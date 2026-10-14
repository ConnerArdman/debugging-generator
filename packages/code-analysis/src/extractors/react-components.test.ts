/**
 * Unit suite for `./react-components.ts` — the extractor that turns a module's
 * syntax into `component` nodes and `renders` edges.
 *
 * Two of its answers are load-bearing far outside this package, and both are
 * asserted here rather than anywhere downstream:
 *
 * - **`isClient` is the `"use client"` directive and nothing else.** A render
 *   investigation that believes a server module is a client one starts from a
 *   false premise, and the plausible wrong signals — a hook import, an event
 *   handler, a browser global — are all present in real server modules. The
 *   corpus is built so that its client module and its server widget differ by
 *   exactly that one statement, and the sandbox cases below add the directive
 *   to a server module, remove it from the client one, and declare hooks
 *   *without* it, so the classification cannot be satisfied incidentally.
 * - **A component node's id is the id every other producer must derive.**
 *   `./event-handlers.ts` constructs component ids independently for its
 *   `handles` edges, and `../graph/graph.ts` drops an edge whose endpoint
 *   nobody emitted as `dangling-edge` — silently deleting the path from a
 *   captured interaction to the component it happened in. The last group below
 *   therefore looks every `handles` edge's source id up in the assembled graph
 *   and requires it to land on a component node.
 *
 * The rest pins what a consumer reads: the naming rule (declared identifier, or
 * the file's basename for an anonymous default export), the 1-based identifier
 * position an editor opens, the display name a captured render event joins
 * against, the three routes a `renders` edge's target is resolved through (a
 * declaration in the same module, a direct relative import, and a barrel
 * re-export behind a path alias — the last being the one that proves
 * re-exports are followed to the declaring module rather than pointed at a
 * module that declares nothing), the absence of
 * nodes for everything that merely *looks* like a component, and the
 * properties the index depends on: source-order determinism, project-relative
 * POSIX paths, a diagnostic instead of a throw for an unparsable module, and no
 * write of any kind.
 *
 * ## How the cases are driven
 *
 * Two kinds of input, deliberately:
 *
 * - **The committed corpus** at `../../test/fixtures/sample-next-app`, opened
 *   once through the real `openProject` and indexed once through the real
 *   `buildIndex`, because the corpus is the thing every other suite of this
 *   package reads and an edit that thinned this extractor's coverage must fail
 *   here, where the reason is written down. It is **read only**: the last group
 *   re-hashes every file of it and fails if a single byte, size or modification
 *   time moved.
 * - **`mkdtemp` sandboxes** for everything that needs a *different* module —
 *   a flipped directive, a declaration shape the corpus does not carry, a
 *   duplicate usage site, an import that resolves to nothing, a file with a
 *   syntax error. Each one is a real directory with a real `tsconfig.json`,
 *   because module resolution is the one thing this extractor does that an
 *   in-memory tree would answer differently, and every sandbox is removed in
 *   `afterAll`.
 *
 * Positions are never hardcoded: each expected line and column is computed by
 * locating the identifier's offset in the module text and converting it, so
 * inserting a line into a fixture moves the expectation with it instead of
 * breaking it.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isErr,
  isSafeRelativePath,
  noopLogger,
  parseSourceLocation,
} from '@debuggen/shared';

import { CodeGraph, makeNodeId } from '../graph/graph.js';
import { buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import { reactComponentsExtractor } from './react-components.js';

import type { Result } from '@debuggen/shared';

import type { CodeEdge, CodeNodeOf, ExtractorContext, IndexDiagnostic } from '../graph/types.js';
import type { LoadedProject } from '../project.js';

/* -------------------------------------------------------------------------------------------------
 * The corpus, and what it is expected to hold
 * ---------------------------------------------------------------------------------------------- */

/** The committed indexing corpus this package's suites share, resolved from this file. */
const FIXTURE_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/** The corpus' only client module: its first statement is the `"use client"` directive. */
const CLIENT_MODULE = 'src/widgets/GaugeReadout.tsx';

/** The server half of the corpus' widget pair, which differs from it by that one statement. */
const SERVER_WIDGET_MODULE = 'src/widgets/BasinSummary.tsx';

/** The root App Router page, which reaches its child through the `@/widgets` barrel. */
const ROOT_PAGE_MODULE = 'app/page.tsx';

/** The root layout: the corpus' only `<html>`/`<body>` shell, and its only exported constant. */
const ROOT_LAYOUT_MODULE = 'app/layout.tsx';

/** The grouped dynamic page, whose returned JSX is host elements only. */
const GROUPED_PAGE_MODULE = 'app/(observatory)/basins/[id]/page.tsx';

/** The corpus' only barrel: four re-export kinds and no declaration of its own. */
const BARREL_MODULE = 'src/widgets/index.ts';

/**
 * One component the corpus is expected to declare.
 *
 * `declaredAfter` is the exact text that precedes the identifier in the module,
 * which is how the expected position is *computed* from the file rather than
 * written down: the marker must occur exactly once, and the identifier starts
 * immediately after it.
 */
interface ExpectedComponent {
  /** The declaring module, project-relative POSIX. */
  readonly file: string;

  /** The declared identifier, which is also the node's `name`. */
  readonly name: string;

  /** The text immediately preceding the identifier in the module. */
  readonly declaredAfter: string;

  /** Whether the module carries the client directive. */
  readonly isClient: boolean;

  /** Whether the declaration is the module's default export. */
  readonly isDefaultExport: boolean;

  /** Whether the declaration is exported at all. */
  readonly exported: boolean;

  /** The runtime display name, which differs from `name` only for a wrapper. */
  readonly displayName: string;

  /** The separate declaration a wrapper resolved through, when it resolved through one. */
  readonly implementation?: string | undefined;
}

/**
 * Every component of the corpus, in the order extraction emits them: files in
 * the project's ascending path order, declarations in source order within a
 * file.
 *
 * Four server components and four client ones, and the only thing that
 * separates the two groups is which module they are declared in — the widget
 * pair is otherwise symmetric.
 */
const CORPUS_COMPONENTS: readonly ExpectedComponent[] = Object.freeze([
  {
    file: GROUPED_PAGE_MODULE,
    name: 'BasinDetailPage',
    declaredAfter: 'export default async function ',
    isClient: false,
    isDefaultExport: true,
    exported: true,
    displayName: 'BasinDetailPage',
    implementation: undefined,
  },
  {
    file: ROOT_LAYOUT_MODULE,
    name: 'ObservatoryLayout',
    declaredAfter: 'export default function ',
    isClient: false,
    isDefaultExport: true,
    exported: true,
    displayName: 'ObservatoryLayout',
    implementation: undefined,
  },
  {
    file: ROOT_PAGE_MODULE,
    name: 'BasinIndexPage',
    declaredAfter: 'export default function ',
    isClient: false,
    isDefaultExport: true,
    exported: true,
    displayName: 'BasinIndexPage',
    implementation: undefined,
  },
  {
    file: SERVER_WIDGET_MODULE,
    name: 'BasinSummary',
    declaredAfter: 'export default function ',
    isClient: false,
    isDefaultExport: true,
    exported: true,
    displayName: 'BasinSummary',
    implementation: undefined,
  },
  {
    file: CLIENT_MODULE,
    name: 'GaugeReadout',
    declaredAfter: 'export function ',
    isClient: true,
    isDefaultExport: false,
    exported: true,
    displayName: 'GaugeReadout',
    implementation: undefined,
  },
  {
    file: CLIENT_MODULE,
    name: 'GaugeTrendBody',
    declaredAfter: 'function ',
    isClient: true,
    isDefaultExport: false,
    // The implementation behind the memoised binding below: declared, rendered
    // through its wrapper, and exported by nothing.
    exported: false,
    displayName: 'GaugeTrendBody',
    implementation: undefined,
  },
  {
    file: CLIENT_MODULE,
    name: 'GaugeTrend',
    declaredAfter: 'export const ',
    isClient: true,
    isDefaultExport: false,
    exported: true,
    // `memo(GaugeTrendBody)` with no display-name assignment, so React reports
    // the implementation's own name for the exported binding.
    displayName: 'GaugeTrendBody',
    implementation: 'GaugeTrendBody',
  },
  {
    file: CLIENT_MODULE,
    name: 'GaugeTrendPanel',
    declaredAfter: 'export function ',
    isClient: true,
    isDefaultExport: false,
    exported: true,
    displayName: 'GaugeTrendPanel',
    implementation: undefined,
  },
]);

/** The names of the corpus' client components: every component of {@link CLIENT_MODULE}. */
const CLIENT_COMPONENT_NAMES: readonly string[] = CORPUS_COMPONENTS.filter(
  (component) => component.isClient,
).map((component) => component.name);

/** The names of the corpus' server components: every component of every other module. */
const SERVER_COMPONENT_NAMES: readonly string[] = CORPUS_COMPONENTS.filter(
  (component) => !component.isClient,
).map((component) => component.name);

/**
 * One `renders` edge the corpus is expected to hold, named by its endpoints and
 * its usage site.
 *
 * Three edges, covering the three resolution routes the extractor takes: a
 * direct relative import, a path alias through a barrel re-export, and a
 * declaration in the same file.
 */
interface ExpectedEdge {
  /** The enclosing component's name. */
  readonly fromName: string;

  /** The enclosing component's declaring module. */
  readonly fromFile: string;

  /** The rendered component's name. */
  readonly toName: string;

  /** The module that *declares* the rendered component — never the barrel. */
  readonly toFile: string;

  /** The module the markup is written in, which is the edge's own `file`. */
  readonly siteFile: string;

  /** The tag as written, whose `<` the edge is positioned at. */
  readonly tag: string;
}

/** Every `renders` edge of the corpus, in emission order. */
const CORPUS_EDGES: readonly ExpectedEdge[] = Object.freeze([
  {
    // `import { BasinSummary } from '@/widgets'` -> the barrel's
    // `export { default as BasinSummary } from './BasinSummary'` -> the
    // declaring module. The target is the declaration, not the re-export.
    fromName: 'BasinIndexPage',
    fromFile: ROOT_PAGE_MODULE,
    toName: 'BasinSummary',
    toFile: SERVER_WIDGET_MODULE,
    siteFile: ROOT_PAGE_MODULE,
    tag: 'BasinSummary',
  },
  {
    // `import { GaugeReadout } from './GaugeReadout'` — relative and
    // extensionless, resolved under the corpus' `moduleResolution: "bundler"`.
    fromName: 'BasinSummary',
    fromFile: SERVER_WIDGET_MODULE,
    toName: 'GaugeReadout',
    toFile: CLIENT_MODULE,
    siteFile: SERVER_WIDGET_MODULE,
    tag: 'GaugeReadout',
  },
  {
    // A declaration of the same module, which shadows any import of the name.
    fromName: 'GaugeTrendPanel',
    fromFile: CLIENT_MODULE,
    toName: 'GaugeTrend',
    toFile: CLIENT_MODULE,
    siteFile: CLIENT_MODULE,
    tag: 'GaugeTrend',
  },
]);

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

/** One file of an opened project, named without importing ts-morph's own type. */
type LoadedSourceFile = ReturnType<LoadedProject['sourceFiles']>[number];

/** A 1-based position, on the convention every node in the graph carries. */
interface Position {
  /** The 1-based line. */
  readonly line: number;

  /** The 1-based column. */
  readonly column: number;
}

/** What this extractor produced for one file, with its kinds already narrowed. */
interface FileExtraction {
  /** The file, project-relative POSIX. */
  readonly file: string;

  /** The component nodes, in emission order. */
  readonly components: readonly CodeNodeOf<'component'>[];

  /** The `renders` edges, in emission order. */
  readonly edges: readonly CodeEdge[];

  /** The diagnostics, empty when the result carried none. */
  readonly diagnostics: readonly IndexDiagnostic[];

  /**
   * Whether the result object carried a `diagnostics` property at all.
   *
   * `ExtractorResult` documents the field as *absent* rather than empty for a
   * clean extraction, which is a distinction `toStrictEqual` and the indexer's
   * unguarded concatenation both depend on.
   */
  readonly announcedDiagnostics: boolean;
}

/** A sandbox project: a real directory, a real `tsconfig.json`, and an opened handle. */
interface Sandbox {
  /** The sandbox root, absolute. */
  readonly root: string;

  /** The opened project over it. */
  readonly loaded: LoadedProject;
}

/**
 * The configuration every sandbox project declares, mirroring the corpus'.
 *
 * `jsx: "preserve"` keeps JSX in the tree, `moduleResolution: "bundler"` is
 * what lets a relative specifier omit its extension, and the `@/*` alias is
 * what a sandbox needs to exercise the same aliased-barrel route the corpus
 * takes. Nothing is installed for a sandbox, exactly as nothing is installed
 * for the corpus: this extractor reads syntax and must not need a resolved
 * `react`.
 */
const SANDBOX_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      jsx: 'preserve',
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      isolatedModules: true,
      paths: { '@/*': ['./src/*'] },
    },
    include: ['**/*.ts', '**/*.tsx'],
    exclude: ['node_modules'],
  },
  undefined,
  2,
)}\n`;

/**
 * The budget a case that plants, copies or opens a project gets.
 *
 * Generous rather than unbounded, and well above Vitest's 5 s default: such a
 * case writes a small tree and builds a ts-morph program over it, on a machine
 * this suite may be sharing with every other project of the run. A genuinely
 * hung open still fails the run.
 */
const SANDBOX_CASE_TIMEOUT_MS = 30_000;

/** The corpus, opened once: every read-only case shares it. */
let corpus: LoadedProject | undefined;

/** The corpus' per-file extraction, computed once from a direct extractor call per file. */
let corpusExtraction: readonly FileExtraction[] | undefined;

/** The corpus' assembled graph, from the real `buildIndex` over the full extractor set. */
let corpusGraph: CodeGraph | undefined;

/** The corpus' bytes, sizes and modification times as they were before anything ran. */
let corpusSnapshot: readonly string[] | undefined;

/** Every sandbox directory this suite created, removed in `afterAll`. */
const sandboxes: string[] = [];

beforeAll(async () => {
  // Taken first, so the integrity case at the end compares against the state
  // the suite inherited rather than one it may already have disturbed.
  corpusSnapshot = snapshotTree(FIXTURE_ROOT);

  const loaded = openOrFail(FIXTURE_ROOT);
  corpus = loaded;
  corpusExtraction = extractEveryFile(loaded);

  // The whole extractor set, because the cross-extractor assertion needs the
  // `handles` edges `./event-handlers.ts` emits and the graph's own findings.
  const built = valueOrFail(
    await buildIndex(loaded, { logger: noopLogger }),
    'indexing the corpus',
  );

  corpusGraph = CodeGraph.fromIndex(built, { logger: noopLogger });
}, 60_000);

afterAll(() => {
  for (const sandbox of sandboxes.splice(0, sandboxes.length)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

/**
 * The value of a `Result` this suite expects to succeed, or a failure naming
 * the refusal.
 *
 * Every failure in this package is a value rather than an exception, so a case
 * that dereferenced one would report a `TypeError` instead of the reason.
 *
 * @param result The outcome to unwrap.
 * @param what What was attempted, for the failure message.
 * @returns The value.
 */
function valueOrFail<T>(result: Result<T>, what: string): T {
  if (isErr(result)) {
    return expect.unreachable(`${what} failed with ${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

/**
 * Opens a project this suite expects to open, or fails with the refusal.
 *
 * @param projectRoot The absolute root to open.
 * @returns The opened project.
 */
function openOrFail(projectRoot: string): LoadedProject {
  return valueOrFail(openProject({ projectRoot }), `openProject('${projectRoot}')`);
}

/** The corpus handle, or a failure naming the missing `beforeAll`. */
function corpusProject(): LoadedProject {
  if (corpus === undefined) {
    return expect.unreachable('the corpus was not opened: beforeAll did not run');
  }

  return corpus;
}

/** The corpus' per-file extraction, or a failure naming the missing `beforeAll`. */
function extraction(): readonly FileExtraction[] {
  if (corpusExtraction === undefined) {
    return expect.unreachable('the corpus was not extracted: beforeAll did not run');
  }

  return corpusExtraction;
}

/** The corpus' assembled graph, or a failure naming the missing `beforeAll`. */
function graph(): CodeGraph {
  if (corpusGraph === undefined) {
    return expect.unreachable('the corpus was not indexed: beforeAll did not run');
  }

  return corpusGraph;
}

/**
 * Builds the {@link ExtractorContext} for one file of an opened project,
 * **exactly as `../indexer.ts` builds it**: the same handle, the same
 * project-relative path, the same root, and a logger.
 *
 * @param loaded The opened project.
 * @param file The project-relative POSIX path to visit.
 * @returns The context the indexer would hand this extractor.
 */
function contextFor(loaded: LoadedProject, file: string): ExtractorContext {
  return {
    loaded,
    sourceFile: sourceFileFor(loaded, file),
    file,
    projectRoot: loaded.projectRoot,
    logger: noopLogger,
  };
}

/**
 * The opened project's source file for a project-relative path.
 *
 * Looked up through `projectRelative` rather than by string-joining the root,
 * so the match is made on the same normalised form the indexer would use.
 *
 * @param loaded The opened project.
 * @param file The project-relative POSIX path.
 * @returns The source file.
 */
function sourceFileFor(loaded: LoadedProject, file: string): LoadedSourceFile {
  const found = loaded
    .sourceFiles()
    .find((sourceFile) => loaded.projectRelative(sourceFile.getFilePath()) === file);

  if (found === undefined) {
    return expect.unreachable(
      `the project at '${loaded.projectRoot}' does not hold '${file}'; it holds: ${relativePathsOf(loaded).join(', ')}`,
    );
  }

  return found;
}

/** Every project-relative path an opened project holds, in its deterministic order. */
function relativePathsOf(loaded: LoadedProject): readonly string[] {
  return loaded
    .sourceFiles()
    .map(
      (sourceFile) => loaded.projectRelative(sourceFile.getFilePath()) ?? '<outside the project>',
    );
}

/**
 * Extracts one file and narrows what came back.
 *
 * @param loaded The opened project.
 * @param file The project-relative POSIX path.
 * @returns The components, edges and diagnostics of that file.
 */
function extractFile(loaded: LoadedProject, file: string): FileExtraction {
  const result = reactComponentsExtractor.extract(contextFor(loaded, file));

  return {
    file,
    components: result.nodes.filter(
      (node): node is CodeNodeOf<'component'> => node.kind === 'component',
    ),
    edges: [...result.edges],
    diagnostics: result.diagnostics === undefined ? [] : [...result.diagnostics],
    announcedDiagnostics: result.diagnostics !== undefined,
  };
}

/**
 * Extracts every file of an opened project, in the project's own order.
 *
 * @param loaded The opened project.
 * @returns One entry per file, including the files that yielded nothing.
 */
function extractEveryFile(loaded: LoadedProject): readonly FileExtraction[] {
  return relativePathsOf(loaded).map((file) => extractFile(loaded, file));
}

/** Every component node of an extraction, in emission order. */
function componentsOf(files: readonly FileExtraction[]): readonly CodeNodeOf<'component'>[] {
  return files.flatMap((entry) => entry.components);
}

/** Every edge of an extraction, in emission order. */
function edgesOf(files: readonly FileExtraction[]): readonly CodeEdge[] {
  return files.flatMap((entry) => entry.edges);
}

/** The one extraction entry for a file, or a failure naming what the project held. */
function fileEntry(files: readonly FileExtraction[], file: string): FileExtraction {
  const found = files.find((entry) => entry.file === file);

  if (found === undefined) {
    return expect.unreachable(
      `no extraction entry for '${file}'; the project holds: ${files.map((entry) => entry.file).join(', ')}`,
    );
  }

  return found;
}

/**
 * The one component node of a given name, or a failure naming every candidate.
 *
 * A case that accidentally matched two declarations would otherwise assert
 * about whichever came first.
 *
 * @param components The extracted component nodes.
 * @param name The declared name to look for.
 * @returns The single matching node.
 */
function componentNamed(
  components: readonly CodeNodeOf<'component'>[],
  name: string,
): CodeNodeOf<'component'> {
  const matched = components.filter((component) => component.name === name);

  expect(
    matched.map((component) => `${component.file}@${String(component.line)}`),
    `exactly one component named '${name}' was expected`,
  ).toHaveLength(1);

  const [first] = matched;
  if (first === undefined) {
    return expect.unreachable(`no component named '${name}' was extracted`);
  }

  return first;
}

/* -------------------------------------------------------------------------------------------------
 * Positions, computed from the source rather than written down
 * ---------------------------------------------------------------------------------------------- */

/** The text of a module of a project, read from disk. */
function textOf(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf8');
}

/**
 * The 1-based line and column of a zero-based character offset.
 *
 * The same convention `CodeNodeBase.line` fixes and `SourceLocation` shares:
 * the first character of a file is line 1, column 1.
 *
 * @param text The file text.
 * @param offset A zero-based character offset into it.
 * @returns The 1-based position.
 */
function positionAtOffset(text: string, offset: number): Position {
  const before = text.slice(0, offset);

  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
}

/** Every zero-based offset a marker occurs at, in ascending order. */
function offsetsOf(text: string, marker: string): readonly number[] {
  const found: number[] = [];

  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
    found.push(at);
  }

  return found;
}

/**
 * The single offset a marker occurs at, or a failure naming how many there
 * were.
 *
 * Uniqueness is the point: an expectation computed from a marker that occurs
 * twice would be computed from whichever came first.
 *
 * @param text The file text.
 * @param marker The text to locate.
 * @returns Its zero-based offset.
 */
function soleOffsetOf(text: string, marker: string): number {
  const offsets = offsetsOf(text, marker);

  expect(offsets, `'${marker}' was expected to occur exactly once`).toHaveLength(1);

  const [first] = offsets;
  if (first === undefined) {
    return expect.unreachable(`'${marker}' does not occur in the file`);
  }

  return first;
}

/**
 * The position of a declared identifier, located by the text that precedes it.
 *
 * This is what keeps every expected line and column derived rather than
 * hardcoded: the marker is `${declaredAfter}${name}`, and the identifier starts
 * `declaredAfter.length` characters into it.
 *
 * @param text The module text.
 * @param declaredAfter The exact text immediately preceding the identifier.
 * @param name The identifier.
 * @returns The identifier's 1-based position.
 */
function identifierPosition(text: string, declaredAfter: string, name: string): Position {
  return positionAtOffset(
    text,
    soleOffsetOf(text, `${declaredAfter}${name}`) + declaredAfter.length,
  );
}

/**
 * Every position a component tag is written at, positioned at its `<`.
 *
 * That is where the extractor positions a `renders` edge. The trailing
 * character is checked so `<GaugeTrend` does not also match
 * `<GaugeTrendPanel`.
 *
 * @param text The module text.
 * @param tag The tag name as written.
 * @returns The 1-based positions of every usage site, in source order.
 */
function tagPositions(text: string, tag: string): readonly Position[] {
  const marker = `<${tag}`;

  return offsetsOf(text, marker)
    .filter((at) => !/[A-Za-z0-9_$]/.test(text.charAt(at + marker.length)))
    .map((at) => positionAtOffset(text, at));
}

/** The single position a component tag is written at, or a failure naming the count. */
function soleTagPosition(text: string, tag: string): Position {
  const positions = tagPositions(text, tag);

  expect(positions, `'<${tag}' was expected to be written exactly once`).toHaveLength(1);

  const [first] = positions;
  if (first === undefined) {
    return expect.unreachable(`'<${tag}' is not written in the file`);
  }

  return first;
}

/* -------------------------------------------------------------------------------------------------
 * Sandboxes: real directories, removed in `afterAll`
 * ---------------------------------------------------------------------------------------------- */

/** A fresh sandbox directory, registered for removal. */
function makeSandboxDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'debuggen-react-components-'));
  sandboxes.push(root);

  return root;
}

/** Writes one file inside a sandbox, creating its directory chain first. */
function plantFile(root: string, file: string, text: string): void {
  const absolute = join(root, file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

/**
 * Plants a sandbox project from a set of modules and opens it.
 *
 * A real directory rather than an in-memory tree because module resolution —
 * the one thing this extractor does beyond reading syntax — is what several
 * cases are about, and because "the extractor writes nothing" is only
 * assertable against a real filesystem.
 *
 * @param files The modules, keyed by project-relative POSIX path.
 * @returns The sandbox root and the opened project.
 */
function plantSandbox(files: Readonly<Record<string, string>>): Sandbox {
  const root = makeSandboxDirectory();
  writeFileSync(join(root, 'tsconfig.json'), SANDBOX_TSCONFIG);

  for (const [file, text] of Object.entries(files)) {
    plantFile(root, file, text);
  }

  return { root, loaded: openOrFail(root) };
}

/**
 * Copies the corpus into a sandbox so a case may edit it, and opens the copy.
 *
 * The committed corpus is never written to: a directive-toggling case needs a
 * *different* module, and a copy is the only way to have one without deleting
 * the coverage the corpus exists for.
 *
 * @param edit Applied to the copy before it is opened; receives the copy's
 * root.
 * @returns The copy's root and the opened project over it.
 */
function plantCorpusCopy(edit: (root: string) => void): Sandbox {
  const root = join(makeSandboxDirectory(), 'corpus-copy');
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  edit(root);

  return { root, loaded: openOrFail(root) };
}

/* -------------------------------------------------------------------------------------------------
 * Tree snapshots: for the corpus' integrity and the sandboxes' purity
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every file of a tree, as `path|size|mtime|sha256`, sorted.
 *
 * Content *and* metadata, so the comparison catches a rewrite that preserved
 * the length as well as a touch that preserved the bytes.
 *
 * @param root The directory to describe.
 * @returns One line per file, in ascending path order.
 */
function snapshotTree(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      const stats = statSync(absolute);
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');

      return `${relative(root, absolute)}|${String(stats.size)}|${String(stats.mtimeMs)}|${digest}`;
    })
    .sort();
}

/* -------------------------------------------------------------------------------------------------
 * Projections the assertions compare
 * ---------------------------------------------------------------------------------------------- */

/** What a component node says about itself, flattened for comparison. */
interface ComponentDescription {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly exported: boolean | undefined;
  readonly isClient: boolean;
  readonly isDefaultExport: boolean;
  readonly displayName: string;
  readonly implementation: string | undefined;
}

/** The description of an extracted node. */
function describeComponent(component: CodeNodeOf<'component'>): ComponentDescription {
  return {
    file: component.file,
    name: component.name,
    line: component.line,
    column: component.column,
    exported: component.exported,
    isClient: component.data.isClient,
    isDefaultExport: component.data.isDefaultExport,
    displayName: component.data.displayName,
    implementation: component.data.implementation,
  };
}

/** The description the corpus is expected to yield, with its position computed. */
function describeExpected(expected: ExpectedComponent): ComponentDescription {
  const { line, column } = identifierPosition(
    textOf(FIXTURE_ROOT, expected.file),
    expected.declaredAfter,
    expected.name,
  );

  return {
    file: expected.file,
    name: expected.name,
    line,
    column,
    exported: expected.exported,
    isClient: expected.isClient,
    isDefaultExport: expected.isDefaultExport,
    displayName: expected.displayName,
    implementation: expected.implementation,
  };
}

/** What an edge says about itself, with its endpoints resolved to node names. */
interface EdgeDescription {
  readonly fromName: string | undefined;
  readonly fromFile: string | undefined;
  readonly toName: string | undefined;
  readonly toFile: string | undefined;
  readonly siteFile: string | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
}

/**
 * The description of an extracted edge, resolving both endpoint ids against the
 * component nodes the same extraction emitted.
 *
 * Resolving rather than comparing ids is what makes the barrel case meaningful:
 * the assertion is about *which declaration* the edge points at, and an id is
 * only a name for it.
 *
 * @param edge The edge.
 * @param components Every component node of the extraction.
 * @returns The description.
 */
function describeEdge(
  edge: CodeEdge,
  components: readonly CodeNodeOf<'component'>[],
): EdgeDescription {
  const from = components.find((component) => component.id === edge.from);
  const to = components.find((component) => component.id === edge.to);

  return {
    fromName: from?.name,
    fromFile: from?.file,
    toName: to?.name,
    toFile: to?.file,
    siteFile: edge.file,
    line: edge.line,
    column: edge.column,
  };
}

/** The description an expected edge stands for, with its site position computed. */
function describeExpectedEdge(expected: ExpectedEdge): EdgeDescription {
  const { line, column } = soleTagPosition(textOf(FIXTURE_ROOT, expected.siteFile), expected.tag);

  return {
    fromName: expected.fromName,
    fromFile: expected.fromFile,
    toName: expected.toName,
    toFile: expected.toFile,
    siteFile: expected.siteFile,
    line,
    column,
  };
}

/** Every component's name mapped to its `isClient` flag, for the classification cases. */
function clientFlagsOf(components: readonly CodeNodeOf<'component'>[]): Record<string, boolean> {
  return Object.fromEntries(
    components.map((component) => [component.name, component.data.isClient]),
  );
}

/* -------------------------------------------------------------------------------------------------
 * The harness itself, so that no case below can pass vacuously
 * ---------------------------------------------------------------------------------------------- */

describe('reactComponentsExtractor: the corpus this suite reads', () => {
  it('opened through the corpus\u2019 own tsconfig, which is what the aliased barrel case needs', () => {
    const loaded = corpusProject();

    // Without a resolved configuration there are no `paths` aliases, so
    // `@/widgets` would resolve to nothing and the barrel edge would quietly
    // disappear instead of failing.
    expect(loaded.tsConfigFilePath ?? '').toMatch(/sample-next-app\/tsconfig\.json$/);
    expect(loaded.projectRoot.endsWith('sample-next-app')).toBe(true);
  });

  it('holds every module the cases below name', () => {
    const held = relativePathsOf(corpusProject());

    for (const file of [
      CLIENT_MODULE,
      SERVER_WIDGET_MODULE,
      ROOT_PAGE_MODULE,
      ROOT_LAYOUT_MODULE,
      GROUPED_PAGE_MODULE,
      BARREL_MODULE,
    ]) {
      expect(held, `the corpus must hold '${file}'`).toContain(file);
    }
  });

  it('is registered under the stable extractor id its diagnostics are attributed to', () => {
    expect(reactComponentsExtractor.id).toBe('react-components');
  });
});

/* -------------------------------------------------------------------------------------------------
 * The client/server distinction is the directive, and nothing else
 * ---------------------------------------------------------------------------------------------- */

/**
 * The directive forms and near-misses the corpus cannot carry, since it holds
 * exactly one client module and one server widget and both spellings are
 * load-bearing there.
 *
 * `HooksOnly` is the case that makes this group more than a restatement of the
 * implementation: it imports hooks, calls two of them and binds an event
 * handler — every signal a client-ness *guess* would key on — and declares no
 * directive, so it must be classified as a server component.
 */
const DIRECTIVE_MODULES: Readonly<Record<string, string>> = Object.freeze({
  'src/SingleQuoted.tsx': [
    "'use client';",
    '',
    'export function SingleQuoted() {',
    '  return <section>single-quoted</section>;',
    '}',
    '',
  ].join('\n'),
  'src/AfterComment.tsx': [
    '/*',
    ' * A leading block comment is trivia rather than a statement, so the',
    ' * directive prologue still begins at the first statement below it.',
    ' */',
    '',
    '"use client";',
    '',
    'export function AfterComment() {',
    '  return <section>after a comment</section>;',
    '}',
    '',
  ].join('\n'),
  'src/AfterImport.tsx': [
    "import { useMemo } from 'react';",
    "'use client';",
    '',
    'export function AfterImport() {',
    "  const label = useMemo(() => 'after an import', []);",
    '',
    '  return <section>{label}</section>;',
    '}',
    '',
  ].join('\n'),
  'src/InBody.tsx': [
    'export function InBody() {',
    '  const mode = "use client";',
    '',
    '  return <section>{mode}</section>;',
    '}',
    '',
  ].join('\n'),
  'src/HooksOnly.tsx': [
    "import { useEffect, useState } from 'react';",
    '',
    'export function HooksOnly() {',
    '  const [count, setCount] = useState(0);',
    '',
    '  useEffect(() => {',
    '    setCount(1);',
    '  }, []);',
    '',
    '  return (',
    '    <button type="button" onClick={() => setCount(count + 1)}>',
    '      {count}',
    '    </button>',
    '  );',
    '}',
    '',
  ].join('\n'),
});

/** The directive sandbox, planted on first use and removed with the others. */
let directiveSandbox: Sandbox | undefined;

/** The directive sandbox's opened project. */
function directiveProject(): Sandbox {
  directiveSandbox ??= plantSandbox(DIRECTIVE_MODULES);

  return directiveSandbox;
}

describe('reactComponentsExtractor: client-ness is the "use client" directive and nothing else', () => {
  it('classifies every component of the directive-carrying module as a client component, and no other', () => {
    const components = componentsOf(extraction());

    const client = components
      .filter((component) => component.data.isClient)
      .map((component) => `${component.file}#${component.name}`);
    const server = components
      .filter((component) => !component.data.isClient)
      .map((component) => `${component.file}#${component.name}`);

    // The client set is exactly the components of the one module whose first
    // statement is the directive — all four of them, including the unexported
    // implementation and the memoised binding.
    expect(client).toStrictEqual(CLIENT_COMPONENT_NAMES.map((name) => `${CLIENT_MODULE}#${name}`));

    // Client-ness is a property of the *module*, so exactly one module of the
    // corpus contributes client components, and it is the one whose first
    // statement is the directive. Its named component export is `GaugeReadout`,
    // the client half of the corpus' widget pair.
    expect([
      ...new Set(
        components
          .filter((component) => component.data.isClient)
          .map((component) => component.file),
      ),
    ]).toStrictEqual([CLIENT_MODULE]);
    expect(textOf(FIXTURE_ROOT, CLIENT_MODULE).startsWith("'use client';")).toBe(true);
    expect(componentNamed(components, 'GaugeReadout').data).toMatchObject({
      isClient: true,
      isDefaultExport: false,
    });

    // And the server set is every component of every module that does not carry
    // it: the widget pair's server half plus the three App Router modules.
    expect(server).toStrictEqual(
      SERVER_COMPONENT_NAMES.map(
        (name) =>
          `${CORPUS_COMPONENTS.find((component) => component.name === name)?.file ?? ''}#${name}`,
      ),
    );
  });

  it('records isClient as a boolean for every component, never undefined', () => {
    // The absence of a directive is a positive statement about the component,
    // not missing information: a consumer must never have to treat "not a
    // client component" and "unknown" as the same answer.
    for (const component of componentsOf(extraction())) {
      expect(typeof component.data.isClient, `${component.file}#${component.name}`).toBe('boolean');
    }
  });

  it(
    'flips both classifications when the directive is moved between the two widget modules',
    () => {
      const { root, loaded } = plantCorpusCopy((copy) => {
        const server = join(copy, SERVER_WIDGET_MODULE);
        writeFileSync(server, `'use client';\n\n${readFileSync(server, 'utf8')}`);

        const client = join(copy, CLIENT_MODULE);
        writeFileSync(client, readFileSync(client, 'utf8').replace("'use client';\n", ''));
      });

      const flippedServer = extractFile(loaded, SERVER_WIDGET_MODULE);
      const flippedClient = extractFile(loaded, CLIENT_MODULE);

      expect(clientFlagsOf(flippedServer.components)).toStrictEqual({ BasinSummary: true });
      expect(clientFlagsOf(flippedClient.components)).toStrictEqual({
        GaugeReadout: false,
        GaugeTrendBody: false,
        GaugeTrend: false,
        GaugeTrendPanel: false,
      });

      // The copy is what moved, not the corpus: the same read one line later
      // still finds the committed spelling in the committed tree.
      expect(readFileSync(join(root, CLIENT_MODULE), 'utf8')).not.toContain("'use client';");
      expect(textOf(FIXTURE_ROOT, CLIENT_MODULE).startsWith("'use client';")).toBe(true);
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it(
    'reads the single-quoted form and one preceded by a comment and a blank line',
    () => {
      const { loaded } = directiveProject();

      expect(clientFlagsOf(extractFile(loaded, 'src/SingleQuoted.tsx').components)).toStrictEqual({
        SingleQuoted: true,
      });
      expect(clientFlagsOf(extractFile(loaded, 'src/AfterComment.tsx').components)).toStrictEqual({
        AfterComment: true,
      });
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it(
    'does not read a directive that follows an import statement',
    () => {
      // A directive prologue is a run of string-literal statements at the very
      // top of the module; a string after an import is an expression statement
      // the framework ignores, so the extractor must ignore it too.
      const { loaded } = directiveProject();

      expect(clientFlagsOf(extractFile(loaded, 'src/AfterImport.tsx').components)).toStrictEqual({
        AfterImport: false,
      });
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it(
    'does not read a "use client" string inside a function body as a directive',
    () => {
      const { loaded } = directiveProject();

      expect(clientFlagsOf(extractFile(loaded, 'src/InBody.tsx').components)).toStrictEqual({
        InBody: false,
      });
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it(
    'does not infer client-ness from a hook import, a hook call or an event handler',
    () => {
      // The rule this case exists for: make the extractor guess from a hook and
      // this expectation is the one that turns red.
      const { loaded } = directiveProject();

      expect(clientFlagsOf(extractFile(loaded, 'src/HooksOnly.tsx').components)).toStrictEqual({
        HooksOnly: false,
      });
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );
});

/* -------------------------------------------------------------------------------------------------
 * Node identity: name, position, export status and display name
 * ---------------------------------------------------------------------------------------------- */

describe('reactComponentsExtractor: the component nodes of the corpus', () => {
  it('emits exactly the expected components, in emission order, with computed positions', () => {
    // One assertion over the whole corpus rather than eight: the *set* is the
    // contract, so a component that appeared or vanished fails here with both
    // lists side by side.
    expect(componentsOf(extraction()).map(describeComponent)).toStrictEqual(
      CORPUS_COMPONENTS.map(describeExpected),
    );
  });

  it('names each component by its declared identifier and reports the runtime display name', () => {
    const components = componentsOf(extraction());

    // Declared name and display name coincide everywhere except the memoised
    // binding, where React reports the wrapped implementation's own name —
    // which is the pair a captured render event has to join against.
    expect(
      components.map((component) => `${component.name}->${component.data.displayName}`),
    ).toStrictEqual([
      'BasinDetailPage->BasinDetailPage',
      'ObservatoryLayout->ObservatoryLayout',
      'BasinIndexPage->BasinIndexPage',
      'BasinSummary->BasinSummary',
      'GaugeReadout->GaugeReadout',
      'GaugeTrendBody->GaugeTrendBody',
      'GaugeTrend->GaugeTrendBody',
      'GaugeTrendPanel->GaugeTrendPanel',
    ]);

    const wrapped = componentNamed(components, 'GaugeTrend');
    expect(wrapped.data.implementation).toBe('GaugeTrendBody');

    // `implementation` names a *different* declaration, so an unwrapped
    // component carries no such key at all.
    for (const component of components.filter((entry) => entry.name !== 'GaugeTrend')) {
      expect(
        Object.keys(component.data).sort(),
        `${component.file}#${component.name}`,
      ).toStrictEqual(['displayName', 'isClient', 'isDefaultExport']);
    }

    expect(Object.keys(wrapped.data).sort()).toStrictEqual([
      'displayName',
      'implementation',
      'isClient',
      'isDefaultExport',
    ]);
  });

  it('reports isDefaultExport for the default-exported components and for nothing else', () => {
    const components = componentsOf(extraction());

    // In the project's own file order, which is the order extraction emits.
    expect(
      components
        .filter((component) => component.data.isDefaultExport)
        .map((component) => component.file),
    ).toStrictEqual([
      GROUPED_PAGE_MODULE,
      ROOT_LAYOUT_MODULE,
      ROOT_PAGE_MODULE,
      SERVER_WIDGET_MODULE,
    ]);

    // Every component of the client module is a named declaration, including
    // the exported ones: a named export is not a default export.
    for (const name of CLIENT_COMPONENT_NAMES) {
      expect(componentNamed(components, name).data.isDefaultExport, name).toBe(false);
    }
  });

  it('positions every component at the 1-based line and column of its identifier', () => {
    for (const expected of CORPUS_COMPONENTS) {
      const component = componentNamed(componentsOf(extraction()), expected.name);
      const text = textOf(FIXTURE_ROOT, expected.file);
      const position = identifierPosition(text, expected.declaredAfter, expected.name);

      expect({ line: component.line, column: component.column }, expected.name).toStrictEqual(
        position,
      );

      // The position really indexes the identifier: the text at it starts with
      // the name, which is what an editor jumping there would select.
      const lines = text.split('\n');
      const line = lines[component.line - 1];
      expect(line?.slice(component.column - 1), expected.name).toMatch(
        new RegExp(`^${expected.name}\\b`),
      );

      // The span is never inverted, which is what a consumer minting a source
      // location out of these fields depends on.
      expect(component.endLine ?? component.line).toBeGreaterThanOrEqual(component.line);
    }
  });

  it('derives every node id through makeNodeId from its kind, file, name and position', () => {
    // The id rule `./event-handlers.ts` copies. Deriving it here from the
    // node's own published fields is what proves the two can agree without
    // coordinating on anything else.
    for (const component of componentsOf(extraction())) {
      expect(component.id).toBe(
        makeNodeId({
          kind: 'component',
          file: component.file,
          name: component.name,
          line: component.line,
          column: component.column,
        }),
      );
    }
  });

  it('yields a valid code-graph source location when a consumer mints one from a node', () => {
    // The node vocabulary carries no `SourceLocation` field — a second
    // definition of a shape `@debuggen/shared` owns is what the graph forbids —
    // so the assertion is that the published fields are *sufficient* to mint
    // one on the code-graph route of the resolution table.
    for (const component of componentsOf(extraction())) {
      const location = valueOrFail(
        parseSourceLocation({
          file: component.file,
          line: component.line,
          column: component.column,
          symbol: component.name,
          ...(component.endLine === undefined ? {} : { endLine: component.endLine }),
          resolvedBy: 'code-graph',
          confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
        }),
        `minting a source location for ${component.file}#${component.name}`,
      );

      expect(location.resolvedBy).toBe('code-graph');
      expect(location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
      expect(location.symbol).toBe(component.name);
      expect(location.file).toBe(component.file);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * What is not a component
 * ---------------------------------------------------------------------------------------------- */

describe('reactComponentsExtractor: declarations that must not become components', () => {
  it('records nothing for the widget module\u2019s helper export or the layout\u2019s constant', () => {
    // Over-detection here would pollute `findByName` for the investigation
    // stage and put a non-component in a "Found ‹Component›" progress message.
    const names = componentsOf(extraction()).map((component) => component.name);

    expect(names).not.toContain('formatGaugeCount');
    expect(names).not.toContain('metadata');

    // Each of those modules yields exactly its one component and no other.
    expect(
      fileEntry(extraction(), SERVER_WIDGET_MODULE).components.map((component) => component.name),
    ).toStrictEqual(['BasinSummary']);
    expect(
      fileEntry(extraction(), ROOT_LAYOUT_MODULE).components.map((component) => component.name),
    ).toStrictEqual(['ObservatoryLayout']);
  });

  it('records nothing for a route module, a service function, a driver stub or the barrel', () => {
    const byFile = extraction();

    for (const file of [
      'app/api/gauges/route.ts',
      'app/api/gauges/[id]/route.ts',
      'app/(observatory)/api/basins/[...segments]/route.ts',
      'pages/api/gauge-log.ts',
      'src/lib/station-service.ts',
      'src/lib/http.ts',
      'src/lib/datastore.ts',
      'src/lib/stubs/pg.ts',
      'src/lib/stubs/prisma-client.ts',
      BARREL_MODULE,
    ]) {
      const entry = fileEntry(byFile, file);

      expect(entry.components, `${file} must declare no component`).toStrictEqual([]);
      expect(entry.edges, `${file} must imply no renders edge`).toStrictEqual([]);
      expect(entry.announcedDiagnostics, `${file} must extract cleanly`).toBe(false);
    }

    // The two names an uppercase-first rule alone would have admitted: an
    // exported HTTP-method handler and a driver stub class.
    const names = componentsOf(byFile).map((component) => component.name);
    for (const name of ['GET', 'POST', 'Pool', 'PrismaClient', 'summarizeBasin', 'handler']) {
      expect(names, `'${name}' is not a React component`).not.toContain(name);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The declaration shapes the corpus does not carry
 * ---------------------------------------------------------------------------------------------- */

/**
 * The assigned, wrapped, class and anonymous forms, beside the near-misses that
 * share their syntax.
 *
 * Neutral identifiers throughout: the syntax is the subject, and a name
 * borrowed from an application under test would suggest otherwise.
 */
const SHAPE_MODULES: Readonly<Record<string, string>> = Object.freeze({
  'src/Shapes.tsx': [
    "import { forwardRef, memo } from 'react';",
    '',
    '/** An arrow-function const with a concise JSX body. */',
    'export const ArrowPanel = () => <section>arrow</section>;',
    '',
    '/** A memo wrapper around a named function expression. */',
    'export const MemoPanel = memo(function MemoPanelBody() {',
    '  return <section>memo</section>;',
    '});',
    '',
    '/** A forwardRef wrapper around an arrow function. */',
    'export const RefPanel = forwardRef((props: { label: string }, ref: unknown) => (',
    '  <section data-ref={String(ref)}>{props.label}</section>',
    '));',
    '',
    '/** A class component whose render method returns JSX. */',
    'export class ClassPanel {',
    '  render() {',
    '    return <section>class</section>;',
    '  }',
    '}',
    '',
    '/** Uppercase, exported, and not a function: not a component. */',
    "export const PANEL_LABELS = { arrow: 'arrow', memo: 'memo' };",
    '',
    '/** A class with no render method: not a component. */',
    'export class PanelRegistry {',
    '  describe() {',
    "    return 'no jsx here';",
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/AnonymousDefault.tsx': [
    '/** A truly anonymous default export, named after its file by the naming rule. */',
    'export default function () {',
    '  return <section>anonymous</section>;',
    '}',
    '',
  ].join('\n'),
  'src/TileList.tsx': [
    '/** Lowercase-initial, so neither a component declaration nor a component tag. */',
    'function tile() {',
    '  return <li>tile</li>;',
    '}',
    '',
    'export function TileList() {',
    '  return (',
    '    <ul>',
    '      <tile />',
    '    </ul>',
    '  );',
    '}',
    '',
  ].join('\n'),
});

/** The declaration-shape sandbox, planted on first use. */
let shapeSandbox: Sandbox | undefined;

/** The declaration-shape sandbox's opened project. */
function shapeProject(): Sandbox {
  shapeSandbox ??= plantSandbox(SHAPE_MODULES);

  return shapeSandbox;
}

describe('reactComponentsExtractor: the declaration shapes beyond the corpus', () => {
  it(
    'detects the arrow, memo, forwardRef and class forms, and refuses their near-misses',
    () => {
      const { loaded } = shapeProject();
      const text = textOf(loaded.projectRoot, 'src/Shapes.tsx');
      const { components } = extractFile(loaded, 'src/Shapes.tsx');

      expect(components.map(describeComponent)).toStrictEqual([
        {
          file: 'src/Shapes.tsx',
          name: 'ArrowPanel',
          ...identifierPosition(text, 'export const ', 'ArrowPanel'),
          exported: true,
          isClient: false,
          isDefaultExport: false,
          displayName: 'ArrowPanel',
          implementation: undefined,
        },
        {
          file: 'src/Shapes.tsx',
          name: 'MemoPanel',
          ...identifierPosition(text, 'export const ', 'MemoPanel'),
          exported: true,
          isClient: false,
          isDefaultExport: false,
          // The wrapped function's own name is what React reports; it is not a
          // separate module-level declaration, so nothing is `implementation`.
          displayName: 'MemoPanelBody',
          implementation: undefined,
        },
        {
          file: 'src/Shapes.tsx',
          name: 'RefPanel',
          ...identifierPosition(text, 'export const ', 'RefPanel'),
          exported: true,
          isClient: false,
          isDefaultExport: false,
          displayName: 'RefPanel',
          implementation: undefined,
        },
        {
          file: 'src/Shapes.tsx',
          name: 'ClassPanel',
          ...identifierPosition(text, 'export class ', 'ClassPanel'),
          exported: true,
          isClient: false,
          isDefaultExport: false,
          displayName: 'ClassPanel',
          implementation: undefined,
        },
      ]);
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it(
    'names an anonymous default export after its file basename',
    () => {
      const { loaded } = shapeProject();
      const { components } = extractFile(loaded, 'src/AnonymousDefault.tsx');

      expect(components.map(describeComponent)).toStrictEqual([
        {
          file: 'src/AnonymousDefault.tsx',
          name: 'AnonymousDefault',
          // Positioned at the declaration itself, because there is no identifier
          // to jump to.
          ...positionAtOffset(
            textOf(loaded.projectRoot, 'src/AnonymousDefault.tsx'),
            soleOffsetOf(
              textOf(loaded.projectRoot, 'src/AnonymousDefault.tsx'),
              'export default function',
            ),
          ),
          exported: true,
          isClient: false,
          isDefaultExport: true,
          displayName: 'AnonymousDefault',
          implementation: undefined,
        },
      ]);
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it(
    'treats a lowercase declaration and a lowercase tag as host markup',
    () => {
      const { loaded } = shapeProject();
      const { components, edges } = extractFile(loaded, 'src/TileList.tsx');

      expect(components.map((component) => component.name)).toStrictEqual(['TileList']);
      expect(edges).toStrictEqual([]);
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );
});

/* -------------------------------------------------------------------------------------------------
 * `renders` edges: one per usage site, resolved to the declaring module
 * ---------------------------------------------------------------------------------------------- */

/** A parent that renders one child twice and one component that resolves to nothing. */
const EDGE_MODULES: Readonly<Record<string, string>> = Object.freeze({
  'src/Child.tsx': [
    'export function Child({ label }: { label: string }) {',
    '  return <span>{label}</span>;',
    '}',
    '',
  ].join('\n'),
  'src/Parent.tsx': [
    "import { Child } from './Child';",
    "import { Absent } from 'unavailable-widget-package';",
    '',
    'export function Parent() {',
    '  return (',
    '    <div>',
    '      <Child label="first" />',
    '      <Child label="second" />',
    '      <Absent />',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n'),
});

/** The edge sandbox, planted on first use. */
let edgeSandbox: Sandbox | undefined;

/** The edge sandbox's opened project. */
function edgeProject(): Sandbox {
  edgeSandbox ??= plantSandbox(EDGE_MODULES);

  return edgeSandbox;
}

describe('reactComponentsExtractor: renders edges', () => {
  it('emits exactly the corpus edges, resolving each to the module that declares its target', () => {
    const components = componentsOf(extraction());

    // The direct relative import, the aliased barrel re-export and the
    // same-file declaration — the three routes tag resolution takes.
    expect(edgesOf(extraction()).map((edge) => describeEdge(edge, components))).toStrictEqual(
      CORPUS_EDGES.map(describeExpectedEdge),
    );
  });

  it('resolves the aliased barrel re-export through to the declaring module, not into the barrel', () => {
    const components = componentsOf(extraction());
    const [pageEdge] = fileEntry(extraction(), ROOT_PAGE_MODULE).edges;

    if (pageEdge === undefined) {
      return expect.unreachable(`${ROOT_PAGE_MODULE} was expected to imply one renders edge`);
    }

    // `@/widgets` -> src/widgets/index.ts -> `export { default as BasinSummary }`
    // -> src/widgets/BasinSummary.tsx. The barrel declares nothing, so an edge
    // into it would be an edge into a node nobody emits.
    expect(pageEdge.to).toBe(componentNamed(components, 'BasinSummary').id);
    expect(pageEdge.to).toContain(SERVER_WIDGET_MODULE);
    expect(pageEdge.to).not.toContain(BARREL_MODULE);
    expect(fileEntry(extraction(), BARREL_MODULE).components).toStrictEqual([]);

    // And the alias the barrel re-exports under never becomes the target's
    // name: `default as BasinSummary` continues with the original name.
    expect(graph().nodeById(pageEdge.to)?.file).toBe(SERVER_WIDGET_MODULE);
  });

  it('emits no edge for a module whose returned JSX is host elements only', () => {
    // Both modules render several host elements, which is what makes the empty
    // expectation a statement rather than an accident.
    for (const file of [ROOT_LAYOUT_MODULE, GROUPED_PAGE_MODULE]) {
      const text = textOf(FIXTURE_ROOT, file);

      expect(
        ['<html', '<body', '<div', '<h1', '<p>', '<dl'].filter((tag) => text.includes(tag)).length,
        `${file} was expected to render host elements`,
      ).toBeGreaterThan(0);

      expect(
        fileEntry(extraction(), file).edges,
        `${file} must imply no renders edge`,
      ).toStrictEqual([]);
    }
  });

  it('keeps every node and edge id of the corpus unique', () => {
    const nodeIds = componentsOf(extraction()).map((component) => component.id);
    const edgeIds = edgesOf(extraction()).map((edge) => edge.id);

    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });

  it(
    'emits one discriminated edge per usage site when a parent renders a child twice',
    () => {
      const { loaded } = edgeProject();
      const parent = extractFile(loaded, 'src/Parent.tsx');
      const child = extractFile(loaded, 'src/Child.tsx');
      const text = textOf(loaded.projectRoot, 'src/Parent.tsx');

      const childNode = componentNamed(child.components, 'Child');
      const parentNode = componentNamed(parent.components, 'Parent');
      const sites = tagPositions(text, 'Child');

      expect(sites).toHaveLength(2);

      // Two edges, not one with a count: the id carries the site's line and
      // column, so the two are distinct without an occurrence counter.
      expect(
        parent.edges.map((edge) => ({
          from: edge.from,
          to: edge.to,
          file: edge.file,
          line: edge.line,
          column: edge.column,
        })),
      ).toStrictEqual(
        sites.map((site) => ({
          from: parentNode.id,
          to: childNode.id,
          file: 'src/Parent.tsx',
          line: site.line,
          column: site.column,
        })),
      );

      expect(new Set(parent.edges.map((edge) => edge.id)).size).toBe(2);
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it(
    'emits no edge and no diagnostic, and does not throw, for a component from an uninstalled package',
    () => {
      const { loaded } = edgeProject();
      const context = contextFor(loaded, 'src/Parent.tsx');

      // Reading a module whose import resolves to nothing is the ordinary state
      // of a project being indexed before anything is installed, so it is not
      // even an exceptional path.
      expect(() => reactComponentsExtractor.extract(context)).not.toThrow();

      const parent = extractFile(loaded, 'src/Parent.tsx');
      const text = textOf(loaded.projectRoot, 'src/Parent.tsx');

      // The tag is written, and resolves to nothing: an edge there would name a
      // target node nobody emits, and an unresolvable component tag is not a
      // finding, so neither an edge nor a diagnostic is produced.
      expect(tagPositions(text, 'Absent')).toHaveLength(1);
      expect(parent.edges).toHaveLength(2);
      expect(parent.edges.every((edge) => edge.to.includes('src/Child.tsx'))).toBe(true);
      expect(parent.edges.some((edge) => edge.id.includes('Absent'))).toBe(false);
      expect(parent.diagnostics).toStrictEqual([]);
      expect(parent.announcedDiagnostics).toBe(false);
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it('keeps every renders edge in the assembled graph, dropping none as dangling', () => {
    const assembled = graph();
    const extracted = edgesOf(extraction());

    // The graph is what construction validated: an edge whose endpoint no
    // extractor emitted would be absent here and named in `dangling-edge`.
    const survived = assembled
      .edges()
      .filter((edge) => edge.kind === 'renders')
      .map((edge) => edge.id)
      .sort();

    expect(survived).toStrictEqual(extracted.map((edge) => edge.id).sort());
    expect(assembled.diagnostics.filter((entry) => entry.code === 'dangling-edge')).toStrictEqual(
      [],
    );
    expect(
      assembled.diagnostics.filter(
        (entry) => entry.code === 'duplicate-node-id' || entry.code === 'duplicate-edge-id',
      ),
    ).toStrictEqual([]);

    // Every endpoint resolves to a component node of the graph, which is the
    // property `componentsRendering` walks these edges on.
    for (const edge of assembled.edges().filter((entry) => entry.kind === 'renders')) {
      expect(assembled.nodeById(edge.from)?.kind, edge.id).toBe('component');
      expect(assembled.nodeById(edge.to)?.kind, edge.id).toBe('component');
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Robustness, purity and determinism
 * ---------------------------------------------------------------------------------------------- */

/**
 * A module the parser cannot read in full, beside one it can.
 *
 * `PRIVATE-SOURCE-MARKER` is the privacy probe: the parser's own messages quote
 * the text they choked on, and a diagnostic may carry none of it, so the marker
 * sits inside the unparsable construct and must not appear in anything the
 * extractor reports.
 */
const BROKEN_MODULES: Readonly<Record<string, string>> = Object.freeze({
  'src/Broken.tsx': [
    'export function Broken() {',
    '  return <section>PRIVATE-SOURCE-MARKER;',
    '}',
    '',
  ].join('\n'),
  'src/Intact.tsx': [
    'export function Intact() {',
    '  return <section>intact</section>;',
    '}',
    '',
  ].join('\n'),
});

/** The distinctive text the broken module holds and no diagnostic may repeat. */
const SOURCE_MARKER = 'PRIVATE-SOURCE-MARKER';

describe('reactComponentsExtractor: robustness, purity and determinism', () => {
  it(
    'emits deeply equal, identically ordered output on two consecutive runs',
    () => {
      const loaded = corpusProject();
      const first = extractEveryFile(loaded);
      const second = extractEveryFile(loaded);

      expect(second).toStrictEqual(first);

      // Serialisation equality as well as structural equality: an index is
      // cached and compared as JSON, so field and element order are part of the
      // contract rather than an implementation detail.
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it('reports every path as a project-relative POSIX path and leaks no absolute one', () => {
    const loaded = corpusProject();
    const components = componentsOf(extraction());
    const edges = edgesOf(extraction());

    expect(components.length).toBeGreaterThan(0);

    for (const component of components) {
      expect(isSafeRelativePath(component.file), component.file).toBe(true);

      for (const value of [
        component.id,
        component.name,
        component.file,
        component.data.displayName,
        component.data.implementation ?? '',
      ]) {
        expect(value, `${component.id} must carry no absolute path`).not.toContain(
          loaded.projectRoot,
        );
        expect(value.startsWith('/'), `${component.id} must carry no absolute path`).toBe(false);
      }
    }

    for (const edge of edges) {
      expect(edge.file).toBeDefined();
      expect(isSafeRelativePath(edge.file ?? ''), edge.id).toBe(true);

      for (const value of [edge.id, edge.from, edge.to, edge.file ?? '']) {
        expect(value, `${edge.id} must carry no absolute path`).not.toContain(loaded.projectRoot);
      }
    }
  });

  it(
    'reports an unparsable module as a diagnostic that quotes no source, and still indexes its sibling',
    () => {
      const { loaded } = plantSandbox(BROKEN_MODULES);
      const broken = extractFile(loaded, 'src/Broken.tsx');
      const intact = extractFile(loaded, 'src/Intact.tsx');

      // A diagnostic rather than a throw: the run continues and the file's own
      // findings are kept.
      expect(broken.diagnostics).toHaveLength(1);

      const [diagnostic] = broken.diagnostics;
      if (diagnostic === undefined) {
        return expect.unreachable('the unparsable module was expected to yield one diagnostic');
      }

      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.code).toBe('extractor-failed');
      expect(diagnostic.extractorId).toBe('react-components');
      expect(diagnostic.file).toBe('src/Broken.tsx');
      expect(diagnostic.message).toMatch(/syntax error/);

      // The privacy constraint every index diagnostic is under.
      expect(diagnostic.message).not.toContain(SOURCE_MARKER);
      expect(diagnostic.detail ?? '').not.toContain(SOURCE_MARKER);
      expect(JSON.stringify(diagnostic)).not.toContain(SOURCE_MARKER);

      // One unreadable file costs nothing outside itself.
      expect(intact.components.map((component) => component.name)).toStrictEqual(['Intact']);
      expect(intact.announcedDiagnostics).toBe(false);
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it(
    'writes nothing: a scratch project\u2019s file set, bytes and modification times are unchanged',
    () => {
      const { root, loaded } = plantSandbox(SHAPE_MODULES);
      const before = snapshotTree(root);

      extractEveryFile(loaded);

      expect(snapshotTree(root)).toStrictEqual(before);
    },
    SANDBOX_CASE_TIMEOUT_MS,
  );

  it('shares its component node ids with the handles edges of the event-handler extractor', () => {
    const assembled = graph();
    const componentIds = new Set(componentsOf(extraction()).map((component) => component.id));
    const handles = assembled.edges().filter((edge) => edge.kind === 'handles');

    // The corpus binds a handler inside a component, so this set is non-empty;
    // if it were empty the case would prove nothing.
    expect(handles.length).toBeGreaterThan(0);

    for (const edge of handles) {
      // The single most likely cross-extractor regression: one extractor's
      // naming rule drifting from the other's, which turns the edge from an
      // interaction to its component into a silently dropped `dangling-edge`.
      expect(assembled.nodeById(edge.from)?.kind, edge.id).toBe('component');
      expect(
        componentIds.has(edge.from),
        `the handles edge ${edge.id} names a component id this extractor did not emit`,
      ).toBe(true);
      expect(assembled.nodeById(edge.to)?.kind, edge.id).toBe('handler');
    }
  });

  it('leaves the committed corpus byte-for-byte as it found it', () => {
    if (corpusSnapshot === undefined) {
      return expect.unreachable('the corpus was not snapshotted: beforeAll did not run');
    }

    // The corpus is shared input for every suite of this package: a case that
    // wrote to it would corrupt expectations far outside this file, so the
    // directive-toggling cases copy it and this case proves they did.
    expect(snapshotTree(FIXTURE_ROOT)).toStrictEqual(corpusSnapshot);
  });
});
