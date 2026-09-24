/**
 * Render aggregation: the `renders` and `componentTree` data sources.
 *
 * Two of the rows of the panel-data table (AAP 0.4.2) are computed here.
 * `POST /sessions/:id/panel-data` with `source: "renders"` answers with
 * {@link RenderStat}`[]`, and with `source: "componentTree"` it answers with a
 * {@link ComponentTreeSnapshot}. The renderer's render-table and
 * component-tree components are keyed to those two shapes, and the panel-node
 * catalog declares which of their fields each node reads, so the names and
 * fields below are a cross-process contract rather than an internal detail.
 *
 * ## What this module is
 *
 * Pure, environment-neutral and non-mutating. It performs no I/O, opens no
 * socket, touches no store and calls no model: it takes a flat list of
 * already-ingested, already-redacted events and returns new objects. Nothing
 * here reads a clock — every timestamp comes from the events themselves — and
 * nothing here reaches for a Node builtin or a DOM global, because this file is
 * inside the graph the package's library bundle builds with a neutral platform
 * and is imported from the service, from a page bundle and from the DevTools
 * panel alike.
 *
 * ## The one semantic that lives here
 *
 * The render-trigger buckets. `../schema/attributes.ts` fixes the vocabulary
 * and `../browser/fiber-diff.ts` decides, per render, which member of it
 * applies; this module counts the result, and the counting rule is the part
 * that is easy to get wrong:
 *
 * - `unchanged` means all three dimensions were evaluated and none changed —
 *   shallow-equal props, unchanged own hook state *and* no changed consumed
 *   context value. It is the interesting bucket: a re-render with stable
 *   inputs.
 * - `unknown` means at least one of the three could not be evaluated.
 *
 * They are **disjoint and never merged**. An `unknown` render is not evidence
 * of a stable-input re-render, so it is counted separately and reported
 * separately (`unchanged_render_count` versus `render_trigger_unknown_count`).
 * This module never infers `unchanged` itself and never reclassifies an
 * `unknown` render as one; anything it cannot read as a member of the
 * vocabulary becomes `unknown`. {@link summarizeRenderTriggers} is the single
 * place those totals are computed, and `./summary.ts` calls it instead of
 * re-deriving them, so the metric cards and this module cannot drift apart.
 *
 * ## Structure versus counts
 *
 * A component tree is a *point-in-time* structure: it is the structure of the
 * page **as the capture ended** — the producer's snapshot event, taken at
 * capture stop, or failing that the last commit of the capture, because that is
 * the only commit whose shape is still the shape of the page. The per-node
 * numbers are *cumulative* over the whole capture, because "this node rendered
 * 240 times" is the finding, and it is not visible in a single commit. Both
 * come from one internal accumulation pass, so a node's count and its row in
 * the render table can never disagree.
 *
 * @packageDocumentation
 */

import { clampNonNegative, roundMs } from '@debuggen/shared';
import type { EventId, SourceLocation, SpanId, TraceId } from '@debuggen/shared';

import {
  COMMIT_ATTRIBUTE_KEYS,
  COMPONENT_TREE_ATTRIBUTE_KEYS,
  COMPONENT_TREE_EVENT_NAME,
  COMPONENT_TREE_TRUNCATED_FIELD,
  LOG_ATTRIBUTE_KEYS,
  MAX_TRACKED_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_PHASES,
  RENDER_TRIGGERS,
  attributeKeysFor,
} from '../schema/attributes.js';
import type { ChangedPropEntry, RenderPhase, RenderTrigger } from '../schema/attributes.js';
import type { TelemetryEvent } from '../schema/event.js';
import { RENDER_KINDS, TELEMETRY_KINDS } from '../schema/kinds.js';
import type { TelemetryKind } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Vocabulary bindings
 *
 * Every kind string, attribute key and trigger value this module works with is
 * bound from the schema modules rather than spelled here. `../schema/kinds.ts`
 * is explicit that no other module may hard-code a kind list, and
 * `../schema/attributes.ts` owns the key names and the value vocabularies, so a
 * literal in this file would be a second declaration of something that already
 * has one — and the kind of second declaration that drifts silently.
 * ---------------------------------------------------------------------------
 */

/**
 * The attribute keys of a `render` event, bound positionally from the tuple
 * that declares them.
 *
 * The binding is positional because the tuple is the declaration: it carries
 * the key *names*, so naming one here would duplicate it. The coupling is
 * therefore to `RENDER_ATTRIBUTE_KEYS`' declaration order, and the tuple's
 * literal element types make each name below a literal type rather than a
 * widened `string`. Every read of these keys is validated against a closed
 * vocabulary or a type check (see {@link readTrigger},
 * {@link readRenderPhase}, {@link readComponentName}), so a reordering upstream
 * degrades this module to "unknown component" and "unknown trigger" — visibly
 * useless output — rather than to plausible-looking wrong output.
 */
const [
  COMPONENT_KEY,
  RENDER_PHASE_KEY,
  RENDER_COUNT_KEY,
  CHANGED_PROPS_KEY,
  TRIGGER_KEY,
  ACTUAL_DURATION_KEY,
  OWNER_CHAIN_KEY,
] = RENDER_ATTRIBUTE_KEYS;

/**
 * The two trigger members this module reports as their own totals.
 *
 * Bound from the vocabulary for the same reason as the keys above, and used
 * only to read the histogram it has already filled — the classification itself
 * compares against the whole tuple.
 */
const [, , , UNCHANGED_TRIGGER, UNKNOWN_TRIGGER] = RENDER_TRIGGERS;

/**
 * The component-tree snapshot's attribute keys, bound positionally from the
 * tuple that declares them.
 *
 * `componentTree` holds the forest as JSON text (or as the structure itself)
 * and `componentTreeTruncated` says the producer had to fall back to a bound
 * below the one it was asked for. The second key of the tuple,
 * `componentTreeNodeCount`, is deliberately left unbound: this module counts
 * the nodes it actually emits, and a count the producer computed over a
 * document this module may have parsed only part of would contradict it.
 */
const [COMPONENT_TREE_KEY, , COMPONENT_TREE_TRUNCATED_KEY] = COMPONENT_TREE_ATTRIBUTE_KEYS;

/**
 * The kind whose declared attribute keys are the render keys, and the kind
 * whose declared keys are the commit keys.
 *
 * Resolved by asking the attribute registry which member of the render kind
 * group declares which key set, rather than by indexing the group positionally.
 * The registry hands back the very tuple each kind declares, so the identity
 * check is exact, and the resolution stays correct if the group is ever
 * reordered.
 *
 * Both are typed as possibly absent so that a future kind group which no longer
 * contains one of them degrades to "no such events in this capture" — an empty
 * aggregate — instead of throwing inside the service's panel-data route.
 */
const RENDER_EVENT_KIND: TelemetryKind | undefined = resolveKindByDeclaredKeys(
  RENDER_KINDS,
  RENDER_ATTRIBUTE_KEYS,
);

const COMMIT_EVENT_KIND: TelemetryKind | undefined = resolveKindByDeclaredKeys(
  RENDER_KINDS,
  COMMIT_ATTRIBUTE_KEYS,
);

/**
 * The kind a component-tree snapshot travels as.
 *
 * Resolved the same way, from the whole kind vocabulary rather than from the
 * render group: the snapshot is not a rendering event but a named record of
 * the kind whose declared keys include the component-tree keys
 * (`../schema/attributes.ts` spreads them into that kind's tuple). Resolving
 * it this way rather than naming the kind is what keeps `../schema/kinds.ts`
 * the only place a kind string is written.
 *
 * Typed as possibly absent, and the selection in {@link toSnapshotRecord}
 * requires the kind only when it resolved: a catalog reorganised so that no
 * single kind declares exactly that key set must degrade to selecting
 * snapshots by event name, not to ignoring them.
 */
const SNAPSHOT_EVENT_KIND: TelemetryKind | undefined = resolveKindByDeclaredKeys(
  TELEMETRY_KINDS,
  LOG_ATTRIBUTE_KEYS,
);

/**
 * Finds the member of `candidates` whose declared attribute keys are
 * `declaredKeys`.
 *
 * Reference identity is tried first because the registry returns the declaring
 * tuple itself; the element-wise comparison is the fallback for the day the
 * registry starts copying, and it is cheap because both operands are short
 * frozen tuples.
 *
 * @param candidates Kinds to consider, conventionally one of the named kind
 * groups.
 * @param declaredKeys The key tuple that identifies the wanted kind.
 * @returns The matching kind, or `undefined` when no candidate declares that
 * key set.
 */
function resolveKindByDeclaredKeys(
  candidates: readonly TelemetryKind[],
  declaredKeys: readonly string[],
): TelemetryKind | undefined {
  return candidates.find((candidate) => {
    const keys = attributeKeysFor(candidate);
    if (keys === declaredKeys) {
      return true;
    }
    return keys.length === declaredKeys.length && keys.every((key, at) => declaredKeys[at] === key);
  });
}

/*
 * ---------------------------------------------------------------------------
 * Bounds and labels
 *
 * The three bounds are exported because they are part of the contract, not
 * tuning knobs a caller has to guess at: the aggregates computed here travel
 * inside the capture summary that crosses the WebSocket when a capture stops
 * (AAP 0.4.2, `capture.stopped`), and from there into a prompt payload. An
 * unbounded occurrence list or an unbounded tree would turn one busy capture
 * into a frame nothing can carry and a prompt nothing can afford, so the bounds
 * are defaults a caller may raise or lower deliberately, and every result says
 * whether it hit one.
 * ---------------------------------------------------------------------------
 */

/**
 * Occurrences kept per component by {@link aggregateRenders} unless the caller
 * says otherwise.
 *
 * Two hundred is the same default page size the panel-data route uses, so a
 * render table's expanded row and a paged query agree about how much detail one
 * response carries. A component that rendered more times than this still
 * reports its true `renderCount`; only the per-render list is cut, and
 * `occurrencesTruncated` says so.
 */
export const DEFAULT_MAX_OCCURRENCES_PER_COMPONENT = 200;

/**
 * Nodes emitted by {@link buildComponentTreeSnapshot} unless the caller says
 * otherwise.
 *
 * A real application's fiber tree is far larger than anything a developer reads
 * in a panel, and the snapshot is transported as JSON inside the capture
 * summary. Two thousand nodes is deep enough to hold the interesting subtree of
 * a page and small enough to serialise without thought.
 */
export const DEFAULT_COMPONENT_TREE_MAX_NODES = 2000;

/**
 * Depth emitted by {@link buildComponentTreeSnapshot} unless the caller says
 * otherwise.
 *
 * Also the recursion bound when a serialized tree arrives in a commit's
 * attributes: the parser refuses to descend past it, which — together with the
 * cycle check — is what makes parsing untrusted structure safe.
 */
export const DEFAULT_COMPONENT_TREE_MAX_DEPTH = 64;

/**
 * The component name reported for a render whose own name could not be read.
 *
 * Such a render is grouped under this label rather than dropped. Evidence is
 * never silently discarded — the correlator attaches an orphaned span to the
 * trace root with a flag for the same reason — and a capture that shows twelve
 * renders no one can attribute is a finding in itself, while a capture that
 * quietly shows none is a lie.
 *
 * Parenthesised so it cannot be mistaken for a component that is actually
 * called this.
 */
export const UNKNOWN_COMPONENT_LABEL = '(unknown component)';

/**
 * Prefix of every {@link RenderStat.id}.
 *
 * Exported so a consumer that has to re-derive a stat id — the service paging a
 * result set, a test naming an expectation — derives it from the same constant
 * this module builds it from.
 */
export const RENDER_STAT_ID_PREFIX = 'render:';

/**
 * Prefix of every {@link ComponentTreeNode.id}.
 *
 * Exported for the same reason as {@link RENDER_STAT_ID_PREFIX}. A node id is
 * this prefix followed by the node's root-first path, each segment
 * percent-encoded and joined with `/`, so it is stable across captures of the
 * same page shape and unique within one snapshot.
 */
export const COMPONENT_TREE_NODE_ID_PREFIX = 'tree:';

/*
 * ---------------------------------------------------------------------------
 * Exported result shapes
 * ---------------------------------------------------------------------------
 */

/**
 * How many renders fell into each trigger bucket.
 *
 * **Total by construction**: every member of the trigger vocabulary is present
 * and zero-filled, so a consumer reads a count without checking for a hole and
 * a chart renders an empty bucket as a zero rather than as a gap.
 */
export type RenderTriggerHistogram = Readonly<Record<RenderTrigger, number>>;

/**
 * How many renders were in each commit phase.
 *
 * Zero-filled over the whole phase vocabulary, exactly like
 * {@link RenderTriggerHistogram}. Renders whose phase could not be read appear
 * in neither bucket, so these counts may sum to less than `renderCount` — which
 * is the honest reading: a phase nobody observed is not a mount and not an
 * update.
 */
export type RenderPhaseCounts = Readonly<Record<RenderPhase, number>>;

/**
 * One observed render of one component.
 *
 * The row behind an expanded render-table row. It carries the identifiers a
 * panel needs to cite this render as evidence and to jump from it to the trace
 * it happened in, and the source location the component name links to.
 */
export interface RenderOccurrence {
  /**
   * Stable row identity, equal to {@link eventId}.
   *
   * Present under this name as well because every panel-data row carries an
   * `id`, and the renderer's tables key their rows on it.
   */
  id: EventId;
  /** The render event this occurrence was read from. */
  eventId: EventId;
  /** Span id of the render, so the timeline can select the same item. */
  spanId: SpanId;
  /** Trace the render belongs to. */
  traceId: TraceId;
  /** Parent span — the commit that rendered this fiber, when it was recorded. */
  parentSpanId?: SpanId;
  /**
   * When the render started, in Unix epoch milliseconds: the product's one time
   * base across browser, server and database tiers.
   */
  startTime: number;
  /** How long the render took, in milliseconds, never negative. */
  durationMs: number;
  /** Mount or update, when the phase was recorded. */
  phase?: RenderPhase;
  /** Why the fiber rendered. `unknown` when that could not be determined. */
  trigger: RenderTrigger;
  /**
   * The producer's running count for this component at this render, when it was
   * recorded. Not this module's count — see {@link RenderStat.renderCount}.
   */
  renderCount?: number;
  /**
   * Names of the props that changed at this render. **Names only**: a value
   * never travels, and this module never reconstructs one.
   */
  changedPropKeys: readonly string[];
  /** Where the component is declared, when a resolver supplied it. */
  source?: SourceLocation;
}

/**
 * Everything one component's renders add up to across a capture.
 *
 * The `renders` panel-data source is an array of these, and the render table
 * draws one row per entry: component, count, total and average time, trigger
 * attribution, changed props, and a source link. Expanding a row shows
 * {@link occurrences}.
 */
export interface RenderStat {
  /**
   * Stable, deterministic identity: {@link RENDER_STAT_ID_PREFIX} followed by
   * the component name.
   *
   * Derived from the component rather than minted, because the panel-data
   * contract uses `id` as the stable secondary sort key it pages by: a random
   * id would reshuffle a result set between two pages of the same query, and an
   * array index would change meaning the moment the caller sorted differently.
   */
  id: string;
  /**
   * The component's display name, or {@link UNKNOWN_COMPONENT_LABEL} for
   * renders whose name could not be read.
   */
  component: string;
  /**
   * Renders observed for this component in the capture.
   *
   * Counts `render` events only. A commit is structural — it is the parent of
   * the renders it performed — so counting commits here would inflate every
   * total and break the identity `render_count` = the sum of this field over
   * the result set, which `./summary.ts` relies on.
   */
  renderCount: number;
  /** Summed render time, in milliseconds. */
  totalDurationMs: number;
  /**
   * Mean render time, in milliseconds: {@link totalDurationMs} divided by
   * {@link renderCount}, rounded.
   *
   * Computed from the two published numbers rather than from the unrounded sum,
   * so a consumer that re-derives it from this row gets the same answer this
   * row states.
   */
  averageDurationMs: number;
  /** Longest single render, in milliseconds. */
  maxDurationMs: number;
  /** Start of the earliest observed render, in Unix epoch milliseconds. */
  firstStartTime: number;
  /** Start of the latest observed render, in Unix epoch milliseconds. */
  lastStartTime: number;
  /** Renders per trigger bucket; total over the vocabulary, zero-filled. */
  triggers: RenderTriggerHistogram;
  /**
   * Renders that were observed to have stable inputs: `triggers.unchanged`.
   *
   * Surfaced as its own field because it is a headline number — the
   * `unchanged_render_count` metric — and because a consumer must not compute
   * it by adding `unchanged` to `unknown`.
   */
  unchangedRenderCount: number;
  /**
   * Renders whose trigger could not be determined: `triggers.unknown`.
   *
   * The `render_trigger_unknown_count` metric. Disjoint from
   * {@link unchangedRenderCount} by construction.
   */
  unknownTriggerCount: number;
  /** Renders per commit phase; total over the vocabulary, zero-filled. */
  phaseCounts: RenderPhaseCounts;
  /**
   * Distinct prop names that changed across the capture, sorted ascending by
   * code unit, at most {@link MAX_TRACKED_KEYS} of them.
   *
   * Names only, never values, and the same bound the producer's own diff
   * applies — so a component with a very wide props object reports the props it
   * knows about rather than all of them.
   */
  changedPropKeys: readonly string[];
  /**
   * How many renders each reported key changed at.
   *
   * Keyed by exactly the names in {@link changedPropKeys}, so the two can never
   * disagree about which keys this row reports.
   */
  changedPropCounts: Readonly<Record<string, number>>;
  /**
   * Where the component is declared, when at least one of its renders carried a
   * location.
   *
   * The most confident location seen wins, because the resolution routes differ
   * in how much they can promise and a panel shows this one as the component's
   * source link.
   */
  source?: SourceLocation;
  /**
   * Individual renders, earliest first, bounded by
   * {@link RenderAggregateOptions.maxOccurrencesPerComponent}.
   *
   * Empty when the caller asked for counts only; see
   * {@link occurrencesTruncated}.
   */
  occurrences: readonly RenderOccurrence[];
  /**
   * Whether renders exist that {@link occurrences} does not list — because the
   * bound was reached, or because occurrences were not requested at all.
   */
  occurrencesTruncated: boolean;
}

/**
 * One component instance in a component-tree snapshot.
 *
 * JSON-serializable and free of back-references: a node knows its children and
 * its depth, never its parent. That is the same decision the trace tree makes,
 * and for the same two reasons — a cycle cannot be serialised, and a consumer
 * that walks down never needs to walk up.
 */
export interface ComponentTreeNode {
  /**
   * Stable identity: {@link COMPONENT_TREE_NODE_ID_PREFIX} followed by this
   * node's root-first path, each segment percent-encoded and joined with `/`.
   *
   * Two sibling instances of one component that carry no React key are
   * distinguished by an ordinal suffix, so ids stay unique inside a snapshot
   * without inventing identity the page did not have.
   */
  id: string;
  /** The component's display name. */
  component: string;
  /** The instance's React key, when the structure carried one. */
  key?: string;
  /** Distance from the root of this snapshot; a root node is `0`. */
  depth: number;
  /**
   * How many times this **component** rendered during the whole capture, not
   * just in the commit this structure came from.
   *
   * Cumulative on purpose: the finding is how often something rendered, and the
   * component-tree view highlights nodes above a threshold. A component
   * appearing at several positions reports the same cumulative count at each,
   * because the evidence is per component, not per instance.
   */
  renderCount: number;
  /** Cumulative render time for the component, in milliseconds. */
  totalDurationMs: number;
  /** Trigger of the component's most recent observed render. */
  lastTrigger?: RenderTrigger;
  /**
   * Event id of the render that supplied {@link lastTrigger} — the node's
   * representative event, what a view selects when the node is activated.
   *
   * That render is the latest one of this component in canonical order (start
   * time, then event id), so the reference does not depend on the order the
   * events were handed over in. A real, captured event: present only when the
   * component rendered at least once during the capture, and absent — never an
   * invented id — for a node that is structure alone.
   */
  lastRenderEventId?: EventId;
  /**
   * Span id of that same render, so a view can select it on a timeline. Present
   * exactly when {@link lastRenderEventId} is.
   */
  lastRenderSpanId?: SpanId;
  /**
   * Trace that same render belongs to. Present exactly when
   * {@link lastRenderEventId} is.
   */
  lastRenderTraceId?: TraceId;
  /** Where the component is declared, when a resolver supplied it. */
  source?: SourceLocation;
  /** Child nodes, in the order the structure presented them. */
  children: readonly ComponentTreeNode[];
}

/**
 * How a component-tree snapshot was built, best first.
 *
 * - `commit-snapshot` — the producer serialized the structure itself, so it
 *   needed only validating: either on its own snapshot event, taken at capture
 *   stop while the last committed structure was still reachable, or attached
 *   to the commit. Both write the catalogued `componentTree` key.
 * - `owner-chains` — the structure was reconstructed from the owner chains the
 *   individual render events carry. Faithful for every path that was rendered,
 *   and silent about parts of the page that did not render.
 * - `flat` — no structure was available, so the observed components are listed
 *   as a single level. Always {@link ComponentTreeSnapshot.degraded}.
 */
export const COMPONENT_TREE_ORIGINS = ['commit-snapshot', 'owner-chains', 'flat'] as const;

/** One member of the closed snapshot-origin vocabulary. */
export type ComponentTreeOrigin = (typeof COMPONENT_TREE_ORIGINS)[number];

/**
 * The component structure of the page, as of the last commit of the capture,
 * annotated with cumulative render counts.
 *
 * The `componentTree` panel-data source. `origin` and `degraded` are part of
 * the answer, not diagnostics: a developer reading a tree needs to know whether
 * they are looking at the page's structure or at a reconstruction of the parts
 * of it that rendered.
 */
export interface ComponentTreeSnapshot {
  /**
   * When the structure was observed, in Unix epoch milliseconds: the start of
   * the snapshot event that carried it, of the commit it came from, or of the
   * latest render when the capture holds neither.
   */
  capturedAt: number;
  /** The commit event the structure came from, when one was captured. */
  commitEventId?: EventId;
  /** Span id of that commit, so a panel can select it on the timeline. */
  commitSpanId?: SpanId;
  /** Trace that commit belongs to. */
  traceId?: TraceId;
  /** Which construction route produced {@link roots}. */
  origin: ComponentTreeOrigin;
  /**
   * Whether the structure is known to be incomplete: a flat listing, a
   * truncated tree, a reconstruction from partial owner chains, or a snapshot
   * with no commit to anchor it.
   *
   * A consumer shows a degraded tree with that caveat rather than as the page's
   * structure.
   */
  degraded: boolean;
  /** Root nodes, in the order the structure presented them. */
  roots: readonly ComponentTreeNode[];
  /** Nodes actually emitted, across every level. */
  nodeCount: number;
  /**
   * The greatest {@link ComponentTreeNode.depth} emitted, so a single level of
   * roots reports `0`.
   */
  maxDepth: number;
  /**
   * Whether any node was dropped: a node or depth bound was reached, or a
   * serialized structure could not be followed any further — a cycle, or a
   * subtree past the depth bound.
   *
   * Always implies {@link degraded}; the two are separate because a consumer
   * that shows "1 of 2 000 nodes" needs to know *why* the tree is short, not
   * only that it is caveated.
   */
  truncated: boolean;
}

/**
 * The render totals of a whole capture.
 *
 * `./summary.ts` turns this into the `render_count`,
 * `unchanged_render_count` and `render_trigger_unknown_count` metrics, and the
 * panel schema validates those metric ids — so the three numbers here and the
 * three cards a panel can ask for are the same three numbers, computed once.
 */
export interface RenderTriggerSummary {
  /** Renders observed across every component. */
  renderCount: number;
  /**
   * Renders observed to have stable inputs. Counts `unchanged` and nothing
   * else.
   */
  unchangedRenderCount: number;
  /**
   * Renders whose trigger could not be determined. Counts `unknown` and nothing
   * else.
   */
  unknownTriggerCount: number;
  /** Renders per trigger bucket across every component; zero-filled. */
  byTrigger: RenderTriggerHistogram;
  /** Components that rendered at least once. */
  componentCount: number;
}

/**
 * How much per-render detail {@link aggregateRenders} should carry.
 *
 * Both fields are optional; the defaults are the exported constants, and an
 * out-of-range value falls back to the default rather than throwing, because
 * these options arrive from a panel-data request body.
 */
export interface RenderAggregateOptions {
  /**
   * Occurrences to keep per component. Defaults to
   * {@link DEFAULT_MAX_OCCURRENCES_PER_COMPONENT}. A value of `0` keeps none,
   * which is reported as truncation rather than as "there were none".
   */
  maxOccurrencesPerComponent?: number;
  /**
   * Set `false` for counts only — the shape `./summary.ts` needs, and the
   * cheapest one to put in a prompt payload. Defaults to `true`.
   */
  includeOccurrences?: boolean;
}

/**
 * How large a tree {@link buildComponentTreeSnapshot} may emit.
 *
 * `maxDepth` bounds the parser as well as the output, so it is also the
 * recursion bound applied to a serialized tree that arrived inside a commit's
 * attributes.
 */
export interface ComponentTreeOptions {
  /** Nodes to emit. Defaults to {@link DEFAULT_COMPONENT_TREE_MAX_NODES}. */
  maxNodes?: number;
  /** Depth to emit. Defaults to {@link DEFAULT_COMPONENT_TREE_MAX_DEPTH}. */
  maxDepth?: number;
}

/*
 * ---------------------------------------------------------------------------
 * Internal shapes
 *
 * The normalised view of an event, read once and reused by both public
 * functions. Optional fields are spelled `| undefined` rather than `?:` here:
 * these objects are built in one place and never serialised, so the explicit
 * union is easier to construct under `exactOptionalPropertyTypes` than an
 * optional property is, and the exported shapes above — which *are* serialised
 * — keep their optional properties and receive them by conditional spread.
 * ---------------------------------------------------------------------------
 */

/** An event's attribute bag: an open record of JSON-shaped values. */
type AttributeBag = Readonly<Record<string, unknown>>;

/**
 * Hostile-input bound on an owner chain read from an attribute.
 *
 * A chain longer than this cannot contribute a usable path — the tree's own
 * depth bound is far smaller — so reading further would only cost memory. It is
 * internal because, unlike the three exported bounds, no caller has a reason to
 * choose it.
 */
const MAX_OWNER_CHAIN_SEGMENTS = 1024;

/** A `render` event, normalised. */
interface RenderRecord {
  readonly eventId: EventId;
  readonly spanId: SpanId;
  readonly parentSpanId: SpanId | undefined;
  readonly traceId: TraceId;
  readonly startTime: number;
  readonly durationMs: number;
  readonly ingestSeq: number;
  readonly component: string;
  readonly componentId: string;
  readonly phase: RenderPhase | undefined;
  readonly trigger: RenderTrigger;
  readonly reportedRenderCount: number | undefined;
  readonly changedPropKeys: readonly string[];
  /** Ancestor component names, nearest first, as the producer recorded them. */
  readonly ownerChain: readonly string[];
  /** Whether the chain was cut at {@link MAX_OWNER_CHAIN_SEGMENTS}. */
  readonly ownerChainTruncated: boolean;
  readonly source: SourceLocation | undefined;
}

/** A `commit` event, normalised. */
interface CommitRecord {
  readonly eventId: EventId;
  readonly spanId: SpanId;
  readonly traceId: TraceId;
  readonly startTime: number;
  readonly durationMs: number;
  readonly ingestSeq: number;
  readonly kind: TelemetryKind;
  readonly attributes: AttributeBag;
}

/**
 * A component-tree snapshot event, normalised.
 *
 * The serialized document is carried **unparsed**: parsing is bounded by the
 * node and depth limits, which only {@link buildComponentTreeSnapshot} knows,
 * and {@link aggregateRenders} indexes the same capture without ever needing
 * the structure. So the index records the candidate and the tree is read once,
 * for the snapshot that is actually used.
 */
interface SnapshotRecord {
  readonly eventId: EventId;
  readonly startTime: number;
  readonly ingestSeq: number;
  /** The `componentTree` attribute as it arrived: JSON text, or a structure. */
  readonly serialized: unknown;
  /** The producer's `componentTreeTruncated` flag: it reduced the tree. */
  readonly reduced: boolean;
}

/** Running totals for one component. Mutated only while indexing. */
interface ComponentAccumulator {
  readonly component: string;
  readonly id: string;
  renderCount: number;
  totalDuration: number;
  maxDuration: number;
  firstStartTime: number;
  lastStartTime: number;
  readonly triggers: Record<RenderTrigger, number>;
  readonly phaseCounts: Record<RenderPhase, number>;
  readonly changedPropCounts: Map<string, number>;
  source: SourceLocation | undefined;
  lastTrigger: RenderTrigger | undefined;
  lastOrderStartTime: number;
  lastOrderEventId: string;
  /**
   * Coordinates of the render that owns {@link lastTrigger}: the latest one in
   * canonical order. `undefined` only between creation and the first fold,
   * which `accumulate` performs together; kept explicit so the tree builder
   * handles "no captured render" rather than assuming a reference exists.
   */
  lastRender: RenderCoordinates | undefined;
  readonly occurrences: RenderRecord[];
}

/** The three ids that address one captured render. */
interface RenderCoordinates {
  readonly eventId: EventId;
  readonly spanId: SpanId;
  readonly traceId: TraceId;
}

/**
 * Everything both public functions need, computed in one pass.
 *
 * This is the "shared accumulator" that keeps the two results consistent: a
 * component's row in the render table and its node in the tree are annotated
 * from the same {@link ComponentAccumulator}, so they cannot report different
 * counts for the same component.
 */
interface RenderIndex {
  readonly components: ReadonlyMap<string, ComponentAccumulator>;
  readonly renders: readonly RenderRecord[];
  readonly commits: readonly CommitRecord[];
  /** Component-tree snapshot events, in canonical order. */
  readonly snapshots: readonly SnapshotRecord[];
}

/*
 * ---------------------------------------------------------------------------
 * Defensive readers
 *
 * Everything below treats an attribute as untrusted. The events reaching this
 * module have passed the event schema, but the schema deliberately leaves the
 * attribute bag open, and the bag has crossed a page boundary, a WebSocket and
 * a store on its way here. So: no read may throw, no read may widen a value,
 * and a value that cannot be understood is absent rather than guessed at — one
 * malformed attribute costs its own field and nothing else.
 * ---------------------------------------------------------------------------
 */

/**
 * Reads one attribute without trusting the bag.
 *
 * The `try` is not ceremony: an attribute bag is an ordinary object that
 * travelled as JSON, but a caller inside the same process may hand over an
 * object with an accessor or a proxy trap, and a throw from here would abort a
 * whole capture's aggregation.
 */
function readAttribute(attributes: AttributeBag, key: string): unknown {
  try {
    return attributes[key];
  } catch {
    return undefined;
  }
}

/**
 * Reads one property of an untrusted object.
 *
 * The assertion restores an index signature the compiler does not have for a
 * bare `object`, which is exactly what makes the *value* `unknown` and forces
 * the caller to validate it. Paired with the `try`, it is how this module reads
 * structure that arrived from a page without ever trusting its shape.
 */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Readonly<Record<string, unknown>>)[key];
  } catch {
    return undefined;
  }
}

/** A finite number, or `undefined` for anything else — including `NaN`. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A non-empty string, or `undefined`. */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * An array with element type restored to `unknown`.
 *
 * `Array.isArray` narrows an `unknown` to `any[]`, which would let every
 * element flow onwards unchecked. The assertion here *tightens* that back to
 * `unknown`, so each element still has to be validated by the reader that
 * consumes it; it is not a check being silenced.
 */
function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

/** A member of the trigger vocabulary, or `undefined`. */
function asRenderTrigger(value: unknown): RenderTrigger | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return RENDER_TRIGGERS.find((trigger) => trigger === value);
}

/** A member of the phase vocabulary, or `undefined`. */
function asRenderPhase(value: unknown): RenderPhase | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return RENDER_PHASES.find((phase) => phase === value);
}

/** Code-unit string order: locale-independent, so two machines agree. */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * A record with every member of a closed vocabulary set to zero.
 *
 * The assertion states completeness, which the loop above it establishes: the
 * vocabulary is a frozen tuple of the exact key union, so after the loop every
 * key of the record has a value. It is not covering for an unchecked index.
 */
function zeroFilledCounts<Key extends string>(keys: readonly Key[]): Record<Key, number> {
  const counts: Partial<Record<Key, number>> = {};
  for (const key of keys) {
    counts[key] = 0;
  }
  return counts as Record<Key, number>;
}

/**
 * Total order for two locations of equal confidence: file, line, column,
 * symbol, resolution route, then end line.
 *
 * Every field of the shape except `confidence` takes part, in that fixed
 * order, so the comparison separates any two locations that are not identical
 * and returns `0` only for two that are. A location that **names a symbol
 * sorts before one that does not**, so the more descriptive of two otherwise
 * identical positions wins; an absent `endLine` sorts first. The string
 * comparisons are by code unit so two machines agree.
 *
 * `./timeline.ts` orders equal-confidence locations by the same rule for the
 * participants of its dependency graph, so the `renders` and `graph` sources
 * cannot send a developer to two different lines for one component.
 */
function compareLocations(left: SourceLocation, right: SourceLocation): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  if (left.column !== right.column) {
    return left.column - right.column;
  }
  if (left.symbol !== right.symbol) {
    if (left.symbol === undefined) {
      return 1;
    }
    if (right.symbol === undefined) {
      return -1;
    }
    return compareStrings(left.symbol, right.symbol);
  }
  const byRoute = compareStrings(left.resolvedBy, right.resolvedBy);
  if (byRoute !== 0) {
    return byRoute;
  }
  return (left.endLine ?? 0) - (right.endLine ?? 0);
}

/**
 * Keeps the more trustworthy of two locations.
 *
 * Resolution routes differ in what they can promise — a patch knows exactly
 * where it wrote, a source map knows a position, an owner chain knows a
 * component — and each location carries the confidence its route assigned. When
 * several renders of one component disagree, the most confident answer is the
 * one a developer should be sent to.
 *
 * **Equal confidence is broken by the locations themselves**, not by which
 * render was folded in first: {@link compareLocations} is a total order over
 * the whole shape and the lesser location wins. Keeping the incumbent instead
 * would make a component's reported source depend on the order the events
 * happened to arrive in, so two runs over one capture — or the service and a
 * page bundle reading the same capture — could send a developer to two
 * different lines and neither would be wrong. The confidence precedence itself
 * is untouched: a more confident location still beats a less confident one
 * whatever their fields say.
 */
function preferSource(
  current: SourceLocation | undefined,
  candidate: SourceLocation | undefined,
): SourceLocation | undefined {
  if (candidate === undefined) {
    return current;
  }
  if (current === undefined) {
    return candidate;
  }
  if (candidate.confidence !== current.confidence) {
    return candidate.confidence > current.confidence ? candidate : current;
  }
  return compareLocations(candidate, current) < 0 ? candidate : current;
}

/** The component name of a render, or {@link UNKNOWN_COMPONENT_LABEL}. */
function readComponentName(attributes: AttributeBag): string {
  return asNonEmptyString(readAttribute(attributes, COMPONENT_KEY)) ?? UNKNOWN_COMPONENT_LABEL;
}

/**
 * Why the fiber rendered.
 *
 * Strict by design: a missing value, a wrong type and an unrecognised string
 * are all `unknown`. The producer is the only party that can tell an
 * unchanged-input render from an unevaluable one, so a reader that guessed here
 * would manufacture the very evidence the two buckets exist to keep apart.
 */
function readTrigger(attributes: AttributeBag): RenderTrigger {
  return asRenderTrigger(readAttribute(attributes, TRIGGER_KEY)) ?? UNKNOWN_TRIGGER;
}

/** Mount or update, or absent when the phase could not be read. */
function readRenderPhase(attributes: AttributeBag): RenderPhase | undefined {
  return asRenderPhase(readAttribute(attributes, RENDER_PHASE_KEY));
}

/**
 * The producer's running render count, when it is a plain non-negative integer.
 *
 * Reported as observed and never used as this module's own count: a count the
 * producer computed over its own lifetime cannot be summed with one computed
 * over the capture.
 */
function readReportedRenderCount(attributes: AttributeBag): number | undefined {
  const value = asFiniteNumber(readAttribute(attributes, RENDER_COUNT_KEY));
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * The name of one changed prop, from either shape the attribute may carry.
 *
 * The producer's diff emits entries, but a leaner producer — or a replayed
 * fixture — may carry plain names, so both are accepted. Only the name is ever
 * taken: the summaries an entry carries describe values, and this module has no
 * business copying them anywhere.
 */
function changedPropKeyOf(entry: unknown): string | undefined {
  const asName = asNonEmptyString(entry);
  if (asName !== undefined) {
    return asName;
  }
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  return asNonEmptyString(readProperty(entry, CHANGED_PROP_KEY_FIELD));
}

/**
 * The name of the field an entry carries its prop name in.
 *
 * Annotated as a key of the upstream entry shape rather than written as a bare
 * string, so renaming that field upstream fails this file's typecheck instead
 * of silently emptying every changed-prop list in the product.
 */
const CHANGED_PROP_KEY_FIELD: keyof ChangedPropEntry = 'key';

/**
 * Names of the props that changed at one render: deduplicated, sorted, and cut
 * to {@link MAX_TRACKED_KEYS}.
 *
 * The bound matches the producer's own, so a well-behaved event is never cut
 * here and a misbehaving one cannot widen what the capture carries.
 */
function readChangedPropKeys(attributes: AttributeBag): readonly string[] {
  const entries = asArray(readAttribute(attributes, CHANGED_PROPS_KEY));
  if (entries === undefined || entries.length === 0) {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries) {
    const name = changedPropKeyOf(entry);
    if (name === undefined) {
      continue;
    }
    names.add(name);
    if (names.size >= MAX_TRACKED_KEYS) {
      break;
    }
  }
  return [...names].sort(compareStrings);
}

/**
 * Ancestor component names for one render, nearest first.
 *
 * Nearest-first is the producer's convention for a component chain, and it is
 * what lets the tree builder recover a root-first path by reversing. Entries
 * that are not usable names are skipped, and consecutive repeats are collapsed
 * — a memoised wrapper and the component it wraps are one component to a
 * developer, and collapsing them here keeps a wrapper from becoming a level of
 * the tree.
 */
function readOwnerChain(attributes: AttributeBag): {
  readonly chain: readonly string[];
  readonly truncated: boolean;
} {
  const entries = asArray(readAttribute(attributes, OWNER_CHAIN_KEY));
  if (entries === undefined || entries.length === 0) {
    return { chain: [], truncated: false };
  }
  const chain: string[] = [];
  let truncated = false;
  for (const entry of entries) {
    if (chain.length >= MAX_OWNER_CHAIN_SEGMENTS) {
      truncated = true;
      break;
    }
    const name = ownerChainNameOf(entry);
    if (name === undefined || chain[chain.length - 1] === name) {
      continue;
    }
    chain.push(name);
  }
  return { chain, truncated };
}

/**
 * One owner-chain entry's component name.
 *
 * A chain is a list of names, and this reader also accepts an entry that names
 * itself the way a tree node does, so a producer that carries richer entries
 * does not have to flatten them before they can be read.
 */
function ownerChainNameOf(entry: unknown): string | undefined {
  const asName = asNonEmptyString(entry);
  if (asName !== undefined) {
    return asName;
  }
  return componentNameOfNodeLike(entry);
}

/*
 * ---------------------------------------------------------------------------
 * Indexing: the one pass both results are built from
 * ---------------------------------------------------------------------------
 */

/** Canonical order for renders: start time, then event id. */
function compareRenderRecords(left: RenderRecord, right: RenderRecord): number {
  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }
  return compareStrings(left.eventId, right.eventId);
}

/** The fields canonical event order is computed from. */
interface CanonicallyOrdered {
  readonly startTime: number;
  readonly ingestSeq: number;
  readonly eventId: EventId;
}

/**
 * Canonical order: start time, then ingest sequence, then event id.
 *
 * The same ordering the correlator uses, and for the same reason: the ingest
 * sequence is store-assigned and always distinct, so the comparison is total
 * and two runs over one capture choose the same "last" record. Both the
 * commits and the snapshot events are sorted with it, so "the last commit" and
 * "the latest snapshot" are decided by one rule.
 */
function compareCanonically(left: CanonicallyOrdered, right: CanonicallyOrdered): number {
  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }
  if (left.ingestSeq !== right.ingestSeq) {
    return left.ingestSeq - right.ingestSeq;
  }
  return compareStrings(left.eventId, right.eventId);
}

/**
 * An event's start time, rounded to the product's stored precision.
 *
 * Rounding is idempotent for an event that was stored through the same policy,
 * so this normalises a hand-built or replayed event without moving a real one.
 * A non-finite value yields `undefined`: such an event cannot be placed on any
 * timeline, and admitting it would poison every minimum, maximum and sort it
 * took part in.
 */
function normalizeStartTime(value: number): number | undefined {
  return Number.isFinite(value) ? roundMs(value) : undefined;
}

/**
 * How long a render took.
 *
 * The event's own duration is authoritative. The attribute the producer
 * records alongside it is consulted only when that duration is unusable, which
 * the event schema already forbids — so this is a guard against a replayed or
 * hand-built event rather than a routine path. Clamped before rounding, so a
 * duration reconstructed from two clock readings can never arrive negative.
 */
function renderDurationMs(event: TelemetryEvent, attributes: AttributeBag): number {
  if (Number.isFinite(event.duration)) {
    return roundMs(clampNonNegative(event.duration));
  }
  const reported = asFiniteNumber(readAttribute(attributes, ACTUAL_DURATION_KEY));
  return reported === undefined ? 0 : roundMs(clampNonNegative(reported));
}

/** Normalises a `render` event, or rejects it as unplaceable. */
function toRenderRecord(event: TelemetryEvent): RenderRecord | undefined {
  const startTime = normalizeStartTime(event.startTime);
  if (startTime === undefined) {
    return undefined;
  }
  const attributes: AttributeBag = event.attributes;
  const component = readComponentName(attributes);
  const ownerChain = readOwnerChain(attributes);
  return {
    eventId: event.id,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    traceId: event.traceId,
    startTime,
    durationMs: renderDurationMs(event, attributes),
    ingestSeq: event.ingestSeq,
    component,
    componentId: renderStatId(component),
    phase: readRenderPhase(attributes),
    trigger: readTrigger(attributes),
    reportedRenderCount: readReportedRenderCount(attributes),
    changedPropKeys: readChangedPropKeys(attributes),
    ownerChain: ownerChain.chain,
    ownerChainTruncated: ownerChain.truncated,
    source: event.source,
  };
}

/**
 * Whether an attribute value could be a serialized forest.
 *
 * The same two transports {@link resolveSerializedValue} accepts — text, or
 * the structure itself — tested without parsing, so indexing a capture costs
 * nothing for an event that carries neither.
 */
function isSerializedCandidate(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.length > 0;
  }
  return typeof value === 'object' && value !== null;
}

/**
 * Normalises a component-tree snapshot event, or rejects it.
 *
 * Three conditions, in the order that costs least: the event's name is the
 * catalogued snapshot name, its kind is the kind that declares the snapshot
 * keys (when {@link SNAPSHOT_EVENT_KIND} resolved — otherwise the name alone
 * decides, so a catalog reorganisation degrades to a looser match rather than
 * to no match), and its `componentTree` attribute holds something that could
 * be a forest.
 */
function toSnapshotRecord(event: TelemetryEvent): SnapshotRecord | undefined {
  if (event.name !== COMPONENT_TREE_EVENT_NAME) {
    return undefined;
  }
  if (SNAPSHOT_EVENT_KIND !== undefined && event.kind !== SNAPSHOT_EVENT_KIND) {
    return undefined;
  }
  const startTime = normalizeStartTime(event.startTime);
  if (startTime === undefined) {
    return undefined;
  }
  const attributes: AttributeBag = event.attributes;
  const serialized = readAttribute(attributes, COMPONENT_TREE_KEY);
  if (!isSerializedCandidate(serialized)) {
    return undefined;
  }
  return {
    eventId: event.id,
    startTime,
    ingestSeq: event.ingestSeq,
    serialized,
    reduced: readAttribute(attributes, COMPONENT_TREE_TRUNCATED_KEY) === true,
  };
}

/** Normalises a `commit` event, or rejects it as unplaceable. */
function toCommitRecord(event: TelemetryEvent): CommitRecord | undefined {
  const startTime = normalizeStartTime(event.startTime);
  if (startTime === undefined) {
    return undefined;
  }
  return {
    eventId: event.id,
    spanId: event.spanId,
    traceId: event.traceId,
    startTime,
    durationMs: roundMs(clampNonNegative(event.duration)),
    ingestSeq: event.ingestSeq,
    kind: event.kind,
    attributes: event.attributes,
  };
}

/** The stable stat and grouping id for a component. */
function renderStatId(component: string): string {
  return `${RENDER_STAT_ID_PREFIX}${component}`;
}

/** A fresh accumulator with both histograms already total. */
function createAccumulator(component: string, id: string, startTime: number): ComponentAccumulator {
  return {
    component,
    id,
    renderCount: 0,
    totalDuration: 0,
    maxDuration: 0,
    firstStartTime: startTime,
    lastStartTime: startTime,
    triggers: zeroFilledCounts(RENDER_TRIGGERS),
    phaseCounts: zeroFilledCounts(RENDER_PHASES),
    changedPropCounts: new Map<string, number>(),
    source: undefined,
    lastTrigger: undefined,
    lastOrderStartTime: Number.NEGATIVE_INFINITY,
    lastOrderEventId: '',
    lastRender: undefined,
    occurrences: [],
  };
}

/** Folds one render into its component's running totals. */
function accumulate(components: Map<string, ComponentAccumulator>, record: RenderRecord): void {
  let accumulator = components.get(record.componentId);
  if (accumulator === undefined) {
    accumulator = createAccumulator(record.component, record.componentId, record.startTime);
    components.set(record.componentId, accumulator);
  }

  accumulator.renderCount += 1;
  accumulator.totalDuration += record.durationMs;
  if (record.durationMs > accumulator.maxDuration) {
    accumulator.maxDuration = record.durationMs;
  }
  if (record.startTime < accumulator.firstStartTime) {
    accumulator.firstStartTime = record.startTime;
  }
  if (record.startTime > accumulator.lastStartTime) {
    accumulator.lastStartTime = record.startTime;
  }

  accumulator.triggers[record.trigger] += 1;
  if (record.phase !== undefined) {
    accumulator.phaseCounts[record.phase] += 1;
  }

  for (const key of record.changedPropKeys) {
    accumulator.changedPropCounts.set(key, (accumulator.changedPropCounts.get(key) ?? 0) + 1);
  }

  // The latest render in canonical order owns `lastTrigger`, so the value does
  // not depend on the order the caller handed the events over in. The same
  // render's coordinates are kept with it: they are the tree node's
  // representative event, and taking them from any other render would let a
  // view select an event whose trigger is not the one the node shows.
  if (isLaterInCanonicalOrder(record, accumulator)) {
    accumulator.lastTrigger = record.trigger;
    accumulator.lastOrderStartTime = record.startTime;
    accumulator.lastOrderEventId = record.eventId;
    accumulator.lastRender = {
      eventId: record.eventId,
      spanId: record.spanId,
      traceId: record.traceId,
    };
  }

  accumulator.source = preferSource(accumulator.source, record.source);
  accumulator.occurrences.push(record);
}

/** Whether `record` is the latest render seen for its component so far. */
function isLaterInCanonicalOrder(record: RenderRecord, accumulator: ComponentAccumulator): boolean {
  if (record.startTime !== accumulator.lastOrderStartTime) {
    return record.startTime > accumulator.lastOrderStartTime;
  }
  return compareStrings(record.eventId, accumulator.lastOrderEventId) > 0;
}

/**
 * Reads a capture once: normalised renders, normalised commits, the
 * component-tree snapshot events, and per component totals.
 *
 * The three event classes are disjoint by construction — a render, a commit,
 * and a named record of the snapshot kind — and each is tried in turn, so an
 * event contributes to at most one of them.
 *
 * The input is never mutated and no event object is touched. Every event is
 * read inside a `try`, so a single hostile or malformed event costs itself and
 * nothing else — the capture's other evidence still reaches the panel, which is
 * the graceful-degradation posture the product requires of every read path.
 */
function indexRenderEvents(events: readonly TelemetryEvent[]): RenderIndex {
  const components = new Map<string, ComponentAccumulator>();
  const renders: RenderRecord[] = [];
  const commits: CommitRecord[] = [];
  const snapshots: SnapshotRecord[] = [];

  for (const event of events) {
    try {
      if (RENDER_EVENT_KIND !== undefined && event.kind === RENDER_EVENT_KIND) {
        const record = toRenderRecord(event);
        if (record !== undefined) {
          renders.push(record);
          accumulate(components, record);
        }
        continue;
      }
      if (COMMIT_EVENT_KIND !== undefined && event.kind === COMMIT_EVENT_KIND) {
        const record = toCommitRecord(event);
        if (record !== undefined) {
          commits.push(record);
        }
        continue;
      }
      const snapshot = toSnapshotRecord(event);
      if (snapshot !== undefined) {
        snapshots.push(snapshot);
      }
    } catch {
      // One unreadable event is skipped, never propagated: aggregation runs
      // inside the service's panel-data route and a throw here would turn a
      // bad attribute into a failed panel.
      continue;
    }
  }

  renders.sort(compareRenderRecords);
  commits.sort(compareCanonically);
  snapshots.sort(compareCanonically);

  return { components, renders, commits, snapshots };
}

/*
 * ---------------------------------------------------------------------------
 * The `renders` data source
 * ---------------------------------------------------------------------------
 */

/** The occurrence bound, defaulted and sanitised. */
function resolveOccurrenceLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return DEFAULT_MAX_OCCURRENCES_PER_COMPONENT;
  }
  return value;
}

/** Projects a normalised render into its transported form. */
function toOccurrence(record: RenderRecord): RenderOccurrence {
  return {
    id: record.eventId,
    eventId: record.eventId,
    spanId: record.spanId,
    traceId: record.traceId,
    ...(record.parentSpanId === undefined ? {} : { parentSpanId: record.parentSpanId }),
    startTime: record.startTime,
    durationMs: record.durationMs,
    ...(record.phase === undefined ? {} : { phase: record.phase }),
    trigger: record.trigger,
    ...(record.reportedRenderCount === undefined
      ? {}
      : { renderCount: record.reportedRenderCount }),
    changedPropKeys: record.changedPropKeys,
    ...(record.source === undefined ? {} : { source: record.source }),
  };
}

/** Projects one component's accumulator into its transported form. */
function toRenderStat(
  accumulator: ComponentAccumulator,
  limit: number,
  includeOccurrences: boolean,
): RenderStat {
  const totalDurationMs = roundMs(accumulator.totalDuration);
  const renderCount = accumulator.renderCount;
  const averageDurationMs = renderCount > 0 ? roundMs(totalDurationMs / renderCount) : 0;

  const changedPropKeys = [...accumulator.changedPropCounts.keys()]
    .sort(compareStrings)
    .slice(0, MAX_TRACKED_KEYS);
  const changedPropCounts: Record<string, number> = {};
  for (const key of changedPropKeys) {
    const count = accumulator.changedPropCounts.get(key);
    if (count === undefined) {
      continue;
    }
    changedPropCounts[key] = count;
  }

  // Ordering is only worth paying for when the list is going to be carried.
  // `./summary.ts` aggregates every capture with occurrences switched off, so
  // the counts-only path stays linear in the number of renders.
  const observed = accumulator.occurrences.length;
  const kept = includeOccurrences
    ? [...accumulator.occurrences].sort(compareRenderRecords).slice(0, limit)
    : [];

  return {
    id: accumulator.id,
    component: accumulator.component,
    renderCount,
    totalDurationMs,
    averageDurationMs,
    maxDurationMs: roundMs(accumulator.maxDuration),
    firstStartTime: accumulator.firstStartTime,
    lastStartTime: accumulator.lastStartTime,
    triggers: { ...accumulator.triggers },
    unchangedRenderCount: accumulator.triggers[UNCHANGED_TRIGGER],
    unknownTriggerCount: accumulator.triggers[UNKNOWN_TRIGGER],
    phaseCounts: { ...accumulator.phaseCounts },
    changedPropKeys,
    changedPropCounts,
    ...(accumulator.source === undefined ? {} : { source: accumulator.source }),
    occurrences: kept.map(toOccurrence),
    // True whenever renders exist that the list does not carry — including the
    // counts-only case, where none of them do.
    occurrencesTruncated: kept.length < observed,
  };
}

/**
 * Per-component render statistics for a capture: the `renders` data source.
 *
 * Only `render` events contribute. Commits are the structure renders happened
 * inside and are consumed by {@link buildComponentTreeSnapshot} instead, so
 * that `render_count` stays the number of renders rather than the number of
 * rendering events.
 *
 * The returned array is fresh, and so is every object in it; the input array
 * and the events inside it are left untouched.
 *
 * ## Order
 *
 * Busiest component first (`renderCount` descending), then component name and
 * finally `id`, both ascending by code unit so two machines agree. The service
 * re-sorts per the query's `sort` field, but a *stable total* base order is what
 * makes paging honest: without one, two pages of the same query can show the
 * same row twice and never show another.
 *
 * @param events Capture events, in any order; non-render events are ignored.
 * @param options Occurrence detail. See {@link RenderAggregateOptions}.
 * @returns One {@link RenderStat} per component that rendered.
 */
export function aggregateRenders(
  events: readonly TelemetryEvent[],
  options?: RenderAggregateOptions,
): RenderStat[] {
  const index = indexRenderEvents(events);
  const limit = resolveOccurrenceLimit(options?.maxOccurrencesPerComponent);
  const includeOccurrences = options?.includeOccurrences !== false;

  const stats: RenderStat[] = [];
  for (const accumulator of index.components.values()) {
    stats.push(toRenderStat(accumulator, limit, includeOccurrences));
  }

  stats.sort((left, right) => {
    if (left.renderCount !== right.renderCount) {
      return right.renderCount - left.renderCount;
    }
    const byComponent = compareStrings(left.component, right.component);
    return byComponent !== 0 ? byComponent : compareStrings(left.id, right.id);
  });

  return stats;
}

/*
 * ---------------------------------------------------------------------------
 * Capture-wide trigger totals
 * ---------------------------------------------------------------------------
 */

/**
 * Tells the two accepted inputs apart.
 *
 * A statistic carries a trigger histogram and an event never does, so one
 * property settles it. An empty array is reported as statistics because both
 * readings of an empty input produce the same empty summary.
 */
function isRenderStatList(
  input: readonly RenderStat[] | readonly TelemetryEvent[],
): input is readonly RenderStat[] {
  const first: RenderStat | TelemetryEvent | undefined = input[0];
  if (first === undefined) {
    return true;
  }
  return TRIGGER_HISTOGRAM_FIELD in first;
}

/**
 * The field whose presence identifies a {@link RenderStat}.
 *
 * Annotated as a key of that interface so the discrimination cannot outlive the
 * field it tests for.
 */
const TRIGGER_HISTOGRAM_FIELD: keyof RenderStat = 'triggers';

/** A count that is safe to add: a finite, non-negative number. */
function addableCount(value: unknown): number {
  const numeric = asFiniteNumber(value);
  return numeric === undefined || numeric < 0 ? 0 : numeric;
}

/**
 * Capture-wide render totals, with the two special buckets called out.
 *
 * This is the single computation behind the `render_count`,
 * `unchanged_render_count` and `render_trigger_unknown_count` metrics;
 * `./summary.ts` calls it rather than re-deriving them, which is what keeps the
 * metric cards, the render table and the analysis prose citing one set of
 * numbers.
 *
 * ## Invariants
 *
 * - `unchangedRenderCount === byTrigger.unchanged` and
 *   `unknownTriggerCount === byTrigger.unknown`: each counts exactly one bucket.
 * - The two are **disjoint** — a render classified `unknown` is never also
 *   counted as `unchanged` — because a render carries exactly one trigger and
 *   each contributes to exactly one bucket.
 * - `unchangedRenderCount + unknownTriggerCount <= renderCount`, since every
 *   bucket's total is part of the same sum.
 *
 * Accepts either the statistics — the cheap path, when the caller already has
 * them — or raw events, which are aggregated first with occurrences switched
 * off. Both reach the same code, so the two call styles cannot diverge.
 *
 * @param input Render statistics, or capture events to derive them from.
 * @returns Totals over every component that rendered.
 */
export function summarizeRenderTriggers(
  input: readonly RenderStat[] | readonly TelemetryEvent[],
): RenderTriggerSummary {
  const stats = isRenderStatList(input)
    ? input
    : aggregateRenders(input, { includeOccurrences: false });

  const byTrigger = zeroFilledCounts(RENDER_TRIGGERS);
  let renderCount = 0;

  for (const stat of stats) {
    renderCount += addableCount(stat.renderCount);
    for (const trigger of RENDER_TRIGGERS) {
      byTrigger[trigger] += addableCount(stat.triggers[trigger]);
    }
  }

  return {
    renderCount,
    unchangedRenderCount: byTrigger[UNCHANGED_TRIGGER],
    unknownTriggerCount: byTrigger[UNKNOWN_TRIGGER],
    byTrigger,
    componentCount: stats.length,
  };
}

/*
 * ---------------------------------------------------------------------------
 * The `componentTree` data source
 *
 * Four construction routes under three origins, tried best first: the
 * producer's own snapshot event, a document attached to the last commit (both
 * `commit-snapshot`, because both are the producer's structure rather than a
 * reconstruction), the owner chains of the individual renders, and a flat
 * listing. The point of keeping all of them — rather than insisting on the
 * best one — is that a component tree is most wanted exactly when a page is
 * behaving oddly, which is also when a producer is most likely to have managed
 * only part of the job. A partial answer that says it is partial beats an
 * empty panel.
 * ---------------------------------------------------------------------------
 */

/** The three origins, bound from the vocabulary so each is spelled once. */
const [COMMIT_SNAPSHOT_ORIGIN, OWNER_CHAINS_ORIGIN, FLAT_ORIGIN] = COMPONENT_TREE_ORIGINS;

/**
 * Field names of a serialized tree node, checked against the emitted shape.
 *
 * A producer that serialises a tree into a commit's attributes writes the shape
 * this module emits, so the reader looks for the same field names — and the
 * `keyof` annotations mean a rename of the emitted shape cannot leave the
 * reader looking for fields that no longer exist.
 */
const TREE_NODE_COMPONENT_FIELD: keyof ComponentTreeNode = 'component';
const TREE_NODE_KEY_FIELD: keyof ComponentTreeNode = 'key';
const TREE_NODE_CHILDREN_FIELD: keyof ComponentTreeNode = 'children';

/**
 * The field a serialized node marks its own truncation under.
 *
 * Bound from `../schema/attributes.ts` rather than spelled here, because the
 * producer writes it and the ingest redactor preserves it: one spelling across
 * the three modules is what makes the disclosure survive the trip. It is
 * deliberately **not** a field of {@link ComponentTreeNode} — this module
 * reports truncation once, for the whole snapshot, rather than per node — so
 * it cannot be annotated with `keyof` like the three fields above.
 */
const TREE_NODE_TRUNCATED_FIELD: string = COMPONENT_TREE_TRUNCATED_FIELD;

/**
 * Field names a node may carry its component name under instead.
 *
 * Both are the conventional spellings for a React component's name, so a
 * producer that serialises fiber nodes more directly is still readable. Neither
 * is a fallback with any guesswork in it: whichever field is present must still
 * hold a non-empty string.
 */
const ALTERNATE_COMPONENT_NAME_FIELDS: readonly string[] = ['name', 'displayName'];

/**
 * Hostile-input bound on a serialized tree carried as text.
 *
 * Half a megabyte is far more than any tree worth showing and small enough that
 * parsing it cannot become the expensive part of answering a panel-data
 * request.
 */
const MAX_SERIALIZED_TREE_CHARS = 512 * 1024;

/** A tree under construction: emitted shape minus the computed annotations. */
interface TreeDraft {
  readonly component: string;
  readonly key: string | undefined;
  readonly children: TreeDraft[];
}

/** A parsed or reconstructed forest, with whether anything was dropped. */
interface DraftForest {
  readonly roots: readonly TreeDraft[];
  readonly truncated: boolean;
}

/** Mutable bookkeeping shared by one parse or one emit walk. */
interface WalkState {
  budget: number;
  nodeCount: number;
  maxDepthSeen: number;
  truncated: boolean;
}

/** A bound from a request body, defaulted and sanitised. */
function resolveBound(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

/** The component name of a node-like object, under any accepted field. */
function componentNameOfNodeLike(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const declared = asNonEmptyString(readProperty(value, TREE_NODE_COMPONENT_FIELD));
  if (declared !== undefined) {
    return declared;
  }
  for (const field of ALTERNATE_COMPONENT_NAME_FIELDS) {
    const alternate = asNonEmptyString(readProperty(value, field));
    if (alternate !== undefined) {
      return alternate;
    }
  }
  return undefined;
}

/**
 * The React key of a node-like object.
 *
 * A numeric key is accepted and stringified, because that is how a list index
 * used as a key arrives after a JSON round trip, and the key's only job here is
 * to tell two sibling instances apart.
 */
function nodeKeyOfNodeLike(value: object): string | undefined {
  const raw = readProperty(value, TREE_NODE_KEY_FIELD);
  const text = asNonEmptyString(raw);
  if (text !== undefined) {
    return text;
  }
  const numeric = asFiniteNumber(raw);
  return numeric === undefined ? undefined : String(numeric);
}

/**
 * Unwraps an attribute value into something parseable as structure.
 *
 * Both transports a producer might reasonably use are accepted: the structure
 * itself, and the structure as JSON text — a serialized tree is, after all,
 * what the attribute is called. `JSON.parse` is inside a `try` and behind a
 * length bound, so neither malformed nor enormous text can do more than fail.
 */
function resolveSerializedValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_SERIALIZED_TREE_CHARS) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed;
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value;
  }
  return undefined;
}

/**
 * Parses one node of an untrusted structure, and its children beneath it.
 *
 * Four defences, each of which marks the result truncated rather than
 * throwing: the depth bound, the node budget, an ancestor set that refuses a
 * reference already open on the current path — which is how a cycle, the one
 * shape a recursive reader cannot survive, is stopped — and a child that is
 * not a readable node, whose omission is disclosed rather than passed over.
 * A node without a usable component name is not a node, and its subtree goes
 * with it: an anonymous level would be a hole in the tree that no consumer
 * could interpret.
 *
 * **The producer's own marker is read here too.** A node the producer's walk
 * stopped at carries {@link COMPONENT_TREE_TRUNCATED_FIELD}, which is a
 * statement about that node's missing descendants rather than about the
 * document (`../schema/attributes.ts` declares both levels). Folding it into
 * the walk's truncation state is what stops a tree the producer had already
 * cut from arriving as the page's whole structure: the node looks complete —
 * a component with no children — and only the marker says otherwise.
 */
function parseDraft(
  candidate: unknown,
  depth: number,
  maxDepth: number,
  ancestors: Set<object>,
  state: WalkState,
): TreeDraft | undefined {
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }
  if (depth > maxDepth || state.budget <= 0) {
    state.truncated = true;
    return undefined;
  }
  if (ancestors.has(candidate)) {
    state.truncated = true;
    return undefined;
  }
  const component = componentNameOfNodeLike(candidate);
  if (component === undefined) {
    return undefined;
  }

  state.budget -= 1;
  ancestors.add(candidate);

  if (readProperty(candidate, TREE_NODE_TRUNCATED_FIELD) === true) {
    state.truncated = true;
  }

  const children: TreeDraft[] = [];
  const childValues = asArray(readProperty(candidate, TREE_NODE_CHILDREN_FIELD));
  if (childValues !== undefined) {
    for (const child of childValues) {
      const draft = parseDraft(child, depth + 1, maxDepth, ancestors, state);
      if (draft === undefined) {
        // A child the reader could not use is a child the tree no longer
        // shows. The bounds above already record their own losses; this covers
        // the rest — a nameless node, a string where a node was expected —
        // so that every omission reaches `degraded`.
        state.truncated = true;
        continue;
      }
      children.push(draft);
    }
  }

  ancestors.delete(candidate);
  return { component, key: nodeKeyOfNodeLike(candidate), children };
}

/** Parses a serialized forest: an array of nodes, or a single root node. */
function parseSerializedForest(
  value: unknown,
  maxDepth: number,
  maxNodes: number,
): DraftForest | undefined {
  const source = resolveSerializedValue(value);
  if (source === undefined) {
    return undefined;
  }

  const state: WalkState = { budget: maxNodes, nodeCount: 0, maxDepthSeen: 0, truncated: false };
  const ancestors = new Set<object>();
  const roots: TreeDraft[] = [];
  const listed = asArray(source);

  for (const candidate of listed ?? [source]) {
    const draft = parseDraft(candidate, 0, maxDepth, ancestors, state);
    if (draft !== undefined) {
      roots.push(draft);
    }
  }

  return roots.length === 0 ? undefined : { roots, truncated: state.truncated };
}

/**
 * Looks through a commit's attributes for a serialized tree.
 *
 * The catalogued {@link COMPONENT_TREE_KEY} is read first, because that is the
 * one spelling the contract fixes: a producer that attaches the document to
 * its commit rather than emitting a snapshot event writes the same key its
 * snapshot event would have (`../schema/attributes.ts`), and honouring it here
 * is what makes the two routes one contract.
 *
 * Failing that, the key is *discovered*: every attribute the catalog does not
 * declare for this kind is offered to the structural parser — the event schema
 * is explicit that the bag is open precisely so a new signal can ship without a
 * schema change — and the first value that parses as a forest wins. Keys are
 * visited in sorted order, so two producers carrying two candidates still
 * yield one deterministic answer.
 */
function findSerializedForest(
  commit: CommitRecord,
  maxDepth: number,
  maxNodes: number,
): DraftForest | undefined {
  const catalogued = parseSerializedForest(
    readAttribute(commit.attributes, COMPONENT_TREE_KEY),
    maxDepth,
    maxNodes,
  );
  if (catalogued !== undefined) {
    return catalogued;
  }

  let keys: string[];
  try {
    const declared = new Set(attributeKeysFor(commit.kind, { includeCommon: true }));
    keys = Object.keys(commit.attributes)
      .filter((key) => !declared.has(key))
      .sort(compareStrings);
  } catch {
    return undefined;
  }

  for (const key of keys) {
    const parsed = parseSerializedForest(readAttribute(commit.attributes, key), maxDepth, maxNodes);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * The renders that belong to one commit, and whether the match was exact.
 *
 * A commit is the parent span of the renders it performed, so the span
 * relationship is the exact answer. When a producer recorded renders without
 * that link, the commit's own time window inside its trace is the next best
 * association, and the whole capture is the last resort — each step reported as
 * inexact, because a reconstruction from the wrong renders would look exactly
 * like a reconstruction from the right ones.
 */
function selectCommitRenders(
  index: RenderIndex,
  commit: CommitRecord | undefined,
): { readonly records: readonly RenderRecord[]; readonly exact: boolean } {
  if (commit === undefined) {
    return { records: index.renders, exact: false };
  }

  const byParent = index.renders.filter((record) => record.parentSpanId === commit.spanId);
  if (byParent.length > 0) {
    return { records: byParent, exact: true };
  }

  const windowEnd = commit.startTime + commit.durationMs;
  const byWindow = index.renders.filter(
    (record) =>
      record.traceId === commit.traceId &&
      record.startTime >= commit.startTime &&
      record.startTime <= windowEnd,
  );
  if (byWindow.length > 0) {
    return { records: byWindow, exact: false };
  }

  return { records: index.renders, exact: false };
}

/**
 * One render's root-first path.
 *
 * The owner chain is nearest-first, so reversing it gives the ancestors from
 * the root down, and the rendered component itself is the last segment. A
 * producer that includes the component at the head of its own chain is handled
 * rather than doubled.
 */
function rootFirstPath(record: RenderRecord): readonly string[] {
  const chain = record.ownerChain;
  const ancestors = chain.length > 0 && chain[0] === record.component ? chain.slice(1) : chain;
  const path = [...ancestors].reverse();
  path.push(record.component);
  return path;
}

/** Map key for one level of the reconstruction trie. */
function levelKeyOf(component: string, key: string | undefined): string {
  return `${component}\u0000${key ?? ''}`;
}

/** A trie node used only while reconstructing, holding its own child index. */
interface DraftBuilder {
  readonly draft: TreeDraft;
  readonly children: Map<string, DraftBuilder>;
}

/**
 * Rebuilds a forest from the owner chains of a set of renders.
 *
 * Paths that share a prefix share nodes, which is what turns a flat list of
 * renders back into a tree. Two instances of one component under one parent
 * merge, because a chain of names carries no instance identity — the node's
 * cumulative count covers both, and the component-tree view is about which
 * components rendered, not about how many copies of one existed.
 */
function buildForestFromChains(records: readonly RenderRecord[]): {
  readonly roots: readonly TreeDraft[];
  readonly chainlessRenders: number;
} {
  const roots = new Map<string, DraftBuilder>();
  let chainlessRenders = 0;

  for (const record of records) {
    if (record.ownerChain.length === 0) {
      chainlessRenders += 1;
    }
    let level = roots;
    let parent: DraftBuilder | undefined;
    for (const segment of rootFirstPath(record)) {
      const levelKey = levelKeyOf(segment, undefined);
      let builder = level.get(levelKey);
      if (builder === undefined) {
        builder = {
          draft: { component: segment, key: undefined, children: [] },
          children: new Map<string, DraftBuilder>(),
        };
        level.set(levelKey, builder);
        if (parent !== undefined) {
          parent.draft.children.push(builder.draft);
        }
      }
      parent = builder;
      level = builder.children;
    }
  }

  return { roots: [...roots.values()].map((builder) => builder.draft), chainlessRenders };
}

/**
 * The last-resort forest: every component that rendered, as one level.
 *
 * Ordered the way {@link aggregateRenders} orders its rows — busiest first,
 * then by name — so the flat listing is at least useful, and so the same
 * capture always produces the same listing.
 */
function buildFlatForest(index: RenderIndex): readonly TreeDraft[] {
  return [...index.components.values()]
    .sort((left, right) => {
      if (left.renderCount !== right.renderCount) {
        return right.renderCount - left.renderCount;
      }
      return compareStrings(left.component, right.component);
    })
    .map((accumulator) => ({ component: accumulator.component, key: undefined, children: [] }));
}

/** One path segment of a node id: the name, plus the key when there is one. */
function segmentFor(draft: TreeDraft): string {
  const encodedName = encodeURIComponent(draft.component);
  return draft.key === undefined ? encodedName : `${encodedName}[${encodeURIComponent(draft.key)}]`;
}

/** Annotates one draft with the capture-wide numbers for its component. */
function buildNode(
  draft: TreeDraft,
  depth: number,
  path: readonly string[],
  children: readonly ComponentTreeNode[],
  index: RenderIndex,
): ComponentTreeNode {
  const accumulator = index.components.get(renderStatId(draft.component));
  const lastTrigger = accumulator?.lastTrigger;
  const lastRender = accumulator?.lastRender;
  const source = accumulator?.source;

  return {
    id: `${COMPONENT_TREE_NODE_ID_PREFIX}${path.join('/')}`,
    component: draft.component,
    ...(draft.key === undefined ? {} : { key: draft.key }),
    depth,
    renderCount: accumulator?.renderCount ?? 0,
    totalDurationMs: accumulator === undefined ? 0 : roundMs(accumulator.totalDuration),
    ...(lastTrigger === undefined ? {} : { lastTrigger }),
    // All three or none: a node that never rendered has no representative
    // event, and a partial reference would address nothing.
    ...(lastRender === undefined
      ? {}
      : {
          lastRenderEventId: lastRender.eventId,
          lastRenderSpanId: lastRender.spanId,
          lastRenderTraceId: lastRender.traceId,
        }),
    ...(source === undefined ? {} : { source }),
    children,
  };
}

/**
 * Emits one level of drafts, then their descendants, inside the bounds.
 *
 * Pre-order with a shared node budget: the nodes nearest the roots — the ones a
 * developer reads first — are the ones that survive a bound. Sibling instances
 * of one component are given an ordinal suffix so that ids stay unique inside a
 * snapshot without pretending the page had keys it did not.
 */
function emitLevel(
  drafts: readonly TreeDraft[],
  depth: number,
  parentPath: readonly string[],
  maxDepth: number,
  index: RenderIndex,
  state: WalkState,
): ComponentTreeNode[] {
  const nodes: ComponentTreeNode[] = [];
  const ordinals = new Map<string, number>();

  for (const draft of drafts) {
    if (depth > maxDepth || state.budget <= 0) {
      state.truncated = true;
      break;
    }

    const base = segmentFor(draft);
    const ordinal = (ordinals.get(base) ?? 0) + 1;
    ordinals.set(base, ordinal);
    const path = [...parentPath, ordinal > 1 ? `${base}#${String(ordinal)}` : base];

    state.budget -= 1;
    state.nodeCount += 1;
    if (depth > state.maxDepthSeen) {
      state.maxDepthSeen = depth;
    }

    const children = emitLevel(draft.children, depth + 1, path, maxDepth, index, state);
    nodes.push(buildNode(draft, depth, path, children, index));
  }

  return nodes;
}

/** Emits a whole forest and reports what it cost. */
function emitForest(
  roots: readonly TreeDraft[],
  index: RenderIndex,
  maxNodes: number,
  maxDepth: number,
): { roots: ComponentTreeNode[]; nodeCount: number; maxDepth: number; truncated: boolean } {
  const state: WalkState = { budget: maxNodes, nodeCount: 0, maxDepthSeen: 0, truncated: false };
  const emitted = emitLevel(roots, 0, [], maxDepth, index, state);
  return {
    roots: emitted,
    nodeCount: state.nodeCount,
    maxDepth: state.maxDepthSeen,
    truncated: state.truncated,
  };
}

/** Start of the latest render in the capture, when there was one. */
function lastRenderStartTime(renders: readonly RenderRecord[]): number | undefined {
  const last = renders[renders.length - 1];
  return last?.startTime;
}

/** A snapshot event and the forest its document parsed to. */
interface SnapshotForest {
  readonly record: SnapshotRecord;
  readonly forest: DraftForest;
}

/**
 * The latest snapshot event whose document parses, latest first.
 *
 * Latest wins because a capture can hold several — the agent takes one at each
 * capture stop, and the service may ask for one mid-capture — and the last one
 * describes the page as it most recently was. The records arrive in canonical
 * order, so "latest" is the same answer whatever order the events were handed
 * to this module in.
 *
 * Earlier snapshots are tried when a later document cannot be read at all: a
 * producer's unparseable last word is not a reason to discard a structure that
 * did arrive, and every route below this one is a reconstruction.
 */
function selectSnapshotForest(
  records: readonly SnapshotRecord[],
  maxDepth: number,
  maxNodes: number,
): SnapshotForest | undefined {
  for (let at = records.length - 1; at >= 0; at -= 1) {
    const record = records[at];
    if (record === undefined) {
      continue;
    }
    const forest = parseSerializedForest(record.serialized, maxDepth, maxNodes);
    if (forest !== undefined) {
      return { record, forest };
    }
  }
  return undefined;
}

/**
 * Splits the snapshot events into the ones that describe the selected commit's
 * structure and the ones that describe an earlier one.
 *
 * A snapshot is **current** when it was observed at or after the last commit:
 * nothing has committed since, so what it serialised is still the page's
 * shape. A snapshot observed *before* that commit is **stale** — the page has
 * committed again since it was taken — and a stale document is not the last
 * commit's structure however recently it arrived. The distinction matters
 * because a snapshot is not only taken at capture stop: the service can ask
 * the agent for one mid-capture, and a capture that renders afterwards then
 * holds a snapshot with a later commit behind it.
 *
 * Comparison is the canonical event order — start time, then ingest sequence,
 * then event id — the same rule that chose the commit, so a snapshot and a
 * commit sharing a millisecond are ordered by the store's sequence rather than
 * by luck.
 *
 * @param records Snapshot events in canonical order.
 * @param commit The commit the structure is attributed to, if the capture has
 * one. With no commit at all, every snapshot is current: there is no later
 * structure for it to be stale against.
 */
function partitionSnapshots(
  records: readonly SnapshotRecord[],
  commit: CommitRecord | undefined,
): { readonly current: readonly SnapshotRecord[]; readonly stale: readonly SnapshotRecord[] } {
  if (commit === undefined) {
    return { current: records, stale: [] };
  }

  const current: SnapshotRecord[] = [];
  const stale: SnapshotRecord[] = [];
  for (const record of records) {
    if (compareCanonically(record, commit) >= 0) {
      current.push(record);
    } else {
      stale.push(record);
    }
  }
  return { current, stale };
}

/**
 * The component structure of the page: the `componentTree` data source.
 *
 * ## Where the structure comes from
 *
 * The producer's own snapshot event first — the event named
 * {@link COMPONENT_TREE_EVENT_NAME}, which `../browser/agent.ts` emits at
 * capture stop while the last committed structure is still reachable, and
 * which therefore describes the page rather than the parts of it that
 * rendered. The latest such event wins, in canonical order, **among those
 * observed at or after the last commit**: the agent can also be asked for a
 * snapshot mid-capture, and a document serialised before the page committed
 * again is not that commit's structure. Its `componentTreeTruncated` flag —
 * and any node-level marker inside the document — is folded into this result's
 * own `truncated` and `degraded` fields, so a tree the producer had to reduce
 * is presented as reduced rather than as the page's whole structure.
 *
 * Failing that, a document attached to the **last commit of the capture** —
 * the commit with the greatest start time, ties broken by ingest sequence and
 * then event id, which is the canonical event order and therefore total. Any
 * earlier commit describes a shape the page has since left.
 *
 * Failing that, a **stale** snapshot: one taken before the last commit. It is
 * still the producer's own structure and beats a reconstruction, but it is
 * reported with no commit identity at all and always `degraded`, because the
 * page committed after it was taken. Then the owner chains of the individual
 * renders, and finally a flat listing.
 *
 * `commitEventId`, `commitSpanId` and `traceId` point at the last commit
 * whenever the structure can honestly be attributed to it — every route except
 * the stale snapshot — because those three fields are how a panel selects that
 * commit on the timeline, and naming a commit the structure predates would be
 * a claim about the page that the evidence does not support.
 *
 * ## Structure versus counts
 *
 * The numbers on each node come from the **whole capture**, because "this
 * component rendered 240 times" is the finding and no single commit shows it.
 * Structure and counts are read in one pass, so a node's count always equals
 * that component's row in {@link aggregateRenders}.
 *
 * Returns `undefined` — not an empty tree — when the capture holds no render,
 * no commit and no snapshot evidence at all, so the service can answer with an
 * empty result and the renderer can show its empty state instead of an invented
 * root.
 *
 * @param events Capture events, in any order.
 * @param options Node and depth bounds. See {@link ComponentTreeOptions}.
 * @returns The snapshot, or `undefined` when there is no rendering evidence.
 */
export function buildComponentTreeSnapshot(
  events: readonly TelemetryEvent[],
  options?: ComponentTreeOptions,
): ComponentTreeSnapshot | undefined {
  const index = indexRenderEvents(events);
  if (index.renders.length === 0 && index.commits.length === 0 && index.snapshots.length === 0) {
    return undefined;
  }

  const maxNodes = resolveBound(options?.maxNodes, DEFAULT_COMPONENT_TREE_MAX_NODES);
  const maxDepth = resolveBound(options?.maxDepth, DEFAULT_COMPONENT_TREE_MAX_DEPTH);
  const commit = index.commits[index.commits.length - 1];

  const partitioned = partitionSnapshots(index.snapshots, commit);

  const snapshot = selectSnapshotForest(partitioned.current, maxDepth, maxNodes);
  if (snapshot !== undefined) {
    const emitted = emitForest(snapshot.forest.roots, index, maxNodes, maxDepth);
    return assembleSnapshot({
      origin: COMMIT_SNAPSHOT_ORIGIN,
      // The snapshot was observed at or after the commit it is attributed to,
      // so its own start time is when this structure was observed.
      capturedAt: snapshot.record.startTime,
      commit,
      emitted,
      // Both mean nodes are missing from the document: the parser refused to
      // follow part of it, or the producer had already reduced the tree before
      // it was serialised.
      droppedWhileReading: snapshot.forest.truncated || snapshot.record.reduced,
      incomplete: false,
    });
  }

  const capturedAt = commit?.startTime ?? lastRenderStartTime(index.renders) ?? 0;

  if (commit !== undefined) {
    const serialized = findSerializedForest(commit, maxDepth, maxNodes);
    if (serialized !== undefined) {
      const emitted = emitForest(serialized.roots, index, maxNodes, maxDepth);
      return assembleSnapshot({
        origin: COMMIT_SNAPSHOT_ORIGIN,
        capturedAt,
        commit,
        emitted,
        droppedWhileReading: serialized.truncated,
        incomplete: false,
      });
    }
  }

  const stale = selectSnapshotForest(partitioned.stale, maxDepth, maxNodes);
  if (stale !== undefined) {
    const emitted = emitForest(stale.forest.roots, index, maxNodes, maxDepth);
    return assembleSnapshot({
      origin: COMMIT_SNAPSHOT_ORIGIN,
      // The structure is what it was when the snapshot was taken, which is
      // before the last commit — so that instant, and not the commit's, is
      // when it was observed.
      capturedAt: stale.record.startTime,
      // Deliberately **not** attributed to the last commit. The three commit
      // fields say "this is that commit's structure", and this document was
      // serialised before it: naming the commit would turn a stale tree into a
      // false claim about the page's final shape. Their absence also makes
      // `degraded` true on its own.
      commit: undefined,
      emitted,
      droppedWhileReading: stale.forest.truncated || stale.record.reduced,
      // The page committed again after this document was taken, so whatever it
      // shows is at best the shape of an earlier moment.
      incomplete: true,
    });
  }

  const selection = selectCommitRenders(index, commit);
  if (selection.records.some((record) => record.ownerChain.length > 0)) {
    const forest = buildForestFromChains(selection.records);
    const emitted = emitForest(forest.roots, index, maxNodes, maxDepth);
    return assembleSnapshot({
      origin: OWNER_CHAINS_ORIGIN,
      capturedAt,
      commit,
      emitted,
      droppedWhileReading: false,
      // A reconstruction is complete only when every render of an exactly
      // matched commit carried a whole chain.
      incomplete:
        !selection.exact ||
        forest.chainlessRenders > 0 ||
        selection.records.some((record) => record.ownerChainTruncated),
    });
  }

  const emitted = emitForest(buildFlatForest(index), index, maxNodes, maxDepth);
  return assembleSnapshot({
    origin: FLAT_ORIGIN,
    capturedAt,
    commit,
    emitted,
    droppedWhileReading: false,
    incomplete: true,
  });
}

/**
 * Assembles the transported snapshot.
 *
 * Two fields summarise the caveats, and they answer different questions.
 * `truncated` says nodes were dropped — by a bound during emission, or by the
 * parser refusing to follow a structure further. `degraded` is the disjunction
 * of every reason the structure might not be the page's: truncation, a flat
 * listing, an incomplete reconstruction, or no commit to anchor it to. It is
 * one field because the consumer's decision is one decision — caveat the tree,
 * or present it.
 */
function assembleSnapshot(input: {
  readonly origin: ComponentTreeOrigin;
  readonly capturedAt: number;
  readonly commit: CommitRecord | undefined;
  readonly emitted: {
    roots: ComponentTreeNode[];
    nodeCount: number;
    maxDepth: number;
    truncated: boolean;
  };
  /** Nodes dropped before emission, by the structural parser. */
  readonly droppedWhileReading: boolean;
  readonly incomplete: boolean;
}): ComponentTreeSnapshot {
  const { commit, emitted } = input;
  const truncated = emitted.truncated || input.droppedWhileReading;
  const degraded =
    input.origin === FLAT_ORIGIN || truncated || input.incomplete || commit === undefined;

  return {
    capturedAt: input.capturedAt,
    ...(commit === undefined
      ? {}
      : {
          commitEventId: commit.eventId,
          commitSpanId: commit.spanId,
          traceId: commit.traceId,
        }),
    origin: input.origin,
    degraded,
    roots: emitted.roots,
    nodeCount: emitted.nodeCount,
    maxDepth: emitted.maxDepth,
    truncated,
  };
}
