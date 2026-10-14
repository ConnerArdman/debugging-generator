/**
 * The lifecycle of the generic fixture application `tests/fixtures/sample-next-app` — the
 * target of `generalization.spec.ts`, the run that proves no demo knowledge is baked into the
 * product.
 *
 * It offers the same contract as `demo-app.ts` (launch through the product's launcher, the
 * tracked-file snapshot, the restoration check, the residual-instrumentation gate, a serving
 * probe and runtime source lookup) for a project that shares no symbol names with the demo.
 *
 * ## What this module owns
 *
 * - **Identity and address.** {@link SAMPLE_APP_REL_DIR}, {@link sampleAppRoot},
 *   {@link sampleAppPort} (`SAMPLE_APP_PORT`, else the port of the Playwright config's
 *   `fixtureAppUrl` — `FIXTURE_APP_URL`, default `http://localhost:3100`) and
 *   {@link sampleAppBaseUrl}. The host is always `localhost`: `next dev` prints
 *   `http://localhost:<port>`, the launcher reports exactly that address, and the service binds a
 *   tab to the session whose dev-server **origin** matches — a tab opened at `127.0.0.1` would
 *   stay unbound. The port is deliberately distinct from the demo's (3000): with `workers: 1`
 *   and one Chromium context both apps may be up at once, and the port is what keeps their
 *   sessions apart.
 * - **The borrowed `next` binary.** The fixture is not a `pnpm-workspace.yaml` member, has no
 *   `node_modules` and must never get one, so it runs on the `next` installed for `apps/demo-app`
 *   ({@link resolveNextBinary}, {@link sampleAppLaunchCommand}).
 * - **A port ladder that is safe by construction** ({@link ensurePortFree}).
 * - **Launching and stopping through `POST /dev-server/launch` / `POST /dev-server/stop`**
 *   ({@link startSampleApp}, {@link stopSampleApp}), so the launcher attaches the telemetry
 *   preload: the server tier the generalization spec asserts only exists that way.
 *
 * ## How the fixture is started, and why the command looks the way it does
 *
 * The launcher spawns the request's `command` with the project root as its working directory
 * and no shell, after appending `--import <preload>` to `NODE_OPTIONS` and injecting
 * `DEBUGGEN_INGEST_URL`, `DEBUGGEN_TOKEN` and `DEBUGGEN_PROJECT_ROOT`. Without an explicit
 * command it would run the fixture's `dev` script through the detected package manager, which
 * cannot work in a directory without `node_modules`. The explicit command is therefore:
 *
 * ```text
 * NEXT_TELEMETRY_DISABLED=1 DEBUGGEN_LOG_LEVEL=warn NODE_PATH=<repo>/apps/demo-app/node_modules \
 *   <node> <repo>/apps/demo-app/node_modules/next/dist/bin/next dev --webpack --port <port>
 * ```
 *
 * Each part was measured on this repository, with the `next` version the demo and the fixture both
 * pin ({@link resolveBorrowedNext} refuses a fixture pin that differs from the demo's installed
 * `next`):
 *
 * - **`--webpack`.** The fixture's `next.config.ts` pins `turbopack.root` to its own directory,
 *   which is also the boundary Turbopack resolves packages within. A `next` that lives outside it
 *   answers every page with HTTP 500 ("Could not find the Next.js package"). Webpack resolves
 *   modules the Node way and honours `NODE_PATH`; the fixture's source, config and tracked files
 *   are untouched either way.
 * - **`NODE_PATH`.** Next's TypeScript check must find `@types/react`. When it cannot, it runs
 *   `pnpm install` for the directory — which rewrites the repository's tracked `pnpm-lock.yaml`
 *   and creates `node_modules` inside the fixture. The demo's `node_modules` holds exactly the
 *   packages the fixture pins, so pointing `NODE_PATH` at it makes every resolution succeed and
 *   nothing is installed. {@link resolveNextBinary} checks that before any launch.
 * - **`process.execPath`** runs the package's `bin` script directly, so neither the service's
 *   `PATH` nor pnpm's shim script decides which Node runs the app.
 * - **`--port <port>`** is explicit. `next dev` then refuses a taken port (it exits with
 *   `EADDRINUSE`) instead of silently moving to the next free one, and prints the address the
 *   launcher reports. No `--hostname`: Next then prints `http://localhost:<port>`.
 * - **`NEXT_TELEMETRY_DISABLED=1`** keeps a test run off the network.
 * - **`DEBUGGEN_LOG_LEVEL=warn`** pins the preload's own default. The preload also loads into
 *   the `tsc --showConfig` child `next dev` spawns and parses as JSON; a service started with
 *   `DEBUGGEN_LOG_LEVEL=debug` would otherwise hand that level down, the preload would write its
 *   diagnostics to that child's stdout, and the dev server would exit on the unparsable output.
 *
 * What the dev server writes into the fixture directory — `.next/` and `next-env.d.ts` — is
 * listed in the fixture's own `.gitignore`, so `git status --porcelain -- tests/fixtures/
 * sample-next-app` stays empty. That is exactly what {@link expectNoResidualInstrumentation}
 * asserts afterwards.
 *
 * ## Deliberate divergence from `tests/browser/fixtures.ts`
 *
 * The browser suite also launches the fixture through `POST /dev-server/launch`, but it serves a
 * **temporary copy** outside the repository with its own `node_modules`, and it falls back to a
 * preload-free spawn when the launch route is missing. That is right for its purpose — it
 * asserts browser-tier behaviour only — and wrong for this one. Here the tracked tree must be
 * served **in place**, because the product's installer, cleanup, this module's snapshot and the
 * residual gate all have to act on the tracked files. And the launcher is the only way in,
 * because the server tier (`http.server`, `route.handler`, `function` spans) is part of what the
 * generalization spec proves. There is no preload-free fallback.
 *
 * A fixture server that the browser suite leaves running holds the same default port, 3100, and
 * serves that copy — whose server agent, if any, reports to the copy's project root, never to
 * this one. {@link ensurePortFree} refuses such a server with the exact diagnosis instead of
 * letting the session silently collect zero server spans.
 *
 * ## No database
 *
 * The fixture has no data source, so there is no `ensureDatabase` equivalent and no
 * `DATABASE_URL` is read. A session over this project legitimately produces no `db.query` spans:
 * the correlated chain is `interaction` → `fetch` → `http.server` → `route.handler`, and
 * `generalization.spec.ts` asserts it without the database tier.
 *
 * ## What this module never does
 *
 * 1. **It never writes under `tests/fixtures/sample-next-app`.** It reads the fixture's
 *    `package.json` as text and drives the app over HTTP; the dev server's own output is
 *    git-ignored, and the product alone patches and restores source. Fixture source is never
 *    imported (`tests/tsconfig.json` excludes `fixtures/**`).
 * 2. **It never starts `next dev` itself and never signals a process.** It asks the launcher to
 *    start and stop its own child; a server it did not launch is reported, never stopped. It
 *    never scans the process table.
 * 3. **It never re-implements the marker scan or the worktree check.** Both run through
 *    `demo-app.ts`'s wrappers, which run `scripts/check-no-residual-instrumentation.mjs` in its
 *    `--path tests/fixtures/sample-next-app` mode.
 * 4. **It never reads `.git/`** and never logs anything that could carry a credential: the
 *    launch command holds absolute paths and flags only, and the launcher mints the ingest token
 *    into the child's environment, where nothing here can see it.
 * 5. **It does no work at import time** and declares no tests. `fixtures.ts` builds its handle
 *    lazily, and `clean-clone.spec.ts` imports that file without paying for anything here.
 *
 * ## Relationship to its siblings
 *
 * `./repo` supplies the repository root. `./service` supplies the typed launcher calls and the
 * poll intervals. `./demo-app` supplies the snapshot, restoration, residual-check, source-lookup
 * and probe primitives, which are called here with this fixture's `relDir` / `relativeTo` /
 * `baseUrl` rather than written a second time. Failures raised inside those primitives surface
 * as `DemoAppError` (codes `not-restored`, `residual-instrumentation`,
 * `residual-check-unavailable`, `source`, `snapshot`); failures of this fixture's own lifecycle
 * are {@link SampleAppError}s. The dependency is one-way: `demo-app.ts` never imports this file.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { expect } from '@playwright/test';

import {
  demoUrl as configuredDemoUrl,
  fixtureAppUrl as configuredFixtureAppUrl,
  serviceUrl as configuredServiceUrl,
} from '../../../playwright.config';
import {
  PRE_LAUNCH_PROBE_TIMEOUT_MS,
  demoRoot,
  describeFetchError,
  describeProbe,
  expectNoResidualInstrumentation as expectNoResidualInstrumentationIn,
  findMarkers as findMarkersIn,
  isPortListening,
  messageOf,
  probeDemo,
  runResidualCheck as runResidualCheckIn,
  sameLoopbackPort,
  sentence,
  snapshotTrackedFiles as snapshotTrackedFilesIn,
  sourceLineContaining as sourceLineContainingIn,
  verifyRestored as verifyRestoredIn,
  withEditorAnnouncement,
  worktreeDirty as worktreeDirtyIn,
} from './demo-app';
import type {
  MarkerFinding,
  ResidualCheckOptions,
  ResidualCheckOutcome,
  RestorationReport,
  ServingProbeOptions,
  ServingProbeResult,
  SourceLineMatch,
  SourceLineOptions,
  TrackedFileSnapshot,
  VerifyRestoredOptions,
} from './demo-app';
import { repoPath, repoRoot } from './repo';
import { POLL_INTERVALS_MS, ServiceCallError } from './service';
import type { DevServerLaunchResponse, ServiceHandle } from './service';

/**
 * The shared contract types this module's functions return, re-exported so a spec that only
 * imports this file can name them. They are `demo-app.ts`'s declarations, not copies.
 */
export type {
  MarkerFinding,
  ResidualCheckOutcome,
  RestorationReport,
  ServingProbeOptions,
  ServingProbeResult,
  SourceLineMatch,
  SourceLineOptions,
  TrackedFileSnapshot,
};

// ---------------------------------------------------------------------------
// Identity, budgets and bounds — named once so no caller restates a magic number
// ---------------------------------------------------------------------------

/** The fixture's repository-relative POSIX directory — the `relDir` of every check below. */
export const SAMPLE_APP_REL_DIR = 'tests/fixtures/sample-next-app';

/** The environment variable that moves the fixture app to another port. */
export const SAMPLE_APP_PORT_ENV = 'SAMPLE_APP_PORT';

/**
 * The fixture's default port: `next dev --port 3100` in its `package.json`, the default of the
 * Playwright config's `fixtureAppUrl`, and never the demo's 3000.
 */
export const DEFAULT_SAMPLE_APP_PORT = 3100;

/** The lowest port accepted: the fixture never needs a privileged one. */
const MIN_USABLE_PORT = 1024;

/** The highest valid TCP port. */
const MAX_USABLE_PORT = 65_535;

/**
 * Budget of one `POST /dev-server/launch`. The launcher waits up to 60 s for the child to print
 * its address (its `DEFAULT_READY_TIMEOUT_MS`); the rest is slack for a busy host.
 */
export const SAMPLE_APP_LAUNCH_TIMEOUT_MS = 90_000;

/**
 * Budget of the readiness poll after a launch. The first request compiles the page and the
 * route (a few seconds with webpack on an idle host).
 */
export const SAMPLE_APP_READY_TIMEOUT_MS = 120_000;

/** The bound on one readiness GET, which may wait out that first compile. */
export const SAMPLE_APP_READY_PROBE_TIMEOUT_MS = 60_000;

/** Budget of one `POST /dev-server/stop` (the launcher sends SIGTERM, then SIGKILL after 5 s). */
export const SAMPLE_APP_STOP_TIMEOUT_MS = 30_000;

/** How long a port may take to be released after the launcher stopped its child. */
export const PORT_RELEASE_TIMEOUT_MS = 15_000;

/** The bound on the GET that describes a foreign server before this module refuses it. */
export const FOREIGN_SERVER_PROBE_TIMEOUT_MS = 3_000;

/** The largest fixture or `next` manifest this module will parse, in bytes. */
const MAX_MANIFEST_BYTES = 1_048_576;

/**
 * The fixture's identity route: `GET /api/ping` answers a JSON body carrying a string `reply`
 * (`app/api/ping/route.ts`). Readiness requires it, so the server behind the port is proven to be
 * this fixture rather than any app that answers `/`.
 */
const IDENTITY_PATH = '/api/ping';

/** The variable the telemetry preload reads its diagnostics threshold from. */
const PRELOAD_LOG_LEVEL_ENV = 'DEBUGGEN_LOG_LEVEL';

/**
 * The preload's own documented default threshold, pinned for the fixture's dev server whatever
 * the service runs at. `NODE_OPTIONS` loads the preload into every Node child `next dev` spawns,
 * including the `tsc --showConfig` whose stdout Next parses as JSON; at `info` or finer the
 * preload's console sink writes to stdout and that parse fails, so the dev server exits
 * ("Could not parse output from TypeScript's --showConfig"). At `warn` it writes to stderr only.
 */
const PRELOAD_LOG_LEVEL = 'warn';

/** A word the POSIX command-line tokenizer passes through unchanged when unquoted. */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A leading `NAME=value` word, which the launcher applies to the child's environment. */
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a fixture-lifecycle operation failed. */
export type SampleAppErrorCode =
  /** A precondition is missing: an install, a valid port, the fixture manifest. */
  | 'prerequisites'
  /** A server this module did not launch holds the fixture's port. */
  | 'port-in-use'
  /** `POST /dev-server/launch` failed. */
  | 'launch'
  /** The page the suite opens is not served by the launcher's preloaded child. */
  | 'preload-not-attached'
  /** The launcher's child is on the right port but under a different origin spelling. */
  | 'origin-mismatch'
  /** The fixture does not answer, or does not answer as this fixture. */
  | 'not-serving'
  /** `POST /dev-server/stop` could not be asked. */
  | 'stop';

/**
 * A fixture-lifecycle failure. Its message states the symptom, the cause and the fix, and never
 * carries a credential, file contents or child output (that stays in the service log).
 */
export class SampleAppError extends Error {
  /** What failed. */
  readonly code: SampleAppErrorCode;

  constructor(code: SampleAppErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SampleAppError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Identity and address
// ---------------------------------------------------------------------------

/** The fixture's absolute project root — the `projectRoot` every launcher and session call names. */
export function sampleAppRoot(): string {
  return repoPath('tests', 'fixtures', 'sample-next-app');
}

/** A trimmed environment value, with an empty or whitespace-only value treated as unset. */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Parse and range-check a port given as text, naming `source` in the refusal. */
function parsePort(text: string, source: string): number {
  if (!/^\d{1,5}$/.test(text)) {
    throw new SampleAppError(
      'prerequisites',
      `${source} must be a decimal TCP port between ${String(MIN_USABLE_PORT)} and ${String(MAX_USABLE_PORT)}; got ${JSON.stringify(text)}.`,
    );
  }
  const port = Number(text);
  if (port < MIN_USABLE_PORT) {
    throw new SampleAppError(
      'prerequisites',
      `${source} must be a TCP port between ${String(MIN_USABLE_PORT)} and ${String(MAX_USABLE_PORT)} (a dev server never needs a privileged port); got ${String(port)}.`,
    );
  }
  if (port > MAX_USABLE_PORT) {
    throw new SampleAppError(
      'prerequisites',
      `${source} must be a TCP port between ${String(MIN_USABLE_PORT)} and ${String(MAX_USABLE_PORT)}; ${String(port)} is not a TCP port.`,
    );
  }
  return port;
}

/** The explicit or scheme-default port of `url`. */
function effectivePort(url: URL): number {
  if (url.port !== '') {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

/** The effective port of a configured URL, or `undefined` when it does not parse. */
function portOfConfiguredUrl(value: string): number | undefined {
  try {
    return effectivePort(new URL(value));
  } catch {
    return undefined;
  }
}

/**
 * The port of the Playwright config's `fixtureAppUrl` (`FIXTURE_APP_URL`), which the browser
 * suite serves its copy of this fixture on. Honouring it means one per-clone override moves both
 * suites; the host part is not used (see {@link sampleAppBaseUrl}).
 */
function portOfFixtureAppUrl(): number {
  let url: URL;
  try {
    url = new URL(configuredFixtureAppUrl);
  } catch (error) {
    throw new SampleAppError(
      'prerequisites',
      `FIXTURE_APP_URL is not a valid URL; set it to an origin such as http://localhost:${String(DEFAULT_SAMPLE_APP_PORT)} (the default), unset it, or set ${SAMPLE_APP_PORT_ENV} instead.`,
      { cause: error },
    );
  }
  if (url.protocol !== 'http:') {
    throw new SampleAppError(
      'prerequisites',
      `FIXTURE_APP_URL must be a plain http origin (the fixture's dev server does not serve TLS); set it to an origin such as http://localhost:${String(DEFAULT_SAMPLE_APP_PORT)}, or set ${SAMPLE_APP_PORT_ENV} instead.`,
    );
  }
  return parsePort(String(effectivePort(url)), 'The port of FIXTURE_APP_URL');
}

/**
 * The port the fixture app is served on: `SAMPLE_APP_PORT` when set, else the port of the
 * Playwright config's `fixtureAppUrl` (`FIXTURE_APP_URL`, default `http://localhost:3100`) — so
 * by default {@link DEFAULT_SAMPLE_APP_PORT}.
 *
 * It must be a non-privileged TCP port, and it may be neither the demo's port (`DEMO_URL`) nor
 * the service's (`DEBUGGEN_PORT`): the service binds a tab to the session whose dev-server
 * origin matches, so a shared port would merge two apps' sessions, and a port the service holds
 * cannot be served at all.
 *
 * @throws {SampleAppError} `prerequisites`, naming the variable to fix.
 */
export function sampleAppPort(): number {
  const override = readEnv(SAMPLE_APP_PORT_ENV);
  const port =
    override === undefined ? portOfFixtureAppUrl() : parsePort(override, SAMPLE_APP_PORT_ENV);
  const source =
    override === undefined
      ? `The fixture app's port ${String(port)} (from FIXTURE_APP_URL, default ${String(DEFAULT_SAMPLE_APP_PORT)})`
      : `${SAMPLE_APP_PORT_ENV}=${String(port)}`;
  if (portOfConfiguredUrl(configuredDemoUrl) === port) {
    throw new SampleAppError(
      'prerequisites',
      `${source} is the demo's port (DEMO_URL=${configuredDemoUrl}). Both apps can run at once and the service keeps their sessions apart by dev-server origin, so they need different ports: set ${SAMPLE_APP_PORT_ENV} to a free port such as 3123.`,
    );
  }
  if (portOfConfiguredUrl(configuredServiceUrl) === port) {
    throw new SampleAppError(
      'prerequisites',
      `${source} is the local service's port (${configuredServiceUrl}); set ${SAMPLE_APP_PORT_ENV} to a free port such as 3123.`,
    );
  }
  return port;
}

/**
 * The origin the suite opens the fixture at: `http://localhost:<port>`, no trailing slash.
 *
 * The host is always `localhost`, never `127.0.0.1`. The Chrome extension's content scripts —
 * the telemetry agent among them — run on its `http://localhost/*` and `http://127.0.0.1/*` host
 * permissions, and the launcher reports the address `next dev` prints, `http://localhost:<port>`.
 * The service binds a tab to the session whose dev-server origin matches, so any other spelling
 * would leave the tab unbound and the browser tier silently empty.
 *
 * @throws {SampleAppError} `prerequisites` when the port is unusable (see {@link sampleAppPort}).
 */
export function sampleAppBaseUrl(): string {
  return `http://localhost:${String(sampleAppPort())}`;
}

// ---------------------------------------------------------------------------
// The borrowed `next` binary and the launch command
// ---------------------------------------------------------------------------

/** What {@link resolveBorrowedNext} found in the demo's install. */
export interface BorrowedNext {
  /** Absolute path of the `next` package's `bin` script (`…/node_modules/next/dist/bin/next`). */
  readonly script: string;
  /** Absolute path of `apps/demo-app/node_modules`, the fixture's `NODE_PATH`. */
  readonly nodeModules: string;
  /** The installed `next` version, equal to the fixture's pin. */
  readonly version: string;
}

/** The actionable tail of every "the borrowed binary is unusable" refusal. */
const INSTALL_ADVICE =
  "Run `pnpm install` (and `pnpm build`) — the fixture app borrows the demo's `next` binary because it is not a workspace member, and it must never get a `node_modules` of its own.";

/** A repository-relative POSIX rendering of an absolute path, for messages. */
function repoRelative(absolute: string): string {
  return path.relative(repoRoot(), absolute).split(path.sep).join('/');
}

/** Read a small JSON manifest, or refuse naming the file and `advice`. */
async function readManifest(file: string, advice: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      throw new Error(
        info.isFile()
          ? `it is larger than ${String(MAX_MANIFEST_BYTES)} bytes`
          : 'it is not a regular file',
      );
    }
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new SampleAppError(
      'prerequisites',
      `${repoRelative(file)} cannot be read (${sentence(messageOf(error))}). ${advice}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SampleAppError(
      'prerequisites',
      `${repoRelative(file)} is not valid JSON (${sentence(messageOf(error))}). ${advice}`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SampleAppError(
      'prerequisites',
      `${repoRelative(file)} is not a JSON object. ${advice}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Whether `file` exists as a regular file. */
async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The `next` version the fixture's own `package.json` pins (read as text, never imported). */
async function fixtureNextPin(): Promise<string> {
  const manifestPath = path.join(sampleAppRoot(), 'package.json');
  const manifest = await readManifest(
    manifestPath,
    'The fixture manifest is tracked; restore it with `git checkout -- tests/fixtures/sample-next-app/package.json`.',
  );
  const dependencies = manifest.dependencies;
  const pin =
    typeof dependencies === 'object' && dependencies !== null && 'next' in dependencies
      ? (dependencies as Record<string, unknown>).next
      : undefined;
  if (typeof pin !== 'string' || pin.trim() === '') {
    throw new SampleAppError(
      'prerequisites',
      `${repoRelative(manifestPath)} declares no \`next\` dependency, so the borrowed binary cannot be checked against it.`,
    );
  }
  return pin.trim();
}

/**
 * Locate and check the `next` installed for `apps/demo-app`:
 *
 * 1. its manifest `apps/demo-app/node_modules/next/package.json` is readable, and its `bin`
 *    entry names a regular file;
 * 2. its version equals the fixture's own pin — the fixture must run on the Next.js it declares;
 * 3. `@types/react` resolves from the same `node_modules` — otherwise Next's TypeScript check
 *    would run `pnpm install` for the fixture directory, rewriting the tracked lockfile.
 *
 * @throws {SampleAppError} `prerequisites`, ending in the `pnpm install` advice.
 */
export async function resolveBorrowedNext(): Promise<BorrowedNext> {
  const nodeModules = path.join(demoRoot(), 'node_modules');
  const manifestPath = path.join(nodeModules, 'next', 'package.json');
  const manifest = await readManifest(manifestPath, INSTALL_ADVICE);

  const version = manifest.version;
  if (typeof version !== 'string' || version === '') {
    throw new SampleAppError(
      'prerequisites',
      `${repoRelative(manifestPath)} carries no version. ${INSTALL_ADVICE}`,
    );
  }
  const bin = manifest.bin;
  const binEntry =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null && 'next' in bin
        ? (bin as Record<string, unknown>).next
        : undefined;
  if (typeof binEntry !== 'string' || binEntry === '') {
    throw new SampleAppError(
      'prerequisites',
      `${repoRelative(manifestPath)} declares no \`next\` bin entry. ${INSTALL_ADVICE}`,
    );
  }
  const script = path.resolve(path.dirname(manifestPath), binEntry);
  if (!(await isRegularFile(script))) {
    throw new SampleAppError(
      'prerequisites',
      `The \`next\` binary ${repoRelative(script)} is missing. ${INSTALL_ADVICE}`,
    );
  }

  const pin = await fixtureNextPin();
  if (pin !== version) {
    throw new SampleAppError(
      'prerequisites',
      `The fixture pins next ${pin}, but apps/demo-app has next ${version} installed. The fixture runs on the demo's binary, so the two pins must agree: align them and run \`pnpm install\`.`,
    );
  }

  const typesReact = path.join(nodeModules, '@types', 'react', 'package.json');
  if (!(await isRegularFile(typesReact))) {
    throw new SampleAppError(
      'prerequisites',
      `${repoRelative(typesReact)} is missing, so Next.js would try to install @types/react into the fixture directory on its first start (rewriting the tracked pnpm-lock.yaml). ${INSTALL_ADVICE}`,
    );
  }

  return { script, nodeModules, version };
}

/**
 * The absolute path of the `next` binary installed for `apps/demo-app` — the package's `bin`
 * script, checked by {@link resolveBorrowedNext}.
 *
 * @throws {SampleAppError} `prerequisites`: "run `pnpm install` (and `pnpm build`) — the fixture
 *   app borrows the demo's `next` binary because it is not a workspace member".
 */
export async function resolveNextBinary(): Promise<string> {
  return (await resolveBorrowedNext()).script;
}

/**
 * Quote one word for the launcher's POSIX command-line tokenizer: a word made of safe characters
 * passes unchanged; anything else is single-quoted, with each `'` rendered as `'\''`. Nothing is
 * expanded by the launcher, so this is the complete quoting rule.
 */
function quoteWord(word: string): string {
  if (SAFE_WORD.test(word)) {
    return word;
  }
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Render an argv array as the single command string `devServerLaunchRequest.command` declares.
 * A leading `NAME=value` element stays an environment assignment (its value quoted after the
 * `=`), exactly as the launcher reads it; every other element is quoted as a whole.
 */
export function renderLaunchCommand(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new SampleAppError('launch', 'A launch command needs at least an executable.');
  }
  let assignments = true;
  return argv
    .map((word) => {
      const assignment = assignments ? ENV_ASSIGNMENT.exec(word) : null;
      if (assignment === null) {
        assignments = false;
        return quoteWord(word);
      }
      return `${assignment[1] ?? ''}=${quoteWord(assignment[2] ?? '')}`;
    })
    .join(' ');
}

/**
 * The argv of the fixture's dev server, in launcher order: environment assignments, the Node
 * executable, the borrowed `next` script, then `dev --webpack --port <port>`. The module header
 * explains every part.
 */
export async function sampleAppLaunchArgv(port: number = sampleAppPort()): Promise<string[]> {
  const borrowed = await resolveBorrowedNext();
  return [
    'NEXT_TELEMETRY_DISABLED=1',
    `${PRELOAD_LOG_LEVEL_ENV}=${PRELOAD_LOG_LEVEL}`,
    `NODE_PATH=${borrowed.nodeModules}`,
    process.execPath,
    borrowed.script,
    'dev',
    '--webpack',
    '--port',
    String(port),
  ];
}

/**
 * The explicit `command` for `POST /dev-server/launch`: {@link sampleAppLaunchArgv} rendered as
 * one string, because `devServerLaunchRequest.command` is a single string the launcher tokenizes
 * itself (quotes honoured, nothing expanded, no shell). It holds absolute paths and flags only —
 * the preload and its credential reach the child through the launcher's environment, never
 * through the command.
 */
export async function sampleAppLaunchCommand(port: number = sampleAppPort()): Promise<string> {
  return renderLaunchCommand(await sampleAppLaunchArgv(port));
}

// ---------------------------------------------------------------------------
// Serving probes
// ---------------------------------------------------------------------------

/** One bounded GET against the fixture (or `options.baseUrl`); never throws for a network failure. */
function probeSampleApp(options: ServingProbeOptions): Promise<ServingProbeResult> {
  return probeDemo({ ...options, baseUrl: options.baseUrl ?? sampleAppBaseUrl() });
}

/**
 * Whether the fixture answers a GET (default path `/`) with a status below 500 — the probe that
 * the application keeps serving after its session ends, as `demo-app.ts` defines it for the demo.
 */
export async function isServing(options: ServingProbeOptions = {}): Promise<boolean> {
  return (await probeSampleApp(options)).serving;
}

/**
 * Assert the fixture answers a GET (default path `/`) with a status below 500.
 *
 * @throws {SampleAppError} `not-serving`, naming the URL and the status or error.
 */
export async function expectServing(
  options: ServingProbeOptions = {},
): Promise<ServingProbeResult> {
  const result = await probeSampleApp(options);
  if (!result.serving) {
    throw new SampleAppError(
      'not-serving',
      `The fixture app is not serving ${describeProbe(result)}. It is started only through POST /dev-server/launch (startSampleApp); if the dev server exited, the service log (the webServer output) shows why.`,
    );
  }
  return result;
}

/** The outcome of one identity probe of `GET /api/ping`. */
interface IdentityProbeResult {
  /** The answer was HTTP 200 with a JSON body carrying a string `reply`. */
  readonly identified: boolean;
  /** What was observed, in words (no body content). */
  readonly description: string;
}

/**
 * One bounded `GET /api/ping` against `baseUrl`: identified when it answers HTTP 200 with a JSON
 * body whose `reply` is a string — the fixture's published contract. Never throws.
 */
async function probeIdentity(baseUrl: string, timeoutMs: number): Promise<IdentityProbeResult> {
  const url = new URL(IDENTITY_PATH, baseUrl);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { identified: false, description: `${url.href}: HTTP ${String(response.status)}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { identified: false, description: `${url.href}: HTTP 200 without a JSON body` };
    }
    const reply =
      typeof body === 'object' && body !== null && 'reply' in body
        ? (body as Record<string, unknown>).reply
        : undefined;
    return typeof reply === 'string'
      ? { identified: true, description: `${url.href}: HTTP 200 with a string reply` }
      : { identified: false, description: `${url.href}: HTTP 200 without a string \`reply\`` };
  } catch (error) {
    return {
      identified: false,
      description: `${url.href}: ${describeFetchError(error, timeoutMs)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Launch records
// ---------------------------------------------------------------------------

/**
 * Why the page the suite opens is, or is not, served with the telemetry preload.
 *
 * - `'launcher-child'` — the launcher's own child answers on the fixture's port. The launcher
 *   always spawns with the preload, so its server agent reports for this project.
 * - `'no-server-agent-connection'` — the product's reason for "no server agent for this project":
 *   the page the suite opens is served by something other than that child.
 */
export type SampleAppPreloadReason = 'launcher-child' | 'no-server-agent-connection';

/** One launch of the fixture, as the launcher reported it and as this module judged it. */
export interface SampleAppLaunch {
  /** The absolute project root the launcher keys its child by ({@link sampleAppRoot}). */
  readonly projectRoot: string;
  /** The URL the launcher reported (the first loopback address the child printed). */
  readonly devServerUrl: string;
  /** The origin of {@link devServerUrl}. */
  readonly origin: string;
  /** The child's pid, as the launcher reported it. Never signalled by this module. */
  readonly pid: number;
  /** The origin the suite opens ({@link sampleAppBaseUrl}) at the time of the launch. */
  readonly baseUrl: string;
  /** The port the suite opens ({@link sampleAppPort}). */
  readonly port: number;
  /** The `command` sent to the launcher: absolute paths and flags only, no credential. */
  readonly command: string;
  /** The caller supplied {@link command} rather than this module building it. */
  readonly explicitCommand: boolean;
  /**
   * The server answering {@link baseUrl} is the launcher's child, which the launcher always
   * starts with the telemetry preload. `false` means no `http.server`, `route.handler` or
   * `function` span will be captured for a session over the page the suite opens.
   */
  readonly preloadAttached: boolean;
  /** Why {@link preloadAttached} holds or not. */
  readonly preloadReason: SampleAppPreloadReason;
  /**
   * {@link origin} equals {@link baseUrl}. The service binds a tab to the session whose
   * dev-server origin matches, so a mismatch leaves the tab unbound even with the preload.
   */
  readonly originMatches: boolean;
  /** The launcher answered with a child that was already running before this call. */
  readonly reused: boolean;
  /** Something accepted connections on {@link port} right before the launch request. */
  readonly listeningBeforeLaunch: boolean;
  /**
   * What {@link ensurePortFree} found before the launch, or `undefined` when this module reused a
   * launch it had recorded (the ladder's first rung would have stopped that very child).
   */
  readonly portCheck: PortFreeResult | undefined;
  /** Why the launch is unusable for a session, when it is. */
  readonly diagnosis: string | undefined;
  /** When the launch answered (epoch milliseconds). */
  readonly launchedAt: number;
  /** The launcher's response, verbatim. */
  readonly raw: DevServerLaunchResponse;
}

/**
 * The latest launch of the fixture in this process, keyed by project root. The launcher keeps
 * one child per root; this record is what makes a second start recognisable as a reuse, what the
 * ladder's first rung stops, and what {@link stopSampleApp} reports. Module state, but no work:
 * nothing is read or started at import time.
 */
const launches = new Map<string, SampleAppLaunch>();

/** The launch this process last recorded for the fixture, if it is still believed to run. */
export function currentSampleAppLaunch(): SampleAppLaunch | undefined {
  return launches.get(sampleAppRoot());
}

// ---------------------------------------------------------------------------
// The port ladder
// ---------------------------------------------------------------------------

/** What {@link ensurePortFree} found. */
export type SampleAppPortState =
  /** Nothing accepted connections on the port. */
  | 'free'
  /** The launcher's own child for the fixture held the port and was stopped through it. */
  | 'stopped-ours';

/** The result of {@link ensurePortFree}. */
export interface PortFreeResult {
  /** How the port became (or already was) free. */
  readonly state: SampleAppPortState;
  /** The port checked ({@link sampleAppPort}). */
  readonly port: number;
  /** The origin checked ({@link sampleAppBaseUrl}). */
  readonly baseUrl: string;
}

/**
 * Whether anything accepts a TCP connection on `port` over loopback. `localhost` is dialled with
 * Node's address-family fallback (it tries `::1` and `127.0.0.1`), and `127.0.0.1` is dialled
 * explicitly as well: a server bound to one family only still makes `next dev`'s dual-stack bind
 * fail, so either answer means "taken". A connect answers at once, where a GET could wait out a
 * cold compile.
 */
async function portAnswers(port: number): Promise<boolean> {
  const answers = await Promise.all([
    isPortListening(`http://localhost:${String(port)}`, PRE_LAUNCH_PROBE_TIMEOUT_MS),
    isPortListening(`http://127.0.0.1:${String(port)}`, PRE_LAUNCH_PROBE_TIMEOUT_MS),
  ]);
  return answers.some(Boolean);
}

/** Poll until nothing answers on `port`; `false` when it still answers after `timeoutMs`. */
async function waitForPortRelease(port: number, timeoutMs: number): Promise<boolean> {
  try {
    await expect
      .poll(() => portAnswers(port), {
        message: `port ${String(port)} was not released`,
        timeout: timeoutMs,
        intervals: [...POLL_INTERVALS_MS],
      })
      .toBe(false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the launcher to stop **its own** child for the fixture root (`POST /dev-server/stop`), with
 * a transient editor announcement for scope. The launcher only ever stops a process it spawned;
 * `false` means it has none for this project, which is a successful answer.
 *
 * @throws {SampleAppError} `stop` when the service cannot be asked.
 */
async function requestLauncherStop(service: ServiceHandle, projectRoot: string): Promise<boolean> {
  try {
    const response = await withEditorAnnouncement(service, () =>
      service.stopDevServer({ projectRoot }, { timeoutMs: SAMPLE_APP_STOP_TIMEOUT_MS }),
    );
    return response.stopped;
  } catch (error) {
    throw new SampleAppError(
      'stop',
      `Stopping the fixture app through POST /dev-server/stop failed: ${sentence(messageOf(error))}. The child stays the launcher's to stop (it also stops every child when the service shuts down); this helper never signals it directly.`,
      { cause: error },
    );
  }
}

/**
 * The actionable refusal of a foreign server on the fixture's port: the port and its override,
 * the likely cause, the consequence, and the fix.
 */
function foreignServerMessage(
  port: number,
  baseUrl: string,
  sighting: string,
  launcherStoppedItsChild: boolean,
): string {
  return [
    `The fixture app's port ${String(port)} is taken — ${sighting} — by a server that neither this helper nor this service's launcher started for ${SAMPLE_APP_REL_DIR}.`,
    ...(launcherStoppedItsChild
      ? [
          `The launcher did stop its own child for this project, yet the port still answers after ${String(PORT_RELEASE_TIMEOUT_MS)} ms.`,
        ]
      : []),
    `Cause: most often a fixture server left running by \`pnpm test:browser\` — that suite serves a temporary copy of this fixture on the same default port, ${String(DEFAULT_SAMPLE_APP_PORT)} — or a \`next dev\` started by hand.`,
    `Consequence: nothing behind ${baseUrl} holds a server-agent connection for this project (\`no-server-agent-connection\`), so a session over the page it serves would silently collect zero server spans (no \`http.server\`, \`route.handler\` or \`function\` spans), and the launcher cannot start its own preloaded child there: \`next dev --port ${String(port)}\` exits with EADDRINUSE instead of moving to another port.`,
    `Fix: stop that server and re-run, or move this suite to a free port with ${SAMPLE_APP_PORT_ENV}=<port> (for example ${SAMPLE_APP_PORT_ENV}=3123). This helper never stops a process it did not start.`,
  ].join('\n');
}

/**
 * Make sure the fixture's port is free before a launch, by exactly these rungs:
 *
 * 1. If this module launched the fixture in this process, stop that launch through
 *    `POST /dev-server/stop` and wait for the port to be released.
 * 2. Probe the port with a TCP connect. If nothing answers, it is free.
 * 3. Something answers that this module did not record: ask the launcher to stop **its own**
 *    child for the fixture root. It answers `stopped: true` only when it spawned one — typically a
 *    child left by an interrupted run of a service that Playwright's `reuseExistingServer` kept
 *    alive — and a foreign process is never touched, because the launcher can only stop what it
 *    spawned. After a stop, wait for the release.
 * 4. Anything still answering is a server nobody here launched. Describe it with one bounded GET
 *    and refuse with the actionable foreign-server diagnosis — never kill it.
 *
 * No signal is sent and the process table is never read: process lifetime belongs to the
 * product's launcher.
 *
 * @throws {SampleAppError} `port-in-use` for a foreign server, `stop` when the service cannot be
 *   asked, `prerequisites` for an unusable port.
 */
export async function ensurePortFree(service: ServiceHandle): Promise<PortFreeResult> {
  const projectRoot = sampleAppRoot();
  const port = sampleAppPort();
  const baseUrl = sampleAppBaseUrl();
  let state: SampleAppPortState = 'free';

  if (launches.has(projectRoot)) {
    await stopSampleApp(service);
    state = 'stopped-ours';
    await waitForPortRelease(port, PORT_RELEASE_TIMEOUT_MS);
  }

  if (!(await portAnswers(port))) {
    return { state, port, baseUrl };
  }

  const launcherStoppedItsChild = await requestLauncherStop(service, projectRoot);
  if (launcherStoppedItsChild && (await waitForPortRelease(port, PORT_RELEASE_TIMEOUT_MS))) {
    return { state: 'stopped-ours', port, baseUrl };
  }

  const probe = await probeDemo({ baseUrl, timeoutMs: FOREIGN_SERVER_PROBE_TIMEOUT_MS });
  throw new SampleAppError(
    'port-in-use',
    foreignServerMessage(port, baseUrl, describeProbe(probe), launcherStoppedItsChild),
  );
}

// ---------------------------------------------------------------------------
// Starting and stopping through the product's launcher
// ---------------------------------------------------------------------------

/** Options of {@link startSampleApp}. */
export interface StartSampleAppOptions {
  /**
   * An explicit launch command, as the single string the launcher tokenizes or as an argv array
   * ({@link renderLaunchCommand} quotes it). Leave it unset: {@link sampleAppLaunchCommand} is
   * the one command known to serve this fixture in place without writing into the repository.
   */
  readonly command?: string | readonly string[] | undefined;
  /** Budget of the launch request; defaults to {@link SAMPLE_APP_LAUNCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Budget of the readiness poll; defaults to {@link SAMPLE_APP_READY_TIMEOUT_MS}. */
  readonly readyTimeoutMs?: number | undefined;
  /**
   * Assert {@link expectPreloadAttached} before waiting for readiness (default `true`). Pass
   * `false` only to inspect an unusable launch.
   */
  readonly assertPreload?: boolean | undefined;
}

/** What {@link stopSampleApp} did. */
export interface SampleAppStopResult {
  /** The launcher stopped a child it owned; `false` means nothing was running (a success). */
  readonly stopped: boolean;
  /** The project root the stop named. */
  readonly projectRoot: string;
  /** The pid of the launch this module last recorded, if any. */
  readonly pid: number | undefined;
  /**
   * Nothing answers on the fixture's port any more (after a bounded wait when a child was
   * stopped). `false` after `stopped: false` means a server nobody here launched holds it.
   */
  readonly portReleased: boolean;
}

/** The consequence every "preload not attached" diagnosis states. */
const NO_SERVER_SPANS =
  'no `http.server`, `route.handler` or `function` spans will be captured for a session over the page the suite opens';

/** Why `launch` is unusable for a session, or `undefined` when it is usable. */
function diagnoseLaunch(launch: Omit<SampleAppLaunch, 'diagnosis'>): string | undefined {
  if (launch.preloadAttached && launch.originMatches) {
    return undefined;
  }
  if (!launch.preloadAttached) {
    const cause = launch.explicitCommand
      ? `The explicit launch command must serve port ${String(launch.port)}: pass \`--port ${String(launch.port)}\`, or leave \`command\` unset so this helper builds it.`
      : `This helper's command passes \`--port ${String(launch.port)}\`, so another address means the launcher answered with a child it had started for this project from a different command; stop it with stopSampleApp() and start again.`;
    return `The launcher's preloaded dev server for ${SAMPLE_APP_REL_DIR} is on ${launch.origin}, but the suite opens ${launch.baseUrl}, which that child does not serve — so behind the page the browser visits there is no server-agent connection for this project (\`${launch.preloadReason}\`), and ${NO_SERVER_SPANS}. ${cause}`;
  }
  return `The launcher reports the fixture app at ${launch.origin}, but the suite opens ${launch.baseUrl}. The service binds a tab to the session whose dev-server origin matches, so the tab would stay unbound: the fixture must be served as ${launch.baseUrl} — leave \`--hostname\` out of an explicit command, so \`next dev\` prints its localhost address.`;
}

/**
 * Assert that a launch is usable for a session: the server behind the URL the suite opens is the
 * launcher's preloaded child, under the origin the extension will bind. Returns the launch for
 * chaining.
 *
 * The launcher's `200` carries only `{ devServerUrl, pid }` — never its detection's
 * `preloadReason` or relaunch hint — so the judgement rests on this module's own evidence: which
 * port the launcher's child is on. A launcher refusal (`SERVER_AGENT_NOT_READY`: a dev server for
 * this project already runs without the preload) never produces a launch record; it fails
 * {@link startSampleApp} with the launcher's relaunch hint quoted verbatim.
 *
 * @throws {SampleAppError} `preload-not-attached`, naming `no-server-agent-connection` and the
 *   consequence, or `origin-mismatch`.
 */
export function expectPreloadAttached(launch: SampleAppLaunch): SampleAppLaunch {
  if (launch.preloadAttached && launch.originMatches) {
    return launch;
  }
  throw new SampleAppError(
    launch.preloadAttached ? 'origin-mismatch' : 'preload-not-attached',
    launch.diagnosis ??
      diagnoseLaunch(launch) ??
      `The fixture app launch on ${launch.origin} is not usable for ${launch.baseUrl}.`,
  );
}

/** A launch failure in words, with the exact diagnosis where one applies. */
function launchFailure(
  error: unknown,
  port: number,
  baseUrl: string,
  listeningBefore: boolean,
): SampleAppError {
  const account = sentence(messageOf(error));
  if (error instanceof ServiceCallError && error.code === 'SERVER_AGENT_NOT_READY') {
    return new SampleAppError(
      'preload-not-attached',
      `The launcher refused to start the fixture app: a dev server for ${SAMPLE_APP_REL_DIR} is already running without the telemetry preload (\`no-server-agent-connection\`), so ${NO_SERVER_SPANS}. The launcher's account, with its relaunch hint: ${account}. This helper never stops a process it did not start.`,
      { cause: error },
    );
  }
  const exitedBeforeReady =
    error instanceof ServiceCallError &&
    (error.status === 502 || error.code === 'DEV_SERVER_LAUNCH_FAILED');
  if (exitedBeforeReady && listeningBefore) {
    return new SampleAppError(
      'port-in-use',
      `Launching the fixture app through POST /dev-server/launch failed: ${account}. The port was taken between the port check and the launch.\n${foreignServerMessage(
        port,
        baseUrl,
        `something accepted connections on ${baseUrl} right before the launch request`,
        false,
      )}`,
      { cause: error },
    );
  }
  return new SampleAppError(
    'launch',
    `Launching the fixture app through POST /dev-server/launch failed: ${account}. A dev server that exits before it is ready most often met a taken port (EADDRINUSE) or an incomplete install (\`pnpm install\`, \`pnpm build\`). Its own output stays in the service log — the webServer output — and is never copied here.`,
    { cause: error },
  );
}

/**
 * Poll the launched fixture with bounded GETs until `/` answers below 500 **and** `/api/ping`
 * answers as this fixture, or fail naming both last outcomes. The identity check is what proves
 * the server behind the port is `tests/fixtures/sample-next-app`, and it compiles the route
 * before a capture needs it.
 */
async function waitForSampleReady(url: string, timeoutMs: number): Promise<ServingProbeResult> {
  // Written from the poll's callback, so held in an object flow analysis does not narrow away.
  const state: { page: ServingProbeResult | undefined; identity: IdentityProbeResult | undefined } =
    { page: undefined, identity: undefined };
  try {
    await expect
      .poll(
        async () => {
          state.identity = undefined;
          state.page = await probeDemo({
            baseUrl: url,
            timeoutMs: SAMPLE_APP_READY_PROBE_TIMEOUT_MS,
          });
          if (!state.page.serving) {
            return false;
          }
          state.identity = await probeIdentity(url, SAMPLE_APP_READY_PROBE_TIMEOUT_MS);
          return state.identity.identified;
        },
        {
          message: `the fixture app launched on ${url} did not answer as ${SAMPLE_APP_REL_DIR}`,
          timeout: timeoutMs,
          intervals: [...POLL_INTERVALS_MS],
        },
      )
      .toBe(true);
  } catch (error) {
    throw new SampleAppError(
      'not-serving',
      `The fixture app launched through POST /dev-server/launch did not become ready within ${String(timeoutMs)} ms; last page probe: ${describeProbe(state.page)}; last identity probe: ${state.identity?.description ?? 'not reached'}. No response means the first compile is still running or the dev server exited; a 5xx on every request is a compile or module-resolution error; an answer that is not this fixture's means another application holds the port. The service log shows the child's output.`,
      { cause: error },
    );
  }
  if (state.page === undefined) {
    throw new SampleAppError('not-serving', `The readiness poll of ${url} never ran.`);
  }
  return state.page;
}

/** Stop an unusable launcher child again; the note is appended to the failure. */
async function stopUnusableLaunch(
  service: ServiceHandle,
  launch: SampleAppLaunch,
): Promise<string> {
  try {
    const result = await stopSampleApp(service);
    return result.stopped
      ? ` The launcher's own unusable child on ${launch.origin} was stopped again through POST /dev-server/stop.`
      : '';
  } catch (error) {
    return ` Stopping the launcher's unusable child on ${launch.origin} also failed: ${messageOf(error)}`;
  }
}

/** The command a start sends: the caller's (rendered when it is an argv array) or this module's. */
async function commandFor(options: StartSampleAppOptions, port: number): Promise<string> {
  const requested = options.command;
  if (requested === undefined) {
    return sampleAppLaunchCommand(port);
  }
  return typeof requested === 'string' ? requested : renderLaunchCommand(requested);
}

/**
 * Start the fixture app through the product's launcher and wait until it serves as this fixture.
 *
 * 1. Run {@link ensurePortFree} — unless this module already recorded a launch in this process,
 *    in which case the start is a reuse: the launcher answers a second launch for the same root
 *    with its registered child, and the ladder's first rung would stop that very child.
 * 2. `POST /dev-server/launch { projectRoot: sampleAppRoot(), command }` (with a transient editor
 *    announcement for scope), where `command` is {@link sampleAppLaunchCommand} unless the caller
 *    passes one. The explicit command is required here: the fixture has no `node_modules`, so the
 *    launcher's own dev-script detection would run a package manager that cannot start it.
 * 3. Judge the answer: `preloadAttached` holds when the launcher's child is on the fixture's port,
 *    i.e. it serves the page the suite opens. {@link expectPreloadAttached} runs here unless
 *    `assertPreload: false`; when it fails, the launcher's unusable child is stopped again.
 * 4. Poll with bounded GETs until `/` answers below 500 and `/api/ping` answers as this fixture.
 *
 * The launch is recorded before readiness is awaited, so {@link stopSampleApp} — a teardown —
 * stops the child even when readiness fails.
 *
 * @throws {SampleAppError} `prerequisites`, `port-in-use`, `launch`, `preload-not-attached`,
 *   `origin-mismatch`, `not-serving` or `stop`.
 */
export async function startSampleApp(
  service: ServiceHandle,
  options: StartSampleAppOptions = {},
): Promise<SampleAppLaunch> {
  const projectRoot = sampleAppRoot();
  const port = sampleAppPort();
  const baseUrl = sampleAppBaseUrl();
  const previous = launches.get(projectRoot);
  const portCheck = previous === undefined ? await ensurePortFree(service) : undefined;
  const command = await commandFor(options, port);
  const listeningBeforeLaunch = await portAnswers(port);

  let raw: DevServerLaunchResponse;
  try {
    raw = await withEditorAnnouncement(service, () =>
      service.launchDevServer(
        { projectRoot, command },
        { timeoutMs: options.timeoutMs ?? SAMPLE_APP_LAUNCH_TIMEOUT_MS },
      ),
    );
  } catch (error) {
    throw launchFailure(error, port, baseUrl, listeningBeforeLaunch);
  }

  const origin = new URL(raw.devServerUrl).origin;
  const preloadAttached = sameLoopbackPort(origin, baseUrl);
  const judged: Omit<SampleAppLaunch, 'diagnosis'> = {
    projectRoot,
    devServerUrl: raw.devServerUrl,
    origin,
    pid: raw.pid,
    baseUrl,
    port,
    command,
    explicitCommand: options.command !== undefined,
    preloadAttached,
    preloadReason: preloadAttached ? 'launcher-child' : 'no-server-agent-connection',
    originMatches: origin === baseUrl,
    reused:
      (previous !== undefined && previous.pid === raw.pid && previous.origin === origin) ||
      (listeningBeforeLaunch && preloadAttached),
    listeningBeforeLaunch,
    portCheck,
    launchedAt: Date.now(),
    raw,
  };
  const launch: SampleAppLaunch = { ...judged, diagnosis: diagnoseLaunch(judged) };
  launches.set(projectRoot, launch);

  if (options.assertPreload !== false) {
    try {
      expectPreloadAttached(launch);
    } catch (error) {
      const stopNote = await stopUnusableLaunch(service, launch);
      throw new SampleAppError(
        error instanceof SampleAppError ? error.code : 'launch',
        `${messageOf(error)}${stopNote}`,
        { cause: error },
      );
    }
  }

  await waitForSampleReady(
    launch.devServerUrl,
    options.readyTimeoutMs ?? SAMPLE_APP_READY_TIMEOUT_MS,
  );
  return launch;
}

/** The fixture's port for a teardown: the recorded one, else the configured one when it is valid. */
function teardownPort(recorded: SampleAppLaunch | undefined): number | undefined {
  if (recorded !== undefined) {
    return recorded.port;
  }
  try {
    return sampleAppPort();
  } catch {
    return undefined;
  }
}

/**
 * Stop the fixture app through `POST /dev-server/stop { projectRoot }` and wait (bounded) for its
 * port to be released, so the next run's ladder finds it free. Idempotent — `stopped: false` when
 * nothing runs — and safe in teardown after a failed launch or with an unusable port setting.
 * Only the launcher's own child is ever stopped; a server nobody here launched is never touched.
 *
 * @throws {SampleAppError} `stop` when the service cannot be asked (the child then stays the
 *   launcher's to stop, for example at service shutdown).
 */
export async function stopSampleApp(service: ServiceHandle): Promise<SampleAppStopResult> {
  const projectRoot = sampleAppRoot();
  const recorded = launches.get(projectRoot);
  const stopped = await requestLauncherStop(service, projectRoot);
  launches.delete(projectRoot);
  const port = teardownPort(recorded);
  let portReleased: boolean;
  if (port === undefined) {
    portReleased = true;
  } else if (stopped) {
    portReleased = await waitForPortRelease(port, PORT_RELEASE_TIMEOUT_MS);
  } else {
    portReleased = !(await portAnswers(port));
  }
  return { stopped, projectRoot, pid: recorded?.pid, portReleased };
}

// ---------------------------------------------------------------------------
// The snapshot / restoration contract and the residual gate (delegated)
// ---------------------------------------------------------------------------

/**
 * The SHA-256 of every file git tracks under {@link SAMPLE_APP_REL_DIR}, keyed by
 * repository-relative POSIX path — `demo-app.ts`'s snapshot with this fixture's `relDir`. Take it
 * before a session; {@link verifyRestored} compares against it afterwards. Paths only are ever
 * reported.
 *
 * @throws `DemoAppError` `snapshot` when git tracks nothing under the fixture.
 */
export function snapshotTrackedFiles(): Promise<TrackedFileSnapshot> {
  return snapshotTrackedFilesIn(SAMPLE_APP_REL_DIR);
}

/**
 * Recompute the fixture's snapshot and require it to equal `snapshot` exactly: the same tracked
 * file set, every digest unchanged, the same count. The failure names paths only — never
 * contents, never a diff.
 *
 * @throws `DemoAppError` `not-restored`.
 */
export function verifyRestored(
  snapshot: TrackedFileSnapshot,
  options: Omit<VerifyRestoredOptions, 'relDir'> = {},
): Promise<RestorationReport> {
  return verifyRestoredIn(snapshot, { ...options, relDir: SAMPLE_APP_REL_DIR });
}

/** The guard script's `residual-marker` findings for the fixture, run in process. */
export function findMarkers(): Promise<readonly MarkerFinding[]> {
  return findMarkersIn(SAMPLE_APP_REL_DIR);
}

/** Whether the fixture has any uncommitted change, as the guard script's `residual-worktree` rule sees it. */
export function worktreeDirty(): Promise<boolean> {
  return worktreeDirtyIn(SAMPLE_APP_REL_DIR);
}

/**
 * Run `scripts/check-no-residual-instrumentation.mjs` in its
 * `--path tests/fixtures/sample-next-app` mode (through `demo-app.ts`'s wrapper, which passes
 * `--json --path <relDir>` for any directory but the demo's). The outcome's `lines` carry the
 * script's own findings — `path:line: residual-marker: …` and `residual-worktree: …`. Never
 * throws for a finding.
 */
export function runResidualCheck(): Promise<ResidualCheckOutcome> {
  return runResidualCheckIn({ relDir: SAMPLE_APP_REL_DIR });
}

/**
 * Assert both guard rules — `residual-marker` and `residual-worktree` — for the fixture. The
 * failure carries the script's own `path:line:` findings, which name locations and never file
 * contents.
 *
 * @throws `DemoAppError` `residual-instrumentation` (exit 1) or `residual-check-unavailable`
 *   (exit 2, which is never a pass).
 */
export function expectNoResidualInstrumentation(
  options: Omit<ResidualCheckOptions, 'relDir'> = {},
): Promise<ResidualCheckOutcome> {
  return expectNoResidualInstrumentationIn({ ...options, relDir: SAMPLE_APP_REL_DIR });
}

/**
 * The 1-based line (and column) of the `occurrence`-th line of `file` that contains `needle`,
 * with `file` resolved against {@link sampleAppRoot} unless `options.relativeTo` says otherwise —
 * so `sourceLineContaining('src/components/PingWidget.tsx', "fetch('/api/ping'")` finds the
 * fixture's request site at runtime, in the frame of a `SourceLocation.file`. Read-only.
 *
 * @throws `DemoAppError` `source`, naming the file, the needle and bounded near misses.
 */
export function sourceLineContaining(
  file: string,
  needle: string | RegExp,
  options: SourceLineOptions = {},
): Promise<SourceLineMatch> {
  return sourceLineContainingIn(file, needle, {
    ...options,
    relativeTo: options.relativeTo ?? sampleAppRoot(),
  });
}

// ---------------------------------------------------------------------------
// The SampleAppHandle
// ---------------------------------------------------------------------------

/** Options of {@link createSampleAppHandle}; they become the defaults of its `start()`. */
export interface SampleAppHandleOptions {
  /** See {@link StartSampleAppOptions.command}; leave it unset. */
  readonly command?: string | readonly string[] | undefined;
  /** See {@link StartSampleAppOptions.timeoutMs}. */
  readonly launchTimeoutMs?: number | undefined;
  /** See {@link StartSampleAppOptions.readyTimeoutMs}. */
  readonly readyTimeoutMs?: number | undefined;
}

/**
 * Everything a spec needs about the fixture app, bound to one service: the worker fixture
 * `sampleApp`. Re-entrant: `start()` twice reuses the recorded launch (the launcher keeps one
 * child per project root, so `reused: true`), `stop()` twice answers `stopped: false`, and
 * `ensurePortFree()`, `start()` and `stop()` run one at a time in call order.
 */
export interface SampleAppHandle {
  /** The fixture's absolute project root ({@link sampleAppRoot}). */
  readonly projectRoot: string;
  /** The fixture's repository-relative directory ({@link SAMPLE_APP_REL_DIR}). */
  readonly relDir: string;
  /** The origin the suite opens the fixture at ({@link sampleAppBaseUrl}). */
  readonly baseUrl: string;
  /** The fixture's port ({@link sampleAppPort}). */
  readonly port: number;
  /** The current launch record — with `preloadAttached` — or `undefined` before `start()` / after `stop()`. */
  readonly launch: SampleAppLaunch | undefined;
  /** {@link resolveNextBinary}. */
  resolveNextBinary(): Promise<string>;
  /** {@link sampleAppLaunchCommand} for {@link port}. */
  launchCommand(): Promise<string>;
  /** {@link ensurePortFree}; serialised with `start()` and `stop()`. */
  ensurePortFree(): Promise<PortFreeResult>;
  /** {@link startSampleApp} with this handle's defaults; serialised. */
  start(options?: StartSampleAppOptions): Promise<SampleAppLaunch>;
  /** {@link stopSampleApp}; idempotent and serialised. */
  stop(): Promise<SampleAppStopResult>;
  /** {@link expectPreloadAttached} over the current launch. */
  expectPreloadAttached(): SampleAppLaunch;
  /** {@link isServing} against {@link baseUrl}. */
  isServing(options?: ServingProbeOptions): Promise<boolean>;
  /** {@link expectServing} against {@link baseUrl}. */
  expectServing(options?: ServingProbeOptions): Promise<ServingProbeResult>;
  /** {@link snapshotTrackedFiles} of the fixture. */
  snapshotTrackedFiles(): Promise<TrackedFileSnapshot>;
  /** {@link verifyRestored} against the fixture. */
  verifyRestored(
    snapshot: TrackedFileSnapshot,
    options?: Omit<VerifyRestoredOptions, 'relDir'>,
  ): Promise<RestorationReport>;
  /** {@link findMarkers} for the fixture. */
  findMarkers(): Promise<readonly MarkerFinding[]>;
  /** {@link worktreeDirty} for the fixture. */
  worktreeDirty(): Promise<boolean>;
  /** {@link runResidualCheck} for the fixture (`--path tests/fixtures/sample-next-app`). */
  runResidualCheck(): Promise<ResidualCheckOutcome>;
  /** {@link expectNoResidualInstrumentation} for the fixture. */
  expectNoResidualInstrumentation(
    options?: Omit<ResidualCheckOptions, 'relDir'>,
  ): Promise<ResidualCheckOutcome>;
  /** {@link sourceLineContaining}, resolving `file` against the fixture root unless `relativeTo` says otherwise. */
  sourceLineContaining(
    file: string,
    needle: string | RegExp,
    options?: SourceLineOptions,
  ): Promise<SourceLineMatch>;
}

/**
 * Bundle the fixture's lifecycle, restoration contract, residual check and source lookup into
 * one {@link SampleAppHandle} bound to `service`. Creating it does no work beyond resolving the
 * fixture root and address (an unusable `SAMPLE_APP_PORT` therefore fails here, once); every
 * operation is lazy.
 *
 * @throws {SampleAppError} `prerequisites` for an unusable port setting.
 */
export function createSampleAppHandle(
  service: ServiceHandle,
  options: SampleAppHandleOptions = {},
): SampleAppHandle {
  const projectRoot = sampleAppRoot();
  const port = sampleAppPort();
  const baseUrl = sampleAppBaseUrl();
  // ensurePortFree(), start() and stop() run one at a time, in call order, so a teardown stop
  // never races a launch still in flight.
  let lifecycle: Promise<unknown> = Promise.resolve();
  const serialise = <T>(step: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(step, step);
    lifecycle = result.catch(() => undefined);
    return result;
  };

  return {
    projectRoot,
    relDir: SAMPLE_APP_REL_DIR,
    baseUrl,
    port,
    get launch(): SampleAppLaunch | undefined {
      return launches.get(projectRoot);
    },
    resolveNextBinary: () => resolveNextBinary(),
    launchCommand: () => sampleAppLaunchCommand(port),
    ensurePortFree: () => serialise(() => ensurePortFree(service)),
    start: (startOptions = {}) =>
      serialise(() =>
        startSampleApp(service, {
          command: startOptions.command ?? options.command,
          timeoutMs: startOptions.timeoutMs ?? options.launchTimeoutMs,
          readyTimeoutMs: startOptions.readyTimeoutMs ?? options.readyTimeoutMs,
          assertPreload: startOptions.assertPreload,
        }),
      ),
    stop: () => serialise(() => stopSampleApp(service)),
    expectPreloadAttached: () => {
      const current = launches.get(projectRoot);
      if (current === undefined) {
        throw new SampleAppError(
          'preload-not-attached',
          'The fixture app has not been started through POST /dev-server/launch in this process (call start() first), so no launch can be judged.',
        );
      }
      return expectPreloadAttached(current);
    },
    isServing: (probeOptions = {}) =>
      isServing({ ...probeOptions, baseUrl: probeOptions.baseUrl ?? baseUrl }),
    expectServing: (probeOptions = {}) =>
      expectServing({ ...probeOptions, baseUrl: probeOptions.baseUrl ?? baseUrl }),
    snapshotTrackedFiles: () => snapshotTrackedFiles(),
    verifyRestored: (snapshot, verifyOptions = {}) => verifyRestored(snapshot, verifyOptions),
    findMarkers: () => findMarkers(),
    worktreeDirty: () => worktreeDirty(),
    runResidualCheck: () => runResidualCheck(),
    expectNoResidualInstrumentation: (checkOptions = {}) =>
      expectNoResidualInstrumentation(checkOptions),
    sourceLineContaining: (file, needle, lookupOptions = {}) =>
      sourceLineContaining(file, needle, lookupOptions),
  };
}
