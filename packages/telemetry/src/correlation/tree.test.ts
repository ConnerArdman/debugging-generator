/**
 * Colocated tests for `./tree.ts`'s **one assembly path**:
 * {@link assembleTraceTree}.
 *
 * `./correlator.test.ts` is this folder's acceptance gate and already drives
 * `buildTraceTree` through every correlation case; it is deliberately left as
 * it stands. What this file adds is the contract the incremental extension in
 * `./correlator.ts` rests on: a tree assembled from aggregates maintained
 * outside a walk is indistinguishable from the tree `buildTraceTree` derives by
 * walking — the same values, the same property set and the same key order
 * `JSON.stringify` emits. If the two ever diverged, an extended cached trace
 * would serialise differently from a rebuilt one and the panel-data response
 * would depend on which path had produced it.
 *
 * Fixtures are synthetic and deterministic: fixed epoch offsets, counter-minted
 * identifiers, no clock and no random source.
 */

import { describe, expect, it } from 'vitest';

import type { ProducerId, SpanId, TraceId } from '@debuggen/shared';

import type { TelemetryEvent } from '../schema/event.js';
import { TELEMETRY_KINDS, TELEMETRY_TIERS } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryTier } from '../schema/kinds.js';

import {
  assembleTraceTree,
  buildTraceTree,
  createTraceNode,
  nodeEndTime,
  walkNode,
} from './tree.js';
import type { TraceNode, TraceTree, TraceTreeAggregates } from './tree.js';

/** The epoch millisecond every offset below is measured from. */
const BASE_TIME = 1_768_000_000_000;

/** The trace every fixture belongs to. */
const TRACE_ID: TraceId = '00000000000000000000000000000abc';

/** Two producers, the browser agent's id sorting first. */
const BROWSER: ProducerId = 'prd_browseragent01';
const SERVER: ProducerId = 'prd_serverpreload1';

/** The counter behind every minted identifier. */
let ordinal = 0;

/** A fresh schema-shaped span id. */
function nextSpanId(): SpanId {
  ordinal += 1;
  return ordinal.toString(16).padStart(16, '0');
}

/** What a fixture varies. */
interface Fixture {
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly kind: TelemetryKind;
  readonly tier: TelemetryTier;
  readonly offsetMs: number;
  readonly durationMs: number;
  readonly producerId: ProducerId;
}

/** One persisted event, every field populated. */
function eventOf(fixture: Fixture): TelemetryEvent {
  ordinal += 1;
  return {
    id: `evt_${ordinal.toString(16).padStart(16, '0')}`,
    traceId: TRACE_ID,
    spanId: fixture.spanId,
    ...(fixture.parentSpanId !== undefined ? { parentSpanId: fixture.parentSpanId } : {}),
    kind: fixture.kind,
    name: `span-${fixture.spanId}`,
    startTime: BASE_TIME + fixture.offsetMs,
    duration: fixture.durationMs,
    tier: fixture.tier,
    attributes: {},
    status: 'ok',
    producerId: fixture.producerId,
    seq: ordinal,
    sessionId: 'ses_00000000000test',
    captureId: 'cap_00000000000test',
    ingestSeq: ordinal,
  };
}

/**
 * A hand-built three-level tree with an orphan and two producers, listing its
 * kinds and tiers **out of** declaration order so the assembler's ordering is
 * doing work.
 */
function sampleRoots(): readonly TraceNode[] {
  const rootSpan = nextSpanId();
  const fetchSpan = nextSpanId();
  const querySpan = nextSpanId();
  const orphanSpan = nextSpanId();

  const query = createTraceNode(
    eventOf({
      spanId: querySpan,
      parentSpanId: fetchSpan,
      kind: 'db.query',
      tier: 'db',
      offsetMs: 30.5,
      durationMs: 400.25,
      producerId: SERVER,
    }),
    [],
    2,
  );
  const fetchNode = createTraceNode(
    eventOf({
      spanId: fetchSpan,
      parentSpanId: rootSpan,
      kind: 'fetch',
      tier: 'browser',
      offsetMs: 10.125,
      durationMs: 600,
      producerId: BROWSER,
    }),
    [query],
    1,
  );
  const orphan = createTraceNode(
    eventOf({
      spanId: orphanSpan,
      parentSpanId: nextSpanId(),
      kind: 'http.server',
      tier: 'server',
      offsetMs: 900.75,
      durationMs: 5,
      producerId: SERVER,
    }),
    [],
    1,
    { orphanReason: 'missing-parent', missingParentSpanId: 'ffffffffffffffff' },
  );
  const root = createTraceNode(
    eventOf({
      spanId: rootSpan,
      kind: 'interaction',
      tier: 'browser',
      offsetMs: 0,
      durationMs: 700,
      producerId: BROWSER,
    }),
    [fetchNode, orphan],
    0,
  );
  const secondRoot = createTraceNode(
    eventOf({
      spanId: nextSpanId(),
      kind: 'log',
      tier: 'server',
      offsetMs: -2.5,
      durationMs: 0,
      producerId: SERVER,
    }),
    [],
    0,
  );

  return [root, secondRoot];
}

/**
 * The aggregates of `roots`, accumulated in **reverse** pre-order so no set is
 * filled in the order the walk would fill it.
 */
function aggregatesOf(roots: readonly TraceNode[]): TraceTreeAggregates {
  const nodes: TraceNode[] = [];
  for (const root of roots) {
    walkNode(root, (node) => {
      nodes.push(node);
    });
  }
  nodes.reverse();

  const tiers = new Set<TelemetryTier>();
  const kinds = new Set<TelemetryKind>();
  const producerIds = new Set<ProducerId>();
  let earliestStart: number | undefined;
  let latestEnd: number | undefined;
  for (const node of nodes) {
    tiers.add(node.event.tier);
    kinds.add(node.event.kind);
    producerIds.add(node.event.producerId);
    earliestStart = Math.min(earliestStart ?? Number.POSITIVE_INFINITY, node.event.startTime);
    latestEnd = Math.max(latestEnd ?? Number.NEGATIVE_INFINITY, nodeEndTime(node));
  }

  return {
    nodeCount: nodes.length,
    maxDepth: nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0),
    orphanCount: nodes.filter((node) => node.orphaned).length,
    earliestStart,
    latestEnd,
    tiers,
    kinds,
    producerIds,
  };
}

describe('assembleTraceTree', () => {
  it('assembles exactly the tree buildTraceTree derives, down to the key order', () => {
    const roots = sampleRoots();
    const extra = { duplicateSpanIds: [], truncated: false } as const;

    const built = buildTraceTree(TRACE_ID, roots, extra);
    const assembled = assembleTraceTree(TRACE_ID, roots, aggregatesOf(roots), extra);

    expect(assembled).toStrictEqual(built);
    expect(JSON.stringify(assembled)).toBe(JSON.stringify(built));
    expect(Object.keys(assembled)).toEqual([
      'traceId',
      'roots',
      'nodeCount',
      'maxDepth',
      'startTime',
      'endTime',
      'totalDuration',
      'orphanCount',
      'tiers',
      'kinds',
      'producerIds',
      'duplicateSpanIds',
      'truncated',
      'primaryRootSpanId',
    ]);
  });

  it('orders tiers and kinds by declaration and producers by code unit, whatever the set order', () => {
    const roots = sampleRoots();
    const aggregates = aggregatesOf(roots);
    const tree = assembleTraceTree(TRACE_ID, roots, aggregates);

    // Every tier and kind the sample reports, in declaration order — the sets
    // were filled in reverse pre-order, so a first-seen order would differ.
    expect(tree.tiers).toEqual(TELEMETRY_TIERS.filter((tier) => aggregates.tiers.has(tier)));
    expect(tree.tiers).toHaveLength(3);
    expect(tree.kinds).toEqual(TELEMETRY_KINDS.filter((kind) => aggregates.kinds.has(kind)));
    expect(tree.kinds).toHaveLength(5);
    expect(tree.producerIds).toEqual([BROWSER, SERVER]);
    expect(tree.nodeCount).toBe(5);
    expect(tree.maxDepth).toBe(2);
    expect(tree.orphanCount).toBe(1);
    expect(tree.startTime).toBe(BASE_TIME - 2.5);
    expect(tree.endTime).toBe(BASE_TIME + 900.75 + 5);
    expect(tree.totalDuration).toBe(908.25);
  });

  it('carries the builder facts and defaults the anchor to the first root', () => {
    const roots = sampleRoots();
    const aggregates = aggregatesOf(roots);
    const [first, second] = roots;
    if (first === undefined || second === undefined) {
      throw new Error('expected two sample roots');
    }

    const anchored: TraceTree = assembleTraceTree(TRACE_ID, roots, aggregates);
    expect(anchored.primaryRootSpanId).toBe(first.event.spanId);
    expect(anchored.duplicateSpanIds).toEqual([]);
    expect(anchored.truncated).toBe(false);

    const duplicates = [second.event.spanId];
    const overridden = assembleTraceTree(TRACE_ID, roots, aggregates, {
      primaryRootSpanId: second.event.spanId,
      duplicateSpanIds: duplicates,
      truncated: true,
    });
    expect(overridden.primaryRootSpanId).toBe(second.event.spanId);
    expect(overridden.duplicateSpanIds).toEqual(duplicates);
    expect(overridden.truncated).toBe(true);
    // Copied, never aliased: the caller's arrays stay theirs.
    expect(overridden.duplicateSpanIds).not.toBe(duplicates);
    expect(overridden.roots).not.toBe(roots);
    expect(overridden.roots).toEqual(roots);
  });

  it('assembles the empty trace with zeroes, empty lists and no anchor', () => {
    const empty = assembleTraceTree(TRACE_ID, [], {
      nodeCount: 0,
      maxDepth: 0,
      orphanCount: 0,
      earliestStart: undefined,
      latestEnd: undefined,
      tiers: new Set<TelemetryTier>(),
      kinds: new Set<TelemetryKind>(),
      producerIds: new Set<ProducerId>(),
    });

    expect(empty).toStrictEqual(buildTraceTree(TRACE_ID, []));
    expect(empty).not.toHaveProperty('primaryRootSpanId');
    expect(empty.startTime).toBe(0);
    expect(empty.endTime).toBe(0);
    expect(empty.totalDuration).toBe(0);
    expect(JSON.parse(JSON.stringify(empty))).toStrictEqual(empty);
  });
});
