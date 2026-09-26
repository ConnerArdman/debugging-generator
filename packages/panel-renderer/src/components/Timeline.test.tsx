/**
 * `components/Timeline` — the colocated suite for the product's most important
 * visualization.
 *
 * ## What this suite is protecting
 *
 * The `timeline` node is the one view that shows the whole correlated shape of
 * an interaction at once: the click, the request it made, the server span that
 * answered it and the datastore call underneath, on one axis, in lanes by tier.
 * `tests/e2e/demo-slow-interaction.spec.ts` proves that chain end to end
 * against a running application; this suite is the fast feedback loop for the
 * *rendering* half of the same story, and it is deliberately more than a smoke
 * test:
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
 *   - **Parent before child on a flat page.** A `spans` page is linked into a
 *     parent/child forest before it is drawn: a child whose clock reads
 *     earlier than its parent's still follows it, a subtree stays contiguous,
 *     siblings fall back to `ingestSeq` last, a parent cycle drops nothing and
 *     a row hanging beneath one still follows its parent, and a span whose
 *     parent is not loaded is marked "Parent not loaded" — never
 *     "Re-attached" — until a later page brings the parent.
 *   - **Partial results say so.** A `spans` page states how much of the result it
 *     holds and offers to load more; a `trace` the correlator truncated says
 *     that, with the refine route, instead of implying completeness.
 *   - **The drawn-row budget is absolute.** A walk longer than
 *     `MAX_DRAWN_ROWS` is drawn one window at a time: the canvas never holds
 *     more bars than the budget however often "Next spans" is pressed, every
 *     walked span is drawn in exactly one window, the footer states which rows
 *     are drawn and how many precede and follow them, no connector is drawn to
 *     a parent outside the window, focus passes to the other paging control at
 *     either end, a span result's further pages lengthen the walk without
 *     growing the window, a span selected elsewhere in the panel pages the
 *     window to it once, and a changed query starts again at its first row.
 *   - **Paging follows the service.** Each further page is requested at the
 *     `nextOffset` the previous response named, at the same page size, and
 *     appended with each record once; the loaded rows stay on screen while a
 *     page is in flight or after it failed, a next offset past 5,000 is still
 *     followed, a response naming none ends the walk whatever its total says,
 *     and a changed query starts again from its first page.
 *   - **An empty page is not an empty capture.** A `limit: 0` query states its
 *     total as a count and offers no paging; a page past the end, or short of
 *     it, states its position and the total; only a zero total, an untotalled
 *     first page or an empty trace says that nothing was captured.
 *   - **The canvas is not the only representation.** The SVG is `role="img"` with
 *     a text alternative, so its bars are deliberately outside the accessibility
 *     tree; the keyboard-reachable equivalent below it must therefore list every
 *     row and be operable.
 *   - **Descriptions are not hover-only.** A row that holds keyboard focus
 *     shows its description in its Operation cell, dismissed by Escape, and no
 *     row's name is a tab stop, so the table body stays one roving stop; the
 *     focused row drives the detail strip, whose name is the pointer's trigger
 *     for the same description and no tab stop of its own.
 *   - **The three states of a query-backed view** and the **click-to-source
 *     payload**, the contracts every query-backed component in this folder is
 *     held to.
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
 *     The correlated trees are **hand-constructed**: this package depends on
 *     `@debuggen/telemetry` for types only, so neither the component nor this
 *     suite may reach for its builders, and a fixture assembled by the very
 *     code under discussion would prove less.
 *   - **Generic fixture vocabulary only**: span names, a file path and a
 *     symbol belonging to no application, demonstration or otherwise — in the
 *     fixtures and in the comments alike.
 *   - **Layout is not stubbed.** No `getBoundingClientRect` override, no
 *     `ResizeObserver` polyfill and no size getter anywhere: the component reads
 *     no layout, so none is needed. The canvas is a fixed logical coordinate
 *     space — a `viewBox` `CHART_VIEWBOX_WIDTH` units wide, `width="100%"`,
 *     `preserveAspectRatio="xMinYMin meet"` — and its labels are fitted with
 *     the deterministic advance estimate of `../utils/format`, so the drawing
 *     is a pure function of the data, which is what every case asserts against
 *     under happy-dom's zero layout.
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

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';
import type { DataQuery, FlameNode, TimelineNode } from '@debuggen/panel-schema';
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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { kindColorVar, tierColorVar } from '../utils/color';
import {
  DEFAULT_LABEL_FONT_SIZE,
  ELLIPSIS,
  KIND_LABELS,
  NOT_AVAILABLE_LABEL,
  TIER_LABELS,
  createEstimateMeasure,
  formatCount,
  formatDuration,
  formatDurationCompact,
  formatKindLabel,
  formatOffset,
  formatTierLabel,
  splitGraphemes,
} from '../utils/format';
import {
  CHART_VIEWBOX_WIDTH,
  MAX_DRAWN_ROWS,
  alignHairline,
  layoutHeight,
  rowY,
} from '../utils/scale';
import { FlameChart } from './FlameChart';
import { Timeline } from './Timeline';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral: no component, route, service or
 * symbol of any inspected project appears here. The identifiers are shaped as
 * a capture shapes them — a 32-hex trace id, 16-hex span ids, epoch
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

/*
 * The shared error-state contract, spelled out rather than imported: these are
 * the words every query-backed node shows a reader, so a drift in any of them
 * is a change this suite notices rather than one it silently adopts.
 */

/** The title of a view whose own data could not be loaded. */
const VIEW_FAILURE_TITLE = 'Could not load this view';

/** The sentence every view failure's message opens with, before the provider's cause. */
const VIEW_FAILURE_LEAD = 'The data for this view could not be loaded.';

/** The title of a failed next page below rows that stay on screen. */
const PAGE_FAILURE_TITLE = 'Could not load the next page';

/** The sentence a failed next page's message opens with. */
const PAGE_FAILURE_LEAD =
  'The next page of this view could not be loaded. The rows already shown are unaffected.';

/** The title of a node whose query names a source this view cannot draw. */
const UNSUPPORTED_TITLE = 'This view cannot draw the requested data';

/** The key the retry control carries so the host can hand focus back to it after a remount. */
const RETRY_FOCUS_KEY = 'error-state-retry';

/** The visible summary of the closed technical-details disclosure. */
const TECHNICAL_DETAILS_LABEL = 'Technical details';

/** The flag the equivalent row carries for a node the correlator re-attached. */
const REATTACHED_FLAG = 'Re-attached';

/** The flag it carries when more than one parent was possible. */
const AMBIGUOUS_FLAG = 'Ambiguous parent';

/** The flag a flat-page row carries when the parent it names is not among the loaded rows. */
const PARENT_NOT_LOADED_FLAG = 'Parent not loaded';

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

/**
 * One page a stub provider can answer with: a correlated tree — or `null`, the
 * service's answer when no trace in the capture matched — or a span page.
 */
type TimelinePage =
  | { readonly source: 'trace'; readonly data: TraceTree | null }
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
 * renders.
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
 * keeps its bars out of the accessibility tree and is therefore sound only
 * alongside the keyboard-reachable equivalent every case below also asserts.
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

/** The text of each bar's label, in that same order; an unlabelled bar contributes nothing. */
function barLabelsOf(canvas: HTMLElement): string[] {
  return Array.from(canvas.querySelectorAll('text.dg-timeline__bar-label')).map(
    (label) => label.textContent ?? '',
  );
}

/** Whether each of those labels is drawn inside its bar or beside it, in the same order. */
function barLabelPlacementsOf(canvas: HTMLElement): ('inside' | 'beside')[] {
  return Array.from(canvas.querySelectorAll('text.dg-timeline__bar-label')).map((label) =>
    label.classList.contains('dg-timeline__bar-label--inside') ? 'inside' : 'beside',
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
 * Read off the row's header cell — obtained by role — and then off the trigger
 * box of the row's tooltip, which holds the name run and nothing else: the cell
 * also holds any correlation flag, and the description bubble, which stays
 * mounted open or closed, so the cell's own text would not be the name. The
 * trigger box is read rather than the element found through
 * `aria-describedby`, so finding a row never depends on the description link
 * the keyboard cases assert.
 *
 * @param row A data row.
 * @returns The name exactly as the capture carried it.
 */
function nameOf(row: HTMLElement): string {
  const header = within(row).getByRole('rowheader');

  return header.querySelector('.dg-tooltip__trigger')?.textContent ?? '';
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

/** The open description bubble inside `scope`, or `null` while every bubble in it is closed. */
function openBubbleIn(scope: Element): HTMLElement | null {
  return scope.querySelector<HTMLElement>('.dg-tooltip__bubble.dg-is-open');
}

/**
 * One row's description, as the tooltip in its header cell states it.
 *
 * Opened the way a pointer opens it — by resting on the row's name — read
 * while open, and closed again by moving away. A closed bubble is never read:
 * whether it stays in the document while closed is the primitive's decision,
 * not something this view's contract depends on.
 *
 * @param row A data row.
 * @returns The description's text.
 */
async function descriptionOf(row: HTMLElement): Promise<string> {
  const user = userEvent.setup();
  const trigger = nameTriggerOf(row);

  await user.hover(trigger);

  const bubble = await waitFor(() => {
    const open = openBubbleIn(row);
    if (open === null) {
      throw new Error('the row’s description did not open on hover');
    }
    return open;
  });
  const text = bubble.textContent ?? '';

  await user.unhover(trigger);

  return text;
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
    // empty state — an unsettled query is not an answer.
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
    // restatement of the sentence.
    const message = await screen.findByText(/no correlated spans were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-timeline__empty')).not.toBeNull();

    // Announced as the settled status, with the empty capture's own short title
    // and a decorative glyph beside the sentence, like every other view's.
    const state = screen.getByRole('status');
    expect(state.contains(message)).toBe(true);
    expect(state.querySelector('.dg-empty-state__title')?.textContent).toBe(NOTHING_CAPTURED_TITLE);
    expect(state.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');

    // An empty trace is a success, so it is drawn as an absence and not as a
    // failure — and there is nothing to place on an axis.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
  });

  it('renders its own empty message, not an error, when no trace matched the query', async () => {
    const stub = pagingProvider([{ source: 'trace', data: null }]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `null` is the service's answer for a capture that collected nothing
    // correlated: an empty capture, drawn as the same absence an empty tree is.
    const message = await screen.findByText(/no correlated spans were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-timeline__empty')).not.toBeNull();

    // No alert and so no retry, and nothing placed on an axis or in the table.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: RETRY_NAME })).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(soleQuery(stub)).toEqual({ source: 'trace', filter: { traceId: TRACE_ID } });
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

  it('renders a provider rejection through the shared error-state contract, naming the query it asked', async () => {
    const hint = 'Start the local service, then retry.';
    const details = { attempts: 3, endpoint: 'panel-data' };
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.', {
        hint,
        details,
      }),
    );
    const user = userEvent.setup();

    // A span node authoring no page size or offset: the query the view asks is
    // the authored one with both filled in, and that — not the authored one —
    // is what failed and what the reader must be shown.
    renderComponent(makeNode({ query: { source: 'spans', filter: { traceId: TRACE_ID } } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    // A lone failure is the assertive announcement.
    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-timeline__error')).not.toBeNull();

    // The one title, and the one message: the generic lead, then the
    // provider's own cause as a sentence of its own.
    const title = within(alert).getByText(VIEW_FAILURE_TITLE);
    expect(title.classList.contains('dg-error-state__title')).toBe(true);
    const message = within(alert).getByText((text) => text.startsWith(VIEW_FAILURE_LEAD));
    expect(message.classList.contains('dg-error-state__message')).toBe(true);
    expect(message.textContent).toContain('The channel to the service is closed.');

    // What the reader can do, on its own line, and the machine code as a chip.
    expect(within(alert).getByText(hint).classList.contains('dg-error-state__message')).toBe(true);
    expect(within(alert).getByText('TRANSPORT_DISCONNECTED').classList.contains('dg-badge')).toBe(
      true,
    );

    // The query block holds exactly the query the provider received, in the
    // one pretty-printed form every node prints. Looked up by name: the closed
    // details disclosure below it is a group too.
    // The expected text is built from a literal written in the formatter's
    // member order (source, filter, sort, limit, offset), so the spelling is
    // pinned independently of the order the query object was assembled in.
    const expected = {
      source: 'spans',
      filter: { traceId: TRACE_ID },
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
    };
    const asked = soleQuery(stub);
    expect(asked).toEqual(expected);
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual(asked);
    expect(shown.textContent).toBe(JSON.stringify(expected, null, 2));

    // Developer detail stays behind the closed disclosure, never on the lines
    // a panel reader meets first.
    const disclosure = within(alert).getByText(TECHNICAL_DETAILS_LABEL).closest('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(JSON.parse(disclosure?.querySelector('pre')?.textContent ?? '')).toEqual(details);

    // The retry carries the key the host restores focus by, and re-asks the
    // very query that failed.
    const retry = within(alert).getByRole('button', { name: RETRY_NAME });
    expect(retry.getAttribute('data-dg-focus-key')).toBe(RETRY_FOCUS_KEY);

    await user.click(retry);

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual(asked);
  });

  it('reports a node whose query names a source it cannot place on an axis, and asks for nothing', async () => {
    const stub = resolvingTrace(crossTierTree());

    renderComponent(makeNode({ query: { source: 'renders' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-timeline__error')).not.toBeNull();

    // The shared wording for a panel defect: what this view reads, from the
    // catalog, beside what it was asked for, under the panel-defect code.
    expect(within(alert).getByText(UNSUPPORTED_TITLE)).toBeTruthy();
    expect(alert.textContent).toContain('"trace" or "spans"');
    expect(alert.textContent).toContain('"renders"');
    expect(within(alert).getByText('PANEL_INVALID').classList.contains('dg-badge')).toBe(true);

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
      // no re-derivation from a url or a symbol.
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

    // Each bar's own label is that same name with a compact duration beside it,
    // whole wherever it fits. Every bar of the chain has room for its label: the
    // three that run almost to the window's end hold theirs inside the bar, and
    // the query, which ends well before the window does, has it after the bar,
    // on the lane surface.
    expect(barLabelsOf(canvas)).toEqual(
      CHAIN_EVENTS.map((event) => `${event.name} · ${formatDurationCompact(event.duration)}`),
    );
    expect(barLabelPlacementsOf(canvas)).toEqual(['inside', 'inside', 'inside', 'beside']);

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
      // the only inline value this view writes.
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

    // Ordered parent-first — each span after the span it names as its parent,
    // siblings in canonical order — whatever order the page arrived in.
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

    // The failure is reported below the rows, never in place of them, in the
    // page scope of the shared contract: its own title, and a lead saying the
    // rows above are unaffected before the provider's cause.
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(PAGE_FAILURE_TITLE)).toBeTruthy();
    expect(within(alert).queryByText(VIEW_FAILURE_TITLE)).toBeNull();
    const message = within(alert).getByText((text) => text.startsWith(PAGE_FAILURE_LEAD));
    expect(message.textContent).toContain(PAGE_FAILURE.message);
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

/*
 * ---------------------------------------------------------------------------
 * Empty pages are not empty captures
 *
 * The query contract makes `limit: 0` an explicit request for a total without
 * rows, and an offset past the end an empty page rather than an error; in both
 * the service may report a positive total. The cases below hold the view to
 * saying which of those it is looking at, and to saying "nothing was captured"
 * only when the total is zero — or unreported on the first page — or the
 * source is a correlated trace, which reports no total at all.
 * ---------------------------------------------------------------------------
 */

/** The empty state's title for a result that holds nothing to draw. */
const NOTHING_CAPTURED_TITLE = 'Nothing to place on the axis';

/** The empty state's message for a result that holds nothing to draw. */
const NOTHING_CAPTURED_MESSAGE = 'No correlated spans were captured for this interaction.';

/** The empty state's title for a page that holds nothing while the result may not. */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/** The empty state's title for a span query authored with `limit: 0`. */
const COUNT_ONLY_TITLE = 'Count only';

/**
 * Waits for the view's empty state and asserts its title and message, and that
 * nothing else is drawn in its place.
 *
 * @param title The title the empty state must carry.
 * @param message The message the empty state must carry.
 */
async function expectEmptyState(title: string, message: string): Promise<void> {
  const rendered = await screen.findByText(message);
  expect(rendered.classList.contains('dg-empty-state__message')).toBe(true);

  const slot = rendered.closest('.dg-timeline__empty');
  expect(slot).not.toBeNull();
  expect(slot?.querySelector('.dg-empty-state__title')?.textContent).toBe(title);

  // The settled answer is the polite status, and only the empty capture
  // carries the view's decorative glyph: an empty page or a count-only answer
  // is a statement about paging, named by its title.
  expect(screen.getByRole('status')).toBe(slot?.querySelector('.dg-empty-state'));
  expect(slot?.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden') ?? null).toBe(
    message === NOTHING_CAPTURED_MESSAGE ? 'true' : null,
  );

  // An empty state is a success drawn as an absence: no canvas, no table, no
  // failure and no loading indicator.
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByRole('grid')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('status', { busy: true })).toBeNull();
}

describe('Timeline empty pages', () => {
  it.each([
    ['echoes the offset it answered', 0],
    ['names a forward offset', 5],
  ])(
    'states the total of a count-only query, and offers no page, when its response %s',
    async (_description: string, nextOffset: number) => {
      const stub = offsetPagedProvider(
        pagesByOffset(new Map<number, SpanPageAnswer>([[0, { data: [], total: 42, nextOffset }]])),
      );

      renderComponent(pagedSpansNode(0), {
        provider: stub.provider,
        actions: makeActions().actions,
      });

      await expectEmptyState(
        COUNT_ONLY_TITLE,
        `This view requests a count without rows: ${formatCount(42)} spans matched its query.`,
      );
      expect(screen.queryByText(NOTHING_CAPTURED_MESSAGE)).toBeNull();

      // Every page of a zero-size query is empty, so no paging is offered and
      // nothing more is requested, whatever the response named.
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
      expect(stub.resolve).toHaveBeenCalledTimes(1);

      // The explicit zero is sent as written, never rounded up into a row.
      const request = pageRequest(stub, 1);
      expect(request.limit).toBe(0);
      expect(request.offset).toBe(0);
    },
  );

  it('names a single matched span in the singular under a count-only query', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(new Map<number, SpanPageAnswer>([[0, { data: [], total: 1 }]])),
    );

    renderComponent(pagedSpansNode(0), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      COUNT_ONLY_TITLE,
      `This view requests a count without rows: ${formatCount(1)} span matched its query.`,
    );
  });

  it('says no total was reported for a count-only query answered without one', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(new Map<number, SpanPageAnswer>([[0, { data: [] }]])),
    );

    renderComponent(pagedSpansNode(0), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      COUNT_ONLY_TITLE,
      'This view requests a count without rows, and no total was reported for its query.',
    );
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('says an authored offset past the end starts past the result, and names its total', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(new Map<number, SpanPageAnswer>([[200, { data: [], total: 42 }]])),
    );

    renderComponent(pagedSpansNode(2, 200), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(201)}, past the end of the ${formatCount(
        42,
      )} spans that matched this query.`,
    );
    expect(screen.queryByText(NOTHING_CAPTURED_MESSAGE)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    const request = pageRequest(stub, 1);
    expect(request.offset).toBe(200);
    expect(request.limit).toBe(2);
  });

  it('places a later empty page at the offset the service named, not at the authored one', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [], total: 2, nextOffset: 2 }],
          [2, { data: [], total: 2 }],
        ]),
      ),
    );
    const user = userEvent.setup();

    renderComponent(pagedSpansNode(2), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(`Showing ${formatCount(0)} of ${formatCount(2)} spans.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(3)}, past the end of the ${formatCount(
        2,
      )} spans that matched this query.`,
    );
    expect(pageRequest(stub, 2).offset).toBe(2);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(2);
  });

  it('names the total when an empty page falls short of the end of the result', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(new Map<number, SpanPageAnswer>([[10, { data: [], total: 42 }]])),
    );

    renderComponent(pagedSpansNode(2, 10), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `${formatCount(42)} spans matched this query, but none are shown on this page.`,
    );
    expect(screen.queryByText(NOTHING_CAPTURED_MESSAGE)).toBeNull();
  });

  it('states the position of an empty page past the first row when no total was reported', async () => {
    const stub = offsetPagedProvider(
      pagesByOffset(new Map<number, SpanPageAnswer>([[5, { data: [] }]])),
    );

    renderComponent(pagedSpansNode(2, 5), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(
        6,
      )} and holds no spans; no total was reported for this query.`,
    );
    expect(screen.queryByText(NOTHING_CAPTURED_MESSAGE)).toBeNull();
  });

  it.each([
    ['reports a total of zero on its first page', 0, { data: [], total: 0 }],
    ['reports a total of zero past its first page', 200, { data: [], total: 0 }],
    ['reports no total on its first page', 0, { data: [] }],
  ])(
    'says nothing was captured when a span result %s',
    async (_description: string, offset: number, answer: SpanPageAnswer) => {
      const stub = offsetPagedProvider(
        pagesByOffset(new Map<number, SpanPageAnswer>([[offset, answer]])),
      );

      renderComponent(pagedSpansNode(2, offset), {
        provider: stub.provider,
        actions: makeActions().actions,
      });

      await expectEmptyState(NOTHING_CAPTURED_TITLE, NOTHING_CAPTURED_MESSAGE);
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    },
  );

  it.each([
    ['with no limit', undefined],
    ['authored with a limit of zero', 0],
  ])(
    'keeps the empty-capture copy for a correlated trace that holds nothing, %s',
    async (_description: string, limit: number | undefined) => {
      const stub = resolvingTrace(makeTree([]));

      renderComponent(
        makeNode({
          query: {
            source: 'trace',
            filter: { traceId: TRACE_ID },
            ...(limit === undefined ? {} : { limit }),
          },
        }),
        { provider: stub.provider, actions: makeActions().actions },
      );

      // A trace reports no total, so its absence is the capture's.
      await expectEmptyState(NOTHING_CAPTURED_TITLE, NOTHING_CAPTURED_MESSAGE);
      expect(screen.queryByText(COUNT_ONLY_TITLE)).toBeNull();
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    },
  );
});

/**
 * The most bars one window draws, restated so the counts below are stated —
 * and checked against the scale module's own budget in the first case that
 * relies on it, so a change to either is noticed.
 */
const DRAWN_ROW_BUDGET = 2000;

/**
 * The time a case that draws full windows is allowed, in milliseconds.
 *
 * Each full window is two thousand bars with their labels and titles, which
 * the layout-free DOM builds in about a second; a case that pages through
 * several windows exceeds the runner's five-second default on a shared,
 * loaded machine without anything being wrong. Generous, not unbounded: a
 * window that never settles still fails the case.
 */
const WINDOW_CASE_TIMEOUT_MS = 30_000;

/**
 * Children under the long trace's root: with the root, 4,501 rows — two full
 * windows and a third of 501, so paging reaches a last window that is not full.
 */
const LONG_CHILD_COUNT = 4500;

/** The rows the long trace's walk holds: its root and every child. */
const LONG_TRACE_ROWS = LONG_CHILD_COUNT + 1;

/** The control that moves the drawn window back by one window. */
const PREVIOUS_SPANS_NAME = 'Previous spans';

/** The control that moves the drawn window on by one window. */
const NEXT_SPANS_NAME = 'Next spans';

/** The refine route the footer gives for a trace the correlator bounded. */
const REFINE_TRUNCATED_TRACE = 'Narrow the query or capture a shorter interaction to see the rest.';

/** The span id of the long trace's root, which every child names as its parent. */
const LONG_ROOT_SPAN_ID = spanIdFor(5000);

/** The event id of the long trace's root. */
const LONG_ROOT_ID = 'event-example-wide-root';

/** The operation name of the long trace's root. */
const LONG_ROOT_NAME = 'example.batch';

/** The event id of the long trace's child at `index`. */
function longChildId(index: number): string {
  return `event-example-wide-${String(index).padStart(4, '0')}`;
}

/** The operation name of the long trace's child at `index`. */
function longChildName(index: number): string {
  return `example.step.${String(index).padStart(4, '0')}`;
}

/**
 * A trace longer than one drawn window: one root and `childCount`
 * back-to-back 1 ms operations under it, so the walk is the root followed by
 * every child in order and a child's walk position is its index plus one.
 *
 * @param childCount How many children the root has.
 * @returns The correlated trace.
 */
function wideTrace(childCount: number = LONG_CHILD_COUNT): TraceTree {
  const rootSpanId = LONG_ROOT_SPAN_ID;
  const children = Array.from({ length: childCount }, (_unused, index) =>
    makeTraceNode(
      makeEvent({
        id: longChildId(index),
        spanId: spanIdFor(6000 + index),
        parentSpanId: rootSpanId,
        kind: 'function',
        name: longChildName(index),
        tier: 'server',
        startTime: BASE_START_MS + index,
        duration: 1,
        producerId: SERVER_PRODUCER_ID,
        seq: index + 1,
        ingestSeq: index + 2,
      }),
      { depth: 1 },
    ),
  );

  return makeTree([
    makeTraceNode(
      makeEvent({
        id: LONG_ROOT_ID,
        spanId: rootSpanId,
        kind: 'route.handler',
        name: LONG_ROOT_NAME,
        tier: 'server',
        startTime: BASE_START_MS,
        duration: childCount,
        producerId: SERVER_PRODUCER_ID,
        seq: 0,
        ingestSeq: 1,
      }),
      { depth: 0, children },
    ),
  ]);
}

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

    // The correlator's own truncation, stated as the sentence it is, with the
    // one route that reaches the rest.
    expect(
      screen.getByText(
        `${formatCount(CHAIN_EVENTS.length)} spans shown. More were captured than this view holds. ${REFINE_TRUNCATED_TRACE}`,
      ),
    ).toBeDefined();
    expect(
      within(screen.getByRole('group', { name: 'Timeline summary' })).getByText('Partial result'),
    ).toBeDefined();

    // A trace is not a paged source, and nothing more of this one is in memory,
    // so there is neither a page to ask for nor another window to move to.
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: PREVIOUS_SPANS_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: NEXT_SPANS_NAME })).toBeNull();
  });
});

/**
 * The footer's statement of a partial window, spelled out as the reader reads
 * it: the 1-based range drawn, the walk it was cut from, and how many rows lie
 * before and after it undrawn.
 *
 * @param first The first drawn row, 1-based.
 * @param last The last drawn row, 1-based.
 * @param total How many rows the walk holds.
 * @param before How many rows precede the window.
 * @param after How many rows follow it.
 */
function windowFooter(
  first: number,
  last: number,
  total: number,
  before: number,
  after: number,
): string {
  const undrawn = [
    ...(before > 0 ? [`${formatCount(before)} before them`] : []),
    ...(after > 0 ? [`${formatCount(after)} after them`] : []),
  ];

  return `Spans ${formatCount(first)}–${formatCount(last)} of ${formatCount(
    total,
  )} are drawn; ${undrawn.join(' and ')} ${before + after === 1 ? 'is' : 'are'} not.`;
}

/** A flat span record of a long result: a root of its own, 1 ms after the one before it. */
function longResultSpan(index: number): TelemetryEvent {
  return makeEvent({
    id: `event-example-flat-${String(index).padStart(4, '0')}`,
    spanId: spanIdFor(9000 + index),
    kind: 'function',
    name: `example.flat.${String(index).padStart(4, '0')}`,
    tier: 'server',
    startTime: BASE_START_MS + index,
    duration: 1,
    producerId: SERVER_PRODUCER_ID,
    seq: index,
    ingestSeq: index + 1,
  });
}

/*
 * Every case below draws at least one full window of two thousand bars, so the
 * group runs under {@link WINDOW_CASE_TIMEOUT_MS} rather than the default.
 */
describe('Timeline drawn-row window', { timeout: WINDOW_CASE_TIMEOUT_MS }, () => {
  it('draws a trace longer than one window a window at a time, says which rows are drawn, and pages without asking for more', async () => {
    // The budget this suite restates is the scale module's own.
    expect(MAX_DRAWN_ROWS).toBe(DRAWN_ROW_BUDGET);
    const tree = wideTrace();
    expect(tree.nodeCount).toBe(LONG_TRACE_ROWS);
    const stub = resolvingTrace(tree);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // The first window: which rows it draws and how many follow it undrawn,
    // in the footer and in the picture's own text alternative.
    const footer = screen.getByText(
      windowFooter(1, DRAWN_ROW_BUDGET, LONG_TRACE_ROWS, 0, LONG_TRACE_ROWS - DRAWN_ROW_BUDGET),
    );
    expect(footer.getAttribute('aria-live')).toBe('polite');
    expect(canvas.getAttribute('aria-label')).toContain(
      `${formatCount(DRAWN_ROW_BUDGET)} of ${formatCount(LONG_TRACE_ROWS)} spans (spans ${formatCount(
        1,
      )}–${formatCount(DRAWN_ROW_BUDGET)})`,
    );
    expect(barsOf(canvas)).toHaveLength(DRAWN_ROW_BUDGET);
    expect(barTitled(canvas, LONG_ROOT_NAME)).toBeDefined();
    // The root is drawn in this window, so every child drawn with it is joined to it.
    expect(edgesOf(canvas)).toHaveLength(DRAWN_ROW_BUDGET - 1);
    expect(within(summaryStrip()).getByText('Partial result')).toBeDefined();
    // The table is the same window, and its name says so rather than "every span".
    expect(
      screen.getByRole('grid', {
        name: (name) =>
          name.includes(
            `spans ${formatCount(1)}–${formatCount(DRAWN_ROW_BUDGET)} of the ${formatCount(
              LONG_TRACE_ROWS,
            )} captured spans`,
          ),
      }),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: PREVIOUS_SPANS_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // The walk is in memory whole, so moving the window asks the provider nothing.
    await user.click(screen.getByRole('button', { name: NEXT_SPANS_NAME }));
    await screen.findByText(
      windowFooter(
        DRAWN_ROW_BUDGET + 1,
        DRAWN_ROW_BUDGET * 2,
        LONG_TRACE_ROWS,
        DRAWN_ROW_BUDGET,
        LONG_TRACE_ROWS - DRAWN_ROW_BUDGET * 2,
      ),
    );
    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The second window starts at walk row 2,000 — the child at index 1,999 —
    // and holds no more bars than the first. Its rows' parent, the root, is not
    // drawn here, so no connector is invented to another row, and each row's
    // description says where its parent is.
    const second = await findCanvas();
    const secondBars = barsOf(second);
    expect(secondBars).toHaveLength(DRAWN_ROW_BUDGET);
    expect(
      secondBars[0]?.querySelector('title')?.textContent?.startsWith(longChildName(1999)),
    ).toBe(true);
    expect(() => barTitled(second, LONG_ROOT_NAME)).toThrow();
    expect(edgesOf(second)).toHaveLength(0);
    expect(barTitled(second, longChildName(1999)).querySelector('title')?.textContent).toContain(
      `Its parent span ${LONG_ROOT_SPAN_ID} is span ${formatCount(
        1,
      )} of this view, outside the spans drawn now, so no connector is drawn to it.`,
    );
    // Every window is drawn on the whole walk's axis.
    expect(second.getAttribute('aria-label')).toContain(`over ${formatDuration(LONG_CHILD_COUNT)}`);
    expect(canvas.getAttribute('aria-label')).toContain(`over ${formatDuration(LONG_CHILD_COUNT)}`);

    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('hands focus to the other paging control when the window reaches either end of the walk', async () => {
    // One full window and a short one: 2,101 rows.
    const childCount = DRAWN_ROW_BUDGET + 100;
    const rows = childCount + 1;
    const stub = resolvingTrace(wideTrace(childCount));
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await findCanvas();
    expect(screen.queryByRole('button', { name: PREVIOUS_SPANS_NAME })).toBeNull();

    // The last window is short, and the control that reached it goes away:
    // focus moves to the control that pages back, not to the document.
    await user.click(screen.getByRole('button', { name: NEXT_SPANS_NAME }));
    await screen.findByText(windowFooter(DRAWN_ROW_BUDGET + 1, rows, rows, DRAWN_ROW_BUDGET, 0));
    expect(barsOf(await findCanvas())).toHaveLength(rows - DRAWN_ROW_BUDGET);
    expect(screen.queryByRole('button', { name: NEXT_SPANS_NAME })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: PREVIOUS_SPANS_NAME }));

    // Back at the first window, focus moves the other way.
    await user.click(screen.getByRole('button', { name: PREVIOUS_SPANS_NAME }));
    await screen.findByText(windowFooter(1, DRAWN_ROW_BUDGET, rows, 0, rows - DRAWN_ROW_BUDGET));
    expect(barsOf(await findCanvas())).toHaveLength(DRAWN_ROW_BUDGET);
    expect(screen.queryByRole('button', { name: PREVIOUS_SPANS_NAME })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: NEXT_SPANS_NAME }));
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('never draws more than the budget however often Next is pressed, and every walked span is drawn in exactly one window', async () => {
    const tree = wideTrace();
    const stub = resolvingTrace(tree);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await findCanvas();

    const drawnEvents = new Map<string, number>();
    let windows = 0;
    const record = (canvas: HTMLElement): void => {
      const bars = barsOf(canvas);
      expect(bars.length).toBeGreaterThan(0);
      expect(bars.length).toBeLessThanOrEqual(DRAWN_ROW_BUDGET);
      windows += 1;
      for (const bar of bars) {
        const title = bar.querySelector('title')?.textContent ?? '';
        drawnEvents.set(title, (drawnEvents.get(title) ?? 0) + 1);
      }
    };

    record(await findCanvas());
    // Next is pressed for as long as it is offered; it is withdrawn at the last
    // window, so no press can move the window past the walk's end.
    for (;;) {
      const next = screen.queryByRole('button', { name: NEXT_SPANS_NAME });
      if (next === null) {
        break;
      }
      const before = screen.getByText(/^Spans /).textContent;
      await user.click(next);
      await waitFor(() => {
        expect(screen.getByText(/^Spans /).textContent).not.toBe(before);
      });
      record(await findCanvas());
      // While the control remains — a middle window — it keeps focus.
      const remaining = screen.queryByRole('button', { name: NEXT_SPANS_NAME });
      if (remaining !== null) {
        expect(document.activeElement).toBe(remaining);
      }
    }

    // Three windows for 4,501 rows, and every row of the walk drawn once: the
    // window moved over the walk, it never grew and never skipped a row.
    expect(windows).toBe(Math.ceil(LONG_TRACE_ROWS / DRAWN_ROW_BUDGET));
    expect(drawnEvents.size).toBe(LONG_TRACE_ROWS);
    expect([...drawnEvents.values()].every((count) => count === 1)).toBe(true);
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
  it('starts again from the first window when the node’s query changes', async () => {
    const stub = resolvingTrace(wideTrace());
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

    const view = render(withHost(makeNode()));
    await findCanvas();
    await user.click(screen.getByRole('button', { name: NEXT_SPANS_NAME }));
    await screen.findByText(
      windowFooter(
        DRAWN_ROW_BUDGET + 1,
        DRAWN_ROW_BUDGET * 2,
        LONG_TRACE_ROWS,
        DRAWN_ROW_BUDGET,
        LONG_TRACE_ROWS - DRAWN_ROW_BUDGET * 2,
      ),
    );

    // Same node, a different query: its walk is drawn from its first row, not
    // from the window the previous query was paged to.
    view.rerender(
      withHost(
        makeNode({ query: { source: 'trace', filter: { traceId: TRACE_ID, tier: 'server' } } }),
      ),
    );

    await screen.findByText(
      windowFooter(1, DRAWN_ROW_BUDGET, LONG_TRACE_ROWS, 0, LONG_TRACE_ROWS - DRAWN_ROW_BUDGET),
    );
    expect(barTitled(await findCanvas(), LONG_ROOT_NAME)).toBeDefined();
    expect(screen.queryByRole('button', { name: PREVIOUS_SPANS_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(2);
  });

  it('pages the window to a span selected elsewhere in the panel, once, and marks nothing it does not draw', async () => {
    const stub = resolvingTrace(wideTrace());
    const spies = makeActions();
    const user = userEvent.setup();
    // The child at index 4,200 is walk row 4,201: in the third window.
    const late: PanelSelectionState = { selection: { eventId: longChildId(4200) } };

    const { rerender } = render(
      hostedTree(<Timeline node={makeNode()} />, stub.provider, spies.actions, late),
    );

    // The window holding the selected span is drawn, and the span is marked
    // on the canvas and in the table.
    await screen.findByText(
      windowFooter(
        DRAWN_ROW_BUDGET * 2 + 1,
        LONG_TRACE_ROWS,
        LONG_TRACE_ROWS,
        DRAWN_ROW_BUDGET * 2,
        0,
      ),
    );
    expect(selectedBars()).toHaveLength(1);
    expect(
      barTitled(timelineCanvas(), longChildName(4200)).classList.contains('dg-is-selected'),
    ).toBe(true);

    // Paging away is the reader's choice and is kept: the window is not pulled
    // back to the selection, and the selection it no longer draws is marked
    // nowhere — no stale mark on a bar or a row of another window.
    await user.click(screen.getByRole('button', { name: PREVIOUS_SPANS_NAME }));
    await screen.findByText(
      windowFooter(
        DRAWN_ROW_BUDGET + 1,
        DRAWN_ROW_BUDGET * 2,
        LONG_TRACE_ROWS,
        DRAWN_ROW_BUDGET,
        LONG_TRACE_ROWS - DRAWN_ROW_BUDGET * 2,
      ),
    );
    expect(selectedBars()).toHaveLength(0);
    expect(dataRows().some((row) => row.getAttribute('aria-selected') === 'true')).toBe(false);

    // A new selection, by trace and span, in the first window: the window
    // follows it there.
    rerender(
      hostedTree(<Timeline node={makeNode()} />, stub.provider, spies.actions, {
        selection: {
          eventId: 'event-example-elsewhere',
          traceId: TRACE_ID,
          spanId: spanIdFor(6000 + 10),
        },
      }),
    );
    await screen.findByText(
      windowFooter(1, DRAWN_ROW_BUDGET, LONG_TRACE_ROWS, 0, LONG_TRACE_ROWS - DRAWN_ROW_BUDGET),
    );
    expect(
      barTitled(timelineCanvas(), longChildName(10)).classList.contains('dg-is-selected'),
    ).toBe(true);
    expect(selectedBars()).toHaveLength(1);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('bounds a span result the same way: a further page lengthens the walk and never grows the drawn window', async () => {
    const pageSize = 1500;
    const firstPage = Array.from({ length: pageSize }, (_unused, index) => longResultSpan(index));
    const secondPage = Array.from({ length: pageSize }, (_unused, index) =>
      longResultSpan(pageSize + index),
    );
    const total = pageSize * 2;
    const stub = pagingProvider([
      { source: 'spans', data: firstPage, total, nextOffset: pageSize },
      { source: 'spans', data: secondPage, total },
    ]);
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'spans', filter: { traceId: TRACE_ID }, limit: pageSize } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // One page fits one window: every loaded row is drawn and nothing is paged.
    await screen.findByText(`Showing ${formatCount(pageSize)} of ${formatCount(total)} spans.`);
    expect(barsOf(await findCanvas())).toHaveLength(pageSize);
    expect(screen.queryByRole('button', { name: NEXT_SPANS_NAME })).toBeNull();

    // The second page makes the loaded walk longer than one window: the
    // canvas still draws the budget, and the footer states the total, what is
    // loaded and which of the loaded rows are drawn.
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(
      `Showing ${formatCount(total)} of ${formatCount(total)} spans. ${windowFooter(
        1,
        DRAWN_ROW_BUDGET,
        total,
        0,
        total - DRAWN_ROW_BUDGET,
      )}`,
    );
    expect(barsOf(await findCanvas())).toHaveLength(DRAWN_ROW_BUDGET);
    expect(within(summaryStrip()).getByText('Partial result')).toBeDefined();

    // The rest of the loaded rows are one window on, and the provider is not
    // asked again for rows it has already sent.
    await user.click(screen.getByRole('button', { name: NEXT_SPANS_NAME }));
    await screen.findByText(
      `Showing ${formatCount(total)} of ${formatCount(total)} spans. ${windowFooter(
        DRAWN_ROW_BUDGET + 1,
        total,
        total,
        DRAWN_ROW_BUDGET,
        0,
      )}`,
    );
    expect(barsOf(await findCanvas())).toHaveLength(total - DRAWN_ROW_BUDGET);
    expect(stub.resolve).toHaveBeenCalledTimes(2);
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
 * from the picture.
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
    const description = await descriptionOf(row);
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
    expect(await descriptionOf(row)).toContain(AMBIGUOUS_CANDIDATE_SPAN_ID);
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
    expect(await descriptionOf(row)).toContain(`Re-attached to the root (${MISSING_PARENT})`);

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
 * Span order on a flat page
 *
 * The canonical order within a trace is parent-before-child, then `startTime`,
 * then `(producerId, seq)`, then `ingestSeq` (`docs/ARCHITECTURE.md`,
 * "Ordering"). A `spans` page has no tree to walk, so the component links the
 * loaded rows into one before drawing them. Every fixture below is built so
 * that a pure time order would draw it differently, and each is served out of
 * order, so a case can only pass when the structure — not the arrival order
 * and not the clock — decided the rows.
 * ---------------------------------------------------------------------------
 */

/** A `spans` node over the fixture trace, with the published default page size. */
function spansNode(): TimelineNode {
  return makeNode({ query: { source: 'spans', filter: { traceId: TRACE_ID } } });
}

/** A second fixture trace, for a page with no trace filter: 32 lower-case hex digits. */
const SECOND_TRACE_ID = 'c8d2e3f405162738495a6b7c8d9e0f1a';

describe('Timeline span order', () => {
  it('draws a parent before a child whose clock reads earlier, and joins the two', async () => {
    // Two producers read two clocks and no alignment is applied, so a server
    // child can start a millisecond "before" the browser span that caused it.
    const parent = makeEvent({
      id: 'event-example-0101',
      spanId: spanIdFor(0x11),
      kind: 'fetch',
      name: 'example.parent',
      tier: 'browser',
      startTime: BASE_START_MS + 1000,
      duration: 40,
      producerId: BROWSER_PRODUCER_ID,
      seq: 0,
      ingestSeq: 1,
    });
    const child = makeEvent({
      id: 'event-example-0102',
      spanId: spanIdFor(0x12),
      parentSpanId: parent.spanId,
      kind: 'http.server',
      name: 'example.child',
      tier: 'server',
      startTime: BASE_START_MS + 999,
      duration: 30,
      producerId: SERVER_PRODUCER_ID,
      seq: 0,
      ingestSeq: 2,
    });
    const stub = resolvingSpans([child, parent]);

    renderComponent(spansNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // The parent first in the equivalent table and on the canvas alike.
    expect(renderedNames()).toEqual([parent.name, child.name]);

    const [firstBar, secondBar] = barsOf(canvas);
    expect(barsOf(canvas)).toHaveLength(2);
    expect(firstBar).toBe(barTitled(canvas, parent.name));
    expect(secondBar).toBe(barTitled(canvas, child.name));

    // The relationship is drawn, and the child's parent is loaded, so it is not
    // flagged as missing one.
    expect(edgesOf(canvas)).toHaveLength(1);
    expect(within(rowNamed(child.name)).queryByText(PARENT_NOT_LOADED_FLAG)).toBeNull();
    expect(within(rowNamed(parent.name)).queryByText(PARENT_NOT_LOADED_FLAG)).toBeNull();
  });

  it('breaks a tie on start, producer and sequence by arrival order, not by id', async () => {
    const arrivedFirst = makeEvent({
      id: 'event-example-0202',
      spanId: spanIdFor(0x21),
      name: 'example.arrived-first',
      startTime: BASE_START_MS,
      producerId: BROWSER_PRODUCER_ID,
      seq: 3,
      ingestSeq: 1,
    });
    const arrivedSecond = makeEvent({
      id: 'event-example-0201',
      spanId: spanIdFor(0x22),
      name: 'example.arrived-second',
      startTime: BASE_START_MS,
      producerId: BROWSER_PRODUCER_ID,
      seq: 3,
      ingestSeq: 2,
    });

    // The ids order the two the other way round, so an id tie-break reached
    // before `ingestSeq` would reverse the rows.
    expect(arrivedSecond.id < arrivedFirst.id).toBe(true);

    const stub = resolvingSpans([arrivedSecond, arrivedFirst]);

    renderComponent(spansNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();

    expect(renderedNames()).toEqual([arrivedFirst.name, arrivedSecond.name]);
  });

  it('keeps a subtree contiguous: a later root follows every descendant of an earlier one', async () => {
    const firstRoot = makeEvent({
      id: 'event-example-0301',
      spanId: spanIdFor(0x31),
      name: 'example.first-root',
      startTime: BASE_START_MS,
      duration: 80,
      seq: 0,
      ingestSeq: 1,
    });
    const earlyChild = makeEvent({
      id: 'event-example-0302',
      spanId: spanIdFor(0x32),
      parentSpanId: firstRoot.spanId,
      kind: 'fetch',
      name: 'example.early-child',
      startTime: BASE_START_MS + 10,
      duration: 20,
      seq: 1,
      ingestSeq: 2,
    });
    const secondRoot = makeEvent({
      id: 'event-example-0303',
      spanId: spanIdFor(0x33),
      name: 'example.second-root',
      startTime: BASE_START_MS + 20,
      duration: 10,
      seq: 2,
      ingestSeq: 3,
    });
    const lateChild = makeEvent({
      id: 'event-example-0304',
      spanId: spanIdFor(0x34),
      parentSpanId: firstRoot.spanId,
      kind: 'fetch',
      name: 'example.late-child',
      startTime: BASE_START_MS + 50,
      duration: 20,
      seq: 3,
      ingestSeq: 4,
    });
    const stub = resolvingSpans([secondRoot, lateChild, firstRoot, earlyChild]);

    renderComponent(spansNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // Time order would put the second root between the two children; the
    // children are siblings, so they are ordered by their own start instead.
    expect(renderedNames()).toEqual([
      firstRoot.name,
      earlyChild.name,
      lateChild.name,
      secondRoot.name,
    ]);
    expect(edgesOf(canvas)).toHaveLength(2);
  });

  it('marks a span whose parent is on a page not loaded yet, and re-links it when that page arrives', async () => {
    // The server half of the chain arrives first; the browser half that caused
    // it is on the next page.
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [SERVER_EVENT, QUERY_EVENT], total: 4, nextOffset: 2 }],
          [2, { data: [INTERACTION_EVENT, FETCH_EVENT], total: 4 }],
        ]),
      ),
    );
    const user = userEvent.setup();

    renderComponent(pagedSpansNode(2), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(4)} spans.`);
    expect(renderedNames()).toEqual([SERVER_EVENT.name, QUERY_EVENT.name]);

    // The server span names a parent this view does not hold: it says so, names
    // the span it is waiting for, and does not claim the parent never arrived.
    const server = rowNamed(SERVER_EVENT.name);
    expect(within(server).getByText(PARENT_NOT_LOADED_FLAG)).toBeDefined();
    expect(within(server).queryByText(REATTACHED_FLAG)).toBeNull();

    const description = await descriptionOf(server);
    expect(description).toContain(spanIdFor(2));
    expect(description).not.toContain(REATTACHED_FLAG);

    // Not an orphan in the drawing either: that state belongs to the correlator.
    const canvas = screen.getByRole('img');
    for (const bar of barsOf(canvas)) {
      expect(bar.classList.contains('dg-is-orphan')).toBe(false);
      expect(bar.classList.contains('dg-is-orphaned')).toBe(false);
    }

    // The datastore call's parent IS loaded: no flag, and its connector is drawn.
    expect(within(rowNamed(QUERY_EVENT.name)).queryByText(PARENT_NOT_LOADED_FLAG)).toBeNull();
    expect(edgesOf(canvas)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The page that brought the parent re-links the rows already on screen
    // beneath it, and the mark goes with the gap it described.
    await screen.findByText(`Showing ${formatCount(4)} of ${formatCount(4)} spans.`);
    expect(renderedNames()).toEqual([...CHAIN_NAMES]);
    expect(screen.queryAllByText(PARENT_NOT_LOADED_FLAG)).toHaveLength(0);
    expect(edgesOf(screen.getByRole('img'))).toHaveLength(CHAIN_EVENTS.length - 1);
  });

  it('expands a duplicated span id under its first record, and joins the child to that record', async () => {
    // Two records carry one span id; the child that names it starts after both.
    const firstCarrier = makeEvent({
      id: 'event-example-0401',
      spanId: spanIdFor(0x41),
      name: 'example.first-carrier',
      startTime: BASE_START_MS,
      duration: 50,
      seq: 0,
      ingestSeq: 1,
    });
    const secondCarrier = makeEvent({
      id: 'event-example-0402',
      spanId: spanIdFor(0x41),
      name: 'example.second-carrier',
      startTime: BASE_START_MS + 100,
      duration: 50,
      seq: 1,
      ingestSeq: 2,
    });
    const sharedChild = makeEvent({
      id: 'event-example-0403',
      spanId: spanIdFor(0x42),
      parentSpanId: spanIdFor(0x41),
      kind: 'fetch',
      name: 'example.shared-child',
      startTime: BASE_START_MS + 200,
      duration: 10,
      seq: 2,
      ingestSeq: 3,
    });
    const stub = resolvingSpans([secondCarrier, sharedChild, firstCarrier]);

    renderComponent(spansNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    expect(renderedNames()).toEqual([firstCarrier.name, sharedChild.name, secondCarrier.name]);

    // One connector, and it leaves the record the child is drawn beneath.
    const edges = edgesOf(canvas);
    expect(edges).toHaveLength(1);

    const parentX = alignHairline(Number(barTitled(canvas, firstCarrier.name).getAttribute('x')));
    const otherX = alignHairline(Number(barTitled(canvas, secondCarrier.name).getAttribute('x')));
    expect(parentX).not.toBe(otherX);
    expect((edges[0]?.getAttribute('d') ?? '').startsWith(`M ${String(parentX)} `)).toBe(true);
  });

  it('looks for a parent only inside its own trace when an unfiltered page holds several', async () => {
    // Span ids are unique only within a trace, and a page with no trace filter
    // mixes traces: a root of the fixture trace carries the very span id that a
    // row of the second trace names as its parent. That row's real parent — the
    // same span id, in its own trace — is on the next page, and its clock reads
    // later than the child's, so neither time order nor a bare span id lookup
    // draws the rows the way their traces do.
    const collidingRoot = makeEvent({
      id: 'event-example-0701',
      spanId: spanIdFor(0x71),
      name: 'example.colliding-root',
      startTime: BASE_START_MS,
      duration: 60,
      seq: 0,
      ingestSeq: 1,
    });
    const secondTraceChild = makeEvent({
      id: 'event-example-0702',
      traceId: SECOND_TRACE_ID,
      spanId: spanIdFor(0x72),
      parentSpanId: spanIdFor(0x71),
      kind: 'fetch',
      name: 'example.second-trace-child',
      startTime: BASE_START_MS + 3,
      duration: 20,
      seq: 1,
      ingestSeq: 2,
    });
    const secondTraceRoot = makeEvent({
      id: 'event-example-0703',
      traceId: SECOND_TRACE_ID,
      spanId: spanIdFor(0x71),
      name: 'example.second-trace-root',
      startTime: BASE_START_MS + 5,
      duration: 40,
      seq: 2,
      ingestSeq: 3,
    });
    const stub = offsetPagedProvider(
      pagesByOffset(
        new Map<number, SpanPageAnswer>([
          [0, { data: [secondTraceChild, collidingRoot], total: 3, nextOffset: 2 }],
          [2, { data: [secondTraceRoot], total: 3 }],
        ]),
      ),
    );
    const user = userEvent.setup();

    renderComponent(makeNode({ query: { source: 'spans', limit: 2 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(3)} spans.`);

    // The colliding span id in the other trace is not the child's parent: the
    // child is a root, marked as waiting for its parent, and no connector joins
    // the two traces.
    expect(renderedNames()).toEqual([collidingRoot.name, secondTraceChild.name]);
    const child = rowNamed(secondTraceChild.name);
    expect(within(child).getByText(PARENT_NOT_LOADED_FLAG)).toBeDefined();
    expect(await descriptionOf(child)).toContain(spanIdFor(0x71));
    expect(within(rowNamed(collidingRoot.name)).queryByText(PARENT_NOT_LOADED_FLAG)).toBeNull();
    expect(edgesOf(screen.getByRole('img'))).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The parent in the child's own trace arrives and the child is re-linked
    // beneath it — not beneath the earlier root that shares the span id.
    await screen.findByText(`Showing ${formatCount(3)} of ${formatCount(3)} spans.`);
    expect(renderedNames()).toEqual([
      collidingRoot.name,
      secondTraceRoot.name,
      secondTraceChild.name,
    ]);
    expect(screen.queryAllByText(PARENT_NOT_LOADED_FLAG)).toHaveLength(0);
    expect(stub.queries.map((query) => query.offset)).toEqual([0, 2]);

    const canvas = screen.getByRole('img');
    const edges = edgesOf(canvas);
    expect(edges).toHaveLength(1);

    const parentX = alignHairline(
      Number(barTitled(canvas, secondTraceRoot.name).getAttribute('x')),
    );
    const collidingX = alignHairline(
      Number(barTitled(canvas, collidingRoot.name).getAttribute('x')),
    );
    expect(parentX).not.toBe(collidingX);
    expect((edges[0]?.getAttribute('d') ?? '').startsWith(`M ${String(parentX)} `)).toBe(true);
  });

  it('draws every row of a parent cycle, and a span naming itself, without throwing', async () => {
    // A well-formed capture holds neither; a corrupted store could hold both.
    const cycleFirst = makeEvent({
      id: 'event-example-0501',
      spanId: spanIdFor(0x51),
      parentSpanId: spanIdFor(0x52),
      name: 'example.cycle-first',
      startTime: BASE_START_MS,
      seq: 0,
      ingestSeq: 1,
    });
    const cycleSecond = makeEvent({
      id: 'event-example-0502',
      spanId: spanIdFor(0x52),
      parentSpanId: spanIdFor(0x51),
      kind: 'fetch',
      name: 'example.cycle-second',
      startTime: BASE_START_MS + 5,
      seq: 1,
      ingestSeq: 2,
    });
    const selfParent = makeEvent({
      id: 'event-example-0503',
      spanId: spanIdFor(0x53),
      parentSpanId: spanIdFor(0x53),
      name: 'example.self-parent',
      startTime: BASE_START_MS + 10,
      seq: 2,
      ingestSeq: 3,
    });
    const stub = resolvingSpans([cycleSecond, selfParent, cycleFirst]);

    renderComponent(spansNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // Nothing dropped and nothing failed. A span naming itself is a root; the
    // cycle has none, so once the roots are drawn it is entered at its
    // canonically first row, and its other row follows beneath it.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(barsOf(canvas)).toHaveLength(3);
    expect(renderedNames()).toEqual([selfParent.name, cycleFirst.name, cycleSecond.name]);

    // Every parent named here is loaded, so nothing is flagged as missing one.
    expect(screen.queryAllByText(PARENT_NOT_LOADED_FLAG)).toHaveLength(0);
  });

  it('draws a row hanging beneath a parent cycle after its parent, even when it starts first', async () => {
    // The cycle's two members name each other; the third row names the second
    // member as its parent and reads the earliest clock of the three, so a walk
    // entered at the canonically first unreached row would draw it before the
    // parent it names.
    const cycleFirst = makeEvent({
      id: 'event-example-0601',
      spanId: spanIdFor(0x61),
      parentSpanId: spanIdFor(0x62),
      name: 'example.loop-first',
      startTime: BASE_START_MS + 10,
      seq: 1,
      ingestSeq: 1,
    });
    const cycleSecond = makeEvent({
      id: 'event-example-0602',
      spanId: spanIdFor(0x62),
      parentSpanId: spanIdFor(0x61),
      kind: 'fetch',
      name: 'example.loop-second',
      startTime: BASE_START_MS + 20,
      seq: 2,
      ingestSeq: 2,
    });
    const hanging = makeEvent({
      id: 'event-example-0603',
      spanId: spanIdFor(0x63),
      parentSpanId: cycleSecond.spanId,
      kind: 'fetch',
      name: 'example.below-loop',
      startTime: BASE_START_MS,
      seq: 0,
      ingestSeq: 3,
    });
    const stub = resolvingSpans([cycleFirst, hanging, cycleSecond]);

    renderComponent(spansNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // The component is entered ON the cycle — the row the climb from the
    // earliest unreached row returns to — so the hanging row follows its
    // parent, and the two rows beneath that entry are ordered as siblings.
    expect(barsOf(canvas)).toHaveLength(3);
    expect(renderedNames()).toEqual([cycleSecond.name, hanging.name, cycleFirst.name]);

    const names = renderedNames();
    expect(names.indexOf(hanging.name)).toBeGreaterThan(names.indexOf(cycleSecond.name));
    expect(screen.queryAllByText(PARENT_NOT_LOADED_FLAG)).toHaveLength(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Keyboard-reachable descriptions
 *
 * A row's full description is carried by a `Tooltip` on its name, which a
 * pointer opens on hover; the keyboard reads the same description while the row
 * itself holds focus, without the table growing a tab stop per row or any stop
 * at all. These readers address the two triggers the view has: the name in each
 * row's Operation cell and the name in the detail strip above the table. A
 * class is read only off an element already obtained semantically, per the
 * harness note at the top of this file.
 * ---------------------------------------------------------------------------
 */

/** The detail strip's tooltip slot, or `null` while no row is hovered, focused or selected. */
function detailSlot(): Element | null {
  return document.querySelector('.dg-timeline__tooltip');
}

/**
 * The element a tooltip wraps inside `scope`: the one child of its trigger box.
 *
 * Located structurally rather than by `aria-describedby`, so the lookup never
 * depends on the description link the cases below assert with `describes`.
 */
function tooltipTriggerIn(scope: Element | null | undefined): HTMLElement | null {
  return scope?.querySelector<HTMLElement>('.dg-tooltip__trigger > *') ?? null;
}

/** The trigger of the detail strip's description: the focused, hovered or selected row's name. */
function detailTrigger(): HTMLElement {
  const trigger = tooltipTriggerIn(detailSlot());

  if (trigger === null) {
    throw new Error('the detail strip shows no row name');
  }

  return trigger;
}

/** The detail strip's description bubble while it is open, or `null` while it is closed. */
function openDetailBubble(): HTMLElement | null {
  const slot = detailSlot();

  if (slot === null) {
    throw new Error('the detail strip shows no row');
  }

  return openBubbleIn(slot);
}

/** The open bubble a case expects, failing with a readable message when it is closed. */
function expectOpen(bubble: HTMLElement | null): HTMLElement {
  if (bubble === null) {
    throw new Error('the description is expected to be open');
  }

  return bubble;
}

/** The trigger of one row's description: the name in its Operation cell. */
function nameTriggerOf(row: HTMLElement): HTMLElement {
  const trigger = tooltipTriggerIn(within(row).getByRole('rowheader'));

  if (trigger === null) {
    throw new Error('the row header holds no name trigger');
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

/** The detail strip itself: always drawn beside a settled canvas, by its accessible name. */
function detailStrip(): HTMLElement {
  return screen.getByRole('group', { name: 'Span detail' });
}

describe('Timeline detail strip', () => {
  it('reserves the strip before anything is hovered, focused or selected, with a resting line', async () => {
    const stub = resolvingTrace(crossTierTree());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();

    // In the layout already, between the canvas and the table, holding the
    // resting line and no trigger: the first Tab still lands on the table.
    const strip = detailStrip();
    expect(strip.classList.contains('dg-timeline__detail')).toBe(true);
    expect(strip.textContent).toBe('Select a span, or point at a bar, to see its detail here.');
    expect(detailSlot()).toBeNull();

    const grid = screen.getByRole('grid');
    expect(strip.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('shows the selection, previews a hovered bar in its place, and returns to the selection', async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();
    const strip = detailStrip();

    await user.click(rowNamed(SERVER_EVENT.name));
    // Clicking a row focuses it, and the focused row IS the selected one.
    expect(detailTrigger().textContent).toBe(SERVER_EVENT.name);
    expect(strip.textContent).toContain('Selected');

    // Focus leaves the view, so only the selection drives the strip.
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(detailTrigger().textContent).toBe(SERVER_EVENT.name);
    expect(strip.textContent).toContain('Selected');

    // A hovered bar is a preview, named as one, and never replaces the strip.
    await user.hover(barTitled(canvas, FETCH_EVENT.name));
    expect(detailTrigger().textContent).toBe(FETCH_EVENT.name);
    expect(strip.textContent).toContain('Preview');
    expect(detailStrip()).toBe(strip);

    // The pointer leaves: back to the selected span, in the same element.
    await user.unhover(barTitled(canvas, FETCH_EVENT.name));
    expect(detailTrigger().textContent).toBe(SERVER_EVENT.name);
    expect(strip.textContent).toContain('Selected');
    expect(detailStrip()).toBe(strip);
  });
});

describe('Timeline keyboard-reachable descriptions', () => {
  it('drives the detail strip from the focused row, whose name is described but is no tab stop', async () => {
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

    // The strip's name is not a stop of its own: it carries no tab index, so
    // Shift+Tab from the row never lands on it. The keyboard reads the same
    // description in the focused row's own Operation cell (the case below).
    expect(detailTrigger().getAttribute('tabindex')).toBeNull();
    expect(openDetailBubble()).toBeNull();

    await user.tab({ shift: true });
    expect(document.activeElement?.closest('.dg-timeline__tooltip') ?? null).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(secondRow);

    // The full name stays on the strip, and its description opens for a
    // pointer on hover — the bubble the name is described by.
    const trigger = detailTrigger();
    expect(trigger.textContent).toBe(FETCH_EVENT.name);
    expect(openDetailBubble()).toBeNull();

    await user.hover(trigger);
    const bubble = await waitFor(() => expectOpen(openDetailBubble()));
    expect(describes(trigger, bubble)).toBe(true);
    expect(bubble.textContent).toContain(FETCH_EVENT.name);
    expect(bubble.textContent).toContain(formatDuration(FETCH_EVENT.duration));

    // Focus never moved to it, and it still shows the row focus is on.
    expect(document.activeElement).toBe(secondRow);
    expect(detailTrigger().textContent).toBe(FETCH_EVENT.name);

    await user.unhover(trigger);
    expect(openDetailBubble()).toBeNull();
  });

  it("reveals the keyboard-focused row's description without making any name a tab stop", async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();

    // No row's name is in the tab order, before focus enters the table or after.
    expect(nameTabIndexes()).toEqual([null, null, null, null]);

    await user.tab();
    const [firstRow, secondRow] = dataRows();

    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('the equivalent rendered fewer than two rows');
    }

    expect(document.activeElement).toBe(firstRow);
    expect(nameTabIndexes()).toEqual([null, null, null, null]);

    // The row itself holds keyboard focus, so its description is open under its
    // name — one tooltip, still the one the name is described by.
    const trigger = nameTriggerOf(firstRow);
    const bubble = expectOpen(openBubbleIn(firstRow));
    expect(document.activeElement).toBe(firstRow);
    // Exactly one description belongs to the name, shown or hidden: the
    // revealed bubble stands in for the pointer's, never beside it.
    const nameCell = within(firstRow).getByRole('rowheader');
    expect(within(nameCell).getAllByRole('tooltip', { hidden: true })).toEqual([bubble]);
    expect(describes(trigger, bubble)).toBe(true);
    // Placed by the primitive's own measurement, as a hovered bubble is: an open
    // bubble is fixed to the viewport, and one nothing placed paints at its corner.
    expect(bubble.style.getPropertyValue('--dgc-tooltip-block')).not.toBe('');
    expect(bubble.style.getPropertyValue('--dgc-tooltip-inline')).not.toBe('');
    expect(bubble.textContent).toContain(INTERACTION_EVENT.name);

    // Escape dismisses it and leaves focus on the row.
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(firstRow);
    expect(openBubbleIn(firstRow)).toBeNull();

    // Moving down moves the reveal with the focus rather than adding a stop.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(secondRow);
    expect(openBubbleIn(firstRow)).toBeNull();
    expect(expectOpen(openBubbleIn(secondRow)).textContent).toContain(FETCH_EVENT.name);
    expect(nameTabIndexes()).toEqual([null, null, null, null]);

    // The body holds the table's single roving stop and nothing else carrying a
    // tab index, however many rows it renders.
    const grid = screen.getByRole('grid');
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('does not reveal a description for the focus a pointer press causes', async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();

    const [, secondRow] = dataRows();
    if (secondRow === undefined) {
      throw new Error('the equivalent rendered fewer than two rows');
    }

    await user.click(secondRow);

    expect(document.activeElement).toBe(secondRow);
    expect(openBubbleIn(secondRow)).toBeNull();

    // The keyboard reveals it again on the next row it reaches.
    await user.keyboard('{ArrowDown}');
    const [, , thirdRow] = dataRows();
    if (thirdRow === undefined) {
      throw new Error('the equivalent rendered fewer than three rows');
    }
    expect(document.activeElement).toBe(thirdRow);
    expectOpen(openBubbleIn(thirdRow));
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

    // No row is focused, hovered or selected any more: the strip is gone, no
    // description is left open and no row's name is in the tab order.
    expect(detailSlot()).toBeNull();
    expect(
      screen
        .getAllByRole('tooltip', { hidden: true })
        .filter((bubble) => bubble.classList.contains('dg-is-open')),
    ).toHaveLength(0);
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

    // The row itself holds keyboard focus, so its description is open already;
    // no further Tab and no stop on the name is needed to read it.
    const bubble = expectOpen(openBubbleIn(row));
    expect(describes(nameTriggerOf(row), bubble)).toBe(true);
    expect(nameTriggerOf(row).getAttribute('tabindex')).toBeNull();
    // The lineage notes a hover would show are in it too.
    expect(bubble.textContent).toContain(AMBIGUOUS_CANDIDATE_SPAN_ID);
  });

  it("keeps a row's source chip out of the Tab order, reached by the table's arrow keys", async () => {
    const stub = resolvingTrace(crossTierTree());
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await findCanvas();
    await user.tab();
    await user.keyboard('{End}');

    const row = rowNamed(QUERY_EVENT.name);
    const nameCell = within(row).getByRole('rowheader');
    const chip = within(row).getByRole('button', { name: SOURCE_CHIP_NAME });
    expect(document.activeElement).toBe(row);
    expect(chip.getAttribute('tabindex')).toBe('-1');
    expectOpen(openBubbleIn(nameCell));

    // Tab leaves the table from its one stop rather than landing on the chip,
    // and Shift+Tab comes back to the row.
    await user.tab();
    expect(row.contains(document.activeElement)).toBe(false);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(row);

    // The arrow keys move into the row. Focus on the chip is not the row's, so
    // the row's description closes, and the strip still shows the row the chip
    // belongs to.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chip);
    expect(openBubbleIn(nameCell)).toBeNull();
    expect(detailTrigger().textContent).toBe(QUERY_EVENT.name);

    // Enter is the chip's own: it opens the location it shows and selects nothing.
    await user.keyboard('{Enter}');
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource).toHaveBeenCalledWith(BASE_SOURCE);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // Back on the row, its description is revealed again.
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(row);
    expectOpen(openBubbleIn(nameCell));
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
    // alternative has to describe what was drawn.
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
    // `confidence` and an invented extra field both fail here. This is the
    // first hop of the click-to-source chain (`docs/ARCHITECTURE.md`, "A click,
    // end to end"), and every hop after it acts on the object it is handed.
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

/*
 * ---------------------------------------------------------------------------
 * The shared selection
 *
 * Under a panel host the selected span is the host's, not this chart's: the
 * bar, the table row and the strip's "Selected" line mark whatever the host's
 * selection context carries, and an activation is reported for the host to
 * record rather than kept here. These cases provide that context directly, and
 * then through a minimal host that feeds each report back into it — the one
 * wiring `PanelHost` performs — with a flame chart over the same trace beside
 * the timeline, so the two charts can be seen to agree.
 * ---------------------------------------------------------------------------
 */

/**
 * The four host contexts around `children`, the selection context included.
 *
 * @param children The views to mount.
 * @param provider The provider that resolves their queries.
 * @param actions The actions they report to.
 * @param selection The selection the host provides.
 * @returns The element tree to render.
 */
function hostedTree(
  children: ReactNode,
  provider: DataProvider,
  actions: PanelActions,
  selection: PanelSelectionState,
): ReactElement {
  return (
    <DataProviderContext.Provider value={provider}>
      <PanelSessionContext.Provider value={SESSION_ID}>
        <PanelActionsContext.Provider value={actions}>
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
 * as the current selection and provides it back to every view beneath, which
 * is exactly the wiring `PanelHost` performs around a panel's layout.
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

  return hostedTree(children, provider, actions, state);
}

/** A `flame` node over the same trace the timeline fixtures draw. */
function flameNode(): FlameNode {
  return {
    type: 'flame',
    id: 'layout.1.flame',
    query: { source: 'trace', filter: { traceId: TRACE_ID } },
  };
}

/** A rendered block by its documented class, failing when it is not on the page. */
function blockOf(className: string): HTMLElement {
  const block = document.querySelector<HTMLElement>(`.${className}`);

  if (block === null) {
    throw new Error(`no .${className} block is rendered`);
  }

  return block;
}

/** The timeline's canvas, read inside its own block so a second chart's canvas is never taken. */
function timelineCanvas(): HTMLElement {
  return within(blockOf('dg-timeline')).getByRole('img');
}

/** The timeline bars carrying the selected state. */
function selectedBars(): Element[] {
  return Array.from(timelineCanvas().querySelectorAll('rect.dg-timeline__bar.dg-is-selected'));
}

/** The flame chart's tree row whose name control is `name`. */
function flameRowNamed(name: string): HTMLElement {
  const row = within(blockOf('dg-flame'))
    .getAllByRole('treeitem')
    .find((candidate) => within(candidate).queryByRole('button', { name }) !== null);

  if (row === undefined) {
    throw new Error(`the flame chart lists no frame named "${name}"`);
  }

  return row;
}

/** The first line of each flame frame's SVG title that carries the selected state. */
function selectedFlameFrames(): string[] {
  return Array.from(
    within(blockOf('dg-flame'))
      .getByRole('img')
      .querySelectorAll('rect.dg-flame__frame.dg-is-selected'),
  ).map((frame) => (frame.querySelector('title')?.textContent ?? '').split('\n')[0] ?? '');
}

describe('Timeline shared selection', () => {
  it('marks the span the panel selection names, by event id or by trace and span, and keeps none of its own', async () => {
    const stub = resolvingTrace(crossTierTree());
    const spies = makeActions();
    const user = userEvent.setup();
    const byId: PanelSelectionState = { selection: { eventId: FETCH_EVENT.id } };

    const { rerender } = render(
      hostedTree(<Timeline node={makeNode()} />, stub.provider, spies.actions, byId),
    );
    await findCanvas();

    // The provided selection is what the three marks show, and only it.
    expect(rowNamed(FETCH_EVENT.name).getAttribute('aria-selected')).toBe('true');
    expect(barTitled(timelineCanvas(), FETCH_EVENT.name).classList.contains('dg-is-selected')).toBe(
      true,
    );
    expect(selectedBars()).toHaveLength(1);
    expect(detailStrip().textContent).toContain('Selected');
    expect(detailStrip().textContent).toContain(FETCH_EVENT.name);

    // Another record's id naming this trace and this span still lands on the
    // span: that pair is the span's identity across tiers.
    const bySpan: PanelSelectionState = {
      selection: {
        eventId: 'event-example-elsewhere',
        traceId: TRACE_ID,
        spanId: SERVER_EVENT.spanId,
      },
    };
    rerender(hostedTree(<Timeline node={makeNode()} />, stub.provider, spies.actions, bySpan));

    expect(rowNamed(SERVER_EVENT.name).getAttribute('aria-selected')).toBe('true');
    expect(rowNamed(FETCH_EVENT.name).getAttribute('aria-selected')).toBe('false');
    expect(
      barTitled(timelineCanvas(), SERVER_EVENT.name).classList.contains('dg-is-selected'),
    ).toBe(true);

    // Activating a row reports it and leaves the marking to the host: a host
    // that has not recorded the report still shows its own selection.
    await user.click(rowNamed(QUERY_EVENT.name));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: QUERY_EVENT.id,
      spanId: QUERY_EVENT.spanId,
      traceId: QUERY_EVENT.traceId,
    });
    expect(rowNamed(QUERY_EVENT.name).getAttribute('aria-selected')).toBe('false');
    expect(rowNamed(SERVER_EVENT.name).getAttribute('aria-selected')).toBe('true');

    // A host with nothing selected marks nothing.
    rerender(
      hostedTree(<Timeline node={makeNode()} />, stub.provider, spies.actions, {
        selection: undefined,
      }),
    );

    expect(dataRows().map((row) => row.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(selectedBars()).toHaveLength(0);
  });

  it('mirrors a selection made in the timeline or the flame chart in the other, under one host', async () => {
    const stub = resolvingTrace(crossTierTree());
    const spies = makeActions();
    const user = userEvent.setup();

    render(
      <SelectionHost provider={stub.provider} spies={spies}>
        <Timeline node={makeNode()} />
        <FlameChart node={flameNode()} />
      </SelectionHost>,
    );

    expect(await screen.findAllByRole('img')).toHaveLength(2);
    await screen.findByRole('tree');

    // Nothing is selected in either chart yet.
    expect(selectedBars()).toHaveLength(0);
    expect(selectedFlameFrames()).toEqual([]);

    // A row activated in the timeline is marked in the flame chart too: its
    // tree row and its frame.
    await user.click(rowNamed(SERVER_EVENT.name));

    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: SERVER_EVENT.id,
      spanId: SERVER_EVENT.spanId,
      traceId: SERVER_EVENT.traceId,
    });
    expect(rowNamed(SERVER_EVENT.name).getAttribute('aria-selected')).toBe('true');
    expect(flameRowNamed(SERVER_EVENT.name).classList.contains('dg-is-selected')).toBe(true);
    expect(flameRowNamed(SERVER_EVENT.name).getAttribute('aria-current')).toBe('true');
    expect(selectedFlameFrames()).toEqual([SERVER_EVENT.name]);

    // A frame activated in the flame chart moves the timeline's marks with it:
    // its bar, its table row and its strip, and nothing is left on the old span.
    await user.click(
      within(flameRowNamed(QUERY_EVENT.name)).getByRole('button', { name: QUERY_EVENT.name }),
    );

    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: QUERY_EVENT.id,
      spanId: QUERY_EVENT.spanId,
      traceId: QUERY_EVENT.traceId,
    });
    expect(rowNamed(QUERY_EVENT.name).getAttribute('aria-selected')).toBe('true');
    expect(rowNamed(SERVER_EVENT.name).getAttribute('aria-selected')).toBe('false');
    expect(selectedBars()).toEqual([barTitled(timelineCanvas(), QUERY_EVENT.name)]);
    expect(selectedFlameFrames()).toEqual([QUERY_EVENT.name]);
    expect(flameRowNamed(SERVER_EVENT.name).classList.contains('dg-is-selected')).toBe(false);
    expect(detailStrip().textContent).toContain('Selected');
    expect(detailStrip().textContent).toContain(QUERY_EVENT.name);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Reaching and dismissing a preview (WCAG 1.4.13)
 *
 * A preview is content that appears on hover or focus, so it has to be
 * hoverable — the pointer can move onto it without it disappearing — and
 * dismissible — Escape removes it without moving the pointer or focus — while
 * the selection it stands in for stays exactly where it was.
 * ---------------------------------------------------------------------------
 */

/** The strip's resting line, as the reader sees it while nothing is shown. */
const RESTING_LINE = 'Select a span, or point at a bar, to see its detail here.';

describe('Timeline preview reach and dismissal', () => {
  it("keeps a bar's preview while the pointer travels onto the strip, and ends it in the table", async () => {
    const stub = resolvingTrace(crossTierTree());
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    const canvas = await findCanvas();
    const strip = detailStrip();

    await user.hover(barTitled(canvas, QUERY_EVENT.name));
    expect(strip.textContent).toContain('Preview');
    expect(detailTrigger().textContent).toBe(QUERY_EVENT.name);

    // Off the bar, across the empty canvas and onto the strip's source chip:
    // the preview holds the whole way, so the chip it shows is the chip the
    // pointer arrives at.
    await user.hover(canvas);
    expect(detailTrigger().textContent).toBe(QUERY_EVENT.name);

    const chip = within(strip).getByRole('button', { name: SOURCE_CHIP_NAME });
    await user.hover(chip);
    expect(within(strip).getByRole('button', { name: SOURCE_CHIP_NAME })).toBe(chip);
    expect(detailTrigger().textContent).toBe(QUERY_EVENT.name);

    // Moving on into the table ends it: nothing is selected or focused, so the
    // strip is back at its resting line, in the same element.
    await user.hover(rowNamed(INTERACTION_EVENT.name));
    expect(strip.textContent).toBe(RESTING_LINE);
    expect(detailStrip()).toBe(strip);

    // The chip reached through a preview is a working control: it opens the
    // location it shows and selects nothing.
    await user.hover(barTitled(canvas, QUERY_EVENT.name));
    const reached = within(strip).getByRole('button', { name: SOURCE_CHIP_NAME });
    await user.hover(reached);
    await user.click(reached);

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource).toHaveBeenCalledWith(BASE_SOURCE);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // Focus is inside the strip now, and it holds the row the strip shows: the
    // pointer moving into the table does not pull the focused chip away.
    await user.hover(rowNamed(INTERACTION_EVENT.name));
    expect(detailTrigger().textContent).toBe(QUERY_EVENT.name);
    expect(document.activeElement).toBe(reached);
    expect(strip.contains(reached)).toBe(true);
  });

  it('dismisses a pointer preview with Escape pressed anywhere, and keeps the selection', async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();
    const strip = detailStrip();

    await user.click(rowNamed(SERVER_EVENT.name));
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(strip.textContent).toContain('Selected');

    await user.hover(barTitled(canvas, FETCH_EVENT.name));
    expect(strip.textContent).toContain('Preview');
    expect(detailTrigger().textContent).toBe(FETCH_EVENT.name);

    // The pointer does not move focus, so the key arrives at the page body. It
    // dismisses the preview there and is not consumed: a dialog or a shortcut
    // above the panel still sees it.
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);

    expect(strip.textContent).toContain('Selected');
    expect(detailTrigger().textContent).toBe(SERVER_EVENT.name);
    expect(detailStrip()).toBe(strip);

    // The selection itself is untouched, on the bar and on the row.
    expect(rowNamed(SERVER_EVENT.name).getAttribute('aria-selected')).toBe('true');
    expect(barTitled(canvas, SERVER_EVENT.name).classList.contains('dg-is-selected')).toBe(true);

    // The next bar the pointer enters previews as before.
    await user.hover(barTitled(canvas, INTERACTION_EVENT.name));
    expect(strip.textContent).toContain('Preview');
    expect(detailTrigger().textContent).toBe(INTERACTION_EVENT.name);

    // The same dismissal through the keyboard as a reader presses it.
    await user.keyboard('{Escape}');
    expect(detailTrigger().textContent).toBe(SERVER_EVENT.name);
  });

  it("dismisses a focused row's preview with Escape, keeping focus and its tab stop, until focus moves on", async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();
    const strip = detailStrip();

    await user.tab();
    const [firstRow, secondRow] = dataRows();

    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('the equivalent rendered fewer than two rows');
    }

    expect(document.activeElement).toBe(firstRow);
    expect(strip.textContent).toContain('Preview');
    expect(detailTrigger().textContent).toBe(INTERACTION_EVENT.name);
    expectOpen(openBubbleIn(firstRow));

    // Escape peels one layer per press, each consumed because it dismissed
    // something: first the description the focused row reveals in its own
    // Operation cell, which leaves the strip's preview in place, then that
    // preview. Focus and the table's one tab stop are exactly where they were.
    expect(fireEvent.keyDown(firstRow, { key: 'Escape' })).toBe(false);
    expect(openBubbleIn(firstRow)).toBeNull();
    expect(strip.textContent).toContain('Preview');
    expect(detailTrigger().textContent).toBe(INTERACTION_EVENT.name);

    expect(fireEvent.keyDown(firstRow, { key: 'Escape' })).toBe(false);
    expect(strip.textContent).toBe(RESTING_LINE);
    expect(document.activeElement).toBe(firstRow);
    expect(firstRow.getAttribute('tabindex')).toBe('0');
    expect(nameTabIndexes()).toEqual([null, null, null, null]);

    // A third press has nothing of this view's to dismiss and is left alone.
    expect(fireEvent.keyDown(firstRow, { key: 'Escape' })).toBe(true);

    // Focus moving to another row previews it, and coming back previews the
    // first row again: the dismissal belonged to that one visit.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(secondRow);
    expect(detailTrigger().textContent).toBe(FETCH_EVENT.name);

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(firstRow);
    expect(detailTrigger().textContent).toBe(INTERACTION_EVENT.name);

    // A focused row that IS the selection is not a preview: once the row's own
    // revealed description is dismissed, Escape there dismisses nothing and
    // the selection stays shown.
    await user.keyboard('{Enter}');
    expect(strip.textContent).toContain('Selected');
    expect(fireEvent.keyDown(firstRow, { key: 'Escape' })).toBe(false);
    expect(openBubbleIn(firstRow)).toBeNull();
    expect(strip.textContent).toContain('Selected');
    expect(fireEvent.keyDown(firstRow, { key: 'Escape' })).toBe(true);
    expect(strip.textContent).toContain('Selected');
    expect(detailTrigger().textContent).toBe(INTERACTION_EVENT.name);
  });

  it('leaves the strip as it is when Escape is pressed while focus is on the strip itself', async () => {
    const stub = resolvingTrace(crossTierTree());
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await findCanvas();
    const strip = detailStrip();
    await user.tab();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rowNamed(QUERY_EVENT.name));
    expect(strip.textContent).toContain('Preview');
    expect(detailTrigger().textContent).toBe(QUERY_EVENT.name);

    // Nothing in the strip is a tab stop, so focus reaches it only through a
    // pointer: a click on the strip's source chip.
    const chip = within(strip).getByRole('button', { name: SOURCE_CHIP_NAME });
    expect(chip.getAttribute('tabindex')).toBe('-1');
    await user.click(chip);
    expect(document.activeElement).toBe(chip);

    // The chip's own description opens with its focus. The first press closes
    // it, the second finds nothing it may dismiss and is left alone:
    // dismissing the strip would unmount the very chip that holds focus.
    expectOpen(openBubbleIn(strip));
    await user.keyboard('{Escape}');
    expect(openBubbleIn(strip)).toBeNull();

    expect(fireEvent.keyDown(chip, { key: 'Escape' })).toBe(true);
    expect(within(detailStrip()).getByRole('button', { name: SOURCE_CHIP_NAME })).toBe(chip);
    expect(detailTrigger().textContent).toBe(QUERY_EVENT.name);
    expect(strip.textContent).toContain('Preview');
    expect(document.activeElement).toBe(chip);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Canvas geometry
 *
 * A deeper, sparser trace than the chain above, shaped like the interactions
 * this view is opened on: a request nested four levels into the server, a
 * render and a commit after it in the browser lane, and a short query whose
 * parent never arrived, re-attached to the root. Its database lane holds a
 * span at depth 1 and another at depth 5, which is what exposes a lane that
 * reserves a row per depth between its extremes, and its late, short spans
 * sit where a label has no room after the bar, which is what exposes a label
 * placed without measuring it.
 * ---------------------------------------------------------------------------
 */

/** The interaction at the root of the nested trace. */
const NESTED_ROOT = makeEvent({
  id: 'event-example-0301',
  spanId: spanIdFor(0x31),
  kind: 'interaction',
  name: 'example.click',
  tier: 'browser',
  startTime: BASE_START_MS,
  duration: 1175,
  producerId: BROWSER_PRODUCER_ID,
  seq: 0,
  ingestSeq: 1,
});

/** The request the interaction made. */
const NESTED_REQUEST = makeEvent({
  id: 'event-example-0302',
  spanId: spanIdFor(0x32),
  parentSpanId: spanIdFor(0x31),
  kind: 'fetch',
  name: 'GET /example/report',
  tier: 'browser',
  startTime: BASE_START_MS + 8,
  duration: 1112,
  producerId: BROWSER_PRODUCER_ID,
  seq: 1,
  ingestSeq: 2,
});

/** The server span that answered the request. */
const NESTED_SERVER = makeEvent({
  id: 'event-example-0303',
  spanId: spanIdFor(0x33),
  parentSpanId: spanIdFor(0x32),
  kind: 'http.server',
  name: 'serve /example/report',
  tier: 'server',
  startTime: BASE_START_MS + 12,
  duration: 1100,
  producerId: SERVER_PRODUCER_ID,
  seq: 0,
  ingestSeq: 3,
});

/** The route handler inside it, whose name is longer than any room beside its bar. */
const NESTED_ROUTE = makeEvent({
  id: 'event-example-0304',
  spanId: spanIdFor(0x34),
  parentSpanId: spanIdFor(0x33),
  kind: 'route.handler',
  name: 'executing example route handler /example/report',
  tier: 'server',
  startTime: BASE_START_MS + 16,
  duration: 1094,
  producerId: SERVER_PRODUCER_ID,
  seq: 1,
  ingestSeq: 4,
});

/** The service function the handler called. */
const NESTED_FUNCTION = makeEvent({
  id: 'event-example-0305',
  spanId: spanIdFor(0x35),
  parentSpanId: spanIdFor(0x34),
  kind: 'function',
  name: 'loadExampleReport',
  tier: 'server',
  startTime: BASE_START_MS + 20,
  duration: 1080,
  producerId: SERVER_PRODUCER_ID,
  seq: 2,
  ingestSeq: 5,
});

/** The slow query at depth 5 — the deepest span, in the database lane. */
const NESTED_QUERY = makeEvent({
  id: 'event-example-0306',
  spanId: spanIdFor(0x36),
  parentSpanId: spanIdFor(0x35),
  kind: 'db.query',
  name: 'example.query.slow',
  tier: 'db',
  startTime: BASE_START_MS + 28,
  duration: 940,
  producerId: SERVER_PRODUCER_ID,
  seq: 3,
  ingestSeq: 6,
});

/** A render after the response, under the request. */
const NESTED_RENDER = makeEvent({
  id: 'event-example-0307',
  spanId: spanIdFor(0x37),
  parentSpanId: spanIdFor(0x32),
  kind: 'render',
  name: 'render ExamplePanel',
  tier: 'browser',
  startTime: BASE_START_MS + 1128,
  duration: 47,
  producerId: BROWSER_PRODUCER_ID,
  seq: 2,
  ingestSeq: 7,
});

/** The commit that ends the window: a 4 ms span at the very right edge. */
const NESTED_COMMIT = makeEvent({
  id: 'event-example-0308',
  spanId: spanIdFor(0x38),
  parentSpanId: spanIdFor(0x31),
  kind: 'commit',
  name: 'commit',
  tier: 'browser',
  startTime: BASE_START_MS + 1175,
  duration: 4,
  producerId: BROWSER_PRODUCER_ID,
  seq: 3,
  ingestSeq: 8,
});

/** A short query whose parent never arrived, re-attached to the root at depth 1. */
const NESTED_ORPHAN_QUERY = makeEvent({
  id: 'event-example-0309',
  spanId: spanIdFor(0x39),
  parentSpanId: spanIdFor(0x3f),
  kind: 'db.query',
  name: 'example.query.fast',
  tier: 'db',
  startTime: BASE_START_MS + 1000,
  duration: 12,
  producerId: SERVER_PRODUCER_ID,
  seq: 4,
  ingestSeq: 9,
  attributes: { orphaned: true, orphanedParentSpanId: spanIdFor(0x3f) },
});

/**
 * The nested trace as a tree, with the depth-5 query replaceable so a case can
 * give it a hostile name.
 *
 * @param query The event drawn at depth 5 in the database lane.
 * @returns The nine-node tree.
 */
function nestedTree(query: TelemetryEvent = NESTED_QUERY): TraceTree {
  return makeTree([
    makeTraceNode(NESTED_ROOT, {
      depth: 0,
      children: [
        makeTraceNode(NESTED_REQUEST, {
          depth: 1,
          children: [
            makeTraceNode(NESTED_SERVER, {
              depth: 2,
              children: [
                makeTraceNode(NESTED_ROUTE, {
                  depth: 3,
                  children: [
                    makeTraceNode(NESTED_FUNCTION, {
                      depth: 4,
                      children: [makeTraceNode(query, { depth: 5 })],
                    }),
                  ],
                }),
              ],
            }),
            makeTraceNode(NESTED_RENDER, { depth: 2 }),
          ],
        }),
        makeTraceNode(NESTED_ORPHAN_QUERY, {
          depth: 1,
          orphaned: true,
          orphanReason: MISSING_PARENT,
          missingParentSpanId: spanIdFor(0x3f),
        }),
        makeTraceNode(NESTED_COMMIT, { depth: 1 }),
      ],
    }),
  ]);
}

/** The lane background bands, top to bottom — the accent stripes carry a style and are excluded. */
function laneBandsOf(canvas: HTMLElement): Element[] {
  return Array.from(canvas.querySelectorAll('rect.dg-timeline__lane')).filter(
    (lane) => lane.getAttribute('style') === null,
  );
}

/** The canvas's `viewBox` as its four numbers. */
function viewBoxOf(canvas: HTMLElement): readonly [number, number, number, number] {
  const parts = (canvas.getAttribute('viewBox') ?? '').split(' ').map(Number);
  const [minX = Number.NaN, minY = Number.NaN, width = Number.NaN, height = Number.NaN] = parts;

  return [minX, minY, width, height];
}

/** A numeric SVG attribute, failing loudly when it is absent. */
function numericAttribute(element: Element, name: string): number {
  const value = element.getAttribute(name);
  if (value === null) {
    throw new Error(`the element has no "${name}" attribute`);
  }

  return Number(value);
}

/**
 * The measure the component fits its labels with, in every environment: the
 * deterministic advance estimate at the label role's size. Reading a drawn
 * label's width through it is reading exactly the width the component placed.
 */
const LABEL_MEASURE = createEstimateMeasure(DEFAULT_LABEL_FONT_SIZE);

/** A drawn bar label, with the horizontal run it covers. */
interface DrawnLabel {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly inside: boolean;
}

/** The backdrop drawn under a label beside its bar. */
interface DrawnBackdrop {
  readonly start: number;
  readonly end: number;
  readonly y: number;
  readonly height: number;
}

/** One drawn span: its bar's run and row, its description, its label and that label's backdrop. */
interface DrawnRow {
  readonly title: string;
  readonly x: number;
  readonly end: number;
  /** The bar's top edge, which every bar on the same row shares. */
  readonly y: number;
  readonly height: number;
  readonly label: DrawnLabel | undefined;
  readonly backdrop: DrawnBackdrop | undefined;
}

/** Every span as drawn, in the canvas's own order, read from its row group. */
function drawnRowsOf(canvas: HTMLElement): DrawnRow[] {
  return Array.from(canvas.querySelectorAll('g.dg-timeline__row')).map((group) => {
    const bar = group.querySelector('rect.dg-timeline__bar');
    if (bar === null) {
      throw new Error('a drawn row holds no bar');
    }
    const x = numericAttribute(bar, 'x');
    const text = group.querySelector('text.dg-timeline__bar-label');
    let label: DrawnLabel | undefined;
    if (text !== null) {
      const content = text.textContent ?? '';
      const width = LABEL_MEASURE(content);
      const at = numericAttribute(text, 'x');
      const start = text.getAttribute('text-anchor') === 'end' ? at - width : at;
      label = {
        text: content,
        start,
        end: start + width,
        inside: text.classList.contains('dg-timeline__bar-label--inside'),
      };
    }

    const backdropRect = group.querySelector('rect.dg-timeline__bar-label-backdrop');
    const backdrop =
      backdropRect === null
        ? undefined
        : {
            start: numericAttribute(backdropRect, 'x'),
            end: numericAttribute(backdropRect, 'x') + numericAttribute(backdropRect, 'width'),
            y: numericAttribute(backdropRect, 'y'),
            height: numericAttribute(backdropRect, 'height'),
          };

    return {
      title: bar.querySelector('title')?.textContent ?? '',
      x,
      end: x + numericAttribute(bar, 'width'),
      y: numericAttribute(bar, 'y'),
      height: numericAttribute(bar, 'height'),
      label,
      backdrop,
    };
  });
}

/** The drawn span whose description names `name`. */
function drawnRowNamed(rows: readonly DrawnRow[], name: string): DrawnRow {
  const row = rows.find((candidate) => candidate.title.startsWith(`${name} `));
  if (row === undefined) {
    throw new Error(`no drawn span is described as "${name}"`);
  }

  return row;
}

/** Whether two horizontal runs share any width. */
function runsOverlap(
  left: { readonly start: number; readonly end: number },
  right: { readonly start: number; readonly end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * Asserts the placement contract for every label on the canvas: a label beside
 * its bar lies between the lane-label column and the canvas's right edge on a
 * backdrop that covers it and no bar, a label inside its bar lies within it
 * with no backdrop, and no label overlaps another bar or another label on its
 * row.
 *
 * @param canvas The canvas.
 * @param laneColumn Where the lane-label column ends: the left edge of a bar
 *   that starts at the window's start.
 * @returns The rows it checked, for further assertions.
 */
function expectLabelsClear(canvas: HTMLElement, laneColumn: number): DrawnRow[] {
  const rows = drawnRowsOf(canvas);
  const [, , canvasWidth] = viewBoxOf(canvas);

  for (const row of rows) {
    const label = row.label;
    if (label === undefined) {
      expect(row.backdrop, `the unlabelled "${row.title}" has no backdrop`).toBeUndefined();
      continue;
    }
    const named = `the label "${label.text}"`;

    if (label.inside) {
      expect(label.start, `${named} starts inside its bar`).toBeGreaterThanOrEqual(row.x);
      expect(label.end, `${named} ends inside its bar`).toBeLessThanOrEqual(row.end);
      expect(row.backdrop, `${named} has no backdrop`).toBeUndefined();
    } else {
      expect(label.start, `${named} clears the lane labels`).toBeGreaterThanOrEqual(laneColumn);
      expect(label.end, `${named} stays on the canvas`).toBeLessThanOrEqual(canvasWidth);
      expect(runsOverlap(label, { start: row.x, end: row.end }), `${named} is off its bar`).toBe(
        false,
      );

      // The backdrop spans the label and the bar's height, and touches no bar.
      const backdrop = row.backdrop;
      if (backdrop === undefined) {
        throw new Error(`${named} is beside its bar with no backdrop`);
      }
      expect(backdrop.start, `${named}'s backdrop starts before it`).toBeLessThan(label.start);
      expect(backdrop.end, `${named}'s backdrop ends after it`).toBeGreaterThan(label.end);
      expect([backdrop.y, backdrop.height]).toEqual([row.y, row.height]);
      for (const other of rows) {
        if (other.y === row.y) {
          expect(
            runsOverlap(backdrop, { start: other.x, end: other.end }),
            `${named}'s backdrop covers the bar of "${other.title}"`,
          ).toBe(false);
        }
      }
    }

    for (const other of rows) {
      if (other === row || other.y !== row.y) {
        continue;
      }
      expect(
        runsOverlap(label, { start: other.x, end: other.end }),
        `${named} crosses the bar of "${other.title}"`,
      ).toBe(false);
      if (other.label !== undefined) {
        expect(runsOverlap(label, other.label), `${named} crosses "${other.label.text}"`).toBe(
          false,
        );
      }
    }
  }

  return rows;
}

/**
 * A 243-code-unit name made mostly of emoji ZWJ sequences, each five code units
 * and one grapheme: a cut by code unit or by code point would split one.
 */
const HOSTILE_NAME = `example.${'\u{1F469}\u200D\u{1F4BB}'.repeat(47)}`;

/** The slow query under that name. */
const HOSTILE_QUERY = makeEvent({
  id: NESTED_QUERY.id,
  spanId: NESTED_QUERY.spanId,
  parentSpanId: NESTED_QUERY.parentSpanId,
  kind: NESTED_QUERY.kind,
  name: HOSTILE_NAME,
  tier: NESTED_QUERY.tier,
  startTime: NESTED_QUERY.startTime,
  duration: NESTED_QUERY.duration,
  producerId: NESTED_QUERY.producerId,
  seq: NESTED_QUERY.seq,
  ingestSeq: NESTED_QUERY.ingestSeq,
});

describe('Timeline canvas geometry', () => {
  it('gives each lane one row per distinct depth, with no band for a depth it does not hold', async () => {
    const tree = nestedTree();
    const stub = resolvingTrace(tree);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    expect(barsOf(canvas)).toHaveLength(tree.nodeCount);
    expect(laneLabelsOf(canvas)).toEqual([...CHAIN_LANE_LABELS]);

    // Browser: depths 0, 1 and 2. Server: depths 2, 3 and 4. Database: depths
    // 1 and 5 — two rows, not the five between its extremes.
    const bands = laneBandsOf(canvas);
    expect(bands.map((band) => numericAttribute(band, 'height'))).toEqual([
      layoutHeight(3),
      layoutHeight(3),
      layoutHeight(2),
    ]);

    // The shallower span sits in the lane's first row and the deeper one in
    // the row directly beneath it: nesting order kept, no empty row between.
    const databaseBand = bands[2];
    if (databaseBand === undefined) {
      throw new Error('the canvas drew no database lane');
    }
    const bandTop = numericAttribute(databaseBand, 'y');
    const bandBottom = bandTop + numericAttribute(databaseBand, 'height');
    const orphanBar = barTitled(canvas, NESTED_ORPHAN_QUERY.name);
    const queryBar = barTitled(canvas, NESTED_QUERY.name);
    const orphanTop = numericAttribute(orphanBar, 'y');
    const queryTop = numericAttribute(queryBar, 'y');
    expect(queryTop - orphanTop).toBe(rowY(1));
    expect(orphanTop).toBeGreaterThanOrEqual(bandTop);
    expect(queryTop + numericAttribute(queryBar, 'height')).toBeLessThanOrEqual(bandBottom);

    // Two spans at depth 1 in the browser lane share its second row.
    expect(numericAttribute(barTitled(canvas, NESTED_COMMIT.name), 'y')).toBe(
      numericAttribute(barTitled(canvas, NESTED_REQUEST.name), 'y'),
    );
  });

  it('lays the canvas out in a fixed logical viewBox that CSS sizes to its container, reading no layout', async () => {
    const stub = resolvingTrace(nestedTree());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // The fixed logical coordinate space: a viewBox the scale module's chart
    // width wide and the drawing's own height tall, declared 100% wide so CSS
    // sizes it, and scaled uniformly from its top-left corner.
    const [minX, minY, viewWidth, viewHeight] = viewBoxOf(canvas);
    expect([minX, minY]).toEqual([0, 0]);
    expect(viewWidth).toBe(CHART_VIEWBOX_WIDTH);
    expect(viewHeight).toBeGreaterThan(0);
    expect(canvas.getAttribute('width')).toBe('100%');
    expect(canvas.getAttribute('preserveAspectRatio')).toBe('xMinYMin meet');
    expect(numericAttribute(canvas, 'height')).toBe(viewHeight);
    // Nothing measured is written back: neither the canvas nor its scroll
    // container carries an inline size.
    expect(canvas.getAttribute('style')).toBeNull();
    expect(canvas.parentElement?.getAttribute('style') ?? null).toBeNull();

    const bands = laneBandsOf(canvas);
    expect(bands).toHaveLength(CHAIN_LANE_TIERS.length);
    for (const band of bands) {
      expect(numericAttribute(band, 'x')).toBe(0);
      expect(numericAttribute(band, 'width')).toBe(CHART_VIEWBOX_WIDTH);
    }

    // The root spans the whole window, so its bar spans the whole plot: from
    // the lane-label column to the logical width less a trailing gutter
    // narrower than that column.
    const root = barTitled(canvas, NESTED_ROOT.name);
    const rootStart = numericAttribute(root, 'x');
    const rootEnd = rootStart + numericAttribute(root, 'width');
    expect(rootStart).toBeGreaterThan(0);
    expect(rootEnd).toBeLessThanOrEqual(CHART_VIEWBOX_WIDTH);
    expect(CHART_VIEWBOX_WIDTH - rootEnd).toBeLessThan(rootStart);
  });

  it('keeps every label clear of the lane labels, the canvas edge, foreign bars and other labels', async () => {
    const tree = nestedTree();
    const stub = resolvingTrace(tree);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();

    // The root starts at the window's start, so its bar starts at the end of
    // the lane-label column.
    const laneColumn = numericAttribute(barTitled(canvas, NESTED_ROOT.name), 'x');
    const rows = expectLabelsClear(canvas, laneColumn);
    expect(rows).toHaveLength(tree.nodeCount);

    // Most spans are labelled, and every label drawn whole is the whole
    // "name · duration" text; a shortened one ends its name in an ellipsis and
    // is a prefix of that name.
    const labelled = rows.filter((row) => row.label !== undefined);
    expect(labelled.length).toBeGreaterThanOrEqual(tree.nodeCount - 1);
    for (const event of flattenFixture(tree.roots).map((node) => node.event)) {
      const label = drawnRowNamed(rows, event.name).label;
      if (label === undefined) {
        continue;
      }
      const whole = `${event.name} · ${formatDurationCompact(event.duration)}`;
      if (label.text !== whole) {
        const [namePart = ''] = label.text.split(' · ');
        expect(namePart.endsWith(ELLIPSIS) || namePart === event.name).toBe(true);
        expect(event.name.startsWith(namePart.replace(ELLIPSIS, ''))).toBe(true);
      }
    }
  });

  it('draws no label over a foreign bar: a late span with no room beside it goes unlabelled', async () => {
    const stub = resolvingTrace(nestedTree());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();
    const rows = drawnRowsOf(canvas);

    // The commit ends the window and shares its row with the request, which
    // runs until just before it: no room after it, none inside it, and before
    // it only the few units between the two bars — too few for four letters
    // of its name. It is left unlabelled rather than drawn across the request,
    // and its name is still in its description and in the table.
    const commit = drawnRowNamed(rows, NESTED_COMMIT.name);
    const request = drawnRowNamed(rows, NESTED_REQUEST.name);
    expect(commit.y).toBe(request.y);
    expect(commit.label).toBeUndefined();
    expect(commit.title.startsWith(`${NESTED_COMMIT.name} `)).toBe(true);
    expect(renderedNames()).toContain(NESTED_COMMIT.name);

    // The request's own label is drawn inside it, clear of the commit.
    expect(request.label?.inside).toBe(true);
    expect(request.label?.text).toBe(
      `${NESTED_REQUEST.name} · ${formatDurationCompact(NESTED_REQUEST.duration)}`,
    );

    // A late span alone on its row has room before its bar, and its label is
    // drawn there whole, end-anchored, on the lane surface.
    const render = drawnRowNamed(rows, NESTED_RENDER.name);
    expect(render.label?.inside).toBe(false);
    expect(render.label?.text).toBe(
      `${NESTED_RENDER.name} · ${formatDurationCompact(NESTED_RENDER.duration)}`,
    );
    expect(render.label?.end).toBeLessThanOrEqual(render.x);
  });

  it('shortens a label to its room in logical units: the duration kept when the name has room beside it, the name alone when it has not', async () => {
    // One browser lane over an 1100 ms window, so one millisecond is 0.8 user
    // units of the fixed canvas. The request fills most of the window under a
    // name longer than its bar; the commit that ends the window shares its row
    // and starts 72 units after the request ends.
    const rootSpanId = spanIdFor(0x60);
    const root = makeEvent({
      id: 'event-example-0601',
      spanId: rootSpanId,
      kind: 'interaction',
      name: 'example.click',
      tier: 'browser',
      startTime: BASE_START_MS,
      duration: 1100,
      producerId: BROWSER_PRODUCER_ID,
      seq: 0,
      ingestSeq: 1,
    });
    const request = makeEvent({
      id: 'event-example-0602',
      spanId: spanIdFor(0x61),
      parentSpanId: rootSpanId,
      kind: 'fetch',
      name: `example.request.${'segment.'.repeat(16)}end`,
      tier: 'browser',
      startTime: BASE_START_MS + 8,
      duration: 998,
      producerId: BROWSER_PRODUCER_ID,
      seq: 1,
      ingestSeq: 2,
    });
    const commit = makeEvent({
      id: 'event-example-0603',
      spanId: spanIdFor(0x62),
      parentSpanId: rootSpanId,
      kind: 'commit',
      name: 'commit',
      tier: 'browser',
      startTime: BASE_START_MS + 1096,
      duration: 4,
      producerId: BROWSER_PRODUCER_ID,
      seq: 2,
      ingestSeq: 3,
    });
    const tree = makeTree([
      makeTraceNode(root, {
        depth: 0,
        children: [makeTraceNode(request, { depth: 1 }), makeTraceNode(commit, { depth: 1 })],
      }),
    ]);
    const stub = resolvingTrace(tree);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();
    const rows = expectLabelsClear(canvas, numericAttribute(barTitled(canvas, root.name), 'x'));
    const requestRow = drawnRowNamed(rows, request.name);
    const commitRow = drawnRowNamed(rows, commit.name);
    expect(commitRow.y).toBe(requestRow.y);

    // The request's label fits nowhere whole. Its widest room is inside its
    // bar, and that room holds the duration beside a cut of the name, so the
    // duration is kept: the longest prefix whose estimate, with the ellipsis
    // and the duration after it, fits the room — one grapheme more would not.
    const requestLabel = requestRow.label;
    if (requestLabel === undefined) {
      throw new Error('the request was left unlabelled');
    }
    const requestSuffix = ` · ${formatDurationCompact(request.duration)}`;
    const inset = requestLabel.start - requestRow.x;
    const insideRoom = requestRow.end - inset - requestLabel.start;
    expect(requestLabel.inside).toBe(true);
    expect(inset).toBeGreaterThan(0);
    expect(LABEL_MEASURE(`${request.name}${requestSuffix}`)).toBeGreaterThan(insideRoom);
    expect(requestLabel.text.endsWith(`${ELLIPSIS}${requestSuffix}`)).toBe(true);
    const kept = requestLabel.text.slice(0, -`${ELLIPSIS}${requestSuffix}`.length);
    expect(kept.length).toBeGreaterThan(0);
    expect(request.name.startsWith(kept)).toBe(true);
    expect(LABEL_MEASURE(requestLabel.text)).toBeLessThanOrEqual(insideRoom);
    expect(
      LABEL_MEASURE(`${kept}${request.name.charAt(kept.length)}${ELLIPSIS}${requestSuffix}`),
    ).toBeGreaterThan(insideRoom);

    // The commit has no room after it (it ends the plot) and none inside (it
    // is narrower than the insets). The room before it, between the request
    // and its own bar, holds its name but not a four-grapheme cut of it with
    // the duration beside it, so the name is drawn alone, whole, end-anchored
    // before its bar and clear of the request.
    const commitLabel = commitRow.label;
    if (commitLabel === undefined) {
      throw new Error('the commit was left unlabelled');
    }
    const commitSuffix = ` · ${formatDurationCompact(commit.duration)}`;
    const gap = commitRow.x - commitLabel.end;
    const beforeRoom = commitLabel.end - (requestRow.end + gap);
    expect(commitLabel.text).toBe(commit.name);
    expect(commitLabel.inside).toBe(false);
    expect(gap).toBeGreaterThan(0);
    expect(commitLabel.start).toBeGreaterThan(requestRow.end);
    expect(LABEL_MEASURE(commit.name)).toBeLessThanOrEqual(beforeRoom);
    expect(LABEL_MEASURE(`${commit.name}${commitSuffix}`)).toBeGreaterThan(beforeRoom);
    expect(LABEL_MEASURE(`${commit.name.slice(0, 4)}${ELLIPSIS}${commitSuffix}`)).toBeGreaterThan(
      beforeRoom,
    );
  });

  it('cuts a hostile emoji name at a grapheme boundary, inside its bar, and keeps the whole name elsewhere', async () => {
    expect(HOSTILE_NAME).toHaveLength(243);
    const tree = nestedTree(HOSTILE_QUERY);
    const stub = resolvingTrace(tree);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const canvas = await findCanvas();
    const laneColumn = numericAttribute(barTitled(canvas, NESTED_ROOT.name), 'x');
    const rows = expectLabelsClear(canvas, laneColumn);

    const query = drawnRowNamed(rows, HOSTILE_NAME);
    const label = query.label;
    if (label === undefined) {
      throw new Error('the hostile span was left unlabelled');
    }

    // The widest room is inside the long bar: the name is cut there, the
    // duration kept after the ellipsis, and the whole text fits the bar.
    const suffix = ` · ${formatDurationCompact(HOSTILE_QUERY.duration)}`;
    expect(label.inside).toBe(true);
    expect(label.text.endsWith(`${ELLIPSIS}${suffix}`)).toBe(true);
    expect(label.end).toBeLessThanOrEqual(query.end);

    // The cut falls between graphemes: the kept prefix is exactly the name's
    // first graphemes, it ends in a whole emoji sequence, and no surrogate is
    // left unpaired.
    const kept = label.text.slice(0, -`${ELLIPSIS}${suffix}`.length);
    const keptGraphemes = splitGraphemes(kept);
    expect(keptGraphemes.length).toBeGreaterThan(1);
    expect(splitGraphemes(HOSTILE_NAME).slice(0, keptGraphemes.length).join('')).toBe(kept);
    expect(keptGraphemes.at(-1)).toBe('\u{1F469}\u200D\u{1F4BB}');
    // Under the `u` flag a paired surrogate is one code point, so this class
    // matches only a surrogate left alone.
    expect(label.text).not.toMatch(/[\uD800-\uDFFF]/u);

    // The whole name is still what the table and the bar's description carry.
    expect(renderedNames()).toContain(HOSTILE_NAME);
    expect(query.title.startsWith(`${HOSTILE_NAME} `)).toBe(true);
  });
});
