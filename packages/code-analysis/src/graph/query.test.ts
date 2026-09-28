/**
 * Unit suite for `./query.ts` — the read-only query surface Stage 2 puts in
 * front of a model — asserted against the committed indexing corpus
 * `test/fixtures/sample-next-app`.
 *
 * ## What this suite is for
 *
 * The sibling suite `./query-symbols.test.ts` asserts the `findSymbol` /
 * `hasSymbol` equivalence over hand-authored indexes, where a case can state
 * exactly one node and vary exactly one field. This suite asks the other
 * question: **do these queries answer real questions about a real Next.js
 * project?** A hand-built index proves the lookup logic; it cannot prove that
 * the graph an actual ts-morph run produces contains the nodes and edges the
 * queries walk, nor that a click in a client component resolves to the SQL
 * statement behind it. So every case below runs against the corpus, indexed
 * through the real `../project.ts` and `../indexer.ts`, and the expectations
 * are the corpus' own line numbers and names.
 *
 * Three properties of AAP 0.4.2 — *"the model proposes queries, deterministic
 * code executes them, no repository dump"* — are what the groups are organised
 * around:
 *
 * - **Answers.** `findByName`, `findSymbol`, `whoCalls`, `routeForUrl`,
 *   `handlersFor`, `componentsRendering` and `pathBetween` each resolve the
 *   corpus fact they claim to, including the cross-tier flow AAP 0.8.3 names:
 *   *"components, handlers, routes, db calls, `pathBetween`"*.
 * - **Bounds.** Every list is capped, every excerpt window is clamped, and no
 *   query can be talked into returning a whole file. A result here is prompt
 *   material, so an unbounded answer is an unbounded prompt.
 * - **Read-only.** Nothing this module does writes, and the suite proves it by
 *   snapshotting the corpus' file list with each file's size and modification
 *   time before any query runs and re-asserting it at the end. The build path
 *   used here is the cache-free one (`openProject` + `buildIndex`), so nothing
 *   is written to `$DEBUGGEN_HOME` either — `../indexer.ts`'s `indexProject`,
 *   which does consult and populate a cache, is deliberately not used.
 *
 * ## Provenance is asserted, not assumed
 *
 * `SourceLocation.resolvedBy` records *how* a position was found, and this
 * module produces two of the five routes (AAP 0.2.3): `'code-graph'` for
 * anything minted from a node or an edge site, `'route-map'` for anything
 * `../route-map.ts` produced and this module forwards. Flattening the two would
 * erase the distinction the schema exists to record, so the route group asserts
 * that a route result keeps `'route-map'` while the graph's own node for the
 * same module keeps `'code-graph'`, and `handlersFor` is asserted in both
 * shapes: a declared App Router handler answers from the graph, and a page
 * module whose graph holds no handler declaration answers from the route map.
 * Confidence values are read from `DEFAULT_RESOLUTION_CONFIDENCE` and never
 * transcribed as numbers — four resolvers in three packages agree only because
 * they all read that one table.
 *
 * ## The corpus is read-only, and independent
 *
 * `test/fixtures/sample-next-app` is *input*, not source: it is outside this
 * package's TypeScript program (`tsconfig.json` excludes `test/fixtures/**`),
 * it carries its own `tsconfig.json` that ts-morph loads at runtime — including
 * the `@/*` alias the corpus imports through — and two of its module
 * specifiers (`react`, `next/server`) deliberately resolve to nothing, which is
 * what proves the extractors read it syntax-tree-first. Nothing here writes to
 * it, formats it or works around those unresolved specifiers. A case needing a
 * mutated corpus would copy it to a temporary directory; none does.
 *
 * It is also an *independent* corpus: this is a test file, excluded from
 * `scripts/check-no-hardcoding.mjs`, and the names below (`GaugeReadout`,
 * `summarizeBasin`, `/api/gauges`) are the fixture's own invented vocabulary,
 * sharing nothing with `apps/demo-app`. The product never sees either.
 *
 * ## Cost
 *
 * The corpus is indexed once in `beforeAll` and the graph and query instance
 * are shared, because building a ts-morph program is what indexing costs. One
 * group — the determinism case of `pathBetween` — builds a second, independent
 * index on purpose: "the same answer in a second process" is the claim
 * `./query.ts` makes about its ordering, and one index cannot test it.
 */

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  createConsoleLogger,
  formatSourceLocation,
  isErr,
  isOk,
  parseSourceLocation,
} from '@debuggen/shared';
import type { LogLevelSetting, LogRecord, Logger, SourceLocation } from '@debuggen/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { INDEXER_VERSION, buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import { matchRoute, routeMapFromIndex } from '../route-map.js';
import type { LoadedProject } from '../project.js';

import { CodeGraph, makeEdgeId, makeNodeId } from './graph.js';
import { CODE_QUERY_LIMITS, createCodeQueries } from './query.js';
import type { CodeMatch, CodePath, CodeQueries } from './query.js';
import { CODE_INDEX_SCHEMA_VERSION } from './types.js';
import type {
  CodeEdge,
  CodeEdgeKind,
  CodeIndex,
  CodeNode,
  CodeNodeKind,
  CodeNodeOf,
  ReferenceResolver,
} from './types.js';

/* -------------------------------------------------------------------------------------------------
 * The corpus, and the handles a case needs on it
 * ---------------------------------------------------------------------------------------------- */

/**
 * The read-only indexing corpus, resolved from this module's own URL.
 *
 * Not from `process.cwd()` and not as a literal: the `code-analysis` Vitest
 * project is run both from the repository root (`pnpm test`) and filtered to one
 * file, and a path derived from the working directory answers differently in
 * the two.
 */
const FIXTURE_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/** Every line terminator the compiler counts as one, so line numbers agree. */
const LINE_BREAK = /\r\n|\n|\r/;

/** One indexing of the corpus: the project handle, the envelope and the graph. */
interface IndexedCorpus {
  /** The opened ts-morph project, which `excerpt` reads text through. */
  readonly loaded: LoadedProject;

  /** The envelope the build produced, for the route-map delegation check. */
  readonly index: CodeIndex;

  /** The graph every query answers from. */
  readonly graph: CodeGraph;
}

/**
 * Opens and indexes the corpus through the **cache-free** path.
 *
 * `openProject` + `buildIndex` is what a consumer holding its own project
 * handle runs, and it is the only build path that touches no cache directory:
 * `indexProject` would consult and populate `$DEBUGGEN_HOME/index`, which a
 * unit suite must not do.
 *
 * @returns The project handle, the index envelope and the graph.
 */
async function indexCorpus(): Promise<IndexedCorpus> {
  const opened = openProject({ projectRoot: FIXTURE_ROOT });
  if (isErr(opened)) {
    throw new Error(`the corpus did not open: ${opened.error.message}`);
  }

  const built = await buildIndex(opened.value);
  if (isErr(built)) {
    throw new Error(`the corpus did not index: ${built.error.message}`);
  }

  return {
    loaded: opened.value,
    index: built.value,
    graph: CodeGraph.fromIndex(built.value),
  };
}

/** The corpus as this suite's files, sizes and modification times stood before any query ran. */
let corpusBefore: readonly string[];

/** The one indexing every group but the determinism case shares. */
let corpus: IndexedCorpus;

/** The queries under test, over {@link corpus} and with its project handle. */
let queries: CodeQueries;

beforeAll(async () => {
  // Snapshotted before the index is built, so the assertion at the end of the
  // suite covers the build as well as the queries.
  corpusBefore = corpusFootprint();
  corpus = await indexCorpus();
  queries = createCodeQueries(corpus.graph, { loaded: corpus.loaded });
}, 120_000);

/**
 * The corpus' files with each file's size and modification time, sorted.
 *
 * The read-only evidence of the final group: metadata only, never contents, and
 * `node:fs` is used here and nowhere else in this file. A write anywhere under
 * the corpus changes a size, a modification time or the file list itself, and
 * comparing two of these catches it without shelling out to git.
 *
 * @returns One `path|size|mtime` line per file, in path order.
 */
function corpusFootprint(): readonly string[] {
  return readdirSync(FIXTURE_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = `${entry.parentPath}/${entry.name}`;
      const stats = statSync(path);

      return `${path}|${stats.size}|${stats.mtimeMs}`;
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Narrows a value the corpus is expected to provide, failing loudly when it does
 * not.
 *
 * `noUncheckedIndexedAccess` makes every `result[0]` optional, and an assertion
 * chain that quietly reads `undefined?.kind` passes for the wrong reason. The
 * message names the remedy the suite's contract states: when the corpus no
 * longer supports an expectation, the query or the extractor is what changes.
 *
 * @typeParam T The value's type.
 * @param value The possibly absent value.
 * @param what What was expected, for the failure message.
 * @returns The value.
 */
function assertDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the corpus no longer provides ${what}: fix the query or the extractor`);
  }

  return value;
}

/**
 * The corpus' node of one kind bearing one source-spelled name, typed by that
 * kind.
 *
 * Used to obtain the `nodeId` endpoints of a `pathBetween` case the way a stage
 * does — from an earlier result — and to read a node's `data`, which a
 * {@link CodeMatch} deliberately does not carry. Generic in the kind, so
 * `corpusNode('db-call', …).data.driver` needs no cast: `./graph.ts`'s
 * `nodesByKind` is typed per kind for exactly this reason.
 *
 * Insisting on **one** match is part of the assertion: a second node of the same
 * kind and name would make a case that picked the first pass for the wrong
 * reason.
 *
 * @typeParam K The node kind.
 * @param kind The node kind.
 * @param name The node's name as written in the source.
 * @returns The node.
 */
function corpusNode<K extends CodeNodeKind>(kind: K, name: string): CodeNodeOf<K> {
  const matched = corpus.graph.nodesByKind(kind).filter((node) => node.name === name);
  if (matched.length !== 1) {
    throw new Error(`expected exactly one ${kind} named ${name}, found ${matched.length}`);
  }

  return assertDefined(matched[0], `a ${kind} named ${name}`);
}

/**
 * The corpus' node of one kind that a path passed through, typed by that kind.
 *
 * A {@link CodeMatch} carries a node's identity, kind, name and location and
 * deliberately not its `data`, so a case asserting on a payload — the literal
 * URL of a request hop, the driver of a database hop — reads the node back out
 * of the graph by the id the path reported.
 *
 * @typeParam K The node kind.
 * @param kind The node kind.
 * @param nodes The path's nodes.
 * @returns The first node of that kind on the path.
 */
function nodeOnPath<K extends CodeNodeKind>(kind: K, nodes: readonly CodeMatch[]): CodeNodeOf<K> {
  const ids = new Set(nodes.map((node) => node.nodeId));

  return assertDefined(
    corpus.graph.nodesByKind(kind).find((node) => ids.has(node.id)),
    `a ${kind} node on the path`,
  );
}

/**
 * The corpus' `api-route` node for one route module.
 *
 * Looked up by file rather than by name, because an `api-route` node's name is
 * its route path — which is the answer a route query gives and therefore not
 * what a case asserting on route queries should assume.
 *
 * @param file The route module, project-relative POSIX.
 * @returns The node.
 */
function routeNodeFor(file: string): CodeNodeOf<'api-route'> {
  return assertDefined(
    corpus.graph.nodesByKind('api-route').find((node) => node.file === file),
    `an api-route node for ${file}`,
  );
}

/**
 * The lines of a corpus file, read through the **loaded project** rather than
 * the filesystem.
 *
 * The same handle `./query.ts`'s `excerpt` reads through, split the same way, so
 * an expectation built here and an excerpt produced there agree on what line
 * three is. It also keeps `node:fs` out of the content path entirely.
 *
 * @param file The file, project-relative POSIX.
 * @returns Its lines, in order.
 */
function corpusLines(file: string): readonly string[] {
  const sourceFile = assertDefined(
    corpus.loaded
      .sourceFiles()
      .find((candidate) => corpus.loaded.projectRelative(candidate.getFilePath()) === file),
    `the file ${file}`,
  );

  return sourceFile.getFullText().split(LINE_BREAK);
}

/**
 * Every {@link SourceLocation} nested anywhere in a query result.
 *
 * A location reaches a prompt or a panel inside whichever result carried it —
 * a match, a caller, a route, a path node, an edge site — so the cross-cutting
 * group validates them by walking the result rather than by naming the fields
 * it happens to remember.
 *
 * @param value Any query result.
 * @param into The accumulator, for the recursive calls.
 * @returns The locations found, in walk order.
 */
function locationsIn(value: unknown, into: SourceLocation[] = []): SourceLocation[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      locationsIn(item, into);
    }

    return into;
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.resolvedBy === 'string' && typeof record.line === 'number') {
      into.push(record as unknown as SourceLocation);
    }

    for (const inner of Object.values(record)) {
      locationsIn(inner, into);
    }
  }

  return into;
}

/**
 * Whether `expected` appears in `actual` in order, with anything in between.
 *
 * A path's waypoints are asserted as a subsequence on purpose: the route-to-
 * service hop may be a direct `calls` edge or a `declares` hop to the exported
 * method symbol that calls it, and both are valid graph shapes for the flow the
 * case is about. Pinning the exact node list would fail on a legitimate change
 * in an extractor while proving nothing more about the flow.
 *
 * @param actual The full sequence.
 * @param expected The waypoints, in the order they must appear.
 * @returns Whether every waypoint was found in order.
 */
function containsSubsequence(actual: readonly string[], expected: readonly string[]): boolean {
  let position = 0;

  for (const step of actual) {
    if (step === expected[position]) {
      position += 1;
    }
    if (position === expected.length) {
      return true;
    }
  }

  return expected.length === 0;
}

/** One path node as `kind:name`, the form the waypoint assertions compare. */
function stepsOf(nodes: readonly CodeMatch[]): readonly string[] {
  return nodes.map((node) => `${node.kind}:${node.name}`);
}

/* -------------------------------------------------------------------------------------------------
 * The corpus contract the rest of the suite rests on
 * ---------------------------------------------------------------------------------------------- */

describe('the indexed corpus', () => {
  it('indexes cleanly, with the node kinds the queries walk', () => {
    expect(corpus.graph.diagnostics).toStrictEqual([]);
    expect(corpus.index.projectRoot).toBe(corpus.loaded.projectRoot);

    const populated = new Set(corpus.graph.nodes().map((node) => node.kind));

    // Every kind a query below resolves. A missing kind here means an extractor
    // stopped contributing, which would make several groups vacuous rather than
    // failing.
    expect([...populated].sort()).toStrictEqual([
      'api-call',
      'api-route',
      'component',
      'db-call',
      'file',
      'handler',
      'server-function',
      'symbol',
    ]);
  });

  it('keeps the two call sites of one literal URL distinct', () => {
    const calls = corpus.graph
      .nodesByKind('api-call')
      .map((node) => `${node.file}:${node.line}|${node.data.url ?? '(dynamic)'}`);

    // Three call sites, and the literal `/api/gauges` appears at two of them —
    // one in the client component, one in the shared helper. A result that
    // collapsed them would be a de-duplication bug in whichever query returned
    // it, so the corpus' own shape is asserted before any query is asked.
    expect(calls).toStrictEqual([
      'src/lib/http.ts:28|/api/gauges',
      'src/widgets/GaugeReadout.tsx:41|/api/gauges',
      'src/widgets/GaugeReadout.tsx:42|(dynamic)',
    ]);
  });

  it('joins each literal call site to the route module that answers it', () => {
    const routesTo = corpus.graph
      .edges()
      .filter((edge) => edge.kind === 'routes-to')
      .map((edge) => {
        const from = assertDefined(corpus.graph.nodeById(edge.from), 'a routes-to source node');
        const to = assertDefined(corpus.graph.nodeById(edge.to), 'a routes-to target node');

        return `${from.file}:${from.line} -> ${to.file}`;
      });

    // The one edge kind no extractor can emit (`../indexer.ts` derives it after
    // both endpoints exist), and the hop that makes the browser half and the
    // server half of a project one traversable graph. The dynamic call site is
    // absent by design: its target was never written down, so it must not
    // acquire an edge to the route its prefix resembles.
    expect(routesTo).toStrictEqual([
      'src/lib/http.ts:28 -> app/api/gauges/route.ts',
      'src/widgets/GaugeReadout.tsx:41 -> app/api/gauges/route.ts',
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * findByName: the entry point of an investigation
 * ---------------------------------------------------------------------------------------------- */

describe('findByName', () => {
  it('resolves an exact name to the declarations that bear it', () => {
    const matches = queries.findByName('GaugeReadout', { exact: true });
    const component = assertDefined(
      matches.find((match) => match.kind === 'component'),
      'a component named GaugeReadout',
    );

    // One name, two nodes: the component the React extractor recognised and the
    // declaration the symbol extractor recorded, at the same position. Both are
    // exact, so both score 1 and the order is the node-id tie-break.
    expect(matches.map((match) => match.kind)).toStrictEqual(['component', 'symbol']);
    expect(matches.map((match) => match.score)).toStrictEqual([1, 1]);
    expect(component.file).toBe('src/widgets/GaugeReadout.tsx');
    expect(component.location.line).toBe(36);
    expect(component.location.column).toBe(17);
    expect(component.location.resolvedBy).toBe('code-graph');
  });

  it('ranks the loose tiers below the exact ones and never upwards', () => {
    const matches = queries.findByName('gaugereadout');

    // A lowercase needle takes no exact hit, so the tiers on show are
    // case-insensitive (the component and its declaration), prefix
    // (`GaugeReadoutProps`) and substring (the file node, whose name is the
    // path). The ranking the plan states is a descending score.
    expect(matches.map((match) => `${match.kind}:${match.name}`)).toStrictEqual([
      'component:GaugeReadout',
      'symbol:GaugeReadout',
      'symbol:GaugeReadoutProps',
      'file:src/widgets/GaugeReadout.tsx',
    ]);

    const scores = matches.map((match) => match.score ?? 0);
    expect(scores).toStrictEqual([0.75, 0.75, 0.5, 0.25]);
    for (const [position, score] of scores.entries()) {
      expect(score).toBeLessThanOrEqual(scores[position - 1] ?? score);
    }
  });

  it('admits the loose tiers only when exactness is not required', () => {
    const exact = queries.findByName('GaugeReadout', { exact: true });
    const loose = queries.findByName('GaugeReadout');

    expect(exact.every((match) => match.score === 1)).toBe(true);
    expect(loose.map((match) => match.name)).toContain('GaugeReadoutProps');
    expect(loose.length).toBeGreaterThan(exact.length);
  });

  it('keeps a kind filter absolute', () => {
    const functions = queries.findByName('summarizeBasin', { kinds: ['server-function'] });

    expect(functions.map((match) => match.kind)).toStrictEqual(['server-function']);
    expect(assertDefined(functions[0], 'the summarizeBasin server function').location.line).toBe(
      88,
    );

    // A name the corpus declares as a component cannot answer a query narrowed
    // to server functions, in either tier.
    expect(queries.findByName('GaugeReadout', { kinds: ['server-function'] })).toStrictEqual([]);
    expect(queries.findByName('gaugereadout', { kinds: ['server-function'] })).toStrictEqual([]);

    // An empty list says "no kind is acceptable", which is an empty result
    // rather than "every kind".
    expect(queries.findByName('GaugeReadout', { kinds: [] })).toStrictEqual([]);
  });

  it('answers a name that matches nothing, and one too long to be a name, with no results', () => {
    expect(queries.findByName('noSuchSymbolAnywhereInTheCorpus')).toStrictEqual([]);
    expect(
      queries.findByName('x'.repeat(CODE_QUERY_LIMITS.maxNameLength + 1), { exact: true }),
    ).toStrictEqual([]);
    expect(queries.findByName('x'.repeat(CODE_QUERY_LIMITS.maxNameLength + 1))).toStrictEqual([]);
    expect(queries.findByName('')).toStrictEqual([]);
  });

  it('honours a lower limit and clamps a higher one', () => {
    // A single-letter needle matches most of the corpus through the substring
    // tier, which is what makes the cap observable.
    expect(queries.findByName('a', { limit: 3 })).toHaveLength(3);
    expect(queries.findByName('a', { limit: 10_000 })).toHaveLength(CODE_QUERY_LIMITS.maxResults);
    expect(queries.findByName('a').length).toBeLessThanOrEqual(CODE_QUERY_LIMITS.maxResults);
    expect(queries.limits.maxResults).toBe(CODE_QUERY_LIMITS.maxResults);
  });

  it('reports the bounds actually in force after a caller tightens them', () => {
    const tightened = createCodeQueries(corpus.graph, {
      loaded: corpus.loaded,
      limits: { maxResults: 2, maxCallers: 10_000 },
    });

    // A caller may tighten the prompt budget and never widen it, and the
    // reported limits are what the stage describing these tools to a model
    // reads.
    expect(tightened.limits.maxResults).toBe(2);
    expect(tightened.limits.maxCallers).toBe(CODE_QUERY_LIMITS.maxCallers);
    expect(tightened.findByName('a', { limit: 50 })).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------------------------------
 * findSymbol and hasSymbol: the feasibility gate
 * ---------------------------------------------------------------------------------------------- */

describe('findSymbol and hasSymbol', () => {
  it('reports the facts a function-timing patch needs about a service function', () => {
    const match = assertDefined(
      queries.findSymbol('src/lib/station-service.ts', 'summarizeBasin'),
      'the summarizeBasin declaration',
    );

    expect(match.kind).toBe('server-function');
    expect(match.symbol).toBe('summarizeBasin');
    expect(match.exported).toBe(true);
    expect(match.isAsync).toBe(true);
    expect(match.file).toBe('src/lib/station-service.ts');
    expect(formatSourceLocation(match.location)).toBe('src/lib/station-service.ts:88:23');
    expect(isOk(parseSourceLocation(match.location))).toBe(true);
    expect(queries.hasSymbol('src/lib/station-service.ts', 'summarizeBasin')).toBe(true);
  });

  it('answers from a component declaration and from a plain declaration too', () => {
    const component = assertDefined(
      queries.findSymbol('src/widgets/GaugeReadout.tsx', 'GaugeReadout'),
      'the GaugeReadout declaration',
    );
    const helper = assertDefined(
      queries.findSymbol('src/widgets/BasinSummary.tsx', 'formatGaugeCount'),
      'the formatGaugeCount declaration',
    );

    expect(component.kind).toBe('component');
    expect(component.location.line).toBe(36);
    expect(helper.kind).toBe('symbol');
    expect(helper.exported).toBe(true);
    expect(helper.location.line).toBe(60);
  });

  it('denies a symbol the file does not declare', () => {
    // This is the case `packages/instrumentation/src/feasibility.ts` depends on
    // to reject a plan action naming an absent symbol: a `false` here is what
    // stops a plan that would pass feasibility and then fail at install, so the
    // predicate and the lookup are asserted together.
    expect(queries.hasSymbol('src/lib/station-service.ts', 'definitelyNotDeclaredHere')).toBe(
      false,
    );
    expect(
      queries.findSymbol('src/lib/station-service.ts', 'definitelyNotDeclaredHere'),
    ).toBeUndefined();

    // Right symbol, wrong file: the question is scoped to the file, so the
    // declaration in `station-service.ts` cannot answer for `http.ts`.
    expect(queries.hasSymbol('src/lib/http.ts', 'summarizeBasin')).toBe(false);

    // A `handler` node records a *binding* and carries the referenced
    // function's name, which is not the same claim as "this file declares it".
    expect(queries.hasSymbol('src/widgets/GaugeReadout.tsx', 'handleReadoutClick')).toBe(false);
  });

  it('refuses a file argument that is not a safe project-relative path', () => {
    for (const file of [
      '',
      '/etc/passwd',
      '../../etc/passwd',
      `${FIXTURE_ROOT}/src/lib/station-service.ts`,
      'src\\lib\\station-service.ts',
      'x'.repeat(CODE_QUERY_LIMITS.maxNameLength + 1),
    ]) {
      expect(queries.hasSymbol(file, 'summarizeBasin')).toBe(false);
      expect(queries.findSymbol(file, 'summarizeBasin')).toBeUndefined();
    }
  });

  it('keeps the predicate exactly equivalent to the lookup across the corpus', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['src/lib/station-service.ts', 'summarizeBasin'],
      ['src/lib/station-service.ts', 'listBasinGauges'],
      ['src/lib/station-service.ts', 'BasinDriftRow'],
      ['src/lib/datastore.ts', 'prisma'],
      ['src/widgets/GaugeReadout.tsx', 'GaugeReadout'],
      ['src/widgets/GaugeReadout.tsx', 'handleReadoutClick'],
      ['app/api/gauges/route.ts', 'POST'],
      ['app/api/gauges/route.ts', 'DELETE'],
      ['', ''],
    ];

    for (const [file, symbol] of cases) {
      expect(queries.hasSymbol(file, symbol)).toBe(queries.findSymbol(file, symbol) !== undefined);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * whoCalls: static edges first, references only on demand
 * ---------------------------------------------------------------------------------------------- */

describe('whoCalls', () => {
  it('finds every caller of a service function, at the call site rather than the declaration', () => {
    const callers = queries.whoCalls('summarizeBasin');

    // Three callers, one per corpus caller: the grouped catch-all route
    // handler, the grouped dynamic page and the legacy Pages handler. The set of
    // files is asserted rather than the count alone, because a count is
    // satisfied by the wrong three.
    expect(callers.map((caller) => formatSourceLocation(caller.location))).toStrictEqual([
      'app/(observatory)/api/basins/[...segments]/route.ts:80:24',
      'app/(observatory)/basins/[id]/page.tsx:62:24',
      'pages/api/gauge-log.ts:56:24',
    ]);
    expect(callers.map((caller) => `${caller.caller.kind}:${caller.caller.name}`)).toStrictEqual([
      'api-route:/api/basins/[...segments]',
      'component:BasinDetailPage',
      'api-route:/api/gauge-log',
    ]);
    expect(callers.every((caller) => caller.via === 'edge')).toBe(true);

    // The call site is not the caller's own declaration: the page's component
    // is declared on line 58 and calls on line 62, and it is the second a
    // developer wants to open.
    const page = assertDefined(callers[1], 'the page caller');
    expect(page.caller.location.line).toBe(58);
    expect(page.location.line).toBe(62);
  });

  it('finds the single caller of a client helper', () => {
    const callers = queries.whoCalls('fetchGaugeIndex');

    // The documented one-hop case: the helper's only caller corpus-wide is the
    // named click handler of the client component.
    expect(callers).toHaveLength(1);
    const only = assertDefined(callers[0], 'the fetchGaugeIndex caller');
    expect(only.caller.kind).toBe('handler');
    expect(only.caller.name).toBe('handleReadoutClick');
    expect(formatSourceLocation(only.location)).toBe('src/widgets/GaugeReadout.tsx:43:30');
  });

  it('answers the same question qualified by the declaring file', () => {
    const bare = queries.whoCalls('summarizeBasin');
    const qualified = queries.whoCalls({
      file: 'src/lib/station-service.ts',
      symbol: 'summarizeBasin',
    });

    expect(qualified).toStrictEqual(bare);
    expect(queries.whoCalls({ file: 'src/lib/http.ts', symbol: 'summarizeBasin' })).toStrictEqual(
      [],
    );
  });

  it('does not consult the reference resolver when the graph already answered', () => {
    const referencesTo = vi.fn<ReferenceResolver['referencesTo']>(() => []);
    const withResolver = createCodeQueries(corpus.graph, {
      loaded: corpus.loaded,
      references: { referencesTo },
    });

    // The laziness is a contract, not an optimisation: `findReferences` type-checks
    // the whole program, so a static answer must never pay for it. `../indexer.ts`
    // asserts the build never calls it either.
    expect(withResolver.whoCalls('summarizeBasin')).toHaveLength(3);
    expect(referencesTo).not.toHaveBeenCalled();

    // Asked explicitly, it is consulted once per distinct declaring file and
    // symbol.
    expect(withResolver.whoCalls('summarizeBasin', { useReferences: true })).toHaveLength(3);
    expect(referencesTo.mock.calls).toStrictEqual([
      [{ file: 'src/lib/station-service.ts', symbol: 'summarizeBasin' }],
    ]);
  });

  it('adds a reference without ever duplicating a call site the graph found', () => {
    const graphSite: SourceLocation = {
      file: 'pages/api/gauge-log.ts',
      line: 56,
      column: 24,
      resolvedBy: 'code-graph',
      confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
    };
    const unseenSite: SourceLocation = {
      file: 'src/widgets/BasinSummary.tsx',
      line: 73,
      column: 9,
      resolvedBy: 'code-graph',
      confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
    };
    const deepened = createCodeQueries(corpus.graph, {
      loaded: corpus.loaded,
      references: { referencesTo: () => [graphSite, unseenSite] },
    }).whoCalls('summarizeBasin', { useReferences: true });

    // The resolver's first answer is a position the graph already reported, so
    // it contributes nothing; the second is new, is attributed to the
    // declaration enclosing it, and is marked with the weaker provenance so a
    // consumer can weigh "the type checker saw this identifier" against "an
    // extractor understood this call".
    expect(
      deepened.map((caller) => `${caller.via}|${formatSourceLocation(caller.location)}`),
    ).toStrictEqual([
      'edge|app/(observatory)/api/basins/[...segments]/route.ts:80:24',
      'edge|app/(observatory)/basins/[id]/page.tsx:62:24',
      'edge|pages/api/gauge-log.ts:56:24',
      'references|src/widgets/BasinSummary.tsx:73:9',
    ]);
    expect(assertDefined(deepened[3], 'the reference caller').caller.name).toBe('BasinSummary');
  });

  it('answers a symbol with no recorded caller with no callers', () => {
    // No resolver injected, so there is nothing to fall back to — and nothing
    // throws. The root layout component is rendered by the framework rather
    // than called by the corpus.
    expect(queries.whoCalls('ObservatoryLayout')).toStrictEqual([]);
    expect(queries.whoCalls('noSuchSymbolAnywhereInTheCorpus')).toStrictEqual([]);
    expect(queries.whoCalls('x'.repeat(CODE_QUERY_LIMITS.maxNameLength + 1))).toStrictEqual([]);
  });

  it('is de-duplicated, deterministically ordered and repeatable', () => {
    const first = queries.whoCalls('listBasinGauges');
    const second = queries.whoCalls('listBasinGauges');

    expect(first).toStrictEqual(second);
    expect(first.map((caller) => formatSourceLocation(caller.location))).toStrictEqual([
      'app/api/gauges/[id]/route.ts:71:24',
      'app/api/gauges/route.ts:58:24',
    ]);

    const keys = first.map((caller) => formatSourceLocation(caller.location));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports a capped answer as a deterministic prefix', () => {
    const all = queries.whoCalls('summarizeBasin');
    const capped = createCodeQueries(corpus.graph, {
      loaded: corpus.loaded,
      limits: { maxCallers: 2 },
    });

    // `CallerRef[]` carries no truncation flag, which is what `./query.ts`
    // documents: the cap yields the first entries of the one deterministic
    // order, so a prefix is comparable between runs and between limits.
    expect(queries.whoCalls('summarizeBasin', { limit: 1 })).toStrictEqual(all.slice(0, 1));
    expect(capped.limits.maxCallers).toBe(2);
    expect(capped.whoCalls('summarizeBasin')).toStrictEqual(all.slice(0, 2));
    expect(capped.whoCalls('summarizeBasin', { limit: 10_000 })).toStrictEqual(all.slice(0, 2));
  });
});

/* -------------------------------------------------------------------------------------------------
 * routeForUrl and handlersFor: matching delegated, never reimplemented
 * ---------------------------------------------------------------------------------------------- */

describe('routeForUrl', () => {
  it('resolves a multi-method App Router handler', () => {
    const route = assertDefined(queries.routeForUrl('/api/gauges'), 'the /api/gauges route');

    expect(route.file).toBe('app/api/gauges/route.ts');
    expect(route.routePath).toBe('/api/gauges');
    expect(route.router).toBe('app');
    expect(route.kind).toBe('route-handler');
    expect([...route.methods]).toStrictEqual(['GET', 'POST']);
    expect(route.params).toStrictEqual({});
    expect(assertDefined(route.node, 'the graph node for the route module').kind).toBe('api-route');
  });

  it('resolves a dynamic segment and reports what it captured', () => {
    const route = assertDefined(queries.routeForUrl('/api/gauges/abc'), 'the dynamic route');

    expect(route.file).toBe('app/api/gauges/[id]/route.ts');
    expect(route.routePath).toBe('/api/gauges/[id]');
    expect(route.params).toStrictEqual({ id: 'abc' });
  });

  it('resolves a catch-all inside a route group, with the group absent from the route path', () => {
    const route = assertDefined(queries.routeForUrl('/api/basins/north/upper'), 'the catch-all');

    expect(route.file).toBe('app/(observatory)/api/basins/[...segments]/route.ts');
    // A route group is an organisational directory and never a URL segment, so
    // the matched route path names neither `(observatory)` nor its parentheses.
    expect(route.routePath).toBe('/api/basins/[...segments]');
    expect(route.routePath).not.toContain('observatory');
    // A catch-all captures an array, one entry per remaining segment.
    expect(route.params).toStrictEqual({ segments: ['north', 'upper'] });
  });

  it('resolves a page module and a grouped dynamic page', () => {
    const root = assertDefined(queries.routeForUrl('/'), 'the root page');
    const detail = assertDefined(queries.routeForUrl('/basins/7'), 'the grouped dynamic page');

    expect(root.file).toBe('app/page.tsx');
    expect(root.kind).toBe('page');
    expect(detail.file).toBe('app/(observatory)/basins/[id]/page.tsx');
    expect(detail.kind).toBe('page');
    expect(detail.params).toStrictEqual({ id: '7' });
  });

  it('resolves the legacy Pages Router handler as answering every method', () => {
    const route = assertDefined(queries.routeForUrl('/api/gauge-log'), 'the legacy handler');

    expect(route.file).toBe('pages/api/gauge-log.ts');
    expect(route.router).toBe('pages');
    expect(route.kind).toBe('route-handler');
    // One default-exported handler dispatches on the method itself, so the
    // route map reports `ANY` rather than guessing a list.
    expect([...route.methods]).toStrictEqual(['ANY']);
  });

  it('reads a query, a fragment, a trailing slash and a loopback origin as the same request', () => {
    const bare = assertDefined(queries.routeForUrl('/api/gauges'), 'the bare pathname');

    for (const url of [
      '/api/gauges?take=5&basinId=north',
      '/api/gauges#top',
      '/api/gauges/',
      'http://localhost:3000/api/gauges',
      'http://127.0.0.1:3000/api/gauges?take=5',
    ]) {
      const route = assertDefined(queries.routeForUrl(url), `the route for ${url}`);

      expect(route.file).toBe(bare.file);
      expect(route.routePath).toBe(bare.routePath);
      expect(route.params).toStrictEqual(bare.params);
    }

    // An absolute URL additionally carries the origin it was addressed to, which
    // is how a third-party URL whose path coincides with a local route is kept
    // from acquiring a location in the developer's project.
    expect(
      assertDefined(queries.routeForUrl('http://localhost:3000/api/gauges'), 'the absolute form')
        .match.origin?.loopback,
    ).toBe(true);
    expect(bare.match.origin).toBeUndefined();
  });

  it('resolves nothing for a path no module serves, or an argument too long to be a URL', () => {
    expect(queries.routeForUrl('/api/nope')).toBeUndefined();
    // The catch-all needs at least one segment and the dynamic route exactly
    // one; a route group never appears in a URL.
    expect(queries.routeForUrl('/api/basins')).toBeUndefined();
    expect(queries.routeForUrl('/api/gauges/north-01/extra')).toBeUndefined();
    expect(queries.routeForUrl('/(observatory)/basins/7')).toBeUndefined();
    expect(queries.routeForUrl('')).toBeUndefined();
    expect(
      queries.routeForUrl(`/api/${'x'.repeat(CODE_QUERY_LIMITS.maxUrlLength)}`),
    ).toBeUndefined();
  });

  it('delegates matching entirely to the route map', () => {
    const entries = routeMapFromIndex(corpus.index).entries;

    // Every answer this query gives is the answer `../route-map.ts` gives for
    // the same input, which is the evidence that there is no second matching
    // algorithm in this folder. Route groups, dynamic and catch-all segments,
    // specificity, percent-decoding and the origin policy all live there.
    for (const url of [
      '/api/gauges',
      '/api/gauges/abc',
      '/api/basins/north/upper',
      '/',
      '/basins/7',
      '/api/gauge-log',
      '/api/gauges?take=5',
      '/api/gauges/',
      'http://localhost:3000/api/gauges',
      '/api/nope',
    ]) {
      expect(queries.routeForUrl(url)?.match).toStrictEqual(matchRoute(entries, url));
    }
  });

  it('keeps the route map as the resolver of a route location', () => {
    const route = assertDefined(queries.routeForUrl('/api/gauges'), 'the /api/gauges route');
    const node = assertDefined(route.node, 'the graph node for the route module');

    // Two resolution routes, both correct, deliberately not flattened into one:
    // the route map found the module from the URL, and the graph found the same
    // module from its own node. Rewriting the first as `code-graph` would
    // misreport how it was found, and the confidence table is the only place
    // either number is written down.
    expect(route.location.resolvedBy).toBe('route-map');
    expect(route.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['route-map']);
    expect(node.location.resolvedBy).toBe('code-graph');
    expect(node.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
    expect(route.location.file).toBe(route.file);
    expect(node.location.file).toBe(route.file);
  });
});

describe('handlersFor', () => {
  it('lists one handler per method, each at its own declaration', () => {
    const handlers = queries.handlersFor('/api/gauges');

    expect(handlers.map((handler) => `${handler.method}:${handler.symbol ?? '-'}`)).toStrictEqual([
      'GET:GET',
      'POST:POST',
    ]);
    // Distinct locations: a route exporting two methods is two places to open,
    // and a result that pointed both at the module's first line would be
    // useless for exactly the question it answers.
    expect(handlers.map((handler) => formatSourceLocation(handler.location))).toStrictEqual([
      'app/api/gauges/route.ts:47:23',
      'app/api/gauges/route.ts:69:23',
    ]);
    expect(handlers.every((handler) => handler.location.resolvedBy === 'code-graph')).toBe(true);
    expect(corpusLines('app/api/gauges/route.ts')[46]).toMatch(/^export async function GET\(/);
    expect(corpusLines('app/api/gauges/route.ts')[68]).toMatch(/^export async function POST\(/);
  });

  it('narrows to one method, and refuses a method the route does not serve', () => {
    const post = queries.handlersFor('/api/gauges', { method: 'POST' });

    expect(post).toHaveLength(1);
    expect(assertDefined(post[0], 'the POST handler').location.line).toBe(69);
    expect(queries.handlersFor('/api/gauges', { method: 'DELETE' })).toStrictEqual([]);
    expect(queries.handlersFor('/api/nope')).toStrictEqual([]);
  });

  it('reports a single dispatching handler for the legacy route, whatever method is asked', () => {
    const any = queries.handlersFor('/api/gauge-log');

    expect(any.map((handler) => `${handler.method}:${handler.symbol ?? '-'}`)).toStrictEqual([
      'ANY:handler',
    ]);
    expect(formatSourceLocation(assertDefined(any[0], 'the legacy handler').location)).toBe(
      'pages/api/gauge-log.ts:49:31',
    );
    // It does answer a POST, so a method filter must not hide it.
    expect(queries.handlersFor('/api/gauge-log', { method: 'POST' })).toStrictEqual(any);
  });

  it('falls back to the route map when the graph holds no handler declaration', () => {
    const page = queries.handlersFor('/');

    // A page module exports a component rather than a method-named function, so
    // there is no `GET` declaration to point at. The answer is the route map's
    // own location, forwarded with its provenance intact rather than restamped —
    // the same distinction the route group asserts, inside one query.
    expect(page).toHaveLength(1);
    const only = assertDefined(page[0], 'the page handler');
    expect(only.method).toBe('GET');
    expect(only.symbol).toBeUndefined();
    expect(only.location.resolvedBy).toBe('route-map');
    expect(only.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['route-map']);
    expect(only.location.file).toBe('app/page.tsx');
  });
});

/* -------------------------------------------------------------------------------------------------
 * componentsRendering: the parents, not the children
 * ---------------------------------------------------------------------------------------------- */

describe('componentsRendering', () => {
  it('finds the component that renders the named one, at the element', () => {
    const parents = queries.componentsRendering('GaugeReadout');

    // Direction matters and is asserted explicitly: these are the components
    // that render `GaugeReadout` — its parents — not the components it renders.
    // An inverted implementation would answer with nothing here (the client
    // widget renders no corpus component) and would still pass a count-only
    // assertion elsewhere.
    expect(parents).toHaveLength(1);
    const parent = assertDefined(parents[0], 'the parent of GaugeReadout');
    expect(parent.component.name).toBe('BasinSummary');
    expect(parent.component.file).toBe('src/widgets/BasinSummary.tsx');
    expect(parent.component.location.line).toBe(68);
    // The JSX element's own position, which is the line that explains why the
    // child rendered.
    expect(formatSourceLocation(parent.location)).toBe('src/widgets/BasinSummary.tsx:73:7');
    expect(corpusLines('src/widgets/BasinSummary.tsx')[72]).toContain('<GaugeReadout');
  });

  it('finds the page component that renders the summary', () => {
    const parents = queries.componentsRendering('BasinSummary');

    expect(parents.map((parent) => parent.component.name)).toStrictEqual(['BasinIndexPage']);
    expect(formatSourceLocation(assertDefined(parents[0], 'the page').location)).toBe(
      'app/page.tsx:37:7',
    );
  });

  it('answers a component nothing renders, and a name nothing bears, with no results', () => {
    // The page and the layout are entered by the framework, not rendered by
    // another component of the corpus.
    expect(queries.componentsRendering('BasinIndexPage')).toStrictEqual([]);
    expect(queries.componentsRendering('ObservatoryLayout')).toStrictEqual([]);
    expect(queries.componentsRendering('NoSuchComponent')).toStrictEqual([]);
    expect(queries.componentsRendering('')).toStrictEqual([]);
  });

  it('honours a lower limit', () => {
    expect(queries.componentsRendering('GaugeReadout', { limit: 1 })).toHaveLength(1);
    expect(
      queries.componentsRendering('GaugeReadout', { limit: 10_000 }).length,
    ).toBeLessThanOrEqual(CODE_QUERY_LIMITS.maxResults);
  });
});

/* -------------------------------------------------------------------------------------------------
 * pathBetween: the cross-tier flow Stage 2 renders
 * ---------------------------------------------------------------------------------------------- */

describe('pathBetween', () => {
  it('walks a click through to the Prisma query behind it', () => {
    const component = assertDefined(
      queries
        .findByName('GaugeReadout', { exact: true })
        .find((match) => match.kind === 'component'),
      'the GaugeReadout component',
    );
    const query = corpusNode('db-call', 'prisma.gauge.findMany');
    const path = assertDefined(
      queries.pathBetween(component.nodeId, query.id),
      'the path from the client component to the Prisma call',
    );

    // The flow AAP 0.8.3 names, end to end and in one traversal: the client
    // component, the named click handler it binds, the literal `fetch` that
    // handler issues, the App Router module that answers that URL, the service
    // function the handler delegates to, and the database call that function
    // makes. Asserted as an ordered subsequence, because an intermediate
    // `declares` hop between a route and its exported method symbol is an
    // equally valid graph shape for the same flow.
    expect(
      containsSubsequence(stepsOf(path.nodes), [
        'component:GaugeReadout',
        'handler:handleReadoutClick',
        'api-call:fetch',
        'api-route:/api/gauges',
        'server-function:listBasinGauges',
        'db-call:prisma.gauge.findMany',
      ]),
    ).toBe(true);

    // The request hop is the one the model was told about: a literal URL,
    // recorded exactly as written, at the call site in the client component
    // rather than the one in the shared helper.
    const call = nodeOnPath('api-call', path.nodes);
    const callStep = assertDefined(
      path.nodes.find((node) => node.kind === 'api-call'),
      'the request hop of the path',
    );
    expect(call.data.url).toBe('/api/gauges');
    expect(call.data.dynamic).toBe(false);
    expect(formatSourceLocation(callStep.location)).toBe('src/widgets/GaugeReadout.tsx:41:33');
    expect(query.data.driver).toBe('prisma');

    // A downstream search, so every hop points the way the path travels and the
    // node list may be read as a flow.
    expect(path.undirected).toBe(false);
    expect(path.edges.every((edge) => !edge.traversedAgainstDirection)).toBe(true);
    expect(path.edges.map((edge) => edge.kind)).toStrictEqual([
      'handles',
      'calls',
      'routes-to',
      'calls',
      'queries',
    ]);
    expect(path.depth).toBe(path.edges.length);
    expect(path.nodes).toHaveLength(path.edges.length + 1);
    // A returned path is always complete and always the shortest one, so the
    // flag describes the search and is false whenever a path came back.
    expect(path.truncated).toBe(false);

    // The derived hop is the one edge with no site: it was computed from two
    // nodes rather than read off a line of source.
    const derived = assertDefined(
      path.edges.find((edge) => edge.kind === 'routes-to'),
      'the routes-to hop',
    );
    expect(derived.location).toBeUndefined();
    expect(
      path.edges
        .filter((edge) => edge.kind !== 'routes-to')
        .every((edge) => edge.location?.resolvedBy === 'code-graph'),
    ).toBe(true);
  });

  it('walks a route handler to the borrowed-client query inside its service function', () => {
    const route = routeNodeFor('app/api/gauges/route.ts');
    const borrowed = corpusNode('db-call', 'client.query');
    const path = assertDefined(
      queries.pathBetween(route.id, borrowed.id),
      'the path to the borrowed-client query',
    );

    expect(stepsOf(path.nodes)).toStrictEqual([
      'api-route:/api/gauges',
      'server-function:recordGaugeReading',
      'db-call:client.query',
    ]);
    // The `pg` shape that borrows a connection from the pool — distinct from
    // the direct `pool.query` and from a Prisma delegate call, and the
    // distinction is what lets an instrumentation plan choose an adapter.
    expect(borrowed.data.driver).toBe('pg');
    expect(formatSourceLocation(assertDefined(path.nodes[2], 'the query node').location)).toBe(
      'src/lib/station-service.ts:72:11',
    );
  });

  it('keeps the corpus’ three database shapes apart', () => {
    const shapes = [
      { function: 'recordGaugeReading', call: 'client.query', driver: 'pg', line: 72 },
      { function: 'recordGaugeReading', call: 'prisma.reading.create', driver: 'prisma', line: 66 },
      { function: 'summarizeBasin', call: 'pool.query', driver: 'pg', line: 90 },
    ] as const;

    for (const shape of shapes) {
      const node = corpusNode('db-call', shape.call);
      const path = assertDefined(
        queries.pathBetween({ name: shape.function, kind: 'server-function' }, node.id),
        `the path from ${shape.function} to ${shape.call}`,
      );

      expect(stepsOf(path.nodes)).toStrictEqual([
        `server-function:${shape.function}`,
        `db-call:${shape.call}`,
      ]);
      expect(path.edges.map((edge) => edge.kind)).toStrictEqual(['queries']);
      expect(node.data.driver).toBe(shape.driver);
      expect(node.line).toBe(shape.line);
      expect(node.symbol).toBe(shape.function);
    }
  });

  it('answers a pair with no connecting path with no path', () => {
    const layout = assertDefined(
      queries
        .findByName('ObservatoryLayout', { exact: true })
        .find((match) => match.kind === 'component'),
      'the layout component',
    );

    // The root layout imports nothing and calls nothing, so no chain of
    // relationships reaches a database call — which is `undefined` rather than
    // an empty path or a throw.
    expect(queries.pathBetween(layout.nodeId, { kind: 'db-call' })).toBeUndefined();
    // An endpoint that resolves to nothing is the same answer.
    expect(queries.pathBetween('no-such-node-id', { kind: 'db-call' })).toBeUndefined();
    expect(queries.pathBetween(layout.nodeId, {})).toBeUndefined();
  });

  it('respects a depth bound rather than wandering, and never loops', () => {
    const component = assertDefined(
      queries
        .findByName('GaugeReadout', { exact: true })
        .find((match) => match.kind === 'component'),
      'the GaugeReadout component',
    );
    const query = corpusNode('db-call', 'prisma.gauge.findMany');

    // The chain is five hops. A search bounded below that reports "not
    // reachable within these bounds" rather than a partial path, because a
    // partial path would assert a flow the code does not contain.
    expect(
      assertDefined(
        queries.pathBetween(component.nodeId, query.id, { maxDepth: 5 }),
        'the bounded path',
      ).depth,
    ).toBe(5);
    expect(queries.pathBetween(component.nodeId, query.id, { maxDepth: 4 })).toBeUndefined();
    expect(queries.pathBetween(component.nodeId, query.id, { maxDepth: 1 })).toBeUndefined();

    // A node budget bites the same way, and an edge-kind filter that excludes
    // the first hop leaves the target unreachable.
    expect(queries.pathBetween(component.nodeId, query.id, { maxNodes: 1 })).toBeUndefined();
    expect(
      queries.pathBetween(component.nodeId, query.id, { edgeKinds: ['calls'] }),
    ).toBeUndefined();
    expect(queries.pathBetween(component.nodeId, query.id, { edgeKinds: [] })).toBeUndefined();

    // The corpus graph contains cycles through its file nodes, and an
    // undirected search over it still terminates with an answer.
    const undirected = assertDefined(
      queries.pathBetween(component.nodeId, query.id, { direction: 'both' }),
      'the undirected path',
    );
    expect(undirected.undirected).toBe(true);
    expect(undirected.depth).toBeLessThanOrEqual(CODE_QUERY_LIMITS.maxPathDepth);
  });

  it('answers a node paired with itself with that node alone', () => {
    const query = corpusNode('db-call', 'pool.query');
    const path = assertDefined(queries.pathBetween(query.id, query.id), 'the degenerate path');

    expect(path.nodes).toHaveLength(1);
    expect(path.edges).toStrictEqual([]);
    expect(path.depth).toBe(0);
  });

  it('is identical on a repeat call and on a second, independently built index', async () => {
    const component = assertDefined(
      queries
        .findByName('GaugeReadout', { exact: true })
        .find((match) => match.kind === 'component'),
      'the GaugeReadout component',
    );
    const query = corpusNode('db-call', 'prisma.gauge.findMany');
    const path = assertDefined(queries.pathBetween(component.nodeId, query.id), 'the first path');

    expect(queries.pathBetween(component.nodeId, query.id)).toStrictEqual(path);

    // Determinism across *processes* is the claim `./query.ts` makes — node and
    // edge identities are derived, the graph orders both arrays canonically, and
    // the search expands each frontier in that order — so one index cannot test
    // it. A second, independent indexing of the same corpus must produce the
    // same path, byte for byte.
    const second = await indexCorpus();
    const again = assertDefined(
      createCodeQueries(second.graph, { loaded: second.loaded }).pathBetween(
        component.nodeId,
        query.id,
      ),
      'the path over the second index',
    );

    expect(again).toStrictEqual(path);
    for (const node of again.nodes) {
      expect(isOk(parseSourceLocation(node.location))).toBe(true);
      expect(node.location.resolvedBy).toBe('code-graph');
      expect(node.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
    }
  }, 120_000);

  it('walks back upstream from a route to the component whose handler issues its request', () => {
    const route = { file: 'app/api/gauges/route.ts', kind: 'api-route' } as const;
    const callerKinds: readonly CodeEdgeKind[] = ['routes-to', 'calls', 'handles'];
    const upstream = assertDefined(
      queries.pathBetween(
        route,
        { kind: 'component' },
        { edgeKinds: callerKinds, direction: 'in' },
      ),
      'the upstream path from the route to a component',
    );

    // "What reaches this": the same flow the downstream search finds, found
    // from the other end, so the node list runs from the `from` endpoint to
    // the `to` endpoint and every hop points back the way the walk came.
    expect(stepsOf(upstream.nodes)).toStrictEqual([
      'api-route:/api/gauges',
      'api-call:fetch',
      'handler:handleReadoutClick',
      'component:GaugeReadout',
    ]);
    expect(upstream.undirected).toBe(false);
    expect(upstream.truncated).toBe(false);
    expect(upstream.edges.map((edge) => edge.traversedAgainstDirection)).toStrictEqual([
      true,
      true,
      true,
    ]);
    for (const [position, hop] of upstream.edges.entries()) {
      expect(hop.to).toBe(upstream.nodes[position]?.nodeId);
      expect(hop.from).toBe(upstream.nodes[position + 1]?.nodeId);
    }

    // Reversed, it is exactly the downstream flow from that component.
    const downstream = assertDefined(
      queries.pathBetween({ name: 'GaugeReadout', kind: 'component' }, route, {
        edgeKinds: callerKinds,
      }),
      'the downstream path from the component to the route',
    );
    const relationships = (path: CodePath): readonly string[] =>
      path.edges.map((edge) => `${edge.kind} ${edge.from} ${edge.to}`);

    expect(upstream.nodes.map((node) => node.nodeId).reverse()).toStrictEqual(
      downstream.nodes.map((node) => node.nodeId),
    );
    expect([...relationships(upstream)].reverse()).toStrictEqual(relationships(downstream));
    expect(downstream.edges.every((edge) => !edge.traversedAgainstDirection)).toBe(true);
  });

  it('follows incoming edges only upstream, and never the way the relationships point', () => {
    const route = { file: 'app/api/gauges/route.ts', kind: 'api-route' } as const;
    const component = { name: 'GaugeReadout', kind: 'component' } as const;

    // The route's database call is downstream of it and the route is
    // downstream of the component, so an upstream search reaches neither,
    // while the downstream search reaches both.
    expect(queries.pathBetween(route, { kind: 'db-call' }, { direction: 'in' })).toBeUndefined();
    expect(queries.pathBetween(route, { kind: 'db-call' })).toBeDefined();
    expect(queries.pathBetween(component, route, { direction: 'in' })).toBeUndefined();
    expect(queries.pathBetween(component, route)).toBeDefined();

    // A single-node path is directed whichever directed search asked for it.
    const query = corpusNode('db-call', 'pool.query');
    expect(queries.pathBetween(query.id, query.id, { direction: 'in' })).toMatchObject({
      depth: 0,
      undirected: false,
      edges: [],
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * pathBetween: the node budget is spent only on nodes that can lead somewhere
 * ---------------------------------------------------------------------------------------------- */

/** The file of the hand-built form component and every handler it binds. */
const FORM_FILE = 'src/widgets/Form.tsx';

/** How many leaf handlers the form binds: more than the default node budget. */
const LEAF_HANDLER_COUNT = CODE_QUERY_LIMITS.maxPathNodes + 8;

/**
 * A node of the hand-built graph, with its id derived through the real
 * {@link makeNodeId} so the canonical order the search expands in is the one
 * a real index has.
 */
function formNode<K extends CodeNodeKind>(
  kind: K,
  file: string,
  name: string,
  line: number,
  data: CodeNodeOf<K>['data'],
): CodeNodeOf<K> {
  return {
    id: makeNodeId({ kind, file, name, line, column: 1 }),
    kind,
    name,
    file,
    line,
    column: 1,
    data,
  } as CodeNodeOf<K>;
}

/** An edge of the hand-built graph, sited in the file of its origin. */
function formEdge(kind: CodeEdgeKind, from: CodeNode, to: CodeNode): CodeEdge {
  return {
    id: makeEdgeId({ kind, from: from.id, to: to.id, line: from.line, column: 1 }),
    kind,
    from: from.id,
    to: to.id,
    file: from.file,
    line: from.line,
    column: 1,
  };
}

describe('pathBetween: the node budget is spent only on nodes that can lead somewhere', () => {
  /*
   * A form that binds many inline handlers only one of which does anything:
   *
   *   Form --handles--> onBlur ×LEAF_HANDLER_COUNT   (leaves: no outgoing edge)
   *   Form --handles--> onSubmit --calls--> fetch --routes-to--> /api/widgets
   *
   * Every `onBlur` id sorts ahead of `onSubmit`'s, so a search seeded with
   * every handler of the file expands the leaves first. Before dead ends were
   * left off the frontier, that spent the whole default budget on leaves and
   * the route was never reached.
   */
  const form = formNode('component', FORM_FILE, 'Form', 1, {
    isClient: true,
    isDefaultExport: false,
    displayName: 'Form',
  });
  const leaves = Array.from({ length: LEAF_HANDLER_COUNT }, (_unused, index) =>
    formNode('handler', FORM_FILE, 'onBlur', index + 2, {
      event: 'blur',
      boundTo: 'input',
      inline: true,
    }),
  );
  const submit = formNode('handler', FORM_FILE, 'onSubmit', 90, {
    event: 'submit',
    boundTo: 'form',
    inline: true,
  });
  const request = formNode('api-call', FORM_FILE, 'fetch', 91, {
    url: '/api/widgets',
    dynamic: false,
    method: 'POST',
  });
  const route = formNode('api-route', 'app/api/widgets/route.ts', '/api/widgets', 1, {
    routePath: '/api/widgets',
    router: 'app',
    kind: 'route-handler',
    methods: ['POST'],
  });
  const index: CodeIndex = {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: '/tmp/project',
    indexerVersion: INDEXER_VERSION,
    generatedAt: 0,
    nodes: [form, ...leaves, submit, request, route],
    edges: [
      ...leaves.map((leaf) => formEdge('handles', form, leaf)),
      formEdge('handles', form, submit),
      formEdge('calls', submit, request),
      formEdge('routes-to', request, route),
    ],
    files: [],
  };
  const graph = CodeGraph.fromIndex(index);
  const handlerSources = { file: FORM_FILE, kind: 'handler' } as const;
  const requestKinds: readonly CodeEdgeKind[] = ['calls', 'routes-to'];

  it('builds the graph it describes, with every leaf ahead of the productive handler', () => {
    expect(graph.diagnostics).toStrictEqual([]);
    expect(leaves.every((leaf) => leaf.id < submit.id)).toBe(true);
    expect(leaves.length).toBeGreaterThan(CODE_QUERY_LIMITS.maxPathNodes);
  });

  it('reaches the route through the one productive source within the default budget', () => {
    const path = assertDefined(
      createCodeQueries(graph).pathBetween(
        handlerSources,
        { kind: 'api-route' },
        {
          edgeKinds: requestKinds,
        },
      ),
      'the path from the submitting handler to its route',
    );

    expect(stepsOf(path.nodes)).toStrictEqual([
      'handler:onSubmit',
      'api-call:fetch',
      'api-route:/api/widgets',
    ]);
    expect(path.truncated).toBe(false);

    // The same answer a search seeded with that handler alone gives: pruning
    // changes which nodes are expanded, never which path is found.
    expect(
      createCodeQueries(graph).pathBetween(
        submit.id,
        { kind: 'api-route' },
        {
          edgeKinds: requestKinds,
        },
      ),
    ).toStrictEqual(path);
  });

  it('counts only the nodes that lead somewhere against the budget', () => {
    const queriesOver = createCodeQueries(graph);

    // Two expansions — the handler, then the request — reach the route, however
    // many leaves were seeded before them; one is not enough.
    expect(
      queriesOver.pathBetween(
        handlerSources,
        { kind: 'api-route' },
        {
          edgeKinds: requestKinds,
          maxNodes: 2,
        },
      ),
    ).toBeDefined();
    expect(
      queriesOver.pathBetween(
        handlerSources,
        { kind: 'api-route' },
        {
          edgeKinds: requestKinds,
          maxNodes: 1,
        },
      ),
    ).toBeUndefined();
  });

  it('reads the same flow upstream from the route, through the productive handler', () => {
    const path = assertDefined(
      createCodeQueries(graph).pathBetween(
        route.id,
        { kind: 'component' },
        {
          edgeKinds: ['routes-to', 'calls', 'handles'],
          direction: 'in',
        },
      ),
      'the upstream path from the route to the form',
    );

    expect(stepsOf(path.nodes)).toStrictEqual([
      'api-route:/api/widgets',
      'api-call:fetch',
      'handler:onSubmit',
      'component:Form',
    ]);
    expect(path.undirected).toBe(false);
    expect(path.edges.every((edge) => edge.traversedAgainstDirection)).toBe(true);
  });

  it('sets truncated only where a bound cut short a node that could lead somewhere', () => {
    const { logger, records } = capturingLogger('trace');
    const logged = createCodeQueries(graph, { logger });

    // Along `handles` alone every handler is a leaf, so none is queued at the
    // depth bound and the miss is exhaustive rather than cut short.
    expect(
      logged.pathBetween(form.id, { kind: 'api-route' }, { edgeKinds: ['handles'], maxDepth: 1 }),
    ).toBeUndefined();
    // Along the whole chain the submitting handler leads on, so stopping it at
    // the depth bound is a truncation.
    expect(
      logged.pathBetween(
        form.id,
        { kind: 'api-route' },
        {
          edgeKinds: ['handles', 'calls', 'routes-to'],
          maxDepth: 1,
        },
      ),
    ).toBeUndefined();

    const misses = records.filter((record) => record.message === PATH_MISS_LOG);
    expect(misses.map((record) => [record.fields.expanded, record.fields.truncated])).toStrictEqual(
      [
        [1, false],
        [1, true],
      ],
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * excerpt: bounded source text, and never an environment file
 * ---------------------------------------------------------------------------------------------- */

describe('excerpt', () => {
  it('returns the window around a node, 1-based and matching the file', () => {
    const declaration = assertDefined(
      queries.findByName('summarizeBasin', { kinds: ['server-function'] })[0],
      'the summarizeBasin server function',
    );
    const excerpt = assertDefined(queries.excerpt(declaration.nodeId), 'the excerpt');
    const lines = corpusLines('src/lib/station-service.ts');

    // The node carries its extent, so the window is "three lines of context
    // before the declaration, through its last line".
    expect(excerpt.file).toBe('src/lib/station-service.ts');
    expect(excerpt.startLine).toBe(85);
    expect(excerpt.endLine).toBe(100);
    expect(excerpt.truncated).toBe(false);
    expect(excerpt.text).toBe(lines.slice(84, 100).join('\n'));
    expect(excerpt.text).toContain('export async function summarizeBasin(');
  });

  it('widens with contextLines and clamps at both ends of the file', () => {
    const declaration = assertDefined(
      queries.findByName('summarizeBasin', { kinds: ['server-function'] })[0],
      'the summarizeBasin server function',
    );

    expect(
      assertDefined(queries.excerpt(declaration.nodeId, { contextLines: 10 }), 'the wide excerpt')
        .startLine,
    ).toBe(78);
    expect(
      assertDefined(queries.excerpt(declaration.nodeId, { contextLines: 0 }), 'the narrow excerpt')
        .startLine,
    ).toBe(88);

    const lines = corpusLines('src/lib/datastore.ts');
    const atStart = assertDefined(
      queries.excerpt({ file: 'src/lib/datastore.ts', line: 1 }, { contextLines: 5 }),
      'the excerpt at the first line',
    );
    const atEnd = assertDefined(
      queries.excerpt({ file: 'src/lib/datastore.ts', line: lines.length }, { contextLines: 3 }),
      'the excerpt at the last line',
    );

    // Context before line 1 and after the last line does not exist, and asking
    // for it is clamped rather than refused or padded. Neither is truncation: the
    // file simply ended.
    expect(atStart.startLine).toBe(1);
    expect(atStart.endLine).toBe(6);
    expect(atStart.truncated).toBe(false);
    expect(atEnd.endLine).toBe(lines.length);
    expect(atEnd.truncated).toBe(false);

    // An anchor past the end of the file is clamped to the file, for the same
    // reason: these arguments arrive from a model.
    const beyond = assertDefined(
      queries.excerpt({ file: 'src/lib/datastore.ts', line: 10_000 }),
      'the excerpt past the end',
    );
    expect(beyond.endLine).toBe(lines.length);
    expect(beyond.startLine).toBeGreaterThanOrEqual(1);
  });

  it('truncates on a line boundary when the window exceeds the line budget', () => {
    const excerpt = assertDefined(
      queries.excerpt({ file: 'src/widgets/GaugeReadout.tsx', line: 1, endLine: 10_000 }),
      'the over-long window',
    );
    const lines = corpusLines('src/widgets/GaugeReadout.tsx');

    expect(excerpt.truncated).toBe(true);
    expect(excerpt.endLine - excerpt.startLine + 1).toBeLessThanOrEqual(
      CODE_QUERY_LIMITS.maxExcerptLines,
    );
    expect(excerpt.text.split('\n')).toHaveLength(CODE_QUERY_LIMITS.maxExcerptLines);
    expect(excerpt.text.length).toBeLessThanOrEqual(CODE_QUERY_LIMITS.maxExcerptChars);
    // Whole lines, not a cut through one: the clipped text is a prefix of the
    // file's lines joined as they were written.
    expect(excerpt.text).toBe(lines.slice(0, CODE_QUERY_LIMITS.maxExcerptLines).join('\n'));
  });

  it('truncates within the character budget a caller lowered', () => {
    const excerpt = assertDefined(
      queries.excerpt(
        { file: 'src/lib/station-service.ts', line: 88, endLine: 100 },
        { maxChars: 80 },
      ),
      'the character-bounded excerpt',
    );

    expect(excerpt.truncated).toBe(true);
    expect(excerpt.text.length).toBeLessThanOrEqual(80);

    const tightened = createCodeQueries(corpus.graph, {
      loaded: corpus.loaded,
      limits: { maxExcerptLines: 5 },
    });
    const bounded = assertDefined(
      tightened.excerpt({ file: 'src/lib/station-service.ts', line: 88, endLine: 100 }),
      'the excerpt under a lowered line budget',
    );
    expect(bounded.endLine - bounded.startLine + 1).toBe(5);
    expect(bounded.truncated).toBe(true);
  });

  it('refuses an environment file, a path outside the project and a file it does not hold', () => {
    // The privacy guard of AAP 0.5.2, applied here independently of
    // `../project.ts`'s own exclusion: an environment file is never read, never
    // excerpted and therefore never promptable, whichever spelling is asked
    // for. An excerpt is the one query that returns code, so it is the one the
    // "no repository dump" rule is really about.
    for (const file of ['.env', '.env.local', '.env.production.local', 'apps/web/.env']) {
      expect(queries.excerpt({ file, line: 1 })).toBeUndefined();
    }

    for (const file of [
      '../../etc/passwd',
      '/etc/passwd',
      `${FIXTURE_ROOT}/src/lib/datastore.ts`,
      'src\\lib\\datastore.ts',
      '',
      'does/not/exist.ts',
      'node_modules/pg/index.js',
    ]) {
      expect(queries.excerpt({ file, line: 1 })).toBeUndefined();
    }

    // A `nodeId` that names no node, and a region whose file is too long to be
    // one, are the same answer.
    expect(queries.excerpt('no-such-node-id')).toBeUndefined();
    expect(
      queries.excerpt({ file: 'x'.repeat(CODE_QUERY_LIMITS.maxNameLength + 1), line: 1 }),
    ).toBeUndefined();
  });

  it('degrades to no excerpts without a loaded project, leaving every other query working', () => {
    const graphOnly = createCodeQueries(corpus.graph);
    const declaration = assertDefined(
      queries.findByName('summarizeBasin', { kinds: ['server-function'] })[0],
      'the summarizeBasin server function',
    );

    // The shape a reopened session has: a graph rebuilt from a cached index and
    // no program open. It answers everything but the one query that needs text.
    expect(graphOnly.excerpt(declaration.nodeId)).toBeUndefined();
    expect(graphOnly.excerpt({ file: 'src/lib/datastore.ts', line: 12 })).toBeUndefined();
    expect(graphOnly.findByName('GaugeReadout', { exact: true })).toHaveLength(2);
    expect(graphOnly.whoCalls('summarizeBasin')).toHaveLength(3);
    expect(graphOnly.routeForUrl('/api/gauges')?.file).toBe('app/api/gauges/route.ts');
    expect(graphOnly.componentsRendering('GaugeReadout')).toHaveLength(1);
  });

  it('cannot be talked into returning a whole file', () => {
    let largest = { file: '', lines: 0 };
    for (const sourceFile of corpus.loaded.sourceFiles()) {
      const file = corpus.loaded.projectRelative(sourceFile.getFilePath());
      if (file === undefined) {
        continue;
      }
      const lines = sourceFile.getFullText().split(LINE_BREAK).length;
      if (lines > largest.lines) {
        largest = { file, lines };
      }
    }

    expect(largest.lines).toBeGreaterThan(CODE_QUERY_LIMITS.maxExcerptLines);

    const widest = assertDefined(
      queries.excerpt(
        { file: largest.file, line: 1, endLine: 10_000 },
        { contextLines: 10_000, maxChars: 10_000_000 },
      ),
      'the widest excerpt of the largest file',
    );
    const whole = corpusLines(largest.file).join('\n');

    // Every bound is asked to be exceeded at once, and each is clamped instead.
    expect(widest.endLine - widest.startLine + 1).toBeLessThanOrEqual(
      CODE_QUERY_LIMITS.maxExcerptLines,
    );
    expect(widest.text.length).toBeLessThanOrEqual(CODE_QUERY_LIMITS.maxExcerptChars);
    expect(widest.text.length).toBeLessThan(whole.length);
    expect(widest.truncated).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Log levels: per-query outcomes at trace, defects at debug
 * ---------------------------------------------------------------------------------------------- */

/** The message `pathBetween` records a miss under. */
const PATH_MISS_LOG = 'pathBetween found no path within the bounds';

/**
 * A real shared-package logger whose sink keeps every record it is handed.
 *
 * `createConsoleLogger` rather than a hand-written recorder, so the threshold
 * filtering under test is the product's own: a record at a level below
 * `level` never reaches the sink.
 *
 * @param level The threshold.
 * @returns The logger and the records its sink received.
 */
function capturingLogger(level: LogLevelSetting): {
  readonly logger: Logger;
  readonly records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level,
    sink: (record) => {
      records.push(record);
    },
  });

  return { logger, records };
}

describe('log levels', () => {
  it('records a pathBetween miss at trace and nothing at debug', () => {
    const { logger, records } = capturingLogger('trace');
    const logged = createCodeQueries(corpus.graph, { loaded: corpus.loaded, logger });
    const layout = assertDefined(
      logged
        .findByName('ObservatoryLayout', { exact: true })
        .find((match) => match.kind === 'component'),
      'the layout component',
    );
    const component = assertDefined(
      logged
        .findByName('GaugeReadout', { exact: true })
        .find((match) => match.kind === 'component'),
      'the GaugeReadout component',
    );
    const query = corpusNode('db-call', 'prisma.gauge.findMany');

    // Three misses of three kinds — unreachable, cut by depth, cut by the node
    // budget — which is what a caller probing candidate after candidate sees.
    expect(logged.pathBetween(layout.nodeId, { kind: 'db-call' })).toBeUndefined();
    expect(logged.pathBetween(component.nodeId, query.id, { maxDepth: 4 })).toBeUndefined();
    expect(logged.pathBetween(component.nodeId, query.id, { maxNodes: 1 })).toBeUndefined();

    const misses = records.filter((record) => record.message === PATH_MISS_LOG);
    expect(misses).toHaveLength(3);
    expect(misses.map((record) => record.level)).toStrictEqual(['trace', 'trace', 'trace']);
    expect(records.filter((record) => record.level === 'debug')).toStrictEqual([]);

    // Bounds and counts only: nothing names a node, a file or a line of source.
    for (const miss of misses) {
      expect(Object.keys(miss.fields).sort()).toStrictEqual([
        'direction',
        'expanded',
        'maxDepth',
        'maxNodes',
        'sources',
        'targets',
        'truncated',
      ]);
    }
    expect(assertDefined(misses[1], 'the depth-bounded miss').fields.truncated).toBe(true);

    // A search that finds its path records nothing at all.
    records.length = 0;
    expect(logged.pathBetween(component.nodeId, query.id)).toBeDefined();
    expect(records).toStrictEqual([]);
  });

  it('emits nothing for a miss through a debug-threshold logger', () => {
    const { logger, records } = capturingLogger('debug');
    const logged = createCodeQueries(corpus.graph, { loaded: corpus.loaded, logger });
    const component = assertDefined(
      logged
        .findByName('GaugeReadout', { exact: true })
        .find((match) => match.kind === 'component'),
      'the GaugeReadout component',
    );
    const query = corpusNode('db-call', 'prisma.gauge.findMany');

    // The service's debug log is the one the misses flooded: fifty of them
    // there now write not a single line.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(logged.pathBetween(component.nodeId, query.id, { maxDepth: 1 })).toBeUndefined();
    }
    expect(records).toStrictEqual([]);
  });

  it('records the other bounded outcomes at trace: capped answers and a clamped selector', () => {
    const { logger, records } = capturingLogger('trace');
    const tight = createCodeQueries(corpus.graph, {
      loaded: corpus.loaded,
      limits: { maxResults: 1, maxCallers: 1 },
      logger,
    });

    // Three callers capped to one, two methods capped to one, and a selector
    // naming every database call clamped to one — each a well-formed query
    // answered inside its bounds. Whether the clamped search then reaches its
    // single remaining target depends on which one survived the clamp, so the
    // path itself is not the assertion; the records are.
    expect(tight.whoCalls('summarizeBasin')).toHaveLength(1);
    expect(tight.handlersFor('/api/gauges')).toHaveLength(1);
    tight.pathBetween({ name: 'summarizeBasin', kind: 'server-function' }, { kind: 'db-call' });

    const levels = new Map(records.map((record) => [record.message, record.level]));
    expect(levels.get('whoCalls result was capped')).toBe('trace');
    expect(levels.get('handlersFor result was capped')).toBe('trace');
    expect(levels.get('endpoint selector matched more nodes than the limit')).toBe('trace');
    // The one debug record is the once-per-surface route-map derivation the
    // first route query paid for, not anything a query repeats.
    expect(
      records.filter((record) => record.level === 'debug').map((record) => record.message),
    ).toStrictEqual(['derived the route map from the code graph']);
  });

  it('keeps a refused argument at debug, where a caller defect belongs', () => {
    const { logger, records } = capturingLogger('debug');
    const logged = createCodeQueries(corpus.graph, { loaded: corpus.loaded, logger });

    expect(logged.findByName(null as unknown as string)).toStrictEqual([]);
    expect(logged.whoCalls('x'.repeat(CODE_QUERY_LIMITS.maxNameLength + 1))).toStrictEqual([]);
    expect(logged.findByName('x'.repeat(CODE_QUERY_LIMITS.maxNameLength + 1))).toStrictEqual([]);

    expect(records.map((record) => `${record.level}:${record.message}`)).toStrictEqual([
      'debug:refused a query argument that is not the shape the query declares',
      'debug:rejected a name argument outside the length bound',
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Properties every query shares
 * ---------------------------------------------------------------------------------------------- */

/** One labelled result per query, so the cross-cutting group asserts over all of them at once. */
function everyResult(): Readonly<Record<string, unknown>> {
  return {
    findByName: queries.findByName('GaugeReadout'),
    findByNameExact: queries.findByName('summarizeBasin', { exact: true }),
    findSymbol: queries.findSymbol('src/lib/station-service.ts', 'summarizeBasin'),
    whoCalls: queries.whoCalls('summarizeBasin'),
    whoCallsOne: queries.whoCalls('fetchGaugeIndex'),
    routeForUrl: queries.routeForUrl('http://localhost:3000/api/gauges?take=2'),
    routeForUrlDynamic: queries.routeForUrl('/api/basins/north/upper'),
    handlersFor: queries.handlersFor('/api/gauges'),
    handlersForPage: queries.handlersFor('/'),
    componentsRendering: queries.componentsRendering('GaugeReadout'),
    pathBetween: queries.pathBetween(
      { name: 'summarizeBasin', kind: 'server-function' },
      { kind: 'db-call' },
    ),
    excerpt: queries.excerpt({ file: 'src/lib/datastore.ts', line: 12 }),
    limits: queries.limits,
  };
}

describe('every query', () => {
  it('reports only valid, project-relative, 1-based source locations', () => {
    const locations = locationsIn(everyResult());

    // Enough results to be worth asserting over, and the schema is the one
    // every boundary in the product validates a location against — the panel's
    // `sourceLink`, `TelemetryEvent.source`, the `source.open` payload.
    expect(locations.length).toBeGreaterThan(20);

    for (const location of locations) {
      const parsed = parseSourceLocation(location);
      expect(isOk(parsed)).toBe(true);
      expect(location.file.startsWith('/')).toBe(false);
      expect(location.file).not.toContain('\\');
      expect(location.file).not.toContain(FIXTURE_ROOT);
      expect(location.line).toBeGreaterThanOrEqual(1);
      expect(location.column).toBeGreaterThanOrEqual(1);
      if (location.endLine !== undefined) {
        expect(location.endLine).toBeGreaterThanOrEqual(location.line);
      }
    }
  });

  it('stamps each location with the mechanism that found it, at that mechanism’s confidence', () => {
    const locations = locationsIn(everyResult());
    const routes = new Set(locations.map((location) => location.resolvedBy));

    // Exactly two of the five resolution routes are produced here, and the
    // confidence of each is read from the shared table rather than transcribed:
    // four resolvers in three packages agree only because they all read it.
    expect([...routes].sort()).toStrictEqual(['code-graph', 'route-map']);
    for (const location of locations) {
      expect(location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[location.resolvedBy]);
    }
  });

  it('returns plain values that survive a JSON round trip', () => {
    // These results are serialised into model prompts and into the local
    // service's tool responses, so a value that does not round-trip — a class
    // instance, a function, a `Map`, a property present and `undefined` — would
    // reach a model as something other than what the query returned.
    for (const [name, value] of Object.entries(everyResult())) {
      const round: unknown = JSON.parse(JSON.stringify(value));

      expect(round, `${name} did not survive a JSON round trip`).toStrictEqual(value);
    }
  });

  it('answers a malformed argument with that query’s empty answer rather than an exception', () => {
    // Arguments arrive from a model (AAP 0.4.2), so a call that does not match
    // the declared signature is an ordinary event and never a failed session
    // (AAP 0.5.5). The casts are the point of the case: they reproduce what a
    // decoded model query can hold at runtime.
    const malformed = [undefined, null, 42, {}, [], true] as unknown[];

    for (const value of malformed) {
      expect(() => queries.findByName(value as string)).not.toThrow();
      expect(queries.findByName(value as string)).toStrictEqual([]);
      expect(queries.findSymbol(value as string, value as string)).toBeUndefined();
      expect(queries.hasSymbol(value as string, value as string)).toBe(false);
      expect(queries.whoCalls(value as string)).toStrictEqual([]);
      expect(queries.routeForUrl(value as string)).toBeUndefined();
      expect(queries.handlersFor(value as string)).toStrictEqual([]);
      expect(queries.componentsRendering(value as string)).toStrictEqual([]);
      expect(queries.pathBetween(value as string, value as string)).toBeUndefined();
      expect(queries.excerpt(value as string)).toBeUndefined();
    }
  });

  it('leaves the corpus exactly as it found it', () => {
    // The read-only evidence, and the last case in the file on purpose: every
    // group above has run by now, including the two index builds. A write
    // anywhere under the corpus — a formatter, a shim added to work around the
    // two deliberately unresolved specifiers, a ts-morph `save()` — changes a
    // size, a modification time or the file list, and the comparison catches it
    // without shelling out to git. `git status --porcelain
    // packages/code-analysis` is the same assertion from outside, and the
    // package's gates run it.
    expect(corpusFootprint()).toStrictEqual(corpusBefore);
  });
});
