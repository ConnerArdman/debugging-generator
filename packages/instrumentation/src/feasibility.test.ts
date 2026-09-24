/**
 * Unit suite for `./feasibility.ts` — the pre-install gate of AAP §0.7.1
 * Group 1 — asserted against the committed fixture project
 * `test/fixtures/project-a`.
 *
 * ## Why the real corpus, and not a hand-built graph
 *
 * The claim this module makes is that an action which passes the gate names a
 * file and a symbol that **exist**, in a declaration shape the function-timing
 * template fits. A hand-built index would prove the branching and nothing else:
 * it could not prove that the graph a real ts-morph run produces contains the
 * declarations the checks look for, that the code-analysis `hasSymbol`
 * equivalence holds for a class member and a `.jsx` helper, or that a generator
 * written in a real file is recognised as one. So every case runs against the
 * fixture, indexed through the real `openProject` + `buildIndex`, and the
 * expectations are the fixture's own names.
 *
 * `openProject` + `buildIndex` is deliberately the cache-free build path:
 * `indexProject` would consult and populate `$DEBUGGEN_HOME/index`, which a
 * unit suite must not touch.
 *
 * ## The fixture is input, and it is read-only
 *
 * `test/fixtures/project-a` is a standalone target project — its own
 * `package.json` and `tsconfig.json`, two module specifiers that resolve to
 * nothing, and `.js`/`.jsx` files this package does not compile — which is what
 * makes it a usable stand-in for a developer's project. The gate reads it and
 * writes nothing, and the last group proves that by snapshotting every file's
 * size and modification time before the index is built and re-asserting it at
 * the end, which is the suite half of AAP §0.5.1's promise that nothing is
 * written until an install runs.
 *
 * ## What each group asserts
 *
 * - **Vocabulary** — the frozen code tuple and its predicate.
 * - **Adapter claim** — check 1, that it is skipped when no resolver is
 *   supplied, and that the resolver is asked exactly one question per action.
 * - **Runtime mode** — checks 3 to 5 apply to a runtime action's target too,
 *   so a hallucinated subject is refused; only check 6 is patch-only.
 * - **Targetless actions** — check 2: the marker is accepted for a runtime
 *   signal without a single graph lookup, and refused for a patch or a type
 *   that wraps one declaration.
 * - **Containment** — check 3, for a traversal, an absolute path and a
 *   backslash path.
 * - **The index** — check 4, for a file the graph has never seen.
 * - **The symbol** — check 5, including the qualified spelling the patcher
 *   accepts, its owner corroborated from the graph, and the bounded near-miss
 *   hint.
 * - **The declaration's shape** — check 6: every supported shape in the
 *   fixture accepted, both generators refused with their own codes, and every
 *   unwrappable form refused as `unsupported-declaration`.
 * - **The route handler** — the fixture's exported request-handler method,
 *   accepted as a server span and as a function timing, and refused for a
 *   method the module does not export.
 * - **No syntax tree** — check 6's honest answer when no project is loaded.
 * - **Shared target resolution** — over a temporary corpus of nested,
 *   duplicated, object-literal and static-block declarations: the gate's
 *   verdict on every spelling equals the function-timing patcher's.
 * - **Duplicates** — check 7, for an identical action and for two patches on
 *   one declaration, and its absence for two runtime signals on one component.
 * - **Determinism and bounds** — ordering, repeatability, serialisability, one
 *   log line, and the truncation every reported value goes through.
 * - **What a developer reads** — every code in the vocabulary reached, and
 *   neither sentence naming a host path or anything shaped like a credential.
 * - **Invariants** — the only conditions this module throws for.
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
  createCodeQueries,
  openProject,
  routeMapFromIndex,
  summarizeProject,
} from '@debuggen/code-analysis';
import type { CodeQueries, LoadedProject, ProjectSummary, RouteMap } from '@debuggen/code-analysis';
import { DebuggenError, isErr, ok, toPosix } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { InstrumentationContext } from './adapter.js';
import {
  FEASIBILITY_REJECTION_CODES,
  checkFeasibility,
  checkPlanFeasibility,
  isFeasibilityRejectionCode,
} from './feasibility.js';
import type { InfeasibleAction } from './feasibility.js';
import { createBackupStore } from './patch/backup-store.js';
import { FunctionTimingPatcher } from './patch/function-timing.js';
import type { ModificationJournal, ModificationRecord } from './schema/modification.js';
import {
  INSTRUMENTATION_PLAN_VERSION,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  instrumentationActionSchema,
  parseInstrumentationPlan,
} from './schema/plan.js';
import type {
  AdapterActionResolution,
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
  InstrumentationPlan,
  PlanAdapterResolver,
} from './schema/plan.js';

/* -------------------------------------------------------------------------------------------------
 * The corpus
 * ---------------------------------------------------------------------------------------------- */

/**
 * The read-only fixture project, resolved from this module's own URL.
 *
 * Not from `process.cwd()`: this package's Vitest project runs from the
 * repository root, and a relative path would resolve there instead.
 */
const FIXTURE_ROOT = toPosix(fileURLToPath(new URL('../test/fixtures/project-a', import.meta.url)));

/** A state root that is never written to, because no check here reaches the backup store. */
const STATE_ROOT = toPosix(join(tmpdir(), 'debuggen-feasibility-suite-state'));

/** The session every action in this suite belongs to. */
const SESSION_ID = 'ses_feasibility0001';

/** The plan revision every context stamps. */
const PLAN_VERSION = 3;

/** Files of the fixture the cases address, by their project-relative POSIX paths. */
const FILES = {
  /** Generators only: both symbols must be refused. */
  generators: 'src/server/segment-stream.ts',
  /** Exactly two function declarations: a destructured parameter with defaults, then positional. */
  planner: 'src/server/cycle-planner.ts',
  /** An async function declaration and a non-async declaration that returns a promise. */
  log: 'src/server/firing-log.ts',
  /** Async function declarations over a driver pool and a checked-out client. */
  metrics: 'src/server/kiln-metrics.ts',
  /** Arrow constants at module scope. */
  glaze: 'src/server/glaze-rules.ts',
  /** A class with methods, a property, and a constructor. */
  controller: 'src/server/kiln-controller.ts',
  /** Function declarations and a non-function constant. */
  cones: 'src/server/cone-rules.ts',
  /** Module-level driver handles: constants holding constructed objects. */
  handles: 'src/server/db-handles.ts',
  /** Plain JavaScript: a function declaration and an arrow constant. */
  legacyJs: 'src/legacy/firing-log.js',
  /** Plain JavaScript: arrow constants only, one of them block-bodied. */
  legacyArrows: 'src/legacy/rack-tally.js',
  /**
   * Plain JavaScript: function declarations only — a destructured parameter
   * with defaults, an async one, and a validating one.
   */
  legacyBisque: 'src/legacy/bisque-schedule.js',
  /** Plain JSX: a helper function beside a component. */
  legacyJsx: 'src/legacy/kiln-badge.jsx',
  /** TSX: an async submit handler declared beside the component that uses it. */
  form: 'src/components/FiringLogForm.tsx',
  /** An App Router request handler module, exporting one method. */
  route: 'app/api/firings/route.ts',
} as const;

/** The method the fixture's one route module exports, and the symbol a plan names. */
const ROUTE_METHOD = 'POST';

/** One indexing of the fixture, with the handles a context needs. */
interface IndexedFixture {
  readonly loaded: LoadedProject;
  readonly graph: CodeGraph;
  readonly queries: CodeQueries;
  readonly routeMap: RouteMap;
  readonly projectSummary: ProjectSummary;
}

/** The one indexing every case shares. */
let fixture: IndexedFixture;

/** The fixture's files, sizes and modification times before anything ran. */
let footprintBefore: readonly string[];

beforeAll(async () => {
  footprintBefore = fixtureFootprint();
  fixture = await indexFixture();
}, 120_000);

/**
 * Opens and indexes the fixture through the cache-free path.
 *
 * @returns The project handle, the graph, its queries, the route map and the
 * project summary.
 */
async function indexFixture(): Promise<IndexedFixture> {
  const opened = openProject({ projectRoot: FIXTURE_ROOT });

  if (isErr(opened)) {
    throw new Error(`the fixture did not open: ${opened.error.message}`);
  }

  const built = await buildIndex(opened.value);

  if (isErr(built)) {
    throw new Error(`the fixture did not index: ${built.error.message}`);
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

/**
 * The fixture's files with each file's size and modification time, sorted.
 *
 * Metadata only, never contents. A write anywhere under the fixture changes a
 * size, a modification time or the file list itself, and comparing two of these
 * catches it without shelling out to git.
 *
 * @returns One `path|size|mtime` line per file, in path order.
 */
function fixtureFootprint(): readonly string[] {
  return readdirSync(FIXTURE_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = `${entry.parentPath}/${entry.name}`;
      const stats = statSync(path);

      return `${path}|${String(stats.size)}|${String(stats.mtimeMs)}`;
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/* -------------------------------------------------------------------------------------------------
 * Actions, contexts and the recording logger
 * ---------------------------------------------------------------------------------------------- */

/** Mints distinct action ids matching `ACTION_ID_PATTERN`. */
let actionCounter = 0;

/** What a case varies about an action. */
interface ActionInput {
  readonly file: string;
  readonly symbol: string;
  readonly type?: InstrumentationActionType;
  readonly mode?: InstrumentationMode;
}

/**
 * One schema-valid action.
 *
 * Every field is spelled so `instrumentationActionSchema` accepts it — the
 * vocabulary group below parses one to prove it — because a gate asserted
 * against a malformed action would be asserted against something the installer
 * would never see.
 *
 * @param input The file, symbol and, where a case cares, the type and mode.
 * @returns The action.
 */
function action(input: ActionInput): InstrumentationAction {
  actionCounter += 1;

  return {
    id: `act_${String(actionCounter).padStart(16, '0')}`,
    file: input.file,
    symbol: input.symbol,
    type: input.type ?? 'function-timing',
    adapter: 'fixture-adapter',
    mode: input.mode ?? 'patch',
    rationale: 'Time the target so the capture shows where the interaction spent its time.',
  };
}

/** A logger that keeps what it was told, so the summary line can be asserted. */
interface RecordingLogger {
  readonly logger: Logger;
  readonly records: { level: string; message: string; fields: LogFields | undefined }[];
}

/**
 * A logger that records instead of printing.
 *
 * @returns The logger and the records it has collected.
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

/**
 * An in-memory modification journal.
 *
 * Present because {@link InstrumentationContext} requires the port, and
 * asserted on by nothing: a feasibility check writes no record, which is part
 * of what "pure with respect to the project" means. Every method answers so
 * that a misdirected call would be visible as a passing call rather than a
 * crash.
 *
 * @returns The journal.
 */
function emptyJournal(): ModificationJournal {
  const missing = (): Promise<Result<ModificationRecord>> =>
    Promise.reject(
      new DebuggenError('INTERNAL', 'The feasibility suite journal holds no records.'),
    );

  return {
    append: (record: ModificationRecord) => Promise.resolve(ok(record)),
    updateStatus: () => missing(),
    listBySession: () => Promise.resolve(ok([])),
    listOpen: () => Promise.resolve(ok([])),
  };
}

/** A resolver that claims every type, in the mode the action already carries. */
function claimsEverything(mode: InstrumentationMode = 'patch'): PlanAdapterResolver {
  return {
    resolveActionType: (): AdapterActionResolution => ({ adapter: 'fixture-adapter', mode }),
  };
}

/** A resolver that claims nothing at all. */
function claimsNothing(): PlanAdapterResolver {
  return { resolveActionType: (): undefined => undefined };
}

/**
 * A context over the indexed fixture, with the members a case wants replaced.
 *
 * @param overrides What this case changes.
 * @returns The context.
 */
function makeContext(overrides: Partial<InstrumentationContext> = {}): InstrumentationContext {
  return {
    sessionId: SESSION_ID,
    projectRoot: FIXTURE_ROOT,
    planVersion: PLAN_VERSION,
    debuggenHome: STATE_ROOT,
    logger: recordingLogger().logger,
    graph: fixture.graph,
    queries: fixture.queries,
    routeMap: fixture.routeMap,
    projectSummary: fixture.projectSummary,
    loaded: fixture.loaded,
    journal: emptyJournal(),
    backups: createBackupStore({ debuggenHome: STATE_ROOT, sessionId: SESSION_ID }),
    readiness: {},
    ...overrides,
  };
}

/**
 * The single refusal of a one-action check, failing loudly when the action was
 * accepted instead.
 *
 * @param input The action to check.
 * @param overrides Context members this case changes.
 * @returns The refusal.
 */
function refusalFor(
  input: ActionInput,
  overrides: Partial<InstrumentationContext> = {},
): InfeasibleAction {
  const report = checkFeasibility([action(input)], makeContext(overrides), {
    resolver: claimsEverything(),
  });
  const [refusal] = report.rejected;

  expect(report.feasible).toHaveLength(0);
  expect(refusal).toBeDefined();

  if (refusal === undefined) {
    throw new Error('the check accepted an action the case expects to be refused');
  }

  return refusal;
}

/**
 * Asserts that one action passes every check.
 *
 * @param input The action to check.
 */
function expectFeasible(input: ActionInput): void {
  const built = action(input);
  const report = checkFeasibility([built], makeContext(), { resolver: claimsEverything() });

  expect(report.rejected).toEqual([]);
  expect(report.feasible).toEqual([built]);
}

/**
 * Asserts the wording contract both sentences of a refusal are under: single
 * line, non-empty and bounded.
 *
 * @param refusal The refusal to check.
 */
function expectReadableRefusal(refusal: InfeasibleAction): void {
  for (const sentence of [refusal.reason, refusal.hint]) {
    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence).not.toMatch(/[\n\r\u2028\u2029]/u);
    expect(sentence.length).toBeLessThan(600);
  }

  expect(isFeasibilityRejectionCode(refusal.code)).toBe(true);
}

/**
 * The {@link DebuggenError} a call threw, failing loudly when it threw nothing
 * or threw something else.
 *
 * @param run The call under test.
 * @returns The coded error.
 */
function captureThrow(run: () => unknown): DebuggenError {
  try {
    run();
  } catch (error) {
    if (DebuggenError.is(error)) {
      return error;
    }

    throw error;
  }

  throw new Error('the call did not throw');
}

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('the rejection vocabulary', () => {
  it('is frozen and names every reason the gate refuses for', () => {
    expect(Object.isFrozen(FEASIBILITY_REJECTION_CODES)).toBe(true);
    expect([...FEASIBILITY_REJECTION_CODES]).toEqual([
      'no-adapter',
      'target-required',
      'path-outside-project',
      'file-not-indexed',
      'symbol-not-found',
      'ambiguous-symbol',
      'unsupported-generator',
      'unsupported-async-generator',
      'unsupported-declaration',
      'ast-unavailable',
      'duplicate-action',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    for (const code of FEASIBILITY_REJECTION_CODES) {
      expect(isFeasibilityRejectionCode(code)).toBe(true);
    }

    for (const other of ['', 'no_adapter', 'PATH_OUTSIDE_PROJECT', 42, null, undefined, {}]) {
      expect(isFeasibilityRejectionCode(other)).toBe(false);
    }
  });

  it('is asserted against actions the internal plan schema accepts', () => {
    const parsed = instrumentationActionSchema.safeParse(
      action({ file: FILES.planner, symbol: 'planCycleSegments' }),
    );

    expect(parsed.success).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 1 — an adapter has to claim the action
 * ---------------------------------------------------------------------------------------------- */

describe('the adapter claim', () => {
  it('refuses an action whose type no registered adapter claims', () => {
    const report = checkFeasibility(
      [action({ file: FILES.planner, symbol: 'planCycleSegments' })],
      makeContext(),
      { resolver: claimsNothing() },
    );
    const [refusal] = report.rejected;

    expect(report.feasible).toEqual([]);
    expect(refusal?.code).toBe('no-adapter');
    expect(refusal?.reason).toContain('function-timing');
    expect(refusal?.hint).toContain('Register an adapter');
  });

  it('refuses an unclaimed runtime action as well, which writes nothing either way', () => {
    const report = checkFeasibility(
      [
        action({
          file: FILES.glaze,
          symbol: 'pickGlazeProfile',
          type: 'react-render-tracking',
          mode: 'runtime',
        }),
      ],
      makeContext(),
      { resolver: claimsNothing() },
    );

    expect(report.rejected[0]?.code).toBe('no-adapter');
  });

  it('is skipped when the caller supplies no resolver', () => {
    const report = checkFeasibility(
      [action({ file: FILES.planner, symbol: 'planCycleSegments' })],
      makeContext(),
    );

    expect(report.rejected).toEqual([]);
    expect(report.feasible).toHaveLength(1);
  });

  it('asks the resolver once per action, with that action’s own type', () => {
    const resolveActionType = vi.fn(
      (type: InstrumentationActionType): AdapterActionResolution | undefined =>
        type === 'server-span' ? undefined : { adapter: 'fixture-adapter', mode: 'patch' },
    );
    const claimed = action({ file: FILES.planner, symbol: 'planCycleSegments' });
    const unclaimed = action({
      file: FILES.cones,
      symbol: 'assertConeValue',
      type: 'server-span',
    });
    const report = checkFeasibility([claimed, unclaimed], makeContext(), {
      resolver: { resolveActionType },
    });

    expect(resolveActionType.mock.calls).toEqual([['function-timing'], ['server-span']]);
    expect(report.feasible).toEqual([claimed]);
    expect(report.rejected.map((refusal) => refusal.code)).toEqual(['no-adapter']);
  });

  it('holds no resolver between calls: a later call without one asks nothing', () => {
    const resolveActionType = vi.fn((): AdapterActionResolution => ({
      adapter: 'fixture-adapter',
      mode: 'patch',
    }));
    const target = { file: FILES.glaze, symbol: 'scoreShelfSlot' } as const;

    checkFeasibility([action(target)], makeContext(), { resolver: { resolveActionType } });

    expect(resolveActionType).toHaveBeenCalledTimes(1);

    checkFeasibility([action(target)], makeContext());

    expect(resolveActionType).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Runtime mode — a target is a target, whatever installs it
 * ---------------------------------------------------------------------------------------------- */

describe('a runtime-mode action', () => {
  it('is refused when its file is absent from the project, rather than validated', () => {
    const refusal = refusalFor({
      file: 'src/components/NoSuchWidget.tsx',
      symbol: 'NoSuchWidget',
      type: 'react-render-tracking',
      mode: 'runtime',
    });

    expect(refusal.code).toBe('file-not-indexed');
    expect(refusal.reason).toContain('src/components/NoSuchWidget.tsx');
    expectReadableRefusal(refusal);
  });

  it('is refused when the file exists but declares no such symbol', () => {
    const refusal = refusalFor({
      file: FILES.form,
      symbol: 'zzzInventedComponent',
      type: 'state-tracking',
      mode: 'runtime',
    });

    expect(refusal.code).toBe('symbol-not-found');
    expect(refusal.reason).toContain('zzzInventedComponent');
    expectReadableRefusal(refusal);
  });

  it('offers the targetless marker when no near miss exists, instead of an invented subject', () => {
    const refusal = refusalFor({
      file: FILES.form,
      symbol: 'qqqzzzNothingLikeThisAnywhere',
      type: 'fetch-tracking',
      mode: 'runtime',
    });

    expect(refusal.code).toBe('symbol-not-found');
    expect(refusal.hint).toContain('targetless marker');
    expect(refusal.hint).toContain(`'${TARGETLESS_FILE}', '${TARGETLESS_SYMBOL}'`);
  });

  it('is refused when its path leaves the project', () => {
    expect(
      refusalFor({
        file: '../outside/Widget.tsx',
        symbol: 'Widget',
        type: 'react-render-tracking',
        mode: 'runtime',
      }).code,
    ).toBe('path-outside-project');
  });

  it('is accepted with no syntax tree loaded, because only a patch needs one', () => {
    const report = checkFeasibility(
      [
        action({
          file: FILES.glaze,
          symbol: 'pickGlazeProfile',
          type: 'state-tracking',
          mode: 'runtime',
        }),
      ],
      makeContext({ loaded: undefined }),
      { resolver: claimsEverything('runtime') },
    );

    expect(report.rejected).toEqual([]);
    expect(report.feasible).toHaveLength(1);
  });

  it('is accepted for a real declaration whose shape no patch could wrap, since it edits nothing', () => {
    // A class is refused as a patch target (see "an unwrappable declaration"),
    // but as the subject of a runtime signal it only has to exist.
    const report = checkFeasibility(
      [
        action({
          file: FILES.controller,
          symbol: 'KilnController',
          type: 'state-tracking',
          mode: 'runtime',
        }),
        action({
          file: FILES.generators,
          symbol: 'walkRampSegments',
          type: 'interaction-tracking',
          mode: 'runtime',
        }),
      ],
      makeContext(),
      { resolver: claimsEverything('runtime') },
    );

    expect(report.rejected).toEqual([]);
    expect(report.feasible).toHaveLength(2);
  });

  it('accepts the qualified spelling a patch would accept', () => {
    expectFeasible({
      file: FILES.controller,
      symbol: 'KilnController.normalizeRampRate',
      type: 'state-tracking',
      mode: 'runtime',
    });
  });

  it('refuses an invented qualifier on a real member name, with no syntax tree needed', () => {
    // The bare name `normalizeRampRate` is real; `GlazeSheet` is not its owner,
    // and a runtime action's shape is never checked, so the qualifier is the
    // part of the subject that has to be corroborated from the graph.
    for (const symbol of [
      'GlazeSheet.normalizeRampRate',
      'GlazeSheet#normalizeRampRate',
      'GlazeSheet.prototype.normalizeRampRate',
    ]) {
      const refusal = refusalFor(
        { file: FILES.controller, symbol, type: 'state-tracking', mode: 'runtime' },
        { loaded: undefined },
      );

      expect(refusal.code).toBe('symbol-not-found');
      expect(refusal.hint).toContain('KilnController');
      expectReadableRefusal(refusal);
    }
  });

  it('accepts every real qualifier of a member without a syntax tree', () => {
    for (const symbol of [
      'KilnController.normalizeRampRate',
      'KilnController#normalizeRampRate',
      'KilnController.prototype.normalizeRampRate',
    ]) {
      const built = action({
        file: FILES.controller,
        symbol,
        type: 'state-tracking',
        mode: 'runtime',
      });
      const report = checkFeasibility([built], makeContext({ loaded: undefined }), {
        resolver: claimsEverything('runtime'),
      });

      expect(report.rejected).toEqual([]);
      expect(report.feasible).toEqual([built]);
    }
  });

  it('refuses a qualifier on a module-scope name, which has no owner', () => {
    const refusal = refusalFor(
      {
        file: FILES.planner,
        symbol: 'Invented.planCycleSegments',
        type: 'perf-tracking',
        mode: 'runtime',
      },
      { loaded: undefined },
    );

    expect(refusal.code).toBe('symbol-not-found');
    expect(refusal.hint).toContain("bare name 'planCycleSegments'");
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 2 — targetless actions
 * ---------------------------------------------------------------------------------------------- */

describe('a targetless action', () => {
  /**
   * A context whose graph and queries fail loudly if they are consulted, so a
   * case can prove the marker is accepted without a single lookup.
   */
  function contextThatMayNotBeQueried(): InstrumentationContext {
    const forbidden = (): never => {
      throw new Error('a targetless action consulted the code graph');
    };

    return makeContext({
      graph: { nodesByFile: forbidden, files: [] } as unknown as CodeGraph,
      queries: { hasSymbol: forbidden, findByName: forbidden } as unknown as CodeQueries,
      loaded: undefined,
    });
  }

  it.each([
    'react-render-tracking',
    'fetch-tracking',
    'db-query-tracking',
    'state-tracking',
    'interaction-tracking',
    'perf-tracking',
  ] as const)('is accepted as a runtime %s action without consulting the graph', (type) => {
    const built = action({
      file: TARGETLESS_FILE,
      symbol: TARGETLESS_SYMBOL,
      type,
      mode: 'runtime',
    });
    const report = checkFeasibility([built], contextThatMayNotBeQueried(), {
      resolver: claimsEverything('runtime'),
    });

    expect(report.rejected).toEqual([]);
    expect(report.feasible).toEqual([built]);
    expect(instrumentationActionSchema.safeParse(built).success).toBe(true);
  });

  it.each([
    ['a patch-mode render action', 'react-render-tracking', 'patch'],
    ['a runtime function-timing action', 'function-timing', 'runtime'],
    ['a runtime server-span action', 'server-span', 'runtime'],
    ['a patch-mode function-timing action', 'function-timing', 'patch'],
  ] as const)('is refused as %s, which has no declaration to act on', (_label, type, mode) => {
    const report = checkFeasibility(
      [action({ file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type, mode })],
      contextThatMayNotBeQueried(),
      { resolver: claimsEverything(mode) },
    );
    const [refusal] = report.rejected;

    expect(report.feasible).toEqual([]);
    expect(refusal?.code).toBe('target-required');
    expect(refusal?.reason).toContain(type);

    if (refusal !== undefined) {
      expectReadableRefusal(refusal);
    }
  });

  it('is still refused for a type no adapter claims, before the marker is considered', () => {
    const report = checkFeasibility(
      [
        action({
          file: TARGETLESS_FILE,
          symbol: TARGETLESS_SYMBOL,
          type: 'perf-tracking',
          mode: 'runtime',
        }),
      ],
      contextThatMayNotBeQueried(),
      { resolver: claimsNothing() },
    );

    expect(report.rejected.map((refusal) => refusal.code)).toEqual(['no-adapter']);
  });

  it('refuses half of the marker as the missing target it is', () => {
    const report = checkFeasibility(
      [
        action({
          file: TARGETLESS_FILE,
          symbol: 'Widget',
          type: 'state-tracking',
          mode: 'runtime',
        }),
        action({
          file: FILES.form,
          symbol: TARGETLESS_SYMBOL,
          type: 'state-tracking',
          mode: 'runtime',
        }),
      ],
      makeContext(),
      { resolver: claimsEverything('runtime') },
    );

    expect(report.feasible).toEqual([]);
    expect(report.rejected.map((refusal) => refusal.code)).toEqual([
      'file-not-indexed',
      'symbol-not-found',
    ]);
  });

  it('counts two identical targetless actions as one request', () => {
    const first = action({
      file: TARGETLESS_FILE,
      symbol: TARGETLESS_SYMBOL,
      type: 'react-render-tracking',
      mode: 'runtime',
    });
    const second = action({
      file: TARGETLESS_FILE,
      symbol: TARGETLESS_SYMBOL,
      type: 'react-render-tracking',
      mode: 'runtime',
    });
    const report = checkFeasibility([first, second], contextThatMayNotBeQueried(), {
      resolver: claimsEverything('runtime'),
    });

    expect(report.feasible).toEqual([first]);
    expect(report.rejected.map((refusal) => refusal.code)).toEqual(['duplicate-action']);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 3 — containment
 * ---------------------------------------------------------------------------------------------- */

describe('containment', () => {
  it('refuses a traversal out of the project', () => {
    const refusal = refusalFor({ file: '../secret-recipes.ts', symbol: 'blend' });

    expect(refusal.code).toBe('path-outside-project');
    expect(refusal.reason).toContain('../secret-recipes.ts');
    expectReadableRefusal(refusal);
  });

  it('refuses an absolute path', () => {
    expect(refusalFor({ file: '/etc/hosts', symbol: 'anything' }).code).toBe(
      'path-outside-project',
    );
  });

  it('refuses a backslash path rather than converting it into an innocent-looking one', () => {
    expect(refusalFor({ file: 'src\\server\\cone-rules.ts', symbol: 'assertConeValue' }).code).toBe(
      'path-outside-project',
    );
  });

  it('never names the absolute project root in what a developer reads', () => {
    const refusal = refusalFor({ file: '../../elsewhere/kiln.ts', symbol: 'fire' });

    expect(refusal.reason).not.toContain(FIXTURE_ROOT);
    expect(refusal.hint).not.toContain(FIXTURE_ROOT);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 4 — the file has to be indexed
 * ---------------------------------------------------------------------------------------------- */

describe('the code index', () => {
  it('refuses a file the graph has never seen', () => {
    const refusal = refusalFor({ file: 'src/server/absent-module.ts', symbol: 'schedule' });

    expect(refusal.code).toBe('file-not-indexed');
    expect(refusal.reason).toContain('src/server/absent-module.ts');
    expect(refusal.hint).toContain('index the project again');
    expectReadableRefusal(refusal);
  });

  it('says so when the program holds the file but the index does not, which is a re-index', () => {
    const index = fixture.graph.toIndex();
    const withoutPlanner = CodeGraph.fromIndex({
      ...index,
      files: index.files.filter((fingerprint) => fingerprint.file !== FILES.planner),
      nodes: index.nodes.filter((node) => node.file !== FILES.planner),
      edges: index.edges.filter(
        (edge) => !edge.from.includes(FILES.planner) && !edge.to.includes(FILES.planner),
      ),
    });
    const refusal = refusalFor(
      { file: FILES.planner, symbol: 'planCycleSegments' },
      { graph: withoutPlanner, queries: createCodeQueries(withoutPlanner) },
    );

    expect(refusal.code).toBe('file-not-indexed');
    expect(refusal.reason).toContain('TypeScript program does');
    expect(refusal.hint).toContain('Index the project again');
    expectReadableRefusal(refusal);
  });

  it('truncates an over-long path rather than letting it fill the row', () => {
    const refusal = refusalFor({
      file: `src/server/${'firing-schedule-'.repeat(40)}.ts`,
      symbol: 'schedule',
    });

    expect(refusal.code).toBe('file-not-indexed');
    expect(refusal.reason).toContain('…');
    expect(refusal.reason.length).toBeLessThan(300);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 5 — the file has to declare the symbol
 * ---------------------------------------------------------------------------------------------- */

describe('the symbol', () => {
  it('refuses a name the file does not declare', () => {
    const refusal = refusalFor({ file: FILES.cones, symbol: 'zzzAbsentSymbol' });

    expect(refusal.code).toBe('symbol-not-found');
    expect(refusal.reason).toContain('zzzAbsentSymbol');
    expect(refusal.hint).toContain(FILES.cones);
    expectReadableRefusal(refusal);
  });

  it('names where the code index does declare the symbol, bounded to a few candidates', () => {
    const refusal = refusalFor({ file: FILES.glaze, symbol: 'planCycleSegments' });

    expect(refusal.code).toBe('symbol-not-found');
    expect(refusal.hint).toContain(FILES.planner);
    expect(refusal.hint.split(' at ').length - 1).toBeLessThanOrEqual(3);
    expectReadableRefusal(refusal);
  });

  it('accepts the qualified spelling the function-timing patcher accepts', () => {
    expectFeasible({ file: FILES.controller, symbol: 'KilnController.normalizeRampRate' });
    expectFeasible({ file: FILES.controller, symbol: 'KilnController#totalSoakMinutes' });
    expectFeasible({
      file: FILES.controller,
      symbol: 'KilnController.prototype.settleSegments',
    });
  });

  it('refuses a spelling qualified by a container the file does not declare', () => {
    const refusal = refusalFor({ file: FILES.controller, symbol: 'GlazeSheet.normalizeRampRate' });

    // The bare name exists, but nothing of that name is declared on or inside
    // the spelled owner — so the qualified symbol does not exist, and the hint
    // names the owner that does declare it.
    expect(refusal.code).toBe('symbol-not-found');
    expect(refusal.reason).toContain('GlazeSheet');
    expect(refusal.hint).toContain('KilnController.normalizeRampRate');
    expectReadableRefusal(refusal);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 6 — the declaration's shape
 * ---------------------------------------------------------------------------------------------- */

describe('a supported declaration', () => {
  const supported: readonly { readonly what: string; readonly input: ActionInput }[] = [
    {
      what: 'a function declaration whose one parameter is a destructured object with defaults',
      input: { file: FILES.planner, symbol: 'planCycleSegments' },
    },
    {
      what: 'a function declaration with positional parameters',
      input: { file: FILES.planner, symbol: 'estimateSoakMinutes' },
    },
    {
      what: 'an async function declaration',
      input: { file: FILES.log, symbol: 'logFiringCycle' },
    },
    {
      what: 'a non-async function declaration that returns a promise',
      input: { file: FILES.log, symbol: 'loadRecentFiringCycles' },
    },
    {
      what: 'an async function declaration over a driver pool',
      input: { file: FILES.metrics, symbol: 'readCycleTotals' },
    },
    {
      what: 'an async function declaration over a checked-out client',
      input: { file: FILES.metrics, symbol: 'collectCycleSamples' },
    },
    {
      what: 'a non-exported function declaration',
      input: { file: FILES.cones, symbol: 'findConeProfile' },
    },
    {
      what: 'an exported arrow function',
      input: { file: FILES.glaze, symbol: 'pickGlazeProfile' },
    },
    {
      what: 'a second exported arrow function',
      input: { file: FILES.glaze, symbol: 'scoreShelfSlot' },
    },
    {
      what: 'a class method',
      input: { file: FILES.controller, symbol: 'normalizeRampRate' },
    },
    {
      what: 'another class method',
      input: { file: FILES.controller, symbol: 'totalSoakMinutes' },
    },
    {
      what: 'a class method named by its bare name, without its class',
      input: { file: FILES.controller, symbol: 'settleSegments' },
    },
    {
      what: 'a server-span target on a function declaration',
      input: { file: FILES.cones, symbol: 'assertConeValue', type: 'server-span' },
    },
    {
      what: 'a function declaration in plain JavaScript',
      input: { file: FILES.legacyJs, symbol: 'tallyFiringMinutes' },
    },
    {
      what: 'an arrow constant in plain JavaScript',
      input: { file: FILES.legacyJs, symbol: 'describeFiringEntry' },
    },
    {
      what: 'an expression-bodied arrow constant in plain JavaScript',
      input: { file: FILES.legacyArrows, symbol: 'tallyRackSlots' },
    },
    {
      what: 'a block-bodied arrow constant in plain JavaScript',
      input: { file: FILES.legacyArrows, symbol: 'orderRacksByLoad' },
    },
    {
      what: 'a comparator arrow constant in plain JavaScript',
      input: { file: FILES.legacyArrows, symbol: 'compareRackLoad' },
    },
    {
      what: 'a conditional-bodied arrow constant in plain JavaScript',
      input: { file: FILES.legacyArrows, symbol: 'gradeRackDensity' },
    },
    {
      what: 'a helper function in a JSX module',
      input: { file: FILES.legacyJsx, symbol: 'formatKilnBadgeLabel' },
    },
    {
      what: 'a function declaration in plain JavaScript whose one parameter is destructured with defaults',
      input: { file: FILES.legacyBisque, symbol: 'planBisqueRamp' },
    },
    {
      what: 'an async function declaration in plain JavaScript',
      input: { file: FILES.legacyBisque, symbol: 'resolveBisqueSoak' },
    },
    {
      what: 'a validating function declaration in plain JavaScript',
      input: { file: FILES.legacyBisque, symbol: 'assertBisqueCone' },
    },
    {
      what: 'an async submit handler declared in a TSX module beside its component',
      input: { file: FILES.form, symbol: 'handleFiringSubmit' },
    },
  ];

  for (const { what, input } of supported) {
    it(`accepts ${what}`, () => {
      expectFeasible(input);
    });
  }
});

/* -------------------------------------------------------------------------------------------------
 * The route handler — the target every server-side plan starts from
 * ---------------------------------------------------------------------------------------------- */

describe("an App Router request handler's exported method", () => {
  it('is a route the index recognises, declaring the method a plan would name', () => {
    const entry = fixture.routeMap.entries.find((candidate) => candidate.file === FILES.route);

    expect(entry).toBeDefined();
    expect(entry?.methods).toContain(ROUTE_METHOD);
  });

  it('is accepted for a server-span action, which is what a route handler is planned as', () => {
    expectFeasible({ file: FILES.route, symbol: ROUTE_METHOD, type: 'server-span' });
  });

  it('is accepted for a function-timing action on the same declaration', () => {
    expectFeasible({ file: FILES.route, symbol: ROUTE_METHOD, type: 'function-timing' });
  });

  it('carries one patch and not two, however the two actions are typed', () => {
    const span = action({ file: FILES.route, symbol: ROUTE_METHOD, type: 'server-span' });
    const timing = action({ file: FILES.route, symbol: ROUTE_METHOD, type: 'function-timing' });
    const report = checkFeasibility([span, timing], makeContext(), {
      resolver: claimsEverything(),
    });

    expect(report.feasible).toEqual([span]);
    expect(report.rejected[0]?.code).toBe('duplicate-action');
  });

  it('refuses a method the route module does not export', () => {
    const refusal = refusalFor({ file: FILES.route, symbol: 'DELETE', type: 'server-span' });

    expect(refusal.code).toBe('symbol-not-found');
    expect(refusal.reason).toContain(FILES.route);
    expectReadableRefusal(refusal);
  });
});

describe('a generator declaration', () => {
  it('is refused, because a wrapper that calls the body cannot preserve yield', () => {
    const refusal = refusalFor({ file: FILES.generators, symbol: 'walkRampSegments' });

    expect(refusal.code).toBe('unsupported-generator');
    expect(refusal.reason).toContain('generator');
    expect(refusal.reason).toContain('yield');
    expect(refusal.hint).toContain('delegates to');
    expectReadableRefusal(refusal);
  });

  it('is refused under its own code when it is an async generator', () => {
    const refusal = refusalFor({ file: FILES.generators, symbol: 'streamKilnSamples' });

    expect(refusal.code).toBe('unsupported-async-generator');
    expect(refusal.reason).toContain('async generator');
    expectReadableRefusal(refusal);
  });

  it('leaves no symbol of the generator module installable', () => {
    const names = [
      ...new Set(
        fixture.graph
          .nodesByFile(FILES.generators)
          .filter((node) => node.kind !== 'file')
          .map((node) => node.name),
      ),
    ].sort();

    expect(names).toContain('walkRampSegments');
    expect(names).toContain('streamKilnSamples');

    const report = checkFeasibility(
      names.map((symbol) => action({ file: FILES.generators, symbol })),
      makeContext(),
      { resolver: claimsEverything() },
    );

    expect(report.feasible).toEqual([]);
    expect(report.rejected).toHaveLength(names.length);

    for (const refusal of report.rejected) {
      expectReadableRefusal(refusal);
    }
  });
});

describe('an unwrappable declaration', () => {
  const unwrappable: readonly { readonly what: string; readonly input: ActionInput }[] = [
    { what: 'a class', input: { file: FILES.controller, symbol: 'KilnController' } },
    { what: 'a constructor', input: { file: FILES.controller, symbol: 'constructor' } },
    {
      what: 'a class property with no initialiser',
      input: { file: FILES.controller, symbol: 'segments' },
    },
    {
      what: 'a constant holding a list',
      input: { file: FILES.cones, symbol: 'CONE_PROFILES' },
    },
    {
      what: 'a constant holding a constructed object',
      input: { file: FILES.handles, symbol: 'prisma' },
    },
  ];

  for (const { what, input } of unwrappable) {
    it(`refuses ${what}`, () => {
      const refusal = refusalFor(input);

      expect(refusal.code).toBe('unsupported-declaration');
      expect(refusal.reason).toContain(input.symbol);
      expectReadableRefusal(refusal);
    });
  }
});

/* -------------------------------------------------------------------------------------------------
 * Check 6 — and the honest answer when there is no syntax tree
 * ---------------------------------------------------------------------------------------------- */

describe('with no syntax tree loaded', () => {
  it('reports that the shape could not be checked rather than guessing', () => {
    const refusal = refusalFor(
      { file: FILES.planner, symbol: 'planCycleSegments' },
      { loaded: undefined },
    );

    expect(refusal.code).toBe('ast-unavailable');
    expect(refusal.reason).toContain('planCycleSegments');
    expectReadableRefusal(refusal);
  });

  it('still refuses an absent symbol on its own terms, which needs no tree', () => {
    const refusal = refusalFor(
      { file: FILES.planner, symbol: 'zzzAbsentSymbol' },
      { loaded: undefined },
    );

    expect(refusal.code).toBe('symbol-not-found');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 6 — one target resolver, shared with the patcher
 * ---------------------------------------------------------------------------------------------- */

/**
 * A corpus of the declaration positions the gate and the function-timing
 * patcher used to disagree about, written to a temporary directory because the
 * committed fixture is read-only and holds none of them.
 *
 * Every file is strict TypeScript with no React, `super`, `new.target` or
 * `arguments`, so the patcher's wrapper-dependent support checks cannot fire:
 * whatever the patcher refuses here, it refuses while *resolving* the target,
 * which is exactly the half the gate shares with it.
 */
const RESOLUTION_CORPUS: Readonly<Record<string, string>> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
    },
    include: ['src/**/*.ts'],
  }),
  // One name, nested in two scopes: a bare spelling cannot choose.
  'src/nested-duplicates.ts': [
    'export function alphaStage(): number {',
    '  function settle(): number {',
    '    return 1;',
    '  }',
    '',
    '  return settle();',
    '}',
    '',
    'export function betaStage(): number {',
    '  function settle(): number {',
    '    return 2;',
    '  }',
    '',
    '  return settle();',
    '}',
    '',
  ].join('\n'),
  // A named function expression is its nested declaration's owner, not the
  // variable that holds it.
  'src/nested-owner.ts': [
    'export const pick = function onPick(): number {',
    '  function inner(): number {',
    '    return 1;',
    '  }',
    '',
    '  return inner();',
    '};',
    '',
  ].join('\n'),
  // An object-literal member is a position no wrapper addresses.
  'src/object-literal.ts': [
    'export const handlers = {',
    '  onSelect: (): number => {',
    '    function inner(): number {',
    '      return 2;',
    '    }',
    '',
    '    return inner();',
    '  },',
    '  inner(): number {',
    '    return 3;',
    '  },',
    '};',
    '',
  ].join('\n'),
  // A function declared in a class static block is a nested declaration.
  'src/static-block.ts': [
    'export class Registry {',
    '  static count = 0;',
    '',
    '  static {',
    '    function boot(): number {',
    '      return 4;',
    '    }',
    '',
    '    Registry.count = boot();',
    '  }',
    '}',
    '',
  ].join('\n'),
  // Module scope wins a bare name; the nested twin needs its owner's name.
  'src/module-first.ts': [
    'export function tally(): number {',
    '  return 5;',
    '}',
    '',
    'export function report(): number {',
    '  function tally(): number {',
    '    return 6;',
    '  }',
    '',
    '  return tally();',
    '}',
    '',
  ].join('\n'),
  // Members of a module-scope class, in every shape the resolver classifies.
  'src/members.ts': [
    'export class Gauge {',
    '  private reading = 0;',
    '',
    '  constructor(start: number) {',
    '    this.reading = start;',
    '  }',
    '',
    '  get level(): number {',
    '    return this.reading;',
    '  }',
    '',
    '  sample(delta: number): number {',
    '    this.reading += delta;',
    '    return this.reading;',
    '  }',
    '',
    '  *steps(): Generator<number> {',
    '    yield this.reading;',
    '  }',
    '}',
    '',
  ].join('\n'),
};

/**
 * Every `(file, symbol)` spelling the equivalence case compares, chosen to
 * cover each resolution rule: ambiguity, qualification by an enclosing
 * function, by a function expression's own name, by a holder that does not
 * own the declaration, object-literal positions, static blocks, module scope
 * before nested scope, and each member shape.
 */
const RESOLUTION_SPELLINGS: readonly (readonly [file: string, symbol: string])[] = [
  ['src/nested-duplicates.ts', 'settle'],
  ['src/nested-duplicates.ts', 'alphaStage.settle'],
  ['src/nested-duplicates.ts', 'betaStage.settle'],
  ['src/nested-duplicates.ts', 'alphaStage'],
  ['src/nested-owner.ts', 'inner'],
  ['src/nested-owner.ts', 'onPick.inner'],
  ['src/nested-owner.ts', 'pick.inner'],
  ['src/nested-owner.ts', 'pick'],
  ['src/object-literal.ts', 'handlers.inner'],
  ['src/object-literal.ts', 'onSelect.inner'],
  ['src/object-literal.ts', 'inner'],
  ['src/static-block.ts', 'boot'],
  ['src/static-block.ts', 'Registry.boot'],
  ['src/module-first.ts', 'tally'],
  ['src/module-first.ts', 'report.tally'],
  ['src/module-first.ts', 'report'],
  ['src/members.ts', 'sample'],
  ['src/members.ts', 'Gauge.sample'],
  ['src/members.ts', 'Gauge#sample'],
  ['src/members.ts', 'Gauge.prototype.sample'],
  ['src/members.ts', 'level'],
  ['src/members.ts', 'constructor'],
  ['src/members.ts', 'steps'],
  ['src/members.ts', 'Gauge'],
];

/** Where the resolution corpus was written for this run. */
let corpusRoot: string;

/** The one indexing of the resolution corpus every case shares. */
let corpus: IndexedFixture;

beforeAll(async () => {
  corpusRoot = toPosix(mkdtempSync(join(tmpdir(), 'debuggen-feasibility-resolution-')));

  for (const [relative, text] of Object.entries(RESOLUTION_CORPUS)) {
    const target = join(corpusRoot, relative);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  const opened = openProject({ projectRoot: corpusRoot });

  if (isErr(opened)) {
    throw new Error(`the resolution corpus did not open: ${opened.error.message}`);
  }

  const built = await buildIndex(opened.value);

  if (isErr(built)) {
    throw new Error(`the resolution corpus did not index: ${built.error.message}`);
  }

  const graph = CodeGraph.fromIndex(built.value);
  const routeMap = routeMapFromIndex(built.value);

  corpus = {
    loaded: opened.value,
    graph,
    queries: createCodeQueries(graph, { loaded: opened.value }),
    routeMap,
    projectSummary: summarizeProject({ loaded: opened.value, graph, routeMap }),
  };
}, 120_000);

afterAll(() => {
  rmSync(corpusRoot, { recursive: true, force: true });
});

/** A context over the resolution corpus. */
function corpusContext(): InstrumentationContext {
  return makeContext({
    projectRoot: corpusRoot,
    graph: corpus.graph,
    queries: corpus.queries,
    routeMap: corpus.routeMap,
    projectSummary: corpus.projectSummary,
    loaded: corpus.loaded,
  });
}

describe('target resolution shared with the function-timing patcher', () => {
  /** The gate's verdict on one patch-mode spelling: `'feasible'` or the code. */
  function gateVerdict(file: string, symbol: string): string {
    const report = checkFeasibility([action({ file, symbol })], corpusContext(), {
      resolver: claimsEverything(),
    });

    return report.feasible.length === 1 ? 'feasible' : (report.rejected[0]?.code ?? 'missing');
  }

  /** The patcher's verdict on the same spelling: `'patchable'` or its reason. */
  function patcherVerdict(file: string, symbol: string): string {
    const patcher = new FunctionTimingPatcher({
      projectRoot: corpusRoot,
      verifyPatchedTypes: false,
    });
    const outcome = patcher.patch({
      file,
      symbol,
      text: readFileSync(join(corpusRoot, file), 'utf8'),
    });

    return outcome.ok ? 'patchable' : String(outcome.error.details?.['reason']);
  }

  it('refuses a bare name two nested declarations share, as the patcher does', () => {
    expect(gateVerdict('src/nested-duplicates.ts', 'settle')).toBe('ambiguous-symbol');
    expect(patcherVerdict('src/nested-duplicates.ts', 'settle')).toBe('ambiguous-symbol');

    const refusal = checkFeasibility(
      [action({ file: 'src/nested-duplicates.ts', symbol: 'settle' })],
      corpusContext(),
      { resolver: claimsEverything() },
    ).rejected[0];

    // The hint is the resolver's own: the spellings that do name one of them.
    expect(refusal?.hint).toContain('alphaStage.settle');
    expect(refusal?.hint).toContain('betaStage.settle');

    if (refusal !== undefined) {
      expectReadableRefusal(refusal);
    }
  });

  it('accepts either duplicate once it is qualified by the function that owns it', () => {
    expect(gateVerdict('src/nested-duplicates.ts', 'alphaStage.settle')).toBe('feasible');
    expect(gateVerdict('src/nested-duplicates.ts', 'betaStage.settle')).toBe('feasible');
  });

  it('names a nested declaration by the function expression that owns it, as the patcher does', () => {
    expect(gateVerdict('src/nested-owner.ts', 'onPick.inner')).toBe('feasible');
    expect(patcherVerdict('src/nested-owner.ts', 'onPick.inner')).toBe('patchable');
  });

  it('refuses an object-literal member the patcher cannot address', () => {
    // The graph records the only addressable `inner` under `onSelect`, so the
    // `handlers` qualifier is refused before a tree is read, and the hint gives
    // the spelling that does address it.
    expect(gateVerdict('src/object-literal.ts', 'handlers.inner')).toBe('symbol-not-found');
    expect(patcherVerdict('src/object-literal.ts', 'handlers.inner')).toBe(
      'symbol-not-addressable',
    );

    const refusal = checkFeasibility(
      [action({ file: 'src/object-literal.ts', symbol: 'handlers.inner' })],
      corpusContext(),
      { resolver: claimsEverything() },
    ).rejected[0];

    expect(refusal?.hint).toContain('onSelect.inner');
  });

  it('accepts a function declared in a class static block, which the graph now records', () => {
    expect(corpus.queries.hasSymbol('src/static-block.ts', 'boot')).toBe(true);
    expect(gateVerdict('src/static-block.ts', 'boot')).toBe('feasible');
    expect(patcherVerdict('src/static-block.ts', 'boot')).toBe('patchable');
  });

  it('keeps a bare module-scope name on the module-scope declaration', () => {
    expect(gateVerdict('src/module-first.ts', 'tally')).toBe('feasible');
    expect(gateVerdict('src/module-first.ts', 'report.tally')).toBe('feasible');
  });

  it('corroborates the owner of a nested runtime subject from the graph alone', () => {
    const runtimeVerdict = (file: string, symbol: string): string => {
      const report = checkFeasibility(
        [action({ file, symbol, type: 'state-tracking', mode: 'runtime' })],
        makeContext({
          projectRoot: corpusRoot,
          graph: corpus.graph,
          queries: corpus.queries,
          loaded: undefined,
        }),
        { resolver: claimsEverything('runtime') },
      );

      return report.feasible.length === 1 ? 'feasible' : (report.rejected[0]?.code ?? 'missing');
    };

    expect(runtimeVerdict('src/nested-duplicates.ts', 'alphaStage.settle')).toBe('feasible');
    expect(runtimeVerdict('src/nested-duplicates.ts', 'gammaStage.settle')).toBe(
      'symbol-not-found',
    );
    expect(runtimeVerdict('src/nested-owner.ts', 'onPick.inner')).toBe('feasible');
    expect(runtimeVerdict('src/nested-owner.ts', 'pick.inner')).toBe('symbol-not-found');
    expect(runtimeVerdict('src/object-literal.ts', 'onSelect.inner')).toBe('feasible');
    expect(runtimeVerdict('src/object-literal.ts', 'handlers.inner')).toBe('symbol-not-found');
    expect(runtimeVerdict('src/module-first.ts', 'report.tally')).toBe('feasible');
    expect(runtimeVerdict('src/module-first.ts', 'summary.tally')).toBe('symbol-not-found');
  });

  it('agrees with the patcher on every spelling in the corpus', () => {
    const disagreements = RESOLUTION_SPELLINGS.flatMap(([file, symbol]) => {
      const gate = gateVerdict(file, symbol);
      const patcher = patcherVerdict(file, symbol);

      return (gate === 'feasible') === (patcher === 'patchable')
        ? []
        : [`${file} ${symbol}: gate=${gate} patcher=${patcher}`];
    });

    expect(disagreements).toEqual([]);
  });

  it('reports every refusal in the corpus in readable, bounded sentences', () => {
    for (const [file, symbol] of RESOLUTION_SPELLINGS) {
      for (const refusal of checkFeasibility([action({ file, symbol })], corpusContext(), {
        resolver: claimsEverything(),
      }).rejected) {
        expectReadableRefusal(refusal);
        expect(refusal.reason).not.toContain(corpusRoot);
        expect(refusal.hint).not.toContain(corpusRoot);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 7 — duplicates
 * ---------------------------------------------------------------------------------------------- */

describe('duplicates within one call', () => {
  it('accepts the first request for an instrumentation and refuses the second', () => {
    const first = action({ file: FILES.planner, symbol: 'planCycleSegments' });
    const second = action({ file: FILES.planner, symbol: 'planCycleSegments' });
    const report = checkFeasibility([first, second], makeContext(), {
      resolver: claimsEverything(),
    });

    expect(report.feasible).toEqual([first]);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.action).toBe(second);
    expect(report.rejected[0]?.code).toBe('duplicate-action');
    expect(report.rejected[0]?.reason).toContain('planCycleSegments');
  });

  it('refuses a second patch on one declaration even under a different action type', () => {
    const timing = action({
      file: FILES.cones,
      symbol: 'assertConeValue',
      type: 'function-timing',
    });
    const span = action({ file: FILES.cones, symbol: 'assertConeValue', type: 'server-span' });
    const report = checkFeasibility([timing, span], makeContext(), {
      resolver: claimsEverything(),
    });

    expect(report.feasible).toEqual([timing]);
    expect(report.rejected[0]?.code).toBe('duplicate-action');
    expect(report.rejected[0]?.reason).toContain('function-timing');
  });

  it('keeps two runtime signals on one component, which are not the same action', () => {
    const renders = action({
      file: FILES.glaze,
      symbol: 'pickGlazeProfile',
      type: 'react-render-tracking',
      mode: 'runtime',
    });
    const state = action({
      file: FILES.glaze,
      symbol: 'pickGlazeProfile',
      type: 'state-tracking',
      mode: 'runtime',
    });
    const report = checkFeasibility([renders, state], makeContext(), {
      resolver: claimsEverything('runtime'),
    });

    expect(report.rejected).toEqual([]);
    expect(report.feasible).toEqual([renders, state]);
  });

  it('refuses a repeated runtime signal, which is the same action twice', () => {
    const first = action({
      file: FILES.glaze,
      symbol: 'pickGlazeProfile',
      type: 'fetch-tracking',
      mode: 'runtime',
    });
    const again = action({
      file: FILES.glaze,
      symbol: 'pickGlazeProfile',
      type: 'fetch-tracking',
      mode: 'runtime',
    });
    const report = checkFeasibility([first, again], makeContext(), {
      resolver: claimsEverything('runtime'),
    });

    expect(report.feasible).toEqual([first]);
    expect(report.rejected[0]?.code).toBe('duplicate-action');
  });

  it('explains a refused action twice over rather than calling the second a duplicate', () => {
    const first = action({ file: FILES.generators, symbol: 'walkRampSegments' });
    const second = action({ file: FILES.generators, symbol: 'walkRampSegments' });
    const report = checkFeasibility([first, second], makeContext(), {
      resolver: claimsEverything(),
    });

    expect(report.feasible).toEqual([]);
    expect(report.rejected.map((refusal) => refusal.code)).toEqual([
      'unsupported-generator',
      'unsupported-generator',
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Determinism, ordering and bounds
 * ---------------------------------------------------------------------------------------------- */

describe('the report', () => {
  /** A mixed set: two installable actions and three refusals, interleaved. */
  function mixedActions(): readonly InstrumentationAction[] {
    return [
      action({ file: FILES.generators, symbol: 'walkRampSegments' }),
      action({ file: FILES.planner, symbol: 'planCycleSegments' }),
      action({ file: 'src/server/absent-module.ts', symbol: 'schedule' }),
      action({ file: FILES.glaze, symbol: 'scoreShelfSlot' }),
      action({ file: '../escape.ts', symbol: 'escape' }),
    ];
  }

  it('partitions the input exactly, keeping input order on both sides', () => {
    const actions = mixedActions();
    const report = checkFeasibility(actions, makeContext(), { resolver: claimsEverything() });

    expect(report.feasible.map((entry) => entry.id)).toEqual([actions[1]?.id, actions[3]?.id]);
    expect(report.rejected.map((refusal) => refusal.action.id)).toEqual([
      actions[0]?.id,
      actions[2]?.id,
      actions[4]?.id,
    ]);
    expect(report.feasible.length + report.rejected.length).toBe(actions.length);
  });

  it('survives the round trip every persisted and broadcast report makes', () => {
    const report = checkFeasibility(mixedActions(), makeContext(), {
      resolver: claimsEverything(),
    });
    const roundTripped: unknown = JSON.parse(JSON.stringify(report));

    expect(roundTripped).toEqual(report);
  });

  it('answers identically on a second run over the same project', () => {
    const actions = mixedActions();
    const first = checkFeasibility(actions, makeContext(), { resolver: claimsEverything() });
    const second = checkFeasibility(actions, makeContext(), { resolver: claimsEverything() });

    expect(second).toEqual(first);
  });

  it('is empty for an empty action list, and logs that', () => {
    const recorder = recordingLogger();
    const report = checkFeasibility([], makeContext({ logger: recorder.logger }));

    expect(report).toEqual({ feasible: [], rejected: [] });
    expect(recorder.records).toHaveLength(1);
  });

  it('writes one bounded summary line, with the distinct codes in vocabulary order', () => {
    const recorder = recordingLogger();

    checkFeasibility(mixedActions(), makeContext({ logger: recorder.logger }), {
      resolver: claimsEverything(),
    });

    expect(recorder.records).toHaveLength(1);

    const [record] = recorder.records;

    expect(record?.level).toBe('debug');
    expect(record?.fields).toEqual({
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      actions: 5,
      feasible: 2,
      rejected: 3,
      codes: ['path-outside-project', 'file-not-indexed', 'unsupported-generator'],
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * What a developer reads — every code in the vocabulary, and nothing leaked into either sentence
 * ---------------------------------------------------------------------------------------------- */

describe('every refusal this gate can produce', () => {
  /** Values that would be a disclosure in a sentence shown in two user interfaces. */
  const LEAKS: readonly string[] = [FIXTURE_ROOT, STATE_ROOT, tmpdir(), toPosix(process.cwd())];

  /**
   * Absolute-path-looking tokens, so that the only one a sentence may name — the
   * path the action itself carried — can be told apart from a host path the
   * module composed.
   */
  const ABSOLUTE_TOKEN_PATTERN = /(?:^|[\s'"(])(\/[^\s'")]+)/gu;

  /** Provider key, token and private-key shapes, none of which belongs in a rejection. */
  const SECRET_PATTERNS: readonly RegExp[] = [
    /sk-ant-/u,
    /\bsk-[A-Za-z0-9]{8,}/u,
    /\bghp_[A-Za-z0-9]{8,}/u,
    /\bgithub_pat_/u,
    /\bAKIA[0-9A-Z]{8,}/u,
    /\bBearer\s+\S+/u,
    /\beyJ[A-Za-z0-9_-]{8,}\./u,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /postgres(?:ql)?:\/\//u,
  ];

  /**
   * One refusal of every code in the vocabulary, collected over the few calls
   * it takes to reach them all.
   *
   * Several calls rather than one because three of the codes are properties of
   * a call rather than of an action: `no-adapter` needs a resolver that claims
   * nothing, which would then refuse every other action too,
   * `ast-unavailable` needs a context with no loaded project, and
   * `ambiguous-symbol` needs a file declaring one name twice, which only the
   * resolution corpus holds.
   *
   * @returns Every refusal, in the order the calls produced them.
   */
  function everyRefusal(): readonly InfeasibleAction[] {
    const unclaimed = checkFeasibility(
      [action({ file: FILES.planner, symbol: 'planCycleSegments' })],
      makeContext(),
      { resolver: claimsNothing() },
    );
    const projectSide = checkFeasibility(
      [
        action({ file: '../escape.ts', symbol: 'escape' }),
        action({ file: '/etc/hosts', symbol: 'anything' }),
        action({ file: 'src/server/absent-module.ts', symbol: 'schedule' }),
        action({ file: FILES.cones, symbol: 'zzzAbsentSymbol' }),
        action({ file: FILES.generators, symbol: 'walkRampSegments' }),
        action({ file: FILES.generators, symbol: 'streamKilnSamples' }),
        action({ file: FILES.controller, symbol: 'KilnController' }),
        action({ file: FILES.glaze, symbol: 'scoreShelfSlot' }),
        action({ file: FILES.glaze, symbol: 'scoreShelfSlot' }),
        action({ file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL }),
      ],
      makeContext(),
      { resolver: claimsEverything() },
    );
    const ambiguous = checkFeasibility(
      [action({ file: 'src/nested-duplicates.ts', symbol: 'settle' })],
      corpusContext(),
      { resolver: claimsEverything() },
    );
    const noTree = checkFeasibility(
      [action({ file: FILES.planner, symbol: 'planCycleSegments' })],
      makeContext({ loaded: undefined }),
      { resolver: claimsEverything() },
    );

    return [
      ...unclaimed.rejected,
      ...projectSide.rejected,
      ...ambiguous.rejected,
      ...noTree.rejected,
    ];
  }

  it('reaches every code in the vocabulary, and only codes in it', () => {
    const codes = new Set(everyRefusal().map((refusal) => refusal.code));

    expect([...FEASIBILITY_REJECTION_CODES].filter((code) => !codes.has(code))).toEqual([]);

    for (const code of codes) {
      expect(isFeasibilityRejectionCode(code)).toBe(true);
    }
  });

  it('says something readable in both sentences, every time', () => {
    for (const refusal of everyRefusal()) {
      expectReadableRefusal(refusal);
      expect(refusal.reason.trim()).not.toBe('');
      expect(refusal.hint.trim()).not.toBe('');
    }
  });

  it('names no absolute path except the one the action itself carried', () => {
    for (const refusal of everyRefusal()) {
      for (const sentence of [refusal.reason, refusal.hint]) {
        for (const leak of LEAKS) {
          expect(sentence).not.toContain(leak);
        }

        for (const [, token] of sentence.matchAll(ABSOLUTE_TOKEN_PATTERN)) {
          expect(token).toBe(refusal.action.file);
        }
      }
    }
  });

  it('carries no value shaped like a credential', () => {
    for (const refusal of everyRefusal()) {
      for (const sentence of [refusal.reason, refusal.hint]) {
        for (const pattern of SECRET_PATTERNS) {
          expect(sentence).not.toMatch(pattern);
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The plan form
 * ---------------------------------------------------------------------------------------------- */

describe('checkPlanFeasibility', () => {
  /**
   * A schema-valid plan over the fixture.
   *
   * @param targets The actions the plan carries.
   * @returns The plan.
   */
  function planOf(targets: readonly InstrumentationAction[]): InstrumentationPlan {
    return {
      version: INSTRUMENTATION_PLAN_VERSION,
      planVersion: PLAN_VERSION,
      sessionId: SESSION_ID,
      objective: 'Determine where a firing schedule request spends its time.',
      hypotheses: ['The cycle planner recomputes the schedule for every segment.'],
      capture: ['server request spans', 'function timing'],
      instrumentationTargets: [...targets],
    };
  }

  it('judges a plan exactly as it judges its actions', () => {
    const targets = [
      action({ file: FILES.planner, symbol: 'planCycleSegments' }),
      action({ file: FILES.generators, symbol: 'streamKilnSamples' }),
    ];
    const plan = planOf(targets);

    expect(parseInstrumentationPlan(plan).ok).toBe(true);

    const fromPlan = checkPlanFeasibility(plan, makeContext(), { resolver: claimsEverything() });
    const fromActions = checkFeasibility(targets, makeContext(), {
      resolver: claimsEverything(),
    });

    expect(fromPlan.feasible.map((entry) => entry.id)).toEqual(
      fromActions.feasible.map((entry) => entry.id),
    );
    expect(fromPlan.rejected.map((refusal) => refusal.code)).toEqual(
      fromActions.rejected.map((refusal) => refusal.code),
    );
    expect(fromPlan.rejected[0]?.code).toBe('unsupported-async-generator');
  });

  it('refuses every target of a plan whose type nothing claims', () => {
    const plan = planOf([
      action({ file: FILES.planner, symbol: 'planCycleSegments' }),
      action({ file: FILES.glaze, symbol: 'scoreShelfSlot' }),
    ]);
    const report = checkPlanFeasibility(plan, makeContext(), { resolver: claimsNothing() });

    expect(report.feasible).toEqual([]);
    expect(report.rejected.map((refusal) => refusal.code)).toEqual(['no-adapter', 'no-adapter']);
  });

  it('throws INTERNAL for a plan carrying no action list, which is a caller defect', () => {
    const malformed = {
      ...planOf([]),
      instrumentationTargets: undefined,
    } as unknown as InstrumentationPlan;
    const error = captureThrow(() => checkPlanFeasibility(malformed, makeContext()));

    expect(error.code).toBe('INTERNAL');
    expect(error.hint).toContain('parseInstrumentationPlan');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Invariants — the only conditions this module throws for
 * ---------------------------------------------------------------------------------------------- */

describe('an unusable context', () => {
  it('throws INTERNAL when no logger was supplied', () => {
    const context = { ...makeContext(), logger: undefined } as unknown as InstrumentationContext;

    expect(captureThrow(() => checkFeasibility([], context)).code).toBe('INTERNAL');
  });

  it('throws INTERNAL when no code queries were supplied', () => {
    const context = { ...makeContext(), queries: undefined } as unknown as InstrumentationContext;
    const error = captureThrow(() => checkFeasibility([], context));

    expect(error.code).toBe('INTERNAL');
    expect(error.hint).toContain('createCodeQueries');
  });

  it('throws INTERNAL when no code graph was supplied', () => {
    const context = { ...makeContext(), graph: {} } as unknown as InstrumentationContext;

    expect(captureThrow(() => checkFeasibility([], context)).code).toBe('INTERNAL');
  });

  it('throws INTERNAL when the project root is missing', () => {
    const context = { ...makeContext(), projectRoot: '' };

    expect(captureThrow(() => checkFeasibility([], context)).code).toBe('INTERNAL');
  });

  it('throws INTERNAL when the actions argument is not a list', () => {
    const actions = undefined as unknown as readonly InstrumentationAction[];

    expect(captureThrow(() => checkFeasibility(actions, makeContext())).code).toBe('INTERNAL');
  });

  it('throws for nothing a project can legitimately be in', () => {
    const everyShape: readonly ActionInput[] = [
      { file: FILES.generators, symbol: 'walkRampSegments' },
      { file: FILES.controller, symbol: 'KilnController' },
      { file: 'src/server/absent-module.ts', symbol: 'schedule' },
      { file: '../escape.ts', symbol: 'escape' },
      { file: FILES.cones, symbol: 'zzzAbsentSymbol' },
      { file: FILES.planner, symbol: 'planCycleSegments' },
      { file: FILES.route, symbol: ROUTE_METHOD, type: 'server-span' },
      { file: FILES.route, symbol: 'DELETE', type: 'server-span' },
      { file: FILES.form, symbol: 'handleFiringSubmit' },
      { file: FILES.legacyBisque, symbol: 'resolveBisqueSoak' },
      { file: FILES.legacyArrows, symbol: 'gradeRackDensity' },
    ];

    expect(() =>
      checkFeasibility(
        everyShape.map((input) => action(input)),
        makeContext({ loaded: undefined }),
        { resolver: claimsEverything() },
      ),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Read-only
 * ---------------------------------------------------------------------------------------------- */

describe('the fixture project', () => {
  it('is byte-for-byte as it was before the suite ran', () => {
    expect(fixtureFootprint()).toEqual(footprintBefore);
  });
});
