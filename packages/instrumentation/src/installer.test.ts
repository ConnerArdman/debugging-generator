/**
 * Unit suite for `./installer.ts` — the ordered installation driver.
 *
 * Six of its promises cannot be read off the type system, and each one is a
 * product guarantee rather than an implementation detail:
 *
 * 1. **Runtime hooks are armed before the first byte is written.** A capture
 *    whose signals are all satisfiable by hooks modifies nothing, and a patch
 *    that fails cannot take down signals that were already live. The ordering
 *    group asserts the observed call order across adapters, including the case
 *    where the patch-mode adapter is registered first.
 * 2. **A runtime-only plan writes nothing at all.** No modification record, no
 *    backup directory, and a project tree byte-identical afterwards — asserted
 *    by digesting every file of the copied fixture before and after, twice over,
 *    because installing the same runtime plan again must also change nothing.
 * 3. **Only "nothing at all could be enabled" is a failure.** Every other gap
 *    is reported through `unavailable` so the developer is told what the
 *    capture will still contain. An infeasible action — a generator the wrapper
 *    cannot preserve, a symbol the file does not declare — is dropped into that
 *    list by the real feasibility gate while the rest of the plan installs.
 * 4. **A delta installs only the delta.** A follow-up's plan version is the
 *    previous plan plus additive actions, so an install of it must not re-apply
 *    an action an earlier version already applied: the journal receives no
 *    second record for the carried action, and its file keeps the bytes the
 *    earlier version left.
 * 5. **A part-way failure leaves the session at its previous plan version.**
 *    The rollback group runs the **real** `restoreModification` over really
 *    patched files in a temporary project with a real backup store, and asserts
 *    byte identity by SHA-256 over raw bytes — the delta's file back to what the
 *    previous plan version left, and that version's own file still instrumented.
 * 6. **A cancelled install unwinds the same way**, whether the signal was
 *    already aborted when the call started or was aborted mid-flight.
 *
 * Three habits here are deliberate.
 *
 * - **The adapters are fakes, and never the built-in ones.** This module's
 *   subject is orchestration, the six built-in adapters have their own suites,
 *   and the driver must work with adapters it has never seen — the extension
 *   point of AAP §0.4.2. Every case therefore injects its adapters through
 *   `InstallPlanOptions.adapters`, which is itself the structural assertion that
 *   a seventh adapter needs no change here.
 * - **The writing half is not faked at all.** A patch-mode adapter here patches
 *   through the production `./patch/patcher.ts` — its hash, backup, journal,
 *   atomic-replace and mark-applied sequence — against a `mkdtemp` copy of the
 *   committed fixture project, with a real backup store under a temporary
 *   `$DEBUGGEN_HOME`. "The file comes back" can only be proven by really
 *   patching, really failing and really restoring.
 * - **The committed fixture is input, and it is read-only.** Every case works on
 *   its own copy, every copy is removed after the case that made it, and the
 *   last group re-digests the fixture itself, so `git status --porcelain
 *   packages/instrumentation` stays empty after `pnpm test`.
 */

import { Buffer } from 'node:buffer';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CodeGraph,
  buildIndex,
  createCodeQueries,
  openProject,
  routeMapFromIndex,
  summarizeProject,
} from '@debuggen/code-analysis';
import type { CodeQueries, LoadedProject, ProjectSummary, RouteMap } from '@debuggen/code-analysis';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
  isErr,
  isOk,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type {
  InstallResult,
  InstrumentationAdapter,
  InstrumentationContext,
  UnavailableSignal,
} from './adapter.js';
import { installPlan } from './installer.js';
import type { AggregateInstallResult, InstallPlanOptions } from './installer.js';
import { createBackupStore } from './patch/backup-store.js';
import { createPatcher } from './patch/patcher.js';
import type {
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from './schema/modification.js';
import { INSTRUMENTATION_PLAN_VERSION } from './schema/plan.js';
import type {
  AdapterActionResolution,
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
  InstrumentationPlan,
} from './schema/plan.js';
import {
  DISABLED_SERVER_AGENT_SIGNALS,
  buildReadiness,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
} from './schema/readiness.js';

/* -------------------------------------------------------------------------------------------------
 * The corpus: the committed fixture project every case copies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The read-only fixture project, resolved from this module's own URL.
 *
 * Not from `process.cwd()`: this package's Vitest project runs from the
 * repository root, and a relative path would resolve there instead of beside
 * this file.
 */
const FIXTURE_PROJECT = fileURLToPath(new URL('../test/fixtures/project-a', import.meta.url));

/**
 * Files and symbols of the fixture the patch-mode cases address.
 *
 * Real declarations in a real project, because the patch-mode cases run the
 * production patcher: a file or symbol that did not exist would fail the
 * transform rather than the orchestration this suite is about. Each entry is
 * spread into {@link action}, so an action names the target and nothing else
 * has to agree with it.
 */
const TARGETS = {
  /** A function declaration the wrapper template fits. */
  cones: { file: 'src/server/cone-rules.ts', symbol: 'assertConeValue' },

  /** A second declaration in the same file, for a case that needs two. */
  coneCeiling: { file: 'src/server/cone-rules.ts', symbol: 'findRampCeiling' },

  /** A third, so three patch cases can run without colliding. */
  coneProfile: { file: 'src/server/cone-rules.ts', symbol: 'findConeProfile' },

  /** A declaration in another file, so a chain never forms by accident. */
  planner: { file: 'src/server/cycle-planner.ts', symbol: 'estimateSoakMinutes' },

  /** A destructured-parameter declaration in that same other file. */
  plannerSegments: { file: 'src/server/cycle-planner.ts', symbol: 'planCycleSegments' },

  /** An exported route handler, which a `server-span` action names. */
  route: { file: 'app/api/firings/route.ts', symbol: 'POST' },

  /** A generator: the feasibility gate refuses it, and must. */
  generator: { file: 'src/server/segment-stream.ts', symbol: 'walkRampSegments' },

  /** A symbol the file does not declare: the gate refuses it too. */
  absentSymbol: { file: 'src/server/cone-rules.ts', symbol: 'noDeclarationCarriesThisName' },
} as const;

/** The marker the function-timing template leaves in a patched file. */
const PATCH_MARKER = '__DEBUGGEN__';

/**
 * Every file of a directory tree with the SHA-256 of its bytes, keyed by
 * project-relative POSIX path.
 *
 * Contents, not metadata: "the tree is byte-identical" is the claim AAP §0.5.1
 * makes, and a size and modification time can match while bytes differ.
 *
 * @param root The directory to digest.
 * @returns One entry per file, in no particular order.
 */
function treeDigests(root: string): Record<string, string> {
  const digests: Record<string, string> = {};

  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const absolute = join(entry.parentPath, entry.name);

    digests[toPosix(relative(root, absolute))] = sha256Hex(readFileSync(absolute));
  }

  return digests;
}

/**
 * The committed fixture's own digests, taken once before any case runs.
 *
 * Re-asserted by the last group: a case that worked in place instead of on its
 * copy would change one of these, and a suite that left the repository modified
 * would fail `git status --porcelain packages/instrumentation` rather than fail
 * here, which is the wrong place to find out.
 */
const FIXTURE_DIGESTS = treeDigests(FIXTURE_PROJECT);

/* -------------------------------------------------------------------------------------------------
 * Fixtures: sessions, plans and actions
 * ---------------------------------------------------------------------------------------------- */

/** The session every case installs for. */
const SESSION_ID = 'ses_installer00000001';

/** The revision every context stamps unless a case says otherwise. */
const PLAN_VERSION = 2;

/**
 * The instant every context's clock reports, in Unix epoch milliseconds.
 *
 * The context carries a clock port precisely so a record's `appliedAt` and a
 * restore's `completedAt` are stated rather than observed; a suite that let the
 * real clock through could assert that a timestamp exists and nothing more.
 */
const FIXED_NOW = 1_780_000_000_000;

/** Mints ids that match `ACTION_ID_PATTERN`. */
let actionCounter = 0;

/** What a case varies about an action. */
interface ActionInput {
  readonly adapter: string;
  readonly type?: InstrumentationActionType;
  readonly mode?: InstrumentationMode;
  readonly file?: string;
  readonly symbol?: string;
  readonly id?: string;
}

/**
 * One schema-shaped action.
 *
 * @param input The adapter it resolves to and, where a case cares, the type,
 * mode, file, symbol and id.
 * @returns The action.
 */
function action(input: ActionInput): InstrumentationAction {
  actionCounter += 1;

  return {
    id: input.id ?? `act_${String(actionCounter).padStart(16, '0')}`,
    file: input.file ?? 'src/feature/panel.tsx',
    symbol: input.symbol ?? 'handleSubmit',
    type: input.type ?? 'react-render-tracking',
    adapter: input.adapter,
    mode: input.mode ?? 'runtime',
    rationale: 'Collect the evidence this question needs.',
  };
}

/**
 * A normalised plan over the given actions.
 *
 * @param actions The plan's actions.
 * @param planVersion The revision the document claims.
 * @returns The plan.
 */
function planWith(
  actions: readonly InstrumentationAction[],
  planVersion: number = PLAN_VERSION,
): InstrumentationPlan {
  return {
    version: INSTRUMENTATION_PLAN_VERSION,
    planVersion,
    sessionId: SESSION_ID,
    objective: 'Determine where this interaction spends its time.',
    hypotheses: [],
    capture: ['click event timing', 'component renders'],
    instrumentationTargets: [...actions],
  };
}

/* -------------------------------------------------------------------------------------------------
 * Fixtures: context, logger and journal
 * ---------------------------------------------------------------------------------------------- */

/** A logger that keeps what it was told. */
interface RecordingLogger {
  readonly logger: Logger;
  readonly records: { level: string; message: string; fields: LogFields | undefined }[];
}

/**
 * A logger that records instead of printing.
 *
 * @returns The logger and its records.
 */
function recordingLogger(): RecordingLogger {
  const records: { level: string; message: string; fields: LogFields | undefined }[] = [];
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

/** One call the journal received, as the suite reads it back. */
type JournalCall =
  | { readonly op: 'append'; readonly recordId: string; readonly file: string }
  | { readonly op: 'updateStatus'; readonly recordId: string; readonly status: ModificationStatus }
  | { readonly op: 'listBySession'; readonly sessionId: string }
  | { readonly op: 'listOpen' };

/**
 * An in-memory journal, which is the port the service implements over
 * `node:sqlite` — this package never opens a database.
 *
 * Its four methods are `vi.fn` spies, so a case can assert how many times a
 * record was written as well as what the journal ended up holding, and every
 * call is appended to one ordered log: "the carried action was not journaled
 * twice" and "the rollback transitioned the record it applied, in reverse
 * order" are both statements about call order.
 */
interface FakeJournal extends ModificationJournal {
  /** Records an edit before it is written. */
  readonly append: Mock<(record: ModificationRecord) => Promise<Result<ModificationRecord>>>;

  /** Transitions a record's status, optionally patching its fields. */
  readonly updateStatus: Mock<
    (
      id: string,
      status: ModificationStatus,
      patch?: ModificationStatusPatch,
    ) => Promise<Result<ModificationRecord>>
  >;

  /** Every record of one session. */
  readonly listBySession: Mock<(sessionId: string) => Promise<Result<ModificationRecord[]>>>;

  /** Every record that is not closed. */
  readonly listOpen: Mock<() => Promise<Result<ModificationRecord[]>>>;

  /** Every record, in append order, as the journal currently holds it. */
  readonly rows: () => ModificationRecord[];

  /** Every call the journal received, in the order it received them. */
  readonly calls: () => JournalCall[];
}

/**
 * A journal that stores records in memory, applies status transitions and
 * records the order it was called in.
 *
 * @returns The journal.
 */
function fakeJournal(): FakeJournal {
  const rows = new Map<string, ModificationRecord>();
  const calls: JournalCall[] = [];

  return {
    append: vi.fn((record: ModificationRecord): Promise<Result<ModificationRecord>> => {
      calls.push({ op: 'append', recordId: record.id, file: record.file });
      rows.set(record.id, record);

      return Promise.resolve(ok(record));
    }),
    updateStatus: vi.fn(
      (
        id: string,
        status: ModificationStatus,
        patch?: ModificationStatusPatch,
      ): Promise<Result<ModificationRecord>> => {
        calls.push({ op: 'updateStatus', recordId: id, status });

        const current = rows.get(id);

        if (current === undefined) {
          // An unknown id is a persistence failure, exactly as the real store
          // reports it; fabricating a row would hide a misdirected transition.
          return Promise.resolve(
            err(
              new DebuggenError('STORE_ERROR', 'The suite journal holds no record under that id.', {
                details: { recordId: id, status },
              }),
            ),
          );
        }

        const next: ModificationRecord = { ...current, ...patch, status };

        rows.set(id, next);

        return Promise.resolve(ok(next));
      },
    ),
    listBySession: vi.fn((sessionId: string): Promise<Result<ModificationRecord[]>> => {
      calls.push({ op: 'listBySession', sessionId });

      return Promise.resolve(ok([...rows.values()].filter((row) => row.sessionId === sessionId)));
    }),
    listOpen: vi.fn((): Promise<Result<ModificationRecord[]>> => {
      calls.push({ op: 'listOpen' });

      return Promise.resolve(ok([...rows.values()].filter((row) => row.status !== 'reverted')));
    }),
    rows: (): ModificationRecord[] => [...rows.values()],
    calls: (): JournalCall[] => [...calls],
  };
}

/**
 * How many records the journal holds for one file.
 *
 * @param journal The journal to read.
 * @param file The project-relative POSIX path.
 * @returns The records for that file, in append order.
 */
function recordsFor(journal: FakeJournal, file: string): ModificationRecord[] {
  return journal.rows().filter((row) => row.file === file);
}

/**
 * The record ids the journal was asked to append, in call order.
 *
 * @param journal The journal to read.
 * @returns One id per append, in the order the appends arrived.
 */
function appendedIds(journal: FakeJournal): string[] {
  return journal
    .calls()
    .filter((entry): entry is Extract<JournalCall, { op: 'append' }> => entry.op === 'append')
    .map((entry) => entry.recordId);
}

/**
 * The record ids the journal was asked to move to one status, in call order.
 *
 * @param journal The journal to read.
 * @param status The status to look for.
 * @returns One id per transition, in the order the transitions arrived.
 */
function transitionedIds(journal: FakeJournal, status: ModificationStatus): string[] {
  return journal
    .calls()
    .filter(
      (entry): entry is Extract<JournalCall, { op: 'updateStatus' }> =>
        entry.op === 'updateStatus' && entry.status === status,
    )
    .map((entry) => entry.recordId);
}

/**
 * A code graph and query surface with only the members the installer's own
 * invariant check and the feasibility gate look for.
 *
 * The default for every case whose subject is orchestration: those either skip
 * the gate or want it to refuse everything, and indexing a project to reach
 * that outcome would test `./feasibility.ts` — which has its own suite against
 * this same fixture — rather than this module. The one case that *is* about the
 * seam between the two indexes its own copy through {@link indexProject} and
 * lets the real gate decide.
 */
const STUB_GRAPH = { nodesByFile: (): unknown[] => [] } as unknown as CodeGraph;

/** The query surface the gate's invariant check requires. */
const STUB_QUERIES = {
  hasSymbol: (): boolean => false,
  findByName: (): unknown[] => [],
} as unknown as CodeQueries;

/** Route map and project summary are read by adapters, not by this module. */
const STUB_ROUTE_MAP = {} as unknown as RouteMap;

/** The project summary, likewise unread here. */
const STUB_SUMMARY = {} as unknown as ProjectSummary;

/** A temporary directory tree for one case, with the paths it needs. */
interface Workspace {
  /** The directory holding everything this workspace contains. */
  readonly root: string;

  /** The copied fixture project, which is the install's `projectRoot`. */
  readonly projectRoot: string;

  /** The temporary `$DEBUGGEN_HOME` the backup store writes under. */
  readonly debuggenHome: string;
}

/** The directory every workspace of the current case lives in. */
let caseRoot = '';

/** Every case root this suite created, checked for removal by the last group. */
const caseRoots: string[] = [];

beforeEach(() => {
  caseRoot = mkdtempSync(join(tmpdir(), 'debuggen-installer-suite-'));
  caseRoots.push(caseRoot);
});

afterEach(() => {
  // Per case, not once at the end: a filtered run of a single case has to leave
  // as little behind as a whole-suite run, and a case that fails must not keep
  // a patched copy of the fixture alive on a shared host.
  rmSync(caseRoot, { recursive: true, force: true });
  caseRoot = '';
});

/**
 * Creates an isolated copy of the fixture project and a product state
 * directory for it.
 *
 * A copy per workspace, never the committed fixture itself: the real patcher
 * runs here and writes real bytes.
 *
 * `$DEBUGGEN_HOME` is a temporary directory too, never the developer's: the
 * backup store asserts its own state root is private and owned by this account
 * before it writes a single original into it, and a suite that pointed at the
 * real one would file a fixture's backups beside a real session's.
 *
 * A fresh directory per call, not one per case: a case that installs twice —
 * determinism, idempotence — needs two independent copies unless it deliberately
 * passes the same workspace to both installs, and two calls landing on one path
 * would have the second install patching a project the first had already
 * patched.
 *
 * @returns The workspace paths.
 */
function makeWorkspace(): Workspace {
  const root = mkdtempSync(join(caseRoot, 'workspace-'));
  const projectRoot = join(root, 'project');
  const debuggenHome = join(root, 'state');

  cpSync(FIXTURE_PROJECT, projectRoot, { recursive: true });
  mkdirSync(debuggenHome, { recursive: true, mode: 0o700 });
  chmodSync(debuggenHome, 0o700);

  return { root, projectRoot: toPosix(projectRoot), debuggenHome: toPosix(debuggenHome) };
}

/**
 * The absolute path of one file inside a workspace's project copy.
 *
 * @param workspace The workspace.
 * @param file The project-relative POSIX path.
 * @returns The absolute path.
 */
function pathIn(workspace: Workspace, file: string): string {
  return join(workspace.projectRoot, file);
}

/**
 * SHA-256 of one file's raw bytes inside a workspace's project copy.
 *
 * Digesting bytes rather than comparing decoded text is what makes "byte
 * identical" mean it: a restored file that differs only in a line ending or a
 * trailing newline would compare equal as a string in some readers and must
 * not compare equal here.
 *
 * @param workspace The workspace.
 * @param file The project-relative POSIX path.
 * @returns The digest, lowercase hex.
 */
function digestIn(workspace: Workspace, file: string): string {
  return sha256Hex(readFileSync(pathIn(workspace, file)));
}

/** One indexing of a project copy, with the handles a context needs. */
interface IndexedProject {
  readonly loaded: LoadedProject;
  readonly graph: CodeGraph;
  readonly queries: CodeQueries;
  readonly routeMap: RouteMap;
  readonly projectSummary: ProjectSummary;
}

/**
 * Opens and indexes a project copy through the cache-free path.
 *
 * `openProject` + `buildIndex` rather than `indexProject`: the latter consults
 * and populates `$DEBUGGEN_HOME/index`, which a unit suite must not touch.
 *
 * Only the cases that exercise the **real** feasibility gate need this — the
 * gate reads the graph, its query surface and the loaded syntax tree — and they
 * index the same copy the patcher then writes into, so a refusal and a patch
 * are decided against the same bytes.
 *
 * @param projectRoot The copy to index.
 * @returns The project handle, graph, queries, route map and summary.
 */
async function indexProject(projectRoot: string): Promise<IndexedProject> {
  const opened = openProject({ projectRoot });

  if (isErr(opened)) {
    throw new Error(`the fixture copy did not open: ${opened.error.message}`);
  }

  const built = await buildIndex(opened.value);

  if (isErr(built)) {
    throw new Error(`the fixture copy did not index: ${built.error.message}`);
  }

  const graph = CodeGraph.fromIndex(built.value);
  const routeMap = routeMapFromIndex(built.value);

  return {
    loaded: opened.value,
    graph,
    queries: createCodeQueries(graph, { loaded: opened.value }),
    routeMap,
    projectSummary: summarizeProject({ loaded: opened.value, graph, routeMap }),
  };
}

/** What a case varies about its context. */
interface ContextInput {
  readonly workspace?: Workspace;
  readonly planVersion?: number;
  readonly journal?: ModificationJournal;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly indexed?: IndexedProject;
  readonly now?: () => number;
}

/**
 * A context over a temporary workspace.
 *
 * @param input What this case changes.
 * @returns The context.
 */
function makeContext(input: ContextInput = {}): InstrumentationContext {
  const workspace = input.workspace ?? makeWorkspace();
  const indexed = input.indexed;

  return {
    sessionId: SESSION_ID,
    projectRoot: workspace.projectRoot,
    planVersion: input.planVersion ?? PLAN_VERSION,
    debuggenHome: workspace.debuggenHome,
    logger: input.logger ?? recordingLogger().logger,
    graph: indexed?.graph ?? STUB_GRAPH,
    queries: indexed?.queries ?? STUB_QUERIES,
    routeMap: indexed?.routeMap ?? STUB_ROUTE_MAP,
    projectSummary: indexed?.projectSummary ?? STUB_SUMMARY,
    journal: input.journal ?? fakeJournal(),
    backups: createBackupStore({
      debuggenHome: workspace.debuggenHome,
      sessionId: SESSION_ID,
    }),
    readiness: {},
    now: input.now ?? ((): number => FIXED_NOW),
    ...(indexed === undefined ? {} : { loaded: indexed.loaded }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Fixtures: adapters
 * ---------------------------------------------------------------------------------------------- */

/** An install as a fake adapter performs it. */
type FakeInstall = (
  actions: readonly InstrumentationAction[],
  context: InstrumentationContext,
) => Promise<InstallResult>;

/**
 * An adapter whose five contract methods are present and whose `install` is
 * whatever a case needs.
 *
 * @param id The adapter's id, as a plan's `adapter` field names it.
 * @param install What it does when asked.
 * @returns The adapter.
 */
function fakeAdapter(id: string, install: FakeInstall): InstrumentationAdapter {
  return {
    id,
    canHandle: (): boolean => true,
    createPlan: (): Promise<InstrumentationAction[]> => Promise.resolve([]),
    install,
    remove: () =>
      Promise.resolve({
        adapterId: id,
        restored: [],
        conflicts: [],
        runtimeHooksDisabled: [],
      }),
    readiness: () => Promise.resolve(buildReadiness({ adapter: id, signals: [] })),
  };
}

/** What a runtime adapter reports. */
interface RuntimeReport {
  readonly hooks?: readonly string[];
  readonly unavailable?: readonly UnavailableSignal[];
  readonly agentHooks?: InstallResult['agentHooks'];
  readonly serverSignals?: InstallResult['serverSignals'];
}

/**
 * An adapter that arms runtime hooks and writes nothing, recording the order it
 * was called in.
 *
 * @param id The adapter id.
 * @param calls The shared call log every adapter in a case appends to.
 * @param report What it reports.
 * @returns The adapter.
 */
function runtimeAdapter(
  id: string,
  calls: string[],
  report: RuntimeReport = {},
): InstrumentationAdapter {
  return fakeAdapter(id, (): Promise<InstallResult> => {
    calls.push(id);

    return Promise.resolve({
      adapterId: id,
      applied: [],
      runtimeHooks: [...(report.hooks ?? [`${id} hook`])],
      unavailable: [...(report.unavailable ?? [])],
      ...(report.agentHooks === undefined ? {} : { agentHooks: report.agentHooks }),
      ...(report.serverSignals === undefined ? {} : { serverSignals: report.serverSignals }),
    });
  });
}

/**
 * An adapter that really patches, through the production
 * `./patch/patcher.ts`.
 *
 * It patches exactly the actions it was handed — the file and symbol each one
 * names — and reports the records the patcher journaled, which is what the
 * rollback under test consumes. Nothing about the write path is faked: the
 * hash, the backup under the temporary `$DEBUGGEN_HOME`, the journal append,
 * the atomic replacement and the mark-applied transition are the production
 * ones, so a case can assert on the bytes that ended up on disk.
 *
 * A patch that fails is thrown rather than reported, which is the contract an
 * adapter's `install` has for a condition it cannot degrade around, and what
 * `./installer.ts` unwinds on.
 *
 * @param id The adapter's id, as a plan's `adapter` field names it.
 * @param calls The shared call log every adapter in a case appends to.
 * @param seen An optional log of the action ids it was handed, for the delta
 * cases.
 * @returns The adapter.
 */
function patchingAdapter(id: string, calls: string[], seen?: string[]): InstrumentationAdapter {
  return fakeAdapter(
    id,
    async (
      actions: readonly InstrumentationAction[],
      context: InstrumentationContext,
    ): Promise<InstallResult> => {
      calls.push(id);
      seen?.push(...actions.map((item) => item.id));

      const applied = await patchThrough(actions, context);

      return {
        adapterId: id,
        applied,
        runtimeHooks: [],
        unavailable: [],
        serverSignals: { functions: actions.map((item) => item.symbol) },
      };
    },
  );
}

/**
 * Patches a set of actions through the production patcher.
 *
 * @param actions The actions to patch, as the installer grouped and ordered
 * them.
 * @param context The session's context, supplying the project root, the session
 * id, the plan version to stamp, the backup store, the journal and the
 * cancellation signal.
 * @returns The journaled, applied records in patch order.
 * @throws {DebuggenError} Whatever the patcher refused with, so the install
 * unwinds exactly as it does for a real adapter.
 */
async function patchThrough(
  actions: readonly InstrumentationAction[],
  context: InstrumentationContext,
): Promise<ModificationRecord[]> {
  const patcher = createPatcher({
    projectRoot: context.projectRoot,
    sessionId: context.sessionId,
    planVersion: context.planVersion,
    backups: context.backups,
    journal: context.journal,
    logger: context.logger,
    // The clock and the cancellation signal are ports on the context, and a
    // real adapter forwards both rather than reaching for the globals.
    ...(context.now === undefined ? {} : { now: context.now }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const batch = await patcher.patchActions(actions);

  if (batch.failure !== undefined) {
    throw batch.failure.error;
  }

  return batch.applied.map((outcome) => outcome.record);
}

/**
 * A patch-mode adapter that fails part-way, which is the condition
 * `./installer.ts` unwinds on.
 *
 * It records that it was asked — so a case can assert it ran *after* the
 * adapter whose records have to be rolled back — and then rejects. An optional
 * hook runs first, for the case where a developer's own edit lands on the
 * instrumented file before the failure.
 *
 * @param id The adapter's id.
 * @param calls The shared call log.
 * @param error What it fails with.
 * @param before Something to do immediately before failing.
 * @returns The adapter.
 */
function throwingPatchAdapter(
  id: string,
  calls: string[],
  error: DebuggenError,
  before?: () => void,
): InstrumentationAdapter {
  return fakeAdapter(id, (): Promise<InstallResult> => {
    calls.push(id);
    before?.();

    return Promise.reject(error);
  });
}

/**
 * The single record a patch of one action produced.
 *
 * @param records What the patch applied.
 * @returns The one record.
 * @throws {Error} When the patch applied none, which would make every
 * assertion after it vacuous.
 */
function onlyRecord(records: readonly ModificationRecord[]): ModificationRecord {
  const [record] = records;

  if (record === undefined || records.length !== 1) {
    throw new Error(`expected exactly one modification record, got ${String(records.length)}`);
  }

  return record;
}

/**
 * The registry half of `InstallPlanOptions.adapters`.
 *
 * Read off the option itself rather than imported from `./registry.ts`: this
 * suite's subject is the driver's published surface, and the shape a case has
 * to satisfy is exactly the one that surface declares — so where the registry
 * type lives is not something this suite has to know.
 */
type AdapterRegistryOption = Exclude<
  InstallPlanOptions['adapters'],
  readonly InstrumentationAdapter[]
>;

/**
 * A registry over the given adapters, in registration order.
 *
 * Structural rather than the real `createAdapterRegistry`: the driver must
 * accept any registry — that is the seam that keeps a seventh adapter from
 * changing this module — and a case that needs a claim resolver can control
 * exactly what it claims.
 *
 * @param adapters The adapters, in registration order.
 * @param resolve What `resolveActionType` answers.
 * @returns The registry.
 */
function fakeRegistry(
  adapters: readonly InstrumentationAdapter[],
  resolve: (type: InstrumentationActionType) => AdapterActionResolution | undefined = () => ({
    adapter: adapters[0]?.id ?? 'none',
    mode: 'runtime',
  }),
): AdapterRegistryOption {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));

  return {
    adapters: (): readonly InstrumentationAdapter[] => [...adapters],
    get: (id: string): InstrumentationAdapter | undefined => byId.get(id),
    register: (): Result<void> => ok(undefined),
    claimants: (): readonly InstrumentationAdapter[] => [...adapters],
    resolveActionType: (type: InstrumentationActionType): AdapterActionResolution | undefined =>
      resolve(type),
    handling: (): readonly InstrumentationAdapter[] => [...adapters],
  };
}

/**
 * Unwraps a successful install, failing the case loudly when it was an error.
 *
 * @param result What {@link installPlan} returned.
 * @returns The aggregate result.
 */
function expectOk(result: Result<AggregateInstallResult>): AggregateInstallResult {
  if (isErr(result)) {
    throw new Error(`the install failed unexpectedly: ${result.error.message}`);
  }

  return result.value;
}

/**
 * Unwraps a failed install, failing the case loudly when it succeeded.
 *
 * @param result What {@link installPlan} returned.
 * @returns The error.
 */
function expectErr(result: Result<AggregateInstallResult>): DebuggenError {
  if (isOk(result)) {
    throw new Error('the install succeeded where the case expects a failure');
  }

  return result.error;
}

/* -------------------------------------------------------------------------------------------------
 * Ordering: runtime hooks before patches
 * ---------------------------------------------------------------------------------------------- */

describe('install order', () => {
  it('installs every runtime-mode group before the first patch-mode group', async () => {
    const workspace = makeWorkspace();
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];
    const patcher = patchingAdapter('framework', calls);
    const renders = runtimeAdapter('renders', calls, { hooks: ['React renders'] });
    const requests = runtimeAdapter('requests', calls, { hooks: ['Network tracing'] });
    const plan = planWith([
      action({ adapter: 'framework', type: 'server-span', mode: 'patch', ...TARGETS.route }),
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      action({ adapter: 'requests', type: 'fetch-tracking' }),
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext({ workspace }), {
        // Registration order deliberately puts the patching adapter first, so
        // only the phase rule can produce the expected order.
        adapters: [patcher, renders, requests],
        skipFeasibility: true,
      }),
    );

    expect(calls).toEqual(['renders', 'requests', 'framework']);
    expect(installed.applied).toHaveLength(1);
    expect(installed.runtimeHooks).toEqual(['React renders', 'Network tracing']);

    // The two runtime groups wrote nothing, and the patch group wrote exactly
    // the one file it was planned for: hooks before bytes, observed on disk.
    const after = treeDigests(workspace.projectRoot);

    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(Object.keys(after).filter((file) => after[file] !== before[file])).toEqual([
      TARGETS.route.file,
    ]);
    expect(readFileSync(pathIn(workspace, TARGETS.route.file), 'utf8')).toContain(PATCH_MARKER);
  }, 30_000);

  it('is deterministic: the same plan installs in the same order twice, whatever the authored order', async () => {
    const first: string[] = [];
    const second: string[] = [];
    // Two groups in each phase, so determinism is asserted *within* each phase
    // and not only across the two.
    const adapters = (calls: string[]): InstrumentationAdapter[] => [
      runtimeAdapter('alpha', calls),
      runtimeAdapter('beta', calls),
      patchingAdapter('framework', calls),
      patchingAdapter('router', calls),
    ];
    const actions = [
      action({
        adapter: 'router',
        id: 'act_0000000000000004',
        type: 'server-span',
        mode: 'patch',
        ...TARGETS.route,
      }),
      action({
        adapter: 'framework',
        id: 'act_0000000000000003',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
      action({ adapter: 'alpha', id: 'act_0000000000000001' }),
      action({ adapter: 'beta', id: 'act_0000000000000002' }),
    ];

    // Each install gets its own copy of the project, because both really
    // patch: a shared copy would have the second install patching what the
    // first had already patched.
    const firstWorkspace = makeWorkspace();
    const secondWorkspace = makeWorkspace();

    expectOk(
      await installPlan(planWith(actions), makeContext({ workspace: firstWorkspace }), {
        adapters: adapters(first),
        skipFeasibility: true,
      }),
    );
    expectOk(
      await installPlan(
        planWith([...actions].reverse()),
        makeContext({ workspace: secondWorkspace }),
        { adapters: adapters(second), skipFeasibility: true },
      ),
    );

    expect(first).toEqual(['alpha', 'beta', 'framework', 'router']);
    expect(second).toEqual(first);
    // Both runs wrote the same two files, so the order they were asked in is
    // the only thing the two runs could have differed by.
    for (const workspace of [firstWorkspace, secondWorkspace]) {
      expect(digestIn(workspace, TARGETS.cones.file)).not.toBe(FIXTURE_DIGESTS[TARGETS.cones.file]);
      expect(digestIn(workspace, TARGETS.route.file)).not.toBe(FIXTURE_DIGESTS[TARGETS.route.file]);
    }

    expect(digestIn(firstWorkspace, TARGETS.cones.file)).toBe(
      digestIn(secondWorkspace, TARGETS.cones.file),
    );
  }, 30_000);

  it('orders the actions inside one group by id, so an adapter sees a stable list', async () => {
    const seen: string[][] = [];
    const adapter = fakeAdapter('single', (actions): Promise<InstallResult> => {
      seen.push(actions.map((item) => item.id));

      return Promise.resolve({
        adapterId: 'single',
        applied: [],
        runtimeHooks: ['Browser performance'],
        unavailable: [],
      });
    });
    const plan = planWith([
      action({ adapter: 'single', id: 'act_0000000000000022' }),
      action({ adapter: 'single', id: 'act_0000000000000011' }),
    ]);

    expectOk(
      await installPlan(plan, makeContext(), { adapters: [adapter], skipFeasibility: true }),
    );

    expect(seen).toEqual([['act_0000000000000011', 'act_0000000000000022']]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Aggregation
 * ---------------------------------------------------------------------------------------------- */

describe('aggregation', () => {
  it('concatenates applied records, de-duplicates hooks and concatenates gaps', async () => {
    const workspace = makeWorkspace();
    const calls: string[] = [];
    const gap: UnavailableSignal = {
      signal: 'componentTree',
      reason: 'the page agent has not reported for the bound tab',
      hint: 'Open the application in the bound tab, then start capture again.',
    };
    const journal = fakeJournal();
    const plan = planWith([
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      action({ adapter: 'perf', type: 'perf-tracking' }),
      action({
        adapter: 'framework',
        id: 'act_0000000000000041',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
      action({
        adapter: 'framework',
        id: 'act_0000000000000042',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.planner,
      }),
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: [
          runtimeAdapter('renders', calls, {
            hooks: ['React renders', 'Browser performance'],
            unavailable: [gap],
            agentHooks: { react: true, componentTree: true },
          }),
          runtimeAdapter('perf', calls, {
            // The duplicate label must collapse, keeping first-occurrence order.
            hooks: ['Browser performance', 'Page errors'],
            agentHooks: { perf: true, errors: true },
          }),
          patchingAdapter('framework', calls),
        ],
        skipFeasibility: true,
      }),
    );

    expect(installed.runtimeHooks).toEqual(['React renders', 'Browser performance', 'Page errors']);
    // Concatenated in application order, which for one group is its actions
    // ordered by id — and both files really carry the patch.
    expect(installed.applied.map((record) => record.file)).toEqual([
      TARGETS.cones.file,
      TARGETS.planner.file,
    ]);
    expect(installed.applied.map((record) => record.status)).toEqual(['applied', 'applied']);
    expect(installed.applied.map((record) => record.planVersion)).toEqual([
      PLAN_VERSION,
      PLAN_VERSION,
    ]);
    // Stamped from the context's clock, not the host's, all the way through the
    // patcher that produced the records.
    expect(installed.applied.map((record) => record.appliedAt)).toEqual([FIXED_NOW, FIXED_NOW]);
    expect(appendedIds(journal)).toHaveLength(2);
    // The counterpart of the runtime-only case's assertion that this directory
    // is absent: a patch really does store an original under it.
    expect(existsSync(join(workspace.debuggenHome, 'backups', SESSION_ID))).toBe(true);
    expect(readFileSync(pathIn(workspace, TARGETS.cones.file), 'utf8')).toContain(PATCH_MARKER);
    expect(readFileSync(pathIn(workspace, TARGETS.planner.file), 'utf8')).toContain(PATCH_MARKER);
    expect(installed.unavailable).toEqual([gap]);
    expect(installed.perAdapter.map((result) => result.adapterId)).toEqual([
      'renders',
      'perf',
      'framework',
    ]);
    expect(installed.planVersion).toBe(PLAN_VERSION);
  }, 30_000);

  it('derives the page agent configuration from the actions that were installed', async () => {
    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      action({ adapter: 'state', type: 'state-tracking' }),
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext(), {
        adapters: [
          runtimeAdapter('renders', calls, { agentHooks: { react: true, componentTree: true } }),
          runtimeAdapter('state', calls, { agentHooks: { state: true, react: true } }),
        ],
        skipFeasibility: true,
      }),
    );

    expect(installed.agentHooks).toEqual({
      // Forced on by the derivation: without it requests leave the page
      // untraced and the browser/server correlation breaks silently.
      interactions: true,
      react: true,
      state: true,
      fetch: false,
      perf: false,
      errors: false,
      componentTree: true,
    });
    expect(installed.serverSignals).toEqual({
      http: false,
      routeHandlers: false,
      fetch: false,
      prisma: false,
      pg: false,
      functions: [],
    });
  });

  it('derives the preload signal set, keeping the spine spans on and the symbols sorted', async () => {
    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'db', type: 'db-query-tracking' }),
      action({
        adapter: 'framework',
        type: 'server-span',
        mode: 'patch',
        symbol: 'submitOrder',
      }),
      action({
        adapter: 'framework',
        type: 'function-timing',
        mode: 'patch',
        symbol: 'applyDiscounts',
      }),
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext(), {
        adapters: [
          runtimeAdapter('db', calls, { serverSignals: { prisma: true, pg: true } }),
          fakeAdapter('framework', () =>
            Promise.resolve({
              adapterId: 'framework',
              applied: [],
              runtimeHooks: ['Server request spans'],
              unavailable: [],
              serverSignals: { http: true, routeHandlers: true },
            }),
          ),
        ],
        skipFeasibility: true,
      }),
    );

    expect(installed.serverSignals).toEqual({
      http: true,
      routeHandlers: true,
      fetch: false,
      prisma: true,
      pg: true,
      functions: ['applyDiscounts', 'submitOrder'],
    });
    expect(installed.agentHooks.react).toBe(false);
  });

  it('derives both producer configurations from the installed actions, not the requested ones', async () => {
    const calls: string[] = [];
    const renderAction = action({ adapter: 'renders', type: 'react-render-tracking' });
    const perfAction = action({ adapter: 'perf', type: 'perf-tracking' });
    const databaseAction = action({ adapter: 'db', type: 'db-query-tracking' });
    const requested = [renderAction, perfAction, databaseAction];

    // Only the perf adapter enables anything; the other two report a gap, so
    // their actions are requested but never installed.
    const enabled = [perfAction];

    const installed = expectOk(
      await installPlan(planWith(requested), makeContext(), {
        adapters: [
          runtimeAdapter('renders', calls, {
            hooks: [],
            unavailable: [
              {
                signal: 'react',
                reason: 'the React hook was installed after React loaded',
                hint: 'Reload the page, then start capture again.',
              },
            ],
          }),
          runtimeAdapter('perf', calls, {
            hooks: ['Browser performance'],
            agentHooks: { perf: true, errors: true },
          }),
          runtimeAdapter('db', calls, {
            hooks: [],
            unavailable: [
              {
                signal: 'prisma',
                reason: 'no dev-server preload is attached for this project',
                hint: 'Relaunch the dev server through the extension so the preload is attached.',
              },
            ],
          }),
        ],
        skipFeasibility: true,
      }),
    );

    // Both configurations are exactly what `./schema/readiness.ts` derives for
    // the actions that were installed, and neither is what it derives for the
    // whole request — which is the difference between telling the page agent to
    // watch React and telling it to watch nothing that is not there.
    expect(installed.agentHooks).toEqual(deriveAgentHookConfig(enabled));
    expect(installed.agentHooks).not.toEqual(deriveAgentHookConfig(requested));
    expect(installed.serverSignals).toEqual(deriveServerAgentSignals(enabled));
    expect(installed.serverSignals).toEqual(DISABLED_SERVER_AGENT_SIGNALS);
    // The request would have armed the database signals; the install did not,
    // which is AAP §0.5.1's promise that an unrelated plan collects no backend
    // or database telemetry.
    expect(deriveServerAgentSignals(requested).prisma).toBe(true);

    expect(installed.agentHooks.react).toBe(false);
    expect(installed.agentHooks.perf).toBe(true);
    expect(installed.agentHooks.interactions).toBe(true);
    expect(installed.unavailable.map((entry) => entry.signal)).toEqual(['react', 'prisma']);
  });
});

/* -------------------------------------------------------------------------------------------------
 * A runtime-only plan: nothing is written, and installing it again changes nothing
 * ---------------------------------------------------------------------------------------------- */

describe('a plan every signal of which a runtime hook satisfies', () => {
  it('modifies no file, journals no record and creates no backup', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      action({ adapter: 'requests', type: 'fetch-tracking' }),
      action({ adapter: 'renders', type: 'state-tracking' }),
    ]);
    const adapters = (): InstrumentationAdapter[] => [
      runtimeAdapter('renders', calls, {
        hooks: ['React renders'],
        agentHooks: { react: true, state: true },
      }),
      runtimeAdapter('requests', calls, {
        hooks: ['Network tracing'],
        agentHooks: { fetch: true },
      }),
    ];

    const installed = expectOk(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: adapters(),
        skipFeasibility: true,
      }),
    );

    expect(installed.applied).toEqual([]);
    expect(journal.calls()).toEqual([]);
    expect(journal.append).not.toHaveBeenCalled();
    expect(journal.rows()).toEqual([]);
    // AAP §0.5.1's preferred outcome: nothing was written, so nothing has to be
    // restored and a crash leaves no journal entry to reconcile.
    expect(treeDigests(workspace.projectRoot)).toEqual(before);
    expect(existsSync(join(workspace.debuggenHome, 'backups'))).toBe(false);

    // Installing the same runtime plan again is equally inert: the second
    // install is what a re-armed capture does, and it may not start writing.
    expectOk(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: adapters(),
        skipFeasibility: true,
      }),
    );

    expect(journal.calls()).toEqual([]);
    expect(treeDigests(workspace.projectRoot)).toEqual(before);
  }, 30_000);
});

/* -------------------------------------------------------------------------------------------------
 * Degradation and the one hard failure
 * ---------------------------------------------------------------------------------------------- */

describe('graceful degradation', () => {
  it('succeeds with a non-empty gap list as long as something was enabled', async () => {
    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      action({ adapter: 'db', type: 'db-query-tracking' }),
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext(), {
        adapters: [
          runtimeAdapter('renders', calls, { agentHooks: { react: true } }),
          runtimeAdapter('db', calls, {
            hooks: [],
            unavailable: [
              {
                signal: 'pg',
                reason: 'no dev-server preload is attached for this project',
                hint: 'Relaunch the dev server through the extension so the preload is attached.',
              },
            ],
          }),
        ],
        skipFeasibility: true,
      }),
    );

    expect(installed.runtimeHooks).toEqual(['renders hook']);
    expect(installed.unavailable).toHaveLength(1);
  });

  it('reports an adapter id nothing resolves as a gap rather than throwing', async () => {
    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      action({ adapter: 'retired-adapter', type: 'fetch-tracking' }),
      action({ adapter: 'retired-adapter', type: 'fetch-tracking' }),
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext(), {
        adapters: [runtimeAdapter('renders', calls)],
        skipFeasibility: true,
      }),
    );

    // Reported once for the adapter and signal, not once per action.
    expect(installed.unavailable).toHaveLength(1);
    expect(installed.unavailable[0]?.signal).toBe('fetch');
    expect(installed.unavailable[0]?.reason).toContain('retired-adapter');
    expect(installed.runtimeHooks).toEqual(['renders hook']);
  });

  it('reports an action whose install mode is neither phase, and installs the rest', async () => {
    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      {
        ...action({ adapter: 'renders', type: 'state-tracking' }),
        mode: 'worktree' as unknown as InstrumentationMode,
      },
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext(), {
        adapters: [runtimeAdapter('renders', calls)],
        skipFeasibility: true,
      }),
    );

    expect(installed.unavailable.map((entry) => entry.signal)).toEqual(['state']);
    expect(calls).toEqual(['renders']);
  });

  it('turns every feasibility refusal into a gap and drops the action', async () => {
    const calls: string[] = [];
    const adapter = runtimeAdapter('renders', calls);
    const plan = planWith([action({ adapter: 'renders', type: 'react-render-tracking' })]);

    // A registry that claims nothing: the gate refuses the action before its
    // file is looked at, which is the cheapest refusal there is.
    const installed = await installPlan(plan, makeContext(), {
      adapters: fakeRegistry([adapter], () => undefined),
    });
    const error = expectErr(installed);

    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(calls).toEqual([]);
    expect(error.details?.['blockedSignal']).toBe('react');
    expect(error.hint).toMatch(/\S/);
  });

  it('drops the actions the real gate refuses and installs the rest of the plan', async () => {
    const workspace = makeWorkspace();
    const indexed = await indexProject(workspace.projectRoot);
    const journal = fakeJournal();
    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'renders', id: 'act_0000000000000501', type: 'react-render-tracking' }),
      // A generator: a wrapper that calls the body as a function cannot
      // preserve `yield`, and the gate refuses it by reading the real syntax
      // tree of the copied fixture.
      action({
        adapter: 'framework',
        id: 'act_0000000000000502',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.generator,
      }),
      // A symbol the file does not declare.
      action({
        adapter: 'framework',
        id: 'act_0000000000000503',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.absentSymbol,
      }),
      action({
        adapter: 'framework',
        id: 'act_0000000000000504',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
    ]);

    // The gate is deliberately NOT skipped here: this case is the seam between
    // `./feasibility.ts` and this module.
    const installed = expectOk(
      await installPlan(plan, makeContext({ workspace, journal, indexed }), {
        adapters: [
          runtimeAdapter('renders', calls, {
            hooks: ['React renders'],
            agentHooks: { react: true },
          }),
          patchingAdapter('framework', calls),
        ],
      }),
    );

    // Two refusals, in plan order, both named in the closed signal vocabulary
    // and both carrying the sentences the gate wrote for the developer.
    expect(installed.unavailable.map((gap) => gap.signal)).toEqual(['functions', 'functions']);

    for (const gap of installed.unavailable) {
      expect(gap.reason).toMatch(/\S/);
      expect(gap.hint).toMatch(/\S/);
    }

    expect(installed.unavailable[0]?.reason).toContain('generator');
    expect(installed.unavailable[1]?.reason).toContain(TARGETS.absentSymbol.symbol);

    // The rest of the plan installed: the runtime hook is armed and the one
    // feasible patch really reached its file.
    expect(calls).toEqual(['renders', 'framework']);
    expect(installed.runtimeHooks).toEqual(['React renders']);
    expect(installed.applied.map((record) => record.file)).toEqual([TARGETS.cones.file]);
    expect(readFileSync(pathIn(workspace, TARGETS.cones.file), 'utf8')).toContain(PATCH_MARKER);

    // The refused actions' file was never opened for writing: its bytes are the
    // committed fixture's.
    expect(digestIn(workspace, TARGETS.generator.file)).toBe(
      FIXTURE_DIGESTS[TARGETS.generator.file],
    );
    expect(recordsFor(journal, TARGETS.generator.file)).toEqual([]);
  }, 60_000);

  it('forwards a registry as the gate resolver and installs what it claims', async () => {
    const calls: string[] = [];
    const adapter = runtimeAdapter('renders', calls, { agentHooks: { react: true } });
    const plan = planWith([action({ adapter: 'renders', type: 'react-render-tracking' })]);

    const installed = expectOk(
      await installPlan(plan, makeContext(), {
        adapters: fakeRegistry([adapter], () => ({ adapter: 'renders', mode: 'runtime' })),
      }),
    );

    expect(calls).toEqual(['renders']);
    expect(installed.unavailable).toEqual([]);
  });
});

describe('the one hard failure', () => {
  it('fails when no hook was armed and no file was modified, quoting the blocked signal', async () => {
    const calls: string[] = [];
    const plan = planWith([action({ adapter: 'db', type: 'db-query-tracking' })]);
    const error = expectErr(
      await installPlan(plan, makeContext(), {
        adapters: [
          runtimeAdapter('db', calls, {
            hooks: [],
            unavailable: [
              {
                signal: 'prisma',
                reason: 'no dev-server preload is attached for this project',
                hint: 'Relaunch the dev server through the extension so the preload is attached.',
              },
            ],
          }),
        ],
        skipFeasibility: true,
      }),
    );

    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    // The code has to be one the protocol can carry to both user interfaces,
    // not a string invented at the throw site.
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.message).toContain('Could not enable prisma');
    // The hint is the blocked signal's own recovery action — a next step the
    // developer can take — rather than a restatement of the failure.
    expect(error.hint).toBe(
      'Relaunch the dev server through the extension so the preload is attached.',
    );
    expect(error.details?.['blockedSignal']).toBe('prisma');
  });

  it('fails for a plan with no actions at all, and says so without quoting a signal', async () => {
    const calls: string[] = [];
    const error = expectErr(
      await installPlan(planWith([]), makeContext(), {
        adapters: [runtimeAdapter('renders', calls)],
        skipFeasibility: true,
      }),
    );

    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(error.message).toContain('no installable action');
    expect(calls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Delta installs
 * ---------------------------------------------------------------------------------------------- */

describe('a follow-up delta install', () => {
  it('installs only the actions the delta names', async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const adapter = fakeAdapter('renders', (actions): Promise<InstallResult> => {
      calls.push('renders');
      seen.push(...actions.map((item) => item.id));

      return Promise.resolve({
        adapterId: 'renders',
        applied: [],
        runtimeHooks: ['React renders'],
        unavailable: [],
        agentHooks: { react: true },
      });
    });
    const carried = action({ adapter: 'renders', id: 'act_0000000000000101' });
    const added = action({
      adapter: 'renders',
      id: 'act_0000000000000102',
      type: 'state-tracking',
    });

    const installed = expectOk(
      await installPlan(planWith([carried, added], 3), makeContext({ planVersion: 3 }), {
        adapters: [adapter],
        delta: { previousPlanVersion: 2, actionIds: [added.id] },
        skipFeasibility: true,
      }),
    );

    expect(seen).toEqual([added.id]);
    expect(installed.planVersion).toBe(3);
    // Derived from the delta's action alone: the carried action is already
    // installed and is not re-armed here.
    expect(installed.agentHooks.state).toBe(true);
  });

  it('does not re-apply an action an earlier plan version already applied', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const carried = action({
      adapter: 'framework',
      id: 'act_0000000000000301',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.plannerSegments,
    });
    const added = action({
      adapter: 'framework',
      id: 'act_0000000000000302',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });

    // Plan version 1 installs the carried action for real.
    const first = expectOk(
      await installPlan(
        planWith([carried], 1),
        makeContext({ workspace, journal, planVersion: 1 }),
        {
          adapters: [patchingAdapter('framework', calls)],
          skipFeasibility: true,
        },
      ),
    );
    const carriedRecord = onlyRecord(first.applied);
    const carriedDigest = digestIn(workspace, carried.file);

    expect(carriedRecord.planVersion).toBe(1);
    expect(carriedDigest).not.toBe(FIXTURE_DIGESTS[carried.file]);

    // Plan version 2 is version 1 plus one additive action, and only the
    // addition is installed.
    const seen: string[] = [];
    const second = expectOk(
      await installPlan(
        planWith([carried, added], 2),
        makeContext({ workspace, journal, planVersion: 2 }),
        {
          adapters: [patchingAdapter('framework', calls, seen)],
          delta: { previousPlanVersion: 1, actionIds: [added.id] },
          skipFeasibility: true,
        },
      ),
    );

    expect(seen).toEqual([added.id]);
    expect(second.planVersion).toBe(2);
    expect(second.applied.map((record) => record.file)).toEqual([added.file]);
    expect(second.applied.map((record) => record.planVersion)).toEqual([2]);

    // The journal received exactly one record for the carried action's file:
    // a second patch over an already-instrumented file would make the chain
    // cleanup unwinds stop describing the file's history.
    expect(
      journal.calls().filter((entry) => entry.op === 'append' && entry.file === carried.file),
    ).toHaveLength(1);
    expect(recordsFor(journal, carried.file).map((record) => record.planVersion)).toEqual([1]);
    expect(journal.rows().find((row) => row.id === carriedRecord.id)?.status).toBe('applied');
    expect(digestIn(workspace, carried.file)).toBe(carriedDigest);
  }, 30_000);

  it('ignores a delta id the plan does not carry and installs the rest', async () => {
    const calls: string[] = [];
    const recording = recordingLogger();
    const added = action({ adapter: 'renders', id: 'act_0000000000000201' });

    const installed = expectOk(
      await installPlan(
        planWith([added], 4),
        makeContext({ planVersion: 4, logger: recording.logger }),
        {
          adapters: [runtimeAdapter('renders', calls)],
          delta: { previousPlanVersion: 3, actionIds: [added.id, 'act_0000000000000999'] },
          skipFeasibility: true,
        },
      ),
    );

    expect(calls).toEqual(['renders']);
    expect(installed.runtimeHooks).toEqual(['renders hook']);
    expect(
      recording.records.some(
        (entry) => entry.level === 'warn' && entry.message.includes('does not carry'),
      ),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Rollback: real files, real backups, real restoration
 * ---------------------------------------------------------------------------------------------- */

describe('a patch failing part-way', () => {
  it('reverse-restores exactly this call\u2019s records and leaves the previous plan version applied', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const setupCalls: string[] = [];

    // Plan version 1 is already installed, through the production patcher: its
    // file carries the patch and its record is applied.
    const previousAction = action({
      adapter: 'framework',
      id: 'act_0000000000000401',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.plannerSegments,
    });
    const previousInstall = expectOk(
      await installPlan(
        planWith([previousAction], 1),
        makeContext({ workspace, journal, planVersion: 1 }),
        { adapters: [patchingAdapter('framework', setupCalls)], skipFeasibility: true },
      ),
    );
    const previousRecord = onlyRecord(previousInstall.applied);
    const previousInstrumentedDigest = digestIn(workspace, previousAction.file);

    expect(previousInstrumentedDigest).toBe(previousRecord.instrumentedHash);
    expect(readFileSync(pathIn(workspace, previousAction.file), 'utf8')).toContain(PATCH_MARKER);

    // What the delta's own two files hold before this call touches them,
    // digested over raw bytes so "came back byte-for-byte" is checkable
    // afterwards.
    const deltaFiles = [TARGETS.cones.file, TARGETS.route.file] as const;
    const bytesBefore = new Map(
      deltaFiles.map((file) => [file, readFileSync(pathIn(workspace, file))] as const),
    );

    for (const file of deltaFiles) {
      expect(digestIn(workspace, file)).toBe(FIXTURE_DIGESTS[file]);
    }

    const calls: string[] = [];
    const failure = new DebuggenError('PATCH_UNSUPPORTED', 'The declaration cannot be wrapped.');
    const plan = planWith(
      [
        previousAction,
        action({
          adapter: 'writer',
          id: 'act_0000000000000402',
          type: 'function-timing',
          mode: 'patch',
          ...TARGETS.cones,
        }),
        action({
          adapter: 'writer',
          id: 'act_0000000000000403',
          type: 'server-span',
          mode: 'patch',
          ...TARGETS.route,
        }),
        action({
          adapter: 'thrower',
          id: 'act_0000000000000404',
          type: 'function-timing',
          mode: 'patch',
          ...TARGETS.coneCeiling,
        }),
      ],
      2,
    );

    const error = expectErr(
      await installPlan(plan, makeContext({ workspace, journal, planVersion: 2 }), {
        adapters: [
          patchingAdapter('writer', calls),
          throwingPatchAdapter('thrower', calls, failure),
        ],
        delta: {
          previousPlanVersion: 1,
          actionIds: ['act_0000000000000402', 'act_0000000000000403', 'act_0000000000000404'],
        },
        skipFeasibility: true,
      }),
    );

    expect(calls).toEqual(['writer', 'thrower']);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.cause).toBe(failure);
    expect(error.details?.['restoredCount']).toBe(2);
    expect(error.details?.['conflictCount']).toBe(0);
    expect(error.details?.['failureCount']).toBe(0);
    expect(error.details?.['previousPlanVersion']).toBe(1);
    expect(error.message).toContain('plan version 1');

    // Each of the delta's files is byte-identical to what it held before this
    // call: digest over raw bytes, and a byte comparison beside it so a mistake
    // in hashing cannot mask a mistake in content.
    for (const file of deltaFiles) {
      const before = bytesBefore.get(file);

      expect(before).toBeDefined();
      expect(digestIn(workspace, file)).toBe(sha256Hex(before ?? Buffer.alloc(0)));
      expect(Buffer.compare(readFileSync(pathIn(workspace, file)), before ?? Buffer.alloc(0))).toBe(
        0,
      );
      expect(readFileSync(pathIn(workspace, file), 'utf8')).not.toContain(PATCH_MARKER);
    }

    // Strictly latest-applied-first, which is what unwinds a chain over one
    // file in the order it was built.
    const appliedInThisCall = appendedIds(journal).filter((id) => id !== previousRecord.id);
    const revertedInOrder = transitionedIds(journal, 'reverted');

    expect(appliedInThisCall).toHaveLength(2);
    expect(revertedInOrder).toEqual([...appliedInThisCall].reverse());

    // The previous plan version's patch is untouched, and its record is still
    // applied: the session is exactly where it was.
    expect(digestIn(workspace, previousAction.file)).toBe(previousInstrumentedDigest);
    expect(readFileSync(pathIn(workspace, previousAction.file), 'utf8')).toContain(PATCH_MARKER);
    expect(journal.rows().find((row) => row.id === previousRecord.id)?.status).toBe('applied');
    expect(
      journal
        .rows()
        .filter((row) => row.planVersion === 2)
        .map((row) => row.status),
    ).toEqual(['reverted', 'reverted']);
  }, 30_000);

  it('unwinds the same way when an adapter returns something that is not an install result', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const digestBefore = digestIn(workspace, TARGETS.cones.file);
    const calls: string[] = [];
    const plan = planWith([
      action({
        adapter: 'writer',
        id: 'act_0000000000000411',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
      action({
        adapter: 'liar',
        id: 'act_0000000000000412',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.coneProfile,
      }),
    ]);

    const error = expectErr(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: [
          patchingAdapter('writer', calls),
          fakeAdapter('liar', () => {
            calls.push('liar');

            return Promise.resolve(undefined as unknown as InstallResult);
          }),
        ],
        skipFeasibility: true,
      }),
    );

    expect(calls).toEqual(['writer', 'liar']);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('invalid-result');
    expect(digestIn(workspace, TARGETS.cones.file)).toBe(digestBefore);
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
  }, 30_000);

  it('honours an abort raised while a group is running, unwinding what it had applied', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const controller = new AbortController();
    const digestBefore = digestIn(workspace, TARGETS.cones.file);
    const calls: string[] = [];
    const context = makeContext({ workspace, journal, signal: controller.signal });
    const plan = planWith([
      action({
        adapter: 'writer',
        id: 'act_0000000000000421',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
      action({
        adapter: 'second',
        id: 'act_0000000000000422',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.coneProfile,
      }),
    ]);

    const error = expectErr(
      await installPlan(plan, context, {
        adapters: [
          fakeAdapter('writer', async (actions, callContext): Promise<InstallResult> => {
            calls.push('writer');

            const applied = await patchThrough(actions, callContext);

            // The developer cancels while the first group is still running.
            controller.abort();

            return { adapterId: 'writer', applied, runtimeHooks: [], unavailable: [] };
          }),
          fakeAdapter('second', (): Promise<InstallResult> => {
            calls.push('second');

            return Promise.resolve({
              adapterId: 'second',
              applied: [],
              runtimeHooks: [],
              unavailable: [],
            });
          }),
        ],
        skipFeasibility: true,
      }),
    );

    // The second group was never asked, and what the first applied came back.
    expect(calls).toEqual(['writer']);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('aborted');
    expect(error.details?.['attempted']).toBe(1);
    expect(digestIn(workspace, TARGETS.cones.file)).toBe(digestBefore);
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
  }, 30_000);

  it('stops before asking any adapter when the signal is already aborted', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];
    const plan = planWith([
      action({
        adapter: 'writer',
        id: 'act_0000000000000431',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
    ]);

    const error = expectErr(
      await installPlan(
        plan,
        makeContext({ workspace, journal, signal: AbortSignal.abort(), planVersion: 4 }),
        { adapters: [patchingAdapter('writer', calls)], skipFeasibility: true },
      ),
    );

    expect(calls).toEqual([]);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('aborted');
    expect(error.details?.['attempted']).toBe(0);
    expect(error.details?.['planVersion']).toBe(4);
    expect(error.message).toContain('nothing had to be restored');
    // Nothing was applied, so nothing had to come back — and the project is
    // untouched rather than merely restored.
    expect(journal.calls()).toEqual([]);
    expect(treeDigests(workspace.projectRoot)).toEqual(before);
  }, 30_000);

  it('reports a rollback it could not finish instead of claiming the project is clean', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const plan = planWith([
      action({
        adapter: 'writer',
        id: 'act_0000000000000441',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
      action({
        adapter: 'thrower',
        id: 'act_0000000000000442',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.coneProfile,
      }),
    ]);
    const developerEdit = `${readFileSync(pathIn(workspace, TARGETS.cones.file), 'utf8')}\n// mine: an edit saved while the file was instrumented.\n`;

    const error = expectErr(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: [
          patchingAdapter('writer', calls),
          throwingPatchAdapter(
            'thrower',
            calls,
            new DebuggenError('PATCH_UNSUPPORTED', 'Cannot wrap that.'),
            () => {
              // The developer saves their own edit over the instrumented file
              // before the install fails: the bytes no longer match the record,
              // so the rollback may not write over them.
              writeFileSync(pathIn(workspace, TARGETS.cones.file), developerEdit);
            },
          ),
        ],
        skipFeasibility: true,
      }),
    );

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['conflictCount']).toBe(1);
    expect(error.details?.['restoredCount']).toBe(0);
    // The failure is reported rather than swallowed: the message says what was
    // left standing instead of claiming a clean project.
    expect(error.message).toContain('left exactly as they stand');
    expect(error.hint).toContain('conflicts');
    // The developer's edit is preserved, not overwritten by the rollback, and
    // the record is not claimed to be reverted.
    expect(readFileSync(pathIn(workspace, TARGETS.cones.file), 'utf8')).toBe(developerEdit);
    expect(journal.rows().map((row) => row.status)).not.toContain('reverted');
  }, 30_000);
});

/* -------------------------------------------------------------------------------------------------
 * Caller invariants
 * ---------------------------------------------------------------------------------------------- */

describe('caller invariants', () => {
  it('throws for a plan belonging to another session', async () => {
    const calls: string[] = [];
    const plan = { ...planWith([action({ adapter: 'renders' })]), sessionId: 'ses_someoneelse01' };

    await expect(
      installPlan(plan, makeContext(), {
        adapters: [runtimeAdapter('renders', calls)],
        skipFeasibility: true,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('throws for an empty adapter set, which is a wiring mistake and not a project gap', async () => {
    await expect(
      installPlan(planWith([action({ adapter: 'renders' })]), makeContext(), {
        adapters: [],
        skipFeasibility: true,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('throws for a context with no plan version to stamp', async () => {
    const calls: string[] = [];

    await expect(
      installPlan(planWith([action({ adapter: 'renders' })]), makeContext({ planVersion: 0 }), {
        adapters: [runtimeAdapter('renders', calls)],
        skipFeasibility: true,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('warns, but installs, when the plan document and the context disagree about the version', async () => {
    const calls: string[] = [];
    const recording = recordingLogger();

    expectOk(
      await installPlan(
        planWith([action({ adapter: 'renders' })], 9),
        makeContext({ planVersion: 3, logger: recording.logger }),
        { adapters: [runtimeAdapter('renders', calls)], skipFeasibility: true },
      ),
    );

    expect(
      recording.records.some(
        (entry) => entry.level === 'warn' && entry.message.includes('planVersion'),
      ),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The suite's own footprint
 * ---------------------------------------------------------------------------------------------- */

describe('the suite\u2019s own footprint', () => {
  it('removed every temporary directory it created', () => {
    // `afterEach` removes each case's root as that case ends, so by the time
    // this runs only the current case's own root may still exist.
    const leftovers = caseRoots.filter((root) => root !== caseRoot && existsSync(root));

    expect(caseRoots.length).toBeGreaterThan(1);
    expect(leftovers).toEqual([]);
  });

  it('left the committed fixture project byte-identical', () => {
    // Every case worked on a copy. If one had worked in place, a digest here
    // would differ - and `git status --porcelain packages/instrumentation`
    // would have found out later, in a worse place.
    expect(treeDigests(FIXTURE_PROJECT)).toEqual(FIXTURE_DIGESTS);
    expect(Object.keys(FIXTURE_DIGESTS).length).toBeGreaterThan(0);
  });
});
