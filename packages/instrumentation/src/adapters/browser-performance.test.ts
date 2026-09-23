/**
 * The suite for `./browser-performance.ts` — the adapter that arms the page
 * agent's interaction listener, its performance observers and its error
 * capture, and therefore the adapter the correlated trace of AAP §0.8.4's first
 * acceptance test is rooted in.
 *
 * Four claims are what make it correct rather than merely present, and every
 * group below exists to hold one of them:
 *
 * 1. **Interaction anchors come out of the code graph.** An anchor is a
 *    `handler` node the event-handler extractor of `@debuggen/code-analysis`
 *    recorded — or, for an inline arrow that has no declaration of its own, the
 *    `component` node the graph says the binding sits inside. Never a
 *    recognised name (AAP §0.5.4). No application's handler, component or
 *    event name is written as an expectation here: each one is read off the
 *    graph a case indexed, which is why the scratch corpora carry deliberately
 *    meaningless identifiers this product has never seen.
 * 2. **The document-wide signal is planned once.** `PerformanceObserver`
 *    reports long tasks, resource, navigation and paint entries for the whole
 *    document, so a plan with one `'perf-tracking'` action per component would
 *    inflate what a developer reads without observing anything more. The cap of
 *    exactly one is asserted on the committed corpus *and* on a graph holding
 *    several components and several handlers, because one anchor cannot tell
 *    "once" from "once per anchor" apart.
 * 3. **Readiness is a pure function of injected evidence.** The only input is
 *    `context.readiness.browserAgent`, the relayed `agent.ready` fact for the
 *    bound tab (AAP §0.5.5) — no port is probed and no environment is read. And
 *    it deliberately does **not** gate on `installedBeforeReact`: a fiber hook
 *    has to exist before React loads, but a capture-phase DOM listener, a
 *    `PerformanceObserver` and a `window` error handler do not, so a page that
 *    reported no React is as ready here as one that did. That distinction is
 *    what keeps this adapter and its React sibling honestly different, and the
 *    install group asserts it in the negative too: **no hint telling a
 *    developer to reload is ever emitted by this adapter's install.**
 * 4. **Nothing is written.** These are runtime signals in AAP §0.5.1's table:
 *    the page agent observes them through browser APIs that already exist, so
 *    `InstallResult.applied` is always empty and `RemoveResult.restored` always
 *    is too. Every context here carries a journal that records every call and a
 *    backup store that throws on contact, so "wrote nothing" is asserted rather
 *    than assumed — and the state root the context names is never created.
 *
 * ## The corpora, and why there are six
 *
 * The adapter's input contract is a real `CodeGraph`, so every source corpus is
 * indexed through the product's own path — `openProject` → `buildIndex` →
 * `CodeGraph.fromIndex` → `buildRouteMap` → `createCodeQueries` →
 * `summarizeProject`. That pair is deliberately the **cache-free** build:
 * `indexProject` would consult and populate `$DEBUGGEN_HOME/index`, which a
 * unit suite must not touch.
 *
 * - `test/fixtures/project-a`, **read-only**, indexed once. Its whole `src/`
 *   tree contains only **named** event handlers — module-scope functions bound
 *   by reference inside `'use client'` components (a `.tsx` submit handler and
 *   a `.jsx` click handler declared after its binding site) — and zero inline
 *   arrows, fewer of them than one proposal may name. The anchor rule is
 *   therefore exercised on a small real tree where every handler must come out
 *   as exactly one anchor at its own declaration; the corpus's shape is read
 *   off the graph and asserted in `assertCorpusInventory`, never counted here.
 *   The "one perf action" claim still needs a second corpus that exceeds the
 *   proposal bound, which this one deliberately does not.
 * - An **inline-arrow** scratch corpus: one component whose only binding is an
 *   arrow written in the markup. It has no declaration to name, so it is the
 *   only corpus that can show the enclosing-component fallback, and the
 *   committed fixture is not bent to cover it.
 * - A **many-anchor** scratch corpus with more named handlers than one proposal
 *   may contain, sized from the adapter's own exported limit. It exercises the
 *   cap, the ordering, the narrowing and the single perf action at once.
 * - A **hand-authored index** with several components, several non-inline
 *   handlers and the `handles` edges between them: the in-memory half of the
 *   single-perf-action claim, with no source tree at all.
 * - A **components-only** hand-authored index: a project whose graph holds no
 *   handler binding. Document-wide observation needs no named handler, so this
 *   must still be handled and still be planned for — a deliberate design
 *   decision rather than an accident, which is why it is asserted in both
 *   directions.
 * - An **anchorless** hand-authored index holding one plain declaration and
 *   nothing else. A project with neither a handler nor a component is the one
 *   input this adapter declines, and it is not worth a source tree.
 *
 * Nothing here needs a network, a browser, a dev server or a working tree:
 * every readiness fact is injected on the context, and no case starts a
 * process or opens a socket.
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
  makeEdgeId,
  makeNodeId,
  openProject,
  routeMapFromIndex,
  summarizeProject,
} from '@debuggen/code-analysis';
import type {
  CodeEdge,
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  CodeQueries,
  LoadedProject,
  ProjectSummary,
  RouteMap,
} from '@debuggen/code-analysis';
import { noopLogger, ok, toPosix } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';
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
  instrumentationActionSchema,
} from '../schema/plan.js';
import type { InstrumentationAction } from '../schema/plan.js';
import {
  AGENT_HOOK_KEYS,
  BROWSER_CAPTURE_SIGNALS,
  CAPTURE_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  READINESS_STATUSES,
  SERVER_CAPTURE_SIGNALS,
  agentHookConfigSchema,
  readinessSchema,
} from '../schema/readiness.js';
import type {
  AgentHookConfig,
  AgentHookKey,
  CaptureSignal,
  Readiness,
} from '../schema/readiness.js';
import { problemUnderstandingSchema, selectedTargetSchema } from '../schema/target.js';
import type { ProblemEntityKind, ProblemUnderstanding, SelectedTarget } from '../schema/target.js';

import {
  BROWSER_PERFORMANCE_ADAPTER_CLAIMS,
  BROWSER_PERFORMANCE_ADAPTER_ID,
  BROWSER_PERFORMANCE_ADAPTER_LIMITS,
  BROWSER_PERFORMANCE_HOOK_KEYS,
  createBrowserPerformanceAdapter,
} from './browser-performance.js';

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

/** The adapter's own source, for the static import-boundary guard. */
const ADAPTER_SOURCE_PATH = fileURLToPath(new URL('./browser-performance.ts', import.meta.url));

/** The session every context in this suite belongs to. */
const SESSION_ID = 'ses_browserperf0001';

/** The plan revision every context stamps. */
const PLAN_VERSION = 3;

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
const STATE_ROOT = toPosix(join(tmpdir(), 'debuggen-browser-performance-state-never-written'));

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

  /** The route map, which every context carries whether or not it is read. */
  readonly routeMap: RouteMap;

  /** The project summary Stage 1 is told about this project. */
  readonly projectSummary: ProjectSummary;
}

/**
 * Indexes one project through the product's own path.
 *
 * The cache-free build (`openProject` + `buildIndex`) rather than
 * `indexProject`, which would read and write `$DEBUGGEN_HOME/index`. A failure
 * is thrown from here rather than asserted in a case, so a corpus that stopped
 * being indexable fails once, loudly, in the lifecycle hook.
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
  const root = mkdtempSync(join(tmpdir(), `debuggen-bperf-${label}-`));

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
 * project, because `summarizeProject` needs a loaded ts-morph project and every
 * case that uses a hand-authored index is about the graph alone.
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
 * A hand-authored index around a node and edge list.
 *
 * @param projectRoot The absolute POSIX root the index claims.
 * @param nodes The nodes the graph holds.
 * @param edges The edges between them; none by default.
 * @returns The index.
 */
function handAuthoredIndex(
  projectRoot: string,
  nodes: readonly CodeNode[],
  edges: readonly CodeEdge[] = [],
): CodeIndex {
  return {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot,
    indexerVersion: INDEXER_VERSION,
    generatedAt: NOW,
    nodes,
    edges,
    files: [],
  };
}

/**
 * One `component` node, hand-authored.
 *
 * @param file The declaring file, project-relative POSIX.
 * @param name The component's display name.
 * @param line The 1-based declaration line.
 * @returns The node.
 */
function componentNode(file: string, name: string, line: number): CodeNodeOf<'component'> {
  return {
    id: makeNodeId({ kind: 'component', file, name, line, column: 1 }),
    kind: 'component',
    name,
    file,
    line,
    column: 1,
    exported: true,
    symbol: name,
    data: { isClient: true, isDefaultExport: false, displayName: name },
  };
}

/**
 * One `symbol` node, hand-authored: the declaration that makes a name
 * addressable.
 *
 * It is what `queries.hasSymbol` answers from — a `handler` node cannot affirm
 * its own symbol, because the graph's declaration test accepts only declaring
 * kinds — so a hand-authored corpus whose handlers are meant to resolve carries
 * one of these per handler.
 *
 * @param file The declaring file, project-relative POSIX.
 * @param name The declared name.
 * @param line The 1-based declaration line.
 * @returns The node.
 */
function symbolNode(file: string, name: string, line: number): CodeNodeOf<'symbol'> {
  return {
    id: makeNodeId({ kind: 'symbol', file, name, line, column: 1 }),
    kind: 'symbol',
    name,
    file,
    line,
    column: 1,
    exported: true,
    symbol: name,
    data: { declaration: 'function', isDefaultExport: false },
  };
}

/**
 * One `handler` node, hand-authored, positioned at the handler's **own
 * declaration** the way the event-handler extractor positions it.
 *
 * @param file The file the binding sits in, project-relative POSIX.
 * @param name The handler's name: a declared identifier, or the markup
 * attribute's name for an inline arrow.
 * @param line The 1-based line the node records.
 * @param event The DOM event name, without its `on` prefix.
 * @param inline Whether the handler is an arrow written in the markup.
 * @returns The node.
 */
function handlerNode(
  file: string,
  name: string,
  line: number,
  event: string,
  inline: boolean,
): CodeNodeOf<'handler'> {
  return {
    id: makeNodeId({ kind: 'handler', file, name, line, column: 3 }),
    kind: 'handler',
    name,
    file,
    line,
    column: 3,
    // A reference to a named function records the symbol to look for; an inline
    // arrow has none, and the absent key is what the adapter reads as "there is
    // nothing here to name".
    ...(inline ? {} : { symbol: name }),
    data: { event, boundTo: 'button', inline },
  };
}

/**
 * One `handles` edge, directed **component → handler**, which is the direction
 * the extractor emits and therefore the direction the adapter traverses
 * backwards to find an enclosing component.
 *
 * @param from The component node's id.
 * @param to The handler node's id.
 * @returns The edge.
 */
function handlesEdge(from: string, to: string): CodeEdge {
  return { id: makeEdgeId({ kind: 'handles', from, to }), kind: 'handles', from, to };
}

/* -------------------------------------------------------------------------------------------------
 * The scratch corpora
 *
 * Every identifier below is arbitrary: a component name, a handler name and a
 * file path this product has never seen and never will. That is the behavioural
 * half of AAP §0.5.4 — an adapter that recognised names rather than reading the
 * graph would find nothing here — and it is what lets the no-hardcoding group
 * compare one corpus's names against another's.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The inline-arrow corpus: one component whose only binding is an arrow written
 * in the markup.
 *
 * There is no function to name, which is the case the committed fixture cannot
 * produce — it carries one named handler and no inline arrow, by design — and
 * the case the enclosing-component fallback exists for.
 */
const INLINE_SOURCES: Readonly<Record<string, string>> = {
  'src/panes/LanternPane.tsx': [
    "'use client';",
    '',
    'export function LanternPane({ slipId }: { slipId: string }) {',
    '  return (',
    '    <button',
    '      type="button"',
    '      onClick={() => {',
    '        window.setTimeout(() => undefined, Number(slipId.length));',
    '      }}',
    '    >',
    '      Raise the lantern',
    '    </button>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

/**
 * How many named handlers the many-anchor corpus declares.
 *
 * Derived from the adapter's own exported limit rather than written as a
 * literal, and deliberately larger than it, so the cap assertion compares the
 * plan against the same number the adapter clamps to and a change to that
 * limit cannot leave this corpus too small to reach it.
 */
const MANY_ANCHOR_COUNT = BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxTargets + 2;

/**
 * The many-anchor corpus: one component per file, each binding its own
 * module-scope named handler by reference.
 *
 * More anchors than one proposal may name, several components to narrow
 * between, and — since the perf observers are document-wide — exactly one
 * `'perf-tracking'` action however many of them there are.
 */
const MANY_ANCHOR_SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  Array.from({ length: MANY_ANCHOR_COUNT }, (_unused, index) => [
    `src/panes/GirderPane${String(index)}.tsx`,
    [
      "'use client';",
      '',
      `export function settleGirderRoster${String(index)}(): void {`,
      `  window.setTimeout(() => undefined, ${String(index)});`,
      '}',
      '',
      `export function GirderPane${String(index)}() {`,
      '  return (',
      `    <button type="button" onClick={settleGirderRoster${String(index)}}>`,
      `      Settle girder ${String(index)}`,
      '    </button>',
      '  );',
      '}',
      '',
    ].join('\n'),
  ]),
);

/** The arbitrary component names the hand-authored multi-anchor index holds. */
const HAND_AUTHORED_PANES: readonly string[] = ['AbacusPane', 'BezelPane', 'CoraclePane'];

/**
 * The nodes and edges of the hand-authored multi-anchor index: one component,
 * one declared handler and the `handles` edge joining them, per name above.
 *
 * @returns The node and edge lists.
 */
function multiAnchorGraphParts(): { nodes: CodeNode[]; edges: CodeEdge[] } {
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];

  for (const [index, pane] of HAND_AUTHORED_PANES.entries()) {
    const file = `src/panes/${pane}.tsx`;
    const handlerName = `dampen${pane}Tally`;
    const component = componentNode(file, pane, 3);
    const handler = handlerNode(file, handlerName, 11 + index, 'click', false);

    nodes.push(component, symbolNode(file, handlerName, 11 + index), handler);
    edges.push(handlesEdge(component.id, handler.id));
  }

  return { nodes, edges };
}

/* -------------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

/** The committed fixture, indexed once. */
let fixture: IndexedProject;

/** The corpus whose only binding is an inline arrow. */
let inlineHandler: IndexedProject;

/** The corpus with more named handlers than one proposal may contain. */
let manyAnchors: IndexedProject;

/** A hand-authored graph with several components and several handlers. */
let multiAnchor: IndexedProject;

/** A hand-authored graph with components and no handler binding at all. */
let componentsOnly: IndexedProject;

/** A hand-authored graph with neither a handler nor a component. */
let anchorless: IndexedProject;

/** Every file of the committed fixture with its SHA-256, taken before anything ran. */
let fixtureSnapshotBefore: readonly string[];

beforeAll(async () => {
  fixtureSnapshotBefore = treeSnapshot(FIXTURE_ROOT);
  fixture = await indexProjectTree(FIXTURE_ROOT);
  inlineHandler = await scratchProject('inline', INLINE_SOURCES);
  manyAnchors = await scratchProject('many-anchors', MANY_ANCHOR_SOURCES);

  const multi = multiAnchorGraphParts();

  multiAnchor = projectFromIndex(
    handAuthoredIndex(
      toPosix(join(tmpdir(), 'debuggen-bperf-multi-anchor')),
      multi.nodes,
      multi.edges,
    ),
    fixture,
  );
  componentsOnly = projectFromIndex(
    handAuthoredIndex(
      toPosix(join(tmpdir(), 'debuggen-bperf-components-only')),
      HAND_AUTHORED_PANES.map((pane, index) =>
        componentNode(`src/panes/${pane}.tsx`, pane, 3 + index),
      ),
    ),
    fixture,
  );
  anchorless = projectFromIndex(
    handAuthoredIndex(toPosix(join(tmpdir(), 'debuggen-bperf-anchorless')), [
      symbolNode('src/panes/pane-arithmetic.ts', 'combinePaneTallies', 4),
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
  // Two cases stub the environment to prove nothing is read from it. Restoring
  // here rather than there keeps a failure inside one of them from leaking a
  // stub into the rest of the run, and clearing the journal keeps every
  // "nothing was journaled" assertion independent of execution order.
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
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          walk(absolute);
        }

        continue;
      }

      if (entry.isFile()) {
        lines.push(`${toPosix(relative(root, absolute))} ${sha256Hex(readFileSync(absolute))}`);
      }
    }
  };

  walk(root);

  return lines.sort();
}

/**
 * Fails the whole run when a corpus stopped holding what the cases below read
 * off it.
 *
 * Every expectation in this suite is derived from a graph rather than written
 * down, which is what keeps the adapter honest — and what makes a silently
 * emptied corpus able to turn a real assertion into a vacuous one. This is the
 * one place the corpora's *shape* is stated, so that drift fails here instead
 * of passing quietly everywhere.
 */
function assertCorpusInventory(): void {
  const committedHandlers = fixture.graph.nodesByKind('handler');

  if (committedHandlers.length === 0) {
    throw new Error('the committed corpus must hold at least one handler binding');
  }

  // Fewer than the proposal bound, so that "one interaction anchor per named
  // handler" is what the committed corpus proves and never the cap.
  if (committedHandlers.length >= BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxTargets) {
    throw new Error(
      `the committed corpus must hold fewer handler bindings than the proposal bound, found ${String(committedHandlers.length)}`,
    );
  }

  for (const handler of committedHandlers) {
    if (handler.data.inline) {
      throw new Error(
        `the committed corpus must hold only NAMED handler bindings, but ${handler.file}:${String(handler.line)} is an inline arrow`,
      );
    }
  }

  if (fixture.graph.nodesByKind('component').length < 2) {
    throw new Error('the committed corpus must hold at least two components');
  }

  const inlineHandlers = inlineHandler.graph.nodesByKind('handler');

  if (inlineHandlers.length !== 1 || inlineHandlers[0]?.data.inline !== true) {
    throw new Error('the inline corpus must hold exactly one inline-arrow handler');
  }

  if (manyAnchors.graph.nodesByKind('handler').length !== MANY_ANCHOR_COUNT) {
    throw new Error(
      `the many-anchor corpus must hold ${String(MANY_ANCHOR_COUNT)} handler bindings`,
    );
  }

  if (multiAnchor.graph.nodesByKind('handler').length !== HAND_AUTHORED_PANES.length) {
    throw new Error('the hand-authored corpus must hold one handler per pane');
  }

  if (
    componentsOnly.graph.nodesByKind('handler').length !== 0 ||
    componentsOnly.graph.nodesByKind('component').length !== HAND_AUTHORED_PANES.length
  ) {
    throw new Error('the components-only corpus must hold components and no handler');
  }

  if (
    anchorless.graph.nodesByKind('handler').length !== 0 ||
    anchorless.graph.nodesByKind('component').length !== 0 ||
    anchorless.graph.nodes().length === 0
  ) {
    throw new Error('the anchorless corpus must hold declarations but no handler and no component');
  }
}

/* -------------------------------------------------------------------------------------------------
 * Graph readers
 *
 * Every expectation about an anchor is resolved through the graph here, so that
 * an assertion cannot agree with the adapter by both restating the same
 * literal.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Asserts a value is present and returns it narrowed.
 *
 * Used where a graph lookup is expected to succeed and a missing value would
 * otherwise turn into a confusing failure three assertions later.
 *
 * @param value The value.
 * @param what What it was, for the failure message.
 * @returns The value.
 * @typeParam T The value's type.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the suite expected ${what} to exist`);
  }

  return value;
}

/**
 * Locale-free code-point ordering, the same total order the adapter sorts
 * anchors by, so an expectation derived here cannot drift from it under a
 * different locale.
 *
 * @param left One string.
 * @param right The other.
 * @returns Negative, zero or positive.
 */
function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

/**
 * The committed corpus's handler nodes, in the adapter's own total order —
 * project-relative file, then declaration line, then symbol — which is the
 * order an unevidenced proposal names them in.
 *
 * @returns The nodes, best-ranked first.
 */
function fixtureHandlers(): readonly CodeNodeOf<'handler'>[] {
  return [...fixture.graph.nodesByKind('handler')].sort(
    (left, right) =>
      compareCodePoints(left.file, right.file) ||
      left.line - right.line ||
      compareCodePoints(left.symbol ?? left.name, right.symbol ?? right.name),
  );
}

/**
 * The committed corpus's best-ranked handler node: the anchor the single
 * performance action records as its provenance.
 *
 * @returns The node.
 */
function fixtureHandler(): CodeNodeOf<'handler'> {
  return must(fixtureHandlers()[0], "the fixture's best-ranked handler node");
}

/**
 * The `(file, symbol)` an anchor on one handler node should carry: the declared
 * identifier the graph recorded, in the file the graph recorded it in.
 *
 * @param handler The handler node.
 * @returns The expected file and symbol.
 */
function expectedHandlerAnchor(handler: CodeNodeOf<'handler'>): {
  readonly file: string;
  readonly symbol: string;
} {
  return { file: handler.file, symbol: handler.symbol ?? handler.name };
}

/**
 * The component node the graph says a handler binding sits inside, resolved
 * through the incoming `handles` edge the way the adapter resolves it.
 *
 * @param project The project holding the graph.
 * @param handler The handler node.
 * @returns The enclosing component node.
 */
function enclosingComponentOf(
  project: IndexedProject,
  handler: CodeNodeOf<'handler'>,
): CodeNodeOf<'component'> {
  for (const neighbor of project.graph.neighbors(handler.id, {
    kind: 'handles',
    direction: 'in',
  })) {
    if (neighbor.kind === 'component') {
      return neighbor;
    }
  }

  throw new Error(`the suite expected a component to enclose ${handler.id}`);
}

/**
 * The handlers the graph says one named component binds.
 *
 * The narrowing cases compare a plan against this, so "narrowed to that
 * component's handlers" is a statement about the graph rather than about a name
 * the case happens to know.
 *
 * @param project The project holding the graph.
 * @param componentName The component's display name.
 * @returns The handler nodes bound inside it.
 */
function handlersOfComponent(
  project: IndexedProject,
  componentName: string,
): readonly CodeNodeOf<'handler'>[] {
  const handlers: CodeNodeOf<'handler'>[] = [];

  for (const component of project.graph.nodesByKind('component')) {
    if (component.name !== componentName) {
      continue;
    }

    for (const neighbor of project.graph.neighbors(component.id, {
      kind: 'handles',
      direction: 'out',
    })) {
      if (neighbor.kind === 'handler') {
        handlers.push(neighbor);
      }
    }
  }

  return handlers;
}

/**
 * The markup attribute name a handler's event would be bound through:
 * `'on'` plus the capitalised event name.
 *
 * Computed from the graph's own event value rather than written down, because
 * the one assertion that needs it — "the anchor names the declaration, not the
 * binding site" — must not import the corpus's vocabulary to make its point.
 *
 * @param event The DOM event name, without its `on` prefix.
 * @returns The attribute name.
 */
function attributeNameFor(event: string): string {
  return `on${event.slice(0, 1).toUpperCase()}${event.slice(1)}`;
}

/**
 * The 1-based line a substring first occurs on in a file.
 *
 * A text offset rather than a hardcoded line number: the corpus is a committed
 * file that may legitimately gain a line, and an assertion pinned to `33` would
 * fail for a reason that has nothing to do with this adapter.
 *
 * @param project The project the file belongs to.
 * @param file The project-relative POSIX path.
 * @param needle The substring to find.
 * @returns The 1-based line number.
 */
function lineOf(project: IndexedProject, file: string, needle: string): number {
  const source = readFileSync(join(project.root, file), 'utf8');
  const index = source.indexOf(needle);

  if (index < 0) {
    throw new Error(`the suite expected ${file} to contain ${needle}`);
  }

  return source.slice(0, index).split('\n').length;
}

/* -------------------------------------------------------------------------------------------------
 * The injected ports
 * ---------------------------------------------------------------------------------------------- */

/** One call a case observed on the journal. */
interface JournalEvent {
  /** The method that was called. */
  readonly method: string;

  /** What it was called about. */
  readonly subject: string;
}

/** Every journal call of the current case. */
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

    throw new Error('the browser-performance adapter must never update a modification record');
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
    throw new Error('the browser-performance adapter must never locate a backup');
  },
  put: () => {
    throw new Error('the browser-performance adapter must never write a backup');
  },
  read: () => {
    throw new Error('the browser-performance adapter must never read a backup');
  },
  has: () => {
    throw new Error('the browser-performance adapter must never query a backup');
  },
  verify: () => {
    throw new Error('the browser-performance adapter must never verify a backup');
  },
  remove: () => {
    throw new Error('the browser-performance adapter must never remove a backup');
  },
  removeSessionDirectory: () => {
    throw new Error('the browser-performance adapter must never remove a backup directory');
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
 * service can genuinely have observed and relayed, and two of them are the
 * boundary this adapter is defined by: a page agent that loaded after React,
 * or reported no React at all, is still a page agent — a capture-phase
 * listener, a `PerformanceObserver` and a `window` error handler do not care —
 * and a dev-server preload is not this adapter's evidence at all.
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
const AGENT_DOCUMENT_URL = 'http://127.0.0.1:20081/panes?slip=girder-nine&token=zephyr';

/** The named page-agent states a case selects from. */
interface AgentPresets {
  /** No `agent.ready` has arrived for the bound tab's current document. */
  readonly absent: ObservedReadinessInputs;

  /** A page agent has reported, before React loaded, with React detected. */
  readonly present: ObservedReadinessInputs;

  /**
   * A page agent that was installed **after** React and detected none.
   *
   * The regression boundary. The React adapter gates its commit observation on
   * `installedBeforeReact`, because a fiber hook has to exist before React
   * loads; interactions, performance entries and page errors do not depend on
   * that ordering and work on a page with no React on it at all. This preset
   * must therefore read exactly like {@link AgentPresets.present}, and the
   * install group asserts that no hint mentioning a reload is produced for it.
   */
  readonly presentWithoutReact: ObservedReadinessInputs;

  /** A page agent whose last report is older than the adapter's own bound. */
  readonly stale: ObservedReadinessInputs;

  /**
   * A dev-server preload is attached and no page agent has reported.
   *
   * None of this adapter's three signals exists in the dev-server process, so
   * this preset must read exactly like {@link AgentPresets.absent}.
   */
  readonly serverAgentOnly: ObservedReadinessInputs;
}

/**
 * How far past the adapter's own staleness bound the stale preset's report sits.
 *
 * One millisecond, and derived from the exported limit rather than written as a
 * round number, so the preset pins the boundary itself: the adapter treats a
 * report as stale only when its age is *strictly greater* than the bound.
 */
const STALE_OVERSHOOT_MS = 1;

/**
 * Builds the presets for one project.
 *
 * A function of the project rather than a constant, because the server-agent
 * state names a project root and "attached to this project" is only expressible
 * relative to one.
 *
 * @param project The project the presets are about.
 * @returns The five named states.
 */
function agentPresets(project: IndexedProject): AgentPresets {
  const reported = (overrides: Partial<ObservedBrowserAgent> = {}): ObservedBrowserAgent => ({
    producerId: 'prd_browserperf0001',
    documentId: 'doc_browserperf0001',
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
    stale: {
      browserAgent: reported({
        observedAt:
          NOW - BROWSER_PERFORMANCE_ADAPTER_LIMITS.staleReportAfterMs - STALE_OVERSHOOT_MS,
      }),
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

/** The preset names under which this adapter's signals can be collected. */
const COLLECTABLE_PRESETS: readonly (keyof AgentPresets)[] = [
  'present',
  'presentWithoutReact',
  'stale',
];

/** The preset names under which no page agent has reported at all. */
const AGENTLESS_PRESETS: readonly (keyof AgentPresets)[] = ['absent', 'serverAgentOnly'];

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

  /** Cancellation, for the abort case. */
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
  signalsNeeded: readonly CaptureSignal[],
  entities: readonly { readonly kind: ProblemEntityKind; readonly name: string }[] = [],
  searchHints: readonly string[] = [],
): ProblemUnderstanding {
  return problemUnderstandingSchema.parse({
    category: 'performance',
    signalsNeeded: [...signalsNeeded],
    entities: entities.map((entity) => ({ ...entity })),
    searchHints: [...searchHints],
  });
}

/** Everything this adapter's two signals can be asked for at once. */
const interactionAndPerfQuestion = understandingFor(['interactions', 'perf']);

/** A question that asks for the interaction signal and nothing else. */
const interactionOnlyQuestion = understandingFor(['interactions']);

/** A question that asks only for page errors, which the perf hook supplies. */
const errorOnlyQuestion = understandingFor(['errors']);

/** A question whose signals all belong to the dev-server preload. */
const serverOnlyQuestion = understandingFor(['http', 'routeHandlers', 'prisma']);

/**
 * Builds a validated selected target for one component chain.
 *
 * The {@link InstrumentationContext} carries no selected target of its own: the
 * component chain the page agent resolved for `$0` reaches an adapter as
 * `'component'` entities on the understanding, which is the path
 * {@link understandingForTarget} models. Validating the descriptor first is
 * what keeps this suite exercising that real path rather than a shortcut.
 *
 * @param componentChain The owner chain, nearest component first.
 * @returns The target.
 */
function targetFor(componentChain: readonly string[]): SelectedTarget {
  return selectedTargetSchema.parse({
    selector: 'button.pane-action:nth-of-type(1)',
    tagName: 'button',
    text: 'Settle',
    componentChain: [...componentChain],
    url: AGENT_DOCUMENT_URL,
  });
}

/**
 * The understanding a selected element produces: its component chain carried as
 * `'component'` entities, nearest first.
 *
 * @param target The selected target.
 * @param signalsNeeded The signals the question asks for.
 * @returns The understanding.
 */
function understandingForTarget(
  target: SelectedTarget,
  signalsNeeded: readonly CaptureSignal[] = ['interactions', 'perf'],
): ProblemUnderstanding {
  return understandingFor(
    signalsNeeded,
    target.componentChain.map((name) => ({ kind: 'component' as const, name })),
  );
}

/* -------------------------------------------------------------------------------------------------
 * Call helpers
 * ---------------------------------------------------------------------------------------------- */

/** What a case varies about a `createPlan` call. */
interface PlanInput {
  /** The project to plan against. */
  readonly project: IndexedProject;

  /** The understanding to plan from. Defaults to interactions plus perf. */
  readonly understanding?: ProblemUnderstanding | undefined;

  /** A bound to build the adapter with, for the cap cases. */
  readonly maxTargets?: number | undefined;

  /** Cancellation, for the abort case. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Plans against one project with a healthy page agent.
 *
 * Readiness is deliberately the *healthy* preset here: `createPlan` must not
 * consult it at all, and every capability case below is also run against the
 * agentless presets to prove that.
 *
 * @param input What this case varies.
 * @returns The proposed actions.
 */
async function planFor(input: PlanInput): Promise<InstrumentationAction[]> {
  const adapter = createBrowserPerformanceAdapter(
    input.maxTargets === undefined ? {} : { maxTargets: input.maxTargets },
  );

  return adapter.createPlan(
    contextFor({
      project: input.project,
      readiness: agentPresets(input.project).present,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
    input.understanding ?? interactionAndPerfQuestion,
  );
}

/**
 * The actions of a plan with their minted ids removed.
 *
 * Two plans over one graph must be identical except for the ids, which are
 * random by contract, so the comparison that proves determinism has to strip
 * exactly that field and nothing else.
 *
 * @param actions The actions.
 * @returns The actions without their ids, in order.
 */
function withoutIds(actions: readonly InstrumentationAction[]): unknown[] {
  // Enumerated rather than destructured with a discarded binding: every other
  // field is named here, so a field added to an action fails this helper until
  // the determinism comparison is told whether it is part of a plan's identity.
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
 * The `type` of every action, in order.
 *
 * @param actions The actions.
 * @returns The types.
 */
function typesOf(actions: readonly InstrumentationAction[]): string[] {
  return actions.map((action) => action.type);
}

/**
 * The `«file»#«symbol»` anchor of every action, in order.
 *
 * @param actions The actions.
 * @returns The anchors.
 */
function anchorsOf(actions: readonly InstrumentationAction[]): string[] {
  return actions.map((action) => `${action.file}#${action.symbol}`);
}

/**
 * The actions of one type, in order.
 *
 * @param actions The actions.
 * @param type The type to keep.
 * @returns The subset.
 */
function ofType(
  actions: readonly InstrumentationAction[],
  type: string,
): readonly InstrumentationAction[] {
  return actions.filter((action) => action.type === type);
}

/**
 * A valid action this adapter must ignore.
 *
 * Built through the plan schema rather than as a literal object, so a case
 * cannot hand `install` something a normalised plan could never contain — which
 * would make "ignored silently" a statement about an impossible input.
 *
 * @param overrides The adapter id and type that make it foreign.
 * @returns The action.
 */
function foreignAction(overrides: {
  readonly adapter: string;
  readonly type: string;
}): InstrumentationAction {
  return instrumentationActionSchema.parse({
    id: 'act_0123456789abcdef',
    file: 'src/panes/somewhere-else.ts',
    symbol: 'unrelatedPaneWork',
    type: overrides.type,
    adapter: overrides.adapter,
    mode: 'runtime',
    rationale: 'Planned by a different adapter, and this one must leave it alone.',
  });
}

/**
 * Installs one plan against one project and preset.
 *
 * @param project The project.
 * @param preset The page-agent state to inject.
 * @param actions The actions to install.
 * @param logger Where to log, when a case is watching.
 * @returns The install result.
 */
async function installFor(
  project: IndexedProject,
  preset: keyof AgentPresets,
  actions: readonly InstrumentationAction[],
  logger?: Logger,
): Promise<InstallResult> {
  return createBrowserPerformanceAdapter().install(
    actions,
    contextFor({
      project,
      readiness: agentPresets(project)[preset],
      ...(logger === undefined ? {} : { logger }),
    }),
  );
}

/**
 * Produces a readiness report for one project and preset.
 *
 * @param project The project.
 * @param preset The page-agent state to inject.
 * @returns The report.
 */
async function readinessFor(
  project: IndexedProject,
  preset: keyof AgentPresets,
): Promise<Readiness> {
  return createBrowserPerformanceAdapter().readiness(
    contextFor({ project, readiness: agentPresets(project)[preset] }),
  );
}

/**
 * Removes one session's instrumentation.
 *
 * @param project The project.
 * @param reason Why the removal is happening.
 * @param records The records the session holds, if any.
 * @returns The removal result.
 */
async function removeFor(
  project: IndexedProject,
  reason: AdapterRemoveReason,
  records?: readonly ModificationRecord[],
): Promise<RemoveResult> {
  return createBrowserPerformanceAdapter().remove(
    {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      reason,
      ...(records === undefined ? {} : { records }),
    },
    contextFor({ project, readiness: agentPresets(project).present }),
  );
}

/**
 * The hook configuration this adapter's contribution amounts to, merged over
 * the dormant seven-flag configuration and **validated**.
 *
 * The merge is the point. `agentHookConfigSchema` is a strict object over all
 * seven required flags, and a contribution carries only the keys that are
 * actually on — so parsing the merged configuration is what catches both
 * failure modes at once: a key this adapter is not entitled to set, and a
 * misspelled key, which `z.strictObject` rejects rather than ignores. A
 * hand-rolled key map that armed nothing would pass a shallow shape check and
 * fail here.
 *
 * @param contribution The `agentHooks` field of an install result.
 * @returns The validated, complete configuration.
 */
function mergedHookConfig(contribution: Partial<AgentHookConfig> | undefined): AgentHookConfig {
  return agentHookConfigSchema.parse({ ...DORMANT_AGENT_HOOK_CONFIG, ...contribution });
}

/**
 * The hook keys a validated configuration has on.
 *
 * @param config The configuration.
 * @returns The enabled keys, in `AGENT_HOOK_KEYS` order.
 */
function enabledHookKeys(config: AgentHookConfig): AgentHookKey[] {
  return AGENT_HOOK_KEYS.filter((key) => config[key]);
}

/**
 * Every developer-facing string an install result carries.
 *
 * @param result The install result.
 * @returns The hook names, reasons and hints.
 */
function installStrings(result: InstallResult): string[] {
  return [...result.runtimeHooks, ...gapStrings(result.unavailable)];
}

/**
 * Every developer-facing string a set of gaps carries.
 *
 * @param unavailable The gaps.
 * @returns The signal names, reasons and hints.
 */
function gapStrings(unavailable: readonly UnavailableSignal[]): string[] {
  return unavailable.flatMap((gap) => [gap.signal, gap.reason, gap.hint]);
}

/**
 * Every developer-facing string a readiness report carries.
 *
 * @param report The report.
 * @returns The signal names, reasons and hints that are present.
 */
function readinessStrings(report: Readiness): string[] {
  return report.signals.flatMap((signal) =>
    [signal.signal, signal.reason, signal.hint].filter(
      (value): value is string => value !== undefined,
    ),
  );
}

/* -------------------------------------------------------------------------------------------------
 * The leak guard
 *
 * A capture's evidence is the developer's data (AAP §0.5.2), and a hook name, a
 * reason, a hint or a log field is rendered in two user interfaces and written
 * to a log file. None of them is a place for a name read out of an
 * application's source — which the *rationales* legitimately carry, because a
 * rationale's whole job is to say which declaration the graph selected.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The file names every project in this repository's corpora carries by
 * construction.
 *
 * They are project *scaffolding*, not application vocabulary: `openProject`
 * takes its compiler options from a target project's own `tsconfig.json`, the
 * project summary reads the package manager from `package.json`, and the router
 * style is detected from the framework's config file — so every corpus here has
 * all three, and a name two corpora share by construction can say nothing about
 * whether an adapter read a graph or recognised a name.
 */
const SCAFFOLDING_FILE_NAMES: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'next.config.mjs',
  'next.config.ts',
  'next-env.d.ts',
];

/**
 * The distinctive identifiers and paths one corpus holds.
 *
 * Read off the graph rather than written down: a name with two camel-case
 * tokens, a hyphen or a dot is specific enough that its appearance in a hook
 * name or a hint could not be a coincidence, while a single generic word could
 * legitimately occur in English prose. The scaffolding above is excluded for
 * the reason given there.
 *
 * @param project The project to read.
 * @returns The distinctive strings.
 */
function distinctiveNames(project: IndexedProject): readonly string[] {
  const names = new Set<string>();

  for (const node of project.graph.nodes()) {
    for (const candidate of [node.name, node.file]) {
      const basename = candidate.slice(candidate.lastIndexOf('/') + 1);

      if (SCAFFOLDING_FILE_NAMES.includes(basename)) {
        continue;
      }

      if (candidate.length >= 6 && /[a-z][A-Z]|[-.]/u.test(candidate)) {
        names.add(candidate);
      }
    }
  }

  return [...names];
}

/**
 * Asserts no corpus identifier appears in a set of developer-facing strings.
 *
 * @param values The strings to check.
 * @param what What they are, for the failure message.
 * @param project The corpus whose names must not appear.
 */
function expectNoLeak(
  values: readonly string[],
  what: string,
  project: IndexedProject = fixture,
): void {
  const forbidden = distinctiveNames(project);

  expect(forbidden.length, 'the leak guard must have something to look for').toBeGreaterThan(0);

  for (const value of values) {
    for (const name of forbidden) {
      expect(value.includes(name), `${what} must not name "${name}"`).toBe(false);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * The corpora
 *
 * The harness asserted before anything reads it. Every expectation in this file
 * is derived from a graph, so a corpus that stopped holding what it holds would
 * turn real assertions into vacuous ones — and this group is where that fails.
 * ---------------------------------------------------------------------------------------------- */

describe('the corpora', () => {
  it('indexed the committed corpus through the product’s own path', () => {
    expect(fixture.root).toBe(FIXTURE_ROOT);
    expect(fixture.loaded).toBeDefined();
    expect(fixture.graph.nodes().length).toBeGreaterThan(0);
    expect(fixture.graph.nodesByKind('handler').length).toBeGreaterThan(0);
    expect(fixture.graph.nodesByKind('handler').length).toBeLessThan(
      BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxTargets,
    );
    expect(fixture.projectSummary.framework).toBeDefined();
  });

  it('holds only named handlers and no inline arrow in the committed corpus', () => {
    const handlers = fixtureHandlers();

    expect(handlers.length).toBeGreaterThan(0);

    for (const handler of handlers) {
      expect(handler.data.inline).toBe(false);
      expect(handler.data.event.length).toBeGreaterThan(0);
      expect(handler.symbol ?? handler.name).toBe(handler.name);

      // The anchor rule's gate: the declaration has to be one `hasSymbol`
      // affirms, or the adapter would propose a symbol `../feasibility.ts`
      // would reject.
      expect(fixture.queries.hasSymbol(handler.file, handler.name)).toBe(true);
    }

    // Distinct declarations: two bindings resolving to one symbol would make
    // "one anchor per handler" and "de-duplicated" indistinguishable here.
    expect(new Set(handlers.map((handler) => `${handler.file}#${handler.name}`)).size).toBe(
      handlers.length,
    );
  });

  it('holds the scratch corpora the committed one cannot produce', () => {
    const inline = must(inlineHandler.graph.nodesByKind('handler')[0], 'the inline handler');

    expect(inline.data.inline).toBe(true);
    expect(inline.symbol).toBeUndefined();
    expect(inlineHandler.queries.hasSymbol(inline.file, inline.name)).toBe(false);

    expect(manyAnchors.graph.nodesByKind('handler').length).toBe(MANY_ANCHOR_COUNT);
    expect(MANY_ANCHOR_COUNT).toBeGreaterThan(BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxTargets);

    expect(multiAnchor.graph.nodesByKind('component').length).toBe(HAND_AUTHORED_PANES.length);
    expect(multiAnchor.graph.nodesByKind('handler').length).toBe(HAND_AUTHORED_PANES.length);
    expect(componentsOnly.graph.nodesByKind('handler').length).toBe(0);
    expect(anchorless.graph.nodesByKind('component').length).toBe(0);
  });

  it('shares no identifier between the committed corpus and a scratch one', () => {
    const fixtureNames = new Set(distinctiveNames(fixture));

    for (const project of [inlineHandler, manyAnchors, multiAnchor]) {
      for (const name of distinctiveNames(project)) {
        expect(fixtureNames.has(name), `"${name}" must be unique to one corpus`).toBe(false);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Identity and claims
 *
 * The three exports `../registry.ts` and `../installer.ts` read. They are the
 * adapter's whole contract with the rest of the package, and a typo in any of
 * them fails silently: an unrecognised action type claims nothing, and a hook
 * key that is not a key of `AgentHookConfig` arms nothing.
 * ---------------------------------------------------------------------------------------------- */

describe('the adapter identity and claims', () => {
  it('registers under its kebab-case module name', () => {
    expect(BROWSER_PERFORMANCE_ADAPTER_ID).toBe('browser-performance');
    expect(createBrowserPerformanceAdapter().id).toBe(BROWSER_PERFORMANCE_ADAPTER_ID);
  });

  it('claims exactly the two runtime action types it installs', () => {
    expect(Object.keys(BROWSER_PERFORMANCE_ADAPTER_CLAIMS).sort()).toEqual([
      'interaction-tracking',
      'perf-tracking',
    ]);

    for (const [type, mode] of Object.entries(BROWSER_PERFORMANCE_ADAPTER_CLAIMS)) {
      expect(
        (INSTRUMENTATION_ACTION_TYPES as readonly string[]).includes(type),
        `"${type}" must be a declared action type`,
      ).toBe(true);
      expect(
        (INSTRUMENTATION_MODES as readonly string[]).includes(mode),
        `"${mode}" must be a declared mode`,
      ).toBe(true);

      // Runtime, not patch: these signals are observed through browser APIs
      // that already exist, so neither costs a byte of a developer's file
      // (AAP §0.5.1).
      expect(mode).toBe('runtime');
    }

    expect(createBrowserPerformanceAdapter().claims).toBe(BROWSER_PERFORMANCE_ADAPTER_CLAIMS);
    expect(Object.isFrozen(BROWSER_PERFORMANCE_ADAPTER_CLAIMS)).toBe(true);
  });

  it('names only real page-agent hook keys, including the error capture', () => {
    expect(BROWSER_PERFORMANCE_HOOK_KEYS.length).toBeGreaterThan(0);

    for (const key of BROWSER_PERFORMANCE_HOOK_KEYS) {
      expect(
        (AGENT_HOOK_KEYS as readonly string[]).includes(key),
        `"${key}" must be a key of AgentHookConfig`,
      ).toBe(true);
      expect(
        Object.prototype.hasOwnProperty.call(DORMANT_AGENT_HOOK_CONFIG, key),
        `"${key}" must exist on the dormant configuration`,
      ).toBe(true);

      // Every hook key is also a capture-signal name, which is what lets the
      // readiness rows and the unavailable rows be derived from this one tuple.
      expect(
        (CAPTURE_SIGNALS as readonly string[]).includes(key),
        `"${key}" must be a capture signal`,
      ).toBe(true);
    }

    // The three this adapter owns: the interaction listener every browser
    // signal hangs off, the performance observers, and the page errors that
    // would otherwise hide behind a long task.
    expect([...BROWSER_PERFORMANCE_HOOK_KEYS].sort()).toEqual(['errors', 'interactions', 'perf']);
    expect(Object.isFrozen(BROWSER_PERFORMANCE_HOOK_KEYS)).toBe(true);
  });

  it('publishes the bounds a suite and a caller read instead of transcribing', () => {
    const limits = BROWSER_PERFORMANCE_ADAPTER_LIMITS;

    expect(Object.isFrozen(limits)).toBe(true);
    expect(Number.isSafeInteger(limits.maxTargets) && limits.maxTargets > 0).toBe(true);
    expect(Number.isSafeInteger(limits.staleReportAfterMs) && limits.staleReportAfterMs > 0).toBe(
      true,
    );
    expect(Number.isSafeInteger(limits.maxEvidenceMatches) && limits.maxEvidenceMatches > 0).toBe(
      true,
    );
    expect(createBrowserPerformanceAdapter().limits).toEqual(limits);
  });

  it('constructs with no side effect and shares no mutable state', () => {
    const first = createBrowserPerformanceAdapter();
    const second = createBrowserPerformanceAdapter();
    const bounded = createBrowserPerformanceAdapter({ maxTargets: 1 });

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.limits).toEqual(second.limits);

    // A bound handed to one instance cannot reach another: nothing is written
    // to module state, which is what makes the registry able to build these at
    // start-up and share them across sessions.
    expect(bounded.limits.maxTargets).toBe(1);
    expect(second.limits.maxTargets).toBe(BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxTargets);

    // Importing the module and building an adapter touches no filesystem and
    // no port: the state root the contexts name is never created.
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(journalEvents).toEqual([]);
  });

  it('clamps an unusable bound instead of failing to construct', () => {
    const lines: LogLine[] = [];

    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const adapter = createBrowserPerformanceAdapter({
        maxTargets: value,
        staleReportAfterMs: value,
        logger: capturingLogger(lines),
      });

      expect(adapter.limits.maxTargets).toBe(BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxTargets);
      expect(adapter.limits.staleReportAfterMs).toBe(
        BROWSER_PERFORMANCE_ADAPTER_LIMITS.staleReportAfterMs,
      );
    }

    // Sanitised rather than silent: the registry builds the built-ins while the
    // service is starting, so a mistyped knob must degrade to the default and
    // still be discoverable.
    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);

    for (const line of lines) {
      expect(line.fields['adapter']).toBe(BROWSER_PERFORMANCE_ADAPTER_ID);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * canHandle
 *
 * Capability, not readiness. Whether a page agent has reported is `readiness`'s
 * question, and answering it here would make a project this adapter can serve
 * look like one it cannot — the session would never reach the plan that would
 * have told the developer to open their application.
 * ---------------------------------------------------------------------------------------------- */

describe('canHandle', () => {
  it('accepts a project whose graph holds a handler binding', () => {
    const answer = createBrowserPerformanceAdapter().canHandle(
      contextFor({ project: fixture, readiness: agentPresets(fixture).present }),
    );

    // Synchronous by contract: the installer and the planner call this for
    // every adapter on every plan, so it is two bucket reads on the graph and
    // never a promise.
    expect(typeof answer).toBe('boolean');
    expect(answer).toBe(true);
    expect(answer).not.toBeInstanceOf(Promise);
  });

  it('accepts a project with components and no handler binding at all', () => {
    // The documented document-wide fallback, and a deliberate design decision
    // rather than an accident: `PerformanceObserver` and a capture-phase
    // listener observe the whole document, so they need no named handler — a
    // component is still a real, graph-derived place to attribute the action
    // to.
    expect(
      createBrowserPerformanceAdapter().canHandle(contextFor({ project: componentsOnly })),
    ).toBe(true);
  });

  it('declines a project whose graph holds neither a handler nor a component', () => {
    expect(anchorless.graph.nodes().length).toBeGreaterThan(0);
    expect(createBrowserPerformanceAdapter().canHandle(contextFor({ project: anchorless }))).toBe(
      false,
    );
  });

  it('answers the same way whatever the page agent has reported', () => {
    const adapter = createBrowserPerformanceAdapter();

    for (const [name, readiness] of presetEntries(fixture)) {
      expect(
        adapter.canHandle(contextFor({ project: fixture, readiness })),
        `capability must not depend on the '${name}' page-agent state`,
      ).toBe(true);
    }

    for (const [name, readiness] of presetEntries(anchorless)) {
      expect(
        adapter.canHandle(contextFor({ project: anchorless, readiness })),
        `capability must not depend on the '${name}' page-agent state`,
      ).toBe(false);
    }
  });

  it('touches no filesystem and journals nothing', () => {
    const lines: LogLine[] = [];

    createBrowserPerformanceAdapter().canHandle(
      contextFor({ project: fixture, logger: capturingLogger(lines) }),
    );

    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(lines).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan
 *
 * The group that holds AAP §0.5.4 at the unit level. Every anchor below is
 * resolved through the graph, and the only application-specific strings in a
 * proposal are values interpolated out of that graph at run time.
 * ---------------------------------------------------------------------------------------------- */

describe('createPlan', () => {
  it('proposes only actions a normalised plan would accept', async () => {
    const actions = await planFor({ project: fixture });

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      // Parsed through the plan's own schema: a proposal this package's
      // internal schema would reject is a defect wherever it was produced.
      expect(instrumentationActionSchema.parse(action)).toEqual(action);

      expect(action.id).toMatch(ACTION_ID_PATTERN);
      expect(action.adapter).toBe(BROWSER_PERFORMANCE_ADAPTER_ID);
      expect(action.mode).toBe('runtime');
      expect(Object.keys(BROWSER_PERFORMANCE_ADAPTER_CLAIMS)).toContain(action.type);
      expect(action.rationale.trim().length).toBeGreaterThan(0);

      // The feasibility gate: an action naming a symbol the graph does not
      // affirm would be rejected by `../feasibility.ts` before anything ran.
      expect(
        fixture.queries.hasSymbol(action.file, action.symbol),
        `${action.file}#${action.symbol} must resolve through the graph`,
      ).toBe(true);
    }

    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
  });

  it('anchors one interaction action on every handler the graph found, in graph order', async () => {
    const handlers = fixtureHandlers();
    const interactions = ofType(await planFor({ project: fixture }), 'interaction-tracking');

    // One anchor per named handler — the corpus holds fewer than the bound, so
    // nothing here is the cap at work — in the adapter's total order.
    expect(interactions.length).toBe(handlers.length);
    expect(anchorsOf(interactions)).toEqual(
      handlers.map((handler) => {
        const expected = expectedHandlerAnchor(handler);

        return `${expected.file}#${expected.symbol}`;
      }),
    );

    for (const [index, handler] of handlers.entries()) {
      const expected = expectedHandlerAnchor(handler);
      const action = must(interactions[index], `the interaction action for ${expected.symbol}`);

      expect(action.file).toBe(expected.file);
      expect(action.symbol).toBe(expected.symbol);

      // The rationale states the graph relationship that selected the anchor,
      // with graph-derived values interpolated — the event name included.
      expect(action.rationale).toContain(expected.symbol);
      expect(action.rationale).toContain(expected.file);
      expect(action.rationale).toContain(handler.data.event);
    }
  });

  it('points at each handler’s own declaration and not at its binding site', async () => {
    const interactions = ofType(await planFor({ project: fixture }), 'interaction-tracking');

    for (const handler of fixtureHandlers()) {
      const declaration = must(
        fixture.queries.findSymbol(handler.file, handler.symbol ?? handler.name),
        `the declaration ${handler.name} resolves to`,
      );
      const attributeLine = lineOf(
        fixture,
        handler.file,
        `${attributeNameFor(handler.data.event)}={`,
      );

      // The graph records a named handler at its *own* declaration, which is
      // where "open source" should land. Both lines are resolved — one through
      // the graph, one through a text offset — rather than written down, so
      // this assertion cannot pass by restating a number. The corpus holds a
      // handler declared before its binding and one declared after it, so the
      // rule is exercised in both directions.
      expect(declaration.location.line).toBe(handler.line);
      expect(attributeLine).not.toBe(handler.line);

      const source = readFileSync(join(fixture.root, handler.file), 'utf8').split('\n');

      expect(must(source[handler.line - 1], 'the declaration line')).toContain(handler.name);
      expect(must(source[attributeLine - 1], 'the binding line')).toContain(
        attributeNameFor(handler.data.event),
      );

      const action = must(
        interactions.find(
          (candidate) =>
            candidate.file === declaration.file && candidate.symbol === declaration.symbol,
        ),
        `the interaction action anchored on ${handler.name}`,
      );

      expect(action.file).toBe(declaration.file);
      expect(action.symbol).toBe(declaration.symbol);
    }
  });

  it('plans the document-wide performance signal exactly once on the committed corpus', async () => {
    const actions = await planFor({ project: fixture });

    expect(ofType(actions, 'perf-tracking').length).toBe(1);
  });

  it('plans it exactly once however many anchors the graph holds', async () => {
    // Twice, because one anchor cannot distinguish "once" from "once per
    // anchor": a real source tree with more handlers than a proposal may name,
    // and a hand-authored graph with several components and several handlers.
    for (const project of [manyAnchors, multiAnchor]) {
      const actions = await planFor({ project });
      const interactions = ofType(actions, 'interaction-tracking');
      const performance = ofType(actions, 'perf-tracking');

      expect(interactions.length).toBeGreaterThan(1);
      expect(performance.length).toBe(1);

      // The single action's anchor is provenance only, and it is the
      // best-ranked one — so it is the first interaction anchor, never a
      // synthesised location.
      expect(must(performance[0], 'the performance action').file).toBe(
        must(interactions[0], 'the first interaction action').file,
      );
      expect(must(performance[0], 'the performance action').rationale).toContain('document-wide');
    }
  });

  it('plans it once for a project whose only anchors are components', async () => {
    const actions = await planFor({ project: componentsOnly });
    const interactions = ofType(actions, 'interaction-tracking');

    expect(interactions.length).toBe(HAND_AUTHORED_PANES.length);
    expect(ofType(actions, 'perf-tracking').length).toBe(1);

    for (const action of actions) {
      expect(componentsOnly.queries.hasSymbol(action.file, action.symbol)).toBe(true);
    }
  });

  it('anchors an inline arrow on its enclosing component and says so', async () => {
    const handler = must(inlineHandler.graph.nodesByKind('handler')[0], 'the inline handler');
    const component = enclosingComponentOf(inlineHandler, handler);
    const actions = await planFor({ project: inlineHandler });
    const action = must(ofType(actions, 'interaction-tracking')[0], 'the interaction action');

    expect(action.file).toBe(component.file);
    expect(action.symbol).toBe(component.name);

    // An unresolvable symbol would be worse than a component anchor: the plan
    // would name something no `hasSymbol` affirms and no editor could open.
    expect(action.symbol).not.toBe(handler.name);
    expect(inlineHandler.queries.hasSymbol(action.file, action.symbol)).toBe(true);
    expect(action.rationale).toContain(component.name);
    expect(action.rationale).toContain(handler.data.event);
    expect(action.rationale).toMatch(/no declaration of its own/u);
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan — narrowing
 *
 * Evidence is what keeps a question about one component from proposing a plan
 * naming every handler in the project. It arrives as the *structured*
 * understanding — entities and search hints resolved through the graph — and
 * never as the developer's question text (AAP §0.5.4).
 * ---------------------------------------------------------------------------------------------- */

describe('createPlan narrowing', () => {
  it('narrows to the handlers of the component a selected element named', async () => {
    const component = must(manyAnchors.graph.nodesByKind('component')[2], 'a component to select');
    const expected = handlersOfComponent(manyAnchors, component.name).map((handler) =>
      expectedHandlerAnchor(handler),
    );

    expect(expected.length).toBeGreaterThan(0);

    // The selected element travels as a validated `SelectedTarget` whose
    // component chain becomes `'component'` entities on the understanding —
    // the context carries no target of its own, so that is the real path.
    const actions = await planFor({
      project: manyAnchors,
      understanding: understandingForTarget(targetFor([component.name])),
    });

    expect(anchorsOf(ofType(actions, 'interaction-tracking'))).toEqual(
      expected.map((anchor) => `${anchor.file}#${anchor.symbol}`),
    );
    expect(ofType(actions, 'perf-tracking').length).toBe(1);
  });

  it('narrows to a declaration the understanding named', async () => {
    const handler = must(manyAnchors.graph.nodesByKind('handler')[4], 'a handler to name');
    const expected = expectedHandlerAnchor(handler);
    const actions = await planFor({
      project: manyAnchors,
      understanding: understandingFor(
        ['interactions'],
        [{ kind: 'function', name: expected.symbol }],
      ),
    });

    expect(anchorsOf(actions)).toEqual([`${expected.file}#${expected.symbol}`]);
  });

  it('narrows on a search hint, which is what a name with no declaration is for', async () => {
    const handler = must(manyAnchors.graph.nodesByKind('handler')[5], 'a handler to hint at');
    const expected = expectedHandlerAnchor(handler);
    const actions = await planFor({
      project: manyAnchors,
      understanding: understandingFor(['interactions'], [], [expected.symbol]),
    });

    expect(anchorsOf(actions)).toEqual([`${expected.file}#${expected.symbol}`]);
  });

  it('falls back to every anchor when the understanding resolves to nothing', async () => {
    const unnarrowed = await planFor({
      project: manyAnchors,
      understanding: understandingFor(['interactions', 'perf']),
    });
    const narrowed = await planFor({
      project: manyAnchors,
      understanding: understandingFor(
        ['interactions', 'perf'],
        [{ kind: 'component', name: 'NoSuchPaneExistsAnywhere' }],
        ['NoSuchPaneExistsAnywhere'],
      ),
    });

    // Junk evidence must not produce a junk plan: an entity nothing resolves to
    // leaves the proposal exactly where it would have been with no evidence at
    // all, rather than emptying it or inventing an anchor for the name.
    expect(narrowed.length).toBeGreaterThan(0);
    expect(withoutIds(narrowed)).toEqual(withoutIds(unnarrowed));
  });

  it('ignores a selector or a URL entity, which are locators and not declarations', async () => {
    const handler = must(manyAnchors.graph.nodesByKind('handler')[1], 'a handler to name');
    const expected = expectedHandlerAnchor(handler);
    const withLocators = await planFor({
      project: manyAnchors,
      understanding: understandingFor(
        ['interactions'],
        [
          { kind: 'selector', name: 'button.pane-action' },
          { kind: 'url', name: AGENT_DOCUMENT_URL },
          { kind: 'function', name: expected.symbol },
        ],
      ),
    });

    expect(anchorsOf(withLocators)).toEqual([`${expected.file}#${expected.symbol}`]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan — signal gating
 *
 * Driven by the closed `CaptureSignal` vocabulary and never by free text. The
 * interaction span is what a render, a state transition or a request is
 * attributed to, so every browser signal implies it; nothing in the dev-server
 * process does.
 * ---------------------------------------------------------------------------------------------- */

describe('createPlan signal gating', () => {
  it('leaves the performance signal out of a question that asked only about interactions', async () => {
    const actions = await planFor({
      project: fixture,
      understanding: interactionOnlyQuestion,
    });

    expect(actions.length).toBeGreaterThan(0);
    expect([...new Set(typesOf(actions))]).toEqual(['interaction-tracking']);
  });

  it('includes it for a performance or a page-error question', async () => {
    for (const understanding of [understandingFor(['perf']), errorOnlyQuestion]) {
      const actions = await planFor({ project: fixture, understanding });

      expect(typesOf(actions)).toContain('perf-tracking');

      // The prerequisite stated as intent: the interaction listener mints the
      // trace root, so a plan that armed the observers without it would collect
      // events that belong to no interaction.
      expect(typesOf(actions)).toContain('interaction-tracking');
    }
  });

  it('proposes the interaction listener for every browser signal', async () => {
    for (const signal of BROWSER_CAPTURE_SIGNALS) {
      const actions = await planFor({
        project: fixture,
        understanding: understandingFor([signal]),
      });

      expect(
        typesOf(actions),
        `the '${signal}' signal must bring the interaction listener with it`,
      ).toContain('interaction-tracking');
    }
  });

  it('proposes nothing for a question only the dev-server preload can answer', async () => {
    expect(await planFor({ project: fixture, understanding: serverOnlyQuestion })).toEqual([]);

    for (const signal of SERVER_CAPTURE_SIGNALS) {
      if ((BROWSER_CAPTURE_SIGNALS as readonly CaptureSignal[]).includes(signal)) {
        continue;
      }

      expect(
        await planFor({ project: fixture, understanding: understandingFor([signal]) }),
        `the '${signal}' signal belongs to another adapter`,
      ).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * createPlan — bounds, determinism and the empty answer
 * ---------------------------------------------------------------------------------------------- */

describe('createPlan bounds and determinism', () => {
  it('names at most as many anchors as its own exported bound allows', async () => {
    const limit = BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxTargets;
    const actions = await planFor({ project: manyAnchors });

    expect(manyAnchors.graph.nodesByKind('handler').length).toBeGreaterThan(limit);
    expect(ofType(actions, 'interaction-tracking').length).toBe(limit);
    expect(actions.length).toBe(limit + 1);
  });

  it('honours a caller’s tighter bound', async () => {
    const actions = await planFor({ project: manyAnchors, maxTargets: 2 });

    expect(ofType(actions, 'interaction-tracking').length).toBe(2);
    expect(ofType(actions, 'perf-tracking').length).toBe(1);
  });

  it('de-duplicates anchors that resolve to one declaration', async () => {
    const actions = await planFor({ project: manyAnchors });
    const anchors = anchorsOf(ofType(actions, 'interaction-tracking'));

    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('produces the same proposal twice, in the same order', async () => {
    for (const project of [fixture, manyAnchors, inlineHandler, componentsOnly]) {
      const first = await planFor({ project });
      const second = await planFor({ project });

      expect(withoutIds(second)).toEqual(withoutIds(first));
      expect(anchorsOf(second)).toEqual(anchorsOf(first));
      expect(typesOf(second)).toEqual(typesOf(first));

      // Ids are minted per action by contract, so they are the one field that
      // must differ between two proposals.
      expect(second.map((action) => action.id)).not.toEqual(first.map((action) => action.id));

      // Every proposal crosses a socket and a store as JSON.
      expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    }
  });

  it('returns an empty proposal rather than throwing when nothing anchors', async () => {
    await expect(planFor({ project: anchorless })).resolves.toEqual([]);
    await expect(
      planFor({ project: anchorless, understanding: interactionOnlyQuestion }),
    ).resolves.toEqual([]);
  });

  it('stops at a step boundary when the caller cancels', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(planFor({ project: manyAnchors, signal: controller.signal })).resolves.toEqual([]);
  });

  it('writes nothing, journals nothing and reads no environment while planning', async () => {
    const lines: LogLine[] = [];

    vi.stubEnv('DEBUGGEN_HOME', '/tmp/a-state-root-this-adapter-must-not-read');

    const actions = await createBrowserPerformanceAdapter().createPlan(
      contextFor({ project: fixture, logger: capturingLogger(lines) }),
      interactionAndPerfQuestion,
    );

    expect(actions.length).toBeGreaterThan(0);
    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);

    for (const line of lines) {
      expect(line.fields['adapter']).toBe(BROWSER_PERFORMANCE_ADAPTER_ID);
      expect(line.fields['sessionId']).toBe(SESSION_ID);
      expect(line.fields['planVersion']).toBe(PLAN_VERSION);
    }

    // A planning log line carries counts, not names: the rationales are where
    // a declaration is named, and they go to the developer rather than to a log
    // file (AAP §0.5.2).
    expectNoLeak(
      lines.flatMap((line) => [line.message, ...Object.values(line.fields).map(String)]),
      'a planning log line',
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * install
 *
 * Runtime mode: the page agent is armed by a configuration frame, so an install
 * here writes nothing and reports what was armed. A signal that cannot be
 * collected is **data on a successful result** rather than a rejection
 * (AAP §0.5.5), and the group below asserts both halves of that.
 * ---------------------------------------------------------------------------------------------- */

describe('install', () => {
  it('arms the hooks a plan asks for and writes nothing at all', async () => {
    const plan = await planFor({ project: fixture });
    const result = await installFor(fixture, 'present', plan);

    expect(result.adapterId).toBe(BROWSER_PERFORMANCE_ADAPTER_ID);

    // Nothing is written, so nothing is journaled and no modification record
    // exists to report (AAP §0.5.1).
    expect(result.applied).toEqual([]);
    expect(result.unavailable).toEqual([]);
    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);

    expect(result.runtimeHooks.length).toBeGreaterThan(0);
    expect(result.runtimeHooks).toEqual([...new Set(result.runtimeHooks)]);
    expect(result.runtimeHooks).toEqual([...result.runtimeHooks].sort());

    for (const hook of result.runtimeHooks) {
      expect(hook.trim()).toBe(hook);
      expect(hook.length).toBeGreaterThan(3);
    }

    // No `serverSignals`: none of this adapter's signals exists in the dev
    // server process. The key is absent rather than present and empty, which
    // under `exactOptionalPropertyTypes` are two different results.
    expect(Object.prototype.hasOwnProperty.call(result, 'serverSignals')).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('contributes only its own keys to the page agent’s configuration', async () => {
    const plan = await planFor({ project: fixture });
    const result = await installFor(fixture, 'present', plan);
    const contribution = result.agentHooks;

    expect(contribution).toBeDefined();

    for (const [key, value] of Object.entries(contribution ?? {})) {
      // Only keys that are actually on: a `false` would be indistinguishable
      // from "off" in a merge that spreads contributions, and this adapter has
      // no business turning another adapter's hook off.
      expect(value).toBe(true);
      expect(
        (BROWSER_PERFORMANCE_HOOK_KEYS as readonly string[]).includes(key),
        `"${key}" is not this adapter's hook to arm`,
      ).toBe(true);
    }

    // Validated through the real schema, merged over the dormant seven-flag
    // configuration — which is what catches a misspelled key that would
    // silently arm nothing.
    const merged = mergedHookConfig(contribution);

    expect(enabledHookKeys(merged)).toEqual([...BROWSER_PERFORMANCE_HOOK_KEYS]);
  });

  it('arms a narrower set for a narrower plan', async () => {
    const wide = await installFor(fixture, 'present', await planFor({ project: fixture }));
    const narrow = await installFor(
      fixture,
      'present',
      await planFor({ project: fixture, understanding: interactionOnlyQuestion }),
    );

    expect(enabledHookKeys(mergedHookConfig(narrow.agentHooks))).toEqual(['interactions']);
    expect(narrow.runtimeHooks.length).toBeGreaterThan(0);
    expect(narrow.runtimeHooks.length).toBeLessThan(wide.runtimeHooks.length);

    for (const hook of narrow.runtimeHooks) {
      expect(wide.runtimeHooks).toContain(hook);
    }
  });

  it('reports no contribution at all for an empty plan', async () => {
    const result = await installFor(fixture, 'present', []);

    expect(result.runtimeHooks).toEqual([]);
    expect(result.unavailable).toEqual([]);
    expect(result.applied).toEqual([]);

    // Absent rather than an empty object: "nothing was armed" is what
    // `../adapter.ts` defines the missing key as.
    expect(Object.prototype.hasOwnProperty.call(result, 'agentHooks')).toBe(false);
  });

  it('reports a missing page agent as one gap per signal and still resolves', async () => {
    const plan = await planFor({ project: fixture });

    for (const preset of AGENTLESS_PRESETS) {
      const result = await installFor(fixture, preset, plan);

      expect(result.runtimeHooks, `the '${preset}' state arms nothing`).toEqual([]);
      expect(Object.prototype.hasOwnProperty.call(result, 'agentHooks')).toBe(false);
      expect(result.unavailable.length).toBe(BROWSER_PERFORMANCE_HOOK_KEYS.length);

      for (const gap of result.unavailable) {
        expect(
          (CAPTURE_SIGNALS as readonly string[]).includes(gap.signal),
          `"${gap.signal}" must be a declared capture signal`,
        ).toBe(true);
        expect(BROWSER_PERFORMANCE_HOOK_KEYS as readonly string[]).toContain(gap.signal);

        // Rendered verbatim by both user interfaces (AAP §0.5.5), so a blank,
        // padded or one-word value is a defect rather than a style choice.
        for (const [field, value] of [
          ['reason', gap.reason],
          ['hint', gap.hint],
        ] as const) {
          expect(value.trim(), `the ${field} must not be padded`).toBe(value);
          expect(value.length, `the ${field} must say something`).toBeGreaterThan(20);
          expect(value).not.toMatch(/\n/u);
        }

        // The one action a developer can take: the agent is a dormant
        // `document_start` content script the service worker arms once a tab is
        // bound, so opening the application with the panel open is the fix.
        expect(gap.hint).toMatch(/open the application/iu);
        expect(gap.hint).toMatch(/devtools panel/iu);
      }

      expect(new Set(result.unavailable.map((gap) => gap.signal)).size).toBe(
        result.unavailable.length,
      );
      expect(journalEvents).toEqual([]);
    }
  });

  it('reports one gap per signal the plan actually asked for', async () => {
    const result = await installFor(
      fixture,
      'absent',
      await planFor({ project: fixture, understanding: interactionOnlyQuestion }),
    );

    expect(result.unavailable.map((gap) => gap.signal)).toEqual(['interactions']);
  });

  it('still arms everything when the agent’s report has merely aged', async () => {
    const plan = await planFor({ project: fixture });
    const stale = await installFor(fixture, 'stale', plan);
    const fresh = await installFor(fixture, 'present', plan);

    // Staleness is a readiness nuance, not an install failure: the hooks can
    // still be armed, and `readiness` is where the product says plainly that
    // the observation may predate the page in front of the developer.
    expect(stale).toEqual(fresh);
  });

  it('does not gate on the fiber hook’s ordering, and never asks for a reload', async () => {
    const plan = await planFor({ project: fixture });
    const healthy = await installFor(fixture, 'present', plan);
    const withoutReact = await installFor(fixture, 'presentWithoutReact', plan);

    // The regression guard against copy-paste from the React adapter.
    // `installedBeforeReact` gates React commit observation, because a fiber
    // hook has to exist before React loads; a capture-phase DOM listener, a
    // `PerformanceObserver` and a `window` error handler work on a page with no
    // React on it at all.
    expect(withoutReact).toEqual(healthy);
    expect(withoutReact.unavailable).toEqual([]);
    expect(enabledHookKeys(mergedHookConfig(withoutReact.agentHooks))).toEqual([
      ...BROWSER_PERFORMANCE_HOOK_KEYS,
    ]);

    // Asserted in the negative, explicitly: a hint telling a developer to
    // reload for a signal a reload cannot affect is the exact mistake this
    // adapter must not inherit from its sibling.
    for (const value of installStrings(withoutReact)) {
      expect(value).not.toMatch(/reload/iu);
      expect(value).not.toMatch(/\breact\b/iu);
    }
  });

  it('ignores actions of another adapter and of a type it does not claim', async () => {
    const plan = await planFor({ project: fixture });
    const mixed = [
      foreignAction({ adapter: 'react', type: 'react-render-tracking' }),
      ...plan,
      // This adapter's own id with a type it does not claim: the filter has to
      // check both, or an action another adapter owns would arm a hook here.
      foreignAction({ adapter: BROWSER_PERFORMANCE_ADAPTER_ID, type: 'fetch-tracking' }),
      foreignAction({ adapter: 'nextjs', type: 'server-span' }),
    ];

    const filtered = await installFor(fixture, 'present', plan);
    const withForeign = await installFor(fixture, 'present', mixed);

    expect(withForeign).toEqual(filtered);
    expect(journalEvents).toEqual([]);
  });

  it('reports nothing about actions that are all foreign', async () => {
    const result = await installFor(fixture, 'absent', [
      foreignAction({ adapter: 'react', type: 'react-render-tracking' }),
    ]);

    expect(result.runtimeHooks).toEqual([]);
    expect(result.unavailable).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(result, 'agentHooks')).toBe(false);
  });

  it('names no part of the application in a hook, a gap or a log field', async () => {
    const lines: LogLine[] = [];
    const plan = await planFor({ project: fixture });

    for (const preset of [...COLLECTABLE_PRESETS, ...AGENTLESS_PRESETS]) {
      const result = await installFor(fixture, preset, plan, capturingLogger(lines));

      expectNoLeak(installStrings(result), `a '${preset}' install result`);
    }

    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);
    expectNoLeak(
      lines.flatMap((line) => [line.message, ...Object.values(line.fields).map(String)]),
      'an install log line',
    );

    // The document URL the page agent reported carries a parameter *value*, and
    // AAP §0.5.2 keeps those out of everything downstream.
    for (const value of lines
      .flatMap((line) => Object.values(line.fields).map(String))
      .concat(installStrings(await installFor(fixture, 'present', plan)))) {
      expect(value).not.toContain(AGENT_DOCUMENT_URL);
      expect(value).not.toContain('zephyr');
    }
  });

  it('installs the same way twice', async () => {
    const plan = await planFor({ project: fixture });

    for (const preset of [...COLLECTABLE_PRESETS, ...AGENTLESS_PRESETS]) {
      const first = await installFor(fixture, preset, plan);
      const second = await installFor(fixture, preset, plan);

      expect(second).toEqual(first);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * readiness
 *
 * A pure function of the relayed `agent.ready` fact on the context and the
 * clock the session runs on. No port is probed, no process is spawned, no
 * environment is read — an adapter that decided readiness from its own probe
 * could contradict the frame the service actually received.
 * ---------------------------------------------------------------------------------------------- */

describe('readiness', () => {
  it('produces a valid report for every page-agent state', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const report = await createBrowserPerformanceAdapter().readiness(
        contextFor({ project: fixture, readiness }),
      );

      // Parsed through the real schema: a report this package would reject at
      // the boundary it crossed is not a report.
      expect(readinessSchema.parse(report), `the '${name}' report must validate`).toEqual(report);
      expect(report.adapter).toBe(BROWSER_PERFORMANCE_ADAPTER_ID);
      expect(report.checkedAt).toBe(NOW);
      expect(report.signals.map((signal) => signal.signal)).toEqual([
        ...BROWSER_PERFORMANCE_HOOK_KEYS,
      ]);

      for (const signal of report.signals) {
        expect(
          (READINESS_STATUSES as readonly string[]).includes(signal.status),
          `"${signal.status}" must be a declared readiness status`,
        ).toBe(true);

        if (signal.status === 'available') {
          // Absent rather than empty: an available row has nothing to explain,
          // and the report is transported and persisted as JSON.
          expect(signal.reason).toBeUndefined();
          expect(signal.hint).toBeUndefined();

          continue;
        }

        const reason = must(signal.reason, `a reason for the ${signal.signal} row`);
        const hint = must(signal.hint, `a hint for the ${signal.signal} row`);

        expect(reason.trim()).toBe(reason);
        expect(hint.trim()).toBe(hint);
        expect(reason.length).toBeGreaterThan(20);
        expect(hint.length).toBeGreaterThan(20);
      }

      // `ready` is derived in one place — no row `'unavailable'` — and carried
      // on the report rather than recomputed by every reader.
      expect(report.ready).toBe(report.signals.every((signal) => signal.status !== 'unavailable'));
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    }
  });

  it('reports every signal unavailable when no page agent has reported', async () => {
    for (const preset of AGENTLESS_PRESETS) {
      const report = await readinessFor(fixture, preset);

      expect(report.ready, `the '${preset}' state cannot be ready`).toBe(false);
      expect(report.signals.map((signal) => signal.status)).toEqual(
        BROWSER_PERFORMANCE_HOOK_KEYS.map(() => 'unavailable'),
      );

      for (const signal of report.signals) {
        expect(must(signal.hint, 'a hint')).toMatch(/open the application/iu);
      }
    }
  });

  it('reports every signal available once a page agent has reported', async () => {
    for (const preset of ['present', 'presentWithoutReact'] as const) {
      const report = await readinessFor(fixture, preset);

      expect(report.ready, `the '${preset}' state must be ready`).toBe(true);
      expect(report.signals.map((signal) => signal.status)).toEqual(
        BROWSER_PERFORMANCE_HOOK_KEYS.map(() => 'available'),
      );
      expect(readinessStrings(report)).toEqual([...BROWSER_PERFORMANCE_HOOK_KEYS]);
    }

    // The two are the *same* report: this adapter reads neither
    // `installedBeforeReact` nor `reactDetected`, so a document with no React
    // on it is exactly as ready as one with React.
    expect(await readinessFor(fixture, 'presentWithoutReact')).toEqual(
      await readinessFor(fixture, 'present'),
    );

    for (const value of readinessStrings(await readinessFor(fixture, 'presentWithoutReact'))) {
      expect(value).not.toMatch(/reload/iu);
    }
  });

  it('degrades rather than fails when the report has aged past its own bound', async () => {
    const report = await readinessFor(fixture, 'stale');

    // A `'degraded'` row does not hold a capture back: the hooks can still be
    // armed, and the product says plainly that the observation it relies on may
    // predate the page in front of the developer.
    expect(report.ready).toBe(true);
    expect(report.signals.map((signal) => signal.status)).toEqual(
      BROWSER_PERFORMANCE_HOOK_KEYS.map(() => 'degraded'),
    );

    const ageSeconds = Math.floor(
      (BROWSER_PERFORMANCE_ADAPTER_LIMITS.staleReportAfterMs + STALE_OVERSHOOT_MS) / 1_000,
    );

    for (const signal of report.signals) {
      expect(must(signal.reason, 'a reason')).toContain(`${String(ageSeconds)}s ago`);
      expect(must(signal.hint, 'a hint')).toMatch(/reload the application tab/iu);
    }
  });

  it('treats a report exactly at the bound as current, and one past it as stale', async () => {
    const bound = BROWSER_PERFORMANCE_ADAPTER_LIMITS.staleReportAfterMs;
    const reportAt = async (ageMs: number): Promise<Readiness> =>
      createBrowserPerformanceAdapter().readiness(
        contextFor({
          project: fixture,
          readiness: {
            browserAgent: {
              installedBeforeReact: true,
              reactDetected: true,
              observedAt: NOW - ageMs,
            },
          },
        }),
      );

    expect((await reportAt(bound)).signals.map((signal) => signal.status)).toEqual(
      BROWSER_PERFORMANCE_HOOK_KEYS.map(() => 'available'),
    );
    expect((await reportAt(bound + 1)).signals.map((signal) => signal.status)).toEqual(
      BROWSER_PERFORMANCE_HOOK_KEYS.map(() => 'degraded'),
    );

    // Clock skew between the moment a frame was stamped and the clock this call
    // was given is not a stale report: a report from the future is current.
    expect((await reportAt(-5_000)).signals.map((signal) => signal.status)).toEqual(
      BROWSER_PERFORMANCE_HOOK_KEYS.map(() => 'available'),
    );
  });

  it('prefers the session’s clock, then its own, then the real one', async () => {
    const optionMoment = NOW - 60_000;
    const withBothClocks = await createBrowserPerformanceAdapter({
      now: () => optionMoment,
    }).readiness(contextFor({ project: fixture, readiness: agentPresets(fixture).present }));

    expect(withBothClocks.checkedAt).toBe(NOW);

    const withOptionClock = await createBrowserPerformanceAdapter({
      now: () => optionMoment,
    }).readiness(
      contextFor({
        project: fixture,
        readiness: agentPresets(fixture).present,
        withoutSessionClock: true,
      }),
    );

    expect(withOptionClock.checkedAt).toBe(optionMoment);

    // A clock that throws, or answers with something `readinessSchema` would
    // reject, is skipped rather than allowed to turn a truthful report into a
    // rejected one.
    const before = Date.now();
    const withBrokenClock = await createBrowserPerformanceAdapter({
      now: () => {
        throw new Error('this clock is broken');
      },
    }).readiness(
      contextFor({
        project: fixture,
        readiness: agentPresets(fixture).present,
        withoutSessionClock: true,
      }),
    );

    expect(withBrokenClock.checkedAt).toBeGreaterThanOrEqual(before);
    expect(readinessSchema.parse(withBrokenClock)).toEqual(withBrokenClock);
  });

  it('probes nothing: the same inputs give the same report', async () => {
    const lines: LogLine[] = [];

    vi.stubEnv('DEBUGGEN_HOME', '/tmp/a-state-root-this-adapter-must-not-read');
    vi.stubEnv('DEBUGGEN_INGEST_URL', 'http://127.0.0.1:1/never-called');

    const adapter = createBrowserPerformanceAdapter();
    const context = contextFor({
      project: fixture,
      readiness: agentPresets(fixture).present,
      logger: capturingLogger(lines),
    });

    const first = await adapter.readiness(context);
    const second = await adapter.readiness(context);

    expect(second).toEqual(first);

    // The backup store throws on contact and the journal records every call, so
    // "no collaborator but the injected inputs was touched" is asserted rather
    // than assumed — and `readiness` is quiet, because a report is its answer.
    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('answers the same way whatever the project looks like', async () => {
    // Readiness is about the page agent, not about the code: a project with no
    // anchor at all still reports the same three rows, because the question
    // "can this signal be collected here?" has nothing to do with the graph.
    for (const project of [fixture, anchorless, componentsOnly]) {
      expect(await readinessFor(project, 'present')).toEqual(
        await readinessFor(fixture, 'present'),
      );
      expect(await readinessFor(project, 'absent')).toEqual(await readinessFor(fixture, 'absent'));
    }
  });

  it('names no part of the application in a row', async () => {
    for (const [name, readiness] of presetEntries(fixture)) {
      const report = await createBrowserPerformanceAdapter().readiness(
        contextFor({ project: fixture, readiness }),
      );

      expectNoLeak(readinessStrings(report), `a '${name}' readiness report`);

      for (const value of readinessStrings(report)) {
        expect(value).not.toContain(AGENT_DOCUMENT_URL);
        expect(value).not.toContain('zephyr');
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * remove
 *
 * There is nothing on disk to undo. What a removal reports is which hooks are
 * no longer observing the application — and nothing else, because a runtime
 * adapter journals no record and has no restoration to claim.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A modification record belonging to some other adapter.
 *
 * This adapter never produces one, but `../cleanup.ts` hands a removal the
 * records a session holds — so a case can prove it claims no restoration it did
 * not perform.
 *
 * @returns The record.
 */
function foreignRecord(): ModificationRecord {
  const originalHash = sha256Hex('the bytes another adapter found');
  const created = createModificationRecord(
    {
      sessionId: SESSION_ID,
      planVersion: PLAN_VERSION,
      file: 'src/panes/patched-by-another-adapter.ts',
      originalHash,
      instrumentedHash: sha256Hex('the bytes another adapter wrote'),
      backupPath: `${STATE_ROOT}/backups/${SESSION_ID}/${originalHash}`,
      diff: '--- a/src/panes/patched-by-another-adapter.ts\n+++ b/src/panes/patched-by-another-adapter.ts\n',
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

      expect(result.adapterId).toBe(BROWSER_PERFORMANCE_ADAPTER_ID);
      expect(result.restored, `a '${reason}' removal must restore nothing`).toEqual([]);
      expect(result.conflicts).toEqual([]);
    }

    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
  });

  it('names the hooks it relinquished, except on a reconcile', async () => {
    const armed = await installFor(fixture, 'present', await planFor({ project: fixture }));

    for (const reason of ['session-end', 'rollback'] as const) {
      // Disabled rather than idled (AAP §0.5.1): the service returns the page
      // agent to dormant with an all-false `agent.config`, which detaches the
      // listener, the observers and the error handlers.
      expect((await removeFor(fixture, reason)).runtimeHooksDisabled).toEqual(armed.runtimeHooks);
    }

    // A reconciled session belongs to a process that is gone, so its page hooks
    // went with it and there is nothing left to detach.
    expect((await removeFor(fixture, 'reconcile')).runtimeHooksDisabled).toEqual([]);
  });

  it('answers the same way with installed actions and with none', async () => {
    const plan = await planFor({ project: fixture });
    const adapter = createBrowserPerformanceAdapter();
    const context = contextFor({ project: fixture, readiness: agentPresets(fixture).present });

    await adapter.install(plan, context);

    const afterInstall = await adapter.remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, reason: 'session-end' },
      context,
    );
    const withoutInstall = await createBrowserPerformanceAdapter().remove(
      { sessionId: SESSION_ID, planVersion: PLAN_VERSION, reason: 'session-end' },
      context,
    );

    expect(afterInstall).toEqual(withoutInstall);
  });

  it('claims no restoration for a record another adapter produced', async () => {
    const result = await removeFor(fixture, 'session-end', [foreignRecord()]);

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

  it('writes nothing, journals nothing and reads no environment', async () => {
    const lines: LogLine[] = [];

    vi.stubEnv('DEBUGGEN_HOME', '/tmp/a-state-root-this-adapter-must-not-read');

    await createBrowserPerformanceAdapter().remove(
      { sessionId: SESSION_ID, reason: 'session-end' },
      contextFor({ project: fixture, logger: capturingLogger(lines) }),
    );

    expect(journalEvents).toEqual([]);
    expect(existsSync(STATE_ROOT)).toBe(false);
    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.map((line) => line.level))]).toEqual(['debug']);

    for (const line of lines) {
      expect(line.fields['adapter']).toBe(BROWSER_PERFORMANCE_ADAPTER_ID);
    }
  });

  it('names no part of the application in what it reports', async () => {
    for (const reason of ['session-end', 'rollback', 'reconcile'] as const) {
      const result = await removeFor(fixture, reason, [foreignRecord()]);

      expectNoLeak(result.runtimeHooksDisabled, `a '${reason}' removal report`);
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

/** The only module specifiers `./browser-performance.ts` may import. */
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
  // adapter arms runtime hooks inside the page: it has nothing to write and
  // nothing to restore, so a reference to that layer would be a second writer.
  { label: 'the patch layer', pattern: /\.\.\/patch\//u },
  { label: 'the environment', pattern: /\bprocess\s*\.\s*env\b/u },
  { label: 'the console', pattern: /\bconsole\s*\./u },
  { label: 'a Node builtin', pattern: /(['"])node:[^'"]*\1|\bnode:[a-z]/u },
];

/**
 * The adapter's source with its comments removed.
 *
 * Comments have to go before anything is matched: this module's prose
 * *discusses* the registry, the patch layer, the cleanup module and the page
 * agent by name — which is exactly why it must not import them — and a guard
 * that scanned the prose would report the explanation as the violation.
 *
 * @returns The comment-free source.
 */
function adapterSourceWithoutComments(): string {
  return readFileSync(ADAPTER_SOURCE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

describe('the import boundary', () => {
  it('leaves code behind after the comments are stripped', () => {
    const stripped = adapterSourceWithoutComments();

    // Without this, a stripping accident would make every assertion below pass
    // against an empty string.
    expect(stripped).toContain('export function createBrowserPerformanceAdapter');
    expect(stripped).toContain(
      `export const BROWSER_PERFORMANCE_ADAPTER_ID = '${BROWSER_PERFORMANCE_ADAPTER_ID}'`,
    );
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
        `./browser-performance.ts must not reach for ${label}`,
      ).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * No application vocabulary of its own (AAP §0.5.4)
 *
 * The assertion this file owes the repository. `scripts/check-no-hardcoding.mjs`
 * is the AST-aware, policy-driven, repository-wide half; this is the same rule
 * asserted where the adapter lives, in both halves — the names it emits are the
 * ones the graph it was handed holds, and its own source carries none of them.
 * ---------------------------------------------------------------------------------------------- */

describe('names nothing of its own', () => {
  it('carries no corpus identifier in its source', () => {
    const stripped = adapterSourceWithoutComments();

    for (const project of [fixture, inlineHandler, manyAnchors, multiAnchor]) {
      for (const name of distinctiveNames(project)) {
        expect(
          stripped.includes(name),
          `./browser-performance.ts must not carry "${name}" as a literal`,
        ).toBe(false);
      }
    }
  });

  it('reads the names it states out of the graph it was handed', async () => {
    const handlers = manyAnchors.graph.nodesByKind('handler');
    const expected = handlers.map((handler) => expectedHandlerAnchor(handler));
    const rationales = (await planFor({ project: manyAnchors })).map((action) => action.rationale);
    const joined = rationales.join('\n');

    expect(rationales.length).toBeGreaterThan(1);

    // Every anchor this plan named appears in the prose the developer reads,
    // and it got there by interpolation from the graph.
    for (const action of await planFor({ project: manyAnchors })) {
      expect(joined).toContain(action.symbol);
      expect(joined).toContain(action.file);
      expect(
        expected.some((anchor) => anchor.symbol === action.symbol),
        `"${action.symbol}" must be a symbol the graph recorded`,
      ).toBe(true);
    }

    // And nothing from any other corpus reaches this one's prose: an adapter
    // that recognised names rather than reading the graph would show it here.
    expectNoLeak(rationales, 'a rationale for the many-anchor corpus', fixture);
    expectNoLeak(rationales, 'a rationale for the many-anchor corpus', inlineHandler);
  });

  it('states the committed corpus’s own names when planning against it', async () => {
    const handlers = fixtureHandlers();
    const actions = await planFor({ project: fixture });
    const rationales = actions.map((action) => action.rationale);

    // Every rationale names the handler it was anchored on — name and file of
    // the same graph node — and every handler is named by at least one.
    for (const rationale of rationales) {
      expect(
        handlers.some(
          (handler) => rationale.includes(handler.name) && rationale.includes(handler.file),
        ),
        `"${rationale}" must name a handler the graph recorded`,
      ).toBe(true);
    }

    for (const handler of handlers) {
      expect(
        rationales.some(
          (rationale) => rationale.includes(handler.name) && rationale.includes(handler.file),
        ),
        `some rationale must name ${handler.name}`,
      ).toBe(true);
    }

    // The single performance action's provenance is the best-ranked anchor.
    const best = fixtureHandler();
    const performance = must(ofType(actions, 'perf-tracking')[0], 'the performance action');

    expect(performance.file).toBe(best.file);
    expect(performance.rationale).toContain(best.name);

    expectNoLeak(rationales, 'a rationale for the committed corpus', manyAnchors);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The committed corpus
 *
 * The last group, deliberately: it asserts that everything above read the
 * fixture and wrote nothing to it.
 * ---------------------------------------------------------------------------------------------- */

describe('the committed corpus', () => {
  it('is byte-identical to what it was before the suite ran', () => {
    expect(fixtureSnapshotBefore.length).toBeGreaterThan(0);
    expect(treeSnapshot(FIXTURE_ROOT)).toEqual([...fixtureSnapshotBefore]);
  });

  it('left no state directory behind', () => {
    expect(existsSync(STATE_ROOT)).toBe(false);
  });
});
