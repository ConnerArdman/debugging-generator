/**
 * The internal, normalized panel specification: the only panel shape the
 * renderer is allowed to draw.
 *
 * A generated panel reaches the screen through four steps, and this module owns
 * the destination of all four (AAP 0.2.3, AAP 0.5.3):
 *
 * 1. a model's structured output is parsed against the **authoring** schema in
 *    `./input.ts`, with a bounded repair loop on failure;
 * 2. the parsed authoring form is converted by the **deterministic** normaliser
 *    in `./normalize.ts` — which lifts the flat query fields into each node's
 *    `query`, derives every node id from its position in the layout, and copies
 *    observed facts and likely causes only from the validated analysis;
 * 3. the result is validated **syntactically** here and in `./validate.ts`;
 * 4. and **semantically** against the capture in `./semantic.ts`.
 *
 * Nothing skips a step: there is no path from model output to a
 * {@link PanelSpec} that does not pass through {@link panelSpecSchema}, and a
 * value that fails it is a rejection the calling stage must degrade — never a
 * panel with a hole in it.
 *
 * ## What a specification is, and is not
 *
 * A specification is a **document**: a title, a summary that keeps what was
 * observed apart from what is merely inferred, and a tree of nodes that each
 * name a prepared view of the same capture. It is stored as JSON, replayed to a
 * reconnecting user interface verbatim, and compared node by node against the
 * panel it supersedes. Two consequences run through every declaration below:
 *
 * - **Every field is JSON-representable.** No date object, no map, no set, no
 *   function, no `undefined`-valued required key. A parsed specification
 *   survives `JSON.parse(JSON.stringify(spec))` and re-parses to an equal
 *   value, because that is literally what the store does to it.
 * - **Every field is `readonly`.** The three processes that carry a
 *   specification around read it; regenerating a panel produces a *new*
 *   document with a new version (see {@link PanelSpec.panelVersion}), never an
 *   edit of the old one.
 *
 * What a specification deliberately cannot express is presentation. No node
 * carries a colour, a size, a spacing, a density or a threshold: what a panel
 * may vary is which evidence it draws and how those views are arranged, and
 * every visual value belongs to the renderer's design tokens (AAP 0.6.2,
 * AAP 0.6.4). "The model authored this panel" is therefore a statement about
 * evidence and arrangement, never about styling.
 *
 * ## The node vocabulary, composed here exactly once
 *
 * Sixteen node types: three containers, owned by `./nodes/layout.ts`, and
 * thirteen leaves, owned by `./nodes/viz.ts`. This module **composes** those two
 * vocabularies into {@link PANEL_NODE_TYPES} and does not retype either of them
 * — a third hand-written list of node-type strings is precisely the drift the
 * node catalog's test exists to catch, and the drift it could not catch is a
 * list nobody derived. {@link PanelNodeType} is the catalog's key domain and the
 * discriminator the renderer's component registry is keyed by.
 *
 * ## Why the recursion is closed here
 *
 * Containers hold nodes, so the node type is recursive, and a recursive type has
 * to be closed in exactly one place. `./nodes/viz.ts` exports concrete leaf
 * schemas (no leaf accepts children, so none needs to know the node type), while
 * `./nodes/layout.ts` exports schema *factories* parameterised by the schema of a
 * child. Neither imports this module, so there is no cycle; this module supplies
 * the child — itself — and the loop closes once, in {@link panelNodeSchema}.
 *
 * The type is declared explicitly rather than inferred, for a reason that is
 * measured rather than stylistic: inference through a generic factory resolves a
 * container's children to `any` in the emitted declarations, so every consumer
 * that walks a panel — the validators here, the service's panel generation and
 * data resolution, the renderer's node dispatch — would lose type safety at the
 * first level of nesting without a single error being reported anywhere.
 *
 * ## Environment-neutral
 *
 * Pure schema and pure data. No platform builtin, no browser global, no
 * import-time side effect: the coordination service validates specifications in
 * a Node process, and the DevTools panel and the editor webview parse the same
 * documents in a page. Every export below is a frozen vocabulary, a constant, a
 * schema, a pure function or a type.
 *
 * @example
 * ```ts
 * const parsed = parsePanelSpec(await readStoredPanel(panelRowId));
 *
 * if (parsed.ok) {
 *   walkPanelNodes(parsed.value.layout, (node, path) => {
 *     registry.record(node.id, node.type, path);
 *   });
 * }
 * ```
 */

import { z } from 'zod';

import { DebuggenError, assertNever, err, ok } from '@debuggen/shared';
import type { PanelId, Result, SessionId } from '@debuggen/shared';

import {
  LAYOUT_NODE_TYPES,
  layoutNodeSchemasFor,
  type SectionNodeOf,
  type SplitNodeOf,
  type StackNodeOf,
} from './nodes/layout.js';
import {
  VISUALIZATION_NODE_SCHEMAS,
  VISUALIZATION_NODE_TYPES,
  type VisualizationNode,
} from './nodes/viz.js';
import { describeIssues, panelSummarySchema, type PanelSummary } from './summary.js';

/*
 * ---------------------------------------------------------------------------
 * The node-type domain
 *
 * Composed from the two owning modules, never retyped. Each re-export below is
 * the *same frozen tuple object* the owning module built, so there is one
 * declaration of each vocabulary in the package and these names are an
 * alternative route to it rather than a copy of it.
 * ---------------------------------------------------------------------------
 */

/**
 * The containers a panel may compose: the vocabulary `./nodes/layout.ts` owns,
 * re-exported under the panel-level name the catalog and the renderer use.
 *
 * Exactly the same frozen tuple — `PANEL_LAYOUT_NODE_TYPES ===
 * LAYOUT_NODE_TYPES` — so a container added there appears here, in
 * {@link PANEL_NODE_TYPES} and in {@link PanelNodeType} without an edit to this
 * module. The element type is that module's `LayoutNodeType`.
 */
export const PANEL_LAYOUT_NODE_TYPES = LAYOUT_NODE_TYPES;

/**
 * The thirteen leaves a panel may draw: the vocabulary `./nodes/viz.ts` owns,
 * re-exported under the panel-level name.
 *
 * Twelve of them are backed by a data query; the source-link leaf carries a
 * resolved location instead and no query. Exactly the same frozen tuple —
 * `PANEL_VIZ_NODE_TYPES === VISUALIZATION_NODE_TYPES` — and its element type is
 * that module's `VisualizationNodeType`.
 */
export const PANEL_VIZ_NODE_TYPES = VISUALIZATION_NODE_TYPES;

/**
 * Every node type a panel may contain: the three containers followed by the
 * thirteen leaves, sixteen in all.
 *
 * **Load-bearing.** The node catalog is keyed by {@link PanelNodeType} and its
 * test asserts that the catalog's key set equals this tuple exactly, so a node
 * type that exists in one of the two owning modules but has no catalog entry —
 * and therefore no declared data-source allowance and no renderer component —
 * fails that assertion instead of rendering as a blank region.
 *
 * Containers first, then leaves, which is the order the specification is
 * documented in and the order a reader of the catalog meets the types in. The
 * order is *not* load-bearing for parsing: {@link panelNodeSchema} discriminates
 * on the `type` field, so a node matches one option by its own discriminator
 * rather than by position.
 *
 * Frozen: a read-only vocabulary shared by this package, the coordination
 * service, the transport package and both user interfaces.
 */
export const PANEL_NODE_TYPES = Object.freeze([
  ...PANEL_LAYOUT_NODE_TYPES,
  ...PANEL_VIZ_NODE_TYPES,
] as const);

/**
 * One member of the complete node vocabulary.
 *
 * Derived from {@link PANEL_NODE_TYPES}, itself derived from the two owning
 * modules' tuples, so the runtime vocabulary and the static type cannot
 * disagree at any of the three levels. This is the type the node catalog is
 * keyed by and the discriminator of {@link PanelNode}.
 */
export type PanelNodeType = (typeof PANEL_NODE_TYPES)[number];

/** Widened view of {@link PANEL_NODE_TYPES} used by {@link isPanelNodeType}. */
const PANEL_NODE_TYPE_VALUES: readonly string[] = PANEL_NODE_TYPES;

/**
 * Narrow an untrusted value to a {@link PanelNodeType} by membership in
 * {@link PANEL_NODE_TYPES}.
 *
 * For the places that have to classify a node type before a schema is
 * available: a catalog lookup being checked, a stored panel row being read back
 * field by field, a type name arriving on its own rather than inside a node.
 * {@link panelNodeSchema} is the gate a whole node passes through; this
 * predicate exists so that no caller has to spell the sixteen names again.
 *
 * @param value Any value believed to name a panel node type.
 * @returns `true` when `value` is one of the sixteen node types.
 */
export function isPanelNodeType(value: unknown): value is PanelNodeType {
  return typeof value === 'string' && PANEL_NODE_TYPE_VALUES.includes(value);
}

/*
 * ---------------------------------------------------------------------------
 * The node type and its schema
 * ---------------------------------------------------------------------------
 */

/**
 * Any node a normalized panel may contain: a leaf that draws something, or a
 * container that arranges other nodes.
 *
 * The recursive type, closed here and nowhere else. The three containers are
 * named one by one rather than through `./nodes/layout.ts`'s `LayoutNodeOf`
 * alias, because only a reference to an *interface* is deferred by the compiler:
 * routing the recursion through a second type alias is rejected outright
 * (TS2456, "type alias circularly references itself").
 *
 * Discriminated by `type`, so a `switch` over a node is exhaustively checkable
 * — which is how the renderer's node dispatch and this package's per-type
 * validation stay complete as the vocabulary grows.
 */
export type PanelNode =
  VisualizationNode | SectionNodeOf<PanelNode> | SplitNodeOf<PanelNode> | StackNodeOf<PanelNode>;

/** A titled group of panel nodes. */
export type PanelSectionNode = SectionNodeOf<PanelNode>;

/** Two or more panel nodes placed along one axis. */
export type PanelSplitNode = SplitNodeOf<PanelNode>;

/** One or more panel nodes in vertical sequence. */
export type PanelStackNode = StackNodeOf<PanelNode>;

/**
 * Any container node of a panel: the three above, with their children resolved
 * to {@link PanelNode}.
 *
 * For a consumer that has already established it is holding a container — by
 * `./nodes/layout.ts`'s `isLayoutNodeType`, or by the catalog's children flag —
 * and wants to read `children` without a further switch. Not usable for closing
 * the recursion, for the reason recorded on {@link PanelNode}.
 */
export type PanelLayoutNode = PanelSectionNode | PanelSplitNode | PanelStackNode;

/**
 * The validator for one node of a normalized panel.
 *
 * A discriminated union over `type` rather than a plain union, and that is the
 * difference between a usable rejection and an unreadable one: an unrecognised
 * node type fails with one issue at the node's own path, and a *recognised* type
 * with a malformed body fails against that type's schema alone instead of
 * reporting sixteen branches' worth of issues at once. An unknown node type must
 * fail, and here it does (AAP 0.8.3).
 *
 * Every option is a strict object, so an unrecognised key on a node is rejected
 * rather than dropped. After normalisation there is no excuse for one: an extra
 * key is either a field this package removed — in which case the panel was
 * written against a contract that no longer holds and must be regenerated
 * rather than half-honoured — or a dimension its author invented, which the
 * renderer would ignore while the panel went on claiming to present it.
 * Strictness is also what proves the normaliser did its job: a flat authoring
 * query field left on a node (`source`, `filter`, `sort`, `limit`) is an
 * unrecognised key here and fails, instead of travelling to a renderer that
 * never reads it.
 *
 * ## How the recursion is wired
 *
 * The union itself is built eagerly, once, at module load; only the *child*
 * position is deferred, with `z.lazy` reading this binding when the first nested
 * node is parsed. That arrangement is deliberate: deferring the union instead
 * would rebuild the three container schemas on every access, giving a panel's
 * nodes schema identities that differ between parses. There is no import-time
 * cycle either way — the getter runs long after the binding is initialised.
 *
 * The annotation is what keeps the emitted declarations honest. Left to
 * inference, a container's `children` resolves to `any` in `dist/index.d.ts`,
 * silently, and every consumer that walks a panel loses type safety one level
 * into the tree; annotated with the explicitly declared {@link PanelNode}, the
 * declaration is genuinely recursive. The cost of the annotation is that this
 * binding is a `z.ZodType` rather than a `z.ZodDiscriminatedUnion`, so a caller
 * that needs the union's own members reaches for the two owning modules'
 * exports, which is where they are declared.
 */
export const panelNodeSchema: z.ZodType<PanelNode> = z.discriminatedUnion('type', [
  ...VISUALIZATION_NODE_SCHEMAS,
  ...layoutNodeSchemasFor(z.lazy((): z.ZodType<PanelNode> => panelNodeSchema)),
]);

/*
 * ---------------------------------------------------------------------------
 * Traversal
 *
 * One implementation, here, because three modules need it and a traversal
 * written three times is a traversal whose three versions disagree about order,
 * about paths, or about which node types have children.
 * ---------------------------------------------------------------------------
 */

/**
 * The field of a panel specification a node path is rooted at.
 *
 * Exported so that a caller building a path by hand — a validator reporting an
 * issue, a normaliser deriving an id — spells it the same way
 * {@link walkPanelNodes} does.
 */
export const PANEL_LAYOUT_FIELD = 'layout';

/**
 * The key a container's children are reached through, as it appears in a node
 * path.
 *
 * Exported for the same reason {@link PANEL_LAYOUT_FIELD} is: a path is a
 * contract between whoever builds one and whoever reads one.
 */
export const PANEL_CHILDREN_FIELD = 'children';

/**
 * Where a node sits in its specification, as the sequence of property keys and
 * array indices that reach it.
 *
 * A top-level node is `['layout', 0]`; the second child of the first node is
 * `['layout', 0, 'children', 1]`. Joined with `.` this is exactly the id form
 * the normaliser derives (`layout.0`, `layout.0.children.1`), and it is also the
 * shape a validation issue's path takes, so one value serves a node's identity,
 * a rejection's location and a developer's mental model of the document.
 */
export type PanelNodePath = readonly (string | number)[];

/**
 * The default root of the paths {@link walkPanelNodes} reports: the layout field
 * of the specification the nodes came from.
 *
 * Frozen, because it is shared by every call that does not override it.
 */
export const PANEL_LAYOUT_PATH_ROOT: PanelNodePath = Object.freeze([PANEL_LAYOUT_FIELD]);

/**
 * What {@link walkPanelNodes} calls for each node it reaches.
 *
 * @param node The node being visited.
 * @param path Where that node sits: see {@link PanelNodePath}.
 */
export type PanelNodeVisitor = (node: PanelNode, path: PanelNodePath) => void;

/** A node and the path that reaches it, queued by {@link walkPanelNodes}. */
interface PanelNodeFrame {
  readonly node: PanelNode;
  readonly path: PanelNodePath;
}

/**
 * The children of a node, or an empty list for a leaf.
 *
 * The one switch in this package that decides whether a node type has children,
 * and the reason it ends in `assertNever`: because the parameter of that call is
 * typed `never`, a node type added to either owning module without a decision
 * here stops compiling, and the error points at this function rather than
 * surfacing as a subtree that silently never gets visited (AAP: `assertNever`
 * exists for exactly these discriminated unions, panel node types among them).
 *
 * Every one of the sixteen types is named explicitly rather than covered by a
 * `default`, which is what makes that guarantee hold in both directions: a
 * container that stopped being one, and a leaf that gained children, are both
 * compile errors here.
 */
function panelNodeChildren(node: PanelNode): readonly PanelNode[] {
  switch (node.type) {
    // The three containers: they hold nodes, so the traversal descends.
    case 'section':
    case 'split':
    case 'stack':
      return node.children;

    // The thirteen leaves: each draws a prepared view of the capture or points
    // at source, and none of them contains a node.
    case 'timeline':
    case 'waterfall':
    case 'eventLog':
    case 'metricCards':
    case 'flame':
    case 'table':
    case 'renderTable':
    case 'componentTree':
    case 'requestTable':
    case 'queryTable':
    case 'stateTransitions':
    case 'dependencyGraph':
    case 'sourceLink':
      return [];

    default:
      return assertNever(node, 'Unhandled panel node type');
  }
}

/**
 * Visits every node of a layout, depth first, in document order, reporting each
 * node with the path that reaches it.
 *
 * This is the traversal `./validate.ts` uses to check catalog membership, node
 * id uniqueness and per-type data-source allowance, the one `./semantic.ts` uses
 * to resolve evidence references and trace filters against the capture, and the
 * one the normaliser's tests use to assert an exact expected document. It exists
 * once, here, so that all of them agree on order and on paths.
 *
 * **Order.** A node is visited before its children (pre-order), and siblings in
 * the order they appear, so the sequence of visits is the order a developer
 * reads the panel in — which is what makes "the first node that failed" a
 * meaningful thing for a rejection to say.
 *
 * **Depth.** Implemented with an explicit stack rather than recursion, so a
 * pathologically nested document cannot exhaust the call stack in a traversal
 * whose whole purpose may be to *detect* that nesting. The nesting bound itself
 * belongs to `./validate.ts`, which checks it on a whole internal document (the
 * authoring schema in `./input.ts` enforces the same constant on an authored
 * one); this function imposes none and completes on any tree it is given. Each
 * node's path is materialised as its own array, so the work is proportional to
 * the number of nodes times the depth they sit at — immaterial for a document
 * bounded at {@link PANEL_LAYOUT_MAX_NODES} nodes per container and a readable
 * depth, and the price of handing the visitor a path it may keep.
 *
 * **Purity.** Nothing here mutates a node, and `visit` receives the node itself
 * rather than a copy: a specification is a read-only document, and every field
 * of every node is declared `readonly` to say so.
 *
 * @param layout The nodes to walk — normally a specification's `layout`.
 * @param visit Called once per node, with the node and its path.
 * @param basePath Prefix for the reported paths. Defaults to
 * {@link PANEL_LAYOUT_PATH_ROOT}, which makes a top-level node's path
 * `['layout', 0]`; pass something else when the nodes being walked sit somewhere
 * other than a specification's layout field, so the reported paths stay true to
 * the document being described.
 */
export function walkPanelNodes(
  layout: readonly PanelNode[],
  visit: PanelNodeVisitor,
  basePath: PanelNodePath = PANEL_LAYOUT_PATH_ROOT,
): void {
  // Reversed, because the stack is LIFO and the first sibling must come out
  // first.
  const stack: PanelNodeFrame[] = framesOf(layout, basePath).reverse();

  while (stack.length > 0) {
    const frame = stack.pop();

    // Unreachable while the loop condition holds; `pop` is typed as possibly
    // empty and this branch is how that is honoured without an assertion.
    if (frame === undefined) {
      return;
    }

    visit(frame.node, frame.path);

    const children = panelNodeChildren(frame.node);

    if (children.length === 0) {
      continue;
    }

    const childFrames = framesOf(children, [...frame.path, PANEL_CHILDREN_FIELD]);
    childFrames.reverse();

    // Pushed one at a time rather than spread, so a node with an implausible
    // number of children cannot exceed the runtime's argument limit.
    for (const childFrame of childFrames) {
      stack.push(childFrame);
    }
  }
}

/**
 * Pairs each node of a list with the path that reaches it.
 *
 * `entries()` rather than an index loop, so no indexed read has to be
 * null-checked under `noUncheckedIndexedAccess`; the returned array is fresh, so
 * {@link walkPanelNodes} may reverse it in place.
 */
function framesOf(nodes: readonly PanelNode[], basePath: PanelNodePath): PanelNodeFrame[] {
  const frames: PanelNodeFrame[] = [];

  for (const [index, node] of nodes.entries()) {
    frames.push({ node, path: [...basePath, index] });
  }

  return frames;
}

/*
 * ---------------------------------------------------------------------------
 * The document version and its bounds
 * ---------------------------------------------------------------------------
 */

/**
 * The version of the panel *document format*: **1**.
 *
 * This is the wire and storage version of the shape declared below — not the
 * version of a particular panel, which is {@link PanelSpec.panelVersion}, and
 * not the version of the package. It is a literal on the schema, so a document
 * written by a future format is rejected here rather than parsed into a shape
 * whose meaning has moved.
 *
 * Raising it is therefore a migration, not an edit: the service's `panels` store
 * table holds every specification ever generated as JSON, and a reader of an old
 * row has to be able to either upgrade it or refuse it explicitly. A change to
 * this number without that migration turns every stored panel into an
 * unparseable row, which the session-reopen path surfaces as a session whose
 * panel can no longer be shown.
 */
export const PANEL_SPEC_VERSION = 1 as const;

/**
 * Longest accepted identifier on a specification — its own id, the session's,
 * and the id of the panel it supersedes: **128** characters.
 *
 * Generously above the ids the product mints (a short prefix plus a generated
 * suffix) so that a document written by an older build, or by a test fixture
 * with a spelled-out id, still parses; bounded because these values arrive from
 * a store and over a transport and are interpolated into keys, log lines and
 * request paths.
 */
export const PANEL_ID_MAX_LENGTH = 128;

/**
 * Longest accepted panel title, in characters: **200**.
 *
 * A title is the one line at the top of the panel, read at a glance: the same
 * ceiling a node heading gets, for the same reason. An author with more to say
 * has the summary's headline for prose and its observed facts for findings.
 */
export const PANEL_TITLE_MAX_LENGTH = 200;

/**
 * Most nodes a specification may place at the top level of its layout: **64**.
 *
 * The bound the containers apply to their children, applied to the root list for
 * the same reason — a sanity ceiling against an author that loops, set far above
 * any panel a developer can read, because rejecting a legitimately large panel
 * does not produce a smaller one but a fallback one, which answers the
 * developer's question materially worse. Nesting *depth* is bounded separately,
 * by `PANEL_MAX_NODE_DEPTH` in `./validate.ts`: that validator checks it on
 * every internal document, and the authoring schema in `./input.ts` enforces
 * the same constant by construction, as a chain of that many node levels.
 */
export const PANEL_LAYOUT_MAX_NODES = 64;

/**
 * The shape an identifier on a specification must take: one or more characters,
 * none of them whitespace and none of them a control character.
 *
 * Deliberately not pinned to the product's prefixed form. The id aliases in
 * `@debuggen/shared` are unbranded by design, a panel is parsed back out of the
 * store and off the transport by processes that only pass the value through, and
 * a document written by an older build or a fixture is legitimately spelled
 * differently — pinning a prefix here would make this module an arbiter of a
 * vocabulary it does not own, and would make a stored panel unrecoverable for
 * nothing gained. What it *does* refuse is the spellings that break the places
 * an id is used: a blank id, an id with a line break in it, an id carrying a
 * control character.
 */
const PANEL_IDENTIFIER_PATTERN = /^[^\s\p{Cc}]+$/u;

/** Requires at least one non-whitespace character somewhere in a string. */
const NON_BLANK_PATTERN = /\S/;

/**
 * The validator shared by the three identifier fields below.
 *
 * One definition, because a tightened bound has to apply to all three at the
 * same moment: a specification's own id, the session it belongs to, and the id
 * of the panel it supersedes are the same kind of value.
 */
const panelIdentifierSchema = z
  .string()
  .min(1)
  .max(PANEL_ID_MAX_LENGTH)
  .regex(PANEL_IDENTIFIER_PATTERN, {
    error: 'an id must be a single token with no whitespace and no control characters',
  });

/**
 * A schema whose parsed output is the given type, described structurally.
 *
 * The same device `./nodes/viz.ts` uses to prove its schema tuple complete, and
 * structural for the same reason: a schema is effectively invariant in what it
 * parses, because its own refinement callbacks put that type in both an argument
 * and a return position, so a `z.ZodType<T>`-typed target would reject a
 * concrete object schema for having *more* internals than the target names.
 * Matching on the internals' output type instead is covariant, which is what
 * lets a full object schema satisfy "parses a value of this type" while still
 * failing when a field's type is wrong or a required field is missing.
 *
 * Used only in `satisfies` clauses, so the exported schemas keep their precise
 * object types — `./normalize.ts` reads their shapes, `./validate.ts` parses
 * with them and `./json-schema.ts` renders them, and an annotation would erase
 * what all three need.
 */
type SchemaParsing<TOutput> = { readonly _zod: { readonly output: TOutput } };

/*
 * ---------------------------------------------------------------------------
 * Panel metadata
 * ---------------------------------------------------------------------------
 */

/**
 * Facts about how a specification came to exist, as opposed to what it presents.
 *
 * One field today, and the strictness of the schema below keeps it that way
 * until a second is justified: metadata is the place a well-meaning addition
 * would quietly turn into presentation, or into an unevidenced claim about the
 * capture that bypasses the summary's fact type entirely.
 */
export interface PanelMeta {
  /**
   * `true` when this panel was assembled deterministically from the capture's
   * aggregates because a model-authored panel could not be validated.
   *
   * **This flag is the difference between honest degradation and presenting a
   * failure as analysis** (AAP 0.5.5). When a model's panel output fails its
   * schema, the repair loop is exhausted, or semantic validation finds it citing
   * evidence the capture does not hold, the service does not show an error in
   * place of a panel and does not quietly ship the rejected one: it builds a
   * panel from the aggregates it actually has, marks it here, and the renderer
   * draws it under a visible "fallback view" banner so the developer knows the
   * views below are a deterministic summary rather than an answer to their
   * question. A failure is never presented as a successful analysis.
   *
   * Absent means an ordinary generated panel. There is deliberately no default
   * filled in on parse: a stored document must read back exactly as it was
   * written, and a consumer that wants a boolean writes `meta?.fallback ===
   * true`.
   */
  readonly fallback?: boolean | undefined;
}

/**
 * The field schemas of {@link PanelMeta}.
 *
 * The `satisfies` clause is a compile-time proof in both directions: a field
 * added to the interface without a schema leaves a required key of the record
 * type unimplemented, and a schema for a field the interface does not declare is
 * rejected as an excess property.
 */
const panelMetaShape = {
  fallback: z
    .boolean()
    .optional()
    .describe(
      'True when this panel was assembled deterministically from the capture because a generated one could not be validated. The renderer shows such a panel under a visible fallback banner rather than presenting it as an answer.',
    ),
} satisfies Record<keyof PanelMeta, z.ZodType>;

/**
 * The validator for {@link PanelMeta}.
 *
 * Strict, and that is the whole point of declaring it separately: an
 * unrecognised key here would be a channel for exactly the content this schema
 * exists to keep out of metadata — a styling hint, or an assertion about the
 * capture that never passed the summary's evidence requirement.
 */
export const panelMetaSchema = z.strictObject(panelMetaShape) satisfies SchemaParsing<PanelMeta>;

/*
 * ---------------------------------------------------------------------------
 * The specification
 * ---------------------------------------------------------------------------
 */

/**
 * A validated, normalized panel: the document the renderer draws and the store
 * persists.
 *
 * Declared explicitly rather than inferred from the schema below, for the same
 * reason {@link PanelNode} is: this type is consumed by four workspaces —
 * generated and stored by the coordination service, embedded in the transport's
 * panel message, rendered by the shared component library, and mirrored in the
 * editor's view — and an explicit declaration is what keeps the emitted
 * declarations readable and the recursive node tree intact inside them. The two
 * `satisfies` clauses on the schema are what keep the two in step.
 *
 * Every field is `readonly`: a specification is a document that is generated
 * once and then travels. Regenerating a panel produces a *new* document —
 * `panelVersion` incremented, `supersedes` naming the previous one — rather than
 * an edit of the old, so a developer who reopens a session sees the version that
 * answered the question they asked.
 */
export interface PanelSpec {
  /**
   * The document format version: always {@link PANEL_SPEC_VERSION}.
   *
   * Present on the document rather than inferred from the store's schema so that
   * a specification read from anywhere — a row, a transport frame, a fixture —
   * carries its own format with it.
   */
  readonly version: typeof PANEL_SPEC_VERSION;

  /**
   * This panel's identity.
   *
   * Minted by the caller with the shared package's panel-id factory, never
   * inside this package: this module validates a document and has no business
   * creating identity, and a schema that generated one would make two parses of
   * one document produce two different panels.
   */
  readonly id: PanelId;

  /** The session this panel was generated for. */
  readonly sessionId: SessionId;

  /**
   * Which generation of this session's panel this is, counting from 1.
   *
   * A follow-up question does not overwrite the panel that answered the first
   * one. On the existing-evidence path the analysis and panel are regenerated
   * from the capture already held; on the new-capture path fresh evidence is
   * gathered first. Either way the result is stored as `panelVersion n + 1` with
   * {@link PanelSpec.supersedes} naming the panel it replaces, and the transport
   * carries both so a user interface can show that the answer moved on
   * (AAP 0.4.2).
   */
  readonly panelVersion: number;

  /**
   * The id of the panel this one supersedes, on a regeneration.
   *
   * Present exactly when `panelVersion > 1` on that path, and absent on a
   * session's first panel. That invariant is **not** encoded as a cross-field
   * rule on the schema below: version bookkeeping belongs to the service that
   * owns the store, a refinement would vanish from any JSON Schema rendered from
   * this shape, and the check, where it is wanted, belongs in `./validate.ts`
   * where the whole document is in view.
   */
  readonly supersedes?: PanelId | undefined;

  /** The one line at the top of the panel, naming what it is about. */
  readonly title: string;

  /**
   * The panel's summary: optional prose, the observed facts, the likely causes.
   *
   * Reused from `./summary.ts` rather than restated, because that module is
   * where the boundary this product depends on is expressed as types — a fact
   * cannot exist without at least one evidence reference, a hypothesis is a
   * distinct type carrying a confidence, and prose has exactly one field it may
   * occupy and no route out of it.
   */
  readonly summary: PanelSummary;

  /**
   * The panel's content: a forest of nodes, in reading order.
   *
   * May be empty. A fallback panel assembled when nothing could be validated is
   * allowed to carry a summary and no views at all — that is an honest document
   * about a capture that yielded little, and it renders under the fallback
   * banner — whereas rejecting it here would leave the developer with no panel
   * and no explanation. Bounded by {@link PANEL_LAYOUT_MAX_NODES}.
   */
  readonly layout: readonly PanelNode[];

  /** How this panel came to exist; see {@link PanelMeta}. */
  readonly meta?: PanelMeta | undefined;
}

/**
 * The field schemas of {@link PanelSpec}.
 *
 * The `satisfies` clause proves the key sets of the interface and the schema
 * identical — a field on one and not the other does not compile — and the clause
 * on the exported schema proves the parsed output assignable to the interface.
 * Together they are why the explicit declaration above cannot drift from the
 * validator below.
 */
const panelSpecShape = {
  version: z
    .literal(PANEL_SPEC_VERSION)
    .describe('The panel document format version. Always 1 in this release.'),

  id: panelIdentifierSchema.describe("This panel's own id, minted by its author."),

  sessionId: panelIdentifierSchema.describe('The session this panel was generated for.'),

  panelVersion: z
    .int()
    .min(1)
    .describe(
      "Which generation of this session's panel this is, counting from 1. A follow-up question stores its answer as the next version rather than replacing this one.",
    ),

  supersedes: panelIdentifierSchema
    .optional()
    .describe('The id of the panel this one replaces, on a regeneration.'),

  title: z
    .string()
    .min(1)
    .max(PANEL_TITLE_MAX_LENGTH)
    .regex(NON_BLANK_PATTERN, {
      error: 'title must contain a non-whitespace character.',
    })
    .describe('The one line at the top of the panel, naming what it is about.'),

  summary: panelSummarySchema.describe(
    'The panel summary: optional prose, the observed facts with their evidence, and the likely causes with their confidence.',
  ),

  layout: z
    .array(panelNodeSchema)
    .max(PANEL_LAYOUT_MAX_NODES)
    .describe(
      'The panel content as a forest of nodes, in reading order. May be empty when there was nothing to draw.',
    ),

  meta: panelMetaSchema
    .optional()
    .describe('How this panel came to exist, as opposed to what it presents.'),
} satisfies Record<keyof PanelSpec, z.ZodType>;

/**
 * The validator every panel passes before it may be stored, broadcast or drawn.
 *
 * Strict at the top level as well as at every node: after normalisation an
 * unrecognised key on the document is either a field this package removed, in
 * which case the panel was written against a contract that no longer holds, or a
 * dimension its author invented — and a specification that claims to carry
 * something the renderer will never read is worse than one that fails, because
 * it fails silently and on screen.
 *
 * What this schema does **not** decide, deliberately, so that each rule lives
 * exactly once:
 *
 * - whether each node's type is in the node catalog and its data query names a
 *   source that type is allowed to read — `./catalog.ts` is that registry and
 *   `./validate.ts` applies it;
 * - whether node ids are unique and the tree is not absurdly deep —
 *   `./validate.ts`, the only layer that sees a whole document;
 * - whether the cited evidence and the filtered traces exist in the capture at
 *   all — `./semantic.ts`, the only layer that has the capture.
 *
 * A document that passes here is well-formed. It becomes *true* only after the
 * other two.
 */
export const panelSpecSchema = z.strictObject(panelSpecShape) satisfies SchemaParsing<PanelSpec>;

/*
 * ---------------------------------------------------------------------------
 * Non-throwing parser
 * ---------------------------------------------------------------------------
 */

/** The name this module reports for {@link panelSpecSchema} in a rejection. */
const PANEL_SPEC_SCHEMA_NAME = 'panelSpec';

/** The hint offered when a panel specification fails validation. */
const PANEL_SPEC_HINT =
  'A panel specification needs version 1, an id, a session id, a panel version of at least 1, a non-empty title, a summary whose observed facts each cite captured evidence, and a layout of catalogued nodes; no other field is accepted, and every node needs the id the normaliser derives from its position.';

/**
 * Validates an unknown value as a {@link PanelSpec}, without throwing.
 *
 * This is how a document that arrived from somewhere else becomes a typed
 * specification: a normalised panel on its way to being stored, a row read back
 * when a session is reopened, a panel message delivered over the transport, a
 * fixture in a test. None of those is trusted — one of them travelled through a
 * browser — so a specification is parsed at each boundary rather than
 * destructured on arrival.
 *
 * Non-throwing is a requirement rather than a preference. A rejected panel has a
 * defined outcome: the generating stage falls back to a deterministic panel
 * marked {@link PanelMeta.fallback}, and a reader that cannot parse a stored row
 * reports that one panel as unavailable. Neither outcome is "abort the pipeline
 * stage", so the caller inspects the result and continues (AAP 0.5.5).
 *
 * **The error carries the shape of the failure and none of the data that caused
 * it.** Issue paths and codes only, through the single implementation of that
 * rule in `./summary.ts` — because this error is logged, may be persisted with
 * the session, and travels to both user interfaces, while passing through
 * neither the redaction layer nor the outbound model guard on the way. Panel
 * content is model-authored prose about captured runtime data; a component name,
 * a redacted URL or a statement fragment must not be recoverable from a
 * validation failure, and the only way to guarantee that is for the offending
 * value never to enter one (AAP 0.5.2).
 *
 * The code is the panel-validation code from the shared package's closed
 * vocabulary, the same one this package's other parsers use; no code is invented
 * here. A caller at a stage boundary that wants the model-output vocabulary maps
 * it with the shared `mapErr`, and a well-formed panel that cites evidence the
 * capture does not hold is `./semantic.ts`'s distinct code rather than this one.
 *
 * @param value Any value believed to be a normalized panel specification.
 * @returns `ok(spec)` with the parsed document, or `err(error)` describing every
 * issue found, by path and code only.
 */
export function parsePanelSpec(value: unknown): Result<PanelSpec, DebuggenError> {
  const parsed = panelSpecSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    new DebuggenError(
      'PANEL_INVALID',
      `A value did not match the ${PANEL_SPEC_SCHEMA_NAME} schema.`,
      {
        hint: PANEL_SPEC_HINT,
        details: {
          schema: PANEL_SPEC_SCHEMA_NAME,
          issues: describeIssues(parsed.error.issues),
        },
      },
    ),
  );
}
