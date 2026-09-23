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
 * - **Adapter claim** — check 1, and that it is skipped when no resolver is
 *   supplied.
 * - **Runtime mode** — checks 2 to 5 are skipped for an action that writes
 *   nothing.
 * - **Containment** — check 2, for a traversal, an absolute path and a
 *   backslash path.
 * - **The index** — check 3, for a file the graph has never seen.
 * - **The symbol** — check 4, including the qualified spelling the patcher
 *   accepts and the bounded near-miss hint.
 * - **The declaration's shape** — check 5: every supported shape in the
 *   fixture accepted, both generators refused with their own codes, and every
 *   unwrappable form refused as `unsupported-declaration`.
 * - **No syntax tree** — check 5's honest answer when no project is loaded.
 * - **Duplicates** — check 6, for an identical action and for two patches on
 *   one declaration, and its absence for two runtime signals on one component.
 * - **Determinism and bounds** — ordering, repeatability, one log line, and the
 *   truncation every reported value goes through.
 * - **Invariants** — the only conditions this module throws for.
 */

import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { beforeAll, describe, expect, it } from 'vitest';

import type { InstrumentationContext } from './adapter.js';
import {
  FEASIBILITY_REJECTION_CODES,
  checkFeasibility,
  checkPlanFeasibility,
  isFeasibilityRejectionCode,
} from './feasibility.js';
import type { InfeasibleAction } from './feasibility.js';
import { createBackupStore } from './patch/backup-store.js';
import type { ModificationJournal, ModificationRecord } from './schema/modification.js';
import {
  INSTRUMENTATION_PLAN_VERSION,
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
  /** Plain JSX: a helper function beside a component. */
  legacyJsx: 'src/legacy/kiln-badge.jsx',
} as const;

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
      'path-outside-project',
      'file-not-indexed',
      'symbol-not-found',
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
});

/* -------------------------------------------------------------------------------------------------
 * Runtime mode — the project-side checks do not apply
 * ---------------------------------------------------------------------------------------------- */

describe('a runtime-mode action', () => {
  it('is accepted although its file and symbol are absent from the project', () => {
    const built = action({
      file: 'src/components/NoSuchWidget.tsx',
      symbol: 'NoSuchWidget',
      type: 'react-render-tracking',
      mode: 'runtime',
    });
    const report = checkFeasibility([built], makeContext(), {
      resolver: claimsEverything('runtime'),
    });

    expect(report.rejected).toEqual([]);
    expect(report.feasible).toEqual([built]);
  });

  it('is accepted with no syntax tree loaded, because it needs none', () => {
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
});

/* -------------------------------------------------------------------------------------------------
 * Check 2 — containment
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
 * Check 3 — the file has to be indexed
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
 * Check 4 — the file has to declare the symbol
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

    expect(refusal.code).toBe('unsupported-declaration');
    expectReadableRefusal(refusal);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check 5 — the declaration's shape
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
      what: 'a helper function in a JSX module',
      input: { file: FILES.legacyJsx, symbol: 'formatKilnBadgeLabel' },
    },
  ];

  for (const { what, input } of supported) {
    it(`accepts ${what}`, () => {
      expectFeasible(input);
    });
  }
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
 * Check 5 — and the honest answer when there is no syntax tree
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
 * Check 6 — duplicates
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
