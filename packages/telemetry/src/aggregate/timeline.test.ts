/**
 * The two contracts this module holds with its producers, and the identity it
 * hands its consumers.
 *
 * `./summary.ts`'s suite exercises the lanes and the metric arithmetic; this
 * one covers the three things that are invisible in an aggregate total and
 * wrong in a way a developer would act on:
 *
 * - **The state-transition trigger.** `../browser/state.ts` knows the span the
 *   work was attributed to — the interaction, or a settled request — and says
 *   so under the catalogued `triggerSpanId`. If the consumer ignores it and
 *   walks the parent chain instead, every row in `StateTransitionViewer` blames
 *   the commit the transition sat inside rather than the interaction that
 *   caused it: a plausible answer, and the wrong one (AAP 0.4.2, 0.6.2).
 * - **Truncation disclosure.** A capture that spent its transition budget
 *   emits one sentinel rather than a transition, and a list that arrives short
 *   without saying so is presented as exhaustive.
 * - **Edge identity in the dependency graph.** An edge id is built from two
 *   producer-controlled node ids. If the join is ambiguous, two distinct
 *   relationships collapse into one row whose count and duration are the sum of
 *   two unrelated things.
 * - **Event coordinates and lineage in the dependency graph.** A participant
 *   that collapsed one record is the one event a host can select, and a
 *   collapse of several is not; an edge whose callee joined through an
 *   asynchronous-continuation attribution is an inference, sometimes an
 *   ambiguous one (AAP 0.4.2). If either fact is lost here, the graph view can
 *   neither select an event nor tell a guessed relationship from a measured one.
 * - **The render cascade in the dependency graph.** Every render's span parent
 *   is its commit, so a graph built from parentage alone is a star around the
 *   commit. AAP 0.6.5 asks the render panel's graph for trigger → provider →
 *   consumers, which only the producer's recorded ancestry and triggers can
 *   give: if they are misread, the graph blames the commit — or the wrong
 *   component — for every render.
 *
 * Plus the determinism the panel-data contract needs: a location chosen from a
 * *set* of candidates rather than from the order they arrived in, since two
 * reads of one capture must send a developer to the same line (AAP 0.4.2's
 * stable ordering, which paging depends on).
 *
 * Events are built by hand here rather than loaded from a fixture: every case
 * turns on one attribute or one parent link, and a literal event is what makes
 * the case readable.
 */

import { describe, expect, it } from 'vitest';

import type { SourceLocation } from '@debuggen/shared';

import {
  DEPENDENCY_EDGE_ID_PREFIX,
  DEPENDENCY_RENDER_REASONS,
  MAX_CONTEXT_LABELS_PER_DEPENDENCY_EDGE,
  aggregateStateTransitions,
  buildDependencyGraph,
} from './timeline.js';
import type { DependencyGraphData, DependencyGraphEdge, DependencyGraphNode } from './timeline.js';
import type { TelemetryEvent } from '../schema/event.js';

/** The trace every event in this suite belongs to. */
const TRACE_ID = 'c'.repeat(32);

/** Monotonic counter behind the generated ids, span ids and sequences. */
let counter = 0;

/**
 * A persisted event with the fields these cases need and defaults for the rest.
 *
 * `ingestSeq` and `seq` follow construction order, which is what makes the
 * canonical ordering total and therefore the assertions independent of the
 * order the events are handed over in.
 */
function event(over: Partial<TelemetryEvent>): TelemetryEvent {
  counter += 1;
  const base: TelemetryEvent = {
    id: `evt_${String(counter).padStart(4, '0')}`,
    traceId: TRACE_ID,
    spanId: String(counter).padStart(16, '0'),
    kind: 'render',
    name: 'render',
    startTime: 1_700_000_000_000 + counter,
    duration: 1,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: 'producer-1',
    seq: counter,
    sessionId: 'ses_1',
    captureId: 'cap_1',
    ingestSeq: counter,
  };
  return { ...base, ...over };
}

/** A readable value summary, the shape a producer's diff emits. */
function summary(preview: string): { type: 'number'; preview: string; truncated: boolean } {
  return { type: 'number', preview, truncated: false };
}

describe('the state-transition trigger', () => {
  it('prefers the span the producer named over the parent chain', () => {
    const interaction = event({
      kind: 'interaction',
      name: 'click button',
      attributes: { 'event.type': 'click' },
    });
    const commit = event({
      kind: 'commit',
      name: 'commit',
      parentSpanId: interaction.spanId,
      attributes: { phase: 'update', renderCount: 1 },
    });
    const render = event({
      kind: 'render',
      name: 'render row',
      parentSpanId: commit.spanId,
      attributes: { component: 'ListRow', trigger: 'context' },
    });
    const transition = event({
      kind: 'state',
      name: 'ListRow context[0]',
      duration: 0,
      parentSpanId: render.spanId,
      attributes: {
        component: 'ListRow',
        hookIndex: 0,
        transitionSource: 'context',
        triggerSpanId: interaction.spanId,
        renderSpanId: render.spanId,
        fiberId: 12,
        previousValue: summary('1'),
        nextValue: summary('2'),
      },
    });

    const rows = aggregateStateTransitions([interaction, commit, render, transition]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.triggerSpanId).toBe(interaction.spanId);
    expect(row?.triggerEventId).toBe(interaction.id);
    expect(row?.triggerName).toBe('click button');
    expect(row?.triggerKind).toBe('interaction');
    // The parent chain would have answered with the render's parent commit.
    expect(row?.triggerEventId).not.toBe(commit.id);
  });

  it('keeps a producer-named trigger span that is outside the slice', () => {
    const absentSpanId = 'f'.repeat(16);
    const transition = event({
      kind: 'state',
      name: 'ListRow hook[0]',
      duration: 0,
      attributes: {
        component: 'ListRow',
        transitionSource: 'state',
        triggerSpanId: absentSpanId,
        previousValue: summary('1'),
        nextValue: summary('2'),
      },
    });

    const row = aggregateStateTransitions([transition])[0];

    expect(row?.triggerSpanId).toBe(absentSpanId);
    // No event id is invented for a span nobody sent: the field is only ever a
    // real event's id.
    expect(row?.triggerEventId).toBeUndefined();
    expect(row?.triggerName).toBeUndefined();
  });

  it('lets a producer-named event id win over a producer-named span id', () => {
    const cause = event({ kind: 'fetch', name: 'GET /resource', attributes: {} });
    const other = event({ kind: 'interaction', name: 'click button', attributes: {} });
    const transition = event({
      kind: 'state',
      name: 'ListRow hook[0]',
      duration: 0,
      attributes: {
        component: 'ListRow',
        triggerEventId: cause.id,
        triggerSpanId: other.spanId,
        previousValue: summary('1'),
      },
    });

    const row = aggregateStateTransitions([cause, other, transition])[0];

    expect(row?.triggerEventId).toBe(cause.id);
    expect(row?.triggerSpanId).toBe(cause.spanId);
  });

  it('still walks the parent chain when the producer named neither', () => {
    const interaction = event({ kind: 'interaction', name: 'click button', attributes: {} });
    const render = event({
      kind: 'render',
      name: 'render row',
      parentSpanId: interaction.spanId,
      attributes: { component: 'ListRow', trigger: 'state' },
    });
    const transition = event({
      kind: 'state',
      name: 'ListRow hook[0]',
      duration: 0,
      parentSpanId: render.spanId,
      attributes: { component: 'ListRow', previousValue: summary('1') },
    });

    const row = aggregateStateTransitions([interaction, render, transition])[0];

    expect(row?.triggerEventId).toBe(render.id);
    expect(row?.triggerSpanId).toBe(render.spanId);
  });

  it('carries the transition description the producer reported', () => {
    const transition = event({
      kind: 'state',
      name: 'ListRow context[2]',
      duration: 0,
      attributes: {
        component: 'ListRow',
        hookIndex: 2,
        hookLabel: 'ThemeContext',
        transitionSource: 'context',
        renderSpanId: '9'.repeat(16),
        fiberId: 48,
        previousValue: summary('1'),
        nextValue: summary('2'),
      },
    });

    const row = aggregateStateTransitions([transition])[0];

    expect(row?.transitionSource).toBe('context');
    expect(row?.renderSpanId).toBe('9'.repeat(16));
    expect(row?.fiberId).toBe(48);
    expect(row?.hookLabel).toBe('ThemeContext');
    expect(row?.changed).toBe(true);
  });

  it('drops a transition source this build does not recognise', () => {
    const transition = event({
      kind: 'state',
      name: 'ListRow hook[0]',
      duration: 0,
      attributes: { component: 'ListRow', transitionSource: 'telepathy' },
    });

    expect(aggregateStateTransitions([transition])[0]?.transitionSource).toBeUndefined();
  });

  it('reads the producer\u2019s truncation disclosure as an incomplete list', () => {
    const sentinel = event({
      kind: 'state',
      name: 'state transitions dropped',
      duration: 0,
      attributes: { component: 'ListRow', truncated: true, droppedTransitions: 41 },
    });

    const row = aggregateStateTransitions([sentinel])[0];

    expect(row?.truncated).toBe(true);
    expect(row?.droppedTransitions).toBe(41);
    // It describes no value, which is the shape a viewer must not render as a
    // transition.
    expect(row?.changed).toBe(false);
    expect(row?.previousValue).toBeUndefined();
  });
});

describe('dependency-graph edge identity', () => {
  /** A span whose participant identity is its own name. */
  function participant(name: string, durationMs: number, parentSpanId?: string): TelemetryEvent {
    return event({
      kind: 'function',
      tier: 'server',
      name,
      duration: durationMs,
      attributes: {},
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
    });
  }

  it('keeps two edges distinct when a span name contains the id separator', () => {
    // Without escaping, `edge:` + A + '=>' + B is byte-identical for these two
    // pairs, because each identity carries the other pair's separator.
    const head = participant('X=>dep:function:server:Y', 7);
    const tail = participant('Z', 7, head.spanId);
    const otherHead = participant('X', 100);
    const otherTail = participant('Y=>dep:function:server:Z', 100, otherHead.spanId);

    const graph = buildDependencyGraph([head, tail, otherHead, otherTail]);

    expect(graph.edges).toHaveLength(2);
    const ids = graph.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id.startsWith(DEPENDENCY_EDGE_ID_PREFIX)).toBe(true);
    }
    // Neither relationship absorbed the other's count or duration.
    expect(graph.edges.map((edge) => edge.count)).toEqual([1, 1]);
    expect(new Set(graph.edges.map((edge) => edge.totalDurationMs))).toEqual(new Set([7, 100]));
  });

  it('keeps an identity that already contains the escape distinct from its plain form', () => {
    const escaped = participant('A%3D', 3);
    const escapedChild = participant('child-one', 3, escaped.spanId);
    const plain = participant('A=', 5);
    const plainChild = participant('child-two', 5, plain.spanId);

    const graph = buildDependencyGraph([escaped, escapedChild, plain, plainChild]);

    const ids = graph.edges.map((edge) => edge.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('points from and to the raw node ids a consumer matches against', () => {
    const caller = participant('caller', 2);
    const callee = participant('callee', 2, caller.spanId);

    const graph = buildDependencyGraph([caller, callee]);

    const edge = graph.edges[0];
    expect(edge).toBeDefined();
    const nodeIds = graph.nodes.map((node) => node.id);
    expect(nodeIds).toContain(edge?.from);
    expect(nodeIds).toContain(edge?.to);
  });
});

describe('dependency-graph event coordinates and lineage', () => {
  /** A server function span whose participant identity is its own name. */
  function call(name: string, over: Partial<TelemetryEvent> = {}): TelemetryEvent {
    return event({ kind: 'function', tier: 'server', name, duration: 4, attributes: {}, ...over });
  }

  /** The lineage attributes an asynchronous continuation is written with (AAP 0.4.2). */
  const CONTINUATION = { lineage: 'async-continuation' } as const;

  /** The participant a graph built from these events gives the label, failing when absent. */
  function nodeLabelled(graph: DependencyGraphData, label: string): DependencyGraphNode {
    const node = graph.nodes.find((candidate) => candidate.label === label);
    if (node === undefined) {
      throw new Error(`the graph carries no participant labelled "${label}"`);
    }
    return node;
  }

  /** The graph's one edge, failing when it has another count. */
  function soleEdge(graph: DependencyGraphData): DependencyGraphEdge {
    expect(graph.edges).toHaveLength(1);
    const [edge] = graph.edges;
    if (edge === undefined) {
      throw new Error('the graph carries no edge');
    }
    return edge;
  }

  it('gives a single-record participant the id and trace of its one event', () => {
    const only = call('example.single');

    const node = nodeLabelled(buildDependencyGraph([only]), 'example.single');

    expect(node.count).toBe(1);
    expect(node.eventId).toBe(only.id);
    expect(node.traceId).toBe(only.traceId);
  });

  it('gives a participant that collapsed several records no event coordinate at all', () => {
    const first = call('example.repeated');
    const second = call('example.repeated');

    const node = nodeLabelled(buildDependencyGraph([first, second]), 'example.repeated');

    // Two records are not one event: neither id is chosen to stand for the
    // group, and the keys are absent rather than present with no value.
    expect(node.count).toBe(2);
    expect('eventId' in node).toBe(false);
    expect('traceId' in node).toBe(false);
  });

  it('counts a callee attributed through an asynchronous continuation as inferred', () => {
    const caller = call('example.caller');
    const callee = call('example.callee', {
      parentSpanId: caller.spanId,
      attributes: { ...CONTINUATION },
    });

    const edge = soleEdge(buildDependencyGraph([caller, callee]));

    expect(edge.count).toBe(1);
    expect(edge.inferredCount).toBe(1);
    expect('ambiguousCount' in edge).toBe(false);
  });

  it('counts an attribution chosen among several open candidates as ambiguous', () => {
    const caller = call('example.caller');
    const callee = call('example.callee', {
      parentSpanId: caller.spanId,
      attributes: {
        ...CONTINUATION,
        lineageAmbiguous: true,
        lineageCandidates: ['e'.repeat(16)],
      },
    });

    const edge = soleEdge(buildDependencyGraph([caller, callee]));

    expect(edge.inferredCount).toBe(1);
    expect(edge.ambiguousCount).toBe(1);
  });

  it('counts only the attributed share of an edge whose callees joined both ways', () => {
    const caller = call('example.caller');
    const nested = call('example.callee', { parentSpanId: caller.spanId });
    const continued = call('example.callee', {
      parentSpanId: caller.spanId,
      attributes: { ...CONTINUATION },
    });

    const edge = soleEdge(buildDependencyGraph([caller, nested, continued]));

    expect(edge.count).toBe(2);
    expect(edge.inferredCount).toBe(1);
    expect('ambiguousCount' in edge).toBe(false);
  });

  it('marks nothing on an edge whose callees were all nested inside their caller', () => {
    const caller = call('example.caller');
    const callee = call('example.callee', { parentSpanId: caller.spanId });

    const edge = soleEdge(buildDependencyGraph([caller, callee]));

    expect('inferredCount' in edge).toBe(false);
    expect('ambiguousCount' in edge).toBe(false);
  });

  it('reads an ambiguity flag without a claimed mechanism as no attribution', () => {
    // `lineageOf` reports no lineage for a qualifier that qualifies nothing, and
    // the edge follows it rather than re-reading the attribute keys itself.
    const caller = call('example.caller');
    const callee = call('example.callee', {
      parentSpanId: caller.spanId,
      attributes: { lineageAmbiguous: true },
    });

    const edge = soleEdge(buildDependencyGraph([caller, callee]));

    expect('inferredCount' in edge).toBe(false);
    expect('ambiguousCount' in edge).toBe(false);
  });

  it('survives a JSON round trip unchanged, as the panel-data response carries it', () => {
    const caller = call('example.caller');
    const nested = call('example.callee', { parentSpanId: caller.spanId });
    const continued = call('example.callee', {
      parentSpanId: caller.spanId,
      attributes: { ...CONTINUATION, lineageAmbiguous: true },
    });

    const graph = buildDependencyGraph([caller, nested, continued]);

    expect(JSON.parse(JSON.stringify(graph))).toStrictEqual(graph);
  });
});

describe('dependency-graph participant span kinds', () => {
  /** The participant of the given class and label, failing when absent. */
  function participant(
    graph: DependencyGraphData,
    kind: DependencyGraphNode['kind'],
    label: string,
  ): DependencyGraphNode {
    const node = graph.nodes.find(
      (candidate) => candidate.kind === kind && candidate.label === label,
    );
    if (node === undefined) {
      throw new Error(`the graph carries no ${kind} participant labelled "${label}"`);
    }
    return node;
  }

  it('keeps the one kind of a participant collapsed from a single kind of record', () => {
    const graph = buildDependencyGraph([
      event({ kind: 'render', name: 'render Example' }),
      event({ kind: 'render', name: 'render Example' }),
    ]);

    // Two records, one kind: the kind is listed once, not once per record. A
    // render is application code executing, so its class is `function`.
    const node = participant(graph, 'function', 'render Example');
    expect(node.count).toBe(2);
    expect(node.spanKinds).toEqual(['render']);
  });

  it('lists every distinct kind a participant collapsed, in the canonical kind order', () => {
    // Arrival order is commit before interaction; the published order is the
    // vocabulary's, so two reads of one capture always agree. Both kinds are
    // `ui-event`s, and an interaction with no readable identity attributes is
    // identified by its span name, so the three records are one participant.
    const graph = buildDependencyGraph([
      event({ kind: 'commit', name: 'example.shared' }),
      event({ kind: 'interaction', name: 'example.shared' }),
      event({ kind: 'commit', name: 'example.shared' }),
    ]);

    expect(participant(graph, 'ui-event', 'example.shared').spanKinds).toEqual([
      'interaction',
      'commit',
    ]);
  });

  it('keeps a render and the commit that performed it in different classes', () => {
    const commit = event({ kind: 'commit', name: 'example.shared' });
    const graph = buildDependencyGraph([
      commit,
      event({ kind: 'render', name: 'example.shared', parentSpanId: commit.spanId }),
    ]);

    // The commit is the page reacting as a whole; the render is a component,
    // which is code. Same name, two participants, one edge between them.
    expect(participant(graph, 'ui-event', 'example.shared').spanKinds).toEqual(['commit']);
    expect(participant(graph, 'function', 'example.shared').spanKinds).toEqual(['render']);
    expect(graph.edges).toHaveLength(1);
  });

  it('tells the two ends of one request apart by kind, though they share a class', () => {
    const request = event({
      kind: 'fetch',
      tier: 'browser',
      name: 'GET /resource',
      attributes: { 'http.method': 'GET' },
    });
    const served = event({
      kind: 'http.server',
      tier: 'server',
      name: 'GET /resource',
      parentSpanId: request.spanId,
      attributes: { 'http.route': '/resource' },
    });

    const graph = buildDependencyGraph([request, served]);
    const apiNodes = graph.nodes.filter((node) => node.kind === 'api');

    // Both are `api` participants; only their kinds say which end each is.
    expect(apiNodes).toHaveLength(2);
    expect(apiNodes.find((node) => node.tier === 'browser')?.spanKinds).toEqual(['fetch']);
    expect(apiNodes.find((node) => node.tier === 'server')?.spanKinds).toEqual(['http.server']);
  });

  it('sets the list on every participant it builds', () => {
    const graph = buildDependencyGraph([
      event({ kind: 'interaction', name: 'click' }),
      event({ kind: 'db.query', tier: 'db', name: 'SELECT 1' }),
      event({ kind: 'server.error', tier: 'server', name: 'Error' }),
    ]);

    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      expect(node.spanKinds?.length, node.id).toBeGreaterThan(0);
    }
  });
});

describe('participant source locations', () => {
  /** Two locations a resolution route could plausibly report with one confidence. */
  const first: SourceLocation = {
    file: 'src/one.ts',
    line: 10,
    column: 3,
    resolvedBy: 'code-graph',
    confidence: 0.6,
  };
  const second: SourceLocation = {
    file: 'src/two.ts',
    line: 4,
    column: 1,
    resolvedBy: 'source-map',
    confidence: 0.6,
  };

  /** One span of a single participant, carrying the location given. */
  function span(source: SourceLocation, at: number): TelemetryEvent {
    return event({
      kind: 'function',
      tier: 'server',
      name: 'computeTotals',
      duration: at,
      attributes: { symbol: 'computeTotals', module: 'src/service.ts' },
      source,
    });
  }

  it('chooses the same equally confident location whatever order the spans arrive in', () => {
    const forward = buildDependencyGraph([span(first, 1), span(second, 2)]);
    const backward = buildDependencyGraph([span(second, 2), span(first, 1)]);

    expect(forward.nodes).toHaveLength(1);
    expect(forward.nodes[0]?.source).toEqual(backward.nodes[0]?.source);
  });

  it('still prefers the more confident location from either direction', () => {
    const confident: SourceLocation = { ...second, resolvedBy: 'patch', confidence: 1 };

    const forward = buildDependencyGraph([span(first, 1), span(confident, 2)]);
    const backward = buildDependencyGraph([span(confident, 2), span(first, 1)]);

    expect(forward.nodes[0]?.source).toEqual(confident);
    expect(backward.nodes[0]?.source).toEqual(confident);
  });

  it('prefers a location that names a symbol over one that does not', () => {
    const named: SourceLocation = { ...first, symbol: 'computeTotals' };

    const forward = buildDependencyGraph([span(first, 1), span(named, 2)]);
    const backward = buildDependencyGraph([span(named, 2), span(first, 1)]);

    expect(forward.nodes[0]?.source).toEqual(named);
    expect(backward.nodes[0]?.source).toEqual(named);
  });
});

describe('dependency-graph render cascade', () => {
  /** A React commit: the span parent of every render it performed. */
  function commit(): TelemetryEvent {
    return event({ kind: 'commit', name: 'React commit', attributes: { phase: 'update' } });
  }

  /**
   * One render of a commit, as `../browser/react.ts` writes it: the component
   * as both name and `component`, an update unless the attributes say
   * otherwise. Construction order is `seq` order, which is emission order.
   */
  function render(
    parent: TelemetryEvent,
    component: string,
    attributes: Readonly<Record<string, unknown>>,
  ): TelemetryEvent {
    return event({
      kind: 'render',
      name: component,
      parentSpanId: parent.spanId,
      attributes: { component, phase: 'update', ...attributes },
    });
  }

  /** A hook transition observed inside one render, as `../browser/state.ts` writes it. */
  function transition(
    inside: TelemetryEvent,
    component: string,
    attributes: Readonly<Record<string, unknown>>,
  ): TelemetryEvent {
    return event({
      kind: 'state',
      name: `${component} hook[0]`,
      duration: 0,
      startTime: inside.startTime,
      parentSpanId: inside.spanId,
      attributes: { component, renderSpanId: inside.spanId, ...attributes },
    });
  }

  /** The participant with the label, failing when absent. */
  function nodeLabelled(graph: DependencyGraphData, label: string): DependencyGraphNode {
    const node = graph.nodes.find((candidate) => candidate.label === label);
    if (node === undefined) {
      throw new Error(`the graph carries no participant labelled "${label}"`);
    }
    return node;
  }

  /** The edge between the two labelled participants, failing when absent. */
  function edgeBetween(graph: DependencyGraphData, from: string, to: string): DependencyGraphEdge {
    const fromId = nodeLabelled(graph, from).id;
    const toId = nodeLabelled(graph, to).id;
    const edge = graph.edges.find(
      (candidate) => candidate.from === fromId && candidate.to === toId,
    );
    if (edge === undefined) {
      throw new Error(`the graph carries no edge from "${from}" to "${to}"`);
    }
    return edge;
  }

  /** Every edge as `from -> to` by label, in the graph's own order. */
  function edgeLabels(graph: DependencyGraphData): string[] {
    const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
    return graph.edges.map((edge) => `${labels.get(edge.from)} -> ${labels.get(edge.to)}`);
  }

  /**
   * A state root, a context provider nested in it, a consumer nested in that,
   * and a child the consumer re-rendered through its props: every link is
   * recorded by fiber identity.
   */
  function nestedCascade(): {
    readonly events: readonly TelemetryEvent[];
    readonly consumer: TelemetryEvent;
  } {
    const performed = commit();
    const root = render(performed, 'ClockProvider', { trigger: 'state', fiberId: 1 });
    const provider = render(performed, 'SessionProvider', {
      trigger: 'context',
      fiberId: 2,
      parentFiberId: 1,
      ownerChain: ['ClockProvider'],
    });
    const header = render(performed, 'Header', {
      trigger: 'context',
      fiberId: 3,
      parentFiberId: 2,
      ownerChain: ['SessionProvider', 'ClockProvider'],
    });
    const child = render(performed, 'ListItem', {
      trigger: 'props',
      fiberId: 4,
      parentFiberId: 3,
      ownerChain: ['Header', 'SessionProvider', 'ClockProvider'],
    });
    return { events: [performed, root, provider, header, child], consumer: header };
  }

  it('charges each render to the ancestor that rendered above it, not to the commit', () => {
    const graph = buildDependencyGraph(nestedCascade().events);

    expect(edgeLabels(graph).sort()).toEqual([
      'ClockProvider -> SessionProvider',
      'Header -> ListItem',
      'React commit -> ClockProvider',
      'SessionProvider -> Header',
    ]);
    // A chain, one column per link, and every link measured structure.
    expect(graph.layerCount).toBe(5);
    expect(nodeLabelled(graph, 'ListItem').layer).toBe(4);
    for (const edge of graph.edges) {
      expect('inferredCount' in edge, edge.id).toBe(false);
      expect('ambiguousCount' in edge, edge.id).toBe(false);
    }
  });

  it('draws nothing under the commit when an ancestor of the render rendered', () => {
    const graph = buildDependencyGraph(nestedCascade().events);
    const commitId = nodeLabelled(graph, 'React commit').id;

    // Only the render that started the cascade hangs from its commit.
    expect(graph.edges.filter((edge) => edge.from === commitId)).toHaveLength(1);
    expect(edgeBetween(graph, 'React commit', 'ClockProvider').renderTriggers).toEqual({
      state: 1,
    });
  });

  it('gives each component the roles its renders played, in vocabulary order', () => {
    const graph = buildDependencyGraph(nestedCascade().events);

    expect(nodeLabelled(graph, 'ClockProvider').roles).toEqual(['trigger', 'provider']);
    expect(nodeLabelled(graph, 'SessionProvider').roles).toEqual(['provider', 'consumer']);
    expect(nodeLabelled(graph, 'Header').roles).toEqual(['consumer']);
    // Downstream through its props: no role, and the key itself is absent.
    expect('roles' in nodeLabelled(graph, 'ListItem')).toBe(false);
    expect('roles' in nodeLabelled(graph, 'React commit')).toBe(false);
  });

  it('matches an ancestor by owner-chain name when no fiber identity was recorded', () => {
    const performed = commit();
    const graph = buildDependencyGraph([
      performed,
      render(performed, 'Layout', { trigger: 'props' }),
      render(performed, 'Header', { trigger: 'props', ownerChain: ['Toolbar', 'Layout'] }),
    ]);

    // `Toolbar` did not render, so the nearest recorded ancestor that did is
    // `Layout`, and the edge is nested structure rather than an inference.
    const edge = edgeBetween(graph, 'Layout', 'Header');
    expect(edge.renderTriggers).toEqual({ props: 1 });
    expect('inferredCount' in edge).toBe(false);
    expect(edgeLabels(graph)).not.toContain('React commit -> Header');
  });

  it('never charges a render to a same-named render emitted after it', () => {
    const performed = commit();
    const graph = buildDependencyGraph([
      performed,
      render(performed, 'Header', { trigger: 'props', ownerChain: ['Layout'] }),
      // Another instance of `Layout`, later in the commit: it cannot be the
      // ancestor of a render emitted before it.
      render(performed, 'Layout', { trigger: 'props' }),
    ]);

    expect(edgeLabels(graph).sort()).toEqual(['React commit -> Header', 'React commit -> Layout']);
  });

  it('skips the nearest ancestor by name when its fiber is known not to have rendered', () => {
    const performed = commit();
    const graph = buildDependencyGraph([
      performed,
      render(performed, 'List', { trigger: 'state', fiberId: 1 }),
      render(performed, 'ListItem', { trigger: 'props', fiberId: 2, parentFiberId: 1 }),
      // Its own parent is another `ListItem` (fiber 3), which did not render:
      // the rendered `ListItem` above is a sibling, not this child's parent.
      render(performed, 'Child', {
        trigger: 'props',
        fiberId: 5,
        parentFiberId: 3,
        ownerChain: ['ListItem', 'List'],
      }),
    ]);

    expect(edgeBetween(graph, 'List', 'Child').renderTriggers).toEqual({ props: 1 });
    expect(edgeLabels(graph)).not.toContain('ListItem -> Child');
  });

  it('charges a consumer with no rendered ancestor to the one candidate before it, as inferred', () => {
    const performed = commit();
    const graph = buildDependencyGraph([
      performed,
      render(performed, 'ClockProvider', { trigger: 'state', fiberId: 1 }),
      // Its recorded ancestry reaches no render of this commit.
      render(performed, 'Header', {
        trigger: 'context',
        fiberId: 9,
        parentFiberId: 8,
        ownerChain: ['Layout', 'Page'],
      }),
    ]);

    const edge = edgeBetween(graph, 'ClockProvider', 'Header');
    expect(edge.count).toBe(1);
    expect(edge.inferredCount).toBe(1);
    expect('ambiguousCount' in edge).toBe(false);
    expect(edgeLabels(graph)).not.toContain('React commit -> Header');
    expect(nodeLabelled(graph, 'ClockProvider').roles).toEqual(['trigger', 'provider']);
    expect(nodeLabelled(graph, 'Header').roles).toEqual(['consumer']);
  });

  it('charges it to the last-emitted provider as ambiguous when there were several', () => {
    const performed = commit();
    const events = [
      performed,
      render(performed, 'ClockProvider', { trigger: 'state', fiberId: 1 }),
      render(performed, 'SessionProvider', { trigger: 'context', fiberId: 2, parentFiberId: 1 }),
      render(performed, 'Header', { trigger: 'context', fiberId: 3, parentFiberId: 2 }),
      // Two instances whose ancestry reaches no render: both providers
      // rendered before them, and the last of those is the one charged.
      render(performed, 'ListItem', {
        trigger: 'context',
        fiberId: 20,
        parentFiberId: 19,
        ownerChain: ['List'],
      }),
      render(performed, 'ListItem', {
        trigger: 'context',
        fiberId: 21,
        parentFiberId: 19,
        ownerChain: ['List'],
      }),
    ];

    const graph = buildDependencyGraph(events);

    const edge = edgeBetween(graph, 'SessionProvider', 'ListItem');
    expect(edge.count).toBe(2);
    expect(edge.inferredCount).toBe(2);
    expect(edge.ambiguousCount).toBe(2);
    expect(edge.renderTriggers).toEqual({ context: 2 });
    expect(edgeLabels(graph)).not.toContain('ClockProvider -> ListItem');
    expect(nodeLabelled(graph, 'ListItem').roles).toEqual(['consumer']);
  });

  it('never lets one inferred provider make a later consumer look certain', () => {
    const performed = commit();
    const graph = buildDependencyGraph([
      performed,
      // Two cascade starts and no provider established by ancestry: both are
      // candidates for every consumer after them.
      render(performed, 'ClockProvider', { trigger: 'state', fiberId: 1 }),
      render(performed, 'SessionProvider', { trigger: 'state', fiberId: 2 }),
      render(performed, 'Header', { trigger: 'context', fiberId: 5, parentFiberId: 4 }),
      render(performed, 'Footer', { trigger: 'context', fiberId: 7, parentFiberId: 6 }),
    ]);

    // The first attribution does not shrink the second one's candidates.
    for (const consumer of ['Header', 'Footer']) {
      const edge = edgeBetween(graph, 'SessionProvider', consumer);
      expect(edge.inferredCount, consumer).toBe(1);
      expect(edge.ambiguousCount, consumer).toBe(1);
    }
    expect(nodeLabelled(graph, 'SessionProvider').roles).toEqual(['trigger', 'provider']);
    expect(nodeLabelled(graph, 'ClockProvider').roles).toEqual(['trigger']);
  });

  it('leaves a consumer with no candidate before it hanging from its commit', () => {
    const performed = commit();
    const graph = buildDependencyGraph([
      performed,
      render(performed, 'Header', { trigger: 'context', fiberId: 3, parentFiberId: 2 }),
      render(performed, 'ClockProvider', { trigger: 'state', fiberId: 1 }),
    ]);

    const edge = edgeBetween(graph, 'React commit', 'Header');
    expect('inferredCount' in edge).toBe(false);
    // Nothing was charged to it, so nothing makes it a provider.
    expect(nodeLabelled(graph, 'ClockProvider').roles).toEqual(['trigger']);
  });

  it('tallies why each callee rendered, a first render as mount, in vocabulary order', () => {
    const performed = commit();
    const graph = buildDependencyGraph([
      performed,
      render(performed, 'Parent', { trigger: 'state', fiberId: 1 }),
      render(performed, 'Child', { trigger: 'props', parentFiberId: 1 }),
      render(performed, 'Child', { trigger: 'unchanged', parentFiberId: 1 }),
      render(performed, 'Child', { phase: 'mount', parentFiberId: 1 }),
      // Neither a trigger nor a phase can be read: the producer's word for an
      // unevaluable classification, never a guess at either.
      render(performed, 'Child', { phase: 'hydrate', trigger: 'renamed', parentFiberId: 1 }),
      render(performed, 'Child', { trigger: 'props', parentFiberId: 1 }),
    ]);

    const edge = edgeBetween(graph, 'Parent', 'Child');
    expect(edge.count).toBe(5);
    expect(edge.renderTriggers).toEqual({ props: 2, unchanged: 1, unknown: 1, mount: 1 });
    const order = DEPENDENCY_RENDER_REASONS.filter(
      (reason) => reason in (edge.renderTriggers ?? {}),
    );
    expect(Object.keys(edge.renderTriggers ?? {})).toEqual(order);
  });

  it('carries no render tallies on an edge none of whose callees rendered', () => {
    const caller = event({ kind: 'function', tier: 'server', name: 'example.caller' });
    const callee = event({
      kind: 'function',
      tier: 'server',
      name: 'example.callee',
      parentSpanId: caller.spanId,
    });

    const { edges } = buildDependencyGraph([caller, callee]);

    // Exactly the shape an edge had before renders were tallied.
    expect(edges).toHaveLength(1);
    expect(Object.keys(edges[0] ?? {}).sort()).toEqual([
      'count',
      'from',
      'id',
      'to',
      'totalDurationMs',
    ]);
  });

  it('names the contexts the callee renders recorded as changed, sorted and de-duplicated', () => {
    const performed = commit();
    const provider = render(performed, 'SessionProvider', { trigger: 'state', fiberId: 1 });
    const first = render(performed, 'Header', { trigger: 'context', fiberId: 2, parentFiberId: 1 });
    const second = render(performed, 'Header', {
      trigger: 'context',
      fiberId: 3,
      parentFiberId: 1,
    });

    const graph = buildDependencyGraph([
      performed,
      provider,
      first,
      second,
      transition(first, 'Header', { transitionSource: 'context', hookLabel: 'Theme' }),
      transition(first, 'Header', { transitionSource: 'context', hookLabel: 'Session' }),
      transition(second, 'Header', { transitionSource: 'context', hookLabel: 'Session' }),
      // The component's own state is not a context, and neither is a
      // transition that names no label.
      transition(second, 'Header', { transitionSource: 'state', hookLabel: 'useState' }),
      transition(second, 'Header', { transitionSource: 'context' }),
    ]);

    expect(edgeBetween(graph, 'SessionProvider', 'Header').contexts).toEqual(['Session', 'Theme']);
    expect('contexts' in edgeBetween(graph, 'React commit', 'SessionProvider')).toBe(false);
  });

  it('keeps at most the bounded number of context labels, the first in sorted order', () => {
    const performed = commit();
    const provider = render(performed, 'SessionProvider', { trigger: 'state', fiberId: 1 });
    const consumer = render(performed, 'Header', { trigger: 'context', parentFiberId: 1 });
    const labels = Array.from(
      { length: MAX_CONTEXT_LABELS_PER_DEPENDENCY_EDGE + 3 },
      (_, index) => `Context${String(index).padStart(2, '0')}`,
    );

    const graph = buildDependencyGraph([
      performed,
      provider,
      consumer,
      ...[...labels]
        .reverse()
        .map((hookLabel) =>
          transition(consumer, 'Header', { transitionSource: 'context', hookLabel }),
        ),
    ]);

    expect(edgeBetween(graph, 'SessionProvider', 'Header').contexts).toEqual(
      labels.slice(0, MAX_CONTEXT_LABELS_PER_DEPENDENCY_EDGE),
    );
  });

  it('folds a component’s hook transitions into its participant without counting them', () => {
    const performed = commit();
    const header = event({
      kind: 'render',
      name: 'Header',
      duration: 3,
      parentSpanId: performed.spanId,
      attributes: { component: 'Header', phase: 'update', trigger: 'state' },
    });

    const graph = buildDependencyGraph([
      performed,
      header,
      transition(header, 'Header', { transitionSource: 'state', hookIndex: 0 }),
      transition(header, 'Header', { transitionSource: 'state', hookIndex: 1 }),
    ]);

    const node = nodeLabelled(graph, 'Header');
    expect(node.kind).toBe('function');
    expect(node.count).toBe(1);
    expect(node.totalDurationMs).toBe(3);
    expect(node.maxDurationMs).toBe(3);
    expect(node.spanIds).toEqual([header.spanId]);
    expect(node.spanKinds).toEqual(['render', 'state']);
    // Still the one record it collapsed, so still that record's coordinate.
    expect(node.eventId).toBe(header.id);
    // No participant of its own for a transition, and no self-edge.
    expect(graph.nodes.map((candidate) => candidate.label).sort()).toEqual([
      'Header',
      'React commit',
    ]);
    expect(graph.edges).toHaveLength(1);
  });

  it('counts transitions whose render is outside the slice as their component’s participant', () => {
    const outside = event({ kind: 'render', name: 'Footer' });
    const graph = buildDependencyGraph([
      transition(outside, 'Footer', { transitionSource: 'state', hookIndex: 0 }),
      transition(outside, 'Footer', { transitionSource: 'state', hookIndex: 1 }),
    ]);

    const node = nodeLabelled(graph, 'Footer');
    expect(node.kind).toBe('function');
    expect(node.count).toBe(2);
    expect(node.spanKinds).toEqual(['state']);
    expect('eventId' in node).toBe(false);
  });

  it('labels a long task by what it is, as code that blocked the main thread', () => {
    const graph = buildDependencyGraph([
      event({ kind: 'perf.longtask', name: 'self', duration: 80 }),
      event({ kind: 'perf.longtask', name: 'self', duration: 60 }),
    ]);

    const node = nodeLabelled(graph, 'Long task (self)');
    expect(node.kind).toBe('function');
    expect(node.id.endsWith('Long task (self)')).toBe(true);
    expect(node.count).toBe(2);
    expect(node.spanKinds).toEqual(['perf.longtask']);
  });

  it('classes the document navigation and its performance entries as request boundaries', () => {
    const graph = buildDependencyGraph([
      event({ kind: 'navigation', name: 'navigation' }),
      event({ kind: 'perf.entry', name: 'first-paint', attributes: { 'entry.type': 'paint' } }),
    ]);

    expect(nodeLabelled(graph, 'navigation').kind).toBe('api');
    expect(nodeLabelled(graph, 'first-paint').kind).toBe('api');
  });

  it('survives a JSON round trip unchanged, roles, tallies and contexts included', () => {
    const { events, consumer } = nestedCascade();
    const graph = buildDependencyGraph([
      ...events,
      transition(consumer, 'Header', { transitionSource: 'context', hookLabel: 'Session' }),
    ]);

    expect(edgeBetween(graph, 'SessionProvider', 'Header').contexts).toEqual(['Session']);
    expect(JSON.parse(JSON.stringify(graph))).toStrictEqual(graph);
  });

  it('builds the same graph whatever order the events arrive in', () => {
    const performed = commit();
    const events = [
      ...nestedCascade().events,
      performed,
      render(performed, 'ClockProvider', { trigger: 'state', fiberId: 1 }),
      render(performed, 'SessionProvider', { trigger: 'context', fiberId: 2, parentFiberId: 1 }),
      render(performed, 'ListItem', { trigger: 'context', fiberId: 7, ownerChain: ['List'] }),
      render(performed, 'ListItem', { trigger: 'context', fiberId: 8, ownerChain: ['List'] }),
      event({ kind: 'perf.longtask', name: 'self', duration: 70 }),
    ];
    // A fixed permutation rather than a random one, so a failure reproduces:
    // stepping by 5 visits every index once because 5 and 11 share no factor.
    expect(events).toHaveLength(11);
    const shuffled = events.flatMap((_, index) => {
      const picked = events[(index * 5 + 3) % events.length];
      return picked === undefined ? [] : [picked];
    });
    expect(new Set(shuffled).size).toBe(events.length);

    const forward = buildDependencyGraph(events);

    expect(buildDependencyGraph(shuffled)).toStrictEqual(forward);
    expect(buildDependencyGraph([...events].reverse())).toStrictEqual(forward);
  });
});
