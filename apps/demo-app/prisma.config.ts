// ---------------------------------------------------------------------------
// Prisma CLI configuration for "Lumen Supply" (apps/demo-app).
//
// Prisma 7 made this file the single place the CLI looks for project settings:
// the `prisma` block of package.json was removed, and `url = env("DATABASE_URL")`
// is no longer accepted inside schema.prisma's `datasource` block (the schema
// there declares only `provider`, and stating a `url` fails with P1012). So the
// schema path, the migrations directory, the seed command and the connection URL
// all live here, and `prisma generate`, `prisma migrate deploy`, `prisma migrate
// dev` and `prisma db seed` are all driven by the object exported below.
//
// Every relative path is resolved against THIS file's directory, not the shell's
// working directory, so the values are written as they appear from
// apps/demo-app/ — `prisma/schema.prisma`, not `apps/demo-app/prisma/...`.
//
// The three scripts in this workspace's package.json map onto the keys below:
//   generate / prebuild / pretypecheck  ->  `schema`
//   migrate (`prisma migrate deploy`)   ->  `schema` + `datasource` + `migrations.path`
//   seed    (`prisma db seed`)          ->  `migrations.seed`
// ---------------------------------------------------------------------------

import { defineConfig, env } from 'prisma/config';

/**
 * The one environment variable this workspace reads. It is named once and reused
 * for both the presence probe and the `env()` lookup below so the two can never
 * drift apart. Its value belongs in the environment or in a git-ignored `.env`
 * file — `.env.example` holds the local Docker Compose development URL to copy,
 * and no connection string is ever written into this file.
 */
const DATABASE_URL_VAR = 'DATABASE_URL';

/**
 * The optional, git-ignored `apps/demo-app/.env`, addressed relative to this
 * module rather than to `process.cwd()`. That keeps the lookup correct whether
 * the CLI is invoked through this workspace's own scripts (working directory
 * apps/demo-app) or from the repository root with an explicit
 * `--config apps/demo-app/prisma.config.ts`.
 */
const LOCAL_ENV_FILE = new URL('.env', import.meta.url);

/**
 * Whether a thrown value is Node's "the file is not there" error.
 *
 * `process.loadEnvFile()` rejects a missing file with a plain `Error` carrying
 * `code: 'ENOENT'`; anything else — a path that turns out to be a directory
 * (`ERR_INVALID_ARG_TYPE`), an unreadable file (`EACCES`), a parse failure — is a
 * real misconfiguration and must not be swallowed. The check is written as a
 * guard over `unknown` because `strict` gives catch clauses that type, and no
 * `any` or type assertion is needed: `'code' in error` narrows the object well
 * enough to read the property.
 *
 * @param error The value caught from `process.loadEnvFile()`.
 * @returns `true` only for a missing-file error.
 */
function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'ENOENT';
}

/**
 * Load `apps/demo-app/.env` into `process.env` when it exists.
 *
 * Prisma 7 no longer reads `.env` files on the CLI's behalf, and this workspace
 * deliberately carries no `dotenv` dependency, so Node's built-in loader does the
 * job (`process.loadEnvFile`, available since Node 20.12; this repository pins
 * Node 24.21.0). Variables already present in the environment win over the file,
 * which is what lets CI supply `DATABASE_URL` through the job environment while a
 * developer's local `.env` stays authoritative on their machine.
 *
 * A missing file is normal — a fresh clone has none, and `prisma generate` needs
 * no database at all — so it is ignored rather than reported.
 */
function loadLocalEnvFile(): void {
  try {
    process.loadEnvFile(LOCAL_ENV_FILE);
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

/**
 * Whether the environment actually carries a usable connection URL.
 *
 * `env()` throws `PrismaConfigEnvError` for an unset *or* empty variable, and
 * that throw happens while the config module is being evaluated — which aborts
 * every command, including the ones that never touch a database. `prisma
 * generate` runs on a clean clone (it is this workspace's `prebuild` and
 * `pretypecheck` step, and the root `pnpm build` / `pnpm typecheck` start with
 * it), so the `datasource` key is contributed only when there is something to put
 * in it. A blank or whitespace-only value counts as absent: it cannot produce a
 * valid URL, and treating it as unset yields Prisma's actionable "the
 * datasource.url property is required" message instead of a parse error.
 *
 * This is a presence probe only. The value handed to Prisma always comes from
 * `env()`, which is the accessor the CLI expects, and is never read, defaulted or
 * logged here.
 *
 * @returns `true` when `DATABASE_URL` holds a non-blank value.
 */
function hasDatabaseUrl(): boolean {
  const configured = process.env[DATABASE_URL_VAR];
  return typeof configured === 'string' && configured.trim() !== '';
}

loadLocalEnvFile();

export default defineConfig({
  // Single-file schema. The `prisma-client` generator inside it owns the output
  // location of the generated client, so no generator settings appear here.
  schema: 'prisma/schema.prisma',
  migrations: {
    // Committed SQL migrations. `prisma migrate deploy` applies them idempotently
    // and writes nothing back into the worktree, which is what keeps `git status
    // --porcelain -- apps/demo-app` clean after the demo database is prepared.
    path: 'prisma/migrations',
    // Run verbatim by `prisma db seed` (this workspace's `seed` script), which
    // resolves `tsx` from the local node_modules/.bin that the package manager
    // puts on PATH. `seed` belongs to the migrations config in Prisma 7 — a
    // top-level key here is a type error, whatever some examples still show.
    seed: 'tsx prisma/seed.ts',
  },
  // Spread rather than a `datasource: undefined` key: an explicitly undefined
  // value is still a present key, and `env()` must not be called at all when the
  // variable is missing. With a URL configured this is exactly
  // `datasource: { url: env('DATABASE_URL') }`; without one the key is absent and
  // schema-only commands keep working, while migration and introspection commands
  // report the missing datasource themselves.
  ...(hasDatabaseUrl() ? { datasource: { url: env(DATABASE_URL_VAR) } } : {}),
});
