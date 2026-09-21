// ---------------------------------------------------------------------------
// Debug Generator - ESLint flat configuration (AAP 0.3.4).
//
// `pnpm lint` is `eslint . --max-warnings 0` (AAP 0.8.5): a blocking step of
// `pnpm verify` where a WARNING fails the run exactly like an error. Every rule
// enabled below therefore has to be satisfiable by the code in this repository;
// nothing here is advisory.
//
// Three layers, in order of importance:
//
//   1. Architecture. AAP 0.2.2 fixes an acyclic dependency edge list over the
//      eight `@debuggen/*` packages and the four apps and states that those
//      edges are "enforced by `eslint` `no-restricted-imports` per package".
//      The "package layering" blocks below ARE that enforcement - the only
//      mechanical guard against a cycle, a layer violation, a deep reach past a
//      package's `exports` map, or the demo app acquiring a product dependency.
//      Keep them in sync with AAP 0.2.2; nothing else checks the edge list.
//   2. Correctness. `@eslint/js` recommended plus typescript-eslint's
//      type-checked recommended set, which needs a TypeScript program per file.
//   3. React. `eslint-plugin-react-hooks` on the React surfaces only.
//
// NOT here, deliberately:
//   - No formatting or stylistic rules. Prettier owns formatting through
//     `pnpm format:check`; a stylistic rule here would put the two gates in
//     conflict, so one of them would always have to lose.
//   - No additional plugins. AAP 0.3.2 pins exactly three lint packages
//     (`@eslint/js` 10.0.1, `typescript-eslint` 8.70.0,
//     `eslint-plugin-react-hooks` 7.1.1); adding another changes what
//     `pnpm install --frozen-lockfile` has to resolve.
//   - No blanket `@typescript-eslint/no-unsafe-*` suppression. Where a
//     third-party typing forces it (`chrome.*`, bippy fibers, OpenTelemetry
//     `ReadableSpan`), the owning file carries a narrow, commented
//     `eslint-disable-next-line` - which `reportUnusedDisableDirectives` then
//     keeps honest.
//
// The root `package.json` declares `"type": "module"`, so this file is ESM and
// may use `import.meta.dirname`.
// ---------------------------------------------------------------------------
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// ---------------------------------------------------------------------------
// Package layering (AAP 0.2.2)
// ---------------------------------------------------------------------------

/**
 * Every workspace package published under the `@debuggen` scope, listed bottom
 * up along the acyclic layering of AAP 0.2.2: `shared` is the base and
 * `protocol` the top of the package stack, above the event, plan and panel
 * schema packages whose types its messages embed.
 *
 * `layering()` derives a block's forbidden list by subtracting that block's
 * allowed names from this array, so a package added here without a block of its
 * own is forbidden everywhere until one is written - the safe default.
 */
const DEBUGGEN_PACKAGES = [
  'shared',
  'telemetry',
  'code-analysis',
  'instrumentation',
  'panel-schema',
  'panel-renderer',
  'model-provider',
  'protocol',
];

/**
 * Gitignore-style patterns matching one package's entry point and every subpath
 * export it may add (`@debuggen/shared/node`, `@debuggen/telemetry/node/register`).
 *
 * @param {string} name Package name without the `@debuggen/` scope.
 * @returns {string[]} Patterns for `no-restricted-imports`.
 */
const scopedGroup = (name) => [`@debuggen/${name}`, `@debuggen/${name}/**`];

/**
 * Restrictions that hold for every file in the repository, whichever layer it
 * belongs to. They are repeated into each layering block on purpose: ESLint
 * replaces a rule's options wholesale when a later config object sets the same
 * rule, so a block that listed only its own forbidden packages would silently
 * drop these.
 */
const UNIVERSAL_IMPORT_PATTERNS = [
  {
    group: [
      '@debuggen/*/src',
      '@debuggen/*/src/**',
      '@debuggen/*/dist',
      '@debuggen/*/dist/**',
      '@debuggen/*/test/**',
    ],
    message:
      "Import a package through its `exports` map ('@debuggen/x', '@debuggen/x/node'), never its internals: reaching into src/, dist/ or test/ bypasses the published entry points that the runtime and every bundler resolve (AAP 0.2.2).",
  },
  {
    // Matches './..', '../..', '../../..' and deeper, followed by a workspace
    // root segment: '../../packages/shared/src/index.js' and
    // '../../../apps/demo-app/src/server/...' are both caught, while
    // in-workspace relatives such as '../utils/scale' are not.
    regex: String.raw`^\.\.?(/\.\.)*/(apps|packages)/`,
    message:
      "Cross-workspace relative imports are forbidden: depend on the workspace package ('@debuggen/x') so the edge is declared in package.json, resolved through the exports map and checked by the layering rules (AAP 0.2.2).",
  },
];

/**
 * Node.js built-in modules, in their bare form. Used by the browser-agent block
 * to keep the page bundle dependency-light; the `node:` prefixed form is covered
 * by a pattern instead. Listed explicitly as `paths` (exact specifier matches)
 * rather than as gitignore patterns, because a bare pattern like `fs` would also
 * match a relative import that happens to end in `/fs`.
 */
const NODE_BUILTIN_MODULES = [
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'sqlite',
  'stream',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];

const BROWSER_AGENT_NODE_MESSAGE =
  'packages/telemetry/src/browser is the IIFE agent that runs inside the inspected page: it must stay dependency-light and free of Node built-ins, which no browser bundle can provide (AAP 0.2.2, 0.7.1 Group 1).';

/**
 * Build the `no-restricted-imports` entry for one workspace layer: everything
 * in `DEBUGGEN_PACKAGES` except `allowedPackages` is forbidden, and the
 * universal restrictions are always appended.
 *
 * @param {string[]} allowedPackages `@debuggen` package names this layer may import.
 * @param {string} [message] Explanation attached to the forbidden `@debuggen/*` group.
 * @param {{ paths?: object[], patterns?: object[] }} [extra] Additional restrictions.
 * @returns {[string, object]} A rule entry for `rules['no-restricted-imports']`.
 */
function layering(allowedPackages, message = '', extra = {}) {
  const forbidden = DEBUGGEN_PACKAGES.filter((name) => !allowedPackages.includes(name));
  const patterns = [...(extra.patterns ?? []), ...UNIVERSAL_IMPORT_PATTERNS];
  if (forbidden.length > 0) {
    patterns.unshift({ group: forbidden.flatMap(scopedGroup), message });
  }
  return ['error', { ...(extra.paths ? { paths: extra.paths } : {}), patterns }];
}

/**
 * One layering block for one workspace (or one directory inside a workspace).
 * `.mjs`/`.js` are included alongside the TypeScript extensions so a build
 * driver such as `packages/telemetry/esbuild.agent.mjs` is held to the same
 * edges as the sources it bundles.
 *
 * @param {string} workspace Repository-relative directory, for example `packages/telemetry`.
 * @param {string[]} allowedPackages `@debuggen` package names this workspace may import.
 * @param {string} message Explanation attached to the forbidden `@debuggen/*` group.
 * @param {{ paths?: object[], patterns?: object[] }} [extra] Additional restrictions.
 * @returns {object} A flat-config object.
 */
function layeringBlock(workspace, allowedPackages, message, extra = {}) {
  return {
    name: `debuggen/layering-${workspace.replaceAll('/', '-')}`,
    files: [
      `${workspace}/**/*.ts`,
      `${workspace}/**/*.tsx`,
      `${workspace}/**/*.mts`,
      `${workspace}/**/*.cts`,
      `${workspace}/**/*.js`,
      `${workspace}/**/*.mjs`,
      `${workspace}/**/*.cjs`,
    ],
    rules: {
      'no-restricted-imports': layering(allowedPackages, message, extra),
    },
  };
}

// ---------------------------------------------------------------------------
// File-set constants
// ---------------------------------------------------------------------------

/**
 * Build tooling written in TypeScript. These files belong to no project of the
 * `tsc -b` solution (root tsconfig.json declares `files: []`, and the workspace
 * projects include only `src/**` and `test/**`), and typescript-eslint's project
 * service throws for a file it cannot place in a project. `allowDefaultProject`
 * is not a way out: it rejects any glob containing `**`, caps out at eight
 * matched files, and would type-check them against the solution file, which
 * declares no `compilerOptions` at all. They are therefore linted with the
 * TypeScript parser but with the type-aware rules switched off - the narrowing
 * is per block, never repository-wide.
 */
const TOOLING_CONFIG_FILES = [
  // `*.config.ts` only matches a basename with the dot, so a source module such
  // as `src/config.ts` keeps its type-aware rules.
  '**/*.config.ts',
  '**/*.config.mts',
  '**/*.config.cts',
  // Build scripts at the repository root or beside a workspace manifest - never
  // a `src/scripts/` directory, which belongs to its workspace's project.
  'scripts/**/*.ts',
  'scripts/**/*.mts',
  'apps/*/scripts/**/*.ts',
  'apps/*/scripts/**/*.mts',
  'packages/*/scripts/**/*.ts',
  'packages/*/scripts/**/*.mts',
];

/**
 * The React surfaces. Everything else in the repository is Node or plain DOM
 * code, and the React Compiler rule set has nothing to say about it.
 *
 * `.tsx` only, deliberately. A hook module written as plain `.ts`
 * (`src/host/useQuery.ts`, `apps/demo-app/src/hooks/*.ts`) is therefore checked
 * by the type-aware rules but not by the hook rules. Widening this list to
 * `.ts` means also adding the demo's two defective hook modules
 * (`src/hooks/useRecommendations.ts`, `src/hooks/useCartSummary.ts`) to
 * DEMO_SEEDED_DEFECT_FILES, because AAP 0.8.2 requires their unstable effect
 * dependencies to survive.
 */
const REACT_SURFACES = [
  'packages/panel-renderer/src/**/*.tsx',
  'apps/chrome-extension/src/panel/**/*.tsx',
  'apps/vscode-extension/src/webview/**/*.tsx',
  'apps/demo-app/app/**/*.tsx',
  'apps/demo-app/src/**/*.tsx',
];

/**
 * The demo application's deliberately defective React files (AAP 0.8.2, seeded
 * defects 2 and 3). Their bugs - a context value rebuilt every render, a 250 ms
 * ticker driving that context, inline callbacks defeating `memo`, and an effect
 * keyed on an inline options object - are PRODUCT REQUIREMENTS: the acceptance
 * tests (`tests/e2e/demo-excessive-renders.spec.ts`,
 * `demo-duplicate-requests.spec.ts`) exist to discover them at runtime, and
 * `scripts/check-no-hardcoding.mjs` guarantees no product file knows where they
 * live. They must never be "fixed" to satisfy a linter.
 *
 * The rules relaxed for these files below are exactly the identity, memoization
 * and effect rules those defects embody. Everything else in the React Compiler
 * set stays on, so a genuine bug in one of these files still fails the gate; a
 * file that needs more than this relaxation carries a narrow, commented
 * `eslint-disable-next-line` naming AAP 0.8.2.
 *
 * Note the glob for the product route: `app/products/[slug]/page.tsx` cannot be
 * written literally, because `[slug]` is a character class to a glob matcher and
 * would match `app/products/s/page.tsx` instead of the directory itself.
 */
const DEMO_SEEDED_DEFECT_FILES = [
  'apps/demo-app/src/providers/CartProvider.tsx',
  'apps/demo-app/src/providers/ShippingEtaProvider.tsx',
  'apps/demo-app/src/components/catalog/CatalogGrid.tsx',
  'apps/demo-app/src/components/catalog/ProductCard.tsx',
  'apps/demo-app/src/components/product/RecommendationsRail.tsx',
  'apps/demo-app/src/components/layout/SiteHeader.tsx',
  'apps/demo-app/app/products/*/page.tsx',
];

/** Every test and spec file, whichever workspace owns it. */
const TEST_FILES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.mts',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/__tests__/**/*.ts',
  '**/__tests__/**/*.tsx',
  'apps/*/test/**/*.ts',
  'apps/*/test/**/*.tsx',
  'packages/*/test/**/*.ts',
  'packages/*/test/**/*.tsx',
  'tests/**/*.ts',
];

/**
 * Ambient globals for the repository's plain-JavaScript tooling (this file,
 * `scripts/*.mjs`, `packages/telemetry/esbuild.*.mjs`,
 * `packages/panel-renderer/scripts/build-tokens.mjs`,
 * `apps/vscode-extension/esbuild.mjs` and `.vscode-test.mjs`).
 *
 * Declared inline rather than imported from the `globals` package on purpose:
 * AAP 0.3.2 pins the dependency inventory and `globals` is not in it, so it is
 * neither installed nor resolvable here - importing it would break
 * configuration loading for everyone. TypeScript files need none of this:
 * typescript-eslint's `eslint-recommended` layer turns `no-undef` off for them,
 * because the compiler already reports unknown identifiers.
 *
 * `module`, `require`, `exports`, `__dirname` and `__filename` are deliberately
 * absent: every JavaScript file here is an ES module, and `scripts/`
 * legitimately uses `module` as a local binding
 * (`const module = await import(...)`). They are declared in the CommonJS block
 * instead.
 */
const NODE_ESM_GLOBALS = Object.fromEntries(
  [
    'AbortController',
    'AbortSignal',
    'Blob',
    'BroadcastChannel',
    'Buffer',
    'ByteLengthQueuingStrategy',
    'CompressionStream',
    'CountQueuingStrategy',
    'DecompressionStream',
    'Event',
    'EventTarget',
    'File',
    'FormData',
    'Headers',
    'Intl',
    'MessageChannel',
    'MessageEvent',
    'MessagePort',
    'ReadableStream',
    'Request',
    'Response',
    'TextDecoder',
    'TextEncoder',
    'TransformStream',
    'URL',
    'URLSearchParams',
    'WebAssembly',
    'WebSocket',
    'WritableStream',
    'atob',
    'btoa',
    'clearImmediate',
    'clearInterval',
    'clearTimeout',
    'console',
    'crypto',
    'fetch',
    'global',
    'globalThis',
    'navigator',
    'performance',
    'process',
    'queueMicrotask',
    'setImmediate',
    'setInterval',
    'setTimeout',
    'structuredClone',
  ].map((name) => [name, 'readonly']),
);

/** CommonJS module scope, for the `.cjs` files a tool may require. */
const COMMONJS_GLOBALS = {
  ...NODE_ESM_GLOBALS,
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
};

export default tseslint.config(
  // -------------------------------------------------------------------------
  // Global ignores. A config object with `ignores` and nothing else applies to
  // every later block, so this is the one place paths leave the lint surface.
  // -------------------------------------------------------------------------
  {
    name: 'debuggen/ignores',
    ignores: [
      // Dependencies and every build artifact: tsup/esbuild/Vite bundles
      // (dist/), Next.js output (.next/), `tsc -b` declarations and state
      // (.tsbuild/), packaged extensions and coverage or report output. Kept in
      // step with .gitignore and .prettierignore; renaming one means renaming
      // all three (tsconfig.base.json records the same contract for .tsbuild).
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/.next/**',
      '**/.tsbuild/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/blob-report/**',
      '**/test-results/**',
      '**/.vscode-test/**',
      '**/.playwright/**',

      // Generated, not authored: the Prisma client the demo app imports, the
      // ambient declarations Next.js writes, and the browser-agent IIFE that
      // scripts/copy-agent.mjs copies out of packages/telemetry/dist.
      'apps/demo-app/src/generated/**',
      'apps/demo-app/next-env.d.ts',
      'apps/chrome-extension/public/agent.iife.js',

      // Fixture projects are INPUTS to tests, not repository source: the real
      // ts-morph patcher rewrites files under them during
      // packages/instrumentation's suite, and every workspace tsconfig excludes
      // them, so they sit outside the type-aware program by design. Linting
      // them would fail on code that is deliberately unidiomatic and would
      // report on bytes a test is about to change.
      '**/test/fixtures/**',
      'tests/fixtures/**',

      // Not JavaScript, or owned by a generator.
      'pnpm-lock.yaml',
      '**/*.md',

      // Blitzy run artifacts (screenshots, recordings).
      'blitzy/**',
    ],
  },

  // -------------------------------------------------------------------------
  // Linter behaviour, repository-wide.
  // -------------------------------------------------------------------------
  {
    name: 'debuggen/linter-options',
    linterOptions: {
      // A suppression that no longer suppresses anything is a lie about the
      // code. Because narrow `eslint-disable-next-line` comments are the
      // sanctioned escape hatch for third-party typings, they have to expire
      // with the problem they were written for - as an error, since
      // `--max-warnings 0` makes the distinction moot anyway.
      reportUnusedDisableDirectives: 'error',
    },
  },

  // -------------------------------------------------------------------------
  // Base layers.
  // -------------------------------------------------------------------------
  js.configs.recommended,

  {
    // Type-aware linting for every authored TypeScript file. `projectService`
    // asks TypeScript itself which project owns a file, so the fourteen
    // projects referenced by the root solution file are discovered without this
    // config listing any of them - a new workspace needs no change here.
    name: 'debuggen/typescript-type-checked',
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    ignores: TOOLING_CONFIG_FILES,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    // Build tooling in TypeScript: the same parser and the same syntactic
    // rules, but no program. `recommended` carries the parser and the plugin
    // (its `base` layer) and none of its rules need type information;
    // `disableTypeChecked` follows it to null out the project options, so a
    // rule that later becomes type-aware cannot quietly demand a program for
    // these files. See TOOLING_CONFIG_FILES for why they have none.
    name: 'debuggen/typescript-tooling-config',
    files: TOOLING_CONFIG_FILES,
    extends: [tseslint.configs.recommended, tseslint.configs.disableTypeChecked],
  },

  {
    // Plain ES modules: this file, the guard scripts and the esbuild drivers.
    name: 'debuggen/javascript-esm',
    files: ['**/*.js', '**/*.mjs', '**/*.jsx'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'module',
      globals: NODE_ESM_GLOBALS,
    },
  },

  {
    name: 'debuggen/javascript-commonjs',
    files: ['**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'commonjs',
      globals: COMMONJS_GLOBALS,
    },
  },

  // -------------------------------------------------------------------------
  // React surfaces.
  // -------------------------------------------------------------------------
  {
    // eslint-plugin-react-hooks 7 publishes its flat configs under
    // `configs.flat`; the top-level `configs.recommended` is the eslintrc form
    // (`plugins: ['react-hooks']`), which flat config rejects. `flat.recommended`
    // carries the React Compiler rule set as well as rules-of-hooks, which is
    // what catches the identity and purity mistakes this product's panels and
    // the demo storefront are full of.
    name: 'debuggen/react-hooks',
    files: REACT_SURFACES,
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // Promoted from the plugin's `warn`: under `--max-warnings 0` a warning
      // fails the gate anyway, and an effect whose dependencies are wrong is
      // precisely the class of bug this product is built to find.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  {
    // See DEMO_SEEDED_DEFECT_FILES: these defects are product requirements.
    name: 'debuggen/react-hooks-demo-seeded-defects',
    files: DEMO_SEEDED_DEFECT_FILES,
    rules: {
      // Defect 3: `useRecommendations({ productId, limit })` is called with an
      // inline options object, so the effect's dependency identity changes on
      // every render. That unstable identity IS the bug under investigation.
      'react-hooks/exhaustive-deps': 'off',
      // Defect 2: a context value rebuilt each render and inline `onSelect`
      // lambdas handed to a `memo`'d card - memoization defeated on purpose.
      'react-hooks/use-memo': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      // Defect 2: the shipping-ETA provider ticks state from an effect every
      // 250 ms, which is what makes the catalog re-render while idle.
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  // -------------------------------------------------------------------------
  // Package layering (AAP 0.2.2) - the mechanical guardian of the dependency
  // edge list. Order is load-bearing: ESLint replaces a rule's options when a
  // later block sets the same rule, so these run broadest first (repository
  // default, then "no package may import protocol", then one block per
  // workspace, then the directory-scoped browser-agent block last).
  // -------------------------------------------------------------------------
  {
    // Files outside apps/ and packages/ - the root tooling configs, the guard
    // scripts under scripts/ and the Playwright suites under tests/ - sit above
    // every layer and may import any package (tests/tsconfig.json references
    // five of them), so only the universal restrictions apply to them.
    name: 'debuggen/layering-default',
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.mts',
      '**/*.cts',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      '**/*.jsx',
    ],
    rules: {
      'no-restricted-imports': layering(DEBUGGEN_PACKAGES),
    },
  },

  {
    // The acyclicity guarantee. `protocol` is the only package allowed to know
    // about `@debuggen/protocol`; every other package sits below it, and an
    // upward import from below would close a cycle. This block also covers any
    // future package that has no block of its own yet.
    name: 'debuggen/layering-packages-no-protocol',
    files: [
      'packages/*/**/*.ts',
      'packages/*/**/*.tsx',
      'packages/*/**/*.mts',
      'packages/*/**/*.cts',
      'packages/*/**/*.js',
      'packages/*/**/*.mjs',
      'packages/*/**/*.cjs',
    ],
    ignores: ['packages/protocol/**'],
    rules: {
      'no-restricted-imports': layering(
        DEBUGGEN_PACKAGES.filter((name) => name !== 'protocol'),
        'No package under packages/ may import @debuggen/protocol except protocol itself: protocol sits ABOVE the event, plan and panel schema packages whose types its messages embed, so an upward import from below would close a cycle (AAP 0.2.2).',
      ),
    },
  },

  layeringBlock(
    'packages/shared',
    [],
    'packages/shared is the base layer of AAP 0.2.2 and may import no @debuggen package at all; a type that several layers need is defined here (SourceLocation) rather than imported into here.',
  ),

  layeringBlock(
    'packages/telemetry',
    ['shared'],
    'packages/telemetry may import only @debuggen/shared - protocol sits above telemetry, whose events its messages embed (AAP 0.2.2).',
  ),

  layeringBlock(
    'packages/code-analysis',
    ['shared'],
    'packages/code-analysis may import only @debuggen/shared (AAP 0.2.2).',
  ),

  layeringBlock(
    'packages/model-provider',
    ['shared'],
    'packages/model-provider may import only @debuggen/shared: the provider boundary stays free of telemetry, plan and panel types so nothing can be sent to a model implicitly (AAP 0.2.2, 0.5.3).',
  ),

  layeringBlock(
    'packages/instrumentation',
    ['shared', 'telemetry', 'code-analysis'],
    'packages/instrumentation may import only @debuggen/telemetry, @debuggen/code-analysis and @debuggen/shared (AAP 0.2.2).',
  ),

  layeringBlock(
    'packages/panel-schema',
    ['shared', 'telemetry'],
    'packages/panel-schema may import only @debuggen/telemetry (event references) and @debuggen/shared (AAP 0.2.2).',
  ),

  layeringBlock(
    'packages/panel-renderer',
    ['shared', 'telemetry', 'panel-schema'],
    'packages/panel-renderer may import only @debuggen/panel-schema, @debuggen/telemetry and @debuggen/shared: "the renderer depends on the schema, never the reverse" (AAP 0.6.2), and a component never reaches a transport or a service (AAP 0.4.2).',
  ),

  layeringBlock(
    'packages/protocol',
    ['shared', 'telemetry', 'instrumentation', 'panel-schema'],
    'packages/protocol may import only @debuggen/telemetry, @debuggen/instrumentation, @debuggen/panel-schema and @debuggen/shared - it is layered ABOVE them and nothing below it may import it back (AAP 0.2.2).',
  ),

  layeringBlock(
    'apps/vscode-extension',
    ['shared', 'protocol', 'panel-renderer'],
    'apps/vscode-extension may import only @debuggen/protocol, @debuggen/panel-renderer (tokens and primitives) and @debuggen/shared: the editor surface talks to the service through the protocol, never through service internals (AAP 0.2.2, 0.4.2).',
  ),

  layeringBlock(
    'apps/chrome-extension',
    ['shared', 'telemetry', 'panel-schema', 'panel-renderer', 'protocol'],
    'apps/chrome-extension may import only @debuggen/protocol, @debuggen/panel-schema, @debuggen/panel-renderer, @debuggen/telemetry and @debuggen/shared (AAP 0.2.2).',
  ),

  layeringBlock(
    'apps/local-service',
    [
      'shared',
      'telemetry',
      'code-analysis',
      'instrumentation',
      'panel-schema',
      'model-provider',
      'protocol',
    ],
    'apps/local-service may import every package except @debuggen/panel-renderer: the service generates and validates panel specifications, it never renders them (AAP 0.2.2).',
  ),

  layeringBlock(
    'apps/demo-app',
    [],
    'apps/demo-app is an instrumentation TARGET, not a product surface: it declares no dependency on any @debuggen package and contains no product hooks, which is what makes the end-to-end run evidence that the tool works on an ordinary project (AAP 0.3.2, 0.4.2).',
    {
      patterns: [
        {
          group: ['@opentelemetry/*', '@opentelemetry/*/**'],
          message:
            'apps/demo-app must not depend on @opentelemetry/*: Next.js emits its spans through the tracer provider its own bundled API copy registers, and the OpenTelemetry global registry is shared across copies of the same major, so the demo needs no OTel dependency of its own (AAP 0.3.2, 0.4.2).',
        },
      ],
    },
  ),

  layeringBlock(
    'packages/telemetry/src/browser',
    ['shared'],
    'The browser agent may import only @debuggen/shared, and never @debuggen/protocol: it emits raw event batches that the Chrome service worker wraps into protocol envelopes, so "the agent bundle never imports protocol" (AAP 0.2.3).',
    {
      paths: NODE_BUILTIN_MODULES.map((name) => ({ name, message: BROWSER_AGENT_NODE_MESSAGE })),
      patterns: [
        {
          group: ['node:*', 'node:*/**'],
          message: BROWSER_AGENT_NODE_MESSAGE,
        },
      ],
    },
  ),

  // -------------------------------------------------------------------------
  // Test and tooling overrides.
  // -------------------------------------------------------------------------
  {
    // Tests stay under the layering rules and under `no-floating-promises` - a
    // forgotten `await` on a Playwright action or a Vitest assertion is a real
    // bug that passes silently - but they may assert on values the compiler
    // cannot narrow, and an empty function is a legitimate stub or spy.
    //
    // Two of the three entries below are inert against the current rule set
    // (`no-non-null-assertion` belongs to typescript-eslint's `strict` config
    // and `no-empty-function` to `stylistic`, neither of which is enabled).
    // They are stated anyway, so that adopting a stricter preset later relaxes
    // for tests instead of turning hundreds of assertions red in one commit.
    //
    // Nothing restricts importing a devDependency: the repository runs no
    // import plugin (AAP 0.3.2 pins the lint dependencies), so `vitest`,
    // `@playwright/test` and `@testing-library/*` are available by
    // construction.
    name: 'debuggen/tests',
    files: TEST_FILES,
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty-function': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  {
    // The guard scripts of AAP 0.5.4 and 0.3.4 are command-line tools: their
    // output IS their interface - `check-secrets` and `check-no-hardcoding`
    // report findings on stdout and exit non-zero - so console use is expected
    // rather than tolerated. `no-console` is not part of `@eslint/js`
    // recommended, which makes this entry inert today; it is stated so that
    // enabling `no-console` repository-wide cannot silence a gate by accident.
    // Type-aware rules are already off for these files through the
    // `javascript-esm` block above.
    name: 'debuggen/scripts',
    files: ['scripts/**/*.mjs', 'scripts/**/*.js', '**/scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
);
