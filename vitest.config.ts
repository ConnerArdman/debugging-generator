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
// Two behaviours below are COMPUTED at config load rather than declared, and
// both are deliberately as narrow as the problem they solve:
//   * `passWithNoTests` is enabled for exactly one shape of run - a run filtered
//     to `local-service-integration` alone, at a position where no integration
//     suite file exists on disk yet. See `passWithNoIntegrationSuites` below.
//   * a preflight that warns, once and without failing, when a workspace
//     package's built `exports` entry is missing. On an unbuilt tree most suites
//     fail with `Failed to resolve entry for package "@debuggen/…"`, which names
//     neither the cause nor the remedy; the preflight names both. See
//     `warnAboutUnbuiltPackages` below.
//
// Deliberately NOT configured here, each for a stated reason:
//   * `resolve.alias` for `@debuggen/*`. Cross-package imports must resolve
//     through each package's `exports` map into `dist/`, which is why `pnpm build`
//     precedes tests (AAP 0.2.2). An alias to `src/**` would let a test pass
//     against a broken `exports` map and would bypass the acyclic package
//     layering that eslint.config.js enforces.
//   * a `pretest` build in the root `package.json`. AAP 0.8.5 fixes `pnpm test`
//     as `vitest run --coverage`, and `pnpm verify` already runs `pnpm build`
//     ahead of it, so a `pretest` would both redefine the gate and build the
//     workspace twice in every verify run. The preflight above reports the
//     missing build instead of performing it.
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
//   * a blanket `passWithNoTests: true`. Measured behaviour of Vitest 5.0.1: a
//     project with no matching files does not fail a run in which another
//     project has files, so `pnpm test` needs nothing; and an unfiltered empty
//     run genuinely means the include globs stopped matching - which must fail
//     rather than pass quietly. Only the one narrow case described above is
//     admitted.
//   * `jsdom`. Rejected by AAP 0.3.2 in favour of happy-dom 20.14.5, whose
//     install is smaller and whose startup is faster across per-package projects;
//     the component tests need DOM/layout semantics only, never canvas.
// ---------------------------------------------------------------------------
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';
import type { UserWorkspaceConfig } from 'vitest/config';

/**
 * The name of the integration project, declared once.
 *
 * It is a contract in three places at once - the project below, the
 * `--project` filter of `pnpm test:integration` (AAP 0.8.5) and the argv
 * inspection that scopes `passWithNoTests` - so the string exists once and all
 * three read it from here. Renaming it would silently turn the gate into a
 * no-op that exits 1, which is exactly what this constant makes impossible to
 * do by halves.
 */
const INTEGRATION_PROJECT_NAME = 'local-service-integration';

/**
 * Filename suffixes the integration-suite probe below counts as a suite.
 *
 * Deliberately WIDER than the project's own `test/integration/**\/*.test.ts`
 * include glob: a suite written as `.test.tsx` or `.test.mts` would not be
 * collected by that glob, and the probe exists to answer "has anyone written an
 * integration suite yet?", not "does the glob match?". Being wider is what
 * makes a mismatch between the two fail the gate loudly instead of letting
 * `pnpm test:integration` pass vacuously over a suite it silently ignores.
 */
const INTEGRATION_SUITE_SUFFIXES: readonly string[] = ['.test.ts', '.test.tsx', '.test.mts'];

/**
 * The `--project` filters of the command line that loaded this config.
 *
 * Vitest accepts the option repeatably and in both spellings
 * (`--project a --project b`, `--project=a`), so both are parsed. `process.argv`
 * is readable at config-load time - this module is evaluated in the Vitest main
 * process, whose argv is the user's command line - which is what lets the
 * `passWithNoTests` policy below depend on WHICH run this is, something no
 * static option can express.
 *
 * A `--project` with no value after it (or another flag next) contributes
 * nothing rather than swallowing the following argument, so a malformed command
 * line cannot widen the policy by accident.
 *
 * @param argv The process argument vector to inspect.
 * @returns Every project name named by a `--project` filter, in argv order.
 */
function projectFiltersFromArgv(argv: readonly string[]): string[] {
  const names: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--project') {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('-')) {
        names.push(value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--project=')) {
      names.push(arg.slice('--project='.length));
    }
  }

  return names;
}

/**
 * How many integration suite files exist on disk, right now.
 *
 * `readdirSync(..., { recursive: true, withFileTypes: true })` is used rather
 * than a glob library so the probe adds no dependency and no async work to
 * config load. A missing directory is the expected state before the first suite
 * of AAP 0.8.3 lands, so ENOENT (and any other read failure) answers zero
 * instead of throwing: a config that throws would break every run, including
 * the ones that do not care about this project at all.
 *
 * Recursion does not follow a symlinked directory - `isDirectory()` is false for
 * a symlink - so the probe cannot loop, while a symlink that POINTS at a suite
 * file still counts, keeping the count on the safe (wider) side.
 *
 * @param directory Absolute path of the integration suite directory.
 * @returns The number of files whose name ends in an INTEGRATION_SUITE_SUFFIXES entry.
 */
function countIntegrationSuiteFiles(directory: string): number {
  try {
    return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(
      (entry) =>
        !entry.isDirectory() &&
        INTEGRATION_SUITE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Whether this invocation is restricted to the integration project alone.
 *
 * "At least one `--project` filter, and every one of them naming
 * `local-service-integration`" - so `pnpm test:integration` and the workspace's
 * own `vitest run --root ../.. --project local-service-integration` qualify,
 * while an unfiltered `pnpm test` and any run that also names another project do
 * not.
 */
const projectFilters: readonly string[] = projectFiltersFromArgv(process.argv);
const filteredToIntegrationOnly =
  projectFilters.length > 0 && projectFilters.every((name) => name === INTEGRATION_PROJECT_NAME);

/**
 * The integration suite directory of AAP 0.8.3, resolved from THIS file's URL
 * rather than from `process.cwd()`.
 *
 * The same run is started from the repository root (`pnpm test:integration`) and
 * from the workspace (`vitest run --root ../.. --project …`), so a cwd-relative
 * path would give the two runs different answers and make the gate's behaviour
 * depend on where it was typed.
 */
const integrationSuiteFilesOnDisk = countIntegrationSuiteFiles(
  fileURLToPath(new URL('./apps/local-service/test/integration', import.meta.url)),
);

/**
 * The narrow `passWithNoTests` policy (root-level, because Vitest 5.0.1 lists
 * `passWithNoTests` in `NonProjectOptions`: `ProjectConfig` omits it, so setting
 * it on a project has no effect at all).
 *
 * While the integration suites of AAP 0.8.3 are legitimately unwritten, a run
 * filtered to `local-service-integration` alone collects nothing and Vitest
 * exits 1 - which aborts the `&&` chain of `pnpm verify` (AAP 0.8.5) at
 * `pnpm test:integration`, so `check:no-hardcoding`,
 * `check:no-residual-instrumentation` and `check:secrets` never run. With this
 * flag that one shape of run passes vacuously and the chain reaches the three
 * guard checks.
 *
 * The flag is false again the moment the first integration suite file lands, so
 * an include glob that stops matching a suite that exists still fails the gate
 * loudly - and it is false for every other run, including `pnpm test`, so a
 * repository-wide collection failure can never pass quietly.
 */
const passWithNoIntegrationSuites = filteredToIntegrationOnly && integrationSuiteFilesOnDisk === 0;

/**
 * Parses a JSON file into a plain object, or answers `undefined`.
 *
 * Used by the preflight below on workspace manifests. Every failure mode -
 * absent file, unreadable file, malformed JSON, a top-level array or scalar -
 * collapses to `undefined`, because a preflight whose job is to IMPROVE an error
 * message must never become the error: a directory under `packages/` that is not
 * a workspace package (a stray build output, a half-created folder) simply
 * contributes nothing.
 *
 * @param fileUrl Absolute `file:` URL of the JSON document.
 * @returns The parsed object, or `undefined` when it is not a readable JSON object.
 */
function readJsonObject(fileUrl: URL): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileUrl, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The module file the `"."` entry of an `exports` map resolves to.
 *
 * Handles every shape an `exports` field may take here: the sugar form (a bare
 * string, `"exports": "./dist/index.js"`), a subpath map whose `"."` is a
 * string, and a subpath map whose `"."` is a conditions object - which is what
 * all eight packages use today (`{ types, import }` in four,
 * `{ types, default }` in two, `{ types, import, default }` in two). Conditions
 * are read in the order an ESM-only workspace resolves them, so `import` wins
 * over a CommonJS fallback that would not be what a suite loads.
 *
 * `types` is deliberately not a candidate: declaration output can exist without
 * the runtime module, so checking it would report a package as built that no
 * test can actually import.
 *
 * @param exportsField The raw `exports` field of a workspace manifest.
 * @returns The relative target of the `"."` entry, or `undefined` when there is none.
 */
function dotExportTarget(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') {
    return exportsField;
  }
  if (typeof exportsField !== 'object' || exportsField === null) {
    return undefined;
  }
  const dot: unknown = (exportsField as Record<string, unknown>)['.'];
  if (typeof dot === 'string') {
    return dot;
  }
  if (typeof dot !== 'object' || dot === null) {
    return undefined;
  }
  const conditions = dot as Record<string, unknown>;
  for (const condition of ['import', 'module', 'default', 'require']) {
    const target: unknown = conditions[condition];
    if (typeof target === 'string') {
      return target;
    }
  }
  return undefined;
}

/**
 * The workspace packages whose `"."` export target does not exist on disk.
 *
 * Every path is resolved from this config file's own URL, never from
 * `process.cwd()`, so the answer is the same for a repository-rooted run and a
 * workspace-rooted one (`vitest run --root ../..`).
 *
 * @returns Package names (manifest `name`, falling back to the directory name), sorted.
 */
function packagesMissingTheirBuiltEntry(): string[] {
  const packagesDir = new URL('./packages/', import.meta.url);

  let directoryNames: string[];
  try {
    directoryNames = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const unbuilt: string[] = [];
  for (const directoryName of directoryNames) {
    const packageDir = new URL(`${directoryName}/`, packagesDir);
    const manifest = readJsonObject(new URL('package.json', packageDir));
    if (manifest === undefined) {
      continue;
    }
    const target = dotExportTarget(manifest['exports']);
    if (target === undefined || existsSync(new URL(target, packageDir))) {
      continue;
    }
    const name = manifest['name'];
    unbuilt.push(typeof name === 'string' ? name : directoryName);
  }

  return unbuilt;
}

/**
 * Preflight: one actionable line when the workspace is not built.
 *
 * Most test files import a sibling `@debuggen/*` package - 57 of the 67 that
 * exist as this is written - and those imports resolve through the package's
 * `exports` map into `dist/` (AAP 0.2.2) -
 * never through a `resolve.alias`, for the reason stated in the header. On an
 * unbuilt tree Vite therefore fails each of them with
 * `Failed to resolve entry for package "@debuggen/…"`, an error that names
 * neither the cause nor the remedy. This prints the remedy once, before the
 * suites start.
 *
 * It WARNS and never throws, for two reasons: a run that needs no `dist` at all
 * (`--project tooling`, whose suites are plain-Node guard scripts) must keep
 * working, and a config that throws would replace a bad error message with no
 * run at all. Nothing is printed when every package is built, so a normal run's
 * output is unchanged.
 */
function warnAboutUnbuiltPackages(): void {
  const unbuilt = packagesMissingTheirBuiltEntry();
  if (unbuilt.length === 0) {
    return;
  }

  process.stderr.write(
    `\nvitest preflight: ${String(unbuilt.length)} workspace package(s) are not built (${unbuilt.join(', ')}) - run \`pnpm build\` first, because most test files import a sibling package through its "exports" map into dist/ (AAP 0.2.2) and will otherwise fail with 'Failed to resolve entry for package'.\n\n`,
  );
}

warnAboutUnbuiltPackages();

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
 * The source trees the coverage report must account for, whether or not a test
 * ever loaded them.
 *
 * Without this list Vitest reports only the files some test touched ("By default
 * only files covered by tests are included"), so a module no suite imports is
 * absent from the report altogether rather than shown at 0% - which both hides
 * the gap and inflates the headline percentages, because they are computed over
 * a denominator that silently omits those files.
 *
 * Vitest 5.0.1 has no `coverage.all` option (it is not part of `CoverageOptions`
 * at all); `coverage.include` is the option that does this, and `coverageExclude`
 * below is applied on top of it.
 *
 * The trees are exactly the code the Vitest projects own and hold suites for:
 * the packages' sources, the service's sources, the VS Code extension's host
 * sources (the `vscode-extension-host` project), and the repository guard
 * scripts of AAP 0.3.4 and 0.5.4. Deliberately NOT widened to
 * `apps/chrome-extension` or to `apps/vscode-extension/src/webview/**` (kept
 * out through `coverageExclude`): their projects hold no suite at this
 * position, so including them would bury the real gaps under whole unmeasured
 * applications. `apps/demo-app` stays out for the reason stated under
 * `coverageExclude` - it is Playwright's subject, not Vitest's.
 */
const coverageInclude: string[] = [
  'packages/*/src/**/*.{ts,tsx}',
  'apps/local-service/src/**/*.ts',
  'apps/vscode-extension/src/**/*.ts',
  'scripts/*.mjs',
];

/**
 * Files kept out of the coverage report (`pnpm test` = `vitest run --coverage`).
 *
 * Applied AFTER `coverageInclude` above (Vitest 5.0.1: "Files are first checked
 * against `coverage.include`"), so this list is what trims the tests themselves,
 * config and build tooling, the declaration output of `tsc -b`, the guard
 * scripts' own suites, the demo application - which is exercised end to end
 * through Playwright (AAP 0.8.3) rather than by any Vitest project - and the VS
 * Code webview, whose project holds no suite yet, back out of the source trees
 * the include globs sweep in.
 *
 * No `*.d.ts` exclusion is needed: the `include` trees hold no hand-written
 * declaration file, and generated declarations live in `dist/` and `.tsbuild/`,
 * both excluded here.
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
  'apps/vscode-extension/src/webview/**',
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
 *
 * `additionalExclude` narrows ONE project beyond `sharedExclude`, for a project
 * whose include glob covers a subtree another project owns (the extension host
 * project and `src/webview/**`). It is appended, never substituted, so every
 * shared exclusion still applies to that project too.
 *
 * @param name The project name - a contract for every `--project` filter.
 * @param include Repository-root relative include globs.
 * @param additionalExclude Extra exclude globs for this project only.
 */
function nodeProject(
  name: string,
  include: string[],
  additionalExclude: readonly string[] = [],
): UserWorkspaceConfig {
  return defineProject({
    test: {
      name,
      environment: 'node',
      globals: false,
      include,
      exclude: [...sharedExclude, ...additionalExclude],
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
        name: INTEGRATION_PROJECT_NAME,
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

    // Scoped vacuous pass, computed above: true only for a run filtered to
    // `local-service-integration` alone while that project's suites are not yet
    // written, which is what keeps `pnpm verify` (AAP 0.8.5) reaching
    // `check:no-hardcoding`, `check:no-residual-instrumentation` and
    // `check:secrets` instead of aborting its `&&` chain at
    // `pnpm test:integration`. It is a root-level option by necessity - Vitest
    // 5.0.1 omits `passWithNoTests` from `ProjectConfig` - and it is false for
    // `pnpm test` and for every other filter, so an empty run of anything else
    // still fails. See `passWithNoIntegrationSuites` for the full reasoning.
    passWithNoTests: passWithNoIntegrationSuites,

    // Coverage is a root-only option - Vitest ignores it inside a project - so
    // one report covers every project of a `pnpm test` run. `text` prints the
    // table in the terminal, `lcov` writes the machine-readable report that CI
    // and editors consume. `coverage/` is git-ignored.
    //
    // `include` is what makes the report cover the source trees rather than only
    // the files some suite happened to load: a module no test imports appears at
    // 0% instead of vanishing from the report and from the denominator of the
    // headline numbers. `exclude` is applied after it. Both lists and the
    // reasoning behind their exact contents are above.
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
      include: coverageInclude,
      exclude: coverageExclude,
    },

    // One project per workspace that owns a Vitest suite, plus `tooling` for the
    // repository guard scripts. Include globs are repository-root relative and no
    // project sets `root`, so all of them share one Vite server and its transform
    // cache (`sharedViteServer`).
    //
    // Two trees deliberately have NO project here:
    //   * `apps/demo-app` - AAP 0.8.3 defines no Vitest suite for it; it is the
    //     instrumentation target, exercised by `tests/e2e/**`, and its generated
    //     Prisma client must never be collected or measured.
    //   * `apps/vscode-extension/test/suite/**` - those tests need a real
    //     extension host and run under `pnpm test:vscode` (`@vscode/test-cli`),
    //     where the `vscode` module exists.
    // The VS Code extension's Vitest code is therefore split in two projects:
    // the webview React code, which is plain DOM code
    // (`vscode-extension-webview`), and host LOGIC colocated under `src/**`
    // that runs with the `vscode` module substituted through `vi.mock`
    // (`vscode-extension-host`). A suite that needs the real editor - activation,
    // command registration, a document actually shown - belongs under
    // `test/suite/**`, not here.
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
      // node: the extension host is a Node process. Its colocated logic suites
      // - today the `vscode://` URI handler's validation sequence, driven
      // against real temporary directories - substitute the `vscode` module
      // with `vi.mock`, which works although no installable package provides
      // it (the editor supplies it at runtime). `src/webview/**` is excluded for
      // this project only: it is the webview project's tree, and a `.test.ts`
      // there must run once, under happy-dom.
      nodeProject(
        'vscode-extension-host',
        ['apps/vscode-extension/src/**/*.test.ts'],
        ['apps/vscode-extension/src/webview/**'],
      ),

      // --- repository tooling -----------------------------------------------
      // The guard scripts of AAP 0.3.4 and 0.5.4 (`check-secrets`,
      // `check-no-hardcoding`) ship their own tests, and AAP 0.7.1 Group 0
      // requires `pnpm test` to run them, so they get a project of their own.
      // They are `.mjs` because the scripts they test are plain Node ESM.
      //
      // `scripts/*.test.mjs` is named first because AAP 0.7.1 Group 0 names it;
      // the two workspace-root globs extend the same project to the build
      // scripts that live beside a workspace manifest rather than under
      // `scripts/` - today `packages/telemetry/esbuild.agent.test.mjs` and
      // `esbuild.node.test.mjs`, which cover the exit-code contract of the two
      // esbuild drivers. A `*.test.mjs` at a workspace ROOT is by construction
      // a plain-Node build-script suite: every product suite is TypeScript
      // under `src/**` or `test/**`, so nothing else can match, and these
      // belong with the guard-script tests rather than in a project of their
      // own. Only the root level is matched (`packages/*/` and `apps/*/`, not
      // `**`), so a `.mjs` fixture deeper in a workspace stays uncollected.
      // Leaving these suites out of every include glob is what let the build
      // scripts' precondition branches - the exit codes a successful CI build
      // never reaches - go untested.
      nodeProject('tooling', ['scripts/*.test.mjs', 'packages/*/*.test.mjs', 'apps/*/*.test.mjs']),
    ],
  },
});
