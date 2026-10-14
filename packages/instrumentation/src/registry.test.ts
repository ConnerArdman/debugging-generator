/**
 * The suite for `./registry.ts` — the one place adapter identity is enumerated,
 * and the extension point: *adding an adapter means implementing
 * `InstrumentationAdapter` and registering it, with no orchestrator change.*
 *
 * Every other suite in this package satisfies `PlanAdapterResolver` with an
 * object literal, which is right for them and is also why the production
 * resolver needs a suite of its own: nothing else proves that the registry the
 * service actually builds routes each of the eight action types to the adapter
 * and mode that adapter declares, that the two database adapters are told apart
 * by the project rather than by registration luck, and that a malformed or
 * hostile adapter is refused or contained instead of taking normalisation down.
 *
 * ## What is held to evidence
 *
 * 1. **Identity.** `ADAPTER_IDS` is the frozen, ordered tuple of the six
 *    built-ins, spelled by the adapter modules themselves, and
 *    `createAdapterRegistry()` builds exactly those adapters in that order —
 *    fresh instances per registry, constructed only when a registry is built.
 * 2. **Resolution.** Each action type resolves to one adapter and mode, and
 *    that answer is the adapter's own claim declaration read back — never a
 *    second table. Without a context the answer is claims plus order; with one
 *    it is narrowed by each adapter's `canHandle`, which the four corpora below
 *    exercise against *real* code graphs.
 * 3. **Refusal.** Registration refuses, with an `Err` carrying
 *    `'INSTRUMENTATION_UNAVAILABLE'` and a `details.reason`, every adapter that
 *    could not be addressed or routed to; construction from a list throws a
 *    `DebuggenError` for the same inputs, because a registry silently missing an
 *    adapter is worse than no registry.
 * 4. **Containment.** An unreadable claim is logged and ignored, a conflicting
 *    second mode is logged and the first kept, and a capability probe that
 *    throws is treated as "not applicable here" — logged, never propagated.
 * 5. **Consumers.** `normalizePlan` and the feasibility gate take the registry
 *    as their `resolver` unchanged, the canonical authoring example plan
 *    normalises to an exact expected object through it, and a seventh adapter
 *    reaches normalisation through `registerAdapter` alone.
 *
 * ## How the contexts are built
 *
 * Context-narrowed resolution is only meaningful against a real `CodeGraph`,
 * so every context is indexed through the product's own cache-free path —
 * `openProject` → `buildIndex` → `CodeGraph.fromIndex` → `buildRouteMap` →
 * `createCodeQueries` → `summarizeProject` — exactly as the database adapters'
 * own suites do. `test/fixtures/project-a` is the one corpus carrying *both*
 * drivers and is read-only here (its footprint is re-asserted at the end); the
 * single-driver and database-free corpora are written into per-corpus `mkdtemp`
 * directories with deliberately meaningless identifiers and removed afterwards.
 * Nothing here needs a network, a database or a dev server.
 *
 * The fake adapters record every contract call they receive and reject it: the
 * registry's methods are questions, never instructions, so the suite asserts
 * after every case that no fake was ever asked to plan, install, remove or
 * report readiness.
 *
 * The canonical authoring example carries identifiers that also exist in the
 * demo application. `scripts/check-no-hardcoding.mjs` scans product source
 * excluding test suites, which is what makes them acceptable here; they appear
 * once, in {@link AUTHORING_EXAMPLE}.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import type { CodeQueries, LoadedProject, ProjectSummary, RouteMap } from '@debuggen/code-analysis';
import { DebuggenError, toPosix } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { InstrumentationAdapter, InstrumentationContext } from './adapter.js';
import {
  BROWSER_PERFORMANCE_ADAPTER_CLAIMS,
  BROWSER_PERFORMANCE_ADAPTER_ID,
} from './adapters/browser-performance.js';
import { FETCH_ADAPTER_CLAIMS, FETCH_ADAPTER_ID } from './adapters/fetch.js';
import { NEXTJS_ADAPTER_CLAIMS, NEXTJS_ADAPTER_ID } from './adapters/nextjs.js';
import { POSTGRES_ADAPTER_CLAIMS, POSTGRES_ADAPTER_ID } from './adapters/postgres.js';
import { PRISMA_ADAPTER_CLAIMS, PRISMA_ADAPTER_ID } from './adapters/prisma.js';
import { REACT_ADAPTER_CLAIMS, REACT_ADAPTER_ID } from './adapters/react.js';
import { checkFeasibility } from './feasibility.js';
import {
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_PLAN_VERSION,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  normalizePlan,
} from './schema/plan.js';
import type {
  AdapterActionResolution,
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
  InstrumentationPlan,
  PlanAdapterResolver,
} from './schema/plan.js';

import { ADAPTER_IDS, createAdapterRegistry, registerAdapter } from './registry.js';
import type {
  AdapterClaimDeclaration,
  AdapterClaimEntry,
  AdapterRegistry,
  ClaimingAdapter,
} from './registry.js';

/* -------------------------------------------------------------------------------------------------
 * Fixed values
 * ---------------------------------------------------------------------------------------------- */

/**
 * The six built-in ids, spelled out.
 *
 * Literal on purpose: an adapter id is stored on every plan, modification
 * record and readiness report, so it must be stable across versions, and a
 * suite that only compared the tuple with the constants it was built from could
 * not notice one of them moving.
 */
const BUILT_IN_IDS = ['react', 'browser-performance', 'fetch', 'nextjs', 'prisma', 'postgres'];

/**
 * What each action type resolves to when no context narrows the answer.
 *
 * `'db-query-tracking'` has two claimants; the object-relational mapper is
 * registered first and therefore answers when the project is not consulted.
 */
const EXPECTED_RESOLUTIONS: Readonly<Record<InstrumentationActionType, AdapterActionResolution>> = {
  'function-timing': { adapter: 'nextjs', mode: 'patch' },
  'server-span': { adapter: 'nextjs', mode: 'patch' },
  'react-render-tracking': { adapter: 'react', mode: 'runtime' },
  'state-tracking': { adapter: 'react', mode: 'runtime' },
  'interaction-tracking': { adapter: 'browser-performance', mode: 'runtime' },
  'perf-tracking': { adapter: 'browser-performance', mode: 'runtime' },
  'fetch-tracking': { adapter: 'fetch', mode: 'runtime' },
  'db-query-tracking': { adapter: 'prisma', mode: 'runtime' },
};

/** The claimants of each action type, by id, in registration order. */
const EXPECTED_CLAIMANTS: Readonly<Record<InstrumentationActionType, readonly string[]>> = {
  'function-timing': ['nextjs'],
  'server-span': ['nextjs'],
  'react-render-tracking': ['react'],
  'state-tracking': ['react'],
  'interaction-tracking': ['browser-performance'],
  'perf-tracking': ['browser-performance'],
  'fetch-tracking': ['fetch'],
  'db-query-tracking': ['prisma', 'postgres'],
};

/**
 * The canonical authoring example plan, verbatim: an objective, the capture
 * list, and one `function-timing` and one `server-span` target.
 *
 * Typed `unknown`: the authoring schema is what must accept it, not the
 * compiler. The one place in this suite a demo-overlapping identifier appears.
 */
const AUTHORING_EXAMPLE: unknown = {
  objective: 'Determine why clicking Checkout takes more than 2 seconds',
  capture: [
    'click event timing',
    'React renders',
    'fetch calls',
    'server request spans',
    'database query spans',
  ],
  instrumentationTargets: [
    { file: 'components/CheckoutButton.tsx', symbol: 'handleCheckout', type: 'function-timing' },
    { file: 'app/api/checkout/route.ts', symbol: 'POST', type: 'server-span' },
  ],
};

/** A session id of the shape `@debuggen/shared` mints. */
const SESSION_ID = 'ses_registrysuite001';

/** The plan revision every context stamps. */
const PLAN_VERSION = 1;

/** The longest adapter id the plan and readiness schemas store. */
const MAX_STORED_ADAPTER_ID_LENGTH = 64;

/**
 * A state root nothing may reach: no registry question touches the journal or
 * the backup store, and the throwing doubles below prove it.
 */
const STATE_ROOT = toPosix(join(tmpdir(), 'debuggen-registry-suite-state-never-written'));

/** The committed, read-only corpus carrying both database drivers. */
const FIXTURE_ROOT = toPosix(fileURLToPath(new URL('../test/fixtures/project-a', import.meta.url)));

/**
 * An action-type argument outside the closed vocabulary, as a JavaScript
 * caller or a stored row read back after a downgrade could supply it.
 *
 * @param value Any value.
 * @returns The same value, typed as the parameter it is passed to.
 */
function outsideVocabulary(value: unknown): InstrumentationActionType {
  return value as InstrumentationActionType;
}

/**
 * A sequential action-id factory, so a normalised plan can be asserted whole.
 *
 * @returns A factory minting `act_0000000000000001`, `act_0000000000000002`, …
 */
function sequentialActionIds(): () => string {
  let minted = 0;

  return () => {
    minted += 1;

    return `act_${String(minted).padStart(16, '0')}`;
  };
}

/* -------------------------------------------------------------------------------------------------
 * The recording logger
 * ---------------------------------------------------------------------------------------------- */

/** One captured log line. */
interface LogLine {
  /** The level it was written at. */
  readonly level: string;

  /** The message. */
  readonly message: string;

  /** The fields, bindings merged. */
  readonly fields: LogFields;
}

/**
 * A logger of `noopLogger`'s shape that captures every line at every level.
 *
 * @param lines Where captured lines go.
 * @param bindings Fields bound by a `child` call.
 * @returns The logger.
 */
function recordingLogger(lines: LogLine[], bindings: LogFields = {}): Logger {
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields: { ...bindings, ...fields } });
    };

  return {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: (nested: LogFields) => recordingLogger(lines, { ...bindings, ...nested }),
  };
}

/**
 * The lines captured at one level.
 *
 * @param lines Every captured line.
 * @param level The level to keep.
 * @returns `{ message, fields }` pairs, in order.
 */
function linesAt(
  lines: readonly LogLine[],
  level: string,
): { readonly message: string; readonly fields: LogFields }[] {
  return lines
    .filter((line) => line.level === level)
    .map((line) => ({ message: line.message, fields: line.fields }));
}

/* -------------------------------------------------------------------------------------------------
 * Fake adapters
 * ---------------------------------------------------------------------------------------------- */

/** Every contract call a fake received. The registry must never produce one. */
const contractCalls: string[] = [];

/** An adapter whose claim declaration may be anything a JavaScript author wrote. */
type FakeAdapter = InstrumentationAdapter & { readonly claims?: unknown };

/** What a case varies about a fake. */
interface FakeAdapterOptions {
  /** The `claims` member. Omitted, the fake declares none. */
  readonly claims?: unknown;

  /** The capability probe. Defaults to "yes, always". */
  readonly canHandle?: (context: InstrumentationContext) => boolean;
}

/**
 * A contract method that records the call and rejects: the registry answers
 * questions, so reaching one of these is a defect the `afterEach` reports.
 *
 * @param label The adapter, for the record.
 * @param method The contract method.
 * @returns The method.
 */
function refusing(label: string, method: string): () => Promise<never> {
  return () => {
    contractCalls.push(`${label}.${method}`);

    return Promise.reject(new Error(`the registry must never call ${method}`));
  };
}

/**
 * A fake adapter that satisfies the contract.
 *
 * @param id Its id.
 * @param options Its probe and claim declaration.
 * @returns The adapter.
 */
function fakeAdapter(id: string, options: FakeAdapterOptions = {}): FakeAdapter {
  const probe = options.canHandle ?? ((): boolean => true);

  return {
    id,
    ...(options.claims === undefined ? {} : { claims: options.claims }),
    canHandle: (context: InstrumentationContext): boolean => probe(context),
    createPlan: refusing(id, 'createPlan'),
    install: refusing(id, 'install'),
    remove: refusing(id, 'remove'),
    readiness: refusing(id, 'readiness'),
  };
}

/**
 * A fake's members as a plain record carrying any id at all.
 *
 * A record rather than a typed adapter so a case can drop or replace a member
 * the way a JavaScript author might, and cast the result at the boundary.
 *
 * @param id The id to carry — any value.
 * @param options The probe and the claim declaration.
 * @returns The members.
 */
function fakeMembers(id: unknown, options: FakeAdapterOptions = {}): Record<string, unknown> {
  return { ...fakeAdapter(String(id), options), id };
}

/**
 * Casts a hand-assembled value to the adapter contract, as the boundary a
 * JavaScript caller crosses without a compiler.
 *
 * @param value Anything.
 * @returns The value, typed as an adapter.
 */
function asAdapter(value: unknown): InstrumentationAdapter {
  return value as InstrumentationAdapter;
}

/** A claim list naming one type in one mode. */
function claimOf(type: InstrumentationActionType, mode: InstrumentationMode): AdapterClaimEntry[] {
  return [{ type, mode }];
}

/* -------------------------------------------------------------------------------------------------
 * Result helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The refusal carried by an `Err`, failing the case on an `Ok`.
 *
 * @param result A registration outcome.
 * @returns The error.
 */
function refusalOf(result: Result<void>): DebuggenError {
  if (result.ok) {
    throw new Error('expected the registration to be refused');
  }

  return result.error;
}

/**
 * The error `createAdapterRegistry` threw, failing the case when it did not.
 *
 * @param build The construction to attempt.
 * @returns The thrown error, asserted to be a `DebuggenError`.
 */
function constructionFailure(build: () => AdapterRegistry): DebuggenError {
  try {
    build();
  } catch (caught) {
    expect(caught).toBeInstanceOf(DebuggenError);

    return DebuggenError.from(caught);
  }

  throw new Error('expected createAdapterRegistry to throw');
}

/** The ids of a list of adapters, in order. */
function idsOf(adapters: readonly InstrumentationAdapter[]): string[] {
  return adapters.map((adapter) => adapter.id);
}

/**
 * Whether a claim declaration is the list form.
 *
 * @param declaration Either form.
 * @returns `true` for a list.
 */
function isClaimList(
  declaration: AdapterClaimDeclaration,
): declaration is readonly AdapterClaimEntry[] {
  return Array.isArray(declaration);
}

/**
 * Reads the mode an adapter's own declaration gives a type — the independent
 * oracle every resolution is compared with.
 *
 * @param adapter A registered adapter.
 * @param type The action type.
 * @returns The declared mode, or `undefined` when the adapter does not claim it.
 */
function declaredMode(
  adapter: InstrumentationAdapter,
  type: InstrumentationActionType,
): InstrumentationMode | undefined {
  const declaring: ClaimingAdapter = adapter;
  const declaration = declaring.claims;

  if (declaration === undefined) {
    return undefined;
  }

  return isClaimList(declaration)
    ? declaration.find((entry) => entry.type === type)?.mode
    : declaration[type];
}

/* -------------------------------------------------------------------------------------------------
 * The indexing harness and the corpora
 * ---------------------------------------------------------------------------------------------- */

/** One indexed project, with every handle a context is built from. */
interface IndexedProject {
  /** Absolute POSIX project root, as `openProject` normalised it. */
  readonly root: string;

  /** The loaded ts-morph project. */
  readonly loaded: LoadedProject;

  /** The code graph, from a cache-free index. */
  readonly graph: CodeGraph;

  /** The bounded query surface. */
  readonly queries: CodeQueries;

  /** The route map. */
  readonly routeMap: RouteMap;

  /** The project summary. */
  readonly projectSummary: ProjectSummary;
}

/**
 * Indexes one project through the product's own cache-free path, which reads
 * and writes nothing under `$DEBUGGEN_HOME`.
 *
 * @param root The project root.
 * @returns The indexed project.
 */
async function indexProjectTree(root: string): Promise<IndexedProject> {
  const opened = openProject({ projectRoot: root });

  if (!opened.ok) {
    throw new Error(`the suite could not open ${root}: ${opened.error.message}`);
  }

  const built = await buildIndex(opened.value);

  if (!built.ok) {
    throw new Error(`the suite could not index ${root}: ${built.error.message}`);
  }

  const graph = CodeGraph.fromIndex(built.value);
  const routeMap = buildRouteMap(opened.value);

  return {
    root: opened.value.projectRoot,
    loaded: opened.value,
    graph,
    routeMap,
    queries: createCodeQueries(graph, { loaded: opened.value, routes: routeMap.entries }),
    projectSummary: summarizeProject({ loaded: opened.value, graph, routeMap }),
  };
}

/** Every scratch directory this suite created, for the teardown. */
const scratchRoots: string[] = [];

/**
 * Writes a tiny source tree into its own `mkdtemp` directory and indexes it.
 *
 * @param label A short name for the directory.
 * @param files Project-relative POSIX paths mapped to contents.
 * @returns The indexed scratch project.
 */
async function scratchProject(
  label: string,
  files: Readonly<Record<string, string>>,
): Promise<IndexedProject> {
  const root = mkdtempSync(join(tmpdir(), `debuggen-registry-${label}-`));

  scratchRoots.push(root);

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: `scratch-${label}`, private: true, packageManager: 'pnpm@12.4.2' }, undefined, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'esnext',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
        },
        include: ['**/*.ts'],
        exclude: ['node_modules'],
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  );

  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }

  return indexProjectTree(toPosix(root));
}

/**
 * The mapper-only corpus. The handle is built in one module and queried from
 * another, and every model and operation name is one this product has never
 * seen, so a probe that recognised a name would find nothing.
 */
const MAPPER_ONLY_SOURCES: Readonly<Record<string, string>> = {
  'src/depot/handles.ts': [
    "import { PrismaClient } from '@prisma/client';",
    '',
    'export const marlinHandle = new PrismaClient();',
    '',
  ].join('\n'),
  'src/depot/vesper-store.ts': [
    "import { marlinHandle } from './handles';",
    '',
    'export async function gatherVesperTallies(pivotId: string): Promise<unknown[]> {',
    '  const rows = await marlinHandle.vesperTally.fetchMany({ where: { pivotId } });',
    '',
    '  return rows as unknown[];',
    '}',
    '',
  ].join('\n'),
};

/** The driver-only corpus: a pool built without a connection string, one statement. */
const DRIVER_ONLY_SOURCES: Readonly<Record<string, string>> = {
  'src/depot/handles.ts': [
    "import { Pool } from 'pg';",
    '',
    'export const fennelHandle = new Pool({ max: 2 });',
    '',
  ].join('\n'),
  'src/depot/sorrel-store.ts': [
    "import { fennelHandle } from './handles';",
    '',
    'export async function tallySorrelRows(pivotId: string): Promise<unknown[]> {',
    '  const result = await fennelHandle.query(',
    "    'select pivot_id, span_units from sorrel_rows where pivot_id = $1',",
    '    [pivotId],',
    '  );',
    '',
    '  return result.rows as unknown[];',
    '}',
    '',
  ].join('\n'),
};

/** The corpus with no database access at all. */
const DATABASE_FREE_SOURCES: Readonly<Record<string, string>> = {
  'src/depot/arithmetic.ts': [
    'export function blendQuanta(left: number, right: number): number {',
    '  return left + right;',
    '}',
    '',
  ].join('\n'),
};

/** The committed fixture, carrying both drivers. */
let bothDrivers: IndexedProject;

/** The mapper-only scratch corpus. */
let mapperOnly: IndexedProject;

/** The driver-only scratch corpus. */
let driverOnly: IndexedProject;

/** The corpus with no database access. */
let databaseFree: IndexedProject;

/** The fixture's files with size and modification time, before anything ran. */
let fixtureFootprintBefore: readonly string[];

/**
 * Every fixture file with its size and modification time, sorted.
 *
 * @returns One line per file.
 */
function fixtureFootprint(): readonly string[] {
  const lines: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);

        continue;
      }

      const stats = statSync(absolute);

      lines.push(`${toPosix(absolute)} ${String(stats.size)} ${String(stats.mtimeMs)}`);
    }
  };

  walk(FIXTURE_ROOT);

  return lines.sort();
}

/**
 * The distinct database drivers a project's graph records.
 *
 * @param project An indexed project.
 * @returns The drivers, sorted.
 */
function driversOf(project: IndexedProject): string[] {
  return [...new Set(project.graph.nodesByKind('db-call').map((call) => call.data.driver))].sort();
}

/**
 * Fails the whole suite, with the reason, when a corpus does not carry what the
 * disambiguation cases assume — otherwise they would pass vacuously.
 */
function assertCorpusInventory(): void {
  const inventory: readonly (readonly [string, IndexedProject, readonly string[]])[] = [
    ['project-a', bothDrivers, ['pg', 'prisma']],
    ['mapper-only', mapperOnly, ['prisma']],
    ['driver-only', driverOnly, ['pg']],
    ['database-free', databaseFree, []],
  ];

  for (const [label, project, expected] of inventory) {
    const found = driversOf(project);

    if (found.join(',') !== expected.join(',')) {
      throw new Error(
        `the ${label} corpus must record the drivers [${expected.join(',')}]; found [${found.join(',')}]`,
      );
    }
  }
}

beforeAll(async () => {
  fixtureFootprintBefore = fixtureFootprint();
  bothDrivers = await indexProjectTree(FIXTURE_ROOT);
  mapperOnly = await scratchProject('mapper-only', MAPPER_ONLY_SOURCES);
  driverOnly = await scratchProject('driver-only', DRIVER_ONLY_SOURCES);
  databaseFree = await scratchProject('database-free', DATABASE_FREE_SOURCES);

  assertCorpusInventory();
}, 180_000);

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  scratchRoots.length = 0;
});

afterEach(() => {
  // The registry answers questions and never acts: no fake may have been asked
  // to plan, install, remove or report readiness by anything under test.
  expect(contractCalls).toStrictEqual([]);
  contractCalls.length = 0;
});

/* -------------------------------------------------------------------------------------------------
 * The context
 * ---------------------------------------------------------------------------------------------- */

/** A journal that fails the case if the registry ever reaches it. */
const forbiddenJournal: InstrumentationContext['journal'] = {
  append: () => {
    throw new Error('the registry must never append a modification record');
  },
  updateStatus: () => {
    throw new Error('the registry must never update a modification record');
  },
  listBySession: () => {
    throw new Error('the registry must never list modification records');
  },
  listOpen: () => {
    throw new Error('the registry must never list open modification records');
  },
};

/** A backup store that fails the case if the registry ever reaches it. */
const forbiddenBackups: InstrumentationContext['backups'] = {
  sessionId: SESSION_ID,
  sessionDirectory: `${STATE_ROOT}/backups/${SESSION_ID}`,
  locate: () => {
    throw new Error('the registry must never locate a backup');
  },
  locateRecorded: () => {
    throw new Error('the registry must never locate a recorded backup');
  },
  put: () => {
    throw new Error('the registry must never write a backup');
  },
  read: () => {
    throw new Error('the registry must never read a backup');
  },
  readRecorded: () => {
    throw new Error('the registry must never read a recorded backup');
  },
  has: () => {
    throw new Error('the registry must never query a backup');
  },
  verify: () => {
    throw new Error('the registry must never verify a backup');
  },
  remove: () => {
    throw new Error('the registry must never remove a backup');
  },
  removeRecorded: () => {
    throw new Error('the registry must never remove a recorded backup');
  },
  removeSessionDirectory: () => {
    throw new Error('the registry must never remove a backup directory');
  },
};

/**
 * Builds an `InstrumentationContext` around an indexed project.
 *
 * @param project The indexed project.
 * @param logger Where the context logs. Defaults to a line sink nobody reads.
 * @returns The context.
 */
function contextFor(project: IndexedProject, logger?: Logger): InstrumentationContext {
  return {
    sessionId: SESSION_ID,
    projectRoot: project.root,
    planVersion: PLAN_VERSION,
    debuggenHome: STATE_ROOT,
    logger: logger ?? recordingLogger([]),
    graph: project.graph,
    queries: project.queries,
    routeMap: project.routeMap,
    projectSummary: project.projectSummary,
    loaded: project.loaded,
    journal: forbiddenJournal,
    backups: forbiddenBackups,
    readiness: {},
  };
}

/**
 * The oracle for context-narrowed resolution, computed from the adapters
 * themselves: the first registered adapter that claims the type and whose own
 * probe accepts the project.
 *
 * @param registry The registry under test.
 * @param type The action type.
 * @param context The session's context.
 * @returns The expected resolution, or `undefined`.
 */
function expectedNarrowedResolution(
  registry: AdapterRegistry,
  type: InstrumentationActionType,
  context: InstrumentationContext,
): AdapterActionResolution | undefined {
  for (const adapter of registry.adapters()) {
    const mode = declaredMode(adapter, type);

    if (mode !== undefined && adapter.canHandle(context)) {
      return { adapter: adapter.id, mode };
    }
  }

  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * ADAPTER_IDS
 * ---------------------------------------------------------------------------------------------- */

describe('ADAPTER_IDS', () => {
  it('names the six built-ins, in registration order', () => {
    expect([...ADAPTER_IDS]).toStrictEqual(BUILT_IN_IDS);
    expect(new Set(ADAPTER_IDS).size).toBe(ADAPTER_IDS.length);
  });

  it('is spelled by the adapter modules themselves, one constant per member', () => {
    expect([...ADAPTER_IDS]).toStrictEqual([
      REACT_ADAPTER_ID,
      BROWSER_PERFORMANCE_ADAPTER_ID,
      FETCH_ADAPTER_ID,
      NEXTJS_ADAPTER_ID,
      PRISMA_ADAPTER_ID,
      POSTGRES_ADAPTER_ID,
    ]);
  });

  it('is frozen, so no caller can reorder resolution through it', () => {
    expect(Object.isFrozen(ADAPTER_IDS)).toBe(true);
    expect(() => {
      (ADAPTER_IDS as unknown as string[]).push('intruder');
    }).toThrow(TypeError);
    expect(ADAPTER_IDS).toHaveLength(BUILT_IN_IDS.length);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Importing the module
 * ---------------------------------------------------------------------------------------------- */

describe('importing the module', () => {
  /** Every built-in factory call a fresh import made, with its argument count. */
  const factoryCalls: string[] = [];

  /**
   * Wraps a factory so each call is recorded.
   *
   * @param name The adapter the factory builds.
   * @param factory The real factory.
   * @returns A factory that records, then delegates.
   */
  function counting<Args extends unknown[], Built>(
    name: string,
    factory: (...args: Args) => Built,
  ): (...args: Args) => Built {
    return (...args: Args): Built => {
      factoryCalls.push(`${name}/${String(args.length)}`);

      return factory(...args);
    };
  }

  afterEach(() => {
    vi.doUnmock('./adapters/react.js');
    vi.doUnmock('./adapters/browser-performance.js');
    vi.doUnmock('./adapters/fetch.js');
    vi.doUnmock('./adapters/nextjs.js');
    vi.doUnmock('./adapters/prisma.js');
    vi.doUnmock('./adapters/postgres.js');
    vi.resetModules();
    factoryCalls.length = 0;
  });

  it('constructs no adapter, and a registry constructs each built-in once, with no arguments', async () => {
    vi.resetModules();
    vi.doMock('./adapters/react.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./adapters/react.js')>();

      return { ...actual, createReactAdapter: counting('react', actual.createReactAdapter) };
    });
    vi.doMock('./adapters/browser-performance.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./adapters/browser-performance.js')>();

      return {
        ...actual,
        createBrowserPerformanceAdapter: counting(
          'browser-performance',
          actual.createBrowserPerformanceAdapter,
        ),
      };
    });
    vi.doMock('./adapters/fetch.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./adapters/fetch.js')>();

      return { ...actual, createFetchAdapter: counting('fetch', actual.createFetchAdapter) };
    });
    vi.doMock('./adapters/nextjs.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./adapters/nextjs.js')>();

      return { ...actual, createNextJsAdapter: counting('nextjs', actual.createNextJsAdapter) };
    });
    vi.doMock('./adapters/prisma.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./adapters/prisma.js')>();

      return { ...actual, createPrismaAdapter: counting('prisma', actual.createPrismaAdapter) };
    });
    vi.doMock('./adapters/postgres.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./adapters/postgres.js')>();

      return {
        ...actual,
        createPostgresAdapter: counting('postgres', actual.createPostgresAdapter),
      };
    });

    const globalsBefore = Reflect.ownKeys(globalThis);
    const fresh = await import('./registry.js');

    expect(factoryCalls).toStrictEqual([]);
    expect(Reflect.ownKeys(globalThis)).toStrictEqual(globalsBefore);
    expect(Object.keys(fresh).sort()).toStrictEqual([
      'ADAPTER_IDS',
      'createAdapterRegistry',
      'registerAdapter',
    ]);
    expect(Object.isFrozen(fresh.ADAPTER_IDS)).toBe(true);

    fresh.createAdapterRegistry();

    expect(factoryCalls).toStrictEqual(BUILT_IN_IDS.map((id) => `${id}/0`));

    fresh.createAdapterRegistry();

    expect(factoryCalls).toStrictEqual([
      ...BUILT_IN_IDS.map((id) => `${id}/0`),
      ...BUILT_IN_IDS.map((id) => `${id}/0`),
    ]);
  });

  it('builds no built-in at all when a registry is given its own adapters', async () => {
    vi.resetModules();
    vi.doMock('./adapters/react.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./adapters/react.js')>();

      return { ...actual, createReactAdapter: counting('react', actual.createReactAdapter) };
    });

    const fresh = await import('./registry.js');
    const registry = fresh.createAdapterRegistry({ adapters: [] });

    expect(registry.adapters()).toStrictEqual([]);
    expect(factoryCalls).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The built-in registry
 * ---------------------------------------------------------------------------------------------- */

describe('createAdapterRegistry() — the six built-ins', () => {
  it('registers the six built-ins in ADAPTER_IDS order', () => {
    const registry = createAdapterRegistry();

    expect(idsOf(registry.adapters())).toStrictEqual([...ADAPTER_IDS]);
  });

  it('answers get(id) with the adapter registered under that id', () => {
    const registry = createAdapterRegistry();
    const adapters = registry.adapters();

    for (const [index, id] of ADAPTER_IDS.entries()) {
      const adapter = registry.get(id);

      expect(adapter?.id).toBe(id);
      expect(adapter).toBe(adapters[index]);
    }
  });

  it('answers get(id) with undefined for an id nothing is registered under', () => {
    const registry = createAdapterRegistry();

    for (const id of ['', 'React', ' react', 'express', '__proto__', 'constructor', 'toString']) {
      expect(registry.get(id)).toBeUndefined();
    }
  });

  it('builds fresh adapter instances for every registry', () => {
    const first = createAdapterRegistry().adapters();
    const second = createAdapterRegistry().adapters();

    expect(idsOf(first)).toStrictEqual(idsOf(second));

    for (const [index, adapter] of first.entries()) {
      expect(adapter).not.toBe(second[index]);
    }
  });

  it('hands out a fresh, frozen array from adapters() that cannot reorder the registry', () => {
    const registry = createAdapterRegistry();
    const first = registry.adapters();
    const second = registry.adapters();

    expect(first).not.toBe(second);
    expect(first).toStrictEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as InstrumentationAdapter[]).reverse();
    }).toThrow(TypeError);
    expect(idsOf(registry.adapters())).toStrictEqual([...ADAPTER_IDS]);
  });

  it('is itself frozen', () => {
    expect(Object.isFrozen(createAdapterRegistry())).toBe(true);
  });

  it('exposes each built-in’s exported claim declaration unchanged', () => {
    const registry = createAdapterRegistry();
    const expected: readonly (readonly [string, AdapterClaimDeclaration])[] = [
      [REACT_ADAPTER_ID, REACT_ADAPTER_CLAIMS],
      [BROWSER_PERFORMANCE_ADAPTER_ID, BROWSER_PERFORMANCE_ADAPTER_CLAIMS],
      [FETCH_ADAPTER_ID, FETCH_ADAPTER_CLAIMS],
      [NEXTJS_ADAPTER_ID, NEXTJS_ADAPTER_CLAIMS],
      [PRISMA_ADAPTER_ID, PRISMA_ADAPTER_CLAIMS],
      [POSTGRES_ADAPTER_ID, POSTGRES_ADAPTER_CLAIMS],
    ];

    for (const [id, declaration] of expected) {
      const adapter = registry.get(id);

      expect(adapter).toBeDefined();

      const declaring: ClaimingAdapter | undefined = adapter;

      expect(declaring?.claims).toBe(declaration);
    }
  });

  it('logs one debug line per built-in and one for the build, and warns about nothing', () => {
    const lines: LogLine[] = [];

    createAdapterRegistry({ logger: recordingLogger(lines) });

    expect(linesAt(lines, 'warn')).toStrictEqual([]);
    expect(lines.filter((line) => line.level !== 'debug')).toStrictEqual([]);
    expect(linesAt(lines, 'debug')).toStrictEqual([
      {
        message: 'registered an instrumentation adapter',
        fields: {
          adapter: 'react',
          position: 0,
          claimedTypes: ['react-render-tracking', 'state-tracking'],
        },
      },
      {
        message: 'registered an instrumentation adapter',
        fields: {
          adapter: 'browser-performance',
          position: 1,
          claimedTypes: ['interaction-tracking', 'perf-tracking'],
        },
      },
      {
        message: 'registered an instrumentation adapter',
        fields: { adapter: 'fetch', position: 2, claimedTypes: ['fetch-tracking'] },
      },
      {
        message: 'registered an instrumentation adapter',
        fields: {
          adapter: 'nextjs',
          position: 3,
          claimedTypes: ['server-span', 'function-timing'],
        },
      },
      {
        message: 'registered an instrumentation adapter',
        fields: { adapter: 'prisma', position: 4, claimedTypes: ['db-query-tracking'] },
      },
      {
        message: 'registered an instrumentation adapter',
        fields: { adapter: 'postgres', position: 5, claimedTypes: ['db-query-tracking'] },
      },
      { message: 'built an adapter registry', fields: { adapters: 6, builtIn: true } },
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Resolution without a context
 * ---------------------------------------------------------------------------------------------- */

describe('resolveActionType and claimants without a context', () => {
  it('covers every action type in the closed vocabulary', () => {
    expect(Object.keys(EXPECTED_RESOLUTIONS).sort()).toStrictEqual(
      [...INSTRUMENTATION_ACTION_TYPES].sort(),
    );
  });

  it.each(INSTRUMENTATION_ACTION_TYPES)(
    'resolves %s to exactly the adapter and mode the built-ins declare',
    (type) => {
      const registry = createAdapterRegistry();
      const resolution = registry.resolveActionType(type);

      expect(resolution).toStrictEqual(EXPECTED_RESOLUTIONS[type]);
      expect(Object.isFrozen(resolution)).toBe(true);

      const adapter = registry.get(EXPECTED_RESOLUTIONS[type].adapter);

      expect(adapter).toBeDefined();

      if (adapter !== undefined) {
        expect(resolution?.mode).toBe(declaredMode(adapter, type));
      }
    },
  );

  it.each(INSTRUMENTATION_ACTION_TYPES)(
    'lists the claimants of %s in registration order',
    (type) => {
      const registry = createAdapterRegistry();
      const claimants = registry.claimants(undefined, type);

      expect(idsOf(claimants)).toStrictEqual(EXPECTED_CLAIMANTS[type]);
      expect(Object.isFrozen(claimants)).toBe(true);

      for (const adapter of claimants) {
        expect(declaredMode(adapter, type)).toBeDefined();
      }

      // Every adapter left out of the list declares no claim on the type.
      for (const adapter of registry.adapters()) {
        if (!claimants.includes(adapter)) {
          expect(declaredMode(adapter, type)).toBeUndefined();
        }
      }
    },
  );

  it('gives the same answer every time it is asked', () => {
    const registry = createAdapterRegistry();

    for (const type of INSTRUMENTATION_ACTION_TYPES) {
      expect(registry.resolveActionType(type)).toStrictEqual(registry.resolveActionType(type));
    }
  });

  it('resolves a value outside the vocabulary to undefined, without throwing', () => {
    const registry = createAdapterRegistry();
    const outside: readonly unknown[] = [
      'teleport-tracking',
      '',
      'FETCH-TRACKING',
      ' fetch-tracking',
      '__proto__',
      'constructor',
      42,
      null,
      undefined,
      {},
      ['fetch-tracking'],
    ];

    for (const value of outside) {
      expect(registry.resolveActionType(outsideVocabulary(value))).toBeUndefined();
      expect(registry.claimants(undefined, outsideVocabulary(value))).toStrictEqual([]);
      expect(registry.claimants(contextFor(bothDrivers), outsideVocabulary(value))).toStrictEqual(
        [],
      );
      expect(
        registry.resolveActionType(outsideVocabulary(value), contextFor(bothDrivers)),
      ).toBeUndefined();
    }
  });

  it('answers an empty claimants list with a frozen empty array', () => {
    const registry = createAdapterRegistry({ adapters: [] });
    const none = registry.claimants(undefined, 'fetch-tracking');

    expect(none).toStrictEqual([]);
    expect(Object.isFrozen(none)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Resolution narrowed by a real context
 * ---------------------------------------------------------------------------------------------- */

describe('context-narrowed resolution against real code graphs', () => {
  it('resolves db-query-tracking to postgres for a project that only uses the driver', () => {
    const registry = createAdapterRegistry();
    const context = contextFor(driverOnly);

    expect(registry.resolveActionType('db-query-tracking', context)).toStrictEqual({
      adapter: 'postgres',
      mode: 'runtime',
    });
    expect(idsOf(registry.claimants(context, 'db-query-tracking'))).toStrictEqual(['postgres']);
  });

  it('resolves db-query-tracking to prisma for a project that only uses the mapper', () => {
    const registry = createAdapterRegistry();
    const context = contextFor(mapperOnly);

    expect(registry.resolveActionType('db-query-tracking', context)).toStrictEqual({
      adapter: 'prisma',
      mode: 'runtime',
    });
    expect(idsOf(registry.claimants(context, 'db-query-tracking'))).toStrictEqual(['prisma']);
  });

  it('asks the mapper first for a project that carries both drivers', () => {
    const registry = createAdapterRegistry();
    const context = contextFor(bothDrivers);

    expect(registry.resolveActionType('db-query-tracking', context)).toStrictEqual({
      adapter: 'prisma',
      mode: 'runtime',
    });
    expect(idsOf(registry.claimants(context, 'db-query-tracking'))).toStrictEqual([
      'prisma',
      'postgres',
    ]);
  });

  it('resolves db-query-tracking to nothing for a project with no database access', () => {
    const registry = createAdapterRegistry();
    const context = contextFor(databaseFree);

    expect(registry.resolveActionType('db-query-tracking', context)).toBeUndefined();
    expect(registry.claimants(context, 'db-query-tracking')).toStrictEqual([]);
  });

  it('narrows every action type exactly as the adapters’ own probes and claims dictate', () => {
    const registry = createAdapterRegistry();

    for (const project of [bothDrivers, mapperOnly, driverOnly, databaseFree]) {
      const context = contextFor(project);

      for (const type of INSTRUMENTATION_ACTION_TYPES) {
        expect(registry.resolveActionType(type, context)).toStrictEqual(
          expectedNarrowedResolution(registry, type, context),
        );
        expect(idsOf(registry.claimants(context, type))).toStrictEqual(
          idsOf(
            registry.claimants(undefined, type).filter((adapter) => adapter.canHandle(context)),
          ),
        );
      }
    }
  });

  it('lists in handling() exactly the adapters whose probe accepts the project, in order', () => {
    const registry = createAdapterRegistry();

    for (const project of [bothDrivers, mapperOnly, driverOnly, databaseFree]) {
      const context = contextFor(project);
      const handling = registry.handling(context);

      expect(idsOf(handling)).toStrictEqual(
        idsOf(registry.adapters().filter((adapter) => adapter.canHandle(context))),
      );
      expect(Object.isFrozen(handling)).toBe(true);
    }

    expect(idsOf(registry.handling(contextFor(bothDrivers)))).toEqual(
      expect.arrayContaining(['prisma', 'postgres']),
    );
    expect(idsOf(registry.handling(contextFor(driverOnly)))).not.toContain('prisma');
    expect(idsOf(registry.handling(contextFor(mapperOnly)))).not.toContain('postgres');
    expect(idsOf(registry.handling(contextFor(databaseFree)))).not.toContain('prisma');
    expect(idsOf(registry.handling(contextFor(databaseFree)))).not.toContain('postgres');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Registration refusals
 * ---------------------------------------------------------------------------------------------- */

describe('register and registerAdapter — refusals', () => {
  /** Ids no stored plan, record or log line could carry, and how each is described. */
  const INVALID_IDS: readonly (readonly [label: string, id: unknown, described: string])[] = [
    ['an empty string', '', ''],
    ['whitespace only', '   ', '   '],
    ['a number', 42, 'number'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['an object', { name: 'pivot' }, 'object'],
    ['a NUL character', 'pivot\u0000probe', 'pivot\u0000probe'],
    ['a line feed', 'pivot\nprobe', 'pivot\nprobe'],
    ['an ESC character', 'pivot\u001b[2Jprobe', 'pivot\u001b[2Jprobe'],
    ['DEL', 'pivot\u007fprobe', 'pivot\u007fprobe'],
    ['a C1 control character', 'pivot\u0085probe', 'pivot\u0085probe'],
    ['the last C1 control character', 'pivot\u009fprobe', 'pivot\u009fprobe'],
    [
      'more characters than a stored plan accepts',
      'p'.repeat(MAX_STORED_ADAPTER_ID_LENGTH + 1),
      `${'p'.repeat(64)}…`,
    ],
  ];

  it.each(INVALID_IDS)('refuses an id that is %s as invalid-id', (_label, id, described) => {
    const registry = createAdapterRegistry({ adapters: [] });
    const refusal = refusalOf(registry.register(asAdapter(fakeMembers(id))));

    expect(refusal).toBeInstanceOf(DebuggenError);
    expect(refusal.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(refusal.details).toStrictEqual({ reason: 'invalid-id', id: described });
    expect(refusal.hint).toEqual(expect.any(String));
    expect(registry.adapters()).toStrictEqual([]);
  });

  it('accepts ids at the edges of what is legal', () => {
    const registry = createAdapterRegistry({ adapters: [] });
    const legal = [
      'pivot probe',
      'pivot\u00a0probe',
      'p',
      'p'.repeat(MAX_STORED_ADAPTER_ID_LENGTH),
      'pivot-probe/2',
    ];

    for (const id of legal) {
      expect(registry.register(fakeAdapter(id))).toStrictEqual({ ok: true, value: undefined });
    }

    expect(idsOf(registry.adapters())).toStrictEqual(legal);
  });

  it('refuses a value that is not an object at all as invalid-id, never throwing', () => {
    const registry = createAdapterRegistry({ adapters: [] });

    for (const value of [null, undefined, 'fetch', 7, true]) {
      const refusal = refusalOf(registry.register(asAdapter(value)));

      expect(refusal.code).toBe('INSTRUMENTATION_UNAVAILABLE');
      expect(refusal.details).toStrictEqual({ reason: 'invalid-id', id: 'undefined' });
    }

    expect(registry.adapters()).toStrictEqual([]);
  });

  it.each(['canHandle', 'createPlan', 'install', 'remove', 'readiness'])(
    'refuses an adapter missing %s as incomplete-contract, naming it',
    (method) => {
      const registry = createAdapterRegistry({ adapters: [] });
      const members = Object.fromEntries(
        Object.entries(fakeMembers('pivot-probe')).filter(([name]) => name !== method),
      );
      const refusal = refusalOf(registry.register(asAdapter(members)));

      expect(refusal.code).toBe('INSTRUMENTATION_UNAVAILABLE');
      expect(refusal.details).toStrictEqual({
        reason: 'incomplete-contract',
        adapter: 'pivot-probe',
        missing: [method],
      });
      expect(refusal.message).toContain(method);
      expect(registry.get('pivot-probe')).toBeUndefined();
    },
  );

  it('lists every missing or non-callable contract member, in contract order', () => {
    const registry = createAdapterRegistry({ adapters: [] });
    const refusal = refusalOf(
      registry.register(
        asAdapter({ id: 'pivot-probe', canHandle: true, install: 'soon', claims: [] }),
      ),
    );

    expect(refusal.details).toStrictEqual({
      reason: 'incomplete-contract',
      adapter: 'pivot-probe',
      missing: ['canHandle', 'createPlan', 'install', 'remove', 'readiness'],
    });
  });

  it('refuses a second adapter under a taken id as duplicate-id, keeping the first', () => {
    const lines: LogLine[] = [];
    const registry = createAdapterRegistry({ logger: recordingLogger(lines) });
    const original = registry.get('prisma');
    const impostor = fakeAdapter('prisma', { claims: claimOf('fetch-tracking', 'patch') });
    const refusal = refusalOf(registry.register(impostor));

    expect(refusal.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(refusal.details).toStrictEqual({ reason: 'duplicate-id', adapter: 'prisma' });
    expect(refusal.hint).toEqual(expect.any(String));
    expect(registry.get('prisma')).toBe(original);
    expect(idsOf(registry.adapters())).toStrictEqual([...ADAPTER_IDS]);
    expect(registry.resolveActionType('fetch-tracking')).toStrictEqual({
      adapter: 'fetch',
      mode: 'runtime',
    });
    expect(
      linesAt(lines, 'debug').filter(
        (line) => line.message === 'registered an instrumentation adapter',
      ),
    ).toHaveLength(ADAPTER_IDS.length);
  });

  it('refuses the same adapter object registered twice', () => {
    const adapter = fakeAdapter('pivot-probe');
    const registry = createAdapterRegistry({ adapters: [adapter] });

    expect(refusalOf(registry.register(adapter)).details).toStrictEqual({
      reason: 'duplicate-id',
      adapter: 'pivot-probe',
    });
    expect(registry.adapters()).toStrictEqual([adapter]);
  });

  it('gives registerAdapter exactly register’s outcomes', () => {
    const registry = createAdapterRegistry({ adapters: [] });
    const adapter = fakeAdapter('pivot-probe', { claims: claimOf('perf-tracking', 'runtime') });

    expect(registerAdapter(registry, adapter)).toStrictEqual({ ok: true, value: undefined });
    expect(registry.get('pivot-probe')).toBe(adapter);
    expect(refusalOf(registerAdapter(registry, adapter)).details).toStrictEqual({
      reason: 'duplicate-id',
      adapter: 'pivot-probe',
    });
    expect(refusalOf(registerAdapter(registry, asAdapter(fakeMembers('')))).details).toStrictEqual({
      reason: 'invalid-id',
      id: '',
    });
    expect(registry.adapters()).toStrictEqual([adapter]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Construction from a list
 * ---------------------------------------------------------------------------------------------- */

describe('createAdapterRegistry({ adapters })', () => {
  it('registers exactly the adapters given, in order, instead of the built-ins', () => {
    const lines: LogLine[] = [];
    const first = fakeAdapter('pivot-one', { claims: claimOf('fetch-tracking', 'patch') });
    const second = fakeAdapter('pivot-two', { claims: claimOf('fetch-tracking', 'runtime') });
    const registry = createAdapterRegistry({
      adapters: [first, second],
      logger: recordingLogger(lines),
    });

    expect(registry.adapters()).toStrictEqual([first, second]);
    expect(registry.get('react')).toBeUndefined();
    expect(registry.resolveActionType('fetch-tracking')).toStrictEqual({
      adapter: 'pivot-one',
      mode: 'patch',
    });
    expect(registry.claimants(undefined, 'fetch-tracking')).toStrictEqual([first, second]);
    expect(linesAt(lines, 'debug').at(-1)).toStrictEqual({
      message: 'built an adapter registry',
      fields: { adapters: 2, builtIn: false },
    });
  });

  it('builds an empty registry from an empty list, which resolves nothing', () => {
    const registry = createAdapterRegistry({ adapters: [] });
    const context = contextFor(bothDrivers);

    expect(registry.adapters()).toStrictEqual([]);
    expect(registry.handling(context)).toStrictEqual([]);

    for (const type of INSTRUMENTATION_ACTION_TYPES) {
      expect(registry.resolveActionType(type)).toBeUndefined();
      expect(registry.resolveActionType(type, context)).toBeUndefined();
      expect(registry.claimants(undefined, type)).toStrictEqual([]);
    }
  });

  it('throws a DebuggenError for two entries sharing an id', () => {
    const adapter = fakeAdapter('pivot-probe');
    const failure = constructionFailure(() =>
      createAdapterRegistry({ adapters: [adapter, adapter] }),
    );

    expect(failure.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(failure.details).toStrictEqual({ supplied: 2, registered: 1 });
    expect(failure.hint).toEqual(expect.any(String));
    expect(failure.cause).toBeInstanceOf(DebuggenError);
    expect(DebuggenError.from(failure.cause).details).toStrictEqual({
      reason: 'duplicate-id',
      adapter: 'pivot-probe',
    });
  });

  it('throws a DebuggenError for an entry that breaks the contract', () => {
    const malformed: readonly (readonly [InstrumentationAdapter, string])[] = [
      [asAdapter(fakeMembers('   ')), 'invalid-id'],
      [asAdapter({ id: 'pivot-probe' }), 'incomplete-contract'],
      [asAdapter(null), 'invalid-id'],
    ];

    for (const [entry, reason] of malformed) {
      const failure = constructionFailure(() =>
        createAdapterRegistry({ adapters: [fakeAdapter('pivot-first'), entry] }),
      );

      expect(failure.code).toBe('INSTRUMENTATION_UNAVAILABLE');
      expect(failure.details).toStrictEqual({ supplied: 2, registered: 1 });
      expect(DebuggenError.from(failure.cause).details).toMatchObject({ reason });
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Claim declarations
 * ---------------------------------------------------------------------------------------------- */

describe('claim declarations', () => {
  it('reads the list form, ignoring members beyond type and mode', () => {
    const registry = createAdapterRegistry({
      adapters: [
        fakeAdapter('pivot-probe', {
          claims: [
            { type: 'perf-tracking', mode: 'patch', signal: 'longTask', weight: 3 },
            { type: 'state-tracking', mode: 'runtime' },
          ],
        }),
      ],
    });

    expect(registry.resolveActionType('perf-tracking')).toStrictEqual({
      adapter: 'pivot-probe',
      mode: 'patch',
    });
    expect(registry.resolveActionType('state-tracking')).toStrictEqual({
      adapter: 'pivot-probe',
      mode: 'runtime',
    });
    expect(registry.resolveActionType('fetch-tracking')).toBeUndefined();
  });

  it('reads the table form', () => {
    const registry = createAdapterRegistry({
      adapters: [
        fakeAdapter('pivot-probe', {
          claims: { 'server-span': 'runtime', 'db-query-tracking': 'patch' },
        }),
      ],
    });

    expect(registry.resolveActionType('server-span')).toStrictEqual({
      adapter: 'pivot-probe',
      mode: 'runtime',
    });
    expect(registry.resolveActionType('db-query-tracking')).toStrictEqual({
      adapter: 'pivot-probe',
      mode: 'patch',
    });
    expect(registry.resolveActionType('function-timing')).toBeUndefined();
  });

  it('logs and ignores every unreadable entry of a list, keeping the readable ones', () => {
    const lines: LogLine[] = [];
    const longType = 't'.repeat(80);
    const registry = createAdapterRegistry({
      logger: recordingLogger(lines),
      adapters: [
        fakeAdapter('pivot-probe', {
          claims: [
            { type: 'teleport-tracking', mode: 'runtime' },
            { type: 'fetch-tracking', mode: 'eventually' },
            { type: 42, mode: null },
            null,
            'perf-tracking',
            { type: longType, mode: 'runtime' },
            { type: 'state-tracking', mode: 'runtime' },
          ],
        }),
      ],
    });

    expect(linesAt(lines, 'warn')).toStrictEqual([
      {
        message: 'ignored an unreadable adapter claim',
        fields: { adapter: 'pivot-probe', type: 'teleport-tracking', mode: 'runtime' },
      },
      {
        message: 'ignored an unreadable adapter claim',
        fields: { adapter: 'pivot-probe', type: 'fetch-tracking', mode: 'eventually' },
      },
      {
        message: 'ignored an unreadable adapter claim',
        fields: { adapter: 'pivot-probe', type: 'number', mode: 'null' },
      },
      {
        message: 'ignored an adapter claim that is not an object',
        fields: { adapter: 'pivot-probe', entry: 'null' },
      },
      {
        message: 'ignored an adapter claim that is not an object',
        fields: { adapter: 'pivot-probe', entry: 'perf-tracking' },
      },
      {
        message: 'ignored an unreadable adapter claim',
        fields: { adapter: 'pivot-probe', type: `${'t'.repeat(64)}…`, mode: 'runtime' },
      },
    ]);

    for (const type of INSTRUMENTATION_ACTION_TYPES) {
      expect(registry.resolveActionType(type)).toStrictEqual(
        type === 'state-tracking' ? { adapter: 'pivot-probe', mode: 'runtime' } : undefined,
      );
    }
  });

  it('logs and ignores every unreadable entry of a table', () => {
    const lines: LogLine[] = [];
    const registry = createAdapterRegistry({
      logger: recordingLogger(lines),
      adapters: [
        fakeAdapter('pivot-probe', {
          claims: { 'perf-tracking': 'runtime', 'warp-tracking': 'patch', 'fetch-tracking': 7 },
        }),
      ],
    });

    expect(linesAt(lines, 'warn')).toStrictEqual([
      {
        message: 'ignored an unreadable adapter claim',
        fields: { adapter: 'pivot-probe', type: 'warp-tracking', mode: 'patch' },
      },
      {
        message: 'ignored an unreadable adapter claim',
        fields: { adapter: 'pivot-probe', type: 'fetch-tracking', mode: 'number' },
      },
    ]);
    expect(idsOf(registry.claimants(undefined, 'perf-tracking'))).toStrictEqual(['pivot-probe']);
    expect(registry.claimants(undefined, 'fetch-tracking')).toStrictEqual([]);
  });

  it.each([
    ['a string', 'fetch-tracking', 'fetch-tracking'],
    ['a number', 12, 'number'],
    ['a boolean', true, 'boolean'],
    ['a function', (): string => 'fetch-tracking', 'function'],
  ])(
    'registers an adapter whose declaration is %s with no claims, and warns',
    (_label, claims, described) => {
      const lines: LogLine[] = [];
      const registry = createAdapterRegistry({
        logger: recordingLogger(lines),
        adapters: [fakeAdapter('pivot-probe', { claims })],
      });

      expect(linesAt(lines, 'warn')).toStrictEqual([
        {
          message: 'ignored an adapter claim declaration that is neither a list nor a table',
          fields: { adapter: 'pivot-probe', declaration: described },
        },
      ]);
      expect(registry.get('pivot-probe')).toBeDefined();

      for (const type of INSTRUMENTATION_ACTION_TYPES) {
        expect(registry.resolveActionType(type)).toBeUndefined();
      }
    },
  );

  it('keeps the first mode of a type declared twice, warning once about the conflict', () => {
    const lines: LogLine[] = [];
    const registry = createAdapterRegistry({
      logger: recordingLogger(lines),
      adapters: [
        fakeAdapter('pivot-probe', {
          claims: [
            { type: 'fetch-tracking', mode: 'runtime' },
            { type: 'fetch-tracking', mode: 'patch' },
            { type: 'fetch-tracking', mode: 'runtime' },
          ],
        }),
      ],
    });

    expect(linesAt(lines, 'warn')).toStrictEqual([
      {
        message: 'kept the first mode an adapter declared for an action type',
        fields: {
          adapter: 'pivot-probe',
          type: 'fetch-tracking',
          kept: 'runtime',
          ignored: 'patch',
        },
      },
    ]);
    expect(registry.resolveActionType('fetch-tracking')).toStrictEqual({
      adapter: 'pivot-probe',
      mode: 'runtime',
    });
  });

  it.each([
    ['no claims member', {}],
    ['a null declaration', { claims: null }],
    ['an empty list', { claims: [] }],
    ['an empty table', { claims: {} }],
  ])(
    'registers an adapter with %s: handled, resolving nothing, silently',
    (_label, options: FakeAdapterOptions) => {
      const lines: LogLine[] = [];
      const adapter = fakeAdapter('pivot-probe', options);
      const registry = createAdapterRegistry({
        logger: recordingLogger(lines),
        adapters: [adapter],
      });
      const context = contextFor(databaseFree);

      expect(linesAt(lines, 'warn')).toStrictEqual([]);
      expect(linesAt(lines, 'debug')[0]).toStrictEqual({
        message: 'registered an instrumentation adapter',
        fields: { adapter: 'pivot-probe', position: 0, claimedTypes: [] },
      });
      expect(registry.handling(context)).toStrictEqual([adapter]);

      for (const type of INSTRUMENTATION_ACTION_TYPES) {
        expect(registry.resolveActionType(type)).toBeUndefined();
        expect(registry.resolveActionType(type, context)).toBeUndefined();
        expect(registry.claimants(context, type)).toStrictEqual([]);
      }
    },
  );

  it('reads a declaration once, at registration: later mutation changes nothing', () => {
    const table: Partial<Record<InstrumentationActionType, InstrumentationMode>> = {
      'fetch-tracking': 'runtime',
    };
    const registry = createAdapterRegistry({
      adapters: [fakeAdapter('pivot-probe', { claims: table })],
    });

    table['fetch-tracking'] = 'patch';
    table['perf-tracking'] = 'runtime';

    expect(registry.resolveActionType('fetch-tracking')).toStrictEqual({
      adapter: 'pivot-probe',
      mode: 'runtime',
    });
    expect(registry.resolveActionType('perf-tracking')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Capability probes that misbehave
 * ---------------------------------------------------------------------------------------------- */

describe('capability probes that misbehave', () => {
  it('treats a throwing probe as inapplicable, logs it, and moves on to the next claimant', () => {
    const lines: LogLine[] = [];
    const seen: InstrumentationContext[] = [];
    const thrower = fakeAdapter('pivot-thrower', {
      claims: claimOf('fetch-tracking', 'patch'),
      canHandle: (context) => {
        seen.push(context);

        throw new Error('probe gave way');
      },
    });
    const fallback = fakeAdapter('pivot-fallback', {
      claims: claimOf('fetch-tracking', 'runtime'),
    });
    const registry = createAdapterRegistry({
      adapters: [thrower, fallback],
      logger: recordingLogger(lines),
    });
    const context = contextFor(databaseFree);

    expect(registry.resolveActionType('fetch-tracking', context)).toStrictEqual({
      adapter: 'pivot-fallback',
      mode: 'runtime',
    });
    expect(registry.claimants(context, 'fetch-tracking')).toStrictEqual([fallback]);
    expect(registry.handling(context)).toStrictEqual([fallback]);

    const warning = {
      message: 'an adapter capability probe threw; treating it as inapplicable here',
      fields: { adapter: 'pivot-thrower', reason: 'probe gave way' },
    };

    expect(linesAt(lines, 'warn')).toStrictEqual([warning, warning, warning]);
    expect(seen).toStrictEqual([context, context, context]);
    expect(seen.every((received) => received === context)).toBe(true);
  });

  it('contains a probe that throws a value that is not an Error', () => {
    const lines: LogLine[] = [];
    const registry = createAdapterRegistry({
      logger: recordingLogger(lines),
      adapters: [
        fakeAdapter('pivot-thrower', {
          claims: claimOf('perf-tracking', 'runtime'),
          canHandle: () => {
            // A JavaScript adapter can throw anything; the registry must cope.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'probe gave way as a string';
          },
        }),
      ],
    });

    expect(registry.resolveActionType('perf-tracking', contextFor(databaseFree))).toBeUndefined();
    expect(linesAt(lines, 'warn')).toStrictEqual([
      {
        message: 'an adapter capability probe threw; treating it as inapplicable here',
        fields: { adapter: 'pivot-thrower', reason: 'probe gave way as a string' },
      },
    ]);
  });

  it('never consults a probe when no context was given', () => {
    let probes = 0;
    const registry = createAdapterRegistry({
      adapters: [
        fakeAdapter('pivot-thrower', {
          claims: claimOf('perf-tracking', 'runtime'),
          canHandle: () => {
            probes += 1;

            throw new Error('must not be asked');
          },
        }),
      ],
    });

    expect(registry.resolveActionType('perf-tracking')).toStrictEqual({
      adapter: 'pivot-thrower',
      mode: 'runtime',
    });
    expect(idsOf(registry.claimants(undefined, 'perf-tracking'))).toStrictEqual(['pivot-thrower']);
    expect(probes).toBe(0);
  });

  it('accepts only a literal true from a probe', () => {
    const truthy = 1 as unknown as boolean;
    const registry = createAdapterRegistry({
      adapters: [
        fakeAdapter('pivot-truthy', {
          claims: claimOf('perf-tracking', 'runtime'),
          canHandle: () => truthy,
        }),
      ],
    });
    const context = contextFor(databaseFree);

    expect(registry.resolveActionType('perf-tracking', context)).toBeUndefined();
    expect(registry.handling(context)).toStrictEqual([]);
  });

  it('contains a built-in probe handed a context it cannot read', () => {
    const lines: LogLine[] = [];
    const registry = createAdapterRegistry({ logger: recordingLogger(lines) });
    const unusable = {} as unknown as InstrumentationContext;

    expect(registry.handling(unusable)).toStrictEqual([]);
    expect(registry.resolveActionType('db-query-tracking', unusable)).toBeUndefined();
    expect(registry.claimants(unusable, 'db-query-tracking')).toStrictEqual([]);

    // Whatever each probe made of the context, every failure was logged as a
    // contained probe failure and none escaped.
    for (const line of linesAt(lines, 'warn')) {
      expect(line.message).toBe(
        'an adapter capability probe threw; treating it as inapplicable here',
      );
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The extension point
 * ---------------------------------------------------------------------------------------------- */

describe('the extension point: a seventh adapter', () => {
  /** A database adapter for a project shape neither built-in recognises. */
  function seventhAdapter(): FakeAdapter {
    return fakeAdapter('quarry-ledger', {
      claims: claimOf('db-query-tracking', 'runtime'),
      canHandle: (context) => context.graph.nodesByKind('db-call').length === 0,
    });
  }

  it('joins the end of the registry through registerAdapter alone', () => {
    const registry = createAdapterRegistry();
    const seventh = seventhAdapter();

    expect(registerAdapter(registry, seventh)).toStrictEqual({ ok: true, value: undefined });
    expect(idsOf(registry.adapters())).toStrictEqual([...ADAPTER_IDS, 'quarry-ledger']);
    expect(registry.get('quarry-ledger')).toBe(seventh);
    expect(idsOf(registry.claimants(undefined, 'db-query-tracking'))).toStrictEqual([
      'prisma',
      'postgres',
      'quarry-ledger',
    ]);
  });

  it('wins db-query-tracking for a project neither built-in database adapter handles', () => {
    const registry = createAdapterRegistry();

    registerAdapter(registry, seventhAdapter());

    expect(registry.resolveActionType('db-query-tracking', contextFor(databaseFree))).toStrictEqual(
      { adapter: 'quarry-ledger', mode: 'runtime' },
    );
    expect(registry.resolveActionType('db-query-tracking', contextFor(driverOnly))).toStrictEqual({
      adapter: 'postgres',
      mode: 'runtime',
    });
    expect(registry.resolveActionType('db-query-tracking', contextFor(bothDrivers))).toStrictEqual({
      adapter: 'prisma',
      mode: 'runtime',
    });
    expect(registry.resolveActionType('db-query-tracking')).toStrictEqual({
      adapter: 'prisma',
      mode: 'runtime',
    });
    expect(idsOf(registry.handling(contextFor(databaseFree))).at(-1)).toBe('quarry-ledger');

    for (const type of INSTRUMENTATION_ACTION_TYPES) {
      expect(registry.resolveActionType(type)).toStrictEqual(EXPECTED_RESOLUTIONS[type]);
    }
  });

  it('leaves every other registry untouched', () => {
    const extended = createAdapterRegistry();

    registerAdapter(extended, seventhAdapter());

    expect(idsOf(createAdapterRegistry().adapters())).toStrictEqual([...ADAPTER_IDS]);
  });

  it('cannot take a built-in’s id', () => {
    const registry = createAdapterRegistry();

    expect(
      refusalOf(registerAdapter(registry, fakeAdapter('postgres', { claims: [] }))).details,
    ).toStrictEqual({ reason: 'duplicate-id', adapter: 'postgres' });
  });

  it('reaches normalisation with no other change', () => {
    const registry = createAdapterRegistry({ adapters: [] });

    registerAdapter(
      registry,
      fakeAdapter('quarry-timer', {
        claims: [
          { type: 'function-timing', mode: 'patch' },
          { type: 'server-span', mode: 'patch' },
        ],
      }),
    );

    const normalized = normalizePlan(AUTHORING_EXAMPLE, {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      resolver: registry,
      newActionId: sequentialActionIds(),
    });

    expect(normalized.ok).toBe(true);

    if (normalized.ok) {
      expect(
        normalized.value.instrumentationTargets.map((action) => [action.adapter, action.mode]),
      ).toStrictEqual([
        ['quarry-timer', 'patch'],
        ['quarry-timer', 'patch'],
      ]);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Consumers
 * ---------------------------------------------------------------------------------------------- */

describe('consumers: normalizePlan and the feasibility gate take the registry as resolver', () => {
  it('normalises the authoring example to the exact expected plan through the built-ins', () => {
    const resolver: PlanAdapterResolver = createAdapterRegistry();
    const normalized = normalizePlan(AUTHORING_EXAMPLE, {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      resolver,
      newActionId: sequentialActionIds(),
    });
    const objective = 'Determine why clicking Checkout takes more than 2 seconds';
    const expected: InstrumentationPlan = {
      version: INSTRUMENTATION_PLAN_VERSION,
      planVersion: PLAN_VERSION,
      sessionId: SESSION_ID,
      objective,
      hypotheses: [],
      capture: [
        'click event timing',
        'React renders',
        'fetch calls',
        'server request spans',
        'database query spans',
      ],
      instrumentationTargets: [
        {
          id: 'act_0000000000000001',
          file: 'components/CheckoutButton.tsx',
          symbol: 'handleCheckout',
          type: 'function-timing',
          adapter: 'nextjs',
          mode: 'patch',
          rationale: objective,
        },
        {
          id: 'act_0000000000000002',
          file: 'app/api/checkout/route.ts',
          symbol: 'POST',
          type: 'server-span',
          adapter: 'nextjs',
          mode: 'patch',
          rationale: objective,
        },
      ],
    };

    expect(normalized).toStrictEqual({ ok: true, value: expected });
  });

  it('routes a plan naming all eight action types exactly as the registry resolves them', () => {
    const registry = createAdapterRegistry();
    const normalized = normalizePlan(
      {
        objective: 'Measure where the pivot panel spends its time',
        capture: ['every signal'],
        instrumentationTargets: INSTRUMENTATION_ACTION_TYPES.map((type, index) => ({
          file: `src/pivot/probe-${String(index)}.ts`,
          symbol: `pivotProbe${String(index)}`,
          type,
        })),
      },
      {
        sessionId: SESSION_ID,
        planVersion: PLAN_VERSION,
        resolver: registry,
        newActionId: sequentialActionIds(),
      },
    );

    expect(normalized.ok).toBe(true);

    if (normalized.ok) {
      expect(
        normalized.value.instrumentationTargets.map((action) => ({
          adapter: action.adapter,
          mode: action.mode,
        })),
      ).toStrictEqual(INSTRUMENTATION_ACTION_TYPES.map((type) => EXPECTED_RESOLUTIONS[type]));
    }
  });

  it('rejects the plan with INSTRUMENTATION_UNAVAILABLE when the registry is empty', () => {
    const normalized = normalizePlan(AUTHORING_EXAMPLE, {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      resolver: createAdapterRegistry({ adapters: [] }),
      newActionId: sequentialActionIds(),
    });

    expect(normalized.ok).toBe(false);

    if (!normalized.ok) {
      expect(normalized.error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
      expect(normalized.error.details).toMatchObject({
        targetIndex: 0,
        actionType: 'function-timing',
      });
    }
  });

  it('never registers an adapter whose id a normalised plan could not store', () => {
    const registry = createAdapterRegistry({ adapters: [] });
    const longest = 'q'.repeat(MAX_STORED_ADAPTER_ID_LENGTH);
    const tooLong = 'q'.repeat(MAX_STORED_ADAPTER_ID_LENGTH + 1);
    const timing = [
      { type: 'function-timing', mode: 'patch' },
      { type: 'server-span', mode: 'patch' },
    ];

    expect(
      refusalOf(registry.register(fakeAdapter(tooLong, { claims: timing }))).details,
    ).toMatchObject({ reason: 'invalid-id' });
    expect(registry.register(fakeAdapter(longest, { claims: timing }))).toStrictEqual({
      ok: true,
      value: undefined,
    });

    const normalized = normalizePlan(AUTHORING_EXAMPLE, {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      resolver: registry,
      newActionId: sequentialActionIds(),
    });

    expect(normalized.ok).toBe(true);

    if (normalized.ok) {
      expect(normalized.value.instrumentationTargets.map((action) => action.adapter)).toStrictEqual(
        [longest, longest],
      );
    }
  });

  it('lets the feasibility gate report an unclaimed action, and pass a claimed one', () => {
    const context = contextFor(databaseFree);
    const action: InstrumentationAction = {
      id: 'act_0000000000000001',
      file: TARGETLESS_FILE,
      symbol: TARGETLESS_SYMBOL,
      type: 'fetch-tracking',
      adapter: 'fetch',
      mode: 'runtime',
      rationale: 'Observe every request the page issues.',
    };

    const withBuiltIns = checkFeasibility([action], context, {
      resolver: createAdapterRegistry(),
    });

    expect(withBuiltIns.feasible).toStrictEqual([action]);
    expect(withBuiltIns.rejected).toStrictEqual([]);

    const withNothing = checkFeasibility([action], context, {
      resolver: createAdapterRegistry({ adapters: [] }),
    });

    expect(withNothing.feasible).toStrictEqual([]);
    expect(withNothing.rejected.map((rejection) => rejection.code)).toStrictEqual(['no-adapter']);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The committed fixture
 * ---------------------------------------------------------------------------------------------- */

describe('the committed fixture', () => {
  it('was read and never written', () => {
    expect(fixtureFootprint()).toStrictEqual(fixtureFootprintBefore);
  });
});
