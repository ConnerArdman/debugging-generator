/**
 * Unit suite for `./event-handlers.ts` — the extractor that owns the `handler`
 * node kind and the `handles` edge kind of the code graph.
 *
 * A handler node is where a user interaction enters the application's own code,
 * so it is the head of the cross-tier chain `../graph/query.ts` walks — client
 * component → named handler → literal fetch → route handler → server function →
 * database call — and both of the corpus' `fetch` sites sit *inside* the one
 * handler the corpus declares. Three properties of that node therefore have to
 * be exactly right, and each has a distinct failure mode nothing else catches:
 *
 * - **Its identity.** `makeNodeId` derives a node's id from kind, file, name and
 *   position, and another extractor that wants to attribute a call to a handler
 *   has to derive the same id. A wrong name or position is not a slightly wrong
 *   node, it is a second node nobody references.
 * - **Its position.** Click-to-source takes the `code-graph` route of AAP 0.4.2
 *   straight from `file`/`line`/`column`, so a named handler positioned at the
 *   JSX attribute instead of at its own declaration opens the markup rather than
 *   the function a developer asked to see. The case that pins this locates both
 *   offsets in the fixture's own text and asserts the node matches the
 *   declaration and differs from the attribute.
 * - **Its `handles` edge.** The edge points at a `component` node that
 *   `./react-components.ts` declares, so this extractor re-derives that module's
 *   naming rule. An id that differs in one character is dropped by
 *   `../graph/graph.ts` as `dangling-edge`, which silently deletes the path from
 *   an interaction to the component it happened in — a removal no per-file
 *   assertion can see. The edge is therefore resolved **in the assembled
 *   graph**, against the component node the other extractor really emitted.
 *
 * ## What is pinned here
 *
 * Every invariant below is the module documentation of `./event-handlers.ts`
 * restated as an executable assertion:
 *
 * 1. the corpus' single binding — one node, event `click`, bound by reference to
 *    the module's named handler, positioned at that handler's declaration, with
 *    a project-relative POSIX `file` a `SourceLocation` accepts;
 * 2. exactly one `handles` edge, from the enclosing component, carrying the
 *    *binding site* rather than the declaration, retained by graph construction;
 * 3. the binding shapes the corpus deliberately lacks — inline arrow, inline
 *    function expression, property-access reference, `Capture` phase suffix, an
 *    open-ended event vocabulary, props that only look like events, one named
 *    handler bound several times, a reference that cannot be resolved, and
 *    markup outside every component;
 * 4. and the properties the whole index depends on — determinism, tolerance of a
 *    module the parser could not finish, diagnostics that quote no source text,
 *    a `file` the indexer would actually visit, no write of any kind, and
 *    membership of the closed node and edge vocabularies.
 *
 * ## How the cases are driven
 *
 * Two projects, each opened once in `beforeAll` through the real `openProject`,
 * and each visited with a per-file {@link ExtractorContext} built exactly as
 * `../indexer.ts` builds one:
 *
 * - **The committed corpus** at `../../test/fixtures/sample-next-app`, opened
 *   where it lives and **never written**. It is shared with several other suites
 *   whose expectations are fixed numbers, so a case that needed a new shape adds
 *   it to the scratch project below rather than to the corpus. `../indexer.ts`'s
 *   `buildIndex` is run over it once as well, because the cross-extractor
 *   agreement and the absence of a `dangling-edge` finding are only observable
 *   in the assembled graph.
 * - **An `mkdtemp` scratch project** written in `beforeAll` and removed in
 *   `afterAll`, carrying its own minimal `tsconfig.json` and **no installed
 *   package at all** — which is also the point: the extractor reads syntax, so
 *   an unresolvable `react` or an absent dependency must cost it nothing.
 *
 * Positions are never written as literals. Each expectation is located in the
 * source text the case itself supplied and converted to the 1-based line and
 * column {@link CodeNodeBase.line} fixes, so a case cannot drift from the file
 * it is about and a failure names the position it wanted.
 *
 * Fixture and scratch identifiers are test data (`RowPanel`, `handleApply`): the
 * subject is syntax, and a name borrowed from an application under test would
 * suggest the extractor recognises vocabulary, which is precisely what AAP 0.5.4
 * forbids it from doing.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isOk,
  isSafeRelativePath,
  noopLogger,
  parseSourceLocation,
} from '@debuggen/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CodeGraph, makeNodeId } from '../graph/graph.js';
import {
  CODE_EDGE_KINDS,
  CODE_NODE_KINDS,
  INDEX_DIAGNOSTIC_SEVERITIES,
  isIndexDiagnosticCode,
} from '../graph/types.js';
import type {
  CodeEdge,
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
} from '../graph/types.js';
import { buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import type { LoadedProject } from '../project.js';
import { eventHandlersExtractor } from './event-handlers.js';

/* -------------------------------------------------------------------------------------------------
 * Corpus and scratch-project sources
 * ---------------------------------------------------------------------------------------------- */

/**
 * The committed indexing corpus, resolved from this module's own URL rather
 * than from `process.cwd()`: the `code-analysis` Vitest project can be run from
 * the repository root or from the workspace, and only the module URL is the same
 * in both.
 */
const CORPUS_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/** The corpus' client widget: the one module of it that binds an event handler. */
const CORPUS_WIDGET = 'src/widgets/GaugeReadout.tsx';

/**
 * The corpus modules that must yield no handler at all: the server component,
 * the three App Router route modules, the Pages Router remnant and the service
 * layer.
 *
 * Listed rather than derived, because "no handler here" is the assertion and a
 * derivation that happened to select nothing would pass vacuously.
 */
const CORPUS_HANDLERLESS_MODULES: readonly string[] = Object.freeze([
  'src/widgets/BasinSummary.tsx',
  'app/api/gauges/route.ts',
  'app/api/gauges/[id]/route.ts',
  'app/(observatory)/api/basins/[...segments]/route.ts',
  'pages/api/gauge-log.ts',
  'src/lib/station-service.ts',
  'src/lib/datastore.ts',
  'src/lib/http.ts',
]);

/**
 * A string that exists in the scratch project's sources and must never appear
 * in a diagnostic.
 *
 * `INDEX_DIAGNOSTIC_CODES` constrains a diagnostic to name things — a file, an
 * extractor, a symbol, a limit — and to quote nothing, because diagnostics are
 * logged, persisted with a session and can reach model prompt context
 * (AAP 0.5.2). A marker planted in the source is how "quotes nothing" becomes
 * testable: any mechanism that echoed a slice of the developer's file would
 * carry this with it.
 */
const SOURCE_MARKER = 'marker-text-that-must-not-be-quoted';

/**
 * The scratch project, keyed by project-relative POSIX path.
 *
 * One module per shape, so a failure names the shape and so the positions each
 * case locates in the text cannot be disturbed by an unrelated edit. Nothing
 * here imports anything that exists: the extractor resolves modules of the
 * project under extraction and consults no type, so an unresolvable specifier is
 * a case rather than a problem.
 */
const SCRATCH_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        jsx: 'preserve',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    },
    null,
    2,
  )}\n`,

  // Inline bindings: the branch the corpus deliberately omits.
  'src/InlinePanel.tsx': `export function InlinePanel({ label }: { label: string }) {
  return (
    <section>
      <button onClick={() => label.trim()}>arrow</button>
      <button onMouseEnter={function () {}}>expression</button>
    </section>
  );
}
`,

  // Property-access references: one through an opaque receiver, one through
  // \`this\`, which is the only receiver syntax can resolve.
  'src/ReferencePanels.tsx': `export function RowPanel(props: { onSelect: () => void }) {
  return <button onClick={props.onSelect}>select</button>;
}

export class PressPanel {
  onPress = () => {};

  render() {
    return <button onClick={this.onPress}>press</button>;
  }
}
`,

  // The event vocabulary: one named handler per prop, because a single handler
  // bound to several props yields one node carrying the first binding's event.
  'src/VocabularyPanel.tsx': `export function VocabularyPanel() {
  function handleSubmit() {}
  function handleChange() {}
  function handleKeyDown() {}
  function handleMouseEnter() {}
  function handleCapturePhase() {}
  function handleProjectProp() {}

  return (
    <form onSubmit={handleSubmit}>
      <input onChange={handleChange} onKeyDown={handleKeyDown} />
      <span onMouseEnter={handleMouseEnter} />
      <button onClickCapture={handleCapturePhase}>phase</button>
      <ReadingChart onViewportSettled={handleProjectProp} />
    </form>
  );
}
`,

  // Props that merely start with the same two letters, plus a lower-cased
  // suffix and the bare prefix.
  'src/NonEventPanel.tsx': `export function NonEventPanel() {
  function handleApply() {}

  return (
    <div online={handleApply} onward={handleApply} once={handleApply} onclick={handleApply}>
      <span on={handleApply}>status</span>
    </div>
  );
}
`,

  // One named handler bound three times, to two different events.
  'src/SharedHandlerPanel.tsx': `export function SharedHandlerPanel() {
  function handleApply() {}

  return (
    <section>
      <button onClick={handleApply}>first</button>
      <button onClick={handleApply}>second</button>
      <input onChange={handleApply} />
    </section>
  );
}
`,

  // A reference syntax cannot follow: the module it comes from is not installed
  // and never will be.
  'src/RemotePanel.tsx': `import { handleRemote } from 'absent-package-under-test';

export function RemotePanel() {
  return <button onClick={handleRemote}>remote</button>;
}
`,

  // A handler declared in another module of the same project: the node belongs
  // in *that* module, while the edge stays in the markup's.
  'src/ImportingPanel.tsx': `import { handleImported } from './shared-handlers';

export function ImportingPanel() {
  return <button onClick={handleImported}>imported</button>;
}
`,
  'src/shared-handlers.ts': `export function handleImported(): void {}
`,

  // Markup outside every module-level component: a node, and no edge.
  'src/helper-markup.tsx': `function buildRowMarkup(onPick: () => void) {
  return <button onClick={onPick}>pick</button>;
}

export const rowMarkup = buildRowMarkup;
`,

  // Bindings that name one of two handlers, or name nothing a developer could
  // search for, plus the one call shape that is looked through.
  'src/OpaquePanel.tsx': `export function OpaquePanel({ ready }: { ready: boolean }) {
  function handleApply() {}
  const registry = { apply: handleApply };

  return (
    <section>
      <button onClick={ready ? handleApply : undefined}>conditional</button>
      <button onClick={registry['apply']}>subscript</button>
      <button onClick={undefined}>absent</button>
      <button onClick>shorthand</button>
      <button onClick="text">string</button>
      <button onClick={handleApply.bind(null)}>bound</button>
    </section>
  );
}
`,

  // A module the parser cannot finish. The marker is what proves no diagnostic
  // quotes the file.
  'src/broken-module.tsx': `const label = '${SOURCE_MARKER}';

export function BrokenPanel( {
  return <button onClick={
}
`,
});

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

/** One file of an opened project, named without importing ts-morph's own type. */
type LoadedSourceFile = ReturnType<LoadedProject['sourceFiles']>[number];

/** A 1-based position, on the convention `CodeNodeBase.line` fixes. */
interface Position {
  /** The 1-based line. */
  readonly line: number;

  /** The 1-based column. */
  readonly column: number;
}

/**
 * Everything one visit of a project produced, kept per file and flattened.
 *
 * The flattened lists are what most cases assert on; the per-file map is what
 * lets a case say "this module yielded nothing" without searching a list for an
 * absence.
 */
interface ProjectExtraction {
  /** The project this extraction is over. */
  readonly loaded: LoadedProject;

  /** Each visited file's result, keyed by its project-relative POSIX path. */
  readonly byFile: ReadonlyMap<string, ExtractorResult>;

  /** Every handler node, in visit order. */
  readonly nodes: readonly CodeNodeOf<'handler'>[];

  /** Every edge, in visit order. */
  readonly edges: readonly CodeEdge[];

  /** Every diagnostic, in visit order. */
  readonly diagnostics: readonly IndexDiagnostic[];
}

/** The corpus, opened once: the extractor mutates nothing, so one open serves every case. */
let corpus: ProjectExtraction | undefined;

/** The corpus' assembled index, for the cases about graph construction's findings. */
let corpusIndex: CodeIndex | undefined;

/** The corpus' graph, where a `handles` edge's endpoints can actually be resolved. */
let corpusGraph: CodeGraph | undefined;

/** The scratch project's root, `undefined` until it is created. */
let scratchRoot: string | undefined;

/** The scratch project, opened once over the sources above. */
let scratch: ProjectExtraction | undefined;

/** The scratch project's assembled index, for the cases about diagnostics. */
let scratchIndex: CodeIndex | undefined;

/** The scratch project's graph, for the cases about edges and construction. */
let scratchGraph: CodeGraph | undefined;

beforeAll(async () => {
  corpus = visitProject(openOrFail(CORPUS_ROOT));
  corpusIndex = await buildOrFail(corpus.loaded);
  corpusGraph = CodeGraph.fromIndex(corpusIndex, { logger: noopLogger });

  scratchRoot = writeScratchProject();
  scratch = visitProject(openOrFail(scratchRoot));
  scratchIndex = await buildOrFail(scratch.loaded);
  scratchGraph = CodeGraph.fromIndex(scratchIndex, { logger: noopLogger });
}, 30_000);

afterAll(() => {
  // The corpus is never written and therefore never cleaned up; the scratch
  // project is this suite's own and leaves nothing behind.
  if (scratchRoot !== undefined) {
    rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = undefined;
  }
});

/**
 * Writes the scratch project into a fresh temporary directory.
 *
 * `realpathSync` is applied to the created root because a platform that links
 * its temporary directory (macOS links `/tmp`) would otherwise hand back a path
 * `openProject` resolves to a different one, and every `file` this suite
 * compares against is derived from the root the loader settled on.
 *
 * @returns The project root, absolute and fully resolved.
 */
function writeScratchProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-event-handlers-')));

  for (const [file, text] of Object.entries(SCRATCH_SOURCES)) {
    const absolute = join(root, file);

    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  }

  return root;
}

/**
 * Opens a project this suite expects to open, or fails with the reason it did
 * not.
 *
 * `openProject` reports every failure as a value, so an exception here would
 * mean a bug in the harness rather than in the loader; the message carries the
 * loader's own explanation, which names the path and the reason.
 *
 * @param projectRoot The absolute root to open.
 * @returns The opened project.
 */
function openOrFail(projectRoot: string): LoadedProject {
  const opened = openProject({ projectRoot, logger: noopLogger });

  if (!isOk(opened)) {
    return expect.unreachable(
      `openProject was expected to succeed for ${projectRoot} and failed with ${opened.error.code}: ${opened.error.message}`,
    );
  }

  return opened.value;
}

/**
 * Builds the whole index over an opened project, or fails with the reason it
 * could not.
 *
 * Run because two of this file's invariants are only observable after graph
 * construction: whether the `handles` edge survived it, and whether the
 * component node its `from` names is the one `./react-components.ts` emitted.
 *
 * @param loaded The opened project.
 * @returns The index, canonically ordered and de-duplicated.
 */
async function buildOrFail(loaded: LoadedProject): Promise<CodeIndex> {
  const built = await buildIndex(loaded, { logger: noopLogger });

  if (!isOk(built)) {
    return expect.unreachable(
      `buildIndex was expected to succeed for ${loaded.projectRoot} and failed with ${built.error.code}: ${built.error.message}`,
    );
  }

  return built.value;
}

/**
 * The {@link ExtractorContext} for one file, built exactly as `../indexer.ts`
 * builds it: the same handle, the same project-relative path from
 * `LoadedProject.projectRelative`, the same root, one logger for the run.
 *
 * `noopLogger` rather than a recording stub: this extractor reports what it
 * found out as `IndexDiagnostic`s on its result — the contract its header states
 * — and logs only when a caller handed it a path that is not project-relative,
 * which is its own case below.
 *
 * @param loaded The opened project.
 * @param sourceFile The file to visit.
 * @param file The project-relative POSIX path to report nodes under.
 * @returns The context.
 */
function contextFor(
  loaded: LoadedProject,
  sourceFile: LoadedSourceFile,
  file: string,
): ExtractorContext {
  return { loaded, sourceFile, file, projectRoot: loaded.projectRoot, logger: noopLogger };
}

/**
 * Visits every indexable file of a project and collects what the extractor
 * produced.
 *
 * The visit order is `LoadedProject.sourceFiles()`, which is sorted by
 * project-relative path and frozen, so the flattened lists below are in a
 * deterministic order and two visits can be compared element by element.
 *
 * @param loaded The opened project.
 * @returns The per-file results and the flattened nodes, edges and diagnostics.
 */
function visitProject(loaded: LoadedProject): ProjectExtraction {
  const byFile = new Map<string, ExtractorResult>();
  const nodes: CodeNodeOf<'handler'>[] = [];
  const edges: CodeEdge[] = [];
  const diagnostics: IndexDiagnostic[] = [];

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(sourceFile.getFilePath());

    if (file === undefined) {
      return expect.unreachable(
        `${sourceFile.getFilePath()} must be expressible relative to ${loaded.projectRoot}`,
      );
    }

    const result = eventHandlersExtractor.extract(contextFor(loaded, sourceFile, file));

    byFile.set(file, result);
    nodes.push(...result.nodes.filter(isHandlerNode));
    edges.push(...result.edges);
    diagnostics.push(...(result.diagnostics ?? []));
  }

  return { loaded, byFile, nodes, edges, diagnostics };
}

/**
 * Narrows a node to the one kind this extractor emits.
 *
 * `ExtractorResult.nodes` is typed as the whole `CodeNode` union, so the
 * narrowing happens once here instead of at every assertion — and the cases
 * that assert the *kind* do so against the unnarrowed lists, so this filter
 * cannot hide a node of another kind.
 *
 * @param node Any node from a result.
 * @returns `true` when it is a `handler` node.
 */
function isHandlerNode(node: CodeNode): node is CodeNodeOf<'handler'> {
  return node.kind === 'handler';
}

/**
 * The extraction of a project the suite has already opened, or a failure naming
 * the hook that should have produced it.
 *
 * @param extraction The module-level handle.
 * @param what Which project is being asked for.
 * @returns The extraction.
 */
function requireExtraction(
  extraction: ProjectExtraction | undefined,
  what: string,
): ProjectExtraction {
  if (extraction === undefined) {
    return expect.unreachable(`the ${what} was not opened: beforeAll did not run`);
  }

  return extraction;
}

/**
 * The graph of a project the suite has already indexed, or a failure naming the
 * hook that should have produced it.
 *
 * @param graph The module-level handle.
 * @param what Which project is being asked for.
 * @returns The graph.
 */
function requireGraph(graph: CodeGraph | undefined, what: string): CodeGraph {
  if (graph === undefined) {
    return expect.unreachable(`the ${what} was not indexed: beforeAll did not run`);
  }

  return graph;
}

/**
 * One file's result, or a failure naming the file and what the project did
 * hold.
 *
 * A missing entry means the project no longer contains the module a case is
 * about, which is worth a sentence rather than an assertion on `undefined`.
 *
 * @param extraction The project's extraction.
 * @param file The project-relative POSIX path.
 * @returns That file's result.
 */
function resultFor(extraction: ProjectExtraction, file: string): ExtractorResult {
  const result = extraction.byFile.get(file);

  if (result === undefined) {
    return expect.unreachable(
      `${file} is not in the project, which holds ${[...extraction.byFile.keys()].join(', ')}`,
    );
  }

  return result;
}

/**
 * One file's handler nodes, in the order the extractor emitted them.
 *
 * @param extraction The project's extraction.
 * @param file The project-relative POSIX path.
 * @returns The handler nodes of that file's result.
 */
function handlersIn(extraction: ProjectExtraction, file: string): readonly CodeNodeOf<'handler'>[] {
  return resultFor(extraction, file).nodes.filter(isHandlerNode);
}

/**
 * The single element of a list, or a failure that names every element found.
 *
 * Every case that reaches for one node, edge or diagnostic goes through here, so
 * a case that accidentally matched two of them fails with both rather than with
 * an index that happened to exist.
 *
 * @param items The list.
 * @param what What the list was supposed to hold exactly one of.
 * @returns The only element.
 */
function only<T>(items: readonly T[], what: string): T {
  const [first] = items;

  if (items.length !== 1 || first === undefined) {
    return expect.unreachable(
      `expected exactly one ${what}, found ${String(items.length)}: ${JSON.stringify(items)}`,
    );
  }

  return first;
}

/**
 * The handler node of a given name, or a failure naming what was found.
 *
 * @param nodes The nodes to search.
 * @param name The node name to select on.
 * @returns The only node of that name.
 */
function handlerNamed(
  nodes: readonly CodeNodeOf<'handler'>[],
  name: string,
): CodeNodeOf<'handler'> {
  return only(
    nodes.filter((node) => node.name === name),
    `handler node named ${name}`,
  );
}

/**
 * The 1-based position of a substring in a file's text.
 *
 * This is how every expected position in this suite is obtained: the case names
 * the text it means, and the line and column are computed from the file the
 * extractor read. A literal line number would drift the moment a fixture gains
 * a line, and would say nothing about *which* construct the node was meant to
 * point at.
 *
 * @param text The file's text.
 * @param needle The substring to locate; must occur.
 * @param occurrence Which occurrence to take, 1-based. Defaults to the first.
 * @returns The 1-based line and column the substring starts at.
 */
function positionOf(text: string, needle: string, occurrence = 1): Position {
  let offset = -1;

  for (let found = 0; found < occurrence; found += 1) {
    offset = text.indexOf(needle, offset + 1);

    if (offset < 0) {
      return expect.unreachable(
        `the case needs occurrence ${String(occurrence)} of ${JSON.stringify(needle)} in the source it names`,
      );
    }
  }

  const before = text.slice(0, offset);
  const lineBreaks = before.split('\n');
  const lastLine = lineBreaks[lineBreaks.length - 1] ?? '';

  return { line: lineBreaks.length, column: lastLine.length + 1 };
}

/**
 * The 1-based position of a node, as a comparable object.
 *
 * @param node A handler node.
 * @returns Its position.
 */
function positionOfNode(node: CodeNodeOf<'handler'>): Position {
  return { line: node.line, column: node.column };
}

/** The text of one corpus module. */
function corpusText(file: string): string {
  return readFileSync(join(CORPUS_ROOT, file), 'utf8');
}

/**
 * The text of one scratch module, taken from the constant this suite wrote
 * rather than read back, so a case cannot assert against a file it failed to
 * write.
 *
 * @param file The project-relative POSIX path.
 * @returns The module's source text.
 */
function scratchText(file: string): string {
  const text = SCRATCH_SOURCES[file];

  if (text === undefined) {
    return expect.unreachable(`the scratch project declares no ${file}`);
  }

  return text;
}

/**
 * Every file under a directory with its size and modification time, keyed by
 * path relative to that directory.
 *
 * The purity check compares two of these around an extraction: a read leaves
 * both values alone, while any write — a formatter, a cache, an "organise
 * imports" — moves at least one of them.
 *
 * @param root The directory to walk.
 * @returns One entry per file.
 */
function treeSnapshot(root: string): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>();
  const pending: string[] = [''];

  while (pending.length > 0) {
    const relative = pending.pop();

    if (relative === undefined) {
      break;
    }

    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }

      const stats = statSync(join(root, child));

      snapshot.set(child, `${String(stats.size)}:${String(stats.mtimeMs)}`);
    }
  }

  return snapshot;
}

/**
 * The corpus' assembled index, or a failure naming the hook that should have
 * produced it.
 *
 * @returns The index.
 */
function requireCorpusIndex(): CodeIndex {
  if (corpusIndex === undefined) {
    return expect.unreachable('the corpus was not indexed: beforeAll did not run');
  }

  return corpusIndex;
}

/**
 * The scratch project's assembled index, or a failure naming the hook that
 * should have produced it.
 *
 * @returns The index.
 */
function requireScratchIndex(): CodeIndex {
  if (scratchIndex === undefined) {
    return expect.unreachable('the scratch project was not indexed: beforeAll did not run');
  }

  return scratchIndex;
}

/**
 * The scratch project's root, or a failure naming the hook that should have
 * created it.
 *
 * @returns The absolute project root.
 */
function requireScratchRoot(): string {
  if (scratchRoot === undefined) {
    return expect.unreachable('the scratch project was not created: beforeAll did not run');
  }

  return scratchRoot;
}

/**
 * The identifier the corpus' `onClick` attribute names, read out of the corpus
 * itself.
 *
 * Derived rather than written down: the assertions about the node's name and
 * symbol are that they are **the handler the markup references**, and a literal
 * would state the corpus' current spelling instead.
 *
 * @returns The referenced identifier.
 */
function corpusReferencedHandler(): string {
  const matched = /onClick=\{([A-Za-z_$][\w$]*)\}/.exec(corpusText(CORPUS_WIDGET));
  const name = matched?.[1];

  if (name === undefined) {
    return expect.unreachable(`${CORPUS_WIDGET} must bind onClick to a named handler`);
  }

  return name;
}

/**
 * Every `handles` edge of a graph, which is every edge this extractor can
 * contribute to one.
 *
 * @param graph The assembled graph.
 * @returns The `handles` edges in canonical order.
 */
function handlesEdgesOf(graph: CodeGraph): readonly CodeEdge[] {
  return graph.edges().filter((edge) => edge.kind === 'handles');
}

/* -------------------------------------------------------------------------------------------------
 * 1. The corpus' single handler: named, bound by reference, positioned at its declaration
 * ---------------------------------------------------------------------------------------------- */

describe("the corpus' single event handler", () => {
  it('yields exactly one handler node, and only in the client widget module', () => {
    const extraction = requireExtraction(corpus, 'corpus');
    const node = only(extraction.nodes, 'handler node in the corpus');

    expect(node.kind).toBe('handler');
    expect(node.file).toBe(CORPUS_WIDGET);
    expect(handlersIn(extraction, CORPUS_WIDGET)).toHaveLength(1);

    // Every other module of the corpus contributed nothing, which is the other
    // half of "exactly one": a second node anywhere would fail `only` above,
    // and this states where the one node came from.
    const elsewhere = [...extraction.byFile.entries()].filter(
      ([file, result]) => file !== CORPUS_WIDGET && result.nodes.length > 0,
    );

    expect(elsewhere.map(([file]) => file)).toEqual([]);
  });

  it('derives the click event from the onClick prop and binds it by reference', () => {
    const node = only(requireExtraction(corpus, 'corpus').nodes, 'handler node in the corpus');
    const referenced = corpusReferencedHandler();

    // The payload is exactly the three fields `HandlerNodeData` declares: the
    // event with the `on` prefix removed and its initial lower-cased, the tag
    // as written, and the binding style.
    expect(node.data).toEqual({ event: 'click', boundTo: 'button', inline: false });

    // A named binding is named for the function, not for the property, and
    // carries the same name as the symbol an instrumentation action would
    // address — the corpus declares the handler inside its component, so it is
    // not exported.
    expect(node.name).toBe(referenced);
    expect(node.symbol).toBe(referenced);
    expect(node.exported).toBe(false);
  });

  it('binds no inline handler anywhere in the corpus', () => {
    const extraction = requireExtraction(corpus, 'corpus');

    expect(extraction.nodes.filter((node) => node.data.inline)).toEqual([]);
  });

  it('positions the node at the handler declaration and never at the JSX attribute', () => {
    const node = only(requireExtraction(corpus, 'corpus').nodes, 'handler node in the corpus');
    const referenced = corpusReferencedHandler();
    const text = corpusText(CORPUS_WIDGET);

    // Both offsets, located in the corpus' own text and converted to the
    // 1-based pair a node carries: the declaration's identifier, and the
    // attribute that binds it.
    const declaration = positionOf(text, `${referenced} = `);
    const attribute = positionOf(text, `onClick={${referenced}}`);

    // This is the assertion click-to-source depends on. Opening the attribute
    // instead of the declaration shows a developer the markup they already
    // clicked rather than the function they asked about.
    expect(positionOfNode(node)).toEqual(declaration);
    expect(positionOfNode(node)).not.toEqual(attribute);

    // The extent covers the declaration and stops before the markup that binds
    // it, so an editor revealing `line`..`endLine` reveals the function.
    expect(node.endLine).toBeGreaterThanOrEqual(node.line);
    expect(node.endLine).toBeLessThan(attribute.line);
  });

  it('carries fields a code-graph source location accepts unchanged', () => {
    const node = only(requireExtraction(corpus, 'corpus').nodes, 'handler node in the corpus');

    // A `handler` node does not *hold* a `SourceLocation` — the node vocabulary
    // has no such field, and re-declaring a shape that lives in
    // `@debuggen/shared` is what `../graph/types.ts` forbids. What it promises
    // is that its position fields mint one: this is the `code-graph` route of
    // AAP 0.4.2 exactly as a consumer takes it.
    const parsed = parseSourceLocation({
      file: node.file,
      line: node.line,
      column: node.column,
      endLine: node.endLine,
      symbol: node.symbol,
      resolvedBy: 'code-graph',
      confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
    });

    if (!isOk(parsed)) {
      return expect.unreachable(
        `the node's fields must form a source location and did not: ${parsed.error.message}`,
      );
    }

    expect(parsed.value.resolvedBy).toBe('code-graph');
    expect(parsed.value.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
    expect(parsed.value.file).toBe(CORPUS_WIDGET);

    // The refinement the schema applies is already satisfied by the extractor,
    // so no consumer has to sanitise the path a second time.
    expect(isSafeRelativePath(node.file)).toBe(true);
    expect(node.file.includes('\\')).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. The `handles` edge: component → handler, agreed with `./react-components.ts`
 * ---------------------------------------------------------------------------------------------- */

describe('the handles edge', () => {
  it('emits exactly one handles edge for the corpus, pointing at the handler node', () => {
    const extraction = requireExtraction(corpus, 'corpus');
    const node = only(extraction.nodes, 'handler node in the corpus');
    const edge = only(extraction.edges, 'edge in the corpus');

    expect(edge.kind).toBe('handles');
    expect(edge.to).toBe(node.id);
    expect(edge.file).toBe(CORPUS_WIDGET);
  });

  it('records the binding site on the edge while the node keeps the declaration', () => {
    const extraction = requireExtraction(corpus, 'corpus');
    const node = only(extraction.nodes, 'handler node in the corpus');
    const edge = only(extraction.edges, 'edge in the corpus');
    const attribute = positionOf(
      corpusText(CORPUS_WIDGET),
      `onClick={${corpusReferencedHandler()}}`,
    );

    // The relationship is written at the attribute, which is what makes one
    // function bound at several places one node and several distinct edges.
    expect({ line: edge.line, column: edge.column }).toEqual(attribute);
    expect(edge.line).not.toBe(node.line);
  });

  it('names the component node the component extractor declares, by the same naming rule', () => {
    const graph = requireGraph(corpusGraph, 'corpus');
    const edge = only(handlesEdgesOf(graph), 'handles edge in the corpus graph');
    const from = graph.nodeById(edge.from);
    const to = graph.nodeById(edge.to);

    // Resolved in the assembled graph rather than in this extractor's own
    // result: the component node is `./react-components.ts`'s, and an id that
    // differs from it by one character is not a wrong edge but a missing one.
    if (from === undefined || to === undefined) {
      return expect.unreachable(
        `both endpoints of the handles edge must resolve in the graph: ${edge.from} -> ${edge.to}`,
      );
    }

    expect(from.kind).toBe('component');
    expect(from.file).toBe(CORPUS_WIDGET);
    expect(to.kind).toBe('handler');

    // The naming rule itself: kind, file, name and the identifier's position.
    // Re-derived from the component node's own fields, so this fails if either
    // module changes how a component is named or positioned without the other.
    expect(edge.from).toBe(
      makeNodeId({
        kind: 'component',
        file: from.file,
        name: from.name,
        line: from.line,
        column: from.column,
      }),
    );

    // The component contains the markup, so its declaration starts before the
    // binding the edge records.
    expect(from.line).toBeLessThan(edge.line ?? 0);
  });

  it('survives graph construction with no dangling-edge finding', () => {
    const index = requireCorpusIndex();
    const graph = requireGraph(corpusGraph, 'corpus');
    const extracted = only(requireExtraction(corpus, 'corpus').edges, 'edge in the corpus');

    // The one finding that would hide a broken endpoint: construction drops the
    // edge and says so, and nothing downstream notices the missing path.
    const dropped = (index.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.code === 'dangling-edge',
    );

    expect(dropped).toEqual([]);

    // And the edge this extractor produced is the edge the graph holds, by id.
    expect(handlesEdgesOf(graph).map((edge) => edge.id)).toEqual([extracted.id]);
    expect(graph.outgoing(extracted.from, 'handles').map((edge) => edge.id)).toEqual([
      extracted.id,
    ]);
  });

  it('originates every handles edge at a component node, in both projects', () => {
    for (const [what, handle] of [
      ['corpus', corpusGraph],
      ['scratch project', scratchGraph],
    ] as const) {
      const graph = requireGraph(handle, what);
      const edges = handlesEdgesOf(graph);

      // Vacuous coverage is the risk here, so the scratch project's edges are
      // counted: both projects do bind handlers inside components.
      expect(edges.length).toBeGreaterThan(0);

      const wrongEnd = edges.filter((edge) => graph.nodeById(edge.from)?.kind !== 'component');

      expect(wrongEnd.map((edge) => edge.id)).toEqual([]);
    }
  });

  it('records no handler in the corpus server component, route modules or service layer', () => {
    const extraction = requireExtraction(corpus, 'corpus');

    for (const file of CORPUS_HANDLERLESS_MODULES) {
      const result = resultFor(extraction, file);

      expect({ file, nodes: result.nodes.length, edges: result.edges.length }).toEqual({
        file,
        nodes: 0,
        edges: 0,
      });
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. The binding shapes the corpus lacks
 * ---------------------------------------------------------------------------------------------- */

describe('inline bindings', () => {
  it('records an arrow function as an inline handler positioned at the arrow', () => {
    const file = 'src/InlinePanel.tsx';
    const text = scratchText(file);
    const node = handlerNamed(
      handlersIn(requireExtraction(scratch, 'scratch project'), file),
      'onClick',
    );

    // An inline handler has no declaration of its own, so the node is the
    // expression and the name is the property as written — the derived label
    // `CodeNodeBase.name` allows for exactly this case.
    expect(node.data).toEqual({ event: 'click', boundTo: 'button', inline: true });
    expect(positionOfNode(node)).toEqual(positionOf(text, '() => label.trim()'));

    // No function to look for, and nothing an inline arrow can export: both
    // fields are *absent* rather than present and undefined, which is what
    // keeps a serialised node from claiming an instrumentable symbol.
    expect(Object.hasOwn(node, 'symbol')).toBe(false);
    expect(Object.hasOwn(node, 'exported')).toBe(false);
  });

  it('records a function expression the same way, at its own position', () => {
    const file = 'src/InlinePanel.tsx';
    const text = scratchText(file);
    const extraction = requireExtraction(scratch, 'scratch project');
    const node = handlerNamed(handlersIn(extraction, file), 'onMouseEnter');

    expect(node.data).toEqual({ event: 'mouseEnter', boundTo: 'button', inline: true });
    expect(positionOfNode(node)).toEqual(positionOf(text, 'function () {}'));

    // Two inline handlers in one component are two nodes — each is its own
    // expression — and each binding site carries its own edge.
    const result = resultFor(extraction, file);

    expect(result.nodes).toHaveLength(2);
    expect(new Set(result.edges.map((edge) => edge.to)).size).toBe(2);
    expect(result.edges).toHaveLength(2);
  });
});

describe('references through a receiver', () => {
  it('names the property and falls back to the binding site for an opaque receiver', () => {
    const file = 'src/ReferencePanels.tsx';
    const text = scratchText(file);
    const node = handlerNamed(
      handlersIn(requireExtraction(scratch, 'scratch project'), file),
      'onSelect',
    );

    // `props.onSelect` — the binding exists and the property names it, but what
    // the receiver holds is a value question, so the node stays at the markup
    // and records the name to look for without claiming an export status.
    expect(node.data).toEqual({ event: 'click', boundTo: 'button', inline: false });
    expect(node.symbol).toBe('onSelect');
    expect(Object.hasOwn(node, 'exported')).toBe(false);
    expect(positionOfNode(node)).toEqual(positionOf(text, 'onClick={props.onSelect}'));
  });

  it('reports an unlocated declaration at the lowest severity, naming no source text', () => {
    const file = 'src/ReferencePanels.tsx';
    const text = scratchText(file);
    const diagnostic = only(
      resultFor(requireExtraction(scratch, 'scratch project'), file).diagnostics ?? [],
      `diagnostic for ${file}`,
    );
    const attribute = positionOf(text, 'onClick={props.onSelect}');

    // The node is usable and merely positioned at the binding site, so this is
    // information rather than a warning — `info` is the first, lowest member of
    // the severity vocabulary.
    expect(diagnostic.severity).toBe('info');
    expect(INDEX_DIAGNOSTIC_SEVERITIES[0]).toBe('info');
    expect(isIndexDiagnosticCode(diagnostic.code)).toBe(true);
    expect(diagnostic.code).toBe('extractor-failed');
    expect(diagnostic.extractorId).toBe(eventHandlersExtractor.id);
    expect(diagnostic.file).toBe(file);

    // It names the handler and the position and quotes nothing: a symbol name
    // is material a diagnostic is built from, a slice of the developer's source
    // is not.
    expect(diagnostic.message).toContain('onSelect');
    expect(diagnostic.message).toContain(`line ${String(attribute.line)}`);
    expect(diagnostic.message).toContain(`column ${String(attribute.column)}`);
    expect(diagnostic.message).not.toContain('<button');
    expect(diagnostic.message).not.toContain('props.onSelect');
  });

  it('resolves a this-member to the class member that declares it', () => {
    const file = 'src/ReferencePanels.tsx';
    const text = scratchText(file);
    const node = handlerNamed(
      handlersIn(requireExtraction(scratch, 'scratch project'), file),
      'onPress',
    );

    // A class's members are syntax, so `this.onPress` resolves: the node sits on
    // the member, names it as a symbol, and needs no diagnostic.
    expect(node.data.inline).toBe(false);
    expect(node.symbol).toBe('onPress');
    expect(node.exported).toBe(false);
    expect(positionOfNode(node)).toEqual(positionOf(text, 'onPress = () => {}'));
  });
});

describe('the event vocabulary', () => {
  it('derives every event from the property shape rather than from a list of names', () => {
    const file = 'src/VocabularyPanel.tsx';
    const nodes = handlersIn(requireExtraction(scratch, 'scratch project'), file);

    // One named handler per property, because one handler bound to several
    // properties is one node carrying the first binding's event (see the
    // de-duplication case below). The last row is the point of the rule: a
    // property no browser defines is recognised by its shape alone.
    expect(
      nodes
        .map((node) => ({ name: node.name, event: node.data.event, boundTo: node.data.boundTo }))
        .sort((left, right) => (left.name < right.name ? -1 : 1)),
    ).toEqual([
      { name: 'handleCapturePhase', event: 'click', boundTo: 'button' },
      { name: 'handleChange', event: 'change', boundTo: 'input' },
      { name: 'handleKeyDown', event: 'keyDown', boundTo: 'input' },
      { name: 'handleMouseEnter', event: 'mouseEnter', boundTo: 'span' },
      { name: 'handleProjectProp', event: 'viewportSettled', boundTo: 'ReadingChart' },
      { name: 'handleSubmit', event: 'submit', boundTo: 'form' },
    ]);
  });

  it('normalises the capture phase away instead of recording it', () => {
    const file = 'src/VocabularyPanel.tsx';
    const node = handlerNamed(
      handlersIn(requireExtraction(scratch, 'scratch project'), file),
      'handleCapturePhase',
    );

    // `onClickCapture` reports the same event as `onClick` — the graph's
    // vocabulary is the runtime's — and `HandlerNodeData` declares no field for
    // the phase, so the payload is exactly its three documented keys.
    expect(node.data.event).toBe('click');
    expect(Object.keys(node.data).sort()).toEqual(['boundTo', 'event', 'inline']);
  });

  it('treats a property that merely starts with the same letters as no handler', () => {
    const file = 'src/NonEventPanel.tsx';
    const result = resultFor(requireExtraction(scratch, 'scratch project'), file);

    // `online`, `onward`, `once`, a lower-cased `onclick` and the bare prefix
    // `on`: the uppercase letter is the whole distinction, and none of these is
    // an error either.
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toBeUndefined();
  });
});

describe('one named handler bound several times', () => {
  it('yields one node carrying the first binding and one edge per binding site', () => {
    const file = 'src/SharedHandlerPanel.tsx';
    const text = scratchText(file);
    const extraction = requireExtraction(scratch, 'scratch project');
    const node = only(handlersIn(extraction, file), `handler node in ${file}`);
    const result = resultFor(extraction, file);

    // The de-duplication this module chose of the two the graph permits: the
    // declaration is one function at one position, so it is one node, and the
    // first binding in source order is the event it records.
    expect(node.name).toBe('handleApply');
    expect(node.data.event).toBe('click');
    expect(positionOfNode(node)).toEqual(positionOf(text, 'handleApply() {}'));

    // Three bindings, three edges, each at its own site and all pointing at the
    // one node.
    expect(result.edges).toHaveLength(3);
    expect(new Set(result.edges.map((edge) => edge.to))).toEqual(new Set([node.id]));
    expect(result.edges.map((edge) => ({ line: edge.line, column: edge.column }))).toEqual([
      positionOf(text, 'onClick={handleApply}', 1),
      positionOf(text, 'onClick={handleApply}', 2),
      positionOf(text, 'onChange={handleApply}'),
    ]);
  });

  it('keeps every id unique and stable across two extractions', () => {
    const file = 'src/SharedHandlerPanel.tsx';
    const extraction = requireExtraction(scratch, 'scratch project');
    const again = visitProject(extraction.loaded);
    const first = resultFor(extraction, file);
    const second = resultFor(again, file);

    const edgeIds = first.edges.map((edge) => edge.id);

    expect(new Set(edgeIds).size).toBe(edgeIds.length);
    expect(second.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
    expect(second.edges.map((edge) => edge.id)).toEqual(edgeIds);
  });
});

describe('references syntax cannot follow', () => {
  it('keeps the handler, positions it at the binding site and says so once', () => {
    const file = 'src/RemotePanel.tsx';
    const text = scratchText(file);
    const extraction = requireExtraction(scratch, 'scratch project');
    const node = only(handlersIn(extraction, file), `handler node in ${file}`);
    const result = resultFor(extraction, file);

    // The module it comes from is not installed and never will be. A handler the
    // graph does not hold is a hole in every path through it, so the node exists
    // — named, flagged as a reference, positioned where the binding is written.
    expect(node.name).toBe('handleRemote');
    expect(node.data.inline).toBe(false);
    expect(node.symbol).toBe('handleRemote');
    expect(Object.hasOwn(node, 'exported')).toBe(false);
    expect(positionOfNode(node)).toEqual(positionOf(text, 'onClick={handleRemote}'));

    // One finding, at the lowest severity, and the edge is unaffected: the
    // binding is inside a component either way.
    const diagnostic = only(result.diagnostics ?? [], `diagnostic for ${file}`);

    expect(diagnostic.severity).toBe('info');
    expect(diagnostic.message).toContain('handleRemote');
    expect(result.edges).toHaveLength(1);
  });

  it('positions an imported handler in the module that declares it', () => {
    const markup = 'src/ImportingPanel.tsx';
    const declaring = 'src/shared-handlers.ts';
    const extraction = requireExtraction(scratch, 'scratch project');
    const node = only(handlersIn(extraction, markup), `handler node in ${markup}`);
    const edge = only(resultFor(extraction, markup).edges, `edge in ${markup}`);

    // A node's `file` is not always the file under extraction: an editor opening
    // this handler should land in the module that declares it, while the edge
    // stays where the relationship is written.
    expect(node.file).toBe(declaring);
    expect(positionOfNode(node)).toEqual(positionOf(scratchText(declaring), 'handleImported'));
    expect(node.symbol).toBe('handleImported');
    expect(node.exported).toBe(true);
    expect(node.id).toBe(
      makeNodeId({
        kind: 'handler',
        file: declaring,
        name: node.name,
        line: node.line,
        column: node.column,
      }),
    );
    expect(edge.file).toBe(markup);

    // The declaring module binds nothing itself, so it contributes no node of
    // its own — the relation is recorded once, from the markup.
    expect(resultFor(extraction, declaring).nodes).toEqual([]);
  });
});

describe('markup outside every component', () => {
  it('records the handler and no edge rather than inventing a component', () => {
    const file = 'src/helper-markup.tsx';
    const text = scratchText(file);
    const extraction = requireExtraction(scratch, 'scratch project');
    const node = only(handlersIn(extraction, file), `handler node in ${file}`);
    const result = resultFor(extraction, file);

    // There is no component node to point at, and an edge naming one nobody
    // declares would be dropped as `dangling-edge`. No diagnostic either: this
    // is a shape, not a failure.
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toBeUndefined();

    // Resolution reached a parameter, which is a binding site and not a
    // declaration: the function arrives from the caller, so the node points at
    // the parameter and claims no symbol to wrap.
    expect(node.name).toBe('onPick');
    expect(node.data).toEqual({ event: 'click', boundTo: 'button', inline: false });
    expect(positionOfNode(node)).toEqual(positionOf(text, 'onPick: () => void'));
    expect(Object.hasOwn(node, 'symbol')).toBe(false);
    expect(node.exported).toBe(false);
  });
});

describe('bindings that name nothing a developer could search for', () => {
  it('yields no node for a conditional, a subscript, undefined, a shorthand or a string', () => {
    const file = 'src/OpaquePanel.tsx';
    const text = scratchText(file);
    const extraction = requireExtraction(scratch, 'scratch project');
    const result = resultFor(extraction, file);

    // Six bindings, one node: a node naming one of two candidates, or named
    // after a subscript, would be a guess. The one that survives is
    // `handleApply.bind(null)`, because the language says the result of `bind`
    // is that function — so the node describes the method rather than the
    // standard-library builtin.
    const node = only(result.nodes.filter(isHandlerNode), `handler node in ${file}`);

    expect(node.name).toBe('handleApply');
    expect(positionOfNode(node)).toEqual(positionOf(text, 'handleApply() {}'));
    expect(result.edges.map((edge) => ({ line: edge.line, column: edge.column }))).toEqual([
      positionOf(text, 'onClick={handleApply.bind(null)}'),
    ]);
    expect(result.diagnostics).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4. Robustness, purity and determinism
 * ---------------------------------------------------------------------------------------------- */

describe('determinism', () => {
  it('produces deeply equal, identically ordered output on two consecutive runs', () => {
    for (const [what, handle] of [
      ['corpus', corpus],
      ['scratch project', scratch],
    ] as const) {
      const first = requireExtraction(handle, what);
      const second = visitProject(first.loaded);

      expect(second.nodes).toEqual(first.nodes);
      expect(second.edges).toEqual(first.edges);
      expect(second.diagnostics).toEqual(first.diagnostics);

      // Serialised as well as deeply equal: an index is cached and compared as
      // JSON, so property order has to match too, not only content.
      expect(JSON.stringify(second.nodes)).toBe(JSON.stringify(first.nodes));
      expect(JSON.stringify(second.edges)).toBe(JSON.stringify(first.edges));
      expect(JSON.stringify(second.diagnostics)).toBe(JSON.stringify(first.diagnostics));
    }
  });
});

describe('failure tolerance', () => {
  it('survives a module the parser could not finish, without inventing a node', () => {
    const broken = 'src/broken-module.tsx';
    const extraction = requireExtraction(scratch, 'scratch project');
    const result = resultFor(extraction, broken);

    // `extract` never throws — `visitProject` in `beforeAll` would have failed
    // the whole suite otherwise — and a region the parser skipped is invisible
    // to this walk, so nothing is guessed from it. The file-level finding is
    // reported once, by the component extractor, rather than repeated by each
    // extractor that read the same unparsed file.
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(extraction.diagnostics.filter((entry) => entry.file === broken)).toEqual([]);

    // The index is still honest about the file: at least one diagnostic names
    // it, which is what keeps a partial index from looking complete.
    const reported = (requireScratchIndex().diagnostics ?? []).filter(
      (diagnostic) => diagnostic.file === broken,
    );

    expect(reported.length).toBeGreaterThan(0);

    // And the rest of the run is unaffected: every other module still yielded
    // its handlers.
    expect(extraction.nodes.length).toBeGreaterThan(0);
    expect(handlersIn(extraction, 'src/InlinePanel.tsx')).toHaveLength(2);
  });

  it('quotes no source text in any diagnostic, at either level', () => {
    const diagnostics: readonly IndexDiagnostic[] = [
      ...requireExtraction(scratch, 'scratch project').diagnostics,
      ...(requireScratchIndex().diagnostics ?? []),
      ...requireExtraction(corpus, 'corpus').diagnostics,
      ...(requireCorpusIndex().diagnostics ?? []),
    ];

    // Diagnostics are logged, persisted with a session and can reach model
    // prompt context (AAP 0.5.2), so the marker planted in the broken module —
    // and the markup around it — must not travel in one.
    expect(diagnostics.length).toBeGreaterThan(0);

    for (const diagnostic of diagnostics) {
      const text = `${diagnostic.message} ${diagnostic.detail ?? ''}`;

      expect(text).not.toContain(SOURCE_MARKER);
      expect(text).not.toContain('<button');
      expect(isIndexDiagnosticCode(diagnostic.code)).toBe(true);
      expect(INDEX_DIAGNOSTIC_SEVERITIES).toContain(diagnostic.severity);
    }

    // This extractor's own findings are held to the tighter form its header
    // states — a name, a file, a position and no syntax at all — which the two
    // fragments below are the recognisable shape of.
    const mine = diagnostics.filter(
      (diagnostic) => diagnostic.extractorId === eventHandlersExtractor.id,
    );

    expect(mine.length).toBeGreaterThan(0);

    for (const diagnostic of mine) {
      const text = `${diagnostic.message} ${diagnostic.detail ?? ''}`;

      expect(text).not.toContain('=>');
      expect(text).not.toContain('onClick={');
    }
  });

  it('skips a file whose path is not project-relative, and emits nothing for it', () => {
    const extraction = requireExtraction(scratch, 'scratch project');
    const [sourceFile] = extraction.loaded.sourceFiles();

    if (sourceFile === undefined) {
      return expect.unreachable('the scratch project must hold at least one source file');
    }

    // Every node's `file` has to satisfy the same refinement a `SourceLocation`
    // applies, so a context built by hand with an absolute path yields the empty
    // result rather than nodes nothing can open.
    const result = eventHandlersExtractor.extract(
      contextFor(extraction.loaded, sourceFile, sourceFile.getFilePath()),
    );

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toBeUndefined();
  });
});

describe('purity and vocabulary', () => {
  it('writes nothing: neither project changes when the extractor runs over it', () => {
    const corpusBefore = treeSnapshot(CORPUS_ROOT);
    const scratchBefore = treeSnapshot(requireScratchRoot());

    visitProject(requireExtraction(corpus, 'corpus').loaded);
    visitProject(requireExtraction(scratch, 'scratch project').loaded);

    // The committed corpus is shared with several suites and must leave
    // `git status` unchanged; the scratch project is the control that proves the
    // comparison would notice a write at all.
    expect(treeSnapshot(CORPUS_ROOT)).toEqual(corpusBefore);
    expect(treeSnapshot(requireScratchRoot())).toEqual(scratchBefore);
  });

  it('emits only the two kinds it owns, and never a references edge', () => {
    const extractions = [
      requireExtraction(corpus, 'corpus'),
      requireExtraction(scratch, 'scratch project'),
    ];

    for (const extraction of extractions) {
      for (const result of extraction.byFile.values()) {
        for (const node of result.nodes) {
          expect(CODE_NODE_KINDS).toContain(node.kind);
          expect(node.kind).toBe('handler');
        }

        for (const edge of result.edges) {
          expect(CODE_EDGE_KINDS).toContain(edge.kind);
          expect(edge.kind).toBe('handles');
        }
      }

      // A reference set is deepened on demand by a `ReferenceResolver`, never at
      // indexing time, so this extractor emits no `references` edge — the kind
      // exists in the vocabulary, which is why the absence is asserted rather
      // than assumed.
      expect(extraction.edges.filter((edge) => edge.kind === 'references')).toEqual([]);
    }
  });

  it('identifies itself as the emitter of every diagnostic it reports', () => {
    const extraction = requireExtraction(scratch, 'scratch project');

    expect(eventHandlersExtractor.id).toBe('event-handlers');
    expect(extraction.diagnostics.length).toBeGreaterThan(0);
    expect(
      extraction.diagnostics.every(
        (diagnostic) => diagnostic.extractorId === eventHandlersExtractor.id,
      ),
    ).toBe(true);
  });
});
