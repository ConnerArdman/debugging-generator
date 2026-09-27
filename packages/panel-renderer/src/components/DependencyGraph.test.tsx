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
 *   - **The layout is reproducible.** Interactive graph layout (drag, zoom) is
 *     a recorded gap of this version — the graph is a layered static layout
 *     with hover and click — so the geometry is arithmetic over a column index
 *     and a row index and nothing else. `determinism` renders one payload
 *     twice and then renders it with its participants **shuffled**,
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
 *     be an unevidenced claim, and what the view presents as observed must
 *     exist in the capture.
 *
 * Alongside those, this suite covers what every component suite in this folder
 * is held to — the three states of a query-backed view (loading, empty and
 * error) and the click-to-source payload — and the graph's second
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
 *   - **Generic fixture vocabulary only.** Participant classes come from the
 *     closed telemetry domain, and every label, path and symbol belongs to no
 *     application, demonstration or otherwise:
 *     `example.interaction`, `example.handler`, `/example/resource`,
 *     `example.route`, `example.datastore`, `src/example/service.ts`.
 *     `scripts/check-no-hardcoding.mjs` skips test files, so this suite keeps
 *     the product's neutral vocabulary by convention.
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
 *   - **Layout-free throughout, with no layout stubbed.** happy-dom has no
 *     layout, and the component needs none: it measures nothing, so its
 *     geometry is a pure function of the payload and every positional case
 *     asserts the scale module's rhythm directly. No element size, observer or
 *     font metric is stood in for anywhere in this file. The `deterministic
 *     geometry` cases prove the point: the canvas declares the layout's own
 *     logical size, the column gap widens only as far as a count label drawn
 *     in it requires — by the same pure estimate the component uses — and one
 *     payload draws identically across renders, mounts and orders of arrival.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…`; `userEvent` drives pointer
 *     activation, and `fireEvent` the two low-level gestures (a wheel and a key
 *     press) `userEvent` has no vocabulary for.
 *   - **Aliased types, deliberately.** `DependencyGraphNode` names two
 *     different things in this monorepo: the panel-schema *specification* node
 *     (imported here as `DependencyGraphNodeSpec`, exactly as the component
 *     aliases it) and the telemetry *datum* for one participant (imported
 *     unaliased alongside `DependencyGraphData` and `DependencyGraphEdge`).
 *     Both arrive as types only. The runtime imports from `@debuggen/telemetry`
 *     are the aggregate itself and the vocabularies it is built over
 *     (`TELEMETRY_KINDS`, `KIND_ALLOWED_TIERS`, `DEPENDENCY_NODE_ROLES`,
 *     `DEPENDENCY_RENDER_REASONS`), for the contract cases: the component may
 *     read none of them at runtime, so the suite is what proves its own
 *     tables agree with them.
 *
 * @see ./DependencyGraph for the component, its four states and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 * @see ../utils/scale for the layered geometry the positional assertions derive from.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DataQuery,
  DependencyGraphNode as DependencyGraphNodeSpec,
  FlameNode,
} from '@debuggen/panel-schema';
import { catalogEntryFor } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import {
  DEPENDENCY_NODE_ROLES,
  DEPENDENCY_RENDER_REASONS,
  KIND_ALLOWED_TIERS,
  TELEMETRY_KINDS,
  buildDependencyGraph,
  correlateTrace,
} from '@debuggen/telemetry';
import type {
  DependencyGraphData,
  DependencyGraphEdge,
  DependencyGraphNode,
  TelemetryEvent,
} from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext, PanelSelectionContext } from '../host/PanelActions';
import type {
  PanelActions,
  PanelEventRef,
  PanelSelection,
  PanelSelectionState,
} from '../host/PanelActions';
import { DATA_TABLE_COLUMN_TRACKS } from '../primitives/DataTable';
import type { DataTableColumnWidth } from '../primitives/DataTable';
import { dependencyNodeColorVar } from '../utils/color';
import {
  DEFAULT_LABEL_FONT_SIZE,
  estimateTextWidth,
  formatCount,
  formatDurationCompact,
  formatTierLabel,
} from '../utils/format';
import {
  DEFAULT_GRAPH_COLUMN_GAP,
  DEFAULT_GRAPH_NODE_HEIGHT,
  DEFAULT_GRAPH_NODE_WIDTH,
  DEFAULT_GRAPH_ROW_GAP,
  assignGraphLayers,
  layoutDependencyGraph,
  resolveGraphLayering,
} from '../utils/scale';
import type { GraphLayering, GraphRowPlan } from '../utils/scale';
import type * as ScaleModule from '../utils/scale';
import { DependencyGraph } from './DependencyGraph';
import { FlameChart } from './FlameChart';

/*
 * ---------------------------------------------------------------------------
 * The layering call record
 *
 * `../utils/scale` is mocked with its own implementation: every export behaves
 * exactly as shipped, and the layering, row-planning and layout entry points
 * additionally record what they were called with, so the layering-once case
 * can prove the component resolves one layering and plans one set of rows per
 * payload, and hands those very objects to the layout.
 * ---------------------------------------------------------------------------
 */

/** What the component asked of the scale module's graph entry points since the last reset. */
interface ScaleCallRecord {
  /** Every layering `resolveGraphLayering` returned, in call order. */
  readonly resolved: GraphLayering[];

  /** The `layering` argument of every `layoutDependencyGraph` call, in call order. */
  readonly supplied: (GraphLayering | undefined)[];

  /** The `layering` argument of every `planGraphRows` call, in call order. */
  readonly planned: (GraphLayering | undefined)[];

  /** Every plan `planGraphRows` returned, in call order. */
  readonly plans: GraphRowPlan[];

  /** The `plan` argument of every `layoutDependencyGraph` call, in call order. */
  readonly suppliedPlans: (GraphRowPlan | undefined)[];
}

/**
 * The record itself.
 *
 * Hoisted, because Vitest lifts the `vi.mock` factory above the imports and the
 * factory closes over it. Plain arrays rather than `vi.fn` history: `afterEach`
 * restores every mock, and this record must not depend on what that does to a
 * spy.
 */
const scaleCalls = vi.hoisted<ScaleCallRecord>(() => ({
  resolved: [],
  supplied: [],
  planned: [],
  plans: [],
  suppliedPlans: [],
}));

vi.mock('../utils/scale', async (importOriginal) => {
  const actual = await importOriginal<typeof ScaleModule>();

  const resolveGraphLayering: typeof actual.resolveGraphLayering = (nodes, edges) => {
    const layering = actual.resolveGraphLayering(nodes, edges);
    scaleCalls.resolved.push(layering);
    return layering;
  };

  const planGraphRows: typeof actual.planGraphRows = (data, options, layering) => {
    scaleCalls.planned.push(layering);
    const plan = actual.planGraphRows(data, options, layering);
    scaleCalls.plans.push(plan);
    return plan;
  };

  const layoutDependencyGraph: typeof actual.layoutDependencyGraph = (
    data,
    options,
    layering,
    plan,
  ) => {
    scaleCalls.supplied.push(layering);
    scaleCalls.suppliedPlans.push(plan);
    return actual.layoutDependencyGraph(data, options, layering, plan);
  };

  return { ...actual, resolveGraphLayering, planGraphRows, layoutDependencyGraph };
});

/** Empties {@link scaleCalls}, so a case reads only the calls its own render made. */
function resetScaleCalls(): void {
  scaleCalls.resolved.length = 0;
  scaleCalls.supplied.length = 0;
  scaleCalls.planned.length = 0;
  scaleCalls.plans.length = 0;
  scaleCalls.suppliedPlans.length = 0;
}

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Application-neutral throughout, and shaped as the capture shapes it: a 32-hex
 * trace id, 16-hex span ids, millisecond durations, a project-relative POSIX
 * source path.
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

/*
 * The shared error-state contract, spelled out rather than read back from
 * `../host/useQuery`, so this suite pins the words a reader sees on this node
 * instead of restating whatever the contract currently holds.
 */

/** The first line of a node whose own data could not be loaded. */
const VIEW_FAILURE_TITLE = 'Could not load this view';

/** The generic lead every failed view's message opens with. */
const VIEW_FAILURE_LEAD = 'The data for this view could not be loaded.';

/** The first line of a node whose query names a source it cannot draw. */
const UNSUPPORTED_TITLE = 'This view cannot draw the requested data';

/** The attribute and value the retry control carries so focus can follow it. */
const RETRY_FOCUS_ATTRIBUTE = 'data-dg-focus-key';
const RETRY_FOCUS_KEY = 'error-state-retry';

/**
 * The parts of a rendered error state, read through the class contract
 * `primitives/ErrorState` declares.
 *
 * @param alert The error state's live-region container.
 * @returns Its title, its message paragraphs (message, then hint) and its code chip.
 */
function errorStateParts(alert: HTMLElement): {
  readonly title: string | undefined;
  readonly paragraphs: readonly string[];
  readonly code: string | undefined;
} {
  return {
    title: alert.querySelector('.dg-error-state__title')?.textContent ?? undefined,
    paragraphs: Array.from(alert.querySelectorAll('.dg-error-state__message')).map(
      (paragraph) => paragraph.textContent ?? '',
    ),
    code: alert.querySelector(':scope > .dg-badge')?.textContent ?? undefined,
  };
}

/** The badge a bounded graph carries, as every chart marks a partial result. */
const PARTIAL_RESULT_BADGE = 'Partial result';

/**
 * The note for participants whose declared event contradicts their records, in
 * either agreement: "its records" for one participant, "their records" for
 * several. The cases that pin a count pin the whole sentence.
 */
const INCONSISTENT_COORDINATES_NOTE =
  /declared an event that does not match (?:its|their) records/i;

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
  readonly roles?: DependencyGraphNode['roles'] | undefined;
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
    roles,
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
    ...(roles === undefined ? {} : { roles }),
  };
}

/**
 * Overrides accepted by {@link makeEdge}, with the same `undefined` policy.
 *
 * `inferredCount` and `ambiguousCount` are the authoritative edge's own
 * optional lineage counts: how many of its records joined their caller through
 * an asynchronous-continuation attribution rather than by nesting, and how many
 * of those attributions were ambiguous. The component reads them and derives
 * neither, so a guessed relationship can never read as a measured one.
 */
type EdgeOverrides = {
  readonly id?: string | undefined;
  readonly count?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly inferredCount?: DependencyGraphEdge['inferredCount'] | undefined;
  readonly ambiguousCount?: DependencyGraphEdge['ambiguousCount'] | undefined;
  readonly renderTriggers?: DependencyGraphEdge['renderTriggers'] | undefined;
  readonly contexts?: DependencyGraphEdge['contexts'] | undefined;
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
    renderTriggers,
    contexts,
  } = overrides;

  return {
    id,
    from,
    to,
    count,
    totalDurationMs,
    ...(inferredCount === undefined ? {} : { inferredCount }),
    ...(ambiguousCount === undefined ? {} : { ambiguousCount }),
    ...(renderTriggers === undefined ? {} : { renderTriggers }),
    ...(contexts === undefined ? {} : { contexts }),
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
 * renders.
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
 * cell also carries the participant's detail on a second line, which a bare
 * `textContent` would concatenate onto the label.
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

/**
 * The pointer title of a participant's shape: the SVG `<title>` of the group
 * the shape is drawn in, which is also the element a click on the shape
 * reaches.
 *
 * @param shape A shape obtained through {@link shapeNamed}.
 * @returns The title's text.
 */
function titleOfShape(shape: Element): string {
  const title = shape.parentElement?.querySelector(':scope > title');

  if (title === null || title === undefined) {
    throw new Error('the shape is drawn without a title');
  }

  return title.textContent ?? '';
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

/*
 * ---------------------------------------------------------------------------
 * Canvas geometry, read off the drawing
 *
 * Every reader below takes the numbers the component wrote into the SVG's own
 * attributes. None asks the DOM for a laid-out size — happy-dom has no layout
 * to report — and none needs to: the component declares its whole geometry.
 * ---------------------------------------------------------------------------
 */

/** The canvas's declared size, and its `viewBox` as four numbers. */
function canvasFrame(): { width: number; height: number; viewBox: number[] } {
  const picture = canvas();
  return {
    width: Number(picture.getAttribute('width')),
    height: Number(picture.getAttribute('height')),
    viewBox: (picture.getAttribute('viewBox') ?? '').split(' ').map(Number),
  };
}

/** The left edge of every participant shape, in document order. */
function shapeLefts(): number[] {
  return nodeShapes().map((shape) => Number(shape.getAttribute('x')));
}

/** The repeated-relationship count labels of the canvas, in document order. */
function edgeCountLabels(): Element[] {
  return Array.from(canvas().querySelectorAll('text.dg-dependency-graph__edge-label'));
}

/** Every positional fact of one drawing, as {@link drawnGeometry} returns it. */
interface DrawnGeometry {
  /** The canvas's declared size and `viewBox`. */
  readonly frame: ReturnType<typeof canvasFrame>;
  /** Every participant shape's rectangle, in document order. */
  readonly shapes: (string | null)[][];
  /** The labels drawn in those shapes, in the same order. */
  readonly labels: string[];
  /** Every relationship curve's path data, sorted. */
  readonly curves: string[];
  /** Every count label as `text@x,y`, sorted. */
  readonly counts: string[];
}

/**
 * The whole drawing's geometry, read off its attributes.
 *
 * Shapes and their labels are compared in document order, which the component
 * fixes by column and canonical order. Curves and count labels are drawn in
 * the order the relationships arrived, so they are compared as sorted sets:
 * the question is whether any of them moved, not which the payload listed
 * first.
 *
 * @returns The snapshot.
 */
function drawnGeometry(): DrawnGeometry {
  return {
    frame: canvasFrame(),
    shapes: shapeGeometry(),
    labels: canvasLabels(),
    curves: edgeCurves()
      .map((curve) => curve.getAttribute('d') ?? '')
      .toSorted(),
    counts: edgeCountLabels()
      .map(
        (label) =>
          `${label.textContent ?? ''}@${label.getAttribute('x') ?? ''},${label.getAttribute('y') ?? ''}`,
      )
      .toSorted(),
  };
}

/**
 * Asserts, for a graph whose relationships all run from one column to the
 * next, that every curve leaves a box's right outline and meets the next
 * column's left outline with no box between the two — horizontal control
 * points keep a cubic within its anchors' x, so no curve crosses a box.
 */
function expectCurvesBetweenColumns(): void {
  const lefts = shapeLefts();
  for (const curve of edgeCurves()) {
    const numbers = (curve.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const [startX, , , , , , endX] = numbers;
    if (startX === undefined || endX === undefined) {
      throw new Error(`a curve carries no path: ${curve.getAttribute('d') ?? ''}`);
    }
    expect(lefts.map((left) => left + DEFAULT_GRAPH_NODE_WIDTH)).toContain(startX);
    expect(lefts).toContain(endX);
    for (const left of lefts) {
      const right = left + DEFAULT_GRAPH_NODE_WIDTH;
      expect(right <= startX || left >= endX).toBe(true);
    }
  }
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
    // an unsettled query is not an answer.
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
    // to be exactly that: product vocabulary, naming no inspected project.
    const message = await screen.findByText(/no dependency relationships were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-dependency-graph__empty')).not.toBeNull();

    for (const label of ALL_LABELS) {
      expect(message.textContent).not.toContain(label);
    }

    // Announced as the settled status, with a short title and a decorative
    // glyph above the sentence, like every other view's empty capture.
    const state = screen.getByRole('status');
    expect(state.contains(message)).toBe(true);
    expect(state.querySelector('.dg-empty-state__title')?.textContent).toBe('No relationships');
    expect(state.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');

    // An empty graph is a success, so it is drawn as an absence rather than as
    // a failure, and there is no picture and no grid to hold participants.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
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

    // The provider's own message, hint and code reach the reader after the
    // shared lead, rather than being replaced by a generic sentence.
    expect(alert.textContent).toContain(VIEW_FAILURE_LEAD);
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

  it('draws a rejected query through the shared error-state contract', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.', {
        hint: 'Reconnect the panel and ask again.',
      }),
    );

    renderComponent(makeNode({ query: { source: 'graph', filter: { traceId: TRACE_ID } } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    // A lone failure alerts: nothing else on screen failed with it.
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-error-state')).toBe(true);

    // Title, then the generic lead followed by the provider's own cause — with
    // the hint on a line of its own rather than appended to the message — then
    // the code chip.
    const parts = errorStateParts(alert);
    expect(parts.title).toBe(VIEW_FAILURE_TITLE);
    expect(parts.paragraphs).toEqual([
      `${VIEW_FAILURE_LEAD} The channel to the service is closed.`,
      'Reconnect the panel and ask again.',
    ]);
    expect(parts.code).toBe('TRANSPORT_DISCONNECTED');

    // The query block, found by its name — the error state's `<details>` is an
    // unnamed group too — parses back to exactly the query that was asked.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual(soleQuery(stub));

    // The retry carries the key the node frame restores focus by.
    const retryControl = within(alert).getByRole('button', { name: RETRY_NAME });
    expect(retryControl.getAttribute(RETRY_FOCUS_ATTRIBUTE)).toBe(RETRY_FOCUS_KEY);

    // One glyph for every failure: the primitive's own, decorative.
    expect(alert.querySelector('.dg-error-state__icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws a source it cannot read through the shared unsupported-query contract', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode({ query: { source: 'spans', sort: 'duration_desc' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-dependency-graph__error')).not.toBeNull();

    // The contract's title and code, and a message worded from the node
    // catalog: what this view reads next to what it was asked for.
    const parts = errorStateParts(alert);
    expect(parts.title).toBe(UNSUPPORTED_TITLE);
    expect(parts.paragraphs).toEqual([
      `The ${catalogEntryFor('dependencyGraph').label} view reads "graph" data, but this panel asks it for "spans".`,
    ]);
    expect(parts.code).toBe('PANEL_INVALID');

    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'spans', sort: 'duration_desc' });

    // A defect in the panel, not a failed request: nothing to retry.
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();
    expect(alert.querySelector(`[${RETRY_FOCUS_ATTRIBUTE}]`)).toBeNull();
    expect(stub.resolve).not.toHaveBeenCalled();
  });
});

describe('DependencyGraph rendering', () => {
  it('sizes every participants-grid column by a token-built width role, so a narrow panel scrolls the grid instead of squeezing it', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid');
    const template = grid.style.getPropertyValue('--dgc-columns').trim();

    // Split at top-level spaces only, so the space after the comma inside
    // `minmax(var(--dg-column-min-name), var(--dg-column-share-wide))` stays
    // inside the track it belongs to.
    const tracks: string[] = [];
    let depth = 0;
    let current = '';
    for (const character of template) {
      if (character === ' ' && depth === 0) {
        if (current !== '') {
          tracks.push(current);
        }
        current = '';
        continue;
      }
      depth += character === '(' ? 1 : character === ')' ? -1 : 0;
      current += character;
    }
    if (current !== '') {
      tracks.push(current);
    }

    // Six columns, each the design system's track for its content's role: the
    // layer and total-time figures take the compact roles, the class chip a
    // label, and the participant, its relationships and its source the
    // identifier role — so the participant label and the relationship chips,
    // which wrap their full text, take the identifier role's track: its full
    // floor wherever the panel has room and, only when narrowing makes the grid
    // fit a panel too narrow for every floor, as little as the yielded fraction
    // of it.
    const roles: readonly DataTableColumnWidth[] = [
      'status',
      'name',
      'label',
      'quantity',
      'name',
      'name',
    ];
    expect(tracks).toEqual(roles.map((role) => DATA_TABLE_COLUMN_TRACKS[role].track));

    // None of them is a floorless `minmax(0, …)`, which would let the
    // participant label collapse to a few characters per line in a narrow
    // panel: every track opens on a column-floor token — the readable floor
    // itself, or a clamp that opens on that floor scaled by the
    // `--dg-column-yield` token a truncating role can give way to — and no
    // track carries a number of its own.
    for (const track of tracks) {
      expect(track).toMatch(
        /^(?:minmax\()?(?:var\(--dg-column-min-[a-z]+\)|clamp\(calc\(var\(--dg-column-min-[a-z]+\) \* var\(--dg-column-yield\)\))/u,
      );
      // A token's own name may carry a digit (`--dg-space-2`); what the track
      // writes around its references may not.
      expect(track.replace(/var\(--[a-z0-9-]+\)/gu, '')).not.toMatch(/\d/u);
    }

    // One minimum and one readable floor per column reach the grid's own sums,
    // which decide whether a too-narrow panel truncates the identifier columns
    // to fit or keeps every floor and scrolls.
    const minimumInline = grid.style.getPropertyValue('--dgc-min-inline').trim();
    expect(minimumInline).toBe(
      `calc(${roles.map((role) => DATA_TABLE_COLUMN_TRACKS[role].minimum).join(' + ')})`,
    );
    expect(minimumInline.match(/var\(--dg-column-min-[a-z]+\)/gu)).toHaveLength(tracks.length);
    expect(grid.style.getPropertyValue('--dgc-readable-inline').trim()).toBe(
      `calc(${roles.map((role) => DATA_TABLE_COLUMN_TRACKS[role].floor).join(' + ')})`,
    );
  });

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
    // the only thing distinguishing two of them.
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
    // literal reaches this component.
    const style = shape.getAttribute('style') ?? '';
    expect(style).toContain(dependencyNodeColorVar('database'));
    expect(style).not.toContain('#');
    expect(style).not.toContain('rgb');
  });

  it('agrees every count in the text alternative with its noun, singular and plural', async () => {
    // One participant in one column, joined by nothing.
    const lone = resolvingProvider(makeGraph({ nodes: [INTERACTION], edges: [] }));
    const view = renderComponent(makeNode(), {
      provider: lone.provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('grid');

    const loneAlternative = canvas().getAttribute('aria-label') ?? '';
    expect(loneAlternative).toContain('1 participant in 1 layer, joined by 0 relationships and');
    expect(loneAlternative).not.toContain('1 participants');
    expect(loneAlternative).not.toContain('1 layers');
    view.unmount();

    // Two participants in two columns, joined by exactly one relationship.
    const pair = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, HANDLER], edges: [makeEdge(INTERACTION.id, HANDLER.id)] }),
    );
    renderComponent(makeNode(), { provider: pair.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const pairAlternative = canvas().getAttribute('aria-label') ?? '';
    expect(pairAlternative).toContain('2 participants in 2 layers, joined by 1 relationship and');
    expect(pairAlternative).not.toContain('1 relationships');
  });

  it('states what the picture holds and repeats every participant in the grid', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // The canvas is one image with a text alternative that says what it holds
    // and where the keyboard-reachable equivalent is.
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

    // The layout is static by design; this sentence is how a reader learns
    // that without trying to drag the picture first.
    const note = await screen.findByText(/this layout is static in this version/i);
    expect(note.textContent).toContain('Dragging, panning and zooming are not available.');
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();

    // It also says what a click does, and says nothing about hover or focus
    // revealing detail: every row of the table carries its detail already.
    expect(note.textContent).toContain(
      'Clicking a participant on the picture also opens its source location in the editor when it has one',
    );
    expect(note.textContent).not.toMatch(/hover|focus/i);
  });

  it('states a bounded graph as a partial result beside the canvas, with the route to more', async () => {
    const stub = resolvingProvider(chainGraph({ truncated: true }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // The badge the other charts use, and one statement of what is drawn and
    // how to see more — never a control, since nothing more is in memory.
    const drawn = `Showing the ${String(CHAIN_PARTICIPANTS.length)} most significant participants`;
    const badge = screen.getByText(PARTIAL_RESULT_BADGE);
    const notice = screen.getByText(/most significant participants/);
    expect(notice.textContent).toContain(drawn);
    expect(notice.textContent).toMatch(/narrow the query to one trace or interaction/i);
    expect(badge.parentElement).toBe(notice.parentElement);
    expect(screen.queryByRole('button', { name: /^(show|load) more/i })).toBeNull();

    // Beside the canvas it qualifies — before it — rather than under the grid.
    expect(notice.compareDocumentPosition(canvas()) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(notice.closest('.dg-dependency-graph__note')).toBeNull();

    // The picture's text alternative says the same.
    expect(canvas().getAttribute('aria-label') ?? '').toContain(drawn);
  });

  it('marks nothing as partial for a graph that reached no bound', async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(screen.queryByText(PARTIAL_RESULT_BADGE)).toBeNull();
    expect(screen.queryByText(/most significant participants/)).toBeNull();
    expect(canvas().getAttribute('aria-label') ?? '').not.toContain('most significant');
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

  it("names every participant's time as a sum, and says how it differs from the metric cards", async () => {
    const stub = resolvingProvider(chainGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const metaOf = (label: string): string =>
      shapeNamed(label).parentElement?.querySelector(':scope > text.dg-dependency-graph__node-meta')
        ?.textContent ?? '';

    // On the canvas, `Σ` marks the time as a sum, before the record count.
    expect(metaOf(DATASTORE_LABEL)).toBe(`Σ ${formatDurationCompact(640)} · ×2`);
    expect(metaOf(HANDLER_LABEL)).toBe(`Σ ${formatDurationCompact(18)}`);

    // In the title and the grid, in words.
    const summed = `Records 2 · Summed ${formatDurationCompact(640)} · Slowest ${formatDurationCompact(420)}`;
    expect(titleOfShape(shapeNamed(DATASTORE_LABEL))).toContain(summed);
    expect(within(rowNamed(DATASTORE_LABEL)).getByRole('rowheader').textContent).toContain(summed);
    expect(screen.getByRole('columnheader', { name: 'Summed time' })).toBeDefined();
    expect(screen.queryByRole('columnheader', { name: 'Total time' })).toBeNull();

    // And one note under the grid, always, says what a sum is and why it can
    // exceed the wall-clock durations the metric cards report.
    const note = screen.getByText(/is the sum of its records' durations/);
    expect(note.textContent).toBe(
      `A participant's time (Σ, "Summed") is the sum of its records' durations, so records that overlapped are each counted in full and a participant's time can exceed the wall-clock tier durations the metric cards report.`,
    );
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
  });
});

describe('DependencyGraph participant detail', () => {
  /** A generic label far longer than the participant column is wide, so the column has to wrap it. */
  const LONG_LABEL = 'example.participant.with.a.label.long.enough.that.its.column.has.to.wrap.it';

  /** The chain, with the participant of its first row given {@link LONG_LABEL}. */
  function longLabelGraph(): DependencyGraphData {
    return makeGraph({
      nodes: CHAIN_PARTICIPANTS.map((node) =>
        node.id === INTERACTION.id ? makeParticipant({ ...node, label: LONG_LABEL }) : node,
      ),
      edges: CHAIN_RELATIONSHIPS,
    });
  }

  /** The participants of {@link longLabelGraph}, in the canonical order the grid reads them in. */
  const LONG_LABEL_PARTICIPANTS: readonly DependencyGraphNode[] = [
    makeParticipant({ ...INTERACTION, label: LONG_LABEL }),
    HANDLER,
    REQUEST,
    ROUTE,
    DATASTORE,
  ];

  /**
   * Asserts that a row shows its participant in the one form the cell has: the
   * full label, untruncated, wrapping and outside any tooltip, then the tier and
   * the metrics on a second line.
   *
   * @param row A row obtained by role.
   * @param node The participant it stands for.
   */
  function expectFullForm(row: HTMLElement, node: DependencyGraphNode): void {
    const label = participantLabelElementOf(row);
    expect(label.textContent).toBe(node.label);
    expect(label.classList.contains('dg-dependency-graph__participant-label')).toBe(true);
    expect(label.classList.contains('dg-text--truncate')).toBe(false);
    expect(label.closest('.dg-tooltip')).toBeNull();

    const tier = node.tier === undefined ? '' : `${formatTierLabel(node.tier)} · `;
    const metrics = `Records ${String(node.count)} · Summed ${formatDurationCompact(node.totalDurationMs)} · Slowest ${formatDurationCompact(node.maxDurationMs)}`;
    const header = within(row).getByRole('rowheader');
    expect(header.textContent).toBe(`${node.label}${tier}${metrics}`);
    expect(header.querySelector('[role="tooltip"]')).toBeNull();
  }

  /**
   * Every data row's content, cell by cell: the comparison surface of the
   * invariance cases.
   *
   * Each cell is read as its markup, so a changed element, class, attribute or
   * text anywhere in it fails the comparison. One column is read differently:
   * the source chip is wrapped in the library's tooltip, which opens on focus
   * and on hover by swapping classes on its bubble — an absolutely positioned
   * overlay that takes no space in the row — so that cell is compared by its
   * element count and its text, which is everything about it that could move
   * the chip.
   *
   * The row element's own attributes are deliberately not part of it: the
   * `DataTable` primitive moves its roving tab stop there and writes
   * `aria-selected`, `dg-is-active` and `dg-is-selected`, colour-only states
   * that resize nothing.
   *
   * @returns One list of cell readings per data row, in document order.
   */
  function rowContents(): string[][] {
    return dataRows().map((row) =>
      Array.from(row.querySelectorAll<HTMLElement>('[aria-colindex]')).map((cell) =>
        cell.getAttribute('aria-colindex') === String(SOURCE_COLUMN_INDEX)
          ? `${String(cell.querySelectorAll('*').length)}|${cell.textContent ?? ''}`
          : cell.innerHTML,
      ),
    );
  }

  /**
   * The grid's Tab order, read from the DOM: how many of its elements are Tab
   * stops, and how many of its data rows carry the roving index.
   *
   * A Tab stop is a focusable element whose tab index is not `-1`: a
   * `tabindex="0"`, or a native control that states no index and so keeps the
   * browser's own order. A control inside a cell carries `tabindex="-1"` — the
   * `DataTable` caller's obligation — which keeps it focusable by the pointer
   * and by the grid's cell navigation but out of the Tab order.
   */
  function gridTabIndices(): { readonly stops: number; readonly rows: number } {
    const focusable = Array.from(
      screen
        .getByRole('grid')
        .querySelectorAll('[tabindex], a[href], button, input, select, textarea'),
    );
    return {
      stops: focusable.filter((element) => element.getAttribute('tabindex') !== '-1').length,
      rows: dataRows().filter((row) => row.hasAttribute('tabindex')).length,
    };
  }

  it('shows every row its full label and its detail inline, with no tooltip to open', async () => {
    const stub = resolvingProvider(longLabelGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const rows = dataRows();
    expect(rows).toHaveLength(LONG_LABEL_PARTICIPANTS.length);

    // Before anything holds focus or the pointer, every row already reads in
    // full: nothing about a participant is reachable by hover alone.
    for (const [index, row] of rows.entries()) {
      const node = LONG_LABEL_PARTICIPANTS[index];
      if (node === undefined) {
        throw new Error(`the fixture has no participant for row ${String(index)}`);
      }
      expectFullForm(row, node);
    }
  });

  it('keeps every row identical through focus, the pointer and the selection', async () => {
    const user = userEvent.setup();
    const stub = resolvingProvider(longLabelGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const before = rowContents();

    // Keyboard focus on the grid's single tab stop, then on the next row.
    await user.tab();
    expect(document.activeElement).toBe(dataRows()[0]);
    expect(rowContents()).toEqual(before);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(dataRows()[1]);
    expect(rowContents()).toEqual(before);

    // The pointer over a row, and over a shape on the canvas — which the
    // canvas answers, and the grid does not.
    await user.hover(rowNamed(ROUTE_LABEL));
    expect(rowContents()).toEqual(before);

    await user.hover(shapeNamed(REQUEST_LABEL));
    expect(shapeNamed(REQUEST_LABEL).classList.contains('dg-is-hovered')).toBe(true);
    expect(rowContents()).toEqual(before);

    // A selection, made in the grid.
    await user.click(rowNamed(HANDLER_LABEL));
    expect(rowNamed(HANDLER_LABEL).getAttribute('aria-selected')).toBe('true');
    expect(rowContents()).toEqual(before);

    // Focus on a control inside a row, and then leaving the view altogether.
    const chip = screen.getByRole('button', { name: SOURCE_CHIP_NAME });
    act(() => {
      chip.focus();
    });
    expect(document.activeElement).toBe(chip);
    expect(rowContents()).toEqual(before);

    act(() => {
      chip.blur();
    });
    expect(document.activeElement).not.toBe(chip);
    expect(rowContents()).toEqual(before);

    for (const [index, row] of dataRows().entries()) {
      const node = LONG_LABEL_PARTICIPANTS[index];
      if (node === undefined) {
        throw new Error(`the fixture has no participant for row ${String(index)}`);
      }
      expectFullForm(row, node);
    }
  });

  it('opens source on the first press of a chip, because the row does not move under it', async () => {
    const stub = resolvingProvider(chainGraph());
    const spies = makeActions();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    const chip = await screen.findByRole('button', { name: SOURCE_CHIP_NAME });
    const before = rowContents();

    // A primary-button press, as a browser delivers it: `mousedown` on the
    // chip, and focus moving to the chip before the button is released. A row
    // that answered that focus by growing would carry the chip out from under
    // the pointer, and the release — and so the click — would land on the row.
    fireEvent.mouseDown(chip, { button: 0 });
    act(() => {
      chip.focus();
    });

    expect(document.activeElement).toBe(chip);
    expect(rowContents()).toEqual(before);

    // The release and the click land where the press did: on the chip.
    fireEvent.mouseUp(chip, { button: 0 });
    fireEvent.click(chip, { button: 0 });

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toBe(BASE_SOURCE);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(rowNamed(DATASTORE_LABEL).getAttribute('aria-selected')).toBe('false');
    expect(rowContents()).toEqual(before);
  });

  it('adds no tab stop: the grid keeps exactly one before, during and after focus', async () => {
    const user = userEvent.setup();
    const stub = resolvingProvider(longLabelGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // Every row carries the roving index and exactly one element is a Tab stop:
    // the source chip, the grid's one in-cell control, is out of the Tab order.
    const rowCount = dataRows().length;
    expect(gridTabIndices()).toEqual({ stops: 1, rows: rowCount });
    expect(screen.getByRole('button', { name: SOURCE_CHIP_NAME }).getAttribute('tabindex')).toBe(
      '-1',
    );

    await user.tab();
    expect(gridTabIndices()).toEqual({ stops: 1, rows: rowCount });

    await user.keyboard('{ArrowDown}');
    expect(gridTabIndices()).toEqual({ stops: 1, rows: rowCount });

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

    // The rows are planned once too, from that same layering, and the layout
    // draws that very plan — the one the column gap was sized from — rather
    // than planning its own.
    expect(scaleCalls.planned).toHaveLength(1);
    expect(scaleCalls.planned[0]).toBe(resolved);
    expect(scaleCalls.plans).toHaveLength(1);
    expect(scaleCalls.suppliedPlans).toHaveLength(1);
    expect(scaleCalls.suppliedPlans[0]).toBe(scaleCalls.plans[0]);

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
    // not scale, and no transform appeared to carry a gesture.
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

describe('DependencyGraph deterministic geometry', () => {
  /** The chain's column count: it places one participant per column. */
  const COLUMNS = CANONICAL_LABELS.length;

  /** The inset the canvas keeps on every side: half the participant outline's 2-unit stroke. */
  const INSET = 1;

  /**
   * The space the component keeps clear between a count label's ink and the
   * outline on either side of it, beyond the half stroke ({@link INSET}) each
   * outline reaches into the gap.
   */
  const LABEL_CLEARANCE = 4;

  /** A count whose label is far wider than the default gap can hold. */
  const LARGE_COUNT = 123_456_789;

  /** A count of several digits whose label the default gap still holds. */
  const MODEST_COUNT = 1_234;

  /** The left edge of every chain column at a given gap, in reading order. */
  function columnLefts(gap: number): number[] {
    return CANONICAL_LABELS.map((_label, column) => column * (DEFAULT_GRAPH_NODE_WIDTH + gap));
  }

  /** The canvas width the chain needs at a given gap, its inset included. */
  function chainCanvasWidth(gap: number): number {
    return COLUMNS * DEFAULT_GRAPH_NODE_WIDTH + (COLUMNS - 1) * gap + 2 * INSET;
  }

  /** The count label the canvas draws for a relationship that ran `count` times. */
  function countLabel(count: number): string {
    return `×${formatCount(count)}`;
  }

  /**
   * The column gap a count label drawn in it requires: the label's advance by
   * the package's own pure estimate at the label type role's size, rounded up
   * to a whole unit, with the clearance and the half outline on both sides —
   * and never less than the scale module's default rhythm.
   */
  function gapHolding(label: string): number {
    return Math.max(
      DEFAULT_GRAPH_COLUMN_GAP,
      Math.ceil(estimateTextWidth(label, DEFAULT_LABEL_FONT_SIZE)) + 2 * (LABEL_CLEARANCE + INSET),
    );
  }

  /**
   * The chain with its one column-to-column repeated relationship, the server
   * work into the datastore, run `count` times.
   *
   * @param count How often that relationship ran.
   * @param order How to rearrange the participants and the relationships.
   */
  function repeatedChain(
    count: number,
    order: <T>(values: readonly T[]) => readonly T[] = (values) => values,
  ): DependencyGraphData {
    return makeGraph({
      nodes: order(CHAIN_PARTICIPANTS),
      edges: order([
        makeEdge(ROUTE.id, DATASTORE.id, { count, totalDurationMs: 640 }),
        ...CHAIN_RELATIONSHIPS.filter((edge) => edge.from !== ROUTE.id),
      ]),
    });
  }

  /**
   * Asserts the canvas declares the chain's logical size at `gap`: the
   * `viewBox` is the layout's own extent with the outline inset, the `width`
   * and `height` attributes are those same two numbers — so at rest one user
   * unit is one CSS pixel — and the canvas is exactly as tall as its one row of
   * boxes. Every box keeps the scale module's width.
   */
  function expectLogicalSize(gap: number): void {
    const frame = canvasFrame();
    expect(frame.width).toBe(chainCanvasWidth(gap));
    expect(frame.height).toBe(DEFAULT_GRAPH_NODE_HEIGHT + 2 * INSET);
    expect(frame.viewBox).toEqual([-INSET, -INSET, frame.width, frame.height]);
    expect(nodeShapes().map((shape) => shape.getAttribute('width'))).toEqual(
      CANONICAL_LABELS.map(() => String(DEFAULT_GRAPH_NODE_WIDTH)),
    );
  }

  /**
   * Renders a payload and waits for the grid.
   *
   * @param data The payload to draw.
   */
  async function renderGraph(data: DependencyGraphData): Promise<void> {
    renderComponent(makeNode(), {
      provider: resolvingProvider(data).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('grid');
  }

  it("declares the layout's own logical size as its viewBox, width and height", async () => {
    await renderGraph(chainGraph());

    // The chain's one repeated relationship, `×2`, needs far less room than the
    // default rhythm gives, so the rhythm holds.
    expect(edgeCountLabels().map((label) => label.textContent)).toEqual([countLabel(2)]);
    expect(shapeLefts()).toEqual(columnLefts(DEFAULT_GRAPH_COLUMN_GAP));
    expectLogicalSize(DEFAULT_GRAPH_COLUMN_GAP);
    expectCurvesBetweenColumns();

    // The size is the drawing's own, declared as plain numbers on the element:
    // no percentage, no inline style and no aspect override for a container to
    // resolve. The viewport around it is a plain scroll container.
    const picture = canvas();
    expect(picture.getAttribute('width')).toBe(String(chainCanvasWidth(DEFAULT_GRAPH_COLUMN_GAP)));
    expect(picture.getAttribute('height')).toBe(String(DEFAULT_GRAPH_NODE_HEIGHT + 2 * INSET));
    expect(picture.getAttribute('style')).toBeNull();
    expect(picture.getAttribute('preserveAspectRatio')).toBeNull();

    const viewport = picture.parentElement;
    expect(viewport?.classList.contains('dg-dependency-graph__viewport')).toBe(true);
    expect(viewport?.getAttribute('style')).toBeNull();
  });

  it('widens the column gap exactly as far as a long count label drawn in it requires', async () => {
    await renderGraph(repeatedChain(LARGE_COUNT));

    const [label] = edgeCountLabels();
    if (label === undefined) {
      throw new Error('the repeated relationship drew no count label');
    }
    const text = label.textContent ?? '';
    expect(text).toBe(countLabel(LARGE_COUNT));

    // Wider than the default rhythm, by exactly what the label needs, and the
    // same for every gap: the columns stay on one pitch.
    const gap = gapHolding(text);
    expect(gap).toBeGreaterThan(DEFAULT_GRAPH_COLUMN_GAP);
    expect(shapeLefts()).toEqual(columnLefts(gap));
    expectLogicalSize(gap);
    expectCurvesBetweenColumns();

    // The label is centred in the gap it labels, and its ink — estimated the
    // way the component estimates it — clears both outlines, whose strokes
    // reach one unit into the gap, by the clearance on each side.
    const [, , , routeLeft, datastoreLeft] = shapeLefts();
    if (routeLeft === undefined || datastoreLeft === undefined) {
      throw new Error('the chain drew fewer than five columns');
    }
    const routeRight = routeLeft + DEFAULT_GRAPH_NODE_WIDTH;
    const centre = Number(label.getAttribute('x'));
    const advance = estimateTextWidth(text, DEFAULT_LABEL_FONT_SIZE);
    expect(centre).toBeCloseTo(routeRight + gap / 2);
    expect(centre - advance / 2).toBeGreaterThanOrEqual(routeRight + INSET + LABEL_CLEARANCE);
    expect(centre + advance / 2).toBeLessThanOrEqual(datastoreLeft - INSET - LABEL_CLEARANCE);

    // The reading order is the payload's, whatever the gap.
    expect(canvasLabels()).toEqual(CANONICAL_LABELS);
    expect(participantLabels()).toEqual(CANONICAL_LABELS);
  });

  it('keeps the default rhythm for a count label the default gap already holds', async () => {
    await renderGraph(repeatedChain(MODEST_COUNT));

    // Several digits and a group separator, and still narrower than the gap
    // needs to be: nothing widens that the data does not require.
    const text = countLabel(MODEST_COUNT);
    expect(edgeCountLabels().map((label) => label.textContent)).toEqual([text]);
    expect(gapHolding(text)).toBe(DEFAULT_GRAPH_COLUMN_GAP);
    expect(shapeLefts()).toEqual(columnLefts(DEFAULT_GRAPH_COLUMN_GAP));
    expectLogicalSize(DEFAULT_GRAPH_COLUMN_GAP);
  });

  it('draws one payload identically across renders, mounts and orders of arrival', async () => {
    const user = userEvent.setup();

    resetScaleCalls();
    await renderGraph(repeatedChain(LARGE_COUNT));
    const first = drawnGeometry();
    expect(first.frame.width).toBe(chainCanvasWidth(gapHolding(countLabel(LARGE_COUNT))));

    // A second render of the same mount: a hover changes state and redraws the
    // canvas, and not one coordinate moves — nor is the layering resolved or
    // the layout rebuilt for it.
    await user.hover(shapeNamed(ROUTE_LABEL));
    expect(shapeNamed(ROUTE_LABEL).classList.contains('dg-is-hovered')).toBe(true);
    expect(drawnGeometry()).toEqual(first);
    await user.unhover(shapeNamed(ROUTE_LABEL));
    expect(drawnGeometry()).toEqual(first);
    expect(scaleCalls.resolved).toHaveLength(1);
    expect(scaleCalls.supplied).toHaveLength(1);
    expect(scaleCalls.plans).toHaveLength(1);

    // Fresh mounts of the same data in other orders — reversed, and rotated —
    // are the same graph, so they draw the same picture to the last attribute.
    const arrivals: readonly (<T>(values: readonly T[]) => readonly T[])[] = [
      (values) => values,
      (values) => values.toReversed(),
      (values) => [...values.slice(2), ...values.slice(0, 2)],
    ];

    for (const order of arrivals) {
      cleanup();
      await renderGraph(repeatedChain(LARGE_COUNT, order));
      expect(drawnGeometry()).toEqual(first);
    }
  });
});

describe('DependencyGraph row bound and count placement', () => {
  /** The inset the canvas keeps on every side: half the participant outline's stroke. */
  const INSET = 1;

  /** The clear space a count label keeps from a box: the clearance plus the outline's reach. */
  const REACH = 4 + INSET;

  /** The distance from one row's top to the next row's. */
  const ROW_PITCH = DEFAULT_GRAPH_NODE_HEIGHT + DEFAULT_GRAPH_ROW_GAP;

  /** The participant a fan starts at. */
  const FAN_SOURCE = makeParticipant({
    id: 'dep:function|browser|example.fan.source',
    label: 'example.fan.source',
    spanIds: [spanIdFor(90)],
    totalDurationMs: 900,
    layer: 0,
  });

  /** The label of a fan's `index`-th target: `example.fan.07`. */
  function fanLabel(index: number): string {
    return `example.fan.${String(index).padStart(2, '0')}`;
  }

  /** A fan's `index`-th target; the earlier the index, the costlier. */
  function fanTarget(index: number): DependencyGraphNode {
    return makeParticipant({
      id: `dep:function|browser|${fanLabel(index)}`,
      label: fanLabel(index),
      spanIds: [spanIdFor(100 + index)],
      totalDurationMs: 500 - index,
      layer: 1,
    });
  }

  /**
   * One participant calling `size` others in the next column; the relationship
   * to the `index`-th ran `index + 2` times, so every one carries a count.
   */
  function fanGraph(
    size: number,
    edge: (index: number) => EdgeOverrides = (index) => ({ count: index + 2 }),
  ): DependencyGraphData {
    const targets = Array.from({ length: size }, (_, index) => fanTarget(index));
    return makeGraph({
      nodes: [FAN_SOURCE, ...targets],
      edges: targets.map((target, index) => makeEdge(FAN_SOURCE.id, target.id, edge(index))),
    });
  }

  /** The vertical centre of row `row`, where its connectors anchor. */
  function rowCentre(row: number): number {
    return row * ROW_PITCH + DEFAULT_GRAPH_NODE_HEIGHT / 2;
  }

  /** Renders a payload, waits for the grid and returns the action spies. */
  async function renderGraph(data: DependencyGraphData): Promise<ActionSpies> {
    const spies = makeActions();
    renderComponent(makeNode(), {
      provider: resolvingProvider(data).provider,
      actions: spies.actions,
    });
    await screen.findByRole('grid');
    return spies;
  }

  /** The overflow box's shape. */
  function overflowShape(): Element {
    const shape = canvas().querySelector('[data-overflow] > rect');
    if (shape === null) {
      throw new Error('the canvas drew no overflow box');
    }
    return shape;
  }

  /** The metrics line drawn in a shape's box. */
  function metaOf(shape: Element): string {
    return (
      shape.parentElement?.querySelector(':scope > text.dg-dependency-graph__node-meta')
        ?.textContent ?? ''
    );
  }

  /** The note under the grid that counts the labels left off the picture, if any. */
  function suppressedNote(): HTMLElement | null {
    return screen.queryByText(/relationship counts? (?:is|are) not drawn on the picture/);
  }

  it('draws a column taller than the row bound as its five costliest participants and one overflow box', async () => {
    await renderGraph(fanGraph(20));

    // Five targets in boxes of their own, costliest first, and one box for the
    // other fifteen — every box with exactly one label.
    expect(canvasLabels()).toEqual([
      FAN_SOURCE.label,
      ...[0, 1, 2, 3, 4].map(fanLabel),
      '+15 more',
    ]);
    expect(nodeShapes()).toHaveLength(7);

    // Targets 5 to 19 took 495 down to 481 ms: 7,320 ms summed.
    const gatheredTotal = formatDurationCompact(7320);
    const overflow = overflowShape();
    expect(overflow.getAttribute('y')).toBe(String(5 * ROW_PITCH));
    expect(metaOf(overflow)).toBe(`Σ ${gatheredTotal}`);
    expect(titleOfShape(overflow)).toBe(
      `15 participants gathered here: ${[5, 6, 7, 8, 9].map(fanLabel).join(', ')} and 10 more · Summed time ${gatheredTotal}. Each is listed in the table below.`,
    );

    // It stands for no one class: the base class alone, no colour of its own —
    // its only inline declaration hands the pointer back to the browser, since
    // it selects nothing.
    expect([...overflow.classList]).toEqual(['dg-dependency-graph__node']);
    expect((overflow as SVGElement).style.getPropertyValue('--dgc-node-color')).toBe('');
    expect((overflow as SVGElement).style.cursor).toBe('auto');
    expect((overflow as SVGElement).style.length).toBe(1);

    // Six rows tall, whatever the column holds, so the viewport cuts no box.
    expect(canvasFrame().height).toBe(
      6 * DEFAULT_GRAPH_NODE_HEIGHT + 5 * DEFAULT_GRAPH_ROW_GAP + 2 * INSET,
    );

    // One curve per drawn pair of boxes, the gathered relationships merged
    // into the last, whose count is their sum: 7 + 8 + … + 21.
    expect(edgeCurves()).toHaveLength(6);
    expectCurvesBetweenColumns();
    expect(edgeCountLabels().map((label) => label.textContent)).toEqual([
      '×2',
      '×3',
      '×4',
      '×5',
      '×6',
      '×210',
    ]);

    // The grid still lists every participant, in its own column, and every
    // relationship on its own.
    expect(dataRows()).toHaveLength(21);
    expect(statedLayers().slice(6)).toEqual(Array.from({ length: 15 }, () => '2'));
    expect(relationshipChips(rowNamed(FAN_SOURCE.label))).toHaveLength(20);

    // And the text alternative says what was gathered.
    expect(canvas().getAttribute('aria-label')).toContain(
      'In 1 layer that holds more than 6 participants, the 5 that took the most time are drawn in boxes of their own and the other 15 participants are gathered into one summary box at its foot.',
    );
  });

  it('keeps the overflow box inert, and marks it as where a gathered participant selected in the grid is drawn', async () => {
    const spies = await renderGraph(fanGraph(20));
    const user = userEvent.setup();

    // Not a control: there is no one participant a click could select or open,
    // and it does not hover with the participant boxes' hand.
    expect((overflowShape() as SVGElement).style.cursor).toBe('auto');
    expect((shapeNamed(fanLabel(0)) as SVGElement).style.getPropertyValue('cursor')).toBe('');
    await user.click(overflowShape());
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(dataRows().some((row) => row.getAttribute('aria-selected') === 'true')).toBe(false);

    await user.click(rowNamed(fanLabel(12)));
    expect(rowNamed(fanLabel(12)).getAttribute('aria-selected')).toBe('true');
    expect(overflowShape().classList.contains('dg-is-selected')).toBe(true);
    expect(nodeShapes().filter((shape) => shape.classList.contains('dg-is-selected'))).toEqual([
      overflowShape(),
    ]);

    // Selecting a participant drawn in its own box moves the mark there.
    await user.click(rowNamed(fanLabel(1)));
    expect(overflowShape().classList.contains('dg-is-selected')).toBe(false);
    expect(shapeNamed(fanLabel(1)).classList.contains('dg-is-selected')).toBe(true);
  });

  it('draws each count of a fan beside the participant it reaches, and leaves no note', async () => {
    await renderGraph(fanGraph(4));

    const targetLeft = DEFAULT_GRAPH_NODE_WIDTH + DEFAULT_GRAPH_COLUMN_GAP;
    const labels = edgeCountLabels();
    expect(labels).toHaveLength(4);
    for (const [row, label] of labels.entries()) {
      const advance = estimateTextWidth(label.textContent ?? '', DEFAULT_LABEL_FONT_SIZE);
      expect(label.getAttribute('data-placement')).toBe('near-target');
      expect(Number(label.getAttribute('x'))).toBeCloseTo(targetLeft - REACH - advance / 2);
      expect(Number(label.getAttribute('y'))).toBe(rowCentre(row));
    }
    expect(suppressedNote()).toBeNull();
  });

  it('keeps a lone count centred in its gap', async () => {
    await renderGraph(chainGraph());

    expect(
      edgeCountLabels().map((label) => [label.textContent, label.getAttribute('data-placement')]),
    ).toEqual([['×2', 'midpoint']]);
    expect(suppressedNote()).toBeNull();
  });

  it('says how many counts fit nowhere on the picture, while the table keeps every one', async () => {
    const stacked = (label: string): DependencyGraphNode =>
      makeParticipant({ id: `dep:function|browser|${label}`, label, layer: 0 });
    const [upper, middle, lower] = [
      stacked('example.stack.a'),
      stacked('example.stack.b'),
      stacked('example.stack.c'),
    ];

    // One relationship between two boxes of one column: the row gap is
    // shorter than a label, so its count is not drawn.
    await renderGraph(
      makeGraph({ nodes: [upper, middle], edges: [makeEdge(upper.id, middle.id, { count: 3 })] }),
    );
    expect(edgeCountLabels()).toHaveLength(0);
    expect(suppressedNote()?.textContent).toBe(
      '1 relationship count is not drawn on the picture where it would overlap; the table lists every count.',
    );
    expect(relationshipChips(rowNamed(upper.label)).map((chip) => chip.textContent)).toEqual([
      `→ ${middle.label} ×3`,
    ]);

    cleanup();
    await renderGraph(
      makeGraph({
        nodes: [upper, middle, lower],
        edges: [
          makeEdge(upper.id, middle.id, { count: 3 }),
          makeEdge(middle.id, lower.id, { count: 4 }),
        ],
      }),
    );
    expect(suppressedNote()?.textContent).toBe(
      '2 relationship counts are not drawn on the picture where they would overlap; the table lists every count.',
    );
  });

  it('marks a merged connector with the least certain lineage among the relationships it stands for', async () => {
    const mergedCurve = (): Element => {
      const curve = canvas().querySelector('path[data-connector="0:0>1:5"]');
      if (curve === null) {
        throw new Error('the canvas drew no connector to the overflow box');
      }
      return curve;
    };

    // Targets 5, 6 and 7 are gathered; one of their relationships was inferred.
    await renderGraph(
      fanGraph(8, (index) => ({
        count: index + 2,
        ...(index === 6 ? { inferredCount: index + 2 } : {}),
      })),
    );
    expect(mergedCurve().classList.contains('dg-is-inferred')).toBe(true);

    // An ambiguous one among them outweighs the inferred one.
    cleanup();
    await renderGraph(
      fanGraph(8, (index) => ({
        count: index + 2,
        ...(index === 6 ? { inferredCount: index + 2 } : {}),
        ...(index === 7 ? { inferredCount: index + 2, ambiguousCount: 1 } : {}),
      })),
    );
    expect(mergedCurve().classList.contains('dg-is-ambiguous')).toBe(true);
    expect(mergedCurve().classList.contains('dg-is-inferred')).toBe(false);

    // A drawn box's own connector keeps its own state.
    expect(
      canvas()
        .querySelector('path[data-connector="0:0>1:0"]')
        ?.classList.contains('dg-is-inferred'),
    ).toBe(false);
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
    // this one acts on the object it is handed.
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
    // nothing rather than being handed a span id masquerading as an event id.
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

    // One participant: the noun, the pronouns and the verb all agree with it.
    const note = await screen.findByText(INCONSISTENT_COORDINATES_NOTE);
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
    expect(note.textContent).toBe(
      '1 participant declared an event that does not match its records, so selecting it opens no event.',
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

    // Several participants: the plural throughout.
    const note = await screen.findByText(INCONSISTENT_COORDINATES_NOTE);
    expect(note.textContent).toBe(
      `${String(broken.length)} participants declared an event that does not match their records, so selecting them opens no event.`,
    );
  });

  it('reports nothing inconsistent for a payload whose coordinates all hold', async () => {
    const enriched = makeParticipant({ ...HANDLER, eventId: EVENT_ID, traceId: TRACE_ID });
    const stub = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, enriched], edges: [makeEdge(INTERACTION.id, HANDLER.id)] }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(screen.queryByText(INCONSISTENT_COORDINATES_NOTE)).toBeNull();
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

    // This participant resolved to no location, so the click opens nothing and
    // its title promises nothing.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(titleOfShape(shapeNamed(REQUEST_LABEL))).not.toContain('Click to open');
  });

  it('opens the very location a participant resolved to when its shape is clicked', async () => {
    // A single-record participant carrying both an event coordinate and a
    // location: one click raises both intents, each exactly once.
    const located = makeParticipant({
      ...HANDLER,
      eventId: EVENT_ID,
      traceId: TRACE_ID,
      source: BASE_SOURCE,
    });
    const stub = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, located], edges: [makeEdge(INTERACTION.id, HANDLER.id)] }),
    );
    const spies = makeActions();
    const user = userEvent.setup();

    // Taken BEFORE the render, as in the chip case above: a component that
    // added a field to the location in place would still pass a comparison
    // against the live fixture.
    const expectedKeys = Object.keys({ ...BASE_SOURCE }).sort();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    // The title tells the pointer user what the click will do.
    expect(titleOfShape(shapeNamed(HANDLER_LABEL))).toContain(
      `Click to open ${SOURCE_FILE} in the editor.`,
    );

    await user.click(shapeNamed(HANDLER_LABEL));

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    const [call] = spies.onOpenSource.mock.calls;
    if (call === undefined) {
      throw new Error('the open-source handler recorded no call');
    }

    // The payload's own object, by reference, with its key set untouched.
    expect(call[0]).toBe(BASE_SOURCE);
    expect(Object.keys(call[0]).sort()).toEqual(expectedKeys);

    // The selection half of the click is unchanged: the declared coordinate,
    // once, and the participant highlighted in both representations.
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent.mock.calls[0]?.[0]).toEqual({
      eventId: EVENT_ID,
      spanId: spanIdFor(2),
      traceId: TRACE_ID,
    });
    expect(rowNamed(HANDLER_LABEL).getAttribute('aria-selected')).toBe('true');
    expect(shapeNamed(HANDLER_LABEL).classList.contains('dg-is-selected')).toBe(true);
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('opens the location of a participant that collapsed several records, and selects no event', async () => {
    const stub = resolvingProvider(chainGraph());
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    // The datastore collapsed two records, so it declares no event coordinate —
    // but it did resolve to a location, and the location is what a click on
    // its shape opens.
    await user.click(shapeNamed(DATASTORE_LABEL));

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toBe(BASE_SOURCE);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(rowNamed(DATASTORE_LABEL).getAttribute('aria-selected')).toBe('true');
  });

  it('opens nothing from the shape of a participant without a location, even one with an event', async () => {
    const enriched = makeParticipant({ ...HANDLER, eventId: EVENT_ID, traceId: TRACE_ID });
    const stub = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, enriched], edges: [makeEdge(INTERACTION.id, HANDLER.id)] }),
    );
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    await user.click(shapeNamed(HANDLER_LABEL));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(titleOfShape(shapeNamed(HANDLER_LABEL))).not.toContain('Click to open');
  });

  it('keeps grid activation to selecting, so only the chip opens source from the table', async () => {
    const stub = resolvingProvider(chainGraph());
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await screen.findByRole('grid');

    // A click on the row and Enter on it: both select the participant, and
    // neither opens the location it resolved to.
    await user.click(cellOf(rowNamed(DATASTORE_LABEL), LAYER_COLUMN));
    fireEvent.keyDown(rowNamed(DATASTORE_LABEL), { key: 'Enter' });

    expect(rowNamed(DATASTORE_LABEL).getAttribute('aria-selected')).toBe('true');
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('promises no navigation from a shape where no host can open one', async () => {
    const stub = resolvingProvider(chainGraph());
    const user = userEvent.setup();

    // Rendered with a data provider and no panel actions: a surface that can
    // draw a panel but cannot navigate.
    render(
      <DataProviderContext.Provider value={stub.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <DependencyGraph node={makeNode()} />
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );
    await screen.findByRole('grid');

    expect(titleOfShape(shapeNamed(DATASTORE_LABEL))).not.toContain('Click to open');

    // The click still selects, and raises nothing that could throw.
    await user.click(shapeNamed(DATASTORE_LABEL));
    expect(rowNamed(DATASTORE_LABEL).getAttribute('aria-selected')).toBe('true');
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
    // of thing took part.
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
  it('marks an inferred relationship as inferred, and not as ambiguous, on the chip and the curve', async () => {
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

    // The distinction survives in text as well as in the tone: a guessed
    // relationship must never read as a measured one. But an attribution with
    // one candidate was not in doubt, so it is inferred — the info tone, a
    // solid curve — and never marked ambiguous, which is the one state the
    // stylesheet dashes.
    expect(chip.getAttribute('data-edge-id')).toBe(inferred.id);
    expect(chip.classList.contains('dg-is-inferred')).toBe(true);
    expect(chip.classList.contains('dg-is-ambiguous')).toBe(false);
    expect(chip.classList.contains('dg-badge--info')).toBe(true);
    expect(chip.textContent).toBe(`→ ${REQUEST_LABEL} (inferred)`);

    // The chip is the grid's own element, not a second use of the canvas
    // curve's class, whose SVG paint rules mean nothing on an HTML chip.
    expect(chip.classList.contains('dg-dependency-graph__relationship')).toBe(true);
    expect(chip.classList.contains('dg-dependency-graph__edge')).toBe(false);

    // The measured relationship beside it is not marked, in either
    // representation.
    const [measured] = relationshipChips(rowNamed(INTERACTION_LABEL));
    if (measured === undefined) {
      throw new Error('the page event rendered no relationship chip');
    }

    expect(measured.classList.contains('dg-is-inferred')).toBe(false);
    expect(measured.classList.contains('dg-is-ambiguous')).toBe(false);
    expect(measured.classList.contains('dg-badge--neutral')).toBe(true);
    expect(measured.textContent).not.toContain('inferred');
    expect(edgeCurves().filter((curve) => curve.classList.contains('dg-is-inferred'))).toHaveLength(
      1,
    );
    expect(
      edgeCurves().filter((curve) => curve.classList.contains('dg-is-ambiguous')),
    ).toHaveLength(0);
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

    // Any ambiguous record marks the relationship ambiguous — the warning
    // tone, a dashed curve — in the grid and on the canvas, and ambiguous
    // supersedes inferred rather than joining it.
    for (const chip of [partialChip, wholeChip]) {
      expect(chip.classList.contains('dg-is-ambiguous')).toBe(true);
      expect(chip.classList.contains('dg-is-inferred')).toBe(false);
      expect(chip.classList.contains('dg-badge--warning')).toBe(true);
    }
    expect(
      edgeCurves().filter((curve) => curve.classList.contains('dg-is-ambiguous')),
    ).toHaveLength(2);
    expect(edgeCurves().filter((curve) => curve.classList.contains('dg-is-inferred'))).toHaveLength(
      0,
    );
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
      expect(chip.classList.contains('dg-is-inferred')).toBe(false);
    }

    expect(
      edgeCurves().filter(
        (curve) =>
          curve.classList.contains('dg-is-ambiguous') || curve.classList.contains('dg-is-inferred'),
      ),
    ).toHaveLength(0);

    // Dropped, but never silently: the count of inconsistent declarations is
    // stated under the grid.
    const note = await screen.findByText(/inconsistent inferred or ambiguous counts/i);
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
    expect(note.textContent).toBe(
      '4 relationships declared inconsistent inferred or ambiguous counts, which are not shown.',
    );
  });

  it('states a single relationship with inconsistent lineage in the singular', async () => {
    // The relationship stays drawn; what is withheld is its declared counts, so
    // the relative clause agrees with those counts and stays plural.
    const overstated = makeEdge(INTERACTION.id, HANDLER.id, { inferredCount: 5 });
    const stub = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, HANDLER], edges: [overstated] }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const note = await screen.findByText(/inconsistent inferred or ambiguous counts/i);
    expect(note.textContent).toBe(
      '1 relationship declared inconsistent inferred or ambiguous counts, which are not shown.',
    );
    expect(edgeCurves()).toHaveLength(1);
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
    expect(chip?.classList.contains('dg-is-inferred')).toBe(false);
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

  it('names a long called participant in full on its chip, which wraps instead', async () => {
    // A generic module path and symbol, far longer than any one-line chip: the
    // kind of label a server function collapses to.
    const longLabel =
      'src/example/deeply/nested/module/path/example-service.ts runExampleOperation';
    const callee = makeParticipant({
      id: 'dep:function|server|example.long-callee',
      kind: 'function',
      label: longLabel,
      tier: 'server',
      spanIds: [spanIdFor(9)],
      layer: 1,
    });
    const stub = resolvingProvider(
      makeGraph({
        nodes: [INTERACTION, callee],
        edges: [makeEdge(INTERACTION.id, callee.id)],
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const [chip] = relationshipChips(rowNamed(INTERACTION_LABEL));
    if (chip === undefined) {
      throw new Error('the page event rendered no relationship chip');
    }

    // The chip is the relationship's only text form in the grid, so its target
    // is never shortened there: the chip's own class lets it wrap in its cell.
    expect(chip.textContent).toBe(`→ ${longLabel}`);
    expect(chip.textContent).not.toContain('…');
    expect(chip.classList.contains('dg-dependency-graph__relationship')).toBe(true);
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
    // One relationship: its noun and its verb in the singular.
    expect(note.textContent).toBe(
      '1 relationship named a participant this graph does not contain and is not drawn.',
    );

    expect(edgeCurves()).toHaveLength(1);
    expect(relationshipChips(rowNamed(HANDLER_LABEL))).toHaveLength(0);
    expect(screen.queryByText(/unlisted/i)).toBeNull();
  });

  it('counts several relationships naming participants it does not contain in the plural', async () => {
    const stub = resolvingProvider(
      makeGraph({
        nodes: [INTERACTION, HANDLER],
        edges: [
          makeEdge(INTERACTION.id, HANDLER.id),
          makeEdge(HANDLER.id, 'dep:database|db|example.unlisted'),
          makeEdge(HANDLER.id, 'dep:external|server|example.unlisted'),
        ],
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const note = await screen.findByText(/named a participant this graph does not contain/i);
    expect(note.textContent).toBe(
      '2 relationships named a participant this graph does not contain and are not drawn.',
    );
    expect(edgeCurves()).toHaveLength(1);
  });
});

describe('DependencyGraph render cascade', () => {
  /** The component whose own state changed and started the pass. */
  const TRIGGER = makeParticipant({
    id: 'dep:function|browser|example.trigger',
    kind: 'function',
    label: 'example.trigger',
    spanIds: [spanIdFor(31)],
    count: 3,
    totalDurationMs: 30,
    layer: 0,
    roles: ['trigger'],
  });

  /** A component that provided the changed value and read another; roles out of order on purpose. */
  const PROVIDER = makeParticipant({
    id: 'dep:function|browser|example.provider',
    kind: 'function',
    label: 'example.provider',
    spanIds: [spanIdFor(32)],
    count: 5,
    totalDurationMs: 50,
    layer: 1,
    roles: ['consumer', 'provider'],
  });

  /** A component that re-rendered because a context it reads changed. */
  const CONSUMER = makeParticipant({
    id: 'dep:function|browser|example.consumer',
    kind: 'function',
    label: 'example.consumer',
    spanIds: [spanIdFor(33)],
    count: 5,
    totalDurationMs: 20,
    layer: 2,
    roles: ['consumer'],
  });

  /** A component that only re-rendered because its parent did: no role. */
  const LEAF = makeParticipant({
    id: 'dep:function|browser|example.leaf',
    kind: 'function',
    label: 'example.leaf',
    spanIds: [spanIdFor(34)],
    count: 480,
    totalDurationMs: 12,
    layer: 3,
  });

  /** The cascade's relationships, each declaring why its callee rendered. */
  const CASCADE_EDGES: readonly DependencyGraphEdge[] = [
    makeEdge(TRIGGER.id, PROVIDER.id, { count: 5, renderTriggers: { props: 5 } }),
    makeEdge(PROVIDER.id, CONSUMER.id, {
      count: 5,
      inferredCount: 5,
      renderTriggers: { context: 5 },
      contexts: ['example.context'],
    }),
    makeEdge(CONSUMER.id, LEAF.id, {
      count: 480,
      renderTriggers: { props: 240, unchanged: 240 },
    }),
    makeEdge(TRIGGER.id, LEAF.id, { count: 5, renderTriggers: { mount: 3 } }),
  ];

  /** The cascade as a payload. */
  function cascadeGraph(): DependencyGraphData {
    return makeGraph({ nodes: [LEAF, CONSUMER, PROVIDER, TRIGGER], edges: CASCADE_EDGES });
  }

  /** The metrics line drawn in a participant's box, found through its label. */
  function metaOfShape(label: string): string {
    const metas = Array.from(canvas().querySelectorAll('text.dg-dependency-graph__node-meta'));
    return metas[canvasLabels().indexOf(label)]?.textContent ?? '';
  }

  /** The role words a row's class cell shows, in document order. */
  function rolesOfRow(label: string): string[] {
    return Array.from(
      cellOf(rowNamed(label), CLASS_COLUMN).querySelectorAll<HTMLElement>('[data-role]'),
    ).map((chip) => chip.textContent ?? '');
  }

  /**
   * The text of the relationship chip a row carries toward `target`, found by
   * the relationship id {@link makeEdge} gives it.
   */
  function chipTo(label: string, target: DependencyGraphNode): string {
    const chip = relationshipChips(rowNamed(label)).find((candidate) =>
      (candidate.getAttribute('data-edge-id') ?? '').endsWith(`=>${target.id}`),
    );
    if (chip === undefined) {
      throw new Error(`"${label}" rendered no relationship chip toward "${target.label}"`);
    }
    return chip.textContent ?? '';
  }

  it('names every role after the class chip, in the vocabulary order, and nothing for a component with none', async () => {
    const stub = resolvingProvider(cascadeGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // The class chip stays first and keeps its colour; each role follows as a
    // chip of its own, in the aggregate's order whatever order it arrived in.
    const providerClass = cellOf(rowNamed(PROVIDER.label), CLASS_COLUMN);
    expect(providerClass.querySelector('[data-kind]')?.textContent).toBe('Function');
    expect(rolesOfRow(PROVIDER.label)).toEqual(['provider', 'consumer']);
    expect(rolesOfRow(TRIGGER.label)).toEqual(['trigger']);
    expect(rolesOfRow(CONSUMER.label)).toEqual(['consumer']);

    // A component that re-rendered only because its parent did played no role.
    expect(rolesOfRow(LEAF.label)).toEqual([]);
    expect(cellOf(rowNamed(LEAF.label), CLASS_COLUMN).textContent).toBe('Function');

    // The role chips carry no colour of their own: a role is never drawn as a
    // participant class or a span kind.
    for (const chip of providerClass.querySelectorAll<HTMLElement>('[data-role]')) {
      expect(chip.getAttribute('style')).toBeNull();
    }
  });

  it('lists roles in the order the telemetry vocabulary declares them', async () => {
    const everything = makeParticipant({
      ...TRIGGER,
      roles: DEPENDENCY_NODE_ROLES.toReversed(),
    });
    const stub = resolvingProvider(makeGraph({ nodes: [everything], edges: [] }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(rolesOfRow(TRIGGER.label)).toEqual([...DEPENDENCY_NODE_ROLES]);
    expect(titleOfShape(shapeNamed(TRIGGER.label))).toContain(
      `Roles: ${DEPENDENCY_NODE_ROLES.join(', ')}`,
    );
    // Provider first when a box has room for one role.
    expect(metaOfShape(TRIGGER.label).startsWith('provider · ')).toBe(true);
  });

  it('ignores a role outside the closed vocabulary rather than inventing a word for it', async () => {
    const odd = makeParticipant({
      ...CONSUMER,
      roles: ['consumer', 'example-role'] as unknown as DependencyGraphNode['roles'],
    });
    const stub = resolvingProvider(makeGraph({ nodes: [odd], edges: [] }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(rolesOfRow(CONSUMER.label)).toEqual(['consumer']);
    expect(screen.queryByText(/example-role/)).toBeNull();
  });

  it('prefixes each box with its primary role and names every role in its title', async () => {
    const stub = resolvingProvider(cascadeGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // Provider outranks consumer, and the box of a component with no role
    // carries its metrics alone.
    expect(metaOfShape(PROVIDER.label).startsWith('provider · ')).toBe(true);
    expect(metaOfShape(TRIGGER.label).startsWith('trigger · ')).toBe(true);
    expect(metaOfShape(CONSUMER.label).startsWith('consumer · ')).toBe(true);
    expect(metaOfShape(LEAF.label)).not.toMatch(/^(?:trigger|provider|consumer) · /u);

    expect(titleOfShape(shapeNamed(PROVIDER.label))).toContain('Roles: provider, consumer');
    expect(titleOfShape(shapeNamed(TRIGGER.label))).toContain('Role: trigger');
    expect(titleOfShape(shapeNamed(LEAF.label))).not.toMatch(/Roles?:/u);
  });

  it('keeps a role and its weight whole when the full box line runs past its box, dropping the summed time first', async () => {
    const heavy = makeParticipant({
      ...CONSUMER,
      count: 9087,
      totalDurationMs: 2100,
      maxDurationMs: 61,
    });
    const stub = resolvingProvider(makeGraph({ nodes: [heavy], edges: [] }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // "consumer · Σ 2.1 s · ×9,087" is wider than the box less its text
    // insets, so the box names the role and the weight whole — the count a
    // render question is about — rather than cutting the count off.
    const full = `consumer · Σ ${formatDurationCompact(2100)} · ×9,087`;
    expect(estimateTextWidth(full, DEFAULT_LABEL_FONT_SIZE)).toBeGreaterThan(
      DEFAULT_GRAPH_NODE_WIDTH - 2 * 4,
    );
    const meta = metaOfShape(CONSUMER.label);
    expect(meta).toBe('consumer · ×9,087');
    expect(estimateTextWidth(meta, DEFAULT_LABEL_FONT_SIZE)).toBeLessThanOrEqual(
      DEFAULT_GRAPH_NODE_WIDTH - 2 * 4,
    );

    // Nothing is lost: the title and the grid carry the summed time.
    expect(titleOfShape(shapeNamed(CONSUMER.label))).toContain(
      `Summed ${formatDurationCompact(2100)}`,
    );
    expect(within(rowNamed(CONSUMER.label)).getByRole('rowheader').textContent).toContain(
      'Records 9,087',
    );
  });

  it('cuts the full box line with an ellipsis only when no shorter whole line fits, keeping it whole in the title', async () => {
    const enormous = makeParticipant({
      ...CONSUMER,
      count: 1_000_000_000_000,
      totalDurationMs: 2100,
      maxDurationMs: 61,
    });
    const stub = resolvingProvider(makeGraph({ nodes: [enormous], edges: [] }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // Neither "consumer · ×1,000,000,000,000" nor the metrics alone fit, so the
    // full line is cut, never exceeding the box less its text insets.
    const meta = metaOfShape(CONSUMER.label);
    expect(meta.startsWith('consumer · ')).toBe(true);
    expect(meta.endsWith('…')).toBe(true);
    expect(estimateTextWidth(meta, DEFAULT_LABEL_FONT_SIZE)).toBeLessThanOrEqual(
      DEFAULT_GRAPH_NODE_WIDTH - 2 * 4,
    );
    expect(titleOfShape(shapeNamed(CONSUMER.label))).toContain('Records 1,000,000,000,000');
  });

  it('defines the three roles under the grid whenever a role is shown, and not otherwise', async () => {
    const cascade = resolvingProvider(cascadeGraph());
    const view = renderComponent(makeNode(), {
      provider: cascade.provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('grid');

    const note = screen.getByText(/^A trigger is a component whose own state changed/u);
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
    expect(note.textContent).toBe(
      'A trigger is a component whose own state changed, which started a render pass. A provider is a component that re-rendered above a context consumer in the same commit, which is where the changed context value came from. A consumer is a component that re-rendered because a context value it reads changed.',
    );
    view.unmount();

    renderComponent(makeNode(), {
      provider: resolvingProvider(chainGraph()).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('grid');
    expect(screen.queryByText(/^A trigger is a component/u)).toBeNull();
  });

  it('says on each chip why the callee rendered and which contexts changed', async () => {
    const stub = resolvingProvider(cascadeGraph());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // One reason accounting for every record: the word alone.
    expect(chipTo(TRIGGER.label, PROVIDER)).toBe(`→ ${PROVIDER.label} ×5 (props)`);
    // One reason for only some of them: the word and its count.
    expect(chipTo(TRIGGER.label, LEAF)).toBe(`→ ${LEAF.label} ×5 (mount 3)`);
    // Several reasons: each with its count, in the contract's order.
    expect(chipTo(CONSUMER.label, LEAF)).toBe(`→ ${LEAF.label} ×480 (props 240 · unchanged 240)`);
    // The contexts that changed, then how the relationship was known.
    expect(chipTo(PROVIDER.label, CONSUMER)).toBe(
      `→ ${CONSUMER.label} ×5 (context) (context: example.context) (inferred)`,
    );
    expect(screen.queryByText(/render reasons or contexts/u)).toBeNull();
  });

  it('lists render reasons in the order the telemetry vocabulary declares them', async () => {
    const everyReason = Object.fromEntries(
      DEPENDENCY_RENDER_REASONS.toReversed().map((reason) => [reason, 1]),
    ) as DependencyGraphEdge['renderTriggers'];
    const edge = makeEdge(TRIGGER.id, PROVIDER.id, {
      count: DEPENDENCY_RENDER_REASONS.length,
      renderTriggers: everyReason,
    });
    const stub = resolvingProvider(makeGraph({ nodes: [TRIGGER, PROVIDER], edges: [edge] }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(chipTo(TRIGGER.label, PROVIDER)).toBe(
      `→ ${PROVIDER.label} ×${String(DEPENDENCY_RENDER_REASONS.length)} (${DEPENDENCY_RENDER_REASONS.map((reason) => `${reason} 1`).join(' · ')})`,
    );
  });

  it('withholds render reasons or contexts that do not add up, and says so', async () => {
    const edges = [
      // More renders than the relationship stands for.
      makeEdge(INTERACTION.id, HANDLER.id, { count: 5, renderTriggers: { context: 7 } }),
      // A reason outside the vocabulary.
      makeEdge(HANDLER.id, REQUEST.id, {
        renderTriggers: { because: 1 } as unknown as DependencyGraphEdge['renderTriggers'],
      }),
      // A reason with no render behind it.
      makeEdge(REQUEST.id, ROUTE.id, { renderTriggers: { props: 0 } }),
      // A blank context label.
      makeEdge(ROUTE.id, DATASTORE.id, { count: 2, contexts: [' '] }),
    ];
    const stub = resolvingProvider(
      makeGraph({ nodes: [INTERACTION, HANDLER, REQUEST, ROUTE, DATASTORE], edges }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(chipTo(INTERACTION_LABEL, HANDLER)).toBe(`→ ${HANDLER_LABEL} ×5`);
    expect(chipTo(HANDLER_LABEL, REQUEST)).toBe(`→ ${REQUEST_LABEL}`);
    expect(chipTo(REQUEST_LABEL, ROUTE)).toBe(`→ ${ROUTE_LABEL}`);
    expect(chipTo(ROUTE_LABEL, DATASTORE)).toBe(`→ ${DATASTORE_LABEL} ×2`);

    const note = screen.getByText(/render reasons or contexts/u);
    expect(note.closest('.dg-dependency-graph__note')).not.toBeNull();
    expect(note.textContent).toBe(
      '4 relationships declared render reasons or contexts that do not match their records, which are not shown.',
    );
  });

  it('states a single relationship with an inconsistent render cause in the singular', async () => {
    const edge = makeEdge(INTERACTION.id, HANDLER.id, { renderTriggers: { state: 2 } });
    const stub = resolvingProvider(makeGraph({ nodes: [INTERACTION, HANDLER], edges: [edge] }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    expect(screen.getByText(/render reasons or contexts/u).textContent).toBe(
      '1 relationship declared render reasons or contexts that do not match its records, which are not shown.',
    );
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

  /**
   * The relationship of the real graph a chip stands for, by the id the chip
   * carries.
   *
   * @param graph The graph the aggregate built.
   * @param chip A relationship chip obtained from the grid.
   */
  function edgeWithId(graph: DependencyGraphData, chip: HTMLElement): DependencyGraphEdge {
    const edge = graph.edges.find(
      (candidate) => candidate.id === chip.getAttribute('data-edge-id'),
    );
    if (edge === undefined) {
      throw new Error('the chip names a relationship the aggregate did not build');
    }
    return edge;
  }

  /**
   * What a chip says about why its callee rendered and which contexts changed,
   * spelled out from what the aggregate declared on the relationship: nothing
   * when it declared nothing, one reason's word when it accounts for every
   * record, otherwise each reason and its count in the vocabulary's order,
   * then the contexts. An oracle written from the contract rather than read
   * back from the component, so the chips are checked against whatever the
   * aggregate records for these events.
   *
   * @param edge The relationship as the aggregate built it.
   */
  function renderCauseSuffixOf(edge: DependencyGraphEdge): string {
    const tallies = DEPENDENCY_RENDER_REASONS.flatMap((reason) => {
      const count = edge.renderTriggers?.[reason];
      return count === undefined ? [] : [{ reason, count }];
    });
    const [only] = tallies;
    const why =
      only === undefined
        ? ''
        : tallies.length === 1 && only.count === edge.count
          ? ` (${only.reason})`
          : ` (${tallies.map(({ reason, count }) => `${reason} ${formatCount(count)}`).join(' · ')})`;
    const contexts = edge.contexts ?? [];
    return contexts.length === 0 ? why : `${why} (context: ${contexts.join(', ')})`;
  }

  it('draws every participant class and span colour in a legend colour of its own', async () => {
    // One event of every kind the telemetry domain declares, each in a tier its
    // kind may be reported in and each the child of the one before, so every
    // kind reaches the real aggregate and the chain keeps every column short.
    const events: TelemetryEvent[] = [];
    for (const kind of TELEMETRY_KINDS) {
      const [tier] = KIND_ALLOWED_TIERS[kind];
      const parent = events.at(-1);
      events.push(
        capturedEvent({
          kind,
          name: `example.${kind}`,
          ...(tier === undefined ? {} : { tier }),
          ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
        }),
      );
    }

    const graph = buildDependencyGraph(events);
    expect(new Set(graph.nodes.flatMap((node) => node.spanKinds ?? []))).toEqual(
      new Set(TELEMETRY_KINDS),
    );

    const { container } = renderComponent(makeNode(), {
      provider: resolvingProvider(graph).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('grid');

    // Every participant is drawn in its own box, so every stroke is read.
    expect(nodeShapes()).toHaveLength(graph.nodes.length);

    const legend = legendOf(container);
    const chipColour = (chip: HTMLElement): string =>
      chip.style.getPropertyValue('--dgc-badge-color').trim();
    const chips = Array.from(legend.querySelectorAll<HTMLElement>('.dg-badge'));
    const colours = chips.map(chipColour);

    // No two key entries share a colour: a reader can tell every class and
    // every span-kind family apart by colour as well as by word. Every kind is
    // present, so the key holds span-colour entries beyond the six classes.
    expect(chips.length).toBeGreaterThan(KINDS.length);
    expect(colours.every((colour) => colour !== '')).toBe(true);
    expect(new Set(colours).size).toBe(colours.length);

    const classColours = new Map(
      Array.from(legend.querySelectorAll<HTMLElement>('[data-kind]')).map((chip) => [
        chip.getAttribute('data-kind') ?? '',
        chipColour(chip),
      ]),
    );
    expect([...classColours.keys()]).toEqual(KINDS);

    // A participant is stroked in its own class's colour, or in a span colour
    // the key names that belongs to no class: never in another class's colour.
    for (const shape of nodeShapes()) {
      const kind = KINDS.find((candidate) =>
        shape.classList.contains(`dg-dependency-graph__node--${candidate}`),
      );
      if (kind === undefined) {
        throw new Error('a participant box carries no class modifier');
      }
      if (!(shape instanceof SVGElement)) {
        throw new Error('a participant box is not an SVG element');
      }
      const stroke = shape.style.getPropertyValue('--dgc-node-color').trim();
      expect(colours).toContain(stroke);
      if (stroke !== classColours.get(kind)) {
        expect([...classColours.values()]).not.toContain(stroke);
      }
    }
  });

  it('selects, withholds and marks exactly what the real aggregate produced', async () => {
    // A page event that issued one request and reached one function twice; a
    // view update attributed to the settled request through an asynchronous
    // continuation rather than nested inside it.
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

    // The continuation-attributed relationship is chipped and drawn inferred.
    // Its one attribution had a single candidate — the event declares no
    // `lineageAmbiguous` — so it is NOT ambiguous: no curve is dashed. The
    // nested ones beside it are neither.
    const [inferredChip] = relationshipChips(rowNamed('GET /example/resource'));
    if (inferredChip === undefined) {
      throw new Error('the request participant rendered no relationship chip');
    }
    expect(inferredChip.textContent).toBe(
      `→ example.view${renderCauseSuffixOf(edgeWithId(graph, inferredChip))} (inferred)`,
    );
    expect(inferredChip.classList.contains('dg-is-inferred')).toBe(true);
    expect(inferredChip.classList.contains('dg-is-ambiguous')).toBe(false);

    for (const chip of relationshipChips(rowNamed('example.press'))) {
      expect(chip.classList.contains('dg-is-inferred')).toBe(false);
      expect(chip.classList.contains('dg-is-ambiguous')).toBe(false);
      expect(chip.textContent).not.toContain('inferred');
    }

    const inferredCurves = edgeCurves().filter((curve) =>
      curve.classList.contains('dg-is-inferred'),
    );
    expect(inferredCurves).toHaveLength(1);
    expect(
      edgeCurves().filter((curve) => curve.classList.contains('dg-is-ambiguous')),
    ).toHaveLength(0);
    expect(edgeCurves()).toHaveLength(graph.edges.length);

    // Everything the real aggregate declared passes the component's validation:
    // nothing is reported as inconsistent.
    expect(screen.queryByText(INCONSISTENT_COORDINATES_NOTE)).toBeNull();
    expect(screen.queryByText(/inconsistent inferred or ambiguous counts/i)).toBeNull();
  });

  it('dashes exactly the relationship the real aggregate counted as ambiguous', async () => {
    // Two parallel requests from one page event, and a view update attributed
    // to the second through an asynchronous continuation while the first still
    // had an open window: the producer flags the attribution ambiguous and
    // names the other candidate (see docs/ARCHITECTURE.md, "Async-continuation
    // lineage").
    const press = capturedEvent({ kind: 'interaction', name: 'example.press' });
    const first = capturedEvent({
      kind: 'fetch',
      name: 'GET /example/first',
      parentSpanId: press.spanId,
    });
    const second = capturedEvent({
      kind: 'fetch',
      name: 'GET /example/second',
      parentSpanId: press.spanId,
    });
    const update = capturedEvent({
      kind: 'render',
      name: 'example.view',
      parentSpanId: second.spanId,
      attributes: {
        lineage: 'async-continuation',
        lineageAmbiguous: true,
        lineageCandidates: [first.spanId],
      },
    });

    const graph = buildDependencyGraph([press, first, second, update]);
    const stub = resolvingProvider(graph);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    const [ambiguousChip] = relationshipChips(rowNamed('GET /example/second'));
    if (ambiguousChip === undefined) {
      throw new Error('the chosen request rendered no relationship chip');
    }
    expect(ambiguousChip.textContent).toBe(
      `→ example.view${renderCauseSuffixOf(edgeWithId(graph, ambiguousChip))} (inferred, 1 ambiguous)`,
    );
    expect(ambiguousChip.classList.contains('dg-is-ambiguous')).toBe(true);
    expect(ambiguousChip.classList.contains('dg-is-inferred')).toBe(false);
    expect(ambiguousChip.classList.contains('dg-badge--warning')).toBe(true);

    // One ambiguous curve, and no merely inferred one: the attribution's
    // ambiguity is the whole of how that relationship was known.
    expect(
      edgeCurves().filter((curve) => curve.classList.contains('dg-is-ambiguous')),
    ).toHaveLength(1);
    expect(edgeCurves().filter((curve) => curve.classList.contains('dg-is-inferred'))).toHaveLength(
      0,
    );
    expect(screen.queryByText(/inconsistent inferred or ambiguous counts/i)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The lineage states and the relationship chip, as the stylesheet paints them
 *
 * The cases above pin the classes the component writes; these pin what the
 * stylesheet does with them, because the distinction the classes carry — an
 * inferred relationship solid, an ambiguous one dashed, a chip that wraps —
 * exists only once a rule implements it, and happy-dom applies no stylesheet.
 * ---------------------------------------------------------------------------
 */

describe('DependencyGraph lineage styling', () => {
  /**
   * The component stylesheet, read from disk with the `import.meta.url`
   * convention `../tokens/tokens.test.ts` documents. Joined with `node:path`
   * rather than resolved with `new URL(…)`: under happy-dom the global `URL` is
   * the DOM's, which Node's `fileURLToPath` rejects.
   */
  const stylesheet = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'components.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//gu, '');

  /**
   * Every declaration the stylesheet makes for one exact selector, in source
   * order, gathered from each rule whose selector list names it — so a grouped
   * rule and a rule of its own both count.
   *
   * @param selector One compound selector, exactly as written.
   * @returns Its declarations, normalised to `property: value`.
   */
  function declarationsOf(selector: string): string[] {
    const declarations: string[] = [];
    for (const [, selectors = '', body = ''] of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (selectors.split(',').some((part) => part.trim() === selector)) {
        declarations.push(
          ...body
            .split(';')
            .map((declaration) => declaration.replace(/\s+/gu, ' ').trim())
            .filter((declaration) => declaration !== ''),
        );
      }
    }

    return declarations;
  }

  it('draws an inferred curve solid in the info tone and an ambiguous one dashed in the warning tone', () => {
    const inferred = declarationsOf('.dg-dependency-graph__edge.dg-is-inferred');
    expect(inferred).toContain('stroke: var(--dg-info)');
    expect(inferred.some((declaration) => declaration.startsWith('stroke-dasharray'))).toBe(false);

    const ambiguous = declarationsOf('.dg-dependency-graph__edge.dg-is-ambiguous');
    expect(ambiguous).toContain('stroke: var(--dg-warning)');
    expect(ambiguous).toContain('stroke-dasharray: var(--dg-stroke-dash-dashed)');

    // The measured curve keeps the connector token alone, which the token
    // suite measures in every theme.
    expect(
      declarationsOf('.dg-dependency-graph__edge').filter((declaration) =>
        declaration.startsWith('stroke:'),
      ),
    ).toEqual(['stroke: var(--dg-graph-edge)']);
  });

  it('lets a relationship chip wrap inside its cell, and dashes an ambiguous one', () => {
    const chip = declarationsOf('.dg-dependency-graph__relationship');
    expect(chip).toContain('white-space: normal');
    expect(chip).toContain('overflow-wrap: anywhere');
    expect(chip).toContain('min-inline-size: 0');

    expect(declarationsOf('.dg-dependency-graph__relationship.dg-is-ambiguous')).toContain(
      'border-style: dashed',
    );

    // Declared after the shared chip rule, whose `white-space: nowrap` it has
    // to override at equal specificity.
    expect(stylesheet.indexOf('\n.dg-dependency-graph__relationship {')).toBeGreaterThan(
      stylesheet.indexOf('\n.dg-badge,'),
    );
  });

  it('wraps a participant label anywhere rather than truncating it', () => {
    const label = declarationsOf('.dg-dependency-graph__participant-label');
    expect(label).toContain('overflow-wrap: anywhere');
    expect(label).toContain('min-inline-size: 0');
    expect(label.some((declaration) => declaration.startsWith('white-space'))).toBe(false);
    expect(label.some((declaration) => declaration.startsWith('text-overflow'))).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The shared selection
 *
 * Under a panel host the selected participant is resolved from the host's one
 * selection: the participant whose validated coordinate matches it is marked,
 * and a participant with no coordinate is highlighted locally only until that
 * selection changes. The last case mounts a flame chart over the same capture
 * beside the graph, under the smallest host that records each report as the
 * selection, so the two charts can be seen to agree.
 * ---------------------------------------------------------------------------
 */

/**
 * The host contexts around `children`, the selection context included.
 *
 * @param children The views to mount.
 * @param selection The selection the host provides.
 * @param context The provider to resolve queries and the actions to report to.
 * @returns The element tree to render.
 */
function hostedTree(
  children: ReactNode,
  selection: PanelSelectionState,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): ReactElement {
  return (
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <PanelSelectionContext.Provider value={selection}>
            {children}
          </PanelSelectionContext.Provider>
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>
  );
}

/** The props of {@link SelectionHost}. */
interface SelectionHostProps {
  /** The provider that resolves every view's query. */
  readonly provider: DataProvider;
  /** The spies each report is forwarded to after it is recorded. */
  readonly spies: ActionSpies;
  /** The views sharing the selection. */
  readonly children: ReactNode;
}

/**
 * The smallest host that shares a selection: it records every reported event
 * as the current selection and provides it back to every view beneath — the
 * wiring `PanelHost` performs around a panel's layout.
 *
 * @param props See {@link SelectionHostProps}.
 * @returns The hosted views.
 */
function SelectionHost(props: SelectionHostProps): ReactElement {
  const { provider, spies, children } = props;
  const [selection, setSelection] = useState<PanelSelection | undefined>(undefined);

  const actions = useMemo<PanelActions>(
    () => ({
      onSelectEvent: (ref: PanelEventRef) => {
        setSelection(ref);
        spies.onSelectEvent(ref);
      },
      onOpenSource: spies.onOpenSource,
    }),
    [spies],
  );
  const state = useMemo<PanelSelectionState>(() => ({ selection }), [selection]);

  return hostedTree(children, state, { provider, actions });
}

/** The labels of the grid rows carrying `aria-selected="true"`, in document order. */
function selectedRowLabels(): string[] {
  return dataRows()
    .filter((row) => row.getAttribute('aria-selected') === 'true')
    .map(participantLabelOf);
}

/** The labels drawn in the canvas shapes carrying the selected state, in document order. */
function selectedShapeLabels(scope: HTMLElement): string[] {
  const picture = within(scope).getByRole('img');
  const labels = Array.from(picture.querySelectorAll('text.dg-dependency-graph__node-label'));

  return Array.from(picture.querySelectorAll('rect.dg-dependency-graph__node')).flatMap(
    (shape, index) =>
      shape.classList.contains('dg-is-selected') ? [labels[index]?.textContent ?? ''] : [],
  );
}

/** A rendered block by its documented class, failing when it is not on the page. */
function blockOf(className: string): HTMLElement {
  const block = document.querySelector<HTMLElement>(`.${className}`);

  if (block === null) {
    throw new Error(`no .${className} block is rendered`);
  }

  return block;
}

describe('DependencyGraph shared selection', () => {
  /** The handler, declaring the coordinate of the one record it collapsed. */
  const ENRICHED_HANDLER = makeParticipant({ ...HANDLER, eventId: EVENT_ID, traceId: TRACE_ID });

  /** Three participants: one with an event coordinate between two without. */
  function mixedGraph(): DependencyGraphData {
    return makeGraph({
      nodes: [INTERACTION, ENRICHED_HANDLER, REQUEST],
      edges: [makeEdge(INTERACTION.id, HANDLER.id), makeEdge(HANDLER.id, REQUEST.id)],
    });
  }

  it('marks the participant whose coordinate the panel selection names, and nothing else', async () => {
    const stub = resolvingProvider(mixedGraph());
    const context = { provider: stub.provider, actions: makeActions().actions };

    const { rerender, container } = render(
      hostedTree(
        <DependencyGraph node={makeNode()} />,
        { selection: { eventId: EVENT_ID } },
        context,
      ),
    );
    await screen.findByRole('grid');

    expect(selectedRowLabels()).toEqual([HANDLER_LABEL]);
    expect(selectedShapeLabels(container)).toEqual([HANDLER_LABEL]);

    // Another record's id naming the participant's trace and its one span still
    // lands on it: that pair is the span's identity across tiers.
    rerender(
      hostedTree(
        <DependencyGraph node={makeNode()} />,
        {
          selection: {
            eventId: 'event-example-elsewhere',
            traceId: TRACE_ID,
            spanId: spanIdFor(2),
          },
        },
        context,
      ),
    );
    expect(selectedRowLabels()).toEqual([HANDLER_LABEL]);

    // An event this graph draws no participant for marks nothing here.
    rerender(
      hostedTree(
        <DependencyGraph node={makeNode()} />,
        { selection: { eventId: 'event-example-elsewhere' } },
        context,
      ),
    );
    expect(selectedRowLabels()).toEqual([]);
    expect(selectedShapeLabels(container)).toEqual([]);
  });

  it('highlights a participant with no event locally, and gives way the moment the panel selection changes', async () => {
    const stub = resolvingProvider(mixedGraph());
    const spies = makeActions();
    const context = { provider: stub.provider, actions: spies.actions };
    const user = userEvent.setup();
    const graph = <DependencyGraph node={makeNode()} />;

    const { rerender, container } = render(hostedTree(graph, { selection: undefined }, context));
    await screen.findByRole('grid');

    // No coordinate, so nothing is reported, yet the reader sees where they aimed.
    await user.click(rowNamed(REQUEST_LABEL));
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(selectedRowLabels()).toEqual([REQUEST_LABEL]);
    expect(selectedShapeLabels(container)).toEqual([REQUEST_LABEL]);

    // A re-rendered host holding the same selection is not a change.
    rerender(hostedTree(graph, { selection: undefined }, context));
    expect(selectedRowLabels()).toEqual([REQUEST_LABEL]);

    // Another view selects the handler's event: the local highlight yields.
    const handlerSelected: PanelSelectionState = { selection: { eventId: EVENT_ID } };
    rerender(hostedTree(graph, handlerSelected, context));
    expect(selectedRowLabels()).toEqual([HANDLER_LABEL]);
    expect(selectedShapeLabels(container)).toEqual([HANDLER_LABEL]);

    // Highlighted again, then another view selects an event this graph does not
    // draw: nothing is left marked, rather than a participant the other charts
    // have moved on from.
    await user.click(rowNamed(REQUEST_LABEL));
    expect(selectedRowLabels()).toEqual([REQUEST_LABEL]);

    rerender(hostedTree(graph, { selection: { eventId: 'event-example-elsewhere' } }, context));
    expect(selectedRowLabels()).toEqual([]);

    // Activating the participant that carries a coordinate drops the local
    // highlight even when its event is the one already selected.
    rerender(hostedTree(graph, handlerSelected, context));
    await user.click(rowNamed(REQUEST_LABEL));
    expect(selectedRowLabels()).toEqual([REQUEST_LABEL]);

    await user.click(rowNamed(HANDLER_LABEL));
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      spanId: spanIdFor(2),
      traceId: TRACE_ID,
    });
    expect(selectedRowLabels()).toEqual([HANDLER_LABEL]);
  });

  it('mirrors a selection made in the graph or a flame chart over the same capture, under one host', async () => {
    // One interaction that issued a request and ran one function twice, as the
    // capture records them; both charts are derived from these same events by
    // the real aggregate and the real correlator.
    const base = {
      traceId: TRACE_ID,
      tier: 'browser',
      attributes: {},
      status: 'ok',
      producerId: 'producer-example',
      sessionId: 'session-example',
      captureId: 'capture-example',
    } as const;
    const press: TelemetryEvent = {
      ...base,
      id: 'event-example-0201',
      spanId: spanIdFor(0x201),
      kind: 'interaction',
      name: 'example.press',
      startTime: 1_700_000_000_000,
      duration: 90,
      seq: 1,
      ingestSeq: 1,
    };
    const request: TelemetryEvent = {
      ...base,
      id: 'event-example-0202',
      spanId: spanIdFor(0x202),
      parentSpanId: press.spanId,
      kind: 'fetch',
      name: 'GET /example/resource',
      startTime: 1_700_000_000_004,
      duration: 60,
      seq: 2,
      ingestSeq: 2,
    };
    const work = [3, 4].map<TelemetryEvent>((ordinal) => ({
      ...base,
      id: `event-example-020${String(ordinal)}`,
      spanId: spanIdFor(0x200 + ordinal),
      parentSpanId: press.spanId,
      kind: 'function',
      name: 'example.work',
      startTime: 1_700_000_000_000 + ordinal * 10,
      duration: 5,
      seq: ordinal,
      ingestSeq: ordinal,
    }));
    const events = [press, request, ...work];

    const tree = correlateTrace(events, TRACE_ID);
    if (tree === undefined) {
      throw new Error('the correlator produced no trace for the fixture events');
    }
    const graph = buildDependencyGraph(events);

    const stub = recordingProvider((query) =>
      Promise.resolve<DataQueryResponse>(
        query.source === 'graph'
          ? { source: 'graph', data: graph }
          : { source: 'trace', data: tree },
      ),
    );
    const spies = makeActions();
    const user = userEvent.setup();
    const flame: FlameNode = {
      type: 'flame',
      id: 'layout.1.flame',
      query: { source: 'trace', filter: { traceId: TRACE_ID } },
    };

    render(
      <SelectionHost provider={stub.provider} spies={spies}>
        <DependencyGraph node={makeNode()} />
        <FlameChart node={flame} />
      </SelectionHost>,
    );

    // Both canvases are drawn: the graph's picture, and the flame chart's
    // figure, whose frames are named images of their own.
    await screen.findByRole('figure');
    expect(
      (await screen.findAllByRole('img')).filter((element) => element instanceof SVGSVGElement),
    ).toHaveLength(1);
    await screen.findByRole('grid');
    await screen.findByRole('tree');

    const flameBlock = blockOf('dg-flame');
    const flameRow = (name: string): HTMLElement => {
      const row = within(flameBlock)
        .getAllByRole('treeitem')
        .find((candidate) => within(candidate).queryByRole('button', { name }) !== null);
      if (row === undefined) {
        throw new Error(`the flame chart lists no frame named "${name}"`);
      }
      return row;
    };
    const graphBlock = blockOf('dg-dependency-graph');

    // A frame selected in the flame chart marks the participant that stands for
    // that one record, in the grid and on the canvas.
    await user.click(within(flameRow(request.name)).getByRole('button', { name: request.name }));

    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: request.id,
      spanId: request.spanId,
      traceId: request.traceId,
    });
    expect(selectedRowLabels()).toEqual([request.name]);
    expect(selectedShapeLabels(graphBlock)).toEqual([request.name]);

    // A participant selected in the graph marks its frame in the flame chart.
    await user.click(rowNamed(press.name));

    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: press.id,
      spanId: press.spanId,
      traceId: press.traceId,
    });
    expect(flameRow(press.name).classList.contains('dg-is-selected')).toBe(true);
    expect(flameRow(request.name).classList.contains('dg-is-selected')).toBe(false);
    expect(selectedRowLabels()).toEqual([press.name]);

    // The collapse of two records is highlighted in the graph alone, and gives
    // way as soon as the flame chart selects another span.
    await user.click(rowNamed('example.work'));
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(2);
    expect(selectedRowLabels()).toEqual(['example.work']);

    await user.click(within(flameRow(request.name)).getByRole('button', { name: request.name }));
    expect(selectedRowLabels()).toEqual([request.name]);
    expect(selectedShapeLabels(graphBlock)).toEqual([request.name]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The hover highlight, focus, and their dismissal (WCAG 1.4.13)
 *
 * A box's SVG title is the user agent's tooltip, so nothing it says may be
 * reachable by hover alone: every grid row shows its participant's full detail
 * in one form, whatever holds focus or the pointer (see the participant detail
 * cases). Neither hovering a box nor focusing a row therefore reveals anything
 * in the grid. The one preview is the hovered box's own highlight on the
 * canvas: Escape dismisses it without moving the pointer or focus, and leaves
 * the selection and every row alone.
 * ---------------------------------------------------------------------------
 */

/** The chain's labels in the order {@link CHAIN_PARTICIPANTS} lists them. */
const CHAIN_PARTICIPANT_LABELS: readonly string[] = CHAIN_PARTICIPANTS.map((node) => node.label);

/**
 * The label element of a row whose participant cell carries the detail — the
 * label outside any tooltip, with the tier and the metrics after it — or
 * `null` when the cell does not.
 *
 * @param row A row obtained by role.
 * @param node The participant it stands for.
 */
function inlineDetailLabelOf(row: HTMLElement, node: DependencyGraphNode): HTMLElement | null {
  const label = participantLabelElementOf(row);
  const header = within(row).getByRole('rowheader');
  const tier = node.tier === undefined ? '' : `${formatTierLabel(node.tier)} · `;
  const text = header.textContent ?? '';
  const detail = `${tier}Records ${String(node.count)}`;
  const carriesDetail =
    label.closest('.dg-tooltip') === null &&
    text.startsWith(node.label) &&
    text.slice(node.label.length).replace(/^ · /, '').startsWith(detail);

  return carriesDetail ? label : null;
}

/**
 * Whether a row shows its participant's detail inline, in the cell's one form:
 * the label untruncated — neither itself nor any run around it ellipsizes —
 * with the detail after it.
 *
 * @param row A row obtained by role.
 * @param node The participant it stands for.
 */
function showsInlineDetail(row: HTMLElement, node: DependencyGraphNode): boolean {
  const label = inlineDetailLabelOf(row, node);

  return label !== null && label.closest('.dg-text--truncate') === null;
}

/** The labels of the rows showing their detail inline, among the chain's participants. */
function inlineDetailLabels(): string[] {
  return CHAIN_PARTICIPANTS.filter((node) => showsInlineDetail(rowNamed(node.label), node)).map(
    (node) => node.label,
  );
}

/**
 * Every data row's participant cell, as its markup, in document order: the
 * cell a focus- or hover-driven form would change, read so that a changed
 * element, class, attribute or text anywhere in it fails the comparison.
 */
function participantCellMarkup(): string[] {
  return dataRows().map((row) => within(row).getByRole('rowheader').innerHTML);
}

/** The labels of the canvas shapes carrying the hovered state, in document order. */
function hoveredShapeLabels(): string[] {
  const labels = canvasLabels();

  return nodeShapes().flatMap((shape, index) =>
    shape.classList.contains('dg-is-hovered') ? [labels[index] ?? ''] : [],
  );
}

describe('DependencyGraph hover and focus detail dismissal', () => {
  it('highlights a hovered box on the canvas alone, and Escape dismisses it without moving the pointer', async () => {
    const stub = resolvingProvider(chainGraph());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    // At rest every row already carries its detail, and nothing is hovered.
    const before = participantCellMarkup();
    expect(inlineDetailLabels()).toEqual(CHAIN_PARTICIPANT_LABELS);
    expect(hoveredShapeLabels()).toEqual([]);

    // The box under the pointer is marked; the grid does not answer the
    // pointer, so no row changes form or size.
    await user.hover(shapeNamed(ROUTE_LABEL));
    expect(shapeNamed(ROUTE_LABEL).classList.contains('dg-is-hovered')).toBe(true);
    expect(hoveredShapeLabels()).toEqual([ROUTE_LABEL]);
    expect(participantCellMarkup()).toEqual(before);

    // The pointer moves no focus, so the key arrives at the page body. It
    // dismisses the box's hover state, changes no row, and is not consumed.
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
    expect(shapeNamed(ROUTE_LABEL).classList.contains('dg-is-hovered')).toBe(false);
    expect(hoveredShapeLabels()).toEqual([]);
    expect(participantCellMarkup()).toEqual(before);

    // The next box the pointer enters is marked, and leaving ends it.
    await user.hover(shapeNamed(REQUEST_LABEL));
    expect(hoveredShapeLabels()).toEqual([REQUEST_LABEL]);

    await user.unhover(shapeNamed(REQUEST_LABEL));
    expect(hoveredShapeLabels()).toEqual([]);
    expect(nodeShapes().filter((shape) => shape.classList.contains('dg-is-hovered'))).toHaveLength(
      0,
    );
    expect(participantCellMarkup()).toEqual(before);
  });

  it('leaves a focused row and the selection alone on Escape, and dismisses only a hovered box', async () => {
    const stub = resolvingProvider(chainGraph());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    await user.tab();
    const [first, second] = dataRows();
    if (first === undefined || second === undefined) {
      throw new Error('the grid rendered fewer than two data rows');
    }

    expect(document.activeElement).toBe(first);
    const before = participantCellMarkup();
    expect(inlineDetailLabels()).toEqual(CHAIN_PARTICIPANT_LABELS);

    // Focus previews nothing, so an Escape on the row has nothing of this
    // view's to dismiss: it is left unconsumed, focus stays on the row and the
    // row keeps its detail.
    expect(fireEvent.keyDown(first, { key: 'Escape' })).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(participantCellMarkup()).toEqual(before);

    // Focus moving on changes no row either.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(second);
    expect(participantCellMarkup()).toEqual(before);

    // A selection made from the keyboard, then a box hovered while the row
    // keeps focus: Escape on the row dismisses the highlight and nothing else.
    await user.keyboard('{Enter}');
    expect(rowNamed(HANDLER_LABEL).getAttribute('aria-selected')).toBe('true');

    await user.hover(shapeNamed(ROUTE_LABEL));
    expect(hoveredShapeLabels()).toEqual([ROUTE_LABEL]);

    expect(fireEvent.keyDown(second, { key: 'Escape' })).toBe(true);
    expect(hoveredShapeLabels()).toEqual([]);
    expect(document.activeElement).toBe(second);
    expect(participantCellMarkup()).toEqual(before);
    expect(rowNamed(HANDLER_LABEL).getAttribute('aria-selected')).toBe('true');
    expect(shapeNamed(HANDLER_LABEL).classList.contains('dg-is-selected')).toBe(true);
  });

  it("keeps the focused row's full form when the pointer rests on that row's box", async () => {
    const stub = resolvingProvider(chainGraph());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('grid');

    await user.tab();
    expect(document.activeElement).toBe(dataRows()[0]);
    const before = participantCellMarkup();
    expect(inlineDetailLabels()).toEqual(CHAIN_PARTICIPANT_LABELS);

    // The keyboard user's form is never taken away by a pointer: the box under
    // the pointer is marked, its row keeps its form.
    await user.hover(shapeNamed(INTERACTION_LABEL));
    expect(shapeNamed(INTERACTION_LABEL).classList.contains('dg-is-hovered')).toBe(true);
    expect(participantCellMarkup()).toEqual(before);

    // Another box under the pointer leaves every row, the focused one included,
    // exactly as it was.
    await user.hover(shapeNamed(ROUTE_LABEL));
    expect(hoveredShapeLabels()).toEqual([ROUTE_LABEL]);
    expect(inlineDetailLabels()).toEqual(CHAIN_PARTICIPANT_LABELS);
    expect(participantCellMarkup()).toEqual(before);
  });
});
