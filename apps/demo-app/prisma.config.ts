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
// That check is prisma/check-migrations.ts, which runs `prisma migrate diff
// --from-empty --to-schema prisma/schema.prisma --script` itself — spawned as
// `node <prisma>/build/index.js …`, through no shell, with DATABASE_URL present
// but blank, so this file hands the diff the offline placeholder below whatever
// the environment or `.env` holds — then replays every committed migration in
// order and requires the two to create exactly the same schema objects. The
// history is incremental — 0001_init is the applied baseline and later
// migrations add to it, as `migrate:dev` writes them — so an applied migration
// is never edited and `prisma migrate deploy` brings an existing database
// forward. The replay needs no database and covers the additive statements
// Prisma writes; a migration that drops or alters something is refused by it
// and verified against a live database through `--from-config-datasource`
// instead.
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
 * yields this file's actionable "DATABASE_URL is not set" message for a command
 * that needs a database, instead of a parse error.
 *
 * This is a presence probe only: the value is inspected here solely to see
 * whether it is non-blank. The connection value handed to Prisma always comes
 * from `env()`, which is the accessor the CLI expects, and it is never defaulted
 * or logged here.
 *
 * @returns `true` when `DATABASE_URL` holds a non-blank value.
 */
function hasDatabaseUrl(): boolean {
  const configured = process.env[DATABASE_URL_VAR];
  return typeof configured === 'string' && configured.trim() !== '';
}

/**
 * The connection URL handed to a fully offline `prisma migrate diff`: supplied
 * only when `DATABASE_URL` is absent (unset or blank) and neither
 * `--from-config-datasource` nor `--to-config-datasource` is named.
 *
 * `migrate diff` is a schema-engine command, and the engine needs a datasource
 * *dialect* even for a diff whose two endpoints are both offline — an empty
 * datamodel, a `.prisma` file, a migrations directory. Without one it renders
 * nothing: `prisma migrate diff --from-empty --to-schema prisma/schema.prisma
 * --script` exits 0 and writes zero bytes, so redirecting that output into a
 * migration file silently truncates the file. This URL supplies the dialect,
 * and the complete DDL script is rendered.
 *
 * It is never dialled: offline endpoints open no connection, and `migrate diff`
 * reads a live database only through the config-datasource endpoints, which are
 * never given it. Nor could it connect if it were: port 1 on the loopback
 * address is not where PostgreSQL listens, and loopback traffic never leaves
 * the machine. It carries no credential — no user, no password — and names only
 * a placeholder database.
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
 * The commands that open a connection to the database `DATABASE_URL` names,
 * written as {@link invokedCommandName} returns them. Without a URL, each is
 * refused by {@link resolveDatasource} with a message naming the variable and
 * the setup step, rather than left to Prisma's "The datasource.url property is
 * required in your Prisma config file when using prisma migrate deploy.", which
 * names neither.
 *
 * `studio` is a one-word command whose `--port` and `--browser` values can
 * follow it as a second positional (`prisma studio --port 5555` reads as
 * `'studio 5555'`), so an entry matches the command itself or the command
 * followed by further words. `db seed` is deliberately absent: the seed script
 * checks the variable itself and prints the full setup sequence. So is
 * `migrate diff`, whose live endpoints {@link namesConfigDatasource} recognises
 * instead.
 */
const CONNECTING_COMMANDS = [
  'migrate deploy',
  'migrate dev',
  'migrate status',
  'migrate reset',
  'migrate resolve',
  'db push',
  'db pull',
  'db execute',
  'studio',
];

/**
 * The flags that ask a command for its usage text. Help opens no connection,
 * so an invocation carrying one is never refused for a missing URL.
 */
const HELP_FLAGS = ['--help', '-h'];

/**
 * The flag with which prisma 7.10.0's `migrate dev`, `db push`, `db pull` and
 * `studio` take a connection string on the command line ("Override the
 * datasource URL from the Prisma config file"). Such an invocation has its
 * connection without `DATABASE_URL`, so it is left to Prisma. `migrate diff`
 * has no such flag: its live endpoints read only this config's datasource.
 */
const URL_OVERRIDE_FLAGS = ['--url'];

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
 * Whether any of `flags` appears among the CLI's arguments, either bare
 * (`--url`) or in its `--flag=value` spelling (`--url=…`), so a value attached
 * with `=` cannot slip past the check.
 *
 * @param flags The flag spellings to look for.
 * @returns `true` when at least one of them was passed.
 */
function flagged(flags: readonly string[]): boolean {
  return process.argv
    .slice(2)
    .some((argument) => flags.some((flag) => argument === flag || argument.startsWith(`${flag}=`)));
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
  return flagged(CONFIG_DATASOURCE_DIFF_FLAGS);
}

/**
 * The error that refuses a command needing a database while `DATABASE_URL` is
 * absent, worded as `prisma/seed.ts` reports the same missing variable for
 * `prisma db seed`.
 *
 * Thrown while this module is evaluated, it reaches the developer through the
 * CLI's `Failed to load config file "…" as a TypeScript/JavaScript module.
 * Error: …` report, and the command exits 1 before it opens anything. Only the
 * variable's name appears: no connection string is printed, defaulted or
 * suggested here — `.env.example` carries the local development one.
 *
 * The CLI prints the error as `String(error)`, i.e. `<name>: <message>`, after
 * its own `Error: `. The name is therefore set to the same kind of source
 * prefix the seed script writes (`lumen-supply seed: …`), which reads as
 * `Error: lumen-supply config: prisma migrate deploy needs …` instead of the
 * doubled `Error: Error: …` a plain `Error` would produce.
 *
 * @param command The refused command as it follows `prisma` on the command
 * line, e.g. `'migrate deploy'`.
 * @returns The error to throw.
 */
function unconfigured(command: string): Error {
  const error = new Error(
    [
      `prisma ${command} needs a database connection, but ${DATABASE_URL_VAR} is not set.`,
      '  1. start PostgreSQL:  pnpm demo:db',
      '  2. copy apps/demo-app/.env.example to apps/demo-app/.env, which carries the local',
      `     development connection URL (or export ${DATABASE_URL_VAR} yourself)`,
      '  3. run the command again',
    ].join('\n'),
  );
  error.name = 'lumen-supply config';
  return error;
}

/**
 * The `datasource` object for this invocation, or `undefined` when the key must
 * be absent altogether.
 *
 * Four cases, in order:
 *
 *  1. `DATABASE_URL` is set — every command gets
 *     `{ url: env('DATABASE_URL') }`, the shape AAP 0.3.4 and 0.7.1 Group 5
 *     prescribe. The URL handed to Prisma is always read through `env()`, the
 *     accessor the CLI expects; `process.env` is consulted only by
 *     {@link hasDatabaseUrl}'s presence probe.
 *  2. No `DATABASE_URL`, and the command is `prisma migrate diff` with both
 *     endpoints offline (neither `--from-config-datasource` nor
 *     `--to-config-datasource`): {@link OFFLINE_DIFF_DATASOURCE_URL} supplies
 *     the dialect, so the full DDL is rendered. `--from-migrations` lands here
 *     too and fails loudly and correctly ("You must set
 *     `datasource.shadowDatabaseUrl`…") rather than succeeding empty.
 *  3. No `DATABASE_URL`, and the command must connect — `migrate diff` naming
 *     a config datasource, or one of {@link CONNECTING_COMMANDS} without a
 *     `--url` override: the command is refused with {@link unconfigured}'s
 *     error, which names the variable, `pnpm demo:db` and the `.env.example`
 *     copy step. Left to Prisma, `prisma migrate deploy` would answer only "The
 *     datasource.url property is required in your Prisma config file when
 *     using prisma migrate deploy."; a config-datasource diff would fail in
 *     `env()` without the setup step or, given no datasource key at all, exit 0
 *     with zero bytes — the silent success this file exists to prevent — and a
 *     placeholder would only report a connection error against port 1. An
 *     invocation carrying `--help` or `-h` is exempt and falls to case 4: help
 *     opens no connection.
 *  4. No `DATABASE_URL`, any other command — no `datasource` key. This is what
 *     keeps `generate`, `validate`, `format` and `version` working on a clean
 *     clone with no database (`prisma generate` is this workspace's `prebuild`
 *     and `pretypecheck` step), and what leaves `prisma db seed` to the seed
 *     script, which reports the missing variable with the full setup sequence.
 *
 * @returns The datasource to contribute, or `undefined` to contribute none.
 * @throws `Error` naming `DATABASE_URL`, `pnpm demo:db` and the
 * `apps/demo-app/.env.example` → `apps/demo-app/.env` copy step when the
 * command needs a database that neither the environment, `apps/demo-app/.env`
 * nor a `--url` override provides.
 */
function resolveDatasource(): { readonly url: string } | undefined {
  if (hasDatabaseUrl()) {
    return { url: env(DATABASE_URL_VAR) };
  }
  const command = invokedCommandName();
  if (command === MIGRATE_DIFF_COMMAND && !namesConfigDatasource()) {
    return { url: OFFLINE_DIFF_DATASOURCE_URL };
  }
  if (flagged(HELP_FLAGS)) {
    return undefined;
  }
  if (command === MIGRATE_DIFF_COMMAND) {
    throw unconfigured(command);
  }
  const connecting = CONNECTING_COMMANDS.find(
    (entry) => command === entry || command.startsWith(`${entry} `),
  );
  if (connecting !== undefined && !flagged(URL_OVERRIDE_FLAGS)) {
    throw unconfigured(connecting);
  }
  return undefined;
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
  // `resolveDatasource()` above decides which case applies — a configured URL,
  // the offline `migrate diff` placeholder, or no key at all; a command that
  // needs a database it was not given has already been refused there.
  ...(datasource === undefined ? {} : { datasource }),
});
