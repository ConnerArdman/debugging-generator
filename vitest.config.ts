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
// Two things here are load-bearing beyond the project list, and both are
// EXPORTED so that apps/local-service/vitest.config.ts - the one other Vitest
// container in the repository, which serves workspace-rooted and IDE runs -
// states the same policy from the same source instead of a second copy of it:
//   * `hermeticEnv` is applied to every project and to the container, so no
//     automated test can inherit an ambient model provider or credential
//     (AAP 0.5.3, 0.8.3). See its own comment for how and why.
//   * `localServiceProjects` defines that workspace's two projects once, so
//     they behave identically from both entry points; a second declaration is
//     what let the execution policy of the integration suites go missing from
//     this path.
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
 * The environment EVERY project runs with, whichever entry point started it.
 *
 * Without it a suite inherits the launching shell's configuration verbatim, so
 * a developer's or CI runner's ambient `DEBUGGEN_PROVIDER=anthropic` plus a
 * live `ANTHROPIC_API_KEY` would put the real, networked model provider inside
 * an automated test. AAP 0.5.3 makes the deterministic provider "what every
 * automated test uses", AAP 0.8.3 runs the integration suites with
 * `DEBUGGEN_PROVIDER=deterministic`, and AAP 0.5.2 promises that "nothing
 * leaves" the machine in that mode - promises this file is the only place that
 * can keep for every project at once.
 *
 * How it takes effect, measured in Vitest 5.0.1 rather than assumed: `test.env`
 * is a per-project option, and the worker assigns each entry onto `process.env`
 * (through the `import.meta.env` proxy, whose setter writes `process.env[key]`)
 * before the first test module is imported. Assignment means these values
 * OVERRIDE whatever was exported ambiently, which is the whole point, and any
 * child process a suite spawns inherits them too.
 *
 * `ANTHROPIC_API_KEY` is emptied rather than removed because `test.env` can
 * only assign - an `undefined` value would stringify to the literal
 * `"undefined"`, which is worse than an empty string. Empty is falsy, so every
 * "is a key configured?" check still reads it as absent while the real
 * credential cannot reach a test process.
 *
 * Deliberately NOT a `process.env` mutation at module scope: this file is
 * evaluated once, in the Vitest main process, which an editor keeps alive for a
 * whole session, so a mutation here would leak into everything that process
 * later does. `test.env` is scoped to the worker that runs the tests.
 *
 * A suite that genuinely needs another value opts in explicitly and reversibly
 * with `vi.stubEnv('DEBUGGEN_PROVIDER', …)` in the test that needs it - which is
 * how the Anthropic provider's own suite (AAP 0.8.3, mocked transport) covers
 * the real provider without a live key. Nothing else may reintroduce the
 * ambient value.
 *
 * Exported so the workspace container in apps/local-service can declare the
 * same guarantee on itself rather than only inheriting it through the projects
 * it registers - a reader of that file must be able to see it there.
 */
export const hermeticEnv: Readonly<Record<string, string>> = {
  DEBUGGEN_PROVIDER: 'deterministic',
  ANTHROPIC_API_KEY: '',
};

/**
 * A Node-environment project.
 *
 * `globals: false` is the convention for these projects: every Node suite
 * imports `describe`/`it`/`expect` from `vitest` explicitly, which keeps the
 * service, schema and analysis packages honest about what they depend on.
 *
 * `env` is spread into a fresh object per project so no two projects share one
 * mutable environment record.
 */
function nodeProject(name: string, include: string[]): UserWorkspaceConfig {
  return defineProject({
    test: {
      name,
      environment: 'node',
      globals: false,
      include,
      exclude: sharedExclude,
      env: { ...hermeticEnv },
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
      env: { ...hermeticEnv },
    },
  });
}

/**
 * The two projects of `apps/local-service`, defined here ONCE for both
 * containers that register them.
 *
 * Why the definition lives in this file and not in the workspace's own
 * vitest.config.ts, which imports this factory: every command-line run resolves
 * through THIS config. Each workspace's `test` script is
 * `vitest run --root ../.. --project <name>`, and `pnpm test:integration` is
 * `vitest run --project local-service-integration` (AAP 0.8.5) - so the root is
 * the authoritative execution path, and an execution policy that existed only
 * in the workspace file would never be in force for any gate. The dependency
 * runs workspace -> root rather than the other way around because
 * eslint.config.js forbids a cross-workspace relative import (`./apps/…`) from
 * anywhere in the repository, while `../../vitest.config.ts` from inside the
 * workspace is allowed.
 *
 * `baseDir` is the directory the include globs are written against, relative to
 * the run root: `apps/local-service` for a repository-root run, `''` when the
 * run root already IS the workspace. `exclude` belongs to the registering
 * container, because the two trees genuinely differ - the root list also has to
 * keep `tests/**` (Playwright's) and the demo's generated Prisma client out,
 * neither of which exists below `apps/local-service`.
 *
 * Both names are contracts, not labels: `pnpm test:integration` names
 * `local-service-integration` and the workspace scripts pass both names to this
 * config. Renaming one turns a blocking gate into a no-op that exits 1.
 *
 * @param options.baseDir Directory prefix for the include globs, `''` for none.
 * @param options.exclude Exclude patterns of the registering container.
 * @returns The `local-service` and `local-service-integration` projects.
 */
export function localServiceProjects(options: {
  readonly baseDir: string;
  readonly exclude: string[];
}): UserWorkspaceConfig[] {
  const { baseDir, exclude } = options;
  const at = (glob: string): string[] => [baseDir === '' ? glob : `${baseDir}/${glob}`];

  return [
    /**
     * The colocated unit suites of the service: config parsing and defaults,
     * the session state-machine transition table, telemetry attribution,
     * redaction wiring, the auth token and Origin rules, source-path
     * containment, panel fallback assembly and retention. They must stay fast
     * and hermetic - no socket opened, no dev server launched, nothing under
     * `$DEBUGGEN_HOME` touched - so they need none of the execution policy the
     * integration project below carries and run with Vitest's defaults.
     * `retry: 0` restates the default on the record: a flaky unit test must
     * fail, never be masked by a second attempt.
     */
    defineProject({
      test: {
        name: 'local-service',
        environment: 'node',
        globals: false,
        include: at('src/**/*.test.ts'),
        exclude,
        env: { ...hermeticEnv },
        retry: 0,
      },
    }),

    /**
     * The in-process integration suites of AAP 0.8.3 (`session-lifecycle`,
     * `ws-protocol`, `telemetry-ingest`, `pipeline-deterministic`,
     * `cleanup-conflict`, `source-open`, `panel-fallback`, `panel-data`,
     * `binding`, `followup`, `auth`, `concurrency`). Every one of them boots a
     * real service - HTTP plus a WebSocket upgrade on an ephemeral port -
     * creates a temporary `$DEBUGGEN_HOME` holding a `node:sqlite` store, and
     * copies a fixture project somewhere writable before the real installer
     * patches it. That makes the policy below part of the contract rather than
     * tuning, and it is why the definition is shared instead of duplicated:
     *
     *   * `fileParallelism: false` runs one suite file at a time (Vitest also
     *     forces this project's `maxWorkers` to 1 when it is false). Concurrent
     *     files would race for ports, for the store and for the fixture copy,
     *     and a collision reads as a product bug when it is only a scheduling
     *     artefact. It does not serialize the rest of the run: Vitest 5.0.1
     *     puts the specs of a project with `isolate: true`, the default
     *     `sequence.groupOrder` and `maxWorkers: 1` into their own sequential
     *     group, leaving every sibling project at its own worker count.
     *   * `pool: 'forks'` states the pool these suites require instead of
     *     relying on it being the 5.0.1 default: they drive `node:sqlite`,
     *     child processes (the dev-server launcher) and `process.env`, all of
     *     which behave as they do in production only in a real child process.
     *   * `isolate: true` (also the default, restated because it is
     *     load-bearing here) gives each suite file a fresh process and module
     *     registry, so a store handle, a listening server or a cached config
     *     cannot survive into the next file. Deliberately not the `singleFork`
     *     shape: `test.poolOptions` was removed in Vitest 4, and one shared
     *     fork would trade exactly the isolation these suites depend on.
     *   * `testTimeout` / `hookTimeout` of 30 s replace the 5 s / 10 s
     *     defaults, which a real pipeline run, a ts-morph instrumentation
     *     install or a cleanup reconciliation pass legitimately exceeds on a
     *     loaded machine. Generous, not unbounded: a genuinely hung server
     *     still fails the run.
     *   * `retry: 0`. A flaky integration test is usually reporting a real leak
     *     (an unclosed socket, a `$DEBUGGEN_HOME` left behind) that a retry
     *     would hide.
     *
     * `environment: 'node'` with `globals: false`: the suites reach the service
     * over `fetch` and a `ws` client, never a DOM, and import their test API
     * from `vitest` explicitly.
     */
    defineProject({
      test: {
        name: 'local-service-integration',
        environment: 'node',
        globals: false,
        include: at('test/integration/**/*.test.ts'),
        exclude,
        env: { ...hermeticEnv },
        pool: 'forks',
        fileParallelism: false,
        isolate: true,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        retry: 0,
      },
    }),
  ];
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

    // `env`, by contrast, belongs in both places, and for the reason `exclude`
    // does not: inheritance merges an object by key instead of concatenating it,
    // so the identical record below and on each project produces exactly one
    // value per variable. Every project already declares it explicitly; this
    // entry is the backstop that holds the guarantee of `hermeticEnv` - no
    // automated test may inherit a real model provider or credential - even for
    // a project added later without the helpers above.
    env: { ...hermeticEnv },

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
      // `local-service` (the service's colocated unit suites) and
      // `local-service-integration` (its in-process integration suites, with
      // the serialized execution policy and 30 s budgets those need) come from
      // the single factory above, which apps/local-service/vitest.config.ts
      // imports for workspace-rooted runs. They are NOT re-declared through
      // `nodeProject` here: that is what previously left the two containers
      // describing the same project name differently, with the execution policy
      // missing from this - the authoritative - path.
      //
      // The name `local-service-integration` is the contract behind
      // `pnpm test:integration` (AAP 0.8.5). It also runs as part of `pnpm test`,
      // so `pnpm verify` executes it twice; that repetition is accepted by the
      // gate definitions and must not be "optimised" away by renaming the project
      // or excluding it from the default run.
      ...localServiceProjects({ baseDir: 'apps/local-service', exclude: sharedExclude }),
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
