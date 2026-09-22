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
 *    set produces a deeply equal result. The service re-correlates a capture
 *    incrementally as batches land from two independent producers, so arrival
 *    order must not be observable anywhere in the output. Every decision below
 *    — which occurrence of a repeated span id wins, which parentless event
 *    becomes the primary root, which member of a cycle is cut, the order of
 *    siblings and of the repaired orphans — is taken in canonical order.
 * 4. **Purity.** No input event or array is mutated, no clock or random source
 *    is read, no module-level state is kept and nothing is logged. The same
 *    input yields the same output in the service, in a test and in a browser.
 *
 * ## Who calls it
 *
 * - `apps/local-service/src/telemetry/correlate.ts` — incrementally at ingest,
 *   as each batch of events is persisted.
 * - `apps/local-service/src/panels/data.ts` — through
 *   {@link correlateTrace}, to answer the `trace` data source.
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
import type { SpanId, TraceId } from '@debuggen/shared';

import type { TelemetryEvent } from '../schema/event.js';
import { TELEMETRY_KINDS, isTelemetryKind } from '../schema/kinds.js';
import type { TelemetryKind } from '../schema/kinds.js';

import { DEFAULT_MAX_DEPTH, buildTraceTree, createTraceNode } from './tree.js';
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
 * filters once and delegates, so the incremental re-correlation the service
 * performs as a capture streams in stays as cheap as one pass plus one sort
 * over the events of a single trace.
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
