/**
 * The three containers a generated panel may compose, and nothing else.
 *
 * A panel is a document of nodes. A node either *draws something* — those are
 * the leaves, declared in `./viz.ts` — or *arranges other nodes*, and this
 * module owns the whole of the second category: a titled group, a two-or-more
 * pane split, and a vertical stack. Three, deliberately, and closed: the shared
 * component library implements exactly one component per container, and the
 * node catalog is asserted to mark these three — and only these three — as
 * accepting children. A fourth container added here without a component and a
 * catalog entry fails that assertion rather than degrading quietly.
 *
 * ## Why containers are a closed vocabulary at all
 *
 * The arrangement of a generated panel has to be expressible enough that two
 * panels answering two different questions genuinely differ, and constrained
 * enough that the author of a panel — a language model, validated but not
 * trusted — cannot reach past arrangement into presentation. Those two
 * requirements meet exactly here. Every container below carries structure and
 * labels; none carries spacing, alignment, sizing, density, colour or any other
 * visual value. Those come from the renderer's design tokens and layout
 * primitives, which is what keeps a panel free of hardcoded style values, and
 * what makes "the model authored this layout" a statement about which views sit
 * next to which, never about how they look.
 *
 * That is also why the list is short rather than expressive. A grid, a tab set
 * or a resizable pane would each need a component, a token story, keyboard
 * semantics and a validation rule; a panel that needs one of those today
 * expresses it as a split of stacks, and the vocabulary grows only when a
 * container is added across all four places at once.
 *
 * ## The folder's recursion convention (read before writing `./viz.ts`)
 *
 * Nodes nest, so the node type is recursive, and a recursive type has to be
 * closed in exactly one place. This folder closes it in `../spec.ts`, and the
 * two node modules are shaped to make that possible without a cycle:
 *
 * - **`./viz.ts` exports concrete schemas.** Every visualization node is a leaf
 *   — none accepts children — so its schema needs no knowledge of the node type
 *   and can be a plain value.
 * - **`./layout.ts` exports shape factories** parameterised by the schema of a
 *   child: {@link sectionNodeSchema}, {@link splitNodeSchema},
 *   {@link stackNodeSchema} and the three-at-once {@link layoutNodeSchemasFor}.
 *   A factory needs the child schema, and the child schema is the whole node
 *   union, which lives one level up — so the parameter is how this module stays
 *   below `../spec.ts` instead of importing it back.
 * - **`../spec.ts` closes the loop once**, with a lazy self-reference:
 *
 *   ```ts
 *   export type PanelNode =
 *     | VisualizationNode
 *     | SectionNodeOf<PanelNode>
 *     | SplitNodeOf<PanelNode>
 *     | StackNodeOf<PanelNode>;
 *
 *   export const panelNodeSchema: z.ZodType<PanelNode> = z.lazy(() =>
 *     z.discriminatedUnion('type', [
 *       ...VISUALIZATION_NODE_SCHEMAS,
 *       ...layoutNodeSchemasFor(panelNodeSchema),
 *     ]),
 *   );
 *   ```
 *
 * The generic interfaces {@link SectionNodeOf}, {@link SplitNodeOf} and
 * {@link StackNodeOf} exist for the first half of that snippet and are not
 * decoration. Inference through a generic factory alone does not produce a
 * recursive type: the emitted declarations would resolve a container's children
 * to `any`, and every consumer that walks a panel — the validators here, the
 * service's panel generation, the renderer's node dispatch — would lose type
 * safety at the first level of nesting without a single error being reported.
 * Declaring the fields explicitly and annotating the schema with the declared
 * type is what keeps `dist/index.d.ts` honest.
 *
 * ## What this module deliberately does not own
 *
 * - **Which data sources a node may read.** Containers read none — they hold
 *   nodes, not evidence — so no container below accepts a source, a filter, a
 *   sort, a limit, an offset, a query or a metric list. The per-type source
 *   allowances of the *leaves* are the node catalog's single registry.
 * - **Node identity.** A node's `id` is required here because it is required in
 *   the normalized form this module describes, but it is derived by the
 *   normaliser from the node's position in the layout, and the authoring schema
 *   rejects an authored one. Uniqueness across a panel is the syntactic
 *   validator's check; a schema can only see one node at a time.
 * - **Nesting depth.** The excessive-depth rule belongs to the syntactic
 *   validator, which sees the whole document and owns the one depth constant;
 *   the authoring schema in `../input.ts` builds its node chain from that same
 *   constant. A depth limit restated here would be a second rule tuned
 *   separately from the first, and the two would disagree the moment either
 *   moved.
 *
 * ## Constraints every declaration below works under
 *
 * - **Environment-neutral.** This package is built with no platform
 *   assumptions, because the local service, the DevTools panel and the editor
 *   webview all load it: no platform builtin, no browser global, and no
 *   import-time side effect. Every export here is a frozen vocabulary, a
 *   constant, a schema, a pure factory or a type.
 * - **JSON-Schema-representable.** The authoring schema that mirrors these
 *   shapes is rendered into a versioned prompt file by a renderer configured to
 *   fail on anything it cannot represent, so every constraint below is
 *   declarative — `min`, `max`, `literal`, `enum`, `describe` — and surfaces to
 *   the author as `minItems`, `maxItems`, `const`, `enum` and `description`. A
 *   refinement would still be enforced at runtime but would vanish from the
 *   rendered document, turning an expressible limit into a parse failure and a
 *   wasted repair round-trip. There is none below, and none is needed.
 * - **No shape change.** No `.transform()`, no `.preprocess()` and no
 *   `.default()`: a specification is stored and replayed verbatim, so a parsed
 *   node must equal the authored one field for field. Filling a value in is the
 *   deterministic normaliser's job, and the one value a consumer may need to
 *   assume is exported as a constant instead — see
 *   {@link DEFAULT_SPLIT_DIRECTION}.
 *
 * @example
 * ```ts
 * // Closing the recursion for a single-leaf node type, which is what
 * // `../spec.ts` does for the full node vocabulary. The three containers are
 * // named one by one rather than through the LayoutNodeOf alias: only an
 * // interface reference is deferred by the compiler, so routing the recursion
 * // through a second type alias is rejected outright (TS2456, "type alias
 * // circularly references itself"). See LayoutNodeOf for what it is for.
 * type Node = LeafNode | SectionNodeOf<Node> | SplitNodeOf<Node> | StackNodeOf<Node>;
 *
 * const nodeSchema: z.ZodType<Node> = z.lazy(() =>
 *   z.discriminatedUnion('type', [leafNodeSchema, ...layoutNodeSchemasFor(nodeSchema)]),
 * );
 * ```
 */

import { z } from 'zod';

import {
  panelNodeDescriptionSchema,
  panelNodeIdSchema,
  panelNodeTitleSchema,
  type PanelNodeId,
} from './query.js';

/*
 * ---------------------------------------------------------------------------
 * The container vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * Every container a panel may compose, in the order this package fixes.
 *
 * `../spec.ts` concatenates this tuple with the visualization tuple from
 * `./viz.ts` to compose the full node-type vocabulary, and the node catalog is
 * keyed by that vocabulary — its own test asserts the catalog's key set equals
 * it exactly. So this is the *only* place the three container names are typed:
 * a second list somewhere else is the drift that assertion exists to catch, and
 * the one it cannot prevent is a list nobody derived.
 *
 * The order runs from the most to the least structural — a group, then a
 * division, then a sequence — and it is the order the rendered JSON Schema
 * offers the author. Extending it means adding a schema below, a catalog entry
 * and a renderer component in the same change.
 *
 * Frozen: a read-only vocabulary shared by four processes.
 */
export const LAYOUT_NODE_TYPES = Object.freeze([
  /**
   * A titled group of one or more nodes: the container that gives a part of a
   * panel a heading and a boundary.
   */
  'section',
  /**
   * Two or more nodes placed side by side (or one above the other), for views
   * that are read against each other.
   */
  'split',
  /**
   * One or more nodes in vertical sequence, for views that are read in order.
   */
  'stack',
] as const);

/**
 * One member of the closed container vocabulary.
 *
 * Derived from {@link LAYOUT_NODE_TYPES}, so the runtime tuple and the static
 * type cannot disagree. `../spec.ts` unions it with the visualization node type
 * to form the catalog's key domain.
 */
export type LayoutNodeType = (typeof LAYOUT_NODE_TYPES)[number];

/** Widened view of {@link LAYOUT_NODE_TYPES} used by {@link isLayoutNodeType}. */
const LAYOUT_NODE_TYPE_VALUES: readonly string[] = LAYOUT_NODE_TYPES;

/**
 * Narrow an untrusted value to a {@link LayoutNodeType} by membership in
 * {@link LAYOUT_NODE_TYPES}.
 *
 * For the places that have to classify a node type before a schema is
 * available: a node read back out of a stored panel, a type name arriving on
 * its own. It answers "is this a container?", which is the question a consumer
 * asks before descending into children, and it answers it without anyone
 * having to spell the three names again.
 */
export function isLayoutNodeType(value: unknown): value is LayoutNodeType {
  return typeof value === 'string' && LAYOUT_NODE_TYPE_VALUES.includes(value);
}

/**
 * The container discriminator as a schema, described for the author of a panel.
 *
 * Exported for the consumers that validate a bare type name — a catalog lookup
 * being checked, a user-interface control offering the containers — rather than
 * a whole node. A node's own `type` field is the narrower `z.literal` on each
 * schema below, because a discriminated union needs a literal per option.
 */
export const layoutNodeTypeSchema = z
  .enum(LAYOUT_NODE_TYPES)
  .describe(
    'Which container this node is: a titled group of nodes, a division into two or more panes read against each other, or a vertical sequence of nodes read in order. A container arranges other nodes and reads no data of its own.',
  );

/*
 * ---------------------------------------------------------------------------
 * Split direction
 * ---------------------------------------------------------------------------
 */

/**
 * The axes a split may divide along.
 *
 * `horizontal` places its panes side by side, `vertical` one above the other.
 * Two values and no more: a division is along one axis or the other, and
 * anything finer is a matter of proportion, which is presentation and therefore
 * the renderer's to decide from its tokens.
 *
 * Frozen: a read-only vocabulary.
 */
export const SPLIT_DIRECTIONS = Object.freeze(['horizontal', 'vertical'] as const);

/** One member of {@link SPLIT_DIRECTIONS}. */
export type SplitDirection = (typeof SPLIT_DIRECTIONS)[number];

/**
 * The axis a consumer assumes when a split names none: **`horizontal`**.
 *
 * Exported as a constant precisely so that it is *not* a schema default. A
 * default on {@link splitNodeSchema} would materialise `direction:
 * 'horizontal'` on a node that never said it, so a parsed node would no longer
 * equal the authored one — which defeats the normaliser's exact-object
 * assertion, hides whether a field was authored or filled in, and would make
 * two stored panels differ from each other purely by which version of this file
 * parsed them. The assumption belongs to the side that renders a split, and
 * that side has this constant, so both sides agree on the value without the
 * document being rewritten.
 */
export const DEFAULT_SPLIT_DIRECTION: SplitDirection = 'horizontal';

/**
 * The `direction` field's schema, described for the author of a panel.
 *
 * Exported separately from {@link splitNodeSchema} because the authoring schema
 * accepts the same field on an authored split and must validate it with exactly
 * this definition rather than a second, drifting one.
 */
export const splitDirectionSchema = z
  .enum(SPLIT_DIRECTIONS)
  .describe(
    `Which axis this split divides along: 'horizontal' places its panes beside each other, 'vertical' places them one above the other. Optional; omit it to accept the '${DEFAULT_SPLIT_DIRECTION}' arrangement.`,
  );

/*
 * ---------------------------------------------------------------------------
 * Child-count bounds
 * ---------------------------------------------------------------------------
 */

/**
 * How many children each container needs to mean anything: **1** for a section,
 * **2** for a split, **1** for a stack.
 *
 * Each minimum is the point below which the container is not the container it
 * claims to be. A section or a stack with no children is a heading over
 * nothing, which renders as an empty region that the developer has to read as
 * either "no evidence" or "a bug" with no way to tell which. A split with one
 * pane is not a division at all: it renders as its only child, misreports the
 * intent of the panel, and is a strictly worse spelling of that child on its
 * own.
 *
 * Declared as one record rather than three loose constants so that the schemas
 * below, the prose in their descriptions and any consumer assembling a panel
 * deterministically all read the same numbers.
 */
export const LAYOUT_NODE_MIN_CHILDREN = Object.freeze({
  section: 1,
  split: 2,
  stack: 1,
} as const) satisfies Readonly<Record<LayoutNodeType, number>>;

/**
 * Most children any one container accepts: **64**.
 *
 * A sanity bound against pathological output, deliberately far above any
 * plausible panel — a panel a developer can read holds a handful of views per
 * container, not dozens — and it exists for the case where an author loops. A
 * tight bound here would be the worse failure: it would reject a legitimate
 * generated panel, and a rejected panel is not a smaller panel but a fallback
 * one, which is a materially worse answer to the developer's question than a
 * slightly crowded section. Nesting depth is bounded separately, by the
 * syntactic validator's `PANEL_MAX_NODE_DEPTH`: the validator checks it on a
 * whole internal document, which no one-node schema here can see, and the
 * authoring schema enforces the same constant by construction, as a chain of
 * that many node levels.
 */
export const LAYOUT_NODE_MAX_CHILDREN = 64;

/*
 * ---------------------------------------------------------------------------
 * The node types, declared explicitly
 *
 * These are the halves of the recursive node type that `../spec.ts` assembles
 * (see the module documentation above for the full snippet). Each is generic in
 * the child node so that the parent module can supply its own union and get a
 * genuinely recursive type rather than the `any` an inferred one would decay
 * to.
 * ---------------------------------------------------------------------------
 */

/**
 * The fields every container carries regardless of how it arranges its
 * children: an identity and two optional labels.
 *
 * Declared once here, as the primitives it is built from are declared once in
 * `./query.js`, so that a tightened bound or a renamed field applies to all
 * three containers at the same moment. Exported because a consumer that walks a
 * panel generically — a host assigning keys, a validator collecting ids — wants
 * the common part without naming each container.
 *
 * Every field is `readonly`: a specification is a document, and the three
 * processes that carry one around read it rather than edit it. Regenerating a
 * panel produces a new document with a new version instead.
 */
export interface LayoutNodeBase {
  /**
   * This node's identity within its panel.
   *
   * Required, because the shape described here is the normalized one. It is the
   * node's position in the layout rather than a random value, so it is stable
   * across regenerations of the same panel and safe to use as a list key, a
   * selection target and a fragment.
   */
  readonly id: PanelNodeId;

  /**
   * Optional heading for this container.
   *
   * A label the developer reads, never a finding: an assertion about what the
   * capture demonstrates has to be a fact with evidence attached, which is a
   * different type in a different module.
   */
  readonly title?: string | undefined;

  /**
   * Optional sentence under the heading, saying what the group below shows or
   * how to read it. Presentation only, on the same footing as the title.
   */
  readonly description?: string | undefined;
}

/**
 * A titled group of nodes, generic in the node type it contains.
 *
 * The container to reach for when a part of a panel is about one thing and
 * wants a boundary and a heading around it.
 *
 * @typeParam TChild The panel's node type, supplied by `../spec.ts`.
 */
export interface SectionNodeOf<TChild> extends LayoutNodeBase {
  /** Discriminator. */
  readonly type: 'section';

  /**
   * The nodes this section groups, in the order they are read. At least one,
   * and at most {@link LAYOUT_NODE_MAX_CHILDREN}.
   */
  readonly children: readonly TChild[];
}

/**
 * A division of the space into two or more panes, generic in the node type it
 * contains.
 *
 * The container to reach for when two views are read *against* each other
 * rather than one after the other.
 *
 * @typeParam TChild The panel's node type, supplied by `../spec.ts`.
 */
export interface SplitNodeOf<TChild> extends LayoutNodeBase {
  /** Discriminator. */
  readonly type: 'split';

  /**
   * Which axis to divide along. Absent means {@link DEFAULT_SPLIT_DIRECTION};
   * nothing fills the field in, so an authored node and a parsed one agree.
   */
  readonly direction?: SplitDirection | undefined;

  /**
   * The panes, in order. At least {@link LAYOUT_NODE_MIN_CHILDREN}.split — one
   * pane is not a division — and at most {@link LAYOUT_NODE_MAX_CHILDREN}.
   */
  readonly children: readonly TChild[];
}

/**
 * A vertical sequence of nodes, generic in the node type it contains.
 *
 * The container to reach for when views are read in order. Verticality is the
 * node's meaning rather than an option on it: a sequence read along the other
 * axis is a {@link SplitNodeOf}.
 *
 * @typeParam TChild The panel's node type, supplied by `../spec.ts`.
 */
export interface StackNodeOf<TChild> extends LayoutNodeBase {
  /** Discriminator. */
  readonly type: 'stack';

  /**
   * The nodes in the sequence, in the order they are read. At least one, and at
   * most {@link LAYOUT_NODE_MAX_CHILDREN}.
   */
  readonly children: readonly TChild[];
}

/**
 * Any container, generic in the node type it contains.
 *
 * For a consumer that has already narrowed a node to a container — by
 * {@link isLayoutNodeType}, or by the catalog's children flag — and wants to
 * read `children` without a further switch.
 *
 * **Not for closing the recursion.** A node type that defines itself in terms
 * of this alias — `type PanelNode = VisualizationNode | LayoutNodeOf<PanelNode>`
 * — is rejected by the compiler as TS2456, "type alias circularly references
 * itself": a reference to an *interface* is deferred and may therefore be
 * circular, while a reference through a second type alias must be resolved
 * eagerly. That is precisely why {@link SectionNodeOf}, {@link SplitNodeOf} and
 * {@link StackNodeOf} are declared as interfaces and are named one by one in
 * `../spec.ts`, and it is measured rather than assumed: the union above is a
 * convenience for consumers, and substituting it into the definition of the
 * node type is the one place it does not work.
 *
 * @typeParam TChild The panel's node type, supplied by `../spec.ts`.
 */
export type LayoutNodeOf<TChild> =
  SectionNodeOf<TChild> | SplitNodeOf<TChild> | StackNodeOf<TChild>;

/*
 * ---------------------------------------------------------------------------
 * The schema factories
 * ---------------------------------------------------------------------------
 */

/**
 * The schemas for the fields of {@link LayoutNodeBase}, shared by all three
 * containers.
 *
 * The `satisfies` clause is a compile-time proof rather than a decoration, and
 * it fails in both directions: a field added to {@link LayoutNodeBase} without
 * a schema here leaves a required key of the record type unimplemented, and a
 * schema here for a field that interface does not declare is rejected. The
 * declared type and the validator therefore cannot drift apart, which matters
 * because the type is what `../spec.ts` annotates its recursive schema with —
 * the one place where a mismatch would surface as an assignability error a long
 * way from its cause.
 *
 * The three schema instances are shared by the objects below rather than
 * rebuilt per container. A schema is immutable, so sharing is safe, and it is
 * what guarantees the three containers validate an id, a title and a
 * description identically.
 */
const layoutNodeBaseShape = {
  id: panelNodeIdSchema,
  title: panelNodeTitleSchema.optional(),
  description: panelNodeDescriptionSchema.optional(),
} satisfies Record<keyof LayoutNodeBase, z.ZodType>;

/**
 * Builds the schema for a titled group of nodes.
 *
 * A factory rather than a value because the shape contains the node type, which
 * is recursive and closed one level up: see the module documentation for the
 * convention and for why this module must not import `../spec.ts` back.
 *
 * Strict, as every node schema in this package is: after normalisation an
 * unrecognised key is either a field this module removed — in which case the
 * panel was written against a contract that no longer holds and must be
 * regenerated rather than half-honoured — or a dimension the author invented,
 * which would be silently ignored while the panel went on claiming to present
 * it. Strictness is also what enforces the absences this container depends on:
 * a container reads no evidence, so a source, a filter, a sort, a limit, an
 * offset, a query or a metric list is rejected here rather than accepted and
 * dropped; and it carries no presentation, so a spacing, alignment, sizing or
 * colour field is rejected for the same reason.
 *
 * The return type is deliberately inferred. An annotation widened to a plain
 * schema type would erase the literal discriminator from the object's
 * internals, and a discriminated union cannot be built from options whose
 * discriminator it can no longer see — the union would have to fall back to a
 * plain union, whose failures report every branch's issues instead of the one
 * that matched the node's type.
 *
 * @typeParam TChild Schema of the node type this container may contain.
 * @param child Schema every child of the returned container is validated with.
 * @returns A strict object schema for one `section` node.
 */
export function sectionNodeSchema<TChild extends z.ZodType>(child: TChild) {
  return z
    .strictObject({
      type: z.literal('section'),
      ...layoutNodeBaseShape,
      children: z
        .array(child)
        .min(LAYOUT_NODE_MIN_CHILDREN.section)
        .max(LAYOUT_NODE_MAX_CHILDREN)
        .describe(
          `The nodes this section groups, in reading order. At least ${String(LAYOUT_NODE_MIN_CHILDREN.section)} and at most ${String(LAYOUT_NODE_MAX_CHILDREN)}; a heading over no nodes shows the developer an empty region they cannot interpret.`,
        ),
    })
    .describe(
      'A titled group of nodes. Use it to give one part of a panel a heading and a boundary, so that each question the panel answers is visibly its own section. It arranges nodes only and reads no data itself.',
    );
}

/**
 * Builds the schema for a division of the space into two or more panes.
 *
 * Same convention, same strictness and the same reason for an inferred return
 * type as {@link sectionNodeSchema}; the difference is the minimum child count
 * and the optional axis.
 *
 * @typeParam TChild Schema of the node type this container may contain.
 * @param child Schema every child of the returned container is validated with.
 * @returns A strict object schema for one `split` node.
 */
export function splitNodeSchema<TChild extends z.ZodType>(child: TChild) {
  return z
    .strictObject({
      type: z.literal('split'),
      ...layoutNodeBaseShape,
      direction: splitDirectionSchema.optional(),
      children: z
        .array(child)
        .min(LAYOUT_NODE_MIN_CHILDREN.split)
        .max(LAYOUT_NODE_MAX_CHILDREN)
        .describe(
          `The panes of this split, in order along its axis. At least ${String(LAYOUT_NODE_MIN_CHILDREN.split)}, because a division with one pane is just that pane, and at most ${String(LAYOUT_NODE_MAX_CHILDREN)}.`,
        ),
    })
    .describe(
      'Two or more nodes placed along one axis. Use it when the views are read against each other — a claim beside the evidence for it, a ranking beside the detail of the selected row — rather than one after another.',
    );
}

/**
 * Builds the schema for a vertical sequence of nodes.
 *
 * Same convention, same strictness and the same reason for an inferred return
 * type as {@link sectionNodeSchema}. It takes no axis: a sequence read along the
 * other axis is a split, and an axis here would give one arrangement two
 * spellings, which a validator cannot choose between and a reviewer of a stored
 * panel cannot tell apart.
 *
 * @typeParam TChild Schema of the node type this container may contain.
 * @param child Schema every child of the returned container is validated with.
 * @returns A strict object schema for one `stack` node.
 */
export function stackNodeSchema<TChild extends z.ZodType>(child: TChild) {
  return z
    .strictObject({
      type: z.literal('stack'),
      ...layoutNodeBaseShape,
      children: z
        .array(child)
        .min(LAYOUT_NODE_MIN_CHILDREN.stack)
        .max(LAYOUT_NODE_MAX_CHILDREN)
        .describe(
          `The nodes of this sequence, in reading order. At least ${String(LAYOUT_NODE_MIN_CHILDREN.stack)} and at most ${String(LAYOUT_NODE_MAX_CHILDREN)}.`,
        ),
    })
    .describe(
      'One or more nodes in vertical sequence. The default way to put several views in a section: each is read after the one above it, and the arrangement carries no other meaning.',
    );
}

/**
 * Builds all three container schemas for one child node type, as a tuple ready
 * to be spread into a discriminated union.
 *
 * This is the function `../spec.ts` calls, and it exists so that closing the
 * recursion is a single expression that cannot silently omit a container:
 *
 * ```ts
 * export const panelNodeSchema: z.ZodType<PanelNode> = z.lazy(() =>
 *   z.discriminatedUnion('type', [
 *     ...VISUALIZATION_NODE_SCHEMAS,
 *     ...layoutNodeSchemasFor(panelNodeSchema),
 *   ]),
 * );
 * ```
 *
 * Passing the union's own schema as `child` is what makes a panel a tree, and
 * it is safe despite the apparent cycle because the union is built lazily: the
 * reference is read when the first node is parsed, not while the schema is
 * being constructed.
 *
 * The tuple is ordered as {@link LAYOUT_NODE_TYPES} is, and its length is
 * fixed by that tuple: three containers, three schemas, checked by the
 * assembled union rejecting any node type the catalog does not carry.
 *
 * @typeParam TChild Schema of the node type the containers may contain.
 * @param child Schema every child of every returned container is validated
 * with — in the recursive case, the whole node union.
 * @returns The `section`, `split` and `stack` schemas, in that order.
 */
export function layoutNodeSchemasFor<TChild extends z.ZodType>(child: TChild) {
  return [sectionNodeSchema(child), splitNodeSchema(child), stackNodeSchema(child)] as const;
}
