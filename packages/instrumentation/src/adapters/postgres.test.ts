/**
 * The colocated unit suite of `./postgres.ts` — the adapter that speaks for the
 * raw PostgreSQL driver's query spans.
 *
 * ## What this suite is for
 *
 * The adapter is the product's answer to one question about a developer's
 * project: *does this project hand-write statements against PostgreSQL, and if
 * so, where?* Everything downstream of that answer is load-bearing for
 * acceptance test 1 (AAP §0.8.4) — the `db.query` span that has to appear under
 * the route handler in the correlated trace, and the "open source" target the
 * panel's query table offers for it. So the suite proves the four properties
 * that answer can get wrong:
 *
 * 1. **Detection is structural.** `pg` usage is read from the code graph —
 *    `db-call` nodes whose `driver` is the raw driver, plus the project
 *    summary's `databaseAccess.style` — and never from the spelling of a table,
 *    a pool variable or a borrowed client (AAP §0.5.4). The suite therefore
 *    indexes a real corpus through the real pipeline and, for the decisive
 *    cases, writes throwaway projects whose identifiers are arbitrary: a name
 *    this product recognised would be a name it had been taught.
 * 2. **Both driver shapes count equally.** A statement sent straight to the
 *    pool and a statement sent on a client borrowed with `connect()` and handed
 *    back in a `finally` are the same signal to a developer. The borrowed form
 *    is the one an extractor or an adapter is most likely to drop (or to
 *    double-count), so the expected owner set is computed from the graph and
 *    compared exactly rather than spot-checked.
 * 3. **A missing preload is reported, not hidden.** Driver spans come from the
 *    dev-server preload; when it is absent the adapter must say so with a hint
 *    a developer can paste, naming *their* project (AAP §0.5.5) — and when the
 *    driver is unused it must say nothing at all rather than warn about a
 *    signal nobody asked for.
 * 4. **Nothing it handles leaks.** This adapter is the one whose input material
 *    is raw SQL: the graph nodes it reads carry statement text, table names and
 *    `$1` placeholders. Every string it emits and every line it logs is
 *    therefore checked against tokens *derived from the corpus's own
 *    statements* (AAP §0.5.2), so a future change that quotes a statement into
 *    a rationale or a log field fails here.
 *
 * It also proves the two boundaries that keep the adapter honest: it writes
 * nothing — `applied` is always empty, the journal is never appended to and the
 * backup store is never reached (AAP §0.5.1) — and it imports nothing it should
 * not, including its Prisma sibling, so the two claimants of
 * `'db-query-tracking'` stay independent and a seventh adapter needs no edit
 * here (AAP §0.4.2).
 *
 * ## How it runs
 *
 * In the root-owned Vitest project named `instrumentation` (node environment,
 * `globals: false`), inside the blocking `pnpm test` gate (AAP §0.8.3). There
 * is no per-package Vitest config and this file adds none.
 *
 * Hermetic by construction: no socket is opened, no database is contacted, no
 * driver package is imported (none is installed, and none may be) and the
 * committed fixture is only ever *read*. The two things that touch a filesystem
 * are both deliberate and both harmless: `openProject` reads the corpus, and
 * four throwaway source trees are written under `mkdtemp` and removed in
 * `afterAll`.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CodeGraph,
  buildIndex,
  buildRouteMap,
  createCodeQueries,
  openProject,
  summarizeProject,
} from '@debuggen/code-analysis';
import type {
  CodeNode,
  CodeNodeOf,
  CodeQueries,
  DbDriver,
  LoadedProject,
  ProjectSummary,
  RouteMap,
} from '@debuggen/code-analysis';
import { DebuggenError, err, isErr, noopLogger, ok, toPosix } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  InstallResult,
  InstrumentationContext,
  ObservedServerAgent,
  UnavailableSignal,
} from '../adapter.js';
import {
  ACTION_ID_PATTERN,
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  instrumentationActionSchema,
} from '../schema/plan.js';
import type { InstrumentationAction } from '../schema/plan.js';
import type { ModificationJournal, ModificationRecord } from '../schema/modification.js';
import {
  CAPTURE_SIGNALS,
  DISABLED_SERVER_AGENT_SIGNALS,
  READINESS_STATUSES,
  SERVER_AGENT_SIGNAL_KEYS,
  readinessSchema,
  serverAgentSignalsSchema,
} from '../schema/readiness.js';
import type { ProblemUnderstanding } from '../schema/target.js';
import {
  POSTGRES_ADAPTER_CLAIMS,
  POSTGRES_ADAPTER_DEFAULTS,
  POSTGRES_ADAPTER_ID,
  POSTGRES_SERVER_SIGNAL_KEYS,
  createPostgresAdapter,
} from './postgres.js';

/* -------------------------------------------------------------------------------------------------
 * Fixed inputs
 * ---------------------------------------------------------------------------------------------- */

/**
 * The committed corpus, resolved from this module's own URL.
 *
 * Never from `process.cwd()`: Vitest's working directory is the repository root
 * for a full run and the workspace root for `pnpm --filter … test`, and a suite
 * that depended on which one it got would pass in one and fail in the other.
 */
const FIXTURE_ROOT = toPosix(
  fileURLToPath(new URL('../../test/fixtures/project-a', import.meta.url)),
);

/** The adapter's own source, read by the import-boundary guard of the last block. */
const ADAPTER_SOURCE_PATH = fileURLToPath(new URL('./postgres.ts', import.meta.url));

/** Session identity the context factory stamps on every call. */
const SESSION_ID = 'ses_postgresadapter1';

/** Plan version the context factory stamps on every call. */
const PLAN_VERSION = 2;

/**
 * The session-state root named on the context.
 *
 * It is never created and never written to: the adapter has no business under
 * `$DEBUGGEN_HOME`, and the backup-store double below fails the test if it is
 * ever reached. A path under the OS temporary directory rather than a real
 * `~/.debuggen`, so a bug that did write something could not touch a
 * developer's state.
 */
const STATE_ROOT = toPosix(join(tmpdir(), 'debuggen-postgres-adapter-state'));

/** The instant every clock in this suite reports, in epoch milliseconds. */
const NOW = 1_700_000_000_000;

/** A project root that is not the corpus, for the foreign-preload case. */
const FOREIGN_PROJECT_ROOT = toPosix(join(tmpdir(), 'debuggen-some-other-project'));

/** The owner node kinds a query call site may be attributed to. */
const OWNER_NODE_KINDS: readonly string[] = Object.freeze(['server-function', 'symbol']);

/* -------------------------------------------------------------------------------------------------
 * Indexing a project the way the product does
 * ---------------------------------------------------------------------------------------------- */

/** One indexed project, as the adapter's context carries it. */
interface IndexedProject {
  /** Absolute POSIX project root. */
  readonly root: string;
  readonly loaded: LoadedProject;
  readonly graph: CodeGraph;
  readonly queries: CodeQueries;
  readonly routeMap: RouteMap;
  readonly projectSummary: ProjectSummary;
}

/**
 * Indexes a project through the real pipeline, cache-free.
 *
 * `openProject` → `buildIndex` → `CodeGraph.fromIndex` → `buildRouteMap` →
 * `createCodeQueries` → `summarizeProject`, exactly the sequence
 * `apps/local-service` runs before it asks an adapter anything. Going through
 * the real path is the point: a graph assembled by hand in this file would
 * prove the adapter consistent with this file's idea of the indexer rather than
 * with the indexer, and the borrowed-client call site — the shape most likely
 * to regress — exists only because the extractor produces it.
 *
 * @param root Absolute project root to index.
 * @returns The handles an `InstrumentationContext` needs.
 */
async function indexProject(root: string): Promise<IndexedProject> {
  const opened = openProject({ projectRoot: root });
  if (isErr(opened)) {
    throw new Error(`the project at ${root} did not open: ${opened.error.message}`);
  }

  const built = await buildIndex(opened.value);
  if (isErr(built)) {
    throw new Error(`the project at ${root} did not index: ${built.error.message}`);
  }

  const graph = CodeGraph.fromIndex(built.value);
  const routeMap = buildRouteMap(opened.value);

  return {
    root: toPosix(root),
    loaded: opened.value,
    graph,
    queries: createCodeQueries(graph, { loaded: opened.value, routes: routeMap.entries }),
    routeMap,
    projectSummary: summarizeProject({ loaded: opened.value, graph, routeMap }),
  };
}

/** Every scratch root this suite created, removed in `afterAll`. */
const scratchRoots: string[] = [];

/**
 * Writes a throwaway source tree under its own `mkdtemp` directory and indexes
 * it.
 *
 * The committed corpus is read-only in this suite, so every case that needs a
 * *different* project — a client-only one, a database-free one, one with more
 * query sites than the anchor budget allows — gets its own tree instead. The
 * identifiers in those trees are arbitrary on purpose: they are the behavioural
 * half of the no-hardcoding evidence (AAP §0.5.4), since an adapter that
 * recognised them could only have been taught them.
 *
 * @param label Short name, used only in the temporary directory prefix.
 * @param files Project-relative path to file contents.
 * @returns The indexed project.
 */
async function indexScratchProject(
  label: string,
  files: Readonly<Record<string, string>>,
): Promise<IndexedProject> {
  const root = mkdtempSync(join(tmpdir(), `debuggen-${label}-`));
  scratchRoots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }

  return indexProject(root);
}

/**
 * The TypeScript configuration every scratch tree carries.
 *
 * `openProject` prefers a project's own `tsconfig.json`, which is how a real
 * target project is loaded; giving each scratch tree one keeps the indexing
 * path identical to the corpus's.
 */
const SCRATCH_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2023',
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['**/*.ts'],
    exclude: ['node_modules'],
  },
  undefined,
  2,
)}\n`;

/* -------------------------------------------------------------------------------------------------
 * The scratch projects
 * ---------------------------------------------------------------------------------------------- */

/**
 * A harbour timetable that reaches PostgreSQL only through the raw driver, in
 * both shapes, through handles named nothing like a pool or a client.
 *
 * `walkBerthSlots` borrows a connection and releases it in a `finally`;
 * `tallyTideWindows` sends its statement straight to the handle. One module
 * above them calls exactly one of the two, which is what lets the narrowing
 * case assert that naming a caller promotes the query site it reaches. No
 * `package.json`, so the project's package manager is unknown and the relaunch
 * hint must fall back to naming the editor command.
 */
const PG_ONLY_FILES: Readonly<Record<string, string>> = Object.freeze({
  'tsconfig.json': SCRATCH_TSCONFIG,
  'src/ledger/handles.ts': [
    "import { Pool } from 'pg';",
    '',
    'export const ferryBerth = new Pool({ max: 4 });',
    '',
  ].join('\n'),
  'src/ledger/tide-book.ts': [
    "import { ferryBerth } from './handles';",
    '',
    'export async function tallyTideWindows(harbourId: string): Promise<number> {',
    '  const result = await ferryBerth.query(',
    "    'select count(*) as window_total from tide_windows where harbour_id = $1',",
    '    [harbourId],',
    '  );',
    '',
    '  return result.rows.length;',
    '}',
    '',
    'export async function walkBerthSlots(harbourId: string): Promise<unknown[]> {',
    '  const borrowed = await ferryBerth.connect();',
    '',
    '  try {',
    '    const result = await borrowed.query(',
    "      'select slot_id, moored_at from berth_slots where harbour_id = $1 order by moored_at asc',",
    '      [harbourId],',
    '    );',
    '',
    '    return result.rows;',
    '  } finally {',
    '    borrowed.release();',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/ledger/harbour-desk.ts': [
    "import { tallyTideWindows } from './tide-book';",
    '',
    'export async function openHarbourDesk(harbourId: string): Promise<number> {',
    '  return tallyTideWindows(harbourId);',
    '}',
    '',
  ].join('\n'),
});

/**
 * A quarry office that reaches the database only through a generated client.
 *
 * The decisive negative case for `canHandle`: `'db-query-tracking'` is claimed
 * by this adapter *and* by the Prisma sibling, and this project is the one
 * where the sibling must win.
 */
const PRISMA_ONLY_FILES: Readonly<Record<string, string>> = Object.freeze({
  'tsconfig.json': SCRATCH_TSCONFIG,
  'package.json': `${JSON.stringify(
    {
      name: 'scratch-quarry-office',
      version: '0.0.0',
      private: true,
      packageManager: 'pnpm@12.4.2',
      scripts: { dev: 'next dev' },
    },
    undefined,
    2,
  )}\n`,
  'src/office/handles.ts': [
    "import { PrismaClient } from '@prisma/client';",
    '',
    'export const ledgerClient = new PrismaClient();',
    '',
  ].join('\n'),
  'src/office/haul-book.ts': [
    "import { ledgerClient } from './handles';",
    '',
    'export async function listQuarryHauls(siteId: string): Promise<unknown[]> {',
    '  return ledgerClient.haulTicket.findMany({ where: { siteId } });',
    '}',
    '',
  ].join('\n'),
});

/** A project with no database access of any kind. */
const DATABASE_FREE_FILES: Readonly<Record<string, string>> = Object.freeze({
  'tsconfig.json': SCRATCH_TSCONFIG,
  'src/ferry/timetable.ts': [
    'export function nextDeparture(offsetMinutes: number): number {',
    '  return offsetMinutes + 15;',
    '}',
    '',
  ].join('\n'),
});

/**
 * How many query-site owners the crowded scratch project holds.
 *
 * More than {@link POSTGRES_ADAPTER_DEFAULTS.maxTargetsCeiling} so that the
 * ceiling is reachable, which is the only way to prove it bounds a caller's
 * request rather than merely being exported.
 */
const CROWDED_OWNER_COUNT = POSTGRES_ADAPTER_DEFAULTS.maxTargetsCeiling + 8;

/**
 * Builds a module of {@link CROWDED_OWNER_COUNT} functions, each sending one
 * statement to the same handle.
 *
 * @returns The module source.
 */
function crowdedModuleSource(): string {
  const lines: string[] = ["import { depotLedger } from './handles';", ''];

  for (let index = 0; index < CROWDED_OWNER_COUNT; index += 1) {
    const suffix = String(index).padStart(2, '0');
    lines.push(
      `export async function tallyDepotRun${suffix}(runId: string): Promise<number> {`,
      `  const result = await depotLedger.query(`,
      `    'select count(*) as run_total from depot_runs_${suffix} where run_id = $1',`,
      '    [runId],',
      '  );',
      '',
      '  return result.rows.length;',
      '}',
      '',
    );
  }

  return lines.join('\n');
}

/** A project whose query sites outnumber the anchor budget several times over. */
const CROWDED_FILES: Readonly<Record<string, string>> = Object.freeze({
  'tsconfig.json': SCRATCH_TSCONFIG,
  'src/depot/handles.ts': [
    "import { Pool } from 'pg';",
    '',
    'export const depotLedger = new Pool({ max: 8 });',
    '',
  ].join('\n'),
  'src/depot/run-book.ts': crowdedModuleSource(),
});

/* -------------------------------------------------------------------------------------------------
 * Query-site facts, computed from the graph
 * ---------------------------------------------------------------------------------------------- */

/** One function the graph says encloses at least one driver call site. */
interface QuerySiteOwner {
  readonly file: string;
  readonly symbol: string;
  readonly line: number;
  readonly callSites: number;
}

/**
 * Derives the owners of a driver's query sites straight from the graph.
 *
 * Deliberately an independent derivation rather than a call into the adapter:
 * filter `db-call` nodes by their `driver`, walk each one's incoming `queries`
 * edge to the node that encloses it, and keep the ones that are addressable
 * functions. What the adapter proposes is then compared against this, so a
 * shape the adapter drops — or invents — is visible as a set difference rather
 * than as a count that happens to match.
 *
 * @param project The indexed project to read.
 * @param driver The driver whose call sites are wanted.
 * @returns The owners, ordered by file, then line, then symbol.
 */
function querySiteOwners(project: IndexedProject, driver: DbDriver): readonly QuerySiteOwner[] {
  const byKey = new Map<
    string,
    { file: string; symbol: string; line: number; callSites: number }
  >();

  for (const call of callSitesFor(project, driver)) {
    for (const edge of project.graph.incoming(call.id, 'queries')) {
      const owner: CodeNode | undefined = project.graph.nodeById(edge.from);
      if (owner === undefined || !OWNER_NODE_KINDS.includes(owner.kind)) {
        continue;
      }

      const key = `${owner.file}#${owner.name}@${String(owner.line)}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, { file: owner.file, symbol: owner.name, line: owner.line, callSites: 1 });
        continue;
      }
      existing.callSites += 1;
    }
  }

  return [...byKey.values()].sort(
    (left, right) =>
      compareText(left.file, right.file) ||
      left.line - right.line ||
      compareText(left.symbol, right.symbol),
  );
}

/**
 * The `db-call` nodes of one driver.
 *
 * @param project The indexed project to read.
 * @param driver The driver to filter by.
 * @returns The matching nodes, in graph order.
 */
function callSitesFor(project: IndexedProject, driver: DbDriver): readonly CodeNodeOf<'db-call'>[] {
  return project.graph.nodesByKind('db-call').filter((node) => node.data.driver === driver);
}

/**
 * Total ordering on strings, without a locale.
 *
 * @param left First value.
 * @param right Second value.
 * @returns Negative, zero or positive.
 */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The 1-based line numbers of a module whose text matches a pattern.
 *
 * @param lines The module's lines.
 * @param pattern The pattern to look for.
 * @returns Matching line numbers, ascending.
 */
function lineNumbersMatching(lines: readonly string[], pattern: RegExp): readonly number[] {
  const matches: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) {
      matches.push(index + 1);
    }
  }
  return matches;
}

/* -------------------------------------------------------------------------------------------------
 * Context doubles
 *
 * Everything the adapter is handed that it must NOT use is a double that says
 * so: the journal records the calls it never expects to receive, and the backup
 * store records the properties it never expects to be read and throws from
 * whatever is read off it. Those two records are the evidence behind AAP
 * §0.5.1's "this adapter writes nothing".
 * ---------------------------------------------------------------------------------------------- */

/** One line a logger was asked to write. */
interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that keeps what it was told, and the records it kept. */
interface LoggerProbe {
  readonly logger: Logger;
  readonly records: readonly LogRecord[];
}

/**
 * Builds a logger that records instead of writing.
 *
 * `child()` returns the same recorder, so a binding the adapter adds cannot
 * hide a line from the suite.
 *
 * @returns The logger and the live array of records it appends to.
 */
function recordingLogger(): LoggerProbe {
  const records: LogRecord[] = [];
  const write =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };

  const logger: Logger = {
    level: 'debug',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: (): Logger => logger,
  };

  return { logger, records };
}

/** A journal that records what it was asked to do, and the record of that. */
interface JournalProbe {
  readonly journal: ModificationJournal;
  readonly calls: readonly string[];
  readonly appended: readonly ModificationRecord[];
}

/**
 * Builds an in-memory journal.
 *
 * It answers successfully rather than throwing, so a hypothetical append would
 * proceed far enough for the *behaviour* to be asserted — the suite fails on
 * the recorded call, not on an exception whose stack could be mistaken for an
 * unrelated bug.
 *
 * @returns The journal and the live records of its use.
 */
function recordingJournal(): JournalProbe {
  const calls: string[] = [];
  const appended: ModificationRecord[] = [];

  const journal: ModificationJournal = {
    append: (record: ModificationRecord) => {
      calls.push(`append:${record.file}`);
      appended.push(record);
      return Promise.resolve(ok(record));
    },
    updateStatus: (id: string, status: string) => {
      calls.push(`updateStatus:${id}:${status}`);
      return Promise.resolve(
        err(
          new DebuggenError('INTERNAL', 'The driver adapter suite journals no modification.', {
            hint: 'This adapter installs a runtime signal and modifies no file (AAP 0.5.1).',
          }),
        ),
      );
    },
    listBySession: (sessionId: string) => {
      calls.push(`listBySession:${sessionId}`);
      return Promise.resolve(ok([]));
    },
    listOpen: () => {
      calls.push('listOpen');
      return Promise.resolve(ok([]));
    },
  };

  return { journal, calls, appended };
}

/** A backup store that must never be reached, and the record of any attempt. */
interface BackupStoreProbe {
  readonly backups: InstrumentationContext['backups'];
  readonly touches: readonly string[];
}

/**
 * Builds a backup store double that records every property read and throws from
 * anything called off it.
 *
 * A proxy rather than an object literal implementing the interface, for two
 * reasons: the type comes off the context (`InstrumentationContext['backups']`)
 * so this suite needs no import of the patcher's internals, and a member added
 * to the store later is covered without editing this file.
 *
 * @returns The store and the live record of properties read from it.
 */
function forbiddenBackupStore(): BackupStoreProbe {
  const touches: string[] = [];

  const backups = new Proxy(
    {},
    {
      get(_target: object, property: string | symbol): unknown {
        const name = typeof property === 'symbol' ? property.toString() : property;
        touches.push(name);
        return (): never => {
          throw new Error(
            `the driver adapter reached the backup store through ${name}; it must write nothing`,
          );
        };
      },
    },
  ) as InstrumentationContext['backups'];

  return { backups, touches };
}

/* -------------------------------------------------------------------------------------------------
 * The context factory
 * ---------------------------------------------------------------------------------------------- */

/** What a test varies about the context it hands the adapter. */
interface HarnessInput {
  /** The indexed project. Defaults to the committed corpus. */
  readonly project?: IndexedProject;

  /** The observed dev-server agent. Absent means none has ever connected. */
  readonly serverAgent?: ObservedServerAgent;

  /** An abort signal, for the cancelled-session case. */
  readonly signal?: AbortSignal;

  /** The session clock. Defaults to the frozen instant {@link NOW}. */
  readonly now?: () => number;

  /** The session logger. Defaults to a fresh recorder. */
  readonly logger?: Logger;
}

/** A context plus live views of everything the adapter was observed doing with it. */
interface Harness {
  readonly context: InstrumentationContext;
  readonly logs: readonly LogRecord[];
  readonly journalCalls: readonly string[];
  readonly backupTouches: readonly string[];
}

/**
 * Builds one `InstrumentationContext` and the probes attached to it.
 *
 * The shape is read off `../adapter.ts` — it is never re-declared here — so a
 * field added to the contract is a compile error in this file rather than a
 * silently missing input.
 *
 * @param input What to vary.
 * @returns The context and its probes.
 */
function harness(input: HarnessInput = {}): Harness {
  const project = input.project ?? fixture;
  const logs = recordingLogger();
  const journal = recordingJournal();
  const backups = forbiddenBackupStore();

  const context: InstrumentationContext = {
    sessionId: SESSION_ID,
    projectRoot: project.root,
    planVersion: PLAN_VERSION,
    debuggenHome: STATE_ROOT,
    logger: input.logger ?? logs.logger,
    graph: project.graph,
    queries: project.queries,
    routeMap: project.routeMap,
    projectSummary: project.projectSummary,
    loaded: project.loaded,
    journal: journal.journal,
    backups: backups.backups,
    readiness: input.serverAgent === undefined ? {} : { serverAgent: input.serverAgent },
    now: input.now ?? frozenClock,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };

  return {
    context,
    logs: logs.records,
    journalCalls: journal.calls,
    backupTouches: backups.touches,
  };
}

/** The clock every context reports unless a test injects another. */
const frozenClock = (): number => NOW;

/* -------------------------------------------------------------------------------------------------
 * Dev-server presets
 *
 * The three states AAP §0.5.5 distinguishes — no preload, a preload that is
 * reporting, a preload that has gone quiet — plus the two ways an apparently
 * connected agent is still no use: it belongs to another project, or its socket
 * is closed.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A preload attached to this project and reporting.
 *
 * @param root The project root it reports for.
 * @returns The observed agent.
 */
function attachedPreload(root: string): ObservedServerAgent {
  return { connected: true, projectRoot: root, lastHeartbeatAt: NOW - 1_000 };
}

/**
 * A preload attached to this project that has not reported inside a window.
 *
 * Staleness is driven by the clock, never by waiting: the heartbeat is dated
 * before the window, and the session clock is frozen at {@link NOW}.
 *
 * @param root The project root it reports for.
 * @param stalenessMs The window it must fall outside of.
 * @returns The observed agent.
 */
function quietPreload(
  root: string,
  stalenessMs: number = POSTGRES_ADAPTER_DEFAULTS.heartbeatStalenessMs,
): ObservedServerAgent {
  return { connected: true, projectRoot: root, lastHeartbeatAt: NOW - (stalenessMs + 5_000) };
}

/**
 * A preload that is connected but has never reported.
 *
 * @param root The project root it reports for.
 * @returns The observed agent.
 */
function neverReportedPreload(root: string): ObservedServerAgent {
  return { connected: true, projectRoot: root };
}

/**
 * A socket that has closed.
 *
 * @param root The project root it reported for.
 * @returns The observed agent.
 */
function disconnectedPreload(root: string): ObservedServerAgent {
  return { connected: false, projectRoot: root, lastHeartbeatAt: NOW - 1_000 };
}

/**
 * A preload reporting for some other project on the machine.
 *
 * @returns The observed agent.
 */
function foreignPreload(): ObservedServerAgent {
  return { connected: true, projectRoot: FOREIGN_PROJECT_ROOT, lastHeartbeatAt: NOW };
}

/** Every readiness preset, for the invariance cases. */
function everyPreset(
  root: string,
): readonly { readonly label: string; readonly agent?: ObservedServerAgent }[] {
  return [
    { label: 'no preload has ever connected' },
    { label: 'the preload is attached and reporting', agent: attachedPreload(root) },
    { label: 'the preload has gone quiet', agent: quietPreload(root) },
    { label: 'the preload has never reported', agent: neverReportedPreload(root) },
    { label: 'the socket has closed', agent: disconnectedPreload(root) },
    { label: 'the preload belongs to another project', agent: foreignPreload() },
  ];
}

/* -------------------------------------------------------------------------------------------------
 * Understandings
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds a problem understanding.
 *
 * @param signalsNeeded The capture signals the question needs.
 * @param entities The entities the question named.
 * @param searchHints Free-text hints from the question.
 * @returns The understanding.
 */
function understandingFor(
  signalsNeeded: ProblemUnderstanding['signalsNeeded'],
  entities: ProblemUnderstanding['entities'] = [],
  searchHints: readonly string[] = [],
): ProblemUnderstanding {
  return {
    category: 'performance',
    signalsNeeded: [...signalsNeeded],
    entities: [...entities],
    searchHints: [...searchHints],
  };
}

/** A question that wants the whole slow-interaction picture, database included. */
const databaseQuestion = understandingFor(['interactions', 'fetch', 'http', 'pg']);

/** A question that asks only for server-tier evidence, naming no database signal. */
const serverTierQuestion = understandingFor(['http', 'routeHandlers']);

/** A question about the page, which has not asked this product to read any query. */
const renderQuestion = understandingFor(['react', 'state']);

/* -------------------------------------------------------------------------------------------------
 * The privacy guard
 *
 * The material this adapter reads is raw SQL: the corpus's `db-call` nodes
 * carry statement text with table names, column names and numbered bind
 * placeholders. The guard below is therefore built FROM that text rather than
 * from a list written by hand, so it cannot go stale, and it is applied to
 * every string the adapter emits and every field it logs (AAP §0.5.2).
 * ---------------------------------------------------------------------------------------------- */

/** Tokens and shapes that must never appear in anything the adapter produces. */
interface LeakGuard {
  /** Snake-case identifiers and handle names taken from the corpus. */
  readonly tokens: readonly string[];

  /** Statement and credential shapes, named so a failure reads plainly. */
  readonly patterns: readonly { readonly name: string; readonly pattern: RegExp }[];
}

/** Matches a snake_case identifier — the give-away of a table or column name. */
const SNAKE_CASE_IDENTIFIER = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/giu;

/**
 * Builds the guard from the statement text and handle names the given projects
 * hold.
 *
 * Generic SQL keywords are deliberately *not* tokens: "come from" in a
 * rationale is prose, not a leak. Keyword *sequences* are matched as patterns
 * instead, which is what a quoted statement would produce.
 *
 * @param projects The indexed projects whose call sites supply the material.
 * @returns The guard.
 */
function leakGuardFor(projects: readonly IndexedProject[]): LeakGuard {
  const tokens = new Set<string>();

  for (const project of projects) {
    for (const call of project.graph.nodesByKind('db-call')) {
      // The handle and method the statement was sent through, for example a
      // pool variable's `.query`. An anchor must name the enclosing function
      // instead.
      tokens.add(call.name);

      const shape = call.data.statementShape;
      if (shape === undefined) {
        continue;
      }
      for (const match of shape.matchAll(SNAKE_CASE_IDENTIFIER)) {
        tokens.add(match[0].toLowerCase());
      }
    }
  }

  return {
    tokens: [...tokens].sort(compareText),
    patterns: [
      { name: 'a select … from sequence', pattern: /\bselect\b[\s\S]{0,400}?\bfrom\b/iu },
      { name: 'an insert into sequence', pattern: /\binsert\s+into\b/iu },
      { name: 'an update … set sequence', pattern: /\bupdate\b[\s\S]{0,200}?\bset\b/iu },
      { name: 'a delete from sequence', pattern: /\bdelete\s+from\b/iu },
      { name: 'a group by clause', pattern: /\bgroup\s+by\b/iu },
      { name: 'an order by clause', pattern: /\border\s+by\b/iu },
      { name: 'a count(*) aggregate', pattern: /\bcount\s*\(\s*\*\s*\)/iu },
      { name: 'a numbered bind placeholder', pattern: /\$\d/u },
      { name: 'a PostgreSQL connection URL', pattern: /postgres(?:ql)?:\/\//iu },
      { name: 'a credential-bearing URL', pattern: /:\/\/[^\s/@]+:[^\s/@]+@/u },
    ],
  };
}

/**
 * Fails if any value carries a statement, a placeholder, a table identifier, a
 * handle name or anything credential-shaped.
 *
 * @param values The strings to check; empty ones are skipped.
 */
function expectNoLeak(values: readonly string[]): void {
  for (const value of values) {
    if (value.length === 0) {
      continue;
    }
    const lowered = value.toLowerCase();

    for (const token of leakGuard.tokens) {
      expect(
        lowered.includes(token.toLowerCase()),
        `"${value}" repeats "${token}" from the project's own statements`,
      ).toBe(false);
    }

    for (const { name, pattern } of leakGuard.patterns) {
      expect(pattern.test(value), `"${value}" contains ${name}`).toBe(false);
    }
  }
}

/**
 * Every string an install result carries, flattened for the privacy guard.
 *
 * @param result The result to flatten.
 * @returns Its strings, plus its JSON form so a field added later is covered.
 */
function installStrings(result: InstallResult): readonly string[] {
  return [
    result.adapterId,
    ...result.runtimeHooks,
    ...gapStrings(result.unavailable),
    JSON.stringify(result),
  ];
}

/**
 * Every string a set of unavailable-signal reports carries.
 *
 * @param unavailable The reports to flatten.
 * @returns Their signals, reasons and hints.
 */
function gapStrings(unavailable: readonly UnavailableSignal[]): readonly string[] {
  return unavailable.flatMap((entry) => [String(entry.signal), entry.reason, entry.hint]);
}

/**
 * Every string a log record carries, including its structured fields.
 *
 * @param records The records to flatten.
 * @returns One string per record plus the record's JSON form.
 */
function logStrings(records: readonly LogRecord[]): readonly string[] {
  return records.flatMap((record) => [record.message, JSON.stringify(record.fields ?? {})]);
}

/**
 * Every string a proposed action carries.
 *
 * @param actions The actions to flatten.
 * @returns Their fields plus the plan's JSON form.
 */
function actionStrings(actions: readonly InstrumentationAction[]): readonly string[] {
  return [
    ...actions.flatMap((action) => [
      action.id,
      action.file,
      action.symbol,
      action.type,
      action.adapter,
      action.mode,
      action.rationale,
    ]),
    JSON.stringify(actions),
  ];
}

/**
 * The comparable shape of a proposal: everything but the freshly minted id.
 *
 * @param actions The actions to strip.
 * @returns One plain object per action.
 */
function withoutIds(actions: readonly InstrumentationAction[]): readonly unknown[] {
  return actions.map((action) => {
    const copy: Record<string, unknown> = { ...action };
    delete copy.id;
    return copy;
  });
}

/**
 * `(file, symbol)` pairs, the shape the expected-owner comparisons use.
 *
 * @param actions The actions to read.
 * @returns One `file#symbol` key per action, in order.
 */
function anchorKeys(actions: readonly InstrumentationAction[]): readonly string[] {
  return actions.map((action) => `${action.file}#${action.symbol}`);
}

/**
 * `file#symbol` keys for a set of owners derived from the graph.
 *
 * @param owners The owners to read.
 * @returns One key per owner, in order.
 */
function ownerKeys(owners: readonly QuerySiteOwner[]): readonly string[] {
  return owners.map((owner) => `${owner.file}#${owner.symbol}`);
}

/* -------------------------------------------------------------------------------------------------
 * Recording what the adapter reads from the environment
 * ---------------------------------------------------------------------------------------------- */

/** What an environment-recorded call produced, and which variables it read. */
interface EnvRecording<T> {
  readonly result: T;
  readonly reads: readonly string[];
}

/**
 * Runs a synchronous call with `process.env` replaced by a recorder.
 *
 * The callback is invoked and the original object restored with no `await`
 * between the two, so nothing else in the worker can interleave and any
 * recorded read belongs to the code under test. Used to show that a relaunch
 * instruction is composed from what the caller injected rather than from the
 * environment the suite happens to run in.
 *
 * @param run The call to make; it must not await inside.
 * @returns Its result and the variables read while it ran.
 */
function recordingEnvReads<T>(run: () => T): EnvRecording<T> {
  const original = process.env;
  const reads: string[] = [];

  process.env = new Proxy(original, {
    get(target: NodeJS.ProcessEnv, property: string | symbol): string | undefined {
      const name = typeof property === 'symbol' ? property.toString() : property;
      reads.push(name);
      return typeof property === 'symbol' ? undefined : target[property];
    },
  });

  try {
    return { result: run(), reads };
  } finally {
    process.env = original;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The import-boundary guard
 *
 * The adapter's independence is a property of its source text, so it is checked
 * there: the two `'db-query-tracking'` claimants must not import each other, an
 * adapter must not reach the registry, the installer, the patcher or the
 * cleanup module, and a module that only *describes* a signal has no business
 * importing a database driver, reading the environment or writing to the
 * console (AAP §0.4.2, §0.5.4).
 * ---------------------------------------------------------------------------------------------- */

/** One boundary violation, with the text that proves it. */
interface BoundaryFinding {
  readonly rule: string;
  readonly matched: string;
}

/** Specifiers this module must never import. */
const FORBIDDEN_SPECIFIERS: readonly string[] = Object.freeze([
  '@debuggen/protocol',
  '@debuggen/panel-schema',
  '@debuggen/panel-renderer',
  '../registry.js',
  '../installer.js',
  '../cleanup.js',
  './prisma.js',
]);

/** Specifier prefixes this module must never import. */
const FORBIDDEN_SPECIFIER_PREFIXES: readonly string[] = Object.freeze([
  '@debuggen/protocol/',
  '@debuggen/panel-schema/',
  '@debuggen/panel-renderer/',
  '../patch/',
  'node:',
]);

/** Driver and query-builder packages an adapter describes but never loads. */
const DRIVER_PACKAGES: readonly string[] = Object.freeze([
  'pg',
  'pg-pool',
  'pg-native',
  'postgres',
  'node-postgres',
  '@prisma/client',
  '@prisma/instrumentation',
  '@opentelemetry/instrumentation-pg',
  'knex',
  'sequelize',
  'typeorm',
  'drizzle-orm',
  'kysely',
  'slonik',
]);

/**
 * Removes comments, so prose that mentions a module is not mistaken for an
 * import of it.
 *
 * @param source The module source.
 * @returns The source with block and line comments blanked.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gmu, '$1');
}

/**
 * Every module specifier the source imports, static or dynamic.
 *
 * @param source The module source.
 * @returns The specifiers, de-duplicated and ordered.
 */
function moduleSpecifiers(source: string): readonly string[] {
  const code = withoutComments(source);
  const specifiers = new Set<string>();

  for (const pattern of [
    /\bfrom\s*'([^']+)'/gu,
    /\bimport\s*\(\s*'([^']+)'\s*\)/gu,
    /^\s*import\s*'([^']+)'/gmu,
  ]) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers].sort(compareText);
}

/**
 * Checks a module's source against the boundary rules.
 *
 * Returns findings rather than asserting, so a failure names the rule and the
 * text that broke it instead of only the line number of an assertion.
 *
 * @param source The module source.
 * @returns Every violation found, empty when the boundary holds.
 */
function boundaryFindings(source: string): readonly BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];

  for (const specifier of moduleSpecifiers(source)) {
    if (FORBIDDEN_SPECIFIERS.includes(specifier)) {
      findings.push({ rule: 'imports a module outside the adapter contract', matched: specifier });
    }
    for (const prefix of FORBIDDEN_SPECIFIER_PREFIXES) {
      if (specifier.startsWith(prefix)) {
        findings.push({ rule: `imports from the forbidden prefix ${prefix}`, matched: specifier });
      }
    }
    if (
      DRIVER_PACKAGES.includes(specifier) ||
      DRIVER_PACKAGES.some((name) => specifier.startsWith(`${name}/`))
    ) {
      findings.push({ rule: 'imports a database driver package', matched: specifier });
    }
    if (specifier.startsWith('.') && !specifier.endsWith('.js')) {
      findings.push({ rule: 'relative import without a .js extension', matched: specifier });
    }
  }

  const code = withoutComments(source);
  const textRules: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
    { rule: 'reads the environment', pattern: /process\s*\.\s*env/u },
    { rule: 'writes to the console', pattern: /\bconsole\s*\./u },
  ];

  for (const { rule, pattern } of textRules) {
    const match = pattern.exec(code);
    if (match !== null) {
      findings.push({ rule, matched: match[0] });
    }
  }

  return findings;
}

/**
 * A size-and-timestamp snapshot of every file under a directory.
 *
 * Compared before and after the run to show the committed corpus was read and
 * never written: this adapter modifies no file, and a suite that mutated its
 * own fixture would hide exactly that.
 *
 * @param root The directory to walk.
 * @returns One `path|size|mtime` line per file, ordered.
 */
function footprintOf(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const stats = statSync(path);
      return `${toPosix(path)}|${String(stats.size)}|${String(stats.mtimeMs)}`;
    })
    .sort(compareText);
}

/* -------------------------------------------------------------------------------------------------
 * Suite state, indexed once
 * ---------------------------------------------------------------------------------------------- */

/** The committed corpus: both driver shapes, plus generated-client call sites. */
let fixture: IndexedProject;

/** A project that reaches PostgreSQL only through the raw driver. */
let pgOnlyProject: IndexedProject;

/** A project that reaches the database only through a generated client. */
let prismaOnlyProject: IndexedProject;

/** A project with no database access at all. */
let databaseFreeProject: IndexedProject;

/** A project whose query sites outnumber the anchor budget. */
let crowdedProject: IndexedProject;

/** Tokens and shapes derived from every indexed project's statements. */
let leakGuard: LeakGuard;

/** The corpus's driver query-site owners, derived from the graph. */
let fixturePgOwners: readonly QuerySiteOwner[];

/** The corpus's generated-client query-site owners, derived from the graph. */
let fixturePrismaOwners: readonly QuerySiteOwner[];

/** The one corpus module that holds driver call sites. */
let driverModule: string;

/** That module's lines, for the shape preconditions. */
let driverModuleLines: readonly string[];

/** The owner of the statement sent straight to the pool. */
let directPoolOwner: QuerySiteOwner;

/** The owner of the statement sent on a borrowed client. */
let borrowedClientOwner: QuerySiteOwner;

/** The corpus's file footprint before anything ran. */
let corpusFootprint: readonly string[];

beforeAll(async () => {
  corpusFootprint = footprintOf(FIXTURE_ROOT);

  fixture = await indexProject(FIXTURE_ROOT);
  pgOnlyProject = await indexScratchProject('pg-only', PG_ONLY_FILES);
  prismaOnlyProject = await indexScratchProject('client-only', PRISMA_ONLY_FILES);
  databaseFreeProject = await indexScratchProject('database-free', DATABASE_FREE_FILES);
  crowdedProject = await indexScratchProject('crowded', CROWDED_FILES);

  leakGuard = leakGuardFor([fixture, pgOnlyProject, prismaOnlyProject, crowdedProject]);
  fixturePgOwners = querySiteOwners(fixture, 'pg');
  fixturePrismaOwners = querySiteOwners(fixture, 'prisma');

  // The corpus preconditions this whole suite reasons from. They are checked
  // again as assertions in the first block below, which is what a reader sees;
  // these throws are what stops every later block from failing obscurely when
  // the corpus changes shape.
  const driverFiles = [...new Set(callSitesFor(fixture, 'pg').map((node) => node.file))].sort(
    compareText,
  );
  const [onlyDriverFile] = driverFiles;
  if (driverFiles.length !== 1 || onlyDriverFile === undefined) {
    throw new Error(
      `the corpus must hold its driver call sites in exactly one module; found ${
        driverFiles.length === 0 ? 'none' : driverFiles.join(', ')
      }`,
    );
  }
  driverModule = onlyDriverFile;
  driverModuleLines = readFileSync(join(FIXTURE_ROOT, driverModule), 'utf8').split('\n');

  // The borrowed-client shape is identified structurally - the owner enclosing
  // the module's single `connect()` - rather than by the spelling of a handle,
  // which is the same discipline the adapter itself is held to.
  const connectLines = lineNumbersMatching(driverModuleLines, /\.connect\s*\(/u);
  const [connectLine] = connectLines;
  if (connectLines.length !== 1 || connectLine === undefined) {
    throw new Error(
      `${driverModule} must borrow a connection exactly once; found ${String(connectLines.length)} such call sites`,
    );
  }

  const [enclosing] = fixturePgOwners
    .filter((owner) => owner.file === driverModule && owner.line <= connectLine)
    .sort((left, right) => right.line - left.line);
  if (enclosing === undefined) {
    throw new Error(`no indexed function encloses the borrowed connection in ${driverModule}`);
  }
  borrowedClientOwner = enclosing;

  const direct = fixturePgOwners.find((owner) => owner.symbol !== borrowedClientOwner.symbol);
  if (direct === undefined) {
    throw new Error(
      `${driverModule} must also send a statement straight to the pool, from a second function`,
    );
  }
  directPoolOwner = direct;
}, 120_000);

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  scratchRoots.length = 0;
});

/**
 * Builds a context for one project, optionally with an observed dev-server
 * agent.
 *
 * @param project The indexed project.
 * @param agent The observed agent, if any.
 * @returns The harness.
 */
function harnessFor(project: IndexedProject, agent?: ObservedServerAgent): Harness {
  return harness({ project, ...(agent === undefined ? {} : { serverAgent: agent }) });
}

/**
 * Fails if the adapter touched a file through either double.
 *
 * @param probe The harness whose probes to inspect.
 */
function expectNoFileAccess(probe: Harness): void {
  expect(probe.journalCalls).toEqual([]);
  expect(probe.backupTouches).toEqual([]);
}

/**
 * Fails if the adapter said anything above `debug`.
 *
 * A signal nobody asked for is not a warning: an adapter that logged at `info`
 * or `warn` for a project that never touches PostgreSQL would put a gap in
 * front of every developer whose project uses something else.
 *
 * @param probe The harness whose log records to inspect.
 */
function expectQuietLog(probe: Harness): void {
  expect(
    probe.logs.filter((record) => record.level !== 'debug' && record.level !== 'trace'),
  ).toEqual([]);
}

/* -------------------------------------------------------------------------------------------------
 * The corpus this suite reasons from
 * ---------------------------------------------------------------------------------------------- */

describe('the indexed corpus', () => {
  it('holds exactly two driver call sites, both in one server module', () => {
    const driverCalls = callSitesFor(fixture, 'pg');

    expect(driverCalls).toHaveLength(2);
    expect(new Set(driverCalls.map((node) => node.file))).toEqual(new Set([driverModule]));
    for (const node of driverCalls) {
      expect(node.data.driver).toBe('pg');
      expect(node.data.dynamic).toBe(false);
    }
    expect(fixturePgOwners).toHaveLength(2);
  });

  it('supplies one direct-pool statement and one borrowed client released in a finally', () => {
    const connectLines = lineNumbersMatching(driverModuleLines, /\.connect\s*\(/u);
    const releaseLines = lineNumbersMatching(driverModuleLines, /\.release\s*\(/u);
    const finallyLines = lineNumbersMatching(driverModuleLines, /\}\s*finally\s*\{/u);

    expect(connectLines).toHaveLength(1);
    expect(releaseLines).toHaveLength(1);
    expect(finallyLines).toHaveLength(1);

    const [connectLine] = connectLines;
    const [finallyLine] = finallyLines;
    const [releaseLine] = releaseLines;
    expect(connectLine).toBeDefined();
    expect(finallyLine).toBeDefined();
    expect(releaseLine).toBeDefined();
    // The connection is borrowed first and handed back from the finally block,
    // which is the shape a naive extractor reads as two call sites or as none.
    expect(connectLine ?? 0).toBeLessThan(finallyLine ?? 0);
    expect(finallyLine ?? 0).toBeLessThan(releaseLine ?? 0);

    // Borrowing is not itself a query: the extractor emits a node for each
    // statement and none for `connect()` or `release()`, so two functions own
    // one call site each.
    expect(borrowedClientOwner.symbol).not.toBe(directPoolOwner.symbol);
    expect(borrowedClientOwner.callSites).toBe(1);
    expect(directPoolOwner.callSites).toBe(1);
    expect([...ownerKeys(fixturePgOwners)].sort(compareText)).toEqual(
      [...ownerKeys([directPoolOwner, borrowedClientOwner])].sort(compareText),
    );
  });

  it('keeps the generated-client call sites in a different module', () => {
    expect(callSitesFor(fixture, 'prisma').length).toBeGreaterThan(0);
    expect(fixturePrismaOwners.length).toBeGreaterThan(0);

    for (const owner of fixturePrismaOwners) {
      expect(owner.file).not.toBe(driverModule);
    }
  });

  it('reports a database access style that names both drivers', () => {
    expect(fixture.projectSummary.databaseAccess.style).toBe('both');
    expect(fixture.projectSummary.databaseAccess.callSiteCount).toBeGreaterThanOrEqual(
      callSitesFor(fixture, 'pg').length + callSitesFor(fixture, 'prisma').length,
    );

    expect(pgOnlyProject.projectSummary.databaseAccess.style).toBe('pg');
    expect(prismaOnlyProject.projectSummary.databaseAccess.style).toBe('prisma');
    expect(databaseFreeProject.projectSummary.databaseAccess.style).toBe('none');
  });

  it('carries parameterised statement text, so the privacy guard has material', () => {
    const shapes = callSitesFor(fixture, 'pg')
      .map((node) => node.data.statementShape)
      .filter((shape): shape is string => shape !== undefined);

    expect(shapes).toHaveLength(2);
    for (const shape of shapes) {
      // A numbered bind placeholder and a table identifier: exactly what must
      // never reach a rationale, a hint or a log field.
      expect(shape).toMatch(/\$\d/u);
      expect(shape).toMatch(SNAKE_CASE_IDENTIFIER);
    }

    expect(leakGuard.tokens.length).toBeGreaterThan(4);
    expect(leakGuard.patterns.length).toBeGreaterThan(4);
    // The guard must reject the material it was built from, or it proves nothing.
    expect(() => {
      expectNoLeak(shapes);
    }).toThrow();
  });

  it('offers a caller that reaches exactly one of the scratch driver call sites', () => {
    const owners = querySiteOwners(pgOnlyProject, 'pg');
    expect(owners).toHaveLength(2);

    const callers = owners.map(
      (owner) => pgOnlyProject.queries.whoCalls({ file: owner.file, symbol: owner.symbol }).length,
    );
    // One of the two is called from another module and the other is not, which
    // is what the narrowing case needs in order to mean anything.
    expect(callers.filter((count) => count > 0)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Identity and claim declaration
 * ---------------------------------------------------------------------------------------------- */

describe('identity and claim declaration', () => {
  it('registers under the id its file is named for', () => {
    expect(POSTGRES_ADAPTER_ID).toBe('postgres');
    expect(createPostgresAdapter().id).toBe(POSTGRES_ADAPTER_ID);
  });

  it('claims exactly db-query-tracking, in runtime mode', () => {
    expect(POSTGRES_ADAPTER_CLAIMS).toHaveLength(1);

    const [claim] = POSTGRES_ADAPTER_CLAIMS;
    expect(claim).toBeDefined();
    expect(claim?.type).toBe('db-query-tracking');
    expect(claim?.mode).toBe('runtime');

    // Both vocabularies are closed, and a claim outside them could never be
    // matched by the registry or accepted by the plan schema.
    expect(INSTRUMENTATION_ACTION_TYPES).toContain(claim?.type);
    expect(INSTRUMENTATION_MODES).toContain(claim?.mode);

    expect(createPostgresAdapter().claims).toEqual(POSTGRES_ADAPTER_CLAIMS);
    expect(Object.isFrozen(POSTGRES_ADAPTER_CLAIMS)).toBe(true);
    expect(Object.isFrozen(claim)).toBe(true);
  });

  it('contributes exactly the driver signal key', () => {
    expect([...POSTGRES_SERVER_SIGNAL_KEYS]).toEqual(['pg']);

    for (const key of POSTGRES_SERVER_SIGNAL_KEYS) {
      expect(SERVER_AGENT_SIGNAL_KEYS).toContain(key);
      expect(CAPTURE_SIGNALS).toContain(key);
    }
    expect(Object.isFrozen(POSTGRES_SERVER_SIGNAL_KEYS)).toBe(true);
  });

  it('publishes the frozen defaults a caller is overriding', () => {
    expect(Object.isFrozen(POSTGRES_ADAPTER_DEFAULTS)).toBe(true);
    expect(POSTGRES_ADAPTER_DEFAULTS.maxTargets).toBeGreaterThanOrEqual(1);
    expect(POSTGRES_ADAPTER_DEFAULTS.maxTargets).toBeLessThanOrEqual(
      POSTGRES_ADAPTER_DEFAULTS.maxTargetsCeiling,
    );
    expect(POSTGRES_ADAPTER_DEFAULTS.heartbeatStalenessMs).toBeGreaterThan(0);
    expect(POSTGRES_ADAPTER_DEFAULTS.preloadSpecifier).toContain('@debuggen/telemetry');
    expect(POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle.length).toBeGreaterThan(0);
  });

  it('hands out independent instances', () => {
    const first = createPostgresAdapter();
    const second = createPostgresAdapter({ maxTargets: 1 });

    expect(first).not.toBe(second);
    expect(first.id).toBe(second.id);
    expect(first.claims).toEqual(second.claims);
  });

  it('registers nothing on the global object when it is imported', async () => {
    const before = new Set(Reflect.ownKeys(globalThis).map((key) => String(key)));

    vi.resetModules();
    const reimported = await import('./postgres.js');

    const after = new Set(Reflect.ownKeys(globalThis).map((key) => String(key)));
    expect([...after].filter((key) => !before.has(key))).toEqual([]);

    // A fresh evaluation declares the same identity and the same claims, so the
    // constants are module state rather than anything accumulated at import.
    expect(reimported.POSTGRES_ADAPTER_ID).toBe(POSTGRES_ADAPTER_ID);
    expect(reimported.POSTGRES_ADAPTER_CLAIMS).toEqual(POSTGRES_ADAPTER_CLAIMS);
    expect([...reimported.POSTGRES_SERVER_SIGNAL_KEYS]).toEqual([...POSTGRES_SERVER_SIGNAL_KEYS]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * canHandle: the discriminator between the two db-query-tracking claimants
 * ---------------------------------------------------------------------------------------------- */

describe('canHandle', () => {
  it('claims a project whose graph carries driver call sites, synchronously', () => {
    const probe = harnessFor(fixture);
    const claimed = createPostgresAdapter().canHandle(probe.context);

    expect(claimed).toBe(true);
    expect(typeof claimed).toBe('boolean');
    expect(claimed).not.toBeInstanceOf(Promise);
    expectNoFileAccess(probe);
  });

  it('declines a project that reaches the database only through a generated client', () => {
    const probe = harnessFor(prismaOnlyProject);

    // The decisive negative: this type is claimed by the Prisma sibling too,
    // and on this project the sibling is the one that must answer.
    expect(createPostgresAdapter().canHandle(probe.context)).toBe(false);
    expectNoFileAccess(probe);
  });

  it('claims a project whose driver handles are named nothing like a pool', () => {
    const probe = harnessFor(pgOnlyProject);

    expect(createPostgresAdapter().canHandle(probe.context)).toBe(true);
    // Detection came from the graph, not from a name: nothing in this project
    // is spelled `pool`, `client` or `db`.
    for (const owner of querySiteOwners(pgOnlyProject, 'pg')) {
      expect(owner.symbol.toLowerCase()).not.toContain('pool');
      expect(owner.symbol.toLowerCase()).not.toContain('client');
    }
    expectNoFileAccess(probe);
  });

  it('declines a project with no database access at all', () => {
    const probe = harnessFor(databaseFreeProject);

    expect(createPostgresAdapter().canHandle(probe.context)).toBe(false);
    expectNoFileAccess(probe);
  });

  it('answers the same way whatever the dev server is doing', () => {
    const adapter = createPostgresAdapter();

    for (const preset of everyPreset(fixture.root)) {
      const probe = harnessFor(fixture, preset.agent);
      expect(adapter.canHandle(probe.context), preset.label).toBe(true);
      expectNoFileAccess(probe);
    }

    for (const preset of everyPreset(prismaOnlyProject.root)) {
      const probe = harnessFor(prismaOnlyProject, preset.agent);
      expect(adapter.canHandle(probe.context), preset.label).toBe(false);
      expectNoFileAccess(probe);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan: both driver shapes, anchored on the functions that own them
 * ---------------------------------------------------------------------------------------------- */

describe('createPlan', () => {
  it('anchors both driver shapes on their enclosing server functions', async () => {
    const probe = harnessFor(fixture, attachedPreload(fixture.root));
    const actions = await createPostgresAdapter().createPlan(probe.context, databaseQuestion);

    // The expected set is derived from the graph, not written down: filter the
    // `db-call` nodes by driver, follow each one's `queries` edge to the
    // function that encloses it. A shape the adapter drops - the borrowed
    // client is the one at risk - shows up as a missing key, and one it
    // double-counts as a repeated key.
    expect(anchorKeys(actions)).toEqual(ownerKeys(fixturePgOwners));
    expect(anchorKeys(actions)).toContain(`${directPoolOwner.file}#${directPoolOwner.symbol}`);
    expect(anchorKeys(actions)).toContain(
      `${borrowedClientOwner.file}#${borrowedClientOwner.symbol}`,
    );
    expect(new Set(anchorKeys(actions)).size).toBe(actions.length);
    expectNoFileAccess(probe);
  });

  it('proposes only actions the plan schema and the feasibility gate accept', async () => {
    const probe = harnessFor(fixture);
    const actions = await createPostgresAdapter().createPlan(probe.context, databaseQuestion);

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      expect(() => instrumentationActionSchema.parse(action)).not.toThrow();
      expect(action.id).toMatch(ACTION_ID_PATTERN);
      expect(action.id.startsWith('act_')).toBe(true);
      expect(action.type).toBe('db-query-tracking');
      expect(action.mode).toBe('runtime');
      expect(INSTRUMENTATION_ACTION_TYPES).toContain(action.type);
      expect(INSTRUMENTATION_MODES).toContain(action.mode);
      expect(action.adapter).toBe(POSTGRES_ADAPTER_ID);
      expect(action.rationale.trim().length).toBeGreaterThan(0);

      // The gate the installer applies before anything else: an anchor whose
      // file and symbol the graph cannot resolve is rejected downstream, so it
      // must never be proposed.
      expect(probe.context.queries.hasSymbol(action.file, action.symbol)).toBe(true);
    }

    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
  });

  it('anchors on the enclosing function, never on a table, a statement or a handle', async () => {
    const probe = harnessFor(fixture);
    const actions = await createPostgresAdapter().createPlan(probe.context, databaseQuestion);
    const ownerSymbols = new Set(fixturePgOwners.map((owner) => owner.symbol));
    const handleNames = new Set(callSitesFor(fixture, 'pg').map((node) => node.name));

    for (const action of actions) {
      expect(ownerSymbols.has(action.symbol)).toBe(true);
      expect(handleNames.has(action.symbol)).toBe(false);
      // An identifier, so neither a statement nor a synthesised label: the
      // handle-and-method names the graph carries all contain a dot.
      expect(action.symbol).toMatch(/^[A-Za-z_$][\w$]*$/u);
      expect(action.file).toBe(driverModule);
    }
  });

  it('never points at a call site that belongs to the generated client', async () => {
    const probe = harnessFor(fixture);
    const actions = await createPostgresAdapter().createPlan(probe.context, databaseQuestion);
    const clientKeys = new Set(ownerKeys(fixturePrismaOwners));

    expect(clientKeys.size).toBeGreaterThan(0);
    for (const key of anchorKeys(actions)) {
      expect(clientKeys.has(key)).toBe(false);
    }
  });

  it('states that the signal is process-wide while the anchors are the query sites found', async () => {
    const probe = harnessFor(fixture);
    const actions = await createPostgresAdapter().createPlan(probe.context, databaseQuestion);

    for (const action of actions) {
      // The honest shape of this claim: the preload instruments the driver for
      // the whole process, so an anchor is a pointer to evidence rather than a
      // per-call installation.
      expect(action.rationale).toContain('process-wide');
      expect(action.rationale).toContain('call site');
      expect(action.rationale).not.toContain('\n');
      expect(action.rationale.length).toBeLessThanOrEqual(500);
      // Where the access shape is described at all, it is described as a
      // category - a count of call sites - and never by quoting one.
      expect(action.rationale).toMatch(/\b\d+ database call sites?\b/u);
    }
  });

  it('narrows to a function the question named', async () => {
    const probe = harnessFor(fixture);
    const named = understandingFor(
      ['pg'],
      [{ kind: 'function', name: borrowedClientOwner.symbol, file: borrowedClientOwner.file }],
    );

    const actions = await createPostgresAdapter({ maxTargets: 1 }).createPlan(probe.context, named);

    expect(anchorKeys(actions)).toEqual([
      `${borrowedClientOwner.file}#${borrowedClientOwner.symbol}`,
    ]);
  });

  it('promotes the query site that a named caller reaches', async () => {
    const owners = querySiteOwners(pgOnlyProject, 'pg');
    const reached = owners.find(
      (owner) =>
        pgOnlyProject.queries.whoCalls({ file: owner.file, symbol: owner.symbol }).length > 0,
    );
    expect(reached).toBeDefined();
    if (reached === undefined) {
      return;
    }

    const [reference] = pgOnlyProject.queries.whoCalls({
      file: reached.file,
      symbol: reached.symbol,
    });
    expect(reference).toBeDefined();
    if (reference === undefined) {
      return;
    }

    const probe = harnessFor(pgOnlyProject);
    const named = understandingFor(
      ['pg'],
      [
        {
          kind: 'function',
          name: reference.caller.name,
          file: reference.caller.file,
        },
      ],
    );

    const actions = await createPostgresAdapter({ maxTargets: 1 }).createPlan(probe.context, named);

    // The question named a caller, not a query site; the site it reaches is the
    // one worth anchoring.
    expect(anchorKeys(actions)).toEqual([`${reached.file}#${reached.symbol}`]);
  });

  it('falls back to every query site when the named entities resolve to nothing', async () => {
    const probe = harnessFor(fixture);
    const unresolvable = understandingFor(
      ['pg'],
      [{ kind: 'function', name: 'noSuchFunctionExistsHere' }],
      ['nothing-matches-this-hint'],
    );

    const actions = await createPostgresAdapter().createPlan(probe.context, unresolvable);

    // Falling back is the answer, not an empty plan and not a guess: every
    // query site the graph knows about, in its stable order.
    expect(anchorKeys(actions)).toEqual(ownerKeys(fixturePgOwners));
  });

  it('proposes nothing for a question that asks for no database or server evidence', async () => {
    const probe = harnessFor(fixture, attachedPreload(fixture.root));

    await expect(
      createPostgresAdapter().createPlan(probe.context, renderQuestion),
    ).resolves.toEqual([]);
    expectNoFileAccess(probe);
  });

  it('proposes for a question that asks only for server-tier evidence', async () => {
    const probe = harnessFor(fixture);
    const actions = await createPostgresAdapter().createPlan(probe.context, serverTierQuestion);

    expect(anchorKeys(actions)).toEqual(ownerKeys(fixturePgOwners));
  });

  it('proposes nothing once the session has been aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = harness({ project: fixture, signal: controller.signal });

    await expect(
      createPostgresAdapter().createPlan(probe.context, databaseQuestion),
    ).resolves.toEqual([]);
    expectNoFileAccess(probe);
  });

  it('returns an empty proposal, and throws nothing, when the driver is unused', async () => {
    const adapter = createPostgresAdapter();

    for (const project of [prismaOnlyProject, databaseFreeProject]) {
      const probe = harnessFor(project);
      await expect(adapter.createPlan(probe.context, databaseQuestion)).resolves.toEqual([]);
      expectNoFileAccess(probe);
    }
  });

  it('stays inside the shipped anchor budget and inside its ceiling', async () => {
    const probe = harnessFor(crowdedProject);
    const owners = querySiteOwners(crowdedProject, 'pg');
    expect(owners.length).toBe(CROWDED_OWNER_COUNT);
    expect(owners.length).toBeGreaterThan(POSTGRES_ADAPTER_DEFAULTS.maxTargetsCeiling);

    const shipped = await createPostgresAdapter().createPlan(probe.context, databaseQuestion);
    expect(shipped).toHaveLength(POSTGRES_ADAPTER_DEFAULTS.maxTargets);
    expect(anchorKeys(shipped)).toEqual(
      ownerKeys(owners.slice(0, POSTGRES_ADAPTER_DEFAULTS.maxTargets)),
    );

    // A caller may raise the budget, but not past the ceiling: a plan is shown
    // to a developer and stored on the session.
    const greedy = await createPostgresAdapter({ maxTargets: 1_000 }).createPlan(
      probe.context,
      databaseQuestion,
    );
    expect(greedy).toHaveLength(POSTGRES_ADAPTER_DEFAULTS.maxTargetsCeiling);

    const narrow = await createPostgresAdapter({ maxTargets: 2 }).createPlan(
      probe.context,
      databaseQuestion,
    );
    expect(narrow).toHaveLength(2);
  });

  it('ignores an unusable maximum in favour of the shipped default', async () => {
    const probe = harnessFor(crowdedProject);

    for (const maxTargets of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const actions = await createPostgresAdapter({ maxTargets }).createPlan(
        probe.context,
        databaseQuestion,
      );
      expect(actions, `maxTargets ${String(maxTargets)}`).toHaveLength(
        POSTGRES_ADAPTER_DEFAULTS.maxTargets,
      );
    }
  });

  it('proposes the same anchors twice, in the same order, apart from fresh ids', async () => {
    const adapter = createPostgresAdapter();
    const probe = harnessFor(fixture);

    const first = await adapter.createPlan(probe.context, databaseQuestion);
    const second = await adapter.createPlan(probe.context, databaseQuestion);

    expect(withoutIds(second)).toEqual(withoutIds(first));
    expect(anchorKeys(second)).toEqual(anchorKeys(first));
    expect(second.map((action) => action.id)).not.toEqual(first.map((action) => action.id));

    // A plan crosses a process boundary and is stored as JSON, so it has to
    // survive the round trip unchanged.
    const roundTripped: unknown = JSON.parse(JSON.stringify(first));
    expect(roundTripped).toEqual(first);
  });

  it('keeps statements, placeholders and handle names out of the plan', async () => {
    const adapter = createPostgresAdapter();

    for (const project of [fixture, pgOnlyProject, crowdedProject]) {
      const probe = harnessFor(project);
      const actions = await adapter.createPlan(probe.context, databaseQuestion);

      expect(actions.length).toBeGreaterThan(0);
      expectNoLeak(actionStrings(actions));
      expectNoLeak(logStrings(probe.logs));
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * install: arming a runtime signal, and saying so when it cannot be armed
 * ---------------------------------------------------------------------------------------------- */

/**
 * Proposes a plan and installs it against the same context.
 *
 * The pair a session actually runs, so the actions reaching `install` are the
 * ones this adapter produced rather than ones written by hand.
 *
 * @param probe The harness to run against.
 * @param adapter The adapter under test.
 * @returns The proposal and the install result.
 */
async function planAndInstall(
  probe: Harness,
  adapter = createPostgresAdapter(),
): Promise<{ readonly actions: readonly InstrumentationAction[]; readonly result: InstallResult }> {
  const actions = await adapter.createPlan(probe.context, databaseQuestion);
  const result = await adapter.install(actions, probe.context);
  return { actions, result };
}

/**
 * The single gap an install reported, asserted to be the only one.
 *
 * @param result The install result.
 * @returns The one unavailable-signal report.
 */
function onlyGap(result: InstallResult): UnavailableSignal {
  expect(result.unavailable).toHaveLength(1);
  const [gap] = result.unavailable;
  if (gap === undefined) {
    throw new Error('the install reported no unavailable signal');
  }
  return gap;
}

describe('install', () => {
  it('writes nothing, whatever the dev server looks like', async () => {
    for (const preset of everyPreset(fixture.root)) {
      const probe = harnessFor(fixture, preset.agent);
      const { result } = await planAndInstall(probe);

      expect(result.adapterId).toBe(POSTGRES_ADAPTER_ID);
      expect(result.applied, preset.label).toEqual([]);
      // No modification record, because there is no modification: the signal
      // lives in the dev-server process, not in the developer's files.
      expectNoFileAccess(probe);
    }
  });

  it('arms the signal and reports no gap when the preload is attached', async () => {
    const probe = harnessFor(fixture, attachedPreload(fixture.root));
    const { result } = await planAndInstall(probe);

    expect(result.unavailable).toEqual([]);
    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect(result.runtimeHooks).toEqual([...new Set(result.runtimeHooks)].sort(compareText));
    for (const hook of result.runtimeHooks) {
      expect(hook.trim()).toBe(hook);
      expect(hook.length).toBeGreaterThan(0);
    }

    // Browser hooks belong to the React, fetch and performance adapters; a
    // contribution here would argue with them.
    expect(Object.hasOwn(result, 'agentHooks')).toBe(false);
    expect(result.agentHooks).toBeUndefined();

    // Arming a runtime signal is not a modification: no record is journaled
    // and the backup store is never reached, even on the path that succeeds.
    expect(result.applied).toEqual([]);
    expectNoFileAccess(probe);
  });

  it('contributes the driver key alone, leaving the other signals to their owners', async () => {
    const probe = harnessFor(fixture, attachedPreload(fixture.root));
    const { result } = await planAndInstall(probe);
    const contributed = result.serverSignals ?? {};

    expect(Object.keys(contributed)).toEqual(['pg']);
    for (const key of Object.keys(contributed)) {
      expect(SERVER_AGENT_SIGNAL_KEYS).toContain(key);
    }

    // Parsed as the preload will parse it: merged onto the disabled baseline
    // and validated against the strict schema, so a hand-rolled key map or a
    // misspelled key fails here rather than on the wire.
    const merged = { ...DISABLED_SERVER_AGENT_SIGNALS, ...contributed };
    const parsed = serverAgentSignalsSchema.parse(merged);
    expect(parsed.pg).toBe(true);
    expect(parsed.prisma).toBe(DISABLED_SERVER_AGENT_SIGNALS.prisma);
    // Named function timing is the framework adapter's patch-mode business.
    expect(parsed.functions).toEqual([]);
  });

  it('reports one actionable gap naming the project when no preload is attached', async () => {
    const probe = harnessFor(fixture);
    const { result } = await planAndInstall(probe);
    const gap = onlyGap(result);

    // A missing signal is data, not a failure: the install resolved.
    expect(result.applied).toEqual([]);
    expect(result.runtimeHooks).toEqual([]);

    expect(CAPTURE_SIGNALS).toContain(gap.signal);
    expect(gap.signal).toBe('pg');

    expect(gap.reason.trim()).toBe(gap.reason);
    expect(gap.reason.length).toBeGreaterThan(0);
    expect(gap.reason).not.toContain('\n');
    expect(gap.reason).toContain('preload');
    expect(gap.reason.length).toBeLessThanOrEqual(500);

    // The hint is the one thing a developer acts on, so it names their project
    // and reads as a single instruction they can paste.
    expect(gap.hint.length).toBeGreaterThan(0);
    expect(gap.hint.trim()).toBe(gap.hint);
    expect(gap.hint).not.toContain('\n');
    expect(gap.hint).toContain(fixture.root);
    expect(gap.hint).toContain(POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle);
    expect(gap.hint.length).toBeLessThanOrEqual(500);
  });

  it('composes the hint from the project own package manager when it is known', async () => {
    expect(fixture.projectSummary.packageManager).toBe('npm');

    const probe = harnessFor(fixture);
    const actions = await createPostgresAdapter().createPlan(probe.context, databaseQuestion);
    const { result, reads } = recordingEnvReads(() =>
      createPostgresAdapter().install(actions, probe.context),
    );
    const gap = onlyGap(await result);

    expect(gap.hint).toBe(
      `Stop the dev server for ${fixture.root} and start it with NODE_OPTIONS="--import ${POSTGRES_ADAPTER_DEFAULTS.preloadSpecifier}" npm run dev - or run the "${POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle}" command in VS Code, which does it for you.`,
    );
    expect(reads).toEqual([]);
  });

  it('prefers an injected relaunch command, and reads no environment variable', async () => {
    const command = 'pnpm --filter harbour-desk dev:traced';
    const adapter = createPostgresAdapter({ relaunch: { command } });
    const probe = harnessFor(fixture);
    const actions = await adapter.createPlan(probe.context, databaseQuestion);

    // `process.env` is swapped for a recorder and restored with no await in
    // between, so any variable read here belongs to the adapter. The relaunch
    // instruction is composed from what the caller injected and from the
    // project on the context - never from the environment this suite runs in.
    const { result, reads } = recordingEnvReads(() => adapter.install(actions, probe.context));
    const gap = onlyGap(await result);

    expect(gap.hint).toBe(
      `Relaunch the dev server for ${fixture.root} with: ${command} - or run the "${POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle}" command in VS Code, which does it for you.`,
    );
    expect(gap.hint).toContain(command);
    expect(reads).toEqual([]);
  });

  it('names the editor command when the project package manager is unknown', async () => {
    expect(pgOnlyProject.projectSummary.packageManager).toBe('unknown');

    const probe = harnessFor(pgOnlyProject);
    const { result } = await planAndInstall(probe);
    const gap = onlyGap(result);

    expect(gap.hint).toBe(
      `Run the "${POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle}" command in VS Code for ${pgOnlyProject.root}, which restarts the dev server with the Debug Generator Node preload attached.`,
    );
  });

  it('treats a preload attached to another project, or a closed socket, as absent', async () => {
    const absent = onlyGap((await planAndInstall(harnessFor(fixture))).result);

    for (const agent of [foreignPreload(), disconnectedPreload(fixture.root)]) {
      const probe = harnessFor(fixture, agent);
      const { result } = await planAndInstall(probe);
      const gap = onlyGap(result);

      expect(result.runtimeHooks).toEqual([]);
      expect(gap.reason).toBe(absent.reason);
      expect(gap.hint).toBe(absent.hint);
    }
  });

  it('degrades, in different words, when the preload is connected but quiet', async () => {
    const absent = onlyGap((await planAndInstall(harnessFor(fixture))).result);

    for (const agent of [quietPreload(fixture.root), neverReportedPreload(fixture.root)]) {
      const probe = harnessFor(fixture, agent);
      const { result } = await planAndInstall(probe);
      const gap = onlyGap(result);

      // A process is holding the hook, so the hook is listed; what is reported
      // is the limitation, in wording a developer can tell from "nothing is
      // attached".
      expect(result.runtimeHooks.length).toBeGreaterThan(0);
      expect(gap.reason).not.toBe(absent.reason);
      expect(gap.hint).toContain(POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle);
    }
  });

  it('honours a configured staleness window', async () => {
    const window = 5_000;
    const agent: ObservedServerAgent = {
      connected: true,
      projectRoot: fixture.root,
      lastHeartbeatAt: NOW - (window + 1_000),
    };
    const probe = harnessFor(fixture, agent);

    // Six seconds of silence is nothing to the shipped window and everything
    // to a five-second one; the clock is frozen, so no test waits.
    const strict = await planAndInstall(
      probe,
      createPostgresAdapter({ heartbeatStalenessMs: window }),
    );
    expect(onlyGap(strict.result).reason).toContain('5s');

    const lenient = await planAndInstall(harnessFor(fixture, agent));
    expect(lenient.result.unavailable).toEqual([]);
  });

  it('stays silent when nothing of its kind was asked for', async () => {
    const probe = harnessFor(fixture);
    const result = await createPostgresAdapter().install([], probe.context);

    expect(result).toEqual({
      adapterId: POSTGRES_ADAPTER_ID,
      applied: [],
      runtimeHooks: [],
      unavailable: [],
    });
    // No key at all rather than `pg: false`: this install arms nothing, and a
    // false contribution could only argue with an adapter that does.
    expect(Object.hasOwn(result, 'serverSignals')).toBe(false);
    expectQuietLog(probe);
  });

  it('stays silent for a project that never uses the driver', async () => {
    const probe = harnessFor(prismaOnlyProject);
    const { actions, result } = await planAndInstall(probe);

    expect(actions).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.runtimeHooks).toEqual([]);
    // Nothing about `pg` is reported to a developer who never asked about it.
    expect(result.unavailable.filter((gap) => gap.signal === 'pg')).toEqual([]);
    expect(result.unavailable).toEqual([]);
    expectQuietLog(probe);
    expectNoFileAccess(probe);
  });

  it('ignores an action belonging to another adapter or to another type', async () => {
    const adapter = createPostgresAdapter();
    const probe = harnessFor(fixture, attachedPreload(fixture.root));
    const mine = await adapter.createPlan(probe.context, databaseQuestion);
    const [template] = mine;
    expect(template).toBeDefined();
    if (template === undefined) {
      return;
    }

    const foreign: InstrumentationAction[] = [
      { ...template, id: 'act_0000000000000001', adapter: 'prisma' },
      { ...template, id: 'act_0000000000000002', type: 'function-timing', mode: 'patch' },
      {
        ...template,
        id: 'act_0000000000000003',
        adapter: 'react',
        type: 'react-render-tracking',
      },
    ];

    const mixed = await adapter.install([...foreign, ...mine], probe.context);
    const filtered = await adapter.install(mine, probe.context);

    expect(mixed).toEqual(filtered);
    expect(mixed.applied).toEqual([]);
    expectNoFileAccess(probe);
  });

  it('logs through the logger it was given, at debug, and never at the session logger', async () => {
    const injected = recordingLogger();
    const probe = harness({ project: fixture, logger: noopLogger });
    const adapter = createPostgresAdapter({ logger: injected.logger });

    const actions = await adapter.createPlan(probe.context, databaseQuestion);
    await adapter.install(actions, probe.context);

    expect(injected.records.length).toBeGreaterThan(0);
    for (const record of injected.records) {
      expect(record.level).toBe('debug');
    }
    expectNoLeak(logStrings(injected.records));
  });

  it('keeps statements, shapes and credentials out of everything it reports', async () => {
    const adapter = createPostgresAdapter();

    for (const project of [fixture, pgOnlyProject, crowdedProject]) {
      for (const preset of everyPreset(project.root)) {
        const probe = harnessFor(project, preset.agent);
        const { result } = await planAndInstall(probe, adapter);

        // The assertion that distinguishes this suite from its Prisma sibling:
        // raw SQL is this adapter's material, so every emitted string and
        // every logged field is checked against the corpus's own statements.
        expectNoLeak(installStrings(result));
        expectNoLeak(logStrings(probe.logs));
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * readiness: a pure function of the observed facts
 * ---------------------------------------------------------------------------------------------- */

describe('readiness', () => {
  it('is ready with no rows for a project that does not use the driver', async () => {
    for (const project of [prismaOnlyProject, databaseFreeProject]) {
      const probe = harnessFor(project, attachedPreload(project.root));
      const report = await createPostgresAdapter().readiness(probe.context);

      expect(() => readinessSchema.parse(report)).not.toThrow();
      // "Not applicable" is expressed through the authored contract - ready,
      // with nothing to say - rather than as a signal that failed.
      expect(report.ready).toBe(true);
      expect(report.signals).toEqual([]);
      expect(report.adapter).toBe(POSTGRES_ADAPTER_ID);
      expect(report.checkedAt).toBe(NOW);
      expectNoFileAccess(probe);
    }
  });

  it('reports the signal available when the preload is attached', async () => {
    const probe = harnessFor(fixture, attachedPreload(fixture.root));
    const report = await createPostgresAdapter().readiness(probe.context);

    expect(() => readinessSchema.parse(report)).not.toThrow();
    expect(report.ready).toBe(true);
    expect(report.signals).toHaveLength(1);

    const [row] = report.signals;
    expect(row?.signal).toBe('pg');
    expect(row?.status).toBe('available');
    expect(row?.reason).toBeUndefined();
    expect(row?.hint).toBeUndefined();
  });

  it('reports the signal degraded, and still ready, when the preload is quiet', async () => {
    const probe = harnessFor(fixture, quietPreload(fixture.root));
    const report = await createPostgresAdapter().readiness(probe.context);

    const [row] = report.signals;
    expect(row?.status).toBe('degraded');
    // Degraded does not hold "Ready to capture" back; it only says what the
    // capture may be missing.
    expect(report.ready).toBe(true);
    expect((row?.reason ?? '').length).toBeGreaterThan(0);
    expect((row?.hint ?? '').length).toBeGreaterThan(0);
  });

  it('holds a capture back when no preload is attached', async () => {
    const probe = harnessFor(fixture);
    const report = await createPostgresAdapter().readiness(probe.context);

    const [row] = report.signals;
    expect(row?.status).toBe('unavailable');
    expect(report.ready).toBe(false);
    expect(row?.hint).toContain(fixture.root);
  });

  it('answers every dev-server preset with a schema-valid, self-explaining report', async () => {
    const adapter = createPostgresAdapter();

    for (const preset of everyPreset(fixture.root)) {
      const probe = harnessFor(fixture, preset.agent);
      const report = await adapter.readiness(probe.context);

      expect(() => readinessSchema.parse(report), preset.label).not.toThrow();
      expect(report.signals, preset.label).toHaveLength(1);

      for (const row of report.signals) {
        expect(READINESS_STATUSES, preset.label).toContain(row.status);
        expect(CAPTURE_SIGNALS, preset.label).toContain(row.signal);

        if (row.status === 'available') {
          continue;
        }
        // A row that is not ready owes a developer both halves: what is wrong
        // and what to do about it.
        expect((row.reason ?? '').trim().length, preset.label).toBeGreaterThan(0);
        expect((row.hint ?? '').trim().length, preset.label).toBeGreaterThan(0);
      }

      expect(report.ready, preset.label).toBe(
        report.signals.every((row) => row.status !== 'unavailable'),
      );
      expectNoLeak([
        ...report.signals.flatMap((row) => [row.signal, row.reason ?? '', row.hint ?? '']),
        JSON.stringify(report),
      ]);
    }
  });

  it('takes its timestamp from the session clock first, and from the injected one otherwise', async () => {
    const injected = NOW + 5_000;
    const probe = harnessFor(fixture, attachedPreload(fixture.root));

    const sessionWins = await createPostgresAdapter({ now: () => injected }).readiness(
      probe.context,
    );
    expect(sessionWins.checkedAt).toBe(NOW);

    // With no clock on the context, the adapter's own injected clock answers -
    // which is what lets a caller pin a `checkedAt` without freezing time.
    const contextWithoutClock: InstrumentationContext = { ...probe.context, now: undefined };
    const adapterWins = await createPostgresAdapter({ now: () => injected }).readiness(
      contextWithoutClock,
    );
    expect(adapterWins.checkedAt).toBe(injected);
  });

  it('is deterministic, serialisable, and probes nothing', async () => {
    const adapter = createPostgresAdapter();
    const probe = harnessFor(fixture, quietPreload(fixture.root));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      const first = await adapter.readiness(probe.context);
      const second = await adapter.readiness(probe.context);

      expect(second).toEqual(first);

      const roundTripped: unknown = JSON.parse(JSON.stringify(first));
      expect(roundTripped).toEqual(first);

      // Nothing is polled, spawned or connected to: readiness is a function of
      // the facts already on the context.
      expect(fetchSpy).not.toHaveBeenCalled();
      expectNoFileAccess(probe);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * remove: relinquishing a signal it never wrote
 * ---------------------------------------------------------------------------------------------- */

describe('remove', () => {
  it('has nothing to restore and nothing in conflict', async () => {
    const probe = harnessFor(fixture, attachedPreload(fixture.root));
    const adapter = createPostgresAdapter();
    const { result: installed } = await planAndInstall(probe, adapter);

    const removed = await adapter.remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, reason: 'session-end' },
      probe.context,
    );

    expect(removed.adapterId).toBe(POSTGRES_ADAPTER_ID);
    expect(removed.restored).toEqual([]);
    expect(removed.conflicts).toEqual([]);
    // What it detaches is what it armed.
    expect(removed.runtimeHooksDisabled).toEqual(installed.runtimeHooks);
    expect(removed.runtimeHooksDisabled).toEqual(
      [...new Set(removed.runtimeHooksDisabled)].sort(compareText),
    );
    expectNoFileAccess(probe);
  });

  it('claims no detachment on a reconcile, where the process is already gone', async () => {
    const probe = harnessFor(fixture);
    const removed = await createPostgresAdapter().remove(
      { sessionId: SESSION_ID, reason: 'reconcile' },
      probe.context,
    );

    expect(removed.runtimeHooksDisabled).toEqual([]);
    expect(removed.restored).toEqual([]);
    expect(removed.conflicts).toEqual([]);
  });

  it('converges when called again, with or without installed actions', async () => {
    const adapter = createPostgresAdapter();
    const probe = harnessFor(fixture, attachedPreload(fixture.root));

    // Never installed: removal is still a well-formed answer.
    const cold = await adapter.remove(
      { sessionId: SESSION_ID, reason: 'session-end' },
      probe.context,
    );

    await planAndInstall(probe, adapter);
    const warm = await adapter.remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, records: [], reason: 'session-end' },
      probe.context,
    );
    const again = await adapter.remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, records: [], reason: 'rollback' },
      probe.context,
    );

    expect(warm).toEqual(cold);
    expect(again).toEqual(warm);
    expectNoFileAccess(probe);
  });

  it('writes nothing, reaches nothing and leaks nothing while relinquishing', async () => {
    const adapter = createPostgresAdapter();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      for (const reason of ['session-end', 'rollback', 'reconcile'] as const) {
        const probe = harnessFor(fixture, attachedPreload(fixture.root));
        const removed = await adapter.remove({ sessionId: SESSION_ID, reason }, probe.context);

        expectNoFileAccess(probe);
        expectNoLeak([
          removed.adapterId,
          ...removed.runtimeHooksDisabled,
          JSON.stringify(removed),
          ...logStrings(probe.logs),
        ]);
      }

      // Disabling the signal in the dev-server process is the service's
      // `server-agent.config` message, not a call this adapter makes: it
      // reports what it relinquished and touches no socket.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The module boundary and the no-hardcoding evidence
 * ---------------------------------------------------------------------------------------------- */

describe('the module boundary', () => {
  it('imports only the adapter contract, its schemas and the two packages below it', () => {
    const source = readFileSync(ADAPTER_SOURCE_PATH, 'utf8');

    expect(boundaryFindings(source)).toEqual([]);
    // Stated positively as well, so a new import is a decision taken here
    // rather than one the forbidden list happens not to cover.
    expect(moduleSpecifiers(source)).toEqual([
      '../adapter.js',
      '../schema/plan.js',
      '../schema/readiness.js',
      '../schema/target.js',
      '@debuggen/code-analysis',
      '@debuggen/shared',
    ]);
  });

  it('would catch a sibling import, a driver, a builtin or an environment read', () => {
    const offending = [
      "import { createPrismaAdapter } from './prisma.js';",
      "import { Pool } from 'pg';",
      "import { readFileSync } from 'node:fs';",
      "import { patchFunctionTiming } from '../patch/function-timing.js';",
      "import { registerAdapter } from '../registry.js';",
      "import { somethingElse } from './helpers';",
      'const home = process.env.HOME;',
      'console.warn(home);',
    ].join('\n');

    const findings = boundaryFindings(offending);
    const matched = findings.map((finding) => finding.matched);

    expect(matched).toContain('./prisma.js');
    expect(matched).toContain('pg');
    expect(matched).toContain('node:fs');
    expect(matched).toContain('../patch/function-timing.js');
    expect(matched).toContain('../registry.js');
    expect(matched).toContain('./helpers');
    expect(findings.map((finding) => finding.rule)).toContain('reads the environment');
    expect(findings.map((finding) => finding.rule)).toContain('writes to the console');
  });

  it('names only the identifiers of the project it was given', async () => {
    const adapter = createPostgresAdapter();
    const scratchProbe = harnessFor(pgOnlyProject);
    const corpusProbe = harnessFor(fixture);

    const scratchActions = await adapter.createPlan(scratchProbe.context, databaseQuestion);
    const corpusActions = await adapter.createPlan(corpusProbe.context, databaseQuestion);
    const scratchOwners = querySiteOwners(pgOnlyProject, 'pg');

    // Every anchor is one of this project's own arbitrary identifiers, and the
    // corpus's identifiers appear nowhere in what was produced for it.
    expect(anchorKeys(scratchActions)).toEqual(ownerKeys(scratchOwners));
    const emitted = actionStrings(scratchActions).join('\n');
    for (const owner of [...fixturePgOwners, ...fixturePrismaOwners]) {
      expect(emitted).not.toContain(owner.symbol);
      expect(emitted).not.toContain(owner.file);
    }

    // The prose is the same for both projects, which is what it means for a
    // rationale to be derived from the graph rather than from knowledge of a
    // particular application.
    expect(new Set(scratchActions.map((action) => action.rationale))).toEqual(
      new Set(corpusActions.map((action) => action.rationale)),
    );
  });

  it('left the committed corpus exactly as it found it', () => {
    expect(footprintOf(FIXTURE_ROOT)).toEqual(corpusFootprint);
  });
});
