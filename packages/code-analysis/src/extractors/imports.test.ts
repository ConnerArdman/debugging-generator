/**
 * Unit suite for `./imports.ts` — the extractor that owns the `file` node of
 * every visited module, every `imports` edge and every `exports` edge.
 *
 * ## What it pins, and against what
 *
 * The subject is driven against the committed corpus
 * `../../test/fixtures/sample-next-app`: a generic Next.js application that
 * exists to be indexed, whose invariants are deliberately fixed and documented
 * in its own files. Those invariants are the specification here, so the counts
 * below are written as exact numbers rather than lower bounds — **if an
 * assertion in this file starts failing, the extractor is almost always what
 * changed, not the expectation.**
 *
 * The corpus' entire coverage of two behaviours lives in three declarations and
 * one module, which is why both are pinned to the specimen:
 *
 * - **External-module tolerance.** The corpus declares `next`, `react` and
 *   `react-dom` in its manifest and installs none of them, so exactly **three**
 *   module specifiers resolve to nothing: a value named import of `react` in
 *   the client widget, a type-only import of `next/server` in the fetch helper,
 *   and a type-only import of `next` in the single legacy `pages/api` module.
 *   Each is recorded on its own file's `FileNodeData.externalImports` and
 *   produces **no** edge — which is the extractor's core guarantee, since it
 *   proves the specifier was read off the abstract syntax tree rather than
 *   through type resolution.
 * - **Re-export handling.** `src/widgets/index.ts` is the corpus' only module
 *   with module-specifier export declarations, and it carries the four forms
 *   once each — star, named, type-only named and `default as` — for exactly
 *   **four** `exports` edges.
 *
 * ### The documented "two unresolved specifiers" discrepancy
 *
 * `pages/api/gauge-log.ts` says "so the two annotations below resolve to
 * nothing", which reads as a corpus budget of two unresolved specifiers and is
 * not one: it counts the two *type annotations* (`NextApiRequest`,
 * `NextApiResponse`) that its single `next` specifier binds. The folder
 * requirements and that module's own specification both state three
 * specifiers, the committed corpus yields three, and three is what
 * {@link EXPECTED_EXTERNAL_IMPORTS} asserts. A corpus that yields a different
 * set fails the first case of "unresolvable external specifiers" with both
 * sets printed and the discrepancy named — the correct response is to fix
 * whichever side regressed, never to edit the fixture or widen the assertion.
 *
 * ## How the cases are driven
 *
 * Two harnesses, and the split is deliberate:
 *
 * - The **corpus** is opened once with `openProject` and every one of its files
 *   is handed to `importsExtractor.extract` through an `ExtractorContext` built
 *   exactly as `../indexer.ts` builds one — same `file` (through
 *   `LoadedProject.projectRelative`), same `projectRoot`, same logger contract.
 *   The index is additionally built twice with `buildIndex` and assembled with
 *   `CodeGraph.fromIndex`: once over this extractor **alone**, which is what
 *   makes a `dangling-edge` finding attributable — every edge in that index
 *   came from here, so zero such findings is a statement about this extractor
 *   rather than about the extractor set — and once over the whole default set,
 *   which is the only way to see an edge of this extractor's dropped because of
 *   something another one emitted.
 * - A **scratch project** under `os.mkdtemp` carries the malformed and
 *   unresolvable shapes. The corpus is read-only — every case that needs a
 *   different module writes it there instead, the directory is removed in
 *   `afterAll`, and a byte snapshot of the corpus taken before it is opened is
 *   compared against the tree afterwards, so a write into the checkout fails
 *   this suite rather than being noticed later as a dirty `git status`.
 *
 * `git status --porcelain packages/code-analysis` is deliberately **not** shelled
 * out to from a case: while this file is itself untracked it would report this
 * file, which is a false signal rather than a finding. The byte snapshot above
 * is the hermetic form of the same property, and the repository-wide gate
 * covers the version-control form.
 *
 * ## Conventions
 *
 * `describe`/`it`/`expect` are imported explicitly — the `code-analysis` Vitest
 * project runs with `globals: false`. Single-element lookups go through helpers
 * that fail with the whole candidate list rather than through an indexed
 * access, so a case that accidentally matches two declarations says so instead
 * of quietly asserting about the first.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Node, Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isOk, isSafeRelativePath, noopLogger, toPosix } from '@debuggen/shared';

import { CodeGraph, makeNodeId } from '../graph/graph.js';
import { CODE_EDGE_KINDS, isCodeEdgeKind, isCodeNodeKind } from '../graph/types.js';
import type {
  CodeEdge,
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  ExternalImportRef,
  ExtractorContext,
  FileNodeData,
  IndexDiagnostic,
} from '../graph/types.js';
import { DEFAULT_EXTRACTORS, buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import type { LoadedProject } from '../project.js';
import {
  IMPORTS_EXTRACTOR_ID,
  RE_EXPORT_FORMS,
  classifyReExportForm,
  importsExtractor,
} from './imports.js';
import type { ReExportForm } from './imports.js';

/* -------------------------------------------------------------------------------------------------
 * The corpus, and the invariants pinned to it
 * ---------------------------------------------------------------------------------------------- */

/**
 * The read-only indexing corpus, resolved from this file's own URL.
 *
 * From the module URL rather than from `process.cwd()`, so the suite finds the
 * corpus whether it was started by a filtered run from this directory or by the
 * root `pnpm test`.
 */
const FIXTURE_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/** The corpus' manifest, read for the "declared but never installed" assertion. */
const FIXTURE_MANIFEST = join(FIXTURE_ROOT, 'package.json');

/**
 * This repository's root, without a trailing separator.
 *
 * Only ever used as a string an extraction must **not** contain: an index is
 * portable and its node ids are stable across checkouts precisely because no
 * absolute path reaches them, and this repository's own root is the widest
 * prefix a leak from this suite's runs could carry.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/+$/u, '');

/** The corpus' only barrel: the module carrying all four re-export forms. */
const BARREL = 'src/widgets/index.ts';

/** The client widget: the one module with a `"use client"` directive and the `react` import. */
const CLIENT_WIDGET = 'src/widgets/GaugeReadout.tsx';

/** The server widget: no directive, one relative extensionless import of the client widget. */
const SERVER_WIDGET = 'src/widgets/BasinSummary.tsx';

/** The root App Router page: the corpus' only alias-through-a-barrel specifier. */
const ROOT_PAGE = 'app/page.tsx';

/** The root App Router layout: the corpus' only module that imports nothing at all. */
const ROOT_LAYOUT = 'app/layout.tsx';

/** The fetch helper: one type-only import of `next/server` and no edge of its own. */
const FETCH_HELPER = 'src/lib/http.ts';

/** The single legacy Pages Router module: one type-only import of `next`. */
const LEGACY_API = 'pages/api/gauge-log.ts';

/** The server-function layer every route and page of the corpus reaches through the alias. */
const SERVICE = 'src/lib/station-service.ts';

/** The module that declares the corpus' two database handles. */
const DRIVER_HANDLE = 'src/lib/datastore.ts';

/** The local node-postgres stand-in the driver-handle module imports. */
const PG_STUB = 'src/lib/stubs/pg.ts';

/** The local generated-client stand-in the driver-handle module imports. */
const PRISMA_STUB = 'src/lib/stubs/prisma-client.ts';

/**
 * Every indexable file of the corpus, project-relative, in the order
 * `LoadedProject.sourceFiles()` returns them.
 *
 * Written out rather than derived from a walk: an expectation derived from the
 * implementation agrees with whatever it does, including dropping a file, and
 * this suite's per-file assertions are only as strong as the set they cover.
 */
const EXPECTED_FIXTURE_FILES: readonly string[] = [
  'app/(observatory)/api/basins/[...segments]/route.ts',
  'app/(observatory)/basins/[id]/page.tsx',
  'app/api/gauges/[id]/route.ts',
  'app/api/gauges/route.ts',
  ROOT_LAYOUT,
  ROOT_PAGE,
  'next.config.mjs',
  LEGACY_API,
  DRIVER_HANDLE,
  FETCH_HELPER,
  SERVICE,
  PG_STUB,
  PRISMA_STUB,
  SERVER_WIDGET,
  CLIENT_WIDGET,
  BARREL,
];

/**
 * One expected `FileNodeData.externalImports` entry, with the file it belongs
 * to.
 */
interface ExpectedExternalImport {
  /** The importing file, project-relative POSIX. */
  readonly file: string;

  /** The record the extractor must have written for it. */
  readonly ref: ExternalImportRef;
}

/**
 * The corpus' **entire** budget of specifiers that resolve to nothing: three,
 * one per file, sorted by file so the comparison is order-stable.
 *
 * `next` and `next/server` are type-only, which is the distinction that says a
 * dependency was compiled against rather than loaded; `react` is a value
 * import, so the same file's dependency is a runtime one. `memo` sits beside
 * `useState` and `useCallback` because the client widget's memoised specimen
 * was appended to it later — the folder requirements name the first two, and
 * the binding list is pinned in full so a fourth binding has to be noticed
 * here.
 *
 * See the module header for the "two versus three" discrepancy this set
 * settles.
 */
const EXPECTED_EXTERNAL_IMPORTS: readonly ExpectedExternalImport[] = [
  {
    file: LEGACY_API,
    ref: { specifier: 'next', typeOnly: true, names: ['NextApiRequest', 'NextApiResponse'] },
  },
  { file: FETCH_HELPER, ref: { specifier: 'next/server', typeOnly: true, names: ['NextRequest'] } },
  {
    file: CLIENT_WIDGET,
    ref: { specifier: 'react', typeOnly: false, names: ['useState', 'useCallback', 'memo'] },
  },
];

/**
 * The three unresolvable specifiers alone, in the order the corpus' files are
 * visited — which is also their sorted order.
 */
const EXPECTED_UNRESOLVABLE_SPECIFIERS: readonly string[] = ['next', 'next/server', 'react'];

/**
 * What a failure of the external-import cases means, attached to those
 * assertions so the mismatch is reported rather than absorbed.
 *
 * The folder requirements are explicit that the correct response to a mismatch
 * here is to report it and stop — never to edit the corpus and never to weaken
 * the assertion — so the message says which side is the specification.
 */
const DISCREPANCY_MESSAGE = [
  'The corpus must yield exactly three unresolvable module specifiers, one per file:',
  `  ${LEGACY_API} -> next (type-only)`,
  `  ${FETCH_HELPER} -> next/server (type-only)`,
  `  ${CLIENT_WIDGET} -> react (value)`,
  'The corpus is the specification: a different set is a regression in the extractor or in the',
  'corpus, and the fix belongs there rather than here. Note that the "two" in the header of',
  `${LEGACY_API} counts that module's two type ANNOTATIONS, not two specifiers.`,
].join('\n');

/** One expected edge, described by its site and its resolved target. */
interface ExpectedEdge {
  /** The file the declaration is written in, project-relative POSIX. */
  readonly file: string;

  /** The **1-based** line the declaration starts on. */
  readonly line: number;

  /** The specifier exactly as written, before resolution. */
  readonly specifier: string;

  /** The project-relative POSIX path the specifier resolved to. */
  readonly target: string;
}

/**
 * Every `imports` edge the corpus yields: thirteen, seven through a `paths`
 * alias and six through a relative extensionless specifier.
 *
 * Every declaration in the corpus sits at column 1, so the column is asserted
 * once, globally, rather than repeated on each row.
 */
const EXPECTED_IMPORT_EDGES: readonly ExpectedEdge[] = [
  {
    file: 'app/(observatory)/api/basins/[...segments]/route.ts',
    line: 47,
    specifier: '@/lib/station-service',
    target: SERVICE,
  },
  {
    file: 'app/(observatory)/basins/[id]/page.tsx',
    line: 41,
    specifier: '@/lib/station-service',
    target: SERVICE,
  },
  {
    file: 'app/api/gauges/[id]/route.ts',
    line: 40,
    specifier: '@/lib/station-service',
    target: SERVICE,
  },
  {
    file: 'app/api/gauges/route.ts',
    line: 28,
    specifier: '@/lib/station-service',
    target: SERVICE,
  },
  { file: ROOT_PAGE, line: 30, specifier: '@/widgets', target: BARREL },
  { file: LEGACY_API, line: 41, specifier: '@/lib/station-service', target: SERVICE },
  { file: DRIVER_HANDLE, line: 9, specifier: './stubs/pg', target: PG_STUB },
  { file: DRIVER_HANDLE, line: 10, specifier: './stubs/prisma-client', target: PRISMA_STUB },
  { file: SERVICE, line: 22, specifier: './datastore', target: DRIVER_HANDLE },
  { file: SERVICE, line: 24, specifier: './stubs/pg', target: PG_STUB },
  { file: SERVICE, line: 25, specifier: './stubs/prisma-client', target: PRISMA_STUB },
  { file: SERVER_WIDGET, line: 33, specifier: './GaugeReadout', target: CLIENT_WIDGET },
  { file: CLIENT_WIDGET, line: 20, specifier: '@/lib/http', target: FETCH_HELPER },
];

/** One expected `exports` edge, with the re-export form its declaration is written in. */
interface ExpectedReExport extends ExpectedEdge {
  /** The form {@link classifyReExportForm} must report for the declaration at this site. */
  readonly form: ReExportForm;
}

/**
 * The barrel's four re-exports, one per form, in source order.
 *
 * `CodeEdge` carries no payload field, so the form does not travel on the edge:
 * it is recovered from the declaration at the edge *site*, exactly as
 * `./imports.ts` documents, which is what makes the four edges distinguishable
 * from edge data rather than merely countable.
 */
const EXPECTED_RE_EXPORTS: readonly ExpectedReExport[] = [
  { file: BARREL, line: 16, specifier: './GaugeReadout', target: CLIENT_WIDGET, form: 'star' },
  { file: BARREL, line: 17, specifier: './BasinSummary', target: SERVER_WIDGET, form: 'named' },
  {
    file: BARREL,
    line: 18,
    specifier: './BasinSummary',
    target: SERVER_WIDGET,
    form: 'type-named',
  },
  {
    file: BARREL,
    line: 19,
    specifier: './BasinSummary',
    target: SERVER_WIDGET,
    form: 'default-as',
  },
];

/** The one file of the corpus whose module carries the client-component directive. */
const EXPECTED_CLIENT_MODULES: readonly string[] = [CLIENT_WIDGET];

/**
 * Every module of the corpus that reaches the server-function layer through the
 * `@/lib/...` alias, in visit order.
 *
 * Five modules across both router conventions — four App Router modules and the
 * single legacy Pages Router one — which is what makes "the alias resolves"
 * a statement about the resolver rather than about one call site.
 */
const EXPECTED_SERVICE_IMPORTERS: readonly string[] = [
  'app/(observatory)/api/basins/[...segments]/route.ts',
  'app/(observatory)/basins/[id]/page.tsx',
  'app/api/gauges/[id]/route.ts',
  'app/api/gauges/route.ts',
  LEGACY_API,
];

/**
 * Every `@/lib/...` specifier the corpus declares: the five above plus the
 * client widget's hop into the fetch helper.
 */
const EXPECTED_LIB_ALIAS_IMPORT_COUNT = EXPECTED_SERVICE_IMPORTERS.length + 1;

/**
 * Modules of the corpus that export declarations of their own and carry no
 * re-export.
 *
 * They are what gives "a local export is never an `exports` edge" its teeth: a
 * case asserting the absence of an edge proves nothing unless the module it
 * looks at genuinely exports something.
 */
const EXPECTED_LOCAL_EXPORT_MODULES: readonly string[] = [
  ROOT_LAYOUT,
  SERVER_WIDGET,
  CLIENT_WIDGET,
  FETCH_HELPER,
  SERVICE,
];

/* -------------------------------------------------------------------------------------------------
 * The scratch project
 * ---------------------------------------------------------------------------------------------- */

/** The scratch module whose import declaration has no module specifier at all. */
const SCRATCH_BROKEN = 'src/broken-declaration.ts';

/** The scratch module importing a relative path that names no file. */
const SCRATCH_MISSING_IMPORT = 'src/missing-import.ts';

/** The scratch module re-exporting from a relative path that names no file. */
const SCRATCH_MISSING_RE_EXPORT = 'src/missing-re-export.ts';

/** The scratch module with two import declarations of one and the same module. */
const SCRATCH_REPEATED = 'src/repeated-import.ts';

/** The scratch module both resolvable scratch importers point at. */
const SCRATCH_TARGET = 'src/resolved-target.ts';

/**
 * The scratch module that must still be processed after the malformed one:
 * "one malformed construct costs one relation, never a file", and never another
 * file.
 */
const SCRATCH_UNAFFECTED = 'src/unaffected.ts';

/** Every indexable file of the scratch project, in the order it is visited. */
const EXPECTED_SCRATCH_FILES: readonly string[] = [
  SCRATCH_BROKEN,
  SCRATCH_MISSING_IMPORT,
  SCRATCH_MISSING_RE_EXPORT,
  SCRATCH_REPEATED,
  SCRATCH_TARGET,
  SCRATCH_UNAFFECTED,
];

/** The relative specifier the scratch importer names and that resolves to nothing. */
const SCRATCH_ABSENT_MODULE = './absent-module';

/** The relative specifier the scratch re-exporter names and that resolves to nothing. */
const SCRATCH_ABSENT_BARREL = './absent-barrel';

/**
 * The identifier planted inside the malformed declaration.
 *
 * Its only job is to be findable: the privacy case asserts that no diagnostic
 * message or detail contains it, which is a stronger statement than "the
 * message looks fine" — a third-party parser error embedded verbatim would
 * carry exactly this text.
 */
const SOURCE_TEXT_MARKER = 'SOURCE_TEXT_MARKER_MUST_NOT_LEAK';

/**
 * The scratch project's sources.
 *
 * `moduleResolution: "bundler"` in the generated configuration is what makes
 * the extensionless relative specifiers below resolvable, matching the corpus'
 * own configuration; the malformed declaration is the one shape that makes
 * ts-morph's specifier accessor fail rather than recover, which is what the
 * `extractor-failed` case needs.
 */
const SCRATCH_SOURCES: Readonly<Record<string, string>> = {
  [SCRATCH_TARGET]: 'export const first = 1;\nexport const second = 2;\n',
  [SCRATCH_BROKEN]: `import { ${SOURCE_TEXT_MARKER} } from ;\nexport const broken = 1;\n`,
  [SCRATCH_MISSING_IMPORT]: `import { absent } from '${SCRATCH_ABSENT_MODULE}';\nexport const missing = 1;\n`,
  [SCRATCH_MISSING_RE_EXPORT]: `export { absent } from '${SCRATCH_ABSENT_BARREL}';\n`,
  [SCRATCH_REPEATED]:
    "import { first } from './resolved-target';\nimport { second } from './resolved-target';\nexport const repeated = first + second;\n",
  [SCRATCH_UNAFFECTED]:
    "import { first } from './resolved-target';\nexport const unaffected = first;\n",
};

/** The configuration the scratch project is opened with. */
const SCRATCH_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      isolatedModules: true,
      noEmit: true,
    },
    include: ['**/*.ts'],
    exclude: ['node_modules'],
  },
  null,
  2,
)}\n`;

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

/** What one `extract` call produced for one file. */
interface FileExtraction {
  /** The project-relative POSIX path the context carried. */
  readonly file: string;

  /** Every node the call returned — asserted to be exactly one `file` node. */
  readonly nodes: readonly CodeNode[];

  /** Every edge the call returned, in emission order. */
  readonly edges: readonly CodeEdge[];

  /**
   * The findings the call returned, normalised to an array.
   *
   * `ExtractorResult.diagnostics` is absent rather than empty for a clean
   * extraction, and {@link FileExtraction.reportedDiagnostics} preserves that
   * distinction for the one case that asserts it.
   */
  readonly diagnostics: readonly IndexDiagnostic[];

  /** Whether the result carried a `diagnostics` field at all. */
  readonly reportedDiagnostics: boolean;
}

/** One file's identity and content, for the "nothing was written" comparisons. */
interface TreeEntry {
  /** The path relative to the snapshotted root, POSIX separators. */
  readonly file: string;

  /** The file's size in bytes. */
  readonly size: number;

  /** The file's last-modification time, in epoch milliseconds. */
  readonly mtimeMs: number;

  /** The file's bytes, decoded as UTF-8. */
  readonly content: string;
}

/** Everything the corpus cases read, built once in `beforeAll`. */
interface CorpusHarness {
  /** The opened corpus. */
  readonly loaded: LoadedProject;

  /** Every file's extraction, keyed by project-relative path, in `sourceFiles()` order. */
  readonly extraction: ReadonlyMap<string, FileExtraction>;

  /** The index built over this extractor alone. */
  readonly index: CodeIndex;

  /** The graph assembled from {@link CorpusHarness.index}. */
  readonly graph: CodeGraph;

  /**
   * The graph assembled from an index built over the **whole** default
   * extractor set.
   *
   * The second half of the assembly question: an edge of this extractor's can
   * be dropped by something another extractor emits — a divergent `file` node
   * above all — and only a full index shows that.
   */
  readonly fullGraph: CodeGraph;

  /** The findings of the full index, normalised to an array. */
  readonly fullDiagnostics: readonly IndexDiagnostic[];

  /** The corpus tree as it stood before the project was opened. */
  readonly snapshotBefore: readonly TreeEntry[];
}

/** Everything the scratch cases read, built once in `beforeAll`. */
interface ScratchHarness {
  /** The scratch project's absolute, symlink-free root. */
  readonly root: string;

  /** The opened scratch project. */
  readonly loaded: LoadedProject;

  /** Every file's extraction, keyed by project-relative path. */
  readonly extraction: ReadonlyMap<string, FileExtraction>;

  /** The tree as it stood after the project was opened and before extraction ran. */
  readonly snapshotBefore: readonly TreeEntry[];

  /** The tree as it stood immediately after extraction ran. */
  readonly snapshotAfter: readonly TreeEntry[];
}

/**
 * The corpus harness, or `undefined` before `beforeAll` has run.
 *
 * Spelled as a nullable module binding with an accessor rather than with a
 * definite-assignment assertion, so a case that somehow ran without the hook
 * fails with a sentence naming the cause instead of dereferencing `undefined`.
 */
let corpusHarness: CorpusHarness | undefined;

/** The scratch harness, on the same terms. */
let scratchHarness: ScratchHarness | undefined;

/**
 * The corpus harness.
 *
 * @returns The harness built in `beforeAll`.
 */
function corpus(): CorpusHarness {
  if (corpusHarness === undefined) {
    throw new Error('the corpus harness is missing: beforeAll did not complete');
  }

  return corpusHarness;
}

/**
 * The scratch harness.
 *
 * @returns The harness built in `beforeAll`.
 */
function scratch(): ScratchHarness {
  if (scratchHarness === undefined) {
    throw new Error('the scratch harness is missing: beforeAll did not complete');
  }

  return scratchHarness;
}

/**
 * Every file under one directory, sorted by path, with its size, modification
 * time and content.
 *
 * Content as well as metadata: a write that replaced a file with the same
 * number of bytes at the same instant would be invisible to a metadata-only
 * comparison, and "the corpus is read-only" has to hold against exactly that.
 *
 * @param root The absolute directory to snapshot.
 * @returns The entries, sorted ascending by relative path.
 */
function snapshotTree(root: string): readonly TreeEntry[] {
  const entries: TreeEntry[] = [];

  const walk = (directory: string, prefix: string): void => {
    const listing = readdirSync(directory, { withFileTypes: true });
    listing.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of listing) {
      const absolute = join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }

      const stats = statSync(absolute);
      entries.push({
        file: relative,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        content: readFileSync(absolute, 'utf8'),
      });
    }
  };

  walk(root, '');

  return entries;
}

/**
 * Opens a project, or fails with the reported error rather than with a
 * dereference of `undefined`.
 *
 * @param projectRoot The absolute project root.
 * @returns The opened project.
 */
function openOrFail(projectRoot: string): LoadedProject {
  const opened = openProject({ projectRoot: toPosix(projectRoot), logger: noopLogger });

  if (!isOk(opened)) {
    throw new Error(
      `openProject refused ${projectRoot}: ${opened.error.code} — ${opened.error.message}`,
    );
  }

  return opened.value;
}

/**
 * Runs the extractor under test over every file of a project, building the
 * context exactly as `../indexer.ts` does.
 *
 * The same four fields the indexer supplies, from the same sources: the opened
 * project, the source file, the project-relative path through
 * `LoadedProject.projectRelative`, and `LoadedProject.projectRoot`. The logger
 * is `noopLogger` because the extractor reports findings as diagnostics on its
 * result rather than as log lines — the contract its header states — so there
 * is no log output to assert on.
 *
 * @param loaded The opened project.
 * @returns Each file's extraction, keyed by project-relative path, in
 * `sourceFiles()` order.
 */
function extractProject(loaded: LoadedProject): ReadonlyMap<string, FileExtraction> {
  const byFile = new Map<string, FileExtraction>();

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(toPosix(sourceFile.getFilePath()));

    if (file === undefined) {
      throw new Error(
        `the opened project holds a source file that is not project-relative: ${sourceFile.getFilePath()}`,
      );
    }

    const ctx: ExtractorContext = {
      loaded,
      sourceFile,
      file,
      projectRoot: loaded.projectRoot,
      logger: noopLogger,
    };
    const result = importsExtractor.extract(ctx);

    byFile.set(file, {
      file,
      nodes: result.nodes,
      edges: result.edges,
      diagnostics: result.diagnostics ?? [],
      reportedDiagnostics: result.diagnostics !== undefined,
    });
  }

  return byFile;
}

/**
 * One project's extraction, ordered by file, for the equality comparisons.
 *
 * @param extraction The map `extractProject` produced.
 * @returns The extractions in iteration order.
 */
function orderedExtractions(
  extraction: ReadonlyMap<string, FileExtraction>,
): readonly FileExtraction[] {
  return [...extraction.values()];
}

/**
 * The extraction of one file, or a failure naming every file that was
 * extracted.
 *
 * @param extraction The map to look in.
 * @param file The project-relative POSIX path.
 * @returns That file's extraction.
 */
function extractionFor(
  extraction: ReadonlyMap<string, FileExtraction>,
  file: string,
): FileExtraction {
  const found = extraction.get(file);

  if (found === undefined) {
    throw new Error(
      `no extraction was recorded for ${file}; the project held: ${[...extraction.keys()].join(', ')}`,
    );
  }

  return found;
}

/**
 * The single `file` node of one extraction.
 *
 * Narrowed by kind rather than asserted, and the count is checked here so that
 * every case reading a payload is reading the only node there was.
 *
 * @param extraction The file's extraction.
 * @returns Its `file` node.
 */
function fileNodeOf(extraction: FileExtraction): CodeNodeOf<'file'> {
  const nodes = extraction.nodes.filter((node): node is CodeNodeOf<'file'> => node.kind === 'file');

  expect(
    nodes.length,
    `${extraction.file} yielded ${String(extraction.nodes.length)} node(s), of which ${String(nodes.length)} are file nodes; exactly one file node is required`,
  ).toBe(1);

  const [node] = nodes;

  if (node === undefined) {
    throw new Error(`no file node was emitted for ${extraction.file}`);
  }

  return node;
}

/**
 * The payload of one extraction's `file` node.
 *
 * `CodeNode`'s `data` is optional for a `file` node — an extractor with nothing
 * to add may omit it — but this one always emits it, so an absent payload is a
 * regression rather than a shape to tolerate.
 *
 * @param extraction The file's extraction.
 * @returns The payload.
 */
function fileDataOf(extraction: FileExtraction): FileNodeData {
  const data = fileNodeOf(extraction).data;

  if (data === undefined) {
    throw new Error(`the file node of ${extraction.file} carries no payload`);
  }

  return data;
}

/**
 * The id the extractor must compose for one file's node.
 *
 * Built through `makeNodeId` with the convention `./imports.ts` documents —
 * name equal to the project-relative path, at line 1, column 1 — because that
 * byte-equality is the whole reason an edge computed in the importing file
 * connects to the node emitted when the indexer visits the target. Composed,
 * never parsed: no case in this file takes an id apart.
 *
 * @param file The project-relative POSIX path.
 * @returns The node id.
 */
function fileNodeId(file: string): string {
  return makeNodeId({ kind: 'file', file, name: file, line: 1, column: 1 });
}

/** Every edge of every file of one project, in file then emission order. */
function allEdges(extraction: ReadonlyMap<string, FileExtraction>): readonly CodeEdge[] {
  return orderedExtractions(extraction).flatMap((entry) => [...entry.edges]);
}

/** Every diagnostic of every file of one project, in file then discovery order. */
function allDiagnostics(
  extraction: ReadonlyMap<string, FileExtraction>,
): readonly IndexDiagnostic[] {
  return orderedExtractions(extraction).flatMap((entry) => [...entry.diagnostics]);
}

/** Every external-import record of one project, paired with its importing file. */
function allExternalImports(
  extraction: ReadonlyMap<string, FileExtraction>,
): readonly ExpectedExternalImport[] {
  return orderedExtractions(extraction).flatMap((entry) =>
    fileDataOf(entry).externalImports.map((ref) => ({ file: entry.file, ref })),
  );
}

/**
 * One edge reduced to the fields a case compares: its site, its specifier and
 * the file its target node names.
 *
 * The target is recovered by comparing the edge's `to` against the id computed
 * for each candidate file, never by parsing the id.
 *
 * @param edge The edge to describe.
 * @param candidates The project-relative paths the target may be.
 * @returns The comparable description.
 */
function describeEdge(edge: CodeEdge, candidates: readonly string[]): ExpectedEdge {
  const target = candidates.find((candidate) => fileNodeId(candidate) === edge.to);

  return {
    file: edge.file ?? '',
    line: edge.line ?? 0,
    specifier: edge.specifier ?? '',
    target: target ?? `<unknown node: ${edge.to}>`,
  };
}

/**
 * The source file of one project at a project-relative path.
 *
 * @param loaded The opened project.
 * @param file The project-relative POSIX path.
 * @returns The source file.
 */
function sourceFileFor(loaded: LoadedProject, file: string): SourceFile {
  for (const sourceFile of loaded.sourceFiles()) {
    if (loaded.projectRelative(toPosix(sourceFile.getFilePath())) === file) {
      return sourceFile;
    }
  }

  throw new Error(`the project holds no source file at ${file}`);
}

/**
 * The re-export form of every module-specifier export declaration in one file,
 * keyed by the **1-based** line it starts on.
 *
 * This is the recovery route `./imports.ts` documents for a consumer that holds
 * an edge site and wants the form the edge cannot carry, and it is used here
 * rather than an independent re-implementation precisely because the point is
 * that the two agree.
 *
 * @param loaded The opened project.
 * @param file The project-relative POSIX path of the re-exporting module.
 * @returns The form at each line.
 */
function reExportFormsByLine(
  loaded: LoadedProject,
  file: string,
): ReadonlyMap<number, ReExportForm> {
  const sourceFile = sourceFileFor(loaded, file);
  const byLine = new Map<number, ReExportForm>();

  for (const declaration of sourceFile.getExportDeclarations()) {
    if (declaration.getModuleSpecifierValue() === undefined) {
      continue;
    }

    const { line } = sourceFile.getLineAndColumnAtPos(declaration.getStart());
    byLine.set(line, classifyReExportForm(declaration));
  }

  return byLine;
}

/**
 * Every file of one project holding at least one export declaration that
 * carries a module specifier.
 *
 * Read from the syntax rather than from the extractor's output, so "exactly one
 * module re-exports" is a statement about the corpus that the edge count is
 * then checked against — rather than the same number twice.
 *
 * @param loaded The opened project.
 * @returns The project-relative paths, in `sourceFiles()` order.
 */
function modulesWithReExports(loaded: LoadedProject): readonly string[] {
  const files: string[] = [];

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(toPosix(sourceFile.getFilePath()));

    if (file === undefined) {
      continue;
    }

    const reExports = sourceFile
      .getExportDeclarations()
      .filter((declaration) => declaration.getModuleSpecifierValue() !== undefined);

    if (reExports.length > 0) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Every file of one project whose import declarations name a specifier with the
 * given prefix.
 *
 * For a well-formed project only, like {@link modulesWithReExports}: ts-morph's
 * specifier accessor throws for a declaration with no specifier, which is the
 * one shape the scratch project deliberately contains, so neither helper is
 * pointed at it.
 *
 * @param loaded The opened project.
 * @param prefix The specifier prefix, for example `'@/lib/'`.
 * @returns The project-relative paths paired with the specifier each names.
 */
function modulesImportingWithPrefix(
  loaded: LoadedProject,
  prefix: string,
): readonly { readonly file: string; readonly specifier: string }[] {
  const found: { readonly file: string; readonly specifier: string }[] = [];

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(toPosix(sourceFile.getFilePath()));

    if (file === undefined) {
      continue;
    }

    for (const declaration of sourceFile.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();

      if (specifier.startsWith(prefix)) {
        found.push({ file, specifier });
      }
    }
  }

  return found;
}

/**
 * Whether every one of a file's import and export declarations resolves to
 * nothing through the project's module resolver.
 *
 * The direct evidence for "no type resolution was required": the resolver
 * itself answers `undefined` for these specifiers, so a record that exists for
 * them cannot have come from a resolved module or a declaration file.
 *
 * @param loaded The opened project.
 * @param file The project-relative POSIX path.
 * @param specifier The specifier to check.
 * @returns `true` when no declaration naming that specifier resolves.
 */
function specifierResolvesToNothing(
  loaded: LoadedProject,
  file: string,
  specifier: string,
): boolean {
  const sourceFile = sourceFileFor(loaded, file);
  const declarations = sourceFile
    .getImportDeclarations()
    .filter((declaration) => declaration.getModuleSpecifierValue() === specifier);

  expect(
    declarations.length,
    `${file} was expected to declare exactly one import of ${specifier}`,
  ).toBe(1);

  return declarations.every(
    (declaration) => declaration.getModuleSpecifierSourceFile() === undefined,
  );
}

/**
 * The `dependencies` keys of a package manifest.
 *
 * `JSON.parse` answers `any`, so the value is taken as `unknown` and narrowed
 * by hand: a manifest is untrusted input here exactly as it is in the product.
 *
 * @param manifestPath The absolute path of the manifest.
 * @returns The declared dependency names, or an empty list when there are none.
 */
function declaredDependencies(manifestPath: string): readonly string[] {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }

  const { dependencies } = parsed as { readonly dependencies?: unknown };

  if (typeof dependencies !== 'object' || dependencies === null) {
    return [];
  }

  return Object.keys(dependencies);
}

/**
 * Writes the scratch project and returns its resolved root.
 *
 * `realpath` matters: a temporary directory reached through a symbolic link
 * would make every path the project loader screens look like an escape, and the
 * cases here are about the extractor rather than about that screen.
 *
 * @returns The absolute, symlink-free scratch root.
 */
function writeScratchProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-imports-')));

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), SCRATCH_TSCONFIG, 'utf8');

  for (const [file, source] of Object.entries(SCRATCH_SOURCES)) {
    writeFileSync(join(root, file), source, 'utf8');
  }

  return root;
}

/**
 * How many top-level statements of one module carry an `export` modifier.
 *
 * Syntactic, through ts-morph's exportability guard, so it answers for a module
 * whose imports resolve to nothing — which every framework-importing module of
 * the corpus is.
 *
 * @param sourceFile The module to count.
 * @returns The number of exported top-level statements.
 */
function localExportCount(sourceFile: SourceFile): number {
  let count = 0;

  for (const statement of sourceFile.getStatements()) {
    if (Node.isExportable(statement) && statement.isExported()) {
      count += 1;
    }
  }

  return count;
}

/**
 * The substantial source lines of one scratch module, for the privacy case.
 *
 * Trimmed, and short lines are dropped: a two-character line would match by
 * coincidence rather than by leaking, and the assertion has to fail only for a
 * genuine quotation of the developer's source.
 *
 * @param file The scratch module's project-relative path, or `undefined` for a
 * finding about the run rather than about one file.
 * @returns The lines worth searching a diagnostic for.
 */
function scratchSourceLines(file: string | undefined): readonly string[] {
  if (file === undefined) {
    return [];
  }

  const source = SCRATCH_SOURCES[file];

  if (source === undefined) {
    return [];
  }

  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
}

beforeAll(async () => {
  // The corpus snapshot is taken before anything opens it, so the comparison at
  // the end of this file covers the whole run rather than only extraction.
  const snapshotBefore = snapshotTree(FIXTURE_ROOT);
  const loaded = openOrFail(FIXTURE_ROOT);
  const extraction = extractProject(loaded);

  // This extractor ALONE, which is what makes a `dangling-edge` finding
  // attributable to it: every edge in the resulting index came from here.
  const built = await buildIndex(loaded, {
    extractors: [importsExtractor],
    logger: noopLogger,
  });

  if (!isOk(built)) {
    throw new Error(`buildIndex failed over the corpus: ${built.error.code}`);
  }

  // And once over the whole default extractor set, which is the index the
  // product actually builds.
  const full = await buildIndex(loaded, { logger: noopLogger });

  if (!isOk(full)) {
    throw new Error(`buildIndex over every extractor failed: ${full.error.code}`);
  }

  corpusHarness = {
    loaded,
    extraction,
    index: built.value,
    graph: CodeGraph.fromIndex(built.value, { logger: noopLogger }),
    fullGraph: CodeGraph.fromIndex(full.value, { logger: noopLogger }),
    fullDiagnostics: full.value.diagnostics ?? [],
    snapshotBefore,
  };

  const root = writeScratchProject();
  const scratchLoaded = openOrFail(root);

  // Snapshotted after the project is opened and before extraction runs, so the
  // comparison is a statement about `extract` and about nothing else.
  const scratchSnapshotBefore = snapshotTree(root);
  const scratchExtraction = extractProject(scratchLoaded);

  scratchHarness = {
    root,
    loaded: scratchLoaded,
    extraction: scratchExtraction,
    snapshotBefore: scratchSnapshotBefore,
    snapshotAfter: snapshotTree(root),
  };
});

afterAll(() => {
  if (scratchHarness !== undefined) {
    rmSync(scratchHarness.root, { recursive: true, force: true });
    scratchHarness = undefined;
  }

  corpusHarness = undefined;
});

/* -------------------------------------------------------------------------------------------------
 * The corpus, and the file node of every module in it
 * ---------------------------------------------------------------------------------------------- */

describe('importsExtractor: the corpus and its file nodes', () => {
  it("opens the corpus through the corpus' own configuration", () => {
    // The precondition for every alias case below: without a resolved
    // configuration there are no `paths` aliases, so `@/widgets` would resolve
    // to nothing and four of this file's cases would pass for the wrong reason.
    const { loaded } = corpus();

    expect(loaded.tsConfigFilePath).toBeDefined();
    expect(toPosix(loaded.tsConfigFilePath ?? '')).toBe(
      toPosix(join(FIXTURE_ROOT, 'tsconfig.json')),
    );
    expect(loaded.projectRoot).toBe(toPosix(FIXTURE_ROOT));
  });

  it('visits exactly the corpus files, in deterministic order', () => {
    expect([...corpus().extraction.keys()]).toStrictEqual(EXPECTED_FIXTURE_FILES);
  });

  it('emits exactly one file node per visited file, anchored at line 1, column 1', () => {
    for (const entry of orderedExtractions(corpus().extraction)) {
      const node = fileNodeOf(entry);

      expect(node.kind).toBe('file');
      expect(node.name, `${entry.file}: a file node's name is its project-relative path`).toBe(
        entry.file,
      );
      expect(node.file).toBe(entry.file);
      expect(node.line).toBe(1);
      expect(node.column).toBe(1);

      // Byte-equal to the id an edge pointing AT this file computes, which is
      // the only reason the module graph is connected at all.
      expect(node.id).toBe(fileNodeId(entry.file));
    }
  });

  it('records the extension and the client-module directive on every file node', () => {
    const clientModules: string[] = [];

    for (const entry of orderedExtractions(corpus().extraction)) {
      const data = fileDataOf(entry);
      const extension = /\.[^./]+$/u.exec(entry.file);

      expect(extension, `${entry.file} has no extension to record`).not.toBeNull();
      expect(data.extension).toBe((extension?.[0] ?? '').toLowerCase());

      if (data.isClientModule) {
        clientModules.push(entry.file);
      }
    }

    expect(clientModules).toStrictEqual(EXPECTED_CLIENT_MODULES);
  });

  it('reports no finding anywhere in the corpus, and omits the field when clean', () => {
    expect(allDiagnostics(corpus().extraction)).toStrictEqual([]);

    // Absent rather than empty, as the result contract requires, so the indexer
    // does not merge an empty array into the envelope.
    for (const entry of orderedExtractions(corpus().extraction)) {
      expect(entry.reportedDiagnostics, `${entry.file} carried a diagnostics field`).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 1 — the three specifiers that resolve to nothing
 * ---------------------------------------------------------------------------------------------- */

describe('importsExtractor: unresolvable external specifiers', () => {
  it('records exactly three, one per file, with their bindings and type-only flags', () => {
    expect(allExternalImports(corpus().extraction), DISCREPANCY_MESSAGE).toStrictEqual(
      EXPECTED_EXTERNAL_IMPORTS,
    );
  });

  it('reports the corpus budget as three specifiers and not two', () => {
    const specifiers = allExternalImports(corpus().extraction).map((entry) => entry.ref.specifier);

    expect(specifiers, DISCREPANCY_MESSAGE).toStrictEqual(EXPECTED_UNRESOLVABLE_SPECIFIERS);
  });

  it('attributes each record to the declaring file and to no other file', () => {
    const { extraction } = corpus();
    const carriers = new Set(EXPECTED_EXTERNAL_IMPORTS.map((entry) => entry.file));

    for (const expected of EXPECTED_EXTERNAL_IMPORTS) {
      expect(fileDataOf(extractionFor(extraction, expected.file)).externalImports).toStrictEqual([
        expected.ref,
      ]);
    }

    for (const entry of orderedExtractions(extraction)) {
      if (carriers.has(entry.file)) {
        continue;
      }

      expect(
        fileDataOf(entry).externalImports,
        `${entry.file} recorded an external import it should not have`,
      ).toStrictEqual([]);
    }
  });

  it('emits no imports edge for any of the three', () => {
    const edges = allEdges(corpus().extraction);

    for (const specifier of EXPECTED_UNRESOLVABLE_SPECIFIERS) {
      expect(
        edges.filter((edge) => edge.specifier === specifier),
        `${specifier} became an edge; an external module has no node to point at`,
      ).toStrictEqual([]);
    }
  });

  it('needed no type resolution: the packages are declared and never installed', () => {
    const { loaded } = corpus();
    const declared = declaredDependencies(FIXTURE_MANIFEST);

    expect(declared, 'the corpus manifest must declare the packages it never installs').toContain(
      'next',
    );
    expect(declared).toContain('react');
    expect(
      existsSync(join(FIXTURE_ROOT, 'node_modules')),
      'the corpus must carry no node_modules of its own',
    ).toBe(false);

    // The direct evidence: the project's own module resolver answers nothing
    // for each of the three, so the record cannot have come from a resolved
    // module or a declaration file.
    for (const expected of EXPECTED_EXTERNAL_IMPORTS) {
      expect(
        specifierResolvesToNothing(loaded, expected.file, expected.ref.specifier),
        `${expected.ref.specifier} resolved in ${expected.file}; the corpus installs nothing`,
      ).toBe(true);
    }
  });

  it('reports no finding for them: an uninstalled package is not a hole in the graph', () => {
    for (const expected of EXPECTED_EXTERNAL_IMPORTS) {
      expect(
        extractionFor(corpus().extraction, expected.file).diagnostics,
        `${expected.file} reported a finding for a bare package specifier`,
      ).toStrictEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 2 — where a specifier that does resolve leads
 * ---------------------------------------------------------------------------------------------- */

describe('importsExtractor: resolution paths', () => {
  it('yields exactly the corpus imports edges, in source order per file', () => {
    const edges = allEdges(corpus().extraction).filter((edge) => edge.kind === 'imports');

    expect(edges.map((edge) => describeEdge(edge, EXPECTED_FIXTURE_FILES))).toStrictEqual(
      EXPECTED_IMPORT_EDGES,
    );
  });

  it('sites every edge at the column the declaration starts at', () => {
    for (const edge of allEdges(corpus().extraction)) {
      expect(
        edge.column,
        `${edge.file ?? '<no file>'}:${String(edge.line ?? 0)} is sited at an unexpected column`,
      ).toBe(1);
    }
  });

  it('resolves the tsconfig paths alias through to the barrel module', () => {
    const page = extractionFor(corpus().extraction, ROOT_PAGE);

    expect(page.edges, `${ROOT_PAGE} declares exactly one import`).toHaveLength(1);

    const [edge] = page.edges;

    if (edge === undefined) {
      throw new Error(`${ROOT_PAGE} emitted no edge`);
    }

    expect(edge.kind).toBe('imports');
    expect(edge.from).toBe(fileNodeId(ROOT_PAGE));
    expect(edge.to, 'the alias hop must land on the barrel module').toBe(fileNodeId(BARREL));

    // The specifier as written, so the evidence of the alias survives the
    // resolution that would otherwise erase it.
    expect(edge.specifier).toBe('@/widgets');
    expect(edge.file).toBe(ROOT_PAGE);
    expect(edge.line).toBe(30);
  });

  it('resolves relative extensionless specifiers', () => {
    const { extraction } = corpus();
    const cases: readonly {
      readonly from: string;
      readonly specifier: string;
      readonly to: string;
    }[] = [
      { from: SERVER_WIDGET, specifier: './GaugeReadout', to: CLIENT_WIDGET },
      { from: SERVICE, specifier: './datastore', to: DRIVER_HANDLE },
      { from: DRIVER_HANDLE, specifier: './stubs/pg', to: PG_STUB },
      { from: DRIVER_HANDLE, specifier: './stubs/prisma-client', to: PRISMA_STUB },
    ];

    for (const scenario of cases) {
      const label = `${scenario.from} -> ${scenario.specifier}`;
      const edges = extractionFor(extraction, scenario.from).edges.filter(
        (edge) => edge.specifier === scenario.specifier,
      );

      expect(edges, label).toHaveLength(1);
      expect(edges[0]?.kind, label).toBe('imports');
      expect(edges[0]?.from, label).toBe(fileNodeId(scenario.from));
      expect(edges[0]?.to, label).toBe(fileNodeId(scenario.to));
    }
  });

  it('resolves every @/lib alias import, and every one into the service layer', () => {
    const { loaded, extraction } = corpus();
    const aliased = modulesImportingWithPrefix(loaded, '@/lib/');

    expect(aliased, 'the corpus declares six @/lib specifiers').toHaveLength(
      EXPECTED_LIB_ALIAS_IMPORT_COUNT,
    );

    const intoService = aliased.filter((entry) => entry.specifier === '@/lib/station-service');

    expect(intoService.map((entry) => entry.file)).toStrictEqual(EXPECTED_SERVICE_IMPORTERS);

    for (const entry of aliased) {
      const target = entry.specifier === '@/lib/station-service' ? SERVICE : FETCH_HELPER;
      const label = `${entry.file} -> ${entry.specifier}`;
      const edges = extractionFor(extraction, entry.file).edges.filter(
        (edge) => edge.specifier === entry.specifier,
      );

      expect(edges, label).toHaveLength(1);
      expect(edges[0]?.to, label).toBe(fileNodeId(target));
    }
  });

  it('emits no edge for a module that imports nothing, while still contributing its node', () => {
    const layout = extractionFor(corpus().extraction, ROOT_LAYOUT);

    expect(layout.edges, `${ROOT_LAYOUT} imports nothing and re-exports nothing`).toStrictEqual([]);
    expect(fileDataOf(layout).externalImports).toStrictEqual([]);
    expect(layout.diagnostics).toStrictEqual([]);

    // The node is still emitted: it is the anchor every other extractor's
    // `declares` edges point at.
    expect(fileNodeOf(layout).id).toBe(fileNodeId(ROOT_LAYOUT));
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 3 — the four re-export forms, and the one barrel that carries them
 * ---------------------------------------------------------------------------------------------- */

describe('importsExtractor: the four re-export forms', () => {
  it('finds exactly one module with module-specifier export declarations', () => {
    expect(modulesWithReExports(corpus().loaded)).toStrictEqual([BARREL]);
  });

  it('yields exactly four exports edges, one per form, distinguishable from edge data', () => {
    const { loaded, extraction } = corpus();
    const edges = allEdges(extraction).filter((edge) => edge.kind === 'exports');

    expect(
      edges,
      'the barrel carries four re-exports and the corpus carries no other',
    ).toHaveLength(EXPECTED_RE_EXPORTS.length);

    const forms = reExportFormsByLine(loaded, BARREL);
    const described = edges.map((edge) => {
      const line = edge.line ?? 0;
      const form = forms.get(line);

      if (form === undefined) {
        throw new Error(`no export declaration was found at ${BARREL}:${String(line)}`);
      }

      return { ...describeEdge(edge, EXPECTED_FIXTURE_FILES), form };
    });

    expect(described).toStrictEqual(EXPECTED_RE_EXPORTS);

    for (const edge of edges) {
      expect(edge.from, 'every exports edge of the corpus starts at the barrel').toBe(
        fileNodeId(BARREL),
      );
      expect(edge.file).toBe(BARREL);
    }
  });

  it('covers four of the five forms; the namespace form is the one the corpus omits', () => {
    const covered = new Set(EXPECTED_RE_EXPORTS.map((entry) => entry.form));

    expect(RE_EXPORT_FORMS).toHaveLength(5);
    expect(covered.size, 'each of the four covered forms appears exactly once').toBe(
      EXPECTED_RE_EXPORTS.length,
    );
    expect([...RE_EXPORT_FORMS].filter((form) => !covered.has(form))).toStrictEqual(['namespace']);
  });

  it('emits no exports edge for a local export', () => {
    const { loaded, extraction } = corpus();

    for (const file of EXPECTED_LOCAL_EXPORT_MODULES) {
      // Teeth first: a module that exports nothing would make the absence of an
      // edge below prove nothing at all.
      expect(
        localExportCount(sourceFileFor(loaded, file)),
        `${file} must export at least one declaration of its own`,
      ).toBeGreaterThan(0);

      expect(
        extractionFor(extraction, file).edges.filter((edge) => edge.kind === 'exports'),
        `${file} emitted an exports edge for a local export; those belong to ./symbols.ts`,
      ).toStrictEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The edges survive graph construction
 * ---------------------------------------------------------------------------------------------- */

describe('importsExtractor: its edges survive graph assembly', () => {
  it('builds an index with no finding when it is the only extractor', () => {
    const { index } = corpus();

    expect(index.diagnostics, 'a clean index omits the diagnostics field entirely').toBeUndefined();
    expect(index.nodes).toHaveLength(EXPECTED_FIXTURE_FILES.length);
    expect(index.edges).toHaveLength(EXPECTED_IMPORT_EDGES.length + EXPECTED_RE_EXPORTS.length);
    expect(index.files).toHaveLength(EXPECTED_FIXTURE_FILES.length);
  });

  it('has no dangling-edge finding attributable to it', () => {
    const { graph } = corpus();

    // Every edge of this index came from this extractor, which is what makes a
    // construction finding attributable to it rather than to the extractor set.
    expect(graph.diagnostics.filter((finding) => finding.code === 'dangling-edge')).toStrictEqual(
      [],
    );
    expect(graph.diagnostics, 'construction dropped nothing at all').toStrictEqual([]);
    expect(graph.size).toStrictEqual({
      nodes: EXPECTED_FIXTURE_FILES.length,
      edges: EXPECTED_IMPORT_EDGES.length + EXPECTED_RE_EXPORTS.length,
    });

    for (const edge of graph.edges()) {
      expect(graph.nodeById(edge.from), `${edge.id} has no from endpoint`).toBeDefined();
      expect(graph.nodeById(edge.to), `${edge.id} has no to endpoint`).toBeDefined();
    }
  });

  it('keeps every one of its edges in an index built over every extractor', () => {
    const { extraction, fullDiagnostics, fullGraph } = corpus();

    expect(
      DEFAULT_EXTRACTORS.map((extractor) => extractor.id),
      'this extractor must be part of the set the product indexes with',
    ).toContain(IMPORTS_EXTRACTOR_ID);

    expect(
      fullDiagnostics.filter((finding) => finding.code === 'dangling-edge'),
      'the corpus must assemble with no dropped edge at all',
    ).toStrictEqual([]);

    // The edge ids are compared, never parsed: an id this extractor computed
    // must still name an edge of the assembled graph, which is what proves no
    // other extractor's divergent `file` node cost this one its endpoints.
    const assembled = new Set(fullGraph.edges().map((edge) => edge.id));

    for (const edge of allEdges(extraction)) {
      expect(
        assembled.has(edge.id),
        `${edge.kind} at ${edge.file ?? '<no file>'}:${String(edge.line ?? 0)} was dropped from the full index`,
      ).toBe(true);
    }
  });

  it('points every edge of the raw extraction at a file node of the same run', () => {
    const { extraction } = corpus();
    const ids = new Set(orderedExtractions(extraction).map((entry) => fileNodeOf(entry).id));

    for (const edge of allEdges(extraction)) {
      const label = `${edge.file ?? '<no file>'}:${String(edge.line ?? 0)}`;

      expect(ids.has(edge.from), `${label} starts at a node no file emitted`).toBe(true);
      expect(ids.has(edge.to), `${label} points at a node no file emitted`).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 4 — determinism, path safety and vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('importsExtractor: determinism, path safety and vocabulary', () => {
  it('produces deeply equal, identically ordered output on two consecutive runs', () => {
    const { loaded } = corpus();
    const first = orderedExtractions(extractProject(loaded));
    const second = orderedExtractions(extractProject(loaded));

    expect(second).toStrictEqual(first);

    // The stronger form, and the one `../indexer.ts` turns into a byte-identical
    // serialised index: equal *and* in the same order, field for field.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('produces the same output from a separately opened project', () => {
    const reopened = openOrFail(FIXTURE_ROOT);

    expect(JSON.stringify(orderedExtractions(extractProject(reopened)))).toBe(
      JSON.stringify(orderedExtractions(corpus().extraction)),
    );
  });

  it('keeps every emitted path a safe project-relative POSIX path', () => {
    for (const entry of orderedExtractions(corpus().extraction)) {
      const node = fileNodeOf(entry);

      expect(isSafeRelativePath(node.file), node.file).toBe(true);
      expect(isSafeRelativePath(node.name), node.name).toBe(true);

      for (const edge of entry.edges) {
        expect(edge.file, `an edge of ${entry.file} carries no site`).toBeDefined();
        expect(isSafeRelativePath(edge.file ?? ''), edge.file ?? '<absent>').toBe(true);
      }
    }
  });

  it('puts no absolute path in any node id, edge id or data field', () => {
    const serialized = JSON.stringify(orderedExtractions(corpus().extraction));

    expect(serialized).not.toContain(FIXTURE_ROOT);
    expect(serialized).not.toContain(toPosix(FIXTURE_ROOT));
    expect(serialized, 'an index is portable only while it holds no absolute path').not.toContain(
      REPO_ROOT,
    );
  });

  it('emits only vocabulary kinds, and never a references edge', () => {
    // `references` is a real member of the vocabulary, so the absence asserted
    // below is a decision of this extractor and not a typo in this case.
    expect(CODE_EDGE_KINDS).toContain('references');

    for (const entry of orderedExtractions(corpus().extraction)) {
      for (const node of entry.nodes) {
        expect(isCodeNodeKind(node.kind), `${entry.file} emitted node kind ${node.kind}`).toBe(
          true,
        );
        expect(node.kind).toBe('file');
      }

      for (const edge of entry.edges) {
        expect(isCodeEdgeKind(edge.kind), `${entry.file} emitted edge kind ${edge.kind}`).toBe(
          true,
        );
        expect(['imports', 'exports']).toContain(edge.kind);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Phase 4 — malformed and unresolvable modules, in a scratch project
 * ---------------------------------------------------------------------------------------------- */

describe('importsExtractor: malformed and unresolvable modules', () => {
  it('visits every file of the scratch project', () => {
    expect([...scratch().extraction.keys()]).toStrictEqual(EXPECTED_SCRATCH_FILES);
  });

  it('reports a declaration it cannot read as a finding, without throwing', () => {
    const entry = extractionFor(scratch().extraction, SCRATCH_BROKEN);

    expect(entry.edges, 'a declaration that cannot be read contributes no edge').toStrictEqual([]);
    expect(entry.diagnostics).toHaveLength(1);

    const [finding] = entry.diagnostics;

    if (finding === undefined) {
      throw new Error(`${SCRATCH_BROKEN} reported no finding for its malformed declaration`);
    }

    // `error`, because a part of the index is genuinely missing, and attributed
    // by extractor id — which is what makes the failure traceable.
    expect(finding.severity).toBe('error');
    expect(finding.code).toBe('extractor-failed');
    expect(finding.file).toBe(SCRATCH_BROKEN);
    expect(finding.extractorId).toBe(IMPORTS_EXTRACTOR_ID);

    // The node is still emitted, so the file stays the anchor of the other
    // extractors' edges.
    expect(fileNodeOf(entry).id).toBe(fileNodeId(SCRATCH_BROKEN));
  });

  it('processes every other file of the project after the malformed one', () => {
    const entry = extractionFor(scratch().extraction, SCRATCH_UNAFFECTED);

    expect(entry.diagnostics).toStrictEqual([]);
    expect(entry.edges).toHaveLength(1);
    expect(entry.edges[0]?.to).toBe(fileNodeId(SCRATCH_TARGET));
  });

  it('records a relative specifier naming no file as unresolved, with no edge', () => {
    const entry = extractionFor(scratch().extraction, SCRATCH_MISSING_IMPORT);

    expect(entry.edges).toStrictEqual([]);
    expect(fileDataOf(entry).externalImports).toStrictEqual([
      { specifier: SCRATCH_ABSENT_MODULE, typeOnly: false, names: ['absent'] },
    ]);
    expect(entry.diagnostics).toHaveLength(1);

    const [finding] = entry.diagnostics;

    if (finding === undefined) {
      throw new Error(`${SCRATCH_MISSING_IMPORT} reported no finding for its missing target`);
    }

    // A relative specifier names a file that is supposed to be there, so unlike
    // an uninstalled package it is a hole in the graph and earns a warning.
    expect(finding.severity).toBe('warning');
    expect(finding.code).toBe('unresolved-import');
    expect(finding.file).toBe(SCRATCH_MISSING_IMPORT);
    expect(finding.extractorId).toBe(IMPORTS_EXTRACTOR_ID);
  });

  it('records a re-export whose target module does not exist on the same terms', () => {
    const entry = extractionFor(scratch().extraction, SCRATCH_MISSING_RE_EXPORT);

    expect(entry.edges).toStrictEqual([]);
    expect(fileDataOf(entry).externalImports).toStrictEqual([
      { specifier: SCRATCH_ABSENT_BARREL, typeOnly: false, names: ['absent'] },
    ]);
    expect(entry.diagnostics).toHaveLength(1);
    expect(entry.diagnostics[0]?.code).toBe('unresolved-import');
    expect(entry.diagnostics[0]?.severity).toBe('warning');
    expect(entry.diagnostics[0]?.extractorId).toBe(IMPORTS_EXTRACTOR_ID);
  });

  it('gives each of two import declarations of one module its own edge', () => {
    // `./imports.ts` de-duplicates by edge id and an edge id carries the
    // declaration's line and column, so the documented contract is one distinct
    // edge per declaration — not one aggregated edge with two occurrences.
    const entry = extractionFor(scratch().extraction, SCRATCH_REPEATED);
    const target = fileNodeId(SCRATCH_TARGET);

    expect(entry.edges).toHaveLength(2);
    expect(entry.edges.map((edge) => edge.to)).toStrictEqual([target, target]);
    expect(entry.edges.map((edge) => edge.line)).toStrictEqual([1, 2]);
    expect(new Set(entry.edges.map((edge) => edge.id)).size, 'edge ids must be unique').toBe(2);
    expect(entry.diagnostics).toStrictEqual([]);
  });

  it('puts no source text in any diagnostic', () => {
    const findings = allDiagnostics(scratch().extraction);

    expect(findings.length, 'the scratch project must produce findings to inspect').toBeGreaterThan(
      0,
    );

    for (const finding of findings) {
      const text = `${finding.message}\n${finding.detail ?? ''}`;
      const label = `${finding.code} on ${finding.file ?? '<the run>'}`;

      expect(text, `${label} quoted the planted marker`).not.toContain(SOURCE_TEXT_MARKER);
      expect(text, `${label} quoted a module specifier`).not.toContain(SCRATCH_ABSENT_MODULE);
      expect(text, `${label} quoted a module specifier`).not.toContain(SCRATCH_ABSENT_BARREL);

      for (const line of scratchSourceLines(finding.file)) {
        expect(text, `${label} quoted a line of the file it concerns`).not.toContain(line);
      }
    }
  });

  it('writes nothing: the scratch project is byte-identical after extraction', () => {
    const { snapshotBefore, snapshotAfter } = scratch();

    expect(snapshotAfter, 'extraction is pure with respect to the filesystem').toStrictEqual(
      snapshotBefore,
    );
  });

  it('keeps the scratch project root out of the extraction', () => {
    const { extraction, root } = scratch();

    expect(JSON.stringify(orderedExtractions(extraction))).not.toContain(root);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The exported classifier, and the extractor's own identity
 * ---------------------------------------------------------------------------------------------- */

describe('classifyReExportForm', () => {
  it('classifies every form written in one module, in the documented precedence', () => {
    // In memory: the classifier reads syntax and nothing else, so it answers for
    // declarations whose target does not exist and needs no project on disk.
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      '/project/barrel.ts',
      [
        "export * from './widgets';",
        "export * as widgets from './widgets';",
        "export { alpha } from './widgets';",
        "export { type Beta } from './widgets';",
        "export type { Gamma } from './widgets';",
        "export { default as Delta } from './widgets';",
        // Precedence: a type-only declaration reports `type-named` even when its
        // clause names the target's default binding — what matters most about it
        // is that it erases at runtime.
        "export type { default as Epsilon } from './widgets';",
        // Keys on the IMPORTED name, so re-exporting a named binding *as* this
        // module's default is `named` rather than `default-as`.
        "export { Zeta as default } from './widgets';",
        'const eta = 1;',
        // A local export is not a re-export at all; it is classified on its
        // clause alone rather than rejected.
        'export { eta };',
      ].join('\n'),
    );

    expect(sourceFile.getExportDeclarations().map(classifyReExportForm)).toStrictEqual([
      'star',
      'namespace',
      'named',
      'type-named',
      'type-named',
      'default-as',
      'type-named',
      'named',
      'named',
    ]);
  });

  it('exposes the five forms as a frozen, ordered vocabulary', () => {
    expect(RE_EXPORT_FORMS).toStrictEqual([
      'star',
      'namespace',
      'named',
      'type-named',
      'default-as',
    ]);
    expect(Object.isFrozen(RE_EXPORT_FORMS)).toBe(true);
  });
});

describe('importsExtractor: identity', () => {
  it('is a frozen singleton named by the id diagnostics are attributed with', () => {
    expect(IMPORTS_EXTRACTOR_ID).toBe('imports');
    expect(importsExtractor.id).toBe(IMPORTS_EXTRACTOR_ID);
    expect(Object.isFrozen(importsExtractor)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The committed corpus is read-only — asserted last, so it covers the whole run
 * ---------------------------------------------------------------------------------------------- */

describe('the committed corpus', () => {
  it('is byte-identical after the whole run', () => {
    expect(
      snapshotTree(FIXTURE_ROOT),
      'a case that needs a different module writes it into an mkdtemp copy, never into the checkout',
    ).toStrictEqual(corpus().snapshotBefore);
  });
});
