/**
 * `@debuggen/panel-schema` — the vocabulary a generated panel is written in.
 *
 * A panel is a document with two halves: a summary that keeps what was
 * *observed* during a capture apart from what is merely *inferred* from it, and
 * a tree of nodes that each name a prepared view of that same capture. This
 * package holds the single definition of both halves, as Zod schemas and the
 * types inferred from them, so that the process which generates a panel, the
 * process which stores it and serves its data, and the two surfaces which render
 * it cannot disagree about the shapes involved (AAP 0.2.2, AAP 0.2.3).
 *
 * ## One entry, and it is this file
 *
 * The package manifest publishes exactly one condition — `"."`, mapping to
 * `dist/index.js` with `dist/index.d.ts` beside it — and the sibling
 * `tsup.config.ts` emits both from this module alone. So this is the package's
 * only public door: a declaration that is not re-exported below is invisible to
 * `apps/local-service`, `@debuggen/protocol` and `@debuggen/panel-renderer`,
 * which depend on this package directly, to the DevTools extension, which lists
 * it in its own package manifest, and to the editor extension, which reaches it
 * through the renderer and the protocol package — however public that
 * declaration looks in the module that owns it. A second entry would be a change
 * to the `exports` map and to AAP 0.2.5, not an edit here.
 *
 * The two workspace dependencies are deliberately **not** re-exported. The
 * shapes this package borrows from them — the source-location schema from
 * `@debuggen/shared`, the telemetry kind and tier vocabularies and the fixed
 * metric ids from `@debuggen/telemetry` — keep one import path each, so a
 * consumer that needs one reaches the package that defines it rather than
 * receiving a second route to the same binding through here. Nor is any
 * third-party binding forwarded: a consumer that wants Zod imports Zod.
 *
 * ## The three steps this package exists to make safe
 *
 * Panel generation is three fixed steps, and every one of them is a function
 * behind this entry (AAP 0.5.3):
 *
 * 1. **Validate the authoring input.** `parsePanelSpecInput` parses whatever a
 *    model produced against the *authoring* schema — the forgiving shape in
 *    which a node's data request may be written flat on the node, ids and
 *    versions are absent because they are not the author's to mint, and the
 *    summary is prose. `panelSpecInputJsonSchema` renders that same schema for
 *    the prompt, so the shape asked for and the shape enforced are one artefact.
 * 2. **Normalise deterministically.** `normalizePanel` turns a parsed input into
 *    the internal {@link PanelSpec}: flat query fields move into each node's
 *    `query`, nodes acquire ids from their position, the document acquires its
 *    version and identifiers from the caller's context, and the summary acquires
 *    its observed facts and likely causes **from the validated analysis** and
 *    from nowhere else. No model, no clock, no randomness: equal arguments give
 *    an equal document.
 * 3. **Validate the result.** `validatePanelSpec` parses it against the internal
 *    schema and `validateAgainstCapture` checks it against the capture it claims
 *    to describe — that every cited event id and trace filter exists, and that
 *    each node draws only from a source its catalog entry allows.
 *
 * Which failure belongs to whom follows from that order. A step-1 failure is the
 * model's, and the caller re-prompts with the issues a bounded number of times.
 * A failure in step 2 or step 3 is **ours**: the normaliser is deterministic and
 * the internal schema is the normaliser's own target, so a rejection there
 * reports a product bug, is logged with the input, and is never retried against
 * the model. In either case the caller stops asking and assembles a fallback
 * panel deterministically from the capture aggregates, marked `meta.fallback`
 * — see {@link PanelMeta} — which the renderer draws under a visible banner
 * rather than presenting as an answer. Nothing here presents a failure as an
 * analysis.
 *
 * ## The catalog is the registry both sides key on
 *
 * {@link PANEL_NODE_CATALOG} is the single registry of node types, one entry per
 * type, each declaring the data sources that type may query, the telemetry
 * fields it reads and the prose that describes it to a model. It is a runtime
 * value and not merely a type, because two independent consumers key on it: the
 * validator here rejects a node type the catalog does not contain, and the
 * renderer's component registry is built from it and fails its own test on an
 * entry with no component behind it (AAP 0.6.2). `describeCatalogForPrompt`
 * turns the same registry into the catalogue a panel-generation prompt embeds,
 * so a node type cannot be offered to a model without being renderable.
 *
 * ## What lives behind this entry
 *
 * Eleven modules, re-exported in dependency order, which is also this package's
 * internal layering:
 *
 * - `summary` — the evidence boundary, expressed as types rather than as a
 *   convention. `EventRef`; `Fact`, whose `evidence` array is bounded below by
 *   one, so a statement with nothing to cite cannot be parsed into an observed
 *   fact at all; `Hypothesis`, a `Fact` plus a required `ConfidenceLevel` and an
 *   optional `suggestedLocation`, and a distinct type so no assignment can move
 *   a guess into the observed list; and the `PanelSummary` that carries those
 *   two lists beside the one field free prose is allowed in. With them: their
 *   schemas, the exported length and cardinality bounds those schemas enforce,
 *   the confidence vocabulary with its guard and its ordering comparator, the
 *   non-throwing `parseFact` and `parseHypothesis`, and `describeIssues` — the
 *   single implementation of the rule that a validation failure is reported by
 *   its *shape* and never by the value that caused it (AAP 0.5.2).
 * - `nodes/query` — the `DataQuery` contract every query-backed node is resolved
 *   through: the ten-member source vocabulary, each member of which corresponds
 *   to exactly one prepared result shape the panel-data route serves; the sort
 *   vocabulary; the filter shape and its bounds; the paging constants a resolver
 *   applies to an omitted `limit` or `offset`, exported so both sides agree on
 *   the numbers instead of restating them; the authoritative list of flat
 *   authoring fields that a normaliser lifts into `node.query`; and the node
 *   identity, title and description primitives both node modules share, declared
 *   once here so half the node vocabulary cannot drift from the other half.
 * - `nodes/layout` — the three containers a panel may compose (`section`,
 *   `split`, `stack`): their generic interfaces, the split-direction and
 *   child-count vocabularies, and schema **factories** parameterised by the
 *   schema of a child — `sectionNodeSchema`, `splitNodeSchema`,
 *   `stackNodeSchema` and the three-at-once `layoutNodeSchemasFor`. The
 *   parameter is what keeps a recursive node union closed by the module that
 *   composes these, exactly once, rather than inside this package's node folder.
 * - `nodes/viz` — the thirteen leaves, none of which accepts children: twelve
 *   query-backed visualization node schemas with their inferred types, the
 *   `sourceLink` leaf that carries a `SourceLocation` and no query, the
 *   node-type vocabularies with their schema and guard, and
 *   `VISUALIZATION_NODE_SCHEMAS` — the ordered tuple, proved at compile time to
 *   hold one schema per node type in vocabulary order, that a node union is
 *   assembled from. No node below carries a height, a column count, a threshold
 *   or a colour: what a node may vary is which evidence it draws, and every
 *   visual value belongs to the renderer's design tokens (AAP 0.6.2).
 * - `spec` — the internal document. `panelNodeSchema` closes the recursion by
 *   feeding the layout factories the node union they parameterise; `PanelSpec`
 *   and `panelSpecSchema` wrap a summary and a layout in the version, the
 *   identifiers and the supersession link a stored panel needs; `walkPanelNodes`
 *   is the one traversal both validators and any consumer walk a layout with, so
 *   node order and node paths mean the same thing everywhere; `parsePanelSpec`
 *   is the non-throwing parse of a stored document.
 * - `input` — the authoring schema in full: the flat data-query form, a node
 *   input per visualization type, the three layout inputs, the authored summary
 *   in its prose and statement forms, and `panelSpecInputSchema` with its
 *   non-throwing `parsePanelSpecInput`. This is the only schema a model's output
 *   is ever measured against. Its node union is not recursive but an unrolled
 *   chain bounded at `validate`'s `PANEL_MAX_NODE_DEPTH`, so parsing any
 *   authored document costs a bounded depth; reading that constant and the
 *   depth issue code is the one edge in this list that points at a module
 *   listed after it, and `validate` imports nothing from `input`, so the graph
 *   stays acyclic. `PANEL_INPUT_MAX_NODE_COUNT` is the total number of node
 *   positions `parsePanelSpecInput` admits, checked before the schema runs —
 *   the one rule that parser enforces and the schema cannot express, since a
 *   total renders to no JSON Schema keyword.
 * - `catalog` — the node registry described above, its entry type, the lookup
 *   and the two guards over it, and the prompt renderer.
 * - `normalize` — `normalizePanel` and the two argument shapes it reads: the
 *   validated analysis the summary's facts and hypotheses are copied from, and
 *   the context that supplies the identifiers, the panel version and the
 *   fallback marker.
 * - `validate` — the internal syntactic and structural gate: `validatePanelSpec`
 *   for the `Result` form, `assertValidPanelSpec` for the throwing form,
 *   `collectPanelSpecIssues` for every issue at once, and the issue vocabulary
 *   and depth bound they share.
 * - `semantic` — the gate against the capture: `collectSemanticIssues`,
 *   `validateAgainstCapture` with its three-way outcome, and `toResult` for a
 *   caller that wants the same answer as a `Result`. Its options carry the id
 *   resolvers, so a spec can be checked against a capture whose event ids are
 *   known only to the store, and the field-presence tally `tallyFieldPresence`
 *   computes from the capture's events, so a node whose records lack a field
 *   its catalog entry requires is reported rather than rendered empty.
 * - `json-schema` — `panelSpecInputJsonSchema` and its text form, the schema id
 *   and the dialect, for the prompt that asks a model for an authored panel.
 *
 * ## Why the re-exports below are enumerated
 *
 * Every re-export names its symbols instead of forwarding a module wholesale.
 * That is a deliberate departure from the two sibling schema barrels, and it
 * buys two things this entry needs: the whole public surface of the package is
 * auditable in one read, and what crosses the boundary stays a decision rather
 * than a consequence. Each name below is listed because it belongs to the
 * package's contract — including the helpers the modules share with one another,
 * which consumers need for the same reason the modules do. A symbol added to a
 * module later reaches nobody until it is added to a list here, in review, so a
 * declaration exported for a test or for one sibling cannot arrive in four
 * processes as a side effect of an edit elsewhere. AAP 0.8.3 gives this package
 * no entry-boundary test, so this list *is* that audit and is worth its length.
 *
 * Each module is re-exported by exactly two statements — its runtime values,
 * then its types — because `verbatimModuleSyntax` requires a type-only
 * re-export to say `export type`, and because the split makes the value/type
 * character of every name legible. No module is forwarded both wholesale and by
 * name; the lists are the only route out.
 *
 * Every relative specifier below carries an explicit `.js` extension, which the
 * package's `NodeNext` module resolution requires of a `"type": "module"`
 * package whose output is imported directly by a Node process; the bundler maps
 * such a specifier back to the `.ts` file on disk, so the emitted bundle is
 * unaffected.
 *
 * ## Environment-neutral, and must stay that way
 *
 * This barrel is loaded by a Node process — the coordination service validates a
 * model's panel output and resolves its data queries — and must stay loadable,
 * unchanged, in three page-side environments: the DevTools panel, the MV3
 * service worker that relays the protocol envelopes a panel specification
 * travels in, and the editor webview. Nothing reachable from here may therefore
 * import a `node:` builtin, reach for `@debuggen/shared`'s Node-only entry, or
 * touch a DOM global. Two guards keep that honest rather than aspirational: the
 * sibling build sets `platform: 'neutral'` with `removeNodeProtocol: false`, so
 * a builtin specifier has no external to fall back on and fails the build
 * instead of shipping inside this bundle, and the package's compiler project
 * omits `"DOM"` from `lib`, so a `window` or `document` reference does not
 * compile. A review of `dist/index.js` should find no `node:` specifier at all.
 *
 * Importing this module has no side effect, and it declares nothing of its own:
 * every line below is a re-export. The vocabularies behind them are frozen
 * tuples and the schemas are pure values, both built once at load time; no
 * module in the graph reads an environment variable, mutates a global, starts a
 * timer, writes to the console or performs I/O while being loaded; and there is
 * no default export, so a consumer names what it takes. The manifest declares
 * `"sideEffects": false` on that basis, so a bundler may drop whatever a
 * consumer does not use.
 *
 * @example
 * ```ts
 * import {
 *   normalizePanel,
 *   parsePanelSpecInput,
 *   validateAgainstCapture,
 *   validatePanelSpec,
 *   type PanelSpec,
 * } from '@debuggen/panel-schema';
 * ```
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// summary — the fact/hypothesis boundary every generated panel is judged by
// ---------------------------------------------------------------------------
export {
  CONFIDENCE_LEVELS,
  MAX_EVENT_REF_ID_LENGTH,
  MAX_EVENT_REF_LABEL_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_HEADLINE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MAX_SUMMARY_FACTS,
  MAX_SUMMARY_HYPOTHESES,
  compareConfidence,
  confidenceLevelSchema,
  describeIssues,
  eventRefSchema,
  factSchema,
  hypothesisSchema,
  isConfidenceLevel,
  panelSummarySchema,
  parseFact,
  parseHypothesis,
} from './summary.js';
export type {
  ConfidenceLevel,
  EventRef,
  Fact,
  Hypothesis,
  PanelSummary,
  SchemaIssueSummary,
} from './summary.js';

// ---------------------------------------------------------------------------
// nodes/query — the data request every query-backed node is resolved through
// ---------------------------------------------------------------------------
export {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_FLAT_FIELD_KEYS,
  DATA_QUERY_MAX_COMPONENT_LENGTH,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_MAX_TRACE_ID_LENGTH,
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
  PANEL_NODE_DESCRIPTION_MAX_LENGTH,
  PANEL_NODE_ID_MAX_LENGTH,
  PANEL_NODE_ID_PATTERN,
  PANEL_NODE_TITLE_MAX_LENGTH,
  dataQueryFilterSchema,
  dataQuerySchema,
  dataQuerySortSchema,
  dataQuerySourceSchema,
  isDataQuerySort,
  isDataQuerySource,
  panelNodeDescriptionSchema,
  panelNodeIdSchema,
  panelNodeTitleSchema,
  parseDataQuery,
} from './nodes/query.js';
export type {
  DataQuery,
  DataQueryFilter,
  DataQueryFlatFieldKey,
  DataQuerySort,
  DataQuerySource,
  PanelNodeId,
} from './nodes/query.js';

// ---------------------------------------------------------------------------
// nodes/layout — the three containers, as schema factories over a child schema
// ---------------------------------------------------------------------------
export {
  DEFAULT_SPLIT_DIRECTION,
  LAYOUT_NODE_MAX_CHILDREN,
  LAYOUT_NODE_MIN_CHILDREN,
  LAYOUT_NODE_TYPES,
  SPLIT_DIRECTIONS,
  isLayoutNodeType,
  layoutNodeSchemasFor,
  layoutNodeTypeSchema,
  sectionNodeSchema,
  splitDirectionSchema,
  splitNodeSchema,
  stackNodeSchema,
} from './nodes/layout.js';
export type {
  LayoutNodeBase,
  LayoutNodeOf,
  LayoutNodeType,
  SectionNodeOf,
  SplitDirection,
  SplitNodeOf,
  StackNodeOf,
} from './nodes/layout.js';

// ---------------------------------------------------------------------------
// nodes/viz — the thirteen leaves: twelve query-backed views and the source link
// ---------------------------------------------------------------------------
export {
  QUERY_BACKED_NODE_TYPES,
  VISUALIZATION_NODE_SCHEMAS,
  VISUALIZATION_NODE_TYPES,
  componentTreeNodeSchema,
  dependencyGraphNodeSchema,
  eventLogNodeSchema,
  flameNodeSchema,
  isVisualizationNodeType,
  metricCardsNodeSchema,
  queryTableNodeSchema,
  renderTableNodeSchema,
  requestTableNodeSchema,
  sourceLinkNodeSchema,
  stateTransitionsNodeSchema,
  tableNodeSchema,
  timelineNodeSchema,
  visualizationNodeTypeSchema,
  waterfallNodeSchema,
} from './nodes/viz.js';
export type {
  ComponentTreeNode,
  DependencyGraphNode,
  EventLogNode,
  FlameNode,
  MetricCardsNode,
  QueryBackedNode,
  QueryBackedNodeType,
  QueryTableNode,
  RenderTableNode,
  RequestTableNode,
  SourceLinkNode,
  StateTransitionsNode,
  TableNode,
  TimelineNode,
  VisualizationNode,
  VisualizationNodeType,
  WaterfallNode,
} from './nodes/viz.js';

// ---------------------------------------------------------------------------
// spec — the internal document: the closed node union, the PanelSpec, the walk
// ---------------------------------------------------------------------------
export {
  PANEL_CHILDREN_FIELD,
  PANEL_ID_MAX_LENGTH,
  PANEL_LAYOUT_FIELD,
  PANEL_LAYOUT_MAX_NODES,
  PANEL_LAYOUT_NODE_TYPES,
  PANEL_LAYOUT_PATH_ROOT,
  PANEL_NODE_TYPES,
  PANEL_SPEC_VERSION,
  PANEL_TITLE_MAX_LENGTH,
  PANEL_VIZ_NODE_TYPES,
  isPanelNodeType,
  panelMetaSchema,
  panelNodeSchema,
  panelSpecSchema,
  parsePanelSpec,
  walkPanelNodes,
} from './spec.js';
export type {
  PanelLayoutNode,
  PanelMeta,
  PanelNode,
  PanelNodePath,
  PanelNodeType,
  PanelNodeVisitor,
  PanelSectionNode,
  PanelSpec,
  PanelSplitNode,
  PanelStackNode,
} from './spec.js';

// ---------------------------------------------------------------------------
// input — the authoring schema, and the only shape a model's output is measured
// against
// ---------------------------------------------------------------------------
export {
  PANEL_INPUT_MAX_NODE_COUNT,
  authoredSummaryProseSchema,
  authoredSummaryStatementSchema,
  dataQueryInputSchema,
  panelNodeInputSchema,
  panelSpecInputSchema,
  parsePanelSpecInput,
} from './input.js';
export type {
  AuthoredSummaryProse,
  AuthoredSummaryStatement,
  ComponentTreeNodeInput,
  DataQueryInput,
  DependencyGraphNodeInput,
  EventLogNodeInput,
  FlameNodeInput,
  LayoutNodeInput,
  MetricCardsNodeInput,
  PanelNodeInput,
  PanelNodeInputBase,
  PanelSpecInput,
  PanelSummaryInput,
  QueryBackedNodeInput,
  QueryTableNodeInput,
  RenderTableNodeInput,
  RequestTableNodeInput,
  SectionNodeInput,
  SourceLinkNodeInput,
  SplitNodeInput,
  StackNodeInput,
  StateTransitionsNodeInput,
  TableNodeInput,
  TimelineNodeInput,
  VisualizationNodeInput,
  WaterfallNodeInput,
} from './input.js';

// ---------------------------------------------------------------------------
// catalog — the single node registry: the validator reads it, the renderer's
// component registry is keyed by it, and the prompt is rendered from it
// ---------------------------------------------------------------------------
export {
  DEFAULT_CATALOG_PROMPT_BULLET,
  PANEL_NODE_CATALOG,
  PANEL_NODE_CATALOG_ENTRIES,
  PANEL_NODE_CATALOG_KINDS,
  catalogEntryFor,
  describeCatalogForPrompt,
  isKnownPanelNodeType,
  isSourceAllowedForNode,
} from './catalog.js';
export type {
  DescribeCatalogOptions,
  PanelNodeCatalogEntry,
  PanelNodeCatalogKind,
} from './catalog.js';

// ---------------------------------------------------------------------------
// normalize — step 2: authored form in, internal document out, deterministically
// ---------------------------------------------------------------------------
export { normalizePanel } from './normalize.js';
export type { NormalizeAnalysis, NormalizeContext } from './normalize.js';

// ---------------------------------------------------------------------------
// validate — step 3a: the internal syntactic and structural gate
// ---------------------------------------------------------------------------
export {
  PANEL_MAX_NODE_DEPTH,
  PANEL_VALIDATION_ISSUE_CODES,
  assertValidPanelSpec,
  collectPanelSpecIssues,
  isPanelValidationIssueCode,
  validatePanelSpec,
} from './validate.js';
export type { PanelValidationIssue, PanelValidationIssueCode } from './validate.js';

// ---------------------------------------------------------------------------
// semantic — step 3b: the gate against the capture the panel claims to describe
// ---------------------------------------------------------------------------
export {
  SEMANTIC_ISSUE_CODES,
  SEMANTIC_ISSUE_CODE_BY_REASON,
  SEMANTIC_ISSUE_REASONS,
  SEMANTIC_ISSUE_SEVERITIES,
  SEMANTIC_ISSUE_SEVERITY_BY_REASON,
  SEMANTIC_VALIDATION_STATUSES,
  collectSemanticIssues,
  isSemanticIssueReason,
  tallyFieldPresence,
  toResult,
  validateAgainstCapture,
} from './semantic.js';
export type {
  CaptureFieldPresence,
  EventIdResolver,
  IdResolution,
  KindFieldPresence,
  SemanticIssue,
  SemanticIssueReason,
  SemanticIssueSets,
  SemanticIssueSeverity,
  SemanticResultOptions,
  SemanticValidationInvalid,
  SemanticValidationOptions,
  SemanticValidationOutcome,
  SemanticValidationStatus,
  SemanticValidationUnverifiable,
  SemanticValidationValid,
  TraceIdResolver,
} from './semantic.js';

// ---------------------------------------------------------------------------
// json-schema — the authoring schema as JSON Schema, for the generation prompt
// ---------------------------------------------------------------------------
export {
  PANEL_SPEC_INPUT_JSON_SCHEMA_ID,
  PANEL_SPEC_INPUT_SCHEMA_TARGET,
  PANEL_SPEC_INPUT_SCHEMA_TARGETS,
  panelSpecInputJsonSchema,
  panelSpecInputJsonSchemaText,
} from './json-schema.js';
export type { PanelSpecInputJsonSchemaOptions, PanelSpecInputSchemaTarget } from './json-schema.js';
