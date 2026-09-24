/**
 * The deterministic normaliser: the authored form of a panel in, the internal
 * form out, with nothing added that the capture did not establish.
 *
 * Panel generation is three fixed steps, and this module is the middle one
 * (AAP 0.5.3):
 *
 * 1. `./input.ts` parses whatever the model produced against the **authoring**
 *    schema — a forgiving shape in which a node's data request may be written
 *    flat on the node, ids and versions are absent because they are not the
 *    author's to mint, and the summary is prose.
 * 2. **this module** turns that value into the internal {@link PanelSpec}:
 *    every node acquires an id derived from its position, every query-backed
 *    node acquires a single `query` object, the document acquires its version
 *    and identifiers from the caller's context, and the summary acquires its
 *    observed facts and likely causes **from the validated analysis** rather
 *    than from anything the author wrote.
 * 3. `./validate.ts` parses the result against the internal schema, and
 *    `./semantic.ts` checks it against the capture it claims to describe.
 *
 * Only step 1 involves a model. This module is a pure function of its three
 * arguments: no clock, no random id, no I/O, no environment lookup, no mutation
 * of anything it is given. Two calls with equal arguments produce equal output,
 * which is what lets `./normalize.test.ts` assert an exact expected object.
 *
 * ## The integrity boundary
 *
 * A panel keeps what was *observed* during a capture apart from what is merely
 * *inferred* from it, and both halves cite the evidence behind them. Neither
 * half can be authored: {@link normalizePanel} copies `observed` and
 * `likelyCauses` from its `analysis` argument and from nowhere else, and reads
 * the authored summary for **prose only** — a single line for the top of the
 * panel. The authoring schema has no evidence, confidence or event-id field to
 * begin with, and the one function here that touches an authored summary
 * returns `string | undefined`, so it is not merely forbidden but *impossible*
 * for an authored statement to become a {@link Fact}. Unrelated event ids
 * supplied in an authored summary therefore cannot substantiate anything: the
 * prose is prose, and the evidence is only ever the analysis's.
 *
 * ## Structural, never interpretive
 *
 * Nothing here branches on what was asked or on what a panel is called. There
 * is no question text in scope, no title comparison, no keyword list and no
 * pre-authored panel: the transformation is driven entirely by the node type
 * vocabulary and by `./catalog.ts` (AAP 0.5.4). A node type gains an implicit
 * data source by having a `defaultSource` in the catalog, not by being named in
 * a branch here, which is why this module holds no per-node-type special case
 * at all.
 *
 * ## Totality
 *
 * For an input that has already passed `parsePanelSpecInput`, normalisation
 * does not throw. Two `throw`s are reachable from here, both `DebuggenError`
 * with code `INTERNAL`, and both for states a parsed input cannot hold: the
 * exhaustiveness guard on the node switch, which fires for a node type the
 * vocabulary does not contain, and the cycle guard of the layout walk, which
 * fires for a node found inside its own subtree (a parse always yields a fresh
 * tree). Either is a product bug in whatever assembled the input. Depth is not
 * a third: the layout is walked with an explicit stack rather than by
 * recursion, so a hand-assembled layout of any depth normalizes instead of
 * overflowing the call stack. The return type is therefore {@link PanelSpec}
 * and not a `Result`: AAP 0.5.3 records that a normalisation failure "is a
 * product bug, logged with the input, never retried against the model", and a
 * `Result` here would invite the caller to report a bug of ours as a validation
 * failure of the model's.
 *
 * Normalisation is not a second validator, either. Where the authored value is
 * incomplete in a way the authoring schema chose not to reject — a query-backed
 * node with no source at all — this module emits the node without a query and
 * lets step 3 report it. One validation checkpoint, one error message, at the
 * place the pipeline already looks for one.
 *
 * Environment-neutral, like every module in this package: no `node:` builtin,
 * no DOM global, no side effect at load.
 *
 * @example
 * ```ts
 * const parsed = parsePanelSpecInput(modelOutput);
 *
 * if (parsed.ok) {
 *   const spec = normalizePanel(parsed.value, analysis, {
 *     id: newPanelId(),
 *     sessionId: session.id,
 *     panelVersion: previous === undefined ? 1 : previous.panelVersion + 1,
 *     ...(previous === undefined ? {} : { supersedes: previous.id }),
 *   });
 *
 *   const validated = parsePanelSpec(spec);
 * }
 * ```
 */

import { DebuggenError, assertNever } from '@debuggen/shared';
import type { PanelId, SessionId } from '@debuggen/shared';

import { PANEL_NODE_CATALOG } from './catalog.js';
import type {
  DataQueryInput,
  PanelNodeInput,
  PanelSpecInput,
  PanelSummaryInput,
  QueryBackedNodeInput,
} from './input.js';
import { PANEL_NODE_ID_MAX_LENGTH } from './nodes/query.js';
import type {
  DataQuery,
  DataQueryFilter,
  DataQueryFlatFieldKey,
  PanelNodeId,
} from './nodes/query.js';
import type { MetricCardsNode, QueryBackedNode, SourceLinkNode } from './nodes/viz.js';
import {
  PANEL_CHILDREN_FIELD,
  PANEL_LAYOUT_FIELD,
  PANEL_LAYOUT_PATH_ROOT,
  PANEL_SPEC_VERSION,
} from './spec.js';
import type {
  PanelNode,
  PanelSectionNode,
  PanelSpec,
  PanelSplitNode,
  PanelStackNode,
} from './spec.js';
import { MAX_HEADLINE_LENGTH } from './summary.js';
import type { Fact, Hypothesis, PanelSummary } from './summary.js';

/*
 * ---------------------------------------------------------------------------
 * The two parameter types
 * ---------------------------------------------------------------------------
 */

/**
 * The validated analysis, as much of it as normalisation reads.
 *
 * **Why this is a local interface and not an import.** The analysis of a
 * capture is `AnalysisResult`, and that type lives in `@debuggen/protocol`,
 * which sits *above* this package in the acyclic package graph of AAP 0.2.2:
 * `protocol` composes **this package's** {@link Fact} and {@link Hypothesis}
 * into its analysis and message types, so an import in the other direction
 * would close a cycle. The root `eslint.config.js` enforces that edge, and
 * `tsc -b` would refuse the project reference as well.
 *
 * Declaring the two lists structurally costs nothing and keeps the dependency
 * pointing one way: `AnalysisResult` satisfies this interface without knowing
 * it exists, and every other field of an analysis — its id, its metrics, the
 * capture it was computed from — is deliberately out of scope here, because a
 * panel's summary is exactly these two lists.
 *
 * A future reader who "fixes" this by importing `AnalysisResult` reintroduces
 * the cycle. It is not an oversight; it is the direction of the graph.
 */
export interface NormalizeAnalysis {
  /**
   * What the capture showed, each statement carrying the evidence that
   * substantiates it. Copied into `summary.observed` verbatim.
   */
  readonly observed: readonly Fact[];

  /**
   * What may explain it, each with a confidence level and, where one resolved,
   * a suggested source location. Copied into `summary.likelyCauses` verbatim.
   */
  readonly likelyCauses: readonly Hypothesis[];
}

/**
 * The identifiers and provenance a panel document carries, supplied by the
 * caller because none of them is derivable from the authored value.
 *
 * Every field is consumed as given. In particular `id` is **minted by the
 * caller** — with `newPanelId()` from `@debuggen/shared`, ordinarily — rather
 * than here: an id generated inside normalisation would make the function
 * non-deterministic, and its determinism is what the test suite and the
 * follow-up flow (which stores a regenerated panel as the next version of the
 * same session) both rely on.
 *
 * The values are not re-validated here. `./validate.ts` parses the finished
 * document against the internal schema, so a caller that supplies a blank id or
 * a `panelVersion` below 1 is told so at that one checkpoint rather than by two
 * different mechanisms.
 */
export interface NormalizeContext {
  /** This panel's own id. */
  readonly id: PanelId;

  /** The session this panel was generated for. */
  readonly sessionId: SessionId;

  /**
   * Which generation of this session's panel this is, counting from 1. A
   * follow-up stores its answer as the next version rather than replacing the
   * previous one.
   */
  readonly panelVersion: number;

  /** The id of the panel this one replaces, on a regeneration. */
  readonly supersedes?: PanelId;

  /**
   * True when the caller assembled this panel deterministically from the
   * capture because a generated one could not be validated. It becomes
   * `meta.fallback`, which the renderer shows under a visible banner instead of
   * presenting the panel as an answer (AAP 0.5.5). Anything other than `true`
   * leaves `meta` off the document entirely.
   */
  readonly fallback?: boolean;
}

/*
 * ---------------------------------------------------------------------------
 * Node identity
 *
 * A node's id is its position in the document. That choice has a purpose
 * beyond brevity: `walkPanelNodes` in `./spec.ts` reports a node's path with
 * the same vocabulary, so a validation issue at `layout.0.children.1` and the
 * id the renderer uses as that node's React key are the same coordinates, and
 * an error message can be followed to a node without a lookup table.
 * ---------------------------------------------------------------------------
 */

/** How the segments of a node path are joined into an id. */
const NODE_ID_SEPARATOR = '.';

/**
 * The prefix of the bounded fallback id described on {@link createNodeIdMinter}.
 *
 * Built from the layout field name so the fallback shares the derived form's
 * root, and deliberately containing a segment no path can produce: a path
 * alternates numeric indices with the literal `children`, so nothing derived
 * from a position can collide with `layout.node-…`.
 */
const NODE_ID_ORDINAL_PREFIX = `${PANEL_LAYOUT_FIELD}${NODE_ID_SEPARATOR}node-`;

/**
 * The joined root every derived id starts from: the layout field, `layout`.
 *
 * Joined once from {@link PANEL_LAYOUT_PATH_ROOT}, the walker's own root, so an
 * id and a reported path cannot disagree about how a position is spelled.
 */
const NODE_ID_ROOT = PANEL_LAYOUT_PATH_ROOT.join(NODE_ID_SEPARATOR);

/**
 * Mints the id of one node, called once per node in depth-first pre-order.
 *
 * Given the node's derived id — its path joined with `.` — when that fits
 * {@link PANEL_NODE_ID_MAX_LENGTH}, or `undefined` when it does not.
 */
type NodeIdMinter = (derived: string | undefined) => PanelNodeId;

/**
 * Create the id minter for one normalisation.
 *
 * The id of a node is its path joined with `.` — `layout.0` for the first
 * top-level node, `layout.0.children.1` for the second child of that node —
 * which is stable, human-readable and identical to the path the walker reports.
 *
 * A path only fails to serve when its rendering exceeds
 * {@link PANEL_NODE_ID_MAX_LENGTH}, which takes a layout nested some eighteen
 * containers deep. A parsed document never gets there — the authoring schema
 * bounds nesting at the validator's `PANEL_MAX_NODE_DEPTH`, well short of it —
 * but `normalizePanel` also accepts a hand-assembled input, which is bounded by
 * nothing, and an id too long for the internal schema would make step 3 fail
 * on a document this module produced. Such a node takes `layout.node-<n>`
 * instead, where `n` counts the nodes visited before it in depth-first
 * pre-order. That form is bounded, unique within the document, and — because
 * the counter advances for every node whether or not it is used — as
 * deterministic as the paths it stands in for.
 *
 * The minter is handed the derived id rather than the path so that minting
 * costs the same at any depth: {@link derivedIdAt} builds each id from its
 * parent's, and stops building once one no longer fits, so a node ten thousand
 * levels down is not given a path ten thousand levels long to join.
 */
function createNodeIdMinter(): NodeIdMinter {
  let ordinal = 0;

  return (derived: string | undefined): PanelNodeId => {
    const id = derived ?? `${NODE_ID_ORDINAL_PREFIX}${String(ordinal)}`;

    ordinal += 1;

    return id;
  };
}

/**
 * The derived id of the node at `index` under `base`, or `undefined` when it
 * would exceed {@link PANEL_NODE_ID_MAX_LENGTH}.
 *
 * Exactly the rule of joining the node's whole path with `.` and checking its
 * length, computed incrementally: `base` is the joined path of the array the
 * node sits in (`layout`, or a container's id plus `.children`), and an
 * `undefined` base stays `undefined`, because a path that already did not fit
 * only grows as it descends.
 *
 * @param base The joined path of the containing array, or `undefined` when an
 * ancestor's path already exceeded the bound.
 * @param index The node's index in that array.
 * @returns The joined path when it fits, otherwise `undefined`.
 */
function derivedIdAt(base: string | undefined, index: number): string | undefined {
  if (base === undefined) {
    return undefined;
  }

  const derived = `${base}${NODE_ID_SEPARATOR}${String(index)}`;

  return derived.length <= PANEL_NODE_ID_MAX_LENGTH ? derived : undefined;
}

/**
 * The joined path of a container's `children` array — the base its children's
 * ids are derived under — or `undefined` when the container's own id is not a
 * derived one.
 *
 * @param derived The container's derived id, if it had one.
 * @returns The base for {@link derivedIdAt}.
 */
function childrenIdBase(derived: string | undefined): string | undefined {
  return derived === undefined
    ? undefined
    : `${derived}${NODE_ID_SEPARATOR}${PANEL_CHILDREN_FIELD}`;
}

/*
 * ---------------------------------------------------------------------------
 * Query lifting
 *
 * The authoring schema accepts a node's data request in either of two
 * spellings — five fields written flat on the node, or the same five inside a
 * `query` object — and states the precedence between them: the object wins for
 * the fields it names, and the fields written on the node fill the rest. The
 * internal schema has one spelling. These four functions are the whole of the
 * translation.
 * ---------------------------------------------------------------------------
 */

/**
 * Resolve one field under the documented precedence.
 *
 * `declared` is the value from the nested `query` object, `fallback` the value
 * written flat on the node. A field counts as *declared* when it holds a
 * defined value, so an explicit `undefined` — which a hand-built input can
 * carry and which Zod preserves as a present key — is treated as absent rather
 * than as an instruction to blank the flat value out.
 *
 * The check is presence, never truthiness: `limit: 0` and `minDuration: 0` are
 * meaningful requests and must survive.
 */
function preferDeclared<TValue>(
  declared: TValue | undefined,
  fallback: TValue | undefined,
): TValue | undefined {
  return declared === undefined ? fallback : declared;
}

/**
 * Merge the two spellings of a filter **per key** rather than by replacement.
 *
 * Replacing the whole object would make the two spellings interfere: a node
 * that narrows to one interaction flat and adds a duration floor inside its
 * query object means both narrowings, and a merge that dropped one of them
 * would silently widen or narrow the view the author asked for. Each key is
 * therefore resolved on its own with {@link preferDeclared}.
 *
 * A merge that would carry no narrowing at all — because neither spelling named
 * a single field — yields `undefined` instead of an empty object, so a stored
 * panel never holds a `filter: {}` that means exactly what its absence means.
 */
function mergeFilters(
  declared: DataQueryFilter | undefined,
  fallback: DataQueryFilter | undefined,
): DataQueryFilter | undefined {
  if (declared === undefined && fallback === undefined) {
    return undefined;
  }

  /*
   * `satisfies Record<keyof DataQueryFilter, unknown>` is an exhaustiveness
   * guard, not decoration: a filter field added to `./nodes/query.ts` and not
   * resolved here fails this line at compile time instead of being dropped at
   * runtime.
   */
  const resolved = {
    traceId: preferDeclared(declared?.traceId, fallback?.traceId),
    kinds: preferDeclared(declared?.kinds, fallback?.kinds),
    component: preferDeclared(declared?.component, fallback?.component),
    tier: preferDeclared(declared?.tier, fallback?.tier),
    minDuration: preferDeclared(declared?.minDuration, fallback?.minDuration),
  } satisfies Record<keyof DataQueryFilter, unknown>;

  // Written key by key, in the schema's own field order, so the stored JSON of
  // two equal filters is byte-identical however the author spelled them.
  const merged: DataQueryFilter = {
    ...(resolved.traceId === undefined ? {} : { traceId: resolved.traceId }),
    ...(resolved.kinds === undefined ? {} : { kinds: [...resolved.kinds] }),
    ...(resolved.component === undefined ? {} : { component: resolved.component }),
    ...(resolved.tier === undefined ? {} : { tier: resolved.tier }),
    ...(resolved.minDuration === undefined ? {} : { minDuration: resolved.minDuration }),
  };

  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * Lift a query-backed node's data request into the one internal `query` object.
 *
 * The source is resolved from the two authored spellings and then, when neither
 * named one, from the node type's `defaultSource` in `PANEL_NODE_CATALOG`. That
 * catalog lookup is the whole of the "a metric-tile node has an implicit
 * source" rule: the implicit `{ source: 'metrics' }` is catalog **data**, so
 * this function carries no branch on `metricCards` — nor on any other node type
 * — and gains none when a second type acquires a default.
 *
 * Whether the resolved source is one this node type can actually read is not
 * decided here. `./catalog.ts` states each type's readable sources and
 * `./validate.ts` checks them at step 3; a normaliser that also checked would
 * report the same fault twice, in two wordings.
 *
 * With no source there is nothing to request, so the node is emitted **without
 * a query** and any filter, sort, limit or offset written beside it is dropped
 * with it. The internal schema requires a query of every query-backed node, so
 * step 3 rejects such a node as the syntactic gap it is — which is the reporting
 * this module deliberately does not do itself.
 */
function liftQuery(input: QueryBackedNodeInput): DataQuery | undefined {
  const declared: DataQueryInput | undefined = input.query;

  /*
   * As in `mergeFilters`, the `satisfies` clause is the guard that keeps this
   * function honest if the flat authoring vocabulary grows: `./nodes/query.ts`
   * owns `DataQueryFlatFieldKey`, and a key it adds must be resolved here.
   */
  const resolved = {
    source:
      preferDeclared(declared?.source, input.source) ??
      PANEL_NODE_CATALOG[input.type].defaultSource,
    filter: mergeFilters(declared?.filter, input.filter),
    sort: preferDeclared(declared?.sort, input.sort),
    limit: preferDeclared(declared?.limit, input.limit),
    offset: preferDeclared(declared?.offset, input.offset),
  } satisfies Record<DataQueryFlatFieldKey, unknown>;

  if (resolved.source === undefined) {
    return undefined;
  }

  // Field order follows the internal `dataQuerySchema`, and `source` is the one
  // field that is always present.
  return {
    source: resolved.source,
    ...(resolved.filter === undefined ? {} : { filter: resolved.filter }),
    ...(resolved.sort === undefined ? {} : { sort: resolved.sort }),
    ...(resolved.limit === undefined ? {} : { limit: resolved.limit }),
    ...(resolved.offset === undefined ? {} : { offset: resolved.offset }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Nodes
 * ---------------------------------------------------------------------------
 */

/** The two presentational fields every authored node may carry. */
interface AuthoredNodeLabels {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}

/**
 * Carry a node's heading and explanation across unchanged.
 *
 * Present fields are copied verbatim and absent fields stay absent: a node the
 * author did not title is not given one here. The label a titleless node is
 * shown under is `PANEL_NODE_CATALOG[type].label`, which is the renderer's
 * concern and would be a second, diverging source of headings if it were baked
 * into the document instead.
 */
function labelsOf(input: AuthoredNodeLabels): AuthoredNodeLabels {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}

/**
 * Normalize one of the twelve query-backed visualization nodes.
 *
 * The node's own options stay its own: a metric-tile node keeps `metrics` as a
 * field of the node, exactly where `./nodes/viz.ts` declares it, and it is
 * never folded into the query — the ids to show are what the node draws, not
 * which evidence it reads. The array is copied so the document shares no
 * mutable state with the value it was normalized from.
 *
 * The only type assertions in this module are the two below, and they are the
 * assertions TypeScript requires of any function that builds a member of a
 * discriminated union from a discriminant held in a variable. They are also
 * what allows the deliberate emission of a node whose `query` could not be
 * resolved — the internal schema requires that field, so the node cannot be
 * typed as complete — which step 3 then rejects; see {@link liftQuery} for why
 * that reporting belongs there and not here.
 */
function normalizeQueryBackedNode(input: QueryBackedNodeInput, id: PanelNodeId): QueryBackedNode {
  const query = liftQuery(input);

  const node = {
    type: input.type,
    id,
    ...labelsOf(input),
    ...(query === undefined ? {} : { query }),
  };

  if (input.type === 'metricCards') {
    return { ...node, type: 'metricCards', metrics: [...input.metrics] } as MetricCardsNode;
  }

  return node as QueryBackedNode;
}

/**
 * One normalized node, and — for a container — the authored children still to
 * be normalized into it.
 *
 * The seam between building a node and walking a tree: {@link normalizeNode}
 * builds one node with its fields in their final order and, for a container,
 * an output `children` array of the authored array's length, and hands the
 * authored children back instead of recursing into them. {@link normalizeLayout}
 * then fills that array in place, so a container's object is complete — keys,
 * order and all — before any of its children exist.
 */
interface NormalizedNodeShell {
  /** The node, final except for the entries of its `children` array. */
  readonly node: PanelNode;

  /** A container's children: the authored nodes, and the array they fill. */
  readonly children?: {
    readonly authored: readonly PanelNodeInput[];
    readonly into: PanelNode[];
  };
}

/**
 * The output array for a list of authored nodes: the same length, filled later
 * by index.
 *
 * Sized up front and filled by position — rather than pushed to — so a hole in
 * a hand-assembled input array stays a hole in the output, exactly as the
 * `Array.prototype.map` a recursive normaliser would use leaves it; see
 * {@link queueNodes} for the other half of that rule.
 *
 * @param authored The authored nodes.
 * @returns An array of the same length with no entries yet.
 */
function outputArrayFor(authored: readonly PanelNodeInput[]): PanelNode[] {
  return new Array<PanelNode>(authored.length);
}

/**
 * Normalize one authored node, without its subtree.
 *
 * Called once per node in depth-first pre-order, which is the order the id
 * minter counts in and the order `walkPanelNodes` reads a finished document in.
 * A container's children are returned for the caller to walk, never recursed
 * into here — see {@link normalizeLayout} for why.
 *
 * The switch is exhaustive by construction: every branch returns, and the
 * default hands the value to `assertNever`, so a node type added to the
 * vocabulary in `./spec.ts` fails to compile here until it is handled. That is
 * the only reason this function enumerates node types at all — the behaviour
 * within a branch is driven by the catalog, never by the name of the type.
 */
function normalizeNode(input: PanelNodeInput, id: PanelNodeId): NormalizedNodeShell {
  switch (input.type) {
    case 'section': {
      const children = outputArrayFor(input.children);
      const section: PanelSectionNode = {
        type: 'section',
        id,
        ...labelsOf(input),
        children,
      };

      return { node: section, children: { authored: input.children, into: children } };
    }

    case 'split': {
      /*
       * `direction` is carried over only when the author stated it. The
       * internal schema keeps it optional and `DEFAULT_SPLIT_DIRECTION` in
       * `./nodes/layout.ts` is the renderer's default, so materialising it here
       * would freeze today's default into every stored document and make a
       * later change to it invisible to every panel already on disk.
       */
      const children = outputArrayFor(input.children);
      const split: PanelSplitNode = {
        type: 'split',
        id,
        ...labelsOf(input),
        ...(input.direction === undefined ? {} : { direction: input.direction }),
        children,
      };

      return { node: split, children: { authored: input.children, into: children } };
    }

    case 'stack': {
      const children = outputArrayFor(input.children);
      const stack: PanelStackNode = {
        type: 'stack',
        id,
        ...labelsOf(input),
        children,
      };

      return { node: stack, children: { authored: input.children, into: children } };
    }

    case 'sourceLink': {
      /*
       * The leaf that reads no captured data. Its location was parsed by
       * `sourceLocationSchema` at step 1 and is carried through whole: a
       * normaliser that rewrote a file path, a line or a resolution route would
       * be inventing a location, and the one thing a source link must be is the
       * place the capture or the code index actually resolved.
       */
      const sourceLink: SourceLinkNode = {
        type: 'sourceLink',
        id,
        ...labelsOf(input),
        location: input.location,
      };

      return { node: sourceLink };
    }

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
      return { node: normalizeQueryBackedNode(input, id) };

    default:
      return assertNever(input, 'Unhandled authored panel node type');
  }
}

/*
 * ---------------------------------------------------------------------------
 * The layout walk
 *
 * Iterative, with an explicit stack, for the reason `walkPanelNodes` in
 * `./spec.ts` is: `normalizePanel` accepts a hand-assembled input as well as a
 * parsed one — the deterministic fallback path of AAP 0.5.5 builds one — and
 * nothing bounds how deep such an input is nested. A recursive walk would turn
 * a deep layout into a `RangeError` from the call stack; this one turns it into
 * a document, with the same ids in the same order a recursive walk would give.
 * ---------------------------------------------------------------------------
 */

/** An authored node waiting to be normalized, and where its result goes. */
interface NormalizeNodeStep {
  readonly kind: 'node';

  /** The authored node. */
  readonly input: PanelNodeInput;

  /** Its derived id, when that fits; see {@link derivedIdAt}. */
  readonly derivedId: string | undefined;

  /** Its nesting level, a top-level node being 1. Reported by the cycle guard. */
  readonly level: number;

  /** The output array the normalized node is written into. */
  readonly into: PanelNode[];

  /** The position it is written at: its index among its authored siblings. */
  readonly index: number;
}

/**
 * The marker a container leaves below its children on the stack: when it is
 * popped, the container's whole subtree has been normalized and the container
 * leaves the ancestor chain.
 */
interface LeaveContainerStep {
  readonly kind: 'leave';

  /** The authored container whose subtree is complete. */
  readonly container: PanelNodeInput;
}

/** One entry of {@link normalizeLayout}'s stack. */
type NormalizeStep = NormalizeNodeStep | LeaveContainerStep;

/**
 * Queues one list of authored nodes, so that they are normalized in document
 * order.
 *
 * The steps are gathered with `forEach` and pushed last to first: the stack is
 * LIFO, so the first sibling comes out first, and each sibling's whole subtree
 * is pushed — and therefore finished — before the next sibling is popped, which
 * is exactly depth-first pre-order. `forEach` skips a hole in a sparse array
 * the way `Array.prototype.map` does, so a hand-assembled array with a hole
 * mints no id for it and leaves the hole in the output (see
 * {@link outputArrayFor}). Pushed one at a time rather than spread, so no list
 * length can exceed the runtime's argument limit.
 *
 * @param pending The walk's stack. **Mutated.**
 * @param authored The nodes to queue.
 * @param idBase The joined path of the array they sit in, for
 * {@link derivedIdAt}.
 * @param into The output array they are written into.
 * @param level Their nesting level.
 */
function queueNodes(
  pending: NormalizeStep[],
  authored: readonly PanelNodeInput[],
  idBase: string | undefined,
  into: PanelNode[],
  level: number,
): void {
  const steps: NormalizeNodeStep[] = [];

  authored.forEach((input, index) => {
    steps.push({ kind: 'node', input, derivedId: derivedIdAt(idBase, index), level, into, index });
  });

  steps.reverse();

  for (const step of steps) {
    pending.push(step);
  }
}

/**
 * The failure raised when an authored node is found inside its own subtree.
 *
 * Such an input is a graph, not a layout, and normalizing it would never end —
 * a recursive walk would overflow the stack, an iterative one would run until
 * memory ran out. It cannot come out of `parsePanelSpecInput`, whose output is a
 * freshly built tree, so it is a defect in whatever assembled the value:
 * `INTERNAL`, as the "Totality" contract in this module's documentation states
 * for every throw here. The message names the nesting level and nothing
 * authored.
 *
 * @param level The nesting level at which the node reappeared.
 * @returns The error to throw.
 */
function layoutCycleError(level: number): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    `An authored panel layout contains a node inside its own subtree, found again at nesting level ${String(level)}; a layout must be a tree.`,
    {
      hint: 'Assemble the authored layout so that no container holds itself at any depth. A subtree may be shared between positions, but never placed below itself.',
      details: { level },
    },
  );
}

/**
 * Normalize a whole authored layout, depth first, without recursion.
 *
 * Each node is popped, checked against the ancestor chain, given its id —
 * pre-order, so the id minter's ordinals match a recursive walk's — built by
 * {@link normalizeNode} and written into its parent's output array at its own
 * index. A container additionally joins the ancestor chain, pushes a
 * {@link LeaveContainerStep} and then its children above that marker, so the
 * marker surfaces exactly when its subtree is done.
 *
 * **The ancestor chain is the cycle guard.** It holds the authored containers
 * on the path from the root to the node being normalized, by identity; a node
 * already on it has been reached from inside itself, and the walk throws
 * {@link layoutCycleError} instead of running forever. A node that is merely
 * *shared* — the same object at two positions, neither inside the other — is
 * off the chain by the time its second position is reached, so it is
 * normalized twice, with the two path-derived ids of its two positions, as a
 * recursive walk would normalize it.
 *
 * Memory is proportional to the number of nodes plus the depth, and every id
 * costs at most {@link PANEL_NODE_ID_MAX_LENGTH} characters to derive, so a
 * layout ten thousand levels deep costs what ten thousand siblings cost.
 *
 * @param layout The authored top-level nodes.
 * @param mintId The id minter for this normalisation.
 * @returns The normalized top-level nodes.
 * @throws DebuggenError `INTERNAL` if a node is found inside its own subtree,
 * or if a node's type is outside the vocabulary.
 */
function normalizeLayout(
  layout: readonly PanelNodeInput[],
  mintId: NodeIdMinter,
): readonly PanelNode[] {
  const normalized = outputArrayFor(layout);
  const pending: NormalizeStep[] = [];
  const ancestors = new Set<PanelNodeInput>();

  queueNodes(pending, layout, NODE_ID_ROOT, normalized, 1);

  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    if (step.kind === 'leave') {
      ancestors.delete(step.container);
      continue;
    }

    if (ancestors.has(step.input)) {
      throw layoutCycleError(step.level);
    }

    const shell = normalizeNode(step.input, mintId(step.derivedId));

    step.into[step.index] = shell.node;

    if (shell.children !== undefined) {
      ancestors.add(step.input);
      pending.push({ kind: 'leave', container: step.input });
      queueNodes(
        pending,
        shell.children.authored,
        childrenIdBase(step.derivedId),
        shell.children.into,
        step.level + 1,
      );
    }
  }

  return normalized;
}

/*
 * ---------------------------------------------------------------------------
 * The summary — the integrity boundary
 *
 * Two lists and one line of prose. The lists come from the analysis and the
 * prose comes from the author, and no code path crosses between them. The
 * structure below is the guarantee: the only function that reads an authored
 * summary returns `string | undefined`, so there is no branch that promotes an
 * authored statement into a fact, no filter that would let one through, and no
 * value shaped like evidence anywhere in its output.
 * ---------------------------------------------------------------------------
 */

/** Marks prose that was shortened to fit {@link MAX_HEADLINE_LENGTH}. */
const HEADLINE_TRUNCATION_MARK = '…';

/**
 * Cut a string at a length without splitting a surrogate pair, so a shortened
 * headline can never end in half a character.
 */
function cutAt(value: string, limit: number): string {
  const cut = value.slice(0, limit);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const endsOnHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;

  return endsOnHighSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * Bound one piece of authored prose to what the internal summary accepts.
 *
 * Surrounding whitespace is trimmed, prose that is blank once trimmed is
 * dropped rather than carried as an empty line, and prose longer than
 * {@link MAX_HEADLINE_LENGTH} keeps its first `MAX_HEADLINE_LENGTH - 1`
 * characters (minus a trailing surrogate half or trailing space) followed by a
 * single ellipsis, so the result is always within the bound and always visibly
 * shortened. The authoring schema already applies the same bound, so the rule
 * matters for a caller that assembled an input without parsing it — the
 * deterministic fallback path of AAP 0.5.5 is one — and is a no-op for anything
 * that came through `parsePanelSpecInput`.
 */
function boundedProse(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.length <= MAX_HEADLINE_LENGTH) {
    return trimmed;
  }

  return `${cutAt(trimmed, MAX_HEADLINE_LENGTH - 1).trimEnd()}${HEADLINE_TRUNCATION_MARK}`;
}

/**
 * Read an authored summary for prose, and for nothing else.
 *
 * The rule, in full, and it is the only one implemented:
 *
 * - a summary written as a **string** is that string, bounded by
 *   {@link boundedProse};
 * - a summary written as an **object** is its `headline` field, bounded the
 *   same way — the field `./input.ts` documents as "the field a summary written
 *   as an object is read for";
 * - the object's `observed` and `likelyCauses` statements are **discarded
 *   entirely**. They are prose about a capture that the author was not in a
 *   position to substantiate, and the two places a panel states such a thing
 *   are filled from the analysis. There is no third place for them and so no
 *   route by which they could appear.
 *
 * The return type is the enforcement. A `Fact` needs at least one evidence
 * reference; this function returns `string | undefined`; therefore no value it
 * produces can become one, whatever a future edit to its body attempts. Event
 * ids written into an authored summary — related to this capture or not —
 * substantiate nothing, because the prose they were attached to arrives here
 * without them and leaves as one line of text.
 */
function headlineFrom(summary: PanelSummaryInput): string | undefined {
  return typeof summary === 'string' ? boundedProse(summary) : boundedProse(summary.headline);
}

/**
 * Build the panel summary: the analysis's findings, plus the author's one line.
 *
 * `observed` and `likelyCauses` are copies of the analysis's own lists, in the
 * analysis's own order, with nothing added, removed or re-worded. The arrays
 * are fresh so the document owns its structure; the facts and hypotheses inside
 * them are carried by reference as the validated, immutable values they are.
 */
function normalizeSummary(summary: PanelSummaryInput, analysis: NormalizeAnalysis): PanelSummary {
  const headline = headlineFrom(summary);

  return {
    ...(headline === undefined ? {} : { headline }),
    observed: [...analysis.observed],
    likelyCauses: [...analysis.likelyCauses],
  };
}

/*
 * ---------------------------------------------------------------------------
 * The entry point
 * ---------------------------------------------------------------------------
 */

/**
 * Turn an authored panel into the internal panel document.
 *
 * Deterministic, pure and total for any `input` that passed
 * `parsePanelSpecInput`: nothing here reads a clock, generates an id, performs
 * I/O or writes to any of its three arguments, and calling it twice with equal
 * arguments produces equal output.
 *
 * What it does, in the order the fields appear in the result:
 *
 * - `version`, `id`, `sessionId`, `panelVersion` and `supersedes` come from
 *   `context`; `version` is the one constant of the document format.
 * - `title` is the authored title, unchanged. It was bounded and checked at
 *   step 1, and rewriting it here would make that check pointless while hiding
 *   an authoring fault from step 3.
 * - `summary` is the analysis's observed facts and likely causes, plus at most
 *   one line of authored prose as `headline`. See {@link headlineFrom} for why
 *   nothing else of an authored summary survives.
 * - `layout` is the authored forest with an id derived from each node's
 *   position and each query-backed node's data request lifted into one `query`,
 *   walked without recursion so that no depth of input overflows the stack.
 * - `meta` appears only when `context.fallback` is `true`, so an ordinary
 *   panel's JSON carries no `meta` key at all.
 *
 * Every object is written field by field in the order the internal schemas
 * declare, which is also the order Zod emits when the document is parsed back:
 * two panels with equal content serialise identically, however the author
 * happened to order their keys.
 *
 * @param input - An authored panel, ordinarily the value of a successful
 *   `parsePanelSpecInput`.
 * @param analysis - The **validated** analysis of the capture. The sole source
 *   of the panel's observed facts and likely causes.
 * @param context - The identifiers and provenance of this panel document.
 * @returns The internal panel document, ready for `parsePanelSpec` and then for
 *   semantic validation against the capture.
 * @throws DebuggenError with code `INTERNAL` if the input holds a node type
 *   outside the vocabulary, or a node inside its own subtree — both
 *   unreachable for a parsed input, and a product bug rather than a model
 *   failure if either ever happens (AAP 0.5.3).
 */
export function normalizePanel(
  input: PanelSpecInput,
  analysis: NormalizeAnalysis,
  context: NormalizeContext,
): PanelSpec {
  const layout = normalizeLayout(input.layout, createNodeIdMinter());

  return {
    version: PANEL_SPEC_VERSION,
    id: context.id,
    sessionId: context.sessionId,
    panelVersion: context.panelVersion,
    ...(context.supersedes === undefined ? {} : { supersedes: context.supersedes }),
    title: input.title,
    summary: normalizeSummary(input.summary, analysis),
    layout,
    ...(context.fallback === true ? { meta: { fallback: true } } : {}),
  };
}
