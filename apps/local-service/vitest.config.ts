// ---------------------------------------------------------------------------
// @debuggen/local-service - workspace-local Vitest configuration.
//
// AAP 0.9.1 lists `vitest.config.ts` among this workspace's in-scope paths. It
// exists for runs whose root is THIS directory - editor/IDE test integration and
// a bare `vitest` invoked from inside the workspace - while the repository-root
// vitest.config.ts stays the authoritative project registry for CI.
//
// OWNERSHIP - settled by reading the root config, not assumed
// ----------------------------------------------------------
// The root config declares its projects INLINE: its `test.projects` array is
// built entirely from its own `nodeProject`/`domProject` helpers, two of whose
// entries are
//
//   local-service              apps/local-service/src/**/*.test.ts
//   local-service-integration  apps/local-service/test/integration/**/*.test.ts
//
// both `environment: 'node'` with `globals: false`. That array contains no path,
// glob or directory entry, and Vitest only discovers config files for entries
// that are paths or globs - so a root-rooted run never loads this file, each
// project name is registered exactly once, and `pnpm test` can neither fail with
// a duplicate project name nor double a test count.
//
// This is therefore the mirror case: the file below re-declares the SAME two
// projects - same names, same `node` environment, same `globals: false`, the same
// include globs written relative to this workspace - so that a workspace-rooted
// run behaves like the corresponding slice of a root run. Two rules follow and
// are not negotiable: this path must never be added to the root `projects` array
// (that is what would double-register the names), and neither name may be
// renamed or joined by a third, because the names are the contract behind the
// blocking gates - `pnpm test:integration` is literally
// `vitest run --project local-service-integration` (AAP 0.8.5) and this
// workspace's own scripts pass `--project <name>` to the root config.
//
// Which configuration each command uses
// -------------------------------------
//   pnpm test, pnpm test:integration (repository root)      root config
//   pnpm --filter @debuggen/local-service test              root config, because
//   pnpm --filter @debuggen/local-service test:integration  both scripts run
//                                                           `vitest run --root ../..
//                                                            --project <name>`
//   vitest with this directory as its root (IDE gutter
//     actions, `cd apps/local-service && vitest run`)       THIS file
//
// Deliberately NOT configured here, each for a stated reason:
//   * `coverage`. A root-only option (Vitest ignores it inside a project), and
//     AAP 0.8.5 makes the repository-root `pnpm test` (= `vitest run --coverage`,
//     `@vitest/coverage-v8` 5.0.1) the single place a report is produced.
//     Repeating it would emit a second, partial report; a threshold would invent
//     a gate the plan does not list.
//   * `setupFiles`. No suite here needs one. The integration suites take their
//     `DEBUGGEN_PROVIDER=deterministic`, their temporary `$DEBUGGEN_HOME` and
//     their ephemeral port through injected config, which is what makes them
//     re-runnable; a workspace-wide setup file would turn that into a hidden
//     global. If one ever becomes genuinely necessary it belongs under `test/`,
//     declared on the project that needs it.
//   * `process.env` writes. This module is evaluated once, in the Vitest main
//     process, so a mutation here would leak into every project of the run and
//     into an editor's long-lived Vitest server - and could point a suite at the
//     developer's real `~/.debuggen` or their real `ANTHROPIC_API_KEY`. Neither
//     project may reach either, and that is enforced where it belongs: in the
//     suites, through injected configuration.
//   * `resolve.alias` for `@debuggen/*`. Cross-package imports must resolve
//     through each package's `exports` map into `dist/` (AAP 0.2.2), exactly as
//     Node, tsup and the esbuild bundle of apps/vscode-extension resolve them;
//     an alias to `src/**` would let a suite pass against a broken exports map
//     and would hide the acyclic package layering.
//   * `plugins`, `reporters`, and any test-tooling dependency. Vitest 5.0.1 is
//     pinned once, in the root manifest; this workspace adds nothing to it. With
//     no Vite-level option set, the projects below also stay eligible for the
//     shared Vite server and its transform cache.
//   * `clearMocks` / `restoreMocks`. Left exactly as the root registry leaves
//     them, which means Vitest 5.0.1's defaults (`clearMocks: true`,
//     `restoreMocks: false`). Diverging would make a suite behave differently
//     under an IDE than under CI - the one thing a mirror config must never do.
// ---------------------------------------------------------------------------
import { defineConfig, defineProject } from 'vitest/config';
import type { UserWorkspaceConfig } from 'vitest/config';

/**
 * Paths neither project may ever collect. Applied to both projects below.
 *
 * Declaring `exclude` REPLACES Vitest's default list rather than extending it
 * (`defaultExclude` in 5.0.1 is exactly `['**\/node_modules/**', '**\/.git/**']`),
 * so both defaults are repeated here before anything is added.
 *
 * `test/fixtures/**` is the load-bearing entry, and it is not an optimisation.
 * That tree holds sample-project corpora and JSON payloads which are RUNTIME
 * INPUTS to the integration suites: `test/fixtures/sample-project` is a
 * self-contained Next.js application - its own `package.json`, its own
 * `tsconfig.json`, its own `.tsx` components - that exists to be indexed by the
 * ts-morph indexer, patched by the real installer and posted at the ingest
 * routes. Collecting anything from it as a spec would run a foreign project's
 * code under this workspace's runner. The root config's `sharedExclude` keeps
 * the same tree out of collection and `apps/local-service/tsconfig.json`
 * excludes it from the typecheck program, so all three agree.
 *
 * `dist/` (tsup output) and `.tsbuild/` (`tsc -b` declaration output) are
 * excluded because both sit inside this workspace and would otherwise re-admit
 * compiled copies of the same suites. The second fixture pattern is the same
 * rule spelled with a leading globstar, so a fixture tree nested under some
 * future subdirectory cannot slip back in.
 */
const sharedExclude: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.tsbuild/**',
  'test/fixtures/**',
  '**/test/fixtures/**',
];

/**
 * Project `local-service`: the colocated unit suites of the service.
 *
 * These are the fast suites that sit next to the code they cover - config
 * parsing and defaults, the session state-machine transition table, telemetry
 * attribution, redaction wiring, the auth token and Origin rules, source-path
 * containment, panel fallback assembly and retention. They must stay fast and
 * hermetic: no socket is opened, no dev server is launched and nothing under
 * `$DEBUGGEN_HOME` is touched, which is why this project needs none of the
 * execution policy the integration project below carries and runs with Vitest's
 * defaults (the `forks` pool, `isolate: true`, a 5 s test and 10 s hook budget).
 *
 * `globals: false` is the repository convention for Node projects and is
 * deliberate rather than stylistic: every suite imports `describe`, `it`,
 * `expect` and `vi` from `vitest` explicitly, which keeps the service honest
 * about what it depends on and matches how the root registry declares this same
 * project. `retry: 0` restates the default so the intent is on the record: a
 * flaky unit test must fail, never be masked by a second attempt.
 */
const unitProject: UserWorkspaceConfig = defineProject({
  test: {
    name: 'local-service',
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: sharedExclude,
    retry: 0,
  },
});

/**
 * Project `local-service-integration`: the in-process integration suites of
 * AAP 0.8.3 (`session-lifecycle`, `ws-protocol`, `telemetry-ingest`,
 * `pipeline-deterministic`, `cleanup-conflict`, `source-open`, `panel-fallback`,
 * `panel-data`, `binding`, `followup`, `auth`, `concurrency`).
 *
 * Every one of them boots a real service - HTTP plus a WebSocket upgrade on an
 * ephemeral port - creates a temporary `$DEBUGGEN_HOME` holding a `node:sqlite`
 * store, and copies `test/fixtures/sample-project` somewhere writable before the
 * real installer patches it. That makes the execution policy below part of the
 * contract rather than tuning:
 *
 *   * `fileParallelism: false` runs one suite file at a time (Vitest also forces
 *     `maxWorkers` to 1 when it is false). Concurrent files would race for
 *     ports, for the store and for the fixture copy, and a port or lock
 *     collision reads as a product bug when it is only a scheduling artefact.
 *   * `pool: 'forks'` states the pool this workspace requires instead of relying
 *     on it being the 5.0.1 default: the suites drive `node:sqlite`, child
 *     processes (the dev-server launcher) and `process.env`, all of which behave
 *     as they do in production only in a real child process.
 *   * `isolate: true` (also the default, restated because it is load-bearing
 *     here) gives each suite file a fresh process and module registry, so a
 *     store handle, a listening server or a cached config from one suite cannot
 *     survive into the next. This is deliberately NOT the `singleFork` shape:
 *     `test.poolOptions` was removed in Vitest 4 - its options are top-level now
 *     - and a single shared fork would trade exactly the isolation these suites
 *     depend on for a saving this suite count does not need.
 *   * `testTimeout` / `hookTimeout` of 30 s replace the 5 s / 10 s defaults,
 *     which a real pipeline run, a ts-morph instrumentation install or a cleanup
 *     reconciliation pass legitimately exceeds on a loaded machine. The budget is
 *     generous, not unbounded: a genuinely hung server still fails the run.
 *   * `retry: 0`. A flaky integration test must fail rather than be retried into
 *     a green run - it is usually reporting a real leak (an unclosed socket, a
 *     `$DEBUGGEN_HOME` left behind) that a retry would hide.
 *
 * `environment: 'node'` and `globals: false` mirror the root registry exactly;
 * the suites reach the service over `fetch` and a `ws` client, never a DOM.
 *
 * One divergence is deliberate and load-bearing when writing these suites: the
 * root registry declares this project through its generic node-project helper,
 * so a root-rooted run (`pnpm test`, `pnpm test:integration`) resolves it with
 * Vitest's defaults - files in parallel, a 5 s test and 10 s hook budget. The
 * policy above is a hardening of the workspace-scoped run, never a licence to
 * depend on it. Every suite must therefore stand on its own: an ephemeral port
 * (`listen(0)`), a unique temporary `$DEBUGGEN_HOME`, its own copy of the
 * fixture project, and either a step that fits the default budget or an explicit
 * per-test timeout. Written that way a suite is green from both entry points; a
 * suite that silently assumes serialization would pass here and be flaky in CI.
 */
const integrationProject: UserWorkspaceConfig = defineProject({
  test: {
    name: 'local-service-integration',
    environment: 'node',
    globals: false,
    include: ['test/integration/**/*.test.ts'],
    exclude: sharedExclude,
    pool: 'forks',
    fileParallelism: false,
    isolate: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 0,
  },
});

/**
 * Declaring `projects` makes this file a container: it never collects tests
 * itself, it only provides the two projects above. That is what lets a
 * workspace-rooted `vitest run --project local-service` (or
 * `--project local-service-integration`) resolve the same names the root
 * registry uses, and what makes an editor list both suites of this workspace.
 *
 * No other `test` option is set at this level. Inline projects inherit the
 * container's options (`extends` defaults to `true`), so keeping the container
 * empty means each project's own options are exactly what Vitest runs - there is
 * no merge to reason about, and in particular no second copy of `exclude` to
 * keep in sync.
 */
export default defineConfig({
  test: {
    projects: [unitProject, integrationProject],
  },
});
