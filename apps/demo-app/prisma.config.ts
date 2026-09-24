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
// The scripts in this workspace's package.json map onto the keys below:
//   generate / prebuild / pretypecheck  ->  `schema`
//   migrate (`prisma migrate deploy`)   ->  `schema` + `datasource` + `migrations.path`
//   seed    (`prisma db seed`)          ->  `migrations.seed`
//   check:migration (`prisma migrate diff --from-empty --to-schema --script`,
//                    the `premigrate` regression check)
//                                       ->  `schema` + `datasource`
//
// That check pipes the SQL rendered from the schema into
// prisma/check-migrations.ts, which replays every committed migration in order
// and requires the two to create exactly the same schema objects. The history
// is incremental — 0001_init is the applied baseline and later migrations add
// to it, as `migrate:dev` writes them — so an applied migration is never edited
// and `prisma migrate deploy` brings an existing database forward. The replay
// needs no database and covers the additive statements Prisma writes; a
// migration that drops or alters something is refused by it and verified
// against a live database through `--from-config-datasource` instead.
// ---------------------------------------------------------------------------

import { defineConfig, env } from 'prisma/config';

/**
 * The one environment variable this workspace reads. It is named once and reused
 * for both the presence probe and the `env()` lookup below so the two can never
 * drift apart. Its value belongs in the environment or in a git-ignored `.env`
 * file — `.env.example` holds the local Docker Compose development URL to copy,
 * and no credential is ever written into this file. The one URL literal here is
 * {@link OFFLINE_DIFF_DATASOURCE_URL}, which carries none and reaches nothing.
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
 * it), so `env()` is reached only where a URL really is required, which is what
 * {@link resolveDatasource} below decides. A blank or whitespace-only value
 * counts as absent: it cannot produce a valid URL, and treating it as unset
 * yields Prisma's actionable "the datasource.url property is required" message
 * instead of a parse error.
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

/**
 * The connection URL handed to a fully offline `prisma migrate diff` when
 * `DATABASE_URL` is absent.
 *
 * `migrate diff` is a schema-engine command, and the engine needs a datasource
 * *dialect* even for a diff whose two endpoints are both offline — an empty
 * datamodel, a `.prisma` file, a migrations directory. Without one it renders
 * nothing: `prisma migrate diff --from-empty --to-schema prisma/schema.prisma
 * --script` exits 0 and writes zero bytes, so the documented way of
 * regenerating a migration (redirecting that output into
 * `prisma/migrations/0001_init/migration.sql`) truncates the migration to
 * nothing and still reports success. Measured on prisma 7.10.0: 0 bytes with no
 * datasource, 9192 bytes of DDL with one. Contributing this URL is what turns
 * that silent truncation into the complete script.
 *
 * It is dialled by nothing. Those endpoints open no connection — `migrate diff`
 * is read-only and reads a live database only through
 * `--from-config-datasource` / `--to-config-datasource`, which are excluded
 * below — and the URL could not connect if it were: port 1 (`tcpmux`) is not
 * where PostgreSQL listens, and 127.0.0.1 leaves the machine's loopback.
 *
 * It carries no credential, which is the point of the shape chosen: no user, no
 * password, no real host, no real database. This file's authoring checklist says
 * "grep for `postgresql://` -> zero matches" for the stated reason "never inline
 * a credential"; that reason is honoured here even though the grep now answers
 * once, and `pnpm check:secrets` agrees — its `connection-string` rule requires
 * an embedded `user:password@` and its entropy rule requires a key-like name.
 * The CI workflow of AAP 0.7.1 Group 0 puts a credential-free
 * `postgresql://localhost:5432/placeholder` in the `verify` job environment for
 * exactly the same purpose.
 */
const OFFLINE_DIFF_DATASOURCE_URL = 'postgresql://127.0.0.1:1/lumen_supply_schema_diff_placeholder';

/**
 * The one CLI command that is given the placeholder above: `prisma migrate
 * diff`. Compared against the first two positional arguments, joined by a
 * space, as {@link invokedCommandName} returns them.
 */
const MIGRATE_DIFF_COMMAND = 'migrate diff';

/**
 * Flags that may appear *before* the command and consume the following argv
 * token as their value, so that {@link invokedCommandName} does not mistake
 * that value for the command.
 *
 * `--config <path>` is the only one: it is how the CLI is pointed at this file
 * from the repository root (`prisma --config apps/demo-app/prisma.config.ts
 * migrate diff …`), and prisma 7.10.0 accepts its value as a separate token.
 * The `--config=<path>` spelling needs no entry — it starts with `-` and is
 * skipped as a flag. Every other flag of `migrate diff` (`--from-…`, `--to-…`,
 * `--script`, `-o`) can only follow the command and subcommand, by which point
 * both positionals have already been read.
 */
const VALUE_TAKING_GLOBAL_FLAGS = new Set(['--config']);

/**
 * The `migrate diff` endpoints that read the datasource of this config, and
 * therefore must never be handed a placeholder: substituting one would turn a
 * missing-URL report into a connection failure against an address the developer
 * never configured.
 */
const CONFIG_DATASOURCE_DIFF_FLAGS = ['--from-config-datasource', '--to-config-datasource'];

/**
 * The command the CLI was invoked with, as its first two positional arguments
 * joined by a space — `'migrate diff'`, `'generate'`, `'db seed'`, `''` when
 * the CLI was given no command at all.
 *
 * Every Prisma command loads this config module in the CLI's own process, so
 * `process.argv` here is the CLI's argv (verified: `[node,
 * …/prisma/build/index.js, 'migrate', 'diff', '--from-empty', …]`). The command
 * and subcommand are always the first two positionals, and reading them
 * positionally rather than searching for the words means a path or flag value
 * that happens to read `migrate` cannot be mistaken for the command.
 *
 * @returns The invoked command name, possibly empty, never `undefined`.
 */
function invokedCommandName(): string {
  const positional: string[] = [];
  let skipValueOfPreviousFlag = false;
  for (const argument of process.argv.slice(2)) {
    if (positional.length === 2) {
      break;
    }
    if (skipValueOfPreviousFlag) {
      skipValueOfPreviousFlag = false;
      continue;
    }
    if (argument.startsWith('-')) {
      skipValueOfPreviousFlag = VALUE_TAKING_GLOBAL_FLAGS.has(argument);
      continue;
    }
    positional.push(argument);
  }
  return positional.join(' ');
}

/**
 * Whether the invocation names this config's datasource as a diff endpoint,
 * i.e. whether it intends to read a live database.
 *
 * Both the bare flag and a `--from-config-datasource=…` spelling are matched,
 * so a future CLI that accepts an explicit value cannot slip past the check.
 *
 * @returns `true` when `--from-config-datasource` or `--to-config-datasource`
 * is present.
 */
function namesConfigDatasource(): boolean {
  return process.argv
    .slice(2)
    .some((argument) =>
      CONFIG_DATASOURCE_DIFF_FLAGS.some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
    );
}

/**
 * The `datasource` object for this invocation, or `undefined` when the key must
 * be absent altogether.
 *
 * Three cases, in order:
 *
 *  1. `DATABASE_URL` is set — every command gets
 *     `{ url: env('DATABASE_URL') }`, the shape AAP 0.3.4 and 0.7.1 Group 5
 *     prescribe. The value is always read through `env()`, the accessor the CLI
 *     expects, and never through `process.env`.
 *  2. No `DATABASE_URL`, and the command is `prisma migrate diff`:
 *     - naming a config datasource (`--from-config-datasource` /
 *       `--to-config-datasource`) means a live database is required, so
 *       `env()` is called and its `PrismaConfigEnvError` aborts the command
 *       with exit 1 naming `DATABASE_URL`. That is deliberate: with no
 *       datasource key at all, prisma 7.10.0 answers this invocation with exit
 *       0 and zero bytes, which is the same silent success this file exists to
 *       prevent, and a placeholder would only report a connection error against
 *       port 1 instead of the missing variable.
 *     - otherwise both endpoints are offline and
 *       {@link OFFLINE_DIFF_DATASOURCE_URL} supplies the dialect, so the full
 *       DDL is rendered. `--from-migrations` lands here too and fails loudly and
 *       correctly ("You must set `datasource.shadowDatabaseUrl`…") rather than
 *       succeeding empty.
 *  3. No `DATABASE_URL`, any other command — no `datasource` key. This is what
 *     keeps `generate`, `validate` and `format` working on a clean clone with no
 *     database (`prisma generate` is this workspace's `prebuild` and
 *     `pretypecheck` step), and what lets connecting commands report the missing
 *     datasource in their own words: `prisma migrate deploy` answers "The
 *     datasource.url property is required in your Prisma config file when using
 *     prisma migrate deploy."
 *
 * @returns The datasource to contribute, or `undefined` to contribute none.
 * @throws `PrismaConfigEnvError` from `env()` when a `migrate diff` invocation
 * needs a live datasource that the environment does not provide.
 */
function resolveDatasource(): { readonly url: string } | undefined {
  if (hasDatabaseUrl()) {
    return { url: env(DATABASE_URL_VAR) };
  }
  if (invokedCommandName() !== MIGRATE_DIFF_COMMAND) {
    return undefined;
  }
  if (namesConfigDatasource()) {
    return { url: env(DATABASE_URL_VAR) };
  }
  return { url: OFFLINE_DIFF_DATASOURCE_URL };
}

loadLocalEnvFile();

/**
 * Decided after `loadLocalEnvFile()`, so a local `.env` counts as configured,
 * and before `defineConfig` so the object below stays declarative.
 */
const datasource = resolveDatasource();

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
  // value is still a present key, and `exactOptionalPropertyTypes` rejects it.
  // `resolveDatasource()` above decides which of the three cases applies — a
  // configured URL, the offline `migrate diff` placeholder, or no key at all.
  ...(datasource === undefined ? {} : { datasource }),
});
