/**
 * `components/Timeline` — the colocated suite for the product's most important
 * visualization.
 *
 * ## What this suite is protecting
 *
 * The `timeline` node is the one view that shows the whole correlated shape of
 * an interaction at once: the click, the request it made, the server span that
 * answered it and the datastore call underneath, on one axis, in lanes by tier
 * (AAP 0.4.2, 0.6.2). `tests/e2e/demo-slow-interaction.spec.ts` proves that
 * chain end to end against a running application; this suite is the fast
 * feedback loop for the *rendering* half of the same story, and it is deliberately
 * more than a smoke test:
 *
 *   - **Both payload shapes.** The catalog lets this node read either the
 *     correlated `trace` tree or a flat page of `spans`, and the component
 *     branches on the QUERY'S source rather than on the payload's shape. Two
 *     cases drive the two branches with the same component, so neither path can
 *     be the one that was written and the other the one that was assumed.
 *   - **Correlation honesty.** A guessed relationship must never read as a
 *     measured one and captured work must never be dropped. The ambiguous-lineage
 *     case asserts the dashed edge, the row's flag and the alternative candidate
 *     span ids; the orphan case asserts that a re-attached node is drawn, flagged,
 *     and counted — the rendered row count equals the tree's own `nodeCount`.
 *   - **Partial results say so.** A `spans` page states how much of the result it
 *     holds and offers to load more; a `trace` the correlator truncated says that
 *     instead of implying completeness.
 *   - **Paging follows the service.** Each further page is requested at the
 *     `nextOffset` the previous response named, at the same page size, and
 *     appended with each record once; the loaded rows stay on screen while a
 *     page is in flight or after it failed, a next offset past 5,000 is still
 *     followed, a response naming none ends the walk whatever its total says,
 *     and a changed query starts again from its first page.
 *   - **The canvas is not the only representation.** The SVG is `role="img"` with
 *     a text alternative, so its bars are deliberately outside the accessibility
 *     tree; the keyboard-reachable equivalent below it must therefore list every
 *     row and be operable (AAP 0.6.4).
 *   - **Descriptions are not hover-only.** The focused row drives the detail
 *     strip, whose name is a focusable tooltip trigger, and the focused row's
 *     own name is one Tab away — in that row only, so the table body does not
 *     grow a tab stop per row.
 *   - **The three states of a query-backed view** and the **click-to-source
 *     payload** that AAP 0.8.3 asks of every component suite in this folder.
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`, and `afterEach(cleanup)`
 *     registered explicitly, even though the `panel-renderer` project enables
 *     globals for `@testing-library/react`'s automatic cleanup.
 *   - **Stub providers built with the library's own `createDataProvider`**, so
 *     these cases exercise the seam the DevTools panel and the editor webview
 *     implement. The resolver is a `vi.fn` and every query it receives is
 *     recorded: what the component *asked for* is as much of its contract as what
 *     it drew.
 *   - **In-file synthetic builders, no fixture files.** {@link makeEvent},
 *     {@link makeTraceNode}, {@link makeTree} and {@link makeNode} take overrides.
 *     The correlated trees are **hand-constructed**: `@debuggen/telemetry` is a
 *     type-only dependency of this package (AAP 0.2.2), so neither the component
 *     nor this suite may reach for its builders, and a fixture assembled by the
 *     very code under discussion would prove less.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): span names, a file path and
 *     a symbol belonging to no application, demonstration or otherwise — in the
 *     fixtures and in the comments alike.
 *   - **Nothing about layout is stubbed.** No `getBoundingClientRect` override and
 *     no `ResizeObserver` polyfill: the canvas is a fixed logical `viewBox` scaled
 *     by CSS, so an environment with no layout draws exactly what a browser draws.
 *     A case that needed such a stub would be reporting a measurement dependency
 *     in the component, to be removed rather than accommodated.
 *   - **Queries by role and accessible name.** The canvas, the grid, its rows, the
 *     chips, the tooltips and the footer control are all reached that way; a class
 *     is read only off an element already obtained semantically, since no
 *     `jest-dom` matcher is available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…`, and interactions through
 *     `userEvent`.
 *
 * @see ./Timeline for the component, its four states and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../utils/scale for the children-only trace walk the trace branch uses.
 */

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import type { DataQuery, TimelineNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type {
  OrphanReason,
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
  TraceNode,
  TraceNodeLineage,
  TraceTree,
} from '@debuggen/telemetry';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import { kindColorVar, tierColorVar } from '../utils/color';
import {
  KIND_LABELS,
  NOT_AVAILABLE_LABEL,
  TIER_LABELS,
  formatCount,
  formatDuration,
  formatDurationCompact,
  formatKindLabel,
  formatOffset,
  formatTierLabel,
} from '../utils/format';
import { Timeline } from './Timeline';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral (AAP 0.5.4): no component, route,
 * service or symbol of any inspected project appears here. The identifiers are
 * shaped as a capture shapes them — a 32-hex trace id, 16-hex span ids, epoch
 * millisecond start times and millisecond durations — because the component
 * reads exactly those fields and formats them.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every node below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'b7c1d2e3f4051627384950a6b7c8d9e0';

/** The fixture session and capture the persisted events are attributed to. */
const SESSION_ID = 'session-example-0001';
const CAPTURE_ID = 'capture-example-0001';

/**
 * The two producers of a cross-tier trace: the page agent and the dev-server
 * preload.
 *
 * Two of them rather than one because that is the shape of the evidence this
 * view exists to show — a trace whose browser and server halves were reported by
 * different processes — and because `producerId` is part of the canonical
 * ordering of a flat page.
 */
const BROWSER_PRODUCER_ID = 'producer-example-browser';
const SERVER_PRODUCER_ID = 'producer-example-server';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Inside the window the event schema accepts, and far enough from zero that a
 * relative performance timestamp could not be mistaken for one.
 */
const BASE_START_MS = 1_767_225_600_000;

/** A project-relative, POSIX path for the one node that resolved to source. */
const SOURCE_FILE = 'src/example/service.ts';

/** The symbol at that location. */
const SOURCE_SYMBOL = 'runExample';

/** Its 1-based coordinates. */
const SOURCE_LINE = 84;
const SOURCE_COLUMN = 9;

/** A complete, resolved location for the source-chip case. */
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
const NODE_ID = 'layout.0.timeline';

/** The footer control that asks for a wider page. */
const LOAD_MORE_NAME = 'Load more spans';

/** The error state's retry control. */
const RETRY_NAME = 'Retry';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/** The flag the equivalent row carries for a node the correlator re-attached. */
const REATTACHED_FLAG = 'Re-attached';

/** The flag it carries when more than one parent was possible. */
const AMBIGUOUS_FLAG = 'Ambiguous parent';

/** The attribution mechanism a continuation window records, verbatim. */
const ASYNC_CONTINUATION = 'async-continuation';

/** The orphan reason the fixtures use: the named parent never arrived. */
const MISSING_PARENT: OrphanReason = 'missing-parent';

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/**
 * The optional fields of an event admit `undefined` explicitly, which `Partial`
 * does not under this repository's `exactOptionalPropertyTypes`: passing
 * `{ source: undefined }` is how a case asks for a node *without* a location, and
 * {@link makeEvent} drops the key rather than storing the value.
 */
type EventOverrides = Partial<
  Pick<
    TelemetryEvent,
    | 'id'
    | 'traceId'
    | 'spanId'
    | 'kind'
    | 'name'
    | 'startTime'
    | 'duration'
    | 'tier'
    | 'status'
    | 'producerId'
    | 'seq'
    | 'ingestSeq'
  >
> & {
  readonly parentSpanId?: string | undefined;
  readonly source?: SourceLocation | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
};

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/**
 * One persisted span record for a bar and its row to draw.
 *
 * Complete and schema-shaped by construction: a 32-hex `traceId`, a 16-hex
 * `spanId`, an epoch-millisecond `startTime`, a millisecond `duration`, and a
 * `kind`/`tier` pair the event schema's cross-field rule permits (`interaction`
 * and `fetch` on `browser`, `http.server` on `server`, `db.query` on `db`).
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh event; nothing is shared between calls.
 */
function makeEvent(overrides: EventOverrides = {}): TelemetryEvent {
  const {
    id = 'event-example-0001',
    traceId = TRACE_ID,
    spanId = spanIdFor(1),
    parentSpanId,
    kind = 'interaction',
    name = 'example.interaction',
    startTime = BASE_START_MS,
    duration = 12,
    tier = 'browser',
    status = 'ok',
    producerId = BROWSER_PRODUCER_ID,
    seq = 0,
    ingestSeq = 1,
    attributes = {},
    source,
  } = overrides;

  return {
    id,
    traceId,
    spanId,
    kind,
    name,
    startTime,
    duration,
    tier,
    attributes: { ...attributes },
    status,
    producerId,
    seq,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    ...(source === undefined ? {} : { source }),
  };
}

/** What {@link makeTraceNode} accepts beyond the event it wraps. */
interface TraceNodeOverrides {
  /** The events this one caused, already in canonical order. */
  readonly children?: readonly TraceNode[] | undefined;
  /** Distance from the trace root; `0` at a root. */
  readonly depth?: number | undefined;
  /** Whether the correlator had to re-attach this node rather than place it. */
  readonly orphaned?: boolean | undefined;
  /** Why it had to; only meaningful together with `orphaned`. */
  readonly orphanReason?: OrphanReason | undefined;
  /** The parent this node named and the correlator could not resolve. */
  readonly missingParentSpanId?: string | undefined;
  /** How the node joined its trace, when it crossed an asynchronous boundary. */
  readonly lineage?: TraceNodeLineage | undefined;
}

/**
 * One node of a correlated trace, hand-built.
 *
 * A trace node carries no parent pointer by design — a cyclic object is not JSON
 * and the tree crosses an HTTP response — so a fixture is written outside-in and
 * the optional flags are omitted rather than set to `undefined`, which is what
 * the node's own declaration (`orphanReason?: OrphanReason`) requires.
 *
 * @param event The captured event this node represents.
 * @param overrides Its children, depth and correlation flags.
 * @returns A fresh node.
 */
function makeTraceNode(event: TelemetryEvent, overrides: TraceNodeOverrides = {}): TraceNode {
  const {
    children = [],
    depth = 0,
    orphaned = false,
    orphanReason,
    missingParentSpanId,
    lineage,
  } = overrides;

  return {
    event,
    children,
    depth,
    orphaned,
    ...(orphanReason === undefined ? {} : { orphanReason }),
    ...(missingParentSpanId === undefined ? {} : { missingParentSpanId }),
    ...(lineage === undefined ? {} : { lineage }),
  };
}

/** The correlator's own observations about its input, which a fixture may state. */
interface TreeOverrides {
  /** Span ids the correlator saw more than once; empty in the normal case. */
  readonly duplicateSpanIds?: readonly string[] | undefined;
  /** Whether the correlator stopped short of including everything it was given. */
  readonly truncated?: boolean | undefined;
}

/** Every node of a tree, depth-first, children-only — the walk a fixture needs. */
function flattenFixture(roots: readonly TraceNode[]): readonly TraceNode[] {
  const collected: TraceNode[] = [];

  const visit = (node: TraceNode): void => {
    collected.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };

  for (const root of roots) {
    visit(root);
  }

  return collected;
}

/**
 * The position of a vocabulary member in its declaration order.
 *
 * The correlated tree reports its tiers and kinds in the telemetry package's own
 * declaration order, and the two label tables in `../utils/format` are written in
 * that order and documented as mirroring it — so the order is read off them
 * rather than restated here, where it could drift.
 *
 * @param table A total label table keyed by the vocabulary.
 * @param key One member of it.
 * @returns Its index in the table's key order.
 */
function orderIndex<Key extends string>(table: Readonly<Record<Key, string>>, key: Key): number {
  return Object.keys(table).indexOf(key);
}

/**
 * A correlated trace whose tree-level fields are derived from its own nodes.
 *
 * Derived rather than passed in, because every one of them is a statement about
 * the nodes: a fixture claiming four nodes while holding three would be testing
 * the component against a tree the correlator could not produce. Only the two
 * facts a tree's nodes cannot carry — the duplicate span ids the correlator saw
 * and whether it truncated its input — are accepted as overrides.
 *
 * @param roots The roots, in canonical order.
 * @param overrides The correlator's own observations.
 * @returns A consistent tree.
 */
function makeTree(roots: readonly TraceNode[], overrides: TreeOverrides = {}): TraceTree {
  const { duplicateSpanIds = [], truncated = false } = overrides;
  const nodes = flattenFixture(roots);

  const starts = nodes.map((node) => node.event.startTime);
  const ends = nodes.map((node) => node.event.startTime + node.event.duration);
  const startTime = starts.length === 0 ? 0 : Math.min(...starts);
  const endTime = ends.length === 0 ? 0 : Math.max(...ends);

  const tiers: TelemetryTier[] = [];
  const kinds: TelemetryKind[] = [];
  const producerIds: string[] = [];

  for (const node of nodes) {
    if (!tiers.includes(node.event.tier)) {
      tiers.push(node.event.tier);
    }
    if (!kinds.includes(node.event.kind)) {
      kinds.push(node.event.kind);
    }
    if (!producerIds.includes(node.event.producerId)) {
      producerIds.push(node.event.producerId);
    }
  }

  tiers.sort((left, right) => orderIndex(TIER_LABELS, left) - orderIndex(TIER_LABELS, right));
  kinds.sort((left, right) => orderIndex(KIND_LABELS, left) - orderIndex(KIND_LABELS, right));
  producerIds.sort();

  const primaryRootSpanId = roots[0]?.event.spanId;

  return {
    traceId: TRACE_ID,
    roots,
    nodeCount: nodes.length,
    maxDepth: nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0),
    startTime,
    endTime,
    totalDuration: Math.round(Math.max(endTime - startTime, 0)),
    orphanCount: nodes.filter((node) => node.orphaned).length,
    tiers,
    kinds,
    producerIds,
    duplicateSpanIds,
    truncated,
    ...(primaryRootSpanId === undefined ? {} : { primaryRootSpanId }),
  };
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<TimelineNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `timeline` node, as the panel normaliser produces one: an id, no
 * heading of its own (the host's section owns that) and a data query narrowed to
 * one interaction.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): TimelineNode {
  const {
    id = NODE_ID,
    query = { source: 'trace', filter: { traceId: TRACE_ID } },
    title,
    description,
  } = overrides;

  return {
    type: 'timeline',
    id,
    query,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The cross-tier chain most cases draw
 *
 * One interaction and the work it caused, one tier per level: the click in the
 * browser, the request it made, the server span that answered it and the
 * datastore call underneath. Distinct kinds, distinct tiers and distinct
 * durations, so a per-row assertion cannot pass by matching the wrong row; only
 * the datastore call resolved to a source location, which is what lets the
 * selection case activate a row with no chip in it.
 * ---------------------------------------------------------------------------
 */

/** The interaction that started the trace, and its root span. */
const INTERACTION_EVENT = makeEvent({
  id: 'event-example-0001',
  spanId: spanIdFor(1),
  kind: 'interaction',
  name: 'example.interaction',
  tier: 'browser',
  startTime: BASE_START_MS,
  duration: 1175,
  producerId: BROWSER_PRODUCER_ID,
  seq: 0,
  ingestSeq: 1,
});

/** The request the handler made, reported by the same page agent. */
const FETCH_EVENT = makeEvent({
  id: 'event-example-0002',
  spanId: spanIdFor(2),
  parentSpanId: spanIdFor(1),
  kind: 'fetch',
  name: 'example.request',
  tier: 'browser',
  startTime: BASE_START_MS + 8,
  duration: 1112,
  producerId: BROWSER_PRODUCER_ID,
  seq: 1,
  ingestSeq: 2,
});

/** The server span that answered it, reported by the dev-server preload. */
const SERVER_EVENT = makeEvent({
  id: 'event-example-0003',
  spanId: spanIdFor(3),
  parentSpanId: spanIdFor(2),
  kind: 'http.server',
  name: 'example.handler',
  tier: 'server',
  startTime: BASE_START_MS + 12,
  duration: 1080,
  producerId: SERVER_PRODUCER_ID,
  seq: 0,
  ingestSeq: 3,
});

/** The datastore call underneath it — the one node that resolved to source. */
const QUERY_EVENT = makeEvent({
  id: 'event-example-0004',
  spanId: spanIdFor(4),
  parentSpanId: spanIdFor(3),
  kind: 'db.query',
  name: 'example.query',
  tier: 'db',
  startTime: BASE_START_MS + 18,
  duration: 640,
  producerId: SERVER_PRODUCER_ID,
  seq: 1,
  ingestSeq: 4,
  source: BASE_SOURCE,
});

/** The chain in the order a children-only walk of the tree produces it. */
const CHAIN_EVENTS: readonly TelemetryEvent[] = [
  INTERACTION_EVENT,
  FETCH_EVENT,
  SERVER_EVENT,
  QUERY_EVENT,
];

/** Their names, in that same order. */
const CHAIN_NAMES: readonly string[] = CHAIN_EVENTS.map((event) => event.name);

/**
 * The tier lanes that chain occupies, in the order the product reads a stack:
 * the browser where an interaction starts, the server it reached, the datastore
 * under it.
 *
 * Written as the tier vocabulary and mapped through the label table, so this
 * suite pins the ORDER — which is the component's own decision — while the three
 * words stay the product's.
 */
const CHAIN_LANE_TIERS: readonly TelemetryTier[] = ['browser', 'server', 'db'];

/** Those lanes as a reader hears them. */
const CHAIN_LANE_LABELS: readonly string[] = CHAIN_LANE_TIERS.map((tier) => formatTierLabel(tier));

/** The window the chain occupies: the interaction's own span, in milliseconds. */
const CHAIN_WINDOW_MS = INTERACTION_EVENT.duration;

/**
 * The correlated chain as a tree.
 *
 * A function rather than a constant, so no case can observe another's tree: the
 * component borrows nodes read-only, but a shared object would let a future
 * regression in that promise pass unnoticed.
 *
 * @param overrides The correlator's own observations about its input.
 * @returns The four-node cross-tier tree.
 */
function crossTierTree(overrides: TreeOverrides = {}): TraceTree {
  return makeTree(
    [
      makeTraceNode(INTERACTION_EVENT, {
        depth: 0,
        children: [
          makeTraceNode(FETCH_EVENT, {
            depth: 1,
            children: [
              makeTraceNode(SERVER_EVENT, {
                depth: 2,
                children: [makeTraceNode(QUERY_EVENT, { depth: 3 })],
              }),
            ],
          }),
        ],
      }),
    ],
    overrides,
  );
}

/*
 * ---------------------------------------------------------------------------
 * Stub providers
 *
 * Built through `createDataProvider`, the factory the library publishes for
 * exactly this shape: one resolver answering every query. Two things come with
 * it — the single type assertion the generic `DataProvider.query` signature
 * would otherwise force into this file, and the factory's own check that a
 * response answers for the source it was asked about, which is why each page
 * below names the source it answers for.
 * ---------------------------------------------------------------------------
 */

/** One page a stub provider can answer with: a correlated tree, or a span page. */
type TimelinePage =
  | { readonly source: 'trace'; readonly data: TraceTree }
  | {
      readonly source: 'spans';
      readonly data: readonly TelemetryEvent[];
      readonly total?: number | undefined;
      readonly nextOffset?: number | undefined;
    };

/** A stub provider, the queries it has received and the resolver behind it. */
interface StubProvider {
  /** The provider to hand to {@link renderComponent}. */
  readonly provider: DataProvider;

  /**
   * Every query the component has asked for, in call order.
   *
   * The assertion surface for the paging and retry cases: what the component
   * *requested* is as much of its contract as what it rendered.
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

/** One page as the response the seam carries, with only the counters it has. */
function responseFor(page: TimelinePage): DataQueryResponse {
  if (page.source === 'trace') {
    return { source: 'trace', data: page.data };
  }

  return {
    source: 'spans',
    data: page.data,
    ...(page.total === undefined ? {} : { total: page.total }),
    ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
  };
}

/**
 * A provider that answers each successive call with the next page, repeating the
 * last one once the list is exhausted.
 *
 * The builder the paging and retry cases use: a re-query has to be able to
 * answer differently from the query before it, or "the rows follow the second
 * response" could not be told from "the rows were re-derived locally".
 *
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(pages: readonly TimelinePage[]): StubProvider {
  return recordingProvider((_query, call) => {
    const page = pages[Math.min(call, pages.length) - 1];

    if (page === undefined) {
      throw new Error('the stub provider was built with no pages');
    }

    return Promise.resolve(responseFor(page));
  });
}

/**
 * A provider that resolves the same correlated tree for every query.
 *
 * @param tree The tree to answer with.
 * @returns The stub provider.
 */
function resolvingTrace(tree: TraceTree): StubProvider {
  return pagingProvider([{ source: 'trace', data: tree }]);
}

/**
 * A provider that resolves one page of a flat span list for every query.
 *
 * @param data The records of the page, in the order they should be drawn.
 * @param extra The paging counters to report, if any.
 * @returns The stub provider.
 */
function resolvingSpans(
  data: readonly TelemetryEvent[],
  extra: { readonly total?: number; readonly nextOffset?: number } = {},
): StubProvider {
  return pagingProvider([{ source: 'spans', data, ...extra }]);
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
 * implementation for: the code and hint it carries are what the error state
 * renders (AAP 0.5.5).
 *
 * @param error The failure to reject with.
 * @returns The stub provider.
 */
function rejectingProvider(error: DebuggenError): StubProvider {
  return recordingProvider(() => Promise.reject(error));
}

/*
 * ---------------------------------------------------------------------------
 * Actions, rendering and DOM readers
 * ---------------------------------------------------------------------------
 */

/** A host's `PanelActions`, with every member this component can raise spied on. */
interface ActionSpies {
  /** The object to provide through {@link PanelActionsContext}. */
  readonly actions: PanelActions;

  /** The event-selection spy. */
  readonly onSelectEvent: Mock<(ref: PanelEventRef) => void>;

  /** The open-source spy. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host — so
 * every case can assert not only that the intent it exercised was raised but
 * also that the other was not: opening a file must never also select a span.
 *
 * @returns The actions object and its two spies.
 */
function makeActions(): ActionSpies {
  const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
  const onOpenSource = vi.fn<(location: SourceLocation) => void>();

  return { actions: { onSelectEvent, onOpenSource }, onSelectEvent, onOpenSource };
}

/**
 * Renders the component inside both host contexts.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 */
function renderComponent(
  node: TimelineNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <Timeline node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );
}

/**
 * The canvas, once the query has settled.
 *
 * Obtained by its role: the SVG is `role="img"` with a text alternative, which
 * is the treatment AAP 0.6.4 permits only alongside the keyboard-reachable
 * equivalent every case below also asserts.
 *
 * @returns The `svg` element.
 */
async function findCanvas(): Promise<HTMLElement> {
  return screen.findByRole('img');
}

/** The lane labels drawn on the canvas, top to bottom. */
function laneLabelsOf(canvas: HTMLElement): string[] {
  return Array.from(canvas.querySelectorAll('.dg-timeline__lane-label')).map(
    (label) => label.textContent ?? '',
  );
}

/** The bars drawn on the canvas, in the model's own row order. */
function barsOf(canvas: HTMLElement): Element[] {
  return Array.from(canvas.querySelectorAll('rect.dg-timeline__bar'));
}

/** The text drawn beside each bar, in that same order. */
function barLabelsOf(canvas: HTMLElement): string[] {
  return Array.from(canvas.querySelectorAll('text.dg-timeline__bar-label')).map(
    (label) => label.textContent ?? '',
  );
}

/**
 * The bar whose SVG title describes the named operation.
 *
 * A bar is addressed through its own description rather than through an index,
 * so a case cannot assert about the wrong row if the drawing order changes.
 *
 * @param canvas The canvas to search.
 * @param name The operation name the bar draws.
 * @returns That bar.
 */
function barTitled(canvas: HTMLElement, name: string): Element {
  const bar = barsOf(canvas).find((candidate) =>
    (candidate.querySelector('title')?.textContent ?? '').startsWith(`${name} `),
  );

  if (bar === undefined) {
    throw new Error(`no bar on the canvas describes "${name}"`);
  }

  return bar;
}

/** The parent → child connectors drawn on the canvas. */
function edgesOf(canvas: HTMLElement): Element[] {
  return Array.from(canvas.querySelectorAll('path.dg-timeline__edge'));
}

/**
 * The equivalent table's data rows, in document order.
 *
 * Obtained by role and then narrowed by the attribute the table primitive writes
 * on a data row, because the header row is `role="row"` too and a bare role
 * query would count it.
 *
 * @returns The data rows.
 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-row-index') !== null);
}

/**
 * The operation name of one equivalent row.
 *
 * Read off the row's header cell — obtained by role — and then off the element
 * the row's tooltip describes, which is the name run and nothing else: the cell
 * also holds the description bubble and any correlation flag, so the cell's own
 * text would not be the name.
 *
 * @param row A data row.
 * @returns The name exactly as the capture carried it.
 */
function nameOf(row: HTMLElement): string {
  const header = within(row).getByRole('rowheader');

  return header.querySelector('[aria-describedby]')?.textContent ?? '';
}

/** The operation name of each equivalent row, in document order. */
function renderedNames(): string[] {
  return dataRows().map(nameOf);
}

/**
 * The equivalent row for the named operation.
 *
 * @param name The operation name to find.
 * @returns That row.
 */
function rowNamed(name: string): HTMLElement {
  const row = dataRows().find((candidate) => nameOf(candidate) === name);

  if (row === undefined) {
    throw new Error(`no rendered row is named "${name}"`);
  }

  return row;
}

/** One row's description, as the tooltip in its header cell states it. */
function descriptionOf(row: HTMLElement): string {
  return within(row).getByRole('tooltip').textContent ?? '';
}

/** The single query a stub provider received, failing on any other count. */
function soleQuery(stub: StubProvider): DataQuery {
  expect(stub.queries).toHaveLength(1);

  const [query] = stub.queries;

  if (query === undefined) {
    throw new Error('the stub provider recorded no query');
  }

  return query;
}

/**
 * The query a stub provider received on the given 1-based call.
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

// Explicit, per the harness note above: automatic cleanup belongs to the
// runner's configuration, this guarantee belongs to the suite. Restoring spies
// in the same place keeps one case's mock out of the next.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Timeline states', () => {
  it('announces that it is loading, and draws nothing, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes only the
    // element class that places it.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.parentElement?.classList.contains('dg-timeline__loading')).toBe(true);

    // Nothing is drawn yet: no canvas, no equivalent table, and above all no
    // empty state — an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // One query, and it was issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders its own empty message, and no canvas, for a trace that holds nothing', async () => {
    const stub = resolvingTrace(makeTree([]));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic substring of the product's own copy rather than by a
    // restatement of the sentence (AAP 0.5.4).
    const message = await screen.findByText(/no correlated spans were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-timeline__empty')).not.toBeNull();

    // An empty trace is a success, so it is drawn as an absence and not as a
    // failure — and there is nothing to place on an axis.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-timeline__error')).not.toBeNull();

    // The provider's own message and code reach the reader, rather than a
    // generic sentence written over them.
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full. It is compared as a value rather
    // than as a spelling, since the serialisation is formatting.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'trace',
      filter: { traceId: TRACE_ID },
    });

    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The retry an error state offers is only useful if it really re-queries.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual(queryOfCall(stub, 1));

    // No canvas and no rows were invented behind the failure.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('reports a node whose query names a source it cannot place on an axis, and asks for nothing', async () => {
    const stub = resolvingTrace(crossTierTree());

    renderComponent(makeNode({ query: { source: 'renders' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-timeline__error')).not.toBeNull();

    // The node's own query is what the reader is shown, and no retry is offered:
    // re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'renders' });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('Timeline cross-tier chain', () => {
  it('draws one bar and one equivalent row per span, in browser, server, database lanes', async () => {
    const stub = resolvingTrace(crossTierTree());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // Four spans: four bars on the canvas and four rows in the equivalent, in
    // the order the children-only walk of the tree produced them.
    expect(barsOf(canvas)).toHaveLength(CHAIN_EVENTS.length);
    expect(dataRows()).toHaveLength(CHAIN_EVENTS.length);
    expect(renderedNames()).toEqual([...CHAIN_NAMES]);

    // Three lanes, in the fixed order the product reads a stack in.
    expect(laneLabelsOf(canvas)).toEqual([...CHAIN_LANE_LABELS]);

    for (const event of CHAIN_EVENTS) {
      const row = rowNamed(event.name);

      // The name is rendered exactly as the capture carried it: no shortening,
      // no re-derivation from a url or a symbol (AAP 0.5.2).
      expect(within(row).getByText(event.name).textContent).toBe(event.name);

      // A duration and an offset, both formatted; the wall-clock instant the
      // capture carried is never printed.
      expect(within(row).getByText(formatDuration(event.duration))).toBeDefined();
      expect(within(row).getByText(formatOffset(event.startTime, BASE_START_MS))).toBeDefined();
      expect(row.textContent).not.toContain(String(event.startTime));
    }

    // One literal, to prove a duration is rendered as a scaled quantity rather
    // than as the raw millisecond number the capture carried.
    expect(within(rowNamed(INTERACTION_EVENT.name)).getByText('1.175 s')).toBeDefined();

    // Each bar's own label is that same name with a compact duration beside it.
    expect(barLabelsOf(canvas)).toEqual(
      CHAIN_EVENTS.map((event) => `${event.name} · ${formatDurationCompact(event.duration)}`),
    );

    // The summary strip states the shape of what was drawn.
    const summary = screen.getByRole('group', { name: 'Timeline summary' });
    expect(within(summary).getByText(`${formatCount(CHAIN_EVENTS.length)} spans`)).toBeDefined();
    expect(
      within(summary).getByText(`${formatCount(CHAIN_LANE_TIERS.length)} tiers`),
    ).toBeDefined();
    expect(within(summary).getByText(`${formatDuration(CHAIN_WINDOW_MS)} elapsed`)).toBeDefined();
    // A complete trace is not a partial result and must not be labelled one.
    expect(within(summary).queryByText('Partial result')).toBeNull();

    // The node's query reached the provider untouched: a trace is not paged, so
    // no page size is invented for it.
    expect(soleQuery(stub)).toEqual({ source: 'trace', filter: { traceId: TRACE_ID } });
  });

  it('carries the kind and tier scales to CSS as token references, never as colours', async () => {
    const stub = resolvingTrace(crossTierTree());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    for (const event of CHAIN_EVENTS) {
      // A bar's colour reaches the stylesheet as the kind scale's token, which is
      // the only inline value this view writes (AAP 0.6.3).
      expect(barTitled(canvas, event.name).getAttribute('style')).toContain(
        kindColorVar(event.kind),
      );

      // The row's chips carry the same two scales, so the canvas and its
      // equivalent cannot disagree about what a kind or a tier looks like.
      const row = rowNamed(event.name);
      expect(within(row).getByText(formatKindLabel(event.kind)).getAttribute('style')).toContain(
        kindColorVar(event.kind),
      );
      expect(within(row).getByText(formatTierLabel(event.tier)).getAttribute('style')).toContain(
        tierColorVar(event.tier),
      );
    }

    // Each lane's accent is the tier scale's token, once per lane.
    const accents = Array.from(canvas.querySelectorAll('rect.dg-timeline__lane')).filter((lane) =>
      (lane.getAttribute('style') ?? '').includes('--dgc-lane-color'),
    );
    expect(accents).toHaveLength(CHAIN_LANE_TIERS.length);
    expect(accents.map((lane) => lane.getAttribute('style') ?? '')).toEqual(
      CHAIN_LANE_TIERS.map((tier) => `--dgc-lane-color: ${tierColorVar(tier)};`),
    );

    // And nothing anywhere on the canvas resolves a colour itself: a literal
    // here would be a value the theme could not reach. The count is asserted
    // first, so the loop below cannot pass by having nothing to examine.
    const styled = Array.from(canvas.querySelectorAll('[style]'));
    expect(styled.length).toBeGreaterThan(CHAIN_EVENTS.length);

    for (const element of styled) {
      expect(element.getAttribute('style') ?? '').not.toMatch(/#[0-9a-f]{3}|rgba?\(|hsla?\(/iu);
    }
  });

  it('draws a flat span page through the same component, with no correlated tree', async () => {
    // The same four records as a page of the `spans` source. The branch is taken
    // on the QUERY'S source, so this case is what proves the second payload path
    // exists rather than being assumed from the first.
    const stub = resolvingSpans([QUERY_EVENT, INTERACTION_EVENT, SERVER_EVENT, FETCH_EVENT]);

    renderComponent(makeNode({ query: { source: 'spans', filter: { traceId: TRACE_ID } } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const canvas = await findCanvas();

    expect(barsOf(canvas)).toHaveLength(CHAIN_EVENTS.length);
    expect(laneLabelsOf(canvas)).toEqual([...CHAIN_LANE_LABELS]);

    // Ordered canonically — start, then the producer's own sequence — whatever
    // order the page arrived in.
    expect(renderedNames()).toEqual([...CHAIN_NAMES]);

    const query = soleQuery(stub);
    expect(query.source).toBe('spans');
    expect(query.filter).toEqual({ traceId: TRACE_ID });
    // A flat page IS paged, so the published default page size is asked for.
    expect(query.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Offset-aware paging stubs
 *
 * Local to the paging cases below, and deliberately independent of the shared
 * stub helpers above: a page is looked up from the query the component SENT —
 * its offset, and for the reset case its filter — so a case can only pass when
 * the component asks for the page the service's `nextOffset` named. Any call can
 * be held open, to observe the view while a page is in flight, or failed once,
 * to observe it after a page failed. Built on the library's own
 * `createDataProvider`, like every other stub in this suite.
 * ---------------------------------------------------------------------------
 */

/** One span page, as a service would answer the request that asked for it. */
interface SpanPageAnswer {
  readonly data: readonly TelemetryEvent[];
  readonly total?: number | undefined;
  readonly nextOffset?: number | undefined;
}

/** Finds the page that answers a query, or `undefined` for a page that does not exist. */
type SpanPageLookup = (query: DataQuery) => SpanPageAnswer | undefined;

/** Which requests an {@link offsetPagedProvider} holds open or fails, by 1-based call number. */
interface OffsetStubOptions {
  /** Calls whose answer waits for {@link OffsetStub.release}. */
  readonly hold?: readonly number[] | undefined;
  /** Calls that reject with {@link PAGE_FAILURE} instead of answering. */
  readonly fail?: readonly number[] | undefined;
}

/** An offset-aware stub provider and what it has been asked. */
interface OffsetStub {
  /** The provider to hand to the component. */
  readonly provider: DataProvider;
  /** Every query received, in call order. */
  readonly queries: readonly DataQuery[];
  /** The recorded resolver, for call counts. */
  readonly resolve: Mock<DataQueryResolver>;
  /** Settles a held call with the page its query names. */
  readonly release: (call: number) => void;
}

/** The failure a failed page reports: the provider's own message and code. */
const PAGE_FAILURE = new DebuggenError(
  'TRANSPORT_DISCONNECTED',
  'The channel to the service closed mid-page.',
);

/** The footer control while the page it asked for is in flight. */
const LOADING_MORE_NAME = 'Loading more spans…';

/**
 * A lookup that answers by the offset the query asked for, and only by it.
 *
 * @param pages The pages, keyed by the offset each one starts at.
 * @returns The lookup.
 */
function pagesByOffset(pages: ReadonlyMap<number, SpanPageAnswer>): SpanPageLookup {
  return (query) => (query.offset === undefined ? undefined : pages.get(query.offset));
}

/**
 * A provider that answers each span query with the page its own offset names.
 *
 * A query for a page the lookup does not hold is rejected, so a component that
 * asked for an offset the previous response never named fails loudly.
 *
 * @param lookup Which page answers which query.
 * @param options Calls to hold open or to fail.
 * @returns The stub.
 */
function offsetPagedProvider(lookup: SpanPageLookup, options: OffsetStubOptions = {}): OffsetStub {
  const queries: DataQuery[] = [];
  const held = new Set(options.hold ?? []);
  const failing = new Set(options.fail ?? []);
  const pending = new Map<number, () => void>();

  const answer = (query: DataQuery): Promise<DataQueryResponse> => {
    const page = lookup(query);

    if (page === undefined) {
      return Promise.reject(
        new DebuggenError(
          'INTERNAL',
          `The stub holds no page at offset ${String(query.offset)}; the view asked for a page no response named.`,
        ),
      );
    }

    return Promise.resolve({
      source: 'spans',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    });
  };

  const resolve = vi.fn<DataQueryResolver>((query) => {
    queries.push(query);
    const call = queries.length;

    if (failing.has(call)) {
      return Promise.reject(PAGE_FAILURE);
    }

    if (held.has(call)) {
      return new Promise<DataQueryResponse>((settle, reject) => {
        pending.set(call, () => {
          answer(query).then(settle, reject);
        });
      });
    }

    return answer(query);
  });

  const release = (call: number): void => {
    const settle = pending.get(call);

    if (settle === undefined) {
      throw new Error(`call ${String(call)} is not being held open`);
    }

    pending.delete(call);
    settle();
  };

  return { provider: createDataProvider(resolve), queries, resolve, release };
}

/**
 * The query an offset stub received on the given 1-based call.
 *
 * @param stub The stub.
 * @param call The 1-based call number.
 * @returns That query.
 */
function pageRequest(stub: OffsetStub, call: number): DataQuery {
  const query = stub.queries[call - 1];

  if (query === undefined) {
    throw new Error(`the offset stub recorded no query for call ${String(call)}`);
  }

  return query;
}

/** The summary strip, where a partial result is named. */
function summaryStrip(): HTMLElement {
  return screen.getByRole('group', { name: 'Timeline summary' });
}

/** A span node paging the fixture trace at the given page size. */
function pagedSpansNode(limit: number, offset?: number): TimelineNode {
  return makeNode({
    query: {
      source: 'spans',
      filter: { traceId: TRACE_ID },
      limit,
      ...(offset === undefined ? {} : { offset }),
    },
  });
}

describe('Timeline paging', () => {
  it('advances by the next offset at a fixed page size, appending pages and keeping loaded rows on screen', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 4, nextOffset: 2 }],
          // The capture grew between the two requests and pushed the request
          // record back across the page boundary, so this page repeats it.
          [2, { data: [FETCH_EVENT, SERVER_EVENT], total: 4, nextOffset: 4 }],
          [4, { data: [QUERY_EVENT], total: 4 }],
        ]),
      ),
      { hold: [2] },
    );
    const user = userEvent.setup();

    renderComponent(pagedSpansNode(2), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(4)} spans.`);
    expect(renderedNames()).toEqual([INTERACTION_EVENT.name, FETCH_EVENT.name]);
    expect(within(summaryStrip()).getByText('Partial result')).toBeDefined();

    const first = pageRequest(stub, 1);
    expect(first.offset).toBe(0);
    expect(first.limit).toBe(2);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next request starts exactly where the first response said the next
    // page does, at the same page size: nothing is re-requested and nothing grows.
    expect(stub.resolve).toHaveBeenCalledTimes(2);
    const second = pageRequest(stub, 2);
    expect(second.offset).toBe(2);
    expect(second.limit).toBe(first.limit);
    expect(second.source).toBe('spans');
    expect(second.filter).toEqual({ traceId: TRACE_ID });

    // While that page is in flight the loaded chart and table stay on screen,
    // the footer keeps its total, and the control reports the page it awaits.
    expect(renderedNames()).toEqual([INTERACTION_EVENT.name, FETCH_EVENT.name]);
    expect(barsOf(screen.getByRole('img'))).toHaveLength(2);
    expect(document.querySelector('.dg-timeline__loading')).toBeNull();
    expect(screen.getByText(`Showing ${formatCount(2)} of ${formatCount(4)} spans.`)).toBeDefined();

    const busy = screen.getByRole('button', { name: LOADING_MORE_NAME });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    stub.release(2);

    // Appended after the rows already drawn, and the repeated record drawn once.
    await screen.findByText(`Showing ${formatCount(3)} of ${formatCount(4)} spans.`);
    expect(renderedNames()).toEqual([INTERACTION_EVENT.name, FETCH_EVENT.name, SERVER_EVENT.name]);
    expect(barsOf(screen.getByRole('img'))).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await screen.findByText(`Showing ${formatCount(4)} of ${formatCount(4)} spans.`);
    expect(renderedNames()).toEqual([...CHAIN_NAMES]);

    // Every page was asked for once, at the offset the page before it named.
    expect(stub.queries.map((query) => query.offset)).toEqual([0, 2, 4]);
    expect(stub.queries.map((query) => query.limit)).toEqual([2, 2, 2]);

    // The last response named no next offset: the result is exhausted, and the
    // view no longer calls itself partial.
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(within(summaryStrip()).queryByText('Partial result')).toBeNull();
  });

  it('keeps the loaded rows when the next page fails, and retries that same page', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 4, nextOffset: 2 }],
          [2, { data: [SERVER_EVENT, QUERY_EVENT], total: 4 }],
        ]),
      ),
      { fail: [2] },
    );
    const user = userEvent.setup();

    renderComponent(pagedSpansNode(2), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(4)} spans.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The failure is reported below the rows, never in place of them.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(PAGE_FAILURE.message);
    expect(alert.textContent).toContain(PAGE_FAILURE.code);
    expect(renderedNames()).toEqual([INTERACTION_EVENT.name, FETCH_EVENT.name]);
    expect(barsOf(screen.getByRole('img'))).toHaveLength(2);
    expect(screen.getByText(`Showing ${formatCount(2)} of ${formatCount(4)} spans.`)).toBeDefined();

    // The query shown is the page that failed, not the node's first page.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'spans',
      filter: { traceId: TRACE_ID },
      limit: 2,
      offset: 2,
    });

    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    await screen.findByText(`Showing ${formatCount(4)} of ${formatCount(4)} spans.`);
    expect(renderedNames()).toEqual([...CHAIN_NAMES]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(stub.queries.map((query) => query.offset)).toEqual([0, 2, 2]);
  });

  it('requests a next offset beyond 5,000 and draws the rows it returns', async () => {
    // Authored to start at 4,900; the service names 5,100 as the next page.
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [4900, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 5300, nextOffset: 5100 }],
          [5100, { data: [SERVER_EVENT, QUERY_EVENT], total: 5300 }],
        ]),
      ),
    );
    const user = userEvent.setup();

    renderComponent(pagedSpansNode(200, 4900), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(5300)} spans.`);
    expect(pageRequest(stub, 1).offset).toBe(4900);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await screen.findByText(`Showing ${formatCount(4)} of ${formatCount(5300)} spans.`);
    expect(renderedNames()).toEqual([...CHAIN_NAMES]);

    const second = pageRequest(stub, 2);
    expect(second.offset).toBe(5100);
    expect(second.limit).toBe(200);
  });

  it('keeps walking at the page ceiling: pages of 5,000 advance to offsets 5,000 and 10,000', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 12_000, nextOffset: 5000 }],
          [5000, { data: [SERVER_EVENT], total: 12_000, nextOffset: 10_000 }],
          [10_000, { data: [QUERY_EVENT], total: 12_000 }],
        ]),
      ),
    );
    const user = userEvent.setup();

    renderComponent(pagedSpansNode(DATA_QUERY_MAX_LIMIT), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(12_000)} spans.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(`Showing ${formatCount(3)} of ${formatCount(12_000)} spans.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(`Showing ${formatCount(4)} of ${formatCount(12_000)} spans.`);

    expect(renderedNames()).toEqual([...CHAIN_NAMES]);
    expect(stub.queries.map((query) => query.offset)).toEqual([0, 5000, 10_000]);
    expect(stub.queries.map((query) => query.limit)).toEqual([
      DATA_QUERY_MAX_LIMIT,
      DATA_QUERY_MAX_LIMIT,
      DATA_QUERY_MAX_LIMIT,
    ]);
  });

  it('offers no next page when the service names none, whatever the total says', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 10 }],
        ]),
      ),
    );

    renderComponent(pagedSpansNode(2), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    // The total is stated and the view is named partial, but a total is not a
    // next offset: nothing is offered and nothing more is requested.
    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(10)} spans.`);
    expect(within(summaryStrip()).getByText('Partial result')).toBeDefined();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: LOADING_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['names the page it answered', 3],
    ['points backwards', 1],
  ])(
    'treats a next offset that %s as the end of the result',
    async (_description: string, nextOffset: number) => {
      const stub = offsetPagedProvider(
        pagesByOffset(
          new Map<number, SpanPageAnswer>([
            [3, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 10, nextOffset }],
          ]),
        ),
      );

      renderComponent(pagedSpansNode(2, 3), {
        provider: stub.provider,
        actions: makeActions().actions,
      });

      // Following it would re-request rows already on screen, or loop on them.
      await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(10)} spans.`);
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
      expect(stub.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it('returns to the first page, with none of the old rows, when the query changes', async () => {
    const byOffset = pagesByOffset(
      new Map<number, SpanPageAnswer>([
        [0, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 4, nextOffset: 2 }],
        [2, { data: [SERVER_EVENT, QUERY_EVENT], total: 4 }],
      ]),
    );
    const stub = offsetPagedProvider(
      (query) =>
        query.filter?.tier === 'db'
          ? query.offset === 0
            ? { data: [QUERY_EVENT], total: 1 }
            : undefined
          : byOffset(query),
      { hold: [3] },
    );
    const { actions } = makeActions();
    const user = userEvent.setup();

    const withHost = (node: TimelineNode): ReactElement => (
      <DataProviderContext.Provider value={stub.provider}>
        <PanelSessionContext.Provider value={SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <Timeline node={node} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
    );

    const view = render(withHost(pagedSpansNode(2)));

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(4)} spans.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(`Showing ${formatCount(4)} of ${formatCount(4)} spans.`);

    // Same node, a different query: a different page sequence.
    view.rerender(
      withHost(
        makeNode({
          query: { source: 'spans', filter: { traceId: TRACE_ID, tier: 'db' }, limit: 2 },
        }),
      ),
    );

    // Its first page, from the start, and the old query's rows are not painted
    // while it loads: the first-page loading state is.
    const third = pageRequest(stub, 3);
    expect(third.offset).toBe(0);
    expect(third.limit).toBe(2);
    expect(third.filter).toEqual({ traceId: TRACE_ID, tier: 'db' });
    expect(document.querySelector('.dg-timeline__loading')).not.toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();

    stub.release(3);

    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(1)} spans.`);
    expect(renderedNames()).toEqual([QUERY_EVENT.name]);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(3);
  });

  it('offers the next page after a resolved page that held no spans but named one', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [], total: 2, nextOffset: 2 }],
          [2, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 2 }],
        ]),
      ),
    );
    const user = userEvent.setup();

    renderComponent(pagedSpansNode(2), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    // The empty page is reported as a page, never as an empty capture, and the
    // offset it named stays reachable.
    await screen.findByText(`Showing ${formatCount(0)} of ${formatCount(2)} spans.`);
    expect(
      screen.queryByText('No correlated spans were captured for this interaction.'),
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    const second = pageRequest(stub, 2);
    expect(second.offset).toBe(2);
    expect(second.limit).toBe(pageRequest(stub, 1).limit);

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(2)} spans.`);
    expect(renderedNames()).toEqual([INTERACTION_EVENT.name, FETCH_EVENT.name]);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('starts over from the authored first page, painting none of the old rows, when the data provider is replaced', async () => {
    const earlier = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 4, nextOffset: 2 }],
          [2, { data: [SERVER_EVENT, QUERY_EVENT], total: 4 }],
        ]),
      ),
    );
    const later = offsetPagedProvider(
      pagesByOffset(new Map<number, SpanPageAnswer>([[0, { data: [QUERY_EVENT], total: 1 }]])),
      { hold: [1] },
    );
    const { actions } = makeActions();
    const user = userEvent.setup();

    // One node, one query, two providers: a host rebinding a mounted panel to
    // another session swaps the provider without remounting the node.
    const withProvider = (provider: DataProvider): ReactElement => (
      <DataProviderContext.Provider value={provider}>
        <PanelSessionContext.Provider value={SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <Timeline node={pagedSpansNode(2)} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
    );

    const view = render(withProvider(earlier.provider));

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(4)} spans.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(`Showing ${formatCount(4)} of ${formatCount(4)} spans.`);
    await user.click(rowNamed(SERVER_EVENT.name));

    view.rerender(withProvider(later.provider));

    // The new provider is asked for the authored first page — not the offset
    // the previous provider's pages reached — and while it loads nothing of the
    // previous provider's is on screen.
    expect(later.resolve).toHaveBeenCalledTimes(1);
    const first = pageRequest(later, 1);
    expect(first.offset).toBe(0);
    expect(first.limit).toBe(2);
    expect(document.querySelector('.dg-timeline__loading')).not.toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(detailSlot()).toBeNull();

    later.release(1);

    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(1)} spans.`);
    expect(renderedNames()).toEqual([QUERY_EVENT.name]);
    expect(earlier.resolve).toHaveBeenCalledTimes(2);
  });
});

describe('Timeline partial results', () => {
  it('says how much of a span result is on screen and asks for the next page', async () => {
    // A page of one record out of twenty-five, then the next page the component
    // asks for, which holds the record after it.
    const stub = pagingProvider([
      { source: 'spans', data: [INTERACTION_EVENT], total: 25, nextOffset: 1 },
      { source: 'spans', data: [FETCH_EVENT], total: 25, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'spans', filter: { traceId: TRACE_ID }, limit: 1 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // One span of twenty-five, said plainly rather than implied by a bare count.
    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(25)} spans.`);
    expect(dataRows()).toHaveLength(1);

    // And named as partial in the summary strip, so the shape on the axis is not
    // mistaken for the whole interaction.
    expect(
      within(screen.getByRole('group', { name: 'Timeline summary' })).getByText('Partial result'),
    ).toBeDefined();

    const first = soleQuery(stub);
    expect(first.limit).toBe(1);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);

    // The walk ADVANCES to the offset the first response named, at the same
    // page size, rather than widening a window over rows already on screen.
    const second = queryOfCall(stub, 2);
    expect(second.offset).toBe(1);
    expect(second.limit).toBe(first.limit);
    expect(second.source).toBe('spans');
    expect(second.filter).toEqual({ traceId: TRACE_ID });

    // The page is appended after the row already drawn, and the coverage
    // statement follows the rows.
    await waitFor(() => {
      expect(renderedNames()).toEqual([INTERACTION_EVENT.name, FETCH_EVENT.name]);
    });
    expect(
      screen.getByText(`Showing ${formatCount(2)} of ${formatCount(25)} spans.`),
    ).toBeDefined();
  });

  it('states a bare count, and offers nothing to load, when no total was reported', async () => {
    const stub = resolvingSpans([INTERACTION_EVENT, FETCH_EVENT]);

    renderComponent(makeNode({ query: { source: 'spans', filter: { traceId: TRACE_ID } } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    // A service that reported neither a total nor a next offset leaves nothing
    // to claim about the rest of the result, so nothing is claimed.
    await screen.findByText(`${formatCount(2)} spans shown.`);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('says a correlated trace was truncated rather than implying it is complete', async () => {
    const stub = resolvingTrace(crossTierTree({ truncated: true }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();

    // The correlator's own truncation, stated as the sentence it is.
    expect(
      screen.getByText(
        `${formatCount(CHAIN_EVENTS.length)} spans shown. More were captured than this view holds.`,
      ),
    ).toBeDefined();
    expect(
      within(screen.getByRole('group', { name: 'Timeline summary' })).getByText('Partial result'),
    ).toBeDefined();

    // A trace is not a paged source, so there is no wider window to ask for.
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Correlation honesty fixtures
 *
 * The two conditions the pipeline can only report, never measure: an attribution
 * with more than one possible parent, and a span whose parent never arrived. Both
 * are drawn and both are flagged — the first because a guess must not read as a
 * measurement, the second because dropping it would remove real captured work
 * from the picture (AAP 0.4.2).
 * ---------------------------------------------------------------------------
 */

/** The other parent that was open when the continuation below was attributed. */
const AMBIGUOUS_CANDIDATE_SPAN_ID = spanIdFor(9);

/**
 * A commit attributed to the trace through a continuation window, with more than
 * one settled request open at the time.
 *
 * Both routes the component reads are populated, exactly as a correlated node
 * carries them: the node's own lineage record (below) and the attribute keys the
 * producer wrote, which are all a flat span page has.
 */
const CONTINUATION_EVENT = makeEvent({
  id: 'event-example-0005',
  spanId: spanIdFor(5),
  parentSpanId: spanIdFor(2),
  kind: 'render',
  name: 'example.commit',
  tier: 'browser',
  startTime: BASE_START_MS + 1128,
  duration: 47,
  producerId: BROWSER_PRODUCER_ID,
  seq: 2,
  ingestSeq: 5,
  attributes: {
    lineage: ASYNC_CONTINUATION,
    lineageAmbiguous: true,
    lineageCandidates: [AMBIGUOUS_CANDIDATE_SPAN_ID],
  },
});

/** The lineage record the correlator derives from those attributes. */
const AMBIGUOUS_LINEAGE: TraceNodeLineage = {
  value: ASYNC_CONTINUATION,
  ambiguous: true,
  candidateSpanIds: [AMBIGUOUS_CANDIDATE_SPAN_ID],
};

/** A server span whose named parent never arrived, re-attached to the root. */
const ORPHAN_EVENT = makeEvent({
  id: 'event-example-0006',
  spanId: spanIdFor(6),
  parentSpanId: spanIdFor(8),
  kind: 'http.server',
  name: 'example.detached',
  tier: 'server',
  startTime: BASE_START_MS + 400,
  duration: 90,
  producerId: SERVER_PRODUCER_ID,
  seq: 2,
  ingestSeq: 6,
  attributes: { orphaned: true, orphanedParentSpanId: spanIdFor(8) },
});

describe('Timeline correlation honesty', () => {
  it('marks an ambiguous attribution as uncertain and names the other candidates', async () => {
    const stub = resolvingTrace(
      makeTree([
        makeTraceNode(INTERACTION_EVENT, {
          depth: 0,
          children: [
            makeTraceNode(FETCH_EVENT, {
              depth: 1,
              children: [
                makeTraceNode(CONTINUATION_EVENT, { depth: 2, lineage: AMBIGUOUS_LINEAGE }),
              ],
            }),
          ],
        }),
      ]),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();
    const row = rowNamed(CONTINUATION_EVENT.name);

    // The row says so in words, which is the signal that does not depend on
    // seeing the drawing.
    expect(within(row).getByText(AMBIGUOUS_FLAG)).toBeDefined();

    // And its description names the mechanism and the candidates that were not
    // chosen, so the alternatives stay inspectable rather than being discarded.
    const description = descriptionOf(row);
    expect(description).toContain(ASYNC_CONTINUATION);
    expect(description).toContain('More than one parent was possible');
    expect(description).toContain(AMBIGUOUS_CANDIDATE_SPAN_ID);

    // The drawing carries the same statement: the bar is marked and the
    // connector to the chosen parent is the dashed one.
    expect(barTitled(canvas, CONTINUATION_EVENT.name).classList.contains('dg-is-ambiguous')).toBe(
      true,
    );

    const dashed = edgesOf(canvas).filter((edge) =>
      edge.classList.contains('dg-timeline__edge--dashed'),
    );
    expect(dashed).toHaveLength(1);
    expect(dashed[0]?.classList.contains('dg-is-ambiguous')).toBe(true);

    // The measured relationships are not marked as guesses: exactly one of the
    // two connectors is dashed, and the ordinary rows carry no flag.
    expect(edgesOf(canvas)).toHaveLength(2);
    expect(within(rowNamed(FETCH_EVENT.name)).queryByText(AMBIGUOUS_FLAG)).toBeNull();
    expect(barTitled(canvas, FETCH_EVENT.name).classList.contains('dg-is-ambiguous')).toBe(false);
  });

  it('reads the same uncertainty off a flat span page, where no tree carries it', async () => {
    // A page has no node to hold a lineage record, so the attribute keys the
    // producer wrote are the only route — and the same marks must appear.
    const stub = resolvingSpans([INTERACTION_EVENT, FETCH_EVENT, CONTINUATION_EVENT]);

    renderComponent(makeNode({ query: { source: 'spans', filter: { traceId: TRACE_ID } } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const canvas = await findCanvas();
    const row = rowNamed(CONTINUATION_EVENT.name);

    expect(within(row).getByText(AMBIGUOUS_FLAG)).toBeDefined();
    expect(descriptionOf(row)).toContain(AMBIGUOUS_CANDIDATE_SPAN_ID);
    expect(barTitled(canvas, CONTINUATION_EVENT.name).classList.contains('dg-is-ambiguous')).toBe(
      true,
    );
  });

  it('draws, flags and counts a span the correlator had to re-attach', async () => {
    const tree = makeTree([
      makeTraceNode(INTERACTION_EVENT, {
        depth: 0,
        children: [makeTraceNode(FETCH_EVENT, { depth: 1 })],
      }),
      makeTraceNode(ORPHAN_EVENT, {
        depth: 0,
        orphaned: true,
        orphanReason: MISSING_PARENT,
        missingParentSpanId: spanIdFor(8),
      }),
    ]);
    const stub = resolvingTrace(tree);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // Nothing was dropped: every node of the tree is on the axis and in the
    // equivalent, orphan included.
    expect(tree.orphanCount).toBe(1);
    expect(dataRows()).toHaveLength(tree.nodeCount);
    expect(barsOf(canvas)).toHaveLength(tree.nodeCount);
    expect(renderedNames()).toContain(ORPHAN_EVENT.name);

    // And it is marked, so the tree is not mistaken for the shape the
    // application actually had.
    const row = rowNamed(ORPHAN_EVENT.name);
    expect(within(row).getByText(REATTACHED_FLAG)).toBeDefined();
    expect(descriptionOf(row)).toContain(`Re-attached to the root (${MISSING_PARENT})`);

    const bar = barTitled(canvas, ORPHAN_EVENT.name);
    expect(bar.classList.contains('dg-is-orphan')).toBe(true);
    expect(bar.classList.contains('dg-is-orphaned')).toBe(true);

    // Its parent is not on the canvas, so no connector asserts a relationship a
    // reader could not check: the only edge is the measured one.
    expect(edgesOf(canvas)).toHaveLength(1);
    expect(edgesOf(canvas)[0]?.classList.contains('dg-is-orphan')).toBe(false);

    // The rows that were placed carry no re-attachment mark.
    expect(within(rowNamed(INTERACTION_EVENT.name)).queryByText(REATTACHED_FLAG)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Keyboard-reachable descriptions
 *
 * A row's full description is carried by a `Tooltip`, which opens on focus, so
 * its trigger has to be reachable by the keyboard — and reachable without the
 * table growing a tab stop per row. These readers address the two triggers the
 * view has: the name in the detail strip above the table, and the name in each
 * row's Operation cell. A class is read only off an element already obtained
 * semantically, per the harness note at the top of this file.
 * ---------------------------------------------------------------------------
 */

/** The detail strip's tooltip slot, or `null` while no row is hovered, focused or selected. */
function detailSlot(): Element | null {
  return document.querySelector('.dg-timeline__tooltip');
}

/** The trigger of the detail strip's description: the focused, hovered or selected row's name. */
function detailTrigger(): HTMLElement {
  const trigger = detailSlot()?.querySelector('[aria-describedby]');

  if (!(trigger instanceof HTMLElement)) {
    throw new Error('the detail strip shows no described row name');
  }

  return trigger;
}

/** The detail strip's description bubble. */
function detailBubble(): HTMLElement {
  const slot = detailSlot();

  if (!(slot instanceof HTMLElement)) {
    throw new Error('the detail strip is not rendered');
  }

  return within(slot).getByRole('tooltip');
}

/** The trigger of one row's description: the name in its Operation cell. */
function nameTriggerOf(row: HTMLElement): HTMLElement {
  const trigger = within(row).getByRole('rowheader').querySelector('[aria-describedby]');

  if (!(trigger instanceof HTMLElement)) {
    throw new Error('the row header holds no described name');
  }

  return trigger;
}

/** Each rendered row's name trigger `tabindex`, in document order; `null` when it has none. */
function nameTabIndexes(): (string | null)[] {
  return dataRows().map((row) => nameTriggerOf(row).getAttribute('tabindex'));
}

/** Whether `bubble` is the description `trigger` announces. */
function describes(trigger: HTMLElement, bubble: HTMLElement): boolean {
  return (trigger.getAttribute('aria-describedby') ?? '').split(/\s+/u).includes(bubble.id);
}

describe('Timeline keyboard-reachable descriptions', () => {
  it('drives the detail strip from the focused row, and opens its description on focus', async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();

    // Nothing hovered, focused or selected: no strip yet, so Tab lands on the table.
    expect(detailSlot()).toBeNull();

    await user.tab();
    const [firstRow, secondRow] = dataRows();

    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('the equivalent rendered fewer than two rows');
    }

    expect(document.activeElement).toBe(firstRow);
    expect(detailTrigger().textContent).toBe(INTERACTION_EVENT.name);

    // The strip follows the row the arrow keys move to.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(secondRow);
    expect(detailTrigger().textContent).toBe(FETCH_EVENT.name);

    // The strip's name is a focusable trigger one Shift+Tab away, and its
    // description opens the moment it takes focus.
    expect(detailTrigger().getAttribute('tabindex')).toBe('0');
    expect(detailBubble().classList.contains('dg-is-open')).toBe(false);

    await user.tab({ shift: true });

    const trigger = detailTrigger();
    const bubble = detailBubble();
    expect(document.activeElement).toBe(trigger);
    expect(bubble.classList.contains('dg-is-open')).toBe(true);
    expect(describes(trigger, bubble)).toBe(true);
    expect(bubble.textContent).toContain(FETCH_EVENT.name);
    expect(bubble.textContent).toContain(formatDuration(FETCH_EVENT.duration));

    // Focus moved within the view, so the strip still shows the row it came from.
    expect(trigger.textContent).toBe(FETCH_EVENT.name);

    // Escape dismisses it without moving focus.
    await user.keyboard('{Escape}');
    expect(detailBubble().classList.contains('dg-is-open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("makes the focused row's own name a tab stop that opens its description, and no other row's", async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();

    // Before focus enters the table no row's name is in the tab order.
    expect(nameTabIndexes()).toEqual([null, null, null, null]);

    await user.tab();
    const [firstRow, secondRow] = dataRows();

    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('the equivalent rendered fewer than two rows');
    }

    expect(document.activeElement).toBe(firstRow);
    expect(nameTabIndexes()).toEqual(['0', null, null, null]);

    // One Tab from the row reaches its name, and focus opens the description.
    await user.tab();

    const trigger = nameTriggerOf(firstRow);
    const bubble = within(firstRow).getByRole('tooltip');
    expect(document.activeElement).toBe(trigger);
    expect(bubble.classList.contains('dg-is-open')).toBe(true);
    expect(describes(trigger, bubble)).toBe(true);
    expect(bubble.textContent).toContain(INTERACTION_EVENT.name);

    // Back to the row closes it; moving down moves the stop rather than adding one.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(firstRow);
    expect(bubble.classList.contains('dg-is-open')).toBe(false);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(secondRow);
    expect(nameTabIndexes()).toEqual([null, '0', null, null]);

    // The body holds the table's roving stop and the focused row's name, and
    // nothing else carrying a tab index, however many rows it renders.
    const grid = screen.getByRole('grid');
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(2);
  });

  it('forgets the focused row once focus leaves the view', async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();
    await user.tab();

    const [firstRow] = dataRows();

    if (firstRow === undefined) {
      throw new Error('the equivalent rendered no rows');
    }

    expect(document.activeElement).toBe(firstRow);
    expect(detailTrigger().textContent).toBe(INTERACTION_EVENT.name);

    act(() => {
      firstRow.blur();
    });

    // No row is focused, hovered or selected any more: the strip is gone and no
    // row's name is left in the tab order.
    expect(detailSlot()).toBeNull();
    expect(nameTabIndexes()).toEqual([null, null, null, null]);
  });

  it('reaches the description of a flat span page the same way', async () => {
    const stub = resolvingSpans([INTERACTION_EVENT, FETCH_EVENT, CONTINUATION_EVENT]);
    const user = userEvent.setup();

    renderComponent(makeNode({ query: { source: 'spans', filter: { traceId: TRACE_ID } } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await findCanvas();
    await user.tab();
    await user.keyboard('{End}');

    const row = rowNamed(CONTINUATION_EVENT.name);
    expect(document.activeElement).toBe(row);

    await user.tab();

    const bubble = within(row).getByRole('tooltip');
    expect(document.activeElement).toBe(nameTriggerOf(row));
    expect(bubble.classList.contains('dg-is-open')).toBe(true);
    // The lineage notes a hover would show are in it too.
    expect(bubble.textContent).toContain(AMBIGUOUS_CANDIDATE_SPAN_ID);
  });
});

describe('Timeline accessibility', () => {
  it('pairs the canvas with a keyboard-operable equivalent of every row', async () => {
    const stub = resolvingTrace(crossTierTree());
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    const canvas = await findCanvas();

    // The canvas is an image with a text alternative — the treatment that keeps
    // its bars out of the accessibility tree — and it is not hidden, so that
    // alternative has to describe what was drawn (AAP 0.6.4).
    expect(canvas.tagName.toLowerCase()).toBe('svg');
    expect(canvas.getAttribute('aria-hidden')).toBeNull();

    const alternative = canvas.getAttribute('aria-label') ?? '';
    expect(alternative).toContain(`${formatCount(CHAIN_EVENTS.length)} spans`);
    expect(alternative).toContain(`${formatCount(CHAIN_LANE_TIERS.length)} tier lanes`);
    expect(alternative).toContain(formatDuration(CHAIN_WINDOW_MS));
    expect(alternative).toContain('table below');

    // The equivalent is a named grid and it lists every span, not a sample.
    const grid = screen.getByRole('grid', { name: /every captured span of this interaction/i });
    expect(grid.closest('.dg-timeline__equivalent')).not.toBeNull();
    expect(dataRows()).toHaveLength(CHAIN_EVENTS.length);
    expect(renderedNames()).toEqual([...CHAIN_NAMES]);
    expect(
      screen.getAllByRole('columnheader').map((cell) => cell.textContent?.trim() ?? ''),
    ).toEqual(['Operation', 'Kind', 'Tier', 'Reported', 'Offset', 'Duration', 'Source']);

    // Reachable: the body of the grid is one tab stop, and Tab lands on it.
    const rows = dataRows();
    const firstRow = rows[0];
    const secondRow = rows[1];

    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('the equivalent rendered fewer than two rows');
    }

    await user.tab();
    expect(document.activeElement).toBe(firstRow);

    // Operable: the arrow keys move the active row and Enter activates it, which
    // raises the same selection a bar does.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(secondRow);

    await user.keyboard('{Enter}');

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: FETCH_EVENT.id,
      spanId: FETCH_EVENT.spanId,
      traceId: FETCH_EVENT.traceId,
    });
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });
});

describe('Timeline interactions', () => {
  it('hands the host the very location a span resolved to, and selects nothing', async () => {
    const stub = resolvingTrace(crossTierTree());
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
    // this one acts on the object it is handed (AAP 0.4.2, hop 1 of five).
    expect(received).toEqual(BASE_SOURCE);
    expect(Object.keys(received).sort()).toEqual(expectedKeys);
    expect(received.file).toBe(SOURCE_FILE);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.line).toBe(SOURCE_LINE);
    expect(received.column).toBe(SOURCE_COLUMN);
    expect(received.symbol).toBe(SOURCE_SYMBOL);

    // Opening source is not selecting a span: the chip's activation stops at the
    // chip, so the row it sits in is not activated as well.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // A span that resolved to nothing says so rather than offering a chip that
    // would open the wrong file.
    const unresolved = rowNamed(INTERACTION_EVENT.name);
    expect(within(unresolved).queryByRole('button')).toBeNull();
    expect(within(unresolved).getByText(NOT_AVAILABLE_LABEL)).toBeDefined();
    expect(unresolved.textContent).not.toContain(SOURCE_FILE);
  });

  it('announces an activated row as the event it stands for, and marks its bar', async () => {
    const stub = resolvingTrace(crossTierTree());
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await findCanvas();

    const row = rowNamed(SERVER_EVENT.name);
    expect(row.getAttribute('aria-selected')).toBe('false');

    await user.click(row);

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    const ref = call[0];

    // The three identifiers the host needs to resolve the record, taken from
    // that span and nothing else.
    expect(ref).toEqual({
      eventId: SERVER_EVENT.id,
      spanId: SERVER_EVENT.spanId,
      traceId: SERVER_EVENT.traceId,
    });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // Both representations show that the click landed where the reader aimed.
    expect(rowNamed(SERVER_EVENT.name).getAttribute('aria-selected')).toBe('true');
    expect(
      barTitled(await findCanvas(), SERVER_EVENT.name).classList.contains('dg-is-selected'),
    ).toBe(true);

    // Selecting a span is not opening its source.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });
});

describe('Timeline determinism', () => {
  it('draws the same lanes, bars and rows for the same tree twice', async () => {
    const first = resolvingTrace(crossTierTree());

    renderComponent(makeNode(), { provider: first.provider, actions: makeActions().actions });

    const firstCanvas = await findCanvas();
    const firstLanes = laneLabelsOf(firstCanvas);
    const firstBarLabels = barLabelsOf(firstCanvas);
    const firstRows = renderedNames();

    cleanup();

    const second = resolvingTrace(crossTierTree());

    renderComponent(makeNode(), { provider: second.provider, actions: makeActions().actions });

    const secondCanvas = await findCanvas();

    // Lane order and row order are decisions this component makes, and an
    // unstable sort in either would read as data that changed between renders.
    expect(laneLabelsOf(secondCanvas)).toEqual(firstLanes);
    expect(barLabelsOf(secondCanvas)).toEqual(firstBarLabels);
    expect(renderedNames()).toEqual(firstRows);

    // Stated against the fixture too, so the case cannot pass by being equally
    // wrong twice.
    expect(firstLanes).toEqual([...CHAIN_LANE_LABELS]);
    expect(firstRows).toEqual([...CHAIN_NAMES]);
  });
});
