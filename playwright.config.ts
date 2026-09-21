/**
 * Playwright configuration for the Debug Generator monorepo (AAP 0.3.4, 0.7.1 Group 0).
 *
 * Two projects, and the names are contracts because the root package.json binds a
 * script to each one (AAP 0.8.5):
 *
 *   pnpm test:browser -> playwright test --project browser  -> tests/browser/**
 *   pnpm test:e2e     -> playwright test --project e2e      -> tests/e2e/**
 *
 * Both suites drive Chrome with the unpacked Manifest V3 extension loaded from
 * `apps/chrome-extension/dist`. The launch itself is NOT configured here: the specs
 * create their own persistent context in `tests/browser/fixtures.ts` with the recipe
 * verified in AAP 0.2.4 -
 *
 *   chromium.launchPersistentContext(userDataDir, {
 *     channel: 'chromium',
 *     args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
 *   })
 *
 * - because an unpacked extension cannot be loaded into Playwright's own managed
 * browser, and the MV3 service worker is reached through `context.serviceWorkers()` /
 * `context.waitForEvent('serviceworker')`. Consequently neither project declares a
 * browser (`devices['Desktop Chrome']`) or a `channel`: doing so would start a second,
 * extension-less browser alongside the persistent context the fixtures own. The bundled
 * Chromium of Playwright 1.63.0 (153.0.8010.12) is the version the extension's
 * `minimum_chrome_version: "153"` records, and it is exactly what CI installs with
 * `pnpm exec playwright install --with-deps chromium`.
 *
 * Paths, ports and URLs the specs need are published through `use` as typed test
 * options (see {@link DebuggenTestOptions}) and mirrored as named exports for helper
 * modules that are not test files.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Repository root. This file lives at the root of the workspace, so the directory that
 * contains it is the root; every path below is absolute or resolved against it, which
 * keeps the config correct no matter which directory Playwright is invoked from.
 */
const repoRoot = import.meta.dirname;

/**
 * Test options the browser and end-to-end suites read instead of re-deriving paths and
 * ports. Fixture modules declare them as Playwright options, for example:
 *
 * ```ts
 * import { test as base } from '@playwright/test';
 * import type { DebuggenTestOptions } from '../../playwright.config';
 *
 * export const test = base.extend<DebuggenTestOptions>({
 *   extensionPath: ['', { option: true }],
 *   serviceUrl: ['', { option: true }],
 *   demoUrl: ['', { option: true }],
 *   fixtureAppUrl: ['', { option: true }],
 * });
 * ```
 *
 * The values themselves are also exported individually for non-test helpers under
 * `tests/e2e/helpers/`, which run outside the fixture graph.
 */
export interface DebuggenTestOptions {
  /** Absolute path of the built, unpacked Chrome extension (`apps/chrome-extension/dist`). */
  extensionPath: string;
  /** Origin of the local coordination service, for example `http://127.0.0.1:43117`. */
  serviceUrl: string;
  /** Origin of the demo application ("Lumen Supply"), started through the product launcher. */
  demoUrl: string;
  /** Origin of the generic fixture app under `tests/fixtures/sample-next-app`. */
  fixtureAppUrl: string;
}

/**
 * Product defaults (AAP 0.3.4). Every one of them is overridable by environment.
 *
 * This file reads its overrides from the PROCESS environment only - it loads no `.env`,
 * because a Playwright config runs before any product code that would - so `DEMO_URL` and
 * `FIXTURE_APP_URL` take effect when exported in the shell or set by CI, not when written
 * into `.env`. `/.env.example` documents both keys, with these defaults, under that exact
 * caveat; `scripts/dev-instrumented.test.mjs` asserts the two files agree, so changing a
 * default here without updating that documentation fails the test suite.
 */
const DEFAULT_SERVICE_HOST = '127.0.0.1';
const DEFAULT_SERVICE_PORT = '43117';
const DEFAULT_DEMO_URL = 'http://localhost:3000';
/**
 * The fixture app declares `next dev --port 3100` in tests/fixtures/sample-next-app, so
 * it can never collide with the demo application on 3000.
 */
const DEFAULT_FIXTURE_APP_URL = 'http://localhost:3100';

/**
 * Reads an environment variable, treating an empty or whitespace-only value as unset so
 * that `DEBUGGEN_PORT=` in a stray `.env` cannot produce the URL `http://127.0.0.1:`.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const serviceHost = readEnv('DEBUGGEN_HOST') ?? DEFAULT_SERVICE_HOST;
const servicePort = readEnv('DEBUGGEN_PORT') ?? DEFAULT_SERVICE_PORT;

/** Absolute path of the built, unpacked Chrome extension both suites load. */
export const extensionPath = path.join(repoRoot, 'apps', 'chrome-extension', 'dist');
/** Origin of the local coordination service (AAP 0.3.4: `DEBUGGEN_HOST`, `DEBUGGEN_PORT`). */
export const serviceUrl = `http://${serviceHost}:${servicePort}`;
/** Origin of the demo application; the e2e helpers start it through the product launcher. */
export const demoUrl = readEnv('DEMO_URL') ?? DEFAULT_DEMO_URL;
/** Origin of the generalization fixture app (`tests/fixtures/sample-next-app`). */
export const fixtureAppUrl = readEnv('FIXTURE_APP_URL') ?? DEFAULT_FIXTURE_APP_URL;

/**
 * Session home for the service started by `webServer`. `DEBUGGEN_HOME` is honoured when
 * set - CI sets it to `${{ runner.temp }}/debuggen` (AAP 0.7.1 Group 0) and parallel
 * clones set it per clone - and otherwise a repository-local directory is used instead of
 * the product default `~/.debuggen`, so a test run never writes session databases, auth
 * tokens or file backups into the developer's real home. `test-results/` is git-ignored,
 * which keeps `git status --porcelain` clean after a run.
 */
export const debuggenHome =
  readEnv('DEBUGGEN_HOME') ?? path.join(repoRoot, 'test-results', 'debuggen-home');

/**
 * Environment for the service process. Playwright merges this over `process.env`, so
 * anything not named here (`ANTHROPIC_API_KEY`, `DEBUGGEN_LOG_LEVEL`, ...) is inherited
 * unchanged. The provider defaults to `deterministic`: the suites must never depend on a
 * network model call (AAP 0.5.3, 0.5.4). `DATABASE_URL` is forwarded only when it is set,
 * because the type of `webServer.env` admits strings only and an explicit `undefined`
 * would mask a value the service can otherwise read from its own `.env`.
 */
const databaseUrl = readEnv('DATABASE_URL');

const serviceEnv: Record<string, string> = {
  DEBUGGEN_PROVIDER: readEnv('DEBUGGEN_PROVIDER') ?? 'deterministic',
  DEBUGGEN_HOST: serviceHost,
  DEBUGGEN_PORT: servicePort,
  DEBUGGEN_HOME: debuggenHome,
  ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }),
};

/** Flags that make `playwright test` enumerate or explain rather than execute. */
const NON_EXECUTING_FLAGS = new Set(['--list', '--help', '-h']);

/**
 * True when this process is about to RUN tests, as opposed to listing them, printing
 * help, serving a report or loading the config programmatically.
 *
 * The distinction matters for the build guard below: `playwright test --list` must keep
 * working on a tree where nothing has been built yet (it is how the project split is
 * verified), while an actual run without the built extension can only fail obscurely
 * inside Chromium. Worker processes are forked without a subcommand, so they report
 * `false` and never re-run a guard the main process already satisfied.
 *
 * Exported so the check can be exercised directly rather than only through the CLI.
 */
export function isTestExecution(argv: readonly string[] = process.argv): boolean {
  const args = argv.slice(2);
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  if (subcommand !== 'test') {
    return false;
  }
  return !args.some((arg) => NON_EXECUTING_FLAGS.has(arg));
}

/**
 * Explains, in one place and in the developer's terms, that the unpacked extension has
 * not been built. Without this the failure surfaces as a Chromium launch error or an
 * empty `context.serviceWorkers()`, neither of which names the missing step.
 */
function chromeExtensionBuildAdvice(): string[] {
  const detail = existsSync(extensionPath)
    ? `The directory exists but holds no manifest.json, so the Vite/crxjs build did not finish.`
    : `The directory does not exist.`;
  return [
    `Debug Generator: the Chrome extension has not been built.`,
    ``,
    `  expected: ${path.join(extensionPath, 'manifest.json')}`,
    `  ${detail}`,
    ``,
    `Both Playwright projects load that directory as an unpacked Manifest V3 extension.`,
    `Build it first:`,
    ``,
    `  pnpm build`,
    ``,
    `or, for just the two workspaces that produce it, in this order:`,
    ``,
    `  pnpm --filter @debuggen/telemetry build`,
    `  pnpm --filter @debuggen/chrome-extension build`,
    ``,
    `The extension's prebuild step copies packages/telemetry/dist/browser-agent.iife.js`,
    `into apps/chrome-extension/public/agent.iife.js, which is why @debuggen/telemetry`,
    `must be built first.`,
  ];
}

// Fail fast, before Playwright starts a browser, when the extension is missing. On an
// invocation that only enumerates or explains the suites the same guidance is a warning,
// so `playwright test --list` and IDE integrations keep working on an unbuilt tree.
if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
  const advice = chromeExtensionBuildAdvice();
  if (isTestExecution()) {
    throw new Error(
      [...advice, ``, `To enumerate the suites without building, run: playwright test --list`].join(
        '\n',
      ),
    );
  }
  console.warn(
    [
      `[playwright.config] ${advice[0] ?? ''}`,
      ...advice.slice(1),
      ``,
      `This invocation launches no browser, so it continues.`,
    ].join('\n'),
  );
}

export default defineConfig<DebuggenTestOptions>({
  // No root `testDir`. Each project sets its own, so neither suite can collect the
  // other's specs and `--project browser` / `--project e2e` stay disjoint.

  // Both suites drive ONE persistent Chromium context with an unpacked extension, and
  // they share one local service, one DEBUGGEN_HOME and one PostgreSQL database. Parallel
  // workers would interleave sessions, captures and instrumentation installs on that
  // shared state - and a capture is exclusive per project (AAP 0.4.2) - so the suites run
  // strictly serially.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  // `playwright-report/` is uploaded as a CI artifact (AAP 0.7.1 Group 0); both output
  // locations are git-ignored, so a run leaves the working tree clean.
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',

  // Sized for a real pipeline run, not for a page load: a single e2e test covers code
  // indexing, instrumentation install, a capture window, analysis and panel generation
  // (AAP 0.8.1 slice 10) over a demo checkout that deliberately takes 1.2-1.6 s
  // (AAP 0.8.2).
  timeout: 120_000,
  expect: { timeout: 15_000 },

  use: {
    // Diagnostics are kept only for failures: a passing suite produces no artifacts.
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',

    // Deliberately no `baseURL`: the browser suite talks to the fixture app while the
    // e2e suite talks to the demo, so a relative `page.goto('/')` would be ambiguous.
    // Specs navigate with `demoUrl` / `fixtureAppUrl` explicitly.
    extensionPath,
    serviceUrl,
    demoUrl,
    fixtureAppUrl,
  },

  projects: [
    // Extension-level integration against the generic fixture app (AAP 0.8.3):
    // extension-connect, telemetry-capture, panel-render, source-navigation.
    { name: 'browser', testDir: 'tests/browser', testMatch: '**/*.spec.ts' },
    // Full-stack demo flows (AAP 0.8.3): demo-slow-interaction, demo-excessive-renders,
    // demo-duplicate-requests, cleanup, generalization. `testMatch` keeps the shared
    // modules under tests/e2e/helpers/ out of collection.
    { name: 'e2e', testDir: 'tests/e2e', testMatch: '**/*.spec.ts' },
  ],

  // Exactly ONE web server: the local coordination service.
  //
  // The demo dev server and the fixture app are intentionally NOT `webServer` entries.
  // `webServer` is global rather than per-project, and AAP 0.8.3 requires the e2e helpers
  // to "start the demo through the launcher (preload attached)" - that is
  // `POST /dev-server/launch`, which runs the product's own
  // apps/local-service/src/dev-server/launcher.ts and applies
  // `NODE_OPTIONS=--import` of the telemetry preload. Declaring the demo here would both
  // start it twice and bypass the very code path under test; the fixture app is likewise
  // started by tests/browser/fixtures.ts. Together with this entry that satisfies "web
  // servers for service and demo" (AAP 0.7.1 Group 0) without weakening either
  // requirement.
  //
  // `reuseExistingServer` is the contract helper authors must respect: locally, a service
  // that already answers `${serviceUrl}/health` is reused and this command is never run,
  // so a helper handed a live `serviceUrl` must reuse it too and must not spawn a
  // competing instance - two services on one port mean EADDRINUSE at best and a silent
  // answer from a stale process at worst. In CI it is false, so the run owns its service
  // and a leftover process is an error rather than a silent dependency.
  webServer: {
    name: 'debuggen local service',
    command: 'node apps/local-service/dist/main.js',
    cwd: repoRoot,
    url: `${serviceUrl}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // SIGTERM rather than SIGKILL: the service reverts instrumentation and closes the
    // session store on shutdown (AAP 0.5.1), and a killed service would leave patched
    // files behind for the next run's reconciliation to clean up.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    env: serviceEnv,
  },
});
