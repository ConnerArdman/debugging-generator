/**
 * `react-components` — the React component extractor of `@debuggen/code-analysis`.
 *
 * One of the per-file extractors `../indexer.ts` runs over every indexable
 * module of a target project. It owns exactly two pieces of the code graph's
 * vocabulary (`../graph/types.ts`):
 *
 * - the **`component` node kind** — one node per module-level React component
 *   declaration, carrying the required {@link ComponentNodeData} payload
 *   (`isClient`, `isDefaultExport`, `displayName`); and
 * - the **`renders` edge kind** — `component → component`, one edge per JSX
 *   usage site of one component inside another, directed from the enclosing
 *   component to the one it renders.
 *
 * Nothing else. In particular it emits **no `file` node** (that anchor belongs
 * to the import extractor, and a second producer of it would cost a
 * `duplicate-node-id` diagnostic), **no `symbol` node** for the non-component
 * members a component module also exports (a component is the more specific
 * kind and the symbol extractor owns the rest), **no `declares` or `exports`
 * edge** (the file-level extractor's) and **no `references` edge** (a reference
 * set is deepened on demand by a `ReferenceResolver`, not at indexing time).
 *
 * ## Who reads what this produces
 *
 * - `./graph/query.ts`'s `componentsRendering` is a backwards search along the
 *   `renders` edges emitted here, so their direction is load-bearing: `from` is
 *   reliably the *enclosing* component.
 * - The service's progress view says "Found ‹Component›" from these nodes
 *   (AAP 0.7.1 Group 2), which is why {@link CodeNodeBase.name} is the source
 *   spelling and never a prettified form.
 * - Click-to-source takes the `code-graph` route of AAP 0.4.2: a captured
 *   render event carries the component's runtime display name, and
 *   {@link ComponentNodeData.displayName} is the side of that pair which
 *   matches the runtime, while `file`/`line`/`column` are what the editor
 *   opens. A wrapped component — memo, forward-ref — is exactly where the two
 *   names diverge, which is why both are recorded.
 *
 * ## The naming rule, shared with `./event-handlers.ts`
 *
 * A component's node id is derived by `makeNodeId` from its kind, file, name
 * and position, and **two extractors construct component node ids**: this one,
 * which declares the node, and `./event-handlers.ts`, whose `handles` edges
 * point at the component that binds a handler. The rule below must therefore
 * stay **byte-for-byte identical** in both modules — an id that differs in one
 * character is not a slightly wrong edge, it is an edge `../graph/graph.ts`
 * drops as `dangling-edge`, which silently deletes the path from an
 * interaction to the component it happened in:
 *
 * 1. `name` is the **declared identifier** whenever the declaration has one —
 *    the variable name for `const Widget = memo(function Inner() {…})`, the
 *    function or class name otherwise. Never an export alias, and never a
 *    wrapper's inner function name.
 * 2. For a **truly anonymous default export** (`export default function () {…}`,
 *    `export default class {…}`), `name` is the file's basename without its
 *    extension, and `isDefaultExport` is `true`.
 * 3. The position is the **1-based line and column of the identifier** — the
 *    place an editor should jump to — or of the declaration itself when there
 *    is no identifier.
 *
 * A component node carries that position as the `file`/`line`/`column`/`endLine`
 * fields {@link CodeNodeBase} declares, and **not** as a `SourceLocation`: the
 * node vocabulary has no such field, and a second definition of a shape that
 * already exists in `@debuggen/shared` is exactly what `../graph/types.ts`
 * forbids. A consumer that needs one mints it from those fields with
 * `resolvedBy: 'code-graph'` and the matching entry of
 * `DEFAULT_RESOLUTION_CONFIDENCE`, which is the resolution route AAP 0.4.2
 * assigns to the code graph; `file` is already refined by `isSafeRelativePath`
 * here, so no second sanitisation is needed there.
 *
 * ## Abstract-syntax-tree first, no type resolution
 *
 * Detection reads syntax and nothing else: the `"use client"` directive
 * prologue, the shape of a declaration, the presence of JSX in a returned
 * position, and the React API names `memo` and `forwardRef`. It consults no
 * type, resolves no symbol and evaluates no expression, so a target project
 * whose dependencies are not installed — the ordinary state of a project being
 * indexed for the first time, and the deliberate state of this package's own
 * corpus — is indexed exactly as fully as one whose `node_modules` is warm.
 *
 * The one resolution step is module resolution, by design: a `renders` edge
 * needs the *declaring file* of the tag it points at, so an import binding is
 * followed with ts-morph's `getModuleSpecifierSourceFile()` and, when the
 * module it lands in is a barrel that re-exports the name rather than declaring
 * it, through the re-export chain (`export { name } from`,
 * `export { default as Name } from`, `export * from`) for a bounded number of
 * hops with a cycle guard. A tag that cannot be resolved to a declaration this
 * extractor recognises yields **no edge at all**, because an edge whose target
 * node nobody emits would be dropped as `dangling-edge`.
 *
 * ## Deliberately out of scope for v1
 *
 * - **Member-expression tags** (`<Namespace.Child />`). They are skipped, with
 *   no node and no edge: resolving one means resolving a namespace import or an
 *   object of components, which is a type- and value-level question rather than
 *   a syntactic one.
 * - **Namespaced tags** (`<svg:rect />`), which are never components.
 * - **Non-module-level declarations.** A component declared inside another
 *   function is not indexed as its own node; the JSX in it is attributed to the
 *   enclosing module-level component, which is where a developer would look.
 * - **Class components whose render is a property initialiser**
 *   (`render = () => …`) rather than a method.
 * - **Generator components**, which React does not render.
 *
 * ## Failure tolerance and determinism
 *
 * {@link reactComponentsExtractor.extract} never throws. One malformed
 * construct becomes one `extractor-failed` {@link IndexDiagnostic} — severity
 * `warning`, this extractor's id, the file and the 1-based position, and **no
 * source text**, per the privacy constraint on `INDEX_DIAGNOSTIC_CODES` — while
 * every other declaration in the file still yields its node and its edges. A
 * file the *parser* could not read in full earns one diagnostic of its own,
 * because a declaration inside a region the parser skipped is invisible to
 * every walk here and "no component in this file" would otherwise be reported
 * as a fact.
 * Emission is in source order, node by node and then edge by edge, and every
 * value is derived from the syntax tree alone, so two runs over unchanged
 * source serialise byte-identically.
 *
 * ## Position in the module graph
 *
 * Imports `@debuggen/shared` (the sole `@debuggen/*` dependency this package
 * may have, per AAP 0.2.2 and the `no-restricted-imports` layering block of
 * `eslint.config.js`), `ts-morph`, `../graph/graph.js` for the two id
 * constructors, `../graph/types.js` for the vocabulary, and `../project.js` for
 * the two predicates that decide whether a resolved file is one the indexer
 * will visit. It must never import `../indexer.js`, `../graph/query.js`,
 * `../summary.js`, `../route-map.js`, `../cache.js`, `../search/*`,
 * `../source-map/*` or a sibling extractor: the first five sit above it and a
 * sibling would couple two independent units of extraction.
 *
 * @packageDocumentation
 */

import { basenamePosix, extnamePosix, isSafeRelativePath } from '@debuggen/shared';
import { Node } from 'ts-morph';

import { makeEdgeId, makeNodeId } from '../graph/graph.js';
import { isIndexableFile, shouldExcludePath } from '../project.js';

import type {
  ClassDeclaration,
  FunctionDeclaration,
  JsxOpeningElement,
  JsxSelfClosingElement,
  SourceFile,
  VariableDeclaration,
  VariableStatement,
} from 'ts-morph';

import type {
  CodeEdge,
  CodeNodeOf,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
} from '../graph/types.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary and bounds
 * ---------------------------------------------------------------------------------------------- */

/**
 * This extractor's {@link Extractor.id}, the value that appears in
 * {@link IndexDiagnostic.extractorId}.
 *
 * Stable across versions on purpose: renaming it makes every diagnostic already
 * reported against it untraceable to its source.
 */
const EXTRACTOR_ID = 'react-components';

/**
 * The directive that makes a module a client module, and the **only** signal
 * that sets {@link ComponentNodeData.isClient}.
 *
 * Its absence classifies a server component — recorded as `isClient: false`
 * rather than left undefined — because that is exactly how the framework
 * decides, and because guessing from a hook call, an event handler or a browser
 * global would put a whole render-side investigation on a false premise.
 */
const USE_CLIENT_DIRECTIVE = 'use client';

/**
 * The export name a default export is known by, in both an import binding and a
 * re-export specifier (`export { default as Name } from …`).
 */
const DEFAULT_EXPORT_NAME = 'default';

/**
 * The property a React component's runtime display name is assigned to
 * (`Widget.displayName = 'Widget'`), read as the highest-precedence source of
 * {@link ComponentNodeData.displayName} because it is what the runtime reports.
 */
const DISPLAY_NAME_PROPERTY = 'displayName';

/**
 * The method a class component renders from.
 */
const RENDER_METHOD_NAME = 'render';

/**
 * The React API names a component declaration may be wrapped in.
 *
 * Generic framework vocabulary, matched as a callee name in either the bare
 * (`memo(…)`) or the qualified (`React.memo(…)`) form. Real projects memoise
 * components constantly, and a wrapped declaration that went undetected would
 * cost the graph the component node a captured render event has to join
 * against — the very shape this extractor exists to resolve.
 */
const COMPONENT_WRAPPER_NAMES: readonly string[] = Object.freeze(['memo', 'forwardRef']);

/**
 * How many nested wrapper calls are unwrapped before a declaration is judged
 * not to be a component.
 *
 * `memo(forwardRef(fn))` is the canonical two-level form; the bound exists so a
 * pathological or generated expression cannot drive the unwrapping arbitrarily
 * deep.
 */
const MAX_WRAPPER_DEPTH = 4;

/**
 * How many re-export hops a component name is followed through before
 * resolution gives up.
 *
 * A barrel of barrels is ordinary — `src/components/index.ts` re-exporting
 * `src/components/widgets/index.ts` — and four hops covers every layout this
 * package has met while keeping the walk bounded independently of the cycle
 * guard.
 */
const MAX_REEXPORT_HOPS = 4;

/**
 * The nodes of a file that declares no component, shared and frozen so the
 * common case allocates nothing.
 */
const EMPTY_NODES: readonly CodeNodeOf<'component'>[] = Object.freeze([]);

/**
 * The edges of a component that renders no other component, for the reason
 * given on {@link EMPTY_NODES}.
 */
const EMPTY_EDGES: readonly CodeEdge[] = Object.freeze([]);

/**
 * The result of a file this extractor found nothing in: no node, no edge and —
 * per {@link ExtractorResult.diagnostics}, which is absent rather than empty
 * for a clean extraction — no diagnostics field.
 */
const EMPTY_RESULT: ExtractorResult = Object.freeze({
  nodes: EMPTY_NODES,
  edges: EMPTY_EDGES,
});

/**
 * The detection result of a file that declares no component, shared for the
 * same reason as {@link EMPTY_NODES}. Declared before its uses so no call site
 * reads it in its initialisation window.
 */
const EMPTY_CANDIDATES: readonly ComponentCandidate[] = Object.freeze([]);

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * A 1-based position in a file, on the convention {@link CodeNodeBase.line}
 * documents and `SourceLocation` shares.
 */
interface Position {
  /** The 1-based line. */
  readonly line: number;

  /** The 1-based column. */
  readonly column: number;
}

/**
 * What one module says about the names it exports, collected once per file so
 * every declaration in it can be classified without re-walking the statements.
 *
 * Both sets hold **local declaration names**, not export aliases: the question
 * they answer is "is the declaration called `X` exported, and is it the default
 * export", which is what {@link CodeNodeBase.exported} and
 * {@link ComponentNodeData.isDefaultExport} record.
 */
interface ModuleExportNames {
  /**
   * Every local name exported through an `export { … }` clause or an
   * `export default X` assignment.
   *
   * A declaration carrying its own `export` keyword is not listed here — that
   * is read off the declaration — so a caller checks both.
   */
  readonly exported: ReadonlySet<string>;

  /**
   * Every local name exported *as the default*, through `export { X as default }`
   * or `export default X`.
   *
   * A subset of {@link ModuleExportNames.exported}. The inline
   * `export default function X` form carries a default keyword instead and is
   * read off the declaration.
   */
  readonly asDefault: ReadonlySet<string>;
}

/**
 * Everything about the module under extraction that every declaration in it
 * shares.
 *
 * Gathered once per file: the client-module classification, the display-name
 * overrides assigned at module level, and the export names above. Passing it
 * down keeps each detection branch a pure function of one declaration plus this
 * context.
 */
interface ModuleScope {
  /** The module's project-relative POSIX path, from {@link ExtractorContext.file}. */
  readonly file: string;

  /**
   * Whether the module carries the `"use client"` directive — copied onto every
   * component node's {@link ComponentNodeData.isClient}.
   */
  readonly isClient: boolean;

  /**
   * Display names assigned at module level (`Widget.displayName = 'Widget'`),
   * keyed by the declared identifier they were assigned to.
   */
  readonly displayNames: ReadonlyMap<string, string>;

  /** What the module exports, by local name. */
  readonly exports: ModuleExportNames;
}

/**
 * One detected component: the node this extractor emits for it, and the
 * declaration subtree its `renders` edges are read from.
 *
 * The node is built at detection time rather than later, because its id is what
 * both an edge's `from` and a cross-file edge's `to` are, and building it in one
 * place is what keeps the two byte-identical.
 */
interface ComponentCandidate {
  /**
   * The declaration subtree that holds the component's JSX.
   *
   * The function or class declaration, or the *variable declaration* for an
   * assigned form, so the JSX inside a wrapper call
   * (`const Widget = memo(() => <Row />)`) is inside it.
   */
  readonly declaration: Node;

  /** The `component` node, ready to emit. */
  readonly node: CodeNodeOf<'component'>;
}

/**
 * The fields {@link buildCandidate} needs that vary between detection branches.
 *
 * An options object rather than a parameter list: the branches differ in four
 * independent booleans and names, and a positional signature of that width is
 * the kind that gets called with two arguments transposed.
 */
interface CandidateDraft {
  /** The subtree that holds the JSX; becomes {@link ComponentCandidate.declaration}. */
  readonly declaration: Node;

  /**
   * The node whose start position the component is reported at: the declared
   * identifier where there is one, the declaration itself for an anonymous
   * default export.
   */
  readonly anchor: Node;

  /** The name, already resolved by the naming rule documented in the header. */
  readonly name: string;

  /** The runtime display name. */
  readonly displayName: string;

  /** Whether the declaration is the file's default export. */
  readonly isDefaultExport: boolean;

  /** Whether the declaration is exported at all. */
  readonly exported: boolean;
}

/**
 * What the parser recorded about a file that did not parse cleanly.
 *
 * A count and a place, and deliberately nothing else: the parser's messages
 * quote the source they failed on, which a diagnostic may not carry (see
 * {@link syntaxFailure}).
 */
interface SyntaxErrorSummary {
  /** How many syntax errors the parser recorded for the file. */
  readonly count: number;

  /** Where the first one is, when the parser reported a position for it. */
  readonly first: Position | undefined;
}

/**
 * A function-like expression a component declaration was found to be, together
 * with the name the runtime would report for it.
 */
interface ComponentFunction {
  /** The arrow function or function expression that produces the JSX. */
  readonly fn: Node;

  /**
   * The inner function's own name, when it has one.
   *
   * `const Widget = memo(function Inner() {…})` renders under `Inner` in the
   * React tree while the declaration is called `Widget`, and this is the field
   * that carries the difference into
   * {@link ComponentNodeData.displayName}.
   */
  readonly innerName: string | undefined;
}

/**
 * Where an imported component name came from: the module that was imported, and
 * the name to look for *inside* it.
 *
 * The distinction is the whole point of the shape: `import { Inner as Outer }`
 * binds `Outer` locally while the module exports it as `Inner`, and
 * `import Outer from …` binds a name the module exports as `default`.
 */
interface ImportBinding {
  /** The resolved module the name is imported from. */
  readonly moduleSourceFile: SourceFile;

  /** The name that module exports it under, possibly `'default'`. */
  readonly exportName: string;
}

/* -------------------------------------------------------------------------------------------------
 * The extractor
 * ---------------------------------------------------------------------------------------------- */

/**
 * The React component extractor: `component` nodes and `renders` edges for one
 * file.
 *
 * Registered in `../indexer.ts`'s default extractor set. Synchronous and
 * side-effect-free, as {@link Extractor} requires: it reads the syntax tree,
 * never mutates a node, never writes a file and never performs I/O beyond the
 * module resolution ts-morph does on its behalf.
 *
 * @example
 * ```ts
 * const result = reactComponentsExtractor.extract(ctx);
 * for (const node of result.nodes) {
 *   // node.kind === 'component', node.data.isClient, node.data.displayName
 * }
 * ```
 */
export const reactComponentsExtractor: Extractor = Object.freeze({
  id: EXTRACTOR_ID,

  extract(ctx: ExtractorContext): ExtractorResult {
    return extractComponents(ctx);
  },
});

/**
 * Extracts every component node and `renders` edge of one file.
 *
 * Three stages, in this order, so a failure in one costs only what it is about:
 * the module-wide facts are gathered, each module-level statement is inspected
 * for component declarations, and each detected component's JSX is walked for
 * the components it renders. A throw anywhere inside becomes a diagnostic
 * rather than an exception — the indexer would survive one, but it would lose
 * every node this file had already yielded.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The component nodes, the `renders` edges, and any diagnostics.
 */
function extractComponents(ctx: ExtractorContext): ExtractorResult {
  // `ExtractorContext.file` is produced by the indexer through
  // `LoadedProject.projectRelative`, so this can only fail if a caller built a
  // context by hand. It is checked anyway: every node's `file` must satisfy the
  // same refinement `SourceLocation` applies, or a graph node cannot become a
  // location a user interface opens (see `CodeNodeBase.file`).
  if (!isSafeRelativePath(ctx.file)) {
    ctx.logger.warn('component extraction skipped: the file path is not project-relative', {
      extractorId: EXTRACTOR_ID,
    });

    return EMPTY_RESULT;
  }

  const diagnostics: IndexDiagnostic[] = [];

  // Reported first because it explains anything else this file did or did not
  // yield: a region the parser could not read is a region a component could
  // have been declared in.
  const unparsed = syntaxFailure(ctx);
  if (unparsed !== undefined) {
    diagnostics.push(unparsed);
  }

  let candidates: readonly ComponentCandidate[] = EMPTY_CANDIDATES;

  try {
    candidates = collectCandidates(ctx.sourceFile, ctx.file, diagnostics);
  } catch (cause) {
    diagnostics.push(fileFailure(ctx.file, cause));
  }

  const nodes =
    candidates.length === 0 ? EMPTY_NODES : candidates.map((candidate) => candidate.node);
  const edges =
    candidates.length === 0 ? EMPTY_EDGES : collectRendersEdges(ctx, candidates, diagnostics);

  // `diagnostics` is absent rather than empty for a clean extraction, which is
  // what `ExtractorResult` documents and what lets the indexer concatenate
  // without a guard.
  return diagnostics.length === 0 ? { nodes, edges } : { nodes, edges, diagnostics };
}

/* -------------------------------------------------------------------------------------------------
 * Detection
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every component declared at the module level of one file, in source order.
 *
 * Called twice for different reasons, and both matter:
 *
 * - for the file under extraction, where `failures` is the diagnostics list the
 *   result carries; and
 * - for a file a `renders` edge resolved into, where the caller discards
 *   `failures` because that file gets its own visit and its own diagnostics, and
 *   reporting them from here would duplicate them.
 *
 * Reusing one function for both is what guarantees a cross-file edge's `to` is
 * the id the target file's own pass emits: the name, position and kind all come
 * out of the same rule.
 *
 * Per-statement failures are contained: a construct that throws costs its own
 * declaration and nothing else.
 *
 * @param sourceFile The module to inspect.
 * @param file That module's project-relative POSIX path.
 * @param failures Collector for `extractor-failed` diagnostics.
 * @returns The detected components, in source order.
 */
function collectCandidates(
  sourceFile: SourceFile,
  file: string,
  failures: IndexDiagnostic[],
): readonly ComponentCandidate[] {
  const scope: ModuleScope = {
    file,
    isClient: hasUseClientDirective(sourceFile),
    displayNames: collectDisplayNameOverrides(sourceFile),
    exports: collectModuleExportNames(sourceFile),
  };

  const candidates: ComponentCandidate[] = [];

  for (const statement of sourceFile.getStatements()) {
    try {
      appendStatementCandidates(scope, statement, candidates);
    } catch (cause) {
      failures.push(constructFailure(file, statement, cause));
    }
  }

  return candidates.length === 0 ? EMPTY_CANDIDATES : candidates;
}

/**
 * Appends the components one module-level statement declares.
 *
 * A statement declares at most one component, except a variable statement with
 * several declarators (`const A = () => …, B = () => …`), which is why the
 * accumulator is passed in rather than returned.
 *
 * @param scope The module-wide facts.
 * @param statement One module-level statement.
 * @param candidates The accumulator, appended in source order.
 */
function appendStatementCandidates(
  scope: ModuleScope,
  statement: Node,
  candidates: ComponentCandidate[],
): void {
  // `function Widget() { … }`, `export function Widget() { … }`,
  // `export default function Widget() { … }` and the anonymous
  // `export default function () { … }`.
  if (Node.isFunctionDeclaration(statement)) {
    appendCandidate(candidates, functionCandidate(scope, statement));

    return;
  }

  // `class Widget { render() { … } }` and `export default class { render() { … } }`.
  if (Node.isClassDeclaration(statement)) {
    appendCandidate(candidates, classCandidate(scope, statement));

    return;
  }

  // `const Widget = () => …`, `const Widget = function () { … }`,
  // `const Widget = memo(…)`, `const Widget = forwardRef(…)`.
  if (Node.isVariableStatement(statement)) {
    for (const declaration of statement.getDeclarations()) {
      appendCandidate(candidates, variableCandidate(scope, statement, declaration));
    }
  }
}

/**
 * Appends a candidate when there is one.
 *
 * A two-line helper, so that the branches above read as a list of syntactic
 * forms instead of a list of undefined checks.
 *
 * @param candidates The accumulator.
 * @param candidate The candidate, or `undefined` when the declaration is not a
 * component.
 */
function appendCandidate(
  candidates: ComponentCandidate[],
  candidate: ComponentCandidate | undefined,
): void {
  if (candidate !== undefined) {
    candidates.push(candidate);
  }
}

/**
 * The component a function declaration declares, if it is one.
 *
 * Two gates, both from the header's rule: the declaration is named with an
 * initial capital *or* is an anonymous default export, and it produces JSX in a
 * returned position.
 *
 * @param scope The module-wide facts.
 * @param declaration The function declaration.
 * @returns The candidate, or `undefined`.
 */
function functionCandidate(
  scope: ModuleScope,
  declaration: FunctionDeclaration,
): ComponentCandidate | undefined {
  const nameNode = declaration.getNameNode();
  const declaredName = nameNode?.getText();

  if (!isComponentDeclarationName(declaredName, declaration.hasDefaultKeyword())) {
    return undefined;
  }

  // A generator function cannot be a React component, whatever it returns.
  if (declaration.isGenerator()) {
    return undefined;
  }

  if (!functionProducesJsx(declaration)) {
    return undefined;
  }

  const name = componentName(declaredName, scope.file);

  return buildCandidate(scope, {
    declaration,
    anchor: nameNode ?? declaration,
    name,
    displayName: componentDisplayName(scope, declaredName, undefined) ?? name,
    isDefaultExport: isDefaultExported(scope, declaredName, declaration.hasDefaultKeyword()),
    exported: isExported(scope, declaredName, declaration.isExported()),
  });
}

/**
 * The component a class declaration declares, if it is one.
 *
 * A class is a component when it has a `render` **method** that produces JSX.
 * A `render` property initialiser is out of scope (see the header), and a
 * static `render` is not the React contract, so `getMethod` — which looks at
 * instance methods — is exactly the right lookup.
 *
 * @param scope The module-wide facts.
 * @param declaration The class declaration.
 * @returns The candidate, or `undefined`.
 */
function classCandidate(
  scope: ModuleScope,
  declaration: ClassDeclaration,
): ComponentCandidate | undefined {
  const nameNode = declaration.getNameNode();
  const declaredName = nameNode?.getText();

  if (!isComponentDeclarationName(declaredName, declaration.hasDefaultKeyword())) {
    return undefined;
  }

  const render = declaration.getMethod(RENDER_METHOD_NAME);
  if (render === undefined || !functionProducesJsx(render)) {
    return undefined;
  }

  const name = componentName(declaredName, scope.file);

  return buildCandidate(scope, {
    declaration,
    anchor: nameNode ?? declaration,
    name,
    displayName: componentDisplayName(scope, declaredName, undefined) ?? name,
    isDefaultExport: isDefaultExported(scope, declaredName, declaration.hasDefaultKeyword()),
    exported: isExported(scope, declaredName, declaration.isExported()),
  });
}

/**
 * The component one declarator of a variable statement declares, if it is one.
 *
 * The assigned forms: an arrow function, a function expression, and a wrapper
 * call around either (`memo`, `forwardRef`, qualified or not, nested up to
 * {@link MAX_WRAPPER_DEPTH}). A destructuring declarator is not a component
 * declaration and is refused before anything else, because its "name" is a
 * binding pattern rather than an identifier.
 *
 * The candidate's `declaration` is the **variable declaration**, not the
 * function inside it, so a wrapper call's JSX is inside the subtree the
 * `renders` pass walks.
 *
 * @param scope The module-wide facts.
 * @param statement The variable statement the declarator belongs to, which is
 * where an `export` keyword would sit.
 * @param declaration The declarator.
 * @returns The candidate, or `undefined`.
 */
function variableCandidate(
  scope: ModuleScope,
  statement: VariableStatement,
  declaration: VariableDeclaration,
): ComponentCandidate | undefined {
  const nameNode = declaration.getNameNode();
  if (!Node.isIdentifier(nameNode)) {
    return undefined;
  }

  const declaredName = nameNode.getText();

  // An assigned component always has a name, so the anonymous-default branch of
  // the naming rule cannot apply here.
  if (!isComponentDeclarationName(declaredName, false)) {
    return undefined;
  }

  const initializer = declaration.getInitializer();
  if (initializer === undefined) {
    return undefined;
  }

  const fn = componentFunctionOf(initializer, 0);
  if (fn === undefined || !functionProducesJsx(fn.fn)) {
    return undefined;
  }

  return buildCandidate(scope, {
    declaration,
    anchor: nameNode,
    name: declaredName,
    displayName: componentDisplayName(scope, declaredName, fn.innerName) ?? declaredName,
    isDefaultExport: isDefaultExported(scope, declaredName, false),
    exported: isExported(scope, declaredName, statement.isExported()),
  });
}

/**
 * Turns a draft into the candidate that will be emitted.
 *
 * The single place a `component` node is constructed, and therefore the single
 * place its id is derived. Both properties the graph depends on come from here:
 * the id is built by {@link makeNodeId} from the project-relative file, the name
 * and the identifier's 1-based position, and `endLine` is clamped to at least
 * `line` so the span is never inverted for a declaration whose body was parsed
 * from an unterminated construct.
 *
 * @param scope The module-wide facts.
 * @param draft What this detection branch determined.
 * @returns The candidate.
 */
function buildCandidate(scope: ModuleScope, draft: CandidateDraft): ComponentCandidate {
  const position = positionOf(draft.anchor);
  const endLine = Math.max(draft.declaration.getEndLineNumber(), position.line);

  const node: CodeNodeOf<'component'> = {
    id: makeNodeId({
      kind: 'component',
      file: scope.file,
      name: draft.name,
      line: position.line,
      column: position.column,
    }),
    kind: 'component',
    name: draft.name,
    file: scope.file,
    line: position.line,
    column: position.column,
    endLine,
    exported: draft.exported,
    data: {
      isClient: scope.isClient,
      isDefaultExport: draft.isDefaultExport,
      displayName: draft.displayName,
    },
  };

  return { declaration: draft.declaration, node };
}

/* -------------------------------------------------------------------------------------------------
 * Naming, export status and module facts
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a declaration's name admits it as a component candidate.
 *
 * The capitalisation gate of the header's rule, plus the one exception: a
 * declaration with no name at all is a candidate only when it is the file's
 * inline default export, because that is the only way an anonymous declaration
 * can be reached by another module.
 *
 * @param declaredName The declared identifier, or `undefined`.
 * @param hasDefaultKeyword Whether the declaration carries `export default`.
 * @returns `true` when the name gate is satisfied.
 */
function isComponentDeclarationName(
  declaredName: string | undefined,
  hasDefaultKeyword: boolean,
): boolean {
  if (declaredName === undefined) {
    return hasDefaultKeyword;
  }

  return startsWithUppercase(declaredName);
}

/**
 * Whether a name begins with an uppercase letter.
 *
 * The rule JSX itself applies in spirit — a lowercase-initial tag is a host
 * element, an uppercase-initial one is a value reference — implemented over the
 * first **code point** rather than the first UTF-16 unit, so a name outside the
 * Basic Multilingual Plane is judged on its actual initial character. A
 * caseless initial (`_`, `$`, a digit, a script without case) is not an
 * uppercase letter and therefore not a component name, which keeps the rule the
 * same one `./event-handlers.ts` applies.
 *
 * @param name The name to test.
 * @returns `true` when the first character is an uppercase letter.
 */
function startsWithUppercase(name: string): boolean {
  const first = name.codePointAt(0);
  if (first === undefined) {
    return false;
  }

  const initial = String.fromCodePoint(first);

  // Both halves are needed: the first rejects caseless characters, the second
  // rejects a title-case character whose uppercase form differs from itself.
  return initial !== initial.toLowerCase() && initial === initial.toUpperCase();
}

/**
 * The component's {@link CodeNodeBase.name}, by the naming rule in the header.
 *
 * The declared identifier when there is one; otherwise the file's basename
 * without its extension, which is what a developer calls an anonymously
 * default-exported page or layout module.
 *
 * @param declaredName The declared identifier, or `undefined`.
 * @param file The module's project-relative POSIX path.
 * @returns The name to record.
 */
function componentName(declaredName: string | undefined, file: string): string {
  if (declaredName !== undefined) {
    return declaredName;
  }

  return basenamePosix(file, extnamePosix(file));
}

/**
 * The component's runtime display name, when it differs from its declared one.
 *
 * Precedence, highest first, because each step is closer to what the runtime
 * reports and therefore to what a captured render event will carry:
 *
 * 1. an explicit module-level `Widget.displayName = 'Something'` assignment;
 * 2. the name of the function inside a `memo`/`forwardRef` wrapper, which is
 *    the name React derives when the wrapper itself is anonymous;
 * 3. nothing — the caller falls back to the declared name.
 *
 * @param scope The module-wide facts.
 * @param declaredName The declared identifier, or `undefined` for an anonymous
 * default export.
 * @param innerName The wrapped function's own name, when there is one.
 * @returns The display name, or `undefined` when the declared name should be
 * used.
 */
function componentDisplayName(
  scope: ModuleScope,
  declaredName: string | undefined,
  innerName: string | undefined,
): string | undefined {
  if (declaredName !== undefined) {
    const override = scope.displayNames.get(declaredName);
    if (override !== undefined) {
      return override;
    }
  }

  return innerName;
}

/**
 * Whether a declaration is the file's default export.
 *
 * Both forms count, as {@link ComponentNodeData.isDefaultExport} requires: the
 * inline `export default …` keyword, and the detached
 * `export { Widget as default }` / `export default Widget` statements collected
 * into {@link ModuleExportNames.asDefault}.
 *
 * @param scope The module-wide facts.
 * @param declaredName The declared identifier, or `undefined`.
 * @param hasDefaultKeyword Whether the declaration carries `export default`.
 * @returns `true` when the declaration is the default export.
 */
function isDefaultExported(
  scope: ModuleScope,
  declaredName: string | undefined,
  hasDefaultKeyword: boolean,
): boolean {
  if (hasDefaultKeyword) {
    return true;
  }

  return declaredName !== undefined && scope.exports.asDefault.has(declaredName);
}

/**
 * Whether a declaration is exported from its file at all.
 *
 * The declaration's own `export` keyword, or its name in an
 * `export { … }` clause. Recorded because `packages/instrumentation` can only
 * reason about a symbol another module can reach, and `../summary.ts` prefers
 * exported declarations when it must choose which to report.
 *
 * @param scope The module-wide facts.
 * @param declaredName The declared identifier, or `undefined`.
 * @param hasExportKeyword Whether the declaration carries `export`.
 * @returns `true` when the declaration is exported.
 */
function isExported(
  scope: ModuleScope,
  declaredName: string | undefined,
  hasExportKeyword: boolean,
): boolean {
  if (hasExportKeyword) {
    return true;
  }

  return declaredName !== undefined && scope.exports.exported.has(declaredName);
}

/**
 * Whether a module carries the `"use client"` directive.
 *
 * A directive prologue is a run of string-literal expression statements at the
 * very top of the module, so the scan walks statements from the first and stops
 * at the first one that is not such a statement. Both quote styles are handled
 * for free — `getLiteralValue` returns the cooked value — and a leading comment
 * block or a shebang is leading trivia rather than a statement, so neither hides
 * the directive.
 *
 * Nothing else is consulted, ever: see {@link USE_CLIENT_DIRECTIVE}.
 *
 * @param sourceFile The module to inspect.
 * @returns `true` when the module is a client module.
 */
function hasUseClientDirective(sourceFile: SourceFile): boolean {
  for (const statement of sourceFile.getStatements()) {
    if (!Node.isExpressionStatement(statement)) {
      return false;
    }

    const expression = statement.getExpression();
    if (!Node.isStringLiteral(expression)) {
      return false;
    }

    if (expression.getLiteralValue().trim() === USE_CLIENT_DIRECTIVE) {
      return true;
    }
  }

  return false;
}

/**
 * The display names assigned at a module's top level, keyed by the declared
 * identifier they were assigned to.
 *
 * Matches the `Widget.displayName = 'Something'` statement form and nothing
 * else: the assignment target must be a property access on a plain identifier,
 * the property must be `displayName`, and the value must be a string literal —
 * an expression would have to be evaluated, and this extractor evaluates
 * nothing. A name assigned twice keeps the last assignment, which is what the
 * runtime would hold.
 *
 * @param sourceFile The module to inspect.
 * @returns The overrides, empty when there are none.
 */
function collectDisplayNameOverrides(sourceFile: SourceFile): ReadonlyMap<string, string> {
  const overrides = new Map<string, string>();

  for (const statement of sourceFile.getStatements()) {
    if (!Node.isExpressionStatement(statement)) {
      continue;
    }

    const expression = statement.getExpression();
    if (!Node.isBinaryExpression(expression)) {
      continue;
    }

    if (expression.getOperatorToken().getText() !== '=') {
      continue;
    }

    const target = expression.getLeft();
    if (!Node.isPropertyAccessExpression(target) || target.getName() !== DISPLAY_NAME_PROPERTY) {
      continue;
    }

    const owner = target.getExpression();
    const value = expression.getRight();
    if (!Node.isIdentifier(owner) || !Node.isStringLiteral(value)) {
      continue;
    }

    overrides.set(owner.getText(), value.getLiteralValue());
  }

  return overrides;
}

/**
 * The local names a module exports, and the subset it exports as the default.
 *
 * Only clauses **without** a module specifier are read here: those are the ones
 * that say something about a declaration in *this* file. A re-export
 * (`export { Widget } from './widget.js'`) says nothing about a local
 * declaration and is followed elsewhere, by
 * {@link resolveExportedComponentId}.
 *
 * @param sourceFile The module to inspect.
 * @returns The export names, by local name.
 */
function collectModuleExportNames(sourceFile: SourceFile): ModuleExportNames {
  const exported = new Set<string>();
  const asDefault = new Set<string>();

  for (const declaration of sourceFile.getExportDeclarations()) {
    if (declaration.getModuleSpecifier() !== undefined || declaration.isTypeOnly()) {
      continue;
    }

    for (const specifier of declaration.getNamedExports()) {
      if (specifier.isTypeOnly()) {
        continue;
      }

      // `export { Widget }` exports the local name; `export { Widget as default }`
      // additionally makes it the default export.
      const localName = specifier.getName();
      exported.add(localName);

      if (specifier.getAliasNode()?.getText() === DEFAULT_EXPORT_NAME) {
        asDefault.add(localName);
      }
    }
  }

  // `export default Widget` — an export assignment over an identifier declared
  // in this file. `export = Widget` is the CommonJS form and is not a default
  // export.
  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) {
      continue;
    }

    const expression = assignment.getExpression();
    if (Node.isIdentifier(expression)) {
      exported.add(expression.getText());
      asDefault.add(expression.getText());
    }
  }

  return { exported, asDefault };
}

/**
 * The 1-based line and column a node starts at.
 *
 * 1-based on both axes, which is the convention {@link CodeNodeBase.line}
 * fixes for the whole product; the single conversion to an editor's 0-based
 * position happens in the VS Code extension.
 *
 * @param node Any node.
 * @returns Its start position.
 */
function positionOf(node: Node): Position {
  return positionAt(node.getSourceFile(), node.getStart());
}

/**
 * The 1-based line and column of an offset in a file.
 *
 * The offset-taking half of {@link positionOf}, for the one caller that holds a
 * position without a node: a parser diagnostic.
 *
 * @param sourceFile The file the offset is in.
 * @param pos A zero-based character offset.
 * @returns The corresponding 1-based position.
 */
function positionAt(sourceFile: SourceFile, pos: number): Position {
  const { line, column } = sourceFile.getLineAndColumnAtPos(pos);

  return { line, column };
}

/* -------------------------------------------------------------------------------------------------
 * Does this declaration produce JSX?
 * ---------------------------------------------------------------------------------------------- */

/**
 * The function-like expression a variable initialiser resolves to, if any.
 *
 * Unwraps, in a loop bounded by {@link MAX_WRAPPER_DEPTH}:
 *
 * - parentheses, `as` and `satisfies` assertions and non-null assertions, none
 *   of which change what is being assigned;
 * - a `memo`/`forwardRef` call — bare or qualified — around its first argument,
 *   including the nested `memo(forwardRef(fn))` form.
 *
 * Anything else — an object literal, a call to an unrecognised function, a
 * plain value — is not a component declaration, which is how a component module
 * that also exports a constant keeps that constant out of this extractor's
 * output.
 *
 * @param expression The initialiser, or an inner expression during unwrapping.
 * @param depth How many wrapper calls have already been unwrapped.
 * @returns The function and its own name, or `undefined`.
 */
function componentFunctionOf(expression: Node, depth: number): ComponentFunction | undefined {
  // `() => …` — an arrow has no name of its own, so the declared identifier is
  // what the runtime reports.
  if (Node.isArrowFunction(expression)) {
    return { fn: expression, innerName: undefined };
  }

  // `function () { … }` and `function Inner() { … }`.
  if (Node.isFunctionExpression(expression)) {
    return { fn: expression, innerName: expression.getName() };
  }

  // Transparent wrappers: `(fn)`, `fn as T`, `fn satisfies T`, `fn!`.
  if (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isSatisfiesExpression(expression) ||
    Node.isNonNullExpression(expression)
  ) {
    return componentFunctionOf(expression.getExpression(), depth);
  }

  // `memo(…)`, `React.memo(…)`, `forwardRef(…)`.
  if (
    depth < MAX_WRAPPER_DEPTH &&
    Node.isCallExpression(expression) &&
    isComponentWrapperCallee(expression.getExpression())
  ) {
    const [first] = expression.getArguments();

    return first === undefined ? undefined : componentFunctionOf(first, depth + 1);
  }

  return undefined;
}

/**
 * Whether a call's callee is one of the React component wrappers.
 *
 * Matched by **name only**, in the bare (`memo`) and qualified (`React.memo`)
 * forms — no import is resolved and no type is consulted, which keeps the check
 * working in a project whose dependencies are not installed. The cost of the
 * looseness is a false positive on an unrelated local function called `memo`,
 * which would still have to return JSX from an uppercase-named declaration
 * before it produced a node.
 *
 * @param callee The callee expression.
 * @returns `true` when the callee names a component wrapper.
 */
function isComponentWrapperCallee(callee: Node): boolean {
  if (Node.isIdentifier(callee)) {
    return COMPONENT_WRAPPER_NAMES.includes(callee.getText());
  }

  if (Node.isPropertyAccessExpression(callee)) {
    return COMPONENT_WRAPPER_NAMES.includes(callee.getName());
  }

  return false;
}

/**
 * Whether a function-like node produces JSX in a returned position.
 *
 * Two shapes, which together are the whole of the header's rule:
 *
 * - a **concise arrow body** (`() => <Row />`, `() => cond ? <A /> : <B />`,
 *   `() => items.map(…)`), where the body expression itself is what is
 *   returned; and
 * - a **block body**, where every `return` statement belonging to *this*
 *   function is examined. Returns inside a nested function belong to that
 *   function and are skipped, so a function whose body merely *holds* a
 *   JSX-returning callback (`const cell = () => <Row />; return cell;`) is not
 *   itself mistaken for a component.
 *
 * "Produces JSX" is then "the returned expression contains a JSX element,
 * self-closing element or fragment anywhere inside it", which is what admits
 * the conditional, logical and mapped forms real components are written in. The
 * one consequence worth stating: a function that *returns* a JSX-producing
 * function (`return () => <Row />;`) satisfies the rule as written, and is
 * recorded under the enclosing declaration's name — which is the name a
 * developer would search for, since the inner function is not a module-level
 * declaration and gets no node of its own.
 *
 * @param fn A function declaration, function expression, arrow function or
 * method.
 * @returns `true` when the function returns JSX.
 */
function functionProducesJsx(fn: Node): boolean {
  if (Node.isArrowFunction(fn)) {
    const body = fn.getBody();

    if (!Node.isBlock(body)) {
      return containsJsx(body);
    }
  }

  return returnsJsxFromOwnBody(fn);
}

/**
 * Whether any `return` statement belonging to this function returns JSX.
 *
 * The traversal skips the subtree of every nested function-like node, so only
 * this function's own returns are considered, and stops at the first match.
 *
 * @param fn The function whose body is walked.
 * @returns `true` when one of its own returns contains JSX.
 */
function returnsJsxFromOwnBody(fn: Node): boolean {
  let found = false;

  fn.forEachDescendant((node, traversal) => {
    // A nested function's returns are its own, not this function's.
    if (Node.isFunctionLikeDeclaration(node)) {
      traversal.skip();

      return;
    }

    if (!Node.isReturnStatement(node)) {
      return;
    }

    const expression = node.getExpression();
    if (expression !== undefined && containsJsx(expression)) {
      found = true;
      traversal.stop();
    }
  });

  return found;
}

/**
 * Whether an expression contains JSX anywhere inside it.
 *
 * A subtree search rather than a shape match, deliberately: the returned
 * expression of a real component is as often `cond && <Row />`,
 * `cond ? <A /> : <B />` or `items.map((item) => <Row key={item.id} />)` as it
 * is a bare element, and enumerating those forms would leave the next one out.
 *
 * @param node The returned expression, or an arrow's concise body.
 * @returns `true` when JSX output appears inside it.
 */
function containsJsx(node: Node): boolean {
  if (isJsxOutput(node)) {
    return true;
  }

  let found = false;

  node.forEachDescendant((child, traversal) => {
    if (isJsxOutput(child)) {
      found = true;
      traversal.stop();
    }
  });

  return found;
}

/**
 * Whether a node is one of the three JSX forms that render something.
 *
 * `<Row />`, `<Row>…</Row>` and `<>…</>`. A JSX attribute, expression container
 * or text node is not itself output, and a node kind that is not JSX at all
 * obviously is not.
 *
 * @param node Any node.
 * @returns `true` for a JSX element, self-closing element or fragment.
 */
function isJsxOutput(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

/* -------------------------------------------------------------------------------------------------
 * `renders` edges
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every `renders` edge of one file, in source order.
 *
 * One edge per JSX **usage site**: the same child rendered twice in one parent
 * is two edges, which is both true to the source and what keeps their ids
 * distinct — {@link makeEdgeId} takes the site's line and column, so no
 * occurrence counter is needed and `../graph/graph.ts` never has to drop a
 * `duplicate-edge-id`.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param candidates The components detected in this file.
 * @param diagnostics Collector for `extractor-failed` diagnostics.
 * @returns The edges, in source order.
 */
function collectRendersEdges(
  ctx: ExtractorContext,
  candidates: readonly ComponentCandidate[],
  diagnostics: IndexDiagnostic[],
): readonly CodeEdge[] {
  const edges: CodeEdge[] = [];

  for (const candidate of candidates) {
    for (const element of jsxElementsWithin(candidate.declaration)) {
      try {
        appendRendersEdge(ctx, candidates, candidate, element, edges);
      } catch (cause) {
        // One unreadable element costs its own edge; the rest of the component
        // and every other component in the file still produce theirs.
        diagnostics.push(constructFailure(ctx.file, element, cause));
      }
    }
  }

  return edges.length === 0 ? EMPTY_EDGES : edges;
}

/**
 * Appends the `renders` edge one JSX element implies, when it implies one.
 *
 * Three ways there is no edge, and none of them is an error:
 *
 * - the tag is a **host element** (`<div />`) or a namespaced one
 *   (`<svg:rect />`), neither of which is a component;
 * - the tag is a **member expression** (`<Namespace.Child />`), out of scope for
 *   v1 (see the header); or
 * - the tag **cannot be resolved** to a component declaration this extractor
 *   recognises — a component from a package that is not installed, a
 *   locally-shadowed name, a re-export chain that leads nowhere. Emitting an
 *   edge there would mean emitting one whose target node nobody declares, and
 *   `../graph/graph.ts` would drop it as `dangling-edge`, so it is not emitted
 *   at all.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param candidates The components detected in this file, for same-file
 * resolution.
 * @param parent The component the element appears inside.
 * @param element The JSX opening or self-closing element.
 * @param edges The accumulator, appended in source order.
 */
function appendRendersEdge(
  ctx: ExtractorContext,
  candidates: readonly ComponentCandidate[],
  parent: ComponentCandidate,
  element: JsxOpeningElement | JsxSelfClosingElement,
  edges: CodeEdge[],
): void {
  const tag = componentTagName(element);
  if (tag === undefined) {
    return;
  }

  const to = resolveTargetComponentId(ctx, candidates, tag);
  if (to === undefined) {
    return;
  }

  const from = parent.node.id;
  const position = positionOf(element);

  edges.push({
    id: makeEdgeId({ kind: 'renders', from, to, line: position.line, column: position.column }),
    kind: 'renders',
    from,
    to,
    // The edge *site*: where the markup is written, which is this file even when
    // the component it points at lives in another one.
    file: ctx.file,
    line: position.line,
    column: position.column,
  });
}

/**
 * Every JSX opening and self-closing element inside a declaration, in source
 * order.
 *
 * Collected into an array before anything is resolved, so the per-element
 * failure handling above cannot interfere with the traversal and the order of
 * emission is unmistakably source order.
 *
 * @param declaration The component's declaration subtree.
 * @returns The elements, in source order.
 */
function jsxElementsWithin(
  declaration: Node,
): readonly (JsxOpeningElement | JsxSelfClosingElement)[] {
  const elements: (JsxOpeningElement | JsxSelfClosingElement)[] = [];

  declaration.forEachDescendant((node) => {
    if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
      elements.push(node);
    }
  });

  return elements;
}

/**
 * The component name a JSX element references, or `undefined` when it
 * references none.
 *
 * An identifier tag beginning with an uppercase letter is a component
 * reference; a lowercase-initial identifier is a host element; a property-access
 * tag and a namespaced tag are both out of scope (see the header).
 *
 * @param element The JSX opening or self-closing element.
 * @returns The referenced component name, or `undefined`.
 */
function componentTagName(element: JsxOpeningElement | JsxSelfClosingElement): string | undefined {
  const tagName = element.getTagNameNode();

  if (!Node.isIdentifier(tagName)) {
    return undefined;
  }

  const name = tagName.getText();

  return startsWithUppercase(name) ? name : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Resolving a tag to a declaration
 * ---------------------------------------------------------------------------------------------- */

/**
 * The node id of the component a tag refers to, or `undefined` when no
 * declaration this extractor recognises can be found.
 *
 * The order is the scoping order of the language, and it matters:
 *
 * 1. **A declaration in this very file** wins, because a module-level
 *    declaration shadows any import of the same name. It yields an edge when
 *    detection recognised it as a component, and ends the search when it did
 *    not: the name is taken, and falling through to the imports would
 *    attribute the usage to an unrelated module.
 * 2. **An import binding** is followed into the module it names, honouring an
 *    alias so the *original* exported name is what is looked up there.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param candidates The components detected in this file.
 * @param tag The referenced component name, as written in the tag.
 * @returns The target node id, or `undefined`.
 */
function resolveTargetComponentId(
  ctx: ExtractorContext,
  candidates: readonly ComponentCandidate[],
  tag: string,
): string | undefined {
  // The shadowing question comes first, and asking it of the *source* rather
  // than of the detected candidates is what keeps an anonymous default export
  // out of the way: its node is named after the file, which can coincide with
  // an imported tag's name without the file declaring that identifier at all.
  if (declaresNameLocally(ctx.sourceFile, tag)) {
    const local = candidates.find((candidate) => candidate.node.name === tag);

    // Declared here, so the tag means this declaration — and it earns an edge
    // only if detection recognised it as a component.
    return local?.node.id;
  }

  const binding = importBindingFor(ctx.sourceFile, tag);
  if (binding === undefined) {
    return undefined;
  }

  return resolveExportedComponentId(
    ctx,
    binding.moduleSourceFile,
    binding.exportName,
    new Set<string>(),
    MAX_REEXPORT_HOPS,
  );
}

/**
 * Whether a module declares a name at its top level.
 *
 * Asked only after the component candidates have been searched, so a `true`
 * here means "declared, and not a component" — which is a reason to stop rather
 * than to look further afield.
 *
 * @param sourceFile The module to inspect.
 * @param name The name in question.
 * @returns `true` when the module declares it as a function, class or variable.
 */
function declaresNameLocally(sourceFile: SourceFile, name: string): boolean {
  return (
    sourceFile.getFunction(name) !== undefined ||
    sourceFile.getClass(name) !== undefined ||
    sourceFile.getVariableDeclaration(name) !== undefined
  );
}

/**
 * The import a locally-bound name came from, if it came from one.
 *
 * Handles the default import (`import Widget from './widget.js'` → the module's
 * `default` export) and named imports including aliases
 * (`import { Inner as Outer }` → the module's `Inner`). Type-only imports and
 * type-only specifiers are skipped, because a type is never a component.
 *
 * A namespace import (`import * as Ns`) is not handled on purpose: the only way
 * to render through one is a member-expression tag, which is out of scope.
 *
 * When the name *is* bound by an import whose module does not resolve, the
 * answer is `undefined` — the binding is known and it leads outside the
 * project, so there is nothing further to try.
 *
 * @param sourceFile The module the tag was written in.
 * @param name The locally-bound name.
 * @returns The module and the name to look for inside it, or `undefined`.
 */
function importBindingFor(sourceFile: SourceFile, name: string): ImportBinding | undefined {
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.isTypeOnly()) {
      continue;
    }

    // `import Widget from './widget.js'`
    if (declaration.getDefaultImport()?.getText() === name) {
      return bindingTo(declaration.getModuleSpecifierSourceFile(), DEFAULT_EXPORT_NAME);
    }

    // `import { Widget } from './widget.js'`, `import { Inner as Outer } from …`
    for (const specifier of declaration.getNamedImports()) {
      if (specifier.isTypeOnly()) {
        continue;
      }

      const boundName = specifier.getAliasNode()?.getText() ?? specifier.getName();
      if (boundName !== name) {
        continue;
      }

      return bindingTo(declaration.getModuleSpecifierSourceFile(), specifier.getName());
    }
  }

  return undefined;
}

/**
 * Pairs a resolved module with the export name to look up in it, or reports
 * that the module did not resolve.
 *
 * @param moduleSourceFile The resolved module, or `undefined`.
 * @param exportName The name that module exports the component under.
 * @returns The binding, or `undefined` when the module did not resolve.
 */
function bindingTo(
  moduleSourceFile: SourceFile | undefined,
  exportName: string,
): ImportBinding | undefined {
  return moduleSourceFile === undefined ? undefined : { moduleSourceFile, exportName };
}

/**
 * The node id of the component a module exports under a given name, following
 * re-exports when the module is a barrel.
 *
 * The walk, in order:
 *
 * 1. **Refuse a file the indexer will not visit.** A resolved module under
 *    `node_modules`, a build output directory or a declaration file gets no
 *    node from anyone, so an edge into it would be dropped as `dangling-edge`;
 *    the two predicates from `../project.ts` are the rules the project loader
 *    bounded its file set with (see {@link indexableTargetPath}).
 * 2. **Look for the declaration here.** The module's own components are
 *    detected with the same function that detected this file's, which is what
 *    makes the id byte-identical to the one the target file's own visit emits.
 *    `'default'` matches by {@link ComponentNodeData.isDefaultExport} rather
 *    than by name, so an anonymous default export is found too.
 * 3. **Follow re-exports.** `export { Widget } from './widget.js'` and
 *    `export { default as Widget } from './widget.js'` each continue with the
 *    *original* name — which is why a `default as` alias never becomes the
 *    target node's name — and a bare `export * from './widget.js'` continues
 *    with the same name. A star re-export never re-exports a default, so it is
 *    not followed for one.
 *
 * Bounded twice over: at most {@link MAX_REEXPORT_HOPS} hops, and a
 * `file#name` visited set, so a barrel that re-exports itself terminates
 * instead of recursing. Explicit named re-exports are tried before star
 * re-exports because that is the precedence the language gives them.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param moduleSourceFile The module to look in.
 * @param exportName The export name to look for, possibly `'default'`.
 * @param visited The `file#name` pairs already attempted on this walk.
 * @param hopsLeft How many further re-export hops are permitted.
 * @returns The target node id, or `undefined`.
 */
function resolveExportedComponentId(
  ctx: ExtractorContext,
  moduleSourceFile: SourceFile,
  exportName: string,
  visited: Set<string>,
  hopsLeft: number,
): string | undefined {
  const file = indexableTargetPath(ctx, moduleSourceFile);
  if (file === undefined) {
    return undefined;
  }

  const attempt = `${file}#${exportName}`;
  if (visited.has(attempt)) {
    return undefined;
  }
  visited.add(attempt);

  // Diagnostics from another file are that file's to report on its own visit;
  // collecting them here would duplicate them in the index.
  const candidates = collectCandidates(moduleSourceFile, file, []);
  const declared = candidates.find((candidate) => matchesExportName(candidate, exportName));
  if (declared !== undefined) {
    return declared.node.id;
  }

  if (hopsLeft <= 0) {
    return undefined;
  }

  const starModules: SourceFile[] = [];

  for (const declaration of moduleSourceFile.getExportDeclarations()) {
    if (declaration.isTypeOnly()) {
      continue;
    }

    const target = declaration.getModuleSpecifierSourceFile();
    if (target === undefined) {
      continue;
    }

    // `export * from './widget.js'` — deferred until the explicit specifiers
    // below have had their turn. `export * as Ns from …` exposes a namespace
    // rather than the names themselves, and a namespace can only be rendered
    // through a member-expression tag, so it is not a star re-export here.
    if (declaration.isNamespaceExport()) {
      if (declaration.getNamespaceExport() === undefined) {
        starModules.push(target);
      }

      continue;
    }

    for (const specifier of declaration.getNamedExports()) {
      if (specifier.isTypeOnly()) {
        continue;
      }

      const exposedName = specifier.getAliasNode()?.getText() ?? specifier.getName();
      if (exposedName !== exportName) {
        continue;
      }

      const resolved = resolveExportedComponentId(
        ctx,
        target,
        specifier.getName(),
        visited,
        hopsLeft - 1,
      );

      if (resolved !== undefined) {
        return resolved;
      }
    }
  }

  // A star re-export carries every *named* export of its target and never the
  // target's default export.
  if (exportName !== DEFAULT_EXPORT_NAME) {
    for (const target of starModules) {
      const resolved = resolveExportedComponentId(ctx, target, exportName, visited, hopsLeft - 1);

      if (resolved !== undefined) {
        return resolved;
      }
    }
  }

  return undefined;
}

/**
 * Whether a detected component is the one a module exports under a given name.
 *
 * `'default'` is answered from {@link ComponentNodeData.isDefaultExport}, which
 * covers the inline keyword, `export { Widget as default }` and
 * `export default Widget` alike; any other name is answered by the declared
 * name, because that is what the naming rule records.
 *
 * @param candidate A detected component.
 * @param exportName The export name being resolved.
 * @returns `true` when the candidate is that export.
 */
function matchesExportName(candidate: ComponentCandidate, exportName: string): boolean {
  if (exportName === DEFAULT_EXPORT_NAME) {
    return candidate.node.data.isDefaultExport;
  }

  return candidate.node.name === exportName;
}

/**
 * The project-relative POSIX path of a resolved module, provided the indexer
 * will visit it.
 *
 * Four conditions, each of which would otherwise produce an edge into a node
 * nobody emits: the module must be inside the project, its path must satisfy
 * the same refinement every stored path does, it must be an indexable file
 * (which excludes a `.d.ts` declaration file), and it must not sit under one of
 * the generated or vendored directories the project loader excludes.
 *
 * The check mirrors the loader's **default** rules rather than consulting the
 * loaded file list, so it costs a few string operations instead of a scan per
 * resolution, and it needs no cached state — this extractor keeps none. The one
 * rule it cannot see is a caller's `extraExcludes`, which
 * {@link ExtractorContext} does not carry; a module excluded only by that would
 * still be refused by `../graph/graph.ts`, as a dropped edge with a
 * `dangling-edge` diagnostic rather than a wrong one.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param moduleSourceFile The resolved module.
 * @returns Its project-relative path, or `undefined` when it is out of bounds.
 */
function indexableTargetPath(
  ctx: ExtractorContext,
  moduleSourceFile: SourceFile,
): string | undefined {
  const absolutePath = moduleSourceFile.getFilePath();
  const file = ctx.loaded.projectRelative(absolutePath);

  if (file === undefined || !isSafeRelativePath(file)) {
    return undefined;
  }

  if (!isIndexableFile(file) || shouldExcludePath(ctx.projectRoot, absolutePath)) {
    return undefined;
  }

  return file;
}

/* -------------------------------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * The diagnostic for one construct this extractor could not read.
 *
 * `extractor-failed` is the code, because that is the one the vocabulary
 * reserves for "an extractor could not do its job here" and this extractor is
 * named in {@link IndexDiagnostic.extractorId}. It is deliberately **not**
 * `unresolved-import`: `../graph/types.ts` assigns that code to the import
 * extractor and gives every code exactly one emitter, which is what makes a
 * diagnostic attributable — and an unresolvable component tag is in any case
 * not a finding, it is the ordinary state of a component imported from a
 * package, so it produces no diagnostic at all.
 *
 * Severity is `warning` rather than `error`: the file still yielded everything
 * else, so the index is usable and merely incomplete at one position.
 *
 * The message names the syntax kind, the file and the 1-based position, and
 * quotes **nothing** — a diagnostic reaches logs, the session store and
 * possibly a model prompt, so the privacy constraint on
 * `INDEX_DIAGNOSTIC_CODES` applies in full.
 *
 * @param file The project-relative POSIX path of the file being extracted.
 * @param node The construct that could not be read.
 * @param cause Whatever was thrown.
 * @returns The diagnostic.
 */
function constructFailure(file: string, node: Node, cause: unknown): IndexDiagnostic {
  const position = safePositionOf(node);
  const where =
    position === undefined
      ? 'at an unknown position'
      : `at line ${position.line}, column ${position.column}`;

  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `${EXTRACTOR_ID} could not read a ${safeKindName(node)} ${where}; the rest of the file was indexed`,
    file,
    extractorId: EXTRACTOR_ID,
    detail: failureDetail(cause),
  };
}

/**
 * The diagnostic for a file the parser could not read in full, when there is
 * one.
 *
 * Detection is **syntactic only**: `getSyntacticDiagnostics` returns what the
 * *parser* recorded, so no type is resolved, no declaration file is loaded and
 * a project whose dependencies are not installed reports nothing here — which
 * is what keeps this honest with the extractor's AST-first contract. (The
 * program it asks is the same one ts-morph builds for the module resolution
 * this extractor already performs when it follows an import.)
 *
 * It matters because a parse error is the one case where "no component in this
 * file" may be wrong: the parser recovers by skipping, and a declaration inside
 * the skipped region is invisible to every walk above. One diagnostic per file
 * rather than one per error, because the finding is about the file.
 *
 * The count and the first position are reported; the parser's own messages are
 * **not**. They quote the source they choked on ("JSX element 'x' has no
 * corresponding closing tag"), and a diagnostic may not carry source text.
 *
 * Any failure of the check itself is silent: a missing diagnostic is a far
 * smaller problem than an extractor that fails while reporting a failure.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The diagnostic, or `undefined` when the file parsed cleanly.
 */
function syntaxFailure(ctx: ExtractorContext): IndexDiagnostic | undefined {
  const summary = syntaxErrorSummary(ctx);
  if (summary === undefined) {
    return undefined;
  }

  const { count, first } = summary;
  const where = first === undefined ? '' : ` from line ${first.line}, column ${first.column}`;
  const errors = count === 1 ? 'syntax error' : 'syntax errors';

  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `${EXTRACTOR_ID} read a file with ${count} ${errors}${where}; a component declared in an unparsed region would have been missed`,
    file: ctx.file,
    extractorId: EXTRACTOR_ID,
  };
}

/**
 * How many syntax errors a file has and where the first one is, or `undefined`
 * when it parsed cleanly or the question could not be asked.
 *
 * Separated from {@link syntaxFailure} so the query and the sentence it turns
 * into are each one thing, and so the `catch` covers exactly the calls that can
 * fail.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The summary, or `undefined`.
 */
function syntaxErrorSummary(ctx: ExtractorContext): SyntaxErrorSummary | undefined {
  try {
    const syntactic = ctx.loaded.project.getProgram().getSyntacticDiagnostics(ctx.sourceFile);
    if (syntactic.length === 0) {
      return undefined;
    }

    const start = syntactic[0]?.getStart();

    return {
      count: syntactic.length,
      first: start === undefined ? undefined : positionAt(ctx.sourceFile, start),
    };
  } catch {
    return undefined;
  }
}

/**
 * The diagnostic for a failure that cost the whole file rather than one
 * construct.
 *
 * Raised when gathering the module-wide facts itself threw, which leaves no
 * position to report and no partial output to keep.
 *
 * @param file The project-relative POSIX path of the file being extracted.
 * @param cause Whatever was thrown.
 * @returns The diagnostic.
 */
function fileFailure(file: string, cause: unknown): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `${EXTRACTOR_ID} could not index this file; no component was recorded for it`,
    file,
    extractorId: EXTRACTOR_ID,
    detail: failureDetail(cause),
  };
}

/**
 * What can safely be said about a thrown value.
 *
 * The error's **type name only**. A thrown message is not safe to repeat here:
 * an abstract-syntax-tree library routinely embeds the text of the node it
 * choked on in its message, and that text is the developer's source, which a
 * diagnostic may never carry (see {@link constructFailure}).
 *
 * @param cause Whatever was thrown.
 * @returns A short, quote-free description of its type.
 */
function failureDetail(cause: unknown): string {
  if (cause instanceof Error) {
    return `threw ${cause.name}`;
  }

  return `threw a non-error value of type ${typeof cause}`;
}

/**
 * The syntax kind of a node, or a placeholder when even that cannot be read.
 *
 * A syntax kind name is a fixed vocabulary word (`FunctionDeclaration`,
 * `JsxSelfClosingElement`) and never source text, so it is safe in a
 * diagnostic. The guard exists because this runs on the failure path, where
 * assuming any further call succeeds is how one failure becomes two.
 *
 * @param node The node in question.
 * @returns Its syntax kind name, or `'construct'`.
 */
function safeKindName(node: Node): string {
  try {
    return node.getKindName();
  } catch {
    return 'construct';
  }
}

/**
 * The position of a node, or `undefined` when it cannot be computed.
 *
 * The failure-path counterpart of {@link positionOf}, for the reason given on
 * {@link safeKindName}.
 *
 * @param node The node in question.
 * @returns Its 1-based position, or `undefined`.
 */
function safePositionOf(node: Node): Position | undefined {
  try {
    return positionOf(node);
  } catch {
    return undefined;
  }
}
