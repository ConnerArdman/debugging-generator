/**
 * The panel component registry — the single sanctioned mapping from a panel
 * node type to the component that draws it (AAP 0.6.2).
 *
 * ## What this module is for
 *
 * A generated panel is data: a validated specification whose `layout` is a tree
 * of nodes, each naming a type from the schema package's node catalog. Nothing
 * in a specification is code, and nothing in it names a component — which is
 * exactly the property that makes a generated panel safe to render (AAP 0.6.4:
 * "generated panels compose catalogued components only — no model-authored
 * markup, styles or component code reaches the renderer"). This file is the
 * allow-list that turns that property into a mechanism: a node type reaches a
 * component only because this record pairs the two, so the set of things a
 * panel can put on screen is fixed here, in reviewed source, rather than
 * decided by whatever produced the specification.
 *
 * It is therefore a contract and not a convenience:
 *
 * - The record is keyed by the schema package's `PanelNodeType`, which is the
 *   key type of `PANEL_NODE_CATALOG` itself. A catalogued type with no entry
 *   below is a compile error here (the key is missing from a complete record)
 *   and a failure of the colocated suite `registry.test.ts`, which asserts
 *   one-to-one coverage in both directions: every catalogue entry has a
 *   component, and every component belongs to a catalogue entry.
 * - An *unknown* node type never gets this far. A specification is parsed and
 *   validated before it is rendered, and a node type outside the catalogue is a
 *   validation failure raised by `packages/panel-schema/src/validate.ts` — "a
 *   node type with no component is a validation failure … never a blank area"
 *   (AAP 0.6.2). A miss at this layer is consequently a programming error, not
 *   an input the renderer has to tolerate: {@link componentForNodeType}
 *   reports it as an absent component so that `NodeRenderer` can show an error
 *   state, and each adapter below reports a mis-dispatched node by throwing.
 *   Neither path renders nothing and calls it success.
 *
 * ## Why every entry is an adapter rather than the component itself
 *
 * The sixteen components this record points at do not share a props shape, and
 * they should not: a container takes rendered React children and a title, a
 * query-backed view takes its own node type (so the compiler checks that the
 * query it carries is one this view can read), and the source-link leaf takes a
 * resolved location and no query at all. A record holding the components
 * directly could not be typed — React props are checked contravariantly, so a
 * container whose `children` are React nodes is not a component that accepts a
 * container *node*, whose `children` are unrendered panel nodes.
 *
 * So each entry is a small named adapter over one uniform contract
 * ({@link PanelNodeComponentProps}): it narrows the node on its own `type`
 * discriminant and calls its component with that component's own props. The
 * narrowing is a plain comparison against a literal, which means the compiler
 * checks the pairing — an adapter that handed a node to the wrong component
 * would not compile — and no assertion, cast or `any` is needed anywhere in
 * this file.
 *
 * ## Conventions this file keeps
 *
 * - **No JSX.** This module is `.ts`, not `.tsx`: the package barrel and the
 *   AAP both name it `registry.ts`, and a registry is data rather than markup.
 *   Every adapter body is therefore a single `createElement` call, which is
 *   also what the automatic JSX runtime would have produced.
 * - **Nothing visual.** No class name, no inline style, no CSS value. Every
 *   adapter forwards fields and rendered children; appearance belongs to the
 *   components and, through them, to `../styles/components.css` and the token
 *   set (AAP 0.6.4).
 * - **A node's heading belongs to its container.** The query-backed components
 *   deliberately do not render `node.title`; the node renderer wraps a titled
 *   node in `../layout/Section`. The adapters below therefore forward a title
 *   only for the three containers, whose title *is* their own heading.
 * - **No back edge.** The dependency runs one way — `PanelHost` →
 *   `NodeRenderer` → this registry → the components — so this module imports
 *   neither of the first two, and it reaches no transport: the components read
 *   the data provider and the action contract from context themselves.
 * - **No side effect on import.** Every statement is a declaration; the record
 *   is frozen at module scope and nothing else runs.
 */

import { isKnownPanelNodeType } from '@debuggen/panel-schema';
import type { PanelNode, PanelNodeType } from '@debuggen/panel-schema';
import { fail } from '@debuggen/shared';
import { createElement } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';

import { ComponentTree } from '../components/ComponentTree';
import { DependencyGraph } from '../components/DependencyGraph';
import { EventLog } from '../components/EventLog';
import { FlameChart } from '../components/FlameChart';
import { MetricCards } from '../components/MetricCards';
import { QueryTable } from '../components/QueryTable';
import { RenderTable } from '../components/RenderTable';
import { RequestTable } from '../components/RequestTable';
import { SourceLink } from '../components/SourceLink';
import { SpanTable } from '../components/SpanTable';
import { StateTransitionViewer } from '../components/StateTransitionViewer';
import { Timeline } from '../components/Timeline';
import { Waterfall } from '../components/Waterfall';
import { Section } from '../layout/Section';
import { Split } from '../layout/Split';
import { Stack } from '../layout/Stack';

/*
 * ---------------------------------------------------------------------------
 * The uniform component contract
 * ---------------------------------------------------------------------------
 */

/**
 * What every entry of {@link PANEL_COMPONENT_REGISTRY} is rendered with.
 *
 * One shape for all sixteen node types, so the node renderer can dispatch on
 * `node.type` without knowing anything about the component it selected. The
 * per-type differences live inside the adapters, which is the whole reason the
 * adapters exist.
 */
export interface PanelNodeComponentProps {
  /**
   * The validated node this component draws, forwarded untouched.
   *
   * Untouched is load-bearing: a node arrives having been parsed by
   * `@debuggen/panel-schema` and, for a generated panel, checked against the
   * capture it claims to describe. An adapter that rewrote a query, filled in
   * a field or dropped one would make the view disagree with the specification
   * the service validated and stored, so the adapters below read fields and
   * never edit them.
   */
  node: PanelNode;

  /**
   * The identity to report to the ambient `PanelActions` for interactions
   * inside this node.
   *
   * Normally the node's own `id`, which is what the specification named it and
   * what a stored panel's evidence references point at. A host that renders the
   * same node in more than one place passes distinct values so that its
   * callbacks can tell the copies apart. Only the components that accept an
   * identity override receive it; the rest report `node.id` themselves, which
   * is the same value in the ordinary case.
   */
  nodeId: string;

  /**
   * The node's already-rendered children, supplied by the node renderer for a
   * container type and absent for a leaf.
   *
   * The children of a container node are *panel nodes*, and rendering them is
   * the node renderer's recursion, not a container's job: a container is a
   * layout primitive that knows nothing about the schema. So the adapters for
   * the three container types forward this prop and never forward
   * `node.children`, and the thirteen leaf adapters ignore it — a leaf that was
   * given children would have come from a specification the validator should
   * have rejected, and dropping them here is what keeps a leaf's rendering
   * identical either way.
   */
  children?: ReactNode | undefined;
}

/**
 * A component that can draw a panel node under the uniform contract.
 *
 * `ComponentType` rather than a function type so an entry may be a memoized or
 * otherwise wrapped component without this record changing shape, and so that
 * `displayName` — which every adapter below sets, and which a failing
 * assertion in `registry.test.ts` reads to name the entry that broke — is part
 * of the type.
 */
export type PanelNodeComponent = ComponentType<PanelNodeComponentProps>;

/**
 * The complete node-type-to-component mapping.
 *
 * A `Record` over the catalogue's own key type, which is what makes the
 * registry's completeness a compile-time property: a missing key fails to
 * satisfy the record and an unrecognised key is not assignable to it, so
 * neither can reach the test suite, let alone a rendered panel. Read-only,
 * because the mapping is a fact about this package rather than a configuration
 * point — a consumer that needs a different component for a node type needs a
 * different node type.
 */
export type PanelComponentRegistry = Readonly<Record<PanelNodeType, PanelNodeComponent>>;

/*
 * ---------------------------------------------------------------------------
 * Mis-dispatch
 * ---------------------------------------------------------------------------
 */

/**
 * Reports a node handed to the wrong adapter, which cannot happen through the
 * supported path and must never be rendered as an empty region.
 *
 * `fail` from `@debuggen/shared` rather than that module's `assertNever`: the
 * value here is a perfectly well-typed node of *another* type, not an unhandled
 * member of a union the compiler has already exhausted, so `assertNever` — whose
 * parameter is `never` by design — cannot be called with it. `fail` is its
 * unconditional sibling and raises the same internal error, which is the
 * behaviour this branch owes: a loud failure naming both types, never a silent
 * `null` and never a fabricated fallback view.
 *
 * @param node The node that arrived.
 * @param expected The node type this adapter is registered for.
 * @returns Never; the return type lets an adapter `return` this call.
 */
function unexpectedNodeType(node: PanelNode, expected: PanelNodeType): never {
  return fail(
    `The panel component registry's "${expected}" entry was rendered with a "${node.type}" node (id "${node.id}"). A node is dispatched by its own type, so this is a mis-dispatch in the node renderer rather than a malformed panel.`,
  );
}

/*
 * ---------------------------------------------------------------------------
 * Container adapters
 *
 * The three types whose catalogue entries set `supportsChildren`. Each forwards
 * the node's own labels and the children the node renderer rendered, and leaves
 * every other prop of the layout primitive at that primitive's default: a field
 * the schema does not carry is not a value this file may invent (AAP 0.6.4).
 * ---------------------------------------------------------------------------
 */

/**
 * `section` → `../layout/Section`: a titled, bounded group of nodes.
 *
 * @param props The uniform contract; `children` are the rendered child nodes.
 * @returns The section, wrapping its children.
 */
function SectionNodeAdapter({ node, children }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'section') {
    return unexpectedNodeType(node, 'section');
  }

  return createElement(Section, {
    title: node.title,
    description: node.description,
    children,
  });
}
SectionNodeAdapter.displayName = 'SectionNodeAdapter';

/**
 * `split` → `../layout/Split`: two or more nodes placed along one axis.
 *
 * `direction` is forwarded as the node carries it, `undefined` included: the
 * schema leaves the field optional and the normaliser deliberately does not
 * fill it in, so the axis an unstated division assumes is the layout
 * primitive's documented default rather than a value chosen here.
 *
 * @param props The uniform contract; `children` are the rendered panes.
 * @returns The division, with its panes.
 */
function SplitNodeAdapter({ node, children }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'split') {
    return unexpectedNodeType(node, 'split');
  }

  return createElement(Split, {
    direction: node.direction,
    title: node.title,
    description: node.description,
    children,
  });
}
SplitNodeAdapter.displayName = 'SplitNodeAdapter';

/**
 * `stack` → `../layout/Stack`: nodes in vertical sequence.
 *
 * @param props The uniform contract; `children` are the rendered child nodes.
 * @returns The flow container, with its children.
 */
function StackNodeAdapter({ node, children }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'stack') {
    return unexpectedNodeType(node, 'stack');
  }

  return createElement(Stack, {
    title: node.title,
    description: node.description,
    children,
  });
}
StackNodeAdapter.displayName = 'StackNodeAdapter';

/*
 * ---------------------------------------------------------------------------
 * Query-backed adapters
 *
 * The twelve types whose catalogue entries require a `DataQuery`. Each one
 * forwards the narrowed node and nothing else: the component resolves the query
 * through the ambient data provider, owns its own loading, empty and error
 * states, and reports interactions through the ambient action contract. The
 * `className` prop every one of them accepts is placement, which belongs to the
 * container the node renderer wraps a node in, so no adapter sets one.
 * ---------------------------------------------------------------------------
 */

/**
 * `timeline` → `../components/Timeline`: one interaction on a shared time axis,
 * in lanes by the tier that produced each span.
 *
 * @param props The uniform contract.
 * @returns The timeline for this node's query.
 */
function TimelineNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'timeline') {
    return unexpectedNodeType(node, 'timeline');
  }

  return createElement(Timeline, { node });
}
TimelineNodeAdapter.displayName = 'TimelineNodeAdapter';

/**
 * `waterfall` → `../components/Waterfall`: calls as bars positioned by their
 * offset from the first, with the work nested beneath each expandable.
 *
 * @param props The uniform contract.
 * @returns The waterfall for this node's query.
 */
function WaterfallNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'waterfall') {
    return unexpectedNodeType(node, 'waterfall');
  }

  return createElement(Waterfall, { node });
}
WaterfallNodeAdapter.displayName = 'WaterfallNodeAdapter';

/**
 * `eventLog` → `../components/EventLog`: the captured records in order, as a
 * filterable, virtualized list.
 *
 * @param props The uniform contract.
 * @returns The log for this node's query.
 */
function EventLogNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'eventLog') {
    return unexpectedNodeType(node, 'eventLog');
  }

  return createElement(EventLog, { node });
}
EventLogNodeAdapter.displayName = 'EventLogNodeAdapter';

/**
 * `metricCards` → `../components/MetricCards`: the capture's computed values as
 * a row of tiles.
 *
 * The node's `metrics` option travels inside the node, where the schema
 * deliberately keeps it — it is a node option and never a query field — so this
 * adapter forwards the node whole and lifts nothing out of it.
 *
 * @param props The uniform contract.
 * @returns The tile row for this node's requested values.
 */
function MetricCardsNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'metricCards') {
    return unexpectedNodeType(node, 'metricCards');
  }

  return createElement(MetricCards, { node });
}
MetricCardsNodeAdapter.displayName = 'MetricCardsNodeAdapter';

/**
 * `flame` → `../components/FlameChart`: nested timing drawn as a hierarchy, so
 * a call that was slow itself reads differently from one that was waiting.
 *
 * @param props The uniform contract.
 * @returns The hierarchy for this node's query.
 */
function FlameNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'flame') {
    return unexpectedNodeType(node, 'flame');
  }

  return createElement(FlameChart, { node });
}
FlameNodeAdapter.displayName = 'FlameNodeAdapter';

/**
 * `table` → `../components/SpanTable`: a sortable ranking of spans with their
 * kind, tier and duration.
 *
 * The one query-backed component that accepts an identity override, so this is
 * the one adapter that forwards `nodeId`. The others report `node.id`
 * themselves, which is the same value unless a host deliberately renamed this
 * instance.
 *
 * @param props The uniform contract.
 * @returns The ranking for this node's query.
 */
function TableNodeAdapter({ node, nodeId }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'table') {
    return unexpectedNodeType(node, 'table');
  }

  return createElement(SpanTable, { node, nodeId });
}
TableNodeAdapter.displayName = 'TableNodeAdapter';

/**
 * `renderTable` → `../components/RenderTable`: per-component render counts,
 * timing and trigger attribution for one capture.
 *
 * @param props The uniform contract.
 * @returns The render statistics for this node's query.
 */
function RenderTableNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'renderTable') {
    return unexpectedNodeType(node, 'renderTable');
  }

  return createElement(RenderTable, { node });
}
RenderTableNodeAdapter.displayName = 'RenderTableNodeAdapter';

/**
 * `componentTree` → `../components/ComponentTree`: the tree as it stood at the
 * capture's last commit, with each node's render count.
 *
 * @param props The uniform contract.
 * @returns The tree for this node's query.
 */
function ComponentTreeNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'componentTree') {
    return unexpectedNodeType(node, 'componentTree');
  }

  return createElement(ComponentTree, { node });
}
ComponentTreeNodeAdapter.displayName = 'ComponentTreeNodeAdapter';

/**
 * `requestTable` → `../components/RequestTable`: requests grouped so that
 * repeats of one request are a single badged row rather than several.
 *
 * @param props The uniform contract.
 * @returns The request groups for this node's query.
 */
function RequestTableNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'requestTable') {
    return unexpectedNodeType(node, 'requestTable');
  }

  return createElement(RequestTable, { node });
}
RequestTableNodeAdapter.displayName = 'RequestTableNodeAdapter';

/**
 * `queryTable` → `../components/QueryTable`: datastore statements grouped by
 * their redacted, parameterized text, with their execution counts and callers.
 *
 * @param props The uniform contract.
 * @returns The statement groups for this node's query.
 */
function QueryTableNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'queryTable') {
    return unexpectedNodeType(node, 'queryTable');
  }

  return createElement(QueryTable, { node });
}
QueryTableNodeAdapter.displayName = 'QueryTableNodeAdapter';

/**
 * `stateTransitions` → `../components/StateTransitionViewer`: each observed
 * transition as its previous value, what triggered it and its next value.
 *
 * @param props The uniform contract.
 * @returns The transitions for this node's query.
 */
function StateTransitionsNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'stateTransitions') {
    return unexpectedNodeType(node, 'stateTransitions');
  }

  return createElement(StateTransitionViewer, { node });
}
StateTransitionsNodeAdapter.displayName = 'StateTransitionsNodeAdapter';

/**
 * `dependencyGraph` → `../components/DependencyGraph`: the correlated flow of
 * one interaction as a layered graph, an edge per handover.
 *
 * @param props The uniform contract.
 * @returns The graph for this node's query.
 */
function DependencyGraphNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'dependencyGraph') {
    return unexpectedNodeType(node, 'dependencyGraph');
  }

  return createElement(DependencyGraph, { node });
}
DependencyGraphNodeAdapter.displayName = 'DependencyGraphNodeAdapter';

/*
 * ---------------------------------------------------------------------------
 * The source-link leaf
 * ---------------------------------------------------------------------------
 */

/**
 * `sourceLink` → `../components/SourceLink`: a chip that opens the developer's
 * own source at a resolved location.
 *
 * The only leaf with no query, so this adapter forwards no query and no
 * identity: there is nothing to resolve and nothing to page, and the chip
 * raises the location itself through the ambient action contract. The location
 * is passed by reference, exactly as the specification carries it — the click
 * path's first hop is only correct while the object that arrives is the object
 * that leaves (AAP 0.4.2).
 *
 * The node's optional labels are deliberately not mapped onto the component's
 * `label`, which *replaces* the chip's derived `file:line` text: a node's title
 * is a heading, rendered by the container the node renderer wraps it in, so
 * using it here would both hide the target and print the same words twice.
 *
 * @param props The uniform contract.
 * @returns The chip for this node's location.
 */
function SourceLinkNodeAdapter({ node }: PanelNodeComponentProps): ReactElement {
  if (node.type !== 'sourceLink') {
    return unexpectedNodeType(node, 'sourceLink');
  }

  return createElement(SourceLink, { location: node.location });
}
SourceLinkNodeAdapter.displayName = 'SourceLinkNodeAdapter';

/*
 * ---------------------------------------------------------------------------
 * The registry
 * ---------------------------------------------------------------------------
 */

/**
 * Every panel node type, paired with the component that draws it.
 *
 * In the node catalogue's own order — the three containers, then the twelve
 * query-backed views, then the source-link leaf — so this record can be read
 * against `PANEL_NODE_CATALOG` line by line. `satisfies` is what checks the
 * literal in both directions: a catalogued type left out is a missing property
 * and a type that is not in the catalogue is an excess one, and both are
 * reported here rather than discovered at render time. Frozen, because the
 * mapping is a fact about this package and a consumer must not be able to swap
 * a component for a node type behind the schema's back (AAP 0.6.4).
 *
 * @example Dispatching one validated node.
 * ```ts
 * const Component = PANEL_COMPONENT_REGISTRY[node.type];
 * return createElement(Component, { node, nodeId: node.id });
 * ```
 */
export const PANEL_COMPONENT_REGISTRY: PanelComponentRegistry = Object.freeze({
  // Containers — the only entries that receive rendered children.
  section: SectionNodeAdapter,
  split: SplitNodeAdapter,
  stack: StackNodeAdapter,

  // Query-backed views — cross-tier, then tabular, then structural.
  timeline: TimelineNodeAdapter,
  waterfall: WaterfallNodeAdapter,
  eventLog: EventLogNodeAdapter,
  metricCards: MetricCardsNodeAdapter,
  flame: FlameNodeAdapter,
  table: TableNodeAdapter,
  renderTable: RenderTableNodeAdapter,
  componentTree: ComponentTreeNodeAdapter,
  requestTable: RequestTableNodeAdapter,
  queryTable: QueryTableNodeAdapter,
  stateTransitions: StateTransitionsNodeAdapter,
  dependencyGraph: DependencyGraphNodeAdapter,

  // The leaf that carries a resolved location instead of a query.
  sourceLink: SourceLinkNodeAdapter,
} satisfies Record<PanelNodeType, PanelNodeComponent>);

/**
 * Looks up the component for a node type, answering `undefined` for a type this
 * package does not draw.
 *
 * For the node renderer, whose input is a validated node and whose remaining
 * duty is the case that validation should already have excluded: a type name
 * that is not in the catalogue at all — a specification stored by a newer peer,
 * say, or a row read back after the vocabulary moved on. Reporting the absence
 * lets that caller render an error state naming the type, which is the required
 * behaviour for an unrenderable node; the alternative — indexing the record
 * with an unchecked string — would hand back `undefined` under a type that says
 * otherwise and put the mistake inside React's render instead.
 *
 * A known type always resolves: completeness is the record's type, not a
 * runtime property, so this function's `undefined` means "not a panel node
 * type", never "catalogued but unmapped".
 *
 * @param type A value believed to name a panel node type.
 * @returns The component registered for `type`, or `undefined` when `type` is
 * not one of the catalogued node types.
 */
export function componentForNodeType(type: string): PanelNodeComponent | undefined {
  return isKnownPanelNodeType(type) ? PANEL_COMPONENT_REGISTRY[type] : undefined;
}
