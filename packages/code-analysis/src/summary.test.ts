/**
 * Tests for `./summary.ts`: the builder of the bounded description of a target
 * project that the pipeline's first stage reasons about (AAP 0.4.2).
 *
 * Two properties are what this suite exists to hold, because everything else
 * about the module follows from them:
 *
 * **It is bounded.** The summary is embedded verbatim in a prompt, so its size
 * is a cost paid on every session. The boundedness group pins every cap, the
 * serialised byte budget, and the *order* in which items are given up when the
 * budget bites — dependencies, then directories, then routes, then entry
 * points — since that order is the module's answer to "if the prompt can carry
 * one more thing, what should it be".
 *
 * **It is honest.** Every field is derived from something actually present in
 * the target project, and where nothing settles a question the answer is the
 * explicit `'unknown'` or `'none'` member of the vocabulary rather than a
 * plausible default. The detector groups therefore assert the *absence* of
 * confidence as carefully as its presence: an empty router directory is not a
 * framework, a declared client with no call sites is not database access, and a
 * project that declares no package manager is `'unknown'` rather than this
 * repository's own pin.
 *
 * A third property is a security control rather than a preference: the summary
 * is **the first artefact that leaves the machine** when a real model provider
 * is configured (AAP 0.5.2). The privacy group plants environment files, a
 * dense opaque literal and a statement-bearing module inside a copy of the
 * corpus and asserts that none of them — no `.env` path, no variable name, no
 * value, no source text, no statement text, nothing matching the secret shapes
 * of AAP 0.5.2 — reaches the serialised summary.
 *
 * ## The four parts
 *
 * 1. **Reading, over narrow inputs.** `parseManifest`, `readTargetManifest` and
 *    `createProjectProbe`: the module's only two filesystem touches and the
 *    view it reduces a manifest to. The refusals are the interesting half — an
 *    environment file cannot even be probed for, an excluded tree is never
 *    inspected, an unreadable manifest is an answer rather than a fault.
 * 2. **Detection, over narrow inputs.** The four detectors are driven with
 *    literal manifests and three-line fake probes, because each one is a
 *    decision ladder with more rungs than any single corpus exercises, and an
 *    algorithm asserted only through a fixture is an algorithm a fixture can
 *    silently stop covering.
 * 3. **The corpus, opened where it lives.** `summarizeProject` over
 *    `test/fixtures/sample-next-app` through the real `openProject`,
 *    `buildRouteMap` and `indexProject`, which is what a consumer does with a
 *    developer's project. The corpus is deliberately hybrid — an App Router
 *    tree with a Pages Router remnant — its database access deliberately
 *    covers both drivers in one module, and its manifest deliberately declares
 *    a package manager that is *not* this repository's, which is the assertion
 *    hook proving the module reads the target's manifest. It is read **only**,
 *    never written, so a run leaves `git status` unchanged.
 * 4. **Boundedness, determinism, privacy and degradation.** Everything that is
 *    a property of the whole object rather than of one field, each asserted in
 *    an `mkdtemp` copy where a copy is needed.
 *
 * Fixture names (`fixture-observatory-app`, its routes, its widgets) are
 * fixture-invented test data. None of them appears in `./summary.ts`, and none
 * should: that module knows published library names and framework conventions,
 * never the vocabulary of any project it summarises.
 */

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dirnamePosix, isSafeRelativePath, joinPosix, toPosix } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger } from '@debuggen/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CodeGraph, makeEdgeId } from './graph/graph.js';
import { CODE_INDEX_SCHEMA_VERSION } from './graph/types.js';
import type {
  CodeEdge,
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  DbDriver,
  ExternalImportRef,
  ProjectSummary,
  ProjectSummaryCounts,
} from './graph/types.js';
import { indexProject } from './indexer.js';
import { findWorkspaceRoot, openProject } from './project.js';
import type { LoadedProject } from './project.js';
import { buildRouteMap, matchRoute } from './route-map.js';
import type { RouteEntry, RouteMap } from './route-map.js';
import {
  PROJECT_SUMMARY_LIMITS,
  createProjectProbe,
  detectDatabaseAccess,
  detectFramework,
  detectPackageManager,
  detectRouterStyle,
  isToolingModulePath,
  parseManifest,
  readTargetManifest,
  summarizeProject,
} from './summary.js';
import type { ProjectProbe, TargetManifest } from './summary.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures and helpers
 * ---------------------------------------------------------------------------
 */

/** The read-only indexing corpus, opened where it lives and never written. */
const FIXTURE_ROOT = toPosix(
  fileURLToPath(new URL('../test/fixtures/sample-next-app', import.meta.url)),
);

/** One log record a {@link recordingLogger} logger captured. */
interface RecordedLog {
  /** The severity the record was emitted at. */
  readonly level: LogLevel;

  /** The message text, which is what the assertions match on. */
  readonly message: string;

  /** The structured fields, or `undefined` when the call passed none. */
  readonly fields: LogFields | undefined;
}

/**
 * A logger that records instead of printing, plus the list it records into.
 *
 * The module's degradations are part of its contract — an unreadable manifest
 * and an exhausted byte budget are reported at `debug` and `warn` rather than
 * thrown — so several cases assert on the record. `level` is `trace` so nothing
 * is filtered before it is recorded, and `child` returns the same logger
 * because no case asserts on bindings and one flat list is easier to search.
 */
function recordingLogger(): { readonly logger: Logger; readonly records: readonly RecordedLog[] } {
  const records: RecordedLog[] = [];
  const capture =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };

  const logger: Logger = {
    level: 'trace',
    trace: capture('trace'),
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    fatal: capture('fatal'),
    child: () => logger,
  };

  return { logger, records };
}

/** Whether any record of `level` carries `message`. */
function logged(records: readonly RecordedLog[], level: LogLevel, message: string): boolean {
  return records.some((record) => record.level === level && record.message === message);
}

/**
 * A probe over a literal layout: the paths that exist, and nothing else.
 *
 * The seam `./summary.ts` documents for exactly this purpose — every detector
 * takes a {@link ProjectProbe} rather than touching the filesystem — so a
 * layout a real project would take a directory tree to express is three lines
 * here, and a case can state the *absence* of a path as precisely as its
 * presence.
 */
function fakeProbe(layout: {
  readonly files?: readonly string[];
  readonly directories?: readonly string[];
}): ProjectProbe {
  const files = new Set(layout.files ?? []);
  const directories = new Set(layout.directories ?? []);
  return {
    fileExists: (path: string): boolean => files.has(path),
    directoryExists: (path: string): boolean => directories.has(path),
  };
}

/** A project whose disk holds nothing the detectors look for. */
const EMPTY_PROBE: ProjectProbe = fakeProbe({});

/**
 * The environment variable planted in the sandboxes that prove the privacy
 * boundary.
 *
 * Obviously fake, and deliberately distinctive: the privacy case searches the
 * serialised summary for this exact name and value, so a substring that could
 * occur naturally would let the case pass for the wrong reason.
 */
const PLANTED_ENV_NAME = 'OBSERVATORY_PLACEHOLDER_VALUE';

/** The value beside {@link PLANTED_ENV_NAME}. Not a credential, and not shaped like one. */
const PLANTED_ENV_VALUE = 'example-placeholder-value';

/** The contents of a planted environment file. */
function envFileContents(): string {
  return `${PLANTED_ENV_NAME}=${PLANTED_ENV_VALUE}\n`;
}

/**
 * The narrow manifest view of a literal.
 *
 * Every detector case builds its manifest through `parseManifest`, which is the
 * seam the module documents for them, rather than asserting a `TargetManifest`
 * into existence: a case therefore exercises the same reduction a real manifest
 * goes through.
 *
 * @param raw The literal to reduce.
 * @returns The view.
 */
function manifestView(raw: unknown): TargetManifest {
  const view = parseManifest(raw);
  if (view === undefined) {
    throw new Error('the literal did not reduce to a manifest view');
  }
  return view;
}

/** A `file` node carrying the imports a construction site would leave behind. */
function fileNode(
  id: string,
  file: string,
  externalImports: readonly ExternalImportRef[],
): CodeNodeOf<'file'> {
  return {
    id,
    kind: 'file',
    name: file,
    file,
    line: 1,
    column: 1,
    data: { extension: '.ts', isClientModule: false, externalImports },
  };
}

/**
 * A `db-call` node for one driver, which is all the style detector reads.
 *
 * `dynamic: false` is the payload's own requirement rather than anything this
 * suite asserts on: a statement built from a literal is the ordinary case, and
 * no statement text is carried at all, because the summary must never be able
 * to relay one.
 */
function dbCallNode(id: string, driver: DbDriver, file: string): CodeNodeOf<'db-call'> {
  return {
    id,
    kind: 'db-call',
    name: id,
    file,
    line: 1,
    column: 1,
    data: { driver, dynamic: false },
  };
}

/**
 * A graph over synthesised nodes and edges, built exactly as a persisted index
 * is read back.
 *
 * @param nodes The nodes.
 * @param edges The edges; none by default, which is all the style detector needs.
 * @returns The graph.
 */
function graphOf(nodes: readonly CodeNode[], edges: readonly CodeEdge[] = []): CodeGraph {
  const index: CodeIndex = {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: '/project',
    indexerVersion: 'summary.test',
    generatedAt: 0,
    nodes: [...nodes],
    edges: [...edges],
    files: [],
  };
  return CodeGraph.fromIndex(index);
}

/**
 * A resolved in-project `imports` edge from one `file` node to another, which
 * is what tells the construction-module ranking that a module is shared.
 *
 * @param from The importing file node's id.
 * @param to The imported file node's id.
 * @returns The edge.
 */
function importEdge(from: string, to: string): CodeEdge {
  return {
    id: makeEdgeId({ kind: 'imports', from, to, line: 1, column: 1 }),
    kind: 'imports',
    from,
    to,
  };
}

/** A route map over a literal entry list, resolving through the real matcher. */
function routeMapOf(entries: readonly RouteEntry[]): RouteMap {
  return {
    entries,
    resolve: (urlOrPathname, method) => matchRoute(entries, urlOrPathname, method),
  };
}

/**
 * Every sandbox this file created, removed together in `afterAll`.
 *
 * A registry rather than per-case cleanup so that a case which fails part-way
 * through building its layout still has its directory removed: `afterAll` runs
 * whether the cases passed or not, and nothing under `tmpdir()` survives the
 * suite.
 */
const sandboxes: string[] = [];

/**
 * An empty, symlink-free sandbox directory.
 *
 * `realpath` matters for the same reason it matters inside the module: a
 * temporary directory reached through a link would make every sandbox project
 * a "symlinked root" project, and the module's containment checks would be
 * answering a different question than the one a case is asking.
 *
 * @param purpose Names the directory, so a failing run is readable in `/tmp`.
 * @returns The absolute POSIX path of the new directory.
 */
function newSandbox(purpose: string): string {
  const root = toPosix(realpathSync(mkdtempSync(join(tmpdir(), `debuggen-summary-${purpose}-`))));
  sandboxes.push(root);
  return root;
}

/**
 * A writable copy of the corpus, so a case may mutate a project's manifest,
 * lockfiles or trees without touching the committed fixture.
 *
 * The copy is always made into a `target` directory *inside* the sandbox rather
 * than into the sandbox itself, which pins one value a case asserts on: a
 * project with no readable manifest is named after its own directory, and
 * `'target'` is a name a case can state instead of the random one `mkdtemp`
 * produced.
 *
 * @param purpose Names the sandbox.
 * @returns The absolute POSIX path of the copy's root.
 */
function corpusCopy(purpose: string): string {
  const root = joinPosix(newSandbox(purpose), 'target');
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

/** Writes a file inside a sandbox, creating its directory chain first. */
function plantFile(root: string, relativePath: string, contents: string): string {
  const absolute = joinPosix(root, relativePath);
  mkdirSync(dirnamePosix(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return absolute;
}

/** Removes a path from a sandbox, whether it is a file or a directory. */
function removePath(root: string, relativePath: string): void {
  rmSync(joinPosix(root, relativePath), { recursive: true, force: true });
}

/** Opens a project exactly as a consumer opens a developer's project. */
function openAt(projectRoot: string): LoadedProject {
  const opened = openProject({ projectRoot });
  if (!opened.ok) {
    throw new Error(`the project at ${projectRoot} did not open: ${opened.error.message}`);
  }
  return opened.value;
}

/** Everything the corpus group shares, prepared once. */
interface Corpus {
  /** The corpus, opened read-only. */
  readonly loaded: LoadedProject;

  /** Its route inventory, built with the compiler. */
  readonly routeMap: RouteMap;

  /** Its graph, from a freshly built index. */
  readonly graph: CodeGraph;

  /** That index, for the case that summarises from an index instead of a graph. */
  readonly index: CodeIndex;

  /** The summary under default limits, which most cases assert against. */
  readonly summary: ProjectSummary;
}

/**
 * The prepared corpus, or `undefined` until `beforeAll` has run.
 *
 * Held as possibly-undefined and read through {@link corpus} rather than
 * asserted into existence, so a case that somehow ran without the hook fails
 * with a sentence instead of a `TypeError` three frames deep.
 */
let prepared: Corpus | undefined;

/** The prepared corpus. */
function corpus(): Corpus {
  if (prepared === undefined) {
    throw new Error('the corpus was not prepared: the beforeAll hook did not complete');
  }
  return prepared;
}

/**
 * Opens, indexes and summarises the corpus once.
 *
 * Indexing is the expensive part of this suite — a ts-morph program over the
 * whole corpus — and every assertion about the committed fixture works from
 * the same artefacts, so it is paid for once. The budget is generous because
 * the cost is a compiler's rather than this module's, and a loaded machine
 * must not turn a correct suite red.
 */
beforeAll(async () => {
  const loaded = openAt(FIXTURE_ROOT);
  const routeMap = buildRouteMap(loaded);
  const indexed = await indexProject({ projectRoot: FIXTURE_ROOT, loaded, cache: false });
  if (!indexed.ok) {
    throw new Error(`the corpus did not index: ${indexed.error.message}`);
  }

  prepared = {
    loaded,
    routeMap,
    graph: indexed.value.graph,
    index: indexed.value.index,
    summary: summarizeProject({ loaded, graph: indexed.value.graph, routeMap }),
  };
}, 120_000);

afterAll(() => {
  for (const sandbox of sandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
  sandboxes.length = 0;
});

/*
 * ---------------------------------------------------------------------------
 * 1. Reading: the manifest view and the existence probe
 * ---------------------------------------------------------------------------
 */

describe('parseManifest', () => {
  it('refuses anything that is not a JSON object', () => {
    expect(parseManifest(null)).toBeUndefined();
    expect(parseManifest(undefined)).toBeUndefined();
    expect(parseManifest([{ name: 'listed' }])).toBeUndefined();
    expect(parseManifest('a string')).toBeUndefined();
    expect(parseManifest(42)).toBeUndefined();
  });

  it('reduces a manifest to the four fields it is willing to look at', () => {
    // `scripts` is the field that matters here: a developer's build command can
    // legitimately carry a credential, and the view has no shape that could
    // represent it, so it cannot reach a prompt.
    const view = manifestView({
      name: 'literal-project',
      version: '2.0.0',
      packageManager: 'yarn@4.9.2',
      scripts: { dev: 'run --with-token placeholder' },
      config: { nested: { value: 'kept out' } },
      dependencies: { alpha: '^1.0.0' },
      devDependencies: { beta: '~2.0.0' },
    });

    expect(view).toEqual({
      name: 'literal-project',
      packageManager: 'yarn@4.9.2',
      dependencies: { alpha: '^1.0.0' },
      devDependencies: { beta: '~2.0.0' },
    });
  });

  it('checks every field on its own, keeping the well-formed ones', () => {
    const view = manifestView({
      name: 42,
      packageManager: null,
      dependencies: { declared: '^1.2.3', numeric: 9, nested: { range: '1' } },
      devDependencies: 'not a record',
    });

    expect(view.name).toBeUndefined();
    expect(view.packageManager).toBeUndefined();
    expect(view.devDependencies).toBeUndefined();
    expect(view.dependencies).toEqual({ declared: '^1.2.3' });
  });

  it('drops an empty name and an empty dependency record', () => {
    const view = manifestView({ name: '', packageManager: '', dependencies: {} });

    expect(view).toEqual({});
  });
});

describe('readTargetManifest', () => {
  it('reads the target project manifest and nothing beyond the narrow view', () => {
    const view = readTargetManifest(FIXTURE_ROOT);

    expect(view).toBeDefined();
    expect(Object.keys(view ?? {}).sort()).toEqual(['dependencies', 'name', 'packageManager']);
    expect(view?.name).toBe('fixture-observatory-app');
    expect(view?.packageManager).toBe('npm@10.9.0');
    expect(view?.dependencies).toEqual({ next: '16.3.5', react: '19.3.0', 'react-dom': '19.3.0' });
  });

  it('answers undefined for a project that declares no manifest', () => {
    const { logger, records } = recordingLogger();
    const root = newSandbox('no-manifest');

    expect(readTargetManifest(root, logger)).toBeUndefined();
    expect(logged(records, 'debug', 'project declares no manifest')).toBe(true);
  });

  it('answers undefined for a manifest that is not valid JSON', () => {
    const { logger, records } = recordingLogger();
    const root = newSandbox('malformed-manifest');
    plantFile(root, 'package.json', '{ "name": "half-written",');

    expect(readTargetManifest(root, logger)).toBeUndefined();
    expect(logged(records, 'debug', 'project manifest is not valid JSON')).toBe(true);
  });

  it('answers undefined for a manifest that parses to something other than an object', () => {
    const { logger, records } = recordingLogger();
    const root = newSandbox('array-manifest');
    plantFile(root, 'package.json', '[]');

    expect(readTargetManifest(root, logger)).toBeUndefined();
    expect(logged(records, 'debug', 'project manifest is not a JSON object')).toBe(true);
  });

  it('refuses a manifest larger than it will read, without reading it', () => {
    const { logger, records } = recordingLogger();
    const root = newSandbox('huge-manifest');
    // Well past the 1 MiB ceiling, and valid JSON: the refusal must come from
    // the size rather than from a parse failure.
    plantFile(
      root,
      'package.json',
      JSON.stringify({ name: 'oversized', pad: 'a'.repeat(1_100_000) }),
    );

    expect(readTargetManifest(root, logger)).toBeUndefined();
    expect(logged(records, 'debug', 'project manifest is larger than this module will read')).toBe(
      true,
    );
  });
});

describe('createProjectProbe', () => {
  it('answers the two existence questions about the corpus', () => {
    const probe = createProjectProbe(FIXTURE_ROOT);

    expect(probe.fileExists('package.json')).toBe(true);
    expect(probe.fileExists('next.config.mjs')).toBe(true);
    expect(probe.directoryExists('app')).toBe(true);
    expect(probe.directoryExists('pages/api')).toBe(true);
    expect(probe.fileExists('app')).toBe(false);
    expect(probe.directoryExists('package.json')).toBe(false);
    expect(probe.fileExists('pnpm-lock.yaml')).toBe(false);
  });

  it('refuses to probe an environment file even when one is there', () => {
    // AAP 0.5.2: the module reads no environment value, and the guarantee is
    // upstream of reading — an environment file cannot even be probed for, so
    // its *presence* cannot become a signal either.
    const root = newSandbox('env-files');
    plantFile(root, '.env', envFileContents());
    plantFile(root, '.env.local', envFileContents());
    plantFile(root, '.env.production.local', envFileContents());
    const probe = createProjectProbe(root);

    expect(probe.fileExists('.env')).toBe(false);
    expect(probe.fileExists('.env.local')).toBe(false);
    expect(probe.fileExists('.env.production.local')).toBe(false);
  });

  it('refuses an excluded tree, so an installed dependency layout is never inspected', () => {
    const root = newSandbox('excluded-trees');
    plantFile(root, 'node_modules/published-library/package.json', '{ "name": "published" }');
    plantFile(root, '.next/build-manifest.json', '{}');
    const probe = createProjectProbe(root);

    expect(probe.directoryExists('node_modules')).toBe(false);
    expect(probe.fileExists('node_modules/published-library/package.json')).toBe(false);
    expect(probe.directoryExists('.next')).toBe(false);
  });

  it('refuses a path that is not a safe project-relative path', () => {
    const probe = createProjectProbe(FIXTURE_ROOT);

    expect(probe.fileExists('../package.json')).toBe(false);
    expect(probe.fileExists('app/../../package.json')).toBe(false);
    expect(probe.fileExists('/etc/hostname')).toBe(false);
    expect(probe.fileExists('C:\\Windows\\win.ini')).toBe(false);
    // A traversal written with the other separator is still a traversal, which
    // is the case that makes the conversion below safe.
    expect(probe.fileExists('..\\..\\package.json')).toBe(false);
    expect(probe.fileExists('app/page\u0000.tsx')).toBe(false);
    expect(probe.fileExists('')).toBe(false);
    expect(probe.directoryExists('..')).toBe(false);
  });

  it('converts a separator to POSIX before it asks, as the shared predicate requires', () => {
    // `@debuggen/shared`'s `isSafeRelativePath` documents that a caller must
    // convert with `toPosix` *before* asking, and the probe does. So a path
    // whose separators are written the other way round names the same file,
    // while every unsafe shape above is still refused after the conversion.
    expect(createProjectProbe(FIXTURE_ROOT).fileExists('app\\page.tsx')).toBe(true);
    expect(createProjectProbe(FIXTURE_ROOT).directoryExists('app\\api')).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 2. Detection, over narrow inputs
 * ---------------------------------------------------------------------------
 */

describe('detectFramework', () => {
  it('reports the declared range string, never a resolved version', () => {
    // A range is what the project claims; a resolved version would mean reading
    // its `node_modules`, which may be absent, stale or pruned.
    expect(
      detectFramework(manifestView({ dependencies: { next: '^16.3.5' } }), EMPTY_PROBE),
    ).toEqual({ name: 'next', version: '^16.3.5' });
    expect(
      detectFramework(manifestView({ dependencies: { next: 'latest' } }), EMPTY_PROBE),
    ).toEqual({
      name: 'next',
      version: 'latest',
    });
  });

  it('accepts a declaration in either dependency section', () => {
    expect(
      detectFramework(manifestView({ devDependencies: { next: '16.3.5' } }), EMPTY_PROBE),
    ).toEqual({ name: 'next', version: '16.3.5' });
  });

  it('recognises the framework from its configuration module in every extension', () => {
    for (const config of [
      'next.config.ts',
      'next.config.mts',
      'next.config.js',
      'next.config.mjs',
      'next.config.cjs',
    ]) {
      // No manifest at all: a project whose dependencies were pruned still has
      // its configuration, and the on-disk signal stands on its own.
      expect(detectFramework(undefined, fakeProbe({ files: [config] }))).toEqual({ name: 'next' });
    }
  });

  it('recognises the framework from a router tree, in both layouts', () => {
    const layouts: readonly { readonly directories: string[]; readonly files: string[] }[] = [
      { directories: ['app'], files: ['app/layout.tsx'] },
      { directories: ['app'], files: ['app/page.js'] },
      { directories: ['src/app'], files: ['src/app/template.tsx'] },
      { directories: ['pages'], files: ['pages/index.tsx'] },
      { directories: ['src/pages'], files: ['src/pages/_app.jsx'] },
      { directories: ['app', 'app/api'], files: [] },
    ];

    for (const layout of layouts) {
      expect(detectFramework(undefined, fakeProbe(layout))).toEqual({ name: 'next' });
    }
  });

  it('does not take an empty router directory for a router tree', () => {
    // The honesty rule in one case: a directory called `app` holding none of the
    // convention's own modules says nothing, and reporting the framework from it
    // would send the understanding stage looking for route modules that do not
    // exist.
    expect(detectFramework(undefined, fakeProbe({ directories: ['app', 'pages'] }))).toEqual({
      name: 'unknown',
    });
  });

  it('reports the view library when there is no framework signal', () => {
    expect(
      detectFramework(manifestView({ dependencies: { react: '19.3.0' } }), EMPTY_PROBE),
    ).toEqual({ name: 'react', version: '19.3.0' });
    expect(
      detectFramework(manifestView({ dependencies: { 'react-dom': '19.2.0' } }), EMPTY_PROBE),
    ).toEqual({ name: 'react', version: '19.2.0' });
    expect(
      detectFramework(
        manifestView({ dependencies: { react: '19.3.0', 'react-dom': '19.2.0' } }),
        EMPTY_PROBE,
      ),
    ).toEqual({ name: 'react', version: '19.3.0' });
  });

  it('answers unknown, without a version, when nothing settles it', () => {
    // The vocabulary has three members and no member for "plain runtime
    // project", and its own documentation prescribes the honest `unknown`.
    expect(
      detectFramework(manifestView({ dependencies: { hono: '4.13.8' } }), EMPTY_PROBE),
    ).toEqual({ name: 'unknown' });
    expect(detectFramework(undefined, EMPTY_PROBE)).toEqual({ name: 'unknown' });
  });

  it('treats an unparseable manifest as no manifest, without throwing', () => {
    // What `readTargetManifest` hands over for a malformed file is `undefined`,
    // and the detector's contract is that this is an ordinary input.
    expect(parseManifest('{ not json }')).toBeUndefined();
    expect(detectFramework(parseManifest('{ not json }'), EMPTY_PROBE)).toEqual({
      name: 'unknown',
    });
  });
});

describe('detectRouterStyle', () => {
  it('reads each convention from its tree on disk', () => {
    expect(
      detectRouterStyle(undefined, fakeProbe({ directories: ['app'], files: ['app/page.tsx'] })),
    ).toBe('app');
    expect(
      detectRouterStyle(
        undefined,
        fakeProbe({ directories: ['pages'], files: ['pages/index.tsx'] }),
      ),
    ).toBe('pages');
    expect(
      detectRouterStyle(
        undefined,
        fakeProbe({
          directories: ['app', 'pages'],
          files: ['app/layout.tsx', 'pages/_document.tsx'],
        }),
      ),
    ).toBe('hybrid');
    expect(detectRouterStyle(undefined, EMPTY_PROBE)).toBe('none');
  });

  it('recognises both trees under src/', () => {
    expect(
      detectRouterStyle(
        undefined,
        fakeProbe({ directories: ['src/app'], files: ['src/app/page.tsx'] }),
      ),
    ).toBe('app');
    expect(
      detectRouterStyle(
        undefined,
        fakeProbe({ directories: ['src/pages'], files: ['src/pages/index.js'] }),
      ),
    ).toBe('pages');
    expect(
      detectRouterStyle(
        undefined,
        fakeProbe({
          directories: ['src/app', 'src/pages'],
          files: ['src/app/page.tsx', 'src/pages/_app.tsx'],
        }),
      ),
    ).toBe('hybrid');
  });

  it('reads the convention from the route inventory when the disk is silent', () => {
    // Only each entry's `router` field is read here, which is why real corpus
    // entries can drive the case: what is being asserted is the union rule, not
    // anything about the corpus.
    const app = corpus().routeMap.entries.filter((entry) => entry.router === 'app');
    const pages = corpus().routeMap.entries.filter((entry) => entry.router === 'pages');

    expect(app.length).toBeGreaterThan(0);
    expect(pages.length).toBeGreaterThan(0);
    expect(detectRouterStyle(routeMapOf(app), EMPTY_PROBE)).toBe('app');
    expect(detectRouterStyle(routeMapOf(pages), EMPTY_PROBE)).toBe('pages');
    expect(detectRouterStyle(routeMapOf([...app, ...pages]), EMPTY_PROBE)).toBe('hybrid');
    expect(detectRouterStyle(routeMapOf([]), EMPTY_PROBE)).toBe('none');
  });

  it('unions the two signals rather than preferring either', () => {
    // The shape of a migration that has moved the document but not the pages: a
    // tree on disk with no routable module yet, beside routes of the other
    // convention. Reporting either pure flavour would hide half of the request
    // surface from the investigation.
    const pages = corpus().routeMap.entries.filter((entry) => entry.router === 'pages');

    expect(
      detectRouterStyle(
        routeMapOf(pages),
        fakeProbe({ directories: ['app'], files: ['app/layout.tsx'] }),
      ),
    ).toBe('hybrid');
  });
});

describe('detectPackageManager', () => {
  it("lets the target project's own declaration win over its lockfiles", () => {
    // The whole point of the detector: a lockfile left behind by another
    // manager does not override what the project says about itself.
    expect(
      detectPackageManager(
        manifestView({ packageManager: 'npm@10.9.0' }),
        fakeProbe({ files: ['pnpm-lock.yaml'] }),
      ),
    ).toBe('npm');
  });

  it('reads a bare manager name and a Corepack specifier alike, in any case', () => {
    expect(detectPackageManager(manifestView({ packageManager: 'yarn' }), EMPTY_PROBE)).toBe(
      'yarn',
    );
    expect(detectPackageManager(manifestView({ packageManager: 'bun@1.3.9' }), EMPTY_PROBE)).toBe(
      'bun',
    );
    expect(
      detectPackageManager(manifestView({ packageManager: '  PNPM@12.4.2  ' }), EMPTY_PROBE),
    ).toBe('pnpm');
  });

  it('treats a declaration it does not recognise as no declaration', () => {
    expect(
      detectPackageManager(
        manifestView({ packageManager: 'some-other-manager@3.1.0' }),
        fakeProbe({ files: ['yarn.lock'] }),
      ),
    ).toBe('yarn');
    expect(
      detectPackageManager(
        manifestView({ packageManager: 'some-other-manager@3.1.0' }),
        EMPTY_PROBE,
      ),
    ).toBe('unknown');
  });

  it('identifies a manager from its lockfile', () => {
    const byLockfile: readonly (readonly [string, string])[] = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['package-lock.json', 'npm'],
      ['npm-shrinkwrap.json', 'npm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['bun.lock', 'bun'],
    ];

    for (const [lockfile, manager] of byLockfile) {
      expect(detectPackageManager(undefined, fakeProbe({ files: [lockfile] }))).toBe(manager);
    }
  });

  it('counts managers rather than files, so one manager with two lockfiles is one answer', () => {
    expect(
      detectPackageManager(
        undefined,
        fakeProbe({ files: ['package-lock.json', 'npm-shrinkwrap.json'] }),
      ),
    ).toBe('npm');
  });

  it('refuses to choose when two managers left a lockfile behind', () => {
    // The parts of the product that read this field suggest a command line to
    // the developer, so an honest `unknown` costs a prompt where a wrong guess
    // costs a failed command.
    expect(
      detectPackageManager(undefined, fakeProbe({ files: ['pnpm-lock.yaml', 'yarn.lock'] })),
    ).toBe('unknown');
  });

  it('answers unknown when neither a declaration nor a lockfile settles it', () => {
    expect(detectPackageManager(undefined, EMPTY_PROBE)).toBe('unknown');
    expect(detectPackageManager(manifestView({ name: 'silent' }), EMPTY_PROBE)).toBe('unknown');
  });

  it('falls back to the workspace root only where the member is silent', () => {
    const member = manifestView({ name: 'member' });
    const workspaceProbe = fakeProbe({ files: ['pnpm-lock.yaml'] });

    expect(
      detectPackageManager(member, EMPTY_PROBE, {
        manifest: manifestView({ packageManager: 'pnpm@12.4.2' }),
        probe: EMPTY_PROBE,
      }),
    ).toBe('pnpm');
    expect(
      detectPackageManager(member, EMPTY_PROBE, { manifest: undefined, probe: workspaceProbe }),
    ).toBe('pnpm');

    // A member that pins its own manager is stating something about itself,
    // deliberately and against the root's default.
    expect(
      detectPackageManager(manifestView({ packageManager: 'npm@10.9.0' }), EMPTY_PROBE, {
        manifest: manifestView({ packageManager: 'pnpm@12.4.2' }),
        probe: workspaceProbe,
      }),
    ).toBe('npm');

    // And an ambiguous workspace root is as unanswerable as an ambiguous
    // member.
    expect(
      detectPackageManager(member, EMPTY_PROBE, {
        manifest: undefined,
        probe: fakeProbe({ files: ['pnpm-lock.yaml', 'bun.lock'] }),
      }),
    ).toBe('unknown');
  });
});

describe('detectDatabaseAccess', () => {
  it('answers none with no call sites when there is no graph', () => {
    // What a summary built from a manifest alone knows: "no database call sites
    // were found". `callSiteCount` is 0 exactly when the style is `none`, which
    // the type documents as one fact.
    expect(
      detectDatabaseAccess(
        undefined,
        manifestView({ dependencies: { pg: '8.23.0' } }),
        EMPTY_PROBE,
      ),
    ).toEqual({ style: 'none', callSiteCount: 0 });
  });

  it('derives the style from call sites and their driver', () => {
    const prismaOnly = graphOf([
      dbCallNode('db:1', 'prisma', 'src/data.ts'),
      dbCallNode('db:2', 'prisma', 'src/data.ts'),
    ]);
    const pgOnly = graphOf([dbCallNode('db:1', 'pg', 'src/data.ts')]);
    const both = graphOf([
      dbCallNode('db:1', 'prisma', 'src/data.ts'),
      dbCallNode('db:2', 'pg', 'src/data.ts'),
      dbCallNode('db:3', 'pg', 'src/data.ts'),
    ]);

    expect(detectDatabaseAccess(prismaOnly, undefined, EMPTY_PROBE)).toEqual({
      style: 'prisma',
      callSiteCount: 2,
    });
    expect(detectDatabaseAccess(pgOnly, undefined, EMPTY_PROBE)).toEqual({
      style: 'pg',
      callSiteCount: 1,
    });
    expect(detectDatabaseAccess(both, undefined, EMPTY_PROBE)).toEqual({
      style: 'both',
      callSiteCount: 3,
    });
  });

  it('never raises the style from a declared dependency or a schema file', () => {
    // A project can declare a client it no longer calls, and a schema file on
    // disk is not access either. Raising the style from either would produce
    // `prisma` with no call sites — contradicting the type — and would make the
    // Prisma and Postgres adapters require a dev-server preload for a session
    // whose capture could never contain a database span.
    const empty = graphOf([fileNode('file:1', 'src/data.ts', [])]);
    const manifest = manifestView({
      dependencies: { '@prisma/client': '7.10.0', pg: '8.23.0' },
      devDependencies: { prisma: '7.10.0' },
    });
    const probe = fakeProbe({ files: ['prisma/schema.prisma'] });

    expect(detectDatabaseAccess(empty, manifest, probe)).toEqual({
      style: 'none',
      callSiteCount: 0,
    });
  });

  it('names the module that constructs each handle', () => {
    const graph = graphOf([
      dbCallNode('db:1', 'prisma', 'src/services/catalog.ts'),
      dbCallNode('db:2', 'pg', 'src/services/inventory.ts'),
      fileNode('file:1', 'src/db/client.ts', [
        { specifier: '@prisma/client', typeOnly: false, names: ['PrismaClient'] },
      ]),
      fileNode('file:2', 'src/db/pool.ts', [{ specifier: 'pg', typeOnly: false, names: ['Pool'] }]),
    ]);

    expect(detectDatabaseAccess(graph, undefined, EMPTY_PROBE)).toEqual({
      style: 'both',
      prismaClientModule: 'src/db/client.ts',
      pgPoolModule: 'src/db/pool.ts',
      callSiteCount: 2,
    });
  });

  it('recognises a client generated into the project tree, and a re-exported driver', () => {
    const graph = graphOf([
      dbCallNode('db:1', 'prisma', 'src/services/catalog.ts'),
      dbCallNode('db:2', 'pg', 'src/services/inventory.ts'),
      fileNode('file:1', 'src/db/client.ts', [
        { specifier: '../generated/prisma/client', typeOnly: false, names: ['PrismaClient'] },
      ]),
      fileNode('file:2', 'src/db/pool.ts', [
        { specifier: './vendor/pg', typeOnly: false, names: ['Pool'] },
      ]),
    ]);

    const info = detectDatabaseAccess(graph, undefined, EMPTY_PROBE);

    expect(info.prismaClientModule).toBe('src/db/client.ts');
    expect(info.pgPoolModule).toBe('src/db/pool.ts');
  });

  it('ignores a type-only import, because importing types constructs nothing', () => {
    const graph = graphOf([
      dbCallNode('db:1', 'prisma', 'src/services/catalog.ts'),
      fileNode('file:1', 'src/db/types.ts', [
        { specifier: '@prisma/client', typeOnly: true, names: ['PrismaClient'] },
      ]),
    ]);

    expect(detectDatabaseAccess(graph, undefined, EMPTY_PROBE)).toEqual({
      style: 'prisma',
      callSiteCount: 1,
    });
  });

  it('accepts a bindingless import only where the project corroborates the library', () => {
    const graph = graphOf([
      dbCallNode('db:1', 'pg', 'src/services/inventory.ts'),
      fileNode('file:1', 'src/db/pool.ts', [{ specifier: 'pg', typeOnly: false, names: [] }]),
    ]);

    expect(detectDatabaseAccess(graph, undefined, EMPTY_PROBE).pgPoolModule).toBeUndefined();
    expect(
      detectDatabaseAccess(graph, manifestView({ dependencies: { pg: '8.23.0' } }), EMPTY_PROBE)
        .pgPoolModule,
    ).toBe('src/db/pool.ts');
  });

  it('reports the lexicographically first module and skips an unsafe path', () => {
    const importsPool: readonly ExternalImportRef[] = [
      { specifier: 'pg', typeOnly: false, names: ['Pool'] },
    ];
    const graph = graphOf([
      dbCallNode('db:1', 'pg', 'src/services/inventory.ts'),
      fileNode('file:1', 'src/z-pool.ts', importsPool),
      fileNode('file:2', 'src/a-pool.ts', importsPool),
      fileNode('file:3', '../outside/pool.ts', importsPool),
    ]);

    expect(detectDatabaseAccess(graph, undefined, EMPTY_PROBE).pgPoolModule).toBe('src/a-pool.ts');
  });

  it('prefers the shared handle module over a seed or script that constructs its own', () => {
    // The seed and the script both sort before `src/`, so a path order alone
    // would name them. Neither runs inside the dev server, and the services the
    // application runs import the `src/db` modules instead.
    const graph = graphOf(
      [
        dbCallNode('db:1', 'prisma', 'src/services/catalog.ts'),
        dbCallNode('db:2', 'pg', 'src/services/inventory.ts'),
        dbCallNode('db:3', 'prisma', 'prisma/seed.ts'),
        dbCallNode('db:4', 'pg', 'scripts/backfill.ts'),
        fileNode('file:seed', 'prisma/seed.ts', [
          { specifier: '@prisma/client', typeOnly: false, names: ['PrismaClient'] },
          { specifier: 'pg', typeOnly: false, names: ['Pool'] },
        ]),
        fileNode('file:script', 'scripts/backfill.ts', [
          { specifier: 'pg', typeOnly: false, names: ['Pool'] },
        ]),
        fileNode('file:client', 'src/db/client.ts', [
          { specifier: '@prisma/client', typeOnly: false, names: ['PrismaClient'] },
        ]),
        fileNode('file:pool', 'src/db/pool.ts', [
          { specifier: 'pg', typeOnly: false, names: ['Pool'] },
        ]),
        fileNode('file:catalog', 'src/services/catalog.ts', []),
        fileNode('file:inventory', 'src/services/inventory.ts', []),
      ],
      [importEdge('file:catalog', 'file:client'), importEdge('file:inventory', 'file:pool')],
    );

    expect(detectDatabaseAccess(graph, undefined, EMPTY_PROBE)).toEqual({
      style: 'both',
      prismaClientModule: 'src/db/client.ts',
      pgPoolModule: 'src/db/pool.ts',
      callSiteCount: 4,
    });
  });

  it('ranks an imported application module first, counting only application importers', () => {
    const importsPool: readonly ExternalImportRef[] = [
      { specifier: 'pg', typeOnly: false, names: ['Pool'] },
    ];
    const nodes = [
      dbCallNode('db:1', 'pg', 'src/services/inventory.ts'),
      fileNode('file:a', 'src/a-pool.ts', importsPool),
      fileNode('file:m', 'src/m-pool.ts', importsPool),
      fileNode('file:z', 'src/z-pool.ts', importsPool),
      fileNode('file:inventory', 'src/services/inventory.ts', []),
      fileNode('file:load', 'scripts/load.ts', []),
    ];

    // The one module an application module imports wins, whatever its path.
    expect(
      detectDatabaseAccess(
        graphOf(nodes, [importEdge('file:inventory', 'file:z'), importEdge('file:load', 'file:m')]),
        undefined,
        EMPTY_PROBE,
      ).pgPoolModule,
    ).toBe('src/z-pool.ts');

    // An import from a script does not make a module the application's own
    // handle, so the lexicographic order decides between the unshared modules;
    // and a module importing itself shares nothing.
    expect(
      detectDatabaseAccess(
        graphOf(nodes, [importEdge('file:load', 'file:m'), importEdge('file:z', 'file:z')]),
        undefined,
        EMPTY_PROBE,
      ).pgPoolModule,
    ).toBe('src/a-pool.ts');
  });

  it('still names a tooling module when it is the only construction site', () => {
    const graph = graphOf([
      dbCallNode('db:1', 'prisma', 'prisma/seed.ts'),
      fileNode('file:seed', 'prisma/seed.ts', [
        { specifier: '@prisma/client', typeOnly: false, names: ['PrismaClient'] },
      ]),
      fileNode('file:tests', 'tests/client.test.ts', [
        { specifier: '@prisma/client', typeOnly: false, names: ['PrismaClient'] },
      ]),
    ]);

    // Both qualifying modules are tooling, so the path order decides: the
    // answer stays deterministic and the summary still says where the client
    // is built rather than pretending it is built nowhere.
    expect(detectDatabaseAccess(graph, undefined, EMPTY_PROBE).prismaClientModule).toBe(
      'prisma/seed.ts',
    );
  });
});

describe('isToolingModulePath', () => {
  it('recognises seed, migration, script, test and configuration modules', () => {
    for (const path of [
      'prisma/seed.ts',
      'db/seeds.mjs',
      'db/seeds/accounts.ts',
      'src/db/seed/load.ts',
      'seed.ts',
      'db/migrations/x.ts',
      'src/db/migrations/0001_init.ts',
      'scripts/load.ts',
      'script/run.mjs',
      'test/cart.ts',
      'tests/helpers/fixture.ts',
      'e2e/checkout.ts',
      'src/__tests__/cart.ts',
      'src/__mocks__/client.ts',
      'src/__fixtures__/rows.ts',
      'src/cart.test.ts',
      'src/cart.spec.tsx',
      'src/widgets/Gauge.stories.tsx',
      'next.config.ts',
      'vitest.config.mts',
      'prisma.config.ts',
      './prisma/seed.ts',
      'scripts\\load.ts',
    ]) {
      expect(isToolingModulePath(path), path).toBe(true);
    }
  });

  it('leaves application modules alone, including ones that merely share a word', () => {
    for (const path of [
      'src/seedling.ts',
      'src/lib/seed-utils.ts',
      'src/components/Seed.tsx',
      'src/server/db/client.ts',
      'src/server/db/pool.ts',
      'src/config.ts',
      'src/test.ts',
      'src/scripts/editor.ts',
      'src/tests-dashboard/page.tsx',
      'lib/migration.ts',
      'testing/cart.ts',
      'app/api/gauges/route.ts',
      'scripts',
      '',
    ]) {
      expect(isToolingModulePath(path), path).toBe(false);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * 3. The corpus, opened where it lives
 * ---------------------------------------------------------------------------
 */

/** Every route of the corpus, exactly as the summary must project it. */
const CORPUS_ROUTES: readonly Record<string, unknown>[] = [
  { routePath: '/', router: 'app', kind: 'page', file: 'app/page.tsx', methods: ['GET'] },
  {
    routePath: '/api/basins/[...segments]',
    router: 'app',
    kind: 'route-handler',
    file: 'app/(observatory)/api/basins/[...segments]/route.ts',
    methods: ['GET'],
  },
  {
    routePath: '/api/gauge-log',
    router: 'pages',
    kind: 'route-handler',
    file: 'pages/api/gauge-log.ts',
    methods: ['ANY'],
  },
  {
    routePath: '/api/gauges',
    router: 'app',
    kind: 'route-handler',
    file: 'app/api/gauges/route.ts',
    methods: ['GET', 'POST'],
  },
  {
    routePath: '/api/gauges/[id]',
    router: 'app',
    kind: 'route-handler',
    file: 'app/api/gauges/[id]/route.ts',
    methods: ['GET'],
  },
  {
    routePath: '/basins/[id]',
    router: 'app',
    kind: 'page',
    file: 'app/(observatory)/basins/[id]/page.tsx',
    methods: ['GET'],
  },
];

/** The route list as plain records, for comparison against {@link CORPUS_ROUTES}. */
function routeRecords(summary: ProjectSummary): readonly Record<string, unknown>[] {
  return summary.routes.map((route) => ({
    routePath: route.routePath,
    router: route.router,
    kind: route.kind,
    file: route.file,
    methods: [...route.methods],
  }));
}

/** Every value in a summary that is a path, `projectRoot` excluded. */
function relativePathsOf(summary: ProjectSummary): readonly string[] {
  const paths: string[] = [...summary.entryPoints, ...summary.notableDirectories];
  for (const route of summary.routes) {
    paths.push(route.file);
  }
  for (const module of [
    summary.databaseAccess.prismaClientModule,
    summary.databaseAccess.pgPoolModule,
    summary.typescript.tsConfigFile,
  ]) {
    if (module !== undefined) {
      paths.push(module);
    }
  }
  return paths;
}

describe('summarizeProject over the sample application', () => {
  it('names the project from its own manifest', () => {
    expect(corpus().summary.projectName).toBe('fixture-observatory-app');
    expect(corpus().summary.projectRoot).toBe(FIXTURE_ROOT);
  });

  it('reports the framework and the version string the manifest declares', () => {
    // The declared range verbatim: the corpus is never installed, so a resolved
    // version does not exist for it and must not be invented.
    expect(corpus().summary.framework).toEqual({ name: 'next', version: '16.3.5' });
  });

  it('reports the hybrid router style the corpus is built to have', () => {
    // An App Router tree *and* one legacy `pages/api` handler, which is the
    // normal state of a codebase mid-migration.
    expect(corpus().summary.routerStyle).toBe('hybrid');
  });

  it('describes the TypeScript setup from the configuration in force', () => {
    // `version` is absent because the corpus manifest declares no compiler: it
    // is TypeScript by its modules and its configuration, and the summary says
    // only what it can see.
    expect(corpus().summary.typescript).toEqual({
      enabled: true,
      strict: true,
      tsConfigFile: 'tsconfig.json',
    });
  });

  it("reports the target project's package manager, never this repository's pin", () => {
    // The corpus manifest declares `npm@10.9.0` precisely as this assertion
    // hook: the repository the tool ships from pins pnpm, and a developer's
    // project is the only authority on the question. The second assertion is
    // the mechanism that keeps the pin from leaking — `findWorkspaceRoot`
    // accepts an ancestor only when the project matches one of its declared
    // member patterns, and a fixture nested under `packages/<name>/test/...`
    // matches none, so no workspace fallback is even built here.
    expect(corpus().summary.packageManager).toBe('npm');
    expect(findWorkspaceRoot(FIXTURE_ROOT)).toBeUndefined();
  });

  it('reports database access derived from the graph, both drivers and no module', () => {
    // The corpus reaches its data through the generated client *and* the raw
    // driver, from one module, which is what makes `both` assertable without
    // inventing inputs. No construction module is named, and that is correct
    // rather than a gap: the corpus builds its two handles from a *relative*
    // module of its own, so no external construction specifier exists for the
    // detector to recognise — a summary that named one anyway would be
    // guessing.
    expect(corpus().summary.databaseAccess).toEqual({ style: 'both', callSiteCount: 4 });

    const callSiteFiles = new Set(
      corpus()
        .graph.nodesByKind('db-call')
        .map((node) => node.file),
    );
    expect([...callSiteFiles]).toEqual(['src/lib/station-service.ts']);
  });

  it('reports every route of the corpus, sorted by path', () => {
    expect(routeRecords(corpus().summary)).toEqual(CORPUS_ROUTES);
  });

  it('ranks the entry points a developer would recognise', () => {
    // The order is `(rank, path)`: the document that wraps everything, the
    // module the landing URL renders, then the modules that answer requests.
    // It is also the order in which they survive the byte budget.
    expect([...corpus().summary.entryPoints]).toEqual([
      'app/layout.tsx',
      'app/page.tsx',
      'app/(observatory)/api/basins/[...segments]/route.ts',
      'app/api/gauges/[id]/route.ts',
      'app/api/gauges/route.ts',
      'pages/api/gauge-log.ts',
    ]);
    expect(corpus().summary.entryPoints.length).toBeLessThanOrEqual(
      PROJECT_SUMMARY_LIMITS.maxEntryPoints,
    );
  });

  it('lists the directories the files are actually in, as paths and nothing else', () => {
    // Derived from where the files are rather than from a list of conventional
    // names, ordered by file count descending then path ascending, and capped
    // at the first two levels. The counts are the ordering key and are
    // deliberately not reported — a per-directory census would spend the byte
    // budget on detail the understanding stage does not act on.
    expect([...corpus().summary.notableDirectories]).toEqual([
      'src',
      'app',
      'src/lib',
      'src/widgets',
      'app/(observatory)',
      'app/api',
      'pages',
      'pages/api',
    ]);

    for (const directory of corpus().summary.notableDirectories) {
      expect(directory.split('/').length).toBeLessThanOrEqual(2);
    }
  });

  it('reports the dependencies it recognises, framework family first', () => {
    expect([...corpus().summary.dependencies]).toEqual([
      { name: 'next', versionRange: '16.3.5', dev: false },
      { name: 'react', versionRange: '19.3.0', dev: false },
      { name: 'react-dom', versionRange: '19.3.0', dev: false },
    ]);
  });

  it('reports uncapped counts that mirror the graph, with the fixed corpus invariants', () => {
    const graph = corpus().graph;
    const fromGraph: ProjectSummaryCounts = {
      files: graph.nodesByKind('file').length,
      symbols: graph.nodesByKind('symbol').length,
      components: graph.nodesByKind('component').length,
      handlers: graph.nodesByKind('handler').length,
      apiCalls: graph.nodesByKind('api-call').length,
      apiRoutes: graph.nodesByKind('api-route').length,
      serverFunctions: graph.nodesByKind('server-function').length,
      dbCalls: graph.nodesByKind('db-call').length,
    };

    // The contract first: with a graph, every count is that graph's per-kind
    // bucket size, so a consumer can always tell how much of the project the
    // capped lists are a sample of.
    expect(corpus().summary.counts).toEqual(fromGraph);

    // Then the corpus invariants the fixture's own contract notes fix: fifteen
    // TypeScript modules plus the framework configuration module, exactly three
    // network call sites, four database call sites, six routes.
    expect(corpus().summary.counts.files).toBe(16);
    expect(corpus().summary.counts.apiCalls).toBe(3);
    expect(corpus().summary.counts.dbCalls).toBe(4);
    expect(corpus().summary.counts.apiRoutes).toBe(6);

    // And the remaining kinds are populated rather than silently zero, which is
    // what would happen if an extractor stopped contributing.
    expect(corpus().summary.counts.symbols).toBeGreaterThan(0);
    expect(corpus().summary.counts.components).toBeGreaterThan(0);
    expect(corpus().summary.counts.handlers).toBeGreaterThan(0);
    expect(corpus().summary.counts.serverFunctions).toBeGreaterThan(0);
  });

  it('keeps every path project-relative POSIX, with projectRoot the only absolute one', () => {
    const summary = corpus().summary;

    for (const path of relativePathsOf(summary)) {
      expect(isSafeRelativePath(path)).toBe(true);
      expect(path).not.toContain('\\');
      expect(path.startsWith('/')).toBe(false);
    }

    // The host-path check, over the whole serialised object with the one
    // permitted absolute path removed: a developer's directory layout must not
    // reach a prompt or anything rendered from one.
    const withoutRoot = JSON.stringify({ ...summary, projectRoot: '' });
    expect(withoutRoot).not.toContain(FIXTURE_ROOT);
    expect(withoutRoot).not.toContain(toPosix(tmpdir()));
    expect(withoutRoot).not.toContain('\\');
  });

  it('agrees with itself when built from a graph alone or from an index alone', () => {
    // Without a route map the routes come from the graph's `api-route` nodes,
    // and an index is turned into a graph before anything is counted. All three
    // inputs therefore have to describe one project.
    const fromGraph = summarizeProject({ loaded: corpus().loaded, graph: corpus().graph });
    const fromIndex = summarizeProject({ loaded: corpus().loaded, index: corpus().index });

    expect(routeRecords(fromGraph)).toEqual(CORPUS_ROUTES);
    expect(routeRecords(fromIndex)).toEqual(CORPUS_ROUTES);
    expect(fromIndex.counts).toEqual(corpus().summary.counts);
    expect(fromGraph.databaseAccess).toEqual(corpus().summary.databaseAccess);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 4. Boundedness, determinism, privacy and degradation
 * ---------------------------------------------------------------------------
 */

/** The corpus summarised under `limits`, which every boundedness case needs. */
function corpusSummaryWith(
  limits: Partial<typeof PROJECT_SUMMARY_LIMITS>,
  logger?: Logger,
): ProjectSummary {
  const { loaded, graph, routeMap } = corpus();
  return summarizeProject({ loaded, graph, routeMap, limits, logger });
}

describe('boundedness', () => {
  it('stays within every cap and within the byte budget under the default limits', () => {
    const summary = corpus().summary;

    expect(summary.entryPoints.length).toBeLessThanOrEqual(PROJECT_SUMMARY_LIMITS.maxEntryPoints);
    expect(summary.routes.length).toBeLessThanOrEqual(PROJECT_SUMMARY_LIMITS.maxRoutes);
    expect(summary.notableDirectories.length).toBeLessThanOrEqual(
      PROJECT_SUMMARY_LIMITS.maxDirectories,
    );
    expect(summary.dependencies.length).toBeLessThanOrEqual(PROJECT_SUMMARY_LIMITS.maxDependencies);
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(
      PROJECT_SUMMARY_LIMITS.maxTotalBytes,
    );

    // A complete summary of an ordinary application fits the budget, so the
    // trimming pass is the exception rather than the rule.
    expect(summary.truncated).toBe(false);
  });

  it('trims each list to its cap, keeps the most valuable items and says so', () => {
    const summary = corpusSummaryWith({
      maxEntryPoints: 1,
      maxRoutes: 1,
      maxDirectories: 1,
      maxDependencies: 1,
    });

    expect(summary.entryPoints).toEqual(['app/layout.tsx']);
    expect(summary.routes.map((route) => route.routePath)).toEqual(['/']);
    expect(summary.notableDirectories).toEqual(['src']);
    expect(summary.dependencies.map((dependency) => dependency.name)).toEqual(['next']);
    expect(summary.truncated).toBe(true);

    // The counts are never capped: "there are six routes" and "you have been
    // shown one of six routes" lead to opposite conclusions.
    expect(summary.counts).toEqual(corpus().summary.counts);
  });

  it('cannot be made unbounded by an unusable limit', () => {
    const summary = corpusSummaryWith({
      maxEntryPoints: Number.POSITIVE_INFINITY,
      maxRoutes: Number.NaN,
      maxDirectories: -5,
      maxDependencies: 2.7,
    });

    // A non-finite override falls back to the default, a negative count is held
    // at its minimum and a fraction floors, so no combination of inputs turns a
    // bounded summary into an unbounded one.
    expect(summary.entryPoints.length).toBe(corpus().summary.entryPoints.length);
    expect(summary.routes.length).toBe(corpus().summary.routes.length);
    expect(summary.notableDirectories).toEqual([]);
    expect(summary.dependencies.length).toBe(2);
    expect(summary.truncated).toBe(true);
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(
      PROJECT_SUMMARY_LIMITS.maxTotalBytes,
    );
  });

  it('clamps free text but drops an oversized path instead of shortening it', () => {
    const summary = corpusSummaryWith({ maxStringLength: 16 });

    // A shortened label is still a usable label...
    expect(summary.projectName).toBe('fixture-observa…');

    // ...while a shortened path names a file that does not exist, so the items
    // whose paths are too long are absent rather than mangled.
    for (const path of relativePathsOf(summary)) {
      expect(path.length).toBeLessThanOrEqual(16);
      expect(path).not.toContain('…');
      expect(isSafeRelativePath(path)).toBe(true);
    }
    expect(summary.entryPoints).toEqual(['app/layout.tsx', 'app/page.tsx']);
    expect(summary.routes.map((route) => route.routePath)).toEqual(['/']);
    expect(summary.notableDirectories).not.toContain('app/(observatory)');

    // The counts still describe the whole project, which is how a consumer can
    // tell that what it is looking at is a sample.
    expect(summary.counts).toEqual(corpus().summary.counts);
  });

  it('gives up the lowest-value list first as the byte budget tightens', () => {
    const full = corpus().summary;
    // Every budget below is smaller than the corpus summary, so each one forces
    // the trimming pass; the smallest cannot be satisfied at all.
    const budgets: readonly number[] = [1700, 1500, 1300, 1100, 900, 700, 500, 400, 300, 200, 1];

    for (const maxTotalBytes of budgets) {
      const summary = corpusSummaryWith({ maxTotalBytes });

      // The documented precedence, stated as an invariant rather than as a
      // table of expected lengths: dependencies are corroborating detail,
      // directories are orientation, routes are matched against captured
      // requests, and entry points are where an investigation starts. A list is
      // only touched once every lower-value list is empty.
      if (summary.notableDirectories.length < full.notableDirectories.length) {
        expect(summary.dependencies).toEqual([]);
      }
      if (summary.routes.length < full.routes.length) {
        expect(summary.notableDirectories).toEqual([]);
      }
      if (summary.entryPoints.length < full.entryPoints.length) {
        expect(summary.routes).toEqual([]);
      }

      // Items are taken from the end, so what survives is a prefix of the full
      // list rather than an arbitrary subset.
      expect([...summary.entryPoints]).toEqual(
        full.entryPoints.slice(0, summary.entryPoints.length),
      );
      expect(routeRecords(summary)).toEqual(CORPUS_ROUTES.slice(0, summary.routes.length));

      expect(summary.truncated).toBe(true);
      expect(summary.counts).toEqual(full.counts);
      if (JSON.stringify(summary).length > maxTotalBytes) {
        // Over budget is only reachable with nothing left to give up.
        expect(summary.entryPoints).toEqual([]);
        expect(summary.routes).toEqual([]);
        expect(summary.notableDirectories).toEqual([]);
        expect(summary.dependencies).toEqual([]);
      }
    }
  });

  it('warns rather than misreporting when an empty summary still exceeds the budget', () => {
    const { logger, records } = recordingLogger();
    const summary = corpusSummaryWith({ maxTotalBytes: 1 }, logger);

    expect(summary.entryPoints).toEqual([]);
    expect(summary.routes).toEqual([]);
    expect(summary.notableDirectories).toEqual([]);
    expect(summary.dependencies).toEqual([]);
    expect(summary.truncated).toBe(true);
    expect(
      logged(
        records,
        'warn',
        'project summary exceeds its byte budget with every list already empty',
      ),
    ).toBe(true);

    // The identity block and the counts are never given up: they are what makes
    // a summary usable when every list has gone.
    expect(summary.projectName).toBe(corpus().summary.projectName);
    expect(summary.framework).toEqual(corpus().summary.framework);
    expect(summary.routerStyle).toBe(corpus().summary.routerStyle);
    expect(summary.databaseAccess).toEqual(corpus().summary.databaseAccess);
    expect(summary.counts).toEqual(corpus().summary.counts);
  });
});

describe('determinism and purity', () => {
  it('produces byte-identical JSON across calls, generatedAt excepted', () => {
    const { loaded, graph, routeMap } = corpus();
    const first = summarizeProject({ loaded, graph, routeMap });
    const second = summarizeProject({ loaded, graph, routeMap });

    // The timestamp is the single documented exemption, so it is normalised
    // explicitly rather than ignored by accident — and it is normalised to a
    // value neither call could have produced.
    expect(JSON.stringify({ ...first, generatedAt: 0 })).toBe(
      JSON.stringify({ ...second, generatedAt: 0 }),
    );
    expect(first.generatedAt).toBeGreaterThan(0);
    expect(second.generatedAt).toBeGreaterThanOrEqual(first.generatedAt);
  });

  it('mutates nothing it is given, and hands back a frozen object', () => {
    const { loaded, graph, routeMap } = corpus();
    const entriesBefore = JSON.stringify(routeMap.entries);
    const limits: Partial<typeof PROJECT_SUMMARY_LIMITS> = { maxRoutes: 2 };

    const summary = summarizeProject({ loaded, graph, routeMap, limits });

    expect(JSON.stringify(routeMap.entries)).toBe(entriesBefore);
    expect(limits).toEqual({ maxRoutes: 2 });
    expect(PROJECT_SUMMARY_LIMITS).toEqual({
      maxEntryPoints: 25,
      maxRoutes: 40,
      maxDirectories: 25,
      maxDependencies: 40,
      maxStringLength: 200,
      maxTotalBytes: 8192,
    });
    expect(Object.isFrozen(PROJECT_SUMMARY_LIMITS)).toBe(true);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.routes)).toBe(true);
    expect(Object.isFrozen(summary.entryPoints)).toBe(true);
    expect(Object.isFrozen(summary.notableDirectories)).toBe(true);
    expect(Object.isFrozen(summary.dependencies)).toBe(true);
  });
});

/**
 * A dense, opaque literal planted in a source module of the privacy sandbox.
 *
 * It stands in for whatever a developer's own module happens to contain — an
 * encoded fixture, a hash, a key they should not have committed — and the point
 * of the case is that the summary carries source *paths* and never source
 * *contents*, whatever those contents are.
 */
const PLANTED_OPAQUE_MARKER = 'Zm9vYmFyMDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3A';

/** A table name that exists only inside the planted statement. */
const PLANTED_TABLE = 'planted_observation_notes';

/** The module planted in the privacy sandbox, shaped like the corpus's own data layer. */
function plantedModuleSource(): string {
  return [
    "import { pool } from './datastore';",
    '',
    `const OPAQUE_MARKER = '${PLANTED_OPAQUE_MARKER}';`,
    `const configuredLabel = process.env.${PLANTED_ENV_NAME} ?? OPAQUE_MARKER;`,
    '',
    'export async function countObservationNotes(basinId: string): Promise<number> {',
    '  const result = await pool.query(',
    `    'SELECT note_id FROM ${PLANTED_TABLE} WHERE basin_id = $1 AND label = $2',`,
    '    [basinId, configuredLabel],',
    '  );',
    '  return result.rowCount ?? 0;',
    '}',
    '',
  ].join('\n');
}

/**
 * The secret shapes of AAP 0.5.2, each assembled from fragments.
 *
 * Assembled rather than written whole for the reason `scripts/check-secrets.mjs`
 * assembles its own: this file is tracked content and is scanned like any
 * other, and a contiguous credential shape in a test is still a finding. The
 * runtime patterns are the complete shapes.
 */
const SECRET_SHAPES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'model provider key', pattern: new RegExp('s' + 'k-' + '[A-Za-z0-9_-]{8,}') },
  { label: 'source-control token', pattern: new RegExp('gh' + 'p_' + '[A-Za-z0-9]{8,}') },
  { label: 'cloud access key id', pattern: new RegExp('AK' + 'IA' + '[A-Z0-9]{8,}') },
  {
    label: 'compact web token',
    pattern: new RegExp('ey' + 'J' + '[A-Za-z0-9_-]{6,}' + '\\.' + '[A-Za-z0-9_-]{6,}' + '\\.'),
  },
  {
    label: 'credentialed connection string',
    pattern: new RegExp(
      '[a-z][a-z0-9+.-]*' + ':' + '\\/\\/' + '[^/\\s:@]+' + ':' + '[^/\\s:@]+' + '@',
      'i',
    ),
  },
];

describe('privacy', () => {
  it('carries no environment path, no environment value and no source text', async () => {
    const root = corpusCopy('privacy');
    plantFile(root, '.env', envFileContents());
    plantFile(root, '.env.local', envFileContents());
    plantFile(root, 'src/lib/observation-notes.ts', plantedModuleSource());

    const loaded = openAt(root);
    const routeMap = buildRouteMap(loaded);
    const indexed = await indexProject({ projectRoot: root, loaded, cache: false });
    if (!indexed.ok) {
      throw new Error(`the sandbox did not index: ${indexed.error.message}`);
    }
    const summary = summarizeProject({ loaded, graph: indexed.value.graph, routeMap });
    const serialized = JSON.stringify(summary);

    // The graph really does hold the planted statement's text, so the
    // assertions below are a boundary rather than an empty input: the module
    // this suite tests is what refuses to relay it.
    const plantedCalls = indexed.value.graph
      .nodesByKind('db-call')
      .filter((node) => node.file === 'src/lib/observation-notes.ts');
    expect(plantedCalls.length).toBeGreaterThan(0);
    expect(
      plantedCalls.some((node) => (node.data.statementShape ?? '').includes(PLANTED_TABLE)),
    ).toBe(true);

    // No environment file, by path or by name, and no value out of one.
    expect(serialized).not.toContain('.env');
    expect(serialized).not.toContain(PLANTED_ENV_NAME);
    expect(serialized).not.toContain(PLANTED_ENV_VALUE);

    // No source contents: not the opaque literal, not a fragment of it, not
    // the statement, not the statement's table, not a source line.
    expect(serialized).not.toContain(PLANTED_OPAQUE_MARKER);
    expect(serialized).not.toContain(PLANTED_OPAQUE_MARKER.slice(0, 16));
    expect(serialized).not.toContain(PLANTED_TABLE);
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('OPAQUE_MARKER');
    expect(serialized).not.toContain('countObservationNotes');

    // And nothing shaped like a credential, whatever its origin.
    for (const shape of SECRET_SHAPES) {
      expect(serialized, `a ${shape.label} reached the summary`).not.toMatch(shape.pattern);
    }

    // What the summary *is* allowed to carry, so the case cannot pass by
    // producing nothing: the planted module's path is part of the layout, and
    // its call site is part of the count.
    expect(summary.counts.files).toBe(corpus().summary.counts.files + 1);
    expect(summary.counts.dbCalls).toBeGreaterThan(corpus().summary.counts.dbCalls);
    expect(summary.notableDirectories).toContain('src/lib');
  }, 120_000);
});

describe('degradation', () => {
  it('describes a project whose manifest was deleted', () => {
    const root = corpusCopy('no-manifest');
    removePath(root, 'package.json');
    const loaded = openAt(root);
    const summary = summarizeProject({ loaded, routeMap: buildRouteMap(loaded) });

    // Named after its own directory, since nothing declares a name...
    expect(summary.projectName).toBe('target');
    // ...and still recognised as a framework project, because its configuration
    // module is on disk whatever its dependencies say.
    expect(summary.framework).toEqual({ name: 'next' });
    expect(summary.packageManager).toBe('unknown');
    expect(summary.dependencies).toEqual([]);
    expect(summary.typescript.enabled).toBe(true);
    expect(summary.typescript.version).toBeUndefined();
    expect(summary.routerStyle).toBe('hybrid');
    expect(routeRecords(summary)).toEqual(CORPUS_ROUTES);
  });

  it('treats a malformed manifest exactly as a missing one', () => {
    const root = corpusCopy('malformed-copy');
    plantFile(root, 'package.json', '{ "name": "half-written",');
    const loaded = openAt(root);
    const summary = summarizeProject({ loaded, routeMap: buildRouteMap(loaded) });

    expect(summary.projectName).toBe('target');
    expect(summary.framework).toEqual({ name: 'next' });
    expect(summary.packageManager).toBe('unknown');
    expect(summary.dependencies).toEqual([]);
  });

  it('says none about database access when it has no graph to read', () => {
    // A summary built from a manifest and a route map alone knows that no call
    // site was found, which is exactly what it reports — never the style its
    // dependencies would suggest.
    const summary = summarizeProject({
      loaded: corpus().loaded,
      routeMap: corpus().routeMap,
    });

    expect(summary.databaseAccess).toEqual({ style: 'none', callSiteCount: 0 });
    expect(summary.counts).toEqual({
      files: corpus().summary.counts.files,
      symbols: 0,
      components: 0,
      handlers: 0,
      apiCalls: 0,
      apiRoutes: corpus().routeMap.entries.length,
      serverFunctions: 0,
      dbCalls: 0,
    });
  });

  it('reports the App Router alone once the legacy tree is gone', () => {
    const root = corpusCopy('app-only');
    removePath(root, 'pages');
    const loaded = openAt(root);
    const summary = summarizeProject({ loaded, routeMap: buildRouteMap(loaded) });

    expect(summary.routerStyle).toBe('app');
    expect(summary.routes.every((route) => route.router === 'app')).toBe(true);
    expect(summary.routes.length).toBe(CORPUS_ROUTES.length - 1);
    expect(summary.entryPoints).not.toContain('pages/api/gauge-log.ts');
    expect(summary.notableDirectories).not.toContain('pages');
  });

  it('falls back to the lockfiles once the declaration is gone, and refuses when they disagree', () => {
    const root = corpusCopy('lockfiles');
    plantFile(
      root,
      'package.json',
      `${JSON.stringify({ name: 'declares-no-manager', dependencies: { next: '16.3.5' } })}\n`,
    );
    const loaded = openAt(root);
    const routeMap = buildRouteMap(loaded);

    // Nothing declares a manager and no lockfile is present. This repository
    // pins pnpm, and a project that says nothing must still answer `unknown`.
    expect(summarizeProject({ loaded, routeMap }).packageManager).toBe('unknown');

    plantFile(root, 'yarn.lock', '# lockfile of the sandbox target\n');
    expect(summarizeProject({ loaded, routeMap }).packageManager).toBe('yarn');

    // Two managers' lockfiles are genuinely ambiguous, and the product suggests
    // command lines from this field.
    plantFile(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    expect(summarizeProject({ loaded, routeMap }).packageManager).toBe('unknown');
  });

  it('describes a project with nothing in it at all', () => {
    const root = newSandbox('empty-project');
    const loaded = openAt(root);
    const summary = summarizeProject({ loaded });

    expect(summary.projectName).toBe(summary.projectRoot.split('/').at(-1));
    expect(summary.framework).toEqual({ name: 'unknown' });
    expect(summary.routerStyle).toBe('none');
    expect(summary.packageManager).toBe('unknown');
    expect(summary.typescript.enabled).toBe(false);
    expect(summary.databaseAccess).toEqual({ style: 'none', callSiteCount: 0 });
    expect(summary.entryPoints).toEqual([]);
    expect(summary.routes).toEqual([]);
    expect(summary.notableDirectories).toEqual([]);
    expect(summary.dependencies).toEqual([]);
    expect(summary.counts).toEqual({
      files: 0,
      symbols: 0,
      components: 0,
      handlers: 0,
      apiCalls: 0,
      apiRoutes: 0,
      serverFunctions: 0,
      dbCalls: 0,
    });
    expect(summary.truncated).toBe(false);
  });
});
