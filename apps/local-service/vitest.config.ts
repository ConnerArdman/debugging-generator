// ---------------------------------------------------------------------------
// @debuggen/local-service - workspace-local Vitest configuration.
//
// AAP 0.9.1 lists `vitest.config.ts` among this workspace's in-scope paths. It
// exists for runs whose root is THIS directory - editor/IDE test integration and
// a bare `vitest` invoked from inside the workspace - while the repository-root
// vitest.config.ts stays the authoritative project registry for every gate.
//
// ONE DEFINITION, TWO CONTAINERS - settled by reading the root config
// -------------------------------------------------------------------
// The root config declares its projects inline and EXPORTS the two belonging to
// this workspace as a factory, `localServiceProjects({ baseDir, exclude })`,
// which returns
//
//   local-service              <baseDir>/src/**/*.test.ts
//   local-service-integration  <baseDir>/test/integration/**/*.test.ts
//
// both `environment: 'node'` with `globals: false`, both carrying the root's
// hermetic environment (`DEBUGGEN_PROVIDER=deterministic` and an emptied
// `ANTHROPIC_API_KEY`, AAP 0.5.3/0.8.3), and the integration project carrying
// its execution policy: `pool: 'forks'`, `fileParallelism: false`,
// `isolate: true`, 30 s `testTimeout`/`hookTimeout` and `retry: 0`.
//
// This file imports that factory with `baseDir: ''`, because a run rooted here
// resolves the globs against THIS directory. So the two containers register the
// same two projects from the same source: a workspace-rooted run behaves like
// the corresponding slice of a root run by construction, rather than by two
// declarations being kept in agreement by hand - which is what previously left
// the integration suites running under the 5 s/10 s defaults and in parallel on
// the root path, where every gate actually runs them.
//
// The import direction is forced and must not be flipped: eslint.config.js
// forbids a cross-workspace relative import (anything matching `../…/apps/` or
// `../…/packages/`) everywhere in the repository, so the root may not import
// this file, while `../../vitest.config` from here is allowed. Two further
// rules follow and are not negotiable: this path must never be added to the
// root `projects` array (that double-registers the names and Vitest fails the
// run with "Project name … is not unique"), and neither name may be renamed or
// joined by a third, because the names are the contract behind the blocking
// gates - `pnpm test:integration` is literally
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
//     temporary `$DEBUGGEN_HOME` and their ephemeral port through injected
//     config, which is what makes them re-runnable; a workspace-wide setup file
//     would turn that into a hidden global. If one ever becomes genuinely
//     necessary it belongs under `test/`, declared on the project that needs it.
//   * `process.env` writes. This module is evaluated once, in the Vitest main
//     process, so a mutation here would leak into every project of the run and
//     into an editor's long-lived Vitest server. The provider and credential
//     guarantee is not made that way: it travels with the shared projects as
//     Vitest's own per-project `test.env`, which the worker applies to its own
//     `process.env` before a test module loads and which therefore cannot
//     outlive the run. A suite needing a different value stubs it per test with
//     `vi.stubEnv`.
//   * `resolve.alias` for `@debuggen/*`. Cross-package imports must resolve
//     through each package's `exports` map into `dist/` (AAP 0.2.2), exactly as
//     Node, tsup and the esbuild bundle of apps/vscode-extension resolve them;
//     an alias to `src/**` would let a suite pass against a broken exports map
//     and would hide the acyclic package layering.
//   * `plugins`, `reporters`, and any test-tooling dependency. Vitest 5.0.1 is
//     pinned once, in the root manifest; this workspace adds nothing to it. With
//     no Vite-level option set, the projects below also stay eligible for the
//     shared Vite server and its transform cache.
//   * `clearMocks` / `restoreMocks`. Left exactly as the shared definition
//     leaves them, which means Vitest 5.0.1's defaults (`clearMocks: true`,
//     `restoreMocks: false`). Diverging would make a suite behave differently
//     under an IDE than under CI - the one thing this file must never do.
// ---------------------------------------------------------------------------
import { defineConfig } from 'vitest/config';
// The `.ts` extension is spelled out deliberately. Vite 8's `configLoader:
// 'native'` - announced as a future default - cannot load an extensionless
// relative import from a config file and warns "Add the file extension" on
// every run that resolves this file; Node's own TypeScript loader, which that
// mode uses, requires the real filename too. It needs no
// `allowImportingTsExtensions`: neither this file nor the root config belongs to
// any `tsc -b` program (the root solution declares `files: []`, this workspace's
// tsconfig.json includes only `src/**` and `test/**`, and tests/tsconfig.json
// omits both on purpose), so the compiler never resolves this specifier. Should
// a future project ever include a config file, that flag - or moving the shared
// factory into a non-config module - is the change to make, never dropping the
// extension and reinstating the warning.
import { hermeticEnv, localServiceProjects } from '../../vitest.config.ts';

/**
 * Paths neither project may ever collect, spelled relative to THIS directory
 * because that is the root of a run served by this file. The root container
 * passes its own, repository-root-relative list to the same factory, and it has
 * to: that list also keeps `tests/**` (Playwright's territory) and the demo's
 * generated Prisma client out of collection, and neither path exists below this
 * workspace.
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
 * Declaring `projects` makes this file a container: it never collects tests
 * itself, it only provides the two projects the shared factory returns. That is
 * what lets a workspace-rooted `vitest run --project local-service` (or
 * `--project local-service-integration`) resolve the same names the root
 * registry uses, and what makes an editor list both suites of this workspace.
 *
 * `baseDir: ''` is what makes the factory's globs workspace-relative here
 * (`src/**\/*.test.ts`, `test/integration/**\/*.test.ts`) while the root passes
 * `apps/local-service` for the same two projects.
 *
 * `env` is the one option set at this level, and it is the same record both
 * shared projects already carry: no suite of this workspace may inherit the
 * developer's ambient `DEBUGGEN_PROVIDER` or real `ANTHROPIC_API_KEY`, whichever
 * container registered it (AAP 0.5.3, 0.8.3). Declaring it here is the backstop
 * - inheritance merges an object by key, so the value is identical rather than
 * doubled - and it means the guarantee is visible in this file instead of only
 * in the factory it imports.
 *
 * Nothing else is set at this level. Inline projects inherit the container's
 * options (`extends` defaults to `true`), so keeping it otherwise empty means
 * each project's own options are exactly what Vitest runs - and in particular
 * there is no second copy of `exclude`, which inheritance would concatenate
 * rather than merge.
 */
export default defineConfig({
  test: {
    env: { ...hermeticEnv },
    projects: localServiceProjects({ baseDir: '', exclude: sharedExclude }),
  },
});
