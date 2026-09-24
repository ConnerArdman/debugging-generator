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
 * 1. **The validators** (the authoring schema in `./input.ts`, `./validate.ts`,
 *    and the capture-aware pass in `./semantic.ts`). A node type absent from
 *    the catalog is a *validation failure* rather than a crash or a blank
 *    region — {@link isKnownPanelNodeType} is the check that makes it one — and
 *    a node whose `query.source` is not listed for its type is rejected by
 *    {@link isSourceAllowedForNode}. The authoring schema builds each
 *    query-backed node type's `source` enumeration, and its rule for when a
 *    source must be written, from the entry's `sources`, `defaultSource` and
 *    `requiresQuery`, so the model is refused and told the readable sources at
 *    the step it can still repair. The `telemetryKinds` and `requiredReads` of an
 *    entry are what let the semantic pass ask whether the capture in hand can
 *    actually substantiate the node: the kinds say whether the capture holds
 *    the node's records at all, and the required attribute keys say whether
 *    those records carry what the node cannot draw one without.
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
 * Every telemetry name in this file is checked against the module that owns
 * it. The attribute keys of each entry's reads come from `@debuggen/telemetry`'s
 * attribute-key catalog: a subset of one kind's keys is picked out of that
 * kind's own declared tuple by {@link attributeKeysFrom}, whose element type
 * rejects a key the tuple does not declare at compile time, and a cross-kind
 * group — lineage, correlation — is taken whole, as the telemetry package
 * exports it. The record kinds come from that package's kind groups, which no
 * other module may spell out as a literal list; the metric vocabulary a
 * metric-tile node draws from is its `METRIC_IDS`; and the participant classes
 * of the graph node are its `DEPENDENCY_NODE_KINDS`. The event-field half of
 * the reads is the event's own field names, typed so that the compiler rejects
 * a name that is not a `TelemetryEvent` field and a required read that the
 * event schema lets a record omit. A hand-typed key string that drifts from the
 * producer's spelling is exactly the defect this arrangement prevents — it
 * would not fail loudly, it would render an empty column.
 *
 * ## Reads are what a node's data depends on, split by what it cannot do without
 *
 * Each query-backed entry's reads are derived from two places, never from the
 * node's kinds alone: the fields its renderer component reads off a record
 * directly, and the fields the telemetry aggregate or correlator behind its
 * source reads to build the result that component is served. A key a node's
 * kinds declare but nothing on that path reads is not listed — a declaration
 * that overstates a node's inputs hides the fields it really depends on — and a
 * key outside those kinds that the path does read *is* listed, which is how the
 * cross-kind lineage and correlation keys, the resource-timing entries a
 * request is joined to and the snapshot a component tree is parsed from appear
 * where they are consumed.
 *
 * The reads are then split in two. {@link PanelNodeCatalogEntry.requiredReads}
 * holds what a record cannot contribute a row, a bar or a node without: the
 * schema-required event fields the node reads, and any attribute key the
 * aggregate refuses a record without. {@link PanelNodeCatalogEntry.optionalReads}
 * holds enrichment — the optional event fields and every other attribute key —
 * whose absence renders as unavailable, as a fallback label or as a missing
 * mark, never as an empty view. The split is what lets the semantic pass report
 * a capture whose records lack a required key without ever failing one that
 * merely lacks resource timing or a resolved source location.
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
  CORRELATION_ATTRIBUTE_KEYS,
  DB_QUERY_ATTRIBUTE_KEYS,
  DEPENDENCY_NODE_KINDS,
  FETCH_ATTRIBUTE_KEYS,
  FUNCTION_ATTRIBUTE_KEYS,
  HTTP_SERVER_ATTRIBUTE_KEYS,
  INTERACTION_ATTRIBUTE_KEYS,
  LINEAGE_ATTRIBUTE_KEYS,
  METRIC_IDS,
  PERF_ENTRY_ATTRIBUTE_KEYS,
  PERF_LONGTASK_ATTRIBUTE_KEYS,
  QUERY_KINDS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_KINDS,
  REQUEST_KINDS,
  ROUTE_HANDLER_ATTRIBUTE_KEYS,
  STATE_ATTRIBUTE_KEYS,
  STATE_KINDS,
  WATERFALL_KINDS,
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
 * what it *consumes* when it draws (`telemetryKinds`, `requiredReads`,
 * `optionalReads` and their union `reads`), and how it is *explained* to the
 * model that chooses it (`description`).
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
   * isSourceAllowedForNode} a real check rather than a formality. The authoring
   * schema in `./input.ts` renders this list as the node type's `source`
   * enumeration, so the model is shown exactly the sources the type can read.
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
   * spread across flat fields, and for a stored panel being read back. The
   * authoring schema in `./input.ts` reads it with {@link defaultSource}: a
   * type that requires a query and has no default must name its source, flat
   * or inside its `query` object, before normalisation is reached.
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
   * the kinds whose declared attribute keys every attribute key in
   * {@link requiredReads} comes from — so a presence check on a required key
   * always has a kind whose records are expected to carry it.
   *
   * It does **not** bound what the node reads. A node reads what the path to
   * its rendered result reads, which can reach keys of other kinds (a request
   * joined to its resource-timing entry, a tree parsed from a snapshot record)
   * and never includes a declared key nothing on that path touches.
   *
   * Never a literal list of kind strings: `packages/telemetry/src/schema/kinds.ts`
   * owns every such list and states that no other module may spell one out.
   */
  readonly telemetryKinds: readonly TelemetryKind[];

  /**
   * The telemetry fields a record must carry for this node to draw it at all.
   *
   * Two kinds of member, and only these two:
   *
   * - **event fields the schema requires** — every one the node reads, since a
   *   persisted event can never lack one: its identity, its placement, its
   *   label, its outcome, and the canonical-order tie-breakers where a
   *   correlator or a sort reads them. The compiler rejects a field the event
   *   schema lets a record omit;
   * - **attribute keys the aggregate behind the node refuses a record without**,
   *   each declared by one of {@link telemetryKinds}. `queryTable`'s
   *   `db.statement` is the one today: `aggregateQueries` forms no group for a
   *   database span that carries no statement, so a capture whose spans all
   *   lack it draws an empty table however many it holds.
   *
   * This is the list the semantic validator checks field presence against
   * (`./semantic.ts`), in the form the aggregate accepts: first from the
   * aggregate result the capture summary publishes, and otherwise by counting
   * the records that carry the key as text of positive length — the predicate
   * `aggregateQueries` applies to a statement. **Empty** for the containers and
   * the source-link leaf, which read no captured data. Disjoint from
   * {@link optionalReads}.
   */
  readonly requiredReads: readonly string[];

  /**
   * The telemetry fields this node reads when a record carries them.
   *
   * Enrichment: a record lacking one still contributes its row, bar or node,
   * and the missing value renders as unavailable, as a fallback label or as a
   * mark that is simply not drawn — never as an empty view. The optional event
   * fields (`parentSpanId`, `source`) belong here, as does every attribute key
   * that is not in {@link requiredReads}: the per-kind keys the view shows when
   * present, the cross-kind lineage and correlation flags, and cross-kind
   * provenance such as the resource-timing entry a request's byte count is
   * joined from.
   *
   * Never checked for presence: a capture without resource timing, or whose
   * locations were not resolved, is still a capture the node can draw.
   * **Empty** for the containers and the source-link leaf. Disjoint from
   * {@link requiredReads}.
   */
  readonly optionalReads: readonly string[];

  /**
   * Every telemetry field a component of this type reads: {@link requiredReads}
   * then {@link optionalReads}, deduplicated in that order.
   *
   * Declared **here only**, and imported by the renderer's component for this
   * node type as well as by the semantic validator — the renderer depends on
   * the schema, never the reverse (AAP 0.6.2). A component that gates a column
   * on the catalog (`SpanTable`, for instance) asks this union, because a
   * column may draw an optional field as readily as a required one. Every
   * member is either a field of a telemetry event or an attribute key the
   * telemetry package's own catalog declares; nothing here is typed by hand.
   *
   * **Empty** for the containers and the source-link leaf. A node that reads an
   * aggregated source declares the *event* fields and attribute keys that
   * aggregate is computed from rather than the aggregate's own property names:
   * the aggregate shapes live in `@debuggen/telemetry`, and re-listing their
   * properties here would be a second definition of them that could drift.
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
 * an entry below *checked* — against the event type, against the telemetry
 * package's attribute-key tuples, or against a node schema's own keys — so that
 * no member of a read list or an `options` list is a hand-typed literal that can
 * drift from the module that owns it.
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
const NO_FIELDS: readonly string[] = Object.freeze([]);

/*
 * Event-field vocabulary.
 *
 * The two halves of `keyof TelemetryEvent`, split by the event schema itself
 * rather than by a list kept here: a field the persisted schema requires, and a
 * field a record may omit. A required read typed as the first is proved by the
 * compiler to be one no persisted event can lack, and an optional read typed as
 * the second is proved to be one the schema really leaves out — so a field
 * renamed in `packages/telemetry/src/schema/event.ts`, or one whose optionality
 * changes there, fails the build here instead of leaving the split untrue.
 */

/**
 * A `TelemetryEvent` field the persisted schema requires.
 *
 * A key is optional exactly when a `Pick` of it is satisfied by its own
 * `Partial`, which is what the conditional below asks; the `-?` keeps the
 * mapped type's own values from absorbing `undefined` from an optional key.
 */
type RequiredEventField = {
  [TField in keyof TelemetryEvent]-?: Partial<Pick<TelemetryEvent, TField>> extends Pick<
    TelemetryEvent,
    TField
  >
    ? never
    : TField;
}[keyof TelemetryEvent];

/** A `TelemetryEvent` field a persisted record may omit. */
type OptionalEventField = Exclude<keyof TelemetryEvent, RequiredEventField>;

/*
 * Event-field groups.
 *
 * Grouped by the question a node asks of them, so an entry below spells out
 * what it reads by naming groups where several nodes ask the same question and
 * by naming fields where only one does. Each is typed to the required half of
 * the vocabulary above.
 */

/** Which record this is: the event's own id and its trace coordinates. */
const EVENT_IDENTITY_FIELDS = Object.freeze([
  'id',
  'traceId',
  'spanId',
] as const) satisfies readonly RequiredEventField[];

/** When it happened and how long it took — every timing view needs both. */
const EVENT_TIMING_FIELDS = Object.freeze([
  'startTime',
  'duration',
] as const) satisfies readonly RequiredEventField[];

/** What kind of work it was, and which tier produced it. */
const EVENT_TAXONOMY_FIELDS = Object.freeze([
  'kind',
  'tier',
] as const) satisfies readonly RequiredEventField[];

/**
 * The canonical-order tie-breakers after `startTime`: the producer, its
 * monotonic sequence number and the store's always-distinct arrival number
 * (AAP 0.2.3).
 *
 * Read wherever the correlator's comparator orders a node's records — the
 * trace tree the `trace` source resolves to, and the canonical sort the
 * state-transition and graph aggregates apply — so a node served through one of
 * those depends on all three.
 */
const CANONICAL_ORDER_FIELDS = Object.freeze([
  'producerId',
  'seq',
  'ingestSeq',
] as const) satisfies readonly RequiredEventField[];

/**
 * The two optional event fields: what a record hung from, and the project
 * location it resolved to.
 */
const EVENT_LINK_FIELDS = Object.freeze([
  'parentSpanId',
  'source',
] as const) satisfies readonly OptionalEventField[];

/*
 * Attribute-key groups.
 *
 * A subset of one kind's keys is always picked out of that kind's own tuple
 * through {@link attributeKeysFrom}, never written as a free-standing list, and
 * a cross-kind group is used whole.
 */

/**
 * Picks the named keys out of one kind's declared attribute tuple, in the
 * order that tuple declares them.
 *
 * The element type of `wanted` is the tuple's own key union, so a key the kind
 * does not declare — or a spelling that drifted from the producer's — is a
 * compile error here. The result is filtered from `declared` rather than
 * copied from `wanted`, so its order follows the owning declaration and a
 * repeated name cannot enter it.
 *
 * @param declared A per-kind attribute tuple exported by `@debuggen/telemetry`.
 * @param wanted The keys of it a node reads.
 * @returns Those keys, frozen, in declaration order.
 */
function attributeKeysFrom<TDeclared extends readonly string[]>(
  declared: TDeclared,
  wanted: readonly TDeclared[number][],
): readonly string[] {
  return Object.freeze(declared.filter((key) => wanted.includes(key)));
}

/**
 * The resource-timing entry keys a request is joined to its `perf.entry` on,
 * and the byte count and exposure verdict that join carries back.
 *
 * `aggregateRequests` matches a request to the resource entry the Performance
 * Timeline recorded for it by `entry.type`, `url` and `initiator.type`, then
 * takes the entry's `transferSize` unless `transferSizeExposed` says the host
 * withheld it (`packages/telemetry/src/aggregate/requests.ts`); the summary's
 * `transferred_bytes` counts the unclaimed entries by the same keys. These are
 * **cross-kind provenance** for every node served from that path: the entries
 * are records of another kind, the join is optional, and a capture without
 * resource timing draws its requests all the same with the bytes unavailable.
 */
const RESOURCE_TIMING_JOIN_KEYS = attributeKeysFrom(PERF_ENTRY_ATTRIBUTE_KEYS, [
  'entry.type',
  'url',
  'initiator.type',
  'transferSize',
  'transferSizeExposed',
]);

/*
 * Assembling one entry's reads.
 */

/**
 * One node's reads, as the three lists its catalog entry publishes.
 *
 * The entry fields themselves, picked from the entry type so that a renamed
 * field is renamed here as well.
 */
type CatalogReads = Pick<PanelNodeCatalogEntry, 'requiredReads' | 'optionalReads' | 'reads'>;

/**
 * What one query-backed node reads, as written in an entry below.
 *
 * Every list is typed to the vocabulary it may draw from, so the split between
 * required and optional is checked by the compiler for event fields and
 * derived from the owning tuples for attribute keys.
 */
interface NodeReadDeclaration {
  /** Schema-required event fields the node's data depends on. */
  readonly requiredFields: readonly RequiredEventField[];
  /**
   * Attribute-key groups the aggregate behind the node refuses a record
   * without. Omitted when it refuses none, which is the usual case.
   */
  readonly requiredAttributes?: readonly (readonly string[])[];
  /** Optional event fields the node reads when a record carries them. */
  readonly optionalFields?: readonly OptionalEventField[];
  /** Attribute-key groups the node reads when a record carries them. */
  readonly optionalAttributes?: readonly (readonly string[])[];
}

/**
 * Collapses field and key groups into one frozen list, first occurrence first.
 *
 * Overlapping groups genuinely repeat keys (the request and resource-timing
 * vocabularies share `url` and `transferSize`, and two route-bearing kinds
 * share `http.route`), and the lists are compared and reviewed, so a stable,
 * duplicate-free order matters.
 *
 * @param groups Field and key groups, in the order they should be read.
 * @returns Their union, frozen.
 */
function unionOf(groups: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const key of group) {
      seen.add(key);
    }
  }
  return Object.freeze([...seen]);
}

/**
 * Builds one entry's `requiredReads`, `optionalReads` and `reads` from its
 * declaration.
 *
 * `reads` is the union of the other two, required first. Nothing is subtracted
 * from the optional list to keep the two disjoint: a field declared on both
 * sides is an authoring error in this file, and `catalog.test.ts` asserts the
 * disjointness so that such an error fails loudly rather than being tidied
 * away here. Pure; every list is frozen because an entry is a declaration.
 *
 * @param declaration What the node reads; see {@link NodeReadDeclaration}.
 * @returns The three lists, ready to spread into an entry.
 */
function declareReads(declaration: NodeReadDeclaration): CatalogReads {
  const requiredReads = unionOf([
    declaration.requiredFields,
    ...(declaration.requiredAttributes ?? []),
  ]);
  const optionalReads = unionOf([
    declaration.optionalFields ?? NO_FIELDS,
    ...(declaration.optionalAttributes ?? []),
  ]);

  return Object.freeze({
    requiredReads,
    optionalReads,
    reads: unionOf([requiredReads, optionalReads]),
  });
}

/**
 * The reads of a node that reads no captured data: the three containers and
 * the source-link leaf. One shared, frozen value, so all four entries point at
 * the same empty lists.
 */
const NO_READS: CatalogReads = Object.freeze({
  requiredReads: NO_FIELDS,
  optionalReads: NO_FIELDS,
  reads: NO_FIELDS,
});

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
    // direction, the children — which is why the three read lists, which name
    // *telemetry*, are empty rather than listing them.
    // -----------------------------------------------------------------------

    section: {
      type: 'section',
      kind: 'layout',
      label: 'Section',
      sources: NO_SOURCES,
      requiresQuery: false,
      supportsChildren: true,
      telemetryKinds: NO_TELEMETRY_KINDS,
      ...NO_READS,
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
      ...NO_READS,
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
      ...NO_READS,
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
      // A bar is placed by its tier lane, start and duration, labelled by its
      // name and kind and tinted by its status. The canonical tie-breakers are
      // read twice over: the correlator orders the `trace` tree's siblings by
      // them, and a flat page is sorted by producer and sequence number. The
      // lineage family marks a bar attributed across an asynchronous boundary —
      // dashed when the attribution is ambiguous — whether it arrives on the
      // tree node or is read off a flat record, and the correlation family is
      // the `orphaned` repair a flat page reads to mark a re-attached subtree.
      // No bar needs any of them, nor its parent or its location, to be drawn.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'name',
          ...EVENT_TAXONOMY_FIELDS,
          ...EVENT_TIMING_FIELDS,
          'status',
          ...CANONICAL_ORDER_FIELDS,
        ],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [LINEAGE_ATTRIBUTE_KEYS, CORRELATION_ATTRIBUTE_KEYS],
      }),
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
      // A bar is every record of the waterfall kinds, placed by its offset and
      // duration; nothing refuses one, so no attribute is required. A row then
      // shows what its kind can say about itself when the record carries it —
      // a call's method, URL, status and bytes, a server span's matched route,
      // a statement and its row count — and the `requests` source adds the
      // grouping key, the in-flight marker and the resource-timing join its
      // grouped rows and byte counts are built from. The lineage and
      // correlation families mark an ambiguous attribution and a re-attached
      // call on a flat page. None of the kinds' other keys is read: not the
      // same-origin or trace-header flags, not the framework's route type and
      // not the database client, name or operation.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'name',
          ...EVENT_TAXONOMY_FIELDS,
          ...EVENT_TIMING_FIELDS,
          'status',
        ],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [
          attributeKeysFrom(FETCH_ATTRIBUTE_KEYS, [
            'http.method',
            'url',
            'http.status_code',
            'request_key',
            'transferSize',
            'resourceTimingUrl',
            'inFlight',
          ]),
          attributeKeysFrom(HTTP_SERVER_ATTRIBUTE_KEYS, ['http.route']),
          attributeKeysFrom(DB_QUERY_ATTRIBUTE_KEYS, ['db.statement', 'db.rowCount']),
          RESOURCE_TIMING_JOIN_KEYS,
          LINEAGE_ATTRIBUTE_KEYS,
          CORRELATION_ATTRIBUTE_KEYS,
        ],
      }),
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
      // A row is the record's sequence number, its offset from the earliest
      // start, its kind and name, a failure badge from its status and the
      // attribute bag in full — whatever keys it holds, which is why the bag
      // itself rather than any key of it is the read. The identity is what a
      // selected row hands to the host. The location chip is enrichment. The
      // log draws no duration, no tier and no parent: nesting is the timeline's
      // question, not the log's.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'seq',
          'startTime',
          'kind',
          'name',
          'status',
          'attributes',
        ],
        optionalFields: ['source'],
      }),
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
      // A tile names no field of its own: each value is computed from the whole
      // capture by `computeMetrics`, and these are the fields that computation
      // reads. The per-tier durations are unions of every record's interval;
      // the counts classify records by kind and status; the render totals read
      // each render's trigger; `query_count` counts the statement groups, which
      // keys on the statement and drops an inner duplicate by walking parent
      // links; the request and duplicate counts group by the service-assigned
      // key (falling back to method and URL) and settle in-flight snapshots;
      // `transferred_bytes` reads a request's own byte count and the
      // resource-timing entries it is joined to; `blocking_time` reads a long
      // task's reported blocking time. All of it is optional: a metric the
      // capture holds nothing for is published as unavailable, never absent.
      // The keys come from several kinds while the node declares none, which
      // `catalog.test.ts` pins as this node's cross-kind provenance.
      ...declareReads({
        requiredFields: [
          'id',
          'spanId',
          ...EVENT_TAXONOMY_FIELDS,
          ...EVENT_TIMING_FIELDS,
          'status',
        ],
        optionalFields: ['parentSpanId'],
        optionalAttributes: [
          attributeKeysFrom(RENDER_ATTRIBUTE_KEYS, ['trigger']),
          attributeKeysFrom(FETCH_ATTRIBUTE_KEYS, [
            'http.method',
            'url',
            'request_key',
            'transferSize',
            'resourceTimingUrl',
            'inFlight',
          ]),
          attributeKeysFrom(DB_QUERY_ATTRIBUTE_KEYS, ['db.statement']),
          attributeKeysFrom(PERF_LONGTASK_ATTRIBUTE_KEYS, ['blockingTime']),
          RESOURCE_TIMING_JOIN_KEYS,
        ],
      }),
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
      // A frame is a tree node: its width is its duration, its row its depth,
      // its label its name and kind, its tint its status and tier. The tree is
      // the correlator's — nested through parent links, siblings ordered by the
      // canonical tie-breakers — and its lineage record, read from the lineage
      // family, is what marks an attributed or ambiguous frame. A re-attached
      // frame's orphan mark is the correlator's own verdict from the parent
      // link, not the stored correlation flags, so those are not read here.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'name',
          ...EVENT_TAXONOMY_FIELDS,
          ...EVENT_TIMING_FIELDS,
          'status',
          ...CANONICAL_ORDER_FIELDS,
        ],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [LINEAGE_ATTRIBUTE_KEYS],
      }),
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
      // One column per field: name, kind, tier, offset, duration and status,
      // with the location chip as enrichment and the identity as what a
      // selected row hands to the host. `SpanTable` renders a column only while
      // this entry's `reads` grants its field. A table row has no parent.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'name',
          ...EVENT_TAXONOMY_FIELDS,
          ...EVENT_TIMING_FIELDS,
          'status',
        ],
        optionalFields: ['source'],
      }),
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
      // `aggregateRenders` folds every `render` event into its component's row
      // and refuses none: an unreadable component name becomes the unknown
      // label and an unreadable trigger the unknown bucket, so no attribute is
      // required. It reads the component, phase, trigger and changed props that
      // the row's columns and histograms show, the producer's running render
      // count each occurrence carries, and the reported render time as the
      // fallback for an unusable duration. The owner chain feeds only the
      // component tree, the self time and the commit's root name feed nothing
      // in this result, and a commit is not a render, so none is read here.
      ...declareReads({
        requiredFields: [...EVENT_IDENTITY_FIELDS, 'kind', ...EVENT_TIMING_FIELDS],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [
          attributeKeysFrom(RENDER_ATTRIBUTE_KEYS, [
            'component',
            'phase',
            'renderCount',
            'changedProps',
            'trigger',
            'actualDuration',
          ]),
        ],
      }),
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
      // is why its keys appear in the reads below rather than as a second entry
      // here: the kinds a node declares are the kinds a filter may narrow to,
      // and narrowing this view to the snapshot alone would lose the counts.
      telemetryKinds: RENDER_KINDS,
      // `buildComponentTreeSnapshot` takes the latest snapshot — selected by
      // its event name, ordered by the store's arrival number — or a commit's
      // serialized forest, falling back to the renders' owner chains and then
      // to a flat list, so every route is optional and none is required. A
      // node shows its component, its cumulative count and time, its latest
      // trigger and its location. The snapshot's own node count is not read:
      // the aggregate counts the nodes it actually emits. Nor are a render's
      // phase, changed props, running count or self time, or the commit's root
      // name, none of which reaches a tree node.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'kind',
          'name',
          ...EVENT_TIMING_FIELDS,
          'ingestSeq',
        ],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [
          attributeKeysFrom(RENDER_ATTRIBUTE_KEYS, [
            'component',
            'trigger',
            'actualDuration',
            'ownerChain',
          ]),
          attributeKeysFrom(COMPONENT_TREE_ATTRIBUTE_KEYS, [
            'componentTree',
            'componentTreeTruncated',
          ]),
        ],
      }),
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
      // `aggregateRequests` groups every request event and refuses none — a
      // missing method or URL becomes the unknown label, a missing status code
      // a response that never reported one — so no attribute is required. It
      // groups by the service-assigned key, reads the method, URL, status code,
      // initiator and in-flight marker the columns and the pending badge show,
      // and resolves bytes from the request's own reading or from the
      // resource-timing entry it is joined to, which is cross-kind provenance.
      // The same-origin and trace-header flags are not read by anything behind
      // this view.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          ...EVENT_TAXONOMY_FIELDS,
          ...EVENT_TIMING_FIELDS,
          'status',
        ],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [
          attributeKeysFrom(FETCH_ATTRIBUTE_KEYS, [
            'http.method',
            'url',
            'http.status_code',
            'initiator',
            'request_key',
            'transferSize',
            'resourceTimingUrl',
            'inFlight',
          ]),
          RESOURCE_TIMING_JOIN_KEYS,
        ],
      }),
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
      // `aggregateQueries` forms a group only for a database span carrying a
      // non-empty statement, so `db.statement` is the one required attribute in
      // the catalog: a capture whose spans all lack it draws an empty table
      // however many it holds. The system and row count are shown when present.
      // The caller of a statement is resolved by walking parent links up to the
      // enclosing application function or request handler, and what that walk
      // reads is the ancestor's kind, name and location — never an attribute of
      // the function or route-handler kinds, and never the database client,
      // name or operation.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'kind',
          'name',
          ...EVENT_TIMING_FIELDS,
          'status',
        ],
        requiredAttributes: [attributeKeysFrom(DB_QUERY_ATTRIBUTE_KEYS, ['db.statement'])],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [
          attributeKeysFrom(DB_QUERY_ATTRIBUTE_KEYS, ['db.system', 'db.rowCount']),
        ],
      }),
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
      // `aggregateStateTransitions` turns every `state` event, in canonical
      // order, into one row and refuses none, reading every key the kind
      // declares. The row also names the record it was triggered by, which is
      // why the name and kind are read: the trigger is shown by its own name
      // and kind, found through the producer's trigger ids, the parent chain
      // or — when that chain leads nowhere — a lineage candidate, and selecting
      // it moves to that record. A transition is an instant, so its duration
      // and tier are not read.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'kind',
          'name',
          'startTime',
          ...CANONICAL_ORDER_FIELDS,
        ],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [STATE_ATTRIBUTE_KEYS, LINEAGE_ATTRIBUTE_KEYS],
      }),
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
      // `buildDependencyGraph` sorts the records canonically, collapses each
      // into a participant by class (from its kind), tier and identity, sums
      // their durations, keeps the most confident location, and draws an edge
      // for every record hanging from another participant's — counting the
      // edges attributed through lineage and, of those, the ambiguous ones.
      // A participant's identity is the span name except for the four kinds
      // with something better: what an interaction did and to which element,
      // the matched route of a request or a route handler, and a function's
      // module and symbol. Those identity keys, read only when present, are
      // the graph's only per-kind attributes; nothing else of the interaction,
      // request, statement or function vocabularies is read, and neither is a
      // record's status.
      ...declareReads({
        requiredFields: [
          ...EVENT_IDENTITY_FIELDS,
          'name',
          ...EVENT_TAXONOMY_FIELDS,
          ...EVENT_TIMING_FIELDS,
          ...CANONICAL_ORDER_FIELDS,
        ],
        optionalFields: EVENT_LINK_FIELDS,
        optionalAttributes: [
          attributeKeysFrom(INTERACTION_ATTRIBUTE_KEYS, ['event.type', 'target.selector']),
          attributeKeysFrom(HTTP_SERVER_ATTRIBUTE_KEYS, ['http.route']),
          attributeKeysFrom(ROUTE_HANDLER_ATTRIBUTE_KEYS, ['http.route']),
          attributeKeysFrom(FUNCTION_ATTRIBUTE_KEYS, ['module', 'symbol']),
          LINEAGE_ATTRIBUTE_KEYS,
        ],
      }),
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
      ...NO_READS,
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
 * a declared contract. The prompt renderer below ({@link describeCatalogForPrompt})
 * iterates this list, and the package exports it for any other consumer that
 * needs the entries in order, so each meets them in the same order, run after
 * run. The renderer's component registry does not need it: that registry is a
 * literal record checked against the catalog's key type, and its coverage test
 * iterates `PANEL_NODE_TYPES` and the catalog's keys directly.
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
