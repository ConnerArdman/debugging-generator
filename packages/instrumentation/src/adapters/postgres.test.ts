/**
 * The suite for `./postgres.ts`.
 *
 * It asserts the four things that make this adapter correct rather than merely
 * present:
 *
 * 1. **Detection is graph-only.** The scratch corpus below carries both
 *    recognised driver shapes — a query issued straight on a pool and a query
 *    issued on a client borrowed from one — in a single module, and a second
 *    module that reaches the database only through a generated client. The
 *    handles themselves are declared in a third module, exactly as a real
 *    project declares them, so nothing about a call site's own text identifies
 *    the driver: only `DbCallNodeData.driver` does, which is the discriminator
 *    AAP §0.5.4 requires.
 * 2. **Silence where there is nothing to say.** A project that never reaches
 *    the driver produces no proposal, no readiness row and — decisively — no
 *    "Postgres unavailable" report.
 * 3. **An actionable gap where there is one.** With driver call sites and no
 *    dev-server preload, the install reports one `UnavailableSignal` whose hint
 *    names the project to relaunch, and a preload that has gone quiet degrades
 *    rather than disappears.
 * 4. **Nothing about the data leaks.** No statement, no statement shape and no
 *    database handle name reaches a rationale, a reason, a hint or a hook name
 *    (AAP §0.5.2) — and no file is written, which the throwing journal and
 *    backup ports below prove by never being called.
 *
 * The corpus is built as a `CodeIndex` and loaded through `CodeGraph.fromIndex`
 * rather than indexed from a fixture tree on disk. The adapter's input contract
 * *is* the graph, the node and edge shapes here are the ones
 * `@debuggen/code-analysis`'s database extractor emits (a `db-call` node
 * positioned at the callee, carrying the enclosing owner's name as its
 * `symbol`, with a `queries` edge from that owner), and building them in memory
 * keeps the suite hermetic: it mutates no fixture, needs no `tsconfig` to load
 * and no PostgreSQL to run.
 */

import { noopLogger } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';
import {
  CODE_INDEX_SCHEMA_VERSION,
  CodeGraph,
  createCodeQueries,
  makeEdgeId,
  makeNodeId,
} from '@debuggen/code-analysis';
import type {
  CodeEdge,
  CodeEdgeKind,
  CodeIndex,
  CodeNode,
  DatabaseAccessStyle,
  DbDriver,
  PackageManagerName,
  ProjectSummary,
  RouteMap,
} from '@debuggen/code-analysis';
import { describe, expect, it } from 'vitest';

import type { InstrumentationContext, ObservedServerAgent, UnavailableSignal } from '../adapter.js';
import { ACTION_ID_PATTERN, instrumentationActionSchema } from '../schema/plan.js';
import type { InstrumentationAction } from '../schema/plan.js';
import { parseReadiness, readinessSignalSchema } from '../schema/readiness.js';
import type { ProblemUnderstanding } from '../schema/target.js';
import type { ModificationJournal } from '../schema/modification.js';
import type { BackupStore } from '../patch/backup-store.js';

import {
  POSTGRES_ADAPTER_CLAIMS,
  POSTGRES_ADAPTER_DEFAULTS,
  POSTGRES_ADAPTER_ID,
  POSTGRES_SERVER_SIGNAL_KEYS,
  createPostgresAdapter,
} from './postgres.js';

/* -------------------------------------------------------------------------------------------------
 * The scratch corpus
 * ---------------------------------------------------------------------------------------------- */

/** The project the scratch graph belongs to. */
const PROJECT_ROOT = '/scratch/kiln-studio';

/** Where the two database handles are constructed, as a real project declares them. */
const HANDLES_MODULE = 'src/server/store-handles.ts';

/** The module with the two driver call shapes. */
const DRIVER_MODULE = 'src/server/firing-log.ts';

/** The module that reaches the database only through the generated client. */
const CLIENT_MODULE = 'src/server/schedule-book.ts';

/** The route module that reaches the driver module. */
const ROUTE_MODULE = 'app/api/firing-log/route.ts';

/** The route path the route module answers. */
const ROUTE_PATH = '/api/firing-log';

/**
 * The statement shape the driver call sites carry.
 *
 * Deliberately recognisable: every string the adapter emits is asserted not to
 * contain it, which is how the privacy rule of AAP §0.5.2 is checked rather
 * than assumed.
 */
const STATEMENT_SHAPE = 'select ? from ? where ? = $1';

/** The handle name a driver call site is written against, which must also never leak. */
const DIRECT_CALL_NAME = 'firingPool.query';

/** The borrowed-connection call name, which must also never leak. */
const BORROWED_CALL_NAME = 'borrowedConnection.query';

/** The generated client's call name in the client-only module. */
const CLIENT_CALL_NAME = 'scheduleClient.firingCycle.findMany';

/** Every string that must never appear in anything the adapter emits. */
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  STATEMENT_SHAPE,
  'select',
  '$1',
  DIRECT_CALL_NAME,
  BORROWED_CALL_NAME,
  CLIENT_CALL_NAME,
];

/** Builds a `server-function` node the way the server-function extractor would. */
function serverFunctionNode(file: string, name: string, line: number): CodeNode {
  return {
    id: makeNodeId({ kind: 'server-function', file, name, line, column: 1 }),
    kind: 'server-function',
    name,
    file,
    line,
    column: 1,
    endLine: line + 6,
    exported: true,
    data: { isAsync: true, exported: true },
  };
}

/** Builds a module-level `symbol` node the way the symbol extractor would. */
function symbolNode(file: string, name: string, line: number): CodeNode {
  return {
    id: makeNodeId({ kind: 'symbol', file, name, line, column: 7 }),
    kind: 'symbol',
    name,
    file,
    line,
    column: 7,
    endLine: line + 4,
    exported: false,
    data: { declaration: 'function', isDefaultExport: false },
  };
}

/** Builds a `file` node, which is the owner cascade's last resort. */
function fileNode(file: string): CodeNode {
  return {
    id: makeNodeId({ kind: 'file', file, name: file, line: 1, column: 1 }),
    kind: 'file',
    name: file,
    file,
    line: 1,
    column: 1,
    data: { extension: '.ts', isClientModule: false, externalImports: [] },
  };
}

/** Builds an `api-route` node the way the route extractor would. */
function apiRouteNode(file: string, routePath: string, line: number): CodeNode {
  return {
    id: makeNodeId({ kind: 'api-route', file, name: routePath, line, column: 1 }),
    kind: 'api-route',
    name: routePath,
    file,
    line,
    column: 1,
    endLine: line + 10,
    exported: true,
    data: { routePath, router: 'app', kind: 'route-handler', methods: ['GET'] },
  };
}

/** Builds a `db-call` node the way the database extractor would. */
function dbCallNode(
  file: string,
  name: string,
  line: number,
  driver: DbDriver,
  owner?: string,
): CodeNode {
  return {
    id: makeNodeId({ kind: 'db-call', file, name, line, column: 9 }),
    kind: 'db-call',
    name,
    file,
    line,
    column: 9,
    endLine: line + 2,
    // Omitted rather than set to `undefined` when the owner cascade fell
    // through to the module, which is what the extractor does and what
    // `exactOptionalPropertyTypes` requires.
    ...(owner === undefined ? {} : { symbol: owner }),
    data: { driver, dynamic: false, statementShape: STATEMENT_SHAPE },
  };
}

/** Builds an edge with the identity the graph's own constructor would give it. */
function graphEdge(kind: CodeEdgeKind, from: CodeNode, to: CodeNode, line: number): CodeEdge {
  return {
    id: makeEdgeId({ kind, from: from.id, to: to.id, line, column: 9 }),
    kind,
    from: from.id,
    to: to.id,
    file: from.file,
    line,
    column: 9,
  };
}

/** Loads a graph from a set of nodes and edges. */
function loadGraph(nodes: readonly CodeNode[], edges: readonly CodeEdge[]): CodeGraph {
  const index: CodeIndex = {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: PROJECT_ROOT,
    indexerVersion: 'scratch',
    generatedAt: 1,
    nodes,
    edges,
    files: [],
  };

  return CodeGraph.fromIndex(index);
}

/** What one scratch graph exposes to a test beyond the graph itself. */
interface ScratchCorpus {
  readonly graph: CodeGraph;
  readonly directOwner: CodeNode;
  readonly borrowedOwner: CodeNode;
  readonly clientOwner: CodeNode;
  readonly route: CodeNode;
}

/**
 * The corpus: both driver shapes in one module, three client calls in another,
 * the handles in a third, and a route that reaches the first driver function.
 *
 * Two driver call sites and zero client calls in {@link DRIVER_MODULE}; three
 * client calls and zero driver calls in {@link CLIENT_MODULE} — which is why a
 * project like this reports a database access style of `'both'`, and why
 * filtering by driver rather than by module is the only correct discriminator.
 */
function buildCorpus(): ScratchCorpus {
  const handles = fileNode(HANDLES_MODULE);
  const driverModule = fileNode(DRIVER_MODULE);
  const clientModule = fileNode(CLIENT_MODULE);

  const directOwner = serverFunctionNode(DRIVER_MODULE, 'totalFiringMinutes', 12);
  const borrowedOwner = serverFunctionNode(DRIVER_MODULE, 'recordFiringSegments', 30);
  const clientOwner = serverFunctionNode(CLIENT_MODULE, 'listScheduledFirings', 8);
  const route = apiRouteNode(ROUTE_MODULE, ROUTE_PATH, 1);

  const directCall = dbCallNode(DRIVER_MODULE, DIRECT_CALL_NAME, 16, 'pg', directOwner.name);
  const borrowedCall = dbCallNode(DRIVER_MODULE, BORROWED_CALL_NAME, 36, 'pg', borrowedOwner.name);
  const clientCalls = [10, 14, 18].map((line) =>
    dbCallNode(CLIENT_MODULE, CLIENT_CALL_NAME, line, 'prisma', clientOwner.name),
  );

  const nodes: CodeNode[] = [
    handles,
    driverModule,
    clientModule,
    fileNode(ROUTE_MODULE),
    directOwner,
    borrowedOwner,
    clientOwner,
    route,
    directCall,
    borrowedCall,
    ...clientCalls,
  ];

  const edges: CodeEdge[] = [
    graphEdge('declares', driverModule, directOwner, 12),
    graphEdge('declares', driverModule, borrowedOwner, 30),
    graphEdge('declares', clientModule, clientOwner, 8),
    graphEdge('imports', driverModule, handles, 3),
    graphEdge('imports', clientModule, handles, 3),
    graphEdge('queries', directOwner, directCall, 16),
    graphEdge('queries', borrowedOwner, borrowedCall, 36),
    ...clientCalls.map((call, offset) => graphEdge('queries', clientOwner, call, 10 + offset * 4)),
    // The route reaches the LATER-declared driver function, so a test that
    // names the route can only win through reachability and never through the
    // declaration-order tie-break.
    graphEdge('calls', route, borrowedOwner, 6),
  ];

  return { graph: loadGraph(nodes, edges), directOwner, borrowedOwner, clientOwner, route };
}

/** A corpus that reaches the database only through the generated client. */
function buildClientOnlyCorpus(): CodeGraph {
  const clientModule = fileNode(CLIENT_MODULE);
  const clientOwner = serverFunctionNode(CLIENT_MODULE, 'listScheduledFirings', 8);
  const clientCalls = [10, 14, 18].map((line) =>
    dbCallNode(CLIENT_MODULE, CLIENT_CALL_NAME, line, 'prisma', clientOwner.name),
  );

  return loadGraph(
    [clientModule, clientOwner, ...clientCalls],
    [
      graphEdge('declares', clientModule, clientOwner, 8),
      ...clientCalls.map((call, offset) =>
        graphEdge('queries', clientOwner, call, 10 + offset * 4),
      ),
    ],
  );
}

/** A corpus with no database access at all. */
function buildDatabaselessCorpus(): CodeGraph {
  const module = fileNode(DRIVER_MODULE);
  const fn = serverFunctionNode(DRIVER_MODULE, 'totalFiringMinutes', 12);

  return loadGraph([module, fn], [graphEdge('declares', module, fn, 12)]);
}

/* -------------------------------------------------------------------------------------------------
 * The context
 * ---------------------------------------------------------------------------------------------- */

/**
 * A journal that fails the test if it is ever reached.
 *
 * This adapter installs a runtime signal: it journals nothing, because nothing
 * was written. A call here would be a modification record for a file that was
 * never touched.
 */
const forbiddenJournal: ModificationJournal = {
  append: () => {
    throw new Error('the driver adapter must never journal a modification');
  },
  updateStatus: () => {
    throw new Error('the driver adapter must never update a modification');
  },
  listBySession: () => {
    throw new Error('the driver adapter must never read the journal');
  },
  listOpen: () => {
    throw new Error('the driver adapter must never read the journal');
  },
};

/** A backup store that fails the test if it is ever reached. */
const forbiddenBackups: BackupStore = {
  sessionId: 'ses_scratchsession01',
  sessionDirectory: '/scratch/debuggen-home/backups/ses_scratchsession01',
  locate: () => {
    throw new Error('the driver adapter must never locate a backup');
  },
  put: () => {
    throw new Error('the driver adapter must never write a backup');
  },
  read: () => {
    throw new Error('the driver adapter must never read a backup');
  },
  has: () => {
    throw new Error('the driver adapter must never query a backup');
  },
  verify: () => {
    throw new Error('the driver adapter must never verify a backup');
  },
  remove: () => {
    throw new Error('the driver adapter must never remove a backup');
  },
  removeSessionDirectory: () => {
    throw new Error('the driver adapter must never remove a backup directory');
  },
};

/** An empty route map: this adapter resolves routes through the query surface. */
const emptyRouteMap: RouteMap = { entries: [], resolve: () => undefined };

/** Builds a project summary for a database access style and package manager. */
function scratchSummary(
  style: DatabaseAccessStyle,
  packageManager: PackageManagerName = 'pnpm',
): ProjectSummary {
  return {
    projectRoot: PROJECT_ROOT,
    projectName: 'kiln-studio',
    framework: { name: 'next' },
    routerStyle: 'app',
    typescript: { enabled: true },
    packageManager,
    databaseAccess: { style, callSiteCount: style === 'none' ? 0 : 5 },
    entryPoints: [],
    routes: [],
    notableDirectories: [],
    dependencies: [],
    counts: {
      files: 4,
      symbols: 4,
      components: 0,
      handlers: 0,
      apiCalls: 0,
      apiRoutes: 1,
      serverFunctions: 3,
      dbCalls: 5,
    },
    truncated: false,
    generatedAt: 1,
  };
}

/** What a test varies about the context. */
interface ScratchContextInput {
  readonly graph: CodeGraph;
  readonly summary: ProjectSummary;
  readonly projectRoot?: string;
  readonly serverAgent?: ObservedServerAgent;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/** Builds an instrumentation context around a scratch graph. */
function scratchContext(input: ScratchContextInput): InstrumentationContext {
  return {
    sessionId: 'ses_scratchsession01',
    projectRoot: input.projectRoot ?? PROJECT_ROOT,
    planVersion: 1,
    debuggenHome: '/scratch/debuggen-home',
    logger: input.logger ?? noopLogger,
    graph: input.graph,
    queries: createCodeQueries(input.graph),
    routeMap: emptyRouteMap,
    projectSummary: input.summary,
    journal: forbiddenJournal,
    backups: forbiddenBackups,
    readiness: input.serverAgent === undefined ? {} : { serverAgent: input.serverAgent },
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/** A fixed moment, so every clock-dependent assertion is exact. */
const NOW = 1_700_000_000_000;

/** A clock frozen at {@link NOW}. */
const frozenClock = (): number => NOW;

/** A preload attached to this project and heard from a moment ago. */
const attachedPreload: ObservedServerAgent = {
  connected: true,
  projectRoot: PROJECT_ROOT,
  lastHeartbeatAt: NOW - 1_000,
};

/** A preload attached to this project that has gone quiet. */
const silentPreload: ObservedServerAgent = {
  connected: true,
  projectRoot: PROJECT_ROOT,
  lastHeartbeatAt: NOW - (POSTGRES_ADAPTER_DEFAULTS.heartbeatStalenessMs + 5_000),
};

/** Builds a problem understanding. */
function understandingFor(
  signalsNeeded: ProblemUnderstanding['signalsNeeded'],
  entities: ProblemUnderstanding['entities'] = [],
  searchHints: readonly string[] = [],
): ProblemUnderstanding {
  return {
    category: 'performance',
    signalsNeeded,
    entities: [...entities],
    searchHints: [...searchHints],
  };
}

/** The understanding a latency question that names the database produces. */
const databaseQuestion = understandingFor(['interactions', 'fetch', 'http', 'pg']);

/** The understanding a purely browser-side question produces. */
const renderQuestion = understandingFor(['react', 'state']);

/** Every string one adapter call put in front of a developer. */
function emittedStrings(values: readonly string[]): readonly string[] {
  return values.filter((value) => value.length > 0);
}

/** Asserts that no emitted string carries a statement, a shape or a handle name. */
function expectNoDataLeak(values: readonly string[]): void {
  for (const value of emittedStrings(values)) {
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(value.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  }
}

/** Flattens an unavailable report into its strings. */
function gapStrings(unavailable: readonly UnavailableSignal[]): string[] {
  return unavailable.flatMap((entry) => [String(entry.signal), entry.reason, entry.hint]);
}

/** Strips the fresh ids so two proposals can be compared for equality. */
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
 * Identity and claims
 * ---------------------------------------------------------------------------------------------- */

describe('the driver adapter identity', () => {
  it('registers under the id its file is named for', () => {
    expect(POSTGRES_ADAPTER_ID).toBe('postgres');
    expect(createPostgresAdapter().id).toBe(POSTGRES_ADAPTER_ID);
  });

  it('claims exactly one action type, in runtime mode', () => {
    expect(POSTGRES_ADAPTER_CLAIMS).toEqual([{ type: 'db-query-tracking', mode: 'runtime' }]);
    expect(createPostgresAdapter().claims).toBe(POSTGRES_ADAPTER_CLAIMS);
    expect(Object.isFrozen(POSTGRES_ADAPTER_CLAIMS)).toBe(true);
  });

  it('contributes exactly the driver signal key', () => {
    expect(POSTGRES_SERVER_SIGNAL_KEYS).toEqual(['pg']);
    expect(Object.isFrozen(POSTGRES_SERVER_SIGNAL_KEYS)).toBe(true);
  });

  it('publishes frozen defaults', () => {
    expect(Object.isFrozen(POSTGRES_ADAPTER_DEFAULTS)).toBe(true);
    expect(POSTGRES_ADAPTER_DEFAULTS.maxTargets).toBeGreaterThan(0);
    expect(POSTGRES_ADAPTER_DEFAULTS.maxTargets).toBeLessThanOrEqual(
      POSTGRES_ADAPTER_DEFAULTS.maxTargetsCeiling,
    );
    expect(POSTGRES_ADAPTER_DEFAULTS.heartbeatStalenessMs).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * canHandle
 * ---------------------------------------------------------------------------------------------- */

describe('canHandle', () => {
  it('claims a project whose graph carries driver call sites, in both shapes', () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    expect(createPostgresAdapter().canHandle(context)).toBe(true);

    // Both shapes are present and indistinguishable to this adapter, which is
    // the point: the graph reports one driver for a pool query and for a query
    // on a connection borrowed from that pool.
    const driverCalls = corpus.graph
      .nodesByKind('db-call')
      .filter((node) => node.data.driver === 'pg');

    expect(driverCalls).toHaveLength(2);
    expect(new Set(driverCalls.map((node) => node.symbol))).toEqual(
      new Set([corpus.directOwner.name, corpus.borrowedOwner.name]),
    );
  });

  it('declines a project that reaches the database only through a generated client', () => {
    const context = scratchContext({
      graph: buildClientOnlyCorpus(),
      summary: scratchSummary('prisma'),
    });

    expect(createPostgresAdapter().canHandle(context)).toBe(false);
  });

  it('declines a project with no database access at all', () => {
    const context = scratchContext({
      graph: buildDatabaselessCorpus(),
      summary: scratchSummary('none'),
    });

    expect(createPostgresAdapter().canHandle(context)).toBe(false);
  });

  it('accepts the summary as corroboration when the graph was handed over narrowed', () => {
    const adapter = createPostgresAdapter();
    const narrowed = buildDatabaselessCorpus();

    expect(
      adapter.canHandle(scratchContext({ graph: narrowed, summary: scratchSummary('pg') })),
    ).toBe(true);
    expect(
      adapter.canHandle(scratchContext({ graph: narrowed, summary: scratchSummary('both') })),
    ).toBe(true);
  });

  it('answers the same way twice and reaches no port', () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });
    const adapter = createPostgresAdapter();

    expect(adapter.canHandle(context)).toBe(adapter.canHandle(context));
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan
 * ---------------------------------------------------------------------------------------------- */

describe('createPlan', () => {
  it('anchors on the functions the graph says reach the driver, in both shapes', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    const actions = await createPostgresAdapter().createPlan(context, databaseQuestion);

    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.symbol).sort()).toEqual(
      [corpus.directOwner.name, corpus.borrowedOwner.name].sort(),
    );

    for (const action of actions) {
      expect(action.adapter).toBe(POSTGRES_ADAPTER_ID);
      expect(action.type).toBe('db-query-tracking');
      expect(action.mode).toBe('runtime');
      expect(action.file).toBe(DRIVER_MODULE);
      expect(action.id).toMatch(ACTION_ID_PATTERN);
      expect(instrumentationActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('never proposes the client-only function as a driver target', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    const actions = await createPostgresAdapter().createPlan(context, databaseQuestion);

    expect(actions.map((action) => action.symbol)).not.toContain(corpus.clientOwner.name);
    expect(actions.map((action) => action.file)).not.toContain(CLIENT_MODULE);
  });

  it('proposes nothing for a project that does not use the driver', async () => {
    const context = scratchContext({
      graph: buildClientOnlyCorpus(),
      summary: scratchSummary('prisma'),
    });

    await expect(createPostgresAdapter().createPlan(context, databaseQuestion)).resolves.toEqual(
      [],
    );
  });

  it('proposes nothing for a question about the page', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    await expect(createPostgresAdapter().createPlan(context, renderQuestion)).resolves.toEqual([]);
  });

  it('proposes for a question that asks only for server-tier evidence', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    const actions = await createPostgresAdapter().createPlan(
      context,
      understandingFor(['interactions', 'http', 'routeHandlers']),
    );

    expect(actions.length).toBeGreaterThan(0);
  });

  it('proposes nothing when the graph records no addressable owner', async () => {
    // The owner cascade's last resort: a query written outside every
    // declaration, whose `queries` edge starts at the module's own file node.
    const module = fileNode(DRIVER_MODULE);
    const orphan = dbCallNode(DRIVER_MODULE, DIRECT_CALL_NAME, 4, 'pg');
    const graph = loadGraph([module, orphan], [graphEdge('queries', module, orphan, 4)]);
    const context = scratchContext({ graph, summary: scratchSummary('pg') });

    await expect(createPostgresAdapter().createPlan(context, databaseQuestion)).resolves.toEqual(
      [],
    );
  });

  it('skips an owner whose symbol the graph cannot resolve', async () => {
    // A `queries` edge from a declaration the graph holds no addressable node
    // for: the type alias is a declaration `hasSymbol` refuses, so the anchor
    // would be rejected by the feasibility gate and is never proposed.
    const module = fileNode(DRIVER_MODULE);
    const unaddressable: CodeNode = {
      id: makeNodeId({
        kind: 'symbol',
        file: DRIVER_MODULE,
        name: 'FiringRow',
        line: 5,
        column: 6,
      }),
      kind: 'symbol',
      name: 'FiringRow',
      file: DRIVER_MODULE,
      line: 5,
      column: 6,
      data: { declaration: 'type', isDefaultExport: false },
    };
    const call = dbCallNode(DRIVER_MODULE, DIRECT_CALL_NAME, 7, 'pg', 'FiringRow');
    const graph = loadGraph(
      [module, unaddressable, call],
      [graphEdge('queries', unaddressable, call, 7)],
    );
    const context = scratchContext({ graph, summary: scratchSummary('pg') });

    await expect(createPostgresAdapter().createPlan(context, databaseQuestion)).resolves.toEqual(
      [],
    );
  });

  it('anchors on a non-exported function when that is what encloses the query', async () => {
    // The extractor's owner cascade attributes a query inside a module-level
    // function that does not leave its module to a `symbol` node rather than a
    // `server-function` node. Both are legal origins of a `queries` edge and
    // both name a declaration `hasSymbol` finds, so both are anchorable.
    const module = fileNode(DRIVER_MODULE);
    const owner = symbolNode(DRIVER_MODULE, 'sumFiringMinutes', 20);
    const call = dbCallNode(DRIVER_MODULE, DIRECT_CALL_NAME, 24, 'pg', owner.name);
    const graph = loadGraph(
      [module, owner, call],
      [graphEdge('declares', module, owner, 20), graphEdge('queries', owner, call, 24)],
    );
    const context = scratchContext({ graph, summary: scratchSummary('pg') });

    const actions = await createPostgresAdapter().createPlan(context, databaseQuestion);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.symbol).toBe(owner.name);
    expect(actions[0]?.file).toBe(DRIVER_MODULE);
  });

  it('caps the anchor set at the configured maximum', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    const actions = await createPostgresAdapter({ maxTargets: 1 }).createPlan(
      context,
      databaseQuestion,
    );

    expect(actions).toHaveLength(1);
  });

  it('ignores an unusable maximum in favour of the shipped default', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    for (const maxTargets of [0, -3, 1.5, Number.NaN]) {
      const actions = await createPostgresAdapter({ maxTargets }).createPlan(
        context,
        databaseQuestion,
      );

      expect(actions).toHaveLength(2);
    }
  });

  it('produces an identical proposal on a second run, apart from fresh ids', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });
    const adapter = createPostgresAdapter();

    const first = await adapter.createPlan(context, databaseQuestion);
    const second = await adapter.createPlan(context, databaseQuestion);

    expect(withoutIds(second)).toEqual(withoutIds(first));
    expect(second.map((action) => action.id)).not.toEqual(first.map((action) => action.id));
  });

  it('ranks a function the question named ahead of one it did not', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    // Without evidence, the two owners are ordered by declaration line, so the
    // first-declared one wins.
    const unnarrowed = await createPostgresAdapter({ maxTargets: 1 }).createPlan(
      context,
      databaseQuestion,
    );

    expect(unnarrowed[0]?.symbol).toBe(corpus.directOwner.name);

    // Naming the later-declared function promotes it above the earlier one.
    const named = await createPostgresAdapter({ maxTargets: 1 }).createPlan(
      context,
      understandingFor(
        ['pg'],
        [{ kind: 'function', name: corpus.borrowedOwner.name, file: DRIVER_MODULE }],
      ),
    );

    expect(named[0]?.symbol).toBe(corpus.borrowedOwner.name);
  });

  it('promotes a function reachable from the route the question named', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });
    const adapter = createPostgresAdapter({ maxTargets: 1 });

    // Declaration order alone would pick the earlier-declared function, and it
    // does when nothing narrows the candidates.
    const unnarrowed = await adapter.createPlan(context, understandingFor(['pg']));

    expect(unnarrowed[0]?.symbol).toBe(corpus.directOwner.name);

    // Naming the route the graph says reaches the other function promotes it
    // past that tie-break.
    const narrowed = await adapter.createPlan(
      context,
      understandingFor(['pg'], [{ kind: 'route', name: ROUTE_PATH }], [ROUTE_PATH]),
    );

    expect(narrowed[0]?.symbol).toBe(corpus.borrowedOwner.name);
  });

  it('proposes nothing once the session has been aborted', async () => {
    const corpus = buildCorpus();
    const controller = new AbortController();

    controller.abort();

    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      signal: controller.signal,
    });

    await expect(createPostgresAdapter().createPlan(context, databaseQuestion)).resolves.toEqual(
      [],
    );
  });

  it('states why each anchor is there without naming a statement or a handle', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    const actions = await createPostgresAdapter().createPlan(context, databaseQuestion);

    for (const action of actions) {
      expect(action.rationale.trim().length).toBeGreaterThan(0);
      expect(action.rationale.length).toBeLessThanOrEqual(500);
      expect(action.rationale).not.toContain('\n');
    }

    expectNoDataLeak(actions.flatMap((action) => [action.rationale, action.symbol, action.file]));
  });
});

/* -------------------------------------------------------------------------------------------------
 * install
 * ---------------------------------------------------------------------------------------------- */

/** One driver action, as a normalised plan would carry it. */
function driverAction(symbol: string, file: string = DRIVER_MODULE): InstrumentationAction {
  return {
    id: 'act_scratchaction0001',
    file,
    symbol,
    type: 'db-query-tracking',
    adapter: POSTGRES_ADAPTER_ID,
    mode: 'runtime',
    rationale: 'A scratch action for the suite.',
  };
}

describe('install', () => {
  it('writes nothing, whatever the dev server looks like', async () => {
    const corpus = buildCorpus();

    for (const serverAgent of [undefined, attachedPreload, silentPreload]) {
      const context = scratchContext({
        graph: corpus.graph,
        summary: scratchSummary('both'),
        now: frozenClock,
        ...(serverAgent === undefined ? {} : { serverAgent }),
      });

      const result = await createPostgresAdapter().install(
        [driverAction(corpus.directOwner.name)],
        context,
      );

      expect(result.adapterId).toBe(POSTGRES_ADAPTER_ID);
      expect(result.applied).toEqual([]);
      expect(result.agentHooks).toBeUndefined();
    }
  });

  it('arms the signal and reports no gap when the preload is attached', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: attachedPreload,
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install(
      [driverAction(corpus.directOwner.name), driverAction(corpus.borrowedOwner.name)],
      context,
    );

    expect(result.unavailable).toEqual([]);
    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect(result.serverSignals).toEqual({ pg: true });
  });

  it('reports one actionable gap naming the project when no preload is attached', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install(
      [driverAction(corpus.directOwner.name)],
      context,
    );

    expect(result.unavailable).toHaveLength(1);

    const [gap] = result.unavailable;

    expect(gap?.signal).toBe('pg');
    expect(gap?.reason.trim().length).toBeGreaterThan(0);
    expect(gap?.hint.trim().length).toBeGreaterThan(0);
    expect(gap?.hint).toContain(PROJECT_ROOT);
    expect(gap?.hint).toContain(POSTGRES_ADAPTER_DEFAULTS.preloadSpecifier);

    // Nothing is armed, because there is no process holding it - but the signal
    // is still requested, so a preload that attaches later is configured for it.
    expect(result.runtimeHooks).toEqual([]);
    expect(result.serverSignals).toEqual({ pg: true });

    // Both strings are renderable as a readiness row, which is where the same
    // words are shown.
    expect(
      readinessSignalSchema.safeParse({
        signal: gap?.signal,
        status: 'unavailable',
        reason: gap?.reason,
        hint: gap?.hint,
      }).success,
    ).toBe(true);
  });

  it('treats a preload attached to another project as no preload at all', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: {
        connected: true,
        projectRoot: '/scratch/another-project',
        lastHeartbeatAt: NOW,
      },
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install(
      [driverAction(corpus.directOwner.name)],
      context,
    );

    expect(result.unavailable).toHaveLength(1);
    expect(result.runtimeHooks).toEqual([]);
  });

  it('treats a connection that has gone as no preload at all', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: { connected: false, projectRoot: PROJECT_ROOT, lastHeartbeatAt: NOW },
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install(
      [driverAction(corpus.directOwner.name)],
      context,
    );

    expect(result.unavailable).toHaveLength(1);
  });

  it('degrades rather than disappears when the preload has stopped reporting', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: silentPreload,
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install(
      [driverAction(corpus.directOwner.name)],
      context,
    );

    expect(result.unavailable).toHaveLength(1);
    expect(result.unavailable[0]?.hint).toContain(PROJECT_ROOT);

    // The connection is up, so the hook is armed and the limitation is stated
    // beside it rather than instead of it.
    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect(result.serverSignals).toEqual({ pg: true });
  });

  it('degrades a preload that is connected but has never reported', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: { connected: true, projectRoot: PROJECT_ROOT },
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install(
      [driverAction(corpus.directOwner.name)],
      context,
    );

    expect(result.unavailable).toHaveLength(1);
    expect(result.runtimeHooks.length).toBeGreaterThan(0);
  });

  it('honours a configured staleness window', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: { connected: true, projectRoot: PROJECT_ROOT, lastHeartbeatAt: NOW - 5_000 },
      now: frozenClock,
    });

    const tolerant = await createPostgresAdapter({ heartbeatStalenessMs: 60_000 }).install(
      [driverAction(corpus.directOwner.name)],
      context,
    );
    const strict = await createPostgresAdapter({ heartbeatStalenessMs: 1_000 }).install(
      [driverAction(corpus.directOwner.name)],
      context,
    );

    expect(tolerant.unavailable).toEqual([]);
    expect(strict.unavailable).toHaveLength(1);
  });

  it('prefers an injected relaunch command over a composed one', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      now: frozenClock,
    });

    const result = await createPostgresAdapter({
      relaunch: { command: 'scratch-launcher --with-preload' },
    }).install([driverAction(corpus.directOwner.name)], context);

    expect(result.unavailable[0]?.hint).toContain('scratch-launcher --with-preload');
    expect(result.unavailable[0]?.hint).toContain(PROJECT_ROOT);
  });

  it('names the editor command when the project manager could not be identified', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both', 'unknown'),
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install(
      [driverAction(corpus.directOwner.name)],
      context,
    );

    expect(result.unavailable[0]?.hint).toContain(POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle);
    expect(result.unavailable[0]?.hint).toContain(PROJECT_ROOT);
  });

  it('composes the hint from the project own package manager when it is known', async () => {
    const corpus = buildCorpus();
    const expectations: readonly [PackageManagerName, string][] = [
      ['pnpm', 'pnpm dev'],
      ['npm', 'npm run dev'],
      ['yarn', 'yarn dev'],
      ['bun', 'bun run dev'],
    ];

    for (const [packageManager, fragment] of expectations) {
      const context = scratchContext({
        graph: corpus.graph,
        summary: scratchSummary('both', packageManager),
        now: frozenClock,
      });

      const result = await createPostgresAdapter().install(
        [driverAction(corpus.directOwner.name)],
        context,
      );

      expect(result.unavailable[0]?.hint).toContain(fragment);
    }
  });

  it('stays silent when nothing of its kind was asked for', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install([], context);

    expect(result.unavailable).toEqual([]);
    expect(result.runtimeHooks).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.serverSignals).toBeUndefined();
  });

  it('stays silent for a project that never uses the driver', async () => {
    const context = scratchContext({
      graph: buildClientOnlyCorpus(),
      summary: scratchSummary('prisma'),
      now: frozenClock,
    });

    const result = await createPostgresAdapter().install([], context);

    expect(result.unavailable).toEqual([]);
    expect(result.runtimeHooks).toEqual([]);
  });

  it('ignores an action belonging to another adapter or another type', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: attachedPreload,
      now: frozenClock,
    });

    const foreign: InstrumentationAction[] = [
      { ...driverAction(corpus.clientOwner.name, CLIENT_MODULE), adapter: 'prisma' },
      {
        ...driverAction(corpus.directOwner.name),
        type: 'function-timing',
        mode: 'patch',
      },
    ];

    const result = await createPostgresAdapter().install(foreign, context);

    expect(result.unavailable).toEqual([]);
    expect(result.runtimeHooks).toEqual([]);
    expect(result.serverSignals).toBeUndefined();
  });

  it('reports hooks deterministically', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: attachedPreload,
      now: frozenClock,
    });
    const adapter = createPostgresAdapter();

    const first = await adapter.install([driverAction(corpus.directOwner.name)], context);
    const second = await adapter.install(
      [driverAction(corpus.borrowedOwner.name), driverAction(corpus.directOwner.name)],
      context,
    );

    expect(second.runtimeHooks).toEqual(first.runtimeHooks);
    expect([...first.runtimeHooks].sort()).toEqual(first.runtimeHooks);
    expect(new Set(first.runtimeHooks).size).toBe(first.runtimeHooks.length);
  });

  it('leaks no statement, shape or handle name into anything it reports', async () => {
    const corpus = buildCorpus();

    for (const serverAgent of [undefined, attachedPreload, silentPreload]) {
      const context = scratchContext({
        graph: corpus.graph,
        summary: scratchSummary('both'),
        now: frozenClock,
        ...(serverAgent === undefined ? {} : { serverAgent }),
      });

      const result = await createPostgresAdapter().install(
        [driverAction(corpus.directOwner.name)],
        context,
      );

      expectNoDataLeak([...result.runtimeHooks, ...gapStrings(result.unavailable)]);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * readiness
 * ---------------------------------------------------------------------------------------------- */

describe('readiness', () => {
  it('is ready with no rows for a project that does not use the driver', async () => {
    const context = scratchContext({
      graph: buildClientOnlyCorpus(),
      summary: scratchSummary('prisma'),
      now: frozenClock,
    });

    const report = await createPostgresAdapter().readiness(context);

    expect(report).toEqual({
      ready: true,
      adapter: POSTGRES_ADAPTER_ID,
      signals: [],
      checkedAt: NOW,
    });
    expect(parseReadiness(report).ok).toBe(true);
  });

  it('reports the signal available when the preload is attached', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: attachedPreload,
      now: frozenClock,
    });

    const report = await createPostgresAdapter().readiness(context);

    expect(report.ready).toBe(true);
    expect(report.signals).toEqual([{ signal: 'pg', status: 'available' }]);
    expect(parseReadiness(report).ok).toBe(true);
  });

  it('reports the signal degraded, and still ready, when the preload is quiet', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      serverAgent: silentPreload,
      now: frozenClock,
    });

    const report = await createPostgresAdapter().readiness(context);

    expect(report.ready).toBe(true);
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]?.status).toBe('degraded');
    expect(report.signals[0]?.reason).toBeDefined();
    expect(report.signals[0]?.hint).toContain(PROJECT_ROOT);
    expect(parseReadiness(report).ok).toBe(true);
  });

  it('holds a capture back when no preload is attached', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      now: frozenClock,
    });

    const report = await createPostgresAdapter().readiness(context);

    expect(report.ready).toBe(false);
    expect(report.signals[0]?.status).toBe('unavailable');
    expect(report.signals[0]?.reason).toBeDefined();
    expect(report.signals[0]?.hint).toContain(PROJECT_ROOT);
    expect(parseReadiness(report).ok).toBe(true);
  });

  it('takes its timestamp from the injected clock, the session first', async () => {
    const corpus = buildCorpus();
    const optionClock = (): number => NOW - 500;
    const adapter = createPostgresAdapter({ now: optionClock });

    const sessionClocked = await adapter.readiness(
      scratchContext({
        graph: corpus.graph,
        summary: scratchSummary('both'),
        serverAgent: attachedPreload,
        now: frozenClock,
      }),
    );
    const optionClocked = await adapter.readiness(
      scratchContext({
        graph: corpus.graph,
        summary: scratchSummary('both'),
        serverAgent: attachedPreload,
      }),
    );

    expect(sessionClocked.checkedAt).toBe(NOW);
    expect(optionClocked.checkedAt).toBe(NOW - 500);
  });

  it('is deterministic and leaks nothing', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      now: frozenClock,
    });
    const adapter = createPostgresAdapter();

    const first = await adapter.readiness(context);
    const second = await adapter.readiness(context);

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expectNoDataLeak(
      first.signals.flatMap((row) => [row.signal, row.reason ?? '', row.hint ?? '']),
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * remove
 * ---------------------------------------------------------------------------------------------- */

describe('remove', () => {
  it('has nothing to restore and nothing in conflict', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    const result = await createPostgresAdapter().remove(
      { sessionId: context.sessionId, reason: 'session-end' },
      context,
    );

    expect(result.adapterId).toBe(POSTGRES_ADAPTER_ID);
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.runtimeHooksDisabled.length).toBeGreaterThan(0);
  });

  it('claims no detachment on a reconcile, where the process is already gone', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    const result = await createPostgresAdapter().remove(
      { sessionId: context.sessionId, reason: 'reconcile' },
      context,
    );

    expect(result.runtimeHooksDisabled).toEqual([]);
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('converges when called again', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });
    const adapter = createPostgresAdapter();

    for (const reason of ['session-end', 'rollback', 'reconcile'] as const) {
      const first = await adapter.remove({ sessionId: context.sessionId, reason }, context);
      const second = await adapter.remove({ sessionId: context.sessionId, reason }, context);

      expect(second).toEqual(first);
    }
  });

  it('leaks nothing into the hooks it reports disabling', async () => {
    const corpus = buildCorpus();
    const context = scratchContext({ graph: corpus.graph, summary: scratchSummary('both') });

    const result = await createPostgresAdapter().remove(
      { sessionId: context.sessionId, planVersion: 2, reason: 'rollback' },
      context,
    );

    expectNoDataLeak(result.runtimeHooksDisabled);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The logging boundary
 * ---------------------------------------------------------------------------------------------- */

describe('logging', () => {
  it('logs at debug through the injected logger, with no statement in any field', async () => {
    const records: { readonly message: string; readonly fields: Record<string, unknown> }[] = [];
    const levels = new Set<string>();

    const capture = (bindings: Record<string, unknown>): Logger => ({
      level: 'debug',
      trace: (message, fields) => {
        levels.add('trace');
        records.push({ message, fields: { ...bindings, ...fields } });
      },
      debug: (message, fields) => {
        levels.add('debug');
        records.push({ message, fields: { ...bindings, ...fields } });
      },
      info: (message, fields) => {
        levels.add('info');
        records.push({ message, fields: { ...bindings, ...fields } });
      },
      warn: (message, fields) => {
        levels.add('warn');
        records.push({ message, fields: { ...bindings, ...fields } });
      },
      error: (message, fields) => {
        levels.add('error');
        records.push({ message, fields: { ...bindings, ...fields } });
      },
      fatal: (message, fields) => {
        levels.add('fatal');
        records.push({ message, fields: { ...bindings, ...fields } });
      },
      child: (nested) => capture({ ...bindings, ...nested }),
    });

    const corpus = buildCorpus();
    const adapter = createPostgresAdapter({ logger: capture({}) });
    const context = scratchContext({
      graph: corpus.graph,
      summary: scratchSummary('both'),
      now: frozenClock,
    });

    const actions = await adapter.createPlan(context, databaseQuestion);
    await adapter.install(actions, context);
    await adapter.remove({ sessionId: context.sessionId, reason: 'session-end' }, context);

    expect(records.length).toBeGreaterThan(0);
    expect([...levels]).toEqual(['debug']);

    for (const record of records) {
      expect(record.fields['adapter']).toBe(POSTGRES_ADAPTER_ID);
      expectNoDataLeak([
        record.message,
        ...Object.values(record.fields).map((value) =>
          typeof value === 'string' ? value : String(value),
        ),
      ]);
    }
  });
});
