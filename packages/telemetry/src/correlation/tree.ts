/**
 * The trace tree: the **type contract and the pure tree algebra** behind the
 * product's headline capability — one click resolving to one ordered tree that
 * spans the browser event handler, the React work it caused, the `fetch` it
 * issued, the Next.js route handler that answered, the service functions that
 * ran, the SQL they executed and the external calls they made (AAP 0.2.3,
 * 0.4.2, 0.8.1 slice 7).
 *
 * ## What lives here, and what lives next door
 *
 * This module defines the **shape** and every operation that is a function of
 * that shape alone. The sibling `./correlator.ts` does the *building*: it owns
 * the canonical ordering comparator (parent before child, then `startTime`,
 * then `(producerId, seq)`, then `ingestSeq` as the always-distinct
 * tie-breaker — see `../schema/event.ts`, which deliberately delegates it),
 * the parent lookup, the orphan and cycle detection and the depth guard. That
 * split is what lets the renderers, the aggregates and the service share one
 * vocabulary without each of them re-deriving a tree walk:
 *
 * - `../aggregate/*` computes capture metrics and the per-source `DataResult`
 *   shapes from a correlated tree.
 * - `apps/local-service/src/telemetry/correlate.ts` re-correlates
 *   incrementally as a capture streams in, and
 *   `apps/local-service/src/panels/data.ts` serves the result.
 * - `packages/panel-renderer`'s `Timeline`, `FlameChart` and `Waterfall`
 *   iterate {@link flattenTrace} and read {@link selfTimeOf} /
 *   {@link totalTimeOf}; the DevTools `EventDetails` drawer renders
 *   {@link ancestorsOfSpanId} as its parent chain (AAP 0.7.3).
 *
 * ## The tree crosses a process boundary, so it is plain JSON
 *
 * A {@link TraceTree} is the response body of
 * `POST /sessions/:id/panel-data` with `{ source: 'trace', filter: { traceId } }`
 * (AAP 0.4.2). Everything here is therefore built from plain objects, arrays,
 * strings, numbers and booleans:
 *
 * - **no `Map`, no `Set`, no class instance, no function** on any exported
 *   shape (the two `Set`s used inside {@link buildTraceTree} and the `Map`
 *   inside {@link ancestorsOfSpanId} are local scratch, never returned);
 * - **no parent back-reference on a node.** A child pointing back at its
 *   parent is a cycle, and `JSON.stringify` throws on one. {@link walkNode}
 *   hands the parent to its visitor instead, and {@link ancestorsOfSpanId}
 *   reconstructs a chain on demand;
 * - **absent optional fields are omitted, never set to `undefined`.** With
 *   this repository's `exactOptionalPropertyTypes` that is also what the types
 *   say, and it is what makes `JSON.parse(JSON.stringify(tree))` deeply equal
 *   to the original — the property set survives the round trip.
 *
 * ## Pure, deterministic, environment-neutral
 *
 * No input event, node or array is ever mutated: persisted events are parsed
 * byte-faithfully by `../schema/event.ts` and are re-correlated repeatedly as
 * a capture grows, so mutating one would corrupt stored evidence. Nothing here
 * reads a clock, a random source, a `node:*` builtin or a DOM global — the
 * package's library entry re-exports this file and tsup builds that graph with
 * `platform: 'neutral'`, so a single environment-specific reference anywhere in
 * it fails the build.
 *
 * Determinism extends to ordering: `children` arrives in canonical order from
 * the correlator and is **never re-sorted** here or downstream, and every walk
 * in this module is depth-first pre-order over that order, implemented with an
 * explicit stack so a pathologically deep trace cannot overflow the call stack.
 *
 * @packageDocumentation
 */

import { clampNonNegative, roundMs } from '@debuggen/shared';
import type { ProducerId, SpanId, TraceId } from '@debuggen/shared';

import { CORRELATION_ATTRIBUTE_KEYS, LINEAGE_ATTRIBUTE_KEYS } from '../schema/attributes.js';
import type { TelemetryEvent } from '../schema/event.js';
import { TELEMETRY_KINDS, TELEMETRY_TIERS } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryTier } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Vocabularies
 * ---------------------------------------------------------------------------
 */

/**
 * Why the correlator could not place an event under the parent it named.
 *
 * Each member describes a *repair*, never a discard: an event whose parentage
 * could not be resolved is still real captured evidence, so it is attached to
 * the trace root and flagged. Dropping it would silently remove all the work
 * underneath it from every duration in the capture (AAP 0.4.2).
 *
 * - `missing-parent` — the event named a `parentSpanId` that never arrived.
 *   The producer of the parent disconnected before flushing, the parent was
 *   rejected at ingest, or the parent belongs to a capture that has ended.
 *   This is the common case, and the one the service also records on the event
 *   itself (see {@link orphanFlagsOf}).
 * - `self-parent` — the event named itself (`parentSpanId === spanId`), which
 *   no correct producer emits and which would make the node its own ancestor.
 * - `cycle` — the parent chain led back to the event, so the named parentage
 *   described a loop rather than a tree.
 * - `max-depth` — the event sat deeper than the correlator's depth guard
 *   ({@link DEFAULT_MAX_DEPTH}) allowed, so it was lifted to the root instead
 *   of extending an implausibly deep chain.
 *
 * Frozen: a read-only vocabulary, in the order a reviewer reads it — the
 * unremarkable case first, then the three malformed ones.
 */
export const ORPHAN_REASONS = Object.freeze([
  'missing-parent',
  'self-parent',
  'cycle',
  'max-depth',
] as const);

/** One member of the closed {@link ORPHAN_REASONS} vocabulary. */
export type OrphanReason = (typeof ORPHAN_REASONS)[number];

/**
 * The reason {@link orphanFlagsOf} reports, read from the tuple rather than
 * retyped: the flag the service writes onto an event records *that* the parent
 * was unresolvable, never which of the four ways it happened, and
 * `missing-parent` is the one of the four that is not a producer bug.
 *
 * A literal index into a frozen `as const` tuple keeps the exact literal type
 * (`noUncheckedIndexedAccess` widens index signatures and arrays, not tuples),
 * so this needs no assertion.
 */
const ORPHAN_REASON_MISSING_PARENT: OrphanReason = ORPHAN_REASONS[0];

/**
 * The deepest node the correlator will place before it treats the input as
 * pathological: 1024.
 *
 * It is a guard against malformed input rather than a product limit. A real
 * correlated trace is a handful of levels deep — interaction, commit, render,
 * fetch, server request, route handler, service function, query — and even a
 * deeply recursive React tree contributes tens, not hundreds. A chain longer
 * than this means a producer emitted parentage that is not a tree (a long
 * spurious chain, or a cycle the cheaper checks missed), and the honest
 * response is to stop extending it and flag the node with
 * `'max-depth'` from {@link ORPHAN_REASONS} instead of building a structure no
 * renderer can draw.
 *
 * The constant lives here, with the shape, so the correlator and its tests
 * cannot disagree about the number; a caller that needs a different bound
 * passes its own rather than editing this one.
 */
export const DEFAULT_MAX_DEPTH = 1024;

/*
 * ---------------------------------------------------------------------------
 * Attribute keys
 *
 * `../schema/attributes.ts` is the only place the lineage and correlation key
 * strings may be enumerated, and it publishes them as `readonly string[]`
 * groups rather than as literal tuples. Positional indexing into those groups
 * would silently misread every lineage attribute if the declaration order
 * there ever changed (an alphabetical tidy-up is enough), so each key is
 * resolved by the suffix that identifies its *role* — which is how that module
 * documents them.
 * ---------------------------------------------------------------------------
 */

/** Suffix identifying the ambiguity flag within {@link LINEAGE_ATTRIBUTE_KEYS}. */
const AMBIGUOUS_KEY_SUFFIX = 'Ambiguous';

/** Suffix identifying the candidate-span list within {@link LINEAGE_ATTRIBUTE_KEYS}. */
const CANDIDATES_KEY_SUFFIX = 'Candidates';

/**
 * Suffix identifying the intended-parent id within
 * {@link CORRELATION_ATTRIBUTE_KEYS}.
 */
const PARENT_SPAN_ID_KEY_SUFFIX = 'ParentSpanId';

/**
 * The first key in `keys` ending with `suffix`, or `undefined` when the group
 * carries no such key.
 *
 * `undefined` is a real answer rather than an impossibility: this module must
 * keep working — reading one attribute less — if the key group it depends on is
 * ever reshaped, because the alternative is a schema package change that makes
 * the correlator throw at ingest.
 */
function keyEndingWith(keys: readonly string[], suffix: string): string | undefined {
  return keys.find((key) => key.endsWith(suffix));
}

/**
 * The first key in `keys` ending with none of `suffixes`: the group's base key,
 * the one the qualifying flags qualify (`lineage` beside `lineageAmbiguous`,
 * `orphaned` beside `orphanedParentSpanId`).
 */
function keyEndingWithNone(
  keys: readonly string[],
  suffixes: readonly string[],
): string | undefined {
  return keys.find((key) => !suffixes.some((suffix) => key.endsWith(suffix)));
}

/** The key holding the lineage mechanism, conventionally `lineage`. */
const LINEAGE_VALUE_KEY = keyEndingWithNone(LINEAGE_ATTRIBUTE_KEYS, [
  AMBIGUOUS_KEY_SUFFIX,
  CANDIDATES_KEY_SUFFIX,
]);

/** The key holding the ambiguity flag, conventionally `lineageAmbiguous`. */
const LINEAGE_AMBIGUOUS_KEY = keyEndingWith(LINEAGE_ATTRIBUTE_KEYS, AMBIGUOUS_KEY_SUFFIX);

/** The key holding the rejected candidates, conventionally `lineageCandidates`. */
const LINEAGE_CANDIDATES_KEY = keyEndingWith(LINEAGE_ATTRIBUTE_KEYS, CANDIDATES_KEY_SUFFIX);

/** The key holding the service's orphan flag, conventionally `orphaned`. */
const ORPHANED_KEY = keyEndingWithNone(CORRELATION_ATTRIBUTE_KEYS, [PARENT_SPAN_ID_KEY_SUFFIX]);

/**
 * The key holding the parent the orphaned event named, conventionally
 * `orphanedParentSpanId`.
 */
const ORPHANED_PARENT_SPAN_ID_KEY = keyEndingWith(
  CORRELATION_ATTRIBUTE_KEYS,
  PARENT_SPAN_ID_KEY_SUFFIX,
);

/** The shared empty list every "nothing to report" answer returns. */
const EMPTY_STRING_LIST: readonly string[] = Object.freeze([]);

/*
 * ---------------------------------------------------------------------------
 * Defensive attribute reads
 *
 * `attributes` is an open record of `unknown` (`../schema/event.ts` validates
 * that its values are transportable and nothing more), and these values are
 * written by three independent producers. Every read below therefore narrows
 * and never coerces: a malformed attribute costs the field it would have
 * populated, never an exception on the ingest path (AAP 0.5.5).
 * ---------------------------------------------------------------------------
 */

/**
 * The value at `key`, or `undefined` when there is no key to read or the bag
 * does not carry it.
 */
function attributeValue(
  attributes: TelemetryEvent['attributes'],
  key: string | undefined,
): unknown {
  if (key === undefined) {
    return undefined;
  }
  return attributes[key];
}

/** `value` when it is a non-empty string, otherwise `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Whether a value is an array, narrowed to `readonly unknown[]`.
 *
 * A local predicate rather than a bare `Array.isArray`, which narrows
 * `unknown` to `any[]` and would spread `any` — and the type-aware lint rules
 * that forbid it — through every element read.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * The non-empty strings of an array attribute, in their original order.
 *
 * A non-array, or an array of anything else, yields the empty list: the
 * candidate list is a diagnostic aid, so a malformed one is reported as "no
 * candidates" rather than as a parse failure.
 */
function stringList(value: unknown): readonly string[] {
  if (!isUnknownArray(value)) {
    return EMPTY_STRING_LIST;
  }

  const strings: string[] = [];
  for (const entry of value) {
    const text = nonEmptyString(entry);
    if (text === undefined) {
      continue;
    }
    strings.push(text);
  }
  return strings;
}

/*
 * ---------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------
 */

/**
 * How a node was attributed to its trace across an asynchronous boundary.
 *
 * Present only on a node whose event carries the lineage attributes written by
 * `../browser/continuation.ts`, which keeps a continuation window open on a
 * settled request so the React work that follows a response joins the
 * interaction's trace instead of starting a new one (AAP 0.4.2).
 *
 * - `value` is the mechanism the producer claimed. It normally holds a member
 *   of `LINEAGE_VALUES` in `../schema/attributes.ts` — today the
 *   async-continuation marker — and is typed as `string` rather than as that
 *   union on purpose: a second attribution mechanism adds a value to that
 *   vocabulary, and a tree built by a newer producer must still be readable by
 *   an older renderer, which shows the marker rather than discarding the edge.
 * - `ambiguous` is the field that changes what a developer sees: more than one
 *   settled request had an open continuation window when the event landed, so
 *   the attribution is the most recently settled candidate rather than a
 *   certainty, and `Timeline` draws the edge **dashed** instead of presenting
 *   a guess as a fact (AAP 0.4.2).
 * - `candidateSpanIds` carries the other candidates, so the alternative
 *   attributions stay inspectable rather than being discarded. It is empty
 *   when the attribution was unambiguous.
 */
export interface TraceNodeLineage {
  /** The attribution mechanism the producer claimed, verbatim. */
  readonly value: string;
  /** Whether more than one candidate parent was open at attribution time. */
  readonly ambiguous: boolean;
  /** The span ids of the candidates that were not chosen; empty when there were none. */
  readonly candidateSpanIds: readonly SpanId[];
}

/**
 * The orphan state of one node, as the builder reports it.
 *
 * The **input** counterpart of {@link TraceNode}'s `orphanReason` and
 * `missingParentSpanId`: it exists so {@link createTraceNode} takes one
 * optional bag instead of a pair of positional arguments that are easy to
 * transpose. Both members are declared `| undefined` precisely because a
 * caller computes them — the correlator writes
 * `{ orphanReason: reasonOrUndefined }` — whereas the node's own properties are
 * not, so an absent value is an absent *key* on the result (see
 * {@link createTraceNode}).
 *
 * An empty bag (`{}`) is meaningful and is the authoritative way to say "this
 * node is placed correctly": see the note on {@link orphanFlagsOf} about why a
 * flag stored on an event must never override the builder's own knowledge.
 */
export interface TraceNodeOrphanFlags {
  /** Why the node could not be placed under the parent it named. */
  readonly orphanReason?: OrphanReason | undefined;
  /** The `parentSpanId` that could not be resolved, when the event named one. */
  readonly missingParentSpanId?: SpanId | undefined;
}

/**
 * One event and the events it caused: a node of a correlated trace.
 *
 * ## Deliberately no parent pointer
 *
 * A `parent` property would make the tree cyclic, and a cyclic object is not
 * JSON — `JSON.stringify` throws on it, which would break the panel-data
 * response this shape is served as (AAP 0.4.2). The parent is available
 * wherever it is needed: {@link walkNode} passes it to its visitor and
 * {@link ancestorsOfSpanId} rebuilds a whole chain.
 *
 * ## `children` is already in canonical order
 *
 * The correlator sorts siblings once, by the ordering `../schema/event.ts`
 * documents (`startTime`, then `(producerId, seq)`, then `ingestSeq`), and a
 * consumer **must not re-sort them**. Re-sorting is not a harmless preference:
 * two events from different producers can share a millisecond, and only the
 * correlator holds the tie-breakers that make the order total. A view that
 * wants a different order — slowest first, say — derives its own array from
 * {@link flattenNode} and leaves the tree alone.
 *
 * ## An orphaned node is evidence, not filler
 *
 * `orphaned` marks a node the correlator could not place where its event said
 * it belonged, so it was attached to the trace root instead (see
 * {@link ORPHAN_REASONS}). It is a real captured operation with real timings:
 * it is rendered, counted and citable as evidence, and it is flagged so that
 * the tree is not mistaken for the shape the application actually had. It is
 * never a placeholder the product invented, and there is no synthetic node
 * type in this module for the same reason.
 */
export interface TraceNode {
  /** The captured event this node represents, exactly as the store holds it. */
  readonly event: TelemetryEvent;
  /** The events this one caused, in canonical order; never re-sorted by a consumer. */
  readonly children: readonly TraceNode[];
  /** Distance from the trace root: `0` at a root, one more per level. */
  readonly depth: number;
  /** Whether the correlator had to re-attach this node rather than place it. */
  readonly orphaned: boolean;
  /** Why it was re-attached. Present if and only if `orphaned` is `true`. */
  readonly orphanReason?: OrphanReason;
  /** The `parentSpanId` that could not be resolved, when the event named one. */
  readonly missingParentSpanId?: SpanId;
  /** How the node joined its trace, when it crossed an asynchronous boundary. */
  readonly lineage?: TraceNodeLineage;
}

/**
 * One interaction's events, correlated into one ordered tree with the
 * aggregates a renderer needs to lay it out.
 *
 * ## One root is the well-formed case
 *
 * A trace that was captured completely has exactly one root: the interaction
 * that started it. Several roots is a normal, reportable condition rather than
 * an error — server spans whose browser parent never arrived (the page
 * navigated, the agent was armed after the request began, the browser batch
 * was lost) are attached as roots so their work is still visible (AAP 0.4.2).
 * {@link primaryRootSpanId} is what a view anchors on when there is more than
 * one; `roots.length > 1` is what tells it to say so.
 *
 * ## The numbers are derived, never accumulated by a caller
 *
 * Every count and timestamp below is computed by {@link buildTraceTree} from
 * one walk of `roots`, so they cannot drift from the nodes they describe. An
 * **empty** trace — a `traceId` with no events, which a query for a trace that
 * has been purged or has not arrived yet produces — reports zeroes and empty
 * lists rather than `undefined` or sentinel values: a caller laying out a
 * timeline gets arithmetic that works (`0` width, `0` duration) instead of a
 * special case, and `nodeCount === 0` is the unambiguous test for emptiness.
 */
export interface TraceTree {
  /** The correlation id every event in this tree shares: 32 lowercase hex characters. */
  readonly traceId: TraceId;
  /** The roots, in canonical order. Exactly one in a well-formed trace. */
  readonly roots: readonly TraceNode[];
  /** The span id a view should anchor on; absent only when the tree is empty. */
  readonly primaryRootSpanId?: SpanId;
  /** How many nodes the tree holds, at every depth. `0` for an empty trace. */
  readonly nodeCount: number;
  /** The greatest `depth` present: `0` for a single-level tree, `0` when empty. */
  readonly maxDepth: number;
  /** The earliest `event.startTime` in the tree, in Unix epoch milliseconds; `0` when empty. */
  readonly startTime: number;
  /** The latest `event.startTime + event.duration` in the tree; `0` when empty. */
  readonly endTime: number;
  /** `endTime - startTime` in milliseconds, clamped at zero and rounded. */
  readonly totalDuration: number;
  /** How many nodes the correlator had to re-attach (see {@link ORPHAN_REASONS}). */
  readonly orphanCount: number;
  /** The tiers present, in `TELEMETRY_TIERS` declaration order. */
  readonly tiers: readonly TelemetryTier[];
  /**
   * The kinds present, in `TELEMETRY_KINDS` declaration order.
   *
   * Declaration order rather than first-seen order because the renderer builds
   * its lanes and its legend from this list: lanes that reorder themselves
   * between two captures of the same interaction are unreadable.
   */
  readonly kinds: readonly TelemetryKind[];
  /** The producers that contributed, in ascending id order. */
  readonly producerIds: readonly ProducerId[];
  /** Span ids the correlator saw more than once in its input; empty in the normal case. */
  readonly duplicateSpanIds: readonly SpanId[];
  /** Whether the correlator stopped short of including everything it was given. */
  readonly truncated: boolean;
}

/**
 * The facts about a correlated trace that only its builder knows.
 *
 * {@link buildTraceTree} derives everything it can see from the nodes it is
 * handed; these three cannot be seen from the result, so the correlator passes
 * them in:
 *
 * - `primaryRootSpanId` — which root to anchor on, when the correlator has a
 *   better answer than "the first one" (the browser interaction, say, when a
 *   server span sorts ahead of it).
 * - `duplicateSpanIds` — span ids that arrived twice. A duplicate is visible
 *   only in the correlator's *input*: whichever copy it dropped is not in the
 *   tree, so the tree cannot report it.
 * - `truncated` — whether something was left out, for example by the depth
 *   guard or a caller's node budget. A view must be able to say "this is part
 *   of the trace" rather than implying completeness.
 *
 * All three are optional; omitting the bag entirely yields the first root's
 * span id, no duplicates and `truncated: false`.
 */
export interface TraceTreeExtra {
  /** The root a view should anchor on, overriding "the first root". */
  readonly primaryRootSpanId?: SpanId | undefined;
  /** Span ids seen more than once in the correlator's input. */
  readonly duplicateSpanIds?: readonly SpanId[] | undefined;
  /** Whether the tree omits part of what the correlator was given. */
  readonly truncated?: boolean | undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Attribute readers
 *
 * Two functions, and they are the package's **only** readers of the lineage
 * and correlation attribute groups: a second reader elsewhere would be a
 * second interpretation of the same keys.
 * ---------------------------------------------------------------------------
 */

/**
 * Reads an event's lineage attributes, or reports that it has none.
 *
 * Called by {@link createTraceNode}, so a node built through that factory
 * carries its lineage without the caller having to know the attribute keys.
 *
 * ## What counts as a lineage record
 *
 * A usable mechanism name. `value` is taken only from a non-empty string at
 * the lineage key; an event carrying `lineageAmbiguous` or `lineageCandidates`
 * **without** such a string reports no lineage at all, because those two
 * qualify a mechanism and naming one the producer did not claim would be
 * exactly the coercion this module refuses. `ambiguous` is `true` only for the
 * boolean `true` — the string `'true'`, the number `1` and a truthy object are
 * all ignored, since an attribute bag is not a query string and a producer
 * that means `true` sends `true`.
 *
 * Nothing here throws and nothing is coerced: a malformed attribute costs the
 * field it would have filled.
 *
 * @param event Any captured event.
 * @returns The lineage record, or `undefined` when the event carries no usable
 * lineage attribute.
 */
export function lineageOf(event: TelemetryEvent): TraceNodeLineage | undefined {
  const attributes = event.attributes;
  const value = nonEmptyString(attributeValue(attributes, LINEAGE_VALUE_KEY));
  if (value === undefined) {
    return undefined;
  }

  return {
    value,
    ambiguous: attributeValue(attributes, LINEAGE_AMBIGUOUS_KEY) === true,
    candidateSpanIds: stringList(attributeValue(attributes, LINEAGE_CANDIDATES_KEY)),
  };
}

/**
 * Reads the orphan flags the service recorded **on an event**, or reports that
 * it carries none.
 *
 * `apps/local-service/src/telemetry/correlate.ts` writes the correlation
 * attribute group (`orphaned`, `orphanedParentSpanId`) when it persists an
 * event it could not place, so that the repair survives in the store and is
 * visible to anything reading a flat event list rather than a tree. This is
 * the reader that matches that writer, kept here beside the node shape so the
 * key strings are interpreted in exactly one place.
 *
 * ## Why {@link createTraceNode} does not call it
 *
 * A stored flag is a record of what *one earlier correlation pass* concluded,
 * and a capture is correlated repeatedly as it streams in: an event whose
 * parent arrived late was orphaned then and is placed correctly now. Letting a
 * stale flag reach the node would re-orphan a correctly placed subtree, so the
 * builder's own knowledge always wins and orphan state is passed explicitly —
 * `{}` for "placed correctly". Use this function when re-hydrating node flags
 * for events whose parentage is **not** being recomputed.
 *
 * The reason is always `'missing-parent'`: the stored flag records that the
 * parent was unresolvable, not which of the four {@link ORPHAN_REASONS} cases
 * applied.
 *
 * @param event Any captured event.
 * @returns The flags to pass to {@link createTraceNode}, or `undefined` when
 * the event is not marked as orphaned.
 */
export function orphanFlagsOf(event: TelemetryEvent): TraceNodeOrphanFlags | undefined {
  const attributes = event.attributes;
  if (attributeValue(attributes, ORPHANED_KEY) !== true) {
    return undefined;
  }

  const missingParentSpanId = nonEmptyString(
    attributeValue(attributes, ORPHANED_PARENT_SPAN_ID_KEY),
  );
  if (missingParentSpanId === undefined) {
    return { orphanReason: ORPHAN_REASON_MISSING_PARENT };
  }

  return { orphanReason: ORPHAN_REASON_MISSING_PARENT, missingParentSpanId };
}

/*
 * ---------------------------------------------------------------------------
 * Constructors
 *
 * The two functions the correlator builds a tree with. Both exist so that the
 * invariants of {@link TraceNode} and {@link TraceTree} — the omitted optional
 * key, the orphan flag pair, every derived aggregate — are established in one
 * place instead of at each of the correlator's call sites.
 * ---------------------------------------------------------------------------
 */

/** The shared empty child list every leaf node carries. */
const EMPTY_NODE_LIST: readonly TraceNode[] = Object.freeze([]);

/**
 * The assembly view of {@link TraceNode}: the same properties without
 * `readonly`, so the factory can add an optional key only when it has a value
 * for it.
 *
 * This is what `exactOptionalPropertyTypes` costs and buys. A conditional
 * spread would type each optional property as `T | undefined` and so would not
 * satisfy {@link TraceNode}, while assigning `undefined` outright would put a
 * key with an `undefined` value on the result — which JSON drops, making a
 * round-tripped tree structurally different from the one the service built.
 * Assembling here and returning the finished object keeps "absent means the
 * key is not there" literally true. A mutable object is assignable to its
 * `readonly` counterpart, so no assertion is needed.
 */
interface MutableTraceNode {
  event: TelemetryEvent;
  children: readonly TraceNode[];
  depth: number;
  orphaned: boolean;
  orphanReason?: OrphanReason;
  missingParentSpanId?: SpanId;
  lineage?: TraceNodeLineage;
}

/**
 * Assembles one {@link TraceNode}.
 *
 * ## Invariants it establishes
 *
 * - `orphaned === (orphanReason !== undefined)`. The pair cannot disagree,
 *   because `orphaned` is computed from the reason rather than passed: a
 *   caller that knows a node is misplaced always knows why.
 * - `missingParentSpanId` is kept **only** on an orphaned node. It names the
 *   repair that was needed, so on a correctly placed node it would describe
 *   work that did not happen, and a view rendering "parent not found" beside a
 *   node that has its parent is worse than no annotation at all.
 * - `lineage` is filled from the event itself through {@link lineageOf}, so no
 *   caller needs the attribute keys and no node can disagree with its event.
 * - `children` is copied, so the node is immutable once built even if the
 *   caller keeps filling the array it passed. A leaf shares one frozen empty
 *   list rather than allocating per node — most nodes of a real capture are
 *   leaves.
 * - Absent optional keys are **omitted**, never set to `undefined`.
 *
 * @param event The captured event this node represents.
 * @param children The nodes for the events it caused, already in canonical
 * order (this factory does not sort: only the correlator holds the
 * tie-breakers).
 * @param depth Distance from the trace root, `0` at a root. A value that is
 * not a non-negative integer is a builder bug; it is recorded as `0` rather
 * than propagated, so that a `NaN` cannot poison {@link TraceTree.maxDepth}
 * and a fractional value cannot become a half-level in a layout.
 * @param flags Why the node had to be re-attached, if it did. Omit it — or
 * pass `{}` — for a correctly placed node.
 * @returns A node satisfying every invariant above.
 *
 * @example
 * ```ts
 * const leaf = createTraceNode(queryEvent, [], 3);
 * const handler = createTraceNode(routeEvent, [leaf], 2);
 * const detached = createTraceNode(serverEvent, [], 0, {
 *   orphanReason: 'missing-parent',
 *   missingParentSpanId: serverEvent.parentSpanId,
 * });
 * ```
 */
export function createTraceNode(
  event: TelemetryEvent,
  children: readonly TraceNode[],
  depth: number,
  flags?: TraceNodeOrphanFlags,
): TraceNode {
  const orphanReason = flags?.orphanReason;
  const node: MutableTraceNode = {
    event,
    children: children.length === 0 ? EMPTY_NODE_LIST : [...children],
    depth: Number.isInteger(depth) && depth >= 0 ? depth : 0,
    orphaned: orphanReason !== undefined,
  };

  if (orphanReason !== undefined) {
    node.orphanReason = orphanReason;

    const missingParentSpanId = flags?.missingParentSpanId;
    if (missingParentSpanId !== undefined) {
      node.missingParentSpanId = missingParentSpanId;
    }
  }

  const lineage = lineageOf(event);
  if (lineage !== undefined) {
    node.lineage = lineage;
  }

  return node;
}

/** The assembly view of {@link TraceTree}; see {@link MutableTraceNode}. */
interface MutableTraceTree {
  traceId: TraceId;
  roots: readonly TraceNode[];
  primaryRootSpanId?: SpanId;
  nodeCount: number;
  maxDepth: number;
  startTime: number;
  endTime: number;
  totalDuration: number;
  orphanCount: number;
  tiers: readonly TelemetryTier[];
  kinds: readonly TelemetryKind[];
  producerIds: readonly ProducerId[];
  duplicateSpanIds: readonly SpanId[];
  truncated: boolean;
}

/**
 * Orders identifiers by UTF-16 code unit, deterministically and without a
 * locale.
 *
 * `Array.prototype.sort`'s default comparator would do the same thing for
 * strings, and `localeCompare` would not: its order depends on the host's
 * locale data, so two machines could serialise the same trace differently.
 * Stating the comparator makes the order a property of this module.
 */
function compareIdentifiers(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Assembles a {@link TraceTree} from its roots, deriving every aggregate in
 * one depth-first walk.
 *
 * `traceId` is taken from the caller rather than read off a node: an empty
 * trace has no node to read it from, and the correlator has already grouped
 * its input by that id, so re-deriving it here could only disagree.
 *
 * ## The empty trace
 *
 * `roots: []` yields `nodeCount`, `maxDepth`, `startTime`, `endTime` and
 * `totalDuration` all `0`, empty lists throughout and no
 * `primaryRootSpanId`. That is a deliberate choice over `undefined` or
 * `-Infinity` sentinels: querying a trace that has been purged, or one whose
 * events have not arrived yet, is an ordinary outcome of the panel-data route,
 * and a caller laying out a timeline gets arithmetic that works instead of a
 * special case. `nodeCount === 0` is the test for emptiness.
 *
 * ## Timestamps
 *
 * `startTime` is the smallest `event.startTime` present and `endTime` the
 * largest {@link nodeEndTime}; neither is assumed to belong to a root, because
 * a child can start before its parent (clock skew between the browser agent
 * and the dev-server preload, AAP 0.2.3) and a child can outlive it (a
 * fire-and-forget request). Non-finite values are skipped rather than
 * propagated, so one unusable reading cannot make the whole trace unusable.
 * `totalDuration` is clamped at zero and rounded through the product's single
 * rounding policy so that the same trace serialises to the same digits twice.
 *
 * @param traceId The correlation id every event in the tree shares.
 * @param roots The root nodes, already in canonical order.
 * @param extra The facts only the builder knows; see {@link TraceTreeExtra}.
 * @returns A fully derived, JSON-serialisable tree.
 */
export function buildTraceTree(
  traceId: TraceId,
  roots: readonly TraceNode[],
  extra?: TraceTreeExtra,
): TraceTree {
  const rootList = roots.length === 0 ? EMPTY_NODE_LIST : [...roots];

  let nodeCount = 0;
  let maxDepth = 0;
  let orphanCount = 0;
  let earliestStart: number | undefined;
  let latestEnd: number | undefined;
  const presentTiers = new Set<TelemetryTier>();
  const presentKinds = new Set<TelemetryKind>();
  const presentProducers = new Set<ProducerId>();

  for (const root of rootList) {
    walkNode(root, (node) => {
      nodeCount += 1;
      if (node.depth > maxDepth) {
        maxDepth = node.depth;
      }
      if (node.orphaned) {
        orphanCount += 1;
      }

      presentTiers.add(node.event.tier);
      presentKinds.add(node.event.kind);
      presentProducers.add(node.event.producerId);

      const start = node.event.startTime;
      if (Number.isFinite(start) && (earliestStart === undefined || start < earliestStart)) {
        earliestStart = start;
      }

      const end = nodeEndTime(node);
      if (Number.isFinite(end) && (latestEnd === undefined || end > latestEnd)) {
        latestEnd = end;
      }
    });
  }

  const startTime = earliestStart ?? 0;
  const endTime = latestEnd ?? 0;

  const tree: MutableTraceTree = {
    traceId,
    roots: rootList,
    nodeCount,
    maxDepth,
    startTime,
    endTime,
    totalDuration: roundMs(clampNonNegative(endTime - startTime)),
    orphanCount,
    tiers: TELEMETRY_TIERS.filter((tier) => presentTiers.has(tier)),
    kinds: TELEMETRY_KINDS.filter((kind) => presentKinds.has(kind)),
    producerIds: [...presentProducers].sort(compareIdentifiers),
    duplicateSpanIds:
      extra?.duplicateSpanIds === undefined ? EMPTY_STRING_LIST : [...extra.duplicateSpanIds],
    truncated: extra?.truncated ?? false,
  };

  const primaryRootSpanId = extra?.primaryRootSpanId ?? rootList[0]?.event.spanId;
  if (primaryRootSpanId !== undefined) {
    tree.primaryRootSpanId = primaryRootSpanId;
  }

  return tree;
}

/*
 * ---------------------------------------------------------------------------
 * Traversal
 *
 * One order — depth-first **pre-order**, siblings in the order the correlator
 * put them in — and one implementation technique: an explicit stack. Recursion
 * is avoided deliberately. The depth guard ({@link DEFAULT_MAX_DEPTH}) bounds
 * what the correlator *builds*, but these helpers also run on trees that
 * arrived over HTTP from another build, and a stack overflow inside a
 * traversal would take the service's ingest loop or the DevTools panel with
 * it. An explicit stack turns "too deep" into memory pressure instead of a
 * crash.
 *
 * Pre-order is the contract, not an implementation detail: it is where
 * AAP 0.2.3's "parent before child" guarantee becomes observable, and the
 * waterfall, the event log and the flame layout all rely on it.
 *
 * All of these require an **acyclic** node graph and none of them checks for
 * one, which is a deliberate trade rather than an oversight: a cycle check
 * costs a set of every visited node on a path the aggregates walk for every
 * capture, and the two sources of a tree cannot produce a cycle. The
 * correlator detects one and flags the offending nodes with `'cycle'` from
 * {@link ORPHAN_REASONS} instead of building it, and a tree that arrived as
 * JSON cannot express one at all. A caller that hand-builds a node whose
 * subtree contains itself has built something that is not a tree, cannot be
 * serialised and will not terminate here.
 * ---------------------------------------------------------------------------
 */

/** One entry of a traversal stack: a node and the node it hangs from. */
interface WalkFrame {
  /** The node to visit. */
  readonly node: TraceNode;
  /** Its parent, or `undefined` at a root. */
  readonly parent: TraceNode | undefined;
}

/**
 * Pushes `node`'s children onto `stack` so that they are visited in canonical
 * order.
 *
 * A stack pops in reverse, so the children go on backwards. This is the one
 * place that reversal happens, which is what keeps every walk in this module
 * in the same order.
 */
function pushChildren(stack: WalkFrame[], node: TraceNode): void {
  const children = node.children;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child === undefined) {
      continue;
    }
    stack.push({ node: child, parent: node });
  }
}

/**
 * Visits `node` and its whole subtree, depth-first and pre-order.
 *
 * The visitor receives each node and its parent — `undefined` for `node`
 * itself, since a {@link TraceNode} deliberately carries no parent pointer.
 * The visitor's return value is ignored and it cannot stop the walk: use
 * {@link findNodeInSubtree} to search, which stops at the first match.
 *
 * @param node The subtree root.
 * @param visit Called once per node, parent before child, siblings in
 * canonical order.
 *
 * @example
 * ```ts
 * let slowest: TraceNode | undefined;
 * walkNode(root, (node) => {
 *   if (slowest === undefined || node.event.duration > slowest.event.duration) {
 *     slowest = node;
 *   }
 * });
 * ```
 */
export function walkNode(
  node: TraceNode,
  visit: (node: TraceNode, parent: TraceNode | undefined) => void,
): void {
  const stack: WalkFrame[] = [{ node, parent: undefined }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      // Unreachable while the loop condition holds: `pop` on a non-empty array
      // always returns an element. The check is what lets the frame be used
      // without an assertion, which this repository forbids.
      continue;
    }

    visit(frame.node, frame.parent);
    pushChildren(stack, frame.node);
  }
}

/**
 * Visits every node of every root of `tree`, depth-first and pre-order, roots
 * in canonical order.
 *
 * Each root is visited with an `undefined` parent. A trace with several roots
 * is the normal reporting of an incomplete capture (see {@link TraceTree}), so
 * a visitor that assumes one root is the bug, not the tree.
 *
 * @param tree The correlated trace.
 * @param visit Called once per node, parent before child.
 */
export function walkTrace(
  tree: TraceTree,
  visit: (node: TraceNode, parent: TraceNode | undefined) => void,
): void {
  for (const root of tree.roots) {
    walkNode(root, visit);
  }
}

/**
 * `node` and its subtree as a flat array, in pre-order.
 *
 * @param node The subtree root.
 * @returns A fresh array, parent before child; never the tree's own arrays, so
 * a caller may sort or filter it freely.
 */
export function flattenNode(node: TraceNode): TraceNode[] {
  const flat: TraceNode[] = [];
  walkNode(node, (visited) => {
    flat.push(visited);
  });
  return flat;
}

/**
 * The whole tree as a flat array, in pre-order.
 *
 * This is the array `EventLog`, `Waterfall` and the flame layout iterate, and
 * the place AAP 0.2.3's parent-before-child guarantee is directly observable:
 * every node appears after its parent and after its earlier siblings' whole
 * subtrees.
 *
 * @param tree The correlated trace.
 * @returns A fresh array of every node, parent before child. Empty for an
 * empty trace.
 */
export function flattenTrace(tree: TraceTree): TraceNode[] {
  const flat: TraceNode[] = [];
  walkTrace(tree, (visited) => {
    flat.push(visited);
  });
  return flat;
}

/*
 * ---------------------------------------------------------------------------
 * Lookup
 *
 * Every lookup answers with the **first match in canonical pre-order**, which
 * matters because a span id is not guaranteed unique in practice: a producer
 * restart or a replayed batch can put the same id in one trace twice, which is
 * exactly what {@link TraceTree.duplicateSpanIds} records. Answering with the
 * first match means two lookups for the same id agree with each other and with
 * {@link flattenTrace}'s order.
 * ---------------------------------------------------------------------------
 */

/**
 * The first node in `node`'s subtree — `node` itself included — whose event
 * carries `spanId`.
 *
 * Stops at the match instead of walking the whole subtree, which is why this
 * is written as its own stack loop rather than through {@link walkNode}.
 *
 * @param node The subtree root.
 * @param spanId The 16-hex span id to look for.
 * @returns The node, or `undefined` when the subtree does not contain it.
 */
export function findNodeInSubtree(node: TraceNode, spanId: SpanId): TraceNode | undefined {
  const stack: WalkFrame[] = [{ node, parent: undefined }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      continue;
    }

    if (frame.node.event.spanId === spanId) {
      return frame.node;
    }
    pushChildren(stack, frame.node);
  }

  return undefined;
}

/**
 * The first node of `tree` whose event carries `spanId`.
 *
 * @param tree The correlated trace.
 * @param spanId The 16-hex span id to look for.
 * @returns The node, or `undefined` when the trace does not contain it.
 */
export function findNodeBySpanId(tree: TraceTree, spanId: SpanId): TraceNode | undefined {
  for (const root of tree.roots) {
    const found = findNodeInSubtree(root, spanId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * The ancestor chain of `spanId`, root first and **excluding** the span
 * itself.
 *
 * This is the "parent chain" the DevTools `EventDetails` drawer renders
 * (AAP 0.7.3), and what an assertion about nesting reads: the end-to-end test
 * of the slow interaction checks that a `db.query` sits under a
 * `function`/`route.handler` span, under `http.server`, under `fetch`, under
 * `interaction` (AAP 0.8.3), which is this chain's kinds read root-first.
 *
 * @param tree The correlated trace.
 * @param spanId The 16-hex span id whose ancestors are wanted.
 * @returns The chain from the trace root down to the span's parent. **Empty**
 * both when the span is a root and when it is absent — a caller that needs to
 * tell those apart asks {@link findNodeBySpanId}.
 */
export function ancestorsOfSpanId(tree: TraceTree, spanId: SpanId): readonly TraceNode[] {
  const parents = new Map<TraceNode, TraceNode>();
  let target: TraceNode | undefined;

  walkTrace(tree, (node, parent) => {
    if (parent !== undefined && !parents.has(node)) {
      parents.set(node, parent);
    }
    if (target === undefined && node.event.spanId === spanId) {
      target = node;
    }
  });

  if (target === undefined) {
    return EMPTY_NODE_LIST;
  }

  // Walked leaf-to-root and reversed once at the end, which is cheaper than
  // carrying a path array down every branch of the tree. `seen` keeps this
  // loop total whatever the parent index holds, so a repeated entry costs a
  // short chain rather than a spin.
  const reversed: TraceNode[] = [];
  const seen = new Set<TraceNode>([target]);
  let current = parents.get(target);
  while (current !== undefined && !seen.has(current)) {
    reversed.push(current);
    seen.add(current);
    current = parents.get(current);
  }

  return reversed.reverse();
}

/**
 * How many nodes `node`'s subtree holds, counting `node` itself.
 *
 * `1` for a leaf. Used where a count is wanted without materialising the
 * array {@link flattenNode} would build — a collapsed tree row's badge, a
 * subtree's share of a capture.
 *
 * @param node The subtree root.
 * @returns The node count, always at least `1`.
 */
export function subtreeNodeCount(node: TraceNode): number {
  let count = 0;
  walkNode(node, () => {
    count += 1;
  });
  return count;
}

/*
 * ---------------------------------------------------------------------------
 * Timing
 *
 * Total time is what an operation took; self time is what it spent outside the
 * operations it called. The distinction is the whole point of a flame view: a
 * route handler with 640 ms of total time and 4 ms of self time is waiting on
 * its query, and one with 640 ms of both is doing the work itself. Those are
 * different findings and the analysis stage reports them differently.
 * ---------------------------------------------------------------------------
 */

/**
 * When the node's operation finished: `event.startTime + event.duration`, in
 * Unix epoch milliseconds.
 *
 * Reported as the raw arithmetic — unclamped and unrounded — because it is a
 * *position* on the same axis as `startTime` rather than a measurement:
 * clamping would move an event in time, and rounding is applied where a
 * duration is reported instead ({@link totalTimeOf}, {@link selfTimeOf},
 * {@link TraceTree.totalDuration}). `../schema/event.ts` already rejects a
 * negative duration and a non-finite timestamp, so the sum is meaningful for
 * every validated event.
 *
 * @param node Any node.
 * @returns The end of the node's interval.
 */
export function nodeEndTime(node: TraceNode): number {
  return node.event.startTime + node.event.duration;
}

/**
 * The node's own inclusive duration in milliseconds: everything it took,
 * including the operations it called.
 *
 * Clamped at zero and rounded through the product's single rounding policy, so
 * the value a panel shows and the value a test asserts carry the same digits.
 *
 * @param node Any node.
 * @returns The total time, never negative.
 */
export function totalTimeOf(node: TraceNode): number {
  return roundMs(clampNonNegative(node.event.duration));
}

/**
 * The node's self time in milliseconds: its total time minus the wall-clock
 * time covered by its direct children.
 *
 * ## Why the children's durations are not summed
 *
 * Summing them is **wrong** and this function deliberately does not do it.
 * Children overlap as a matter of routine: one interaction can issue several
 * requests in parallel (AAP 0.4.2), and two 400 ms requests that ran side by
 * side account for 400 ms of their parent's time, not 800 ms. A sum would
 * report negative self time for that parent, which a flame or icicle layout
 * cannot draw — a negative width is either clipped to nothing or inverted, and
 * either way the developer is shown a lie about where the time went. So the
 * children's intervals are **merged into a union** and the union's length is
 * what gets subtracted.
 *
 * ## Why each child is clipped to its parent's window first
 *
 * A child can legitimately fall partly outside its parent's `[start, end]`
 * window. The browser agent and the dev-server preload are separate processes
 * whose clocks are read independently (AAP 0.2.3), so a server span can appear
 * to start a fraction of a millisecond before the `fetch` that caused it; and
 * a request the handler did not await can outlive it. Time outside the
 * parent's window is not the parent's to account for, so each child interval
 * is clipped to that window before merging and an interval that clips to
 * nothing is dropped.
 *
 * Only **direct** children are considered: a grandchild's time is already
 * inside its parent's interval, so counting it again would subtract it twice.
 *
 * @param node Any node.
 * @returns The self time, clamped at zero and rounded. Equal to
 * {@link totalTimeOf} for a leaf.
 *
 * @example
 * ```ts
 * // A 100 ms parent with two sequential 20 ms children: 60 ms of self time.
 * // The same parent with two overlapping 20 ms children: 80 ms.
 * const self = selfTimeOf(node);
 * ```
 */
export function selfTimeOf(node: TraceNode): number {
  const total = clampNonNegative(node.event.duration);
  const windowStart = node.event.startTime;
  const windowEnd = windowStart + total;

  const intervals: { readonly start: number; readonly end: number }[] = [];
  for (const child of node.children) {
    const start = Math.max(child.event.startTime, windowStart);
    const end = Math.min(child.event.startTime + clampNonNegative(child.event.duration), windowEnd);
    if (!(end > start)) {
      // Also excludes a non-finite bound, for which every comparison is false.
      continue;
    }
    intervals.push({ start, end });
  }

  intervals.sort((left, right) => left.start - right.start);

  let covered = 0;
  let openStart: number | undefined;
  let openEnd = 0;
  for (const interval of intervals) {
    if (openStart === undefined) {
      openStart = interval.start;
      openEnd = interval.end;
      continue;
    }

    if (interval.start > openEnd) {
      covered += openEnd - openStart;
      openStart = interval.start;
      openEnd = interval.end;
      continue;
    }

    if (interval.end > openEnd) {
      openEnd = interval.end;
    }
  }
  if (openStart !== undefined) {
    covered += openEnd - openStart;
  }

  return roundMs(clampNonNegative(total - covered));
}
