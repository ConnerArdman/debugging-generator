/**
 * Unit suite for `./installer.ts` — the ordered installation driver.
 *
 * Ten of its promises cannot be read off the type system, and each one is a
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
 * 7. **A failure an adapter reports is fatal, not a gap.** An adapter that
 *    returns `InstallResult.failure` — the contract's fatal channel, for an
 *    action it accepted and could not complete — fails the install exactly as
 *    one that throws, and the rollback also restores the records it returned
 *    beside the failure and the record journaled for the failed attempt, in
 *    strict reverse append order. A malformed `failure` is an invalid result,
 *    and an explicit `failure: undefined` is still an ordinary success, which
 *    is what keeps the channel additive for adapters written before it.
 * 8. **The journal, not an adapter's report, decides what a rollback unwinds.**
 *    An adapter that journals a patch and then rejects, returns something that
 *    is not an install result, reports a failure without its attempt's record,
 *    or returns an ordinary result — empty, or with hooks — that leaves the
 *    record out still has its edit reversed. The record is found by the
 *    install's ledger, which saw every append through the journal the adapters
 *    were handed, and by comparing the journal with the baseline taken before
 *    the first adapter was asked, which also finds an append made past it — so
 *    an edit is reversed in the same call even when the second listing fails,
 *    and the nothing-enabled error never claims no file was modified while one
 *    stands.
 * 9. **An install never stamps a revision it is not.** A plan document whose
 *    revision differs from the context's, a delta whose predecessor is not the
 *    revision immediately before the one being installed, a journal that
 *    contradicts the revision, and a journal that cannot be read are each
 *    refused before any adapter is asked — asserted as zero journal writes, no
 *    new backup and a project tree byte-identical to what it was.
 * 10. **A target another session holds is a gap, not a failed session.** A
 *    held patch target is set aside as a Function-timing gap naming the
 *    holder and the rest installs; a held route handler's request and
 *    route-handler spans stay armed as preload residue; and when nothing else
 *    could be enabled the failure carries the holder as structured
 *    `heldTargets`, bounded like every other detail list.
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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
  InstallFailure,
  InstallResult,
  InstrumentationAdapter,
  InstrumentationContext,
  UnavailableSignal,
} from './adapter.js';
import { installPlan } from './installer.js';
import type { AggregateInstallResult, InstallPlanOptions } from './installer.js';
import { createBackupStore } from './patch/backup-store.js';
import { PATCH_TARGET_HELD_REASON, createPatcher, describeTargetYield } from './patch/patcher.js';
import type { Patcher, PatchStageObserver } from './patch/patcher.js';
import type {
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from './schema/modification.js';
import { INSTRUMENTATION_PLAN_VERSION, TARGETLESS_FILE, TARGETLESS_SYMBOL } from './schema/plan.js';
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
 * The calls that changed the journal — appends and status transitions — in
 * call order.
 *
 * Reads are not writes: the installer lists the session's records for its
 * rollback baseline, and "journals no record" is a statement about what the
 * journal ends up holding, which only these two operations can change.
 *
 * @param journal The journal to read.
 * @returns Every append and status transition it received.
 */
function journalWrites(journal: FakeJournal): JournalCall[] {
  return journal.calls().filter((entry) => entry.op === 'append' || entry.op === 'updateStatus');
}

/** A journal whose session listing can be made to fail, and the fake behind it. */
interface BreakableJournal {
  /** The journal a context is given. */
  readonly journal: ModificationJournal;

  /** The in-memory journal behind it, for assertions. */
  readonly fake: FakeJournal;

  /**
   * From now on, every session listing answers `err('STORE_ERROR')` — how the
   * service's store reports a failed read. Appends and transitions keep working.
   */
  readonly breakListings: () => void;
}

/**
 * A journal that behaves exactly like {@link fakeJournal} until its session
 * listing is broken.
 *
 * A switch rather than a call count, because more than the installer lists the
 * journal: the production patcher reads it to find a chain parent. Breaking it
 * before the install makes the rollback baseline unreadable; breaking it from
 * inside an adapter, after its patches have run, fails only the re-read a
 * failed install performs.
 *
 * @returns The journal, the fake behind it and the switch.
 */
function breakableJournal(): BreakableJournal {
  const fake = fakeJournal();
  let broken = false;

  return {
    fake,
    breakListings: (): void => {
      broken = true;
    },
    journal: {
      append: fake.append,
      updateStatus: fake.updateStatus,
      listOpen: fake.listOpen,
      listBySession: (sessionId: string): Promise<Result<ModificationRecord[]>> => {
        if (broken) {
          return Promise.resolve(
            err(
              new DebuggenError('STORE_ERROR', 'The suite journal could not be read.', {
                details: { sessionId },
              }),
            ),
          );
        }

        return fake.listBySession(sessionId);
      },
    },
  };
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
  const batch = await patcherFor(context).patchActions(actions);

  if (batch.failure !== undefined) {
    throw batch.failure.error;
  }

  return batch.applied.map((outcome) => outcome.record);
}

/**
 * The production patcher for one install call, built from the context the
 * installer handed the adapter.
 *
 * @param context The session's context, supplying the project root, the session
 * id, the plan version to stamp, the backup store, the journal, the clock and
 * the cancellation signal.
 * @param onStage A stage observer, for a case that injects a failure — or
 * raises a cancellation — at a named boundary of the write sequence.
 * @returns The patcher.
 */
function patcherFor(context: InstrumentationContext, onStage?: PatchStageObserver): Patcher {
  return createPatcher({
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
    ...(onStage === undefined ? {} : { onStage }),
  });
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

/** A fatal-channel adapter, and the failure it last reported. */
interface ReportingAdapter {
  /** The adapter, to pass in `InstallPlanOptions.adapters`. */
  readonly adapter: InstrumentationAdapter;

  /** The failure its last install returned, or `undefined` when it had none. */
  readonly reported: () => InstallFailure | undefined;
}

/**
 * A patch-mode adapter that reports a failed batch through the fatal channel
 * instead of throwing it.
 *
 * It patches exactly the actions it was handed through the production patcher
 * — an optional stage observer is where a case injects a failure — and returns
 * a stopped batch the way the adapter contract says a failed install is
 * returned: the completed records in `applied`, and the error, the target and
 * the record journaled for the failed attempt in `failure`. A batch that did
 * not stop is returned as an ordinary success. The failure it returned is kept,
 * so a case can compare the installer's error against the very object the
 * adapter reported.
 *
 * @param id The adapter's id, as a plan's `adapter` field names it.
 * @param calls The shared call log every adapter in a case appends to.
 * @param onStage A stage observer for the patcher, where a case injects its
 * failure.
 * @returns The adapter and an accessor for what it reported.
 */
function reportingPatchAdapter(
  id: string,
  calls: string[],
  onStage?: PatchStageObserver,
): ReportingAdapter {
  let reported: InstallFailure | undefined;

  const adapter = fakeAdapter(
    id,
    async (
      actions: readonly InstrumentationAction[],
      context: InstrumentationContext,
    ): Promise<InstallResult> => {
      calls.push(id);
      reported = undefined;

      const batch = await patcherFor(context, onStage).patchActions(actions);
      const applied = batch.applied.map((outcome) => outcome.record);

      if (batch.failure === undefined) {
        return {
          adapterId: id,
          applied,
          runtimeHooks: [],
          unavailable: [],
          serverSignals: { functions: actions.map((item) => item.symbol) },
        };
      }

      const { error, actionId, file, symbol, record } = batch.failure;

      reported = {
        error,
        signal: 'functions',
        file,
        symbol,
        ...(actionId === undefined ? {} : { actionId }),
        ...(record === undefined ? {} : { record }),
      };

      return { adapterId: id, applied, runtimeHooks: [], unavailable: [], failure: reported };
    },
  );

  return { adapter, reported: () => reported };
}

/**
 * A stage observer that throws right after one file's rename.
 *
 * The injected failure that leaves the most behind: the target holds the
 * patched bytes and its journal row is still the pre-write one, so only a
 * rollback that includes the failed attempt's record can bring the file back.
 *
 * @param file The project-relative file whose `'replace-file'` step fails.
 * @returns The observer.
 */
function failAfterRenameOf(file: string): PatchStageObserver {
  return (event) => {
    if (event.stage === 'replace-file' && event.file === file) {
      throw new Error(`injected: interrupted right after renaming ${file}`);
    }
  };
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
      // The server's outgoing calls ride with the spine: an external call the
      // handler awaits is part of the request tree.
      fetch: true,
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
    // One read — the rollback baseline — and not a single write.
    expect(journal.calls()).toEqual([{ op: 'listBySession', sessionId: SESSION_ID }]);
    expect(journalWrites(journal)).toEqual([]);
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

    expect(journal.calls()).toEqual([
      { op: 'listBySession', sessionId: SESSION_ID },
      { op: 'listBySession', sessionId: SESSION_ID },
    ]);
    expect(journalWrites(journal)).toEqual([]);
    expect(journal.rows()).toEqual([]);
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
      // Page-wide render tracking names the targetless marker: the real gate
      // checks every target it is given, so a runtime action naming a file the
      // copied fixture does not have would be refused alongside the patches.
      action({
        adapter: 'renders',
        id: 'act_0000000000000501',
        type: 'react-render-tracking',
        file: TARGETLESS_FILE,
        symbol: TARGETLESS_SYMBOL,
      }),
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
    const plan = planWith([
      action({
        adapter: 'renders',
        type: 'react-render-tracking',
        file: TARGETLESS_FILE,
        symbol: TARGETLESS_SYMBOL,
      }),
    ]);

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
    const plan = planWith(
      [
        action({
          adapter: 'writer',
          id: 'act_0000000000000431',
          type: 'function-timing',
          mode: 'patch',
          ...TARGETS.cones,
        }),
      ],
      4,
    );

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
    expect(error.details?.['journalReread']).toBe('not-needed');
    expect(error.message).toContain('nothing had to be restored');
    // Nothing was applied, so nothing had to come back — and the project is
    // untouched rather than merely restored. Not even the rollback baseline is
    // read: no adapter was asked, so nothing of this call's can be journaled.
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
 * The fatal channel: a failure an adapter returns rather than throws
 * ---------------------------------------------------------------------------------------------- */

describe('a failure reported through the fatal channel', () => {
  it('reverse-restores a delta whose adapter applied two targets and failed after a third one\u2019s rename', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();

    // Plan version 1 is already installed: its file carries the patch and its
    // record is applied.
    const previousAction = action({
      adapter: 'framework',
      id: 'act_0000000000000601',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.plannerSegments,
    });
    const previousInstall = expectOk(
      await installPlan(
        planWith([previousAction], 1),
        makeContext({ workspace, journal, planVersion: 1 }),
        { adapters: [patchingAdapter('framework', [])], skipFeasibility: true },
      ),
    );
    const previousRecord = onlyRecord(previousInstall.applied);
    const previousInstrumentedDigest = digestIn(workspace, previousAction.file);

    expect(previousInstrumentedDigest).toBe(previousRecord.instrumentedHash);

    // The delta's three targets, in the order the group installs them (by id).
    // The third is in plan version 1's file, so its record chains onto that
    // version's — and it is the one whose write fails after the rename.
    const route = action({
      adapter: 'writer',
      id: 'act_0000000000000602',
      type: 'server-span',
      mode: 'patch',
      ...TARGETS.route,
    });
    const cones = action({
      adapter: 'writer',
      id: 'act_0000000000000603',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const chained = action({
      adapter: 'writer',
      id: 'act_0000000000000604',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });
    const deltaFiles = [route.file, cones.file, chained.file] as const;
    const bytesBefore = new Map(
      deltaFiles.map((file) => [file, readFileSync(pathIn(workspace, file))] as const),
    );
    const appendsBefore = appendedIds(journal).length;
    const calls: string[] = [];
    const writer = reportingPatchAdapter('writer', calls, failAfterRenameOf(chained.file));

    const error = expectErr(
      await installPlan(
        planWith([previousAction, route, cones, chained], 2),
        makeContext({ workspace, journal, planVersion: 2 }),
        {
          adapters: [writer.adapter],
          delta: { previousPlanVersion: 1, actionIds: [route.id, cones.id, chained.id] },
          skipFeasibility: true,
        },
      ),
    );
    const reported = writer.reported();
    const appliedInThisCall = appendedIds(journal).slice(appendsBefore);

    // The adapter really applied two targets and journaled a third, and said so
    // through the channel rather than by throwing.
    expect(calls).toEqual(['writer']);
    expect(appliedInThisCall).toHaveLength(3);
    expect(reported?.record?.id).toBe(appliedInThisCall[2]);
    expect(reported?.record?.previousRecordId).toBe(previousRecord.id);

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.cause).toBe(reported?.error);
    expect(error.details?.['reason']).toBe('action-failed');
    expect(error.details?.['adapter']).toBe('writer');
    expect(error.details?.['previousPlanVersion']).toBe(1);
    expect(error.details?.['attempted']).toBe(3);
    expect(error.details?.['restoredCount']).toBe(3);
    expect(error.details?.['conflictCount']).toBe(0);
    expect(error.details?.['failureCount']).toBe(0);
    expect(error.details?.['failedAction']).toEqual({
      actionId: chained.id,
      file: chained.file,
      symbol: chained.symbol,
      signal: 'functions',
      code: reported?.error.code,
      recordId: appliedInThisCall[2],
      conflictReported: false,
    });
    expect(error.message).toContain('"writer"');
    expect(error.message).toContain(`${chained.symbol} in ${chained.file}`);
    expect(error.message).toContain('plan version 1');
    expect(error.hint).toBe(reported?.error.hint);

    // Strictly latest-appended-first: the failed attempt, then the two that
    // completed — which is what unwinds the chain over plan version 1's file.
    expect(transitionedIds(journal, 'reverted')).toEqual([...appliedInThisCall].reverse());
    expect(
      journal
        .rows()
        .filter((row) => row.planVersion === 2)
        .map((row) => row.status),
    ).toEqual(['reverted', 'reverted', 'reverted']);

    // Every file the delta touched holds its pre-delta bytes — plan version
    // 1's file its instrumented ones, the other two their originals.
    for (const file of deltaFiles) {
      const before = bytesBefore.get(file) ?? Buffer.alloc(0);

      expect(digestIn(workspace, file)).toBe(sha256Hex(before));
      expect(Buffer.compare(readFileSync(pathIn(workspace, file)), before)).toBe(0);
    }

    expect(digestIn(workspace, route.file)).toBe(FIXTURE_DIGESTS[route.file]);
    expect(digestIn(workspace, cones.file)).toBe(FIXTURE_DIGESTS[cones.file]);
    expect(digestIn(workspace, previousAction.file)).toBe(previousInstrumentedDigest);
    expect(journal.rows().find((row) => row.id === previousRecord.id)?.status).toBe('applied');
  }, 30_000);

  it('fails a first install after earlier groups succeeded, restoring what they wrote and quoting the failure\u2019s hint', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const refuser = reportingPatchAdapter('refuser', calls);
    const plan = planWith([
      action({ adapter: 'renders', id: 'act_0000000000000611' }),
      action({
        adapter: 'writer',
        id: 'act_0000000000000612',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
      action({
        adapter: 'refuser',
        id: 'act_0000000000000613',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.generator,
      }),
    ]);

    const error = expectErr(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: [
          runtimeAdapter('renders', calls),
          patchingAdapter('writer', calls),
          refuser.adapter,
        ],
        // Skipped on purpose: the gate would refuse the generator, and this
        // case is about a refusal that arrives after the gate admitted it.
        skipFeasibility: true,
      }),
    );
    const reported = refuser.reported();

    expect(calls).toEqual(['renders', 'writer', 'refuser']);
    expect(reported?.error.code).toBe('PATCH_UNSUPPORTED');
    expect(reported?.record).toBeUndefined();

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('action-failed');
    expect(error.details?.['adapter']).toBe('refuser');
    expect(error.details?.['attempted']).toBe(1);
    expect(error.details?.['restoredCount']).toBe(1);
    expect(error.message).toContain(`${TARGETS.generator.symbol} in ${TARGETS.generator.file}`);
    expect(error.message).toContain(reported?.error.message ?? '\u0000');
    // The project came back intact, so the hint is the failure's own: it
    // names the recovery for the cause, which a generic re-ask would not.
    expect(reported?.error.hint).toBeTruthy();
    expect(error.hint).toBe(reported?.error.hint);

    // The earlier patch adapter's record was restored; the runtime hook it ran
    // alongside is not reported, because the install is not.
    expect(digestIn(workspace, TARGETS.cones.file)).toBe(FIXTURE_DIGESTS[TARGETS.cones.file]);
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
    expect(journal.rows().map((row) => row.file)).toEqual([TARGETS.cones.file]);
  }, 30_000);

  it('says nothing had to be restored when the failure left no record at all', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];
    const refuser = reportingPatchAdapter('refuser', calls);

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'refuser',
            id: 'act_0000000000000621',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.generator,
          }),
        ]),
        makeContext({ workspace, journal }),
        { adapters: [refuser.adapter], skipFeasibility: true },
      ),
    );

    expect(calls).toEqual(['refuser']);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('action-failed');
    expect(error.details?.['attempted']).toBe(0);
    expect(error.details?.['restoredCount']).toBe(0);
    expect(error.message).toContain('nothing had to be restored');
    expect(journal.calls().filter((entry) => entry.op === 'append')).toEqual([]);
    expect(treeDigests(workspace.projectRoot)).toEqual(before);
  }, 30_000);

  it('treats a failure member that is not an object as an invalid result', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'writer',
            id: 'act_0000000000000631',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
          action({
            adapter: 'garbled',
            id: 'act_0000000000000632',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.coneProfile,
          }),
        ]),
        makeContext({ workspace, journal }),
        {
          adapters: [
            patchingAdapter('writer', calls),
            fakeAdapter('garbled', () => {
              calls.push('garbled');

              return Promise.resolve({
                adapterId: 'garbled',
                applied: [],
                runtimeHooks: [],
                unavailable: [],
                failure: 'boom',
              } as unknown as InstallResult);
            }),
          ],
          skipFeasibility: true,
        },
      ),
    );

    expect(calls).toEqual(['writer', 'garbled']);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('invalid-result');
    expect(error.details?.['failedAction']).toBeUndefined();
    expect(digestIn(workspace, TARGETS.cones.file)).toBe(FIXTURE_DIGESTS[TARGETS.cones.file]);
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
  }, 30_000);

  it('reads an explicit `failure: undefined` as an ordinary success', async () => {
    const calls: string[] = [];
    const adapter = fakeAdapter('renders', (): Promise<InstallResult> => {
      calls.push('renders');

      return Promise.resolve({
        adapterId: 'renders',
        applied: [],
        runtimeHooks: ['React renders'],
        unavailable: [],
        agentHooks: { react: true },
        failure: undefined,
      });
    });

    const installed = expectOk(
      await installPlan(planWith([action({ adapter: 'renders' })]), makeContext(), {
        adapters: [adapter],
        skipFeasibility: true,
      }),
    );

    expect(calls).toEqual(['renders']);
    expect(installed.runtimeHooks).toEqual(['React renders']);
    expect(installed.agentHooks.react).toBe(true);
    expect(installed.perAdapter.map((result) => result.adapterId)).toEqual(['renders']);
  });

  it('reports a cancellation raised inside the adapter that then returned a failure as aborted', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const controller = new AbortController();
    const calls: string[] = [];

    // The developer cancels once the first target is fully applied; the
    // patcher then abandons the second one at its first stage boundary, and
    // the adapter forwards that through the fatal channel.
    const writer = reportingPatchAdapter('writer', calls, (event) => {
      if (event.stage === 'mark-applied' && event.file === TARGETS.cones.file) {
        controller.abort();
      }
    });

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'writer',
            id: 'act_0000000000000641',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
          action({
            adapter: 'writer',
            id: 'act_0000000000000642',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.planner,
          }),
        ]),
        makeContext({ workspace, journal, signal: controller.signal }),
        { adapters: [writer.adapter], skipFeasibility: true },
      ),
    );
    const reported = writer.reported();

    expect(calls).toEqual(['writer']);
    expect(reported?.error.details?.['reason']).toBe('aborted');
    expect(reported?.file).toBe(TARGETS.planner.file);

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('aborted');
    expect(error.details?.['attempted']).toBe(1);
    expect(error.details?.['restoredCount']).toBe(1);
    expect(error.details?.['failedAction']).toMatchObject({
      file: TARGETS.planner.file,
      symbol: TARGETS.planner.symbol,
    });
    expect(error.message).toContain('cancelled');
    expect(digestIn(workspace, TARGETS.cones.file)).toBe(FIXTURE_DIGESTS[TARGETS.cones.file]);
    expect(digestIn(workspace, TARGETS.planner.file)).toBe(FIXTURE_DIGESTS[TARGETS.planner.file]);
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
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

  it('throws for a journal that cannot list a session\u2019s records, which the rollback baseline needs', async () => {
    const calls: string[] = [];
    const journal = fakeJournal();
    const withoutListing = {
      append: journal.append,
      updateStatus: journal.updateStatus,
      listOpen: journal.listOpen,
    };

    await expect(
      installPlan(
        planWith([action({ adapter: 'renders' })]),
        makeContext({ journal: withoutListing as unknown as ModificationJournal }),
        { adapters: [runtimeAdapter('renders', calls)], skipFeasibility: true },
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(calls).toEqual([]);
    expect(journal.calls()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The revision: refused before anything is armed, read or written
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every backup file under a workspace's `$DEBUGGEN_HOME`, by content.
 *
 * @param workspace The workspace to read.
 * @returns One digest per backup file, or an empty record when no backup
 * directory exists.
 */
function backupDigests(workspace: Workspace): Record<string, string> {
  const root = join(workspace.debuggenHome, 'backups');

  return existsSync(root) ? treeDigests(root) : {};
}

/**
 * Asserts that an install was refused without leaving a trace: no adapter was
 * asked, the journal received no write, the project tree is byte-identical and
 * no backup was written — no backup directory at all for a fresh session, and
 * exactly the backups taken before the refused call otherwise.
 *
 * @param input What the case observed.
 */
function expectNothingInstalled(input: {
  readonly calls: readonly string[];
  readonly journal: FakeJournal;
  readonly workspace: Workspace;
  readonly before: Record<string, string>;
  readonly appendsBefore?: number;
  readonly transitionsBefore?: number;
  readonly backupsBefore?: Record<string, string>;
}): void {
  const writes = journalWrites(input.journal);

  expect(input.calls).toEqual([]);
  expect(writes.filter((entry) => entry.op === 'append')).toHaveLength(input.appendsBefore ?? 0);
  expect(writes.filter((entry) => entry.op === 'updateStatus')).toHaveLength(
    input.transitionsBefore ?? 0,
  );
  expect(treeDigests(input.workspace.projectRoot)).toEqual(input.before);

  if (input.appendsBefore === undefined) {
    expect(existsSync(join(input.workspace.debuggenHome, 'backups'))).toBe(false);
  }

  if (input.backupsBefore !== undefined) {
    expect(backupDigests(input.workspace)).toEqual(input.backupsBefore);
  }
}

describe('a revision the context does not stamp', () => {
  it('refuses a plan document whose planVersion differs from the context, before anything is armed, read or written', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];
    const plan = planWith(
      [
        action({ adapter: 'renders', id: 'act_0000000000000701' }),
        action({
          adapter: 'framework',
          id: 'act_0000000000000702',
          type: 'function-timing',
          mode: 'patch',
          ...TARGETS.cones,
        }),
      ],
      9,
    );

    await expect(
      installPlan(plan, makeContext({ workspace, journal, planVersion: 3 }), {
        adapters: [runtimeAdapter('renders', calls), patchingAdapter('framework', calls)],
        skipFeasibility: true,
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      details: { planDocumentVersion: 9, contextPlanVersion: 3 },
    });

    // Neither the hook nor the patch ran, and the journal was not even read:
    // a record stamped 3 for a plan that says 9 is exactly what is refused.
    expectNothingInstalled({ calls, journal, workspace, before });
    expect(journal.calls()).toEqual([]);
  }, 30_000);

  it.each([
    ['equal to the revision being installed', 3],
    ['later than the revision being installed', 5],
    ['two below the revision being installed, skipping the one immediately before it', 1],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number at all', Number.NaN],
  ])(
    'refuses a delta whose previous plan version is %s',
    async (_label: string, previousPlanVersion: number) => {
      const workspace = makeWorkspace();
      const journal = fakeJournal();
      const before = treeDigests(workspace.projectRoot);
      const calls: string[] = [];
      const added = action({
        adapter: 'framework',
        id: 'act_0000000000000711',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      });

      await expect(
        installPlan(planWith([added], 3), makeContext({ workspace, journal, planVersion: 3 }), {
          adapters: [patchingAdapter('framework', calls)],
          delta: { previousPlanVersion, actionIds: [added.id] },
          skipFeasibility: true,
        }),
      ).rejects.toMatchObject({
        code: 'INTERNAL',
        details: { planVersion: 3, previousPlanVersion },
      });

      expectNothingInstalled({ calls, journal, workspace, before });
      expect(journal.calls()).toEqual([]);
    },
    30_000,
  );

  it('refuses a delta at plan version 1, which has no revision before it to build on', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];
    const added = action({
      adapter: 'framework',
      id: 'act_0000000000000715',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });

    // 0 is "planVersion minus one" arithmetically, but revisions count from 1.
    await expect(
      installPlan(planWith([added], 1), makeContext({ workspace, journal, planVersion: 1 }), {
        adapters: [patchingAdapter('framework', calls)],
        delta: { previousPlanVersion: 0, actionIds: [added.id] },
        skipFeasibility: true,
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      details: { planVersion: 1, previousPlanVersion: 0 },
    });

    expectNothingInstalled({ calls, journal, workspace, before });
    expect(journal.calls()).toEqual([]);
  }, 30_000);

  it('refuses a delta whose actionIds is not an array', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];
    const added = action({ adapter: 'renders', id: 'act_0000000000000721' });

    await expect(
      installPlan(planWith([added], 3), makeContext({ workspace, journal, planVersion: 3 }), {
        adapters: [runtimeAdapter('renders', calls)],
        delta: {
          previousPlanVersion: 2,
          actionIds: added.id as unknown as readonly string[],
        },
        skipFeasibility: true,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    expectNothingInstalled({ calls, journal, workspace, before });
    expect(journal.calls()).toEqual([]);
  });
});

describe('a revision the journal contradicts', () => {
  /**
   * Installs one patch-mode action for real at a given revision, so the
   * journal holds an `applied` record of it and its file carries the patch.
   *
   * @param workspace The project copy.
   * @param journal The journal the record lands in.
   * @param planVersion The revision to install at.
   * @param target The declaration to patch.
   * @param delta The delta, when this install is a follow-up.
   * @returns The applied record.
   */
  async function installForReal(
    workspace: Workspace,
    journal: FakeJournal,
    planVersion: number,
    target: { readonly file: string; readonly symbol: string },
    delta?: { readonly previousPlanVersion: number; readonly action: InstrumentationAction },
  ): Promise<ModificationRecord> {
    const planned =
      delta?.action ??
      action({ adapter: 'framework', type: 'function-timing', mode: 'patch', ...target });
    const installed = expectOk(
      await installPlan(
        planWith([planned], planVersion),
        makeContext({ workspace, journal, planVersion }),
        {
          adapters: [patchingAdapter('framework', [])],
          skipFeasibility: true,
          ...(delta === undefined
            ? {}
            : {
                delta: {
                  previousPlanVersion: delta.previousPlanVersion,
                  actionIds: [planned.id],
                },
              }),
        },
      ),
    );

    return onlyRecord(installed.applied);
  }

  /**
   * Brings a session to plan version 2 with a follow-up that armed only
   * runtime hooks — a revision the journal holds no record of.
   *
   * @param workspace The project copy.
   * @param journal The session's journal.
   */
  async function installRuntimeOnlyFollowUp(
    workspace: Workspace,
    journal: FakeJournal,
  ): Promise<void> {
    const added = action({ adapter: 'renders', id: 'act_0000000000000732' });

    expectOk(
      await installPlan(planWith([added], 2), makeContext({ workspace, journal, planVersion: 2 }), {
        adapters: [runtimeAdapter('renders', [])],
        delta: { previousPlanVersion: 1, actionIds: [added.id] },
        skipFeasibility: true,
      }),
    );
  }

  it.each<[string, (workspace: Workspace, journal: FakeJournal) => Promise<void>]>([
    [
      'holds only plan version 1',
      async (workspace, journal): Promise<void> => {
        await installForReal(workspace, journal, 1, TARGETS.plannerSegments);
      },
    ],
    [
      'holds plan version 1, and plan version 2 armed only runtime hooks so it journaled nothing',
      async (workspace, journal): Promise<void> => {
        await installForReal(workspace, journal, 1, TARGETS.plannerSegments);
        await installRuntimeOnlyFollowUp(workspace, journal);
      },
    ],
    [
      'holds plan versions 1 and 2',
      async (workspace, journal): Promise<void> => {
        await installForReal(workspace, journal, 1, TARGETS.plannerSegments);
        await installForReal(workspace, journal, 2, TARGETS.cones, {
          previousPlanVersion: 1,
          action: action({
            adapter: 'framework',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
        });
      },
    ],
  ])(
    'refuses plan version 3 as a delta over plan version 1 when the journal %s, before it is even read',
    async (_label, history) => {
      const workspace = makeWorkspace();
      const journal = fakeJournal();

      await history(workspace, journal);

      const before = treeDigests(workspace.projectRoot);
      const backupsBefore = backupDigests(workspace);
      const rowsBefore = journal.rows().map((row) => [row.id, row.status]);
      const callsBefore = journal.calls().length;
      const appendsBefore = appendedIds(journal).length;
      const transitionsBefore = journalWrites(journal).filter(
        (entry) => entry.op === 'updateStatus',
      ).length;
      const calls: string[] = [];
      const added = action({
        adapter: 'framework',
        id: 'act_0000000000000731',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.route,
      });

      // A follow-up builds plan version n + 1 on plan version n: skipping 2 is
      // refused whatever the journal can or cannot show about revision 2.
      await expect(
        installPlan(planWith([added], 3), makeContext({ workspace, journal, planVersion: 3 }), {
          adapters: [patchingAdapter('framework', calls)],
          delta: { previousPlanVersion: 1, actionIds: [added.id] },
          skipFeasibility: true,
        }),
      ).rejects.toMatchObject({
        code: 'INTERNAL',
        details: { previousPlanVersion: 1, planVersion: 3 },
      });

      expectNothingInstalled({
        calls,
        journal,
        workspace,
        before,
        appendsBefore,
        transitionsBefore,
        backupsBefore,
      });
      expect(journal.calls()).toHaveLength(callsBefore);
      expect(journal.rows().map((row) => [row.id, row.status])).toEqual(rowsBefore);
      expect(readFileSync(pathIn(workspace, TARGETS.route.file), 'utf8')).not.toContain(
        PATCH_MARKER,
      );
    },
    60_000,
  );

  it('refuses a delta whose predecessor is right but whose session already holds a later revision', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const later = await installForReal(workspace, journal, 3, TARGETS.plannerSegments);
    const before = treeDigests(workspace.projectRoot);
    const backupsBefore = backupDigests(workspace);
    const calls: string[] = [];
    const added = action({
      adapter: 'framework',
      id: 'act_0000000000000735',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.route,
    });

    const error = expectErr(
      await installPlan(planWith([added], 2), makeContext({ workspace, journal, planVersion: 2 }), {
        adapters: [patchingAdapter('framework', calls)],
        delta: { previousPlanVersion: 1, actionIds: [added.id] },
        skipFeasibility: true,
      }),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.details?.['reason']).toBe('plan-version-conflict');
    expect(error.details?.['previousPlanVersion']).toBe(1);
    expect(error.details?.['installedPlanVersions']).toEqual([3]);
    expect(error.details?.['conflictingRecords']).toEqual([later.id]);
    expect(error.message).toContain('which is later');

    expectNothingInstalled({
      calls,
      journal,
      workspace,
      before,
      appendsBefore: 1,
      transitionsBefore: 1,
      backupsBefore,
    });
    expect(journal.rows().map((row) => [row.id, row.status])).toEqual([[later.id, 'applied']]);
  }, 30_000);

  it('refuses a whole-plan install over a revision the journal still holds, because it would patch over it', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const carried = await installForReal(workspace, journal, 1, TARGETS.plannerSegments);
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];

    // A follow-up's plan version 2 installed without a delta would re-apply
    // the carried action as well as the added one.
    const error = expectErr(
      await installPlan(
        planWith(
          [
            action({
              adapter: 'framework',
              id: 'act_0000000000000741',
              type: 'function-timing',
              mode: 'patch',
              ...TARGETS.plannerSegments,
            }),
            action({
              adapter: 'framework',
              id: 'act_0000000000000742',
              type: 'function-timing',
              mode: 'patch',
              ...TARGETS.cones,
            }),
          ],
          2,
        ),
        makeContext({ workspace, journal, planVersion: 2 }),
        { adapters: [patchingAdapter('framework', calls)], skipFeasibility: true },
      ),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(error.details?.['reason']).toBe('plan-version-conflict');
    expect(error.details?.['previousPlanVersion']).toBeUndefined();
    expect(error.details?.['conflictingRecords']).toEqual([carried.id]);
    expect(error.hint).toContain('delta');

    expectNothingInstalled({
      calls,
      journal,
      workspace,
      before,
      appendsBefore: 1,
      transitionsBefore: 1,
    });
    expect(recordsFor(journal, TARGETS.plannerSegments.file)).toHaveLength(1);
    expect(digestIn(workspace, TARGETS.plannerSegments.file)).toBe(carried.instrumentedHash);
  }, 30_000);

  it('refuses to install an earlier revision over a later one', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const later = await installForReal(workspace, journal, 2, TARGETS.plannerSegments);
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];

    const error = expectErr(
      await installPlan(
        planWith([action({ adapter: 'renders', id: 'act_0000000000000751' })], 1),
        makeContext({ workspace, journal, planVersion: 1 }),
        { adapters: [runtimeAdapter('renders', calls)], skipFeasibility: true },
      ),
    );

    expect(error.code).toBe('SESSION_INVALID_STATE');
    expect(error.details?.['conflictingRecords']).toEqual([later.id]);
    expect(error.message).toContain('which is later');
    expectNothingInstalled({
      calls,
      journal,
      workspace,
      before,
      appendsBefore: 1,
      transitionsBefore: 1,
    });
  }, 30_000);

  it('accepts a retried install of the revision the journal already holds', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const standing = await installForReal(workspace, journal, 2, TARGETS.plannerSegments);
    const calls: string[] = [];

    // Re-arming the same revision is consistent: its records are this
    // revision's, and an adapter treats them as already applied.
    const installed = expectOk(
      await installPlan(
        planWith([action({ adapter: 'renders', id: 'act_0000000000000761' })], 2),
        makeContext({ workspace, journal, planVersion: 2 }),
        { adapters: [runtimeAdapter('renders', calls)], skipFeasibility: true },
      ),
    );

    expect(calls).toEqual(['renders']);
    expect(installed.planVersion).toBe(2);
    expect(journal.rows().find((row) => row.id === standing.id)?.status).toBe('applied');
  }, 30_000);

  it('ignores records a rollback already closed or a developer now owns', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const reverted = await installForReal(workspace, journal, 2, TARGETS.plannerSegments);
    const conflicted = await installForReal(workspace, journal, 3, TARGETS.cones, {
      previousPlanVersion: 2,
      action: action({
        adapter: 'framework',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
    });

    // Neither record stands in the project any more on the journal's account.
    expect(isOk(await journal.updateStatus(reverted.id, 'reverted'))).toBe(true);
    expect(isOk(await journal.updateStatus(conflicted.id, 'conflict'))).toBe(true);

    const calls: string[] = [];
    const installed = expectOk(
      await installPlan(
        planWith([action({ adapter: 'renders', id: 'act_0000000000000771' })], 1),
        makeContext({ workspace, journal, planVersion: 1 }),
        { adapters: [runtimeAdapter('renders', calls)], skipFeasibility: true },
      ),
    );

    expect(calls).toEqual(['renders']);
    expect(installed.planVersion).toBe(1);
  }, 30_000);

  it('refuses when the journal cannot be read for the baseline, before any adapter is asked', async () => {
    const workspace = makeWorkspace();
    const { journal, fake, breakListings } = breakableJournal();
    const before = treeDigests(workspace.projectRoot);
    const calls: string[] = [];

    breakListings();

    const error = expectErr(
      await installPlan(
        planWith([
          action({ adapter: 'renders', id: 'act_0000000000000781' }),
          action({
            adapter: 'framework',
            id: 'act_0000000000000782',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
        ]),
        makeContext({ workspace, journal }),
        {
          adapters: [runtimeAdapter('renders', calls), patchingAdapter('framework', calls)],
          skipFeasibility: true,
        },
      ),
    );

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['reason']).toBe('journal-unreadable');
    expect(error.hint).toContain('No hook was armed and no file was modified');
    expect(DebuggenError.is(error.cause)).toBe(true);
    expectNothingInstalled({ calls, journal: fake, workspace, before });
  }, 30_000);
});

/* -------------------------------------------------------------------------------------------------
 * Rollback decided by the journal: records no adapter reported
 * ---------------------------------------------------------------------------------------------- */

describe('records the journal holds that no adapter reported', () => {
  /**
   * A patch-mode adapter that really patches every action it is handed and then
   * reports none of it: it rejects, or returns something that is not an install
   * result. The edit is on disk and in the journal, and only the journal — as
   * the install's ledger saw it appended, or as a second listing shows it — can
   * tell the installer so.
   *
   * @param id The adapter's id.
   * @param calls The shared call log.
   * @param ending How it ends after patching.
   * @param afterPatching Something to do once its patches are on disk, before
   * it ends — for the case where the journal becomes unreadable right then.
   * @returns The adapter.
   */
  function silentPatchAdapter(
    id: string,
    calls: string[],
    ending: 'reject' | 'invalid-result',
    afterPatching?: () => void,
  ): InstrumentationAdapter {
    return fakeAdapter(id, async (actions, context): Promise<InstallResult> => {
      calls.push(id);
      await patchThrough(actions, context);
      afterPatching?.();

      if (ending === 'reject') {
        throw new DebuggenError('INSTRUMENTATION_INSTALL_FAILED', 'The adapter lost its way.');
      }

      return undefined as unknown as InstallResult;
    });
  }

  it('reverse-restores a patch an adapter journaled and then rejected without reporting, after the earlier group\u2019s', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const plan = planWith([
      action({
        adapter: 'writer',
        id: 'act_0000000000000801',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.cones,
      }),
      action({
        adapter: 'silent',
        id: 'act_0000000000000802',
        type: 'function-timing',
        mode: 'patch',
        ...TARGETS.planner,
      }),
    ]);

    const error = expectErr(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: [patchingAdapter('writer', calls), silentPatchAdapter('silent', calls, 'reject')],
        skipFeasibility: true,
      }),
    );
    const appended = appendedIds(journal);
    const silentRecord = recordsFor(journal, TARGETS.planner.file)[0];

    expect(calls).toEqual(['writer', 'silent']);
    expect(appended).toHaveLength(2);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('adapter-failed');
    expect(error.details?.['journalReread']).toBe('listed');
    expect(error.details?.['attempted']).toBe(2);
    expect(error.details?.['restoredCount']).toBe(2);
    expect(error.details?.['discovered']).toEqual([silentRecord?.id]);
    expect(error.details?.['discoveredCount']).toBe(1);
    expect(error.message).toContain('this install left no instrumentation in the project');

    // Both files are back to their pristine bytes, the unreported one included,
    // and they were restored last-journaled-first.
    for (const file of [TARGETS.cones.file, TARGETS.planner.file]) {
      expect(digestIn(workspace, file)).toBe(FIXTURE_DIGESTS[file]);
      expect(readFileSync(pathIn(workspace, file), 'utf8')).not.toContain(PATCH_MARKER);
    }

    expect(transitionedIds(journal, 'reverted')).toEqual([...appended].reverse());
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted', 'reverted']);
  }, 30_000);

  it('reverse-restores a patch an adapter journaled before returning something that is not an install result', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'silent',
            id: 'act_0000000000000811',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.coneProfile,
          }),
        ]),
        makeContext({ workspace, journal }),
        {
          adapters: [silentPatchAdapter('silent', calls, 'invalid-result')],
          skipFeasibility: true,
        },
      ),
    );

    expect(calls).toEqual(['silent']);
    expect(error.details?.['reason']).toBe('invalid-result');
    expect(error.details?.['attempted']).toBe(1);
    expect(error.details?.['restoredCount']).toBe(1);
    expect(error.details?.['discoveredCount']).toBe(1);
    expect(digestIn(workspace, TARGETS.coneProfile.file)).toBe(
      FIXTURE_DIGESTS[TARGETS.coneProfile.file],
    );
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
  }, 30_000);

  it('reverse-restores a failed attempt\u2019s record that the adapter left out of its failure', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const cones = action({
      adapter: 'forgetful',
      id: 'act_0000000000000821',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const planner = action({
      adapter: 'forgetful',
      id: 'act_0000000000000822',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });

    // It reports the completed record and the failure, but not the record the
    // patcher journaled for the attempt whose rename landed before it failed.
    const forgetful = fakeAdapter('forgetful', async (actions, context): Promise<InstallResult> => {
      calls.push('forgetful');

      const batch = await patcherFor(context, failAfterRenameOf(planner.file)).patchActions(
        actions,
      );
      const applied = batch.applied.map((outcome) => outcome.record);

      if (batch.failure === undefined) {
        throw new Error('the injected failure did not fire');
      }

      return {
        adapterId: 'forgetful',
        applied,
        runtimeHooks: [],
        unavailable: [],
        failure: {
          error: batch.failure.error,
          signal: 'functions',
          file: batch.failure.file,
          symbol: batch.failure.symbol,
        },
      };
    });

    const error = expectErr(
      await installPlan(planWith([cones, planner]), makeContext({ workspace, journal }), {
        adapters: [forgetful],
        skipFeasibility: true,
      }),
    );
    const appended = appendedIds(journal);
    const failedAttempt = recordsFor(journal, planner.file)[0];

    expect(calls).toEqual(['forgetful']);
    expect(appended).toHaveLength(2);
    expect(error.details?.['reason']).toBe('action-failed');
    expect(error.details?.['attempted']).toBe(2);
    expect(error.details?.['restoredCount']).toBe(2);
    expect(error.details?.['discovered']).toEqual([failedAttempt?.id]);
    expect(error.details?.['failedAction']).toMatchObject({
      file: planner.file,
      recordId: undefined,
    });

    // The file whose rename landed is back to its original bytes, as is the one
    // that completed, and the failed attempt went first.
    expect(digestIn(workspace, planner.file)).toBe(FIXTURE_DIGESTS[planner.file]);
    expect(digestIn(workspace, cones.file)).toBe(FIXTURE_DIGESTS[cones.file]);
    expect(transitionedIds(journal, 'reverted')).toEqual([...appended].reverse());
  }, 30_000);

  it('reverse-restores an unreported patch from the install ledger when the journal cannot be re-read', async () => {
    const workspace = makeWorkspace();
    const { journal, fake, breakListings } = breakableJournal();
    const calls: string[] = [];

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'writer',
            id: 'act_0000000000000831',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
          action({
            adapter: 'silent',
            id: 'act_0000000000000832',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.planner,
          }),
        ]),
        makeContext({ workspace, journal }),
        {
          adapters: [
            patchingAdapter('writer', calls),
            // The store becomes unreadable once the silent patch has landed, so
            // the baseline was taken but the rollback's re-read fails.
            silentPatchAdapter('silent', calls, 'reject', breakListings),
          ],
          skipFeasibility: true,
        },
      ),
    );

    const appended = appendedIds(fake);
    const silentRecord = recordsFor(fake, TARGETS.planner.file)[0];

    expect(calls).toEqual(['writer', 'silent']);
    expect(appended).toHaveLength(2);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('adapter-failed');
    expect(error.details?.['journalReread']).toBe('failed');
    // The ledger saw the silent adapter's append, so the failed listing hides
    // nothing that went through the journal the adapters were handed.
    expect(error.details?.['attempted']).toBe(2);
    expect(error.details?.['restoredCount']).toBe(2);
    expect(error.details?.['discovered']).toEqual([silentRecord?.id]);
    expect(error.details?.['discoveredCount']).toBe(1);
    expect(error.details?.['conflictCount']).toBe(0);
    expect(error.details?.['failureCount']).toBe(0);
    // Honest about the one thing it could not confirm, without claiming a
    // clean project or promising what a listing would have shown.
    expect(error.message).toContain(
      'All 2 file modification(s) journaled through the adapters were restored.',
    );
    expect(error.message).toContain('could not be re-read');
    expect(error.message).not.toContain('left no instrumentation');
    expect(error.hint).toContain('journal store');

    // Both patches came back in this call, last journaled first — no restart
    // and no start-up reconciliation needed.
    for (const file of [TARGETS.cones.file, TARGETS.planner.file]) {
      expect(digestIn(workspace, file)).toBe(FIXTURE_DIGESTS[file]);
      expect(readFileSync(pathIn(workspace, file), 'utf8')).not.toContain(PATCH_MARKER);
    }

    expect(transitionedIds(fake, 'reverted')).toEqual([...appended].reverse());
    expect(fake.rows().map((row) => row.status)).toEqual(['reverted', 'reverted']);
  }, 30_000);

  it('reverse-restores a patch an adapter journaled and then left out of an otherwise empty result', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const quiet = fakeAdapter('quiet', async (actions, context): Promise<InstallResult> => {
      calls.push('quiet');
      await patchThrough(actions, context);

      // A structurally valid result that describes nothing it did.
      return { adapterId: 'quiet', applied: [], runtimeHooks: [], unavailable: [] };
    });

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'quiet',
            id: 'act_0000000000000841',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.coneCeiling,
          }),
        ]),
        makeContext({ workspace, journal }),
        { adapters: [quiet], skipFeasibility: true },
      ),
    );
    const record = recordsFor(journal, TARGETS.coneCeiling.file)[0];

    expect(calls).toEqual(['quiet']);
    // Not the nothing-enabled error, which would say no file was modified.
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('unreported-modification');
    expect(error.details?.['adapter']).toBe('quiet');
    expect(error.details?.['unreported']).toBe(1);
    expect(error.details?.['journalReread']).toBe('listed');
    expect(error.details?.['discovered']).toEqual([record?.id]);
    expect(error.details?.['attempted']).toBe(1);
    expect(error.details?.['restoredCount']).toBe(1);
    expect(error.message).toContain(
      'The adapter "quiet" returned an install result that leaves out',
    );
    expect(error.message).toContain('this install left no instrumentation in the project');
    expect(error.message).not.toContain('no file was modified');
    expect(error.hint).toContain('defect in the adapter');

    expect(digestIn(workspace, TARGETS.coneCeiling.file)).toBe(
      FIXTURE_DIGESTS[TARGETS.coneCeiling.file],
    );
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
  }, 30_000);

  it('reverse-restores a patch an adapter left out of a result that armed hooks, with the earlier group\u2019s', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const hooky = fakeAdapter('hooky', async (actions, context): Promise<InstallResult> => {
      calls.push('hooky');
      await patchThrough(actions, context);

      // Reports a hook as its whole contribution, and omits the patch.
      return { adapterId: 'hooky', applied: [], runtimeHooks: ['hooky hook'], unavailable: [] };
    });

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'writer',
            id: 'act_0000000000000851',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
          action({
            adapter: 'hooky',
            id: 'act_0000000000000852',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.planner,
          }),
        ]),
        makeContext({ workspace, journal }),
        { adapters: [patchingAdapter('writer', calls), hooky], skipFeasibility: true },
      ),
    );
    const appended = appendedIds(journal);
    const hookyRecord = recordsFor(journal, TARGETS.planner.file)[0];

    expect(calls).toEqual(['writer', 'hooky']);
    expect(appended).toHaveLength(2);
    expect(error.details?.['reason']).toBe('unreported-modification');
    expect(error.details?.['adapter']).toBe('hooky');
    expect(error.details?.['unreported']).toBe(1);
    expect(error.details?.['discovered']).toEqual([hookyRecord?.id]);
    expect(error.details?.['attempted']).toBe(2);
    expect(error.details?.['restoredCount']).toBe(2);

    for (const file of [TARGETS.cones.file, TARGETS.planner.file]) {
      expect(digestIn(workspace, file)).toBe(FIXTURE_DIGESTS[file]);
    }

    expect(transitionedIds(journal, 'reverted')).toEqual([...appended].reverse());
  }, 30_000);

  it('unwinds a patch journaled past the adapters\u2019 journal before reporting that nothing was enabled', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    // Journals through the session's store directly rather than the journal it
    // was handed, so only the installer's listing can find the record.
    const bypassing = fakeAdapter('bypassing', async (actions, context): Promise<InstallResult> => {
      calls.push('bypassing');

      const batch = await patcherFor({ ...context, journal }).patchActions(actions);

      if (batch.failure !== undefined) {
        throw batch.failure.error;
      }

      return {
        adapterId: 'bypassing',
        applied: [],
        runtimeHooks: [],
        unavailable: [
          {
            signal: 'functions',
            reason: 'the adapter chose not to say',
            hint: 'Ask the question again.',
          },
        ],
      };
    });

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'bypassing',
            id: 'act_0000000000000861',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.coneProfile,
          }),
        ]),
        makeContext({ workspace, journal }),
        { adapters: [bypassing], skipFeasibility: true },
      ),
    );
    const record = recordsFor(journal, TARGETS.coneProfile.file)[0];

    expect(calls).toEqual(['bypassing']);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('unreported-modification');
    expect(error.details?.['adapter']).toBeUndefined();
    expect(error.details?.['unreported']).toBe(1);
    expect(error.details?.['journalReread']).toBe('listed');
    expect(error.details?.['discovered']).toEqual([record?.id]);
    expect(error.details?.['restoredCount']).toBe(1);
    expect(error.message).toContain('No adapter reported enabling any instrumentation');
    expect(error.message).not.toContain('no file was modified');

    expect(digestIn(workspace, TARGETS.coneProfile.file)).toBe(
      FIXTURE_DIGESTS[TARGETS.coneProfile.file],
    );
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
  }, 30_000);

  it('says which listing stands behind "no file was modified" when nothing was enabled', async () => {
    const { journal, breakListings } = breakableJournal();
    const calls: string[] = [];
    // Enables nothing, and the store stops answering listings right then.
    const idle = fakeAdapter('idle', (): Promise<InstallResult> => {
      calls.push('idle');
      breakListings();

      return Promise.resolve({
        adapterId: 'idle',
        applied: [],
        runtimeHooks: [],
        unavailable: [
          {
            signal: 'renders',
            reason: 'React was not detected',
            hint: 'Reload the page once the agent is ready.',
          },
        ],
      });
    });

    const error = expectErr(
      await installPlan(
        planWith([action({ adapter: 'idle', id: 'act_0000000000000871' })]),
        makeContext({ journal }),
        { adapters: [idle], skipFeasibility: true },
      ),
    );

    expect(calls).toEqual(['idle']);
    // Nothing was journaled through the adapters, so the ledger alone supports
    // the §0.5.5 message, and the details say that it did.
    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(error.details?.['journalReread']).toBe('failed');
  });

  it('hands adapters a journal that forwards every call to the session\u2019s own as a method call', async () => {
    const workspace = makeWorkspace();
    const inner = fakeJournal();

    /** A store whose methods need `this`, as a class-based journal does. */
    class StoreJournal implements ModificationJournal {
      private readonly rows = inner;

      append(record: ModificationRecord): Promise<Result<ModificationRecord>> {
        return this.rows.append(record);
      }

      updateStatus(
        id: string,
        status: ModificationStatus,
        patch?: ModificationStatusPatch,
      ): Promise<Result<ModificationRecord>> {
        return this.rows.updateStatus(id, status, patch);
      }

      listBySession(sessionId: string): Promise<Result<ModificationRecord[]>> {
        return this.rows.listBySession(sessionId);
      }

      listOpen(): Promise<Result<ModificationRecord[]>> {
        return this.rows.listOpen();
      }
    }

    const installed = expectOk(
      await installPlan(
        planWith([
          action({
            adapter: 'framework',
            id: 'act_0000000000000881',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
        ]),
        makeContext({ workspace, journal: new StoreJournal() }),
        { adapters: [patchingAdapter('framework', [])], skipFeasibility: true },
      ),
    );

    expect(installed.applied).toHaveLength(1);
    expect(inner.rows().map((row) => [row.id, row.status])).toEqual([
      [onlyRecord(installed.applied).id, 'applied'],
    ]);
    expect(digestIn(workspace, TARGETS.cones.file)).toBe(
      onlyRecord(installed.applied).instrumentedHash,
    );
  }, 30_000);
});

/* -------------------------------------------------------------------------------------------------
 * The suite's own footprint
 * ---------------------------------------------------------------------------------------------- */

describe('a refusal from the backup store, named for what was observed', () => {
  it('names a symbolic link planted at the backup path, which was refused rather than followed', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const before = treeDigests(workspace.projectRoot);

    // The content-addressed path the store files this original under, with a
    // link standing in it: `<debuggenHome>/backups/<session>/<digest>`, every
    // directory private so the state-directory policy itself is satisfied.
    const digest = sha256Hex(readFileSync(pathIn(workspace, TARGETS.cones.file)));
    const backupsRoot = join(workspace.debuggenHome, 'backups');
    const sessionBackups = join(backupsRoot, SESSION_ID);
    const planted = join(sessionBackups, digest);
    const decoy = join(workspace.root, 'planted-elsewhere.txt');

    mkdirSync(sessionBackups, { recursive: true, mode: 0o700 });
    chmodSync(backupsRoot, 0o700);
    chmodSync(sessionBackups, 0o700);
    writeFileSync(decoy, 'planted\n');
    symlinkSync(decoy, planted);

    const writer = reportingPatchAdapter('writer', calls);
    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'writer',
            id: 'act_0000000000000901',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
        ]),
        makeContext({ workspace, journal }),
        { adapters: [writer.adapter], skipFeasibility: true },
      ),
    );
    const reported = writer.reported();

    // The patcher's own failure keeps its code, reason and errno, and says what
    // it met: a planted link, refused, with the path and the errno named.
    expect(reported?.error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(reported?.error.details?.['reason']).toBe('backup-write-failed');
    expect(reported?.error.details?.['errno']).toBe('ELOOP');
    expect(reported?.error.message).toContain('symbolic link');
    expect(reported?.error.message).toContain(planted);

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('action-failed');
    expect(error.message).toContain('a symbolic link is planted');
    expect(error.message).toContain('refused rather than followed (ELOOP)');
    expect(error.hint).toContain(`Remove the symbolic link at '${planted}'`);
    expect(error.hint).toContain('The project was not modified.');
    expect(error.hint).not.toContain('is writable');

    // Nothing was written anywhere: the project, the link and what it points
    // at are all exactly as they were, and nothing was journaled.
    expect(treeDigests(workspace.projectRoot)).toEqual(before);
    expect(lstatSync(planted).isSymbolicLink()).toBe(true);
    expect(readFileSync(decoy, 'utf8')).toBe('planted\n');
    expect(journal.calls().filter((entry) => entry.op === 'append')).toEqual([]);
  }, 30_000);

  it('quotes the state-directory policy refusal instead of a generic writability hint', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const before = treeDigests(workspace.projectRoot);

    // The backups directory is a link out of the state root: the policy of
    // `@debuggen/shared/node` refuses it with its own message and hint.
    const elsewhere = join(workspace.root, 'elsewhere-backups');

    mkdirSync(elsewhere, { mode: 0o700 });
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, join(workspace.debuggenHome, 'backups'), 'dir');

    const writer = reportingPatchAdapter('writer', calls);
    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'writer',
            id: 'act_0000000000000902',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
        ]),
        makeContext({ workspace, journal }),
        { adapters: [writer.adapter], skipFeasibility: true },
      ),
    );
    const reported = writer.reported();
    const refusal = reported?.error.cause;

    expect(DebuggenError.is(refusal)).toBe(true);

    if (!DebuggenError.is(refusal)) {
      throw new Error('the patcher did not keep the policy refusal as its cause');
    }

    expect(refusal.code).toBe('FS_UNSAFE_PATH');
    expect(reported?.error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(reported?.error.details?.['reason']).toBe('backup-write-failed');
    expect(reported?.error.details?.['errno']).toBe('FS_UNSAFE_PATH');

    // The refusal's own words reach the developer, in the headline and the
    // hint, and nothing claims the directory merely needs to be writable.
    expect(error.message).toContain(refusal.message.trim().replace(/[.!?]$/u, ''));
    expect(refusal.hint).toBeTruthy();
    expect(error.hint).toContain(refusal.hint?.trim().replace(/[.!?]$/u, '') ?? '\u0000');
    expect(error.hint).toContain('The project was not modified.');
    expect(error.hint).not.toContain('is writable');

    expect(treeDigests(workspace.projectRoot)).toEqual(before);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(journal.calls().filter((entry) => entry.op === 'append')).toEqual([]);
  }, 30_000);
});

describe('an adapter that rejects with a coded error', () => {
  it('names a backup store built for another session instead of a generic adapter failure', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const before = treeDigests(workspace.projectRoot);
    const otherSession = 'ses_installer_other_0001';
    const context: InstrumentationContext = {
      ...makeContext({ workspace, journal }),
      // Scoped to a different session from the context's own: the production
      // patcher refuses to be built over it, before it reads or writes a byte.
      backups: createBackupStore({ debuggenHome: workspace.debuggenHome, sessionId: otherSession }),
    };

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'writer',
            id: 'act_0000000000000911',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
        ]),
        context,
        { adapters: [patchingAdapter('writer', calls)], skipFeasibility: true },
      ),
    );
    const rejection = error.cause;

    expect(calls).toEqual(['writer']);
    expect(DebuggenError.is(rejection)).toBe(true);

    if (!DebuggenError.is(rejection)) {
      throw new Error('the installer did not keep the adapter rejection as its cause');
    }

    expect(rejection.code).toBe('STORE_ERROR');
    expect(rejection.message).toMatch(/backup store/iu);
    expect(rejection.message).toMatch(/session/iu);

    // The headline says what was observed — the store belongs to another
    // session — after the adapter's name, and the hint is the rejection's own
    // recovery, because the project came back (here: was never touched).
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('adapter-failed');
    expect(error.message).toContain(
      `The adapter "writer" failed while installing its share of the plan: ${rejection.message}`,
    );
    expect(error.message).toContain('No file had been modified, so nothing had to be restored.');
    expect(rejection.hint).toBeTruthy();
    expect(error.hint).toBe(rejection.hint);

    // Nothing was written: not the project, not the journal, and not the other
    // session's backup directory.
    expect(treeDigests(workspace.projectRoot)).toEqual(before);
    expect(journal.calls().filter((entry) => entry.op === 'append')).toEqual([]);
    expect(existsSync(join(workspace.debuggenHome, 'backups', otherSession))).toBe(false);
    expect(existsSync(join(workspace.debuggenHome, 'backups', SESSION_ID))).toBe(false);
  }, 30_000);

  it('keeps an arbitrary exception out of the headline and the hint', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const calls: string[] = [];
    const thrown = new Error('internal: stack detail an adapter did not write for anyone');

    const error = expectErr(
      await installPlan(
        planWith([
          action({
            adapter: 'opaque',
            id: 'act_0000000000000912',
            type: 'function-timing',
            mode: 'patch',
            ...TARGETS.cones,
          }),
        ]),
        makeContext({ workspace, journal }),
        {
          adapters: [
            fakeAdapter('opaque', (): Promise<InstallResult> => {
              calls.push('opaque');

              return Promise.reject(thrown);
            }),
          ],
          skipFeasibility: true,
        },
      ),
    );

    expect(calls).toEqual(['opaque']);
    expect(error.details?.['reason']).toBe('adapter-failed');
    expect(error.cause).toBe(thrown);
    expect(error.message).toContain(
      'The adapter "opaque" failed while installing its share of the plan.',
    );
    expect(error.message).not.toContain(thrown.message);
    expect(error.hint).toBe(
      'Nothing from this attempt remains in the project; ask the question again to install instrumentation afresh.',
    );
  }, 30_000);
});

/* -------------------------------------------------------------------------------------------------
 * A target instrumented already: a gap to install around, not a failed install
 * ---------------------------------------------------------------------------------------------- */

/** The session that holds the targets the cases below cannot patch. */
const HOLDING_SESSION_ID = 'ses_holding000000001';

/**
 * The refusal the patch layer returns for a target whose file holds another
 * session's patch — the shape `./patch/patcher.ts` raises in step 1a.
 *
 * @param target The action whose file is held.
 * @param owningSessionId The session holding it.
 * @returns The refusal.
 */
function heldRefusal(
  target: InstrumentationAction,
  owningSessionId: string = HOLDING_SESSION_ID,
): DebuggenError {
  return new DebuggenError(
    'PATCH_UNSUPPORTED',
    `${target.file} is already instrumented by session ${owningSessionId}, so this session cannot patch it as well.`,
    {
      hint: `End session ${owningSessionId} — its cleanup restores ${target.file} — then ask again to time ${target.symbol} in this session.`,
      details: {
        reason: PATCH_TARGET_HELD_REASON,
        file: target.file,
        symbol: target.symbol,
        owningSessionId,
        recordId: 'mod_holding0000000001',
      },
    },
  );
}

/**
 * The fatal-channel entry a patch adapter reports for a held target: the
 * refusal and the action, and — because nothing was written — no record.
 *
 * @param target The held action.
 * @returns The failure.
 */
function heldFailure(target: InstrumentationAction): InstallFailure {
  return {
    error: heldRefusal(target),
    signal: 'functions',
    actionId: target.id,
    file: target.file,
    symbol: target.symbol,
  };
}

/**
 * The gap the installer is expected to report for a held target.
 *
 * @param target The held action.
 * @param owningSessionId The session holding it.
 * @returns The gap.
 */
function heldGap(
  target: InstrumentationAction,
  owningSessionId: string = HOLDING_SESSION_ID,
): UnavailableSignal {
  return {
    signal: 'functions',
    reason: `${target.file} is already instrumented by session ${owningSessionId}`,
    hint: `End session ${owningSessionId} — its cleanup restores ${target.file} — then ask again to time ${target.symbol} in this session.`,
  };
}

/** A preload gap a patch adapter carries beside its answer. */
const SILENT_PRELOAD_GAP: UnavailableSignal = {
  signal: 'routeHandlers',
  reason: 'the dev-server preload has not reported for a while',
  hint: 'Relaunch the dev server through the extension so the preload reports again.',
};

describe('a target instrumented already', () => {
  it('sets a held target aside as a gap and asks the adapter again with the rest', async () => {
    const calls: string[] = [];
    const asked: string[][] = [];
    const render = action({ adapter: 'renders', id: 'act_0000000000000701' });
    const held = action({
      adapter: 'framework',
      id: 'act_0000000000000702',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const kept = action({
      adapter: 'framework',
      id: 'act_0000000000000703',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });
    const recorder = recordingLogger();
    const framework = fakeAdapter('framework', (actions): Promise<InstallResult> => {
      calls.push('framework');
      asked.push(actions.map((item) => item.id));

      return Promise.resolve(
        actions.some((item) => item.id === held.id)
          ? {
              adapterId: 'framework',
              applied: [],
              runtimeHooks: [],
              unavailable: [SILENT_PRELOAD_GAP],
              failure: heldFailure(held),
            }
          : {
              adapterId: 'framework',
              applied: [],
              runtimeHooks: ['Named function spans'],
              unavailable: [SILENT_PRELOAD_GAP],
              serverSignals: { functions: actions.map((item) => item.symbol) },
            },
      );
    });

    const installed = expectOk(
      await installPlan(planWith([render, held, kept]), makeContext({ logger: recorder.logger }), {
        adapters: [runtimeAdapter('renders', calls), framework],
        skipFeasibility: true,
      }),
    );

    // Asked twice: once with both targets, then again with the held one
    // removed — and never about the held one again.
    expect(calls).toEqual(['renders', 'framework', 'framework']);
    expect(asked).toEqual([[held.id, kept.id], [kept.id]]);

    // The held target is a gap worded from the refusal, ahead of the gap the
    // kept answer reported; the set-aside ask's own copy of that gap is not
    // reported twice.
    expect(installed.unavailable).toEqual([heldGap(held), SILENT_PRELOAD_GAP]);
    expect(installed.unavailable[0]).toEqual({
      signal: 'functions',
      ...describeTargetYield(heldRefusal(held)),
    });

    // The capture proceeds with everything else, and the preload is not asked
    // to wrap the symbol nobody patched.
    expect(installed.applied).toEqual([]);
    expect(installed.runtimeHooks).toEqual(['renders hook', 'Named function spans']);
    expect(installed.serverSignals.functions).toEqual([kept.symbol]);
    expect(installed.serverSignals.functions).not.toContain(held.symbol);
    expect(installed.perAdapter.map((result) => result.adapterId)).toEqual([
      'renders',
      'framework',
    ]);

    // One informational line per set-aside target, with identifiers only.
    const setAside = recorder.records.filter(
      (entry) => entry.level === 'info' && entry.message.includes('instrumented already'),
    );

    expect(setAside).toHaveLength(1);
    expect(setAside[0]?.fields).toMatchObject({
      sessionId: SESSION_ID,
      adapter: 'framework',
      actionId: held.id,
      signal: 'functions',
      code: 'PATCH_UNSUPPORTED',
      reason: PATCH_TARGET_HELD_REASON,
      owningSessionId: HOLDING_SESSION_ID,
      remaining: 1,
    });
  });

  it('continues with runtime hooks and the held server span’s preload residue when every patch target is held', async () => {
    const calls: string[] = [];
    const asked: string[][] = [];
    const render = action({ adapter: 'renders', id: 'act_0000000000000711' });
    const first = action({
      adapter: 'framework',
      id: 'act_0000000000000712',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const second = action({
      adapter: 'framework',
      id: 'act_0000000000000713',
      type: 'server-span',
      mode: 'patch',
      ...TARGETS.route,
    });
    // Every ask is answered with its first target held, which is how the
    // patch layer answers a batch whose files another session holds.
    const framework = fakeAdapter('framework', (actions): Promise<InstallResult> => {
      calls.push('framework');
      asked.push(actions.map((item) => item.id));

      const [target] = actions;

      return Promise.resolve({
        adapterId: 'framework',
        applied: [],
        runtimeHooks: [],
        unavailable: [SILENT_PRELOAD_GAP],
        ...(target === undefined ? {} : { failure: heldFailure(target) }),
      });
    });

    const installed = expectOk(
      await installPlan(planWith([render, first, second]), makeContext(), {
        adapters: [runtimeAdapter('renders', calls), framework],
        skipFeasibility: true,
      }),
    );

    // Asked once per target and never with an empty list.
    expect(asked).toEqual([[first.id, second.id], [second.id]]);
    expect(calls).toEqual(['renders', 'framework', 'framework']);

    // Both targets are Function-timing gaps — a patch only ever supplied the
    // named span, whatever its action type — and the last ask's preload gap is
    // kept once so it is not lost with the group.
    expect(installed.unavailable).toEqual([heldGap(first), heldGap(second), SILENT_PRELOAD_GAP]);
    expect(installed.unavailable.slice(0, 2).map((gap) => gap.signal)).toEqual([
      'functions',
      'functions',
    ]);
    expect(installed.applied).toEqual([]);
    expect(installed.runtimeHooks).toEqual(['renders hook']);

    // The held server span's request and route-handler spans come from the
    // preload, so they stay armed — with the outgoing calls that ride with that
    // spine; neither held symbol is named for wrapping.
    expect(installed.serverSignals).toEqual({
      http: true,
      routeHandlers: true,
      fetch: true,
      prisma: false,
      pg: false,
      functions: [],
    });
    expect(installed.serverSignals).toEqual(
      deriveServerAgentSignals([{ ...second, mode: 'runtime' }]),
    );

    // The residue arms nothing in the page: the agent's hooks are the render
    // action's alone.
    expect(installed.agentHooks).toEqual(deriveAgentHookConfig([render]));
    expect(installed.perAdapter.map((result) => result.adapterId)).toEqual(['renders']);
  });

  it('arms the preload residue alone when the only planned target is a held server span', async () => {
    const held = action({
      adapter: 'framework',
      id: 'act_0000000000000781',
      type: 'server-span',
      mode: 'patch',
      ...TARGETS.route,
    });
    const recorder = recordingLogger();
    const framework = fakeAdapter('framework', (): Promise<InstallResult> =>
      Promise.resolve({
        adapterId: 'framework',
        applied: [],
        runtimeHooks: [],
        unavailable: [],
        failure: heldFailure(held),
      }),
    );

    const installed = expectOk(
      await installPlan(planWith([held]), makeContext({ logger: recorder.logger }), {
        adapters: [framework],
        skipFeasibility: true,
      }),
    );

    // No hook and no file, yet not the nothing-enabled failure: the residue
    // arms the preload's request and route-handler spans, which a capture
    // collects without the edit.
    expect(installed.applied).toEqual([]);
    expect(installed.runtimeHooks).toEqual([]);
    expect(installed.unavailable).toEqual([heldGap(held)]);
    expect(installed.serverSignals).toMatchObject({ http: true, routeHandlers: true });
    expect(installed.serverSignals.functions).toEqual([]);
    expect(installed.agentHooks).toEqual(deriveAgentHookConfig([]));
    expect(installed.perAdapter).toEqual([]);

    const summary = recorder.records.find((entry) => entry.message === 'instrumentation installed');

    expect(summary?.fields).toMatchObject({ applied: 0, setAside: 1, residue: 1 });
  });

  it('keeps a set-aside runtime-mode action under its own signal and leaves no residue for it', async () => {
    const render = action({ adapter: 'renders', id: 'act_0000000000000791' });
    const declined = action({
      adapter: 'spans',
      id: 'act_0000000000000792',
      type: 'server-span',
      mode: 'runtime',
      ...TARGETS.route,
    });
    const spans = fakeAdapter('spans', (): Promise<InstallResult> =>
      Promise.resolve({
        adapterId: 'spans',
        applied: [],
        runtimeHooks: [],
        unavailable: [],
        failure: heldFailure(declined),
      }),
    );

    const installed = expectOk(
      await installPlan(planWith([render, declined]), makeContext(), {
        adapters: [runtimeAdapter('renders', []), spans],
        skipFeasibility: true,
      }),
    );

    // Only a patch is renamed: a runtime action keeps the signal its type
    // names, and an adapter that declined to arm it is not overruled.
    expect(installed.unavailable).toEqual([{ ...heldGap(declined), signal: 'routeHandlers' }]);
    expect(installed.serverSignals).toEqual(DISABLED_SERVER_AGENT_SIGNALS);
    expect(installed.runtimeHooks).toEqual(['renders hook']);
  });

  it('fails with the held target’s own hint when nothing else could be enabled', async () => {
    const held = action({
      adapter: 'framework',
      id: 'act_0000000000000721',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const framework = fakeAdapter('framework', (): Promise<InstallResult> =>
      Promise.resolve({
        adapterId: 'framework',
        applied: [],
        runtimeHooks: [],
        unavailable: [],
        failure: heldFailure(held),
      }),
    );

    const error = expectErr(
      await installPlan(planWith([held]), makeContext(), {
        adapters: [framework],
        skipFeasibility: true,
      }),
    );

    // AAP §0.5.5's one hard failure, and it tells the developer which session
    // holds the file rather than a generic "could not be installed".
    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(error.hint).toBe(heldGap(held).hint);
    expect(error.message).toContain(`Could not enable functions: ${heldGap(held).reason}.`);
    expect(error.details?.['unavailable']).toEqual([heldGap(held)]);

    // The holder as structured identifiers, which the service words its own
    // public hint from instead of quoting the gap.
    expect(error.details?.['heldTargets']).toEqual([
      { file: held.file, symbol: held.symbol, owningSessionId: HOLDING_SESSION_ID },
    ]);
    expect(error.details?.['heldTargetCount']).toBe(1);
  });

  it('lists every holder as bounded heldTargets, leaving out a declaration no session holds', async () => {
    // One more held target than an error detail carries, and a declaration
    // that already carries the span helper, which no session holds.
    const heldCount = 21;
    const held = Array.from({ length: heldCount }, (_, index) =>
      action({
        adapter: 'framework',
        id: `act_${String(800 + index).padStart(16, '0')}`,
        type: 'function-timing',
        mode: 'patch',
        file: `src/server/held-${String(index).padStart(2, '0')}.ts`,
        symbol: `heldSymbol${String(index)}`,
      }),
    );
    const helperAlready = action({
      adapter: 'framework',
      id: 'act_0000000000000899',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });
    const alreadyInstrumented = new DebuggenError(
      'PATCH_UNSUPPORTED',
      `${helperAlready.symbol} already contains the span helper.`,
      {
        hint: `Revert the existing modification of ${helperAlready.file} before instrumenting it again.`,
        details: {
          reason: 'already-instrumented',
          file: helperAlready.file,
          symbol: helperAlready.symbol,
        },
      },
    );
    // Every ask is answered with its first target set aside, in id order.
    const framework = fakeAdapter('framework', (actions): Promise<InstallResult> => {
      const [target] = actions;

      if (target === undefined) {
        return Promise.resolve({
          adapterId: 'framework',
          applied: [],
          runtimeHooks: [],
          unavailable: [],
        });
      }

      return Promise.resolve({
        adapterId: 'framework',
        applied: [],
        runtimeHooks: [],
        unavailable: [],
        failure:
          target.id === helperAlready.id
            ? {
                error: alreadyInstrumented,
                signal: 'functions',
                actionId: target.id,
                file: target.file,
                symbol: target.symbol,
              }
            : heldFailure(target),
      });
    });

    const error = expectErr(
      await installPlan(planWith([...held, helperAlready]), makeContext(), {
        adapters: [framework],
        skipFeasibility: true,
      }),
    );

    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(error.details?.['unavailableCount']).toBe(heldCount + 1);
    expect(error.details?.['heldTargetCount']).toBe(heldCount);
    expect(error.details?.['heldTargets']).toEqual(
      held.slice(0, 20).map((target) => ({
        file: target.file,
        symbol: target.symbol,
        owningSessionId: HOLDING_SESSION_ID,
      })),
    );
  });

  it('keeps a held target fatal once the same ask applied a record, and unwinds that record', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    let asks = 0;
    const patched = action({
      adapter: 'framework',
      id: 'act_0000000000000731',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });
    const held = action({
      adapter: 'framework',
      id: 'act_0000000000000732',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const framework = fakeAdapter('framework', async (actions, context): Promise<InstallResult> => {
      asks += 1;

      const applied = await patchThrough(
        actions.filter((item) => item.id === patched.id),
        context,
      );

      return {
        adapterId: 'framework',
        applied,
        runtimeHooks: [],
        unavailable: [],
        failure: heldFailure(held),
      };
    });

    const error = expectErr(
      await installPlan(planWith([patched, held]), makeContext({ workspace, journal }), {
        adapters: [framework],
        skipFeasibility: true,
      }),
    );

    // Setting the held target aside would leave this call's record standing
    // under a retry, so the install fails and the record is unwound.
    expect(asks).toBe(1);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('action-failed');
    expect(error.details?.['restoredCount']).toBe(1);
    expect(digestIn(workspace, TARGETS.planner.file)).toBe(FIXTURE_DIGESTS[TARGETS.planner.file]);
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
  }, 30_000);

  it('keeps a held target fatal when the same ask appended a record it did not report', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    let asks = 0;
    const patched = action({
      adapter: 'framework',
      id: 'act_0000000000000741',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });
    const held = action({
      adapter: 'framework',
      id: 'act_0000000000000742',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const framework = fakeAdapter('framework', async (actions, context): Promise<InstallResult> => {
      asks += 1;

      // Patched and journaled, then left out of the answer: only the
      // install's ledger knows this ask wrote anything.
      await patchThrough(
        actions.filter((item) => item.id === patched.id),
        context,
      );

      return {
        adapterId: 'framework',
        applied: [],
        runtimeHooks: [],
        unavailable: [],
        failure: heldFailure(held),
      };
    });

    const error = expectErr(
      await installPlan(planWith([patched, held]), makeContext({ workspace, journal }), {
        adapters: [framework],
        skipFeasibility: true,
      }),
    );

    expect(asks).toBe(1);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('action-failed');
    expect(digestIn(workspace, TARGETS.planner.file)).toBe(FIXTURE_DIGESTS[TARGETS.planner.file]);
    expect(journal.rows().map((row) => row.status)).toEqual(['reverted']);
  }, 30_000);

  it('keeps a held target fatal when the failure names no action it was asked about', async () => {
    let asks = 0;
    const held = action({
      adapter: 'framework',
      id: 'act_0000000000000751',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const stranger = action({
      adapter: 'framework',
      id: 'act_0000000000000759',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });
    const framework = fakeAdapter('framework', (): Promise<InstallResult> => {
      asks += 1;

      return Promise.resolve({
        adapterId: 'framework',
        applied: [],
        runtimeHooks: [],
        unavailable: [],
        failure: heldFailure(stranger),
      });
    });

    const error = expectErr(
      await installPlan(planWith([held]), makeContext(), {
        adapters: [framework],
        skipFeasibility: true,
      }),
    );

    // Dropping an action nobody asked about would drop nothing, and asking
    // again would get the same answer: the failure is reported as it came.
    expect(asks).toBe(1);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('action-failed');
  });

  it('unwinds as aborted, without asking again, when the install is cancelled during the ask', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let asks = 0;
    const render = action({ adapter: 'renders', id: 'act_0000000000000761' });
    const held = action({
      adapter: 'framework',
      id: 'act_0000000000000762',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const kept = action({
      adapter: 'framework',
      id: 'act_0000000000000763',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });
    const framework = fakeAdapter('framework', (): Promise<InstallResult> => {
      asks += 1;
      controller.abort();

      return Promise.resolve({
        adapterId: 'framework',
        applied: [],
        runtimeHooks: [],
        unavailable: [],
        failure: heldFailure(held),
      });
    });

    const error = expectErr(
      await installPlan(
        planWith([render, held, kept]),
        makeContext({ signal: controller.signal }),
        { adapters: [runtimeAdapter('renders', calls), framework], skipFeasibility: true },
      ),
    );

    expect(asks).toBe(1);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('aborted');
  });

  it('lets a second session on the project continue without the targets the first session patched', async () => {
    // Two sessions, one project copy and one journal, as the service holds
    // them, with the production patcher doing every read and write: session 1
    // installs the plan, then session 2 installs the same plan.
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const secondSessionId = 'ses_installer00000002';
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const render = action({ adapter: 'renders', id: 'act_0000000000000771' });
    const cones = action({
      adapter: 'framework',
      id: 'act_0000000000000772',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const planner = action({
      adapter: 'framework',
      id: 'act_0000000000000773',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.planner,
    });
    const actions = [render, cones, planner];

    const firstInstall = expectOk(
      await installPlan(planWith(actions), makeContext({ workspace, journal }), {
        adapters: [
          runtimeAdapter('renders', firstCalls),
          reportingPatchAdapter('framework', firstCalls).adapter,
        ],
        skipFeasibility: true,
      }),
    );

    expect(firstInstall.applied).toHaveLength(2);

    const patchedDigests = {
      [TARGETS.cones.file]: digestIn(workspace, TARGETS.cones.file),
      [TARGETS.planner.file]: digestIn(workspace, TARGETS.planner.file),
    };
    const secondContext: InstrumentationContext = {
      ...makeContext({ workspace, journal }),
      sessionId: secondSessionId,
      backups: createBackupStore({
        debuggenHome: workspace.debuggenHome,
        sessionId: secondSessionId,
      }),
    };
    const secondReporter = reportingPatchAdapter('framework', secondCalls);

    const secondInstall = expectOk(
      await installPlan({ ...planWith(actions), sessionId: secondSessionId }, secondContext, {
        adapters: [runtimeAdapter('renders', secondCalls), secondReporter.adapter],
        skipFeasibility: true,
      }),
    );

    // Session 2 continues runtime-only: its hook is armed, nothing of its own
    // is patched, and each held target is a gap naming session 1.
    expect(secondCalls).toEqual(['renders', 'framework', 'framework']);
    expect(secondInstall.applied).toEqual([]);
    expect(secondInstall.runtimeHooks).toEqual(['renders hook']);
    expect(secondInstall.serverSignals.functions).toEqual([]);
    expect(secondInstall.unavailable).toEqual([
      heldGap(cones, SESSION_ID),
      heldGap(planner, SESSION_ID),
    ]);

    // And it touched nothing: the files hold session 1's patches, the journal
    // holds session 1's records alone, and session 2 took no backup.
    expect(digestIn(workspace, TARGETS.cones.file)).toBe(patchedDigests[TARGETS.cones.file]);
    expect(digestIn(workspace, TARGETS.planner.file)).toBe(patchedDigests[TARGETS.planner.file]);
    expect(journal.rows().map((row) => row.sessionId)).toEqual([SESSION_ID, SESSION_ID]);
    expect(journal.rows().map((row) => row.status)).toEqual(['applied', 'applied']);
    expect(existsSync(join(workspace.debuggenHome, 'backups', secondSessionId))).toBe(false);
  }, 30_000);

  it('names the holder on the same project when another copy holds the same patch', async () => {
    // Two copies of one project and one journal, as a service holds them: the
    // session on the first copy and the session on the second patch the same
    // target, so both files hold the same bytes under the same relative path,
    // and the second copy's record is listed last. Session 2, on the first
    // copy, is handed the caller's project predicate.
    const primary = makeWorkspace();
    const secondary = makeWorkspace();
    const journal = fakeJournal();
    const otherCopySessionId = 'ses_installer00000004';
    const secondSessionId = 'ses_installer00000005';
    const cones = action({
      adapter: 'framework',
      id: 'act_0000000000000781',
      type: 'function-timing',
      mode: 'patch',
      ...TARGETS.cones,
    });
    const contextFor = (
      workspace: ReturnType<typeof makeWorkspace>,
      sessionId: string,
    ): InstrumentationContext => ({
      ...makeContext({ workspace, journal }),
      sessionId,
      backups: createBackupStore({ debuggenHome: workspace.debuggenHome, sessionId }),
    });

    expectOk(
      await installPlan(planWith([cones]), makeContext({ workspace: primary, journal }), {
        adapters: [reportingPatchAdapter('framework', []).adapter],
        skipFeasibility: true,
      }),
    );
    expectOk(
      await installPlan(
        { ...planWith([cones]), sessionId: otherCopySessionId },
        contextFor(secondary, otherCopySessionId),
        { adapters: [reportingPatchAdapter('framework', []).adapter], skipFeasibility: true },
      ),
    );

    expect(digestIn(secondary, TARGETS.cones.file)).toBe(digestIn(primary, TARGETS.cones.file));
    expect(journal.rows().map((row) => row.sessionId)).toEqual([SESSION_ID, otherCopySessionId]);

    const projects = new Map([
      [SESSION_ID, 'primary'],
      [otherCopySessionId, 'secondary'],
    ]);
    const asked: string[] = [];
    const second = expectErr(
      await installPlan(
        { ...planWith([cones]), sessionId: secondSessionId },
        contextFor(primary, secondSessionId),
        {
          adapters: [reportingPatchAdapter('framework', []).adapter],
          skipFeasibility: true,
          sessionOnAnotherProject: (sessionId) => {
            asked.push(sessionId);
            const project = projects.get(sessionId);
            return project !== undefined && project !== 'primary';
          },
        },
      ),
    );

    // Nothing else could be enabled, so the install is the nothing-enabled
    // failure — naming the session on this copy, never the other copy's.
    expect(second.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(second.details?.['heldTargets']).toEqual([
      { file: TARGETS.cones.file, symbol: TARGETS.cones.symbol, owningSessionId: SESSION_ID },
    ]);
    expect(second.details?.['unavailable']).toEqual([heldGap(cones, SESSION_ID)]);
    expect(asked).toContain(otherCopySessionId);
    expect(journal.rows().map((row) => row.status)).toEqual(['applied', 'applied']);
    expect(existsSync(join(primary.debuggenHome, 'backups', secondSessionId))).toBe(false);
  }, 30_000);

  it('keeps a second session’s request spans armed when the route handler it planned is held', async () => {
    // The production patcher again, on a route handler this time: session 1
    // patches it as a server span, then session 2 plans the same action.
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const secondSessionId = 'ses_installer00000003';
    const route = action({
      adapter: 'framework',
      id: 'act_0000000000000901',
      type: 'server-span',
      mode: 'patch',
      ...TARGETS.route,
    });

    const firstInstall = expectOk(
      await installPlan(planWith([route]), makeContext({ workspace, journal }), {
        adapters: [reportingPatchAdapter('framework', []).adapter],
        skipFeasibility: true,
      }),
    );

    expect(firstInstall.applied).toHaveLength(1);

    const patchedDigest = digestIn(workspace, TARGETS.route.file);
    const secondCalls: string[] = [];
    const secondContext: InstrumentationContext = {
      ...makeContext({ workspace, journal }),
      sessionId: secondSessionId,
      backups: createBackupStore({
        debuggenHome: workspace.debuggenHome,
        sessionId: secondSessionId,
      }),
    };

    const secondInstall = expectOk(
      await installPlan({ ...planWith([route]), sessionId: secondSessionId }, secondContext, {
        adapters: [reportingPatchAdapter('framework', secondCalls).adapter],
        skipFeasibility: true,
      }),
    );

    // Session 2 is not failed: the handler's own span is a Function-timing
    // gap naming session 1, and the preload still collects the request and
    // route-handler spans, and the outgoing calls that ride with them —
    // without being asked to wrap the held symbol.
    expect(secondCalls).toEqual(['framework']);
    expect(secondInstall.applied).toEqual([]);
    expect(secondInstall.unavailable).toEqual([heldGap(route, SESSION_ID)]);
    expect(secondInstall.serverSignals).toEqual({
      http: true,
      routeHandlers: true,
      fetch: true,
      prisma: false,
      pg: false,
      functions: [],
    });
    expect(digestIn(workspace, TARGETS.route.file)).toBe(patchedDigest);
    expect(journal.rows().map((row) => row.sessionId)).toEqual([SESSION_ID]);
    expect(existsSync(join(workspace.debuggenHome, 'backups', secondSessionId))).toBe(false);
  }, 30_000);
});

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
