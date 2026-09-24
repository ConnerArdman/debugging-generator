/**
 * The sessions repository: everything the session store holds that is scoped
 * to one debugging session, over `node:sqlite`.
 *
 * ## What this module owns
 *
 * Seven tables of `./schema.sql` name this file as their owner, and no other
 * module writes them:
 *
 * | Table | What a row is |
 * | --- | --- |
 * | `sessions` | one session: the authoritative `SessionRecord` JSON document plus its indexed projections |
 * | `session_progress` | one line of the append-only pipeline progress log the editor replays on reopen |
 * | `plans` | one version of the session's instrumentation plan ladder |
 * | `captures` | one capture window, open while `stopped_at` is `NULL` |
 * | `followups` | one follow-up question, in the order it was asked |
 * | `bindings` | which inspected browser tab belongs to which session |
 * | `session_keys` | the per-session keyed-hash secret behind duplicate-request grouping |
 *
 * The neighbouring tables belong elsewhere and this module deliberately has no
 * method for them: telemetry rows to `./telemetry-repo.ts`, the modification
 * journal to `./modifications-repo.ts`, panels and analyses to
 * `./panels-repo.ts`, and the credential and pairing-code tables to
 * `src/server/auth.ts` through the store handle.
 *
 * ## The JSON document is the contract
 *
 * `@debuggen/protocol` defines `SessionRecord` once and states that the service
 * persists it as the `sessions.record` column; the same object is broadcast in
 * `session.created` / `session.updated` and returned by the session routes. So
 * the document is authoritative and the flat columns (`project_root`,
 * `project_name`, `status`, `question`, `dev_server_url`, `created_at`,
 * `updated_at`) are **projections**: they are computed from the validated record
 * on every write — never accepted separately — so a projection cannot disagree
 * with the document it was derived from, and they exist only so that the
 * session list and the retention sweep can filter and sort without parsing JSON.
 * The same pattern holds for `followups` (`question`, `asked_at` projected from
 * the `FollowUpRecord` document).
 *
 * Every read path maps a row through one helper per table, and every value that
 * leaves this module has been validated by the upstream schema that owns its
 * shape: `parseSessionRecord`, `parseInstrumentationPlan`, and the protocol's
 * capture, follow-up and bound-tab schemas. No shape is re-declared here; the
 * types this module exports are repository-local projections and option
 * objects that *embed* the upstream types.
 *
 * ## Results, not exceptions
 *
 * Every method returns a `Result`. An expected failure — a missing session a
 * write depends on, a duplicate key, a row that no longer parses, an argument
 * outside its domain, a capture already running — comes back as `err` with a
 * code from the shared vocabulary: `SESSION_NOT_FOUND`, `CAPTURE_ALREADY_ACTIVE`,
 * `SESSION_INVALID_STATE`, `PLAN_INVALID` or `STORE_ERROR`. Only a programmer
 * error is thrown: the one this module can detect is a session record about to
 * carry the request-key secret into its JSON column, which no caller can
 * recover from and every caller must be stopped by.
 *
 * Absence is not a failure. `get`, `getPlan`, `getCapture`, `getActiveCapture`
 * and the two binding lookups answer `ok(undefined)` for "no such row".
 *
 * ## Transactions and composition
 *
 * Multi-statement operations run inside `Store.transaction`, which opens
 * `BEGIN IMMEDIATE` at the outermost level and a savepoint when nested, so a
 * caller that already holds a transaction — the retention sweep, a session
 * manager persisting several changes at once — composes with these methods and
 * either all of it commits or none of it does. Inside a transaction every
 * refusal is decided *before* the first write, so returning an `err` never
 * commits half an operation; a write that fails throws inside the callback,
 * which rolls it back.
 *
 * ## Privacy
 *
 * A session row is among the most sensitive data the product stores: the
 * developer's question, an absolute project path, a dev-server URL, source file
 * paths. So nothing in this module logs a record, a row, a question, a path or a
 * URL — log lines and error `details` carry identifiers (`sessionId`,
 * `captureId`, `tabId`, a plan version), statuses and counts only. A row that no
 * longer parses is reported by the id of the row and never by its content, and
 * a JSON parse failure is reported without the engine's own message, which
 * quotes a fragment of the text it could not parse.
 *
 * `session_keys.request_key` is the one secret stored as a value. It is returned
 * by {@link SessionsRepo.getOrCreateRequestKeySecret} and by no other method,
 * it is never logged, never placed in an error, and every write of a session
 * record is checked for it — by field name at the top level of the document,
 * and by value across the whole serialised document — before the row is
 * written.
 *
 * All SQL goes through `Store.statement` with bound parameters only. Statement
 * text is a module constant or is assembled from module-constant fragments and
 * placeholder counts, never from a value.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';

import { parseInstrumentationPlan } from '@debuggen/instrumentation';
import type { InstrumentationPlan } from '@debuggen/instrumentation';
import {
  PROGRESS_STATUSES,
  SESSION_STATUSES,
  boundTabSchema,
  captureRecordSchema,
  followUpRecordSchema,
  isSessionStatus,
  parseSessionRecord,
  protocolParseError,
  touchSessionRecord,
} from '@debuggen/protocol';
import type {
  BoundTab,
  CaptureRecord,
  FollowUpRecord,
  ProgressStatus,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  newCaptureId,
  noopLogger,
  nowEpochMs,
  ok,
} from '@debuggen/shared';
import type { CaptureId, Logger, Result, SessionId } from '@debuggen/shared';

import { LOG_BINDING_KEYS } from '../logging.js';
import type { Store } from './db.js';

/* -------------------------------------------------------------------------------------------------
 * Bindings and bounds
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` binding every record from this repository carries, matching
 * `./db.ts`, `./migrations.ts` and the sibling repositories, so store lines can
 * be filtered out of a session's log without matching on message text.
 */
const SUBSYSTEM = 'store';

/**
 * The `repo` binding, which tells this repository's records apart from the
 * other repositories sharing the `store` subsystem.
 */
const REPO = 'sessions';

/** The field name the `repo` binding is emitted under. */
const REPO_BINDING_KEY = 'repo';

/**
 * How many sessions {@link SessionsRepo.list} returns when the caller names no
 * `limit`: one screen of the editor's Sessions tree.
 */
export const DEFAULT_SESSION_LIST_LIMIT = 50;

/**
 * The largest page {@link SessionsRepo.list} serves.
 *
 * A caller asking for more is refused rather than silently truncated, so a
 * retention sweep or a route that pages through every session always knows
 * whether it has seen the last page (`total` says so). The list reads indexed
 * columns only, so a thousand rows is a cheap page.
 */
export const MAX_SESSION_LIST_LIMIT = 1000;

/**
 * How many random bytes a per-session request-key secret carries: 32, rendered
 * as 64 lowercase hexadecimal characters — the key width the keyed-hash
 * grouping in `@debuggen/telemetry` requires.
 */
const REQUEST_KEY_SECRET_BYTES = 32;

/**
 * The exact shape of a stored secret, checked on every read so a row altered by
 * something other than this module is reported as corrupt instead of being
 * handed to the keyed hash as key material.
 */
const REQUEST_KEY_SECRET_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Top-level `SessionRecord` field names that would mean the request-key secret
 * — or something shaped like it — has been added to the session document.
 *
 * Checked against the **top level** only, on purpose: a capture summary nested
 * inside the record legitimately carries per-group `requestKey` *digests*
 * (keyed-hash outputs, not the key), and a deep name scan would refuse every
 * session with a stopped capture. The value check in
 * {@link SessionsRepo.update}'s write path covers every depth instead: it looks
 * for the secret itself in the serialised document.
 */
const SECRET_FIELD_NAME_PATTERN = /(?:request|session)[-_]?key|secret/i;

/**
 * The shape an identifier must have before it is written into an error
 * *message*. Ids minted by `@debuggen/shared` (`ses_…`, `cap_…`) always match;
 * a key column altered by hand to hold arbitrary text does not, and is then
 * named only in `details`, so a message can never carry stored content.
 */
const MESSAGE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The extended SQLite result codes `node:sqlite` reports on the `errcode`
 * property of a thrown constraint failure. Stable SQLite values, matched so the
 * classification never depends on message text.
 */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

/** A `UNIQUE` index refused the row. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** A `REFERENCES sessions (id)` edge found no session. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

/* -------------------------------------------------------------------------------------------------
 * Statements
 *
 * Every text below is a module constant or is assembled, once per query shape,
 * from module-constant fragments and placeholder counts. No value ever reaches
 * a statement's text: values are bound, which is both the injection defence and
 * what keeps every parameter out of the prepared-statement cache's keys.
 * ---------------------------------------------------------------------------------------------- */

/**
 * `?` placeholders, joined. Only ever called with a count, never with a value.
 *
 * @param count How many placeholders to emit.
 * @returns The joined placeholder list.
 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * The columns of `sessions`, in the order {@link sessionRowValues} binds them.
 * `record` is the authoritative document; the rest are its projections.
 */
const SESSION_COLUMNS: readonly string[] = Object.freeze([
  'id',
  'project_root',
  'project_name',
  'status',
  'question',
  'dev_server_url',
  'created_at',
  'updated_at',
  'record',
]);

/** Inserts a new session; a duplicate id is refused by the primary key. */
const INSERT_SESSION_SQL = `INSERT INTO sessions (${SESSION_COLUMNS.join(', ')})
VALUES (${placeholders(SESSION_COLUMNS.length)})`;

/**
 * Inserts or replaces a session in one statement.
 *
 * `created_at` is deliberately absent from the `SET` list: a session's creation
 * time is immutable, and the write path also restores the stored value into the
 * document so the column and the JSON agree.
 */
const UPSERT_SESSION_SQL = `${INSERT_SESSION_SQL}
ON CONFLICT (id) DO UPDATE SET
  project_root = excluded.project_root,
  project_name = excluded.project_name,
  status = excluded.status,
  question = excluded.question,
  dev_server_url = excluded.dev_server_url,
  updated_at = excluded.updated_at,
  record = excluded.record`;

/**
 * Rewrites an existing session's projections and document together, binding
 * the same values as {@link INSERT_SESSION_SQL} minus `created_at` with the id
 * moved to the end, so a status change can never update one without the other.
 */
const REWRITE_SESSION_SQL = `UPDATE sessions SET
  project_root = ?,
  project_name = ?,
  status = ?,
  question = ?,
  dev_server_url = ?,
  updated_at = ?,
  record = ?
WHERE id = ?`;

/** Reads one session's document. */
const SELECT_SESSION_SQL = 'SELECT id, record FROM sessions WHERE id = ?';

/** Reads the two stamps the upsert path reconciles against. */
const SELECT_SESSION_STAMPS_SQL = 'SELECT created_at, updated_at FROM sessions WHERE id = ?';

/**
 * Removes one session. Every child table references `sessions (id)` with
 * `ON DELETE CASCADE`, so this one statement removes the whole session.
 */
const DELETE_SESSION_SQL = 'DELETE FROM sessions WHERE id = ?';

/** The projection columns {@link SessionsRepo.list} reads, never the document. */
const SESSION_LIST_COLUMNS =
  'id, project_root, project_name, status, question, created_at, updated_at';

/** The `project_root` filter of the session list, served by its index. */
const PROJECT_ROOT_TERM = 'project_root = ?';

/**
 * How many slots the session-status filter binds: the full width of the status
 * vocabulary. A shorter filter repeats one of its own values to fill the rest,
 * which cannot change which rows match and keeps one statement text per shape.
 */
const STATUS_SLOTS = SESSION_STATUSES.length;

/** The fixed-width status filter of the session list. */
const STATUS_TERM = `status IN (${placeholders(STATUS_SLOTS)})`;

/** The retention filter of the session list, served by the `updated_at` index. */
const UPDATED_BEFORE_TERM = 'updated_at < ?';

/**
 * The stable order of the session list: most recently updated first, the id
 * breaking a tie so consecutive pages neither repeat nor skip a session.
 */
const SESSION_LIST_ORDER = 'ORDER BY updated_at DESC, id DESC';

/** Appends one progress line; `detail` is JSON text or `NULL`. */
const INSERT_PROGRESS_SQL = `INSERT INTO session_progress (session_id, stage, status, message, detail, ts)
VALUES (?, ?, ?, ?, ?, ?)`;

/**
 * Reads a session's progress in append order after a cursor. The
 * autoincrement id *is* the append order; a negative `LIMIT` means no limit.
 */
const SELECT_PROGRESS_SQL = `SELECT id, session_id, stage, status, message, detail, ts
FROM session_progress
WHERE session_id = ? AND id > ?
ORDER BY id ASC
LIMIT ?`;

/** Stores one plan version; the composite primary key refuses a duplicate. */
const INSERT_PLAN_SQL = `INSERT INTO plans (session_id, plan_version, plan, created_at)
VALUES (?, ?, ?, ?)`;

/** Reads one plan version. */
const SELECT_PLAN_SQL = `SELECT session_id, plan_version, plan FROM plans
WHERE session_id = ? AND plan_version = ?`;

/** Reads a session's plan ladder, oldest version first. */
const SELECT_PLANS_SQL = `SELECT session_id, plan_version, plan FROM plans
WHERE session_id = ?
ORDER BY plan_version ASC`;

/** The newest plan version of a session, `NULL` when it has none. */
const SELECT_LATEST_PLAN_VERSION_SQL =
  'SELECT MAX(plan_version) AS latest FROM plans WHERE session_id = ?';

/** The columns every capture read selects. */
const CAPTURE_COLUMNS = 'id, session_id, plan_version, started_at, stopped_at, summary';

/** Opens a capture window: no stop time and no summary until it closes. */
const INSERT_CAPTURE_SQL = `INSERT INTO captures (id, session_id, plan_version, started_at, stopped_at, summary)
VALUES (?, ?, ?, ?, NULL, NULL)`;

/** Reads one capture. */
const SELECT_CAPTURE_SQL = `SELECT ${CAPTURE_COLUMNS} FROM captures WHERE id = ?`;

/**
 * The open capture of a session, served by the partial index over
 * `stopped_at IS NULL`. Should a crash have left more than one open, the newest
 * is the one reported, deterministically.
 */
const SELECT_ACTIVE_CAPTURE_SQL = `SELECT ${CAPTURE_COLUMNS} FROM captures
WHERE session_id = ? AND stopped_at IS NULL
ORDER BY started_at DESC, rowid DESC
LIMIT 1`;

/**
 * The id of a session's open capture, when only its existence matters: the
 * start guard must refuse even when that row is otherwise unreadable.
 */
const SELECT_ACTIVE_CAPTURE_ID_SQL = `SELECT id FROM captures
WHERE session_id = ? AND stopped_at IS NULL
ORDER BY started_at DESC, rowid DESC
LIMIT 1`;

/** A session's captures, oldest first; `rowid` breaks a same-millisecond tie. */
const SELECT_CAPTURES_SQL = `SELECT ${CAPTURE_COLUMNS} FROM captures
WHERE session_id = ?
ORDER BY started_at ASC, rowid ASC`;

/**
 * Closes a capture. The trailing `stopped_at IS NULL` is an optimistic guard:
 * a capture another writer already closed matches no row.
 */
const STOP_CAPTURE_SQL = `UPDATE captures SET stopped_at = ?, summary = ?
WHERE id = ? AND stopped_at IS NULL`;

/** Appends one follow-up; the autoincrement id is the order it was asked in. */
const INSERT_FOLLOWUP_SQL = `INSERT INTO followups (session_id, question, asked_at, record)
VALUES (?, ?, ?, ?)`;

/** A session's follow-ups in the order they were asked. */
const SELECT_FOLLOWUPS_SQL = `SELECT id, record FROM followups
WHERE session_id = ?
ORDER BY id ASC`;

/** The columns every binding read selects. */
const BINDING_COLUMNS = 'tab_id, session_id, url, bound_at';

/** The binding of one tab (the primary key). */
const SELECT_BINDING_BY_TAB_SQL = `SELECT ${BINDING_COLUMNS} FROM bindings WHERE tab_id = ?`;

/** The binding of one session (the unique index). */
const SELECT_BINDING_BY_SESSION_SQL = `SELECT ${BINDING_COLUMNS} FROM bindings WHERE session_id = ?`;

/** Records a binding. */
const INSERT_BINDING_SQL = `INSERT INTO bindings (${BINDING_COLUMNS}) VALUES (${placeholders(4)})`;

/** Drops the binding of one tab. */
const DELETE_BINDING_BY_TAB_SQL = 'DELETE FROM bindings WHERE tab_id = ?';

/** Drops the binding of one session. */
const DELETE_BINDING_BY_SESSION_SQL = 'DELETE FROM bindings WHERE session_id = ?';

/** Reads a session's request-key secret. Never logged, never selected elsewhere. */
const SELECT_REQUEST_KEY_SQL = 'SELECT request_key FROM session_keys WHERE session_id = ?';

/**
 * Stores a freshly minted secret unless one already exists. `DO NOTHING` makes
 * a racing second writer a no-op, so the read that follows returns the one key
 * the session will ever have. A missing session still fails: the conflict
 * clause covers uniqueness only, never the foreign key.
 */
const INSERT_REQUEST_KEY_SQL = `INSERT INTO session_keys (session_id, request_key, created_at)
VALUES (?, ?, ?)
ON CONFLICT (session_id) DO NOTHING`;

/** Whether a session has a secret, answered without selecting the value. */
const SELECT_REQUEST_KEY_EXISTS_SQL = 'SELECT 1 AS present FROM session_keys WHERE session_id = ?';

/** Drops a session's secret. */
const DELETE_REQUEST_KEY_SQL = 'DELETE FROM session_keys WHERE session_id = ?';

/* -------------------------------------------------------------------------------------------------
 * Public types
 *
 * Repository-local projections and option objects only. Every shape another
 * process sees — the session record, a capture, a follow-up, a bound tab, a
 * plan — is the upstream type, embedded rather than restated.
 * ---------------------------------------------------------------------------------------------- */

/** What {@link createSessionsRepo} is constructed from. */
export interface SessionsRepoDeps {
  /**
   * The open, migrated store handle from `./db.ts`. The repository owns no
   * connection of its own, so its statements share the store's cache and its
   * writes join whatever transaction a caller has already opened.
   */
  readonly store: Store;

  /**
   * Where the repository reports what it persisted. Defaults to the shared
   * no-op logger. A child bound to `{ subsystem: 'store', repo: 'sessions' }` is
   * derived from it; records carry identifiers, statuses and counts only.
   */
  readonly logger?: Logger | undefined;

  /**
   * Reads the current epoch-millisecond time for every timestamp this module
   * stamps. Defaults to `nowEpochMs()`. Injectable so a suite can assert exact
   * rows without fake timers.
   */
  readonly now?: (() => number) | undefined;
}

/**
 * One row of the session list: the indexed projections of a session, read
 * without parsing its document.
 *
 * Backs the editor's Sessions tree and `GET /sessions` paging, and is what the
 * retention sweep enumerates purge candidates with. Fetch the whole record with
 * {@link SessionsRepo.get} when more than this is needed.
 */
export interface SessionListItem {
  /** The session's id. */
  readonly id: SessionId;
  /** The absolute POSIX root of the project the session debugs. */
  readonly projectRoot: string;
  /** The project's display name. */
  readonly projectName: string;
  /** Where the session is in the pipeline. */
  readonly status: SessionStatus;
  /** The developer's original question, as typed. Display text only. */
  readonly question: string;
  /** When the session was created, in epoch milliseconds. */
  readonly createdAt: number;
  /** When the session last changed, in epoch milliseconds. */
  readonly updatedAt: number;
}

/** Narrowing and paging for {@link SessionsRepo.list}. All members optional. */
export interface ListSessionsOptions {
  /** Keep only the sessions of this exact project root. */
  readonly projectRoot?: string | undefined;

  /**
   * Keep only the sessions in these statuses. Absent means every status; an
   * **empty** array selects nothing and answers an empty page with a `total` of
   * zero rather than every session. A value outside the vocabulary is refused.
   */
  readonly statuses?: readonly SessionStatus[] | undefined;

  /**
   * Keep only the sessions last updated strictly before this epoch-millisecond
   * instant — the retention sweep's purge-candidate filter.
   */
  readonly updatedBefore?: number | undefined;

  /**
   * The page size: an integer from 0 to {@link MAX_SESSION_LIST_LIMIT},
   * defaulting to {@link DEFAULT_SESSION_LIST_LIMIT}. `0` is a count-only
   * request: an empty page and the real `total`.
   */
  readonly limit?: number | undefined;

  /** How many matching sessions to skip, a non-negative integer. Defaults to 0. */
  readonly offset?: number | undefined;
}

/** One page of the session list. */
export interface SessionListPage {
  /** The sessions on this page, most recently updated first. */
  readonly items: readonly SessionListItem[];
  /** How many sessions match the filter in total, before `limit` and `offset`. */
  readonly total: number;
}

/**
 * One progress line to append.
 *
 * The same fields as a `session.progress` payload, which is what a reopened
 * session's progress view is replayed from, plus the optional timestamp.
 */
export interface AppendProgressInput {
  /** The session the line belongs to. */
  readonly sessionId: SessionId;
  /** Which stage is reporting — a pipeline stage name, non-empty. */
  readonly stage: string;
  /** Whether that stage is working, finished or failed. */
  readonly status: ProgressStatus;
  /** The line a surface shows, built by the service from what the stage found. */
  readonly message: string;
  /**
   * Optional structured detail, stored as JSON text. Must be JSON-serialisable;
   * absent (or `undefined`) stores no detail.
   */
  readonly detail?: unknown;
  /** When the line was produced, in epoch milliseconds. Defaults to `now()`. */
  readonly ts?: number | undefined;
}

/** One stored progress line, as {@link SessionsRepo.listProgress} returns it. */
export interface ProgressEntry {
  /**
   * The row's autoincrement id: the append order, and the cursor to pass as
   * {@link ListProgressOptions.sinceId} to read only what came after it.
   */
  readonly id: number;
  /** The session the line belongs to. */
  readonly sessionId: SessionId;
  /** The reporting stage. */
  readonly stage: string;
  /** The stage's status. */
  readonly status: ProgressStatus;
  /** The line itself. */
  readonly message: string;
  /** The structured detail, parsed back from JSON; absent when none was stored. */
  readonly detail?: unknown;
  /** When the line was produced, in epoch milliseconds. */
  readonly ts: number;
}

/** Cursor and page size for {@link SessionsRepo.listProgress}. */
export interface ListProgressOptions {
  /** Return only lines appended after the line with this id. Defaults to 0. */
  readonly sinceId?: number | undefined;
  /** At most this many lines, a non-negative integer. Absent means all of them. */
  readonly limit?: number | undefined;
}

/**
 * A capture summary, as `@debuggen/telemetry` computes it. Named here from the
 * upstream `CaptureRecord` member rather than restated: the store treats it as
 * opaque, persisting and returning it without re-validating its internals.
 */
export type StoredCaptureSummary = NonNullable<CaptureRecord['summary']>;

/** What {@link SessionsRepo.startCapture} opens. */
export interface StartCaptureInput {
  /** The session the capture belongs to. */
  readonly sessionId: SessionId;
  /** The plan version installed while this capture runs, a positive integer. */
  readonly planVersion: number;
  /** The capture's id. Minted with `newCaptureId()` when absent. */
  readonly captureId?: CaptureId | undefined;
  /** When the capture started, in epoch milliseconds. Defaults to `now()`. */
  readonly startedAt?: number | undefined;
}

/** What {@link SessionsRepo.stopCapture} closes. */
export interface StopCaptureInput {
  /** The capture to close. */
  readonly captureId: CaptureId;
  /**
   * When it stopped, in epoch milliseconds. Defaults to `now()`, raised to the
   * start time should the clock read earlier; an explicit value earlier than
   * the start time is refused.
   */
  readonly stoppedAt?: number | undefined;
  /**
   * The aggregate the capture produced. Absent only for a capture that
   * produced nothing worth summarising.
   */
  readonly summary?: StoredCaptureSummary | undefined;
}

/**
 * A capture as the store holds it: the upstream `CaptureRecord` plus the
 * session that owns it.
 *
 * Nested rather than merged on purpose. `capture` is exactly the element a
 * `SessionRecord.captures` array holds — a strict schema that would refuse an
 * extra `sessionId` key — so it can be placed on a record as-is, while
 * `sessionId` answers the ownership question a caller holding only a capture id
 * has to ask.
 */
export interface StoredCapture {
  /** The session the capture belongs to. */
  readonly sessionId: SessionId;
  /** The capture, validated by the protocol's capture schema. */
  readonly capture: CaptureRecord;
}

/** What {@link SessionsRepo.upsertBinding} records. */
export interface UpsertBindingInput {
  /** The browser's tab id, a non-negative integer. */
  readonly tabId: number;
  /** The session the tab is bound to. */
  readonly sessionId: SessionId;
  /** The tab's document URL at bind time: the basis of later origin checks. */
  readonly url: string;
  /** When the binding was made, in epoch milliseconds. Defaults to `now()`. */
  readonly boundAt?: number | undefined;
}

/**
 * One tab binding as the store holds it.
 *
 * `tab` is exactly a `SessionRecord.boundTab` value, so the session manager can
 * mirror the binding onto the record without an adapter.
 */
export interface TabBinding {
  /** The session the tab belongs to. */
  readonly sessionId: SessionId;
  /** The bound tab, validated by the protocol's bound-tab schema. */
  readonly tab: BoundTab;
  /** When the binding was made, in epoch milliseconds. */
  readonly boundAt: number;
}

/**
 * The outcome of {@link SessionsRepo.upsertBinding}: the new binding and the
 * two bindings it may have replaced, which is what the caller announces with
 * `session.bound` (AAP §0.2.3: a second bind replaces the first and is
 * announced).
 */
export interface BindingUpsert {
  /** The binding now stored. */
  readonly binding: TabBinding;
  /**
   * The binding this **session** held before, when it was a different tab: that
   * tab no longer receives the session's agent configuration or panels.
   */
  readonly displacedTab?: TabBinding;
  /**
   * The binding this **tab** held before, when it belonged to a different
   * session: that session has lost its tab.
   */
  readonly displacedSession?: TabBinding;
}

/**
 * The sessions repository, over the session store.
 *
 * Every method is synchronous — `node:sqlite` is — and answers with a
 * {@link Result}; see this module's overview for which failures are returned
 * and the single one that is thrown. Nothing is mutated in place: every value
 * returned is the validated value that was stored or read.
 */
export interface SessionsRepo {
  /**
   * Stores a new session.
   *
   * The record is validated with `parseSessionRecord` before anything is
   * written; timestamps are canonicalised to whole milliseconds (the columns are
   * `STRICT` integers) in the document and the columns alike.
   *
   * @param record The new session's record.
   * @returns The record as stored, or `err`: `STORE_ERROR` when the record does
   * not satisfy the session contract (`details.reason` `invalid-record`) or a
   * session with its id already exists (`duplicate-session`).
   * @throws {DebuggenError} `INTERNAL` when the record would carry the
   * request-key secret into the document — a programmer error.
   */
  insert(record: SessionRecord): Result<SessionRecord>;

  /**
   * Persists a session, inserting it when absent and replacing it otherwise —
   * the call the session manager makes after every state change.
   *
   * `updatedAt` is stamped with the latest of the record's own value, `now()`
   * and the stored value, so it never moves backwards. `createdAt` is
   * immutable: a stored session keeps its original creation time, which is
   * written back into the returned document.
   *
   * @param record The session's new state.
   * @returns The record as stored (with the reconciled stamps), or `err`
   * `STORE_ERROR` (`invalid-record`).
   * @throws {DebuggenError} `INTERNAL` on the request-key guard, as for
   * {@link SessionsRepo.insert}.
   */
  update(record: SessionRecord): Result<SessionRecord>;

  /**
   * Reads one session.
   *
   * @param id The session's id.
   * @returns `ok(record)`, `ok(undefined)` when no such session exists, or
   * `err` `STORE_ERROR` (`corrupt-row`) when the stored document no longer
   * parses — reported by id, never by content.
   */
  get(id: SessionId): Result<SessionRecord | undefined>;

  /**
   * Persists a status the session state machine has decided on.
   *
   * Transition **legality** is owned by `src/sessions/state-machine.ts`, not
   * here: this method persists a decision it does not make. It validates the
   * status against `SESSION_STATUSES`, stamps `updatedAt`, and rewrites the
   * `status` column and the document in one transaction so the projection can
   * never drift from the record.
   *
   * @param id The session's id.
   * @param status The new status.
   * @returns The record as stored, or `err`: `STORE_ERROR` for a status outside
   * the vocabulary (`unknown-status`) or a corrupt row, `SESSION_NOT_FOUND`
   * when no such session exists.
   * @throws {DebuggenError} `INTERNAL` on the request-key guard.
   */
  setStatus(id: SessionId, status: SessionStatus): Result<SessionRecord>;

  /**
   * Lists sessions from their indexed projections, most recently updated
   * first (`updated_at DESC, id DESC`), with a `total` over the same filter.
   *
   * Backs `GET /sessions` and the editor's Sessions tree; `updatedBefore` is how
   * `./retention.ts` finds purge candidates. Items and total are read inside
   * one transaction, so they describe the same state.
   *
   * @param options Filters and paging; see {@link ListSessionsOptions}.
   * @returns The page, or `err` `STORE_ERROR` for an option outside its domain
   * (`invalid-argument`, `unknown-status`) or a row whose projections are
   * unreadable (`corrupt-row`).
   */
  list(options?: ListSessionsOptions): Result<SessionListPage>;

  /**
   * Deletes one session and, through the schema's `ON DELETE CASCADE` edges,
   * everything scoped to it: progress, plans, captures and their telemetry,
   * panels, analyses, follow-ups, its binding, its request-key secret — and its
   * modification journal rows.
   *
   * That cascade is why per-session purging is a single statement, and it only
   * holds because `./db.ts` sets `PRAGMA foreign_keys = ON` on every connection
   * it opens. It is also why the caller owns the precondition: the retention
   * sweep must first establish through `./modifications-repo.ts` that no
   * modification of the session is still open, because the journal is the only
   * record able to restore a patched file.
   *
   * @param id The session's id.
   * @returns How many sessions were deleted (0 or 1), or `err` `STORE_ERROR`.
   */
  delete(id: SessionId): Result<number>;

  /**
   * Appends one line to a session's progress log.
   *
   * @param entry The line; see {@link AppendProgressInput}.
   * @returns `ok(undefined)`, or `err`: `STORE_ERROR` for a field outside its
   * domain (`invalid-argument`) or an unserialisable detail
   * (`unserializable-detail`), `SESSION_NOT_FOUND` when the session does not
   * exist.
   */
  appendProgress(entry: AppendProgressInput): Result<void>;

  /**
   * Reads a session's progress log in **insertion order** — the autoincrement
   * id, never the timestamp — which is the order the editor's progress view
   * replays for a reopened session.
   *
   * @param sessionId The session's id.
   * @param options An optional cursor and page size.
   * @returns The lines, or `err` `STORE_ERROR` (`invalid-argument`,
   * `corrupt-row`).
   */
  listProgress(sessionId: SessionId, options?: ListProgressOptions): Result<ProgressEntry[]>;

  /**
   * Stores one version of a session's instrumentation plan, keyed by
   * `plan.sessionId` and `plan.planVersion`.
   *
   * The composite primary key makes the follow-up ladder a database invariant:
   * version n + 1 is a new row and can never overwrite version n.
   *
   * @param plan A normalised plan.
   * @returns The plan as stored, or `err`: `PLAN_INVALID` when it fails the
   * normalised plan schema, `STORE_ERROR` when that version already exists
   * (`duplicate-plan-version`), `SESSION_NOT_FOUND` when its session does not.
   */
  insertPlan(plan: InstrumentationPlan): Result<InstrumentationPlan>;

  /**
   * Reads one plan version, validated with the normalised plan schema.
   *
   * @param sessionId The session's id.
   * @param planVersion The version, a positive integer.
   * @returns `ok(plan)`, `ok(undefined)` when that version does not exist, or
   * `err` `STORE_ERROR` (`invalid-argument`, `corrupt-row`).
   */
  getPlan(sessionId: SessionId, planVersion: number): Result<InstrumentationPlan | undefined>;

  /**
   * Reads a session's whole plan ladder, oldest version first.
   *
   * @param sessionId The session's id.
   * @returns The plans, or `err` `STORE_ERROR` (`corrupt-row`).
   */
  listPlans(sessionId: SessionId): Result<InstrumentationPlan[]>;

  /**
   * The newest plan version a session has stored.
   *
   * @param sessionId The session's id.
   * @returns `ok(version)`, `ok(undefined)` when it has no plan yet, or `err`
   * `STORE_ERROR` (`corrupt-row`).
   */
  latestPlanVersion(sessionId: SessionId): Result<number | undefined>;

  /**
   * The version the session's next plan must carry: one more than the newest
   * stored, or 1 for a session with no plan.
   *
   * @param sessionId The session's id.
   * @returns The version, or `err` `STORE_ERROR` (`corrupt-row`).
   */
  nextPlanVersion(sessionId: SessionId): Result<number>;

  /**
   * Opens a capture window for a session.
   *
   * Refuses while the session already has an open capture: this is the
   * store-side half of the rule that one capture runs at a time (AAP §0.4.2),
   * whose `409 { owningSessionId }` answer across a project is produced by
   * `src/sessions/manager.ts`. The check and the insert run in one transaction.
   *
   * @param input The session, plan version and optional id and start time.
   * @returns The opened capture, or `err`: `CAPTURE_ALREADY_ACTIVE` with
   * `details.activeCaptureId`, `STORE_ERROR` for an input outside its domain
   * (`invalid-argument`) or a reused capture id (`duplicate-capture`),
   * `SESSION_NOT_FOUND` when the session does not exist.
   */
  startCapture(input: StartCaptureInput): Result<StoredCapture>;

  /**
   * Closes a capture window, writing its summary.
   *
   * @param input The capture, an optional stop time and the summary.
   * @returns The closed capture, or `err`: `SESSION_INVALID_STATE` when the
   * capture is already stopped (`capture-already-stopped`), `STORE_ERROR` when
   * no such capture exists (`capture-not-found`), the stop time precedes the
   * start (`stop-before-start`), the summary is not a capture summary
   * (`invalid-capture`) or cannot be serialised, or the row is corrupt.
   */
  stopCapture(input: StopCaptureInput): Result<StoredCapture>;

  /**
   * Reads one capture.
   *
   * @param captureId The capture's id.
   * @returns `ok(capture)`, `ok(undefined)` when it does not exist, or `err`
   * `STORE_ERROR` (`corrupt-row`).
   */
  getCapture(captureId: CaptureId): Result<StoredCapture | undefined>;

  /**
   * Reads the open capture of a session — the row whose `stopped_at` is `NULL`.
   *
   * @param sessionId The session's id.
   * @returns `ok(capture)`, `ok(undefined)` when none is open, or `err`
   * `STORE_ERROR` (`corrupt-row`).
   */
  getActiveCapture(sessionId: SessionId): Result<StoredCapture | undefined>;

  /**
   * Reads every capture of a session, oldest first.
   *
   * @param sessionId The session's id.
   * @returns The captures, or `err` `STORE_ERROR` (`corrupt-row`).
   */
  listCaptures(sessionId: SessionId): Result<StoredCapture[]>;

  /**
   * Appends a follow-up question to a session's follow-up log.
   *
   * The `FollowUpRecord` document is authoritative and `question` / `asked_at`
   * are its projections. The record carries no session id of its own — it is an
   * element of `SessionRecord.followUps` — so the owning session is named here.
   * The outcome links a follow-up acquires later (the capture, analysis and
   * panel that answered it) are persisted on the session record through
   * {@link SessionsRepo.update}.
   *
   * @param sessionId The session the question was asked in.
   * @param record The follow-up as it was asked.
   * @returns The record as stored, or `err`: `STORE_ERROR` when it fails the
   * follow-up schema (`invalid-follow-up`), `SESSION_NOT_FOUND` when the
   * session does not exist.
   */
  appendFollowUp(sessionId: SessionId, record: FollowUpRecord): Result<FollowUpRecord>;

  /**
   * Reads a session's follow-ups in the order they were asked.
   *
   * @param sessionId The session's id.
   * @returns The records, or `err` `STORE_ERROR` (`corrupt-row`).
   */
  listFollowUps(sessionId: SessionId): Result<FollowUpRecord[]>;

  /**
   * Binds a tab to a session, replacing whatever either was bound to.
   *
   * Inside one transaction it removes any binding of the session and any
   * binding of the tab, then inserts the new one — the AAP §0.2.3 rule that one
   * tab binds to at most one session and one session to at most one tab, with
   * a second bind replacing the first. The replaced bindings are returned so
   * the caller can announce them. Mirroring the binding onto
   * `SessionRecord.boundTab` is the session manager's write, through
   * {@link SessionsRepo.update}.
   *
   * @param input The tab, the session, the tab's URL and the bind time.
   * @returns The new binding and the displaced ones, or `err`: `STORE_ERROR`
   * for an invalid tab (`invalid-binding`) or an unreadable existing binding
   * (`corrupt-row`, removable with {@link SessionsRepo.deleteBinding}),
   * `SESSION_NOT_FOUND` when the session does not exist.
   */
  upsertBinding(input: UpsertBindingInput): Result<BindingUpsert>;

  /**
   * Reads the binding of one tab.
   *
   * @param tabId The browser's tab id.
   * @returns `ok(binding)`, `ok(undefined)` when the tab is unbound, or `err`
   * `STORE_ERROR` (`invalid-argument`, `corrupt-row`).
   */
  getBindingByTab(tabId: number): Result<TabBinding | undefined>;

  /**
   * Reads the binding of one session.
   *
   * @param sessionId The session's id.
   * @returns `ok(binding)`, `ok(undefined)` when no tab is bound, or `err`
   * `STORE_ERROR` (`corrupt-row`).
   */
  getBindingBySession(sessionId: SessionId): Result<TabBinding | undefined>;

  /**
   * Removes the binding of one tab — on `session.unbind`, a tab closing or a
   * navigation to another origin. Needs no readable row, so it is also how an
   * unreadable binding is cleared.
   *
   * @param tabId The browser's tab id.
   * @returns How many bindings were removed (0 or 1), or `err` `STORE_ERROR`.
   */
  deleteBinding(tabId: number): Result<number>;

  /**
   * Removes the binding of one session — on `session.end`.
   *
   * @param sessionId The session's id.
   * @returns How many bindings were removed (0 or 1), or `err` `STORE_ERROR`.
   */
  deleteBindingsForSession(sessionId: SessionId): Result<number>;

  /**
   * Returns the session's request-key secret, minting it on first use.
   *
   * The secret keys the `request_key = HMAC-SHA-256(secret, method + path +
   * sorted query pairs)` grouping computed at ingest from the *unredacted* URL
   * (AAP §0.5.2), which is how two requests differing only in a parameter value
   * stay distinct while byte-identical ones collide. A new secret is 32 bytes
   * from `node:crypto`'s `randomBytes`, hex-encoded, stored with
   * `INSERT … ON CONFLICT DO NOTHING` and then read back inside one transaction,
   * so two ingest batches racing on a new session can never produce two keys.
   *
   * **Three prohibitions hold for the returned value:** it is never logged, it
   * is never serialised into a `SessionRecord`, and it is never sent over HTTP
   * or WebSocket. Its one consumer is `packages/telemetry/src/redaction/
   * request-key.ts`, reached through `src/telemetry/ingest.ts`. This is the only
   * method that returns it, and no error this module builds contains it.
   *
   * @param sessionId The session's id.
   * @returns The 64-character lowercase hex secret, or `err`:
   * `SESSION_NOT_FOUND` when the session does not exist, `STORE_ERROR` when the
   * stored value is not a well-formed secret (`corrupt-row`).
   */
  getOrCreateRequestKeySecret(sessionId: SessionId): Result<string>;

  /**
   * Whether a session already has a request-key secret, answered without
   * reading the value.
   *
   * @param sessionId The session's id.
   * @returns `ok(boolean)`, or `err` `STORE_ERROR`.
   */
  hasRequestKeySecret(sessionId: SessionId): Result<boolean>;

  /**
   * Deletes a session's request-key secret, for cleanup paths.
   *
   * The secret is otherwise retained for the whole lifetime of its session,
   * because a follow-up capture must produce the same `request_key` for a
   * byte-identical request as the first capture did, and it is removed with the
   * session by the cascade during retention. Deleting it earlier makes the
   * session's grouping keys unrecomputable, by design.
   *
   * @param sessionId The session's id.
   * @returns Whether a secret was removed, or `err` `STORE_ERROR`.
   */
  deleteRequestKeySecret(sessionId: SessionId): Result<boolean>;
}

/* -------------------------------------------------------------------------------------------------
 * Values and rows
 * ---------------------------------------------------------------------------------------------- */

/**
 * The value types this module binds: text, integers and `NULL` for the
 * nullable columns. Nothing binds a `bigint` or a buffer, so a mistyped value
 * is a compile error rather than a `STRICT`-table failure at run time.
 */
type BoundValue = string | number | null;

/** A row as `node:sqlite` hands it back, before validation. */
type StoredRow = Record<string, unknown>;

/**
 * Reads the extended SQLite result code off a thrown value.
 *
 * @param cause Whatever was caught.
 * @returns The numeric code, or `undefined` when the value is not a SQLite error.
 */
function sqliteErrcode(cause: unknown): number | undefined {
  if (typeof cause === 'object' && cause !== null && 'errcode' in cause) {
    const { errcode } = cause;

    return typeof errcode === 'number' ? errcode : undefined;
  }

  return undefined;
}

/**
 * Canonicalises an epoch-millisecond reading for a `STRICT` `INTEGER` column,
 * which refuses a fractional value outright. The rounded value is written to
 * the document as well, so the column and the JSON always agree. A non-finite
 * reading passes through for validation to reject.
 *
 * @param value The reading.
 * @returns Whole milliseconds, or `value` when it is not finite.
 */
function toEpochColumn(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : value;
}

/**
 * Reads an integer column. A `bigint` — only produced by a statement configured
 * for it, which this module never does — is accepted while it is safe.
 *
 * @param value The raw column value.
 * @returns The integer, or `undefined` when the column holds anything else.
 */
function readInteger(value: unknown): number | undefined {
  if (typeof value === 'bigint') {
    const converted = Number(value);

    return Number.isSafeInteger(converted) ? converted : undefined;
  }

  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Reads a text column.
 *
 * @param value The raw column value.
 * @returns The text, or `undefined` when the column holds anything else.
 */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * How many rows a write changed. `node:sqlite` types the count as
 * `number | bigint`; every write here changes a handful of rows at most.
 *
 * @param result What `StatementSync.run` returned.
 * @returns The change count.
 */
function changesOf(result: { readonly changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
}

/**
 * Whether `value` is a non-empty string, the minimum every id and label this
 * module binds must satisfy before the schemas that own them judge the rest.
 *
 * @param value The candidate.
 * @returns `true` for a string with at least one character.
 */
function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Whether `value` is a safe integer within `[min, max]`.
 *
 * @param value The candidate.
 * @param min The inclusive lower bound.
 * @param max The inclusive upper bound.
 * @returns `true` when it is.
 */
function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Whether `value` is a finite number: the domain of every timestamp argument.
 *
 * @param value The candidate.
 * @returns `true` when it is.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Serialises a value to JSON without letting the engine's error escape.
 *
 * `JSON.stringify` throws on a cycle or a `bigint` and answers `undefined` for
 * a function or a symbol; each is reported as `undefined` here so the caller
 * chooses a coded refusal. The thrown error is discarded rather than attached,
 * because its message names the structure of the value that failed.
 *
 * @param value The value to serialise.
 * @returns The JSON text, or `undefined` when the value is not serialisable.
 */
function stringifyJson(value: unknown): string | undefined {
  try {
    const text: unknown = JSON.stringify(value);

    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The outcome of {@link parseJsonColumn}: parsed, or unreadable. */
type JsonColumn = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * Parses a JSON text column without letting the engine's error escape.
 *
 * A `SyntaxError` from `JSON.parse` quotes a fragment of the text it could not
 * parse, and that text is a stored document — a question, a path, a URL — so
 * the error is discarded and the caller reports the row by id alone.
 *
 * @param value The raw column value.
 * @returns The parsed value, or the unreadable marker.
 */
function parseJsonColumn(value: unknown): JsonColumn {
  if (typeof value !== 'string') {
    return { ok: false };
  }

  try {
    const parsed: unknown = JSON.parse(value);

    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Errors
 *
 * Every error below carries identifiers, statuses, counts and a stable
 * `details.reason` — never a record, a row, a question, a path, a URL or the
 * request-key secret.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The diagnostic context every error of this module carries.
 *
 * @param operation The repository method that failed.
 * @param details Identifiers to add.
 * @returns The context object.
 */
function context(
  operation: string,
  details: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return { subsystem: SUBSYSTEM, [REPO_BINDING_KEY]: REPO, operation, ...details };
}

/**
 * Errors this module *throws*: programmer errors no caller can recover from.
 *
 * {@link attempt} converts everything else it catches into an `err`, and
 * rethrows a member of this set unchanged, so a guard violation raised inside a
 * transaction still rolls that transaction back and still reaches the caller as
 * an exception. Identity-based, so no caller can forge membership.
 */
const PROGRAMMER_ERRORS = new WeakSet<object>();

/**
 * Builds a programmer error and registers it for {@link attempt} to rethrow.
 *
 * @param message What invariant broke.
 * @param operation The repository method that detected it.
 * @param details Identifiers only.
 * @returns The coded error, ready to throw.
 */
function programmerError(
  message: string,
  operation: string,
  details: Readonly<Record<string, unknown>>,
): DebuggenError {
  const error = new DebuggenError('INTERNAL', message, {
    hint: 'This is a defect in Debug Generator rather than a setting: nothing was written. Report it with the service log.',
    details: context(operation, details),
  });
  PROGRAMMER_ERRORS.add(error);

  return error;
}

/**
 * Whether a caught value is one of this module's programmer errors.
 *
 * @param value Whatever was caught.
 * @returns `true` when it must be rethrown rather than returned.
 */
function isProgrammerError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && PROGRAMMER_ERRORS.has(value);
}

/**
 * An argument outside its domain: code `STORE_ERROR`, reason
 * `invalid-argument` unless a more specific one is named.
 *
 * @param operation The repository method that was called.
 * @param field The argument's name — an identifier from this module.
 * @param expectation What the argument must be, as a fixed phrase.
 * @param details Identifiers to add.
 * @param reason The stable `details.reason`.
 * @returns The coded error.
 */
function invalidArgumentError(
  operation: string,
  field: string,
  expectation: string,
  details: Readonly<Record<string, unknown>> = {},
  reason = 'invalid-argument',
): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    `The ${field} passed to the sessions repository must be ${expectation}.`,
    {
      hint: 'This is a defect in the caller rather than a setting: correct the argument and retry.',
      details: context(operation, { ...details, field, reason }),
    },
  );
}

/**
 * A session status outside the vocabulary: code `STORE_ERROR`, reason
 * `unknown-status`.
 *
 * @param operation The repository method that was called.
 * @param details Identifiers to add.
 * @returns The coded error.
 */
function unknownStatusError(
  operation: string,
  details: Readonly<Record<string, unknown>> = {},
): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The sessions repository was given a session status it does not know.',
    {
      hint: `Use one of: ${SESSION_STATUSES.join(', ')}.`,
      details: context(operation, { ...details, reason: 'unknown-status' }),
    },
  );
}

/**
 * No session with this id, where a write depends on one: code
 * `SESSION_NOT_FOUND`.
 *
 * @param operation The repository method that was called.
 * @param details Identifiers to add.
 * @param cause The foreign-key failure, when the schema reported it.
 * @returns The coded error.
 */
function sessionNotFoundError(
  operation: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): DebuggenError {
  return new DebuggenError(
    'SESSION_NOT_FOUND',
    'The session store holds no session with this id.',
    {
      hint: 'The session may have ended and been purged by retention. Start a new session from the editor.',
      details: context(operation, { ...details, reason: 'session-not-found' }),
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * A row that is in its table but is not what the table promises: code
 * `STORE_ERROR`, reason `corrupt-row`.
 *
 * Names the table and the row's identifiers and nothing else: the owning
 * session id appears in the message (when it has the shape of an id, see
 * {@link MESSAGE_IDENTIFIER_PATTERN}) and every identifier in `details`; the
 * row's stored content appears in neither. A schema failure travels as `cause`;
 * the upstream parse helpers already strip rejected values from their messages,
 * so the cause is safe to log in full.
 *
 * @param operation The repository method that read it.
 * @param table The table's name — an identifier from this module.
 * @param details The row's identifiers.
 * @param cause The validation failure, when there is one.
 * @returns The coded error.
 */
function corruptRowError(
  operation: string,
  table: string,
  details: Readonly<Record<string, unknown>>,
  cause?: DebuggenError,
): DebuggenError {
  const sessionId = details[LOG_BINDING_KEYS.sessionId];
  const subject =
    typeof sessionId === 'string' && MESSAGE_IDENTIFIER_PATTERN.test(sessionId)
      ? ` for session ${sessionId}`
      : '';

  return new DebuggenError(
    'STORE_ERROR',
    `A ${table} row${subject} in the session store no longer matches the shape the store writes.`,
    {
      hint: 'The session store may have been written by a different build of Debug Generator or altered by hand. Report the operation and identifiers with the service log.',
      details: context(operation, { ...details, table, reason: 'corrupt-row' }),
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * A value offered for storage that fails the schema owning its shape: code
 * `STORE_ERROR`.
 *
 * @param operation The repository method that was called.
 * @param message What was refused.
 * @param reason The stable `details.reason`.
 * @param cause The validation failure, whose details name field paths only.
 * @param details Identifiers to add.
 * @returns The coded error.
 */
function invalidValueError(
  operation: string,
  message: string,
  reason: string,
  cause: DebuggenError | undefined,
  details: Readonly<Record<string, unknown>> = {},
): DebuggenError {
  const issues = cause?.details?.['issues'];

  return new DebuggenError('STORE_ERROR', message, {
    hint: 'This is a defect in whatever built the value rather than a setting: the reported field paths identify it. Nothing was written.',
    details: context(operation, {
      ...details,
      reason,
      ...(issues === undefined ? {} : { issues }),
    }),
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Builds the refusal a primary-key or unique constraint maps to, specific to
 * the operation that provoked it.
 */
type DuplicateErrorFactory = (cause: unknown) => DebuggenError;

/**
 * The error for a store operation that failed for a reason of its own.
 *
 * Classifies the two constraint failures a correct caller can still provoke —
 * a duplicate key, through the operation's own `duplicate` factory, and a
 * session that does not exist — and reports everything else (a closed handle,
 * a disk failure, a statement this build cannot prepare) as `STORE_ERROR`.
 *
 * @param operation The repository method that failed.
 * @param cause Whatever was caught.
 * @param details Identifiers to attach.
 * @param duplicate How this operation reports a duplicate key.
 * @returns The coded error.
 */
function storeOperationError(
  operation: string,
  cause: unknown,
  details: Readonly<Record<string, unknown>>,
  duplicate: DuplicateErrorFactory | undefined,
): DebuggenError {
  const errcode = sqliteErrcode(cause);

  if (
    duplicate !== undefined &&
    (errcode === SQLITE_CONSTRAINT_PRIMARYKEY || errcode === SQLITE_CONSTRAINT_UNIQUE)
  ) {
    return duplicate(cause);
  }

  if (errcode === SQLITE_CONSTRAINT_FOREIGNKEY) {
    return sessionNotFoundError(operation, details, cause);
  }

  const error = DebuggenError.from(cause, 'STORE_ERROR');

  return new DebuggenError('STORE_ERROR', 'The session store could not complete an operation.', {
    hint:
      error.hint ??
      'Check that the state directory is writable and that no other Debug Generator service is running against it, then retry.',
    details: context(operation, { ...details, reason: 'store-failed' }),
    cause,
  });
}

/**
 * Runs a repository operation, converting anything thrown into a coded `err` —
 * except this module's programmer errors, which are rethrown unchanged.
 *
 * Every public method goes through this, which is what makes "expected
 * failures come back as `err`" true in one place.
 *
 * @typeParam T The operation's success value.
 * @param operation The method's name, for the error's `details`.
 * @param fn The work to run.
 * @param details Identifiers to attach to a failure.
 * @param duplicate How this operation reports a duplicate key.
 * @returns What `fn` returned, or the classified failure.
 */
function attempt<T>(
  operation: string,
  fn: () => Result<T>,
  details: Readonly<Record<string, unknown>> = {},
  duplicate?: DuplicateErrorFactory,
): Result<T> {
  try {
    return fn();
  } catch (cause) {
    if (isProgrammerError(cause)) {
      throw cause;
    }

    return err(storeOperationError(operation, cause, details, duplicate));
  }
}

/* -------------------------------------------------------------------------------------------------
 * Row mapping — one helper per table, used by every read path
 * ---------------------------------------------------------------------------------------------- */

/**
 * Maps a `sessions` row to its validated record.
 *
 * The one place a session row becomes a `SessionRecord`: the `record` column is
 * parsed as JSON and validated with `parseSessionRecord`, and the document's id
 * must equal the row's key — a document filed under another session's id is
 * corrupt, not merely odd, because returning it would hand one session's state
 * to another's reader. A failure names the row's id and never its content.
 *
 * @param row The row, selecting at least `id` and `record`.
 * @param operation The calling method, for the error's `details`.
 * @returns The record, or the refusal.
 */
function toSessionRecord(row: StoredRow, operation: string): Result<SessionRecord> {
  const id = readText(row['id']);

  if (id === undefined) {
    return err(corruptRowError(operation, 'sessions', { column: 'id' }));
  }

  const document = parseJsonColumn(row['record']);

  if (!document.ok) {
    return err(corruptRowError(operation, 'sessions', { [LOG_BINDING_KEYS.sessionId]: id }));
  }

  const parsed = parseSessionRecord(document.value);

  if (isErr(parsed)) {
    return err(
      corruptRowError(operation, 'sessions', { [LOG_BINDING_KEYS.sessionId]: id }, parsed.error),
    );
  }

  if (parsed.value.id !== id) {
    return err(
      corruptRowError(operation, 'sessions', { [LOG_BINDING_KEYS.sessionId]: id, mismatch: 'id' }),
    );
  }

  return ok(parsed.value);
}

/**
 * Maps a session-list row to its projection, without touching the document.
 *
 * @param row The row, selecting {@link SESSION_LIST_COLUMNS}.
 * @param operation The calling method.
 * @returns The list item, or the refusal.
 */
function toSessionListItem(row: StoredRow, operation: string): Result<SessionListItem> {
  const id = readText(row['id']);
  const projectRoot = readText(row['project_root']);
  const projectName = readText(row['project_name']);
  const status = readText(row['status']);
  const asked = readText(row['question']);
  const createdAt = readInteger(row['created_at']);
  const updatedAt = readInteger(row['updated_at']);

  if (
    id === undefined ||
    projectRoot === undefined ||
    projectName === undefined ||
    status === undefined ||
    !isSessionStatus(status) ||
    asked === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return err(
      corruptRowError(
        operation,
        'sessions',
        id === undefined ? {} : { [LOG_BINDING_KEYS.sessionId]: id },
      ),
    );
  }

  return ok({ id, projectRoot, projectName, status, question: asked, createdAt, updatedAt });
}

/**
 * The indexed projections of a session record, derived from it and from
 * nothing else.
 */
interface SessionColumns {
  readonly id: string;
  readonly projectRoot: string;
  readonly projectName: string;
  readonly status: SessionStatus;
  readonly question: string;
  readonly devServerUrl: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A validated, canonical session record ready to be written. */
interface PreparedSession {
  /** The record exactly as it will be stored and returned. */
  readonly record: SessionRecord;
  /** Its JSON document, the `record` column. */
  readonly json: string;
  /** Its projections, computed from `record`. */
  readonly columns: SessionColumns;
}

/**
 * Refuses — by throwing — a session document that has grown a field named like
 * the request-key secret.
 *
 * `parseSessionRecord` is strict, so such a field can only survive it if the
 * upstream contract itself changes; this guard is what stops the secret's
 * table from being circumvented by such a change. Top level only — see
 * {@link SECRET_FIELD_NAME_PATTERN} for why a deep name scan would be wrong and
 * how the value check covers every depth.
 *
 * @param record The validated record.
 * @param operation The calling method.
 * @throws {DebuggenError} `INTERNAL`, a programmer error, naming only the id.
 */
function assertNoSecretFields(record: SessionRecord, operation: string): void {
  for (const key of Object.keys(record)) {
    if (SECRET_FIELD_NAME_PATTERN.test(key)) {
      throw programmerError(
        'A session record carries a field named like the request-key secret, which must never be serialised into the session document.',
        operation,
        { [LOG_BINDING_KEYS.sessionId]: record.id, reason: 'secret-field-in-record' },
      );
    }
  }
}

/**
 * Computes a record's projections and asserts that each one has the column
 * type the table declares.
 *
 * The projections are derived here and nowhere else, so they agree with the
 * document by construction; the assertion is what catches an upstream shape
 * change that would make a projection unrepresentable — a timestamp that is no
 * longer a whole number, a field that stopped being text — before a `STRICT`
 * column refuses it with a less useful message.
 *
 * @param record The validated, canonical record.
 * @param operation The calling method.
 * @returns The projections.
 * @throws {DebuggenError} `INTERNAL` when a projection is not representable.
 */
function projectSessionColumns(record: SessionRecord, operation: string): SessionColumns {
  const columns: SessionColumns = {
    id: record.id,
    projectRoot: record.projectRoot,
    projectName: record.projectName,
    status: record.status,
    question: record.question,
    devServerUrl: typeof record.devServerUrl === 'string' ? record.devServerUrl : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  const representable =
    isNonEmptyText(columns.id) &&
    typeof columns.projectRoot === 'string' &&
    typeof columns.projectName === 'string' &&
    isSessionStatus(columns.status) &&
    typeof columns.question === 'string' &&
    Number.isSafeInteger(columns.createdAt) &&
    Number.isSafeInteger(columns.updatedAt);

  if (!representable) {
    throw programmerError(
      'A validated session record produced a projection the sessions table cannot hold.',
      operation,
      {
        [LOG_BINDING_KEYS.sessionId]: typeof record.id === 'string' ? record.id : undefined,
        reason: 'projection-mismatch',
      },
    );
  }

  return columns;
}

/**
 * Validates, canonicalises and serialises a session record for writing.
 *
 * The one write-preparation path for `insert`, `update` and `setStatus`:
 *
 * 1. validate with `parseSessionRecord`;
 * 2. round `createdAt` / `updatedAt` to whole milliseconds, in the document as
 *    in the columns, and re-validate when that changed anything;
 * 3. refuse a top-level secret-shaped field ({@link assertNoSecretFields});
 * 4. serialise and project.
 *
 * The value check against the session's stored secret needs the store and is
 * made by the caller, inside its transaction.
 *
 * @param record The record offered for writing.
 * @param operation The calling method.
 * @returns The prepared write, or `err` `STORE_ERROR` (`invalid-record`).
 * @throws {DebuggenError} `INTERNAL` from the two assertions.
 */
function prepareSession(record: SessionRecord, operation: string): Result<PreparedSession> {
  const parsed = parseSessionRecord(record);

  if (isErr(parsed)) {
    return err(
      invalidValueError(
        operation,
        'A session record offered to the session store does not satisfy the session record contract.',
        'invalid-record',
        parsed.error,
      ),
    );
  }

  let canonical = parsed.value;
  const createdAt = toEpochColumn(canonical.createdAt);
  const updatedAt = toEpochColumn(canonical.updatedAt);

  if (createdAt !== canonical.createdAt || updatedAt !== canonical.updatedAt) {
    const reparsed = parseSessionRecord({ ...canonical, createdAt, updatedAt });

    if (isErr(reparsed)) {
      return err(
        invalidValueError(
          operation,
          'A session record offered to the session store has a timestamp outside the range the store can hold.',
          'invalid-record',
          reparsed.error,
          { [LOG_BINDING_KEYS.sessionId]: canonical.id },
        ),
      );
    }

    canonical = reparsed.value;
  }

  assertNoSecretFields(canonical, operation);

  const json = stringifyJson(canonical);

  if (json === undefined) {
    return err(
      invalidValueError(
        operation,
        'A session record offered to the session store cannot be serialised as JSON.',
        'invalid-record',
        undefined,
        { [LOG_BINDING_KEYS.sessionId]: canonical.id },
      ),
    );
  }

  return ok({ record: canonical, json, columns: projectSessionColumns(canonical, operation) });
}

/**
 * The bind list of {@link INSERT_SESSION_SQL} and {@link UPSERT_SESSION_SQL},
 * in {@link SESSION_COLUMNS} order.
 *
 * @param prepared The prepared write.
 * @returns The values to bind.
 */
function sessionRowValues(prepared: PreparedSession): readonly BoundValue[] {
  const { columns } = prepared;

  return [
    columns.id,
    columns.projectRoot,
    columns.projectName,
    columns.status,
    columns.question,
    columns.devServerUrl,
    columns.createdAt,
    columns.updatedAt,
    prepared.json,
  ];
}

/**
 * The bind list of {@link REWRITE_SESSION_SQL}: every projection but the
 * immutable `created_at`, the document, then the id.
 *
 * @param prepared The prepared write.
 * @returns The values to bind.
 */
function sessionRewriteValues(prepared: PreparedSession): readonly BoundValue[] {
  const { columns } = prepared;

  return [
    columns.projectRoot,
    columns.projectName,
    columns.status,
    columns.question,
    columns.devServerUrl,
    columns.updatedAt,
    prepared.json,
    columns.id,
  ];
}

/** The progress-status vocabulary as a membership list for `unknown` values. */
const PROGRESS_STATUS_VALUES: readonly string[] = PROGRESS_STATUSES;

/**
 * Whether `value` is one of the three progress statuses.
 *
 * @param value The candidate.
 * @returns `true` when it is.
 */
function isProgressStatus(value: unknown): value is ProgressStatus {
  return typeof value === 'string' && PROGRESS_STATUS_VALUES.includes(value);
}

/**
 * Maps a `session_progress` row to its entry.
 *
 * @param row The row.
 * @param operation The calling method.
 * @returns The entry, or the refusal.
 */
function toProgressEntry(row: StoredRow, operation: string): Result<ProgressEntry> {
  const id = readInteger(row['id']);
  const sessionId = readText(row['session_id']);
  const stage = readText(row['stage']);
  const status = row['status'];
  const message = readText(row['message']);
  const ts = readInteger(row['ts']);
  const rawDetail = row['detail'];

  if (
    id === undefined ||
    sessionId === undefined ||
    stage === undefined ||
    !isProgressStatus(status) ||
    message === undefined ||
    ts === undefined
  ) {
    return err(
      corruptRowError(operation, 'session_progress', id === undefined ? {} : { progressId: id }),
    );
  }

  if (rawDetail === null || rawDetail === undefined) {
    return ok({ id, sessionId, stage, status, message, ts });
  }

  const detail = parseJsonColumn(rawDetail);

  if (!detail.ok) {
    return err(
      corruptRowError(operation, 'session_progress', { progressId: id, column: 'detail' }),
    );
  }

  return ok({ id, sessionId, stage, status, message, detail: detail.value, ts });
}

/**
 * Maps a `plans` row to its validated plan.
 *
 * The document must name the session and version it is filed under: a plan
 * stored at another key would reorder a session's follow-up ladder.
 *
 * @param row The row.
 * @param operation The calling method.
 * @returns The plan, or the refusal.
 */
function toInstrumentationPlan(row: StoredRow, operation: string): Result<InstrumentationPlan> {
  const sessionId = readText(row['session_id']);
  const planVersion = readInteger(row['plan_version']);

  if (sessionId === undefined || planVersion === undefined) {
    return err(corruptRowError(operation, 'plans', {}));
  }

  const key = { [LOG_BINDING_KEYS.sessionId]: sessionId, planVersion };
  const document = parseJsonColumn(row['plan']);

  if (!document.ok) {
    return err(corruptRowError(operation, 'plans', key));
  }

  const parsed = parseInstrumentationPlan(document.value);

  if (isErr(parsed)) {
    return err(corruptRowError(operation, 'plans', key, parsed.error));
  }

  if (parsed.value.sessionId !== sessionId || parsed.value.planVersion !== planVersion) {
    return err(corruptRowError(operation, 'plans', { ...key, mismatch: 'key' }));
  }

  return ok(parsed.value);
}

/**
 * Maps a `captures` row to its stored capture, validated with the protocol's
 * capture schema. The summary is parsed from JSON and otherwise passed through
 * as the opaque upstream value it is.
 *
 * @param row The row, selecting {@link CAPTURE_COLUMNS}.
 * @param operation The calling method.
 * @returns The capture, or the refusal.
 */
function toStoredCapture(row: StoredRow, operation: string): Result<StoredCapture> {
  const id = readText(row['id']);
  const sessionId = readText(row['session_id']);
  const planVersion = readInteger(row['plan_version']);
  const startedAt = readInteger(row['started_at']);
  const rawStoppedAt = row['stopped_at'];
  const rawSummary = row['summary'];

  if (
    id === undefined ||
    sessionId === undefined ||
    planVersion === undefined ||
    startedAt === undefined
  ) {
    return err(
      corruptRowError(
        operation,
        'captures',
        id === undefined ? {} : { [LOG_BINDING_KEYS.captureId]: id },
      ),
    );
  }

  const key = { [LOG_BINDING_KEYS.sessionId]: sessionId, [LOG_BINDING_KEYS.captureId]: id };
  const stoppedAt =
    rawStoppedAt === null || rawStoppedAt === undefined ? undefined : readInteger(rawStoppedAt);

  if (rawStoppedAt !== null && rawStoppedAt !== undefined && stoppedAt === undefined) {
    return err(corruptRowError(operation, 'captures', { ...key, column: 'stopped_at' }));
  }

  let summary: unknown;

  if (rawSummary !== null && rawSummary !== undefined) {
    const document = parseJsonColumn(rawSummary);

    if (!document.ok) {
      return err(corruptRowError(operation, 'captures', { ...key, column: 'summary' }));
    }

    summary = document.value;
  }

  const parsed = captureRecordSchema.safeParse({
    id,
    planVersion,
    startedAt,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
    ...(summary === undefined ? {} : { summary }),
  });

  if (!parsed.success) {
    return err(
      corruptRowError(
        operation,
        'captures',
        key,
        protocolParseError('STORE_ERROR', 'Invalid stored capture', parsed.error.issues),
      ),
    );
  }

  return ok({ sessionId, capture: parsed.data });
}

/**
 * Maps a `followups` row to its validated record.
 *
 * @param row The row, selecting `id` and `record`.
 * @param operation The calling method.
 * @returns The record, or the refusal.
 */
function toFollowUpRecord(row: StoredRow, operation: string): Result<FollowUpRecord> {
  const rowId = readInteger(row['id']);
  const key = rowId === undefined ? {} : { followUpId: rowId };
  const document = parseJsonColumn(row['record']);

  if (!document.ok) {
    return err(corruptRowError(operation, 'followups', key));
  }

  const parsed = followUpRecordSchema.safeParse(document.value);

  if (!parsed.success) {
    return err(
      corruptRowError(
        operation,
        'followups',
        key,
        protocolParseError('STORE_ERROR', 'Invalid stored follow-up record', parsed.error.issues),
      ),
    );
  }

  return ok(parsed.data);
}

/**
 * Maps a `bindings` row to its binding, validated with the protocol's
 * bound-tab schema.
 *
 * @param row The row, selecting {@link BINDING_COLUMNS}.
 * @param operation The calling method.
 * @returns The binding, or the refusal.
 */
function toTabBinding(row: StoredRow, operation: string): Result<TabBinding> {
  const tabId = readInteger(row['tab_id']);
  const sessionId = readText(row['session_id']);
  const url = readText(row['url']);
  const boundAt = readInteger(row['bound_at']);

  if (
    tabId === undefined ||
    sessionId === undefined ||
    url === undefined ||
    boundAt === undefined
  ) {
    return err(corruptRowError(operation, 'bindings', tabId === undefined ? {} : { tabId }));
  }

  const parsed = boundTabSchema.safeParse({ tabId, url });

  if (!parsed.success) {
    return err(
      corruptRowError(
        operation,
        'bindings',
        { tabId, [LOG_BINDING_KEYS.sessionId]: sessionId },
        protocolParseError('STORE_ERROR', 'Invalid stored binding', parsed.error.issues),
      ),
    );
  }

  return ok({ sessionId, tab: parsed.data, boundAt });
}

/**
 * Builds the fixed-width bind list for the session-status filter.
 *
 * Duplicates are collapsed and the list is padded to {@link STATUS_SLOTS} by
 * repeating one of its own values, which keeps one statement text per query
 * shape. A value outside the vocabulary is refused rather than dropped: a query
 * that silently ignored part of its filter would answer with rows the caller
 * did not ask for.
 *
 * @param statuses The statuses asked for.
 * @param operation The calling method.
 * @returns The bind list, `undefined` when the filter selects nothing, or the
 * refusal.
 */
function statusFilterSlots(
  statuses: readonly SessionStatus[],
  operation: string,
): Result<readonly BoundValue[] | undefined> {
  const unique: SessionStatus[] = [];

  for (const status of statuses) {
    if (!isSessionStatus(status)) {
      return err(unknownStatusError(operation));
    }

    if (!unique.includes(status)) {
      unique.push(status);
    }
  }

  const filler = unique[0];

  if (filler === undefined) {
    return ok(undefined);
  }

  const slots: BoundValue[] = [...unique];

  while (slots.length < STATUS_SLOTS) {
    slots.push(filler);
  }

  return ok(slots);
}

/** The optional filters of the session list, validated. */
interface SessionListFilter {
  readonly projectRoot: string | undefined;
  readonly statusSlots: readonly BoundValue[] | undefined;
  readonly updatedBefore: number | undefined;
}

/**
 * Assembles the `WHERE` clause of the session list from module-constant terms,
 * in a fixed order, with the matching bind list. The text depends only on which
 * filters are present — at most eight shapes — never on a value.
 *
 * @param filter The validated filters.
 * @returns The clause (empty, or starting with a space) and its values.
 */
function sessionListWhere(filter: SessionListFilter): {
  readonly clause: string;
  readonly values: readonly BoundValue[];
} {
  const terms: string[] = [];
  const values: BoundValue[] = [];

  if (filter.projectRoot !== undefined) {
    terms.push(PROJECT_ROOT_TERM);
    values.push(filter.projectRoot);
  }

  if (filter.statusSlots !== undefined) {
    terms.push(STATUS_TERM);
    values.push(...filter.statusSlots);
  }

  if (filter.updatedBefore !== undefined) {
    terms.push(UPDATED_BEFORE_TERM);
    values.push(filter.updatedBefore);
  }

  return { clause: terms.length === 0 ? '' : ` WHERE ${terms.join(' AND ')}`, values };
}

/* -------------------------------------------------------------------------------------------------
 * The repository
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the sessions repository over an open store.
 *
 * `src/main.ts` constructs one per process and hands it to the session
 * manager, the pipeline, the telemetry ingest path, the binding routes and
 * retention. A suite constructs one against a store opened at a sandbox path
 * (or `':memory:'`), so it exercises the real DDL, pragmas and migrations.
 *
 * The repository holds no state of its own beyond its dependencies:
 * statements live in the store's cache and every method is a function of the
 * database's contents. The returned object is a frozen record of functions.
 *
 * @param deps The store, and optionally a logger and a clock.
 * @returns The repository.
 *
 * @example
 * ```ts
 * const sessions = createSessionsRepo({ store, logger });
 *
 * const stored = sessions.update(nextRecord);
 * if (stored.ok) {
 *   broadcast({ type: 'session.updated', payload: { session: stored.value } });
 * }
 * ```
 */
export function createSessionsRepo(deps: SessionsRepoDeps): SessionsRepo {
  const { store } = deps;
  const now = deps.now ?? nowEpochMs;
  const logger = (deps.logger ?? noopLogger).child({
    [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM,
    [REPO_BINDING_KEY]: REPO,
  });

  /**
   * The injected clock's reading, canonicalised for an integer column. A clock
   * that answers something other than a finite number is a wiring defect, and
   * is thrown rather than written.
   */
  function stamp(operation: string): number {
    const reading = now();

    if (!isFiniteNumber(reading)) {
      throw programmerError(
        'The clock injected into the sessions repository returned a value that is not a finite number.',
        operation,
        { reason: 'invalid-clock' },
      );
    }

    return toEpochColumn(reading);
  }

  /**
   * The value half of the request-key guard, run inside the write's
   * transaction: the serialised document must not contain the session's
   * stored secret anywhere. Reads the secret into this frame only; it is never
   * logged and never placed in the thrown error.
   */
  function assertSecretAbsent(prepared: PreparedSession, operation: string): void {
    const row = store.statement(SELECT_REQUEST_KEY_SQL).get(prepared.columns.id);
    const secret = row === undefined ? undefined : readText(row['request_key']);

    if (secret !== undefined && secret.length > 0 && prepared.json.includes(secret)) {
      throw programmerError(
        'A session record carries the request-key secret, which must never be serialised into the session document.',
        operation,
        { [LOG_BINDING_KEYS.sessionId]: prepared.columns.id, reason: 'secret-value-in-record' },
      );
    }
  }

  /** Reports a refused operation: identifiers, the code and the reason only. */
  function reportFailure(
    message: string,
    operation: string,
    error: DebuggenError,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    const reason = error.details?.['reason'];

    logger.warn(message, {
      ...fields,
      operation,
      code: error.code,
      ...(typeof reason === 'string' ? { reason } : {}),
    });
  }

  /**
   * Refuses a session id that is not a non-empty string before it is bound.
   * The type already excludes it; this is the guard for a JavaScript caller.
   */
  function sessionIdError(operation: string, sessionId: unknown): DebuggenError | undefined {
    return isNonEmptyText(sessionId)
      ? undefined
      : invalidArgumentError(operation, 'sessionId', 'a non-empty session id string');
  }

  /** How a duplicate session id is reported. */
  function duplicateSessionError(operation: string, sessionId: string): DuplicateErrorFactory {
    return (cause) =>
      new DebuggenError(
        'STORE_ERROR',
        'A session with this id already exists in the session store.',
        {
          hint: 'Session ids are minted once per session and never reused. Persist changes to an existing session with update().',
          details: context(operation, {
            [LOG_BINDING_KEYS.sessionId]: sessionId,
            reason: 'duplicate-session',
          }),
          cause,
        },
      );
  }

  // -----------------------------------------------------------------------------------------------
  // sessions
  // -----------------------------------------------------------------------------------------------

  function insert(record: SessionRecord): Result<SessionRecord> {
    const operation = 'insert';
    const prepared = attempt(operation, () => prepareSession(record, operation));

    if (isErr(prepared)) {
      reportFailure('a session could not be stored', operation, prepared.error);
      return prepared;
    }

    const { columns } = prepared.value;
    const fields = { [LOG_BINDING_KEYS.sessionId]: columns.id };
    const outcome = attempt(
      operation,
      () =>
        store.transaction((): Result<SessionRecord> => {
          assertSecretAbsent(prepared.value, operation);
          store.statement(INSERT_SESSION_SQL).run(...sessionRowValues(prepared.value));

          return ok(prepared.value.record);
        }),
      fields,
      duplicateSessionError(operation, columns.id),
    );

    if (isErr(outcome)) {
      reportFailure('a session could not be stored', operation, outcome.error, fields);
    } else {
      logger.info('session stored', { ...fields, status: columns.status });
    }

    return outcome;
  }

  function update(record: SessionRecord): Result<SessionRecord> {
    const operation = 'update';
    const input = attempt(operation, (): Result<SessionRecord> => {
      const parsed = parseSessionRecord(record);

      return isErr(parsed)
        ? err(
            invalidValueError(
              operation,
              'A session record offered to the session store does not satisfy the session record contract.',
              'invalid-record',
              parsed.error,
            ),
          )
        : parsed;
    });

    if (isErr(input)) {
      reportFailure('a session could not be persisted', operation, input.error);
      return input;
    }

    const sessionId = input.value.id;
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      () =>
        store.transaction(
          (): Result<{ readonly record: SessionRecord; readonly created: boolean }> => {
            const stamps = store.statement(SELECT_SESSION_STAMPS_SQL).get(sessionId);
            let createdAt = input.value.createdAt;
            let floor = Number.NEGATIVE_INFINITY;

            if (stamps !== undefined) {
              const storedCreatedAt = readInteger(stamps['created_at']);
              const storedUpdatedAt = readInteger(stamps['updated_at']);

              if (storedCreatedAt === undefined || storedUpdatedAt === undefined) {
                return err(corruptRowError(operation, 'sessions', fields));
              }

              // Creation time is immutable: the stored value wins, in the
              // document as in the column the upsert leaves untouched.
              createdAt = storedCreatedAt;
              floor = storedUpdatedAt;
            }

            // Never backwards: the record's own stamp, the clock and the stored
            // stamp, whichever is latest.
            const updatedAt = Math.max(
              toEpochColumn(input.value.updatedAt),
              stamp(operation),
              floor,
            );
            const prepared = prepareSession(
              { ...touchSessionRecord(input.value, updatedAt), createdAt },
              operation,
            );

            if (isErr(prepared)) {
              return prepared;
            }

            assertSecretAbsent(prepared.value, operation);
            store.statement(UPSERT_SESSION_SQL).run(...sessionRowValues(prepared.value));

            return ok({ record: prepared.value.record, created: stamps === undefined });
          },
        ),
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a session could not be persisted', operation, outcome.error, fields);
      return outcome;
    }

    logger.debug('session persisted', {
      ...fields,
      status: outcome.value.record.status,
      created: outcome.value.created,
    });

    return ok(outcome.value.record);
  }

  function get(id: SessionId): Result<SessionRecord | undefined> {
    const operation = 'get';
    const invalid = sessionIdError(operation, id);

    if (invalid !== undefined) {
      return err(invalid);
    }

    const fields = { [LOG_BINDING_KEYS.sessionId]: id };
    const outcome = attempt(
      operation,
      (): Result<SessionRecord | undefined> => {
        const row = store.statement(SELECT_SESSION_SQL).get(id);

        return row === undefined ? ok(undefined) : toSessionRecord(row, operation);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a session could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  function setStatus(id: SessionId, status: SessionStatus): Result<SessionRecord> {
    const operation = 'setStatus';
    const invalid = sessionIdError(operation, id);

    if (invalid !== undefined) {
      return err(invalid);
    }

    const fields = { [LOG_BINDING_KEYS.sessionId]: id };

    if (!isSessionStatus(status)) {
      const refused = unknownStatusError(operation, fields);
      reportFailure('a session status could not be persisted', operation, refused, fields);
      return err(refused);
    }

    const outcome = attempt(
      operation,
      () =>
        store.transaction(
          (): Result<{ readonly record: SessionRecord; readonly previous: SessionStatus }> => {
            const row = store.statement(SELECT_SESSION_SQL).get(id);

            if (row === undefined) {
              return err(sessionNotFoundError(operation, fields));
            }

            const current = toSessionRecord(row, operation);

            if (isErr(current)) {
              return current;
            }

            const updatedAt = Math.max(current.value.updatedAt, stamp(operation));
            const prepared = prepareSession(
              touchSessionRecord({ ...current.value, status }, updatedAt),
              operation,
            );

            if (isErr(prepared)) {
              return prepared;
            }

            assertSecretAbsent(prepared.value, operation);
            store.statement(REWRITE_SESSION_SQL).run(...sessionRewriteValues(prepared.value));

            return ok({ record: prepared.value.record, previous: current.value.status });
          },
        ),
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a session status could not be persisted', operation, outcome.error, fields);
      return outcome;
    }

    logger.info('session status persisted', {
      ...fields,
      from: outcome.value.previous,
      to: status,
    });

    return ok(outcome.value.record);
  }

  function list(options: ListSessionsOptions = {}): Result<SessionListPage> {
    const operation = 'list';
    const outcome = attempt(operation, (): Result<SessionListPage> => {
      const { projectRoot, statuses, updatedBefore } = options;
      const limit = options.limit ?? DEFAULT_SESSION_LIST_LIMIT;
      const offset = options.offset ?? 0;

      if (projectRoot !== undefined && !isNonEmptyText(projectRoot)) {
        return err(invalidArgumentError(operation, 'projectRoot', 'a non-empty string'));
      }

      if (updatedBefore !== undefined && !isFiniteNumber(updatedBefore)) {
        return err(
          invalidArgumentError(operation, 'updatedBefore', 'a finite epoch-millisecond number'),
        );
      }

      if (!isIntegerInRange(limit, 0, MAX_SESSION_LIST_LIMIT)) {
        return err(
          invalidArgumentError(
            operation,
            'limit',
            `an integer from 0 to ${String(MAX_SESSION_LIST_LIMIT)}`,
          ),
        );
      }

      if (!isIntegerInRange(offset, 0, Number.MAX_SAFE_INTEGER)) {
        return err(invalidArgumentError(operation, 'offset', 'a non-negative integer'));
      }

      let statusSlots: readonly BoundValue[] | undefined;

      if (statuses !== undefined) {
        const slots = statusFilterSlots(statuses, operation);

        if (isErr(slots)) {
          return slots;
        }

        // An empty status filter selects nothing, which is answered here rather
        // than widened into "every status".
        if (slots.value === undefined) {
          return ok({ items: [], total: 0 });
        }

        statusSlots = slots.value;
      }

      const { clause, values } = sessionListWhere({ projectRoot, statusSlots, updatedBefore });

      // One transaction, so the page and the total describe the same state.
      return store.transaction((): Result<SessionListPage> => {
        const counted = store
          .statement(`SELECT COUNT(*) AS total FROM sessions${clause}`)
          .get(...values);
        const total = counted === undefined ? undefined : readInteger(counted['total']);

        if (total === undefined) {
          return err(corruptRowError(operation, 'sessions', { column: 'total' }));
        }

        if (limit === 0) {
          return ok({ items: [], total });
        }

        const rows = store
          .statement(
            `SELECT ${SESSION_LIST_COLUMNS} FROM sessions${clause} ${SESSION_LIST_ORDER} LIMIT ? OFFSET ?`,
          )
          .all(...values, limit, offset);
        const items: SessionListItem[] = [];

        for (const row of rows) {
          const item = toSessionListItem(row, operation);

          if (isErr(item)) {
            return item;
          }

          items.push(item.value);
        }

        return ok({ items, total });
      });
    });

    if (isErr(outcome)) {
      reportFailure('the session list could not be read', operation, outcome.error);
    }

    return outcome;
  }

  function deleteSession(id: SessionId): Result<number> {
    const operation = 'delete';
    const invalid = sessionIdError(operation, id);

    if (invalid !== undefined) {
      return err(invalid);
    }

    const fields = { [LOG_BINDING_KEYS.sessionId]: id };
    const outcome = attempt(
      operation,
      () => ok(changesOf(store.statement(DELETE_SESSION_SQL).run(id))),
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a session could not be deleted', operation, outcome.error, fields);
    } else {
      logger.info('session deleted', { ...fields, removed: outcome.value });
    }

    return outcome;
  }

  // -----------------------------------------------------------------------------------------------
  // session_progress
  // -----------------------------------------------------------------------------------------------

  function appendProgress(entry: AppendProgressInput): Result<void> {
    const operation = 'appendProgress';
    const outcome = attempt(operation, (): Result<void> => {
      const invalid = sessionIdError(operation, entry.sessionId);

      if (invalid !== undefined) {
        return err(invalid);
      }

      const fields = { [LOG_BINDING_KEYS.sessionId]: entry.sessionId };

      if (!isNonEmptyText(entry.stage)) {
        return err(invalidArgumentError(operation, 'stage', 'a non-empty stage name', fields));
      }

      if (!isProgressStatus(entry.status)) {
        return err(
          invalidArgumentError(
            operation,
            'status',
            `one of ${PROGRESS_STATUSES.join(', ')}`,
            fields,
          ),
        );
      }

      if (!isNonEmptyText(entry.message)) {
        return err(invalidArgumentError(operation, 'message', 'a non-empty string', fields));
      }

      if (entry.ts !== undefined && !isFiniteNumber(entry.ts)) {
        return err(
          invalidArgumentError(operation, 'ts', 'a finite epoch-millisecond number', fields),
        );
      }

      let detail: string | null = null;

      if (entry.detail !== undefined) {
        const serialised = stringifyJson(entry.detail);

        if (serialised === undefined) {
          return err(
            new DebuggenError(
              'STORE_ERROR',
              'A progress detail offered to the session store cannot be serialised as JSON.',
              {
                hint: 'Pass plain JSON data as the detail: no functions, symbols, cycles or bigint values.',
                details: context(operation, { ...fields, reason: 'unserializable-detail' }),
              },
            ),
          );
        }

        detail = serialised;
      }

      const ts = entry.ts === undefined ? stamp(operation) : toEpochColumn(entry.ts);

      store
        .statement(INSERT_PROGRESS_SQL)
        .run(entry.sessionId, entry.stage, entry.status, entry.message, detail, ts);

      return ok(undefined);
    });

    if (isErr(outcome)) {
      reportFailure('a progress line could not be stored', operation, outcome.error);
    } else {
      logger.debug('progress line stored', {
        [LOG_BINDING_KEYS.sessionId]: entry.sessionId,
        stage: entry.stage,
        status: entry.status,
      });
    }

    return outcome;
  }

  function listProgress(
    sessionId: SessionId,
    options: ListProgressOptions = {},
  ): Result<ProgressEntry[]> {
    const operation = 'listProgress';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<ProgressEntry[]> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        const sinceId = options.sinceId ?? 0;

        if (!isIntegerInRange(sinceId, 0, Number.MAX_SAFE_INTEGER)) {
          return err(invalidArgumentError(operation, 'sinceId', 'a non-negative integer', fields));
        }

        if (
          options.limit !== undefined &&
          !isIntegerInRange(options.limit, 0, Number.MAX_SAFE_INTEGER)
        ) {
          return err(invalidArgumentError(operation, 'limit', 'a non-negative integer', fields));
        }

        // SQLite reads a negative LIMIT as "no limit".
        const limit = options.limit ?? -1;
        const rows = store.statement(SELECT_PROGRESS_SQL).all(sessionId, sinceId, limit);
        const entries: ProgressEntry[] = [];

        for (const row of rows) {
          const entry = toProgressEntry(row, operation);

          if (isErr(entry)) {
            return entry;
          }

          entries.push(entry.value);
        }

        return ok(entries);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('session progress could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  // -----------------------------------------------------------------------------------------------
  // plans
  // -----------------------------------------------------------------------------------------------

  function insertPlan(plan: InstrumentationPlan): Result<InstrumentationPlan> {
    const operation = 'insertPlan';
    const validated = attempt(operation, (): Result<InstrumentationPlan> => {
      const parsed = parseInstrumentationPlan(plan);

      return isErr(parsed)
        ? err(
            new DebuggenError(
              'PLAN_INVALID',
              'An instrumentation plan offered to the session store does not satisfy the normalised plan schema.',
              {
                hint: 'This is a defect in whatever produced the plan: the reported field paths identify it. Nothing was stored.',
                details: context(operation, { reason: 'invalid-plan' }),
                cause: parsed.error,
              },
            ),
          )
        : parsed;
    });

    if (isErr(validated)) {
      reportFailure('a plan could not be stored', operation, validated.error);
      return validated;
    }

    const { sessionId, planVersion } = validated.value;
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId, planVersion };
    const outcome = attempt(
      operation,
      (): Result<InstrumentationPlan> => {
        const json = stringifyJson(validated.value);

        if (json === undefined) {
          return err(
            invalidValueError(
              operation,
              'An instrumentation plan offered to the session store cannot be serialised as JSON.',
              'invalid-plan',
              undefined,
              fields,
            ),
          );
        }

        store.statement(INSERT_PLAN_SQL).run(sessionId, planVersion, json, stamp(operation));

        return ok(validated.value);
      },
      fields,
      (cause) =>
        new DebuggenError('STORE_ERROR', 'This plan version is already stored for the session.', {
          hint: 'Plan versions are append-only: a follow-up that needs more instrumentation stores the next version (nextPlanVersion) rather than rewriting this one.',
          details: context(operation, { ...fields, reason: 'duplicate-plan-version' }),
          cause,
        }),
    );

    if (isErr(outcome)) {
      reportFailure('a plan could not be stored', operation, outcome.error, fields);
    } else {
      logger.info('plan stored', {
        ...fields,
        actions: outcome.value.instrumentationTargets.length,
      });
    }

    return outcome;
  }

  function getPlan(
    sessionId: SessionId,
    planVersion: number,
  ): Result<InstrumentationPlan | undefined> {
    const operation = 'getPlan';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<InstrumentationPlan | undefined> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        if (!isIntegerInRange(planVersion, 1, Number.MAX_SAFE_INTEGER)) {
          return err(invalidArgumentError(operation, 'planVersion', 'a positive integer', fields));
        }

        const row = store.statement(SELECT_PLAN_SQL).get(sessionId, planVersion);

        return row === undefined ? ok(undefined) : toInstrumentationPlan(row, operation);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a plan could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  function listPlans(sessionId: SessionId): Result<InstrumentationPlan[]> {
    const operation = 'listPlans';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<InstrumentationPlan[]> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        const plans: InstrumentationPlan[] = [];

        for (const row of store.statement(SELECT_PLANS_SQL).all(sessionId)) {
          const plan = toInstrumentationPlan(row, operation);

          if (isErr(plan)) {
            return plan;
          }

          plans.push(plan.value);
        }

        return ok(plans);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('plans could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  function latestPlanVersion(sessionId: SessionId): Result<number | undefined> {
    const operation = 'latestPlanVersion';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<number | undefined> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        const row = store.statement(SELECT_LATEST_PLAN_VERSION_SQL).get(sessionId);
        const latest = row === undefined ? null : row['latest'];

        if (latest === null || latest === undefined) {
          return ok(undefined);
        }

        const version = readInteger(latest);

        return version === undefined
          ? err(corruptRowError(operation, 'plans', { ...fields, column: 'plan_version' }))
          : ok(version);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('the latest plan version could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  function nextPlanVersion(sessionId: SessionId): Result<number> {
    const latest = latestPlanVersion(sessionId);

    return isErr(latest) ? latest : ok((latest.value ?? 0) + 1);
  }

  // -----------------------------------------------------------------------------------------------
  // captures
  // -----------------------------------------------------------------------------------------------

  function startCapture(input: StartCaptureInput): Result<StoredCapture> {
    const operation = 'startCapture';
    const prepared = attempt(operation, (): Result<CaptureRecord> => {
      const invalid = sessionIdError(operation, input.sessionId);

      if (invalid !== undefined) {
        return err(invalid);
      }

      const fields = { [LOG_BINDING_KEYS.sessionId]: input.sessionId };

      if (!isIntegerInRange(input.planVersion, 1, Number.MAX_SAFE_INTEGER)) {
        return err(invalidArgumentError(operation, 'planVersion', 'a positive integer', fields));
      }

      if (input.captureId !== undefined && !isNonEmptyText(input.captureId)) {
        return err(
          invalidArgumentError(operation, 'captureId', 'a non-empty capture id string', fields),
        );
      }

      if (input.startedAt !== undefined && !isFiniteNumber(input.startedAt)) {
        return err(
          invalidArgumentError(operation, 'startedAt', 'a finite epoch-millisecond number', fields),
        );
      }

      const parsed = captureRecordSchema.safeParse({
        id: input.captureId ?? newCaptureId(),
        planVersion: input.planVersion,
        startedAt:
          input.startedAt === undefined ? stamp(operation) : toEpochColumn(input.startedAt),
      });

      return parsed.success
        ? ok(parsed.data)
        : err(
            invalidValueError(
              operation,
              'A capture offered to the session store does not satisfy the capture record contract.',
              'invalid-capture',
              protocolParseError('STORE_ERROR', 'Invalid capture', parsed.error.issues),
              fields,
            ),
          );
    });

    if (isErr(prepared)) {
      reportFailure('a capture could not be started', operation, prepared.error);
      return prepared;
    }

    const capture = prepared.value;
    const fields = {
      [LOG_BINDING_KEYS.sessionId]: input.sessionId,
      [LOG_BINDING_KEYS.captureId]: capture.id,
      planVersion: capture.planVersion,
    };
    const outcome = attempt(
      operation,
      () =>
        store.transaction((): Result<StoredCapture> => {
          // Refused on the open row's id alone, so an otherwise unreadable
          // orphan still blocks a second window rather than being ignored.
          const active = store.statement(SELECT_ACTIVE_CAPTURE_ID_SQL).get(input.sessionId);

          if (active !== undefined) {
            const activeCaptureId = readText(active['id']);

            return err(
              new DebuggenError(
                'CAPTURE_ALREADY_ACTIVE',
                'This session already has a capture running.',
                {
                  hint: 'Stop the running capture before starting another one.',
                  details: context(operation, {
                    [LOG_BINDING_KEYS.sessionId]: input.sessionId,
                    ...(activeCaptureId === undefined ? {} : { activeCaptureId }),
                    reason: 'capture-already-active',
                  }),
                },
              ),
            );
          }

          store
            .statement(INSERT_CAPTURE_SQL)
            .run(capture.id, input.sessionId, capture.planVersion, capture.startedAt);

          return ok({ sessionId: input.sessionId, capture });
        }),
      fields,
      (cause) =>
        new DebuggenError(
          'STORE_ERROR',
          'A capture with this id already exists in the session store.',
          {
            hint: 'Capture ids are minted once per capture window. Omit captureId to have one minted.',
            details: context(operation, { ...fields, reason: 'duplicate-capture' }),
            cause,
          },
        ),
    );

    if (isErr(outcome)) {
      reportFailure('a capture could not be started', operation, outcome.error, fields);
    } else {
      logger.info('capture started', fields);
    }

    return outcome;
  }

  function stopCapture(input: StopCaptureInput): Result<StoredCapture> {
    const operation = 'stopCapture';
    const fields = { [LOG_BINDING_KEYS.captureId]: input.captureId };
    const outcome = attempt(
      operation,
      (): Result<StoredCapture> => {
        if (!isNonEmptyText(input.captureId)) {
          return err(invalidArgumentError(operation, 'captureId', 'a non-empty capture id string'));
        }

        if (input.stoppedAt !== undefined && !isFiniteNumber(input.stoppedAt)) {
          return err(
            invalidArgumentError(
              operation,
              'stoppedAt',
              'a finite epoch-millisecond number',
              fields,
            ),
          );
        }

        return store.transaction((): Result<StoredCapture> => {
          const row = store.statement(SELECT_CAPTURE_SQL).get(input.captureId);

          if (row === undefined) {
            return err(
              new DebuggenError('STORE_ERROR', 'The session store holds no capture with this id.', {
                hint: 'Re-read the session: the capture may have been purged with its session, or the id may belong to another store.',
                details: context(operation, { ...fields, reason: 'capture-not-found' }),
              }),
            );
          }

          const current = toStoredCapture(row, operation);

          if (isErr(current)) {
            return current;
          }

          const { sessionId } = current.value;
          const { startedAt } = current.value.capture;
          const scoped = { ...fields, [LOG_BINDING_KEYS.sessionId]: sessionId };

          if (current.value.capture.stoppedAt !== undefined) {
            return err(
              new DebuggenError('SESSION_INVALID_STATE', 'This capture has already been stopped.', {
                hint: 'A capture window closes once. Start a new capture to collect more telemetry.',
                details: context(operation, { ...scoped, reason: 'capture-already-stopped' }),
              }),
            );
          }

          // The clock is raised to the start time rather than refused, so a
          // clock reading earlier than a caller-supplied start can never leave
          // a capture impossible to stop; an explicit earlier stop is refused.
          const stoppedAt =
            input.stoppedAt === undefined
              ? Math.max(stamp(operation), startedAt)
              : toEpochColumn(input.stoppedAt);

          if (stoppedAt < startedAt) {
            return err(
              invalidArgumentError(
                operation,
                'stoppedAt',
                'no earlier than the capture start time',
                scoped,
                'stop-before-start',
              ),
            );
          }

          const parsed = captureRecordSchema.safeParse({
            ...current.value.capture,
            stoppedAt,
            ...(input.summary === undefined ? {} : { summary: input.summary }),
          });

          if (!parsed.success) {
            return err(
              invalidValueError(
                operation,
                'A capture summary offered to the session store does not satisfy the capture record contract.',
                'invalid-capture',
                protocolParseError('STORE_ERROR', 'Invalid capture', parsed.error.issues),
                scoped,
              ),
            );
          }

          let summaryJson: string | null = null;

          if (parsed.data.summary !== undefined) {
            const serialised = stringifyJson(parsed.data.summary);

            if (serialised === undefined) {
              return err(
                invalidValueError(
                  operation,
                  'A capture summary offered to the session store cannot be serialised as JSON.',
                  'invalid-capture',
                  undefined,
                  scoped,
                ),
              );
            }

            summaryJson = serialised;
          }

          const changed = changesOf(
            store.statement(STOP_CAPTURE_SQL).run(stoppedAt, summaryJson, input.captureId),
          );

          if (changed === 0) {
            return err(
              new DebuggenError('SESSION_INVALID_STATE', 'This capture has already been stopped.', {
                hint: 'A capture window closes once. Start a new capture to collect more telemetry.',
                details: context(operation, { ...scoped, reason: 'capture-already-stopped' }),
              }),
            );
          }

          return ok({ sessionId, capture: parsed.data });
        });
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a capture could not be stopped', operation, outcome.error, fields);
    } else {
      logger.info('capture stopped', {
        ...fields,
        [LOG_BINDING_KEYS.sessionId]: outcome.value.sessionId,
        summarised: outcome.value.capture.summary !== undefined,
      });
    }

    return outcome;
  }

  function getCapture(captureId: CaptureId): Result<StoredCapture | undefined> {
    const operation = 'getCapture';
    const fields = { [LOG_BINDING_KEYS.captureId]: captureId };
    const outcome = attempt(
      operation,
      (): Result<StoredCapture | undefined> => {
        if (!isNonEmptyText(captureId)) {
          return err(invalidArgumentError(operation, 'captureId', 'a non-empty capture id string'));
        }

        const row = store.statement(SELECT_CAPTURE_SQL).get(captureId);

        return row === undefined ? ok(undefined) : toStoredCapture(row, operation);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a capture could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  function getActiveCapture(sessionId: SessionId): Result<StoredCapture | undefined> {
    const operation = 'getActiveCapture';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<StoredCapture | undefined> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        const row = store.statement(SELECT_ACTIVE_CAPTURE_SQL).get(sessionId);

        return row === undefined ? ok(undefined) : toStoredCapture(row, operation);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('the active capture could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  function listCaptures(sessionId: SessionId): Result<StoredCapture[]> {
    const operation = 'listCaptures';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<StoredCapture[]> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        const captures: StoredCapture[] = [];

        for (const row of store.statement(SELECT_CAPTURES_SQL).all(sessionId)) {
          const capture = toStoredCapture(row, operation);

          if (isErr(capture)) {
            return capture;
          }

          captures.push(capture.value);
        }

        return ok(captures);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('captures could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  // -----------------------------------------------------------------------------------------------
  // followups
  // -----------------------------------------------------------------------------------------------

  function appendFollowUp(sessionId: SessionId, record: FollowUpRecord): Result<FollowUpRecord> {
    const operation = 'appendFollowUp';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<FollowUpRecord> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        const parsed = followUpRecordSchema.safeParse(record);

        if (!parsed.success) {
          return err(
            invalidValueError(
              operation,
              'A follow-up record offered to the session store does not satisfy the follow-up record contract.',
              'invalid-follow-up',
              protocolParseError('STORE_ERROR', 'Invalid follow-up record', parsed.error.issues),
              fields,
            ),
          );
        }

        let canonical: FollowUpRecord = parsed.data;
        const askedAt = toEpochColumn(canonical.askedAt);

        if (askedAt !== canonical.askedAt) {
          const reparsed = followUpRecordSchema.safeParse({ ...canonical, askedAt });

          if (!reparsed.success) {
            return err(
              invalidValueError(
                operation,
                'A follow-up record offered to the session store has a timestamp outside the range the store can hold.',
                'invalid-follow-up',
                protocolParseError(
                  'STORE_ERROR',
                  'Invalid follow-up record',
                  reparsed.error.issues,
                ),
                fields,
              ),
            );
          }

          canonical = reparsed.data;
        }

        const json = stringifyJson(canonical);

        if (json === undefined) {
          return err(
            invalidValueError(
              operation,
              'A follow-up record offered to the session store cannot be serialised as JSON.',
              'invalid-follow-up',
              undefined,
              fields,
            ),
          );
        }

        store
          .statement(INSERT_FOLLOWUP_SQL)
          .run(sessionId, canonical.question, canonical.askedAt, json);

        return ok(canonical);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a follow-up could not be stored', operation, outcome.error, fields);
    } else {
      logger.info('follow-up stored', fields);
    }

    return outcome;
  }

  function listFollowUps(sessionId: SessionId): Result<FollowUpRecord[]> {
    const operation = 'listFollowUps';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<FollowUpRecord[]> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        const records: FollowUpRecord[] = [];

        for (const row of store.statement(SELECT_FOLLOWUPS_SQL).all(sessionId)) {
          const parsed = toFollowUpRecord(row, operation);

          if (isErr(parsed)) {
            return parsed;
          }

          records.push(parsed.value);
        }

        return ok(records);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('follow-ups could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  // -----------------------------------------------------------------------------------------------
  // bindings
  // -----------------------------------------------------------------------------------------------

  /** Reads at most one binding row, absence being a success. */
  function readBinding(
    sql: string,
    key: BoundValue,
    operation: string,
  ): Result<TabBinding | undefined> {
    const row = store.statement(sql).get(key);

    return row === undefined ? ok(undefined) : toTabBinding(row, operation);
  }

  function upsertBinding(input: UpsertBindingInput): Result<BindingUpsert> {
    const operation = 'upsertBinding';
    const prepared = attempt(operation, (): Result<TabBinding> => {
      const invalid = sessionIdError(operation, input.sessionId);

      if (invalid !== undefined) {
        return err(invalid);
      }

      const fields = { [LOG_BINDING_KEYS.sessionId]: input.sessionId };

      if (input.boundAt !== undefined && !isFiniteNumber(input.boundAt)) {
        return err(
          invalidArgumentError(operation, 'boundAt', 'a finite epoch-millisecond number', fields),
        );
      }

      const parsed = boundTabSchema.safeParse({ tabId: input.tabId, url: input.url });

      if (!parsed.success) {
        return err(
          invalidValueError(
            operation,
            'A tab binding offered to the session store does not satisfy the bound-tab contract.',
            'invalid-binding',
            protocolParseError('STORE_ERROR', 'Invalid tab binding', parsed.error.issues),
            fields,
          ),
        );
      }

      return ok({
        sessionId: input.sessionId,
        tab: parsed.data,
        boundAt: input.boundAt === undefined ? stamp(operation) : toEpochColumn(input.boundAt),
      });
    });

    if (isErr(prepared)) {
      reportFailure('a tab binding could not be stored', operation, prepared.error);
      return prepared;
    }

    const binding = prepared.value;
    const fields = { [LOG_BINDING_KEYS.sessionId]: binding.sessionId, tabId: binding.tab.tabId };
    const outcome = attempt(
      operation,
      () =>
        store.transaction((): Result<BindingUpsert> => {
          const previousForTab = readBinding(
            SELECT_BINDING_BY_TAB_SQL,
            binding.tab.tabId,
            operation,
          );

          if (isErr(previousForTab)) {
            return previousForTab;
          }

          const previousForSession = readBinding(
            SELECT_BINDING_BY_SESSION_SQL,
            binding.sessionId,
            operation,
          );

          if (isErr(previousForSession)) {
            return previousForSession;
          }

          // Both edges of the one-to-one rule are cleared before the insert, so
          // neither the tab's primary key nor the session's unique index can
          // refuse it; a missing session fails the insert's foreign key and
          // rolls both deletes back.
          store.statement(DELETE_BINDING_BY_TAB_SQL).run(binding.tab.tabId);
          store.statement(DELETE_BINDING_BY_SESSION_SQL).run(binding.sessionId);
          store
            .statement(INSERT_BINDING_SQL)
            .run(binding.tab.tabId, binding.sessionId, binding.tab.url, binding.boundAt);

          const displacedSession =
            previousForTab.value !== undefined &&
            previousForTab.value.sessionId !== binding.sessionId
              ? previousForTab.value
              : undefined;
          const displacedTab =
            previousForSession.value !== undefined &&
            previousForSession.value.tab.tabId !== binding.tab.tabId
              ? previousForSession.value
              : undefined;

          return ok({
            binding,
            ...(displacedTab === undefined ? {} : { displacedTab }),
            ...(displacedSession === undefined ? {} : { displacedSession }),
          });
        }),
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a tab binding could not be stored', operation, outcome.error, fields);
    } else {
      logger.info('tab binding stored', {
        ...fields,
        ...(outcome.value.displacedTab === undefined
          ? {}
          : { displacedTabId: outcome.value.displacedTab.tab.tabId }),
        ...(outcome.value.displacedSession === undefined
          ? {}
          : { displacedSessionId: outcome.value.displacedSession.sessionId }),
      });
    }

    return outcome;
  }

  function getBindingByTab(tabId: number): Result<TabBinding | undefined> {
    const operation = 'getBindingByTab';
    const fields = { tabId };
    const outcome = attempt(
      operation,
      (): Result<TabBinding | undefined> =>
        isIntegerInRange(tabId, 0, Number.MAX_SAFE_INTEGER)
          ? readBinding(SELECT_BINDING_BY_TAB_SQL, tabId, operation)
          : err(invalidArgumentError(operation, 'tabId', 'a non-negative integer tab id')),
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a tab binding could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  function getBindingBySession(sessionId: SessionId): Result<TabBinding | undefined> {
    const operation = 'getBindingBySession';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<TabBinding | undefined> => {
        const invalid = sessionIdError(operation, sessionId);

        return invalid === undefined
          ? readBinding(SELECT_BINDING_BY_SESSION_SQL, sessionId, operation)
          : err(invalid);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a tab binding could not be read', operation, outcome.error, fields);
    }

    return outcome;
  }

  function deleteBinding(tabId: number): Result<number> {
    const operation = 'deleteBinding';
    const fields = { tabId };
    const outcome = attempt(
      operation,
      (): Result<number> =>
        isIntegerInRange(tabId, 0, Number.MAX_SAFE_INTEGER)
          ? ok(changesOf(store.statement(DELETE_BINDING_BY_TAB_SQL).run(tabId)))
          : err(invalidArgumentError(operation, 'tabId', 'a non-negative integer tab id')),
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a tab binding could not be removed', operation, outcome.error, fields);
    } else {
      logger.info('tab binding removed', { ...fields, removed: outcome.value });
    }

    return outcome;
  }

  function deleteBindingsForSession(sessionId: SessionId): Result<number> {
    const operation = 'deleteBindingsForSession';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<number> => {
        const invalid = sessionIdError(operation, sessionId);

        return invalid === undefined
          ? ok(changesOf(store.statement(DELETE_BINDING_BY_SESSION_SQL).run(sessionId)))
          : err(invalid);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('a tab binding could not be removed', operation, outcome.error, fields);
    } else {
      logger.info('tab binding removed', { ...fields, removed: outcome.value });
    }

    return outcome;
  }

  // -----------------------------------------------------------------------------------------------
  // session_keys — the one secret this store holds as a value
  // -----------------------------------------------------------------------------------------------

  /**
   * Reads a session's stored secret, validating its shape. The error names the
   * session and never the value.
   */
  function readSecret(sessionId: SessionId, operation: string): Result<string | undefined> {
    const row = store.statement(SELECT_REQUEST_KEY_SQL).get(sessionId);

    if (row === undefined) {
      return ok(undefined);
    }

    const secret = readText(row['request_key']);

    return secret !== undefined && REQUEST_KEY_SECRET_PATTERN.test(secret)
      ? ok(secret)
      : err(
          corruptRowError(operation, 'session_keys', { [LOG_BINDING_KEYS.sessionId]: sessionId }),
        );
  }

  function getOrCreateRequestKeySecret(sessionId: SessionId): Result<string> {
    const operation = 'getOrCreateRequestKeySecret';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    let minted = false;
    const outcome = attempt(
      operation,
      (): Result<string> => {
        const invalid = sessionIdError(operation, sessionId);

        if (invalid !== undefined) {
          return err(invalid);
        }

        return store.transaction((): Result<string> => {
          const existing = readSecret(sessionId, operation);

          if (isErr(existing)) {
            return existing;
          }

          if (existing.value !== undefined) {
            return ok(existing.value);
          }

          // `DO NOTHING` turns a racing writer's insert into a no-op, and the
          // read below returns whichever key won — the only key the session
          // will ever have. A missing session fails the foreign key instead.
          const inserted = store
            .statement(INSERT_REQUEST_KEY_SQL)
            .run(
              sessionId,
              randomBytes(REQUEST_KEY_SECRET_BYTES).toString('hex'),
              stamp(operation),
            );
          minted = changesOf(inserted) > 0;

          const stored = readSecret(sessionId, operation);

          if (isErr(stored)) {
            return stored;
          }

          return stored.value === undefined
            ? err(
                corruptRowError(operation, 'session_keys', {
                  ...fields,
                  problem: 'missing-after-insert',
                }),
              )
            : ok(stored.value);
        });
      },
      fields,
    );

    // Identifiers only: the value itself never reaches a log record.
    if (isErr(outcome)) {
      reportFailure('the request-key secret could not be read', operation, outcome.error, fields);
    } else if (minted) {
      logger.info('request-key secret minted', fields);
    }

    return outcome;
  }

  function hasRequestKeySecret(sessionId: SessionId): Result<boolean> {
    const operation = 'hasRequestKeySecret';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<boolean> => {
        const invalid = sessionIdError(operation, sessionId);

        return invalid === undefined
          ? ok(store.statement(SELECT_REQUEST_KEY_EXISTS_SQL).get(sessionId) !== undefined)
          : err(invalid);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure('the request-key secret could not be probed', operation, outcome.error, fields);
    }

    return outcome;
  }

  function deleteRequestKeySecret(sessionId: SessionId): Result<boolean> {
    const operation = 'deleteRequestKeySecret';
    const fields = { [LOG_BINDING_KEYS.sessionId]: sessionId };
    const outcome = attempt(
      operation,
      (): Result<boolean> => {
        const invalid = sessionIdError(operation, sessionId);

        return invalid === undefined
          ? ok(changesOf(store.statement(DELETE_REQUEST_KEY_SQL).run(sessionId)) > 0)
          : err(invalid);
      },
      fields,
    );

    if (isErr(outcome)) {
      reportFailure(
        'the request-key secret could not be deleted',
        operation,
        outcome.error,
        fields,
      );
    } else {
      logger.debug('request-key secret deleted', { ...fields, removed: outcome.value });
    }

    return outcome;
  }

  return Object.freeze({
    insert,
    update,
    get,
    setStatus,
    list,
    delete: deleteSession,
    appendProgress,
    listProgress,
    insertPlan,
    getPlan,
    listPlans,
    latestPlanVersion,
    nextPlanVersion,
    startCapture,
    stopCapture,
    getCapture,
    getActiveCapture,
    listCaptures,
    appendFollowUp,
    listFollowUps,
    upsertBinding,
    getBindingByTab,
    getBindingBySession,
    deleteBinding,
    deleteBindingsForSession,
    getOrCreateRequestKeySecret,
    hasRequestKeySecret,
    deleteRequestKeySecret,
  });
}
