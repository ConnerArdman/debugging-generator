/**
 * The migration-consistency gate behind `pnpm check:migration` (and `premigrate`):
 * the committed migrations, replayed in order, must build exactly the database
 * `prisma/schema.prisma` describes.
 *
 * It needs no database. The schema side is Prisma's own rendering of the schema
 * from nothing - `prisma migrate diff --from-empty --to-schema
 * prisma/schema.prisma --script`, which this check runs itself - and the
 * migrations side is the `migration.sql` of every directory under
 * `prisma/migrations`, read in the order Prisma applies them. Neither side is
 * executed: each is reduced to the set of schema objects it creates, and the
 * two sets must be equal.
 *
 * **How the schema is rendered.** The check starts the Prisma CLI as a child
 * process and reads its standard output, so the package script is a plain
 * `tsx prisma/check-migrations.ts` with no shell syntax in it. Two details of
 * that child are deliberate:
 *
 *  - It is `node <prisma>/build/index.js migrate diff ...` - the running Node
 *    binary (`process.execPath`) given the CLI entry point that `bin.prisma`
 *    names, resolved from this workspace's dependencies - and never a shell or
 *    the `node_modules/.bin/prisma` shim. A shell is what made the former
 *    `DATABASE_URL= prisma ... | tsx ...` script POSIX-only: `cmd.exe` rejects
 *    the `VAR= command` prefix, and on Windows the `.bin` shim is a `.cmd` file
 *    that cannot be spawned without one. Spawning Node directly behaves the same
 *    on every platform, and keeps the CLI's argv as `[node,
 *    .../prisma/build/index.js, 'migrate', 'diff', ...]`, the positional shape
 *    `invokedCommandName()` in prisma.config.ts reads.
 *  - Its environment is this one with `DATABASE_URL` present and empty. The
 *    rendering must never depend on a live database, and blanking the variable
 *    (rather than deleting it) is what guarantees that: prisma.config.ts loads
 *    the git-ignored `.env` with `process.loadEnvFile()`, which leaves a
 *    variable that is already present untouched, and it treats a blank value as
 *    absent, so `migrate diff` is given its credential-free offline dialect
 *    placeholder whatever `.env` or the calling shell holds.
 *
 * Prisma's own diagnostics reach the terminal unchanged: the child's standard
 * error is this process's standard error.
 *
 * **Why a reduction rather than a text comparison.** While the history was one
 * initial migration, that migration and the rendering were the same text, and
 * a line-by-line `diff` was the whole check. A later migration ends that: it
 * adds a column with `ALTER TABLE ... ADD COLUMN`, while the rendering from
 * nothing states the same column inside `CREATE TABLE`. So both sides are read
 * as facts - one per enum, per index, per foreign key, and one per column or
 * table constraint, filed under its table - and a column added later is the
 * same fact as the column created with its table. Column order is deliberately
 * not compared: Prisma addresses columns by name, and a column added by a later
 * migration sits last in the table whatever its place in the model.
 *
 * **What it replays, and what it refuses.** The statements Prisma writes when a
 * schema grows: `CREATE TYPE`, `CREATE TABLE`, `CREATE [UNIQUE] INDEX`, and
 * `ALTER TABLE` adding columns or constraints. A migration holding anything
 * else - a dropped or altered column, a renamed index, a data statement - is
 * refused with the statement named, because replaying it without a database
 * would mean reimplementing PostgreSQL's DDL here; the check fails closed rather
 * than passing a history it did not understand. Such a migration is verified
 * against a live database instead, with `prisma migrate diff
 * --from-config-datasource --to-schema prisma/schema.prisma --exit-code` after
 * `pnpm migrate`.
 *
 * Exits `0` when the migrations reproduce the schema, `1` when they do not (the
 * differing facts are printed on both sides), and `2` when the rendering failed
 * or was empty, or a statement could not be replayed.
 *
 * It runs from any working directory - `pnpm run check:migration` inside
 * apps/demo-app, `pnpm --filter @debuggen/demo-app check:migration` from the
 * repository root, or `tsx apps/demo-app/prisma/check-migrations.ts` - because
 * every path it uses is resolved against this file rather than against
 * `process.cwd()`.
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Where the committed history lives, beside this file. */
const MIGRATIONS = new URL('./migrations/', import.meta.url);

/**
 * The workspace directory (apps/demo-app), which the Prisma CLI is started in:
 * it finds prisma.config.ts there, and resolves the schema path below against
 * it.
 */
const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));

/**
 * The Prisma CLI entry point - the file `bin.prisma` of prisma 7.10.0 names, and
 * an exported subpath of the package - as a specifier resolved from this file,
 * so the CLI that runs is the one this workspace depends on.
 */
const PRISMA_CLI = 'prisma/build/index.js';

/**
 * The CLI arguments that render the schema from nothing, as the SQL script that
 * would create it on an empty database.
 */
const RENDER_ARGUMENTS: readonly string[] = [
  'migrate',
  'diff',
  '--from-empty',
  '--to-schema',
  'prisma/schema.prisma',
  '--script',
];

/** The rendering command as a developer would type it, for messages. */
const RENDER_COMMAND = `prisma ${RENDER_ARGUMENTS.join(' ')}`;

/**
 * The variable blanked in the child's environment so that the rendering never
 * reaches a database; see "How the schema is rendered" above.
 */
const DATABASE_URL = 'DATABASE_URL';

/** The file every migration directory holds. */
const SCRIPT = 'migration.sql';

/** Exit code for a history that does not reproduce the schema. */
const DRIFT = 1;

/**
 * Exit code for input this check cannot judge: a rendering that failed or came
 * back empty, a statement it cannot replay, or a history it could not read.
 */
const UNUSABLE = 2;

/**
 * `text` cut at every `separator` that stands outside quotes and parentheses,
 * each piece trimmed, empty pieces dropped.
 *
 * DDL nests both: a column type carries its precision in parentheses -
 * `DECIMAL(10,2)`, `TIMESTAMP(3)` - and a default or an enum value is quoted, so
 * a separator inside either is part of the piece it appears in.
 *
 * @param text The statement text, or the body of one.
 * @param separator The one character to cut at: `;` between statements, `,`
 * between the elements of a table or of an `ALTER TABLE`.
 */
function split(text: string, separator: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === separator && depth === 0) {
      pieces.push(text.slice(start, index));
      start = index + 1;
    }
  }

  pieces.push(text.slice(start));

  return pieces.map((piece) => piece.trim()).filter((piece) => piece.length > 0);
}

/**
 * The statements of a SQL script, comment lines removed and each statement's
 * whitespace collapsed to single spaces, so that the same statement written by
 * two renderings compares equal however it was indented.
 *
 * @param sql A script as Prisma writes one.
 */
function statements(sql: string): string[] {
  const code = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  return split(code, ';').map((statement) => statement.replace(/\s+/g, ' '));
}

/**
 * Records one occurrence of `fact`.
 *
 * A multiset rather than a set, so that a statement a history applies twice
 * is a difference rather than something the comparison absorbs.
 */
function add(facts: Map<string, number>, fact: string): void {
  facts.set(fact, (facts.get(fact) ?? 0) + 1);
}

/**
 * Folds one statement into `facts`, or refuses it.
 *
 * @param facts The schema objects created so far.
 * @param statement One statement, as {@link statements} returns it.
 * @param origin Where the statement came from, for a refusal to name.
 * @throws Error For a statement outside the additive forms this check replays.
 */
function apply(facts: Map<string, number>, statement: string, origin: string): void {
  const table = /^CREATE TABLE ("[^"]+") \((.*)\)$/s.exec(statement);

  if (table !== null) {
    const [, name = '', body = ''] = table;

    for (const element of split(body, ',')) {
      add(facts, `${name} ${element}`);
    }

    return;
  }

  const altered = /^ALTER TABLE ("[^"]+") (.*)$/s.exec(statement);

  if (altered !== null) {
    const [, name = '', rest = ''] = altered;

    // A constraint added after its table exists is rendered the same way from
    // nothing, so the statement itself is the fact.
    if (/^ADD CONSTRAINT /.test(rest)) {
      add(facts, statement);

      return;
    }

    for (const change of split(rest, ',')) {
      const column = /^ADD COLUMN (.*)$/s.exec(change);

      if (column === null) {
        throw new Error(`${origin}: cannot replay "${statement}" without a database`);
      }

      add(facts, `${name} ${column[1] ?? ''}`);
    }

    return;
  }

  if (/^CREATE (SCHEMA|TYPE|(UNIQUE )?INDEX) /.test(statement)) {
    add(facts, statement);

    return;
  }

  throw new Error(`${origin}: cannot replay "${statement}" without a database`);
}

/**
 * The schema objects a script creates, as a multiset of facts.
 *
 * @param sql The script.
 * @param origin Where it came from, for a refusal to name.
 * @param facts The facts to add to, when the script continues a history.
 */
function reduce(
  sql: string,
  origin: string,
  facts = new Map<string, number>(),
): Map<string, number> {
  for (const statement of statements(sql)) {
    apply(facts, statement, origin);
  }

  return facts;
}

/**
 * What the committed history creates, every migration folded in the order
 * Prisma applies them: the directory names, compared as strings.
 */
function replay(): { facts: Map<string, number>; count: number } {
  const directories = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const facts = new Map<string, number>();

  for (const directory of directories) {
    const script = readFileSync(new URL(`${directory}/${SCRIPT}`, MIGRATIONS), 'utf8');

    reduce(script, `prisma/migrations/${directory}/${SCRIPT}`, facts);
  }

  return { facts, count: directories.length };
}

/**
 * The facts `from` holds more of than `to`, each repeated once per surplus
 * occurrence, in a stable order for the report.
 */
function surplus(from: Map<string, number>, to: Map<string, number>): string[] {
  const extra: string[] = [];

  for (const [fact, count] of from) {
    for (let left = count - (to.get(fact) ?? 0); left > 0; left -= 1) {
      extra.push(fact);
    }
  }

  return extra.sort();
}

/**
 * The schema rendered from nothing: everything {@link RENDER_COMMAND} writes to
 * standard output, once it has exited successfully.
 *
 * The child is `process.execPath` running the resolved {@link PRISMA_CLI} in
 * {@link WORKSPACE}, with `DATABASE_URL` present and blank, no standard input,
 * and this process's standard error - see "How the schema is rendered" above
 * for why each is what it is. Output is collected as bytes and decoded once, so
 * a multi-byte character split across two chunks survives.
 *
 * The promise settles on `close`, which follows both the exit and the end of
 * the child's output, so nothing written last is lost.
 *
 * @returns The rendered script, decoded as UTF-8.
 * @throws Error When the CLI cannot be resolved or started, its output cannot
 * be read, or it exits with a non-zero code or on a signal; Prisma's own
 * account of such a failure has already been written to standard error.
 */
async function render(): Promise<string> {
  const cli = createRequire(import.meta.url).resolve(PRISMA_CLI);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...RENDER_ARGUMENTS], {
      cwd: WORKSPACE,
      env: { ...process.env, [DATABASE_URL]: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];

    child.stdout.on('data', (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });

    // Without a listener a stream error is thrown as an uncaught exception,
    // which would end this process with exit code 1 and read as drift.
    child.stdout.on('error', (error: Error) => {
      reject(new Error(`could not read the output of \`${RENDER_COMMAND}\`: ${error.message}`));
    });

    child.on('error', (error: Error) => {
      reject(new Error(`could not start \`${RENDER_COMMAND}\`: ${error.message}`));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));

        return;
      }

      reject(
        new Error(
          signal === null
            ? `\`${RENDER_COMMAND}\` exited with code ${String(code)}; Prisma's report is above`
            : `\`${RENDER_COMMAND}\` was terminated by ${signal}`,
        ),
      );
    });
  });
}

/**
 * Renders the schema, replays the committed history, and compares the two.
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  try {
    const rendered = await render();

    if (statements(rendered).length === 0) {
      throw new Error(
        `\`${RENDER_COMMAND}\` succeeded but rendered no SQL; prisma.config.ts must give \`migrate diff\` a datasource dialect when ${DATABASE_URL} is blank, or Prisma renders nothing`,
      );
    }

    const schema = reduce(rendered, 'the schema rendering');
    const history = replay();
    const missing = surplus(schema, history.facts);
    const unexpected = surplus(history.facts, schema);

    if (missing.length === 0 && unexpected.length === 0) {
      console.log(
        `check-migrations: ${String(history.count)} migrations reproduce prisma/schema.prisma (${String(schema.size)} schema objects)`,
      );

      return 0;
    }

    for (const fact of missing) {
      console.error(`check-migrations: the schema has, the migrations lack: ${fact}`);
    }

    for (const fact of unexpected) {
      console.error(`check-migrations: the migrations have, the schema lacks: ${fact}`);
    }

    console.error(
      'check-migrations: prisma/migrations does not reproduce prisma/schema.prisma; add the migration the schema change needs (`pnpm migrate:dev`) rather than editing one that has been applied',
    );

    return DRIFT;
  } catch (failure) {
    // Every failure here is one this check cannot judge past - a rendering that
    // failed or came back empty, a statement it cannot replay, a history it
    // could not read - and is reported as that rather than as drift, which
    // would claim a comparison that never happened.
    console.error(
      `check-migrations: ${failure instanceof Error ? failure.message : String(failure)}`,
    );

    return UNUSABLE;
  }
}

process.exitCode = await main();
