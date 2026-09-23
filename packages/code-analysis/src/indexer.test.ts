/**
 * Tests for `./indexer.ts`: the pipeline that turns a target project into the
 * `CodeGraph` the rest of the product reasons over.
 *
 * This is the broadest suite in the package, because the module it covers is
 * the one that runs every other one. It is organised around the four contracts
 * the module documents, and a failing case belongs to exactly one of them:
 *
 * ## 1. The envelope — what a consumer holds after a run
 *
 * A `CodeIndex` is persisted, cached, shipped to the pipeline's read-only
 * investigation tools and compared between runs, so its shape is a contract
 * rather than an implementation detail: the declared schema and indexer
 * versions, one fingerprint per indexed file in byte-wise path order, unique
 * node and edge identities, every node's `file` a safe project-relative POSIX
 * path, every edge endpoint naming a node that is actually present, and two
 * runs over unchanged source agreeing byte for byte but for the one clock
 * reading. The node and edge coverage groups assert the *content* of that
 * envelope against the corpus, kind by kind.
 *
 * ## 2. The cache — an optimisation that may never change an answer
 *
 * A hit must return the index a build would have produced and must cost no
 * program: that is asserted through the public cache interface rather than by
 * inspecting entry files. A changed file must miss. An entry an earlier
 * indexer or an earlier vocabulary wrote must be ignored. A cache that cannot
 * be written to must not fail an index, because failing to cache an index is
 * not failing to build one.
 *
 * ## 3. Degradation — a partial graph beats a failed stage
 *
 * AAP 0.5.5's graceful-failure rule applied to indexing: an extractor that
 * throws on one file costs that contribution and nothing else, a contribution
 * whose `file` is not a safe project-relative path is dropped rather than
 * stored, a file that vanished mid-run is skipped, a project with nothing
 * indexable in it is an empty index rather than an error — and each of those is
 * *reported* in `stats.diagnostics`, which is what makes a partial index honest
 * instead of merely smaller. The only failures are the ones that leave nothing
 * to index: an unopenable project and a cancelled run.
 *
 * ## 4. Laziness — the build never asks the type checker for references
 *
 * `findReferences` forces type resolution across the whole program and is the
 * single most expensive operation ts-morph offers, so the build may not perform
 * it: the static `calls` and `references` edges are the primary signal and
 * `createReferenceResolver` is the on-demand deepening. That is asserted by
 * spying on the language service the project would have to go through, and
 * expecting zero calls during a whole index — then proving the resolver itself
 * answers, memoises, and reports nothing rather than throwing for a symbol that
 * is not there.
 *
 * ## Three habits, each deliberate
 *
 * - **The committed corpus is read, never written.** The assertion-heavy groups
 *   index `test/fixtures/sample-next-app` where it lives, which is exactly what
 *   a consumer does with a developer's project, so a run leaves `git status`
 *   unchanged. Every case that has to *touch* a file — the fingerprint
 *   invalidation, the deleted file, the unwritable cache directory — copies the
 *   corpus into a `mkdtemp` sandbox first, and every sandbox is removed in
 *   `afterEach` even when the case failed.
 * - **The corpus is indexed once and reused.** Constructing the ts-morph
 *   program is what indexing actually costs, so the groups that only read the
 *   result share one `beforeAll` run instead of paying for it per case. Cases
 *   that need their own options index again, and carry an explicit timeout
 *   because a real program build legitimately exceeds Vitest's 5 s default on a
 *   loaded machine.
 * - **The corpus' numbers are asserted, not derived.** Exactly three `fetch`
 *   call sites, exactly three unresolvable external specifiers, exactly three
 *   callers of the one multi-caller server function, one barrel carrying one
 *   re-export edge of each of the four kinds, database access confined to one
 *   module covering both drivers, one client module and one server component.
 *   A derived expectation agrees with whatever the implementation does,
 *   including dropping a file; these literals do not. If an assertion here
 *   disagrees with the corpus, the extractor changed, not the fixture.
 *
 * Nothing in this file indexes the repository itself or anything under
 * `node_modules`, and no case writes inside the checkout.
 */

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEBUGGEN_ERROR_CODES,
  DEFAULT_RESOLUTION_CONFIDENCE,
  isErr,
  isSafeRelativePath,
  toPosix,
} from '@debuggen/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { computeIndexCacheKey, createIndexCache } from './cache.js';
import { CodeGraph } from './graph/graph.js';
import { CODE_INDEX_SCHEMA_VERSION } from './graph/types.js';
import {
  DEFAULT_EXTRACTORS,
  INDEXER_VERSION,
  buildIndex,
  computeFileFingerprints,
  createReferenceResolver,
  indexProject,
} from './indexer.js';
import { openProject } from './project.js';

import type {
  CodeIndex,
  CodeNodeKind,
  CodeNodeOf,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
  IndexDiagnosticCode,
} from './graph/types.js';
import type { IndexProjectOptions, IndexResult } from './indexer.js';
import type { LoadedProject } from './project.js';

/*
 * ---------------------------------------------------------------------------
 * The corpus
 * ---------------------------------------------------------------------------
 */

/**
 * The read-only indexing corpus: a generic Next.js application that exists to
 * be indexed.
 *
 * Resolved from this module's own URL rather than from `process.cwd()`, so the
 * suite finds it whether Vitest was started from the repository root or from
 * the workspace.
 */
const FIXTURE_ROOT = fileURLToPath(new URL('../test/fixtures/sample-next-app', import.meta.url));

/**
 * Every indexable file of the corpus, project-relative, in the byte-wise order
 * the index's `files` array must carry them in.
 *
 * Written out in full rather than derived from a directory walk: a derived
 * expectation agrees with an implementation that silently dropped a file, and
 * this list is also what `stats.fileCount` is checked against. One case below
 * proves the literal is in sorted order rather than trusting that it was typed
 * that way.
 */
const EXPECTED_FIXTURE_FILES: readonly string[] = [
  'app/(observatory)/api/basins/[...segments]/route.ts',
  'app/(observatory)/basins/[id]/page.tsx',
  'app/api/gauges/[id]/route.ts',
  'app/api/gauges/route.ts',
  'app/layout.tsx',
  'app/page.tsx',
  'next.config.mjs',
  'pages/api/gauge-log.ts',
  'src/lib/datastore.ts',
  'src/lib/http.ts',
  'src/lib/station-service.ts',
  'src/lib/stubs/pg.ts',
  'src/lib/stubs/prisma-client.ts',
  'src/widgets/BasinSummary.tsx',
  'src/widgets/GaugeReadout.tsx',
  'src/widgets/index.ts',
];

/** The corpus' service module: the one module that reaches the database. */
const SERVICE_MODULE = 'src/lib/station-service.ts';

/** The corpus' only client module, and its only barrel. */
const CLIENT_MODULE = 'src/widgets/GaugeReadout.tsx';

/** The corpus' only barrel, which re-exports and declares nothing. */
const BARREL_MODULE = 'src/widgets/index.ts';

/**
 * A generous per-case budget for a case that builds its own program.
 *
 * The `code-analysis` Vitest project takes the 5 s default, which a real
 * ts-morph program build plus a full extraction pass can exceed on a machine
 * running the rest of the suite beside it. Generous rather than unbounded: a
 * genuinely hung run still fails.
 */
const INDEX_TIMEOUT_MS = 60_000;

/**
 * The timestamp every index is normalised to before two of them are compared.
 *
 * `CodeIndex.generatedAt` is a clock reading and the module's single
 * time-varying field, so the determinism assertion replaces it explicitly
 * instead of excluding it — an ignored field is a field that could start
 * carrying something else without any case noticing.
 */
const FIXED_GENERATED_AT = 1_700_000_000_000;

/*
 * ---------------------------------------------------------------------------
 * Sandboxes
 * ---------------------------------------------------------------------------
 */

/** Every sandbox the current case created, removed in `afterEach`. */
const sandboxes: string[] = [];

/**
 * An empty, absolute, symlink-free temporary directory, registered for removal.
 *
 * `realpath` matters for the same reason it matters in `./project.ts`: a
 * temporary directory reached through a link would make every sandboxed project
 * a "symlinked root" project and would change which paths the containment
 * screen resolves.
 */
function makeSandbox(prefix: string): string {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  sandboxes.push(sandbox);
  return sandbox;
}

/** Copies the corpus into a sandbox and returns the copy's root. */
function copyCorpusInto(sandbox: string, name: string): string {
  const root = join(sandbox, name);
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();

  while (sandboxes.length > 0) {
    const sandbox = sandboxes.pop();
    if (sandbox !== undefined) {
      // `force` so teardown cannot fail a passing case, and so a case that
      // tightened a directory's permissions is still cleaned up.
      chmodSync(sandbox, 0o700);
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
});

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Indexes and unwraps, failing the case with the reported code when the run
 * reported one.
 *
 * Every case that asserts on an index wants the index; a case that asserts on a
 * *failure* calls `indexProject` directly and inspects the `Err`.
 */
async function indexOrThrow(options: IndexProjectOptions): Promise<IndexResult> {
  const indexed = await indexProject(options);

  if (isErr(indexed)) {
    throw new Error(`indexProject reported ${indexed.error.code}: ${indexed.error.message}`);
  }

  return indexed.value;
}

/** Opens a project and unwraps, failing the case with the reported code. */
function openOrThrow(projectRoot: string): LoadedProject {
  const opened = openProject({ projectRoot });

  if (isErr(opened)) {
    throw new Error(`openProject reported ${opened.error.code}: ${opened.error.message}`);
  }

  return opened.value;
}

/** An index with its one time-varying field replaced, ready to be compared. */
function withFixedTimestamp(index: CodeIndex): CodeIndex {
  // Spreading and then overriding an existing key preserves that key's
  // position, so the serialised form stays byte-comparable with another index's.
  return { ...index, generatedAt: FIXED_GENERATED_AT };
}

/** The serialised form two runs must agree on, with the clock reading removed. */
function canonicalJson(index: CodeIndex): string {
  return JSON.stringify(withFixedTimestamp(index));
}

/**
 * The cache key `indexProject` will compute for a project indexed with the
 * default extractors.
 *
 * Derived through the same public functions the module uses — the project's own
 * normalised root and configuration, {@link INDEXER_VERSION}, the extractor
 * identities in run order and {@link computeFileFingerprints} — so a case can
 * plant an entry the module will actually look for. Every cache case that
 * plants one also proves the key agreed, by indexing once more and expecting
 * the hit.
 */
async function cacheKeyFor(loaded: LoadedProject): Promise<string> {
  return computeIndexCacheKey({
    projectRoot: loaded.projectRoot,
    tsConfigFilePath: loaded.tsConfigFilePath,
    indexerVersion: INDEXER_VERSION,
    extractors: DEFAULT_EXTRACTORS.map((extractor) => extractor.id),
    files: await computeFileFingerprints(loaded),
  });
}

/** The diagnostics of one code, in the order they were reported. */
function diagnosticsOf(
  diagnostics: readonly IndexDiagnostic[],
  code: IndexDiagnosticCode,
): readonly IndexDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.code === code);
}

/**
 * The single member of a list, failing the case with the count when there is
 * not exactly one.
 *
 * Used wherever the corpus' shape says "exactly one": a bare index access would
 * report `undefined` at the first property read instead of naming what was
 * actually found.
 */
function exactlyOne<T>(values: readonly T[], description: string): T {
  const [first, ...rest] = values;

  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one ${description}, found ${String(values.length)}`);
  }

  return first;
}

/** The one node of a kind that satisfies `predicate`, failing the case otherwise. */
function requireNode<K extends CodeNodeKind>(
  graph: CodeGraph,
  kind: K,
  description: string,
  predicate: (node: CodeNodeOf<K>) => boolean,
): CodeNodeOf<K> {
  return exactlyOne(graph.nodesByKind(kind).filter(predicate), `${kind} node (${description})`);
}

/**
 * An extractor that contributes nothing, or whatever a case hands it.
 *
 * Declared through the {@link Extractor} interface rather than as an object
 * literal at each call site, so every injected extractor of this file is
 * type-checked against the real contract the pipeline calls.
 */
function makeExtractor(id: string, extract: (ctx: ExtractorContext) => ExtractorResult): Extractor {
  return { id, extract };
}

/** The `file` of every node an index holds, as a sorted list of unique paths. */
function filesWithNodes(index: CodeIndex): readonly string[] {
  return [...new Set(index.nodes.map((node) => node.file))].sort();
}

/*
 * ---------------------------------------------------------------------------
 * The shared run
 * ---------------------------------------------------------------------------
 */

/**
 * The corpus indexed once, with no cache, for every group that only reads the
 * result.
 *
 * Held through an accessor rather than a definitely-assigned variable so that a
 * case reached without the hook having run fails with a sentence instead of
 * with a property read on `undefined`.
 */
let sharedRun: IndexResult | undefined;

/** The shared run, or a failure naming why there isn't one. */
function baseline(): IndexResult {
  if (sharedRun === undefined) {
    throw new Error('the corpus was not indexed: the beforeAll hook did not complete');
  }

  return sharedRun;
}

beforeAll(async () => {
  sharedRun = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache: false });
}, INDEX_TIMEOUT_MS);

/*
 * ---------------------------------------------------------------------------
 * 1. The envelope
 * ---------------------------------------------------------------------------
 */

describe('the index envelope', () => {
  it('indexes every file of the corpus and reports a clean run', () => {
    const { index, stats, fromCache } = baseline();

    expect(fromCache).toBe(false);
    expect(stats.fileCount).toBe(EXPECTED_FIXTURE_FILES.length);
    expect(stats.skippedFiles).toBe(0);

    // A clean run over a corpus whose dependencies are deliberately not
    // installed: an unresolvable specifier costs an edge, never a diagnostic.
    expect(stats.diagnostics).toEqual([]);
    expect(index.files.map((fingerprint) => fingerprint.file)).toEqual([...EXPECTED_FIXTURE_FILES]);
  });

  it('lists the corpus files in byte-wise path order', () => {
    // Proves the literal above is in the order the module sorts by, rather than
    // trusting that it was typed that way — every `files` assertion and the
    // cache key's input depend on it.
    expect([...EXPECTED_FIXTURE_FILES].sort()).toEqual([...EXPECTED_FIXTURE_FILES]);
    expect(baseline().index.files.map((fingerprint) => fingerprint.file)).toEqual(
      [...EXPECTED_FIXTURE_FILES].sort(),
    );
  });

  it('declares the vocabulary version, the indexer version and the normalised project root', () => {
    const { index } = baseline();

    expect(index.schemaVersion).toBe(CODE_INDEX_SCHEMA_VERSION);
    expect(index.indexerVersion).toBe(INDEXER_VERSION);
    expect(index.projectRoot).toBe(toPosix(FIXTURE_ROOT));
    expect(index.generatedAt).toBeGreaterThan(0);
    expect(Number.isInteger(index.generatedAt)).toBe(true);
  });

  it('omits the diagnostics field entirely for a run that found nothing to report', () => {
    // Not "present and empty": the envelope is plain JSON compared byte for
    // byte between runs and round-tripped through graph construction, so an
    // absent finding is an absent key.
    expect(Object.keys(baseline().index)).toEqual([
      'schemaVersion',
      'projectRoot',
      'indexerVersion',
      'generatedAt',
      'nodes',
      'edges',
      'files',
    ]);
  });

  it('reports statistics that agree with the envelope it returned', () => {
    const { index, stats } = baseline();

    expect(stats.nodeCount).toBe(index.nodes.length);
    expect(stats.edgeCount).toBe(index.edges.length);
    expect(stats.durationMs).toBeGreaterThan(0);
    expect(Object.keys(stats.extractorDurations).sort()).toEqual(
      DEFAULT_EXTRACTORS.map((extractor) => extractor.id).sort(),
    );

    for (const duration of Object.values(stats.extractorDurations)) {
      expect(duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('claims no node or edge identity twice', () => {
    const { index } = baseline();

    expect(new Set(index.nodes.map((node) => node.id)).size).toBe(index.nodes.length);
    expect(new Set(index.edges.map((edge) => edge.id)).size).toBe(index.edges.length);
  });

  it('spells every node file as a safe project-relative path inside the corpus', () => {
    const { index } = baseline();

    for (const node of index.nodes) {
      expect(isSafeRelativePath(node.file)).toBe(true);
      expect(node.file).not.toContain('\\');
      expect(EXPECTED_FIXTURE_FILES).toContain(node.file);
      expect(node.line).toBeGreaterThan(0);
      expect(node.column).toBeGreaterThan(0);
    }

    // Every source file contributed at least its own `file` node, so the set of
    // files that carry nodes is the indexed set itself.
    expect(filesWithNodes(index)).toEqual([...EXPECTED_FIXTURE_FILES]);
  });

  it('leaves no edge pointing at a node the index does not hold', () => {
    const { index } = baseline();
    const ids = new Set(index.nodes.map((node) => node.id));

    for (const edge of index.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);

      if (edge.file !== undefined) {
        expect(isSafeRelativePath(edge.file)).toBe(true);
      }
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * 2. Fingerprints
 * ---------------------------------------------------------------------------
 */

describe('computeFileFingerprints', () => {
  it(
    'fingerprints every indexable file once, in path order, with real metadata',
    async () => {
      const loaded = openOrThrow(FIXTURE_ROOT);
      const fingerprints = await computeFileFingerprints(loaded);

      expect(fingerprints.map((fingerprint) => fingerprint.file)).toEqual([
        ...EXPECTED_FIXTURE_FILES,
      ]);

      for (const fingerprint of fingerprints) {
        expect(fingerprint.size).toBeGreaterThan(0);
        expect(fingerprint.mtimeMs).toBeGreaterThan(0);

        // Metadata-only is the default: a digest costs a full read of every
        // file, and its presence changes the cache key.
        expect(fingerprint.hash).toBeUndefined();
      }
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'adds a stable content digest when hashing was asked for',
    async () => {
      const loaded = openOrThrow(FIXTURE_ROOT);

      const first = await computeFileFingerprints(loaded, { hashContents: true });
      const second = await computeFileFingerprints(loaded, { hashContents: true });

      expect(first.map((fingerprint) => fingerprint.file)).toEqual([...EXPECTED_FIXTURE_FILES]);

      for (const fingerprint of first) {
        expect(fingerprint.hash).toMatch(/^[0-9a-f]{64}$/u);
      }

      // Hashing the same tree twice answers the same way, which is the whole
      // reason the digest is an alternative invalidation key.
      expect(second.map((fingerprint) => fingerprint.hash)).toEqual(
        first.map((fingerprint) => fingerprint.hash),
      );
    },
    INDEX_TIMEOUT_MS,
  );
});

/*
 * ---------------------------------------------------------------------------
 * 3. Node coverage
 * ---------------------------------------------------------------------------
 *
 * One case per node kind, each asserting a count the corpus fixes and at least
 * one concrete specimen. A kind that stopped being extracted, or started being
 * extracted twice, fails here rather than in a downstream package that merely
 * finds the graph emptier than it expected.
 */

describe('node coverage against the corpus', () => {
  it('records one file node per source file, with the corpus one client module', () => {
    const { graph } = baseline();
    const files = graph.nodesByKind('file');

    expect(files.map((node) => node.file).sort()).toEqual([...EXPECTED_FIXTURE_FILES]);

    // Exactly one module carries the `"use client"` directive; every other
    // module of the corpus is deliberately without it.
    expect(
      files.filter((node) => node.data?.isClientModule === true).map((node) => node.file),
    ).toEqual([CLIENT_MODULE]);

    const barrel = requireNode(graph, 'file', BARREL_MODULE, (node) => node.file === BARREL_MODULE);
    expect(barrel.data?.extension).toBe('.ts');
    expect(barrel.data?.isClientModule).toBe(false);
  });

  it('records the corpus three unresolvable specifiers on the files that name them', () => {
    const { graph } = baseline();

    // Nothing in the corpus is installed, so a specifier naming a package
    // resolves to nothing. The pipeline is syntax-tree-first precisely so that
    // this is a record on the importing file rather than a failure.
    const external = graph
      .nodesByKind('file')
      .flatMap((node) =>
        (node.data?.externalImports ?? []).map((ref) => `${node.file} ${ref.specifier}`),
      )
      .sort();

    expect(external).toEqual([
      'pages/api/gauge-log.ts next',
      'src/lib/http.ts next/server',
      `${CLIENT_MODULE} react`,
    ]);
  });

  it('records symbol nodes for declarations and none for the barrel that only re-exports', () => {
    const { graph } = baseline();
    const symbols = graph.nodesByKind('symbol');

    expect(
      symbols
        .filter((node) => node.file === SERVICE_MODULE)
        .map((node) => node.name)
        .sort(),
    ).toEqual([
      'BasinDriftRow',
      'GaugeReadingInput',
      'listBasinGauges',
      'recordGaugeReading',
      'summarizeBasin',
    ]);

    const exported = requireNode(
      graph,
      'symbol',
      'summarizeBasin',
      (node) => node.file === SERVICE_MODULE && node.name === 'summarizeBasin',
    );
    expect(exported.exported).toBe(true);
    expect(exported.data?.declaration).toBe('function');
    expect(exported.data?.isDefaultExport).toBe(false);

    // The barrel declares nothing at all: its worth is its four re-export
    // statements, which are edges rather than declarations.
    expect(symbols.filter((node) => node.file === BARREL_MODULE)).toEqual([]);
  });

  it('distinguishes the client component from the server component', () => {
    const { graph } = baseline();
    const components = graph.nodesByKind('component');

    const gaugeReadout = requireNode(
      graph,
      'component',
      'GaugeReadout',
      (node) => node.name === 'GaugeReadout',
    );
    expect(gaugeReadout.file).toBe(CLIENT_MODULE);
    expect(gaugeReadout.data.isClient).toBe(true);
    expect(gaugeReadout.data.displayName).toBe('GaugeReadout');
    expect(gaugeReadout.data.isDefaultExport).toBe(false);

    const basinSummary = requireNode(
      graph,
      'component',
      'BasinSummary',
      (node) => node.name === 'BasinSummary',
    );
    expect(basinSummary.file).toBe('src/widgets/BasinSummary.tsx');
    expect(basinSummary.data.isClient).toBe(false);
    expect(basinSummary.data.isDefaultExport).toBe(true);

    // The directive is a property of the module, so the split is exactly the
    // client module against the rest of the corpus.
    for (const component of components) {
      expect(component.data.isClient).toBe(component.file === CLIENT_MODULE);
    }

    // A component declared through a higher-order call records the function
    // that implements it, which is how a memoised component stays traceable.
    const memoised = requireNode(
      graph,
      'component',
      'GaugeTrend',
      (node) => node.name === 'GaugeTrend',
    );
    expect(memoised.data.implementation).toBe('GaugeTrendBody');
  });

  it('records the named click handler bound through a JSX attribute', () => {
    const { graph } = baseline();
    const handler = exactlyOne(graph.nodesByKind('handler'), 'handler node');

    expect(handler.name).toBe('handleReadoutClick');
    expect(handler.file).toBe(CLIENT_MODULE);
    expect(handler.symbol).toBe('handleReadoutClick');
    expect(handler.data).toEqual({ event: 'click', boundTo: 'button', inline: false });
  });

  it('records the corpus three fetch call sites without de-duplicating the repeated route', () => {
    const { graph } = baseline();
    const calls = graph.nodesByKind('api-call');

    expect(calls).toHaveLength(3);

    const literal = calls.filter((node) => !node.data.dynamic);
    expect(literal).toHaveLength(2);

    // The same literal route is fetched from two places, and both are recorded:
    // duplicate-request analysis is about call *sites*, so collapsing them here
    // would delete the very thing it needs.
    expect(literal.map((node) => `${node.file}:${String(node.line)}`).sort()).toEqual([
      'src/lib/http.ts:28',
      `${CLIENT_MODULE}:41`,
    ]);
    for (const node of literal) {
      expect(node.data.url).toBe('/api/gauges');
      expect(node.data.method).toBe('GET');
      expect(node.data.urlExpression).toBeUndefined();
    }

    // The template-literal URL cannot be known statically, so it is flagged
    // rather than guessed at, and the expression is kept for display.
    const dynamic = exactlyOne(
      calls.filter((node) => node.data.dynamic),
      'dynamic api-call node',
    );
    expect(dynamic.file).toBe(CLIENT_MODULE);
    expect(dynamic.data.url).toBeUndefined();
    expect(dynamic.data.urlExpression).toContain('${gaugeId}');
  });

  it('records api-route nodes for both routers', () => {
    const { graph } = baseline();
    const routes = graph.nodesByKind('api-route');

    expect(
      routes.map((node) => `${node.data.router} ${node.data.kind} ${node.data.routePath}`).sort(),
    ).toEqual([
      'app page /',
      'app page /basins/[id]',
      'app route-handler /api/basins/[...segments]',
      'app route-handler /api/gauges',
      'app route-handler /api/gauges/[id]',
      'pages route-handler /api/gauge-log',
    ]);

    // The App Router module that exports two methods records both of them, in
    // the canonical method order rather than in source order.
    const gauges = requireNode(
      graph,
      'api-route',
      '/api/gauges',
      (node) => node.data.routePath === '/api/gauges',
    );
    expect(gauges.file).toBe('app/api/gauges/route.ts');
    expect(gauges.data.methods).toEqual(['GET', 'POST']);

    // The Pages Router module default-exports one handler for every method.
    const pagesRoute = requireNode(
      graph,
      'api-route',
      'the Pages Router handler',
      (node) => node.data.router === 'pages',
    );
    expect(pagesRoute.file).toBe('pages/api/gauge-log.ts');
    expect(pagesRoute.data.methods).toEqual(['ANY']);
  });

  it('records the service module three exported async functions', () => {
    const { graph } = baseline();
    const functions = graph.nodesByKind('server-function').filter((node) => {
      return node.file === SERVICE_MODULE;
    });

    expect(functions.map((node) => node.name).sort()).toEqual([
      'listBasinGauges',
      'recordGaugeReading',
      'summarizeBasin',
    ]);

    for (const node of functions) {
      expect(node.data.isAsync).toBe(true);
      expect(node.data.exported).toBe(true);
      expect(node.exported).toBe(true);
      expect(node.endLine ?? 0).toBeGreaterThan(node.line);
    }
  });

  it('records database calls for both drivers, including the borrowed client', () => {
    const { graph } = baseline();
    const calls = graph.nodesByKind('db-call');

    // Database access is confined to one module in the corpus, which is what
    // makes the driver split assertable without ambiguity.
    expect(new Set(calls.map((node) => node.file))).toEqual(new Set([SERVICE_MODULE]));
    expect(calls).toHaveLength(4);

    const prisma = calls.filter((node) => node.data.driver === 'prisma');
    expect(
      prisma.map((node) => `${node.data.model ?? '?'}.${node.data.operation ?? '?'}`).sort(),
    ).toEqual(['gauge.findMany', 'reading.create']);

    // The two `pg` shapes the corpus covers: a query on the pool itself, and one
    // on a client borrowed from it — each recording the driver it was found for.
    const pg = calls.filter((node) => node.data.driver === 'pg');
    expect(pg.map((node) => node.name).sort()).toEqual(['client.query', 'pool.query']);

    const poolQuery = requireNode(
      graph,
      'db-call',
      'pool.query',
      (node) => node.name === 'pool.query',
    );
    expect(poolQuery.data.operation).toBe('select');
    expect(poolQuery.data.dynamic).toBe(false);

    // The statement is kept in its parameterised form, with placeholders and no
    // inline literal, which is what the privacy model allows to be stored.
    expect(poolQuery.data.statementShape).toContain('$1');
    expect(poolQuery.data.statementShape).toContain('FROM station_gauges');

    const clientQuery = requireNode(
      graph,
      'db-call',
      'client.query',
      (node) => node.name === 'client.query',
    );
    expect(clientQuery.data.operation).toBe('update');
    expect(clientQuery.data.model).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * 4. Edge coverage
 * ---------------------------------------------------------------------------
 *
 * Edges are where the extractors' independent contributions become one graph:
 * no extractor reads another's output, so an edge one of them emitted finds the
 * node another emitted only because the identity functions agree. These cases
 * assert that agreement on the paths an investigation actually walks — alias to
 * barrel to module, component to component, handler to helper, route handler to
 * service function, service function to database.
 */

describe('edge coverage against the corpus', () => {
  it('follows the alias through the barrel to the module the default re-export names', () => {
    const { graph } = baseline();

    const page = requireNode(graph, 'file', 'app/page.tsx', (node) => node.file === 'app/page.tsx');
    const barrel = requireNode(graph, 'file', BARREL_MODULE, (node) => node.file === BARREL_MODULE);

    // First hop: the `@/…` alias resolves through the target's own `paths`
    // configuration, which is the reason the configuration is part of the cache
    // key at all.
    const aliased = exactlyOne(graph.outgoing(page.id, 'imports'), 'import edge of app/page.tsx');
    expect(aliased.to).toBe(barrel.id);
    expect(aliased.specifier).toBe('@/widgets');
    expect(aliased.file).toBe('app/page.tsx');

    // Second hop: three of the barrel's statements name './BasinSummary', so the
    // default-as one is identified by the line it was written on. It leads to
    // the module that declares the component the page renders, which closes the
    // chain `@/widgets` → barrel → `BasinSummary.tsx`.
    const defaultReExport = exactlyOne(
      graph.outgoing(barrel.id, 'exports').filter((edge) => edge.line === 19),
      'default-as re-export edge of the barrel',
    );
    expect(defaultReExport.specifier).toBe('./BasinSummary');
    expect(graph.nodeById(defaultReExport.to)?.file).toBe('src/widgets/BasinSummary.tsx');

    const rendered = requireNode(
      graph,
      'component',
      'BasinSummary',
      (node) => node.name === 'BasinSummary',
    );
    expect(rendered.file).toBe('src/widgets/BasinSummary.tsx');
    expect(
      graph
        .incoming(rendered.id, 'renders')
        .map((edge) => graph.nodeById(edge.from)?.file ?? 'missing'),
    ).toEqual(['app/page.tsx']);
  });

  it('records one re-export edge per statement of the barrel four re-export kinds', () => {
    const { graph } = baseline();
    const barrel = requireNode(graph, 'file', BARREL_MODULE, (node) => node.file === BARREL_MODULE);

    const reExports = graph.outgoing(barrel.id, 'exports');
    expect(reExports).toHaveLength(4);

    // One edge per statement — star, named, type-only and default-as — each
    // identified by the line it was written on and the module it names. The
    // forms differ in syntax and not in edge kind, which is why the count and
    // the targets are what this asserts.
    expect(
      reExports
        .map((edge) => {
          const target = graph.nodeById(edge.to);
          return `${String(edge.line)} ${edge.specifier ?? '?'} ${target?.file ?? 'missing'}`;
        })
        .sort(),
    ).toEqual([
      '16 ./GaugeReadout src/widgets/GaugeReadout.tsx',
      '17 ./BasinSummary src/widgets/BasinSummary.tsx',
      '18 ./BasinSummary src/widgets/BasinSummary.tsx',
      '19 ./BasinSummary src/widgets/BasinSummary.tsx',
    ]);

    // The end of the alias chain: the module the default-as form names is the
    // one whose default export is the component.
    const defaultReExport = exactlyOne(
      reExports.filter((edge) => edge.line === 19),
      'default-as re-export edge',
    );
    const target = graph.nodeById(defaultReExport.to);
    expect(target?.kind).toBe('file');

    const basinSummary = requireNode(
      graph,
      'component',
      'BasinSummary',
      (node) => node.name === 'BasinSummary',
    );
    expect(basinSummary.data.isDefaultExport).toBe(true);
    expect(basinSummary.file).toBe(target?.file);
  });

  it('records the render edge from the server component to the client component', () => {
    const { graph } = baseline();

    const basinSummary = requireNode(
      graph,
      'component',
      'BasinSummary',
      (node) => node.name === 'BasinSummary',
    );
    const gaugeReadout = requireNode(
      graph,
      'component',
      'GaugeReadout',
      (node) => node.name === 'GaugeReadout',
    );

    const rendered = graph.outgoing(basinSummary.id, 'renders');
    expect(rendered.map((edge) => edge.to)).toEqual([gaugeReadout.id]);

    // The boundary this edge crosses is the one that matters to an
    // investigation: a server component rendering a client component is where
    // browser-side work starts.
    expect(basinSummary.data.isClient).toBe(false);
    expect(gaugeReadout.data.isClient).toBe(true);
  });

  it('records the handler call edges to its helper and to its two fetch sites', () => {
    const { graph } = baseline();
    const handler = exactlyOne(graph.nodesByKind('handler'), 'handler node');

    const called = graph
      .outgoing(handler.id, 'calls')
      .map((edge) => graph.nodeById(edge.to))
      .map((node) => `${node?.kind ?? '?'} ${node?.name ?? '?'}`)
      .sort();

    expect(called).toEqual(['api-call fetch', 'api-call fetch', 'server-function fetchGaugeIndex']);

    // The component that binds the handler is the other half of the same chain.
    const gaugeReadout = requireNode(
      graph,
      'component',
      'GaugeReadout',
      (node) => node.name === 'GaugeReadout',
    );
    expect(graph.outgoing(gaugeReadout.id, 'handles').map((edge) => edge.to)).toEqual([handler.id]);
  });

  it('records the call edges from route handlers to the server functions they delegate to', () => {
    const { graph } = baseline();
    const gauges = requireNode(
      graph,
      'api-route',
      '/api/gauges',
      (node) => node.data.routePath === '/api/gauges',
    );

    // The module exports two methods and each delegates to a different service
    // function, so the route node carries both call edges.
    expect(
      graph
        .outgoing(gauges.id, 'calls')
        .map((edge) => graph.nodeById(edge.to))
        .map((node) => `${node?.kind ?? '?'} ${node?.name ?? '?'}`)
        .sort(),
    ).toEqual(['server-function listBasinGauges', 'server-function recordGaugeReading']);
  });

  it('records exactly three callers for the corpus multi-caller server function', () => {
    const { graph } = baseline();
    const summarize = requireNode(
      graph,
      'server-function',
      'summarizeBasin',
      (node) => node.name === 'summarizeBasin',
    );

    const callers = graph.incoming(summarize.id, 'calls').map((edge) => graph.nodeById(edge.from));

    // Three callers across three shapes — an App Router handler, a Pages Router
    // handler and a server component — which is what makes `whoCalls` worth
    // asking about this symbol rather than about any other.
    expect(callers).toHaveLength(3);
    expect(callers.map((node) => `${node?.kind ?? '?'} ${node?.file ?? '?'}`).sort()).toEqual([
      'api-route app/(observatory)/api/basins/[...segments]/route.ts',
      'api-route pages/api/gauge-log.ts',
      'component app/(observatory)/basins/[id]/page.tsx',
    ]);
  });

  it('records a query edge from every server function to the database call it makes', () => {
    const { graph } = baseline();

    const queries = graph.edges().filter((edge) => edge.kind === 'queries');
    expect(queries).toHaveLength(4);

    expect(
      queries
        .map((edge) => {
          const from = graph.nodeById(edge.from);
          const to = graph.nodeById(edge.to);
          return `${from?.name ?? '?'} -> ${to?.name ?? '?'}`;
        })
        .sort(),
    ).toEqual([
      'listBasinGauges -> prisma.gauge.findMany',
      'recordGaugeReading -> client.query',
      'recordGaugeReading -> prisma.reading.create',
      'summarizeBasin -> pool.query',
    ]);

    // Every query edge starts at a server function, which is what lets a slow
    // SQL span be attributed to the function that issued it.
    for (const edge of queries) {
      expect(graph.nodeById(edge.from)?.kind).toBe('server-function');
      expect(graph.nodeById(edge.to)?.kind).toBe('db-call');
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * 5. The route map that rides along
 * ---------------------------------------------------------------------------
 */

describe('the route map a run returns', () => {
  it('resolves a URL from each of the corpus two routers', () => {
    const { routeMap } = baseline();

    expect(routeMap.entries).toHaveLength(6);

    const appRoute = routeMap.resolve('/api/gauges', 'POST');
    expect(appRoute?.entry.file).toBe('app/api/gauges/route.ts');
    expect(appRoute?.entry.router).toBe('app');

    const pagesRoute = routeMap.resolve('http://127.0.0.1:3000/api/gauge-log?basinId=upper', 'GET');
    expect(pagesRoute?.entry.file).toBe('pages/api/gauge-log.ts');
    expect(pagesRoute?.entry.router).toBe('pages');

    // A dynamic segment resolves and captures, which is how a captured request
    // URL reaches the module that served it.
    const dynamic = routeMap.resolve('/api/gauges/gauge-north', 'GET');
    expect(dynamic?.entry.file).toBe('app/api/gauges/[id]/route.ts');
    expect(dynamic?.params).toEqual({ id: 'gauge-north' });

    expect(routeMap.resolve('/no/such/route')).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * 6. Determinism and the round trip
 * ---------------------------------------------------------------------------
 */

describe('determinism', () => {
  it(
    'produces byte-identical output for two independent runs over unchanged source',
    async () => {
      const first = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache: false });
      const second = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache: false });

      // `generatedAt` is the module's single time-varying field and is replaced
      // explicitly rather than excluded, so a second time-varying field would
      // fail this case instead of hiding behind an ignored one.
      expect(canonicalJson(second.index)).toBe(canonicalJson(first.index));
      expect(second.index.generatedAt).toBeGreaterThanOrEqual(first.index.generatedAt);
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'is a fixed point of graph construction',
    () => {
      const { index } = baseline();
      const rebuilt = CodeGraph.fromIndex(index).toIndex();

      expect(rebuilt).toEqual(index);
      expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(index));

      // The envelope a caller holds is always `graph.toIndex()`, so a second
      // round trip has nothing left to normalise.
      expect(JSON.stringify(CodeGraph.fromIndex(rebuilt).toIndex())).toBe(JSON.stringify(index));
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'answers the same over a project handle the caller supplied',
    async () => {
      const loaded = openOrThrow(FIXTURE_ROOT);

      const built = await buildIndex(loaded);
      if (isErr(built)) {
        throw new Error(`buildIndex reported ${built.error.code}`);
      }

      const viaOptions = await indexOrThrow({
        projectRoot: FIXTURE_ROOT,
        loaded,
        cache: false,
      });

      // The cache-free core and the whole pipeline over the same handle are the
      // same answer, which is what makes a behaviour proved on one hold on the
      // other.
      expect(canonicalJson(built.value)).toBe(canonicalJson(viaOptions.index));
      expect(canonicalJson(built.value)).toBe(canonicalJson(baseline().index));
    },
    INDEX_TIMEOUT_MS,
  );
});

/*
 * ---------------------------------------------------------------------------
 * 7. The cache contract
 * ---------------------------------------------------------------------------
 *
 * Every case here drives a cache the case owns, in a directory the case
 * created, through the public `IndexCache` interface. Nothing reads or writes an
 * entry file by hand: what matters is that the module and the cache agree on a
 * key, and a hand-written entry would prove agreement with the test instead.
 */

/**
 * `it`, skipped for the superuser and for a platform with no permission bits.
 *
 * A permission-denied write is the one save failure that cannot be provoked as
 * root — uid 0 creates inside a `0500` directory regardless — so the case would
 * assert the opposite of what it was written for. Its structural companion
 * below provokes the same branch without a permission bit and therefore runs
 * for every account, including in CI.
 */
const itUnprivileged = it.skipIf(process.getuid === undefined || process.getuid?.() === 0);

describe('the cache contract', () => {
  it(
    'builds on a miss, writes the entry, and serves the next run from it',
    async () => {
      const cacheDir = join(makeSandbox('debuggen-indexer-hit-'), 'index');
      const cache = createIndexCache({ cacheDir });

      const built = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache });
      expect(built.fromCache).toBe(false);

      const served = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache });
      expect(served.fromCache).toBe(true);

      // A hit is the same answer as a build, including the moment the index
      // describes: `generatedAt` belongs to the index, not to the run that
      // returned it.
      expect(canonicalJson(served.index)).toBe(canonicalJson(built.index));
      expect(served.index.generatedAt).toBe(built.index.generatedAt);
      expect(served.stats.fileCount).toBe(EXPECTED_FIXTURE_FILES.length);
      expect(served.stats.diagnostics).toEqual([]);

      // No extractor ran, which is the point of the whole cache-first path.
      expect(served.stats.extractorDurations).toEqual({});

      // Both views are rebuilt from the stored envelope and both still work.
      expect(served.graph.nodesByKind('api-route')).toHaveLength(6);
      expect(served.graph.size).toEqual(built.graph.size);
      expect(served.routeMap.resolve('/api/gauges', 'GET')?.entry.file).toBe(
        'app/api/gauges/route.ts',
      );
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'misses when a file changed, and the rebuilt index reflects the change',
    async () => {
      const sandbox = makeSandbox('debuggen-indexer-invalidate-');
      const root = copyCorpusInto(sandbox, 'project');
      const cache = createIndexCache({ cacheDir: join(sandbox, 'index') });

      expect((await indexOrThrow({ projectRoot: root, cache })).fromCache).toBe(false);
      expect((await indexOrThrow({ projectRoot: root, cache })).fromCache).toBe(true);

      // One file's size and modification time change, so its fingerprint
      // changes, so the key changes: a single edited file is a full rebuild, by
      // design rather than by omission.
      await appendFile(
        join(root, SERVICE_MODULE),
        '\nexport async function countBasinGauges(): Promise<number> {\n  return 0;\n}\n',
      );

      const rebuilt = await indexOrThrow({ projectRoot: root, cache });
      expect(rebuilt.fromCache).toBe(false);
      expect(rebuilt.graph.nodesByKind('server-function').map((node) => node.name)).toContain(
        'countBasinGauges',
      );

      // And the rebuilt index is what the next run is served.
      expect((await indexOrThrow({ projectRoot: root, cache })).fromCache).toBe(true);
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'still answers Ok when the entry cannot be written at all',
    async () => {
      const sandbox = makeSandbox('debuggen-indexer-unwritable-');

      // A regular file stands where the cache directory belongs, so creating it
      // fails structurally — no permission bit involved, so this runs for every
      // account.
      const cacheDir = join(sandbox, 'index');
      await appendFile(cacheDir, 'not a directory\n');

      const run = await indexOrThrow({
        projectRoot: FIXTURE_ROOT,
        cache: createIndexCache({ cacheDir }),
      });

      // Failing to cache an index is not failing to build one: the index is
      // whole, and the run reports nothing about the cache in its diagnostics.
      expect(run.fromCache).toBe(false);
      expect(run.stats.diagnostics).toEqual([]);
      expect(canonicalJson(run.index)).toBe(canonicalJson(baseline().index));
    },
    INDEX_TIMEOUT_MS,
  );

  itUnprivileged(
    'still answers Ok when the cache directory cannot be created for want of permission',
    async () => {
      const sandbox = makeSandbox('debuggen-indexer-denied-');
      const locked = join(sandbox, 'locked');

      // The cache directory's parent refuses the `mkdir` the first save
      // performs, which is the ordinary shape of "the cache is unwritable" on a
      // developer's machine.
      mkdirSync(locked, { mode: 0o500 });
      chmodSync(locked, 0o500);

      const run = await indexOrThrow({
        projectRoot: FIXTURE_ROOT,
        cache: createIndexCache({ cacheDir: join(locked, 'index') }),
      });

      expect(run.fromCache).toBe(false);
      expect(canonicalJson(run.index)).toBe(canonicalJson(baseline().index));
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'ignores an entry an earlier indexer version wrote',
    async () => {
      const cacheDir = join(makeSandbox('debuggen-indexer-stale-version-'), 'index');
      const cache = createIndexCache({ cacheDir });
      const loaded = openOrThrow(FIXTURE_ROOT);
      const key = await cacheKeyFor(loaded);

      const planted = await cache.save(key, {
        ...baseline().index,
        indexerVersion: 'indexer/0.0.0-earlier',
      });
      expect(isErr(planted)).toBe(false);

      const run = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache });
      expect(run.fromCache).toBe(false);
      expect(run.index.indexerVersion).toBe(INDEXER_VERSION);

      // The entry really was under the key the module looks for: the rebuild
      // wrote its own index there, and the next run is served from it. Without
      // this step the case would also pass against a key that never matched.
      expect((await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache })).fromCache).toBe(true);
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'ignores an entry an earlier vocabulary version wrote',
    async () => {
      const cacheDir = join(makeSandbox('debuggen-indexer-stale-schema-'), 'index');
      const cache = createIndexCache({ cacheDir });
      const loaded = openOrThrow(FIXTURE_ROOT);
      const key = await cacheKeyFor(loaded);

      const planted = await cache.save(key, {
        ...baseline().index,
        schemaVersion: CODE_INDEX_SCHEMA_VERSION + 1,
      });
      expect(isErr(planted)).toBe(false);

      const run = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache });
      expect(run.fromCache).toBe(false);
      expect(run.index.schemaVersion).toBe(CODE_INDEX_SCHEMA_VERSION);
      expect((await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache })).fromCache).toBe(true);
    },
    INDEX_TIMEOUT_MS,
  );
});

/*
 * ---------------------------------------------------------------------------
 * 8. Degradation and limits
 * ---------------------------------------------------------------------------
 */

/**
 * The absolute path an injected extractor tries to attribute a node to.
 *
 * Never created and never read: its only job is to be a path that is not
 * project-relative, so that the drop and the silence about it are both
 * assertable.
 */
const INTRUDER_PATH = '/var/tmp/debuggen-not-a-project-file.ts';

describe('degradation', () => {
  it(
    'keeps indexing when an extractor throws, and reports which one on which file',
    async () => {
      const failing = makeExtractor('blitzy-failing-extractor', (ctx: ExtractorContext) => {
        if (ctx.file === SERVICE_MODULE) {
          throw new Error('this extractor failed on purpose');
        }

        return { nodes: [], edges: [] };
      });

      const run = await indexOrThrow({
        projectRoot: FIXTURE_ROOT,
        cache: false,
        extractors: [...DEFAULT_EXTRACTORS, failing],
      });

      const failure = exactlyOne(
        diagnosticsOf(run.stats.diagnostics, 'extractor-failed'),
        'extractor-failed diagnostic',
      );
      expect(failure.severity).toBe('error');
      expect(failure.extractorId).toBe('blitzy-failing-extractor');
      expect(failure.file).toBe(SERVICE_MODULE);

      // The type of the thrown value, never its message: a syntax-tree library
      // routinely embeds the text it choked on in the message, and that text is
      // the developer's source (AAP 0.5.2).
      expect(failure.detail).toBe('threw Error');
      expect(failure.message).not.toContain('on purpose');

      // One extractor throwing on one file costs that contribution and nothing
      // else — every default extractor's output is byte-identical to the clean
      // run's.
      expect(JSON.stringify(run.index.nodes)).toBe(JSON.stringify(baseline().index.nodes));
      expect(JSON.stringify(run.index.edges)).toBe(JSON.stringify(baseline().index.edges));

      // Its time was still spent, so it is still reported.
      expect(Object.keys(run.stats.extractorDurations)).toContain('blitzy-failing-extractor');
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'drops a contribution whose file is not a safe project-relative path',
    async () => {
      const unsafe = makeExtractor('blitzy-unsafe-extractor', (ctx: ExtractorContext) => {
        if (ctx.file !== SERVICE_MODULE) {
          return { nodes: [], edges: [] };
        }

        return {
          nodes: [
            {
              id: 'file:blitzy-absolute-intruder',
              kind: 'file',
              name: 'intruder',
              file: INTRUDER_PATH,
              line: 1,
              column: 1,
            },
          ],
          edges: [
            {
              id: 'calls:blitzy-escaping-edge',
              kind: 'calls',
              from: 'file:blitzy-absolute-intruder',
              to: 'file:blitzy-absolute-intruder',
              file: '../outside-the-project/escape.ts',
              line: 1,
              column: 1,
            },
          ],
        };
      });

      const run = await indexOrThrow({
        projectRoot: FIXTURE_ROOT,
        cache: false,
        extractors: [...DEFAULT_EXTRACTORS, unsafe],
      });

      const dropped = diagnosticsOf(run.stats.diagnostics, 'extractor-failed');
      expect(dropped.map((diagnostic) => diagnostic.detail).sort()).toEqual([
        'edgeKind=calls',
        'nodeKind=file',
      ]);

      for (const diagnostic of dropped) {
        // A warning rather than an error: the extractor otherwise succeeded, and
        // the finding is attributable to it rather than to the project.
        expect(diagnostic.severity).toBe('warning');
        expect(diagnostic.extractorId).toBe('blitzy-unsafe-extractor');
        expect(diagnostic.file).toBe(SERVICE_MODULE);

        // The offending path is never echoed: it is by definition not a
        // project-relative path, so repeating it would put a host path into a
        // log line, a persisted session and possibly a prompt.
        expect(diagnostic.message).not.toContain(INTRUDER_PATH);
        expect(diagnostic.detail ?? '').not.toContain(INTRUDER_PATH);
        expect(diagnostic.message).not.toContain('outside-the-project');
      }

      expect(run.index.nodes.map((node) => node.id)).not.toContain('file:blitzy-absolute-intruder');
      expect(run.index.edges.map((edge) => edge.id)).not.toContain('calls:blitzy-escaping-edge');
      expect(JSON.stringify(run.index.nodes)).toBe(JSON.stringify(baseline().index.nodes));
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'caps the run at maxFiles, reports the truncation, and never caches it',
    async () => {
      const cacheDir = join(makeSandbox('debuggen-indexer-capped-'), 'index');
      const cache = createIndexCache({ cacheDir });

      const capped = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache, maxFiles: 1 });

      expect(capped.fromCache).toBe(false);
      expect(capped.stats.fileCount).toBe(1);
      expect(capped.stats.skippedFiles).toBe(EXPECTED_FIXTURE_FILES.length - 1);

      // The bound is a prefix of the same sorted order, so a truncated run is
      // deterministic rather than an arbitrary subset.
      expect(capped.index.files.map((fingerprint) => fingerprint.file)).toEqual(
        EXPECTED_FIXTURE_FILES.slice(0, 1),
      );

      const limit = exactlyOne(
        diagnosticsOf(capped.stats.diagnostics, 'limit-reached'),
        'limit-reached diagnostic',
      );
      expect(limit.severity).toBe('warning');
      expect(limit.detail).toBe('maxFiles=1');
      expect(limit.message).toContain('partial');

      // The edges the excluded files would have answered for are reported as
      // dropped rather than silently missing, which is what makes a capped index
      // honest instead of merely smaller.
      expect(diagnosticsOf(capped.stats.diagnostics, 'dangling-edge').length).toBeGreaterThan(0);

      // A truncated index describes a prefix of the project, so it is never
      // written: the next capped run rebuilds instead of being served one.
      const again = await indexOrThrow({ projectRoot: FIXTURE_ROOT, cache, maxFiles: 1 });
      expect(again.fromCache).toBe(false);
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'reports an empty index for a directory with nothing indexable in it',
    async () => {
      const run = await indexOrThrow({
        projectRoot: makeSandbox('debuggen-indexer-empty-'),
        cache: false,
      });

      // An empty project is an empty index, not a failure: a developer who
      // opened the wrong directory gets an answer and a progress view that says
      // nothing was found.
      expect(run.index.nodes).toEqual([]);
      expect(run.index.edges).toEqual([]);
      expect(run.index.files).toEqual([]);
      expect(run.stats.fileCount).toBe(0);
      expect(run.stats.diagnostics).toEqual([]);
      expect(run.graph.size).toEqual({ nodes: 0, edges: 0 });
      expect(run.routeMap.entries).toEqual([]);
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'skips a file that vanished after the project was opened',
    async () => {
      const root = copyCorpusInto(makeSandbox('debuggen-indexer-deleted-'), 'project');
      const loaded = openOrThrow(root);

      // The window every working tree has: the program holds the file, the
      // filesystem no longer does.
      unlinkSync(join(root, 'src/lib/http.ts'));

      const run = await indexOrThrow({ projectRoot: root, loaded, cache: false });

      expect(run.stats.fileCount).toBe(EXPECTED_FIXTURE_FILES.length - 1);
      expect(run.stats.skippedFiles).toBe(1);

      const skipped = exactlyOne(
        diagnosticsOf(run.stats.diagnostics, 'file-skipped'),
        'file-skipped diagnostic',
      );
      expect(skipped.severity).toBe('info');
      expect(skipped.file).toBe('src/lib/http.ts');
      expect(skipped.detail).toBe('ENOENT');

      // A file the run could not even stat is left out of both the fingerprint
      // list and the extraction loop, so nothing claims to describe it.
      expect(run.index.files.map((fingerprint) => fingerprint.file)).not.toContain(
        'src/lib/http.ts',
      );
      expect(filesWithNodes(run.index)).not.toContain('src/lib/http.ts');
    },
    INDEX_TIMEOUT_MS,
  );
});

/*
 * ---------------------------------------------------------------------------
 * 9. Cancellation
 * ---------------------------------------------------------------------------
 *
 * A cancelled index is not a partial index: a caller that asked for one and
 * then changed its mind must not be handed half a graph as if it were whole.
 */

describe('cancellation', () => {
  it(
    'reports a declared failure code for a signal that was already aborted',
    async () => {
      const controller = new AbortController();
      controller.abort();

      const indexed = await indexProject({
        projectRoot: FIXTURE_ROOT,
        cache: false,
        signal: controller.signal,
      });

      if (!isErr(indexed)) {
        throw new Error('expected the cancelled run to report a failure');
      }

      expect(indexed.error.code).toBe('CODE_INDEX_FAILED');
      expect(DEBUGGEN_ERROR_CODES).toContain(indexed.error.code);
      expect(indexed.error.details).toEqual({ reason: 'aborted' });

      // A cancelled run is recoverable, so it carries the developer's next step.
      expect(indexed.error.hint ?? '').not.toBe('');
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'reports the same failure for a run cancelled between files',
    async () => {
      const controller = new AbortController();
      let visited = 0;

      // Cancellation is cooperative and checked between files, so aborting from
      // inside an extractor stops the run within one file's work rather than at
      // the end of it.
      const cancelling = makeExtractor('blitzy-cancelling-extractor', () => {
        visited += 1;
        controller.abort();
        return { nodes: [], edges: [] };
      });

      const indexed = await indexProject({
        projectRoot: FIXTURE_ROOT,
        cache: false,
        extractors: [...DEFAULT_EXTRACTORS, cancelling],
        signal: controller.signal,
      });

      if (!isErr(indexed)) {
        throw new Error('expected the cancelled run to report a failure');
      }

      expect(visited).toBeGreaterThan(0);
      expect(visited).toBeLessThan(EXPECTED_FIXTURE_FILES.length);
      expect(indexed.error.code).toBe('CODE_INDEX_FAILED');
      expect(indexed.error.details).toEqual({ reason: 'aborted' });
    },
    INDEX_TIMEOUT_MS,
  );
});

/*
 * ---------------------------------------------------------------------------
 * 10. Laziness and the on-demand reference resolver
 * ---------------------------------------------------------------------------
 *
 * `findReferences` forces type resolution across the whole program and is the
 * most expensive operation ts-morph offers. The build may not perform it — the
 * static `calls` and `references` edges the extractors record while they are
 * already walking the tree are the primary signal — and the resolver is the
 * deepening `./graph/query.ts` reaches for when those edges are inconclusive.
 */

describe('laziness', () => {
  it(
    'performs no reference resolution while building an index',
    async () => {
      const loaded = openOrThrow(FIXTURE_ROOT);

      // The language service is the only route to a reference lookup: both
      // `Node.findReferences` and `Node.findReferencesAsNodes` delegate to this
      // instance, so a zero count here is the whole claim.
      const service = loaded.project.getLanguageService();
      const asNodes = vi.spyOn(service, 'findReferencesAsNodes');
      const references = vi.spyOn(service, 'findReferences');

      const run = await indexOrThrow({ projectRoot: FIXTURE_ROOT, loaded, cache: false });

      expect(run.stats.nodeCount).toBe(baseline().stats.nodeCount);
      expect(asNodes).not.toHaveBeenCalled();
      expect(references).not.toHaveBeenCalled();

      // Creating a resolver costs one object: the path index is built on the
      // first lookup and the language service is not touched until then.
      createReferenceResolver(loaded);
      expect(asNodes).not.toHaveBeenCalled();
      expect(references).not.toHaveBeenCalled();
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'answers a one-hop caller lookup on demand and memoises the answer',
    () => {
      const loaded = openOrThrow(FIXTURE_ROOT);
      const asNodes = vi.spyOn(loaded.project.getLanguageService(), 'findReferencesAsNodes');
      const resolver = createReferenceResolver(loaded);

      // The corpus' single-caller relationship: one route handler imports the
      // function and calls it, so the lookup answers with the import specifier
      // and the call site, in file, line and column order.
      const found = resolver.referencesTo({ file: SERVICE_MODULE, symbol: 'recordGaugeReading' });

      expect(asNodes.mock.calls.length).toBeGreaterThan(0);
      expect(
        found.map(
          (location) => `${location.file}:${String(location.line)}:${String(location.column)}`,
        ),
      ).toEqual(['app/api/gauges/route.ts:28:27', 'app/api/gauges/route.ts:92:25']);

      for (const location of found) {
        expect(location.symbol).toBe('recordGaugeReading');
        expect(location.resolvedBy).toBe('code-graph');
        expect(location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
        expect(isSafeRelativePath(location.file)).toBe(true);
      }

      // Memoised per `(file, symbol)` for the resolver's lifetime: the second
      // lookup is the same frozen array and asks the language service nothing.
      const callsAfterFirst = asNodes.mock.calls.length;
      const again = resolver.referencesTo({ file: SERVICE_MODULE, symbol: 'recordGaugeReading' });

      expect(again).toBe(found);
      expect(asNodes.mock.calls.length).toBe(callsAfterFirst);
    },
    INDEX_TIMEOUT_MS,
  );

  it(
    'reports nothing rather than throwing for a lookup it cannot answer',
    () => {
      const loaded = openOrThrow(FIXTURE_ROOT);
      const resolver = createReferenceResolver(loaded);

      // An unanswerable lookup must not fail an investigation: `./graph/query.ts`
      // keeps its static answer when this returns nothing, which is a smaller
      // loss than a failed stage.
      expect(
        resolver.referencesTo({ file: SERVICE_MODULE, symbol: 'notDeclaredAnywhere' }),
      ).toEqual([]);
      expect(
        resolver.referencesTo({ file: 'src/lib/no-such-module.ts', symbol: 'summarizeBasin' }),
      ).toEqual([]);
      expect(resolver.referencesTo({ file: '', symbol: '' })).toEqual([]);

      // A type that is referenced only as a type still resolves, so the resolver
      // is not restricted to callable symbols.
      expect(
        resolver.referencesTo({ file: 'src/widgets/BasinSummary.tsx', symbol: 'BasinSummaryProps' })
          .length,
      ).toBeGreaterThan(0);
    },
    INDEX_TIMEOUT_MS,
  );
});
