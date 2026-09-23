/**
 * Unit suite for `./api-calls.ts`, the extractor that turns every outbound HTTP
 * call site of one module into an `api-call` node plus the `calls` edge that
 * attributes it.
 *
 * ## Why this suite exists at all
 *
 * The extractor is the client-side half of the product's cross-tier story, and
 * two of its recorded decisions are load-bearing in a way no other extractor's
 * are — both because a *plausible* alternative would silently destroy evidence
 * the analysis downstream cannot rebuild:
 *
 * - **Two call sites that request the same URL are two nodes, always.** The
 *   duplicate-request investigation exists to tell one initiator from another
 *   (`ApiCallNodeData`'s own words), so an extractor that keyed its output by
 *   URL would answer "why did this run twice?" by having thrown the second
 *   occurrence away before the question was asked. De-duplication here is
 *   prevented by construction — the id carries the position — which is exactly
 *   the kind of guarantee that decays into a *convention* unless a test
 *   asserts it.
 * - **A computed target is declared dynamic and not recorded as a URL.** A
 *   template literal with a substitution resolves at runtime and nowhere else.
 *   An extractor that recorded `` `/api/x/${id}` `` as the literal path
 *   `/api/x/` would join it to a route with full confidence and be wrong, and
 *   `../route-map.ts` has no way to notice.
 *
 * The indexing corpus at `../../test/fixtures/sample-next-app` is built to pin
 * both at once, and its API-call count is deliberately fixed at **three**: one
 * literal path written at *two* separate sites, plus one dynamic template. That
 * is the minimum that distinguishes a correct extractor from one that either
 * merges evidence or resolves an interpolated URL it cannot know — and, because
 * the count is fixed, it also makes *over*-detection visible, which is the
 * failure mode the deliberately generic client-wrapper rule risks.
 *
 * ## The invariants pinned here, in order
 *
 * 1. **The corpus inventory** — exactly three `api-call` nodes, all `fetch`
 *    sites; the shared literal path recorded twice as two distinct nodes with
 *    distinct positions; the template site flagged dynamic with its raw
 *    expression and no URL; literals recorded verbatim (no normalisation, no
 *    query stripping); every recorded method a member of `HTTP_METHOD_NAMES`;
 *    1-based positions at the *callee*; and no node from any other module of
 *    the corpus.
 * 2. **The owner cascade** — both handler-resident sites attributed to the
 *    *same* `handler` node (cascade step 1, reached through the `useCallback`
 *    the declaration is wrapped in), the helper module's site attributed to the
 *    `server-function` node of its enclosing exported function (step 3), one
 *    `calls` edge per node, and **no `dangling-edge` diagnostic** from graph
 *    assembly — the assertion that proves each spelled owner id names a node
 *    some other extractor really emitted.
 * 3. **Shapes the corpus does not hold** — explicit, computed and
 *    outside-the-vocabulary `fetch` methods; the global receivers; paired and
 *    unpaired `XMLHttpRequest`; the client-wrapper rule and, just as
 *    importantly, its negative cases (`registry.get(3)`,
 *    `lookup.delete(key)`); concatenated, variable and substitution-free
 *    targets; the 200-character cap on recorded source text; and the owner
 *    cascade's fallbacks to the `symbol` and `file` nodes.
 * 4. **Robustness, purity and determinism** — two runs are deeply equal and
 *    identically ordered; a module the parser could not read in full yields an
 *    `IndexDiagnostic` rather than a throw, quotes no source, and costs no
 *    other module its call sites; `extract` writes nothing; only `calls` edges
 *    are emitted; every recorded `file` is a project-relative POSIX path; and
 *    no absolute path reaches an id or a payload field.
 *
 * ## How the cases are driven
 *
 * The corpus is opened **once**, through the real `../project.ts`, exactly as a
 * consumer opens a developer's project — the fixture ships its own
 * `tsconfig.json` for that reason. The unit is then invoked **directly**, with
 * a per-file `ExtractorContext` assembled field-for-field as `../indexer.ts`
 * assembles it, so a case failing here is about this extractor and not about
 * the pipeline around it. The full index is built once as well, because two of
 * the invariants above are only observable after assembly: whether an owner id
 * resolves to a real node, and whether any edge was dropped as dangling.
 *
 * The corpus is **read-only** and must stay byte-identical: `git status
 * --porcelain packages/code-analysis` is expected to be empty after this suite
 * runs. Every shape the corpus does not hold is therefore exercised in an
 * `os.mkdtemp` scratch project with its own minimal `tsconfig.json` and no
 * installed packages, removed in `afterAll`. Those projects' `fetch` calls are
 * only ever *parsed*: nothing in this file opens a socket, and the extractor
 * itself performs no I/O at all.
 *
 * Expectations are **derived from the committed source** rather than written
 * out: positions come from locating each call's text in the file and converting
 * the offset, the method expectation comes from reading whether the call states
 * a literal `method` at all, and the owner names come from the JSX binding and
 * the `export` keyword the fixture actually carries. A hardcoded line number
 * would turn an unrelated edit to a fixture comment into a failure of this
 * suite, and a hardcoded method would stop testing the rule.
 *
 * Fixture paths and fixture identifiers are named here on purpose — a test file
 * is exempt from `scripts/check-no-hardcoding.mjs`, and a suite over a corpus
 * has to be able to say which corpus. No path, route or identifier of
 * `apps/demo-app` appears anywhere below.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SourceFile } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isOk, isSafeRelativePath, joinPosix, noopLogger, toPosix } from '@debuggen/shared';

import { CodeGraph } from '../graph/graph.js';
import { HTTP_METHOD_NAMES } from '../graph/types.js';
import type {
  CodeEdge,
  CodeIndex,
  CodeNode,
  CodeNodeOf,
  ExtractorContext,
  ExtractorResult,
} from '../graph/types.js';
import { buildIndex } from '../indexer.js';
import { openProject } from '../project.js';
import type { LoadedProject } from '../project.js';
import { API_CALLS_EXTRACTOR_ID, apiCallsExtractor } from './api-calls.js';

/* -------------------------------------------------------------------------------------------------
 * Contracts restated, so a change to one has to fail here
 * ---------------------------------------------------------------------------------------------- */

/**
 * The method a `fetch` call records when its source states none
 * (`DEFAULT_FETCH_METHOD` in the unit under test).
 *
 * Restated rather than imported, because the constant is internal and the
 * behaviour is a *contract* this suite is the asserting party for: the value is
 * a documented property of the platform API, so recording it is a statement
 * about what the call does, and changing it would change what every
 * method-less call site claims.
 */
const DEFAULT_FETCH_METHOD = 'GET';

/**
 * The hard cap on any raw source text a node carries, in characters
 * (`MAX_SOURCE_TEXT_LENGTH` in the unit under test, and the cap
 * `ApiCallNodeData.urlExpression` fixes at 200).
 *
 * Restated for the same reason, and with a sharper edge: the cap is a privacy
 * and cost bound (AAP 0.5.2), so a case at the cap must be truncated and the
 * number must not drift silently.
 */
const MAX_RECORDED_TEXT_LENGTH = 200;

/** The one diagnostic code this extractor emits, at the one severity it uses. */
const EXTRACTOR_DIAGNOSTIC_CODE = 'extractor-failed';

/* -------------------------------------------------------------------------------------------------
 * The corpus: paths and the inventory it is fixed at
 * ---------------------------------------------------------------------------------------------- */

/** The indexing corpus, resolved from this module rather than from a working directory. */
const FIXTURE_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/** The corpus' shared library module: one `fetch` inside one exported async function. */
const HELPER_MODULE = 'src/lib/http.ts';

/** The corpus' client component module: two `fetch` calls inside one memoised click handler. */
const WIDGET_MODULE = 'src/widgets/GaugeReadout.tsx';

/** The two modules of the corpus that write a request, in the order the index holds them. */
const CALLING_MODULES: readonly string[] = [HELPER_MODULE, WIDGET_MODULE];

/**
 * Every other module of the corpus, each of which must yield **no** `api-call`
 * node.
 *
 * Named one by one rather than derived, because that is what makes the negative
 * coverage legible: the two request-handling App Router modules and the legacy
 * Pages Router one, the two rendered pages and the layout, the service module
 * and the datastore handle module, the two driver stubs, the widget barrel, the
 * sibling widget and the framework configuration. Several of them call
 * verb-named methods on ordinary objects (`params.get('basinId')`), which is
 * precisely the client-wrapper rule's false-positive risk.
 */
const NON_CALLING_MODULES: readonly string[] = [
  'app/(observatory)/api/basins/[...segments]/route.ts',
  'app/(observatory)/basins/[id]/page.tsx',
  'app/api/gauges/[id]/route.ts',
  'app/api/gauges/route.ts',
  'app/layout.tsx',
  'app/page.tsx',
  'next.config.mjs',
  'pages/api/gauge-log.ts',
  'src/lib/datastore.ts',
  'src/lib/station-service.ts',
  'src/lib/stubs/pg.ts',
  'src/lib/stubs/prisma-client.ts',
  'src/widgets/BasinSummary.tsx',
  'src/widgets/index.ts',
];

/**
 * The exact source text of each of the corpus' three call sites, in index
 * order.
 *
 * The text is the *key* every expectation below is derived from — its offset in
 * the file gives the position, its first argument gives the target, and its
 * argument list gives the method — so the table states source and nothing else.
 * Each entry must occur exactly once in its module, which is asserted rather
 * than assumed.
 */
const CALL_TEXTS: readonly { readonly module: string; readonly callText: string }[] = [
  { module: HELPER_MODULE, callText: "fetch('/api/gauges', init)" },
  { module: WIDGET_MODULE, callText: "fetch('/api/gauges')" },
  { module: WIDGET_MODULE, callText: 'fetch(`/api/gauges/${gaugeId}`)' },
];

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

/**
 * An opened project, what this extractor said about each of its files, and the
 * assembled index and graph.
 *
 * The index and the graph are part of the fixture rather than of one case,
 * because two of this module's invariants are only observable after assembly:
 * whether a spelled owner id resolves to a node another extractor really
 * emitted, and whether any edge was dropped as dangling.
 */
interface ExtractedProject {
  /** The project root as opened, absolute. */
  readonly root: string;

  /** The handle `../project.ts` returned. */
  readonly loaded: LoadedProject;

  /** Each file's result from a direct invocation, keyed by project-relative POSIX path. */
  readonly results: ReadonlyMap<string, ExtractorResult>;

  /** The whole index, canonically ordered, with dangling edges removed and reported. */
  readonly index: CodeIndex;

  /** The graph over that index, used to resolve every `calls` edge's origin. */
  readonly graph: CodeGraph;
}

/**
 * Every `mkdtemp` directory this suite created, removed in `afterAll`.
 *
 * Collected in one list so the teardown is total: a case that fails part-way
 * through still leaves nothing behind, and nothing outside the process' own
 * temporary directory is ever a member.
 */
const scratchRoots: string[] = [];

/** The corpus fixture, built once in `beforeAll`. */
let corpus: ExtractedProject | undefined;

/** The scratch project holding the call shapes the corpus does not contain. */
let shapes: ExtractedProject | undefined;

/** The scratch project holding one unreadable module beside one intact module. */
let torn: ExtractedProject | undefined;

/**
 * The {@link ExtractorContext} for one file of an opened project, assembled
 * field-for-field as `../indexer.ts` assembles it.
 *
 * `noopLogger` rather than a recording stub: the two observations this
 * extractor logs (a call attributed to its file node, a method literal outside
 * the shared vocabulary) are deliberately *not* diagnostics, and both are
 * already observable from the node and the edge — the first by the absence of
 * `symbol` and a `file:` owner id, the second by the absence of `method`. There
 * is nothing a log assertion would add that is not asserted below directly.
 *
 * @param loaded The opened project.
 * @param sourceFile The file being visited.
 * @param file Its project-relative POSIX path.
 * @returns The context.
 */
function contextFor(loaded: LoadedProject, sourceFile: SourceFile, file: string): ExtractorContext {
  return { loaded, sourceFile, file, projectRoot: loaded.projectRoot, logger: noopLogger };
}

/**
 * Runs the extractor over every file of an opened project, in the order the
 * project holds them.
 *
 * @param loaded The opened project.
 * @returns Each file's result, keyed by project-relative POSIX path.
 */
function extractAll(loaded: LoadedProject): ReadonlyMap<string, ExtractorResult> {
  const results = new Map<string, ExtractorResult>();

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(sourceFile.getFilePath());

    if (file === undefined) {
      throw new Error(
        `a file of the opened project lies outside its root: ${sourceFile.getFilePath()}`,
      );
    }

    results.set(file, apiCallsExtractor.extract(contextFor(loaded, sourceFile, file)));
  }

  return results;
}

/**
 * Opens a project or fails the run with the reason.
 *
 * @param projectRoot The absolute root to open.
 * @returns The handle.
 */
function openOrThrow(projectRoot: string): LoadedProject {
  const opened = openProject({ projectRoot, logger: noopLogger });

  if (!isOk(opened)) {
    throw new Error(`the project at ${projectRoot} did not open: ${opened.error.message}`);
  }

  return opened.value;
}

/**
 * Opens a project, extracts every file directly, and assembles the index and
 * graph over it.
 *
 * @param root The absolute project root.
 * @returns The fixture.
 */
async function openAndExtract(root: string): Promise<ExtractedProject> {
  const loaded = openOrThrow(root);
  const results = extractAll(loaded);
  const built = await buildIndex(loaded, { logger: noopLogger });

  if (!isOk(built)) {
    throw new Error(`the index of ${root} did not build: ${built.error.message}`);
  }

  const index = built.value;

  return {
    root,
    loaded,
    results,
    index,
    graph: CodeGraph.fromIndex(index, { logger: noopLogger }),
  };
}

/**
 * The corpus fixture, or a readable failure when `beforeAll` did not run.
 *
 * @returns The fixture.
 */
function corpusFixture(): ExtractedProject {
  if (corpus === undefined) {
    throw new Error('the corpus fixture was not prepared');
  }

  return corpus;
}

/**
 * One of the two scratch projects, or a readable failure when it was not
 * prepared.
 *
 * @param project The project, possibly unset.
 * @param what Its name, for the failure message.
 * @returns The project.
 */
function scratchProject(project: ExtractedProject | undefined, what: string): ExtractedProject {
  if (project === undefined) {
    throw new Error(`the ${what} scratch project was not prepared`);
  }

  return project;
}

/**
 * The minimal configuration every scratch project ships.
 *
 * It exists because `openProject` resolves a project's `tsconfig.json` and
 * takes its `compilerOptions` — the same path the corpus exercises — and
 * because the extractor's parse-failure report reads the program's *syntactic*
 * diagnostics, which requires a program. Nothing is installed for these trees,
 * so `lib` is stated rather than resolved from a dependency, and no
 * `moduleResolution` decision below can reach the network.
 */
const SCRATCH_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      isolatedModules: true,
    },
    include: ['**/*.ts'],
  },
  undefined,
  2,
)}\n`;

/**
 * Creates a scratch project under the process' temporary directory, opens it
 * and extracts every file.
 *
 * @param prefix The `mkdtemp` prefix, so a leftover directory is attributable.
 * @param modules The project-relative path of each module and its source.
 * @returns The opened, extracted project.
 */
async function createScratchProject(
  prefix: string,
  modules: Readonly<Record<string, string>>,
): Promise<ExtractedProject> {
  const root = mkdtempSync(join(tmpdir(), prefix));

  scratchRoots.push(root);
  writeFileSync(join(root, 'tsconfig.json'), SCRATCH_TSCONFIG, 'utf8');

  for (const [relative, source] of Object.entries(modules)) {
    const absolute = join(root, relative);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source, 'utf8');
  }

  return openAndExtract(root);
}

/* -------------------------------------------------------------------------------------------------
 * Reading what the extractor said
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `api-call` nodes one file yielded, in emission order.
 *
 * `ExtractorResult.nodes` is typed as the whole `CodeNode` union, so the kind
 * is narrowed here once rather than at every assertion — and the narrowing is
 * itself a claim this extractor must satisfy, since it emits no other kind.
 *
 * @param project The extracted project.
 * @param file The project-relative POSIX path.
 * @returns That file's api-call nodes.
 */
function apiCallsOf(project: ExtractedProject, file: string): readonly CodeNodeOf<'api-call'>[] {
  const result = project.results.get(file);

  if (result === undefined) {
    throw new Error(`no extraction result was recorded for ${file}`);
  }

  return result.nodes.filter((node): node is CodeNodeOf<'api-call'> => node.kind === 'api-call');
}

/**
 * Every `api-call` node of a project, in file order and then emission order.
 *
 * @param project The extracted project.
 * @returns The nodes.
 */
function allApiCallsOf(project: ExtractedProject): readonly CodeNodeOf<'api-call'>[] {
  return [...project.results.keys()].flatMap((file) => apiCallsOf(project, file));
}

/**
 * The edges one file yielded, in emission order.
 *
 * @param project The extracted project.
 * @param file The project-relative POSIX path.
 * @returns That file's edges.
 */
function edgesOf(project: ExtractedProject, file: string): readonly CodeEdge[] {
  return project.results.get(file)?.edges ?? [];
}

/** Every edge of a project, in file order and then emission order. */
function allEdgesOf(project: ExtractedProject): readonly CodeEdge[] {
  return [...project.results.keys()].flatMap((file) => edgesOf(project, file));
}

/** Every diagnostic of a project, in file order. */
function allDiagnosticsOf(project: ExtractedProject): readonly string[] {
  return [...project.results.values()].flatMap((result) =>
    (result.diagnostics ?? []).map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
  );
}

/** A node in one short line, so a failed cardinality assertion names what was found. */
function describeNode(node: CodeNodeOf<'api-call'>): string {
  return `${node.name}@${node.file}:${String(node.line)}:${String(node.column)}`;
}

/**
 * The one node matching a predicate, or a failure naming every candidate.
 *
 * Every case that reaches for a single node goes through here, so a case that
 * accidentally matches two sites fails with both positions rather than
 * silently asserting about the first.
 *
 * @param nodes The candidates.
 * @param match The predicate.
 * @param what What was being looked for, for the failure message.
 * @returns The single match.
 */
function soleNode(
  nodes: readonly CodeNodeOf<'api-call'>[],
  match: (node: CodeNodeOf<'api-call'>) => boolean,
  what: string,
): CodeNodeOf<'api-call'> {
  const matched = nodes.filter(match);

  expect(matched.map(describeNode), `exactly one api-call node ${what}`).toHaveLength(1);

  const [first] = matched;

  if (first === undefined) {
    throw new Error(`no api-call node ${what}`);
  }

  return first;
}

/** The one node whose enclosing function the cascade named `symbol`. */
function nodeBySymbol(
  nodes: readonly CodeNodeOf<'api-call'>[],
  symbol: string,
): CodeNodeOf<'api-call'> {
  return soleNode(nodes, (node) => node.symbol === symbol, `inside ${symbol}`);
}

/** The one node whose recorded literal target is `url`. */
function nodeByUrl(nodes: readonly CodeNodeOf<'api-call'>[], url: string): CodeNodeOf<'api-call'> {
  return soleNode(nodes, (node) => node.data.url === url, `requesting ${url}`);
}

/**
 * The single `calls` edge pointing at a node, asserted to be single.
 *
 * @param edges The candidates.
 * @param nodeId The api-call node's id.
 * @returns The edge.
 */
function soleCallsEdgeTo(edges: readonly CodeEdge[], nodeId: string): CodeEdge {
  const matched = edges.filter((edge) => edge.kind === 'calls' && edge.to === nodeId);

  expect(
    matched.map((edge) => edge.from),
    `exactly one calls edge into ${nodeId}`,
  ).toHaveLength(1);

  const [first] = matched;

  if (first === undefined) {
    throw new Error(`no calls edge into ${nodeId}`);
  }

  return first;
}

/**
 * The node an edge starts at, resolved in the assembled graph.
 *
 * This is the assertion that a spelled owner id names a node another extractor
 * really emitted: the cascade reproduces three sibling naming rules, and a
 * reproduction that drifted would either resolve to nothing here or be dropped
 * as a dangling edge during assembly.
 *
 * @param graph The assembled graph.
 * @param edge The `calls` edge.
 * @returns The owning node.
 */
function ownerNodeOf(graph: CodeGraph, edge: CodeEdge): CodeNode {
  const owner = graph.nodeById(edge.from);

  if (owner === undefined) {
    throw new Error(`the graph holds no node for the calls edge origin ${edge.from}`);
  }

  return owner;
}

/* -------------------------------------------------------------------------------------------------
 * Expectations derived from the committed source
 * ---------------------------------------------------------------------------------------------- */

/** One corpus module's text, read from where the corpus lives. */
function corpusText(file: string): string {
  return readFileSync(joinPosix(toPosix(FIXTURE_ROOT), file), 'utf8');
}

/**
 * The offset of a substring that must occur exactly once.
 *
 * Exactly once is the point: an expectation derived from the *second*
 * occurrence of a call's text would be derived from the wrong site, and a
 * fixture edit that duplicated a line would make this suite quietly assert
 * about the wrong one.
 *
 * @param text The file's text.
 * @param needle The substring to locate.
 * @returns Its character offset.
 */
function soleOffsetOf(text: string, needle: string): number {
  const first = text.indexOf(needle);

  expect(first, `the corpus must contain ${needle}`).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(needle, first + 1), `${needle} must occur exactly once`).toBe(-1);

  return first;
}

/**
 * The 1-based line and column of a character offset.
 *
 * 1-based on both axes, which is the convention `CodeNodeBase.line` fixes for
 * the whole product — and the conversion is done here from the file's own text
 * so that no line number is written into this suite.
 *
 * @param text The file's text.
 * @param offset The character offset.
 * @returns The position.
 */
function positionAt(
  text: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  const before = text.slice(0, offset);

  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
}

/**
 * The text of a call's first argument, which is where every recognised shape
 * writes its target.
 *
 * Deliberately not a parser: it reads the one quoted or back-quoted argument
 * the three committed call texts begin with, and fails loudly on anything
 * else, so it cannot quietly mis-derive an expectation.
 *
 * @param callText The call's exact source text.
 * @returns The first argument's source text, quotes included.
 */
function firstArgumentOf(callText: string): string {
  const inner = callText.slice(callText.indexOf('(') + 1, callText.lastIndexOf(')'));
  const quote = inner.slice(0, 1);

  expect(["'", '"', '`'], `${callText} must open its target with a quote`).toContain(quote);

  const close = inner.indexOf(quote, 1);

  expect(close, `${callText} must close its target`).toBeGreaterThan(0);

  return inner.slice(0, close + 1);
}

/**
 * Whether a target argument is computed: a template literal carrying a
 * substitution.
 *
 * @param argument The first argument's source text.
 * @returns `true` when only the runtime knows the target.
 */
function isDynamicTarget(argument: string): boolean {
  return argument.startsWith('`') && argument.includes('${');
}

/**
 * The value a fully static target argument denotes.
 *
 * The corpus' literals carry no escape sequence, which is asserted rather than
 * assumed — with one present, stripping the quotes would no longer equal the
 * decoded value the extractor records.
 *
 * @param argument The first argument's source text.
 * @returns The path the request is made to.
 */
function decodedLiteral(argument: string): string {
  expect(argument, 'the derivation below assumes an escape-free literal').not.toContain('\\');

  return argument.slice(1, -1);
}

/**
 * The HTTP method a call's source states literally, or `undefined` when it
 * states none.
 *
 * Trimmed and upper-cased exactly as the extractor reads a literal, because
 * `{ method: ' post ' }` is a method the platform accepts — so this derivation
 * follows the documented rule rather than restating a result.
 *
 * @param callText The call's exact source text.
 * @returns The stated method, or `undefined`.
 */
function statedMethodOf(callText: string): string | undefined {
  const matched = /\bmethod\s*:\s*(['"`])(.*?)\1/.exec(callText);
  const stated = matched?.[2];

  return stated === undefined ? undefined : stated.trim().toUpperCase();
}

/** What one call site's node must record, derived entirely from the committed source. */
interface SiteExpectation {
  /** The module the site is written in. */
  readonly module: string;

  /** The site's exact source text. */
  readonly callText: string;

  /** The 1-based line of the callee. */
  readonly line: number;

  /** The 1-based column of the callee. */
  readonly column: number;

  /** Whether the target is computed. */
  readonly dynamic: boolean;

  /** The literal target, for a static site. */
  readonly url: string | undefined;

  /** The raw target expression, for a computed site. */
  readonly urlExpression: string | undefined;

  /** The method the node must carry: the stated one, or the platform default. */
  readonly method: string;
}

/**
 * Derives one site's expectation from the corpus.
 *
 * Every field comes from the source: the position from the call text's offset,
 * the target from its first argument, and the method from whether it states one
 * at all — a site that states none must record {@link DEFAULT_FETCH_METHOD},
 * which is what the platform API does and therefore a statement about the call
 * rather than a guess.
 *
 * @param module The module the site is written in.
 * @param callText The site's exact source text.
 * @returns The expectation.
 */
function expectationFor(module: string, callText: string): SiteExpectation {
  const text = corpusText(module);
  const { line, column } = positionAt(text, soleOffsetOf(text, callText));
  const argument = firstArgumentOf(callText);
  const dynamic = isDynamicTarget(argument);

  return {
    module,
    callText,
    line,
    column,
    dynamic,
    url: dynamic ? undefined : decodedLiteral(argument),
    urlExpression: dynamic ? argument : undefined,
    method: statedMethodOf(callText) ?? DEFAULT_FETCH_METHOD,
  };
}

/** The three expectations, derived once. */
function siteExpectations(): readonly SiteExpectation[] {
  return CALL_TEXTS.map((entry) => expectationFor(entry.module, entry.callText));
}

/**
 * The identifier a module's single markup event attribute binds.
 *
 * Read from the fixture's own JSX (`onClick={…}`) so the handler's name is
 * never written into this suite: the cascade's first step must attribute a call
 * to *that* declaration, whatever it is called.
 *
 * @param module The module to read.
 * @returns The bound identifier.
 */
function boundHandlerNameOf(module: string): string {
  const matched = /\son[A-Z]\w*=\{(\w+)\}/.exec(corpusText(module));
  const name = matched?.[1];

  if (name === undefined) {
    throw new Error(`${module} declares no markup event binding to read a handler name from`);
  }

  return name;
}

/**
 * The name of a module's single exported async function declaration.
 *
 * Read from the fixture for the same reason: the cascade's third step must
 * attribute a call to the exported function it sits inside, under that
 * function's own declared name.
 *
 * @param module The module to read.
 * @returns The declared name.
 */
function exportedFunctionNameOf(module: string): string {
  const matched = /export async function (\w+)\(/.exec(corpusText(module));
  const name = matched?.[1];

  if (name === undefined) {
    throw new Error(`${module} declares no exported async function`);
  }

  return name;
}

/* -------------------------------------------------------------------------------------------------
 * The scratch projects: shapes the corpus does not hold
 * ---------------------------------------------------------------------------------------------- */

/** How many segments the over-long dynamic target concatenates. */
const LONG_TARGET_SEGMENTS = 40;

/**
 * A target expression far longer than {@link MAX_RECORDED_TEXT_LENGTH}, so the
 * cap is exercised rather than approached.
 *
 * Generated rather than written out: forty hand-written concatenations would
 * obscure the one property under test, and the expected value is derived from
 * this same string, so the case cannot drift from its own input.
 */
const LONG_TARGET_EXPRESSION = [
  "'/scratch/'",
  ...Array.from({ length: LONG_TARGET_SEGMENTS }, () => 'segment'),
].join(' + ');

/**
 * The scratch modules, one per family of shapes.
 *
 * Written with neutral identifiers (`client`, `transport`, `registry`,
 * `segment`) and `/scratch/…` targets: the syntax is the subject, and a name
 * borrowed from an application under test would suggest otherwise. Every module
 * is parsed and nothing is executed, so the unresolved ambient declarations and
 * the deliberately ill-typed `fetch()` below cost nothing — the extractor
 * resolves no type and reads no second file.
 */
const SHAPE_MODULES: Readonly<Record<string, string>> = {
  'src/methods.ts': [
    'declare const computedVerb: string;',
    '',
    'export function explicitPost() {',
    "  return fetch('/scratch/explicit-post', { method: 'POST' });",
    '}',
    '',
    'export function computedMethod() {',
    "  return fetch('/scratch/computed-method', { method: computedVerb });",
    '}',
    '',
    'export function paddedLowerCaseVerb() {',
    "  return fetch('/scratch/padded-verb', { method: ' post ' });",
    '}',
    '',
    'export function verbOutsideVocabulary() {',
    "  return fetch('/scratch/unsupported-verb', { method: 'TRACE' });",
    '}',
    '',
    'export function initWithoutMethod() {',
    "  return fetch('/scratch/no-method', { cache: 'no-store' });",
    '}',
    '',
  ].join('\n'),

  'src/receivers.ts': [
    'declare const httpClient: { fetch(url: string): Promise<unknown> };',
    '',
    "export function onWindow() { return window.fetch('/scratch/window'); }",
    "export function onGlobalThis() { return globalThis.fetch('/scratch/global-this'); }",
    "export function onSelf() { return self.fetch('/scratch/self'); }",
    "export function onOtherReceiver() { return httpClient.fetch('/scratch/not-a-global'); }",
    '',
  ].join('\n'),

  'src/xhr.ts': [
    'export function pairedRequest(): void {',
    '  const request = new XMLHttpRequest();',
    "  request.open('PUT', '/scratch/xhr-put');",
    '  request.send();',
    '}',
    '',
    'export function unpairedConstruction(): XMLHttpRequest {',
    '  const created = new XMLHttpRequest();',
    '  return created;',
    '}',
    '',
  ].join('\n'),

  'src/wrappers.ts': [
    'declare const client: { get(url: string): unknown };',
    'declare const transport: { post(url: string, body?: unknown): unknown };',
    'declare const registry: { get(index: number): unknown };',
    'declare const lookup: { delete(key: string): unknown };',
    'declare const cacheKey: string;',
    '',
    "export function wrapperGet() { return client.get('/scratch/wrapper-get'); }",
    "export function wrapperPost() { return transport.post('/scratch/wrapper-post', { ok: true }); }",
    'export function collectionGet() { return registry.get(3); }',
    'export function registryDelete() { return lookup.delete(cacheKey); }',
    "export function relativeArgument() { return client.get('scratch/relative'); }",
    '',
  ].join('\n'),

  'src/dynamic.ts': [
    'declare const gaugeKey: string;',
    'declare const wholeTarget: string;',
    '',
    "export function concatenatedTarget() { return fetch('/scratch/' + gaugeKey); }",
    'export function variableTarget() { return fetch(wholeTarget); }',
    'export function templateWithoutSubstitution() { return fetch(`/scratch/static-template`); }',
    'export function noArgument() { return fetch(); }',
    '',
  ].join('\n'),

  'src/owners.ts': [
    'declare const rows: readonly number[];',
    '',
    "fetch('/scratch/top-level');",
    "rows.map(() => fetch('/scratch/anonymous-callback'));",
    "const moduleLevelBinding = fetch('/scratch/module-binding');",
    '',
    'export { moduleLevelBinding };',
    '',
  ].join('\n'),

  'src/cap.ts': [
    'declare const segment: string;',
    '',
    `export function overlongTarget() { return fetch(${LONG_TARGET_EXPRESSION}); }`,
    '',
  ].join('\n'),
};

/**
 * One module the parser cannot read in full, beside one it can.
 *
 * A broken module does not make ts-morph throw — it yields a partial tree — so
 * the pair is what proves both halves of the degradation rule at once: the
 * unreadable module is *reported*, and the intact module still yields its call
 * site.
 */
const TORN_MODULES: Readonly<Record<string, string>> = {
  'src/torn-module.ts': [
    'export function unreadableMember( {',
    "  return fetch('/scratch/never-parsed');",
    '',
  ].join('\n'),

  'src/intact-module.ts': [
    "export function intactMember() { return fetch('/scratch/still-indexed'); }",
    '',
  ].join('\n'),
};

/* -------------------------------------------------------------------------------------------------
 * Setup and teardown
 * ---------------------------------------------------------------------------------------------- */

beforeAll(async () => {
  corpus = await openAndExtract(FIXTURE_ROOT);
  shapes = await createScratchProject('debuggen-api-calls-shapes-', SHAPE_MODULES);
  torn = await createScratchProject('debuggen-api-calls-torn-', TORN_MODULES);
});

afterAll(() => {
  // Only `mkdtemp` directories this suite created are ever removed, and every
  // one of them sits under the process' own temporary directory. The corpus is
  // read-only and is never a member.
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  scratchRoots.length = 0;
});

/* -------------------------------------------------------------------------------------------------
 * 1. The corpus inventory, fixed at three
 * ---------------------------------------------------------------------------------------------- */

describe('apiCallsExtractor: the corpus inventory', () => {
  it('is written against the whole corpus, and names every module of it', () => {
    const { results } = corpusFixture();
    const expected = [...CALLING_MODULES, ...NON_CALLING_MODULES];

    // The guard that keeps the negative coverage below honest: a module added
    // to the corpus has to be classified here as calling or non-calling before
    // this suite will pass, so over-detection in a new file cannot hide.
    expect([...results.keys()].sort()).toStrictEqual([...expected].sort());
  });

  it('records exactly three api-call nodes, each one a fetch site', () => {
    const fixture = corpusFixture();
    const nodes = allApiCallsOf(fixture);

    expect(nodes.map(describeNode)).toHaveLength(CALL_TEXTS.length);
    expect(nodes.every((node) => node.kind === 'api-call')).toBe(true);
    expect(nodes.map((node) => node.name)).toStrictEqual(['fetch', 'fetch', 'fetch']);

    // One in the shared library helper, two inside the widget's click handler.
    expect(apiCallsOf(fixture, HELPER_MODULE)).toHaveLength(1);
    expect(apiCallsOf(fixture, WIDGET_MODULE)).toHaveLength(2);

    // The count the index carries must be the count the extractor emitted: a
    // node lost or duplicated during assembly is as damaging as one never
    // recorded.
    expect(fixture.index.nodes.filter((node) => node.kind === 'api-call')).toHaveLength(
      CALL_TEXTS.length,
    );
  });

  it('records the one literal path written at two sites as two distinct nodes', () => {
    const fixture = corpusFixture();
    const expectations = siteExpectations();

    // The shared path is derived, not named: it is whichever literal target the
    // corpus writes more than once.
    const literals = expectations
      .map((expectation) => expectation.url)
      .filter((url): url is string => url !== undefined);
    const shared = literals.filter((url, index) => literals.indexOf(url) !== index);

    expect(shared, 'the corpus must write exactly one literal path twice').toHaveLength(1);

    const [sharedUrl] = shared;

    if (sharedUrl === undefined) {
      throw new Error('the corpus writes no literal path twice');
    }

    const sharing = allApiCallsOf(fixture).filter((node) => node.data.url === sharedUrl);

    // Two nodes, not one: nothing in the extractor de-duplicates by URL, and
    // this is the invariant that makes duplicate-request evidence possible at
    // all (`ApiCallNodeData`'s never-merge rule).
    expect(sharing.map(describeNode)).toHaveLength(2);

    // Distinct identities...
    expect(new Set(sharing.map((node) => node.id)).size).toBe(2);

    // ...and distinct positions. An `api-call` node carries no `SourceLocation`
    // of its own — the node vocabulary has none, and `../graph/query.ts` is
    // where a node becomes a location — so the triple a location would be
    // minted from is what has to differ.
    const positions = sharing.map(
      (node) => `${node.file}:${String(node.line)}:${String(node.column)}`,
    );

    expect(new Set(positions).size).toBe(2);
    expect(new Set(sharing.map((node) => node.file)).size).toBe(2);

    // Both sites really are the two the corpus writes, in two different files.
    expect(sharing.map((node) => node.file).sort()).toStrictEqual(
      [HELPER_MODULE, WIDGET_MODULE].sort(),
    );
  });

  it('declares the template-literal site dynamic and claims no URL for it', () => {
    const fixture = corpusFixture();
    const dynamicExpectation = siteExpectations().find((expectation) => expectation.dynamic);

    if (dynamicExpectation === undefined) {
      throw new Error('the corpus writes no computed target');
    }

    const nodes = allApiCallsOf(fixture).filter((node) => node.data.dynamic);

    expect(nodes.map(describeNode)).toHaveLength(1);

    const [node] = nodes;

    if (node === undefined) {
      throw new Error('no dynamic api-call node was recorded');
    }

    expect(node.data.dynamic).toBe(true);
    expect(node.data.url).toBeUndefined();
    expect(node.data.urlExpression).toBe(dynamicExpectation.urlExpression);
    expect(node.data.urlExpression?.length ?? 0).toBeLessThanOrEqual(MAX_RECORDED_TEXT_LENGTH);

    // The substitution is recorded as source text and never resolved: a target
    // only the runtime knows must not be presented as a path.
    expect(node.data.urlExpression).toContain('${');
  });

  it('records every literal target verbatim, with no normalisation and no query stripping', () => {
    const fixture = corpusFixture();
    const nodes = allApiCallsOf(fixture).filter((node) => !node.data.dynamic);
    const expected = siteExpectations()
      .filter((expectation) => !expectation.dynamic)
      .map((expectation) => expectation.url);

    expect(nodes.map((node) => node.data.url)).toStrictEqual(expected);

    for (const node of nodes) {
      expect(node.data.dynamic).toBe(false);
      expect(node.data.urlExpression).toBeUndefined();
      // Verbatim means verbatim: the recorded value is the source's own text,
      // not a trimmed, lower-cased or query-stripped rewrite of it.
      expect(node.data.url).toBe(node.data.url?.trim());
    }
  });

  it('names each site for what it calls rather than for the URL it requests', () => {
    for (const node of allApiCallsOf(corpusFixture())) {
      expect(node.name).toBe('fetch');
      expect(node.name).not.toContain('/');
    }
  });

  for (const { module, callText } of CALL_TEXTS) {
    it(`records the method and position the source states for ${callText} in ${module}`, () => {
      const fixture = corpusFixture();
      const expectation = expectationFor(module, callText);
      const node = soleNode(
        apiCallsOf(fixture, module),
        (candidate) =>
          candidate.line === expectation.line && candidate.column === expectation.column,
        `at ${module}:${String(expectation.line)}:${String(expectation.column)}`,
      );

      // The position is the callee's own, 1-based on both axes, and it is
      // derived from the call text's offset in the file — never written here.
      expect(node.line).toBe(expectation.line);
      expect(node.column).toBe(expectation.column);
      expect(node.endLine ?? node.line).toBeGreaterThanOrEqual(node.line);
      expect(node.file).toBe(module);

      // The method the source implies: its literal `method` when it states
      // one, and the platform default otherwise. Both of the corpus' shapes —
      // no init object at all, and an init object that is not written inline —
      // state none, so both must record the default.
      expect(statedMethodOf(callText)).toBeUndefined();
      expect(node.data.method).toBe(expectation.method);

      // Whatever was recorded has to be comparable with a route's declared
      // methods, which means it has to be drawn from the shared vocabulary.
      expect(HTTP_METHOD_NAMES).toContain(node.data.method);
    });
  }

  it('records the enclosing function of each site as its symbol', () => {
    const fixture = corpusFixture();
    const helperFunction = exportedFunctionNameOf(HELPER_MODULE);
    const boundHandler = boundHandlerNameOf(WIDGET_MODULE);

    expect(apiCallsOf(fixture, HELPER_MODULE).map((node) => node.symbol)).toStrictEqual([
      helperFunction,
    ]);
    expect(apiCallsOf(fixture, WIDGET_MODULE).map((node) => node.symbol)).toStrictEqual([
      boundHandler,
      boundHandler,
    ]);
  });

  for (const module of NON_CALLING_MODULES) {
    it(`records no api-call node for ${module}`, () => {
      const fixture = corpusFixture();

      // Over-detection is what the fixed count of three exists to expose, and
      // the generic client-wrapper rule is where it would come from: several of
      // these modules call verb-named methods on ordinary objects, and none of
      // them writes a request.
      expect(apiCallsOf(fixture, module).map(describeNode)).toStrictEqual([]);
      expect(edgesOf(fixture, module)).toStrictEqual([]);
    });
  }

  it('reports no diagnostic for a corpus it can read in full', () => {
    expect(allDiagnosticsOf(corpusFixture())).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. The `calls` edge and the owner cascade
 * ---------------------------------------------------------------------------------------------- */

describe('apiCallsExtractor: the calls edge and the owner cascade', () => {
  it('attributes both handler-resident sites to the same handler node', () => {
    const fixture = corpusFixture();
    const nodes = apiCallsOf(fixture, WIDGET_MODULE);
    const edges = nodes.map((node) => soleCallsEdgeTo(edgesOf(fixture, WIDGET_MODULE), node.id));
    const origins = new Set(edges.map((edge) => edge.from));

    // One owner for both: the cascade has to be stable inside a single
    // function, and the two sites sit in one memoised handler body.
    expect([...origins]).toHaveLength(1);

    const [edge] = edges;

    if (edge === undefined) {
      throw new Error('the widget module yielded no calls edge');
    }

    const owner = ownerNodeOf(fixture.graph, edge);

    // Cascade step 1: the declaration is function-local — its initialiser is a
    // `useCallback` call — so it carries no `symbol` node, and it is
    // addressable only because the markup binds it. Attributing these requests
    // to the component instead is precisely the mistake the step exists to
    // prevent.
    expect(owner.kind).toBe('handler');
    expect(owner.name).toBe(boundHandlerNameOf(WIDGET_MODULE));
    expect(owner.file).toBe(WIDGET_MODULE);

    // Every site the handler owns names it as its `symbol`, which is what a
    // developer recognises in a query result.
    expect(nodes.map((node) => node.symbol)).toStrictEqual([owner.name, owner.name]);
  });

  it('attributes the helper module site to the server-function node of its exported function', () => {
    const fixture = corpusFixture();
    const node = soleNode(apiCallsOf(fixture, HELPER_MODULE), () => true, `in ${HELPER_MODULE}`);
    const edge = soleCallsEdgeTo(edgesOf(fixture, HELPER_MODULE), node.id);
    const owner = ownerNodeOf(fixture.graph, edge);

    // Cascade step 3, as `./api-calls.ts` documents it: in a module that is
    // neither a route/page module nor a component module, a module-level
    // function-valued declaration the module exports is a `server-function`
    // node — named under the declaration's own name, at its own position.
    // `ownerNodeOf` has already proved the node exists; this pins which kind
    // the cascade selected, because the id's first component is the only place
    // that decision is legible.
    expect(owner.kind).toBe('server-function');
    expect(owner.name).toBe(exportedFunctionNameOf(HELPER_MODULE));
    expect(owner.file).toBe(HELPER_MODULE);
    expect(node.symbol).toBe(owner.name);
  });

  it('emits exactly one calls edge per api-call node, with unique edge ids', () => {
    const fixture = corpusFixture();
    const nodes = allApiCallsOf(fixture);
    const edges = allEdgesOf(fixture);

    expect(edges).toHaveLength(nodes.length);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);

    for (const edge of edges) {
      // Direction is fixed by the edge table on `CODE_EDGE_KINDS`: caller ->
      // callee, which is the only reason `whoCalls` can search backwards.
      expect(edge.kind).toBe('calls');
      expect(nodes.map((node) => node.id)).toContain(edge.to);
    }

    // And every node is pointed at exactly once, so no site is unattributed.
    for (const node of nodes) {
      expect(edges.filter((edge) => edge.to === node.id)).toHaveLength(1);
    }
  });

  it('loses no calls edge to graph assembly and reports no dangling edge', () => {
    const fixture = corpusFixture();
    const assembledIds = new Set(fixture.index.edges.map((edge) => edge.id));

    // Assembly drops an edge whose endpoint no extractor emitted and reports
    // `dangling-edge`. This extractor spells three sibling extractors' node ids
    // by reproducing their naming rules, so this assertion is what proves each
    // reproduction still agrees with its original.
    expect(
      (fixture.index.diagnostics ?? [])
        .filter((diagnostic) => diagnostic.code === 'dangling-edge')
        .map((diagnostic) => diagnostic.message),
    ).toStrictEqual([]);

    for (const edge of allEdgesOf(fixture)) {
      expect(assembledIds.has(edge.id), `${edge.id} survived assembly`).toBe(true);
    }

    for (const node of allApiCallsOf(fixture)) {
      expect(fixture.graph.incoming(node.id, 'calls')).toHaveLength(1);
      expect(fixture.graph.outgoing(node.id, 'calls')).toStrictEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. Shapes the corpus does not hold
 * ---------------------------------------------------------------------------------------------- */

describe('apiCallsExtractor: fetch methods', () => {
  it('records a literal method from the init object', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/methods.ts');

    expect(nodeBySymbol(nodes, 'explicitPost').data.method).toBe('POST');
    // Upper-cased and trimmed, because `{ method: ' post ' }` is a method the
    // platform accepts and the vocabulary spells in upper case.
    expect(nodeBySymbol(nodes, 'paddedLowerCaseVerb').data.method).toBe('POST');
  });

  it('falls back to the platform default when no method is statically known', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/methods.ts');

    // A computed method and an init object that declares none are the same
    // reading — nothing statically known — and both record what `fetch` itself
    // does. `ApiCallNodeData` carries no "defaulted" marker, and deliberately
    // so: a defaulted `GET` and a written `GET` describe the same request.
    expect(nodeBySymbol(nodes, 'computedMethod').data.method).toBe(DEFAULT_FETCH_METHOD);
    expect(nodeBySymbol(nodes, 'initWithoutMethod').data.method).toBe(DEFAULT_FETCH_METHOD);
  });

  it('records no method for a literal verb outside the shared vocabulary', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/methods.ts');
    const node = nodeBySymbol(nodes, 'verbOutsideVocabulary');

    // The distinction the extractor exists to keep: the call performs neither
    // a method this vocabulary can name nor the platform default, so the field
    // is absent. Recording `GET` here would be a confident wrong answer.
    expect(node.data.method).toBeUndefined();
    expect('method' in node.data).toBe(false);

    // The site is still recorded — a request is written here.
    expect(node.data.url).toBe('/scratch/unsupported-verb');
  });

  it('draws every method it records from the shared vocabulary', () => {
    const methods = allApiCallsOf(scratchProject(shapes, 'shapes'))
      .map((node) => node.data.method)
      .filter((method): method is string => method !== undefined);

    expect(methods.length).toBeGreaterThan(0);

    for (const method of methods) {
      expect(HTTP_METHOD_NAMES).toContain(method);
    }
  });
});

describe('apiCallsExtractor: the receivers a fetch may be written on', () => {
  it('recognises fetch on window, globalThis and self, and names the callee as written', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/receivers.ts');

    expect(nodeBySymbol(nodes, 'onWindow').name).toBe('window.fetch');
    expect(nodeBySymbol(nodes, 'onGlobalThis').name).toBe('globalThis.fetch');
    expect(nodeBySymbol(nodes, 'onSelf').name).toBe('self.fetch');
    expect(nodes.map((node) => node.data.url)).toStrictEqual([
      '/scratch/window',
      '/scratch/global-this',
      '/scratch/self',
    ]);
  });

  it('does not recognise a fetch member on any other receiver', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/receivers.ts');

    // `client.fetch(…)` is a different function whose behaviour cannot be
    // known syntactically, and `fetch` is not an HTTP verb, so the wrapper rule
    // does not claim it either.
    expect(nodes).toHaveLength(3);
    expect(nodes.map((node) => node.symbol)).not.toContain('onOtherReceiver');
  });
});

describe('apiCallsExtractor: XMLHttpRequest', () => {
  it('pairs a construction with the open call on the same binding', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/xhr.ts');
    const node = nodeBySymbol(nodes, 'pairedRequest');

    // One node for the request, not one per call: the construction is where
    // the request originates, and `open(method, url)` is what says what it will
    // request.
    expect(node.name).toBe('XMLHttpRequest');
    expect(node.data.method).toBe('PUT');
    expect(node.data.url).toBe('/scratch/xhr-put');
    expect(node.data.dynamic).toBe(false);
  });

  it('records an unpaired construction with an unknown target rather than a guess', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/xhr.ts');
    const node = nodeBySymbol(nodes, 'unpairedConstruction');

    expect(nodes).toHaveLength(2);
    expect(node.data.dynamic).toBe(true);
    expect(node.data.url).toBeUndefined();
    expect(node.data.urlExpression).toBeUndefined();
    // No platform default exists for an `open()` that was never written, so no
    // method is recorded either.
    expect(node.data.method).toBeUndefined();
  });
});

describe('apiCallsExtractor: the client-wrapper rule', () => {
  it('recognises a verb-named method call whose first argument is path-like', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/wrappers.ts');
    const get = nodeBySymbol(nodes, 'wrapperGet');
    const post = nodeBySymbol(nodes, 'wrapperPost');

    // The verb is the method, so the node is named for the *receiver* — the
    // non-redundant remainder, recorded as written rather than resolved to a
    // client.
    expect(get.name).toBe('client');
    expect(get.data.method).toBe('GET');
    expect(get.data.url).toBe('/scratch/wrapper-get');

    expect(post.name).toBe('transport');
    expect(post.data.method).toBe('POST');
    expect(post.data.url).toBe('/scratch/wrapper-post');
  });

  it('does not recognise a verb-named call whose first argument is not path-like', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/wrappers.ts');

    // The main false-positive risk of a rule that names no library: a
    // collection lookup and a map deletion are written with exactly the same
    // shape. A relative argument is refused for the same reason — it is
    // indistinguishable from a key — and a false api-call node is worse than a
    // missed one, because the analysis would then hunt for a request that never
    // happens.
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.symbol)).toStrictEqual(['wrapperGet', 'wrapperPost']);

    for (const absent of ['collectionGet', 'registryDelete', 'relativeArgument']) {
      expect(nodes.map((node) => node.symbol)).not.toContain(absent);
    }
  });
});

describe('apiCallsExtractor: computed and static targets', () => {
  it('declares a concatenation and a bare variable dynamic, with their source text', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/dynamic.ts');
    const concatenated = nodeBySymbol(nodes, 'concatenatedTarget');
    const variable = nodeBySymbol(nodes, 'variableTarget');

    expect(concatenated.data.dynamic).toBe(true);
    expect(concatenated.data.url).toBeUndefined();
    expect(concatenated.data.urlExpression).toBe("'/scratch/' + gaugeKey");

    expect(variable.data.dynamic).toBe(true);
    expect(variable.data.url).toBeUndefined();
    expect(variable.data.urlExpression).toBe('wholeTarget');
  });

  it('treats a substitution-free template literal as the literal it is', () => {
    const nodes = apiCallsOf(scratchProject(shapes, 'shapes'), 'src/dynamic.ts');
    const node = nodeBySymbol(nodes, 'templateWithoutSubstitution');

    // Fully static: the decoded value is the path the request is made to, which
    // is what a route match needs, and the back-quotes are syntax.
    expect(node.data.dynamic).toBe(false);
    expect(node.data.url).toBe('/scratch/static-template');
    expect(node.data.urlExpression).toBeUndefined();
  });

  it('records a call with no argument at all as a request with an unknown target', () => {
    const node = nodeBySymbol(
      apiCallsOf(scratchProject(shapes, 'shapes'), 'src/dynamic.ts'),
      'noArgument',
    );

    expect(node.data.dynamic).toBe(true);
    expect(node.data.url).toBeUndefined();
    expect(node.data.urlExpression).toBeUndefined();
  });

  it('caps recorded source text at the documented length', () => {
    const node = nodeBySymbol(
      apiCallsOf(scratchProject(shapes, 'shapes'), 'src/cap.ts'),
      'overlongTarget',
    );
    const condensed = LONG_TARGET_EXPRESSION.replace(/\s+/g, ' ').trim();

    expect(condensed.length, 'the case must exceed the cap to exercise it').toBeGreaterThan(
      MAX_RECORDED_TEXT_LENGTH,
    );
    expect(node.data.urlExpression).toHaveLength(MAX_RECORDED_TEXT_LENGTH);
    expect(node.data.urlExpression).toBe(condensed.slice(0, MAX_RECORDED_TEXT_LENGTH));
  });
});

describe('apiCallsExtractor: the owner cascade falls through', () => {
  it('attributes a module-level binding to its symbol node', () => {
    const project = scratchProject(shapes, 'shapes');
    const node = nodeByUrl(apiCallsOf(project, 'src/owners.ts'), '/scratch/module-binding');
    const owner = ownerNodeOf(
      project.graph,
      soleCallsEdgeTo(edgesOf(project, 'src/owners.ts'), node.id),
    );

    // Cascade step 4: a module-level declaration is addressable even though its
    // value is not a function, so the call belongs to that declaration rather
    // than to the file.
    expect(owner.kind).toBe('symbol');
    expect(owner.name).toBe('moduleLevelBinding');
    expect(node.symbol).toBe('moduleLevelBinding');
  });

  for (const target of ['/scratch/top-level', '/scratch/anonymous-callback']) {
    it(`attributes ${target} to the file node, with no symbol`, () => {
      const project = scratchProject(shapes, 'shapes');
      const node = nodeByUrl(apiCallsOf(project, 'src/owners.ts'), target);
      const owner = ownerNodeOf(
        project.graph,
        soleCallsEdgeTo(edgesOf(project, 'src/owners.ts'), node.id),
      );

      // Cascade step 5, the least specific owner: no enclosing declaration
      // anywhere up the chain is addressable — a top-level statement has none,
      // and an anonymous callback is not one. The edge still has a real
      // endpoint, which `ownerNodeOf` has just proved, and the node carries no
      // `symbol` because there is no function to name.
      expect(owner.kind).toBe('file');
      expect(owner.name).toBe('src/owners.ts');
      expect(node.symbol).toBeUndefined();
      expect('symbol' in node).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------------------------------
 * 4. Robustness, purity and determinism
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every entry of a directory tree with the facts a write would change.
 *
 * Size and modification time together are what make the purity assertion
 * meaningful: a rewrite with identical length still moves `mtimeMs`, and a
 * file created or removed changes the set.
 *
 * @param root The directory to snapshot.
 * @returns One line per entry, sorted.
 */
function fileStateOf(root: string): readonly string[] {
  return readdirSync(root, { encoding: 'utf8', recursive: true })
    .sort()
    .map((relative) => {
      const stats = statSync(join(root, relative));

      return [
        relative,
        stats.isDirectory() ? 'dir' : 'file',
        String(stats.size),
        String(stats.mtimeMs),
      ].join(' ');
    });
}

/** Every project this suite extracted, for the invariants that hold across all of them. */
function everyProject(): readonly ExtractedProject[] {
  return [corpusFixture(), scratchProject(shapes, 'shapes'), scratchProject(torn, 'torn')];
}

describe('apiCallsExtractor: robustness, purity and determinism', () => {
  it('identifies itself by the exported extractor id', () => {
    expect(apiCallsExtractor.id).toBe(API_CALLS_EXTRACTOR_ID);
  });

  it('produces deeply equal, identically ordered output on two consecutive runs', () => {
    const fixture = corpusFixture();
    const first = [...extractAll(fixture.loaded).entries()];
    const second = [...extractAll(fixture.loaded).entries()];

    // Identical, and identical to the run `beforeAll` performed: ids are
    // derived only from kind, file, name and position, and emission order is
    // document order, which is what `../indexer.ts`'s reproducibility promise
    // and the index cache rest on.
    expect(second).toStrictEqual(first);
    expect(first).toStrictEqual([...fixture.results.entries()]);
  });

  it('reports a module the parser could not read in full, and quotes no source', () => {
    const project = scratchProject(torn, 'torn');
    const result = project.results.get('src/torn-module.ts');

    if (result === undefined) {
      throw new Error('the torn module was not extracted');
    }

    const diagnostics = result.diagnostics ?? [];

    // A broken module does not make ts-morph throw — it yields a partial tree —
    // so an unreported one would be a silently incomplete index.
    expect(diagnostics.length).toBeGreaterThan(0);

    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe(EXTRACTOR_DIAGNOSTIC_CODE);
      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.extractorId).toBe(API_CALLS_EXTRACTOR_ID);
      expect(diagnostic.file).toBe('src/torn-module.ts');

      // Diagnostic text names files, extractors, counts and positions, and
      // quotes no source: an abstract-syntax-tree library routinely embeds the
      // developer's own source in an error message, and that text may never
      // reach a diagnostic (the privacy constraint on
      // `INDEX_DIAGNOSTIC_CODES`).
      const text = `${diagnostic.message} ${diagnostic.detail ?? ''}`;

      for (const source of ['unreadableMember', '/scratch/never-parsed', 'fetch(', 'return']) {
        expect(text).not.toContain(source);
      }
    }
  });

  it('still indexes every other module of a project holding an unreadable one', () => {
    const project = scratchProject(torn, 'torn');
    const intact = apiCallsOf(project, 'src/intact-module.ts');

    expect(intact.map((node) => node.data.url)).toStrictEqual(['/scratch/still-indexed']);
    expect(project.results.get('src/intact-module.ts')?.diagnostics).toBeUndefined();
  });

  it('writes nothing: a scratch project is byte-identical after extraction', () => {
    const project = scratchProject(shapes, 'shapes');
    const before = fileStateOf(project.root);

    extractAll(project.loaded);

    // No filesystem access, no caching, no mutation of the tree — the contract
    // that lets the extractor run against a developer's live working tree.
    expect(fileStateOf(project.root)).toStrictEqual(before);
  });

  it('emits api-call nodes and calls edges, and nothing else', () => {
    for (const project of everyProject()) {
      for (const result of project.results.values()) {
        expect(
          result.nodes.map((node) => node.kind).filter((kind) => kind !== 'api-call'),
        ).toStrictEqual([]);
        // In particular no `references` edge: resolving who references a
        // declaration belongs to the lazy reference resolver and must never run
        // during a build.
        expect(
          result.edges.map((edge) => edge.kind).filter((kind) => kind !== 'calls'),
        ).toStrictEqual([]);
      }
    }
  });

  it('records only project-relative POSIX paths, and no absolute path anywhere', () => {
    for (const project of everyProject()) {
      const root = toPosix(project.root);

      for (const node of allApiCallsOf(project)) {
        // The same refinement `SourceLocation` applies, checked because a node
        // that fails it cannot become a location a user interface opens.
        expect(isSafeRelativePath(node.file), `${node.file} is project-relative`).toBe(true);
        expect(node.file).toBe(toPosix(node.file));
        expect(JSON.stringify(node)).not.toContain(root);
      }

      for (const edge of allEdgesOf(project)) {
        expect(edge.file === undefined || isSafeRelativePath(edge.file)).toBe(true);
        expect(JSON.stringify(edge)).not.toContain(root);
      }
    }
  });
});
