/**
 * `components/FlameChart` — the colocated suite for the `flame` node.
 *
 * ## What this suite is protecting
 *
 * Four properties of this view are easy to break and invisible when broken, so
 * each one has a case of its own rather than a comment:
 *
 *   - **Own time is measured against the interval UNION of a frame's children,
 *     never their sum.** Children overlap as a matter of routine — one route
 *     handler firing two calls in parallel is the ordinary case (AAP 0.4.2) —
 *     and subtracting a sum reports a negative own time for such a parent,
 *     which is then either clamped to nothing or drawn inverted. Either way the
 *     reader is told something false about where the time went. The fixture
 *     below is built so that the two implementations cannot agree: a 100 ms
 *     parent with two 55 ms children overlapping inside a 60 ms window has an
 *     own time of 40 ms by union and −10 ms by sum.
 *   - **The orientation is an icicle.** The trace root is the first row and its
 *     children hang below it, so a reader follows causality downward. A
 *     bottom-up flame — the orientation the name suggests — would invert the
 *     whole message, and only the document order and the row positions can tell
 *     the two apart.
 *   - **The picture is never the only representation** (AAP 0.6.4). The `<svg>`
 *     is `role="img"` with a text alternative, and beneath it every frame the
 *     chart draws is a row of a keyboard-reachable list. A frame neither shows
 *     is named in a note, so a reduction is always stated and never silent.
 *   - **Nothing here presents itself as a profiler** (AAP 0.6.6). The product
 *     samples no stacks and measures no CPU time; this component renders the
 *     recorded nesting of measured spans, and says so on screen. One assertion
 *     scans everything a reader or a screen reader can reach — text, accessible
 *     names, SVG titles — for profiling vocabulary, which is the durable guard
 *     against a future well-meaning label change.
 *
 * Alongside those, AAP 0.8.3 asks every component suite in this folder for the
 * three states of a query-backed view — loading, empty and error — and for the
 * click-to-source payload. Each state is driven through a stub `DataProvider`
 * that respectively never settles, resolves an empty trace and rejects; the
 * payload cases assert what the host actually receives, because every hop after
 * this one acts blind on the object it is handed (AAP 0.4.2, hop 1 of five).
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`, and `afterEach(cleanup)`
 *     registered explicitly, even though the `panel-renderer` project enables
 *     `globals` so that `@testing-library/react` can register its automatic
 *     cleanup: a suite that leaks a mounted tree fails later with a
 *     multiple-match error that reads like a component bug.
 *   - **Stub providers are built with the library's own `createDataProvider`**,
 *     so these cases exercise the seam the DevTools panel and the editor webview
 *     implement. The resolver is a `vi.fn` and every query it receives is
 *     recorded: what the component *asked for* is as much of its contract as
 *     what it drew.
 *   - **In-file synthetic builders, no fixture files.** {@link makeEvent},
 *     {@link makeTraceNode}, {@link nest} and {@link makeTree} take overrides;
 *     nothing here is read from disk or shared with another suite.
 *   - **`@debuggen/telemetry` is imported for types only.** The tree fixtures
 *     are hand-built and the expected own time is computed by hand in the
 *     comments below, so no telemetry runtime helper — `selfTimeOf`,
 *     `unionDurationMs` and the rest — takes part in either building or
 *     verifying a fixture. A test that reused the implementation's own
 *     arithmetic would agree with it whatever it computed.
 *   - **Nothing is measured from the DOM, and nothing is stubbed for it.** The
 *     component's geometry is arithmetic over a fixed `viewBox`, so there is no
 *     `getBoundingClientRect`, `ResizeObserver` or `offsetWidth` to fake.
 *   - **Generic fixture vocabulary only** (AAP 0.5.2, 0.5.4): operation names, a
 *     file path and a symbol that belong to no application, demonstration or
 *     otherwise. `scripts/check-no-hardcoding.mjs` scans this text with the rest
 *     of `packages/**`.
 *   - **Queries by role and accessible name.** The canvas, the list, its rows
 *     and their controls are all reached that way; a class is read only off an
 *     element already obtained semantically, since no `jest-dom` matcher is
 *     available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…`, and interactions through
 *     `userEvent`.
 *
 * @see ./FlameChart for the component, its states, its notes and its classes.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 * @see ../utils/scale for the bounded traversal whose limits the honesty cases
 * exercise.
 */

import type { DataQuery, FlameNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type {
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import { formatDuration } from '../utils/format';
import { FlameChart } from './FlameChart';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral (AAP 0.5.4): no component, route,
 * service or symbol of any inspected project appears here, in the fixtures or
 * in the comments. The identifiers are shaped as a capture shapes them — a
 * 32-hex trace id, 16-hex span ids, epoch-millisecond start times and
 * millisecond durations — because the component reads those fields and formats
 * them.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every frame below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'b7c8d9e0f1a2b3c4d5e6f70819202122';

/** The fixture session and capture the persisted events are attributed to. */
const SESSION_ID = 'session-example-0001';
const CAPTURE_ID = 'capture-example-0001';

/** The producer that reported them. */
const PRODUCER_ID = 'producer-example-0001';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Inside the window the event schema accepts, and far enough from zero that a
 * relative performance timestamp could not be mistaken for one.
 */
const BASE_START_MS = 1_767_225_600_000;

/** A project-relative, POSIX path for the one frame that resolved to source. */
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
const NODE_ID = 'layout.0.flame';

/** The error state's retry control. */
const RETRY_NAME = 'Retry';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/**
 * The prefix every fixture operation name shares.
 *
 * It is what lets a row's *name* control be told from its other controls by
 * role and name alone: the disclosure control announces "Expand the … inside …"
 * and a source chip announces "Open …", so neither matches this pattern while
 * the name button always does.
 */
const FRAME_NAME_PATTERN = /^example\./;

/**
 * The vocabulary this view must never use about itself (AAP 0.6.6).
 *
 * Deliberately broad stems rather than whole words: "CPU", "sample",
 * "sampled", "sampling", "profile", "profiler" and "profiling" all fail it, so
 * a label rewritten in good faith cannot quietly promote a nesting of measured
 * spans into a sampled call stack.
 */
const PROFILER_WORDING = /cpu|sampl|profil/i;

/**
 * The tiers, in the order a correlated tree lists them.
 *
 * Restated here rather than imported: `@debuggen/telemetry` is a type-only
 * dependency of this package, and this suite keeps that boundary (see the
 * harness note above).
 */
const TIER_ORDER: readonly TelemetryTier[] = ['browser', 'server', 'db'];

/**
 * The kinds these fixtures use, in the declaration order of the telemetry
 * kind vocabulary — which is the order a tree reports them in.
 *
 * Restated for the same reason as {@link TIER_ORDER}, and deliberately narrow:
 * it covers the fixtures below and nothing else, so an added fixture kind has
 * to be placed here consciously.
 */
const FIXTURE_KIND_ORDER: readonly TelemetryKind[] = [
  'interaction',
  'fetch',
  'route.handler',
  'function',
  'db.query',
  'http.client',
];

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/**
 * The optional fields of an event admit `undefined` explicitly, which `Partial`
 * does not under this repository's `exactOptionalPropertyTypes`: passing
 * `{ source: undefined }` is how a case asks for a frame *without* a location,
 * and {@link makeEvent} drops the key rather than storing the value.
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
    | 'seq'
    | 'ingestSeq'
  >
> & {
  readonly parentSpanId?: string | undefined;
  readonly source?: SourceLocation | undefined;
};

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return `00000000000${ordinal.toString(16).padStart(5, '0')}`;
}

/**
 * One persisted span record for a frame to draw.
 *
 * Complete and schema-shaped by construction: a 32-hex `traceId`, a 16-hex
 * `spanId`, an epoch-millisecond `startTime`, a millisecond `duration`, and a
 * `kind`/`tier` pair the event schema's cross-field rule permits (`interaction`
 * and `fetch` on `browser`, `route.handler` and `http.client` on `server`,
 * `db.query` on `db`, `function` on either).
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
    kind = 'function',
    name = 'example.operation',
    startTime = BASE_START_MS,
    duration = 12,
    tier = 'server',
    status = 'ok',
    seq = 0,
    ingestSeq = 1,
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
    attributes: {},
    status,
    producerId: PRODUCER_ID,
    seq,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * One node of a correlated trace: an event, its children and its depth.
 *
 * Neither orphaned nor asynchronously attributed — those flags describe
 * structure the correlator had to guess at, which no case here exercises — so
 * the optional keys are omitted rather than set to `undefined`, as
 * `exactOptionalPropertyTypes` requires of a `TraceNode` whose optional members
 * do not admit it.
 *
 * @param event The captured record this node stands for.
 * @param children Its direct children, in canonical order.
 * @param depth Its distance from the trace root.
 * @returns A fresh node.
 */
function makeTraceNode(
  event: TelemetryEvent,
  children: readonly TraceNode[] = [],
  depth = 0,
): TraceNode {
  return { event, children, depth, orphaned: false };
}

/**
 * A chain: each event nested inside the one before it, depths assigned by
 * position.
 *
 * Built from the innermost event outward in a loop rather than by recursion, so
 * a chain of a few hundred levels — which one case below builds deliberately —
 * costs the fixture nothing.
 *
 * @param events The chain from root to leaf; at least one.
 * @returns The chain's root node.
 */
function nest(events: readonly TelemetryEvent[]): TraceNode {
  let node: TraceNode | undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    node = makeTraceNode(event, node === undefined ? [] : [node], index);
  }

  if (node === undefined) {
    throw new Error('nest requires at least one event');
  }

  return node;
}

/** The three facts about a trace that only its correlator knows. */
interface TreeOverrides {
  /** Whether the correlator stopped short of including everything. */
  readonly truncated?: boolean;
  /** How many records it had to re-attach to the root. */
  readonly orphanCount?: number;
  /** Span ids it saw more than once. */
  readonly duplicateSpanIds?: readonly string[];
}

/**
 * A correlated trace around the given roots.
 *
 * The counters — `nodeCount`, `maxDepth`, the window and its duration, the
 * tiers, the kinds and the producers — are derived from the nodes by an
 * iterative walk *in this file*, so a fixture cannot describe itself
 * inconsistently and a three-hundred-node chain needs no hand-counted totals.
 * What the walk deliberately does **not** derive is any per-node timing
 * arithmetic: own time is the component's to compute and this suite's to check
 * against a hand calculation.
 *
 * @param roots The roots, in canonical order.
 * @param overrides The correlator's own observations about its input.
 * @returns A consistent tree.
 */
function makeTree(roots: readonly TraceNode[], overrides: TreeOverrides = {}): TraceTree {
  const kinds = new Set<TelemetryKind>();
  const tiers = new Set<TelemetryTier>();
  const producers = new Set<string>();
  const stack: TraceNode[] = [...roots];

  let nodeCount = 0;
  let maxDepth = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }

    nodeCount += 1;
    maxDepth = Math.max(maxDepth, node.depth);
    earliest = Math.min(earliest, node.event.startTime);
    latest = Math.max(latest, node.event.startTime + node.event.duration);
    kinds.add(node.event.kind);
    tiers.add(node.event.tier);
    producers.add(node.event.producerId);

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const empty = nodeCount === 0;
  const startTime = empty ? 0 : earliest;
  const endTime = empty ? 0 : latest;
  const primaryRoot = roots[0];

  return {
    traceId: TRACE_ID,
    roots,
    ...(primaryRoot === undefined ? {} : { primaryRootSpanId: primaryRoot.event.spanId }),
    nodeCount,
    maxDepth,
    startTime,
    endTime,
    totalDuration: Math.max(0, endTime - startTime),
    orphanCount: overrides.orphanCount ?? 0,
    tiers: TIER_ORDER.filter((tier) => tiers.has(tier)),
    kinds: FIXTURE_KIND_ORDER.filter((kind) => kinds.has(kind)),
    producerIds: [...producers].sort(),
    duplicateSpanIds: overrides.duplicateSpanIds ?? [],
    truncated: overrides.truncated ?? false,
  };
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<FlameNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `flame` node, as the panel normaliser produces one: an id, no
 * heading of its own (the host's section owns that) and a query naming the one
 * source the catalog permits, narrowed to a single interaction.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): FlameNode {
  const {
    id = NODE_ID,
    query = { source: 'trace', filter: { traceId: TRACE_ID } },
    title,
    description,
  } = overrides;

  return {
    type: 'flame',
    id,
    query,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
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
   * The assertion surface for the retry case and for "a node this view cannot
   * draw asks for nothing": what the component *requested* is as much of its
   * contract as what it rendered.
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
 * A provider that resolves the same correlated trace for every query.
 *
 * @param tree The trace to answer with.
 * @returns The stub provider.
 */
function resolvingProvider(tree: TraceTree): StubProvider {
  return recordingProvider(() =>
    Promise.resolve<DataQueryResponse>({ source: 'trace', data: tree }),
  );
}

/**
 * A provider that answers a `trace` query with something that is not a trace.
 *
 * The response is well formed at the transport's level — it echoes the source
 * it was asked about, so the factory's own check passes — and wrong at the
 * payload's, which is the one failure mode `useQuery` cannot catch: it writes a
 * provider's answer through verbatim. The component's own shape guard is what
 * keeps that from throwing inside a render.
 *
 * @returns The stub provider.
 */
function wrongShapeProvider(): StubProvider {
  return recordingProvider(() => Promise.resolve<DataQueryResponse>({ source: 'trace', data: [] }));
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

  /** The disclosure-report spy, supplied so cases can assert on it. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host —
 * and the optional disclosure report is supplied too, so every case can assert
 * not only that the intent it exercised was raised but also that the others
 * were not: activating a chip must not also select a frame, and selecting a
 * frame must not report a disclosure.
 *
 * @returns The actions object and its three spies.
 */
function makeActions(): ActionSpies {
  const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
  const onOpenSource = vi.fn<(location: SourceLocation) => void>();
  const onExpand = vi.fn<(nodeId: string, itemId: string, expanded: boolean) => void>();

  return {
    actions: { onSelectEvent, onOpenSource, onExpand },
    onSelectEvent,
    onOpenSource,
    onExpand,
  };
}

/**
 * Renders the component inside both host contexts.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 * @returns The render container, for the whole-output scans below.
 */
function renderComponent(
  node: FlameNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): HTMLElement {
  return render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelActionsContext.Provider value={context.actions}>
        <FlameChart node={node} />
      </PanelActionsContext.Provider>
    </DataProviderContext.Provider>,
  ).container;
}

/** The text equivalent: the list that carries one row per drawn frame. */
function frameList(): HTMLElement {
  return screen.getByRole('list');
}

/** Its rows, in document order. */
function frameRows(): HTMLElement[] {
  return within(frameList()).getAllByRole('listitem');
}

/**
 * The control that names a frame, obtained by role from a row.
 *
 * @param row A row of the text equivalent.
 * @returns That row's name control.
 */
function nameControlOf(row: HTMLElement): HTMLElement {
  return within(row).getByRole('button', { name: FRAME_NAME_PATTERN });
}

/** The frame names the text equivalent carries, in document order. */
function frameNames(): string[] {
  return frameRows().map((row) => nameControlOf(row).textContent ?? '');
}

/**
 * The row naming `name`.
 *
 * @param name The frame name to find.
 * @returns That row.
 */
function rowNamed(name: string): HTMLElement {
  const row = frameRows()[frameNames().indexOf(name)];

  if (row === undefined) {
    throw new Error(`no rendered row is named "${name}"`);
  }

  return row;
}

/**
 * A row's own two duration cells, in document order: its measured duration and
 * then its own time.
 *
 * Read off a row already obtained by role, and filtered to the cells outside
 * the row's tooltip: the same two figures appear inside the bubble, which is
 * always in the DOM (visually hidden until the row is hovered or focused), so a
 * bare class query would return four elements and an index into them would be a
 * guess.
 *
 * @param row A row of the text equivalent.
 * @returns The row's `[duration, ownTime]` cells.
 */
function ownDurationCells(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>('.dg-duration-cell')).filter(
    (cell) => cell.closest('.dg-tooltip__bubble') === null,
  );
}

/**
 * The two figures a row shows, as the reader sees them.
 *
 * @param row A row of the text equivalent.
 * @returns The formatted duration and own time.
 */
function figuresOf(row: HTMLElement): { readonly duration: string; readonly ownTime: string } {
  const [duration, ownTime] = ownDurationCells(row);

  if (duration === undefined || ownTime === undefined) {
    throw new Error('a row must show both its measured duration and its own time');
  }

  return { duration: duration.textContent ?? '', ownTime: ownTime.textContent ?? '' };
}

/** The canvas: the picture, which is an image with a text alternative. */
function canvas(): HTMLElement {
  return screen.getByRole('img');
}

/** The icicle's depth rows, in document order — one group per shown depth. */
function icicleRows(): SVGGElement[] {
  return Array.from(canvas().querySelectorAll<SVGGElement>('g.dg-flame__row'));
}

/**
 * The `y` coordinate of the first bar of each depth row, in document order.
 *
 * The vertical rhythm itself is not asserted anywhere in this suite — it
 * belongs to `../utils/scale` — so these are read as opaque numbers and only
 * their order and distinctness are checked.
 *
 * @returns One coordinate per shown depth.
 */
function depthOffsets(): number[] {
  return icicleRows().map((group) => {
    const bar = group.querySelector('rect.dg-flame__frame');

    if (bar === null) {
      throw new Error('a depth row must draw at least one frame');
    }

    return Number.parseFloat(bar.getAttribute('y') ?? '');
  });
}

/** Every `<title>` the canvas carries, in document order: one per bar. */
function barTitles(): string[] {
  return Array.from(canvas().querySelectorAll('title')).map((title) => title.textContent ?? '');
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

/*
 * ---------------------------------------------------------------------------
 * The three-level chain most cases draw
 *
 * One interaction, the request it issued and the route handler that answered:
 * three levels, three tiers touched, three distinct durations, and exactly one
 * frame carrying a resolved source location — which is what lets the selection
 * case activate a frame with no chip in it and the chip case activate a chip
 * without selecting anything.
 * ---------------------------------------------------------------------------
 */

/** Depth 0: the browser interaction that started everything. */
const INTERACTION_EVENT = makeEvent({
  id: 'event-example-0001',
  spanId: spanIdFor(1),
  name: 'example.interaction',
  kind: 'interaction',
  tier: 'browser',
  startTime: BASE_START_MS,
  duration: 120,
  seq: 0,
  ingestSeq: 1,
});

/** Depth 1: the request the handler answered, inside the interaction's window. */
const REQUEST_EVENT = makeEvent({
  id: 'event-example-0002',
  spanId: spanIdFor(2),
  parentSpanId: spanIdFor(1),
  name: 'example.request',
  kind: 'fetch',
  tier: 'browser',
  startTime: BASE_START_MS + 4,
  duration: 100,
  seq: 1,
  ingestSeq: 2,
});

/** Depth 2: the server work, and the only frame that resolved to source. */
const HANDLER_EVENT = makeEvent({
  id: 'event-example-0003',
  spanId: spanIdFor(3),
  parentSpanId: spanIdFor(2),
  name: 'example.handler',
  kind: 'route.handler',
  tier: 'server',
  startTime: BASE_START_MS + 10,
  duration: 80,
  seq: 2,
  ingestSeq: 3,
  source: BASE_SOURCE,
});

/** The chain, outermost first — which is also the order an icicle draws it. */
const CHAIN_EVENTS: readonly TelemetryEvent[] = [INTERACTION_EVENT, REQUEST_EVENT, HANDLER_EVENT];

/** Their names, in that same order. */
const CHAIN_NAMES: readonly string[] = CHAIN_EVENTS.map((event) => event.name);

/** The correlated trace those three events form. */
const CHAIN_TREE = makeTree([nest(CHAIN_EVENTS)]);

/*
 * ---------------------------------------------------------------------------
 * The parallel-children shape, and its own time computed by hand
 *
 * A 100 ms parent with two 55 ms children that overlap:
 *
 *   parent    [   0 …………………………………………………………………………………… 100 ]
 *   child A        [  10 ……………………………… 65 ]
 *   child B             [  15 ……………………………… 70 ]
 *
 * The children's intervals MERGE to [10, 70] — a 60 ms window — so the parent's
 * own time is 100 − 60 = 40 ms. Their DURATIONS sum to 110 ms, so an
 * implementation that subtracted the sum would compute −10 ms and, after the
 * non-negative clamp every duration goes through, display 0 ms instead. The two
 * answers are therefore distinguishable on screen, which is the whole point of
 * this shape (AAP 0.4.2: parallel work inside one interaction is ordinary).
 * ---------------------------------------------------------------------------
 */

/** The parent's measured duration, in milliseconds. */
const PARALLEL_PARENT_DURATION_MS = 100;

/** Each child's measured duration, in milliseconds. */
const PARALLEL_CHILD_DURATION_MS = 55;

/** The children's merged interval length, by hand: 70 − 10. */
const PARALLEL_UNION_MS = 60;

/** The parent's own time, by hand: its duration minus that merge. */
const PARALLEL_OWN_TIME_MS = PARALLEL_PARENT_DURATION_MS - PARALLEL_UNION_MS;

/**
 * What a sum-based implementation would show instead: 100 − 55 − 55 is −10, and
 * a negative duration is clamped to zero before it is formatted.
 */
const PARALLEL_SUM_OWN_TIME_MS = 0;

/** The parent of the two parallel children. */
const PARALLEL_PARENT_EVENT = makeEvent({
  id: 'event-example-0011',
  spanId: spanIdFor(11),
  name: 'example.handler',
  kind: 'route.handler',
  tier: 'server',
  startTime: BASE_START_MS,
  duration: PARALLEL_PARENT_DURATION_MS,
  seq: 0,
  ingestSeq: 1,
});

/** The first child: [+10, +65] inside the parent's window. */
const PARALLEL_QUERY_EVENT = makeEvent({
  id: 'event-example-0012',
  spanId: spanIdFor(12),
  parentSpanId: spanIdFor(11),
  name: 'example.query',
  kind: 'db.query',
  tier: 'db',
  startTime: BASE_START_MS + 10,
  duration: PARALLEL_CHILD_DURATION_MS,
  seq: 1,
  ingestSeq: 2,
});

/** The second child: [+15, +70], overlapping the first. */
const PARALLEL_OUTBOUND_EVENT = makeEvent({
  id: 'event-example-0013',
  spanId: spanIdFor(13),
  parentSpanId: spanIdFor(11),
  name: 'example.outbound',
  kind: 'http.client',
  tier: 'server',
  startTime: BASE_START_MS + 15,
  duration: PARALLEL_CHILD_DURATION_MS,
  seq: 2,
  ingestSeq: 3,
});

/** The trace those three events form: one parent, two overlapping children. */
const PARALLEL_TREE = makeTree([
  makeTraceNode(
    PARALLEL_PARENT_EVENT,
    [makeTraceNode(PARALLEL_QUERY_EVENT, [], 1), makeTraceNode(PARALLEL_OUTBOUND_EVENT, [], 1)],
    0,
  ),
]);

/*
 * ---------------------------------------------------------------------------
 * Deep chains, for the bounds the component states rather than hides
 *
 * The three constants below are the component's own, restated here so a case
 * asserts against a stated number instead of against whatever the layout
 * currently does. A change to either bound is expected to fail these cases and
 * be re-stated, which is exactly the review this behaviour deserves.
 * ---------------------------------------------------------------------------
 */

/** The deepest row the icicle draws; deeper nodes are reported in a note. */
const ICICLE_DEPTH_BOUND = 32;

/** The depth at which a subtree arrives folded behind its own control. */
const AUTO_FOLD_DEPTH = 12;

/** Depths 0 … {@link AUTO_FOLD_DEPTH} — every frame a deep chain shows at first. */
const VISIBLE_DEPTH_COUNT = AUTO_FOLD_DEPTH + 1;

/** The root duration of a generated chain, wide enough for 300 nested levels. */
const DEEP_CHAIN_ROOT_DURATION_MS = 900;

/** Levels for the bound-and-fold case: past the depth bound, and no further. */
const CLAMPED_CHAIN_LEVELS = 40;

/** Levels for the stack-safety case: far past anything a real trace reaches. */
const DEEP_CHAIN_LEVELS = 300;

/**
 * The frame that arrives folded in any generated chain: the one at
 * {@link AUTO_FOLD_DEPTH}.
 */
const FOLDED_FRAME_NAME = `example.chain.${String(AUTO_FOLD_DEPTH).padStart(3, '0')}`;

/** The frame immediately inside it, hidden until that one is expanded. */
const FIRST_HIDDEN_FRAME_NAME = `example.chain.${String(AUTO_FOLD_DEPTH + 1).padStart(3, '0')}`;

/** The span id the folded frame is identified by, and reports as its item id. */
const FOLDED_FRAME_SPAN_ID = spanIdFor(1000 + AUTO_FOLD_DEPTH);

/**
 * A chain of `levels` nested operations, each inside the one above it.
 *
 * Every level is 2 ms shorter than its parent and starts 1 ms later, so the
 * nesting is geometrically real — a child's window lies inside its parent's —
 * and every duration stays positive for the deepest chain built here.
 *
 * @param levels How many levels to build; at least one.
 * @returns The correlated trace that chain forms.
 */
function deepChain(levels: number): TraceTree {
  const events: TelemetryEvent[] = [];

  for (let depth = 0; depth < levels; depth += 1) {
    events.push(
      makeEvent({
        id: `event-example-chain-${String(depth).padStart(4, '0')}`,
        spanId: spanIdFor(1000 + depth),
        ...(depth === 0 ? {} : { parentSpanId: spanIdFor(1000 + depth - 1) }),
        name: `example.chain.${String(depth).padStart(3, '0')}`,
        kind: 'function',
        tier: 'server',
        startTime: BASE_START_MS + depth,
        duration: DEEP_CHAIN_ROOT_DURATION_MS - 2 * depth,
        seq: depth,
        ingestSeq: depth + 1,
      }),
    );
  }

  return makeTree([nest(events)]);
}

describe('FlameChart states', () => {
  it('announces a query in flight, draws nothing else, and asks for the node’s own query', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes the
    // variant and the element class that places it.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.classList.contains('dg-loading-state--chart')).toBe(true);
    expect(busy.parentElement?.classList.contains('dg-flame__loading')).toBe(true);

    // Nothing is drawn yet: no picture, no text equivalent, and above all no
    // empty state — an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // One query, issued as the node carried it: this view adds no paging,
    // ordering or filtering of its own.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(soleQuery(stub)).toEqual({ source: 'trace', filter: { traceId: TRACE_ID } });
  });

  it('renders its own empty message for a successful but empty trace', async () => {
    const stub = resolvingProvider(makeTree([]));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic substring of the product's own copy, then checked to
    // be exactly that: product vocabulary, naming no inspected project.
    const message = await screen.findByText(/no trace was captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);

    // An empty trace is a success, so it is drawn as an absence and not as a
    // failure — and there is no picture to imply frames behind it.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
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
    expect(alert.parentElement?.classList.contains('dg-flame__error')).toBe(true);

    // What the reader is told: this view's own sentence about what could not be
    // drawn, and the failure's CODE, which is the part of a rejection that
    // identifies it. The provider's prose is deliberately not restated in the
    // alert — an error state is not an analysis (AAP 0.5.5) — so the assertion
    // is that the code arrives, not that the message is echoed.
    expect(alert.textContent).toContain('nested timing');
    expect(alert.textContent).toContain('could not be loaded');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown field by field, in this view's own
    // vocabulary, so a reader can tell which interaction went unanswered.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(shown.textContent).toBe(`source=trace traceId=${TRACE_ID}`);

    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The retry an error state offers is only useful if it really re-queries.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual(queryOfCall(stub, 1));

    // No frames were invented behind the failure.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('reports a node whose query names a source it cannot draw, and asks for nothing', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode({ query: { source: 'spans' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');

    // The node's own query is what the reader is shown, and no retry is
    // offered: re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(shown.textContent).toBe('source=spans');
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();
    expect(alert.textContent).toContain('needs regenerating');

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('reports a payload that is not a correlated trace instead of crashing on it', async () => {
    const stub = wrongShapeProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The hook writes a provider's answer through verbatim, so this shape would
    // otherwise be read as a tree and throw inside a render.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('needs regenerating');
    expect(screen.queryByRole('list')).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('FlameChart hierarchy', () => {
  it('draws the root first and one depth row per level, downward', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('list');

    // Document order is outermost first in both representations — the icicle
    // orientation, not a bottom-up flame.
    expect(frameNames()).toEqual([...CHAIN_NAMES]);
    expect(barTitles().map((title) => title.split('\n')[0])).toEqual([...CHAIN_NAMES]);

    // The list states each frame's level for a screen reader.
    expect(frameRows().map((row) => row.getAttribute('aria-level'))).toEqual(['1', '2', '3']);

    // Three depth rows, at three distinct and strictly increasing offsets: a
    // layout that collapsed two levels onto one row, or inverted them, fails
    // here. The rhythm itself belongs to `../utils/scale` and is not asserted.
    const offsets = depthOffsets();
    expect(offsets).toHaveLength(CHAIN_EVENTS.length);
    expect(new Set(offsets).size).toBe(CHAIN_EVENTS.length);

    const [rootOffset, middleOffset, leafOffset] = offsets;
    if (rootOffset === undefined || middleOffset === undefined || leafOffset === undefined) {
      throw new Error('the icicle drew fewer depth rows than the chain has levels');
    }
    expect(rootOffset).toBeLessThan(middleOffset);
    expect(middleOffset).toBeLessThan(leafOffset);
  });

  it('carries every frame in a keyboard-reachable list beside the picture', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('list');

    // One entry per node in the trace — the text equivalent is complete, not a
    // sample of it (AAP 0.6.4).
    expect(frameRows()).toHaveLength(CHAIN_TREE.nodeCount);

    for (const [index, event] of CHAIN_EVENTS.entries()) {
      const row = rowNamed(event.name);

      // Name and measured duration, both on the row itself rather than only in
      // its hover detail.
      const control = nameControlOf(row);
      expect(control.tagName).toBe('BUTTON');
      expect(control.textContent).toBe(event.name);
      expect(figuresOf(row).duration).toBe(formatDuration(event.duration));
      expect(row.textContent).not.toContain(String(event.startTime));

      // The hierarchy is carried in the list too: a row states its level for a
      // screen reader and hands its depth to the stylesheet as the indentation
      // to apply — the only inline value this view contributes, and a token
      // reference rather than a length (AAP 0.6.4).
      expect(row.getAttribute('aria-level')).toBe(String(index + 1));
      expect(row.getAttribute('style')).toContain(`--dgc-depth: ${String(index)}`);
    }

    // The keyboard reaches the list without passing through the picture: the
    // canvas exposes no focusable bar, so the first Tab lands inside the first
    // row.
    await user.tab();
    const [firstRow] = frameRows();
    if (firstRow === undefined) {
      throw new Error('the text equivalent rendered no rows');
    }
    expect(firstRow.contains(document.activeElement)).toBe(true);

    // The picture is an image with a text alternative, and the list is named
    // separately: neither representation stands alone.
    const picture = canvas();
    expect(picture.getAttribute('aria-label')).toContain('operations');
    expect(picture.getAttribute('aria-hidden')).toBeNull();
    expect(frameList().getAttribute('aria-label')).toContain('operations');
  });

  it('never describes itself as a profile, a sample or CPU time', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    const container = renderComponent(makeNode({ title: 'Nested timing' }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('list');

    // The on-screen statement AAP 0.6.6 requires: what a bar actually is.
    expect(screen.getByText(/recorded operation/i)).toBeDefined();

    // Everything a reader or a screen reader can reach: the rendered text, the
    // canvas's role and text alternative, every accessible name, and the
    // titles the bars carry.
    const spoken = [
      container.textContent ?? '',
      canvas().getAttribute('role') ?? '',
      ...Array.from(container.querySelectorAll('[aria-label]')).map(
        (element) => element.getAttribute('aria-label') ?? '',
      ),
      ...barTitles(),
    ].join(' ');

    // The scan really saw the output, so a passing assertion cannot be an
    // empty string matching nothing.
    expect(spoken).toContain(HANDLER_EVENT.name);
    expect(spoken).toContain('Nested timing');
    expect(PROFILER_WORDING.test(spoken)).toBe(false);
  });

  it('renders the same trace in the same order every time', async () => {
    const first = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: first.provider, actions: makeActions().actions });
    await screen.findByRole('list');

    const firstNames = frameNames();
    const firstTitles = barTitles();

    cleanup();

    const second = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: second.provider, actions: makeActions().actions });
    await screen.findByRole('list');

    // Same frames, same order, in both representations: the traversal preserves
    // the correlator's canonical ordering and nothing here re-sorts it.
    expect(frameNames()).toEqual(firstNames);
    expect(barTitles()).toEqual(firstTitles);
  });
});

describe('FlameChart own time', () => {
  it('subtracts the union of overlapping children, never their sum', async () => {
    const stub = resolvingProvider(PARALLEL_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('list');

    const parent = rowNamed(PARALLEL_PARENT_EVENT.name);
    const figures = figuresOf(parent);

    // The measured duration is untouched…
    expect(figures.duration).toBe(formatDuration(PARALLEL_PARENT_DURATION_MS));

    // …and the own time is the duration minus the children's MERGED interval,
    // computed by hand at the fixture above: 100 − 60 = 40 ms.
    expect(figures.ownTime).toBe(formatDuration(PARALLEL_OWN_TIME_MS));

    // Two literals, so this case does not rest on the formatter it also uses:
    // a `formatDuration` that returned the same string for every input would
    // satisfy the two assertions above and nothing here.
    expect(figures.duration).toBe('100.00 ms');
    expect(figures.ownTime).toBe('40.00 ms');

    // Never negative, and never the sum-based answer, which would have clamped
    // to zero and told the reader the parent did nothing itself.
    const shownOwnTime = Number.parseFloat(figures.ownTime);
    expect(shownOwnTime).toBeGreaterThanOrEqual(0);
    expect(shownOwnTime).toBeLessThanOrEqual(PARALLEL_PARENT_DURATION_MS);
    expect(figures.ownTime).not.toBe(formatDuration(PARALLEL_SUM_OWN_TIME_MS));
    expect(figures.ownTime.startsWith('-')).toBe(false);

    // A leaf accounts for all of its own time, which is what makes the parent's
    // figure readable as "time this frame spent itself".
    for (const child of [PARALLEL_QUERY_EVENT, PARALLEL_OUTBOUND_EVENT]) {
      const childFigures = figuresOf(rowNamed(child.name));
      expect(childFigures.duration).toBe(formatDuration(PARALLEL_CHILD_DURATION_MS));
      expect(childFigures.ownTime).toBe(formatDuration(PARALLEL_CHILD_DURATION_MS));
    }
  });
});

describe('FlameChart interactions', () => {
  it('announces the activated frame as the event it stands for', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('list');

    const row = rowNamed(REQUEST_EVENT.name);
    expect(row.getAttribute('aria-current')).toBeNull();

    await user.click(nameControlOf(row));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    const ref = call[0];

    // The three identifiers the host needs to resolve the record, taken from
    // that frame's own event and nothing else.
    expect(ref).toEqual({
      eventId: REQUEST_EVENT.id,
      spanId: REQUEST_EVENT.spanId,
      traceId: REQUEST_EVENT.traceId,
    });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // Both representations show where the click landed, and only there: one
    // row and one bar carry the selected state.
    const selectedRow = rowNamed(REQUEST_EVENT.name);
    expect(selectedRow.getAttribute('aria-current')).toBe('true');
    expect(selectedRow.classList.contains('dg-is-selected')).toBe(true);
    expect(
      frameRows().filter((candidate) => candidate.getAttribute('aria-current') === 'true'),
    ).toHaveLength(1);
    expect(canvas().querySelectorAll('rect.dg-flame__frame.dg-is-selected')).toHaveLength(1);

    // Selecting a frame is not opening its source, and it is not a disclosure.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('hands the host the very location a frame resolved to, and selects nothing', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
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

    // Opening source is not selecting a frame: the chip's activation stops at
    // the chip, so the row it sits in is not activated as well.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(
      frameRows().filter((candidate) => candidate.getAttribute('aria-current') === 'true'),
    ).toHaveLength(0);
  });

  it('draws no chip for a frame the capture could not resolve to a location', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('list');

    const row = rowNamed(INTERACTION_EVENT.name);

    expect(within(row).queryByRole('button', { name: /^Open / })).toBeNull();
    expect(row.textContent).not.toContain(SOURCE_FILE);

    // Exactly one frame in this trace resolved, so exactly one chip exists.
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(1);
  });
});

describe('FlameChart honesty', () => {
  it('says so when the correlator itself truncated the trace', async () => {
    const stub = resolvingProvider(makeTree([nest(CHAIN_EVENTS)], { truncated: true }));

    const container = renderComponent(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('list');

    // The honesty note comes first because it frames everything under it; the
    // reduction follows it rather than replacing it.
    const notes = Array.from(container.querySelectorAll('.dg-flame__note')).map(
      (note) => note.textContent ?? '',
    );
    expect(notes[0]).toMatch(/recorded operation/i);
    expect(notes.some((note) => /arrived incomplete/i.test(note))).toBe(true);

    // The frames that did arrive are still drawn: a partial trace is evidence,
    // not an error.
    expect(frameNames()).toEqual([...CHAIN_NAMES]);
  });

  it('states the depth bound and the fold instead of dropping deeper frames', async () => {
    const tree = deepChain(CLAMPED_CHAIN_LEVELS);
    const stub = resolvingProvider(tree);

    const container = renderComponent(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('list');

    // Depths 0 … 12 are shown; the subtree at the fold depth arrives folded,
    // which is what keeps a deep trace readable.
    const rows = frameRows();
    expect(rows).toHaveLength(VISIBLE_DEPTH_COUNT);
    expect(rows.length).toBeLessThan(tree.nodeCount);
    expect(frameNames().at(-1)).toBe(FOLDED_FRAME_NAME);
    expect(screen.queryByText(FIRST_HIDDEN_FRAME_NAME)).toBeNull();

    // Every reduction is named. The traversal walked past the fold to the depth
    // bound, so both notes are owed: one for the levels this layout does not
    // draw at all, one for the subtree the reader can open.
    const notes = Array.from(container.querySelectorAll('.dg-flame__note')).map(
      (note) => note.textContent ?? '',
    );
    expect(
      notes.some((note) =>
        new RegExp(`deeper than ${String(ICICLE_DEPTH_BOUND)} levels`, 'i').test(note),
      ),
    ).toBe(true);
    expect(notes.some((note) => /folded, hiding \d+ operations/i.test(note))).toBe(true);

    // The picture and the list agree about what is on screen.
    expect(canvas().querySelectorAll('rect.dg-flame__frame')).toHaveLength(rows.length);
  });

  it('opens a folded subtree on request and reports the disclosure', async () => {
    const stub = resolvingProvider(deepChain(CLAMPED_CHAIN_LEVELS));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('list');

    const folded = rowNamed(FOLDED_FRAME_NAME);
    const disclosure = within(folded).getByRole('button', { name: /^Expand the / });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    await user.click(disclosure);

    // One more level is on screen, and the report names the node, the frame and
    // the state AFTER the gesture.
    expect(frameRows()).toHaveLength(VISIBLE_DEPTH_COUNT + 1);
    expect(frameNames().at(-1)).toBe(FIRST_HIDDEN_FRAME_NAME);
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
    expect(spies.onExpand).toHaveBeenCalledWith(NODE_ID, FOLDED_FRAME_SPAN_ID, true);

    // Opening a subtree is not selecting it.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('renders a chain of hundreds of levels without overflowing the stack', async () => {
    const tree = deepChain(DEEP_CHAIN_LEVELS);
    const stub = resolvingProvider(tree);

    const container = renderComponent(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    // Reaching the list at all is the assertion: the traversal, the model and
    // both representations are iterative, so a pathological depth costs rows
    // and a note rather than a thrown `RangeError`.
    await screen.findByRole('list');

    expect(tree.nodeCount).toBe(DEEP_CHAIN_LEVELS);
    expect(frameRows()).toHaveLength(VISIBLE_DEPTH_COUNT);
    expect(frameNames()[0]).toBe('example.chain.000');
    expect(
      Array.from(container.querySelectorAll('.dg-flame__note')).some((note) =>
        /deeper than/i.test(note.textContent ?? ''),
      ),
    ).toBe(true);
  });
});
