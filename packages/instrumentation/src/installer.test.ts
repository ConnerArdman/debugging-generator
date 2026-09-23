/**
 * Unit suite for `./installer.ts` — the ordered installation driver.
 *
 * Four of its promises cannot be read off the type system, and each one is a
 * product guarantee rather than an implementation detail:
 *
 * 1. **Runtime hooks are armed before the first byte is written.** A capture
 *    whose signals are all satisfiable by hooks modifies nothing, and a patch
 *    that fails cannot take down signals that were already live. The ordering
 *    group asserts the observed call order across adapters, including the case
 *    where the patch-mode adapter is registered first.
 * 2. **Only "nothing at all could be enabled" is a failure.** Every other gap
 *    is reported through `unavailable` so the developer is told what the
 *    capture will still contain. Two groups cover both sides of that line.
 * 3. **A delta installs only the delta.** A follow-up's plan version is the
 *    previous plan plus additive actions, so an install of it must not re-apply
 *    an action an earlier version already applied.
 * 4. **A part-way failure leaves the session at its previous plan version.**
 *    The rollback group runs the **real** `restoreModification` over real files
 *    in a temporary project with a real backup store, and asserts byte
 *    identity — the delta's file back to what the previous plan version left,
 *    and that version's own file still instrumented.
 *
 * Two habits here are deliberate. The adapters are fakes, because this module's
 * subject is orchestration and the built-in adapters have their own suites —
 * and because the driver must work with adapters it has never seen, which is
 * the extension point of AAP §0.4.2. The rollback, by contrast, is not faked at
 * all: bytes, digests, backups and journal transitions are the real ones, since
 * "the file comes back" is the claim being tested.
 */

import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CodeGraph, CodeQueries, ProjectSummary, RouteMap } from '@debuggen/code-analysis';
import { DebuggenError, err, isErr, isOk, ok, toPosix } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import { describe, expect, it } from 'vitest';

import type {
  InstallResult,
  InstrumentationAdapter,
  InstrumentationContext,
  UnavailableSignal,
} from './adapter.js';
import { installPlan } from './installer.js';
import type { AggregateInstallResult } from './installer.js';
import { createBackupStore } from './patch/backup-store.js';
import type { AdapterRegistry } from './registry.js';
import { createModificationRecord } from './schema/modification.js';
import type { ModificationJournal, ModificationRecord } from './schema/modification.js';
import { INSTRUMENTATION_PLAN_VERSION } from './schema/plan.js';
import type {
  AdapterActionResolution,
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
  InstrumentationPlan,
} from './schema/plan.js';
import { buildReadiness } from './schema/readiness.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures: sessions, plans and actions
 * ---------------------------------------------------------------------------------------------- */

/** The session every case installs for. */
const SESSION_ID = 'ses_installer00000001';

/** The revision every context stamps unless a case says otherwise. */
const PLAN_VERSION = 2;

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

/** An in-memory journal, which is the port the service implements over SQLite. */
interface FakeJournal extends ModificationJournal {
  /** Every record, in append order, as the journal currently holds it. */
  readonly rows: () => ModificationRecord[];
}

/**
 * A journal that stores records in memory and applies status transitions.
 *
 * @returns The journal.
 */
function fakeJournal(): FakeJournal {
  const rows = new Map<string, ModificationRecord>();

  return {
    append: (record: ModificationRecord): Promise<Result<ModificationRecord>> => {
      rows.set(record.id, record);

      return Promise.resolve(ok(record));
    },
    updateStatus: (id, status, patch): Promise<Result<ModificationRecord>> => {
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
    listBySession: (sessionId: string): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok([...rows.values()].filter((row) => row.sessionId === sessionId))),
    listOpen: (): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok([...rows.values()].filter((row) => row.status !== 'reverted'))),
    rows: (): ModificationRecord[] => [...rows.values()],
  };
}

/**
 * A code graph and query surface with only the members the installer's own
 * invariant check and the feasibility gate look for.
 *
 * Every case that needs the *real* graph skips the gate instead: the gate has
 * its own suite against the committed fixture project, and re-indexing it here
 * would test that module twice and this one not at all.
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
  readonly root: string;
  readonly projectRoot: string;
  readonly debuggenHome: string;
}

/** Every workspace this suite created, removed by the last case that ran. */
const workspaces: string[] = [];

/**
 * Creates an isolated project and product state directory.
 *
 * `$DEBUGGEN_HOME` is a temporary directory, never the developer's: the backup
 * store creates `0700` directories and `0600` files under it, and a suite that
 * pointed at the real one would file a fixture's backups beside a real
 * session's.
 *
 * @returns The workspace paths.
 */
function makeWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'debuggen-installer-suite-'));
  const projectRoot = join(root, 'project');
  const debuggenHome = join(root, 'state');

  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  mkdirSync(debuggenHome, { recursive: true, mode: 0o700 });
  workspaces.push(root);

  return { root, projectRoot: toPosix(projectRoot), debuggenHome: toPosix(debuggenHome) };
}

/** What a case varies about its context. */
interface ContextInput {
  readonly workspace?: Workspace;
  readonly planVersion?: number;
  readonly journal?: ModificationJournal;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

/**
 * A context over a temporary workspace.
 *
 * @param input What this case changes.
 * @returns The context.
 */
function makeContext(input: ContextInput = {}): InstrumentationContext {
  const workspace = input.workspace ?? makeWorkspace();

  return {
    sessionId: SESSION_ID,
    projectRoot: workspace.projectRoot,
    planVersion: input.planVersion ?? PLAN_VERSION,
    debuggenHome: workspace.debuggenHome,
    logger: input.logger ?? recordingLogger().logger,
    graph: STUB_GRAPH,
    queries: STUB_QUERIES,
    routeMap: STUB_ROUTE_MAP,
    projectSummary: STUB_SUMMARY,
    journal: input.journal ?? fakeJournal(),
    backups: createBackupStore({
      debuggenHome: workspace.debuggenHome,
      sessionId: SESSION_ID,
    }),
    readiness: {},
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

/** One file a patching adapter rewrites. */
interface PatchTarget {
  /** The project-relative POSIX path. */
  readonly file: string;

  /** The content the patch installs. */
  readonly instrumented: string;
}

/**
 * An adapter that performs the parts of a real patch this suite needs:
 * hash the original, store the backup, journal the record, write the patched
 * bytes, then mark the record applied.
 *
 * It is not the production patcher — `./patch/patcher.ts` owns that sequence
 * and its own suite — but it produces the same artefacts, which is what the
 * rollback under test consumes.
 *
 * @param id The adapter id.
 * @param calls The shared call log.
 * @param targets The files it patches.
 * @returns The adapter.
 */
function patchingAdapter(
  id: string,
  calls: string[],
  targets: readonly PatchTarget[],
): InstrumentationAdapter {
  return fakeAdapter(
    id,
    async (
      _actions: readonly InstrumentationAction[],
      context: InstrumentationContext,
    ): Promise<InstallResult> => {
      calls.push(id);

      const applied: ModificationRecord[] = [];

      for (const target of targets) {
        applied.push(await applyPatch(target, context));
      }

      return {
        adapterId: id,
        applied,
        runtimeHooks: [],
        unavailable: [],
        serverSignals: { functions: applied.map((record) => record.file) },
      };
    },
  );
}

/**
 * Applies one patch the way the production sequence does, in the order that
 * makes it reversible: hash, back up, journal, write, mark applied.
 *
 * @param target The file and its patched content.
 * @param context The session's context, supplying the project root, the backup
 * store and the journal.
 * @returns The applied record.
 */
async function applyPatch(
  target: PatchTarget,
  context: InstrumentationContext,
): Promise<ModificationRecord> {
  const absolute = join(context.projectRoot, target.file);
  const original = readFileSync(absolute);
  const originalHash = sha256Hex(original);
  const instrumented = Buffer.from(target.instrumented, 'utf8');
  const stored = await context.backups.put(originalHash, original);

  if (isErr(stored)) {
    throw stored.error;
  }

  const record = createModificationRecord({
    sessionId: context.sessionId,
    planVersion: context.planVersion,
    file: target.file,
    originalHash,
    backupPath: stored.value.path,
    instrumentedHash: sha256Hex(instrumented),
    diff: `--- a/${target.file}\n+++ b/${target.file}\n`,
  });

  if (isErr(record)) {
    throw record.error;
  }

  const appended = await context.journal.append(record.value);

  if (isErr(appended)) {
    throw appended.error;
  }

  writeFileSync(absolute, instrumented);

  const marked = await context.journal.updateStatus(record.value.id, 'applied');

  if (isErr(marked)) {
    throw marked.error;
  }

  return marked.value;
}

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
): AdapterRegistry {
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

    writeFileSync(join(workspace.projectRoot, 'route.ts'), 'export function GET() {}\n');

    const calls: string[] = [];
    const patcher = patchingAdapter('framework', calls, [
      { file: 'route.ts', instrumented: 'export function GET() { /* timed */ }\n' },
    ]);
    const renders = runtimeAdapter('renders', calls, { hooks: ['React renders'] });
    const requests = runtimeAdapter('requests', calls, { hooks: ['Network tracing'] });
    const plan = planWith([
      action({ adapter: 'framework', type: 'server-span', mode: 'patch', file: 'route.ts' }),
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
  });

  it('is deterministic: the same plan installs in the same order twice, whatever the authored order', async () => {
    const first: string[] = [];
    const second: string[] = [];
    const adapters = (calls: string[]): InstrumentationAdapter[] => [
      runtimeAdapter('alpha', calls),
      runtimeAdapter('beta', calls),
      runtimeAdapter('gamma', calls),
    ];
    const actions = [
      action({ adapter: 'gamma', id: 'act_0000000000000003' }),
      action({ adapter: 'alpha', id: 'act_0000000000000001' }),
      action({ adapter: 'beta', id: 'act_0000000000000002' }),
    ];

    expectOk(
      await installPlan(planWith(actions), makeContext(), {
        adapters: adapters(first),
        skipFeasibility: true,
      }),
    );
    expectOk(
      await installPlan(planWith([...actions].reverse()), makeContext(), {
        adapters: adapters(second),
        skipFeasibility: true,
      }),
    );

    expect(first).toEqual(['alpha', 'beta', 'gamma']);
    expect(second).toEqual(first);
  });

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

    mkdirSync(dirname(join(workspace.projectRoot, 'src/a.ts')), { recursive: true });
    writeFileSync(join(workspace.projectRoot, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(workspace.projectRoot, 'src/b.ts'), 'export const b = 2;\n');

    const calls: string[] = [];
    const gap: UnavailableSignal = {
      signal: 'componentTree',
      reason: 'the page agent has not reported for the bound tab',
      hint: 'Open the application in the bound tab, then start capture again.',
    };
    const plan = planWith([
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      action({ adapter: 'perf', type: 'perf-tracking' }),
      action({ adapter: 'framework', type: 'function-timing', mode: 'patch', file: 'src/a.ts' }),
      action({ adapter: 'framework', type: 'function-timing', mode: 'patch', file: 'src/b.ts' }),
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext({ workspace }), {
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
          patchingAdapter('framework', calls, [
            { file: 'src/a.ts', instrumented: 'export const a = 1; // timed\n' },
            { file: 'src/b.ts', instrumented: 'export const b = 2; // timed\n' },
          ]),
        ],
        skipFeasibility: true,
      }),
    );

    expect(installed.runtimeHooks).toEqual(['React renders', 'Browser performance', 'Page errors']);
    expect(installed.applied.map((record) => record.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(installed.unavailable).toEqual([gap]);
    expect(installed.perAdapter.map((result) => result.adapterId)).toEqual([
      'renders',
      'perf',
      'framework',
    ]);
    expect(installed.planVersion).toBe(PLAN_VERSION);
  });

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

  it('does not arm hooks for an adapter that enabled nothing', async () => {
    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'renders', type: 'react-render-tracking' }),
      action({ adapter: 'perf', type: 'perf-tracking' }),
    ]);

    const installed = expectOk(
      await installPlan(plan, makeContext(), {
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
        ],
        skipFeasibility: true,
      }),
    );

    expect(installed.agentHooks.react).toBe(false);
    expect(installed.agentHooks.perf).toBe(true);
    expect(installed.agentHooks.interactions).toBe(true);
    expect(installed.unavailable.map((entry) => entry.signal)).toEqual(['react']);
  });
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
    expect(error.message).toContain('Could not enable prisma');
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
  /** What the previous plan version installed, and what this call adds. */
  const PREVIOUS_ORIGINAL = 'export function loadCart() {\n  return [];\n}\n';

  /** The content the previous plan version's patch left on disk. */
  const PREVIOUS_INSTRUMENTED = 'export function loadCart() {\n  return []; // v1 timed\n}\n';

  /** The delta's target, before this call touches it. */
  const DELTA_ORIGINAL = 'export function quote() {\n  return 0;\n}\n';

  it('reverse-restores exactly this call\u2019s records and leaves the previous plan version applied', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();

    mkdirSync(join(workspace.projectRoot, 'src'), { recursive: true });
    writeFileSync(join(workspace.projectRoot, 'src/cart.ts'), PREVIOUS_ORIGINAL);
    writeFileSync(join(workspace.projectRoot, 'src/shipping.ts'), DELTA_ORIGINAL);

    // Plan version 1 is already installed: its file carries the patch and its
    // record is applied.
    const previousContext = makeContext({ workspace, journal, planVersion: 1 });
    const previousRecord = await applyPatch(
      { file: 'src/cart.ts', instrumented: PREVIOUS_INSTRUMENTED },
      previousContext,
    );

    expect(readFileSync(join(workspace.projectRoot, 'src/cart.ts'), 'utf8')).toBe(
      PREVIOUS_INSTRUMENTED,
    );

    const calls: string[] = [];
    const failure = new DebuggenError('PATCH_UNSUPPORTED', 'The declaration cannot be wrapped.');
    const plan = planWith(
      [
        action({
          adapter: 'writer',
          id: 'act_0000000000000301',
          type: 'function-timing',
          mode: 'patch',
          file: 'src/shipping.ts',
        }),
        action({
          adapter: 'thrower',
          id: 'act_0000000000000302',
          type: 'function-timing',
          mode: 'patch',
          file: 'src/cart.ts',
        }),
      ],
      2,
    );

    const error = expectErr(
      await installPlan(plan, makeContext({ workspace, journal, planVersion: 2 }), {
        adapters: [
          patchingAdapter('writer', calls, [
            {
              file: 'src/shipping.ts',
              instrumented: 'export function quote() {\n  return 1;\n}\n',
            },
          ]),
          fakeAdapter('thrower', (): Promise<InstallResult> => {
            calls.push('thrower');

            return Promise.reject(failure);
          }),
        ],
        delta: {
          previousPlanVersion: 1,
          actionIds: ['act_0000000000000301', 'act_0000000000000302'],
        },
        skipFeasibility: true,
      }),
    );

    expect(calls).toEqual(['writer', 'thrower']);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.cause).toBe(failure);
    expect(error.details?.['restoredCount']).toBe(1);
    expect(error.details?.['conflictCount']).toBe(0);
    expect(error.details?.['failureCount']).toBe(0);
    expect(error.details?.['previousPlanVersion']).toBe(1);
    expect(error.message).toContain('plan version 1');

    // The delta's file is byte-identical to what it held before this call.
    expect(readFileSync(join(workspace.projectRoot, 'src/shipping.ts'), 'utf8')).toBe(
      DELTA_ORIGINAL,
    );
    expect(
      Buffer.compare(
        readFileSync(join(workspace.projectRoot, 'src/shipping.ts')),
        Buffer.from(DELTA_ORIGINAL, 'utf8'),
      ),
    ).toBe(0);

    // The previous plan version's patch is untouched, and its record is still
    // applied: the session is exactly where it was.
    expect(readFileSync(join(workspace.projectRoot, 'src/cart.ts'), 'utf8')).toBe(
      PREVIOUS_INSTRUMENTED,
    );
    expect(journal.rows().find((row) => row.id === previousRecord.id)?.status).toBe('applied');
    expect(
      journal
        .rows()
        .filter((row) => row.planVersion === 2)
        .map((row) => row.status),
    ).toEqual(['reverted']);
  });

  it('unwinds the same way when an adapter returns something that is not an install result', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();

    writeFileSync(join(workspace.projectRoot, 'thing.ts'), DELTA_ORIGINAL);

    const calls: string[] = [];
    const plan = planWith([
      action({
        adapter: 'writer',
        type: 'function-timing',
        mode: 'patch',
        file: 'thing.ts',
      }),
      action({ adapter: 'liar', type: 'function-timing', mode: 'patch', file: 'thing.ts' }),
    ]);

    const error = expectErr(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: [
          patchingAdapter('writer', calls, [
            { file: 'thing.ts', instrumented: 'export function quote() {\n  return 2;\n}\n' },
          ]),
          fakeAdapter('liar', () => {
            calls.push('liar');

            return Promise.resolve(undefined as unknown as InstallResult);
          }),
        ],
        skipFeasibility: true,
      }),
    );

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('invalid-result');
    expect(readFileSync(join(workspace.projectRoot, 'thing.ts'), 'utf8')).toBe(DELTA_ORIGINAL);
  });

  it('honours an abort between groups, unwinding what it had applied', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();
    const controller = new AbortController();

    writeFileSync(join(workspace.projectRoot, 'unit.ts'), DELTA_ORIGINAL);

    const calls: string[] = [];
    const context = makeContext({ workspace, journal, signal: controller.signal });
    const plan = planWith([
      action({ adapter: 'writer', type: 'function-timing', mode: 'patch', file: 'unit.ts' }),
      action({ adapter: 'second', type: 'function-timing', mode: 'patch', file: 'unit.ts' }),
    ]);

    const error = expectErr(
      await installPlan(plan, context, {
        adapters: [
          fakeAdapter('writer', async (_actions, callContext): Promise<InstallResult> => {
            calls.push('writer');

            const record = await applyPatch(
              { file: 'unit.ts', instrumented: 'export function quote() {\n  return 3;\n}\n' },
              callContext,
            );

            // The developer cancels while the first group is still running.
            controller.abort();

            return { adapterId: 'writer', applied: [record], runtimeHooks: [], unavailable: [] };
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

    expect(calls).toEqual(['writer']);
    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('aborted');
    expect(readFileSync(join(workspace.projectRoot, 'unit.ts'), 'utf8')).toBe(DELTA_ORIGINAL);
  });

  it('reports a rollback it could not finish instead of claiming the project is clean', async () => {
    const workspace = makeWorkspace();
    const journal = fakeJournal();

    writeFileSync(join(workspace.projectRoot, 'edited.ts'), DELTA_ORIGINAL);

    const calls: string[] = [];
    const plan = planWith([
      action({ adapter: 'writer', type: 'function-timing', mode: 'patch', file: 'edited.ts' }),
      action({ adapter: 'thrower', type: 'function-timing', mode: 'patch', file: 'edited.ts' }),
    ]);

    const error = expectErr(
      await installPlan(plan, makeContext({ workspace, journal }), {
        adapters: [
          patchingAdapter('writer', calls, [
            { file: 'edited.ts', instrumented: 'export function quote() {\n  return 4;\n}\n' },
          ]),
          fakeAdapter('thrower', (): Promise<InstallResult> => {
            calls.push('thrower');
            // The developer saves their own edit over the instrumented file
            // before the install fails: the bytes no longer match the record.
            writeFileSync(
              join(workspace.projectRoot, 'edited.ts'),
              'export function quote() {\n  return 99; // mine\n}\n',
            );

            return Promise.reject(new DebuggenError('PATCH_UNSUPPORTED', 'Cannot wrap that.'));
          }),
        ],
        skipFeasibility: true,
      }),
    );

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['conflictCount']).toBe(1);
    expect(error.details?.['restoredCount']).toBe(0);
    // The developer's edit is preserved, not overwritten by the rollback.
    expect(readFileSync(join(workspace.projectRoot, 'edited.ts'), 'utf8')).toContain('// mine');
  });
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
 * Cleanup of the suite's own temporary trees
 * ---------------------------------------------------------------------------------------------- */

describe('the suite\u2019s temporary state', () => {
  it('removes every directory it created', () => {
    for (const root of workspaces) {
      rmSync(root, { recursive: true, force: true });
    }

    expect(workspaces.length).toBeGreaterThan(0);
  });
});
