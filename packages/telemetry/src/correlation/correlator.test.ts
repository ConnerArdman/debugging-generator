/**
 * Colocated tests for `./correlator.ts` — and, because this folder holds only
 * three files, for the tree vocabulary and traversals of `./tree.ts` that the
 * correlator builds and every consumer reads.
 *
 * **Why this suite is the folder's acceptance gate.** AAP §0.8.3 names it
 * directly ("trace correlation → `correlation/correlator.ts` (ordering,
 * nesting, orphan attachment)") because correlation is the product's headline
 * capability: one click must resolve to *one ordered tree* spanning the browser
 * handler, the React work, the `fetch`, the Next.js request and route handler,
 * the patched service function, the SQL and the external call (AAP §0.8.4,
 * acceptance test 1). Four surfaces read that tree without any shared runtime
 * path — `Timeline`, `FlameChart` and `Waterfall` draw it,
 * `POST /sessions/:id/panel-data` serves it for `{ source: 'trace' }`, and
 * `../aggregate/*` derives every capture metric from it — so a defect here is
 * silent everywhere: a dropped span removes all the work underneath it from
 * every duration in the capture, and an unstable order makes two renders of the
 * same capture disagree.
 *
 * ## The four guarantees, and how each is checked
 *
 * 1. **The canonical order** (AAP §0.2.3). `startTime`, then `producerId`, then
 *    `seq`, then `ingestSeq`. The mandated hard case is *mixed browser/Node
 *    input with equal timestamps across producers*: the browser agent and the
 *    dev-server preload read two different clocks and routinely land in the
 *    same millisecond, so the suite below asserts that pair resolves the same
 *    way in both input orders, and that the comparator is a **total** order
 *    (antisymmetric, transitive, `0` only for a pair that ties on every key).
 *    Parent-before-child is *structural*, so the clock-skew case asserts that a
 *    child timestamped **before** its parent still renders after it.
 * 2. **Nothing is dropped** (AAP §0.4.2). Every orphan scenario —
 *    missing parent, no parentable event at all, self-parent, two- and
 *    three-node cycles, repeated span ids and the depth guard — asserts
 *    `eventCount === events.length` *and* that the trees' `nodeCount` sums to
 *    it. Those two numbers are the mechanical proof; a correlator that quietly
 *    discarded an unresolvable parent would pass a structural assertion and
 *    fail these.
 * 3. **Permutation invariance.** The service re-correlates a capture
 *    incrementally as batches land from two independent producers, so arrival
 *    order must be unobservable. Structural cases feed a seeded shuffle, and
 *    the ambiguous decisions (which cycle member is cut, which parentless event
 *    anchors the trace) are asserted equal across reversal and shuffling.
 * 4. **Purity.** Inputs are frozen before the call and compared against a
 *    structured copy afterwards, and every tree is asserted to survive a JSON
 *    round trip — it crosses a WebSocket as `panel.generated` evidence and an
 *    HTTP response as the `trace` DataResult, so a parent back-reference, a
 *    `Map` or an `undefined`-valued key would be a transport bug.
 *
 * ## Fixture conventions
 *
 * Most of the data is built here and is **synthetic and deterministic**
 * (AAP §0.5.2): identifiers are minted from a counter so a failing assertion
 * names the same span on every run, span and trace ids are schema-shaped hex
 * (asserted by the harness self-checks below), timings are explicit
 * millisecond offsets from one fixed epoch base, and the only permutation
 * source is a seeded linear-congruential shuffle. No wall clock, no
 * `Math.random` and no locale-sensitive comparison is read anywhere in this
 * file. Span names are derived from their span id, so nothing built here is a
 * URL, a SQL statement, a credential or an identifier a pipeline is meant to
 * discover by analysing a project's code (AAP §0.5.4).
 *
 * The first three guarantees — and the input-purity half of the fourth — are
 * **additionally** driven by one committed corpus,
 * `test/fixtures/correlation-mixed-tiers.json` — the mixed browser/Node
 * capture AAP §0.2.3 names this suite against — which the last section of the
 * file reads from disk at run time and validates row by row through
 * `telemetryEventSchema`. That read is this suite's only filesystem access,
 * and what it reads is deterministic repository data rather than captured
 * telemetry: eleven already-redacted persisted rows in a deliberately shuffled
 * file order, no clock and no network, so its expectations are as reproducible
 * as the inline ones. It is there because a corpus with no executable consumer
 * is free to drift — it could lose its server tier or its orphan and leave
 * every hand-built case above green — so parsing it *is* the fixture-contract
 * assertion, and the structure it pins (the chain span by span, the depths,
 * the per-tier counts) is stated as literals for the same reason.
 *
 * Expectations are derived from the imported vocabularies (`TELEMETRY_KINDS`,
 * `TELEMETRY_TIERS`, `ORPHAN_REASONS`, `LINEAGE_ATTRIBUTE_KEYS`,
 * `DEFAULT_MAX_DEPTH`) rather than restated as literals, so a vocabulary change
 * surfaces here as a failure instead of as a stale copy that still passes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isSpanId, isTraceId } from '@debuggen/shared';
import type { CaptureId, ProducerId, SessionId, SpanId, TraceId } from '@debuggen/shared';

import {
  CORRELATION_ATTRIBUTE_KEYS,
  LINEAGE_ATTRIBUTE_KEYS,
  LINEAGE_VALUES,
} from '../schema/attributes.js';
import { isTelemetryEvent, telemetryEventSchema } from '../schema/event.js';
import type { TelemetryEvent } from '../schema/event.js';
import { TELEMETRY_KINDS, TELEMETRY_TIERS, allowedTiersFor } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryTier } from '../schema/kinds.js';

import {
  EXTENSION_REFUSAL_REASONS,
  compareEventsCanonical,
  correlateEvents,
  correlateTrace,
  extendCorrelatedTrace,
  indexTraceForExtension,
  rootAffinityForKind,
  sortEventsCanonical,
} from './correlator.js';
import type {
  CorrelationResult,
  ExtensionRefusalReason,
  TraceExtensionIndex,
  TraceExtensionResult,
} from './correlator.js';
import {
  DEFAULT_MAX_DEPTH,
  ORPHAN_REASONS,
  ancestorsOfSpanId,
  findNodeBySpanId,
  findNodeInSubtree,
  flattenNode,
  flattenTrace,
  nodeEndTime,
  orphanFlagsOf,
  selfTimeOf,
  subtreeNodeCount,
  totalTimeOf,
  walkTrace,
} from './tree.js';
import type { TraceNode, TraceTree } from './tree.js';

/*
 * ---------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------
 */

/**
 * The epoch millisecond every offset in this file is measured from.
 *
 * Inside the window `../schema/event.ts` accepts, and fixed rather than read
 * from a clock so that every assertion about ordering and duration is the same
 * on every run and on every host.
 */
const BASE_TIME = 1_768_000_000_000;

/** The duration a fixture reports unless the case is about timing. */
const DEFAULT_DURATION_MS = 1;

/** The kind a fixture reports unless the case is about the kind vocabulary. */
const DEFAULT_KIND: TelemetryKind = 'function';

/**
 * The browser agent's producer id, and the lexicographically **smaller** of the
 * two: the equal-timestamp case below depends on knowing which way
 * `producerId` breaks the tie, and stating it here keeps that dependency
 * visible instead of hiding it in a string literal.
 */
const BROWSER_PRODUCER: ProducerId = 'prd_browseragent01';

/** The Node preload's producer id; lexicographically after the browser's. */
const SERVER_PRODUCER: ProducerId = 'prd_serverpreload1';

/** The session every fixture belongs to; correlation never reads it. */
const SESSION_ID: SessionId = 'ses_00000000000test';

/** The capture every fixture belongs to; correlation never reads it. */
const CAPTURE_ID: CaptureId = 'cap_00000000000test';

/** One counter behind every minted identifier, so each fixture is distinct. */
let fixtureOrdinal = 0;

/** The next ordinal; the only source of variation in a fixture identifier. */
function nextOrdinal(): number {
  fixtureOrdinal += 1;
  return fixtureOrdinal;
}

/**
 * `value` as exactly `length` lowercase hex digits.
 *
 * @param length How many digits the identifier carries.
 * @param value The ordinal to render.
 * @returns The zero-padded digits.
 */
function hexDigits(length: number, value: number): string {
  return value.toString(16).padStart(length, '0');
}

/** `value` as a schema-shaped {@link SpanId}: 16 lowercase hex characters. */
function hexSpan(value: number): SpanId {
  return hexDigits(16, value);
}

/** `value` as a schema-shaped {@link TraceId}: 32 lowercase hex characters. */
function hexTrace(value: number): TraceId {
  return hexDigits(32, value);
}

/** The trace a fixture belongs to unless the case is about grouping. */
const DEFAULT_TRACE_ID = hexTrace(1);

/** A fresh span id no other fixture carries. */
function nextSpanId(): SpanId {
  return hexSpan(nextOrdinal());
}

/**
 * `offsetMs` milliseconds after {@link BASE_TIME}.
 *
 * Fractional offsets are deliberate in the tie-break cases: `startTime` is a
 * double with sub-millisecond precision, and two producers landing on the
 * *identical* double is the case AAP §0.2.3 says the later keys exist for.
 */
function at(offsetMs: number): number {
  return BASE_TIME + offsetMs;
}

/**
 * A tier the kind/tier table permits for `kind`.
 *
 * Fixtures take their tier from the table rather than stating one, so every
 * event this file builds satisfies the persisted schema's cross-field check by
 * construction — including the events of all seventeen kinds swept through the
 * harness self-check and the root-affinity case.
 */
function firstAllowedTier(kind: TelemetryKind): TelemetryTier {
  const [tier] = allowedTiersFor(kind);
  if (tier === undefined) {
    throw new Error(`KIND_ALLOWED_TIERS lists no tier for kind "${kind}"`);
  }
  return tier;
}

/**
 * What a case may vary about one persisted event.
 *
 * `spanId` is required because parentage is the whole subject here: every
 * fixture's identity has to be visible at its construction site rather than
 * minted invisibly, so that a case reads as the tree it is about.
 */
type EventOverrides = Partial<TelemetryEvent> & { readonly spanId: SpanId };

/**
 * One persisted telemetry event: every field the store holds, populated.
 *
 * `seq` and `ingestSeq` default to the same fresh ordinal, so fixtures built in
 * source order are also in canonical order when their timestamps tie — which is
 * why every tie-break case states those two fields explicitly instead of
 * relying on construction order.
 *
 * @param overrides The span id, plus any field the case varies.
 * @returns A fresh event that `isTelemetryEvent` accepts.
 */
function makeEvent(overrides: EventOverrides): TelemetryEvent {
  const kind = overrides.kind ?? DEFAULT_KIND;
  const ordinal = nextOrdinal();

  return {
    id: overrides.id ?? `evt_${hexDigits(16, ordinal)}`,
    traceId: overrides.traceId ?? DEFAULT_TRACE_ID,
    spanId: overrides.spanId,
    ...(overrides.parentSpanId !== undefined ? { parentSpanId: overrides.parentSpanId } : {}),
    kind,
    name: overrides.name ?? `span-${overrides.spanId}`,
    startTime: overrides.startTime ?? BASE_TIME,
    duration: overrides.duration ?? DEFAULT_DURATION_MS,
    tier: overrides.tier ?? firstAllowedTier(kind),
    attributes: overrides.attributes ?? {},
    status: overrides.status ?? 'ok',
    producerId: overrides.producerId ?? BROWSER_PRODUCER,
    seq: overrides.seq ?? ordinal,
    ...(overrides.source !== undefined ? { source: overrides.source } : {}),
    ...(overrides.redacted !== undefined ? { redacted: [...overrides.redacted] } : {}),
    sessionId: overrides.sessionId ?? SESSION_ID,
    captureId: overrides.captureId ?? CAPTURE_ID,
    ingestSeq: overrides.ingestSeq ?? ordinal,
  };
}

/** One level of a nested chain: what it is, when it ran, and who emitted it. */
interface ChainStep {
  /** The kind this level reports. */
  readonly kind: TelemetryKind;
  /** Its tier; defaults to the first the kind/tier table permits. */
  readonly tier?: TelemetryTier;
  /** Start offset in milliseconds from {@link BASE_TIME}. */
  readonly offsetMs: number;
  /** Wall duration in milliseconds. */
  readonly durationMs: number;
  /** The producer that emitted it; defaults to the browser agent. */
  readonly producerId?: ProducerId;
}

/**
 * A strictly nested chain: each step becomes the child of the step before it.
 *
 * @param steps The levels, outermost first.
 * @returns One event per step, in that same (outermost-first) order.
 */
function chainEvents(steps: readonly ChainStep[]): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  let parentSpanId: SpanId | undefined;

  for (const step of steps) {
    const spanId = nextSpanId();
    events.push(
      makeEvent({
        spanId,
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
        kind: step.kind,
        ...(step.tier !== undefined ? { tier: step.tier } : {}),
        startTime: at(step.offsetMs),
        duration: step.durationMs,
        producerId: step.producerId ?? BROWSER_PRODUCER,
      }),
    );
    parentSpanId = spanId;
  }

  return events;
}

/**
 * A chain of `length` levels: an `interaction` root and `function` descendants,
 * each one millisecond after the last.
 *
 * Used by the depth-guard and deep-traversal cases, where the *shape* is the
 * subject and the kinds are incidental.
 *
 * @param length How many levels to build.
 * @returns The events, outermost first.
 */
function linearChain(length: number): TelemetryEvent[] {
  const steps: ChainStep[] = [];
  for (let index = 0; index < length; index += 1) {
    steps.push({
      kind: index === 0 ? 'interaction' : DEFAULT_KIND,
      offsetMs: index,
      durationMs: length - index,
    });
  }
  return chainEvents(steps);
}

/**
 * A seeded permutation of `items`: a Fisher–Yates shuffle driven by a linear
 * congruential generator, so "any input order" is a *reproducible* order.
 *
 * `Math.random` is never used anywhere in this file: a permutation case that
 * failed only on some runs would be worse than no case at all, because the
 * property under test — that arrival order is unobservable — is exactly the one
 * a flaky test would teach a reader to ignore.
 *
 * @param items The array to permute; never modified.
 * @param seed Any non-zero 32-bit seed.
 * @returns A new array holding the same elements in a shuffled order.
 */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const permuted = [...items];
  let state = seed >>> 0 || 1;

  for (let index = permuted.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    const high = permuted[index];
    const low = permuted[target];
    if (high === undefined || low === undefined) {
      // Unreachable for a dense array; the check is what lets both elements be
      // used without a non-null assertion.
      continue;
    }
    permuted[index] = low;
    permuted[target] = high;
  }

  return permuted;
}

/** The span ids of `events`, in the order given. */
function spanIdsOfEvents(events: readonly TelemetryEvent[]): SpanId[] {
  return events.map((event) => event.spanId);
}

/** The span ids of `nodes`, in the order given. */
function spanIdsOfNodes(nodes: readonly TraceNode[]): SpanId[] {
  return nodes.map((node) => node.event.spanId);
}

/**
 * The one trace `events` describes, or a failure naming what came back instead.
 *
 * Every single-trace case goes through this rather than indexing `traces[0]`,
 * so a regression that split one trace into two fails with that sentence rather
 * than with a `TypeError` on `undefined`.
 *
 * @param result A correlation of events that all share one trace id.
 * @returns That trace's tree.
 */
function onlyTrace(result: CorrelationResult): TraceTree {
  expect(result.traceCount).toBe(1);
  const [trace] = result.traces;
  if (trace === undefined) {
    throw new Error('expected exactly one correlated trace');
  }
  return trace;
}

/**
 * The node carrying `spanId`, or a failure naming the span that went missing.
 *
 * @param tree The tree to search.
 * @param spanId The span to find.
 * @returns That node.
 */
function nodeFor(tree: TraceTree, spanId: SpanId): TraceNode {
  const node = findNodeBySpanId(tree, spanId);
  if (node === undefined) {
    throw new Error(`expected span ${spanId} to be present in trace ${tree.traceId}`);
  }
  return node;
}

/**
 * The primary root of `tree`, or a failure naming the anchor that went missing.
 *
 * @param tree The tree to read.
 * @returns The node `primaryRootSpanId` names.
 */
function primaryRootOf(tree: TraceTree): TraceNode {
  const { primaryRootSpanId } = tree;
  if (primaryRootSpanId === undefined) {
    throw new Error(`expected trace ${tree.traceId} to name a primary root`);
  }
  return nodeFor(tree, primaryRootSpanId);
}

/**
 * The "nothing was dropped" check, in the two forms that together are the
 * proof: the result counts every event it was handed, and every one of those
 * events reached a node in some tree (AAP §0.4.2).
 *
 * @param result The correlation to audit.
 * @param events The events it was given.
 */
function expectNothingDropped(result: CorrelationResult, events: readonly TelemetryEvent[]): void {
  expect(result.eventCount).toBe(events.length);

  const placed = result.traces.reduce((total, trace) => total + trace.nodeCount, 0);
  expect(placed).toBe(events.length);

  const placedSpanIds = result.traces.flatMap((trace) =>
    flattenTrace(trace).map((node) => node.event.id),
  );
  expect([...placedSpanIds].sort()).toEqual([...events.map((event) => event.id)].sort());
}

/**
 * A sample built to tie at **every** level of the canonical order: two
 * producers inside one millisecond, one producer inside one millisecond with
 * different `seq`, one producer repeating a `seq` so only `ingestSeq`
 * separates the pair, and two events whose timestamps settle it outright.
 *
 * Returned in a deliberately non-canonical order, so a case that sorts it is
 * doing work.
 *
 * @returns Six events with no two of them tying on every key.
 */
function mixedTieSample(): TelemetryEvent[] {
  const tiedInstant = at(5.125);

  return [
    makeEvent({ spanId: nextSpanId(), startTime: at(9), seq: 0, ingestSeq: 1 }),
    makeEvent({
      spanId: nextSpanId(),
      startTime: tiedInstant,
      producerId: SERVER_PRODUCER,
      seq: 0,
      ingestSeq: 2,
    }),
    makeEvent({
      spanId: nextSpanId(),
      startTime: tiedInstant,
      producerId: BROWSER_PRODUCER,
      seq: 4,
      ingestSeq: 3,
    }),
    makeEvent({
      spanId: nextSpanId(),
      startTime: tiedInstant,
      producerId: BROWSER_PRODUCER,
      seq: 2,
      ingestSeq: 4,
    }),
    makeEvent({
      spanId: nextSpanId(),
      startTime: tiedInstant,
      producerId: BROWSER_PRODUCER,
      seq: 2,
      ingestSeq: 5,
    }),
    makeEvent({ spanId: nextSpanId(), startTime: at(1), seq: 7, ingestSeq: 6 }),
  ];
}

/*
 * ---------------------------------------------------------------------------
 * The harness's own guarantees
 *
 * Every case below rests on these three, so they are asserted rather than
 * assumed: a fixture the persisted schema would reject, or a "shuffle" that
 * returned its input, would make a passing suite meaningless.
 * ---------------------------------------------------------------------------
 */

describe('the fixture harness', () => {
  it('mints schema-shaped trace and span identifiers', () => {
    expect(hexTrace(1)).toHaveLength(32);
    expect(hexSpan(1)).toHaveLength(16);
    expect(hexTrace(255)).toBe('000000000000000000000000000000ff');
    expect(hexSpan(255)).toBe('00000000000000ff');
    expect(isTraceId(hexTrace(1))).toBe(true);
    expect(isTraceId(hexTrace(0xdead_beef))).toBe(true);
    expect(isSpanId(hexSpan(1))).toBe(true);
    expect(isSpanId(hexSpan(0xfeed_face))).toBe(true);
  });

  it('builds an event the persisted schema accepts for every kind in the vocabulary', () => {
    expect(TELEMETRY_KINDS).toHaveLength(17);

    for (const kind of TELEMETRY_KINDS) {
      const event = makeEvent({ spanId: nextSpanId(), kind });
      expect(isTelemetryEvent(event)).toBe(true);
      expect(event.kind).toBe(kind);
      expect(event.tier).toBe(firstAllowedTier(kind));
    }
  });

  it('permutes deterministically, reorders, and leaves the caller array alone', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    const permuted = shuffle(items, 7);
    expect(shuffle(items, 7)).toEqual(permuted);
    expect(permuted).not.toEqual(items);
    expect(shuffle(items, 11)).not.toEqual(permuted);
    expect([...permuted].sort((left, right) => left - right)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Canonical ordering (AAP 0.2.3)
 * ---------------------------------------------------------------------------
 */

describe('compareEventsCanonical', () => {
  it('orders by startTime first, whatever the later keys would say', () => {
    const later = makeEvent({ spanId: nextSpanId(), startTime: at(10), seq: 1, ingestSeq: 1 });
    const earlier = makeEvent({ spanId: nextSpanId(), startTime: at(2), seq: 99, ingestSeq: 99 });

    expect(compareEventsCanonical(earlier, later)).toBeLessThan(0);
    expect(compareEventsCanonical(later, earlier)).toBeGreaterThan(0);
    expect(spanIdsOfEvents(sortEventsCanonical([later, earlier]))).toEqual([
      earlier.spanId,
      later.spanId,
    ]);
  });

  it('separates a browser-agent and a Node-preload event that share the identical epoch millisecond', () => {
    // AAP 0.2.3's mandated case: the two producers read different clocks and
    // routinely land on the same double. `producerId` is the only key that
    // separates them, and both of the later keys point the other way here, so
    // nothing but the documented order can make this pass.
    const sameInstant = at(8.25);
    const fromBrowser = makeEvent({
      spanId: nextSpanId(),
      kind: 'fetch',
      startTime: sameInstant,
      producerId: BROWSER_PRODUCER,
      seq: 9,
      ingestSeq: 41,
    });
    const fromPreload = makeEvent({
      spanId: nextSpanId(),
      kind: 'http.server',
      startTime: sameInstant,
      producerId: SERVER_PRODUCER,
      seq: 0,
      ingestSeq: 40,
    });

    expect(fromBrowser.startTime).toBe(fromPreload.startTime);
    expect(BROWSER_PRODUCER < SERVER_PRODUCER).toBe(true);

    expect(compareEventsCanonical(fromBrowser, fromPreload)).toBeLessThan(0);
    expect(compareEventsCanonical(fromPreload, fromBrowser)).toBeGreaterThan(0);
    expect(spanIdsOfEvents(sortEventsCanonical([fromBrowser, fromPreload]))).toEqual([
      fromBrowser.spanId,
      fromPreload.spanId,
    ]);
    expect(spanIdsOfEvents(sortEventsCanonical([fromPreload, fromBrowser]))).toEqual([
      fromBrowser.spanId,
      fromPreload.spanId,
    ]);
  });

  it('falls through to seq for one producer inside a millisecond', () => {
    const sameInstant = at(3.5);
    const second = makeEvent({
      spanId: nextSpanId(),
      startTime: sameInstant,
      seq: 12,
      ingestSeq: 5,
    });
    const first = makeEvent({
      spanId: nextSpanId(),
      startTime: sameInstant,
      seq: 11,
      ingestSeq: 6,
    });

    // `ingestSeq` would invert this pair, so only the documented key order
    // yields the emission order the producer's counter recorded.
    expect(compareEventsCanonical(first, second)).toBeLessThan(0);
    expect(compareEventsCanonical(second, first)).toBeGreaterThan(0);
    expect(spanIdsOfEvents(sortEventsCanonical([second, first]))).toEqual([
      first.spanId,
      second.spanId,
    ]);
  });

  it('falls through to ingestSeq when one producer repeats a sequence number', () => {
    const sameInstant = at(4);
    const late = makeEvent({ spanId: nextSpanId(), startTime: sameInstant, seq: 7, ingestSeq: 92 });
    const early = makeEvent({
      spanId: nextSpanId(),
      startTime: sameInstant,
      seq: 7,
      ingestSeq: 91,
    });

    expect(compareEventsCanonical(early, late)).toBeLessThan(0);
    expect(compareEventsCanonical(late, early)).toBeGreaterThan(0);
    expect(spanIdsOfEvents(sortEventsCanonical([late, early]))).toEqual([
      early.spanId,
      late.spanId,
    ]);
  });

  it('is a total order: antisymmetric, transitive, and zero only for an identical event', () => {
    const sample = mixedTieSample();

    for (const left of sample) {
      expect(compareEventsCanonical(left, left)).toBe(0);

      for (const right of sample) {
        const forward = compareEventsCanonical(left, right);
        const backward = compareEventsCanonical(right, left);
        // Antisymmetry, stated as a sum so that the two zeros of the tie case
        // do not turn into a `0` versus `-0` comparison.
        expect(Math.sign(forward) + Math.sign(backward)).toBe(0);

        if (left !== right) {
          expect(forward).not.toBe(0);
        }
      }
    }

    // Sorting proves transitivity: in a total order every earlier element
    // compares strictly before every later one, not merely before its
    // neighbour.
    const ordered = sortEventsCanonical(sample);
    expect(ordered).toHaveLength(sample.length);

    for (let index = 0; index < ordered.length; index += 1) {
      const left = ordered[index];
      if (left === undefined) {
        throw new Error('the sorted sample is dense by construction');
      }

      for (let other = index + 1; other < ordered.length; other += 1) {
        const right = ordered[other];
        if (right === undefined) {
          throw new Error('the sorted sample is dense by construction');
        }
        expect(compareEventsCanonical(left, right)).toBeLessThan(0);
      }
    }
  });

  it('sorts every permutation of one sample into the same sequence', () => {
    const sample = mixedTieSample();
    const canonical = spanIdsOfEvents(sortEventsCanonical(sample));

    expect(spanIdsOfEvents(sortEventsCanonical([...sample].reverse()))).toEqual(canonical);
    for (const seed of [3, 29, 101, 7919]) {
      expect(spanIdsOfEvents(sortEventsCanonical(shuffle(sample, seed)))).toEqual(canonical);
    }
  });
});

describe('sortEventsCanonical', () => {
  it('returns a new array and leaves the caller array untouched', () => {
    const first = makeEvent({ spanId: nextSpanId(), startTime: at(30) });
    const second = makeEvent({ spanId: nextSpanId(), startTime: at(10) });
    const third = makeEvent({ spanId: nextSpanId(), startTime: at(20) });
    const input = [first, second, third];
    const asGiven = spanIdsOfEvents(input);

    const sorted = sortEventsCanonical(input);

    expect(sorted).not.toBe(input);
    expect(spanIdsOfEvents(sorted)).toEqual([second.spanId, third.spanId, first.spanId]);
    expect(spanIdsOfEvents(input)).toEqual(asGiven);
    expect(input[0]).toBe(first);
  });
});

describe('sibling order and structural nesting', () => {
  it('orders siblings by the canonical comparator rather than by arrival', () => {
    const root = makeEvent({
      spanId: nextSpanId(),
      kind: 'interaction',
      startTime: at(0),
      duration: 40,
    });
    const last = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: root.spanId,
      kind: 'render',
      startTime: at(20),
    });
    const tiedPreload = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: root.spanId,
      kind: 'http.server',
      startTime: at(10),
      producerId: SERVER_PRODUCER,
      seq: 0,
      ingestSeq: 3,
    });
    const tiedBrowser = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: root.spanId,
      kind: 'fetch',
      startTime: at(10),
      producerId: BROWSER_PRODUCER,
      seq: 5,
      ingestSeq: 9,
    });

    const tree = onlyTrace(correlateEvents([last, tiedPreload, tiedBrowser, root]));
    const rootNode = primaryRootOf(tree);

    expect(rootNode.event.spanId).toBe(root.spanId);
    expect(spanIdsOfNodes(rootNode.children)).toEqual([
      tiedBrowser.spanId,
      tiedPreload.spanId,
      last.spanId,
    ]);
  });

  it('keeps a child after its parent even when the child is timestamped first', () => {
    // The preload's clock reads three milliseconds behind the agent's, which
    // AAP 0.2.3 records rather than corrects. Structure is causality; the
    // timestamp is only a sibling tie-break.
    const parent = makeEvent({
      spanId: nextSpanId(),
      kind: 'fetch',
      startTime: at(10),
      duration: 20,
    });
    const child = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: parent.spanId,
      kind: 'http.server',
      startTime: at(7),
      duration: 12,
      producerId: SERVER_PRODUCER,
    });

    expect(compareEventsCanonical(child, parent)).toBeLessThan(0);

    const tree = onlyTrace(correlateEvents([parent, child]));

    expect(spanIdsOfNodes(flattenTrace(tree))).toEqual([parent.spanId, child.spanId]);
    expect(nodeFor(tree, child.spanId).depth).toBe(1);
    expect(nodeFor(tree, child.spanId).orphaned).toBe(false);
    // The tree's window still opens at the earliest timestamp it holds.
    expect(tree.startTime).toBe(child.startTime);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Nesting: the chain the end-to-end suite asserts (AAP 0.8.3, 0.8.4)
 * ---------------------------------------------------------------------------
 */

/**
 * The six levels of AAP 0.8.4's acceptance test 1, as one strictly nested
 * chain: a browser interaction, the `fetch` it issued, the framework's request
 * span, its route-handler span, a named service function a reversible patch
 * timed, and the SQL that function ran.
 *
 * Two producers contribute — the page agent for the first two levels, the
 * dev-server preload for the last four — and the timings are the plan's own
 * (the click at 0 ms, the request at 8 ms, the query at 18 ms running for
 * 640 ms, the whole interaction 1175 ms), so the window assertions are about
 * a shape a developer would actually see.
 *
 * @returns The six events, outermost first. Fresh span ids on every call.
 */
function crossTierChain(): TelemetryEvent[] {
  return chainEvents([
    { kind: 'interaction', offsetMs: 0, durationMs: 1175, producerId: BROWSER_PRODUCER },
    { kind: 'fetch', offsetMs: 8, durationMs: 1112, producerId: BROWSER_PRODUCER },
    { kind: 'http.server', offsetMs: 12, durationMs: 1100, producerId: SERVER_PRODUCER },
    { kind: 'route.handler', offsetMs: 12, durationMs: 1090, producerId: SERVER_PRODUCER },
    {
      kind: 'function',
      tier: 'server',
      offsetMs: 15,
      durationMs: 660,
      producerId: SERVER_PRODUCER,
    },
    { kind: 'db.query', offsetMs: 18, durationMs: 640, producerId: SERVER_PRODUCER },
  ]);
}

/**
 * Asserts the pre-order property every consumer relies on: in
 * `flattenTrace`'s output, a node never precedes its own parent.
 *
 * Checked through `walkTrace`'s `parent` argument rather than by re-deriving
 * parentage from span ids, so the two traversals are asserted to agree.
 *
 * @param tree The tree to audit.
 */
function expectParentsBeforeChildren(tree: TraceTree): void {
  const flat = flattenTrace(tree);
  const positions = new Map<TraceNode, number>();
  flat.forEach((node, index) => {
    positions.set(node, index);
  });

  walkTrace(tree, (node, parent) => {
    if (parent === undefined) {
      return;
    }

    const childPosition = positions.get(node);
    const parentPosition = positions.get(parent);
    if (childPosition === undefined || parentPosition === undefined) {
      throw new Error('walkTrace visited a node flattenTrace did not return');
    }
    expect(parentPosition).toBeLessThan(childPosition);
  });
}

describe('the correlated chain across tiers', () => {
  it('resolves a shuffled six-level chain into one strictly nested tree', () => {
    const events = crossTierChain();
    const chainSpanIds = spanIdsOfEvents(events);
    const shuffled = shuffle(events, 4_242);
    expect(spanIdsOfEvents(shuffled)).not.toEqual(chainSpanIds);

    const result = correlateEvents(shuffled);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(tree.traceId).toBe(DEFAULT_TRACE_ID);
    expect(tree.roots).toHaveLength(1);
    expect(spanIdsOfNodes(tree.roots)).toEqual([chainSpanIds[0]]);
    expect(tree.primaryRootSpanId).toBe(chainSpanIds[0]);
    expect(primaryRootOf(tree).event.kind).toBe('interaction');
    expect(tree.nodeCount).toBe(6);
    expect(tree.maxDepth).toBe(5);
    expect(tree.orphanCount).toBe(0);
    expect(result.orphanCount).toBe(0);
    expect(tree.truncated).toBe(false);
    expect(tree.duplicateSpanIds).toEqual([]);

    // Every level carries exactly one child except the query at the bottom,
    // and depth counts the levels rather than the arrival order.
    const flat = flattenTrace(tree);
    expect(spanIdsOfNodes(flat)).toEqual(chainSpanIds);
    expect(flat.map((node) => node.children.length)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(flat.map((node) => node.depth)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(flat.map((node) => node.orphaned)).toEqual([false, false, false, false, false, false]);
  });

  it('reports the query span ancestry root-first, one ancestor per tier boundary', () => {
    const events = crossTierChain();
    const chainSpanIds = spanIdsOfEvents(events);
    const rootSpanId = chainSpanIds.at(0);
    const querySpanId = chainSpanIds.at(-1);
    if (rootSpanId === undefined || querySpanId === undefined) {
      throw new Error('the chain builder returns six levels');
    }

    const tree = onlyTrace(correlateEvents(shuffle(events, 99)));

    expect(spanIdsOfNodes(ancestorsOfSpanId(tree, querySpanId))).toEqual(chainSpanIds.slice(0, 5));
    // The root has no ancestors, and a span the trace never carried has none
    // either — asking about an absent span is an ordinary answer, not an error.
    expect(ancestorsOfSpanId(tree, rootSpanId)).toEqual([]);
    expect(ancestorsOfSpanId(tree, nextSpanId())).toEqual([]);
  });

  it('walks every node exactly once with the parent that placed it', () => {
    const events = crossTierChain();
    const chainSpanIds = spanIdsOfEvents(events);
    const tree = onlyTrace(correlateEvents(shuffle(events, 17)));

    const visited: [SpanId, SpanId | undefined][] = [];
    walkTrace(tree, (node, parent) => {
      visited.push([node.event.spanId, parent?.event.spanId]);
    });

    expect(visited).toEqual([
      [chainSpanIds[0], undefined],
      [chainSpanIds[1], chainSpanIds[0]],
      [chainSpanIds[2], chainSpanIds[1]],
      [chainSpanIds[3], chainSpanIds[2]],
      [chainSpanIds[4], chainSpanIds[3]],
      [chainSpanIds[5], chainSpanIds[4]],
    ]);
    expectParentsBeforeChildren(tree);
  });

  it('summarises the tiers, kinds and producers in vocabulary order', () => {
    const events = crossTierChain();
    const tree = onlyTrace(correlateEvents(shuffle(events, 31)));

    const tiersPresent = new Set<TelemetryTier>(events.map((event) => event.tier));
    const kindsPresent = new Set<TelemetryKind>(events.map((event) => event.kind));

    // The chain spans every tier the product observes, so the expectation is
    // the whole tuple, read from the vocabulary rather than restated.
    expect(tiersPresent.size).toBe(TELEMETRY_TIERS.length);
    expect(tree.tiers).toEqual([...TELEMETRY_TIERS]);
    expect(tree.kinds).toEqual(TELEMETRY_KINDS.filter((kind) => kindsPresent.has(kind)));
    expect(tree.kinds).toHaveLength(6);
    expect(tree.producerIds).toEqual([BROWSER_PRODUCER, SERVER_PRODUCER]);
  });

  it('opens its window at the earliest start and closes it at the latest end', () => {
    const events = crossTierChain();
    const tree = onlyTrace(correlateEvents(shuffle(events, 55)));

    const starts = events.map((event) => event.startTime);
    const ends = events.map((event) => event.startTime + event.duration);

    expect(tree.startTime).toBe(Math.min(...starts));
    expect(tree.endTime).toBe(Math.max(...ends));
    expect(tree.startTime).toBe(at(0));
    expect(tree.endTime).toBe(at(1175));
    expect(tree.totalDuration).toBe(1175);

    // The root's own end is the widest of the chain, so the tree window and
    // the root's window coincide here — which is what makes a timeline's
    // percentage scale meaningful.
    expect(nodeEndTime(primaryRootOf(tree))).toBe(tree.endTime);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Permutation invariance and incremental correlation (AAP 0.4.2)
 * ---------------------------------------------------------------------------
 */

describe('permutation invariance', () => {
  it('produces deeply equal traces for the sorted, reversed and shuffled input', () => {
    const events = crossTierChain();

    const sorted = correlateEvents(sortEventsCanonical(events));
    const reversed = correlateEvents([...events].reverse());

    expect(reversed.traces).toEqual(sorted.traces);
    for (const seed of [2, 137, 6_007]) {
      expect(correlateEvents(shuffle(events, seed)).traces).toEqual(sorted.traces);
    }
  });

  it('nests a child whose parent arrives later in the same batch', () => {
    // The service re-correlates the whole capture as each batch lands, so the
    // server's request span routinely reaches the store before the browser's
    // fetch span that caused it. Batch-wide resolution, not streaming.
    const interaction = makeEvent({
      spanId: nextSpanId(),
      kind: 'interaction',
      startTime: at(0),
      duration: 60,
    });
    const request = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: interaction.spanId,
      kind: 'fetch',
      startTime: at(4),
      duration: 40,
    });
    const server = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: request.spanId,
      kind: 'http.server',
      startTime: at(6),
      duration: 30,
      producerId: SERVER_PRODUCER,
    });

    const lateParentFirst = [server, interaction, request];
    const result = correlateEvents(lateParentFirst);
    const tree = onlyTrace(result);

    expectNothingDropped(result, lateParentFirst);
    expect(tree.orphanCount).toBe(0);
    expect(spanIdsOfNodes(flattenTrace(tree))).toEqual([
      interaction.spanId,
      request.spanId,
      server.spanId,
    ]);
    expect(nodeFor(tree, server.spanId).depth).toBe(2);
    expect(nodeFor(tree, server.spanId).orphaned).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Orphan attachment: nothing is dropped (AAP 0.4.2)
 * ---------------------------------------------------------------------------
 */

/** The orphan reasons present in `tree`, unique and sorted. */
function orphanReasonsIn(tree: TraceTree): string[] {
  const reasons = new Set<string>();
  for (const node of flattenTrace(tree)) {
    if (node.orphanReason !== undefined) {
      reasons.add(node.orphanReason);
    }
  }
  return [...reasons].sort();
}

/** The nodes of `tree` that were re-attached, in `flattenTrace` order. */
function orphanNodesIn(tree: TraceTree): TraceNode[] {
  return flattenTrace(tree).filter((node) => node.orphaned);
}

describe('orphan attachment', () => {
  it('re-attaches a server span whose browser parent never arrived', () => {
    const neverArrives = nextSpanId();
    const interaction = makeEvent({
      spanId: nextSpanId(),
      kind: 'interaction',
      startTime: at(0),
      duration: 50,
    });
    const server = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: neverArrives,
      kind: 'http.server',
      startTime: at(5),
      duration: 20,
      producerId: SERVER_PRODUCER,
    });
    const events = [interaction, server];

    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(result.orphanCount).toBe(1);
    expect(tree.orphanCount).toBe(1);

    const rootNode = primaryRootOf(tree);
    expect(rootNode.event.spanId).toBe(interaction.spanId);
    expect(rootNode.orphaned).toBe(false);
    expect(rootNode.orphanReason).toBeUndefined();
    expect(spanIdsOfNodes(rootNode.children)).toEqual([server.spanId]);

    const orphan = nodeFor(tree, server.spanId);
    expect(orphan.orphaned).toBe(true);
    expect(orphan.orphanReason).toBe('missing-parent');
    expect(orphan.missingParentSpanId).toBe(neverArrives);
    expect(orphan.depth).toBe(1);
    // The span it named is genuinely absent: repair, not misplacement.
    expect(findNodeBySpanId(tree, neverArrives)).toBeUndefined();
  });

  it('anchors a trace whose every event names a parent that never arrived', () => {
    const firstMissing = nextSpanId();
    const secondMissing = nextSpanId();
    const thirdMissing = nextSpanId();

    // Deliberately in descending time order, so "the canonically first event"
    // cannot be confused with "the first element of the array".
    const latest = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: firstMissing,
      kind: 'render',
      startTime: at(9),
    });
    const middle = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: secondMissing,
      kind: 'state',
      startTime: at(6),
    });
    const earliest = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: thirdMissing,
      kind: 'commit',
      startTime: at(3),
    });
    const events = [latest, middle, earliest];

    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(tree.roots).toHaveLength(1);
    expect(tree.primaryRootSpanId).toBe(earliest.spanId);

    const anchor = primaryRootOf(tree);
    expect(anchor.event.spanId).toBe(earliest.spanId);
    // The anchor keeps its own flag: it was repaired, not discovered.
    expect(anchor.orphaned).toBe(true);
    expect(anchor.orphanReason).toBe('missing-parent');
    expect(anchor.missingParentSpanId).toBe(thirdMissing);
    expect(anchor.depth).toBe(0);

    expect(spanIdsOfNodes(anchor.children)).toEqual([middle.spanId, latest.spanId]);
    expect(anchor.children.map((node) => node.orphanReason)).toEqual([
      'missing-parent',
      'missing-parent',
    ]);
    expect(anchor.children.map((node) => node.missingParentSpanId)).toEqual([
      secondMissing,
      firstMissing,
    ]);
    expect(tree.orphanCount).toBe(3);
  });

  it('anchors a trace on the most root-like of two genuine roots', () => {
    const neverArrives = nextSpanId();
    // The request span starts first; the interaction is the more root-like
    // kind. The ranking decides, not the clock.
    const server = makeEvent({
      spanId: nextSpanId(),
      kind: 'http.server',
      startTime: at(0),
      duration: 10,
      producerId: SERVER_PRODUCER,
    });
    const interaction = makeEvent({
      spanId: nextSpanId(),
      kind: 'interaction',
      startTime: at(5),
      duration: 40,
    });
    const strandedQuery = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: neverArrives,
      kind: 'db.query',
      startTime: at(7),
      duration: 3,
      producerId: SERVER_PRODUCER,
    });
    const events = [server, interaction, strandedQuery];

    expect(rootAffinityForKind('interaction')).toBeGreaterThan(rootAffinityForKind('http.server'));

    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    // Both genuine roots are kept, in canonical order — the earlier request
    // span first — while the anchor is the interaction.
    expect(spanIdsOfNodes(tree.roots)).toEqual([server.spanId, interaction.spanId]);
    expect(tree.primaryRootSpanId).toBe(interaction.spanId);

    const anchor = primaryRootOf(tree);
    expect(spanIdsOfNodes(anchor.children)).toEqual([strandedQuery.spanId]);
    expect(nodeFor(tree, server.spanId).children).toEqual([]);
    expect(nodeFor(tree, strandedQuery.spanId).orphanReason).toBe('missing-parent');
    expect(tree.orphanCount).toBe(1);
  });

  it('repairs an event that names itself as its own parent', { timeout: 2_000 }, () => {
    const interaction = makeEvent({
      spanId: nextSpanId(),
      kind: 'interaction',
      startTime: at(0),
      duration: 30,
    });
    const selfSpanId = nextSpanId();
    const selfReferential = makeEvent({
      spanId: selfSpanId,
      parentSpanId: selfSpanId,
      kind: 'function',
      startTime: at(4),
      duration: 6,
    });
    const events = [interaction, selfReferential];

    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    const repaired = nodeFor(tree, selfReferential.spanId);
    expect(repaired.orphaned).toBe(true);
    expect(repaired.orphanReason).toBe('self-parent');
    // `self-parent` records no missing span: the parent it named is present,
    // it is simply the node itself.
    expect(repaired.missingParentSpanId).toBeUndefined();
    expect(repaired.depth).toBe(1);
    expect(repaired.children).toEqual([]);
    expect(spanIdsOfNodes(primaryRootOf(tree).children)).toEqual([selfReferential.spanId]);
    expect(tree.orphanCount).toBe(1);
  });

  it(
    'terminates on a two-node parentage cycle and cuts it deterministically',
    { timeout: 2_000 },
    () => {
      const firstSpanId = nextSpanId();
      const secondSpanId = nextSpanId();
      const first = makeEvent({
        spanId: firstSpanId,
        parentSpanId: secondSpanId,
        kind: 'function',
        startTime: at(1),
        duration: 5,
      });
      const second = makeEvent({
        spanId: secondSpanId,
        parentSpanId: firstSpanId,
        kind: 'function',
        startTime: at(2),
        duration: 3,
      });
      const events = [first, second];

      const result = correlateEvents(events);
      const tree = onlyTrace(result);

      expectNothingDropped(result, events);
      expect(tree.nodeCount).toBe(2);
      expect(tree.orphanCount).toBe(1);

      // The canonically first member is the one cut, so the same cycle cuts the
      // same way however the batches arrived.
      const cut = primaryRootOf(tree);
      expect(cut.event.spanId).toBe(firstSpanId);
      expect(cut.orphanReason).toBe('cycle');
      expect(cut.missingParentSpanId).toBeUndefined();
      expect(spanIdsOfNodes(cut.children)).toEqual([secondSpanId]);
      expect(nodeFor(tree, secondSpanId).orphaned).toBe(false);

      expect(correlateEvents([second, first]).traces).toEqual(result.traces);
    },
  );

  it(
    'terminates on a three-node parentage cycle and keeps every member',
    { timeout: 2_000 },
    () => {
      const alphaSpanId = nextSpanId();
      const betaSpanId = nextSpanId();
      const gammaSpanId = nextSpanId();
      const alpha = makeEvent({
        spanId: alphaSpanId,
        parentSpanId: gammaSpanId,
        kind: 'function',
        startTime: at(1),
        duration: 9,
      });
      const beta = makeEvent({
        spanId: betaSpanId,
        parentSpanId: alphaSpanId,
        kind: 'function',
        startTime: at(2),
        duration: 6,
      });
      const gamma = makeEvent({
        spanId: gammaSpanId,
        parentSpanId: betaSpanId,
        kind: 'function',
        startTime: at(3),
        duration: 3,
      });
      const events = [alpha, beta, gamma];

      const result = correlateEvents(events);
      const tree = onlyTrace(result);

      expectNothingDropped(result, events);
      expect(tree.nodeCount).toBe(3);
      expect(tree.orphanCount).toBe(1);
      expect(spanIdsOfNodes(flattenTrace(tree))).toEqual([alphaSpanId, betaSpanId, gammaSpanId]);
      expect(flattenTrace(tree).map((node) => node.depth)).toEqual([0, 1, 2]);
      expect(spanIdsOfNodes(orphanNodesIn(tree))).toEqual([alphaSpanId]);
      expect(nodeFor(tree, alphaSpanId).orphanReason).toBe('cycle');

      for (const seed of [13, 271]) {
        expect(correlateEvents(shuffle(events, seed)).traces).toEqual(result.traces);
      }
    },
  );

  it('keeps both events when two of them carry the same span id', () => {
    const sharedSpanId = nextSpanId();
    const interaction = makeEvent({
      spanId: nextSpanId(),
      kind: 'interaction',
      startTime: at(0),
      duration: 20,
    });
    const firstOccurrence = makeEvent({
      spanId: sharedSpanId,
      parentSpanId: interaction.spanId,
      kind: 'render',
      startTime: at(4),
      duration: 2,
    });
    const secondOccurrence = makeEvent({
      spanId: sharedSpanId,
      parentSpanId: interaction.spanId,
      kind: 'render',
      startTime: at(9),
      duration: 2,
    });
    // The later occurrence is handed in first, so "canonically first" cannot
    // be satisfied by reading the array.
    const events = [secondOccurrence, interaction, firstOccurrence];

    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(tree.nodeCount).toBe(3);
    expect(tree.duplicateSpanIds).toEqual([sharedSpanId]);
    expect(tree.orphanCount).toBe(0);

    const rootNode = primaryRootOf(tree);
    expect(rootNode.children).toHaveLength(2);
    expect(rootNode.children.map((node) => node.event.id)).toEqual([
      firstOccurrence.id,
      secondOccurrence.id,
    ]);

    // Lookup answers with the occurrence that owns the children of that id.
    const found = findNodeBySpanId(tree, sharedSpanId);
    if (found === undefined) {
      throw new Error(`expected span ${sharedSpanId} to be present`);
    }
    expect(found.event.id).toBe(firstOccurrence.id);
    expect(found.event.startTime).toBe(at(4));
  });

  it('lifts a chain deeper than the bound to the anchor and reports the truncation', () => {
    const events = linearChain(20);
    const chainSpanIds = spanIdsOfEvents(events);

    const unbounded = onlyTrace(correlateEvents(events));
    expect(unbounded.truncated).toBe(false);
    expect(unbounded.maxDepth).toBe(19);
    expect(unbounded.orphanCount).toBe(0);

    const result = correlateEvents(events, { maxDepth: 5 });
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(tree.truncated).toBe(true);
    expect(tree.maxDepth).toBe(5);

    // The bound is applied per subtree: the node that would have sat at depth
    // six is lifted to the anchor, and the chain continues beneath it.
    const lifted = orphanNodesIn(tree);
    expect(spanIdsOfNodes(lifted)).toEqual([chainSpanIds[6], chainSpanIds[11], chainSpanIds[16]]);
    expect(lifted.map((node) => node.orphanReason)).toEqual([
      'max-depth',
      'max-depth',
      'max-depth',
    ]);
    expect(lifted.map((node) => node.depth)).toEqual([1, 1, 1]);
    expect(tree.orphanCount).toBe(3);

    expect(spanIdsOfNodes(primaryRootOf(tree).children)).toEqual([
      chainSpanIds[1],
      chainSpanIds[6],
      chainSpanIds[11],
      chainSpanIds[16],
    ]);
  });

  it('exercises every reason in the ORPHAN_REASONS vocabulary', () => {
    // The vocabulary is what the two UIs and the event log label a repaired
    // subtree with, so a member no scenario above can produce would be a label
    // nobody could ever see — and a new member added without a producing path
    // fails here rather than shipping unreachable.
    const anchor = (): TelemetryEvent =>
      makeEvent({ spanId: nextSpanId(), kind: 'interaction', startTime: at(0), duration: 40 });

    const absentParent = nextSpanId();
    const missingParentTrace = onlyTrace(
      correlateEvents([
        anchor(),
        makeEvent({
          spanId: nextSpanId(),
          parentSpanId: absentParent,
          kind: 'render',
          startTime: at(1),
        }),
      ]),
    );

    const selfSpanId = nextSpanId();
    const selfParentTrace = onlyTrace(
      correlateEvents([
        anchor(),
        makeEvent({
          spanId: selfSpanId,
          parentSpanId: selfSpanId,
          kind: 'render',
          startTime: at(2),
        }),
      ]),
    );

    const leftSpanId = nextSpanId();
    const rightSpanId = nextSpanId();
    const cycleTrace = onlyTrace(
      correlateEvents([
        makeEvent({
          spanId: leftSpanId,
          parentSpanId: rightSpanId,
          kind: 'function',
          startTime: at(3),
        }),
        makeEvent({
          spanId: rightSpanId,
          parentSpanId: leftSpanId,
          kind: 'function',
          startTime: at(4),
        }),
      ]),
    );

    const depthTrace = onlyTrace(correlateEvents(linearChain(4), { maxDepth: 1 }));

    const observed = new Set<string>([
      ...orphanReasonsIn(missingParentTrace),
      ...orphanReasonsIn(selfParentTrace),
      ...orphanReasonsIn(cycleTrace),
      ...orphanReasonsIn(depthTrace),
    ]);

    expect([...observed].sort()).toEqual([...ORPHAN_REASONS].sort());
  });
});

/*
 * ---------------------------------------------------------------------------
 * Traces, lookup and the panel-data entry point (AAP 0.4.2)
 * ---------------------------------------------------------------------------
 */

/** One trace's worth of events: an interaction and the render it caused. */
function miniTrace(traceId: TraceId, offsetMs: number): TelemetryEvent[] {
  const rootSpanId = nextSpanId();
  return [
    makeEvent({
      spanId: rootSpanId,
      traceId,
      kind: 'interaction',
      startTime: at(offsetMs),
      duration: 10,
    }),
    makeEvent({
      spanId: nextSpanId(),
      traceId,
      parentSpanId: rootSpanId,
      kind: 'render',
      startTime: at(offsetMs + 1),
      duration: 2,
    }),
  ];
}

describe('grouping by trace id', () => {
  it('returns one tree per trace, ascending by start time rather than by id', () => {
    // The trace ids are chosen so their ascending order is the REVERSE of the
    // traces' start order for the first two: an implementation that ordered by
    // id would fail here.
    const firstTraceId = hexTrace(0x30);
    const secondTraceId = hexTrace(0x10);
    const thirdTraceId = hexTrace(0x20);
    const events = [
      ...miniTrace(secondTraceId, 40),
      ...miniTrace(thirdTraceId, 80),
      ...miniTrace(firstTraceId, 5),
    ];

    const result = correlateEvents(shuffle(events, 991));

    expectNothingDropped(result, events);
    expect(result.traceCount).toBe(3);
    expect(result.traces.map((trace) => trace.traceId)).toEqual([
      firstTraceId,
      secondTraceId,
      thirdTraceId,
    ]);
    expect([...result.byTraceId.keys()]).toEqual([firstTraceId, secondTraceId, thirdTraceId]);

    for (const trace of result.traces) {
      expect(result.byTraceId.get(trace.traceId)).toBe(trace);
      expect(trace.nodeCount).toBe(2);
      expect(trace.maxDepth).toBe(1);
      expect(trace.orphanCount).toBe(0);
      expect(flattenTrace(trace).every((node) => node.event.traceId === trace.traceId)).toBe(true);
    }

    expect(result.byTraceId.get(hexTrace(0x99))).toBeUndefined();
  });

  it('correlates one trace out of a mixed list and answers undefined for an absent id', () => {
    const wantedTraceId = hexTrace(0x41);
    const otherTraceId = hexTrace(0x42);
    const wanted = miniTrace(wantedTraceId, 12);
    const events = [...wanted, ...miniTrace(otherTraceId, 30)];

    const scoped = correlateTrace(shuffle(events, 77), wantedTraceId);
    if (scoped === undefined) {
      throw new Error(`expected trace ${wantedTraceId} to correlate`);
    }

    expect(scoped.traceId).toBe(wantedTraceId);
    expect(scoped.nodeCount).toBe(2);
    expect(spanIdsOfNodes(flattenTrace(scoped))).toEqual(spanIdsOfEvents(wanted));
    expect(scoped).toEqual(correlateEvents(events).byTraceId.get(wantedTraceId));

    expect(correlateTrace(events, hexTrace(0x43))).toBeUndefined();
    expect(correlateTrace([], wantedTraceId)).toBeUndefined();
  });

  it('answers an empty capture with empty collections and zero counts', () => {
    const result = correlateEvents([]);

    expect(result.traces).toEqual([]);
    expect(result.byTraceId.size).toBe(0);
    expect(result.traceCount).toBe(0);
    expect(result.eventCount).toBe(0);
    expect(result.orphanCount).toBe(0);
    // A fresh collection each time: a shared empty array would be a
    // module-level object a caller could write into.
    expect(correlateEvents([]).traces).not.toBe(result.traces);
  });
});

describe('subtree traversal helpers', () => {
  it('counts and searches a branching subtree without leaving it', () => {
    const rootSpanId = nextSpanId();
    const commitSpanId = nextSpanId();
    const root = makeEvent({
      spanId: rootSpanId,
      kind: 'interaction',
      startTime: at(0),
      duration: 30,
    });
    const commit = makeEvent({
      spanId: commitSpanId,
      parentSpanId: rootSpanId,
      kind: 'commit',
      startTime: at(2),
      duration: 8,
    });
    const firstRender = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: commitSpanId,
      kind: 'render',
      startTime: at(3),
      duration: 2,
    });
    const secondRender = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: commitSpanId,
      kind: 'render',
      startTime: at(6),
      duration: 1,
    });
    const request = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: rootSpanId,
      kind: 'fetch',
      startTime: at(12),
      duration: 9,
    });
    const events = [root, commit, firstRender, secondRender, request];

    const result = correlateEvents(shuffle(events, 8_191));
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(tree.nodeCount).toBe(5);
    expect(tree.maxDepth).toBe(2);

    const rootNode = primaryRootOf(tree);
    const commitNode = nodeFor(tree, commitSpanId);
    const requestNode = nodeFor(tree, request.spanId);

    expect(spanIdsOfNodes(rootNode.children)).toEqual([commitSpanId, request.spanId]);
    expect(subtreeNodeCount(rootNode)).toBe(5);
    expect(subtreeNodeCount(commitNode)).toBe(3);
    expect(subtreeNodeCount(requestNode)).toBe(1);

    expect(spanIdsOfNodes(flattenNode(commitNode))).toEqual([
      commitSpanId,
      firstRender.spanId,
      secondRender.spanId,
    ]);

    const foundInCommit = findNodeInSubtree(commitNode, secondRender.spanId);
    if (foundInCommit === undefined) {
      throw new Error('expected the second render inside the commit subtree');
    }
    expect(foundInCommit.event.id).toBe(secondRender.id);
    // Scoped, not global: the render is in the tree but not in this subtree.
    expect(findNodeInSubtree(requestNode, secondRender.spanId)).toBeUndefined();
    expect(findNodeInSubtree(commitNode, rootSpanId)).toBeUndefined();

    // The kind list follows the vocabulary's declaration order, which here is
    // neither the input order nor the tree order (`commit` precedes `render`
    // in the tree and follows it in the vocabulary).
    const kindsPresent = new Set<TelemetryKind>(events.map((event) => event.kind));
    expect(tree.kinds).toEqual(TELEMETRY_KINDS.filter((kind) => kindsPresent.has(kind)));
    expect(tree.kinds).toEqual(['interaction', 'render', 'commit', 'fetch']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Node timing: total time versus self time
 *
 * The difference is what a flame view draws and what "where did the time go"
 * means in an analysis: a parent that awaited two requests in parallel spent
 * the union of their windows waiting, not the sum, and a child whose clock ran
 * past its parent's end cannot subtract time the parent never held.
 * ---------------------------------------------------------------------------
 */

/**
 * Correlates a parent and its children and returns the parent's node.
 *
 * @param parent The parent event.
 * @param children Its children, already naming it as their parent.
 * @returns The parent's node, with its children attached.
 */
function parentNodeOf(parent: TelemetryEvent, children: readonly TelemetryEvent[]): TraceNode {
  const events = [...children, parent];
  const result = correlateEvents(events);
  const tree = onlyTrace(result);
  expectNothingDropped(result, events);
  return nodeFor(tree, parent.spanId);
}

describe('node timing helpers', () => {
  it('reports the end time and the total time of one node', () => {
    const parent = makeEvent({
      spanId: nextSpanId(),
      kind: 'interaction',
      startTime: at(4),
      duration: 12.5,
    });
    const node = parentNodeOf(parent, []);

    expect(nodeEndTime(node)).toBe(at(16.5));
    expect(totalTimeOf(node)).toBe(12.5);
    // A leaf spent all of its time in itself.
    expect(selfTimeOf(node)).toBe(totalTimeOf(node));
  });

  it('subtracts two sequential children from the parent total', () => {
    const parentSpanId = nextSpanId();
    const parent = makeEvent({
      spanId: parentSpanId,
      kind: 'interaction',
      startTime: at(0),
      duration: 100,
    });
    const node = parentNodeOf(parent, [
      makeEvent({
        spanId: nextSpanId(),
        parentSpanId,
        kind: 'fetch',
        startTime: at(10),
        duration: 30,
      }),
      makeEvent({
        spanId: nextSpanId(),
        parentSpanId,
        kind: 'fetch',
        startTime: at(50),
        duration: 20,
      }),
    ]);

    expect(totalTimeOf(node)).toBe(100);
    expect(selfTimeOf(node)).toBe(50);
  });

  it('subtracts the union, not the sum, of two parallel children', () => {
    // AAP 0.4.2's parallel-request case: one interaction issues two requests
    // at once. Summing them would claim 40 ms of self time out of 100 ms with
    // 30 ms of waiting, and a deeper fan-out would go negative.
    const parentSpanId = nextSpanId();
    const parent = makeEvent({
      spanId: parentSpanId,
      kind: 'interaction',
      startTime: at(0),
      duration: 100,
    });
    const node = parentNodeOf(parent, [
      makeEvent({
        spanId: nextSpanId(),
        parentSpanId,
        kind: 'fetch',
        startTime: at(10),
        duration: 30,
      }),
      makeEvent({
        spanId: nextSpanId(),
        parentSpanId,
        kind: 'fetch',
        startTime: at(10),
        duration: 30,
      }),
    ]);

    expect(selfTimeOf(node)).toBe(70);
    expect(selfTimeOf(node)).toBeGreaterThanOrEqual(0);
  });

  it('clips a child that overhangs the parent window and never goes negative', () => {
    const parentSpanId = nextSpanId();
    const parent = makeEvent({
      spanId: parentSpanId,
      kind: 'interaction',
      startTime: at(0),
      duration: 100,
    });
    const overhanging = parentNodeOf(parent, [
      makeEvent({
        spanId: nextSpanId(),
        parentSpanId,
        kind: 'http.server',
        startTime: at(90),
        duration: 50,
        producerId: SERVER_PRODUCER,
      }),
    ]);

    // Only the ten milliseconds inside the parent's window are subtracted.
    expect(selfTimeOf(overhanging)).toBe(90);

    const engulfedParentSpanId = nextSpanId();
    const engulfedParent = makeEvent({
      spanId: engulfedParentSpanId,
      kind: 'interaction',
      startTime: at(0),
      duration: 10,
    });
    const engulfed = parentNodeOf(engulfedParent, [
      makeEvent({
        spanId: nextSpanId(),
        parentSpanId: engulfedParentSpanId,
        kind: 'http.server',
        startTime: at(-5),
        duration: 30,
        producerId: SERVER_PRODUCER,
      }),
    ]);

    expect(selfTimeOf(engulfed)).toBe(0);

    const disjointParentSpanId = nextSpanId();
    const disjointParent = makeEvent({
      spanId: disjointParentSpanId,
      kind: 'interaction',
      startTime: at(0),
      duration: 10,
    });
    const disjoint = parentNodeOf(disjointParent, [
      makeEvent({
        spanId: nextSpanId(),
        parentSpanId: disjointParentSpanId,
        kind: 'http.server',
        startTime: at(40),
        duration: 5,
        producerId: SERVER_PRODUCER,
      }),
    ]);

    // A child entirely outside the window subtracts nothing at all.
    expect(selfTimeOf(disjoint)).toBe(10);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Lineage across an asynchronous boundary (AAP 0.4.2)
 *
 * The attribute keys are resolved from the declared group by the suffix that
 * identifies each one's role — exactly as `./tree.ts` resolves them — so a
 * reordering or a rename in `../schema/attributes.ts` surfaces here as a
 * failure instead of as a silently misread attribute.
 * ---------------------------------------------------------------------------
 */

/** Suffix identifying the ambiguity flag within the lineage group. */
const AMBIGUOUS_SUFFIX = 'Ambiguous';

/** Suffix identifying the candidate-span list within the lineage group. */
const CANDIDATES_SUFFIX = 'Candidates';

/** Suffix identifying the intended parent within the correlation group. */
const PARENT_SPAN_ID_SUFFIX = 'ParentSpanId';

/**
 * The one key of `keys` playing `role`, or a failure naming what is missing.
 *
 * @param keys A declared attribute-key group.
 * @param role What the key is for, for the failure message.
 * @param match The predicate that identifies it.
 * @returns That key.
 */
function keyFor(keys: readonly string[], role: string, match: (key: string) => boolean): string {
  const key = keys.find(match);
  if (key === undefined) {
    throw new Error(`the declared attribute group carries no ${role} key: ${keys.join(', ')}`);
  }
  return key;
}

/** The key holding the lineage mechanism. */
const LINEAGE_VALUE_KEY = keyFor(
  LINEAGE_ATTRIBUTE_KEYS,
  'lineage mechanism',
  (key) => !key.endsWith(AMBIGUOUS_SUFFIX) && !key.endsWith(CANDIDATES_SUFFIX),
);

/** The key holding the ambiguity flag. */
const LINEAGE_AMBIGUOUS_KEY = keyFor(LINEAGE_ATTRIBUTE_KEYS, 'lineage ambiguity', (key) =>
  key.endsWith(AMBIGUOUS_SUFFIX),
);

/** The key holding the rejected candidate parents. */
const LINEAGE_CANDIDATES_KEY = keyFor(LINEAGE_ATTRIBUTE_KEYS, 'lineage candidate list', (key) =>
  key.endsWith(CANDIDATES_SUFFIX),
);

/** The key holding the service's orphan flag. */
const ORPHANED_KEY = keyFor(
  CORRELATION_ATTRIBUTE_KEYS,
  'orphan flag',
  (key) => !key.endsWith(PARENT_SPAN_ID_SUFFIX),
);

/** The key holding the parent an orphaned event named. */
const ORPHANED_PARENT_SPAN_ID_KEY = keyFor(CORRELATION_ATTRIBUTE_KEYS, 'orphaned parent', (key) =>
  key.endsWith(PARENT_SPAN_ID_SUFFIX),
);

/** The only lineage mechanism the vocabulary declares today. */
const ASYNC_CONTINUATION = LINEAGE_VALUES[0];

/**
 * A commit attributed to an interaction's trace, carrying whatever lineage
 * attributes the case wants to hand the reader.
 *
 * @param attributes The attribute bag to attach to the commit.
 * @returns The interaction root and the commit, in that order.
 */
function continuationPair(attributes: Record<string, unknown>): TelemetryEvent[] {
  const rootSpanId = nextSpanId();
  return [
    makeEvent({
      spanId: rootSpanId,
      kind: 'interaction',
      startTime: at(0),
      duration: 400,
    }),
    makeEvent({
      spanId: nextSpanId(),
      parentSpanId: rootSpanId,
      kind: 'commit',
      startTime: at(320),
      duration: 6,
      attributes,
    }),
  ];
}

/**
 * The lineage of the commit in a {@link continuationPair} correlation.
 *
 * @param attributes The attribute bag the commit carries.
 * @returns That node's lineage, or `undefined` when the attributes yielded none.
 */
function lineageOfContinuation(attributes: Record<string, unknown>): TraceNode['lineage'] {
  const events = continuationPair(attributes);
  const commit = events.at(1);
  if (commit === undefined) {
    throw new Error('the continuation builder returns two events');
  }
  const tree = onlyTrace(correlateEvents(events));
  return nodeFor(tree, commit.spanId).lineage;
}

describe('lineage attribution', () => {
  it('resolves one distinct key per role from the declared groups', () => {
    const lineageKeys = [LINEAGE_VALUE_KEY, LINEAGE_AMBIGUOUS_KEY, LINEAGE_CANDIDATES_KEY];
    expect(new Set(lineageKeys).size).toBe(3);
    for (const key of lineageKeys) {
      expect(LINEAGE_ATTRIBUTE_KEYS).toContain(key);
    }

    const correlationKeys = [ORPHANED_KEY, ORPHANED_PARENT_SPAN_ID_KEY];
    expect(new Set(correlationKeys).size).toBe(2);
    for (const key of correlationKeys) {
      expect(CORRELATION_ATTRIBUTE_KEYS).toContain(key);
    }

    expect(ASYNC_CONTINUATION).toBe('async-continuation');
  });

  it('reports the mechanism, the ambiguity and both rejected candidates', () => {
    // This is what makes `Timeline` draw the edge dashed: the commit landed
    // while two settled requests still had an open continuation window, so the
    // attribution is the most recent candidate rather than a certainty.
    const firstCandidate = nextSpanId();
    const secondCandidate = nextSpanId();

    expect(
      lineageOfContinuation({
        [LINEAGE_VALUE_KEY]: ASYNC_CONTINUATION,
        [LINEAGE_AMBIGUOUS_KEY]: true,
        [LINEAGE_CANDIDATES_KEY]: [firstCandidate, secondCandidate],
      }),
    ).toEqual({
      value: ASYNC_CONTINUATION,
      ambiguous: true,
      candidateSpanIds: [firstCandidate, secondCandidate],
    });
  });

  it('reports an unambiguous continuation with no candidates', () => {
    expect(lineageOfContinuation({ [LINEAGE_VALUE_KEY]: ASYNC_CONTINUATION })).toEqual({
      value: ASYNC_CONTINUATION,
      ambiguous: false,
      candidateSpanIds: [],
    });
  });

  it('leaves a node without lineage attributes unlabelled', () => {
    expect(lineageOfContinuation({})).toBeUndefined();
  });

  it('tolerates malformed lineage attributes without coercing them', () => {
    const candidate = nextSpanId();

    // A number where the mechanism belongs costs the whole field rather than
    // producing a lineage labelled "42".
    expect(
      lineageOfContinuation({
        [LINEAGE_VALUE_KEY]: 42,
        [LINEAGE_AMBIGUOUS_KEY]: true,
        [LINEAGE_CANDIDATES_KEY]: [candidate],
      }),
    ).toBeUndefined();
    expect(lineageOfContinuation({ [LINEAGE_VALUE_KEY]: '' })).toBeUndefined();

    // A truthy string is not `true`: only the boolean marks an ambiguity, so a
    // certain attribution is never reported as a guess.
    expect(
      lineageOfContinuation({
        [LINEAGE_VALUE_KEY]: ASYNC_CONTINUATION,
        [LINEAGE_AMBIGUOUS_KEY]: 'yes',
        [LINEAGE_CANDIDATES_KEY]: 'not-an-array',
      }),
    ).toEqual({ value: ASYNC_CONTINUATION, ambiguous: false, candidateSpanIds: [] });

    // A mixed array keeps its usable span ids and silently drops the rest.
    const mixed = lineageOfContinuation({
      [LINEAGE_VALUE_KEY]: ASYNC_CONTINUATION,
      [LINEAGE_AMBIGUOUS_KEY]: 1,
      [LINEAGE_CANDIDATES_KEY]: [candidate, 7, null, '', { spanId: candidate }],
    });
    expect(mixed).toEqual({
      value: ASYNC_CONTINUATION,
      ambiguous: false,
      candidateSpanIds: [candidate],
    });
    expect(mixed?.candidateSpanIds.every((entry) => typeof entry === 'string')).toBe(true);
  });
});

describe('orphanFlagsOf', () => {
  it('reads the flag the service writes onto an event it could not place', () => {
    const intendedParent = nextSpanId();

    expect(
      orphanFlagsOf(
        makeEvent({
          spanId: nextSpanId(),
          kind: 'http.server',
          producerId: SERVER_PRODUCER,
          attributes: {
            [ORPHANED_KEY]: true,
            [ORPHANED_PARENT_SPAN_ID_KEY]: intendedParent,
          },
        }),
      ),
    ).toEqual({ orphanReason: 'missing-parent', missingParentSpanId: intendedParent });

    // The flag alone is enough; the intended parent is optional evidence.
    expect(
      orphanFlagsOf(
        makeEvent({
          spanId: nextSpanId(),
          kind: 'http.server',
          producerId: SERVER_PRODUCER,
          attributes: { [ORPHANED_KEY]: true },
        }),
      ),
    ).toEqual({ orphanReason: 'missing-parent' });
  });

  it('reports nothing for an event that was placed, or whose flag is malformed', () => {
    expect(orphanFlagsOf(makeEvent({ spanId: nextSpanId() }))).toBeUndefined();
    expect(
      orphanFlagsOf(makeEvent({ spanId: nextSpanId(), attributes: { [ORPHANED_KEY]: false } })),
    ).toBeUndefined();
    // A truthy string is not the flag: only the boolean counts.
    expect(
      orphanFlagsOf(makeEvent({ spanId: nextSpanId(), attributes: { [ORPHANED_KEY]: 'true' } })),
    ).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Purity and transport safety
 * ---------------------------------------------------------------------------
 */

describe('purity and serialization', () => {
  it('reads frozen events and a frozen array without mutating either', () => {
    const events = crossTierChain();
    const snapshot: readonly TelemetryEvent[] = structuredClone(events);

    for (const event of events) {
      Object.freeze(event.attributes);
      Object.freeze(event);
    }
    Object.freeze(events);

    const result = correlateEvents(events);
    expect(result.eventCount).toBe(events.length);
    expect(onlyTrace(result).nodeCount).toBe(events.length);

    expect(correlateTrace(events, DEFAULT_TRACE_ID)?.nodeCount).toBe(events.length);
    expect(sortEventsCanonical(events)).toHaveLength(events.length);

    // The persisted rows the store handed in are byte-for-byte what they were.
    expect(events).toEqual(snapshot);
  });

  it('hands each node the stored event itself rather than a copy of it', () => {
    const events = crossTierChain();
    const first = events.at(0);
    if (first === undefined) {
      throw new Error('the chain builder returns six levels');
    }

    const tree = onlyTrace(correlateEvents(shuffle(events, 5_005)));
    expect(primaryRootOf(tree).event).toBe(first);
  });

  it('produces trees that survive a JSON round trip unchanged', () => {
    // A tree crosses a WebSocket as evidence and an HTTP response as the
    // `trace` DataResult, so a parent back-reference would throw here, a `Map`
    // would arrive empty, and an `undefined`-valued key would vanish.
    const absentParent = nextSpanId();
    const events = [
      ...crossTierChain(),
      makeEvent({
        spanId: nextSpanId(),
        parentSpanId: absentParent,
        kind: 'commit',
        startTime: at(900),
        duration: 4,
        attributes: {
          [LINEAGE_VALUE_KEY]: ASYNC_CONTINUATION,
          [LINEAGE_AMBIGUOUS_KEY]: true,
          [LINEAGE_CANDIDATES_KEY]: [absentParent],
        },
      }),
    ];

    const result = correlateEvents(events);
    const tree = onlyTrace(result);
    expectNothingDropped(result, events);
    expect(tree.orphanCount).toBe(1);

    const serialized = JSON.stringify(tree);
    const roundTripped: unknown = JSON.parse(serialized);

    expect(roundTripped).toEqual(tree);
    // Key order too: a re-serialisation that differed would mean a key was
    // added or dropped in transit.
    expect(JSON.stringify(roundTripped)).toBe(serialized);

    // The map view is deliberately outside the tree, because a `Map` does not
    // serialise: it is the server-side lookup for `filter.traceId`.
    expect(result.byTraceId).toBeInstanceOf(Map);
    expect(serialized).not.toContain('byTraceId');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The kind vocabulary (the runtime companion to the correlator's assertNever)
 * ---------------------------------------------------------------------------
 */

describe('rootAffinityForKind', () => {
  it('ranks every kind in the vocabulary with a finite number', () => {
    // `rootAffinityForKind` ends in `assertNever`, so a kind added to
    // `../schema/kinds.ts` without a ranking stops compiling. This case is why
    // that guard is worth the switch: the ranking decides which span a
    // timeline is anchored on, so an unranked kind is not a small omission.
    const scores = new Map<TelemetryKind, number>();
    for (const kind of TELEMETRY_KINDS) {
      const score = rootAffinityForKind(kind);
      expect(Number.isFinite(score)).toBe(true);
      scores.set(kind, score);
    }
    expect(scores.size).toBe(TELEMETRY_KINDS.length);
    expect(scores.size).toBe(17);

    const affinityOf = (kind: TelemetryKind): number => {
      const score = scores.get(kind);
      if (score === undefined) {
        throw new Error(`no affinity recorded for kind "${kind}"`);
      }
      return score;
    };

    // The bands of the ranking: what the developer did outranks the
    // browser-to-server seam, which outranks work inside the server, which
    // outranks observations of work, which outrank symptoms.
    expect(affinityOf('interaction')).toBeGreaterThan(affinityOf('navigation'));
    expect(affinityOf('navigation')).toBeGreaterThan(affinityOf('fetch'));
    expect(affinityOf('fetch')).toBe(affinityOf('xhr'));
    expect(affinityOf('xhr')).toBeGreaterThan(affinityOf('http.server'));
    expect(affinityOf('http.server')).toBeGreaterThan(affinityOf('route.handler'));
    expect(affinityOf('route.handler')).toBeGreaterThan(affinityOf('function'));
    expect(affinityOf('function')).toBeGreaterThan(affinityOf('db.query'));
    expect(affinityOf('db.query')).toBeGreaterThan(affinityOf('http.client'));
    expect(affinityOf('http.client')).toBeGreaterThan(affinityOf('commit'));
    expect(affinityOf('commit')).toBeGreaterThan(affinityOf('render'));
    expect(affinityOf('render')).toBeGreaterThan(affinityOf('state'));
    expect(affinityOf('state')).toBeGreaterThan(affinityOf('perf.longtask'));
    expect(affinityOf('perf.longtask')).toBeGreaterThan(affinityOf('perf.entry'));
    expect(affinityOf('perf.entry')).toBeGreaterThan(affinityOf('log'));
    expect(affinityOf('log')).toBeGreaterThan(affinityOf('error'));
    expect(affinityOf('error')).toBeGreaterThan(affinityOf('server.error'));

    // `interaction` is the unique maximum, which is what makes a capture that
    // recorded a click always anchor on the click.
    const highest = Math.max(...scores.values());
    expect(affinityOf('interaction')).toBe(highest);
    expect([...scores.values()].filter((score) => score === highest)).toHaveLength(1);
  });

  it('anchors a trace on the interaction against every other parentless kind', () => {
    for (const kind of TELEMETRY_KINDS) {
      if (kind === 'interaction') {
        continue;
      }

      // The rival starts first, so only the ranking can decide the anchor.
      const rival = makeEvent({
        spanId: nextSpanId(),
        kind,
        startTime: at(0),
        duration: 5,
        producerId: firstAllowedTier(kind) === 'browser' ? BROWSER_PRODUCER : SERVER_PRODUCER,
      });
      const interaction = makeEvent({
        spanId: nextSpanId(),
        kind: 'interaction',
        startTime: at(10),
        duration: 20,
      });
      const events = [rival, interaction];

      const result = correlateEvents(events);
      const tree = onlyTrace(result);

      expectNothingDropped(result, events);
      expect(spanIdsOfNodes(tree.roots)).toEqual([rival.spanId, interaction.spanId]);
      expect(tree.primaryRootSpanId).toBe(interaction.spanId);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Scale
 *
 * A capture is thousands of spans from two producers, and the traversals must
 * be iterative: a recursive walk over a pathological chain would overflow the
 * stack inside the ingest loop, which AAP 0.5.5 does not permit.
 * ---------------------------------------------------------------------------
 */

/**
 * A synthetic capture: `traceCount` traces of `spansPerTrace` spans each,
 * alternating between the browser agent and the Node preload and branching off
 * the root every fifth span.
 *
 * @param traceCount How many traces to build.
 * @param spansPerTrace How many spans each trace holds, root included.
 * @returns Every event, grouped by trace in construction order.
 */
function syntheticCapture(traceCount: number, spansPerTrace: number): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];

  for (let traceIndex = 0; traceIndex < traceCount; traceIndex += 1) {
    const traceId = hexTrace(0x1_0000 + traceIndex);
    const rootSpanId = nextSpanId();
    events.push(
      makeEvent({
        spanId: rootSpanId,
        traceId,
        kind: 'interaction',
        startTime: at(traceIndex * 1_000),
        duration: spansPerTrace,
      }),
    );

    let previousSpanId = rootSpanId;
    for (let spanIndex = 1; spanIndex < spansPerTrace; spanIndex += 1) {
      const spanId = nextSpanId();
      const fromPreload = spanIndex % 2 === 0;
      events.push(
        makeEvent({
          spanId,
          traceId,
          parentSpanId: spanIndex % 5 === 0 ? rootSpanId : previousSpanId,
          kind: fromPreload ? 'function' : 'render',
          tier: fromPreload ? 'server' : 'browser',
          startTime: at(traceIndex * 1_000 + spanIndex * 0.25),
          duration: 1,
          producerId: fromPreload ? SERVER_PRODUCER : BROWSER_PRODUCER,
        }),
      );
      previousSpanId = spanId;
    }
  }

  return events;
}

describe('scale', () => {
  it('correlates five thousand events across fifty traces, invariant to arrival order', () => {
    const traceCount = 50;
    const spansPerTrace = 100;
    const events = syntheticCapture(traceCount, spansPerTrace);
    expect(events).toHaveLength(traceCount * spansPerTrace);

    const result = correlateEvents(shuffle(events, 20_252));

    expectNothingDropped(result, events);
    expect(result.traceCount).toBe(traceCount);
    expect(result.orphanCount).toBe(0);

    for (const trace of result.traces) {
      expect(trace.nodeCount).toBe(spansPerTrace);
      expect(trace.truncated).toBe(false);
      expect(trace.orphanCount).toBe(0);
      expect(trace.roots).toHaveLength(1);
      expect(trace.producerIds).toEqual([BROWSER_PRODUCER, SERVER_PRODUCER]);
      expect(flattenTrace(trace)).toHaveLength(spansPerTrace);
    }

    // Two independent producers mean two arrival orders for the same capture.
    expect(correlateEvents(shuffle(events, 98_765)).traces).toEqual(result.traces);
  });

  it('walks a chain far deeper than the guard without recursion or loss', () => {
    const events = linearChain(2_000);
    expect(events.length).toBeGreaterThan(DEFAULT_MAX_DEPTH);

    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(tree.nodeCount).toBe(events.length);
    expect(tree.truncated).toBe(true);
    expect(tree.maxDepth).toBe(DEFAULT_MAX_DEPTH);
    expect(tree.orphanCount).toBe(1);

    const flat = flattenTrace(tree);
    expect(flat).toHaveLength(events.length);
    expectParentsBeforeChildren(tree);

    const deepest = flat.reduce((lowest, node) => (node.depth > lowest.depth ? node : lowest));
    expect(deepest.depth).toBeGreaterThan(0);
    expect(ancestorsOfSpanId(tree, deepest.event.spanId)).toHaveLength(deepest.depth);
    expect(subtreeNodeCount(primaryRootOf(tree))).toBe(events.length);
  });

  it('places a chain exactly as deep as the guard allows, and lifts the next level', () => {
    const atTheBound = correlateEvents(linearChain(DEFAULT_MAX_DEPTH + 1));
    const boundedTree = onlyTrace(atTheBound);
    expect(boundedTree.maxDepth).toBe(DEFAULT_MAX_DEPTH);
    expect(boundedTree.truncated).toBe(false);
    expect(boundedTree.orphanCount).toBe(0);

    const oneDeeper = correlateEvents(linearChain(DEFAULT_MAX_DEPTH + 2));
    const truncatedTree = onlyTrace(oneDeeper);
    expect(truncatedTree.maxDepth).toBe(DEFAULT_MAX_DEPTH);
    expect(truncatedTree.truncated).toBe(true);
    expect(truncatedTree.orphanCount).toBe(1);
    expect(orphanNodesIn(truncatedTree).map((node) => node.orphanReason)).toEqual(['max-depth']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The committed mixed-tier corpus (AAP 0.2.3, 0.4.2)
 *
 * Every case above builds its own events, which is what a boundary case needs:
 * a two-node cycle or a chain one level past the depth guard has to be stated
 * exactly, not searched for in a file. It leaves one gap, and this section
 * closes it. `test/fixtures/correlation-mixed-tiers.json` is the mixed
 * browser/Node capture AAP 0.2.3 requires this suite to cover — one click
 * resolving across the page agent and the dev-server preload, with an
 * equal-timestamp pair across the two producers and one render whose parent
 * never arrived — and with no executable consumer it is data nothing holds to
 * account: a row could lose its `server` tier, its orphan or its tie and every
 * case above would still pass.
 *
 * The blocks below therefore drive the canonical order, the nesting, the
 * orphan repair and the mixed-producer summary from that file, read at run
 * time and validated through the persisted schema. Two deliberate choices in
 * how they assert:
 *
 * - **Derived where derivation keeps the test honest.** The producer set, the
 *   kind set and the window are computed from the parsed rows and compared
 *   against what the tree reports, so the tree is checked against its own
 *   input rather than against a copy of it.
 * - **Pinned where drift must fail.** The chain span by span, the depths, the
 *   per-tier node counts and the one orphan are literals. A corpus edit that
 *   quietly dropped the server tier would keep every derived assertion true
 *   and must fail here.
 * ---------------------------------------------------------------------------
 */

/**
 * `packages/telemetry/test/fixtures`, resolved from this module's own URL.
 *
 * The resolution is deliberately `fileURLToPath` **then** `join`, not
 * `new URL('../../test/fixtures/…', import.meta.url)`: the `telemetry` Vitest
 * project runs under happy-dom, whose global `URL` resolves a relative
 * specifier against the document origin instead of the `file:` base it was
 * given, which makes the tidier one-liner throw "The URL must be of scheme
 * file" inside `readFileSync`. Resolving from `import.meta.url` rather than
 * from the process working directory also keeps the path right whether Vitest
 * is invoked on this one file or on the whole repository. The same rationale
 * is recorded in `../redaction/rules.test.ts` and `../schema/attributes.test.ts`.
 */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

/** The committed mixed browser/Node capture this section is driven by. */
const MIXED_TIER_FIXTURE_PATH = join(FIXTURES_DIR, 'correlation-mixed-tiers.json');

/**
 * Narrows a parsed JSON document to an array without letting `any` escape.
 *
 * `JSON.parse` returns `any` and `Array.isArray` widens to `any[]`, either of
 * which would hand the schema an unchecked value and defeat the point of
 * validating at all. The predicate keeps the elements `unknown` so that the
 * only way to obtain a `TelemetryEvent` below is to parse one.
 *
 * @param value The parsed document.
 * @returns Whether it is an array, narrowing its elements to `unknown`.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * The corpus, read from disk once and validated row by row.
 *
 * The file is **read**, never `import`ed: this package's `tsconfig.json` pins
 * `rootDir` to `src` and excludes `test/**`, and a JSON import would hand the
 * suite an `any`-shaped literal that no schema had seen — the opposite of the
 * contract this corpus exists to hold. Parsing every row through
 * `telemetryEventSchema` *is* that contract: it is the same strict,
 * cross-field-checked schema the store re-validates a row against, so a corpus
 * that drifted into an unknown key, a kind/tier disagreement, a malformed
 * identifier or a timestamp outside the accepted window fails at module load
 * naming the row and the field, instead of surfacing later as a puzzling
 * structural mismatch.
 *
 * @returns The rows in committed file order, typed as the store's own records.
 * @throws An `Error` naming the offending row and issue when the file is not a
 * JSON array of persisted telemetry events.
 */
function loadMixedTierCorpus(): readonly TelemetryEvent[] {
  const corpusJson: unknown = JSON.parse(readFileSync(MIXED_TIER_FIXTURE_PATH, 'utf8'));
  if (!isUnknownArray(corpusJson)) {
    throw new Error(`${MIXED_TIER_FIXTURE_PATH} must hold a JSON array of persisted events`);
  }

  const events: TelemetryEvent[] = [];
  for (const [index, row] of corpusJson.entries()) {
    const parsed = telemetryEventSchema.safeParse(row);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<row>'}: ${issue.message}`)
        .join('; ');
      throw new Error(
        `correlation-mixed-tiers.json row ${String(index)} is not a persisted telemetry event (${issues})`,
      );
    }
    events.push(parsed.data);
  }

  return events;
}

/** The parsed corpus. Read once at module load; never handed to a case as-is. */
const MIXED_TIER_CORPUS: readonly TelemetryEvent[] = loadMixedTierCorpus();

/**
 * A fresh, mutable copy of the corpus in its committed file order.
 *
 * Every case takes its events from here rather than from
 * {@link MIXED_TIER_CORPUS} directly. The cases below freeze their input to
 * assert purity and one of them mutates a row on purpose, and a shared array
 * would make those cases observable in each other — the precise failure mode
 * that makes a suite's passing result meaningless.
 *
 * @returns Eleven deeply cloned events.
 */
function mixedTierEvents(): TelemetryEvent[] {
  return MIXED_TIER_CORPUS.map((event) => structuredClone(event));
}

/**
 * The corpus row carrying `spanId`, or a failure naming the row that went
 * missing.
 *
 * @param events A copy of the corpus.
 * @param spanId The span the case is about.
 * @returns That row.
 */
function corpusEventFor(events: readonly TelemetryEvent[], spanId: SpanId): TelemetryEvent {
  const row = events.find((event) => event.spanId === spanId);
  if (row === undefined) {
    throw new Error(`the corpus no longer carries span ${spanId}`);
  }
  return row;
}

/** How many nodes of `tree` each tier of the vocabulary holds. */
function nodeCountsByTier(tree: TraceTree): Record<TelemetryTier, number> {
  // Written out rather than derived from TELEMETRY_TIERS so that the record
  // stays exhaustive at compile time: a tier added to the vocabulary stops this
  // initialiser from compiling and demands an expected count for it.
  const counts: Record<TelemetryTier, number> = { browser: 0, server: 0, db: 0 };
  for (const node of flattenTrace(tree)) {
    counts[node.event.tier] += 1;
  }
  return counts;
}

/** How many rows the corpus holds. */
const CORPUS_EVENT_COUNT = 11;

/** The one trace id every row of the corpus carries. */
const CORPUS_TRACE_ID: TraceId = '7b41e0c82d9f36a5148e7c02fb95d3a6';

/**
 * The corpus's page-agent producer, and the lexicographically **smaller** of
 * its two: the equal-timestamp case below turns on which way `producerId`
 * breaks the tie, so the fact is named here rather than left implicit in two
 * opaque identifiers.
 */
const CORPUS_BROWSER_PRODUCER: ProducerId = 'prd_j4m8q2t6w0z3b7fh';

/** The corpus's dev-server preload producer; after the page agent's. */
const CORPUS_SERVER_PRODUCER: ProducerId = 'prd_r9v3y7c1f5h8k2np';

/**
 * The corpus's spans, by the role each plays in the capture.
 *
 * Naming them is what lets the expectations below read as the tree they
 * describe: `CORPUS_SPANS.dbQuery` under `CORPUS_SPANS.serviceFunction` is the
 * assertion AAP 0.8.3 states in words, where two bare hex strings would not be.
 */
const CORPUS_SPANS = {
  /** The browser `interaction` the whole trace descends from. */
  interaction: 'c92a3f07d1b48e65',
  /** The page's `fetch`, whose span id joined the browser trace to the server. */
  fetch: '5e18b4c60a97d23f',
  /** The framework's request span. */
  httpServer: '0d7f2b9631ea48c5',
  /** The App Router route-handler span. */
  routeHandler: 'b6a45e08c7132f9d',
  /** The named service function a reversible patch timed. */
  serviceFunction: '38f1c705ae24b6d9',
  /** The SQL that function ran: the only `db` tier row. */
  dbQuery: 'a70e5c28f13b649d',
  /** A React render that ties, in time, with the server's external call. */
  renderSummaryCard: '4c8b1d63e0a927f5',
  /** The external call the route handler made. */
  httpClient: '1a5b93e70c28d4f6',
  /** The React commit that ties, in time, with the render below it. */
  commit: 'e21d908457c3b6fa',
  /** A React render emitted in the commit's millisecond, one `seq` later. */
  renderItemList: '96f3a0b71c48e52d',
  /** The render whose parent the corpus deliberately omits: the one orphan. */
  renderFilterPanel: '7d24c1f8b530a96e',
} as const satisfies Record<string, SpanId>;

/** The parent the FilterPanel render names and no row of the corpus carries. */
const CORPUS_ABSENT_PARENT_SPAN_ID: SpanId = 'f04b8d1e6a37c952';

/** The store's arrival numbers for the corpus: eleven contiguous values. */
const CORPUS_FIRST_INGEST_SEQ = 61;

/**
 * The instant the browser's SummaryCard render and the server's external call
 * share, to the last bit of the double.
 *
 * This is AAP 0.2.3's mandated hard case as a committed row pair rather than as
 * a constructed one: the page agent and the preload read different clocks and
 * landed on the same millisecond.
 */
const CORPUS_TIED_INSTANT = 1_789_812_900_733.5;

/** The earliest `startTime` in the corpus: the interaction's. */
const CORPUS_START_TIME = 1_789_812_900_000;

/** The latest end in the corpus, which is also the interaction's. */
const CORPUS_END_TIME = 1_789_812_901_175.402;

/**
 * The corpus window, to the three decimals the product's rounding policy keeps.
 *
 * `TraceTree.totalDuration` is `roundMs(endTime - startTime)`, and the binary
 * difference of the two doubles above is `1175.402099609375` — so this literal
 * is the rounded value by design, not an approximation of one.
 */
const CORPUS_TOTAL_DURATION = 1_175.402;

/** The deepest node in the corpus: the SQL, five levels under the click. */
const CORPUS_MAX_DEPTH = 5;

/**
 * The depth a repaired node is re-attached at: one level below the anchor.
 *
 * `./correlator.ts` keeps its own `ORPHAN_DEPTH` private — the repair position
 * is an implementation decision, not part of the module's surface — so the
 * expectation is stated here rather than imported.
 */
const ORPHAN_ATTACHMENT_DEPTH = 1;

/**
 * The corpus in canonical order: `startTime`, then `producerId`, then `seq`,
 * then `ingestSeq` (AAP 0.2.3).
 *
 * Two pairs in this sequence are decided by a key later than `startTime`. The
 * SummaryCard render precedes the external call because the page agent's
 * producer id sorts before the preload's — and only because of that: the
 * preload's row reached the store first, so `ingestSeq` would invert the pair.
 * The commit precedes the ItemList render because one producer's `seq` records
 * the emission order inside a millisecond that the timestamp cannot resolve.
 */
const CORPUS_CANONICAL_ORDER: readonly SpanId[] = [
  CORPUS_SPANS.interaction,
  CORPUS_SPANS.fetch,
  CORPUS_SPANS.httpServer,
  CORPUS_SPANS.routeHandler,
  CORPUS_SPANS.serviceFunction,
  CORPUS_SPANS.dbQuery,
  CORPUS_SPANS.renderSummaryCard,
  CORPUS_SPANS.httpClient,
  CORPUS_SPANS.commit,
  CORPUS_SPANS.renderItemList,
  CORPUS_SPANS.renderFilterPanel,
];

/** One expected node of the correlated corpus, as `flattenTrace` returns it. */
interface ExpectedCorpusNode {
  /** The span this node carries. */
  readonly spanId: SpanId;
  /** The span that placed it, `undefined` for the trace root. */
  readonly parentSpanId: SpanId | undefined;
  /** Its level, counting the root as zero. */
  readonly depth: number;
  /** The kind it reports. */
  readonly kind: TelemetryKind;
  /** Its children, in the order the tree lists them. */
  readonly childSpanIds: readonly SpanId[];
}

/**
 * The tree the corpus must correlate into, in `flattenTrace` pre-order.
 *
 * This table is the whole of AAP 0.8.4's acceptance test 1 read off committed
 * data — click → `fetch` → `http.server` → `route.handler` → patched
 * `function` → SQL, with the route handler's external call beside the function
 * and the React work beside the fetch — plus the repaired render at the end.
 * The child lists pin sibling order as well as parentage, including the two
 * facts that are decisions rather than data: the service function precedes the
 * external call because it started first, and the repaired render is
 * **appended** after the structure the application actually had.
 */
const CORPUS_TREE: readonly ExpectedCorpusNode[] = [
  {
    spanId: CORPUS_SPANS.interaction,
    parentSpanId: undefined,
    depth: 0,
    kind: 'interaction',
    childSpanIds: [
      CORPUS_SPANS.fetch,
      CORPUS_SPANS.renderSummaryCard,
      CORPUS_SPANS.commit,
      CORPUS_SPANS.renderItemList,
      CORPUS_SPANS.renderFilterPanel,
    ],
  },
  {
    spanId: CORPUS_SPANS.fetch,
    parentSpanId: CORPUS_SPANS.interaction,
    depth: 1,
    kind: 'fetch',
    childSpanIds: [CORPUS_SPANS.httpServer],
  },
  {
    spanId: CORPUS_SPANS.httpServer,
    parentSpanId: CORPUS_SPANS.fetch,
    depth: 2,
    kind: 'http.server',
    childSpanIds: [CORPUS_SPANS.routeHandler],
  },
  {
    spanId: CORPUS_SPANS.routeHandler,
    parentSpanId: CORPUS_SPANS.httpServer,
    depth: 3,
    kind: 'route.handler',
    childSpanIds: [CORPUS_SPANS.serviceFunction, CORPUS_SPANS.httpClient],
  },
  {
    spanId: CORPUS_SPANS.serviceFunction,
    parentSpanId: CORPUS_SPANS.routeHandler,
    depth: 4,
    kind: 'function',
    childSpanIds: [CORPUS_SPANS.dbQuery],
  },
  {
    spanId: CORPUS_SPANS.dbQuery,
    parentSpanId: CORPUS_SPANS.serviceFunction,
    depth: CORPUS_MAX_DEPTH,
    kind: 'db.query',
    childSpanIds: [],
  },
  {
    spanId: CORPUS_SPANS.httpClient,
    parentSpanId: CORPUS_SPANS.routeHandler,
    depth: 4,
    kind: 'http.client',
    childSpanIds: [],
  },
  {
    spanId: CORPUS_SPANS.renderSummaryCard,
    parentSpanId: CORPUS_SPANS.interaction,
    depth: 1,
    kind: 'render',
    childSpanIds: [],
  },
  {
    spanId: CORPUS_SPANS.commit,
    parentSpanId: CORPUS_SPANS.interaction,
    depth: 1,
    kind: 'commit',
    childSpanIds: [],
  },
  {
    spanId: CORPUS_SPANS.renderItemList,
    parentSpanId: CORPUS_SPANS.interaction,
    depth: 1,
    kind: 'render',
    childSpanIds: [],
  },
  {
    spanId: CORPUS_SPANS.renderFilterPanel,
    parentSpanId: CORPUS_SPANS.interaction,
    depth: ORPHAN_ATTACHMENT_DEPTH,
    kind: 'render',
    childSpanIds: [],
  },
];

describe('the committed mixed-tier corpus', () => {
  it('parses every committed row through the persisted schema', () => {
    const events = mixedTierEvents();

    // The load above would have thrown on an invalid row, so what is left to
    // assert is that the corpus is still the capture these cases describe: an
    // empty or truncated file is a valid JSON array and would otherwise make
    // every case below vacuous.
    expect(events).toHaveLength(CORPUS_EVENT_COUNT);

    for (const event of events) {
      expect(isTelemetryEvent(event)).toBe(true);
      expect(event.traceId).toBe(CORPUS_TRACE_ID);
      expect(isTraceId(event.traceId)).toBe(true);
      expect(isSpanId(event.spanId)).toBe(true);
    }

    // Distinct ids and distinct span ids, so neither the "nothing dropped"
    // counts nor the span lookups below can be satisfied by a repeated row.
    expect(new Set(events.map((event) => event.id)).size).toBe(CORPUS_EVENT_COUNT);
    expect(new Set(spanIdsOfEvents(events)).size).toBe(CORPUS_EVENT_COUNT);
    expect([...spanIdsOfEvents(events)].sort()).toEqual([...Object.values(CORPUS_SPANS)].sort());

    // A contiguous block of arrival numbers: these are rows the store wrote,
    // which is what makes `ingestSeq` usable as the final tie-breaker.
    expect([...events.map((event) => event.ingestSeq)].sort((left, right) => left - right)).toEqual(
      Array.from(
        { length: CORPUS_EVENT_COUNT },
        (_unused, index) => CORPUS_FIRST_INGEST_SEQ + index,
      ),
    );
  });

  it('is committed in a non-canonical order, so a case that sorts it is doing work', () => {
    const events = mixedTierEvents();

    expect(spanIdsOfEvents(events)).not.toEqual([...CORPUS_CANONICAL_ORDER]);
    // Nor is the file in reverse canonical order, and its first row is neither
    // the trace root nor the earliest event: the shuffle is real.
    expect(spanIdsOfEvents(events)).not.toEqual([...CORPUS_CANONICAL_ORDER].reverse());
    expect(events.at(0)?.spanId).not.toBe(CORPUS_SPANS.interaction);
    expect(events.at(0)?.startTime).not.toBe(CORPUS_START_TIME);
  });

  it('hands each case a fresh copy, so one case cannot leak into another', () => {
    const mutated = mixedTierEvents().at(0);
    if (mutated === undefined) {
      throw new Error('the corpus holds eleven rows');
    }

    const committedStart = mutated.startTime;
    const committedAttributes = structuredClone(mutated.attributes);
    mutated.startTime = 0;
    mutated.attributes = {};

    const reread = mixedTierEvents().at(0);
    expect(reread?.startTime).toBe(committedStart);
    expect(reread?.attributes).toEqual(committedAttributes);
    // The clone is deep, so the module-level parse is untouched too — which is
    // what keeps the next case's expectations true.
    expect(MIXED_TIER_CORPUS.at(0)?.startTime).toBe(committedStart);
    expect(MIXED_TIER_CORPUS.at(0)?.attributes).toEqual(committedAttributes);
  });
});

describe('canonical ordering over the committed corpus', () => {
  it('sorts the committed file order into the documented total order', () => {
    const events = mixedTierEvents();
    const sorted = sortEventsCanonical(events);

    expect(spanIdsOfEvents(sorted)).toEqual([...CORPUS_CANONICAL_ORDER]);

    // The sequence is the comparator's own, pairwise: every adjacent pair is
    // strictly ordered, so no two rows of the corpus tie on all five keys and
    // the order above cannot depend on the sort implementation.
    for (let index = 1; index < sorted.length; index += 1) {
      const earlier = sorted.at(index - 1);
      const later = sorted.at(index);
      if (earlier === undefined || later === undefined) {
        throw new Error('sortEventsCanonical returns a dense array');
      }
      expect(compareEventsCanonical(earlier, later)).toBeLessThan(0);
      expect(compareEventsCanonical(later, earlier)).toBeGreaterThan(0);
    }

    // And the caller's array is untouched, still in committed file order.
    expect(spanIdsOfEvents(events)).not.toEqual([...CORPUS_CANONICAL_ORDER]);
  });

  it('reaches that same order from the reversed and from seeded shuffles of the corpus', () => {
    const reversed = mixedTierEvents().reverse();
    expect(spanIdsOfEvents(sortEventsCanonical(reversed))).toEqual([...CORPUS_CANONICAL_ORDER]);

    for (const seed of [3, 97, 4_242]) {
      const permuted = shuffle(mixedTierEvents(), seed);
      expect(spanIdsOfEvents(permuted)).not.toEqual([...CORPUS_CANONICAL_ORDER]);
      expect(spanIdsOfEvents(sortEventsCanonical(permuted))).toEqual([...CORPUS_CANONICAL_ORDER]);
    }
  });

  it('separates the corpus row pair that two producers put in one millisecond', () => {
    const events = mixedTierEvents();
    const fromBrowser = corpusEventFor(events, CORPUS_SPANS.renderSummaryCard);
    const fromPreload = corpusEventFor(events, CORPUS_SPANS.httpClient);

    // The committed premise: one instant, two producers, two tiers.
    expect(fromBrowser.startTime).toBe(CORPUS_TIED_INSTANT);
    expect(fromPreload.startTime).toBe(fromBrowser.startTime);
    expect(fromBrowser.producerId).toBe(CORPUS_BROWSER_PRODUCER);
    expect(fromPreload.producerId).toBe(CORPUS_SERVER_PRODUCER);
    expect(fromBrowser.tier).toBe('browser');
    expect(fromPreload.tier).toBe('server');
    expect(CORPUS_BROWSER_PRODUCER < CORPUS_SERVER_PRODUCER).toBe(true);

    // The preload's row reached the store first, so the final tie-breaker
    // points the *other* way: an implementation that fell straight through to
    // `ingestSeq` would invert this pair and fail here. What this committed
    // pair cannot settle on its own is `producerId` **before** `seq` — the
    // page agent's third emission and the preload's fifth agree on the
    // outcome — so that discrimination stays with the constructed pair in
    // `compareEventsCanonical` above, where both keys are made to disagree.
    expect(fromPreload.ingestSeq).toBeLessThan(fromBrowser.ingestSeq);
    expect(fromBrowser.seq).toBeLessThan(fromPreload.seq);

    expect(compareEventsCanonical(fromBrowser, fromPreload)).toBeLessThan(0);
    expect(compareEventsCanonical(fromPreload, fromBrowser)).toBeGreaterThan(0);
    expect(spanIdsOfEvents(sortEventsCanonical([fromBrowser, fromPreload]))).toEqual([
      CORPUS_SPANS.renderSummaryCard,
      CORPUS_SPANS.httpClient,
    ]);
    expect(spanIdsOfEvents(sortEventsCanonical([fromPreload, fromBrowser]))).toEqual([
      CORPUS_SPANS.renderSummaryCard,
      CORPUS_SPANS.httpClient,
    ]);
  });

  it('falls through to seq for the commit and render the page agent emitted together', () => {
    const events = mixedTierEvents();
    const commit = corpusEventFor(events, CORPUS_SPANS.commit);
    const render = corpusEventFor(events, CORPUS_SPANS.renderItemList);

    // One producer, one instant: `producerId` ties and `seq` is what records
    // the order React's commit callback observed.
    expect(commit.startTime).toBe(render.startTime);
    expect(commit.producerId).toBe(render.producerId);
    expect(commit.producerId).toBe(CORPUS_BROWSER_PRODUCER);
    expect(commit.seq).toBeLessThan(render.seq);

    expect(compareEventsCanonical(commit, render)).toBeLessThan(0);
    expect(compareEventsCanonical(render, commit)).toBeGreaterThan(0);
    expect(spanIdsOfEvents(sortEventsCanonical([render, commit]))).toEqual([
      CORPUS_SPANS.commit,
      CORPUS_SPANS.renderItemList,
    ]);
  });
});

describe('nesting across tiers over the committed corpus', () => {
  it('reproduces the cross-tier chain span by span, with its depths', () => {
    const events = mixedTierEvents();
    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(tree.traceId).toBe(CORPUS_TRACE_ID);
    expect(tree.roots).toHaveLength(1);
    expect(tree.primaryRootSpanId).toBe(CORPUS_SPANS.interaction);
    expect(primaryRootOf(tree).event.kind).toBe('interaction');
    expect(tree.nodeCount).toBe(CORPUS_EVENT_COUNT);
    expect(tree.maxDepth).toBe(CORPUS_MAX_DEPTH);
    expect(tree.truncated).toBe(false);
    expect(tree.duplicateSpanIds).toEqual([]);

    const flat = flattenTrace(tree);
    expect(spanIdsOfNodes(flat)).toEqual(CORPUS_TREE.map((expected) => expected.spanId));
    expect(flat.map((node) => node.depth)).toEqual(CORPUS_TREE.map((expected) => expected.depth));
    expect(flat.map((node) => node.event.kind)).toEqual(
      CORPUS_TREE.map((expected) => expected.kind),
    );
    expect(flat.map((node) => spanIdsOfNodes(node.children))).toEqual(
      CORPUS_TREE.map((expected) => [...expected.childSpanIds]),
    );
  });

  it('places every node after the parent that placed it', () => {
    const tree = onlyTrace(correlateEvents(mixedTierEvents()));

    expectParentsBeforeChildren(tree);

    const visited: [SpanId, SpanId | undefined][] = [];
    walkTrace(tree, (node, parent) => {
      visited.push([node.event.spanId, parent?.event.spanId]);
    });
    expect(visited).toEqual(
      CORPUS_TREE.map((expected) => [expected.spanId, expected.parentSpanId]),
    );

    // AAP 0.8.3's end-to-end assertion, read off the corpus: the SQL sits under
    // the patched function, under the route handler, under the request span,
    // under the browser's fetch, under the click — root-first, one ancestor per
    // tier boundary, and the tiers cross browser → server → db exactly once.
    const ancestry = ancestorsOfSpanId(tree, CORPUS_SPANS.dbQuery);
    expect(spanIdsOfNodes(ancestry)).toEqual([
      CORPUS_SPANS.interaction,
      CORPUS_SPANS.fetch,
      CORPUS_SPANS.httpServer,
      CORPUS_SPANS.routeHandler,
      CORPUS_SPANS.serviceFunction,
    ]);
    expect(ancestry.map((node) => node.event.tier)).toEqual([
      'browser',
      'browser',
      'server',
      'server',
      'server',
    ]);
    expect(nodeFor(tree, CORPUS_SPANS.dbQuery).event.tier).toBe('db');
    expect(ancestry).toHaveLength(nodeFor(tree, CORPUS_SPANS.dbQuery).depth);
    expect(subtreeNodeCount(primaryRootOf(tree))).toBe(CORPUS_EVENT_COUNT);
  });

  it('correlates the reversed and the shuffled corpus into the identical tree', () => {
    const canonical = correlateEvents(sortEventsCanonical(mixedTierEvents()));
    expect(spanIdsOfNodes(flattenTrace(onlyTrace(canonical)))).toEqual(
      CORPUS_TREE.map((expected) => expected.spanId),
    );

    // Two producers mean two arrival orders for the same capture, and the
    // service re-correlates the whole capture as each batch lands.
    expect(correlateEvents(mixedTierEvents().reverse()).traces).toEqual(canonical.traces);
    for (const seed of [11, 613, 20_252]) {
      expect(correlateEvents(shuffle(mixedTierEvents(), seed)).traces).toEqual(canonical.traces);
    }
  });

  it('reads the frozen corpus without mutating it', () => {
    const events = mixedTierEvents();
    const snapshot: readonly TelemetryEvent[] = structuredClone(events);

    for (const event of events) {
      Object.freeze(event.attributes);
      Object.freeze(event);
    }
    Object.freeze(events);

    const result = correlateEvents(events);
    expect(onlyTrace(result).nodeCount).toBe(CORPUS_EVENT_COUNT);
    expect(correlateTrace(events, CORPUS_TRACE_ID)?.nodeCount).toBe(CORPUS_EVENT_COUNT);
    expect(correlateTrace(events, DEFAULT_TRACE_ID)).toBeUndefined();

    // The persisted rows are byte-for-byte what the file holds.
    expect(events).toEqual(snapshot);
  });
});

describe('orphan attachment over the committed corpus', () => {
  it('retains the render whose parent never arrived, re-attached under the click', () => {
    const events = mixedTierEvents();
    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expectNothingDropped(result, events);
    expect(result.orphanCount).toBe(1);
    expect(tree.orphanCount).toBe(1);

    // The corpus's premise: the named parent is genuinely absent, so this is a
    // repair rather than a misplacement.
    expect(corpusEventFor(events, CORPUS_SPANS.renderFilterPanel).parentSpanId).toBe(
      CORPUS_ABSENT_PARENT_SPAN_ID,
    );
    expect(events.some((event) => event.spanId === CORPUS_ABSENT_PARENT_SPAN_ID)).toBe(false);
    expect(findNodeBySpanId(tree, CORPUS_ABSENT_PARENT_SPAN_ID)).toBeUndefined();

    const orphan = nodeFor(tree, CORPUS_SPANS.renderFilterPanel);
    expect(orphan.orphaned).toBe(true);
    expect(orphan.orphanReason).toBe('missing-parent');
    expect(orphan.missingParentSpanId).toBe(CORPUS_ABSENT_PARENT_SPAN_ID);
    expect(orphan.depth).toBe(ORPHAN_ATTACHMENT_DEPTH);
    expect(orphan.children).toEqual([]);
    expect(orphanFlagsOf(orphan.event)).toBeUndefined();

    // Exactly one repair, exactly one reason, and it is the last child of the
    // anchor: the structure the application had is read first, the repair after.
    expect(spanIdsOfNodes(orphanNodesIn(tree))).toEqual([CORPUS_SPANS.renderFilterPanel]);
    expect(orphanReasonsIn(tree)).toEqual(['missing-parent']);
    expect(spanIdsOfNodes(primaryRootOf(tree).children).at(-1)).toBe(
      CORPUS_SPANS.renderFilterPanel,
    );
  });

  it('leaves every other node of the corpus unflagged', () => {
    const tree = onlyTrace(correlateEvents(mixedTierEvents()));

    const flagged = flattenTrace(tree).filter(
      (node) =>
        node.orphaned || node.orphanReason !== undefined || node.missingParentSpanId !== undefined,
    );
    expect(spanIdsOfNodes(flagged)).toEqual([CORPUS_SPANS.renderFilterPanel]);

    // The repair is a re-parenting and nothing else: the row still reports the
    // parent it named, so a developer can see what went missing.
    expect(nodeFor(tree, CORPUS_SPANS.renderFilterPanel).event.parentSpanId).toBe(
      CORPUS_ABSENT_PARENT_SPAN_ID,
    );
  });
});

describe('the mixed-producer facts of the committed corpus', () => {
  it('summarises both producers, all three tiers and every kind present', () => {
    const events = mixedTierEvents();
    const result = correlateEvents(events);
    const tree = onlyTrace(result);

    expect(result.traceCount).toBe(1);
    expect(result.eventCount).toBe(CORPUS_EVENT_COUNT);
    expect([...result.byTraceId.keys()]).toEqual([CORPUS_TRACE_ID]);

    // Derived from the corpus, so the tree is checked against its own input.
    const producersPresent = [...new Set(events.map((event) => event.producerId))].sort();
    const kindsPresent = new Set<TelemetryKind>(events.map((event) => event.kind));
    expect(producersPresent).toEqual([CORPUS_BROWSER_PRODUCER, CORPUS_SERVER_PRODUCER]);
    expect(tree.producerIds).toEqual(producersPresent);
    expect(tree.kinds).toEqual(TELEMETRY_KINDS.filter((kind) => kindsPresent.has(kind)));

    // Pinned, so a corpus that quietly lost its server or db tier fails here
    // rather than agreeing with a smaller derived set.
    expect(tree.tiers).toEqual([...TELEMETRY_TIERS]);
    expect(tree.kinds).toEqual([
      'interaction',
      'render',
      'commit',
      'fetch',
      'http.server',
      'route.handler',
      'function',
      'db.query',
      'http.client',
    ]);
    expect(nodeCountsByTier(tree)).toEqual({ browser: 6, server: 4, db: 1 });
    expect(events.filter((event) => event.producerId === CORPUS_BROWSER_PRODUCER)).toHaveLength(6);
    expect(events.filter((event) => event.producerId === CORPUS_SERVER_PRODUCER)).toHaveLength(5);
  });

  it('opens its window at the click and closes it where the click ended', () => {
    const events = mixedTierEvents();
    const tree = onlyTrace(correlateEvents(events));

    expect(tree.startTime).toBe(Math.min(...events.map((event) => event.startTime)));
    expect(tree.endTime).toBe(Math.max(...events.map((event) => event.startTime + event.duration)));
    expect(tree.startTime).toBe(CORPUS_START_TIME);
    expect(tree.endTime).toBe(CORPUS_END_TIME);
    expect(tree.totalDuration).toBe(CORPUS_TOTAL_DURATION);

    // The interaction is the widest span in the capture, so the tree's window
    // and the anchor's coincide — which is what makes a timeline's percentage
    // scale meaningful for this capture.
    const root = primaryRootOf(tree);
    expect(root.event.startTime).toBe(tree.startTime);
    expect(nodeEndTime(root)).toBe(tree.endTime);
    expect(totalTimeOf(root)).toBe(CORPUS_TOTAL_DURATION);

    // Every row's own window falls inside the trace window, which is what lets
    // the aggregates treat the two producers' clocks as one time base.
    for (const event of events) {
      expect(event.startTime).toBeGreaterThanOrEqual(tree.startTime);
      expect(event.startTime + event.duration).toBeLessThanOrEqual(tree.endTime);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Incremental extension (`indexTraceForExtension`, `extendCorrelatedTrace`)
 *
 * The service grows cached trees batch by batch instead of re-correlating the
 * whole trace per batch (the `O(n²/b)` the code review rejected). The contract
 * under test is exactness: every `extended` answer must be identical — deeply
 * and in `JSON.stringify` key order — to `correlateTrace` over every row so
 * far, and every `refused` answer must leave the index untouched and be one of
 * the documented reasons. The randomized differential case is the main
 * evidence — its batches routinely carry orphans ahead of their parents, late
 * parents (real children, repairs and genuine roots among them, several per
 * batch), rings the late parents close, anchoring and non-anchoring roots and
 * moved subtrees on and past the depth guard. The explicit cases pin each of
 * the fast path's cases (new roots, new repairs, late parents), each form of
 * `primary-change` and every other refusal, the replay no-op, the anchor's
 * prefix/suffix layout, the per-step cost bound and the bounded fallback on a
 * demo-shaped stream one at a time.
 * ---------------------------------------------------------------------------
 */

/**
 * A seeded uniform source in `[0, 1)`: the same linear congruential generator
 * as {@link shuffle}, read through its full 32-bit state. Never `Math.random`.
 */
function randomSource(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** One element of a non-empty list, chosen by `random`. */
function pick<T>(items: readonly T[], random: () => number): T {
  const chosen = items[Math.floor(random() * items.length)];
  if (chosen === undefined) {
    throw new Error('pick() needs a non-empty list');
  }
  return chosen;
}

/** The kinds a generated non-root span reports. */
const GENERATED_CHILD_KINDS: readonly TelemetryKind[] = [
  'fetch',
  'http.server',
  'route.handler',
  'function',
  'db.query',
  'http.client',
  'render',
  'commit',
  'state',
  'log',
];

/**
 * The kinds a generated extra genuine root reports: three that rank below an
 * `interaction`, so one arriving in a trace anchored on the click leaves the
 * anchor in place, and `interaction` itself, which outranks every other root
 * and ties the anchor — so both the non-anchoring and the anchoring root are
 * generated.
 */
const GENERATED_ROOT_KINDS: readonly TelemetryKind[] = [
  'http.server',
  'navigation',
  'fetch',
  'interaction',
];

/**
 * How often a generated trace carries each irregularity, per event.
 *
 * Two profiles: a *regular* trace has only what real captures routinely have
 * (a stray parentless span, a parent that never arrives, a deep branch), and a
 * *malformed* one adds what only a misbehaving producer emits (self-parents,
 * reused span ids, two-span cycles and longer rings) — each of which, once
 * stored, keeps the trace on the full-correlation path for good, so a trace
 * carries them rarely or not at all.
 */
interface IrregularityRates {
  readonly extraRoot: number;
  readonly missingParent: number;
  readonly selfParent: number;
  readonly reusedSpan: number;
  readonly cycle: number;
  /** A ring of three or four spans, each naming the next. */
  readonly ring: number;
  /** A chain of three to six spans under one parent: a deep subtree to move. */
  readonly branch: number;
}

const REGULAR_RATES: IrregularityRates = {
  extraRoot: 0.02,
  missingParent: 0.02,
  selfParent: 0,
  reusedSpan: 0,
  cycle: 0,
  ring: 0,
  branch: 0.03,
};

const MALFORMED_RATES: IrregularityRates = {
  extraRoot: 0.02,
  missingParent: 0.025,
  selfParent: 0.012,
  reusedSpan: 0.004,
  cycle: 0.006,
  ring: 0.01,
  branch: 0.03,
};

/**
 * A random trace, as the store would hold it once every row has arrived:
 * usually one genuine `interaction` root, fan-out and depth underneath it, two
 * producers landing on a small set of shared timestamps, and — at the given
 * rates — extra parentless roots, missing parents, self-parents, deep
 * branches, reused span ids, two-span cycles and longer rings. Every span,
 * including a repaired or parentless one, can gain children, so a late parent
 * can be a real child, an orphan itself or a genuine root. Late parents are
 * not generated here: they come from the arrival order, when a subtree is
 * delivered before its parent.
 *
 * @param random The seeded source.
 * @param traceId The trace every event carries.
 * @param size At least how many events to generate.
 * @param rates How often each irregularity occurs.
 * @returns The events, in generation order; `ingestSeq` is assigned later, by
 * arrival.
 */
function generatedTrace(
  random: () => number,
  traceId: TraceId,
  size: number,
  rates: IrregularityRates,
): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  const spans: SpanId[] = [];
  let missingOrdinal = 0;

  // The tier's own producer, as in a real capture, with one span in ten from
  // the other one — so cross-producer edges exist beyond the fetch → server
  // seam without being every edge.
  const producerFor = (kind: TelemetryKind): ProducerId => {
    const own = firstAllowedTier(kind) === 'browser' ? BROWSER_PRODUCER : SERVER_PRODUCER;
    if (random() < 0.1) {
      return own === BROWSER_PRODUCER ? SERVER_PRODUCER : BROWSER_PRODUCER;
    }
    return own;
  };

  const span = (
    spanId: SpanId,
    parentSpanId: SpanId | undefined,
    kind: TelemetryKind,
  ): TelemetryEvent => {
    const event = makeEvent({
      spanId,
      traceId,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      kind,
      // Twenty-four shared instants: cross-producer ties are routine.
      startTime: at(Math.floor(random() * 24) * 0.5),
      duration: Math.floor(random() * 200) * 0.25,
      producerId: producerFor(kind),
    });
    events.push(event);
    spans.push(spanId);
    return event;
  };
  const missingSpanId = (): SpanId => {
    missingOrdinal += 1;
    // Far above the fixture counter, so no generated span ever carries it.
    return hexSpan(0xdead_0000 + missingOrdinal);
  };

  if (random() < 0.85) {
    span(nextSpanId(), undefined, 'interaction');
  }

  // Cumulative thresholds over one roll per event, in a fixed order.
  const extraRoot = rates.extraRoot;
  const missingParent = extraRoot + rates.missingParent;
  const selfParent = missingParent + rates.selfParent;
  const reusedSpan = selfParent + rates.reusedSpan;
  const cycle = reusedSpan + rates.cycle;
  const ring = cycle + rates.ring;
  const branch = ring + rates.branch;

  while (events.length < size) {
    const roll = random();
    const kind = pick(GENERATED_CHILD_KINDS, random);

    if (roll < extraRoot) {
      span(nextSpanId(), undefined, pick(GENERATED_ROOT_KINDS, random));
    } else if (roll < missingParent || spans.length === 0) {
      span(nextSpanId(), missingSpanId(), kind);
    } else if (roll < selfParent) {
      const spanId = nextSpanId();
      span(spanId, spanId, kind);
    } else if (roll < reusedSpan) {
      span(pick(spans, random), pick(spans, random), kind);
    } else if (roll < cycle) {
      const first = nextSpanId();
      const second = nextSpanId();
      span(first, second, kind);
      span(second, first, kind);
    } else if (roll < ring) {
      // Each member names the next and the last names the first: delivered
      // across batches, the span that closes the ring is a late parent.
      const members = [nextSpanId(), nextSpanId(), nextSpanId()];
      if (random() < 0.5) {
        members.push(nextSpanId());
      }
      const [first] = members;
      if (first === undefined) {
        throw new Error('a ring needs members');
      }
      members.forEach((spanId, position) => {
        span(spanId, members[position + 1] ?? first, kind);
      });
    } else if (roll < branch) {
      // A deep subtree under one span: moved whole when its top arrives late.
      let parentSpanId = pick(spans, random);
      const length = 3 + Math.floor(random() * 4);
      for (let level = 0; level < length; level += 1) {
        parentSpanId = span(nextSpanId(), parentSpanId, pick(GENERATED_CHILD_KINDS, random)).spanId;
      }
    } else {
      const recent = spans.slice(-6);
      span(nextSpanId(), pick(random() < 0.6 ? recent : spans, random), kind);
    }
  }

  return events;
}

/**
 * The order two independent producers deliver a trace in: roughly emission
 * order, because both flush as they go, with each event's position jittered —
 * slightly for most, by several places for one in six, and by several whole
 * batches for one in eight: the span whose producer's flush lagged the other's.
 * That is what delivers a server span ahead of the browser span that caused
 * it, a subtree ahead of its root, and several late parents in one batch.
 * `scrambled` replaces it with a full permutation, the worst case.
 */
function deliveryOrder(
  random: () => number,
  events: readonly TelemetryEvent[],
  scrambled: boolean,
): TelemetryEvent[] {
  if (scrambled) {
    return shuffle(events, Math.floor(random() * 0xffff_ffff));
  }

  return events
    .map((event, position) => {
      const roll = random();
      const lag =
        roll < 1 / 8 ? 6 + random() * 24 : roll < 1 / 8 + 1 / 6 ? random() * 8 : random() * 1.5;
      return { event, due: position + lag };
    })
    .sort((left, right) => left.due - right.due)
    .map((entry) => entry.event);
}

/**
 * The generated trace's arrival, with `ingestSeq` assigned in arrival order as
 * the store assigns it, split into batches of one to six rows. About one batch
 * in five also replays an earlier row, one in twenty repeats one of its own,
 * and one in twelve is followed by a batch of replays alone — each exactly as
 * the store returns it, the stored row itself.
 */
function arrivalBatches(
  random: () => number,
  events: readonly TelemetryEvent[],
  scrambled: boolean,
): TelemetryEvent[][] {
  const arrival = deliveryOrder(random, events, scrambled).map((event, position) => ({
    ...event,
    ingestSeq: position + 1,
  }));
  const batches: TelemetryEvent[][] = [];
  const delivered: TelemetryEvent[] = [];
  let cursor = 0;

  while (cursor < arrival.length) {
    const rows = arrival.slice(cursor, cursor + 1 + Math.floor(random() * 6));
    cursor += rows.length;

    const batch = [...rows];
    if (delivered.length > 0 && random() < 0.2) {
      batch.push(pick(delivered, random));
    }
    if (random() < 0.05) {
      batch.push(pick(rows, random));
    }

    delivered.push(...rows);
    batches.push(shuffle(batch, Math.floor(random() * 0xffff_ffff)));

    // Now and then a batch of nothing but replays: a reloaded page flushing a
    // buffer the store already holds.
    if (random() < 0.08) {
      batches.push([pick(delivered, random), pick(delivered, random)]);
    }
  }

  return batches;
}

/**
 * The refusals the generator can provoke; the other reasons need crafted rows
 * (`ambiguous-order`, `stale-replay`, `non-finite-time`, `options-mismatch`,
 * `inconsistent-index`) and have explicit cases below.
 */
const GENERATED_REFUSALS: readonly ExtensionRefusalReason[] = [
  'primary-change',
  'duplicate-span',
  'cycle',
  'max-depth',
];

/** The batch's new events: replays of tree rows, and repeats within it, removed. */
function freshEventsOf(before: TraceTree, batch: readonly TelemetryEvent[]): TelemetryEvent[] {
  const inTree = new Map(flattenTrace(before).map((node) => [node.event.spanId, node] as const));
  const fresh: TelemetryEvent[] = [];
  const seen = new Set<string>();
  for (const event of batch) {
    if (inTree.get(event.spanId)?.event.id === event.id || seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    fresh.push(event);
  }
  return fresh;
}

/**
 * Whether the pre-batch tree and the batch really exhibit the condition a
 * refusal names — an independent restatement of each rule, so a refusal for
 * the wrong reason (or for none) fails the differential case.
 *
 * @param reason The refusal.
 * @param before The indexed tree the batch was offered to.
 * @param batch The batch, replays included.
 * @param after The full correlation of every row including the batch.
 */
function refusalIsJustified(
  reason: ExtensionRefusalReason,
  before: TraceTree,
  batch: readonly TelemetryEvent[],
  after: TraceTree | undefined,
): boolean {
  const treeEvents = flattenTrace(before).map((node) => node.event);
  const fresh = freshEventsOf(before, batch);

  switch (reason) {
    case 'primary-change':
      // The full correlation anchors the trace somewhere else.
      return after !== undefined && after.primaryRootSpanId !== before.primaryRootSpanId;
    case 'duplicate-span': {
      const spans = new Set(treeEvents.map((event) => event.spanId));
      return fresh.some((event) => {
        const repeated = spans.has(event.spanId);
        spans.add(event.spanId);
        return repeated;
      });
    }
    case 'cycle': {
      // Some event of the combined rows lies on a `parentSpanId` loop.
      const bySpanId = new Map<SpanId, TelemetryEvent>();
      for (const event of [...treeEvents, ...fresh]) {
        bySpanId.set(event.spanId, event);
      }
      return [...bySpanId.values()].some((start) => {
        const seen = new Set<SpanId>();
        let cursor: TelemetryEvent | undefined = start;
        while (cursor !== undefined) {
          if (seen.has(cursor.spanId)) {
            return true;
          }
          seen.add(cursor.spanId);
          const parentSpanId: SpanId | undefined = cursor.parentSpanId;
          cursor = parentSpanId === undefined ? undefined : bySpanId.get(parentSpanId);
        }
        return false;
      });
    }
    case 'max-depth':
      return after?.truncated === true;
    default:
      return false;
  }
}

/** What one extended step exercised, read off the trees rather than the code. */
interface StepShape {
  /** A new event was repaired onto the anchor (case B). */
  readonly repairAdded: boolean;
  /** A new genuine root joined the roots without moving the anchor (case A). */
  readonly rootAdded: boolean;
  /** How many distinct late parents adopted an orphan of the tree (case C). */
  readonly lateParents: number;
  /** A late parent that is itself a repair of the anchor adopted an orphan. */
  readonly repairedLateParent: boolean;
  /** A late parent that is a genuine root adopted an orphan. */
  readonly rootLateParent: boolean;
  /** The deepest node of a moved subtree, after the move; `-1` when none moved. */
  readonly deepestMoved: number;
}

/**
 * Reads what a step did from the tree before and after it: which orphans lost
 * their flags, who adopted them, and what joined the roots and the repairs.
 */
function shapeOfStep(before: TraceTree, after: TraceTree): StepShape {
  const earlier = new Map(flattenTrace(before).map((node) => [node.event.spanId, node] as const));
  const parentOf = new Map<SpanId, TraceNode | undefined>();
  walkTrace(after, (node, parent) => {
    parentOf.set(node.event.spanId, parent);
  });

  let repairAdded = false;
  let repairedLateParent = false;
  let rootLateParent = false;
  let deepestMoved = -1;
  const adopters = new Set<SpanId>();

  for (const node of flattenTrace(after)) {
    const old = earlier.get(node.event.spanId);
    if (old === undefined) {
      repairAdded ||= node.orphaned;
      continue;
    }
    if (!old.orphaned || node.orphaned) {
      continue;
    }

    const adopter = parentOf.get(node.event.spanId);
    if (adopter !== undefined) {
      adopters.add(adopter.event.spanId);
      repairedLateParent ||= adopter.orphaned;
      rootLateParent ||= adopter.depth === 0;
    }
    for (const moved of flattenNode(node)) {
      deepestMoved = Math.max(deepestMoved, moved.depth);
    }
  }

  return {
    repairAdded,
    rootAdded: after.roots.length > before.roots.length,
    lateParents: adopters.size,
    repairedLateParent,
    rootLateParent,
    deepestMoved,
  };
}

/**
 * How many nodes of `after` are new objects — absent from `before`, or not the
 * very node `before` held for that span. With every unchanged node shared,
 * this is exactly the count an extension reports as `nodesBuilt`.
 */
function freshNodeObjects(before: TraceTree, after: TraceTree): number {
  const earlier = new Map(flattenTrace(before).map((node) => [node.event.spanId, node] as const));
  return flattenTrace(after).filter((node) => earlier.get(node.event.spanId) !== node).length;
}

/**
 * Whether a node that was rebuilt had to be: a rebuilt node of the tree must
 * differ from the node it replaces in depth, in its flags, or in its children
 * (a child added, removed or itself rebuilt). A rebuild that changes none of
 * them is work the extension should not have done.
 */
function everyRebuildIsNeeded(before: TraceTree, after: TraceTree): boolean {
  const earlier = new Map(flattenTrace(before).map((node) => [node.event.spanId, node] as const));
  return flattenTrace(after).every((node) => {
    const old = earlier.get(node.event.spanId);
    if (old === undefined || old === node) {
      return true;
    }
    return (
      old.depth !== node.depth ||
      old.orphanReason !== node.orphanReason ||
      old.children.length !== node.children.length ||
      old.children.some((child, position) => node.children[position] !== child)
    );
  });
}

/**
 * Whether an index still describes its tree exactly as a fresh index of that
 * tree would: every node the same object, the same missing parents with the
 * same counts, and the same running aggregates.
 */
function indexMatchesFreshIndex(index: TraceExtensionIndex, maxDepth: number | undefined): boolean {
  const fresh = indexTraceForExtension(index.tree, { maxDepth });
  if (fresh === undefined || fresh.nodeBySpanId.size !== index.nodeBySpanId.size) {
    return false;
  }
  for (const [spanId, node] of fresh.nodeBySpanId) {
    if (index.nodeBySpanId.get(spanId) !== node) {
      return false;
    }
  }
  const counts = (map: ReadonlyMap<SpanId, number>): string =>
    JSON.stringify([...map.entries()].sort(([left], [right]) => (left < right ? -1 : 1)));
  return (
    counts(fresh.missingParents) === counts(index.missingParents) &&
    snapshotIndex(fresh).aggregates === snapshotIndex(index).aggregates
  );
}

/** What a refusal must leave exactly as it found it. */
interface IndexSnapshot {
  readonly tree: TraceTree;
  readonly spans: number;
  readonly missingParents: number;
  readonly aggregates: string;
}

/** A snapshot of the parts of an index an extension would write. */
function snapshotIndex(index: TraceExtensionIndex): IndexSnapshot {
  const { tiers, kinds, producerIds, ...scalars } = index.aggregates;
  return {
    tree: index.tree,
    spans: index.nodeBySpanId.size,
    missingParents: index.missingParents.size,
    aggregates: JSON.stringify({
      ...scalars,
      tiers: [...tiers].sort(),
      kinds: [...kinds].sort(),
      producerIds: [...producerIds].sort(),
    }),
  };
}

/** The tree of an `extended` result, or a failure naming the refusal. */
function extendedTree(result: TraceExtensionResult): TraceTree {
  if (result.kind !== 'extended') {
    throw new Error(`expected an extension, got a refusal: ${result.reason}`);
  }
  return result.tree;
}

/** The index of a tree that must be extendable, or a failure saying it is not. */
function indexOf(tree: TraceTree | undefined, maxDepth?: number): TraceExtensionIndex {
  if (tree === undefined) {
    throw new Error('expected a correlated tree to index');
  }
  const index = indexTraceForExtension(tree, { maxDepth });
  if (index === undefined) {
    throw new Error(`expected trace ${tree.traceId} to be extendable`);
  }
  return index;
}

/** `value` and everything reachable from it, frozen, so a write would throw. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) {
      deepFreeze(member);
    }
  }
  return value;
}

/**
 * Asserts that `batch` is refused with `reason` and that the index, its tree
 * and the batch are exactly as they were.
 */
function expectRefusedUntouched(
  index: TraceExtensionIndex,
  batch: readonly TelemetryEvent[],
  reason: ExtensionRefusalReason,
  maxDepth?: number,
): void {
  const before = snapshotIndex(index);
  const treeText = JSON.stringify(index.tree);
  const frozen = deepFreeze([...batch]);

  const result = extendCorrelatedTrace(index, frozen, { maxDepth });

  expect(result).toEqual({ kind: 'refused', reason });
  expect(snapshotIndex(index)).toEqual(before);
  expect(index.tree).toBe(before.tree);
  expect(JSON.stringify(index.tree)).toBe(treeText);
}

/** The default trace `events` correlate into, or a failure saying they do not. */
function correlateTraceOrFail(
  events: readonly TelemetryEvent[],
  options?: { readonly maxDepth?: number },
): TraceTree {
  const tree = correlateTrace(events, DEFAULT_TRACE_ID, options);
  if (tree === undefined) {
    throw new Error('expected the events to correlate into a trace');
  }
  return tree;
}

/**
 * Asserts that `batch` really moves the anchor of the trace `rows` correlate
 * into — checked against a full correlation, not assumed — and that the
 * extension refuses it as `primary-change`, leaving the index untouched.
 */
function expectPrimaryChange(
  rows: readonly TelemetryEvent[],
  batch: readonly TelemetryEvent[],
): void {
  const before = correlateTraceOrFail(rows);
  const after = correlateTraceOrFail([...rows, ...batch]);
  expect(after.primaryRootSpanId).not.toBe(before.primaryRootSpanId);
  expectRefusedUntouched(indexOf(before), batch, 'primary-change');
}

/** A small, fully placed trace: an interaction, a fetch under it, a query under that. */
function smallTrace(): TelemetryEvent[] {
  return chainEvents([
    { kind: 'interaction', offsetMs: 0, durationMs: 100 },
    { kind: 'fetch', offsetMs: 5, durationMs: 80 },
    { kind: 'db.query', offsetMs: 10, durationMs: 40, producerId: SERVER_PRODUCER },
  ]);
}

/** The event at `position`, or a failure naming the gap. */
function eventAt(events: readonly TelemetryEvent[], position: number): TelemetryEvent {
  const event = events[position];
  if (event === undefined) {
    throw new Error(`expected a fixture event at ${position}`);
  }
  return event;
}

describe('incremental extension: the randomized differential', () => {
  it('matches a full correlation after every batch, and refuses only for documented reasons', () => {
    const tally = {
      steps: 0,
      extended: 0,
      grown: 0,
      repairsAdded: 0,
      rootsAdded: 0,
      lateParentSteps: 0,
      severalLateParents: 0,
      repairedLateParents: 0,
      rootLateParents: 0,
      movedToTheGuard: 0,
      lateParentRings: 0,
    };
    const refusals = new Map<ExtensionRefusalReason, number>();

    for (let seed = 1; seed <= 96; seed += 1) {
      const random = randomSource(seed * 7_919);
      const traceId = hexTrace(0x5_0000 + seed);
      // A shallow guard on every fourth trace and a moderate one on the next,
      // so moved subtrees land on and past the guard; a malformed producer on
      // every third and a fully scrambled arrival on every fifth.
      const maxDepth = seed % 4 === 0 ? 3 : seed % 4 === 1 ? 5 : undefined;
      const limit = maxDepth ?? DEFAULT_MAX_DEPTH;
      const options = { maxDepth };
      const rates = seed % 3 === 0 ? MALFORMED_RATES : REGULAR_RATES;
      const batches = arrivalBatches(
        random,
        generatedTrace(random, traceId, 40 + Math.floor(random() * 120), rates),
        seed % 5 === 0,
      );

      const stored: TelemetryEvent[] = [];
      const storedIds = new Set<string>();
      let index: TraceExtensionIndex | undefined;

      for (const batch of batches) {
        for (const event of batch) {
          if (!storedIds.has(event.id)) {
            storedIds.add(event.id);
            stored.push(event);
          }
        }
        const expected = correlateTrace(stored, traceId, options);

        if (index === undefined) {
          // Seeding, or re-seeding after a refusal or an unextendable tree.
          index = expected === undefined ? undefined : indexTraceForExtension(expected, options);
          continue;
        }

        tally.steps += 1;
        const before = snapshotIndex(index);
        const result = extendCorrelatedTrace(index, deepFreeze([...batch]), options);

        if (result.kind === 'extended') {
          tally.extended += 1;
          if (result.added > 0) {
            tally.grown += 1;
          }
          expect(result.tree).toStrictEqual(expected);
          expect(JSON.stringify(result.tree)).toBe(JSON.stringify(expected));
          expect(index.tree).toBe(result.tree);
          // Exactly one new object per changed node, none for anything else,
          // and no rebuild of a node that did not change.
          expect(result.nodesBuilt).toBe(freshNodeObjects(before.tree, result.tree));
          expect(everyRebuildIsNeeded(before.tree, result.tree)).toBe(true);
          // The index the next batch reads is the one this tree would get.
          expect(indexMatchesFreshIndex(index, maxDepth)).toBe(true);

          const shape = shapeOfStep(before.tree, result.tree);
          tally.repairsAdded += shape.repairAdded ? 1 : 0;
          tally.rootsAdded += shape.rootAdded ? 1 : 0;
          tally.lateParentSteps += shape.lateParents > 0 ? 1 : 0;
          tally.severalLateParents += shape.lateParents > 1 ? 1 : 0;
          tally.repairedLateParents += shape.repairedLateParent ? 1 : 0;
          tally.rootLateParents += shape.rootLateParent ? 1 : 0;
          tally.movedToTheGuard += shape.deepestMoved === limit ? 1 : 0;
          continue;
        }

        expect(GENERATED_REFUSALS).toContain(result.reason);
        expect(refusalIsJustified(result.reason, before.tree, batch, expected)).toBe(true);
        expect(snapshotIndex(index)).toEqual(before);
        refusals.set(result.reason, (refusals.get(result.reason) ?? 0) + 1);

        // A loop closed by the parent an orphan of the tree was waiting for.
        const waiting = new Set(index.missingParents.keys());
        if (
          result.reason === 'cycle' &&
          freshEventsOf(before.tree, batch).some((event) => waiting.has(event.spanId))
        ) {
          tally.lateParentRings += 1;
        }

        index = expected === undefined ? undefined : indexTraceForExtension(expected, options);
      }
    }

    // The case must exercise both halves: most steps extend, every case of the
    // fast path is taken many times, and every refusal the generator can
    // provoke is actually provoked. The run is seeded, so these are floors at
    // about half of what it produces — a generator change that stops
    // exercising a case fails here instead of silently testing less.
    expect(tally.steps).toBeGreaterThan(1_000);
    expect(tally.grown).toBeGreaterThan(tally.steps * 0.75);
    expect(tally.extended).toBeGreaterThan(tally.grown);
    expect(tally.repairsAdded).toBeGreaterThan(250);
    expect(tally.rootsAdded).toBeGreaterThan(20);
    expect(tally.lateParentSteps).toBeGreaterThan(180);
    expect(tally.severalLateParents).toBeGreaterThan(50);
    expect(tally.repairedLateParents).toBeGreaterThan(45);
    expect(tally.rootLateParents).toBeGreaterThan(3);
    expect(tally.movedToTheGuard).toBeGreaterThan(4);
    expect(tally.lateParentRings).toBeGreaterThan(4);
    expect([...refusals.keys()].sort()).toEqual([...GENERATED_REFUSALS].sort());
    // Refusals are the exception on this stream, not the rule.
    const refused = [...refusals.values()].reduce((sum, count) => sum + count, 0);
    expect(refused).toBeLessThan(tally.steps * 0.15);
  });
});

describe('incremental extension: indexing', () => {
  it('indexes a correlated tree with one entry per node and the spans its orphans miss', () => {
    const events = smallTrace();
    const neverArrives = nextSpanId();
    const orphan = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: neverArrives,
      startTime: at(3),
    });
    const tree = correlateTrace([...events, orphan], DEFAULT_TRACE_ID);
    const index = indexOf(tree);

    expect(index.traceId).toBe(DEFAULT_TRACE_ID);
    expect(index.depthLimit).toBe(DEFAULT_MAX_DEPTH);
    expect(index.primaryRootSpanId).toBe(eventAt(events, 0).spanId);
    expect(index.tree).toBe(tree);
    expect(index.nodeBySpanId.size).toBe(4);
    expect([...index.missingParents.entries()]).toEqual([[neverArrives, 1]]);
    expect(index.aggregates).toMatchObject({ nodeCount: 4, maxDepth: 2, orphanCount: 1 });
  });

  it('declines a tree a later batch could change in a way only a full correlation reproduces', () => {
    const duplicated = nextSpanId();
    const withDuplicate = correlateTrace(
      [
        makeEvent({ spanId: duplicated, kind: 'interaction' }),
        makeEvent({ spanId: duplicated, startTime: at(1) }),
      ],
      DEFAULT_TRACE_ID,
    );

    const first = nextSpanId();
    const second = nextSpanId();
    const withCycle = correlateTrace(
      [
        makeEvent({ spanId: nextSpanId(), kind: 'interaction' }),
        makeEvent({ spanId: first, parentSpanId: second, startTime: at(1) }),
        makeEvent({ spanId: second, parentSpanId: first, startTime: at(2) }),
      ],
      DEFAULT_TRACE_ID,
    );

    const truncated = correlateTrace(linearChain(5), DEFAULT_TRACE_ID, { maxDepth: 2 });

    const nonFinite = correlateTrace(
      [
        makeEvent({
          spanId: nextSpanId(),
          kind: 'interaction',
          duration: Number.POSITIVE_INFINITY,
        }),
      ],
      DEFAULT_TRACE_ID,
    );

    expect(withDuplicate?.duplicateSpanIds).toEqual([duplicated]);
    expect(withCycle?.orphanCount).toBe(1);
    expect(truncated?.truncated).toBe(true);
    for (const tree of [withDuplicate, withCycle, truncated, nonFinite]) {
      if (tree === undefined) {
        throw new Error('expected a correlated tree');
      }
      expect(indexTraceForExtension(tree)).toBeUndefined();
    }

    // Correlated under a deeper guard than the one it would be extended under.
    const deep = correlateTrace(linearChain(5), DEFAULT_TRACE_ID);
    if (deep === undefined) {
      throw new Error('expected a correlated tree');
    }
    expect(indexTraceForExtension(deep, { maxDepth: 2 })).toBeUndefined();
    expect(indexTraceForExtension(deep, { maxDepth: 4 })).toBeDefined();
  });

  it('declines a tree whose numbers or placements are not the ones its nodes add up to', () => {
    const tree = correlateTrace(smallTrace(), DEFAULT_TRACE_ID);
    if (tree === undefined) {
      throw new Error('expected a correlated tree');
    }

    expect(indexTraceForExtension({ ...tree, nodeCount: tree.nodeCount + 1 })).toBeUndefined();
    expect(indexTraceForExtension({ ...tree, primaryRootSpanId: nextSpanId() })).toBeUndefined();
    expect(indexTraceForExtension({ ...tree, roots: [] })).toBeUndefined();
  });
});

describe('incremental extension: exact application', () => {
  it('hangs new spans under the tree and under each other, exactly as a full correlation does', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const handler = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: eventAt(events, 1).spanId,
      kind: 'http.server',
      startTime: at(7),
      producerId: SERVER_PRODUCER,
    });
    const query = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: handler.spanId,
      kind: 'db.query',
      startTime: at(8),
      producerId: SERVER_PRODUCER,
    });
    const sibling = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: eventAt(events, 0).spanId,
      kind: 'render',
      startTime: at(1),
    });
    const batch = [query, sibling, handler];

    const result = extendCorrelatedTrace(index, deepFreeze([...batch]));
    const expected = correlateTrace([...events, ...batch], DEFAULT_TRACE_ID);

    expect(extendedTree(result)).toStrictEqual(expected);
    expect(JSON.stringify(extendedTree(result))).toBe(JSON.stringify(expected));
    // Three new nodes; the fetch and the root copied once each, the root only
    // once although two of its paths changed.
    expect(result).toMatchObject({ kind: 'extended', added: 3, nodesBuilt: 5 });
    expect(index.nodeBySpanId.size).toBe(6);
    expect(index.nodeBySpanId.get(query.spanId)?.depth).toBe(3);

    // And it keeps going from the extended tree.
    const late = makeEvent({ spanId: nextSpanId(), parentSpanId: query.spanId, startTime: at(9) });
    expect(extendedTree(extendCorrelatedTrace(index, [late]))).toStrictEqual(
      correlateTrace([...events, ...batch, late], DEFAULT_TRACE_ID),
    );
  });

  it('never mutates the tree it grew: a reader holding it keeps the tree it was served', () => {
    const events = smallTrace();
    const tree = correlateTrace(events, DEFAULT_TRACE_ID);
    const served = JSON.stringify(tree);
    const index = indexOf(tree);

    extendedTree(
      extendCorrelatedTrace(index, [
        makeEvent({
          spanId: nextSpanId(),
          parentSpanId: eventAt(events, 2).spanId,
          startTime: at(11),
        }),
      ]),
    );

    expect(JSON.stringify(tree)).toBe(served);
    expect(index.tree).not.toBe(tree);
  });

  it('treats a replayed row, or a row repeated in its batch, as a no-op that keeps the tree', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const tree = index.tree;
    const before = snapshotIndex(index);

    const replay = extendCorrelatedTrace(index, [eventAt(events, 2), eventAt(events, 0)]);
    expect(replay).toEqual({ kind: 'extended', tree, added: 0, nodesBuilt: 0 });
    expect(extendedTree(replay)).toBe(tree);
    expect(snapshotIndex(index)).toEqual(before);

    const fresh = makeEvent({ spanId: nextSpanId(), parentSpanId: eventAt(events, 0).spanId });
    const repeated = extendCorrelatedTrace(index, [fresh, eventAt(events, 1), fresh]);
    expect(repeated).toMatchObject({ kind: 'extended', added: 1 });
    expect(extendedTree(repeated)).toStrictEqual(
      correlateTrace([...events, fresh], DEFAULT_TRACE_ID),
    );
  });

  it('ignores events of another trace, as correlateTrace does', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const elsewhere = makeEvent({
      spanId: nextSpanId(),
      traceId: hexTrace(0xabc),
      kind: 'interaction',
    });

    expect(extendCorrelatedTrace(index, [elsewhere])).toMatchObject({ kind: 'extended', added: 0 });
  });

  it('merges new children of the primary root into its real prefix, ahead of the repaired suffix', () => {
    const root = makeEvent({
      spanId: nextSpanId(),
      kind: 'interaction',
      startTime: at(0),
      duration: 90,
    });
    const real = makeEvent({ spanId: nextSpanId(), parentSpanId: root.spanId, startTime: at(10) });
    // Repaired nodes: parents that never arrived, one sorting before the real
    // child and one after it — both still belong to the appended suffix.
    const earlyOrphan = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      startTime: at(2),
    });
    const lateOrphan = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      startTime: at(60),
    });
    const events = [root, real, earlyOrphan, lateOrphan];
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));

    const first = makeEvent({ spanId: nextSpanId(), parentSpanId: root.spanId, startTime: at(1) });
    const last = makeEvent({ spanId: nextSpanId(), parentSpanId: root.spanId, startTime: at(80) });
    const underOrphan = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: lateOrphan.spanId,
      startTime: at(61),
    });
    const batch = [last, underOrphan, first];

    const tree = extendedTree(extendCorrelatedTrace(index, batch));
    const expected = correlateTrace([...events, ...batch], DEFAULT_TRACE_ID);

    expect(tree).toStrictEqual(expected);
    expect(JSON.stringify(tree)).toBe(JSON.stringify(expected));
    const [anchor] = tree.roots;
    expect(spanIdsOfNodes(anchor?.children ?? [])).toEqual([
      first.spanId,
      real.spanId,
      last.spanId,
      earlyOrphan.spanId,
      lateOrphan.spanId,
    ]);
    expect(nodeFor(tree, underOrphan.spanId).depth).toBe(2);
    expect(tree.orphanCount).toBe(2);
  });

  it('extends a trace anchored on a repaired root, and a non-primary root of several', () => {
    // No genuine root: the canonically first parentless span anchors the trace.
    const fallback = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      kind: 'http.server',
    });
    const other = makeEvent({ spanId: nextSpanId(), parentSpanId: nextSpanId(), startTime: at(5) });
    const anchored = [fallback, other];
    const anchoredIndex = indexOf(correlateTrace(anchored, DEFAULT_TRACE_ID));
    const underAnchor = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: fallback.spanId,
      startTime: at(3),
    });
    expect(extendedTree(extendCorrelatedTrace(anchoredIndex, [underAnchor]))).toStrictEqual(
      correlateTrace([...anchored, underAnchor], DEFAULT_TRACE_ID),
    );

    // Two genuine roots; the server span is not the anchor.
    const click = makeEvent({ spanId: nextSpanId(), kind: 'interaction', startTime: at(4) });
    const server = makeEvent({ spanId: nextSpanId(), kind: 'http.server', startTime: at(1) });
    const rooted = [click, server];
    const rootedIndex = indexOf(correlateTrace(rooted, DEFAULT_TRACE_ID));
    const underServer = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: server.spanId,
      startTime: at(2),
    });
    const tree = extendedTree(extendCorrelatedTrace(rootedIndex, [underServer]));
    expect(tree).toStrictEqual(correlateTrace([...rooted, underServer], DEFAULT_TRACE_ID));
    expect(tree.primaryRootSpanId).toBe(click.spanId);
  });
});

describe('incremental extension: every refusal leaves the index untouched', () => {
  it('refuses a span id already in the tree under another event, or repeated in the batch', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const reused = eventAt(events, 2).spanId;

    expectRefusedUntouched(
      index,
      [makeEvent({ spanId: reused, parentSpanId: eventAt(events, 0).spanId })],
      'duplicate-span',
    );

    const twice = nextSpanId();
    expectRefusedUntouched(
      index,
      [
        makeEvent({ spanId: twice, parentSpanId: eventAt(events, 0).spanId }),
        makeEvent({ spanId: twice, parentSpanId: eventAt(events, 1).spanId }),
      ],
      'duplicate-span',
    );
  });

  it('refuses every batch that moves the anchor as primary-change, in each of its forms', () => {
    // A genuine root that outranks the anchor: the click lands after the
    // server span it caused had anchored the trace.
    const server = makeEvent({
      spanId: nextSpanId(),
      kind: 'http.server',
      startTime: at(10),
      producerId: SERVER_PRODUCER,
    });
    const serverRows = [server];
    expectPrimaryChange(serverRows, [
      makeEvent({ spanId: nextSpanId(), kind: 'interaction', startTime: at(20) }),
    ]);

    // A genuine root that ties the anchor's affinity and sorts ahead of it.
    const clickRows = smallTrace();
    expectPrimaryChange(clickRows, [
      makeEvent({ spanId: nextSpanId(), kind: 'interaction', startTime: at(-1) }),
    ]);

    // No genuine root yet: the anchor is a repair, the canonically first
    // parentless span. Any genuine root, however lowly, takes over from it.
    const anchorParent = nextSpanId();
    const fallback = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: anchorParent,
      kind: 'http.server',
      startTime: at(5),
      producerId: SERVER_PRODUCER,
    });
    const repairedRows = [
      fallback,
      makeEvent({ spanId: nextSpanId(), parentSpanId: nextSpanId(), startTime: at(9) }),
    ];
    expectPrimaryChange(repairedRows, [
      makeEvent({ spanId: nextSpanId(), kind: 'log', startTime: at(30) }),
    ]);

    // A new repair, or a new self-parent, that sorts ahead of that anchor.
    expectPrimaryChange(repairedRows, [
      makeEvent({ spanId: nextSpanId(), parentSpanId: nextSpanId(), startTime: at(1) }),
    ]);
    const self = nextSpanId();
    expectPrimaryChange(repairedRows, [
      makeEvent({ spanId: self, parentSpanId: self, startTime: at(2) }),
    ]);

    // The anchor's own missing parent arrives, itself waiting for a parent.
    expectPrimaryChange(repairedRows, [
      makeEvent({
        spanId: anchorParent,
        parentSpanId: nextSpanId(),
        kind: 'fetch',
        startTime: at(8),
      }),
    ]);
  });

  it('refuses a loop closed by late parents: a ring of two, and one inside the subtree it adopts', () => {
    const root = makeEvent({ spanId: nextSpanId(), kind: 'interaction', duration: 100 });
    const firstAwaited = nextSpanId();
    const secondAwaited = nextSpanId();
    const firstOrphan = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: firstAwaited,
      startTime: at(10),
    });
    const underFirst = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: firstOrphan.spanId,
      startTime: at(11),
    });
    const secondOrphan = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: secondAwaited,
      startTime: at(20),
    });
    const underSecond = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: secondOrphan.spanId,
      startTime: at(21),
    });
    const rows = [root, firstOrphan, underFirst, secondOrphan, underSecond];
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID));

    // Each awaited span arrives under the other orphan's subtree.
    const ring = [
      makeEvent({ spanId: firstAwaited, parentSpanId: underSecond.spanId, startTime: at(9) }),
      makeEvent({ spanId: secondAwaited, parentSpanId: underFirst.spanId, startTime: at(19) }),
    ];
    // An awaited span that arrives under the orphan it would adopt.
    const inside = [
      makeEvent({ spanId: firstAwaited, parentSpanId: underFirst.spanId, startTime: at(12) }),
    ];

    for (const batch of [ring, inside]) {
      expect(orphanReasonsIn(correlateTraceOrFail([...rows, ...batch]))).toContain('cycle');
      expectRefusedUntouched(index, batch, 'cycle');
    }
  });

  it('refuses a late parent that carries a moved subtree past the depth guard', () => {
    const root = makeEvent({ spanId: nextSpanId(), kind: 'interaction', duration: 100 });
    const awaited = nextSpanId();
    const orphan = makeEvent({ spanId: nextSpanId(), parentSpanId: awaited, startTime: at(10) });
    const child = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: orphan.spanId,
      startTime: at(11),
    });
    const grandchild = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: child.spanId,
      startTime: at(12),
    });
    const rows = [root, orphan, child, grandchild];
    // Depth 3 holds the orphan's chain as a repair: 1, 2, 3.
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID, { maxDepth: 3 }), 3);
    // Under the root the chain moves to 2, 3, 4.
    const batch = [makeEvent({ spanId: awaited, parentSpanId: root.spanId, startTime: at(9) })];

    expect(correlateTrace([...rows, ...batch], DEFAULT_TRACE_ID, { maxDepth: 3 })?.truncated).toBe(
      true,
    );
    expectRefusedUntouched(index, batch, 'max-depth', 3);
  });

  it('refuses a cycle inside the batch, and a child hanging under one', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const first = nextSpanId();
    const second = nextSpanId();
    const ring = [
      makeEvent({ spanId: first, parentSpanId: second }),
      makeEvent({ spanId: second, parentSpanId: first }),
    ];

    expectRefusedUntouched(index, ring, 'cycle');
    expectRefusedUntouched(
      index,
      [makeEvent({ spanId: nextSpanId(), parentSpanId: first }), ...ring],
      'cycle',
    );
  });

  it('refuses a new node past the depth guard, and a guard other than the index’s', () => {
    const chain = linearChain(3);
    const index = indexOf(correlateTrace(chain, DEFAULT_TRACE_ID, { maxDepth: 2 }), 2);

    expectRefusedUntouched(
      index,
      [makeEvent({ spanId: nextSpanId(), parentSpanId: eventAt(chain, 2).spanId })],
      'max-depth',
      2,
    );
    expectRefusedUntouched(
      index,
      [makeEvent({ spanId: nextSpanId(), parentSpanId: eventAt(chain, 0).spanId })],
      'options-mismatch',
      5,
    );
  });

  it('refuses siblings that tie on every canonical key', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const parentSpanId = eventAt(events, 0).spanId;
    const twin = makeEvent({ spanId: nextSpanId(), parentSpanId, startTime: at(50) });

    // Two new siblings tying on every key, and a new sibling tying an existing one.
    expectRefusedUntouched(index, [twin, { ...twin, spanId: nextSpanId() }], 'ambiguous-order');
    expectRefusedUntouched(
      index,
      [{ ...eventAt(events, 1), spanId: nextSpanId() }],
      'ambiguous-order',
    );

    // A new root tying the anchor (which names no parent), and two new roots
    // tying each other.
    expectRefusedUntouched(
      index,
      [{ ...eventAt(events, 0), spanId: nextSpanId() }],
      'ambiguous-order',
    );
    const server = makeEvent({ spanId: nextSpanId(), kind: 'http.server', startTime: at(70) });
    expectRefusedUntouched(index, [server, { ...server, spanId: nextSpanId() }], 'ambiguous-order');

    // A new repair tying a repair the anchor already holds.
    const repair = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      startTime: at(80),
    });
    const repaired = indexOf(correlateTrace([...events, repair], DEFAULT_TRACE_ID));
    expectRefusedUntouched(
      repaired,
      [{ ...repair, spanId: nextSpanId(), parentSpanId: nextSpanId() }],
      'ambiguous-order',
    );
  });

  it('refuses a stored row delivered with another arrival number, and a non-finite time', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const row = eventAt(events, 1);

    expectRefusedUntouched(index, [{ ...row, ingestSeq: row.ingestSeq + 10_000 }], 'stale-replay');
    expectRefusedUntouched(
      index,
      [makeEvent({ spanId: nextSpanId(), parentSpanId: row.spanId, startTime: Number.NaN })],
      'non-finite-time',
    );
  });

  it('refuses an index that no longer describes its tree', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    // A caller editing the index: the attachment point's ancestor is gone.
    index.nodeBySpanId.delete(eventAt(events, 1).spanId);

    expectRefusedUntouched(
      index,
      [makeEvent({ spanId: nextSpanId(), parentSpanId: eventAt(events, 2).spanId })],
      'inconsistent-index',
    );

    // A caller editing the missing-parent counts: the orphans on the anchor
    // are no longer the ones the index says a late parent adopts.
    const awaited = nextSpanId();
    const orphan = makeEvent({ spanId: nextSpanId(), parentSpanId: awaited, startTime: at(20) });
    const edited = indexOf(correlateTrace([...events, orphan], DEFAULT_TRACE_ID));
    edited.missingParents.set(awaited, 2);

    expectRefusedUntouched(
      edited,
      [makeEvent({ spanId: awaited, parentSpanId: eventAt(events, 0).spanId, startTime: at(15) })],
      'inconsistent-index',
    );
  });

  it('names every refusal from the closed vocabulary, and no longer refuses what now extends', () => {
    expect([...EXTENSION_REFUSAL_REASONS]).toEqual([
      'primary-change',
      'duplicate-span',
      'cycle',
      'max-depth',
      'ambiguous-order',
      'stale-replay',
      'non-finite-time',
      'options-mismatch',
      'inconsistent-index',
    ]);
    for (const reason of GENERATED_REFUSALS) {
      expect(EXTENSION_REFUSAL_REASONS).toContain(reason);
    }
    for (const extended of ['late-parent', 'new-root', 'self-parent', 'missing-parent']) {
      expect(EXTENSION_REFUSAL_REASONS).not.toContain(extended);
    }
  });
});

/**
 * A trace of `size` spans laid out as a `fanOut`-ary heap — span `i` hangs
 * from span `⌊(i − 1) / fanOut⌋` — so fan-out is bounded and depth is the
 * heap's.
 */
function heapTrace(size: number, fanOut: number): TelemetryEvent[] {
  const spans: SpanId[] = [];
  const events: TelemetryEvent[] = [];

  for (let position = 0; position < size; position += 1) {
    const spanId = nextSpanId();
    const parentSpanId = position === 0 ? undefined : spans[Math.floor((position - 1) / fanOut)];
    spans.push(spanId);
    events.push(
      makeEvent({
        spanId,
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
        kind: position === 0 ? 'interaction' : DEFAULT_KIND,
        startTime: at(position * 0.125),
        producerId: position % 2 === 0 ? BROWSER_PRODUCER : SERVER_PRODUCER,
      }),
    );
  }

  return events;
}

describe('incremental extension: the per-step bound', () => {
  it('builds at most batch × (depth + 1) nodes per step, the same at 2 000 and 20 000 nodes', () => {
    const fanOut = 12;
    // Depth-3 spans of a 12-ary heap: positions 157 to 1884. Both sizes hold
    // them, and both reach depth 4, so the bound is the same for both.
    const firstDepthThree = 1 + fanOut + fanOut * fanOut;
    const batchSize = 10;
    const steps = 4;
    const builtPerSize: number[][] = [];

    // The positions a step changes: its ten targets and every heap ancestor of
    // them, each counted once — what "every changed ancestor copied exactly
    // once" predicts, derived from the heap arithmetic rather than the code.
    const changedPositions = (step: number): number => {
      const changed = new Set<number>();
      for (let offset = 0; offset < batchSize; offset += 1) {
        let position = firstDepthThree + step * batchSize + offset;
        while (!changed.has(position)) {
          changed.add(position);
          if (position === 0) {
            break;
          }
          position = Math.floor((position - 1) / fanOut);
        }
      }
      return changed.size;
    };

    for (const size of [2_000, 20_000]) {
      const events = heapTrace(size, fanOut);
      const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
      const stored = [...events];
      const built: number[] = [];

      for (let step = 0; step < steps; step += 1) {
        const batch: TelemetryEvent[] = [];
        for (let offset = 0; offset < batchSize; offset += 1) {
          const target = eventAt(events, firstDepthThree + step * batchSize + offset);
          batch.push(
            makeEvent({
              spanId: nextSpanId(),
              parentSpanId: target.spanId,
              startTime: target.startTime + 0.0625,
            }),
          );
        }
        stored.push(...batch);

        const result = extendCorrelatedTrace(index, batch);
        const tree = extendedTree(result);
        if (result.kind !== 'extended') {
          throw new Error('unreachable: extendedTree already failed on a refusal');
        }

        expect(result.added).toBe(batchSize);
        expect(tree.maxDepth).toBe(4);
        expect(result.nodesBuilt).toBeLessThanOrEqual(batchSize * (tree.maxDepth + 1));
        expect(result.nodesBuilt).toBe(batchSize + changedPositions(step));
        built.push(result.nodesBuilt);
        expect(tree.nodeCount).toBe(stored.length);
      }

      // The last step's tree against a full correlation of every row.
      expect(index.tree).toStrictEqual(correlateTrace(stored, DEFAULT_TRACE_ID));
      builtPerSize.push(built);
    }

    // Ten times the tree, the same work per step.
    const [small, large] = builtPerSize;
    expect(small).toHaveLength(steps);
    expect(large).toEqual(small);
  });
});

describe('incremental extension: new genuine roots (case A)', () => {
  it('admits a root that ranks below the anchor at its canonical place, with its subtree', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const before = index.tree;
    // A server span whose browser half was never captured: parentless, and
    // timestamped ahead of the click by the other process's clock.
    const server = makeEvent({
      spanId: nextSpanId(),
      kind: 'http.server',
      startTime: at(-5),
      producerId: SERVER_PRODUCER,
    });
    const handler = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: server.spanId,
      kind: 'route.handler',
      startTime: at(-4),
      producerId: SERVER_PRODUCER,
    });
    const batch = [handler, server];

    const result = extendCorrelatedTrace(index, deepFreeze([...batch]));
    const tree = extendedTree(result);
    const expected = correlateTrace([...events, ...batch], DEFAULT_TRACE_ID);

    expect(tree).toStrictEqual(expected);
    expect(JSON.stringify(tree)).toBe(JSON.stringify(expected));
    expect(spanIdsOfNodes(tree.roots)).toEqual([server.spanId, eventAt(events, 0).spanId]);
    expect(tree.primaryRootSpanId).toBe(eventAt(events, 0).spanId);
    expect(nodeFor(tree, handler.spanId).depth).toBe(1);
    // The two new nodes and nothing else: the anchor's subtree is shared.
    expect(result).toMatchObject({ kind: 'extended', added: 2, nodesBuilt: 2 });
    expect(tree.roots[1]).toBe(before.roots[0]);
  });

  it('admits a root that ties the anchor’s affinity and sorts after it', () => {
    const events = smallTrace();
    const index = indexOf(correlateTrace(events, DEFAULT_TRACE_ID));
    const secondClick = makeEvent({ spanId: nextSpanId(), kind: 'interaction', startTime: at(50) });

    const tree = extendedTree(extendCorrelatedTrace(index, [secondClick]));

    expect(tree).toStrictEqual(correlateTrace([...events, secondClick], DEFAULT_TRACE_ID));
    expect(spanIdsOfNodes(tree.roots)).toEqual([eventAt(events, 0).spanId, secondClick.spanId]);
    expect(tree.primaryRootSpanId).toBe(eventAt(events, 0).spanId);
  });
});

describe('incremental extension: new repairs (case B)', () => {
  it('repairs a missing-parent and a self-parent span onto the anchor at their canonical place in the suffix', () => {
    const root = makeEvent({ spanId: nextSpanId(), kind: 'interaction', duration: 90 });
    const real = makeEvent({ spanId: nextSpanId(), parentSpanId: root.spanId, startTime: at(10) });
    const earlyRepair = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      startTime: at(2),
    });
    const lateRepair = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      startTime: at(60),
    });
    const rows = [root, real, earlyRepair, lateRepair];
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID));

    const absent = nextSpanId();
    const missing = makeEvent({ spanId: nextSpanId(), parentSpanId: absent, startTime: at(30) });
    const underMissing = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: missing.spanId,
      startTime: at(31),
    });
    const selfSpan = nextSpanId();
    const self = makeEvent({ spanId: selfSpan, parentSpanId: selfSpan, startTime: at(1) });
    const batch = [underMissing, self, missing];

    const result = extendCorrelatedTrace(index, deepFreeze([...batch]));
    const tree = extendedTree(result);
    const expected = correlateTrace([...rows, ...batch], DEFAULT_TRACE_ID);

    expect(tree).toStrictEqual(expected);
    expect(JSON.stringify(tree)).toBe(JSON.stringify(expected));
    expect(spanIdsOfNodes(primaryRootOf(tree).children)).toEqual([
      real.spanId,
      self.spanId,
      earlyRepair.spanId,
      missing.spanId,
      lateRepair.spanId,
    ]);
    expect(nodeFor(tree, missing.spanId)).toMatchObject({
      depth: 1,
      orphaned: true,
      orphanReason: 'missing-parent',
      missingParentSpanId: absent,
    });
    expect(nodeFor(tree, self.spanId)).toMatchObject({
      orphaned: true,
      orphanReason: 'self-parent',
    });
    expect('missingParentSpanId' in nodeFor(tree, self.spanId)).toBe(false);
    expect(nodeFor(tree, underMissing.spanId)).toMatchObject({ depth: 2, orphaned: false });
    // Three new nodes and the anchor that holds two of them.
    expect(result).toMatchObject({ added: 3, nodesBuilt: 4 });
    expect(index.aggregates.orphanCount).toBe(4);
    expect(index.missingParents.get(absent)).toBe(1);
    expect(index.missingParents.size).toBe(3);
  });

  it('repairs onto a repaired anchor a span that sorts after it', () => {
    const fallback = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      kind: 'http.server',
      startTime: at(5),
      producerId: SERVER_PRODUCER,
    });
    const other = makeEvent({ spanId: nextSpanId(), parentSpanId: nextSpanId(), startTime: at(9) });
    const rows = [fallback, other];
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID));
    const between = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      startTime: at(7),
    });

    const tree = extendedTree(extendCorrelatedTrace(index, [between]));

    expect(tree).toStrictEqual(correlateTrace([...rows, between], DEFAULT_TRACE_ID));
    expect(tree.primaryRootSpanId).toBe(fallback.spanId);
    expect(spanIdsOfNodes(primaryRootOf(tree).children)).toEqual([between.spanId, other.spanId]);
  });

  it('places a repair at depth 1 unchecked under a zero guard, and refuses a child under it', () => {
    const root = makeEvent({ spanId: nextSpanId(), kind: 'interaction' });
    const index = indexOf(correlateTrace([root], DEFAULT_TRACE_ID, { maxDepth: 0 }), 0);
    const repair = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: nextSpanId(),
      startTime: at(1),
    });

    const tree = extendedTree(extendCorrelatedTrace(index, [repair], { maxDepth: 0 }));
    expect(tree).toStrictEqual(correlateTrace([root, repair], DEFAULT_TRACE_ID, { maxDepth: 0 }));
    expect(tree.truncated).toBe(false);
    expect(nodeFor(tree, repair.spanId).depth).toBe(1);

    const child = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: repair.spanId,
      startTime: at(2),
    });
    expect(
      correlateTrace([root, repair, child], DEFAULT_TRACE_ID, { maxDepth: 0 })?.truncated,
    ).toBe(true);
    expectRefusedUntouched(index, [child], 'max-depth', 0);
  });
});

describe('incremental extension: late parents (case C)', () => {
  it('moves the orphans a late parent names under it, with their subtrees, clearing their flags', () => {
    const root = makeEvent({ spanId: nextSpanId(), kind: 'interaction', duration: 100 });
    const real = makeEvent({ spanId: nextSpanId(), parentSpanId: root.spanId, startTime: at(10) });
    const fetchSpan = nextSpanId();
    const request = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: fetchSpan,
      kind: 'http.server',
      startTime: at(20),
      producerId: SERVER_PRODUCER,
    });
    const handler = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: request.spanId,
      kind: 'route.handler',
      startTime: at(21),
      producerId: SERVER_PRODUCER,
    });
    const query = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: handler.spanId,
      kind: 'db.query',
      startTime: at(22),
      producerId: SERVER_PRODUCER,
    });
    // A second orphan naming the same fetch, and one waiting for another span.
    const log = makeEvent({ spanId: nextSpanId(), parentSpanId: fetchSpan, startTime: at(25) });
    const otherAwaited = nextSpanId();
    const unrelated = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: otherAwaited,
      startTime: at(30),
    });
    const rows = [root, real, request, handler, query, log, unrelated];
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID));
    expect(index.missingParents.get(fetchSpan)).toBe(2);

    const fetch = makeEvent({
      spanId: fetchSpan,
      parentSpanId: root.spanId,
      kind: 'fetch',
      startTime: at(19),
    });
    const result = extendCorrelatedTrace(index, deepFreeze([fetch]));
    const tree = extendedTree(result);
    const expected = correlateTrace([...rows, fetch], DEFAULT_TRACE_ID);

    expect(tree).toStrictEqual(expected);
    expect(JSON.stringify(tree)).toBe(JSON.stringify(expected));
    expect(spanIdsOfNodes(ancestorsOfSpanId(tree, query.spanId))).toEqual([
      root.spanId,
      fetchSpan,
      request.spanId,
      handler.spanId,
    ]);
    expect(spanIdsOfNodes(nodeFor(tree, fetchSpan).children)).toEqual([request.spanId, log.spanId]);
    for (const moved of [request, log]) {
      const node = nodeFor(tree, moved.spanId);
      expect(node).toMatchObject({ depth: 2, orphaned: false });
      expect('orphanReason' in node || 'missingParentSpanId' in node).toBe(false);
    }
    expect(nodeFor(tree, query.spanId).depth).toBe(4);
    expect(spanIdsOfNodes(primaryRootOf(tree).children)).toEqual([
      real.spanId,
      fetchSpan,
      unrelated.spanId,
    ]);
    // The fetch; the request's subtree and the log, one level deeper; the root.
    expect(result).toMatchObject({ added: 1, nodesBuilt: 6 });
    expect([...index.missingParents.entries()]).toEqual([[otherAwaited, 1]]);
    expect(index.aggregates).toMatchObject({ orphanCount: 1, maxDepth: 4, nodeCount: 8 });

    // The moved orphan is an ordinary node now: the next batch hangs under it.
    const late = makeEvent({ spanId: nextSpanId(), parentSpanId: query.spanId, startTime: at(23) });
    expect(extendedTree(extendCorrelatedTrace(index, [late]))).toStrictEqual(
      correlateTrace([...rows, fetch, late], DEFAULT_TRACE_ID),
    );
  });

  it('shares a moved subtree whose depth does not change: a late parent that is a genuine root', () => {
    const click = makeEvent({ spanId: nextSpanId(), kind: 'interaction', duration: 100 });
    const awaited = nextSpanId();
    const orphan = makeEvent({ spanId: nextSpanId(), parentSpanId: awaited, startTime: at(20) });
    const child = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: orphan.spanId,
      startTime: at(21),
    });
    const rows = [click, orphan, child];
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID));
    const childBefore = nodeFor(index.tree, child.spanId);

    // A parentless server span, below the click in affinity, is the parent.
    const server = makeEvent({
      spanId: awaited,
      kind: 'http.server',
      startTime: at(19),
      producerId: SERVER_PRODUCER,
    });
    const result = extendCorrelatedTrace(index, [server]);
    const tree = extendedTree(result);

    expect(tree).toStrictEqual(correlateTrace([...rows, server], DEFAULT_TRACE_ID));
    expect(spanIdsOfNodes(tree.roots)).toEqual([click.spanId, awaited]);
    expect(nodeFor(tree, orphan.spanId)).toMatchObject({ depth: 1, orphaned: false });
    // Only the server span, the orphan (its flags) and the click (its suffix).
    expect(result).toMatchObject({ added: 1, nodesBuilt: 3 });
    expect(nodeFor(tree, child.spanId)).toBe(childBefore);
  });

  it('lets a late parent that is itself a repair adopt an orphan', () => {
    const click = makeEvent({ spanId: nextSpanId(), kind: 'interaction', duration: 100 });
    const firstAwaited = nextSpanId();
    const secondAwaited = nextSpanId();
    const first = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: firstAwaited,
      startTime: at(20),
    });
    const second = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: secondAwaited,
      startTime: at(40),
    });
    const rows = [click, first, second];
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID));

    // One late parent waits for a parent of its own; the other names itself.
    const stillAwaited = nextSpanId();
    const batch = [
      makeEvent({ spanId: firstAwaited, parentSpanId: stillAwaited, startTime: at(18) }),
      makeEvent({ spanId: secondAwaited, parentSpanId: secondAwaited, startTime: at(38) }),
    ];
    const tree = extendedTree(extendCorrelatedTrace(index, deepFreeze([...batch])));
    const expected = correlateTrace([...rows, ...batch], DEFAULT_TRACE_ID);

    expect(tree).toStrictEqual(expected);
    expect(JSON.stringify(tree)).toBe(JSON.stringify(expected));
    expect(nodeFor(tree, firstAwaited)).toMatchObject({
      depth: 1,
      orphanReason: 'missing-parent',
      missingParentSpanId: stillAwaited,
    });
    expect(nodeFor(tree, secondAwaited)).toMatchObject({ depth: 1, orphanReason: 'self-parent' });
    expect(nodeFor(tree, first.spanId)).toMatchObject({ depth: 2, orphaned: false });
    expect(nodeFor(tree, second.spanId)).toMatchObject({ depth: 2, orphaned: false });
    expect([...index.missingParents.entries()]).toEqual([[stillAwaited, 1]]);
    expect(index.aggregates.orphanCount).toBe(2);
  });

  it('applies several late parents in one batch, one of them under a subtree another one moves', () => {
    const click = makeEvent({ spanId: nextSpanId(), kind: 'interaction', duration: 100 });
    const outerAwaited = nextSpanId();
    const innerAwaited = nextSpanId();
    const outer = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: outerAwaited,
      startTime: at(20),
    });
    const outerChild = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: outer.spanId,
      startTime: at(21),
    });
    const inner = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: innerAwaited,
      startTime: at(30),
    });
    const rows = [click, outer, outerChild, inner];
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID));

    const batch = [
      makeEvent({ spanId: innerAwaited, parentSpanId: outerChild.spanId, startTime: at(29) }),
      makeEvent({ spanId: outerAwaited, parentSpanId: click.spanId, startTime: at(19) }),
    ];
    const result = extendCorrelatedTrace(index, deepFreeze([...batch]));
    const tree = extendedTree(result);
    const expected = correlateTrace([...rows, ...batch], DEFAULT_TRACE_ID);

    expect(tree).toStrictEqual(expected);
    expect(JSON.stringify(tree)).toBe(JSON.stringify(expected));
    expect(spanIdsOfNodes(ancestorsOfSpanId(tree, inner.spanId))).toEqual([
      click.spanId,
      outerAwaited,
      outer.spanId,
      outerChild.spanId,
      innerAwaited,
    ]);
    expect(nodeFor(tree, inner.spanId).depth).toBe(5);
    expect(tree.orphanCount).toBe(0);
    expect(index.missingParents.size).toBe(0);
    expect(result).toMatchObject({ added: 2, nodesBuilt: 6 });
  });

  it('extends a late parent that lands a moved subtree exactly on the depth guard', () => {
    const root = makeEvent({ spanId: nextSpanId(), kind: 'interaction', duration: 100 });
    const awaited = nextSpanId();
    const orphan = makeEvent({ spanId: nextSpanId(), parentSpanId: awaited, startTime: at(10) });
    const child = makeEvent({
      spanId: nextSpanId(),
      parentSpanId: orphan.spanId,
      startTime: at(11),
    });
    const rows = [root, orphan, child];
    const index = indexOf(correlateTrace(rows, DEFAULT_TRACE_ID, { maxDepth: 3 }), 3);
    const batch = [makeEvent({ spanId: awaited, parentSpanId: root.spanId, startTime: at(9) })];

    const tree = extendedTree(extendCorrelatedTrace(index, batch, { maxDepth: 3 }));

    expect(tree).toStrictEqual(
      correlateTrace([...rows, ...batch], DEFAULT_TRACE_ID, { maxDepth: 3 }),
    );
    expect(tree.maxDepth).toBe(3);
    expect(tree.truncated).toBe(false);
  });
});

/**
 * One request of the demo-shaped stream: the dev-server preload's four spans,
 * which name the browser `fetch` that has not landed yet, and that `fetch`.
 */
function demoRequest(
  interaction: TelemetryEvent,
  offsetMs: number,
): { readonly server: TelemetryEvent[]; readonly fetch: TelemetryEvent } {
  const fetchSpan = nextSpanId();
  const server: TelemetryEvent[] = [];
  let parentSpanId = fetchSpan;
  const kinds: readonly TelemetryKind[] = ['http.server', 'route.handler', 'function', 'db.query'];
  kinds.forEach((kind, level) => {
    const event = makeEvent({
      spanId: nextSpanId(),
      parentSpanId,
      kind,
      startTime: at(offsetMs + 0.5 + level * 0.25),
      duration: 4 - level,
      producerId: SERVER_PRODUCER,
    });
    server.push(event);
    parentSpanId = event.spanId;
  });

  const fetch = makeEvent({
    spanId: fetchSpan,
    parentSpanId: interaction.spanId,
    kind: 'fetch',
    startTime: at(offsetMs),
    duration: 6,
  });
  return { server, fetch };
}

describe('incremental extension: the bounded fallback on a demo-shaped stream', () => {
  it('extends every server-span batch and every late fetch under one interaction, at a cost independent of the stream length', () => {
    const builtPerLength: number[][] = [];

    for (const requests of [40, 400]) {
      const interaction = makeEvent({
        spanId: nextSpanId(),
        kind: 'interaction',
        duration: requests * 10 + 10,
      });
      const stored: TelemetryEvent[] = [interaction];
      const index = indexOf(correlateTrace(stored, DEFAULT_TRACE_ID));
      const built: number[] = [];

      for (let request = 0; request < requests; request += 1) {
        const { server, fetch } = demoRequest(interaction, 1 + request * 10);

        // The server spans land first: an orphan subtree on the anchor. The
        // step builds the batch and copies the one node on its path.
        stored.push(...server);
        const serverStep = extendCorrelatedTrace(index, server);
        expect(serverStep).toMatchObject({ kind: 'extended', added: 4 });
        if (serverStep.kind !== 'extended') {
          throw new Error(`the server batch was refused: ${serverStep.reason}`);
        }
        expect(serverStep.nodesBuilt).toBe(server.length + 1);
        built.push(serverStep.nodesBuilt);

        // Then the fetch: the late parent adopts the orphan, whose four-node
        // subtree moves one level down; the anchor on the path is copied.
        stored.push(fetch);
        const fetchStep = extendCorrelatedTrace(index, [fetch]);
        expect(fetchStep).toMatchObject({ kind: 'extended', added: 1 });
        if (fetchStep.kind !== 'extended') {
          throw new Error(`the fetch batch was refused: ${fetchStep.reason}`);
        }
        expect(fetchStep.nodesBuilt).toBe(1 + server.length + 1);
        built.push(fetchStep.nodesBuilt);

        if (requests === 40 || request % 50 === 0) {
          const expected = correlateTrace(stored, DEFAULT_TRACE_ID);
          expect(fetchStep.tree).toStrictEqual(expected);
          expect(JSON.stringify(fetchStep.tree)).toBe(JSON.stringify(expected));
        }
      }

      const expected = correlateTrace(stored, DEFAULT_TRACE_ID);
      expect(index.tree).toStrictEqual(expected);
      expect(index.tree).toMatchObject({ nodeCount: stored.length, orphanCount: 0, maxDepth: 5 });
      expect(index.missingParents.size).toBe(0);
      builtPerLength.push(built);
    }

    // Ten times the stream, the same work per step: every step is bounded by
    // its batch, the subtree it moves and the path above it, never by N.
    const [short, long] = builtPerLength;
    expect(short).toHaveLength(80);
    expect(long).toHaveLength(800);
    expect(Math.max(...(long ?? []))).toBe(Math.max(...(short ?? [])));
    expect(long?.slice(0, short?.length)).toEqual(short);
  });
});
