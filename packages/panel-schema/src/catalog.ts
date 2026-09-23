/**
 * The node catalog — the single registry of the node types a generated panel
 * may contain, and of what each of them may read.
 *
 * A panel specification is authored by a model and rendered in two surfaces
 * that were built long before any particular panel existed. That only works
 * while three independently written pieces of the product agree, to the letter,
 * on the set of node types and on what each one is allowed to ask for. This
 * module is where that agreement is written down once:
 *
 * 1. **The validator** (`./validate.ts`, and the capture-aware pass in
 *    `./semantic.ts`). A node type absent from the catalog is a *validation
 *    failure* rather than a crash or a blank region — {@link
 *    isKnownPanelNodeType} is the check that makes it one — and a node whose
 *    `query.source` is not listed for its type is rejected by {@link
 *    isSourceAllowedForNode}. The `reads` and `telemetryKinds` of an entry are
 *    what let the semantic pass ask whether the capture in hand can actually
 *    substantiate the node.
 * 2. **The panel-generation prompt** (`apps/local-service/prompts/generate-panel/vNNN.md`).
 *    {@link describeCatalogForPrompt} renders the entries into it, so each
 *    {@link PanelNodeCatalogEntry.description} is the model's only guidance on
 *    what a node is for. Those strings are therefore written as descriptions of
 *    *telemetry*, never of an application: no component name, no route, no
 *    example question and no hint about what some particular panel ought to
 *    contain may appear in them, because a panel that was decided in a prompt
 *    is a hardcoded answer wearing a pipeline's clothes (AAP 0.5.4).
 * 3. **The renderer's component registry**
 *    (`packages/panel-renderer/src/host/registry.ts`), which is keyed by this
 *    catalog: one component per entry, one-to-one, asserted by that package's
 *    `registry.test.ts`. {@link PANEL_NODE_CATALOG} is consequently a runtime
 *    value — the registry iterates it — and not a type-level construct.
 *
 * ## The invariant
 *
 * **The catalog's key set is exactly the `PanelNodeType` union**, which
 * `./spec.ts` composes from the container vocabulary of `./nodes/layout.ts` and
 * the leaf vocabulary of `./nodes/viz.ts`. The record below is annotated as
 * `Record<PanelNodeType, …>`, so a node type added to either owning module and
 * not given an entry here is a **compile error** rather than a validator that
 * quietly rejects a legitimate node or a renderer that draws nothing; and a key
 * here that no module declares is rejected for the same reason. `catalog.test.ts`
 * asserts the same equality at runtime against {@link
 * PANEL_NODE_TYPES}, because that equality is what keeps the three consumers
 * above in step.
 *
 * ## Nothing is restated that another module owns
 *
 * Every telemetry name in this file is imported. The attribute keys of each
 * entry's `reads` come from `@debuggen/telemetry`'s attribute-key catalog
 * through {@link attributeKeysFor}, which that module documents as the registry
 * "`packages/panel-schema/src/catalog.ts` consults when it declares each node's
 * `reads` list"; the record kinds come from that package's kind groups, which
 * no other module may spell out as a literal list; the metric vocabulary a
 * metric-tile node draws from is its `METRIC_IDS`; and the participant classes
 * of the graph node are its `DEPENDENCY_NODE_KINDS`. The non-attribute half of
 * `reads` is the event's own field names, and those are checked against
 * `keyof TelemetryEvent` by the compiler. A hand-typed key string that drifts
 * from the producer's spelling is exactly the defect this arrangement
 * prevents — it would not fail loudly, it would render an empty column.
 *
 * ## Environment-neutral, side-effect-free
 *
 * Pure data and total functions: frozen tuples, frozen records, and accessors
 * that allocate nothing on their default paths. No `node:` builtin, no DOM
 * global, no schema library — this module is loaded by the coordination
 * service, by the DevTools panel, by the editor webview and by the shared
 * component library alike, and the package is bundled with `platform:
 * 'neutral'` so a platform-only import fails the build rather than shipping.
 * Relative specifiers carry an explicit `.js` extension, as this package's
 * `NodeNext` resolution requires.
 *
 * @example
 * ```ts
 * import { PANEL_NODE_CATALOG, catalogEntryFor, isSourceAllowedForNode } from '@debuggen/panel-schema';
 *
 * const entry = catalogEntryFor('renderTable');
 * entry.requiresQuery; // true
 * isSourceAllowedForNode('renderTable', 'queries'); // false
 * ```
 */

import {
  COMPONENT_TREE_ATTRIBUTE_KEYS,
  DEPENDENCY_NODE_KINDS,
  FUNCTION_ATTRIBUTE_KEYS,
  INTERACTION_ATTRIBUTE_KEYS,
  METRIC_IDS,
  QUERY_KINDS,
  RENDER_KINDS,
  REQUEST_KINDS,
  ROUTE_HANDLER_ATTRIBUTE_KEYS,
  STATE_KINDS,
  WATERFALL_KINDS,
  attributeKeysFor,
  type TelemetryEvent,
  type TelemetryKind,
} from '@debuggen/telemetry';

import type { SplitNodeOf } from './nodes/layout.js';
import type { DataQuerySource } from './nodes/query.js';
import type { MetricCardsNode, SourceLinkNode } from './nodes/viz.js';
import { PANEL_NODE_TYPES, isPanelNodeType, type PanelNodeType } from './spec.js';

/*
 * ---------------------------------------------------------------------------
 * The entry-kind vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * The two things a node can be: a container that arranges other nodes, or a
 * visualization that draws something.
 *
 * A closed vocabulary rather than a boolean, because the distinction is read in
 * three places that each phrase it differently — the validator asks whether a
 * node may carry children, the prompt groups the catalog by it, and the
 * renderer dispatches a container to a layout primitive and a visualization to
 * a component — and a named value survives all three readings where
 * `isLayout: true` would invite a fourth meaning.
 *
 * Containers first, matching the order {@link PANEL_NODE_TYPES} itself runs in.
 *
 * Frozen: a read-only vocabulary.
 */
export const PANEL_NODE_CATALOG_KINDS = Object.freeze(['layout', 'visualization'] as const);

/**
 * One member of {@link PANEL_NODE_CATALOG_KINDS}.
 *
 * Derived from the tuple, so the runtime vocabulary and the static type cannot
 * disagree.
 */
export type PanelNodeCatalogKind = (typeof PANEL_NODE_CATALOG_KINDS)[number];

/*
 * ---------------------------------------------------------------------------
 * The entry
 * ---------------------------------------------------------------------------
 */

/**
 * Everything the product knows about one node type, in one place.
 *
 * Every field is `readonly` and every array in it is frozen: an entry is a
 * declaration shared by four processes, not state. The fields split cleanly
 * into what a node *is* (`type`, `kind`, `label`), what it may *ask for*
 * (`sources`, `defaultSource`, `requiresQuery`, `supportsChildren`, `options`),
 * what it *consumes* when it draws (`telemetryKinds`, `reads`), and how it is
 * *explained* to the model that chooses it (`description`).
 */
export interface PanelNodeCatalogEntry {
  /**
   * The node type this entry describes.
   *
   * Redundant with the key it is stored under, and deliberately so: the entries
   * are iterated as a list by the prompt renderer and by the renderer's
   * registry test, and an entry that cannot name itself forces both of them to
   * carry the key alongside the value.
   */
  readonly type: PanelNodeType;

  /** Whether this node arranges other nodes or draws a view of the capture. */
  readonly kind: PanelNodeCatalogKind;

  /**
   * A short human-readable name for the node type.
   *
   * Used for a section heading a panel did not title, for an empty or error
   * state that has to name what is missing, and for any user-interface control
   * that offers the vocabulary. Written in sentence case, because that is how
   * it appears in a heading; it is a label rather than a component name, so it
   * never matches the renderer's file names by construction.
   */
  readonly label: string;

  /**
   * The `DataQuery.source` values a node of this type may read, in the order
   * the catalog recommends them.
   *
   * **Empty** for the three containers and for the source-link leaf, none of
   * which reads captured data at all. For every other type the first member is
   * the source the node was designed around and the rest are the alternatives
   * whose prepared result its component can also consume; a source whose result
   * shape the component cannot render is absent, which is what makes {@link
   * isSourceAllowedForNode} a real check rather than a formality.
   */
  readonly sources: readonly DataQuerySource[];

  /**
   * The source normalisation supplies when a node of this type carries none.
   *
   * Present on exactly one entry today, and that is the point: the implicit
   * `{ source: 'metrics' }` of a metric-tile node is recorded here as **data**
   * so that `./normalize.ts` reads this field for every node type instead of
   * branching on one of them. A normaliser with a special case per node type is
   * a normaliser that grows one more special case per node type; a normaliser
   * that consults the catalog does not change when this field moves.
   *
   * Always a member of {@link sources} when present. Absent — rather than
   * `undefined` — on every entry that has none, because the package compiles
   * under `exactOptionalPropertyTypes`.
   */
  readonly defaultSource?: DataQuerySource;

  /**
   * Whether a node of this type must carry a `query` to be meaningful.
   *
   * `true` for the twelve query-backed visualizations, `false` for the three
   * containers and for the source-link leaf. The normalized node schemas in
   * `./nodes/viz.ts` already require the field of the twelve; this flag is what
   * states the same rule for the *authoring* form, where the query may still be
   * spread across flat fields, and for a stored panel being read back.
   */
  readonly requiresQuery: boolean;

  /**
   * Whether a node of this type contains other nodes.
   *
   * `true` for the three containers only. A consumer walking a panel tests this
   * rather than the node type, which is how `walkPanelNodes` in `./spec.ts` and
   * the renderer's node dispatch stay complete as the vocabulary grows.
   */
  readonly supportsChildren: boolean;

  /**
   * The telemetry record kinds this node type draws, taken from
   * `@debuggen/telemetry`'s kind groups.
   *
   * **Empty means "whatever the source offers"** — the cross-tier views, the
   * rankings, the chronological log and the computed tiles are all indifferent
   * to kind, as are the containers and the source-link leaf, which read nothing.
   * A non-empty list is the node's own subject: it is the honest value for a
   * `DataQuery.filter.kinds` narrowing the author may apply, the set a
   * capture-aware validator checks a capture's per-kind tallies against, and
   * the input the attribute half of {@link reads} below is derived from.
   *
   * Never a literal list of kind strings: `packages/telemetry/src/schema/kinds.ts`
   * owns every such list and states that no other module may spell one out.
   */
  readonly telemetryKinds: readonly TelemetryKind[];

  /**
   * The telemetry fields a component of this type reads, deduplicated.
   *
   * Declared **here only**, and imported by the renderer's component for this
   * node type as well as by the semantic validator — the renderer depends on
   * the schema, never the reverse (AAP 0.6.2). Every member is either a field
   * of a telemetry event (checked against `keyof TelemetryEvent` by the
   * compiler) or an attribute key the telemetry package's own catalog declares
   * for one of this node's {@link telemetryKinds}; nothing here is typed by
   * hand.
   *
   * **Empty** for the containers and the source-link leaf. A node that reads an
   * aggregated source declares the *event* fields that aggregate is computed
   * from rather than the aggregate's own property names: the aggregate shapes
   * live in `@debuggen/telemetry`, and re-listing their properties here would
   * be a second definition of them that could drift.
   */
  readonly reads: readonly string[];

  /**
   * The node's own non-query option fields, when it has any.
   *
   * Three entries carry one each — the metric ids of a tile row, the resolved
   * location of a source-link leaf, and the axis of a split — and they are
   * listed so that the normaliser knows which fields must *not* be lifted into
   * `node.query` and the prompt renderer can name them. Absent where a node
   * type has none, which is most of them.
   *
   * Every name is checked against the corresponding node type's own keys at
   * compile time (see `NodeOptionKey` below), so an option renamed in
   * `./nodes/viz.ts` or `./nodes/layout.ts` fails the build here.
   */
  readonly options?: readonly string[];

  /**
   * What this node shows and when to choose it, addressed to the model that
   * authors a panel.
   *
   * Rendered into the versioned generate-panel prompt by {@link
   * describeCatalogForPrompt}. One or two sentences, phrased entirely in terms
   * of the telemetry the node draws — see this module's documentation for why
   * an application name, a route, an example question or a recommendation about
   * a particular panel may never appear in one.
   */
  readonly description: string;
}

/*
 * ---------------------------------------------------------------------------
 * Composition helpers
 *
 * Internal, and small on purpose. Their whole job is to make every string in
 * an entry below *derived* — from the event type, from the telemetry package's
 * attribute-key registry, or from a node schema's own keys — so that no member
 * of a `reads` or `options` list is a hand-typed literal that can drift from
 * the module that owns it.
 * ---------------------------------------------------------------------------
 */

/**
 * The shared, empty value the entries that read nothing point at.
 *
 * One frozen array per shape rather than a fresh `[]` in four entries: the
 * catalog is a constant, and a constant should not hold four distinct empty
 * arrays that a consumer might compare by identity.
 */
const NO_SOURCES: readonly DataQuerySource[] = Object.freeze([]);

/** The shared empty kind list; see {@link NO_SOURCES}. */
const NO_TELEMETRY_KINDS: readonly TelemetryKind[] = Object.freeze([]);

/** The shared empty field list; see {@link NO_SOURCES}. */
const NO_READS: readonly string[] = Object.freeze([]);

/*
 * Event-field groups.
 *
 * Each tuple is annotated with `keyof TelemetryEvent`, which is the compiler
 * check that keeps these names honest: a field renamed in
 * `packages/telemetry/src/schema/event.ts` fails the build here rather than
 * leaving a `reads` entry pointing at a field no event carries. They are
 * grouped by the question a component asks of them so that an entry below
 * spells out what it reads by naming groups instead of repeating field names.
 */

/** Identity and lineage: which record this is, and what it hung from. */
const SPAN_IDENTITY_FIELDS = Object.freeze([
  'id',
  'traceId',
  'spanId',
  'parentSpanId',
] as const) satisfies readonly (keyof TelemetryEvent)[];

/** When it happened and how long it took — every timing view needs both. */
const SPAN_TIMING_FIELDS = Object.freeze([
  'startTime',
  'duration',
] as const) satisfies readonly (keyof TelemetryEvent)[];

/** What kind of work it was, and which tier produced it. */
const SPAN_TAXONOMY_FIELDS = Object.freeze([
  'kind',
  'tier',
] as const) satisfies readonly (keyof TelemetryEvent)[];

/** The producer's own label for the record. */
const SPAN_LABEL_FIELDS = Object.freeze([
  'name',
] as const) satisfies readonly (keyof TelemetryEvent)[];

/** Whether the work succeeded, which is what colours a failing row or bar. */
const SPAN_STATUS_FIELDS = Object.freeze([
  'status',
] as const) satisfies readonly (keyof TelemetryEvent)[];

/** The open attribute bag, for a view that shows whatever a record carries. */
const SPAN_ATTRIBUTE_FIELDS = Object.freeze([
  'attributes',
] as const) satisfies readonly (keyof TelemetryEvent)[];

/** The resolved project location, which is what makes a row clickable. */
const SPAN_SOURCE_FIELDS = Object.freeze([
  'source',
] as const) satisfies readonly (keyof TelemetryEvent)[];

/** The producer's monotonic sequence number: capture order for a log. */
const SPAN_ORDER_FIELDS = Object.freeze([
  'seq',
] as const) satisfies readonly (keyof TelemetryEvent)[];

/**
 * The attribute keys the telemetry package declares for a set of record kinds.
 *
 * The bridge between an entry's `telemetryKinds` and the attribute half of its
 * `reads`: ask the owning package what keys those kinds carry rather than
 * naming any of them here. Deterministic — kinds in the order the group
 * declares them, keys in the order each kind's tuple declares them — and the
 * cross-kind lineage and correlation keys are deliberately not requested, since
 * no node below reads them.
 *
 * @param kinds The kinds whose declared attribute keys are wanted.
 * @returns Their keys, in kind order then key order, with duplicates left for
 * {@link composeReads} to collapse.
 */
function attributeKeysForKinds(kinds: readonly TelemetryKind[]): readonly string[] {
  return kinds.flatMap((kind) => attributeKeysFor(kind));
}

/**
 * Builds one entry's `reads` list from the groups it is composed of.
 *
 * Deduplicates while preserving first-seen order, which matters for two
 * reasons: overlapping kind groups genuinely repeat keys (the request kinds
 * share every key but one), and the result is rendered and compared, so a
 * stable order makes it reviewable. Pure, and the result is frozen because an
 * entry is a declaration.
 *
 * @param groups Field and key groups, in the order they should be read.
 * @returns The union of the groups, first occurrence first.
 */
function composeReads(...groups: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const key of group) {
      seen.add(key);
    }
  }
  return Object.freeze([...seen]);
}

/**
 * The fields every node schema carries because of *where* a node sits, rather
 * than because of what it is: the discriminator, the identity, the two labels,
 * the data request of a query-backed node and the children of a container.
 *
 * Subtracting them from a node type's keys leaves exactly that type's own
 * options, which is what {@link NodeOptionKey} does.
 */
type StructuralNodeField = 'type' | 'id' | 'title' | 'description' | 'query' | 'children';

/**
 * The option field names of one node type: its keys, less the structural ones.
 *
 * Used to annotate the option tuples below, so that each name is proved to be a
 * real field of the node schema it describes. A renamed or removed option
 * therefore fails the build in this module instead of leaving the catalog
 * advertising a field the renderer will never receive.
 *
 * @typeParam TNode The node type whose own options are wanted.
 */
type NodeOptionKey<TNode> = Exclude<keyof TNode, StructuralNodeField>;

/** The metric-tile node's own option: which computed values to show. */
const METRIC_CARDS_OPTIONS: readonly NodeOptionKey<MetricCardsNode>[] = Object.freeze([
  'metrics',
] as const);

/** The source-link leaf's own option: the location the chip points at. */
const SOURCE_LINK_OPTIONS: readonly NodeOptionKey<SourceLinkNode>[] = Object.freeze([
  'location',
] as const);

/**
 * The split container's own option: the axis it divides along.
 *
 * Typed through the layout module's generic container interface rather than the
 * specification module's resolved alias, because the option set does not depend
 * on what the container may contain.
 */
const SPLIT_OPTIONS: readonly NodeOptionKey<SplitNodeOf<unknown>>[] = Object.freeze([
  'direction',
] as const);

/*
 * ---------------------------------------------------------------------------
 * The catalog
 *
 * Sixteen entries: three containers, twelve query-backed visualizations and
 * the source-link leaf. Each entry's `sources` list is decided from the
 * prepared result shape the panel-data contract serves for each source — the
 * correlated tree, the flat record lists, the four per-concern aggregates, the
 * component structure, the participant graph and the computed metric values —
 * and a source is listed only where the component for that node can render the
 * result it resolves to. The reasoning is recorded per entry, because "why is
 * this source not allowed here" is the question a future author of a node or a
 * renderer component will arrive with.
 *
 * Completeness is guaranteed in both directions, and it takes both the
 * annotation and the `satisfies` clause to do it. The annotation rejects a
 * **missing** entry: a node type added to either owning module without an entry
 * here fails with "property … is missing". The `satisfies` clause rejects an
 * **extra** one, and is not redundant — an object literal handed to
 * `Object.freeze` loses its freshness through that generic call, so the
 * annotation alone would accept a key no node type declares and leave the
 * renderer registry, the validator and the prompt carrying a node nothing can
 * produce. Applied to the literal itself, `satisfies` runs the excess-property
 * check before the freeze. `catalog.test.ts` asserts the same equality at
 * runtime, which is what covers a stored panel read back in a process that was
 * never type-checked against this build.
 * ---------------------------------------------------------------------------
 */

/**
 * Every node type a panel may contain, keyed by the type itself.
 *
 * The one registry the validator, the generate-panel prompt and the renderer's
 * component registry all read; see this module's documentation for what each of
 * them takes from it and for the key-set invariant that keeps them in step.
 *
 * Frozen, as is every array inside it: this is a declaration shared by four
 * processes.
 */
export const PANEL_NODE_CATALOG: Readonly<Record<PanelNodeType, PanelNodeCatalogEntry>> =
  Object.freeze({
    // -----------------------------------------------------------------------
    // Containers. No source, no query, no telemetry: a container arranges the
    // nodes beneath it. Their inputs are their own schema fields — a title, a
    // direction, the children — which is why `reads`, which names *telemetry*,
    // is empty rather than listing them.
    // -----------------------------------------------------------------------

    section: {
      type: 'section',
      kind: 'layout',
      label: 'Section',
      sources: NO_SOURCES,
      requiresQuery: false,
      supportsChildren: true,
      telemetryKinds: NO_TELEMETRY_KINDS,
      reads: NO_READS,
      description:
        'A titled group of nodes. Use it to give one part of a panel a heading and a boundary so that each thing the panel establishes is visibly its own part; it arranges the nodes beneath it and reads no captured data.',
    },

    split: {
      type: 'split',
      kind: 'layout',
      label: 'Split',
      sources: NO_SOURCES,
      requiresQuery: false,
      supportsChildren: true,
      telemetryKinds: NO_TELEMETRY_KINDS,
      reads: NO_READS,
      options: SPLIT_OPTIONS,
      description:
        'Two or more nodes placed along one axis. Use it when the views are read against each other — a claim beside the evidence for it, a ranking beside the detail of a selected row — rather than one after another.',
    },

    stack: {
      type: 'stack',
      kind: 'layout',
      label: 'Stack',
      sources: NO_SOURCES,
      requiresQuery: false,
      supportsChildren: true,
      telemetryKinds: NO_TELEMETRY_KINDS,
      reads: NO_READS,
      description:
        'One or more nodes in vertical sequence, each read after the one above it. The plain way to place several views inside a section when their order is all the arrangement means.',
    },

    // -----------------------------------------------------------------------
    // Cross-tier views of one interaction.
    // -----------------------------------------------------------------------

    timeline: {
      type: 'timeline',
      kind: 'visualization',
      label: 'Timeline',
      // `trace` first: the lanes are built from one correlated interaction, and
      // the tree the trace source resolves to already carries the nesting. A
      // flat span list is accepted as the alternative because every field the
      // lanes need is on the records themselves — the parent span id included —
      // so a caller who has narrowed to one interaction by filter rather than
      // by tree gets the same picture. The aggregates are not accepted: a
      // grouped or computed result has no per-record position on a shared axis.
      sources: Object.freeze(['trace', 'spans'] as const),
      requiresQuery: true,
      supportsChildren: false,
      // Indifferent to kind: the point of the view is that every tier's records
      // appear on one axis.
      telemetryKinds: NO_TELEMETRY_KINDS,
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_LABEL_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_SOURCE_FIELDS,
      ),
      description:
        'Every record of one correlated interaction on a shared time axis, in lanes by the tier that produced it, so the time each tier held and the gaps between them are directly visible. Choose it when the question is where the time in a single interaction went, and narrow it to one interaction, because a capture holds many.',
    },

    waterfall: {
      type: 'waterfall',
      kind: 'visualization',
      label: 'Waterfall',
      // `spans` first: a waterfall positions each call by its offset from the
      // first and expands into the work nested beneath it, which needs the flat
      // records and their parent links. `requests` is also accepted — the
      // grouped request result keeps each occurrence's start and duration, so
      // the same bars can be drawn for calls that were grouped for duplicate
      // detection. `trace` is deliberately absent: the whole tree is the
      // timeline's and the hierarchical view's shape, and a waterfall that had
      // to flatten one would duplicate work the resolver already does.
      sources: Object.freeze(['spans', 'requests'] as const),
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: WATERFALL_KINDS,
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_LABEL_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_SOURCE_FIELDS,
        attributeKeysForKinds(WATERFALL_KINDS),
      ),
      description:
        'The calls of one interaction as bars positioned by their offset from the first, each expandable into the work nested beneath it. Choose it when ordering and overlap are the question: calls that ran one after another when they could have run together read as a staircase, and genuinely concurrent work reads as a block.',
    },

    eventLog: {
      type: 'eventLog',
      kind: 'visualization',
      label: 'Event log',
      // Only `events`: this is the view with no opinion, and the source that
      // offers every record of any kind in capture order is the only one that
      // can supply it. `spans` would silently drop the records that are not
      // span-shaped work, which is the opposite of what a log is for.
      sources: Object.freeze(['events'] as const),
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: NO_TELEMETRY_KINDS,
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_ORDER_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_LABEL_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_ATTRIBUTE_FIELDS,
        SPAN_SOURCE_FIELDS,
      ),
      description:
        'Captured records in chronological order, filterable by kind and by free text, with the full attributes of a selected record. Choose it when the answer needs the raw sequence rather than a summary, or to place the unaggregated evidence beneath the views that summarise it; narrow it by kind to keep it readable.',
    },

    metricCards: {
      type: 'metricCards',
      kind: 'visualization',
      label: 'Metrics',
      // Only `metrics`, and it is also the default: the tiles show computed
      // values of the whole capture, addressed by id. Every other source
      // resolves to records or groups, which a tile cannot show without
      // computing something — and a value computed in the renderer is a value
      // that can disagree with the same number elsewhere in the panel.
      sources: Object.freeze(['metrics'] as const),
      // Recorded as data so that `./normalize.ts` supplies the implicit source
      // by consulting the catalog for every node type rather than by branching
      // on this one.
      defaultSource: 'metrics',
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: NO_TELEMETRY_KINDS,
      // A tile names no attribute key of its own: each metric is computed from
      // the capture by the telemetry package, from the timing, the kind and the
      // tier of every record, its status, and the per-kind attributes the
      // individual metrics draw on — which is what the open attribute bag
      // stands for here.
      reads: composeReads(
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_ATTRIBUTE_FIELDS,
      ),
      options: METRIC_CARDS_OPTIONS,
      description: `A row of tiles carrying computed values of the capture — durations per tier, counts and transferred bytes — each shown against the same severity thresholds used everywhere in the product. Choose the few of the ${String(METRIC_IDS.length)} available ids that bear on the question rather than every one: a value that could not be computed for this capture is shown as unavailable, so an irrelevant id costs a tile that says nothing. The ids are an option of this node, not part of its query.`,
    },

    flame: {
      type: 'flame',
      kind: 'visualization',
      label: 'Hierarchical timing',
      // Only `trace`: the view *is* the nesting, and the correlated tree is the
      // one result that carries it already resolved, orphans attached and
      // ordering settled. Rebuilding a hierarchy from a flat list in the
      // renderer would put a second, divergent implementation of the correlator
      // in the component library.
      sources: Object.freeze(['trace'] as const),
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: NO_TELEMETRY_KINDS,
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_LABEL_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_SOURCE_FIELDS,
      ),
      description:
        'Nested timing drawn as an icicle: each call a bar whose width is its measured duration, with the calls it made beneath it. Choose it to tell a call that was slow itself apart from one that was merely waiting on something nested inside it, and narrow it to one interaction. The hierarchy is the recorded nesting, not a sampled call stack.',
    },

    table: {
      type: 'table',
      kind: 'visualization',
      label: 'Span table',
      // `spans` first — the ranking this node exists for is over measured work.
      // `events` is accepted for the case where the ranking should include
      // records that are not span-shaped work, since both sources resolve to
      // the same record shape and the table reads only fields every record has.
      sources: Object.freeze(['spans', 'events'] as const),
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: NO_TELEMETRY_KINDS,
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_LABEL_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_SOURCE_FIELDS,
      ),
      description:
        'A sortable table of records showing what each one was, which tier produced it and how long it took. Choose it for a ranking — the slowest operations of a capture, or of one interaction — where a grouped or specialised table would obscure the order; order it by duration and bound the rows to the few that matter.',
    },

    // -----------------------------------------------------------------------
    // Per-concern aggregates. Each of these reads one prepared aggregate and
    // no other: a component built around render statistics cannot render
    // grouped statements, and listing a source it cannot draw would turn a
    // validation failure into an empty region.
    // -----------------------------------------------------------------------

    renderTable: {
      type: 'renderTable',
      kind: 'visualization',
      label: 'Render table',
      sources: Object.freeze(['renders'] as const),
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: RENDER_KINDS,
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_SOURCE_FIELDS,
        attributeKeysForKinds(RENDER_KINDS),
      ),
      description:
        'Render statistics per component: how often each rendered, how much time that took, what triggered those renders and which of its inputs changed. Choose it when a component renders more often than expected, because it separates renders whose inputs changed from renders whose inputs were stable and from renders that could not be classified; order it by count.',
    },

    componentTree: {
      type: 'componentTree',
      kind: 'visualization',
      label: 'Component tree',
      sources: Object.freeze(['componentTree'] as const),
      requiresQuery: true,
      supportsChildren: false,
      // The structure and its per-node counts are read from the renders and
      // commits of the capture. A producer may also serialize the structure
      // itself, and that snapshot arrives on a record of another kind — which
      // is why its keys appear in `reads` below rather than as a second entry
      // here: the kinds a node declares are the kinds a filter may narrow to,
      // and narrowing this view to the snapshot alone would lose the counts.
      telemetryKinds: RENDER_KINDS,
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_SOURCE_FIELDS,
        attributeKeysForKinds(RENDER_KINDS),
        COMPONENT_TREE_ATTRIBUTE_KEYS,
      ),
      description:
        'The component hierarchy as it stood at the end of the capture, each node annotated with how often that component rendered, expandable branch by branch. Choose it when position explains behaviour — what a component sits beneath, and what supplies values to it — and narrow it to a subtree when the whole structure would bury the answer.',
    },

    requestTable: {
      type: 'requestTable',
      kind: 'visualization',
      label: 'Request table',
      sources: Object.freeze(['requests'] as const),
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: REQUEST_KINDS,
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_SOURCE_FIELDS,
        attributeKeysForKinds(REQUEST_KINDS),
      ),
      description:
        'Network calls grouped so that identical requests collide and differently parameterized ones do not, each group badged with how many times it occurred and expandable to every occurrence with the code that initiated it. Choose it for a question about repeated or redundant calls, and order it by count to bring the repeats to the top.',
    },

    queryTable: {
      type: 'queryTable',
      kind: 'visualization',
      label: 'Query table',
      sources: Object.freeze(['queries'] as const),
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: QUERY_KINDS,
      // The caller of a statement is resolved by walking up to the enclosing
      // application function or request handler, so those kinds' identity keys
      // are read here too even though the rows themselves are statements.
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_LABEL_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_SOURCE_FIELDS,
        attributeKeysForKinds(QUERY_KINDS),
        FUNCTION_ATTRIBUTE_KEYS,
        ROUTE_HANDLER_ATTRIBUTE_KEYS,
      ),
      description:
        'Database statements grouped by their parameterized text, with how often each ran, how long it took and which code issued it. Statements only: no values and no returned rows are ever captured, so nothing here can expose data. Choose it when the cost may sit below the application code — one expensive statement, or one cheap statement run once per item of a collection.',
    },

    stateTransitions: {
      type: 'stateTransitions',
      kind: 'visualization',
      label: 'State transitions',
      sources: Object.freeze(['stateTransitions'] as const),
      requiresQuery: true,
      supportsChildren: false,
      telemetryKinds: STATE_KINDS,
      // The row also names the record it was triggered by, which is why the
      // label and taxonomy fields are read: the trigger is shown by its own
      // name and kind, and selecting it moves to that record.
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_LABEL_FIELDS,
        SPAN_SOURCE_FIELDS,
        attributeKeysForKinds(STATE_KINDS),
      ),
      description:
        'Hook state changes as rows: the component, a bounded summary of the value before, the record that triggered the change, and a summary of the value after. Values are summarised and truncated, never captured in full. Choose it when what drives a component to update matters more than how often it did.',
    },

    dependencyGraph: {
      type: 'dependencyGraph',
      kind: 'visualization',
      label: 'Dependency graph',
      sources: Object.freeze(['graph'] as const),
      requiresQuery: true,
      supportsChildren: false,
      // Indifferent to kind by construction: the graph classifies every record
      // into a participant class, so narrowing to a kind group would drop
      // participants and leave edges pointing at nothing.
      telemetryKinds: NO_TELEMETRY_KINDS,
      // Participants are labelled from the records they collapse: the
      // interaction that started the flow, the application functions and
      // request handlers it entered, and the calls and statements it ended at.
      reads: composeReads(
        SPAN_IDENTITY_FIELDS,
        SPAN_TIMING_FIELDS,
        SPAN_TAXONOMY_FIELDS,
        SPAN_LABEL_FIELDS,
        SPAN_STATUS_FIELDS,
        SPAN_SOURCE_FIELDS,
        INTERACTION_ATTRIBUTE_KEYS,
        FUNCTION_ATTRIBUTE_KEYS,
        ROUTE_HANDLER_ATTRIBUTE_KEYS,
        attributeKeysForKinds(WATERFALL_KINDS),
      ),
      description: `The correlated flow of one interaction as a layered graph, its participants classed as ${DEPENDENCY_NODE_KINDS.join(', ')}, with an edge for every handover between them. Choose it for a question about the path an interaction takes rather than the time it spends; a participant that resolved to a project location links to it.`,
    },

    // -----------------------------------------------------------------------
    // The leaf that reads no capture data.
    // -----------------------------------------------------------------------

    sourceLink: {
      type: 'sourceLink',
      kind: 'visualization',
      label: 'Source link',
      // No source and no query: the content of this node is a location that was
      // resolved before the panel was assembled, carried on the node itself.
      sources: NO_SOURCES,
      requiresQuery: false,
      supportsChildren: false,
      telemetryKinds: NO_TELEMETRY_KINDS,
      reads: NO_READS,
      options: SOURCE_LINK_OPTIONS,
      description:
        'A standalone link into the project source, rendered as a monospace chip that opens the file at that line in the editor. Choose it to point at the code a statement implicates — beside a hypothesis, or as the conclusion of a section. It carries one resolved location and no query; the tables, timelines and graphs already embed the same chip on any row that resolved to a location.',
    },
  } satisfies Record<PanelNodeType, PanelNodeCatalogEntry>);

/**
 * The catalog as an ordered list, in {@link PANEL_NODE_TYPES} order.
 *
 * Derived from that tuple rather than from `Object.keys`, and that is the whole
 * reason it exists: property enumeration order is an implementation detail of
 * how the record above happened to be written, while the vocabulary's order is
 * a declared contract. Every consumer that iterates the catalog — the prompt
 * renderer below, the renderer's registry and its coverage test — iterates this
 * list, so all of them meet the entries in the same order, run after run.
 *
 * Built once at module load and frozen; the entries are the very objects the
 * record holds, not copies.
 */
export const PANEL_NODE_CATALOG_ENTRIES: readonly PanelNodeCatalogEntry[] = Object.freeze(
  PANEL_NODE_TYPES.map((type) => PANEL_NODE_CATALOG[type]),
);

/*
 * ---------------------------------------------------------------------------
 * Accessors
 *
 * Total, pure and allocation-light: a lookup returns the frozen entry as it
 * stands, and nothing here memoises anything. Module-level mutable state would
 * make the prompt rendering below order-dependent under test, which is exactly
 * the property the generate-panel stage relies on it not having.
 * ---------------------------------------------------------------------------
 */

/**
 * The catalog entry for one node type.
 *
 * Total over the node vocabulary by construction — the record is exhaustive, so
 * there is no missing case, no fallback and no `undefined` to handle. Callers
 * that hold an *untrusted* type name narrow it with {@link
 * isKnownPanelNodeType} first; that is the boundary where an unrecognised name
 * becomes a validation failure rather than a lookup that returns nothing.
 *
 * @param type The node type to look up.
 * @returns Its entry, shared rather than copied.
 */
export function catalogEntryFor(type: PanelNodeType): PanelNodeCatalogEntry {
  return PANEL_NODE_CATALOG[type];
}

/**
 * Whether an untrusted value names a node type the catalog carries.
 *
 * The check the syntactic validator uses, so that a node whose `type` the
 * catalog does not know is reported as a validation failure instead of reaching
 * a lookup, a registry or a renderer that has nothing for it (AAP 0.2.3).
 *
 * Both halves of the test are deliberate. Membership of the vocabulary comes
 * from `./spec.ts`, which owns it; membership of the catalog is asserted here
 * because "the catalog knows this type" is the question this predicate is
 * actually asked. The record's annotation makes the two answers identical, and
 * the conjunction is what keeps them identical at runtime as well as at compile
 * time, at the cost of one own-property lookup.
 *
 * @param value Any value believed to name a panel node type.
 * @returns `true` when the catalog carries an entry for `value`.
 */
export function isKnownPanelNodeType(value: unknown): value is PanelNodeType {
  return isPanelNodeType(value) && Object.hasOwn(PANEL_NODE_CATALOG, value);
}

/**
 * Whether a node of this type may read this data source.
 *
 * The per-node half of query validation: the source vocabulary itself is closed
 * by `./nodes/query.ts`, and this is the narrower question of whether *this*
 * node's component can render the result that source resolves to. A node
 * type that reads nothing — a container, or the source-link leaf — allows no
 * source at all, so this returns `false` for every source, which is the correct
 * answer rather than a special case: such a node must carry no query.
 *
 * @param type The node type carrying the query.
 * @param source The source the query names.
 * @returns `true` when the type's entry lists `source`.
 */
export function isSourceAllowedForNode(type: PanelNodeType, source: DataQuerySource): boolean {
  return PANEL_NODE_CATALOG[type].sources.includes(source);
}

/*
 * ---------------------------------------------------------------------------
 * Prompt rendering
 * ---------------------------------------------------------------------------
 */

/**
 * The line prefix {@link describeCatalogForPrompt} uses unless asked for
 * another: a Markdown list marker, since the prompt files are Markdown.
 *
 * Exported so that a prompt author and a test agree on the default rather than
 * each spelling it.
 */
export const DEFAULT_CATALOG_PROMPT_BULLET = '- ';

/** How to render the catalog for a prompt. Both fields are optional. */
export interface DescribeCatalogOptions {
  /**
   * Render only the entries of one kind — the containers, or the
   * visualizations. Omit for the whole catalog, which is the usual case.
   */
  readonly kind?: PanelNodeCatalogKind;
  /**
   * The prefix placed before each line. Defaults to {@link
   * DEFAULT_CATALOG_PROMPT_BULLET}; pass an empty string for bare lines.
   */
  readonly bullet?: string;
}

/**
 * Renders one entry's source allowance as the phrase a prompt reads.
 *
 * Kept separate from the line builder because the three cases are genuinely
 * different statements — a node that takes no query at all, a container that
 * takes children instead, and a node whose sources are listed with its default
 * marked — and a nested conditional inside a template literal is how one of the
 * three quietly loses its wording.
 */
function describeSourcesForPrompt(entry: PanelNodeCatalogEntry): string {
  if (entry.sources.length === 0) {
    return entry.supportsChildren ? 'no data query; contains other nodes' : 'no data query';
  }

  const rendered = entry.sources
    .map((source) => (source === entry.defaultSource ? `${source} (default)` : source))
    .join(', ');

  return `sources: ${rendered}`;
}

/**
 * Renders one catalog entry as a single prompt line.
 *
 * The node type is quoted as code because it is a literal the author must
 * reproduce exactly, while the label is prose. The options clause is present
 * only where a node has options, so the common case reads without an empty
 * fragment.
 */
function describeEntryForPrompt(entry: PanelNodeCatalogEntry, bullet: string): string {
  const options = entry.options;
  const optionsClause =
    options !== undefined && options.length > 0 ? `; options: ${options.join(', ')}` : '';

  return `${bullet}\`${entry.type}\` (${entry.label}) — ${describeSourcesForPrompt(entry)}${optionsClause}. ${entry.description}`;
}

/**
 * The catalog rendered for the generate-panel prompt: one line per node type,
 * naming its type, its label, the sources it may read, its own options and what
 * it is for.
 *
 * **Deterministic, and that is a requirement rather than a nicety.** The
 * coordination service renders this into a versioned prompt file that is
 * immutable once committed, and the version used is recorded on the session, so
 * two runs of the same version must produce byte-identical text. Everything
 * here is therefore fixed: the iteration order is {@link
 * PANEL_NODE_CATALOG_ENTRIES}, which derives from the declared vocabulary
 * rather than from property enumeration; no sorting is performed, so no
 * locale collation can enter; no clock, no environment and no random source is
 * read; and the function holds no memo that could make a second call differ
 * from the first. Two calls with equal options return equal strings, in any
 * order, in any process.
 *
 * The descriptions it emits are written as descriptions of telemetry only — no
 * application name, route, example question or per-question recommendation —
 * because a prompt that names what a particular panel should contain is a
 * hardcoded answer, which this product forbids and its guard scripts scan for
 * (AAP 0.5.4).
 *
 * @param options See {@link DescribeCatalogOptions}.
 * @returns The rendered lines joined by newlines, with no trailing newline, so
 * the caller decides how the block sits in the surrounding document. Empty when
 * a `kind` filter matches nothing.
 */
export function describeCatalogForPrompt(options?: DescribeCatalogOptions): string {
  const bullet = options?.bullet ?? DEFAULT_CATALOG_PROMPT_BULLET;
  const wantedKind = options?.kind;

  const lines: string[] = [];
  for (const entry of PANEL_NODE_CATALOG_ENTRIES) {
    if (wantedKind !== undefined && entry.kind !== wantedKind) {
      continue;
    }
    lines.push(describeEntryForPrompt(entry, bullet));
  }

  return lines.join('\n');
}
