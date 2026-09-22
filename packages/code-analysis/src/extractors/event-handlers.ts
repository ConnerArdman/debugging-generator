/**
 * `event-handlers` — the event-handler extractor of `@debuggen/code-analysis`.
 *
 * One of the per-file extractors `../indexer.ts` runs over every indexable
 * module of a target project. It owns exactly two pieces of the code graph's
 * vocabulary (`../graph/types.ts`):
 *
 * - the **`handler` node kind** — one node per event handler bound in markup,
 *   carrying the required {@link HandlerNodeData} payload (`event`, `boundTo`,
 *   `inline`); and
 * - the **`handles` edge kind** — `component → handler`, directed from the
 *   component whose markup binds the handler to the handler itself.
 *
 * Nothing else. In particular it emits **no `file` node** (that anchor belongs
 * to the import extractor, and a second producer of it would cost a
 * `duplicate-node-id` diagnostic), **no `component` node** (the component
 * extractor declares those; this module only *names* them, see below), **no
 * `symbol` node** for the handler's declaration, **no `calls` edge** for
 * anything the handler body reaches (the api-call and db-call extractors own
 * those) and **no `references` edge** (a reference set is deepened on demand by
 * a `ReferenceResolver`, not at indexing time). It reads no other extractor's
 * output: every extractor is handed the same {@link ExtractorContext} and
 * produces its fragment independently, so this one re-derives what it needs
 * from the syntax tree rather than consuming a sibling's nodes.
 *
 * ## Who reads what this produces
 *
 * - A `handler` node is where a **user interaction enters the application's own
 *   code**, so it is the head of the cross-tier chain `./query.ts`'s
 *   `pathBetween` walks — client component → named handler → literal fetch →
 *   route handler → server function → database call. The `handles` edge is the
 *   first hop of that chain and its direction is load-bearing: `from` is
 *   reliably the *component*.
 * - The service's progress view says "Traced event handler" from these nodes
 *   (AAP 0.7.1 Group 2), and `./query.ts`'s handler-facing lookups match on
 *   {@link CodeNodeBase.name}, which is why the name is the source spelling and
 *   never a prettified form.
 * - `packages/instrumentation`'s feasibility check asks whether a handler can
 *   carry function-level timing. {@link HandlerNodeData.inline} is the answer —
 *   an inline arrow has no named declaration to wrap — and for a named handler
 *   {@link CodeNodeBase.symbol} is the function to look for while
 *   `file`/`line`/`column`/`endLine` bound the declaration a patch would
 *   rewrite.
 * - Click-to-source takes the `code-graph` route of AAP 0.4.2. A node carries
 *   its position as the `file`/`line`/`column`/`endLine` fields
 *   {@link CodeNodeBase} declares and **not** as a `SourceLocation`: the node
 *   vocabulary has no such field, and re-declaring a shape that already exists
 *   in `@debuggen/shared` is what `../graph/types.ts` forbids. A consumer that
 *   needs one mints it from those fields with `resolvedBy: 'code-graph'` and the
 *   matching entry of `DEFAULT_RESOLUTION_CONFIDENCE`; `file` is already refined
 *   by `isSafeRelativePath` here, so no second sanitisation is needed there.
 *
 * ## What counts as a handler, and where its node is positioned
 *
 * The rule is the **shape of the markup property**, never a list of event
 * names: an attribute whose name matches `/^on[A-Z]/` binds a handler, and the
 * event is that name with `on` removed and its first character lower-cased
 * (`onClick` → `click`, `onKeyDown` → `keyDown`). A `Capture` suffix names the
 * phase rather than the event, so it is stripped (`onClickCapture` → `click`)
 * as long as something remains; {@link HandlerNodeData} has no field for the
 * phase, so the capture form is normalised away rather than recorded. Keying on
 * the shape is what lets a project's custom component prop (`onSelect`) be
 * found by the same code that finds `onClick`, and what keeps any application's
 * vocabulary out of this module (AAP 0.5.4).
 *
 * Two binding styles are distinguished, and the distinction is the point of the
 * extractor because it decides both what can be instrumented and where
 * click-to-source lands:
 *
 * - **Named, bound by reference** (`onClick={handleSubmit}`,
 *   `onClick={this.onPress}`, `onClick={props.onSelect}`) — `inline` is
 *   `false`, the node's name and {@link CodeNodeBase.symbol} are the function's
 *   name, and the node is positioned at **the handler's own declaration**,
 *   resolved through the enclosing scopes of the use site and, for an imported
 *   binding, into the module it comes from. An editor opening this node lands on
 *   the function, which is what a developer asked for when they clicked an
 *   interaction. Where resolution reaches a declaration, the name is the
 *   **declaration's** identifier rather than the local one — an
 *   `import { onSubmit as submit }` alias is a fact about the importing module,
 *   and a node positioned in a file is named as that file names it, which is also
 *   what keeps one function to one node across every module that binds it.
 * - **Inline** (`onClick={() => …}`, `onClick={function () {}}`) — `inline` is
 *   `true`, the node is positioned at the function expression itself, and its
 *   name is the property as written, which is the "derived label"
 *   {@link CodeNodeBase.name} allows for a handler with no declaration of its
 *   own. {@link CodeNodeBase.symbol} is **absent**: there is no function to look
 *   for, and the component that owns the arrow is already reachable through the
 *   `handles` edge.
 *
 * A call expression (`onClick={makeHandler(id)}`) is neither of those two
 * shapes: what it evaluates to is a value question, not a syntactic one.
 * {@link HandlerNodeData} declares no third style, so it is classified as
 * named-by-reference to the **called** identifier, which is the name a
 * developer would search for; the imprecision is that the node describes the
 * factory rather than the function it returns, and it is recorded here rather
 * than guessed at by a consumer. The one call looked *through* instead of at is
 * `fn.bind(…)`: the language says the result is that function, so
 * `onClick={this.handleSelect.bind(this)}` describes the method and not the
 * standard-library builtin.
 *
 * ## Identity: one node per handler, one edge per binding
 *
 * `makeNodeId` derives a node's identity from its kind, file, name and
 * position, so **a named handler bound to several props or elements yields one
 * node** — the declaration is one function and its position is one place — and
 * each binding site contributes its own `handles` edge, whose id carries that
 * site's line and column. That is the de-duplication this module chose of the
 * two the graph permits, and it is applied inside one file's result as well, so
 * `../graph/graph.ts` never has to drop a duplicate. The consequence worth
 * stating: where one function is bound to props naming *different* events, the
 * node records the first binding in source order and the others are represented
 * by their edges, because a node has one {@link HandlerNodeData.event} and the
 * function it describes is still one function. An inline handler is positioned
 * at its own expression, so two arrows on one line are two nodes.
 *
 * Two consequences of positioning a node at its declaration are worth stating
 * outright, because they are unusual for a per-file extractor:
 *
 * - A node's `file` is **not always the file under extraction**. A handler
 *   imported from another module of the project is positioned in *that* module,
 *   which is where an editor should open it, while the `handles` edge's own
 *   `file` remains the markup's. Two files binding the same imported handler
 *   therefore produce the identical node, which `../graph/graph.ts` merges
 *   silently.
 * - Another extractor that wants to emit a `calls` edge **from** a handler — the
 *   shape `CODE_EDGE_KINDS` permits for "this handler is what issues the
 *   request" — must derive the handler's id by this same rule: the declared
 *   identifier of the resolved declaration, at that declaration's 1-based
 *   position, in the declaring file. Attributing the call to the enclosing
 *   function's own node instead is equally valid and needs no coordination; what
 *   does not work is guessing a third spelling of the handler's id.
 *
 * ## The component-naming rule, shared with `./react-components.ts`
 *
 * A `handles` edge points at a `component` node **that module declares**, and
 * `makeNodeId` is injective, so the component's kind, file, name and position
 * must be derived here exactly as they are derived there. The rule below is
 * therefore a copy that must stay **byte-for-byte equivalent** to
 * `./react-components.ts`'s — an id that differs in one character is not a
 * slightly wrong edge, it is an edge `../graph/graph.ts` drops as
 * `dangling-edge`, which silently deletes the path from an interaction to the
 * component it happened in:
 *
 * 1. A component is a **module-level** function declaration, class declaration
 *    with a JSX-producing `render` method, or variable declarator initialised
 *    with an arrow, a function expression or a `memo`/`forwardRef` wrapper
 *    around one, whose name begins with an uppercase letter (or which is an
 *    anonymous default export) and which produces JSX in a returned position.
 * 2. `name` is the **declared identifier**; for a truly anonymous default
 *    export it is the file's basename without its extension.
 * 3. The position is the **1-based line and column of the identifier**, or of
 *    the declaration itself when there is none.
 *
 * Detection is re-implemented rather than imported on purpose: an extractor may
 * not depend on a sibling (see the module-graph note below), and per-file purity
 * is what lets the indexer run the set in any order.
 *
 * A handler bound in markup that sits **outside** every module-level component
 * — a fragment returned by a helper function, a constant holding an element —
 * still earns its node, and simply no edge. That is not a failure and carries no
 * diagnostic: there is no component to point at, and inventing one would be
 * worse than recording the handler alone.
 *
 * ## Abstract-syntax-tree first, no type resolution
 *
 * Detection and resolution read syntax and nothing else: property-name shape,
 * expression kind, the declarations a scope contains, the React API names
 * `memo` and `forwardRef`. No type is consulted, no symbol is resolved through
 * the checker, and no expression is evaluated, so a target project whose
 * dependencies are not installed — the ordinary state of a project being
 * indexed for the first time, and the deliberate state of this package's own
 * corpus — is indexed exactly as fully as one whose `node_modules` is warm. The
 * one resolution step is module resolution, by design: a handler imported from
 * another module of the same project is positioned at its declaration *there*,
 * which needs `getModuleSpecifierSourceFile()` and nothing more.
 *
 * ## Deliberately out of scope for v1
 *
 * - **Imperative listeners.** `addEventListener('click', fn)` call sites are not
 *   handlers in this graph: no invariant depends on them, the runtime
 *   interaction hook of `packages/telemetry` observes the resulting events
 *   anyway, and a call site that merely *mentions* an event name is not a
 *   binding a component owns. They are ignored gracefully — no node, no
 *   diagnostic.
 * - **Spread attributes** (`<button {...handlers} />`), whose property names are
 *   not visible in the markup at all.
 * - **Conditional and logical bindings** (`onClick={ready ? a : b}`), which name
 *   two handlers or none, and **element-access bindings**
 *   (`onClick={handlers[key]}`), which name nothing a developer could search
 *   for. Both yield no node: a node naming one of two candidates, or named after
 *   a subscript, would be a guess rather than evidence.
 * - **Receivers other than `this`** (`onClick={props.onSelect}`,
 *   `onClick={lib.handlers.click}`), whose members are a value question. The
 *   node *is* emitted — the binding exists and the property names it — but it is
 *   positioned at its binding site and carries the diagnostic described below.
 * - **Re-export chains.** A handler imported through a barrel that re-exports it
 *   is resolved only if the imported module declares it; a further hop is not
 *   followed, and the node falls back to its binding site.
 * - **Parse failures.** A region the parser skipped is invisible to every walk
 *   here, as it is to every other extractor; the file-level finding is reported
 *   once by the component extractor rather than repeated by each of them.
 *
 * ## Failure tolerance and determinism
 *
 * {@link eventHandlersExtractor.extract} never throws. One malformed construct
 * becomes one `extractor-failed` {@link IndexDiagnostic} — severity `warning`,
 * this extractor's id, the file and the 1-based position, and **no source
 * text**, per the privacy constraint on `INDEX_DIAGNOSTIC_CODES` — while every
 * other binding in the file still yields its node and its edge. A named handler
 * whose declaration cannot be located earns a **low-severity** (`info`)
 * diagnostic under the same code: the node exists and is usable, it is merely
 * positioned at the binding site instead of at a declaration. `unresolved-import`
 * is deliberately not borrowed for that — `../graph/types.ts` assigns it to the
 * import extractor and gives every code exactly one emitter.
 *
 * Emission is in source order — every node, then every edge — and every value
 * is derived from the syntax tree alone, so two runs over unchanged source
 * serialise byte-identically.
 *
 * ## Position in the module graph
 *
 * Imports `@debuggen/shared` (the sole `@debuggen/*` dependency this package
 * may have, per AAP 0.2.2 and the `no-restricted-imports` layering block of
 * `eslint.config.js`), `ts-morph`, `../graph/graph.js` for the two id
 * constructors, `../graph/types.js` for the vocabulary, and `../project.js` for
 * the two predicates that decide whether a resolved file is one the indexer will
 * visit. It must never import `../indexer.js`, `../graph/query.js`,
 * `../summary.js`, `../route-map.js`, `../cache.js`, `../search/*`,
 * `../source-map/*` or a sibling extractor — including `./react-components.ts`,
 * whose naming rule is copied above precisely because importing it is not an
 * option.
 *
 * @packageDocumentation
 */

import { basenamePosix, extnamePosix, isSafeRelativePath } from '@debuggen/shared';
import { Node } from 'ts-morph';

import { makeEdgeId, makeNodeId } from '../graph/graph.js';
import { isIndexableFile, shouldExcludePath } from '../project.js';

import type {
  ClassDeclaration,
  ClassExpression,
  FunctionDeclaration,
  JsxAttribute,
  JsxOpeningElement,
  JsxSelfClosingElement,
  ParameterDeclaration,
  SourceFile,
  Statement,
  VariableDeclaration,
  VariableStatement,
} from 'ts-morph';

import type {
  CodeEdge,
  CodeNodeOf,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  HandlerNodeData,
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
const EXTRACTOR_ID = 'event-handlers';

/**
 * The shape of a markup property that binds an event handler: `on` followed by
 * an uppercase letter.
 *
 * **The whole detection rule, and deliberately not a list of event names.** A
 * closed list would recognise `onClick` and miss a project's own `onSelect`, and
 * an application's vocabulary has no place in this package (AAP 0.5.4). The
 * uppercase requirement is what keeps `once` or `only` — ordinary property names
 * that merely start with the same two letters — out.
 */
const EVENT_PROP_PATTERN = /^on[A-Z]/;

/**
 * The prefix {@link EVENT_PROP_PATTERN} matches, removed to obtain the event
 * name.
 */
const EVENT_PROP_PREFIX = 'on';

/**
 * The suffix that names the *phase* a listener is attached in rather than the
 * event it listens for.
 *
 * Stripped so `onClickCapture` and `onClick` report the same
 * {@link HandlerNodeData.event}, which is what makes the graph's vocabulary the
 * runtime's. {@link HandlerNodeData} declares no field for the phase, so the
 * distinction is normalised away rather than recorded — see the header.
 */
const CAPTURE_PHASE_SUFFIX = 'Capture';

/**
 * The export name a default export is known by, in an import binding as well as
 * in a declaration.
 */
const DEFAULT_EXPORT_NAME = 'default';

/**
 * The language's own re-binding method, looked through when it is called on a
 * handler.
 *
 * `onClick={this.handleSelect.bind(this)}` is one of the two canonical ways a
 * class component binds an instance method, and `Function.prototype.bind`
 * returns *that* function with a bound receiver — so the handler the markup
 * means is the method, not the builtin. Looking through it is language
 * semantics, matched by name exactly as {@link COMPONENT_WRAPPER_NAMES} are, and
 * the alternative is a node named after a standard-library method, which would
 * tell a developer nothing.
 */
const BIND_METHOD_NAME = 'bind';

/**
 * The identifier that denotes the absence of a value.
 *
 * `onClick={undefined}` is how a conditional binding is written when the
 * condition is false, and it binds no handler at all. Without this the global
 * would be recorded as a handler named after itself and would earn an
 * unresolved-declaration diagnostic for a binding that was never there.
 */
const UNDEFINED_IDENTIFIER = 'undefined';

/**
 * The method a class component renders from, part of the copied component rule.
 */
const RENDER_METHOD_NAME = 'render';

/**
 * The React API names a component declaration may be wrapped in, part of the
 * copied component rule.
 *
 * Matched by **name only**, bare (`memo(…)`) or qualified (`React.memo(…)`), so
 * the check works in a project whose dependencies are not installed.
 */
const COMPONENT_WRAPPER_NAMES: readonly string[] = Object.freeze(['memo', 'forwardRef']);

/**
 * How many nested wrapper calls are unwrapped before a declaration is judged not
 * to be a component. `memo(forwardRef(fn))` is the canonical two-level form.
 */
const MAX_WRAPPER_DEPTH = 4;

/**
 * How many transparent expressions — parentheses, `as`, `satisfies` and
 * non-null assertions — are peeled off a binding before classification gives
 * up.
 *
 * Bounded for the same reason {@link MAX_WRAPPER_DEPTH} is: none of these forms
 * changes what is bound, and a generated expression must not be able to drive
 * the peeling arbitrarily deep.
 */
const MAX_UNWRAP_DEPTH = 4;

/**
 * The nodes of a file that binds no handler, shared and frozen so the common
 * case allocates nothing.
 */
const EMPTY_NODES: readonly CodeNodeOf<'handler'>[] = Object.freeze([]);

/**
 * The edges of a file whose handlers sit outside every component, for the reason
 * given on {@link EMPTY_NODES}.
 */
const EMPTY_EDGES: readonly CodeEdge[] = Object.freeze([]);

/**
 * The result of a file this extractor found nothing in: no node, no edge and —
 * per {@link ExtractorResult.diagnostics}, which is absent rather than empty for
 * a clean extraction — no diagnostics field.
 */
const EMPTY_RESULT: ExtractorResult = Object.freeze({
  nodes: EMPTY_NODES,
  edges: EMPTY_EDGES,
});

/**
 * The component anchors of a file that declares no component, shared for the
 * same reason as {@link EMPTY_NODES}. Declared before its uses so no call site
 * reads it in its initialisation window.
 */
const EMPTY_ANCHORS: readonly ComponentAnchor[] = Object.freeze([]);

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
 * One module-level component of the file under extraction, reduced to what a
 * `handles` edge needs: the id `./react-components.ts` will emit for it, and the
 * character range of its declaration.
 *
 * The range is how the enclosing component of a binding is found. Module-level
 * declarations cannot nest, so at most one range contains a given position; the
 * narrowest match is taken anyway, which costs nothing and cannot be wrong.
 */
interface ComponentAnchor {
  /** The component node id, derived by the copied naming rule. */
  readonly id: string;

  /** The zero-based character offset the declaration starts at. */
  readonly start: number;

  /** The zero-based character offset the declaration ends at. */
  readonly end: number;
}

/**
 * Where a handler node sits, and how far its declaration extends.
 *
 * `file` is project-relative POSIX and is **not** always the file under
 * extraction: an imported handler is positioned in the module that declares it.
 */
interface HandlerPlacement {
  /** The declaring file: project-relative, POSIX separators. */
  readonly file: string;

  /** The 1-based line of the declaration, or of the binding site when unresolved. */
  readonly line: number;

  /** The 1-based column, on the same terms as {@link HandlerPlacement.line}. */
  readonly column: number;

  /** The last line of the declaration, never less than {@link HandlerPlacement.line}. */
  readonly endLine: number;
}

/**
 * A resolved declaration: where it is, and whether its module exports it.
 *
 * `exported` is only knowable once the declaration itself has been found, which
 * is why it is not part of {@link HandlerPlacement}: an unresolved handler has
 * no export status to report, and reporting `false` for one would be a claim
 * rather than an observation.
 */
interface ResolvedDeclaration extends HandlerPlacement {
  /**
   * Whether the declaration carries an export keyword in its own module.
   *
   * `false` for a handler declared inside a component body, which is the
   * ordinary shape — and decisive for `packages/instrumentation`, which can only
   * reason about a symbol another module can reach.
   */
  readonly exported: boolean;

  /**
   * The identifier the declaration itself is written under, when it has one.
   *
   * Not always the name at the binding site: `import { onSubmit as submit }`
   * binds one name locally and declares another in the module it came from, and
   * it is the **declaration's** name that belongs on the node — a function is
   * one function however many modules import it, and a node positioned in a file
   * ought to be named as that file names it. `undefined` for a declaration with
   * no identifier at all (an anonymous default export) or one named by something
   * other than an identifier (a computed class member), in which case the name
   * written at the binding site is what the node falls back to.
   */
  readonly declaredName: string | undefined;
}

/**
 * What a named binding points at, as far as syntax can say.
 *
 * Three cases, because they are resolved three different ways: an identifier is
 * looked up in the enclosing scopes and then in the module's imports, a
 * `this.member` reference is looked up in the enclosing class, and anything else
 * is opaque — a receiver whose members are a value question this extractor does
 * not ask.
 */
type NamedReference =
  | { readonly kind: 'identifier'; readonly site: Node }
  | { readonly kind: 'this-member'; readonly member: string; readonly site: Node }
  | { readonly kind: 'opaque' };

/**
 * The classification of one binding: the two styles
 * {@link HandlerNodeData.inline} distinguishes.
 *
 * A discriminated union rather than a flag plus optional fields, so the branch
 * that builds an inline node cannot read a name that only a named binding has.
 */
type HandlerBinding =
  | { readonly inline: true; readonly fn: Node }
  | { readonly inline: false; readonly name: string; readonly reference: NamedReference };

/**
 * Everything {@link handlerNode} needs to build one node.
 *
 * `symbol` and `exported` are `string | undefined` and `boolean | undefined`
 * here rather than optional properties: the draft is internal, and carrying the
 * absence explicitly is what lets the single constructor decide which of the
 * three concrete node shapes to emit under `exactOptionalPropertyTypes`.
 */
interface HandlerNodeDraft {
  /** The node's name: the referenced function, or the property as written. */
  readonly name: string;

  /** Where the node sits. */
  readonly placement: HandlerPlacement;

  /** The function to look for, for a named binding; `undefined` for an inline one. */
  readonly symbol: string | undefined;

  /** The declaration's export status, when it was resolved. */
  readonly exported: boolean | undefined;

  /** The required payload. */
  readonly data: HandlerNodeData;
}

/* -------------------------------------------------------------------------------------------------
 * The extractor
 * ---------------------------------------------------------------------------------------------- */

/**
 * The event-handler extractor: `handler` nodes and `handles` edges for one file.
 *
 * Registered in `../indexer.ts`'s default extractor set. Synchronous and
 * side-effect-free, as {@link Extractor} requires: it reads the syntax tree,
 * never mutates a node, never writes a file and never performs I/O beyond the
 * module resolution ts-morph does on its behalf.
 *
 * @example
 * ```ts
 * const result = eventHandlersExtractor.extract(ctx);
 * for (const node of result.nodes) {
 *   // node.kind === 'handler', node.data.event, node.data.boundTo, node.data.inline
 * }
 * ```
 */
export const eventHandlersExtractor: Extractor = Object.freeze({
  id: EXTRACTOR_ID,

  extract(ctx: ExtractorContext): ExtractorResult {
    return extractEventHandlers(ctx);
  },
});

/**
 * Extracts every handler node and `handles` edge of one file.
 *
 * Three stages, in this order, so a failure in one costs only what it is about:
 * the file's module-level components are located (they are what an edge points
 * at), every event-binding attribute is collected in source order, and each
 * binding is turned into a node and — when it sits inside a component — an edge.
 *
 * Nodes are accumulated in a map keyed by node id, which is where the
 * de-duplication documented in the header happens: the first binding of a named
 * handler creates the node and every later binding of the same declaration
 * contributes only its edge.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The handler nodes, the `handles` edges, and any diagnostics.
 */
function extractEventHandlers(ctx: ExtractorContext): ExtractorResult {
  // `ExtractorContext.file` is produced by the indexer through
  // `LoadedProject.projectRelative`, so this can only fail if a caller built a
  // context by hand. It is checked anyway: every node's `file` must satisfy the
  // same refinement `SourceLocation` applies, or a graph node cannot become a
  // location a user interface opens (see `CodeNodeBase.file`).
  if (!isSafeRelativePath(ctx.file)) {
    ctx.logger.warn('event-handler extraction skipped: the file path is not project-relative', {
      extractorId: EXTRACTOR_ID,
    });

    return EMPTY_RESULT;
  }

  const diagnostics: IndexDiagnostic[] = [];
  const nodes = new Map<string, CodeNodeOf<'handler'>>();
  const edges: CodeEdge[] = [];

  let anchors: readonly ComponentAnchor[] = EMPTY_ANCHORS;
  let attributes: readonly JsxAttribute[] = [];

  try {
    anchors = collectComponentAnchors(ctx.sourceFile, ctx.file, diagnostics);
    attributes = eventAttributesWithin(ctx.sourceFile);
  } catch (cause) {
    diagnostics.push(fileFailure(ctx.file, cause));
  }

  for (const attribute of attributes) {
    try {
      appendHandler(ctx, anchors, attribute, nodes, edges, diagnostics);
    } catch (cause) {
      // One unreadable binding costs its own node and edge; every other binding
      // in the file still produces both.
      diagnostics.push(constructFailure(ctx.file, attribute, cause));
    }
  }

  const collected = nodes.size === 0 ? EMPTY_NODES : [...nodes.values()];
  const collectedEdges = edges.length === 0 ? EMPTY_EDGES : edges;

  // `diagnostics` is absent rather than empty for a clean extraction, which is
  // what `ExtractorResult` documents and what lets the indexer concatenate
  // without a guard.
  return diagnostics.length === 0
    ? { nodes: collected, edges: collectedEdges }
    : { nodes: collected, edges: collectedEdges, diagnostics };
}

/* -------------------------------------------------------------------------------------------------
 * Binding discovery
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every markup attribute of one file whose name has the event-property shape, in
 * source order.
 *
 * Collected into an array before anything is classified, so the per-binding
 * failure handling above cannot interfere with the traversal and the order of
 * emission is unmistakably source order. A namespaced attribute name
 * (`<use xlink:href … />`) is not an identifier and can never have the shape, so
 * it is filtered here rather than in every branch below; a spread attribute
 * exposes no property name at all and is out of scope (see the header).
 *
 * @param sourceFile The module to inspect.
 * @returns The event-binding attributes, in source order.
 */
function eventAttributesWithin(sourceFile: SourceFile): readonly JsxAttribute[] {
  const attributes: JsxAttribute[] = [];

  sourceFile.forEachDescendant((node) => {
    if (Node.isJsxAttribute(node) && eventPropName(node) !== undefined) {
      attributes.push(node);
    }
  });

  return attributes;
}

/**
 * The attribute's property name when it binds an event handler, or `undefined`.
 *
 * @param attribute One markup attribute.
 * @returns The property name as written, or `undefined` when the attribute is
 * not an event binding.
 */
function eventPropName(attribute: JsxAttribute): string | undefined {
  const nameNode = attribute.getNameNode();

  // `<Widget onSelect={…} />` — an identifier. The alternative,
  // `<use xlink:href="…" />`, is a namespaced name and never a handler prop.
  if (!Node.isIdentifier(nameNode)) {
    return undefined;
  }

  const name = nameNode.getText();

  return EVENT_PROP_PATTERN.test(name) ? name : undefined;
}

/**
 * The event name a property name denotes: the prefix removed, the first
 * character lower-cased, a capture-phase suffix dropped.
 *
 * `onClick` → `click`, `onKeyDown` → `keyDown`, `onClickCapture` → `click`. The
 * suffix is dropped only while something remains, so a property literally named
 * `onCapture` reports the event `capture` rather than an empty string.
 *
 * The lower-casing is done over the first **code point** rather than the first
 * UTF-16 unit, so a property name outside the Basic Multilingual Plane is not
 * cut in half.
 *
 * @param propName The property name as written, already known to match
 * {@link EVENT_PROP_PATTERN}.
 * @returns The event name for {@link HandlerNodeData.event}.
 */
function eventNameFrom(propName: string): string {
  const withoutPrefix = propName.slice(EVENT_PROP_PREFIX.length);
  const withoutPhase =
    withoutPrefix.length > CAPTURE_PHASE_SUFFIX.length &&
    withoutPrefix.endsWith(CAPTURE_PHASE_SUFFIX)
      ? withoutPrefix.slice(0, withoutPrefix.length - CAPTURE_PHASE_SUFFIX.length)
      : withoutPrefix;

  const first = withoutPhase.codePointAt(0);
  if (first === undefined) {
    return withoutPhase;
  }

  const initial = String.fromCodePoint(first);

  return initial.toLowerCase() + withoutPhase.slice(initial.length);
}

/* -------------------------------------------------------------------------------------------------
 * From a binding to a node and an edge
 * ---------------------------------------------------------------------------------------------- */

/**
 * Turns one event-binding attribute into a node — new or already present — and,
 * when the markup sits inside a module-level component, a `handles` edge.
 *
 * Four ways a binding yields nothing, none of them an error:
 *
 * - the property name is not an event binding after all (the collector already
 *   filtered those, and the check is repeated because this function is the one
 *   that must not assume);
 * - the attribute is not inside an opening or self-closing element, which a
 *   well-formed tree cannot produce and a partially-parsed one can;
 * - the attribute has no expression to bind (`<button onClick />`,
 *   `onClick="text"`, `onClick={}`); or
 * - the expression is neither a reference nor a function (see the header's
 *   out-of-scope list).
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param anchors The module-level components of this file.
 * @param attribute The event-binding attribute.
 * @param nodes Accumulator keyed by node id, which de-duplicates named handlers.
 * @param edges Accumulator appended in source order.
 * @param diagnostics Collector for this extractor's diagnostics.
 */
function appendHandler(
  ctx: ExtractorContext,
  anchors: readonly ComponentAnchor[],
  attribute: JsxAttribute,
  nodes: Map<string, CodeNodeOf<'handler'>>,
  edges: CodeEdge[],
  diagnostics: IndexDiagnostic[],
): void {
  const propName = eventPropName(attribute);
  if (propName === undefined) {
    return;
  }

  const element = enclosingJsxElement(attribute);
  if (element === undefined) {
    return;
  }

  const binding = classifyBinding(attribute);
  if (binding === undefined) {
    return;
  }

  const data: HandlerNodeData = {
    event: eventNameFrom(propName),
    // `<button …>` yields `button`, `<Widget …>` yields `Widget`, and a
    // member-expression tag yields its written text: the payload documents this
    // as "as written", and a developer matching a selected target against it
    // needs the spelling rather than a resolution.
    boundTo: element.getTagNameNode().getText(),
    inline: binding.inline,
  };

  const draft = binding.inline
    ? inlineDraft(ctx, propName, binding.fn, data)
    : namedDraft(ctx, attribute, binding.name, binding.reference, data, diagnostics);

  const node = handlerNode(draft);
  const existing = nodes.get(node.id);

  // The first binding of a named handler declares the node; a later binding of
  // the same declaration contributes only its edge, so the graph never has to
  // drop a duplicate (see the header's identity note).
  if (existing === undefined) {
    nodes.set(node.id, node);
  }

  appendHandlesEdge(ctx, anchors, attribute, node.id, edges);
}

/**
 * The draft of an inline handler's node.
 *
 * Positioned at the function expression itself — there is nothing else to point
 * at — and named for the property as written, which is the derived label
 * {@link CodeNodeBase.name} allows. No `symbol`, because there is no function to
 * look for, and no `exported`, because an inline handler cannot be exported.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param propName The property name as written.
 * @param fn The arrow function or function expression bound to it.
 * @param data The payload, already computed.
 * @returns The draft.
 */
function inlineDraft(
  ctx: ExtractorContext,
  propName: string,
  fn: Node,
  data: HandlerNodeData,
): HandlerNodeDraft {
  return {
    name: propName,
    placement: placementOf(ctx.file, fn),
    symbol: undefined,
    exported: undefined,
    data,
  };
}

/**
 * The draft of a named handler's node, positioned at its declaration when one
 * can be found.
 *
 * When resolution fails the node is still produced — the binding exists, and a
 * handler the graph does not hold is a hole in every path through it — but it is
 * positioned at the attribute and the failure is recorded as a low-severity
 * diagnostic, so a consumer can tell "the declaration is here" from "the binding
 * is here and the declaration was not found".
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param attribute The binding site, used as the fallback position.
 * @param name The referenced function's name.
 * @param reference What the binding points at, syntactically.
 * @param data The payload, already computed.
 * @param diagnostics Collector for the unresolved-declaration finding.
 * @returns The draft.
 */
function namedDraft(
  ctx: ExtractorContext,
  attribute: JsxAttribute,
  referenceName: string,
  reference: NamedReference,
  data: HandlerNodeData,
  diagnostics: IndexDiagnostic[],
): HandlerNodeDraft {
  const resolved = resolveDeclaration(ctx, referenceName, reference);

  if (resolved !== undefined) {
    // An import alias is a fact about the importing module rather than about the
    // function: where resolution reached a declaration, that declaration's own
    // identifier is both the name and the symbol, so one function yields one node
    // however many modules bind it and under whatever local name.
    const name = resolved.declaredName ?? referenceName;

    return { name, placement: resolved, symbol: name, exported: resolved.exported, data };
  }

  diagnostics.push(unresolvedDeclaration(ctx.file, referenceName, safePositionOf(attribute)));

  return {
    name: referenceName,
    placement: placementOf(ctx.file, attribute),
    symbol: referenceName,
    exported: undefined,
    data,
  };
}

/**
 * Builds a handler node from a draft.
 *
 * The single place a `handler` node is constructed, and therefore the single
 * place its id is derived. Three concrete shapes are returned rather than one
 * object assembled conditionally, because `exactOptionalPropertyTypes` makes
 * "absent" and "present and undefined" different types and the three
 * combinations a draft can express are exactly these:
 *
 * - inline — no `symbol`, no `exported`;
 * - named but unresolved — a `symbol` to look for, no export status to report;
 * - named and resolved — both.
 *
 * `endLine` is clamped to at least `line` so a span is never inverted for a
 * declaration whose body was parsed from an unterminated construct.
 *
 * @param draft What the classification determined.
 * @returns The node.
 */
function handlerNode(draft: HandlerNodeDraft): CodeNodeOf<'handler'> {
  const { name, placement, data } = draft;
  const { file, line, column } = placement;
  const endLine = Math.max(placement.endLine, line);
  const id = makeNodeId({ kind: 'handler', file, name, line, column });

  if (draft.symbol === undefined) {
    return { id, kind: 'handler', name, file, line, column, endLine, data };
  }

  if (draft.exported === undefined) {
    return { id, kind: 'handler', name, file, line, column, endLine, symbol: draft.symbol, data };
  }

  return {
    id,
    kind: 'handler',
    name,
    file,
    line,
    column,
    endLine,
    exported: draft.exported,
    symbol: draft.symbol,
    data,
  };
}

/**
 * Appends the `handles` edge one binding implies, when the markup sits inside a
 * module-level component.
 *
 * The edge's *site* is the attribute: that is where the relationship is written,
 * and it is always in the file under extraction even when the handler it points
 * at is declared in another module. Its id carries that site, so one function
 * bound at several places yields one node and several distinct edges.
 *
 * Markup outside every component yields no edge and **no diagnostic**: there is
 * no component node to point at, and an edge naming one that nobody declares
 * would be dropped as `dangling-edge`.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param anchors The module-level components of this file.
 * @param attribute The binding site.
 * @param to The handler node's id.
 * @param edges The accumulator, appended in source order.
 */
function appendHandlesEdge(
  ctx: ExtractorContext,
  anchors: readonly ComponentAnchor[],
  attribute: JsxAttribute,
  to: string,
  edges: CodeEdge[],
): void {
  const from = enclosingComponentId(anchors, attribute.getStart());
  if (from === undefined) {
    return;
  }

  const position = positionOf(attribute);

  edges.push({
    id: makeEdgeId({ kind: 'handles', from, to, line: position.line, column: position.column }),
    kind: 'handles',
    from,
    to,
    file: ctx.file,
    line: position.line,
    column: position.column,
  });
}

/**
 * The opening or self-closing element an attribute belongs to.
 *
 * @param attribute The attribute in question.
 * @returns The element, or `undefined` when the attribute has no element
 * ancestor — which a well-formed tree cannot produce.
 */
function enclosingJsxElement(
  attribute: JsxAttribute,
): JsxOpeningElement | JsxSelfClosingElement | undefined {
  return attribute.getFirstAncestor(
    (node): node is JsxOpeningElement | JsxSelfClosingElement =>
      Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node),
  );
}

/**
 * The id of the module-level component whose declaration contains a position, or
 * `undefined` when the position is outside every one of them.
 *
 * The narrowest containing range wins. Module-level declarations cannot nest, so
 * there is normally only one; preferring the narrowest costs a comparison and
 * removes any dependence on the order the anchors were collected in.
 *
 * @param anchors The module-level components of this file.
 * @param offset A zero-based character offset inside the file.
 * @returns The component node id, or `undefined`.
 */
function enclosingComponentId(
  anchors: readonly ComponentAnchor[],
  offset: number,
): string | undefined {
  let best: ComponentAnchor | undefined;

  for (const anchor of anchors) {
    if (offset < anchor.start || offset > anchor.end) {
      continue;
    }

    if (best === undefined || anchor.end - anchor.start < best.end - best.start) {
      best = anchor;
    }
  }

  return best?.id;
}

/* -------------------------------------------------------------------------------------------------
 * Classification: named reference or inline function
 * ---------------------------------------------------------------------------------------------- */

/**
 * How one attribute binds its handler, or `undefined` when it binds nothing this
 * extractor can describe.
 *
 * The initializer must be a markup expression container with an expression in
 * it: `onClick` with no value is a boolean-shorthand property, `onClick="text"`
 * binds a string, and an empty container — braces holding nothing, or holding
 * only a comment — binds nothing. None of the three is a handler, and none is an
 * error.
 *
 * @param attribute The event-binding attribute.
 * @returns The classification, or `undefined`.
 */
function classifyBinding(attribute: JsxAttribute): HandlerBinding | undefined {
  const initializer = attribute.getInitializer();

  if (initializer === undefined || !Node.isJsxExpression(initializer)) {
    return undefined;
  }

  const expression = initializer.getExpression();

  return expression === undefined ? undefined : classifyExpression(expression, 0);
}

/**
 * Classifies the expression a binding holds, peeling transparent wrappers first.
 *
 * The branches, in the order they are tested, each naming the syntax it matches:
 *
 * 1. `(fn)`, `fn as T`, `fn satisfies T`, `fn!` — transparent: none of them
 *    changes what is bound, so the peeling continues, bounded by
 *    {@link MAX_UNWRAP_DEPTH}.
 * 2. `() => …` and `function () {}` — an inline function, with no declaration of
 *    its own to point at.
 * 3. `handleSubmit` — a named handler bound by reference, resolved through the
 *    enclosing scopes. The identifier `undefined` is the one exception: it binds
 *    no handler, so it yields nothing rather than a node named after itself.
 * 4. `this.onPress`, `props.onSelect`, `lib.handlers.click` — a named handler
 *    reached through a receiver. The property name is the handler's name;
 *    resolution is attempted only for a `this` receiver, because a class's
 *    members are syntax while another object's are a value.
 * 5. `makeHandler(id)` — a call. Classified as named-by-reference to the
 *    **called** name for the reason given in the header: there is no third
 *    binding style to put it in, and the called name is the one a developer
 *    searches for. The node therefore describes the factory, not the function it
 *    returns — except for `fn.bind(…)`, which {@link classifyCallee} looks
 *    through to `fn`.
 *
 * Anything else — a conditional, a logical expression, an element access, a
 * literal, an identifier-free expression — yields `undefined`: a node naming one
 * of two possible handlers, or naming none, would be a guess.
 *
 * @param expression The bound expression, or an inner expression during peeling.
 * @param depth How many transparent wrappers have already been peeled.
 * @returns The classification, or `undefined`.
 */
function classifyExpression(expression: Node, depth: number): HandlerBinding | undefined {
  if (
    depth < MAX_UNWRAP_DEPTH &&
    (Node.isParenthesizedExpression(expression) ||
      Node.isAsExpression(expression) ||
      Node.isSatisfiesExpression(expression) ||
      Node.isNonNullExpression(expression))
  ) {
    return classifyExpression(expression.getExpression(), depth + 1);
  }

  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return { inline: true, fn: expression };
  }

  if (Node.isIdentifier(expression)) {
    const name = expression.getText();

    // `onClick={undefined}` binds nothing; see `UNDEFINED_IDENTIFIER`.
    if (name === UNDEFINED_IDENTIFIER) {
      return undefined;
    }

    return { inline: false, name, reference: { kind: 'identifier', site: expression } };
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return {
      inline: false,
      name: expression.getName(),
      reference: referenceForPropertyAccess(expression.getExpression(), expression.getName()),
    };
  }

  if (Node.isCallExpression(expression)) {
    return classifyCallee(expression.getExpression(), depth);
  }

  return undefined;
}

/**
 * The classification of a call's callee, when the callee is nameable.
 *
 * `makeHandler(id)` resolves like the identifier `makeHandler`;
 * `this.makeHandler(id)` and `factory.make(id)` resolve like the corresponding
 * property access. The one call this looks *through* rather than at is
 * `fn.bind(…)`, whose result is the receiving function itself — see
 * {@link BIND_METHOD_NAME}. A callee that is itself a call, an element access or
 * a function expression yields `undefined`, the same rule the classification
 * above applies to a binding it cannot name.
 *
 * @param callee The called expression.
 * @param depth How many wrappers have already been looked through, so a chain of
 * calls cannot drive the recursion arbitrarily deep.
 * @returns The classification, or `undefined`.
 */
function classifyCallee(callee: Node, depth: number): HandlerBinding | undefined {
  if (Node.isIdentifier(callee)) {
    return {
      inline: false,
      name: callee.getText(),
      reference: { kind: 'identifier', site: callee },
    };
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  // `this.handleSelect.bind(this)`, `handleSelect.bind(null, id)` — the bound
  // function is the receiver, so classification continues there.
  if (callee.getName() === BIND_METHOD_NAME && depth < MAX_UNWRAP_DEPTH) {
    return classifyExpression(callee.getExpression(), depth + 1);
  }

  return {
    inline: false,
    name: callee.getName(),
    reference: referenceForPropertyAccess(callee.getExpression(), callee.getName()),
  };
}

/**
 * What a property access can be resolved through: the enclosing class for a
 * `this` receiver, nothing for any other.
 *
 * @param receiver The expression before the dot.
 * @param member The property name after it.
 * @returns The reference to attempt resolution with.
 */
function referenceForPropertyAccess(receiver: Node, member: string): NamedReference {
  // `this.onPress` — a class member, which is a syntactic question.
  if (Node.isThisExpression(receiver)) {
    return { kind: 'this-member', member, site: receiver };
  }

  // `props.onSelect`, `lib.handlers.click` — the receiver's members are a value
  // question this extractor does not ask (see the header).
  return { kind: 'opaque' };
}

/* -------------------------------------------------------------------------------------------------
 * Resolving a named handler's declaration
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where a named handler is declared, or `undefined` when syntax cannot say.
 *
 * Three routes, one per {@link NamedReference} case, and each stops at the first
 * answer:
 *
 * 1. an identifier — the enclosing scopes of the use site, innermost first, then
 *    the module's own import bindings;
 * 2. a `this` member — the enclosing class's methods and properties; and
 * 3. an opaque receiver — no route at all.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param name The referenced function's name.
 * @param reference What the binding points at.
 * @returns The declaration, or `undefined`.
 */
function resolveDeclaration(
  ctx: ExtractorContext,
  name: string,
  reference: NamedReference,
): ResolvedDeclaration | undefined {
  if (reference.kind === 'opaque') {
    return undefined;
  }

  if (reference.kind === 'this-member') {
    return resolveClassMember(ctx, reference.site, reference.member);
  }

  return resolveInScopes(ctx, reference.site, name) ?? resolveImported(ctx, name);
}

/**
 * The declaration of a name in the enclosing scopes of a use site, innermost
 * first.
 *
 * The walk is the language's own scoping order and it is what makes a handler
 * declared inside a component body — `const handleSubmit = useCallback(…)`, the
 * memoised shape every real component uses — resolve to *that* declaration
 * rather than to a module-level one of the same name. At each ancestor two
 * questions are asked, in this order:
 *
 * 1. does it hold **statements** that declare the name (a block, a case clause,
 *    a module block, the file itself)? and
 * 2. is it a **parametered** node whose parameters bind it (including a
 *    destructured parameter, `function Row({ onPick })`)?
 *
 * Statements come first because a `const` in a function body shadows a parameter
 * of the same name, and the innermost block containing the use site is reached
 * before the function that owns the parameter anyway.
 *
 * Nothing here consults the type checker: only the declarations a scope
 * syntactically contains are considered, which is the contract stated in the
 * header.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param site The use site the walk starts at.
 * @param name The name to look for.
 * @returns The declaration, or `undefined` when no enclosing scope declares it.
 */
function resolveInScopes(
  ctx: ExtractorContext,
  site: Node,
  name: string,
): ResolvedDeclaration | undefined {
  for (const ancestor of site.getAncestors()) {
    if (Node.isStatemented(ancestor)) {
      const declared = declarationInStatements(ctx, ancestor.getStatements(), name);

      if (declared !== undefined) {
        return declared;
      }
    }

    if (Node.isParametered(ancestor)) {
      const bound = declarationInParameters(ctx, ancestor.getParameters(), name);

      if (bound !== undefined) {
        return bound;
      }
    }
  }

  return undefined;
}

/**
 * The declaration of a name among a scope's statements.
 *
 * Three statement forms declare a value a handler can be: a function
 * declaration, a class declaration and a variable statement — the last one
 * including a destructured declarator (`const { onPick } = props;`), whose bound
 * identifier is what the position points at while the whole declarator bounds
 * the span. A type alias, an interface and an enum are deliberately not
 * considered: none of them is callable, so none of them can be the handler this
 * binding named.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param statements The scope's statements.
 * @param name The name to look for.
 * @returns The declaration, or `undefined`.
 */
function declarationInStatements(
  ctx: ExtractorContext,
  statements: readonly Statement[],
  name: string,
): ResolvedDeclaration | undefined {
  for (const statement of statements) {
    // `function handleSubmit() { … }`
    if (Node.isFunctionDeclaration(statement) && statement.getName() === name) {
      return declarationIn(
        ctx.file,
        statement.getNameNode() ?? statement,
        statement,
        exportedFlag(statement),
      );
    }

    // `class Handlers { … }` — a class is a value, so a binding may name it.
    if (Node.isClassDeclaration(statement) && statement.getName() === name) {
      return declarationIn(
        ctx.file,
        statement.getNameNode() ?? statement,
        statement,
        exportedFlag(statement),
      );
    }

    // `const handleSubmit = useCallback(…)`, `let handleSubmit = () => …`,
    // `const { onPick } = props;`
    if (Node.isVariableStatement(statement)) {
      const declared = declarationInVariableStatement(ctx.file, statement, name);

      if (declared !== undefined) {
        return declared;
      }
    }
  }

  return undefined;
}

/**
 * The declaration of a name among one variable statement's declarators.
 *
 * @param file The project-relative POSIX path the declaration is in.
 * @param statement The variable statement to inspect.
 * @param name The name to look for.
 * @returns The declaration, or `undefined`.
 */
function declarationInVariableStatement(
  file: string,
  statement: VariableStatement,
  name: string,
): ResolvedDeclaration | undefined {
  const exported = exportedFlag(statement);

  for (const declaration of statement.getDeclarations()) {
    const anchor = boundIdentifier(declaration.getNameNode(), name);

    if (anchor !== undefined) {
      return declarationIn(file, anchor, declaration, exported);
    }
  }

  return undefined;
}

/**
 * The declaration of a name among a function's parameters.
 *
 * A parameter is where a handler passed down from a parent arrives
 * (`function Row({ onPick }) { … <button onClick={onPick} /> }`), and pointing at
 * it is the honest answer: the function it holds is declared in the *caller*,
 * which no amount of syntax in this file can reach. A parameter is never
 * exported, so its export status is `false` rather than unknown.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param parameters The parameters to inspect.
 * @param name The name to look for.
 * @returns The declaration, or `undefined`.
 */
function declarationInParameters(
  ctx: ExtractorContext,
  parameters: readonly ParameterDeclaration[],
  name: string,
): ResolvedDeclaration | undefined {
  for (const parameter of parameters) {
    const anchor = boundIdentifier(parameter.getNameNode(), name);

    if (anchor !== undefined) {
      return declarationIn(ctx.file, anchor, parameter, false);
    }
  }

  return undefined;
}

/**
 * The identifier a binding name binds under a given name, or `undefined`.
 *
 * Two shapes: a plain identifier, compared directly, and a destructuring
 * pattern, searched for a binding element whose own name is that identifier. The
 * search descends, so a nested pattern (`{ handlers: { onPick } }`) is covered;
 * a binding element whose name is itself a pattern is skipped rather than
 * matched on its text.
 *
 * @param nameNode The declarator's or parameter's name node.
 * @param name The name to look for.
 * @returns The identifier node, or `undefined`.
 */
function boundIdentifier(nameNode: Node, name: string): Node | undefined {
  if (Node.isIdentifier(nameNode)) {
    return nameNode.getText() === name ? nameNode : undefined;
  }

  if (!Node.isObjectBindingPattern(nameNode) && !Node.isArrayBindingPattern(nameNode)) {
    return undefined;
  }

  let found: Node | undefined;

  nameNode.forEachDescendant((node, traversal) => {
    if (!Node.isBindingElement(node)) {
      return;
    }

    const elementName = node.getNameNode();

    if (Node.isIdentifier(elementName) && elementName.getText() === name) {
      found = elementName;
      traversal.stop();
    }
  });

  return found;
}

/**
 * The declaration of a `this` member in the class that encloses the use site.
 *
 * Methods are tried before properties because a method is the form a class
 * component's handler normally takes; a property initialised with an arrow
 * (`onPress = () => …`) is the other, and both are instance members, which is
 * what `this` names.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param site The `this` expression the reference was written on.
 * @param member The member name after the dot.
 * @returns The declaration, or `undefined` when the site is in no class or the
 * class declares no such member.
 */
function resolveClassMember(
  ctx: ExtractorContext,
  site: Node,
  member: string,
): ResolvedDeclaration | undefined {
  const owner = site.getFirstAncestor(
    (node): node is ClassDeclaration | ClassExpression =>
      Node.isClassDeclaration(node) || Node.isClassExpression(node),
  );

  if (owner === undefined) {
    return undefined;
  }

  const method = owner.getMethod(member);
  if (method !== undefined) {
    return declarationIn(ctx.file, method.getNameNode(), method, false);
  }

  const property = owner.getProperty(member);

  // A class member is not a module export, whatever the class's own status is.
  return property === undefined
    ? undefined
    : declarationIn(ctx.file, property.getNameNode(), property, false);
}

/**
 * The declaration of a name that this module imports, in the module it comes
 * from.
 *
 * Asked only after every enclosing scope has been searched, because a local
 * declaration shadows an import of the same name. The default import
 * (`import handleSubmit from './handlers.js'`) and named imports including
 * aliases (`import { handleSubmit as onSubmit }`) are followed; a type-only
 * import or specifier is skipped, since a type is never a handler, and a
 * namespace import binds an object whose members this extractor does not resolve
 * (see the header).
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param name The locally-bound name.
 * @returns The declaration in the imported module, or `undefined`.
 */
function resolveImported(ctx: ExtractorContext, name: string): ResolvedDeclaration | undefined {
  for (const declaration of ctx.sourceFile.getImportDeclarations()) {
    if (declaration.isTypeOnly()) {
      continue;
    }

    // `import handleSubmit from './handlers.js'`
    if (declaration.getDefaultImport()?.getText() === name) {
      return declarationInModule(
        ctx,
        declaration.getModuleSpecifierSourceFile(),
        DEFAULT_EXPORT_NAME,
      );
    }

    // `import { handleSubmit } from './handlers.js'`,
    // `import { handleSubmit as onSubmit } from …`
    for (const specifier of declaration.getNamedImports()) {
      if (specifier.isTypeOnly()) {
        continue;
      }

      const bound = specifier.getAliasNode()?.getText() ?? specifier.getName();

      if (bound === name) {
        return declarationInModule(
          ctx,
          declaration.getModuleSpecifierSourceFile(),
          specifier.getName(),
        );
      }
    }
  }

  return undefined;
}

/**
 * The declaration an imported module exports under a given name.
 *
 * The module must be one the indexer will visit — see
 * {@link indexableTargetPath} — because a node positioned in a file nobody
 * indexes is a node whose `file` the rest of the product cannot open. A
 * re-export chain is not followed: that bound is stated in the header, and a
 * handler reached only through a barrel falls back to its binding site.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @param moduleSourceFile The resolved module, or `undefined` when the specifier
 * resolved to nothing.
 * @param exportName The name that module exports the handler under, possibly
 * `'default'`.
 * @returns The declaration, or `undefined`.
 */
function declarationInModule(
  ctx: ExtractorContext,
  moduleSourceFile: SourceFile | undefined,
  exportName: string,
): ResolvedDeclaration | undefined {
  if (moduleSourceFile === undefined) {
    return undefined;
  }

  const file = indexableTargetPath(ctx, moduleSourceFile);
  if (file === undefined) {
    return undefined;
  }

  return exportName === DEFAULT_EXPORT_NAME
    ? defaultDeclarationIn(moduleSourceFile, file)
    : namedDeclarationIn(moduleSourceFile, file, exportName);
}

/**
 * The declaration a module exports under a plain name.
 *
 * Function, class and variable declarations are the three forms a handler can
 * take, looked up by the module's own top-level lookups so a declaration nested
 * inside another function — which no other module can import — is never
 * returned.
 *
 * @param moduleSourceFile The module to look in.
 * @param file That module's project-relative POSIX path.
 * @param name The exported name.
 * @returns The declaration, or `undefined`.
 */
function namedDeclarationIn(
  moduleSourceFile: SourceFile,
  file: string,
  name: string,
): ResolvedDeclaration | undefined {
  const fn = moduleSourceFile.getFunction(name);
  if (fn !== undefined) {
    return declarationIn(file, fn.getNameNode() ?? fn, fn, exportedFlag(fn));
  }

  const cls = moduleSourceFile.getClass(name);
  if (cls !== undefined) {
    return declarationIn(file, cls.getNameNode() ?? cls, cls, exportedFlag(cls));
  }

  const variable = moduleSourceFile.getVariableDeclaration(name);
  if (variable === undefined) {
    return undefined;
  }

  const statement = variable.getVariableStatement();

  return declarationIn(
    file,
    variable.getNameNode(),
    variable,
    statement === undefined ? false : exportedFlag(statement),
  );
}

/**
 * The declaration a module exports as its default.
 *
 * Two forms: the inline keyword (`export default function handleSubmit() {}`,
 * including the anonymous variant) and the assignment
 * (`export default handleSubmit;`), which is followed one hop to the local
 * declaration it names. `export = x` is a TypeScript-only form that an ES module
 * import cannot bind, so it is not followed.
 *
 * Either way the result's `exported` is `true`: being the default export *is*
 * being exported, whether or not the declaration itself carries the keyword.
 *
 * @param moduleSourceFile The module to look in.
 * @param file That module's project-relative POSIX path.
 * @returns The declaration, or `undefined`.
 */
function defaultDeclarationIn(
  moduleSourceFile: SourceFile,
  file: string,
): ResolvedDeclaration | undefined {
  for (const statement of moduleSourceFile.getStatements()) {
    // `export default function handleSubmit() {}`, `export default class {}`
    if (
      (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement)) &&
      statement.hasDefaultKeyword()
    ) {
      return declarationIn(file, statement.getNameNode() ?? statement, statement, true);
    }

    // `export default handleSubmit;`
    if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      const expression = statement.getExpression();

      if (!Node.isIdentifier(expression)) {
        continue;
      }

      const local = namedDeclarationIn(moduleSourceFile, file, expression.getText());

      if (local !== undefined) {
        return { ...local, exported: true };
      }
    }
  }

  return undefined;
}

/**
 * The project-relative POSIX path of a resolved module, provided the indexer will
 * visit it.
 *
 * Four conditions, each of which would otherwise produce a node positioned in a
 * file the product cannot open: the module must be inside the project, its path
 * must satisfy the same refinement every stored path does, it must be an
 * indexable file (which excludes a `.d.ts` declaration file), and it must not sit
 * under one of the generated or vendored directories the project loader
 * excludes.
 *
 * The check mirrors the loader's **default** rules rather than consulting the
 * loaded file list, so it costs a few string operations instead of a scan per
 * resolution, and it needs no cached state — this extractor keeps none. The one
 * rule it cannot see is a caller's `extraExcludes`, which
 * {@link ExtractorContext} does not carry; a handler declared in a module
 * excluded only by that would be positioned in a file the index does not cover,
 * which is why the same mirror is used here as in the component extractor rather
 * than a looser check.
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
 * Positions and export status
 * ---------------------------------------------------------------------------------------------- */

/**
 * The placement of a node that is its own extent: an inline function, or the
 * attribute a named handler falls back to.
 *
 * @param file The project-relative POSIX path the node is in.
 * @param node The node to measure.
 * @returns The placement.
 */
function placementOf(file: string, node: Node): HandlerPlacement {
  const position = positionOf(node);

  return {
    file,
    line: position.line,
    column: position.column,
    endLine: Math.max(node.getEndLineNumber(), position.line),
  };
}

/**
 * The placement of a resolved declaration: positioned at its identifier, spanning
 * its whole declarator.
 *
 * The split between the two nodes is what makes click-to-source land on the name
 * while an editor can still reveal the whole function: the anchor is the
 * identifier a developer reads, the extent is the declaration a patch would
 * rewrite.
 *
 * @param file The project-relative POSIX path the declaration is in.
 * @param anchor The identifier the position is taken from.
 * @param extent The declaration the end line is taken from.
 * @param exported Whether the declaration is exported from its module.
 * @returns The resolved declaration.
 */
function declarationIn(
  file: string,
  anchor: Node,
  extent: Node,
  exported: boolean,
): ResolvedDeclaration {
  const position = positionOf(anchor);

  return {
    file,
    line: position.line,
    column: position.column,
    endLine: Math.max(extent.getEndLineNumber(), position.line),
    exported,
    // The anchor is the declaration's identifier wherever it has one, so this is
    // the declaration's own name rather than the name written at the binding
    // site; see {@link ResolvedDeclaration.declaredName}.
    declaredName: Node.isIdentifier(anchor) ? anchor.getText() : undefined,
  };
}

/**
 * Whether a declaration carries an export keyword.
 *
 * Asked through the `Exportable` capability rather than per node kind, and
 * `false` for anything that cannot be exported at all — a nested function
 * declaration, a class member, a parameter.
 *
 * @param node The declaration in question.
 * @returns `true` when the declaration is exported from its module.
 */
function exportedFlag(node: Node): boolean {
  return Node.isExportable(node) && node.isExported();
}

/**
 * The 1-based line and column a node starts at.
 *
 * 1-based on both axes, which is the convention {@link CodeNodeBase.line} fixes
 * for the whole product; the single conversion to an editor's 0-based position
 * happens in the VS Code extension.
 *
 * @param node Any node.
 * @returns Its start position.
 */
function positionOf(node: Node): Position {
  const { line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart());

  return { line, column };
}

/* -------------------------------------------------------------------------------------------------
 * The component-naming rule, copied from `./react-components.ts`
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every module-level component of one file, reduced to the id and range a
 * `handles` edge needs, in source order.
 *
 * **This is the copy of `./react-components.ts`'s detection and naming rule that
 * the header requires to stay equivalent.** Only what the id depends on is
 * reproduced — kind, file, name and the identifier's position — so the payload
 * facts that module also records (`isClient`, `displayName`,
 * `isDefaultExport`) are deliberately absent here: they do not participate in
 * {@link makeNodeId}, and re-deriving them would be a second chance to disagree
 * for no benefit.
 *
 * Per-statement failures are contained: a construct that throws costs its own
 * anchor, so a handler bound inside a *different* component still gets its edge.
 *
 * @param sourceFile The module to inspect.
 * @param file That module's project-relative POSIX path.
 * @param failures Collector for `extractor-failed` diagnostics.
 * @returns The anchors, in source order.
 */
function collectComponentAnchors(
  sourceFile: SourceFile,
  file: string,
  failures: IndexDiagnostic[],
): readonly ComponentAnchor[] {
  const anchors: ComponentAnchor[] = [];

  for (const statement of sourceFile.getStatements()) {
    try {
      appendStatementAnchors(file, statement, anchors);
    } catch (cause) {
      failures.push(constructFailure(file, statement, cause));
    }
  }

  return anchors.length === 0 ? EMPTY_ANCHORS : anchors;
}

/**
 * Appends the anchors one module-level statement declares.
 *
 * A statement declares at most one component, except a variable statement with
 * several declarators (`const A = () => …, B = () => …`), which is why the
 * accumulator is passed in rather than returned.
 *
 * @param file The module's project-relative POSIX path.
 * @param statement One module-level statement.
 * @param anchors The accumulator, appended in source order.
 */
function appendStatementAnchors(file: string, statement: Node, anchors: ComponentAnchor[]): void {
  // `function Widget() { … }`, `export default function () { … }`.
  if (Node.isFunctionDeclaration(statement)) {
    appendAnchor(anchors, functionAnchor(file, statement));

    return;
  }

  // `class Widget { render() { … } }`.
  if (Node.isClassDeclaration(statement)) {
    appendAnchor(anchors, classAnchor(file, statement));

    return;
  }

  // `const Widget = () => …`, `const Widget = memo(…)`.
  if (Node.isVariableStatement(statement)) {
    for (const declaration of statement.getDeclarations()) {
      appendAnchor(anchors, variableAnchor(file, declaration));
    }
  }
}

/**
 * Appends an anchor when there is one, so the branches above read as a list of
 * syntactic forms rather than a list of undefined checks.
 *
 * @param anchors The accumulator.
 * @param anchor The anchor, or `undefined` when the declaration is not a
 * component.
 */
function appendAnchor(anchors: ComponentAnchor[], anchor: ComponentAnchor | undefined): void {
  if (anchor !== undefined) {
    anchors.push(anchor);
  }
}

/**
 * The anchor a function declaration contributes, if it is a component.
 *
 * @param file The module's project-relative POSIX path.
 * @param declaration The function declaration.
 * @returns The anchor, or `undefined`.
 */
function functionAnchor(
  file: string,
  declaration: FunctionDeclaration,
): ComponentAnchor | undefined {
  const nameNode = declaration.getNameNode();
  const declaredName = nameNode?.getText();

  if (!isComponentDeclarationName(declaredName, declaration.hasDefaultKeyword())) {
    return undefined;
  }

  // A generator function cannot be a React component, whatever it returns.
  if (declaration.isGenerator() || !functionProducesJsx(declaration)) {
    return undefined;
  }

  return anchorFor(file, componentName(declaredName, file), nameNode ?? declaration, declaration);
}

/**
 * The anchor a class declaration contributes, if it is a component.
 *
 * A class is a component when it has a `render` **method** that produces JSX; a
 * `render` property initialiser is out of scope in the component extractor, so it
 * is out of scope here too.
 *
 * @param file The module's project-relative POSIX path.
 * @param declaration The class declaration.
 * @returns The anchor, or `undefined`.
 */
function classAnchor(file: string, declaration: ClassDeclaration): ComponentAnchor | undefined {
  const nameNode = declaration.getNameNode();
  const declaredName = nameNode?.getText();

  if (!isComponentDeclarationName(declaredName, declaration.hasDefaultKeyword())) {
    return undefined;
  }

  const render = declaration.getMethod(RENDER_METHOD_NAME);
  if (render === undefined || !functionProducesJsx(render)) {
    return undefined;
  }

  return anchorFor(file, componentName(declaredName, file), nameNode ?? declaration, declaration);
}

/**
 * The anchor one declarator of a variable statement contributes, if it is a
 * component.
 *
 * The extent is the **variable declaration**, not the function inside it, so a
 * wrapper call's markup is inside the range a binding is matched against.
 *
 * @param file The module's project-relative POSIX path.
 * @param declaration The declarator.
 * @returns The anchor, or `undefined`.
 */
function variableAnchor(
  file: string,
  declaration: VariableDeclaration,
): ComponentAnchor | undefined {
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
  if (fn === undefined || !functionProducesJsx(fn)) {
    return undefined;
  }

  return anchorFor(file, declaredName, nameNode, declaration);
}

/**
 * Builds one component anchor: the id `./react-components.ts` will emit, and the
 * declaration's character range.
 *
 * The single place a component node id is derived in this module, which is what
 * makes the equivalence with the component extractor checkable in one place.
 *
 * @param file The module's project-relative POSIX path.
 * @param name The component's name, by the naming rule.
 * @param anchor The identifier the position is taken from, or the declaration
 * when there is none.
 * @param declaration The declaration whose range a binding is matched against.
 * @returns The anchor.
 */
function anchorFor(file: string, name: string, anchor: Node, declaration: Node): ComponentAnchor {
  const position = positionOf(anchor);

  return {
    id: makeNodeId({
      kind: 'component',
      file,
      name,
      line: position.line,
      column: position.column,
    }),
    start: declaration.getStart(),
    end: declaration.getEnd(),
  };
}

/**
 * Whether a declaration's name admits it as a component candidate.
 *
 * The capitalisation gate, plus the one exception: a declaration with no name at
 * all is a candidate only when it is the file's inline default export.
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
 * Implemented over the first **code point** rather than the first UTF-16 unit,
 * so a name outside the Basic Multilingual Plane is judged on its actual initial
 * character. A caseless initial (`_`, `$`, a digit, a script without case) is not
 * an uppercase letter and therefore not a component name — the same rule
 * `./react-components.ts` applies.
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
 * The component's name, by the naming rule: the declared identifier when there
 * is one, otherwise the file's basename without its extension.
 *
 * @param declaredName The declared identifier, or `undefined`.
 * @param file The module's project-relative POSIX path.
 * @returns The name to derive the id from.
 */
function componentName(declaredName: string | undefined, file: string): string {
  if (declaredName !== undefined) {
    return declaredName;
  }

  return basenamePosix(file, extnamePosix(file));
}

/**
 * The function-like expression a variable initialiser resolves to, if any.
 *
 * Unwraps parentheses, `as` and `satisfies` assertions and non-null assertions,
 * and a `memo`/`forwardRef` call — bare or qualified — around its first
 * argument, nested up to {@link MAX_WRAPPER_DEPTH}. Anything else is not a
 * component declaration.
 *
 * @param expression The initialiser, or an inner expression during unwrapping.
 * @param depth How many wrapper calls have already been unwrapped.
 * @returns The function, or `undefined`.
 */
function componentFunctionOf(expression: Node, depth: number): Node | undefined {
  // `() => …` and `function () { … }`.
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return expression;
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
 * Whether a call's callee is one of the React component wrappers, matched by
 * name only in the bare and qualified forms.
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
 * A concise arrow body is what is returned; a block body is judged by the
 * `return` statements belonging to *this* function.
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
 * The traversal skips the subtree of every nested function-like declaration, so
 * only this function's own returns are considered, and stops at the first match.
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
 * A subtree search rather than a shape match, because the returned expression of
 * a real component is as often `cond && <Row />` or `items.map(…)` as it is a
 * bare element.
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
 * Whether a node is one of the three JSX forms that render something:
 * `<Row />`, `<Row>…</Row>` and `<>…</>`.
 *
 * @param node Any node.
 * @returns `true` for a JSX element, self-closing element or fragment.
 */
function isJsxOutput(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

/* -------------------------------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * The diagnostic for a named handler whose declaration could not be located.
 *
 * Severity `info`, which is the vocabulary's "worth recording, nothing to act
 * on": the node exists, it is usable, and it is positioned at the binding site
 * rather than at a declaration — which is exactly what a consumer sees when it
 * opens it. The code is `extractor-failed` because that is the one the vocabulary
 * reserves for "an extractor could not do its job here"; `unresolved-import` is
 * deliberately not borrowed, since `../graph/types.ts` assigns it to the import
 * extractor and gives every code exactly one emitter.
 *
 * The message names the handler, the file and the 1-based position and quotes
 * **nothing**: a symbol name is material a diagnostic is built from, a slice of
 * the developer's source is not (see the privacy constraint on
 * `INDEX_DIAGNOSTIC_CODES`).
 *
 * @param file The project-relative POSIX path of the file being extracted.
 * @param name The referenced handler's name.
 * @param position The binding site's 1-based position, when it could be read.
 * @returns The diagnostic.
 */
function unresolvedDeclaration(
  file: string,
  name: string,
  position: Position | undefined,
): IndexDiagnostic {
  const where =
    position === undefined
      ? 'at an unknown position'
      : `at line ${position.line}, column ${position.column}`;

  return {
    severity: 'info',
    code: 'extractor-failed',
    message: `${EXTRACTOR_ID} could not locate the declaration of the handler ${name} bound ${where}; the handler node was positioned at its binding site`,
    file,
    extractorId: EXTRACTOR_ID,
  };
}

/**
 * The diagnostic for one construct this extractor could not read.
 *
 * Severity `warning` rather than `error`: the file still yielded everything
 * else, so the index is usable and merely incomplete at one position. The
 * message names the syntax kind, the file and the 1-based position, and quotes
 * nothing.
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
 * The diagnostic for a failure that cost the whole file rather than one
 * construct.
 *
 * Raised when locating the file's components or collecting its bindings threw,
 * which leaves no position to report and no partial output to keep.
 *
 * @param file The project-relative POSIX path of the file being extracted.
 * @param cause Whatever was thrown.
 * @returns The diagnostic.
 */
function fileFailure(file: string, cause: unknown): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `${EXTRACTOR_ID} could not index this file; no event handler was recorded for it`,
    file,
    extractorId: EXTRACTOR_ID,
    detail: failureDetail(cause),
  };
}

/**
 * What can safely be said about a thrown value: the error's **type name only**.
 *
 * A thrown message is not safe to repeat — an abstract-syntax-tree library
 * routinely embeds the text of the node it choked on in its message, and that
 * text is the developer's source.
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
 * A syntax kind name is a fixed vocabulary word (`JsxAttribute`,
 * `FunctionDeclaration`) and never source text, so it is safe in a diagnostic.
 * The guard exists because this runs on the failure path, where assuming any
 * further call succeeds is how one failure becomes two.
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
