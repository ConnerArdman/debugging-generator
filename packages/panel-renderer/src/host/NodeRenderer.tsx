/**
 * `host/NodeRenderer` — the recursive dispatcher that turns the nodes of a
 * validated panel specification into elements.
 *
 * ## The one job
 *
 * For each node: look its `type` up in the component registry, render the
 * component the registry paired with that type, and — for a container — render
 * the node's `children` through this module again. That is the whole of it.
 * The per-type work of mapping a node onto a component's own props lives in
 * `./registry`, which is where the pairing is reviewed; this module knows only
 * the uniform contract that every registry entry accepts, so adding a node type
 * to the schema's catalogue and the registry needs no edit here.
 *
 * ## What this module deliberately does NOT do
 *
 * - **It does not validate.** A specification is parsed by
 *   `@debuggen/panel-schema` and, for a generated panel, checked against the
 *   capture it claims to describe, before it may be stored, broadcast or drawn.
 *   By the time a node reaches this file, that has happened.
 * - **It does not mutate or repair.** No query field is defaulted, narrowed or
 *   reordered, no node is dropped and no label is invented. A panel on screen
 *   has to be the panel the coordination service validated and stored, so every
 *   field below is read and none is written.
 * - **It reaches no transport.** The evidence behind a node arrives through that
 *   component's own `useQuery` against the ambient `DataProvider`, and an
 *   interaction leaves through the ambient `PanelActions` (AAP 0.1.2, 0.4.2).
 *   There is no `fetch`, no socket, no message port and no host API in this
 *   file, and no provider or callback prop either — the host mounts both
 *   contexts once, around the whole panel.
 * - **It holds nothing.** No state, no hook, no effect, no memoization. A
 *   memoized node is a node that can stay on screen after the specification
 *   behind it has been replaced, and this package's render behaviour is
 *   something the product reports on rather than something the renderer should
 *   smooth over.
 *
 * ## A node type with no component is an error ON SCREEN, never a blank area
 *
 * AAP 0.6.2 is explicit: "a node type with no component is a validation failure
 * raised by `packages/panel-schema/src/validate.ts` before rendering, never a
 * blank area". Both halves bind this file. The first says a miss here cannot
 * happen through the supported path — an unknown node type is rejected by the
 * validator — so the remaining ways to reach one are all defects: a stored
 * panel written by a newer vocabulary and read back, a caller that rendered a
 * specification it never validated, or a catalogue entry added without a
 * registry component. The second says what a defect must look like: this module
 * renders {@link ErrorState}, naming the node type and the node's id, inside a
 * wrapper whose stylesheet rule gives it the room the visualization would have
 * occupied.
 *
 * It must not return `null`, an empty fragment or a substituted component, and
 * it must not read as "no data": a failure is never presented as a successful
 * result (AAP 0.5.5). "No data" belongs to a component whose query legitimately
 * resolved to nothing, which is that component's own empty state.
 *
 * There is deliberately no error boundary. One that rendered nothing would
 * dress a failure as success, and one that rendered a message would absorb the
 * stack a developer needs; a component that throws while drawing is a defect
 * that has to reach the surface's own diagnostics, and the failure this file
 * *does* own — the registry miss — is handled explicitly below.
 *
 * ## Headings belong to the container, and are written once here
 *
 * The thirteen leaf components draw no heading. They take `node.title` as an
 * accessible name for the grid, list or figure they render and nothing more,
 * because every one of the sixteen node types carries the same optional
 * `title`/`description` pair and rendering it in thirteen places would give a
 * titled node two headings and an outline level no component can place. So a
 * *labelled leaf* is wrapped in `../layout/Section` here — once, for all of
 * them — while a *container's* own labels are forwarded by that container's
 * registry adapter, whose layout primitive already renders them.
 *
 * The outline depth this module tracks is the depth of the headings it owns:
 * {@link NodeRendererProps.headingLevel} is the level a labelled leaf's heading
 * sits at, and the children of a container whose title has text are rendered
 * one level deeper, clamped at the deepest legal level. The containers' own
 * headings are at their layout primitives' defaults, which the uniform registry
 * contract carries no way to override; tracking depth anyway is what keeps the
 * levels this module emits from skipping one, and a skipped level is the
 * failure that actually costs a screen-reader user their sense of structure.
 *
 * ## Children are an ARRAY, never a fragment
 *
 * `../layout/Split` positions its panes by index over `Children.toArray(children)`,
 * and a fragment counts as **one** entry there: handing a division its children
 * inside a fragment would collapse every pane into the first and silently
 * misalign `weights`. {@link renderPanelNodes} is therefore a function that
 * returns `ReactElement[]` rather than a list *component*, and its result is
 * spread into a container as the array it is. The same function is what a host
 * renders a specification's `layout` with, so the layout and every nested level
 * go through one implementation.
 *
 * ## The dispatched component is data, so it is `createElement`
 *
 * The wrappers below are JSX, because they are markup this file wrote. The
 * component a node dispatches to is not: it is a value resolved from the
 * registry at render time, exactly as `./registry` resolves its own components
 * with `createElement` — "which is also what the automatic JSX runtime would
 * have produced". Spelling the dispatch as a call rather than as an element
 * with a capitalised variable says that much in the syntax, and it keeps
 * `eslint-plugin-react-hooks`'s static-component guarantee meaningful for the
 * markup that genuinely is markup instead of suppressing it with a comment.
 * The identity of what is dispatched to is stable either way: the registry's
 * entries are module constants, so a node type resolves to the same component
 * on every render and nothing inside a view is remounted by this dispatch.
 *
 * ## Keys are path-derived
 *
 * A node's key is the document path that reaches it, joined with `.` —
 * `layout.0`, `layout.0.children.1` — which is unique by construction. For a
 * normalized panel that string *is* the node's id, because the normaliser
 * derives an id from exactly this path, so the keys read as ids in practice
 * while staying collision-free for a specification that reached the renderer
 * with duplicate ids (which validation forbids, and which would otherwise cost
 * a React key warning and a confused reconciliation). The identity reported to
 * `PanelActions` is a separate value and always the node's own `id`: that is
 * what the specification named it and what a stored panel's evidence references
 * point at.
 *
 * ## Appearance is two class names and no CSS value
 *
 * `../styles/components.css` implements both, under its
 * `host/PanelHost.tsx and host/NodeRenderer.tsx` heading:
 *
 *   `dg-panel__node`        the wrapper this module emits around every node. It
 *                           owns no appearance — a `section` node renders its
 *                           own container inside it and a bare visualization
 *                           renders straight onto the panel surface — but it
 *                           does carry the column flow and the zero minimum
 *                           inline size that let a wide table or timeline
 *                           shrink inside a division instead of forcing it
 *                           open.
 *   `dg-panel__node-error`  added to that wrapper for the failure above. Its
 *                           minimum block size is what makes an unrenderable
 *                           node occupy the room its visualization would have,
 *                           which is the mechanical half of "never a blank
 *                           area".
 *
 * There is no inline style, no colour, no length and no font in this file, and
 * no raw interactive, tabular or heading element: the heading of a labelled leaf
 * is `../layout/Section`'s, and the failure is `../primitives/ErrorState`'s
 * (AAP 0.6.4).
 *
 * Relative specifiers are extensionless, as everywhere under `src/**` of this
 * package: it resolves with `moduleResolution: "bundler"`, unlike the
 * `.js`-suffixed convention of the Node-targeted packages.
 *
 * @module
 */

import {
  PANEL_CHILDREN_FIELD,
  PANEL_LAYOUT_PATH_ROOT,
  catalogEntryFor,
} from '@debuggen/panel-schema';
import type { PanelNode, PanelNodePath } from '@debuggen/panel-schema';
import type { DebuggenErrorCode } from '@debuggen/shared';
import { createElement } from 'react';
import type { ReactElement } from 'react';

import { Section } from '../layout/Section';
import { ErrorState } from '../primitives/ErrorState';
import type { HeadingLevel } from '../primitives/Heading';
import { componentForNodeType } from './registry';

/*
 * ---------------------------------------------------------------------------
 * Class names and wording
 * ---------------------------------------------------------------------------
 */

/** The wrapper class every rendered node carries. */
const NODE_CLASS = 'dg-panel__node';

/**
 * The wrapper class of a node that could not be rendered, composed onto
 * {@link NODE_CLASS} rather than replacing it.
 *
 * Both classes, so the wrapper stays findable as a node wrapper — one per node,
 * whatever happened inside it — while the stylesheet's minimum block size
 * applies. Written as one literal rather than through `clsx`, because both
 * parts are constants: there is no condition to compose here, and a helper call
 * would only hide that.
 */
const NODE_FAILURE_CLASS = `${NODE_CLASS} dg-panel__node-error`;

/**
 * The first line of the failure state.
 *
 * Stated rather than left to the error primitive's generic default: nothing was
 * *loaded* here, so "could not load this view" would misdescribe a node the
 * renderer has no component for.
 */
const FAILURE_TITLE = 'Could not render this part of the panel';

/**
 * The code the failure state chips, from the closed vocabulary
 * `@debuggen/shared` owns.
 *
 * `PANEL_INVALID` is the product's code for a specification that should not have
 * passed validation, which is exactly what an unrenderable node is — the
 * annotation is what proves the string is a member of that vocabulary rather
 * than a code invented here, and it costs a type-only import.
 */
const FAILURE_CODE: DebuggenErrorCode = 'PANEL_INVALID';

/*
 * ---------------------------------------------------------------------------
 * Outline depth
 * ---------------------------------------------------------------------------
 */

/**
 * The level a labelled leaf's heading sits at when the caller states none:
 * **2**, the level `../layout/Section` itself defaults to, so a leaf wrapped
 * here and a `section` node reach the outline at the same depth.
 */
const DEFAULT_HEADING_LEVEL: HeadingLevel = 2;

/** The deepest heading level the document outline has, and the clamp's ceiling. */
const DEEPEST_HEADING_LEVEL: HeadingLevel = 6;

/**
 * The heading level for the children of a container whose own title is at
 * `level`.
 *
 * One step deeper, clamped, exactly as `../layout/SummaryHeader` clamps its
 * regions: a generated panel may nest arbitrarily and a level of `7` is not an
 * element, so the bottom of the range duplicates one level rather than emitting
 * a heading that no assistive technology announces.
 *
 * @param level The level of the container's own heading.
 * @returns The level its labelled children render at.
 */
function nextHeadingLevel(level: HeadingLevel): HeadingLevel {
  return level >= DEEPEST_HEADING_LEVEL ? DEEPEST_HEADING_LEVEL : ((level + 1) as HeadingLevel);
}

/*
 * ---------------------------------------------------------------------------
 * Reading a node
 * ---------------------------------------------------------------------------
 */

/**
 * Whether an optional label carries something to render.
 *
 * Absent, empty and whitespace-only are one case, which is the rule the three
 * layout primitives apply to the same two fields: a blank title must leave a
 * container unnamed rather than produce an empty heading, so a blank title must
 * not cause a leaf to be wrapped in a container either.
 *
 * Module-private, as the identical predicate is in each layout primitive: it is
 * two comparisons over a string and nothing about it is design-system
 * vocabulary.
 *
 * @param value The label as the specification carries it, if at all.
 * @returns `true` when the value is a string with a non-whitespace character.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * The children of a container node, or `undefined` for a node this module
 * cannot read children from.
 *
 * The *decision* about containment is the catalogue's — {@link
 * NodeRenderer} reads `supportsChildren`, because containment is a fact the
 * schema owns and a renderer that re-derived it from a list of type names would
 * be a second source for it. This function is the type-safe *read* that the
 * decision needs: a predicate applied to `node.type` does not narrow `node`
 * itself, so the three container types are named in a switch, which is the only
 * construction the compiler uses to reach `children` without a cast.
 *
 * `undefined` for every other type is therefore not "this is a leaf" — the
 * caller already knows that from the catalogue — but "the catalogue calls this a
 * container and this module has no read for it", which can only mean the
 * vocabulary grew a fourth container. The caller renders that as a visible
 * failure instead of dropping a subtree silently.
 *
 * @param node The node whose children are wanted.
 * @returns Its children, or `undefined` when this module cannot read them.
 */
function containerChildren(node: PanelNode): readonly PanelNode[] | undefined {
  switch (node.type) {
    case 'section':
    case 'split':
    case 'stack':
      return node.children;

    default:
      return undefined;
  }
}

/**
 * The node itself, serialised for the failure state, or `undefined` when it
 * cannot be serialised.
 *
 * The error primitive renders what was asked for and never serialises anything,
 * by its own documented contract: the inside of a failure renderer is the worst
 * place in a product to throw, because the render that was reporting a problem
 * would fail and leave the reader an empty region. So the serialisation happens
 * here, where the value's type is known, and a failure of it is handled — a node
 * arrives parsed from JSON and cannot be cyclic, but a hand-built object with a
 * throwing accessor could be, and losing the detail is strictly better than
 * losing the message.
 *
 * Pretty-printed, which is the form that primitive expects, and unbounded: a
 * node is a handful of fields, and a specification carries no captured value —
 * every query in it names a prepared view, so there is nothing here to redact.
 *
 * @param node The node that could not be rendered.
 * @returns The node as indented JSON, or `undefined` if that failed.
 */
function describeNode(node: PanelNode): string | undefined {
  try {
    return JSON.stringify(node, undefined, 2);
  } catch {
    return undefined;
  }
}

/**
 * The document path that reaches a node, as the key React identifies it by.
 *
 * Joined with `.`, which is the form the normaliser derives a node id in, so a
 * normalized panel's keys and its ids coincide without this module reading an
 * id that a malformed specification could have duplicated.
 *
 * @param path The node's path within its specification.
 * @returns The key for that position.
 */
function pathKey(path: PanelNodePath): string {
  return path.join('.');
}

/**
 * Renders the failure a node type with no component must show.
 *
 * A plain function rather than a component: it takes no props of its own, holds
 * nothing, and inlining the element at both call sites would be the same
 * markup written twice.
 *
 * @param node The node that could not be rendered.
 * @param message What went wrong, in one sentence.
 * @returns The wrapper and the error state inside it.
 */
function renderNodeFailure(node: PanelNode, message: string): ReactElement {
  return (
    <div className={NODE_FAILURE_CLASS}>
      <ErrorState
        title={FAILURE_TITLE}
        message={message}
        code={FAILURE_CODE}
        query={describeNode(node)}
      />
    </div>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The dispatcher
 * ---------------------------------------------------------------------------
 */

/**
 * The inputs of one rendered node.
 *
 * Three, and the last two are positioning rather than content: the node is the
 * whole of what is drawn, and the data provider and the action contract are
 * ambient — the host mounts them once around the panel, so they are not props
 * here and must not become them (AAP 0.1.2).
 *
 * Every optional member spells `| undefined` explicitly, because
 * `exactOptionalPropertyTypes` is in force repository-wide and a caller
 * forwarding a value it may not have has to stay legal.
 */
export interface NodeRendererProps {
  /**
   * The validated node to draw.
   *
   * Read, never written: see this module's header on what it does not do. A
   * node arrives having been parsed by `@debuggen/panel-schema` and, for a
   * generated panel, checked against its capture.
   */
  readonly node: PanelNode;

  /**
   * Where this node sits in its specification, as the path that reaches it —
   * `['layout', 0]` for the first top-level node.
   *
   * Used for one thing: deriving the keys of this node's children, so that a
   * position in the document rather than a value inside it identifies a child
   * across renders. Defaults to the node's own id as a single-segment path,
   * which is what a caller rendering a node on its own — a test, or a surface
   * showing one view — gets without having to invent a document position; for a
   * normalized panel that yields exactly the child ids the normaliser derived,
   * because it derives them from this same path.
   */
  readonly path?: PanelNodePath | undefined;

  /**
   * The outline level this node's own heading sits at, when it has one.
   *
   * Only a labelled leaf has a heading this module emits (see the header): the
   * container types render their labels through their own layout primitives.
   * The value is passed one level deeper to the children of a container whose
   * title has text, so that the headings this module emits never skip a level.
   *
   * @default 2
   */
  readonly headingLevel?: HeadingLevel | undefined;
}

/**
 * Draws one node of a validated panel, and its subtree.
 *
 * The dispatch is a single lookup in `./registry`, so every node type is
 * treated identically here and the per-type differences stay in the adapters
 * the registry declares. A container's children are rendered through
 * {@link renderPanelNodes} and handed over as an array; a labelled leaf is
 * wrapped in `../layout/Section`; a type the registry has no component for
 * renders a visible failure rather than nothing (AAP 0.6.2, 0.5.5).
 *
 * Pure and presentational: no state, no effect, no hook, no memoization.
 *
 * @param props See {@link NodeRendererProps}.
 * @returns The node's wrapper and whatever belongs inside it — never an empty
 * element, whatever the node turns out to be.
 *
 * @example One node, rendered on its own.
 * ```tsx
 * <NodeRenderer node={node} />
 * ```
 */
export function NodeRenderer(props: NodeRendererProps): ReactElement {
  const { node, path, headingLevel = DEFAULT_HEADING_LEVEL } = props;

  // First, and deliberately: this lookup is the only *runtime* check that the
  // node's type is one this package draws. `node.type` is typed as a catalogued
  // type, but a specification read back from storage or handed over unvalidated
  // can carry a name outside the vocabulary, and the catalogue accessor below
  // is total over the type rather than over every string — so asking the
  // registry first is what keeps an unknown type a rendered failure instead of
  // a lookup on a missing catalogue entry inside React's render.
  const component = componentForNodeType(node.type);

  if (component === undefined) {
    return renderNodeFailure(
      node,
      `This panel names a node of type "${node.type}" (node "${node.id}"), which this renderer has no component for.`,
    );
  }

  // Containment is the catalogue's statement, not a list of type names kept
  // here: `supportsChildren` is true for exactly the container types, so a type
  // added to the vocabulary is classified without an edit to this file.
  if (catalogEntryFor(node.type).supportsChildren) {
    const children = containerChildren(node);

    if (children === undefined) {
      return renderNodeFailure(
        node,
        `The node type "${node.type}" (node "${node.id}") is catalogued as a container, but this renderer cannot read its children.`,
      );
    }

    return (
      <div className={NODE_CLASS}>
        {createElement(component, {
          node,
          nodeId: node.id,
          children: renderPanelNodes(children, {
            basePath: [...(path ?? [node.id]), PANEL_CHILDREN_FIELD],
            // One level deeper only when the container actually renders a
            // heading; a description alone adds prose, not an outline level.
            headingLevel: hasText(node.title) ? nextHeadingLevel(headingLevel) : headingLevel,
          }),
        })}
      </div>
    );
  }

  // A leaf: the component draws the node's evidence and takes no children, and
  // a leaf handed children by a malformed specification is rendered exactly as
  // it would be without them (the registry's adapters ignore the prop).
  const view = createElement(component, { node, nodeId: node.id });

  // The heading a leaf's labels deserve, rendered once, here. The condition
  // applies the same blank-label rule `Section` applies internally, so a node
  // whose title is whitespace is not given an empty container to sit in. Only
  // the two labels and the outline level are passed: the frame and the spacing
  // stay at the container's own defaults, because a specification carries no
  // field for either and this file may not invent one (AAP 0.6.4).
  if (hasText(node.title) || hasText(node.description)) {
    return (
      <div className={NODE_CLASS}>
        <Section title={node.title} description={node.description} headingLevel={headingLevel}>
          {view}
        </Section>
      </div>
    );
  }

  return <div className={NODE_CLASS}>{view}</div>;
}

/*
 * ---------------------------------------------------------------------------
 * The list
 * ---------------------------------------------------------------------------
 */

/** How {@link renderPanelNodes} positions the nodes it renders. */
export interface RenderPanelNodesOptions {
  /**
   * The path the list itself sits at, which each node's own path extends with
   * its index.
   *
   * Defaults to a specification's `layout` field, so a host rendering a panel's
   * layout states nothing and gets the paths — and therefore the keys —
   * `layout.0`, `layout.1`, … that the normaliser used as those nodes' ids.
   */
  readonly basePath?: PanelNodePath | undefined;

  /**
   * The outline level each node in the list renders its own heading at, when it
   * has one. Omitted, each node takes {@link NodeRendererProps.headingLevel}'s
   * default.
   */
  readonly headingLevel?: HeadingLevel | undefined;
}

/**
 * Renders a list of sibling nodes — a specification's `layout`, or one
 * container's children.
 *
 * A function returning an **array**, not a list component, and that is a
 * contract rather than a style: `../layout/Split` positions its panes by index
 * over `Children.toArray(children)`, where a fragment counts as one entry, so a
 * component here would collapse every division in the product into a single
 * pane. Returning the array lets a container receive its children as the
 * sequence the specification wrote.
 *
 * An empty list renders no elements, which is the correct reading of a
 * specification whose layout is legitimately empty — "may be empty when there
 * was nothing to draw" — and a panel that drew nothing is the host's to explain,
 * since only the host knows the summary and the state of the session behind it.
 *
 * @param nodes The sibling nodes, in reading order.
 * @param options See {@link RenderPanelNodesOptions}.
 * @returns One element per node, keyed by its document path.
 *
 * @example A host rendering a validated panel's layout.
 * ```tsx
 * <div className="dg-panel__body">{renderPanelNodes(spec.layout)}</div>
 * ```
 */
export function renderPanelNodes(
  nodes: readonly PanelNode[],
  options: RenderPanelNodesOptions = {},
): ReactElement[] {
  const { basePath = PANEL_LAYOUT_PATH_ROOT, headingLevel } = options;

  return nodes.map((node, index) => {
    const path: PanelNodePath = [...basePath, index];

    return <NodeRenderer key={pathKey(path)} node={node} path={path} headingLevel={headingLevel} />;
  });
}
