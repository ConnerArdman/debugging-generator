/**
 * Persistence for a session's generated panels and the analyses behind them:
 * the `panels` and `analyses` tables of `./schema.sql`, their two version
 * ladders, and the `supersedes` chain that links one generation of a panel to
 * the next.
 *
 * ## The integrity boundary this module sits on
 *
 * A panel is what a developer reads as the answer to their question, and an
 * analysis is the evidence-backed reasoning that answer is drawn from. Both are
 * produced upstream — the analysis by `createAnalysisResult` from findings the
 * analyze stage validated, the panel by `normalizePanel` followed by
 * `validatePanelSpec` and the semantic check against the capture (AAP 0.5.3) —
 * and this module's whole job is to keep them exactly as they were decided.
 *
 * It therefore **never manufactures, repairs or edits** a document. It does not
 * mint an id, fill in a missing field, drop an unknown one or normalise `meta`:
 * identity comes from the document (`PanelSpec.id`, `AnalysisResult.id`), and a
 * document that fails its upstream parser — `parsePanelSpec` from
 * `@debuggen/panel-schema`, `parseAnalysisResult` from `@debuggen/protocol` — is
 * refused with an `Err` rather than stored in part. That refusal is a defined
 * outcome, not a crash: the panel stage turns it into the deterministic fallback
 * panel, and the state machine keeps the session out of `generated`, which it may
 * only reach once a validated analysis **and** a validated panel exist
 * (AAP 0.5.5).
 *
 * The bytes written are the serialization of the **validated** value, and the
 * value handed back is that serialization parsed again, so what a caller holds
 * after an insert is byte-for-byte what every later read returns. In particular
 * `meta.fallback` — the flag behind the DevTools "fallback view" banner — goes
 * in and comes out untouched.
 *
 * ## The two version ladders
 *
 * A follow-up question answered from existing evidence does not overwrite
 * anything: the analysis and the panel are regenerated from the stored capture
 * and saved as **new versions** — `panelVersion n + 1` with `supersedes` naming
 * panel *n*, and `analysisVersion n + 1` beside it (AAP 0.4.2). The two `UNIQUE`
 * constraints of the DDL, `(session_id, panel_version)` and
 * `(session_id, version)`, make each ladder a database invariant, and this
 * module reports a violation as an `Err` whose hint names the method a caller
 * takes the next version from — {@link PanelsRepo.nextPanelVersion} or
 * {@link PanelsRepo.nextAnalysisVersion} — instead of letting a guessed version
 * silently replace a stored answer.
 *
 * On top of the constraints, an insert refuses a chain that cannot be true:
 *
 * - a panel that supersedes itself, or that supersedes anything while claiming
 *   to be its session's first version (`validatePanelSpec` rejects both too; the
 *   store must not depend on a caller having run it);
 * - a document whose predecessor is still stored but belongs to another session
 *   or does not carry a lower version.
 *
 * A predecessor that is **absent** is accepted. The `supersedes` column is
 * deliberately not a foreign key (`./schema.sql`), so a superseded panel can be
 * purged on its own without cascading into its successor or nulling the
 * successor's pointer; a dangling `supersedes` is therefore history, not
 * corruption.
 *
 * ## Columns and fields
 *
 * | Column          | `panels` ← `PanelSpec`        | `analyses` ← `AnalysisResult` |
 * | --------------- | ----------------------------- | ----------------------------- |
 * | `id`            | `id`                          | `id`                          |
 * | `session_id`    | `sessionId`                   | `sessionId`                   |
 * | version         | `panel_version` ← `panelVersion` | `version` ← `analysisVersion` |
 * | `supersedes`    | `supersedes ?? NULL`          | *(no column — in the document)* |
 * | `capture_id`    | `options.captureId ?? NULL`   | `captureId`                   |
 * | document        | `spec` (JSON)                 | `result` (JSON)               |
 * | `created_at`    | the injected clock            | the injected clock            |
 *
 * The analysis version column is named `version`, as AAP 0.4.2 lists it; there
 * is no `analysis_version` column anywhere. `created_at` records when the store
 * persisted the row, which is the tie-breaker of the ladder queries; the
 * analysis's own `createdAt` — when it was produced — stays inside the document.
 *
 * `capture_id` is `ON DELETE SET NULL`: a panel or analysis stays readable as a
 * record of what was concluded after the capture's rows have aged out, and a
 * deterministic fallback panel may have been assembled with no capture at all.
 * Because of that edge, a `NULL` column beside a document naming a capture is a
 * legitimate state and is never treated as a mismatch.
 *
 * ## Reading a row back
 *
 * The document column is authoritative; the other columns are projections
 * maintained on every write (`./schema.sql`, "Documents"). A row is returned only
 * when its JSON parses, the parsed value passes the same upstream parser the
 * insert used, and the projections agree with it (`id`, `session_id`, the version
 * and, for panels, `supersedes`). Anything else is a corrupt row, reported as an
 * `Err` naming the row's id and version and nothing else — never a throw, never a
 * partially typed object. The JSON engine's own message is deliberately not
 * attached, because it quotes a fragment of the text it could not parse; the
 * schema parsers' errors are attached as `cause`, since they carry field paths
 * and issue codes with every rejected value already stripped. A list read fails
 * as a whole on one corrupt row rather than skipping it: a history with a silent
 * hole would misreport which answer is the latest.
 *
 * ## Errors
 *
 * Every method returns a {@link Result} and never throws. The code is
 * `STORE_ERROR` whenever persistence itself refused — a taken version, a
 * duplicate id, an unknown session or capture, a chain the stored rows
 * contradict, a corrupt row, a closed handle — and `details.reason` carries one
 * of {@link PANELS_REPO_FAILURE_REASONS} so a caller branches without parsing a
 * message. A document the upstream parser refused keeps that parser's code
 * (`PANEL_INVALID` for a panel, `PROTOCOL_INVALID_MESSAGE` for an analysis), and
 * the two document-level chain refusals of a panel are `PANEL_INVALID`, matching
 * the issue codes `validatePanelSpec` reports for the same faults.
 *
 * ## Privacy
 *
 * An analysis holds the developer's observed facts and the code locations they
 * point at, and a panel holds model-authored prose about captured runtime data.
 * Neither a statement, a title, a label nor any other document content ever
 * reaches a log record or an error's `details`: this module logs and reports
 * ids, versions, counts, one boolean (`fallback`) and an enumerated reason, and
 * every value reaches SQLite as a bound parameter of a constant statement.
 *
 * @packageDocumentation
 */

import { parsePanelSpec } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import { ANALYSIS_VERSION_START, parseAnalysisResult } from '@debuggen/protocol';
import type { AnalysisResult } from '@debuggen/protocol';
import { DebuggenError, err, isErr, noopLogger, nowEpochMs, ok, tryCatch } from '@debuggen/shared';
import type {
  AnalysisId,
  CaptureId,
  Logger,
  LogFields,
  PanelId,
  Result,
  SessionId,
} from '@debuggen/shared';

import { LOG_BINDING_KEYS } from '../logging.js';
import type { Store } from './db.js';

/* -------------------------------------------------------------------------------------------------
 * Bindings and small vocabularies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` binding every record from this repository carries, matching
 * the other store modules so store lines can be filtered out of a session's log
 * without matching on message text.
 */
const SUBSYSTEM = 'store';

/**
 * The `repo` binding, which distinguishes this repository's records from the
 * other repositories sharing the `store` subsystem. One name covers both tables:
 * they are one module's responsibility and share one lifecycle.
 */
const REPO = 'panels';

/** The field name the `repo` binding is emitted under. */
const REPO_BINDING_KEY = 'repo';

/**
 * The first `panelVersion` of a session.
 *
 * The lower bound `panelSpecSchema` enforces on the field (an integer of at
 * least 1). `@debuggen/panel-schema` exports no constant for it — unlike the
 * analysis ladder, whose start `@debuggen/protocol` publishes as
 * `ANALYSIS_VERSION_START` — so the ladder's starting point is named once here,
 * where {@link PanelsRepo.nextPanelVersion} and the first-version chain rule use
 * it.
 */
const FIRST_PANEL_VERSION = 1;

/**
 * Every `details.reason` this repository reports, in the order the checks run.
 *
 * - `invalid-document` — the upstream parser refused the document; nothing was
 *   written, and the error keeps that parser's code.
 * - `supersedes-self` — a panel names itself as its predecessor.
 * - `supersedes-on-first-version` — a panel at its session's first version names
 *   a predecessor.
 * - `invalid-clock` — the injected clock returned a value that is not a finite
 *   number, so no `created_at` could be written.
 * - `unknown-session` — no `sessions` row holds the document's session id.
 * - `unknown-capture` — no `captures` row holds the capture id to associate.
 * - `capture-session-mismatch` — the capture belongs to a different session.
 * - `supersedes-other-session` — the stored predecessor belongs to a different
 *   session.
 * - `supersedes-not-earlier` — the stored predecessor does not carry a lower
 *   version than the document.
 * - `duplicate-id` — a row with the document's id is already stored.
 * - `version-taken` — the session already holds this version; take the next one
 *   from `nextPanelVersion` / `nextAnalysisVersion`.
 * - `corrupt-row` — a stored row is not a document this build can read.
 * - `store-failed` — anything else the store refused: a closed handle, a disk
 *   failure, a lock that could not be taken.
 */
export const PANELS_REPO_FAILURE_REASONS = Object.freeze([
  'invalid-document',
  'supersedes-self',
  'supersedes-on-first-version',
  'invalid-clock',
  'unknown-session',
  'unknown-capture',
  'capture-session-mismatch',
  'supersedes-other-session',
  'supersedes-not-earlier',
  'duplicate-id',
  'version-taken',
  'corrupt-row',
  'store-failed',
] as const);

/** One of {@link PANELS_REPO_FAILURE_REASONS}. */
export type PanelsRepoFailureReason = (typeof PANELS_REPO_FAILURE_REASONS)[number];

/**
 * Why a stored row was judged corrupt, as `details.corruption` beside
 * `reason: 'corrupt-row'`.
 *
 * - `document-not-text` — the document column does not hold text;
 * - `unparseable-json` — the text is not JSON;
 * - `schema-mismatch` — the JSON is not a document the upstream parser accepts;
 * - `projection-mismatch` — the flat columns disagree with the document they
 *   project, so the ladder queries would order the history wrongly.
 */
export type PanelsRepoCorruption =
  'document-not-text' | 'unparseable-json' | 'schema-mismatch' | 'projection-mismatch';

/**
 * Whether a value is one of {@link PANELS_REPO_FAILURE_REASONS}, for a caller
 * reading `details.reason` off an error it did not construct.
 *
 * @param value Any value.
 * @returns `true` when `value` is a reason this repository reports.
 */
export function isPanelsRepoFailureReason(value: unknown): value is PanelsRepoFailureReason {
  return (
    typeof value === 'string' && (PANELS_REPO_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------------------------------
 * Statements
 *
 * Every statement is a module-level constant: values reach SQLite as bound
 * parameters only (the `Store.statement` contract), and the text is the key of
 * the store's prepared-statement cache.
 * ---------------------------------------------------------------------------------------------- */

/** The columns a panel is read back from: the document and its projections. */
const PANEL_SELECTED = 'id, session_id, panel_version, supersedes, spec';

/** Writes one panel row. */
const INSERT_PANEL_SQL = `INSERT INTO panels (id, session_id, panel_version, supersedes, capture_id, spec, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** Reads one panel by its id. */
const SELECT_PANEL_BY_ID_SQL = `SELECT ${PANEL_SELECTED} FROM panels WHERE id = ?`;

/**
 * Reads the newest panel of a session.
 *
 * `UNIQUE (session_id, panel_version)` gives SQLite an index whose leading
 * columns are exactly this filter and this order, so the read is one index seek
 * rather than a scan of the session's history. The version is unique within a
 * session, so the `created_at` and `id` tie-breakers never decide anything on a
 * healthy store; they are there so the answer stays deterministic on one that
 * was written by something other than this module.
 */
const SELECT_LATEST_PANEL_SQL = `SELECT ${PANEL_SELECTED} FROM panels
WHERE session_id = ?
ORDER BY panel_version DESC, created_at DESC, id DESC
LIMIT 1`;

/** Reads a session's panel history, oldest version first. */
const SELECT_PANELS_BY_SESSION_SQL = `SELECT ${PANEL_SELECTED} FROM panels
WHERE session_id = ?
ORDER BY panel_version ASC, created_at ASC, id ASC`;

/** The highest panel version a session holds, `NULL` when it holds none. */
const SELECT_MAX_PANEL_VERSION_SQL =
  'SELECT MAX(panel_version) AS latest FROM panels WHERE session_id = ?';

/**
 * Reads the panels that name a given panel as their predecessor.
 *
 * `supersedes` carries no index, so this is a scan of the `panels` table. That
 * is deliberate rather than an oversight: the table holds a handful of rows per
 * session — one per question and follow-up — and is purged with its sessions,
 * and the query runs when a user interface walks a panel's history, never on an
 * ingest or render path.
 */
const SELECT_PANELS_SUPERSEDING_SQL = `SELECT ${PANEL_SELECTED} FROM panels
WHERE supersedes = ?
ORDER BY panel_version ASC, created_at ASC, id ASC`;

/**
 * The session and version of a stored panel, for the predecessor check.
 *
 * The version is aliased to `version`, the analyses table's own column name, so
 * the lineage rows of both ladders are read with one set of keys.
 */
const SELECT_PANEL_LINEAGE_SQL =
  'SELECT session_id, panel_version AS version FROM panels WHERE id = ?';

/** Counts one session's panels. */
const COUNT_PANELS_BY_SESSION_SQL = 'SELECT COUNT(*) AS total FROM panels WHERE session_id = ?';

/** Removes one session's panels. */
const DELETE_PANELS_BY_SESSION_SQL = 'DELETE FROM panels WHERE session_id = ?';

/** The columns an analysis is read back from: the document and its projections. */
const ANALYSIS_SELECTED = 'id, session_id, version, result';

/**
 * Writes one analysis row.
 *
 * `version` is the column `AnalysisResult.analysisVersion` is persisted in; see
 * the mapping table in this module's overview.
 */
const INSERT_ANALYSIS_SQL = `INSERT INTO analyses (id, session_id, capture_id, version, result, created_at)
VALUES (?, ?, ?, ?, ?, ?)`;

/** Reads one analysis by its id. */
const SELECT_ANALYSIS_BY_ID_SQL = `SELECT ${ANALYSIS_SELECTED} FROM analyses WHERE id = ?`;

/**
 * Reads the newest analysis of a session: one seek on the index behind
 * `UNIQUE (session_id, version)`, exactly as {@link SELECT_LATEST_PANEL_SQL}.
 */
const SELECT_LATEST_ANALYSIS_SQL = `SELECT ${ANALYSIS_SELECTED} FROM analyses
WHERE session_id = ?
ORDER BY version DESC, created_at DESC, id DESC
LIMIT 1`;

/** Reads a session's analysis history, oldest version first. */
const SELECT_ANALYSES_BY_SESSION_SQL = `SELECT ${ANALYSIS_SELECTED} FROM analyses
WHERE session_id = ?
ORDER BY version ASC, created_at ASC, id ASC`;

/** The highest analysis version a session holds, `NULL` when it holds none. */
const SELECT_MAX_ANALYSIS_VERSION_SQL =
  'SELECT MAX(version) AS latest FROM analyses WHERE session_id = ?';

/** The session and version of a stored analysis, for the predecessor check. */
const SELECT_ANALYSIS_LINEAGE_SQL = 'SELECT session_id, version FROM analyses WHERE id = ?';

/** Counts one session's analyses. */
const COUNT_ANALYSES_BY_SESSION_SQL = 'SELECT COUNT(*) AS total FROM analyses WHERE session_id = ?';

/** Removes one session's analyses. */
const DELETE_ANALYSES_BY_SESSION_SQL = 'DELETE FROM analyses WHERE session_id = ?';

/** Whether a session row exists. */
const SELECT_SESSION_EXISTS_SQL = 'SELECT 1 AS present FROM sessions WHERE id = ?';

/** The owning session of a capture, for the association check. */
const SELECT_CAPTURE_OWNER_SQL = 'SELECT session_id FROM captures WHERE id = ?';

/* -------------------------------------------------------------------------------------------------
 * The two ladders
 * ---------------------------------------------------------------------------------------------- */

/**
 * The identity and position of a document on its ladder, read off the
 * validated document rather than taken from a caller.
 */
interface DocumentIdentity {
  /** The document's own id. */
  readonly id: string;

  /** The session it belongs to. */
  readonly sessionId: string;

  /** Its version on the session's ladder. */
  readonly version: number;

  /** The id of the document it supersedes, when it names one. */
  readonly supersedes: string | undefined;
}

/**
 * The names and constants that describe one of the two tables, independent of
 * the document type it stores.
 *
 * Split out of {@link Ladder} so that the error and logging helpers, which only
 * ever read these labels, can take either ladder without a type parameter: the
 * document-typed members of {@link Ladder} make `Ladder<PanelSpec>` and
 * `Ladder<AnalysisResult>` unrelated types under `strictFunctionTypes`.
 */
interface LadderLabels {
  /** The document's name in messages. */
  readonly noun: 'panel' | 'analysis';

  /** The `details` key a document's id is reported under. */
  readonly idKey: 'panelId' | 'analysisId';

  /**
   * The `details` key a document's version is reported under, which is also the
   * name of the version field on the document itself.
   */
  readonly versionKey: 'panelVersion' | 'analysisVersion';

  /** The column the read statements return the version in. */
  readonly versionColumn: 'panel_version' | 'version';

  /** The column holding the JSON document. */
  readonly documentColumn: 'spec' | 'result';

  /**
   * Whether the table projects `supersedes` into a column of its own. Only
   * `panels` does; an analysis's predecessor lives in its document alone.
   */
  readonly projectsSupersedes: boolean;

  /** The version a session's first document carries. */
  readonly firstVersion: number;

  /** The repository method a caller takes the next version from. */
  readonly nextVersionMethod: 'nextPanelVersion' | 'nextAnalysisVersion';
}

/**
 * Everything the shared read, insert and version logic needs to know about one
 * of the two tables.
 *
 * One descriptor per table, rather than two copies of the logic, is what keeps
 * the panel ladder and the analysis ladder from drifting apart on what a corrupt
 * row is, how a taken version is reported or where a ladder starts.
 *
 * @typeParam T The document type the table stores.
 */
interface Ladder<T> extends LadderLabels {
  /** The upstream parser that judges whether a value is a document. */
  readonly parse: (value: unknown) => Result<T, DebuggenError>;

  /** Reads the ladder identity off a validated document. */
  readonly identify: (document: T) => DocumentIdentity;

  /**
   * The ids, versions, counts and flags a successful write is logged with —
   * never a title, a statement, a label or any other document content.
   */
  readonly describe: (document: T) => LogFields;

  /** The table's `INSERT`. */
  readonly insertSql: string;

  /**
   * The bind list for {@link Ladder.insertSql}, in the column order the
   * statement declares.
   */
  readonly insertValues: (row: InsertRow) => readonly BoundValue[];

  /** The table's read statements. */
  readonly sql: {
    readonly selectById: string;
    readonly selectLatest: string;
    readonly selectBySession: string;
    readonly selectMaxVersion: string;
    readonly selectLineage: string;
  };
}

/** A value `node:sqlite` binds: text, a number, or `NULL`. */
type BoundValue = string | number | null;

/** What one insert writes, assembled from the validated document. */
interface InsertRow {
  /** The document's ladder identity. */
  readonly identity: DocumentIdentity;

  /** The capture to associate, or `undefined` for `NULL`. */
  readonly captureId: string | undefined;

  /** The JSON text of the validated document. */
  readonly serialized: string;

  /** The `created_at` reading, in whole epoch milliseconds. */
  readonly storedAt: number;
}

/** The `panels` ladder. */
const PANEL_LADDER: Ladder<PanelSpec> = Object.freeze({
  noun: 'panel',
  idKey: 'panelId',
  versionKey: 'panelVersion',
  versionColumn: 'panel_version',
  documentColumn: 'spec',
  projectsSupersedes: true,
  firstVersion: FIRST_PANEL_VERSION,
  nextVersionMethod: 'nextPanelVersion',
  parse: parsePanelSpec,
  identify: (spec: PanelSpec): DocumentIdentity => ({
    id: spec.id,
    sessionId: spec.sessionId,
    version: spec.panelVersion,
    supersedes: spec.supersedes,
  }),
  describe: (spec: PanelSpec): LogFields => ({
    fallback: spec.meta?.fallback === true,
    layoutNodes: spec.layout.length,
    observed: spec.summary.observed.length,
    likelyCauses: spec.summary.likelyCauses.length,
  }),
  insertSql: INSERT_PANEL_SQL,
  insertValues: ({
    identity,
    captureId,
    serialized,
    storedAt,
  }: InsertRow): readonly BoundValue[] => [
    identity.id,
    identity.sessionId,
    identity.version,
    identity.supersedes ?? null,
    captureId ?? null,
    serialized,
    storedAt,
  ],
  sql: Object.freeze({
    selectById: SELECT_PANEL_BY_ID_SQL,
    selectLatest: SELECT_LATEST_PANEL_SQL,
    selectBySession: SELECT_PANELS_BY_SESSION_SQL,
    selectMaxVersion: SELECT_MAX_PANEL_VERSION_SQL,
    selectLineage: SELECT_PANEL_LINEAGE_SQL,
  }),
});

/**
 * The `analyses` ladder, whose version column is named `version` and holds
 * `AnalysisResult.analysisVersion`.
 */
const ANALYSIS_LADDER: Ladder<AnalysisResult> = Object.freeze({
  noun: 'analysis',
  idKey: 'analysisId',
  versionKey: 'analysisVersion',
  versionColumn: 'version',
  documentColumn: 'result',
  projectsSupersedes: false,
  firstVersion: ANALYSIS_VERSION_START,
  nextVersionMethod: 'nextAnalysisVersion',
  parse: parseAnalysisResult,
  identify: (result: AnalysisResult): DocumentIdentity => ({
    id: result.id,
    sessionId: result.sessionId,
    version: result.analysisVersion,
    supersedes: result.supersedes,
  }),
  describe: (result: AnalysisResult): LogFields => ({
    observed: result.observed.length,
    likelyCauses: result.likelyCauses.length,
    metrics: result.metrics.length,
  }),
  insertSql: INSERT_ANALYSIS_SQL,
  insertValues: ({
    identity,
    captureId,
    serialized,
    storedAt,
  }: InsertRow): readonly BoundValue[] => [
    identity.id,
    identity.sessionId,
    captureId ?? null,
    identity.version,
    serialized,
    storedAt,
  ],
  sql: Object.freeze({
    selectById: SELECT_ANALYSIS_BY_ID_SQL,
    selectLatest: SELECT_LATEST_ANALYSIS_SQL,
    selectBySession: SELECT_ANALYSES_BY_SESSION_SQL,
    selectMaxVersion: SELECT_MAX_ANALYSIS_VERSION_SQL,
    selectLineage: SELECT_ANALYSIS_LINEAGE_SQL,
  }),
});

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/** What {@link createPanelsRepo} is constructed from. */
export interface PanelsRepoDeps {
  /**
   * The open, migrated store handle from `./db.ts`.
   *
   * The repository owns no connection of its own, which puts its statements in
   * the shared prepared-statement cache and its writes inside whatever
   * transaction a caller has already opened: the retention sweep removes a
   * session's panels, analyses and telemetry in one transaction, and either all
   * of it goes or none does.
   */
  readonly store: Store;

  /**
   * Where the repository reports what it stored. Defaults to the shared no-op
   * logger, so a suite that does not care about output passes nothing.
   *
   * A child bound to `{ subsystem: 'store', repo: 'panels' }` is derived from
   * it. Records carry ids, versions and counts only — see the privacy note in
   * this module's overview.
   */
  readonly logger?: Logger | undefined;

  /**
   * Reads the current epoch-millisecond time for the `created_at` column.
   * Defaults to `nowEpochMs()`.
   *
   * Injectable so a suite can assert an exact row and order ties without fake
   * timers. A sub-millisecond reading is rounded to whole milliseconds, the
   * resolution of the `INTEGER` column, which a `STRICT` table would otherwise
   * refuse; a reading that is not a finite number is refused with
   * `invalid-clock` rather than written.
   */
  readonly now?: (() => number) | undefined;
}

/** Options for {@link PanelsRepo.insertPanel}. */
export interface InsertPanelOptions {
  /**
   * The capture the panel was generated from, stored in the `capture_id`
   * column.
   *
   * Absent for a panel that has no capture behind it — a deterministic fallback
   * assembled before any evidence was stored is a legitimate panel. When given,
   * the capture must exist and belong to the panel's session.
   */
  readonly captureId?: CaptureId | undefined;
}

/**
 * How many panels and analyses one session holds, or held before a delete.
 *
 * The shape both {@link PanelsRepo.countBySession} and
 * {@link PanelsRepo.deleteBySession} answer with, so `./retention.ts` can put
 * the same two numbers in its report whichever it called.
 */
export interface SessionDocumentCounts {
  /** Rows of the `panels` table. */
  readonly panels: number;

  /** Rows of the `analyses` table. */
  readonly analyses: number;
}

/**
 * The panels and analyses of every session, over the session store.
 *
 * Every method is synchronous — `node:sqlite` is a synchronous binding, so a
 * returned `Ok` from an insert means a committed row — answers with a
 * {@link Result} and **never throws**. Every returned document is parsed out of
 * its row (or, for an insert, out of the exact bytes written), so a caller may
 * keep it without ever holding a value the store does not.
 */
export interface PanelsRepo {
  /**
   * Stores a validated panel as the next rung of its session's ladder.
   *
   * The panel is parsed with `parsePanelSpec` first and refused, unwritten, when
   * it fails (`invalid-document`, code `PANEL_INVALID`) — which is the signal the
   * panel stage turns into its deterministic fallback. It is then refused when
   * it names itself as its predecessor (`supersedes-self`) or names any
   * predecessor at its session's first version (`supersedes-on-first-version`),
   * both `PANEL_INVALID`; and, inside one `BEGIN IMMEDIATE` transaction, when its
   * session is unknown, when `options.captureId` names an unknown capture or
   * another session's, when a stored predecessor belongs to another session or
   * is not an earlier version, when its id is already stored (`duplicate-id`),
   * or when its session already holds its `panelVersion` (`version-taken`, whose
   * hint points at {@link PanelsRepo.nextPanelVersion}) — all `STORE_ERROR`.
   *
   * Column mapping: `id` ← `spec.id`, `session_id` ← `spec.sessionId`,
   * `panel_version` ← `spec.panelVersion`, `supersedes` ← `spec.supersedes` or
   * `NULL`, `capture_id` ← `options.captureId` or `NULL`, `spec` ← the JSON of
   * the validated panel, `created_at` ← the injected clock.
   *
   * @param spec The panel to store, normally straight out of `normalizePanel`
   * and `validatePanelSpec`, or out of the fallback assembler.
   * @param options The capture to associate, when there is one.
   * @returns The stored panel exactly as every later read returns it —
   * `meta.fallback` included — or the refusal.
   */
  insertPanel(spec: PanelSpec, options?: InsertPanelOptions): Result<PanelSpec, DebuggenError>;

  /**
   * Reads one panel by its id.
   *
   * @param panelId The panel to read.
   * @returns `Ok(undefined)` when no row holds the id, the panel when one does,
   * or `corrupt-row` when the row is not a readable panel.
   */
  getPanel(panelId: PanelId): Result<PanelSpec | undefined, DebuggenError>;

  /**
   * Reads the newest panel of a session: the highest `panelVersion`, ties broken
   * by `created_at` then `id`, both descending.
   *
   * This is what `GET /sessions/:id/panel` serves, what `src/sessions/reopen.ts`
   * replays as the latest `panel.generated`, and half of the evidence the state
   * machine requires before a session may reach `generated`. One index seek.
   *
   * @param sessionId The session to read.
   * @returns `Ok(undefined)` when the session holds no panel, the newest panel
   * otherwise, or `corrupt-row`.
   */
  getLatestPanel(sessionId: SessionId): Result<PanelSpec | undefined, DebuggenError>;

  /**
   * Lists a session's panels, oldest version first.
   *
   * @param sessionId The session to list.
   * @returns Every panel of the session — an empty list is a success — or
   * `corrupt-row` when any one of them is unreadable.
   */
  listPanels(sessionId: SessionId): Result<PanelSpec[], DebuggenError>;

  /**
   * The `panelVersion` the session's next panel must carry: the highest stored
   * version plus one, or the first version when the session holds none.
   *
   * Read it in the same synchronous turn as the insert it feeds. Two writers
   * that read the same value race, and the loser's insert comes back as
   * `version-taken` rather than overwriting the winner.
   *
   * @param sessionId The session the next panel belongs to.
   * @returns The next version, or `corrupt-row` when a stored version is not a
   * positive integer.
   */
  nextPanelVersion(sessionId: SessionId): Result<number, DebuggenError>;

  /**
   * Lists the panels that name `panelId` as the panel they supersede, lowest
   * version first.
   *
   * Normally zero panels (the newest of its session) or one (its successor on
   * the follow-up path). The `supersedes` column is deliberately not a foreign
   * key: a successor may outlive the panel it names, and the panel named here
   * may already have been purged, in which case its successors are still
   * returned.
   *
   * @param panelId The superseded panel.
   * @returns Its successors, or `corrupt-row`.
   */
  listSupersededBy(panelId: PanelId): Result<PanelSpec[], DebuggenError>;

  /**
   * Stores a validated analysis as the next rung of its session's ladder.
   *
   * The analysis is parsed with `parseAnalysisResult` first and refused,
   * unwritten, when it fails (`invalid-document`, keeping the parser's
   * `PROTOCOL_INVALID_MESSAGE` code; that parser also refuses an analysis that
   * supersedes itself). Inside one `BEGIN IMMEDIATE` transaction it is then
   * refused, as `STORE_ERROR`, when its session is unknown, when its
   * `captureId` names an unknown capture or another session's, when a stored
   * predecessor belongs to another session or is not an earlier version, when
   * its id is already stored, or when its session already holds its
   * `analysisVersion` (`version-taken`, whose hint points at
   * {@link PanelsRepo.nextAnalysisVersion}).
   *
   * Column mapping: `id` ← `result.id`, `session_id` ← `result.sessionId`,
   * `capture_id` ← `result.captureId`, **`version` ← `result.analysisVersion`**
   * (the column is named `version`; there is no `analysis_version` column),
   * `result` ← the JSON of the validated analysis, `created_at` ← the injected
   * clock. The analysis's `supersedes` has no column of its own and lives in
   * the document.
   *
   * @param result The analysis to store, normally straight out of
   * `createAnalysisResult`.
   * @returns The stored analysis exactly as every later read returns it, or the
   * refusal.
   */
  insertAnalysis(result: AnalysisResult): Result<AnalysisResult, DebuggenError>;

  /**
   * Reads one analysis by its id.
   *
   * @param analysisId The analysis to read.
   * @returns `Ok(undefined)` when no row holds the id, the analysis when one
   * does, or `corrupt-row`.
   */
  getAnalysis(analysisId: AnalysisId): Result<AnalysisResult | undefined, DebuggenError>;

  /**
   * Reads the newest analysis of a session: the highest `analysisVersion`,
   * ties broken by `created_at` then `id`, both descending. One index seek, and
   * the other half of the evidence the state machine requires before a session
   * may reach `generated`.
   *
   * @param sessionId The session to read.
   * @returns `Ok(undefined)` when the session holds no analysis, the newest one
   * otherwise, or `corrupt-row`.
   */
  getLatestAnalysis(sessionId: SessionId): Result<AnalysisResult | undefined, DebuggenError>;

  /**
   * Lists a session's analyses, oldest version first.
   *
   * @param sessionId The session to list.
   * @returns Every analysis of the session — an empty list is a success — or
   * `corrupt-row` when any one of them is unreadable.
   */
  listAnalyses(sessionId: SessionId): Result<AnalysisResult[], DebuggenError>;

  /**
   * The `analysisVersion` the session's next analysis must carry: the highest
   * stored version plus one, or `ANALYSIS_VERSION_START` when the session holds
   * none. The same race note as {@link PanelsRepo.nextPanelVersion} applies.
   *
   * @param sessionId The session the next analysis belongs to.
   * @returns The next version, or `corrupt-row`.
   */
  nextAnalysisVersion(sessionId: SessionId): Result<number, DebuggenError>;

  /**
   * Counts one session's panels and analyses.
   *
   * Used by `./retention.ts` before it purges a session, so its report states
   * what the purge removed; the `ON DELETE CASCADE` edges would remove the rows
   * anyway, but a cascade reports no count.
   *
   * @param sessionId The session to count.
   * @returns Both counts, zero for an unknown session.
   */
  countBySession(sessionId: SessionId): Result<SessionDocumentCounts, DebuggenError>;

  /**
   * Removes one session's panels and analyses, in one transaction (a savepoint
   * when the caller already holds one), and reports how many rows went.
   *
   * @param sessionId The session to purge.
   * @returns The rows removed from each table, zero for an unknown session.
   */
  deleteBySession(sessionId: SessionId): Result<SessionDocumentCounts, DebuggenError>;
}

/* -------------------------------------------------------------------------------------------------
 * Internals
 * ---------------------------------------------------------------------------------------------- */

/** A row as `node:sqlite` hands it back, before anything is read out of it. */
type StoredRow = Record<string, unknown>;

/**
 * The extended result codes `node:sqlite` reports on the `errcode` property of
 * the error it throws, for the three constraint failures an insert here can
 * provoke. They are stable SQLite values — the same ones the other store
 * repositories match on — and matching on them keeps the classification off the
 * message text, which is not a contract.
 */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

/**
 * A `UNIQUE` index refused the row. The primary key reports
 * {@link SQLITE_CONSTRAINT_PRIMARYKEY} instead, so on both tables the only index
 * that raises this code is the version ladder's `(session_id, <version>)`.
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** A foreign key refused the row: no `sessions` or `captures` row holds the value. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

/**
 * The shape an id taken from a document that failed validation must have
 * before it may appear in an error: one printable, non-space ASCII token of
 * bounded length. A value that fails this is left out rather than quoted — an
 * invalid document's "id" could be anything, including captured content.
 */
const SAFE_TOKEN_PATTERN = /^[\x21-\x7e]{1,128}$/;

/**
 * Reads the extended SQLite result code off a thrown value.
 *
 * @param cause Whatever was caught.
 * @returns The numeric code, or `undefined` when the value is not a SQLite
 * error.
 */
function sqliteErrcode(cause: unknown): number | undefined {
  if (typeof cause === 'object' && cause !== null && 'errcode' in cause) {
    const { errcode } = cause;

    return typeof errcode === 'number' ? errcode : undefined;
  }

  return undefined;
}

/**
 * The `details` every error and log record from this module starts from.
 *
 * @param operation The repository method.
 * @param details Identifiers, versions, counts and an enumerated reason.
 * @returns The merged details.
 */
function context(
  operation: string,
  details: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM,
    [REPO_BINDING_KEY]: REPO,
    operation,
    ...details,
  };
}

/**
 * The identifying `details` of a validated document: its id, its session and
 * its version, under the ladder's own keys.
 *
 * @param labels The ladder the document belongs to.
 * @param identity The document's identity.
 * @returns The three fields.
 */
function identityDetails(labels: LadderLabels, identity: DocumentIdentity): LogFields {
  return {
    [labels.idKey]: identity.id,
    [LOG_BINDING_KEYS.sessionId]: identity.sessionId,
    [labels.versionKey]: identity.version,
  };
}

/**
 * Normalises a column value that should be a number.
 *
 * `node:sqlite` hands back a `bigint` for an integer column only when a
 * statement was configured to, which this module never does; the conversion is
 * here so a handle configured elsewhere cannot turn every read into a
 * corruption report. Anything else is passed through for the caller to judge.
 *
 * @param value The raw column value.
 * @returns A number where one was recoverable, otherwise `value` unchanged.
 */
function toColumnNumber(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * How many rows a write changed, as a number.
 *
 * @param result What `StatementSync.run` returned.
 * @returns The change count.
 */
function changesOf(result: { readonly changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
}

/**
 * The id of a row, for an error that may name nothing else about it.
 *
 * @param row The row as read.
 * @returns The id when the column holds a string, `'<unreadable>'` otherwise —
 * a placeholder rather than the raw value, which could be anything.
 */
function rowIdOf(row: StoredRow): string {
  const id = row['id'];

  return typeof id === 'string' ? id : '<unreadable>';
}

/**
 * The version a row's version column holds, when it holds a safe integer.
 *
 * @param row The row as read.
 * @param column The version column.
 * @returns The version, or `undefined` when the column holds anything else.
 */
function rowVersionOf(row: StoredRow, column: string): number | undefined {
  const version = toColumnNumber(row[column]);

  return typeof version === 'number' && Number.isSafeInteger(version) ? version : undefined;
}

/**
 * An own field of an arbitrary value, read without trusting its shape.
 *
 * @param value Anything.
 * @param key The field to read.
 * @returns The field's value, or `undefined` when `value` is not an object or
 * does not own the field.
 */
function ownField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) {
    return undefined;
  }

  return (value as Readonly<Record<string, unknown>>)[key];
}

/**
 * The identity fields of a document that failed validation, keeping only those
 * that are safe to report: ids that are short printable tokens and a version
 * that is a safe integer.
 *
 * A refused document is still worth locating in a log, but its fields have not
 * been judged by anything, so each one is admitted only on its own merits and
 * never quoted when it fails them.
 *
 * @param labels The ladder the value was offered to.
 * @param value The refused value.
 * @returns The admissible fields, possibly none.
 */
function refusedIdentityDetails(labels: LadderLabels, value: unknown): LogFields {
  const details: LogFields = {};
  const id = ownField(value, 'id');
  const sessionId = ownField(value, 'sessionId');
  const version = ownField(value, labels.versionKey);

  if (typeof id === 'string' && SAFE_TOKEN_PATTERN.test(id)) {
    details[labels.idKey] = id;
  }

  if (typeof sessionId === 'string' && SAFE_TOKEN_PATTERN.test(sessionId)) {
    details[LOG_BINDING_KEYS.sessionId] = sessionId;
  }

  if (typeof version === 'number' && Number.isSafeInteger(version)) {
    details[labels.versionKey] = version;
  }

  return details;
}

/**
 * The error for a document the upstream parser refused, before anything was
 * written.
 *
 * Keeps the parser's code — `PANEL_INVALID` for a panel,
 * `PROTOCOL_INVALID_MESSAGE` for an analysis — so a caller branches on it
 * exactly as it would on the parser's own result, and carries the parser's error
 * as `cause` for its issue paths (which hold no rejected value).
 *
 * @param labels The ladder the document was offered to.
 * @param operation The repository method.
 * @param value The refused value, read only for its admissible identity.
 * @param cause The parser's refusal.
 * @returns The coded error.
 */
function invalidDocumentError(
  labels: LadderLabels,
  operation: string,
  value: unknown,
  cause: DebuggenError,
): DebuggenError {
  const reason: PanelsRepoFailureReason = 'invalid-document';

  return new DebuggenError(
    cause.code,
    `A ${labels.noun} was refused before storage because it does not match the ${labels.noun} schema.`,
    {
      hint:
        cause.hint ??
        `Only a validated ${labels.noun} can be stored. Nothing was written; validate the document before storing it.`,
      details: context(operation, { ...refusedIdentityDetails(labels, value), reason }),
      cause,
    },
  );
}

/**
 * The error for a refusal this module decided itself: a chain rule, an unknown
 * session or capture, a bad clock reading.
 *
 * @param code `PANEL_INVALID` for a fault of the document alone, `STORE_ERROR`
 * for one judged against the stored rows.
 * @param operation The repository method.
 * @param reason The enumerated cause.
 * @param message What was refused.
 * @param hint What the caller should do about it.
 * @param details Identifiers and versions only.
 * @returns The coded error.
 */
function refusalError(
  code: 'PANEL_INVALID' | 'STORE_ERROR',
  operation: string,
  reason: PanelsRepoFailureReason,
  message: string,
  hint: string,
  details: LogFields,
): DebuggenError {
  return new DebuggenError(code, message, {
    hint,
    details: context(operation, { ...details, reason }),
  });
}

/**
 * The error for a stored row that is not a readable document.
 *
 * Names the row's id and, when readable, its version — nothing else. The JSON
 * engine's own error is deliberately never attached (it quotes a fragment of the
 * text it could not parse); a schema parser's error is, because it carries
 * field paths and issue codes with every rejected value already stripped.
 *
 * @param labels The ladder the row belongs to.
 * @param operation The repository method.
 * @param row The row as read.
 * @param corruption What is wrong with it.
 * @param cause The schema parser's refusal, for `schema-mismatch` only.
 * @returns The coded error.
 */
function corruptRowError(
  labels: LadderLabels,
  operation: string,
  row: StoredRow,
  corruption: PanelsRepoCorruption,
  cause?: DebuggenError,
): DebuggenError {
  const reason: PanelsRepoFailureReason = 'corrupt-row';
  const version = rowVersionOf(row, labels.versionColumn);

  return new DebuggenError(
    'STORE_ERROR',
    `A stored ${labels.noun} could not be read back as a ${labels.noun} document.`,
    {
      hint: `The row was written by a different build of Debug Generator or edited outside it. Nothing was changed: ask the question again to store a new version, and report the ${labels.noun} id with the service log.`,
      details: context(operation, {
        [labels.idKey]: rowIdOf(row),
        ...(version === undefined ? {} : { [labels.versionKey]: version }),
        reason,
        corruption,
      }),
      cause,
    },
  );
}

/**
 * The error for a store operation that failed for a reason of its own — a
 * closed handle, a lock, a disk failure.
 *
 * @param operation The repository method.
 * @param cause Whatever was caught.
 * @param details Identifiers and versions to attach.
 * @returns The coded error.
 */
function storeFailedError(
  operation: string,
  cause: unknown,
  details: LogFields = {},
): DebuggenError {
  const reason: PanelsRepoFailureReason = 'store-failed';
  const error = DebuggenError.from(cause, 'STORE_ERROR');

  return new DebuggenError('STORE_ERROR', 'The panel store could not complete an operation.', {
    hint:
      error.hint ??
      'Check that the state directory is writable and that no other Debug Generator service is running against it, then retry.',
    details: context(operation, { ...details, reason }),
    cause,
  });
}

/**
 * Classifies what an insert's transaction threw.
 *
 * The three constraint codes get their own reasons — above all `version-taken`,
 * whose hint is what keeps a follow-up that guessed its version from ever
 * overwriting a stored answer. Everything else is `store-failed`.
 *
 * @param labels The ladder written to.
 * @param operation The repository method.
 * @param identity The document's identity.
 * @param cause Whatever was caught.
 * @returns The coded error.
 */
function insertFailureError(
  labels: LadderLabels,
  operation: string,
  identity: DocumentIdentity,
  cause: unknown,
): DebuggenError {
  const errcode = sqliteErrcode(cause);
  const details = identityDetails(labels, identity);
  let reason: PanelsRepoFailureReason | undefined;
  let message = '';
  let hint = '';

  if (errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
    reason = 'duplicate-id';
    message = `A ${labels.noun} with this id is already stored.`;
    hint = `A stored ${labels.noun} is never replaced. Mint a new id for a new version instead of storing an existing ${labels.noun} again.`;
  } else if (errcode === SQLITE_CONSTRAINT_UNIQUE) {
    reason = 'version-taken';
    message = `The session already holds a ${labels.noun} at this version.`;
    hint = `Versions are never overwritten. Take the next version from ${labels.nextVersionMethod} and store the ${labels.noun} as that version.`;
  } else if (errcode === SQLITE_CONSTRAINT_FOREIGNKEY) {
    reason = 'unknown-session';
    message = `A ${labels.noun} names a session or capture the store does not hold.`;
    hint = `The session and its capture must be stored before its ${labels.noun}, and a purged session takes its ${labels.noun} history with it.`;
  }

  if (reason === undefined) {
    return storeFailedError(operation, cause, details);
  }

  return new DebuggenError('STORE_ERROR', message, {
    hint,
    details: context(operation, { ...details, reason }),
    cause,
  });
}

/**
 * Turns one row into a document, or into the reason it is not one.
 *
 * The document column is parsed as JSON inside `tryCatch`, then judged by the
 * ladder's upstream parser, and finally compared with the flat columns that
 * project it — `id`, `session_id`, the version and, on `panels`, `supersedes`.
 * The projections are what the ladder queries order and filter by, so a row
 * whose projections disagree with its document would put the wrong answer at
 * the top of the history; it is reported rather than returned.
 *
 * `capture_id` is not compared: `ON DELETE SET NULL` legitimately clears it
 * while the document still names its capture.
 *
 * @typeParam T The ladder's document type.
 * @param ladder The ladder the row belongs to.
 * @param operation The repository method, for the error's details.
 * @param row The row as read.
 * @returns The validated document, or `corrupt-row`.
 */
function documentFromRow<T>(ladder: Ladder<T>, operation: string, row: StoredRow): Result<T> {
  const text = row[ladder.documentColumn];

  if (typeof text !== 'string') {
    return err(corruptRowError(ladder, operation, row, 'document-not-text'));
  }

  const json = tryCatch(() => JSON.parse(text) as unknown, 'STORE_ERROR');

  if (isErr(json)) {
    return err(corruptRowError(ladder, operation, row, 'unparseable-json'));
  }

  const parsed = ladder.parse(json.value);

  if (isErr(parsed)) {
    return err(corruptRowError(ladder, operation, row, 'schema-mismatch', parsed.error));
  }

  const identity = ladder.identify(parsed.value);
  const projectionsAgree =
    identity.id === row['id'] &&
    identity.sessionId === row['session_id'] &&
    identity.version === rowVersionOf(row, ladder.versionColumn) &&
    (!ladder.projectsSupersedes || (identity.supersedes ?? null) === (row['supersedes'] ?? null));

  if (!projectionsAgree) {
    return err(corruptRowError(ladder, operation, row, 'projection-mismatch'));
  }

  return ok(parsed.value);
}

/* -------------------------------------------------------------------------------------------------
 * The repository
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the panel and analysis repository over an open store.
 *
 * `src/main.ts` constructs one per process and hands it to the panel stage
 * (`src/panels/generate.ts`, `src/panels/fallback.ts`), the analysis stage, the
 * follow-up stage, the session routes, `src/sessions/reopen.ts`, the state
 * machine and `./retention.ts`. A suite constructs one against a store opened
 * with `openStore`, so it exercises the real DDL, pragmas and constraints.
 *
 * The repository holds no state beyond its dependencies: statements live in the
 * store's cache, and every method is a pure function of the database's contents.
 *
 * @param deps The store, and optionally a logger and a clock.
 * @returns The repository.
 *
 * @example The follow-up ladder, answered from existing evidence
 * ```ts
 * const panels = createPanelsRepo({ store, logger });
 *
 * const previous = panels.getLatestPanel(sessionId);
 * const version = panels.nextPanelVersion(sessionId);
 * if (previous.ok && previous.value !== undefined && version.ok) {
 *   const stored = panels.insertPanel(
 *     { ...regenerated, panelVersion: version.value, supersedes: previous.value.id },
 *     { captureId },
 *   );
 *   // stored.ok === false with details.reason 'version-taken' means another
 *   // writer took the version first: re-read and retry, never overwrite.
 * }
 * ```
 */
export function createPanelsRepo(deps: PanelsRepoDeps): PanelsRepo {
  const { store } = deps;
  const now = deps.now ?? nowEpochMs;
  const logger = (deps.logger ?? noopLogger).child({
    [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM,
    [REPO_BINDING_KEY]: REPO,
  });

  /**
   * Logs a refusal with the error's own details — which hold ids, versions and
   * an enumerated reason only — and passes it through.
   *
   * `store-failed` is an `error`: the store itself misbehaved. Every other
   * reason is a `warn`: a handled condition a caller has a defined path for.
   */
  function refuse<T>(error: DebuggenError): Result<T> {
    const reason = error.details?.['reason'];
    const fields: LogFields = { ...error.details, code: error.code };

    if (reason === 'store-failed') {
      logger.error('a panel store operation failed', fields);
    } else {
      logger.warn('the panel store refused an operation', fields);
    }

    return err(error);
  }

  /** Runs `fn`, converting anything thrown into a `store-failed` refusal. */
  function attempt<T>(operation: string, fn: () => Result<T>, details?: LogFields): Result<T> {
    let result: Result<T>;

    try {
      result = fn();
    } catch (cause) {
      return refuse(storeFailedError(operation, cause, details));
    }

    return isErr(result) ? refuse(result.error) : result;
  }

  /** Reads at most one document; absence is a success. */
  function readOne<T>(
    ladder: Ladder<T>,
    operation: string,
    sql: string,
    key: string,
  ): Result<T | undefined> {
    return attempt(operation, (): Result<T | undefined> => {
      const row = store.statement(sql).get(key);

      return row === undefined ? ok(undefined) : documentFromRow(ladder, operation, row);
    });
  }

  /**
   * Reads every document a statement returns. One unreadable row fails the
   * whole read: a history with a silent gap would misreport which answer is
   * the latest.
   */
  function readAll<T>(ladder: Ladder<T>, operation: string, sql: string, key: string): Result<T[]> {
    return attempt(operation, (): Result<T[]> => {
      const documents: T[] = [];

      for (const row of store.statement(sql).all(key)) {
        const document = documentFromRow(ladder, operation, row);

        if (isErr(document)) {
          return document;
        }

        documents.push(document.value);
      }

      return ok(documents);
    });
  }

  /**
   * The next version on a session's ladder: one above the highest stored
   * version, or the ladder's first version when the session holds none.
   */
  function nextVersion<T>(
    ladder: Ladder<T>,
    operation: string,
    sessionId: SessionId,
  ): Result<number> {
    return attempt(
      operation,
      (): Result<number> => {
        const row = store.statement(ladder.sql.selectMaxVersion).get(sessionId);
        const latest = toColumnNumber(row?.['latest'] ?? null);

        if (latest === null) {
          return ok(ladder.firstVersion);
        }

        if (
          typeof latest !== 'number' ||
          !Number.isSafeInteger(latest) ||
          latest < ladder.firstVersion
        ) {
          const reason: PanelsRepoFailureReason = 'corrupt-row';

          return err(
            new DebuggenError(
              'STORE_ERROR',
              `A stored ${ladder.noun} carries a version that is not a positive integer.`,
              {
                hint: `The ${ladder.noun} history of this session was written by a different build of Debug Generator or edited outside it. Report the session id with the service log.`,
                details: context(operation, {
                  [LOG_BINDING_KEYS.sessionId]: sessionId,
                  reason,
                  corruption: 'projection-mismatch' satisfies PanelsRepoCorruption,
                }),
              },
            ),
          );
        }

        return ok(latest + 1);
      },
      { [LOG_BINDING_KEYS.sessionId]: sessionId },
    );
  }

  /** Reads the `created_at` value for a write, or refuses a bad reading. */
  function readClock(operation: string, details: LogFields): Result<number> {
    const reading = now();

    if (typeof reading !== 'number' || !Number.isFinite(reading)) {
      return err(
        refusalError(
          'STORE_ERROR',
          operation,
          'invalid-clock',
          'The clock returned a value that is not a finite number, so no creation time could be stored.',
          'This is a defect in how the repository was constructed: the injected clock must return epoch milliseconds. Nothing was written.',
          details,
        ),
      );
    }

    return ok(Math.round(reading));
  }

  /**
   * The checks that need the stored rows, run inside the insert's transaction
   * so they and the write see one state: the session exists, the capture (when
   * there is one) exists and belongs to it, and a stored predecessor belongs to
   * it and sits lower on the ladder.
   */
  function checkAgainstStore(
    labels: LadderLabels,
    selectLineage: string,
    operation: string,
    identity: DocumentIdentity,
    captureId: string | undefined,
  ): DebuggenError | undefined {
    const details = identityDetails(labels, identity);

    if (store.statement(SELECT_SESSION_EXISTS_SQL).get(identity.sessionId) === undefined) {
      return refusalError(
        'STORE_ERROR',
        operation,
        'unknown-session',
        `A ${labels.noun} names a session the store does not hold.`,
        `The session must be stored before its ${labels.noun}, and a purged session takes its ${labels.noun} history with it. Nothing was written.`,
        details,
      );
    }

    if (captureId !== undefined) {
      const owner = store.statement(SELECT_CAPTURE_OWNER_SQL).get(captureId);

      if (owner === undefined) {
        return refusalError(
          'STORE_ERROR',
          operation,
          'unknown-capture',
          `A ${labels.noun} names a capture the store does not hold.`,
          `Store the capture before the ${labels.noun} drawn from it, or store the ${labels.noun} without a capture when there was none. Nothing was written.`,
          { ...details, [LOG_BINDING_KEYS.captureId]: captureId },
        );
      }

      if (owner['session_id'] !== identity.sessionId) {
        return refusalError(
          'STORE_ERROR',
          operation,
          'capture-session-mismatch',
          `A ${labels.noun} names a capture that belongs to a different session.`,
          `A ${labels.noun} may only be drawn from its own session's captures. Nothing was written.`,
          { ...details, [LOG_BINDING_KEYS.captureId]: captureId },
        );
      }
    }

    if (identity.supersedes !== undefined) {
      const lineage = store.statement(selectLineage).get(identity.supersedes);

      // An absent predecessor is history rather than corruption: `supersedes`
      // is deliberately not a foreign key, so the panel or analysis it names
      // may have been purged on its own.
      if (lineage !== undefined) {
        const predecessor = { ...details, supersedes: identity.supersedes };

        if (lineage['session_id'] !== identity.sessionId) {
          return refusalError(
            'STORE_ERROR',
            operation,
            'supersedes-other-session',
            `A ${labels.noun} supersedes a ${labels.noun} of a different session.`,
            `A follow-up supersedes the previous ${labels.noun} of its own session. Nothing was written.`,
            predecessor,
          );
        }

        const version = toColumnNumber(lineage['version']);

        if (typeof version !== 'number' || version >= identity.version) {
          return refusalError(
            'STORE_ERROR',
            operation,
            'supersedes-not-earlier',
            `A ${labels.noun} supersedes a ${labels.noun} that is not an earlier version.`,
            `A new version supersedes an earlier one. Take the version from ${labels.nextVersionMethod} and supersede the latest stored ${labels.noun}. Nothing was written.`,
            predecessor,
          );
        }
      }
    }

    return undefined;
  }

  /**
   * The shared insert: validate, serialize, re-read the serialization, check
   * the document, check against the store, write — or refuse at the first step
   * that fails, having written nothing.
   *
   * @param ladder The ladder to write to.
   * @param operation The repository method.
   * @param candidate The value offered for storage.
   * @param documentCheck Rules of the document alone, run before the store is
   * touched.
   * @param captureFor The capture to associate with the validated document.
   */
  function insertDocument<T>(
    ladder: Ladder<T>,
    operation: string,
    candidate: unknown,
    documentCheck: (identity: DocumentIdentity) => DebuggenError | undefined,
    captureFor: (document: T) => string | undefined,
  ): Result<T> {
    return attempt(operation, (): Result<T> => {
      const validated = ladder.parse(candidate);

      if (isErr(validated)) {
        return err(invalidDocumentError(ladder, operation, candidate, validated.error));
      }

      // The bytes written are the validated value's serialization, and what is
      // returned is those bytes parsed again — so the caller holds exactly what
      // every later read returns, and a value that would not survive the round
      // trip is refused here rather than discovered on the next read.
      const serialized = JSON.stringify(validated.value);
      const reread = ladder.parse(JSON.parse(serialized) as unknown);

      if (isErr(reread)) {
        return err(invalidDocumentError(ladder, operation, candidate, reread.error));
      }

      const document = reread.value;
      const identity = ladder.identify(document);
      const details = identityDetails(ladder, identity);
      const documentFault = documentCheck(identity);

      if (documentFault !== undefined) {
        return err(documentFault);
      }

      const storedAt = readClock(operation, details);

      if (isErr(storedAt)) {
        return storedAt;
      }

      const captureId = captureFor(document);

      try {
        const fault = store.transaction((): DebuggenError | undefined => {
          const refused = checkAgainstStore(
            ladder,
            ladder.sql.selectLineage,
            operation,
            identity,
            captureId,
          );

          if (refused !== undefined) {
            return refused;
          }

          store
            .statement(ladder.insertSql)
            .run(
              ...ladder.insertValues({ identity, captureId, serialized, storedAt: storedAt.value }),
            );

          return undefined;
        });

        if (fault !== undefined) {
          return err(fault);
        }
      } catch (cause) {
        return err(insertFailureError(ladder, operation, identity, cause));
      }

      logger.info(`${ladder.noun} stored`, {
        ...details,
        ...(identity.supersedes === undefined ? {} : { supersedes: identity.supersedes }),
        ...(captureId === undefined ? {} : { [LOG_BINDING_KEYS.captureId]: captureId }),
        ...ladder.describe(document),
      });

      return ok(document);
    });
  }

  /** Counts one session's rows in a table. */
  function countRows(sql: string, sessionId: SessionId): number {
    const total = toColumnNumber(store.statement(sql).get(sessionId)?.['total']);

    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
      throw new DebuggenError(
        'STORE_ERROR',
        'A row count came back as something other than a count.',
        {
          details: context('countBySession', { [LOG_BINDING_KEYS.sessionId]: sessionId }),
        },
      );
    }

    return total;
  }

  return {
    insertPanel(spec, options) {
      return insertDocument(
        PANEL_LADDER,
        'insertPanel',
        spec,
        (identity) => {
          if (identity.supersedes === undefined) {
            return undefined;
          }

          const details = {
            ...identityDetails(PANEL_LADDER, identity),
            supersedes: identity.supersedes,
          };

          if (identity.supersedes === identity.id) {
            return refusalError(
              'PANEL_INVALID',
              'insertPanel',
              'supersedes-self',
              'A panel names itself as the panel it supersedes.',
              'A regenerated panel supersedes the previous panel of its session, never itself. Nothing was written.',
              details,
            );
          }

          if (identity.version <= FIRST_PANEL_VERSION) {
            return refusalError(
              'PANEL_INVALID',
              'insertPanel',
              'supersedes-on-first-version',
              'A panel at its session\u2019s first version names a panel it supersedes.',
              'Only a regenerated panel, at a version above the first, supersedes another. Take the version from nextPanelVersion. Nothing was written.',
              details,
            );
          }

          return undefined;
        },
        () => options?.captureId,
      );
    },

    getPanel(panelId) {
      return readOne(PANEL_LADDER, 'getPanel', SELECT_PANEL_BY_ID_SQL, panelId);
    },

    getLatestPanel(sessionId) {
      return readOne(PANEL_LADDER, 'getLatestPanel', SELECT_LATEST_PANEL_SQL, sessionId);
    },

    listPanels(sessionId) {
      return readAll(PANEL_LADDER, 'listPanels', SELECT_PANELS_BY_SESSION_SQL, sessionId);
    },

    nextPanelVersion(sessionId) {
      return nextVersion(PANEL_LADDER, 'nextPanelVersion', sessionId);
    },

    listSupersededBy(panelId) {
      return readAll(PANEL_LADDER, 'listSupersededBy', SELECT_PANELS_SUPERSEDING_SQL, panelId);
    },

    insertAnalysis(result) {
      return insertDocument(
        ANALYSIS_LADDER,
        'insertAnalysis',
        result,
        // `parseAnalysisResult` already refuses an analysis that supersedes
        // itself, and the analysis schema deliberately leaves the first-version
        // rule to the caller, so the document needs no further rule here.
        () => undefined,
        (stored) => stored.captureId,
      );
    },

    getAnalysis(analysisId) {
      return readOne(ANALYSIS_LADDER, 'getAnalysis', SELECT_ANALYSIS_BY_ID_SQL, analysisId);
    },

    getLatestAnalysis(sessionId) {
      return readOne(ANALYSIS_LADDER, 'getLatestAnalysis', SELECT_LATEST_ANALYSIS_SQL, sessionId);
    },

    listAnalyses(sessionId) {
      return readAll(ANALYSIS_LADDER, 'listAnalyses', SELECT_ANALYSES_BY_SESSION_SQL, sessionId);
    },

    nextAnalysisVersion(sessionId) {
      return nextVersion(ANALYSIS_LADDER, 'nextAnalysisVersion', sessionId);
    },

    countBySession(sessionId) {
      return attempt(
        'countBySession',
        (): Result<SessionDocumentCounts> =>
          ok({
            panels: countRows(COUNT_PANELS_BY_SESSION_SQL, sessionId),
            analyses: countRows(COUNT_ANALYSES_BY_SESSION_SQL, sessionId),
          }),
        { [LOG_BINDING_KEYS.sessionId]: sessionId },
      );
    },

    deleteBySession(sessionId) {
      return attempt(
        'deleteBySession',
        (): Result<SessionDocumentCounts> => {
          const deleted = store.transaction((): SessionDocumentCounts => ({
            panels: changesOf(store.statement(DELETE_PANELS_BY_SESSION_SQL).run(sessionId)),
            analyses: changesOf(store.statement(DELETE_ANALYSES_BY_SESSION_SQL).run(sessionId)),
          }));

          logger.info('session panels and analyses deleted', {
            [LOG_BINDING_KEYS.sessionId]: sessionId,
            panels: deleted.panels,
            analyses: deleted.analyses,
          });

          return ok(deleted);
        },
        { [LOG_BINDING_KEYS.sessionId]: sessionId },
      );
    },
  };
}
