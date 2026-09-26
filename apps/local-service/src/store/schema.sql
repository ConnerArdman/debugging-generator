-- =============================================================================
-- Debug Generator - session store schema, version 1 (apps/local-service)
-- =============================================================================
-- Stored at $DEBUGGEN_HOME/sessions.sqlite (default ~/.debuggen), outside the
-- debugged project, so its version control never sees a session.
-- DatabaseSync.exec of node:sqlite runs this file verbatim: complete,
-- semicolon-terminated statements only, with no dot-command, no placeholder
-- and no transaction control, which the caller owns.
--
-- ./migrations.ts applies it as ladder version 1 in one transaction and stamps
-- PRAGMA user_version, the version authority. Only comments may change here:
-- every later schema change is an additive step in ./migrations.ts, so the
-- modifications journal always migrates forward intact. ./db.ts loads it
-- inline in the packaged editor extension, as ./schema.sql in development and
-- as ./store/schema.sql beside dist/main.js, so it stays a standalone file.
--
-- Conventions
--   Names         snake_case; indexes are idx_<table>_<columns>.
--   Types         STRICT tables of TEXT, INTEGER and REAL only.
--   Idempotence   every statement is IF NOT EXISTS.
--   Documents     a JSON document column is authoritative; the flat columns
--                 beside it are projections kept in sync on every write, so
--                 queries never parse JSON.
--   Time          INTEGER epoch milliseconds, except the REAL start_time and
--                 duration of telemetry_events, kept sub-millisecond.
--   Row ids       TEXT with the ses_, cap_, pnl_, ana_, mod_ and evt_ prefixes
--                 of @debuggen/shared; bindings, credentials and pairing_codes
--                 key on a tab id or a hash instead.
--   Integrity     ON DELETE edges hold only because ./db.ts enables PRAGMA
--                 foreign_keys on every connection.
--   Vocabularies  parsed before a write. Only modifications.status and
--                 telemetry_events.tier also carry a CHECK list, for writes
--                 that bypass the parse; repository tests pin each list to its
--                 TypeScript tuple, in order.
--   Secrets       the session_keys key is the only secret stored as a value;
--                 credentials and pairing codes are stored as hashes.
--   Comments      the -- line form, with no apostrophe and no quoted text, so
--                 the CHECK lists hold the only single-quoted literals.
-- =============================================================================

-- meta - migration bookkeeping. Owner: ./migrations.ts
-- A readable mirror of PRAGMA user_version, which stays the authority. Keys:
-- schema_version, ddl_sha256, created_at (written once) and updated_at.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- sessions - one row per debugging session. Owner: ./sessions-repo.ts
-- record is the authoritative SessionRecord document. status has no CHECK:
-- SESSION_STATUSES of @debuggen/protocol is its only definition, enforced by
-- parsing. dev_server_url is NULL until a dev server is detected or launched.
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

-- session_progress - the append-only progress log. Owner: ./sessions-repo.ts
-- The AUTOINCREMENT id is the replay order of a reopened session and is never
-- reused after a purge. detail is an optional JSON fragment.
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

-- plans - the instrumentation plan ladder. Owner: ./sessions-repo.ts
-- plan is a normalized InstrumentationPlan document. The composite primary key
-- makes the ladder a database invariant: a follow-up stores plan version n+1
-- and can never overwrite version n.
CREATE TABLE IF NOT EXISTS plans (
  session_id   TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  plan         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, plan_version)
) STRICT;

-- modifications - the reversibility journal. Owner: ./modifications-repo.ts
-- The only record able to restore a patched file, reconciled on every service
-- start whatever the session status. Both hashes are written before the file
-- is touched, so after a crash a file at original_hash was never written, one
-- at instrumented_hash is restored from backup_path, and one matching neither
-- was edited by the developer: a conflict that leaves the file untouched and
-- keeps its backup. backup_path is unconstrained text so an old record stays
-- restorable if the backup layout changes. previous_record_id chains the
-- records of one file, each original_hash repeating the preceding
-- instrumented_hash; cleanup restores a chain strictly in reverse, and SET NULL
-- rather than CASCADE keeps a purged ancestor from deleting a live record. The
-- status CHECK list must equal MODIFICATION_STATUSES of
-- @debuggen/instrumentation, in order.
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

-- Per-session status views drive the editor modification list; the bare
-- status index serves the start-up reconciliation scan across all sessions;
-- the file index tells the conflict watcher whether a path is instrumented;
-- the chain index walks the chain of one file in reverse.
CREATE INDEX IF NOT EXISTS idx_modifications_session_id_status
  ON modifications (session_id, status);
CREATE INDEX IF NOT EXISTS idx_modifications_status ON modifications (status);
CREATE INDEX IF NOT EXISTS idx_modifications_session_id_file
  ON modifications (session_id, file);
CREATE INDEX IF NOT EXISTS idx_modifications_previous_record_id
  ON modifications (previous_record_id);

-- captures - one row per runtime capture window. Owner: ./sessions-repo.ts
-- A NULL stopped_at marks the active capture. At most one per session is an
-- invariant of the session manager, not a unique constraint, so a capture
-- orphaned by a crash is closed on the next start instead of blocking the next
-- one. summary is the CaptureSummary document, NULL while the capture runs.
CREATE TABLE IF NOT EXISTS captures (
  id           TEXT PRIMARY KEY,
  session_id   TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  stopped_at   INTEGER,
  summary      TEXT
) STRICT;

-- Captures of a session by start time; the partial index finds the active
-- capture without scanning history.
CREATE INDEX IF NOT EXISTS idx_captures_session_id_started_at
  ON captures (session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_captures_session_id_active
  ON captures (session_id) WHERE stopped_at IS NULL;

-- telemetry_events - captured spans of every tier. Owner: ./telemetry-repo.ts
-- Only redacted events are stored: redaction and the request_key computation
-- both run in the ingest path before the insert.
--   ingest_seq   AUTOINCREMENT, never reused after a purge, so it stays the
--                final tie-breaker of the canonical order (start_time,
--                producer_id and seq, then ingest_seq).
--   id           producer-minted and UNIQUE, so a replayed batch is skipped
--                rather than stored twice or renumbered.
--   session_id   assigned at ingest and never absent, so either cascade
--   capture_id   removes the row with its window.
--   kind         no CHECK: TELEMETRY_KINDS of the telemetry package is its
--                only definition, enforced by parsing.
--   tier         the CHECK list must equal TELEMETRY_TIERS, in order.
--   producer_id  the emitting page document or server process, and its
--   seq          per-capture counter: a deterministic order for one producer.
--   request_key  opaque keyed hash of method, path and sorted query pairs of
--                the unredacted URL; never a URL, NULL for a non-request.
--   event        the authoritative TelemetryEvent document.
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

-- The first two serve the panel data layer: a capture in canonical start
-- order and a trace in start order. The rest serve kind counts, span and
-- parent lookups, duplicate-request grouping and the per-producer order. Trace
-- and span ids are selective table-wide, so ./telemetry-repo.ts applies
-- session_id to those lookups as a residual filter the planner cannot use to
-- pick a session-leading index, which would walk the whole session.
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

-- panels - the generated debugging panels. Owner: ./panels-repo.ts
-- spec is the validated PanelSpec document, fallback marker included; the
-- UNIQUE constraint makes the version ladder a database invariant. supersedes,
-- the previous panel id, is deliberately not a foreign key, so a superseded
-- panel is purged without cascading into its successor or nulling its pointer.
-- capture_id is SET NULL so a panel outlives the telemetry of its capture.
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

-- analyses - the validated analysis behind each panel. Owner: ./panels-repo.ts
-- result is the AnalysisResult document, whose observed facts cite evidence in
-- telemetry_events. version is its analysis version; a follow-up stores n+1,
-- and the UNIQUE constraint keeps that ladder a database invariant.
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

-- followups - the follow-up questions of a session. Owner: ./sessions-repo.ts
-- record is the authoritative FollowUpRecord document; the AUTOINCREMENT id is
-- the order the questions were asked.
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

-- bindings - the inspected browser tab of a session. Owner: ./sessions-repo.ts
-- The tab_id key binds a tab to at most one session and the unique index on
-- session_id gives a session at most one bound tab; a second bind replaces the
-- first. url is the tab URL at bind time, against which the origin of every
-- later navigation is checked. tab_id is the browser tab id, not minted here.
CREATE TABLE IF NOT EXISTS bindings (
  tab_id     INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  bound_at   INTEGER NOT NULL
) STRICT;

-- One bound tab per session, enforced rather than merely indexed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_session_id
  ON bindings (session_id);

-- credentials - the issued access credentials. Owner: src/server/auth.ts,
-- through the store handle; no repository owns this table. Only the SHA-256
-- token_hash is stored, never a plaintext credential, so a stolen file yields
-- nothing a client could present.
--   role        vscode (editor extension), devtools (paired browser DevTools
--               client) or server-agent (launched dev-server process).
--   scope       a JSON object, one shape per role: vscode stores only a marker
--               whose kind is machine-user and which names no folder; devtools
--               the paired extension id and the SHA-256 digest of the read
--               proof issued with it at pairing, never the proof itself;
--               server-agent the one project root it may ingest for, plus, for
--               a lease the dev-server launcher renews, the process id of the
--               service holding it. Workspace folders that editor connections
--               announce are never stored: the service keeps them in memory per
--               live connection and for a bounded lease after it drops, until
--               rotation or shutdown. The stored role and scope fix what a
--               client is: its role, its extension identity, its server-agent
--               project. A client claim never widens that. The project root an
--               authenticated editor announces only narrows the projects it may
--               act on to its announced folders, and a DevTools acting tab
--               counts only when the live binding table confirms it.
--   expires_at  NULL when a credential has no expiry of its own; a launcher
--               lease always has one, renewed only while its child runs.
-- Rotation deletes every credential and pairing code in the transaction that
-- stores the new editor credential.
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

-- pairing_codes - short-lived, single-use codes for pairing a browser client.
-- Owner: src/server/auth.ts
-- Stored as hashes only and valid for five minutes. used goes from 0 to 1 in
-- the transaction that issues the devtools credential, and only for an unused,
-- unexpired code, so a replayed code can never mint a second credential.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Expired codes are swept in bulk.
CREATE INDEX IF NOT EXISTS idx_pairing_codes_expires_at
  ON pairing_codes (expires_at);

-- session_keys - the per-session keyed-hash key. Owner: ./sessions-repo.ts
-- WARNING: request_key is a secret, the random key that hashes unredacted
-- request URLs into telemetry_events.request_key. It is kept out of the
-- session record, which is broadcast to clients and returned by routes, and
-- must NEVER be serialized into sessions.record, logged, returned by any route
-- or message, or sent to a model provider. The cascade deletes it with its
-- session, after which those grouping keys cannot be recomputed, by design.
CREATE TABLE IF NOT EXISTS session_keys (
  session_id  TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  request_key TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;
