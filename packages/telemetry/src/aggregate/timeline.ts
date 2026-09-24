/**
 * `timeline`, `stateTransitions` and `graph` — the three remaining data sources
 * a capture is answered with, plus the interval arithmetic the tier metrics are
 * built on.
 *
 * Three rows of the panel-data table (AAP 0.4.2) are computed here.
 * `POST /sessions/:id/panel-data` answers `source: "trace"` and
 * `source: "spans"` layout work from {@link TimelineView} (the `timeline`,
 * `waterfall` and `flame` nodes all position their bars from the `offsetMs`,
 * `durationMs` and `depth` a row carries), `source: "stateTransitions"` with
 * {@link StateTransition}`[]`, and `source: "graph"` with
 * {@link DependencyGraphData}. The field names below are therefore a
 * cross-process contract: the panel-node catalog declares which of them each
 * node `reads`, the semantic validator checks a generated panel against them,
 * and `@debuggen/panel-renderer` keys its components to them.
 *
 * ## Why the three live in one module
 *
 * The aggregate folder has five modules, one per group of related data sources,
 * and these three share one substrate: a flat event list ordered canonically,
 * a span index, and the interval union that keeps overlapping work from being
 * counted twice. Splitting them would mean three copies of that substrate — the
 * kind of copy that drifts — so they share it here, and nothing else in the
 * package re-implements it.
 *
 * ## Lanes are keyed by tier, and colour is not computed here
 *
 * A {@link TimelineView} groups its rows into one lane per {@link TelemetryTier}
 * present, in the tier vocabulary's declaration order, so two captures of the
 * same interaction produce lanes in the same order and a reader is not asked to
 * relearn the layout. A row carries its `kind`; it carries no colour, no class
 * name and no pixel. Colour is a design-token decision that belongs to the
 * renderer (AAP 0.6.3), and geometry belongs to the renderer's scale utilities —
 * this module supplies the numbers they scale.
 *
 * A row also carries no per-kind attributes. It points at its event by
 * `eventId`, and a consumer that wants the interaction's `event.type` or the
 * document's navigation milestones reads them from that event through the key
 * groups declared in `../schema/attributes.ts`, so the lane view stays one
 * shape regardless of which kinds a capture contains.
 *
 * ## Interval unions, and why no tier metric is a sum
 *
 * {@link mergeIntervals}, {@link unionDurationMs} and
 * {@link subtractIntervalsDurationMs} are exported from here and consumed by
 * `./summary.ts` for `frontend_duration`, `backend_duration` and
 * `database_duration`. They exist because **a sum of durations is not a
 * duration**: one interaction routinely issues several requests in parallel
 * (AAP 0.4.2), and two 400 ms requests that ran side by side account for 400 ms
 * of wall-clock time, not 800 ms. A metric built by summing would report more
 * browser time than the capture lasted, and `frontend_duration` would include
 * the time the page spent waiting on the server. So every tier metric is the
 * length of a merged interval set, and the browser's share is the part of its
 * union that the server's union does not cover. `selfTimeOf` in
 * `../correlation/tree.ts` already applies the same technique one level down,
 * to a node against its children; these helpers are the folder-local, exported
 * form of that idea.
 *
 * ## Graph edges come from correlated telemetry only
 *
 * AAP 0.6.2 describes the dependency graph's edges as coming from "correlated
 * trace + code graph". Only the first half happens here: this package sits below
 * `@debuggen/code-analysis` in the acyclic package graph (AAP 0.2.2) and must
 * not import it, so {@link buildDependencyGraph} derives participants and edges
 * from span parentage and nothing else.
 *
 * Two facts of that parentage travel with the graph, so that no consumer has to
 * re-derive them from raw events or guess at them:
 *
 * - **The event a participant stands for.** A participant that collapsed
 *   exactly one record carries that record's `eventId` and `traceId` — the
 *   coordinate a host selects an event by. A collapse of several records stands
 *   for no single event, so it carries neither, and no consumer is handed a
 *   span id to pass off as one.
 * - **How an edge was known.** `inferredCount` says how many of an edge's
 *   callee spans joined their caller through a lineage attribution — AAP
 *   0.4.2's asynchronous continuation — rather than by being nested inside it,
 *   and `ambiguousCount` how many of those attributions had more than one
 *   candidate. Both are read through `lineageOf`, the package's only reader of
 *   the lineage keys, and both are omitted when zero, so a measured edge is
 *   byte-for-byte the shape it always was.
 *
 * The shapes are deliberately **additive** for the other half:
 * `apps/local-service`, which owns the code graph, attaches a `source` to a node
 * it can resolve without this module needing to know that the code graph
 * exists. Every added field is optional and JSON-safe, because the graph is
 * embedded opaquely in the protocol's `graph` data result.
 *
 * ## Purity and environment
 *
 * Pure, environment-neutral and non-mutating: no platform builtin, no DOM
 * global, no clock — every timestamp comes from the events — and no I/O. The
 * input array and the events in it are never modified, and every exported
 * function is deterministic: the same events in the same order produce the same
 * object graph, down to array order. Nothing throws. A malformed event costs
 * the field it would have filled and never the call, because the service's
 * panel-data route must answer a degraded capture rather than fail on it
 * (AAP 0.5.5).
 *
 * ## Privacy (AAP 0.5.2)
 *
 * The only application values that appear are the already-scrubbed, bounded
 * previews a producer put on a `state` event, carried through as the strings
 * they arrived as. This module never re-expands, re-parses or reconstructs a
 * value, never compares two previews to decide anything, and declares no field
 * in which a raw value could travel — every member of every exported shape is a
 * number, an identifier, a producer-assigned name, a redacted preview or a
 * source location.
 *
 * @packageDocumentation
 */

import { clampNonNegative, roundMs } from '@debuggen/shared';
import type { EventId, SourceLocation, SpanId, TraceId } from '@debuggen/shared';

import { sortEventsCanonical } from '../correlation/correlator.js';
import {
  lineageOf,
  nodeEndTime,
  orphanFlagsOf,
  selfTimeOf,
  walkTrace,
} from '../correlation/tree.js';
import type { TraceNode, TraceNodeLineage, TraceTree } from '../correlation/tree.js';
import {
  ATTRIBUTE_VALUE_TYPES,
  MAX_PREVIEW_LENGTH,
  TRANSITION_SOURCES,
} from '../schema/attributes.js';
// Type-only: these key tuples are consulted by the *compiler*, which checks the
// key literals bound below against the sets the catalog declares. There is
// nothing to consult at runtime, and a value import would pull the whole
// catalog into this neutral library entry's bundle to no purpose.
import type {
  FUNCTION_ATTRIBUTE_KEYS,
  HTTP_SERVER_ATTRIBUTE_KEYS,
  INTERACTION_ATTRIBUTE_KEYS,
  ROUTE_HANDLER_ATTRIBUTE_KEYS,
  STATE_ATTRIBUTE_KEYS,
} from '../schema/attributes.js';
import type {
  AttributeValueSummary,
  AttributeValueType,
  TransitionSource,
} from '../schema/attributes.js';
import type { TelemetryEvent } from '../schema/event.js';
import { STATE_KINDS, TELEMETRY_KINDS, TELEMETRY_TIERS } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryTier } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Vocabulary bindings
 *
 * Every kind string and attribute key this module works with is bound from the
 * schema modules, never spelled as a bare literal. `../schema/kinds.ts` is
 * explicit that no other module may hard-code a kind list, and
 * `../schema/attributes.ts` owns the key names.
 *
 * Two mechanisms, each chosen over the obvious alternative:
 *
 * - **Annotation instead of positional indexing** for a single key. A key
 *   annotated with its kind's member type (`const K: StateAttributeKey =
 *   'component'`) fails to compile when the catalog renames or drops the key,
 *   whereas `STATE_ATTRIBUTE_KEYS[0]` still compiles after a reordering and
 *   would silently start reading a different attribute. This is the pattern
 *   `./queries.ts` established.
 * - **A total `Record` keyed by the kind union** for anything that must decide
 *   something per kind. Adding a member to `TELEMETRY_KINDS` then fails to
 *   compile here until the new kind is classified, which is what makes
 *   "classify through one table rather than scattered conditionals" hold.
 *
 * The lineage and correlation attribute groups are deliberately **not** bound
 * here: `../correlation/tree.ts` states that its `lineageOf` and
 * `orphanFlagsOf` are the package's only readers of those keys, because a
 * second reader would be a second interpretation of them. This module calls
 * those two functions instead of re-reading the keys, which is also why the
 * lineage values on a row and the lineage on a `TraceNode` can never disagree.
 * ---------------------------------------------------------------------------
 */

/** One member of the declared `state` attribute key set. */
type StateAttributeKey = (typeof STATE_ATTRIBUTE_KEYS)[number];

/** One member of the declared `interaction` attribute key set. */
type InteractionAttributeKey = (typeof INTERACTION_ATTRIBUTE_KEYS)[number];

/** One member of the declared `http.server` attribute key set. */
type HttpServerAttributeKey = (typeof HTTP_SERVER_ATTRIBUTE_KEYS)[number];

/** One member of the declared `route.handler` attribute key set. */
type RouteHandlerAttributeKey = (typeof ROUTE_HANDLER_ATTRIBUTE_KEYS)[number];

/** One member of the declared `function` attribute key set. */
type FunctionAttributeKey = (typeof FUNCTION_ATTRIBUTE_KEYS)[number];

/** The component whose hook changed, on a `state` event. */
const STATE_COMPONENT_KEY: StateAttributeKey = 'component';

/** The hook's position in the fiber's hook list — a hook's only stable id. */
const STATE_HOOK_INDEX_KEY: StateAttributeKey = 'hookIndex';

/** The inferred hook kind, when the producer could infer one. */
const STATE_HOOK_LABEL_KEY: StateAttributeKey = 'hookLabel';

/** Summary of the value before the transition; never the value itself. */
const STATE_PREVIOUS_VALUE_KEY: StateAttributeKey = 'previousValue';

/** Summary of the value after the transition; never the value itself. */
const STATE_NEXT_VALUE_KEY: StateAttributeKey = 'nextValue';

/** The event the producer itself blamed for the transition, when it knew. */
const STATE_TRIGGER_EVENT_ID_KEY: StateAttributeKey = 'triggerEventId';

/**
 * The span the producer itself blamed, when what it held was a span id.
 *
 * The second of the catalog's two trigger keys: `../browser/state.ts` knows the
 * interaction's — or a settled request's — span id at commit time and cannot
 * know its event id, so both keys exist and {@link resolveTrigger} reads this
 * one through the span index.
 */
const STATE_TRIGGER_SPAN_ID_KEY: StateAttributeKey = 'triggerSpanId';

/** Which dimension changed: a member of {@link TRANSITION_SOURCES}. */
const STATE_TRANSITION_SOURCE_KEY: StateAttributeKey = 'transitionSource';

/** The render span the transition was observed inside, as the producer saw it. */
const STATE_RENDER_SPAN_ID_KEY: StateAttributeKey = 'renderSpanId';

/** The fiber instance whose value changed, so two copies are two rows. */
const STATE_FIBER_ID_KEY: StateAttributeKey = 'fiberId';

/** Whether the producer's transition list was cut by one of its bounds. */
const STATE_TRUNCATED_KEY: StateAttributeKey = 'truncated';

/** How many reported transitions the producer's bounds left without an event. */
const STATE_DROPPED_TRANSITIONS_KEY: StateAttributeKey = 'droppedTransitions';

/** The DOM event type of an interaction (`click`, `keydown`, …). */
const INTERACTION_EVENT_TYPE_KEY: InteractionAttributeKey = 'event.type';

/** The selector of the element that was interacted with. */
const INTERACTION_TARGET_SELECTOR_KEY: InteractionAttributeKey = 'target.selector';

/** The matched route pattern of an incoming request, not the concrete path. */
const HTTP_SERVER_ROUTE_KEY: HttpServerAttributeKey = 'http.route';

/** The matched route pattern a route handler answered under. */
const ROUTE_HANDLER_ROUTE_KEY: RouteHandlerAttributeKey = 'http.route';

/** The patched function's name. */
const FUNCTION_SYMBOL_KEY: FunctionAttributeKey = 'symbol';

/** The patched function's project-relative module path. */
const FUNCTION_MODULE_KEY: FunctionAttributeKey = 'module';

/** Field names of {@link AttributeValueSummary}, checked against the interface. */
const VALUE_SUMMARY_TYPE_FIELD: keyof AttributeValueSummary = 'type';

/** @see VALUE_SUMMARY_TYPE_FIELD */
const VALUE_SUMMARY_PREVIEW_FIELD: keyof AttributeValueSummary = 'preview';

/**
 * The kinds the state-transition aggregate is computed from: the state kind
 * group of `../schema/kinds.ts`, whose documentation names this data source as
 * its consumer.
 *
 * A `Set` rather than the array's `includes`, because the membership test runs
 * once per event of a capture.
 */
const STATE_KIND_SET: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>(STATE_KINDS);

/**
 * The value type reported when a producer named a category this build does not
 * recognise.
 *
 * `unknown` is the vocabulary's own documented total fallback — "a value whose
 * category could not be determined is described as such rather than guessed
 * at" — so an unrecognised name is mapped onto it rather than carried through
 * as a string no consumer can interpret. Annotated with the vocabulary's member
 * type, so removing the member upstream fails here rather than shipping a value
 * type no consumer accepts.
 */
const UNKNOWN_VALUE_TYPE: AttributeValueType = 'unknown';

/*
 * ---------------------------------------------------------------------------
 * Interval arithmetic
 *
 * Written first because `./summary.ts` imports these three functions, and
 * because the timeline's own lane occupancy is one of their callers. See the
 * module documentation for why every tier metric is a union rather than a sum.
 * ---------------------------------------------------------------------------
 */

/**
 * A half-open span of the capture's time axis, in Unix epoch milliseconds.
 *
 * Half-open (`[start, end)`) is what makes two intervals that merely touch —
 * one operation ending exactly as the next begins — merge into one covered
 * stretch instead of double-counting the shared instant.
 *
 * Both members are `readonly`: an interval is a measurement, and
 * {@link mergeIntervals} returns fresh objects rather than the caller's.
 */
export interface Interval {
  /** When the covered stretch begins. */
  readonly start: number;
  /** When it ends; equal to `start` for an instant. */
  readonly end: number;
}

/**
 * Whether an interval can be positioned on the time axis at all.
 *
 * Both bounds must be finite and the end must not precede the start. A
 * zero-length interval **is** kept: it is a real instant a producer reported —
 * a span that completed within the clock's resolution — and it contributes
 * nothing to a union, so keeping it costs nothing and drops no evidence. An
 * inverted or non-finite interval is dropped, because there is no position at
 * which it could be drawn and letting `NaN` into the arithmetic would turn
 * every metric computed from it into `NaN`.
 */
function isPositionable(interval: Interval): boolean {
  return (
    Number.isFinite(interval.start) &&
    Number.isFinite(interval.end) &&
    interval.end >= interval.start
  );
}

/** Ascending by start, then by end: a total order, so merging is deterministic. */
function compareIntervals(left: Interval, right: Interval): number {
  if (left.start !== right.start) {
    return left.start < right.start ? -1 : 1;
  }
  if (left.end !== right.end) {
    return left.end < right.end ? -1 : 1;
  }
  return 0;
}

/**
 * The smallest set of non-overlapping intervals covering exactly what
 * `intervals` covers.
 *
 * Overlapping and touching intervals are merged; unpositionable ones
 * ({@link isPositionable}) are dropped. The result is ascending by `start`,
 * and no two of its members overlap or touch.
 *
 * @param intervals Any intervals, in any order. Not modified.
 * @returns A fresh array of fresh objects, so a caller may sort, extend or
 * hand it on freely.
 *
 * @example
 * ```ts
 * mergeIntervals([
 *   { start: 0, end: 10 },
 *   { start: 10, end: 20 }, // touches the first
 *   { start: 15, end: 18 }, // inside the second
 * ]); // → [{ start: 0, end: 20 }]
 * ```
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const positionable = intervals.filter(isPositionable);
  if (positionable.length === 0) {
    return [];
  }

  // A copy, because `sort` mutates and the input is the caller's.
  const sorted = [...positionable].sort(compareIntervals);

  const merged: Interval[] = [];
  let openStart: number | undefined;
  let openEnd = 0;

  for (const interval of sorted) {
    if (openStart === undefined) {
      openStart = interval.start;
      openEnd = interval.end;
      continue;
    }

    if (interval.start > openEnd) {
      merged.push({ start: openStart, end: openEnd });
      openStart = interval.start;
      openEnd = interval.end;
      continue;
    }

    if (interval.end > openEnd) {
      openEnd = interval.end;
    }
  }

  if (openStart !== undefined) {
    merged.push({ start: openStart, end: openEnd });
  }

  return merged;
}

/**
 * How many milliseconds `intervals` covers in total, counting overlapped time
 * once.
 *
 * This is the function every per-tier duration is computed with: hand it the
 * intervals of one tier's spans and it answers with the wall-clock time that
 * tier was busy, which is never more than the capture lasted however many
 * spans ran in parallel.
 *
 * @param intervals Any intervals, in any order. Not modified.
 * @returns The covered duration, clamped at zero and rounded through the
 * product's single rounding policy. `0` for an empty or wholly unpositionable
 * input.
 */
export function unionDurationMs(intervals: readonly Interval[]): number {
  let covered = 0;
  for (const interval of mergeIntervals(intervals)) {
    covered += interval.end - interval.start;
  }
  return roundMs(clampNonNegative(covered));
}

/**
 * How many milliseconds `base` covers that `subtrahend` does not: the length of
 * `union(base) \ union(subtrahend)`.
 *
 * `./summary.ts` needs exactly this for `frontend_duration`. The browser tier's
 * spans cover the whole interaction, including the stretch the page spent
 * waiting for the server, so reporting their union as frontend time would
 * charge the browser for the backend's work and make the tier metrics sum to
 * more than the interaction took. Subtracting the server tier's union answers
 * the question a developer is actually asking — how much of this interaction
 * was the front end's own.
 *
 * @param base The intervals to measure. Not modified.
 * @param subtrahend The intervals to exclude. Not modified.
 * @returns The uncovered remainder's duration, clamped at zero and rounded.
 * Equal to `unionDurationMs(base)` when the two sets do not overlap.
 *
 * @example
 * ```ts
 * // A 1000 ms interaction of which 600 ms was spent inside a server request.
 * subtractIntervalsDurationMs(
 *   [{ start: 0, end: 1000 }],
 *   [{ start: 200, end: 800 }],
 * ); // → 400
 * ```
 */
export function subtractIntervalsDurationMs(
  base: readonly Interval[],
  subtrahend: readonly Interval[],
): number {
  const holes = mergeIntervals(subtrahend);
  if (holes.length === 0) {
    return unionDurationMs(base);
  }

  let covered = 0;

  for (const interval of mergeIntervals(base)) {
    // Walks the holes in ascending order, accumulating the gaps between them.
    // A hole may span several base intervals, so the scan restarts per
    // interval rather than advancing one shared cursor; both `continue` and
    // `break` bound the work, and both arrays are already merged and sorted.
    let cursor = interval.start;

    for (const hole of holes) {
      if (hole.end <= cursor) {
        continue;
      }
      if (hole.start >= interval.end) {
        break;
      }
      if (hole.start > cursor) {
        covered += hole.start - cursor;
      }
      cursor = hole.end;
      if (cursor >= interval.end) {
        break;
      }
    }

    if (cursor < interval.end) {
      covered += interval.end - cursor;
    }
  }

  return roundMs(clampNonNegative(covered));
}

/*
 * ---------------------------------------------------------------------------
 * Defensive readers and shared helpers
 *
 * Everything below treats an event's attributes as untrusted. The events
 * reaching this module have passed the event schema, but the schema
 * deliberately leaves the attribute bag open, and a bag has crossed a page
 * boundary, a WebSocket and a store on its way here. So: no read throws, no
 * read widens a value, and a value that cannot be understood is absent rather
 * than guessed at — one malformed attribute costs its own field and nothing
 * else.
 * ---------------------------------------------------------------------------
 */

/** An event's attribute bag as this module reads it: keys of unknown values. */
type AttributeBag = Readonly<Record<string, unknown>>;

/** Stand-in bag for an event whose `attributes` is missing or not an object. */
const EMPTY_ATTRIBUTES: AttributeBag = Object.freeze({});

/**
 * The event's attribute bag, or an empty one.
 *
 * Guarded because indexing `undefined` is the one read here that would throw,
 * and one malformed event must never end the service's panel-data call.
 */
function attributeBagOf(event: TelemetryEvent): AttributeBag {
  const { attributes } = event;
  return typeof attributes === 'object' && attributes !== null ? attributes : EMPTY_ATTRIBUTES;
}

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
 * the caller to validate it. It is not a check being silenced.
 */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as AttributeBag)[key];
  } catch {
    return undefined;
  }
}

/** A non-empty string, or `undefined`. */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A non-negative integer, or `undefined` — including for `NaN` and a fraction. */
function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A member of the closed transition-source vocabulary, or `undefined`.
 *
 * Strict, for the reason the vocabulary is closed: `state` and `context` say
 * whose doing a change was — the component's own, or a provider's — and a value
 * outside the pair is a producer this build does not understand. Absent is the
 * honest answer to that, because a guess here would attribute a provider's
 * change to the component reading it.
 */
function asTransitionSource(value: unknown): TransitionSource | undefined {
  const reported = asNonEmptyString(value);
  if (reported === undefined) {
    return undefined;
  }
  return TRANSITION_SOURCES.find((source) => source === reported);
}

/**
 * A disclosure flag, which a producer only ever sets to `true`.
 *
 * Exactly `true` passes; anything else — `false`, `'true'`, `1`, absence — is
 * `undefined`, so the field is omitted rather than carrying a claim the
 * producer did not make. A truncation flag is read as "the producer said this
 * list is incomplete", and only the literal says that.
 */
function asTrueFlag(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

/**
 * A finite measurement, or zero.
 *
 * The event schema already refuses a non-finite `startTime` or `duration`, so
 * this only matters for an event that reached this function another way — a row
 * read back from a store written by an older build, say. Zero rather than
 * propagation: one `NaN` in a timestamp makes every offset in a view `NaN`, and
 * a lane of unlabelled zeroes is a visible defect where a `NaN` layout is an
 * invisible one.
 */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * A bound, or its default when the caller supplied nothing usable.
 *
 * Ignoring a nonsensical bound rather than rejecting it is deliberate: these
 * functions do not throw, and a view rendered with default bounds is a better
 * answer to a caller's mistake than no view at all. Zero is a usable bound, not
 * a mistake — a caller that wants counts without rows asks for it.
 */
function resolveBound(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Code-unit string order: locale-independent, so two machines agree. */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Indexes events by span id, so a parent lookup is a lookup rather than a scan.
 *
 * On a duplicate span id the first event wins, which keeps every result a
 * function of the input order the store already fixes. Duplicates are an
 * anomaly the correlator reports (`TraceTree.duplicateSpanIds`) rather than
 * something this module repairs.
 */
function indexSpans(events: readonly TelemetryEvent[]): ReadonlyMap<SpanId, TelemetryEvent> {
  const index = new Map<SpanId, TelemetryEvent>();

  for (const event of events) {
    if (!index.has(event.spanId)) {
      index.set(event.spanId, event);
    }
  }

  return index;
}

/**
 * When a row's operation finished, sanitised for layout.
 *
 * `../correlation/tree.ts` reports `nodeEndTime` as raw arithmetic —
 * unclamped and unrounded — because it is a *position* rather than a
 * measurement. That is right for the tree and wrong for a bar: a non-finite
 * or backwards end would place a row before its own start. An end that cannot
 * be used collapses the row to an instant at its start instead, which is
 * drawable and honest about carrying no width.
 */
function positionableEndTime(startTime: number, rawEndTime: number): number {
  return Number.isFinite(rawEndTime) && rawEndTime > startTime ? rawEndTime : startTime;
}

/*
 * ---------------------------------------------------------------------------
 * Timeline shapes
 * ---------------------------------------------------------------------------
 */

/**
 * The largest number of rows a timeline view carries: 2000.
 *
 * A bound rather than a product limit. A correlated interaction is tens of
 * spans; a capture that spanned a minute of an idle page rendering on a timer
 * can be thousands, and a view no one can read is worth less than the same view
 * marked `truncated`. The rows kept are the **earliest** in canonical order,
 * because an interaction's story starts at its root: cutting the tail keeps the
 * click, its handler and the request it made, while cutting anywhere else would
 * leave a tree with no top.
 */
export const DEFAULT_TIMELINE_MAX_ROWS = 2000;

/** Prefix of every {@link TimelineLane.id}, so a consumer can recognise one. */
export const TIMELINE_LANE_ID_PREFIX = 'lane:';

/**
 * The human label of each tier's lane, declared once.
 *
 * Total by construction: the key type is the closed tier union, so a tier added
 * to `TELEMETRY_TIERS` fails to compile here until it has a label, and nothing
 * else in the product spells a lane name. The strings are generic vocabulary —
 * the three tiers of the evidence model — and name no framework, product or
 * project.
 *
 * Frozen: a read-only lookup table.
 */
export const TIER_LANE_LABELS: Readonly<Record<TelemetryTier, string>> = Object.freeze({
  browser: 'Browser',
  server: 'Server',
  db: 'Database',
});

/**
 * One operation as a timeline, waterfall or flame view lays it out.
 *
 * ## The geometry is precomputed, the styling is not
 *
 * `offsetMs`, `durationMs` and `depth` are what the renderer's scale utilities
 * need, and computing them here keeps the same three numbers behind all three
 * visualizations instead of three implementations of the same arithmetic
 * (AAP 0.6.2). `kind` and `tier` are carried so a component can *choose* a
 * design token; no colour, class or pixel appears in this shape.
 *
 * ## No parent pointer, by the same discipline as `TraceNode`
 *
 * A row names its parent by `parentSpanId` and its event by `eventId`. Nothing
 * here holds an object reference, because a view crosses an HTTP response and a
 * WebSocket frame as JSON, and a cycle is not JSON.
 */
export interface TimelineRow {
  /**
   * Stable identity of the row, equal to `eventId`.
   *
   * Both are present on purpose: `id` is what a list keys on and what a sort
   * breaks ties with, and `eventId` is what an evidence citation or a
   * selection callback names. Keeping them as two fields means a consumer never
   * has to know that a row happens to be one event.
   */
  readonly id: EventId;
  /** The captured event this row draws. */
  readonly eventId: EventId;
  /** The event's span id. */
  readonly spanId: SpanId;
  /** The trace the event belongs to. */
  readonly traceId: TraceId;
  /** The span this one hung from, when the event named one. */
  readonly parentSpanId?: SpanId;
  /** Distance from the trace root: `0` at a root, one more per level. */
  readonly depth: number;
  /** What kind of operation this was; the renderer's colour input. */
  readonly kind: TelemetryKind;
  /** The producer's name for the operation, verbatim. */
  readonly name: string;
  /** Which tier produced it, and therefore which lane the row sits in. */
  readonly tier: TelemetryTier;
  /** How the operation ended. */
  readonly status: TelemetryEvent['status'];
  /** When it began, in Unix epoch milliseconds. */
  readonly startTime: number;
  /** When it finished; equal to `startTime` for an instant. */
  readonly endTime: number;
  /**
   * Milliseconds from the view's own start to this row's start, rounded.
   *
   * The x-position of the bar. Never negative: the view's window is the
   * earliest start among the rows it carries.
   */
  readonly offsetMs: number;
  /** The bar's width in milliseconds: the operation's own inclusive duration. */
  readonly durationMs: number;
  /**
   * Milliseconds the operation spent outside the operations it called.
   *
   * Present only when the row came from a correlated tree, where the children
   * are known; a view built from a flat slice omits it rather than reporting a
   * self time that is really a total. Computed by `selfTimeOf` in
   * `../correlation/tree.ts`, which subtracts the interval *union* of the
   * children, so parallel children never produce a negative width.
   */
  readonly selfTimeMs?: number;
  /** Where in the developer's project this operation lives, when resolved. */
  readonly source?: SourceLocation;
  /**
   * The attribution mechanism, when the row joined its trace across an
   * asynchronous boundary — the continuation lineage of AAP 0.4.2.
   */
  readonly lineage?: string;
  /**
   * Whether more than one candidate parent was open when the attribution was
   * made. `Timeline` draws such an edge dashed rather than presenting a guess
   * as a fact.
   */
  readonly lineageAmbiguous?: boolean;
  /**
   * Whether the correlator had to re-attach this operation rather than place
   * it where its event said it belonged.
   */
  readonly orphaned?: boolean;
}

/**
 * Every row of one tier, and what that tier's occupancy was.
 *
 * A lane is emitted only when it has rows: the renderer draws what it receives,
 * and an empty lane is vertical space that says nothing. Lanes appear in the
 * tier vocabulary's declaration order, so the layout of two captures of the
 * same interaction is the same layout.
 */
export interface TimelineLane {
  /** `lane:` followed by the tier — deterministic, so it survives a re-render. */
  readonly id: string;
  /** The tier whose rows this lane holds. */
  readonly tier: TelemetryTier;
  /** The lane's human label, from {@link TIER_LANE_LABELS}. */
  readonly label: string;
  /** The rows, in the canonical order the view was built in. */
  readonly rows: readonly TimelineRow[];
  /** How many rows the lane holds; always `rows.length`. */
  readonly rowCount: number;
  /** The earliest row start in the lane, in Unix epoch milliseconds. */
  readonly startTime: number;
  /** The latest row end in the lane. */
  readonly endTime: number;
  /**
   * Milliseconds this tier was busy, counting overlapped work once.
   *
   * An interval union rather than a sum of the rows' durations
   * ({@link unionDurationMs}), so a tier that ran four requests in parallel is
   * not reported as busier than the capture was long, and a parent span does
   * not have its children's time counted twice on top of its own.
   */
  readonly occupancyMs: number;
}

/**
 * One interaction — or one queried slice of a capture — laid out in lanes.
 *
 * ## The empty convention
 *
 * A view with no rows reports `startTime === endTime === 0`,
 * `totalDurationMs === 0`, no lanes and `rowCount === 0`. Zeroes rather than
 * `undefined` or a sentinel: a renderer scaling a bar gets arithmetic that
 * works instead of a special case, and `rowCount === 0` is the unambiguous test
 * for emptiness. It matches the same decision in `TraceTree`.
 *
 * ## The window is the rows', not the trace's
 *
 * `startTime` and `endTime` describe the rows this view actually carries, which
 * is what keeps every `offsetMs` non-negative even when orphans were excluded
 * or the row list was truncated.
 */
export interface TimelineView {
  /**
   * The trace this view lays out, when there is exactly one.
   *
   * Always present for a view built from a correlated tree. Present for a view
   * built from a flat slice only when every event in the slice shares one trace
   * id — a slice filtered by kind rather than by trace routinely spans several,
   * and naming one of them would be a claim the data does not support.
   */
  readonly traceId?: TraceId;
  /** The earliest row start, in Unix epoch milliseconds; `0` when empty. */
  readonly startTime: number;
  /** The latest row end; `0` when empty. */
  readonly endTime: number;
  /** `endTime - startTime`, clamped at zero and rounded. */
  readonly totalDurationMs: number;
  /** One lane per tier present, in tier declaration order; never an empty lane. */
  readonly lanes: readonly TimelineLane[];
  /**
   * How many rows the view holds across every lane.
   *
   * Always the sum of the lanes' `rowCount`s: a row is never counted here and
   * then dropped from its lane.
   */
  readonly rowCount: number;
  /** Whether rows were left out because the row bound was reached. */
  readonly truncated: boolean;
}

/** How a timeline view is built. Both members are optional. */
export interface TimelineOptions {
  /**
   * The largest number of rows to carry; defaults to
   * {@link DEFAULT_TIMELINE_MAX_ROWS}.
   *
   * Declared `| undefined` so a caller may forward an optional configuration
   * value straight through under this repository's `exactOptionalPropertyTypes`
   * setting; a value that is not a non-negative integer is treated as absent.
   */
  readonly maxRows?: number | undefined;
  /**
   * Whether to include operations the correlator had to re-attach; defaults to
   * `true`.
   *
   * Orphans are **evidence, not filler** (AAP 0.4.2): a server span whose
   * browser parent never arrived is real work with real timings, and dropping
   * it would remove that time from the view entirely. Excluding them is offered
   * for the narrower question "what does the part of this trace I can trust the
   * shape of look like", never as a cleanup.
   */
  readonly includeOrphans?: boolean | undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Timeline assembly
 *
 * Both builders produce a row *seed* per included operation, then assemble the
 * view once: a row's `offsetMs` is relative to the view's window, and the
 * window is not known until every row is in hand. One assembly step also means
 * the lane grouping, the truncation rule and the empty convention exist once
 * rather than twice.
 * ---------------------------------------------------------------------------
 */

/** Everything known about one row before the view's window is known. */
interface RowSeed {
  /** The event the row draws. */
  readonly event: TelemetryEvent;
  /** Distance from the trace root. */
  readonly depth: number;
  /** The row's sanitised start, in Unix epoch milliseconds. */
  readonly startTime: number;
  /** The row's sanitised end; never before `startTime`. */
  readonly endTime: number;
  /** The bar's width, clamped and rounded. */
  readonly durationMs: number;
  /** Self time, when the children were known. */
  readonly selfTimeMs?: number | undefined;
  /** Whether the correlator re-attached this operation. */
  readonly orphaned: boolean;
  /** The lineage record, read through the correlation layer's own reader. */
  readonly lineage?: TraceNodeLineage | undefined;
}

/**
 * The assembly view of {@link RowSeed} and {@link TimelineRow}: the same
 * properties without `readonly`, so a factory can add an optional key only when
 * it has a value for it.
 *
 * This is what `exactOptionalPropertyTypes` costs and buys. A conditional
 * spread would type each optional property as `T | undefined` and so would not
 * satisfy the read-only shape, while assigning `undefined` outright would put a
 * key with an `undefined` value on the result — which JSON drops, making a
 * round-tripped view structurally different from the one the service built.
 * Assembling here keeps "absent means the key is not there" literally true. A
 * mutable object is assignable to its `readonly` counterpart, so no assertion
 * is needed.
 */
interface MutableRowSeed {
  event: TelemetryEvent;
  depth: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  selfTimeMs?: number;
  orphaned: boolean;
  lineage?: TraceNodeLineage;
}

/** @see MutableRowSeed */
interface MutableTimelineRow {
  id: EventId;
  eventId: EventId;
  spanId: SpanId;
  traceId: TraceId;
  parentSpanId?: SpanId;
  depth: number;
  kind: TelemetryKind;
  name: string;
  tier: TelemetryTier;
  status: TelemetryEvent['status'];
  startTime: number;
  endTime: number;
  offsetMs: number;
  durationMs: number;
  selfTimeMs?: number;
  source?: SourceLocation;
  lineage?: string;
  lineageAmbiguous?: boolean;
  orphaned?: boolean;
}

/** @see MutableRowSeed */
interface MutableTimelineView {
  traceId?: TraceId;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  lanes: readonly TimelineLane[];
  rowCount: number;
  truncated: boolean;
}

/** The shared empty lane list of an empty view; frozen, so no caller fills it. */
const EMPTY_LANES: readonly TimelineLane[] = Object.freeze([]);

/**
 * The seed of one node of a correlated tree.
 *
 * `depth`, `orphaned` and `lineage` come from the node, which is the
 * correlator's own conclusion about where the operation belonged — never from a
 * flag stored on the event, which records what an *earlier* correlation pass
 * concluded and may since have been superseded.
 */
function seedFromNode(node: TraceNode): RowSeed {
  const { event } = node;
  const startTime = finiteOrZero(event.startTime);

  const seed: MutableRowSeed = {
    event,
    depth: node.depth,
    startTime,
    endTime: positionableEndTime(startTime, nodeEndTime(node)),
    durationMs: roundMs(clampNonNegative(finiteOrZero(event.duration))),
    selfTimeMs: selfTimeOf(node),
    orphaned: node.orphaned,
  };

  if (node.lineage !== undefined) {
    seed.lineage = node.lineage;
  }

  return seed;
}

/**
 * The seed of one event of a flat slice.
 *
 * No `selfTimeMs`: a slice does not know which operations were this one's
 * children, and a self time that is really a total would be read as "this span
 * did the work itself" — the opposite finding from "this span waited on its
 * query" (see the timing note in `../correlation/tree.ts`). The end is the same
 * arithmetic `nodeEndTime` applies, `startTime + duration`, sanitised the same
 * way.
 */
function seedFromEvent(event: TelemetryEvent, depth: number, orphaned: boolean): RowSeed {
  const startTime = finiteOrZero(event.startTime);

  const seed: MutableRowSeed = {
    event,
    depth,
    startTime,
    endTime: positionableEndTime(startTime, event.startTime + event.duration),
    durationMs: roundMs(clampNonNegative(finiteOrZero(event.duration))),
    orphaned,
  };

  const lineage = lineageOf(event);
  if (lineage !== undefined) {
    seed.lineage = lineage;
  }

  return seed;
}

/** One finished row, positioned against the view's window. */
function toRow(seed: RowSeed, viewStartTime: number): TimelineRow {
  const { event } = seed;

  const row: MutableTimelineRow = {
    id: event.id,
    eventId: event.id,
    spanId: event.spanId,
    traceId: event.traceId,
    depth: Number.isInteger(seed.depth) && seed.depth >= 0 ? seed.depth : 0,
    kind: event.kind,
    name: event.name,
    tier: event.tier,
    status: event.status,
    startTime: seed.startTime,
    endTime: seed.endTime,
    offsetMs: roundMs(clampNonNegative(seed.startTime - viewStartTime)),
    durationMs: seed.durationMs,
  };

  if (event.parentSpanId !== undefined) {
    row.parentSpanId = event.parentSpanId;
  }
  if (seed.selfTimeMs !== undefined) {
    row.selfTimeMs = seed.selfTimeMs;
  }
  if (event.source !== undefined) {
    row.source = event.source;
  }
  if (seed.lineage !== undefined) {
    row.lineage = seed.lineage.value;
    // Only when the attribution was ambiguous: a `false` on every other row
    // would be a key the wire carries for no one.
    if (seed.lineage.ambiguous) {
      row.lineageAmbiguous = true;
    }
  }
  if (seed.orphaned) {
    row.orphaned = true;
  }

  return row;
}

/**
 * Groups finished rows into lanes.
 *
 * Lanes are emitted in `TELEMETRY_TIERS` declaration order, and then — for any
 * tier value the vocabulary does not contain, which only a row read back from a
 * store written by a newer producer can carry — in ascending tier order. That
 * tail is what keeps {@link TimelineView.rowCount} equal to the sum of the
 * lanes' counts: a row is never counted in the view and then dropped from every
 * lane, which would be an inconsistency no consumer could see but every total
 * would reflect.
 */
function toLanes(rows: readonly TimelineRow[]): readonly TimelineLane[] {
  const byTier = new Map<TelemetryTier, TimelineRow[]>();

  for (const row of rows) {
    const existing = byTier.get(row.tier);
    if (existing === undefined) {
      byTier.set(row.tier, [row]);
      continue;
    }
    existing.push(row);
  }

  const order: TelemetryTier[] = TELEMETRY_TIERS.filter((tier) => byTier.has(tier));
  const unknownTiers = [...byTier.keys()]
    .filter((tier) => !TELEMETRY_TIERS.includes(tier))
    .sort(compareStrings);
  order.push(...unknownTiers);

  const lanes: TimelineLane[] = [];

  for (const tier of order) {
    const laneRows = byTier.get(tier);
    if (laneRows === undefined || laneRows.length === 0) {
      continue;
    }

    let startTime = Number.POSITIVE_INFINITY;
    let endTime = Number.NEGATIVE_INFINITY;
    const intervals: Interval[] = [];

    for (const row of laneRows) {
      if (row.startTime < startTime) {
        startTime = row.startTime;
      }
      if (row.endTime > endTime) {
        endTime = row.endTime;
      }
      intervals.push({ start: row.startTime, end: row.endTime });
    }

    lanes.push({
      id: `${TIMELINE_LANE_ID_PREFIX}${tier}`,
      tier,
      // Falls back to the tier itself for a value the label table does not
      // cover, so an unknown lane is still identifiable rather than blank.
      label: TIER_LANE_LABELS[tier] ?? tier,
      rows: laneRows,
      rowCount: laneRows.length,
      startTime: finiteOrZero(startTime),
      endTime: finiteOrZero(endTime),
      occupancyMs: unionDurationMs(intervals),
    });
  }

  return lanes;
}

/**
 * Assembles the view: applies the row bound, computes the window, positions
 * every row against it and groups the result into lanes.
 *
 * Truncation keeps the earliest rows **in the order the caller seeded them**,
 * which is canonical order in both builders — pre-order for a tree (parent
 * before child) and the correlator's canonical comparator for a flat slice.
 */
function assembleView(
  seeds: readonly RowSeed[],
  maxRows: number,
  traceId: TraceId | undefined,
): TimelineView {
  const truncated = seeds.length > maxRows;
  const kept = truncated ? seeds.slice(0, maxRows) : seeds;

  const view: MutableTimelineView = {
    startTime: 0,
    endTime: 0,
    totalDurationMs: 0,
    lanes: EMPTY_LANES,
    rowCount: 0,
    truncated,
  };

  if (traceId !== undefined) {
    view.traceId = traceId;
  }

  if (kept.length === 0) {
    return view;
  }

  let startTime = Number.POSITIVE_INFINITY;
  let endTime = Number.NEGATIVE_INFINITY;
  for (const seed of kept) {
    if (seed.startTime < startTime) {
      startTime = seed.startTime;
    }
    if (seed.endTime > endTime) {
      endTime = seed.endTime;
    }
  }

  // Both are finite here: every seed carries sanitised numbers and `kept` is
  // non-empty. `finiteOrZero` states that rather than assuming it.
  const windowStart = finiteOrZero(startTime);
  const windowEnd = finiteOrZero(endTime);

  const rows = kept.map((seed) => toRow(seed, windowStart));

  view.startTime = windowStart;
  view.endTime = windowEnd;
  view.totalDurationMs = roundMs(clampNonNegative(windowEnd - windowStart));
  view.lanes = toLanes(rows);
  view.rowCount = rows.length;

  return view;
}

/**
 * Lays out a correlated trace: one row per node, in lanes by tier.
 *
 * This is the path behind `source: "trace"` — a `DataQuery` filtered by
 * `traceId`, whose answer is the cross-tier tree the product exists to show:
 * the interaction, the handler it ran, the state update and requests that
 * followed, the server request that answered one of them, the route handler,
 * the service functions it called, the database work underneath them, the
 * outgoing calls beside it, and the React commit that closed the loop
 * (AAP 0.4.2). Every row carries the `depth` the correlator placed it at, so
 * that nesting is the tree's and not a re-derivation of it.
 *
 * @param tree A correlated trace, as `../correlation/correlator.ts` builds it.
 * @param options Row bound and orphan handling; see {@link TimelineOptions}.
 * @returns A view whose `traceId` is the tree's. Empty (see
 * {@link TimelineView}) for a tree with no nodes.
 *
 * @example
 * ```ts
 * const view = buildTimeline(tree, { maxRows: 500 });
 * for (const lane of view.lanes) {
 *   // lane.label === 'Browser' | 'Server' | 'Database'
 * }
 * ```
 */
export function buildTimeline(tree: TraceTree, options?: TimelineOptions): TimelineView {
  const maxRows = resolveBound(options?.maxRows, DEFAULT_TIMELINE_MAX_ROWS);
  const includeOrphans = options?.includeOrphans !== false;

  const seeds: RowSeed[] = [];
  // Span ids of nodes excluded from the view. A whole subtree goes with an
  // excluded node: keeping its children would put rows at a depth whose parent
  // is not in the view, which no nesting layout can draw. Pre-order guarantees
  // a parent is visited before its children, so one set is enough.
  const excludedSpanIds = new Set<SpanId>();

  walkTrace(tree, (node, parent) => {
    if (!includeOrphans) {
      const parentExcluded = parent !== undefined && excludedSpanIds.has(parent.event.spanId);
      if (node.orphaned || parentExcluded) {
        excludedSpanIds.add(node.event.spanId);
        return;
      }
    }

    seeds.push(seedFromNode(node));
  });

  return assembleView(seeds, maxRows, tree.traceId);
}

/**
 * The deepest parent chain a flat slice is walked for: 64 hops.
 *
 * A real correlated trace is a handful of levels — interaction, commit, render,
 * fetch, server request, route handler, service function, query — and a slice
 * of one is never deeper. A chain longer than this means parentage that is not
 * a tree, so the walk stops and reports the depth it reached rather than
 * following a spurious chain (the correlator, which has the whole trace, flags
 * such a node instead; see its `max-depth` orphan reason).
 */
const MAX_PARENT_LOOKUP_HOPS = 64;

/**
 * How many of an event's ancestors are present in the slice being laid out.
 *
 * `0` for an event whose parent is outside the slice, which is the honest
 * answer: within this view that event *is* a root. Three malformations end the
 * walk instead of trapping it — a span that is its own parent, a cycle among
 * ancestors, and a parent that never arrived — and the visited set is what
 * makes the first two terminate regardless of the hop budget.
 */
function depthWithinSlice(
  event: TelemetryEvent,
  spansBySpanId: ReadonlyMap<SpanId, TelemetryEvent>,
): number {
  const visited = new Set<SpanId>([event.spanId]);
  let depth = 0;
  let parentSpanId = event.parentSpanId;

  while (parentSpanId !== undefined && depth < MAX_PARENT_LOOKUP_HOPS) {
    if (visited.has(parentSpanId)) {
      break;
    }
    visited.add(parentSpanId);

    const parent = spansBySpanId.get(parentSpanId);
    if (parent === undefined) {
      break;
    }

    depth += 1;
    parentSpanId = parent.parentSpanId;
  }

  return depth;
}

/**
 * The trace id every event shares, or `undefined` when they do not share one.
 */
function sharedTraceId(events: readonly TelemetryEvent[]): TraceId | undefined {
  let shared: TraceId | undefined;

  for (const event of events) {
    if (shared === undefined) {
      shared = event.traceId;
      continue;
    }
    if (event.traceId !== shared) {
      return undefined;
    }
  }

  return shared;
}

/**
 * Lays out a flat slice of events: one row per event, in lanes by tier.
 *
 * This is the path behind `source: "spans"` and `source: "events"` — a
 * `DataQuery` filtered by kinds, tier or duration rather than by one trace,
 * which the service answers with whatever the filter selected across the
 * capture. It differs from {@link buildTimeline} in exactly three ways, each
 * because a slice is not a tree:
 *
 * - `depth` counts the ancestors that are **in the slice**
 *   ({@link depthWithinSlice}); an event whose parent was filtered out is a root
 *   of this view.
 * - No row carries `selfTimeMs`, because the children are not known.
 * - Orphan state is read from the flag the service stored on the event
 *   (`orphanFlagsOf` in `../correlation/tree.ts`), and excluding orphans
 *   excludes only the flagged events themselves — a slice has no subtree to
 *   exclude with them.
 *
 * @param events Any already-ingested, already-redacted events. Not modified.
 * @param options Row bound and orphan handling; see {@link TimelineOptions}.
 * @returns A view whose `traceId` is present only when every event in the
 * slice shares one. Empty (see {@link TimelineView}) for no events.
 */
export function buildTimelineFromEvents(
  events: readonly TelemetryEvent[],
  options?: TimelineOptions,
): TimelineView {
  const maxRows = resolveBound(options?.maxRows, DEFAULT_TIMELINE_MAX_ROWS);
  const includeOrphans = options?.includeOrphans !== false;

  const ordered = sortEventsCanonical(events);
  const spansBySpanId = indexSpans(ordered);

  const seeds: RowSeed[] = [];

  for (const event of ordered) {
    const orphaned = orphanFlagsOf(event) !== undefined;
    if (orphaned && !includeOrphans) {
      continue;
    }

    seeds.push(seedFromEvent(event, depthWithinSlice(event, spansBySpanId), orphaned));
  }

  return assembleView(seeds, maxRows, sharedTraceId(ordered));
}

/*
 * ---------------------------------------------------------------------------
 * State transitions
 *
 * The `stateTransitions` data source: what a React hook's value was, what
 * caused it to change, and what it became — the three columns
 * `StateTransitionViewer` renders as "old → trigger → new" (AAP 0.6.2).
 * ---------------------------------------------------------------------------
 */

/**
 * The largest number of transitions one result carries: 1000.
 *
 * A provider that publishes a new value on a timer produces transitions for as
 * long as a capture runs, and a table no one can scroll is worth less than the
 * same table cut at a stated bound. The transitions kept are the **earliest**,
 * because the first few are what show the pattern; the service's panel-data
 * route pages the rest through its own `limit`/`offset`.
 */
export const DEFAULT_MAX_STATE_TRANSITIONS = 1000;

/**
 * How far up a parent chain a transition's trigger is looked for: 8 hops.
 *
 * Far enough to cross the levels that legitimately sit between a state
 * transition and the operation that caused it — a commit, a settled request,
 * the interaction itself — and short enough that a malformed chain costs a
 * bounded walk. A visited set, not this budget, is what makes a cycle
 * terminate.
 */
export const MAX_TRIGGER_LOOKUP_HOPS = 8;

/**
 * One React hook state transition, and the operation that caused it.
 *
 * ## The values are previews, and that is the whole guarantee
 *
 * `previousValue` and `nextValue` are the **already-scrubbed, bounded preview
 * strings** a producer put on the event — never the state itself, which never
 * leaves the page (AAP 0.5.2). They are typed `string` rather than `unknown`
 * precisely so that no consumer is tempted to introspect them: there is nothing
 * to introspect. This module carries them through, cutting a preview that
 * exceeds the declared bound and otherwise leaving it byte-for-byte as it
 * arrived; it never re-expands, re-parses or reconstructs a value, and
 * `valueType` is the category the producer reported rather than one inferred
 * from the preview's text.
 *
 * ## `changed` is reported, never inferred
 *
 * A producer emits a `state` event for a hook whose value it observed changing,
 * so `changed` records whether that report arrived with something to show:
 * `true` when at least one of the two value summaries was readable, `false`
 * when neither was, which is the degenerate event a viewer must not render as a
 * transition. It is **never** computed by comparing the two previews. Two long
 * values that differ only past the truncation bound have identical previews,
 * and calling that pair unchanged would be exactly the false claim the
 * unchanged-render accounting exists to avoid.
 *
 * ## The trigger links to an event, not to an object
 *
 * `triggerEventId` is what the viewer's trigger column links to, and it is
 * populated whenever the producer named a trigger **event** or a parent (or
 * lineage) span could be resolved. It is only ever a real event id: a producer
 * that knows the trigger's *span* id writes `triggerSpanId` instead (the
 * catalog's two trigger keys are two identifier spaces, not two spellings), and
 * that span id reaches `triggerSpanId` here even when the span it names is
 * outside the slice — a link into the trace still works, while inventing an
 * event id for it would not. `triggerName` and `triggerKind` are filled only
 * when the trigger's event is in the slice being aggregated, so no row borrows
 * a name from a different event.
 *
 * ## `truncated` is about the list, and marks a row that is not a transition
 *
 * `truncated` is the producer's disclosure that the transition list this row
 * belongs to is **incomplete** — a bound cut it — and `droppedTransitions` is
 * how many reported transitions it left without an event of their own. Neither
 * says anything about this row's values, and neither is related to the
 * truncation of a single preview.
 *
 * `../browser/state.ts` also emits one bounded *sentinel* per capture when its
 * per-capture bound left no transition to mark: a row with `truncated` set, no
 * `transitionSource`, no value previews and therefore `changed: false`. A
 * viewer must render such a row as the disclosure it is — "transitions were
 * dropped" — and never as a value transition, which is exactly what
 * `changed: false` has always meant here.
 */
export interface StateTransition {
  /** Stable identity of the row, equal to `eventId`; see {@link TimelineRow}. */
  readonly id: EventId;
  /** The captured `state` event this row describes. */
  readonly eventId: EventId;
  /** The event's span id. */
  readonly spanId: SpanId;
  /** The trace the transition belongs to. */
  readonly traceId: TraceId;
  /** When the transition was observed, in Unix epoch milliseconds. */
  readonly startTime: number;
  /** The component whose hook changed, when the producer could name it. */
  readonly component?: string;
  /** The hook's zero-based position in the fiber's hook list. */
  readonly hookIndex?: number;
  /** The inferred hook kind, when one could be inferred; diagnostic only. */
  readonly hookLabel?: string;
  /** Redacted, bounded preview of the value before the transition. */
  readonly previousValue?: string;
  /** Redacted, bounded preview of the value after it. */
  readonly nextValue?: string;
  /**
   * The category the producer reported: the new value's when it is known,
   * otherwise the old one's. A category this build does not recognise is
   * reported as `unknown` rather than passed through.
   */
  readonly valueType?: AttributeValueType;
  /** Whether the producer reported a transition it could describe. */
  readonly changed: boolean;
  /** The event the transition is attributed to; what the viewer links to. */
  readonly triggerEventId?: EventId;
  /**
   * The trigger's span id: the producer's own `triggerSpanId` when it named
   * one, otherwise the span of the event this row was attributed to. Set even
   * when that span is outside the slice.
   */
  readonly triggerSpanId?: SpanId;
  /** That event's name, when it is in the slice. */
  readonly triggerName?: string;
  /** That event's kind, when it is in the slice. */
  readonly triggerKind?: TelemetryKind;
  /**
   * Which dimension changed — the fiber's own hook state, or a context value it
   * consumes — when the producer reported a recognised one. Absent on the
   * truncation sentinel, which describes no value.
   */
  readonly transitionSource?: TransitionSource;
  /** The render span the transition was observed inside, as the producer reported it. */
  readonly renderSpanId?: SpanId;
  /**
   * The fiber instance whose value changed, when the producer resolved one.
   *
   * What separates two mounted copies of one component, which `component`
   * alone groups together.
   */
  readonly fiberId?: number;
  /**
   * `true` when the producer disclosed that this row's transition list was cut
   * by a bound; see the interface documentation.
   */
  readonly truncated?: boolean;
  /**
   * How many reported transitions the producer's bounds left without an event,
   * when it disclosed a count. A floor, not a total: the producer reports what
   * it had dropped at the moment it emitted the disclosure.
   */
  readonly droppedTransitions?: number;
  /** Where in the developer's project the hook lives, when resolved. */
  readonly source?: SourceLocation;
}

/** How the state-transition aggregate is built. */
export interface StateTransitionOptions {
  /**
   * The largest number of transitions to return; defaults to
   * {@link DEFAULT_MAX_STATE_TRANSITIONS}. Declared `| undefined` so an
   * optional configuration value can be forwarded straight through; a value
   * that is not a non-negative integer is treated as absent.
   */
  readonly maxTransitions?: number | undefined;
}

/** @see MutableRowSeed */
interface MutableStateTransition {
  id: EventId;
  eventId: EventId;
  spanId: SpanId;
  traceId: TraceId;
  startTime: number;
  component?: string;
  hookIndex?: number;
  hookLabel?: string;
  previousValue?: string;
  nextValue?: string;
  valueType?: AttributeValueType;
  changed: boolean;
  triggerEventId?: EventId;
  triggerSpanId?: SpanId;
  triggerName?: string;
  triggerKind?: TelemetryKind;
  transitionSource?: TransitionSource;
  renderSpanId?: SpanId;
  fiberId?: number;
  truncated?: boolean;
  droppedTransitions?: number;
  source?: SourceLocation;
}

/** What could be read out of one value summary: a preview, a category, or neither. */
interface ValueProjection {
  /** The producer's preview, cut to the declared bound if it was longer. */
  readonly preview?: string | undefined;
  /** The category the producer reported, mapped onto the closed vocabulary. */
  readonly type?: AttributeValueType | undefined;
}

/** The projection of an attribute that held nothing readable. */
const EMPTY_VALUE_PROJECTION: ValueProjection = Object.freeze({});

/**
 * Cuts a preview to the declared bound, counting code points.
 *
 * The producer already bounds a preview to `MAX_PREVIEW_LENGTH` (a documented
 * privacy guarantee, not a display preference), so a longer one means a
 * producer that did not — an older build, or a bug. Carrying it would widen
 * what a panel shows beyond what the guarantee promises, so it is cut here.
 * Code points rather than UTF-16 units, so a surrogate pair is never split into
 * a lone half.
 */
function boundedPreview(text: string): string {
  const codePoints = [...text];
  if (codePoints.length <= MAX_PREVIEW_LENGTH) {
    return text;
  }
  return codePoints.slice(0, MAX_PREVIEW_LENGTH).join('');
}

/**
 * Projects one `previousValue`/`nextValue` attribute into a preview and a
 * category.
 *
 * Accepts the {@link AttributeValueSummary} shape the attribute catalog
 * declares, reading its two fields through names the compiler checks against
 * that interface. A bare non-empty string is also accepted, as the preview with
 * no reported category: the summary shape is what the current producers send,
 * and tolerating the simpler form costs one branch and keeps a transition
 * legible if one ever sends it. Anything else projects to nothing.
 */
function projectValueSummary(value: unknown): ValueProjection {
  const preview = asNonEmptyString(value);
  if (preview !== undefined) {
    return { preview: boundedPreview(preview) };
  }

  if (typeof value !== 'object' || value === null) {
    return EMPTY_VALUE_PROJECTION;
  }

  const projection: { preview?: string; type?: AttributeValueType } = {};

  const summaryPreview = asNonEmptyString(readProperty(value, VALUE_SUMMARY_PREVIEW_FIELD));
  if (summaryPreview !== undefined) {
    projection.preview = boundedPreview(summaryPreview);
  }

  const reportedType = asNonEmptyString(readProperty(value, VALUE_SUMMARY_TYPE_FIELD));
  if (reportedType !== undefined) {
    projection.type =
      ATTRIBUTE_VALUE_TYPES.find((type) => type === reportedType) ?? UNKNOWN_VALUE_TYPE;
  }

  return projection;
}

/**
 * What a transition was attributed to: an event id to link to, a span id to
 * point at, and the event itself when the slice contains it.
 *
 * All three members are optional because the routes below know different
 * amounts. A producer that named a trigger **event** yields an id whether or
 * not the slice holds it; a producer that named a trigger **span** outside the
 * slice yields only that span id, and inventing an event id for it would put a
 * dead link in the viewer's trigger column; every route that resolves an event
 * yields all three. A resolution with no member at all is never returned —
 * {@link resolveTrigger} answers `undefined` for "nothing to attribute this to".
 */
interface TriggerResolution {
  /** The event id to link to, when a real one is known. */
  readonly eventId?: EventId | undefined;
  /** The trigger's span id: the producer's, or the resolved event's. */
  readonly spanId?: SpanId | undefined;
  /** The event itself, when the slice contains it. */
  readonly event?: TelemetryEvent | undefined;
}

/** The resolution of one event in the slice: its id, its span and itself. */
function triggerFromEvent(event: TelemetryEvent): TriggerResolution {
  return { eventId: event.id, spanId: event.spanId, event };
}

/**
 * Chooses the operation a transition is attributed to, in a fixed preference
 * order.
 *
 * 1. **The producer's own answer, as an event id.** `triggerEventId` on the
 *    event is what the page observed; nothing derived here can beat it, and it
 *    is honoured even when the named event is outside the slice.
 * 2. **The producer's own answer, as a span id.** `triggerSpanId` is the same
 *    answer from a producer that holds a span id rather than an event id — the
 *    page agent, which knows the interaction's or the settled request's span at
 *    commit time. Resolved through the span index, so the row gets the event's
 *    id, name and kind; a span outside the slice still yields the span id,
 *    because the producer's direct trigger must not be discarded in favour of a
 *    guess.
 * 3. **The nearest ancestor that is not itself a state transition.** A burst of
 *    transitions in one commit chains through each other; the useful trigger is
 *    the commit, the settled request or the interaction above them.
 * 4. **A lineage candidate.** When the parent chain leads nowhere and the
 *    producer recorded alternative continuation parents, the first resolvable
 *    one is a better answer than none — the ambiguity itself is carried on the
 *    timeline row, which is where a view can draw it.
 * 5. **The nearest resolvable ancestor at all**, even another transition: the
 *    span directly above is still what a reader sees above the row.
 *
 * The two producer-named routes come first because they are observations rather
 * than inferences: the page knew what it was responding to, and the parent
 * chain below is this module reconstructing that from span parentage.
 *
 * Three malformations end the walk rather than trapping it — a span that is its
 * own parent, a cycle among ancestors, and a parent that never arrived — and
 * the visited set is what makes the first two terminate regardless of the hop
 * budget.
 */
function resolveTrigger(
  event: TelemetryEvent,
  attributes: AttributeBag,
  spansBySpanId: ReadonlyMap<SpanId, TelemetryEvent>,
  eventsById: ReadonlyMap<EventId, TelemetryEvent>,
): TriggerResolution | undefined {
  const reported = asNonEmptyString(readAttribute(attributes, STATE_TRIGGER_EVENT_ID_KEY));
  if (reported !== undefined && reported !== event.id) {
    const named = eventsById.get(reported);
    return named === undefined ? { eventId: reported } : triggerFromEvent(named);
  }

  const reportedSpanId = asNonEmptyString(readAttribute(attributes, STATE_TRIGGER_SPAN_ID_KEY));
  if (reportedSpanId !== undefined && reportedSpanId !== event.spanId) {
    const named = spansBySpanId.get(reportedSpanId);
    return named === undefined ? { spanId: reportedSpanId } : triggerFromEvent(named);
  }

  const visited = new Set<SpanId>([event.spanId]);
  let nearest: TelemetryEvent | undefined;
  let spanId = event.parentSpanId;

  for (let hops = 0; hops < MAX_TRIGGER_LOOKUP_HOPS && spanId !== undefined; hops += 1) {
    if (visited.has(spanId)) {
      break;
    }
    visited.add(spanId);

    const ancestor = spansBySpanId.get(spanId);
    if (ancestor === undefined) {
      break;
    }

    if (nearest === undefined) {
      nearest = ancestor;
    }
    if (!STATE_KIND_SET.has(ancestor.kind)) {
      return triggerFromEvent(ancestor);
    }

    spanId = ancestor.parentSpanId;
  }

  const lineage = lineageOf(event);
  if (lineage !== undefined) {
    for (const candidateSpanId of lineage.candidateSpanIds) {
      if (candidateSpanId === event.spanId) {
        continue;
      }
      const candidate = spansBySpanId.get(candidateSpanId);
      if (candidate !== undefined) {
        return triggerFromEvent(candidate);
      }
    }
  }

  if (nearest !== undefined) {
    return triggerFromEvent(nearest);
  }

  return undefined;
}

/**
 * Indexes events by their event id, so a producer-named trigger is a lookup.
 *
 * First occurrence wins, like {@link indexSpans}: an id is unique by
 * construction, and a repeat is a replayed batch rather than a second event.
 */
function indexEventIds(events: readonly TelemetryEvent[]): ReadonlyMap<EventId, TelemetryEvent> {
  const index = new Map<EventId, TelemetryEvent>();

  for (const event of events) {
    if (!index.has(event.id)) {
      index.set(event.id, event);
    }
  }

  return index;
}

/** Assembles one transition from one `state` event. */
function toStateTransition(
  event: TelemetryEvent,
  spansBySpanId: ReadonlyMap<SpanId, TelemetryEvent>,
  eventsById: ReadonlyMap<EventId, TelemetryEvent>,
): StateTransition {
  const attributes = attributeBagOf(event);
  const previous = projectValueSummary(readAttribute(attributes, STATE_PREVIOUS_VALUE_KEY));
  const next = projectValueSummary(readAttribute(attributes, STATE_NEXT_VALUE_KEY));

  const transition: MutableStateTransition = {
    id: event.id,
    eventId: event.id,
    spanId: event.spanId,
    traceId: event.traceId,
    startTime: finiteOrZero(event.startTime),
    changed: previous.preview !== undefined || next.preview !== undefined,
  };

  const component = asNonEmptyString(readAttribute(attributes, STATE_COMPONENT_KEY));
  if (component !== undefined) {
    transition.component = component;
  }

  const hookIndex = asNonNegativeInteger(readAttribute(attributes, STATE_HOOK_INDEX_KEY));
  if (hookIndex !== undefined) {
    transition.hookIndex = hookIndex;
  }

  const hookLabel = asNonEmptyString(readAttribute(attributes, STATE_HOOK_LABEL_KEY));
  if (hookLabel !== undefined) {
    transition.hookLabel = hookLabel;
  }

  if (previous.preview !== undefined) {
    transition.previousValue = previous.preview;
  }
  if (next.preview !== undefined) {
    transition.nextValue = next.preview;
  }

  const valueType = next.type ?? previous.type;
  if (valueType !== undefined) {
    transition.valueType = valueType;
  }

  const trigger = resolveTrigger(event, attributes, spansBySpanId, eventsById);
  if (trigger !== undefined) {
    if (trigger.eventId !== undefined) {
      transition.triggerEventId = trigger.eventId;
    }
    if (trigger.spanId !== undefined) {
      transition.triggerSpanId = trigger.spanId;
    }

    const triggerEvent = trigger.event;
    if (triggerEvent !== undefined) {
      transition.triggerName = triggerEvent.name;
      transition.triggerKind = triggerEvent.kind;
    }
  }

  const transitionSource = asTransitionSource(
    readAttribute(attributes, STATE_TRANSITION_SOURCE_KEY),
  );
  if (transitionSource !== undefined) {
    transition.transitionSource = transitionSource;
  }

  const renderSpanId = asNonEmptyString(readAttribute(attributes, STATE_RENDER_SPAN_ID_KEY));
  if (renderSpanId !== undefined) {
    transition.renderSpanId = renderSpanId;
  }

  const fiberId = asNonNegativeInteger(readAttribute(attributes, STATE_FIBER_ID_KEY));
  if (fiberId !== undefined) {
    transition.fiberId = fiberId;
  }

  const truncated = asTrueFlag(readAttribute(attributes, STATE_TRUNCATED_KEY));
  if (truncated !== undefined) {
    transition.truncated = truncated;
  }

  const droppedTransitions = asNonNegativeInteger(
    readAttribute(attributes, STATE_DROPPED_TRANSITIONS_KEY),
  );
  if (droppedTransitions !== undefined) {
    transition.droppedTransitions = droppedTransitions;
  }

  if (event.source !== undefined) {
    transition.source = event.source;
  }

  return transition;
}

/**
 * The `stateTransitions` data source: every hook transition in the slice, in
 * canonical time order.
 *
 * Ordering is delegated to the correlator's canonical comparator, whose primary
 * key is `startTime` and whose final tie-breaker is the event id — exactly the
 * order this result promises, with the producer tie-breakers in between that
 * make it total. Two transitions that share a millisecond therefore come back
 * in the same order on every machine and in every process.
 *
 * @param events Any already-ingested, already-redacted events; the non-`state`
 * ones are the index the triggers are resolved against, so hand in the whole
 * slice rather than a pre-filtered one. Not modified.
 * @param options Result bound; see {@link StateTransitionOptions}.
 * @returns A fresh array of fresh objects, earliest first, at most
 * `maxTransitions` long. Empty when the slice holds no `state` events.
 */
export function aggregateStateTransitions(
  events: readonly TelemetryEvent[],
  options?: StateTransitionOptions,
): StateTransition[] {
  const maxTransitions = resolveBound(options?.maxTransitions, DEFAULT_MAX_STATE_TRANSITIONS);
  if (maxTransitions === 0) {
    return [];
  }

  const ordered = sortEventsCanonical(events);
  const spansBySpanId = indexSpans(ordered);
  const eventsById = indexEventIds(ordered);

  const transitions: StateTransition[] = [];

  for (const event of ordered) {
    if (!STATE_KIND_SET.has(event.kind)) {
      continue;
    }

    transitions.push(toStateTransition(event, spansBySpanId, eventsById));

    if (transitions.length >= maxTransitions) {
      break;
    }
  }

  return transitions;
}

/*
 * ---------------------------------------------------------------------------
 * Dependency graph
 *
 * The `graph` data source: who participated in the captured work and who called
 * whom. Participants, not spans — a component that rendered forty times is one
 * node with a count of forty, because the finding is "this participant was busy
 * forty times", not forty findings.
 *
 * Built from correlated telemetry only; the code-graph half of AAP 0.6.2's
 * description belongs to the service (see the module documentation).
 * ---------------------------------------------------------------------------
 */

/**
 * The participant classes a graph node can belong to: exactly the classes
 * AAP 0.6.2 names — "UI event, function, API, service, database/external".
 *
 * A closed vocabulary, in the order the work flows through it left to right,
 * which is also the order a reader meets them in a layered layout. The renderer
 * keys a node's shape and token off this and nothing else.
 *
 * Frozen: a read-only vocabulary.
 */
export const DEPENDENCY_NODE_KINDS = Object.freeze([
  /** Something the user did, and the page's own response to it. */
  'ui-event',
  /** A named application function, on either tier. */
  'function',
  /** A request boundary: the call the page made and the request that answered it. */
  'api',
  /** Server-side work behind that boundary. */
  'service',
  /** The datastore. */
  'database',
  /** Something outside the application: an outbound call to a third party. */
  'external',
] as const);

/** One member of the closed participant-class vocabulary. */
export type DependencyNodeKind = (typeof DEPENDENCY_NODE_KINDS)[number];

/**
 * The participant class each telemetry kind belongs to.
 *
 * **One table, no scattered conditionals.** Total by construction: the key type
 * is the closed kind union, so a kind added to `TELEMETRY_KINDS` fails to
 * compile here until it has been classified — which is the point, because an
 * unclassified kind would otherwise fall into whatever branch happened to be
 * last. The rules it encodes:
 *
 * - Everything the page observes about itself is a `ui-event`: the interaction,
 *   the renders and commits that followed, the hook transitions, the document's
 *   navigation, the performance entries, and a page error. They are one
 *   participant class because they are all the page acting, and their *kind*
 *   stays on the node for a renderer that wants to distinguish them.
 * - A request boundary is an `api`: the browser's `fetch`/`xhr` and the server's
 *   incoming request span. They stay separate nodes — their identities differ
 *   (a span name versus a matched route) and their tiers differ — which is
 *   precisely the client-to-server edge a reader is looking for.
 * - Server-side work behind that boundary is a `service`: the route handler, and
 *   an exception raised while handling a request, charged to the participant
 *   that failed rather than given a class of its own.
 * - A patched named function is a `function` on either tier, and an explicit log
 *   record joins it: a log names the code that emitted it rather than a
 *   participant of its own.
 * - `db.query` is the `database`; an outgoing server-side request is `external`,
 *   which is the only class that means "not this application".
 *
 * Frozen: a read-only lookup table.
 */
export const KIND_TO_DEPENDENCY_NODE_KIND: Readonly<Record<TelemetryKind, DependencyNodeKind>> =
  Object.freeze({
    interaction: 'ui-event',
    render: 'ui-event',
    commit: 'ui-event',
    fetch: 'api',
    xhr: 'api',
    navigation: 'ui-event',
    'perf.longtask': 'ui-event',
    'perf.entry': 'ui-event',
    error: 'ui-event',
    state: 'ui-event',
    'http.server': 'api',
    'route.handler': 'service',
    function: 'function',
    'db.query': 'database',
    'http.client': 'external',
    'server.error': 'service',
    log: 'function',
  });

/**
 * The class an event of an unrecognised kind is charged to.
 *
 * {@link KIND_TO_DEPENDENCY_NODE_KIND} is total over the kind vocabulary *this
 * build* knows, and an event read back from a store written by a newer producer
 * can carry a kind that is not in it. `external` is the honest bucket for one:
 * the participant is outside what this build can classify, and charging it to a
 * class that implies knowledge — a `service`, a `function` — would be a guess
 * presented as a fact. The span still appears, with its own kind on the node.
 */
const UNCLASSIFIED_DEPENDENCY_NODE_KIND: DependencyNodeKind = 'external';

/** Prefix of every {@link DependencyGraphNode.id}. */
export const DEPENDENCY_NODE_ID_PREFIX = 'dep:';

/** Prefix of every {@link DependencyGraphEdge.id}. */
export const DEPENDENCY_EDGE_ID_PREFIX = 'edge:';

/**
 * Separator between the two **escaped** node ids inside an edge id.
 *
 * A node id ends in a participant identity, and that identity is a span name
 * or an attribute value the producer chose: an interaction's selector, a route
 * pattern, a module and a symbol. It can therefore contain anything, including
 * this separator, and a raw `from + '=>' + to` would be ambiguous — the pair
 * (`a=>b`, `c`) and the pair (`a`, `b=>c`) produce one string, so two distinct
 * relationships would collide on one edge id and have their counts and
 * durations merged.
 *
 * {@link encodeEdgeEndpoint} escapes each endpoint before the join, so neither
 * character of this separator can occur inside an endpoint and the separator
 * occurs in the joined string exactly once. That makes the id injective over
 * the ordered pair of node ids, which is what an identity has to be.
 */
const DEPENDENCY_EDGE_ID_SEPARATOR = '=>';

/** Percent escape of `'%'` — applied first, so an escape cannot be re-escaped. */
const EDGE_ENDPOINT_PERCENT_ESCAPE = '%25';

/** Percent escape of `'='`, the separator's first character. */
const EDGE_ENDPOINT_EQUALS_ESCAPE = '%3D';

/** Percent escape of `'>'`, the separator's second character. */
const EDGE_ENDPOINT_GREATER_THAN_ESCAPE = '%3E';

/**
 * Escapes one node id so it can be joined with
 * {@link DEPENDENCY_EDGE_ID_SEPARATOR} unambiguously.
 *
 * Percent-escaping restricted to three characters: the two the separator is
 * made of, and `'%'` itself so the escaping is reversible and therefore
 * injective — escape `'%'` first, or `'a=b'` and `'a%3Db'` would both become
 * `'a%3Db'`.
 *
 * `encodeURIComponent` is deliberately not used even though it would escape
 * both separator characters: it throws `URIError` on a lone surrogate, and a
 * participant identity comes from a page this module does not control, which
 * would turn one malformed span name into a failed panel-data call. This
 * function is total over every string.
 *
 * @param nodeId A {@link DependencyGraphNode.id}.
 * @returns The id with `%`, `=` and `>` percent-escaped; every other character
 * byte for byte as it arrived.
 */
function encodeEdgeEndpoint(nodeId: string): string {
  return nodeId
    .replaceAll('%', EDGE_ENDPOINT_PERCENT_ESCAPE)
    .replaceAll('=', EDGE_ENDPOINT_EQUALS_ESCAPE)
    .replaceAll('>', EDGE_ENDPOINT_GREATER_THAN_ESCAPE);
}

/**
 * The id of the edge from one participant to another.
 *
 * The one place an edge id is built, so its injectivity is a property of a
 * named function rather than of a template literal. The `from` and `to` fields
 * of {@link DependencyGraphEdge} keep the **raw** node ids, because that is
 * what a consumer matches against {@link DependencyGraphNode.id}; only the id
 * string is escaped.
 */
function dependencyEdgeId(from: string, to: string): string {
  const head = encodeEdgeEndpoint(from);
  const tail = encodeEdgeEndpoint(to);
  return `${DEPENDENCY_EDGE_ID_PREFIX}${head}${DEPENDENCY_EDGE_ID_SEPARATOR}${tail}`;
}

/**
 * The label of a participant whose span carried no readable name.
 *
 * Such a span is **kept, never dropped**: its duration is part of the captured
 * work whether or not its producer labelled it, and a graph that silently
 * omitted it would understate the very path a developer is following.
 */
export const UNKNOWN_PARTICIPANT_LABEL = '(unknown participant)';

/** The largest number of participants one graph carries: 200. */
export const DEFAULT_MAX_DEPENDENCY_NODES = 200;

/** The largest number of edges one graph carries: 400. */
export const DEFAULT_MAX_DEPENDENCY_EDGES = 400;

/**
 * How many span ids a node carries as a sample: 50.
 *
 * `count` is the true number of spans a participant collapsed; `spanIds` is a
 * bounded sample of the earliest of them, so a node that collapsed four
 * thousand renders is a small object that can still be selected from. A
 * consumer that needs every span asks the `spans` source with a filter.
 */
export const MAX_SPAN_IDS_PER_DEPENDENCY_NODE = 50;

/** The empty identity-key list of a kind whose span name is its identity. */
const NO_IDENTITY_KEYS: readonly string[] = Object.freeze([]);

/** Joins the readable identity values of one span. */
const IDENTITY_SEPARATOR = ' ';

/**
 * The attributes that identify a participant, per kind, in the order they are
 * joined.
 *
 * Collapsing spans into participants needs an identity, and for most kinds the
 * producer's span name *is* it. Four kinds have something better, and it is
 * always a key the catalog already declares:
 *
 * - An interaction is identified by what happened and to what, so two clicks on
 *   the same element are one participant while clicks on two elements are two.
 * - An incoming request and a route handler are identified by the **matched
 *   route**, never the concrete path, so requests that differ only in their
 *   parameters collapse — which is what makes a graph of a parameterised route
 *   readable.
 * - A named function is identified by its module and symbol together, so two
 *   functions with the same name in different modules stay two participants.
 *
 * Database spans are deliberately **not** identified by their statement:
 * grouping by normalised statement is `./queries.ts`'s job, it owns the
 * normalisation rule, and that rule lives in the redaction layer this module
 * does not import. A second, subtly different grouping rule here would split one
 * group in two the moment the two copies drifted, so the producer's span name is
 * the identity and per-statement detail is read from the `queries` source.
 *
 * Total by construction, for the same reason as the classification table.
 *
 * Frozen: a read-only lookup table of read-only lists.
 */
const KIND_IDENTITY_ATTRIBUTE_KEYS: Readonly<Record<TelemetryKind, readonly string[]>> =
  Object.freeze({
    interaction: Object.freeze([INTERACTION_EVENT_TYPE_KEY, INTERACTION_TARGET_SELECTOR_KEY]),
    render: NO_IDENTITY_KEYS,
    commit: NO_IDENTITY_KEYS,
    fetch: NO_IDENTITY_KEYS,
    xhr: NO_IDENTITY_KEYS,
    navigation: NO_IDENTITY_KEYS,
    'perf.longtask': NO_IDENTITY_KEYS,
    'perf.entry': NO_IDENTITY_KEYS,
    error: NO_IDENTITY_KEYS,
    state: NO_IDENTITY_KEYS,
    'http.server': Object.freeze([HTTP_SERVER_ROUTE_KEY]),
    'route.handler': Object.freeze([ROUTE_HANDLER_ROUTE_KEY]),
    function: Object.freeze([FUNCTION_MODULE_KEY, FUNCTION_SYMBOL_KEY]),
    'db.query': NO_IDENTITY_KEYS,
    'http.client': NO_IDENTITY_KEYS,
    'server.error': NO_IDENTITY_KEYS,
    log: NO_IDENTITY_KEYS,
  });

/**
 * One participant of the captured work.
 *
 * ## It is a collapse, and the numbers say so
 *
 * `count` is how many spans collapsed into this node, `totalDurationMs` the sum
 * of their durations and `maxDurationMs` the slowest of them. The total is a
 * **sum, not a union**, and that is deliberate: the question a graph node
 * answers is "how much time went into this participant across the capture",
 * for which two concurrent 400 ms calls really are 800 ms of work. Wall-clock
 * questions — how long the capture, the interaction or a tier actually took —
 * are answered by the interval unions at the top of this module, which is why
 * both live here and neither is used for the other's job.
 *
 * ## It stands for one event only when it collapsed one record
 *
 * `eventId` and `traceId` are the coordinate a host selects an event by, and a
 * collapse of forty records is not one event: pairing it with the first of them
 * would send a details drawer to an arbitrary member of the group and present
 * that choice as the participant. So both fields are set **only** when `count`
 * is `1`, where the participant and its record are the same thing, and are
 * absent — the key itself, not an `undefined` value — otherwise.
 *
 * ## Nothing here holds a reference
 *
 * Edges name nodes by `id`, and a node names its spans and its event by id. The
 * whole shape is JSON, because it crosses an HTTP response on its way to the
 * panel.
 */
export interface DependencyGraphNode {
  /** `dep:` followed by class, tier and identity: deterministic across runs. */
  readonly id: string;
  /** Which participant class this node belongs to. */
  readonly kind: DependencyNodeKind;
  /** The participant's human label: its identity, or the producer's span name. */
  readonly label: string;
  /**
   * The tier the collapsed spans were produced in.
   *
   * Always set by {@link buildDependencyGraph} — a participant is per-tier by
   * construction, so a browser function and a server function of the same name
   * are two nodes. Optional in the shape because a consumer may add a node that
   * belongs to no tier: the service's code-graph enrichment can contribute a
   * participant it resolved statically.
   */
  readonly tier?: TelemetryTier;
  /**
   * The distinct telemetry kinds of the collapsed spans, in the canonical order
   * of `TELEMETRY_KINDS`.
   *
   * The participant class above is coarser than the kind vocabulary — a
   * `ui-event` node may collapse renders, commits or a navigation, and an `api`
   * node is either the browser's request or the server's — so the class alone
   * cannot tell a renderer what the node actually is. This list keeps the
   * kinds on the node, which is what lets a graph colour a participant with
   * the same span-kind colour the timeline and flame views give its spans.
   *
   * Always set by {@link buildDependencyGraph}, never empty there, and never
   * longer than the kind vocabulary. Optional in the shape for the same reason
   * as `tier`: a participant contributed without captured records has no kind.
   */
  readonly spanKinds?: readonly TelemetryKind[];
  /** A bounded sample of the collapsed span ids; see {@link MAX_SPAN_IDS_PER_DEPENDENCY_NODE}. */
  readonly spanIds: readonly SpanId[];
  /** How many spans collapsed into this node. Never bounded by the sample. */
  readonly count: number;
  /** The sum of the collapsed spans' durations, in milliseconds. */
  readonly totalDurationMs: number;
  /** The slowest single span of the collapse, in milliseconds. */
  readonly maxDurationMs: number;
  /**
   * Where in the developer's project this participant lives.
   *
   * The most confident location any collapsed span carried, when one did. The
   * field is also the seam the service's code-graph enrichment fills for a node
   * whose spans carried none.
   */
  readonly source?: SourceLocation;
  /**
   * Which column of a layered left-to-right layout this node belongs in.
   *
   * Always set by {@link buildDependencyGraph} (longest path from a root, so a
   * participant always sits to the right of everything that calls it). Optional
   * in the shape for the same reason as `tier`.
   */
  readonly layer?: number;
  /**
   * The id of the one captured event this participant stands for.
   *
   * Set by {@link buildDependencyGraph} exactly when `count` is `1`: the
   * participant collapsed a single record, so that record's id is a coordinate
   * a host can resolve. Absent for a collapse of several records, which stands
   * for no single event, and for a participant contributed without a captured
   * record.
   */
  readonly eventId?: EventId;
  /**
   * The trace the event named by `eventId` belongs to.
   *
   * Present exactly when `eventId` is, and taken from the same record.
   */
  readonly traceId?: TraceId;
}

/**
 * One caller-to-callee relationship between two participants.
 *
 * ## Measured, inferred, and ambiguous
 *
 * Most callee spans join their caller by being **nested** inside it: the
 * parent link is the context the runtime carried, and the edge is measured.
 * Some join through a **lineage attribution** instead — AAP 0.4.2's
 * asynchronous continuation, which gives a commit that followed a settled
 * response that response's span as its parent — and an attribution is an
 * inference, sometimes one chosen from several open candidates. A reader must
 * be able to tell the three apart, so an edge says how many of its `count`
 * callee spans were attributed (`inferredCount`) and how many of those
 * attributions were ambiguous (`ambiguousCount`). Both are read through
 * `lineageOf` in `../correlation/tree.ts`, never from the attribute keys, and
 * both keys are omitted when their value is `0`: an edge built entirely from
 * nesting carries neither.
 */
export interface DependencyGraphEdge {
  /**
   * `edge:` followed by the two node ids, each escaped by
   * {@link encodeEdgeEndpoint} and joined by `=>`: deterministic across runs,
   * and distinct for every distinct ordered pair of participants.
   */
  readonly id: string;
  /** The calling participant's {@link DependencyGraphNode.id}, unescaped. */
  readonly from: string;
  /** The called participant's id, unescaped. */
  readonly to: string;
  /** How many spans of `to` hung from a span of `from`. */
  readonly count: number;
  /** The sum of those spans' durations: what the caller spent in this dependency. */
  readonly totalDurationMs: number;
  /**
   * How many of the `count` callee spans joined their caller through a lineage
   * attribution rather than by being nested inside it.
   *
   * Between `1` and `count` when present; the key is omitted when no callee
   * span was attributed, so `inferredCount === count` means the whole
   * relationship is inferred and a smaller value that part of it is.
   */
  readonly inferredCount?: number;
  /**
   * How many of those attributed spans had more than one candidate caller open
   * when they were attributed, so the caller shown is the most recently settled
   * candidate rather than a certainty.
   *
   * Between `1` and `inferredCount` when present; omitted when `0`.
   */
  readonly ambiguousCount?: number;
}

/**
 * The `graph` data source: the participants of a capture and the calls between
 * them, laid out in layers.
 */
export interface DependencyGraphData {
  /** Participants, by `layer`, then by descending total duration, then by id. */
  readonly nodes: readonly DependencyGraphNode[];
  /** Relationships, by `from`, then by `to`. */
  readonly edges: readonly DependencyGraphEdge[];
  /**
   * How many layers the layout needs: one more than the greatest `layer`, and
   * `0` for an empty graph.
   */
  readonly layerCount: number;
  /** Whether participants or edges were left out because a bound was reached. */
  readonly truncated: boolean;
}

/** How the dependency graph is built. Both members are optional. */
export interface DependencyGraphOptions {
  /**
   * The largest number of participants to carry; defaults to
   * {@link DEFAULT_MAX_DEPENDENCY_NODES}. Declared `| undefined` so an optional
   * configuration value can be forwarded straight through; a value that is not a
   * non-negative integer is treated as absent.
   */
  readonly maxNodes?: number | undefined;
  /**
   * The largest number of edges to carry; defaults to
   * {@link DEFAULT_MAX_DEPENDENCY_EDGES}. An edge whose endpoints did not
   * survive the node bound is dropped before this bound applies.
   */
  readonly maxEdges?: number | undefined;
}

/** The running state of one participant while the events are scanned. */
interface ParticipantAccumulator {
  readonly id: string;
  readonly kind: DependencyNodeKind;
  readonly label: string;
  readonly tier: TelemetryTier;
  /** Every distinct kind folded in; published sorted, see {@link DependencyGraphNode.spanKinds}. */
  readonly spanKinds: Set<TelemetryKind>;
  readonly spanIds: SpanId[];
  /**
   * The id of the first record folded in, in canonical order.
   *
   * Kept for every participant and published only while `count` is `1`, where
   * it is the id of the participant's one record; see
   * {@link DependencyGraphNode.eventId}.
   */
  readonly firstEventId: EventId;
  /** The trace of that same record; see {@link DependencyGraphNode.traceId}. */
  readonly firstTraceId: TraceId;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  source?: SourceLocation | undefined;
}

/** The running state of one edge. */
interface EdgeAccumulator {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  count: number;
  totalDurationMs: number;
  /** Callee spans attributed through lineage; see {@link DependencyGraphEdge.inferredCount}. */
  inferredCount: number;
  /** Of those, the ambiguous ones; see {@link DependencyGraphEdge.ambiguousCount}. */
  ambiguousCount: number;
}

/** @see MutableRowSeed */
interface MutableDependencyGraphNode {
  id: string;
  kind: DependencyNodeKind;
  label: string;
  tier?: TelemetryTier;
  spanKinds?: readonly TelemetryKind[];
  spanIds: readonly SpanId[];
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  source?: SourceLocation;
  layer?: number;
  eventId?: EventId;
  traceId?: TraceId;
}

/** @see MutableRowSeed */
interface MutableDependencyGraphEdge {
  id: string;
  from: string;
  to: string;
  count: number;
  totalDurationMs: number;
  inferredCount?: number;
  ambiguousCount?: number;
}

/**
 * Orders two locations of equal confidence, totally and independently of input
 * order.
 *
 * Confidence is what decides between two locations, and it decides nothing
 * between two that report the same number — which happens routinely, because
 * every route has a default confidence and several spans of one participant are
 * usually resolved by the same route. So the locations themselves are compared,
 * in a fixed field order: `file`, then `line`, then `column`, then `symbol`,
 * then `resolvedBy`, then `endLine`. That is every field of the shape except
 * `confidence` itself, which makes the order **total**: two locations compare
 * equal only when they are the same location, so no pair is left for arrival
 * order to decide. Comparing them in a declared order is what makes the choice
 * a function of the *set* of candidates rather than of the order the events
 * happened to arrive in.
 *
 * A location that names a symbol sorts before one that does not, so the more
 * descriptive of two otherwise identical positions wins. `../aggregate/
 * renders.ts` orders equal-confidence locations by the same rule, so the
 * `renders` and `graph` sources cannot send a developer to two different lines
 * for one component.
 *
 * @returns A negative number when `left` sorts first, positive when `right`
 * does, and `0` only for two identical locations — at which point they are
 * interchangeable for every consumer.
 */
function compareSourceLocations(left: SourceLocation, right: SourceLocation): number {
  if (left.file !== right.file) {
    return compareStrings(left.file, right.file);
  }
  if (left.line !== right.line) {
    return left.line < right.line ? -1 : 1;
  }
  if (left.column !== right.column) {
    return left.column < right.column ? -1 : 1;
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
  // The last field of the shape, and the one that makes the order total: two
  // locations agreeing on everything above can still describe different spans
  // of one declaration, and leaving that pair equal would hand the choice back
  // to arrival order.
  return (left.endLine ?? 0) - (right.endLine ?? 0);
}

/**
 * Keeps the more trustworthy of two locations.
 *
 * Resolution routes differ in what they can promise — a patch knows exactly
 * where it wrote, a source map knows a position, an owner chain knows a
 * component — and each location carries the confidence its route assigned. When
 * several spans of one participant disagree, the most confident answer is the
 * one a developer should be sent to.
 *
 * Confidence takes precedence, and {@link compareSourceLocations} settles a
 * tie. Keeping the incumbent on a tie would make a participant's source
 * location depend on the order its spans were folded in, so two builds of one
 * capture could send a developer to two different lines; the tie-break is a
 * total order, so they cannot.
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
  return compareSourceLocations(candidate, current) < 0 ? candidate : current;
}

/**
 * The identity a span collapses by: its kind's identity attributes when they
 * are readable, otherwise the producer's span name, otherwise
 * {@link UNKNOWN_PARTICIPANT_LABEL}.
 */
function participantIdentityOf(event: TelemetryEvent): string {
  const keys = KIND_IDENTITY_ATTRIBUTE_KEYS[event.kind] ?? NO_IDENTITY_KEYS;

  if (keys.length > 0) {
    const attributes = attributeBagOf(event);
    const parts: string[] = [];

    for (const key of keys) {
      const value = asNonEmptyString(readAttribute(attributes, key));
      if (value !== undefined) {
        parts.push(value);
      }
    }

    if (parts.length > 0) {
      return parts.join(IDENTITY_SEPARATOR);
    }
  }

  return asNonEmptyString(event.name) ?? UNKNOWN_PARTICIPANT_LABEL;
}

/**
 * Folds one event into its participant, creating the participant on first
 * sight.
 *
 * @returns The participant's node id, so the caller can map the span onto it.
 */
function accumulateParticipant(
  participants: Map<string, ParticipantAccumulator>,
  event: TelemetryEvent,
): string {
  const kind = KIND_TO_DEPENDENCY_NODE_KIND[event.kind] ?? UNCLASSIFIED_DEPENDENCY_NODE_KIND;
  const identity = participantIdentityOf(event);
  const id = `${DEPENDENCY_NODE_ID_PREFIX}${kind}:${event.tier}:${identity}`;
  const durationMs = clampNonNegative(finiteOrZero(event.duration));

  const existing = participants.get(id);
  if (existing === undefined) {
    participants.set(id, {
      id,
      kind,
      label: identity,
      tier: event.tier,
      spanKinds: new Set([event.kind]),
      spanIds: [event.spanId],
      firstEventId: event.id,
      firstTraceId: event.traceId,
      count: 1,
      totalDurationMs: durationMs,
      maxDurationMs: durationMs,
      source: event.source,
    });
    return id;
  }

  existing.count += 1;
  existing.totalDurationMs += durationMs;
  existing.spanKinds.add(event.kind);
  if (durationMs > existing.maxDurationMs) {
    existing.maxDurationMs = durationMs;
  }
  if (existing.spanIds.length < MAX_SPAN_IDS_PER_DEPENDENCY_NODE) {
    existing.spanIds.push(event.spanId);
  }
  existing.source = preferSource(existing.source, event.source);

  return id;
}

/** Descending by total duration, then by count, then ascending by id. */
function compareParticipantsBySignificance(
  left: ParticipantAccumulator,
  right: ParticipantAccumulator,
): number {
  if (left.totalDurationMs !== right.totalDurationMs) {
    return left.totalDurationMs > right.totalDurationMs ? -1 : 1;
  }
  if (left.count !== right.count) {
    return left.count > right.count ? -1 : 1;
  }
  return compareStrings(left.id, right.id);
}

/** Descending by count, then by total duration, then ascending by id. */
function compareEdgesBySignificance(left: EdgeAccumulator, right: EdgeAccumulator): number {
  if (left.count !== right.count) {
    return left.count > right.count ? -1 : 1;
  }
  if (left.totalDurationMs !== right.totalDurationMs) {
    return left.totalDurationMs > right.totalDurationMs ? -1 : 1;
  }
  return compareStrings(left.id, right.id);
}

/** By layer, then by descending total duration, then by id: the output order. */
function compareNodesForOutput(left: DependencyGraphNode, right: DependencyGraphNode): number {
  const leftLayer = left.layer ?? 0;
  const rightLayer = right.layer ?? 0;
  if (leftLayer !== rightLayer) {
    return leftLayer < rightLayer ? -1 : 1;
  }
  if (left.totalDurationMs !== right.totalDurationMs) {
    return left.totalDurationMs > right.totalDurationMs ? -1 : 1;
  }
  return compareStrings(left.id, right.id);
}

/** By `from`, then by `to`: the output order. */
function compareEdgesForOutput(left: DependencyGraphEdge, right: DependencyGraphEdge): number {
  if (left.from !== right.from) {
    return compareStrings(left.from, right.from);
  }
  return compareStrings(left.to, right.to);
}

/**
 * Assigns each node the column of a layered left-to-right layout it belongs in:
 * its longest path from a root.
 *
 * Longest path rather than shortest, because a layout must place a participant
 * to the right of **everything** that calls it — with a shortest path, a
 * function reached both directly and through a service would be drawn beside the
 * service that calls it.
 *
 * ## Cycles
 *
 * Collapsing spans into participants can create a cycle that the trace itself
 * did not have: two functions that call each other in different requests become
 * two nodes with an edge each way. A cycle has no longest path, so its members
 * are not reached by the topological pass; they are then placed one column right
 * of whichever of their callers *was* placed, or in column zero if none was.
 * That is stable, never negative and always drawable, which is what a renderer
 * needs from a layout it cannot ask questions of.
 *
 * @param nodeIds Every node's id, in ascending order, which is what makes the
 * traversal deterministic.
 * @param edges The edges of the same graph, already reduced to those bounds
 * kept.
 */
function assignLayers(
  nodeIds: readonly string[],
  edges: readonly DependencyGraphEdge[],
): ReadonlyMap<string, number> {
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of nodeIds) {
    outgoing.set(id, []);
    inDegree.set(id, 0);
  }

  for (const edge of edges) {
    const targets = outgoing.get(edge.from);
    const incoming = inDegree.get(edge.to);
    if (targets === undefined || incoming === undefined) {
      // An edge whose endpoint is not a node of this graph. The caller filters
      // those out; the guard is what lets this function stand alone.
      continue;
    }
    targets.push(edge.to);
    inDegree.set(edge.to, incoming + 1);
  }

  const layers = new Map<string, number>();
  const queue: string[] = [];

  for (const id of nodeIds) {
    if (inDegree.get(id) === 0) {
      layers.set(id, 0);
      queue.push(id);
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined) {
      continue;
    }

    const layer = layers.get(id) ?? 0;

    for (const target of outgoing.get(id) ?? []) {
      const known = layers.get(target);
      if (known === undefined || layer + 1 > known) {
        layers.set(target, layer + 1);
      }

      const remaining = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
      }
    }
  }

  for (const id of nodeIds) {
    if (layers.has(id)) {
      continue;
    }

    let layer = 0;
    for (const edge of edges) {
      if (edge.to !== id) {
        continue;
      }
      const callerLayer = layers.get(edge.from);
      if (callerLayer !== undefined && callerLayer + 1 > layer) {
        layer = callerLayer + 1;
      }
    }
    layers.set(id, layer);
  }

  return layers;
}

/**
 * The kinds of `kinds` in the canonical order of `TELEMETRY_KINDS`, so a node's
 * `spanKinds` is the same list however its records arrived. A kind this build
 * does not know — a newer producer's, read back from the store — sorts after
 * every known kind, by its own spelling, rather than being dropped.
 */
function canonicalKindOrder(kinds: ReadonlySet<TelemetryKind>): TelemetryKind[] {
  const rank = (kind: TelemetryKind): number => {
    const index = TELEMETRY_KINDS.indexOf(kind);
    return index === -1 ? TELEMETRY_KINDS.length : index;
  };
  return [...kinds].sort((left, right) => rank(left) - rank(right) || compareStrings(left, right));
}

/** Finishes one participant into its output node. */
function toDependencyNode(accumulator: ParticipantAccumulator, layer: number): DependencyGraphNode {
  const node: MutableDependencyGraphNode = {
    id: accumulator.id,
    kind: accumulator.kind,
    label: accumulator.label,
    tier: accumulator.tier,
    spanKinds: canonicalKindOrder(accumulator.spanKinds),
    spanIds: [...accumulator.spanIds],
    count: accumulator.count,
    totalDurationMs: roundMs(clampNonNegative(accumulator.totalDurationMs)),
    maxDurationMs: roundMs(clampNonNegative(accumulator.maxDurationMs)),
    layer,
  };

  if (accumulator.source !== undefined) {
    node.source = accumulator.source;
  }

  // A single-record participant IS its record, so that record's coordinate is
  // the participant's. A collapse of several stands for no single event, and
  // publishing the first of them would present an arbitrary member of the
  // group as the whole of it.
  if (accumulator.count === 1) {
    node.eventId = accumulator.firstEventId;
    node.traceId = accumulator.firstTraceId;
  }

  return node;
}

/** Finishes one edge into its output shape. */
function toDependencyEdge(accumulator: EdgeAccumulator): DependencyGraphEdge {
  const edge: MutableDependencyGraphEdge = {
    id: accumulator.id,
    from: accumulator.from,
    to: accumulator.to,
    count: accumulator.count,
    totalDurationMs: roundMs(clampNonNegative(accumulator.totalDurationMs)),
  };

  // Omitted rather than written as `0`, so an edge built entirely from nesting
  // keeps exactly the shape it had before lineage was reported.
  if (accumulator.inferredCount > 0) {
    edge.inferredCount = accumulator.inferredCount;
  }
  if (accumulator.ambiguousCount > 0) {
    edge.ambiguousCount = accumulator.ambiguousCount;
  }

  return edge;
}

/**
 * The `graph` data source: the participants of a capture and the calls between
 * them.
 *
 * Spans collapse into participants by class, tier and identity
 * ({@link KIND_IDENTITY_ATTRIBUTE_KEYS}); an edge is one participant's span
 * hanging from another's. Two relationships are deliberately not edges: a span
 * whose parent is outside the slice contributes none (there is nothing to point
 * at), and a span whose parent collapsed into the **same** participant
 * contributes none either — a self-edge is not drawable in a layered layout, and
 * the recursion it describes is already visible in that node's `count`.
 *
 * A participant that collapsed exactly one record carries that record's
 * `eventId` and `traceId` ({@link DependencyGraphNode}), and an edge counts how
 * many of its callee spans were attributed through lineage rather than nested,
 * and how many of those ambiguously ({@link DependencyGraphEdge}). Both are
 * read off the events; neither is guessed.
 *
 * Both bounds drop the least significant items rather than an arbitrary tail:
 * participants by descending total duration, edges by descending count. Keeping
 * the costliest participants is what makes a truncated graph still answer the
 * question that was asked, and `truncated` is what lets the renderer say that
 * something was left out.
 *
 * @param events Any already-ingested, already-redacted events — the whole slice,
 * since an event's parent is resolved within it. Not modified.
 * @param options Node and edge bounds; see {@link DependencyGraphOptions}.
 * @returns A graph whose arrays are in a fixed order, so two builds of the same
 * capture are structurally identical. Empty, with `layerCount: 0`, for no
 * events.
 */
export function buildDependencyGraph(
  events: readonly TelemetryEvent[],
  options?: DependencyGraphOptions,
): DependencyGraphData {
  const maxNodes = resolveBound(options?.maxNodes, DEFAULT_MAX_DEPENDENCY_NODES);
  const maxEdges = resolveBound(options?.maxEdges, DEFAULT_MAX_DEPENDENCY_EDGES);

  const ordered = sortEventsCanonical(events);

  const participants = new Map<string, ParticipantAccumulator>();
  const participantIdBySpanId = new Map<SpanId, string>();

  for (const event of ordered) {
    const id = accumulateParticipant(participants, event);
    // First occurrence of a span id wins, as everywhere else in this module: a
    // repeated span id is a replayed batch the correlator reports rather than
    // something to reconcile here.
    if (!participantIdBySpanId.has(event.spanId)) {
      participantIdBySpanId.set(event.spanId, id);
    }
  }

  const edgeAccumulators = new Map<string, EdgeAccumulator>();

  for (const event of ordered) {
    const { parentSpanId } = event;
    if (parentSpanId === undefined) {
      continue;
    }

    const from = participantIdBySpanId.get(parentSpanId);
    const to = participantIdBySpanId.get(event.spanId);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }

    const id = dependencyEdgeId(from, to);
    const durationMs = clampNonNegative(finiteOrZero(event.duration));
    // How this callee span came to hang from its caller: through a lineage
    // attribution when `lineageOf` finds one, by nesting otherwise. Read
    // through the one reader of the lineage keys, so the edge and the timeline
    // row built from the same event can never disagree about it.
    const lineage = lineageOf(event);
    const inferred = lineage === undefined ? 0 : 1;
    const ambiguous = lineage?.ambiguous === true ? 1 : 0;

    const existing = edgeAccumulators.get(id);
    if (existing === undefined) {
      edgeAccumulators.set(id, {
        id,
        from,
        to,
        count: 1,
        totalDurationMs: durationMs,
        inferredCount: inferred,
        ambiguousCount: ambiguous,
      });
      continue;
    }

    existing.count += 1;
    existing.totalDurationMs += durationMs;
    existing.inferredCount += inferred;
    existing.ambiguousCount += ambiguous;
  }

  const allParticipants = [...participants.values()];
  const nodesTruncated = allParticipants.length > maxNodes;
  const keptParticipants = nodesTruncated
    ? [...allParticipants].sort(compareParticipantsBySignificance).slice(0, maxNodes)
    : allParticipants;
  const keptNodeIds = new Set(keptParticipants.map((participant) => participant.id));

  const connectedEdges = [...edgeAccumulators.values()].filter(
    (edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to),
  );
  const edgesTruncated = connectedEdges.length > maxEdges;
  const keptEdges = edgesTruncated
    ? [...connectedEdges].sort(compareEdgesBySignificance).slice(0, maxEdges)
    : connectedEdges;

  const edges = keptEdges.map(toDependencyEdge).sort(compareEdgesForOutput);
  const layers = assignLayers([...keptNodeIds].sort(compareStrings), edges);

  const nodes = keptParticipants
    .map((participant) => toDependencyNode(participant, layers.get(participant.id) ?? 0))
    .sort(compareNodesForOutput);

  let maxLayer = -1;
  for (const node of nodes) {
    const layer = node.layer ?? 0;
    if (layer > maxLayer) {
      maxLayer = layer;
    }
  }

  return {
    nodes,
    edges,
    layerCount: maxLayer + 1,
    // An edge dropped with its endpoint is not a truncation of its own: the
    // node bound already said something was left out.
    truncated: nodesTruncated || edgesTruncated,
  };
}
