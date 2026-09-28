/**
 * Spec for the extension's CSP runtime, `../src/shared/csp-runtime.ts`, and for the build ordering
 * it depends on.
 *
 * The extension pages run under the policy the manifest declares as
 * `content_security_policy.extension_pages`, whose `script-src` is exactly `'self'` - no eval of
 * any kind, which `./manifest.test.ts` asserts on the built manifest - and the ISOLATED-world bridge
 * runs under an equally eval-free policy, so Zod 4's `new Function('')` probe raises a CSP issue
 * on every load unless Zod is switched to its jitless path before its first object schema is
 * built. The module does the switching; the build decides whether it runs early enough. The panel
 * and the devtools page share Zod through a chunk of its own, and ES modules evaluate a chunk's
 * static imports, in order, before its body - so the setting is effective only if each page's
 * entry chunk imports the CSP runtime chunk ahead of every chunk that reaches Zod.
 * `../vite.config.ts` pins the module into its own chunk and refuses to emit a bundle that breaks
 * the order; this spec checks the emitted `dist/` independently of that guard, the same way
 * `./manifest.test.ts` checks the built manifest.
 *
 * Harness. Collected by the root `vitest.config.ts` into the `chrome-extension` project.
 * Hermetic: module evaluation, filesystem reads and one `node:vm` context - no browser, no network,
 * no timers. Which modules a chunk holds is read from its source map (`build.sourcemap: 'hidden'`
 * writes one per chunk), never from minified identifiers. A missing build is a failure, never a
 * skip: every build-dependent case fails with the command that fixes it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * ===========================================================================
 * Locations
 * ===========================================================================
 */

/** This spec's directory, resolved from the module URL - never `process.cwd()`. */
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The `@debuggen/chrome-extension` workspace directory. */
const WORKSPACE_DIR = path.resolve(TEST_DIR, '..');

/** The unpacked extension `vite build` emits. */
const DIST_DIR = path.resolve(WORKSPACE_DIR, 'dist');

/** The module under test, as a source path the built source maps resolve to. */
const CSP_RUNTIME_SOURCE = path.resolve(WORKSPACE_DIR, 'src/shared/csp-runtime.ts');

/** The one command that produces `dist/`, named in every build-related failure. */
const BUILD_COMMAND = 'pnpm --filter @debuggen/chrome-extension build';

/** The built ISOLATED-world bridge, the second entry of `manifest.config.ts`'s content scripts. */
const BRIDGE_SCRIPT = path.join(DIST_DIR, 'src/content/bridge.js');

/** The extension pages that validate with Zod, by their built document. */
const PAGES = [
  { page: 'DevTools panel', document: 'src/panel/panel.html' },
  { page: 'devtools page', document: 'src/devtools/devtools.html' },
] as const;

/** A module of the `zod` package, whichever physical path pnpm gave it. */
const ZOD_MODULE = /[\\/]node_modules[\\/]zod[\\/]/;

/*
 * ===========================================================================
 * The module
 * ===========================================================================
 */

/** Zod 4's global configuration object, as far as this spec reads it. */
interface ZodGlobalConfig {
  jitless?: boolean;
  [key: string]: unknown;
}

/** The global scope with the one member Zod 4 adopts at load. */
interface ZodGlobalScope {
  __zod_globalConfig?: ZodGlobalConfig;
}

const scope = globalThis as ZodGlobalScope;

describe('src/shared/csp-runtime.ts', () => {
  // The global is process-wide, so it is put back exactly as found: any Zod this worker already
  // loaded keeps the object and the flag it had.
  let hadConfig = false;
  let originalConfig: ZodGlobalConfig | undefined;
  let originalJitless: boolean | undefined;

  beforeEach(() => {
    hadConfig = Object.prototype.hasOwnProperty.call(scope, '__zod_globalConfig');
    originalConfig = scope.__zod_globalConfig;
    originalJitless = originalConfig?.jitless;
    // Every case evaluates the module afresh.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfig !== undefined) {
      if (originalJitless === undefined) {
        delete originalConfig.jitless;
      } else {
        originalConfig.jitless = originalJitless;
      }
    }
    if (hadConfig && originalConfig !== undefined) {
      scope.__zod_globalConfig = originalConfig;
    } else if (hadConfig) {
      // Present but undefined: restore the own property with that value.
      Reflect.set(scope, '__zod_globalConfig', undefined);
    } else {
      delete scope.__zod_globalConfig;
    }
  });

  it('creates the global Zod configuration with jitless on when Zod has not loaded yet', async () => {
    delete scope.__zod_globalConfig;

    await import('../src/shared/csp-runtime');

    expect(scope.__zod_globalConfig).toEqual({ jitless: true });
  });

  it('sets jitless on the configuration Zod already adopted, without replacing it', async () => {
    const adopted: ZodGlobalConfig = { marker: 'kept' };
    scope.__zod_globalConfig = adopted;

    await import('../src/shared/csp-runtime');

    expect(scope.__zod_globalConfig, 'the object Zod holds must stay the global one').toBe(adopted);
    expect(adopted).toEqual({ marker: 'kept', jitless: true });
  });

  it('imports nothing, so evaluating it first evaluates nothing before it', () => {
    const source = readFileSync(CSP_RUNTIME_SOURCE, 'utf8');
    expect(source, 'src/shared/csp-runtime.ts must not import or require anything').not.toMatch(
      /^\s*(?:import|export)\b[^\n]*\bfrom\b|^\s*import\s*['"(]|\brequire\s*\(/m,
    );
  });
});

/*
 * ===========================================================================
 * The built extension
 * ===========================================================================
 */

/** Reads a built file, naming the build command when it is missing. */
function readBuilt(file: string): string {
  if (!existsSync(file)) {
    throw new Error(
      `${path.relative(WORKSPACE_DIR, file)} does not exist: dist/ is missing or stale. ` +
        `Run: ${BUILD_COMMAND}`,
    );
  }
  return readFileSync(file, 'utf8');
}

/**
 * The absolute paths of the source modules a built chunk contains, from its source map. A chunk
 * with no map (Vite's module-preload polyfill has none) contributes no module.
 */
function chunkSources(chunk: string): readonly string[] {
  const mapFile = `${chunk}.map`;
  if (!existsSync(mapFile)) {
    return [];
  }
  const parsed: unknown = JSON.parse(readFileSync(mapFile, 'utf8'));
  const sources =
    typeof parsed === 'object' && parsed !== null && 'sources' in parsed ? parsed.sources : [];
  if (!Array.isArray(sources)) {
    throw new Error(`${mapFile} has no "sources" array`);
  }
  return sources
    .filter((source): source is string => typeof source === 'string')
    .map((source) => path.resolve(path.dirname(chunk), source));
}

/**
 * One leading static import of a minified ES chunk: a side-effect import (`import"./a.js"`) or a
 * binding import (`import{a as b}from"./c.js"`). Sticky, so it matches only where the previous
 * statement ended - ES modules put every static import ahead of the body.
 */
const LEADING_IMPORT = /\s*import\s*(?:[\w$\s{},*]+?\s*from\s*)?(["'])([^"']+)\1\s*;?/y;

/** The chunks a built chunk statically imports, as absolute paths, in evaluation order. */
function staticImports(chunk: string): readonly string[] {
  const code = readBuilt(chunk);
  const imports: string[] = [];
  LEADING_IMPORT.lastIndex = 0;
  for (let match = LEADING_IMPORT.exec(code); match !== null; match = LEADING_IMPORT.exec(code)) {
    const specifier = match[2] ?? '';
    imports.push(path.resolve(path.dirname(chunk), specifier));
  }
  return imports;
}

/** Whether a chunk, or any chunk it statically imports, contains a Zod module. */
function reachesZod(chunk: string, seen: Set<string> = new Set()): boolean {
  if (seen.has(chunk)) {
    return false;
  }
  seen.add(chunk);
  return (
    chunkSources(chunk).some((source) => ZOD_MODULE.test(source)) ||
    staticImports(chunk).some((imported) => reachesZod(imported, seen))
  );
}

/** Whether a chunk is the CSP runtime pinned on its own: that one module and no import. */
function isCspRuntimeChunk(chunk: string): boolean {
  const sources = chunkSources(chunk);
  return (
    sources.length === 1 && sources[0] === CSP_RUNTIME_SOURCE && staticImports(chunk).length === 0
  );
}

/** The entry chunk a built page document loads with its module script. */
function pageEntryChunk(document: string): string {
  const html = readBuilt(path.join(DIST_DIR, document));
  const script = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
  if (script === undefined) {
    throw new Error(`dist/${document} has no <script type="module" src="..."> entry`);
  }
  return script.startsWith('/')
    ? path.join(DIST_DIR, script)
    : path.resolve(path.dirname(path.join(DIST_DIR, document)), script);
}

describe('the built extension', () => {
  beforeAll(() => {
    readBuilt(path.join(DIST_DIR, 'manifest.json'));
  });

  it('emits the CSP runtime as a chunk of its own, holding that one module and importing nothing', () => {
    const assets = path.join(DIST_DIR, 'assets');
    const chunks = readdirSync(assets)
      .filter((file) => file.endsWith('.js'))
      .map((file) => path.join(assets, file));
    const hosts = chunks.filter((chunk) => chunkSources(chunk).includes(CSP_RUNTIME_SOURCE));
    expect(
      hosts.map((chunk) => path.relative(DIST_DIR, chunk)),
      'exactly one chunk may contain src/shared/csp-runtime.ts',
    ).toHaveLength(1);
    expect(isCspRuntimeChunk(hosts[0] ?? ''), `${hosts[0] ?? ''} must hold nothing else`).toBe(
      true,
    );
  });

  it.each(PAGES)(
    'the $page imports the CSP runtime chunk before every chunk that reaches Zod',
    ({ document }) => {
      const entry = pageEntryChunk(document);
      expect(
        reachesZod(entry),
        `dist/${document} does not load Zod at all, so this case would prove nothing`,
      ).toBe(true);

      const imports = staticImports(entry);
      const runtimeIndex = imports.findIndex(isCspRuntimeChunk);
      expect(
        runtimeIndex,
        `${path.relative(DIST_DIR, entry)} does not import the CSP runtime chunk ` +
          `(imports: ${imports.map((file) => path.relative(DIST_DIR, file)).join(', ')})`,
      ).toBeGreaterThanOrEqual(0);

      const earlier = imports
        .slice(0, runtimeIndex)
        .filter((chunk) => reachesZod(chunk))
        .map((chunk) => path.relative(DIST_DIR, chunk));
      expect(earlier, 'chunks that reach Zod and are evaluated before the CSP runtime').toEqual([]);
    },
  );

  it('runs the bridge with Zod jitless: evaluating it never constructs a Function', () => {
    const code = readBuilt(BRIDGE_SCRIPT);
    expect(
      chunkSources(BRIDGE_SCRIPT).some((source) => ZOD_MODULE.test(source)),
      'dist/src/content/bridge.js bundles no Zod module, so this case would prove nothing',
    ).toBe(true);

    // A realm of its own whose `Function` counts every use - the call Zod's eval probe and its
    // compiled fast path both make. Outside a content-script realm the bridge's bootstrap is
    // inert, so evaluating the bundle runs module initialisation, schema construction included,
    // and nothing else.
    const context = vm.createContext({});
    vm.runInContext(
      `globalThis.__functionUses = 0;
       globalThis.Function = new Proxy(Function, {
         apply(target, self, args) { globalThis.__functionUses += 1; return Reflect.apply(target, self, args); },
         construct(target, args) { globalThis.__functionUses += 1; return Reflect.construct(target, args); },
       });`,
      context,
    );
    vm.runInContext(code, context, { filename: BRIDGE_SCRIPT });

    expect(vm.runInContext('globalThis.__functionUses', context) as unknown).toBe(0);
    expect(vm.runInContext('globalThis.__zod_globalConfig?.jitless', context) as unknown).toBe(
      true,
    );
  });
});
