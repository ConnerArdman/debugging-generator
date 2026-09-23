/**
 * The session store's connection: the one place in this service that opens a
 * database, and the handle every repository is constructed around.
 *
 * ## What this module owns
 *
 * `$DEBUGGEN_HOME/sessions.sqlite` holds everything a debugging session is made
 * of — the session records, the progress ladder, the instrumentation plans, the
 * **modification journal that is the only record able to restore a developer's
 * patched files**, the captured telemetry, the analyses and the generated
 * panels. Opening it correctly is therefore not a detail of start-up: the
 * per-connection settings below decide whether the schema's cascade rules hold
 * at all, and the shutdown sequence decides whether a stopped service leaves
 * one readable file behind or a write-ahead log nobody folded back in.
 *
 * Three things live here and nowhere else:
 *
 * 1. **The DDL loader** ({@link loadSchemaSql}) — the three-source probe that
 *    finds `./schema.sql` in every layout this service runs in.
 * 2. **The connection's pragmas** ({@link STORE_PRAGMAS}) — `journal_mode`,
 *    `foreign_keys`, `busy_timeout` and `synchronous`, which `./schema.sql` and
 *    `./migrations.ts` both document as this module's responsibility because
 *    none of them can be declared in a DDL file or set inside a transaction.
 * 3. **The {@link Store} handle** — a prepared-statement cache, a composable
 *    transaction helper, a tolerant checkpoint and an idempotent close.
 *
 * The engine is the runtime's built-in `node:sqlite` binding and nothing else
 * (AAP 0.3.2): a native module would have to be rebuilt per platform and would
 * break the self-contained VSIX the editor extension packages, so
 * `better-sqlite3` was deliberately rejected and no alternative driver may be
 * introduced here.
 *
 * ## The loader contract
 *
 * `./schema.sql` is data — executed verbatim by `DatabaseSync.exec()` — and it
 * must stay a standalone file rather than a TypeScript template literal, so it
 * has to be *found* at run time. {@link loadSchemaSql} probes three sources,
 * first hit wins:
 *
 * 1. an inline string the caller hands in ({@link LoadSchemaSqlOptions.inlineDdl}),
 *    which is the packaged-extension path: `apps/vscode-extension/esbuild.mjs`
 *    inlines the DDL at build time, so the installed bundle performs **no
 *    filesystem read at all**;
 * 2. `new URL('./schema.sql', import.meta.url)` — the development path, where
 *    this module's URL is `src/store/db.ts` and the DDL sits beside it;
 * 3. `new URL('./store/schema.sql', import.meta.url)` — the bundled path, where
 *    this module has been folded into `dist/main.js` and `tsup.config.ts` has
 *    copied the DDL to `dist/store/schema.sql` (that build fails if the copy is
 *    missing, so this candidate is a guaranteed path rather than a hopeful one).
 *
 * Both filesystem candidates are derived from `import.meta.url` — never from
 * `__dirname`, `require.resolve` or a bundler-specific asset import, none of
 * which survives all three layouts — and their relative specifiers are exported
 * as {@link SCHEMA_SQL_CANDIDATES} so a suite can assert the probe order
 * without restating the strings.
 *
 * ## The pragmas, and why each one is here
 *
 * - `journal_mode = WAL` is the mode AAP 0.4.2 specifies for this store. It is
 *   persistent in the file, but it is set on every open because a copied,
 *   restored or hand-created file may not carry it, and it **cannot be set from
 *   inside a transaction** — which is precisely why the migration ladder
 *   refuses to own it. WAL is what lets the ingest path write while a panel
 *   query reads.
 * - `foreign_keys = ON` is off by default in SQLite and is per connection, so
 *   the `ON DELETE CASCADE` edges the schema declares take effect only while
 *   this statement has run. Without it, deleting a session would orphan its
 *   telemetry instead of removing it.
 * - `busy_timeout = 5000` replaces an immediate `SQLITE_BUSY` with a bounded
 *   wait, which is what makes a retention purge and a telemetry ingest batch
 *   coexist rather than race.
 * - `synchronous = NORMAL` is the standard companion of WAL: a commit no longer
 *   waits for a disk flush, and the exposure is a power loss losing the last
 *   commits of a *debugging session* — never a developer's source file, which
 *   is restored from a backup that was `fsync`ed before anything was patched.
 *
 * They are applied through `db.exec` in the declared order and outside any
 * transaction, and the resulting `journal_mode` is read back: a filesystem that
 * cannot support WAL reports something else, which is logged at `warn` rather
 * than treated as a failure. For an in-memory database the mode is `memory` and
 * that is expected, so it is reported at `debug`.
 *
 * ## The transaction model
 *
 * {@link Store.transaction} opens `BEGIN IMMEDIATE` at the outermost level and
 * a `SAVEPOINT` at every level below it, so repository calls compose: the
 * retention sweep can delete a session through the sessions repository inside
 * one outer transaction, and either the whole sweep commits or none of it does.
 * `IMMEDIATE` rather than the default deferred mode is deliberate — it takes
 * the write lock up front, so a concurrent purge and an ingest batch fail fast
 * against `busy_timeout` instead of dying mid-transaction with
 * `SQLITE_BUSY_SNAPSHOT` after work has already been done.
 *
 * ## The shutdown sequence
 *
 * `src/main.ts` checkpoints and closes the store from its `SIGINT`/`SIGTERM`
 * handler and from its own failure paths, which is why {@link Store.checkpoint}
 * and an idempotent {@link Store.close} are part of the public handle.
 * `close()` clears the statement cache, runs `PRAGMA wal_checkpoint(TRUNCATE)`
 * so the `-wal` sidecar is folded back into the database file, closes the
 * connection and flips {@link Store.isClosed}. Calling it twice is a no-op —
 * the binding itself throws `ERR_INVALID_STATE` on a second close, and a signal
 * handler racing a test teardown must not turn a clean stop into a crash.
 *
 * ## Values, injection and privacy
 *
 * Values reach SQLite through bound parameters only. That is simultaneously the
 * injection defence and the privacy guarantee: {@link Store.statement} takes a
 * **constant** SQL string, so a statement's text is safe to reason about, and no
 * parameter value, row content or byte of the credential, pairing-code or
 * per-session-key tables can appear in an error, a log record or a stack trace
 * (AAP 0.5.2). This module logs operation names, the local filesystem path of
 * the database, the schema version and counts — never the DDL text, never a
 * statement's parameters and never a row.
 *
 * ## The `db` escape hatch
 *
 * `src/server/auth.ts` owns the `credentials` and `pairing_codes` tables and has
 * no repository of its own, so it reaches them through {@link Store.statement}
 * or, where it needs a connection-level facility, {@link Store.db}. Both are on
 * the public handle by design; a consumer that uses `db` directly takes on the
 * two obligations the handle otherwise discharges — bind every value, and never
 * open a transaction that {@link Store.transaction} does not know about (it
 * detects one and nests a savepoint inside it rather than failing, but the
 * outer commit is then somebody else's responsibility).
 *
 * @packageDocumentation
 */

import { chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  DebuggenError,
  err,
  isErr,
  isWithin,
  noopLogger,
  ok,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';
import { SECURE_FILE_MODE, ensureSecureDir } from '@debuggen/shared/node';

import type { ServiceConfig } from '../config.js';
import { applyMigrations, readSchemaVersion } from './migrations.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` field every log record from this module carries, matching the
 * binding `./migrations.ts` uses, so store lines can be filtered out of a
 * session's log without matching on message text.
 */
const SUBSYSTEM = 'store';

/**
 * The path `node:sqlite` understands as "a private database in memory, backed
 * by no file".
 *
 * Recognised explicitly rather than pattern-matched, because every behaviour
 * that is skipped for it — creating and tightening a directory, tightening the
 * database file and its sidecars, expecting WAL mode — is skipped because there
 * *is* no file, and a path that merely looks like this one would still have one.
 */
const MEMORY_DATABASE_PATH = ':memory:';

/**
 * How long a statement waits for the write lock before it fails, in
 * milliseconds.
 *
 * Long enough to absorb a retention purge or a migration step that is already
 * in flight, short enough that a genuinely stuck writer surfaces as an error a
 * developer sees rather than as a service that appears to have hung.
 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * The per-connection settings applied to every store connection, in the order
 * they are applied.
 *
 * Exported so a suite can assert the set and the order rather than restate it,
 * and frozen so nothing can append to the sequence at run time. See this
 * module's overview for why each one is here and why none of them can live in
 * `./schema.sql` or in a migration step.
 */
export const STORE_PRAGMAS: readonly string[] = Object.freeze([
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
  'PRAGMA synchronous = NORMAL;',
]);

/**
 * The relative specifiers {@link loadSchemaSql} probes, in probe order, each
 * resolved against `import.meta.url`.
 *
 * Exported for the suites and the packaged-extension smoke test, which assert
 * the order rather than duplicating the strings:
 * `'./schema.sql'` is the development layout (this module is
 * `src/store/db.ts`), `'./store/schema.sql'` is the bundled layout (this module
 * has become `dist/main.js`, beside the copy `tsup.config.ts` places at
 * `dist/store/schema.sql`).
 */
export const SCHEMA_SQL_CANDIDATES: readonly string[] = Object.freeze([
  './schema.sql',
  './store/schema.sql',
]);

/**
 * The absolute filesystem paths {@link loadSchemaSql} probes, in probe order,
 * for this build's actual module location.
 *
 * Derived from {@link SCHEMA_SQL_CANDIDATES} through `import.meta.url`, which is
 * why it is a function rather than a constant: the answer depends on where this
 * module ended up, and a test asserting the bundled candidate needs the value
 * this process would really read.
 *
 * @returns One absolute path per candidate, in the order they are tried.
 */
export function schemaSqlCandidatePaths(): readonly string[] {
  return SCHEMA_SQL_CANDIDATES.map((specifier) =>
    fileURLToPath(new URL(specifier, import.meta.url)),
  );
}

/**
 * The marker a resolved DDL must contain to be considered whole.
 *
 * A truncated or empty asset is a packaging fault, and the failure it produces
 * without this check is far worse than a refusal to start: `applyMigrations`
 * would execute nothing, stamp the schema version, and leave every repository
 * failing against tables that were never created. `IF NOT EXISTS` and the
 * `TEMP`/`TEMPORARY` forms are tolerated so the check tests for a table
 * declaration rather than for one exact spelling.
 */
const CREATE_TABLE_PATTERN = /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\b/i;

/** Reads a pragma that returns a row, for the verification reads below. */
const READ_JOURNAL_MODE_SQL = 'PRAGMA journal_mode';

/** Folds the write-ahead log back into the database file and truncates it. */
const CHECKPOINT_SQL = 'PRAGMA wal_checkpoint(TRUNCATE)';

/** Opens the outermost transaction, taking the write lock up front. */
const BEGIN_IMMEDIATE_SQL = 'BEGIN IMMEDIATE;';

/** Commits the outermost transaction. */
const COMMIT_SQL = 'COMMIT;';

/** Rolls the outermost transaction back. */
const ROLLBACK_SQL = 'ROLLBACK;';

/**
 * The hint on every failure a developer can act on by relocating the state
 * directory, which is the one lever they always have.
 */
const STATE_DIRECTORY_HINT =
  'Check that the directory is writable by this account, or set DEBUGGEN_HOME to another state directory and start the service again.';

/**
 * The hint on a packaging-level failure: the schema asset the service needs is
 * not where every layout puts it.
 */
const PACKAGING_HINT =
  'This is a packaging fault rather than a setting: rebuild the service with `pnpm --filter @debuggen/local-service build`, which copies src/store/schema.sql to dist/store/schema.sql, or reinstall Debug Generator.';

/* -------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `errno` code of a caught filesystem or binding failure, when it has one.
 *
 * The same shape `src/main.ts` and `./migrations.ts` use, and for the same
 * reason: a `catch` binding is `unknown`, the distinction between "this
 * candidate is simply not there" (`ENOENT`) and "this candidate exists and
 * cannot be read" is the whole point of the probe, and a thrown value need not
 * be an `Error` at all.
 *
 * @param cause The caught value.
 * @returns The `code` property when it is a string, otherwise `undefined`.
 */
function errnoCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The value of one column of a single-row pragma, as an unknown.
 *
 * Pragmas answer with a row rather than a scalar, and the column name differs
 * from the pragma's own (`PRAGMA busy_timeout` answers under `timeout`), so the
 * column is named by the caller. The value is deliberately widened to `unknown`
 * instead of being narrowed here: what a pragma returns is a text mode for one
 * and an integer — possibly a `bigint`, on a connection reading big integers —
 * for another, and each caller below knows which it wants.
 *
 * @param db An open database handle.
 * @param sql A constant pragma read, from this module's constants.
 * @param column The column to read out of the answering row.
 * @returns The column's value, or `undefined` when the pragma answered no row.
 */
function readPragma(db: DatabaseSync, sql: string, column: string): unknown {
  const row: Record<string, unknown> | undefined = db.prepare(sql).get();
  return row?.[column];
}

/**
 * A pragma's numeric value, normalised across the `number` and `bigint` forms
 * the binding can return.
 *
 * @param value A value from {@link readPragma}.
 * @returns The number, or `undefined` when the value is neither numeric nor
 * finite.
 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

/**
 * The log fields that describe a failure without quoting anything from a row.
 *
 * Only the code, the hint and the error's own diagnostic details travel, which
 * are the three fields a developer acts on and the three this repository's
 * privacy model already constrains.
 *
 * @param error The failure to describe.
 * @returns Fields safe to log.
 */
function errorFields(error: DebuggenError): LogFields {
  return {
    subsystem: SUBSYSTEM,
    code: error.code,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/**
 * Whether a database path names the in-memory database rather than a file.
 *
 * @param path The path as it will be handed to `DatabaseSync`.
 * @returns `true` for the in-memory path.
 */
function isInMemory(path: string): boolean {
  return path === MEMORY_DATABASE_PATH;
}

/* -------------------------------------------------------------------------------------------------
 * The DDL loader
 * ---------------------------------------------------------------------------------------------- */

/** Inputs to {@link loadSchemaSql}. */
export interface LoadSchemaSqlOptions {
  /**
   * The DDL text, supplied directly by a caller that already has it.
   *
   * This is the packaged-extension route: the editor extension's bundler inlines
   * `./schema.sql` at build time and hands the string over, so the installed
   * service reads no file and needs no asset beside its bundle. Supplying it
   * short-circuits the filesystem probe entirely.
   *
   * Declared `| undefined` explicitly so a caller assembling options from its
   * own optional configuration can pass the property straight through — this
   * workspace compiles with `exactOptionalPropertyTypes`, under which
   * `inlineDdl?: string` would reject `{ inlineDdl: undefined }`. An absent or
   * `undefined` value means "probe the filesystem"; a present but empty or
   * whitespace-only value is a packaging fault and is refused rather than
   * quietly falling through to a file that would not be there either.
   */
  readonly inlineDdl?: string | undefined;
}

/**
 * Resolves the session store's data definition from the first available of the
 * three sources this module's overview describes.
 *
 * Every filesystem candidate is guarded individually: a candidate that is not
 * there (`ENOENT`) advances to the next, while any other `errno` — a permission
 * failure, a directory where a file belongs — aborts the probe, because a
 * candidate that exists and cannot be read is a fault to report rather than a
 * miss to skip.
 *
 * Whatever is resolved is then checked for being whole: an empty or
 * whitespace-only text, or a text carrying no `CREATE TABLE` statement, is
 * refused. A truncated asset must fail loudly at start-up rather than produce a
 * service that stamps a schema version over an empty database.
 *
 * @param options The inline DDL, when the caller has it.
 * @returns `Ok` with the DDL text, or `Err` with a `STORE_ERROR` whose `hint`
 * names every path that was probed, so the failure diagnoses itself.
 *
 * @example The development and bundled layouts
 * ```ts
 * const ddl = loadSchemaSql();
 * ```
 *
 * @example The packaged editor extension, which reads no file
 * ```ts
 * const ddl = loadSchemaSql({ inlineDdl: INLINED_SCHEMA_SQL });
 * ```
 */
export function loadSchemaSql(options: LoadSchemaSqlOptions = {}): Result<string, DebuggenError> {
  const { inlineDdl } = options;

  // Source 1. Taken whenever the caller declared it, so an unusable inline DDL
  // is reported as the packaging fault it is instead of falling through to a
  // filesystem probe that cannot succeed in the layout that supplies one.
  if (inlineDdl !== undefined) {
    return validateDdl(inlineDdl, 'inline');
  }

  // Sources 2 and 3, in order. `probed` accumulates what was actually tried so
  // the failure at the end can name it.
  const probed: string[] = [];

  for (const path of schemaSqlCandidatePaths()) {
    probed.push(path);

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (cause) {
      if (errnoCodeOf(cause) === 'ENOENT') {
        continue;
      }
      return err(
        new DebuggenError(
          'STORE_ERROR',
          'Could not read the session store schema that ships beside the service.',
          {
            hint: `Check that ${path} is readable by this account. ${PACKAGING_HINT}`,
            details: { subsystem: SUBSYSTEM, path, errno: errnoCodeOf(cause) ?? 'unknown' },
            cause,
          },
        ),
      );
    }

    return validateDdl(text, path);
  }

  return err(
    new DebuggenError(
      'STORE_ERROR',
      'Could not find the session store schema (schema.sql) beside the service.',
      {
        hint: `${PACKAGING_HINT} Probed: ${probed.join(', ')}.`,
        details: { subsystem: SUBSYSTEM, probed: [...probed] },
      },
    ),
  );
}

/**
 * Accepts a resolved DDL, or refuses it as incomplete.
 *
 * The text itself never reaches the error: only its length and where it came
 * from, because a DDL is large, is executed verbatim, and has no business in a
 * log record or a user interface.
 *
 * @param ddl The resolved text.
 * @param source The absolute path it was read from, or `'inline'`.
 * @returns `Ok` with the text unchanged, or `Err` with a `STORE_ERROR`.
 */
function validateDdl(ddl: string, source: string): Result<string, DebuggenError> {
  if (ddl.trim().length === 0) {
    return err(
      new DebuggenError('STORE_ERROR', 'The session store schema resolved to an empty text.', {
        hint: PACKAGING_HINT,
        details: { subsystem: SUBSYSTEM, source, ddlLength: ddl.length },
      }),
    );
  }

  if (!CREATE_TABLE_PATTERN.test(ddl)) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        'The session store schema declares no table, so it is truncated or is not the store schema.',
        {
          hint: PACKAGING_HINT,
          details: { subsystem: SUBSYSTEM, source, ddlLength: ddl.length },
        },
      ),
    );
  }

  return ok(ddl);
}

/* -------------------------------------------------------------------------------------------------
 * The store handle
 * ---------------------------------------------------------------------------------------------- */

/**
 * An open, migrated session store.
 *
 * This is what {@link openStore} returns and what every repository in
 * `src/store/` is constructed around: `sessions-repo.ts`,
 * `telemetry-repo.ts`, `modifications-repo.ts`, `panels-repo.ts` and
 * `retention.ts` hold one of these and own no connection of their own, which is
 * what makes the statement cache, the pragmas and the transaction nesting below
 * apply to the whole service rather than to whoever remembered them.
 *
 * A handle is single-process and single-threaded, exactly like the binding it
 * wraps: `node:sqlite` is synchronous, so a transaction opened here cannot be
 * interleaved with another caller's statements within this process, and the
 * concurrency that remains — a second process, or the dev-server's own
 * connection — is what `busy_timeout` and WAL mode address.
 */
export interface Store {
  /**
   * The database's path, absolute, or {@link MEMORY_DATABASE_PATH} for an
   * in-memory store. A local filesystem path, safe to log.
   */
  readonly path: string;

  /**
   * The underlying connection.
   *
   * The escape hatch for a caller that needs a connection-level facility this
   * handle does not wrap — `src/server/auth.ts` owns the `credentials` and
   * `pairing_codes` tables and has no repository of its own. Prefer
   * {@link Store.statement} and {@link Store.transaction}: they cache, they
   * nest, and they keep the close path in one piece. Whoever reaches for this
   * takes on both obligations the handle otherwise discharges — bind every
   * value, and leave transaction control to {@link Store.transaction}.
   *
   * After {@link Store.close} this is a closed handle: every call on it throws
   * `ERR_INVALID_STATE` from the binding, so check {@link Store.isClosed}
   * rather than assuming.
   */
  readonly db: DatabaseSync;

  /**
   * The schema version the database is at, read from `PRAGMA user_version`
   * after migration. Equal to `STORE_SCHEMA_VERSION` for every handle
   * {@link openStore} returns.
   */
  readonly schemaVersion: number;

  /** Whether {@link Store.close} has run. */
  readonly isClosed: boolean;

  /**
   * A prepared statement for `sql`, prepared once per distinct text and cached
   * for the lifetime of the handle.
   *
   * `sql` must be a **constant** — a module-level string or a template with no
   * interpolated value. Values reach SQLite through bound parameters only:
   * that is the injection defence, and it is also why no parameter can ever
   * appear in a log record, an error or this cache's keys (AAP 0.5.2). A
   * statement text assembled from a session's question, a file path or a
   * captured attribute is a defect, and it would also defeat the cache, which
   * is keyed on the text.
   *
   * @param sql The constant statement text.
   * @returns The cached statement, prepared on first use.
   * @throws {DebuggenError} With code `STORE_ERROR` when the handle is closed,
   * or when the text cannot be prepared — a mistyped column or a missing table
   * is a defect in this repository, not a condition a developer can act on, so
   * it is raised rather than returned.
   */
  statement(sql: string): StatementSync;

  /**
   * Runs `fn` inside a transaction, committing when it returns and rolling back
   * when it throws.
   *
   * The outermost call opens `BEGIN IMMEDIATE`; a call made while one is
   * already open — including a transaction opened directly on
   * {@link Store.db} — opens a `SAVEPOINT` instead, so repository calls
   * compose: a nested failure rolls back only its own savepoint and leaves the
   * outer transaction able to commit the rest.
   *
   * The callback runs synchronously and must stay synchronous. Returning a
   * promise would commit before the work it represents had finished, because
   * `node:sqlite` is a synchronous binding and this helper commits the moment
   * `fn` returns.
   *
   * @typeParam T The callback's return value, passed through unchanged.
   * @param fn The work to run inside the transaction.
   * @returns Whatever `fn` returned.
   * @throws Whatever `fn` threw, after the rollback — the original failure
   * reaches the caller, never a rollback error that would hide it.
   * @throws {DebuggenError} With code `STORE_ERROR` when the handle is closed,
   * or when the transaction could not be opened or committed.
   */
  transaction<T>(fn: () => T): T;

  /**
   * Folds the write-ahead log back into the database file and truncates it.
   *
   * Called on graceful shutdown and after a large retention purge, so a stopped
   * service leaves one file any SQLite client can read and a purge's freed pages
   * are actually reclaimed. A checkpoint that cannot complete — a reader is
   * still open, or a transaction is in flight — is reported at `debug` and never
   * raised: the cost is disk space, and there is no caller for whom that is
   * worth failing.
   *
   * @throws {DebuggenError} With code `STORE_ERROR` when the handle is closed.
   */
  checkpoint(): void;

  /**
   * Releases the statement cache, checkpoints the write-ahead log and closes the
   * connection.
   *
   * Idempotent: a second call does nothing. `src/main.ts` may reach it from a
   * signal handler and from its own failure path in the same stop, and the
   * binding throws `ERR_INVALID_STATE` on a second close, so this must absorb
   * that rather than turn a clean stop into a crash. After it returns,
   * {@link Store.statement} and {@link Store.transaction} throw.
   */
  close(): void;
}

/** What {@link SqliteStore} is constructed from. */
interface SqliteStoreInit {
  /** The open, pragma-configured, migrated connection. */
  readonly db: DatabaseSync;

  /** The path the connection was opened at. */
  readonly path: string;

  /** The version `PRAGMA user_version` reported after migration. */
  readonly schemaVersion: number;

  /** Where this handle reports checkpoint and close problems. */
  readonly logger: Logger;
}

/**
 * The {@link Store} implementation.
 *
 * Deliberately not exported: the handle is obtained from {@link openStore},
 * which is what guarantees that no connection exists anywhere in this service
 * without the pragmas set and the migration ladder run. A test that wants an
 * isolated store passes `databasePath: ':memory:'` to `openStore` and gets the
 * same code path the service uses.
 */
class SqliteStore implements Store {
  readonly #db: DatabaseSync;

  readonly #path: string;

  readonly #schemaVersion: number;

  readonly #logger: Logger;

  /**
   * Prepared statements by their exact text. Cleared by {@link close}; the
   * binding finalises the statements themselves when the connection closes,
   * and any that outlive the cache report `ERR_INVALID_STATE` rather than
   * reading freed memory.
   */
  readonly #statements = new Map<string, StatementSync>();

  /** How many transactions this handle currently has open, outermost included. */
  #depth = 0;

  /** Whether {@link close} has run. */
  #closed = false;

  constructor(init: SqliteStoreInit) {
    this.#db = init.db;
    this.#path = init.path;
    this.#schemaVersion = init.schemaVersion;
    this.#logger = init.logger;
  }

  get path(): string {
    return this.#path;
  }

  get db(): DatabaseSync {
    return this.#db;
  }

  get schemaVersion(): number {
    return this.#schemaVersion;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  statement(sql: string): StatementSync {
    this.#assertUsable('statement');

    const cached = this.#statements.get(sql);
    if (cached !== undefined) {
      return cached;
    }

    let prepared: StatementSync;
    try {
      prepared = this.#db.prepare(sql);
    } catch (cause) {
      // The statement text is not attached: this handle's contract is that it
      // is a constant, and the binding's own message already names the object
      // it could not resolve, which is the part a developer needs.
      throw new DebuggenError('STORE_ERROR', 'Could not prepare a session store statement.', {
        hint: 'This is a defect in Debug Generator rather than a setting: the statement does not match the store schema. Report it with the service log.',
        details: { subsystem: SUBSYSTEM, operation: 'prepare' },
        cause,
      });
    }

    this.#statements.set(sql, prepared);
    return prepared;
  }

  transaction<T>(fn: () => T): T {
    this.#assertUsable('transaction');

    // A transaction opened on `db` directly counts: nesting a savepoint inside
    // it is correct, while a second `BEGIN` would fail outright.
    const nested = this.#depth > 0 || this.#db.isTransaction;
    const savepoint = nested ? `sp_${this.#depth + 1}` : undefined;

    try {
      this.#db.exec(savepoint === undefined ? BEGIN_IMMEDIATE_SQL : `SAVEPOINT ${savepoint};`);
    } catch (cause) {
      throw new DebuggenError('STORE_ERROR', 'Could not open a session store transaction.', {
        hint: 'Another process may be holding the store write lock. Stop any other Debug Generator service running against this state directory and try again.',
        details: { subsystem: SUBSYSTEM, operation: 'begin', nested },
        cause,
      });
    }

    this.#depth += 1;

    let value: T;
    try {
      value = fn();
    } catch (cause) {
      this.#depth -= 1;
      this.#rollback(savepoint);
      // Rethrown unchanged: the caller's failure is the useful one, and the
      // rollback's own problems are logged by `#rollback` rather than raised.
      throw cause;
    }

    this.#depth -= 1;

    try {
      this.#db.exec(savepoint === undefined ? COMMIT_SQL : `RELEASE ${savepoint};`);
    } catch (cause) {
      this.#rollback(savepoint);
      throw new DebuggenError('STORE_ERROR', 'Could not commit a session store transaction.', {
        hint: 'The change was rolled back. Check that the state directory has free space and is writable, then retry.',
        details: { subsystem: SUBSYSTEM, operation: 'commit', nested },
        cause,
      });
    }

    return value;
  }

  checkpoint(): void {
    this.#assertUsable('checkpoint');
    this.#checkpointQuietly();
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    if (this.#depth > 0) {
      // Reported rather than prevented: a signal handler closing the store
      // mid-transaction is a stop, not a bug, and the binding rolls the open
      // transaction back as it closes.
      this.#logger.warn('closing the session store while a transaction is open', {
        subsystem: SUBSYSTEM,
        depth: this.#depth,
      });
    }

    this.#statements.clear();
    this.#depth = 0;

    // Before the close, and tolerated: a checkpoint cannot run while a
    // transaction is in flight, which is exactly the state the branch above
    // reports.
    this.#checkpointQuietly();

    try {
      if (this.#db.isOpen) {
        this.#db.close();
      }
    } catch (cause) {
      this.#logger.error('could not close the session store cleanly', {
        subsystem: SUBSYSTEM,
        reason: DebuggenError.from(cause, 'STORE_ERROR').message,
      });
    }

    this.#closed = true;
  }

  /**
   * Throws unless this handle can still be used.
   *
   * A call after {@link close} is a lifecycle defect in the service — a
   * repository outliving the handle it was given — so it is raised with the
   * operation named, which is the one piece of context that locates it. Raising
   * here rather than letting the binding throw `ERR_INVALID_STATE` keeps the
   * failure inside this repository's error type, where a boundary can report it.
   *
   * @param operation The member that was called, for the diagnostic details.
   */
  #assertUsable(operation: string): void {
    if (this.#closed || !this.#db.isOpen) {
      throw new DebuggenError('STORE_ERROR', 'The session store is closed.', {
        hint: 'This is a defect in Debug Generator rather than a setting: something used the session store after the service released it. Report it with the service log.',
        details: { subsystem: SUBSYSTEM, operation, path: this.#path },
      });
    }
  }

  /**
   * Undoes the current level of {@link transaction}, reporting rather than
   * raising.
   *
   * A rollback runs on a path where something has already gone wrong, so its own
   * failure must never replace the error the caller is about to see. The
   * `isTransaction` guard is what keeps the common case quiet: SQLite aborts and
   * rolls back the transaction itself for some errors, and `ROLLBACK` with
   * nothing to roll back is an error of its own.
   *
   * @param savepoint The savepoint to unwind, or `undefined` for the outermost
   * transaction.
   */
  #rollback(savepoint: string | undefined): void {
    if (!this.#db.isTransaction) {
      return;
    }

    try {
      if (savepoint === undefined) {
        this.#db.exec(ROLLBACK_SQL);
      } else {
        // `ROLLBACK TO` leaves the savepoint on the stack, so it is released
        // afterwards: without that, the enclosing level would still be holding
        // a savepoint this level owns.
        this.#db.exec(`ROLLBACK TO ${savepoint};`);
        this.#db.exec(`RELEASE ${savepoint};`);
      }
    } catch (cause) {
      this.#logger.error('could not roll back a session store transaction', {
        subsystem: SUBSYSTEM,
        operation: 'rollback',
        ...(savepoint === undefined ? {} : { savepoint }),
        reason: DebuggenError.from(cause, 'STORE_ERROR').message,
      });
    }
  }

  /**
   * Checkpoints the write-ahead log, tolerating a busy result.
   *
   * Used by {@link checkpoint} and by {@link close}. `PRAGMA
   * wal_checkpoint(TRUNCATE)` answers with `busy`, `log` and `checkpointed`
   * counts and raises outright when a transaction holds the database, so both
   * outcomes are reported at `debug` and neither is raised.
   */
  #checkpointQuietly(): void {
    if (!this.#db.isOpen) {
      return;
    }

    try {
      const busy = toFiniteNumber(readPragma(this.#db, CHECKPOINT_SQL, 'busy'));
      if (busy !== undefined && busy !== 0) {
        this.#logger.debug('the session store write-ahead log was busy during the checkpoint', {
          subsystem: SUBSYSTEM,
          busy,
        });
      }
    } catch (cause) {
      this.#logger.debug('could not checkpoint the session store write-ahead log', {
        subsystem: SUBSYSTEM,
        reason: DebuggenError.from(cause, 'STORE_ERROR').message,
      });
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Opening the store
 * ---------------------------------------------------------------------------------------------- */

/** Inputs to {@link openStore}. */
export interface OpenStoreOptions {
  /**
   * The database to open, absolute or relative to the process's working
   * directory, or `':memory:'` for a private in-memory store.
   *
   * The route the suites take: a colocated repository test opens a store inside
   * an `mkdtemp` sandbox — or in memory — so it exercises the real pragmas and
   * the real migration ladder without a `$DEBUGGEN_HOME`. Mutually exclusive
   * with {@link OpenStoreOptions.config}.
   */
  readonly databasePath?: string | undefined;

  /**
   * The resolved service configuration, which is the route `src/main.ts` takes.
   *
   * Only the two members the store needs are required, so a caller never has to
   * assemble a whole {@link ServiceConfig} to open a database:
   * `databasePath` is `<debuggenHome>/sessions.sqlite`, and `debuggenHome` is
   * the state root — the boundary whose whole chain is verified and tightened to
   * `0700` before the file is created. Mutually exclusive with
   * {@link OpenStoreOptions.databasePath}.
   */
  readonly config?: Pick<ServiceConfig, 'databasePath' | 'debuggenHome'> | undefined;

  /**
   * Where the store reports progress and trouble. Defaults to the shared no-op
   * logger, so a test that does not care about output passes nothing.
   *
   * Handed to `applyMigrations` as given rather than as a child bound to
   * `subsystem`: that module puts `subsystem: 'store'` on every record it emits,
   * and a child already bound to the same key would duplicate it in one record.
   */
  readonly logger?: Logger | undefined;

  /**
   * The store's DDL, inlined by the caller's bundler.
   *
   * Forwarded to {@link loadSchemaSql}, where it short-circuits the filesystem
   * probe. This is what makes the packaged editor extension self-contained.
   */
  readonly inlineDdl?: string | undefined;

  /**
   * The store's DDL, supplied directly.
   *
   * Takes precedence over {@link OpenStoreOptions.inlineDdl} and over the
   * filesystem probe, and is the seam a suite uses to migrate a deliberately
   * minimal schema. It is checked for being whole exactly as a resolved file is,
   * so a truncated string fails the open rather than stamping a version over an
   * empty database.
   */
  readonly ddl?: string | undefined;

  /**
   * Whether to create and verify the database's parent directory before opening
   * it. Defaults to `true`.
   *
   * Pass `false` only when the directory is already known to exist and to be
   * private — a caller that has just created its own sandbox, or one that opens
   * a database it does not own the tree of. It is never skipped for the service
   * itself: `$DEBUGGEN_HOME` must be `0700` before a session's telemetry,
   * questions and file paths land inside it.
   */
  readonly ensureDirectory?: boolean | undefined;
}

/** Where the database lives, and which tree the caller declared as its own. */
interface StoreTarget {
  /** The absolute path, or {@link MEMORY_DATABASE_PATH}. */
  readonly path: string;

  /**
   * The state root whose chain is verified and tightened, when the caller
   * declared one and the database really sits inside it; `undefined` otherwise,
   * in which case only the database's own directory is verified.
   */
  readonly stateRoot: string | undefined;
}

/**
 * Opens the session store: the connection, its pragmas, its file modes and its
 * schema, in that order, or a typed failure describing which step refused.
 *
 * This is the only way a {@link Store} comes into existence, which is what
 * guarantees that no connection in this service is missing the pragmas or the
 * migration ladder. `src/main.ts` calls it once, between creating
 * `$DEBUGGEN_HOME` with the editor credential and running the modification
 * reconciliation and retention purge that need a migrated database; the suites
 * call it per test with a sandbox path.
 *
 * ## The sequence, and why it is this one
 *
 * 1. Resolve the target and require **exactly one** of
 *    {@link OpenStoreOptions.databasePath} and {@link OpenStoreOptions.config}.
 * 2. Create and verify the parent directory (`0700`) — before the file exists,
 *    because `DatabaseSync` creates a missing database under the process umask
 *    and a private directory is what keeps the window harmless.
 * 3. Open the connection with no constructor options, so nothing depends on an
 *    option's availability across Node patch releases, and set every behaviour
 *    through the explicit {@link STORE_PRAGMAS} instead.
 * 4. Restrict the database file and its `-wal`/`-shm` sidecars to `0600`,
 *    non-fatally: a host that does not record POSIX modes must not fail to start.
 * 5. Resolve the DDL.
 * 6. Run the migration ladder, closing the connection before returning any
 *    failure so a refused start leaks no handle.
 * 7. Read the stamped schema version back and build the handle.
 *
 * @param options Exactly one of `databasePath` and `config`, plus the optional
 * logger, DDL source and directory switch.
 * @returns `Ok` with an open, migrated {@link Store}, or `Err` with a
 * {@link DebuggenError}: `CONFIG_INVALID` when the options do not name exactly
 * one target, `FS_UNSAFE_PATH` when the state directory is not private or is
 * reached through a symbolic link, and `STORE_ERROR` for every other refusal —
 * the file cannot be opened, the DDL is missing or truncated, the ladder
 * refused.
 *
 * @example The service
 * ```ts
 * const opened = openStore({ config, logger });
 * if (isErr(opened)) {
 *   logger.fatal(opened.error.message, { hint: opened.error.hint });
 *   process.exit(1);
 * }
 * const store = opened.value;
 * ```
 *
 * @example A suite
 * ```ts
 * const store = unwrap(openStore({ databasePath: join(mkdtempSync(prefix), 'sessions.sqlite') }));
 * try {
 *   // exercise a repository against the real schema
 * } finally {
 *   store.close();
 * }
 * ```
 */
export function openStore(options: OpenStoreOptions): Result<Store, DebuggenError> {
  const logger = options.logger ?? noopLogger;

  // Step 1.
  const target = resolveTarget(options);
  if (isErr(target)) {
    return target;
  }
  const { path, stateRoot } = target.value;

  // Step 2.
  if (options.ensureDirectory !== false && !isInMemory(path)) {
    const prepared = prepareStoreDirectory(path, stateRoot);
    if (isErr(prepared)) {
      return prepared;
    }
  }

  // Step 3.
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    return err(
      new DebuggenError('STORE_ERROR', 'Could not open the Debug Generator session store.', {
        hint: `Check that ${path} is a regular file this account can write, and that no other Debug Generator service is running against it. ${STATE_DIRECTORY_HINT}`,
        details: {
          subsystem: SUBSYSTEM,
          databasePath: path,
          errno: errnoCodeOf(cause) ?? 'unknown',
        },
        cause,
      }),
    );
  }

  const configured = configureConnection(db, path, logger);
  if (isErr(configured)) {
    closeQuietly(db, logger);
    return configured;
  }

  // Step 4, first pass: the database file exists from the open above, so this is
  // what narrows the window in which it is readable by other accounts. The
  // sidecars do not exist yet — they are created by the first write, which is
  // the migration transaction below — hence the second pass after it.
  tightenStoreFiles(path, logger);

  // Step 5.
  const ddl = resolveDdl(options);
  if (isErr(ddl)) {
    closeQuietly(db, logger);
    return ddl;
  }

  // Step 6.
  const outcome = applyMigrations(db, { ddl: ddl.value, logger });

  // Runs on both paths and before either return: a refused ladder rolls its
  // transaction back but still leaves the sidecars behind, and they hold the
  // same session data the database does.
  tightenStoreFiles(path, logger);

  if (isErr(outcome)) {
    closeQuietly(db, logger);
    return outcome;
  }

  // Step 7. Read back rather than taken from the outcome: the stamp in the file
  // header is the authority on the version, and a handle that reports it is one
  // a repository can check its own expectations against.
  let schemaVersion: number;
  try {
    schemaVersion = readSchemaVersion(db);
  } catch (cause) {
    const error = DebuggenError.from(cause, 'STORE_ERROR');
    closeQuietly(db, logger);
    return err(error);
  }

  const store = new SqliteStore({ db, path, schemaVersion, logger });

  logger.info('session store opened', {
    subsystem: SUBSYSTEM,
    databasePath: path,
    schemaVersion,
    applied: [...outcome.value.applied],
    adopted: outcome.value.adopted,
  });

  return ok(store);
}

/**
 * Resolves which database to open, refusing an ambiguous or empty request.
 *
 * Exactly one of the two target options must be present. Accepting both would
 * mean silently preferring one, and the two describe different intentions — a
 * sandbox a test owns, and the service's state tree — so the wrong choice would
 * be invisible. Accepting neither would open a database nobody named.
 *
 * @param options The caller's options.
 * @returns `Ok` with the path and the declared state root, or `Err` with
 * `CONFIG_INVALID`.
 */
function resolveTarget(options: OpenStoreOptions): Result<StoreTarget, DebuggenError> {
  const { config, databasePath } = options;

  if (databasePath !== undefined && config !== undefined) {
    return err(
      new DebuggenError(
        'CONFIG_INVALID',
        'openStore was given both a database path and a service configuration.',
        {
          hint: 'Pass exactly one: `databasePath` for a store the caller owns, or `config` for the service state directory.',
          details: { subsystem: SUBSYSTEM, received: 'databasePath+config' },
        },
      ),
    );
  }

  if (databasePath !== undefined) {
    return resolvePath(databasePath, undefined);
  }

  if (config !== undefined) {
    return resolvePath(config.databasePath, config.debuggenHome);
  }

  return err(
    new DebuggenError('CONFIG_INVALID', 'openStore was given no database to open.', {
      hint: 'Pass exactly one: `databasePath` for a store the caller owns, or `config` for the service state directory.',
      details: { subsystem: SUBSYSTEM, received: 'neither' },
    }),
  );
}

/**
 * Turns a configured database path — and the state root it may sit in — into a
 * {@link StoreTarget}.
 *
 * The state root is carried only when the database really lies inside it:
 * `ensureSecureDir` refuses a boundary that does not contain the directory it
 * is asked to create, and a configuration whose database was relocated out of
 * the state tree is a legitimate arrangement rather than a fault, so the
 * boundary is narrowed to the database's own directory instead of rejected.
 *
 * @param databasePath The path to open.
 * @param debuggenHome The declared state root, when there is one.
 * @returns `Ok` with the target, or `Err` with `CONFIG_INVALID` for an empty
 * path.
 */
function resolvePath(
  databasePath: string,
  debuggenHome: string | undefined,
): Result<StoreTarget, DebuggenError> {
  if (isInMemory(databasePath)) {
    return ok({ path: MEMORY_DATABASE_PATH, stateRoot: undefined });
  }

  if (databasePath.trim().length === 0) {
    return err(
      new DebuggenError('CONFIG_INVALID', 'The session store path is empty.', {
        hint: 'Set DEBUGGEN_HOME to a writable directory, or pass an explicit `databasePath`.',
        details: { subsystem: SUBSYSTEM },
      }),
    );
  }

  const path = resolve(databasePath);
  const root =
    debuggenHome === undefined || debuggenHome.trim().length === 0
      ? undefined
      : resolve(debuggenHome);
  const stateRoot = root !== undefined && isWithin(root, dirname(path)) ? root : undefined;

  return ok({ path, stateRoot });
}

/**
 * Creates the database's parent directory as a private one, and proves it.
 *
 * `ensureSecureDir` creates every missing component non-recursively, refuses a
 * symbolic link, tightens the chain to `0700` and verifies the result, so a
 * successful return is a statement about the filesystem rather than about the
 * calls that were attempted. The declared state root is passed as the boundary
 * when there is one, which is what extends the guarantee from "the directory
 * this call created is private" to "every directory from the state root down is
 * private, and none of them is a link".
 *
 * @param path The database path.
 * @param stateRoot The declared boundary, when the database sits inside one.
 * @returns `Ok` when the directory is present and private, or `Err` with
 * `FS_UNSAFE_PATH` for an unsafe tree and `STORE_ERROR` for anything else.
 */
function prepareStoreDirectory(
  path: string,
  stateRoot: string | undefined,
): Result<void, DebuggenError> {
  const directory = dirname(path);

  try {
    if (stateRoot === undefined) {
      ensureSecureDir(directory);
    } else {
      ensureSecureDir(directory, { upTo: stateRoot });
    }
  } catch (cause) {
    const errno = errnoCodeOf(cause);
    const unsafe = DebuggenError.from(cause, 'STORE_ERROR').code === 'FS_UNSAFE_PATH';

    return err(
      new DebuggenError(
        unsafe ? 'FS_UNSAFE_PATH' : 'STORE_ERROR',
        unsafe
          ? 'The Debug Generator state directory is not a private directory this account owns.'
          : 'Could not create the Debug Generator state directory for the session store.',
        {
          hint: unsafe
            ? `Remove or replace ${directory}: the session store's directory must be a real directory owned by this account with no group or other access, because it holds captured telemetry and the backups of every file this tool patches.`
            : STATE_DIRECTORY_HINT,
          details: {
            subsystem: SUBSYSTEM,
            directory,
            ...(stateRoot === undefined ? {} : { stateRoot }),
            errno: errno ?? 'unknown',
          },
          cause,
        },
      ),
    );
  }

  return ok(undefined);
}

/**
 * Applies {@link STORE_PRAGMAS} and verifies the journal mode that resulted.
 *
 * The pragmas run through `db.exec` in the declared order and outside any
 * transaction, which is a hard requirement rather than a convention:
 * `journal_mode` cannot be set inside one. The mode is then read back, because
 * SQLite answers a `journal_mode` request with what it actually adopted — a
 * filesystem without the shared-memory support WAL needs reports something
 * else, and a store running in a rollback journal still works while behaving
 * differently under concurrency, so it is worth a `warn` and is not worth
 * refusing to start over. For an in-memory database the answer is `memory` and
 * that is expected, so it is noted at `debug`.
 *
 * @param db The freshly opened connection.
 * @param path The path it was opened at, for the in-memory distinction.
 * @param logger Where the journal-mode observation is reported.
 * @returns `Ok` when every pragma was applied, or `Err` with `STORE_ERROR`.
 */
function configureConnection(
  db: DatabaseSync,
  path: string,
  logger: Logger,
): Result<void, DebuggenError> {
  for (const pragma of STORE_PRAGMAS) {
    try {
      db.exec(pragma);
    } catch (cause) {
      return err(
        new DebuggenError('STORE_ERROR', 'Could not configure the session store connection.', {
          hint: `Check that ${path} is a SQLite database this account can write; a file of another kind at that path, or one left locked by a stopped process, produces this. ${STATE_DIRECTORY_HINT}`,
          // The pragma text is a constant from this module, so naming it
          // carries no value from a row: it is the one piece of context that
          // says which setting the connection refused.
          details: { subsystem: SUBSYSTEM, pragma, databasePath: path },
          cause,
        }),
      );
    }
  }

  let journalMode: string | undefined;
  try {
    const value = readPragma(db, READ_JOURNAL_MODE_SQL, 'journal_mode');
    journalMode = typeof value === 'string' ? value.toLowerCase() : undefined;
  } catch (cause) {
    logger.debug('could not read back the session store journal mode', {
      subsystem: SUBSYSTEM,
      reason: DebuggenError.from(cause, 'STORE_ERROR').message,
    });
  }

  if (journalMode !== 'wal') {
    const fields: LogFields = {
      subsystem: SUBSYSTEM,
      journalMode: journalMode ?? 'unknown',
      databasePath: path,
    };

    if (isInMemory(path)) {
      logger.debug('the in-memory session store runs without a write-ahead log', fields);
    } else {
      logger.warn(
        'the session store is not in write-ahead log mode, so a reader can block a writer',
        fields,
      );
    }
  }

  return ok(undefined);
}

/**
 * Restricts the database file and its write-ahead sidecars to
 * {@link SECURE_FILE_MODE}.
 *
 * The state tree is `0700`, but the database is not created by this product's
 * own file writers: `DatabaseSync` opens the path itself and takes no mode, so
 * the file — and the `-wal`/`-shm` companions WAL mode creates beside it — land
 * with whatever the process umask allows. A private directory hides them from a
 * listing; the modes are what decide who may read a session's captured
 * telemetry if the tree is ever copied or archived.
 *
 * Every failure is non-fatal and reported at `debug`. A host whose filesystem
 * does not record POSIX permissions cannot satisfy this and must still be able
 * to run the tool, and a missing sidecar is the normal state of a database that
 * has not been written to yet.
 *
 * @param path The database path; the sidecars are derived from it.
 * @param logger Where a refusal is noted.
 */
function tightenStoreFiles(path: string, logger: Logger): void {
  if (isInMemory(path)) {
    return;
  }

  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, SECURE_FILE_MODE);
    } catch (cause) {
      const errno = errnoCodeOf(cause);
      if (errno === 'ENOENT') {
        continue;
      }
      logger.debug('could not restrict a session store file to owner-only access', {
        subsystem: SUBSYSTEM,
        path: file,
        mode: SECURE_FILE_MODE.toString(8),
        errno: errno ?? 'unknown',
      });
    }
  }
}

/**
 * Resolves the DDL for this open: the caller's text, the caller's inline copy,
 * or the filesystem probe.
 *
 * A directly supplied text goes through the same completeness check a resolved
 * file does, because the failure it prevents is the same one: an empty or
 * table-less DDL would be executed as nothing and the schema version stamped
 * over it.
 *
 * @param options The caller's options.
 * @returns `Ok` with the DDL text, or the loader's `Err` unchanged.
 */
function resolveDdl(options: OpenStoreOptions): Result<string, DebuggenError> {
  const { ddl } = options;
  if (ddl !== undefined) {
    return validateDdl(ddl, 'caller');
  }
  return loadSchemaSql({ inlineDdl: options.inlineDdl });
}

/**
 * Closes a connection on a failure path, reporting rather than raising.
 *
 * Used by every `Err` return of {@link openStore} after the handle exists: a
 * refused start must leave no open database behind, or the caller's retry meets
 * its own predecessor holding the write lock. The failure being returned is the
 * one worth reporting, so a problem closing is logged and swallowed.
 *
 * @param db The handle to close.
 * @param logger Where a close problem is reported.
 */
function closeQuietly(db: DatabaseSync, logger: Logger): void {
  if (!db.isOpen) {
    return;
  }

  try {
    db.close();
  } catch (cause) {
    logger.error(
      'could not close the session store after a failed open',
      errorFields(DebuggenError.from(cause, 'STORE_ERROR')),
    );
  }
}
