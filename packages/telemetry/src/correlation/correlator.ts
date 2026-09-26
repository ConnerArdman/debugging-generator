/**
 * The trace correlator: one click becomes **one ordered tree**.
 *
 * {@link correlateEvents} takes the flat, persisted events of a capture and
 * returns one {@link TraceTree} per `traceId`, spanning every tier the product
 * observes — the browser event handler, the React work it caused, the `fetch`
 * it issued, the Next.js request and route-handler spans that answered it, the
 * named service functions a reversible patch timed, the SQL they ran and the
 * external calls they made (AAP 0.2.3, 0.4.2, 0.8.4 acceptance test 1). That
 * tree is what `Timeline`, `FlameChart` and `Waterfall` draw, and what
 * `POST /sessions/:id/panel-data` serves for `{ source: 'trace' }`.
 *
 * ## What this module guarantees
 *
 * 1. **The canonical order.** Within a trace: parent before child, then
 *    `startTime`, then `(producerId, seq)`, then `ingestSeq` — the
 *    store-assigned, always-distinct final tie-breaker (AAP 0.2.3).
 *    Parent-before-child is *structural*: it comes from the tree shape and
 *    from `flattenTrace`'s pre-order walk, and it **outranks `startTime`**.
 *    {@link compareEventsCanonical} orders siblings and nothing else, so a
 *    child that appears to start before its parent — the browser agent and the
 *    dev-server preload read two different clocks — still renders after it.
 * 2. **Nothing is dropped.** An event whose parentage cannot be honoured is
 *    repaired, never discarded: it is attached to the trace's primary root and
 *    flagged with one of `ORPHAN_REASONS` (`missing-parent`, `self-parent`,
 *    `cycle`, `max-depth`). `CorrelationResult.eventCount` is the input length
 *    and the sum of the trees' `nodeCount` matches it, which is the mechanical
 *    proof: dropping one span would silently remove all the work underneath it
 *    from every duration in the capture (AAP 0.4.2).
 * 3. **Permutation invariance.** Correlating any permutation of the same event
 *    set produces a deeply equal result. The service re-correlates a trace from
 *    its stored events whenever batches from two independent producers have
 *    changed it, so arrival order must not be observable anywhere in the
 *    output. Every decision below — which occurrence of a repeated span id
 *    wins, which parentless event becomes the primary root, which member of a
 *    cycle is cut, the order of siblings and of the repaired orphans — is taken
 *    in canonical order.
 * 4. **Purity.** No input event or array is mutated, no clock or random source
 *    is read, no module-level state is kept and nothing is logged. The same
 *    input yields the same output in the service, in a test and in a browser.
 * 5. **Exact incremental extension.** {@link extendCorrelatedTrace} grows an
 *    already correlated tree by a batch of new events — including new
 *    orphans, the late parents that adopt earlier ones and roots that do not
 *    move the anchor — at the cost of the batch, the subtrees it moves and the
 *    paths it touches, and either answers with the tree
 *    {@link correlateTrace} would build from the combined rows — identical
 *    down to the key order — or refuses with a typed reason, leaving its
 *    index untouched. It never answers with an approximation. The argument
 *    for why each refusal is required is stated on the section that
 *    implements it.
 *
 * ## Who calls it
 *
 * - `apps/local-service/src/telemetry/correlate.ts` — through
 *   {@link correlateTrace} when a read finds no cached tree, over the trace's
 *   complete persisted event set, and through {@link indexTraceForExtension}
 *   and {@link extendCorrelatedTrace} at ingest, which grow each cached tree a
 *   persisted batch touched instead of discarding it; its cache serves the
 *   `trace` data source of `apps/local-service/src/panels/data.ts`.
 * - `../aggregate/*` — the capture metrics and the per-source `DataResult`
 *   shapes are computed from correlated trees.
 *
 * ## What it deliberately does not do
 *
 * - **No redaction.** That happened at ingest
 *   (`../redaction/redactor.ts`); the events handed in here are already
 *   scrubbed, and this module neither inspects nor rewrites attribute values.
 * - **No session or capture filtering.** Grouping is by `traceId` *only*,
 *   because AAP 0.4.2 joins browser and server spans by that id and AAP 0.5.5
 *   keeps one `captureId` across a page reload. A caller that wants one
 *   capture filters before calling.
 * - **No persistence, no I/O, no shape of its own.** The tree vocabulary,
 *   every derived aggregate and every traversal live in `./tree.ts`; this file
 *   builds nodes and delegates the aggregates to `buildTraceTree`.
 *
 * @packageDocumentation
 */

import { assertNever } from '@debuggen/shared';
import type { ProducerId, SpanId, TraceId } from '@debuggen/shared';

import type { TelemetryEvent } from '../schema/event.js';
import { TELEMETRY_KINDS, isTelemetryKind } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryTier } from '../schema/kinds.js';

import {
  DEFAULT_MAX_DEPTH,
  assembleTraceTree,
  buildTraceTree,
  createTraceNode,
  nodeEndTime,
} from './tree.js';
import type { OrphanReason, TraceNode, TraceNodeOrphanFlags, TraceTree } from './tree.js';

/*
 * ---------------------------------------------------------------------------
 * Canonical ordering
 *
 * One comparator, exported, because three surfaces must agree about the order
 * of two events that share a millisecond: the timeline, the waterfall and the
 * event log all read the same tree, and `../schema/event.ts` documents the key
 * sequence while deliberately implementing none of it so that no second
 * comparator can appear.
 * ---------------------------------------------------------------------------
 */

/**
 * Orders two events by UTF-16 code unit, deterministically and without a
 * locale.
 *
 * `localeCompare` is never used anywhere in this module: its result depends on
 * the host's locale data, so two machines could order the same capture
 * differently and a correlated trace would stop being reproducible. Plain
 * `<`/`>` is the whole of the order, stated here so it is a property of this
 * module rather than of a default.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * The canonical comparator for two persisted telemetry events: a **total
 * order** over a capture, in the key sequence AAP 0.2.3 fixes.
 *
 * Keys, in order, each one only reached when every earlier key ties:
 *
 * 1. **`startTime`** ascending — Unix epoch milliseconds as a double, the one
 *    time base every producer converts to (`@debuggen/shared`'s
 *    `performanceToEpochMs` in the browser agent, `hrTimeToEpochMs` in the
 *    Node preload), which is what makes cross-tier ordering meaningful at all.
 * 2. **`producerId`** ascending — a plain string comparison. Two events from
 *    two producers routinely land in the same millisecond, and the producer id
 *    is the only thing that separates them; ordering by it keeps a
 *    browser-agent event and a preload event in a stable relative position no
 *    matter which batch arrived first.
 * 3. **`seq`** ascending — a per-producer monotonic counter scoped to
 *    `(producerId, captureId)`, so it records emission order more finely than
 *    a timestamp can. It only ever disambiguates events of the *same*
 *    producer, which is why it sits below `producerId` and not above it.
 * 4. **`ingestSeq`** ascending — the store's one-based arrival number, and the
 *    key that can never tie, which is what makes this order total and
 *    therefore reproducible.
 * 5. **`id`** ascending — defence in depth. `ingestSeq` is distinct by
 *    construction, so this key is unreachable with rows the store wrote; it is
 *    here so that a hand-built event pair, a replayed batch or a future store
 *    that reuses an arrival number still yields a *stable* order instead of
 *    one that depends on the sort implementation. Two events that tie on all
 *    five keys compare `0`, which for stored rows means they are the same row.
 *
 * ## Structural nesting outranks `startTime`
 *
 * The AAP's full ordering is *parent before child*, **then** the five keys
 * above. Parent-before-child is not this function's job and cannot be: it is
 * established by the tree shape and observed through `flattenTrace`'s
 * depth-first pre-order walk. This comparator orders **siblings**. The
 * practical consequence is deliberate: when a server span's clock reads
 * slightly earlier than the browser span that caused it — the two processes
 * read different clocks, and AAP 0.2.3 records only an informational
 * per-producer offset rather than aligning them — the child still appears
 * *after* its parent everywhere, because causality is structure and the
 * timestamp is only a sibling tie-break.
 *
 * ## Non-finite values
 *
 * `../schema/event.ts` rejects `NaN` and infinities, so a stored event cannot
 * carry one. Should one reach here anyway, the numeric comparisons below
 * simply do not fire (every comparison with `NaN` is false) and the order
 * falls through to the next key, which keeps the comparator consistent instead
 * of returning a value that would corrupt the sort.
 *
 * @param a The first event.
 * @param b The second event.
 * @returns A negative number when `a` sorts first, a positive number when `b`
 * does, and `0` when the two tie on every key.
 *
 * @example
 * ```ts
 * const ordered = [...events].sort(compareEventsCanonical);
 * ```
 */
export function compareEventsCanonical(a: TelemetryEvent, b: TelemetryEvent): number {
  if (a.startTime < b.startTime) {
    return -1;
  }
  if (a.startTime > b.startTime) {
    return 1;
  }

  if (a.producerId !== b.producerId) {
    return compareStrings(a.producerId, b.producerId);
  }

  if (a.seq < b.seq) {
    return -1;
  }
  if (a.seq > b.seq) {
    return 1;
  }

  if (a.ingestSeq < b.ingestSeq) {
    return -1;
  }
  if (a.ingestSeq > b.ingestSeq) {
    return 1;
  }

  return compareStrings(a.id, b.id);
}

/**
 * A new array holding `events` in {@link compareEventsCanonical} order.
 *
 * The caller's array is **copied before sorting**, never sorted in place.
 * `Array.prototype.sort` mutates, and the arrays reaching this module are the
 * service's own batches and the store's query results, which are re-correlated
 * as a capture grows: reordering one under its owner would make a later
 * correlation depend on an earlier one.
 *
 * @param events Any events, in any order.
 * @returns A fresh array in canonical order. The event objects themselves are
 * shared, not cloned — they are immutable records and nothing here writes to
 * them.
 */
export function sortEventsCanonical(events: readonly TelemetryEvent[]): TelemetryEvent[] {
  return [...events].sort(compareEventsCanonical);
}

/*
 * ---------------------------------------------------------------------------
 * Root affinity
 *
 * One number per kind, used for exactly one decision: which of several
 * parentless events a trace should be anchored on.
 * ---------------------------------------------------------------------------
 */

/**
 * How root-like an operation of this kind is, on an arbitrary scale where a
 * **higher number is more root-like**.
 *
 * The ranking encodes the product's causal model of a capture, from the outside
 * in:
 *
 * | Band | Kinds | Why |
 * |---|---|---|
 * | 100–90 | `interaction`, `navigation` | what a developer *did*: the only kinds that start a trace on purpose |
 * | 80–70 | `fetch`, `xhr`, `http.server` | the browser-to-server seam — a request is a root only when the interaction that issued it was not captured |
 * | 60–45 | `route.handler`, `function`, `db.query`, `http.client` | work *inside* the server; a root here means the request span is missing |
 * | 30–10 | `commit`, `render`, `state`, `perf.longtask`, `perf.entry`, `log` | observations of work, never its cause |
 * | 5–4 | `error`, `server.error` | a symptom: the least useful thing to anchor a timeline on |
 *
 * The exact numbers carry no meaning beyond their order, and only comparisons
 * between them are ever made. What matters is the shape: when a capture
 * contains a browser `interaction` and a parentless `http.server` span in the
 * same trace, the interaction anchors the trace and the server span keeps its
 * own place, rather than the timeline being anchored on whichever of the two
 * happened to be timestamped first.
 *
 * ## Why a `switch` and not a lookup table
 *
 * The `default` branch calls `assertNever`, so this function is the
 * compile-time guard for the whole vocabulary: a kind added to
 * `../schema/kinds.ts` has a type at that branch, the call stops compiling and
 * the compiler points here, demanding a decision about how root-like the new
 * kind is. A `Record<TelemetryKind, number>` would give the same exhaustiveness
 * but not the same review prompt, and a table with a fallback would silently
 * mis-rank the new member. This is the use of `assertNever` that
 * `packages/shared/src/assert.ts` documents as belonging to this correlator.
 *
 * @param kind Any member of the closed kind vocabulary.
 * @returns A finite number; higher means more root-like.
 * @throws A `DebuggenError` with code `INTERNAL` if called with a value outside
 * the vocabulary, which the type system makes unreachable from typed code. The
 * one path that could reach it — a stored row written by a newer build — is
 * guarded by {@link rootAffinityOf} rather than by a `try`, so that one
 * malformed event cannot crash the ingest loop (AAP 0.5.5).
 */
export function rootAffinityForKind(kind: TelemetryKind): number {
  switch (kind) {
    // What the developer did.
    case 'interaction':
      return 100;
    case 'navigation':
      return 90;

    // The browser-to-server seam.
    case 'fetch':
      return 80;
    case 'xhr':
      return 80;
    case 'http.server':
      return 70;

    // Work inside the server process.
    case 'route.handler':
      return 60;
    case 'function':
      return 55;
    case 'db.query':
      return 50;
    case 'http.client':
      return 45;

    // Observations of work, not causes of it.
    case 'commit':
      return 30;
    case 'render':
      return 25;
    case 'state':
      return 20;
    case 'perf.longtask':
      return 15;
    case 'perf.entry':
      return 14;
    case 'log':
      return 10;

    // Symptoms.
    case 'error':
      return 5;
    case 'server.error':
      return 4;

    default:
      return assertNever(kind, 'Unhandled telemetry kind in the root-affinity ranking');
  }
}

/**
 * The lowest affinity any member of the vocabulary scores, derived from
 * {@link TELEMETRY_KINDS} rather than restated as a literal.
 *
 * It is the score {@link rootAffinityOf} gives a `kind` that is not in the
 * vocabulary at all, so such an event can never outrank a known one. Deriving
 * it means the floor cannot drift when the scale above is re-balanced, and
 * computing it costs one pass over seventeen strings at module load — pure,
 * allocation-free and never recomputed.
 */
const MIN_ROOT_AFFINITY: number = TELEMETRY_KINDS.reduce<number>(
  (lowest, kind) => Math.min(lowest, rootAffinityForKind(kind)),
  Number.POSITIVE_INFINITY,
);

/*
 * ---------------------------------------------------------------------------
 * Public surface
 * ---------------------------------------------------------------------------
 */

/**
 * How to correlate.
 *
 * One option today, and it is a guard rather than a preference — see
 * `DEFAULT_MAX_DEPTH` in `./tree.ts` for why a real correlated trace is a
 * handful of levels deep and why a longer chain means malformed parentage.
 */
export interface CorrelateOptions {
  /**
   * The deepest node to place before a chain is treated as pathological.
   * Defaults to `DEFAULT_MAX_DEPTH` (1024).
   *
   * A node that would sit deeper is not discarded: it is lifted to the
   * trace's primary root, flagged `max-depth`, and the tree reports
   * `truncated: true`. Declared `| undefined` so that a caller may forward an
   * optional configuration value straight through (`{ maxDepth: config.depth }`)
   * under this repository's `exactOptionalPropertyTypes`; a value that is not
   * a non-negative integer is treated as absent.
   */
  readonly maxDepth?: number | undefined;
}

/**
 * Every trace in one capture, correlated.
 *
 * `traces` and `byTraceId` are two views of the same trees — the array for
 * rendering a capture in order, the map for the panel-data route's
 * `filter.traceId` lookup. The map is **server-side only**: it is a `Map`, so
 * it does not survive `JSON.stringify`, which is exactly why no `Map` appears
 * anywhere inside a {@link TraceTree}.
 *
 * The three counts are the result's own audit trail. `eventCount` is the input
 * length, so comparing it against the sum of the trees' `nodeCount` is the
 * mechanical check that nothing was dropped, and `orphanCount` says how much
 * of the structure had to be repaired.
 */
export interface CorrelationResult {
  /** Every trace, ascending by `startTime` and then by `traceId`. */
  readonly traces: readonly TraceTree[];
  /** The same trees, keyed by their `traceId`, in the same order. */
  readonly byTraceId: ReadonlyMap<TraceId, TraceTree>;
  /** How many distinct `traceId`s the input carried. */
  readonly traceCount: number;
  /** How many events were handed in. Always exactly `events.length`. */
  readonly eventCount: number;
  /** How many nodes had to be re-attached, summed over every trace. */
  readonly orphanCount: number;
}

/*
 * ---------------------------------------------------------------------------
 * Working state
 *
 * One trace is correlated over five parallel arrays indexed by an event's
 * position in the canonically sorted group, plus one child-list map. Indices
 * rather than event objects or span ids are the keys throughout, and that is a
 * deliberate choice with three consequences the alternatives do not give:
 *
 * - **A repeated span id cannot duplicate a subtree.** Children are collected
 *   under the index of the *first* canonical occurrence of the parent id, so a
 *   second event carrying that id is placed as a node of its own and simply
 *   has no children — rather than both copies claiming the same subtree and
 *   inflating every duration in the capture.
 * - **The same event object handed in twice stays two nodes.** A `Set` or a
 *   `Map` keyed by identity would conflate them and quietly lose one, which
 *   would break the "nothing is dropped" guarantee at its most literal.
 * - **Canonical order is just ascending index**, so every decision that has to
 *   be permutation-invariant — which cycle member is cut, which parentless
 *   event anchors the trace, the order of the repaired orphans — is an integer
 *   comparison over the already-sorted group.
 * ---------------------------------------------------------------------------
 */

/** The depth of a trace root. */
const ROOT_DEPTH = 0;

/**
 * The depth every repaired node is re-attached at: one level below the primary
 * root.
 *
 * It is applied even when it exceeds `maxDepth` — which only happens for the
 * degenerate `maxDepth: 0` — because attaching the evidence one level too deep
 * is a reporting inaccuracy the tree already flags, while dropping it is the
 * one failure this module does not permit (AAP 0.4.2).
 */
const ORPHAN_DEPTH = 1;

/** The shared empty child list returned for a node that has no children. */
const EMPTY_INDEX_LIST: readonly number[] = Object.freeze([]);

/**
 * The span-id index of one canonically sorted group.
 *
 * `bySpanId` maps a span id to the index of its **first canonical
 * occurrence**, which is the occurrence that owns the children naming that id.
 * `duplicateSpanIds` lists every id seen more than once, unique and in
 * ascending order, and is reported on the tree so that a developer can see the
 * ambiguity rather than wonder why two rows look alike (`TraceTree`).
 */
interface SpanIdIndex {
  readonly bySpanId: ReadonlyMap<SpanId, number>;
  readonly duplicateSpanIds: readonly SpanId[];
}

/**
 * The mutable working state of one trace's correlation pass.
 *
 * Every array is indexed by an event's position in {@link GroupState.events},
 * which is the group in canonical order. The arrays are `readonly` as
 * *properties* — the state object never swaps one out — while their elements
 * are written as parentage is resolved, cycles are cut and the depth guard
 * fires.
 */
interface GroupState {
  /** The group in canonical order. Index `i` identifies `events[i]` throughout. */
  readonly events: readonly TelemetryEvent[];
  /** The index of each event's resolved parent, or `undefined` when it has none. */
  readonly parentIndex: (number | undefined)[];
  /** Why an event could not be placed under the parent it named, when it could not. */
  readonly orphanReason: (OrphanReason | undefined)[];
  /** The `parentSpanId` that never arrived, for a `missing-parent` event only. */
  readonly missingParentSpanId: (SpanId | undefined)[];
  /** Child indices per parent index, in canonical order. Absent means "no children". */
  readonly childIndices: Map<number, number[]>;
  /**
   * Whether an event has been lifted out of its parent's child list — by cycle
   * breaking or by the depth guard — and will be placed as a repaired node
   * instead. Child iteration everywhere skips a detached index, which is what
   * makes both repairs cheap (a flag, not a splice) and idempotent (a node is
   * lifted at most once).
   */
  readonly detached: boolean[];
  /** Whether an event is reachable from some parentless event; see {@link breakCycles}. */
  readonly reached: boolean[];
  /** Whether the depth guard fired anywhere in this trace. */
  truncated: boolean;
}

/**
 * One node to materialise as a subtree of its own: a trace root, a repaired
 * orphan, or a node the depth guard lifted.
 */
interface Placement {
  /** The index of the event this subtree is rooted at. */
  readonly index: number;
  /** The depth to build it at: {@link ROOT_DEPTH} or {@link ORPHAN_DEPTH}. */
  readonly depth: number;
  /** Whether it is a repaired node (a child of the primary root) rather than a root. */
  readonly orphan: boolean;
}

/**
 * Which parentless events become roots, which become repaired children, and
 * which one the trace is anchored on.
 */
interface RootSelection {
  /** The trace's roots, in canonical order. */
  readonly rootIndices: readonly number[];
  /** The parentless events to re-attach under the primary root, in canonical order. */
  readonly orphanIndices: readonly number[];
  /** The root a view anchors on; always a member of {@link RootSelection.rootIndices}. */
  readonly primaryIndex: number;
}

/*
 * ---------------------------------------------------------------------------
 * The passes
 *
 * Six of them, each linear in the size of the group, in the order AAP 0.4.2's
 * correlation contract requires: index, resolve, cut cycles, choose an anchor,
 * materialise, assemble. The only super-linear step in the whole module is the
 * canonical sort.
 * ---------------------------------------------------------------------------
 */

/**
 * Indexes a canonically sorted group by span id, keeping the first occurrence
 * of a repeated id and reporting the repeats.
 *
 * @param events One trace's events, in canonical order.
 * @returns The index and the sorted, unique list of repeated ids.
 */
function indexBySpanId(events: readonly TelemetryEvent[]): SpanIdIndex {
  const bySpanId = new Map<SpanId, number>();
  const duplicates = new Set<SpanId>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      // Unreachable for a dense array; the check is what lets the element be
      // used without a non-null assertion, which this repository forbids.
      continue;
    }

    if (bySpanId.has(event.spanId)) {
      duplicates.add(event.spanId);
      continue;
    }

    bySpanId.set(event.spanId, index);
  }

  return { bySpanId, duplicateSpanIds: [...duplicates].sort(compareStrings) };
}

/**
 * Resolves every event's parentage and collects the child lists.
 *
 * A **real parent** requires all three of: a `parentSpanId` on the event, a
 * value different from the event's own `spanId`, and an entry in the span
 * index that resolves to a different event. Anything else leaves the event
 * parentless, with a reason that says which repair it needs:
 *
 * - no `parentSpanId` at all → a genuine root, no reason recorded;
 * - `parentSpanId === spanId` → `self-parent`, which no correct producer emits
 *   and which would make the node its own ancestor;
 * - a `parentSpanId` the index cannot resolve → `missing-parent`, with the id
 *   kept so a view can name the span that never arrived.
 *
 * Child lists come out in canonical order for free, because this pass walks the
 * already-sorted group in ascending index order and appends: child `i` can
 * only be pushed after every canonically earlier sibling. Nothing re-sorts
 * them afterwards, here or downstream — `TraceNode.children` documents that as
 * a contract.
 *
 * @param events One trace's events, in canonical order.
 * @param bySpanId The span index from {@link indexBySpanId}.
 * @returns Fresh working state with parentage resolved and children collected.
 */
function resolveParentage(
  events: readonly TelemetryEvent[],
  bySpanId: ReadonlyMap<SpanId, number>,
): GroupState {
  const count = events.length;
  const state: GroupState = {
    events,
    parentIndex: new Array<number | undefined>(count).fill(undefined),
    orphanReason: new Array<OrphanReason | undefined>(count).fill(undefined),
    missingParentSpanId: new Array<SpanId | undefined>(count).fill(undefined),
    childIndices: new Map<number, number[]>(),
    detached: new Array<boolean>(count).fill(false),
    reached: new Array<boolean>(count).fill(false),
    truncated: false,
  };

  for (let index = 0; index < count; index += 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }

    const parentSpanId = event.parentSpanId;
    if (parentSpanId === undefined) {
      // A genuine root: absence of a parent is meaningful and is never
      // repaired into something else (`../schema/event.ts`).
      continue;
    }

    if (parentSpanId === event.spanId) {
      state.orphanReason[index] = 'self-parent';
      continue;
    }

    const parent = bySpanId.get(parentSpanId);
    if (parent === undefined) {
      state.orphanReason[index] = 'missing-parent';
      state.missingParentSpanId[index] = parentSpanId;
      continue;
    }

    if (parent === index) {
      // Unreachable: the index resolves a span id to the event carrying it, so
      // `parent === index` would mean `parentSpanId === spanId`, which the
      // check above already handled. Treated as the same producer bug rather
      // than trusted, because the alternative is a node that is its own parent.
      state.orphanReason[index] = 'self-parent';
      continue;
    }

    state.parentIndex[index] = parent;
    const siblings = state.childIndices.get(parent);
    if (siblings === undefined) {
      state.childIndices.set(parent, [index]);
      continue;
    }
    siblings.push(index);
  }

  return state;
}

/**
 * Marks `from` and everything beneath it as reachable, iteratively.
 *
 * Detached children are skipped — they are placed as repaired nodes and are
 * reached from their own placement — and an index already marked is not
 * revisited, which is what makes this safe to run on child lists that still
 * describe a cycle.
 *
 * @param state The working state; `reached` is written.
 * @param from The index to start from.
 */
function markReachable(state: GroupState, from: number): void {
  const stack: number[] = [from];

  while (stack.length > 0) {
    const index = stack.pop();
    if (index === undefined) {
      // Unreachable while the loop condition holds; see `indexBySpanId`.
      break;
    }
    if (state.reached[index] === true) {
      continue;
    }
    state.reached[index] = true;

    const children = state.childIndices.get(index);
    if (children === undefined) {
      continue;
    }
    for (const child of children) {
      if (state.detached[child] === true || state.reached[child] === true) {
        continue;
      }
      stack.push(child);
    }
  }
}

/**
 * Cuts every `parentSpanId` loop, deterministically and in one pass.
 *
 * Two events naming each other, or a longer ring, describe something that is
 * not a tree. Left alone they would be unreachable from any root — and a
 * traversal that followed them would not terminate — so exactly one member of
 * each loop is lifted to the trace root and flagged `cycle`, which leaves the
 * rest of the ring hanging off it in the order the producer claimed.
 *
 * The algorithm is a reachability walk from every parentless event, followed by
 * one **ascending** scan of the group: the first index the walk did not reach
 * is inside or beneath a loop, so it is detached, flagged and marked together
 * with its subtree; the scan then continues, skipping everything that marking
 * just reached.
 *
 * Three properties matter, and each follows from the scan rather than from an
 * assumption:
 *
 * - **It terminates.** A single `for` over a fixed range, with no back edge. A
 *   `while` loop waiting for a shrinking work set would need a progress proof;
 *   this needs none, and the marking step guarantees progress anyway because
 *   it always marks at least the index it was given.
 * - **It is permutation-invariant.** The cut member is the canonically first
 *   unreached event, which is a property of the event set and not of the
 *   arrival order.
 * - **It is idempotent per node.** `detached` is a flag, so a node lifted here
 *   is never lifted again and never reachable through its old parent.
 *
 * @param state The working state; `detached`, `orphanReason` and `reached` are
 * written.
 */
function breakCycles(state: GroupState): void {
  const count = state.events.length;

  for (let index = 0; index < count; index += 1) {
    if (state.parentIndex[index] === undefined) {
      markReachable(state, index);
    }
  }

  for (let index = 0; index < count; index += 1) {
    if (state.reached[index] === true) {
      continue;
    }

    state.detached[index] = true;
    state.orphanReason[index] = 'cycle';
    markReachable(state, index);
  }
}

/**
 * The orphan flags to build a placement's node with, or `undefined` when the
 * node is placed exactly where its event said it belonged.
 *
 * `missingParentSpanId` is passed unconditionally: it is only ever set for a
 * `missing-parent` event, and `createTraceNode` keeps it only on an orphaned
 * node, so the two cannot disagree.
 */
function placementFlags(state: GroupState, index: number): TraceNodeOrphanFlags | undefined {
  const orphanReason = state.orphanReason[index];
  if (orphanReason === undefined) {
    return undefined;
  }

  return { orphanReason, missingParentSpanId: state.missingParentSpanId[index] };
}

/**
 * The event's root affinity, guarded against a kind the vocabulary does not
 * contain.
 *
 * `kind` is typed, so the guard is unreachable from typed code — but a
 * correlated trace is also built from rows read back out of the session store,
 * possibly written by a newer build, and AAP 0.5.5 requires that one malformed
 * event never crash the ingest loop. Such an event scores
 * {@link MIN_ROOT_AFFINITY}: it can never outrank a known kind, and the
 * canonical tie-break decides among equals.
 */
function rootAffinityOf(state: GroupState, index: number): number {
  const event = state.events[index];
  if (event === undefined) {
    return MIN_ROOT_AFFINITY;
  }

  return rootAffinityOfEvent(event);
}

/**
 * One event's root affinity, guarded exactly as {@link rootAffinityOf} guards
 * it: the single definition both the full correlation's root selection and the
 * incremental extension's anchor check score an event with, so the two can
 * never rank the same root differently.
 */
function rootAffinityOfEvent(event: TelemetryEvent): number {
  const kind = event.kind;
  return isTelemetryKind(kind) ? rootAffinityForKind(kind) : MIN_ROOT_AFFINITY;
}

/**
 * Chooses the trace's roots and the root everything repaired hangs from.
 *
 * Genuine roots — events that named no parent — are the trace's roots, all of
 * them: several roots is a normal, reportable condition rather than an error
 * (`TraceTree`), and collapsing them would invent a hierarchy the application
 * did not have. The **primary root** among them is the one with the highest
 * {@link rootAffinityForKind}, ties broken canonically, which is the single
 * decision that ranking exists for.
 *
 * When there is no genuine root — every event named a parent, and the only
 * parentless events are the ones the earlier passes flagged; the "server spans
 * arrived before the browser batch" case, or a trace that is nothing but a
 * cycle — the canonically first parentless event becomes the primary root and
 * **keeps its flag**, so the tree reports that its own anchor is a repair. No
 * synthetic event is ever fabricated to stand in for the interaction that was
 * not captured.
 *
 * @param state The working state, after {@link breakCycles}.
 * @returns The selection, or `undefined` for an empty group — which
 * {@link correlateEvents} never produces, since it only builds groups from
 * events.
 */
function selectRoots(state: GroupState): RootSelection | undefined {
  const count = state.events.length;
  const parentless: number[] = [];
  const genuineRoots: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const placed = state.parentIndex[index] !== undefined && state.detached[index] !== true;
    if (placed) {
      continue;
    }

    parentless.push(index);
    if (state.orphanReason[index] === undefined) {
      genuineRoots.push(index);
    }
  }

  const firstGenuine = genuineRoots[0];
  if (firstGenuine === undefined) {
    const fallback = parentless[0];
    if (fallback === undefined) {
      return undefined;
    }

    return {
      rootIndices: [fallback],
      orphanIndices: parentless.slice(1),
      primaryIndex: fallback,
    };
  }

  let primaryIndex: number = firstGenuine;
  let bestAffinity = rootAffinityOf(state, firstGenuine);
  for (const index of genuineRoots) {
    const affinity = rootAffinityOf(state, index);
    // Strictly greater, so a tie keeps the canonically earlier root.
    if (affinity > bestAffinity) {
      bestAffinity = affinity;
      primaryIndex = index;
    }
  }

  const genuine = new Set<number>(genuineRoots);
  return {
    rootIndices: genuineRoots,
    orphanIndices: parentless.filter((index) => !genuine.has(index)),
    primaryIndex,
  };
}

/**
 * One frame of the materialisation stack: a node being built, the children
 * built for it so far, and how far through its child list the walk has got.
 */
interface BuildFrame {
  /** The index of the event this frame will become a node for. */
  readonly index: number;
  /** The depth to record on the node. */
  readonly depth: number;
  /** The orphan flags for this node; set on a placement's own frame only. */
  readonly flags: TraceNodeOrphanFlags | undefined;
  /** How many of this node's children have been pushed. */
  cursor: number;
  /** The finished child nodes, in canonical order. */
  readonly children: TraceNode[];
}

/**
 * Builds one placement's subtree, depth-first with an **explicit stack**.
 *
 * Recursion is not an option here. A capture of a hundred thousand events is
 * realistic, a chain in it can be thousands of nodes long, and a stack
 * overflow inside this function would take the service's ingest loop or the
 * DevTools panel with it. The stack below turns "too deep" into memory
 * pressure and, past `maxDepth`, into an explicit, flagged repair.
 *
 * Nodes are created on the way back *up*: a frame is only turned into a
 * {@link TraceNode} once its cursor has passed every child, so `children` is
 * already complete and already in canonical order — the walk visits siblings
 * left to right and finishes each subtree before starting the next, so no
 * reversal and no re-sort is needed.
 *
 * ## The depth guard
 *
 * A child that would sit deeper than `maxDepth` is detached, flagged
 * `max-depth` and pushed onto `sink` as a new placement at
 * {@link ORPHAN_DEPTH}; the tree is marked `truncated`. Its own subtree is
 * then built from that new placement, which may hit the guard again — a long
 * chain therefore becomes a series of repaired branches under the primary root
 * instead of one impossibly deep spine, and every node is still present.
 * Termination holds because `detached` is set before the eviction is queued, so
 * no node is ever descended into or queued twice, and the queue is bounded by
 * the size of the group.
 *
 * @param state The working state; `detached`, `orphanReason` and `truncated`
 * are written when the depth guard fires.
 * @param placement The subtree root to build.
 * @param maxDepth The deepest node to place.
 * @param sink The placement queue, which receives the nodes the guard lifts.
 * @returns The subtree's root node, or `undefined` for an index the group does
 * not hold (unreachable from {@link correlateGroup}).
 */
function materialiseSubtree(
  state: GroupState,
  placement: Placement,
  maxDepth: number,
  sink: Placement[],
): TraceNode | undefined {
  const stack: BuildFrame[] = [
    {
      index: placement.index,
      depth: placement.depth,
      flags: placementFlags(state, placement.index),
      cursor: 0,
      children: [],
    },
  ];
  let built: TraceNode | undefined;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      // Unreachable while the loop condition holds; see `indexBySpanId`.
      break;
    }

    const children = state.childIndices.get(frame.index) ?? EMPTY_INDEX_LIST;
    if (frame.cursor < children.length) {
      const childIndex = children[frame.cursor];
      frame.cursor += 1;

      if (childIndex === undefined || state.detached[childIndex] === true) {
        // Either unreachable (a dense array) or a node that has been lifted
        // out of this child list and is placed as a repair of its own.
        continue;
      }

      const childDepth = frame.depth + 1;
      if (childDepth > maxDepth) {
        state.detached[childIndex] = true;
        state.orphanReason[childIndex] = 'max-depth';
        state.truncated = true;
        sink.push({ index: childIndex, depth: ORPHAN_DEPTH, orphan: true });
        continue;
      }

      stack.push({
        index: childIndex,
        depth: childDepth,
        flags: undefined,
        cursor: 0,
        children: [],
      });
      continue;
    }

    stack.pop();

    const event = state.events[frame.index];
    if (event === undefined) {
      continue;
    }

    const node = createTraceNode(event, frame.children, frame.depth, frame.flags);
    const parentFrame = stack[stack.length - 1];
    if (parentFrame === undefined) {
      built = node;
      continue;
    }
    parentFrame.children.push(node);
  }

  return built;
}

/**
 * Correlates one `traceId`'s events into one tree.
 *
 * The six passes, in order: sort canonically, index by span id, resolve
 * parentage, cut cycles, choose the roots, materialise. The repaired nodes are
 * then appended to the primary root **after its real children and in canonical
 * order among themselves**, so a developer reads the structure the application
 * actually had first and the repairs after it, in a position that does not
 * depend on which batch arrived when.
 *
 * Because repairs are appended, the primary root's node is rebuilt once with
 * the orphan children added — nodes are immutable by contract, and the
 * repaired set is only complete after every placement (including the depth
 * guard's) has been materialised.
 *
 * Every aggregate on the result — `nodeCount`, `maxDepth`, `startTime`,
 * `endTime`, `totalDuration`, `orphanCount`, `tiers`, `kinds`, `producerIds` —
 * is derived by `buildTraceTree` from one walk of the finished roots. None of
 * them is accumulated here, so none of them can drift from the nodes it
 * describes.
 *
 * @param traceId The id every event in `group` shares.
 * @param group That trace's events, in any order.
 * @param maxDepth The deepest node to place, already normalised.
 * @returns The correlated tree. `nodeCount` equals `group.length`.
 */
function correlateGroup(
  traceId: TraceId,
  group: readonly TelemetryEvent[],
  maxDepth: number,
): TraceTree {
  const events = sortEventsCanonical(group);
  const spanIdIndex = indexBySpanId(events);
  const state = resolveParentage(events, spanIdIndex.bySpanId);
  breakCycles(state);

  const selection = selectRoots(state);
  if (selection === undefined) {
    // Only an empty group reaches this, which `correlateEvents` cannot build.
    // An empty tree - zeroes and empty lists throughout - is the documented
    // answer for "this trace has no events" (`buildTraceTree`).
    return buildTraceTree(traceId, [], { duplicateSpanIds: spanIdIndex.duplicateSpanIds });
  }

  /*
   * The placement queue is also the depth guard's sink: `materialiseSubtree`
   * appends the nodes it lifts, and this loop picks them up because it re-reads
   * `placements.length` on every iteration. Each node is placed at most once
   * (`detached` is set before an eviction is queued), so the queue is bounded
   * by the group's size and the loop terminates.
   */
  const placements: Placement[] = [];
  for (const index of selection.rootIndices) {
    placements.push({ index, depth: ROOT_DEPTH, orphan: false });
  }
  for (const index of selection.orphanIndices) {
    placements.push({ index, depth: ORPHAN_DEPTH, orphan: true });
  }

  const rootNodes = new Map<number, TraceNode>();
  const repaired: { readonly index: number; readonly node: TraceNode }[] = [];

  for (let cursor = 0; cursor < placements.length; cursor += 1) {
    const placement = placements[cursor];
    if (placement === undefined) {
      continue;
    }

    const node = materialiseSubtree(state, placement, maxDepth, placements);
    if (node === undefined) {
      continue;
    }

    if (placement.orphan) {
      repaired.push({ index: placement.index, node });
      continue;
    }
    rootNodes.set(placement.index, node);
  }

  // Canonical order among the repairs, independent of the order in which the
  // cycle pass and the depth guard discovered them.
  repaired.sort((left, right) => left.index - right.index);
  const repairedNodes = repaired.map((entry) => entry.node);

  const roots: TraceNode[] = [];
  for (const index of selection.rootIndices) {
    const node = rootNodes.get(index);
    if (node === undefined) {
      continue;
    }

    if (index !== selection.primaryIndex || repairedNodes.length === 0) {
      roots.push(node);
      continue;
    }

    const event = state.events[index];
    if (event === undefined) {
      roots.push(node);
      continue;
    }

    roots.push(
      createTraceNode(
        event,
        [...node.children, ...repairedNodes],
        ROOT_DEPTH,
        placementFlags(state, index),
      ),
    );
  }

  const primaryEvent = state.events[selection.primaryIndex];
  return buildTraceTree(traceId, roots, {
    primaryRootSpanId: primaryEvent?.spanId,
    duplicateSpanIds: spanIdIndex.duplicateSpanIds,
    truncated: state.truncated,
  });
}

/**
 * Orders two trees for {@link CorrelationResult.traces}: ascending by
 * `startTime`, then by `traceId`.
 *
 * A trace id is unique per tree, so this is a total order and the array cannot
 * depend on which group the input happened to introduce first. `startTime` is
 * `0` for an empty tree, which sorts such a tree first — harmless, since a
 * correlated capture has no empty trees.
 */
function compareTraces(left: TraceTree, right: TraceTree): number {
  if (left.startTime < right.startTime) {
    return -1;
  }
  if (left.startTime > right.startTime) {
    return 1;
  }
  return compareStrings(left.traceId, right.traceId);
}

/**
 * Normalises a caller's depth bound.
 *
 * A bound that is not a non-negative integer is a caller bug — a `NaN` from a
 * parsed configuration value, a negative from an off-by-one — and it is
 * answered with the default rather than with a throw: correlation runs on the
 * ingest path, where AAP 0.5.5 requires that a bad input degrade rather than
 * stop the capture. `0` is a legitimate bound and is honoured: it places the
 * roots and repairs everything else.
 */
function resolveMaxDepth(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 0) {
    return DEFAULT_MAX_DEPTH;
  }
  return requested;
}

/*
 * ---------------------------------------------------------------------------
 * Entry points
 * ---------------------------------------------------------------------------
 */

/**
 * Correlates a flat list of persisted events into one ordered tree per
 * `traceId`.
 *
 * This is the function the whole module exists for; the guarantees it upholds —
 * the canonical order, orphan preservation, permutation invariance and purity —
 * are stated on the module documentation above.
 *
 * ## Grouping is by `traceId` alone
 *
 * Deliberately, and not by `(sessionId, captureId, traceId)`. A trace is the
 * join between the browser agent's spans and the Node preload's spans, and that
 * join is the trace id (AAP 0.4.2); a capture also survives a page reload with
 * its `captureId` intact (AAP 0.5.5). Narrowing to one session or one capture
 * is the caller's query, not this function's assumption.
 *
 * ## Cost
 *
 * `O(n log n)` for the canonical sort of each group plus a constant number of
 * linear passes: no step scans the input per event, so a hundred-thousand-event
 * capture is a handful of passes rather than a quadratic blow-up.
 *
 * @param events The capture's persisted events, in any order. Neither the array
 * nor any event is modified.
 * @param options The depth bound; see {@link CorrelateOptions}.
 * @returns Every trace, with the audit counts described on
 * {@link CorrelationResult}. An empty input yields empty collections and zero
 * counts rather than a special case for a caller to handle.
 *
 * @example
 * ```ts
 * const result = correlateEvents(await telemetryRepo.forCapture(captureId));
 * for (const trace of result.traces) {
 *   renderTimeline(trace);
 * }
 * ```
 */
export function correlateEvents(
  events: readonly TelemetryEvent[],
  options?: CorrelateOptions,
): CorrelationResult {
  const eventCount = events.length;
  if (eventCount === 0) {
    // A fresh map and array every time: a shared empty collection would be a
    // module-level object a caller could write into.
    return {
      traces: [],
      byTraceId: new Map<TraceId, TraceTree>(),
      traceCount: 0,
      eventCount: 0,
      orphanCount: 0,
    };
  }

  const maxDepth = resolveMaxDepth(options?.maxDepth);

  const groups = new Map<TraceId, TelemetryEvent[]>();
  for (const event of events) {
    const group = groups.get(event.traceId);
    if (group === undefined) {
      groups.set(event.traceId, [event]);
      continue;
    }
    group.push(event);
  }

  const traces: TraceTree[] = [];
  for (const [traceId, group] of groups) {
    traces.push(correlateGroup(traceId, group, maxDepth));
  }
  traces.sort(compareTraces);

  const byTraceId = new Map<TraceId, TraceTree>();
  let orphanCount = 0;
  for (const trace of traces) {
    byTraceId.set(trace.traceId, trace);
    orphanCount += trace.orphanCount;
  }

  return { traces, byTraceId, traceCount: traces.length, eventCount, orphanCount };
}

/**
 * Correlates one trace out of a larger event list.
 *
 * The entry point for `{ source: 'trace', filter: { traceId } }` in
 * `apps/local-service/src/panels/data.ts`, and a thin wrapper by design: it
 * filters once and delegates, so the full rebuild the service falls back to
 * when {@link extendCorrelatedTrace} refuses a batch stays as cheap as one
 * pass plus one sort over the events of a single trace.
 *
 * @param events Any events; only those carrying `traceId` are considered.
 * @param traceId The trace to correlate.
 * @param options The depth bound; see {@link CorrelateOptions}.
 * @returns That trace's tree, or `undefined` when no event carries the id —
 * which is an ordinary outcome for a trace that has been purged by retention or
 * whose events have not arrived yet, and is why this is `undefined` rather than
 * an empty tree a caller could mistake for a captured one.
 */
export function correlateTrace(
  events: readonly TelemetryEvent[],
  traceId: TraceId,
  options?: CorrelateOptions,
): TraceTree | undefined {
  const scoped = events.filter((event) => event.traceId === traceId);
  if (scoped.length === 0) {
    return undefined;
  }

  // Exactly one group, since every event shares the id; `traces[0]` is it.
  return correlateEvents(scoped, options).traces[0];
}

/*
 * ---------------------------------------------------------------------------
 * Incremental extension
 *
 * The service keeps correlated trees cached while a capture streams in, and a
 * persisted batch usually does nothing more than hang new spans under spans
 * the tree already holds. Re-correlating the whole trace for that — reloading
 * and re-sorting every stored row — costs `O(n)` per batch and `O(n²/b)` over
 * a capture of `n` events in batches of `b`. {@link extendCorrelatedTrace}
 * applies such a batch — new spans under known parents, new roots that do not
 * move the anchor, new orphans, and the late parents that adopt earlier
 * orphans — in `O(b log b)` plus the subtrees it moves and the paths it
 * touches, and is **exact**: every tree it returns is identical — deeply and
 * in `JSON.stringify` key order — to
 * `correlateTrace(rows ∪ batch, traceId, options)`, where `rows` are the
 * events the indexed tree was correlated from. Whatever it cannot apply
 * exactly it refuses, and the caller falls back to that full correlation.
 *
 * ## Why the answer is exact, case by case
 *
 * Write `R` for the rows behind the indexed tree, `B` for the batch's new
 * events (replays of rows already in `R` are removed first), `G(R)` for the
 * genuine roots of `R` (events that named no parent), `F(R)` for its flagged
 * parentless events (`missing-parent` and `self-parent`) and `π` for the
 * primary root. The index admits only trees with unique span ids, no `cycle`
 * or `max-depth` repair and no truncation, so every node of `R` is a root,
 * a repair hanging from `π` at `ORPHAN_DEPTH`, or a real child of the span its
 * event names. `correlateGroup` over `R ∪ B` resolves parentage, cuts cycles,
 * selects the roots and materialises; the extension reproduces each decision.
 *
 * - **Parentage.** An event of `R` keeps the parent it resolved, which is still
 *   present, and a self-parent stays one; a `missing-parent` orphan of `R`
 *   stays one unless `B` carries the span it names (case C). An event of `B`
 *   resolves exactly as `resolveParentage` resolves it against the span ids of
 *   `R ∪ B`: no parent (case A), itself (case B), a span of `R` or `B` (a real
 *   child), or neither (case B).
 * - **A. A new genuine root `z`.** The roots are the genuine roots in canonical
 *   order, and `selectRoots` anchors on the canonically first root of maximal
 *   {@link rootAffinityForKind}. So while `G(R)` is non-empty `π` stays the
 *   anchor exactly when `z` scores lower than `π`, or the same and sorts after
 *   it; `z` is then merged into the roots at its canonical position and its
 *   batch subtree is built from depth 0. Every other `z` moves the anchor.
 * - **B. A new flagged parentless event `x`** — `self-parent`, or
 *   `missing-parent` naming a span in neither `R` nor `B`. `correlateGroup`
 *   repairs it under the anchor at `ORPHAN_DEPTH` with the flags
 *   `placementFlags` gives it (`missingParentSpanId` for `missing-parent`
 *   only), without a depth check on the repair itself, and appends the repairs
 *   after the real children sorted by canonical index — so `x` is merged into
 *   `π`'s repaired suffix at its canonical position, and its batch subtree is
 *   built from `ORPHAN_DEPTH + 1` under the depth guard. When `G(R)` is empty
 *   the anchor is the canonically first parentless event, so `π` stays the
 *   anchor exactly when `x` sorts after it.
 * - **C. A late parent `y`**, whose span `s` the orphans `O_s ⊆ R` name. In
 *   `R ∪ B` each `o ∈ O_s` resolves to `y`: its flags clear, it leaves `π`'s
 *   suffix and it takes its canonical place among `y`'s children, carrying
 *   its subtree with it. `y` itself is placed by the rules above. Every repair
 *   of an indexable tree hangs from `π`, so `O_s` is found on `π`'s repaired
 *   suffix (or is `π` itself, a repaired anchor) and its size is checked
 *   against `missingParents`.
 * - **Cycles.** `R` is acyclic, so a loop in `R ∪ B` runs through a new edge:
 *   a new event's parent, or a moved orphan's `y`. Walking every such node's
 *   new ancestor chain up to a parentless event — jumping through `R` from a
 *   node to the top of its placement — finds every loop, including `y` inside
 *   the subtree of an orphan it adopts and a ring of several late parents.
 *   With none, every event is reached and the cycle pass lifts nothing.
 * - **Depths** are recomputed top-down over the new parent relation: a new
 *   event and a moved orphan sit one level below their new parent, and every
 *   node of a moved subtree shifts by its orphan's change of depth. A move is
 *   never shallower — a repair sits at depth 1, the shallowest a child can sit
 *   — and the extension verifies that instead of assuming it, which is what
 *   lets a running maximum stand for `maxDepth`. With every new real depth
 *   within the guard, the guard lifts nothing.
 * - **Sibling order.** Every changed child list, `π`'s repaired suffix and the
 *   roots are merged with {@link compareEventsCanonical}, which is the order
 *   `correlateGroup`'s ascending canonical index gives them.
 * - **Nodes and aggregates.** Nodes are immutable, so every node whose
 *   children, depth or flags change — the new nodes, the moved subtrees whose
 *   depth shifts, the orphans that lose their flags — and every ancestor that
 *   must hold a rebuilt child is built exactly once, deepest first, through
 *   {@link createTraceNode}, the factory `correlateGroup` uses; everything else
 *   is shared. The aggregates change by exactly what changed: new nodes are
 *   counted (a new repair as an orphan), a moved orphan stops counting as one,
 *   a rebuilt node's depth can only raise `maxDepth`, and `missingParents`
 *   loses the spans that arrived and gains those the new repairs name. The
 *   tree is assembled by `assembleTraceTree`, the assembler `buildTraceTree`
 *   uses, with `π`, the (empty) duplicate list and `truncated` carried over.
 *
 * ## Why each remaining refusal is required
 *
 * - `primary-change` — the anchor would move: a new genuine root outranks `π`
 *   or ties it and sorts first, a genuine root reaches a trace anchored on a
 *   repair (it becomes the anchor and the old one a repair), a new repair
 *   sorts ahead of a repaired anchor, or the anchor's own missing parent
 *   arrives. Every repair hangs from the anchor, so a new one re-parents every
 *   repair and reorders the roots: that is a correlation, not an extension.
 * - `duplicate-span` — children belong to the first canonical occurrence of a
 *   span id; a new event reusing an id could sort ahead of its owner and take
 *   every child from it.
 * - `cycle` — `correlateGroup` would lift the canonically first *unreached*
 *   event, which may hang under the loop rather than sit on it, and only the
 *   full pass knows which.
 * - `max-depth` — a real child would sit past the guard, which lifts it to the
 *   anchor, flags it and marks the tree truncated.
 * - `ambiguous-order` — two siblings, or two roots, tie on every canonical key
 *   (rows the store writes never do), so the correlator's stable sort would
 *   order them by input order, which the extension cannot know.
 * - `stale-replay` — the same event id with another arrival number: the store
 *   no longer holds the row the tree was built from.
 * - `non-finite-time` — the aggregates skip such a time and the comparator is
 *   no longer a total order over it.
 * - `options-mismatch` — another depth bound correlates differently from the
 *   first row on.
 * - `inconsistent-index` — the index no longer describes its tree (a caller
 *   edited it), so no answer derived from it can be trusted.
 *
 * ## The bound on refusals
 *
 * What a real capture streams — nodes under known parents, orphans whose
 * parent is still in flight, the late parents that adopt them and roots that
 * do not outrank the anchor — always extends. Of the structural refusals, only
 * `primary-change` is reachable from well-formed producers, and for one trace
 * it can occur only while the trace has no genuine root (every event so far
 * named a parent: the server spans landed before the browser batch), plus once
 * per genuine root that arrives with a strictly higher affinity than the
 * anchor or the same affinity and an earlier canonical position — each such
 * refusal re-anchors the trace on a root every later one has to beat in that
 * same order. A product trace has one interaction root, so a normal stream
 * refuses a handful of times per trace, never once per request. Moves are
 * bounded as well: an orphan moves once, when its parent arrives, and a node
 * is carried by a move at most once per ancestor that arrives after it, so the
 * moved work over a capture of `n` events is at most `n` times its depth.
 * ---------------------------------------------------------------------------
 */

/**
 * Why {@link extendCorrelatedTrace} declined a batch; see the section notes for
 * why each one is required for exactness.
 *
 * Frozen and closed. A refusal is never an error: the batch is stored and the
 * caller rebuilds the tree from its complete row set with
 * {@link correlateTrace}, which handles every one of these cases.
 */
export const EXTENSION_REFUSAL_REASONS = Object.freeze([
  'primary-change',
  'duplicate-span',
  'cycle',
  'max-depth',
  'ambiguous-order',
  'stale-replay',
  'non-finite-time',
  'options-mismatch',
  'inconsistent-index',
] as const);

/** One member of the closed {@link EXTENSION_REFUSAL_REASONS} vocabulary. */
export type ExtensionRefusalReason = (typeof EXTENSION_REFUSAL_REASONS)[number];

/**
 * The running aggregates of an indexed tree: {@link TraceTree}'s derived fields
 * in the raw form `assembleTraceTree` takes, kept current as nodes are added
 * so that assembling an extended tree never walks it.
 */
export interface TraceExtensionAggregates {
  /** How many nodes the tree holds. */
  nodeCount: number;
  /** The greatest node depth. */
  maxDepth: number;
  /** How many nodes are flagged `orphaned`. */
  orphanCount: number;
  /** The smallest `event.startTime`; `undefined` only for an empty tree. */
  earliestStart: number | undefined;
  /** The largest `startTime + duration`; `undefined` only for an empty tree. */
  latestEnd: number | undefined;
  /** Every tier present. */
  readonly tiers: Set<TelemetryTier>;
  /** Every kind present. */
  readonly kinds: Set<TelemetryKind>;
  /** Every producer present. */
  readonly producerIds: Set<ProducerId>;
}

/**
 * What {@link extendCorrelatedTrace} needs to know about a correlated tree to
 * grow it without walking it: built once by {@link indexTraceForExtension} in
 * one `O(n)` walk and kept current by every successful extension.
 *
 * ## Ownership
 *
 * The index is **mutable and owned**: exactly one caller holds it, only
 * {@link extendCorrelatedTrace} writes to it, and it always describes
 * {@link TraceExtensionIndex.tree}. A refused extension leaves it exactly as it
 * was. A caller that edits a member directly has an index that no longer
 * describes a correlated tree; the extension then either refuses with
 * `inconsistent-index` or answers with a tree that is not a correlation.
 *
 * ## What it holds, and what it deliberately does not
 *
 * - `nodeBySpanId` — the current node of every span: the parent lookup for new
 *   events, the replay check and the path-copy walk. One `Map` entry per node,
 *   sharing the span-id strings and node objects the tree already holds.
 * - `missingParents` — the span ids the tree's `missing-parent` orphans name,
 *   with how many name each: the late-parent lookup, and the count the
 *   orphans found on the anchor's repaired suffix are checked against. Kept
 *   current by every extension: a span that arrives leaves it, and a new
 *   orphan's missing parent joins it.
 * - The **placement parent** of a node is *derived*, not stored: a root has
 *   none, a repaired node (orphaned, below a root) hangs from the primary
 *   root, and every other node from the span its event names.
 *   {@link indexTraceForExtension} verifies that derivation for every node,
 *   which keeps the index to one entry per node instead of two.
 * - The running {@link TraceExtensionIndex.aggregates}.
 */
export interface TraceExtensionIndex {
  /** The trace the index describes. */
  readonly traceId: TraceId;
  /** The depth guard the tree was correlated under, normalised. */
  readonly depthLimit: number;
  /** The root the trace is anchored on; never changed by an extension. */
  readonly primaryRootSpanId: SpanId;
  /** The tree the index currently describes; replaced by every extension. */
  tree: TraceTree;
  /** The current node of every span. */
  readonly nodeBySpanId: Map<SpanId, TraceNode>;
  /** The span ids `missing-parent` orphans name, with how many name each. */
  readonly missingParents: Map<SpanId, number>;
  /** The derived fields of {@link TraceExtensionIndex.tree}, in raw form. */
  readonly aggregates: TraceExtensionAggregates;
}

/**
 * The outcome of one {@link extendCorrelatedTrace} call.
 *
 * - `extended` — `tree` is exactly `correlateTrace` over the indexed rows plus
 *   the batch's new events. `added` counts those new events (`0` for a batch
 *   of replays, whose `tree` is the indexed tree itself), and `nodesBuilt`
 *   counts the node objects the extension created: the new nodes, every node
 *   of a moved subtree whose depth changed, every orphan that lost its flags,
 *   and every ancestor copied to hold one of them — the extension's whole cost
 *   in nodes.
 * - `refused` — nothing was changed; `reason` says why the batch cannot be
 *   applied exactly.
 */
export type TraceExtensionResult =
  | {
      readonly kind: 'extended';
      readonly tree: TraceTree;
      readonly added: number;
      readonly nodesBuilt: number;
    }
  | { readonly kind: 'refused'; readonly reason: ExtensionRefusalReason };

/** A refusal, as {@link TraceExtensionResult} carries it. */
type ExtensionRefusal = Extract<TraceExtensionResult, { readonly kind: 'refused' }>;

/** The refusal carrying `reason`. */
function refuse(reason: ExtensionRefusalReason): ExtensionRefusal {
  return { kind: 'refused', reason };
}

/** Whether a step of the extension answered with a refusal. */
function isRefusal<T extends object>(value: T | ExtensionRefusal): value is ExtensionRefusal {
  return 'kind' in value && value.kind === 'refused';
}

/**
 * The span a node is placed under, derived from the node itself: `undefined`
 * for a root, the primary root for a repaired node, and otherwise the span its
 * event names — which, in a tree whose span ids are unique, is exactly the
 * parent `correlateGroup` resolved.
 *
 * @param primaryRootSpanId The trace's anchor.
 * @param node Any node of the indexed tree.
 * @returns The placement parent's span id.
 */
function parentSpanOf(primaryRootSpanId: SpanId, node: TraceNode): SpanId | undefined {
  if (node.depth === ROOT_DEPTH) {
    return undefined;
  }
  if (node.orphaned) {
    return primaryRootSpanId;
  }
  return node.event.parentSpanId;
}

/**
 * Whether a node's times are finite, as every aggregate and the comparator
 * require of an extendable tree.
 */
function hasFiniteTimes(event: TelemetryEvent): boolean {
  return Number.isFinite(event.startTime) && Number.isFinite(event.startTime + event.duration);
}

/**
 * Adds one node to running aggregates, exactly as `buildTraceTree`'s walk
 * counts it.
 *
 * @param aggregates The aggregates to update.
 * @param node A node whose times are finite.
 */
function accumulateNode(aggregates: TraceExtensionAggregates, node: TraceNode): void {
  aggregates.nodeCount += 1;
  if (node.depth > aggregates.maxDepth) {
    aggregates.maxDepth = node.depth;
  }
  if (node.orphaned) {
    aggregates.orphanCount += 1;
  }

  aggregates.tiers.add(node.event.tier);
  aggregates.kinds.add(node.event.kind);
  aggregates.producerIds.add(node.event.producerId);

  const start = node.event.startTime;
  if (aggregates.earliestStart === undefined || start < aggregates.earliestStart) {
    aggregates.earliestStart = start;
  }
  const end = nodeEndTime(node);
  if (aggregates.latestEnd === undefined || end > aggregates.latestEnd) {
    aggregates.latestEnd = end;
  }
}

/**
 * Whether one node sits exactly where `correlateGroup` would have placed it in
 * an untruncated, acyclic tree — the property that makes the derived
 * {@link parentSpanOf} and the refusal argument valid for it.
 *
 * @param node The node.
 * @param parent The node it hangs from in the tree, `undefined` for a root.
 * @param tree The tree being indexed.
 * @param primaryRootSpanId The tree's anchor.
 * @param depthLimit The depth guard it was correlated under.
 * @returns `true` when the placement is one the correlator produces.
 */
function isCorrelatedPlacement(
  node: TraceNode,
  parent: TraceNode | undefined,
  tree: TraceTree,
  primaryRootSpanId: SpanId,
  depthLimit: number,
): boolean {
  const event = node.event;
  if (event.traceId !== tree.traceId || !hasFiniteTimes(event)) {
    return false;
  }
  // A cycle repair or a depth-guard lift is exactly what a new batch could
  // move (section notes, 4 and 5).
  if (node.orphanReason === 'cycle' || node.orphanReason === 'max-depth') {
    return false;
  }

  if (parent === undefined) {
    if (node.depth !== ROOT_DEPTH) {
      return false;
    }
    // A flagged root is the fallback anchor of a trace with no genuine root,
    // which is then its only root; an unflagged root named no parent.
    return node.orphaned
      ? event.spanId === primaryRootSpanId && tree.roots.length === 1
      : event.parentSpanId === undefined;
  }

  if (node.depth !== parent.depth + 1) {
    return false;
  }

  if (node.orphaned) {
    // Repairs hang from the primary root, one level down.
    if (parent.event.spanId !== primaryRootSpanId || parent.depth !== ROOT_DEPTH) {
      return false;
    }
    if (node.orphanReason === 'self-parent') {
      return event.parentSpanId === event.spanId;
    }
    return event.parentSpanId !== undefined;
  }

  // A real child: under the span its event names, within the depth guard.
  return event.parentSpanId === parent.event.spanId && node.depth <= depthLimit;
}

/**
 * Indexes a correlated tree for {@link extendCorrelatedTrace}, in one `O(n)`
 * walk — or reports that it cannot be extended exactly.
 *
 * ## Not extendable
 *
 * `undefined` is returned for a tree that holds repeated span ids, is
 * `truncated`, holds a `cycle` repair, has a node with a non-finite start or
 * end, is empty, or has any node the correlator would not have placed where
 * it is (a hand-built or edited tree). Each of these is a state a later batch
 * could change in a way only a full correlation reproduces (see the section
 * notes); the caller keeps rebuilding such a trace from its rows instead.
 *
 * @param tree A tree {@link correlateTrace} returned.
 * @param options The depth bound it was correlated under; the same one must be
 * passed to every extension.
 * @returns A fresh index the caller owns, or `undefined`.
 *
 * @example
 * ```ts
 * const tree = correlateTrace(rows, traceId, { maxDepth });
 * const index = tree === undefined ? undefined : indexTraceForExtension(tree, { maxDepth });
 * const next = index === undefined ? undefined : extendCorrelatedTrace(index, batch, { maxDepth });
 * ```
 */
export function indexTraceForExtension(
  tree: TraceTree,
  options?: CorrelateOptions,
): TraceExtensionIndex | undefined {
  const primaryRootSpanId = tree.primaryRootSpanId;
  if (tree.truncated || tree.duplicateSpanIds.length > 0 || primaryRootSpanId === undefined) {
    return undefined;
  }

  const depthLimit = resolveMaxDepth(options?.maxDepth);
  const nodeBySpanId = new Map<SpanId, TraceNode>();
  const missingParents = new Map<SpanId, number>();
  const aggregates: TraceExtensionAggregates = {
    nodeCount: 0,
    maxDepth: 0,
    orphanCount: 0,
    earliestStart: undefined,
    latestEnd: undefined,
    tiers: new Set<TelemetryTier>(),
    kinds: new Set<TelemetryKind>(),
    producerIds: new Set<ProducerId>(),
  };

  // An explicit stack, so a deep trace cannot overflow the call stack and the
  // walk can stop at the first node that disqualifies the tree.
  const stack: { readonly node: TraceNode; readonly parent: TraceNode | undefined }[] = [];
  for (const root of tree.roots) {
    stack.push({ node: root, parent: undefined });
  }

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      // Unreachable while the loop condition holds; see `indexBySpanId`.
      break;
    }

    const { node, parent } = frame;
    const spanId = node.event.spanId;
    if (
      nodeBySpanId.has(spanId) ||
      !isCorrelatedPlacement(node, parent, tree, primaryRootSpanId, depthLimit)
    ) {
      return undefined;
    }

    nodeBySpanId.set(spanId, node);
    accumulateNode(aggregates, node);

    if (node.orphanReason === 'missing-parent') {
      const named = node.event.parentSpanId;
      if (named === undefined) {
        return undefined;
      }
      missingParents.set(named, (missingParents.get(named) ?? 0) + 1);
    }

    // Real children first, then the repaired suffix: the only order
    // `correlateGroup` produces, and the one the prefix merge relies on.
    let inRepairedSuffix = false;
    for (const child of node.children) {
      if (child.orphaned) {
        inRepairedSuffix = true;
      } else if (inRepairedSuffix) {
        return undefined;
      }
      stack.push({ node: child, parent: node });
    }
  }

  // A missing parent the tree holds is an orphan the correlator would have
  // placed; an anchor that is not a root is not the correlator's anchor.
  for (const named of missingParents.keys()) {
    if (nodeBySpanId.has(named)) {
      return undefined;
    }
  }
  if (nodeBySpanId.get(primaryRootSpanId)?.depth !== ROOT_DEPTH) {
    return undefined;
  }

  // The tree's own numbers must be the ones its nodes add up to, or an
  // extension would assemble from totals that describe some other tree.
  if (
    aggregates.nodeCount !== tree.nodeCount ||
    aggregates.maxDepth !== tree.maxDepth ||
    aggregates.orphanCount !== tree.orphanCount ||
    (aggregates.earliestStart ?? 0) !== tree.startTime ||
    (aggregates.latestEnd ?? 0) !== tree.endTime
  ) {
    return undefined;
  }

  return {
    traceId: tree.traceId,
    depthLimit,
    primaryRootSpanId,
    tree,
    nodeBySpanId,
    missingParents,
    aggregates,
  };
}

/** The batch's new events, after replays were removed and each was checked. */
interface AdmittedBatch {
  /** The new events, in batch order. */
  readonly fresh: readonly TelemetryEvent[];
  /** The same events by span id. */
  readonly bySpanId: ReadonlyMap<SpanId, TelemetryEvent>;
}

/**
 * Removes replays from a batch and checks every new event against the
 * refusals that concern one event at a time: `duplicate-span`, `stale-replay`
 * and `non-finite-time` (section notes).
 *
 * @param index The index; read only.
 * @param events The batch; events of other traces are ignored, exactly as
 * {@link correlateTrace} ignores them.
 * @returns The admitted batch, or the first refusal in batch order.
 */
function admitBatch(
  index: TraceExtensionIndex,
  events: readonly TelemetryEvent[],
): AdmittedBatch | ExtensionRefusal {
  const fresh: TelemetryEvent[] = [];
  const bySpanId = new Map<SpanId, TelemetryEvent>();

  for (const event of events) {
    if (event.traceId !== index.traceId) {
      continue;
    }

    const earlier = index.nodeBySpanId.get(event.spanId)?.event ?? bySpanId.get(event.spanId);
    if (earlier !== undefined) {
      if (earlier.id !== event.id) {
        return refuse('duplicate-span');
      }
      if (earlier.ingestSeq !== event.ingestSeq) {
        return refuse('stale-replay');
      }
      // The same stored row delivered again — a buffer replay, or the store
      // returning one row twice for a batch that repeated it.
      continue;
    }

    bySpanId.set(event.spanId, event);
    fresh.push(event);
  }

  for (const event of fresh) {
    if (!hasFiniteTimes(event)) {
      return refuse('non-finite-time');
    }
  }

  return { fresh, bySpanId };
}

/**
 * Where `correlateGroup` over `R ∪ B` places one new event, decided exactly as
 * `resolveParentage` decides it (section notes, cases A and B):
 *
 * - `root` — it named no parent: a genuine root;
 * - `repair` — it named itself, or a span in neither the tree nor the batch:
 *   a repaired child of the anchor, with the flags `placementFlags` gives it;
 * - `child` — a real child of the span it named, in the tree or in the batch.
 */
type NewPlacement =
  | { readonly kind: 'root' }
  | { readonly kind: 'repair'; readonly flags: TraceNodeOrphanFlags }
  | { readonly kind: 'child'; readonly parentSpanId: SpanId };

/** The placement of every new genuine root; it carries nothing of its own. */
const GENUINE_ROOT_PLACEMENT: NewPlacement = { kind: 'root' };

/**
 * Places one new event against the span ids of `R ∪ B`.
 *
 * Span ids are unique across tree and batch by now (`admitBatch`), so a
 * resolvable parent is another event and the defensive `parent === index`
 * branch of `resolveParentage` has no counterpart here.
 *
 * @param index The index; read only.
 * @param batch The admitted batch.
 * @param event One of its new events.
 * @returns The placement.
 */
function placeNewEvent(
  index: TraceExtensionIndex,
  batch: AdmittedBatch,
  event: TelemetryEvent,
): NewPlacement {
  const parentSpanId = event.parentSpanId;
  if (parentSpanId === undefined) {
    return GENUINE_ROOT_PLACEMENT;
  }
  if (parentSpanId === event.spanId) {
    return { kind: 'repair', flags: { orphanReason: 'self-parent' } };
  }
  if (index.nodeBySpanId.has(parentSpanId) || batch.bySpanId.has(parentSpanId)) {
    return { kind: 'child', parentSpanId };
  }
  return {
    kind: 'repair',
    flags: { orphanReason: 'missing-parent', missingParentSpanId: parentSpanId },
  };
}

/** An orphan of the indexed tree whose missing parent the batch carries (case C). */
interface MovedOrphan {
  /** Its node in the indexed tree: a repair of the anchor, or the anchor itself. */
  readonly node: TraceNode;
  /** The late parent it now hangs from: a new event of the batch. */
  readonly parentSpanId: SpanId;
}

/**
 * Finds the orphans `O_s` of every late parent in the batch: the anchor itself
 * when it is a repaired anchor naming one, and the `missing-parent` repairs on
 * its suffix that name one — where every repair of an indexable tree hangs.
 *
 * Only the suffix is scanned, from its end, and only when `missingParents`
 * says the batch carries a late parent at all; the anchor is rebuilt whenever
 * an orphan leaves its suffix, so the scan costs no more than that rebuild.
 *
 * @param index The index; read only.
 * @param batch The admitted batch.
 * @param primary The anchor's current node.
 * @returns The moved orphans by span id, in canonical order (the suffix's), or
 * `inconsistent-index` when their number is not the one `missingParents`
 * records.
 */
function collectMovedOrphans(
  index: TraceExtensionIndex,
  batch: AdmittedBatch,
  primary: TraceNode,
): Map<SpanId, MovedOrphan> | ExtensionRefusal {
  const moved = new Map<SpanId, MovedOrphan>();

  let expected = 0;
  for (const event of batch.fresh) {
    expected += index.missingParents.get(event.spanId) ?? 0;
  }
  if (expected === 0) {
    return moved;
  }

  const consider = (node: TraceNode): void => {
    if (node.orphanReason !== 'missing-parent') {
      return;
    }
    const named = node.event.parentSpanId;
    if (named !== undefined && batch.bySpanId.has(named)) {
      moved.set(node.event.spanId, { node, parentSpanId: named });
    }
  };

  consider(primary);
  const children = primary.children;
  let suffixStart = children.length;
  while (suffixStart > 0 && children[suffixStart - 1]?.orphaned === true) {
    suffixStart -= 1;
  }
  for (let position = suffixStart; position < children.length; position += 1) {
    const child = children[position];
    if (child !== undefined) {
      consider(child);
    }
  }

  return moved.size === expected ? moved : refuse('inconsistent-index');
}

/**
 * How one node's new depth follows: outright (`anchor`), or from the node one
 * link further up its new ancestor chain (`link`, at `offset` levels below it).
 */
type DepthLink =
  | { readonly kind: 'anchor'; readonly depth: number }
  | { readonly kind: 'link'; readonly next: SpanId; readonly offset: number };

/**
 * The top of the placement a node of the indexed tree sits in: the first
 * parentless event of `R` on its ancestor chain — a root, or a repair of the
 * anchor. Memoised for every node the walk passes, which share it.
 *
 * Each step must climb exactly one level, as it does in a correlated tree;
 * that check is also what bounds the walk against an edited index.
 *
 * @param index The index; read only.
 * @param spanId A span of the indexed tree.
 * @param tops The memo, shared across one extension.
 * @returns The top node, or `undefined` when the index does not describe its
 * tree.
 */
function placementTopOf(
  index: TraceExtensionIndex,
  spanId: SpanId,
  tops: Map<SpanId, TraceNode>,
): TraceNode | undefined {
  const path: SpanId[] = [];
  let cursor = index.nodeBySpanId.get(spanId);
  let top: TraceNode | undefined;

  while (cursor !== undefined) {
    const known = tops.get(cursor.event.spanId);
    if (known !== undefined) {
      top = known;
      break;
    }

    path.push(cursor.event.spanId);
    if (cursor.depth === ROOT_DEPTH || cursor.orphaned) {
      top = cursor;
      break;
    }

    const parentSpanId = cursor.event.parentSpanId;
    const parent = parentSpanId === undefined ? undefined : index.nodeBySpanId.get(parentSpanId);
    if (parent === undefined || parent.depth !== cursor.depth - 1) {
      return undefined;
    }
    cursor = parent;
  }

  if (top === undefined) {
    return undefined;
  }
  for (const visited of path) {
    tops.set(visited, top);
  }
  return top;
}

/** What {@link resolveNewDepths} reads; bundled so each link is one call. */
interface DepthContext {
  readonly index: TraceExtensionIndex;
  readonly batch: AdmittedBatch;
  readonly placements: ReadonlyMap<SpanId, NewPlacement>;
  readonly moved: ReadonlyMap<SpanId, MovedOrphan>;
  readonly tops: Map<SpanId, TraceNode>;
}

/**
 * One link of a new ancestor chain (section notes, cycles and depths).
 *
 * A moved orphan hangs one level below its late parent. A new root or repair
 * has its depth outright. A new real child hangs one level below its parent:
 * a batch event, followed further; or a node of the tree, whose new depth is
 * its old one unless its placement top is a moved orphan, in which case the
 * chain continues through that orphan at the node's distance below it.
 *
 * @param context The extension's inputs.
 * @param spanId A new event or a moved orphan.
 * @returns The link, or `inconsistent-index`.
 */
function depthLinkOf(context: DepthContext, spanId: SpanId): DepthLink | ExtensionRefusal {
  const orphan = context.moved.get(spanId);
  if (orphan !== undefined) {
    return { kind: 'link', next: orphan.parentSpanId, offset: 1 };
  }

  const placement = context.placements.get(spanId);
  if (placement === undefined) {
    return refuse('inconsistent-index');
  }
  if (placement.kind === 'root') {
    return { kind: 'anchor', depth: ROOT_DEPTH };
  }
  if (placement.kind === 'repair') {
    return { kind: 'anchor', depth: ORPHAN_DEPTH };
  }

  const parentSpanId = placement.parentSpanId;
  if (context.batch.bySpanId.has(parentSpanId)) {
    return { kind: 'link', next: parentSpanId, offset: 1 };
  }

  const parent = context.index.nodeBySpanId.get(parentSpanId);
  const top = placementTopOf(context.index, parentSpanId, context.tops);
  if (parent === undefined || top === undefined) {
    return refuse('inconsistent-index');
  }
  if (context.moved.has(top.event.spanId)) {
    return { kind: 'link', next: top.event.spanId, offset: parent.depth - top.depth + 1 };
  }
  return { kind: 'anchor', depth: parent.depth + 1 };
}

/**
 * The new depth of every new event and every moved orphan, found by walking
 * each one's new ancestor chain to a node whose depth is known — and, on the
 * way, the cycle check over the new parent relation (section notes).
 *
 * Every chain stops at the first node already resolved, so each new event and
 * moved orphan is resolved once; a node met twice on one chain is a loop.
 *
 * @param context The extension's inputs.
 * @returns The depths by span id, or `cycle`, or `inconsistent-index`.
 */
function resolveNewDepths(context: DepthContext): Map<SpanId, number> | ExtensionRefusal {
  const depthOf = new Map<SpanId, number>();
  const starts: SpanId[] = [...context.batch.bySpanId.keys(), ...context.moved.keys()];

  for (const start of starts) {
    if (depthOf.has(start)) {
      continue;
    }

    // Child-to-ancestor; each entry's depth is the next one's plus `offset`,
    // and the last one's is `base` plus its `offset`.
    const chain: { readonly spanId: SpanId; readonly offset: number }[] = [];
    const onChain = new Set<SpanId>();
    let cursor: SpanId | undefined = start;
    let base = 0;

    while (cursor !== undefined) {
      if (onChain.has(cursor)) {
        return refuse('cycle');
      }
      onChain.add(cursor);

      const link = depthLinkOf(context, cursor);
      if (isRefusal(link)) {
        return link;
      }
      if (link.kind === 'anchor') {
        chain.push({ spanId: cursor, offset: link.depth });
        cursor = undefined;
        continue;
      }

      chain.push({ spanId: cursor, offset: link.offset });
      const known = depthOf.get(link.next);
      if (known !== undefined) {
        base = known;
        cursor = undefined;
        continue;
      }
      cursor = link.next;
    }

    let depth = base;
    for (let position = chain.length - 1; position >= 0; position -= 1) {
      const entry = chain[position];
      if (entry === undefined) {
        continue;
      }
      depth += entry.offset;
      depthOf.set(entry.spanId, depth);
    }
  }

  return depthOf;
}

/**
 * Whether the batch leaves the anchor where it is (section notes, A–C).
 *
 * Checked after the cycle check, so that an anchor whose missing parent
 * arrives is known to be placed under it — and therefore no longer a root.
 *
 * @param batch The admitted batch.
 * @param placements Each new event's placement.
 * @param moved The moved orphans.
 * @param primary The anchor's current node.
 * @returns `undefined` when the anchor stays, `primary-change` when it moves,
 * or `ambiguous-order` when a new parentless event ties it on every key.
 */
function checkAnchor(
  batch: AdmittedBatch,
  placements: ReadonlyMap<SpanId, NewPlacement>,
  moved: ReadonlyMap<SpanId, MovedOrphan>,
  primary: TraceNode,
): ExtensionRefusal | undefined {
  if (moved.has(primary.event.spanId)) {
    return refuse('primary-change');
  }

  // A flagged anchor is a fallback: the trace has no genuine root at all.
  const anchoredOnRepair = primary.orphaned;
  const anchorAffinity = rootAffinityOfEvent(primary.event);

  for (const event of batch.fresh) {
    const placement = placements.get(event.spanId);
    if (placement === undefined || placement.kind === 'child') {
      continue;
    }
    if (placement.kind === 'root' && anchoredOnRepair) {
      return refuse('primary-change');
    }
    if (placement.kind === 'repair' && !anchoredOnRepair) {
      continue;
    }

    // A genuine root against a genuine anchor, or a repair against a repaired
    // anchor: the anchor stays only if the newcomer ranks below it.
    if (placement.kind === 'root') {
      const affinity = rootAffinityOfEvent(event);
      if (affinity > anchorAffinity) {
        return refuse('primary-change');
      }
      if (affinity < anchorAffinity) {
        continue;
      }
    }
    const order = compareEventsCanonical(event, primary.event);
    if (order === 0) {
      return refuse('ambiguous-order');
    }
    if (order < 0) {
      return refuse('primary-change');
    }
  }

  return undefined;
}

/**
 * Sorts events canonically, in place, and reports whether two of them tie on
 * every key (section notes, `ambiguous-order`).
 *
 * @param events A fresh array this module owns.
 * @returns `true` when the order is strict.
 */
function sortStrictly(events: TelemetryEvent[]): boolean {
  events.sort(compareEventsCanonical);
  for (let position = 1; position < events.length; position += 1) {
    const previous = events[position - 1];
    const current = events[position];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareEventsCanonical(previous, current) === 0
    ) {
      return false;
    }
  }
  return true;
}

/** The new events and moved orphans, grouped by where they attach. */
interface BatchLayout {
  /** New real children of nodes of the indexed tree, by parent span, canonical. */
  readonly underTree: ReadonlyMap<SpanId, readonly TelemetryEvent[]>;
  /** New real children of new events, by parent span, canonical. */
  readonly underBatch: ReadonlyMap<SpanId, readonly TelemetryEvent[]>;
  /** Moved orphans by the late parent that adopts them, canonical. */
  readonly adopted: ReadonlyMap<SpanId, readonly MovedOrphan[]>;
  /** New genuine roots, canonical. */
  readonly roots: readonly TelemetryEvent[];
  /** New repairs of the anchor, canonical. */
  readonly repairs: readonly TelemetryEvent[];
}

/**
 * Groups the batch by attachment point, each group in canonical order.
 *
 * @param index The index; read only.
 * @param batch The admitted batch.
 * @param placements Each new event's placement.
 * @param moved The moved orphans, in canonical order.
 * @returns The layout, or `ambiguous-order` for two new siblings, roots or
 * repairs that tie on every key.
 */
function layOutBatch(
  index: TraceExtensionIndex,
  batch: AdmittedBatch,
  placements: ReadonlyMap<SpanId, NewPlacement>,
  moved: ReadonlyMap<SpanId, MovedOrphan>,
): BatchLayout | ExtensionRefusal {
  const underTree = new Map<SpanId, TelemetryEvent[]>();
  const underBatch = new Map<SpanId, TelemetryEvent[]>();
  const roots: TelemetryEvent[] = [];
  const repairs: TelemetryEvent[] = [];

  const append = (groups: Map<SpanId, TelemetryEvent[]>, key: SpanId, event: TelemetryEvent) => {
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [event]);
      return;
    }
    group.push(event);
  };

  for (const event of batch.fresh) {
    const placement = placements.get(event.spanId);
    if (placement === undefined) {
      return refuse('inconsistent-index');
    }
    if (placement.kind === 'root') {
      roots.push(event);
    } else if (placement.kind === 'repair') {
      repairs.push(event);
    } else if (batch.bySpanId.has(placement.parentSpanId)) {
      append(underBatch, placement.parentSpanId, event);
    } else if (index.nodeBySpanId.has(placement.parentSpanId)) {
      append(underTree, placement.parentSpanId, event);
    } else {
      return refuse('inconsistent-index');
    }
  }

  for (const group of [...underTree.values(), ...underBatch.values(), roots, repairs]) {
    if (!sortStrictly(group)) {
      return refuse('ambiguous-order');
    }
  }

  // The suffix held the orphans in canonical order, and a `Map` keeps it.
  const adopted = new Map<SpanId, MovedOrphan[]>();
  for (const orphan of moved.values()) {
    const group = adopted.get(orphan.parentSpanId);
    if (group === undefined) {
      adopted.set(orphan.parentSpanId, [orphan]);
      continue;
    }
    group.push(orphan);
  }

  return { underTree, underBatch, adopted, roots, repairs };
}

/**
 * The node of the indexed tree that has to be rebuilt, with its new depth:
 * every node of a moved subtree whose depth shifts, every moved orphan (its
 * flags clear), every node that gains or loses a child, and every ancestor of
 * one of those, each once (section notes, nodes).
 *
 * Also the depth guard for moved subtrees: a moved orphan is a real child now,
 * so its own depth is checked as well as every shifted descendant's.
 *
 * @param index The index; read only.
 * @param layout The batch's layout.
 * @param moved The moved orphans.
 * @param depthOf The new depth of every new event and moved orphan.
 * @returns New depth by span id, or `max-depth`, or `inconsistent-index`.
 */
function collectRebuilt(
  index: TraceExtensionIndex,
  layout: BatchLayout,
  moved: ReadonlyMap<SpanId, MovedOrphan>,
  depthOf: ReadonlyMap<SpanId, number>,
): Map<SpanId, number> | ExtensionRefusal {
  const rebuilt = new Map<SpanId, number>();

  for (const [spanId, orphan] of moved) {
    const depth = depthOf.get(spanId);
    if (depth === undefined) {
      return refuse('inconsistent-index');
    }
    const shift = depth - orphan.node.depth;
    // Never shallower: verified rather than assumed, because the running
    // `maxDepth` is a maximum that cannot be lowered without a walk.
    if (shift < 0) {
      return refuse('inconsistent-index');
    }
    if (depth > index.depthLimit) {
      return refuse('max-depth');
    }
    rebuilt.set(spanId, depth);
    if (shift === 0) {
      continue;
    }

    const stack: TraceNode[] = [...orphan.node.children];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) {
        break;
      }
      const shifted = node.depth + shift;
      if (shifted > index.depthLimit) {
        return refuse('max-depth');
      }
      rebuilt.set(node.event.spanId, shifted);
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }

  // Every node that gains or loses a child, and its ancestors up to the first
  // one already collected. Above a moved subtree the old chain reaches the
  // anchor, which loses the orphan and is collected anyway; a moved orphan's
  // new ancestors are its late parent's, which the batch builds.
  const seeds: SpanId[] = [...layout.underTree.keys()];
  if (layout.repairs.length > 0 || moved.size > 0) {
    seeds.push(index.primaryRootSpanId);
  }

  for (const seed of seeds) {
    let spanId: SpanId | undefined = seed;
    let expectedDepth: number | undefined;

    while (spanId !== undefined && !rebuilt.has(spanId)) {
      const node = index.nodeBySpanId.get(spanId);
      if (node === undefined || (expectedDepth !== undefined && node.depth !== expectedDepth)) {
        return refuse('inconsistent-index');
      }
      rebuilt.set(spanId, node.depth);
      expectedDepth = node.depth - 1;
      spanId = parentSpanOf(index.primaryRootSpanId, node);
    }
  }

  return rebuilt;
}

/**
 * Merges two child lists already in canonical order.
 *
 * @param existing The current nodes.
 * @param added The new nodes.
 * @returns The merged list, or `undefined` when two nodes tie on every
 * canonical key (section notes, `ambiguous-order`).
 */
function mergeCanonical(
  existing: readonly TraceNode[],
  added: readonly TraceNode[],
): readonly TraceNode[] | undefined {
  if (added.length === 0) {
    return existing;
  }

  const merged: TraceNode[] = [];
  let left = 0;
  let right = 0;

  while (left < existing.length && right < added.length) {
    const current = existing[left];
    const incoming = added[right];
    if (current === undefined || incoming === undefined) {
      // Unreachable for dense arrays within the bounds just checked.
      break;
    }

    const order = compareEventsCanonical(current.event, incoming.event);
    if (order === 0) {
      return undefined;
    }
    if (order < 0) {
      merged.push(current);
      left += 1;
    } else {
      merged.push(incoming);
      right += 1;
    }
  }

  for (; left < existing.length; left += 1) {
    const current = existing[left];
    if (current !== undefined) {
      merged.push(current);
    }
  }
  for (; right < added.length; right += 1) {
    const incoming = added[right];
    if (incoming !== undefined) {
      merged.push(incoming);
    }
  }

  return merged;
}

/** The shared empty node list: what a node other than the anchor gains as repairs. */
const EMPTY_NODE_LIST: readonly TraceNode[] = Object.freeze([]);

/** The nodes of the batch, and the roots they are assembled from. */
interface BuiltExtension {
  /** Every node built — new and rebuilt — by span id. */
  readonly nodes: ReadonlyMap<SpanId, TraceNode>;
  /** The tree's roots, in canonical order. */
  readonly roots: readonly TraceNode[];
}

/** Everything {@link buildExtension} assembles from. */
interface ExtensionPlan {
  readonly batch: AdmittedBatch;
  readonly placements: ReadonlyMap<SpanId, NewPlacement>;
  readonly moved: ReadonlyMap<SpanId, MovedOrphan>;
  readonly depthOf: ReadonlyMap<SpanId, number>;
  readonly layout: BatchLayout;
  readonly rebuilt: ReadonlyMap<SpanId, number>;
}

/**
 * Builds every new and rebuilt node exactly once, deepest first, so each one's
 * children already exist, and then the roots.
 *
 * - A new event gets its batch children merged with the orphans it adopts.
 * - A rebuilt node of the tree keeps its children — each replaced by its
 *   rebuilt copy, less any orphan that moved away — with its new real
 *   children merged into the real prefix and, on the anchor, its new repairs
 *   merged into the repaired suffix. A moved orphan's flags clear; every other
 *   node keeps its own.
 *
 * @param index The index; read only.
 * @param plan The validated plan.
 * @returns The nodes and roots, or `ambiguous-order` for a merge that ties.
 */
function buildExtension(
  index: TraceExtensionIndex,
  plan: ExtensionPlan,
): BuiltExtension | ExtensionRefusal {
  const { batch, placements, moved, depthOf, layout, rebuilt } = plan;
  const order: { readonly spanId: SpanId; readonly depth: number }[] = [];
  for (const [spanId, depth] of depthOf) {
    if (!moved.has(spanId)) {
      order.push({ spanId, depth });
    }
  }
  for (const [spanId, depth] of rebuilt) {
    order.push({ spanId, depth });
  }
  order.sort((left, right) => right.depth - left.depth);

  const nodes = new Map<SpanId, TraceNode>();
  const builtNodesOf = (events: readonly TelemetryEvent[] | undefined): TraceNode[] | undefined => {
    const found: TraceNode[] = [];
    for (const event of events ?? []) {
      const node = nodes.get(event.spanId);
      if (node === undefined) {
        return undefined;
      }
      found.push(node);
    }
    return found;
  };

  for (const { spanId, depth } of order) {
    const event = batch.bySpanId.get(spanId);

    if (event !== undefined) {
      const batchChildren = builtNodesOf(layout.underBatch.get(spanId));
      const adoptedChildren: TraceNode[] = [];
      for (const orphan of layout.adopted.get(spanId) ?? []) {
        const node = nodes.get(orphan.node.event.spanId);
        if (node === undefined) {
          return refuse('inconsistent-index');
        }
        adoptedChildren.push(node);
      }
      if (batchChildren === undefined) {
        return refuse('inconsistent-index');
      }
      const children = mergeCanonical(batchChildren, adoptedChildren);
      if (children === undefined) {
        return refuse('ambiguous-order');
      }
      const placement = placements.get(spanId);
      const flags = placement?.kind === 'repair' ? placement.flags : {};
      nodes.set(spanId, createTraceNode(event, children, depth, flags));
      continue;
    }

    const original = index.nodeBySpanId.get(spanId);
    if (original === undefined) {
      return refuse('inconsistent-index');
    }

    const real: TraceNode[] = [];
    const repaired: TraceNode[] = [];
    for (const child of original.children) {
      if (moved.has(child.event.spanId)) {
        continue;
      }
      const current = nodes.get(child.event.spanId) ?? child;
      if (child.orphaned) {
        repaired.push(current);
      } else {
        real.push(current);
      }
    }

    const addedReal = builtNodesOf(layout.underTree.get(spanId));
    const addedRepairs =
      spanId === index.primaryRootSpanId ? builtNodesOf(layout.repairs) : EMPTY_NODE_LIST;
    if (addedReal === undefined || addedRepairs === undefined) {
      return refuse('inconsistent-index');
    }
    const prefix = mergeCanonical(real, addedReal);
    const suffix = mergeCanonical(repaired, addedRepairs);
    if (prefix === undefined || suffix === undefined) {
      return refuse('ambiguous-order');
    }

    const flags: TraceNodeOrphanFlags = moved.has(spanId)
      ? {}
      : { orphanReason: original.orphanReason, missingParentSpanId: original.missingParentSpanId };
    nodes.set(spanId, createTraceNode(original.event, [...prefix, ...suffix], depth, flags));
  }

  const kept = index.tree.roots.map((root) => nodes.get(root.event.spanId) ?? root);
  const newRoots = builtNodesOf(layout.roots);
  if (newRoots === undefined) {
    return refuse('inconsistent-index');
  }
  const roots = mergeCanonical(kept, newRoots);
  if (roots === undefined) {
    return refuse('ambiguous-order');
  }

  return { nodes, roots };
}

/**
 * Validates a batch against the index and plans its application, without
 * writing anything: every refusal is decided here or in
 * {@link buildExtension}, in the order admission, cycles, the anchor, the
 * depth guard, sibling order.
 *
 * @param index The index; read only.
 * @param batch The admitted, non-empty batch.
 * @returns The plan, or the refusal.
 */
function planExtension(
  index: TraceExtensionIndex,
  batch: AdmittedBatch,
): ExtensionPlan | ExtensionRefusal {
  const primary = index.nodeBySpanId.get(index.primaryRootSpanId);
  if (primary === undefined || primary.depth !== ROOT_DEPTH) {
    return refuse('inconsistent-index');
  }

  const placements = new Map<SpanId, NewPlacement>();
  for (const event of batch.fresh) {
    placements.set(event.spanId, placeNewEvent(index, batch, event));
  }

  const moved = collectMovedOrphans(index, batch, primary);
  if (isRefusal(moved)) {
    return moved;
  }

  const depthOf = resolveNewDepths({
    index,
    batch,
    placements,
    moved,
    tops: new Map<SpanId, TraceNode>(),
  });
  if (isRefusal(depthOf)) {
    return depthOf;
  }

  const anchor = checkAnchor(batch, placements, moved, primary);
  if (anchor !== undefined) {
    return anchor;
  }

  // The guard applies to real children; a root sits at depth 0 and a repair
  // is placed at `ORPHAN_DEPTH` unchecked, exactly as `correlateGroup` does.
  for (const event of batch.fresh) {
    const depth = depthOf.get(event.spanId);
    if (depth === undefined) {
      return refuse('inconsistent-index');
    }
    if (placements.get(event.spanId)?.kind === 'child' && depth > index.depthLimit) {
      return refuse('max-depth');
    }
  }

  const layout = layOutBatch(index, batch, placements, moved);
  if (isRefusal(layout)) {
    return layout;
  }

  const rebuilt = collectRebuilt(index, layout, moved, depthOf);
  if (isRefusal(rebuilt)) {
    return rebuilt;
  }

  return { batch, placements, moved, depthOf, layout, rebuilt };
}

/**
 * Grows an indexed, correlated tree by a batch of persisted events —
 * **exactly**, or not at all.
 *
 * ## The contract
 *
 * On `extended`, the returned tree is identical — `toStrictEqual`, and equal
 * under `JSON.stringify` including key order — to
 * `correlateTrace(rows ∪ batch, index.traceId, options)`, where `rows` are
 * the events the indexed tree was correlated from and a batch event already
 * among them (same span, id and arrival number) counts once. On `refused`,
 * nothing changed: the index, its tree, the batch and every node are exactly
 * as they were, and the caller rebuilds from the complete rows with
 * {@link correlateTrace}. What is applied, why it is exact and why each
 * refusal is needed are stated on this section's notes.
 *
 * Every check runs before anything is written: the batch is admitted and
 * placed, the late parents' orphans found, the new ancestor chains walked,
 * the anchor, the depth guard and every merge checked and every node built as
 * a new object, and only then are the index's maps, aggregates and tree
 * updated.
 *
 * ## Cost
 *
 * `O(b log b)` for a batch of `b` new events, plus the nodes of every moved
 * subtree whose depth shifts, plus, per rebuilt node, the length of its child
 * list and of the path above it — independent of the size of the tree.
 * `nodesBuilt` reports the node objects created: `b`, the moved nodes, and the
 * ancestors copied.
 *
 * ## Purity
 *
 * Pure except for the index it owns: no event, array or node it is handed is
 * mutated, and nothing throws for schema-valid input.
 *
 * @param index The index {@link indexTraceForExtension} built, current with
 * every earlier extension; written only on success.
 * @param events The persisted batch, in any order. Replays of indexed rows are
 * skipped; events of another trace are ignored.
 * @param options The depth bound the index was built with; a different one is
 * refused with `options-mismatch`.
 * @returns The extended tree with its counts, or the refusal.
 */
export function extendCorrelatedTrace(
  index: TraceExtensionIndex,
  events: readonly TelemetryEvent[],
  options?: CorrelateOptions,
): TraceExtensionResult {
  if (resolveMaxDepth(options?.maxDepth) !== index.depthLimit) {
    return refuse('options-mismatch');
  }

  const batch = admitBatch(index, events);
  if (isRefusal(batch)) {
    return batch;
  }
  if (batch.fresh.length === 0) {
    // Nothing new: the stored rows are the indexed rows, so the tree stands.
    return { kind: 'extended', tree: index.tree, added: 0, nodesBuilt: 0 };
  }

  const plan = planExtension(index, batch);
  if (isRefusal(plan)) {
    return plan;
  }

  const built = buildExtension(index, plan);
  if (isRefusal(built)) {
    return built;
  }

  // Every check has passed; from here on the index is written.
  const aggregates = index.aggregates;
  for (const event of batch.fresh) {
    const node = built.nodes.get(event.spanId);
    if (node !== undefined) {
      accumulateNode(aggregates, node);
    }
  }
  for (const depth of plan.rebuilt.values()) {
    if (depth > aggregates.maxDepth) {
      aggregates.maxDepth = depth;
    }
  }
  aggregates.orphanCount -= plan.moved.size;

  for (const event of batch.fresh) {
    index.missingParents.delete(event.spanId);
  }
  for (const repair of plan.layout.repairs) {
    const named = plan.placements.get(repair.spanId);
    const missing = named?.kind === 'repair' ? named.flags.missingParentSpanId : undefined;
    if (missing !== undefined) {
      index.missingParents.set(missing, (index.missingParents.get(missing) ?? 0) + 1);
    }
  }
  for (const [spanId, node] of built.nodes) {
    index.nodeBySpanId.set(spanId, node);
  }

  const previous = index.tree;
  const tree = assembleTraceTree(index.traceId, built.roots, aggregates, {
    primaryRootSpanId: index.primaryRootSpanId,
    duplicateSpanIds: previous.duplicateSpanIds,
    truncated: previous.truncated,
  });
  index.tree = tree;

  return {
    kind: 'extended',
    tree,
    added: batch.fresh.length,
    nodesBuilt: built.nodes.size,
  };
}
