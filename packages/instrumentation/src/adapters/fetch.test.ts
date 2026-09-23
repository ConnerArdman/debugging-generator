/**
 * The suite for `./fetch.ts` — the adapter that claims the browser's request
 * signal, and the one place in the product where URLs *are* the evidence.
 *
 * That last fact is why this file exists and what shapes every group in it.
 * Five claims are what make the adapter correct rather than merely present:
 *
 * 1. **Every initiator comes from an `api-call` graph node.** A request target
 *    is known because the call-site extractor of `@debuggen/code-analysis`
 *    recorded a call, never because a path was recognised (AAP §0.5.4). No
 *    route path, method or symbol below is written as an expectation: each one
 *    is read off the graph a case indexed, which is why the scratch corpora
 *    carry deliberately meaningless identifiers this product has never seen.
 * 2. **Every action is anchored on the initiator's owner symbol** — the
 *    declaration the graph's `calls` edge starts at — and never on the call
 *    expression, on a synthesised name or on the surrounding component. The
 *    expected owner is resolved *through the graph* in every case, so an
 *    assertion cannot agree with the adapter by both restating the same
 *    literal.
 * 3. **Nothing is written.** This signal is installed inside the page by
 *    `packages/telemetry/src/browser/fetch.ts` when the service sends
 *    `agent.config`, so `InstallResult.applied` is always empty (AAP §0.5.1).
 *    Every context here carries a backup store that throws on contact and a
 *    journal that records every call, so "wrote nothing" is asserted rather
 *    than assumed — and the state root the context names is never created.
 * 4. **Readiness is a statement about injected evidence.** The only input is
 *    `context.readiness.browserAgent`, the relayed `agent.ready` fact for the
 *    bound tab (AAP §0.5.5). No port is probed, no environment read, and a
 *    missing agent is reported as data on a call that still resolves.
 * 5. **The adapter's own source carries no URL, path or route literal.** This
 *    is the check this file owes the repository: the unit-level companion to
 *    `scripts/check-no-hardcoding.mjs`, specific enough to catch a single
 *    accidental path in a module whose whole subject is paths.
 *
 * ## The corpora, and why there are five
 *
 * The adapter's input contract is a real `CodeGraph`, so every corpus is
 * indexed through the product's own path — `openProject` → `buildIndex` →
 * `CodeGraph.fromIndex` → `buildRouteMap` → `createCodeQueries` →
 * `summarizeProject`. That pair is deliberately the **cache-free** build:
 * `indexProject` would consult and populate `$DEBUGGEN_HOME/index`, which a
 * unit suite must not touch.
 *
 * - `test/fixtures/project-a`, **read-only**, indexed once. It holds exactly
 *   one literal-URL request — inside the module-scope named handler of its
 *   single `'use client'` component — and the route module that answers that
 *   path declares exactly one method export. The owner-symbol rule and the
 *   route cross-reference are therefore each exercised at n = 1 and have to
 *   hold there, which is the whole point of the corpus being small.
 * - A **mixed** scratch corpus: one route module with two method exports, one
 *   component whose named function issues a literal request that route
 *   answers, and a second component whose named function issues a *computed*
 *   one. It is the only corpus that can show a dynamic initiator ranked below
 *   literal evidence, and the only one with two components to narrow between.
 * - A **duplicate** scratch corpus: two distinct call sites requesting one
 *   URL. `api-call` nodes are intentionally not de-duplicated by URL — telling
 *   one initiator from another *is* the duplicate-request investigation of AAP
 *   §0.8.2's third case — so a collapse here would throw the answer away
 *   before the analysis started.
 * - A **many-owner** scratch corpus with more call sites than one proposal may
 *   contain and no route module at all, which exercises the exported cap and
 *   the "nothing in this project answers this target" branch at once.
 * - A **hand-authored `CodeIndex`** with no `api-call` node. A project that
 *   issues no client request is a deliberate capability decision, and it is
 *   the one input not worth writing a source tree for.
 *
 * Nothing here needs a network, a browser, a dev server or a working tree:
 * every readiness fact is injected on the context, and no case performs a
 * request — not even to a loopback address.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODE_INDEX_SCHEMA_VERSION,
  CodeGraph,
  HTTP_METHOD_NAMES,
  INDEXER_VERSION,
  buildIndex,
  buildRouteMap,
  createCodeQueries,
  makeNodeId,
  openProject,
  routeMapFromIndex,
  summarizeProject,
} from '@debuggen/code-analysis';
import type {
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  CodeQueries,
  LoadedProject,
  ProjectSummary,
  RouteMap,
} from '@debuggen/code-analysis';
import { newActionId, noopLogger, ok, toPosix } from '@debuggen/shared';
import type { LogFields, Logger, SourceLocation } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  AdapterRemoveReason,
  InstallResult,
  InstrumentationContext,
  ObservedBrowserAgent,
  ObservedReadinessInputs,
  RemoveResult,
  UnavailableSignal,
} from '../adapter.js';
import { createModificationRecord } from '../schema/modification.js';
import type { ModificationJournal, ModificationRecord } from '../schema/modification.js';
import {
  ACTION_ID_PATTERN,
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  actionIdentityKey,
  instrumentationActionSchema,
} from '../schema/plan.js';
import type { InstrumentationAction } from '../schema/plan.js';
import {
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  READINESS_STATUSES,
  SERVER_AGENT_SIGNAL_KEYS,
  agentHookConfigSchema,
  readinessSchema,
  readinessSignalSchema,
} from '../schema/readiness.js';
import { problemUnderstandingSchema, selectedTargetSchema } from '../schema/target.js';
import type { ProblemUnderstanding, SelectedTarget } from '../schema/target.js';

import {
  FETCH_ADAPTER_CLAIMS,
  FETCH_ADAPTER_ID,
  FETCH_ADAPTER_LIMITS,
  FETCH_AGENT_HOOK_KEYS,
  FETCH_CAPTURE_SIGNALS,
  FETCH_RUNTIME_HOOK_LABELS,
  collectFetchInitiators,
  createFetchAdapter,
} from './fetch.js';
import type { FetchInitiator } from './fetch.js';

/* -------------------------------------------------------------------------------------------------
 * Paths and fixed values
 * ---------------------------------------------------------------------------------------------- */

/**
 * The committed, read-only corpus, resolved from this module's own URL.
 *
 * Two levels up from `src/adapters/`, and deliberately not from
 * `process.cwd()`: this package's Vitest project runs from the repository
 * root, where a relative path would resolve to something else entirely.
 */
const FIXTURE_ROOT = toPosix(
  fileURLToPath(new URL('../../test/fixtures/project-a', import.meta.url)),
);

/** The adapter's own source, for the static import-boundary and URL-literal guards. */
const ADAPTER_SOURCE_PATH = fileURLToPath(new URL('./fetch.ts', import.meta.url));

/** The session every context in this suite belongs to. */
const SESSION_ID = 'ses_fetchadapter0001';

/** The plan revision every context stamps. */
const PLAN_VERSION = 2;

/** A fixed moment, so every clock-dependent assertion is exact. */
const NOW = 1_700_000_000_000;

/** A clock frozen at {@link NOW}. */
const frozenClock = (): number => NOW;

/**
 * A state root no case may reach.
 *
 * This adapter writes nothing, so the directory is never created: it exists as
 * a value the context requires, and the throwing backup store below is what
 * proves nothing went looking for it. One case asserts it is still absent
 * after the whole suite has run.
 */
const STATE_ROOT = toPosix(join(tmpdir(), 'debuggen-fetch-suite-state-never-written'));

/* -------------------------------------------------------------------------------------------------
 * The indexing harness
 * ---------------------------------------------------------------------------------------------- */

/** One indexed project, with every handle an `InstrumentationContext` needs. */
interface IndexedProject {
  /** Absolute POSIX project root, as `openProject` normalised it. */
  readonly root: string;

  /** The loaded ts-morph project, which is what `queries.excerpt` reads from. */
  readonly loaded: LoadedProject | undefined;

  /** The code graph built from a cache-free index. */
  readonly graph: CodeGraph;

  /** The bounded query surface, built over the graph and the route map. */
  readonly queries: CodeQueries;

  /** The route map — the product's only URL ↔ route-file algorithm. */
  readonly routeMap: RouteMap;

  /** The project summary, whose `counts.apiCalls` the adapter records in a log field. */
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
 * Writes a source tree into its own `mkdtemp` directory and indexes it.
 *
 * Each corpus gets a directory of its own and the committed fixture is never
 * written to. A `package.json` is included because `ProjectSummary` reads the
 * package manager from it, a `tsconfig.json` because a target project's own
 * configuration is what `openProject` takes its compiler options from — with
 * `jsx` and the DOM library declared, since these corpora carry components —
 * and a `next.config.mjs` because the router style is detected from the
 * project's own shape.
 *
 * @param label A short, human-readable name for the temporary directory.
 * @param files Project-relative POSIX paths mapped to file contents.
 * @returns The indexed scratch project.
 */
async function scratchProject(
  label: string,
  files: Readonly<Record<string, string>>,
): Promise<IndexedProject> {
  const root = mkdtempSync(join(tmpdir(), `debuggen-fetch-${label}-`));

  scratchRoots.push(root);

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: `scratch-${label}`,
        private: true,
        packageManager: 'pnpm@12.4.2',
        dependencies: { next: '16.3.5', react: '19.3.0' },
        scripts: { dev: 'next dev' },
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          lib: ['DOM', 'DOM.Iterable', 'ES2023'],
          jsx: 'preserve',
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
  writeFileSync(join(root, 'next.config.mjs'), 'export default {};\n', 'utf8');

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(root, relativePath);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }

  return indexProjectTree(toPosix(root));
}

/**
 * Wraps a hand-authored index as an indexed project.
 *
 * The graph, the queries and the route map all come from the index itself, so
 * the three agree with each other; the project summary is borrowed from a real
 * project, because `summarizeProject` needs a loaded ts-morph project and the
 * one case that uses a hand-authored index is about the graph alone.
 *
 * @param index The hand-authored index.
 * @param summaryFrom The project whose summary to borrow.
 * @returns The project handles, with no loaded ts-morph project.
 */
function projectFromIndex(index: CodeIndex, summaryFrom: IndexedProject): IndexedProject {
  const graph = CodeGraph.fromIndex(index);
  const routeMap = routeMapFromIndex(index);

  return {
    root: index.projectRoot,
    loaded: undefined,
    graph,
    routeMap,
    queries: createCodeQueries(graph, { routes: routeMap.entries }),
    projectSummary: summaryFrom.projectSummary,
  };
}

/**
 * A hand-authored index around a node list.
 *
 * @param projectRoot The absolute POSIX root the index claims.
 * @param nodes The nodes the graph holds.
 * @returns The index.
 */
function handAuthoredIndex(projectRoot: string, nodes: readonly CodeNode[]): CodeIndex {
  return {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot,
    indexerVersion: INDEXER_VERSION,
    generatedAt: NOW,
    nodes,
    edges: [],
    files: [],
  };
}

/**
 * One `component` node, hand-authored: a page that issues no request at all.
 *
 * @param file The declaring file, project-relative POSIX.
 * @param name The component's display name.
 * @returns The node.
 */
function componentNode(file: string, name: string): CodeNodeOf<'component'> {
  return {
    id: makeNodeId({ kind: 'component', file, name, line: 1, column: 1 }),
    kind: 'component',
    name,
    file,
    line: 1,
    column: 1,
    exported: true,
    symbol: name,
    data: { isClient: true, isDefaultExport: true, displayName: name },
  };
}

/**
 * One `symbol` node, hand-authored, so the request-free corpus still has a
 * declaration in it.
 *
 * Without one, "this project issues no request" and "this project has no code"
 * would be the same input, and the capability decision under test is the
 * former.
 *
 * @param file The declaring file, project-relative POSIX.
 * @param name The declared name.
 * @returns The node.
 */
function symbolNode(file: string, name: string): CodeNodeOf<'symbol'> {
  return {
    id: makeNodeId({ kind: 'symbol', file, name, line: 3, column: 1 }),
    kind: 'symbol',
    name,
    file,
    line: 3,
    column: 1,
    exported: true,
    symbol: name,
    data: { declaration: 'function', isDefaultExport: false },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The scratch corpora
 *
 * Every identifier below is arbitrary: a route path, a component name and a
 * function name this product has never seen and never will. That is the
 * behavioural half of AAP §0.5.4 — an adapter that recognised names rather than
 * reading the graph would find nothing here — and it is what lets the
 * no-hardcoding group compare one corpus's names against another's.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The mixed corpus: one literal-URL request a route answers, one computed one,
 * in two components.
 *
 * The route module declares two method exports so the cross-reference carries
 * more than one method, and the computed target is a template literal with a
 * substitution — the shape the extractor records as `dynamic` with the raw text
 * kept and no `url`.
 */
const MIXED_SOURCES: Readonly<Record<string, string>> = {
  'app/api/tide-beacons/route.ts': [
    'export async function GET(): Promise<Response> {',
    "  return new Response('[]', { status: 200 });",
    '}',
    '',
    'export async function PATCH(request: Request): Promise<Response> {',
    '  await request.json();',
    '',
    "  return new Response('{}', { status: 200 });",
    '}',
    '',
  ].join('\n'),
  'src/decks/BeaconDeck.tsx': [
    "'use client';",
    '',
    'export async function haulBeaconRoster(): Promise<unknown> {',
    "  const reply = await fetch('/api/tide-beacons', { method: 'GET' });",
    '',
    '  return reply.json();',
    '}',
    '',
    'export function BeaconDeck() {',
    '  return (',
    '    <button',
    '      type="button"',
    '      onClick={() => {',
    '        void haulBeaconRoster();',
    '      }}',
    '    >',
    '      Haul roster',
    '    </button>',
    '  );',
    '}',
    '',
  ].join('\n'),
  'src/decks/MooringDeck.tsx': [
    "'use client';",
    '',
    'export async function nudgeMooringSlip(slipId: string): Promise<unknown> {',
    '  const reply = await fetch(`/api/tide-beacons?slip=${slipId}`, {',
    "    method: 'PATCH',",
    '  });',
    '',
    '  return reply.json();',
    '}',
    '',
    'export function MooringDeck({ slipId }: { slipId: string }) {',
    '  return (',
    '    <button',
    '      type="button"',
    '      onClick={() => {',
    '        void nudgeMooringSlip(slipId);',
    '      }}',
    '    >',
    '      Nudge slip',
    '    </button>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

/**
 * The duplicate corpus: two distinct call sites requesting one URL.
 *
 * Both are module-scope named declarations, so each carries its own owner
 * symbol and the two candidates are distinguishable — which is exactly what
 * the duplicate-request investigation of AAP §0.8.2's third case rests on.
 */
const DUPLICATE_SOURCES: Readonly<Record<string, string>> = {
  'app/api/lantern-slips/route.ts': [
    'export async function GET(): Promise<Response> {',
    "  return new Response('[]', { status: 200 });",
    '}',
    '',
  ].join('\n'),
  'src/decks/SlipTallyDeck.tsx': [
    "'use client';",
    '',
    'export async function primeSlipTally(): Promise<unknown> {',
    "  const reply = await fetch('/api/lantern-slips', { method: 'GET' });",
    '',
    '  return reply.json();',
    '}',
    '',
    'export async function refreshSlipTally(): Promise<unknown> {',
    "  const reply = await fetch('/api/lantern-slips', { method: 'GET' });",
    '',
    '  return reply.json();',
    '}',
    '',
    'export function SlipTallyDeck() {',
    '  return (',
    '    <button',
    '      type="button"',
    '      onClick={() => {',
    '        void primeSlipTally();',
    '      }}',
    '    >',
    '      Prime tally',
    '    </button>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

/** How many request owners the many-owner corpus declares. */
const MANY_OWNER_COUNT = 7;

/**
 * A corpus with far more call sites than one proposal may contain, and no
 * route module at all.
 *
 * Two bounds are observable at once: the exported target cap, and the branch
 * that reports a literal target **no** route module in the project answers —
 * which is the ordinary case for a third-party endpoint and must not read as a
 * failure.
 */
const MANY_OWNER_SOURCES: Readonly<Record<string, string>> = {
  'src/decks/bulk-relay.ts': Array.from({ length: MANY_OWNER_COUNT }, (_unused, index) =>
    [
      `export async function haulRelayLedger${String(index)}(): Promise<unknown> {`,
      `  const reply = await fetch('/relay/ledger-${String(index)}', { method: 'GET' });`,
      '',
      '  return reply.json();',
      '}',
      '',
    ].join('\n'),
  ).join('\n'),
};

/* -------------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

/** The committed fixture, indexed once. */
let fixture: IndexedProject;

/** The mixed corpus: one literal-URL request and one computed one. */
let mixed: IndexedProject;

/** The corpus whose two call sites share one URL. */
let duplicate: IndexedProject;

/** The corpus with more call sites than one proposal may hold, and no routes. */
let manyOwners: IndexedProject;

/** A project that issues no client request at all, from a hand-authored index. */
let requestFree: IndexedProject;

/** Every file of the committed fixture with its SHA-256, taken before anything ran. */
let fixtureSnapshotBefore: readonly string[];

beforeAll(async () => {
  fixtureSnapshotBefore = treeSnapshot(FIXTURE_ROOT);
  fixture = await indexProjectTree(FIXTURE_ROOT);
  mixed = await scratchProject('mixed', MIXED_SOURCES);
  duplicate = await scratchProject('duplicate', DUPLICATE_SOURCES);
  manyOwners = await scratchProject('many-owners', MANY_OWNER_SOURCES);
  requestFree = projectFromIndex(
    handAuthoredIndex(toPosix(join(tmpdir(), 'debuggen-fetch-request-free')), [
      componentNode('src/decks/CalmDeck.tsx', 'CalmDeck'),
      symbolNode('src/decks/calm-arithmetic.ts', 'combineCalmTallies'),
    ]),
    fixture,
  );

  assertCorpusInventory();
}, 180_000);

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  scratchRoots.length = 0;
});

afterEach(() => {
  // One case stubs the environment to prove nothing is read from it. Restoring
  // here rather than there keeps a failure inside that case from leaking a
  // stub into the rest of the run.
  vi.unstubAllEnvs();
  journalEvents.length = 0;
});

/**
 * Every file under a directory, as `«project-relative path» «sha-256»` lines,
 * sorted.
 *
 * Content-addressed rather than size-and-time addressed: this suite's claim is
 * that specific bytes never changed, and a write that happened to preserve a
 * file's length would pass a size comparison.
 *
 * @param root The directory to walk.
 * @returns One sorted line per file.
 */
function treeSnapshot(root: string): readonly string[] {
  const lines: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);

        continue;
      }

      lines.push(`${toPosix(relative(root, absolute))} ${sha256Hex(readFileSync(absolute))}`);
    }
  };

  walk(root);

  return lines.sort();
}

/**
 * Fails the whole suite, immediately and with the reason, when a corpus does
 * not carry what the cases below assume.
 *
 * These are *preconditions*, not assertions about the adapter. If the fixture
 * stopped holding exactly one literal-URL request inside exactly one named
 * handler, the owner-symbol and route cross-reference cases would pass
 * vacuously; throwing from `beforeAll` turns that into one unambiguous failure
 * instead of a suite that is quietly testing nothing.
 */
function assertCorpusInventory(): void {
  const fixtureCalls = apiCalls(fixture);

  if (fixtureCalls.length !== 1) {
    throw new Error(
      `the fixture must hold exactly one api-call node; found ${String(fixtureCalls.length)}`,
    );
  }

  const call = fixtureCalls[0];

  if (call === undefined || call.data.dynamic || call.data.url === undefined) {
    throw new Error("the fixture's one api-call node must carry a literal, non-dynamic URL");
  }

  const owner = ownerOf(fixture, call);

  if (owner === undefined || owner.kind !== 'handler') {
    throw new Error(
      `the fixture's call site must be owned by a named handler; found ${String(owner?.kind)}`,
    );
  }

  const route = fixture.queries.routeForUrl(call.data.url);

  if (route === undefined || route.methods.length !== 1) {
    throw new Error(
      `the fixture's route map must answer the recorded target with a single-method route; found ${String(route?.methods.length)}`,
    );
  }

  if (fixture.routeMap.entries.length === 0) {
    throw new Error("the fixture's route map must not be empty");
  }

  const literals = apiCalls(mixed).filter((node) => node.data.url !== undefined);
  const dynamics = apiCalls(mixed).filter((node) => node.data.dynamic);

  if (literals.length !== 1 || dynamics.length !== 1) {
    throw new Error(
      `the mixed corpus must hold one literal and one computed target; found ${String(literals.length)} and ${String(dynamics.length)}`,
    );
  }

  if (new Set(apiCalls(mixed).map((node) => node.file)).size !== 2) {
    throw new Error('the mixed corpus must hold its two call sites in two modules of its own');
  }

  const duplicateUrls = new Set(apiCalls(duplicate).map((node) => node.data.url));

  if (apiCalls(duplicate).length !== 2 || duplicateUrls.size !== 1) {
    throw new Error(
      `the duplicate corpus must hold two call sites sharing one URL; found ${String(apiCalls(duplicate).length)} sites across ${String(duplicateUrls.size)} URLs`,
    );
  }

  if (apiCalls(manyOwners).length <= FETCH_ADAPTER_LIMITS.maxTargets) {
    throw new Error(
      `the many-owner corpus must hold more call sites than one proposal may contain (${String(FETCH_ADAPTER_LIMITS.maxTargets)})`,
    );
  }

  if (manyOwners.routeMap.entries.length !== 0) {
    throw new Error('the many-owner corpus must declare no route module at all');
  }

  if (apiCalls(requestFree).length !== 0) {
    throw new Error('the request-free corpus must hold no api-call node');
  }

  for (const project of [fixture, mixed, duplicate, manyOwners]) {
    for (const node of apiCalls(project)) {
      const symbol = node.symbol;

      if (symbol === undefined || !project.queries.hasSymbol(node.file, symbol)) {
        throw new Error(
          `every corpus call site must sit inside an addressable declaration; ${node.file}#${String(symbol)} is not one`,
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Reading the corpora — every expectation below is computed from the graph
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every `api-call` node of one project, in the graph's canonical order.
 *
 * The one source of request evidence in the product: the adapter reads these
 * nodes and nothing else, so every expectation in this suite is derived from
 * the same list rather than from a path written here.
 *
 * @param project The indexed project.
 * @returns The call sites.
 */
function apiCalls(project: IndexedProject): readonly CodeNodeOf<'api-call'>[] {
  return project.graph.nodesByKind('api-call');
}

/**
 * The declaration that owns one call site, resolved through the graph's own
 * `calls` edge.
 *
 * The edge's direction is the contract — `from` is the owner the extractor's
 * cascade chose, `to` is the call site — and reading it here is what makes the
 * owner-symbol assertions independent of the adapter: both parties consult the
 * graph, and a disagreement is therefore a real one.
 *
 * @param project The indexed project.
 * @param node The call site.
 * @returns The owner node, or `undefined` when the graph recorded no edge.
 */
function ownerOf(project: IndexedProject, node: CodeNodeOf<'api-call'>): CodeNode | undefined {
  const edge = project.graph.incoming(node.id, 'calls')[0];

  return edge === undefined ? undefined : project.graph.nodeById(edge.from);
}

/**
 * The anchor symbol the graph sanctions for one call site.
 *
 * The owner's own `symbol`, then its `name` — the cascade the call-site
 * extractor documents — then the enclosing symbol the call node itself
 * records, with every candidate put to `queries.hasSymbol`, which is the only
 * authority on whether a name is addressable.
 *
 * @param project The indexed project.
 * @param node The call site.
 * @returns The addressable owner symbol, or `undefined` when the file declares
 * none.
 */
function expectedAnchorOf(
  project: IndexedProject,
  node: CodeNodeOf<'api-call'>,
): string | undefined {
  const owner = ownerOf(project, node);
  const candidates = [
    owner?.symbol,
    owner !== undefined && owner.kind !== 'api-route' && owner.kind !== 'file'
      ? owner.name
      : undefined,
    node.symbol,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && project.queries.hasSymbol(node.file, candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/** The route the project's own URL ↔ file algorithm resolves a target to. */
interface ExpectedRoute {
  /** The route path, as `route-map.ts` spells it. */
  readonly routePath: string;

  /** The route module, project-relative POSIX. */
  readonly file: string;

  /** Where to open the route, exactly as the route map minted it. */
  readonly location: SourceLocation;
}

/**
 * Cross-references one literal target the way the product does, and only the
 * way the product does.
 *
 * `queries.routeForUrl` first, then the route map itself — the same two
 * surfaces, in the same order, that `./fetch.ts` consults. Asserting the
 * adapter agrees with *this* is how the suite proves delegation to the single
 * route algorithm rather than a private re-derivation.
 *
 * @param project The indexed project.
 * @param url The literal target the graph recorded.
 * @returns The route, or `undefined` when nothing in the project answers it.
 */
function expectedRouteFor(project: IndexedProject, url: string): ExpectedRoute | undefined {
  const queried = project.queries.routeForUrl(url);

  if (queried !== undefined) {
    return { routePath: queried.routePath, file: queried.file, location: queried.location };
  }

  const matched = project.routeMap.resolve(url);

  if (matched === undefined) {
    return undefined;
  }

  return {
    routePath: matched.entry.routePath,
    file: matched.entry.file,
    location: matched.entry.location,
  };
}

/**
 * Narrows a value the corpus inventory has already guaranteed.
 *
 * `expect(...).toBeDefined()` asserts but does not narrow, and a `!` would
 * fail with a message about a property of `undefined` rather than about the
 * corpus. This fails once, where the fact is missing, and names it.
 *
 * @param value The value to narrow.
 * @param what What was expected, for the message.
 * @returns The value, narrowed.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the suite expected ${what} to exist in this corpus`);
  }

  return value;
}

/**
 * The one call site whose target the graph recorded as a literal.
 *
 * @param project The indexed project.
 * @returns The call site.
 */
function literalCallOf(project: IndexedProject): CodeNodeOf<'api-call'> {
  return must(
    apiCalls(project).find((node) => node.data.url !== undefined),
    'a call site with a literal target',
  );
}

/**
 * The one call site whose target the graph flagged as computed.
 *
 * @param project The indexed project.
 * @returns The call site.
 */
function dynamicCallOf(project: IndexedProject): CodeNodeOf<'api-call'> {
  return must(
    apiCalls(project).find((node) => node.data.dynamic),
    'a call site with a computed target',
  );
}

/**
 * The component display names one module declares, as the graph recorded them.
 *
 * Read from the graph so the narrowing cases can name a component without this
 * file knowing one, and so the owner-symbol case can assert an action is *not*
 * anchored on the component that renders the handler.
 *
 * @param project The indexed project.
 * @param file The module, project-relative POSIX.
 * @returns The component names.
 */
function componentNamesIn(project: IndexedProject, file: string): readonly string[] {
  return project.graph
    .nodesByFile(file)
    .filter((node) => node.kind === 'component')
    .map((node) => node.name);
}

/**
 * Every request initiator the adapter discovers for one project.
 *
 * The evidence half of the adapter, exported as a pure function of the
 * context — which is what lets this suite read the cross-reference it makes
 * without going through a plan proposal's caps.
 *
 * @param project The indexed project.
 * @returns The initiators, best-ranked first.
 */
function initiatorsOf(project: IndexedProject): readonly FetchInitiator[] {
  return collectFetchInitiators(contextFor({ project }));
}

/**
 * Every path-shaped value one project's graph can legitimately supply to prose.
 *
 * Route paths the route map minted and targets the extractor recorded — and
 * nothing else. The no-hardcoding case below asserts that every slash-bearing
 * token in a rationale is a member of this set, which is a much stronger claim
 * than "no path from the other corpus appears".
 *
 * @param project The indexed project.
 * @returns The permitted paths.
 */
function graphSuppliedPaths(project: IndexedProject): ReadonlySet<string> {
  const paths = new Set<string>();

  for (const entry of project.routeMap.entries) {
    paths.add(entry.routePath);
  }

  for (const node of apiCalls(project)) {
    const url = node.data.url;

    if (url !== undefined) {
      // Prose carries the path only: a query string or fragment is dropped
      // before a recorded target reaches a sentence (AAP §0.5.2).
      paths.add(url);
      paths.add(url.split(/[?#]/u)[0] ?? url);
    }
  }

  return paths;
}

/**
 * The distinctive strings one corpus contributed.
 *
 * Route paths, recorded targets, owner symbols and file paths, narrowed to the
 * ones that could only have come from a project: a name with an internal
 * capital, a path separator or a dot. A single lower-case word would be
 * generic vocabulary, and testing for it would report this product's own
 * English as a leak.
 *
 * @param project The indexed project.
 * @returns The distinctive names, in a stable order.
 */
function distinctiveNames(project: IndexedProject): readonly string[] {
  const names = new Set<string>();
  const candidates: (string | undefined)[] = [
    ...project.routeMap.entries.map((entry) => entry.routePath),
    ...project.routeMap.entries.map((entry) => entry.file),
    ...apiCalls(project).map((node) => node.data.url),
    ...apiCalls(project).map((node) => node.data.urlExpression),
    ...apiCalls(project).map((node) => node.symbol),
    ...apiCalls(project).map((node) => node.file),
  ];

  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      (/[a-z][A-Z]/u.test(candidate) || candidate.includes('/') || candidate.includes('.'))
    ) {
      names.add(candidate);
    }
  }

  return [...names].sort();
}

/* -------------------------------------------------------------------------------------------------
 * The ports: a journal that records, and a backup store that refuses
 * ---------------------------------------------------------------------------------------------- */

/** One call made against the recording journal. */
interface JournalEvent {
  /** Which method was called. */
  readonly method: 'append' | 'updateStatus' | 'listBySession' | 'listOpen';

  /** What the call was about, for a message that names something recognisable. */
  readonly subject: string;
}

/** Every journal call this case made, cleared after each one. */
const journalEvents: JournalEvent[] = [];

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
    journalEvents.push({ method: 'append', subject: `${record.file}:${record.status}` });

    return Promise.resolve(ok(record));
  },
  updateStatus: (id: string, status: string) => {
    journalEvents.push({ method: 'updateStatus', subject: `${id}:${status}` });

    throw new Error('the fetch adapter must never update a modification record');
  },
  listBySession: (sessionId: string) => {
    journalEvents.push({ method: 'listBySession', subject: sessionId });

    return Promise.resolve(ok<ModificationRecord[]>([]));
  },
  listOpen: () => {
    journalEvents.push({ method: 'listOpen', subject: '' });

    return Promise.resolve(ok<ModificationRecord[]>([]));
  },
};

/**
 * A backup store that fails the test if it is ever reached.
 *
 * Nothing is written, so nothing needs a backup. A call here would mean bytes
 * were about to be replaced in a developer's project by an adapter whose whole
 * contract is that it arms a runtime hook inside the page.
 *
 * Typed as the context's own port rather than through a second import of the
 * store's module: the shape a context requires is the shape this double has to
 * satisfy, and reading it from `../adapter.js` keeps that true if the port ever
 * moves.
 */
const forbiddenBackups: InstrumentationContext['backups'] = {
  sessionId: SESSION_ID,
  sessionDirectory: `${STATE_ROOT}/backups/${SESSION_ID}`,
  locate: () => {
    throw new Error('the fetch adapter must never locate a backup');
  },
  put: () => {
    throw new Error('the fetch adapter must never write a backup');
  },
  read: () => {
    throw new Error('the fetch adapter must never read a backup');
  },
  has: () => {
    throw new Error('the fetch adapter must never query a backup');
  },
  verify: () => {
    throw new Error('the fetch adapter must never verify a backup');
  },
  remove: () => {
    throw new Error('the fetch adapter must never remove a backup');
  },
  removeSessionDirectory: () => {
    throw new Error('the fetch adapter must never remove a backup directory');
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
 * what was written *above* `debug`: this adapter reports a missing page agent
 * as data on its result, so it has nothing to warn about, and a warning here
 * would be noise a developer cannot act on twice.
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
 *
 * The whole of this adapter's readiness input. Each preset is a state the
 * service can genuinely have observed and relayed, and the last two are the
 * boundary: a page agent that reports no React is still a page agent, and a
 * dev-server preload is not this adapter's evidence at all.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The document URL a page agent reports, carrying a query parameter **with a
 * value**.
 *
 * Present so the privacy assertions have something real to look for: AAP §0.5.2
 * keeps parameter values out of everything downstream, and a value that is on
 * the context but in none of the adapter's output is the shape of that promise
 * being kept.
 */
const AGENT_DOCUMENT_URL = 'http://127.0.0.1:20301/decks?slip=ferry-nine&token=zephyr';

/** The named page-agent states a case selects from. */
interface AgentPresets {
  /** No `agent.ready` has arrived for the bound tab's current document. */
  readonly absent: ObservedReadinessInputs;

  /** A page agent has reported, before React loaded, with React detected. */
  readonly present: ObservedReadinessInputs;

  /**
   * A page agent has reported from a document with no React on it.
   *
   * The request hook patches two platform functions and needs no fiber hook,
   * so this must be as ready as the preset above. The adapter deliberately
   * reads neither flag, and this preset is what pins that.
   */
  readonly presentWithoutReact: ObservedReadinessInputs;

  /**
   * A dev-server preload is attached and no page agent has reported.
   *
   * `ServerAgentSignals` carries a `fetch` key of its own for the preload's
   * outgoing-request spans, and that signal belongs to the framework adapter.
   * This preset must therefore read exactly like {@link AgentPresets.absent}.
   */
  readonly serverAgentOnly: ObservedReadinessInputs;
}

/**
 * Builds the presets for one project.
 *
 * A function of the project rather than a constant, because the server-agent
 * state names a project root and "attached to this project" is only
 * expressible relative to one.
 *
 * @param project The project the presets are about.
 * @returns The four named states.
 */
function agentPresets(project: IndexedProject): AgentPresets {
  const reported = (overrides: Partial<ObservedBrowserAgent> = {}): ObservedBrowserAgent => ({
    producerId: 'prd_fetchadapter0001',
    documentId: 'doc_fetchadapter0001',
    url: AGENT_DOCUMENT_URL,
    installedBeforeReact: true,
    reactDetected: true,
    observedAt: NOW - 1_000,
    ...overrides,
  });

  return {
    absent: {},
    present: { browserAgent: reported() },
    presentWithoutReact: {
      browserAgent: reported({ installedBeforeReact: false, reactDetected: false }),
    },
    serverAgentOnly: {
      serverAgent: { connected: true, projectRoot: project.root, lastHeartbeatAt: NOW - 1_000 },
    },
  };
}

/**
 * Every preset, with the name a failure message should carry.
 *
 * @param project The project the presets are about.
 * @returns Name/state pairs, in declaration order.
 */
function presetEntries(
  project: IndexedProject,
): readonly [keyof AgentPresets, ObservedReadinessInputs][] {
  const presets = agentPresets(project);

  return (Object.keys(presets) as (keyof AgentPresets)[]).map((name) => [name, presets[name]]);
}

/** The preset names under which this adapter considers the signal collectable. */
const READY_PRESETS: readonly (keyof AgentPresets)[] = ['present', 'presentWithoutReact'];

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
 * The shape is read from `../adapter.js` and never re-declared here. Optional
 * keys are *spread* rather than assigned, which `exactOptionalPropertyTypes`
 * requires: an explicitly `undefined` `loaded`, `now` or `signal` is a
 * different thing from an absent one, and the adapter's clock preference
 * depends on the difference.
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
    journal: recordingJournal,
    backups: forbiddenBackups,
    readiness: input.readiness ?? {},
    ...(input.project.loaded === undefined ? {} : { loaded: input.project.loaded }),
    ...(input.withoutSessionClock === true ? {} : { now: input.now ?? frozenClock }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Stage artifacts — validated, never ad-hoc objects
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds a validated problem understanding.
 *
 * Parsed through the stage's own schema rather than cast, so a case cannot
 * hand this adapter an artifact the pipeline would have rejected — which would
 * make a passing assertion say nothing about production behaviour.
 *
 * @param signalsNeeded The signals the question asks for.
 * @param entities The entities it named.
 * @param searchHints The free-text hints it carried.
 * @returns The understanding.
 */
function understandingFor(
  signalsNeeded: readonly string[],
  entities: readonly { readonly kind: string; readonly name: string }[] = [],
  searchHints: readonly string[] = [],
): ProblemUnderstanding {
  return problemUnderstandingSchema.parse({
    category: 'performance',
    signalsNeeded: [...signalsNeeded],
    entities: entities.map((entity) => ({ ...entity })),
    searchHints: [...searchHints],
  });
}

/** A latency question that asks for the browser's request signal by name. */
const requestQuestion = understandingFor(['interactions', 'fetch']);

/** A question about renders alone, which asks for no request signal at all. */
const renderQuestion = understandingFor(['react', 'state']);

/**
 * Builds a validated selected-element descriptor.
 *
 * The chain is the only field this adapter reads; the rest exist because the
 * producer sends them and the schema requires them.
 *
 * @param componentChain The component chain above the element, nearest first.
 * @returns The descriptor.
 */
function targetFor(componentChain: readonly string[]): SelectedTarget {
  return selectedTargetSchema.parse({
    selector: 'button[type="button"]',
    tagName: 'button',
    text: 'Haul roster',
    componentChain: [...componentChain],
    url: AGENT_DOCUMENT_URL,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Calling the adapter
 * ---------------------------------------------------------------------------------------------- */

/**
 * Proposes a plan for one project, with the default adapter and no narrowing.
 *
 * @param project The indexed project.
 * @param understanding The question. Defaults to {@link requestQuestion}.
 * @returns The proposed actions.
 */
async function wholePlan(
  project: IndexedProject,
  understanding: ProblemUnderstanding = requestQuestion,
): Promise<InstrumentationAction[]> {
  return createFetchAdapter().createPlan(contextFor({ project }), understanding);
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

/**
 * Builds a valid action belonging to some other adapter, or to some other
 * type.
 *
 * Parsed through the plan schema, so a mixed-list case hands `install` an
 * action the installer could really have resolved rather than a shape the
 * pipeline would have rejected first.
 *
 * @param overrides The fields that make it foreign.
 * @returns The action.
 */
function foreignAction(overrides: {
  readonly adapter: string;
  readonly type: (typeof INSTRUMENTATION_ACTION_TYPES)[number];
}): InstrumentationAction {
  return instrumentationActionSchema.parse({
    id: newActionId(),
    file: 'src/decks/other-deck.ts',
    symbol: 'tallyOtherDeck',
    type: overrides.type,
    adapter: overrides.adapter,
    mode: 'runtime',
    rationale: 'An action another adapter claimed, offered to this one by the installer.',
  });
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
 * Every string one install result puts in front of a developer.
 *
 * @param result The install result.
 * @returns Its hook labels and gap strings.
 */
function installStrings(result: InstallResult): string[] {
  return [...result.runtimeHooks, ...gapStrings(result.unavailable)];
}

/** The hook labels every report must carry: de-duplicated and ordered. */
function expectedHookLabels(): string[] {
  return [...new Set(FETCH_RUNTIME_HOOK_LABELS)].sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

/**
 * Removes the hook for one session, with the reason a caller would give.
 *
 * @param project The indexed project.
 * @param reason Why the removal is happening.
 * @param records The records the caller holds, when it holds any.
 * @returns The removal report.
 */
async function removeFor(
  project: IndexedProject,
  reason: AdapterRemoveReason,
  records?: readonly ModificationRecord[],
): Promise<RemoveResult> {
  return createFetchAdapter().remove(
    {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      reason,
      ...(records === undefined ? {} : { records }),
    },
    contextFor({ project, readiness: agentPresets(project).present }),
  );
}

/* -------------------------------------------------------------------------------------------------
 * The corpora themselves
 *
 * `assertCorpusInventory` already fails the run when one of these stops
 * holding; this group states them as assertions so a reader can see what every
 * case below is standing on.
 * ---------------------------------------------------------------------------------------------- */

describe('the corpora', () => {
  it('gives the fixture exactly one literal-URL request, inside one named handler', () => {
    const call = literalCallOf(fixture);

    expect(apiCalls(fixture)).toHaveLength(1);
    expect(call.data.dynamic).toBe(false);
    expect(call.data.url).toBeTypeOf('string');
    expect(ownerOf(fixture, call)?.kind).toBe('handler');
  });

  it('normalises that request method against the shared vocabulary', () => {
    const method = literalCallOf(fixture).data.method;

    // `ApiCallNodeData.method` is already normalised by the extractor, so this
    // suite consumes the field rather than re-parsing the call's arguments.
    expect(method).toBeTypeOf('string');
    expect(HTTP_METHOD_NAMES as readonly string[]).toContain(method);
  });

  it('answers that target from a route module declaring exactly one method', () => {
    const url = must(literalCallOf(fixture).data.url, 'a recorded literal target');
    const route = must(fixture.queries.routeForUrl(url), 'a route answering that target');

    expect(route.methods).toHaveLength(1);
    expect(route.location.resolvedBy).toBe('route-map');
  });

  it('holds a mixed, a duplicate, a many-owner and a request-free corpus beside it', () => {
    expect(apiCalls(mixed).filter((node) => node.data.url !== undefined)).toHaveLength(1);
    expect(apiCalls(mixed).filter((node) => node.data.dynamic)).toHaveLength(1);

    expect(apiCalls(duplicate)).toHaveLength(2);
    expect(new Set(apiCalls(duplicate).map((node) => node.data.url)).size).toBe(1);
    expect(new Set(apiCalls(duplicate).map((node) => node.symbol)).size).toBe(2);

    expect(apiCalls(manyOwners).length).toBeGreaterThan(FETCH_ADAPTER_LIMITS.maxTargets);
    expect(manyOwners.routeMap.entries).toHaveLength(0);

    expect(apiCalls(requestFree)).toHaveLength(0);
    expect(requestFree.graph.nodesByKind('component').length).toBeGreaterThan(0);
  });

  it('shares no distinctive name between the fixture and the scratch corpora', () => {
    const fixtureNames = new Set(distinctiveNames(fixture));
    const scratchNames = [mixed, duplicate, manyOwners].flatMap((project) =>
      distinctiveNames(project),
    );

    expect(fixtureNames.size).toBeGreaterThan(0);
    expect(scratchNames.length).toBeGreaterThan(0);

    for (const name of scratchNames) {
      expect(fixtureNames.has(name), `'${name}' must belong to one corpus only`).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Identity and the claim declaration
 *
 * `../registry.ts` builds its type-to-adapter table from the declaration this
 * module exports, so a claim that drifted here would silently re-route an
 * action type. Every value is checked against the closed vocabulary that owns
 * it rather than against a string restated in this file.
 * ---------------------------------------------------------------------------------------------- */

describe('the request adapter identity', () => {
  it('registers under the id its file is named for', () => {
    expect(FETCH_ADAPTER_ID).toBe('fetch');
    expect(createFetchAdapter().id).toBe(FETCH_ADAPTER_ID);
  });

  it('claims exactly one action type, in runtime mode', () => {
    expect(FETCH_ADAPTER_CLAIMS).toHaveLength(1);

    const claim = FETCH_ADAPTER_CLAIMS[0];

    expect(claim?.type).toBe('fetch-tracking');
    expect(claim?.mode).toBe('runtime');
    expect(createFetchAdapter().claims).toEqual([...FETCH_ADAPTER_CLAIMS]);
  });

  it('states that claim in the three closed vocabularies that own it', () => {
    const claim = FETCH_ADAPTER_CLAIMS[0];

    expect(INSTRUMENTATION_ACTION_TYPES as readonly string[]).toContain(claim?.type);
    expect(INSTRUMENTATION_MODES as readonly string[]).toContain(claim?.mode);
    expect(CAPTURE_SIGNALS as readonly string[]).toContain(claim?.signal);
    expect(FETCH_CAPTURE_SIGNALS).toEqual([claim?.signal]);
  });

  it('contributes exactly the browser request key of the page-agent configuration', () => {
    expect(FETCH_AGENT_HOOK_KEYS).toHaveLength(1);

    const key = FETCH_AGENT_HOOK_KEYS[0];

    expect(AGENT_HOOK_KEYS as readonly string[]).toContain(key);
    expect(Object.keys(DORMANT_AGENT_HOOK_CONFIG)).toContain(key);
    expect(createFetchAdapter().hookKeys).toEqual([...FETCH_AGENT_HOOK_KEYS]);
  });

  it('claims no preload signal, though the preload vocabulary carries the same name', () => {
    // The boundary most easily blurred, and therefore pinned: the dev server's
    // outgoing-request spans are `ServerAgentSignals.fetch`, which belongs to
    // the framework adapter's preload contribution. The names coincide because
    // two producers observe requests; the claims do not.
    expect(SERVER_AGENT_SIGNAL_KEYS as readonly string[]).toContain(FETCH_CAPTURE_SIGNALS[0]);
    expect(Object.keys(createFetchAdapter())).not.toContain('serverSignalKeys');

    const adapter = createFetchAdapter() as unknown as Record<string, unknown>;

    for (const surface of ['serverSignals', 'serverSignalKeys', 'preload']) {
      expect(adapter[surface], `the request adapter must expose no ${surface}`).toBeUndefined();
    }
  });

  it('publishes frozen limits and hook labels', () => {
    for (const frozen of [
      FETCH_ADAPTER_CLAIMS,
      FETCH_CAPTURE_SIGNALS,
      FETCH_AGENT_HOOK_KEYS,
      FETCH_RUNTIME_HOOK_LABELS,
      FETCH_ADAPTER_LIMITS,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }

    expect(FETCH_ADAPTER_LIMITS.minTargets).toBeLessThanOrEqual(FETCH_ADAPTER_LIMITS.maxTargets);
    expect(FETCH_ADAPTER_LIMITS.maxTargets).toBeLessThanOrEqual(
      FETCH_ADAPTER_LIMITS.maxTargetsCeiling,
    );
    expect(FETCH_ADAPTER_LIMITS.maxRationaleLength).toBeGreaterThan(
      FETCH_ADAPTER_LIMITS.maxProseValueLength,
    );
    expect(FETCH_RUNTIME_HOOK_LABELS.length).toBeGreaterThan(0);
    expect(createFetchAdapter().limits).toBe(FETCH_ADAPTER_LIMITS);
  });

  it('builds independent instances the factory configured separately', () => {
    const lenient = createFetchAdapter({ maxTargets: FETCH_ADAPTER_LIMITS.maxTargetsCeiling });
    const strict = createFetchAdapter({ maxTargets: FETCH_ADAPTER_LIMITS.minTargets });

    expect(lenient).not.toBe(strict);
    expect(lenient.maxTargets).toBe(FETCH_ADAPTER_LIMITS.maxTargetsCeiling);
    expect(strict.maxTargets).toBe(FETCH_ADAPTER_LIMITS.minTargets);
    expect(createFetchAdapter().maxTargets).toBe(FETCH_ADAPTER_LIMITS.maxTargets);
  });

  it('clamps an unusable cap into the exported limits and reports the adjustment', () => {
    const lines: LogLine[] = [];

    expect(
      createFetchAdapter({
        maxTargets: FETCH_ADAPTER_LIMITS.maxTargetsCeiling + 50,
        logger: capturingLogger(lines),
      }).maxTargets,
    ).toBe(FETCH_ADAPTER_LIMITS.maxTargetsCeiling);
    expect(createFetchAdapter({ maxTargets: 0 }).maxTargets).toBe(FETCH_ADAPTER_LIMITS.minTargets);
    expect(createFetchAdapter({ maxTargets: Number.NaN }).maxTargets).toBe(
      FETCH_ADAPTER_LIMITS.maxTargets,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('debug');
    expect(lines[0]?.fields['adapter']).toBe(FETCH_ADAPTER_ID);
  });

  it('has no side effect worth paying for at import time', async () => {
    // The state root every context names, and which nothing may create.
    expect(existsSync(STATE_ROOT)).toBe(false);

    vi.resetModules();

    const reimported = await import('./fetch.js');

    expect(reimported.FETCH_ADAPTER_ID).toBe(FETCH_ADAPTER_ID);
    expect(reimported.FETCH_ADAPTER_LIMITS).toEqual(FETCH_ADAPTER_LIMITS);
    expect(reimported.FETCH_ADAPTER_CLAIMS).toEqual([...FETCH_ADAPTER_CLAIMS]);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(journalEvents).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * canHandle — cheap, synchronous, and about the graph alone
 * ---------------------------------------------------------------------------------------------- */

describe('canHandle', () => {
  it('claims a project whose graph records a client request', () => {
    const answer = createFetchAdapter().canHandle(contextFor({ project: fixture }));

    // Synchronous by contract: the planner asks it once per candidate action
    // type while a developer waits, so a promise here would be a await nobody
    // added.
    expect(answer).toBe(true);
    expect(typeof answer).toBe('boolean');
    expect(answer).not.toBeInstanceOf(Promise);
  });

  it('claims a project that requests under names it has never seen', () => {
    for (const project of [mixed, duplicate, manyOwners]) {
      expect(createFetchAdapter().canHandle(contextFor({ project }))).toBe(true);
    }
  });

  it('declines a project whose graph records no request at all', () => {
    expect(createFetchAdapter().canHandle(contextFor({ project: requestFree }))).toBe(false);
  });

  it('answers the same way whatever the page agent is doing', () => {
    const adapter = createFetchAdapter();

    for (const [name, readiness] of presetEntries(fixture)) {
      expect(
        adapter.canHandle(contextFor({ project: fixture, readiness })),
        `capability must not depend on the '${name}' readiness state`,
      ).toBe(true);
    }
  });

  it('touches no file and reads no environment', () => {
    const lines: LogLine[] = [];

    vi.stubEnv('DEBUGGEN_HOME', '/tmp/a-state-root-this-adapter-must-not-read');
    vi.stubEnv('DEBUGGEN_INGEST_URL', 'http://127.0.0.1:20399/telemetry/ingest');

    // The backup store on this context throws on contact and the journal
    // records every call, so both halves of "graph-only" are observable.
    expect(
      createFetchAdapter().canHandle(
        contextFor({ project: fixture, logger: capturingLogger(lines) }),
      ),
    ).toBe(true);
    expect(journalEvents).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan — initiators, owner symbols and the route cross-reference
 *
 * The group that carries AAP §0.5.4's weight. Every expectation is computed
 * from the graph a case indexed: the anchor from the `calls` edge, the route
 * from the project's own URL ↔ file algorithm, the cap from the exported limits
 * constant. Nothing here is written as a path.
 * ---------------------------------------------------------------------------------------------- */

describe('createPlan', () => {
  it('proposes runtime actions the plan schema accepts', async () => {
    const actions = await wholePlan(fixture);

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      expect(() => instrumentationActionSchema.parse(action)).not.toThrow();
      expect(action.id).toMatch(ACTION_ID_PATTERN);
      expect(action.type).toBe('fetch-tracking');
      expect(action.mode).toBe('runtime');
      expect(action.adapter).toBe(FETCH_ADAPTER_ID);
      expect(action.rationale.trim().length).toBeGreaterThan(0);
      expect(action.rationale.length).toBeLessThanOrEqual(FETCH_ADAPTER_LIMITS.maxRationaleLength);

      // The feasibility gate resolves `(file, symbol)` through exactly this
      // query, so an action that failed it here would be one the planner
      // rejects after a developer has read it.
      expect(
        fixture.queries.hasSymbol(action.file, action.symbol),
        `${action.file}#${action.symbol} must be an addressable declaration`,
      ).toBe(true);
    }
  });

  it('anchors on the enclosing declaration the graph records, never on the call', async () => {
    const call = literalCallOf(fixture);
    const expectedAnchor = must(expectedAnchorOf(fixture, call), 'an addressable owner symbol');
    const actions = await wholePlan(fixture);
    const action = must(actions[0], 'one proposed action');

    expect(actions).toHaveLength(1);
    expect(action.file).toBe(call.file);
    expect(action.symbol).toBe(expectedAnchor);

    // The owner is the origin of the `calls` edge, which is what makes this an
    // independent expectation rather than the adapter agreeing with itself.
    expect(ownerOf(fixture, call)?.name).toBe(expectedAnchor);

    // And the three things it must not be: the call expression, the recorded
    // target, and the component that renders the handler.
    expect(action.symbol).not.toBe(call.name);
    expect(action.symbol).not.toBe(call.data.url);
    expect(componentNamesIn(fixture, call.file).length).toBeGreaterThan(0);
    expect(componentNamesIn(fixture, call.file)).not.toContain(action.symbol);
  });

  it('records the route this project answers for the target it discovered', async () => {
    const call = literalCallOf(fixture);
    const url = must(call.data.url, 'a recorded literal target');

    // Both surfaces, asked directly, with the URL taken from the graph node.
    // They are the product's ONE URL ↔ route-file algorithm, so agreement with
    // them is what proves delegation rather than a private re-derivation.
    const queried = must(fixture.queries.routeForUrl(url), 'a resolved route');
    const matched = must(fixture.routeMap.resolve(url), 'a route-map match');

    expect(queried.routePath).toBe(matched.entry.routePath);
    expect(queried.file).toBe(matched.entry.file);

    const action = must((await wholePlan(fixture))[0], 'one proposed action');

    expect(action.rationale).toContain(queried.routePath);
  });

  it('preserves the route map own provenance rather than re-minting a location', () => {
    const call = literalCallOf(fixture);
    const url = must(call.data.url, 'a recorded literal target');
    const expected = must(expectedRouteFor(fixture, url), 'a resolved route');
    const initiators = initiatorsOf(fixture);
    const initiator = must(initiators[0], 'one discovered initiator');
    const route = must(initiator.route, 'a cross-referenced route on that initiator');

    expect(initiators).toHaveLength(1);
    expect(initiator.nodeId).toBe(call.id);
    expect(initiator.url).toBe(url);
    expect(initiator.dynamic).toBe(false);
    expect(route.routePath).toBe(expected.routePath);
    expect(route.file).toBe(expected.file);

    // Carried through unchanged, `resolvedBy` included: re-stamping it would
    // claim a resolution route this module never performed.
    expect(route.location).toEqual(expected.location);
    expect(route.location.resolvedBy).toBe('route-map');
  });

  it('proposes for a question that named a route without naming the signal', async () => {
    const routePath = must(fixture.routeMap.entries[0], 'a route entry').routePath;
    const actions = await wholePlan(
      fixture,
      understandingFor(['react'], [{ kind: 'route', name: routePath }]),
    );

    // A question that names a route IS a question about requests, and
    // honouring that costs nothing while a missed signal costs the
    // browser-to-server join.
    expect(actions).toHaveLength(1);
  });

  it('proposes nothing for a question that asks for no request evidence', async () => {
    expect(await wholePlan(fixture, renderQuestion)).toEqual([]);
  });

  it('keeps a computed target, ranked below literal evidence, and says why', async () => {
    const literal = literalCallOf(mixed);
    const dynamic = dynamicCallOf(mixed);
    const actions = await wholePlan(mixed);

    expect(dynamic.data.url).toBeUndefined();
    expect(dynamic.data.urlExpression).toBeTypeOf('string');
    expect(actions).toHaveLength(2);

    const first = must(actions[0], 'the best-ranked action');
    const second = must(actions[1], 'the second action');

    // Literal first: a literal can be cross-referenced against the route map
    // before the capture, which is what lets the plan say where it lands.
    expect(first.symbol).toBe(expectedAnchorOf(mixed, literal));
    expect(second.symbol).toBe(expectedAnchorOf(mixed, dynamic));

    // Never silently dropped: a computed target is still where a request comes
    // from, and the rationale states the precision it costs.
    expect(second.rationale).toMatch(/computed at run time/iu);
    expect(second.rationale).toMatch(/less precise/iu);
    expect(second.rationale).not.toContain(must(dynamic.data.urlExpression, 'the raw target text'));
  });

  it('keeps two call sites that share one URL as two candidates', () => {
    const initiators = initiatorsOf(duplicate);
    const urls = new Set(initiators.map((initiator) => initiator.url));

    // The duplicate-request investigation of AAP §0.8.2's third case depends on
    // this: collapsing the two would throw the answer away before the analysis
    // started.
    expect(initiators).toHaveLength(2);
    expect(urls.size).toBe(1);
    expect(new Set(initiators.map((initiator) => initiator.nodeId)).size).toBe(2);
    expect(new Set(initiators.map((initiator) => initiator.symbol)).size).toBe(2);
  });

  it('anchors both of those sites separately, with distinct plan identities', async () => {
    const actions = await wholePlan(duplicate);
    const expectedAnchors = apiCalls(duplicate).map((node) =>
      must(expectedAnchorOf(duplicate, node), 'an addressable owner symbol'),
    );

    expect(actions).toHaveLength(2);
    expect([...actions].map((action) => action.symbol).sort()).toEqual(
      [...expectedAnchors].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1)),
    );
    expect(new Set(actions.map((action) => actionIdentityKey(action))).size).toBe(2);
  });

  it('reports a literal target no route module in this project answers', async () => {
    const actions = await wholePlan(manyOwners);
    const action = must(actions[0], 'one proposed action');
    const call = must(
      apiCalls(manyOwners).find((node) => node.symbol === action.symbol),
      'the call site that action was anchored on',
    );
    const url = must(call.data.url, 'a recorded literal target');

    expect(expectedRouteFor(manyOwners, url)).toBeUndefined();
    expect(action.rationale).toContain(url);
    expect(action.rationale).toMatch(/no route module/iu);
  });

  it('stays inside the exported cap however many call sites the graph holds', async () => {
    const sites = apiCalls(manyOwners).length;
    const actions = await wholePlan(manyOwners);

    expect(sites).toBeGreaterThan(FETCH_ADAPTER_LIMITS.maxTargets);
    expect(actions).toHaveLength(FETCH_ADAPTER_LIMITS.maxTargets);
    expect(actions.length).toBeLessThanOrEqual(createFetchAdapter().maxTargets);
  });

  it('honours a configured cap, bounded by the exported ceiling', async () => {
    const context = contextFor({ project: manyOwners });
    const lenient = await createFetchAdapter({
      maxTargets: FETCH_ADAPTER_LIMITS.maxTargetsCeiling,
    }).createPlan(context, requestQuestion);
    const strict = await createFetchAdapter({
      maxTargets: FETCH_ADAPTER_LIMITS.minTargets,
    }).createPlan(context, requestQuestion);

    expect(lenient).toHaveLength(apiCalls(manyOwners).length);
    expect(lenient.length).toBeLessThanOrEqual(FETCH_ADAPTER_LIMITS.maxTargetsCeiling);
    expect(strict).toHaveLength(FETCH_ADAPTER_LIMITS.minTargets);
  });

  it('says the observation is document-wide while the anchor is an initiator', async () => {
    for (const project of [fixture, mixed, duplicate, manyOwners]) {
      for (const action of await wholePlan(project)) {
        // The hook patches two platform functions for the whole document, so a
        // plan that implied per-call-site instrumentation would be a promise
        // this adapter does not keep.
        expect(action.rationale).toMatch(/document-wide/iu);
        expect(action.rationale).toMatch(/anchored on/iu);
        expect(action.rationale).toContain(action.symbol);
      }
    }
  });

  it('narrows to the component the developer selected', async () => {
    const adapter = createFetchAdapter();
    const context = contextFor({ project: mixed });
    const literal = literalCallOf(mixed);
    const dynamic = dynamicCallOf(mixed);

    for (const call of [literal, dynamic]) {
      const component = must(
        componentNamesIn(mixed, call.file)[0],
        'a component declared beside that call site',
      );
      const actions = await adapter.createPlan(context, requestQuestion, targetFor([component]));
      const narrowed = `selecting inside ${component} must narrow to its own module`;

      expect(actions, narrowed).toHaveLength(1);
      expect(actions[0]?.file, narrowed).toBe(call.file);
      expect(actions[0]?.symbol, narrowed).toBe(expectedAnchorOf(mixed, call));
    }
  });

  it('narrows to a declaration the question named', async () => {
    const dynamic = dynamicCallOf(mixed);
    const named = must(expectedAnchorOf(mixed, dynamic), 'an addressable owner symbol');
    const actions = await wholePlan(
      mixed,
      understandingFor(['fetch'], [{ kind: 'function', name: named }]),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.symbol).toBe(named);
    expect(actions[0]?.file).toBe(dynamic.file);
  });

  it('falls back to the ranked initiators when nothing the question named resolves', async () => {
    const actions = await createFetchAdapter().createPlan(
      contextFor({ project: mixed }),
      understandingFor(
        ['fetch'],
        [{ kind: 'component', name: 'GrapnelHoistDeck' }],
        ['grapnel hoist'],
      ),
      targetFor(['GrapnelHoistDeck']),
    );

    // Unresolvable evidence widens rather than empties: answering with nothing
    // would lose the signal that joins the browser and server halves of a
    // trace.
    expect(actions).toHaveLength(apiCalls(mixed).length);
    expect(withoutIds(actions)).toEqual(withoutIds(await wholePlan(mixed)));
  });

  it('returns an empty array, and never throws, for a project it does not claim', async () => {
    await expect(wholePlan(requestFree)).resolves.toEqual([]);
  });

  it('proposes nothing once the session has been abandoned', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      createFetchAdapter().createPlan(
        contextFor({ project: fixture, signal: controller.signal }),
        requestQuestion,
      ),
    ).resolves.toEqual([]);
  });

  it('produces the same proposal twice, in the same order, apart from fresh ids', async () => {
    for (const project of [fixture, mixed, duplicate, manyOwners]) {
      const first = await wholePlan(project);
      const second = await wholePlan(project);

      expect(withoutIds(second)).toEqual(withoutIds(first));
      expect(second.map((action) => action.id)).not.toEqual(first.map((action) => action.id));
    }
  });

  it('is serialisable, because a plan is stored and sent', async () => {
    const actions = await wholePlan(mixed);

    expect(JSON.parse(JSON.stringify(actions))).toEqual(actions);
  });

  it('records nothing in the journal and never reaches the backup store', async () => {
    for (const project of [fixture, mixed, duplicate, manyOwners, requestFree]) {
      await wholePlan(project);
    }

    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The privacy scan
 *
 * What may never reach a developer's log, a stored result or a wire frame: a
 * request target, a query parameter value, a project path or a line of the
 * project's own source (AAP §0.5.2). The forbidden set is derived from the
 * corpora themselves rather than guessed at, so the assertion is about this
 * project's real data.
 * ---------------------------------------------------------------------------------------------- */

/** Shapes a parameter value or a serialised object would have if one leaked. */
const LEAK_PATTERNS: readonly RegExp[] = [
  // A query string carrying a value, in any form.
  /\?[^\s?]*=/u,
  // A serialised object, however it was produced.
  /\[object Object\]/u,
  /"(?:url|urlExpression|params|headers|body)"\s*:/iu,
];

/**
 * The substrings nothing this adapter reports may contain.
 *
 * Every corpus's distinctive names, the query parameter values the injected
 * page-agent fact carries, and the fixture's own source lines.
 *
 * @returns The forbidden substrings.
 */
function forbiddenLeakStrings(): readonly string[] {
  // The opaque producer and document ids the agent minted are deliberately
  // NOT forbidden: they carry no project data and they are how a developer
  // correlates a capture with the document that produced it. The document's
  // URL, and the parameter values inside it, are what may never travel.
  const forbidden = new Set<string>([AGENT_DOCUMENT_URL, 'ferry-nine', 'zephyr', '/decks']);

  for (const project of [fixture, mixed, duplicate, manyOwners]) {
    for (const name of distinctiveNames(project)) {
      forbidden.add(name);
    }
  }

  for (const node of apiCalls(fixture)) {
    for (const line of readFileSync(join(FIXTURE_ROOT, node.file), 'utf8').split('\n')) {
      const trimmed = line.trim();

      if (trimmed.length > 16) {
        forbidden.add(trimmed);
      }
    }
  }

  return [...forbidden];
}

/**
 * Asserts that nothing a developer, a store or a model reads carries the data.
 *
 * @param values Every string one call put in front of a reader.
 * @param what What produced them, for the message.
 */
function expectNoLeak(values: readonly string[], what: string): void {
  const forbidden = forbiddenLeakStrings();

  expect(forbidden.length).toBeGreaterThan(0);

  for (const value of values) {
    if (value.length === 0) {
      continue;
    }

    for (const needle of forbidden) {
      expect(value, `${what} must not carry '${needle}'`).not.toContain(needle);
    }

    for (const pattern of LEAK_PATTERNS) {
      expect(value, `${what} must not match ${pattern.source}`).not.toMatch(pattern);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * install — no write, a stable hook list, and every gap reported as data
 * ---------------------------------------------------------------------------------------------- */

describe('install', () => {
  it('writes nothing, whatever the page agent is doing', async () => {
    const plan = await wholePlan(fixture);

    expect(plan.length).toBeGreaterThan(0);

    for (const [name, readiness] of presetEntries(fixture)) {
      const result = await createFetchAdapter().install(
        plan,
        contextFor({ project: fixture, readiness }),
      );

      // The signal is installed inside the page by the telemetry agent, so
      // there is no file to back up, no hash to record and nothing for cleanup
      // to restore (AAP §0.5.1).
      expect(result.adapterId).toBe(FETCH_ADAPTER_ID);
      expect(result.applied, `the '${name}' state must apply no modification`).toEqual([]);
      expect(result.serverSignals).toBeUndefined();
    }

    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
  });

  it('arms the request hook and reports no gap when a page agent has reported', async () => {
    const plan = await wholePlan(fixture);
    const presets = agentPresets(fixture);

    for (const name of READY_PRESETS) {
      const result = await createFetchAdapter().install(
        plan,
        contextFor({ project: fixture, readiness: presets[name] }),
      );

      expect(result.unavailable, `the '${name}' state must report no gap`).toEqual([]);
      expect(result.runtimeHooks.length).toBeGreaterThan(0);
      expect(result.runtimeHooks).toEqual(expectedHookLabels());
      expect(new Set(result.runtimeHooks).size).toBe(result.runtimeHooks.length);
    }
  });

  it('contributes exactly the browser request key, and the prerequisite it implies', async () => {
    const result = await createFetchAdapter().install(
      await wholePlan(fixture),
      contextFor({ project: fixture, readiness: agentPresets(fixture).present }),
    );
    const hooks = agentHookConfigSchema.parse(result.agentHooks);
    const requestKey = must(FETCH_AGENT_HOOK_KEYS[0], 'the claimed hook key');

    expect(hooks[requestKey]).toBe(true);

    // `interactions` is forced on by the derivation in `../schema/readiness.ts`
    // and not claimed here: the header this hook injects only travels while an
    // interaction window is open, so without it the browser and server halves
    // of a trace would silently become two unrelated trees.
    expect(hooks.interactions).toBe(true);

    for (const key of AGENT_HOOK_KEYS) {
      if (key !== requestKey && key !== 'interactions') {
        expect(hooks[key], `the '${key}' hook must stay off`).toBe(false);
      }
    }

    expect(hooks).toEqual({ ...DORMANT_AGENT_HOOK_CONFIG, [requestKey]: true, interactions: true });

    // And the boundary: the preload's own outgoing-request signal is not this
    // adapter's to arm.
    expect(result.serverSignals).toBeUndefined();
  });

  it('reports one actionable gap when no page agent has reported', async () => {
    const plan = await wholePlan(fixture);

    for (const name of ['absent', 'serverAgentOnly'] as const) {
      const result = await createFetchAdapter().install(
        plan,
        contextFor({ project: fixture, readiness: agentPresets(fixture)[name] }),
      );

      expect(result.unavailable).toHaveLength(1);

      const gap = must(result.unavailable[0], 'one reported gap');

      expect(CAPTURE_SIGNALS as readonly string[]).toContain(gap.signal);
      expect(gap.signal).toBe(FETCH_CAPTURE_SIGNALS[0]);

      for (const [field, value] of [
        ['reason', gap.reason],
        ['hint', gap.hint],
      ] as const) {
        expect(value.length, `the '${name}' gap must state a ${field}`).toBeGreaterThan(0);
        expect(value.trim()).toBe(value);
        expect(value).not.toMatch(/[\r\n\t]/u);
      }

      // Actionable rather than merely honest (AAP §0.5.5): the recovery is to
      // open the application in a tab with the panel attached and reload it.
      expect(gap.hint).toMatch(/open/iu);
      expect(gap.hint).toMatch(/panel/iu);
      expect(gap.hint).toMatch(/reload/iu);

      // The same wording has to be valid in a readiness row too, since the
      // adapter reports the one gap through both surfaces.
      expect(() =>
        readinessSignalSchema.parse({
          signal: gap.signal,
          status: 'unavailable',
          reason: gap.reason,
          hint: gap.hint,
        }),
      ).not.toThrow();

      // Degradation is data: nothing is armed, and the call still resolves.
      expect(result.runtimeHooks).toEqual([]);
      expect(result.agentHooks).toBeUndefined();
      expect(result.applied).toEqual([]);
    }
  });

  it('treats a preload attached to this project as no page agent at all', async () => {
    const plan = await wholePlan(fixture);
    const presets = agentPresets(fixture);
    const [withServerAgent, withNothing] = await Promise.all([
      createFetchAdapter().install(
        plan,
        contextFor({ project: fixture, readiness: presets.serverAgentOnly }),
      ),
      createFetchAdapter().install(
        plan,
        contextFor({ project: fixture, readiness: presets.absent }),
      ),
    ]);

    expect(withServerAgent).toEqual(withNothing);
  });

  it('installs nothing when no request-tracking action was planned', async () => {
    const result = await createFetchAdapter().install(
      [],
      contextFor({ project: fixture, readiness: agentPresets(fixture).present }),
    );

    expect(result).toEqual({
      adapterId: FETCH_ADAPTER_ID,
      applied: [],
      runtimeHooks: [],
      unavailable: [],
    });
    expect(result.agentHooks).toBeUndefined();
  });

  it('ignores an action belonging to another adapter or another type', async () => {
    const plan = await wholePlan(fixture);
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).present });
    const mixedList = [
      foreignAction({ adapter: 'react', type: 'react-render-tracking' }),
      ...plan,
      // This adapter's id, but a type it does not claim: not its work either.
      foreignAction({ adapter: FETCH_ADAPTER_ID, type: 'perf-tracking' }),
      // Its own type, claimed by someone else: that adapter's to install.
      foreignAction({ adapter: 'browser-performance', type: 'fetch-tracking' }),
    ];

    // Silently, because the installer hands every adapter the subset it
    // resolved and complaining about the rest would turn a routing detail into
    // a developer-visible failure.
    expect(await createFetchAdapter().install(mixedList, context)).toEqual(
      await createFetchAdapter().install(plan, context),
    );
  });

  it('arms nothing once the install has been abandoned', async () => {
    const controller = new AbortController();

    controller.abort();

    expect(
      await createFetchAdapter().install(
        await wholePlan(fixture),
        contextFor({
          project: fixture,
          readiness: agentPresets(fixture).present,
          signal: controller.signal,
        }),
      ),
    ).toEqual({
      adapterId: FETCH_ADAPTER_ID,
      applied: [],
      runtimeHooks: [],
      unavailable: [],
    });
  });

  it('resolves rather than rejecting for every observed state, on every corpus', async () => {
    for (const project of [fixture, mixed, duplicate, manyOwners, requestFree]) {
      const plan = await wholePlan(project);

      for (const [, readiness] of presetEntries(project)) {
        await expect(
          createFetchAdapter().install(plan, contextFor({ project, readiness })),
        ).resolves.toBeDefined();
      }
    }
  });

  it('reports hooks deterministically, and in the same order', async () => {
    const plan = await wholePlan(fixture);
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).present });
    const first = await createFetchAdapter().install(plan, context);
    const second = await createFetchAdapter().install(plan, context);

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('leaks no target, parameter value or source line into a result or a log', async () => {
    const lines: LogLine[] = [];
    const adapter = createFetchAdapter();
    const presets = agentPresets(fixture);

    for (const readiness of [presets.present, presets.absent]) {
      const result = await adapter.install(
        await wholePlan(fixture),
        contextFor({ project: fixture, readiness, logger: capturingLogger(lines) }),
      );

      // Asserted over the WHOLE result serialised, not only over the strings
      // this suite thought to flatten, so a new field cannot smuggle data past
      // the check.
      expectNoLeak([JSON.stringify(result), ...installStrings(result)], 'an install result');
    }

    expect(lines.length).toBeGreaterThan(0);

    // Nothing above `debug`: a missing page agent is reported as data on the
    // result, so there is nothing here for a developer to be warned about
    // twice.
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);

    for (const line of lines) {
      expect(line.fields['adapter']).toBe(FETCH_ADAPTER_ID);
      expectNoLeak([line.message, JSON.stringify(line.fields)], 'a log line');
    }

    // The positive half of the same claim: the opaque handles a developer
    // needs to correlate a capture ARE recorded, and the document's URL is
    // not.
    const armed = must(
      lines.find((line) => line.fields['producerId'] !== undefined),
      'a log line naming the page agent',
    );

    expect(armed.fields['producerId']).toBe(presets.present.browserAgent?.producerId);
    expect(armed.fields['documentId']).toBe(presets.present.browserAgent?.documentId);
    expect(Object.keys(armed.fields)).not.toContain('url');
  });
});

/* -------------------------------------------------------------------------------------------------
 * readiness — a pure function of the injected facts
 *
 * The service holds the evidence: the relayed `agent.ready` for the bound tab's
 * current document. An adapter that went looking for its own could tell a
 * developer a signal is ready while the frames the product needs are not
 * arriving (AAP §0.5.5).
 * ---------------------------------------------------------------------------------------------- */

describe('readiness', () => {
  it('is ready with no rows for a project that issues no request', async () => {
    const report = await createFetchAdapter().readiness(contextFor({ project: requestFree }));

    // An adapter claiming nothing cannot hold a capture back, which is a
    // different statement from an adapter whose signal is unavailable.
    expect(report.signals).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.adapter).toBe(FETCH_ADAPTER_ID);
  });

  it('reports every observed state with a row the schema accepts', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const report = await createFetchAdapter().readiness(
        contextFor({ project: fixture, readiness }),
      );

      expect(() => readinessSchema.parse(report)).not.toThrow();
      expect(report.adapter).toBe(FETCH_ADAPTER_ID);
      expect(report.checkedAt).toBe(NOW);
      expect(report.signals).toHaveLength(1);

      const row = must(report.signals[0], `a row for the '${name}' state`);

      expect(READINESS_STATUSES as readonly string[]).toContain(row.status);
      expect(row.signal).toBe(FETCH_CAPTURE_SIGNALS[0]);

      const expected = READY_PRESETS.includes(name) ? 'available' : 'unavailable';

      expect(row.status, `the '${name}' state must read as ${expected}`).toBe(expected);
      expect(report.ready).toBe(expected === 'available');

      if (row.status === 'available') {
        // Nothing to explain, so nothing is said: a reason on a ready row
        // would be prose a developer cannot act on.
        expect(row.reason).toBeUndefined();
        expect(row.hint).toBeUndefined();

        continue;
      }

      const reason = must(row.reason, `a reason on the '${name}' row`);
      const hint = must(row.hint, `a hint on the '${name}' row`);

      expect(reason.trim()).toBe(reason);
      expect(reason.length).toBeGreaterThan(0);
      expect(hint.trim()).toBe(hint);
      expect(hint.length).toBeGreaterThan(0);
    }
  });

  it('never consults React, because the request hook needs no fiber hook', async () => {
    const presets = agentPresets(fixture);
    const [withReact, withoutReact] = await Promise.all([
      createFetchAdapter().readiness(contextFor({ project: fixture, readiness: presets.present })),
      createFetchAdapter().readiness(
        contextFor({ project: fixture, readiness: presets.presentWithoutReact }),
      ),
    ]);

    expect(withoutReact).toEqual(withReact);
  });

  it('takes its timestamp from the session clock first, then its own', async () => {
    const optionClock = NOW + 5_000;
    const adapter = createFetchAdapter({ now: () => optionClock });
    const sessionClock = NOW + 9_000;

    expect(
      (
        await adapter.readiness(
          contextFor({ project: fixture, now: () => sessionClock, readiness: {} }),
        )
      ).checkedAt,
    ).toBe(sessionClock);
    expect(
      (await adapter.readiness(contextFor({ project: fixture, withoutSessionClock: true })))
        .checkedAt,
    ).toBe(optionClock);
  });

  it('is deterministic and serialisable', async () => {
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).present });
    const adapter = createFetchAdapter();
    const first = await adapter.readiness(context);
    const second = await adapter.readiness(context);

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('probes nothing: the injected facts are the entire input', async () => {
    const lines: LogLine[] = [];

    vi.stubEnv('DEBUGGEN_HOST', '127.0.0.1');
    vi.stubEnv('DEBUGGEN_PORT', '20300');
    vi.stubEnv('DEBUGGEN_TOKEN', 'a-token-this-adapter-must-never-read');

    for (const [, readiness] of presetEntries(fixture)) {
      await expect(
        createFetchAdapter().readiness(
          contextFor({ project: fixture, readiness, logger: capturingLogger(lines) }),
        ),
      ).resolves.toBeDefined();
    }

    // No port, no process, no file: the backup store throws on contact, the
    // journal records every call, and the state root is never created.
    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('leaks nothing into the rows it reports', async () => {
    for (const [, readiness] of presetEntries(fixture)) {
      const report = await createFetchAdapter().readiness(
        contextFor({ project: fixture, readiness }),
      );

      expectNoLeak([JSON.stringify(report)], 'a readiness report');
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * remove — nothing to undo on disk
 *
 * The page agent puts the original `fetch` and `XMLHttpRequest` back when the
 * service sends an all-false `agent.config`; restoration of a patched file
 * belongs to `../cleanup.ts`, chain-aware and in strict reverse order. This
 * adapter reports what is no longer observing the application, and nothing
 * else.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A modification record belonging to some other adapter.
 *
 * This adapter never produces one, but `../cleanup.ts` hands a removal the
 * records a session holds — so a case can prove the request adapter claims no
 * restoration it did not perform.
 *
 * @returns The record.
 */
function foreignRecord(): ModificationRecord {
  const created = createModificationRecord(
    {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      file: 'src/decks/other-deck.ts',
      originalHash: sha256Hex('the bytes another adapter found'),
      instrumentedHash: sha256Hex('the bytes another adapter wrote'),
      backupPath: `${STATE_ROOT}/backups/${SESSION_ID}/${sha256Hex('the bytes another adapter found')}`,
      diff: '--- a/src/decks/other-deck.ts\n+++ b/src/decks/other-deck.ts\n',
      status: 'applied',
    },
    { now: frozenClock },
  );

  if (!created.ok) {
    throw new Error(`the suite could not build a record: ${created.error.message}`);
  }

  return created.value;
}

describe('remove', () => {
  it('has nothing to restore and nothing in conflict', async () => {
    for (const reason of ['session-end', 'rollback', 'reconcile'] as const) {
      const result = await removeFor(fixture, reason);

      expect(result.adapterId).toBe(FETCH_ADAPTER_ID);
      expect(result.restored, `a '${reason}' removal must restore nothing`).toEqual([]);
      expect(result.conflicts).toEqual([]);
    }

    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
  });

  it('names the hooks it relinquished, except on a reconcile', async () => {
    expect((await removeFor(fixture, 'session-end')).runtimeHooksDisabled).toEqual(
      expectedHookLabels(),
    );
    expect((await removeFor(fixture, 'rollback')).runtimeHooksDisabled).toEqual(
      expectedHookLabels(),
    );

    // A reconciled session belongs to a process that is gone, so its page
    // hooks went with it and there is nothing to detach.
    expect((await removeFor(fixture, 'reconcile')).runtimeHooksDisabled).toEqual([]);
  });

  it('answers the same way with installed actions and with none', async () => {
    const plan = await wholePlan(fixture);
    const adapter = createFetchAdapter();
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).present });
    const armed = await adapter.install(plan, context);

    expect(armed.runtimeHooks).toEqual(expectedHookLabels());

    const afterInstall = await adapter.remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, reason: 'session-end' },
      context,
    );
    const withoutInstall = await createFetchAdapter().remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, reason: 'session-end' },
      context,
    );

    expect(afterInstall).toEqual(withoutInstall);
  });

  it('claims no restoration for a record another adapter produced', async () => {
    const record = foreignRecord();
    const result = await removeFor(fixture, 'session-end', [record]);

    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result).toEqual(await removeFor(fixture, 'session-end', []));
    expect(journalEvents).toEqual([]);
  });

  it('converges when called again', async () => {
    const first = await removeFor(fixture, 'session-end');
    const second = await removeFor(fixture, 'session-end');
    const third = await removeFor(fixture, 'session-end');

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('writes nothing and reads no environment', async () => {
    const lines: LogLine[] = [];

    vi.stubEnv('DEBUGGEN_HOME', '/tmp/a-state-root-this-adapter-must-not-read');

    await createFetchAdapter().remove(
      { sessionId: SESSION_ID, reason: 'session-end' },
      contextFor({ project: fixture, logger: capturingLogger(lines) }),
    );

    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);

    for (const line of lines) {
      expect(line.fields['adapter']).toBe(FETCH_ADAPTER_ID);
    }
  });

  it('leaks nothing into the hooks it reports disabling', async () => {
    for (const reason of ['session-end', 'rollback', 'reconcile'] as const) {
      const result = await removeFor(fixture, reason, [foreignRecord()]);

      expectNoLeak([JSON.stringify(result)], 'a removal report');
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The import boundary
 *
 * A static read of the adapter's own source. Everything above proves what the
 * adapter *does*; this group proves what it is *able* to do — a module that
 * imported the registry that constructs it, the installer that calls it, the
 * patch layer that writes, or a Node builtin could route itself, write around
 * the journal, or stop being a pure function of what it was handed.
 * ---------------------------------------------------------------------------------------------- */

/** The only module specifiers `./fetch.ts` may import. */
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
  { label: 'the message layer above it', pattern: /@debuggen\/protocol/u },
  { label: 'the panel packages above it', pattern: /@debuggen\/panel-(?:schema|renderer)/u },
  { label: 'the registry that constructs it', pattern: /\.\.\/registry\.js/u },
  { label: 'the installer that calls it', pattern: /\.\.\/installer\.js/u },
  { label: 'the cleanup module that restores after it', pattern: /\.\.\/cleanup\.js/u },
  // The patch layer is the only writer of a developer's working tree, and this
  // adapter arms a runtime hook: it has nothing to write and nothing to
  // restore, so a reference to that layer would be a second writer.
  { label: 'the patch layer', pattern: /\.\.\/patch\//u },
  { label: 'the modification journal it never appends to', pattern: /\.\.\/schema\/modification/u },
  { label: 'the environment', pattern: /\bprocess\s*\.\s*env\b/u },
  { label: 'the console', pattern: /\bconsole\s*\./u },
  { label: 'a Node builtin', pattern: /(['"])node:[^'"]*\1|\bnode:[a-z]/u },
];

/**
 * The adapter's source with its comments removed.
 *
 * Comments have to go before anything is matched: this module's prose
 * *discusses* the registry, the patch layer, the cleanup module and the
 * telemetry agent by name — which is exactly why it must not import them — and
 * a guard that scanned the prose would report the explanation as the
 * violation.
 *
 * @returns The comment-free source.
 */
function adapterSourceWithoutComments(): string {
  return readFileSync(ADAPTER_SOURCE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

/** Every string literal the comment-free source carries. */
function adapterStringLiterals(): readonly string[] {
  const literals = new Set<string>();

  for (const match of adapterSourceWithoutComments().matchAll(
    /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/gu,
  )) {
    const value = match[2];

    if (value !== undefined) {
      literals.add(value);
    }
  }

  return [...literals];
}

describe('the import boundary', () => {
  it('leaves code behind after the comments are stripped', () => {
    const stripped = adapterSourceWithoutComments();

    // Without this, a stripping accident would make every assertion below
    // pass against an empty string.
    expect(stripped).toContain('export function createFetchAdapter');
    expect(stripped).toContain(`export const FETCH_ADAPTER_ID = '${FETCH_ADAPTER_ID}'`);
    expect(stripped).toContain('canHandle');
    expect(stripped).not.toContain('/*');

    // This module carries no scheme prefix and no path literal at all, so
    // nothing legitimate can leave a `//` behind: one here would be a comment
    // the stripper missed, and the guards below would be reading prose.
    expect(stripped).not.toContain('//');
  });

  it('imports exactly the specifiers its layer allows', () => {
    const stripped = adapterSourceWithoutComments();
    const specifiers = new Set<string>();

    for (const pattern of [
      /\bfrom\s*(['"])([^'"]+)\1/gu,
      /\bimport\s*(['"])([^'"]+)\1/gu,
      /\bimport\s*\(\s*(['"])([^'"]+)\1/gu,
      /\brequire\s*\(\s*(['"])([^'"]+)\1/gu,
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
    const relatives: string[] = [];

    for (const pattern of [
      /\bfrom\s*(['"])(\.[^'"]*)\1/gu,
      /\bimport\s*\(\s*(['"])(\.[^'"]*)\1/gu,
    ]) {
      for (const match of stripped.matchAll(pattern)) {
        relatives.push(match[2] ?? '');
      }
    }

    expect(relatives.length).toBeGreaterThan(0);

    for (const specifier of relatives) {
      // NodeNext resolution, which is what this package is type-checked and
      // run under: an extensionless relative specifier is a compile error and
      // an unresolvable import at run time.
      expect(specifier, `relative import '${specifier}' must name a .js file`).toMatch(/\.js$/u);
    }
  });

  it('reaches for nothing outside that boundary', () => {
    const stripped = adapterSourceWithoutComments();

    for (const { label, pattern } of FORBIDDEN_SOURCE_PATTERNS) {
      const match = pattern.exec(stripped);

      expect(
        match === null ? undefined : match[0],
        `./fetch.ts must not reach for ${label}`,
      ).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * No URL of its own (AAP §0.5.4)
 *
 * The assertion this file owes the repository. `scripts/check-no-hardcoding.mjs`
 * is the AST-aware, policy-driven, repository-wide half; this is the same rule
 * asserted where the adapter lives, and it is specific enough to catch a single
 * accidental path in the one module whose whole subject is paths.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a string literal reads as a route, a URL or a query fragment.
 *
 * Four shapes, all of them things this module must receive as data rather than
 * carry: a literal containing `/api`, a literal beginning with a path
 * separator followed by anything, a scheme, and a query fragment with a
 * parameter assignment. A bare `'/'` would be the one exempt form and this
 * module carries none.
 *
 * @param literal The literal to judge.
 * @returns `true` when the literal is route- or URL-shaped.
 */
function looksLikeUrlKnowledge(literal: string): boolean {
  if (literal.includes('/api')) {
    return true;
  }

  if (literal.startsWith('/') && literal.length > 1) {
    return true;
  }

  if (/:\/\/./u.test(literal)) {
    return true;
  }

  return literal.startsWith('?') || /\?[A-Za-z0-9_[\]%.-]+=/u.test(literal);
}

describe('no URL of its own', () => {
  it('finds the guard able to recognise a route-shaped literal at all', () => {
    // A guard that recognised nothing would pass this file vacuously, so its
    // own sensitivity is asserted first — against the corpora's real paths and
    // against the one URL a page agent reported.
    for (const project of [fixture, mixed, duplicate, manyOwners]) {
      for (const path of graphSuppliedPaths(project)) {
        expect(looksLikeUrlKnowledge(path), `'${path}' must read as URL knowledge`).toBe(true);
      }
    }

    expect(looksLikeUrlKnowledge(AGENT_DOCUMENT_URL)).toBe(true);
    expect(looksLikeUrlKnowledge('?slip=ferry-nine')).toBe(true);

    // And the product's own vocabulary is not caught by it.
    for (const benign of [...FETCH_RUNTIME_HOOK_LABELS, FETCH_ADAPTER_ID, 'fetch-tracking']) {
      expect(looksLikeUrlKnowledge(benign), `'${benign}' must not read as URL knowledge`).toBe(
        false,
      );
    }
  });

  it('carries no route path, URL, absolute path or query fragment as a literal', () => {
    const literals = adapterStringLiterals();

    expect(literals.length).toBeGreaterThan(0);

    for (const literal of literals) {
      expect(
        looksLikeUrlKnowledge(literal) ? literal : undefined,
        `./fetch.ts must not carry the URL-shaped literal ${JSON.stringify(literal)}`,
      ).toBeUndefined();
    }
  });

  it('names nothing from any corpus in its own source', () => {
    const stripped = adapterSourceWithoutComments();
    const names = [fixture, mixed, duplicate, manyOwners].flatMap((project) =>
      distinctiveNames(project),
    );

    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      expect(stripped, `./fetch.ts must not carry the project name '${name}'`).not.toContain(name);
    }
  });

  it('states only the values the graph gave it, on corpora it has never seen', async () => {
    const foreign = distinctiveNames(fixture);

    expect(foreign.length).toBeGreaterThan(0);

    for (const project of [mixed, duplicate, manyOwners]) {
      const actions = await wholePlan(project);
      const permittedSymbols = new Set(
        apiCalls(project).map((node) => must(expectedAnchorOf(project, node), 'an owner symbol')),
      );
      const permittedPaths = graphSuppliedPaths(project);

      expect(actions.length).toBeGreaterThan(0);

      for (const action of actions) {
        expect(permittedSymbols.has(action.symbol)).toBe(true);
        expect(action.rationale).toContain(action.symbol);

        for (const name of foreign) {
          expect(
            action.rationale,
            `a rationale for one project must not name another's '${name}'`,
          ).not.toContain(name);
        }

        // Every path-shaped token in the sentence has to be a value the graph
        // supplied: the adapter's own prose carries no separator at all, so
        // anything with one came from data or from a literal that must not
        // exist.
        for (const token of action.rationale.match(/\S*\/\S*/gu) ?? []) {
          const trimmed = token.replace(/[.,;:]+$/u, '');

          expect(
            permittedPaths.has(trimmed),
            `'${trimmed}' in a rationale must be a path this project's graph supplied`,
          ).toBe(true);
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The committed corpus is left exactly as it was found
 * ---------------------------------------------------------------------------------------------- */

describe('the committed corpus', () => {
  it('is byte-for-byte as it was before the suite ran', () => {
    // Every case above has run by now. This adapter writes nothing at all, so
    // the claim is cheap to make and worth asserting anyway: it is what keeps
    // `git status --porcelain packages/instrumentation/test/fixtures` empty
    // after `pnpm test` (AAP §0.5.1, §0.8.4 acceptance test 3).
    expect(treeSnapshot(FIXTURE_ROOT)).toEqual(fixtureSnapshotBefore);
    expect(existsSync(STATE_ROOT)).toBe(false);
  });
});
