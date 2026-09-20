// ---------------------------------------------------------------------------
// Debug Generator - root Vitest configuration (AAP 0.3.4, 0.7.1 Group 0, 0.8.5).
//
// This is the ONLY Vitest configuration that runs tests in the monorepo. It is a
// container config: because it declares `test.projects`, it never collects tests
// itself - it only provides the projects declared below. Every entry point goes
// through it:
//
//   pnpm test              -> vitest run --coverage                (all projects)
//   pnpm test:integration  -> vitest run --project local-service-integration
//   per-workspace `test`   -> vitest run --root ../.. --project <name>
//
// The project NAMES are contracts, not labels: `pnpm test:integration` names
// `local-service-integration` (AAP 0.8.5) and every workspace `package.json`
// invokes this config with `--project <its own name>`. Renaming one silently
// turns the corresponding gate into a no-op that exits 1, so the list below must
// stay in sync with those scripts.
//
// Deliberately NOT configured here, each for a stated reason:
//   * `resolve.alias` for `@debuggen/*`. Cross-package imports must resolve
//     through each package's `exports` map into `dist/`, which is why `pnpm build`
//     precedes tests (AAP 0.2.2). An alias to `src/**` would let a test pass
//     against a broken `exports` map and would bypass the acyclic package
//     layering that eslint.config.js enforces.
//   * `plugins`. Vite 8's Oxc transform already compiles `.tsx` with the
//     automatic React 19 JSX runtime, so `@testing-library/react` works without
//     `@vitejs/plugin-react`. Adding plugins (or a per-project `root`) would also
//     opt every project out of `sharedViteServer`, giving each its own Vite
//     server and transform cache - measurably more memory for no benefit.
//   * `setupFiles` at the repository root. AAP 0.2.5 specifies no root setup
//     file; setup a suite needs belongs to the workspace that needs it, declared
//     in that project's entry below.
//   * `reporters`. The default reporter is used (it switches itself to
//     `github-actions` in CI); AAP 0.7.1 Group 0 uploads only the Playwright
//     report, so no junit/json output is required.
//   * `coverage.thresholds`. AAP 0.8.5 enumerates the quality gates and no
//     coverage percentage is among them; a threshold here would invent a gate.
//   * `passWithNoTests`. Measured behaviour of Vitest 5.0.1: a project with no
//     matching files does not fail a run in which another project has files, and
//     an empty run genuinely means the include globs stopped matching - which
//     must fail rather than pass quietly.
//   * `jsdom`. Rejected by AAP 0.3.2 in favour of happy-dom 20.14.5, whose
//     install is smaller and whose startup is faster across per-package projects;
//     the component tests need DOM/layout semantics only, never canvas.
// ---------------------------------------------------------------------------
import { defineConfig, defineProject } from 'vitest/config';
import type { UserWorkspaceConfig } from 'vitest/config';

/**
 * Paths no project may ever collect, applied to every project below.
 *
 * Declaring `exclude` replaces Vitest's default list (`**\/node_modules/**` and
 * `**\/.git/**`) rather than extending it, so both defaults are repeated here.
 *
 * The load-bearing entry is `tests/**`: `tests/browser/**` and `tests/e2e/**`
 * are Playwright specs (AAP 0.8.3) run by `pnpm test:browser` / `pnpm test:e2e`.
 * Collecting them under Vitest would fail on the missing Playwright fixtures and
 * globals, so the two runners are kept strictly disjoint - Vitest owns
 * `packages/*`, `apps/*` and `scripts/*`, Playwright owns `tests/*`.
 *
 * `**\/test/fixtures/**` and `tests/fixtures/**` matter just as much: the
 * fixture projects (`packages/code-analysis/test/fixtures/sample-next-app`,
 * `packages/instrumentation/test/fixtures/project-a`,
 * `apps/local-service/test/fixtures/**`, `tests/fixtures/sample-next-app`) are
 * sample application sources that exist to be indexed, patched and served - they
 * are inputs to tests, never tests, and some of them carry their own
 * `package.json` and `node_modules`.
 */
const sharedExclude: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.tsbuild/**',
  '**/.next/**',
  // Playwright territory (AAP 0.8.3); `tests/fixtures/**` is redundant under
  // `tests/**` and is kept explicit so narrowing one never re-admits the other.
  'tests/**',
  'tests/fixtures/**',
  '**/test/fixtures/**',
  // Generated Prisma client of the demo application - generated sources are
  // never collected, and the demo has no Vitest project at all (see below).
  'apps/demo-app/src/generated/**',
];

/**
 * Files kept out of the coverage report (`pnpm test` = `vitest run --coverage`).
 *
 * Vitest 5 includes only files that tests actually touched, so this list trims
 * the noise that remains: the tests themselves, config and build tooling, the
 * declaration output of `tsc -b`, and the demo application, which is exercised
 * end to end through Playwright (AAP 0.8.3) rather than by any Vitest project.
 */
const coverageExclude: string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.tsbuild/**',
  '**/*.config.{ts,js,mjs}',
  '**/test/**',
  '**/__tests__/**',
  '**/*.test.*',
  'tests/**',
  '**/test/fixtures/**',
  'scripts/*.test.mjs',
  'apps/demo-app/**',
];

/**
 * A Node-environment project.
 *
 * `globals: false` is the convention for these projects: every Node suite
 * imports `describe`/`it`/`expect` from `vitest` explicitly, which keeps the
 * service, schema and analysis packages honest about what they depend on.
 */
function nodeProject(name: string, include: string[]): UserWorkspaceConfig {
  return defineProject({
    test: {
      name,
      environment: 'node',
      globals: false,
      include,
      exclude: sharedExclude,
    },
  });
}

/**
 * A happy-dom project for code that renders or touches a document.
 *
 * `globals: true` here is required rather than stylistic: `@testing-library/react`
 * 16.3.3 registers its automatic `cleanup` through the global `afterEach` hook,
 * so without globals a component suite leaks mounted trees between tests. Being
 * a DOM project does not remove Node builtins - `node:*` imports keep working
 * under happy-dom, which the telemetry browser suites rely on.
 */
function domProject(name: string, include: string[]): UserWorkspaceConfig {
  return defineProject({
    test: {
      name,
      environment: 'happy-dom',
      globals: true,
      include,
      exclude: sharedExclude,
    },
  });
}

export default defineConfig({
  test: {
    // `exclude` is deliberately declared on each project rather than here.
    // Inline projects inherit root options (`extends` defaults to true) and
    // *concatenate* their own `exclude` onto the inherited one, so declaring it
    // in both places only duplicates every pattern in the diagnostics Vitest
    // prints when a project matches nothing. This config declares `projects`,
    // which makes it a container that never collects tests itself, so the one
    // place the list has to be correct is the projects below.

    // Coverage is a root-only option - Vitest ignores it inside a project - so
    // one report covers every project of a `pnpm test` run. `text` prints the
    // table in the terminal, `lcov` writes the machine-readable report that CI
    // and editors consume. `coverage/` is git-ignored.
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
      exclude: coverageExclude,
    },

    // One project per workspace that owns a Vitest suite, plus `tooling` for the
    // repository guard scripts. Include globs are repository-root relative and no
    // project sets `root`, so all of them share one Vite server and its transform
    // cache (`sharedViteServer`).
    //
    // Two workspaces deliberately have NO project here:
    //   * `apps/demo-app` - AAP 0.8.3 defines no Vitest suite for it; it is the
    //     instrumentation target, exercised by `tests/e2e/**`, and its generated
    //     Prisma client must never be collected or measured.
    //   * `apps/vscode-extension/test/suite/**` - those tests need a real
    //     extension host and run under `pnpm test:vscode` (`@vscode/test-cli`),
    //     where the `vscode` module exists. Only the webview React code, which is
    //     plain DOM code, is a Vitest project.
    projects: [
      // --- packages ---------------------------------------------------------
      nodeProject('shared', ['packages/shared/src/**/*.test.ts']),
      // Covers `src/__tests__/*.test.ts` as well as co-located suites.
      nodeProject('protocol', ['packages/protocol/src/**/*.test.ts']),
      // happy-dom: the browser agent suites drive DOM events, PerformanceObserver
      // and `src/browser/react.test.tsx`, which mounts a React 19.3.0 tree with
      // bippy's hook installed first. The Node preload suites in the same package
      // (`src/node/*.test.ts`) keep using `node:*` builtins under this
      // environment.
      domProject('telemetry', ['packages/telemetry/src/**/*.test.{ts,tsx}']),
      nodeProject('instrumentation', ['packages/instrumentation/src/**/*.test.ts']),
      nodeProject('panel-schema', ['packages/panel-schema/src/**/*.test.ts']),
      // happy-dom: the design system's components, host and registry are rendered
      // with `@testing-library/react`.
      domProject('panel-renderer', ['packages/panel-renderer/src/**/*.test.{ts,tsx}']),
      nodeProject('code-analysis', ['packages/code-analysis/src/**/*.test.ts']),
      nodeProject('model-provider', ['packages/model-provider/src/**/*.test.ts']),

      // --- apps -------------------------------------------------------------
      // Co-located unit suites of the local service. Its `test/` directory holds
      // fixtures and the integration suite, which is the separate project below.
      nodeProject('local-service', ['apps/local-service/src/**/*.test.ts']),
      // The name `local-service-integration` is the contract behind
      // `pnpm test:integration` (AAP 0.8.5). It also runs as part of `pnpm test`,
      // so `pnpm verify` executes it twice; that repetition is accepted by the
      // gate definitions and must not be "optimised" away by renaming the project
      // or excluding it from the default run.
      nodeProject('local-service-integration', [
        'apps/local-service/test/integration/**/*.test.ts',
      ]),
      // happy-dom: the MV3 background, bridge and panel suites stub `chrome.*` on
      // a window and exercise `window.postMessage` relaying.
      domProject('chrome-extension', ['apps/chrome-extension/test/**/*.test.{ts,tsx}']),
      // happy-dom: the extension host's webview is a React app. AAP 0.8.3 names
      // `*.test.tsx` here; `.ts` is admitted alongside it so a non-component
      // webview unit test in the same directory cannot go silently uncollected.
      domProject('vscode-extension-webview', [
        'apps/vscode-extension/src/webview/**/*.test.{ts,tsx}',
      ]),

      // --- repository tooling -----------------------------------------------
      // The guard scripts of AAP 0.3.4 and 0.5.4 (`check-secrets`,
      // `check-no-hardcoding`) ship their own tests, and AAP 0.7.1 Group 0
      // requires `pnpm test` to run them, so they get a project of their own.
      // They are `.mjs` because the scripts they test are plain Node ESM.
      nodeProject('tooling', ['scripts/*.test.mjs']),
    ],
  },
});
