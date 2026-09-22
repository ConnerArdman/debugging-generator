/**
 * The data-query vocabulary every visualization node is built on, and the node
 * primitives its two sibling modules share.
 *
 * This is the foundational module of the panel DSL's node vocabulary: `./layout.ts`
 * and `./viz.ts` compose it, and the parent folder's authoring schema, node
 * catalog, normaliser, validators and JSON-Schema renderer all import from it.
 * Nothing in the folder imports them back, which is what keeps the dependency
 * direction inside this package as acyclic as the package graph around it.
 *
 * A generated panel is a document of nodes, and a node is *what to draw* plus
 * *what to draw it from*. The second half is a {@link DataQuery}: a declarative
 * request the panel host resolves against one capture. That indirection is the
 * whole reason a model may author a panel at all — it names a prepared view of
 * the evidence and how to narrow it, and it can express nothing else. It cannot
 * reach a transport, cannot name a file, cannot carry markup and cannot smuggle
 * a value that was never captured.
 *
 * ## The source vocabulary is a wire contract
 *
 * Each member of {@link DATA_QUERY_SOURCES} corresponds to exactly one prepared
 * result shape. The coordination service's panel-data route resolves a source
 * into its shape, and the shared component library's components are written
 * against it:
 *
 * - `trace` -> `TraceTree` — one correlated interaction as an ordered tree
 * - `spans` -> `TelemetryEvent[]` — the span-shaped records, flat
 * - `events` -> `TelemetryEvent[]` — every captured record, flat, any kind
 * - `renders` -> `RenderStat[]` — per-component render counts and timing
 * - `componentTree` -> `ComponentTreeSnapshot` — the owner/parent tree with
 *   per-node render counts
 * - `requests` -> `RequestGroup[]` — network calls grouped for duplicate
 *   detection
 * - `queries` -> `QueryGroup[]` — database statements grouped by normalised,
 *   parameterized text
 * - `stateTransitions` -> `StateTransition[]` — hook state changes with their
 *   trigger
 * - `graph` -> `DependencyGraphData` — nodes and edges of the correlated flow
 * - `metrics` -> `MetricValue[]` — the computed metric values of a capture
 *
 * Those ten names are therefore **not an internal enum**. They travel in the
 * body of the panel-data request, they are persisted inside every stored panel
 * specification, they are rendered into the panel-generation prompt through this
 * package's JSON-Schema renderer, and they are switched on by the service's
 * panel-data resolver and read by every component of the shared renderer
 * library. Renaming one here breaks all four at once, and breaks stored panels
 * that were valid when they were written. Add a member rather than repurpose
 * one, and add it in the same commit as its result shape, its catalog entry and
 * its component.
 *
 * ## What this module deliberately does not own
 *
 * The temptation in a file like this is to answer every question about a query
 * in one place. Four answers live elsewhere on purpose:
 *
 * - **Which sources a given node type may read** is the node catalog's single
 *   registry, checked by the syntactic validator. Encoding it here too would
 *   create the second source of truth the catalog's own test exists to prevent.
 * - **Whether a trace id, component or metric actually exists in the capture**
 *   is semantic validation, which is the only layer that can see a capture at
 *   all. Nothing here can be more than well-formed.
 * - **What an omitted `limit` or `offset` means** is the service's decision,
 *   applied when the query is resolved. The constants it applies are exported
 *   from here (see {@link DATA_QUERY_DEFAULT_LIMIT}) so both sides agree on the
 *   numbers, but no schema below carries a `.default()`: see that constant for
 *   why a parsed query must equal the authored one, field for field.
 * - **Lifting a flat authoring field into `node.query`** is the deterministic
 *   normaliser's job. This module contributes the authoritative field list
 *   ({@link DATA_QUERY_FLAT_FIELD_KEYS}) and nothing that transforms a value:
 *   no `.transform()`, no `.preprocess()`, no shape change of any kind.
 *
 * ## Why the node primitives are here
 *
 * {@link panelNodeIdSchema}, {@link panelNodeTitleSchema} and
 * {@link panelNodeDescriptionSchema} are needed identically by `./layout.ts` and
 * `./viz.ts`. Declared in both, they would be two definitions of one field, and
 * the first tightened bound or widened charset would silently apply to half the
 * node vocabulary. They are therefore declared once, in the module both siblings
 * already depend on.
 *
 * A node's `id` belongs to the **normalized** form only. The authoring schema
 * rejects an authored `id`, because identity is assigned by the normaliser from
 * the node's position in the layout — deterministically, so that regenerating a
 * panel from the same analysis yields the same ids and a stored panel's
 * selection survives a reload. A model naming its own nodes could collide with
 * that scheme or with itself.
 *
 * ## Constraints every declaration below works under
 *
 * - **Environment-neutral.** The sibling build compiles this package with no
 *   platform assumptions, because the local service, the DevTools panel and the
 *   editor webview all load it. No `node:` builtin, no DOM global, and no
 *   import-time side effect: every export here is a frozen vocabulary, a
 *   constant, a schema or a pure function.
 * - **JSON-Schema-representable.** The parent folder renders the authoring
 *   schema that mirrors these shapes into a versioned prompt file, configured to
 *   fail on anything it cannot represent. Every constraint below is declarative
 *   — `min`, `max`, `int`, `regex`, `enum` — so the model reads the same limits
 *   the validator enforces. A refinement would still be enforced at runtime but
 *   would vanish from the rendered document, turning an expressible limit into a
 *   parse failure and a wasted repair round-trip; there is none below, and none
 *   is needed.
 * - **Privacy.** {@link parseDataQuery} reports a rejection by the *shape* of
 *   the failure and never by the data that caused it. The rule and its single
 *   implementation live in `../summary.js`; this module imports that
 *   implementation rather than repeating it.
 *
 * @example
 * ```ts
 * // A ranking of the slowest work in one capture: a source, a floor on
 * // duration, an ordering and a page size. The kind and tier vocabularies a
 * // filter can also narrow by belong to the telemetry package and are imported
 * // from it, never spelled at a call site.
 * const query = parseDataQuery({
 *   source: 'spans',
 *   filter: { minDuration: 5 },
 *   sort: 'duration_desc',
 *   limit: 20,
 * });
 *
 * if (query.ok) {
 *   const result = await dataProvider.query(query.value);
 * }
 * ```
 */

import { z } from 'zod';

import { DebuggenError, err, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { TELEMETRY_KINDS, TELEMETRY_TIERS } from '@debuggen/telemetry';

import { describeIssues } from '../summary.js';

/*
 * ---------------------------------------------------------------------------
 * Sources
 * ---------------------------------------------------------------------------
 */

/**
 * Every prepared view of a capture a node may read, in the order the panel-data
 * contract fixes.
 *
 * The order is part of the declaration rather than an accident of typing: it is
 * the order the rendered JSON Schema lists for the model, and it runs from the
 * most structured view to the least — the correlated tree, then the flat record
 * lists, then the per-concern aggregates, then the computed metrics. See the
 * module documentation above for the result shape each member resolves to, and
 * for why this tuple may be extended but never rewritten.
 *
 * Frozen: a read-only vocabulary shared by four processes.
 */
export const DATA_QUERY_SOURCES = Object.freeze([
  /**
   * One correlated interaction as an ordered tree, spanning every tier. Needs a
   * `traceId` filter to name which one, since a capture holds many.
   */
  'trace',
  /**
   * The span-shaped records of the capture, flat. The view for ranking work by
   * duration across tiers.
   */
  'spans',
  /**
   * Every captured record, flat and of any kind, in capture order. The view for
   * a chronological log rather than a ranking.
   */
  'events',
  /**
   * Per-component render statistics: how often each component rendered, how
   * long it took, what triggered it, and which of its props changed.
   */
  'renders',
  /**
   * The component tree as it stood at the last commit of the capture, with each
   * node's render count.
   */
  'componentTree',
  /**
   * Network calls grouped so that byte-identical requests collide and
   * differently parameterized ones do not — the view duplicate detection reads.
   */
  'requests',
  /**
   * Database statements grouped by their normalised, parameterized text, with
   * per-group execution counts and timing. Statements only: no row contents are
   * ever captured, so none can be queried.
   */
  'queries',
  /**
   * Hook state changes: what each transition moved from and to, and the event
   * that triggered it.
   */
  'stateTransitions',
  /**
   * The correlated flow as nodes and edges — the interaction, the functions it
   * reached, the calls it made and the datastore it ended at.
   */
  'graph',
  /**
   * The computed metric values of the capture, addressed by the metric ids the
   * telemetry package's aggregates own.
   */
  'metrics',
] as const);

/**
 * One member of the closed source vocabulary.
 *
 * Derived from {@link DATA_QUERY_SOURCES}, so the runtime tuple and the static
 * type cannot disagree. This is the type the node catalog constrains per node
 * type and the service's panel-data resolver switches on.
 */
export type DataQuerySource = (typeof DATA_QUERY_SOURCES)[number];

/** Widened view of {@link DATA_QUERY_SOURCES} used by {@link isDataQuerySource}. */
const DATA_QUERY_SOURCE_VALUES: readonly string[] = DATA_QUERY_SOURCES;

/**
 * Narrow an untrusted value to a {@link DataQuerySource} by membership in
 * {@link DATA_QUERY_SOURCES}.
 *
 * For the places that classify a value before a schema is available: a stored
 * panel row being read back, a source name arriving on its own rather than
 * inside a query. {@link dataQuerySchema} is the primary gate; this predicate
 * exists so that no caller has to spell the vocabulary to ask the question.
 */
export function isDataQuerySource(value: unknown): value is DataQuerySource {
  return typeof value === 'string' && DATA_QUERY_SOURCE_VALUES.includes(value);
}

/**
 * The `source` field's schema, described for the model that authors it.
 *
 * Exported separately from {@link dataQuerySchema} because the authoring schema
 * accepts `source` written flat on a node — before normalisation lifts it into
 * the node's `query` — and must validate it there with exactly this definition.
 */
export const dataQuerySourceSchema = z
  .enum(DATA_QUERY_SOURCES)
  .describe(
    'Which prepared view of the captured evidence this node reads. Each source resolves to its own result shape: one correlated interaction as an ordered tree, the span records or every record as a flat list, per-component render statistics, the component tree with render counts, grouped network requests, grouped database statements, hook state transitions, the correlated flow as a graph, or the computed metric values of the capture.',
  );

/*
 * ---------------------------------------------------------------------------
 * Sorts
 * ---------------------------------------------------------------------------
 */

/**
 * Every ordering an array-valued source may be asked for.
 *
 * Three, deliberately, and each answers a question a panel actually asks: what
 * took longest, what happened first, and what happened most often. A free-form
 * sort expression would be a query language the model could author and the
 * service would have to interpret; a closed vocabulary is one the resolver can
 * implement exhaustively for every source it supports.
 *
 * The scalar sources — the correlated tree and the component tree, whose order
 * is their structure, and the metric values, whose order is the order they were
 * asked for — ignore this field. The node catalog records which node types can
 * meaningfully use it.
 *
 * Frozen: a read-only vocabulary.
 */
export const DATA_QUERY_SORTS = Object.freeze([
  /** Longest first, by measured duration. The ranking a latency panel opens with. */
  'duration_desc',
  /** Earliest first, by start time. Chronological order, for a log or a timeline. */
  'start_asc',
  /**
   * Largest group first, by occurrence count. Only meaningful for the grouped
   * sources, where a count exists to sort by.
   */
  'count_desc',
] as const);

/**
 * One member of the closed sort vocabulary.
 *
 * Derived from {@link DATA_QUERY_SORTS} so the tuple and the type stay one
 * declaration.
 */
export type DataQuerySort = (typeof DATA_QUERY_SORTS)[number];

/** Widened view of {@link DATA_QUERY_SORTS} used by {@link isDataQuerySort}. */
const DATA_QUERY_SORT_VALUES: readonly string[] = DATA_QUERY_SORTS;

/**
 * Narrow an untrusted value to a {@link DataQuerySort} by membership in
 * {@link DATA_QUERY_SORTS}.
 *
 * The counterpart of {@link isDataQuerySource}, and exported for the same
 * reason: so a caller reading a sort name out of a stored row or a user-interface
 * control never has to restate the vocabulary to test it.
 */
export function isDataQuerySort(value: unknown): value is DataQuerySort {
  return typeof value === 'string' && DATA_QUERY_SORT_VALUES.includes(value);
}

/**
 * The `sort` field's schema, described for the model that authors it.
 *
 * Exported separately for the same reason {@link dataQuerySourceSchema} is: the
 * authoring schema accepts `sort` written flat on a node and validates it there
 * with this definition, before the normaliser moves it into the node's query.
 */
export const dataQuerySortSchema = z
  .enum(DATA_QUERY_SORTS)
  .describe(
    'Ordering applied to an array-valued source: longest duration first, earliest start first, or largest group first. The service breaks ties with a stable secondary key per source, so the same data always orders identically and paging through it never repeats or skips an item. Omit to accept the natural order of the source.',
  );

/*
 * ---------------------------------------------------------------------------
 * Filter bounds
 *
 * Every string and array in the filter below is bounded, and the bounds are
 * exported rather than inlined. A filter is model-authored and arrives from
 * another process, so each field states a ceiling and rejects above it; and the
 * numbers reach the model inside the rendered JSON Schema, so exporting them is
 * what keeps the prompt, the normaliser and the validator agreeing on one set of
 * limits.
 * ---------------------------------------------------------------------------
 */

/**
 * Longest accepted {@link DataQueryFilter.traceId}, in characters: **128**.
 *
 * Generous on purpose. A trace identifier in this product is a 32-character hex
 * string, but this field is not the place that asserts it — see the field's own
 * documentation — so the bound is a sanity ceiling rather than a format, wide
 * enough for any identifier a correlated trace could legitimately carry and
 * narrow enough that an unbounded string can never be stored, broadcast and
 * rendered as one.
 */
export const DATA_QUERY_MAX_TRACE_ID_LENGTH = 128;

/**
 * Longest accepted {@link DataQueryFilter.component}, in characters: **200**.
 *
 * A component display name, which in a real codebase can be a wrapped or
 * namespaced name several segments long. Two hundred characters accommodates
 * that and rejects prose.
 */
export const DATA_QUERY_MAX_COMPONENT_LENGTH = 200;

/**
 * The fields of a {@link DataQuery} filter, as a reusable shape.
 *
 * Declared as a plain object of field schemas — the device the sibling schema
 * modules use — so the authoring schema can reuse the identical field
 * definitions rather than retyping them. Retyping is how two shapes drift, and a
 * filter that validated differently before and after normalisation would let a
 * query through one gate and fail at the other.
 *
 * Every field is optional and every field *narrows*: a filter can only ever
 * reduce what a source returns, never widen it or reach outside the capture. An
 * empty filter is therefore legal and means "the whole source".
 */
const dataQueryFilterShape = {
  /**
   * Restrict the result to one correlated trace.
   *
   * **Deliberately a bounded plain string, not a 32-hex pattern**, and this is
   * the one field in the module where the loose constraint is the considered
   * choice rather than the lenient one. Three reasons, all structural:
   *
   * - The authoring example a model is shown carries a placeholder here, because
   *   a trace id cannot be known when a panel is being authored — the capture it
   *   would name has not been correlated yet. The authoring schema has to accept
   *   that placeholder verbatim.
   * - The normaliser passes this value through **unchanged**. Its test asserts an
   *   exact normalised object, so a schema that rewrote, padded or lower-cased a
   *   trace id would fail it, and a schema that rejected the placeholder would
   *   fail it earlier still.
   * - Semantic validation is the single checkpoint that resolves a trace id
   *   against the capture and rejects one the capture does not hold. It is the
   *   only layer that can: a trace id is well-formed or not here, but *present*
   *   or not only there. A format constraint in this position would move that
   *   rejection to the wrong layer and convert a recoverable semantic failure —
   *   which the panel-generation stage handles by substituting a deterministic
   *   fallback — into an authoring-schema failure that burns a repair attempt on
   *   a value the model could not have known.
   */
  traceId: z
    .string()
    .min(1)
    .max(DATA_QUERY_MAX_TRACE_ID_LENGTH)
    .optional()
    .describe(
      'Restrict the result to one correlated interaction, named by its trace id. Required by the views that draw a single interaction, since a capture holds many. Leave the placeholder in place when the trace is not known at authoring time; it is resolved against the capture when the panel is validated.',
    ),

  /**
   * Restrict the result to these telemetry kinds.
   *
   * The vocabulary is imported, never restated: the telemetry package owns the
   * closed kind list, and a second copy of it here would be a copy that drifts
   * the moment a producer learns to describe something new. Both bounds are
   * derived from that same tuple — at least one kind, because an empty array is
   * a filter that excludes everything and is more likely a mistake than an
   * intent, and at most as many as exist, because a list longer than the
   * vocabulary can only contain repeats.
   */
  kinds: z
    .array(z.enum(TELEMETRY_KINDS))
    .min(1)
    .max(TELEMETRY_KINDS.length)
    .optional()
    .describe(
      'Restrict the result to records of these kinds. At least one kind, and each drawn from the closed kind vocabulary listed in the item schema. Omit to accept every kind the source offers.',
    ),

  /**
   * Restrict the result to one component, by its display name.
   *
   * Matched against the name the runtime reports for a component, which is what
   * the render statistics and the component tree are keyed by. No pattern is
   * imposed: a display name is whatever the framework resolves it to, and
   * constraining its charset here would reject legitimate wrapped and namespaced
   * names rather than catching anything.
   */
  component: z
    .string()
    .min(1)
    .max(DATA_QUERY_MAX_COMPONENT_LENGTH)
    .optional()
    .describe(
      'Restrict the result to one component, named exactly as the runtime reports its display name. Omit to accept every component in the source.',
    ),

  /**
   * Restrict the result to one tier of the stack.
   *
   * The vocabulary is imported from the telemetry package for the same reason
   * the kinds are: the tier of a record is a property of its producer, declared
   * once where producers are described.
   */
  tier: z
    .enum(TELEMETRY_TIERS)
    .optional()
    .describe(
      'Restrict the result to one tier of the stack: the browser, the server, or the database. Omit to span every tier, which is what a cross-tier view of one interaction wants.',
    ),

  /**
   * Drop items shorter than this duration, in **milliseconds**.
   *
   * Milliseconds is the canonical unit of every duration in this product, on the
   * wire and in the store alike, so no conversion happens anywhere and none is
   * implied here. Fractional values are accepted, because sub-millisecond
   * precision is captured and a threshold of a quarter of a millisecond is a
   * legitimate request.
   *
   * `0` is a **valid value that must survive parsing**, and is not the same
   * thing as an absent field: it is an explicit statement that no floor applies,
   * and it round-trips as written. The schema library already rejects a
   * non-finite number, so an infinite or not-a-number threshold needs no
   * refinement to exclude it — which keeps this constraint fully expressible in
   * the rendered JSON Schema.
   */
  minDuration: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Drop items whose measured duration is below this many milliseconds. Fractional values are allowed. Zero is valid and means no floor applies. Omit to keep every item regardless of duration.',
    ),
};

/**
 * A narrowing filter on a {@link DataQuery}, and the definition of
 * {@link DataQueryFilter}.
 *
 * Strict: an unrecognised key is a rejection. That strictness is load-bearing
 * rather than fastidious — it is what proves, later, that a flat authoring field
 * was genuinely lifted into the node's query by the normaliser instead of being
 * carried through unnoticed, and it is what stops an invented filter dimension
 * from being silently ignored and quietly changing what a panel claims to show.
 */
export const dataQueryFilterSchema = z.strictObject(dataQueryFilterShape);

/**
 * What a node may narrow its source by.
 *
 * Inferred from {@link dataQueryFilterSchema}, so the validator and the type are
 * one statement. Exported in its own right because the authoring schema, the
 * normaliser and the service's panel-data resolver each take a filter on its
 * own, apart from the query that carries it.
 */
export type DataQueryFilter = z.infer<typeof dataQueryFilterSchema>;

/*
 * ---------------------------------------------------------------------------
 * Paging
 *
 * Three constants, exported because two processes have to agree on them: the
 * service applies them when it resolves a query, and this package states them to
 * the model when it renders the authoring schema. Neither number is repeated at
 * a call site.
 * ---------------------------------------------------------------------------
 */

/**
 * Items returned from an array-valued source when a query omits `limit`:
 * **200**.
 *
 * Applied by the service's panel-data resolver, never by a schema in this
 * module. Two hundred rows is more than any panel view shows at once and small
 * enough to serialise, store in a panel's resolved data and render without a
 * page feeling stalled; a view that needs more pages for it with `offset`.
 *
 * **This constant is a service default, not a schema default.** It is exported
 * so the resolver reads it from here rather than restating the number, which is
 * the only way the value the prompt describes and the value the service applies
 * stay the same value.
 */
export const DATA_QUERY_DEFAULT_LIMIT = 200;

/**
 * Largest `limit` a query may ask for: **5000**.
 *
 * Unlike the default above, this one *is* enforced by the schema, because it is
 * the boundary between a legitimate request and a capture dump: a query above it
 * is refused rather than truncated, so a model cannot ask for the entire
 * telemetry table and call the result a panel. The ceiling appears in the
 * rendered JSON Schema as the field's maximum, so the model is told the limit
 * rather than discovering it through a rejection.
 */
export const DATA_QUERY_MAX_LIMIT = 5000;

/**
 * Where an array-valued source starts when a query omits `offset`: **0**.
 *
 * A service default like {@link DATA_QUERY_DEFAULT_LIMIT}, exported for the same
 * reason, and the identity of the paging operation: the first page of a result is
 * the one no query had to ask for.
 */
export const DATA_QUERY_DEFAULT_OFFSET = 0;

/*
 * ---------------------------------------------------------------------------
 * The query object
 * ---------------------------------------------------------------------------
 */

/**
 * The query fields the authoring schema accepts written **flat on a node**, and
 * that the normaliser lifts into that node's `query`.
 *
 * The authoring shape a model writes puts `source`, `filter`, `sort`, `limit` and
 * `offset` directly on a node; the normalized shape a renderer receives has them
 * inside `node.query`. Both sides of that move need the same field list — the
 * authoring schema to accept them, the normaliser to lift them, the validator to
 * confirm none stayed behind — and a list maintained in three files is a list
 * that disagrees with itself after the first edit. It is declared here, once, in
 * the module all three already import.
 *
 * `metrics` is deliberately **absent**. It is not a query field: the metric ids a
 * metric-card node displays stay an option of that node, and normalisation gives
 * such a node the metrics source as its query without moving `metrics` into it. A
 * `metrics` entry in this tuple would make the normaliser relocate a field the
 * renderer reads from the node itself, and the node would render empty.
 *
 * Frozen: a read-only vocabulary.
 */
export const DATA_QUERY_FLAT_FIELD_KEYS = Object.freeze([
  'source',
  'filter',
  'sort',
  'limit',
  'offset',
] as const);

/**
 * One member of {@link DATA_QUERY_FLAT_FIELD_KEYS}.
 *
 * Used by the normaliser to key its lift, and below to prove that the tuple and
 * the query schema describe the same set of fields.
 */
export type DataQueryFlatFieldKey = (typeof DATA_QUERY_FLAT_FIELD_KEYS)[number];

/**
 * The fields of a {@link DataQuery}, as a reusable shape.
 *
 * The `satisfies` clause is a compile-time proof, not a decoration, and it is
 * what makes {@link DATA_QUERY_FLAT_FIELD_KEYS} trustworthy as *the* field list.
 * It fails in both directions: a field declared here and missing from the tuple
 * leaves the record type unsatisfied, and a field listed in the tuple with no
 * declaration here leaves a required key of the record type unimplemented. A
 * query field can therefore only be added or renamed in both places at once,
 * which is the one guarantee three separate consumers of that tuple need and
 * cannot check for themselves.
 *
 * No field carries a `.default()`. A specification is stored and replayed
 * verbatim, so a parsed query must equal the authored one field for field: a
 * schema-level default would materialise `limit: 200` and `offset: 0` on a query
 * that never said either, which defeats the normaliser's exact-object assertion,
 * hides from the authoring tests whether a flat field was really lifted or merely
 * filled in, and would make two stored panels differ from each other purely by
 * which version of this file parsed them. Defaults belong to the side that reads
 * a query, and that side has the constants above.
 */
const dataQueryShape = {
  /**
   * Which prepared view of the capture this node reads. The only required
   * field: a node without a source has nothing to draw, and no source is a
   * sensible fallback for another.
   */
  source: dataQuerySourceSchema,

  /**
   * How to narrow the source. Optional, and an omitted filter means the whole
   * source.
   */
  filter: dataQueryFilterSchema
    .optional()
    .describe(
      'How to narrow the source before anything is drawn. Every field of a filter is optional and every field narrows; omit the filter entirely to read the whole source.',
    ),

  /** How to order an array-valued source. Ignored by the scalar sources. */
  sort: dataQuerySortSchema.optional(),

  /**
   * How many items to return from an array-valued source.
   *
   * An integer, at least zero and at most {@link DATA_QUERY_MAX_LIMIT}. Zero is
   * legal and is preserved exactly: it is an explicit request for no items,
   * which a node may legitimately make when it wants a total without rows, and
   * nothing downstream may read it as "unset" — the absence of the field is the
   * only thing that means unset.
   */
  limit: z
    .int()
    .min(0)
    .max(DATA_QUERY_MAX_LIMIT)
    .optional()
    .describe(
      `How many items to return from an array-valued source. A whole number from 0 to ${String(DATA_QUERY_MAX_LIMIT)}; zero explicitly requests no items. Omit to accept the default page size of ${String(DATA_QUERY_DEFAULT_LIMIT)} items.`,
    ),

  /**
   * How many items to skip before the returned page.
   *
   * An integer, at least zero, and unbounded above: the ceiling on a page is the
   * number of items the source actually holds, which only the service can know,
   * and an offset past the end is an empty page rather than an error.
   */
  offset: z
    .int()
    .min(0)
    .optional()
    .describe(
      'How many items to skip before the returned page, for reading an array-valued source one page at a time. Omit to start at the first item. The response reports the total and the next offset, so a view never has to guess whether more items remain.',
    ),
} satisfies Record<DataQueryFlatFieldKey, z.ZodType>;

/**
 * A declarative request for the data one node draws, and the definition of
 * {@link DataQuery}.
 *
 * Strict, for the reason {@link dataQueryFilterSchema} is strict and one more: a
 * query is the entire vocabulary a generated panel has for reaching evidence, so
 * an unrecognised key on it is either a field this module removed — in which case
 * the panel was written against a contract that no longer holds and must be
 * regenerated rather than half-honoured — or a dimension the author invented,
 * which would be ignored by the resolver while the panel went on claiming to show
 * something narrower than it does.
 */
export const dataQuerySchema = z.strictObject(dataQueryShape);

/**
 * What to draw a node from: a source, optionally narrowed, ordered and paged.
 *
 * Inferred from {@link dataQuerySchema}, so the validator and the type are one
 * statement. This is the type carried by every visualization node except the
 * source-link leaf, the body of the panel-data request, and the argument of the
 * data provider the shared renderer library resolves its nodes through.
 */
export type DataQuery = z.infer<typeof dataQuerySchema>;

/*
 * ---------------------------------------------------------------------------
 * Shared node primitives
 *
 * The fields every node has regardless of what it draws: an identity and two
 * optional labels. Declared here because `./layout.ts` and `./viz.ts` both need
 * them identically, and a field defined twice is a field whose two definitions
 * diverge. See the module documentation above for why identity in particular
 * belongs to the normalized form only.
 * ---------------------------------------------------------------------------
 */

/**
 * Longest accepted node id, in characters: **200**.
 *
 * An id is a layout path, so its length grows with nesting depth rather than
 * with anything a model chooses. Two hundred characters is far beyond any layout
 * a panel can usefully present — depth is bounded long before this is — and it
 * bounds the field for the case that matters here: an id arriving from a stored
 * panel or another process, which is validated rather than trusted.
 */
export const PANEL_NODE_ID_MAX_LENGTH = 200;

/**
 * The charset a node id may use: letters, digits, `.`, `_`, `-`, `:`, `[` and
 * `]`, at least one character.
 *
 * Permissive enough for both spellings of a layout path — the dotted form and
 * the bracketed-index form — because the normaliser owns that choice and this
 * module must not decide it on the normaliser's behalf; tight enough that an id
 * stays safe to use as a key, a fragment and a test selector: no whitespace, no
 * path separator, no quote, no angle bracket, nothing that needs escaping
 * wherever an id is written down.
 *
 * Deliberately **not** any identifier shape borrowed from elsewhere. A layout
 * path is not a trace id, not a span id and not a prefixed random id, and
 * reusing one of those patterns here would couple this field to a vocabulary it
 * has nothing to do with — and reject every legitimate value on the first
 * character.
 */
export const PANEL_NODE_ID_PATTERN = /^[A-Za-z0-9._:[\]-]+$/;

/**
 * The identity of one node within a panel, and the definition of
 * {@link PanelNodeId}.
 *
 * Required wherever it appears, which is the normalized node form only. It is
 * derived by the normaliser from the node's position in the layout and never
 * randomly: two normalisations of the same analysis produce the same ids, so a
 * selection, a scroll position and a deep link survive a panel being
 * regenerated, and a panel that supersedes another can be compared with it node
 * by node.
 */
export const panelNodeIdSchema = z
  .string()
  .min(1)
  .max(PANEL_NODE_ID_MAX_LENGTH)
  .regex(PANEL_NODE_ID_PATTERN, {
    error: 'id must use only letters, digits, and the characters . _ - : [ ]',
  });

/**
 * A node's identity within one panel.
 *
 * A branded-looking alias rather than a distinct nominal type on purpose: it is
 * a string wherever it is used — a React key, a lookup key in the host's node
 * registry, a value in a data attribute — and the checking that matters happens
 * when a panel is parsed, not at every read.
 */
export type PanelNodeId = z.infer<typeof panelNodeIdSchema>;

/**
 * Longest accepted node title, in characters: **200**.
 *
 * A title is a heading above one visualization, read at a glance. Two hundred
 * characters is a long heading and a short sentence, which is the right place
 * for the boundary: a model that has more to say has the panel summary for it.
 */
export const PANEL_NODE_TITLE_MAX_LENGTH = 200;

/**
 * Longest accepted node description, in characters: **500**.
 *
 * A description is the sentence under a heading that says what the view below is
 * showing. Longer than a title because it is a sentence rather than a label, and
 * bounded well short of a screen because it is neither the analysis nor the
 * evidence.
 */
export const PANEL_NODE_DESCRIPTION_MAX_LENGTH = 500;

/**
 * The optional heading of any node.
 *
 * Free text, and free text is exactly what it stays: a title is a label the
 * developer reads, never a finding. Nothing in this package or the renderer
 * treats it as an observation, and nothing promotes it into one — the summary's
 * observed list accepts only evidence-bearing facts, which is a different type
 * in a different module.
 */
export const panelNodeTitleSchema = z
  .string()
  .min(1)
  .max(PANEL_NODE_TITLE_MAX_LENGTH)
  .describe(
    'Optional heading shown above this node. A short label, not a finding: an observation belongs in the panel summary, where it must cite the captured evidence that supports it.',
  );

/**
 * The optional supporting line of any node.
 *
 * One sentence explaining what the view below shows or how to read it. Governed
 * by the same rule as the title, and for the same reason: prose here is
 * presentation, and an assertion about the capture has to be a fact with
 * evidence attached instead.
 */
export const panelNodeDescriptionSchema = z
  .string()
  .min(1)
  .max(PANEL_NODE_DESCRIPTION_MAX_LENGTH)
  .describe(
    'Optional sentence shown under the heading, explaining what this view shows or how to read it. Presentation only: a claim about what the capture demonstrates belongs in the panel summary with its evidence.',
  );

/*
 * ---------------------------------------------------------------------------
 * Non-throwing parser
 * ---------------------------------------------------------------------------
 */

/** The name this module reports for {@link dataQuerySchema} in a rejection. */
const DATA_QUERY_SCHEMA_NAME = 'dataQuery';

/** The hint offered when a data query fails validation. */
const DATA_QUERY_HINT =
  'A data query needs a source from the closed source vocabulary, and may add a narrowing filter, a sort from the closed sort vocabulary, and whole-number limit and offset values; no other field is accepted.';

/**
 * Validates an unknown value as a {@link DataQuery}, without throwing.
 *
 * This is how a query that arrived from somewhere else becomes a typed one: a
 * body posted by the DevTools panel, a node read back out of a stored panel
 * specification, a query assembled by a user-interface control. None of those is
 * trusted — the panel runs in a browser and its request reaches a service on the
 * developer's own machine — so the query is parsed at the boundary rather than
 * destructured on arrival.
 *
 * Non-throwing is a requirement rather than a preference, and it matches the
 * package's other parsers: a rejected query must degrade the one node that
 * carried it, not abort the request that resolved the panel or the stage that
 * generated it, so the caller inspects the result and continues.
 *
 * **The error carries the shape of the failure and none of the data that caused
 * it.** Issue paths and codes only, through the single implementation of that
 * rule in `../summary.js` — because this error is logged, may be persisted with
 * the session, travels to both user interfaces over the transport's error
 * message, and passes through neither the redaction layer nor the outbound model
 * guard on the way. A trace id, a component name or a duration threshold must
 * not be recoverable from a validation failure, and the only way to guarantee
 * that is for the offending value never to enter one.
 *
 * The code is the panel-validation code from the shared closed vocabulary, which
 * is the code this package's other parsers use; a caller at a stage boundary that
 * wants the model-output vocabulary maps it. No code is invented here.
 *
 * @param value Any value believed to be a data query.
 * @returns `ok(query)` with the parsed query, or `err(error)` describing every
 * issue found, by path and code only.
 */
export function parseDataQuery(value: unknown): Result<DataQuery, DebuggenError> {
  const parsed = dataQuerySchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    new DebuggenError(
      'PANEL_INVALID',
      `A value did not match the ${DATA_QUERY_SCHEMA_NAME} schema.`,
      {
        hint: DATA_QUERY_HINT,
        details: {
          schema: DATA_QUERY_SCHEMA_NAME,
          issues: describeIssues(parsed.error.issues),
        },
      },
    ),
  );
}
