/**
 * Syntactic validation of an internal, normalized panel specification: the
 * checks the schema itself cannot state.
 *
 * ## Where this sits
 *
 * A generated panel reaches the screen through a fixed sequence, and nothing
 * skips a step (AAP 0.2.3, AAP 0.5.3):
 *
 * 1. a model's structured output is parsed against the **authoring** schema in
 *    `./input.ts`, with a bounded repair loop on failure;
 * 2. the parsed authoring form is converted by the **deterministic** normaliser
 *    in `./normalize.ts`, which lifts the flat query fields into each node's
 *    `query`, derives every node id from its position in the layout, and copies
 *    observed facts and likely causes only from the validated analysis;
 * 3. **this module** validates the result *syntactically* — the shape, through
 *    `./spec.ts`'s schema, and then the whole-document rules below;
 * 4. `./semantic.ts` validates it *against the capture*, which is the only
 *    layer that can decide whether the evidence a panel cites exists.
 *
 * What this module adds to step 3 is everything a per-field schema cannot see:
 * a rule about a node's type *and* its query together, a rule about two nodes
 * in different subtrees, a rule about two fields of the document. It is also
 * the checkpoint the product's renderer contract names — "a node type with no
 * component is a validation failure raised by `packages/panel-schema/src/validate.ts`
 * before rendering, never a blank area" (AAP 0.6.2) — so a catalogued vocabulary
 * that has drifted from the registry the renderer is keyed by fails here, in one
 * place, rather than as an empty region on a developer's screen.
 *
 * ## What a failure here means
 *
 * **A rejection from this module is a product bug, not a model mistake.** The
 * model's output was already accepted by the authoring schema one step earlier;
 * whatever reaches here came out of the deterministic normaliser. AAP 0.5.3 is
 * explicit about the consequence: "a normalisation or internal-validation
 * failure is treated as a rejection too (it is a product bug, logged with the
 * input, never retried against the model)". So the caller —
 * `apps/local-service/src/panels/validate.ts` — must **not** re-prompt. It logs
 * the failure and falls back to the deterministic panel assembled from the
 * capture's aggregates, which carries `meta.fallback = true` and which the
 * renderer draws under a visible "fallback view" banner (AAP 0.5.5). A failure
 * is never presented as a successful analysis, and it is never presented as the
 * developer's fault.
 *
 * That is why the primary entry point returns a `Result` rather than throwing:
 * the outcome of a rejected panel is a defined product behaviour, not an aborted
 * pipeline stage. {@link assertValidPanelSpec} exists for the other kind of call
 * site — internal code that holds a specification it built itself and for which
 * invalidity is a defect to crash on rather than a state to render.
 *
 * ## Privacy: failures carry shape, never content
 *
 * A panel specification is model-authored prose *about* captured runtime data:
 * titles, statements, redacted URLs and trace identifiers. An error raised here
 * is logged, may be persisted with the session, and travels to both user
 * interfaces through the protocol's `error` payload — passing through neither
 * the redaction layer nor the outbound model guard on the way. Every message and
 * every detail this module builds is therefore assembled from **issue paths and
 * closed issue codes only** (AAP 0.5.2). No rejected value enters one: not a
 * node's `title`, not a `filter.traceId`, not a `Fact.statement`, not even the
 * unrecognised node-type string that caused a rejection. The one value-like
 * field an issue may carry is `nodeType`, and it is only ever a member of the
 * catalogued vocabulary — never the offending string itself.
 *
 * The shape of a reported issue is `./summary.ts`'s {@link SchemaIssueSummary},
 * extended with that node type, and the schema half of the check delegates to
 * `parsePanelSpec`, which applies that module's `describeIssues`. One privacy
 * rule, expressed once, covers both halves of every failure this module returns.
 *
 * ## Environment-neutral
 *
 * Pure data and pure functions. No platform builtin, no browser global, no
 * import-time side effect: the coordination service validates generated panels
 * in a Node process, and the DevTools panel and the editor webview validate
 * stored ones in a page.
 *
 * @example
 * ```ts
 * const validated = validatePanelSpec(await readStoredPanel(panelRowId));
 *
 * if (!validated.ok) {
 *   log.warn({ err: validated.error.toPayload(), ...validated.error.details }, 'panel rejected');
 *   return fallbackPanelFor(capture);
 * }
 *
 * return validated.value;
 * ```
 */

import { DebuggenError, assertNever, err, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { METRIC_IDS, isMetricId } from '@debuggen/telemetry';

import {
  PANEL_NODE_CATALOG_ENTRIES,
  catalogEntryFor,
  isKnownPanelNodeType,
  isSourceAllowedForNode,
} from './catalog.js';
import { isDataQuerySource } from './nodes/query.js';
import type { DataQuery } from './nodes/query.js';
import type { MetricCardsNode, QueryBackedNode } from './nodes/viz.js';
import {
  PANEL_CHILDREN_FIELD,
  PANEL_LAYOUT_FIELD,
  parsePanelSpec,
  walkPanelNodes,
} from './spec.js';
import type { PanelNode, PanelNodePath, PanelNodeType, PanelSpec } from './spec.js';
import type { Fact, PanelSummary, SchemaIssueSummary } from './summary.js';

/*
 * ---------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------
 */

/**
 * Deepest node nesting a specification may declare: **8** levels, counting a
 * top-level node as level 1.
 *
 * The containers bound their own breadth — `./nodes/layout.ts` caps any one
 * container at 64 children and `./spec.ts` caps the layout array itself — but
 * neither of those node schemas can see how deep the tree they are part of
 * goes, because a schema only ever looks at one node. This layer sees a whole
 * internal document, so the depth bound is stated here and checked here for
 * every specification, however it was produced.
 *
 * It is also enforced one step earlier, **by construction**: `./input.ts`
 * builds the authoring schema as an unrolled chain of exactly this many node
 * levels, the deepest of which accepts no container, and its
 * `parsePanelSpecInput` reports `panel_node_depth_exceeded` — this module's
 * code, at this module's path convention — for an authored document that goes
 * deeper. Both read this one constant, so an authored panel that parses can
 * never be rejected here for its depth, and parsing an authored document costs
 * a bounded number of levels whatever its nesting.
 *
 * Eight is generous against any panel a developer can read: the deepest
 * arrangement the product's own panels reach is a section holding a split
 * holding a stack holding a view, which is four. It is a bound against a
 * pathological document rather than a stylistic limit, and the thing it protects
 * is the renderer: `walkPanelNodes` is iterative and completes on any tree, but
 * the React component tree that draws one is genuinely recursive, so a document
 * nested thousands deep would exhaust a stack in the surface that renders it
 * rather than in the layer that validates it.
 *
 * Exported so that the authoring schema, a deterministic panel assembler, a test
 * fixture and this validator agree on the number instead of each choosing one.
 * It must stay a whole number of at least 2: a container needs a level below it
 * for its children, and `./input.ts` refuses to build its chain otherwise.
 */
export const PANEL_MAX_NODE_DEPTH = 8;

/**
 * How many issues a rejection names in its `message`: **5**.
 *
 * The message line is read in a log and in two user interfaces, so it stays one
 * sentence long; the complete list always travels in the error's `details`, so
 * nothing is lost by truncating here. See {@link collectPanelSpecIssues} for why
 * every issue is collected in the first place.
 */
const MAX_REPORTED_ISSUES = 5;

/**
 * How a path with no segments is rendered in a message.
 *
 * Every issue this module raises names a field, so an empty path does not occur
 * in practice; the label exists so that rendering one could never produce a
 * message with a hole in it.
 */
const ROOT_PATH_LABEL = '(panel)';

/** The separator joining path segments, matching `./summary.ts`'s dotted form. */
const PATH_SEPARATOR = '.';

/*
 * Field names, typed against the shapes they belong to.
 *
 * Each constant below is annotated with `keyof` the interface that declares the
 * field, which is what stops an issue path from naming a field that no longer
 * exists: renaming `supersedes` in `./spec.ts` or `evidence` in `./summary.ts`
 * fails to compile here rather than producing paths that point at nothing. The
 * children key is not restated at all — `./spec.ts` exports it for exactly this
 * purpose, and the traversal builds its paths from the same constant.
 */

/** The panel's own identity, which a `supersedes` reference is compared with. */
const ID_FIELD: keyof PanelSpec = 'id';

/** The version field a `supersedes` reference is checked against. */
const PANEL_VERSION_FIELD: keyof PanelSpec = 'panelVersion';

/** The superseded-panel reference, as it appears in a path. */
const SUPERSEDES_FIELD: keyof PanelSpec = 'supersedes';

/** The summary field, as it appears in a path. */
const SUMMARY_FIELD: keyof PanelSpec = 'summary';

/** The observed-facts list within a summary. */
const OBSERVED_FIELD: keyof PanelSummary = 'observed';

/** The likely-causes list within a summary. */
const LIKELY_CAUSES_FIELD: keyof PanelSummary = 'likelyCauses';

/** The citations of one fact or hypothesis. */
const EVIDENCE_FIELD: keyof Fact = 'evidence';

/** A node's discriminator, read before anything else about the node is. */
const NODE_TYPE_FIELD: keyof PanelNode = 'type';

/** A node's identity, as it appears in a path. */
const NODE_ID_FIELD: keyof PanelNode = 'id';

/** A node's data request, as it appears in a path. */
const NODE_QUERY_FIELD: keyof QueryBackedNode = 'query';

/** The source within a data request. */
const QUERY_SOURCE_FIELD: keyof DataQuery = 'source';

/** The metric-tile node's own option, which is never part of its query. */
const METRICS_FIELD: keyof MetricCardsNode = 'metrics';

/*
 * ---------------------------------------------------------------------------
 * The issue vocabulary
 *
 * Closed, frozen and exported, for the same reason the shared package's error
 * codes are: a code is read by the service that logs a rejection and by the
 * tests that assert one, and a code invented at a call site is a code nobody can
 * switch on. These are *validation issue* codes rather than product error codes
 * — the whole list is reported inside one `DebuggenError`, whose `code` comes
 * from the shared package's closed set (see {@link validatePanelSpec}).
 *
 * Snake case, matching the issue codes the schema library reports, because both
 * kinds of code appear in the same `issues` array of the same `details` object
 * and a reader should not have to know which half produced which.
 * ---------------------------------------------------------------------------
 */

/**
 * Every way a well-formed panel document can still be invalid, as a closed
 * readonly tuple.
 *
 * Grouped in the order the checks run: the node-level rules the node catalog
 * states, then the whole-tree rules, then the document-level ones.
 */
export const PANEL_VALIDATION_ISSUE_CODES = Object.freeze([
  // Node level: the catalog's rules about one node.
  'panel_node_type_unknown',
  'panel_node_query_missing',
  'panel_node_query_forbidden',
  'panel_node_query_source_missing',
  'panel_node_query_source_unknown',
  'panel_node_query_source_not_allowed',
  'panel_node_metrics_missing',
  'panel_node_metrics_empty',
  'panel_node_metric_unknown',
  'panel_node_children_forbidden',
  'panel_node_children_missing',
  'panel_node_children_empty',

  // Whole tree: rules that need more than one node to state.
  'panel_node_depth_exceeded',
  'panel_node_id_duplicate',

  // Document level: rules about the specification's own fields.
  'panel_supersedes_self',
  'panel_supersedes_on_first_version',
  'panel_fact_evidence_empty',
] as const);

/**
 * One member of {@link PANEL_VALIDATION_ISSUE_CODES}.
 *
 * Derived from the tuple, so the runtime vocabulary and the static type cannot
 * disagree.
 */
export type PanelValidationIssueCode = (typeof PANEL_VALIDATION_ISSUE_CODES)[number];

/** Widened view of the tuple, used by {@link isPanelValidationIssueCode}. */
const ISSUE_CODE_VALUES: readonly string[] = PANEL_VALIDATION_ISSUE_CODES;

/**
 * Whether a value is one of this module's issue codes.
 *
 * For the places that classify a code without a schema at hand: a stored
 * rejection read back out of a session row, a detail object arriving over the
 * transport, a test narrowing a code before switching on it. The schema
 * library's own codes are deliberately **not** members, so this predicate is
 * also how a reader tells the two halves of an `issues` array apart.
 *
 * @param value Any value believed to name a panel validation issue.
 * @returns `true` when `value` is a member of the closed vocabulary.
 */
export function isPanelValidationIssueCode(value: unknown): value is PanelValidationIssueCode {
  return typeof value === 'string' && ISSUE_CODE_VALUES.includes(value);
}

/**
 * The code raised for a node this module cannot classify.
 *
 * Named as a constant rather than written at each of its call sites because both
 * of them report the *same* condition about different evidence — a node position
 * holding something that is not an object at all, and a node whose declared type
 * the catalog does not carry — and a reader of a rejection must not have to
 * discover that from two spellings.
 */
const UNKNOWN_NODE_TYPE_CODE: PanelValidationIssueCode = 'panel_node_type_unknown';

/*
 * ---------------------------------------------------------------------------
 * The issue
 * ---------------------------------------------------------------------------
 */

/**
 * One thing wrong with an otherwise well-formed panel specification, reduced to
 * its **structure**.
 *
 * Three fields, and deliberately no fourth: there is no `value`, no `message`
 * and no `expected`, because a panel's content must not be recoverable from a
 * report about it (AAP 0.5.2, and this module's documentation above).
 */
export interface PanelValidationIssue {
  /**
   * Where the problem is, as the sequence of property keys and array indices
   * that reaches it.
   *
   * The same {@link PanelNodePath} form the traversal in `./spec.ts` reports and
   * the normaliser derives node ids from, extended with the offending field:
   * `['layout', 0, 'query', 'source']`, `['layout', 1, 'children']`,
   * `['summary', 'observed', 2, 'evidence']`. Joined with `.` it is the dotted
   * path the schema library's own issues use, which is what lets both kinds
   * share one `issues` array.
   */
  readonly path: PanelNodePath;

  /**
   * What is wrong, as a code.
   *
   * Always a member of {@link PANEL_VALIDATION_ISSUE_CODES}; typed as `string`
   * so that a consumer reading a rejection back out of a log or a stored row
   * does not have to prove membership before it can hold the value, and so that
   * this interface stays usable when the vocabulary grows. Narrow it with
   * {@link isPanelValidationIssueCode} where the distinction matters.
   */
  readonly code: string;

  /**
   * The catalogued type of the node the issue is about, where it is about a
   * node.
   *
   * Absent for a document-level issue, and absent for a node whose type is not
   * in the catalog at all — the unrecognised string is a rejected *value* and
   * never enters a report. Present values are members of the closed node-type
   * vocabulary, which is why this field is safe to log and to show.
   */
  readonly nodeType?: PanelNodeType;
}

/*
 * ---------------------------------------------------------------------------
 * Internal helpers
 *
 * Two of them exist because this module cannot trust the static type of what it
 * is given. {@link collectPanelSpecIssues} accepts a {@link PanelSpec}, but a
 * caller may hold one that was asserted rather than parsed — a row read out of a
 * JSON column, a fixture built by hand, a payload cast on arrival — and the
 * checks below are precisely the ones that are meaningless if a field's presence
 * is taken on trust. So every field an issue is *about* is read as `unknown`
 * through {@link ownField} and classified at runtime, which is also what lets
 * this module promise never to throw.
 * ---------------------------------------------------------------------------
 */

/**
 * Builds one issue.
 *
 * The `code` parameter is typed to the closed vocabulary even though
 * {@link PanelValidationIssue.code} is a `string`, so every issue this module
 * raises is checked against {@link PANEL_VALIDATION_ISSUE_CODES} at compile
 * time and a typo cannot become a code nobody can switch on.
 *
 * The node type is attached only when there is one, rather than set to
 * `undefined`: the package compiles under `exactOptionalPropertyTypes`, and an
 * absent key is also what a JSON round-trip of a stored rejection preserves.
 *
 * @param code What is wrong.
 * @param path Where it is wrong; see {@link PanelValidationIssue.path}.
 * @param nodeType The catalogued type of the node concerned, when the issue is
 * about a node whose type the catalog knows.
 * @returns The issue, frozen only by its `readonly` declaration — it is built
 * once and pushed onto a list that is never mutated afterwards.
 */
function issueAt(
  code: PanelValidationIssueCode,
  path: PanelNodePath,
  nodeType?: PanelNodeType,
): PanelValidationIssue {
  return nodeType === undefined ? { path, code } : { path, code, nodeType };
}

/**
 * Whether a value is an array, narrowing to an array of `unknown`.
 *
 * A type predicate rather than a bare `Array.isArray` call, for a concrete
 * reason: `Array.isArray` narrows an `unknown` to `any[]`, and every element
 * read from it would then be an `any` flowing into a typed parameter — which is
 * both unsafe and a lint failure. Narrowing to `readonly unknown[]` keeps each
 * element `unknown`, so the guards that classify it (`isMetricId`,
 * {@link ownField}) do the narrowing instead.
 *
 * @param value Any value.
 * @returns `true` when `value` is an array.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Reads one **own** property of an object as an untyped value.
 *
 * Own rather than inherited, so nothing reaches a check through
 * `Object.prototype` — a specification that arrived as JSON can carry a
 * `"constructor"` or `"toString"` key, and a prototype hit would let a node look
 * as though it carried a `query` it never declared.
 *
 * The double assertion is what the read costs: an interface without an index
 * signature is not assignable to a record type, so widening has to go through
 * `unknown`. Nothing is written, and the value comes back `unknown` for the
 * caller to classify.
 *
 * @param value The object to read from.
 * @param key The property name.
 * @returns The value of that own property, or `undefined` when the object does
 * not declare it.
 */
function ownField(value: object, key: string): unknown {
  const record = value as unknown as Record<string, unknown>;

  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * How deeply nested the node at `path` is, counting a top-level node as 1.
 *
 * Derived from the path rather than tracked during the walk, because `./spec.ts`
 * owns the traversal and exports {@link PANEL_CHILDREN_FIELD} for exactly this:
 * a path descends into a container by appending that key and then an index, so
 * the number of such keys is the number of containers above the node. The
 * arithmetic therefore holds for any base path the traversal was given, which a
 * count of segments would not.
 *
 * @param path The path of the node, as reported by the traversal.
 * @returns The node's level, at least 1.
 */
function nodeDepth(path: PanelNodePath): number {
  let depth = 1;

  for (const segment of path) {
    if (segment === PANEL_CHILDREN_FIELD) {
      depth += 1;
    }
  }

  return depth;
}

/**
 * Joins a path into the dotted form the schema library's own issues use, so
 * both halves of a reported `issues` array read the same way.
 *
 * Returns the empty string for an empty path, exactly as `./summary.ts`'s
 * `describeIssues` does for an issue about the document itself.
 *
 * @param path The path to render.
 * @returns The dotted path, for instance `layout.0.query.source`.
 */
function joinPath(path: PanelNodePath): string {
  return path.map((segment) => String(segment)).join(PATH_SEPARATOR);
}

/*
 * ---------------------------------------------------------------------------
 * Per-node checks
 *
 * Each function below answers one question about one node, takes the node's
 * catalogued type as an argument rather than re-deriving it, and returns the
 * issues it found. None of them throws, and none of them reads a value it then
 * reports.
 * ---------------------------------------------------------------------------
 */

/**
 * Checks a node's data request against what its type is allowed to ask for.
 *
 * Four rules, in the order a reader of the catalog would apply them:
 *
 * - a node whose entry sets `requiresQuery: false` — the three containers and
 *   the source-link leaf — must carry **no** query. The node schemas in
 *   `./nodes/*` are strict, so a parsed document cannot carry one; this catches
 *   the document that was never parsed, and it is the rule that stops a
 *   source-link chip from being half-described as a data view;
 * - a node whose entry sets `requiresQuery: true` must carry a query object.
 *   This is the case the normaliser can produce: a query-backed node whose
 *   source went missing while the flat authoring fields were being lifted;
 * - the query must name a source from the closed vocabulary `./nodes/query.ts`
 *   owns;
 * - and that source must be one **this node type** can read. This is the check
 *   that matters most in practice: a table pointed at a source whose prepared
 *   result its component cannot consume parses perfectly and renders nothing, so
 *   the catalog's per-type source list is enforced here rather than left as
 *   advice in a prompt.
 *
 * @param node The node to check.
 * @param path The node's path.
 * @param type The node's catalogued type.
 * @returns At most one issue: the rules are ordered from structural to specific,
 * and reporting "the source is not allowed" for a query that is missing
 * altogether would describe a problem the document does not have.
 */
function collectQueryIssues(
  node: PanelNode,
  path: PanelNodePath,
  type: PanelNodeType,
): PanelValidationIssue[] {
  const entry = catalogEntryFor(type);
  const queryPath: PanelNodePath = [...path, NODE_QUERY_FIELD];
  const query = ownField(node, NODE_QUERY_FIELD);

  if (!entry.requiresQuery) {
    return query === undefined ? [] : [issueAt('panel_node_query_forbidden', queryPath, type)];
  }

  if (typeof query !== 'object' || query === null) {
    return [issueAt('panel_node_query_missing', queryPath, type)];
  }

  const sourcePath: PanelNodePath = [...queryPath, QUERY_SOURCE_FIELD];
  const source = ownField(query, QUERY_SOURCE_FIELD);

  if (source === undefined) {
    return [issueAt('panel_node_query_source_missing', sourcePath, type)];
  }

  if (!isDataQuerySource(source)) {
    return [issueAt('panel_node_query_source_unknown', sourcePath, type)];
  }

  if (!isSourceAllowedForNode(type, source)) {
    return [issueAt('panel_node_query_source_not_allowed', sourcePath, type)];
  }

  return [];
}

/**
 * Checks a node's children against whether its type has any.
 *
 * A node type whose entry sets `supportsChildren: false` must carry no
 * `children` key at all — a leaf with children is a subtree the renderer would
 * never draw, because its component takes no children and would not look for
 * them. A container, conversely, must carry a non-empty array: all three
 * containers require at least one child (a split requires two), so an empty one
 * is a heading with nothing under it rather than a legitimate empty state. The
 * exact minimum per container belongs to the schema in `./nodes/layout.ts`,
 * which enforces it on every parsed document; this layer states the part that is
 * true of all three.
 *
 * @param node The node to check.
 * @param path The node's path.
 * @param type The node's catalogued type.
 * @returns At most one issue.
 */
function collectChildrenIssues(
  node: PanelNode,
  path: PanelNodePath,
  type: PanelNodeType,
): PanelValidationIssue[] {
  const entry = catalogEntryFor(type);
  const childrenPath: PanelNodePath = [...path, PANEL_CHILDREN_FIELD];
  const children = ownField(node, PANEL_CHILDREN_FIELD);

  if (!entry.supportsChildren) {
    return children === undefined
      ? []
      : [issueAt('panel_node_children_forbidden', childrenPath, type)];
  }

  if (!isUnknownArray(children)) {
    return [issueAt('panel_node_children_missing', childrenPath, type)];
  }

  return children.length === 0 ? [issueAt('panel_node_children_empty', childrenPath, type)] : [];
}

/**
 * Checks the metric ids a metric-tile node asks for.
 *
 * The ids are the telemetry package's fixed computed set, and they are checked
 * with that package's own {@link isMetricId} rather than against a list spelled
 * out here: `packages/telemetry` owns the vocabulary and pins its order in its
 * own test, so a renamed id fails there first and the rename reaches this check
 * without an edit. A second list here would be the drift both modules exist to
 * prevent.
 *
 * **An empty list is invalid.** A tile row with no tiles renders as an empty
 * band — a panel claiming to present the capture's headline numbers and
 * presenting none — which is the outcome this whole module exists to prevent. It
 * is also unreachable through the schema, which requires at least one id, so an
 * empty array means the document was assembled by something that never parsed
 * it.
 *
 * Every offending id is reported, by index, rather than only the first: a
 * deterministic assembler that emitted two stale ids should learn about both in
 * one pass.
 *
 * @param node The metric-tile node.
 * @param path The node's path.
 * @returns One issue for the list itself, or one per unrecognised id.
 */
function collectMetricIssues(node: MetricCardsNode, path: PanelNodePath): PanelValidationIssue[] {
  const metricsPath: PanelNodePath = [...path, METRICS_FIELD];
  const metrics = ownField(node, METRICS_FIELD);

  if (!isUnknownArray(metrics)) {
    return [issueAt('panel_node_metrics_missing', metricsPath, node.type)];
  }

  if (metrics.length === 0) {
    return [issueAt('panel_node_metrics_empty', metricsPath, node.type)];
  }

  const issues: PanelValidationIssue[] = [];

  for (const [index, candidate] of metrics.entries()) {
    if (!isMetricId(candidate)) {
      issues.push(issueAt('panel_node_metric_unknown', [...metricsPath, index], node.type));
    }
  }

  return issues;
}

/**
 * Checks the option fields a node type carries beyond its query.
 *
 * The one exhaustive switch in this module, and the reason it ends in
 * `assertNever`: because the parameter of that call is typed `never`, a node
 * type added to `./nodes/viz.ts` or `./nodes/layout.ts` without a decision here
 * stops compiling, and the error points at this function rather than surfacing
 * as an option nobody validates. Every one of the sixteen types is named
 * explicitly rather than covered by a `default`, so a type that *gains* an
 * option is a compile error too.
 *
 * Only the metric-tile node has anything to check today, which is why the other
 * fifteen share one branch: the containers' arrangement options and the
 * source-link leaf's location are closed shapes their own schemas validate
 * completely, a container's children are checked separately by
 * {@link collectChildrenIssues}, and the remaining leaves carry no option at all
 * beyond the query and two labels their schemas fully describe. The branch is
 * written as one unbroken run of `case` clauses deliberately: a comment or a
 * blank line between them would make each an empty case that falls through to
 * the next, which the lint gate reports rather than reads as grouping.
 *
 * The `default` branch is unreachable at runtime, not merely unexpected:
 * {@link collectNodeIssues} establishes that the node's type is in the catalog
 * before calling this, and returns early when it is not. It exists as a
 * compile-time device.
 *
 * @param node The node to check, whose type the caller has already established
 * is catalogued.
 * @param path The node's path.
 * @returns The issues found among this node type's own options.
 */
function collectNodeOptionIssues(node: PanelNode, path: PanelNodePath): PanelValidationIssue[] {
  switch (node.type) {
    case 'metricCards':
      return collectMetricIssues(node, path);
    case 'section':
    case 'split':
    case 'stack':
    case 'timeline':
    case 'waterfall':
    case 'eventLog':
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
 * Collects every issue about one node.
 *
 * The order of the checks is the order of the rules' dependencies rather than a
 * preference: the node's type decides which catalog entry applies, so it is
 * established first, and when it cannot be — the node names a type the catalog
 * does not carry — the per-type checks are skipped rather than guessed at. The
 * type-independent checks still run, because "this node is too deep" and "this
 * id is used twice" are true regardless of what the node claims to be.
 *
 * ## Why the catalog-membership check is not redundant
 *
 * `panelSpecSchema`'s discriminated union already rejects a node whose `type` is
 * not one of the sixteen, so on the path through {@link validatePanelSpec} this
 * check cannot fire for that reason. It guards the **other** drift direction: a
 * node type present in the union but never added to
 * `PANEL_NODE_CATALOG` — and therefore absent from the registry the renderer's
 * node dispatch is keyed by, which is exactly the "blank area" the product
 * contract forbids (AAP 0.6.2). `catalog.ts`'s own test asserts the same
 * invariant statically; this is its runtime half, and it also covers the
 * unparsed document, where an arbitrary string can genuinely arrive.
 *
 * @param node The node to check.
 * @param path The node's path, as reported by the traversal.
 * @param seenIds Ids already used elsewhere in the tree. **Mutated**: the id of
 * this node is added, so the caller's set accumulates across the walk and the
 * *second* occurrence of a repeated id is the one reported.
 * @returns Every issue found about this node, in check order — or the single
 * unrecognised-node issue when what arrived in a node position is not an object
 * at all.
 */
function collectNodeIssues(
  node: PanelNode,
  path: PanelNodePath,
  seenIds: Set<string>,
): PanelValidationIssue[] {
  const candidate: unknown = node;

  // A primitive or a `null` where a node should be carries no type, no id and no
  // query, so it is reported as an unrecognised node and nothing is read off it:
  // `Object.hasOwn` throws on `null`, and a report is the last place that may
  // raise an exception of its own.
  if (typeof candidate !== 'object' || candidate === null) {
    return [issueAt(UNKNOWN_NODE_TYPE_CODE, path)];
  }

  const issues: PanelValidationIssue[] = [];
  const declaredType = ownField(node, NODE_TYPE_FIELD);
  let nodeType: PanelNodeType | undefined;

  if (isKnownPanelNodeType(declaredType)) {
    nodeType = declaredType;
  } else {
    // The offending string is deliberately not reported: it is a rejected value
    // (AAP 0.5.2), and the path already identifies which node is at fault.
    issues.push(issueAt(UNKNOWN_NODE_TYPE_CODE, path));
  }

  if (nodeDepth(path) > PANEL_MAX_NODE_DEPTH) {
    issues.push(issueAt('panel_node_depth_exceeded', path, nodeType));
  }

  const declaredId = ownField(node, NODE_ID_FIELD);

  if (typeof declaredId === 'string') {
    if (seenIds.has(declaredId)) {
      issues.push(issueAt('panel_node_id_duplicate', [...path, NODE_ID_FIELD], nodeType));
    } else {
      seenIds.add(declaredId);
    }
  }

  // A node whose type is not catalogued has no entry to check against, and
  // guessing one would report rules the node was never subject to. Returning
  // here is also what keeps `collectNodeOptionIssues`'s exhaustive switch
  // unreachable at runtime for an unrecognised type.
  if (nodeType === undefined) {
    return issues;
  }

  issues.push(...collectQueryIssues(node, path, nodeType));
  issues.push(...collectChildrenIssues(node, path, nodeType));
  issues.push(...collectNodeOptionIssues(node, path));

  return issues;
}

/*
 * ---------------------------------------------------------------------------
 * Document-level checks
 *
 * The rules that need two fields of the specification at once, which is why
 * `./spec.ts` deliberately left them off its schema: a cross-field refinement
 * disappears from any JSON Schema rendered from that shape, and the prompt the
 * panel-generation stage sends is built from exactly that rendering.
 * ---------------------------------------------------------------------------
 */

/**
 * Checks the two invariants of a panel's version bookkeeping.
 *
 * A regeneration stores a **new** document — `panelVersion` incremented,
 * `supersedes` naming the panel it replaces — rather than editing the old one,
 * so:
 *
 * - a panel cannot supersede itself. Such a document is a cycle of one: a reader
 *   following the chain backwards never terminates, and a user interface showing
 *   "replaces …" would point at the panel it is already displaying;
 * - a panel that supersedes another cannot be the session's first. A
 *   `supersedes` on version 1 means either the reference or the version is
 *   wrong, and both readings are bookkeeping this layer must not resolve
 *   silently.
 *
 * Reported at the field whose value is wrong under each reading: the reference
 * for the self-reference, the version for the first-version case.
 *
 * @param spec The specification to check.
 * @returns At most two issues; none when the panel supersedes nothing.
 */
function collectSupersedesIssues(spec: PanelSpec): PanelValidationIssue[] {
  const supersedes = ownField(spec, SUPERSEDES_FIELD);

  if (supersedes === undefined) {
    return [];
  }

  const issues: PanelValidationIssue[] = [];

  if (supersedes === ownField(spec, ID_FIELD)) {
    issues.push(issueAt('panel_supersedes_self', [SUPERSEDES_FIELD]));
  }

  const panelVersion = ownField(spec, PANEL_VERSION_FIELD);

  if (typeof panelVersion !== 'number' || panelVersion <= 1) {
    issues.push(issueAt('panel_supersedes_on_first_version', [PANEL_VERSION_FIELD]));
  }

  return issues;
}

/**
 * Checks that every statement in one of a summary's two lists cites something.
 *
 * Belt and braces, and named as such: `./summary.ts` bounds `Fact.evidence`
 * below by one, so a *parsed* summary cannot hold an uncited statement — that is
 * the mechanical expression of the product's evidence boundary (AAP 0.2.3), and
 * it is enforced one layer down. What this check adds is the same guarantee for
 * a document that reached a consumer without being parsed, because an uncited
 * statement is the one defect that would put an unevidenced assertion under the
 * "Observed" heading of a panel, which is the failure mode the whole
 * fact/hypothesis split exists to prevent (AAP 0.8.4).
 *
 * What it deliberately does **not** check is whether the cited events exist in
 * the capture. That needs the capture, and it belongs to `./semantic.ts`, which
 * reports it under its own error code.
 *
 * @param statements The list to check, read as `unknown` because a document that
 * was never parsed may not hold an array here at all. A non-array is left to the
 * schema rather than reported twice.
 * @param basePath The path of the list within the document.
 * @returns One issue per statement whose citations are missing or empty.
 */
function collectEvidenceIssues(
  statements: unknown,
  basePath: PanelNodePath,
): PanelValidationIssue[] {
  if (!isUnknownArray(statements)) {
    return [];
  }

  const issues: PanelValidationIssue[] = [];

  for (const [index, statement] of statements.entries()) {
    if (typeof statement !== 'object' || statement === null) {
      // Not a statement at all: its shape is the schema's business, and
      // reporting "no evidence" about it would describe the wrong problem.
      continue;
    }

    const evidence = ownField(statement, EVIDENCE_FIELD);

    if (!isUnknownArray(evidence) || evidence.length === 0) {
      issues.push(issueAt('panel_fact_evidence_empty', [...basePath, index, EVIDENCE_FIELD]));
    }
  }

  return issues;
}

/**
 * Checks both lists of a panel's summary.
 *
 * The observed facts and the likely causes are checked identically and reported
 * under their own paths, because the two lists are the same shape plus a
 * confidence and must not diverge in what they guarantee: a hypothesis is
 * allowed to be wrong, but it is not allowed to be about nothing.
 *
 * @param summary The summary to check, read as `unknown` for the reason
 * {@link collectEvidenceIssues} is.
 * @returns Every uncited-statement issue in either list, observed first.
 */
function collectSummaryIssues(summary: unknown): PanelValidationIssue[] {
  if (typeof summary !== 'object' || summary === null) {
    return [];
  }

  return [
    ...collectEvidenceIssues(ownField(summary, OBSERVED_FIELD), [SUMMARY_FIELD, OBSERVED_FIELD]),
    ...collectEvidenceIssues(ownField(summary, LIKELY_CAUSES_FIELD), [
      SUMMARY_FIELD,
      LIKELY_CAUSES_FIELD,
    ]),
  ];
}

/*
 * ---------------------------------------------------------------------------
 * The public checks
 * ---------------------------------------------------------------------------
 */

/**
 * Collects **every** rule this module states that `spec` breaks.
 *
 * Exported so that a caller can report all of a document's problems at once
 * rather than the first one. That is not a convenience: a rejection here means
 * the panel pipeline produced a defective document (see this module's
 * documentation), and the developer diagnosing that pipeline needs the whole
 * list — a validator that stops at the first issue turns one investigation into
 * as many rounds as there are defects.
 *
 * The rules, in the order they are reported, which is the document's own reading
 * order:
 *
 * 1. version bookkeeping — `supersedes` neither names this panel nor appears on
 *    a first version;
 * 2. the summary — every observed fact and every likely cause cites something;
 * 3. every node of the layout, depth first in document order — its type is
 *    catalogued, it is not nested deeper than {@link PANEL_MAX_NODE_DEPTH}, its
 *    id is unique across the whole tree, its query is present or absent as its
 *    type requires and names a source that type can read, its children match
 *    whether its type has any, and its own options are valid.
 *
 * **Never throws**, including on a value that was asserted rather than parsed —
 * which matters because this runs on a reporting path, where an exception
 * replaces the failure being reported with a crash in the reporter. Every field
 * a rule depends on is read at runtime rather than trusted, a node type the
 * catalog does not know ends that node's per-type checks instead of reaching a
 * lookup, a `layout` that is not an array is left entirely to the schema that
 * owns the field's shape, and the node shapes the shared traversal itself
 * cannot walk past — a node type outside the node union, a container whose
 * children are not an array — are handled where they are caught below, each
 * after the node at fault has been reported.
 *
 * **Reports shape, never content.** Each issue carries a path, a code from
 * {@link PANEL_VALIDATION_ISSUE_CODES} and, where the issue is about a
 * catalogued node, that node's type. Nothing else — see AAP 0.5.2 and this
 * module's documentation for why that rule has no exceptions here.
 *
 * @param spec The normalized specification to check. Pass one that has already
 * passed `panelSpecSchema`; {@link validatePanelSpec} is the entry point that
 * guarantees it.
 * @returns Every issue found, in reporting order. Empty means the specification
 * is syntactically valid, and `./semantic.ts` is the next and last step.
 */
export function collectPanelSpecIssues(spec: PanelSpec): readonly PanelValidationIssue[] {
  const document: unknown = spec;

  // Not a document at all. Like a `layout` that is not an array, this is the
  // schema's rejection rather than one of this module's rules, so nothing is
  // reported and — crucially on a reporting path — nothing is read off it.
  // `validatePanelSpec` parses before it calls this, so the case arises only
  // where a caller passed a value its own type contract already forbade.
  if (typeof document !== 'object' || document === null) {
    return [];
  }

  const issues: PanelValidationIssue[] = [
    ...collectSupersedesIssues(spec),
    ...collectSummaryIssues(ownField(spec, SUMMARY_FIELD)),
  ];

  const layout = ownField(spec, PANEL_LAYOUT_FIELD);

  if (!isUnknownArray(layout)) {
    return issues;
  }

  // Ids accumulate across the whole tree rather than per container: an id is a
  // list key, a selection target and a document fragment, so two nodes in
  // different subtrees sharing one is the same defect as two siblings sharing
  // one. The traversal is `./spec.ts`'s, so the paths reported here are the very
  // paths the normaliser derives its ids from.
  const seenIds = new Set<string>();

  try {
    walkPanelNodes(spec.layout, (node, path) => {
      issues.push(...collectNodeIssues(node, path, seenIds));
    });
  } catch (cause) {
    // `./spec.ts`'s traversal reaches a node's children through a switch that
    // ends in `assertNever` and then reads `length` off what that switch
    // returned. Both steps hold for any document that passed `panelSpecSchema`,
    // and both can fail for one a caller *asserted* rather than parsed — the
    // case this function documents itself as safe for:
    //
    // - a node whose `type` is outside the node *union* reaches `assertNever`,
    //   which throws;
    // - a container whose `children` is not an array — absent, `null`, an
    //   object — is returned as it stands and the length read throws a
    //   `TypeError`.
    //
    // In both, the node at fault has already been reported by the visitor, as
    // `panel_node_type_unknown` or as `panel_node_children_missing`, because the
    // visitor runs before the children lookup. The document is therefore
    // rejected either way; what the walk cannot do is carry on past that node,
    // so the nodes after it go unreported and the issue list is the prefix up to
    // the node at fault.
    //
    // A throw with **nothing** reported is explained by no rule here, so it is a
    // defect in this module and is re-raised: swallowing it would hide a bug
    // inside the very function whose job is to report one. Keeping the reported
    // issues in that decision — rather than testing for one specific code — is
    // what makes the non-throwing promise hold for every malformed node shape an
    // unparsed document can carry, instead of for one of them.
    if (issues.length === 0) {
      throw cause;
    }
  }

  return issues;
}

/** The name this module reports for the schema a rejection was measured against. */
const PANEL_SPEC_SCHEMA_NAME = 'panelSpec';

/**
 * The check this module reports as, distinguishing its rejections from the
 * schema's inside one `details` object.
 */
const INVARIANT_CHECK_NAME = 'invariants';

/** How a closed vocabulary is written in a hint and as an issue's `expected`. */
const VOCABULARY_SEPARATOR = ' | ';

/**
 * The catalogued node types, in the vocabulary's order, as one line.
 *
 * Read from the catalog's ordered entry list rather than from `./spec.ts`'s
 * vocabulary, because "catalogued" is what {@link isKnownPanelNodeType} checks
 * and therefore what a `panel_node_type_unknown` issue means. A closed
 * vocabulary, never a rejected value, so it is safe in every message, hint and
 * detail this module builds.
 */
const CATALOGUED_NODE_TYPES = PANEL_NODE_CATALOG_ENTRIES.map((entry) => entry.type).join(
  VOCABULARY_SEPARATOR,
);

/**
 * The developer-facing recovery instruction attached to a rejection.
 *
 * States the rules rather than the values that broke them, and says plainly what
 * a failure here means — a defect in panel generation, answered with the
 * deterministic fallback panel rather than with another attempt at the model
 * (AAP 0.5.3, AAP 0.5.5). The node types and the metric count are derived from
 * the catalog and the telemetry package's vocabulary so the sentence cannot go
 * stale.
 */
const PANEL_INVARIANT_HINT = `Every node must be a catalogued type (${CATALOGUED_NODE_TYPES}); a query-backed node must name a source its type can read, and a container or source link must carry none; only containers carry children, and every node id is unique; metric ids come from the fixed set of ${String(METRIC_IDS.length)}; and a panel that supersedes another is at least version 2. A failure here is a defect in panel generation rather than an unanswerable question: show the deterministic fallback panel for this capture, and use the issue paths in this error's details to locate the nodes at fault.`;

/**
 * One reported issue as it appears in an error's `details`.
 *
 * `./summary.ts`'s {@link SchemaIssueSummary} — the shape the schema library's
 * own issues are reduced to — plus the catalogued node type where there is one,
 * so a reader of a rejection meets one issue shape whichever half of the check
 * produced it. Internal: the type a caller reads back out of `details` is
 * whatever its own logger or store gave it, and
 * {@link PanelValidationIssue} is the typed form this module offers.
 *
 * `expected` carries, for the node-vocabulary codes, the closed vocabulary the
 * node would have been accepted with — see {@link expectedVocabularyFor}.
 */
interface PanelIssueDetail extends SchemaIssueSummary {
  /** The catalogued type of the node concerned, where the issue is about one. */
  readonly nodeType?: PanelNodeType;
}

/**
 * The closed vocabulary a node-vocabulary issue would have been satisfied by,
 * as one line, or `undefined` for every other issue.
 *
 * - `panel_node_type_unknown` — the catalogued node types;
 * - the query and source codes — the sources the node's catalogued type can
 *   read, from its catalog entry.
 *
 * Both are closed vocabularies owned by the catalog and never the rejected
 * value (AAP 0.5.2), which is what makes them safe to log and to show; they are
 * what turns "this node is wrong" into "this node is wrong, and this is what
 * would be right".
 *
 * @param code The issue's code.
 * @param nodeType The node's catalogued type, where it has one.
 * @returns The vocabulary, or `undefined`.
 */
function expectedVocabularyFor(
  code: string,
  nodeType: PanelNodeType | undefined,
): string | undefined {
  if (code === UNKNOWN_NODE_TYPE_CODE) {
    return CATALOGUED_NODE_TYPES;
  }

  if (nodeType !== undefined && QUERY_SOURCE_ISSUE_CODES.has(code)) {
    return catalogEntryFor(nodeType).sources.join(VOCABULARY_SEPARATOR);
  }

  return undefined;
}

/**
 * The codes whose expected vocabulary is the node type's sources: a query that
 * is missing, and a source that is missing, unknown or not readable by the
 * type. Not `panel_node_query_forbidden`, whose node type reads no source.
 */
const QUERY_SOURCE_ISSUE_CODES: ReadonlySet<string> = new Set<PanelValidationIssueCode>([
  'panel_node_query_missing',
  'panel_node_query_source_missing',
  'panel_node_query_source_unknown',
  'panel_node_query_source_not_allowed',
]);

/**
 * Renders issues for an error's `details`: dotted paths, codes, node types and,
 * for the node-vocabulary codes, the vocabulary that would have been accepted.
 *
 * @param issues The issues to render.
 * @returns One detail per issue, in the order they were reported.
 */
function describeIssuesForDetails(
  issues: readonly PanelValidationIssue[],
): readonly PanelIssueDetail[] {
  return issues.map((issue) => {
    const expected = expectedVocabularyFor(issue.code, issue.nodeType);

    return {
      path: joinPath(issue.path),
      code: issue.code,
      ...(expected === undefined ? {} : { expected }),
      ...(issue.nodeType === undefined ? {} : { nodeType: issue.nodeType }),
    };
  });
}

/**
 * Renders the first few issues for an error's `message`.
 *
 * Bounded by {@link MAX_REPORTED_ISSUES} with a count of the remainder, because
 * the message is one line in a log and in two user interfaces while the complete
 * list travels in `details`. Reads the rendered details, so the invariant
 * rejection and the classified schema rejection list their issues alike.
 *
 * @param issues The issues to summarise, with dotted paths; never empty when
 * this is called.
 * @returns A comma-separated list of `path (code)` pairs, with a tail naming how
 * many were omitted.
 */
function renderIssueList(issues: readonly SchemaIssueSummary[]): string {
  const rendered = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const joined = issue.path;

    return `${joined.length === 0 ? ROOT_PATH_LABEL : joined} (${issue.code})`;
  });

  const omitted = issues.length - rendered.length;
  const listed = rendered.join(', ');

  return omitted > 0 ? `${listed} and ${String(omitted)} more` : listed;
}

/**
 * Builds the rejection for a well-formed document that breaks this module's
 * rules.
 *
 * The code is `'PANEL_INVALID'`: `@debuggen/shared`'s `errors.ts` owns a closed
 * code vocabulary and a new code is never invented here; of the codes it offers,
 * this is the panel-validation one, and it is the same code the package's other
 * panel parsers report, so a caller handles a schema failure and an invariant
 * failure through one branch — both mean "this panel cannot be shown, use the
 * fallback". Deliberately **not** `'PANEL_SEMANTIC_INVALID'`, which
 * `./semantic.ts` uses for a specification that is well-formed but cites
 * evidence the capture does not hold, and deliberately not
 * `'MODEL_OUTPUT_INVALID'`, which would misattribute a product defect to the
 * model: a stage boundary that wants that vocabulary maps this one with the
 * shared `mapErr`.
 *
 * The complete issue list goes in `details`, which `toPayload` does not forward,
 * and a bounded path-and-code summary goes in `message`, which it does.
 *
 * @param issues Every issue found; never empty.
 * @returns The error to return or throw.
 */
function invariantRejection(issues: readonly PanelValidationIssue[]): DebuggenError {
  const checks = issues.length === 1 ? 'check' : 'checks';
  const details = describeIssuesForDetails(issues);

  return new DebuggenError(
    'PANEL_INVALID',
    `A panel specification failed ${String(issues.length)} validation ${checks}: ${renderIssueList(details)}.`,
    {
      hint: PANEL_INVARIANT_HINT,
      details: {
        schema: PANEL_SPEC_SCHEMA_NAME,
        check: INVARIANT_CHECK_NAME,
        issueCount: issues.length,
        issues: details,
      },
    },
  );
}

/*
 * ---------------------------------------------------------------------------
 * The node vocabulary of a schema rejection
 *
 * `panelSpecSchema` rejects the node-vocabulary faults of a document that was
 * asserted rather than parsed — a node type outside the vocabulary, a
 * query-backed node with no query, a query with no source or with a value
 * that is no source — before this module's rules ever see it, and it reports
 * them in the schema library's own terms: `invalid_union` on the node's
 * `type`, `invalid_type` on its `query`, `invalid_value` on `query.source`.
 * Those say nothing about the rule broken, and they are exactly the faults
 * this module has catalog codes for. So the rejection `validatePanelSpec`
 * returns for a failed parse reports each such issue with the code
 * {@link collectPanelSpecIssues} would have reported for the same node — at
 * the schema's own path, which already names the field at fault — and with
 * the vocabulary that would have been accepted. Every other issue is reported
 * exactly as the schema reported it.
 *
 * Classifying reads the document at the issue's path, through
 * {@link ownField}, as every other rule here does. It never reports a value:
 * the codes are this module's, the vocabularies are the catalog's.
 * ---------------------------------------------------------------------------
 */

/**
 * The sentence a classified schema rejection adds to the schema's own hint:
 * the node vocabulary the classified issues were measured against.
 */
const PANEL_NODE_VOCABULARY_HINT = `A node's type is one of the catalogued types (${CATALOGUED_NODE_TYPES}), and every node type that reads captured data carries a query naming a source its type can read.`;

/**
 * Splits a dotted schema-issue path into the node it is about and the node
 * field that follows, or answers `undefined` for a path that is not a node's
 * `type`, `query` or `query.source`.
 *
 * A node path is `layout` and an index, then a `children` segment and an index
 * per container below it — the traversal's own path convention — and array
 * indices arrive as their decimal spelling, since the path was joined.
 *
 * @param path A dotted path, as `describeIssues` renders it.
 * @returns The node's path as segments, and the field, or `undefined`.
 */
function locateNodeField(
  path: string,
): { readonly node: readonly string[]; readonly field: string } | undefined {
  const segments = path.split(PATH_SEPARATOR);
  const isIndex = (segment: string | undefined): boolean =>
    segment !== undefined && /^(?:0|[1-9][0-9]*)$/.test(segment);

  if (segments[0] !== PANEL_LAYOUT_FIELD || !isIndex(segments[1])) {
    return undefined;
  }

  let end = 2;

  while (segments[end] === PANEL_CHILDREN_FIELD && isIndex(segments[end + 1])) {
    end += 2;
  }

  const field = segments.slice(end).join(PATH_SEPARATOR);
  const nodeFields: readonly string[] = [
    NODE_TYPE_FIELD,
    NODE_QUERY_FIELD,
    `${NODE_QUERY_FIELD}${PATH_SEPARATOR}${QUERY_SOURCE_FIELD}`,
  ];

  return nodeFields.includes(field) ? { node: segments.slice(0, end), field } : undefined;
}

/**
 * Reads the value at a path of own properties, or `undefined` where the path
 * leaves the document.
 *
 * @param root The document.
 * @param path The keys to follow; array indices in their decimal spelling.
 * @returns The value there, or `undefined`.
 */
function ownFieldAt(root: unknown, path: readonly string[]): unknown {
  let current = root;

  for (const segment of path) {
    current =
      typeof current === 'object' && current !== null ? ownField(current, segment) : undefined;
  }

  return current;
}

/**
 * The catalog code one schema issue is reported with, or `undefined` to report
 * it as the schema did.
 *
 * - `invalid_union` on a node's `type`, when the declared type is not
 *   catalogued → `panel_node_type_unknown`;
 * - `invalid_type` on a query-backed node's `query`, when that is not an
 *   object → `panel_node_query_missing`;
 * - `invalid_value` on a query-backed node's `query.source` →
 *   `panel_node_query_source_missing` when there is no source, and
 *   `panel_node_query_source_unknown` when the value is not a member of the
 *   closed source vocabulary.
 *
 * The same decisions {@link collectNodeIssues} and {@link collectQueryIssues}
 * make, read off the same fields.
 *
 * @param root The document that failed to parse.
 * @param issue One issue of its rejection.
 * @returns The classified issue, or `undefined`.
 */
function catalogIssueForSchemaIssue(
  root: unknown,
  issue: SchemaIssueSummary,
): PanelIssueDetail | undefined {
  const located = locateNodeField(issue.path);

  if (located === undefined) {
    return undefined;
  }

  const node = ownFieldAt(root, located.node);

  if (typeof node !== 'object' || node === null) {
    return undefined;
  }

  const declaredType = ownField(node, NODE_TYPE_FIELD);

  if (located.field === NODE_TYPE_FIELD) {
    return issue.code === 'invalid_union' && !isKnownPanelNodeType(declaredType)
      ? { path: issue.path, code: UNKNOWN_NODE_TYPE_CODE, expected: CATALOGUED_NODE_TYPES }
      : undefined;
  }

  if (!isKnownPanelNodeType(declaredType) || !catalogEntryFor(declaredType).requiresQuery) {
    return undefined;
  }

  const query = ownField(node, NODE_QUERY_FIELD);
  let code: PanelValidationIssueCode | undefined;

  if (located.field === NODE_QUERY_FIELD) {
    code =
      issue.code === 'invalid_type' && (typeof query !== 'object' || query === null)
        ? 'panel_node_query_missing'
        : undefined;
  } else if (issue.code === 'invalid_value' && typeof query === 'object' && query !== null) {
    const source = ownField(query, QUERY_SOURCE_FIELD);

    if (source === undefined) {
      code = 'panel_node_query_source_missing';
    } else if (!isDataQuerySource(source)) {
      code = 'panel_node_query_source_unknown';
    }
  }

  if (code === undefined) {
    return undefined;
  }

  const expected = expectedVocabularyFor(code, declaredType);

  return {
    path: issue.path,
    code,
    ...(expected === undefined ? {} : { expected }),
    nodeType: declaredType,
  };
}

/**
 * Whether a value is one reported schema issue: an object with a string `path`
 * and a string `code`, as `describeIssues` builds them.
 *
 * @param value An entry of a rejection's `details.issues`.
 * @returns `true` when it has that shape.
 */
function isSchemaIssueSummary(value: unknown): value is SchemaIssueSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof ownField(value, 'path') === 'string' &&
    typeof ownField(value, 'code') === 'string'
  );
}

/**
 * Re-reports the schema's rejection of a document with the node-vocabulary
 * issues classified (see this section's heading).
 *
 * When no issue is classified the schema's rejection is returned as it stands,
 * the same object. Otherwise a new `PANEL_INVALID` error keeps the schema's
 * name and every issue in order — classified ones replaced in place — names
 * the first few by path and code in its message, and adds the catalogued node
 * types to the schema's hint.
 *
 * Classification only ever *reads* the document, through own-property access,
 * and a document hostile enough to throw while being read keeps the schema's
 * rejection unchanged: this is a reporting path, and it must not replace the
 * failure it reports with one of its own.
 *
 * @param value The document that failed to parse.
 * @param rejection The schema's rejection of it.
 * @returns The rejection to report.
 */
function classifySchemaRejection(value: unknown, rejection: DebuggenError): DebuggenError {
  const reported = rejection.details?.['issues'];

  if (!isUnknownArray(reported) || !reported.every(isSchemaIssueSummary)) {
    return rejection;
  }

  let issues: readonly SchemaIssueSummary[];

  try {
    issues = reported.map((issue) => catalogIssueForSchemaIssue(value, issue) ?? issue);
  } catch {
    // Deliberately unbound: the exception came from reading a caller's value
    // and describes nothing this module reports (see above).
    return rejection;
  }

  if (issues.every((issue, index) => issue === reported[index])) {
    return rejection;
  }

  return new DebuggenError(
    'PANEL_INVALID',
    `A value did not match the ${PANEL_SPEC_SCHEMA_NAME} schema: ${renderIssueList(issues)}.`,
    {
      hint: `${rejection.hint ?? ''} ${PANEL_NODE_VOCABULARY_HINT}`.trim(),
      details: { ...rejection.details, issues },
    },
  );
}

/**
 * Validates an unknown value as a normalized {@link PanelSpec}, without
 * throwing: the entry point of step 3 of the panel pipeline.
 *
 * Composed of two halves, in this order:
 *
 * 1. the **shape**, through `./spec.ts`'s `parsePanelSpec`, which parses
 *    `panelSpecSchema` and — on failure — builds the rejection through
 *    `./summary.ts`'s `describeIssues`. Delegating rather than re-running
 *    `safeParse` here is what keeps one implementation of that rejection, its
 *    hint and its privacy rule in the package. A node-vocabulary fault the
 *    schema rejects first — an uncatalogued node type, a query-backed node
 *    without a query or a source — is then reported with this module's catalog
 *    code rather than the schema library's (see {@link classifySchemaRejection});
 * 2. the **rules**, through {@link collectPanelSpecIssues}, reported as one
 *    error carrying every issue found.
 *
 * Accepts `unknown` because this is a real parse boundary rather than a
 * formality: a specification arrives from the normaliser, from a JSON column
 * when a session is reopened, from a transport frame a browser process sent, or
 * from a fixture. None of those is trusted, and the value that comes back is the
 * *parsed* document — the one the store, the transport and the renderer may use.
 *
 * Non-throwing is a requirement rather than a preference. A rejected panel has a
 * defined outcome: the service logs the failure and shows the deterministic
 * fallback panel under a visible banner (AAP 0.5.5), and a reader that cannot
 * parse a stored row reports that one panel as unavailable. Neither outcome is
 * "abort the stage", so the caller inspects the result and continues. Use
 * {@link assertValidPanelSpec} for an internal call site where invalidity is a
 * defect rather than a state to render.
 *
 * @param value Any value believed to be a normalized panel specification.
 * @returns `ok(spec)` with the parsed document, or `err(error)` describing every
 * issue by path and code only.
 */
export function validatePanelSpec(value: unknown): Result<PanelSpec, DebuggenError> {
  const parsed = parsePanelSpec(value);

  if (!parsed.ok) {
    return err(classifySchemaRejection(value, parsed.error));
  }

  const issues = collectPanelSpecIssues(parsed.value);

  return issues.length === 0 ? ok(parsed.value) : err(invariantRejection(issues));
}

/**
 * Validates an unknown value as a normalized {@link PanelSpec}, throwing on
 * failure.
 *
 * For the call sites that treat an invalid specification as a bug in their own
 * code rather than as a state to present: a deterministic assembler checking the
 * panel it just built, a test fixture, a migration reading documents it wrote
 * itself. Such a caller has nothing to render a rejection as, and continuing
 * past one would move the failure to whatever draws the document later, with the
 * cause a long way behind it. `@debuggen/shared`'s assertion module draws the
 * same line: a throwing assertion reports a programmer error, while a `Result`
 * reports an expected, developer-facing failure a user interface renders.
 *
 * {@link validatePanelSpec} stays the primary entry point, and the service's
 * panel path uses it: the error thrown here is the very error that function
 * returns, so nothing is gained by catching this instead of inspecting that.
 *
 * @param value Any value believed to be a normalized panel specification.
 * @returns The parsed specification.
 * @throws A `DebuggenError` with code `'PANEL_INVALID'`, carrying every issue by
 * path and code in its `details`.
 */
export function assertValidPanelSpec(value: unknown): PanelSpec {
  const validated = validatePanelSpec(value);

  if (!validated.ok) {
    throw validated.error;
  }

  return validated.value;
}
