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
 *   - **Nothing interactive is implied that does not exist.** `static layout`
 *     dispatches a wheel and a pointer drag over the canvas and asserts every
 *     positional attribute is byte-identical afterwards, that no element
 *     carries a `transform` for a gesture to mutate, and that the only controls
 *     in the whole view are source chips — so the recorded gap stays a recorded
 *     gap instead of a control that looks draggable and is not. The note that
 *     states the limitation on screen is asserted alongside it.
 *   - **No selection is ever fabricated.** A participant is a *collapse* of
 *     many records, so the aggregate gives it span ids and no event id.
 *     `interactions` asserts that activating such a participant highlights it
 *     locally and reports **nothing** to the host, while a participant that
 *     really carries an event coordinate reports exactly that coordinate. A
 *     control claiming to select an event that does not exist would be an
 *     unevidenced claim of precisely the kind AAP 0.8.4 rules out.
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
 *     overrides; nothing here is read from disk, shared with another suite or
 *     produced by `buildDependencyGraph` — this suite tests the renderer, so
 *     its payloads are hand-constructed and include shapes the aggregate would
 *     never emit (a participant with no `layer`, a cycle) because those are the
 *     defensive paths the component declares.
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
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…`; `userEvent` drives pointer
 *     activation, and `fireEvent` the two low-level gestures (a wheel and a key
 *     press) `userEvent` has no vocabulary for.
 *   - **Aliased types, deliberately.** `DependencyGraphNode` names two
 *     different things in this monorepo: the panel-schema *specification* node
 *     (imported here as `DependencyGraphNodeSpec`, exactly as the component
 *     aliases it) and the telemetry *datum* for one participant (imported
 *     unaliased alongside `DependencyGraphData` and `DependencyGraphEdge`).
 *     Both arrive as types only.
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
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
} from '@debuggen/telemetry';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import { dependencyNodeColorVar } from '../utils/color';
import {
  DEFAULT_GRAPH_COLUMN_GAP,
  DEFAULT_GRAPH_NODE_HEIGHT,
  DEFAULT_GRAPH_NODE_WIDTH,
  DEFAULT_GRAPH_ROW_GAP,
} from '../utils/scale';
import { DependencyGraph } from './DependencyGraph';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Application-neutral throughout (AAP 0.5.4), and shaped as the capture shapes
 * it: a 32-hex trace id, 16-hex span ids, millisecond durations, a
 * project-relative POSIX source path.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace the enriched participant belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** The event id an enriched participant carries; see {@link makeParticipant}. */
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
 * A participant, plus the two optional coordinates an **enriched** payload may
 * carry.
 *
 * `eventId` and `traceId` are absent from the aggregate's declared shape: they
 * are the enrichment seam the datum's `source` field documents, which the
 * coordination service fills for a participant whose producer recorded a
 * resolvable event. The component reads them defensively and reports a
 * selection only when one is present, so this suite needs a type that can carry
 * them without a cast.
 */
interface EnrichedParticipant extends DependencyGraphNode {
  /** The event this participant stands for, when it stands for exactly one. */
  readonly eventId?: string | undefined;

  /** The trace that event belongs to. */
  readonly traceId?: string | undefined;
}

/**
 * Overrides accepted by {@link makeParticipant}.
 *
 * The optional fields admit `undefined` explicitly, which `Partial` does not
 * under this repository's `exactOptionalPropertyTypes`: passing
 * `{ layer: undefined }` is how a case asks for a participant the payload never
 * placed — the defensive path where the component recomputes every column from
 * the relationships — and the builder drops the key rather than storing the
 * value.
 */
type ParticipantOverrides = Partial<
  Pick<DependencyGraphNode, 'id' | 'kind' | 'label' | 'spanIds' | 'count' | 'totalDurationMs'>
> & {
  readonly tier?: DependencyGraphNode['tier'] | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly source?: SourceLocation | undefined;
  readonly layer?: number | undefined;
  readonly eventId?: string | undefined;
  readonly traceId?: string | undefined;
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
function makeParticipant(overrides: ParticipantOverrides = {}): EnrichedParticipant {
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
 * A relationship, plus the lineage flags an **inferred** one carries.
 *
 * `lineage` is the field an asynchronous continuation is attributed with
 * (AAP 0.4.2) and `ambiguous` the flag a correlation that could not be resolved
 * to one candidate carries. Neither is part of the aggregate's declared edge
 * shape and neither is derived by the component — they are read, so that a
 * guessed relationship can never read as a measured one.
 */
interface LineageEdge extends DependencyGraphEdge {
  /** Set when the correlation had more than one candidate. */
  readonly ambiguous?: boolean | undefined;

  /** The lineage an asynchronous continuation is attributed with. */
  readonly lineage?: string | undefined;
}

/** Overrides accepted by {@link makeEdge}, with the same `undefined` policy. */
type EdgeOverrides = {
  readonly id?: string | undefined;
  readonly count?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly ambiguous?: boolean | undefined;
  readonly lineage?: string | undefined;
};

/**
 * One caller-to-callee relationship.
 *
 * @param from The calling participant's id.
 * @param to The called participant's id.
 * @param overrides Fields to replace.
 * @returns A fresh relationship.
 */
function makeEdge(from: string, to: string, overrides: EdgeOverrides = {}): LineageEdge {
  const {
    id = `edge:${from}=>${to}`,
    count = 1,
    totalDurationMs = 12,
    ambiguous,
    lineage,
  } = overrides;

  return {
    id,
    from,
    to,
    count,
    totalDurationMs,
    ...(ambiguous === undefined ? {} : { ambiguous }),
    ...(lineage === undefined ? {} : { lineage }),
  };
}

/** Overrides accepted by {@link makeGraph}. */
interface GraphOverrides {
  /** The participants, in the order the provider hands them over. */
  readonly nodes?: readonly EnrichedParticipant[] | undefined;

  /** The relationships, in the order the provider hands them over. */
  readonly edges?: readonly LineageEdge[] | undefined;

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
 *     the last handover to the first, which is the input a longest-path
 *     layering has to iterate to resolve.
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
const CHAIN_PARTICIPANTS: readonly EnrichedParticipant[] = [
  ROUTE,
  DATASTORE,
  INTERACTION,
  REQUEST,
  HANDLER,
];

/** The four handovers, from the last to the first. */
const CHAIN_RELATIONSHIPS: readonly LineageEdge[] = [
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
function unplacedGraph(nodes: readonly EnrichedParticipant[]): DependencyGraphData {
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
function tieGraph(nodes: readonly EnrichedParticipant[]): DependencyGraphData {
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
      <PanelActionsContext.Provider value={context.actions}>
        <DependencyGraph node={node} />
      </PanelActionsContext.Provider>
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
 * The participant label of a row.
 *
 * Read off the row header's tooltip trigger rather than the header's whole text
 * content: the cell also carries the tooltip's description — the label again,
 * with the participant's class, tier and metrics — which a bare `textContent`
 * would concatenate.
 *
 * @param row A row obtained by role.
 * @returns The label that row stands for.
 */
function participantLabelOf(row: HTMLElement): string {
  const header = within(row).getByRole('rowheader');
  const trigger = header.querySelector<HTMLElement>('.dg-tooltip__trigger');

  if (trigger === null) {
    throw new Error('the participant cell rendered no label');
  }

  return trigger.textContent ?? '';
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
    // is the input a longest-path layering has to iterate rather than read.
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
    // no relaxation can order one: the layering is capped, and this case is the
    // proof that the cap is what runs rather than the clock.
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

    // The relaxation could not separate them, so they share a column and are
    // stacked in it — a legible answer rather than an invented ordering.
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

    // THE HONESTY CASE. A participant of this graph is a collapse of many
    // records: the aggregate gives it a bounded span sample and no event id, so
    // there is no coordinate a details drawer could resolve. The activation is
    // therefore local — the row and its shape both show where the reader aimed
    // — and the host is told nothing rather than being handed a span id
    // masquerading as an event id (AAP 0.8.4).
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(rowNamed(HANDLER_LABEL).getAttribute('aria-selected')).toBe('true');
    expect(shapeNamed(HANDLER_LABEL).classList.contains('dg-is-selected')).toBe(true);

    // And only that participant is selected.
    expect(rowNamed(REQUEST_LABEL).getAttribute('aria-selected')).toBe('false');
  });

  it('reports the event coordinate an enriched participant carries', async () => {
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

  it('offers no span id as a span hint for a participant that collapsed several records', async () => {
    const enriched = makeParticipant({ ...DATASTORE, eventId: EVENT_ID, source: undefined });
    const stub = resolvingProvider(makeGraph({ nodes: [enriched], edges: [], layerCount: 5 }));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    await user.click(rowNamed(DATASTORE_LABEL));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    // Two records collapsed into this participant, so no single span stands for
    // it and the sample is not passed off as one: the event coordinate travels
    // alone.
    expect(call[0]).toEqual({ eventId: EVENT_ID });
    expect(Object.keys(call[0])).toEqual(['eventId']);
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
    const inferred = makeEdge(HANDLER.id, REQUEST.id, { lineage: 'async-continuation' });
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
    expect(chip.textContent).toContain('inferred');
    expect(chip.textContent).toContain(REQUEST_LABEL);

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
