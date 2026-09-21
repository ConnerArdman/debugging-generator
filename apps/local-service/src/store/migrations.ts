/**
 * Versioned, idempotent application of the session store schema.
 *
 * `./db.ts` calls {@link applyMigrations} exactly once per process from inside
 * `openStore`, after it has opened the `node:sqlite` connection and set that
 * connection's pragmas, and before any repository prepares a statement. The
 * service's entry point runs that open ahead of modification reconciliation,
 * ahead of the retention sweep and ahead of the HTTP and WebSocket surfaces
 * accepting a single client, so a failure here has to arrive as a typed value
 * the entry point can report and exit on — never as a half-migrated database
 * that the repositories then write into.
 *
 * ## The version authority
 *
 * `PRAGMA user_version` is the authority on the schema version of an existing
 * database. It is a single 32-bit integer in the SQLite file header: reading it
 * costs one page read, which is why the overwhelmingly common start — a
 * database already at the current version — can be decided without a query
 * against a table and without a write of any kind.
 *
 * {@link STORE_SCHEMA_VERSION} is the version this build expects. The `meta`
 * table mirrors the stamped version, the digest of the DDL text and two
 * timestamps in human-readable form for a developer inspecting the file with
 * any SQLite client; it is a mirror and never the authority, because a table
 * can only be read after the schema that declares it exists.
 *
 * Four decisions follow from comparing the two, and they are the whole of this
 * module's behaviour:
 *
 * | Stamped version                  | Decision                                            |
 * | -------------------------------- | --------------------------------------------------- |
 * | equal to `STORE_SCHEMA_VERSION`  | no-op success, performing no write at all            |
 * | greater                          | refuse, with an actionable hint: a newer build wrote it |
 * | `0` with the schema already there | adopt it — stamp, do not re-create                 |
 * | lower                            | apply every ladder step above it, one transaction each |
 *
 * ## The additive-only ladder policy
 *
 * {@link STORE_MIGRATIONS} is the ladder. Step 1 is the DDL text of
 * `./schema.sql`, handed in by the caller. Every later step must be purely
 * additive — `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
 * `ALTER TABLE … ADD COLUMN` — and must never drop, rename or rewrite an
 * object an earlier step declared.
 *
 * That is a safety requirement rather than a matter of taste. This database
 * holds the modification journal: the rows that record, for every file this
 * tool patched, the hash of the original content, the hash of the patched
 * content and the path of the backup. Those rows are the only thing able to
 * restore a developer's source files after a crash, so an existing database
 * must always be able to migrate forward without losing them. A step that
 * rebuilt a table would put a developer's working tree at the mercy of a schema
 * refactor.
 *
 * ## What this module deliberately does not do
 *
 * - **No filesystem access and no path computation.** The DDL arrives as a
 *   string because `./db.ts` owns the three-source loader — an inline string
 *   injected by the packaged editor extension, `./schema.sql` beside the
 *   sources in development, `./store/schema.sql` beside the bundled entry
 *   point. Keeping the read out of here is what lets the installable bundle be
 *   self-contained.
 * - **No connection pragmas.** `journal_mode`, `foreign_keys`, `busy_timeout`
 *   and `synchronous` are per-connection settings owned by `./db.ts`. In
 *   particular `PRAGMA journal_mode` cannot run inside a transaction, and every
 *   write here happens inside one.
 * - **No `node:sqlite` runtime dependency.** The binding is imported for its
 *   type only; the live database handle is passed in, which is what lets a test
 *   drive the whole ladder against an in-memory database with an injected
 *   logger and clock, and without a `$DEBUGGEN_HOME` on disk.
 */

import {
  DebuggenError,
  assert,
  err,
  noopLogger,
  nowEpochMs,
  ok,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import type { DatabaseSync } from 'node:sqlite';

/**
 * The schema version this build of the service expects an opened store to be
 * at, and the version {@link applyMigrations} migrates an older database up to.
 *
 * **Bump this in the same commit that appends a ladder step to
 * {@link STORE_MIGRATIONS}, never separately.** The two are checked against each
 * other when this module loads: the highest step version must equal this
 * constant, so a step added without a bump — or a bump without a step — fails
 * the service's own start and its test suites rather than shipping a database
 * that no build agrees about.
 *
 * Version 1 is the schema declared by `./schema.sql`.
 */
export const STORE_SCHEMA_VERSION = 1;

/**
 * The `subsystem` field every log record from this module carries, so store
 * lines can be filtered out of a session's log without matching on message
 * text.
 */
const SUBSYSTEM = 'store';

/**
 * The table whose presence means "the version-1 schema is already here".
 *
 * `sessions` is the root of the store's foreign-key graph — every other
 * session-scoped table references it — so a database holding it was created by
 * a build that executed the whole DDL in one transaction. Probing a table
 * rather than counting them keeps the check independent of how many tables the
 * current schema happens to declare.
 */
const ADOPTION_PROBE_TABLE = 'sessions';

/** The bookkeeping table this module owns. See `./schema.sql`. */
const META_TABLE = 'meta';

/**
 * The `meta` keys the ladder writes.
 *
 * - `schema_version` — the stamped version, as text. A mirror of
 *   `PRAGMA user_version`, which stays the authority.
 * - `ddl_sha256` — the digest of the DDL text the ladder was given.
 *   Diagnostic only: a mismatch on a later start is logged at `warn` and never
 *   treated as an error, because a comment or whitespace edit to `./schema.sql`
 *   is legitimate and changes the digest without changing the schema.
 * - `created_at` — epoch milliseconds, written once, when the store is first
 *   migrated or adopted, and never refreshed afterwards.
 * - `updated_at` — epoch milliseconds, refreshed on every applied step and on
 *   adoption.
 */
const META_KEYS = {
  schemaVersion: 'schema_version',
  ddlSha256: 'ddl_sha256',
  created: 'created_at',
  updated: 'updated_at',
} as const;

/** Reads the version stamped in the database header. */
const READ_USER_VERSION_SQL = 'PRAGMA user_version';

/** Existence probe for one table, by exact name. */
const TABLE_EXISTS_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`;

/** Reads one `meta` value by key. */
const READ_META_SQL = `SELECT value FROM ${META_TABLE} WHERE key = ?`;

/**
 * Writes one `meta` row, overwriting an existing value for the same key, so
 * repeating the write is harmless.
 */
const UPSERT_META_SQL =
  `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ` +
  `ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/**
 * Writes one `meta` row only when the key is absent — the `created_at`
 * behaviour, which must record the first migration and not the latest one.
 */
const INSERT_META_IF_ABSENT_SQL = `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`;

/**
 * The largest value `PRAGMA user_version` can hold: it is a signed 32-bit
 * integer, and a step version outside that range would be silently truncated by
 * the engine into a version no later start could recognise.
 */
const MAX_USER_VERSION = 2_147_483_647;

/**
 * The hint attached to every failure that leaves the store unusable but the
 * developer's project untouched.
 *
 * One sentence of recovery, and one sentence of consequence, because the second
 * is the part a developer cannot infer: removing the store loses the session
 * history, and it does *not* revert files an earlier session instrumented — the
 * journal that could have reverted them is what is being deleted. The service
 * reconciles that journal on start, so the ordering matters: restart with the
 * store in place first, and remove it only once that reports the files are
 * restored.
 */
const REPAIR_HINT =
  'Stop the service and restart it; if the failure repeats, the store file is unusable and can be removed at $DEBUGGEN_HOME/sessions.sqlite. Removing it loses past sessions and does not revert files an earlier session instrumented, so restart once with the file in place first and let cleanup report on them.';

/**
 * What a ladder step is given when it runs.
 *
 * Everything a step could need arrives here rather than being reached for, which
 * is what keeps the steps pure enough to test: the schema text comes from the
 * caller's loader, the logger is the host process's, and the clock is a
 * function so a suite can pin time.
 */
export interface MigrationContext {
  /**
   * The full text of `./schema.sql`, exactly as the caller's loader produced
   * it. Step 1 executes it; a later step normally ignores it, because a later
   * step's statements are its own and are never appended to this file.
   */
  readonly ddl: string;

  /** The host process's logger, for a step with something worth reporting. */
  readonly logger: Logger;

  /**
   * The current time in Unix epoch milliseconds. Injected rather than read from
   * `Date.now` so a suite can assert on a timestamp it chose.
   */
  readonly now: () => number;
}

/**
 * One rung of the store's schema ladder.
 *
 * A step is applied inside its own transaction, at most once per database, in
 * ascending version order. It reports failure by throwing — the caller converts
 * that into a typed error after rolling back — because a step's body is a
 * sequence of statements, and requiring every one of them to be threaded
 * through a result type would obscure the SQL without making anything safer.
 */
export interface StoreMigration {
  /**
   * The version this step migrates the database *to*. Must be a positive
   * integer, unique in the ladder, and greater than every earlier step's
   * version; the highest step's version must equal
   * {@link STORE_SCHEMA_VERSION}.
   */
  readonly version: number;

  /**
   * A short, lower-case phrase naming what the step does, for the log line and
   * for the error message when it fails. It reaches a developer, so it describes
   * the change ("add the capture retention index") rather than the ticket.
   */
  readonly description: string;

  /**
   * Applies the step's statements to `db`.
   *
   * Runs inside a transaction the caller opened, so the body must not issue
   * `BEGIN`, `COMMIT` or `ROLLBACK` of its own, must not set a pragma that
   * cannot run inside a transaction, and must leave stamping the version and
   * writing the bookkeeping rows to the caller.
   *
   * @param db The open database handle, inside the caller's transaction.
   * @param context The schema text, the logger and the clock.
   * @throws Any error the underlying statements raise; the caller rolls back and
   * wraps it.
   */
  apply(db: DatabaseSync, context: MigrationContext): void;
}

/**
 * The store's schema ladder, in ascending version order.
 *
 * Adding a step is the only supported way to change the schema of a database
 * that may already exist on a developer's machine, and every step must be
 * additive for the reason set out in this module's overview: the modification
 * journal in here is what restores a developer's patched files, so an existing
 * database must always be able to migrate forward without losing a row.
 *
 * The shape of a future step, for the record:
 *
 * @example
 * ```ts
 * {
 *   version: 2,
 *   description: 'add the capture retention index',
 *   apply: (db) => {
 *     db.exec(
 *       'CREATE INDEX IF NOT EXISTS idx_captures_stopped_at ON captures (stopped_at);',
 *     );
 *   },
 * }
 * ```
 *
 * Its version must be `STORE_SCHEMA_VERSION + 1`, and that constant is bumped
 * in the same commit.
 */
export const STORE_MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    description: 'initial schema',
    /**
     * Executes `./schema.sql` verbatim. Every statement in that file is
     * `IF NOT EXISTS`, so the step is idempotent even though the ladder
     * guarantees it runs at most once.
     */
    apply: (db, { ddl }) => {
      db.exec(ddl);
    },
  },
];

/**
 * The version the initial schema step establishes — the bottom rung, and the
 * version an adopted database is stamped with before any later step runs.
 *
 * Read from the ladder rather than written as `1`, so a future ladder cannot
 * develop a second opinion about where it starts.
 */
const INITIAL_SCHEMA_VERSION = readInitialSchemaVersion(STORE_MIGRATIONS);

/**
 * What {@link applyMigrations} did.
 *
 * `applied` is empty on both zero-work paths, which is why `adopted` exists to
 * tell them apart: an already-current database returns
 * `{ applied: [], adopted: false }` and wrote nothing, while a database that
 * carried the schema without the stamp returns `{ applied: [], adopted: true }`
 * and was stamped.
 */
export interface MigrationOutcome {
  /** The version the database was at before this call. `0` for a new file. */
  fromVersion: number;

  /**
   * The version stamped in the database when this call returned. Equals
   * {@link STORE_SCHEMA_VERSION} on every success.
   */
  toVersion: number;

  /** The versions of the ladder steps this call executed, in the order run. */
  applied: readonly number[];

  /**
   * Whether an existing, unstamped schema was adopted — the schema objects were
   * already present at version `0` and were stamped instead of created.
   */
  adopted: boolean;
}

/**
 * Inputs to {@link applyMigrations}.
 *
 * The two optional members are injection points rather than conveniences: the
 * colocated store suites drive the ladder with a collecting logger and a pinned
 * clock, which is how the "a second start writes nothing" guarantee is asserted
 * on `meta.updated_at`. Both declare `| undefined` explicitly so a caller
 * assembling options from its own optional configuration can pass the property
 * through without narrowing it first — the repository compiles with
 * `exactOptionalPropertyTypes`, under which `logger?: Logger` would reject
 * `{ logger: undefined }`.
 */
export interface ApplyMigrationsOptions {
  /**
   * The full text of `./schema.sql`, from the caller's loader. Must be
   * non-empty: an empty string means the loader resolved nothing, and executing
   * it would leave an empty database stamped as migrated.
   */
  readonly ddl: string;

  /** Where to report progress. Defaults to the shared no-op logger. */
  readonly logger?: Logger | undefined;

  /**
   * The clock used for the `created_at` and `updated_at` bookkeeping rows, in
   * Unix epoch milliseconds. Defaults to the shared `nowEpochMs`.
   */
  readonly now?: (() => number) | undefined;
}

/**
 * The version stamped in `db`'s header, from `PRAGMA user_version`.
 *
 * `0` on a database this tool has never migrated — the value SQLite gives a
 * freshly created file, and also the value an older build left behind if it
 * created the schema without stamping it, which is why
 * {@link applyMigrations} distinguishes the two by probing for a table rather
 * than by the version alone.
 *
 * @param db An open database handle.
 * @returns The stamped version, as a non-negative integer.
 * @throws A {@link DebuggenError} with code `STORE_ERROR` when the pragma
 * returns nothing, or returns a value that is not an integer — either means the
 * handle is not a working SQLite connection, which every caller has to treat as
 * a failure to open the store rather than as version `0`.
 */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare(READ_USER_VERSION_SQL).get();
  const value = row?.['user_version'];

  // `bigint` is accepted because a connection opened with `readBigInts` returns
  // integers in that form; the header field is 32-bit, so the conversion is
  // always exact.
  const version = typeof value === 'bigint' ? Number(value) : value;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new DebuggenError(
      'STORE_ERROR',
      'Reading the schema version of the session store returned no usable value.',
      {
        hint: 'The store file may be corrupt. Close the service and remove $DEBUGGEN_HOME/sessions.sqlite to start a new store; past sessions are lost, instrumented files are not.',
        details: { subsystem: SUBSYSTEM, pragma: 'user_version', received: typeof value },
      },
    );
  }

  return version;
}

/**
 * The value of one `meta` row, or `undefined` when there is none.
 *
 * Tolerates the table being absent, which is the state of a brand-new database
 * before the first ladder step runs: `meta` is declared by the version-1 DDL,
 * so a caller reading bookkeeping before migration — or after a refusal — must
 * not have to guard the call itself.
 *
 * @param db An open database handle.
 * @param key The `meta` key, for example `schema_version`.
 * @returns The stored text, or `undefined` when the table or the row is absent.
 */
export function readMetaValue(db: DatabaseSync, key: string): string | undefined {
  if (!tableExists(db, META_TABLE)) {
    return undefined;
  }

  const value = db.prepare(READ_META_SQL).get(key)?.['value'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether `db` declares a table of exactly this name.
 *
 * @param db An open database handle.
 * @param name The table name, matched exactly and case-sensitively.
 * @returns `true` when the table exists.
 */
function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare(TABLE_EXISTS_SQL).get(name) !== undefined;
}

/**
 * Stamps `version` into the database header.
 *
 * `PRAGMA user_version` takes no bound parameter, so the value is interpolated
 * — and therefore asserted first. The assertion is not defence against a
 * hostile caller (the versions come from this module's own ladder, which is
 * validated when the module loads) but against a truncated stamp: a value
 * outside the header's signed 32-bit range would be written as something no
 * later start recognises.
 *
 * @param db An open database handle, inside the caller's transaction.
 * @param version The version to stamp.
 * @throws A {@link DebuggenError} when `version` is not a positive integer
 * within the header's range.
 */
function stampSchemaVersion(db: DatabaseSync, version: number): void {
  assert(
    Number.isInteger(version) && version > 0 && version <= MAX_USER_VERSION,
    `A store schema version must be a positive integer no greater than ${MAX_USER_VERSION}; received ${version}.`,
  );
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * Writes the bookkeeping rows that mirror a stamp.
 *
 * Called inside the same transaction as the stamp it describes, so the mirror
 * cannot disagree with the header: either both land or neither does.
 * `created_at` is written only when absent, the other three are upserted, and
 * every statement is idempotent, so re-running the write after a crash between
 * two steps changes nothing but `updated_at`.
 *
 * @param db An open database handle, inside the caller's transaction.
 * @param fields The stamped version, the DDL digest and the current time.
 * @throws Any error the statements raise; the caller rolls back and wraps it.
 */
function writeMetaRows(
  db: DatabaseSync,
  fields: { readonly version: number; readonly ddlSha256: string; readonly nowMs: number },
): void {
  const { version, ddlSha256, nowMs } = fields;
  assert(
    Number.isFinite(nowMs),
    'The clock given to the store migration ladder must return a finite epoch-millisecond value.',
  );

  const timestamp = String(Math.trunc(nowMs));
  const upsert = db.prepare(UPSERT_META_SQL);
  upsert.run(META_KEYS.schemaVersion, String(version));
  upsert.run(META_KEYS.ddlSha256, ddlSha256);
  upsert.run(META_KEYS.updated, timestamp);
  db.prepare(INSERT_META_IF_ABSENT_SQL).run(META_KEYS.created, timestamp);
}

/**
 * Runs `work` inside a `BEGIN IMMEDIATE` transaction, rolling back if it throws.
 *
 * `IMMEDIATE` rather than a deferred begin: the write lock is taken up front,
 * so a second service process racing to migrate the same store fails at the
 * `BEGIN` — where the busy timeout `./db.ts` set applies and the failure is
 * reported before any statement ran — instead of part-way through the ladder
 * when the first write is attempted.
 *
 * @param db An open database handle with no transaction in progress.
 * @param logger Where a secondary rollback failure is noted.
 * @param work The statements to run; must not issue transaction control.
 * @throws Whatever `work` threw, after the rollback attempt.
 */
function runInTransaction(db: DatabaseSync, logger: Logger, work: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (cause) {
    rollbackQuietly(db, logger);
    throw cause;
  }
}

/**
 * Rolls back the open transaction, reporting a failure to do so at `debug`
 * instead of raising it.
 *
 * The rollback runs on a path that is already failing, and the original cause is
 * the one the caller has to report. A rollback error is also routinely benign:
 * SQLite aborts the transaction itself for some errors, and the explicit
 * `ROLLBACK` that follows then reports that no transaction is active. Either
 * way the durable state is the pre-transaction state, which is the guarantee
 * this path exists to provide.
 *
 * @param db An open database handle.
 * @param logger Where the note goes.
 */
function rollbackQuietly(db: DatabaseSync, logger: Logger): void {
  try {
    db.exec('ROLLBACK');
  } catch (rollbackCause) {
    logger.debug('rolling back a failed store migration step reported an error', {
      subsystem: SUBSYSTEM,
      reason: DebuggenError.from(rollbackCause, 'STORE_ERROR').message,
    });
  }
}

/**
 * Wraps a caught value as the typed error the service reports, keeping the
 * original reachable as `cause`.
 *
 * {@link DebuggenError.from} is what normalises the value — `catch` binds
 * `unknown`, and a raw `node:sqlite` error is a plain `Error` — and its code is
 * carried over, so a specific code raised deeper survives while anything else
 * becomes `STORE_ERROR`. The underlying message goes into `details.reason`
 * rather than into the message line, which keeps what a user interface renders
 * short and stable.
 *
 * @param cause The caught value.
 * @param message A complete sentence naming what failed.
 * @param hint The developer's next step.
 * @param details Diagnostic context. Holds identifiers, versions and reasons
 * only: this object is logged and may be persisted with a session, so nothing
 * user-supplied belongs in it.
 * @returns The error to return inside an `Err`.
 */
function wrapStoreFailure(
  cause: unknown,
  message: string,
  hint: string,
  details: LogFields,
): DebuggenError {
  const normalized = DebuggenError.from(cause, 'STORE_ERROR');
  return new DebuggenError(normalized.code, message, {
    hint,
    details: { subsystem: SUBSYSTEM, ...details, reason: normalized.message },
    cause,
  });
}

/**
 * Validates the ladder and returns its lowest version.
 *
 * Runs once, when this module is loaded, because a malformed ladder is a
 * programmer error in this repository rather than a runtime condition a
 * developer could act on: a duplicate, unordered or non-integer version, or a
 * highest version that disagrees with {@link STORE_SCHEMA_VERSION}, would make
 * every decision below unsound. Failing at load makes it the first thing the
 * service's own start and every store suite report.
 *
 * @param migrations The ladder, as authored.
 * @returns The version of the first step.
 * @throws A {@link DebuggenError} when the ladder is empty, out of order, holds
 * a duplicate or non-integer version, or does not end at
 * {@link STORE_SCHEMA_VERSION}.
 */
function readInitialSchemaVersion(migrations: readonly StoreMigration[]): number {
  const first = migrations[0];
  assert(first !== undefined, 'The store schema ladder must declare at least one step.');

  let previous = 0;
  for (const step of migrations) {
    assert(
      Number.isInteger(step.version) && step.version > 0 && step.version <= MAX_USER_VERSION,
      `Store migration versions must be positive integers no greater than ${MAX_USER_VERSION}; found ${step.version}.`,
    );
    assert(
      step.version > previous,
      `The store schema ladder must be strictly ascending; version ${step.version} follows ${previous}.`,
    );
    assert(
      step.description.length > 0,
      `Store migration ${step.version} must carry a description.`,
    );
    previous = step.version;
  }

  assert(
    previous === STORE_SCHEMA_VERSION,
    `The highest store migration version (${previous}) must equal STORE_SCHEMA_VERSION (${STORE_SCHEMA_VERSION}); bump the constant in the same commit as the step.`,
  );

  return first.version;
}

/**
 * Notes a difference between the DDL this build carries and the one the
 * database was migrated with, at `warn`, and never as a failure.
 *
 * The digest is a diagnostic: a comment or whitespace edit to `./schema.sql`
 * changes it without changing a single schema object, and refusing to open a
 * store over that would turn a documentation edit into an outage. What the line
 * is for is the other case — a developer running a build whose schema text has
 * moved on while the ladder version has not — where it is the only hint
 * available.
 *
 * @param db An open database handle, already at the current version.
 * @param ddlSha256 The digest of the DDL this call was given.
 * @param logger Where the note goes.
 */
function warnOnDigestDrift(db: DatabaseSync, ddlSha256: string, logger: Logger): void {
  let recorded: string | undefined;
  try {
    recorded = readMetaValue(db, META_KEYS.ddlSha256);
  } catch (cause) {
    // The mirror is unreadable while the header says the schema is current.
    // That is worth a line, and nothing more: no caller's behaviour depends on
    // this table, and the store itself is usable.
    logger.debug('could not read the recorded store schema digest', {
      subsystem: SUBSYSTEM,
      reason: DebuggenError.from(cause, 'STORE_ERROR').message,
    });
    return;
  }

  if (recorded !== undefined && recorded !== ddlSha256) {
    logger.warn('the store schema text differs from the one this database was migrated with', {
      subsystem: SUBSYSTEM,
      schemaVersion: STORE_SCHEMA_VERSION,
      recordedDdlSha256: recorded,
      currentDdlSha256: ddlSha256,
    });
  }
}

/**
 * Brings an opened store up to {@link STORE_SCHEMA_VERSION}, doing nothing when
 * it is already there.
 *
 * This is the one entry point of the module and the only function `./db.ts`
 * calls. It is safe to call on every start and on a database in any of the four
 * states the module overview tabulates; it takes the write lock only when there
 * is something to write, and it leaves the database untouched on every failure
 * path.
 *
 * ## Guarantees
 *
 * - **An already-current database is read-only.** The decision costs one header
 *   read plus, at most, one `meta` read for the digest comparison. No
 *   transaction is opened, so a second start cannot even refresh a timestamp —
 *   which is exactly what the store suites assert by snapshotting
 *   `meta.updated_at` across two calls.
 * - **Every step is all-or-nothing.** A step's statements, the version stamp
 *   and the bookkeeping rows commit together inside one `BEGIN IMMEDIATE`
 *   transaction, so a crash or a failing statement leaves the previous version
 *   intact rather than a partially created schema. A ladder of several steps
 *   commits each rung separately, which means an interrupted run resumes from
 *   the last completed rung on the next start instead of starting over.
 * - **A newer database is refused, never downgraded.** Running an older build
 *   against a store a newer one wrote returns an error rather than reinterpreting
 *   its rows — the modification journal in there is what restores a developer's
 *   patched files, and misreading it is worse than refusing to start.
 * - **Nothing escapes as an exception** except a broken invariant in this
 *   repository's own ladder, which is validated when the module loads. Every
 *   condition a developer could cause or act on arrives as an `Err` carrying a
 *   code, a message and a hint, which is what the service's entry point reports
 *   before exiting.
 *
 * @param db An open `node:sqlite` handle with its pragmas already set by
 * `./db.ts` and no transaction in progress.
 * @param options The schema text, and optionally a logger and a clock.
 * @returns `Ok` with the versions and the steps applied, or `Err` with a
 * {@link DebuggenError} describing why the store cannot be used.
 *
 * @example Opening a store
 * ```ts
 * const outcome = applyMigrations(db, { ddl, logger });
 * if (isErr(outcome)) {
 *   logger.fatal(outcome.error.message, { hint: outcome.error.hint });
 *   process.exit(1);
 * }
 * logger.info('store ready', { version: outcome.value.toVersion });
 * ```
 */
export function applyMigrations(
  db: DatabaseSync,
  options: ApplyMigrationsOptions,
): Result<MigrationOutcome, DebuggenError> {
  const { ddl } = options;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? nowEpochMs;

  if (ddl.trim().length === 0) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        'The session store schema text is empty, so there is nothing to migrate.',
        {
          hint: 'This is a packaging fault rather than a setting: rebuild or reinstall Debug Generator so the store schema ships beside the service entry point.',
          details: { subsystem: SUBSYSTEM, ddlLength: ddl.length },
        },
      ),
    );
  }

  const ddlSha256 = sha256Hex(ddl);

  let fromVersion: number;
  try {
    fromVersion = readSchemaVersion(db);
  } catch (cause) {
    return err(
      wrapStoreFailure(
        cause,
        'Could not read the schema version of the session store.',
        REPAIR_HINT,
        {},
      ),
    );
  }

  // State 1 — already current. The common case, and the reason the version
  // lives in the file header: decided without a transaction and without a write.
  if (fromVersion === STORE_SCHEMA_VERSION) {
    warnOnDigestDrift(db, ddlSha256, logger);
    logger.debug('session store schema is already current', {
      subsystem: SUBSYSTEM,
      fromVersion,
      toVersion: fromVersion,
    });
    return ok({ fromVersion, toVersion: fromVersion, applied: [], adopted: false });
  }

  // State 2 — written by a newer build. Refuse rather than reinterpret.
  if (fromVersion > STORE_SCHEMA_VERSION) {
    return err(
      new DebuggenError(
        'STORE_ERROR',
        `The session store is at schema version ${fromVersion}, which is newer than version ${STORE_SCHEMA_VERSION} that this build understands.`,
        {
          hint: 'Update Debug Generator to the build that wrote this store, or stop the service and remove $DEBUGGEN_HOME/sessions.sqlite to start a fresh one: past sessions are lost, and files instrumented by those sessions are not restored by that removal.',
          details: { subsystem: SUBSYSTEM, fromVersion, expectedVersion: STORE_SCHEMA_VERSION },
        },
      ),
    );
  }

  // States 3 and 4 — the database is behind. `version` tracks what is stamped
  // as the work proceeds, so an error message can say where the store stands.
  let version = fromVersion;
  let adopted = false;

  // State 3 — the schema objects are present but were never stamped, which is
  // what a database created by a build that predated version stamping looks
  // like. Adopt it at the initial step's version: the objects that step would
  // create are already there, so re-running its DDL would be pointless work,
  // while any later rung still has to run, which is why this stamps the bottom
  // of the ladder rather than the top.
  if (version === 0) {
    let schemaPresent: boolean;
    try {
      // Both tables, because adoption asserts two different things: that the
      // schema this ladder would create is already there (the root of the
      // foreign-key graph), and that the row this module has to write exists.
      // An unstamped database carrying one without the other is an incomplete
      // schema rather than an adoptable one, and falling through to the ladder
      // completes it — every statement in the version-1 DDL is
      // `IF NOT EXISTS`, so it creates exactly what is missing — instead of
      // stamping a database the repositories would then fail against.
      schemaPresent = tableExists(db, ADOPTION_PROBE_TABLE) && tableExists(db, META_TABLE);
    } catch (cause) {
      return err(
        wrapStoreFailure(
          cause,
          'Could not inspect the session store to decide whether its schema already exists.',
          REPAIR_HINT,
          { fromVersion },
        ),
      );
    }

    if (schemaPresent) {
      try {
        runInTransaction(db, logger, () => {
          stampSchemaVersion(db, INITIAL_SCHEMA_VERSION);
          writeMetaRows(db, { version: INITIAL_SCHEMA_VERSION, ddlSha256, nowMs: now() });
        });
      } catch (cause) {
        return err(
          wrapStoreFailure(
            cause,
            `Could not record schema version ${INITIAL_SCHEMA_VERSION} on the existing session store.`,
            REPAIR_HINT,
            { fromVersion, targetVersion: INITIAL_SCHEMA_VERSION },
          ),
        );
      }

      version = INITIAL_SCHEMA_VERSION;
      adopted = true;
      logger.info('adopted an existing session store schema', {
        subsystem: SUBSYSTEM,
        fromVersion,
        toVersion: version,
      });
    }
  }

  // State 4 — apply every rung above the stamped version, lowest first, each in
  // its own transaction so an interruption resumes from the last completed one.
  const applied: number[] = [];
  const context: MigrationContext = { ddl, logger, now };

  for (const step of STORE_MIGRATIONS) {
    if (step.version <= version) {
      continue;
    }

    try {
      runInTransaction(db, logger, () => {
        step.apply(db, context);
        stampSchemaVersion(db, step.version);
        writeMetaRows(db, { version: step.version, ddlSha256, nowMs: now() });
      });
    } catch (cause) {
      return err(
        wrapStoreFailure(
          cause,
          `Store migration ${step.version} (${step.description}) failed; the session store is unchanged at schema version ${version}.`,
          REPAIR_HINT,
          {
            fromVersion,
            failedVersion: step.version,
            description: step.description,
            appliedVersions: [...applied],
          },
        ),
      );
    }

    logger.info(`applied store migration ${step.version} (${step.description})`, {
      subsystem: SUBSYSTEM,
      fromVersion: version,
      toVersion: step.version,
    });
    applied.push(step.version);
    version = step.version;
  }

  // A postcondition rather than a runtime check: the ladder validated when this
  // module loaded ends at STORE_SCHEMA_VERSION, and every rung above the
  // stamped version has just run, so reaching here at any other version would
  // mean the loop above skipped a rung.
  assert(
    version === STORE_SCHEMA_VERSION,
    `The session store finished migration at version ${version} instead of ${STORE_SCHEMA_VERSION}.`,
  );

  return ok({ fromVersion, toVersion: version, applied, adopted });
}
