/**
 * The **authoring schema**: the shape a panel may be written in, by a model or
 * by a hand assembling one, before anything deterministic touches it.
 *
 * A generated panel reaches the screen through three fixed steps, and this
 * module is the first of them (AAP 0.5.3):
 *
 * 1. **Validate the authored form** — `panelSpecInputSchema` here, driven by
 *    `parsePanelSpecInput`. A failure at this step is *recoverable*: the model
 *    provider re-prompts with the validation errors, at most twice.
 * 2. **Normalise, deterministically** — `./normalize.ts`. No model, no
 *    randomness, no I/O: flat query fields move into each node's `query`, node
 *    ids are derived from the layout path, and the summary's observed facts are
 *    copied from the validated analysis and from nowhere else.
 * 3. **Validate the internal form** — `./spec.ts` and `./validate.ts`, then
 *    `./semantic.ts` against the capture itself.
 *
 * The asymmetry between step 1 and the steps after it is what shapes every
 * decision below. A step-1 failure is a *message to the author*, so it must be
 * precise, cheap and repairable. A step-2 or step-3 failure is a **product
 * bug** — it is reported as a rejection and never retried against the model —
 * so this schema must not accept anything normalisation would go on to turn
 * into a document the internal schema refuses. That gives the module its one
 * rule: **permissive about form, strict about vocabulary**, and every bound it
 * applies is the internal bound it corresponds to, imported rather than
 * restated.
 *
 * ## This is the schema the model is shown
 *
 * `./json-schema.ts` renders **this** schema — never the internal one — and the
 * panel-generation stage embeds the result in its versioned prompt file
 * (`apps/local-service/prompts/generate-panel/v001.md`). Two consequences, both
 * load-bearing:
 *
 * - **Every constraint here must be expressible in JSON Schema.** Nothing
 *   reachable from `panelSpecInputSchema` may use `z.custom`, `.transform()`,
 *   `.preprocess()` or a refinement that cannot be rendered: such a construct
 *   either fails the emission or, worse, vanishes from it silently, leaving the
 *   model told about a contract looser than the one it is judged by. Bounds are
 *   therefore expressed with `z.enum`, `.min`/`.max` and `.int` only.
 * - **Descriptions are documentation with an audience.** Each `.describe()`
 *   below lands in the emitted schema and is, beyond the prompt's own prose,
 *   the only guidance the author gets. They are written for that reader, and
 *   they name no application, framework or project symbol (AAP 0.5.4).
 *
 * The provider is not trusted to enforce what is emitted: the structured-output
 * helpers strip JSON-Schema keywords they do not support — numeric bounds among
 * them (AAP 0.2.4) — so a value can arrive violating a constraint the model was
 * shown. This schema's own `.parse` is the gate, and it is the only gate.
 *
 * One consequence of that emission is worth naming here, because it is a
 * property of *this* module rather than of the emitter: the field schemas below
 * are **shared instances**, not per-node copies — one source enumeration, one
 * filter, one limit — so every repetition across the sixteen node types is the
 * same schema object, and each leaf is the same schema object at every one of
 * the nesting levels described under "The node union, level by level". Rendered
 * with reference reuse, the document is roughly 60 KB of definitions and
 * references (60,046 characters, measured on this schema); inlined, each level
 * would be copied into each of the three containers of the level above, and
 * the rendering outgrows the longest string the runtime can hold. A future edit
 * that rebuilt any of those fields per node, or the leaves per level, would
 * multiply the prompt's schema section while changing nothing about what is
 * accepted.
 *
 * ## What the authored form deliberately allows
 *
 * - **Query fields written flat on a node**, `source`, `filter`, `sort`,
 *   `limit` and `offset`, *and* the same fields inside a nested `query` object.
 *   Both forms are accepted because both are natural to write; normalisation
 *   resolves them into the single internal form. When a node carries both, the
 *   nested `query` wins for the keys it declares and the flat fields fill the
 *   gaps — stated here, implemented once, in `./normalize.ts`.
 * - **A bare string summary.** `summary` is `string | { … }`, and the string
 *   form is the common one. It becomes the panel summary's non-evidentiary
 *   headline; it never becomes an observed fact. Facts come only from the
 *   validated analysis, which is why the object form's purported facts and
 *   citations are not even representable here (see `authoredSummaryProseSchema`).
 * - **A `metricCards` node with no source.** The source of a metric-card row is
 *   implied, and normalisation supplies it from the node catalog.
 * - **A trace-id placeholder.** See `dataQueryInputSchema`: a trace identifier
 *   cannot be known while a panel is being authored, so this layer checks no
 *   format for it and semantic validation resolves it against the capture.
 *
 * ## What it deliberately refuses
 *
 * - **Node ids.** Every node object is strict and declares no `id`, so an
 *   authored one is rejected. Ids are derived from a node's position in the
 *   layout by `./normalize.ts`; accepting an authored id would make the
 *   normaliser's exact-object test depend on what a model chose to write, and
 *   would give two regenerations of one panel node identities that differ.
 * - **Any other unrecognised key**, at the document level and on every node.
 *   The flat query fields are declared *explicitly* on each node rather than
 *   admitted by a passthrough, which is what lets the objects stay strict while
 *   accepting both query forms: an invented dimension is rejected here instead
 *   of surviving into a panel that claims to present it.
 *
 * ## What it deliberately does not decide
 *
 * **Which sources a given node type may read.** That is the node catalog's
 * statement (`./catalog.ts`) and `./validate.ts` applies it after
 * normalisation. Restating it here would put the same rule in two places, and
 * would flatten into the emitted JSON Schema as a per-node source enumeration
 * that has to be regenerated whenever the catalog changes. A node that names a
 * known source its type cannot read is therefore accepted at step 1 and
 * rejected at step 3, with the catalog as the single registry throughout.
 *
 * Environment-neutral, like every module in this package: no `node:` builtin,
 * no DOM global, no side effect at load. Importing it builds schemas and
 * nothing else.
 *
 * @example
 * ```ts
 * // The authored form: prose for the summary, query fields flat on the nodes.
 * const parsed = parsePanelSpecInput({
 *   title: 'Interaction latency',
 *   summary: 'Most of the elapsed time was spent in one database statement.',
 *   layout: [
 *     { type: 'timeline', source: 'trace', filter: { traceId: '...' } },
 *     { type: 'metricCards', metrics: ['total_duration', 'database_duration'] },
 *     { type: 'table', title: 'Slowest operations', source: 'spans', sort: 'duration_desc' },
 *   ],
 * });
 *
 * if (parsed.ok) {
 *   const spec = normalizePanel(parsed.value, analysis, context);
 * }
 * ```
 */

import { z } from 'zod';

import { DebuggenError, err, ok, sourceLocationSchema } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { METRIC_IDS } from '@debuggen/telemetry';

import {
  isLayoutNodeType,
  LAYOUT_NODE_MAX_CHILDREN,
  LAYOUT_NODE_MIN_CHILDREN,
  splitDirectionSchema,
  type SplitDirection,
} from './nodes/layout.js';
import {
  dataQueryFilterSchema,
  dataQuerySchema,
  dataQuerySortSchema,
  dataQuerySourceSchema,
  panelNodeDescriptionSchema,
  panelNodeTitleSchema,
  type DataQueryFlatFieldKey,
} from './nodes/query.js';
import type { QueryBackedNodeType } from './nodes/viz.js';
import {
  PANEL_CHILDREN_FIELD,
  PANEL_LAYOUT_FIELD,
  PANEL_LAYOUT_MAX_NODES,
  PANEL_NODE_TYPES,
  PANEL_TITLE_MAX_LENGTH,
  PANEL_VIZ_NODE_TYPES,
} from './spec.js';
import {
  describeIssues,
  MAX_HEADLINE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MAX_SUMMARY_FACTS,
  MAX_SUMMARY_HYPOTHESES,
  type SchemaIssueSummary,
} from './summary.js';
import { PANEL_MAX_NODE_DEPTH, type PanelValidationIssueCode } from './validate.js';

/*
 * ---------------------------------------------------------------------------
 * Shared primitives
 * ---------------------------------------------------------------------------
 */

/**
 * Requires at least one non-whitespace character somewhere in a string.
 *
 * Declared privately here as `./spec.ts` and `./summary.ts` each declare it
 * privately: neither exports it, and a one-character pattern is not worth a new
 * export edge between three modules of the same package. What matters is that
 * the *rule* is the same rule — a title or a headline of nothing but spaces is
 * rejected at step 1, where it is repairable, rather than passed through
 * normalisation to be refused by the internal schema as a product bug.
 *
 * Expressible in JSON Schema as a `pattern`, which is why it is a regular
 * expression rather than a refinement.
 */
const NON_BLANK_PATTERN = /\S/;

/**
 * The two labels any authored node may carry, and the whole of what an authored
 * node has in common across all sixteen types.
 *
 * The primitives are `./nodes/query.ts`'s, imported: a title is the same field
 * with the same bound whether it is read from an authored node or a normalized
 * one, and its description already tells the author the one thing that matters
 * about it — that a title is a label and never a finding.
 *
 * `id` is conspicuously absent, and that absence is enforced rather than
 * documented: every node schema below is strict, so an authored id fails with
 * an `unrecognized_keys` issue at the node's own path.
 */
const authoredNodeLabelShape = {
  /** Optional heading shown above the node. */
  title: panelNodeTitleSchema.optional(),

  /** Optional sentence shown under the heading. */
  description: panelNodeDescriptionSchema.optional(),
};

/*
 * ---------------------------------------------------------------------------
 * The authored data query
 *
 * One definition of the five query fields, used twice: spread flat onto every
 * query-backed node, and wrapped into the optional nested `query` object those
 * same nodes accept. Declaring it once is what guarantees the two spellings a
 * normaliser has to reconcile are spellings of the *same* fields.
 * ---------------------------------------------------------------------------
 */

/**
 * The five query fields, each optional, as a reusable shape.
 *
 * Every field is the definition `./nodes/query.ts` owns, and that reuse is the
 * point rather than a convenience:
 *
 * - `source` and `sort` are the exported enumerations over the closed source
 *   and sort vocabularies. The ten source names are exactly the discriminants
 *   of the result union the panel-data route serves (AAP 0.4.2), so a second
 *   list of them here would break the service the moment either changed.
 * - `filter` is the internal filter schema itself, which already draws its
 *   `kinds` and `tier` vocabularies from `@debuggen/telemetry` — the package
 *   that owns them and forbids a second hard-coded copy — and which already
 *   keeps `traceId` a plain bounded string rather than a 32-character hex
 *   pattern. That last point is the subtlest requirement in this module, so it
 *   is recorded in full on {@link dataQueryInputSchema} below.
 * - `limit` and `offset` are taken from the internal query's own shape, so the
 *   ceiling an author is told about is the ceiling the resolver enforces, and
 *   `limit: 0` keeps meaning "no items, explicitly" on both sides of
 *   normalisation instead of being mistaken for an unset field.
 *
 * Every field is optional because the flat and the nested form fill each
 * other's gaps: a node may name its source flat and its filter nested, and
 * neither half is complete on its own. A node that ends up with no source at
 * all is the catalog's and `./validate.ts`'s business, not this schema's.
 *
 * The `satisfies` clause is a compile-time proof rather than a decoration, and
 * it fails in both directions against the authoritative flat-field list: a
 * field declared here and missing from `DATA_QUERY_FLAT_FIELD_KEYS` leaves the
 * record type unsatisfied, and a key in that tuple with no declaration here
 * leaves a required key unimplemented. The authoring schema and the normaliser
 * that lifts these fields therefore cannot disagree about which fields they
 * are. `metrics` is deliberately not among them — it is an option of the
 * metric-card node, not a query field, and normalisation must not relocate it.
 */
const authoredQueryFieldShape = {
  /**
   * Which prepared view of the capture this node reads.
   *
   * Optional in the authored form only: normalisation resolves it from the
   * nested query, the flat field or the node type's implicit source, in that
   * order, and the internal form requires it.
   */
  source: dataQuerySourceSchema
    .optional()
    .describe(
      'Which prepared view of the captured evidence this node reads, named by one of the closed source values. May also be written inside this node\'s "query" object instead. Omit it only on a node type whose source is implied.',
    ),

  /** How to narrow the source before anything is drawn. */
  filter: dataQueryFilterSchema
    .optional()
    .describe(
      'How to narrow the source before anything is drawn. Every field of a filter is optional and every field narrows; omit the filter entirely to read the whole source.',
    ),

  /** How to order an array-valued source. */
  sort: dataQuerySortSchema.optional(),

  /**
   * How many items to return from an array-valued source.
   *
   * The internal query's own field, so the whole-number requirement, the
   * ceiling and the meaning of an explicit `0` are one definition.
   */
  limit: dataQuerySchema.shape.limit,

  /** How many items to skip before the returned page. The internal field. */
  offset: dataQuerySchema.shape.offset,
} satisfies Record<DataQueryFlatFieldKey, z.ZodType>;

/**
 * The optional nested `query` object a node may carry instead of, or beside,
 * the flat fields.
 *
 * Strict, like every other object in this module: the five fields above are the
 * whole query vocabulary, and an invented sixth is rejected rather than
 * silently dropped by a resolver that never reads it.
 *
 * ## The trace-id placeholder, and why no format is checked here
 *
 * The filter's `traceId` is a bounded plain string, not a 32-character hex
 * pattern, and that is the considered choice rather than the lenient one. A
 * trace identifier names one correlated interaction *of a capture that has not
 * happened yet* when a panel is authored, so the authored value is routinely a
 * placeholder; the authoring example the panel-generation prompt carries has
 * one. Three layers then do exactly one job each:
 *
 * - here, the value is well-formed or not — a non-empty, bounded string;
 * - `./normalize.ts` passes it through **unchanged**, because its test asserts
 *   an exact normalised object and a normaliser that rewrote, padded or
 *   invented a trace id would fail that test — and would be inventing evidence;
 * - `./semantic.ts` resolves it against the capture and rejects one the capture
 *   does not hold, which is the only layer that can tell *present* from
 *   *well-formed*.
 *
 * A hex constraint in this position would move that rejection to the wrong
 * layer: it would burn one of two repair attempts on a value the author could
 * not have known, and it would convert a recoverable semantic failure — which
 * the generating stage answers with a deterministic fallback panel — into an
 * authoring failure. The internal `DataQuery` keeps the same plain-string
 * field for the same reason, so nothing tightens behind this module's back.
 */
export const dataQueryInputSchema = z
  .strictObject(authoredQueryFieldShape)
  .describe(
    'The data request for one node, written as an object. Its five fields may equally be written directly on the node; when both spellings appear on one node, this object wins for the fields it names and the fields written on the node fill the rest.',
  );

/**
 * A data request as it may be authored: the internal query with every field
 * optional, because the flat and nested spellings complete each other.
 *
 * Inferred from {@link dataQueryInputSchema}, so the validator and the type are
 * one statement. `./normalize.ts` consumes this together with a node's flat
 * fields and produces the internal `DataQuery`.
 */
export type DataQueryInput = z.infer<typeof dataQueryInputSchema>;

/**
 * The shape shared by the twelve query-backed nodes in their authored form:
 * the two labels, the five query fields flat, and the nested query object.
 *
 * Both spellings are declared, and both are declared *explicitly*. A
 * passthrough or a catch-all would accept the flat fields too, and would also
 * accept anything else an author cared to attach — including an id, a colour or
 * a height, none of which this package admits (AAP 0.6.2 keeps every visual
 * value in the renderer's design tokens). Explicit fields plus strictness is
 * what makes "accepts both query forms" and "rejects invented dimensions" the
 * same statement.
 */
const authoredQueryBackedNodeShape = {
  ...authoredNodeLabelShape,
  ...authoredQueryFieldShape,

  /**
   * The same five query fields written as one object.
   *
   * Optional, and never required: a node that writes them flat is complete
   * without it. When both are present the precedence is the one documented on
   * {@link dataQueryInputSchema} and implemented in `./normalize.ts`.
   */
  query: dataQueryInputSchema
    .optional()
    .describe(
      "This node's data request as an object. Equivalent to writing the same fields directly on the node; use either spelling, not both.",
    ),
};

/*
 * ---------------------------------------------------------------------------
 * The twelve query-backed leaves
 *
 * One strict object each, all of them the shared shape above plus their own
 * `type` literal — and, for exactly one of them, one extra option. The literal
 * is what the discriminated union at the bottom of this module keys on, which
 * is what makes a malformed node fail against one schema with one clear issue
 * path instead of against sixteen at once (AAP 0.8.3 requires that an unknown
 * node type fails).
 *
 * The descriptions here say what a node draws in one line. The longer guidance
 * an author needs in order to *choose* between them is the node catalog's, and
 * the panel-generation prompt carries both.
 * ---------------------------------------------------------------------------
 */

/**
 * Builds the authored form of one query-backed node: the shared shape plus a
 * `type` literal.
 *
 * Generic in the node type so the literal survives into the returned schema's
 * internals — a discriminated union cannot be built from options whose
 * discriminator it can no longer see, and would have to fall back to a plain
 * union whose failures report every branch's issues instead of the one that
 * matched. Constrained to `QueryBackedNodeType` so a type name outside that
 * vocabulary cannot be given a query-backed shape, and the return type is
 * deliberately inferred for the same reason the literal is generic.
 *
 * @typeParam TType The node type this schema's `type` field pins.
 * @param type The node type literal.
 * @param description Model-facing description of what this node draws.
 * @returns A strict object schema for one authored node of that type.
 */
function queryBackedNodeInput<TType extends QueryBackedNodeType>(type: TType, description: string) {
  return z
    .strictObject({
      type: z.literal(type),
      ...authoredQueryBackedNodeShape,
    })
    .describe(description);
}

/** One interaction on a shared time axis, in lanes by tier. */
const timelineNodeInputSchema = queryBackedNodeInput(
  'timeline',
  'A correlated timeline of one interaction: every span on a shared time axis, in lanes by the tier that produced it, so the time each tier held and the gaps between them are visible. Narrow it to a single interaction, since a capture holds many.',
);

/** Calls as offset bars with their nested work. */
const waterfallNodeInputSchema = queryBackedNodeInput(
  'waterfall',
  'A waterfall of the calls in one interaction, each a bar positioned by its offset from the first: work that ran one after another when it could have run together reads as a staircase. Narrow it to a single interaction.',
);

/** Captured records in chronological order. */
const eventLogNodeInputSchema = queryBackedNodeInput(
  'eventLog',
  'A chronological log of captured records, unaggregated and filterable. Narrow it by kind to keep it readable.',
);

/** Nested timing drawn as a hierarchy. */
const flameNodeInputSchema = queryBackedNodeInput(
  'flame',
  'Nested timing drawn as a hierarchy, which distinguishes a call that was slow itself from one that was merely waiting on the work inside it. Narrow it to a single interaction.',
);

/** A sortable ranking of spans. */
const tableNodeInputSchema = queryBackedNodeInput(
  'table',
  'A sortable table of spans showing what each one was, which tier produced it and how long it took. Suits a ranking; order it and bound the rows to the few that matter.',
);

/** Per-component render statistics. */
const renderTableNodeInputSchema = queryBackedNodeInput(
  'renderTable',
  'Render statistics per component: how often each rendered, how long that took, what triggered those renders and which of its inputs changed.',
);

/** The component tree with per-node render counts. */
const componentTreeNodeInputSchema = queryBackedNodeInput(
  'componentTree',
  'The component hierarchy captured at the end of the interaction, with the render count of each node, so a count can be read against where the component sits.',
);

/** Network requests grouped, with duplicates counted. */
const requestTableNodeInputSchema = queryBackedNodeInput(
  'requestTable',
  'Network requests grouped so that identical ones collapse into one row with a count, each expandable to its occurrences and their initiators.',
);

/** Database statements grouped, with execution counts. */
const queryTableNodeInputSchema = queryBackedNodeInput(
  'queryTable',
  'Database statements grouped by their parameterized text, with execution counts, durations and the call site of each. Statements are shown parameterized; no row contents are captured.',
);

/** Hook state transitions. */
const stateTransitionsNodeInputSchema = queryBackedNodeInput(
  'stateTransitions',
  'State transitions in order: a summary of the previous value, what triggered the change, and a summary of the next one. Values are summarised rather than captured in full.',
);

/** The correlated flow as a graph. */
const dependencyGraphNodeInputSchema = queryBackedNodeInput(
  'dependencyGraph',
  'The correlated flow as a graph, from the interaction through the functions and calls it reached to the datastore and external services at the end of it.',
);

/**
 * The capture's computed values as a row of tiles.
 *
 * Declared apart from the eleven above because it carries one extra field, and
 * that field is **not** a query field: the renderer reads the id list from the
 * node itself, and normalisation deliberately leaves `metrics` where it was
 * written while giving the node the implicit metrics source as its query (AAP
 * 0.2.3). The authoritative flat-field list omits `metrics` for exactly this
 * reason, so a `metrics` relocated into `query` would leave the node rendering
 * nothing while still parsing.
 *
 * **`metrics` is required**, and the choice is forced rather than stylistic.
 * The internal node requires at least one id, and normalisation never invents
 * one — it has no basis on which to choose. Were omission accepted here, a node
 * without metrics would pass step 1, normalise into a document the internal
 * schema refuses, and surface as a step-3 product bug with a fallback panel
 * instead of a repair prompt. Requiring it keeps the failure where the author
 * can fix it, at a named path, with the whole vocabulary listed in the emitted
 * schema.
 */
const metricCardsNodeInputSchema = z
  .strictObject({
    type: z.literal('metricCards'),
    ...authoredQueryBackedNodeShape,

    /**
     * Which computed values to show, in display order.
     *
     * The vocabulary and both bounds derive from the fixed metric-id tuple
     * `@debuggen/telemetry` owns — imported, never restated: at least one id,
     * because a tile row with no tiles is a mistake rather than an intent, and
     * at most as many as exist, because a longer list can only repeat itself.
     * An enumeration rather than a bare string so the emitted schema lists the
     * ids for the author, who would otherwise have to guess them.
     */
    metrics: z
      .array(z.enum(METRIC_IDS))
      .min(1)
      .max(METRIC_IDS.length)
      .describe(
        `Which computed values of the capture to show as tiles, in display order. At least one and at most ${String(METRIC_IDS.length)} ids, each drawn from the fixed metric vocabulary. Choose the few that bear on the question: a value unavailable for this capture is shown as such, so an irrelevant id costs a tile that says nothing.`,
      ),
  })
  .describe(
    'A row of tiles showing computed values of the capture — durations, counts and sizes. Its source is implied, so no source need be written; the ids to show are the node\'s own "metrics" option rather than part of its query.',
  );

/*
 * ---------------------------------------------------------------------------
 * The source-link leaf
 * ---------------------------------------------------------------------------
 */

/**
 * A pointer into the project's own source, rendered as a clickable chip.
 *
 * The one visualization node that reads no captured data, and the one place in
 * this module where strictness is the entire feature rather than a safeguard:
 * because the object declares no query field, an authored `source`, `filter`,
 * `sort`, `limit`, `offset`, `metrics` or `query` is rejected outright, so a
 * specification cannot half-describe this node as a data view and leave a
 * resolver to guess which half it meant.
 *
 * The location is `@debuggen/shared`'s single definition, delegated to
 * wholesale: it already requires a project-relative POSIX path that cannot
 * escape the project, 1-based line and column, one of the closed set of
 * resolution routes and a confidence between zero and one. Re-validating any of
 * that here would be a second opinion on a contract this package does not own —
 * and the same schema is parsed at every hop of the click path from this chip
 * to the editor, so one definition is what makes the path trustworthy end to
 * end.
 */
const sourceLinkNodeInputSchema = z
  .strictObject({
    type: z.literal('sourceLink'),
    ...authoredNodeLabelShape,

    /** Where in the project this chip points. */
    location: sourceLocationSchema.describe(
      'Where in the project this chip points: a project-relative path with a 1-based line and column, optionally the symbol at that position, plus which resolution route produced it and how much confidence that route has. Use only a location the capture or the code index actually resolved — never a guessed path, line or column.',
    ),
  })
  .describe(
    'A standalone link into the project source, rendered as a chip that opens the file at that line in the editor. Suits pointing at the code a finding implicates. It carries a resolved location and no query; the tables, timelines and graphs already embed the same chip on any row that resolved to a location.',
  );

/*
 * ---------------------------------------------------------------------------
 * The authored leaf types
 *
 * Inferred from the schemas above, so each type and its validator are one
 * statement. `./normalize.ts` switches over these exhaustively.
 * ---------------------------------------------------------------------------
 */

/** One interaction as cross-tier lanes on a shared time axis, as authored. */
export type TimelineNodeInput = z.infer<typeof timelineNodeInputSchema>;

/** Calls as offset bars with their nested work, as authored. */
export type WaterfallNodeInput = z.infer<typeof waterfallNodeInputSchema>;

/** Captured records in chronological order, as authored. */
export type EventLogNodeInput = z.infer<typeof eventLogNodeInputSchema>;

/** Computed values of the capture shown as tiles, as authored. */
export type MetricCardsNodeInput = z.infer<typeof metricCardsNodeInputSchema>;

/** Nested timing drawn as a hierarchy, as authored. */
export type FlameNodeInput = z.infer<typeof flameNodeInputSchema>;

/** A sortable table of spans, as authored. */
export type TableNodeInput = z.infer<typeof tableNodeInputSchema>;

/** Render statistics per component, as authored. */
export type RenderTableNodeInput = z.infer<typeof renderTableNodeInputSchema>;

/** The component tree with render counts, as authored. */
export type ComponentTreeNodeInput = z.infer<typeof componentTreeNodeInputSchema>;

/** Grouped network requests, as authored. */
export type RequestTableNodeInput = z.infer<typeof requestTableNodeInputSchema>;

/** Grouped database statements, as authored. */
export type QueryTableNodeInput = z.infer<typeof queryTableNodeInputSchema>;

/** State transitions in order, as authored. */
export type StateTransitionsNodeInput = z.infer<typeof stateTransitionsNodeInputSchema>;

/** The correlated flow as a graph, as authored. */
export type DependencyGraphNodeInput = z.infer<typeof dependencyGraphNodeInputSchema>;

/** A standalone pointer into the project source, as authored. */
export type SourceLinkNodeInput = z.infer<typeof sourceLinkNodeInputSchema>;

/**
 * Any authored node whose content is a prepared view of the capture.
 *
 * The twelve that accept a query, in either spelling. The source-link leaf is
 * deliberately not one of them: it is the union to accept wherever the
 * operation is "resolve this node's data".
 */
export type QueryBackedNodeInput =
  | TimelineNodeInput
  | WaterfallNodeInput
  | EventLogNodeInput
  | MetricCardsNodeInput
  | FlameNodeInput
  | TableNodeInput
  | RenderTableNodeInput
  | ComponentTreeNodeInput
  | RequestTableNodeInput
  | QueryTableNodeInput
  | StateTransitionsNodeInput
  | DependencyGraphNodeInput;

/**
 * Any authored node that draws something: the twelve query-backed ones plus the
 * source-link leaf.
 *
 * Discriminated by `type`, so narrowing it is a `switch` the compiler can check
 * exhaustively — which is how `./normalize.ts` stays complete as the vocabulary
 * grows.
 */
export type VisualizationNodeInput = QueryBackedNodeInput | SourceLinkNodeInput;

/*
 * ---------------------------------------------------------------------------
 * The three containers
 *
 * The authored form of a container is the internal one minus the derived id:
 * the same three types, the same child-count bounds, the same optional axis on
 * the split, and the same nesting-depth bound. The bounds are imported rather
 * than restated, so a layout that passes this schema is a layout the internal
 * schema and the syntactic validator accept — which is what keeps a container
 * failure at step 1, where it is repairable, instead of at step 3, where it
 * would be a product bug.
 *
 * The internal schema factories in `./nodes/layout.ts` cannot be reused here:
 * they require the `id` that only the normaliser can supply. The types below
 * are therefore declared explicitly, as interfaces, for the reason that module
 * records — a recursive type routed through a second type alias is rejected
 * outright (TS2456), while a reference to an interface is deferred and may be
 * circular. The *types* are recursive and admit any depth; the *schemas* that
 * follow them are not recursive at all, and admit exactly
 * {@link PANEL_MAX_NODE_DEPTH} levels (see "The node union, level by level").
 * ---------------------------------------------------------------------------
 */

/**
 * The fields every authored node carries regardless of what it draws or
 * arranges: two optional labels, and nothing else.
 *
 * No `id`, which is the whole difference between this and the internal node
 * base. Every field is `readonly`: an authored specification is a document that
 * normalisation reads and replaces, never edits in place.
 */
export interface PanelNodeInputBase {
  /** Optional heading for this node. A label the developer reads, never a finding. */
  readonly title?: string | undefined;

  /** Optional sentence under the heading, saying what the node below shows. */
  readonly description?: string | undefined;
}

/** A titled group of authored nodes. */
export interface SectionNodeInput extends PanelNodeInputBase {
  /** Discriminator. */
  readonly type: 'section';

  /** The nodes this section groups, in reading order. */
  readonly children: readonly PanelNodeInput[];
}

/** A division of the space into two or more panes of authored nodes. */
export interface SplitNodeInput extends PanelNodeInputBase {
  /** Discriminator. */
  readonly type: 'split';

  /** Which axis to divide along. Absent means the default the renderer applies. */
  readonly direction?: SplitDirection | undefined;

  /** The panes, in order along the axis. */
  readonly children: readonly PanelNodeInput[];
}

/** A vertical sequence of authored nodes. */
export interface StackNodeInput extends PanelNodeInputBase {
  /** Discriminator. */
  readonly type: 'stack';

  /** The nodes of the sequence, in reading order. */
  readonly children: readonly PanelNodeInput[];
}

/**
 * Any authored container.
 *
 * For a consumer that has already narrowed a node to a container and wants to
 * read `children` without a further switch. **Not usable for closing the
 * recursion** — see {@link PanelNodeInput}.
 */
export type LayoutNodeInput = SectionNodeInput | SplitNodeInput | StackNodeInput;

/**
 * Any node an authored panel may contain: a leaf that draws something, or a
 * container that arranges other nodes.
 *
 * The recursive type, closed here and nowhere else in the authored form. The
 * three containers are named one by one rather than through
 * {@link LayoutNodeInput}, because only a reference to an *interface* is
 * deferred by the compiler; routing the recursion through the alias is rejected
 * as a circular type reference.
 *
 * The type admits a tree of any depth, because a type cannot count; the schema
 * that produces values of it does, and admits {@link PANEL_MAX_NODE_DEPTH}
 * levels. A value built by hand rather than parsed can therefore be deeper than
 * any parsed one, which is why `./normalize.ts` walks one without recursion.
 */
export type PanelNodeInput =
  VisualizationNodeInput | SectionNodeInput | SplitNodeInput | StackNodeInput;

/**
 * Builds the authored form of the three containers for one nesting level, with
 * `child` as the schema every child position of that level is parsed by.
 *
 * A factory rather than three constants because the authoring schema is an
 * unrolled chain (see "The node union, level by level" below): each level has
 * its own three container schemas, identical to those of every other level
 * except in the schema their `children` array holds. Everything an author reads
 * — the strictness, the labels, the split axis, the child-count bounds and
 * every description — is therefore stated once, here, for all levels.
 *
 * The return type is deliberately inferred: the `type` literal of each schema
 * has to survive into it, or the discriminated union a level is built from
 * could no longer see its options' discriminators.
 *
 * @param child The schema of a node one level below the containers built here.
 * @returns The section, split and stack schemas of this level, in the
 * container vocabulary's order.
 */
function containerNodeInputSchemasFor(child: z.ZodType<PanelNodeInput>) {
  /** A titled group of nodes, as authored. */
  const section = z
    .strictObject({
      type: z.literal('section'),
      ...authoredNodeLabelShape,
      children: z
        .array(child)
        .min(LAYOUT_NODE_MIN_CHILDREN.section)
        .max(LAYOUT_NODE_MAX_CHILDREN)
        .describe(
          `The nodes this section groups, in reading order. At least ${String(LAYOUT_NODE_MIN_CHILDREN.section)} and at most ${String(LAYOUT_NODE_MAX_CHILDREN)}; a heading over no nodes shows the developer an empty region they cannot interpret.`,
        ),
    })
    .describe(
      'A titled group of nodes. Use it to give one part of a panel a heading and a boundary, so each question the panel answers is visibly its own section. It arranges nodes only and reads no data itself.',
    );

  /** Two or more panes along one axis, as authored. */
  const split = z
    .strictObject({
      type: z.literal('split'),
      ...authoredNodeLabelShape,
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
      'Two or more nodes placed along one axis. Use it when the views are read against each other — a claim beside the evidence for it — rather than one after another.',
    );

  /** A vertical sequence of nodes, as authored. */
  const stack = z
    .strictObject({
      type: z.literal('stack'),
      ...authoredNodeLabelShape,
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

  return [section, split, stack] as const;
}

/*
 * ---------------------------------------------------------------------------
 * The node union, level by level
 *
 * **Unrolled, not recursive.** A container holds nodes, and the natural way to
 * say so is a union whose containers refer back to the union itself through
 * `z.lazy`. That schema admits nesting of *any* depth, and the schema library
 * descends one call frame per level while parsing it, so an authored document
 * nested a few thousand containers deep exhausts the call stack inside
 * `safeParse` and throws — on the very path whose contract is to return a
 * rejection. Nor is `parsePanelSpecInput` the only caller that would need
 * protecting: the model provider's repair loop parses a reply with this schema
 * directly and quotes each issue's message back to the model.
 *
 * So the bound is made a property of the schema itself. The chain below has
 * exactly {@link PANEL_MAX_NODE_DEPTH} levels, counting a top-level node as
 * level 1 — the counting `./validate.ts` uses — and each level is its own
 * discriminated union:
 *
 * - levels 1 to `PANEL_MAX_NODE_DEPTH - 1` accept all sixteen node types, and
 *   their containers parse their children with the union of the level below;
 * - level `PANEL_MAX_NODE_DEPTH`, the deepest, accepts the thirteen
 *   visualization nodes only, so a container placed there is rejected with one
 *   issue on its own `type` path and nothing below it is ever parsed.
 *
 * The consequences, each of them the point rather than a side effect:
 *
 * - **Parsing is bounded** by the chain's length whatever the input: a document
 *   nested a hundred thousand deep costs `PANEL_MAX_NODE_DEPTH` levels of
 *   parsing and one issue. A cyclic object graph terminates the same way.
 * - **The schema admits exactly the depth `validatePanelSpec` admits**, because
 *   both read the one constant. A document that passes here cannot be rejected
 *   at step 3 for its depth — which would be a product bug and a fallback panel
 *   rather than a repair prompt.
 * - **The emitted JSON Schema is finite and acyclic**: each level renders as
 *   one definition referenced by the three containers of the level above, and
 *   the chain ends in a union that names no container type. The model is shown
 *   the bound as structure rather than as prose it may ignore.
 *
 * Everything else about a node — strictness, labels, query fields, bounds — is
 * shared by every level, because the leaves are the same schema instances at
 * every level and the containers come from one factory.
 * ---------------------------------------------------------------------------
 */

/**
 * A schema that parses an object whose `type` is the given literal, described
 * structurally.
 *
 * The same device `./nodes/viz.ts` uses to prove its schema tuple complete, and
 * structural for the same reason: a schema is effectively invariant in what it
 * parses, so a `z.ZodType<{ type: T }>`-typed target would reject a concrete
 * node schema for having *more* fields than the target names. Matching on the
 * internals' parsed-output type instead is covariant, which is what lets a full
 * node schema satisfy "parses something whose `type` is this literal" while
 * still failing when the literal is wrong.
 */
type SchemaParsingNodeType<TType extends string> = {
  readonly _zod: { readonly output: { readonly type: TType } };
};

/**
 * Compile-time proof that a schema tuple lists exactly one schema per member of
 * a node-type vocabulary, in the same order.
 *
 * A homomorphic mapped type over that vocabulary, so it *is* a tuple of the
 * same length, and each position demands a schema parsing the literal at that
 * position. Written as a generic over `TTypes` rather than directly over the
 * frozen vocabulary because only the generic form maps element positions alone.
 *
 * Applied twice below: to the thirteen leaves against the visualization
 * vocabulary, and to the sixteen top-level schemas against the whole node
 * vocabulary. What it catches, at compile time: a node type with no authored
 * schema, a schema listed twice, a tuple drifting out of the vocabulary's
 * order, and a node type added to `./nodes/layout.ts` or `./nodes/viz.ts`
 * without an authored counterpart beside it. There is no second list of
 * node-type strings in this module for either to drift from — the vocabularies
 * are imported, and this proof is what binds the schemas to them.
 */
type NodeInputSchemaTupleFor<TTypes extends readonly string[]> = {
  readonly [K in keyof TTypes]: SchemaParsingNodeType<TTypes[K]>;
};

/**
 * The thirteen authored leaf schemas, in the visualization vocabulary's order.
 *
 * One tuple of shared instances, spread into every level of the chain: a leaf
 * is the same schema object whether it sits at the top of a layout or at the
 * deepest level, so a leaf parses — and fails — identically at every depth, and
 * the emitted JSON Schema renders each leaf once as a definition every level
 * refers to.
 *
 * Frozen, like every other vocabulary in this package: shared, read-only, built
 * once at module load with no side effect.
 */
const LEAF_NODE_INPUT_SCHEMAS = Object.freeze([
  timelineNodeInputSchema,
  waterfallNodeInputSchema,
  eventLogNodeInputSchema,
  metricCardsNodeInputSchema,
  flameNodeInputSchema,
  tableNodeInputSchema,
  renderTableNodeInputSchema,
  componentTreeNodeInputSchema,
  requestTableNodeInputSchema,
  queryTableNodeInputSchema,
  stateTransitionsNodeInputSchema,
  dependencyGraphNodeInputSchema,
  sourceLinkNodeInputSchema,
] as const) satisfies NodeInputSchemaTupleFor<typeof PANEL_VIZ_NODE_TYPES>;

/**
 * The fewest levels the chain can be built with: **2**.
 *
 * A container needs at least one child (`LAYOUT_NODE_MIN_CHILDREN`), so a
 * container is only usable at a level that has a level below it. With a single
 * level there would be nowhere to put a container's children, and the top-level
 * tuple could not hold the three containers its completeness proof requires.
 */
const MIN_NODE_DEPTH_LEVELS = 2;

/**
 * The schema-level message of the deepest level's union, for a node there whose
 * `type` names no visualization node — in practice a container placed one level
 * too deep.
 *
 * Static, and built from the depth constant alone: like every message this
 * module produces, it carries no input value (AAP 0.5.2). It is what the model
 * provider's repair loop quotes back to the model for this failure, so it says
 * both what the position accepts and why.
 */
const DEEPEST_LEVEL_NODE_MESSAGE = `Only a visualization node is accepted here: this position is at the deepest nesting level a panel allows (${String(PANEL_MAX_NODE_DEPTH)}), so no section, split or stack may be placed at it.`;

/**
 * The union parsing a node at the deepest level, {@link PANEL_MAX_NODE_DEPTH}:
 * the thirteen leaves, and no container.
 *
 * The end of the chain, and the reason the chain is finite: no option here has
 * a child position, so nothing below this level is ever parsed.
 *
 * The custom message is attached through an error *function* scoped to the
 * union's own no-matching-discriminator issue (`invalid_union`). The union
 * raises one other issue of its own — `invalid_type`, for a value that is not an
 * object at all — and that keeps the library's message, because "no container
 * here" would misdescribe it. Issues raised inside a matched leaf belong to that
 * leaf's field schemas, so a leaf at this level with a malformed field reports
 * exactly what it would report at level 1.
 */
const deepestNodeInputSchema: z.ZodType<PanelNodeInput> = z
  .discriminatedUnion('type', [...LEAF_NODE_INPUT_SCHEMAS], {
    error: (issue) => (issue.code === 'invalid_union' ? DEEPEST_LEVEL_NODE_MESSAGE : undefined),
  })
  .describe(
    `A node at the deepest nesting level a panel allows (${String(PANEL_MAX_NODE_DEPTH)}, counting a node written directly in the layout as level 1). Only visualization nodes are accepted at this level; a section, split or stack placed here has nowhere to put its children.`,
  );

/**
 * Builds the chain from the deepest level up to level 2, and returns level 2:
 * the schema every child position of a top-level container is parsed by.
 *
 * Each iteration wraps the level below in a new discriminated union of the three
 * containers — built by {@link containerNodeInputSchemasFor} around that lower
 * level — plus the shared leaves. The loop variable stays typed as
 * `z.ZodType<PanelNodeInput>`, the same annotation {@link panelNodeInputSchema}
 * carries, so the inferred type does not grow with the number of levels and
 * every level is interchangeable to the compiler.
 *
 * Runs once, at module load, and builds schemas and nothing else.
 *
 * @returns The union for level 2.
 * @throws DebuggenError `INTERNAL` if {@link PANEL_MAX_NODE_DEPTH} is not an
 * integer of at least {@link MIN_NODE_DEPTH_LEVELS} — a product defect in that
 * constant, reported at load rather than as a schema that silently admits a
 * different depth than the validator.
 */
function buildSecondLevelNodeInputSchema(): z.ZodType<PanelNodeInput> {
  if (!Number.isInteger(PANEL_MAX_NODE_DEPTH) || PANEL_MAX_NODE_DEPTH < MIN_NODE_DEPTH_LEVELS) {
    throw new DebuggenError(
      'INTERNAL',
      `The authored panel schema needs a nesting depth of at least ${String(MIN_NODE_DEPTH_LEVELS)} levels, and PANEL_MAX_NODE_DEPTH does not provide one.`,
      {
        hint: 'Set PANEL_MAX_NODE_DEPTH in the panel validator to a whole number of at least 2: containers need a level below them for their children.',
      },
    );
  }

  let level: z.ZodType<PanelNodeInput> = deepestNodeInputSchema;

  for (let depth = PANEL_MAX_NODE_DEPTH - 1; depth >= MIN_NODE_DEPTH_LEVELS; depth -= 1) {
    level = z.discriminatedUnion('type', [
      ...containerNodeInputSchemasFor(level),
      ...LEAF_NODE_INPUT_SCHEMAS,
    ]);
  }

  return level;
}

/**
 * Every top-level authored node schema, in the panel node vocabulary's order —
 * the three level-1 containers first, then the thirteen leaves.
 *
 * The `satisfies` clause is the completeness proof for the whole vocabulary:
 * the top level is where every node type is accepted, so it is where a type
 * without an authored schema would first go missing. Frozen, like the leaf
 * tuple.
 */
const PANEL_NODE_INPUT_SCHEMAS = Object.freeze([
  ...containerNodeInputSchemasFor(buildSecondLevelNodeInputSchema()),
  ...LEAF_NODE_INPUT_SCHEMAS,
] as const) satisfies NodeInputSchemaTupleFor<typeof PANEL_NODE_TYPES>;

/**
 * The validator for one **top-level** node of an authored panel — level 1 of
 * the chain, whose containers admit {@link PANEL_MAX_NODE_DEPTH} levels in all,
 * the node itself included.
 *
 * `layout` parses each of its entries with this schema, and a caller validating
 * a lone node gets the same bound: counting the node itself as level 1, a
 * container is accepted at levels 1 to `PANEL_MAX_NODE_DEPTH - 1`, a leaf at
 * every level to `PANEL_MAX_NODE_DEPTH`, and a container at the deepest level
 * is rejected at its own `type` path.
 *
 * A discriminated union over `type` rather than a plain union, and that is the
 * difference between a usable rejection and an unreadable one: an unrecognised
 * node type fails with a single issue on the node's own `type` path, and a
 * *recognised* type with a malformed body fails against that type's schema
 * alone instead of reporting sixteen branches' worth of issues at once. Both
 * matter more here than anywhere else in the package, because this failure is
 * what a repair prompt is built from.
 *
 * Every option is strict, so an unrecognised key on a node — an authored id, an
 * invented filter dimension, a visual property this package does not admit — is
 * rejected rather than dropped. The flat query fields are what make that
 * affordable: they are declared, so accepting the flat spelling costs no
 * looseness anywhere else.
 *
 * The annotation is what keeps the emitted declarations honest. Left to
 * inference, this binding — and through it `PanelSpecInput['layout']` — would
 * be typed as the structural output of sixteen strict-object schemas written
 * out in the package's declaration output, a second statement of the node
 * shape beside the declared one that the two could drift apart in; annotated
 * with the explicitly declared {@link PanelNodeInput}, the declaration is that
 * one genuinely recursive type. The cost is that this binding is a `z.ZodType`
 * rather than a `z.ZodDiscriminatedUnion`, which no consumer of the authored
 * form needs.
 */
export const panelNodeInputSchema: z.ZodType<PanelNodeInput> = z.discriminatedUnion('type', [
  ...PANEL_NODE_INPUT_SCHEMAS,
]);

/*
 * ---------------------------------------------------------------------------
 * The authored summary
 *
 * The one part of an authored panel that is prose and only prose. What a panel
 * *observes* is not authored at all: `./normalize.ts` copies the observed facts
 * and the likely causes from the validated analysis, and from nowhere else, so
 * that every statement a developer reads under "observed" cites captured
 * evidence by construction (AAP 0.2.3).
 * ---------------------------------------------------------------------------
 */

/**
 * One statement an author may write in the object form of the summary.
 *
 * Deliberately **inert**, and deliberately *not* this package's `Fact` or
 * `Hypothesis`: those shapes require evidence references that semantic
 * validation resolves against the capture, and reusing them here would imply
 * that an authored fact could be trusted. There is no field on this object for
 * an evidence reference, a confidence or a source location, because there is no
 * path by which an authored one could become part of a panel's findings.
 *
 * **Unrecognised keys are stripped rather than rejected**, which is the one
 * place in this module that is not strict, and the choice is what makes the
 * guarantee mechanical rather than documentary. An author that attaches an
 * `evidence` array or a `confidence` to a statement has written something this
 * layer drops at parse time: the parsed value provably cannot carry it, so no
 * later step has to remember to discard it. Rejecting instead would spend a
 * repair attempt — and there are only two — on content that was never going to
 * be read, and the outcome of exhausting them is a deterministic fallback
 * panel, which answers the developer's question materially worse than the panel
 * the author almost wrote.
 *
 * Both bounds are the internal summary's own statement bound, imported: a
 * statement that fits here fits the field it may be quoted into.
 */
export const authoredSummaryStatementSchema = z
  .object({
    /** The statement itself, as prose. */
    statement: z
      .string()
      .min(1)
      .max(MAX_STATEMENT_LENGTH)
      .regex(NON_BLANK_PATTERN, { error: 'statement must contain a non-whitespace character.' })
      .describe(
        'One statement, as prose. Presentation only: the observed facts and likely causes a panel shows come from the validated analysis of the capture, never from this object.',
      ),

    /** An optional second sentence enlarging on the statement. */
    detail: z
      .string()
      .min(1)
      .max(MAX_STATEMENT_LENGTH)
      .regex(NON_BLANK_PATTERN, { error: 'detail must contain a non-whitespace character.' })
      .optional()
      .describe('Optional further prose about the statement above.'),
  })
  .describe(
    "A statement written as prose. It carries no evidence reference, no confidence and no source location, because a panel's findings are taken from the validated analysis rather than from the author.",
  );

/** One prose statement of an authored summary. */
export type AuthoredSummaryStatement = z.infer<typeof authoredSummaryStatementSchema>;

/**
 * The object form of `summary`: prose, in up to three registers.
 *
 * It exists because an author may reasonably write a summary as an object
 * rather than a sentence, and a schema that refused the shape outright would
 * spend a repair attempt on a difference of spelling. What it does **not** do
 * is give that object any authority: normalisation takes at most prose from it
 * for the summary's headline and discards the rest, and the arrays below cannot
 * carry evidence in the first place (see
 * {@link authoredSummaryStatementSchema}). A string can never become a fact,
 * and neither can an authored object that resembles one.
 *
 * Stripping rather than strict, for the reason recorded on the statement shape.
 * Every bound is the internal summary's own bound, imported.
 */
export const authoredSummaryProseSchema = z
  .object({
    /** A single sentence naming what the panel is about. */
    headline: z
      .string()
      .min(1)
      .max(MAX_HEADLINE_LENGTH)
      .regex(NON_BLANK_PATTERN, { error: 'headline must contain a non-whitespace character.' })
      .optional()
      .describe(
        'One sentence naming what this panel is about. This is the field a summary written as an object is read for.',
      ),

    /** Prose statements about what the capture appears to show. */
    observed: z
      .array(authoredSummaryStatementSchema)
      .max(MAX_SUMMARY_FACTS)
      .optional()
      .describe(
        "Prose statements about the capture. Not the panel's observed facts: those are taken from the validated analysis, which is the only source that can cite captured evidence. Entries here are read as prose or not at all.",
      ),

    /** Prose statements about what might explain the capture. */
    likelyCauses: z
      .array(authoredSummaryStatementSchema)
      .max(MAX_SUMMARY_HYPOTHESES)
      .optional()
      .describe(
        "Prose statements about what might explain the capture. Not the panel's likely causes: those are taken from the validated analysis with their confidence and evidence. Entries here are read as prose or not at all.",
      ),
  })
  .describe(
    "A summary written as an object. Only its prose is used, for the one line at the top of the panel; the panel's findings and their evidence come from the validated analysis. Writing a single sentence instead is equivalent and simpler.",
  );

/** The object form of an authored summary: prose only. */
export type AuthoredSummaryProse = z.infer<typeof authoredSummaryProseSchema>;

/**
 * What `summary` accepts: a sentence, or an object of prose.
 *
 * The string form is the ordinary one and the form the panel-generation prompt
 * demonstrates. Both forms reach the same place — the summary's
 * non-evidentiary headline — which is why the union is a convenience for the
 * author rather than a choice with consequences.
 *
 * The string is bounded by the internal headline bound, imported, so a sentence
 * that passes here fits the field normalisation puts it in: an over-long
 * summary is a repairable failure at a named path rather than a sentence
 * silently truncated mid-word.
 */
const panelSummaryInputSchema = z
  .union([
    z
      .string()
      .min(1)
      .max(MAX_HEADLINE_LENGTH)
      .regex(NON_BLANK_PATTERN, { error: 'summary must contain a non-whitespace character.' })
      .describe('The panel summary as one sentence. The ordinary form.'),
    authoredSummaryProseSchema,
  ])
  .describe(
    'The summary of this panel, as one sentence or as an object of prose. It is presentation: the observed facts and the likely causes a panel shows are taken from the validated analysis of the capture, each with the evidence that supports it, and nothing written here becomes one of them.',
  );

/** An authored summary: a sentence, or an object of prose. */
export type PanelSummaryInput = z.infer<typeof panelSummaryInputSchema>;

/*
 * ---------------------------------------------------------------------------
 * The document
 * ---------------------------------------------------------------------------
 */

/**
 * The whole authored panel, and the schema a model's structured output is
 * validated against before anything deterministic touches it.
 *
 * Three fields, and strict: an unrecognised key at this level is either a field
 * this package removed — in which case the panel was written against a contract
 * that no longer holds — or one the author invented, which nothing downstream
 * would read while the document went on claiming to carry it. The fields the
 * internal specification adds are all *derived* (`version`, `id`, `sessionId`,
 * `panelVersion`, `supersedes`, `meta`) and come from the normalisation
 * context, so an authored one is rejected here rather than silently overwritten
 * there.
 *
 * What a document that passes this schema has proved is that it is *well
 * formed*: its node types exist, its sources and sorts are in the closed
 * vocabularies, its metric ids exist, its bounds hold. What it has not proved
 * is that the views it asks for can read the sources it names — the node
 * catalog's statement, applied by `./validate.ts` after normalisation — or that
 * the evidence it points at exists in the capture, which `./semantic.ts` is the
 * only layer able to tell.
 */
export const panelSpecInputSchema = z
  .strictObject({
    /** The one line at the top of the panel. */
    title: z
      .string()
      .min(1)
      .max(PANEL_TITLE_MAX_LENGTH)
      .regex(NON_BLANK_PATTERN, { error: 'title must contain a non-whitespace character.' })
      .describe(
        'The one line at the top of the panel, naming what it is about. A label, not a finding, and not a restatement of the question.',
      ),

    /** The summary: prose, and only prose. */
    summary: panelSummaryInputSchema,

    /**
     * The panel content, as a forest of nodes in reading order.
     *
     * **An empty layout is accepted**, and deliberately: a capture with nothing
     * to draw is a legitimate answer, the internal specification accepts an
     * empty layout for the same reason, and rejecting one here would spend a
     * repair attempt asking an author to invent views over evidence that does
     * not exist. The ceiling is the internal ceiling, imported — a sanity bound
     * against an author that loops, set far above any panel a developer can
     * read, because rejecting a legitimately large panel does not produce a
     * smaller one but a fallback one.
     *
     * Each entry is parsed by {@link panelNodeInputSchema}, level 1 of the
     * chain, so the nesting bound below every entry is the validator's
     * {@link PANEL_MAX_NODE_DEPTH} — stated to the author here as well, because
     * the emitted schema shows it only as structure.
     */
    layout: z
      .array(panelNodeInputSchema)
      .max(PANEL_LAYOUT_MAX_NODES)
      .describe(
        `The panel content as a list of nodes, in reading order. Containers may nest further nodes inside themselves, at most ${String(PANEL_MAX_NODE_DEPTH)} levels deep counting a node in this list as level 1, and the deepest level holds visualization nodes only. At most ${String(PANEL_LAYOUT_MAX_NODES)} nodes at this level; an empty list is valid when the capture holds nothing worth drawing.`,
      ),
  })
  .describe(
    'A panel: a title, a prose summary, and a list of nodes that each name a prepared view of one capture. Choose the nodes that answer the question asked — a panel is convincing because the views it composes bear on the question, not because it shows everything available. Node ids, versions and identifiers are not authored: they are assigned when the panel is prepared for rendering.',
  );

/**
 * A panel as it may be authored, before normalisation.
 *
 * Inferred from {@link panelSpecInputSchema}, so the validator and the type are
 * one statement. This is the type `packages/model-provider` parses a model's
 * structured output into, and the input of `normalizePanel`.
 */
export type PanelSpecInput = z.infer<typeof panelSpecInputSchema>;

/*
 * ---------------------------------------------------------------------------
 * Non-throwing parser
 * ---------------------------------------------------------------------------
 */

/** The name this module reports for {@link panelSpecInputSchema} in a rejection. */
const PANEL_SPEC_INPUT_SCHEMA_NAME = 'panelSpecInput';

/** How an issue on the document itself, rather than on one of its fields, is named. */
const PANEL_SPEC_INPUT_ROOT_PATH = '<document>';

/**
 * How many issue locations the message lists: **8**.
 *
 * Enough to repair a document in one round — a malformed panel usually fails in
 * a handful of places, often the same mistake repeated — and few enough that a
 * message stays readable in a log line, a notification and a repair prompt. The
 * count of what was omitted is appended, so nothing is hidden.
 */
const MAX_REPORTED_ISSUE_PATHS = 8;

/**
 * The most node positions an authored panel may hold in all: **4,160**, which
 * is `PANEL_LAYOUT_MAX_NODES × (1 + LAYOUT_NODE_MAX_CHILDREN)`.
 *
 * A node position is one entry of `layout` or of a container's `children`, and
 * it is counted each time it is reached: a node object placed in two positions
 * counts twice, because it is parsed, normalised and drawn twice.
 *
 * **Derived from the two width bounds, never chosen.** It is the size of the
 * widest document two levels deep — every top-level position a container, and
 * every container full — so every document of depth 1 or 2 that the width
 * bounds admit is within it, and the rule can only reject a document of depth 3
 * or more. That is far above any panel a developer can read (the product's own
 * panels hold a few dozen nodes) and far below the more than 64⁸ positions the
 * width and depth bounds alone would admit.
 *
 * **The one rule {@link parsePanelSpecInput} enforces that
 * {@link panelSpecInputSchema} cannot express.** A total is a property of the
 * whole document, which no node's schema sees. Stating it in the schema would
 * take a refinement or a preprocess, and neither renders to JSON Schema, which
 * `./json-schema.ts` emits with `unrepresentable: 'throw'`. So a document that
 * is inside every width and depth bound but over this total is accepted by the
 * schema and rejected by the parser, with `panel_node_count_exceeded` at the
 * document root.
 *
 * A direct caller of the schema is not exposed by that gap, for two reasons.
 * First, measured on Zod 4.6.5: the schema library applies `.max` without
 * skipping elements, so an array over its bound still has every element parsed
 * — 200,000 malformed elements produce 200,001 issues in about a quarter of a
 * second — and the schema's work is therefore linear in the size of the value
 * it is given. Second, on the model path
 * `packages/model-provider/src/structured.ts` calls
 * `panelSpecInputSchema.safeParse` on `JSON.parse` output, which is always a
 * tree and never shares a subtree, so that size is the size of the reply, which
 * the provider's output limit bounds, while depth is bounded by the schema's
 * construction. What this total adds is a bound for a value assembled in code,
 * which can place one subtree object in every position of every level and so
 * present more than 64⁸ positions in a few kilobytes.
 */
export const PANEL_INPUT_MAX_NODE_COUNT = PANEL_LAYOUT_MAX_NODES * (1 + LAYOUT_NODE_MAX_CHILDREN);

/**
 * The most issues the node preflight collects before it stops: **32**, four
 * times the {@link MAX_REPORTED_ISSUE_PATHS} a message lists.
 *
 * The cap is what keeps a preflight rejection's `details.issues` small
 * whatever the input: without it they would be bounded only by
 * {@link PANEL_INPUT_MAX_NODE_COUNT}, since a document can hold one too-deep
 * position per child of every container it places at the deepest level —
 * thousands of them within the budget. Four messages' worth leaves a caller
 * reading the details more than the message shows, and stays small enough to
 * log, persist and send whole.
 *
 * When the walk stops here with positions still unexamined, the rejection says
 * so — `details.truncated` and a fixed closing clause — so the message's
 * "and N more" is never read as a complete count. Exported for the colocated
 * suite; it is not part of the package entry.
 */
export const PANEL_INPUT_MAX_PREFLIGHT_ISSUES = MAX_REPORTED_ISSUE_PATHS * 4;

/**
 * The clause a rejection's message ends with when the preflight stopped before
 * examining the whole document.
 *
 * Fixed text, carrying no count and no value: what it tells the reader is that
 * the issues listed are the ones found before the walk stopped, not all the
 * document holds.
 */
const PREFLIGHT_TRUNCATED_CLAUSE = 'the document was not examined further';

/**
 * The hint offered when an authored panel fails validation.
 *
 * States the rules, never the values that broke them. The depth and node-count
 * figures are the constants the schema and the preflight enforce, so the
 * sentence cannot drift from either bound.
 */
const PANEL_SPEC_INPUT_HINT = `An authored panel needs a non-empty title, a summary written as a sentence or as an object of prose, and a layout of nodes whose types, sources, sorts and metric ids come from the closed vocabularies; containers nest at most ${String(PANEL_MAX_NODE_DEPTH)} levels deep, counting a top-level node as level 1, and the deepest level holds visualization nodes only; a panel holds at most ${String(PANEL_INPUT_MAX_NODE_COUNT)} nodes in all; no other field is accepted, and node ids are assigned rather than authored.`;

/**
 * The issue code reported when a too-deeply nested node is found before the
 * schema runs: the syntactic validator's own code for the same condition.
 *
 * Typed to that validator's closed vocabulary, so the code a rejection carries
 * here and the code `validatePanelSpec` reports at step 3 are provably one
 * member of `PANEL_VALIDATION_ISSUE_CODES` and cannot drift apart.
 */
const NODE_DEPTH_EXCEEDED_CODE: PanelValidationIssueCode = 'panel_node_depth_exceeded';

/**
 * The issue code reported when the value could not be read at all:
 * `panel_input_unreadable`.
 *
 * Raised when inspecting the value threw rather than answered — an accessor
 * property whose getter throws, a proxy whose trap throws, a revoked proxy.
 * Such a value cannot be a panel, and the exception it raised is caller-owned
 * data, so it is replaced by this fixed code at the document's root and nothing
 * of it — message, value or the error itself as a `cause` — reaches the
 * rejection. Snake case, like the schema library's codes and the validator's,
 * because all three can appear in the same `issues` array.
 */
const PANEL_INPUT_UNREADABLE_CODE = 'panel_input_unreadable';

/**
 * The issue code reported when a document holds more node positions than
 * {@link PANEL_INPUT_MAX_NODE_COUNT}: `panel_node_count_exceeded`.
 *
 * Reported once, at the document's root, because the total belongs to the
 * document rather than to any one node, and the walk that counts stops the
 * moment the total would be exceeded, so no later position is named. A code of
 * this module's own, like {@link PANEL_INPUT_UNREADABLE_CODE}: the schema has no
 * code for a rule it cannot express, and the internal validator has no such
 * rule. Snake case for the same reason as that code.
 */
const PANEL_NODE_COUNT_EXCEEDED_CODE = 'panel_node_count_exceeded';

/**
 * The issue code reported when a node array is longer than its position
 * allows: the schema library's own `too_big`.
 *
 * Typed to that library's issue shape, so the code is provably the one its
 * `.max` check reports at the same path — which is what lets the preflight
 * report the schema's diagnosis for an over-long array without letting the
 * schema read it.
 */
const ARRAY_TOO_BIG_CODE: z.core.$ZodIssueTooBig['code'] = 'too_big';

/**
 * Renders issue locations for the rejection message: **paths and codes only**.
 *
 * The one line of formatting in this module that has a privacy constraint
 * attached, and it is the reason the message is built from
 * {@link describeIssues}' output rather than from the issues themselves. What
 * an authored panel contains is prose about captured runtime data — a component
 * name, a redacted URL, a statement fragment — and the error built here is
 * logged, may be persisted with the session, travels to both user interfaces,
 * and is quoted back to the model by the repair loop, passing through neither
 * the redaction layer nor the outbound guard on the way (AAP 0.5.2). So the
 * offending value never enters it: a field path, an issue code, and the
 * expected type where the schema library reports one, which is a type name and
 * never data.
 *
 * It must nevertheless be *actionable*, because the repair loop in
 * `packages/model-provider/src/structured.ts` has nothing else to work from: a
 * message that leaks nothing and says nothing would make a repair attempt a
 * guess. A location plus a code — `layout.2.source: invalid_value` — names the
 * field and the kind of mistake without quoting either.
 *
 * @param issues The described issues of a failed parse, in report order.
 * @returns A single line of `path: code` locations, with a count of any
 * omitted beyond the reporting limit.
 */
function describeIssueLocations(issues: readonly SchemaIssueSummary[]): string {
  const reported = issues.slice(0, MAX_REPORTED_ISSUE_PATHS).map((issue) => {
    const path = issue.path === '' ? PANEL_SPEC_INPUT_ROOT_PATH : issue.path;

    return issue.expected === undefined
      ? `${path}: ${issue.code}`
      : `${path}: ${issue.code} (expected ${issue.expected})`;
  });

  if (reported.length === 0) {
    return 'no issue was reported';
  }

  const omitted = issues.length - reported.length;

  return omitted > 0 ? `${reported.join('; ')}; and ${String(omitted)} more` : reported.join('; ');
}

/** How a rejection is qualified beyond its issues. */
interface PanelSpecInputRejectionOptions {
  /**
   * Whether the preflight stopped before examining the whole document — for
   * the node budget or for the issue cap. Absent means it did not.
   */
  readonly truncated?: boolean;
}

/**
 * Builds the rejection for an authored panel: `PANEL_INVALID`, the issue
 * locations in the message, the issues themselves in the details.
 *
 * One builder for every way {@link parsePanelSpecInput} can reject — a
 * preflight finding (a node array too long, a node nested too deeply, too many
 * nodes in all), a schema failure, a value that could not be read — so all of
 * them are the same error to every consumer: the same code, the same message
 * shape, the same hint and the same privacy rule (paths and codes only, see
 * {@link describeIssueLocations}).
 *
 * A truncated rejection adds `details.truncated: true` and ends its message
 * with {@link PREFLIGHT_TRUNCATED_CLAUSE}, so a reader never takes the issues
 * listed, or the "and N more" after them, for everything the document holds.
 * An untruncated one carries no `truncated` key at all.
 *
 * @param issues The issues to report, in report order.
 * @param options Whether the issues are those of a walk that stopped early.
 * @returns The rejection.
 */
function panelSpecInputRejection(
  issues: readonly SchemaIssueSummary[],
  options: PanelSpecInputRejectionOptions = {},
): DebuggenError {
  const truncated = options.truncated === true;
  const locations = describeIssueLocations(issues);

  return new DebuggenError(
    'PANEL_INVALID',
    truncated
      ? `A value did not match the ${PANEL_SPEC_INPUT_SCHEMA_NAME} schema: ${locations}; ${PREFLIGHT_TRUNCATED_CLAUSE}.`
      : `A value did not match the ${PANEL_SPEC_INPUT_SCHEMA_NAME} schema: ${locations}.`,
    {
      hint: PANEL_SPEC_INPUT_HINT,
      details: truncated
        ? { schema: PANEL_SPEC_INPUT_SCHEMA_NAME, issues, truncated: true }
        : { schema: PANEL_SPEC_INPUT_SCHEMA_NAME, issues },
    },
  );
}

/*
 * ---------------------------------------------------------------------------
 * The node preflight
 *
 * Defence in depth behind the chain above, run over the raw value before the
 * schema sees it. The chain already bounds the depth of parsing; the preflight
 * bounds its breadth and its total, and does so before anything is parsed:
 *
 * - **width** — a node array longer than the schema allows at its position is
 *   reported with the schema's own `too_big` at the array's path, from its
 *   `length` alone, and none of its entries is read;
 * - **depth** — the validator's own diagnosis, `panel_node_depth_exceeded` at
 *   the path of each node beyond the bound;
 * - **total** — a document holding more than {@link PANEL_INPUT_MAX_NODE_COUNT}
 *   node positions is reported with `panel_node_count_exceeded` at its root;
 * - **issues** — at most {@link PANEL_INPUT_MAX_PREFLIGHT_ISSUES} are
 *   collected.
 *
 * The walk has no recursion, so no depth of input can make it throw, and its
 * work is at most one visit per admitted position plus one `length` read per
 * container — bounded by the budget, whatever the size of the input.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a value is an array, narrowing to an array of `unknown`.
 *
 * A predicate rather than a bare `Array.isArray` call, because that narrows an
 * `unknown` to `any[]`, and every element read from it would then be an `any`.
 *
 * @param value Any value.
 * @returns `true` when `value` is an array.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** One node position awaiting the node preflight. */
interface NodePreflightFrame {
  /** Whatever sits at this node position, not yet classified. */
  readonly value: unknown;

  /** The position as a dotted path — the form `describeIssues` reports. */
  readonly path: string;

  /** The position's nesting level, a node written directly in `layout` being 1. */
  readonly level: number;
}

/**
 * Why the node preflight stopped before its stack was empty.
 *
 * - `node_budget` — admitting one more node array would have taken the walk
 *   past {@link PANEL_INPUT_MAX_NODE_COUNT} positions;
 * - `issue_cap` — {@link PANEL_INPUT_MAX_PREFLIGHT_ISSUES} issues were
 *   collected with positions still unexamined;
 * - `unreadable` — a node array reported a `length` no array can have, which
 *   only a proxy can do, so its size and its entries cannot be trusted.
 */
type NodePreflightStop = 'node_budget' | 'issue_cap' | 'unreadable';

/**
 * The state of one node preflight walk. **Mutated** by the walk, and by
 * nothing else: one is built per call and never escapes it.
 */
interface NodePreflightWalk {
  /** The positions admitted and not yet visited: a LIFO stack. */
  readonly pending: NodePreflightFrame[];

  /** What the walk has found so far, in reading order. */
  readonly issues: SchemaIssueSummary[];

  /** How many node positions have been admitted, over the whole walk. */
  positions: number;

  /** Why the walk stopped early, once it has; `undefined` while it runs. */
  stoppedBy: NodePreflightStop | undefined;
}

/** What the node preflight found, and whether it examined the whole document. */
interface NodePreflightOutcome {
  /**
   * The issues found, in reading order — the node-count issue, when there is
   * one, first. Empty when there is none, and never longer than
   * {@link PANEL_INPUT_MAX_PREFLIGHT_ISSUES}.
   */
  readonly issues: readonly SchemaIssueSummary[];

  /** Whether the walk stopped with node positions still unexamined. */
  readonly truncated: boolean;
}

/** The one issue a value that could not be read is rejected with. */
const UNREADABLE_INPUT_ISSUES: readonly SchemaIssueSummary[] = Object.freeze([
  Object.freeze({ path: '', code: PANEL_INPUT_UNREADABLE_CODE }),
]);

/** The one issue a document over the node budget is rejected with. */
const NODE_COUNT_EXCEEDED_ISSUE: SchemaIssueSummary = Object.freeze({
  path: '',
  code: PANEL_NODE_COUNT_EXCEEDED_CODE,
});

/** The outcome of a preflight that found nothing: the schema decides. */
const CLEAN_PREFLIGHT: NodePreflightOutcome = Object.freeze({
  issues: Object.freeze([]),
  truncated: false,
});

/**
 * The outcome of a preflight that met a node array it could not size: the
 * same rejection a value whose inspection throws receives.
 */
const UNREADABLE_PREFLIGHT: NodePreflightOutcome = Object.freeze({
  issues: UNREADABLE_INPUT_ISSUES,
  truncated: false,
});

/**
 * The children the chain would parse below a value, or `undefined` when it
 * would parse none.
 *
 * Mirrors what a level of the chain does and nothing more: it descends only
 * into a non-array object whose `type` names one of the three containers, and
 * only through that object's `children` array. Properties are read with
 * ordinary property access, as the schema library reads them, so the preflight
 * walks the same tree the schema would. Every other value — a leaf, an unknown
 * type, a primitive, a container whose `children` is not an array — has no
 * child position here, exactly as it has none in the schema.
 *
 * @param value The value at one node position.
 * @returns The children array to descend into, or `undefined`.
 */
function containerChildrenOf(value: unknown): readonly unknown[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const node = value as Readonly<Record<string, unknown>>;

  if (!isLayoutNodeType(node['type'])) {
    return undefined;
  }

  const children = node[PANEL_CHILDREN_FIELD];

  return isUnknownArray(children) ? children : undefined;
}

/**
 * Admits the entries of one node array to the walk as node positions, or
 * records why it does not.
 *
 * Everything is decided from the array's `length`, read once, before any entry
 * is read — so an array's size costs the walk nothing, however large it is:
 *
 * 1. A `length` that is not a non-negative safe integer — possible only for a
 *    proxy, which may answer anything — stops the walk as `unreadable`.
 * 2. A `length` over `maxEntries`, the bound the schema's `.max` applies at
 *    this position, records the schema's own `too_big` at the array's path and
 *    admits nothing; the walk goes on with the rest of the document.
 * 3. A `length` that would take the walk past
 *    {@link PANEL_INPUT_MAX_NODE_COUNT} positions admits nothing and stops the
 *    walk as `node_budget`.
 * 4. Otherwise each entry is pushed, by index from the last to the first. The
 *    stack is LIFO, so the first sibling comes out first and issues are
 *    reported in reading order; indices are read only below `length`, so a
 *    hole in a sparse array is read as `undefined`, which has no children; and
 *    pushing one at a time rather than by spread means no length can meet the
 *    runtime's argument limit.
 *
 * @param walk The walk to admit to. **Mutated.**
 * @param nodes The array whose entries are node positions.
 * @param arrayPath The dotted path of that array: `layout`, or a container's
 * path followed by `children`.
 * @param level The nesting level of its entries.
 * @param maxEntries The most entries the schema accepts at this position.
 */
function admitNodePositions(
  walk: NodePreflightWalk,
  nodes: readonly unknown[],
  arrayPath: string,
  level: number,
  maxEntries: number,
): void {
  // Typed as `unknown` rather than trusted as the `number` an array's type
  // promises: a proxy's `get` trap may answer anything for `length`.
  const length: unknown = nodes.length;

  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    walk.stoppedBy = 'unreadable';
    return;
  }

  if (length > maxEntries) {
    walk.issues.push({ path: arrayPath, code: ARRAY_TOO_BIG_CODE });
    return;
  }

  if (walk.positions + length > PANEL_INPUT_MAX_NODE_COUNT) {
    walk.stoppedBy = 'node_budget';
    return;
  }

  walk.positions += length;

  for (let index = length - 1; index >= 0; index -= 1) {
    walk.pending.push({ value: nodes[index], path: `${arrayPath}.${String(index)}`, level });
  }
}

/**
 * The next position for the walk to visit, or `undefined` when the walk is
 * over — because its stack is empty, because it has stopped, or because the
 * issue cap has just stopped it.
 *
 * The cap is checked here, before each visit, and a visit adds at most one
 * issue, so the walk never holds more than
 * {@link PANEL_INPUT_MAX_PREFLIGHT_ISSUES}. It stops the walk only when a
 * position is still waiting: a document whose last position brings the count
 * to the cap has been examined in full, and is not reported as truncated.
 *
 * @param walk The walk. **Mutated** when the cap stops it.
 * @returns The next frame, or `undefined`.
 */
function nextNodePosition(walk: NodePreflightWalk): NodePreflightFrame | undefined {
  if (walk.stoppedBy !== undefined || walk.pending.length === 0) {
    return undefined;
  }

  if (walk.issues.length >= PANEL_INPUT_MAX_PREFLIGHT_ISSUES) {
    walk.stoppedBy = 'issue_cap';
    return undefined;
  }

  return walk.pending.pop();
}

/**
 * The outcome a finished walk reports.
 *
 * @param walk The walk, run to its end.
 * @returns Its issues and whether it was truncated, with the node-count issue
 * leading the list when the budget stopped it: that issue concerns the whole
 * document, and it is the reason nothing after the issues before it was
 * examined.
 */
function nodePreflightOutcomeOf(walk: NodePreflightWalk): NodePreflightOutcome {
  switch (walk.stoppedBy) {
    case undefined:
      return walk.issues.length === 0 ? CLEAN_PREFLIGHT : { issues: walk.issues, truncated: false };
    case 'issue_cap':
      return { issues: walk.issues, truncated: true };
    case 'node_budget':
      return { issues: [NODE_COUNT_EXCEEDED_ISSUE, ...walk.issues], truncated: true };
    case 'unreadable':
      return UNREADABLE_PREFLIGHT;
  }
}

/**
 * Checks the node positions of a raw value — how many there are in each array,
 * how deep they go and how many there are in all — without recursion and
 * before the schema runs.
 *
 * Walks `value.layout` when it is an array — a value without one is left
 * entirely to the schema — depth first with an explicit stack, descending only
 * where {@link containerChildrenOf} says the schema would, and admitting each
 * node array through {@link admitNodePositions}, which reads its `length`
 * before any entry. What it reports:
 *
 * - `too_big` at the path of a node array longer than its position allows —
 *   {@link PANEL_LAYOUT_MAX_NODES} for `layout`,
 *   {@link LAYOUT_NODE_MAX_CHILDREN} for a container's `children` — whose
 *   entries are then never read;
 * - `panel_node_depth_exceeded` at the path of each position beyond
 *   {@link PANEL_MAX_NODE_DEPTH} (one `children` segment per container above
 *   it, the convention `validatePanelSpec` reports in), which is never looked
 *   into;
 * - `panel_node_count_exceeded` at the document root, once, when admitting a
 *   node array would take the walk past {@link PANEL_INPUT_MAX_NODE_COUNT}
 *   positions — at which point the walk stops at once.
 *
 * It also stops once {@link PANEL_INPUT_MAX_PREFLIGHT_ISSUES} issues are
 * collected. Either early stop is reported as `truncated`.
 *
 * **The work is bounded by the budget, not by the input.** Each admitted
 * position is visited once, and admission reads one `length` per container
 * visited, so the walk costs at most {@link PANEL_INPUT_MAX_NODE_COUNT} visits
 * plus one length read each, however long its arrays, however sparse, and
 * however many positions a shared subtree presents. A cyclic object graph
 * terminates at the depth cut-off or the budget, whichever it meets first.
 *
 * **Every value this rejects, the schema rejects too — except by the node
 * count.** A `too_big` array is one the schema's `.max` refuses at the same
 * path, or, at the deepest level, sits in a container that level's union
 * refuses outright. A position beyond the depth bound exists only below a
 * container at the deepest level, which the schema refuses the same way. The
 * one exception is `panel_node_count_exceeded`: a total is the one rule the
 * schema cannot express (see {@link PANEL_INPUT_MAX_NODE_COUNT}), so a document
 * within every width and depth bound but over the total is accepted by the
 * schema and rejected here.
 *
 * May throw, when reading the value throws — a throwing getter, a proxy trap —
 * which is why {@link parsePanelSpecInput} calls it inside its `try`.
 *
 * @param value The raw value handed to the parser.
 * @returns The issues found, in reading order with the node-count issue first,
 * and whether the walk stopped early; no issues when the schema should decide.
 */
function preflightNodePositions(value: unknown): NodePreflightOutcome {
  if (typeof value !== 'object' || value === null) {
    return CLEAN_PREFLIGHT;
  }

  const layout = (value as Readonly<Record<string, unknown>>)[PANEL_LAYOUT_FIELD];

  if (!isUnknownArray(layout)) {
    return CLEAN_PREFLIGHT;
  }

  const walk: NodePreflightWalk = { pending: [], issues: [], positions: 0, stoppedBy: undefined };

  admitNodePositions(walk, layout, PANEL_LAYOUT_FIELD, 1, PANEL_LAYOUT_MAX_NODES);

  for (let frame = nextNodePosition(walk); frame !== undefined; frame = nextNodePosition(walk)) {
    if (frame.level > PANEL_MAX_NODE_DEPTH) {
      walk.issues.push({ path: frame.path, code: NODE_DEPTH_EXCEEDED_CODE });
      continue;
    }

    const children = containerChildrenOf(frame.value);

    if (children !== undefined) {
      admitNodePositions(
        walk,
        children,
        `${frame.path}.${PANEL_CHILDREN_FIELD}`,
        frame.level + 1,
        LAYOUT_NODE_MAX_CHILDREN,
      );
    }
  }

  return nodePreflightOutcomeOf(walk);
}

/*
 * ---------------------------------------------------------------------------
 * The parser
 * ---------------------------------------------------------------------------
 */

/**
 * Validates an unknown value as a {@link PanelSpecInput}, without throwing.
 *
 * This is step 1 of the three-step pipeline. The model provider's
 * structured-output loop (`packages/model-provider/src/structured.ts`) applies
 * the same judgement by parsing a reply against {@link panelSpecInputSchema}
 * itself, re-prompting with the issues at most twice before the generating
 * stage gives up and substitutes a deterministic fallback panel marked as one
 * (AAP 0.5.3, 0.5.5); this function is that judgement as a `Result`, for every
 * caller holding a value believed to be an authored panel, plus the one rule
 * the schema cannot express — the node budget of step 1. Non-throwing is a
 * requirement rather than a preference: a rejected panel has a defined outcome,
 * and that outcome is not "abort the stage".
 *
 * Three steps, and no input makes any of them throw out of here:
 *
 * 1. **The node preflight** ({@link preflightNodePositions}), whose work is
 *    bounded by {@link PANEL_INPUT_MAX_NODE_COUNT} whatever the input. A node
 *    array longer than its position allows is rejected with `too_big` at its
 *    path without an entry of it being read; a node nested beyond
 *    {@link PANEL_MAX_NODE_DEPTH} with `panel_node_depth_exceeded` at its path —
 *    the validator's code and path convention; and a document of more than
 *    {@link PANEL_INPUT_MAX_NODE_COUNT} node positions in all with
 *    `panel_node_count_exceeded` at its root. Any of these rejects without the
 *    schema running at all. The first two are rejections the schema would make
 *    too; **the node count is not** — it is the one rule this function enforces
 *    that {@link panelSpecInputSchema} cannot express, so a document the schema
 *    alone accepts can be rejected here for its total, and for nothing else.
 *    The preflight collects at most {@link PANEL_INPUT_MAX_PREFLIGHT_ISSUES}
 *    issues; when it stops early, for that cap or for the budget, the
 *    rejection carries `details.truncated: true` and says so in its message.
 * 2. **The schema**, which is itself depth-bounded by construction, so even a
 *    value the preflight could not see into is parsed in bounded depth, and
 *    which after a clean preflight parses at most the budget's node positions,
 *    none of them in an array longer than its bound.
 * 3. **Exception translation.** A value whose inspection throws — a throwing
 *    getter, a proxy trap — is rejected with the fixed
 *    `panel_input_unreadable` issue at the document root, and so is a node
 *    array that reports a `length` no array can have. The caught exception is
 *    discarded unread: it is caller-controlled data, so neither its message,
 *    nor any value it carries, nor the error itself as a `cause` reaches the
 *    rejection.
 *
 * A value that passes here is well formed, not yet true. It still has to
 * normalise, pass the internal schema, and be checked against the capture — and
 * a failure at any of those later steps is a bug in this product rather than in
 * the author's output, which is why they are never retried against the model.
 *
 * **The error carries the shape of the failure and none of the data that caused
 * it**, in both the message and the details — see {@link describeIssueLocations}
 * for why that is not optional here.
 *
 * The code is the panel-validation code from `@debuggen/shared`'s closed
 * vocabulary, the same code this package's other parsers use, whichever step
 * rejected; no code is invented. A caller at the model boundary that wants the
 * model-output vocabulary maps it with the shared `mapErr`.
 *
 * @param value Any value believed to be an authored panel.
 * @returns `ok(input)` with the parsed document, or `err(error)` naming the
 * issues found, by path and code only — every one of them, unless the error's
 * details say it is truncated.
 */
export function parsePanelSpecInput(value: unknown): Result<PanelSpecInput, DebuggenError> {
  let preflight: NodePreflightOutcome;
  let parsed: z.ZodSafeParseResult<PanelSpecInput> | undefined;

  try {
    preflight = preflightNodePositions(value);
    parsed = preflight.issues.length === 0 ? panelSpecInputSchema.safeParse(value) : undefined;
  } catch {
    // Deliberately unbound: the exception is caller-controlled data and must
    // not reach the rejection in any form (see step 3 above).
    return err(panelSpecInputRejection(UNREADABLE_INPUT_ISSUES));
  }

  if (parsed === undefined) {
    return err(panelSpecInputRejection(preflight.issues, { truncated: preflight.truncated }));
  }

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(panelSpecInputRejection(describeIssues(parsed.error.issues)));
}
