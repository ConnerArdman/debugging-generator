/**
 * The suite for `./prisma.ts` — the adapter that arms the object-relational
 * mapper's query spans.
 *
 * Four claims make that adapter correct rather than merely present, and this
 * file exists to hold each of them to evidence:
 *
 * 1. **Detection is a graph read.** Whether a project queries through the
 *    mapper is answered from `db-call` nodes' `DbCallNodeData.driver` and from
 *    `ProjectSummary.databaseAccess.style` — never from a model, a table, a
 *    delegate method or a client variable's spelling (AAP §0.5.4). The
 *    committed corpus splits the two drivers across two modules on purpose and
 *    the scratch corpora below are written with deliberately meaningless
 *    identifiers, so an adapter that recognised a *name* would be visible here
 *    as a wrong answer rather than as a passing test.
 * 2. **A missing preload is reported, actionably.** With mapper call sites in
 *    the graph and no dev-server preload for the project, the install reports
 *    one `UnavailableSignal` whose hint names **which project to relaunch** and
 *    reads as one copy-pasteable instruction (AAP §0.5.5) — and it *resolves*,
 *    because degradation is data and never an exception.
 * 3. **An unused driver is silent.** A project that reaches its database only
 *    through the driver library gets no proposal, no readiness row and,
 *    decisively, no "Prisma unavailable" report. A spurious gap there would push
 *    the session's readiness gate into reporting something the developer has no
 *    reason to close.
 * 4. **Nothing is written, and nothing leaks.** `applied` is always empty, the
 *    backup-store double below throws if it is ever reached and the journal
 *    double records calls that never come (AAP §0.5.1); and no statement, no
 *    statement shape and nothing credential-shaped reaches a rationale, a
 *    reason, a hint, a hook name or a log field (AAP §0.5.2).
 *
 * ## Why the committed corpus, and why scratch trees beside it
 *
 * The adapter's input contract is a real `CodeGraph`, so the corpus is indexed
 * through the product's own path — `openProject` → `buildIndex` →
 * `CodeGraph.fromIndex` → `buildRouteMap` → `createCodeQueries` →
 * `summarizeProject` — rather than assembled by hand. `openProject` +
 * `buildIndex` is deliberately the **cache-free** build: `indexProject` would
 * consult and populate `$DEBUGGEN_HOME/index`, which a unit suite must not
 * touch.
 *
 * `test/fixtures/project-a` is the one corpus that carries **both** drivers —
 * three mapper call sites in one server module, two driver call sites in
 * another, and both handles declared in a third — which is exactly the shape
 * that makes driver *filtering*, rather than module filtering, the only correct
 * discriminator. It is read-only here: the last group snapshots every fixture
 * file's size and modification time before anything is indexed and re-asserts
 * it at the end.
 *
 * The single-driver and many-owner cases cannot come from that corpus, so they
 * are written into per-corpus `mkdtemp` directories and indexed the same way.
 * Their identifiers are arbitrary and meaningless on purpose: they double as
 * the behavioural half of AAP §0.5.4's no-hardcoding rule, since an adapter
 * carrying any name at all would fail against names it has never seen.
 *
 * Nothing here needs a network, a database, a dev server or the driver
 * packages: handles are discovered structurally from their construction sites,
 * and every readiness fact is injected on the context.
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
  CodeNodeOf,
  CodeQueries,
  DbDriver,
  LoadedProject,
  ProjectSummary,
  RouteMap,
} from '@debuggen/code-analysis';
import { noopLogger, ok, toPosix } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  InstallResult,
  InstrumentationContext,
  ObservedReadinessInputs,
  ObservedServerAgent,
  UnavailableSignal,
} from '../adapter.js';
import type { ModificationJournal, ModificationRecord } from '../schema/modification.js';
import {
  ACTION_ID_PATTERN,
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  instrumentationActionSchema,
} from '../schema/plan.js';
import type { InstrumentationAction } from '../schema/plan.js';
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
  PRISMA_ADAPTER_CLAIMS,
  PRISMA_ADAPTER_ID,
  PRISMA_ADAPTER_LIMITS,
  PRISMA_RELAUNCH_DEFAULTS,
  PRISMA_SERVER_SIGNAL_KEYS,
  createPrismaAdapter,
} from './prisma.js';

/* -------------------------------------------------------------------------------------------------
 * Paths and fixed values
 * ---------------------------------------------------------------------------------------------- */

/**
 * The committed, read-only corpus, resolved from this module's own URL.
 *
 * Two levels up from `src/adapters/`, and deliberately not from
 * `process.cwd()`: this package's Vitest project runs from the repository root,
 * where a relative path would resolve to something else entirely.
 */
const FIXTURE_ROOT = toPosix(
  fileURLToPath(new URL('../../test/fixtures/project-a', import.meta.url)),
);

/** The adapter's own source, for the static import-boundary guard. */
const ADAPTER_SOURCE_PATH = fileURLToPath(new URL('./prisma.ts', import.meta.url));

/** The session every context in this suite belongs to. */
const SESSION_ID = 'ses_prismaadapter001';

/** The plan revision every context stamps. */
const PLAN_VERSION = 4;

/**
 * A state root no test may reach.
 *
 * This adapter writes nothing, so the directory is never created: it exists as
 * a value the context requires, and the throwing backup store below is what
 * proves nothing went looking for it.
 */
const STATE_ROOT = toPosix(join(tmpdir(), 'debuggen-prisma-suite-state-never-written'));

/** A fixed moment, so every clock-dependent assertion is exact. */
const NOW = 1_700_000_000_000;

/** A clock frozen at {@link NOW}. */
const frozenClock = (): number => NOW;

/**
 * The editor command every default hint names, spelled as the VS Code command
 * palette shows `debuggen.launchDevServer`: its contributed category and title
 * (`apps/vscode-extension/package.json`). Restated rather than imported because
 * a hint quoting any other spelling cannot be typed into the palette.
 */
const LAUNCH_DEV_SERVER_PALETTE_LABEL = 'Debug Generator: Launch Dev Server';

/**
 * Asserts that a hint carries no hand-typed preload command.
 *
 * The published specifier cannot be resolved from a target project, which
 * declares no `@debuggen/*` dependency, and a bare `NODE_OPTIONS` line sets no
 * ingest credential: a default hint quoting either is a command that fails, or
 * runs and reports nothing (QA INT-F05).
 *
 * @param hint The hint.
 */
function expectNoHandTypedCommand(hint: string): void {
  expect(hint).not.toContain(PRISMA_RELAUNCH_DEFAULTS.preloadSpecifier);
  expect(hint).not.toContain('NODE_OPTIONS');
  expect(hint).not.toContain('--import');
}

/* -------------------------------------------------------------------------------------------------
 * The indexing harness
 * ---------------------------------------------------------------------------------------------- */

/** One indexed project, with every handle an `InstrumentationContext` needs. */
interface IndexedProject {
  /** Absolute POSIX project root, as `openProject` normalised it. */
  readonly root: string;

  /** The loaded ts-morph project. */
  readonly loaded: LoadedProject;

  /** The code graph built from a cache-free index. */
  readonly graph: CodeGraph;

  /** The bounded query surface, built over the graph and the route map. */
  readonly queries: CodeQueries;

  /** The route map, empty for a corpus with no router directory. */
  readonly routeMap: RouteMap;

  /** The project summary, whose `databaseAccess.style` corroborates detection. */
  readonly projectSummary: ProjectSummary;
}

/**
 * Indexes one project through the product's own path.
 *
 * The cache-free build (`openProject` + `buildIndex`) rather than
 * `indexProject`, which would read and write `$DEBUGGEN_HOME/index`.
 *
 * @param root The project root to index.
 * @returns Every handle a context is built from.
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
 * Each corpus gets a directory of its own, and the committed fixture is never
 * written to. A `package.json` is included because `ProjectSummary` reads the
 * package manager from it, which is what the relaunch hint of AAP §0.5.5 is
 * composed from, and a `tsconfig.json` because a target project's configuration
 * is what `openProject` takes its compiler options from.
 *
 * @param label A short, human-readable name for the temporary directory.
 * @param files Project-relative POSIX paths mapped to file contents.
 * @param manifestFields Extra manifest fields to declare. Defaults to a
 * `packageManager` pin; pass `{}` for the project whose manager cannot be
 * determined. A record rather than an optional string, because a `string |
 * undefined` parameter with a default cannot express "declare none": passing
 * `undefined` selects the default instead.
 * @returns The indexed scratch project.
 */
async function scratchProject(
  label: string,
  files: Readonly<Record<string, string>>,
  manifestFields: Readonly<Record<string, unknown>> = { packageManager: 'pnpm@12.4.2' },
): Promise<IndexedProject> {
  const root = mkdtempSync(join(tmpdir(), `debuggen-prisma-${label}-`));

  scratchRoots.push(root);

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: `scratch-${label}`, private: true, ...manifestFields }, undefined, 2)}\n`,
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
          allowJs: true,
        },
        include: ['**/*.ts', '**/*.tsx'],
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

/* -------------------------------------------------------------------------------------------------
 * The corpora
 *
 * The committed fixture carries both drivers and is the only corpus that can
 * prove driver *filtering*. The three scratch corpora carry one driver, no
 * driver, and many call sites respectively — none of which that fixture can
 * express — and every identifier in them is arbitrary.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The mapper-only corpus: two owners, meaningless names throughout.
 *
 * The handle is constructed in a module of its own and imported by the module
 * that queries, which is how a project actually declares one — and the reason a
 * call site's own text identifies no driver. The model and the two operations
 * are words this product has never seen, so an adapter that matched a name
 * would find nothing here.
 */
const MAPPER_ONLY_SOURCES: Readonly<Record<string, string>> = {
  'src/back/handles.ts': [
    "import { PrismaClient } from '@prisma/client';",
    '',
    'export const zephyrHandle = new PrismaClient();',
    '',
  ].join('\n'),
  'src/back/tally-store.ts': [
    "import { zephyrHandle } from './handles';",
    '',
    'export async function gatherQuollTallies(markerId: string): Promise<unknown[]> {',
    '  const rows = await zephyrHandle.quollTally.fetchMany({ where: { markerId } });',
    '',
    '  return rows as unknown[];',
    '}',
    '',
    'export async function stampQuollTally(markerId: string): Promise<unknown> {',
    '  return zephyrHandle.quollTally.inscribe({ data: { markerId } });',
    '}',
    '',
  ].join('\n'),
};

/**
 * The driver-only corpus: the decisive negative case for the dual claim.
 *
 * One hand-written statement, carrying a `$1` placeholder so the privacy
 * assertions have a shape to look for, and no generated client anywhere. The
 * pool is constructed without a connection string: nothing credential-shaped
 * belongs in a committed file (AAP §0.3.4).
 */
const DRIVER_ONLY_SOURCES: Readonly<Record<string, string>> = {
  'src/back/handles.ts': [
    "import { Pool } from 'pg';",
    '',
    'export const brookHandle = new Pool({ max: 4 });',
    '',
  ].join('\n'),
  'src/back/ledger-store.ts': [
    "import { brookHandle } from './handles';",
    '',
    'export async function tallyLedgerRows(markerId: string): Promise<unknown[]> {',
    '  const result = await brookHandle.query(',
    "    'select marker_id, total_minutes from ledger_rows where marker_id = $1',",
    '    [markerId],',
    '  );',
    '',
    '  return result.rows as unknown[];',
    '}',
    '',
  ].join('\n'),
};

/** The corpus with no database access at all. */
const DATABASE_FREE_SOURCES: Readonly<Record<string, string>> = {
  'src/back/arithmetic.ts': [
    'export function combineTallies(left: number, right: number): number {',
    '  return left + right;',
    '}',
    '',
  ].join('\n'),
};

/** How many query owners the many-owner corpus declares. */
const MANY_OWNER_COUNT = 9;

/**
 * A corpus with far more query owners than one proposal may contain.
 *
 * The owners are declared in ascending order in one module, so the cap applies
 * to a deterministically ordered candidate list rather than to whichever
 * owners a scan happened to reach first.
 */
const MANY_OWNER_SOURCES: Readonly<Record<string, string>> = {
  'src/back/handles.ts': MAPPER_ONLY_SOURCES['src/back/handles.ts'] ?? '',
  'src/back/bulk-store.ts': [
    "import { zephyrHandle } from './handles';",
    '',
    ...Array.from({ length: MANY_OWNER_COUNT }, (_unused, index) =>
      [
        `export async function gatherBatch${String(index)}(markerId: string): Promise<unknown> {`,
        '  return zephyrHandle.quollTally.fetchMany({ where: { markerId } });',
        '}',
        '',
      ].join('\n'),
    ),
  ].join('\n'),
};

/** The module that constructs the handle in the reachability and tooling corpora. */
const COBALT_HANDLE_SOURCE = [
  "import { PrismaClient } from '@prisma/client';",
  '',
  'export const cobaltHandle = new PrismaClient();',
  '',
].join('\n');

/** A seed module that queries through the shared handle. */
const COBALT_SEED_SOURCE = [
  "import { cobaltHandle } from '../src/back/handles';",
  '',
  'export async function plantWicketRows(laneId: string): Promise<unknown> {',
  '  return cobaltHandle.wicketRow.inscribe({ data: { laneId } });',
  '}',
  '',
].join('\n');

/** A top-level operational script that queries through the shared handle. */
const COBALT_SCRIPT_SOURCE = [
  "import { cobaltHandle } from '../src/back/handles';",
  '',
  'export async function rebuildLaneRows(laneId: string): Promise<unknown[]> {',
  '  const rows = await cobaltHandle.wicketRow.fetchMany({ where: { laneId } });',
  '',
  '  return rows as unknown[];',
  '}',
  '',
].join('\n');

/**
 * One querying module: a single exported function that reads one model.
 *
 * @param symbol The function's name.
 * @param model The model it reads.
 * @returns The module source.
 */
function cobaltLedgerSource(symbol: string, model: string): string {
  return [
    "import { cobaltHandle } from './handles';",
    '',
    `export async function ${symbol}(laneId: string): Promise<unknown[]> {`,
    `  const rows = await cobaltHandle.${model}.fetchMany({ where: { laneId } });`,
    '',
    '  return rows as unknown[];',
    '}',
    '',
  ].join('\n');
}

/**
 * The corpus that separates *reachable* query sites from merely *present* ones,
 * and application modules from tooling modules.
 *
 * - `app/api/wicket/route.ts` answers a request through a desk function that
 *   calls one querying function directly and a second through a relay, so the
 *   two sit several hops below the route and neither has a caller in the route
 *   module itself — a one-hop caller check reaches neither.
 * - The farther query site's module (`abacus-ledger`) sorts *before* the nearer
 *   one's (`wicket-ledger`), and an unrelated querying module nothing calls
 *   (`aardvark-ledger`) sorts before both, so a ranking by path order alone
 *   would choose wrongly.
 * - A seed module and a top-level script query too, and both sort before every
 *   `src/` module. They run in processes of their own, never in the dev server,
 *   and must never be proposed.
 */
const REACHABILITY_SOURCES: Readonly<Record<string, string>> = {
  'src/back/handles.ts': COBALT_HANDLE_SOURCE,
  'app/api/wicket/route.ts': [
    "import { gatherWicketDigest } from '../../../src/back/wicket-desk';",
    '',
    'export async function GET(): Promise<unknown> {',
    "  return gatherWicketDigest('lane-1');",
    '}',
    '',
  ].join('\n'),
  'src/back/wicket-desk.ts': [
    "import { relayWicketTally } from './wicket-relay';",
    "import { tallyWicketRows } from './wicket-ledger';",
    '',
    'export async function gatherWicketDigest(laneId: string): Promise<unknown[]> {',
    '  const rows = await tallyWicketRows(laneId);',
    '  const relayed = await relayWicketTally(laneId);',
    '',
    '  return [...rows, relayed];',
    '}',
    '',
  ].join('\n'),
  'src/back/wicket-relay.ts': [
    "import { tallyAbacusRows } from './abacus-ledger';",
    '',
    'export async function relayWicketTally(laneId: string): Promise<unknown[]> {',
    '  return tallyAbacusRows(laneId);',
    '}',
    '',
  ].join('\n'),
  'src/back/wicket-ledger.ts': cobaltLedgerSource('tallyWicketRows', 'wicketRow'),
  'src/back/abacus-ledger.ts': cobaltLedgerSource('tallyAbacusRows', 'abacusRow'),
  'src/back/aardvark-ledger.ts': cobaltLedgerSource('countAardvarkRows', 'aardvarkRow'),
  'prisma/seed.ts': COBALT_SEED_SOURCE,
  'scripts/rebuild-lanes.ts': COBALT_SCRIPT_SOURCE,
};

/** A corpus whose only mapper query sites are in a seed module and a script. */
const TOOLING_ONLY_SOURCES: Readonly<Record<string, string>> = {
  'src/back/handles.ts': COBALT_HANDLE_SOURCE,
  'prisma/seed.ts': COBALT_SEED_SOURCE,
  'scripts/rebuild-lanes.ts': COBALT_SCRIPT_SOURCE,
};

/** The committed fixture, indexed once. */
let fixture: IndexedProject;

/** The mapper-only scratch corpus. */
let mapperOnly: IndexedProject;

/** The driver-only scratch corpus. */
let driverOnly: IndexedProject;

/** The corpus with no database access. */
let databaseFree: IndexedProject;

/** The corpus with more query owners than one proposal may hold. */
let manyOwners: IndexedProject;

/** The corpus with reachable, unreachable and tooling-module query sites. */
let reachability: IndexedProject;

/** The corpus whose only query sites are in tooling modules. */
let toolingOnly: IndexedProject;

/** The fixture's file list with each file's size and modification time. */
let fixtureFootprintBefore: readonly string[];

beforeAll(async () => {
  fixtureFootprintBefore = fixtureFootprint();
  fixture = await indexProjectTree(FIXTURE_ROOT);
  mapperOnly = await scratchProject('mapper-only', MAPPER_ONLY_SOURCES);
  driverOnly = await scratchProject('driver-only', DRIVER_ONLY_SOURCES);
  databaseFree = await scratchProject('database-free', DATABASE_FREE_SOURCES);
  manyOwners = await scratchProject('many-owners', MANY_OWNER_SOURCES);
  reachability = await scratchProject('reachability', REACHABILITY_SOURCES);
  toolingOnly = await scratchProject('tooling-only', TOOLING_ONLY_SOURCES);

  assertCorpusInventory();
}, 180_000);

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  scratchRoots.length = 0;
});

afterEach(() => {
  // Only one case stubs the environment, and it does so to prove that nothing
  // is read from it. Restoring here rather than there keeps a failure inside
  // that case from leaking a stub into the rest of the run.
  vi.unstubAllEnvs();
  journalCalls.length = 0;
});

/**
 * Fails the whole suite, immediately and with the reason, when a corpus does
 * not carry what every case below assumes.
 *
 * These are *preconditions*, not assertions about the adapter: if the fixture
 * stopped splitting the drivers across two modules, or if the indexer stopped
 * classifying one of them, every driver-isolation case here would pass
 * vacuously. Throwing from `beforeAll` is what turns that into one unambiguous
 * failure instead of a suite that is quietly testing nothing.
 */
function assertCorpusInventory(): void {
  const mapperCalls = driverCallSites(fixture, 'prisma');
  const driverCalls = driverCallSites(fixture, 'pg');

  if (mapperCalls.length < 2 || driverCalls.length < 2) {
    throw new Error(
      `the fixture must carry call sites for BOTH drivers; found ${String(mapperCalls.length)} for the mapper and ${String(driverCalls.length)} for the driver`,
    );
  }

  const mapperFiles = new Set(mapperCalls.map((call) => call.file));
  const driverFiles = new Set(driverCalls.map((call) => call.file));
  const shared = [...mapperFiles].filter((file) => driverFiles.has(file));

  if (mapperFiles.size !== 1 || driverFiles.size !== 1 || shared.length > 0) {
    throw new Error(
      `the fixture must keep each driver's call sites in one module of its own; mapper=${[...mapperFiles].join(',')} driver=${[...driverFiles].join(',')}`,
    );
  }

  if (!PRISMA_ACCESS_STYLES_WITH_MAPPER.includes(fixture.projectSummary.databaseAccess.style)) {
    throw new Error(
      `the fixture's project summary must report a database access style that includes the mapper; found '${fixture.projectSummary.databaseAccess.style}'`,
    );
  }

  for (const [label, expected] of [
    ['mapper-only', ['prisma']],
    ['driver-only', ['pg']],
  ] as const) {
    const project = label === 'mapper-only' ? mapperOnly : driverOnly;
    const drivers = [
      ...new Set(project.graph.nodesByKind('db-call').map((call) => call.data.driver)),
    ];

    if (drivers.length !== 1 || drivers[0] !== expected[0]) {
      throw new Error(
        `the ${label} corpus must carry exactly one driver (${String(expected[0])}); found [${drivers.join(',')}]`,
      );
    }
  }

  if (databaseFree.graph.nodesByKind('db-call').length > 0) {
    throw new Error('the database-free corpus must carry no db-call node at all');
  }

  if (driverCallSites(manyOwners, 'prisma').length <= PRISMA_ADAPTER_LIMITS.maxTargets) {
    throw new Error(
      `the many-owner corpus must hold more mapper call sites than one proposal may contain (${String(PRISMA_ADAPTER_LIMITS.maxTargets)})`,
    );
  }

  for (const owner of mapperOwners(fixture)) {
    if (!fixture.queries.hasSymbol(owner.file, owner.symbol)) {
      throw new Error(
        `the fixture's query owner ${owner.file}#${owner.symbol} must be an addressable symbol`,
      );
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Reading the corpora — every expectation below is computed from the graph
 * ---------------------------------------------------------------------------------------------- */

/**
 * The database-access styles that include the mapper.
 *
 * The two members of `DatabaseAccessStyle` a project using the mapper can
 * report: its own, and `'both'` for the ordinary project that uses a generated
 * client for most work and hand-written statements where it needs them.
 */
const PRISMA_ACCESS_STYLES_WITH_MAPPER: readonly string[] = ['prisma', 'both'];

/**
 * Every `db-call` node of one driver, in the graph's canonical order.
 *
 * `DbCallNodeData.driver` is the classification the indexer's own pass
 * recorded, and it is the only thing that answers "which driver is this?" —
 * which is precisely why the adapter is asserted against it rather than against
 * a module path or a call's text.
 *
 * @param project The indexed project.
 * @param driver The driver to select.
 * @returns The matching call sites.
 */
function driverCallSites(
  project: IndexedProject,
  driver: DbDriver,
): readonly CodeNodeOf<'db-call'>[] {
  return project.graph.nodesByKind('db-call').filter((call) => call.data.driver === driver);
}

/** A `(file, symbol)` pair an action may address. */
interface OwnerRef {
  /** Project-relative POSIX file. */
  readonly file: string;

  /** The declared symbol name. */
  readonly symbol: string;
}

/**
 * The declarations that own one driver's call sites, resolved through the graph.
 *
 * The `queries` edge is the relationship the indexer recorded for exactly this
 * purpose, so the owner is read from its origin — the enclosing server
 * function, or the enclosing declaration where the extractor's cascade found no
 * service function. The call site's own `symbol` field is the fallback for a
 * graph whose edge was dropped, which is the same order the adapter resolves in
 * and is stated here independently so the expectation is a graph fact rather
 * than a copy of the implementation.
 *
 * @param project The indexed project.
 * @param driver The driver whose owners are wanted.
 * @returns One entry per distinct owner, in call-site order.
 */
function ownersForDriver(project: IndexedProject, driver: DbDriver): readonly OwnerRef[] {
  const owners = new Map<string, OwnerRef>();

  for (const call of driverCallSites(project, driver)) {
    const edgeOwner = project.graph
      .incoming(call.id, 'queries')
      .map((edge) => project.graph.nodeById(edge.from))
      .find(
        (node) =>
          node !== undefined &&
          (node.kind === 'server-function' || node.kind === 'symbol' || node.kind === 'component'),
      );

    const resolved: OwnerRef | undefined =
      edgeOwner === undefined
        ? call.symbol === undefined
          ? undefined
          : { file: call.file, symbol: call.symbol }
        : { file: edgeOwner.file, symbol: edgeOwner.name };

    if (resolved !== undefined) {
      owners.set(`${resolved.file}\u0000${resolved.symbol}`, resolved);
    }
  }

  return [...owners.values()];
}

/**
 * The declarations that query through the mapper.
 *
 * @param project The indexed project.
 * @returns The mapper's query owners.
 */
function mapperOwners(project: IndexedProject): readonly OwnerRef[] {
  return ownersForDriver(project, 'prisma');
}

/**
 * The fixture's files with each file's size and modification time, sorted.
 *
 * Metadata only, never contents: a write anywhere under the fixture changes a
 * size, a modification time, or the file list itself, so comparing two of these
 * is the suite half of AAP §0.5.1's promise that this adapter touches nothing.
 *
 * @returns One line per file, sorted.
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

/* -------------------------------------------------------------------------------------------------
 * The ports: a journal that records, a backup store that must never be reached
 * ---------------------------------------------------------------------------------------------- */

/** One call made against the recording journal. */
interface JournalCall {
  /** Which method was called. */
  readonly method: string;

  /** What it was called about. */
  readonly subject: string;
}

/** Every journal call one case made; cleared after each. */
const journalCalls: JournalCall[] = [];

/**
 * An in-memory journal that records rather than refuses.
 *
 * Recording instead of throwing is deliberate: a throwing journal proves only
 * that the adapter did not crash into it, while a recorder lets a case assert
 * the *stronger* statement — that `append` was never called, because there was
 * no modification to record (AAP §0.5.1).
 */
const recordingJournal: ModificationJournal = {
  append: (record: ModificationRecord) => {
    journalCalls.push({ method: 'append', subject: record.id });

    return Promise.resolve(ok(record));
  },
  updateStatus: (id: string, status: string) => {
    journalCalls.push({ method: 'updateStatus', subject: `${id}:${status}` });

    throw new Error('the mapper adapter must never update a modification record');
  },
  listBySession: (sessionId: string) => {
    journalCalls.push({ method: 'listBySession', subject: sessionId });

    return Promise.resolve(ok<ModificationRecord[]>([]));
  },
  listOpen: () => {
    journalCalls.push({ method: 'listOpen', subject: '' });

    return Promise.resolve(ok<ModificationRecord[]>([]));
  },
};

/**
 * A backup store that fails the test if it is ever reached.
 *
 * Nothing is written, so nothing needs a backup. A call here would mean bytes
 * were about to be replaced in a developer's project by an adapter whose whole
 * contract is that it arms a runtime signal.
 *
 * Typed as the context's own port rather than through a second import of the
 * store's module: the shape a context requires is the shape this double has to
 * satisfy, and reading it from `../adapter.ts` keeps that true if the port ever
 * moves.
 */
const forbiddenBackups: InstrumentationContext['backups'] = {
  sessionId: SESSION_ID,
  sessionDirectory: `${STATE_ROOT}/backups/${SESSION_ID}`,
  locate: () => {
    throw new Error('the mapper adapter must never locate a backup');
  },
  locateRecorded: () => {
    throw new Error('the mapper adapter must never locate a recorded backup');
  },
  put: () => {
    throw new Error('the mapper adapter must never write a backup');
  },
  read: () => {
    throw new Error('the mapper adapter must never read a backup');
  },
  readRecorded: () => {
    throw new Error('the mapper adapter must never read a recorded backup');
  },
  has: () => {
    throw new Error('the mapper adapter must never query a backup');
  },
  verify: () => {
    throw new Error('the mapper adapter must never verify a backup');
  },
  remove: () => {
    throw new Error('the mapper adapter must never remove a backup');
  },
  removeRecorded: () => {
    throw new Error('the mapper adapter must never remove a recorded backup');
  },
  removeSessionDirectory: () => {
    throw new Error('the mapper adapter must never remove a backup directory');
  },
};

/** One captured log line. */
interface LogLine {
  /** The level it was written at. */
  readonly level: string;

  /** The message. */
  readonly message: string;

  /** The bound and per-call fields, merged. */
  readonly fields: LogFields;
}

/**
 * A logger that captures every line, at every level, with its bindings.
 *
 * Capturing all six levels rather than only `debug` is what lets a case assert
 * that nothing was written *above* `debug` — the difference between "the
 * adapter logged something" and "the adapter warned a developer about a signal
 * their project does not use".
 *
 * @param lines Where to collect the captured lines.
 * @param bindings The fields already bound by a `child` call.
 * @returns A logger.
 */
function capturingLogger(lines: LogLine[], bindings: LogFields = {}): Logger {
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
    child: (nested: LogFields) => capturingLogger(lines, { ...bindings, ...nested }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The observed readiness inputs, as named presets
 * ---------------------------------------------------------------------------------------------- */

/** The named preload states a case selects from. */
interface PreloadPresets {
  /** Nothing has ever announced itself: a dev server the developer started. */
  readonly notConnected: ObservedReadinessInputs;

  /** Attached to this project and heard from a moment ago. */
  readonly fresh: ObservedReadinessInputs;

  /** Attached to this project and silent past the configured window. */
  readonly stale: ObservedReadinessInputs;

  /** Announced once, and its connection has since gone. */
  readonly disconnected: ObservedReadinessInputs;

  /** Attached — to a different project, so no preload for this one. */
  readonly otherProject: ObservedReadinessInputs;

  /** Connected, and has not reported yet: a freshly launched dev server. */
  readonly neverReported: ObservedReadinessInputs;
}

/**
 * Builds the presets for one project.
 *
 * A function of the project rather than a constant, because every state except
 * the first names a project root, and "attached to a different project" is only
 * expressible relative to this one.
 *
 * @param project The project the presets are about.
 * @returns The six named states.
 */
function preloadPresets(project: IndexedProject): PreloadPresets {
  const attached = (lastHeartbeatAt: number): ObservedServerAgent => ({
    connected: true,
    projectRoot: project.root,
    lastHeartbeatAt,
  });

  return {
    notConnected: {},
    fresh: { serverAgent: attached(NOW - 1_000) },
    stale: { serverAgent: attached(NOW - (PRISMA_ADAPTER_LIMITS.heartbeatStalenessMs + 5_000)) },
    disconnected: {
      serverAgent: { connected: false, projectRoot: project.root, lastHeartbeatAt: NOW },
    },
    otherProject: {
      serverAgent: {
        connected: true,
        projectRoot: `${project.root}-elsewhere`,
        lastHeartbeatAt: NOW,
      },
    },
    neverReported: { serverAgent: { connected: true, projectRoot: project.root } },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The context
 * ---------------------------------------------------------------------------------------------- */

/** What a case varies about the context. */
interface ContextInput {
  /** The indexed project the context describes. */
  readonly project: IndexedProject;

  /** What the service observed about the two producers. Defaults to nothing. */
  readonly readiness?: ObservedReadinessInputs | undefined;

  /** Where to log. Defaults to silence. */
  readonly logger?: Logger | undefined;

  /** The session clock. Defaults to {@link frozenClock}. */
  readonly now?: (() => number) | undefined;

  /**
   * Omits the session clock entirely, so the adapter falls back to the one
   * injected through its options.
   *
   * A flag rather than an `undefined` clock, because under
   * `exactOptionalPropertyTypes` those are two different contexts and the
   * adapter's clock preference is exactly what distinguishes them.
   */
  readonly withoutSessionClock?: boolean | undefined;

  /** Cancellation, for the abort cases. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Builds an `InstrumentationContext` around an indexed project.
 *
 * The shape is read from `../adapter.ts` and never re-declared here. Optional
 * keys are *spread* rather than assigned, which `exactOptionalPropertyTypes`
 * requires: an explicitly `undefined` `now` is a different thing from an absent
 * one, and the adapter's clock preference depends on the difference.
 *
 * @param input What this case varies.
 * @returns The context.
 */
function contextFor(input: ContextInput): InstrumentationContext {
  return {
    sessionId: SESSION_ID,
    projectRoot: input.project.root,
    planVersion: PLAN_VERSION,
    debuggenHome: STATE_ROOT,
    logger: input.logger ?? noopLogger,
    graph: input.project.graph,
    queries: input.project.queries,
    routeMap: input.project.routeMap,
    projectSummary: input.project.projectSummary,
    loaded: input.project.loaded,
    journal: recordingJournal,
    backups: forbiddenBackups,
    readiness: input.readiness ?? {},
    ...(input.withoutSessionClock === true ? {} : { now: input.now ?? frozenClock }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Understandings, and the privacy scan
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds a validated Stage 1 artifact.
 *
 * @param signalsNeeded The signals the question asks for.
 * @param entities The entities it named.
 * @param searchHints The free-text hints it carried.
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

/** A latency question that asks for database evidence. */
const databaseQuestion = understandingFor(['interactions', 'fetch', 'http', 'prisma']);

/** A question about the page, which needs no database evidence. */
const renderQuestion = understandingFor(['react', 'state']);

/**
 * Substrings no string this adapter emits may contain, derived from the graphs
 * themselves.
 *
 * Every statement shape and every call-site text in play is forbidden, so the
 * assertion is about *this corpus's own data* rather than about a guess at what
 * SQL looks like: the extractor records a capped statement shape with its `$n`
 * placeholders preserved, and the rule of AAP §0.5.2 is that not even that
 * shape may be echoed into prose a developer or a model reads.
 *
 * @param projects The projects whose data must not leak.
 * @returns The forbidden substrings, lower-cased.
 */
function forbiddenDataStrings(projects: readonly IndexedProject[]): readonly string[] {
  const forbidden = new Set<string>(['$1', '$2', 'select ', 'insert into', 'delete from']);

  for (const project of projects) {
    for (const call of project.graph.nodesByKind('db-call')) {
      const shape = call.data.statementShape;

      if (shape !== undefined) {
        forbidden.add(shape.toLowerCase());
      }

      // The call's own text: `<handle>.<member>…`. A handle name is evidence of
      // nothing and belongs in no message.
      forbidden.add(call.name.toLowerCase());
    }
  }

  return [...forbidden];
}

/** Shapes a credential or an argument object would have if one ever leaked. */
const LEAK_PATTERNS: readonly RegExp[] = [
  // A connection string carrying credentials.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i,
  // A serialised argument object, however it was produced.
  /\[object Object\]/,
  /"(?:data|where|values|params)"\s*:/i,
];

/**
 * Asserts that nothing a developer or a model reads carries the data.
 *
 * @param values Every string one adapter call emitted.
 * @param projects The projects whose data is at stake.
 */
function expectNoDataLeak(values: readonly string[], projects: readonly IndexedProject[]): void {
  const forbidden = forbiddenDataStrings(projects);

  for (const value of values) {
    if (value.length === 0) {
      continue;
    }

    const lowered = value.toLowerCase();

    for (const needle of forbidden) {
      expect(lowered, `emitted string must not carry '${needle}': ${value}`).not.toContain(needle);
    }

    for (const pattern of LEAK_PATTERNS) {
      expect(value, `emitted string must not match ${pattern.source}`).not.toMatch(pattern);
    }
  }
}

/**
 * Flattens an unavailable report into the strings it puts in front of a
 * developer.
 *
 * @param unavailable The reported gaps.
 * @returns Their signal names, reasons and hints.
 */
function gapStrings(unavailable: readonly UnavailableSignal[]): string[] {
  return unavailable.flatMap((gap) => [String(gap.signal), gap.reason, gap.hint]);
}

/**
 * Every string one install result emitted.
 *
 * @param result The install result.
 * @returns Its hook names and gap strings.
 */
function installStrings(result: InstallResult): string[] {
  return [...result.runtimeHooks, ...gapStrings(result.unavailable)];
}

/**
 * Strips the fresh action ids so two proposals can be compared for equality.
 *
 * @param actions The proposed actions.
 * @returns The actions without their ids, in order.
 */
function withoutIds(actions: readonly InstrumentationAction[]): unknown[] {
  return actions.map((action) => ({
    file: action.file,
    symbol: action.symbol,
    type: action.type,
    adapter: action.adapter,
    mode: action.mode,
    rationale: action.rationale,
  }));
}

/* -------------------------------------------------------------------------------------------------
 * The corpus itself
 *
 * `assertCorpusInventory` already fails the run when one of these stops
 * holding; this group states them as assertions so that a reader of the suite
 * can see what every case below is standing on.
 * ---------------------------------------------------------------------------------------------- */

describe('the corpus', () => {
  it('carries both drivers, split across two modules', () => {
    const mapperCalls = driverCallSites(fixture, 'prisma');
    const driverCalls = driverCallSites(fixture, 'pg');

    expect(mapperCalls.length).toBeGreaterThanOrEqual(2);
    expect(driverCalls).toHaveLength(2);
    expect(new Set(mapperCalls.map((call) => call.file)).size).toBe(1);
    expect(new Set(driverCalls.map((call) => call.file)).size).toBe(1);
    expect(mapperCalls[0]?.file).not.toBe(driverCalls[0]?.file);
  });

  it('reports a database access style that includes the mapper', () => {
    expect(PRISMA_ACCESS_STYLES_WITH_MAPPER).toContain(fixture.projectSummary.databaseAccess.style);
    expect(fixture.projectSummary.databaseAccess.callSiteCount).toBe(
      fixture.graph.nodesByKind('db-call').length,
    );
  });

  it('records an addressable owner for every mapper call site', () => {
    const owners = mapperOwners(fixture);

    expect(owners.length).toBeGreaterThanOrEqual(2);

    for (const owner of owners) {
      expect(fixture.queries.hasSymbol(owner.file, owner.symbol)).toBe(true);
    }
  });

  it('holds single-driver, database-free and many-owner corpora beside it', () => {
    expect(driverCallSites(mapperOnly, 'pg')).toHaveLength(0);
    expect(driverCallSites(mapperOnly, 'prisma').length).toBeGreaterThan(0);
    expect(driverCallSites(driverOnly, 'prisma')).toHaveLength(0);
    expect(driverCallSites(driverOnly, 'pg').length).toBeGreaterThan(0);
    expect(databaseFree.graph.nodesByKind('db-call')).toHaveLength(0);
    expect(driverCallSites(manyOwners, 'prisma').length).toBeGreaterThan(
      PRISMA_ADAPTER_LIMITS.maxTargets,
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * Identity, the claim declaration, and the module's own shape
 * ---------------------------------------------------------------------------------------------- */

describe('the mapper adapter identity', () => {
  it('registers under the id its file is named for', () => {
    expect(PRISMA_ADAPTER_ID).toBe('prisma');
    expect(createPrismaAdapter().id).toBe(PRISMA_ADAPTER_ID);
  });

  it('claims exactly one action type, in runtime mode', () => {
    expect(PRISMA_ADAPTER_CLAIMS).toEqual([{ type: 'db-query-tracking', mode: 'runtime' }]);
    expect(createPrismaAdapter().claims).toBe(PRISMA_ADAPTER_CLAIMS);
    expect(Object.isFrozen(PRISMA_ADAPTER_CLAIMS)).toBe(true);
    expect(Object.isFrozen(PRISMA_ADAPTER_CLAIMS[0])).toBe(true);
  });

  it('states that claim in the two closed vocabularies that own it', () => {
    for (const claim of PRISMA_ADAPTER_CLAIMS) {
      expect(INSTRUMENTATION_ACTION_TYPES).toContain(claim.type);
      expect(INSTRUMENTATION_MODES).toContain(claim.mode);
    }
  });

  it('contributes exactly the mapper key of the preload configuration', () => {
    expect(PRISMA_SERVER_SIGNAL_KEYS).toEqual(['prisma']);
    expect(PRISMA_SERVER_SIGNAL_KEYS).toHaveLength(1);

    for (const key of PRISMA_SERVER_SIGNAL_KEYS) {
      expect(SERVER_AGENT_SIGNAL_KEYS).toContain(key);
    }

    // The driver's key is the sibling adapter's to contribute, and the named
    // function list costs a file modification, which this adapter never makes.
    expect(PRISMA_SERVER_SIGNAL_KEYS).not.toContain('pg');
    expect(PRISMA_SERVER_SIGNAL_KEYS).not.toContain('functions');
  });

  it('names a capture signal from the closed vocabulary', () => {
    expect(CAPTURE_SIGNALS).toContain(PRISMA_ADAPTER_ID);
  });

  it('publishes frozen limits and relaunch wording', () => {
    expect(Object.isFrozen(PRISMA_ADAPTER_LIMITS)).toBe(true);
    expect(Object.isFrozen(PRISMA_RELAUNCH_DEFAULTS)).toBe(true);
    expect(PRISMA_ADAPTER_LIMITS.maxTargets).toBeGreaterThan(0);
    expect(PRISMA_ADAPTER_LIMITS.maxTargets).toBeLessThanOrEqual(
      PRISMA_ADAPTER_LIMITS.maxTargetsCeiling,
    );
    expect(PRISMA_ADAPTER_LIMITS.heartbeatStalenessMs).toBeGreaterThan(0);
    expect(PRISMA_ADAPTER_LIMITS.maxMessageLength).toBeGreaterThan(0);
    expect(PRISMA_ADAPTER_LIMITS.maxRationaleLength).toBeGreaterThan(0);
    expect(PRISMA_RELAUNCH_DEFAULTS.preloadSpecifier.length).toBeGreaterThan(0);
    expect(PRISMA_RELAUNCH_DEFAULTS.devScript.length).toBeGreaterThan(0);
  });

  it('builds independent instances that share no mutable state', async () => {
    const first = createPrismaAdapter();
    const second = createPrismaAdapter();

    expect(first).not.toBe(second);
    expect(first.id).toBe(second.id);

    const context = contextFor({ project: fixture, readiness: preloadPresets(fixture).fresh });
    const result = await first.install(await first.createPlan(context, databaseQuestion), context);

    // Every array on a result is freshly built, so a consumer that sorts or
    // splices one cannot change what the next call reports.
    result.runtimeHooks.push('a consumer wrote here');
    result.unavailable.push({ signal: 'prisma', reason: 'so did this', hint: 'and this' });

    const again = await second.install(await second.createPlan(context, databaseQuestion), context);

    expect(again.runtimeHooks).not.toContain('a consumer wrote here');
    expect(again.unavailable).toEqual([]);
  });

  it('reaches no port while it is being constructed', () => {
    // Construction is a pure resolution of options: no journal call, and no
    // backup store to throw.
    createPrismaAdapter({ maxTargets: 2, heartbeatStalenessMs: 1_000, now: frozenClock });

    expect(journalCalls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * canHandle — the discriminator that keeps the dual claim on
 * `db-query-tracking` honest
 * ---------------------------------------------------------------------------------------------- */

describe('canHandle', () => {
  it('claims a project whose graph carries mapper call sites', () => {
    const answer: unknown = createPrismaAdapter().canHandle(contextFor({ project: fixture }));

    expect(answer).toBe(true);

    // Synchronous by contract: the registry asks every claimant of an action
    // type in turn while it routes a plan, so an answer it had to await would
    // change how that routing is written.
    expect(typeof answer).toBe('boolean');
    expect(answer).not.toBeInstanceOf(Promise);
  });

  it('declines a project that reaches its database only through the driver', () => {
    // The decisive negative case: `db-query-tracking` is claimed by this
    // adapter and by its driver sibling, and this is the answer that lets the
    // registry tell them apart.
    expect(createPrismaAdapter().canHandle(contextFor({ project: driverOnly }))).toBe(false);
  });

  it('claims a project that uses the mapper under names it has never seen', () => {
    // Arbitrary handle, model and operation names throughout the corpus, so a
    // `true` here can only have come from `DbCallNodeData.driver`
    // (AAP §0.5.4).
    expect(createPrismaAdapter().canHandle(contextFor({ project: mapperOnly }))).toBe(true);
  });

  it('declines a project with no database access at all', () => {
    expect(createPrismaAdapter().canHandle(contextFor({ project: databaseFree }))).toBe(false);
  });

  it('answers the same way whatever the preload is doing', () => {
    const adapter = createPrismaAdapter();
    const presets = preloadPresets(fixture);

    for (const readiness of [
      presets.notConnected,
      presets.fresh,
      presets.stale,
      presets.disconnected,
      presets.otherProject,
      presets.neverReported,
    ]) {
      // Capability is not readiness: a project that queries through the mapper
      // is a project this adapter claims, whether or not a preload is attached
      // today.
      expect(adapter.canHandle(contextFor({ project: fixture, readiness }))).toBe(true);
      expect(adapter.canHandle(contextFor({ project: driverOnly, readiness }))).toBe(false);
    }
  });

  it('reaches no port and touches no file', () => {
    const adapter = createPrismaAdapter();

    // The backup store throws on every member and the journal records every
    // call, so an answer produced by reading the project would be visible here
    // as a thrown error or a recorded call.
    for (const project of [fixture, mapperOnly, driverOnly, databaseFree]) {
      adapter.canHandle(contextFor({ project }));
    }

    expect(journalCalls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan — graph-driven selection, and no leakage from the other driver
 * ---------------------------------------------------------------------------------------------- */

describe('createPlan', () => {
  it('proposes runtime actions the plan schema accepts', async () => {
    const context = contextFor({ project: fixture });
    const actions = await createPrismaAdapter().createPlan(context, databaseQuestion);

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      expect(action.type).toBe('db-query-tracking');
      expect(action.mode).toBe('runtime');
      expect(action.adapter).toBe(PRISMA_ADAPTER_ID);
      expect(action.id).toMatch(ACTION_ID_PATTERN);
      expect(action.rationale.trim().length).toBeGreaterThan(0);
      expect(action.rationale.length).toBeLessThanOrEqual(PRISMA_ADAPTER_LIMITS.maxRationaleLength);
      expect(action.rationale).not.toContain('\n');
      expect(instrumentationActionSchema.safeParse(action).success).toBe(true);

      // Every target is a declaration the graph can address, which is what the
      // feasibility gate will ask next.
      expect(context.queries.hasSymbol(action.file, action.symbol)).toBe(true);
    }
  });

  it('anchors on the enclosing declaration the graph records, never on the call', async () => {
    const context = contextFor({ project: fixture });
    const actions = await createPrismaAdapter().createPlan(context, databaseQuestion);
    const expected = mapperOwners(fixture);
    const calleeNames = new Set(driverCallSites(fixture, 'prisma').map((call) => call.name));
    const models = new Set(
      driverCallSites(fixture, 'prisma')
        .map((call) => call.data.model)
        .filter((model): model is string => model !== undefined),
    );

    expect(actions.map((action) => action.symbol).sort()).toEqual(
      expected.map((owner) => owner.symbol).sort(),
    );

    for (const action of actions) {
      const owner = expected.find((candidate) => candidate.symbol === action.symbol);

      expect(owner).toBeDefined();
      expect(action.file).toBe(owner?.file);

      // A model, an operation or a callee is not a symbol anything can
      // address, and an action naming one would be rejected downstream.
      expect(calleeNames.has(action.symbol)).toBe(false);
      expect(models.has(action.symbol)).toBe(false);
    }
  });

  it('never points at a call site belonging to the other driver', async () => {
    // The fixture carries both drivers, so this is the case that proves the
    // filter is `DbCallNodeData.driver` and not the module or the project.
    const context = contextFor({ project: fixture });
    const actions = await createPrismaAdapter().createPlan(context, databaseQuestion);
    const driverOwners = ownersForDriver(fixture, 'pg');

    expect(driverOwners.length).toBeGreaterThan(0);
    expect(new Set(actions.map((action) => action.symbol))).toEqual(
      new Set(mapperOwners(fixture).map((owner) => owner.symbol)),
    );

    for (const owner of driverOwners) {
      expect(actions.map((action) => action.symbol)).not.toContain(owner.symbol);
      expect(actions.map((action) => action.file)).not.toContain(owner.file);
    }
  });

  it('stays inside the exported cap however many call sites the graph holds', async () => {
    const actions = await createPrismaAdapter().createPlan(
      contextFor({ project: manyOwners }),
      databaseQuestion,
    );

    expect(driverCallSites(manyOwners, 'prisma').length).toBeGreaterThan(actions.length);
    expect(actions.length).toBeLessThanOrEqual(PRISMA_ADAPTER_LIMITS.maxTargets);
    expect(actions.length).toBeGreaterThan(0);
  });

  it('honours a configured cap, and ignores an unusable one', async () => {
    const context = contextFor({ project: fixture });
    const unnarrowed = await createPrismaAdapter().createPlan(context, databaseQuestion);

    expect(
      await createPrismaAdapter({ maxTargets: 1 }).createPlan(context, databaseQuestion),
    ).toHaveLength(1);

    // A cap that cannot mean anything — zero, negative, not a number, or
    // unbounded — is answered with the shipped default rather than with a
    // refusal: a proposal is worth making even when one knob arrived malformed.
    for (const maxTargets of [
      0,
      -3,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const actions = await createPrismaAdapter({ maxTargets }).createPlan(
        context,
        databaseQuestion,
      );

      expect(actions).toHaveLength(unnarrowed.length);
    }

    // A fractional cap is brought into range rather than refused, so it still
    // yields a usable proposal.
    expect(
      await createPrismaAdapter({ maxTargets: 1.5 }).createPlan(context, databaseQuestion),
    ).toHaveLength(1);

    // And a cap above the ceiling cannot crowd the rest of a plan out of the
    // 64-target budget `../schema/plan.ts` allows.
    const beyondCeiling = await createPrismaAdapter({
      maxTargets: PRISMA_ADAPTER_LIMITS.maxTargetsCeiling * 4,
    }).createPlan(contextFor({ project: manyOwners }), databaseQuestion);

    expect(beyondCeiling.length).toBeLessThanOrEqual(PRISMA_ADAPTER_LIMITS.maxTargetsCeiling);
  });

  it('says that the instrumentation is process-wide and the symbol an anchor', async () => {
    const context = contextFor({ project: fixture });
    const actions = await createPrismaAdapter().createPlan(context, databaseQuestion);

    for (const action of actions) {
      // The honesty this rationale owes a developer: one action arms the whole
      // dev-server process, and the named symbol is where the graph found the
      // queries rather than the extent of what will be observed.
      expect(action.rationale).toMatch(/process/i);
      expect(action.rationale).toMatch(/anchor/i);
      expect(action.rationale).toContain(action.symbol);
      expect(action.rationale).toContain(action.file);
    }
  });

  it('narrows to a declaration the question named', async () => {
    const context = contextFor({ project: fixture });
    const owners = mapperOwners(fixture);
    const [, second] = owners;

    expect(owners.length).toBeGreaterThan(1);
    expect(second).toBeDefined();

    const narrowed = await createPrismaAdapter().createPlan(
      context,
      understandingFor(
        ['prisma'],
        [{ kind: 'function', name: second?.symbol ?? '', file: second?.file ?? '' }],
      ),
    );

    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]?.symbol).toBe(second?.symbol);
  });

  it('narrows on a bare search hint the graph resolves', async () => {
    const context = contextFor({ project: fixture });
    const [, second] = mapperOwners(fixture);

    const narrowed = await createPrismaAdapter().createPlan(
      context,
      understandingFor(['prisma'], [], [second?.symbol ?? '']),
    );

    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]?.symbol).toBe(second?.symbol);
  });

  it('falls back to the ranked anchors when nothing the question named resolves', async () => {
    const context = contextFor({ project: fixture });
    const unnarrowed = await createPrismaAdapter().createPlan(context, databaseQuestion);
    const withJunk = await createPrismaAdapter().createPlan(
      context,
      understandingFor(
        ['prisma'],
        [{ kind: 'function', name: 'thereIsNoSuchDeclarationHere' }],
        ['norIsThereThisOne'],
      ),
    );

    // A name that resolves to nothing narrows nothing: the proposal is the
    // unnarrowed one rather than an empty result or a guess.
    expect(withoutIds(withJunk)).toEqual(withoutIds(unnarrowed));
  });

  it('proposes nothing for a question that asks for no database evidence', async () => {
    await expect(
      createPrismaAdapter().createPlan(contextFor({ project: fixture }), renderQuestion),
    ).resolves.toEqual([]);
  });

  it('proposes for a question that named the data layer without naming a signal', async () => {
    const actions = await createPrismaAdapter().createPlan(
      contextFor({ project: fixture }),
      understandingFor(['interactions'], [{ kind: 'query', name: 'the slow read' }]),
    );

    expect(actions.length).toBeGreaterThan(0);
  });

  it('returns an empty array, and never throws, for a project it does not claim', async () => {
    for (const project of [driverOnly, databaseFree]) {
      await expect(
        createPrismaAdapter().createPlan(contextFor({ project }), databaseQuestion),
      ).resolves.toEqual([]);
    }
  });

  it('proposes nothing once the session has been abandoned', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      createPrismaAdapter().createPlan(
        contextFor({ project: fixture, signal: controller.signal }),
        databaseQuestion,
      ),
    ).resolves.toEqual([]);
  });

  it('produces the same proposal twice, in the same order, apart from fresh ids', async () => {
    const context = contextFor({ project: fixture });
    const adapter = createPrismaAdapter();

    const first = await adapter.createPlan(context, databaseQuestion);
    const second = await adapter.createPlan(context, databaseQuestion);

    expect(withoutIds(second)).toEqual(withoutIds(first));
    expect(second.map((action) => action.id)).not.toEqual(first.map((action) => action.id));
  });

  it('is serialisable, because a plan is stored and sent', async () => {
    const actions = await createPrismaAdapter().createPlan(
      contextFor({ project: fixture }),
      databaseQuestion,
    );
    const roundTripped: unknown = JSON.parse(JSON.stringify(actions));

    expect(roundTripped).toEqual(actions);
  });

  it('writes no statement, placeholder, argument or credential into a plan', async () => {
    for (const project of [fixture, mapperOnly, manyOwners]) {
      const actions = await createPrismaAdapter().createPlan(
        contextFor({ project }),
        databaseQuestion,
      );

      // The whole plan, as it would be persisted and prompted with.
      expectNoDataLeak([JSON.stringify(actions)], [fixture, mapperOnly, driverOnly, manyOwners]);
    }
  });

  it('records nothing in the journal and never reaches the backup store', async () => {
    await createPrismaAdapter().createPlan(contextFor({ project: fixture }), databaseQuestion);

    expect(journalCalls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan — tooling modules and reachability from the question's route
 *
 * The mapper's spans come from the preload inside the dev-server process, so a
 * seed or a script (each run in a process of its own) can never contribute one,
 * and a question about a route is answered with the query sites that route
 * actually reaches, however many calls below its handler they sit.
 * ---------------------------------------------------------------------------------------------- */

/** The request path the reachability corpus's route module answers. */
const WICKET_ROUTE = '/api/wicket';

/** The reachability corpus's modules the adapter must never anchor on. */
const TOOLING_MODULES: readonly string[] = ['prisma/seed.ts', 'scripts/rebuild-lanes.ts'];

/**
 * `file#symbol` keys, in order, for comparing a proposal against the graph.
 *
 * @param entries Actions or owners.
 * @returns Their keys, in the order given.
 */
function targetKeys(entries: readonly OwnerRef[]): string[] {
  return entries.map((entry) => `${entry.file}#${entry.symbol}`);
}

/**
 * The reachability corpus's owner in one module.
 *
 * @param file The module.
 * @returns The owner.
 */
function reachabilityOwner(file: string): OwnerRef {
  const owner = mapperOwners(reachability).find((candidate) => candidate.file === file);

  if (owner === undefined) {
    throw new Error(`the reachability corpus must record a mapper query owner in ${file}`);
  }

  return owner;
}

describe('createPlan — tooling modules and reachability', () => {
  it('stands on a corpus whose tooling owners sort first and whose route reaches two owners', () => {
    const owners = mapperOwners(reachability);
    const byFile = [...owners].sort((left, right) =>
      left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
    );

    // Without the exclusion, a path-ordered proposal would open on the seed
    // and the script.
    expect(new Set(byFile.slice(0, 2).map((owner) => owner.file))).toEqual(
      new Set(TOOLING_MODULES),
    );

    const route = reachability.queries.routeForUrl(WICKET_ROUTE);
    const routeNode = route?.node?.nodeId;

    expect(routeNode).toBeDefined();

    const near = reachabilityOwner('src/back/wicket-ledger.ts');
    const far = reachabilityOwner('src/back/abacus-ledger.ts');
    const unrelated = reachabilityOwner('src/back/aardvark-ledger.ts');

    // Neither reached owner has a caller in the route module itself, so only a
    // multi-hop search can connect them to the question.
    for (const owner of [near, far]) {
      const callerFiles = reachability.queries
        .whoCalls({ file: owner.file, symbol: owner.symbol })
        .map((caller) => caller.caller.file);

      expect(callerFiles).not.toContain(route?.file);
    }

    const nearPath = reachability.queries.pathBetween(routeNode ?? '', {
      file: near.file,
      symbol: near.symbol,
    });
    const farPath = reachability.queries.pathBetween(routeNode ?? '', {
      file: far.file,
      symbol: far.symbol,
    });

    expect(nearPath?.depth).toBeGreaterThan(1);
    expect(farPath?.depth).toBeGreaterThan(nearPath?.depth ?? Number.POSITIVE_INFINITY);
    expect(far.file < near.file).toBe(true);
    expect(unrelated.file < far.file).toBe(true);
    expect(
      reachability.queries.pathBetween(routeNode ?? '', {
        file: unrelated.file,
        symbol: unrelated.symbol,
      }),
    ).toBeUndefined();
  });

  it('never proposes a seed or script query site, even for an unnarrowed question', async () => {
    const applicationOwners = mapperOwners(reachability).filter(
      (owner) => !TOOLING_MODULES.includes(owner.file),
    );
    const everyAnchor = await createPrismaAdapter({
      maxTargets: PRISMA_ADAPTER_LIMITS.maxTargetsCeiling,
    }).createPlan(contextFor({ project: reachability }), databaseQuestion);
    const shipped = await createPrismaAdapter().createPlan(
      contextFor({ project: reachability }),
      databaseQuestion,
    );

    // The fallback still offers every application owner, and nothing else.
    expect(new Set(targetKeys(everyAnchor))).toEqual(new Set(targetKeys(applicationOwners)));
    expect(shipped.length).toBe(
      Math.min(PRISMA_ADAPTER_LIMITS.maxTargets, applicationOwners.length),
    );

    for (const action of [...everyAnchor, ...shipped]) {
      expect(TOOLING_MODULES).not.toContain(action.file);
    }
  });

  it('proposes nothing when every query site is in a tooling module', async () => {
    const lines: LogLine[] = [];
    const actions = await createPrismaAdapter({ logger: capturingLogger(lines) }).createPlan(
      contextFor({ project: toolingOnly }),
      databaseQuestion,
    );

    expect(mapperOwners(toolingOnly).length).toBe(TOOLING_MODULES.length);
    expect(actions).toEqual([]);
    expect(lines.map((line) => line.message)).toContain(
      'every query owner is a tooling module; proposing nothing',
    );
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);
  });

  it('anchors on the query sites a named route reaches through several calls, nearest first', async () => {
    const near = reachabilityOwner('src/back/wicket-ledger.ts');
    const far = reachabilityOwner('src/back/abacus-ledger.ts');
    const routeQuestion = understandingFor(['prisma'], [{ kind: 'route', name: WICKET_ROUTE }]);

    const actions = await createPrismaAdapter().createPlan(
      contextFor({ project: reachability }),
      routeQuestion,
    );

    // Exactly the reached owners, the nearer first although its module sorts
    // later; the unrelated owner and both tooling owners are not proposed.
    expect(targetKeys(actions)).toEqual(targetKeys([near, far]));

    const single = await createPrismaAdapter({ maxTargets: 1 }).createPlan(
      contextFor({ project: reachability }),
      routeQuestion,
    );

    expect(targetKeys(single)).toEqual(targetKeys([near]));
  });
});

/* -------------------------------------------------------------------------------------------------
 * install — the preload gate, the relaunch hint, and the silence
 * ---------------------------------------------------------------------------------------------- */

/**
 * The actions one adapter would be handed for a project, built through the
 * adapter itself.
 *
 * Going through `createPlan` rather than hand-writing an action keeps the
 * install cases honest about what the installer actually routes here.
 *
 * @param project The project to plan for.
 * @returns The proposed actions.
 */
async function plannedActions(project: IndexedProject): Promise<InstrumentationAction[]> {
  return createPrismaAdapter().createPlan(contextFor({ project }), databaseQuestion);
}

/**
 * The full six-key preload configuration the service would send, given one
 * adapter's contribution.
 *
 * `ServerAgentSignals` is a closed, six-key contract the preload parses
 * structurally, and an adapter contributes a *slice* of it. Merging the slice
 * onto the disabled baseline is how the service assembles the frame, so
 * validating the merge is what catches a hand-rolled or misspelled key before
 * it reaches the wire.
 *
 * @param result The install result.
 * @returns The assembled configuration, validated.
 */
function assembledServerSignals(result: InstallResult): Record<string, unknown> {
  const parsed = serverAgentSignalsSchema.safeParse({
    ...DISABLED_SERVER_AGENT_SIGNALS,
    ...result.serverSignals,
  });

  expect(parsed.success).toBe(true);

  return { ...DISABLED_SERVER_AGENT_SIGNALS, ...result.serverSignals };
}

describe('install', () => {
  it('writes nothing, whatever the preload is doing', async () => {
    const actions = await plannedActions(fixture);
    const presets = preloadPresets(fixture);

    for (const readiness of [
      presets.notConnected,
      presets.fresh,
      presets.stale,
      presets.disconnected,
      presets.otherProject,
      presets.neverReported,
    ]) {
      const result = await createPrismaAdapter().install(
        actions,
        contextFor({ project: fixture, readiness }),
      );

      expect(result.adapterId).toBe(PRISMA_ADAPTER_ID);
      expect(result.applied).toEqual([]);
      expect(result.agentHooks).toBeUndefined();
      expect(journalCalls).toEqual([]);
    }
  });

  it('arms the signal and reports no gap when the preload is attached', async () => {
    const result = await createPrismaAdapter().install(
      await plannedActions(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture).fresh }),
    );

    expect(result.unavailable).toEqual([]);
    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect([...result.runtimeHooks].sort()).toEqual(result.runtimeHooks);
    expect(new Set(result.runtimeHooks).size).toBe(result.runtimeHooks.length);
    expect(result.applied).toEqual([]);
  });

  it('contributes exactly the mapper key of the preload configuration', async () => {
    const result = await createPrismaAdapter().install(
      await plannedActions(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture).fresh }),
    );

    expect(Object.keys(result.serverSignals ?? {})).toEqual([...PRISMA_SERVER_SIGNAL_KEYS]);

    const assembled = assembledServerSignals(result);

    expect(assembled['prisma']).toBe(true);

    // The driver's key and the patched-function list are left exactly as the
    // baseline had them: the first belongs to the sibling adapter, the second
    // to the framework adapter, which is the only one that patches a file.
    expect(assembled['pg']).toBe(DISABLED_SERVER_AGENT_SIGNALS.pg);
    expect(assembled['functions']).toEqual([]);
  });

  it('reports one actionable gap naming the project when no preload is attached', async () => {
    const context = contextFor({
      project: fixture,
      readiness: preloadPresets(fixture).notConnected,
    });
    const result = await createPrismaAdapter().install(await plannedActions(fixture), context);

    expect(result.unavailable).toHaveLength(1);

    const [gap] = result.unavailable;

    expect(gap).toBeDefined();
    expect([...CAPTURE_SIGNALS]).toContain(gap?.signal);
    expect(gap?.signal).toBe(PRISMA_ADAPTER_ID);

    // The reason states what was observed, in one line, within the bound the
    // readiness row that carries it accepts.
    expect(gap?.reason).toBe(gap?.reason.trim());
    expect((gap?.reason ?? '').length).toBeGreaterThan(0);
    expect((gap?.reason ?? '').length).toBeLessThanOrEqual(PRISMA_ADAPTER_LIMITS.maxMessageLength);
    expect(gap?.reason).not.toContain('\n');
    expect(gap?.reason).toMatch(/preload/i);

    // The hint is the one thing the developer can do, and it says WHICH
    // project to do it to (AAP §0.5.5).
    expect(gap?.hint).toBe(gap?.hint.trim());
    expect((gap?.hint ?? '').length).toBeGreaterThan(0);
    expect((gap?.hint ?? '').length).toBeLessThanOrEqual(PRISMA_ADAPTER_LIMITS.maxMessageLength);
    expect(gap?.hint).not.toContain('\n');
    expect(gap?.hint).toContain(fixture.root);
    // The one exact instruction this adapter can give unaided: the editor
    // command, named as the VS Code palette labels it (QA INT-F05).
    expect(gap?.hint).toContain(`"${LAUNCH_DEV_SERVER_PALETTE_LABEL}" in VS Code`);
    expectNoHandTypedCommand(gap?.hint ?? '');

    // Nothing is armed, because there is no process holding it - and the row
    // is renderable as the readiness row that shows the same words.
    expect(result.runtimeHooks).toEqual([]);
    expect(
      readinessSchema.safeParse({
        ready: false,
        adapter: PRISMA_ADAPTER_ID,
        signals: [
          { signal: gap?.signal, status: 'unavailable', reason: gap?.reason, hint: gap?.hint },
        ],
        checkedAt: NOW,
      }).success,
    ).toBe(true);
  });

  it('names the editor command rather than a preload line the project cannot run', async () => {
    const result = await createPrismaAdapter().install(
      await plannedActions(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture).notConnected }),
    );
    const hint = result.unavailable[0]?.hint ?? '';

    // A known package manager changes nothing: a command composed from it and
    // the published specifier fails with ERR_MODULE_NOT_FOUND in a target that
    // has no `@debuggen/*` dependency, and sets no ingest credential.
    expect(fixture.projectSummary.packageManager).not.toBe('unknown');
    expect(hint).toBe(
      `Run "${LAUNCH_DEV_SERVER_PALETTE_LABEL}" in VS Code for ${fixture.root}, which starts this project's dev server with the preload and a fresh ingest credential.`,
    );
    expectNoHandTypedCommand(hint);
    expect(hint).not.toContain(`run ${PRISMA_RELAUNCH_DEFAULTS.devScript}`);
    expect(hint.split('\n')).toHaveLength(1);
  });

  it('drops a project root that cannot be carried whole, never cutting or altering it', async () => {
    const actions = await plannedActions(fixture);
    const bound = PRISMA_ADAPTER_LIMITS.maxMessageLength;
    const rootless = `Run "${LAUNCH_DEV_SERVER_PALETTE_LABEL}" in VS Code, which starts this project's dev server with the preload and a fresh ingest credential.`;
    // Longer than the whole bound, and a path whose bell a clamp would blank:
    // either way, naming it would mean naming a path that is not the project's.
    const roots = [`/${'r'.repeat(bound)}`, '/work/bell\u0007shop'];

    for (const root of roots) {
      const context: InstrumentationContext = {
        ...contextFor({ project: fixture, readiness: {} }),
        projectRoot: root,
      };
      const installed = await createPrismaAdapter().install(actions, context);
      const report = await createPrismaAdapter().readiness(context);
      const hints = [installed.unavailable[0]?.hint, report.signals[0]?.hint];

      expect(readinessSchema.safeParse(report).success).toBe(true);

      for (const hint of hints) {
        expect(hint).toBe(rootless);
        expect(hint?.endsWith('…')).toBe(false);
      }
    }

    // The quiet-preload restart hint degrades the same way.
    const longRoot = `/${'r'.repeat(bound)}`;
    const stale = await createPrismaAdapter().install(actions, {
      ...contextFor({
        project: fixture,
        readiness: {
          serverAgent: {
            connected: true,
            projectRoot: longRoot,
            lastHeartbeatAt: NOW - (PRISMA_ADAPTER_LIMITS.heartbeatStalenessMs + 5_000),
          },
        },
      }),
      projectRoot: longRoot,
    });

    expect(stale.unavailable[0]?.hint).toBe(
      `Restart this project's dev server with "${LAUNCH_DEV_SERVER_PALETTE_LABEL}" in VS Code so its preload reconnects.`,
    );
  });

  it('treats a preload attached to another project as no preload at all', async () => {
    const result = await createPrismaAdapter().install(
      await plannedActions(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture).otherProject }),
    );

    expect(result.unavailable).toHaveLength(1);
    expect(result.unavailable[0]?.hint).toContain(fixture.root);
    expect(result.runtimeHooks).toEqual([]);
  });

  it('treats a connection that has gone as no preload at all', async () => {
    const result = await createPrismaAdapter().install(
      await plannedActions(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture).disconnected }),
    );

    expect(result.unavailable).toHaveLength(1);
    expect(result.runtimeHooks).toEqual([]);
  });

  it('degrades rather than disappears when the preload has gone quiet', async () => {
    const actions = await plannedActions(fixture);
    const presets = preloadPresets(fixture);

    // Staleness is driven entirely by the injected clock: nothing here waits.
    const stale = await createPrismaAdapter().install(
      actions,
      contextFor({ project: fixture, readiness: presets.stale }),
    );
    const absent = await createPrismaAdapter().install(
      actions,
      contextFor({ project: fixture, readiness: presets.notConnected }),
    );

    expect(stale.unavailable).toHaveLength(1);

    // The connection is up, so the hook is armed and the limitation is stated
    // beside it rather than instead of it.
    expect(stale.runtimeHooks.length).toBeGreaterThan(0);
    expect(stale.unavailable[0]?.hint).toContain(fixture.root);

    // Two different observations must read as two different sentences: "no
    // preload" asks for a relaunch, "a quiet preload" asks for a restart
    // through the editor.
    expect(stale.unavailable[0]?.reason).not.toBe(absent.unavailable[0]?.reason);
    expect(stale.unavailable[0]?.hint).not.toBe(absent.unavailable[0]?.hint);
    expect(stale.unavailable[0]?.hint).toMatch(/restart/i);
    expect(stale.unavailable[0]?.hint).toBe(
      `Restart the dev server for ${fixture.root} with "${LAUNCH_DEV_SERVER_PALETTE_LABEL}" in VS Code so its preload reconnects.`,
    );
  });

  it('does not greet a freshly launched preload with a warning about itself', async () => {
    // Connected and not heard from yet is not the same thing as gone quiet.
    const result = await createPrismaAdapter().install(
      await plannedActions(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture).neverReported }),
    );

    expect(result.unavailable).toEqual([]);
    expect(result.runtimeHooks.length).toBeGreaterThan(0);
  });

  it('honours a configured staleness window', async () => {
    const actions = await plannedActions(fixture);
    const readiness: ObservedReadinessInputs = {
      serverAgent: { connected: true, projectRoot: fixture.root, lastHeartbeatAt: NOW - 5_000 },
    };
    const context = contextFor({ project: fixture, readiness });

    const tolerant = await createPrismaAdapter({ heartbeatStalenessMs: 60_000 }).install(
      actions,
      context,
    );
    const strict = await createPrismaAdapter({ heartbeatStalenessMs: 1_000 }).install(
      actions,
      context,
    );

    expect(tolerant.unavailable).toEqual([]);
    expect(strict.unavailable).toHaveLength(1);
    expect(strict.unavailable[0]?.reason).toMatch(/5s/);
  });

  it('uses an injected relaunch descriptor verbatim, and reads no environment', async () => {
    const command = 'scratch-launcher up --with-preload';
    const note = 'Start it the way the service would';

    // A sentinel in the environment: the hint may not contain it, and the
    // static import-boundary guard below proves `process.env` is never read.
    vi.stubEnv('NODE_OPTIONS', '--import sentinel-that-must-not-appear');

    const result = await createPrismaAdapter({ relaunch: { command, note } }).install(
      await plannedActions(fixture),
      contextFor({ project: fixture, readiness: preloadPresets(fixture).notConnected }),
    );
    const hint = result.unavailable[0]?.hint ?? '';

    expect(hint).toContain(command);
    expect(hint).toContain(note);
    expect(hint).toContain(fixture.root);
    expect(hint).not.toContain('sentinel-that-must-not-appear');

    // The injected command wins outright: nothing is composed beside it.
    expect(hint).not.toContain(PRISMA_RELAUNCH_DEFAULTS.preloadSpecifier);
    expect(hint.split('\n')).toHaveLength(1);
  });

  it('names the editor command when the package manager could not be determined', async () => {
    const unknownManager = await scratchProject(
      'unknown-manager',
      MAPPER_ONLY_SOURCES,
      // A manifest that declares no package manager, in a directory that
      // belongs to no workspace: there is no command line to hand over, so the
      // one-click alternative is what remains.
      {},
    );
    const result = await createPrismaAdapter().install(
      await plannedActions(unknownManager),
      contextFor({
        project: unknownManager,
        readiness: preloadPresets(unknownManager).notConnected,
      }),
    );
    const hint = result.unavailable[0]?.hint ?? '';

    expect(unknownManager.projectSummary.packageManager).toBe('unknown');
    expect(hint).toContain(unknownManager.root);
    expect(hint).toContain(`"${LAUNCH_DEV_SERVER_PALETTE_LABEL}" in VS Code`);
    expectNoHandTypedCommand(hint);
    expect(hint.split('\n')).toHaveLength(1);
  });

  it('stays silent for a project that does not use the mapper', async () => {
    // The defect this case exists to prevent: a "could not enable Prisma"
    // report on a project that never queries through it, which would hold the
    // session's readiness gate open over a gap the developer cannot close.
    for (const project of [driverOnly, databaseFree]) {
      const lines: LogLine[] = [];
      const result = await createPrismaAdapter({ logger: capturingLogger(lines) }).install(
        [],
        contextFor({ project, readiness: preloadPresets(project).notConnected }),
      );

      expect(result.applied).toEqual([]);
      expect(result.unavailable).toEqual([]);
      expect(result.runtimeHooks).toEqual([]);
      expect(journalCalls).toEqual([]);

      for (const line of lines) {
        expect(line.level).toBe('debug');
      }
    }
  });

  it('ignores an action belonging to another adapter or another type', async () => {
    const actions = await plannedActions(fixture);
    const [anchor] = actions;

    expect(anchor).toBeDefined();

    const context = contextFor({ project: fixture, readiness: preloadPresets(fixture).fresh });
    const adapter = createPrismaAdapter();
    const filtered = await adapter.install(actions, context);
    const mixed = await adapter.install(
      [
        ...actions,
        ...(anchor === undefined ? [] : [{ ...anchor, adapter: 'postgres' }]),
        ...(anchor === undefined
          ? []
          : [{ ...anchor, type: 'function-timing' as const, mode: 'patch' as const }]),
      ],
      context,
    );

    // Silently ignored rather than counted: the installer routes by adapter id
    // already, and a second filter here is what keeps a mis-routed action from
    // being reported as armed.
    expect(mixed).toEqual(filtered);
  });

  it('reports hooks deterministically, and in the same order', async () => {
    const actions = await plannedActions(fixture);
    const context = contextFor({ project: fixture, readiness: preloadPresets(fixture).fresh });
    const adapter = createPrismaAdapter();

    const first = await adapter.install(actions, context);
    const second = await adapter.install([...actions].reverse(), context);

    expect(second.runtimeHooks).toEqual(first.runtimeHooks);
  });

  it('resolves rather than rejecting for every observed state', async () => {
    const actions = await plannedActions(fixture);
    const presets = preloadPresets(fixture);

    // Degradation is data. None of these is an error, and an adapter that
    // threw for one of them would take the whole capture down with it.
    for (const readiness of [
      presets.notConnected,
      presets.fresh,
      presets.stale,
      presets.disconnected,
      presets.otherProject,
      presets.neverReported,
    ]) {
      await expect(
        createPrismaAdapter().install(actions, contextFor({ project: fixture, readiness })),
      ).resolves.toBeDefined();
    }
  });

  it('leaks no statement, shape, handle or credential into a result or a log', async () => {
    const presets = preloadPresets(fixture);

    for (const readiness of [presets.notConnected, presets.fresh, presets.stale]) {
      const lines: LogLine[] = [];
      const result = await createPrismaAdapter({ logger: capturingLogger(lines) }).install(
        await plannedActions(fixture),
        contextFor({ project: fixture, readiness }),
      );

      expectNoDataLeak(
        [
          JSON.stringify(result),
          ...installStrings(result),
          ...lines.map((line) => `${line.message} ${JSON.stringify(line.fields)}`),
        ],
        [fixture, mapperOnly, driverOnly],
      );
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * readiness — a pure function of the facts the service observed
 * ---------------------------------------------------------------------------------------------- */

describe('readiness', () => {
  it('is ready with no rows for a project that does not use the mapper', async () => {
    for (const project of [driverOnly, databaseFree]) {
      const report = await createPrismaAdapter().readiness(contextFor({ project }));

      // "Not applicable" is expressed through the authored contract — a report
      // with no rows — rather than as a failure or a gap: an adapter that
      // claims nothing here cannot hold a capture back.
      expect(report).toEqual({
        ready: true,
        adapter: PRISMA_ADAPTER_ID,
        signals: [],
        checkedAt: NOW,
      });
      expect(readinessSchema.safeParse(report).success).toBe(true);
    }
  });

  it('reports every observed state with a row the schema accepts', async () => {
    const presets = preloadPresets(fixture);
    const expectations = [
      { readiness: presets.fresh, status: 'available', ready: true },
      { readiness: presets.neverReported, status: 'available', ready: true },
      { readiness: presets.stale, status: 'degraded', ready: true },
      { readiness: presets.notConnected, status: 'unavailable', ready: false },
      { readiness: presets.disconnected, status: 'unavailable', ready: false },
      { readiness: presets.otherProject, status: 'unavailable', ready: false },
    ] as const;

    for (const expectation of expectations) {
      const report = await createPrismaAdapter().readiness(
        contextFor({ project: fixture, readiness: expectation.readiness }),
      );

      expect(readinessSchema.safeParse(report).success).toBe(true);
      expect(report.adapter).toBe(PRISMA_ADAPTER_ID);
      expect(report.checkedAt).toBe(NOW);
      expect(report.signals).toHaveLength(1);
      expect(report.ready).toBe(expectation.ready);

      const [row] = report.signals;

      expect(row).toBeDefined();
      expect([...READINESS_STATUSES]).toContain(row?.status);
      expect(row?.status).toBe(expectation.status);
      expect(row?.signal).toBe(PRISMA_ADAPTER_ID);

      if (expectation.status === 'available') {
        // Omitted rather than present-and-undefined: the report is persisted
        // and transported as JSON, where an absent key is the one
        // representation every layer agrees on.
        expect(row?.reason).toBeUndefined();
        expect(row?.hint).toBeUndefined();
        expect(Object.keys(row ?? {}).sort()).toEqual(['signal', 'status']);

        continue;
      }

      expect((row?.reason ?? '').trim().length).toBeGreaterThan(0);
      expect((row?.hint ?? '').trim().length).toBeGreaterThan(0);
      expect(row?.hint).toContain(fixture.root);
    }
  });

  it('takes its timestamp from the session clock first, then its own', async () => {
    const optionClock = (): number => NOW - 500;
    const adapter = createPrismaAdapter({ now: optionClock });
    const readiness = preloadPresets(fixture).fresh;

    const sessionClocked = await adapter.readiness(
      contextFor({ project: fixture, readiness, now: frozenClock }),
    );
    const optionClocked = await adapter.readiness(
      contextFor({ project: fixture, readiness, withoutSessionClock: true }),
    );

    expect(sessionClocked.checkedAt).toBe(NOW);
    expect(optionClocked.checkedAt).toBe(NOW - 500);
  });

  it('is deterministic and serialisable', async () => {
    const context = contextFor({
      project: fixture,
      readiness: preloadPresets(fixture).notConnected,
    });
    const adapter = createPrismaAdapter();

    const first = await adapter.readiness(context);
    const second = await adapter.readiness(context);
    const roundTripped: unknown = JSON.parse(JSON.stringify(first));

    expect(second).toEqual(first);
    expect(roundTripped).toEqual(first);
  });

  it('probes nothing: the injected facts are the entire input', async () => {
    const presets = preloadPresets(fixture);

    // No socket, no port check, no database and no environment read — the
    // backup store throws on contact and the journal records every call, so
    // either would be visible here.
    for (const readiness of [presets.notConnected, presets.fresh, presets.stale]) {
      await expect(
        createPrismaAdapter().readiness(contextFor({ project: fixture, readiness })),
      ).resolves.toBeDefined();
    }

    expect(journalCalls).toEqual([]);
  });

  it('leaks nothing into the rows it reports', async () => {
    const presets = preloadPresets(fixture);

    for (const readiness of [presets.notConnected, presets.stale]) {
      const report = await createPrismaAdapter().readiness(
        contextFor({ project: fixture, readiness }),
      );

      expectNoDataLeak(
        report.signals.flatMap((row) => [row.signal, row.reason ?? '', row.hint ?? '']),
        [fixture, mapperOnly, driverOnly],
      );
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * remove — giving a runtime signal up
 * ---------------------------------------------------------------------------------------------- */

describe('remove', () => {
  it('has nothing to restore and nothing in conflict', async () => {
    const context = contextFor({ project: fixture });
    const result = await createPrismaAdapter().remove(
      { sessionId: SESSION_ID, reason: 'session-end' },
      context,
    );

    expect(result.adapterId).toBe(PRISMA_ADAPTER_ID);
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.runtimeHooksDisabled.length).toBeGreaterThan(0);
    expect(journalCalls).toEqual([]);
  });

  it('claims no detachment on a reconcile, where the process is already gone', async () => {
    const result = await createPrismaAdapter().remove(
      { sessionId: SESSION_ID, reason: 'reconcile' },
      contextFor({ project: fixture }),
    );

    expect(result.runtimeHooksDisabled).toEqual([]);
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('answers the same way with installed actions and with none', async () => {
    const context = contextFor({ project: fixture, readiness: preloadPresets(fixture).fresh });
    const adapter = createPrismaAdapter();
    const installed = await adapter.install(await plannedActions(fixture), context);

    expect(installed.applied).toEqual([]);

    const afterInstall = await adapter.remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, reason: 'session-end', records: [] },
      context,
    );
    const withoutInstall = await adapter.remove(
      { sessionId: SESSION_ID, reason: 'session-end' },
      context,
    );

    expect(afterInstall).toEqual(withoutInstall);
  });

  it('converges when called again', async () => {
    const context = contextFor({ project: fixture });
    const adapter = createPrismaAdapter();

    for (const reason of ['session-end', 'rollback', 'reconcile'] as const) {
      const first = await adapter.remove({ sessionId: SESSION_ID, reason }, context);
      const second = await adapter.remove({ sessionId: SESSION_ID, reason }, context);

      expect(second).toEqual(first);
    }
  });

  it('writes nothing and reaches for no process', async () => {
    const lines: LogLine[] = [];
    const adapter = createPrismaAdapter({ logger: capturingLogger(lines) });

    await adapter.remove(
      { sessionId: SESSION_ID, reason: 'rollback' },
      contextFor({ project: fixture }),
    );

    // The service is what actually turns the instrumentation off, by sending
    // `server-agent.config` with no capture: this adapter reports that the
    // signal is given up and touches nothing (AAP §0.5.1).
    expect(journalCalls).toEqual([]);
    expectNoDataLeak(
      lines.map((line) => `${line.message} ${JSON.stringify(line.fields)}`),
      [fixture, mapperOnly, driverOnly],
    );
  });

  it('leaks nothing into the hooks it reports disabling', async () => {
    const result = await createPrismaAdapter().remove(
      { sessionId: SESSION_ID, reason: 'session-end' },
      contextFor({ project: fixture }),
    );

    expectNoDataLeak(result.runtimeHooksDisabled, [fixture, mapperOnly, driverOnly]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The import boundary
 *
 * A static read of the adapter's own source. Everything above proves what the
 * adapter *does*; this group proves what it is *able* to do — an adapter that
 * imported the patch layer, the registry, its sibling, a driver package or a
 * Node builtin could write, could route itself, or could go looking for
 * evidence the service already holds, whatever its current code path happens to
 * do.
 * ---------------------------------------------------------------------------------------------- */

/** The only module specifiers `./prisma.ts` may import. */
const ALLOWED_SPECIFIERS: readonly string[] = [
  '../adapter.js',
  '../schema/plan.js',
  '../schema/readiness.js',
  '../schema/target.js',
  '@debuggen/code-analysis',
  '@debuggen/shared',
];

/** One thing the adapter may not reach for, with the shape that would show it. */
interface ForbiddenSourcePattern {
  /** What a match would mean. */
  readonly label: string;

  /** The shape to look for in the comment-free source. */
  readonly pattern: RegExp;
}

/** Everything a match of which would break this adapter's boundary. */
const FORBIDDEN_SOURCE_PATTERNS: readonly ForbiddenSourcePattern[] = [
  { label: 'the message layer above it', pattern: /@debuggen\/protocol/ },
  { label: 'the panel packages above it', pattern: /@debuggen\/panel-(?:schema|renderer)/ },
  { label: 'the registry that constructs it', pattern: /\.\.\/registry\.js/ },
  { label: 'the patch layer, the only writer of a working tree', pattern: /\.\.\/patch\// },
  { label: 'the cleanup module', pattern: /\.\.\/cleanup\.js/ },
  { label: 'its sibling adapter', pattern: /\.\/postgres\.js/ },
  {
    label: 'a database driver package',
    pattern: /(['"])(?:@prisma\/[^'"]+|pg|pg-pool|postgres)\1/,
  },
  { label: 'the environment', pattern: /\bprocess\s*\.\s*env\b/ },
  { label: 'the console', pattern: /\bconsole\s*\./ },
  { label: 'a Node builtin', pattern: /(['"])node:[^'"]*\1|\bnode:[a-z]/ },
];

/**
 * The adapter's source with its comments removed.
 *
 * Comments have to go before anything is matched: this module's prose
 * *discusses* the patch layer, the registry and its sibling by name, which is
 * exactly why it must not import them — and a guard that scanned the prose
 * would report the explanation as the violation.
 *
 * @returns The comment-free source.
 */
function adapterSourceWithoutComments(): string {
  return readFileSync(ADAPTER_SOURCE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the import boundary', () => {
  it('leaves code behind after the comments are stripped', () => {
    const stripped = adapterSourceWithoutComments();

    // Without this, a stripping accident would make every assertion below
    // pass against an empty string.
    expect(stripped).toContain('export function createPrismaAdapter');
    expect(stripped).toContain(`export const PRISMA_ADAPTER_ID = '${PRISMA_ADAPTER_ID}'`);
    expect(stripped).toContain('canHandle');
    expect(stripped).not.toContain('//');
  });

  it('imports exactly the six specifiers its layer allows', () => {
    const stripped = adapterSourceWithoutComments();
    const specifiers = new Set<string>();

    for (const pattern of [
      /\bfrom\s*(['"])([^'"]+)\1/g,
      /\bimport\s*(['"])([^'"]+)\1/g,
      /\bimport\s*\(\s*(['"])([^'"]+)\1/g,
      /\brequire\s*\(\s*(['"])([^'"]+)\1/g,
    ]) {
      for (const match of stripped.matchAll(pattern)) {
        const specifier = match[2];

        if (specifier !== undefined) {
          specifiers.add(specifier);
        }
      }
    }

    expect([...specifiers].sort()).toEqual([...ALLOWED_SPECIFIERS]);
  });

  it('carries a .js extension on every relative import', () => {
    const stripped = adapterSourceWithoutComments();

    for (const match of stripped.matchAll(/\bfrom\s*(['"])(\.[^'"]*)\1/g)) {
      const specifier = match[2] ?? '';

      // NodeNext resolution, which is what this package is type-checked and
      // run under: an extensionless relative specifier is a compile error and
      // an unresolvable import at runtime.
      expect(specifier, `relative import '${specifier}' must name a .js file`).toMatch(/\.js$/);
    }
  });

  it('reaches for nothing outside that boundary', () => {
    const stripped = adapterSourceWithoutComments();

    for (const { label, pattern } of FORBIDDEN_SOURCE_PATTERNS) {
      const match = pattern.exec(stripped);

      expect(
        match === null ? undefined : match[0],
        `./prisma.ts must not reach for ${label}`,
      ).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * No name of its own (AAP §0.5.4), and the logging boundary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The distinctive identifiers one corpus contributed.
 *
 * Owner symbols, model names and call texts, narrowed to the ones that could
 * only have come from a project: a name with an internal capital or a dotted
 * member access. A single lower-case word like an operation name is generic
 * vocabulary — `create` is a substring of `createPrismaAdapter` — and testing
 * for it would report this product's own English as a leak.
 *
 * @param project The indexed project.
 * @returns The distinctive names, in a stable order.
 */
function distinctiveNames(project: IndexedProject): readonly string[] {
  const names = new Set<string>();

  for (const call of project.graph.nodesByKind('db-call')) {
    for (const candidate of [call.name, call.symbol, call.data.model]) {
      if (candidate !== undefined && (/[a-z][A-Z]/.test(candidate) || candidate.includes('.'))) {
        names.add(candidate);
      }
    }
  }

  return [...names].sort();
}

describe('no name of its own', () => {
  it('names nothing from any corpus in its own source', () => {
    const stripped = adapterSourceWithoutComments();
    const names = [fixture, mapperOnly, driverOnly, manyOwners].flatMap((project) =>
      distinctiveNames(project),
    );

    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      // The file-local half of AAP §0.5.4: the repository-wide, AST-aware
      // guard is `scripts/check-no-hardcoding.mjs`, and this is the same rule
      // asserted where the adapter lives.
      expect(stripped, `./prisma.ts must not carry the project name '${name}'`).not.toContain(name);
    }
  });

  it('states only the names the graph gave it, on a corpus it has never seen', async () => {
    const actions = await plannedActions(mapperOnly);
    const permitted = new Set(mapperOwners(mapperOnly).map((owner) => owner.symbol));
    const foreign = [...distinctiveNames(fixture), ...distinctiveNames(driverOnly)];

    expect(actions.length).toBeGreaterThan(0);
    expect(foreign.length).toBeGreaterThan(0);

    for (const action of actions) {
      expect(permitted.has(action.symbol)).toBe(true);
      expect(action.rationale).toContain(action.symbol);
      expect(action.rationale).toContain(action.file);

      for (const name of foreign) {
        expect(
          action.rationale,
          `a rationale for one project must not name another's '${name}'`,
        ).not.toContain(name);
      }
    }
  });

  it('logs at debug only, through the injected logger, with its id bound', async () => {
    const lines: LogLine[] = [];
    const adapter = createPrismaAdapter({ logger: capturingLogger(lines) });
    const context = contextFor({ project: fixture, readiness: preloadPresets(fixture).fresh });

    const actions = await adapter.createPlan(context, databaseQuestion);

    await adapter.install(actions, context);
    await adapter.readiness(context);
    await adapter.remove({ sessionId: SESSION_ID, reason: 'session-end' }, context);

    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);

    for (const line of lines) {
      // Bound as a field rather than formatted into the message, so a log
      // query can filter on it.
      expect(line.fields['adapter']).toBe(PRISMA_ADAPTER_ID);
      expect(line.fields['sessionId']).toBe(SESSION_ID);
      expect(line.message.length).toBeGreaterThan(0);
    }

    expectNoDataLeak(
      lines.map((line) => `${line.message} ${JSON.stringify(line.fields)}`),
      [fixture, mapperOnly, driverOnly, manyOwners],
    );
  });

  it('writes to the session logger when no logger is injected', async () => {
    const lines: LogLine[] = [];
    const context = contextFor({ project: fixture, logger: capturingLogger(lines) });

    await createPrismaAdapter().createPlan(context, databaseQuestion);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.fields['adapter'] === PRISMA_ADAPTER_ID)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The corpus is left exactly as it was found
 * ---------------------------------------------------------------------------------------------- */

describe('the committed corpus', () => {
  it('is byte-for-byte as it was before the suite ran', () => {
    // Every case above has run by now. `applied` being empty is the adapter's
    // claim; this is the evidence for it, and it is also what keeps
    // `git status --porcelain packages/instrumentation/test/fixtures` clean
    // after `pnpm test` (AAP §0.5.1).
    expect(fixtureFootprint()).toEqual(fixtureFootprintBefore);
  });
});
