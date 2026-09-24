/**
 * `components/DependencyGraph` — the colocated suite of the `dependencyGraph`
 * node, and the proof of the three promises that view makes.
 *
 * ## What this suite is protecting
 *
 * The dependency graph is the library's one structural view: it answers "what
 * does this interaction touch" rather than "how long" or "how often", which
 * makes it the view a reader trusts to be a *picture of the capture* rather
 * than a picture that happens to be current. Three of its promises are
 * mechanical, and each has cases here:
 *
 *   - **The layout is reproducible.** AAP 0.6.6 records "interactive graph
 *     layout (drag, zoom) — not in v1; layered static layout with hover and
 *     click; annotated as a follow-up", so the geometry is arithmetic over a
 *     column index and a row index and nothing else. `determinism` renders one
 *     payload twice and then renders it with its participants **shuffled**,
 *     asserting the columns and the reading order do not move: layering must
 *     come from the relationships and a total tie-break, never from array
 *     order. A graph that reshuffled between two readings of one capture would
 *     read as noise and would quietly undermine the evidence it exists to
 *     present, which is why that case matters more here than any visual one.
 *     `layering` then pins the layering itself: one linear pass that lays a
 *     chain of any length out in full, gives a cycle one column, answers the
 *     same for any order of arrival, and is resolved once per payload and
 *     handed to the layout rather than computed again.
 *   - **Nothing interactive is implied that does not exist.** `static layout`
 *     dispatches a wheel and a pointer drag over the canvas and asserts every
 *     positional attribute is byte-identical afterwards, that no element
 *     carries a `transform` for a gesture to mutate, and that the only controls
 *     in the whole view are source chips — so the recorded gap stays a recorded
 *     gap instead of a control that looks draggable and is not. The note that
 *     states the limitation on screen is asserted alongside it.
 *   - **No selection is ever fabricated.** A participant is a *collapse* of
 *     records, and the aggregate declares an `eventId` and `traceId` on it only
 *     when it collapsed exactly one. `interactions` asserts that activating a
 *     participant without one highlights it locally and reports **nothing** to
 *     the host, while a participant that carries the declared coordinate
 *     reports exactly that coordinate, while a coordinate that breaks the
 *     declared rules (an event id on a multi-record participant, a malformed
 *     trace id) reports nothing and is counted under the grid — and `aggregate
 *     contract` proves the same end to end, over a graph the real aggregate
 *     built. A control claiming to select an event that does not exist would
 *     be an unevidenced claim of precisely the kind AAP 0.8.4 rules out.
 *
 * Alongside those, AAP 0.8.3 asks every component suite in this folder for the
 * three states of a query-backed view — loading, empty and error — and for the
 * click-to-source payload, and AAP 0.6.4 asks for the graph's second
 * representation: a picture of a graph is unreadable to a keyboard or a
 * screen-reader user, so the `accessibility` cases assert the canvas carries
 * `role="img"` with a text alternative **and** that the participants grid
 * beside it covers every participant, states its column, names its outgoing
 * relationships in text and is operable by keyboard.
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`, with `afterEach(cleanup)`
 *     registered explicitly: the `panel-renderer` project enables `globals`
 *     only so `@testing-library/react` can register its automatic cleanup, and
 *     a suite that leaks a mounted tree between cases fails later with a
 *     multiple-match error that reads like a component bug.
 *   - **Stub providers built with the library's own `createDataProvider`**, so
 *     these cases exercise the seam the DevTools panel and the editor webview
 *     implement — including its guarantee that a response answers for the
 *     source it was asked about. Every query the component issues is recorded
 *     in an array the cases assert on: what it *asked for* is as much of its
 *     contract as what it drew.
 *   - **In-file synthetic builders, no fixture files.** {@link makeGraph},
 *     {@link makeParticipant}, {@link makeEdge} and {@link makeNode} take
 *     overrides and return the authoritative telemetry types, optional
 *     `eventId`/`traceId` and `inferredCount`/`ambiguousCount` included; nothing
 *     here is read from disk or shared with another suite. Most payloads are
 *     hand-constructed and include shapes the aggregate would never emit (a
 *     participant with no `layer`, a cycle, an event id on a multi-record
 *     participant) because those are the defensive paths the component
 *     declares. The one exception is deliberate: the `aggregate contract` case
 *     runs the real `buildDependencyGraph` over hand-built events, so the
 *     fields this component reads are proven to be fields the aggregate
 *     produces rather than fields only this suite supplies.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4). Participant classes come
 *     from the closed telemetry domain, and every label, path and symbol
 *     belongs to no application, demonstration or otherwise:
 *     `example.interaction`, `example.handler`, `/example/resource`,
 *     `example.route`, `example.datastore`, `src/example/service.ts`.
 *     `scripts/check-no-hardcoding.mjs` scans `packages/**`, and a route or a
 *     component name of an inspected project here would fail that gate.
 *   - **Queries by role and accessible name.** The grid, its rows, its cells,
 *     the canvas (`role="img"`) and the chips are all reached that way; a class
 *     is read only off an element already obtained semantically, since no
 *     `jest-dom` matcher is available in this repository. SVG shapes carry no
 *     role by design — the canvas is one image — so they are read through the
 *     canvas element the role query returned.
 *   - **One pass-through module mock.** `../utils/scale` is mocked with its own
 *     implementation, recording calls to `resolveGraphLayering` and
 *     `layoutDependencyGraph` in a hoisted record, so `layering` can prove the
 *     layering is resolved once per payload and reused rather than computed a
 *     second time. Nothing about the geometry changes under the mock.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…`; `userEvent` drives pointer
 *     activation, and `fireEvent` the two low-level gestures (a wheel and a key
 *     press) `userEvent` has no vocabulary for.
 *   - **Aliased types, deliberately.** `DependencyGraphNode` names two
 *     different things in this monorepo: the panel-schema *specification* node
 *     (imported here as `DependencyGraphNodeSpec`, exactly as the component
 *     aliases it) and the telemetry *datum* for one participant (imported
 *     unaliased alongside `DependencyGraphData` and `DependencyGraphEdge`).
 *     Both arrive as types only; the one runtime import from
 *     `@debuggen/telemetry` is the aggregate itself, for the contract case.
 *
 * @see ./DependencyGraph for the component, its four states and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 * @see ../utils/scale for the layered geometry the positional assertions derive from.
 */

import type {
  DataQuery,
  DependencyGraphNode as DependencyGraphNodeSpec,
} from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { buildDependencyGraph } from '@debuggen/telemetry';
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
  TelemetryEvent,
} from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import { dependencyNodeColorVar } from '../utils/color';
import { formatDurationCompact, formatTierLabel } from '../utils/format';
import {
  DEFAULT_GRAPH_COLUMN_GAP,
  DEFAULT_GRAPH_NODE_HEIGHT,
  DEFAULT_GRAPH_NODE_WIDTH,
  DEFAULT_GRAPH_ROW_GAP,
  assignGraphLayers,
  layoutDependencyGraph,
  resolveGraphLayering,
} from '../utils/scale';
import type { GraphLayering } from '../utils/scale';
import type * as ScaleModule from '../utils/scale';
import { DependencyGraph } from './DependencyGraph';

/*
 * ---------------------------------------------------------------------------
 * The layering call record
 *
 * `../utils/scale` is mocked with its own implementation: every export behaves
 * exactly as shipped, and the two layering entry points additionally record
 * what they were called with, so the layering-once case can prove the component
 * resolves one layering per payload and hands that very object to the layout.
 * ---------------------------------------------------------------------------
 */

/** What the component asked of the two layering entry points since the last reset. */
interface ScaleCallRecord {
  /** Every layering `resolveGraphLayering` returned, in call order. */
  readonly resolved: GraphLayering[];

  /** The `layering` argument of every `layoutDependencyGraph` call, in call order. */
  readonly supplied: (GraphLayering | undefined)[];
}

/**
 * The record itself.
 *
 * Hoisted, because Vitest lifts the `vi.mock` factory above the imports and the
 * factory closes over it. Plain arrays rather than `vi.fn` history: `afterEach`
 * restores every mock, and this record must not depend on what that does to a
 * spy.
 */
const scaleCalls = vi.hoisted<ScaleCallRecord>(() => ({ resolved: [], supplied: [] }));

vi.mock('../utils/scale', async (importOriginal) => {
  const actual = await importOriginal<typeof ScaleModule>();

  const resolveGraphLayering: typeof actual.resolveGraphLayering = (nodes, edges) => {
    const layering = actual.resolveGraphLayering(nodes, edges);
    scaleCalls.resolved.push(layering);
    return layering;
  };

  const layoutDependencyGraph: typeof actual.layoutDependencyGraph = (data, options, layering) => {
    scaleCalls.supplied.push(layering);
    return actual.layoutDependencyGraph(data, options, layering);
  };

  return { ...actual, resolveGraphLayering, layoutDependencyGraph };
});

/** Empties {@link scaleCalls}, so a case reads only the calls its own render made. */
function resetScaleCalls(): void {
  scaleCalls.resolved.length = 0;
  scaleCalls.supplied.length = 0;
}

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Application-neutral throughout (AAP 0.5.4), and shaped as the capture shapes
 * it: a 32-hex trace id, 16-hex span ids, millisecond durations, a
 * project-relative POSIX source path.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace a single-record participant belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** The event id a single-record participant carries; see {@link makeParticipant}. */
const EVENT_ID = 'event-example-0001';

/** A project-relative, POSIX path for the one participant that resolved to source. */
const SOURCE_FILE = 'src/example/service.ts';

/** The symbol at that location, and its 1-based coordinates. */
const SOURCE_SYMBOL = 'runExample';
const SOURCE_LINE = 84;
const SOURCE_COLUMN = 9;

/** A complete, resolved location for the source-chip cases. */
const BASE_SOURCE: SourceLocation = {
  file: SOURCE_FILE,
  line: SOURCE_LINE,
  column: SOURCE_COLUMN,
  symbol: SOURCE_SYMBOL,
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

/** The accessible name the source chip announces (`SourceLink`'s own shape). */
const SOURCE_CHIP_NAME = `Open ${SOURCE_FILE}:${String(SOURCE_LINE)}:${String(SOURCE_COLUMN)}`;

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.dependencyGraph';

/**
 * The six participant classes of the closed telemetry domain, and the readable
 * names the component gives them.
 *
 * Spelled out rather than read back from the component, so this suite pins the
 * vocabulary a reader sees instead of restating whatever the component
 * currently holds — and so the legend case can assert that the key names these
 * six classes and nothing that belongs to an inspected application.
 */
const KINDS: readonly DependencyGraphNode['kind'][] = [
  'ui-event',
  'function',
  'api',
  'service',
  'database',
  'external',
];

/** The class labels, in the same order. */
const KIND_LABELS: readonly string[] = [
  'UI event',
  'Function',
  'API',
  'Service',
  'Database',
  'External',
];

/** The five participants of the chain most cases draw, by label. */
const INTERACTION_LABEL = 'example.interaction';
const HANDLER_LABEL = 'example.handler';
const REQUEST_LABEL = '/example/resource';
const ROUTE_LABEL = 'example.route';
const DATASTORE_LABEL = 'example.datastore';

/** Every fixture label, for the "nothing leaked into this state" assertions. */
const ALL_LABELS: readonly string[] = [
  INTERACTION_LABEL,
  HANDLER_LABEL,
  REQUEST_LABEL,
  ROUTE_LABEL,
  DATASTORE_LABEL,
];

/** The accessible name of the error state's serialised query (`ErrorState`'s own). */
const FAILING_QUERY_NAME = 'Failing query';

/** The error state's retry control. */
const RETRY_NAME = 'Retry';

/**
 * The 1-based `aria-colindex` of each column of the participants grid, in the
 * order the component declares them.
 *
 * Named constants rather than positional indices, because a cell is reached by
 * the ARIA coordinate the grid publishes: `role="gridcell"` alone cannot say
 * which column answered, and the participant column is a `rowheader` rather
 * than a gridcell, so counting cells would silently shift every later column.
 */
const LAYER_COLUMN = 1;
const PARTICIPANT_COLUMN = 2;
const CLASS_COLUMN = 3;
const RELATIONSHIPS_COLUMN = 5;
const SOURCE_COLUMN_INDEX = 6;

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return ordinal.toString(16).padStart(16, '0');
}

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/**
 * Overrides accepted by {@link makeParticipant}.
 *
 * The optional fields admit `undefined` explicitly, which `Partial` does not
 * under this repository's `exactOptionalPropertyTypes`: passing
 * `{ layer: undefined }` is how a case asks for a participant the payload never
 * placed — the defensive path where the component recomputes every column from
 * the relationships — and the builder drops the key rather than storing the
 * value. `eventId` and `traceId` are the authoritative datum's own optional
 * coordinate, which the aggregate sets for a participant that collapsed exactly
 * one record.
 */
type ParticipantOverrides = Partial<
  Pick<DependencyGraphNode, 'id' | 'kind' | 'label' | 'spanIds' | 'count' | 'totalDurationMs'>
> & {
  readonly tier?: DependencyGraphNode['tier'] | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly source?: SourceLocation | undefined;
  readonly layer?: number | undefined;
  readonly eventId?: DependencyGraphNode['eventId'] | undefined;
  readonly traceId?: DependencyGraphNode['traceId'] | undefined;
};

/**
 * One participant of a dependency graph.
 *
 * Complete by construction: an id, a class from the closed domain, a label, a
 * tier, a bounded span sample, a record count and the two durations a
 * participant collapses to. `maxDurationMs` defaults to the total, which is the
 * truthful value for a participant that collapsed a single record.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh participant; nothing is shared between calls.
 */
function makeParticipant(overrides: ParticipantOverrides = {}): DependencyGraphNode {
  const {
    id = 'dep:function|browser|example.participant',
    kind = 'function',
    label = 'example.participant',
    tier = 'browser',
    spanIds = [spanIdFor(1)],
    count = 1,
    totalDurationMs = 12,
    maxDurationMs = totalDurationMs,
    source,
    layer,
    eventId,
    traceId,
  } = overrides;

  return {
    id,
    kind,
    label,
    spanIds,
    count,
    totalDurationMs,
    maxDurationMs,
    ...(tier === undefined ? {} : { tier }),
    ...(source === undefined ? {} : { source }),
    ...(layer === undefined ? {} : { layer }),
    ...(eventId === undefined ? {} : { eventId }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

/**
 * Overrides accepted by {@link makeEdge}, with the same `undefined` policy.
 *
 * `inferredCount` and `ambiguousCount` are the authoritative edge's own
 * optional lineage counts (AAP 0.4.2): how many of its records joined their
 * caller through an asynchronous-continuation attribution rather than by
 * nesting, and how many of those attributions were ambiguous. The component
 * reads them and derives neither, so a guessed relationship can never read as a
 * measured one.
 */
type EdgeOverrides = {
  readonly id?: string | undefined;
  readonly count?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly inferredCount?: DependencyGraphEdge['inferredCount'] | undefined;
  readonly ambiguousCount?: DependencyGraphEdge['ambiguousCount'] | undefined;
};

/**
 * One caller-to-callee relationship.
 *
 * @param from The calling participant's id.
 * @param to The called participant's id.
 * @param overrides Fields to replace.
 * @returns A fresh relationship.
 */
function makeEdge(from: string, to: string, overrides: EdgeOverrides = {}): DependencyGraphEdge {
  const {
    id = `edge:${from}=>${to}`,
    count = 1,
    totalDurationMs = 12,
    inferredCount,
    ambiguousCount,
  } = overrides;

  return {
    id,
    from,
    to,
    count,
    totalDurationMs,
    ...(inferredCount === undefined ? {} : { inferredCount }),
    ...(ambiguousCount === undefined ? {} : { ambiguousCount }),
  };
}

/** Overrides accepted by {@link makeGraph}. */
interface GraphOverrides {
  /** The participants, in the order the provider hands them over. */
  readonly nodes?: readonly DependencyGraphNode[] | undefined;

  /** The relationships, in the order the provider hands them over. */
  readonly edges?: readonly DependencyGraphEdge[] | undefined;

  /** What the payload claims about its own column count. */
  readonly layerCount?: number | undefined;

  /** Whether the payload reports that it reached a size bound. */
  readonly truncated?: boolean | undefined;
}

/**
 * A dependency-graph payload, exactly as the `graph` source answers with one.
 *
 * `layerCount` defaults to the greatest declared `layer` plus one, and to `0`
 * for a payload that placed nothing — the value the aggregate itself reports
 * and, for the unplaced case, the honest statement that this payload carries no
 * layering of its own.
 *
 * @param overrides The participants, relationships and payload flags.
 * @returns A fresh payload; nothing is shared between calls.
 */
function makeGraph(overrides: GraphOverrides = {}): DependencyGraphData {
  const { nodes = [], edges = [], truncated = false } = overrides;
  const declared = nodes.map((node) => node.layer).filter((layer) => layer !== undefined);
  const layerCount =
    overrides.layerCount ?? (declared.length === 0 ? 0 : Math.max(...declared) + 1);

  return { nodes, edges, layerCount, truncated };
}

/** Overrides accepted by {@link makeNode}. */
type NodeOverrides = Partial<Pick<DependencyGraphNodeSpec, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `dependencyGraph` node, as the panel normaliser produces one: an
 * id, no heading (the host's section owns that) and the one data query this
 * view can draw.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): DependencyGraphNodeSpec {
  const { id = NODE_ID, query = { source: 'graph' }, title, description } = overrides;

  return {
    type: 'dependencyGraph',
    id,
    query,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The chain most cases draw
 *
 * Five participants spanning five classes and three tiers, joined into the
 * shape the correlated flow of an interaction actually takes: the page event,
 * the code it reached, the request boundary, the server work behind it and the
 * datastore it ended at. One participant collapsed two records and resolved to
 * source; the others collapsed one and did not.
 *
 * Two deliberate disorders, because a canonical fixture cannot tell a correct
 * implementation from one that follows array order:
 *
 *   - {@link CHAIN_PARTICIPANTS} is NOT in canonical order — the layers run
 *     3, 4, 0, 2, 1 as handed over;
 *   - {@link CHAIN_RELATIONSHIPS} is NOT in topological order — it runs from
 *     the last handover to the first, which is the input a layering that
 *     followed array order — or relaxed edges in list order a bounded number
 *     of times — would get wrong.
 * ---------------------------------------------------------------------------
 */

/** The page event the flow started at. */
const INTERACTION = makeParticipant({
  id: 'dep:ui-event|browser|example.interaction',
  kind: 'ui-event',
  label: INTERACTION_LABEL,
  tier: 'browser',
  spanIds: [spanIdFor(1)],
  totalDurationMs: 1175,
  layer: 0,
});

/** The browser-side function it reached. */
const HANDLER = makeParticipant({
  id: 'dep:function|browser|example.handler',
  kind: 'function',
  label: HANDLER_LABEL,
  tier: 'browser',
  spanIds: [spanIdFor(2)],
  totalDurationMs: 18,
  layer: 1,
});

/** The request boundary that function crossed. */
const REQUEST = makeParticipant({
  id: 'dep:api|browser|/example/resource',
  kind: 'api',
  label: REQUEST_LABEL,
  tier: 'browser',
  spanIds: [spanIdFor(3)],
  totalDurationMs: 1120,
  layer: 2,
});

/** The server work behind it. */
const ROUTE = makeParticipant({
  id: 'dep:service|server|example.route',
  kind: 'service',
  label: ROUTE_LABEL,
  tier: 'server',
  spanIds: [spanIdFor(4)],
  totalDurationMs: 1100,
  layer: 3,
});

/** The datastore it ended at: two collapsed records, and a resolved location. */
const DATASTORE = makeParticipant({
  id: 'dep:database|db|example.datastore',
  kind: 'database',
  label: DATASTORE_LABEL,
  tier: 'db',
  spanIds: [spanIdFor(5), spanIdFor(6)],
  count: 2,
  totalDurationMs: 640,
  maxDurationMs: 420,
  source: BASE_SOURCE,
  layer: 4,
});

/** The five participants, in the order the provider hands them over. */
const CHAIN_PARTICIPANTS: readonly DependencyGraphNode[] = [
  ROUTE,
  DATASTORE,
  INTERACTION,
  REQUEST,
  HANDLER,
];

/** The four handovers, from the last to the first. */
const CHAIN_RELATIONSHIPS: readonly DependencyGraphEdge[] = [
  makeEdge(ROUTE.id, DATASTORE.id, { count: 2, totalDurationMs: 640 }),
  makeEdge(REQUEST.id, ROUTE.id, { totalDurationMs: 1100 }),
  makeEdge(HANDLER.id, REQUEST.id, { totalDurationMs: 1120 }),
  makeEdge(INTERACTION.id, HANDLER.id, { totalDurationMs: 18 }),
];

/** The reading order the component must produce, whatever order the payload arrived in. */
const CANONICAL_LABELS: readonly string[] = [
  INTERACTION_LABEL,
  HANDLER_LABEL,
  REQUEST_LABEL,
  ROUTE_LABEL,
  DATASTORE_LABEL,
];

/** The column each of those participants belongs in, as the grid states it (1-based). */
const CANONICAL_LAYERS: readonly string[] = ['1', '2', '3', '4', '5'];

/**
 * The chain as a payload.
 *
 * A function rather than a constant, so no case can mutate what the next one
 * draws.
 *
 * @param overrides Payload flags to replace.
 * @returns The chain payload.
 */
function chainGraph(overrides: Omit<GraphOverrides, 'nodes' | 'edges'> = {}): DependencyGraphData {
  return makeGraph({ nodes: CHAIN_PARTICIPANTS, edges: CHAIN_RELATIONSHIPS, ...overrides });
}

/**
 * The same five participants and relationships with every `layer` removed.
 *
 * The defensive path the component declares: when a payload has not placed
 * *every* participant, the whole layering is recomputed from the relationships
 * rather than half-read, so the columns can never be a mixture of what arrived
 * and what was derived. The aggregate always places its participants, so this
 * shape exists only in this suite — and it is the one that proves layering
 * comes from the edges.
 *
 * @param nodes The participants to strip and reorder, in the order to hand over.
 * @returns The payload, carrying no layering of its own.
 */
function unplacedGraph(nodes: readonly DependencyGraphNode[]): DependencyGraphData {
  return makeGraph({
    nodes: nodes.map((node) => makeParticipant({ ...node, layer: undefined })),
    edges: CHAIN_RELATIONSHIPS,
    layerCount: 0,
  });
}

/*
 * ---------------------------------------------------------------------------
 * The tie the identity break has to settle
 *
 * Two participants in one column with **identical** totals, which is the case
 * where "by layer, then by descending total duration" runs out of answers. The
 * remaining rule is the id, and it is total — so the reading order is fixed for
 * either order of arrival, rather than being whichever the payload happened to
 * list first.
 * ---------------------------------------------------------------------------
 */

/** The participant both tied participants hang from. */
const TIE_ROOT = makeParticipant({
  id: 'dep:ui-event|browser|example.origin',
  kind: 'ui-event',
  label: 'example.origin',
  tier: 'browser',
  spanIds: [spanIdFor(11)],
  totalDurationMs: 90,
  layer: 0,
});

/** The first of the tied pair by identity. */
const TIE_ALPHA = makeParticipant({
  id: 'dep:function|server|example.alpha',
  kind: 'function',
  label: 'example.alpha',
  tier: 'server',
  spanIds: [spanIdFor(12)],
  totalDurationMs: 40,
  layer: 1,
});

/** The second, with exactly the same total time. */
const TIE_BETA = makeParticipant({
  id: 'dep:function|server|example.beta',
  kind: 'function',
  label: 'example.beta',
  tier: 'server',
  spanIds: [spanIdFor(13)],
  totalDurationMs: 40,
  layer: 1,
});

/**
 * The tied payload, in a caller-chosen order of arrival.
 *
 * @param nodes The three participants, in the order to hand over.
 * @returns The payload.
 */
function tieGraph(nodes: readonly DependencyGraphNode[]): DependencyGraphData {
  return makeGraph({
    nodes,
    edges: [makeEdge(TIE_ROOT.id, TIE_ALPHA.id), makeEdge(TIE_ROOT.id, TIE_BETA.id)],
  });
}

/*
 * ---------------------------------------------------------------------------
 * Stub providers
 *
 * Built through `createDataProvider`, the factory the library publishes for
 * exactly this shape: one resolver answering every query. Two things come with
 * it — the single type assertion the generic `DataProvider.query` signature
 * would otherwise force into this file, and the factory's own check that a
 * response answers for the source it was asked about.
 * ---------------------------------------------------------------------------
 */

/** A stub provider, the queries it has received and the resolver behind it. */
interface StubProvider {
  /** The provider to hand to {@link renderComponent}. */
  readonly provider: DataProvider;

  /**
   * Every query the component has asked for, in call order.
   *
   * The assertion surface for the retry and source-guard cases: what the
   * component *requested* is as much of its contract as what it rendered.
   */
  readonly queries: readonly DataQuery[];

  /** The recorded resolver, for call counts. */
  readonly resolve: Mock<DataQueryResolver>;
}

/**
 * A provider whose answers are computed per call.
 *
 * @param respond Called with each query and the 1-based number of the call.
 * @returns The stub, its recorded queries and its resolver.
 */
function recordingProvider(
  respond: (query: DataQuery, call: number) => Promise<DataQueryResponse>,
): StubProvider {
  const queries: DataQuery[] = [];
  const resolve = vi.fn<DataQueryResolver>((query) => {
    queries.push(query);

    return respond(query, queries.length);
  });

  return { provider: createDataProvider(resolve), queries, resolve };
}

/**
 * A provider that resolves the same payload for every query.
 *
 * The `graph` source is not paged — it answers with one whole graph rather than
 * a window of one — so there is no `total` and no `nextOffset` to report, and a
 * second call answers exactly as the first did.
 *
 * @param data The payload to answer with.
 * @returns The stub provider.
 */
function resolvingProvider(data: DependencyGraphData): StubProvider {
  return recordingProvider(() => Promise.resolve<DataQueryResponse>({ source: 'graph', data }));
}

/**
 * A provider whose promise never settles — the loading state, with no timer.
 *
 * @returns The stub provider.
 */
function pendingProvider(): StubProvider {
  return recordingProvider(() => new Promise<DataQueryResponse>(() => undefined));
}

/**
 * A provider that rejects every query.
 *
 * Rejects with a `DebuggenError` because that is what the interface asks an
 * implementation for: the code and the hint it carries are what the error state
 * renders (AAP 0.5.5).
 *
 * @param error The failure to reject with.
 * @returns The stub provider.
 */
function rejectingProvider(error: DebuggenError): StubProvider {
  return recordingProvider(() => Promise.reject(error));
}

/** The single query a stub received, failing when it received another count. */
function soleQuery(stub: StubProvider): DataQuery {
  expect(stub.queries).toHaveLength(1);

  const [query] = stub.queries;

  if (query === undefined) {
    throw new Error('the stub provider recorded no query');
  }

  return query;
}

/**
 * The query a stub received on the given 1-based call.
 *
 * @param stub The stub provider.
 * @param call The 1-based call number.
 * @returns That query.
 */
function queryOfCall(stub: StubProvider, call: number): DataQuery {
  const query = stub.queries[call - 1];

  if (query === undefined) {
    throw new Error(`the stub provider recorded no query for call ${String(call)}`);
  }

  return query;
}

/*
 * ---------------------------------------------------------------------------
 * Actions, rendering and DOM readers
 * ---------------------------------------------------------------------------
 */

/** A host's `PanelActions`, with every member a component could raise spied on. */
interface ActionSpies {
  /** The object to provide through {@link PanelActionsContext}. */
  readonly actions: PanelActions;

  /** The event-selection spy. */
  readonly onSelectEvent: Mock<(ref: PanelEventRef) => void>;

  /** The open-source spy. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;

  /** The optional disclosure spy, supplied so cases can assert it stays untouched. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** The optional filter/sort spy, supplied for the same reason. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host —
 * and both optional members are supplied too, so every case can assert not only
 * that the intent it exercised was raised but also that the others were not:
 * opening a source chip must not also select a participant, and selecting one
 * must report neither a disclosure nor a filter.
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
 * The session the rendered view's queries are addressed to, provided the way
 * `PanelHost` provides a specification's `sessionId`. Nothing below asserts on
 * it: the routing contract is pinned by `../host/PanelHost.test.tsx`.
 */
const PANEL_SESSION_ID = 'session-under-test';

/**
 * Renders the component inside both host contexts.
 *
 * The `RenderResult` is returned rather than discarded because two elements of
 * this view carry no role of their own — the class key and the notes block —
 * and are read off the container the render produced.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 * @returns The render result.
 */
function renderComponent(
  node: DependencyGraphNodeSpec,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): ReturnType<typeof render> {
  return render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <DependencyGraph node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );
}

/**
 * The canvas, obtained by role.
 *
 * The SVG is one image with a text alternative, so `role="img"` is its
 * semantic handle and the shapes inside it carry no roles at all — reading a
 * shape therefore starts here.
 *
 * @returns The canvas element.
 */
function canvas(): HTMLElement {
  return screen.getByRole('img');
}

/**
 * The grid's data rows, in document order.
 *
 * Obtained by role and then narrowed by the attribute the primitive writes on a
 * data row, because the header row is `role="row"` too and a bare role query
 * would count it.
 *
 * @returns The data rows.
 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-row-index') !== null);
}

/**
 * One cell of a row, by the 1-based ARIA column coordinate the grid publishes.
 *
 * @param row A row obtained by role.
 * @param columnIndex The `aria-colindex` of the wanted column.
 * @returns That cell.
 */
function cellOf(row: HTMLElement, columnIndex: number): HTMLElement {
  const cell = row.querySelector<HTMLElement>(`[aria-colindex="${String(columnIndex)}"]`);

  if (cell === null) {
    throw new Error(`the row rendered no cell at column ${String(columnIndex)}`);
  }

  return cell;
}

/**
 * The label element of a row: the one element the component marks with the
 * participant's id.
 *
 * Read by that attribute rather than by the header's whole text content: the
 * cell also carries the detail — in the tooltip's description while the row is
 * unfocused, on a second line while it holds focus — which a bare `textContent`
 * would concatenate. The attribute is on the label in both forms, so the reader
 * works whichever one the row is in.
 *
 * @param row A row obtained by role.
 * @returns The label element.
 */
function participantLabelElementOf(row: HTMLElement): HTMLElement {
  const header = within(row).getByRole('rowheader');
  const labels = header.querySelectorAll<HTMLElement>('[data-participant-id]');
  const label = labels[0];

  if (label === undefined || labels.length !== 1) {
    throw new Error(`the participant cell rendered ${String(labels.length)} labels, not one`);
  }

  return label;
}

/**
 * The participant label of a row.
 *
 * @param row A row obtained by role.
 * @returns The label that row stands for.
 */
function participantLabelOf(row: HTMLElement): string {
  return participantLabelElementOf(row).textContent ?? '';
}

/** The participant labels of the grid, in document order. */
function participantLabels(): string[] {
  return dataRows().map(participantLabelOf);
}

/** The column each row states, in document order. */
function statedLayers(): string[] {
  return dataRows().map((row) => cellOf(row, LAYER_COLUMN).textContent ?? '');
}

/**
 * The whole reading of the grid: one label-and-column pair per row, in order.
 *
 * The comparison surface of the determinism cases — it holds every input to the
 * layout that a reader can see, so two readings that match cannot differ in
 * what was drawn.
 *
 * @returns The rows as label/layer pairs.
 */
function reading(): { label: string; layer: string }[] {
  return dataRows().map((row) => ({
    label: participantLabelOf(row),
    layer: cellOf(row, LAYER_COLUMN).textContent ?? '',
  }));
}

/**
 * The row standing for a participant.
 *
 * @param label The participant's label.
 * @returns That row.
 */
function rowNamed(label: string): HTMLElement {
  const row = dataRows().find((candidate) => participantLabelOf(candidate) === label);

  if (row === undefined) {
    throw new Error(`no rendered row stands for "${label}"`);
  }

  return row;
}

/** The participant shapes of the canvas, in document order. */
function nodeShapes(): Element[] {
  return Array.from(canvas().querySelectorAll('rect.dg-dependency-graph__node'));
}

/** The labels drawn inside those shapes, in document order. */
function canvasLabels(): string[] {
  return Array.from(canvas().querySelectorAll('text.dg-dependency-graph__node-label')).map(
    (label) => label.textContent ?? '',
  );
}

/** The relationship curves of the canvas, in document order. */
function edgeCurves(): Element[] {
  return Array.from(canvas().querySelectorAll('path.dg-dependency-graph__edge'));
}

/**
 * The shape standing for a participant.
 *
 * Resolved through the labels drawn on the canvas, which are in the same order
 * as the shapes by construction — the two come from one array — so this is the
 * canvas counterpart of {@link rowNamed}.
 *
 * @param label The participant's label.
 * @returns That shape.
 */
function shapeNamed(label: string): Element {
  const shape = nodeShapes()[canvasLabels().indexOf(label)];

  if (shape === undefined) {
    throw new Error(`no drawn shape stands for "${label}"`);
  }

  return shape;
}

/** The column groups of the canvas, in document order. */
function columnGroups(): Element[] {
  return Array.from(canvas().querySelectorAll('g.dg-dependency-graph__column'));
}

/**
 * Every positional attribute of every participant shape, in document order.
 *
 * The geometry snapshot the static-layout case compares before and after a
 * gesture: a drag or a zoom that had been implemented would have to move one of
 * these numbers (or introduce a `transform`, which that case checks for
 * separately).
 *
 * @returns One record per shape.
 */
function shapeGeometry(): (string | null)[][] {
  return nodeShapes().map((shape) => [
    shape.getAttribute('x'),
    shape.getAttribute('y'),
    shape.getAttribute('width'),
    shape.getAttribute('height'),
  ]);
}

/**
 * The relationship chips of a row, in document order.
 *
 * @param row A row obtained by role.
 * @returns The chips, each identified by the relationship it stands for.
 */
function relationshipChips(row: HTMLElement): HTMLElement[] {
  return Array.from(
    cellOf(row, RELATIONSHIPS_COLUMN).querySelectorAll<HTMLElement>('[data-edge-id]'),
  );
}

/**
 * The class key of the view.
 *
 * The key carries no role — it is a row of chips, each of which prints its own
 * meaning as text — so it is read off the rendered container by the class the
 * component documents.
 *
 * @param container The container the render produced.
 * @returns The key element.
 */
function legendOf(container: HTMLElement): HTMLElement {
  const legend = container.querySelector<HTMLElement>('.dg-dependency-graph__legend');

  if (legend === null) {
    throw new Error('the view rendered no class key');
  }

  return legend;
}

// Explicit, per the harness note above: automatic cleanup belongs to the
// runner's configuration, this guarantee belongs to the suite. Restoring spies
// in the same place keeps one case's mock out of the next.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DependencyGraph states', () => {
  it('announces that it is busy, and draws no graph, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes the
    // element class that places it.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.closest('.dg-dependency-graph__loading')).not.toBeNull();
    expect(busy.textContent).toContain('dependency graph');

    // Nothing is drawn yet: no canvas, no grid, and above all no empty state —
    // an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();

    // One query, and it was issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(soleQuery(stub)).toEqual({ source: 'graph' });
  });

  it('renders its own empty message, and no canvas, for a graph with no participants', async () => {
    const stub = resolvingProvider(makeGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic substring of the product's own copy and then checked
    // to be exactly that: product vocabulary, naming no inspected project
    // (AAP 0.5.4).
    const message = await screen.findByText(/no dependency relationships were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-dependency-graph__empty')).not.toBeNull();

    for (const label of ALL_LABELS) {
      expect(message.textContent).not.toContain(label);
    }

    // An empty graph is a success, so it is drawn as an absence rather than as
    // a failure, and there is no picture and no grid to hold participants.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.', {
        hint: 'Reconnect the panel and ask again.',
      }),
    );
    const user = userEvent.setup();

    renderComponent(makeNode({ query: { source: 'graph', filter: { traceId: TRACE_ID } } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-dependency-graph__error')).not.toBeNull();

    // The provider's own message, hint and code reach the reader rather than a
    // generic sentence written over them.
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('Reconnect the panel and ask again.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, and compared as a value rather
    // than as a spelling.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'graph',
      filter: { traceId: TRACE_ID },
    });

    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The retry an error state offers is only useful if it really re-queries.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual(queryOfCall(stub, 1));

    // No participants were invented behind the failure.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('reports a node whose query names a source it cannot draw, and asks for nothing', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode({ query: { source: 'spans', sort: 'duration_desc' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-dependency-graph__error')).not.toBeNull();

    // Both sources are named — the one this view draws and the one it was asked
    // for — because the reader's next action is to regenerate the panel.
    expect(alert.textContent).toContain('graph');
    expect(alert.textContent).toContain('spans');
    expect(alert.textContent).toContain('PANEL_INVALID');

    // The node's own query is what the reader is shown, and no retry is
    // offered: re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'spans',
      sort: 'duration_desc',
    });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
  });
});

describe('DependencyGraph rendering', () => {
  it('draws one shape and one row per participant, and one curve per relationship', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The grid is named by the component's caption, spelled out here rather
    // than read back through the catalog so this case pins the name a reader
    // hears.
    await screen.findByRole('grid', {
      name: 'Dependency graph: every participant by layer, with its outgoing relationships and its source location.',
    });

    expect(dataRows()).toHaveLength(CHAIN_PARTICIPANTS.length);
    expect(nodeShapes()).toHaveLength(CHAIN_PARTICIPANTS.length);
    expect(edgeCurves()).toHaveLength(CHAIN_RELATIONSHIPS.length);

    // The payload arrived out of order (layers 3, 4, 0, 2, 1); both
    // representations read in canonical order, and in the same order as each
    // other — they are one array.
    expect(participantLabels()).toEqual(CANONICAL_LABELS);
    expect(canvasLabels()).toEqual(CANONICAL_LABELS);
    expect(statedLayers()).toEqual(CANONICAL_LAYERS);

    // The participant is the row's header cell rather than one gridcell among
    // six, so a screen reader names the participant before reading its numbers.
    for (const row of dataRows()) {
      expect(cellOf(row, PARTICIPANT_COLUMN).getAttribute('role')).toBe('rowheader');
    }

    // Every participant states its class in text, so the class colour is never
    // the only thing distinguishing two of them (AAP 0.6.4).
    expect(dataRows().map((row) => cellOf(row, CLASS_COLUMN).textContent)).toEqual([
      'UI event',
      'Function',
      'API',
      'Service',
      'Database',
    ]);

    // One query, for the one source this view draws.
    expect(soleQuery(stub)).toEqual({ source: 'graph' });
  });

  it('carries each participant class as its stylesheet modifier and its token colour', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const shape = shapeNamed(DATASTORE_LABEL);
    expect(shape.classList.contains('dg-dependency-graph__node--database')).toBe(true);

    // The only inline value a shape carries is the custom property, and its
    // value is a `var(--dg-*)` reference from the shared class scale: no colour
    // literal reaches this component (AAP 0.6.4).
    const style = shape.getAttribute('style') ?? '';
    expect(style).toContain(dependencyNodeColorVar('database'));
    expect(style).not.toContain('#');
    expect(style).not.toContain('rgb');
  });

  it('states what the picture holds and repeats every participant in the grid', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // The canvas is one image with a text alternative that says what it holds
    // and where the keyboard-reachable equivalent is (AAP 0.6.4).
    const alternative = canvas().getAttribute('aria-label') ?? '';
    expect(alternative).toContain('5 participants');
    expect(alternative).toContain('5 layers');
    expect(alternative).toContain('4 relationships');
    expect(alternative).toContain('participants table below');

    // The equivalent is complete: every participant, its column, and every
    // relationship it starts named in text rather than drawn as a curve only.
    const expectedOutgoing: readonly (readonly [string, readonly string[]])[] = [
      [INTERACTION_LABEL, [HANDLER_LABEL]],
      [HANDLER_LABEL, [REQUEST_LABEL]],
      [REQUEST_LABEL, [ROUTE_LABEL]],
      [ROUTE_LABEL, [DATASTORE_LABEL]],
      [DATASTORE_LABEL, []],
    ];

    expect(participantLabels()).toEqual(expectedOutgoing.map(([label]) => label));

    for (const [label, targets] of expectedOutgoing) {
      const row = rowNamed(label);
      const chips = relationshipChips(row);
      expect(chips).toHaveLength(targets.length);

      for (const [index, target] of targets.entries()) {
        expect(chips[index]?.textContent ?? '').toContain(target);
      }

      if (targets.length === 0) {
        // A participant that calls nothing says so, rather than borrowing a
        // neighbour's relationship.
        expect(cellOf(row, RELATIONSHIPS_COLUMN).textContent ?? '').not.toContain('→');
      }
    }
  });

  it('gives the grid one tab stop, moves between rows and activates from the keyboard', async () => {
    const spies = makeActions();
    const stub = resolvingProvider(chainGraph());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    // A roving tab stop: the body is reachable by Tab in one press, and the
    // rows are navigated with the arrow keys rather than with four more.
    const [first, ...rest] = dataRows();
    if (first === undefined) {
      throw new Error('the grid rendered no data row');
    }

    expect(first.getAttribute('tabindex')).toBe('0');
    expect(rest.map((row) => row.getAttribute('tabindex'))).toEqual(rest.map(() => '-1'));

    // Entered the way a keyboard user enters it, with one Tab. Pressing an
    // arrow on a row that never received focus is not a gesture a reader can
    // make, and it would race the grid's own focus bookkeeping against the
    // commit that mounted it.
    await user.tab();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'ArrowDown' });

    // Re-read rather than reused: the rows are re-rendered by the key, and an
    // assertion against a node the commit replaced would pass on a stale tree.
    const second = dataRows()[1];
    if (second === undefined) {
      throw new Error('the grid rendered no second data row');
    }

    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(participantLabelOf(second)).toBe(HANDLER_LABEL);

    fireEvent.keyDown(second, { key: 'Enter' });

    // Activation from the keyboard reaches the same handler a click does: the
    // row is selected, and so is its shape on the canvas.
    expect(rowNamed(HANDLER_LABEL).getAttribute('aria-selected')).toBe('true');
    expect(shapeNamed(HANDLER_LABEL).classList.contains('dg-is-selected')).toBe(true);

    // This participant carries no event coordinate, so nothing was reported to
    // the host; see the interaction cases for both halves of that rule.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('states on screen that the layout is static, with no gesture implied', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // AAP 0.6.6 records the gap; this sentence is how a reader learns it
    // without trying to drag the picture first.
    const note = await screen.findByText(/this layout is static in this version/i);
    expect(note.textContent).toContain('Dragging, panning and zooming are not available.');
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
  });

  it('places the columns on the shared layered scale', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // Derived from the scale module's own rhythm rather than written as
    // numbers: the assertion is the relation (one column per layer, in order),
    // not a pixel value this suite would have to be edited for.
    const columnPitch = DEFAULT_GRAPH_NODE_WIDTH + DEFAULT_GRAPH_COLUMN_GAP;

    expect(nodeShapes().map((shape) => shape.getAttribute('x'))).toEqual(
      CANONICAL_LABELS.map((_label, layer) => String(layer * columnPitch)),
    );

    // One participant per column here, so every shape sits on the first row of
    // its own column.
    expect(nodeShapes().map((shape) => shape.getAttribute('y'))).toEqual(
      CANONICAL_LABELS.map(() => '0'),
    );
    expect(nodeShapes().map((shape) => shape.getAttribute('width'))).toEqual(
      CANONICAL_LABELS.map(() => String(DEFAULT_GRAPH_NODE_WIDTH)),
    );
    expect(nodeShapes().map((shape) => shape.getAttribute('height'))).toEqual(
      CANONICAL_LABELS.map(() => String(DEFAULT_GRAPH_NODE_HEIGHT)),
    );

    // The groups the shapes are drawn in ascend by column, which is what makes
    // document order and reading order the same thing.
    expect(columnGroups().map((group) => group.getAttribute('data-layer'))).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
    ]);
  });
});

describe('DependencyGraph keyboard detail', () => {
  /** A generic label far longer than the participant column shows, so the column truncates it. */
  const LONG_LABEL =
    'example.participant.with.a.label.long.enough.that.its.column.has.to.shorten.it';

  /** The chain, with the participant of its first row given {@link LONG_LABEL}. */
  function longLabelGraph(): DependencyGraphData {
    return makeGraph({
      nodes: CHAIN_PARTICIPANTS.map((node) =>
        node.id === INTERACTION.id ? makeParticipant({ ...node, label: LONG_LABEL }) : node,
      ),
      edges: CHAIN_RELATIONSHIPS,
    });
  }

  /**
   * Asserts that a row shows its label in the pointer form: truncated by the
   * stylesheet, inside the tooltip trigger.
   *
   * @param row A row obtained by role.
   */
  function expectTooltipForm(row: HTMLElement): void {
    const label = participantLabelElementOf(row);
    expect(label.classList.contains('dg-text--truncate')).toBe(true);
    expect(label.closest('.dg-tooltip__trigger')).not.toBeNull();
  }

  /**
   * Asserts that a row shows its participant's detail inline: the full label,
   * untruncated and outside any tooltip, then the tier and the metrics.
   *
   * @param row A row obtained by role.
   * @param node The participant it stands for.
   */
  function expectInlineForm(row: HTMLElement, node: DependencyGraphNode): void {
    const label = participantLabelElementOf(row);
    expect(label.textContent).toBe(node.label);
    expect(label.classList.contains('dg-text--truncate')).toBe(false);
    expect(label.closest('.dg-tooltip')).toBeNull();

    const tier = node.tier === undefined ? '' : `${formatTierLabel(node.tier)} · `;
    const metrics = `Records ${String(node.count)} · Total ${formatDurationCompact(node.totalDurationMs)} · Slowest ${formatDurationCompact(node.maxDurationMs)}`;
    const header = within(row).getByRole('rowheader');
    expect(header.textContent).toBe(`${node.label}${tier}${metrics}`);
    expect(header.querySelector('[role="tooltip"]')).toBeNull();
  }

  /** The grid, and every element in it that carries a tab index. */
  function gridTabIndices(): { readonly zero: number; readonly total: number } {
    const indexed = Array.from(screen.getByRole('grid').querySelectorAll('[tabindex]'));
    return {
      zero: indexed.filter((element) => element.getAttribute('tabindex') === '0').length,
      total: indexed.length,
    };
  }

  it('shows the focused row its full label and detail inline, and nothing else changes form', async () => {
    const user = userEvent.setup();
    const stub = resolvingProvider(longLabelGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // Unfocused, every label is the pointer form: truncated, with the tooltip.
    for (const row of dataRows()) {
      expectTooltipForm(row);
    }

    // One Tab reaches the grid's single tab stop, the first row.
    await user.tab();

    const [first, ...others] = dataRows();
    if (first === undefined) {
      throw new Error('the grid rendered no data row');
    }

    expect(document.activeElement).toBe(first);
    expectInlineForm(first, makeParticipant({ ...INTERACTION, label: LONG_LABEL }));

    // The rows that do not hold focus keep the pointer form.
    for (const row of others) {
      expectTooltipForm(row);
    }
  });

  it('moves the detail with the arrow keys and restores the pointer form when focus leaves', async () => {
    const user = userEvent.setup();
    const stub = resolvingProvider(longLabelGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    await user.tab();
    await user.keyboard('{ArrowDown}');

    // Re-read: the key re-renders the rows.
    const [first, second] = dataRows();
    if (first === undefined || second === undefined) {
      throw new Error('the grid rendered fewer than two data rows');
    }

    expect(document.activeElement).toBe(second);
    expectInlineForm(second, HANDLER);
    expectTooltipForm(first);
    expect(participantLabelOf(first)).toBe(LONG_LABEL);

    // Focus leaving the grid takes the detail with it.
    act(() => {
      second.blur();
    });

    expect(document.activeElement).not.toBe(second);
    for (const row of dataRows()) {
      expectTooltipForm(row);
    }
  });

  it('adds no tab stop: the grid keeps exactly one before, during and after focus', async () => {
    const user = userEvent.setup();
    const stub = resolvingProvider(longLabelGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // Only the rows carry a tab index, and exactly one of them is the stop.
    const rowCount = dataRows().length;
    expect(gridTabIndices()).toEqual({ zero: 1, total: rowCount });

    await user.tab();
    expect(gridTabIndices()).toEqual({ zero: 1, total: rowCount });

    await user.keyboard('{ArrowDown}');
    expect(gridTabIndices()).toEqual({ zero: 1, total: rowCount });

    // Nothing focusable was put in a participant cell to carry the detail.
    for (const row of dataRows()) {
      const header = within(row).getByRole('rowheader');
      expect(
        header.querySelectorAll('[tabindex], a, button, input, select, textarea'),
      ).toHaveLength(0);
    }
  });
});

describe('DependencyGraph determinism', () => {
  it('draws one payload identically across two fresh mounts', async () => {
    const first = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: first.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const firstReading = reading();
    const firstGeometry = shapeGeometry();

    expect(firstReading.map((row) => row.label)).toEqual(CANONICAL_LABELS);

    // A second MOUNT rather than a re-render, and a second provider object
    // rather than the same one: the question is whether the layout is a
    // function of the payload, so nothing — no state, no memo, no cache — may
    // survive between the two readings.
    cleanup();

    const second = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: second.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(reading()).toEqual(firstReading);
    expect(shapeGeometry()).toEqual(firstGeometry);
    expect(canvasLabels()).toEqual(CANONICAL_LABELS);
  });

  it('assigns the same columns from the relationships when the participants arrive shuffled', async () => {
    const ordered = resolvingProvider(
      unplacedGraph([INTERACTION, HANDLER, REQUEST, ROUTE, DATASTORE]),
    );

    renderComponent(makeNode(), { provider: ordered.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const orderedReading = reading();
    const orderedGeometry = shapeGeometry();

    // The payload placed nothing, so every column here was derived from the
    // handovers — and the handovers arrived from the last to the first, which
    // is the input a layering that followed list order would get wrong.
    expect(orderedReading.map((row) => row.label)).toEqual(CANONICAL_LABELS);
    expect(orderedReading.map((row) => row.layer)).toEqual(CANONICAL_LAYERS);

    // And the component says where the columns came from rather than
    // presenting a derived layering as a captured one.
    const note = await screen.findByText(/computed from the relationships/i);
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();

    cleanup();

    const shuffled = resolvingProvider(
      unplacedGraph([DATASTORE, REQUEST, INTERACTION, ROUTE, HANDLER]),
    );

    renderComponent(makeNode(), { provider: shuffled.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // The same participants and the same relationships in another order are the
    // same graph: identical columns, identical reading order, identical
    // geometry. This is the case that fails if layering ever follows the array.
    expect(reading()).toEqual(orderedReading);
    expect(shapeGeometry()).toEqual(orderedGeometry);
  });

  it('settles a tie inside one column by identity, for either order of arrival', async () => {
    const ordered = resolvingProvider(tieGraph([TIE_ROOT, TIE_ALPHA, TIE_BETA]));

    renderComponent(makeNode(), { provider: ordered.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const orderedReading = reading();

    expect(orderedReading).toEqual([
      { label: 'example.origin', layer: '1' },
      { label: 'example.alpha', layer: '2' },
      { label: 'example.beta', layer: '2' },
    ]);

    // The tied pair shares a column and is stacked inside it on the scale
    // module's own row rhythm.
    const rowPitch = DEFAULT_GRAPH_NODE_HEIGHT + DEFAULT_GRAPH_ROW_GAP;
    const alpha = shapeNamed('example.alpha');
    const beta = shapeNamed('example.beta');

    expect(beta.getAttribute('x')).toBe(alpha.getAttribute('x'));
    expect(alpha.getAttribute('y')).toBe('0');
    expect(beta.getAttribute('y')).toBe(String(rowPitch));

    cleanup();

    const shuffled = resolvingProvider(tieGraph([TIE_BETA, TIE_ALPHA, TIE_ROOT]));

    renderComponent(makeNode(), { provider: shuffled.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(reading()).toEqual(orderedReading);
    expect(shapeNamed('example.beta').getAttribute('y')).toBe(String(rowPitch));
  });
});

describe('DependencyGraph cycles', () => {
  it('draws a cyclic flow without hanging, throwing or dropping a participant', async () => {
    // A cycle is what a mutually dependent pair of participants produces, and
    // no longest path can order one: the layering groups a cycle into one
    // strongly connected component in a single linear pass, and this case is
    // the proof that the pass terminates and keeps every member.
    const first = makeParticipant({
      id: 'dep:ui-event|browser|example.first',
      kind: 'ui-event',
      label: 'example.first',
      tier: 'browser',
      spanIds: [spanIdFor(21)],
      totalDurationMs: 30,
    });
    const second = makeParticipant({
      id: 'dep:function|browser|example.second',
      kind: 'function',
      label: 'example.second',
      tier: 'browser',
      spanIds: [spanIdFor(22)],
      totalDurationMs: 20,
    });
    const third = makeParticipant({
      id: 'dep:api|browser|example.third',
      kind: 'api',
      label: 'example.third',
      tier: 'browser',
      spanIds: [spanIdFor(23)],
      totalDurationMs: 10,
    });

    const cycle = makeGraph({
      nodes: [first, second, third],
      edges: [
        makeEdge(first.id, second.id),
        makeEdge(second.id, third.id),
        makeEdge(third.id, first.id),
      ],
      layerCount: 0,
    });

    const stub = resolvingProvider(cycle);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // Every participant is still there, once each, in both representations.
    expect(participantLabels()).toEqual(['example.first', 'example.second', 'example.third']);
    expect(canvasLabels()).toEqual(['example.first', 'example.second', 'example.third']);
    expect(nodeShapes()).toHaveLength(3);

    // Every relationship is still drawn, including the one that runs backwards.
    expect(edgeCurves()).toHaveLength(3);

    const [backwards] = relationshipChips(rowNamed('example.third'));
    if (backwards === undefined) {
      throw new Error('the closing participant of the cycle rendered no relationship chip');
    }

    expect(backwards.textContent).toContain('example.first');

    // A cycle cannot be ordered, so its members share a column and are stacked
    // in it — a legible answer rather than an invented ordering.
    const stated = statedLayers();
    expect(new Set(stated).size).toBe(1);
    expect(columnGroups()).toHaveLength(1);

    const rowPitch = DEFAULT_GRAPH_NODE_HEIGHT + DEFAULT_GRAPH_ROW_GAP;
    expect(nodeShapes().map((shape) => shape.getAttribute('y'))).toEqual([
      '0',
      String(rowPitch),
      String(rowPitch * 2),
    ]);
  });
});

describe('DependencyGraph layering', () => {
  /** A layering as a plain record, so two maps compare regardless of insertion order. */
  function layersRecord(layers: ReadonlyMap<string, number>): Record<string, number> {
    return Object.fromEntries(layers);
  }

  /** One order of arrival of a graph: its participants and its relationships. */
  type Arrival = readonly [readonly DependencyGraphNode[], readonly DependencyGraphEdge[]];

  /** A copy of `values` starting at position `by` and wrapping round. */
  function rotated<T>(values: readonly T[], by: number): T[] {
    return [...values.slice(by), ...values.slice(0, by)];
  }

  /** The id of step `index` of a synthetic chain. */
  function stepId(index: number): string {
    return `dep:function|server|example.step-${String(index)}`;
  }

  /**
   * A chain of `length` unplaced participants, step `i` calling step `i + 1`,
   * with its relationships listed from the LAST handover to the first.
   *
   * @param length How many steps.
   * @returns The participants in step order and the relationships in reverse.
   */
  function reversedChain(length: number): {
    readonly nodes: readonly DependencyGraphNode[];
    readonly edges: readonly DependencyGraphEdge[];
  } {
    const nodes = Array.from({ length }, (_unused, index) =>
      makeParticipant({ id: stepId(index), label: `example.step-${String(index)}` }),
    );
    const edges = Array.from({ length: Math.max(length - 1, 0) }, (_unused, offset) => {
      const from = length - 2 - offset;
      return makeEdge(stepId(from), stepId(from + 1));
    });

    return { nodes, edges };
  }

  it('reads a fully placed payload as given, and computes an incomplete one whole', () => {
    const placed = chainGraph();
    const fromPayload = resolveGraphLayering(placed.nodes, placed.edges);

    expect(fromPayload.computed).toBe(false);
    expect(layersRecord(fromPayload.layers)).toEqual(
      Object.fromEntries(placed.nodes.map((node) => [node.id, node.layer])),
    );

    const unplaced = unplacedGraph(CHAIN_PARTICIPANTS);
    const computed = resolveGraphLayering(unplaced.nodes, unplaced.edges);

    expect(computed.computed).toBe(true);
    expect(layersRecord(computed.layers)).toEqual({
      [INTERACTION.id]: 0,
      [HANDLER.id]: 1,
      [REQUEST.id]: 2,
      [ROUTE.id]: 3,
      [DATASTORE.id]: 4,
    });

    // All or nothing: one participant without a usable column — absent,
    // negative or fractional — recomputes every column, so the declared `7`
    // below is not mixed with derived ones.
    for (const unusable of [undefined, -1, 1.5]) {
      const mixed = resolveGraphLayering(
        [
          makeParticipant({ ...INTERACTION, layer: 7 }),
          makeParticipant({ ...HANDLER, layer: unusable }),
        ],
        [makeEdge(INTERACTION.id, HANDLER.id)],
      );

      expect(mixed.computed).toBe(true);
      expect(layersRecord(mixed.layers)).toEqual({ [INTERACTION.id]: 0, [HANDLER.id]: 1 });
    }
  });

  it('lays the graph out by the layering it is handed and never resolves its own', () => {
    // Deliberately NOT the payload's layering: the columns are reversed and the
    // flag says "computed" although the payload placed every participant. A
    // layout that recomputed would draw the payload's columns and say "read".
    const placed = chainGraph();
    const reversed: GraphLayering = {
      layers: new Map([
        [INTERACTION.id, 4],
        [HANDLER.id, 3],
        [REQUEST.id, 2],
        [ROUTE.id, 1],
        [DATASTORE.id, 0],
      ]),
      computed: true,
    };

    const layout = layoutDependencyGraph(placed, undefined, reversed);

    expect(
      Object.fromEntries(
        layout.nodes.map((positioned) => [positioned.node.id, positioned.box.layer]),
      ),
    ).toEqual(layersRecord(reversed.layers));
    expect(layout.layersComputed).toBe(true);
    expect(layout.layerCount).toBe(5);

    // The other flag, the other way round: an unplaced payload handed a flat
    // layering that says it was read keeps both the columns and the flag.
    const unplaced = unplacedGraph(CHAIN_PARTICIPANTS);
    const flat: GraphLayering = {
      layers: new Map(unplaced.nodes.map((node) => [node.id, 0])),
      computed: false,
    };

    const flatLayout = layoutDependencyGraph(unplaced, undefined, flat);

    expect(flatLayout.nodes.map((positioned) => positioned.box.layer)).toEqual([0, 0, 0, 0, 0]);
    expect(flatLayout.layersComputed).toBe(false);
    expect(flatLayout.layerCount).toBe(1);

    // Handed nothing, it resolves the layering itself, by the same rule.
    const own = layoutDependencyGraph(unplaced);

    expect(own.layersComputed).toBe(true);
    expect(
      Object.fromEntries(own.nodes.map((positioned) => [positioned.node.id, positioned.box.layer])),
    ).toEqual(layersRecord(resolveGraphLayering(unplaced.nodes, unplaced.edges).layers));
  });

  it('lays a 600-step chain out in full when its relationships arrive last to first', () => {
    // Relaxing edges in list order moves a reversed chain's frontier one column
    // per pass, so any pass budget below the chain's length strands the tail
    // short of its column. The linear layering has no budget to run out of.
    const length = 600;
    const { nodes, edges } = reversedChain(length);

    const layers = assignGraphLayers(nodes, edges);

    expect(layers.size).toBe(length);
    expect(Array.from({ length }, (_unused, index) => layers.get(stepId(index)))).toEqual(
      Array.from({ length }, (_unused, index) => index),
    );
  });

  it('never recurses, so neither a very long chain nor a very long cycle can exhaust the stack', () => {
    const length = 50_000;
    const { nodes, edges } = reversedChain(length);

    const chain = assignGraphLayers(nodes, edges);

    expect(chain.get(stepId(0))).toBe(0);
    expect(chain.get(stepId(length - 1))).toBe(length - 1);

    // Closing the chain makes every step reach every other: one strongly
    // connected component, and therefore one shared column.
    const cycle = assignGraphLayers(nodes, [...edges, makeEdge(stepId(length - 1), stepId(0))]);

    expect(new Set(cycle.values())).toEqual(new Set([0]));
    expect(cycle.size).toBe(length);
  });

  it('gives the members of a cycle one column, and the same map for any order of arrival', () => {
    const origin = makeParticipant({ id: 'dep:ui-event|browser|example.origin', layer: undefined });
    const loopA = makeParticipant({ id: 'dep:function|browser|example.loop-a', layer: undefined });
    const loopB = makeParticipant({ id: 'dep:function|browser|example.loop-b', layer: undefined });
    const loopC = makeParticipant({ id: 'dep:function|browser|example.loop-c', layer: undefined });
    const sink = makeParticipant({ id: 'dep:database|db|example.sink', layer: undefined });

    const nodes = [
      origin,
      loopA,
      loopB,
      loopC,
      sink,
      makeParticipant({ ...loopA, label: 'again' }),
    ];
    const edges = [
      makeEdge(origin.id, loopA.id),
      makeEdge(loopA.id, loopB.id),
      makeEdge(loopB.id, loopC.id),
      makeEdge(loopC.id, loopA.id),
      makeEdge(loopC.id, sink.id),
      // Ignored: a self-reference, and a participant the graph does not hold.
      makeEdge(loopB.id, loopB.id),
      makeEdge(sink.id, 'dep:external|server|example.absent'),
    ];

    const expected = {
      [origin.id]: 0,
      [loopA.id]: 1,
      [loopB.id]: 1,
      [loopC.id]: 1,
      [sink.id]: 2,
    };

    // The repeated id is one participant, and the cycle is one column between
    // the participant calling into it and the one it calls out to.
    expect(layersRecord(assignGraphLayers(nodes, edges))).toEqual(expected);

    const arrivals: readonly Arrival[] = [
      [[...nodes].reverse(), [...edges].reverse()],
      [rotated(nodes, 2), rotated(edges, 3)],
      [rotated([...nodes].reverse(), 4), rotated(edges, 5)],
    ];

    for (const [shuffledNodes, shuffledEdges] of arrivals) {
      expect(layersRecord(assignGraphLayers(shuffledNodes, shuffledEdges))).toEqual(expected);
    }
  });

  it('resolves the layering exactly once per payload and hands that object to the layout', async () => {
    resetScaleCalls();
    const stub = resolvingProvider(
      unplacedGraph([DATASTORE, REQUEST, INTERACTION, ROUTE, HANDLER]),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // One layering for the canonical order and the geometry together — not one
    // for each — and the layout was handed that very object rather than left
    // to resolve a second one internally.
    expect(scaleCalls.resolved).toHaveLength(1);
    expect(scaleCalls.supplied).toHaveLength(1);

    const [resolved] = scaleCalls.resolved;
    expect(resolved?.computed).toBe(true);
    expect(scaleCalls.supplied[0]).toBe(resolved);

    // And the drawing is that layering.
    expect(reading()).toEqual(
      CANONICAL_LABELS.map((label, index) => ({ label, layer: CANONICAL_LAYERS[index] })),
    );
  });
});

describe('DependencyGraph static layout', () => {
  it('ignores a wheel and a pointer drag, and offers no zoom or pan control', async () => {
    const stub = resolvingProvider(chainGraph());

    const { container } = renderComponent(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('grid');

    const picture = canvas();
    const geometryBefore = shapeGeometry();
    const viewBoxBefore = picture.getAttribute('viewBox');
    const sizeBefore = [picture.getAttribute('width'), picture.getAttribute('height')];

    // Nothing to mutate: a pan or a zoom needs a transform to accumulate into,
    // and this view declares none anywhere.
    expect(container.querySelectorAll('[transform]')).toHaveLength(0);
    expect(viewBoxBefore).not.toBeNull();

    // The two gestures an interactive graph would answer, dispatched on the
    // canvas itself. `fireEvent` rather than `userEvent` deliberately: these
    // are low-level pointer and wheel dispatches with explicit deltas, which
    // `userEvent`'s gesture vocabulary does not express, and a drag that
    // started on a participant would instead exercise hover and activation.
    fireEvent.wheel(picture, { deltaX: 40, deltaY: -240, ctrlKey: true });
    fireEvent.pointerDown(picture, { pointerId: 1, button: 0, clientX: 12, clientY: 12 });
    fireEvent.pointerMove(picture, { pointerId: 1, clientX: 180, clientY: 96 });
    fireEvent.pointerMove(picture, { pointerId: 1, clientX: 320, clientY: 40 });
    fireEvent.pointerUp(picture, { pointerId: 1, clientX: 320, clientY: 40 });
    fireEvent.mouseDown(picture, { button: 0, clientX: 12, clientY: 12 });
    fireEvent.mouseMove(picture, { clientX: 320, clientY: 40 });
    fireEvent.mouseUp(picture, { clientX: 320, clientY: 40 });

    // Byte-identical geometry: not one shape moved, the logical viewport did
    // not scale, and no transform appeared to carry a gesture (AAP 0.6.6).
    expect(shapeGeometry()).toEqual(geometryBefore);
    expect(canvas().getAttribute('viewBox')).toBe(viewBoxBefore);
    expect([canvas().getAttribute('width'), canvas().getAttribute('height')]).toEqual(sizeBefore);
    expect(container.querySelectorAll('[transform]')).toHaveLength(0);

    // And no affordance claims otherwise. The only control in the whole view is
    // the source chip of the one participant that resolved to a location.
    const controls = screen.getAllByRole('button');
    expect(controls).toHaveLength(1);
    expect(controls.map((control) => control.getAttribute('aria-label'))).toEqual([
      SOURCE_CHIP_NAME,
    ]);

    for (const gesture of [/zoom/i, /pan/i, /drag/i, /fit/i, /reset/i]) {
      expect(screen.queryByRole('button', { name: gesture })).toBeNull();
    }
    expect(screen.queryByRole('slider')).toBeNull();
  });
});

describe('DependencyGraph interactions', () => {
  it('hands the host the very location a participant resolved to, and selects nothing', async () => {
    const stub = resolvingProvider(chainGraph());
    const spies = makeActions();
    const user = userEvent.setup();

    // Taken BEFORE the render and compared afterwards: comparing the emitted
    // object's keys against the live fixture alone would be satisfied by a
    // component that added a field to it in place.
    const expectedKeys = Object.keys({ ...BASE_SOURCE }).sort();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    const chip = await screen.findByRole('button', { name: SOURCE_CHIP_NAME });

    // Rendering a chip is not activating it: nothing opens an editor until the
    // developer asks.
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    await user.click(chip);

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);

    const [call] = spies.onOpenSource.mock.calls;
    if (call === undefined) {
      throw new Error('the open-source handler recorded no call');
    }

    const received = call[0];

    // Equal, and the same key set: a dropped `symbol`, `resolvedBy` or
    // `confidence` and an invented extra field both fail here. Every hop after
    // this one acts on the object it is handed (AAP 0.4.2).
    expect(received).toEqual(BASE_SOURCE);
    expect(Object.keys(received).sort()).toEqual(expectedKeys);
    expect(received.file).toBe(SOURCE_FILE);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.line).toBe(SOURCE_LINE);
    expect(received.column).toBe(SOURCE_COLUMN);
    expect(received.symbol).toBe(SOURCE_SYMBOL);

    // Opening source is not selecting a participant: the chip's activation
    // stops at the chip, so the row it sits in is not activated as well.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
    expect(rowNamed(DATASTORE_LABEL).getAttribute('aria-selected')).toBe('false');
  });

  it('draws no source chip for a participant the capture could not resolve', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const row = rowNamed(HANDLER_LABEL);

    expect(within(row).queryByRole('button')).toBeNull();
    expect(cellOf(row, SOURCE_COLUMN_INDEX).textContent ?? '').not.toContain(SOURCE_FILE);
    expect(cellOf(row, SOURCE_COLUMN_INDEX).textContent ?? '').not.toContain('service.ts');
  });

  it('reports no selection for a participant that stands for no single event', async () => {
    const stub = resolvingProvider(chainGraph());
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    await user.click(rowNamed(HANDLER_LABEL));

    // THE HONESTY CASE. This participant declares no `eventId` — it carries a
    // span sample and nothing else — so there is no coordinate a details
    // drawer could resolve. The activation is therefore local — the row and
    // its shape both show where the reader aimed — and the host is told
    // nothing rather than being handed a span id masquerading as an event id
    // (AAP 0.8.4).
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(rowNamed(HANDLER_LABEL).getAttribute('aria-selected')).toBe('true');
    expect(shapeNamed(HANDLER_LABEL).classList.contains('dg-is-selected')).toBe(true);

    // And only that participant is selected.
    expect(rowNamed(REQUEST_LABEL).getAttribute('aria-selected')).toBe('false');
  });

  it('reports the event coordinate a single-record participant declares', async () => {
    const enriched = makeParticipant({ ...HANDLER, eventId: EVENT_ID, traceId: TRACE_ID });
    const stub = resolvingProvider(
      makeGraph({
        nodes: [INTERACTION, enriched],
        edges: [makeEdge(INTERACTION.id, HANDLER.id)],
      }),
    );
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    await user.click(rowNamed(HANDLER_LABEL));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    const ref = call[0];

    // The event id the payload carried, the trace it named, and the one span
    // this participant collapsed — because it collapsed exactly one, so the
    // sample really is that record.
    expect(ref).toEqual({ eventId: EVENT_ID, spanId: spanIdFor(2), traceId: TRACE_ID });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('reports no selection for a multi-record participant that declares an event anyway', async () => {
    // The aggregate never pairs an event id with a collapse of several records,
    // but a payload crosses only a shallow guard. Two records are not one event,
    // so the declaration is inconsistent: it is not used, and the view says so.
    const enriched = makeParticipant({
      ...DATASTORE,
      eventId: EVENT_ID,
      traceId: TRACE_ID,
      source: undefined,
    });
    const stub = resolvingProvider(makeGraph({ nodes: [enriched], edges: [], layerCount: 5 }));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    await user.click(rowNamed(DATASTORE_LABEL));

    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // The activation is still honoured locally, so the reader sees where they
    // aimed; only the host is told nothing.
    expect(rowNamed(DATASTORE_LABEL).getAttribute('aria-selected')).toBe('true');

    const note = await screen.findByText(/declared an event that does not match their records/i);
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
    expect(note.textContent).toBe(
      '1 participant(s) declared an event that does not match their records, so selecting them opens no event.',
    );
  });

  it('reports no selection for a single-record participant whose coordinate is malformed', async () => {
    // Every way a single-record coordinate can break its rules, one participant
    // each: a blank event id, an event id with no trace, a malformed trace, a
    // trace with no event, and a well-formed pair on a malformed span sample.
    const broken = [
      makeParticipant({ ...HANDLER, eventId: '   ', traceId: TRACE_ID }),
      makeParticipant({ ...REQUEST, eventId: EVENT_ID }),
      makeParticipant({ ...ROUTE, eventId: EVENT_ID, traceId: 'not-a-trace-id' }),
      makeParticipant({ ...INTERACTION, traceId: TRACE_ID }),
      makeParticipant({
        id: 'dep:external|server|example.outbound',
        kind: 'external',
        label: 'example.outbound',
        tier: 'server',
        spanIds: ['not-a-span-id'],
        layer: 4,
        eventId: EVENT_ID,
        traceId: TRACE_ID,
      }),
    ];
    const stub = resolvingProvider(makeGraph({ nodes: broken, edges: [] }));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    for (const participant of broken) {
      await user.click(rowNamed(participant.label));
    }

    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    const note = await screen.findByText(/declared an event that does not match their records/i);
    expect(note.textContent).toContain(`${String(broken.length)} participant(s)`);
  });

  it('reports nothing inconsistent for a payload whose coordinates all hold', async () => {
    const enriched = makeParticipant({ ...HANDLER, eventId: EVENT_ID, traceId: TRACE_ID });
    const stub = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, enriched], edges: [makeEdge(INTERACTION.id, HANDLER.id)] }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(screen.queryByText(/does not match their records/i)).toBeNull();
    expect(screen.queryByText(/inconsistent inferred or ambiguous counts/i)).toBeNull();
  });

  it('selects the same participant from the canvas as from the grid', async () => {
    const stub = resolvingProvider(chainGraph());
    const spies = makeActions();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    // The shapes and the rows are one array in one order, so a selection made
    // on the picture has to appear in the equivalent and nowhere else.
    fireEvent.click(shapeNamed(REQUEST_LABEL));

    expect(rowNamed(REQUEST_LABEL).getAttribute('aria-selected')).toBe('true');
    expect(shapeNamed(REQUEST_LABEL).classList.contains('dg-is-selected')).toBe(true);
    expect(rowNamed(HANDLER_LABEL).getAttribute('aria-selected')).toBe('false');
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });
});

describe('DependencyGraph legend', () => {
  it('names the six participant classes of the closed domain and nothing else', async () => {
    const stub = resolvingProvider(chainGraph());

    const { container } = renderComponent(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('grid');

    const legend = legendOf(container);
    const chips = Array.from(legend.querySelectorAll<HTMLElement>('[data-kind]'));

    // The whole closed vocabulary, in the reading order of the layout, and no
    // seventh entry: the key is generic product vocabulary describing what kind
    // of thing took part (AAP 0.5.4).
    expect(chips.map((chip) => chip.getAttribute('data-kind'))).toEqual(KINDS);
    expect(chips.map((chip) => chip.textContent)).toEqual(KIND_LABELS);

    for (const [index, chip] of chips.entries()) {
      const kind = KINDS[index];
      if (kind === undefined) {
        throw new Error(`the class vocabulary has no member at position ${String(index)}`);
      }

      // Each chip takes its colour from the shared class scale rather than from
      // a literal, so `function` and `service` resolving to one token stays a
      // decision recorded in that module.
      expect(chip.getAttribute('style') ?? '').toContain(dependencyNodeColorVar(kind));
    }

    // Nothing from the inspected application reached the key: no participant
    // label, no path, no route.
    const text = legend.textContent ?? '';
    for (const label of ALL_LABELS) {
      expect(text).not.toContain(label);
    }
    expect(text).not.toContain('/');
    expect(text).not.toContain('.');
  });
});

describe('DependencyGraph relationships', () => {
  it('marks an inferred relationship as inferred, on the chip and on the curve', async () => {
    const inferred = makeEdge(HANDLER.id, REQUEST.id, { inferredCount: 1 });
    const stub = resolvingProvider(
      makeGraph({
        nodes: [INTERACTION, HANDLER, REQUEST],
        edges: [makeEdge(INTERACTION.id, HANDLER.id), inferred],
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const [chip] = relationshipChips(rowNamed(HANDLER_LABEL));
    if (chip === undefined) {
      throw new Error('the participant rendered no relationship chip');
    }

    // The distinction survives in text as well as in the dash pattern: a
    // guessed relationship must never read as a measured one (AAP 0.4.2,
    // 0.6.4).
    expect(chip.getAttribute('data-edge-id')).toBe(inferred.id);
    expect(chip.classList.contains('dg-is-ambiguous')).toBe(true);
    expect(chip.textContent).toBe(`→ ${REQUEST_LABEL} (inferred)`);

    // The measured relationship beside it is not marked, in either
    // representation.
    const [measured] = relationshipChips(rowNamed(INTERACTION_LABEL));
    if (measured === undefined) {
      throw new Error('the page event rendered no relationship chip');
    }

    expect(measured.classList.contains('dg-is-ambiguous')).toBe(false);
    expect(measured.textContent).not.toContain('inferred');
    expect(
      edgeCurves().filter((curve) => curve.classList.contains('dg-is-ambiguous')),
    ).toHaveLength(1);
  });

  it('states the inferred share and the ambiguous part of a relationship in text', async () => {
    // Three records: two joined through an attribution, one of those two chosen
    // among several open candidates — and an all-inferred, ambiguous one beside
    // it, so both suffix shapes are read off one render.
    const partial = makeEdge(HANDLER.id, REQUEST.id, {
      count: 3,
      inferredCount: 2,
      ambiguousCount: 1,
    });
    const whole = makeEdge(INTERACTION.id, HANDLER.id, { inferredCount: 1, ambiguousCount: 1 });
    const stub = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, HANDLER, REQUEST], edges: [whole, partial] }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const [partialChip] = relationshipChips(rowNamed(HANDLER_LABEL));
    const [wholeChip] = relationshipChips(rowNamed(INTERACTION_LABEL));
    if (partialChip === undefined || wholeChip === undefined) {
      throw new Error('a participant rendered no relationship chip');
    }

    // A mostly measured edge is not called "inferred" outright: its share is.
    expect(partialChip.textContent).toBe(`→ ${REQUEST_LABEL} ×3 (2 of 3 inferred, 1 ambiguous)`);
    expect(wholeChip.textContent).toBe(`→ ${HANDLER_LABEL} (inferred, 1 ambiguous)`);

    // Any inferred record marks the relationship, in the grid and on the canvas.
    expect(partialChip.classList.contains('dg-is-ambiguous')).toBe(true);
    expect(wholeChip.classList.contains('dg-is-ambiguous')).toBe(true);
    expect(
      edgeCurves().filter((curve) => curve.classList.contains('dg-is-ambiguous')),
    ).toHaveLength(2);
  });

  it('uses no lineage whose shares do not nest inside the relationship, and says so', async () => {
    // The protocol's guard on a graph result is shallow, so the shares are
    // validated rather than trusted or repaired: each of these breaks
    // `0 ≤ ambiguousCount ≤ inferredCount ≤ count` one way, and none may be
    // capped into a claim — "inferred", "ambiguous" — the capture never made.
    const overstated = makeEdge(INTERACTION.id, HANDLER.id, { inferredCount: 5 });
    const overAmbiguous = makeEdge(HANDLER.id, REQUEST.id, {
      count: 3,
      inferredCount: 1,
      ambiguousCount: 2,
    });
    const negative = makeEdge(REQUEST.id, ROUTE.id, { inferredCount: -1 });
    const fractional = makeEdge(ROUTE.id, DATASTORE.id, { count: 2, inferredCount: 0.5 });
    const stub = resolvingProvider(
      makeGraph({
        nodes: [INTERACTION, HANDLER, REQUEST, ROUTE, DATASTORE],
        edges: [overstated, overAmbiguous, negative, fractional],
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const expected: readonly (readonly [string, string])[] = [
      [INTERACTION_LABEL, `→ ${HANDLER_LABEL}`],
      [HANDLER_LABEL, `→ ${REQUEST_LABEL} ×3`],
      [REQUEST_LABEL, `→ ${ROUTE_LABEL}`],
      [ROUTE_LABEL, `→ ${DATASTORE_LABEL} ×2`],
    ];

    for (const [label, text] of expected) {
      const [chip] = relationshipChips(rowNamed(label));
      if (chip === undefined) {
        throw new Error(`the participant "${label}" rendered no relationship chip`);
      }
      expect(chip.textContent).toBe(text);
      expect(chip.classList.contains('dg-is-ambiguous')).toBe(false);
    }

    expect(
      edgeCurves().filter((curve) => curve.classList.contains('dg-is-ambiguous')),
    ).toHaveLength(0);

    // Dropped, but never silently: the count of inconsistent declarations is
    // stated under the grid.
    const note = await screen.findByText(/inconsistent inferred or ambiguous counts/i);
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
    expect(note.textContent).toBe(
      '4 relationship(s) declared inconsistent inferred or ambiguous counts, which are not shown.',
    );
  });

  it('accepts a zero share as the share the aggregate omits', async () => {
    // `0` is inside the nesting rule, so an explicit zero reads exactly as an
    // omitted key: a measured relationship, and nothing reported as broken.
    const explicitZero = makeEdge(INTERACTION.id, HANDLER.id, {
      inferredCount: 0,
      ambiguousCount: 0,
    });
    const stub = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, HANDLER], edges: [explicitZero] }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const [chip] = relationshipChips(rowNamed(INTERACTION_LABEL));
    expect(chip?.textContent).toBe(`→ ${HANDLER_LABEL}`);
    expect(chip?.classList.contains('dg-is-ambiguous')).toBe(false);
    expect(screen.queryByText(/inconsistent inferred or ambiguous counts/i)).toBeNull();
  });

  it('says how often a repeated relationship ran, in the grid and on the canvas', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // The one repeated handover of the chain: two records of the datastore hung
    // from the server work.
    const [repeated] = relationshipChips(rowNamed(ROUTE_LABEL));
    if (repeated === undefined) {
      throw new Error('the server participant rendered no relationship chip');
    }

    expect(repeated.textContent).toContain('×2');

    expect(
      Array.from(canvas().querySelectorAll('text.dg-dependency-graph__edge-label')).map(
        (label) => label.textContent,
      ),
    ).toEqual(['×2']);

    // A relationship that ran once carries no count, so a reader never has to
    // read "×1" to learn nothing.
    const [single] = relationshipChips(rowNamed(INTERACTION_LABEL));
    if (single === undefined) {
      throw new Error('the page event rendered no relationship chip');
    }

    expect(single.textContent).toContain(HANDLER_LABEL);
    expect(single.textContent).not.toContain('×');
  });

  it('counts a relationship naming a participant it does not contain, instead of drawing it', async () => {
    const stub = resolvingProvider(
      makeGraph({
        nodes: [INTERACTION, HANDLER],
        edges: [
          makeEdge(INTERACTION.id, HANDLER.id),
          makeEdge(HANDLER.id, 'dep:database|db|example.unlisted'),
        ],
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // An edge to nothing has no second anchor, so it cannot be drawn — and it
    // is counted rather than silently dropped, because the count is the
    // difference between "these participants do not interact" and "part of this
    // graph is missing".
    const note = await screen.findByText(/named a participant this graph does not contain/i);
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
    expect(note.textContent).toContain('1');

    expect(edgeCurves()).toHaveLength(1);
    expect(relationshipChips(rowNamed(HANDLER_LABEL))).toHaveLength(0);
    expect(screen.queryByText(/unlisted/i)).toBeNull();
  });
});

describe('DependencyGraph aggregate contract', () => {
  /** Monotonic ordinal behind the captured events' ids, span ids, times and sequences. */
  let ordinal = 100;

  /**
   * One persisted, already-redacted event, shaped as the store hands it to the
   * aggregate: construction order is canonical order, because start time and
   * both sequences follow it.
   *
   * @param over The fields that make the event what the case needs.
   * @returns A fresh event.
   */
  function capturedEvent(
    over: Pick<TelemetryEvent, 'kind' | 'name'> & Partial<TelemetryEvent>,
  ): TelemetryEvent {
    ordinal += 1;
    return {
      id: `event-example-${String(ordinal)}`,
      traceId: TRACE_ID,
      spanId: spanIdFor(ordinal),
      startTime: 1_700_000_000_000 + ordinal,
      duration: 5,
      tier: 'browser',
      attributes: {},
      status: 'ok',
      producerId: 'producer-example',
      seq: ordinal,
      sessionId: 'session-example',
      captureId: 'capture-example',
      ingestSeq: ordinal,
      ...over,
    };
  }

  it('selects, withholds and marks exactly what the real aggregate produced', async () => {
    // A page event that issued one request and reached one function twice; a
    // view update attributed to the settled request through an asynchronous
    // continuation (AAP 0.4.2) rather than nested inside it.
    const press = capturedEvent({ kind: 'interaction', name: 'example.press' });
    const request = capturedEvent({
      kind: 'fetch',
      name: 'GET /example/resource',
      parentSpanId: press.spanId,
    });
    const firstWork = capturedEvent({
      kind: 'function',
      name: 'example.work',
      parentSpanId: press.spanId,
    });
    const secondWork = capturedEvent({
      kind: 'function',
      name: 'example.work',
      parentSpanId: press.spanId,
    });
    const update = capturedEvent({
      kind: 'render',
      name: 'example.view',
      parentSpanId: request.spanId,
      attributes: { lineage: 'async-continuation' },
    });

    // The real aggregate, not a hand-built payload: whatever this component
    // reads must be something `buildDependencyGraph` actually writes.
    const graph = buildDependencyGraph([press, request, firstWork, secondWork, update]);
    const stub = resolvingProvider(graph);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    // The participant that collapsed two records stands for no single event:
    // activating it selects it locally and reports nothing to the host.
    await user.click(rowNamed('example.work'));

    expect(rowNamed('example.work').getAttribute('aria-selected')).toBe('true');
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // The single-record participant reports the coordinate of its one event:
    // the aggregate's `eventId` and `traceId`, and its one span as the hint.
    await user.click(rowNamed('GET /example/resource'));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }
    expect(call[0]).toEqual({
      eventId: request.id,
      spanId: request.spanId,
      traceId: request.traceId,
    });

    // The continuation-attributed relationship is chipped inferred and its
    // curve dashed; the nested ones beside it are neither.
    const [inferredChip] = relationshipChips(rowNamed('GET /example/resource'));
    if (inferredChip === undefined) {
      throw new Error('the request participant rendered no relationship chip');
    }
    expect(inferredChip.textContent).toBe('→ example.view (inferred)');
    expect(inferredChip.classList.contains('dg-is-ambiguous')).toBe(true);

    for (const chip of relationshipChips(rowNamed('example.press'))) {
      expect(chip.classList.contains('dg-is-ambiguous')).toBe(false);
      expect(chip.textContent).not.toContain('inferred');
    }

    const dashed = edgeCurves().filter((curve) => curve.classList.contains('dg-is-ambiguous'));
    expect(dashed).toHaveLength(1);
    expect(edgeCurves()).toHaveLength(graph.edges.length);

    // Everything the real aggregate declared passes the component's validation:
    // nothing is reported as inconsistent.
    expect(screen.queryByText(/does not match their records/i)).toBeNull();
    expect(screen.queryByText(/inconsistent inferred or ambiguous counts/i)).toBeNull();
  });
});
