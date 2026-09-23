/**
 * `host/registry` — the colocated suite that holds the component registry to the
 * node catalogue, and every catalogued component to a recorded panel-data
 * response.
 *
 * ## The two jobs AAP 0.6.2 gives this file, and why they are one file
 *
 * The clause is explicit on both halves: `src/host/registry.ts` "maps each
 * catalog node type → component and is checked by `registry.test.ts` for
 * one-to-one coverage of `packages/panel-schema/src/catalog.ts`", and every
 * catalogued component is rendered here "against a recorded
 * `POST /sessions/:id/panel-data` response for its source". They belong
 * together because the second is what makes the first mean anything: a registry
 * whose keys match the catalogue but whose components cannot draw the data their
 * node's source resolves to is a mapping that type-checks and fails on screen.
 *
 *   1. **Coverage, in both directions.** No catalogue entry without a component
 *      — "a catalog entry without a renderer component fails
 *      `packages/panel-renderer/src/host/registry.test.ts`" — and no registry
 *      component without a catalogue entry, which is the direction that catches
 *      a node type deleted from the vocabulary while its component stayed
 *      registered and reachable.
 *   2. **Every component reaches its success state from a recorded response.**
 *      One response per data source, shaped as the service's panel-data route
 *      answers (AAP 0.4.2: discriminated on `source`, with `total` and
 *      `nextOffset` on the array-valued sources), resolved through the very
 *      seam the two host surfaces implement — `./DataProvider` — and rendered
 *      through `./NodeRenderer`, which is the only supported way a node reaches
 *      a component.
 *
 * Alongside them, the two failure and wiring properties that the registry's own
 * contract rests on: a node type the registry has no component for renders an
 * error state and never a blank area (AAP 0.6.2, 0.5.5), and an interaction
 * inside a dispatched component reaches the ambient `PanelActions` — proving the
 * registry's *prop wiring*, not merely its keys. The depth of each component's
 * own interactions stays in `../components/*.test.tsx`; this file proves the
 * wiring exists.
 *
 * ## What the sixteen cases are driven by
 *
 * `PANEL_NODE_TYPES` and `PANEL_NODE_CATALOG`, never a list of literals kept
 * here. The case table is a `Record` over `PanelNodeType`, so a node type added
 * to the vocabulary is a **compile** error in this file (a missing property)
 * before it is a failing assertion, and each case's query source is read from
 * its own catalogue entry (`defaultSource ?? sources[0]`) rather than restated —
 * a source removed from an entry therefore changes which recorded response that
 * node resolves against, which is exactly the coupling this suite is for.
 *
 * ## Fixture vocabulary (AAP 0.5.4 and 0.5.2)
 *
 * Every literal below is reviewed copy. The component labels are `Alpha` and
 * `Beta`, the one path is a generic `src/example/…`, the one URL is on
 * `localhost` with its query value already replaced (`?id=?`), the one statement
 * is a parameterized `SELECT … WHERE id = $1`, and no route path, application
 * name or demonstration identifier appears anywhere — in the data, in the names
 * of the cases or in these comments. The data is also shaped like data that has
 * already passed redaction: no header values, no request or response bodies, no
 * database rows, and the two state previews are short strings rather than
 * captured values.
 *
 * ## Harness conventions (shared with `../components/*.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`, and `afterEach(cleanup)`
 *     registered explicitly, exactly as every sibling suite does — the
 *     `panel-renderer` project enables globals only so that
 *     `@testing-library/react` can register its automatic cleanup.
 *   - **No JSX.** This file is `.ts`, because the module it covers is
 *     `registry.ts` and the AAP names both. Elements are built with
 *     `createElement`, which is what the automatic runtime would have produced
 *     and what the registry's own adapters use.
 *   - **Stub providers are built with the library's own `createDataProvider`**,
 *     so each case exercises the seam the DevTools panel and the editor webview
 *     implement, including its guarantee that a response answers for the source
 *     it was asked about. The resolver is a `vi.fn` and every query it receives
 *     is recorded for the cases to assert on.
 *   - **In-file recorded responses**, no fixture files: this folder's brief puts
 *     the recorded panel-data responses here, and they are typed
 *     `DataQueryResponse<Source>` so that drift in any telemetry result shape
 *     fails this file at `tsc -b` rather than at render time.
 *   - **Queries by role and accessible name**, with a class read only off an
 *     element already obtained semantically (no `jest-dom` matcher is available
 *     in this repository), and no timers: post-resolution assertions go through
 *     `findBy…` and interactions through `userEvent`.
 *   - **Nothing from outside this package's dependencies.** No protocol type, no
 *     Node builtin, no `chrome.*`, no `fetch` and no socket: the renderer
 *     reaches data only through the interfaces it declares, and neither does its
 *     suite. Every telemetry import is type-only.
 *
 * @see ./registry for the mapping under test and why each entry is an adapter.
 * @see ./NodeRenderer for the dispatch, the recursion and the failure state.
 * @see ./DataProvider for the panel-data seam these stubs implement.
 */

import { PANEL_NODE_CATALOG, PANEL_NODE_TYPES } from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySource, PanelNode, PanelNodeType } from '@debuggen/panel-schema';
import { formatSourceLocation } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type {
  ComponentTreeNode,
  ComponentTreeSnapshot,
  DependencyGraphData,
  MetricValue,
  QueryGroup,
  RenderStat,
  RequestGroup,
  StateTransition,
  TelemetryEvent,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';
import { cleanup, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, createDataProvider } from './DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from './DataProvider';
import { NodeRenderer } from './NodeRenderer';
import { PanelActionsContext } from './PanelActions';
import type { PanelActions, PanelEventRef } from './PanelActions';
import { PANEL_COMPONENT_REGISTRY, componentForNodeType } from './registry';
import type { PanelNodeComponent } from './registry';

afterEach(cleanup);

/*
 * ---------------------------------------------------------------------------
 * Identifiers and generic vocabulary
 *
 * Shapes first, so a reader can check a fixture against the contract without
 * leaving this section: trace and span identifiers are lower-case hexadecimal of
 * the lengths the event schema requires (32 and 16), timestamps are Unix epoch
 * milliseconds inside the schema's accepted window, and durations are
 * milliseconds.
 * ---------------------------------------------------------------------------
 */

/** The one trace every fixture record belongs to: 32 lower-case hexadecimal digits. */
const TRACE_ID = 'ab12cd34ef567890ab12cd34ef567890';

/** The session the recorded page was captured in. */
const SESSION_ID = 'ses_example_0001';

/** The capture the recorded page belongs to. */
const CAPTURE_ID = 'cap_example_0001';

/** The page document's agent, as a producer of browser-tier records. */
const BROWSER_PRODUCER_ID = 'prod_browser_0001';

/** The instrumented server process, as a producer of server- and db-tier records. */
const SERVER_PRODUCER_ID = 'prod_server_0001';

/**
 * The window every fixture timestamp is measured from, in Unix epoch
 * milliseconds — a fixed instant, so nothing in this suite depends on the clock.
 */
const BASE_START_MS = 1_767_225_600_000;

/** How long the recorded interaction took, in milliseconds. */
const INTERACTION_DURATION_MS = 320;

/**
 * One span identifier, 16 lower-case hexadecimal digits.
 *
 * @param index The span's position in the fixture trace, 1-based.
 * @returns The identifier for that position.
 */
function spanIdFor(index: number): string {
  return `0a1b2c3d4e5f60${index.toString(16).padStart(2, '0')}`;
}

/** The first of the two component labels the fixtures use. */
const FIRST_COMPONENT = 'Alpha';

/** The second, so that a view showing more than one row shows two distinct ones. */
const SECOND_COMPONENT = 'Beta';

/** A prop name, for the render statistics' changed-input columns. */
const CHANGED_PROP = 'items';

/** The path part of the one request the fixtures record. */
const RESOURCE_PATH = '/resource';

/** The request method, from the generic vocabulary. */
const REQUEST_METHOD = 'GET';

/**
 * The one URL the fixtures carry, on `localhost` and already redacted: the path
 * is retained and the query parameter's value is replaced per key, which is what
 * `packages/telemetry/src/redaction/url.ts` produces (AAP 0.5.2).
 */
const RESOURCE_URL = `http://localhost${RESOURCE_PATH}?id=?`;

/** The parameterized statement, with its placeholder and no inline literal. */
const STATEMENT = 'SELECT id FROM items WHERE id = $1';

/** A location resolved through the code graph, for the component that rendered. */
const COMPONENT_SOURCE: SourceLocation = {
  file: 'src/example/widget.tsx',
  line: 42,
  column: 7,
  symbol: 'ExampleWidget',
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

/** A location resolved through the code graph, for the statement's caller. */
const CALLER_SOURCE: SourceLocation = {
  file: 'src/example/service.ts',
  line: 84,
  column: 9,
  symbol: 'loadExample',
  resolvedBy: 'code-graph',
  confidence: 0.8,
};

/** A third location, so the division's two panes point at different places. */
const SECOND_SOURCE: SourceLocation = {
  file: 'src/example/panel.ts',
  line: 12,
  column: 3,
  symbol: 'openExample',
  resolvedBy: 'patch',
  confidence: 1,
};

/*
 * ---------------------------------------------------------------------------
 * The recorded records
 *
 * One correlated interaction, five records deep and spanning all three tiers,
 * which is what lets a single page answer the `trace`, `spans` and `events`
 * sources with data each of their views can actually draw: a browser-tier
 * interaction, the request it made, the server work that request reached, the
 * statement that work ran, and the commit the response caused.
 * ---------------------------------------------------------------------------
 */

/**
 * One persisted record, with the store-assigned fields the panel-data route
 * answers with.
 *
 * Written as a builder rather than five literals so that the fields every
 * record shares — the trace, the session, the capture — are stated once, and a
 * field added to the persisted schema is a single compile error here.
 *
 * @param record The record's own fields, less the ones shared with every other.
 * @returns The persisted record.
 */
function makeEvent(
  record: Omit<TelemetryEvent, 'traceId' | 'sessionId' | 'captureId'>,
): TelemetryEvent {
  return { ...record, traceId: TRACE_ID, sessionId: SESSION_ID, captureId: CAPTURE_ID };
}

/** The interaction the recorded page began with: the root of the fixture trace. */
const INTERACTION_EVENT: TelemetryEvent = makeEvent({
  id: 'evt_example_0001',
  spanId: spanIdFor(1),
  kind: 'interaction',
  name: 'pointer activation',
  startTime: BASE_START_MS,
  duration: INTERACTION_DURATION_MS,
  tier: 'browser',
  attributes: { 'event.type': 'click', 'target.tagName': 'BUTTON' },
  status: 'ok',
  producerId: BROWSER_PRODUCER_ID,
  seq: 0,
  ingestSeq: 1,
});

/** The request the handler made, and the span whose id crossed to the server. */
const FETCH_EVENT: TelemetryEvent = makeEvent({
  id: 'evt_example_0002',
  spanId: spanIdFor(2),
  parentSpanId: spanIdFor(1),
  kind: 'fetch',
  name: `${REQUEST_METHOD} ${RESOURCE_PATH}`,
  startTime: BASE_START_MS + 8,
  duration: 240,
  tier: 'browser',
  attributes: {
    'http.method': REQUEST_METHOD,
    url: RESOURCE_URL,
    'http.status_code': 200,
    initiator: FIRST_COMPONENT,
  },
  status: 'ok',
  producerId: BROWSER_PRODUCER_ID,
  seq: 1,
  ingestSeq: 2,
  source: COMPONENT_SOURCE,
});

/** The server work that request reached, reported by the instrumented process. */
const SERVER_EVENT: TelemetryEvent = makeEvent({
  id: 'evt_example_0003',
  spanId: spanIdFor(3),
  parentSpanId: spanIdFor(2),
  kind: 'http.server',
  name: `${REQUEST_METHOD} ${RESOURCE_PATH}`,
  startTime: BASE_START_MS + 18,
  duration: 210,
  tier: 'server',
  attributes: {
    'http.method': REQUEST_METHOD,
    'http.route': RESOURCE_PATH,
    'http.status_code': 200,
  },
  status: 'ok',
  producerId: SERVER_PRODUCER_ID,
  seq: 0,
  ingestSeq: 3,
});

/** The statement that work ran: parameterized text, a row count and no rows. */
const QUERY_EVENT: TelemetryEvent = makeEvent({
  id: 'evt_example_0004',
  spanId: spanIdFor(4),
  parentSpanId: spanIdFor(3),
  kind: 'db.query',
  name: 'select items',
  startTime: BASE_START_MS + 30,
  duration: 180,
  tier: 'db',
  attributes: { 'db.system': 'postgresql', 'db.statement': STATEMENT, 'db.rowCount': 12 },
  status: 'ok',
  producerId: SERVER_PRODUCER_ID,
  seq: 1,
  ingestSeq: 4,
  source: CALLER_SOURCE,
});

/** The commit the response caused, back on the browser tier. */
const RENDER_EVENT: TelemetryEvent = makeEvent({
  id: 'evt_example_0005',
  spanId: spanIdFor(5),
  parentSpanId: spanIdFor(1),
  kind: 'render',
  name: FIRST_COMPONENT,
  startTime: BASE_START_MS + 260,
  duration: 14,
  tier: 'browser',
  attributes: {
    component: FIRST_COMPONENT,
    phase: 'update',
    renderCount: 3,
    trigger: 'props',
    changedProps: [CHANGED_PROP],
  },
  status: 'ok',
  producerId: BROWSER_PRODUCER_ID,
  seq: 2,
  ingestSeq: 5,
  source: COMPONENT_SOURCE,
});

/**
 * The page the `spans` and `events` sources answer with, in canonical order:
 * parent before child, then by start time.
 */
const RECORDED_EVENTS: readonly TelemetryEvent[] = [
  INTERACTION_EVENT,
  FETCH_EVENT,
  SERVER_EVENT,
  QUERY_EVENT,
  RENDER_EVENT,
];

/*
 * ---------------------------------------------------------------------------
 * The correlated tree
 * ---------------------------------------------------------------------------
 */

/**
 * One node of the recorded tree.
 *
 * @param event The record at this position.
 * @param depth Its depth below the root, the root being zero.
 * @param children Its already-built children, in order.
 * @returns The node.
 */
function makeTraceNode(
  event: TelemetryEvent,
  depth: number,
  children: readonly TraceNode[] = [],
): TraceNode {
  return { event, children, depth, orphaned: false };
}

/**
 * Every node of a built subtree, depth first — the counters below are computed
 * from the tree rather than written beside it, so a fixture edit cannot leave a
 * `nodeCount` that disagrees with what a view will walk.
 *
 * @param nodes The roots to flatten.
 * @returns Every node beneath and including them.
 */
function flattenTraceNodes(nodes: readonly TraceNode[]): readonly TraceNode[] {
  return nodes.flatMap((node) => [node, ...flattenTraceNodes(node.children)]);
}

/** The recorded interaction as the ordered tree the `trace` source answers with. */
const RECORDED_TRACE: TraceTree = ((): TraceTree => {
  const roots: readonly TraceNode[] = [
    makeTraceNode(INTERACTION_EVENT, 0, [
      makeTraceNode(FETCH_EVENT, 1, [
        makeTraceNode(SERVER_EVENT, 2, [makeTraceNode(QUERY_EVENT, 3)]),
      ]),
      makeTraceNode(RENDER_EVENT, 1),
    ]),
  ];

  const nodes = flattenTraceNodes(roots);
  const starts = nodes.map((node) => node.event.startTime);
  const ends = nodes.map((node) => node.event.startTime + node.event.duration);
  const startTime = Math.min(...starts);
  const endTime = Math.max(...ends);

  return {
    traceId: TRACE_ID,
    roots,
    primaryRootSpanId: INTERACTION_EVENT.spanId,
    nodeCount: nodes.length,
    maxDepth: Math.max(...nodes.map((node) => node.depth)),
    startTime,
    endTime,
    totalDuration: endTime - startTime,
    orphanCount: 0,
    tiers: ['browser', 'server', 'db'],
    kinds: ['interaction', 'fetch', 'render', 'http.server', 'db.query'],
    producerIds: [BROWSER_PRODUCER_ID, SERVER_PRODUCER_ID],
    duplicateSpanIds: [],
    truncated: false,
  };
})();

/*
 * ---------------------------------------------------------------------------
 * The aggregates
 *
 * Each one is a page of the shape `packages/telemetry/src/aggregate/*.ts`
 * computes and the panel-data route serves, populated far enough for its view to
 * draw a non-empty success state: two rows where a view ranks or groups, one
 * root where it draws structure.
 * ---------------------------------------------------------------------------
 */

/** Per-component render statistics, the `renders` source. */
const RECORDED_RENDERS: readonly RenderStat[] = [
  {
    id: `render:${FIRST_COMPONENT}`,
    component: FIRST_COMPONENT,
    renderCount: 3,
    totalDurationMs: 42,
    averageDurationMs: 14,
    maxDurationMs: 18,
    firstStartTime: BASE_START_MS + 260,
    lastStartTime: BASE_START_MS + 300,
    triggers: { props: 2, state: 1, context: 0, unchanged: 0, unknown: 0 },
    unchangedRenderCount: 0,
    unknownTriggerCount: 0,
    phaseCounts: { mount: 1, update: 2 },
    changedPropKeys: [CHANGED_PROP],
    changedPropCounts: { [CHANGED_PROP]: 2 },
    occurrences: [
      {
        id: RENDER_EVENT.id,
        eventId: RENDER_EVENT.id,
        spanId: RENDER_EVENT.spanId,
        traceId: TRACE_ID,
        parentSpanId: INTERACTION_EVENT.spanId,
        startTime: RENDER_EVENT.startTime,
        durationMs: RENDER_EVENT.duration,
        phase: 'update',
        trigger: 'props',
        renderCount: 3,
        changedPropKeys: [CHANGED_PROP],
        source: COMPONENT_SOURCE,
      },
    ],
    occurrencesTruncated: false,
    source: COMPONENT_SOURCE,
  },
  {
    id: `render:${SECOND_COMPONENT}`,
    component: SECOND_COMPONENT,
    renderCount: 1,
    totalDurationMs: 6,
    averageDurationMs: 6,
    maxDurationMs: 6,
    firstStartTime: BASE_START_MS + 262,
    lastStartTime: BASE_START_MS + 262,
    triggers: { props: 0, state: 0, context: 0, unchanged: 1, unknown: 0 },
    unchangedRenderCount: 1,
    unknownTriggerCount: 0,
    phaseCounts: { mount: 0, update: 1 },
    changedPropKeys: [],
    changedPropCounts: {},
    occurrences: [],
    occurrencesTruncated: false,
  },
];

/** The child of the recorded structure, so the tree has a level to expand. */
const CHILD_TREE_NODE: ComponentTreeNode = {
  id: 'tree:0/0',
  component: SECOND_COMPONENT,
  depth: 1,
  renderCount: 1,
  totalDurationMs: 6,
  lastTrigger: 'unchanged',
  children: [],
};

/** The component structure as of the capture's last commit, the `componentTree` source. */
const RECORDED_COMPONENT_TREE: ComponentTreeSnapshot = {
  capturedAt: BASE_START_MS + 300,
  commitEventId: RENDER_EVENT.id,
  commitSpanId: RENDER_EVENT.spanId,
  traceId: TRACE_ID,
  origin: 'commit-snapshot',
  degraded: false,
  roots: [
    {
      id: 'tree:0',
      component: FIRST_COMPONENT,
      depth: 0,
      renderCount: 3,
      totalDurationMs: 42,
      lastTrigger: 'props',
      source: COMPONENT_SOURCE,
      children: [CHILD_TREE_NODE],
    },
  ],
  nodeCount: 2,
  maxDepth: 1,
  truncated: false,
};

/** Network calls grouped by request key, the `requests` source. */
const RECORDED_REQUESTS: readonly RequestGroup[] = [
  {
    id: 'request_example_0001',
    requestKey: 'rk_example_0001',
    groupedBy: 'request-key',
    method: REQUEST_METHOD,
    url: RESOURCE_URL,
    path: RESOURCE_PATH,
    count: 2,
    duplicateCount: 1,
    hasDuplicates: true,
    duplicateWindows: [
      {
        id: 'window_example_0001',
        startTime: FETCH_EVENT.startTime,
        endTime: FETCH_EVENT.startTime + 22,
        count: 2,
        redundantCount: 1,
        eventIds: [FETCH_EVENT.id, 'evt_example_0006'],
      },
    ],
    firstStartTime: FETCH_EVENT.startTime,
    lastStartTime: FETCH_EVENT.startTime + 22,
    totalDurationMs: 420,
    averageDurationMs: 210,
    maxDurationMs: 240,
    minDurationMs: 180,
    statusCodes: [200],
    errorCount: 0,
    initiators: [FIRST_COMPONENT],
    occurrences: [
      {
        id: FETCH_EVENT.id,
        eventId: FETCH_EVENT.id,
        spanId: FETCH_EVENT.spanId,
        traceId: TRACE_ID,
        parentSpanId: INTERACTION_EVENT.spanId,
        startTime: FETCH_EVENT.startTime,
        durationMs: FETCH_EVENT.duration,
        endTime: FETCH_EVENT.startTime + FETCH_EVENT.duration,
        statusCode: 200,
        status: 'ok',
        initiator: FIRST_COMPONENT,
        source: COMPONENT_SOURCE,
        tier: 'browser',
        kind: 'fetch',
      },
    ],
    occurrencesTruncated: false,
  },
];

/** Statements grouped by their normalised text, the `queries` source. */
const RECORDED_QUERIES: readonly QueryGroup[] = [
  {
    id: 'query_example_0001',
    normalizedStatement: STATEMENT,
    statement: STATEMENT,
    system: 'postgresql',
    executionCount: 2,
    totalDurationMs: 300,
    averageDurationMs: 150,
    minDurationMs: 120,
    maxDurationMs: 180,
    firstStartTime: QUERY_EVENT.startTime,
    lastStartTime: QUERY_EVENT.startTime + 40,
    totalRowCount: 24,
    errorCount: 0,
    traceIds: [TRACE_ID],
    callers: [
      {
        id: 'caller_example_0001',
        spanId: SERVER_EVENT.spanId,
        name: CALLER_SOURCE.symbol ?? 'caller',
        kind: 'http.server',
        executionCount: 2,
        totalDurationMs: 300,
        source: CALLER_SOURCE,
      },
    ],
    occurrences: [
      {
        id: QUERY_EVENT.id,
        eventId: QUERY_EVENT.id,
        spanId: QUERY_EVENT.spanId,
        traceId: TRACE_ID,
        parentSpanId: SERVER_EVENT.spanId,
        startTime: QUERY_EVENT.startTime,
        durationMs: QUERY_EVENT.duration,
        endTime: QUERY_EVENT.startTime + QUERY_EVENT.duration,
        rowCount: 12,
        status: 'ok',
        callerSpanId: SERVER_EVENT.spanId,
        callerName: CALLER_SOURCE.symbol ?? 'caller',
        source: CALLER_SOURCE,
      },
    ],
    occurrencesTruncated: false,
  },
];

/** Hook state changes, the `stateTransitions` source. Previews, never values. */
const RECORDED_STATE_TRANSITIONS: readonly StateTransition[] = [
  {
    id: 'evt_example_0007',
    eventId: 'evt_example_0007',
    spanId: spanIdFor(7),
    traceId: TRACE_ID,
    startTime: BASE_START_MS + 250,
    component: FIRST_COMPONENT,
    hookIndex: 0,
    hookLabel: 'status',
    previousValue: 'pending',
    nextValue: 'settled',
    changed: true,
    triggerEventId: FETCH_EVENT.id,
    triggerSpanId: FETCH_EVENT.spanId,
    triggerName: FETCH_EVENT.name,
    triggerKind: 'fetch',
    source: COMPONENT_SOURCE,
  },
];

/** The correlated flow as participants and handovers, the `graph` source. */
const RECORDED_GRAPH: DependencyGraphData = {
  nodes: [
    {
      id: 'dep:ui-event|browser|activation',
      kind: 'ui-event',
      label: INTERACTION_EVENT.name,
      tier: 'browser',
      spanIds: [INTERACTION_EVENT.spanId],
      count: 1,
      totalDurationMs: INTERACTION_DURATION_MS,
      maxDurationMs: INTERACTION_DURATION_MS,
      layer: 0,
    },
    {
      id: 'dep:api|server|resource',
      kind: 'api',
      label: RESOURCE_PATH,
      tier: 'server',
      spanIds: [SERVER_EVENT.spanId],
      count: 1,
      totalDurationMs: SERVER_EVENT.duration,
      maxDurationMs: SERVER_EVENT.duration,
      layer: 1,
    },
    {
      id: 'dep:database|db|items',
      kind: 'database',
      label: QUERY_EVENT.name,
      tier: 'db',
      spanIds: [QUERY_EVENT.spanId],
      count: 1,
      totalDurationMs: QUERY_EVENT.duration,
      maxDurationMs: QUERY_EVENT.duration,
      source: CALLER_SOURCE,
      layer: 2,
    },
  ],
  edges: [
    {
      id: 'edge:dep:ui-event|browser|activation=>dep:api|server|resource',
      from: 'dep:ui-event|browser|activation',
      to: 'dep:api|server|resource',
      count: 1,
      totalDurationMs: SERVER_EVENT.duration,
    },
    {
      id: 'edge:dep:api|server|resource=>dep:database|db|items',
      from: 'dep:api|server|resource',
      to: 'dep:database|db|items',
      count: 1,
      totalDurationMs: QUERY_EVENT.duration,
    },
  ],
  layerCount: 3,
  truncated: false,
};

/**
 * The two computed values the metric tiles ask for, the `metrics` source.
 *
 * Two ids from the product's fixed vocabulary, and the node below asks for
 * exactly these two — a tile row whose ids and page agree is what a success
 * state means for that view.
 */
const RECORDED_METRICS: readonly MetricValue[] = [
  {
    id: 'total_duration',
    label: 'Total duration',
    unit: 'milliseconds',
    available: true,
    value: INTERACTION_DURATION_MS,
  },
  {
    id: 'request_count',
    label: 'Requests',
    unit: 'count',
    available: true,
    value: 2,
  },
];

/** The metric ids the `metricCards` node asks for, in display order. */
const REQUESTED_METRICS = ['total_duration', 'request_count'] as const;

/*
 * ---------------------------------------------------------------------------
 * The recorded panel-data responses
 * ---------------------------------------------------------------------------
 */

/**
 * One recorded response per query source, keyed by the source it answers for.
 *
 * A mapped type over `DataQuerySource`, which is what makes this table's
 * completeness a compile-time property in both directions: a source added to
 * the vocabulary is a missing property, and each entry's `data` is checked
 * against that source's own result type — so a change to any telemetry
 * aggregate shape fails `tsc -b` here rather than surfacing as a view that
 * rendered nothing.
 *
 * `total` is carried by the array-valued sources, as the service's route does;
 * `nextOffset` is absent because each page below is the last one, which is
 * exactly what its absence means (AAP 0.4.2). The three scalar sources — the
 * correlated tree, the structure snapshot and the dependency graph — are not
 * paged and carry neither.
 */
const RECORDED_RESPONSES: { readonly [Source in DataQuerySource]: DataQueryResponse<Source> } = {
  trace: { source: 'trace', data: RECORDED_TRACE },
  spans: { source: 'spans', data: RECORDED_EVENTS, total: RECORDED_EVENTS.length },
  events: { source: 'events', data: RECORDED_EVENTS, total: RECORDED_EVENTS.length },
  renders: { source: 'renders', data: RECORDED_RENDERS, total: RECORDED_RENDERS.length },
  componentTree: { source: 'componentTree', data: RECORDED_COMPONENT_TREE },
  requests: { source: 'requests', data: RECORDED_REQUESTS, total: RECORDED_REQUESTS.length },
  queries: { source: 'queries', data: RECORDED_QUERIES, total: RECORDED_QUERIES.length },
  stateTransitions: {
    source: 'stateTransitions',
    data: RECORDED_STATE_TRANSITIONS,
    total: RECORDED_STATE_TRANSITIONS.length,
  },
  graph: { source: 'graph', data: RECORDED_GRAPH },
  metrics: { source: 'metrics', data: RECORDED_METRICS, total: RECORDED_METRICS.length },
};

/*
 * ---------------------------------------------------------------------------
 * Stubs
 * ---------------------------------------------------------------------------
 */

/** A stub data provider, its recorded queries and the resolver behind it. */
interface StubProvider {
  /** The provider to mount, built with the library's own factory. */
  readonly provider: DataProvider;

  /** Every query the resolver received, in call order. */
  readonly queries: DataQuery[];

  /** The resolver itself, for call-count assertions. */
  readonly resolve: Mock<DataQueryResolver>;
}

/**
 * A provider that answers each query with the recorded response for its source.
 *
 * Built through {@link createDataProvider} rather than as a hand-written object,
 * so every case also exercises that factory's guarantee that a response answers
 * for the source it was asked about — a mis-keyed table below would surface as a
 * rejected query and a rendered error state, not as a silently wrong view.
 *
 * @returns The stub, its recorded queries and its resolver.
 */
function recordingProvider(): StubProvider {
  const queries: DataQuery[] = [];
  const resolve = vi.fn<DataQueryResolver>((query) => {
    queries.push(query);

    return Promise.resolve(RECORDED_RESPONSES[query.source]);
  });

  return { provider: createDataProvider(resolve), queries, resolve };
}

/** A host's action contract, with a spy behind each member. */
interface ActionSpies {
  /** The object to provide through {@link PanelActionsContext}. */
  readonly actions: PanelActions;

  /** Raised when a rendered item stands for a captured record. */
  readonly onSelectEvent: Mock<(ref: PanelEventRef) => void>;

  /** Raised when a chip or row asks the editor to open a place in the project. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;

  /** Raised when a row, group or tree node is expanded or collapsed. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** Raised when a component-local filter, sort or search value changes. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * A complete host, including the two optional members: a case asserting that a
 * layout node raises nothing can only mean it if every member a component could
 * have reached was present and unused.
 *
 * @returns The actions object and its four spies.
 */
function makeActions(): ActionSpies {
  const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
  const onOpenSource = vi.fn<(location: SourceLocation) => void>();
  const onExpand = vi.fn<(nodeId: string, itemId: string, expanded: boolean) => void>();
  const onFilterChange = vi.fn<(nodeId: string, filter: Record<string, string>) => void>();

  return {
    actions: { onSelectEvent, onOpenSource, onExpand, onFilterChange },
    onSelectEvent,
    onOpenSource,
    onExpand,
    onFilterChange,
  };
}

/**
 * One node under both ambient contexts, dispatched exactly as a panel dispatches
 * it.
 *
 * `createElement` rather than JSX because this module is `.ts`; the tree is the
 * one `PanelHost` mounts — the data seam outermost, the action contract inside
 * it, the node renderer within both.
 *
 * @param node The node to render.
 * @param provider The provider resolving its query.
 * @param actions The host the rendered component reports interactions to.
 * @returns The element tree to render.
 */
function panelTree(node: PanelNode, provider: DataProvider, actions: PanelActions): ReactElement {
  return createElement(
    DataProviderContext.Provider,
    { value: provider },
    createElement(
      PanelActionsContext.Provider,
      { value: actions },
      createElement(NodeRenderer, { node }),
    ),
  );
}

/**
 * Renders one node and answers with the container it was rendered into, so that
 * every query below is scoped to this node rather than to the document.
 *
 * @param node The node to render.
 * @param stub The provider stub resolving its query.
 * @param spies The host actions to report to.
 * @returns The render container.
 */
function renderNode(node: PanelNode, stub: StubProvider, spies: ActionSpies): HTMLElement {
  return render(panelTree(node, stub.provider, spies.actions)).container;
}

/*
 * ---------------------------------------------------------------------------
 * Reading a rendered node
 * ---------------------------------------------------------------------------
 */

/**
 * The data rows of a grid, header and detail rows excluded.
 *
 * Read off `../primitives/DataTable`'s own row attribute, which is how the
 * component suites in this package identify a data row, and off an element
 * already obtained by role.
 *
 * @param grid The grid to read.
 * @returns Its data rows, in document order.
 */
function dataRowsIn(grid: HTMLElement): HTMLElement[] {
  return within(grid)
    .getAllByRole('row')
    .filter((row) => row.getAttribute('data-row-index') !== null);
}

/**
 * Waits for a view's grid and asserts it drew at least one row of the recorded
 * page.
 *
 * @param scope The node's render container.
 * @returns The grid.
 */
async function findGridWithRows(scope: HTMLElement): Promise<HTMLElement> {
  const grid = await within(scope).findByRole('grid');

  expect(dataRowsIn(grid).length).toBeGreaterThan(0);

  return grid;
}

/**
 * Asserts that nothing transient is left on screen: no query still resolving and
 * no failure.
 *
 * The loading placeholder is the package's only `role="status"` and the failure
 * state its only `role="alert"`, so both are reached semantically. The empty
 * placeholder deliberately declares no role at all — announcing "nothing to
 * show" on every unrelated re-render would be worse than silence — so it is the
 * one state read by class, off the node's own container.
 *
 * @param scope The node's render container.
 */
function expectSettledSuccess(scope: HTMLElement): void {
  expect(within(scope).queryByRole('status')).toBeNull();
  expect(within(scope).queryByRole('alert')).toBeNull();
  expect(scope.querySelectorAll('.dg-empty-state')).toHaveLength(0);
  expect(scope.querySelector('.dg-panel__node')).not.toBeNull();
}

/*
 * ---------------------------------------------------------------------------
 * The nodes, built from the catalogue
 * ---------------------------------------------------------------------------
 */

/**
 * The source a node of this type resolves against: the catalogue's stated
 * default, or the first source it permits.
 *
 * Read from the catalogue rather than restated, which is what couples this
 * suite to the vocabulary: a source removed from an entry changes which
 * recorded response that node's view is rendered against.
 *
 * @param type A query-backed node type.
 * @returns The source its query names.
 */
function sourceFor(type: PanelNodeType): DataQuerySource {
  const entry = PANEL_NODE_CATALOG[type];
  const source = entry.defaultSource ?? entry.sources[0];

  if (source === undefined) {
    throw new Error(
      `the catalogue entry for "${type}" names no data source, so no query can be built for it`,
    );
  }

  return source;
}

/**
 * The minimal query a node of this type carries.
 *
 * Nothing but the source: `filter`, `sort`, `limit` and `offset` are the panel
 * author's narrowing, and a case that omitted them is the case a view has to
 * draw correctly — the components apply their own paging defaults, which is the
 * behaviour under test rather than something to pre-empt here.
 *
 * @param type A query-backed node type.
 * @returns The query.
 */
function queryFor(type: PanelNodeType): DataQuery {
  return { source: sourceFor(type) };
}

/** The title the `section` case gives its container, and the name it is found by. */
const SECTION_TITLE = 'Recorded section';

/** The title the `split` case gives its container. */
const SPLIT_TITLE = 'Recorded division';

/** The title the `stack` case gives its container. */
const STACK_TITLE = 'Recorded stack';

/**
 * A source-link leaf, which is the child every container case is given.
 *
 * Deliberately the one visualization that carries no query: a container's own
 * case can then assert that a layout node reaches the data provider not at all —
 * which is what `requiresQuery: false` means in the catalogue — while still
 * exercising the node renderer's recursion and the container adapters' handover
 * of rendered children.
 *
 * @param id The child's identity within the panel.
 * @param location Where the chip points.
 * @returns The leaf node.
 */
function sourceLinkNode(id: string, location: SourceLocation): PanelNode {
  return { type: 'sourceLink', id, location };
}

/** One case: a node of some catalogued type, and what its success looks like. */
interface RenderCase {
  /** The node to dispatch through the registry. */
  readonly node: PanelNode;

  /**
   * Waits for this node's component to reach its success state and asserts
   * something specific to that component is on screen — a role it owns, a row
   * of the recorded page, or a value the response carried.
   */
  readonly expectSuccess: (scope: HTMLElement) => Promise<void>;
}

/**
 * One case per catalogued node type, keyed by that type.
 *
 * A `Record` over `PanelNodeType`, which is the point: a node type added to the
 * catalogue and the registry is a **missing property** here — a compile error in
 * this file — so a new component cannot be merged without a case that renders
 * it, and a type removed from the vocabulary is an excess property. The runtime
 * suites below iterate `PANEL_NODE_TYPES` and look each type up here, so the two
 * lists are checked against each other at both times.
 *
 * Every query is read from the catalogue by {@link queryFor}; the three
 * containers and the source-link leaf carry none, as their entries state.
 */
const RENDER_CASES: Readonly<Record<PanelNodeType, RenderCase>> = {
  section: {
    node: {
      type: 'section',
      id: 'node:section',
      title: SECTION_TITLE,
      children: [sourceLinkNode('node:section.0', COMPONENT_SOURCE)],
    },
    async expectSuccess(scope) {
      // The container's own heading names the region, and its child was
      // rendered *by the node renderer* and handed over as children — which is
      // the recursion this case exists for.
      const region = await within(scope).findByRole('region', { name: SECTION_TITLE });

      expect(within(region).getAllByRole('button')).toHaveLength(1);
    },
  },

  split: {
    node: {
      type: 'split',
      id: 'node:split',
      title: SPLIT_TITLE,
      children: [
        sourceLinkNode('node:split.0', COMPONENT_SOURCE),
        sourceLinkNode('node:split.1', SECOND_SOURCE),
      ],
    },
    async expectSuccess(scope) {
      const region = await within(scope).findByRole('region', { name: SPLIT_TITLE });

      // Two panes, because a division's children must arrive as an array: a
      // fragment would collapse them into the first pane.
      expect(within(region).getAllByRole('button')).toHaveLength(2);
    },
  },

  stack: {
    node: {
      type: 'stack',
      id: 'node:stack',
      title: STACK_TITLE,
      children: [sourceLinkNode('node:stack.0', SECOND_SOURCE)],
    },
    async expectSuccess(scope) {
      const region = await within(scope).findByRole('region', { name: STACK_TITLE });

      expect(within(region).getAllByRole('button')).toHaveLength(1);
    },
  },

  timeline: {
    node: { type: 'timeline', id: 'node:timeline', query: queryFor('timeline') },
    async expectSuccess(scope) {
      // The canvas is the view's own text alternative; the rows below it are the
      // keyboard-reachable representation of the same spans.
      await within(scope).findByRole('img');
      await findGridWithRows(scope);
    },
  },

  waterfall: {
    node: { type: 'waterfall', id: 'node:waterfall', query: queryFor('waterfall') },
    async expectSuccess(scope) {
      const tree = await within(scope).findByRole('tree');

      // The recorded page holds a request, the server work it reached and the
      // statement that work ran — all three kinds this view draws.
      expect(within(tree).getAllByRole('treeitem').length).toBeGreaterThan(0);
    },
  },

  eventLog: {
    node: { type: 'eventLog', id: 'node:eventLog', query: queryFor('eventLog') },
    async expectSuccess(scope) {
      await findGridWithRows(scope);
    },
  },

  metricCards: {
    node: {
      type: 'metricCards',
      id: 'node:metricCards',
      query: queryFor('metricCards'),
      metrics: [...REQUESTED_METRICS],
    },
    async expectSuccess(scope) {
      const tiles = await within(scope).findByRole('list', {
        name: PANEL_NODE_CATALOG.metricCards.label,
      });

      // One tile per id the node asked for, which is the row the author chose
      // and not the order the page happened to carry.
      expect(within(tiles).getAllByRole('listitem')).toHaveLength(REQUESTED_METRICS.length);
    },
  },

  flame: {
    node: { type: 'flame', id: 'node:flame', query: queryFor('flame') },
    async expectSuccess(scope) {
      await within(scope).findByRole('img');

      // The equivalent list is what a keyboard or screen-reader user reads the
      // hierarchy from, so a drawn icicle alone is not this view's success.
      expect(within(scope).getAllByRole('list').length).toBeGreaterThan(0);
    },
  },

  table: {
    node: { type: 'table', id: 'node:table', query: queryFor('table') },
    async expectSuccess(scope) {
      const grid = await findGridWithRows(scope);

      // The ranking covers the whole recorded page, one row per span.
      expect(dataRowsIn(grid)).toHaveLength(RECORDED_EVENTS.length);
    },
  },

  renderTable: {
    node: { type: 'renderTable', id: 'node:renderTable', query: queryFor('renderTable') },
    async expectSuccess(scope) {
      const grid = await findGridWithRows(scope);

      expect(dataRowsIn(grid)).toHaveLength(RECORDED_RENDERS.length);
      // A value from the recorded page, not merely a row: the statistics are
      // per component, so the component's own name is what a reader looks for.
      expect(within(grid).getAllByText(FIRST_COMPONENT).length).toBeGreaterThan(0);
    },
  },

  componentTree: {
    node: { type: 'componentTree', id: 'node:componentTree', query: queryFor('componentTree') },
    async expectSuccess(scope) {
      const tree = await within(scope).findByRole('tree');

      expect(within(tree).getAllByRole('treeitem').length).toBeGreaterThan(0);
      expect(within(tree).getAllByText(FIRST_COMPONENT).length).toBeGreaterThan(0);
    },
  },

  requestTable: {
    node: { type: 'requestTable', id: 'node:requestTable', query: queryFor('requestTable') },
    async expectSuccess(scope) {
      const grid = await findGridWithRows(scope);

      expect(dataRowsIn(grid)).toHaveLength(RECORDED_REQUESTS.length);
    },
  },

  queryTable: {
    node: { type: 'queryTable', id: 'node:queryTable', query: queryFor('queryTable') },
    async expectSuccess(scope) {
      const grid = await findGridWithRows(scope);

      expect(dataRowsIn(grid)).toHaveLength(RECORDED_QUERIES.length);
      // The parameterized statement, exactly as the page carried it: this view
      // renders redacted statement text and never a value.
      expect(within(grid).getAllByText(STATEMENT).length).toBeGreaterThan(0);
    },
  },

  stateTransitions: {
    node: {
      type: 'stateTransitions',
      id: 'node:stateTransitions',
      query: queryFor('stateTransitions'),
    },
    async expectSuccess(scope) {
      const grid = await findGridWithRows(scope);

      expect(dataRowsIn(grid)).toHaveLength(RECORDED_STATE_TRANSITIONS.length);
    },
  },

  dependencyGraph: {
    node: {
      type: 'dependencyGraph',
      id: 'node:dependencyGraph',
      query: queryFor('dependencyGraph'),
    },
    async expectSuccess(scope) {
      await within(scope).findByRole('img');

      // The relationships are also a table, which is the form the graph is
      // navigable in; the recorded page holds three participants.
      const grid = await findGridWithRows(scope);

      expect(dataRowsIn(grid)).toHaveLength(RECORDED_GRAPH.nodes.length);
    },
  },

  sourceLink: {
    node: sourceLinkNode('node:sourceLink', COMPONENT_SOURCE),
    async expectSuccess(scope) {
      // The chip's accessible name is built from the shared package's own
      // spelling of a location, so this case cannot drift from the format the
      // click path carries.
      await within(scope).findByRole('button', {
        name: `Open ${formatSourceLocation(COMPONENT_SOURCE)}`,
      });
    },
  },
};

/*
 * ---------------------------------------------------------------------------
 * The type no component draws
 * ---------------------------------------------------------------------------
 */

/** A node type that is deliberately not in the catalogue. */
const UNKNOWN_NODE_TYPE = 'unrecordedVisualization';

/** The identity of the node built around it, for the message to name. */
const UNKNOWN_NODE_ID = 'node:unrecorded';

/**
 * A node whose type the registry has no component for.
 *
 * The cast is deliberate and is the whole point of the case: `PanelNode` is a
 * closed discriminated union, so the situation this asserts on — a stored
 * specification written by a newer vocabulary, or a caller that rendered a
 * specification it never validated — cannot be expressed in the public type at
 * all. `packages/panel-schema/src/validate.ts` rejects such a specification
 * upstream, which is why this is unreachable through the supported path and why
 * the renderer must still handle it visibly rather than quietly (AAP 0.6.2,
 * 0.5.5).
 */
const UNKNOWN_NODE = {
  type: UNKNOWN_NODE_TYPE,
  id: UNKNOWN_NODE_ID,
} as unknown as PanelNode;

/*
 * ---------------------------------------------------------------------------
 * Coverage
 * ---------------------------------------------------------------------------
 */

/**
 * The size of the catalogue this suite was written against: three containers,
 * twelve query-backed views and the source-link leaf (AAP 0.6.2).
 *
 * Asserted as a number as well as against the catalogue, so that a vocabulary
 * that grew or shrank is reported here — where the decision about the missing
 * component gets made — rather than only as a compile error in the table above.
 */
const EXPECTED_NODE_TYPE_COUNT = 16;

describe('the panel component registry', () => {
  it('pairs every catalogued node type with a component, in both directions', () => {
    const registered = Object.keys(PANEL_COMPONENT_REGISTRY).sort();
    const catalogued = Object.keys(PANEL_NODE_CATALOG).sort();

    const uncovered = catalogued.filter((type) => !registered.includes(type));
    const unmapped = registered.filter((type) => !catalogued.includes(type));

    expect(
      uncovered,
      `catalogued node types with no renderer component: ${uncovered.join(', ')}`,
    ).toEqual([]);
    expect(
      unmapped,
      `registered components with no catalogue entry: ${unmapped.join(', ')}`,
    ).toEqual([]);
    expect(registered).toEqual(catalogued);
  });

  it('is keyed by the catalogue vocabulary and nothing else', () => {
    expect(Object.keys(PANEL_COMPONENT_REGISTRY).sort()).toEqual([...PANEL_NODE_TYPES].sort());
    expect(PANEL_NODE_TYPES).toHaveLength(EXPECTED_NODE_TYPE_COUNT);
    expect(Object.keys(PANEL_COMPONENT_REGISTRY)).toHaveLength(EXPECTED_NODE_TYPE_COUNT);
  });

  it('registers a distinct, renderable, named component for every catalogued type', () => {
    const seen = new Set<PanelNodeComponent>();

    for (const type of PANEL_NODE_TYPES) {
      const component = PANEL_COMPONENT_REGISTRY[type];

      expect(
        typeof component,
        `the registry entry for "${type}" is not a renderable component`,
      ).toBe('function');
      expect(
        typeof component.displayName,
        `the registry entry for "${type}" has no displayName to report it by`,
      ).toBe('string');
      expect(component.displayName).not.toBe('');

      // Each type has its own adapter: a shared entry would mean one of the two
      // node types is drawn by a component that narrows on the other's type and
      // reports a mis-dispatch instead of rendering.
      expect(seen.has(component), `the component for "${type}" is registered twice`).toBe(false);
      seen.add(component);

      // The lookup a node renderer uses resolves to the same entry, so a known
      // type can never be reported as absent.
      expect(componentForNodeType(type)).toBe(component);
    }

    expect(seen.size).toBe(EXPECTED_NODE_TYPE_COUNT);
  });

  it('answers for no type outside the catalogue', () => {
    expect(componentForNodeType(UNKNOWN_NODE_TYPE)).toBeUndefined();
    expect(componentForNodeType('')).toBeUndefined();
  });

  it('is frozen, so no consumer can swap a component behind the schema', () => {
    expect(Object.isFrozen(PANEL_COMPONENT_REGISTRY)).toBe(true);
  });
});

describe('the recorded render cases', () => {
  it('cover every catalogued node type, and no other', () => {
    expect(Object.keys(RENDER_CASES).sort()).toEqual([...PANEL_NODE_TYPES].sort());
  });

  it('carry a query exactly for the types the catalogue says require one', () => {
    for (const type of PANEL_NODE_TYPES) {
      const { node } = RENDER_CASES[type];
      const entry = PANEL_NODE_CATALOG[type];

      expect(node.type, `the case for "${type}" holds a node of another type`).toBe(type);
      expect('query' in node, `the case for "${type}" disagrees with its catalogue entry`).toBe(
        entry.requiresQuery,
      );

      if ('query' in node) {
        // The source is the catalogue's own, so the recorded response this node
        // resolves against is chosen by the vocabulary rather than by this file.
        expect(entry.sources).toContain(node.query.source);
        expect(node.query.source).toBe(sourceFor(type));
      }
    }
  });

  it('answer every source of the panel-data contract with a recorded response', () => {
    for (const [source, response] of Object.entries(RECORDED_RESPONSES)) {
      expect(response.source).toBe(source);
    }
  });
});

describe('every catalogued component renders its recorded panel-data response', () => {
  for (const type of PANEL_NODE_TYPES) {
    it(`draws the "${type}" node and reaches its success state`, async () => {
      const testCase = RENDER_CASES[type];
      const stub = recordingProvider();
      const spies = makeActions();

      const scope = renderNode(testCase.node, stub, spies);

      await testCase.expectSuccess(scope);

      // No skeleton still on screen, no failure, no empty placeholder: the view
      // drew the page it was given rather than a plausible-looking nothing
      // (AAP 0.5.5).
      expectSettledSuccess(scope);

      const entry = PANEL_NODE_CATALOG[type];

      if (entry.requiresQuery) {
        expect(stub.queries.length).toBeGreaterThan(0);

        // Every request this node made is for its own source. A component may
        // rebuild the query it was authored with — applying its paging default,
        // a toolbar's filter or a further page — but it may not read a source
        // its node did not name.
        for (const query of stub.queries) {
          expect(query.source).toBe(sourceFor(type));
        }
      } else {
        // `requiresQuery: false` in the catalogue means exactly this: the three
        // containers and the source-link leaf reach the data provider not at
        // all, so nothing about them can depend on a capture being loadable.
        expect(stub.resolve).not.toHaveBeenCalled();
        expect(stub.queries).toEqual([]);
      }
    });
  }
});

describe('a node type the registry has no component for', () => {
  it('renders an error state naming the type and the node, never a blank area', async () => {
    const stub = recordingProvider();
    const spies = makeActions();

    const scope = renderNode(UNKNOWN_NODE, stub, spies);

    const failure = await within(scope).findByRole('alert');

    expect(failure.textContent).toContain(UNKNOWN_NODE_TYPE);
    expect(failure.textContent).toContain(UNKNOWN_NODE_ID);

    // The wrapper keeps the node class and adds the failure one, whose minimum
    // block size is what gives an unrenderable node the room its visualization
    // would have occupied.
    const wrapper = scope.querySelector('.dg-panel__node');

    expect(wrapper).not.toBeNull();
    expect(wrapper?.classList.contains('dg-panel__node-error')).toBe(true);
    expect(scope.textContent?.trim()).not.toBe('');

    // A failure is not a loading state and not an empty one, and nothing was
    // asked of the provider for a node that could never have been drawn.
    expect(within(scope).queryByRole('status')).toBeNull();
    expect(scope.querySelectorAll('.dg-empty-state')).toHaveLength(0);
    expect(stub.resolve).not.toHaveBeenCalled();
  });
});

describe('a dispatched component reaches the ambient host actions', () => {
  it('forwards a source chip activation to onOpenSource with the location unchanged', async () => {
    const stub = recordingProvider();
    const spies = makeActions();
    const user = userEvent.setup();

    const scope = renderNode(RENDER_CASES.sourceLink.node, stub, spies);

    const chip = await within(scope).findByRole('button', {
      name: `Open ${formatSourceLocation(COMPONENT_SOURCE)}`,
    });

    await user.click(chip);

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);

    // By reference, not by value: the first hop of the click-to-source path is
    // only correct while the object that arrives is the object that leaves
    // (AAP 0.4.2).
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toBe(COMPONENT_SOURCE);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('announces an activated row as the record it stands for', async () => {
    const stub = recordingProvider();
    const spies = makeActions();
    const user = userEvent.setup();

    const scope = renderNode(RENDER_CASES.table.node, stub, spies);

    const grid = await findGridWithRows(scope);
    const [row] = dataRowsIn(grid);

    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    await user.click(row);

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const ref = spies.onSelectEvent.mock.calls[0]?.[0];

    if (ref === undefined) {
      throw new Error('the selection handler recorded no reference');
    }

    // The identity comes from a record of the page the provider resolved, which
    // is what makes the drawer's lookup resolve to something. Which row sorts
    // first belongs to the component's own suite, so this asserts membership
    // rather than an order.
    expect(RECORDED_EVENTS.map((event) => event.id)).toContain(ref.eventId);
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });
});
