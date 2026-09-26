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
 *    opened inside the window survives; an abandoned one goes.
 * 5. **Nothing outside the state root is touched**, not through a planted link
 *    and not through a sibling that merely shares the root's name as a prefix.
 * 6. **A dry run is honest, one bad item never aborts the pass, and no report
 *    or log line carries a secret, a diff or a question.**
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
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  IN_FLIGHT_SESSION_STATUSES,
  MAX_REPORTED_ITEMS,
  ORPHAN_BACKUP_GRACE_DAYS,
  RETENTION_CANDIDATE_PAGE_SIZE,
  runRetention,
} from './retention.js';
import type {
  RetentionDeps,
  RetentionIssue,
  RetentionOptions,
  RetentionReport,
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

/** A report with its one non-deterministic member zeroed, for equality checks. */
function comparable(report: RetentionReport): RetentionReport {
  return { ...report, durationMs: 0 };
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
    expect(report.bytesReclaimed).toBe(contents.modification.bytes.length);
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

/** The resting statuses: every status outside {@link IN_FLIGHT_SESSION_STATUSES}. */
const RESTING_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter(
  (status) => !IN_FLIGHT_SESSION_STATUSES.includes(status),
);

describe('an atomic purge that never touches an active session', () => {
  it('purges a session holding more than one purge batch of telemetry in a single cascade', async () => {
    const { sessionId, contents } = await seedFullSession(h, AGED_AT);
    seedTelemetry(h, sessionId, AGED_AT, LARGE_TELEMETRY);

    const report = await sweep(h);

    expect(report.sessionIdsDeleted).toEqual([sessionId]);
    expect(report.telemetryEventsDeleted).toBe(contents.telemetryEvents + LARGE_TELEMETRY);
    expect(report.backupDirsDeleted).toBe(1);
    expect(report.errors).toEqual([]);
    expectNoRowsLeft(h, sessionId);
    expect(sessionExists(h, sessionId)).toBe(false);
  });

  it('rolls a large session back whole when its cascade fails past the first purge batch, and carries on', async () => {
    const failing = await seedFullSession(h, AGED_AT);
    seedTelemetry(h, failing.sessionId, AGED_AT, LARGE_TELEMETRY);
    const sibling = await seedFullSession(h, AGED_AT + DAY_MS);
    const rowsBefore = scopedCounts(h, failing.sessionId);
    expect(rowsBefore.telemetry_events).toBeGreaterThan(DEFAULT_PURGE_BATCH_SIZE);

    // The session's last-inserted event refuses to be deleted, so the cascade
    // fails after more rows than one purge batch holds. The engine's message is
    // the sentinel, so the report and the logs can be proven free of it.
    h.store.db.exec(
      `CREATE TEMP TRIGGER retention_cascade_failure BEFORE DELETE ON main.telemetry_events ` +
        `WHEN old.ingest_seq = ${String(lastIngestSeq(h, failing.sessionId))} ` +
        `BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`,
    );

    const report = await sweep(h);

    // Nothing of the failing session went — not one event of any batch.
    expect(sessionExists(h, failing.sessionId)).toBe(true);
    expect(scopedCounts(h, failing.sessionId)).toEqual(rowsBefore);
    expect(present(failing.contents.modification.backupPath)).toBe(true);
    expect(issuesAt(report, 'session', failing.sessionId)).toHaveLength(1);
    expect(report.errors).toHaveLength(1);
    // The sweep went on to the next candidate.
    expect(report.sessionIdsDeleted).toEqual([sibling.sessionId]);
    expect(report.telemetryEventsDeleted).toBe(sibling.contents.telemetryEvents);
    expectNoRowsLeft(h, sibling.sessionId);
    // No engine text reaches the report or a log record.
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
    expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);

    h.store.db.exec('DROP TRIGGER retention_cascade_failure');
    const retry = await sweep(h);

    expect(retry.sessionIdsDeleted).toEqual([failing.sessionId]);
    expect(retry.telemetryEventsDeleted).toBe(rowsBefore.telemetry_events);
    expect(retry.errors).toEqual([]);
    expectNoRowsLeft(h, failing.sessionId);
    expect(present(failing.contents.modification.backupPath)).toBe(false);
  });

  it('keeps every event of a large session refreshed after it was listed', async () => {
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
  });

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

  it('removes an old entry that records no project, and keeps a recent one without reading it', async () => {
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

  it('purges a backlog of several candidate pages page by page, ties included, with capped lists and exact counts', async () => {
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
  });

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
