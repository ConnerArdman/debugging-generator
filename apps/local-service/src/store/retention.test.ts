/**
 * Tests for `./retention.ts`: the one module that deletes aged state from the
 * session database and from `$DEBUGGEN_HOME`.
 *
 * This suite is the proof that the sweep never destroys developer data early.
 * Everything below is judged against that promise rather than against a
 * repository's CRUD, and each block exists because breaking its rule costs a
 * developer something they cannot get back:
 *
 * 1. **Aged sessions go completely.** A session last *updated* before the window
 *    is deleted together with every row scoped to it — the suite reads each
 *    child table directly afterwards, because the guarantee is the schema's
 *    `ON DELETE CASCADE` edges firing under the `foreign_keys` pragma, and a
 *    report that merely *said* it deleted them would prove nothing.
 * 2. **A conflict is never swept.** An aged session whose journal still holds a
 *    `conflict` record keeps its rows and its backup byte for byte, and loses
 *    them only once that record is resolved to `reverted` — so the exemption is
 *    tied to the record's state, not to a permanent opt-out. Start-up
 *    reconciliation runs before this sweep, which makes `conflict` the
 *    realistic open state at sweep time; this is the suite's centre of gravity.
 * 3. **Orphans age out, references never do.** A backup no journal row names
 *    survives the grace window; one a record names survives forever.
 * 4. **Caches follow their project.** An old code-index entry whose project was
 *    opened inside the window survives; an abandoned one goes. An entry the
 *    cache can no longer reach — written under an older envelope version, or
 *    superseded by a newer entry of the same project — goes whatever its age,
 *    so each project is left with the one entry the cache reads and writes.
 * 5. **Nothing outside the state root is touched**, not through a planted link
 *    and not through a sibling that merely shares the root's name as a prefix.
 * 6. **A dry run is honest, one bad item never aborts the pass, and no report
 *    or log line carries a secret, a diff or a question.**
 * 7. **A scoped sweep stays inside its workspace.** A sweep scoped to project A
 *    — what `session.purge` runs for an editor that announced only A — removes
 *    A's aged sessions, orphan backups and caches and leaves every item of B,
 *    and every item whose project is unknown, in place and unreported; the
 *    unscoped start-up sweep over the same state stays machine-wide. The scope
 *    is awaited, outside every transaction, so a scope that resolves roots on
 *    disk keeps a link inside A that points into B; and a directory-shaped
 *    cache entry is inspected whole — one holding more documents than the
 *    sweep reads, a subdirectory, or a document it cannot attribute is kept.
 * 8. **A sweep keeps the write-ahead log bounded off the event loop.** While a
 *    real sweep deletes, the connection's commit-time checkpoint is suspended
 *    and the sweep waits for background checkpoints instead; the threshold is
 *    restored however the sweep ends, and a dry run leaves it alone.
 *
 * The store is the real one: `openStore` against a file in an `mkdtemp`
 * sandbox — never `:memory:` — so WAL and the `foreign_keys` pragma behave as
 * in production, and the four repositories are the real ones over it, each
 * with an injected clock the tests advance explicitly. Nothing reads the real
 * time for a decision: every file age is set with `utimes` relative to the same
 * fixed instant the sweep is given. Every document is built through its
 * upstream constructor or validator (`parseSessionRecord`,
 * `createModificationRecord`, `createAnalysisResult`) or is validated by the
 * repository that stores it (`parsePanelSpec` inside `insertPanel`, the
 * persisted telemetry schema inside `insertMany`), so a drifting upstream
 * schema fails here, at the fixture, loudly.
 *
 * Each test owns one sandbox root holding `$DEBUGGEN_HOME` (with
 * `sessions.sqlite`, `backups/` and `index/`) and, beside it, the directory the
 * containment tests plant link targets in — so "outside the state root" is
 * still inside the test's own disposable tree, and the `afterEach` hook proves
 * the whole root is gone. Fixture vocabulary is neutral (`project-a`, `alpha`,
 * `src/fileOne.ts`), every digest is an obviously synthetic run of `a`s, and
 * no secret-shaped literal appears anywhere: the one real secret involved, a
 * session's request-key secret, is minted at run time by the repository. No
 * environment variable is read, no socket is opened and no test depends on
 * another having run, which is the contract of the `local-service` Vitest
 * project.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CODE_INDEX_SCHEMA_VERSION,
  INDEXER_VERSION,
  INDEX_CACHE_SCHEMA_VERSION,
  createIndexCache,
} from '@debuggen/code-analysis';
import type { CodeIndex, IndexCacheKeyInput } from '@debuggen/code-analysis';
import { createModificationRecord } from '@debuggen/instrumentation';
import type {
  InstrumentationPlan,
  ModificationRecord,
  ModificationStatus,
} from '@debuggen/instrumentation';
import {
  SESSION_STATUSES,
  createAnalysisResult,
  parseAnalysisResult,
  parseSessionRecord,
} from '@debuggen/protocol';
import type { AnalysisResult, PanelSpec, SessionRecord, SessionStatus } from '@debuggen/protocol';
import {
  isErr,
  isWithin,
  newCaptureId,
  newEventId,
  newPanelId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  unwrap,
} from '@debuggen/shared';
import type { CaptureId, LogFields, LogLevel, Logger, SessionId } from '@debuggen/shared';
import { SECURE_DIR_MODE, sha256OfFileSync } from '@debuggen/shared/node';

import { canonicalizePath } from '../config.js';
import { openStore } from './db.js';
import type { Store } from './db.js';
import {
  SELECT_SESSION_BACKUP_REFERENCES_SQL,
  createModificationsRepo,
} from './modifications-repo.js';
import type { ModificationsRepo } from './modifications-repo.js';
import { createPanelsRepo } from './panels-repo.js';
import type { PanelsRepo } from './panels-repo.js';
import {
  BACKUP_PROBE_BATCH_SIZE,
  DEFAULT_RETENTION_DAYS,
  INCREMENTAL_VACUUM_STEP_PAGES,
  IN_FLIGHT_SESSION_STATUSES,
  MAX_INDEX_METADATA_FILES,
  MAX_REPORTED_ITEMS,
  ORPHAN_BACKUP_GRACE_DAYS,
  RETENTION_CANDIDATE_PAGE_SIZE,
  RETENTION_WAL_CHECKPOINT_BYTES,
  SESSION_TELEMETRY_PROBE_SQL,
  VACUUM_CONVERSION_MAX_LIVE_BYTES,
  VACUUM_CONVERSION_MIN_FREE_BYTES,
  VACUUM_CONVERSION_MIN_FREE_SHARE,
  runRetention,
} from './retention.js';
import type {
  RetentionDeps,
  RetentionIssue,
  RetentionOptions,
  RetentionReclaimTuning,
  RetentionReport,
  RetentionScope,
} from './retention.js';
import {
  SELECT_RETENTION_CANDIDATES_AFTER_SQL,
  SELECT_RETENTION_CANDIDATES_SQL,
  createSessionsRepo,
} from './sessions-repo.js';
import type { ListRetentionCandidatesOptions, SessionsRepo } from './sessions-repo.js';
import { DEFAULT_PURGE_BATCH_SIZE, createTelemetryRepo } from './telemetry-repo.js';
import type { PersistableTelemetryEvent, TelemetryRepo } from './telemetry-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Time
 * ---------------------------------------------------------------------------------------------- */

/** Milliseconds in one day: the unit both retention windows are configured in. */
const DAY_MS = 86_400_000;

/**
 * The instant every sweep runs at: 2026-01-01T00:00:00Z, a whole second so that
 * `utimes` (which takes seconds) reproduces every boundary exactly.
 */
const NOW = 1_767_225_600_000;

/** An instant `days` days before {@link NOW}. */
function daysAgo(days: number): number {
  return NOW - days * DAY_MS;
}

/** The retention cutoff the default window produces at {@link NOW}. */
const DEFAULT_CUTOFF = daysAgo(DEFAULT_RETENTION_DAYS);

/** When an aged session was last touched: a full window beyond the cutoff. */
const AGED_AT = daysAgo(DEFAULT_RETENTION_DAYS * 2);

/** When a live session was last touched: well inside the window. */
const RECENT_AT = daysAgo(1);

/** An age no window in this suite reaches: for "however old" assertions. */
const ANCIENT_AT = daysAgo(400);

/* -------------------------------------------------------------------------------------------------
 * Fixture vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** The project most sessions debug. */
const PROJECT_A = '/workspace/project-a';

/** A second project, only ever opened by aged sessions. */
const PROJECT_B = '/workspace/project-b';

/** The file most modification records patch. */
const FILE_ONE = 'src/fileOne.ts';

/** A second file, for sessions that journal two records. */
const FILE_TWO = 'src/fileTwo.ts';

/** A unified diff of the shape the patcher produces, over neutral fixture code. */
const DIFF = [
  `--- a/${FILE_ONE}`,
  `+++ b/${FILE_ONE}`,
  '@@ -1,3 +1,4 @@',
  ' export function alpha(input: number): number {',
  '+  const __dbg = globalThis.__dbgHelper;',
  '   return input * 2;',
  ' }',
  '',
].join('\n');

/**
 * The string the privacy assertions look for, planted in a diff and in a
 * question. Shaped like something that must never be logged and unlikely to
 * occur by accident, so a match is unambiguous.
 */
const SENTINEL = 'RETENTION-SENTINEL-5d0c2e9a-never-log-me';

/** A session id built from a readable label, for fixtures that need stable ids. */
function fixedSessionId(label: string): SessionId {
  return `ses_${label.padEnd(16, '0')}`;
}

/** Whether this process can make a directory unwritable to itself (not as root). */
const CAN_DENY_WRITES = typeof process.getuid === 'function' && process.getuid() !== 0;

/* -------------------------------------------------------------------------------------------------
 * A capturing logger
 * ---------------------------------------------------------------------------------------------- */

/** One call on the capturing logger. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A {@link Logger} that records every call as `{ level, message, fields }`,
 * bindings merged the way a child applies them.
 *
 * Hand-written rather than the console logger with a sink, so the privacy
 * assertions see exactly what the sweep and the repositories handed to the
 * logging interface, with no formatting layer in between that could drop or
 * rewrite a value first.
 */
function createCapturingLogger(sink: CapturedLog[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      sink.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };

  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (childBindings: LogFields): Logger =>
      createCapturingLogger(sink, { ...bindings, ...childBindings }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------------------------- */

/**
 * One test's sandbox: the state root, the real store and repositories over it,
 * the clock they read, and the directory outside the state root that the
 * containment tests plant link targets in.
 */
interface Harness {
  /** The `mkdtemp` directory that holds everything below; removed after the test. */
  readonly root: string;
  /** `$DEBUGGEN_HOME`: the containment boundary of every deletion. */
  readonly home: string;
  /** `<home>/backups`. */
  readonly backupsDir: string;
  /** `<home>/index`. */
  readonly indexCacheDir: string;
  /** `<root>/outside`: a sibling of the state root, never swept. */
  readonly outside: string;
  readonly store: Store;
  readonly sessions: SessionsRepo;
  readonly telemetry: TelemetryRepo;
  readonly modifications: ModificationsRepo;
  readonly panels: PanelsRepo;
  /** Every call the store, the repositories and the sweep made on the logger. */
  readonly logs: CapturedLog[];
  readonly logger: Logger;
  /** The producer every seeded event claims. */
  readonly producerId: string;
  /** The synthetic digest handed out for each label in this sandbox. */
  readonly digests: Map<string, string>;
  /** The epoch-millisecond reading every repository and the sweep see. */
  clock: number;
  /** The next per-producer event sequence number. */
  nextSeq: number;
  /** The next browser tab id a binding claims. */
  nextTabId: number;
}

/** Every sandbox created by the current test, disposed by `afterEach`. */
const harnesses: Harness[] = [];

/** The sandbox most tests work in, created by `beforeEach`. */
let h: Harness;

/**
 * Creates a sandbox: `mkdtemp` under the OS temporary directory, a private
 * `$DEBUGGEN_HOME` inside it holding `backups/` and `index/`, the store opened
 * on a temp **file** there, and the four repositories over it.
 *
 * The root is resolved with `realpath` so that every path the suite writes into
 * the journal is spelled exactly as the sweep's own directory walk spells it,
 * and so the store's own canonical-path check holds on hosts whose temporary
 * directory is reached through a link.
 */
function createHarness(): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-retention-')));
  const home = join(root, 'home');
  const backupsDir = join(home, 'backups');
  const indexCacheDir = join(home, 'index');
  const outside = join(root, 'outside');

  for (const directory of [home, backupsDir, indexCacheDir, outside]) {
    mkdirSync(directory, { mode: SECURE_DIR_MODE });
  }

  const logs: CapturedLog[] = [];
  const logger = createCapturingLogger(logs);
  const store = unwrap(openStore({ databasePath: join(home, 'sessions.sqlite'), logger }));
  const clock = { now: NOW };
  const now = (): number => clock.now;

  const harness: Harness = {
    root,
    home,
    backupsDir,
    indexCacheDir,
    outside,
    store,
    sessions: createSessionsRepo({ store, logger, now }),
    telemetry: createTelemetryRepo({ store, logger }),
    modifications: createModificationsRepo({ store, logger, now }),
    panels: createPanelsRepo({ store, logger, now }),
    logs,
    logger,
    producerId: newProducerId(),
    digests: new Map(),
    get clock(): number {
      return clock.now;
    },
    set clock(value: number) {
      clock.now = value;
    },
    nextSeq: 0,
    nextTabId: 1,
  };

  harnesses.push(harness);
  return harness;
}

/** Closes a sandbox's store and removes its whole tree, proving nothing survives. */
function disposeHarness(harness: Harness): void {
  if (!harness.store.isClosed) {
    harness.store.close();
  }
  rmSync(harness.root, { recursive: true, force: true });
  expect(existsSync(harness.root)).toBe(false);
}

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    disposeHarness(harness);
  }
});

/** Runs `fn` with the sandbox clock reading `at`, then puts it back at {@link NOW}. */
function withClock<T>(harness: Harness, at: number, fn: () => T): T {
  harness.clock = at;
  try {
    return fn();
  } finally {
    harness.clock = NOW;
  }
}

/**
 * {@link withClock} for asynchronous work: the clock is put back only once the
 * promise settles, so every repository call inside `fn` — including the ones
 * after its first `await` — reads `at`.
 */
async function withClockAsync<T>(harness: Harness, at: number, fn: () => Promise<T>): Promise<T> {
  harness.clock = at;
  try {
    return await fn();
  } finally {
    harness.clock = NOW;
  }
}

/** The injected configuration: the four members the sweep reads, and no environment. */
function configOf(harness: Harness): RetentionDeps['config'] {
  return {
    debuggenHome: harness.home,
    backupsDir: harness.backupsDir,
    indexCacheDir: harness.indexCacheDir,
    retentionDays: DEFAULT_RETENTION_DAYS,
  };
}

/** Everything {@link runRetention} needs, over one sandbox. */
function depsOf(harness: Harness, overrides: Partial<RetentionDeps> = {}): RetentionDeps {
  return {
    store: harness.store,
    sessions: harness.sessions,
    telemetry: harness.telemetry,
    modifications: harness.modifications,
    panels: harness.panels,
    config: configOf(harness),
    logger: harness.logger,
    now: () => harness.clock,
    ...overrides,
  };
}

/** Runs one sweep at {@link NOW} and fails the test unless it answered `Ok`. */
async function sweep(
  harness: Harness,
  options: RetentionOptions = {},
  overrides: Partial<RetentionDeps> = {},
): Promise<RetentionReport> {
  harness.clock = NOW;
  const result = await runRetention(depsOf(harness, overrides), options);
  if (isErr(result)) {
    throw new Error(
      `runRetention answered Err (${result.error.code}) where Ok was expected: ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * A report with its layout-dependent members zeroed, for equality checks: its
 * duration, and the bytes the database file shrank by — which follow the
 * store's page layout and auto-vacuum mode rather than its rows, and which a
 * dry run never reclaims — taken back out of `bytesReclaimed` too.
 */
function comparable(report: RetentionReport): RetentionReport {
  const databaseBytes = report.databaseBytesReclaimed ?? 0;
  return {
    ...report,
    durationMs: 0,
    bytesReclaimed: (report.bytesReclaimed ?? 0) - databaseBytes,
    databaseBytesReclaimed: 0,
  };
}

/** The bytes of files a sweep removed: `bytesReclaimed` without the database's share. */
function fileBytesReclaimed(report: RetentionReport): number {
  return (report.bytesReclaimed ?? 0) - (report.databaseBytesReclaimed ?? 0);
}

/* -------------------------------------------------------------------------------------------------
 * Filesystem helpers
 * ---------------------------------------------------------------------------------------------- */

/** Sets a path's access and modification times to the epoch-millisecond `at`. */
function setAge(path: string, at: number): void {
  utimesSync(path, at / 1000, at / 1000);
}

/**
 * Writes one file (creating its directory privately) and dates it `at`.
 *
 * @returns The bytes written, for byte-for-byte comparisons later.
 */
function writeDatedFile(path: string, content: string, at: number): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: SECURE_DIR_MODE });
  const bytes = Buffer.from(content, 'utf8');
  writeFileSync(path, bytes, { mode: 0o600 });
  setAge(path, at);
  return bytes;
}

/** `backups/<directory>/<name>`, written unreferenced and dated `at`: an orphan candidate. */
function writeLooseBackup(harness: Harness, directory: string, name: string, at: number): string {
  const path = join(harness.backupsDir, directory, name);
  writeDatedFile(path, `loose backup bytes of ${name}\n`, at);
  return path;
}

/**
 * `index/<name>`, a file-shaped code-index cache entry whose body is `document`
 * serialised (or `document` itself when it is already a string), dated `at`.
 */
function writeIndexEntry(harness: Harness, name: string, document: unknown, at: number): string {
  const path = join(harness.indexCacheDir, name);
  const body = typeof document === 'string' ? document : JSON.stringify(document);
  writeDatedFile(path, body, at);
  return path;
}

/**
 * A document with the envelope shape `@debuggen/code-analysis` writes: a
 * numeric top-level `schemaVersion` and an `index` recording `projectRoot`,
 * with synthetic digests in the members the sweep never reads.
 *
 * `version` defaults to the envelope version the cache reads and writes now,
 * taken from the package itself so the fixture follows a bump. `extra` adds
 * top-level members — a second `projectRoot`, for an entry recording two.
 */
function makeIndexEnvelope(
  projectRoot: string,
  version: number = INDEX_CACHE_SCHEMA_VERSION,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: version,
    key: 'a'.repeat(64),
    stateKey: 'a'.repeat(64),
    writtenAt: RECENT_AT,
    index: { projectRoot },
    stamps: [],
    ...extra,
  };
}

/** The names directly inside `index/`, sorted. */
function indexEntryNames(harness: Harness): string[] {
  return readdirSync(harness.indexCacheDir).sort();
}

/** Whether anything — a file, a directory or a link, dangling or not — sits at `path`. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every entry under the sandbox root, as sorted `kind path [size mtime]` lines,
 * read with `lstat` and never following a link.
 *
 * The database and its sidecars are left out — their bytes are what the row
 * counts measure — so two snapshots differ exactly when a file, directory or
 * link outside the store changed.
 */
function snapshotTree(harness: Harness): string[] {
  const lines: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      if (dirname(path) === harness.home && name.startsWith('sessions.sqlite')) {
        continue;
      }
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        lines.push(`link ${relative}`);
      } else if (stats.isDirectory()) {
        lines.push(`dir ${relative}`);
        walk(path, relative);
      } else {
        lines.push(`file ${relative} ${String(stats.size)} ${String(stats.mtimeMs)}`);
      }
    }
  };
  walk(harness.root, '');
  return lines;
}

/* -------------------------------------------------------------------------------------------------
 * Database helpers
 * ---------------------------------------------------------------------------------------------- */

/** Every table a session's cascade reaches, in DDL order. */
const SESSION_SCOPED_TABLES = [
  'session_progress',
  'plans',
  'modifications',
  'captures',
  'telemetry_events',
  'panels',
  'analyses',
  'followups',
  'bindings',
  'session_keys',
] as const;

type SessionScopedTable = (typeof SESSION_SCOPED_TABLES)[number];

/** One constant statement per scoped table: the store's statement cache takes constants only. */
const COUNT_BY_SESSION_SQL: Readonly<Record<SessionScopedTable, string>> = {
  session_progress: 'SELECT COUNT(*) AS n FROM session_progress WHERE session_id = ?',
  plans: 'SELECT COUNT(*) AS n FROM plans WHERE session_id = ?',
  modifications: 'SELECT COUNT(*) AS n FROM modifications WHERE session_id = ?',
  captures: 'SELECT COUNT(*) AS n FROM captures WHERE session_id = ?',
  telemetry_events: 'SELECT COUNT(*) AS n FROM telemetry_events WHERE session_id = ?',
  panels: 'SELECT COUNT(*) AS n FROM panels WHERE session_id = ?',
  analyses: 'SELECT COUNT(*) AS n FROM analyses WHERE session_id = ?',
  followups: 'SELECT COUNT(*) AS n FROM followups WHERE session_id = ?',
  bindings: 'SELECT COUNT(*) AS n FROM bindings WHERE session_id = ?',
  session_keys: 'SELECT COUNT(*) AS n FROM session_keys WHERE session_id = ?',
};

/** Whole-table counts, for the "nothing changed" snapshots. */
const COUNT_ALL_SQL: Readonly<Record<string, string>> = {
  sessions: 'SELECT COUNT(*) AS n FROM sessions',
  session_progress: 'SELECT COUNT(*) AS n FROM session_progress',
  plans: 'SELECT COUNT(*) AS n FROM plans',
  modifications: 'SELECT COUNT(*) AS n FROM modifications',
  captures: 'SELECT COUNT(*) AS n FROM captures',
  telemetry_events: 'SELECT COUNT(*) AS n FROM telemetry_events',
  panels: 'SELECT COUNT(*) AS n FROM panels',
  analyses: 'SELECT COUNT(*) AS n FROM analyses',
  followups: 'SELECT COUNT(*) AS n FROM followups',
  bindings: 'SELECT COUNT(*) AS n FROM bindings',
  session_keys: 'SELECT COUNT(*) AS n FROM session_keys',
  credentials: 'SELECT COUNT(*) AS n FROM credentials',
  pairing_codes: 'SELECT COUNT(*) AS n FROM pairing_codes',
};

/** Reads the `n` column of a `COUNT(*)` row. */
function readCount(row: Record<string, unknown> | undefined): number {
  const value = row?.['n'];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new Error('a COUNT(*) query answered no numeric n column');
}

/** How many rows of `table` belong to `sessionId`, read straight from the store. */
function rowsFor(harness: Harness, table: SessionScopedTable, sessionId: SessionId): number {
  return readCount(harness.store.statement(COUNT_BY_SESSION_SQL[table]).get(sessionId));
}

/** Every scoped table's row count for one session. */
function scopedCounts(harness: Harness, sessionId: SessionId): Record<SessionScopedTable, number> {
  const counts: Partial<Record<SessionScopedTable, number>> = {};
  for (const table of SESSION_SCOPED_TABLES) {
    counts[table] = rowsFor(harness, table, sessionId);
  }
  return counts as Record<SessionScopedTable, number>;
}

/** Every table's total row count. */
function tableTotals(harness: Harness): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [table, sql] of Object.entries(COUNT_ALL_SQL)) {
    totals[table] = readCount(harness.store.statement(sql).get());
  }
  return totals;
}

/** Whether the `sessions` table still holds a row for `sessionId`. */
function sessionExists(harness: Harness, sessionId: SessionId): boolean {
  return (
    readCount(
      harness.store.statement('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(sessionId),
    ) === 1
  );
}

/** The `updated_at` column of one session, as the sweep's candidate query reads it. */
function storedUpdatedAt(harness: Harness, sessionId: SessionId): number {
  const row = harness.store
    .statement('SELECT updated_at AS n FROM sessions WHERE id = ?')
    .get(sessionId);
  return readCount(row);
}

/* -------------------------------------------------------------------------------------------------
 * Document builders
 * ---------------------------------------------------------------------------------------------- */

/**
 * An obviously synthetic SHA-256-shaped digest for a label: 56 `a`s followed by
 * the label's ordinal in eight hex digits. The same label answers the same
 * digest for the whole sandbox, so two sandboxes seeded in the same order hand
 * out the same names — which the determinism tests rely on.
 */
function hashOf(harness: Harness, label: string): string {
  const known = harness.digests.get(label);
  if (known !== undefined) {
    return known;
  }
  const digest = `${'a'.repeat(56)}${(harness.digests.size + 1).toString(16).padStart(8, '0')}`;
  harness.digests.set(label, digest);
  return digest;
}

/** What {@link makeSession} may override. */
interface SessionOverrides {
  readonly id?: SessionId;
  readonly projectRoot?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly question?: string;
  readonly status?: SessionStatus;
}

/**
 * A session record, validated through the protocol's own `parseSessionRecord`
 * so a drifting upstream schema fails at the fixture rather than inside a test.
 */
function makeSession(overrides: SessionOverrides = {}): SessionRecord {
  const updatedAt = overrides.updatedAt ?? RECENT_AT;
  const projectRoot = overrides.projectRoot ?? PROJECT_A;
  return unwrap(
    parseSessionRecord({
      id: overrides.id ?? newSessionId(),
      projectRoot,
      projectName: projectRoot.slice(projectRoot.lastIndexOf('/') + 1),
      devServerUrl: 'http://127.0.0.1:3100/',
      createdAt: overrides.createdAt ?? updatedAt,
      updatedAt,
      status: overrides.status ?? 'ended',
      question: overrides.question ?? 'Why is alpha slow?',
      followUps: [],
      relevantFiles: [],
      plans: [],
      modifications: [],
      captures: [],
      panelIds: [],
      analyses: [],
      cleanup: { status: 'pending', conflicts: [] },
      promptVersions: {},
      provider: { id: 'deterministic' },
    }),
  );
}

/**
 * Stores a session whose last activity is `overrides.updatedAt` and proves the
 * row's `updated_at` column — the sweep's age basis — carries exactly that.
 */
function seedSession(harness: Harness, overrides: SessionOverrides = {}): SessionId {
  const record = makeSession(overrides);
  withClock(harness, record.updatedAt, () => unwrap(harness.sessions.insert(record)));
  expect(storedUpdatedAt(harness, record.id)).toBe(record.updatedAt);
  return record.id;
}

/**
 * A storable telemetry event: the persisted schema minus the store-assigned
 * `ingestSeq`. `insertMany` validates it against the persisted schema and
 * refuses the batch otherwise, so an invalid builder fails the seeding step.
 */
function makeEvent(
  harness: Harness,
  sessionId: SessionId,
  captureId: CaptureId,
  startTime: number,
): PersistableTelemetryEvent {
  const seq = harness.nextSeq;
  harness.nextSeq += 1;
  return {
    id: newEventId(),
    sessionId,
    captureId,
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind: 'fetch',
    tier: 'browser',
    name: `operation-alpha-${String(seq)}`,
    startTime: startTime + seq,
    duration: 12.5,
    attributes: {},
    status: 'ok',
    producerId: harness.producerId,
    seq,
  };
}

/**
 * A minimal panel. `insertPanel` parses it with `parsePanelSpec` and refuses it
 * as `PANEL_INVALID` otherwise, so the seeding step is the schema check.
 */
function makePanel(sessionId: SessionId): PanelSpec {
  return {
    version: 1,
    id: newPanelId(),
    sessionId,
    panelVersion: 1,
    title: 'Panel alpha',
    summary: { observed: [], likelyCauses: [] },
    layout: [{ type: 'eventLog', id: 'layout[0]', query: { source: 'events' } }],
  };
}

/** A minimal analysis, assembled by the protocol's constructor and validated by its parser. */
function makeAnalysis(sessionId: SessionId, captureId: CaptureId, at: number): AnalysisResult {
  return unwrap(
    parseAnalysisResult(
      createAnalysisResult(
        { observed: [], likelyCauses: [] },
        { sessionId, captureId, analysisVersion: 1, createdAt: at, metrics: [] },
      ),
    ),
  );
}

/** A minimal normalised plan; `insertPlan` validates it against the plan schema. */
function makePlan(sessionId: SessionId): InstrumentationPlan {
  return {
    version: 1,
    planVersion: 1,
    sessionId,
    objective: 'Measure where alpha spends its time',
    hypotheses: [],
    capture: ['fetch calls'],
    instrumentationTargets: [],
  };
}

/** What {@link makeModification} and {@link seedModification} may override. */
interface ModificationSeed {
  readonly sessionId: SessionId;
  readonly file?: string;
  /** The status the record ends in, reached from `pending` through one legal transition. */
  readonly status?: ModificationStatus;
  readonly diff?: string;
  /** When the backup file was written; its `mtime`. Defaults to the record's own time. */
  readonly backupAt?: number;
}

/**
 * A modification record built by the upstream constructor, with its backup at
 * `backups/<sessionId>/<originalHash>` — the layout the backup store writes.
 */
function makeModification(harness: Harness, seed: ModificationSeed): ModificationRecord {
  const file = seed.file ?? FILE_ONE;
  const originalHash = hashOf(harness, `original:${seed.sessionId}:${file}`);
  return unwrap(
    createModificationRecord(
      {
        sessionId: seed.sessionId,
        planVersion: 1,
        file,
        originalHash,
        backupPath: join(harness.backupsDir, seed.sessionId, originalHash),
        instrumentedHash: hashOf(harness, `instrumented:${seed.sessionId}:${file}`),
        diff: seed.diff ?? DIFF,
      },
      { now: () => harness.clock },
    ),
  );
}

/** A journalled record and the backup file it references. */
interface SeededModification {
  readonly record: ModificationRecord;
  readonly backupPath: string;
  readonly bytes: Buffer;
  readonly digest: string;
}

/**
 * Writes a record's backup file first and journals the record second — the
 * order the patcher uses — then moves it to `seed.status` through the real
 * `updateStatus` and its transition matrix.
 */
async function seedModification(
  harness: Harness,
  seed: ModificationSeed,
): Promise<SeededModification> {
  const record = makeModification(harness, seed);
  const bytes = writeDatedFile(
    record.backupPath,
    `original bytes of ${record.file}\n`,
    seed.backupAt ?? harness.clock,
  );
  let stored = unwrap(await harness.modifications.append(record));
  const status = seed.status ?? 'reverted';
  if (status !== stored.status) {
    stored = unwrap(await harness.modifications.updateStatus(stored.id, status));
  }
  expect(stored.status).toBe(status);
  return {
    record: stored,
    backupPath: record.backupPath,
    bytes,
    digest: sha256OfFileSync(record.backupPath),
  };
}

/** What {@link seedContents} wrote for one session. */
interface SeededContents {
  readonly captureId: CaptureId;
  readonly telemetryEvents: number;
  readonly panels: number;
  readonly analyses: number;
  readonly modification: SeededModification;
  /** The request-key secret the repository minted, for the privacy assertions only. */
  readonly requestKeySecret: string;
}

/** What {@link seedContents} may vary. */
interface ContentsSeed {
  readonly status?: ModificationStatus;
  readonly diff?: string;
  readonly backupAt?: number;
}

/**
 * Fills one session with one row (or more) in every table its cascade reaches:
 * a capture with three telemetry events, a panel, an analysis, a plan, two
 * progress lines, a follow-up, a tab binding, its request-key secret and one
 * journalled modification with its backup file. Everything is written at the
 * session's own `updatedAt`, so nothing here refreshes its age.
 */
async function seedContents(
  harness: Harness,
  sessionId: SessionId,
  at: number,
  seed: ContentsSeed = {},
): Promise<SeededContents> {
  harness.clock = at;
  try {
    const captureId = newCaptureId();
    unwrap(harness.sessions.startCapture({ sessionId, planVersion: 1, captureId, startedAt: at }));
    unwrap(harness.sessions.stopCapture({ captureId, stoppedAt: at + 1_000 }));

    const events = [0, 1, 2].map(() => makeEvent(harness, sessionId, captureId, at));
    expect(unwrap(harness.telemetry.insertMany(events)).inserted).toBe(events.length);

    unwrap(harness.panels.insertPanel(makePanel(sessionId), { captureId }));
    unwrap(harness.panels.insertAnalysis(makeAnalysis(sessionId, captureId, at)));
    unwrap(harness.sessions.insertPlan(makePlan(sessionId)));
    unwrap(
      harness.sessions.appendProgress({
        sessionId,
        stage: 'understand',
        status: 'running',
        message: 'Understanding problem',
      }),
    );
    unwrap(
      harness.sessions.appendProgress({
        sessionId,
        stage: 'understand',
        status: 'done',
        message: 'Found alpha',
      }),
    );
    unwrap(
      harness.sessions.appendFollowUp(sessionId, {
        question: 'Why did alpha run twice?',
        askedAt: at,
      }),
    );
    const tabId = harness.nextTabId;
    harness.nextTabId += 1;
    unwrap(
      harness.sessions.upsertBinding({ tabId, sessionId, url: 'http://127.0.0.1:3100/alpha' }),
    );
    const requestKeySecret = unwrap(harness.sessions.getOrCreateRequestKeySecret(sessionId));

    const modification = await seedModification(harness, {
      sessionId,
      status: seed.status ?? 'reverted',
      ...(seed.diff === undefined ? {} : { diff: seed.diff }),
      ...(seed.backupAt === undefined ? {} : { backupAt: seed.backupAt }),
    });

    // None of the child writes may have refreshed the session's age.
    expect(storedUpdatedAt(harness, sessionId)).toBe(at);

    return {
      captureId,
      telemetryEvents: events.length,
      panels: 1,
      analyses: 1,
      modification,
      requestKeySecret,
    };
  } finally {
    harness.clock = NOW;
  }
}

/** Seeds a session last updated `at` and fills it; the common case in this suite. */
async function seedFullSession(
  harness: Harness,
  at: number,
  overrides: SessionOverrides = {},
  seed: ContentsSeed = {},
): Promise<{ readonly sessionId: SessionId; readonly contents: SeededContents }> {
  const sessionId = seedSession(harness, { ...overrides, updatedAt: at });
  const contents = await seedContents(harness, sessionId, at, seed);
  return { sessionId, contents };
}

/** The issues of one scope whose target is `target`. */
function issuesAt(
  report: RetentionReport,
  scope: RetentionIssue['scope'],
  target: string,
): RetentionIssue[] {
  return report.errors.filter((issue) => issue.scope === scope && issue.target === target);
}

/** `path` relative to the sandbox's state root, as the report spells targets. */
function relativeToHome(harness: Harness, path: string): string {
  return path.slice(harness.home.length + 1);
}

/* -------------------------------------------------------------------------------------------------
 * Rule 1 — aged sessions
 * ---------------------------------------------------------------------------------------------- */

describe('Rule 1: aged sessions', () => {
  it('deletes an aged session and every row its cascade reaches, and reports what it held', async () => {
    const { sessionId, contents } = await seedFullSession(h, AGED_AT);

    // The fixture really did write a row into every scoped table; otherwise the
    // "empty afterwards" assertions below would pass vacuously.
    for (const [table, count] of Object.entries(scopedCounts(h, sessionId))) {
      expect(count, `seeded rows in ${table}`).toBeGreaterThan(0);
    }

    const report = await sweep(h);

    expect(report.cutoff).toBe(DEFAULT_CUTOFF);
    expect(report.sessionsDeleted).toBe(1);
    expect(report.sessionIdsDeleted).toEqual([sessionId]);
    expect(report.telemetryEventsDeleted).toBe(contents.telemetryEvents);
    expect(report.panelsDeleted).toBe(contents.panels);
    expect(report.analysesDeleted).toBe(contents.analyses);
    expect(report.modificationsDeleted).toBe(1);
    expect(report.backupDirsDeleted).toBe(1);
    expect(report.orphanBackupsDeleted).toBe(0);
    expect(report.indexCachesDeleted).toBe(0);
    expect(report.sessionsRetainedForConflicts).toEqual([]);
    expect(fileBytesReclaimed(report)).toBe(contents.modification.bytes.length);
    expect(report.errors).toEqual([]);

    // The cascade fired: every child table is empty for the purged session,
    // including the request-key secret and the tab binding.
    expect(sessionExists(h, sessionId)).toBe(false);
    for (const [table, count] of Object.entries(scopedCounts(h, sessionId))) {
      expect(count, `rows left in ${table}`).toBe(0);
    }
    expect(tableTotals(h)).toMatchObject({ sessions: 0, telemetry_events: 0, session_keys: 0 });

    // And its backup directory went with it.
    expect(present(join(h.backupsDir, sessionId))).toBe(false);
    expect(present(h.backupsDir)).toBe(true);
  });

  it('leaves a session updated inside the window untouched, rows and backups alike', async () => {
    const aged = await seedFullSession(h, AGED_AT);
    // The live session's backup is dated long before the window: a referenced
    // backup is kept however old it is, and the live session's age is its own.
    const live = await seedFullSession(h, RECENT_AT, {}, { backupAt: ANCIENT_AT });
    const before = scopedCounts(h, live.sessionId);

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([aged.sessionId]);
    expect(report.sessionIdsDeleted).not.toContain(live.sessionId);
    expect(sessionExists(h, live.sessionId)).toBe(true);
    expect(scopedCounts(h, live.sessionId)).toEqual(before);
    expect(present(join(h.backupsDir, live.sessionId))).toBe(true);
    expect(readFileSync(live.contents.modification.backupPath)).toEqual(
      live.contents.modification.bytes,
    );
    expect(report.orphanBackupsDeleted).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('ages a session by its last update, never by its creation', async () => {
    // Created a year ago, touched yesterday: a long-running session that must
    // never be purged mid-flight however long ago it began.
    const longRunning = seedSession(h, { createdAt: ANCIENT_AT, updatedAt: RECENT_AT });

    const report = await sweep(h);

    expect(report.sessionsDeleted).toBe(0);
    expect(sessionExists(h, longRunning)).toBe(true);
  });

  it('purges strictly before the cutoff: a session updated exactly at it survives', async () => {
    const atCutoff = seedSession(h, { updatedAt: DEFAULT_CUTOFF });
    const justBefore = seedSession(h, { updatedAt: DEFAULT_CUTOFF - 1 });

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([justBefore]);
    expect(sessionExists(h, atCutoff)).toBe(true);
    expect(sessionExists(h, justBefore)).toBe(false);
  });

  it('never touches credentials or pairing codes, which belong to no session', async () => {
    // The rows the auth layer writes directly through the store handle. The
    // values are computed placeholders, never secret-shaped literals.
    h.store
      .statement(
        'INSERT INTO credentials (token_hash, role, scope, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('b'.repeat(64), 'vscode', PROJECT_A, ANCIENT_AT, null);
    h.store
      .statement('INSERT INTO pairing_codes (code_hash, expires_at, used) VALUES (?, ?, ?)')
      .run('c'.repeat(64), ANCIENT_AT, 1);
    await seedFullSession(h, AGED_AT);

    const report = await sweep(h);

    expect(report.sessionsDeleted).toBe(1);
    expect(tableTotals(h)).toMatchObject({ sessions: 0, credentials: 1, pairing_codes: 1 });
  });

  it('retains an aged session whose journal still describes a patched file, and reports why', async () => {
    // Reconciliation normally settles an `applied` record before the sweep; if
    // one survives, the journal is the only record able to restore that file.
    const { sessionId, contents } = await seedFullSession(h, AGED_AT, {}, { status: 'applied' });

    const report = await sweep(h);

    expect(report.sessionsDeleted).toBe(0);
    expect(report.sessionsRetainedForConflicts).toEqual([]);
    expect(sessionExists(h, sessionId)).toBe(true);
    expect(rowsFor(h, 'modifications', sessionId)).toBe(1);
    expect(sha256OfFileSync(contents.modification.backupPath)).toBe(contents.modification.digest);

    const issues = issuesAt(report, 'session', sessionId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain(sessionId);
  });

  it('purges every aged candidate in one pass and lists them sorted', async () => {
    const ids = [fixedSessionId('charlie'), fixedSessionId('alpha'), fixedSessionId('bravo')];
    for (const id of ids) {
      seedSession(h, { id, updatedAt: AGED_AT });
    }

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([...ids].sort());
    expect(report.sessionsDeleted).toBe(ids.length);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The conflict exemption
 * ---------------------------------------------------------------------------------------------- */

describe('the conflict exemption', () => {
  it('retains an aged session whose journal holds a conflict, with its rows and its backup byte for byte', async () => {
    const first = await seedFullSession(
      h,
      AGED_AT,
      { id: fixedSessionId('bravo') },
      { status: 'conflict', backupAt: ANCIENT_AT },
    );
    const second = await seedFullSession(
      h,
      AGED_AT,
      { id: fixedSessionId('alpha') },
      { status: 'conflict', backupAt: ANCIENT_AT },
    );
    const before = scopedCounts(h, first.sessionId);

    const report = await sweep(h);

    expect(report.sessionsDeleted).toBe(0);
    expect(report.sessionIdsDeleted).toEqual([]);
    expect(report.sessionsRetainedForConflicts).toEqual([first.sessionId, second.sessionId].sort());
    expect(report.backupDirsDeleted).toBe(0);
    expect(report.orphanBackupsDeleted).toBe(0);
    expect(report.errors).toEqual([]);

    // The session row and everything scoped to it survived the window.
    expect(sessionExists(h, first.sessionId)).toBe(true);
    expect(scopedCounts(h, first.sessionId)).toEqual(before);
    expect(rowsFor(h, 'telemetry_events', first.sessionId)).toBe(first.contents.telemetryEvents);
    expect(rowsFor(h, 'panels', first.sessionId)).toBe(first.contents.panels);

    // The developer's only pristine copy is still there, unchanged.
    for (const { contents } of [first, second]) {
      expect(readFileSync(contents.modification.backupPath)).toEqual(contents.modification.bytes);
      expect(sha256OfFileSync(contents.modification.backupPath)).toBe(contents.modification.digest);
    }
  });

  it('purges the session once its conflict is resolved to reverted, at the same clock reading', async () => {
    const { sessionId, contents } = await seedFullSession(
      h,
      AGED_AT,
      {},
      { status: 'conflict', backupAt: ANCIENT_AT },
    );

    const retained = await sweep(h);
    expect(retained.sessionsRetainedForConflicts).toEqual([sessionId]);
    expect(sessionExists(h, sessionId)).toBe(true);

    // The developer resolves the conflict: the real transition matrix allows
    // conflict → reverted, and nothing else about the session changes.
    const resolved = unwrap(
      await h.modifications.updateStatus(contents.modification.record.id, 'reverted'),
    );
    expect(resolved.status).toBe('reverted');

    const purged = await sweep(h);

    expect(purged.cutoff).toBe(retained.cutoff);
    expect(purged.sessionsRetainedForConflicts).toEqual([]);
    expect(purged.sessionIdsDeleted).toEqual([sessionId]);
    expect(purged.modificationsDeleted).toBe(1);
    expect(purged.backupDirsDeleted).toBe(1);
    expect(purged.errors).toEqual([]);
    expect(sessionExists(h, sessionId)).toBe(false);
    for (const table of SESSION_SCOPED_TABLES) {
      expect(rowsFor(h, table, sessionId), `rows left in ${table}`).toBe(0);
    }
    expect(present(contents.modification.backupPath)).toBe(false);
    expect(present(join(h.backupsDir, sessionId))).toBe(false);
  });

  it('protects the conflict backup even when the session also holds reverted records', async () => {
    const sessionId = seedSession(h, { updatedAt: AGED_AT });
    const conflicted = await withClockAsync(h, AGED_AT, () =>
      seedModification(h, { sessionId, file: FILE_ONE, status: 'conflict', backupAt: ANCIENT_AT }),
    );
    const reverted = await withClockAsync(h, AGED_AT, () =>
      seedModification(h, { sessionId, file: FILE_TWO, status: 'reverted', backupAt: ANCIENT_AT }),
    );

    const report = await sweep(h);

    expect(report.sessionsRetainedForConflicts).toEqual([sessionId]);
    expect(rowsFor(h, 'modifications', sessionId)).toBe(2);
    // Both backups are referenced by rows that still exist, so neither is an orphan.
    expect(sha256OfFileSync(conflicted.backupPath)).toBe(conflicted.digest);
    expect(sha256OfFileSync(reverted.backupPath)).toBe(reverted.digest);
    expect(report.orphanBackupsDeleted).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * One decision and one cascade per session, and no purge of an active one
 * ---------------------------------------------------------------------------------------------- */

/** How many events one seeding `insertMany` call carries. */
const TELEMETRY_SEED_CHUNK = 1_000;

/** More telemetry than one batch of the telemetry repository's batched purge holds. */
const LARGE_TELEMETRY = DEFAULT_PURGE_BATCH_SIZE + 25;

/**
 * The timeout of a test that seeds a large fixture — more than one purge batch
 * of telemetry, validated event by event through `insertMany`, or more than
 * one candidate page of sessions — and sweeps it: **60 s**, the bound the
 * telemetry repository's own large-purge tests use. Such a test takes a few
 * seconds on an idle host and legitimately exceeds the 5 s default on a loaded
 * one; a genuinely hung sweep still fails.
 */
const LARGE_FIXTURE_TEST_TIMEOUT_MS = 60_000;

/** What {@link seedTelemetry} may vary. */
interface TelemetrySeed {
  /** Leave the capture window open, as a capture still in progress does. */
  readonly open?: boolean;
}

/**
 * Adds one capture holding `count` telemetry events to a session, written at
 * `at` in chunks, and proves none of it refreshed the session's age.
 *
 * @returns The capture's id.
 */
function seedTelemetry(
  harness: Harness,
  sessionId: SessionId,
  at: number,
  count: number,
  seed: TelemetrySeed = {},
): CaptureId {
  return withClock(harness, at, () => {
    const captureId = newCaptureId();
    unwrap(harness.sessions.startCapture({ sessionId, planVersion: 1, captureId, startedAt: at }));
    for (let written = 0; written < count; written += TELEMETRY_SEED_CHUNK) {
      const size = Math.min(TELEMETRY_SEED_CHUNK, count - written);
      const events = Array.from({ length: size }, () =>
        makeEvent(harness, sessionId, captureId, at),
      );
      expect(unwrap(harness.telemetry.insertMany(events)).inserted).toBe(size);
    }
    if (seed.open !== true) {
      unwrap(harness.sessions.stopCapture({ captureId, stoppedAt: at + 1_000 }));
    }
    expect(storedUpdatedAt(harness, sessionId)).toBe(at);
    return captureId;
  });
}

/** Asserts that no row of any cascading table still belongs to `sessionId`. */
function expectNoRowsLeft(harness: Harness, sessionId: SessionId): void {
  for (const table of SESSION_SCOPED_TABLES) {
    expect(rowsFor(harness, table, sessionId), table).toBe(0);
  }
}

/** The `ingest_seq` of a session's last-inserted event. */
function lastIngestSeq(harness: Harness, sessionId: SessionId): number {
  return readCount(
    harness.store
      .statement('SELECT MAX(ingest_seq) AS n FROM telemetry_events WHERE session_id = ?')
      .get(sessionId),
  );
}

/** The `ingest_seq` of a session's first-inserted event. */
function firstIngestSeq(harness: Harness, sessionId: SessionId): number {
  return readCount(
    harness.store
      .statement('SELECT MIN(ingest_seq) AS n FROM telemetry_events WHERE session_id = ?')
      .get(sessionId),
  );
}

/**
 * Makes the delete of one telemetry row fail with {@link SENTINEL} as the
 * engine's message, so the report and the logs can be proven free of it.
 * Dropped with {@link dropDeleteFailure}.
 */
function failDeleteOf(harness: Harness, ingestSeq: number): void {
  harness.store.db.exec(
    `CREATE TEMP TRIGGER retention_cascade_failure BEFORE DELETE ON main.telemetry_events ` +
      `WHEN old.ingest_seq = ${String(ingestSeq)} ` +
      `BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`,
  );
}

/** Removes the trigger {@link failDeleteOf} planted. */
function dropDeleteFailure(harness: Harness): void {
  harness.store.db.exec('DROP TRIGGER retention_cascade_failure');
}

/**
 * A store that forwards everything to `store` and calls `beforeTransaction`
 * with the 1-based ordinal of each transaction the sweep itself opens, just
 * before it opens it — the moment between two drain batches of a large
 * session. The repositories keep the real store, so only the sweep's own
 * deciding transactions are seen.
 */
function hookTransactions(store: Store, beforeTransaction: (ordinal: number) => void): Store {
  let ordinal = 0;
  return new Proxy(store, {
    get(target, key): unknown {
      if (key === 'transaction') {
        return <T>(fn: () => T): T => {
          ordinal += 1;
          beforeTransaction(ordinal);
          return target.transaction(fn);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Every scoped table's row count for one session, telemetry left out. */
function evidenceBesideTelemetry(
  harness: Harness,
  sessionId: SessionId,
): Record<SessionScopedTable, number> {
  return { ...scopedCounts(harness, sessionId), telemetry_events: 0 };
}

/** The `warn` records of a large session whose drain stopped before its cascade. */
function drainStops(harness: Harness): CapturedLog[] {
  return harness.logs.filter(
    (log) =>
      log.level === 'warn' &&
      log.message ===
        'a large session stopped being eligible part-way through its purge; its row and remaining evidence were kept',
  );
}

/** The resting statuses: every status outside {@link IN_FLIGHT_SESSION_STATUSES}. */
const RESTING_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter(
  (status) => !IN_FLIGHT_SESSION_STATUSES.includes(status),
);

describe('an atomic purge that never touches an active session', () => {
  it(
    'purges a session holding more than one purge batch of telemetry in bounded batches, then one cascade',
    async () => {
      const { sessionId, contents } = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, sessionId, AGED_AT, LARGE_TELEMETRY);
      const total = contents.telemetryEvents + LARGE_TELEMETRY;

      const dry = await sweep(h, { dryRun: true });
      expect(dry.telemetryEventsDeleted).toBe(total);
      expect(rowsFor(h, 'telemetry_events', sessionId)).toBe(total);

      // What the session still held as each of the sweep's transactions opened.
      const heldAtEachTransaction: number[] = [];
      const store = hookTransactions(h.store, () => {
        heldAtEachTransaction.push(rowsFor(h, 'telemetry_events', sessionId));
      });
      const report = await sweep(h, {}, { store });

      expect(report.sessionIdsDeleted).toEqual([sessionId]);
      expect(report.telemetryEventsDeleted).toBe(total);
      expect(report.telemetryEventsDeleted).toBe(dry.telemetryEventsDeleted);
      expect(report.panelsDeleted).toBe(contents.panels);
      expect(report.analysesDeleted).toBe(contents.analyses);
      expect(report.modificationsDeleted).toBe(1);
      expect(report.backupDirsDeleted).toBe(1);
      expect(report.errors).toEqual([]);
      expectNoRowsLeft(h, sessionId);
      expect(sessionExists(h, sessionId)).toBe(false);
      // One drain batch, then the cascade over the rest: no transaction held
      // the write lock — and the event loop — for more than one batch.
      expect(heldAtEachTransaction).toEqual([total, total - DEFAULT_PURGE_BATCH_SIZE]);
      expect(total - DEFAULT_PURGE_BATCH_SIZE).toBeLessThanOrEqual(DEFAULT_PURGE_BATCH_SIZE);
      expect(drainStops(h)).toEqual([]);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'keeps the batches it committed when the final cascade of a large session fails, reports it, and carries on',
    async () => {
      const failing = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, failing.sessionId, AGED_AT, LARGE_TELEMETRY);
      const sibling = await seedFullSession(h, AGED_AT + DAY_MS);
      const rowsBefore = scopedCounts(h, failing.sessionId);
      expect(rowsBefore.telemetry_events).toBeGreaterThan(DEFAULT_PURGE_BATCH_SIZE);
      expect(rowsBefore.telemetry_events).toBeLessThanOrEqual(2 * DEFAULT_PURGE_BATCH_SIZE);

      // The session's last-inserted — newest — event refuses to be deleted, so
      // the first batch drains cleanly and the final cascade fails.
      failDeleteOf(h, lastIngestSeq(h, failing.sessionId));

      const report = await sweep(h);

      // The drained batch stays deleted; the row and everything else stay.
      expect(sessionExists(h, failing.sessionId)).toBe(true);
      expect(rowsFor(h, 'telemetry_events', failing.sessionId)).toBe(
        rowsBefore.telemetry_events - DEFAULT_PURGE_BATCH_SIZE,
      );
      expect(evidenceBesideTelemetry(h, failing.sessionId)).toEqual({
        ...rowsBefore,
        telemetry_events: 0,
      });
      expect(present(failing.contents.modification.backupPath)).toBe(true);
      const issues = issuesAt(report, 'session', failing.sessionId);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain(String(DEFAULT_PURGE_BATCH_SIZE));
      expect(report.errors).toHaveLength(1);
      expect(drainStops(h).map((log) => log.fields)).toEqual([
        expect.objectContaining({
          sessionId: failing.sessionId,
          outcome: 'failed',
          drainedEvents: DEFAULT_PURGE_BATCH_SIZE,
        }),
      ]);
      // The sweep went on to the next candidate, and counted every event it deleted.
      expect(report.sessionIdsDeleted).toEqual([sibling.sessionId]);
      expect(report.telemetryEventsDeleted).toBe(
        sibling.contents.telemetryEvents + DEFAULT_PURGE_BATCH_SIZE,
      );
      expectNoRowsLeft(h, sibling.sessionId);
      // No engine text reaches the report or a log record.
      expect(JSON.stringify(report)).not.toContain(SENTINEL);
      expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);

      dropDeleteFailure(h);
      const retry = await sweep(h);

      // The next sweep resumes where the failed one stopped.
      expect(retry.sessionIdsDeleted).toEqual([failing.sessionId]);
      expect(retry.telemetryEventsDeleted).toBe(
        rowsBefore.telemetry_events - DEFAULT_PURGE_BATCH_SIZE,
      );
      expect(retry.errors).toEqual([]);
      expectNoRowsLeft(h, failing.sessionId);
      expect(present(failing.contents.modification.backupPath)).toBe(false);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'records a drain batch the store refuses as an issue, keeps the batches before it, and still purges the sibling',
    async () => {
      const failing = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, failing.sessionId, AGED_AT, 2 * DEFAULT_PURGE_BATCH_SIZE + 25);
      const sibling = await seedFullSession(h, AGED_AT + DAY_MS);
      const rowsBefore = scopedCounts(h, failing.sessionId);
      expect(rowsBefore.telemetry_events).toBeGreaterThan(2 * DEFAULT_PURGE_BATCH_SIZE);

      // Events are drained oldest first, so this one falls in the second batch:
      // the first commits, the second rolls back, and no cascade is attempted.
      failDeleteOf(h, firstIngestSeq(h, failing.sessionId) + DEFAULT_PURGE_BATCH_SIZE + 10);

      const report = await sweep(h);

      expect(sessionExists(h, failing.sessionId)).toBe(true);
      expect(rowsFor(h, 'telemetry_events', failing.sessionId)).toBe(
        rowsBefore.telemetry_events - DEFAULT_PURGE_BATCH_SIZE,
      );
      expect(evidenceBesideTelemetry(h, failing.sessionId)).toEqual({
        ...rowsBefore,
        telemetry_events: 0,
      });
      expect(present(failing.contents.modification.backupPath)).toBe(true);
      expect(issuesAt(report, 'session', failing.sessionId)).toHaveLength(1);
      expect(report.errors).toHaveLength(1);
      expect(report.sessionIdsDeleted).toEqual([sibling.sessionId]);
      expect(report.telemetryEventsDeleted).toBe(
        sibling.contents.telemetryEvents + DEFAULT_PURGE_BATCH_SIZE,
      );
      expectNoRowsLeft(h, sibling.sessionId);
      expect(JSON.stringify(report)).not.toContain(SENTINEL);
      expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);

      dropDeleteFailure(h);
      const retry = await sweep(h);

      expect(retry.sessionIdsDeleted).toEqual([failing.sessionId]);
      expect(retry.telemetryEventsDeleted).toBe(
        rowsBefore.telemetry_events - DEFAULT_PURGE_BATCH_SIZE,
      );
      expect(retry.errors).toEqual([]);
      expectNoRowsLeft(h, failing.sessionId);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'stops draining a large session refreshed or claimed part-way, keeping its row and every undrained piece of evidence',
    async () => {
      const refreshed = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, refreshed.sessionId, AGED_AT, LARGE_TELEMETRY);
      const claimed = await seedFullSession(h, AGED_AT + DAY_MS);
      seedTelemetry(h, claimed.sessionId, AGED_AT + DAY_MS, LARGE_TELEMETRY);
      const before = new Map(
        [refreshed.sessionId, claimed.sessionId].map((id) => [id, scopedCounts(h, id)]),
      );

      // Candidates are decided oldest first. The refreshed session's second
      // transaction opens after the developer resumed it; the claimed session is
      // free for its first transaction and claimed for its second.
      const store = hookTransactions(h.store, (ordinal) => {
        if (ordinal === 2) {
          unwrap(h.sessions.setStatus(refreshed.sessionId, 'ended'));
        }
      });
      const asked = new Map<SessionId, number>();
      const report = await sweep(
        h,
        {},
        {
          store,
          isSessionInUse: (sessionId) => {
            const calls = (asked.get(sessionId) ?? 0) + 1;
            asked.set(sessionId, calls);
            return sessionId === claimed.sessionId && calls >= 2;
          },
        },
      );

      expect(storedUpdatedAt(h, refreshed.sessionId)).toBe(NOW);
      expect(report.sessionsDeleted).toBe(0);
      expect(report.sessionIdsDeleted).toEqual([]);
      expect(report.sessionsRetainedActive).toEqual([claimed.sessionId]);
      expect(report.telemetryEventsDeleted).toBe(2 * DEFAULT_PURGE_BATCH_SIZE);
      expect(report.errors).toEqual([]);
      for (const { sessionId, contents } of [refreshed, claimed]) {
        const rowsBefore = before.get(sessionId);
        expect(sessionExists(h, sessionId)).toBe(true);
        expect(rowsFor(h, 'telemetry_events', sessionId)).toBe(
          (rowsBefore?.telemetry_events ?? 0) - DEFAULT_PURGE_BATCH_SIZE,
        );
        expect(evidenceBesideTelemetry(h, sessionId)).toEqual({
          ...rowsBefore,
          telemetry_events: 0,
        });
        expect(present(contents.modification.backupPath)).toBe(true);
      }
      const stops = drainStops(h);
      expect(stops.map((log) => log.fields)).toEqual([
        expect.objectContaining({
          sessionId: refreshed.sessionId,
          outcome: 'refreshed',
          drainedEvents: DEFAULT_PURGE_BATCH_SIZE,
        }),
        expect.objectContaining({
          sessionId: claimed.sessionId,
          outcome: 'in-use',
          drainedEvents: DEFAULT_PURGE_BATCH_SIZE,
        }),
      ]);
      // Ids and counts only: no path reaches the record.
      expect(JSON.stringify(stops)).not.toContain(h.root);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'keeps every event of a large session refreshed after it was listed',
    async () => {
      const { sessionId, contents } = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, sessionId, AGED_AT, LARGE_TELEMETRY);
      const rowsBefore = scopedCounts(h, sessionId);

      // A client touches the session between the candidate listing and the
      // decision, as a live service does when the developer resumes it.
      let refreshed = false;
      const modifications: ModificationsRepo = {
        ...h.modifications,
        listConflicts: (...args: Parameters<ModificationsRepo['listConflicts']>) => {
          if (args[0] === sessionId && !refreshed) {
            refreshed = true;
            unwrap(h.sessions.setStatus(sessionId, 'ended'));
          }
          return h.modifications.listConflicts(...args);
        },
      };

      const report = await sweep(h, {}, { modifications });

      expect(refreshed).toBe(true);
      expect(storedUpdatedAt(h, sessionId)).toBe(NOW);
      expect(report.sessionsDeleted).toBe(0);
      expect(report.sessionIdsDeleted).toEqual([]);
      expect(report.telemetryEventsDeleted).toBe(0);
      expect(report.errors).toEqual([]);
      expect(sessionExists(h, sessionId)).toBe(true);
      expect(scopedCounts(h, sessionId)).toEqual(rowsBefore);
      expect(present(contents.modification.backupPath)).toBe(true);
      expect(
        h.logs.some(
          (log) =>
            log.message === 'aged session no longer eligible at deletion time' &&
            log.fields['outcome'] === 'refreshed',
        ),
      ).toBe(true);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it('retains an aged session in any in-flight status and purges one at rest, dry run and real alike', async () => {
    const active: SessionId[] = [];
    for (const status of IN_FLIGHT_SESSION_STATUSES) {
      active.push((await seedFullSession(h, AGED_AT, { status })).sessionId);
    }
    const resting: SessionId[] = [];
    for (const status of RESTING_STATUSES) {
      resting.push((await seedFullSession(h, AGED_AT, { status })).sessionId);
    }
    const activeCounts = active.map((sessionId) => scopedCounts(h, sessionId));

    const dry = await sweep(h, { dryRun: true });
    const report = await sweep(h);

    expect(comparable(report)).toEqual(comparable(dry));
    expect(report.sessionsRetainedActive).toEqual([...active].sort());
    expect(report.sessionIdsDeleted).toEqual([...resting].sort());
    expect(report.sessionsRetainedForConflicts).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(active.map((sessionId) => scopedCounts(h, sessionId))).toEqual(activeCounts);
    for (const sessionId of resting) {
      expectNoRowsLeft(h, sessionId);
    }
    expect(
      h.logs.filter(
        (log) =>
          log.message === 'retaining an aged session: it is still active' &&
          log.fields['reason'] === 'in-flight',
      ),
    ).toHaveLength(active.length * 2);
  });

  it('retains an aged session holding an open capture window until that window closes', async () => {
    const { sessionId, contents } = await seedFullSession(h, AGED_AT, { status: 'ready' });
    const captureId = seedTelemetry(h, sessionId, AGED_AT, 10, { open: true });
    const events = contents.telemetryEvents + 10;

    const held = await sweep(h);

    expect(held.sessionsRetainedActive).toEqual([sessionId]);
    expect(held.sessionsDeleted).toBe(0);
    expect(held.errors).toEqual([]);
    expect(rowsFor(h, 'telemetry_events', sessionId)).toBe(events);

    // Closing the window does not refresh the session, so it ages out at once.
    withClock(h, AGED_AT, () =>
      unwrap(h.sessions.stopCapture({ captureId, stoppedAt: AGED_AT + 2_000 })),
    );
    expect(storedUpdatedAt(h, sessionId)).toBe(AGED_AT);
    const released = await sweep(h);

    expect(released.sessionIdsDeleted).toEqual([sessionId]);
    expect(released.sessionsRetainedActive).toEqual([]);
    expect(released.telemetryEventsDeleted).toBe(events);
    expectNoRowsLeft(h, sessionId);
  });

  it('asks the caller last, inside the deleting transaction, and reads a failing answer as in use', async () => {
    const claimed = (await seedFullSession(h, AGED_AT)).sessionId;
    const unanswered = (await seedFullSession(h, AGED_AT)).sessionId;
    const free = (await seedFullSession(h, AGED_AT)).sessionId;
    const conflicted = (await seedFullSession(h, AGED_AT, {}, { status: 'conflict' })).sessionId;
    const inFlight = (await seedFullSession(h, AGED_AT, { status: 'analyzing' })).sessionId;
    const recent = (await seedFullSession(h, RECENT_AT)).sessionId;

    const asked: { readonly sessionId: SessionId; readonly inTransaction: boolean }[] = [];
    const report = await sweep(
      h,
      {},
      {
        isSessionInUse: (sessionId) => {
          asked.push({ sessionId, inTransaction: h.store.db.isTransaction });
          if (sessionId === unanswered) {
            throw new Error(SENTINEL);
          }
          return sessionId === claimed;
        },
      },
    );

    expect(report.sessionsRetainedActive).toEqual([claimed, inFlight, unanswered].sort());
    expect(report.sessionsRetainedForConflicts).toEqual([conflicted]);
    expect(report.sessionIdsDeleted).toEqual([free]);
    expect(report.errors).toEqual([]);
    // Only sessions every other rule let through were asked, each inside the
    // transaction that deletes it.
    expect(asked.map((entry) => entry.sessionId).sort()).toEqual(
      [claimed, free, unanswered].sort(),
    );
    expect(asked.every((entry) => entry.inTransaction)).toBe(true);
    for (const sessionId of [claimed, unanswered, inFlight, conflicted, recent]) {
      expect(sessionExists(h, sessionId)).toBe(true);
    }
    expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);
  });

  it('tells the listener of each deleted session after its transaction, never on a dry run, and survives a throwing listener', async () => {
    const first = (await seedFullSession(h, AGED_AT)).sessionId;
    const second = (await seedFullSession(h, AGED_AT)).sessionId;
    const inFlight = (await seedFullSession(h, AGED_AT, { status: 'analyzing' })).sessionId;
    const recent = (await seedFullSession(h, RECENT_AT)).sessionId;

    const told: { readonly sessionId: SessionId; readonly inTransaction: boolean }[] = [];
    const listen = (sessionId: SessionId): void => {
      told.push({ sessionId, inTransaction: h.store.db.isTransaction });
      if (sessionId === first) {
        throw new Error(SENTINEL);
      }
    };

    const dry = await sweep(h, { dryRun: true }, { onSessionDeleted: listen });
    expect(dry.sessionIdsDeleted).toEqual([first, second].sort());
    expect(told).toEqual([]);

    const report = await sweep(h, {}, { onSessionDeleted: listen });

    expect(report.sessionIdsDeleted).toEqual([first, second].sort());
    expect(report.errors).toEqual([]);
    expect(told.map((entry) => entry.sessionId).sort()).toEqual([first, second].sort());
    // Told once the delete has committed, so the listener sees no open transaction.
    expect(told.every((entry) => !entry.inTransaction)).toBe(true);
    for (const sessionId of [first, second]) {
      expectNoRowsLeft(h, sessionId);
    }
    for (const sessionId of [inFlight, recent]) {
      expect(sessionExists(h, sessionId)).toBe(true);
    }
    expect(
      h.logs.filter((log) => log.message === 'the listener for a purged session failed'),
    ).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Rule 3 — orphan backups
 * ---------------------------------------------------------------------------------------------- */

describe('Rule 3: orphan backups', () => {
  /** The orphan grace cutoff at {@link NOW}. */
  const GRACE_CUTOFF = daysAgo(ORPHAN_BACKUP_GRACE_DAYS);

  it('removes an unreferenced backup only once it is older than the grace window', async () => {
    const live = await seedFullSession(h, RECENT_AT);
    const directory = live.sessionId;
    // A crash between the backup write and the journal append leaves exactly
    // this: a file no row names. Younger than the grace, it may be about to be
    // claimed; at the boundary it is still inside the grace; older, it is debris.
    const young = writeLooseBackup(h, directory, hashOf(h, 'loose:young'), daysAgo(1));
    const atGrace = writeLooseBackup(h, directory, hashOf(h, 'loose:at-grace'), GRACE_CUTOFF);
    const stale = writeLooseBackup(h, directory, hashOf(h, 'loose:stale'), GRACE_CUTOFF - 1_000);

    const report = await sweep(h);

    expect(report.orphanBackupsDeleted).toBe(1);
    expect(present(stale)).toBe(false);
    expect(present(young)).toBe(true);
    expect(present(atGrace)).toBe(true);
    // The directory still holds a referenced backup and two young orphans.
    expect(present(join(h.backupsDir, directory))).toBe(true);
    expect(report.backupDirsDeleted).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('never removes a backup a live record references, however old the file', async () => {
    const sessionId = seedSession(h, { updatedAt: RECENT_AT });
    const referenced = await seedModification(h, {
      sessionId,
      status: 'applied',
      backupAt: ANCIENT_AT,
    });

    const report = await sweep(h);

    expect(report.orphanBackupsDeleted).toBe(0);
    expect(sha256OfFileSync(referenced.backupPath)).toBe(referenced.digest);
  });

  it('never removes a backup a conflict record references, however old the file', async () => {
    const sessionId = seedSession(h, { updatedAt: RECENT_AT });
    const conflicted = await seedModification(h, {
      sessionId,
      status: 'conflict',
      backupAt: ANCIENT_AT,
    });

    const report = await sweep(h);

    expect(report.orphanBackupsDeleted).toBe(0);
    expect(report.sessionsRetainedForConflicts).toEqual([]);
    expect(readFileSync(conflicted.backupPath)).toEqual(conflicted.bytes);
  });

  it('removes a session backup directory it empties, and keeps one that still holds a referenced backup', async () => {
    // A directory whose session row is already gone: only stale orphans remain.
    const ghost = fixedSessionId('ghost');
    const ghostFiles = [
      writeLooseBackup(h, ghost, hashOf(h, 'ghost:one'), ANCIENT_AT),
      writeLooseBackup(h, ghost, hashOf(h, 'ghost:two'), ANCIENT_AT),
    ];
    // A live session's directory: one referenced backup and one stale orphan.
    const liveId = seedSession(h, { updatedAt: RECENT_AT });
    const referenced = await seedModification(h, { sessionId: liveId, backupAt: ANCIENT_AT });
    const liveOrphan = writeLooseBackup(h, liveId, hashOf(h, 'live:orphan'), ANCIENT_AT);

    const report = await sweep(h);

    expect(report.orphanBackupsDeleted).toBe(ghostFiles.length + 1);
    expect(report.backupDirsDeleted).toBe(1);
    for (const file of ghostFiles) {
      expect(present(file)).toBe(false);
    }
    expect(present(join(h.backupsDir, ghost))).toBe(false);
    expect(present(liveOrphan)).toBe(false);
    expect(present(join(h.backupsDir, liveId))).toBe(true);
    expect(sha256OfFileSync(referenced.backupPath)).toBe(referenced.digest);
    expect(report.bytesReclaimed).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
  });

  it('judges only the level the backup store writes: a subdirectory is never descended into', async () => {
    const ghost = fixedSessionId('quarantine');
    // A relocated backup lives one level further down and is reached only
    // through the record that names it, never by the orphan walk.
    const relocated = join(h.backupsDir, ghost, 'relocated', hashOf(h, 'relocated'));
    writeDatedFile(relocated, 'relocated backup bytes\n', ANCIENT_AT);
    const loose = writeLooseBackup(h, ghost, hashOf(h, 'quarantine:loose'), ANCIENT_AT);

    const report = await sweep(h);

    expect(present(loose)).toBe(false);
    expect(present(relocated)).toBe(true);
    // The directory still holds the subdirectory, so it is not removed.
    expect(present(join(h.backupsDir, ghost))).toBe(true);
    expect(report.orphanBackupsDeleted).toBe(1);
    expect(report.backupDirsDeleted).toBe(0);
  });

  it('judges a stray file directly under backups/ exactly like any other orphan', async () => {
    const strayOld = join(h.backupsDir, hashOf(h, 'stray:old'));
    const strayYoung = join(h.backupsDir, hashOf(h, 'stray:young'));
    writeDatedFile(strayOld, 'stray bytes\n', ANCIENT_AT);
    writeDatedFile(strayYoung, 'stray bytes\n', RECENT_AT);

    const report = await sweep(h);

    expect(present(strayOld)).toBe(false);
    expect(present(strayYoung)).toBe(true);
    expect(report.orphanBackupsDeleted).toBe(1);
  });

  it('never counts the files of a directory Rule 1 removed as orphans a second time', async () => {
    const { sessionId } = await seedFullSession(h, AGED_AT, {}, { backupAt: ANCIENT_AT });
    writeLooseBackup(h, sessionId, hashOf(h, 'aged:loose'), ANCIENT_AT);

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([sessionId]);
    expect(report.backupDirsDeleted).toBe(1);
    expect(report.orphanBackupsDeleted).toBe(0);
    expect(present(join(h.backupsDir, sessionId))).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Rule 2 — code-index caches
 * ---------------------------------------------------------------------------------------------- */

describe('Rule 2: code-index caches', () => {
  it('keeps an old entry whose recorded project has a session inside the window', async () => {
    seedSession(h, { projectRoot: PROJECT_A, updatedAt: RECENT_AT });
    // A cache hit does not rewrite the entry, so an actively used project's
    // cache can be old on disk. Both spellings of the recorded root count.
    const nested = writeIndexEntry(
      h,
      'alpha.json',
      { index: { projectRoot: PROJECT_A } },
      ANCIENT_AT,
    );
    const topLevel = writeIndexEntry(h, 'bravo.json', { projectRoot: `${PROJECT_A}/` }, ANCIENT_AT);

    const report = await sweep(h);

    expect(report.indexCachesDeleted).toBe(0);
    expect(present(nested)).toBe(true);
    expect(present(topLevel)).toBe(true);
  });

  it('removes an old entry that records no project, and keeps a recent one', async () => {
    const staleEmpty = writeIndexEntry(h, 'alpha.json', {}, daysAgo(DEFAULT_RETENTION_DAYS + 1));
    const staleGarbage = writeIndexEntry(h, 'bravo.json', 'not json at all', ANCIENT_AT);
    const staleOther = writeIndexEntry(h, 'charlie.bin', 'opaque bytes', ANCIENT_AT);
    const recent = writeIndexEntry(h, 'delta.json', {}, RECENT_AT);
    const atCutoff = writeIndexEntry(h, 'echo.json', {}, DEFAULT_CUTOFF);

    const report = await sweep(h);

    expect(report.indexCachesDeleted).toBe(3);
    expect(present(staleEmpty)).toBe(false);
    expect(present(staleGarbage)).toBe(false);
    expect(present(staleOther)).toBe(false);
    expect(present(recent)).toBe(true);
    expect(present(atCutoff)).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('removes an old entry whose project was last opened before the window', async () => {
    const aged = seedSession(h, { projectRoot: PROJECT_B, updatedAt: AGED_AT });
    seedSession(h, { projectRoot: PROJECT_A, updatedAt: RECENT_AT });
    const abandoned = writeIndexEntry(
      h,
      'alpha.json',
      { index: { projectRoot: PROJECT_B } },
      ANCIENT_AT,
    );
    const active = writeIndexEntry(
      h,
      'bravo.json',
      { index: { projectRoot: PROJECT_A } },
      ANCIENT_AT,
    );

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([aged]);
    expect(report.indexCachesDeleted).toBe(1);
    expect(present(abandoned)).toBe(false);
    expect(present(active)).toBe(true);
  });

  it('judges a directory-shaped entry by its newest child and removes an abandoned one whole', async () => {
    seedSession(h, { projectRoot: PROJECT_A, updatedAt: RECENT_AT });

    /** Writes `index/<name>/` with `children`, then dates the directory itself. */
    const writeEntryDirectory = (
      name: string,
      children: Readonly<Record<string, { readonly body: string; readonly at: number }>>,
    ): string => {
      const directory = join(h.indexCacheDir, name);
      for (const [child, { body, at }] of Object.entries(children)) {
        writeDatedFile(join(directory, child), body, at);
      }
      setAge(directory, ANCIENT_AT);
      return directory;
    };

    const owned = writeEntryDirectory('alpha', {
      'meta.json': { body: JSON.stringify({ projectRoot: PROJECT_A }), at: ANCIENT_AT },
      'graph.bin': { body: 'graph bytes', at: ANCIENT_AT },
    });
    const abandoned = writeEntryDirectory('bravo', {
      'graph.bin': { body: 'graph bytes', at: ANCIENT_AT },
      'symbols.bin': { body: 'symbol bytes', at: ANCIENT_AT },
    });
    const freshChild = writeEntryDirectory('charlie', {
      'graph.bin': { body: 'graph bytes', at: RECENT_AT },
    });

    const report = await sweep(h);

    expect(report.indexCachesDeleted).toBe(1);
    expect(present(owned)).toBe(true);
    expect(present(abandoned)).toBe(false);
    expect(present(freshChild)).toBe(true);
    expect(report.errors).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Rule 2, ahead of the age rule: entries the cache can no longer reach
 * ---------------------------------------------------------------------------------------------- */

/** The records the sweep logged for entries it removed ahead of the age rule, in sweep order. */
function supersededRecords(harness: Harness): CapturedLog[] {
  return harness.logs.filter((log) => log.message === 'an index-cache entry was superseded');
}

describe('Rule 2: superseded and older-envelope code-index caches', () => {
  it('removes an entry of an older envelope version whatever its age, even while its project is active', async () => {
    seedSession(h, { projectRoot: PROJECT_A, updatedAt: RECENT_AT });
    const previous = writeIndexEntry(
      h,
      'alpha.json',
      makeIndexEnvelope(PROJECT_A, INDEX_CACHE_SCHEMA_VERSION - 1),
      RECENT_AT,
    );
    const earlier = writeIndexEntry(
      h,
      'bravo.json',
      makeIndexEnvelope(PROJECT_A, INDEX_CACHE_SCHEMA_VERSION - 2),
      ANCIENT_AT,
    );
    const current = writeIndexEntry(h, 'charlie.json', makeIndexEnvelope(PROJECT_A), ANCIENT_AT);
    const reclaimable = lstatSync(previous).size + lstatSync(earlier).size;

    const report = await sweep(h);

    expect(report.indexCachesDeleted).toBe(2);
    expect(report.bytesReclaimed).toBe(reclaimable);
    expect(present(previous)).toBe(false);
    expect(present(earlier)).toBe(false);
    // Old on disk, but the current version and its project is active: the age rule keeps it.
    expect(present(current)).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('keeps only the newest current-version entry of each project, however recent the others are', async () => {
    seedSession(h, { projectRoot: PROJECT_A, updatedAt: RECENT_AT });
    const olderA = writeIndexEntry(h, 'alpha.json', makeIndexEnvelope(PROJECT_A), daysAgo(3));
    // Both spellings of a root name one project.
    const slashA = writeIndexEntry(h, 'bravo.json', makeIndexEnvelope(`${PROJECT_A}/`), daysAgo(2));
    const newestA = writeIndexEntry(h, 'charlie.json', makeIndexEnvelope(PROJECT_A), RECENT_AT);
    const onlyB = writeIndexEntry(h, 'delta.json', makeIndexEnvelope(PROJECT_B), daysAgo(5));

    const report = await sweep(h);

    expect(report.indexCachesDeleted).toBe(2);
    expect(present(olderA)).toBe(false);
    expect(present(slashA)).toBe(false);
    expect(present(newestA)).toBe(true);
    // A project's only entry is its newest one.
    expect(present(onlyB)).toBe(true);
    expect(report.errors).toEqual([]);

    // Nothing is superseded twice: an immediate second sweep finds nothing to do.
    expect((await sweep(h)).indexCachesDeleted).toBe(0);
  });

  it('breaks a tie in modification time by name, so exactly one entry of a project survives', async () => {
    const earlierName = writeIndexEntry(h, 'alpha.json', makeIndexEnvelope(PROJECT_A), RECENT_AT);
    const laterName = writeIndexEntry(h, 'bravo.json', makeIndexEnvelope(PROJECT_A), RECENT_AT);

    const report = await sweep(h);

    expect(report.indexCachesDeleted).toBe(1);
    expect(present(earlierName)).toBe(false);
    expect(present(laterName)).toBe(true);
  });

  it('leaves a document without the envelope shape, and one of a newer envelope version, to the age rule', async () => {
    const current = writeIndexEntry(h, 'alpha.json', makeIndexEnvelope(PROJECT_A), RECENT_AT);
    const older = daysAgo(2);
    const bare = writeIndexEntry(h, 'bravo.json', { index: { projectRoot: PROJECT_A } }, older);
    const topLevelRoot = writeIndexEntry(
      h,
      'charlie.json',
      { schemaVersion: INDEX_CACHE_SCHEMA_VERSION - 1, projectRoot: PROJECT_A },
      older,
    );
    const textVersion = writeIndexEntry(
      h,
      'delta.json',
      { schemaVersion: String(INDEX_CACHE_SCHEMA_VERSION - 1), index: { projectRoot: PROJECT_A } },
      older,
    );
    const rootless = writeIndexEntry(
      h,
      'echo.json',
      { schemaVersion: INDEX_CACHE_SCHEMA_VERSION - 1, index: {} },
      older,
    );
    const newer = writeIndexEntry(
      h,
      'foxtrot.json',
      makeIndexEnvelope(PROJECT_A, INDEX_CACHE_SCHEMA_VERSION + 1),
      older,
    );
    const agedNewer = writeIndexEntry(
      h,
      'golf.json',
      makeIndexEnvelope(PROJECT_B, INDEX_CACHE_SCHEMA_VERSION + 1),
      ANCIENT_AT,
    );

    const report = await sweep(h);

    // Only the age rule removed anything: the newer-version entry of an abandoned project.
    expect(report.indexCachesDeleted).toBe(1);
    expect(present(agedNewer)).toBe(false);
    for (const kept of [current, bare, topLevelRoot, textVersion, rootless, newer]) {
      expect(present(kept)).toBe(true);
    }
    expect(supersededRecords(h)).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('keeps an entry recording two projects until each of them has a newer entry', async () => {
    const mixed = writeIndexEntry(
      h,
      'alpha.json',
      makeIndexEnvelope(PROJECT_A, INDEX_CACHE_SCHEMA_VERSION, { projectRoot: PROJECT_B }),
      daysAgo(3),
    );
    writeIndexEntry(h, 'bravo.json', makeIndexEnvelope(PROJECT_A), RECENT_AT);

    const first = await sweep(h);

    // B's newest entry is still the mixed one, so no project loses its last cache.
    expect(first.indexCachesDeleted).toBe(0);
    expect(present(mixed)).toBe(true);

    writeIndexEntry(h, 'charlie.json', makeIndexEnvelope(PROJECT_B), RECENT_AT);
    const second = await sweep(h);

    expect(second.indexCachesDeleted).toBe(1);
    expect(present(mixed)).toBe(false);
    expect(indexEntryNames(h)).toEqual(['bravo.json', 'charlie.json']);
  });

  it('still ages out the newest entry of a project abandoned before the window, and keeps an active one', async () => {
    seedSession(h, { projectRoot: PROJECT_A, updatedAt: RECENT_AT });
    writeIndexEntry(h, 'alpha.json', makeIndexEnvelope(PROJECT_B), ANCIENT_AT);
    writeIndexEntry(h, 'bravo.json', makeIndexEnvelope(PROJECT_B), AGED_AT);
    writeIndexEntry(h, 'charlie.json', makeIndexEnvelope(PROJECT_A), ANCIENT_AT);

    const report = await sweep(h);

    // B's older entry was superseded and its newest aged out; A's is old but active.
    expect(report.indexCachesDeleted).toBe(2);
    expect(indexEntryNames(h)).toEqual(['charlie.json']);
    expect(supersededRecords(h).map((log) => log.fields['reason'])).toEqual(['superseded']);
    expect(report.errors).toEqual([]);
  });

  it('reports on a dry run exactly what the real sweep then removes, logging each entry by path and reason only', async () => {
    seedSession(h, { projectRoot: PROJECT_A, updatedAt: RECENT_AT });
    const legacy = writeIndexEntry(
      h,
      'alpha.json',
      makeIndexEnvelope(PROJECT_A, INDEX_CACHE_SCHEMA_VERSION - 1),
      RECENT_AT,
    );
    const older = writeIndexEntry(h, 'bravo.json', makeIndexEnvelope(PROJECT_A), daysAgo(2));
    const newest = writeIndexEntry(h, 'charlie.json', makeIndexEnvelope(PROJECT_A), RECENT_AT);
    const treeBefore = snapshotTree(h);

    const dry = await sweep(h, { dryRun: true });

    expect(snapshotTree(h)).toEqual(treeBefore);
    expect(dry.indexCachesDeleted).toBe(2);
    const records = supersededRecords(h);
    expect(records.map(({ level, fields }) => [level, fields['target'], fields['reason']])).toEqual(
      [
        ['debug', relativeToHome(h, legacy), 'older-envelope'],
        ['debug', relativeToHome(h, older), 'superseded'],
      ],
    );
    // A path relative to the state root and a reason: never the project the cache belongs to.
    expect(JSON.stringify(records)).not.toContain(PROJECT_A);

    const real = await sweep(h);

    expect(comparable(real)).toEqual(comparable(dry));
    expect(present(legacy)).toBe(false);
    expect(present(older)).toBe(false);
    expect(present(newest)).toBe(true);
  });

  it("removes only the scoped workspace's unreachable entries, leaving the rest to the machine-wide sweep", async () => {
    const legacyA = writeIndexEntry(
      h,
      'alpha.json',
      makeIndexEnvelope(PROJECT_A, INDEX_CACHE_SCHEMA_VERSION - 1),
      RECENT_AT,
    );
    const legacyB = writeIndexEntry(
      h,
      'bravo.json',
      makeIndexEnvelope(PROJECT_B, INDEX_CACHE_SCHEMA_VERSION - 1),
      RECENT_AT,
    );
    const olderA = writeIndexEntry(h, 'charlie.json', makeIndexEnvelope(PROJECT_A), daysAgo(2));
    const olderB = writeIndexEntry(h, 'delta.json', makeIndexEnvelope(PROJECT_B), daysAgo(2));
    const newestA = writeIndexEntry(h, 'echo.json', makeIndexEnvelope(PROJECT_A), RECENT_AT);
    const newestB = writeIndexEntry(h, 'foxtrot.json', makeIndexEnvelope(PROJECT_B), RECENT_AT);

    const scoped = await sweep(h, { scope: scopeOf(PROJECT_A) });

    expect(scoped.indexCachesDeleted).toBe(2);
    expect(present(legacyA)).toBe(false);
    expect(present(olderA)).toBe(false);
    for (const kept of [legacyB, olderB, newestA, newestB]) {
      expect(present(kept)).toBe(true);
    }
    // B's entries are not A's to remove, nor to log.
    expect(supersededRecords(h).map((log) => log.fields['target'])).toEqual([
      relativeToHome(h, legacyA),
      relativeToHome(h, olderA),
    ]);

    const machineWide = await sweep(h);

    expect(machineWide.indexCachesDeleted).toBe(2);
    expect(indexEntryNames(h)).toEqual(['echo.json', 'foxtrot.json']);
  });

  it('collapses the per-state files an older cache left to the one entry the current cache writes and serves', async () => {
    // A real project and a real entry written by `@debuggen/code-analysis`,
    // so the sweep is held to the envelope the cache actually writes.
    const projectRoot = join(h.root, 'workspace');
    writeDatedFile(join(projectRoot, FILE_ONE), 'export const one = 1;\n', RECENT_AT);
    const stats = lstatSync(join(projectRoot, FILE_ONE));
    const index: CodeIndex = {
      schemaVersion: CODE_INDEX_SCHEMA_VERSION,
      projectRoot,
      indexerVersion: INDEXER_VERSION,
      generatedAt: RECENT_AT,
      nodes: [],
      edges: [],
      files: [{ file: FILE_ONE, mtimeMs: stats.mtimeMs, size: stats.size }],
    };
    const keyInput: IndexCacheKeyInput = {
      projectRoot,
      indexerVersion: INDEXER_VERSION,
      extractors: ['alpha'],
      files: index.files,
    };
    const cache = createIndexCache({ cacheDir: h.indexCacheDir });
    expect(isErr(await cache.save(keyInput, index))).toBe(false);
    const written = indexEntryNames(h);
    expect(written).toHaveLength(1);
    const envelope = JSON.parse(
      readFileSync(join(h.indexCacheDir, written[0] ?? ''), 'utf8'),
    ) as unknown;
    expect(envelope).toMatchObject({
      schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
      index: { projectRoot },
    });

    // What the previous cache version left behind: one file per state of the
    // same project, every one of them recent, and the project in active use.
    seedSession(h, { projectRoot, updatedAt: RECENT_AT });
    const legacyStates = 26;
    for (let state = 0; state < legacyStates; state += 1) {
      writeIndexEntry(
        h,
        `${String(state).padStart(64, '0')}.json`,
        makeIndexEnvelope(projectRoot, INDEX_CACHE_SCHEMA_VERSION - 1),
        RECENT_AT + state * 1000,
      );
    }

    const report = await sweep(h);

    expect(report.indexCachesDeleted).toBe(legacyStates);
    expect(report.errors).toEqual([]);
    expect(indexEntryNames(h)).toEqual(written);
    // The entry the sweep kept is the one the cache reads: a hit, unchanged.
    expect(await cache.load(keyInput)).toEqual(index);
  });
});

/* -------------------------------------------------------------------------------------------------
 * A mixed sandbox: something for every rule to find
 * ---------------------------------------------------------------------------------------------- */

/** What {@link seedEveryRule} planted, for the assertions that follow a sweep. */
interface EveryRuleFixture {
  readonly agedIds: readonly SessionId[];
  readonly liveId: SessionId;
  readonly conflictId: SessionId;
  readonly orphan: string;
  readonly staleCache: string;
}

/**
 * Seeds one sandbox with work for every rule: two aged sessions with full
 * contents, one aged session held by a conflict, one live session, a stale
 * orphan in a directory whose session is gone, and a stale cache entry.
 *
 * Session ids are fixed and every digest is handed out in the same order, so
 * two sandboxes seeded by this function hold the same layout.
 */
async function seedEveryRule(harness: Harness): Promise<EveryRuleFixture> {
  const agedIds = [fixedSessionId('alpha'), fixedSessionId('bravo')];
  for (const id of agedIds) {
    await seedFullSession(harness, AGED_AT, { id, projectRoot: PROJECT_B });
  }
  const conflictId = fixedSessionId('charlie');
  await seedFullSession(
    harness,
    AGED_AT,
    { id: conflictId },
    { status: 'conflict', backupAt: ANCIENT_AT },
  );
  const liveId = fixedSessionId('delta');
  await seedFullSession(harness, RECENT_AT, { id: liveId, projectRoot: PROJECT_A });

  const orphan = writeLooseBackup(
    harness,
    fixedSessionId('ghost'),
    hashOf(harness, 'ghost:orphan'),
    ANCIENT_AT,
  );
  const staleCache = writeIndexEntry(
    harness,
    'stale.json',
    { index: { projectRoot: PROJECT_B } },
    ANCIENT_AT,
  );
  writeIndexEntry(harness, 'active.json', { index: { projectRoot: PROJECT_A } }, ANCIENT_AT);

  return { agedIds, liveId, conflictId, orphan, staleCache };
}

/* -------------------------------------------------------------------------------------------------
 * Dry run
 * ---------------------------------------------------------------------------------------------- */

describe('dry run', () => {
  it('reports exactly what the real sweep then removes, and removes nothing itself', async () => {
    const fixture = await seedEveryRule(h);
    const treeBefore = snapshotTree(h);
    const rowsBefore = tableTotals(h);

    const dry = await sweep(h, { dryRun: true });

    // Nothing moved: not a row, not a file, not a directory.
    expect(tableTotals(h)).toEqual(rowsBefore);
    expect(snapshotTree(h)).toEqual(treeBefore);
    // And yet the dry run found everything there was to find.
    expect(dry.sessionIdsDeleted).toEqual([...fixture.agedIds].sort());
    expect(dry.sessionsRetainedForConflicts).toEqual([fixture.conflictId]);
    expect(dry.orphanBackupsDeleted).toBe(1);
    expect(dry.indexCachesDeleted).toBe(1);

    const real = await sweep(h);

    expect(comparable(real)).toEqual(comparable(dry));
    // The real sweep did remove what the dry run reported.
    expect(snapshotTree(h)).not.toEqual(treeBefore);
    for (const id of fixture.agedIds) {
      expect(sessionExists(h, id)).toBe(false);
    }
    expect(present(fixture.orphan)).toBe(false);
    expect(present(fixture.staleCache)).toBe(false);
    expect(sessionExists(h, fixture.conflictId)).toBe(true);
    expect(sessionExists(h, fixture.liveId)).toBe(true);
  });

  it('never runs VACUUM or a checkpoint on a dry run, and completes a requested VACUUM cleanly otherwise', async () => {
    await seedFullSession(h, AGED_AT);
    const rowsBefore = tableTotals(h);

    const dry = await sweep(h, { dryRun: true, vacuum: true });
    expect(dry.errors).toEqual([]);
    expect(tableTotals(h)).toEqual(rowsBefore);

    const real = await sweep(h, { vacuum: true });
    expect(real.sessionsDeleted).toBe(1);
    expect(real.errors).toEqual([]);
    expect(tableTotals(h)).toMatchObject({ sessions: 0 });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Containment
 * ---------------------------------------------------------------------------------------------- */

describe('containment', () => {
  it('refuses a link planted as an aged session backup directory and never reaches its target', async () => {
    const { sessionId } = await seedFullSession(h, AGED_AT);
    // Swap the real backup directory for a link to a directory outside the
    // state root, holding a file the sweep must never delete.
    rmSync(join(h.backupsDir, sessionId), { recursive: true, force: true });
    const targetDirectory = join(h.outside, 'linked');
    const targetFile = join(targetDirectory, 'fileOne.txt');
    const targetBytes = writeDatedFile(targetFile, 'bytes outside the state root\n', ANCIENT_AT);
    const link = join(h.backupsDir, sessionId);
    symlinkSync(targetDirectory, link, 'dir');

    const report = await sweep(h);

    // The row is purged; the link is reported and left; its target is untouched.
    expect(report.sessionIdsDeleted).toEqual([sessionId]);
    expect(report.backupDirsDeleted).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetFile)).toEqual(targetBytes);
    expect(present(targetDirectory)).toBe(true);
    expect(issuesAt(report, 'backup', relativeToHome(h, link)).length).toBeGreaterThan(0);
    // Report targets and messages never spell a path outside the state root.
    expect(JSON.stringify(report)).not.toContain(h.outside);
    expect(JSON.stringify(report)).not.toContain(h.root);
  });

  it('refuses to remove a session directory holding a link, removing only the real orphans beside it', async () => {
    const { sessionId, contents } = await seedFullSession(h, AGED_AT, {}, { backupAt: ANCIENT_AT });
    const targetFile = join(h.outside, 'fileTwo.txt');
    const targetBytes = writeDatedFile(targetFile, 'bytes outside the state root\n', ANCIENT_AT);
    const link = join(h.backupsDir, sessionId, 'linked-file');
    symlinkSync(targetFile, link, 'file');

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([sessionId]);
    // Rule 1 kept the directory because of the link; the orphan rule then
    // removed the purged session's own (now unreferenced, stale) backup and
    // left the link, so the directory survives.
    expect(
      issuesAt(report, 'backup', relativeToHome(h, join(h.backupsDir, sessionId))),
    ).toHaveLength(1);
    expect(issuesAt(report, 'backup', relativeToHome(h, link))).toHaveLength(1);
    expect(present(contents.modification.backupPath)).toBe(false);
    expect(report.orphanBackupsDeleted).toBe(1);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(present(join(h.backupsDir, sessionId))).toBe(true);
    expect(readFileSync(targetFile)).toEqual(targetBytes);
  });

  it('never touches a sibling that shares the state directory name, nor what an index link points at', async () => {
    await seedEveryRule(h);
    // `isWithin` is lexical and treats `<home>-sibling` as outside `<home>`.
    const sibling = `${h.home}-sibling`;
    const siblingBytes = writeDatedFile(sibling, 'sibling bytes\n', ANCIENT_AT);
    const siblingDirectoryFile = join(`${h.backupsDir}-sibling`, 'fileOne.txt');
    const siblingDirectoryBytes = writeDatedFile(
      siblingDirectoryFile,
      'sibling bytes\n',
      ANCIENT_AT,
    );
    const indexTarget = join(h.outside, 'cache-target.json');
    const indexTargetBytes = writeDatedFile(indexTarget, '{}', ANCIENT_AT);
    const indexLink = join(h.indexCacheDir, 'linked.json');
    symlinkSync(indexTarget, indexLink, 'file');

    const report = await sweep(h);

    expect(readFileSync(sibling)).toEqual(siblingBytes);
    expect(readFileSync(siblingDirectoryFile)).toEqual(siblingDirectoryBytes);
    expect(readFileSync(indexTarget)).toEqual(indexTargetBytes);
    expect(lstatSync(indexLink).isSymbolicLink()).toBe(true);
    expect(issuesAt(report, 'index-cache', relativeToHome(h, indexLink))).toHaveLength(1);
    // The rest of the sweep still ran.
    expect(report.sessionsDeleted).toBe(2);
    expect(report.indexCachesDeleted).toBe(1);
  });

  it('answers CONFIG_INVALID, deleting nothing, for swept directories outside the state root', async () => {
    const { sessionId } = await seedFullSession(h, AGED_AT);
    const outsideFile = join(h.outside, 'fileOne.txt');
    const outsideBytes = writeDatedFile(outsideFile, 'outside\n', ANCIENT_AT);
    const treeBefore = snapshotTree(h);

    const cases: readonly RetentionDeps['config'][] = [
      { ...configOf(h), backupsDir: h.outside },
      { ...configOf(h), indexCacheDir: h.outside },
      { ...configOf(h), backupsDir: `${h.home}-sibling` },
      { ...configOf(h), backupsDir: h.home },
      { ...configOf(h), debuggenHome: '/' },
      { ...configOf(h), debuggenHome: 'relative/home' },
    ];
    for (const config of cases) {
      const result = await runRetention(depsOf(h, { config }));
      expect(isErr(result) ? result.error.code : 'ok').toBe('CONFIG_INVALID');
    }

    expect(sessionExists(h, sessionId)).toBe(true);
    expect(snapshotTree(h)).toEqual(treeBefore);
    expect(readFileSync(outsideFile)).toEqual(outsideBytes);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Resilience
 * ---------------------------------------------------------------------------------------------- */

describe('resilience', () => {
  // Root ignores directory permissions, so the refusal this test provokes
  // cannot be produced there; the test runs on every non-root POSIX host.
  it.skipIf(!CAN_DENY_WRITES)(
    'records a backup directory it cannot remove and still completes every other deletion',
    async () => {
      const stuck = await seedFullSession(h, AGED_AT, {}, { backupAt: ANCIENT_AT });
      const other = await seedFullSession(h, AGED_AT, {}, { backupAt: ANCIENT_AT });
      const staleCache = writeIndexEntry(h, 'stale.json', {}, ANCIENT_AT);
      const stuckDirectory = join(h.backupsDir, stuck.sessionId);
      chmodSync(stuckDirectory, 0o500);

      try {
        const result = await runRetention(depsOf(h));
        expect(isErr(result)).toBe(false);
        if (isErr(result)) {
          return;
        }
        const report = result.value;

        expect(report.sessionIdsDeleted).toEqual([stuck.sessionId, other.sessionId].sort());
        expect(issuesAt(report, 'backup', relativeToHome(h, stuckDirectory))).toHaveLength(1);
        expect(present(stuck.contents.modification.backupPath)).toBe(true);
        // Every other candidate still went.
        expect(present(join(h.backupsDir, other.sessionId))).toBe(false);
        expect(present(staleCache)).toBe(false);
        expect(report.indexCachesDeleted).toBe(1);
      } finally {
        chmodSync(stuckDirectory, SECURE_DIR_MODE);
      }
    },
  );

  it('answers STORE_ERROR, deleting nothing, when the store is closed', async () => {
    await seedFullSession(h, AGED_AT);
    writeLooseBackup(h, fixedSessionId('ghost'), hashOf(h, 'ghost'), ANCIENT_AT);
    const treeBefore = snapshotTree(h);
    h.store.close();

    const result = await runRetention(depsOf(h));

    expect(isErr(result) ? result.error.code : 'ok').toBe('STORE_ERROR');
    expect(snapshotTree(h)).toEqual(treeBefore);
  });

  it('answers CONFIG_INVALID for an unusable window override or clock', async () => {
    const aged = seedSession(h, { updatedAt: AGED_AT });
    const refusals: readonly [RetentionOptions, Partial<RetentionDeps>][] = [
      [{ retentionDays: -1 }, {}],
      [{ retentionDays: Number.NaN }, {}],
      [{ orphanBackupGraceDays: Number.POSITIVE_INFINITY }, {}],
      [{}, { now: () => Number.NaN }],
      [
        {},
        {
          now: () => {
            throw new Error('the clock is unavailable');
          },
        },
      ],
    ];

    for (const [options, overrides] of refusals) {
      const result = await runRetention(depsOf(h, overrides), options);
      expect(isErr(result) ? result.error.code : 'ok').toBe('CONFIG_INVALID');
    }
    expect(sessionExists(h, aged)).toBe(true);
  });

  it('answers CONFIG_INVALID, deleting nothing, for a signal that is not an AbortSignal', async () => {
    const aged = seedSession(h, { updatedAt: AGED_AT });
    const signal = { aborted: 'yes' } as unknown as AbortSignal;

    const result = await runRetention(depsOf(h), { signal });

    expect(isErr(result) ? result.error.code : 'ok').toBe('CONFIG_INVALID');
    expect(sessionExists(h, aged)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Interruption
 * ---------------------------------------------------------------------------------------------- */

/** The `info` records of the sweep's first interrupted step boundary. */
function interruptions(harness: Harness): CapturedLog[] {
  return harness.logs.filter(
    (log) => log.message === 'retention sweep interrupted; the next sweep carries on from here',
  );
}

/** The fields of the sweep's closing summary record, which must be logged exactly once. */
function finishedFields(harness: Harness): LogFields {
  const finished = harness.logs.filter((log) => log.message === 'retention sweep finished');
  expect(finished).toHaveLength(1);
  return finished[0]?.fields ?? {};
}

describe('interruption', () => {
  it('answers Ok with interrupted set, and touches nothing, when its signal is aborted before it starts', async () => {
    const fixture = await seedEveryRule(h);
    const rowsBefore = tableTotals(h);
    const treeBefore = snapshotTree(h);
    const observed = observeStore(h.store);
    const controller = new AbortController();
    controller.abort();

    const result = await runRetention(depsOf(h, { store: observed.store }), {
      signal: controller.signal,
    });

    expect(isErr(result)).toBe(false);
    const report = unwrap(result);
    expect(report).toMatchObject({
      interrupted: true,
      sessionsDeleted: 0,
      telemetryEventsDeleted: 0,
      backupDirsDeleted: 0,
      orphanBackupsDeleted: 0,
      indexCachesDeleted: 0,
      bytesReclaimed: 0,
      errors: [],
    });
    // Not a transaction, not a probe, not a checkpoint.
    expect(observed.calls).toEqual({ transactions: 0, checkpoints: 0, referenceRowsRead: 0 });
    expect(tableTotals(h)).toEqual(rowsBefore);
    expect(snapshotTree(h)).toEqual(treeBefore);
    expect(interruptions(h).map((log) => log.fields['at'])).toEqual(['candidate-page']);
    expect(finishedFields(h)).toMatchObject({ interrupted: true, sessionsDeleted: 0 });

    // An uninterrupted sweep then does all of it.
    const resumed = await sweep(h);

    expect(resumed.interrupted).toBe(false);
    expect(resumed.sessionIdsDeleted).toEqual([...fixture.agedIds].sort());
    expect(present(fixture.orphan)).toBe(false);
    expect(present(fixture.staleCache)).toBe(false);
  });

  it('stops before the next session once aborted mid-sweep, runs no reclaim, and leaves the rest to the next sweep', async () => {
    const fixture = await seedEveryRule(h);
    const [first, second] = fixture.agedIds;
    const observed = observeStore(h.store);
    const controller = new AbortController();

    const report = await sweep(
      h,
      { signal: controller.signal },
      {
        store: observed.store,
        onSessionDeleted: () => {
          controller.abort();
        },
      },
    );

    expect(report.interrupted).toBe(true);
    expect(report.sessionsDeleted).toBe(1);
    expect(report.sessionIdsDeleted).toEqual([first]);
    expect(report.errors).toEqual([]);
    expect(sessionExists(h, second ?? fixedSessionId('missing'))).toBe(true);
    // Nothing after the boundary ran: no backup directory, orphan or cache
    // was removed, and neither the checkpoint nor any other reclaim ran.
    expect(report.backupDirsDeleted).toBe(0);
    expect(report.orphanBackupsDeleted).toBe(0);
    expect(report.indexCachesDeleted).toBe(0);
    expect(present(join(h.backupsDir, first ?? 'missing'))).toBe(true);
    expect(present(fixture.orphan)).toBe(true);
    expect(present(fixture.staleCache)).toBe(true);
    expect(observed.calls.checkpoints).toBe(0);
    expect(interruptions(h).map((log) => log.fields['at'])).toEqual(['session']);
    expect(finishedFields(h)).toMatchObject({ interrupted: true, sessionsDeleted: 1 });

    const resumed = await sweep(h);

    expect(resumed.interrupted).toBe(false);
    expect(resumed.sessionIdsDeleted).toEqual([second]);
    // The interrupted sweep's first session left its backups behind without a
    // row; they are orphans now, and the orphan rule removes them.
    expect(present(join(h.backupsDir, first ?? 'missing'))).toBe(false);
    expect(present(fixture.orphan)).toBe(false);
    expect(present(fixture.staleCache)).toBe(false);
    expect(resumed.errors).toEqual([]);
  });

  it(
    'stops between drain batches once aborted, keeping the large session for the next sweep',
    async () => {
      const { sessionId, contents } = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, sessionId, AGED_AT, LARGE_TELEMETRY);
      const rowsBefore = scopedCounts(h, sessionId);
      const observed = observeStore(h.store);
      const controller = new AbortController();

      // Asked inside the first drain transaction: the abort lands mid-drain.
      const report = await sweep(
        h,
        { signal: controller.signal },
        {
          store: observed.store,
          isSessionInUse: () => {
            controller.abort();
            return false;
          },
        },
      );

      expect(report.interrupted).toBe(true);
      expect(report.sessionsDeleted).toBe(0);
      expect(report.telemetryEventsDeleted).toBe(DEFAULT_PURGE_BATCH_SIZE);
      expect(report.errors).toEqual([]);
      expect(observed.calls).toMatchObject({ transactions: 1, checkpoints: 0 });
      expect(sessionExists(h, sessionId)).toBe(true);
      expect(rowsFor(h, 'telemetry_events', sessionId)).toBe(
        rowsBefore.telemetry_events - DEFAULT_PURGE_BATCH_SIZE,
      );
      expect(evidenceBesideTelemetry(h, sessionId)).toEqual({ ...rowsBefore, telemetry_events: 0 });
      expect(present(contents.modification.backupPath)).toBe(true);
      // The sweep was stopped, not the session: reported at `info`, and never
      // as a session that stopped being eligible.
      expect(drainStops(h)).toEqual([]);
      expect(
        h.logs
          .filter(
            (log) =>
              log.message ===
              'the purge of a large session stopped part-way because the sweep was stopped; the next sweep carries on with it',
          )
          .map((log) => [log.level, log.fields]),
      ).toEqual([
        [
          'info',
          expect.objectContaining({
            sessionId,
            outcome: 'interrupted',
            drainedEvents: DEFAULT_PURGE_BATCH_SIZE,
          }),
        ],
      ]);
      expect(interruptions(h).map((log) => log.fields['at'])).toEqual(['drain-batch']);

      const resumed = await sweep(h);

      expect(resumed.interrupted).toBe(false);
      expect(resumed.sessionIdsDeleted).toEqual([sessionId]);
      expect(resumed.telemetryEventsDeleted).toBe(
        rowsBefore.telemetry_events - DEFAULT_PURGE_BATCH_SIZE,
      );
      expectNoRowsLeft(h, sessionId);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );
});

/* -------------------------------------------------------------------------------------------------
 * Returning database space to the filesystem
 * ---------------------------------------------------------------------------------------------- */

/** A store's space, as the four pragmas the reclaim reads report it. */
interface SpaceReading {
  readonly autoVacuum: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
}

/** SQLite's number for each auto-vacuum mode a test establishes, by its pragma name. */
const AUTO_VACUUM = { NONE: 0, INCREMENTAL: 2 } as const;

/** The sandbox store's space, read straight from its connection. */
function databaseSpace(harness: Harness): SpaceReading {
  const read = (sql: string, column: string): number => {
    const value = harness.store.db.prepare(sql).get()?.[column];
    if (typeof value !== 'number') {
      throw new Error(`${sql} answered no numeric ${column} column`);
    }
    return value;
  };
  return {
    autoVacuum: read('PRAGMA auto_vacuum', 'auto_vacuum'),
    pageSize: read('PRAGMA page_size', 'page_size'),
    pageCount: read('PRAGMA page_count', 'page_count'),
    freelistCount: read('PRAGMA freelist_count', 'freelist_count'),
  };
}

/**
 * Puts the sandbox store in `mode` before anything is seeded — `PRAGMA
 * auto_vacuum`, then `VACUUM`, the one way an existing database changes mode —
 * so each reclaim test holds whatever mode `openStore` gives a new store.
 */
function establishAutoVacuum(harness: Harness, mode: keyof typeof AUTO_VACUUM): void {
  harness.store.db.exec(`PRAGMA auto_vacuum = ${mode}; VACUUM;`);
  expect(databaseSpace(harness).autoVacuum).toBe(AUTO_VACUUM[mode]);
}

/** The size on disk of the sandbox's database file, its write-ahead log aside. */
function databaseFileSize(harness: Harness): number {
  return statSync(join(harness.home, 'sessions.sqlite')).size;
}

/**
 * Checkpoints the store and reads its space — the baseline a reclaim test
 * measures against — proving the file on disk is exactly its pages.
 */
function settledSpace(harness: Harness): SpaceReading {
  harness.store.checkpoint();
  const space = databaseSpace(harness);
  expect(databaseFileSize(harness)).toBe(space.pageCount * space.pageSize);
  return space;
}

/** Whether `sql` is the reclaim's incremental step. */
function isIncrementalStep(sql: string): boolean {
  return sql.startsWith('PRAGMA incremental_vacuum(');
}

/**
 * A store that forwards everything to the sandbox's and records, for each
 * incremental reclaim step the sweep runs through it, how many pages the step
 * released — the freelist read from the connection before and after.
 */
function observeVacuumSteps(harness: Harness): {
  readonly store: Store;
  readonly released: number[];
} {
  const released: number[] = [];
  const forward = <T extends object>(target: T, key: PropertyKey): unknown => {
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  };
  const store = new Proxy(harness.store, {
    get(target, key): unknown {
      if (key !== 'statement') {
        return forward(target, key);
      }
      return (sql: string): StatementSync => {
        const statement = target.statement(sql);
        if (!isIncrementalStep(sql)) {
          return statement;
        }
        return new Proxy(statement, {
          get(inner, member): unknown {
            if (member !== 'all') {
              return forward(inner, member);
            }
            return (...args: SQLInputValue[]): Record<string, SQLOutputValue>[] => {
              const before = databaseSpace(harness).freelistCount;
              const rows = inner.all(...args);
              released.push(before - databaseSpace(harness).freelistCount);
              return rows;
            };
          },
        });
      };
    },
  });
  return { store, released };
}

/** The records a reclaim logged under `message`, from the log index `from` on. */
function reclaimLogs(harness: Harness, message: string, from = 0): CapturedLog[] {
  return harness.logs.slice(from).filter((log) => log.message === message);
}

/** The `info` record of a store without auto-vacuum whose conversion a gate refused. */
const PAGES_STAY_REUSABLE =
  'the purged database pages stay reusable; the store file keeps its size';

/** The `info` record of a store without auto-vacuum the reclaim converted. */
const STORE_CONVERTED = 'converted the session store to incremental auto-vacuum and compacted it';

describe('returning database space to the filesystem', () => {
  it('documents the reclaim step and the conversion gates', () => {
    expect(INCREMENTAL_VACUUM_STEP_PAGES).toBe(2_048);
    expect(VACUUM_CONVERSION_MIN_FREE_SHARE).toBe(0.25);
    expect(VACUUM_CONVERSION_MIN_FREE_BYTES).toBe(8 * 1024 * 1024);
    expect(VACUUM_CONVERSION_MAX_LIVE_BYTES).toBe(256 * 1024 * 1024);
  });

  it(
    'returns the pages a purge freed in bounded steps on an incremental store, and reports the real shrink',
    async () => {
      establishAutoVacuum(h, 'INCREMENTAL');
      const live = await seedFullSession(h, RECENT_AT);
      const aged = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, aged.sessionId, AGED_AT, 2 * DEFAULT_PURGE_BATCH_SIZE + 25);
      const before = settledSpace(h);
      expect(before.freelistCount).toBe(0);
      const steps = observeVacuumSteps(h);
      const observed = observeStore(steps.store);

      const report = await sweep(h, {}, { store: observed.store });

      const after = databaseSpace(h);
      const releasedPages = before.pageCount - after.pageCount;
      expect(report.sessionIdsDeleted).toEqual([aged.sessionId]);
      expect(report.errors).toEqual([]);
      expect(after).toMatchObject({ autoVacuum: AUTO_VACUUM.INCREMENTAL, freelistCount: 0 });
      // More than one step's worth was freed, so it went in several bounded
      // steps, each of which made progress.
      expect(releasedPages).toBeGreaterThan(INCREMENTAL_VACUUM_STEP_PAGES);
      expect(steps.released.length).toBeGreaterThan(1);
      expect(Math.max(...steps.released)).toBeLessThanOrEqual(INCREMENTAL_VACUUM_STEP_PAGES);
      expect(steps.released.every((pages) => pages > 0)).toBe(true);
      // The report states the real shrink, and the checkpoint put it on disk.
      expect(report.databaseBytesReclaimed).toBe(releasedPages * before.pageSize);
      expect(report.bytesReclaimed).toBe(
        aged.contents.modification.bytes.length + releasedPages * before.pageSize,
      );
      expect(observed.calls.checkpoints).toBe(1);
      expect(databaseFileSize(h)).toBe(after.pageCount * after.pageSize);
      expect(finishedFields(h)).toMatchObject({
        bytesReclaimed: report.bytesReclaimed,
        databaseBytesReclaimed: report.databaseBytesReclaimed,
        interrupted: false,
      });
      expect(sessionExists(h, live.sessionId)).toBe(true);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'converts a store without auto-vacuum once, compacting it, and releases incrementally from then on',
    async () => {
      establishAutoVacuum(h, 'NONE');
      const live = await seedFullSession(h, RECENT_AT);
      const aged = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, aged.sessionId, AGED_AT, LARGE_TELEMETRY);
      const before = settledSpace(h);
      const steps = observeVacuumSteps(h);
      const observed = observeStore(steps.store);

      // This purge frees less than the default minimum, which the call waives.
      const report = await sweep(h, { reclaim: { minFreeBytes: 0 } }, { store: observed.store });

      const after = databaseSpace(h);
      expect(report.sessionIdsDeleted).toEqual([aged.sessionId]);
      expect(report.errors).toEqual([]);
      expect(after).toMatchObject({ autoVacuum: AUTO_VACUUM.INCREMENTAL, freelistCount: 0 });
      expect(after.pageCount).toBeLessThan(before.pageCount);
      expect(report.databaseBytesReclaimed).toBe(
        (before.pageCount - after.pageCount) * before.pageSize,
      );
      expect(fileBytesReclaimed(report)).toBe(aged.contents.modification.bytes.length);
      expect(steps.released).toEqual([]);
      expect(observed.calls.checkpoints).toBe(1);
      expect(databaseFileSize(h)).toBe(after.pageCount * after.pageSize);
      expect(reclaimLogs(h, STORE_CONVERTED)).toHaveLength(1);
      expect(sessionExists(h, live.sessionId)).toBe(true);

      // Converted once: the next purge, under the default gates, takes the
      // incremental path and converts nothing.
      const next = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, next.sessionId, AGED_AT, LARGE_TELEMETRY);
      const beforeNext = settledSpace(h);
      const nextSteps = observeVacuumSteps(h);

      const again = await sweep(h, {}, { store: nextSteps.store });

      const afterNext = databaseSpace(h);
      expect(again.sessionIdsDeleted).toEqual([next.sessionId]);
      expect(again.errors).toEqual([]);
      expect(nextSteps.released.length).toBeGreaterThan(0);
      expect(afterNext.freelistCount).toBe(0);
      expect(again.databaseBytesReclaimed).toBe(
        (beforeNext.pageCount - afterNext.pageCount) * beforeNext.pageSize,
      );
      expect(again.databaseBytesReclaimed).toBeGreaterThan(0);
      expect(reclaimLogs(h, STORE_CONVERTED)).toHaveLength(1);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'keeps the freed pages reusable on a store without auto-vacuum when a conversion gate fails, and logs which',
    async () => {
      establishAutoVacuum(h, 'NONE');
      await seedFullSession(h, RECENT_AT);
      // The defaults first, while one purge's pages are all the store has
      // free: a thousand events dominate the store, so the free share passes,
      // and they free far less than the minimum.
      const cases: readonly (readonly [RetentionReclaimTuning | undefined, string])[] = [
        [undefined, 'free-bytes-below-minimum'],
        [{ minFreeShare: 1, minFreeBytes: 0 }, 'free-share-below-threshold'],
        [{ minFreeShare: 0, minFreeBytes: 0, maxLiveBytes: 0 }, 'live-bytes-above-cap'],
      ];

      for (const [reclaim, reason] of cases) {
        const aged = seedSession(h, { updatedAt: AGED_AT });
        seedTelemetry(h, aged, AGED_AT, TELEMETRY_SEED_CHUNK);
        const before = settledSpace(h);
        const observed = observeStore(h.store);
        const mark = h.logs.length;

        const report = await sweep(h, { reclaim }, { store: observed.store });

        const after = databaseSpace(h);
        expect(report.sessionIdsDeleted).toEqual([aged]);
        expect(report.errors).toEqual([]);
        expect(report.databaseBytesReclaimed).toBe(0);
        expect(report.bytesReclaimed).toBe(0);
        expect(after.autoVacuum).toBe(AUTO_VACUUM.NONE);
        expect(after.pageCount).toBe(before.pageCount);
        expect(after.freelistCount).toBeGreaterThan(before.freelistCount);
        // The write-ahead log is still folded back.
        expect(observed.calls.checkpoints).toBe(1);
        expect(
          reclaimLogs(h, PAGES_STAY_REUSABLE, mark).map((log) => log.fields['reason']),
        ).toEqual([reason]);
        expect(reclaimLogs(h, STORE_CONVERTED, mark)).toEqual([]);
      }
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'runs no reclaim in a dry run or once interrupted, and the next sweep returns what was left',
    async () => {
      establishAutoVacuum(h, 'INCREMENTAL');
      const first = seedSession(h, { updatedAt: AGED_AT });
      seedTelemetry(h, first, AGED_AT, TELEMETRY_SEED_CHUNK);
      const second = seedSession(h, { updatedAt: AGED_AT + DAY_MS });
      seedTelemetry(h, second, AGED_AT + DAY_MS, TELEMETRY_SEED_CHUNK);
      const before = settledSpace(h);

      const dry = await sweep(h, { dryRun: true });

      expect(dry.sessionIdsDeleted).toEqual([first, second].sort());
      expect(dry.databaseBytesReclaimed).toBe(0);
      expect(databaseSpace(h)).toEqual(before);

      const controller = new AbortController();
      const steps = observeVacuumSteps(h);
      const observed = observeStore(steps.store);
      const interrupted = await sweep(
        h,
        { signal: controller.signal },
        {
          store: observed.store,
          onSessionDeleted: () => {
            controller.abort();
          },
        },
      );

      const left = databaseSpace(h);
      expect(interrupted).toMatchObject({
        interrupted: true,
        sessionIdsDeleted: [first],
        databaseBytesReclaimed: 0,
        bytesReclaimed: 0,
        errors: [],
      });
      expect(steps.released).toEqual([]);
      expect(observed.calls.checkpoints).toBe(0);
      expect(left.pageCount).toBe(before.pageCount);
      expect(left.freelistCount).toBeGreaterThan(0);

      const resumed = await sweep(h);

      const after = databaseSpace(h);
      expect(resumed.sessionIdsDeleted).toEqual([second]);
      expect(resumed.interrupted).toBe(false);
      expect(after.freelistCount).toBe(0);
      // The resumed sweep's shrink includes the pages the interrupted one freed.
      expect(resumed.databaseBytesReclaimed).toBe(
        (left.pageCount - after.pageCount) * left.pageSize,
      );
      expect(after.pageCount).toBeLessThan(before.pageCount - left.freelistCount);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it('sets incremental auto-vacuum before a requested VACUUM, so the rewrite converts the store', async () => {
    establishAutoVacuum(h, 'NONE');
    const aged = await seedFullSession(h, AGED_AT);
    const before = settledSpace(h);
    const observed = observeStore(h.store);

    const report = await sweep(h, { vacuum: true }, { store: observed.store });

    const after = databaseSpace(h);
    expect(report.sessionIdsDeleted).toEqual([aged.sessionId]);
    expect(report.errors).toEqual([]);
    expect(after).toMatchObject({ autoVacuum: AUTO_VACUUM.INCREMENTAL, freelistCount: 0 });
    expect(report.databaseBytesReclaimed).toBe(
      Math.max(0, (before.pageCount - after.pageCount) * before.pageSize),
    );
    expect(observed.calls.checkpoints).toBe(1);
    expect(databaseFileSize(h)).toBe(after.pageCount * after.pageSize);
  });

  it(
    'records a reclaim step that fails as a database issue, never an Err, and still checkpoints',
    async () => {
      establishAutoVacuum(h, 'INCREMENTAL');
      const aged = seedSession(h, { updatedAt: AGED_AT });
      seedTelemetry(h, aged, AGED_AT, TELEMETRY_SEED_CHUNK);
      const failingStep = new Proxy(h.store, {
        get(target, key): unknown {
          if (key === 'statement') {
            return (sql: string): StatementSync => {
              const statement = target.statement(sql);
              if (!isIncrementalStep(sql)) {
                return statement;
              }
              return new Proxy(statement, {
                get(inner, member): unknown {
                  if (member === 'all') {
                    return (): never => {
                      throw new Error(SENTINEL);
                    };
                  }
                  const value: unknown = Reflect.get(inner, member);
                  return typeof value === 'function'
                    ? (value as (...args: unknown[]) => unknown).bind(inner)
                    : value;
                },
              });
            };
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const observed = observeStore(failingStep);

      const report = await sweep(h, {}, { store: observed.store });

      expect(report.sessionIdsDeleted).toEqual([aged]);
      expect(report.errors.map(({ scope, target }) => ({ scope, target }))).toEqual([
        { scope: 'database', target: 'incremental_vacuum' },
      ]);
      expect(report.databaseBytesReclaimed).toBe(0);
      expect(databaseSpace(h).freelistCount).toBeGreaterThan(0);
      expect(observed.calls.checkpoints).toBe(1);
      expect(JSON.stringify(report)).not.toContain(SENTINEL);
      expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);

      // A store without auto-vacuum whose conversion meets an open transaction.
      const other = createHarness();
      establishAutoVacuum(other, 'NONE');
      const otherAged = seedSession(other, { updatedAt: AGED_AT });
      seedTelemetry(other, otherAged, AGED_AT, TELEMETRY_SEED_CHUNK);
      const busyDb = new Proxy(other.store.db, {
        get(target, key): unknown {
          if (key === 'isTransaction') {
            return true;
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const busyStore = new Proxy(other.store, {
        get(target, key): unknown {
          if (key === 'db') {
            return busyDb;
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });

      const refused = await sweep(other, { reclaim: { minFreeBytes: 0 } }, { store: busyStore });

      expect(refused.sessionIdsDeleted).toEqual([otherAged]);
      expect(refused.errors.map(({ scope, target }) => ({ scope, target }))).toEqual([
        { scope: 'database', target: 'auto_vacuum' },
      ]);
      expect(databaseSpace(other).autoVacuum).toBe(AUTO_VACUUM.NONE);
      expect(refused.databaseBytesReclaimed).toBe(0);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it('answers CONFIG_INVALID, deleting nothing, for reclaim gates it cannot use', async () => {
    const aged = seedSession(h, { updatedAt: AGED_AT });
    const refusals: readonly RetentionReclaimTuning[] = [
      { minFreeShare: 1.5 },
      { minFreeShare: -0.1 },
      { minFreeShare: Number.NaN },
      { minFreeBytes: -1 },
      { minFreeBytes: Number.POSITIVE_INFINITY },
      { maxLiveBytes: Number.NaN },
      'every gate' as unknown as RetentionReclaimTuning,
    ];

    for (const reclaim of refusals) {
      const result = await runRetention(depsOf(h), { reclaim });
      expect(isErr(result) ? result.error.code : 'ok').toBe('CONFIG_INVALID');
    }
    expect(sessionExists(h, aged)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Windows and constants
 * ---------------------------------------------------------------------------------------------- */

describe('windows and constants', () => {
  it('documents a seven-day orphan grace and a thirty-day default window (AAP 0.4.2, 0.3.4)', () => {
    expect(ORPHAN_BACKUP_GRACE_DAYS).toBe(7);
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
  });

  it('purges on the configured default window, measured in whole days from now', async () => {
    const inside = seedSession(h, { updatedAt: daysAgo(DEFAULT_RETENTION_DAYS - 1) });
    const outside = seedSession(h, { updatedAt: daysAgo(DEFAULT_RETENTION_DAYS + 1) });

    const report = await sweep(h);

    expect(report.cutoff).toBe(NOW - DEFAULT_RETENTION_DAYS * DAY_MS);
    expect(report.sessionIdsDeleted).toEqual([outside]);
    expect(sessionExists(h, inside)).toBe(true);
  });

  it('falls back to the documented default, keeping more rather than less, when the configured window is unusable', async () => {
    const inside = seedSession(h, { updatedAt: daysAgo(DEFAULT_RETENTION_DAYS - 1) });

    const report = await sweep(h, {}, { config: { ...configOf(h), retentionDays: Number.NaN } });

    expect(report.cutoff).toBe(DEFAULT_CUTOFF);
    expect(sessionExists(h, inside)).toBe(true);
    expect(
      h.logs.some(
        (log) => log.level === 'warn' && log.fields['defaultDays'] === DEFAULT_RETENTION_DAYS,
      ),
    ).toBe(true);
  });

  it('lets one call override the window and the grace', async () => {
    const yesterday = seedSession(h, { updatedAt: RECENT_AT });
    const orphan = writeLooseBackup(h, fixedSessionId('ghost'), hashOf(h, 'ghost'), daysAgo(1));

    const kept = await sweep(h);
    expect(kept.sessionsDeleted).toBe(0);
    expect(present(orphan)).toBe(true);

    const purged = await sweep(h, { retentionDays: 0, orphanBackupGraceDays: 0 });

    expect(purged.cutoff).toBe(NOW);
    expect(purged.sessionIdsDeleted).toEqual([yesterday]);
    expect(purged.orphanBackupsDeleted).toBe(1);
    expect(present(orphan)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Bounded work
 * ---------------------------------------------------------------------------------------------- */

/** What {@link observeStore} records of the sweep's own use of the store. */
interface ObservedStore {
  /** A store that forwards everything to the real one. */
  readonly store: Store;
  /** Every SQL text the sweep prepared through it, in order. */
  readonly prepared: string[];
  /**
   * How many transactions and checkpoints the sweep asked it for, and how many
   * journal rows its backup-reference probes read.
   */
  readonly calls: { transactions: number; checkpoints: number; referenceRowsRead: number };
}

/**
 * Wraps a store so the calls the sweep makes on it directly — its journal
 * probes and the rows they read, its per-session transactions, its checkpoint
 * — are recorded. The repositories keep the real store, so only the sweep's
 * own access is seen.
 */
function observeStore(store: Store): ObservedStore {
  const prepared: string[] = [];
  const calls = { transactions: 0, checkpoints: 0, referenceRowsRead: 0 };
  const forward = <T extends object>(target: T, key: PropertyKey): unknown => {
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  };
  const countRows = (statement: StatementSync): StatementSync =>
    new Proxy(statement, {
      get(target, key): unknown {
        if (key === 'iterate') {
          return function* (...args: SQLInputValue[]): Generator<Record<string, SQLOutputValue>> {
            for (const row of target.iterate(...args)) {
              calls.referenceRowsRead += 1;
              yield row;
            }
          };
        }
        return forward(target, key);
      },
    });
  const observed = new Proxy(store, {
    get(target, key): unknown {
      if (key === 'statement') {
        return (sql: string): StatementSync => {
          prepared.push(sql);
          const statement = target.statement(sql);
          return sql === SELECT_SESSION_BACKUP_REFERENCES_SQL ? countRows(statement) : statement;
        };
      }
      if (key === 'transaction') {
        return <T>(fn: () => T): T => {
          calls.transactions += 1;
          return target.transaction(fn);
        };
      }
      if (key === 'checkpoint') {
        return (): void => {
          calls.checkpoints += 1;
          target.checkpoint();
        };
      }
      return forward(target, key);
    },
  });
  return { store: observed, prepared, calls };
}

/** How many journal probes the sweep ran through an observed store. */
function probesOf(observed: ObservedStore): number {
  return observed.prepared.filter((sql) => sql === SELECT_SESSION_BACKUP_REFERENCES_SQL).length;
}

/**
 * Journals `count` reverted records for `sessionId` straight into the table —
 * an unrelated live journal the probes must never read. Their backups are not
 * written: only the rows matter here.
 */
function seedUnrelatedJournal(harness: Harness, sessionId: SessionId, count: number): void {
  const insert = harness.store.statement(
    `INSERT INTO modifications (id, session_id, plan_version, file, original_hash, backup_path,
       instrumented_hash, applied_at, updated_at, status, diff)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'reverted', '')`,
  );
  const before = rowsFor(harness, 'modifications', sessionId);
  harness.store.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const originalHash = hashOf(harness, `bulk:original:${String(index)}`);
      insert.run(
        `mod_bulk_${String(index).padStart(6, '0')}`,
        sessionId,
        `src/bulk/file-${String(index)}.ts`,
        originalHash,
        join(harness.backupsDir, sessionId, originalHash),
        hashOf(harness, `bulk:instrumented:${String(index)}`),
        RECENT_AT,
        RECENT_AT,
      );
    }
  });
  expect(rowsFor(harness, 'modifications', sessionId)).toBe(before + count);
}

/** The details of SQLite's plan for `sql`, bound to `args`. */
function planOf(harness: Harness, sql: string, ...args: SQLInputValue[]): string[] {
  return harness.store.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => String(row['detail']));
}

describe('bounded work', () => {
  it('reads every candidate page and every backup probe from an index, with no sort or scan', () => {
    const plans = [
      planOf(h, SELECT_RETENTION_CANDIDATES_SQL, NOW, RETENTION_CANDIDATE_PAGE_SIZE),
      planOf(
        h,
        SELECT_RETENTION_CANDIDATES_AFTER_SQL,
        NOW,
        AGED_AT,
        1,
        RETENTION_CANDIDATE_PAGE_SIZE,
      ),
      planOf(h, SELECT_SESSION_BACKUP_REFERENCES_SQL, fixedSessionId('plan')),
    ];

    for (const plan of plans) {
      expect(plan.length).toBeGreaterThan(0);
      for (const detail of plan) {
        expect(detail).toMatch(/^SEARCH \w+ USING (COVERING )?INDEX /);
        expect(detail).not.toContain('TEMP B-TREE');
      }
    }
    expect(plans[0]?.[0]).toContain('idx_sessions_updated_at');
    expect(plans[1]?.[0]).toContain('idx_sessions_updated_at');
  });

  it('probes whether a session outgrows one purge batch through a bounded index read, never a scan', () => {
    const plan = planOf(
      h,
      SESSION_TELEMETRY_PROBE_SQL,
      fixedSessionId('plan'),
      DEFAULT_PURGE_BATCH_SIZE + 1,
    );

    expect(
      plan.some((detail) => /^SEARCH telemetry_events USING COVERING INDEX /.test(detail)),
    ).toBe(true);
    for (const detail of plan) {
      expect(detail).not.toMatch(/^SCAN telemetry_events\b/);
      expect(detail).not.toContain('TEMP B-TREE');
    }
  });

  it(
    'answers the probe with the event count up to one batch, and one past it beyond',
    () => {
      const small = seedSession(h, { updatedAt: AGED_AT });
      seedTelemetry(h, small, AGED_AT, 7);
      const large = seedSession(h, { updatedAt: AGED_AT });
      seedTelemetry(h, large, AGED_AT, DEFAULT_PURGE_BATCH_SIZE + 3);
      const probe = (sessionId: SessionId): unknown =>
        h.store
          .statement(SESSION_TELEMETRY_PROBE_SQL)
          .get(sessionId, DEFAULT_PURGE_BATCH_SIZE + 1)?.['events'];

      expect(probe(small)).toBe(7);
      expect(probe(large)).toBe(DEFAULT_PURGE_BATCH_SIZE + 1);
      expect(probe(fixedSessionId('none'))).toBe(0);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'purges a backlog of several candidate pages page by page, ties included, with capped lists and exact counts',
    async () => {
      // The two oldest are in flight, so they stay behind the cursor on page one.
      const retainedAhead = [0, 1].map((offset) =>
        seedSession(h, { updatedAt: ANCIENT_AT + offset, status: 'capturing' }),
      );
      // Six hundred sessions share one updated_at — more than a page — so a page
      // boundary falls inside the tie group and the keyset's tie-break carries
      // the cursor through it; the rest come in groups of seven.
      const purgeable = new Set<SessionId>();
      for (let index = 0; index < MAX_REPORTED_ITEMS + 1; index += 1) {
        const updatedAt = index < 600 ? AGED_AT : AGED_AT + 1 + Math.floor(index / 7);
        purgeable.add(seedSession(h, { updatedAt }));
      }
      const total = retainedAhead.length + purgeable.size;

      const pages: ListRetentionCandidatesOptions[] = [];
      const seen: SessionId[] = [];
      const sessions: SessionsRepo = {
        ...h.sessions,
        listRetentionCandidates: (options: ListRetentionCandidatesOptions) => {
          pages.push(options);
          const page = h.sessions.listRetentionCandidates(options);
          if (!isErr(page)) {
            seen.push(...page.value.map((candidate) => candidate.id));
          }
          return page;
        },
      };
      const report = await sweep(h, {}, { sessions });

      // Every count is exact; the lists stop at the cap and `omitted` holds the rest.
      expect(report.sessionsDeleted).toBe(purgeable.size);
      expect(report.sessionIdsDeleted).toHaveLength(MAX_REPORTED_ITEMS);
      expect(new Set(report.sessionIdsDeleted).size).toBe(MAX_REPORTED_ITEMS);
      expect(report.sessionIdsDeleted.every((sessionId) => purgeable.has(sessionId))).toBe(true);
      expect(report.sessionIdsDeleted).toEqual([...report.sessionIdsDeleted].sort());
      expect(report.sessionsRetainedActive).toEqual([...retainedAhead].sort());
      expect(report.omitted).toEqual({
        sessionIdsDeleted: purgeable.size - MAX_REPORTED_ITEMS,
        sessionsRetainedForConflicts: 0,
        sessionsRetainedActive: 0,
        errors: 0,
      });
      expect(report.errors).toEqual([]);
      for (const sessionId of purgeable) {
        expect(sessionExists(h, sessionId)).toBe(false);
      }
      for (const sessionId of retainedAhead) {
        expect(sessionExists(h, sessionId)).toBe(true);
      }

      // Every candidate was read exactly once, across keyset pages under one
      // stable cutoff: the first from the start, each later one strictly past
      // the last candidate of the one before.
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      expect(pages).toHaveLength(Math.ceil(total / RETENTION_CANDIDATE_PAGE_SIZE));
      expect(pages[0]?.after).toBeUndefined();
      expect(new Set(pages.map((page) => page.updatedBefore))).toEqual(new Set([report.cutoff]));
      expect(pages.every((page) => page.limit === RETENTION_CANDIDATE_PAGE_SIZE)).toBe(true);
      const cursors = pages.slice(1).map((page) => page.after);
      // The first page boundary falls inside the six-hundred-session tie group.
      expect(cursors[0]?.updatedAt).toBe(AGED_AT);
      for (const [index, cursor] of cursors.entries()) {
        expect(cursor).toBeDefined();
        const previous = cursors[index - 1];
        if (cursor !== undefined && previous !== undefined) {
          const ascending =
            cursor.updatedAt > previous.updatedAt ||
            (cursor.updatedAt === previous.updatedAt && cursor.position > previous.position);
          expect(ascending).toBe(true);
        }
      }
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it('caps the issue list at the reported maximum and counts the rest', async () => {
    const target = join(h.outside, 'link-target');
    writeFileSync(target, SENTINEL);
    const links = MAX_REPORTED_ITEMS + 2;
    for (let index = 0; index < links; index += 1) {
      symlinkSync(target, join(h.backupsDir, `link-${String(index).padStart(5, '0')}`));
    }

    const report = await sweep(h);

    expect(report.errors).toHaveLength(MAX_REPORTED_ITEMS);
    expect(report.omitted.errors).toBe(links - MAX_REPORTED_ITEMS);
    expect(report.errors.every((issue) => issue.scope === 'backup')).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(SENTINEL);
    expect(readdirSync(h.backupsDir)).toHaveLength(links);
  });

  it('reads no journal row, opens no transaction and writes nothing when nothing has aged', async () => {
    const live = await seedFullSession(h, RECENT_AT);
    seedUnrelatedJournal(h, live.sessionId, 500);
    writeLooseBackup(h, fixedSessionId('young'), 'orphan-in-grace', RECENT_AT);
    writeIndexEntry(h, 'recent-cache.json', { projectRoot: PROJECT_B }, RECENT_AT);
    const rowsBefore = tableTotals(h);
    const treeBefore = snapshotTree(h);
    const observed = observeStore(h.store);

    const report = await sweep(h, {}, { store: observed.store });

    expect(probesOf(observed)).toBe(0);
    expect(observed.calls).toEqual({ transactions: 0, checkpoints: 0, referenceRowsRead: 0 });
    expect(report).toMatchObject({
      sessionsDeleted: 0,
      telemetryEventsDeleted: 0,
      backupDirsDeleted: 0,
      orphanBackupsDeleted: 0,
      indexCachesDeleted: 0,
      bytesReclaimed: 0,
      errors: [],
    });
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.durationMs).toBeLessThan(10_000);
    expect(tableTotals(h)).toEqual(rowsBefore);
    expect(snapshotTree(h)).toEqual(treeBefore);
    expect(present(live.contents.modification.backupPath)).toBe(true);
  });

  it('judges old backup files in bounded batches against their own session only, never the unrelated journal', async () => {
    const live = await seedFullSession(h, RECENT_AT, {}, { backupAt: ANCIENT_AT });
    const liveDir = join(h.backupsDir, live.sessionId);
    const strays = BACKUP_PROBE_BATCH_SIZE + 2;
    for (let index = 0; index < strays; index += 1) {
      writeLooseBackup(h, live.sessionId, `stray-${String(index).padStart(5, '0')}`, ANCIENT_AT);
    }
    const ghostDir = join(h.backupsDir, fixedSessionId('ghost'));
    const ghosts = ['one', 'two', 'three'].map((name) =>
      writeLooseBackup(h, fixedSessionId('ghost'), name, ANCIENT_AT),
    );
    // A large journal of another live session, which no probe may read.
    const bulk = seedSession(h, { updatedAt: RECENT_AT });
    seedUnrelatedJournal(h, bulk, 2_500);
    const observed = observeStore(h.store);

    const report = await sweep(h, {}, { store: observed.store });

    // The live directory's old files — its referenced backup included — went
    // in two batches, the ghost's in one; each probe read only its own
    // session's records: one for the live session, none for the ghost.
    const liveCandidates = strays + 1;
    expect(probesOf(observed)).toBe(Math.ceil(liveCandidates / BACKUP_PROBE_BATCH_SIZE) + 1);
    expect(observed.calls.referenceRowsRead).toBe(
      Math.ceil(liveCandidates / BACKUP_PROBE_BATCH_SIZE),
    );
    expect(report.orphanBackupsDeleted).toBe(strays + ghosts.length);
    expect(report.backupDirsDeleted).toBe(1);
    expect(report.errors).toEqual([]);
    expect(readdirSync(liveDir)).toEqual([basename(live.contents.modification.backupPath)]);
    expect(present(live.contents.modification.backupPath)).toBe(true);
    expect(present(ghostDir)).toBe(false);
  });

  it("protects a composed backup through its record's original digest, wherever the recorded path points", async () => {
    // The backup store reads a record's composed backup, backups/<session>/<digest>,
    // whenever the recorded path is not one it will open — here, a path outside
    // the state root. The composed file is therefore still that record's backup.
    const live = seedSession(h, { updatedAt: RECENT_AT });
    const moved = await withClockAsync(h, RECENT_AT, async () => {
      const composed = makeModification(h, { sessionId: live });
      const record = { ...composed, backupPath: join(h.outside, 'moved-away') };
      const stored = unwrap(await h.modifications.append(record));
      unwrap(await h.modifications.updateStatus(stored.id, 'reverted'));
      return composed.backupPath;
    });
    writeDatedFile(moved, 'original bytes of the composed backup\n', ANCIENT_AT);

    const report = await sweep(h);

    expect(present(moved)).toBe(true);
    expect(report.orphanBackupsDeleted).toBe(0);
    expect(report.backupDirsDeleted).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("removes a purged session's backup directory whole, since no other session's record resolves into it", async () => {
    const aged = await seedFullSession(h, AGED_AT);
    const agedDir = join(h.backupsDir, aged.sessionId);
    const live = seedSession(h, { updatedAt: RECENT_AT });
    const foreign = join(agedDir, 'named-by-another-session');
    writeDatedFile(foreign, 'bytes another session names\n', ANCIENT_AT);
    const recordId = await withClockAsync(h, RECENT_AT, async () => {
      const record = { ...makeModification(h, { sessionId: live }), backupPath: foreign };
      const stored = unwrap(await h.modifications.append(record));
      unwrap(await h.modifications.updateStatus(stored.id, 'reverted'));
      return stored.id;
    });
    const observed = observeStore(h.store);

    const report = await sweep(h, {}, { store: observed.store });

    expect(report.sessionIdsDeleted).toEqual([aged.sessionId]);
    expectNoRowsLeft(h, aged.sessionId);
    expect(report.backupDirsDeleted).toBe(1);
    expect(present(agedDir)).toBe(false);
    expect(report.errors).toEqual([]);
    // Removing the purged directory needed no journal read at all.
    expect(probesOf(observed)).toBe(0);
    // The other session's record is untouched; the backup store would resolve
    // it to its own session's composed path, never to the removed file.
    expect(unwrap(await h.modifications.get(recordId))?.sessionId).toBe(live);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy
 * ---------------------------------------------------------------------------------------------- */

describe('privacy', () => {
  it('puts no diff, question or request-key secret into a log record or a report field', async () => {
    const sentinelDiff = `${DIFF}+// ${SENTINEL}\n`;
    const sentinelQuestion = `Why is alpha slow? ${SENTINEL}`;
    const purged = await seedFullSession(
      h,
      AGED_AT,
      { question: sentinelQuestion },
      { diff: sentinelDiff },
    );
    const retained = await seedFullSession(
      h,
      AGED_AT,
      { question: sentinelQuestion },
      { diff: sentinelDiff, status: 'conflict' },
    );
    // An open record, so the sweep also takes its warning path for this session.
    const reported = await seedFullSession(
      h,
      AGED_AT,
      { question: sentinelQuestion },
      { diff: sentinelDiff, status: 'applied' },
    );
    const secrets = [purged, retained, reported].map(({ contents }) => contents.requestKeySecret);

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([purged.sessionId]);
    expect(report.sessionsRetainedForConflicts).toEqual([retained.sessionId]);
    expect(issuesAt(report, 'session', reported.sessionId)).toHaveLength(1);

    const sweepLogs = h.logs.filter((log) => log.fields['repo'] === 'retention');
    expect(sweepLogs.length).toBeGreaterThan(0);

    const logged = JSON.stringify(h.logs);
    const reportText = JSON.stringify(report);
    for (const text of [logged, reportText]) {
      expect(text).not.toContain(SENTINEL);
      for (const secret of secrets) {
        expect(text).not.toContain(secret);
      }
    }
    // Paths travel relative to the state root, never absolute.
    expect(JSON.stringify(sweepLogs)).not.toContain(h.root);
    expect(reportText).not.toContain(h.root);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Determinism
 * ---------------------------------------------------------------------------------------------- */

describe('determinism', () => {
  it('produces the same report for the same state, apart from its duration', async () => {
    const twin = createHarness();
    await seedEveryRule(h);
    await seedEveryRule(twin);

    const first = await sweep(h);
    const second = await sweep(twin);

    expect(comparable(second)).toEqual(comparable(first));
    expect(first.sessionsDeleted).toBeGreaterThan(0);
  });

  it('finds nothing left to do on an immediate second sweep', async () => {
    await seedEveryRule(h);

    const first = await sweep(h);
    const again = await sweep(h);

    expect(first.sessionsDeleted).toBeGreaterThan(0);
    expect(again).toMatchObject({
      cutoff: first.cutoff,
      sessionsDeleted: 0,
      sessionIdsDeleted: [],
      telemetryEventsDeleted: 0,
      panelsDeleted: 0,
      analysesDeleted: 0,
      modificationsDeleted: 0,
      backupDirsDeleted: 0,
      orphanBackupsDeleted: 0,
      indexCachesDeleted: 0,
      bytesReclaimed: 0,
      errors: [],
    });
    // The conflict is still unresolved, so it is still — and only — retained.
    expect(again.sessionsRetainedForConflicts).toEqual(first.sessionsRetainedForConflicts);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Scoped sweeps — `session.purge` for one editor's workspace
 * ---------------------------------------------------------------------------------------------- */

/** A scope admitting `folder` and everything under it, as an editor's announced folder does. */
function scopeOf(folder: string): RetentionScope {
  return (projectRoot) => isWithin(folder, projectRoot);
}

/** What {@link seedTwoWorkspaces} planted, for the assertions that follow a sweep. */
interface TwoWorkspaces {
  readonly agedA: SessionId;
  readonly agedB: { readonly sessionId: SessionId; readonly contents: SeededContents };
  readonly conflictB: SessionId;
  readonly activeB: SessionId;
  readonly orphanA: string;
  readonly orphanB: string;
  readonly ghostOrphan: string;
  readonly stray: string;
  readonly cacheA: string;
  readonly cacheB: string;
  readonly cacheNone: string;
  readonly cacheOpaque: string;
  readonly cacheMixed: string;
}

/**
 * Seeds two workspaces with work for every rule. Project A holds one aged
 * session and an orphan in the backup directory of a live session under it;
 * project B holds the same plus an aged session kept by a conflict and an aged
 * one still capturing — both of which a sweep would name in its report. Beside
 * them: an orphan whose session row is gone, a stray file directly under
 * `backups/`, and aged cache entries recording A, B, nothing, both, or not a
 * document at all. No session of either project root was updated inside the
 * window, so no cache is kept for being active.
 */
async function seedTwoWorkspaces(harness: Harness): Promise<TwoWorkspaces> {
  const agedA = (await seedFullSession(harness, AGED_AT, { projectRoot: PROJECT_A })).sessionId;
  const agedB = await seedFullSession(harness, AGED_AT, { projectRoot: PROJECT_B });
  const conflictB = (
    await seedFullSession(
      harness,
      AGED_AT,
      { projectRoot: PROJECT_B },
      { status: 'conflict', backupAt: ANCIENT_AT },
    )
  ).sessionId;
  const activeB = seedSession(harness, {
    projectRoot: PROJECT_B,
    updatedAt: AGED_AT,
    status: 'capturing',
  });

  const liveA = seedSession(harness, { projectRoot: `${PROJECT_A}/live`, updatedAt: RECENT_AT });
  const liveB = seedSession(harness, { projectRoot: `${PROJECT_B}/live`, updatedAt: RECENT_AT });
  const orphanA = writeLooseBackup(harness, liveA, hashOf(harness, 'scoped:a'), ANCIENT_AT);
  const orphanB = writeLooseBackup(harness, liveB, hashOf(harness, 'scoped:b'), ANCIENT_AT);
  const ghostOrphan = writeLooseBackup(
    harness,
    fixedSessionId('scoped-ghost'),
    hashOf(harness, 'scoped:ghost'),
    ANCIENT_AT,
  );
  const stray = join(harness.backupsDir, hashOf(harness, 'scoped:stray'));
  writeDatedFile(stray, 'stray bytes\n', ANCIENT_AT);

  const cacheA = writeIndexEntry(
    harness,
    'a.json',
    { index: { projectRoot: PROJECT_A } },
    ANCIENT_AT,
  );
  const cacheB = writeIndexEntry(
    harness,
    'b.json',
    { index: { projectRoot: PROJECT_B } },
    ANCIENT_AT,
  );
  const cacheNone = writeIndexEntry(harness, 'none.json', {}, ANCIENT_AT);
  const cacheOpaque = writeIndexEntry(harness, 'opaque.bin', 'opaque bytes', ANCIENT_AT);
  const cacheMixed = join(harness.indexCacheDir, 'mixed');
  writeDatedFile(
    join(cacheMixed, 'a.json'),
    JSON.stringify({ projectRoot: PROJECT_A }),
    ANCIENT_AT,
  );
  writeDatedFile(
    join(cacheMixed, 'b.json'),
    JSON.stringify({ projectRoot: PROJECT_B }),
    ANCIENT_AT,
  );
  setAge(cacheMixed, ANCIENT_AT);

  return {
    agedA,
    agedB,
    conflictB,
    activeB,
    orphanA,
    orphanB,
    ghostOrphan,
    stray,
    cacheA,
    cacheB,
    cacheNone,
    cacheOpaque,
    cacheMixed,
  };
}

/** The `retention sweep finished` records the sweep logged. */
function finishedRecords(harness: Harness): CapturedLog[] {
  return harness.logs.filter((entry) => entry.message === 'retention sweep finished');
}

describe('scoped sweeps: session.purge for one workspace', () => {
  it("removes workspace A's aged sessions, orphans and caches, and leaves every item of B unread and unreported", async () => {
    const fixture = await seedTwoWorkspaces(h);
    const bCounts = scopedCounts(h, fixture.agedB.sessionId);

    const report = await sweep(h, { scope: scopeOf(PROJECT_A) });

    // A's aged session went completely, with its backup directory.
    expect(report.sessionIdsDeleted).toEqual([fixture.agedA]);
    expect(report.sessionsDeleted).toBe(1);
    expect(sessionExists(h, fixture.agedA)).toBe(false);
    expect(present(join(h.backupsDir, fixture.agedA))).toBe(false);
    expect(present(fixture.orphanA)).toBe(false);
    expect(present(fixture.cacheA)).toBe(false);
    expect(report).toMatchObject({
      // The aged session's directory, and the live A directory its orphan emptied.
      backupDirsDeleted: 2,
      orphanBackupsDeleted: 1,
      indexCachesDeleted: 1,
      // B's conflict and B's capturing session are not A's to report.
      sessionsRetainedForConflicts: [],
      sessionsRetainedActive: [],
      errors: [],
    });

    // Every item of B, and every item whose project is unknown, is untouched.
    for (const sessionId of [fixture.agedB.sessionId, fixture.conflictB, fixture.activeB]) {
      expect(sessionExists(h, sessionId)).toBe(true);
    }
    expect(scopedCounts(h, fixture.agedB.sessionId)).toEqual(bCounts);
    expect(sha256OfFileSync(fixture.agedB.contents.modification.backupPath)).toBe(
      fixture.agedB.contents.modification.digest,
    );
    for (const kept of [
      fixture.orphanB,
      fixture.ghostOrphan,
      fixture.stray,
      fixture.cacheB,
      fixture.cacheNone,
      fixture.cacheOpaque,
      fixture.cacheMixed,
    ]) {
      expect(present(kept)).toBe(true);
    }
    expect(finishedRecords(h).at(-1)?.fields).toMatchObject({ scoped: true, sessionsDeleted: 1 });
  });

  it('stays machine-wide without a scope: the same state is swept exactly as before', async () => {
    const fixture = await seedTwoWorkspaces(h);

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([fixture.agedA, fixture.agedB.sessionId].sort());
    expect(report.sessionsRetainedForConflicts).toEqual([fixture.conflictB]);
    expect(report.sessionsRetainedActive).toEqual([fixture.activeB]);
    // Both live directories' orphans, the ownerless one and the stray file.
    expect(report.orphanBackupsDeleted).toBe(4);
    // Every aged cache entry: none of their projects was opened inside the window.
    expect(report.indexCachesDeleted).toBe(5);
    for (const gone of [
      fixture.orphanA,
      fixture.orphanB,
      fixture.ghostOrphan,
      fixture.stray,
      fixture.cacheA,
      fixture.cacheB,
      fixture.cacheNone,
      fixture.cacheOpaque,
      fixture.cacheMixed,
    ]) {
      expect(present(gone)).toBe(false);
    }
    expect(report.errors).toEqual([]);
    expect(finishedRecords(h).at(-1)?.fields).toMatchObject({ scoped: false });
  });

  it('leaves the other workspace to its own editor: a B-scoped sweep then removes what A left', async () => {
    const fixture = await seedTwoWorkspaces(h);
    await sweep(h, { scope: scopeOf(PROJECT_A) });

    const report = await sweep(h, { scope: scopeOf(PROJECT_B) });

    expect(report.sessionIdsDeleted).toEqual([fixture.agedB.sessionId]);
    expect(report.sessionsRetainedForConflicts).toEqual([fixture.conflictB]);
    expect(report.sessionsRetainedActive).toEqual([fixture.activeB]);
    expect(present(fixture.orphanB)).toBe(false);
    expect(present(fixture.cacheB)).toBe(false);
    // Whose project is unknown, or spans both, waits for the machine-wide sweep.
    for (const kept of [
      fixture.ghostOrphan,
      fixture.stray,
      fixture.cacheNone,
      fixture.cacheOpaque,
      fixture.cacheMixed,
    ]) {
      expect(present(kept)).toBe(true);
    }
  });

  it('removes an entry recording several roots once the scope admits all of them', async () => {
    const fixture = await seedTwoWorkspaces(h);

    const report = await sweep(h, { scope: scopeOf('/workspace') });

    expect(present(fixture.cacheMixed)).toBe(false);
    expect(present(fixture.cacheA)).toBe(false);
    expect(present(fixture.cacheB)).toBe(false);
    // Neither an entry that records no project nor a non-document is anyone's.
    expect(present(fixture.cacheNone)).toBe(true);
    expect(present(fixture.cacheOpaque)).toBe(true);
    expect(report.indexCachesDeleted).toBe(3);
  });

  it('reports on a scoped dry run exactly what the scoped sweep then removes', async () => {
    await seedTwoWorkspaces(h);
    const treeBefore = snapshotTree(h);
    const rowsBefore = tableTotals(h);

    const dry = await sweep(h, { scope: scopeOf(PROJECT_A), dryRun: true });

    expect(snapshotTree(h)).toEqual(treeBefore);
    expect(tableTotals(h)).toEqual(rowsBefore);
    const real = await sweep(h, { scope: scopeOf(PROJECT_A) });
    expect(comparable(real)).toEqual(comparable(dry));
  });

  it('reads a scope that throws as outside, keeping everything, and logs only its code', async () => {
    const fixture = await seedTwoWorkspaces(h);
    const treeBefore = snapshotTree(h);
    const rowsBefore = tableTotals(h);

    const report = await sweep(h, {
      scope: () => {
        throw new Error(`scope failure quoting ${SENTINEL}`);
      },
    });

    expect(report).toMatchObject({
      sessionsDeleted: 0,
      orphanBackupsDeleted: 0,
      indexCachesDeleted: 0,
      sessionsRetainedForConflicts: [],
      sessionsRetainedActive: [],
    });
    expect(snapshotTree(h)).toEqual(treeBefore);
    expect(tableTotals(h)).toEqual(rowsBefore);
    expect(sessionExists(h, fixture.agedA)).toBe(true);
    expect(
      h.logs.some((entry) => entry.message.startsWith('the retention scope check failed')),
    ).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);
  });

  it('answers CONFIG_INVALID, deleting nothing, for a scope that is not a predicate', async () => {
    await seedTwoWorkspaces(h);
    const rowsBefore = tableTotals(h);

    const result = await runRetention(depsOf(h), {
      scope: 'project-a' as unknown as RetentionScope,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('CONFIG_INVALID');
    }
    expect(tableTotals(h)).toEqual(rowsBefore);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Scoped sweeps — a scope that resolves roots on disk, awaited outside every transaction
 * ---------------------------------------------------------------------------------------------- */

/**
 * A scope built the way `session.purge` builds one: the workspace folder is
 * canonicalised once, and a root is admitted only when it lies under the
 * folder lexically **and** its own canonical location lies under the
 * canonical folder. A root whose location cannot be established is refused.
 */
async function canonicalScopeOf(folder: string): Promise<RetentionScope> {
  const canonicalFolder = unwrap(await canonicalizePath(folder));
  return async (projectRoot) => {
    if (!isWithin(folder, projectRoot)) {
      return false;
    }
    const canonicalRoot = await canonicalizePath(projectRoot);
    return !isErr(canonicalRoot) && isWithin(canonicalFolder, canonicalRoot.value);
  };
}

/**
 * Writes the directory-shaped cache entry `index/<name>/` holding `children`
 * — each serialised like {@link writeIndexEntry} does — and dates every file
 * and then the directory itself {@link ANCIENT_AT}.
 */
function writeIndexDirectory(
  harness: Harness,
  name: string,
  children: Readonly<Record<string, unknown>>,
): string {
  const directory = join(harness.indexCacheDir, name);
  for (const [child, document] of Object.entries(children)) {
    const body = typeof document === 'string' ? document : JSON.stringify(document);
    writeDatedFile(join(directory, child), body, ANCIENT_AT);
  }
  setAge(directory, ANCIENT_AT);
  return directory;
}

/** `count` cache documents recording `projectRoot`, named so they list in order. */
function documentsRecording(count: number, projectRoot: string): Record<string, unknown> {
  const documents: Record<string, unknown> = {};
  for (let index = 1; index <= count; index += 1) {
    documents[`doc-${String(index).padStart(3, '0')}.json`] = { index: { projectRoot } };
  }
  return documents;
}

/** The message of the `debug` record a scoped sweep writes for a directory it kept unattributed. */
const KEPT_DIRECTORY_LOG =
  'a scoped sweep kept an index-cache directory it could not attribute whole';

/** The directories a scoped sweep kept unattributed after `mark` log records, and why. */
function keptDirectories(harness: Harness, mark = 0): Record<string, unknown>[] {
  return harness.logs
    .slice(mark)
    .filter((entry) => entry.level === 'debug' && entry.message === KEPT_DIRECTORY_LOG)
    .map(({ fields }) => ({
      target: fields['target'],
      reason: fields['reason'],
      documents: fields['documents'],
    }));
}

describe('scoped sweeps: a scope that resolves roots on disk', () => {
  it("keeps a session whose root is a link inside A resolving into B, and removes A's real one", async () => {
    const workspaceA = join(h.root, 'workspaces', 'a');
    const realA = join(workspaceA, 'app');
    const projectInB = join(h.root, 'workspaces', 'b', 'app');
    mkdirSync(realA, { recursive: true });
    mkdirSync(projectInB, { recursive: true });
    const linkToB = join(workspaceA, 'link-to-b');
    symlinkSync(projectInB, linkToB, 'dir');
    // Lexically the link is A's: a scope that only compared strings would sweep it.
    expect(isWithin(workspaceA, linkToB)).toBe(true);

    const agedReal = (await seedFullSession(h, AGED_AT, { projectRoot: realA })).sessionId;
    const agedLinked = await seedFullSession(h, AGED_AT, { projectRoot: linkToB });
    const linkedCounts = scopedCounts(h, agedLinked.sessionId);
    const orphanLinked = writeLooseBackup(
      h,
      agedLinked.sessionId,
      hashOf(h, 'linked:orphan'),
      ANCIENT_AT,
    );
    const cacheReal = writeIndexEntry(
      h,
      'real.json',
      { index: { projectRoot: realA } },
      ANCIENT_AT,
    );
    const cacheLinked = writeIndexEntry(
      h,
      'linked.json',
      { index: { projectRoot: linkToB } },
      ANCIENT_AT,
    );
    const directoryLinked = writeIndexDirectory(h, 'linked-directory', {
      'a.json': { projectRoot: realA },
      'b.json': { projectRoot: linkToB },
    });

    const report = await sweep(h, { scope: await canonicalScopeOf(workspaceA) });

    // A's real project went, with its backups and its cache.
    expect(report.sessionIdsDeleted).toEqual([agedReal]);
    expect(present(join(h.backupsDir, agedReal))).toBe(false);
    expect(present(cacheReal)).toBe(false);
    expect(report).toMatchObject({
      indexCachesDeleted: 1,
      orphanBackupsDeleted: 0,
      sessionsRetainedForConflicts: [],
      sessionsRetainedActive: [],
      errors: [],
    });
    // Everything recorded against the link really lives in B, and stays.
    expect(sessionExists(h, agedLinked.sessionId)).toBe(true);
    expect(scopedCounts(h, agedLinked.sessionId)).toEqual(linkedCounts);
    expect(sha256OfFileSync(agedLinked.contents.modification.backupPath)).toBe(
      agedLinked.contents.modification.digest,
    );
    for (const kept of [orphanLinked, cacheLinked, directoryLinked, projectInB]) {
      expect(present(kept)).toBe(true);
    }
  });

  it('awaits an asynchronous scope for every rule, and never while a transaction is open', async () => {
    const fixture = await seedTwoWorkspaces(h);
    const asked = new Set<string>();
    let askedInsideTransaction = 0;
    const scope: RetentionScope = async (projectRoot) => {
      if (h.store.db.isTransaction) {
        askedInsideTransaction += 1;
      }
      // Settles on a later turn of the event loop, as a scope reading the disk does.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (h.store.db.isTransaction) {
        askedInsideTransaction += 1;
      }
      asked.add(projectRoot);
      return isWithin(PROJECT_A, projectRoot);
    };

    const report = await sweep(h, { scope });

    expect(askedInsideTransaction).toBe(0);
    // Sessions, backup directories and caches of both workspaces were asked about.
    expect(asked).toEqual(
      new Set([PROJECT_A, PROJECT_B, `${PROJECT_A}/live`, `${PROJECT_B}/live`]),
    );
    expect(report.sessionIdsDeleted).toEqual([fixture.agedA]);
    expect(report).toMatchObject({
      backupDirsDeleted: 2,
      orphanBackupsDeleted: 1,
      indexCachesDeleted: 1,
      sessionsRetainedForConflicts: [],
      sessionsRetainedActive: [],
      errors: [],
    });
    for (const gone of [fixture.orphanA, fixture.cacheA]) {
      expect(present(gone)).toBe(false);
    }
    for (const sessionId of [fixture.agedB.sessionId, fixture.conflictB, fixture.activeB]) {
      expect(sessionExists(h, sessionId)).toBe(true);
    }
    for (const kept of [fixture.orphanB, fixture.cacheB, fixture.cacheMixed, fixture.cacheNone]) {
      expect(present(kept)).toBe(true);
    }
  });

  it('reads a scope that rejects as outside, keeping everything, and logs only its code', async () => {
    await seedTwoWorkspaces(h);
    const treeBefore = snapshotTree(h);
    const rowsBefore = tableTotals(h);

    const report = await sweep(h, {
      scope: () => Promise.reject(new Error(`scope rejection quoting ${SENTINEL}`)),
    });

    expect(report).toMatchObject({
      sessionsDeleted: 0,
      orphanBackupsDeleted: 0,
      indexCachesDeleted: 0,
      sessionsRetainedForConflicts: [],
      sessionsRetainedActive: [],
    });
    expect(snapshotTree(h)).toEqual(treeBefore);
    expect(tableTotals(h)).toEqual(rowsBefore);
    expect(
      h.logs.some((entry) => entry.message.startsWith('the retention scope check failed')),
    ).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Scoped sweeps — a directory-shaped cache entry is inspected whole
 * ---------------------------------------------------------------------------------------------- */

describe('scoped sweeps: a directory-shaped cache entry is inspected whole', () => {
  it('keeps a directory holding more documents than the sweep reads, even when only the last records B', async () => {
    const crowded = writeIndexDirectory(h, 'crowded', {
      ...documentsRecording(MAX_INDEX_METADATA_FILES, PROJECT_A),
      // Listed last, so a sweep that sampled the first documents never saw it.
      'doc-999.json': { index: { projectRoot: PROJECT_B } },
    });

    const scoped = await sweep(h, { scope: scopeOf(PROJECT_A) });

    expect(present(crowded)).toBe(true);
    expect(scoped.indexCachesDeleted).toBe(0);
    expect(scoped.errors).toEqual([]);
    expect(keptDirectories(h)).toEqual([
      {
        target: relativeToHome(h, crowded),
        reason: 'too-many-documents',
        documents: MAX_INDEX_METADATA_FILES + 1,
      },
    ]);

    // Not even a scope admitting every root it records removes what it did not read whole.
    const mark = h.logs.length;
    const wide = await sweep(h, { scope: scopeOf('/workspace') });
    expect(present(crowded)).toBe(true);
    expect(wide.indexCachesDeleted).toBe(0);
    expect(keptDirectories(h, mark)).toHaveLength(1);

    // The machine-wide sweep is unchanged: it samples, finds no active project, removes.
    const machineWide = await sweep(h);
    expect(machineWide.indexCachesDeleted).toBe(1);
    expect(present(crowded)).toBe(false);
  });

  it('keeps a directory holding an unreadable or a rootless document, or a subdirectory', async () => {
    const garbled = writeIndexDirectory(h, 'garbled', {
      'a.json': { projectRoot: PROJECT_A },
      'b.json': 'not json at all',
    });
    const rootless = writeIndexDirectory(h, 'rootless', {
      'a.json': { projectRoot: PROJECT_A },
      'b.json': { index: {} },
    });
    // Its subdirectory holds B's document, which a one-level walk never reads
    // but a tree removal would take with it.
    const nested = writeIndexDirectory(h, 'nested', { 'a.json': { projectRoot: PROJECT_A } });
    const shard = join(nested, 'shard');
    writeDatedFile(join(shard, 'b.json'), JSON.stringify({ projectRoot: PROJECT_B }), ANCIENT_AT);
    setAge(shard, ANCIENT_AT);
    setAge(nested, ANCIENT_AT);
    const garbledFile = writeIndexEntry(h, 'garbled.json', 'not json at all', ANCIENT_AT);

    const scoped = await sweep(h, { scope: scopeOf(PROJECT_A) });

    expect(scoped.indexCachesDeleted).toBe(0);
    expect(scoped.errors).toEqual([]);
    for (const kept of [garbled, rootless, nested, garbledFile]) {
      expect(present(kept)).toBe(true);
    }
    expect(keptDirectories(h)).toEqual([
      { target: relativeToHome(h, garbled), reason: 'unreadable-document', documents: 2 },
      { target: relativeToHome(h, nested), reason: 'nested-directory', documents: 1 },
      { target: relativeToHome(h, rootless), reason: 'rootless-document', documents: 2 },
    ]);

    // The machine-wide sweep removes all four, exactly as it always has.
    const machineWide = await sweep(h);
    expect(machineWide.indexCachesDeleted).toBe(4);
    for (const gone of [garbled, rootless, nested, garbledFile]) {
      expect(present(gone)).toBe(false);
    }
  });

  it('still removes a directory of at most the documents it reads, each recording a root the scope admits', async () => {
    const full = writeIndexDirectory(h, 'full', {
      ...documentsRecording(MAX_INDEX_METADATA_FILES, PROJECT_A),
      'graph.bin': 'graph bytes',
    });
    const single = writeIndexDirectory(h, 'single', {
      'meta.json': { projectRoot: `${PROJECT_A}/packages/web` },
    });
    // No document at all: it records no project, so it is nobody's to remove.
    const bare = writeIndexDirectory(h, 'bare', { 'graph.bin': 'graph bytes' });

    const report = await sweep(h, { scope: scopeOf(PROJECT_A) });

    expect(report.indexCachesDeleted).toBe(2);
    expect(present(full)).toBe(false);
    expect(present(single)).toBe(false);
    expect(present(bare)).toBe(true);
    expect(report.errors).toEqual([]);
    expect(keptDirectories(h)).toEqual([]);
  });

  it('keeps an attributable directory that records a project active inside the window', async () => {
    seedSession(h, { projectRoot: PROJECT_A, updatedAt: RECENT_AT });
    const owned = writeIndexDirectory(h, 'owned', documentsRecording(2, PROJECT_A));

    const report = await sweep(h, { scope: scopeOf(PROJECT_A) });

    expect(present(owned)).toBe(true);
    expect(report.indexCachesDeleted).toBe(0);
    expect(keptDirectories(h)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The write-ahead log during a sweep
 * ---------------------------------------------------------------------------------------------- */

/** SQLite's default commit-time checkpoint threshold, which the store never changes. */
const DEFAULT_AUTOCHECKPOINT_PAGES = 1_000;

/** The debug record of each background checkpoint the sweep waited for. */
const BACKGROUND_CHECKPOINT_MESSAGE =
  'checkpointed the session store write-ahead log off the event loop';

/** The store connection's `wal_autocheckpoint`, as the pragma answers it. */
function autoCheckpointOf(harness: Harness): unknown {
  return harness.store.db.prepare('PRAGMA wal_autocheckpoint').get()?.['wal_autocheckpoint'];
}

/** The size of the store's `-wal` file, `0` when there is none. */
function walFileBytes(harness: Harness): number {
  const wal = `${harness.store.path}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

describe('the write-ahead log during a sweep', () => {
  it('documents the bound a sweep keeps the log to', () => {
    expect(RETENTION_WAL_CHECKPOINT_BYTES).toBe(32 * 1024 * 1024);
  });

  it(
    'suspends the commit-time checkpoint while it drains, waits for background checkpoints instead, and restores the threshold',
    async () => {
      const { sessionId } = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, sessionId, AGED_AT, LARGE_TELEMETRY);
      const seen: unknown[] = [];

      // Asked inside every drain transaction and the final cascade.
      const report = await sweep(
        h,
        { walCheckpointBytes: 0 },
        {
          isSessionInUse: () => {
            seen.push(autoCheckpointOf(h));
            return false;
          },
        },
      );

      expect(report.sessionsDeleted).toBe(1);
      expect(report.errors).toEqual([]);
      expect(sessionExists(h, sessionId)).toBe(false);
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(new Set(seen)).toEqual(new Set([0]));
      expect(autoCheckpointOf(h)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);

      const waited = h.logs.filter((log) => log.message === BACKGROUND_CHECKPOINT_MESSAGE);
      expect(waited.length).toBeGreaterThan(0);
      for (const log of waited) {
        expect(log.level).toBe('debug');
        expect(log.fields).toMatchObject({ subsystem: 'store', checkpoint: 'completed', busy: 0 });
        expect(typeof log.fields['walBytes']).toBe('number');
        expect(log.fields['checkpointedFrames']).toBe(log.fields['logFrames']);
      }
      expect(finishedFields(h)).toMatchObject({ walCheckpoints: waited.length });
      // The last wait left nothing for the closing truncation but the truncation.
      expect(walFileBytes(h)).toBe(0);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it('waits only once, before its closing truncation, while the log stays under its bound', async () => {
    const aged = seedSession(h, { updatedAt: AGED_AT });

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([aged]);
    // No batch reached the bound; the one wait is the reclaim's, which copies
    // what is left off the event loop before the store truncates the log.
    expect(h.logs.filter((log) => log.message === BACKGROUND_CHECKPOINT_MESSAGE)).toHaveLength(1);
    expect(finishedFields(h)).toMatchObject({ walCheckpoints: 1 });
    expect(autoCheckpointOf(h)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
    expect(walFileBytes(h)).toBe(0);
  });

  it('waits for no background checkpoint when it deletes nothing', async () => {
    seedSession(h, { updatedAt: RECENT_AT });

    const report = await sweep(h, { walCheckpointBytes: 0 });

    expect(report.sessionsDeleted).toBe(0);
    expect(h.logs.filter((log) => log.message === BACKGROUND_CHECKPOINT_MESSAGE)).toEqual([]);
    expect(finishedFields(h)).toMatchObject({ walCheckpoints: 0 });
    expect(autoCheckpointOf(h)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
  });

  it('leaves the commit-time checkpoint in force for a dry run, which writes nothing', async () => {
    const aged = seedSession(h, { updatedAt: AGED_AT });
    const seen: unknown[] = [];

    const report = await sweep(
      h,
      { dryRun: true, walCheckpointBytes: 0 },
      {
        isSessionInUse: () => {
          seen.push(autoCheckpointOf(h));
          return false;
        },
      },
    );

    expect(report.sessionIdsDeleted).toEqual([aged]);
    expect(sessionExists(h, aged)).toBe(true);
    expect(seen).toEqual([DEFAULT_AUTOCHECKPOINT_PAGES]);
    expect(h.logs.filter((log) => log.message === BACKGROUND_CHECKPOINT_MESSAGE)).toEqual([]);
  });

  it(
    'restores the commit-time checkpoint when an abort stops the sweep mid-drain',
    async () => {
      const { sessionId } = await seedFullSession(h, AGED_AT);
      seedTelemetry(h, sessionId, AGED_AT, LARGE_TELEMETRY);
      const controller = new AbortController();

      const report = await sweep(
        h,
        { signal: controller.signal, walCheckpointBytes: 0 },
        {
          isSessionInUse: () => {
            controller.abort();
            return false;
          },
        },
      );

      expect(report.interrupted).toBe(true);
      expect(report.telemetryEventsDeleted).toBe(DEFAULT_PURGE_BATCH_SIZE);
      expect(sessionExists(h, sessionId)).toBe(true);
      expect(autoCheckpointOf(h)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
      // Aborted before the wait: the shutdown the signal stands for is not
      // held up behind a checkpoint.
      expect(h.logs.filter((log) => log.message === BACKGROUND_CHECKPOINT_MESSAGE)).toEqual([]);
    },
    LARGE_FIXTURE_TEST_TIMEOUT_MS,
  );

  it('answers CONFIG_INVALID, deleting nothing, for a walCheckpointBytes it cannot use', async () => {
    const aged = seedSession(h, { updatedAt: AGED_AT });

    for (const walCheckpointBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
      const result = await runRetention(depsOf(h), {
        walCheckpointBytes: walCheckpointBytes as number,
      });
      expect(isErr(result) ? result.error.code : 'ok').toBe('CONFIG_INVALID');
    }
    expect(sessionExists(h, aged)).toBe(true);
    expect(autoCheckpointOf(h)).toBe(DEFAULT_AUTOCHECKPOINT_PAGES);
  });
});
