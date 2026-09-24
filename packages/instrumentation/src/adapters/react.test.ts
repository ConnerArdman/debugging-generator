/**
 * The suite for `./react.ts` — the runtime-mode adapter that arms the page
 * agent's fiber hook so React renders, commits, state transitions and the
 * component-tree snapshot become evidence.
 *
 * Three claims are what make this adapter correct rather than merely present,
 * and every group below exists to hold one of them:
 *
 * 1. **Every target comes out of the code graph.** A component is armed because
 *    the React-component extractor of `@debuggen/code-analysis` recorded a
 *    declaration for it, never because a name was recognised (AAP §0.5.4). No
 *    component name below is written as an *expectation*: each one is read off
 *    the graph a case indexed, and the scratch corpora carry deliberately
 *    meaningless identifiers this product has never seen, so an adapter that
 *    matched names instead of reading the graph would find nothing in them.
 * 2. **Readiness is a pure function of injected facts.** The only input is
 *    `context.readiness.browserAgent` — the `agent.ready` the service relayed
 *    for the bound tab's current document (AAP §0.5.5) — and the case that
 *    matters most is `installedBeforeReact === false`: a page whose React
 *    loaded before the fiber hook was installed can be fixed by **one reload**,
 *    and the hint has to say so, because that is the recovery the panel offers
 *    as a click and the service performs with a consented `chrome.tabs.reload`
 *    (AAP §0.7.1 Group 4). Nothing here probes a port, reads the environment or
 *    retries a connection.
 * 3. **Nothing is written.** React signals are runtime signals (AAP §0.5.1), so
 *    `InstallResult.applied` is always empty, no modification record is ever
 *    journaled and no backup is ever taken. Every context in this file carries
 *    a backup store that throws on contact and a journal that records every
 *    call, so "wrote nothing" is *asserted* rather than assumed — and the state
 *    directory the context names is never created, which one case checks after
 *    everything else has run.
 *
 * ## The corpora, and why there are five
 *
 * The adapter's input contract is a real `CodeGraph`, so every corpus is built
 * through the product's own path — `openProject` → `buildIndex` →
 * `CodeGraph.fromIndex` → `buildRouteMap` → `createCodeQueries` →
 * `summarizeProject`. That pair is deliberately the **cache-free** build:
 * `indexProject` would consult and populate `$DEBUGGEN_HOME/index`, which a
 * unit suite must not touch.
 *
 * - `test/fixtures/project-a`, **read-only**, indexed once. Its component
 *   evidence is one `'use client'` module, one server module that renders it,
 *   one further component in an unconverted `.jsx` corner, and exactly **one**
 *   `renders` edge. The one-hop neighbourhood logic therefore has to work at
 *   n = 1, which is the whole point of the corpus being small, and the
 *   client-before-server ranking has something real to order.
 * - A **pair** scratch corpus: one client component rendered by one server
 *   component, with arbitrary names. It is where the behavioural
 *   no-hardcoding guard runs, because an adapter that carried a name of its own
 *   could not produce these sentences.
 * - A **many-component** scratch corpus with more client components than one
 *   proposal may contain, which is what makes the exported target cap
 *   observable rather than merely declared.
 * - A **hand-authored `CodeIndex`** with no component node. A project with code
 *   but no React component is a deliberate capability decision — `canHandle`
 *   false, an empty proposal, a ready report with no rows — and it is the one
 *   input not worth writing a source tree for.
 * - The **committed fixture again, at the end**, hashed before and after, so
 *   the claim that this adapter writes nothing is asserted against bytes on
 *   disk and not only against a result object.
 *
 * Nothing here needs a network, a browser, a dev server or a working tree, and
 * no case writes inside the repository: the scratch corpora live in their own
 * `mkdtemp` directories and are removed in `afterAll`.
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
import type { LogFields, Logger } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  AdapterRemoveReason,
  InstallResult,
  InstrumentationContext,
  ObservedBrowserAgent,
  ObservedReadinessInputs,
  RemoveResult,
} from '../adapter.js';
import { createModificationRecord } from '../schema/modification.js';
import type { ModificationJournal, ModificationRecord } from '../schema/modification.js';
import {
  ACTION_ID_PATTERN,
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  instrumentationActionSchema,
} from '../schema/plan.js';
import type { InstrumentationAction } from '../schema/plan.js';
import {
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  READINESS_STATUSES,
  agentHookConfigSchema,
  readinessSchema,
} from '../schema/readiness.js';
import type { AgentHookConfig, CaptureSignal, Readiness } from '../schema/readiness.js';
import { problemUnderstandingSchema, selectedTargetSchema } from '../schema/target.js';
import type { ProblemUnderstanding, SelectedTarget } from '../schema/target.js';

import {
  REACT_ADAPTER_ACTION_TYPES,
  REACT_ADAPTER_CLAIMS,
  REACT_ADAPTER_HOOK_KEYS,
  REACT_ADAPTER_ID,
  REACT_ADAPTER_LIMITS,
  REACT_ADAPTER_RUNTIME_HOOK_LABELS,
  REACT_ADAPTER_SIGNALS,
  createReactAdapter,
  isReactAdapterActionType,
} from './react.js';
import type { ReactAdapter, ReactAdapterActionType, ReactAdapterHookKey } from './react.js';

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

/** The fixture's own standalone TypeScript configuration, named explicitly. */
const FIXTURE_TSCONFIG = toPosix(
  fileURLToPath(new URL('../../test/fixtures/project-a/tsconfig.json', import.meta.url)),
);

/** The adapter's own source, for the static import-boundary guard. */
const ADAPTER_SOURCE_PATH = fileURLToPath(new URL('./react.ts', import.meta.url));

/** The session every context in this suite belongs to. */
const SESSION_ID = 'ses_reactadapter0001';

/** The plan revision every context stamps. */
const PLAN_VERSION = 2;

/** A fixed moment, so every clock-dependent assertion is exact. */
const NOW = 1_700_000_000_000;

/** A clock frozen at {@link NOW}. */
const frozenClock = (): number => NOW;

/**
 * The prefix an action id carries, taken from the generator that mints them.
 *
 * Derived rather than written out: `newActionId` in `@debuggen/shared` owns the
 * id vocabulary, and an assertion that spelled the prefix itself would keep
 * passing if the generator's ever moved — which is precisely the mismatch that
 * would leave the installer unable to look an action back up.
 */
const ACTION_ID_PREFIX = `${newActionId().split('_')[0] ?? ''}_`;

/**
 * A state root no case may reach.
 *
 * This adapter writes nothing, so the directory is never created: it exists as
 * a value the context requires, and the throwing backup store below is what
 * proves nothing went looking for it. One case asserts it is still absent after
 * the whole suite has run.
 */
const STATE_ROOT = toPosix(join(tmpdir(), 'debuggen-react-suite-state-never-written'));

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

  /** The project summary this adapter deliberately does *not* read. */
  readonly projectSummary: ProjectSummary;
}

/**
 * Indexes one project through the product's own path.
 *
 * The cache-free build (`openProject` + `buildIndex`) rather than
 * `indexProject`, which would read and write `$DEBUGGEN_HOME/index`.
 *
 * @param root The project root to index.
 * @param tsConfigFilePath The project's own configuration, when it is worth
 * naming rather than probing.
 * @returns Every handle a context is built from.
 */
async function indexProjectTree(root: string, tsConfigFilePath?: string): Promise<IndexedProject> {
  const opened = openProject({
    projectRoot: root,
    ...(tsConfigFilePath === undefined ? {} : { tsConfigFilePath }),
  });

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
    projectSummary: summarizeProject({
      loaded: opened.value,
      index: built.value,
      graph,
      routeMap,
    }),
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
 * Nothing in the tree is ever installed, so the `react` specifiers these
 * modules would need are deliberately absent: the extractors are AST-only and
 * so is every assertion below.
 *
 * @param label A short, human-readable name for the temporary directory.
 * @param files Project-relative POSIX paths mapped to file contents.
 * @returns The indexed scratch project.
 */
async function scratchProject(
  label: string,
  files: Readonly<Record<string, string>>,
): Promise<IndexedProject> {
  const root = mkdtempSync(join(tmpdir(), `debuggen-react-${label}-`));

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
 * One `symbol` node, hand-authored, so the component-free corpus still has a
 * declaration in it.
 *
 * Without one, "this project has no React component" and "this project has no
 * code" would be the same input, and the capability decision under test is the
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

/**
 * Every file of a tree with its SHA-256, sorted, so two snapshots compare
 * byte-for-byte.
 *
 * @param root The tree to hash.
 * @returns One `path digest` line per file, sorted.
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
 * Fails the suite immediately, and with the reason, when a lookup a case
 * depends on found nothing.
 *
 * @param value The value that should exist.
 * @param what What it was.
 * @returns The value, narrowed.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the suite expected ${what} to exist in this corpus`);
  }

  return value;
}

/* -------------------------------------------------------------------------------------------------
 * The scratch corpora
 *
 * Every identifier below is arbitrary: a component name, a prop name and a file
 * path this product has never seen and never will. That is the behavioural half
 * of AAP §0.5.4 — an adapter that recognised names rather than reading the
 * graph would find nothing here — and it is what lets the no-hardcoding group
 * compare one corpus's names against another's.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The pair corpus: one client component rendered by one server component.
 *
 * The same shape the committed fixture offers, with names of its own, so a
 * rationale built over this corpus can be checked for naming *only* what this
 * graph supplied.
 */
const PAIR_SOURCES: Readonly<Record<string, string>> = {
  'src/panels/LanternDrumPanel.tsx': [
    "'use client';",
    '',
    'export function LanternDrumPanel({ drumId }: { drumId: string }) {',
    '  return <span data-drum={drumId}>drum</span>;',
    '}',
    '',
  ].join('\n'),
  'src/panels/HarborKelpShell.tsx': [
    "import { LanternDrumPanel } from './LanternDrumPanel';",
    '',
    'export function HarborKelpShell() {',
    '  return (',
    '    <section>',
    '      <LanternDrumPanel drumId="north" />',
    '    </section>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

/** How many client components the many-component corpus declares. */
const MANY_COMPONENT_COUNT = 12;

/**
 * A corpus with more client components than one proposal may contain.
 *
 * `MANY_COMPONENT_COUNT` is deliberately above
 * `REACT_ADAPTER_LIMITS.defaultMaxTargets` and below its `maxMaxTargets`, so
 * the default cap, a clamped-up request and a clamped-down one are all
 * observable against the same graph.
 */
const MANY_COMPONENT_SOURCES: Readonly<Record<string, string>> = {
  'src/panels/facets.tsx': [
    "'use client';",
    '',
    ...Array.from(
      { length: MANY_COMPONENT_COUNT },
      (_unused, index) =>
        `export function DrumFacet${String(index).padStart(2, '0')}() {\n  return <span>facet</span>;\n}\n`,
    ),
  ].join('\n'),
};

/* -------------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

/** The committed fixture, indexed once. */
let fixture: IndexedProject;

/** One client component rendered by one server component, arbitrary names. */
let pair: IndexedProject;

/** More client components than one proposal may hold. */
let manyComponents: IndexedProject;

/** A project with code but no React component, from a hand-authored index. */
let componentFree: IndexedProject;

/** Every file of the committed fixture with its SHA-256, taken before anything ran. */
let fixtureSnapshotBefore: readonly string[];

beforeAll(async () => {
  fixtureSnapshotBefore = treeSnapshot(FIXTURE_ROOT);
  fixture = await indexProjectTree(FIXTURE_ROOT, FIXTURE_TSCONFIG);
  pair = await scratchProject('pair', PAIR_SOURCES);
  manyComponents = await scratchProject('many', MANY_COMPONENT_SOURCES);
  componentFree = projectFromIndex(
    handAuthoredIndex(toPosix(join(tmpdir(), 'debuggen-react-component-free')), [
      symbolNode('src/kilns/calm-arithmetic.ts', 'combineCalmTallies'),
    ]),
    fixture,
  );
}, 180_000);

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  scratchRoots.length = 0;
});

/* -------------------------------------------------------------------------------------------------
 * Corpus facts, read from the graph
 *
 * Nothing below names a component: each helper asks the graph a structural
 * question — "which components are client components?", "which component does
 * the one render edge start at?" — so that an assertion and the adapter cannot
 * agree by both restating the same literal, and a corpus whose shape changed
 * fails the precondition group rather than passing something vacuously.
 * ---------------------------------------------------------------------------------------------- */

/** A `component` node of a corpus's graph. */
type ComponentNode = CodeNodeOf<'component'>;

/**
 * Every component the graph holds, in the graph's own order.
 *
 * @param project The indexed project.
 * @returns The component nodes.
 */
function componentsOf(project: IndexedProject): readonly ComponentNode[] {
  return project.graph.nodesByKind('component');
}

/**
 * The components that render in the browser: the ones declared in a
 * `'use client'` module.
 *
 * @param project The indexed project.
 * @returns The client components.
 */
function clientComponentsOf(project: IndexedProject): readonly ComponentNode[] {
  return componentsOf(project).filter((component) => component.data.isClient);
}

/**
 * The components that never render in the browser.
 *
 * @param project The indexed project.
 * @returns The server components.
 */
function serverComponentsOf(project: IndexedProject): readonly ComponentNode[] {
  return componentsOf(project).filter((component) => !component.data.isClient);
}

/** One `renders` relationship, as node handles rather than ids. */
interface RenderEdge {
  /** The component whose markup renders the other: the parent. */
  readonly parent: ComponentNode;

  /** The component it renders: the child. */
  readonly child: ComponentNode;
}

/**
 * Every component-to-component `renders` relationship the graph records.
 *
 * Read through `neighbors`, which is the same traversal the adapter performs,
 * so a case can state the neighbourhood it expects without knowing which
 * component is in it.
 *
 * @param project The indexed project.
 * @returns The relationships, one entry per edge.
 */
function renderEdgesOf(project: IndexedProject): readonly RenderEdge[] {
  const edges: RenderEdge[] = [];

  for (const parent of componentsOf(project)) {
    for (const child of project.graph.neighbors(parent.id, {
      kind: 'renders',
      direction: 'out',
    })) {
      if (child.kind === 'component') {
        edges.push({ parent, child });
      }
    }
  }

  return edges;
}

/**
 * The single `renders` relationship a corpus with one of them holds.
 *
 * @param project The indexed project.
 * @returns The relationship.
 */
function soleRenderEdgeOf(project: IndexedProject): RenderEdge {
  const edges = renderEdgesOf(project);

  if (edges.length !== 1) {
    throw new Error(
      `the suite expected exactly one renders edge in this corpus, found ${String(edges.length)}`,
    );
  }

  return must(edges[0], 'the corpus’s one renders edge');
}

/**
 * The names of a corpus's components, which is the only vocabulary a proposal
 * over it may contain.
 *
 * @param project The indexed project.
 * @returns The names.
 */
function componentNamesOf(project: IndexedProject): readonly string[] {
  return componentsOf(project).map((component) => component.name);
}

/* -------------------------------------------------------------------------------------------------
 * The collaborators, as doubles that record or refuse
 * ---------------------------------------------------------------------------------------------- */

/** One call a case observed on the journal. */
interface JournalEvent {
  /** Which port method was called. */
  readonly method: 'append' | 'updateStatus' | 'listBySession' | 'listOpen';

  /** Enough of the argument to identify the call in a failure message. */
  readonly subject: string;
}

/** Every journal call this suite observed, in order. */
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

    throw new Error('the React adapter must never update a modification record');
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
    throw new Error('the React adapter must never locate a backup');
  },
  locateRecorded: () => {
    throw new Error('the React adapter must never locate a recorded backup');
  },
  put: () => {
    throw new Error('the React adapter must never write a backup');
  },
  read: () => {
    throw new Error('the React adapter must never read a backup');
  },
  readRecorded: () => {
    throw new Error('the React adapter must never read a recorded backup');
  },
  has: () => {
    throw new Error('the React adapter must never query a backup');
  },
  verify: () => {
    throw new Error('the React adapter must never verify a backup');
  },
  remove: () => {
    throw new Error('the React adapter must never remove a backup');
  },
  removeRecorded: () => {
    throw new Error('the React adapter must never remove a recorded backup');
  },
  removeSessionDirectory: () => {
    throw new Error('the React adapter must never remove a backup directory');
  },
};

/** How many journal calls had been observed when a case started. */
function journalCallCount(): number {
  return journalEvents.length;
}

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

/**
 * Every string a captured line could carry, flattened.
 *
 * Used by the privacy assertions: a log field is as much an egress as a result
 * field, so "no source text leaked" has to be asked of both.
 *
 * @param lines The captured lines.
 * @returns Every message and every stringified field value.
 */
function logText(lines: readonly LogLine[]): readonly string[] {
  const text: string[] = [];

  for (const line of lines) {
    text.push(line.message);

    for (const value of Object.values(line.fields)) {
      if (typeof value === 'string') {
        text.push(value);

        continue;
      }

      // `JSON.stringify` answers `undefined` for `undefined`, and a field that
      // is legitimately absent — the obstacle kind of a healthy install — must
      // still be flattened to something a substring check can be run against.
      text.push(JSON.stringify(value) ?? String(value));
    }
  }

  return text;
}

/* -------------------------------------------------------------------------------------------------
 * The observed readiness inputs, as named presets
 *
 * The whole of this adapter's readiness input. Each preset is a state the
 * service can genuinely have observed and relayed, and the three unhealthy ones
 * are precisely the three obstacles AAP §0.5.5 gives this adapter a sentence
 * for.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The document URL a page agent reports.
 *
 * Already query-redacted by the time it reaches an adapter (AAP §0.5.2), so the
 * parameter is present and its value is not — which is the shape this suite
 * asserts the adapter passes through unchanged rather than re-deriving.
 */
const AGENT_DOCUMENT_URL = 'http://127.0.0.1:20171/shelves?kiln=?';

/** The named page-agent states a case selects from. */
interface AgentPresets {
  /** No `agent.ready` has arrived for the bound tab's current document. */
  readonly absent: ObservedReadinessInputs;

  /** A page agent reported before React loaded, with React detected. */
  readonly healthy: ObservedReadinessInputs;

  /**
   * A page agent reported, but the fiber hook was installed after React had
   * loaded.
   *
   * The page that was already open when the extension arrived. React attaches
   * to the hook at mount, so a hook installed later observes nothing — and the
   * recovery is a single reload, which is the one message this adapter must get
   * right (AAP §0.5.5, §0.7.1 Group 4).
   */
  readonly hookInstalledLate: ObservedReadinessInputs;

  /**
   * A page agent reported from a document with no React root on it.
   *
   * A legitimate answer about a legitimate page: the hooks are armed and will
   * observe the root when it mounts, so this degrades the capture rather than
   * refusing it.
   */
  readonly reactUndetected: ObservedReadinessInputs;

  /**
   * A dev-server preload is attached and no page agent has reported.
   *
   * Server-tier evidence is not this adapter's evidence at all, so this preset
   * must read exactly like {@link AgentPresets.absent}.
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
 * @returns The five named states.
 */
function agentPresets(project: IndexedProject): AgentPresets {
  const reported = (overrides: Partial<ObservedBrowserAgent> = {}): ObservedBrowserAgent => ({
    producerId: 'prd_reactadapter001',
    documentId: 'doc_reactadapter001',
    url: AGENT_DOCUMENT_URL,
    installedBeforeReact: true,
    reactDetected: true,
    observedAt: NOW - 1_000,
    ...overrides,
  });

  return {
    absent: {},
    healthy: { browserAgent: reported() },
    hookInstalledLate: { browserAgent: reported({ installedBeforeReact: false }) },
    reactUndetected: { browserAgent: reported({ reactDetected: false }) },
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

/**
 * The preset names under which this adapter can observe a commit at all.
 *
 * `reactUndetected` is among them: the hooks are armed and the gap is reported
 * as a narrower capture, which is the non-blocking half of AAP §0.5.5.
 */
const ARMING_PRESETS: readonly (keyof AgentPresets)[] = ['healthy', 'reactUndetected'];

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

  /**
   * A selected element, carried on the context the way the service carries the
   * session's `target?`.
   *
   * `InstrumentationContext` declares no target member — the adapter reads one
   * structurally when a caller carries it — so a case that supplies one is
   * describing the service's real behaviour rather than a contract this suite
   * invented.
   */
  readonly target?: SelectedTarget | undefined;

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
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Stage artifacts — validated, never ad-hoc objects
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds a validated problem understanding.
 *
 * Parsed through the stage's own schema rather than cast, so a case cannot hand
 * this adapter an artifact the pipeline would have rejected — which would make
 * a passing assertion say nothing about production behaviour.
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
    category: 'rendering',
    signalsNeeded: [...signalsNeeded],
    entities: entities.map((entity) => ({ ...entity })),
    searchHints: [...searchHints],
  });
}

/**
 * The understanding a render question produces when nothing narrowed it.
 *
 * `'react'` and `'componentTree'` are the two render-side members of the closed
 * capture vocabulary, read from {@link CAPTURE_SIGNALS} rather than spelled, so
 * a change to that vocabulary fails the precondition group.
 */
const RENDER_SIGNALS: readonly CaptureSignal[] = ['react', 'componentTree'];

/** The state-side member of the same vocabulary. */
const STATE_SIGNAL: CaptureSignal = 'state';

/**
 * Builds a validated selected target whose chain names the given components.
 *
 * Parsed through `selectedTargetSchema`, so the chain a case supplies is one
 * the `target.selected` message could actually have carried.
 *
 * @param componentChain Composite component display names, nearest first.
 * @returns The selected target.
 */
function selectedTargetFor(componentChain: readonly string[]): SelectedTarget {
  return selectedTargetSchema.parse({
    selector: 'section > span',
    tagName: 'SPAN',
    text: 'drum',
    componentChain: [...componentChain],
    url: AGENT_DOCUMENT_URL,
  });
}

/**
 * An action of another adapter, to be handed to `install` alongside this
 * adapter's own.
 *
 * Validated through the plan's action schema so the mixed list is one the
 * installer could really have assembled.
 *
 * @returns The foreign action.
 */
function foreignAction(): InstrumentationAction {
  return instrumentationActionSchema.parse({
    id: 'act_aaaaaaaaaaaaaaaa',
    file: 'src/kilns/calm-arithmetic.ts',
    symbol: 'combineCalmTallies',
    type: 'fetch-tracking',
    adapter: 'fetch',
    mode: 'runtime',
    rationale: 'Another adapter proposed this, and the React adapter must ignore it.',
  });
}

/**
 * An action carrying this adapter's id but a type it never claims.
 *
 * The other half of the "ignored silently" rule: a type filter that only
 * checked the adapter id would arm nothing for it and still count it.
 *
 * @returns The unclaimed-type action.
 */
function unclaimedTypeAction(): InstrumentationAction {
  return instrumentationActionSchema.parse({
    id: 'act_bbbbbbbbbbbbbbbb',
    file: 'src/kilns/calm-arithmetic.ts',
    symbol: 'combineCalmTallies',
    type: 'db-query-tracking',
    adapter: REACT_ADAPTER_ID,
    mode: 'runtime',
    rationale: 'A type this adapter does not claim, carried under its own id.',
  });
}

/**
 * Strips the freshly minted id from an action, so two proposals can be compared
 * for everything they are supposed to agree about.
 *
 * @param action The action.
 * @returns The action without its id.
 */
function withoutId(action: InstrumentationAction): Omit<InstrumentationAction, 'id'> {
  // Enumerated rather than destructured with a discarded binding: the field set
  // is what determinism is a claim about, so a field added to the action schema
  // has to be considered here rather than silently swept into a rest element.
  return {
    file: action.file,
    symbol: action.symbol,
    type: action.type,
    adapter: action.adapter,
    mode: action.mode,
    rationale: action.rationale,
  };
}

/**
 * Completes an adapter's hook contribution into a whole `AgentHookConfig`.
 *
 * A contribution is a `Partial` by contract — an adapter speaks only for the
 * hooks it owns, and one adapter's explicit `false` must not overwrite
 * another's `true` — so the dormant baseline is what the missing flags fall
 * back to, exactly as `deriveAgentHookConfig` starts from it.
 *
 * @param contribution The adapter's partial contribution.
 * @returns A complete configuration, validated by its own schema.
 */
function completeHookConfig(contribution: Partial<AgentHookConfig> | undefined): AgentHookConfig {
  return agentHookConfigSchema.parse({ ...DORMANT_AGENT_HOOK_CONFIG, ...contribution });
}

/**
 * Names a set of this adapter's hook keys the way it reports them: through the
 * declared label table, sorted by code unit.
 *
 * The expectation for both `InstallResult.runtimeHooks` and
 * `RemoveResult.runtimeHooksDisabled` is derived here rather than written out,
 * so a case asserts the *rule* — every owned hook, named from the table, in a
 * byte-identical order — instead of three strings that would have to be edited
 * alongside the table they come from.
 *
 * @param keys The hook keys to name.
 * @returns The labels, sorted.
 */
function hookLabelsFor(keys: readonly ReactAdapterHookKey[]): string[] {
  return keys.map((key) => REACT_ADAPTER_RUNTIME_HOOK_LABELS[key]).sort();
}

/**
 * The adapter under test, freshly constructed.
 *
 * A factory call per case rather than a shared instance where a case varies the
 * options, and a shared one is never needed: the object holds no mutable state.
 *
 * @param maxTargets The cap to request, when a case varies it.
 * @returns The adapter.
 */
function adapterWith(maxTargets?: number): ReactAdapter {
  return createReactAdapter(maxTargets === undefined ? {} : { maxTargets });
}

/* -------------------------------------------------------------------------------------------------
 * The corpora carry what the cases below assume
 *
 * Preconditions, not assertions about the adapter. If the committed fixture
 * stopped holding a client component, a server component and exactly one
 * `renders` edge, the ranking and neighbourhood cases would pass vacuously;
 * failing here turns that into one unambiguous failure instead of a suite that
 * is quietly testing nothing.
 * ---------------------------------------------------------------------------------------------- */

describe('the corpora', () => {
  it('indexed the committed fixture into a graph with components in it', () => {
    expect(fixture.root).toBe(FIXTURE_ROOT);
    expect(fixture.loaded).toBeDefined();
    expect(componentsOf(fixture).length).toBeGreaterThan(0);
    expect(fixture.graph.size.nodes).toBeGreaterThan(componentsOf(fixture).length);
  });

  it('offers the committed fixture with both a client and a server component', () => {
    expect(clientComponentsOf(fixture).length).toBeGreaterThan(0);
    expect(serverComponentsOf(fixture).length).toBeGreaterThan(0);
  });

  it('offers the committed fixture with exactly one server-renders-client edge', () => {
    const edge = soleRenderEdgeOf(fixture);

    // n = 1 is the realistic case for the one-hop neighbourhood, and the
    // direction matters: a parent's decision is why a child re-renders.
    expect(edge.parent.data.isClient).toBe(false);
    expect(edge.child.data.isClient).toBe(true);
    expect(edge.parent.id).not.toBe(edge.child.id);
  });

  it('declares every committed-fixture component where the graph says it does', () => {
    for (const component of componentsOf(fixture)) {
      expect(
        fixture.queries.hasSymbol(component.file, component.name),
        `${component.file} must declare ${component.name}`,
      ).toBe(true);
      expect(component.file.startsWith('/')).toBe(false);
      expect(component.file).not.toContain('..');
    }
  });

  it('offers a pair corpus of one client component rendered by one server component', () => {
    expect(componentsOf(pair)).toHaveLength(2);
    expect(clientComponentsOf(pair)).toHaveLength(1);
    expect(serverComponentsOf(pair)).toHaveLength(1);

    const edge = soleRenderEdgeOf(pair);

    expect(edge.parent.data.isClient).toBe(false);
    expect(edge.child.data.isClient).toBe(true);
  });

  it('offers a many-component corpus wider than the default cap and inside the ceiling', () => {
    expect(componentsOf(manyComponents)).toHaveLength(MANY_COMPONENT_COUNT);
    expect(clientComponentsOf(manyComponents)).toHaveLength(MANY_COMPONENT_COUNT);
    expect(MANY_COMPONENT_COUNT).toBeGreaterThan(REACT_ADAPTER_LIMITS.defaultMaxTargets);
    expect(MANY_COMPONENT_COUNT).toBeLessThanOrEqual(REACT_ADAPTER_LIMITS.maxMaxTargets);
  });

  it('offers a corpus with code in it but no component at all', () => {
    expect(componentsOf(componentFree)).toHaveLength(0);
    expect(componentFree.graph.size.nodes).toBeGreaterThan(0);
    expect(componentFree.loaded).toBeUndefined();
  });

  it('names nothing in common between two corpora', () => {
    // The no-hardcoding cross-check compares one corpus's vocabulary against
    // another's proposals, which is only meaningful while the two are disjoint.
    const fixtureNames = new Set(componentNamesOf(fixture));

    for (const name of [...componentNamesOf(pair), ...componentNamesOf(manyComponents)]) {
      expect(fixtureNames.has(name), `'${name}' must belong to one corpus only`).toBe(false);
    }
  });

  it('names its capture signals from the closed vocabulary', () => {
    for (const signal of [...RENDER_SIGNALS, STATE_SIGNAL]) {
      expect(CAPTURE_SIGNALS as readonly string[]).toContain(signal);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Identity and the claim declaration
 *
 * The registry resolves an action's adapter and mode from the exported claim
 * table (`../registry.ts` reads it rather than being imported back), the
 * installer looks an adapter up by its id, and `deriveAgentHookConfig` is keyed
 * by hook name — so a typo in any of the three is a plan whose actions resolve
 * to nothing or a hook that is never armed. Each is asserted against the
 * declaration that owns the vocabulary rather than against a literal.
 * ---------------------------------------------------------------------------------------------- */

describe('the React adapter identity', () => {
  it('registers under the id its claim table is read by', () => {
    expect(REACT_ADAPTER_ID).toBe('react');
    expect(adapterWith().id).toBe(REACT_ADAPTER_ID);
  });

  it('claims exactly render tracking and state tracking, both runtime', () => {
    expect([...REACT_ADAPTER_ACTION_TYPES]).toEqual(['react-render-tracking', 'state-tracking']);
    expect(Object.keys(REACT_ADAPTER_CLAIMS).sort()).toEqual(
      [...REACT_ADAPTER_ACTION_TYPES].sort(),
    );

    for (const type of REACT_ADAPTER_ACTION_TYPES) {
      expect(REACT_ADAPTER_CLAIMS[type]).toBe('runtime');
    }
  });

  it('claims only action types and modes the plan schema knows', () => {
    for (const type of REACT_ADAPTER_ACTION_TYPES) {
      expect(
        INSTRUMENTATION_ACTION_TYPES as readonly string[],
        `'${type}' must be a declared action type`,
      ).toContain(type);
      expect(isReactAdapterActionType(type)).toBe(true);
    }

    for (const mode of Object.values(REACT_ADAPTER_CLAIMS)) {
      expect(INSTRUMENTATION_MODES as readonly string[]).toContain(mode);
    }
  });

  it('refuses a type it does not claim, without narrowing it', () => {
    const unclaimed = INSTRUMENTATION_ACTION_TYPES.filter(
      (type) => !(REACT_ADAPTER_ACTION_TYPES as readonly string[]).includes(type),
    );

    expect(unclaimed.length).toBeGreaterThan(0);

    for (const type of unclaimed) {
      expect(isReactAdapterActionType(type), `'${type}' is not this adapter's`).toBe(false);
    }

    expect(isReactAdapterActionType('')).toBe(false);
    expect(isReactAdapterActionType('React-Render-Tracking')).toBe(false);
  });

  it('names only hook keys the page agent configuration actually has', () => {
    expect([...REACT_ADAPTER_HOOK_KEYS]).toEqual(['react', 'state', 'componentTree']);

    for (const key of REACT_ADAPTER_HOOK_KEYS) {
      // A typo here would silently never arm a hook: `deriveAgentHookConfig`
      // returns the whole configuration and the adapter filters it by these
      // keys, so an unknown key simply reads `undefined` and drops out.
      expect(AGENT_HOOK_KEYS as readonly string[]).toContain(key);
      expect(Object.keys(DORMANT_AGENT_HOOK_CONFIG)).toContain(key);
    }

    // It speaks for the hooks it owns and no others. `interactions` in
    // particular belongs to the installer's derivation, not to this adapter.
    expect(REACT_ADAPTER_HOOK_KEYS as readonly string[]).not.toContain('interactions');
  });

  it('reports the same three names as capture signals', () => {
    expect([...REACT_ADAPTER_SIGNALS]).toEqual([...REACT_ADAPTER_HOOK_KEYS]);

    for (const signal of REACT_ADAPTER_SIGNALS) {
      expect(CAPTURE_SIGNALS as readonly string[]).toContain(signal);
    }
  });

  it('labels every hook it owns, in words a developer can read', () => {
    expect(Object.keys(REACT_ADAPTER_RUNTIME_HOOK_LABELS).sort()).toEqual(
      [...REACT_ADAPTER_HOOK_KEYS].sort(),
    );

    const labels = new Set<string>();

    for (const key of REACT_ADAPTER_HOOK_KEYS) {
      const label = REACT_ADAPTER_RUNTIME_HOOK_LABELS[key];

      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(8);
      expect(label).not.toMatch(/[\r\n]/u);
      labels.add(label);
    }

    // Three distinct labels: two hooks sharing a name would make the editor's
    // checklist lie about what is on.
    expect(labels.size).toBe(REACT_ADAPTER_HOOK_KEYS.length);
  });

  it('bounds its own proposals, and the bounds cannot be moved', () => {
    expect(REACT_ADAPTER_LIMITS.minMaxTargets).toBeGreaterThan(0);
    expect(REACT_ADAPTER_LIMITS.defaultMaxTargets).toBeGreaterThanOrEqual(
      REACT_ADAPTER_LIMITS.minMaxTargets,
    );
    expect(REACT_ADAPTER_LIMITS.maxMaxTargets).toBeGreaterThanOrEqual(
      REACT_ADAPTER_LIMITS.defaultMaxTargets,
    );
    expect(REACT_ADAPTER_LIMITS.maxNeighbours).toBeGreaterThan(0);
    expect(REACT_ADAPTER_LIMITS.maxSeedNames).toBeGreaterThan(0);
    expect(REACT_ADAPTER_LIMITS.maxNameMatches).toBeGreaterThan(0);
    expect(Object.isFrozen(REACT_ADAPTER_LIMITS)).toBe(true);
    expect(Object.isFrozen(REACT_ADAPTER_CLAIMS)).toBe(true);
    expect(Object.isFrozen(REACT_ADAPTER_RUNTIME_HOOK_LABELS)).toBe(true);
  });

  it('allocates only when the factory is called', () => {
    // Importing the module costs a consumer nothing: everything in it is a
    // declaration, and the adapter is what the registry constructs inside
    // `createAdapterRegistry`. Two calls therefore have to be independent
    // objects that nevertheless read the same frozen tables.
    expect(typeof createReactAdapter).toBe('function');

    const first = createReactAdapter();
    const second = createReactAdapter({ maxTargets: 1 });

    expect(first).not.toBe(second);
    expect(first.id).toBe(second.id);
    expect(first.claims).toBe(REACT_ADAPTER_CLAIMS);
    expect(second.claims).toBe(REACT_ADAPTER_CLAIMS);
    expect(first.hookKeys).toBe(REACT_ADAPTER_HOOK_KEYS);
    expect(second.hookKeys).toBe(REACT_ADAPTER_HOOK_KEYS);

    // No mutable state to share: five methods and nothing else.
    expect(Object.keys(first).sort()).toEqual([
      'canHandle',
      'claims',
      'createPlan',
      'hookKeys',
      'id',
      'install',
      'readiness',
      'remove',
    ]);
  });

  it('constructs without touching a collaborator', () => {
    const before = journalCallCount();

    createReactAdapter();
    createReactAdapter({ logger: noopLogger, maxTargets: 4, now: frozenClock });

    expect(journalCallCount()).toBe(before);
    expect(existsSync(STATE_ROOT)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * canHandle — cheap, synchronous, graph-only
 *
 * The planner calls it once per candidate action type while a plan is being
 * normalised and again while the capability catalog is assembled, so its cost
 * is paid many times per session while a developer waits. It is also a question
 * about *capability*, never about readiness: a project with components is a
 * project this adapter claims work in whether or not a page agent has reported.
 * ---------------------------------------------------------------------------------------------- */

describe('canHandle', () => {
  it('claims a project whose graph holds a component', () => {
    const answer = adapterWith().canHandle(contextFor({ project: fixture }));

    expect(answer).toBe(true);
    expect(typeof answer).toBe('boolean');
  });

  it('answers synchronously, not with a promise', () => {
    const answer: unknown = adapterWith().canHandle(contextFor({ project: pair }));

    // `await`ing a boolean would pass a promise-returning probe too, so the
    // shape is asserted rather than the value.
    expect(answer).not.toBeInstanceOf(Promise);
    expect(typeof answer).toBe('boolean');
    expect(answer).toBe(true);
  });

  it('declines a project whose graph holds no component', () => {
    expect(adapterWith().canHandle(contextFor({ project: componentFree }))).toBe(false);
  });

  it('answers the same whatever the service observed about the producers', () => {
    const adapter = adapterWith();

    for (const [name, readiness] of presetEntries(fixture)) {
      expect(
        adapter.canHandle(contextFor({ project: fixture, readiness })),
        `capability must not depend on the '${name}' readiness state`,
      ).toBe(true);
      expect(
        adapter.canHandle(contextFor({ project: componentFree, readiness })),
        `capability must not depend on the '${name}' readiness state`,
      ).toBe(false);
    }
  });

  it('is stable across repeated calls on one context', () => {
    const adapter = adapterWith();
    const context = contextFor({ project: fixture });

    expect([adapter.canHandle(context), adapter.canHandle(context)]).toEqual([true, true]);
  });

  it('touches neither the journal nor the backup store', () => {
    const before = journalCallCount();
    const lines: LogLine[] = [];

    expect(
      adapterWith().canHandle(contextFor({ project: fixture, logger: capturingLogger(lines) })),
    ).toBe(true);

    // A capability probe that logged would write a line per candidate action
    // type per session, and one that journaled would be writing during a
    // question nobody has answered yet.
    expect(journalCallCount()).toBe(before);
    expect(lines).toHaveLength(0);
    expect(existsSync(STATE_ROOT)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan — every target selected from the graph, and the same answer twice
 *
 * This is the AAP §0.5.4 half of the adapter and the largest group in the file.
 * No component name is written as an expectation anywhere below: each one is
 * read off the graph the case indexed, and the narrowing cases seed the
 * understanding (or the selected target) with a name they took from the graph
 * moments earlier, so a passing assertion cannot be an adapter and a test
 * agreeing on the same literal.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Runs a proposal over one corpus.
 *
 * @param project The indexed project.
 * @param understanding The understood question.
 * @param extra Anything else the case varies about the context.
 * @returns The proposed actions.
 */
async function planFor(
  project: IndexedProject,
  understanding: ProblemUnderstanding,
  extra: Omit<ContextInput, 'project'> = {},
): Promise<InstrumentationAction[]> {
  return adapterWith().createPlan(contextFor({ project, ...extra }), understanding);
}

/** The distinct `(file, symbol)` anchors a proposal named, in first-seen order. */
function anchorsOf(actions: readonly InstrumentationAction[]): readonly string[] {
  const anchors: string[] = [];

  for (const action of actions) {
    const anchor = `${action.file}#${action.symbol}`;

    if (!anchors.includes(anchor)) {
      anchors.push(anchor);
    }
  }

  return anchors;
}

/** The distinct symbols a proposal named, in first-seen order. */
function symbolsOf(actions: readonly InstrumentationAction[]): readonly string[] {
  const symbols: string[] = [];

  for (const action of actions) {
    if (!symbols.includes(action.symbol)) {
      symbols.push(action.symbol);
    }
  }

  return symbols;
}

describe('createPlan', () => {
  it('proposes only actions the plan schema accepts', async () => {
    const actions = await planFor(fixture, understandingFor(RENDER_SIGNALS));

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      // Parsed, not eyeballed: normalisation rejects the whole plan over one
      // malformed action, so a proposal that could not survive the schema is a
      // proposal that fails a session rather than one target.
      expect(instrumentationActionSchema.parse(action)).toEqual(action);
      expect(action.id).toMatch(ACTION_ID_PATTERN);
      expect(action.id.startsWith(ACTION_ID_PREFIX)).toBe(true);
      expect(action.adapter).toBe(REACT_ADAPTER_ID);
      expect(action.mode).toBe('runtime');
      expect(REACT_ADAPTER_ACTION_TYPES as readonly string[]).toContain(action.type);
      expect(REACT_ADAPTER_CLAIMS[action.type as ReactAdapterActionType]).toBe(action.mode);
      expect(action.rationale.trim().length).toBeGreaterThan(0);
      expect(action.rationale).not.toMatch(/[\r\n]/u);
    }
  });

  it('mints a fresh id for every action it proposes', async () => {
    const actions = await planFor(fixture, understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]));
    const ids = new Set(actions.map((action) => action.id));

    expect(ids.size).toBe(actions.length);
  });

  it('anchors every action on a symbol the graph declares in that file', async () => {
    const actions = await planFor(fixture, understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]));
    const known = new Set(
      componentsOf(fixture).map((component) => `${component.file}#${component.name}`),
    );

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      // Two independent checks: the product's own existence gate, and the node
      // set the graph actually holds. A synthesised name would pass neither.
      expect(
        fixture.queries.hasSymbol(action.file, action.symbol),
        `${action.file} must declare ${action.symbol}`,
      ).toBe(true);
      expect(known.has(`${action.file}#${action.symbol}`)).toBe(true);
    }
  });

  it('names only project-relative, normal paths inside the project', async () => {
    const actions = await planFor(fixture, understandingFor(RENDER_SIGNALS));

    for (const action of actions) {
      expect(action.file.startsWith('/')).toBe(false);
      expect(action.file).not.toMatch(/^[A-Za-z]:/u);
      expect(action.file.split('/')).not.toContain('..');
      expect(action.file.split('/')).not.toContain('.');
      expect(action.file).not.toContain('\\');
      expect(action.file).not.toContain(fixture.root);
    }
  });

  it('serialises to JSON without loss', async () => {
    const actions = await planFor(fixture, understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]));

    // The proposal crosses a process boundary inside `instrumentation.plan` and
    // is stored as JSON on the session record.
    expect(JSON.parse(JSON.stringify(actions))).toEqual(actions);
  });

  it('reaches both component modules of the committed fixture', async () => {
    const actions = await planFor(fixture, understandingFor(RENDER_SIGNALS));
    const edge = soleRenderEdgeOf(fixture);
    const named = new Set(symbolsOf(actions));

    // The client module and the server module that renders it are both
    // addressable, so an unnarrowed question offers both.
    expect(named.has(edge.child.name)).toBe(true);
    expect(named.has(edge.parent.name)).toBe(true);
  });

  it('ranks client components ahead of server components', async () => {
    const actions = await planFor(fixture, understandingFor(RENDER_SIGNALS));
    const order = symbolsOf(actions);
    const clientNames = new Set(clientComponentsOf(fixture).map((component) => component.name));
    const serverNames = new Set(serverComponentsOf(fixture).map((component) => component.name));

    expect(clientNames.size).toBeGreaterThan(0);
    expect(serverNames.size).toBeGreaterThan(0);

    const lastClient = order.reduce(
      (latest, name, index) => (clientNames.has(name) ? index : latest),
      -1,
    );
    const firstServer = order.findIndex((name) => serverNames.has(name));

    expect(lastClient).toBeGreaterThanOrEqual(0);
    expect(firstServer).toBeGreaterThanOrEqual(0);

    // Only a client component renders in the browser, so the fiber hook would
    // see nothing of a server component: putting one first would spend a target
    // slot on evidence that cannot arrive.
    expect(lastClient).toBeLessThan(firstServer);
  });

  it('narrows to the selected element and its one-hop render neighbourhood', async () => {
    const edge = soleRenderEdgeOf(fixture);
    const actions = await planFor(fixture, understandingFor(RENDER_SIGNALS), {
      target: selectedTargetFor([edge.child.name]),
    });
    const named = symbolsOf(actions);

    // The selected component first, then the component the graph records
    // rendering it — the cause of a child's re-render is a decision its parent
    // made. With one `renders` edge in the corpus, that is a neighbourhood of
    // two and nothing else.
    expect(named).toEqual([edge.child.name, edge.parent.name]);
    expect(
      actions.every((action) => action.rationale.includes('code graph')),
      'every rationale states what the graph found',
    ).toBe(true);
  });

  it('follows the render edge downward when the selection is the parent', async () => {
    const edge = soleRenderEdgeOf(fixture);
    const actions = await planFor(fixture, understandingFor(RENDER_SIGNALS), {
      target: selectedTargetFor([edge.parent.name]),
    });

    // The other direction of the same one edge: where a re-render's cost is
    // actually paid.
    expect(symbolsOf(actions)).toEqual([edge.parent.name, edge.child.name]);
  });

  it('ignores a selected chain the graph cannot resolve and falls back', async () => {
    const unresolvable = selectedTargetFor(['Zwmbqvxplk', 'Qhrjfdwtsy']);
    const narrowed = await planFor(fixture, understandingFor(RENDER_SIGNALS), {
      target: unresolvable,
    });
    const unnarrowed = await planFor(fixture, understandingFor(RENDER_SIGNALS));

    // A name nothing bears is not a reason to propose nothing, and it is
    // certainly not a reason to propose that name.
    expect(symbolsOf(narrowed)).toEqual(symbolsOf(unnarrowed));

    for (const action of narrowed) {
      for (const name of unresolvable.componentChain) {
        expect(action.rationale).not.toContain(name);
        expect(action.symbol).not.toBe(name);
      }
    }
  });

  it('narrows on a component entity the understood question named', async () => {
    const edge = soleRenderEdgeOf(fixture);
    const actions = await planFor(
      fixture,
      understandingFor(RENDER_SIGNALS, [{ kind: 'component', name: edge.child.name }]),
    );

    expect(symbolsOf(actions)).toEqual([edge.child.name, edge.parent.name]);
  });

  it('narrows on a search hint when no entity resolved', async () => {
    const edge = soleRenderEdgeOf(fixture);
    const actions = await planFor(
      fixture,
      understandingFor(RENDER_SIGNALS, [], [edge.parent.name]),
    );

    expect(symbolsOf(actions)).toContain(edge.parent.name);
    expect(actions.length).toBeGreaterThan(0);

    // A hint is weaker evidence than a resolved component entity, and the
    // rationale has to say which of the two happened.
    expect(must(actions[0], 'a first action').rationale).toContain(edge.parent.name);
  });

  it('falls back rather than returning junk when nothing named resolves', async () => {
    const actions = await planFor(
      fixture,
      understandingFor(
        RENDER_SIGNALS,
        [
          { kind: 'component', name: 'Zwmbqvxplk' },
          { kind: 'function', name: 'qhrjfdwtsy' },
        ],
        ['zwmbqvxplk'],
      ),
    );
    const unnarrowed = await planFor(fixture, understandingFor(RENDER_SIGNALS));

    expect(symbolsOf(actions)).toEqual(symbolsOf(unnarrowed));

    for (const action of actions) {
      expect(fixture.queries.hasSymbol(action.file, action.symbol)).toBe(true);
      expect(action.symbol).not.toMatch(/Zwmbqvxplk|qhrjfdwtsy/u);
      expect(action.rationale).not.toMatch(/Zwmbqvxplk|qhrjfdwtsy/u);
    }
  });

  it('proposes render tracking without state tracking for a render-only question', async () => {
    for (const signal of RENDER_SIGNALS) {
      const actions = await planFor(fixture, understandingFor([signal]));
      const types = new Set(actions.map((action) => action.type));

      expect(actions.length).toBeGreaterThan(0);
      expect([...types]).toEqual(['react-render-tracking']);
      expect(types.has('state-tracking')).toBe(false);
    }
  });

  it('proposes state tracking when a state signal is asked for', async () => {
    const actions = await planFor(fixture, understandingFor([STATE_SIGNAL]));
    const types = new Set(actions.map((action) => action.type));

    // State transitions are recorded by the same commit walk, and
    // `deriveAgentHookConfig` turns a state action into the fiber hook as well
    // — which is the schema's documented prerequisite, applied there rather
    // than restated here.
    expect([...types]).toEqual(['state-tracking']);
    expect(actions.length).toBeGreaterThan(0);
  });

  it('proposes both types, render first, when both signals are asked for', async () => {
    const actions = await planFor(fixture, understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]));
    const anchors = anchorsOf(actions);

    expect(anchors.length).toBeGreaterThan(0);
    expect(actions).toHaveLength(anchors.length * REACT_ADAPTER_ACTION_TYPES.length);

    // Candidate order outermost, claimed-type order innermost: render tracking
    // first, because the component tree and every render event hang off it.
    for (const [index, action] of actions.entries()) {
      const expectedType = REACT_ADAPTER_ACTION_TYPES[index % REACT_ADAPTER_ACTION_TYPES.length];
      const expectedAnchor = anchors[Math.floor(index / REACT_ADAPTER_ACTION_TYPES.length)];

      expect(action.type).toBe(expectedType);
      expect(`${action.file}#${action.symbol}`).toBe(expectedAnchor);
    }
  });

  it('proposes nothing when the question needs nothing of its kind', async () => {
    const unrelated = CAPTURE_SIGNALS.filter(
      (signal) => !([...RENDER_SIGNALS, STATE_SIGNAL] as readonly string[]).includes(signal),
    );

    expect(unrelated.length).toBeGreaterThan(0);

    const actions = await planFor(fixture, understandingFor(unrelated));

    expect(actions).toEqual([]);
  });

  it('offers render tracking when the question narrows nothing at all', async () => {
    // An empty `signalsNeeded` is refused by the understanding's own schema, so
    // this artifact is assembled directly: a caller that built one by hand
    // should still get the signal this adapter exists for.
    const wide: ProblemUnderstanding = {
      category: 'rendering',
      signalsNeeded: [],
      entities: [],
      searchHints: [],
    };
    const actions = await planFor(fixture, wide);
    const types = new Set(actions.map((action) => action.type));

    expect(actions.length).toBeGreaterThan(0);
    expect([...types]).toEqual(['react-render-tracking']);
  });

  it('honours the default target cap', async () => {
    const actions = await planFor(manyComponents, understandingFor(RENDER_SIGNALS));

    expect(anchorsOf(actions)).toHaveLength(REACT_ADAPTER_LIMITS.defaultMaxTargets);
    expect(actions).toHaveLength(REACT_ADAPTER_LIMITS.defaultMaxTargets);
  });

  it('honours a narrower cap the caller requested', async () => {
    const actions = await adapterWith(2).createPlan(
      contextFor({ project: manyComponents }),
      understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]),
    );

    // The cap counts *targets*, not actions: two claimed types over two targets
    // is four actions, which is what the editor's plan list shows.
    expect(anchorsOf(actions)).toHaveLength(2);
    expect(actions).toHaveLength(2 * REACT_ADAPTER_ACTION_TYPES.length);
  });

  it('clamps a cap below the floor up to it', async () => {
    for (const requested of [0, -8, Number.NaN]) {
      const actions = await adapterWith(requested).createPlan(
        contextFor({ project: manyComponents }),
        understandingFor(RENDER_SIGNALS),
      );
      const expected =
        Number.isFinite(requested) && requested < REACT_ADAPTER_LIMITS.minMaxTargets
          ? REACT_ADAPTER_LIMITS.minMaxTargets
          : REACT_ADAPTER_LIMITS.defaultMaxTargets;

      // A cap of zero would silently disarm the adapter; a non-finite value is
      // what a missing configuration looks like after arithmetic.
      expect(anchorsOf(actions), `a requested cap of ${String(requested)}`).toHaveLength(expected);
    }
  });

  it('clamps a cap above the ceiling down to it', async () => {
    const actions = await adapterWith(REACT_ADAPTER_LIMITS.maxMaxTargets * 8).createPlan(
      contextFor({ project: manyComponents }),
      understandingFor(RENDER_SIGNALS),
    );

    // The corpus is narrower than the ceiling, so the observable consequence is
    // that every component is offered and nothing beyond the ceiling could be.
    expect(anchorsOf(actions).length).toBeLessThanOrEqual(REACT_ADAPTER_LIMITS.maxMaxTargets);
    expect(anchorsOf(actions)).toHaveLength(MANY_COMPONENT_COUNT);
  });

  it('proposes the same plan twice, in the same order', async () => {
    const understanding = understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]);
    const first = await planFor(fixture, understanding);
    const second = await planFor(fixture, understanding);

    expect(first.length).toBeGreaterThan(0);
    expect(first.map(withoutId)).toEqual(second.map(withoutId));
    expect(first.map((action) => action.id)).not.toEqual(second.map((action) => action.id));
  });

  it('proposes the same plan from a second graph built over the same tree', async () => {
    // Determinism has to survive a fresh index, not merely a second call on one
    // graph: node ids and the ranking below them are derived, not remembered.
    const reindexed = await indexProjectTree(FIXTURE_ROOT, FIXTURE_TSCONFIG);
    const understanding = understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]);

    expect((await planFor(fixture, understanding)).map(withoutId)).toEqual(
      (await planFor(reindexed, understanding)).map(withoutId),
    );
  }, 180_000);

  it('returns an empty proposal for a project with no component', async () => {
    for (const signals of [RENDER_SIGNALS, [STATE_SIGNAL], [...RENDER_SIGNALS, STATE_SIGNAL]]) {
      await expect(planFor(componentFree, understandingFor(signals))).resolves.toEqual([]);
    }
  });

  it('returns what it had when the caller cancelled', async () => {
    const controller = new AbortController();

    controller.abort();

    // Cancellation is honoured between steps: an aborted call answers rather
    // than finishing a scan nobody is waiting for, and never rejects.
    await expect(
      planFor(fixture, understandingFor(RENDER_SIGNALS), { signal: controller.signal }),
    ).resolves.toEqual([]);
  });

  it('writes nothing and journals nothing while proposing', async () => {
    const before = journalCallCount();
    const lines: LogLine[] = [];

    await planFor(fixture, understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]), {
      logger: capturingLogger(lines),
    });

    expect(journalCallCount()).toBe(before);
    expect(existsSync(STATE_ROOT)).toBe(false);

    // The adapter logs at `debug` only: a proposal is not news.
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((line) => line.level))).toEqual(new Set(['debug']));
  });
});

/* -------------------------------------------------------------------------------------------------
 * install — writes nothing, arms hooks, and reports every gap as data
 *
 * `applied` is always empty, because React signals are runtime signals
 * (AAP §0.5.1). What varies is the browser fact the service relayed, and the
 * three obstacles AAP §0.5.5 gives this adapter a sentence for are the whole
 * subject of this group — the middle one most of all, because a page whose
 * React loaded before the hook was installed is fixed by one reload and the
 * hint is the only place a developer learns that.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The quoted string literals of the committed fixture's own source, narrowed to
 * text that could only have come from a developer's file.
 *
 * The privacy check this group owes AAP §0.5.2: a symbol name and a
 * project-relative path are values the graph supplies and an action legitimately
 * carries, while the *contents* of a module are not — so anything that overlaps
 * the graph's vocabulary is filtered out and the remainder must appear nowhere
 * in a result or a log line.
 *
 * @returns The literals, de-duplicated.
 */
function fixtureSourceLiterals(): readonly string[] {
  const vocabulary = [
    ...componentNamesOf(fixture),
    ...componentsOf(fixture).map((component) => component.file),
  ];
  const literals = new Set<string>();

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);

        continue;
      }

      if (!/\.(?:tsx?|jsx?)$/u.test(entry.name)) {
        continue;
      }

      for (const match of readFileSync(absolute, 'utf8').matchAll(
        /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/gu,
      )) {
        const value = match[2];

        if (value === undefined || value.length < 8) {
          continue;
        }

        const overlaps = vocabulary.some((known) => known.includes(value) || value.includes(known));

        if (!overlaps) {
          literals.add(value);
        }
      }
    }
  };

  walk(FIXTURE_ROOT);

  return [...literals];
}

/**
 * Every developer-facing string one install produced.
 *
 * @param result The install result.
 * @returns The hook names, reasons and hints.
 */
function installText(result: InstallResult): readonly string[] {
  return [
    ...result.runtimeHooks,
    ...result.unavailable.map((entry) => entry.reason),
    ...result.unavailable.map((entry) => entry.hint),
    ...result.unavailable.map((entry) => entry.signal),
  ];
}

/**
 * Installs one corpus's own proposal under one readiness state.
 *
 * @param project The indexed project.
 * @param readiness What the service observed.
 * @param signals The signals the question asked for.
 * @param logger Where to log, when the case inspects the lines.
 * @returns The proposal and the result it produced.
 */
async function installProposal(
  project: IndexedProject,
  readiness: ObservedReadinessInputs,
  signals: readonly string[] = [...RENDER_SIGNALS, STATE_SIGNAL],
  logger?: Logger,
): Promise<{ readonly actions: InstrumentationAction[]; readonly result: InstallResult }> {
  const adapter = adapterWith();
  const understanding = understandingFor(signals);
  const context = contextFor({
    project,
    readiness,
    ...(logger === undefined ? {} : { logger }),
  });
  const actions = await adapter.createPlan(context, understanding);

  return { actions, result: await adapter.install(actions, context) };
}

describe('install', () => {
  it('arms every owned hook when the page agent reported before React loaded', async () => {
    const before = journalCallCount();
    const { actions, result } = await installProposal(fixture, agentPresets(fixture).healthy);

    expect(actions.length).toBeGreaterThan(0);
    expect(result.adapterId).toBe(REACT_ADAPTER_ID);

    // Runtime-mode: no bytes, no record, no backup.
    expect(result.applied).toEqual([]);
    expect(result.unavailable).toEqual([]);
    expect(journalCallCount()).toBe(before);
    expect(existsSync(STATE_ROOT)).toBe(false);

    // All three labels, since both claimed types were proposed.
    expect(result.runtimeHooks).toEqual(hookLabelsFor(REACT_ADAPTER_HOOK_KEYS));
  });

  it('names its hooks sorted and de-duplicated', async () => {
    const { result } = await installProposal(fixture, agentPresets(fixture).healthy);

    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect([...result.runtimeHooks].sort()).toEqual(result.runtimeHooks);
    expect(new Set(result.runtimeHooks).size).toBe(result.runtimeHooks.length);

    // Every name is one this adapter declared: a hook reported under a name the
    // label table does not hold would be a string the session record cannot
    // reproduce when it is reopened.
    const declared = new Set<string>(Object.values(REACT_ADAPTER_RUNTIME_HOOK_LABELS));

    for (const hook of result.runtimeHooks) {
      expect(declared.has(hook), `'${hook}' must be a declared hook label`).toBe(true);
    }
  });

  it('contributes only the hook keys it owns, and only as true', async () => {
    const { result } = await installProposal(fixture, agentPresets(fixture).healthy);
    const contribution = result.agentHooks;

    expect(contribution).toBeDefined();

    for (const [key, value] of Object.entries(contribution ?? {})) {
      expect(
        REACT_ADAPTER_HOOK_KEYS as readonly string[],
        `'${key}' is not a hook this adapter owns`,
      ).toContain(key);

      // Never an explicit `false`: the installer merges partials, and one
      // adapter's `false` must not overwrite another's `true`.
      expect(value).toBe(true);
    }

    // The forced `interactions` flag belongs to the installer's derivation, not
    // to this adapter's contribution.
    expect(Object.keys(contribution ?? {})).not.toContain('interactions');
  });

  it('contributes a partial that completes into a valid page-agent configuration', async () => {
    const { result } = await installProposal(fixture, agentPresets(fixture).healthy);
    const complete: AgentHookConfig = completeHookConfig(result.agentHooks);

    // Spread over the dormant baseline, the contribution has to parse against
    // the schema the page agent validates the frame with — which is what
    // catches a key typo before it reaches the wire.
    expect(Object.keys(complete).sort()).toEqual([...AGENT_HOOK_KEYS].sort());

    for (const key of REACT_ADAPTER_HOOK_KEYS) {
      expect(complete[key], `'${key}' must be armed`).toBe(true);
    }

    for (const key of AGENT_HOOK_KEYS) {
      if (!(REACT_ADAPTER_HOOK_KEYS as readonly string[]).includes(key)) {
        expect(complete[key], `'${key}' is not this adapter's to arm`).toBe(false);
      }
    }
  });

  it('arms only the fiber hook and the component tree for a render-only plan', async () => {
    const { result } = await installProposal(
      fixture,
      agentPresets(fixture).healthy,
      RENDER_SIGNALS,
    );
    const complete = completeHookConfig(result.agentHooks);

    // The render action's prerequisite pairing lives in
    // `../schema/readiness.ts`; this adapter asks for it rather than restating
    // it, so the component-tree snapshot comes along and the state walk does
    // not.
    expect(complete.react).toBe(true);
    expect(complete.componentTree).toBe(true);
    expect(complete.state).toBe(false);
    expect(result.runtimeHooks).not.toContain(REACT_ADAPTER_RUNTIME_HOOK_LABELS.state);
  });

  it('arms the fiber hook for a state-only plan, because the commit walk records both', async () => {
    const { result } = await installProposal(fixture, agentPresets(fixture).healthy, [
      STATE_SIGNAL,
    ]);
    const complete = completeHookConfig(result.agentHooks);

    expect(complete.state).toBe(true);
    expect(complete.react).toBe(true);
    expect(result.runtimeHooks).toContain(REACT_ADAPTER_RUNTIME_HOOK_LABELS.state);
  });

  it('contributes nothing to the dev-server preload', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const { result } = await installProposal(fixture, readiness);

      // Every signal this adapter claims lives in the page. A server-signal
      // contribution here would arm a preload for evidence it cannot produce.
      expect(result.serverSignals, `the '${name}' state`).toBeUndefined();
    }
  });

  it('arms nothing, and refuses nothing, when no page agent has reported', async () => {
    const before = journalCallCount();
    const { actions, result } = await installProposal(fixture, agentPresets(fixture).absent);

    expect(actions.length).toBeGreaterThan(0);

    // Degradation is data, not an error: the call resolves, the capture
    // proceeds with whatever other adapters enabled, and only the installer
    // judges "nothing at all".
    expect(result.applied).toEqual([]);
    expect(result.runtimeHooks).toEqual([]);
    expect(result.agentHooks).toEqual({});
    expect(journalCallCount()).toBe(before);

    // One entry per affected signal: a developer told that renders are
    // unavailable while hearing nothing about the component tree would be left
    // guessing about the half that was not mentioned.
    expect(result.unavailable.length).toBe(REACT_ADAPTER_SIGNALS.length);
    expect(result.unavailable.map((entry) => entry.signal).sort()).toEqual(
      [...REACT_ADAPTER_SIGNALS].sort(),
    );

    for (const entry of result.unavailable) {
      expect(CAPTURE_SIGNALS as readonly string[]).toContain(entry.signal);
      expect(entry.reason.trim()).toBe(entry.reason);
      expect(entry.hint.trim()).toBe(entry.hint);
      expect(entry.reason.length).toBeGreaterThan(24);
      expect(entry.hint.length).toBeGreaterThan(24);
      expect(entry.reason).not.toMatch(/[\r\n]/u);
      expect(entry.hint).not.toMatch(/[\r\n]/u);

      // The one action available: open the app with the panel on it.
      expect(entry.hint.toLowerCase()).toContain('open the application');
      expect(entry.hint).toMatch(/tab/iu);
      expect(entry.hint).toMatch(/devtools/iu);
      expect(entry.hint).toMatch(/panel/iu);
    }
  });

  it('reads a dev-server preload alone exactly as it reads no agent at all', async () => {
    const presets = agentPresets(fixture);
    const absent = await installProposal(fixture, presets.absent);
    const serverOnly = await installProposal(fixture, presets.serverAgentOnly);

    // Server-tier evidence says nothing about whether a commit can be observed.
    expect(serverOnly.result.runtimeHooks).toEqual(absent.result.runtimeHooks);
    expect(serverOnly.result.unavailable).toEqual(absent.result.unavailable);
    expect(serverOnly.result.agentHooks).toEqual(absent.result.agentHooks);
  });

  it('asks for one page reload when the hook was installed after React loaded', async () => {
    const { result } = await installProposal(fixture, agentPresets(fixture).hookInstalledLate);

    // The single most important message this adapter produces. React attaches
    // to the fiber hook at mount, so a hook installed later observes nothing at
    // all — and the recovery is one reload, which the panel offers as a click
    // and the service performs with a consented `chrome.tabs.reload`
    // (AAP §0.5.5, §0.7.1 Group 4). Without this sentence a developer waits
    // through a capture that could never have recorded a commit.
    expect(result.runtimeHooks).toEqual([]);
    expect(result.agentHooks).toEqual({});
    expect(result.unavailable.length).toBe(REACT_ADAPTER_SIGNALS.length);

    for (const entry of result.unavailable) {
      expect(
        entry.hint.toLowerCase(),
        'the hint must ask the developer to reload the page',
      ).toContain('reload the page');
      expect(entry.hint).toMatch(/reload/iu);
      expect(entry.reason.toLowerCase()).toContain('installed after');

      // And it must not send them off to do the thing the *other* obstacle
      // asks for, which would be an unactionable instruction on a tab that is
      // already open with the panel on it.
      expect(entry.hint.toLowerCase()).not.toContain('open the application');
    }
  });

  it('degrades rather than refusing when the page has no React root yet', async () => {
    const { result } = await installProposal(fixture, agentPresets(fixture).reactUndetected);

    // A server-rendered document, or one whose React has not mounted, is a
    // legitimate page: the hooks are armed and will observe the root when it
    // arrives, so this narrows the capture instead of refusing it.
    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect(result.agentHooks).not.toEqual({});
    expect(result.unavailable.length).toBe(REACT_ADAPTER_SIGNALS.length);

    for (const entry of result.unavailable) {
      expect(entry.reason.toLowerCase()).toContain('no react root');
      expect(entry.hint).toMatch(/navigate/iu);
    }
  });

  it('names the document the page agent reported, and nothing more about it', async () => {
    const { result } = await installProposal(fixture, agentPresets(fixture).reactUndetected);

    for (const entry of result.unavailable) {
      // The URL arrives query-redacted (AAP §0.5.2); the adapter passes it
      // through for actionability and never re-derives a value from it.
      expect(entry.reason).toContain(AGENT_DOCUMENT_URL);
      expect(entry.reason).not.toContain(fixture.root);
    }
  });

  it('gives the three obstacles three different sentences', async () => {
    const presets = agentPresets(fixture);
    const reasons: string[] = [];
    const hints: string[] = [];

    for (const readiness of [presets.absent, presets.hookInstalledLate, presets.reactUndetected]) {
      const { result } = await installProposal(fixture, readiness);
      const first = must(result.unavailable[0], 'an unavailable entry');

      reasons.push(first.reason);
      hints.push(first.hint);
    }

    // Pairwise distinct, so a copy-paste regression between the three branches
    // fails here rather than telling a developer to reload a page that has no
    // agent on it.
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(new Set(hints).size).toBe(hints.length);
  });

  it('reports every affected signal identically within one obstacle', async () => {
    const { result } = await installProposal(fixture, agentPresets(fixture).hookInstalledLate);
    const first = must(result.unavailable[0], 'an unavailable entry');

    for (const entry of result.unavailable) {
      expect(entry.reason).toBe(first.reason);
      expect(entry.hint).toBe(first.hint);
    }

    // One obstacle, one sentence, repeated per signal — not a list to triage.
    expect(new Set(result.unavailable.map((entry) => entry.signal)).size).toBe(
      result.unavailable.length,
    );
  });

  it('ignores an action of another adapter, and one of a type it never claims', async () => {
    const adapter = adapterWith();
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).healthy });
    const own = await adapter.createPlan(
      context,
      understandingFor([...RENDER_SIGNALS, STATE_SIGNAL]),
    );

    expect(own.length).toBeGreaterThan(0);

    const clean = await adapter.install(own, context);
    const mixed = await adapter.install([foreignAction(), ...own, unclaimedTypeAction()], context);

    // The installer may legitimately hand an adapter a broader list than it
    // claimed. An action of another adapter's type is ignored, not refused, and
    // the result must be indistinguishable.
    expect(mixed).toEqual(clean);
  });

  it('arms nothing when the plan asked for nothing of its kind', async () => {
    const adapter = adapterWith();
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).healthy });
    const result = await adapter.install([foreignAction(), unclaimedTypeAction()], context);

    // Not an obstacle: there was nothing to arm, so there is nothing to report
    // as unavailable either.
    expect(result).toEqual({
      adapterId: REACT_ADAPTER_ID,
      applied: [],
      runtimeHooks: [],
      unavailable: [],
      agentHooks: {},
    });
  });

  it('arms nothing for an empty action list, whatever the page reported', async () => {
    const adapter = adapterWith();

    for (const [name, readiness] of presetEntries(fixture)) {
      const result = await adapter.install([], contextFor({ project: fixture, readiness }));

      expect(result.runtimeHooks, `the '${name}' state`).toEqual([]);
      expect(result.unavailable, `the '${name}' state`).toEqual([]);
      expect(result.applied, `the '${name}' state`).toEqual([]);
    }
  });

  it('reports the same state when the same actions are installed twice', async () => {
    const adapter = adapterWith();
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).healthy });
    const actions = await adapter.createPlan(context, understandingFor(RENDER_SIGNALS));

    // The result describes the *state*, not the delta, so the installer can
    // aggregate a retry and a first attempt identically.
    expect(await adapter.install(actions, context)).toEqual(
      await adapter.install(actions, context),
    );
  });

  it('arms hooks under every state in which a commit can be observed', async () => {
    const presets = agentPresets(fixture);

    for (const name of ARMING_PRESETS) {
      const { result } = await installProposal(fixture, presets[name]);

      expect(result.runtimeHooks.length, `the '${name}' state must arm hooks`).toBeGreaterThan(0);
    }
  });

  it('serialises its result to JSON without loss', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const { result } = await installProposal(fixture, readiness);

      expect(JSON.parse(JSON.stringify(result)), `the '${name}' state`).toEqual(result);
    }
  });

  it('leaks no source text from the corpus into a result or a log line', async () => {
    const literals = fixtureSourceLiterals();

    expect(literals.length).toBeGreaterThan(4);

    for (const [name, readiness] of presetEntries(fixture)) {
      const lines: LogLine[] = [];
      const { result } = await installProposal(
        fixture,
        readiness,
        [...RENDER_SIGNALS, STATE_SIGNAL],
        capturingLogger(lines),
      );
      const emitted = [...installText(result), ...logText(lines)];

      expect(emitted.length).toBeGreaterThan(0);

      for (const text of emitted) {
        for (const literal of literals) {
          expect(
            text.includes(literal) ? literal : undefined,
            `the '${name}' state must not emit the source text ${JSON.stringify(literal)}`,
          ).toBeUndefined();
        }
      }
    }
  });

  it('logs at debug only, and journals nothing, whatever the page reported', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const before = journalCallCount();
      const lines: LogLine[] = [];

      await installProposal(
        fixture,
        readiness,
        [...RENDER_SIGNALS, STATE_SIGNAL],
        capturingLogger(lines),
      );

      expect(journalCallCount(), `the '${name}' state`).toBe(before);
      expect(lines.length).toBeGreaterThan(0);
      expect(new Set(lines.map((line) => line.level)), `the '${name}' state`).toEqual(
        new Set(['debug']),
      );
    }

    expect(existsSync(STATE_ROOT)).toBe(false);
  });

  it('installs a proposal made over a corpus it has never seen', async () => {
    const { actions, result } = await installProposal(pair, agentPresets(pair).healthy);

    expect(actions.length).toBeGreaterThan(0);
    expect(result.applied).toEqual([]);
    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect(result.unavailable).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * readiness — a pure function of the facts the service relayed
 *
 * The rows that gate the session's "Ready to capture" state and the
 * "Reproduce the issue now." prompt. The only input is
 * `context.readiness.browserAgent`: the service holds the actual evidence, and
 * an adapter that went looking for its own could contradict it and tell a
 * developer a signal is ready when the frames the product needs are not
 * arriving.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Takes one readiness report and validates it at the boundary it would cross.
 *
 * @param project The indexed project.
 * @param readiness What the service observed.
 * @param extra Anything else the case varies about the context.
 * @returns The parsed report.
 */
async function readinessFor(
  project: IndexedProject,
  readiness: ObservedReadinessInputs,
  extra: Omit<ContextInput, 'project' | 'readiness'> = {},
): Promise<Readiness> {
  const report = await adapterWith().readiness(contextFor({ project, readiness, ...extra }));

  // `parseReadiness` is what the service applies to a report it did not
  // construct, so a report that could not survive it is a report that fails a
  // session rather than one row.
  return readinessSchema.parse(report);
}

describe('readiness', () => {
  it('reports one row per claimed signal, in the declared order', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const report = await readinessFor(fixture, readiness);

      expect(report.adapter, `the '${name}' state`).toBe(REACT_ADAPTER_ID);
      expect(
        report.signals.map((row) => row.signal),
        `the '${name}' state`,
      ).toEqual([...REACT_ADAPTER_SIGNALS]);
    }
  });

  it('gives every row a declared status, and every unhealthy row a way out', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const report = await readinessFor(fixture, readiness);

      for (const row of report.signals) {
        expect(READINESS_STATUSES as readonly string[]).toContain(row.status);
        expect(CAPTURE_SIGNALS as readonly string[]).toContain(row.signal);

        if (row.status === 'available') {
          // Nothing to say, so nothing is said: a reason on a healthy row would
          // be rendered into the same sentence as a real one.
          expect(row.reason, `the '${name}' state`).toBeUndefined();
          expect(row.hint, `the '${name}' state`).toBeUndefined();

          continue;
        }

        // A readiness row that stayed silent about its recovery action would
        // make the failure honest but useless.
        const reason = must(row.reason, 'a reason on a non-available row');
        const hint = must(row.hint, 'a hint on a non-available row');

        expect(reason.trim()).toBe(reason);
        expect(hint.trim()).toBe(hint);
        expect(reason.length).toBeGreaterThan(24);
        expect(hint.length).toBeGreaterThan(24);
        expect(reason).not.toMatch(/[\r\n]/u);
        expect(hint).not.toMatch(/[\r\n]/u);
      }
    }
  });

  it('is ready when a page agent reported before React loaded', async () => {
    const report = await readinessFor(fixture, agentPresets(fixture).healthy);

    expect(report.ready).toBe(true);
    expect(new Set(report.signals.map((row) => row.status))).toEqual(new Set(['available']));
  });

  it('holds a capture back when no page agent has reported', async () => {
    for (const readiness of [agentPresets(fixture).absent, agentPresets(fixture).serverAgentOnly]) {
      const report = await readinessFor(fixture, readiness);

      expect(report.ready).toBe(false);
      expect(new Set(report.signals.map((row) => row.status))).toEqual(new Set(['unavailable']));
    }
  });

  it('holds a capture back, with the reload hint, when the hook was installed late', async () => {
    const report = await readinessFor(fixture, agentPresets(fixture).hookInstalledLate);

    // The readiness half of the message that matters most: the gate is closed,
    // and the row says the one thing that opens it.
    expect(report.ready).toBe(false);

    for (const row of report.signals) {
      expect(row.status).toBe('unavailable');
      expect(must(row.hint, 'a hint').toLowerCase()).toContain('reload the page');
    }
  });

  it('does not hold a capture back for a page whose React has not mounted', async () => {
    const report = await readinessFor(fixture, agentPresets(fixture).reactUndetected);

    // `'degraded'` narrows the capture; only `'unavailable'` blocks it.
    expect(report.ready).toBe(true);
    expect(new Set(report.signals.map((row) => row.status))).toEqual(new Set(['degraded']));
  });

  it('is ready with no rows for a project it claims nothing in', async () => {
    for (const [name, readiness] of presetEntries(componentFree)) {
      const report = await readinessFor(componentFree, readiness);

      // An adapter with nothing to claim cannot hold a capture back, and that
      // is a different statement from one whose signals are all unavailable.
      expect(report.signals, `the '${name}' state`).toEqual([]);
      expect(report.ready, `the '${name}' state`).toBe(true);
    }
  });

  it('agrees with install about which states can observe a commit', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const report = await readinessFor(fixture, readiness);
      const { result } = await installProposal(fixture, readiness);
      const arms = result.runtimeHooks.length > 0;

      expect(arms, `the '${name}' state`).toBe(ARMING_PRESETS.includes(name));

      // Readiness and degradation are the same judgement asked at two moments,
      // so the states whose rows block a capture and the states whose install
      // arms nothing have to be the same states.
      expect(
        report.signals.every((row) => row.status !== 'unavailable'),
        `the '${name}' state`,
      ).toBe(arms);
    }
  });

  it('takes its timestamp from the clock it was given', async () => {
    const report = await readinessFor(fixture, agentPresets(fixture).healthy);

    expect(report.checkedAt).toBe(NOW);
  });

  it('prefers the clock injected through its own options', async () => {
    const optionClock = NOW + 4_242;
    const adapter = createReactAdapter({ now: () => optionClock });
    const report = await adapter.readiness(
      contextFor({ project: fixture, readiness: agentPresets(fixture).healthy }),
    );

    expect(report.checkedAt).toBe(optionClock);
  });

  it('falls back to the session clock when its options carry none', async () => {
    const sessionClock = NOW + 7;
    const report = await readinessFor(fixture, agentPresets(fixture).healthy, {
      now: () => sessionClock,
    });

    expect(report.checkedAt).toBe(sessionClock);
  });

  it('still answers when no clock was injected at all', async () => {
    const report = await readinessFor(fixture, agentPresets(fixture).healthy, {
      withoutSessionClock: true,
    });

    // `buildReadiness` owns the default, which is the epoch-millisecond clock of
    // `@debuggen/shared`; the only assertion worth making is that it is a real
    // moment rather than zero.
    expect(report.checkedAt).toBeGreaterThan(0);
    expect(Number.isFinite(report.checkedAt)).toBe(true);
  });

  it('answers identically twice for the same inputs', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const first = await readinessFor(fixture, readiness);
      const second = await readinessFor(fixture, readiness);

      // Deep-equal, `checkedAt` included: the clock is injected and frozen, so
      // nothing about the report is allowed to vary between two calls.
      expect(first, `the '${name}' state`).toEqual(second);
    }
  });

  it('reads its clock and nothing else', async () => {
    const before = journalCallCount();
    const clock = vi.fn(() => NOW);
    const lines: LogLine[] = [];
    const report = await adapterWith().readiness(
      contextFor({
        project: fixture,
        readiness: agentPresets(fixture).absent,
        logger: capturingLogger(lines),
        now: clock,
      }),
    );

    // Nothing is probed: the backup store throws on contact, the journal
    // records every call, no network exists in this project, and the only
    // collaborator touched is the clock the caller passed in.
    expect(clock).toHaveBeenCalled();
    expect(journalCallCount()).toBe(before);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(lines).toHaveLength(0);
    expect(report.ready).toBe(false);
  });

  it('serialises its report to JSON without loss', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const report = await readinessFor(fixture, readiness);

      expect(JSON.parse(JSON.stringify(report)), `the '${name}' state`).toEqual(report);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * remove — relinquishes hooks, restores nothing, and says so twice
 *
 * There is nothing on disk to restore, so there is nothing that can fail or
 * conflict: the hooks stop when the service sends `agent.config` with every
 * flag false (AAP §0.5.1), and this result states which hooks that is about.
 * It runs again after a crash and on every service start, so it has to be
 * idempotent by construction rather than by bookkeeping.
 * ---------------------------------------------------------------------------------------------- */

/** The three occasions an adapter is asked to remove its instrumentation. */
const REMOVE_REASONS: readonly AdapterRemoveReason[] = ['session-end', 'rollback', 'reconcile'];

/**
 * A modification record of somebody else's work, for the scoped-removal cases.
 *
 * A runtime adapter ignores the member entirely — it has no records, and its
 * work is to detach — so the record exists to prove exactly that: handing one
 * over changes nothing about the answer.
 *
 * @returns The record.
 */
function foreignRecord(): ModificationRecord {
  const created = createModificationRecord(
    {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      file: 'src/kilns/calm-arithmetic.ts',
      originalHash: 'a'.repeat(64),
      backupPath: `${STATE_ROOT}/backups/${SESSION_ID}/${'a'.repeat(64)}`,
      instrumentedHash: 'b'.repeat(64),
      diff: '--- a\n+++ b\n',
      status: 'applied',
    },
    { newId: () => 'mod_ccccccccccccccc1', now: frozenClock },
  );

  if (!created.ok) {
    throw new Error(`the suite could not build a record: ${created.error.message}`);
  }

  return created.value;
}

describe('remove', () => {
  it('relinquishes every hook it owns, whatever the occasion', async () => {
    const adapter = adapterWith();
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).healthy });

    for (const reason of REMOVE_REASONS) {
      const result: RemoveResult = await adapter.remove({ sessionId: SESSION_ID, reason }, context);

      expect(result.adapterId, `the '${reason}' occasion`).toBe(REACT_ADAPTER_ID);
      expect(result.restored, `the '${reason}' occasion`).toEqual([]);
      expect(result.conflicts, `the '${reason}' occasion`).toEqual([]);
      expect(result.runtimeHooksDisabled, `the '${reason}' occasion`).toEqual(
        hookLabelsFor(REACT_ADAPTER_HOOK_KEYS),
      );
    }
  });

  it('answers the same for a session that installed nothing and one that installed records', async () => {
    const adapter = adapterWith();
    const context = contextFor({ project: fixture });
    const withoutRecords = await adapter.remove(
      { sessionId: SESSION_ID, reason: 'session-end' },
      context,
    );
    const withRecords = await adapter.remove(
      {
        sessionId: SESSION_ID,
        planVersion: PLAN_VERSION,
        records: [foreignRecord()],
        reason: 'rollback',
      },
      context,
    );

    // A runtime adapter has no records of its own; a scoped request naming
    // somebody else's cannot change what it detaches.
    expect(withRecords.restored).toEqual([]);
    expect(withRecords.conflicts).toEqual([]);
    expect(withRecords.runtimeHooksDisabled).toEqual(withoutRecords.runtimeHooksDisabled);
  });

  it('is a no-op that still reports when called twice', async () => {
    const adapter = adapterWith();
    const context = contextFor({ project: fixture });
    const request = { sessionId: SESSION_ID, reason: 'session-end' } as const;

    expect(await adapter.remove(request, context)).toEqual(await adapter.remove(request, context));
  });

  it('removes for a project it never claimed anything in', async () => {
    const result = await adapterWith().remove(
      { sessionId: SESSION_ID, reason: 'reconcile' },
      contextFor({ project: componentFree }),
    );

    // Reconciliation runs before a single client is accepted, whatever status
    // the owning session ended in, so this must not depend on the project
    // having components at all.
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.runtimeHooksDisabled.length).toBe(REACT_ADAPTER_HOOK_KEYS.length);
  });

  it('writes nothing, journals nothing and logs at debug only', async () => {
    const before = journalCallCount();
    const lines: LogLine[] = [];
    const result = await adapterWith().remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, reason: 'session-end' },
      contextFor({ project: fixture, logger: capturingLogger(lines) }),
    );

    expect(journalCallCount()).toBe(before);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((line) => line.level))).toEqual(new Set(['debug']));

    // Ids and enumerated reasons only — never a byte of a developer's file.
    for (const text of logText(lines)) {
      for (const literal of fixtureSourceLiterals()) {
        expect(text.includes(literal) ? literal : undefined).toBeUndefined();
      }
    }

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The import boundary
 *
 * A static read of the adapter's own source. Everything above proves what the
 * adapter *does*; this group proves what it is *able* to do — a module that
 * imported the registry that constructs it, the installer that calls it, the
 * patch layer that writes, the cleanup module that restores, or any platform
 * builtin could route itself, write around the journal, or stop being a pure
 * function of what it was handed. It is the mechanical enforcement of this
 * folder's import allow-list, and it follows the precedent
 * `packages/shared/src/index.test.ts` sets for a guard of this kind.
 * ---------------------------------------------------------------------------------------------- */

/** The only module specifiers `./react.ts` may import. */
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
  {
    label: 'the modification journal it never appends to',
    pattern: /\.\.\/schema\/modification/u,
  },
  { label: 'the environment', pattern: /\bprocess\s*\.\s*env\b/u },
  { label: 'the console', pattern: /\bconsole\s*\./u },
  { label: 'a Node builtin', pattern: /(['"])node:[^'"]*\1|\bnode:[a-z]/u },
];

/**
 * The adapter's source with its comments removed.
 *
 * Comments have to go before anything is matched: this module's prose
 * *discusses* the registry, the patch layer, the cleanup module and the
 * telemetry agent — which is exactly why it must not import them — and a guard
 * that scanned the prose would report the explanation as the violation.
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

    // Without this, a stripping accident would make every assertion below pass
    // against an empty string.
    expect(stripped).toContain('export function createReactAdapter');
    expect(stripped).toContain(`export const REACT_ADAPTER_ID = '${REACT_ADAPTER_ID}'`);
    expect(stripped).toContain('canHandle');
    expect(stripped).not.toContain('/*');
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
      // NodeNext resolution, which is what this package is type-checked and run
      // under: an extensionless relative specifier is a compile error and an
      // unresolvable import at run time.
      expect(specifier, `relative import '${specifier}' must name a .js file`).toMatch(/\.js$/u);
    }
  });

  it('reaches for nothing outside that boundary', () => {
    const stripped = adapterSourceWithoutComments();

    for (const { label, pattern } of FORBIDDEN_SOURCE_PATTERNS) {
      const match = pattern.exec(stripped);

      expect(
        match === null ? undefined : match[0],
        `./react.ts must not reach for ${label}`,
      ).toBeUndefined();
    }
  });

  it('finds the guard able to recognise a violation at all', () => {
    // A guard whose patterns matched nothing would pass this file vacuously, so
    // each one is shown to fire against a line that would break the boundary.
    const planted = [
      "import { createAdapterRegistry } from '../registry.js';",
      "import { installActions } from '../installer.js';",
      "import { cleanupSession } from '../cleanup.js';",
      "import { FunctionTimingPatcher } from '../patch/function-timing.js';",
      "import { createModificationRecord } from '../schema/modification.js';",
      "import { parseMessage } from '@debuggen/protocol';",
      "import { validatePanelSpec } from '@debuggen/panel-schema';",
      "import { readFileSync } from 'node:fs';",
      'const home = process.env.DEBUGGEN_HOME;',
      'console.log(home);',
    ].join('\n');

    for (const { label, pattern } of FORBIDDEN_SOURCE_PATTERNS) {
      expect(pattern.test(planted), `the guard for ${label} must fire`).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * No component name of its own (AAP §0.5.4)
 *
 * The assertion this file owes the repository. `scripts/check-no-hardcoding.mjs`
 * is the AST-aware, policy-driven, repository-wide half; this is the same rule
 * asserted where the adapter lives, and it is specific enough to catch a single
 * component name written into the one module whose whole subject is components.
 *
 * The behavioural half runs the adapter over a corpus whose component names are
 * arbitrary and checks that exactly those names — and no others — reach the
 * sentences a developer reads.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a string reads as a name a project could have given a declaration.
 *
 * Two shapes, both of them things this module must receive as data rather than
 * carry:
 *
 * - a **multi-word PascalCase identifier** — one unbroken run of letters and
 *   digits, beginning with a capital, containing a lower-case letter and a
 *   further capital after the first. That is what a React component is called,
 *   and the constraints are what keep the product's own vocabulary out of it: a
 *   `camelCase` hook key such as a page-agent flag begins lower-case, a
 *   hyphenated action type is not one unbroken run, and a sentence has spaces
 *   in it — so none of the three is reported as a leak while `FiringLogForm`
 *   and `DrumFacet00` both are;
 * - anything with a **path separator**, which is how a project-relative file
 *   reads and is a shape this module carries no literal of at all.
 *
 * @param value The value to judge.
 * @returns `true` when the value reads as project vocabulary.
 */
function looksLikeProjectVocabulary(value: string): boolean {
  if (value.includes('/')) {
    return true;
  }

  return (
    /^[A-Z][A-Za-z0-9]*$/u.test(value) && /[a-z]/u.test(value) && /[A-Z]/u.test(value.slice(1))
  );
}

/**
 * The distinctive strings one corpus contributed: its component names and the
 * files they are declared in.
 *
 * @param project The indexed project.
 * @returns The names and paths.
 */
function distinctiveNames(project: IndexedProject): readonly string[] {
  const names = new Set<string>();

  for (const component of componentsOf(project)) {
    names.add(component.name);
    names.add(component.file);
  }

  return [...names];
}

describe('no component name of its own', () => {
  it('finds the guard able to recognise project vocabulary at all', () => {
    for (const project of [fixture, pair, manyComponents]) {
      const names = distinctiveNames(project);

      expect(names.length).toBeGreaterThan(0);

      for (const name of names) {
        expect(looksLikeProjectVocabulary(name), `'${name}' must read as project vocabulary`).toBe(
          true,
        );
      }
    }

    // And the product's own vocabulary is not caught by it: the adapter id, the
    // two claimed action types, the install mode, every page-agent hook key and
    // every developer-facing hook label.
    for (const benign of [
      REACT_ADAPTER_ID,
      ...REACT_ADAPTER_ACTION_TYPES,
      ...Object.values(REACT_ADAPTER_CLAIMS),
      ...AGENT_HOOK_KEYS,
      ...Object.values(REACT_ADAPTER_RUNTIME_HOOK_LABELS),
    ]) {
      expect(
        looksLikeProjectVocabulary(benign),
        `'${benign}' must not read as project vocabulary`,
      ).toBe(false);
    }
  });

  it('carries no component name or path as a literal in its own source', () => {
    // A module specifier is path-shaped by nature, and *which* specifiers this
    // module may carry is settled exactly — and exhaustively — by the import
    // boundary group above, so they are the one exemption here.
    const specifiers = new Set(ALLOWED_SPECIFIERS);
    const literals = adapterStringLiterals().filter((literal) => !specifiers.has(literal));

    expect(literals.length).toBeGreaterThan(0);

    for (const literal of literals) {
      expect(
        looksLikeProjectVocabulary(literal) ? literal : undefined,
        `./react.ts must not carry the project-shaped literal ${JSON.stringify(literal)}`,
      ).toBeUndefined();
    }
  });

  it('names nothing from any corpus in its own source', () => {
    const stripped = adapterSourceWithoutComments();
    const names = [fixture, pair, manyComponents].flatMap((project) => distinctiveNames(project));

    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      expect(stripped, `./react.ts must not carry the project name '${name}'`).not.toContain(name);
    }
  });

  it('states only the names the graph gave it, on a corpus it has never seen', async () => {
    const foreign = distinctiveNames(fixture);
    const edge = soleRenderEdgeOf(pair);

    expect(foreign.length).toBeGreaterThan(0);

    // Seeded with a name taken from *this* corpus's graph a moment ago, so the
    // narrowing under test cannot have come from anywhere else.
    const actions = await planFor(
      pair,
      understandingFor(
        [...RENDER_SIGNALS, STATE_SIGNAL],
        [{ kind: 'component', name: edge.child.name }],
      ),
    );
    const permitted = new Set(componentNamesOf(pair));

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      expect(permitted.has(action.symbol)).toBe(true);
      expect(pair.queries.hasSymbol(action.file, action.symbol)).toBe(true);

      for (const name of foreign) {
        expect(
          action.rationale,
          `a rationale for one project must not name another's '${name}'`,
        ).not.toContain(name);
        expect(action.file).not.toContain(name);
      }

      // Every project-shaped token in the sentence has to be a name this
      // corpus's graph supplied: the adapter's own prose carries none at all,
      // so anything that reads as one came from data or from a literal that
      // must not exist.
      for (const token of action.rationale.split(/[\s.,;:()]+/u)) {
        if (token === '' || !looksLikeProjectVocabulary(token)) {
          continue;
        }

        expect(
          permitted.has(token),
          `'${token}' in a rationale must be a name this corpus's graph supplied`,
        ).toBe(true);
      }
    }
  });

  it('explains the neighbourhood with the graph-derived name it related to', async () => {
    const edge = soleRenderEdgeOf(pair);
    const actions = await planFor(pair, understandingFor(RENDER_SIGNALS), {
      target: selectedTargetFor([edge.child.name]),
    });
    const parentActions = actions.filter((action) => action.symbol === edge.parent.name);

    expect(parentActions.length).toBeGreaterThan(0);

    for (const action of parentActions) {
      // A developer reading the plan is told what the tool found — "renders
      // ‹name›" — rather than that the tool decided.
      expect(action.rationale).toContain(edge.child.name);
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

  it('never saw a modification journaled', () => {
    // The whole suite's tally, not one case's: a runtime adapter that appended
    // a record anywhere would have been writing to a developer's project
    // through somebody else's hand.
    expect(journalEvents).toEqual([]);
  });
});
