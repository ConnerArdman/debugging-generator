/**
 * The lifecycle of the "Lumen Supply" demo application (`apps/demo-app`) and
 * the **restoration contract** of the whole `e2e` suite.
 *
 * ## What this module owns
 *
 * - **Preconditions** — {@link assertDemoPrerequisites}: the demo is in the
 *   checkout, its generated Prisma client exists, and a `DATABASE_URL` is
 *   available. Every failure names its fix.
 * - **The database** — {@link ensureDemoDatabase} runs the root scripts
 *   `pnpm demo:migrate` and `pnpm demo:seed` by name, once per process, with a
 *   heartbeat so the ≈200 000-row seed never looks like a hang.
 * - **The dev server** — {@link startDemoApp} / {@link stopDemoApp} go through
 *   the product's own launcher (`POST /dev-server/launch`, `POST
 *   /dev-server/stop`). That path attaches `NODE_OPTIONS=--import <telemetry
 *   preload>` and injects `DEBUGGEN_INGEST_URL`, `DEBUGGEN_TOKEN` and
 *   `DEBUGGEN_PROJECT_ROOT`; it is part of what the specs exist to prove.
 *   {@link expectPreloadAttached} turns the one confusing failure — a server
 *   someone else started still holding the demo URL — into an exact diagnosis.
 * - **Serving probes** — {@link isServing} / {@link expectServing}, the AAP
 *   §0.5.1 "the application keeps serving" check.
 * - **The restoration contract** — {@link snapshotTrackedFiles},
 *   {@link verifyRestored} and {@link diffSnapshots}: the SHA-256 of the raw
 *   bytes of every file git tracks under `apps/demo-app`, taken before a
 *   session and compared after it (AAP §0.8.3, §0.8.4 acceptance test 3).
 * - **The residual-instrumentation guard, in process** — {@link findMarkers},
 *   {@link worktreeDirty}, {@link runResidualCheck} and
 *   {@link expectNoResidualInstrumentation} load
 *   `scripts/check-no-residual-instrumentation.mjs` and call its own exports,
 *   so this suite and `pnpm check:no-residual-instrumentation` can never
 *   disagree.
 * - **Runtime source lookup** — {@link sourceLineContaining} and
 *   {@link readDemoSource}, so a spec derives the expected line of a call site
 *   (the `pool.query` behind the slow checkout) at run time instead of
 *   hard-coding a number that moves whenever the demo is edited.
 * - {@link createDemoAppHandle} bundles all of it into the re-entrant
 *   {@link DemoAppHandle} that `fixtures.ts` exposes as the worker-scoped,
 *   lazily instantiated `demoApp` fixture.
 *
 * ## What this module never does
 *
 * 1. **It never writes under `apps/demo-app`** (AAP §0.5.1: helpers read, the
 *    product writes). Instrumentation is installed only by the real installer
 *    and removed only by the real cleanup; this file opens demo files for
 *    reading and hashing and nothing else. The clean-`git status` guarantee
 *    of acceptance test 3 depends on that.
 * 2. **It never starts `next dev` itself and never signals a process.** A
 *    hand-spawned dev server has no server-agent connection, so a session
 *    over it collects no server or database spans, and the failure would look
 *    like a correlation bug. Process lifetime belongs to the launcher, which
 *    keeps one child per project root; a server this module did not launch is
 *    reported, never killed.
 * 3. **It never reads `.git/`** (the `origin` URL embeds a live access token).
 *    Tracked files are enumerated with `git ls-files` through `./repo`, and the
 *    working-tree check is the guard script's own `git status --porcelain`.
 * 4. **It never re-implements the guard.** The marker scan and the
 *    working-tree check are the script's; this module only loads and calls it.
 * 5. **It never prints file contents or a diff.** Restoration failures name
 *    paths; lookup failures name line numbers. A diff of a patched file would
 *    put instrumentation code and project source into the report.
 * 6. **It never inlines or logs a connection string or credential.**
 *    `DATABASE_URL` is read from the environment and forwarded to the pnpm
 *    child only; error text is scrubbed of it (`pnpm check:secrets`).
 * 7. **It does no work at import time** — no top-level `await`, no I/O, no
 *    environment reads. `clean-clone.spec.ts` imports `fixtures.ts`, which
 *    imports this file, and must pay for none of it.
 * 8. **It declares no tests.** Specs and `fixtures.ts` consume its exports.
 *
 * ## The database-URL contract
 *
 * `DATABASE_URL` comes from the process environment (CI's job env, a
 * developer's shell) or from the git-ignored `apps/demo-app/.env`, which the
 * Prisma CLI (`prisma.config.ts`) and Next.js both load themselves. This module
 * checks that file's existence and never reads it. The development value to
 * copy lives in `.env.example` / `apps/demo-app/.env.example`; PostgreSQL is
 * started locally with `pnpm demo:db` and in CI by the e2e job's
 * `services.postgres` container.
 *
 * ## Relationship to its siblings
 *
 * `./repo` supplies the repository root, command runner and `git ls-files`;
 * `./service` supplies the typed service client. `sample-app.ts` reuses this
 * module's snapshot, restoration, residual-check and source-lookup functions
 * with its own `relDir` / `relativeTo`, so the fixture application gets the
 * same contract without a second implementation. The dependency is one-way:
 * this module never imports `fixtures.ts`, and it owns its own budgets.
 */

import type { Stats } from 'node:fs';
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect } from '@playwright/test';

import { sha256Hex, sha256OfFile } from '@debuggen/shared/node';

import { demoUrl as configuredDemoUrl } from '../../../playwright.config';
import {
  CommandFailedError,
  MIGRATE_TIMEOUT_MS,
  SEED_TIMEOUT_MS,
  listTrackedFiles,
  repoPath,
  repoRoot,
  runPnpm,
} from './repo';
import type { CommandResult } from './repo';
import { POLL_INTERVALS_MS, ServiceCallError } from './service';
import type { DevServerLaunchResponse, ServiceHandle } from './service';

// ---------------------------------------------------------------------------
// Identity and budgets — named once so no caller restates a magic number
// ---------------------------------------------------------------------------

/**
 * The demo's repository-relative POSIX directory: the `git ls-files` /
 * `git status` scope and the guard script's `relDir` (it is also the script's
 * own `DEFAULT_TARGET_PATH`).
 */
export const DEMO_APP_REL_DIR = 'apps/demo-app';

/** The generated Prisma client, relative to the demo root (git-ignored; `prisma generate` writes it). */
export const DEMO_GENERATED_CLIENT_REL_DIR = 'src/generated/prisma';

/** The guard script this module runs in process, repository-relative. */
export const RESIDUAL_CHECK_SCRIPT = 'scripts/check-no-residual-instrumentation.mjs';

/** The environment variable carrying the demo's PostgreSQL connection URL (never its value). */
export const DATABASE_URL_ENV = 'DATABASE_URL';

/**
 * Set to `1` (or `true`) to skip `pnpm demo:seed` while iterating locally on an
 * already-seeded database. Migrations still run. {@link ensureDemoDatabase}
 * reports the skip so a spec can say why data is missing.
 */
export const SKIP_SEED_ENV = 'DEBUGGEN_E2E_SKIP_SEED';

/**
 * Budget of one `POST /dev-server/launch`. The request blocks until the child
 * prints its URL, and the launcher's own readiness budget is 60 s; this is
 * longer, so the launcher's actionable 504 (with its hint) arrives before a
 * client-side abort would.
 */
export const DEMO_LAUNCH_TIMEOUT_MS = 90_000;

/**
 * How long {@link startDemoApp} polls the launched server until a GET is
 * answered. The first request compiles the home page (and queries the
 * database), which is slow on a cold Next.js dev server.
 */
export const DEMO_READY_TIMEOUT_MS = 150_000;

/** The bound on one readiness GET inside {@link startDemoApp}'s poll. */
export const DEMO_READY_PROBE_TIMEOUT_MS = 60_000;

/** The default bound on one {@link isServing} / {@link expectServing} GET. */
export const SERVING_PROBE_TIMEOUT_MS = 15_000;

/** The bound on the TCP connect that asks "is anything already on the demo port?" before a launch. */
export const PRE_LAUNCH_PROBE_TIMEOUT_MS = 2_000;

/** Budget of one `POST /dev-server/stop` (the launcher's SIGTERM grace is 5 s, then SIGKILL). */
export const DEMO_STOP_TIMEOUT_MS = 30_000;

/**
 * The worst case of the demo fixture's setup — migrate, seed, launch and first
 * compile — for a worker-scoped fixture's `timeout`.
 */
export const DEMO_APP_SETUP_TIMEOUT_MS =
  MIGRATE_TIMEOUT_MS + SEED_TIMEOUT_MS + DEMO_LAUNCH_TIMEOUT_MS + DEMO_READY_TIMEOUT_MS;

/** Files hashed concurrently by {@link snapshotTrackedFiles}. */
export const SNAPSHOT_HASH_CONCURRENCY = 16;

/** The largest source file {@link sourceLineContaining} / {@link readDemoSource} will read. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** How many paths one section of a restoration failure lists before summarising the rest. */
export const MAX_REPORTED_PATHS = 50;

/** How many near-miss line numbers a failed {@link sourceLineContaining} names. */
export const MAX_NEAR_MISS_LINES = 5;

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** What went wrong, as a stable discriminator a spec can assert on. */
export type DemoAppErrorCode =
  | 'prerequisites'
  | 'database'
  | 'launch'
  | 'preload-not-attached'
  | 'origin-mismatch'
  | 'not-serving'
  | 'stop'
  | 'snapshot'
  | 'not-restored'
  | 'residual-instrumentation'
  | 'residual-check-unavailable'
  | 'source';

/**
 * Every failure this module raises. The message is actionable on its own —
 * symptom, cause and fix — and carries no credential, file content or diff.
 */
export class DemoAppError extends Error {
  /** A stable discriminator; see {@link DemoAppErrorCode}. */
  readonly code: DemoAppErrorCode;

  constructor(code: DemoAppErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = 'DemoAppError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** A thrown value's message, without its stack. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `text` without trailing full stops or whitespace, ready to be followed by one full stop. */
function sentence(text: string): string {
  return text.replace(/[.\s]+$/, '');
}

/**
 * Remove anything credential-shaped from text that may have passed through a
 * child's output: the configured `DATABASE_URL` value itself and any URL
 * authority that embeds a user name and a password.
 */
function scrubCredentials(text: string): string {
  const configured = process.env[DATABASE_URL_ENV]?.trim();
  const withoutConfigured =
    configured === undefined || configured === ''
      ? text
      : text.replaceAll(configured, `[${DATABASE_URL_ENV}]`);
  return withoutConfigured.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"`]+:[^\s/@'"`]+@/gi,
    '$1[redacted]@',
  );
}

/** Whether `candidate` exists and satisfies `check` (lstat: a symlink is never followed). */
async function lstatMatches(candidate: string, check: (stats: Stats) => boolean): Promise<boolean> {
  try {
    return check(await lstat(candidate));
  } catch {
    return false;
  }
}

/** A POSIX path from native separators. */
function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Whether `relative` (from `path.relative`) stays inside its base without being the base. */
function isInside(relative: string): boolean {
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Whether any segment of a POSIX path is `.git`. */
function hasGitSegment(posixPath: string): boolean {
  return posixPath.split('/').some((segment) => segment === '.git');
}

/** Up to {@link MAX_REPORTED_PATHS} entries, indented, with a count of the rest. */
function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_REPORTED_PATHS).map((entry) => `    - ${entry}`);
  const rest = paths.length - shown.length;
  return rest > 0 ? [...shown, `    … and ${String(rest)} more`].join('\n') : shown.join('\n');
}

/** Whether an optional flag variable is switched on (`1`, `true`, `yes`; case-insensitive). */
function flagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

// ---------------------------------------------------------------------------
// Paths and preconditions
// ---------------------------------------------------------------------------

/** The demo's absolute project root — the `projectRoot` every launcher and session call names. */
export function demoRoot(): string {
  return repoPath('apps', 'demo-app');
}

/**
 * The origin the suite opens the demo at: the Playwright config's `demoUrl`
 * (`DEMO_URL`, default `http://localhost:3000`), validated and reduced to its
 * origin (no trailing slash).
 *
 * It must be plain `http` on `localhost` or `127.0.0.1`: the Chrome
 * extension's `host_permissions` are `http://localhost/*` and
 * `http://127.0.0.1/*`, so its content scripts — the telemetry agent among
 * them — run on those origins only, and the browser tier would silently
 * disappear anywhere else.
 *
 * @throws {DemoAppError} `prerequisites`, naming the fix.
 */
export function demoBaseUrl(): string {
  let url: URL;
  try {
    url = new URL(configuredDemoUrl);
  } catch (error) {
    throw new DemoAppError(
      'prerequisites',
      `DEMO_URL is not a valid URL; set it to an origin such as http://localhost:3000 (the default) or unset it.`,
      { cause: error },
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new DemoAppError(
      'prerequisites',
      'DEMO_URL must not carry credentials; set it to a bare origin such as http://localhost:3000.',
    );
  }
  if (url.protocol !== 'http:' || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
    throw new DemoAppError(
      'prerequisites',
      `DEMO_URL resolves to ${url.origin}, but the Chrome extension's content scripts only run on http://localhost/* and http://127.0.0.1/*; set DEMO_URL to http://localhost:<port> (default http://localhost:3000).`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new DemoAppError(
      'prerequisites',
      `DEMO_URL must be an origin without a path, query or fragment; use ${url.origin}.`,
    );
  }
  return url.origin;
}

/** Where the demo's `DATABASE_URL` comes from. */
export type DemoDatabaseUrlSource = 'environment' | 'demo-dotenv-file';

/** The `DATABASE_URL` value from the process environment, when it is set and non-blank. */
function databaseUrlFromEnvironment(): string | undefined {
  const value = process.env[DATABASE_URL_ENV];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Where `DATABASE_URL` will come from: the environment, or the git-ignored
 * `apps/demo-app/.env` that the Prisma CLI and Next.js load themselves. The
 * file is checked for existence only — never opened.
 */
async function databaseUrlSource(): Promise<DemoDatabaseUrlSource | undefined> {
  if (databaseUrlFromEnvironment() !== undefined) {
    return 'environment';
  }
  const dotenv = path.join(demoRoot(), '.env');
  return (await lstatMatches(dotenv, (stats) => stats.isFile())) ? 'demo-dotenv-file' : undefined;
}

/** What {@link assertDemoPrerequisites} established. */
export interface DemoPrerequisites {
  /** The demo's absolute project root. */
  readonly projectRoot: string;
  /** The generated Prisma client directory (absolute). */
  readonly generatedClientDir: string;
  /** Where `DATABASE_URL` comes from. */
  readonly databaseUrlSource: DemoDatabaseUrlSource;
}

/**
 * Check, without touching anything, that the demo can be migrated, seeded and
 * served: the demo is in the checkout, its generated Prisma client exists
 * (`src/generated/prisma` is git-ignored, so a clean checkout needs
 * `pnpm build` or `pnpm demo:generate` first) and `DATABASE_URL` is available.
 * Every problem is reported at once, each with its fix.
 *
 * @throws {DemoAppError} `prerequisites`.
 */
export async function assertDemoPrerequisites(): Promise<DemoPrerequisites> {
  const projectRoot = demoRoot();
  const generatedClientDir = path.join(projectRoot, ...DEMO_GENERATED_CLIENT_REL_DIR.split('/'));
  const problems: string[] = [];

  const hasManifest = await lstatMatches(path.join(projectRoot, 'package.json'), (stats) =>
    stats.isFile(),
  );
  if (!hasManifest) {
    problems.push(
      `${DEMO_APP_REL_DIR}/package.json is missing, so the demo application is not in this checkout: restore the full checkout (\`git sparse-checkout disable\`, or re-clone) and run \`pnpm install\`.`,
    );
  }

  const hasClient = await lstatMatches(path.join(generatedClientDir, 'client.ts'), (stats) =>
    stats.isFile(),
  );
  if (!hasClient) {
    problems.push(
      `The generated Prisma client (${DEMO_APP_REL_DIR}/${DEMO_GENERATED_CLIENT_REL_DIR}) does not exist; it is git-ignored and generated, not committed: run \`pnpm build\` or \`pnpm demo:generate\` (neither needs a database).`,
    );
  }

  const source = await databaseUrlSource();
  if (source === undefined) {
    problems.push(
      `${DATABASE_URL_ENV} is not set and ${DEMO_APP_REL_DIR}/.env does not exist: export ${DATABASE_URL_ENV} (its development value is in .env.example and ${DEMO_APP_REL_DIR}/.env.example) or copy ${DEMO_APP_REL_DIR}/.env.example to ${DEMO_APP_REL_DIR}/.env, and start PostgreSQL with \`pnpm demo:db\` (CI provides the e2e job's services.postgres container).`,
    );
  }

  if (problems.length > 0 || source === undefined) {
    throw new DemoAppError(
      'prerequisites',
      [
        `The demo application cannot be prepared (${String(problems.length)} problem(s)):`,
        ...problems.map((problem) => `  - ${problem}`),
      ].join('\n'),
    );
  }
  return { projectRoot, generatedClientDir, databaseUrlSource: source };
}

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

/** Options of {@link ensureDemoDatabase}. */
export interface EnsureDemoDatabaseOptions {
  /** Run migrate (and seed) again even when this process already did. */
  readonly force?: boolean | undefined;
}

/** What {@link ensureDemoDatabase} did. */
export interface DemoDatabaseState {
  /** `pnpm demo:migrate` ran and succeeded. */
  readonly migrated: boolean;
  /** `pnpm demo:seed` ran and succeeded. */
  readonly seeded: boolean;
  /** Seeding was skipped on request ({@link SKIP_SEED_ENV}); the data is whatever was there. */
  readonly skipped: boolean;
  /** Why seeding was skipped, when it was. */
  readonly skipReason: string | undefined;
  /** Where `DATABASE_URL` came from. */
  readonly databaseUrlSource: DemoDatabaseUrlSource;
  /** Wall-clock milliseconds of the migrate step. */
  readonly migrateDurationMs: number;
  /** Wall-clock milliseconds of the seed step (0 when skipped). */
  readonly seedDurationMs: number;
}

/** The one database preparation of this process; see {@link ensureDemoDatabase}. */
let databaseReady: Promise<DemoDatabaseState> | undefined;

/**
 * Migrate and seed the demo database — once per process, because the whole
 * suite (`workers: 1`) shares one database: the first call does the work and
 * every later call answers with the same promise. A failed preparation is not
 * remembered, so the next call tries again; `force` re-runs after whatever is
 * in flight settles, never concurrently with it.
 *
 * Both steps are the root scripts `pnpm demo:migrate` (`prisma migrate
 * deploy`) and `pnpm demo:seed` (`prisma db seed`), invoked by name, so this
 * module can never drift from how a developer prepares the database. The seed
 * truncates all twelve tables before loading, so repeating it is safe.
 *
 * @throws {DemoAppError} `prerequisites` or `database`, naming the fix.
 */
export function ensureDemoDatabase(
  options: EnsureDemoDatabaseOptions = {},
): Promise<DemoDatabaseState> {
  const previous = databaseReady;
  if (previous !== undefined && options.force !== true) {
    return previous;
  }
  const run = (): Promise<DemoDatabaseState> => prepareDemoDatabase();
  const attempt = previous === undefined ? run() : previous.then(run, run);
  databaseReady = attempt;
  attempt.catch(() => {
    if (databaseReady === attempt) {
      databaseReady = undefined;
    }
  });
  return attempt;
}

/** The non-interactive, explicit environment of the database scripts. */
function databaseCommandEnv(): Record<string, string> {
  const url = databaseUrlFromEnvironment();
  // `./repo` forwards an allowlist only, so DATABASE_URL must be an explicit
  // extra; when it is absent the file source applies (prisma.config.ts loads
  // apps/demo-app/.env itself).
  return {
    CI: 'true',
    PRISMA_HIDE_UPDATE_MESSAGE: 'true',
    ...(url === undefined ? {} : { [DATABASE_URL_ENV]: url }),
  };
}

async function prepareDemoDatabase(): Promise<DemoDatabaseState> {
  const prerequisites = await assertDemoPrerequisites();
  const env = databaseCommandEnv();

  const migrate = await runDatabaseScript('demo:migrate', MIGRATE_TIMEOUT_MS, env);

  if (flagEnabled(SKIP_SEED_ENV)) {
    return {
      migrated: true,
      seeded: false,
      skipped: true,
      skipReason: `${SKIP_SEED_ENV} is set, so \`pnpm demo:seed\` did not run; the database holds whatever an earlier seed left.`,
      databaseUrlSource: prerequisites.databaseUrlSource,
      migrateDurationMs: migrate.durationMs,
      seedDurationMs: 0,
    };
  }

  const seed = await runDatabaseScript('demo:seed', SEED_TIMEOUT_MS, env);
  return {
    migrated: true,
    seeded: true,
    skipped: false,
    skipReason: undefined,
    databaseUrlSource: prerequisites.databaseUrlSource,
    migrateDurationMs: migrate.durationMs,
    seedDurationMs: seed.durationMs,
  };
}

/** What a database script's output said about why it failed, if it said anything recognisable. */
interface DatabaseFailureSignals {
  unreachable: boolean;
  authentication: boolean;
  missingDatabase: boolean;
  missingSchema: boolean;
  migrationState: boolean;
}

/** Record the recognisable failure signals of one output line (flags only, never the line). */
function observeDatabaseLine(signals: DatabaseFailureSignals, line: string): void {
  if (/P1001|can't reach database server|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(line)) {
    signals.unreachable = true;
  }
  if (/P1000|authentication failed/i.test(line)) {
    signals.authentication = true;
  }
  if (/P1003|database .* does not exist/i.test(line)) {
    signals.missingDatabase = true;
  }
  if (/P2021|relation .* does not exist|table .* does not exist/i.test(line)) {
    signals.missingSchema = true;
  }
  if (/P3005|P3009|P3018/.test(line)) {
    signals.migrationState = true;
  }
}

/** The actionable cause of a failed database script, from its signals. */
function databaseDiagnosis(signals: DatabaseFailureSignals, timedOut: boolean): string {
  const causes: string[] = [];
  if (signals.unreachable) {
    causes.push(
      `PostgreSQL is not reachable at the address in ${DATABASE_URL_ENV}: start it with \`pnpm demo:db\` locally (CI: the e2e job's services.postgres container) and check the host and port of ${DATABASE_URL_ENV}.`,
    );
  }
  if (signals.authentication) {
    causes.push(
      `PostgreSQL refused the credentials in ${DATABASE_URL_ENV}: use the development role from .env.example (the one docker-compose.yml creates).`,
    );
  }
  if (signals.missingDatabase) {
    causes.push(
      `The database named in ${DATABASE_URL_ENV} does not exist: create it (docker-compose.yml creates the default one) or point ${DATABASE_URL_ENV} at an existing database.`,
    );
  }
  if (signals.missingSchema) {
    causes.push(
      'The schema is incomplete: `pnpm demo:migrate` must succeed before `pnpm demo:seed`.',
    );
  }
  if (signals.migrationState) {
    causes.push(
      `The database's migration history does not match apps/demo-app/prisma/migrations: point ${DATABASE_URL_ENV} at a fresh database (or drop and recreate this one) and re-run.`,
    );
  }
  if (timedOut) {
    causes.push(
      'The script exceeded its budget; the seed writes ≈200 000 inventory movements, so check that the host is not starved and that PostgreSQL is healthy.',
    );
  }
  return causes.length === 0
    ? `Check that PostgreSQL is running (\`pnpm demo:db\`; CI: services.postgres) and that ${DATABASE_URL_ENV} addresses it.`
    : causes.join(' ');
}

/**
 * Run one root database script by name with a label, the heartbeat, streamed
 * output and `expectSuccess`, translating a failure into its likely cause.
 */
async function runDatabaseScript(
  script: 'demo:migrate' | 'demo:seed',
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  const signals: DatabaseFailureSignals = {
    unreachable: false,
    authentication: false,
    missingDatabase: false,
    missingSchema: false,
    migrationState: false,
  };
  try {
    return await runPnpm([script], {
      cwd: repoRoot(),
      timeoutMs,
      env,
      label: script,
      expectSuccess: true,
      onLine: (line) => {
        observeDatabaseLine(signals, line);
      },
    });
  } catch (error) {
    const timedOut = error instanceof CommandFailedError && error.result.timedOut;
    // No `cause`: the underlying message (the command's output tail) is
    // carried below after scrubbing, and a reporter printing an unscrubbed
    // cause is exactly what `scrubCredentials` exists to prevent.
    throw new DemoAppError(
      'database',
      scrubCredentials(
        `Preparing the demo database failed at \`pnpm ${script}\`. ${databaseDiagnosis(signals, timedOut)}\n${messageOf(error)}`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Serving probes
// ---------------------------------------------------------------------------

/** Options of {@link probeDemo}, {@link isServing} and {@link expectServing}. */
export interface ServingProbeOptions {
  /** The path to GET, starting with `/`; defaults to `/`. */
  readonly path?: string | undefined;
  /** The bound on the request; defaults to {@link SERVING_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** The origin to probe; defaults to {@link demoBaseUrl}. */
  readonly baseUrl?: string | undefined;
}

/** The outcome of one bounded GET against the demo. */
export interface ServingProbeResult {
  /** The URL requested. */
  readonly url: string;
  /** A response below 500 arrived within the bound. */
  readonly serving: boolean;
  /** The response status, when one arrived. */
  readonly status: number | undefined;
  /** Why no response arrived (connection refused, timeout…), when none did. */
  readonly error: string | undefined;
  /** Wall-clock milliseconds of the request. */
  readonly durationMs: number;
}

/** The probe URL for `options`, refusing a path that would leave the probed origin. */
function probeUrl(options: ServingProbeOptions): URL {
  const base = options.baseUrl ?? demoBaseUrl();
  const requested = options.path ?? '/';
  if (!requested.startsWith('/') || requested.startsWith('//')) {
    throw new DemoAppError(
      'not-serving',
      `probe path must start with a single "/", got ${JSON.stringify(requested)}`,
    );
  }
  const url = new URL(requested, base);
  if (url.origin !== new URL(base).origin) {
    throw new DemoAppError('not-serving', `probe path ${JSON.stringify(requested)} leaves ${base}`);
  }
  return url;
}

/** A fetch failure in words: the timeout, or the underlying socket error code. */
function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `no response within ${String(timeoutMs)} ms`;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
  const message = messageOf(error);
  return code === undefined ? message : `${message} (${code})`;
}

/**
 * One bounded GET against the demo (or `options.baseUrl`). Never throws for a
 * network failure — the result says what happened — only for a malformed
 * `path`. Redirects are not followed and the body is discarded.
 */
export async function probeDemo(options: ServingProbeOptions = {}): Promise<ServingProbeResult> {
  const url = probeUrl(options);
  const timeoutMs = options.timeoutMs ?? SERVING_PROBE_TIMEOUT_MS;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return {
      url: url.href,
      serving: response.status < 500,
      status: response.status,
      error: undefined,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      url: url.href,
      serving: false,
      status: undefined,
      error: describeFetchError(error, timeoutMs),
      durationMs: Date.now() - started,
    };
  }
}

/** A probe result in words, for failure messages. */
function describeProbe(result: ServingProbeResult | undefined): string {
  if (result === undefined) {
    return 'no probe completed';
  }
  return result.status === undefined
    ? `${result.url}: ${result.error ?? 'no response'}`
    : `${result.url}: HTTP ${String(result.status)}`;
}

/**
 * Whether the demo answers a GET with a status below 500 — the AAP §0.5.1
 * "the application keeps serving" probe. `cleanup.spec.ts` calls it after
 * `session.end` and before {@link stopDemoApp}: the inert preload is still
 * loaded then, and serving is the expected outcome, not a sign of residue.
 */
export async function isServing(options: ServingProbeOptions = {}): Promise<boolean> {
  return (await probeDemo(options)).serving;
}

/**
 * Assert the demo answers a GET with a status below 500.
 *
 * @throws {DemoAppError} `not-serving`, naming the URL and the status or error.
 */
export async function expectServing(
  options: ServingProbeOptions = {},
): Promise<ServingProbeResult> {
  const result = await probeDemo(options);
  if (!result.serving) {
    throw new DemoAppError(
      'not-serving',
      `The demo is not serving ${describeProbe(result)}. It is started only through POST /dev-server/launch (startDemoApp); if the dev server exited, the service log (the webServer output) shows why.`,
    );
  }
  return result;
}

/**
 * Whether anything accepts a TCP connection on `origin`'s host and port.
 * Used before a launch because a GET would wait out a cold compile; a
 * connect answers at once.
 */
function isPortListening(origin: string, timeoutMs: number): Promise<boolean> {
  const url = new URL(origin);
  const port = url.port === '' ? 80 : Number(url.port);
  return new Promise((resolve) => {
    const socket = createConnection({ host: url.hostname, port });
    const finish = (listening: boolean): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Starting and stopping through the product's launcher
// ---------------------------------------------------------------------------

/** One launch of the demo, as the launcher reported it and as this module judged it. */
export interface DemoAppLaunch {
  /** The absolute project root the launcher keys its child by. */
  readonly projectRoot: string;
  /** The URL the launcher reported (`origin/` of the first loopback URL the child printed). */
  readonly devServerUrl: string;
  /** The origin of {@link devServerUrl}. */
  readonly origin: string;
  /** The child's pid, as the launcher reported it. Never signalled by this module. */
  readonly pid: number;
  /** The origin the suite opens ({@link demoBaseUrl}) at the time of the launch. */
  readonly baseUrl: string;
  /**
   * The server answering {@link baseUrl} is the launcher's child — which the
   * launcher always starts with the telemetry preload — rather than a server
   * something else started. False means no server or database span will be
   * captured for a session over the page the suite opens.
   */
  readonly preloadAttached: boolean;
  /**
   * {@link origin} equals {@link baseUrl}. The service binds a tab to the
   * session whose dev-server origin matches, so a mismatch leaves the tab the
   * suite opens unbound even when the preload is attached.
   */
  readonly originMatches: boolean;
  /** The launcher answered with a child that was already running before this call. */
  readonly reused: boolean;
  /** Something already accepted connections on {@link baseUrl}'s port before the launch. */
  readonly listeningBeforeLaunch: boolean;
  /** Why the launch is unusable for a session, when it is. */
  readonly diagnosis: string | undefined;
  /** When the launch answered (epoch milliseconds). */
  readonly launchedAt: number;
  /** The launcher's response, verbatim. */
  readonly raw: DevServerLaunchResponse;
}

/** Options of {@link startDemoApp}. */
export interface StartDemoAppOptions {
  /**
   * An explicit launch command. Leave it unset: the demo is a workspace member
   * with its own `dev` script, and the launcher's own detection is the path
   * under test.
   */
  readonly command?: string | undefined;
  /** Budget of the launch request; defaults to {@link DEMO_LAUNCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Budget of the readiness poll; defaults to {@link DEMO_READY_TIMEOUT_MS}. */
  readonly readyTimeoutMs?: number | undefined;
  /**
   * Assert {@link expectPreloadAttached} before waiting for readiness
   * (default `true`). Pass `false` only to inspect an unusable launch.
   */
  readonly assertPreload?: boolean | undefined;
}

/** What {@link stopDemoApp} did. */
export interface DemoAppStopResult {
  /** The launcher stopped a child it owned; `false` means nothing was running (a success). */
  readonly stopped: boolean;
  /** The project root the stop named. */
  readonly projectRoot: string;
  /** The pid of the launch this module last recorded for that root, if any. */
  readonly pid: number | undefined;
}

/**
 * The latest launch per project root in this process. The launcher keeps one
 * child per root; this record is what makes a second launch recognisable as a
 * reuse and what {@link stopDemoApp} reports.
 */
const launches = new Map<string, DemoAppLaunch>();

/** The launch this process last recorded for the demo, if it is still believed to run. */
export function currentDemoLaunch(): DemoAppLaunch | undefined {
  return launches.get(demoRoot());
}

/** The effective port of an http(s) URL. */
function portOfUrl(url: URL): number {
  if (url.port !== '') {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

/** Whether a hostname is a loopback name the launcher and the extension both recognise. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Whether two origins name the same loopback listening port (host spellings may differ). */
function sameLoopbackPort(left: string, right: string): boolean {
  const a = new URL(left);
  const b = new URL(right);
  return (
    a.protocol === b.protocol &&
    isLoopbackHost(a.hostname) &&
    isLoopbackHost(b.hostname) &&
    portOfUrl(a) === portOfUrl(b)
  );
}

/**
 * The exact diagnosis of the most likely confusing e2e failure: a dev server
 * the launcher did not start already holds the demo URL.
 */
function foreignServerDiagnosis(baseUrl: string, detail: string): string {
  return [
    `a dev server was already listening on ${baseUrl} without the telemetry preload (\`no-server-agent-connection\`), so this session will collect no server or database spans — stop it and re-run.`,
    detail,
    'It was not started by the Debug Generator launcher of this service — typically a `pnpm demo:dev` left running, or a demo launched by another service instance. This suite never stops a process it did not start.',
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/** Why `launch` is unusable for a session, or `undefined` when it is usable. */
function diagnoseLaunch(launch: Omit<DemoAppLaunch, 'diagnosis'>): string | undefined {
  if (launch.preloadAttached && launch.originMatches) {
    return undefined;
  }
  if (!launch.preloadAttached && launch.listeningBeforeLaunch) {
    return foreignServerDiagnosis(
      launch.baseUrl,
      `The launcher started its own preloaded dev server on ${launch.origin} (pid ${String(launch.pid)}) instead, which the suite's browser never visits: the tab opens ${launch.baseUrl}.`,
    );
  }
  if (launch.preloadAttached) {
    return `The launcher reports the demo at ${launch.origin}, but the suite opens ${launch.baseUrl} (DEMO_URL). The service binds a tab to the session whose dev-server origin matches, so set DEMO_URL=${launch.origin} and re-run.`;
  }
  return `The launcher's preloaded dev server came up on ${launch.origin}, not on the suite's demo URL ${launch.baseUrl}. The demo's \`dev\` script (\`next dev\`) takes its port from PORT in the service's environment (the next free port when the default one is taken): set PORT and DEMO_URL consistently (for example PORT=3000 with DEMO_URL=http://localhost:3000) and re-run.`;
}

/**
 * Assert that a launch is usable for a session: the server behind the URL the
 * suite opens is the launcher's preloaded child, and its origin is the one
 * the extension will bind. Returns the launch for chaining.
 *
 * @throws {DemoAppError} `preload-not-attached` — with the exact
 *   `no-server-agent-connection` diagnosis when a foreign server holds the
 *   demo URL — or `origin-mismatch`.
 */
export function expectPreloadAttached(launch: DemoAppLaunch): DemoAppLaunch {
  if (launch.preloadAttached && launch.originMatches) {
    return launch;
  }
  throw new DemoAppError(
    launch.preloadAttached ? 'origin-mismatch' : 'preload-not-attached',
    launch.diagnosis ??
      diagnoseLaunch(launch) ??
      `The demo launch on ${launch.origin} is not usable for ${launch.baseUrl}.`,
  );
}

/**
 * Hold an editor-role connection open for the duration of `action`. The
 * launcher routes are scope-checked against the workspace folders a **live**
 * editor connection announced; this connection announces the repository root
 * (which contains `apps/demo-app`), so the worker-scoped demo fixture can
 * launch before any test-scoped editor client exists. Closing it releases the
 * announcement only — a launched child is tied to neither the connection nor
 * a session and runs until `POST /dev-server/stop`.
 */
async function withEditorAnnouncement<T>(
  service: ServiceHandle,
  action: () => Promise<T>,
): Promise<T> {
  const editor = await service.connectEditor();
  try {
    return await action();
  } finally {
    editor.close();
  }
}

/** A launch failure in words, with the foreign-server diagnosis when it applies. */
function launchFailure(error: unknown, baseUrl: string, listeningBefore: boolean): DemoAppError {
  const account = messageOf(error);
  if (error instanceof ServiceCallError && error.code === 'SERVER_AGENT_NOT_READY') {
    return new DemoAppError(
      'preload-not-attached',
      foreignServerDiagnosis(baseUrl, `The launcher refused to start a second one: ${account}`),
      { cause: error },
    );
  }
  const failedToStart =
    error instanceof ServiceCallError &&
    (error.status === 502 || error.status === 504 || error.code === 'DEV_SERVER_LAUNCH_FAILED');
  const likelyCause =
    listeningBefore && failedToStart ? ` Likely cause: ${foreignServerDiagnosis(baseUrl, '')}` : '';
  return new DemoAppError(
    'launch',
    `Launching the demo through POST /dev-server/launch failed: ${sentence(account)}.${likelyCause}`,
    { cause: error },
  );
}

/** Poll `url` with bounded GETs until it answers below 500, or fail naming the last outcome. */
async function waitForDemoReady(url: string, timeoutMs: number): Promise<ServingProbeResult> {
  // Written from the poll's callback, so held in an object flow analysis
  // does not narrow away.
  const state: { last: ServingProbeResult | undefined } = { last: undefined };
  try {
    await expect
      .poll(
        async () => {
          state.last = await probeDemo({ baseUrl: url, timeoutMs: DEMO_READY_PROBE_TIMEOUT_MS });
          return state.last.serving;
        },
        {
          message: `the demo launched on ${url} did not answer a GET below HTTP 500`,
          timeout: timeoutMs,
          intervals: [...POLL_INTERVALS_MS],
        },
      )
      .toBe(true);
  } catch (error) {
    throw new DemoAppError(
      'not-serving',
      `The demo launched through POST /dev-server/launch did not become ready within ${String(timeoutMs)} ms; last probe: ${describeProbe(state.last)}. A 5xx usually means the database is unreachable (see ensureDemoDatabase); no response means the first compile is still running or the dev server exited (the service log shows its output).`,
      { cause: error },
    );
  }
  if (state.last === undefined) {
    throw new DemoAppError('not-serving', `The readiness poll of ${url} never ran.`);
  }
  return state.last;
}

/**
 * Start the demo through the product's launcher and wait until it serves.
 *
 * 1. Note whether anything already accepts connections on the demo URL's port.
 * 2. `POST /dev-server/launch { projectRoot: demoRoot() }` (with a transient
 *    editor announcement for scope). A 200 always describes a child the
 *    launcher spawned with the telemetry preload — or reused: it keeps one
 *    child per project root.
 * 3. Judge the answer: `preloadAttached` holds when the reported origin is the
 *    demo URL's port, i.e. the page the suite opens is served by that child;
 *    otherwise a foreign server holds the demo URL, or the child came up
 *    elsewhere. {@link expectPreloadAttached} runs here unless
 *    `assertPreload: false`; when it fails, the launcher's unusable child is
 *    stopped again through `POST /dev-server/stop` so the next run starts
 *    clean.
 * 4. Poll the reported URL with bounded GETs until it answers below 500.
 *
 * @throws {DemoAppError} `launch`, `preload-not-attached`, `origin-mismatch`
 *   or `not-serving`.
 */
export async function startDemoApp(
  service: ServiceHandle,
  options: StartDemoAppOptions = {},
): Promise<DemoAppLaunch> {
  const projectRoot = demoRoot();
  const baseUrl = demoBaseUrl();
  const previous = launches.get(projectRoot);
  const listeningBeforeLaunch = await isPortListening(baseUrl, PRE_LAUNCH_PROBE_TIMEOUT_MS);

  let raw: DevServerLaunchResponse;
  try {
    raw = await withEditorAnnouncement(service, () =>
      service.launchDevServer(
        {
          projectRoot,
          ...(options.command === undefined ? {} : { command: options.command }),
        },
        { timeoutMs: options.timeoutMs ?? DEMO_LAUNCH_TIMEOUT_MS },
      ),
    );
  } catch (error) {
    throw launchFailure(error, baseUrl, listeningBeforeLaunch);
  }

  const origin = new URL(raw.devServerUrl).origin;
  const originMatches = origin === baseUrl;
  const preloadAttached = sameLoopbackPort(origin, baseUrl);
  const reused =
    (previous !== undefined && previous.pid === raw.pid && previous.origin === origin) ||
    (listeningBeforeLaunch && preloadAttached);
  const judged = {
    projectRoot,
    devServerUrl: raw.devServerUrl,
    origin,
    pid: raw.pid,
    baseUrl,
    preloadAttached,
    originMatches,
    reused,
    listeningBeforeLaunch,
    launchedAt: Date.now(),
    raw,
  };
  const launch: DemoAppLaunch = { ...judged, diagnosis: diagnoseLaunch(judged) };
  launches.set(projectRoot, launch);

  if (options.assertPreload !== false) {
    try {
      expectPreloadAttached(launch);
    } catch (error) {
      const stopNote = await stopUnusableLaunch(service, launch);
      throw new DemoAppError(
        error instanceof DemoAppError ? error.code : 'launch',
        `${messageOf(error)}${stopNote}`,
      );
    }
  }

  await waitForDemoReady(launch.devServerUrl, options.readyTimeoutMs ?? DEMO_READY_TIMEOUT_MS);
  return launch;
}

/** Stop an unusable launcher child again; the note is appended to the failure. */
async function stopUnusableLaunch(service: ServiceHandle, launch: DemoAppLaunch): Promise<string> {
  try {
    const result = await stopDemoApp(service, launch);
    return result.stopped
      ? ` The launcher's own unusable child on ${launch.origin} was stopped again through POST /dev-server/stop.`
      : '';
  } catch (error) {
    return ` Stopping the launcher's unusable child on ${launch.origin} also failed: ${messageOf(error)}`;
  }
}

/**
 * Stop the demo through `POST /dev-server/stop { projectRoot }` — idempotent
 * (`stopped: false` when nothing runs) and safe in teardown after a failed
 * launch. Only the launcher's own child is ever stopped; a developer-started
 * server is never touched.
 *
 * @throws {DemoAppError} `stop` when the service cannot be asked (it is then
 *   still the launcher's to stop, for example at service shutdown).
 */
export async function stopDemoApp(
  service: ServiceHandle,
  launch?: DemoAppLaunch,
): Promise<DemoAppStopResult> {
  const projectRoot = launch?.projectRoot ?? demoRoot();
  const recorded = launches.get(projectRoot);
  let stopped: boolean;
  try {
    const response = await withEditorAnnouncement(service, () =>
      service.stopDevServer({ projectRoot }, { timeoutMs: DEMO_STOP_TIMEOUT_MS }),
    );
    stopped = response.stopped;
  } catch (error) {
    throw new DemoAppError(
      'stop',
      `Stopping the demo through POST /dev-server/stop failed: ${sentence(messageOf(error))}. The child stays the launcher's to stop (it also stops every child when the service shuts down); this suite never signals it directly.`,
      { cause: error },
    );
  }
  launches.delete(projectRoot);
  return { stopped, projectRoot, pid: launch?.pid ?? recorded?.pid };
}

// ---------------------------------------------------------------------------
// The snapshot / restoration contract
// ---------------------------------------------------------------------------

/**
 * Repository-relative POSIX path → lowercase 64-hex SHA-256 of the file's raw
 * bytes (no decoding, no newline or byte-order-mark normalisation — which is
 * what makes "byte-identical" a real claim). A tracked symbolic link is
 * recorded as the SHA-256 of `symlink:<target>`, because its link text is what
 * git tracks.
 */
export type TrackedFileSnapshot = ReadonlyMap<string, string>;

/** Why a tracked path has no digest in a snapshot. */
export type SnapshotSkipReason = 'missing' | 'not-a-regular-file';

/** A snapshot with its scope and the tracked paths it could not hash. */
export interface DetailedTrackedFileSnapshot {
  /** The repository-relative directory snapshotted. */
  readonly relDir: string;
  /** The digests. */
  readonly snapshot: TrackedFileSnapshot;
  /** Tracked paths absent from the working tree, or neither a file nor a symlink. */
  readonly skipped: readonly { readonly file: string; readonly reason: SnapshotSkipReason }[];
  /** How many paths git listed. */
  readonly tracked: number;
  /** When the snapshot finished (epoch milliseconds). */
  readonly takenAt: number;
}

/** The difference between two snapshots, each list sorted. */
export interface SnapshotDiff {
  /** Paths only in `after`. */
  readonly added: readonly string[];
  /** Paths only in `before`. */
  readonly removed: readonly string[];
  /** Paths in both whose digests differ. */
  readonly changed: readonly string[];
  /** How many paths are in both with the same digest. */
  readonly unchanged: number;
}

/** What {@link verifyRestored} compared. */
export interface RestorationReport {
  /** The directory compared. */
  readonly relDir: string;
  /** Paths compared (the snapshot's size). */
  readonly compared: number;
  /** The fresh snapshot the comparison used. */
  readonly after: DetailedTrackedFileSnapshot;
}

/** Map `items` through `task` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/** The digest of one tracked path, or why it has none. */
async function digestTrackedPath(
  file: string,
): Promise<
  | { readonly file: string; readonly digest: string }
  | { readonly file: string; readonly reason: SnapshotSkipReason }
> {
  const absolute = repoPath(file);
  let stats: Stats;
  try {
    stats = await lstat(absolute);
  } catch {
    return { file, reason: 'missing' };
  }
  if (stats.isSymbolicLink()) {
    return { file, digest: sha256Hex(`symlink:${await readlink(absolute)}`) };
  }
  if (!stats.isFile()) {
    return { file, reason: 'not-a-regular-file' };
  }
  return { file, digest: await sha256OfFile(absolute) };
}

/**
 * {@link snapshotTrackedFiles} with its scope and skip list. Every path git
 * tracks under `relDir` (`git ls-files -z` through `./repo` — never a `.git/`
 * read) is hashed from its raw bytes, {@link SNAPSHOT_HASH_CONCURRENCY} at a
 * time. Untracked and ignored files (`node_modules/`, `.next/`, the generated
 * Prisma client, `.env`) are outside the scope by construction; an untracked
 * file the product might leave behind is the guard's `residual-worktree`
 * rule's to catch.
 *
 * @throws {DemoAppError} `snapshot` when git tracks nothing under `relDir` —
 *   a snapshot of nothing would make every later comparison pass vacuously.
 */
export async function snapshotTrackedFilesDetailed(
  relDir: string = DEMO_APP_REL_DIR,
): Promise<DetailedTrackedFileSnapshot> {
  let files: string[];
  try {
    files = await listTrackedFiles(relDir);
  } catch (error) {
    throw new DemoAppError(
      'snapshot',
      `Listing the tracked files under ${relDir} failed: ${messageOf(error)}`,
      {
        cause: error,
      },
    );
  }
  if (files.length === 0) {
    throw new DemoAppError(
      'snapshot',
      `git tracks no file under ${relDir}, so a restoration snapshot would prove nothing: restore the full checkout (\`git sparse-checkout disable\`) or pass a directory git tracks.`,
    );
  }
  const entries = await mapWithConcurrency(files, SNAPSHOT_HASH_CONCURRENCY, digestTrackedPath);
  const snapshot = new Map<string, string>();
  const skipped: { readonly file: string; readonly reason: SnapshotSkipReason }[] = [];
  for (const entry of entries) {
    if ('digest' in entry) {
      snapshot.set(entry.file, entry.digest);
    } else {
      skipped.push(entry);
    }
  }
  return { relDir, snapshot, skipped, tracked: files.length, takenAt: Date.now() };
}

/**
 * The SHA-256 of the raw bytes of every file git tracks under `relDir`
 * (default `apps/demo-app`), keyed by repository-relative POSIX path. Take it
 * before a session; {@link verifyRestored} compares against it afterwards.
 * A tracked path missing from the working tree is left out with a note on
 * stdout (paths only), and reappears as `removed` if the comparison differs.
 */
export async function snapshotTrackedFiles(
  relDir: string = DEMO_APP_REL_DIR,
): Promise<TrackedFileSnapshot> {
  const detailed = await snapshotTrackedFilesDetailed(relDir);
  if (detailed.skipped.length > 0) {
    console.warn(
      `[demo-app] snapshot of ${relDir}: ${String(detailed.skipped.length)} tracked path(s) not hashed:\n${listPaths(
        detailed.skipped.map((entry) => `${entry.file} (${entry.reason})`),
      )}`,
    );
  }
  return detailed.snapshot;
}

/** Compare two snapshots: added, removed and changed paths (each sorted). */
export function diffSnapshots(
  before: TrackedFileSnapshot,
  after: TrackedFileSnapshot,
): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [file, digest] of before) {
    const now = after.get(file);
    if (now === undefined) {
      removed.push(file);
    } else if (now !== digest) {
      changed.push(file);
    } else {
      unchanged += 1;
    }
  }
  for (const file of after.keys()) {
    if (!before.has(file)) {
      added.push(file);
    }
  }
  const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    added: added.sort(byCodeUnit),
    removed: removed.sort(byCodeUnit),
    changed: changed.sort(byCodeUnit),
    unchanged,
  };
}

/** Options of {@link verifyRestored}. */
export interface VerifyRestoredOptions {
  /** The directory the snapshot was taken of; defaults to `apps/demo-app`. */
  readonly relDir?: string | undefined;
  /** A lead for the failure message (for example the session id). */
  readonly message?: string | undefined;
}

/**
 * Recompute the snapshot of `relDir` and require it to equal `snapshot`
 * exactly — the acceptance assertion of AAP §0.8.4 test 3. Three properties
 * are asserted separately, so the failure names the actual problem: the
 * tracked **file set** is unchanged (added / removed paths), every **digest**
 * matches (changed paths), and the **count** matches. The failure lists paths
 * only — never contents, never a diff.
 *
 * @throws {DemoAppError} `not-restored`.
 */
export async function verifyRestored(
  snapshot: TrackedFileSnapshot,
  options: VerifyRestoredOptions = {},
): Promise<RestorationReport> {
  const relDir = options.relDir ?? DEMO_APP_REL_DIR;
  const after = await snapshotTrackedFilesDetailed(relDir);
  const diff = diffSnapshots(snapshot, after.snapshot);
  const sections: string[] = [];
  if (diff.added.length > 0 || diff.removed.length > 0) {
    sections.push(
      [
        `1. The tracked file set changed (${String(diff.added.length)} added, ${String(diff.removed.length)} removed):`,
        ...(diff.added.length > 0 ? ['  added:', listPaths(diff.added)] : []),
        ...(diff.removed.length > 0
          ? ['  removed (or missing from the working tree):', listPaths(diff.removed)]
          : []),
      ].join('\n'),
    );
  }
  if (diff.changed.length > 0) {
    sections.push(
      [
        `2. ${String(diff.changed.length)} file(s) are not byte-identical to the pre-session snapshot:`,
        listPaths(diff.changed),
      ].join('\n'),
    );
  }
  if (snapshot.size !== after.snapshot.size) {
    sections.push(
      `3. The number of hashed tracked files differs: ${String(snapshot.size)} before, ${String(after.snapshot.size)} now.`,
    );
  }
  if (sections.length > 0) {
    const lead = options.message === undefined ? '' : `${options.message}: `;
    throw new DemoAppError(
      'not-restored',
      [
        `${lead}${relDir} is not back in its pre-session state (${String(diff.unchanged)} of ${String(snapshot.size)} files unchanged).`,
        ...sections,
        'Restore it through the product — end the session, or start the local service once so it reconciles open modification records from $DEBUGGEN_HOME — never by hand: a hand edit defeats the hash check cleanup relies on.',
      ].join('\n'),
    );
  }
  return { relDir, compared: snapshot.size, after };
}

// ---------------------------------------------------------------------------
// In-process reuse of the residual-instrumentation guard
// ---------------------------------------------------------------------------

/**
 * One marker occurrence, exactly as the guard script reports it (its
 * `MarkerFinding` typedef).
 */
export interface MarkerFinding {
  /** Repository-relative POSIX path of the offending file. */
  readonly file: string;
  /** 1-based line of the occurrence. */
  readonly line: number;
  /** The literal that matched (`__DEBUGGEN__` or `__DebuggenSpanHelper`). */
  readonly marker: string;
  /** The script's sanitized excerpt of the line (≤ 120 characters, control characters removed). */
  readonly text: string;
}

/**
 * The exports of `scripts/check-no-residual-instrumentation.mjs` this module
 * calls, as that file declares them. `root` is any path inside the
 * repository (the script derives the work-tree root with git); `relDir`
 * defaults to `apps/demo-app` there. `findMarkers` and `worktreeDirty` are
 * synchronous and throw the script's `ResidualCheckError` (codes such as
 * `target-missing`, `target-empty`, `git-missing`) when the check cannot be
 * performed. `main` is the command line: it prints its report on stdout,
 * never calls `process.exit`, and resolves to 0 (clean), 1 (a marker was
 * found or the working tree is dirty) or 2 (usage or environment error).
 */
interface ResidualInstrumentationModule {
  findMarkers(root: string, relDir?: string): MarkerFinding[];
  worktreeDirty(root: string, relDir?: string): boolean;
  main(argv?: readonly string[]): Promise<number>;
}

/** The names {@link ResidualInstrumentationModule} requires. */
const REQUIRED_GUARD_EXPORTS = ['findMarkers', 'worktreeDirty', 'main'] as const;

/** Whether a value is a non-null object (a record we may probe for properties). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The required exports that `loaded` lacks (or that are not functions). */
function missingGuardExports(loaded: unknown): string[] {
  return REQUIRED_GUARD_EXPORTS.filter(
    (name) => !isRecord(loaded) || typeof loaded[name] !== 'function',
  );
}

function isResidualModule(loaded: unknown): loaded is ResidualInstrumentationModule {
  return missingGuardExports(loaded).length === 0;
}

/** The one load of the guard script in this process. */
let residualModule: Promise<ResidualInstrumentationModule> | undefined;

/**
 * Load the guard script with a dynamic `import()` of its `file://` URL,
 * memoised. The computed specifier keeps the `.mjs` out of the `tests`
 * TypeScript project (no `allowJs`, nothing dragged into `tsc -b` or ESLint)
 * while the real script still runs. Importing it runs nothing: the script
 * executes its command line only when it is the process entry point.
 */
function loadResidualModule(): Promise<ResidualInstrumentationModule> {
  if (residualModule !== undefined) {
    return residualModule;
  }
  const attempt = importResidualModule();
  residualModule = attempt;
  attempt.catch(() => {
    if (residualModule === attempt) {
      residualModule = undefined;
    }
  });
  return attempt;
}

async function importResidualModule(): Promise<ResidualInstrumentationModule> {
  const scriptUrl = pathToFileURL(repoPath(RESIDUAL_CHECK_SCRIPT)).href;
  let loaded: unknown;
  try {
    loaded = await import(scriptUrl);
  } catch (error) {
    throw new DemoAppError(
      'residual-check-unavailable',
      `Loading ${RESIDUAL_CHECK_SCRIPT} failed: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (!isResidualModule(loaded)) {
    throw new DemoAppError(
      'residual-check-unavailable',
      `the script's exports changed — update tests/e2e/helpers/demo-app.ts: ${RESIDUAL_CHECK_SCRIPT} must export the functions ${REQUIRED_GUARD_EXPORTS.join(', ')}; missing or not a function: ${missingGuardExports(loaded).join(', ')}.`,
    );
  }
  return loaded;
}

/**
 * Every instrumentation marker in the tracked files under `relDir` (default
 * `apps/demo-app`), as the guard script's own `findMarkers` reports it. The
 * scan reads the working-tree bytes of tracked files, so it also sees a patch
 * applied mid-session. An empty array means the `residual-marker` rule holds.
 *
 * @throws The script's `ResidualCheckError` when the check cannot be performed
 *   (for example `target-empty`), or {@link DemoAppError}
 *   `residual-check-unavailable` when the script cannot be loaded.
 */
export async function findMarkers(
  relDir: string = DEMO_APP_REL_DIR,
): Promise<readonly MarkerFinding[]> {
  const guard = await loadResidualModule();
  return guard.findMarkers(repoRoot(), relDir);
}

/**
 * Whether `relDir` (default `apps/demo-app`) has any uncommitted change —
 * staged, unstaged or untracked — as the guard script's own `worktreeDirty`
 * (`git status --porcelain -- <relDir>`) reports it. `false` means the
 * `residual-worktree` rule holds.
 */
export async function worktreeDirty(relDir: string = DEMO_APP_REL_DIR): Promise<boolean> {
  const guard = await loadResidualModule();
  return guard.worktreeDirty(repoRoot(), relDir);
}

/** Options of {@link runResidualCheck} and {@link expectNoResidualInstrumentation}. */
export interface ResidualCheckOptions {
  /** The repository-relative directory to check; defaults to `apps/demo-app`. */
  readonly relDir?: string | undefined;
  /** A lead for the failure message of {@link expectNoResidualInstrumentation}. */
  readonly message?: string | undefined;
}

/** The guard's verdict, translated from its exit contract and its `--json` report. */
export interface ResidualCheckOutcome {
  /** Exit code 0: both `residual-marker` and `residual-worktree` hold. */
  readonly passed: boolean;
  /** The script's exit code: 0 clean, 1 findings, 2 usage or environment error. */
  readonly exitCode: number;
  /** The directory checked. */
  readonly relDir: string;
  /** The arguments `main` was called with. */
  readonly argv: readonly string[];
  /** `residual-marker` violations. */
  readonly findings: readonly MarkerFinding[];
  /** `residual-worktree` violations (`git status --porcelain` entries). */
  readonly worktreeEntries: readonly string[];
  /** Tracked files under the directory, when the check ran. */
  readonly filesTracked: number | undefined;
  /** Tracked files actually read and searched, when the check ran. */
  readonly filesScanned: number | undefined;
  /** Why the check could not be performed (exit code 2), when it could not. */
  readonly error: { readonly code: string; readonly message: string } | undefined;
  /** The findings in the script's own `path:line:` / `residual-worktree:` line format. */
  readonly lines: readonly string[];
  /** A one-paragraph verdict: the summary line followed by {@link lines}. */
  readonly message: string;
}

/**
 * Temporarily capture everything written to `stream` through its `write`
 * method, restoring the previous property descriptor (an own override, such
 * as Playwright's, or the inherited method) afterwards.
 */
function interceptWrites(stream: NodeJS.WriteStream, sink: string[]): () => void {
  const previous = Object.getOwnPropertyDescriptor(stream, 'write');
  if (previous !== undefined && previous.configurable !== true) {
    throw new DemoAppError(
      'residual-check-unavailable',
      'cannot capture the guard script’s report: process output `write` is not configurable in this runner.',
    );
  }
  const capture = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') {
      sink.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      sink.push(Buffer.from(chunk).toString('utf8'));
    }
    const callback = rest.find((argument) => typeof argument === 'function');
    if (typeof callback === 'function') {
      process.nextTick(() => {
        (callback as () => void)();
      });
    }
    return true;
  };
  Object.defineProperty(stream, 'write', {
    configurable: true,
    enumerable: previous?.enumerable ?? false,
    writable: true,
    value: capture,
  });
  return () => {
    if (previous === undefined) {
      Reflect.deleteProperty(stream, 'write');
    } else {
      Object.defineProperty(stream, 'write', previous);
    }
  };
}

/**
 * Call the guard's `main(argv)` and capture what it prints, so the verdict
 * reaches the caller as data instead of interleaving with the test output.
 * `main` does its work synchronously before its promise settles, and the
 * previous writers are restored as soon as it does.
 */
async function runGuardMain(
  guard: ResidualInstrumentationModule,
  argv: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const restoreStdout = interceptWrites(process.stdout, stdout);
  let restoreStderr: (() => void) | undefined;
  try {
    restoreStderr = interceptWrites(process.stderr, stderr);
    const exitCode = await guard.main(argv);
    return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    restoreStderr?.();
    restoreStdout();
  }
}

/** A `MarkerFinding` from the report, or `undefined` when the shape drifted. */
function toMarkerFinding(value: unknown): MarkerFinding | undefined {
  if (
    isRecord(value) &&
    typeof value.file === 'string' &&
    typeof value.line === 'number' &&
    typeof value.marker === 'string'
  ) {
    return {
      file: value.file,
      line: value.line,
      marker: value.marker,
      text: typeof value.text === 'string' ? value.text : '',
    };
  }
  return undefined;
}

/** The parsed `--json` report, or `undefined` when stdout is not the expected JSON. */
function parseGuardReport(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the guard's command line in process — `main(['--json'])` for the demo,
 * `main(['--json', '--path', relDir])` for any other directory (the fixture
 * app) — and translate its exit contract into a verdict carrying the script's
 * own findings. Never throws for a finding or an environment error; see
 * {@link expectNoResidualInstrumentation} for the asserting form.
 */
export async function runResidualCheck(
  options: ResidualCheckOptions = {},
): Promise<ResidualCheckOutcome> {
  const relDir = options.relDir ?? DEMO_APP_REL_DIR;
  const argv = relDir === DEMO_APP_REL_DIR ? ['--json'] : ['--json', '--path', relDir];
  const guard = await loadResidualModule();
  const run = await runGuardMain(guard, argv);
  const report = parseGuardReport(run.stdout);

  const rawFindings = Array.isArray(report?.findings) ? (report.findings as unknown[]) : [];
  const findings = rawFindings
    .map(toMarkerFinding)
    .filter((finding): finding is MarkerFinding => finding !== undefined);
  const worktree = isRecord(report?.worktree) ? report.worktree : undefined;
  const worktreeEntries = Array.isArray(worktree?.entries)
    ? (worktree.entries as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  const reportError = isRecord(report?.error) ? report.error : undefined;
  const error =
    run.exitCode === 0 || run.exitCode === 1
      ? undefined
      : {
          code: typeof reportError?.code === 'string' ? reportError.code : 'unknown',
          message:
            typeof reportError?.message === 'string'
              ? reportError.message
              : run.stderr.trim() || run.stdout.trim() || 'the script reported no reason',
        };

  const lines = [
    ...findings.map(
      (finding) =>
        `${finding.file}:${String(finding.line)}: residual-marker: found ${finding.marker}`,
    ),
    ...worktreeEntries.map((entry) => `residual-worktree: ${entry}`),
    ...(error === undefined ? [] : [`residual-instrumentation: ${error.code}: ${error.message}`]),
  ];
  const filesTracked = typeof report?.filesTracked === 'number' ? report.filesTracked : undefined;
  const filesScanned = typeof report?.filesScanned === 'number' ? report.filesScanned : undefined;
  const target = typeof report?.target === 'string' ? report.target : relDir;
  const verdict = run.exitCode === 0 ? 'OK' : run.exitCode === 1 ? 'FAIL' : 'ERROR';
  const summary = `residual-instrumentation: ${verdict}: ${target}: exit ${String(run.exitCode)}, ${String(filesScanned ?? 0)} file(s) scanned, ${String(findings.length)} marker finding(s), ${String(worktreeEntries.length)} worktree entr${worktreeEntries.length === 1 ? 'y' : 'ies'}`;
  const drift =
    report === undefined && run.exitCode !== 2
      ? [`(the script's --json report could not be parsed; raw output: ${run.stdout.trim()})`]
      : [];

  return {
    passed: run.exitCode === 0,
    exitCode: run.exitCode,
    relDir,
    argv,
    findings,
    worktreeEntries,
    filesTracked,
    filesScanned,
    error,
    lines,
    message: [summary, ...lines, ...drift].join('\n'),
  };
}

/**
 * Assert both guard rules — `residual-marker` and `residual-worktree` — for
 * `relDir` (default `apps/demo-app`), through the script's `main`. On failure
 * the message carries the script's own `path:line:` findings, which name
 * locations and never file contents.
 *
 * @throws {DemoAppError} `residual-instrumentation` (exit 1) or
 *   `residual-check-unavailable` (exit 2: the check could not be performed,
 *   which is never treated as a pass).
 */
export async function expectNoResidualInstrumentation(
  options: ResidualCheckOptions = {},
): Promise<ResidualCheckOutcome> {
  const outcome = await runResidualCheck(options);
  if (outcome.passed) {
    return outcome;
  }
  const lead = options.message === undefined ? '' : `${options.message}: `;
  if (outcome.exitCode === 1) {
    throw new DemoAppError(
      'residual-instrumentation',
      `${lead}${outcome.relDir} still carries debugging instrumentation or uncommitted changes.\n${outcome.message}\nRestore it through the product (end the session, or start the local service once so it reconciles open modification records) — never by hand.`,
    );
  }
  throw new DemoAppError(
    'residual-check-unavailable',
    `${lead}the residual-instrumentation check could not be performed for ${outcome.relDir}, which is never a pass.\n${outcome.message}`,
  );
}

// ---------------------------------------------------------------------------
// Runtime source lookup (read-only)
// ---------------------------------------------------------------------------

/** Options of {@link sourceLineContaining}. */
export interface SourceLineOptions {
  /** Which matching line to return: 1-based, or `'last'`. Defaults to 1. */
  readonly occurrence?: number | 'last' | undefined;
  /**
   * The absolute directory a relative `file` is resolved against, inside the
   * repository; defaults to the repository root. The {@link DemoAppHandle}
   * passes the demo root, so its `file` is project-relative — the frame of a
   * `SourceLocation.file`.
   */
  readonly relativeTo?: string | undefined;
}

/** A located source line. */
export interface SourceLineMatch {
  /** The file as a POSIX path relative to the base it was resolved against (repository-relative when outside it). */
  readonly file: string;
  /** The file as a repository-relative POSIX path. */
  readonly repoRelativePath: string;
  /** The file's absolute path. */
  readonly absolutePath: string;
  /** The 1-based line number. */
  readonly line: number;
  /** The 1-based column where the match starts. */
  readonly column: number;
  /** The line's text, trimmed. */
  readonly text: string;
  /** Which matching line this is (1-based). */
  readonly occurrence: number;
  /** How many lines match. */
  readonly matches: number;
}

/** A source file read by {@link readDemoSource}. */
export interface DemoSourceText {
  /** The file as a POSIX path relative to the demo root. */
  readonly file: string;
  /** The file's absolute path. */
  readonly absolutePath: string;
  /** The file's text (UTF-8). */
  readonly text: string;
  /** Its lines, without terminators. */
  readonly lines: readonly string[];
}

/** A file resolved for reading: absolute, inside the repository (symlinks resolved), not under `.git`. */
interface ResolvedSourceFile {
  readonly absolutePath: string;
  readonly repoRelativePath: string;
  readonly baseRelativePath: string;
}

/**
 * Resolve `file` against `base` and prove it stays inside the repository —
 * before and after resolving symbolic links — and outside `.git`.
 */
async function resolveSourceFile(
  file: string,
  base: string,
  label: string,
): Promise<ResolvedSourceFile> {
  if (file.trim() === '') {
    throw new DemoAppError('source', `${label}: the file name is empty.`);
  }
  if (!path.isAbsolute(base)) {
    throw new DemoAppError('source', `${label}: relativeTo must be absolute, got ${base}.`);
  }
  const root = repoRoot();
  const candidate = path.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(base, ...file.split('/'));
  const lexical = path.relative(root, candidate);
  if (!isInside(lexical) || hasGitSegment(toPosix(lexical))) {
    throw new DemoAppError(
      'source',
      `${label}: ${file} does not name a file inside the repository (outside .git).`,
    );
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    throw new DemoAppError(
      'source',
      `${label}: ${toPosix(lexical)} cannot be read: ${messageOf(error)}`,
      {
        cause: error,
      },
    );
  }
  const resolved = path.relative(root, real);
  if (!isInside(resolved) || hasGitSegment(toPosix(resolved))) {
    throw new DemoAppError(
      'source',
      `${label}: ${toPosix(lexical)} resolves outside the repository (or into .git) through a symbolic link.`,
    );
  }
  const fromBase = path.relative(base, candidate);
  return {
    absolutePath: candidate,
    repoRelativePath: toPosix(lexical),
    baseRelativePath: isInside(fromBase) ? toPosix(fromBase) : toPosix(lexical),
  };
}

/** Read a resolved file as UTF-8, bounded by {@link MAX_SOURCE_BYTES}. Read-only. */
async function readBoundedText(resolved: ResolvedSourceFile, label: string): Promise<string> {
  let size: number;
  try {
    const stats = await stat(resolved.absolutePath);
    if (!stats.isFile()) {
      throw new Error('not a regular file');
    }
    size = stats.size;
  } catch (error) {
    throw new DemoAppError(
      'source',
      `${label}: ${resolved.repoRelativePath} cannot be read: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (size > MAX_SOURCE_BYTES) {
    throw new DemoAppError(
      'source',
      `${label}: ${resolved.repoRelativePath} is ${String(size)} bytes, above the ${String(MAX_SOURCE_BYTES)}-byte bound for source lookups.`,
    );
  }
  const text = await readFile(resolved.absolutePath, { encoding: 'utf8', flag: 'r' });
  // A byte-order mark is part of the bytes (and of the snapshot digest) but
  // not of the first line's columns.
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/** A needle as a line matcher returning the 0-based column of the match, or -1. */
function lineMatcher(needle: string | RegExp): (line: string) => number {
  if (typeof needle === 'string') {
    return (line) => line.indexOf(needle);
  }
  // Without `g` / `y`, `exec` keeps no `lastIndex` state between lines.
  const pattern = new RegExp(needle.source, needle.flags.replace(/[gy]/g, ''));
  return (line) => pattern.exec(line)?.index ?? -1;
}

/** A needle for a failure message. */
function describeNeedle(needle: string | RegExp): string {
  return typeof needle === 'string' ? JSON.stringify(needle) : String(needle);
}

/**
 * Line numbers that nearly match: lines containing the needle's longest
 * identifier-like token, case-insensitively. Bounded; line numbers only.
 */
function nearMissLines(
  lines: readonly string[],
  needle: string | RegExp,
): { token: string; lines: number[] } {
  const source = typeof needle === 'string' ? needle : needle.source;
  const tokens = source.match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
  const token = tokens.reduce(
    (best, candidate) => (candidate.length > best.length ? candidate : best),
    '',
  );
  if (token === '') {
    return { token, lines: [] };
  }
  const lowered = token.toLowerCase();
  const hits: number[] = [];
  for (let index = 0; index < lines.length && hits.length < MAX_NEAR_MISS_LINES; index += 1) {
    if ((lines[index] ?? '').toLowerCase().includes(lowered)) {
      hits.push(index + 1);
    }
  }
  return { token, lines: hits };
}

/**
 * The 1-based line (and column) of the `occurrence`-th line of `file` that
 * contains `needle` — a substring, or a pattern (its `g` / `y` flags are
 * ignored). `file` is resolved against `options.relativeTo` (default: the
 * repository root; an absolute path is accepted) and must stay inside the
 * repository. The file is only read.
 *
 * This is how a spec asserts a `source.open` location — the `pool.query` call
 * site behind the slow checkout — without hard-coding a line number.
 *
 * @throws {DemoAppError} `source`, naming the file, the needle, the number of
 *   lines searched and (bounded) the line numbers of near misses.
 */
export async function sourceLineContaining(
  file: string,
  needle: string | RegExp,
  options: SourceLineOptions = {},
): Promise<SourceLineMatch> {
  const label = 'sourceLineContaining';
  if (needle === '') {
    throw new DemoAppError('source', `${label}: the needle is empty.`);
  }
  const occurrence = options.occurrence ?? 1;
  if (occurrence !== 'last' && (!Number.isInteger(occurrence) || occurrence < 1)) {
    throw new DemoAppError(
      'source',
      `${label}: occurrence must be a positive integer or 'last', got ${String(occurrence)}.`,
    );
  }
  const resolved = await resolveSourceFile(file, options.relativeTo ?? repoRoot(), label);
  const lines = (await readBoundedText(resolved, label)).split(/\r?\n/);
  const match = lineMatcher(needle);

  const hits: { readonly line: number; readonly column: number; readonly text: string }[] = [];
  lines.forEach((text, index) => {
    const column = match(text);
    if (column >= 0) {
      hits.push({ line: index + 1, column: column + 1, text: text.trim() });
    }
  });

  if (hits.length === 0) {
    const near = nearMissLines(lines, needle);
    const hint =
      near.lines.length > 0
        ? ` Lines mentioning ${JSON.stringify(near.token)} (case-insensitive): ${near.lines.join(', ')}.`
        : '';
    throw new DemoAppError(
      'source',
      `${label}: no line of ${resolved.repoRelativePath} (${String(lines.length)} lines searched) contains ${describeNeedle(needle)}.${hint}`,
    );
  }
  const index = occurrence === 'last' ? hits.length - 1 : occurrence - 1;
  const hit = hits[index];
  if (hit === undefined) {
    throw new DemoAppError(
      'source',
      `${label}: occurrence ${String(occurrence)} of ${describeNeedle(needle)} was requested in ${resolved.repoRelativePath}, but only ${String(hits.length)} line(s) match: ${hits.map((entry) => entry.line).join(', ')}.`,
    );
  }
  return {
    file: resolved.baseRelativePath,
    repoRelativePath: resolved.repoRelativePath,
    absolutePath: resolved.absolutePath,
    line: hit.line,
    column: hit.column,
    text: hit.text,
    occurrence: index + 1,
    matches: hits.length,
  };
}

/**
 * Read one demo source file — a POSIX path relative to the demo root, such as
 * `src/server/services/inventory.service.ts` — as text and lines, bounded and
 * read-only. Mirrors `tests/browser/fixtures.ts`'s `readFixtureSource`, so no
 * spec reaches for `node:fs` itself.
 *
 * @throws {DemoAppError} `source` when the path leaves the demo or cannot be read.
 */
export async function readDemoSource(file: string): Promise<DemoSourceText> {
  const label = 'readDemoSource';
  const root = demoRoot();
  const resolved = await resolveSourceFile(file, root, label);
  if (!isInside(path.relative(root, resolved.absolutePath))) {
    throw new DemoAppError(
      'source',
      `${label}: ${file} does not name a file inside ${DEMO_APP_REL_DIR}.`,
    );
  }
  const text = await readBoundedText(resolved, label);
  return {
    file: resolved.baseRelativePath,
    absolutePath: resolved.absolutePath,
    text,
    lines: text.split(/\r?\n/),
  };
}

/**
 * The SHA-256 of the raw bytes of one demo file (a POSIX path relative to the
 * demo root, the frame of `ModificationRecord.file`) — for comparing a file's
 * current state against a record's `originalHash` / `instrumentedHash`.
 *
 * @throws {DemoAppError} `source` when the path leaves the demo or cannot be read.
 */
export async function sha256OfDemoFile(file: string): Promise<string> {
  const label = 'sha256OfDemoFile';
  const root = demoRoot();
  const resolved = await resolveSourceFile(file, root, label);
  if (!isInside(path.relative(root, resolved.absolutePath))) {
    throw new DemoAppError(
      'source',
      `${label}: ${file} does not name a file inside ${DEMO_APP_REL_DIR}.`,
    );
  }
  try {
    return await sha256OfFile(resolved.absolutePath);
  } catch (error) {
    throw new DemoAppError(
      'source',
      `${label}: ${resolved.repoRelativePath} cannot be hashed: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// The DemoAppHandle
// ---------------------------------------------------------------------------

/** Options of {@link createDemoAppHandle}; they become the defaults of its `start()`. */
export interface DemoAppHandleOptions {
  /** See {@link StartDemoAppOptions.command}; leave it unset. */
  readonly command?: string | undefined;
  /** See {@link StartDemoAppOptions.timeoutMs}. */
  readonly launchTimeoutMs?: number | undefined;
  /** See {@link StartDemoAppOptions.readyTimeoutMs}. */
  readonly readyTimeoutMs?: number | undefined;
}

/**
 * Everything a spec needs about the demo, bound to one service: the worker
 * fixture `demoApp`. Re-entrant: `start()` twice asks the launcher again,
 * which reuses its one child per project root (`reused: true`); `stop()` twice
 * answers `stopped: false`; the database is prepared once per process.
 */
export interface DemoAppHandle {
  /** The demo's absolute project root. */
  readonly projectRoot: string;
  /** The demo's repository-relative directory (`apps/demo-app`). */
  readonly relDir: string;
  /** The origin the suite opens the demo at ({@link demoBaseUrl}). */
  readonly baseUrl: string;
  /** The current launch record, or `undefined` before `start()` / after `stop()`. */
  readonly launch: DemoAppLaunch | undefined;
  /** {@link assertDemoPrerequisites}. */
  assertPrerequisites(): Promise<DemoPrerequisites>;
  /** {@link ensureDemoDatabase}. */
  ensureDatabase(options?: EnsureDemoDatabaseOptions): Promise<DemoDatabaseState>;
  /** {@link startDemoApp} with this handle's defaults; serialised with `stop()`. */
  start(options?: StartDemoAppOptions): Promise<DemoAppLaunch>;
  /** {@link stopDemoApp}; idempotent and serialised with `start()`. */
  stop(): Promise<DemoAppStopResult>;
  /** {@link expectPreloadAttached} over the current launch. */
  expectPreloadAttached(): DemoAppLaunch;
  /** {@link isServing} against {@link baseUrl}. */
  isServing(options?: ServingProbeOptions): Promise<boolean>;
  /** {@link expectServing} against {@link baseUrl}. */
  expectServing(options?: ServingProbeOptions): Promise<ServingProbeResult>;
  /** {@link snapshotTrackedFiles} of the demo. */
  snapshotTrackedFiles(): Promise<TrackedFileSnapshot>;
  /** {@link verifyRestored} against the demo. */
  verifyRestored(
    snapshot: TrackedFileSnapshot,
    options?: Omit<VerifyRestoredOptions, 'relDir'>,
  ): Promise<RestorationReport>;
  /** {@link findMarkers} for the demo. */
  findMarkers(): Promise<readonly MarkerFinding[]>;
  /** {@link worktreeDirty} for the demo. */
  worktreeDirty(): Promise<boolean>;
  /** {@link runResidualCheck} for the demo. */
  runResidualCheck(): Promise<ResidualCheckOutcome>;
  /** {@link expectNoResidualInstrumentation} for the demo. */
  expectNoResidualInstrumentation(
    options?: Omit<ResidualCheckOptions, 'relDir'>,
  ): Promise<ResidualCheckOutcome>;
  /** {@link sourceLineContaining}, resolving `file` against the demo root unless `relativeTo` says otherwise. */
  sourceLineContaining(
    file: string,
    needle: string | RegExp,
    options?: SourceLineOptions,
  ): Promise<SourceLineMatch>;
  /** {@link readDemoSource}. */
  readSource(file: string): Promise<DemoSourceText>;
  /** {@link sha256OfDemoFile}. */
  hashFile(file: string): Promise<string>;
}

/**
 * Bundle the demo's lifecycle, restoration contract, residual check and source
 * lookup into one {@link DemoAppHandle} bound to `service`. Creating it does
 * no work beyond resolving the demo root and URL; every operation is lazy.
 */
export function createDemoAppHandle(
  service: ServiceHandle,
  options: DemoAppHandleOptions = {},
): DemoAppHandle {
  const projectRoot = demoRoot();
  const baseUrl = demoBaseUrl();
  // start() and stop() run one at a time, in call order, so a teardown stop
  // never races a launch still in flight.
  let lifecycle: Promise<unknown> = Promise.resolve();
  const serialise = <T>(step: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(step, step);
    lifecycle = result.catch(() => undefined);
    return result;
  };

  return {
    projectRoot,
    relDir: DEMO_APP_REL_DIR,
    baseUrl,
    get launch(): DemoAppLaunch | undefined {
      return launches.get(projectRoot);
    },
    assertPrerequisites: () => assertDemoPrerequisites(),
    ensureDatabase: (databaseOptions) => ensureDemoDatabase(databaseOptions),
    start: (startOptions = {}) =>
      serialise(() =>
        startDemoApp(service, {
          command: startOptions.command ?? options.command,
          timeoutMs: startOptions.timeoutMs ?? options.launchTimeoutMs,
          readyTimeoutMs: startOptions.readyTimeoutMs ?? options.readyTimeoutMs,
          assertPreload: startOptions.assertPreload,
        }),
      ),
    stop: () => serialise(() => stopDemoApp(service, launches.get(projectRoot))),
    expectPreloadAttached: () => {
      const current = launches.get(projectRoot);
      if (current === undefined) {
        throw new DemoAppError(
          'preload-not-attached',
          'The demo has not been started through POST /dev-server/launch in this process (call start() first), so no launch can be judged.',
        );
      }
      return expectPreloadAttached(current);
    },
    isServing: (probeOptions = {}) =>
      isServing({ ...probeOptions, baseUrl: probeOptions.baseUrl ?? baseUrl }),
    expectServing: (probeOptions = {}) =>
      expectServing({ ...probeOptions, baseUrl: probeOptions.baseUrl ?? baseUrl }),
    snapshotTrackedFiles: () => snapshotTrackedFiles(DEMO_APP_REL_DIR),
    verifyRestored: (snapshot, verifyOptions = {}) =>
      verifyRestored(snapshot, { ...verifyOptions, relDir: DEMO_APP_REL_DIR }),
    findMarkers: () => findMarkers(DEMO_APP_REL_DIR),
    worktreeDirty: () => worktreeDirty(DEMO_APP_REL_DIR),
    runResidualCheck: () => runResidualCheck({ relDir: DEMO_APP_REL_DIR }),
    expectNoResidualInstrumentation: (checkOptions = {}) =>
      expectNoResidualInstrumentation({ ...checkOptions, relDir: DEMO_APP_REL_DIR }),
    sourceLineContaining: (file, needle, lookupOptions = {}) =>
      sourceLineContaining(file, needle, {
        ...lookupOptions,
        relativeTo: lookupOptions.relativeTo ?? projectRoot,
      }),
    readSource: (file) => readDemoSource(file),
    hashFile: (file) => sha256OfDemoFile(file),
  };
}
