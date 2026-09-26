-- =============================================================================
-- Debug Generator - session store data definition (apps/local-service)
-- =============================================================================
--
-- ROLE
--   The complete schema of the session database owned by the local coordination
--   service. It lives at "$DEBUGGEN_HOME/sessions.sqlite" (DEBUGGEN_HOME
--   defaults to ~/.debuggen), deliberately outside the project directory being
--   debugged, together with the file backups and the code-index cache, so
--   running a debugging session never changes what that project reports as
--   modified in version control.
--
--   This file is data, not code. It is executed verbatim by the built-in
--   node:sqlite binding through "DatabaseSync.exec()", so it must stay a plain
--   sequence of complete, semicolon-terminated statements: no client directives
--   (no dot-commands), no parameter placeholders, and no transaction control -
--   the caller owns the transaction.
--
--   Comments here use only the "--" line form and contain no apostrophe and no
--   quoted text, so the only single-quoted literals in this file are the two
--   CHECK vocabularies below. Text tooling that reads this DDL - the drift
--   tests that compare a CHECK list against its TypeScript tuple, and the
--   repository guard scripts - can therefore extract those literals without
--   ambiguity.
--
-- MIGRATION CONTRACT
--   This DDL is schema version 1 of the store ladder. ./migrations.ts applies
--   it as the single step of that version inside one transaction and then
--   stamps "PRAGMA user_version", which is the authority on the version of an
--   existing database.
--
--   Once released this file is never edited in place. Every later schema change
--   is an additive ladder step in ./migrations.ts - CREATE TABLE IF NOT EXISTS,
--   CREATE INDEX IF NOT EXISTS, ALTER TABLE ... ADD COLUMN - and never a
--   rewrite of, or a drop of, an object declared below. That policy is a safety
--   requirement rather than a style preference: the modifications journal is
--   the only record able to restore the files this tool patches, so an existing
--   database must always be able to migrate forward without losing it.
--
--   Comment-only and whitespace edits are tolerated. migrations.ts records
--   sha256 of this text as the ddl_sha256 row of the meta table for
--   diagnostics and logs a mismatch at warn level on a later start; it is never
--   treated as an error.
--
-- LOADER CONTRACT
--   ./db.ts resolves this DDL from exactly one of three sources, first hit wins:
--     1. an inline string handed in by the caller - the packaged editor
--        extension inlines this file at build time so the installable bundle is
--        self-contained and performs no filesystem read at all;
--     2. ./schema.sql relative to src/store/db.ts - the development path, where
--        the service runs from TypeScript sources under tsx;
--     3. ./store/schema.sql relative to the bundled dist/main.js - the build
--        copies this file to dist/store/schema.sql and fails if it is missing.
--   All three routes require the DDL to remain a standalone .sql file at this
--   exact path; it must never be folded into a TypeScript template literal.
--
-- CONVENTIONS
--   Identifiers   snake_case for every table, column and index. Indexes are
--                 named idx_<table>_<columns> so a future ladder step can
--                 reference one unambiguously.
--   Strictness    every table is declared STRICT, which turns column affinity
--                 into real type enforcement: a wrong-typed bind is rejected at
--                 the write instead of being silently coerced. Only TEXT,
--                 INTEGER and REAL appear; there are no BLOB and no ANY columns.
--   Idempotence   every statement is IF NOT EXISTS, so re-executing this DDL
--                 against an already-migrated database is a no-op. That is what
--                 lets migrations.ts adopt a database created by an earlier
--                 build without re-creating anything.
--   Documents     structured records are stored as JSON text. Where a table has
--                 both a JSON document and flat columns, the document is
--                 authoritative and the flat columns are denormalized
--                 projections maintained on every write, so list, filter, sort
--                 and retention queries never have to parse JSON.
--   Time          every timestamp is Unix epoch milliseconds. Record-level
--                 timestamps are INTEGER. The two telemetry timing columns
--                 (start_time and duration on telemetry_events) are REAL
--                 because the capture model requires sub-millisecond doubles:
--                 the browser producer computes performance.timeOrigin plus an
--                 entry start offset, and the server producer converts
--                 OpenTelemetry hrTime. A correlated cross-tier timeline is
--                 only correct if that precision round-trips unrounded.
--   Row ids       primary keys are TEXT and carry the prefixes minted by
--                 @debuggen/shared: ses_ for a session, cap_ for a capture,
--                 pnl_ for a panel, ana_ for an analysis, mod_ for a
--                 modification record and evt_ for a telemetry event. Three
--                 tables key on values that are not minted here: bindings on an
--                 integer browser tab id, and credentials and pairing_codes on
--                 a hash.
--   Integrity     the ON DELETE CASCADE and ON DELETE SET NULL edges below take
--                 effect only because ./db.ts sets PRAGMA foreign_keys = ON on
--                 every connection it opens. Foreign-key enforcement is a
--                 per-connection setting in SQLite and is off by default, so it
--                 cannot be declared from this file.
--   Vocabularies  a status or kind vocabulary shared with a TypeScript package
--                 is defined exactly once, in that package, and is enforced by
--                 parsing before the write - there is no second definition
--                 here. Only two vocabularies are additionally pinned as CHECK
--                 lists, because they also guard rows written on recovery paths
--                 that do not go through a parse: the status column of
--                 modifications and the tier column of telemetry_events.
--                 Colocated repository tests assert each CHECK list equals its
--                 TypeScript tuple, element for element and in the same order,
--                 so a drift fails the suite.
--   Privacy       authentication material is never stored as a value:
--                 credentials and pairing codes are persisted only as hashes
--                 minted at runtime, so a stolen database file yields nothing
--                 a client could present. Exactly one runtime secret is
--                 stored as a value - the random per-session keyed-hash key -
--                 and it is isolated in its own table for precisely that
--                 reason (see session_keys): it must never be serialized into
--                 the record column of sessions, logged, returned by any
--                 route or message, or included in a payload sent to a model
--                 provider. Telemetry rows are redacted before they are
--                 handed to the store, and the DDL text itself holds no
--                 secret literal, which is what the repository secret scan
--                 verifies.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- meta - migration bookkeeping. Owner: ./migrations.ts
--
-- PRAGMA user_version is the authority on the schema version; this table is the
-- human-readable mirror a developer can inspect with any SQLite client. Rows
-- written by the ladder: schema_version (the stamped version as text),
-- ddl_sha256 (diagnostic fingerprint of this file), created_at (written once)
-- and updated_at (refreshed on every applied step). Writes use
-- INSERT ... ON CONFLICT(key) DO UPDATE, so they are idempotent.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- -----------------------------------------------------------------------------
-- sessions - one row per debugging session. Owner: ./sessions-repo.ts
--
-- The record column holds the authoritative SessionRecord JSON document defined
-- by @debuggen/protocol (question, target, understanding, relevant files, plan
-- versions, modifications, captures, panel ids, analyses, cleanup state, prompt
-- versions, provider). The remaining columns are denormalized projections kept
-- in sync on every write so the session list endpoint and the retention sweep
-- can filter and sort without parsing JSON.
--
-- There is deliberately no CHECK on status: the eleven-member status vocabulary
-- lives once in the SESSION_STATUSES tuple of the protocol package and is
-- enforced by parsing the record before every write; restating it here would
-- create a second definition of a shared vocabulary that could drift.
-- dev_server_url is nullable because a session can be created before the
-- development server of the target project has been detected or launched.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  project_root   TEXT    NOT NULL,
  project_name   TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  question       TEXT    NOT NULL,
  dev_server_url TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  record         TEXT    NOT NULL
) STRICT;

-- Sessions are looked up per project, filtered by status, and swept by age.
CREATE INDEX IF NOT EXISTS idx_sessions_project_root ON sessions (project_root);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at);

-- -----------------------------------------------------------------------------
-- session_progress - the append-only pipeline progress log.
-- Owner: ./sessions-repo.ts
--
-- One row per stage transition broadcast to the connected clients. The
-- autoincrement id is the append order the editor progress view replays when a
-- session is reopened, which is why it must not be reused after a purge. The
-- detail column is an optional JSON fragment carrying structured stage detail.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_progress (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  stage      TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  detail     TEXT,
  ts         INTEGER NOT NULL
) STRICT;

-- Replay reads the rows of one session in append order.
CREATE INDEX IF NOT EXISTS idx_session_progress_session_id_id
  ON session_progress (session_id, id);

-- -----------------------------------------------------------------------------
-- plans - the instrumentation plan ladder of a session.
-- Owner: ./sessions-repo.ts
--
-- The plan column is a normalized InstrumentationPlan JSON document. The
-- composite primary key makes the follow-up ladder a database invariant: a
-- follow-up that needs more signal stores plan version n+1, which is the
-- previous plan plus additive actions, and can never overwrite version n.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  session_id   TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  plan         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, plan_version)
) STRICT;

-- -----------------------------------------------------------------------------
-- modifications - the reversibility journal. Owner: ./modifications-repo.ts
--
-- This is the most safety-critical table in the store: it is the only record
-- that can restore a patched file to the bytes it had beforehand, and it is
-- read on every service start to reconcile whatever the previous run left
-- behind - regardless of the status of the owning session.
--
-- Both hashes are written BEFORE the file on disk is touched, which is what
-- makes reconciliation decidable after a crash at any point: a file whose
-- current hash equals original_hash was never written and the record is closed;
-- one that equals instrumented_hash is restored from the backup; one that
-- matches neither was edited by the developer and becomes a conflict whose file
-- is left untouched and whose backup is retained.
--
--   file                project-relative POSIX path of the patched file.
--   original_hash       hash of the file bytes before the patch.
--   instrumented_hash   hash of the patched bytes, known before the write.
--   backup_path         absolute path of the byte-for-byte copy of the
--                       original, taken under the backups directory of
--                       $DEBUGGEN_HOME, one subdirectory per session and one
--                       file per original hash. Deliberately unconstrained
--                       text: that layout is owned by the backup store, and an
--                       old record must stay restorable even if the layout
--                       changes.
--   applied_at          when the record was journalled.
--   updated_at          when its status last changed, so status transitions can
--                       be audited after the fact.
--   previous_record_id  the earlier record for the same file when a later plan
--                       version patches an already-patched file. Records form a
--                       chain in which original_hash repeats the preceding
--                       instrumented_hash; cleanup restores a chain strictly in
--                       reverse order. The edge is SET NULL rather than CASCADE
--                       so purging an ancestor can never delete a live record
--                       that still describes a file needing restoration.
--
-- The status CHECK list is one of only two vocabularies restated in SQL, and it
-- must equal the MODIFICATION_STATUSES tuple of @debuggen/instrumentation in
-- this exact order; modifications-repo.test.ts asserts that the two lists
-- match, so this CHECK is the single place in SQL to update if that vocabulary
-- ever changes.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS modifications (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  plan_version       INTEGER NOT NULL,
  file               TEXT    NOT NULL,
  original_hash      TEXT    NOT NULL,
  backup_path        TEXT    NOT NULL,
  instrumented_hash  TEXT    NOT NULL,
  applied_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  status             TEXT    NOT NULL
    CHECK (status IN ('pending', 'applied', 'reverted', 'conflict', 'failed')),
  diff               TEXT    NOT NULL,
  previous_record_id TEXT REFERENCES modifications (id) ON DELETE SET NULL
) STRICT;

-- Per-session status views drive the editor modification list. The bare status
-- index serves the start-up reconciliation scan, which selects every record in
-- a non-terminal status across all sessions; the file index answers whether a
-- path is already instrumented for the conflict watcher; the chain index walks
-- the record chain of one file in reverse.
CREATE INDEX IF NOT EXISTS idx_modifications_session_id_status
  ON modifications (session_id, status);
CREATE INDEX IF NOT EXISTS idx_modifications_status ON modifications (status);
CREATE INDEX IF NOT EXISTS idx_modifications_session_id_file
  ON modifications (session_id, file);
CREATE INDEX IF NOT EXISTS idx_modifications_previous_record_id
  ON modifications (previous_record_id);

-- Schema version 2, applied by ./migrations.ts rather than declared here, adds
-- the single-child invariant of a chain: the chain_fork flag column and the
-- partial unique index idx_modifications_previous_record_id_unique over
-- previous_record_id, so no record carries two live layers at once. A reverted
-- layer is excluded, which is what lets a follow-up be layered again on a
-- parent whose earlier delta was rolled back. Forks written before that step
-- are flagged rather than rewritten, and cleanup reports their files as
-- conflicts instead of restoring either branch.

-- -----------------------------------------------------------------------------
-- captures - one row per runtime capture window. Owner: ./sessions-repo.ts
--
-- A capture is opened when the developer arms the session and closed when they
-- stop it; every telemetry row is attributed to exactly one capture. A row
-- whose stopped_at is NULL is the active capture of that session, of which
-- there is at most one at a time - an invariant owned by the session manager
-- rather than by a unique constraint, so a capture orphaned by a crash can be
-- reconciled and closed on the next start instead of blocking the next capture
-- with a constraint failure. plan_version records which plan version was
-- installed while the window was open, and summary receives the CaptureSummary
-- JSON document when the window closes; it stays NULL while the capture runs.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS captures (
  id           TEXT PRIMARY KEY,
  session_id   TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  stopped_at   INTEGER,
  summary      TEXT
) STRICT;

-- The captures of a session are listed newest-last by start time; the partial
-- index resolves the active capture of a session without scanning history.
CREATE INDEX IF NOT EXISTS idx_captures_session_id_started_at
  ON captures (session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_captures_session_id_active
  ON captures (session_id) WHERE stopped_at IS NULL;

-- -----------------------------------------------------------------------------
-- telemetry_events - every captured span, from every tier.
-- Owner: ./telemetry-repo.ts
--
--   ingest_seq   the store-assigned monotonic integer and the final,
--                always-distinct tie-breaker of the canonical ordering
--                (start_time, then producer_id and seq, then ingest_seq).
--                AUTOINCREMENT rather than a bare rowid alias is required so a
--                value is never reused after a retention purge, which is what
--                keeps that ordering sound across the lifetime of a database.
--                It is also why this table must keep its rowid: it is
--                deliberately not WITHOUT ROWID.
--   id           the producer-minted event id. UNIQUE so replaying a batch is
--                idempotent: a producer buffers events while its transport is
--                down and re-sends them after reconnecting, and the insert path
--                relies on this conflict target to skip rows already stored
--                without renumbering them.
--   session_id   attribution assigned at ingest. A row is never stored without
--   capture_id   both, so telemetry cannot outlive the window it belongs to;
--                either cascade removes it.
--   trace_id     W3C trace context identifiers. One interaction resolves to one
--   span_id      ordered tree across the browser, server and database tiers by
--   parent_span_id  joining on trace_id and parent_span_id; a root has none.
--   kind         the span kind. Deliberately no CHECK: the seventeen-member
--                kind vocabulary lives once in the TELEMETRY_KINDS tuple of the
--                telemetry package and is enforced by parsing.
--   tier         one of the three producer tiers. This CHECK list is the second
--                and last vocabulary restated in SQL and must equal the
--                TELEMETRY_TIERS tuple; telemetry-repo.test.ts asserts it.
--   start_time   epoch milliseconds, and duration in milliseconds, both REAL to
--   duration     preserve the sub-millisecond doubles the producers emit.
--   producer_id  identifies the emitting page document or server process, and
--   seq          is the monotonic counter of that producer within a capture;
--                together they order the events of one producer deterministically
--                even when two producers report the same start_time.
--   request_key  the keyed hash of the method, path and sorted query pairs of a
--                request, computed at ingest from the unredacted URL and copied
--                out of the event attributes so that duplicate-request grouping
--                is an indexed query. It is an opaque digest, never a URL, and
--                is NULL for events that are not requests.
--   event        the full TelemetryEvent JSON document (attributes, status and
--                the optional source location) and the authoritative copy of
--                the row; the flat columns exist for filtering and ordering.
--
-- Schema version 5, applied by ./migrations.ts rather than declared here, adds
-- the nullable clock_offset_ms INTEGER column: the informational clock offset
-- the producer of the event reported when it created it, in whole milliseconds,
-- server clock minus producer clock, bounded by a CHECK built from
-- CLOCK_OFFSET_BOUND_MS of the telemetry package. It projects the optional
-- clockOffsetMs field of the event document, is NULL for rows written before
-- that step and for events created before the first usable sample of their
-- producer, and is never added to start_time or duration. It carries no index:
-- the per-producer read is a rare diagnostic scoped to one session.
--
-- Only already-redacted events ever reach this table: redaction and the
-- request-key computation both happen in the ingest path before insertion, so
-- no header value, query-parameter value, request body, database row content or
-- inline SQL literal is ever written here.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_events (
  ingest_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT    NOT NULL UNIQUE,
  session_id     TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  capture_id     TEXT    NOT NULL REFERENCES captures (id) ON DELETE CASCADE,
  trace_id       TEXT    NOT NULL,
  span_id        TEXT    NOT NULL,
  parent_span_id TEXT,
  kind           TEXT    NOT NULL,
  tier           TEXT    NOT NULL CHECK (tier IN ('browser', 'server', 'db')),
  name           TEXT    NOT NULL,
  start_time     REAL    NOT NULL,
  duration       REAL    NOT NULL,
  producer_id    TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  request_key    TEXT,
  event          TEXT    NOT NULL
) STRICT;

-- The first two indexes are the ones the panel data layer depends on: the
-- default page of one capture in canonical start order, and the spans of one
-- trace in start order for the correlated tree. The rest serve kind-filtered
-- counts, parent and child span lookups while correlating, duplicate-request
-- counts and grouping by keyed hash, and the per-producer ordering probe.
--
-- The trace, span and parent span indexes serve their lookups with session_id
-- applied as a residual filter on the rows they return: those ids are
-- selective across the whole table, so ./telemetry-repo.ts writes the session
-- term of such a read in the form the planner cannot use to choose a
-- session-leading index, which would walk every row of the session instead.
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_id_capture_id_start_time
  ON telemetry_events (session_id, capture_id, start_time);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_trace_id_start_time
  ON telemetry_events (trace_id, start_time);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_id_kind
  ON telemetry_events (session_id, kind);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_span_id
  ON telemetry_events (span_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_parent_span_id
  ON telemetry_events (parent_span_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_id_request_key
  ON telemetry_events (session_id, request_key);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_id_producer_id_seq
  ON telemetry_events (session_id, producer_id, seq);

-- Schema version 2, applied by ./migrations.ts, adds the two retention purge
-- indexes idx_telemetry_events_start_time_ingest_seq and
-- idx_telemetry_events_session_id_start_time_ingest_seq, so every bounded purge
-- batch is an ordered index range read rather than a full scan and a sort.
--
-- Schema version 3, applied by ./migrations.ts, adds the two ordered lookup
-- indexes idx_telemetry_events_session_id_kind_start_time_id and
-- idx_telemetry_events_session_id_request_key_start_time_producer_id_seq, so a
-- page of one kind in the panel order and the occurrences of one request group
-- in the canonical order are each an ordered index range read rather than a
-- scan of the whole session and a sort.

-- -----------------------------------------------------------------------------
-- panels - the generated debugging panels of a session. Owner: ./panels-repo.ts
--
-- The spec column is a validated PanelSpec JSON document, including the marker
-- that flags a deterministically assembled fallback panel so the renderer can
-- show its banner. The UNIQUE (session_id, panel_version) constraint makes the
-- version ladder a database invariant, exactly as it does for plans.
--
-- The supersedes column carries the id of the previous panel on the follow-up
-- regeneration path and is intentionally NOT a foreign key, so a superseded
-- panel can be purged independently without either cascading into its successor
-- or forcing the pointer of that successor to NULL. capture_id is SET NULL on
-- purge because a panel stays readable as a record of what was concluded even
-- after the rows of the underlying capture have aged out.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS panels (
  id            TEXT PRIMARY KEY,
  session_id    TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  panel_version INTEGER NOT NULL,
  supersedes    TEXT,
  capture_id    TEXT REFERENCES captures (id) ON DELETE SET NULL,
  spec          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (session_id, panel_version)
) STRICT;

-- The panel history of a session, newest last.
CREATE INDEX IF NOT EXISTS idx_panels_session_id_created_at
  ON panels (session_id, created_at);

-- -----------------------------------------------------------------------------
-- analyses - the validated analysis behind each panel. Owner: ./panels-repo.ts
--
-- The column is named version and maps to the analysis version field of the
-- analysis result; a follow-up answered from existing evidence stores version
-- n+1 beside the panel of the same generation, which the UNIQUE constraint
-- enforces. The result column is the full AnalysisResult JSON document, whose
-- observed facts each carry evidence references into telemetry_events - the
-- structural separation that keeps observations apart from inferred causes.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analyses (
  id         TEXT PRIMARY KEY,
  session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  capture_id TEXT REFERENCES captures (id) ON DELETE SET NULL,
  version    INTEGER NOT NULL,
  result     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, version)
) STRICT;

-- The analysis history of a session, newest last.
CREATE INDEX IF NOT EXISTS idx_analyses_session_id_created_at
  ON analyses (session_id, created_at);

-- -----------------------------------------------------------------------------
-- followups - the follow-up questions asked within a session.
-- Owner: ./sessions-repo.ts
--
-- Same pattern as sessions: the record column holds the authoritative
-- FollowUpRecord JSON document (the decision, whether a new capture was needed
-- and which additional actions it added) and the flat columns are projections
-- for ordering and display. The autoincrement id is the order in which the
-- questions were asked.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS followups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  question   TEXT    NOT NULL,
  asked_at   INTEGER NOT NULL,
  record     TEXT    NOT NULL
) STRICT;

-- The follow-ups of a session in the order they were asked.
CREATE INDEX IF NOT EXISTS idx_followups_session_id_asked_at
  ON followups (session_id, asked_at);

-- -----------------------------------------------------------------------------
-- bindings - which inspected browser tab belongs to which session.
-- Owner: ./sessions-repo.ts
--
-- The primary key on tab_id encodes that one tab binds to at most one session,
-- and the unique index on session_id encodes that one session accepts one bound
-- tab at a time - a second bind replaces the first and is announced to the
-- clients. The url column is the tab URL at bind time and is the basis of the
-- origin check on every later navigation: the same origin keeps the binding and
-- re-arms the agent, a different origin drops it. tab_id is an INTEGER because
-- it is the tab identifier of the browser and is not minted by this service.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bindings (
  tab_id     INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  bound_at   INTEGER NOT NULL
) STRICT;

-- One bound tab per session, enforced rather than merely indexed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_session_id
  ON bindings (session_id);

-- -----------------------------------------------------------------------------
-- credentials - the access credentials the service has issued.
-- Read and written by src/server/auth.ts through the store handle; no repository
-- module owns this table.
--
-- Only the SHA-256 hash of a credential is ever stored, so a stolen database
-- file yields no usable credential and the service can verify a presented token
-- only by hashing it. Writing a plaintext credential into this table is
-- forbidden.
--
--   role        which kind of client the credential authenticates: the editor
--               extension, a paired browser DevTools client, or a launched
--               development-server process.
--   scope       the scope appropriate to that role, as text or a JSON array:
--               the workspace folders the editor announced, the id of the
--               paired extension, or the single project root a server-side
--               producer may ingest for. Authorization resolves from the stored
--               role and scope, never from anything a client claims about
--               itself.
--   expires_at  NULL for a credential that does not expire on its own; a
--               process-scoped credential is given the lifetime of that
--               process. Rotation deletes every row in this table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credentials (
  token_hash TEXT PRIMARY KEY,
  role       TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER
) STRICT;

-- Credentials are enumerated by role and swept by expiry.
CREATE INDEX IF NOT EXISTS idx_credentials_role ON credentials (role);
CREATE INDEX IF NOT EXISTS idx_credentials_expires_at
  ON credentials (expires_at);

-- -----------------------------------------------------------------------------
-- pairing_codes - short-lived, single-use codes for pairing a browser client.
-- Same owner as credentials: src/server/auth.ts.
--
-- A pairing code is the capability that lets the browser extension - which
-- cannot read the credential file of the editor - obtain a credential of its
-- own. Codes are stored only as hashes, are valid for five minutes, and are
-- single-use: used is 0 or 1 and is flipped inside the same transaction that
-- issues the credential, so a replayed code can never mint a second one.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Expired codes are swept in bulk.
CREATE INDEX IF NOT EXISTS idx_pairing_codes_expires_at
  ON pairing_codes (expires_at);

-- -----------------------------------------------------------------------------
-- session_keys - the per-session keyed-hash key. Owner: ./sessions-repo.ts
--
-- WARNING - this table holds a secret, and it exists precisely so that the
-- secret cannot leak by accident. request_key is the random per-session key
-- behind the request keyed-hash grouping: duplicate-request detection must
-- distinguish two requests that differ only in a query-parameter value while
-- still collapsing byte-identical ones, which requires hashing the unredacted
-- URL, which requires a key that never leaves this machine.
--
-- It is stored in its own table rather than inside the session record because
-- that record is serialized and broadcast to every connected client over the
-- socket and returned by the session HTTP routes. This value must therefore
-- never be written into the record column of sessions, never be logged, never
-- be returned by any route or message, and never be included in a payload sent
-- to a model provider. It is deleted with its session by the cascade below, and
-- the grouping keys of that session become unrecomputable at that moment by
-- design.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_keys (
  session_id  TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  request_key TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;
