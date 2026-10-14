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
 *     handler firing two calls in parallel is the ordinary case — and
 *     subtracting a sum reports a negative own time for such a parent, which
 *     is then either clamped to nothing or drawn inverted. Either way the
 *     reader is told something false about where the time went. The fixture
 *     below is built so that the two implementations cannot agree: a 100 ms
 *     parent with two 55 ms children overlapping inside a 60 ms window has an
 *     own time of 40 ms by union and −10 ms by sum.
 *   - **The orientation is an icicle.** The trace root is the first row and its
 *     children hang below it, so a reader follows causality downward. A
 *     bottom-up flame — the orientation the name suggests — would invert the
 *     whole message, and only the document order and the row positions can tell
 *     the two apart.
 *   - **The picture is never the only representation.** The `<svg>` is
 *     `role="img"` with a text alternative, and beneath it every frame the
 *     chart draws is a row of a keyboard-reachable tree. A frame neither shows
 *     is named in a note or in the partial-result notice, so a reduction is
 *     always stated and never silent — and where more of the trace is in
 *     memory, the notice offers it.
 *   - **Nothing here presents itself as a profiler.** The product samples no
 *     stacks and measures no CPU time; this component renders the recorded
 *     nesting of measured spans, and says so on screen. One assertion scans
 *     everything a reader or a screen reader can reach — text, accessible
 *     names, SVG titles — for profiling vocabulary, which is the durable guard
 *     against a future well-meaning label change.
 *
 * Captured and model-authored text also displays its logical order: a Unicode
 * direction control in a frame's name, an ancestor's name or the node's title
 * is drawn as its visible escape (`\u202E`) in every label, SVG `<title>` and
 * accessible name — never raw, never as markup — while the selection a frame
 * raises still carries the raw event id.
 *
 * Alongside those, every component suite in this folder covers the three states
 * of a query-backed view — loading, empty and error — and the click-to-source
 * payload. Each state is driven through a stub `DataProvider` that respectively
 * never settles, resolves an empty trace — or `null`, the service's answer when
 * no trace matched — and rejects; the payload cases assert what the host
 * actually receives, because every hop after this one acts blind on the object
 * it is handed (this is the first hop of the path `docs/ARCHITECTURE.md` traces
 * under "A click, end to end").
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
 *   - **Layout is absent, and never stubbed.** happy-dom lays nothing out, and
 *     the component reads no size: the chart always draws in its fixed
 *     1 000-unit logical space, with labels fitted by the deterministic advance
 *     estimate in the same units, and the tree always renders one page of
 *     rows, the page holding its tab stop, which its row controls and its
 *     keys turn by count — so every case runs exactly as a browser would, and
 *     its geometry and its paging are arithmetic a case can assert exactly. No
 *     layout API (`getBoundingClientRect`, `ResizeObserver`, `client*`,
 *     `offset*`, `scroll*` sizes) is spied on or faked anywhere. The one spy on
 *     an element method is on `scrollIntoView`, a request the component makes
 *     of the browser rather than a size it reads: it records whether a
 *     selection made elsewhere asked for its row to be revealed.
 *   - **Generic fixture vocabulary only**: operation names, a file path and a
 *     symbol that belong to no application, demonstration or otherwise.
 *     `scripts/check-no-hardcoding.mjs` skips test files, so this suite keeps
 *     the product's neutral vocabulary by convention.
 *   - **Queries by role and accessible name.** The canvas, the tree, its rows
 *     and their controls are all reached that way; a class is read only off an
 *     element already obtained semantically, since no `jest-dom` matcher is
 *     available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…` and interactions through
 *     `userEvent`.
 *
 * @see ./FlameChart for the component, its states, its notes and its classes.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 * @see ../utils/scale for the bounded traversal whose limits the honesty cases
 * exercise.
 */

import type { DataQuery, FlameNode } from '@debuggen/panel-schema';
import { catalogEntryFor } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type {
  OrphanReason,
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext, PanelSelectionContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef, PanelSelectionState } from '../host/PanelActions';
import {
  NOT_AVAILABLE_LABEL,
  containsDirectionControl,
  estimateTextWidth,
  formatDuration,
  formatCount,
} from '../utils/format';
import { kindColorVar, kindInkColorVar } from '../utils/color';
import { FlameChart } from './FlameChart';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral: no component, route, service or
 * symbol of any inspected project appears here, in the fixtures or in the
 * comments. The identifiers are shaped as a capture shapes them — a 32-hex
 * trace id, 16-hex span ids, epoch-millisecond start times and millisecond
 * durations — because the component reads those fields and formats them.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every frame below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'b7c8d9e0f1a2b3c4d5e6f70819202122';

/** A second trace id, for the case that re-points a node at another query. */
const OTHER_TRACE_ID = 'c8d9e0f1a2b3c4d5e6f7081920212223';

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

/*
 * The shared error-state contract — the one wording every failed node in the
 * panel uses — spelled out rather than read back from `../host/useQuery`, so
 * this suite pins the words a reader sees on this node instead of restating
 * whatever the contract currently holds.
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
 * The vocabulary this view must never use about itself: it renders measured
 * spans, not a sampled profile.
 *
 * Deliberately broad stems rather than whole words: "CPU", "sample",
 * "sampled", "sampling", "profile", "profiler" and "profiling" all fail it, so
 * a label rewritten in good faith cannot quietly promote a nesting of measured
 * spans into a sampled call stack.
 */
const PROFILER_WORDING = /cpu|sampl|profil/i;

/**
 * How far two bars on one row may share an edge before they count as
 * overlapping, in user units: a millionth of one, far below any rendered
 * pixel, which only absorbs the rounding of two edges computed separately.
 */
const TOUCH_SLACK = 1e-6;

/** Why the correlator re-attached a record: its parent never arrived. */
const MISSING_PARENT: OrphanReason = 'missing-parent';

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
 * it was asked about, so the factory's own check passes — and it carries the
 * envelope of a trace: an own `traceId` and an array `roots`. Its `nodeCount`,
 * a field this view dereferences before drawing, is broken in one of two ways:
 *
 * - `"missing"`: absent. The host's response check requires the member, so it
 *   refuses the answer before the view sees it, and the view renders an
 *   ordinary failed query.
 * - `"mistyped"`: present but not a number. That passes the host's presence
 *   check, so only the component's own shape guard catches it — the guard that
 *   keeps it from throwing inside a render — and it words the refusal exactly
 *   as the host does.
 *
 * @param variant How the payload's `nodeCount` is broken.
 * @returns The stub provider.
 */
function wrongShapeProvider(variant: 'missing' | 'mistyped'): StubProvider {
  // Asserted through `unknown` because the case under test is precisely a
  // payload that breaks the `TraceTree` type: the compiler refuses it here, but
  // nothing refuses it in a provider that decoded it from a transport.
  const partialTree = (variant === 'missing'
    ? { traceId: TRACE_ID, roots: [] }
    : { traceId: TRACE_ID, roots: [], nodeCount: 'many' }) as unknown as TraceTree;

  return recordingProvider(() =>
    Promise.resolve<DataQueryResponse>({ source: 'trace', data: partialTree }),
  );
}

/**
 * A provider that answers a `trace` query with `null` — the service's own
 * answer when no trace in the capture matched the query.
 *
 * @returns The stub provider.
 */
function noTraceProvider(): StubProvider {
  return recordingProvider(() =>
    Promise.resolve<DataQueryResponse>({ source: 'trace', data: null }),
  );
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
  return render(hostedChart(node, context)).container;
}

/**
 * The component inside both host contexts, as an element — for the cases that
 * re-render the same mounted chart with a changed node.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 * @returns The element tree {@link renderComponent} mounts.
 */
function hostedChart(
  node: FlameNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): ReactElement {
  return (
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <FlameChart node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>
  );
}

/** The text equivalent: the tree that carries one row per drawn frame. */
function frameList(): HTMLElement {
  return screen.getByRole('tree');
}

/**
 * Its RENDERED rows, in document order.
 *
 * The tree renders one page of rows, the page holding its tab stop, so this
 * is every row only while the list is short enough to be one page — every
 * fixture below except the ones built to prove the tree is paged.
 */
function frameRows(): HTMLElement[] {
  return within(frameList()).getAllByRole('treeitem');
}

/** The rows of the tree that are in the Tab order: exactly one, when any row renders. */
function tabStops(): HTMLElement[] {
  return frameRows().filter((row) => row.getAttribute('tabindex') === '0');
}

/**
 * Every element inside the tree that the Tab key could land on.
 *
 * A composite widget is one stop, so this must be its single active row and
 * nothing else: no nested button, chip or name may carry a non-negative tab
 * index of its own.
 */
function tabbableInTree(): Element[] {
  return Array.from(
    frameList().querySelectorAll('button, a[href], input, select, textarea, [tabindex]'),
  ).filter((element) => element.getAttribute('tabindex') !== '-1');
}

/**
 * The row that holds focus, failing when focus is anywhere else.
 *
 * @returns The focused treeitem.
 */
function focusedRow(): HTMLElement {
  const active = document.activeElement;

  if (!(active instanceof HTMLElement) || active.getAttribute('role') !== 'treeitem') {
    throw new Error('focus is not on a row of the frame tree');
  }

  return active;
}

/**
 * The frame name a row shows, read off its name control.
 *
 * @param row A row of the text equivalent.
 * @returns The row's frame name.
 */
function nameOfRow(row: HTMLElement): string {
  return nameControlOf(row).textContent ?? '';
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

/** The canvas: the picture, a figure with a text alternative whose frames are named images. */
function canvas(): HTMLElement {
  return screen.getByRole('figure');
}

/**
 * The icicle's drawn rows, in document order — one group per row: a depth, or
 * one sub-row of a depth whose siblings overlap.
 */
function icicleRows(): SVGGElement[] {
  return Array.from(canvas().querySelectorAll<SVGGElement>('g.dg-flame__row'));
}

/**
 * The `y` coordinate of the first bar of each drawn row, in document order.
 *
 * The vertical rhythm itself is not asserted anywhere in this suite — it
 * belongs to `../utils/scale` — so these are read as opaque numbers and only
 * their order and distinctness are checked.
 *
 * @returns One coordinate per drawn row.
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

/** One drawn frame's name and its geometry, read off its `<rect>`. */
interface DrawnFrame {
  readonly name: string;
  readonly x: number;
  readonly width: number;
  readonly y: number;
}

/** A window frame's bar: a frame rect that is not part of the context band. */
const WINDOW_FRAME_SELECTOR = 'rect.dg-flame__frame:not([data-flame-context])';

/** A context bar: a frame rect drawn only to show where the window sits. */
const CONTEXT_FRAME_SELECTOR = 'rect.dg-flame__frame[data-flame-context]';

/**
 * The name and geometry one frame `<rect>` carries.
 *
 * The name is the first line of the bar's `<title>`, which is the frame's own
 * name; the numbers are read as opaque user units, as {@link depthOffsets}
 * reads them.
 *
 * @param rect A frame's `<rect>`.
 * @returns Its name and geometry.
 */
function drawnFrameOf(rect: Element): DrawnFrame {
  return {
    name: (rect.querySelector('title')?.textContent ?? '').split('\n')[0] ?? '',
    x: Number.parseFloat(rect.getAttribute('x') ?? ''),
    width: Number.parseFloat(rect.getAttribute('width') ?? ''),
    y: Number.parseFloat(rect.getAttribute('y') ?? ''),
  };
}

/**
 * Every frame of the drawn WINDOW, with the geometry its `<rect>` carries —
 * the bars of the context band excluded, since they are not the window's.
 *
 * @returns One entry per window frame, in document order.
 */
function drawnFrames(): DrawnFrame[] {
  return Array.from(canvas().querySelectorAll(WINDOW_FRAME_SELECTOR)).map(drawnFrameOf);
}

/**
 * The context band's bars, in document order: the operations a window that
 * opens below the root is nested inside, outermost first.
 *
 * @returns One entry per context bar.
 */
function contextBars(): DrawnFrame[] {
  return Array.from(canvas().querySelectorAll(CONTEXT_FRAME_SELECTOR)).map(drawnFrameOf);
}

/** The names of the context band's bars, outermost first. */
function contextBarNames(): string[] {
  return contextBars().map((bar) => bar.name);
}

/**
 * The context bar drawn for the operation named `name`.
 *
 * @param name The operation's recorded name.
 * @returns Its `<rect>`.
 */
function contextRect(name: string): SVGRectElement {
  const rect = Array.from(canvas().querySelectorAll<SVGRectElement>(CONTEXT_FRAME_SELECTOR)).find(
    (candidate) => drawnFrameOf(candidate).name === name,
  );

  if (rect === undefined) {
    throw new Error(`the canvas draws no context bar named "${name}"`);
  }

  return rect;
}

/**
 * The drawn frame named `name`.
 *
 * @param name The frame name to find.
 * @returns Its drawn geometry.
 */
function drawnFrameNamed(name: string): DrawnFrame {
  const frame = drawnFrames().find((candidate) => candidate.name === name);

  if (frame === undefined) {
    throw new Error(`the canvas draws no frame named "${name}"`);
  }

  return frame;
}

/**
 * Every pair of frames drawn on one row whose bars intersect horizontally.
 *
 * Bars that merely touch — one ending exactly where the next begins — do not
 * count; the slack is far below a rendered pixel and only absorbs the rounding
 * of two edges computed through the scale separately.
 *
 * @returns The overlapping pairs, by name; empty when no row paints over itself.
 */
function sameRowOverlaps(): string[] {
  const frames = drawnFrames();
  const overlaps: string[] = [];

  for (const [index, first] of frames.entries()) {
    for (const second of frames.slice(index + 1)) {
      if (first.y !== second.y) {
        continue;
      }
      const disjoint =
        first.x + first.width <= second.x + TOUCH_SLACK ||
        second.x + second.width <= first.x + TOUCH_SLACK;
      if (!disjoint) {
        overlaps.push(`${first.name} × ${second.name}`);
      }
    }
  }

  return overlaps;
}

/**
 * The index, among the drawn rows, of the row holding the frame named `name`.
 *
 * @param name The frame name to find.
 * @returns Its 0-based row index, top to bottom.
 */
function rowIndexOf(name: string): number {
  const index = icicleRows().findIndex((group) =>
    Array.from(group.querySelectorAll('rect.dg-flame__frame')).some(
      (rect) => (rect.querySelector('title')?.textContent ?? '').split('\n')[0] === name,
    ),
  );

  if (index < 0) {
    throw new Error(`no drawn row holds a frame named "${name}"`);
  }

  return index;
}

/** One "+N" mark the canvas draws over a crowded depth's gathered operations. */
interface DrawnOverflowMark {
  /** How many operations it gathers, read off the count its title opens with. */
  readonly count: number;
  /** Its native tooltip, whole. */
  readonly title: string;
  /** The "+N" count drawn inside it, when one is drawn. */
  readonly label: string | undefined;
  /** The index, among the drawn rows, of the row it sits on. */
  readonly row: number;
  /** The band's `x`, in user units. */
  readonly x: number;
  /** The band's `width`, in user units. */
  readonly width: number;
  /** The band's `y`, in user units. */
  readonly y: number;
}

/**
 * Every "+N" mark the canvas draws, in document order, with its count, title,
 * label, row and geometry.
 *
 * The count is read off the title's opening figure — the mark's label is drawn
 * only when it fits whole, while the title always carries the count — and the
 * label is the element right after the band, as a frame's is after its bar.
 *
 * @returns One entry per `rect.dg-flame__overflow`.
 */
function overflowMarks(): DrawnOverflowMark[] {
  const rows = icicleRows();

  return Array.from(canvas().querySelectorAll('rect.dg-flame__overflow')).map((rect) => {
    const title = rect.querySelector('title')?.textContent ?? '';
    const figure = /^([\d,]+) operations? /.exec(title)?.[1];
    if (figure === undefined) {
      throw new Error(`an overflow mark's title does not open with its count: "${title}"`);
    }
    const next = rect.nextElementSibling;
    const text = next?.matches('text.dg-flame__overflow-label') === true ? next : null;
    const group = rect.closest('g.dg-flame__row');

    return {
      count: Number(figure.replace(/,/g, '')),
      title,
      label: text === null ? undefined : (text.textContent ?? ''),
      row: rows.findIndex((candidate) => candidate === group),
      x: Number.parseFloat(rect.getAttribute('x') ?? ''),
      width: Number.parseFloat(rect.getAttribute('width') ?? ''),
      y: Number.parseFloat(rect.getAttribute('y') ?? ''),
    };
  });
}

/**
 * How many operations the canvas accounts for: every frame it draws as a bar,
 * and every operation a "+N" mark gathers. While no gathered frame is the
 * panel's selection — which is drawn as a bar over its mark as well — this is
 * exactly the number of operations the drawn window holds.
 */
function canvasOperationCount(): number {
  return drawnFrames().length + overflowMarks().reduce((sum, mark) => sum + mark.count, 0);
}

/** One drawn frame's bar geometry and label, as the canvas carries them. */
interface LabelledFrame {
  /** The bar's `x`, in user units. */
  readonly x: number;
  /** The bar's `width`, in user units. */
  readonly width: number;
  /** The label's `x`, in user units, when a label is drawn. */
  readonly labelX: number | undefined;
  /** The label's text, when a label is drawn. */
  readonly label: string | undefined;
}

/**
 * The bar drawn for the frame named `name`, and the label drawn inside it.
 *
 * Found through the bar's `<title>`, whose first line is the frame's full name,
 * so a truncated label cannot hide which frame it belongs to. Unlike
 * {@link drawnFrameNamed}, it also reads the label the frame carries.
 *
 * @param name The frame's recorded name.
 * @returns Its bar's geometry and its label, read as numbers and text.
 */
function drawnFrame(name: string): LabelledFrame {
  const bar = Array.from(canvas().querySelectorAll(WINDOW_FRAME_SELECTOR)).find(
    (rect) => rect.querySelector('title')?.textContent?.split('\n')[0] === name,
  );

  if (bar === undefined) {
    throw new Error(`the canvas drew no frame named "${name}"`);
  }

  // A bar and its label are siblings — the chart wraps no group around a
  // frame — so the label, when one is drawn, is the element right after it.
  const next = bar.nextElementSibling;
  const text = next?.matches('text.dg-flame__frame-label') === true ? next : null;

  return {
    x: Number.parseFloat(bar.getAttribute('x') ?? ''),
    width: Number.parseFloat(bar.getAttribute('width') ?? ''),
    labelX: text === null ? undefined : Number.parseFloat(text.getAttribute('x') ?? ''),
    label: text === null ? undefined : (text.textContent ?? ''),
  };
}

/**
 * The canvas's `viewBox`, parsed.
 *
 * @returns Its four numbers: min-x, min-y, width and height.
 */
function viewBoxOf(): readonly number[] {
  return (canvas().getAttribute('viewBox') ?? '').split(' ').map(Number);
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
 * this shape: parallel work inside one interaction is ordinary.
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
 * Siblings that overlap on one depth
 *
 * An icicle draws each depth on its own row, which is only legible while the
 * siblings on that row are disjoint. Two shapes break that, and both are
 * ordinary: a record the correlator re-attached to the root while it ran
 * inside another child's window, and a run of short siblings that only overlap
 * once each has been widened to the minimum visible width.
 *
 *   root      [ 0 …………………………………………………………………………… 120 ]
 *   request       [ 4 ……………………………………………………… 104 ]
 *   orphan                                   [ 90 … 95 ]   ← depth 1 as well
 * ---------------------------------------------------------------------------
 */

/** Depth 1, re-attached to the root: its parent never arrived, and it ran inside the request. */
const ORPHAN_EVENT = makeEvent({
  id: 'event-example-0021',
  spanId: spanIdFor(21),
  parentSpanId: spanIdFor(99),
  name: 'example.orphan',
  kind: 'db.query',
  tier: 'db',
  startTime: BASE_START_MS + 90,
  duration: 5,
  seq: 3,
  ingestSeq: 4,
});

/** The root with its request and, beside it on the same depth, the orphan. */
const ORPHAN_TREE = makeTree(
  [
    makeTraceNode(
      INTERACTION_EVENT,
      [
        makeTraceNode(REQUEST_EVENT, [], 1),
        { ...makeTraceNode(ORPHAN_EVENT, [], 1), orphaned: true, orphanReason: MISSING_PARENT },
      ],
      0,
    ),
  ],
  { orphanCount: 1 },
);

/** The window of the short-siblings root, in milliseconds. */
const SHORT_SIBLINGS_ROOT_MS = 1000;

/** How many back-to-back 1 ms siblings it holds. */
const SHORT_SIBLING_COUNT = 40;

/** One sibling of {@link shortSiblingsTree} that resolved to a place in the project. */
interface SourcedSibling {
  /** The sibling's 0-based index among the root's children. */
  readonly index: number;
  /** The location it resolved to. */
  readonly source: SourceLocation;
}

/**
 * A root holding `count` consecutive 1 ms operations.
 *
 * Measured, the siblings are disjoint — each starts where the one before it
 * ended. Drawn, each is a thousandth of the canvas and is widened to the
 * scale's minimum visible width, so neighbours overlap: exactly the shape that
 * painted frames over one another before rows were packed. At a few hundred
 * siblings it is also the long list the bounded-tree cases need, and at a few
 * thousand the trace the drawn-row budget pages through.
 *
 * @param count How many siblings. The root's window is
 * {@link SHORT_SIBLINGS_ROOT_MS}, widened to one millisecond per sibling when
 * there are more, so every child lies inside it.
 * @param sourced The one sibling that carries a resolved location, if any —
 * for the cases that open a source from a row past the tree's first page.
 * @returns The correlated trace.
 */
function shortSiblingsTree(
  count: number = SHORT_SIBLING_COUNT,
  sourced?: SourcedSibling,
): TraceTree {
  const root = makeEvent({
    id: 'event-example-0100',
    spanId: spanIdFor(100),
    name: 'example.batch',
    kind: 'route.handler',
    tier: 'server',
    startTime: BASE_START_MS,
    duration: Math.max(SHORT_SIBLINGS_ROOT_MS, count),
    seq: 0,
    ingestSeq: 1,
  });
  const children = Array.from({ length: count }, (_unused, index) =>
    makeTraceNode(
      makeEvent({
        id: `event-example-short-${String(index).padStart(3, '0')}`,
        spanId: spanIdFor(200 + index),
        parentSpanId: spanIdFor(100),
        name: `example.step.${String(index).padStart(3, '0')}`,
        kind: 'function',
        tier: 'server',
        startTime: BASE_START_MS + index,
        duration: 1,
        seq: index + 1,
        ingestSeq: index + 2,
        source: sourced !== undefined && sourced.index === index ? sourced.source : undefined,
      }),
      [],
      1,
    ),
  );

  return makeTree([makeTraceNode(root, children, 0)]);
}

/** A 100 ms root whose two children touch: the first ends as the second begins. */
const TOUCHING_TREE = makeTree([
  makeTraceNode(
    makeEvent({
      id: 'event-example-0031',
      spanId: spanIdFor(31),
      name: 'example.handler',
      kind: 'route.handler',
      tier: 'server',
      startTime: BASE_START_MS,
      duration: 100,
      seq: 0,
      ingestSeq: 1,
    }),
    [
      makeTraceNode(
        makeEvent({
          id: 'event-example-0032',
          spanId: spanIdFor(32),
          parentSpanId: spanIdFor(31),
          name: 'example.first',
          kind: 'function',
          tier: 'server',
          startTime: BASE_START_MS,
          duration: 50,
          seq: 1,
          ingestSeq: 2,
        }),
        [],
        1,
      ),
      makeTraceNode(
        makeEvent({
          id: 'event-example-0033',
          spanId: spanIdFor(33),
          parentSpanId: spanIdFor(31),
          name: 'example.second',
          kind: 'function',
          tier: 'server',
          startTime: BASE_START_MS + 50,
          duration: 50,
          seq: 2,
          ingestSeq: 3,
        }),
        [],
        1,
      ),
    ],
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

/*
 * ---------------------------------------------------------------------------
 * Traces larger than one drawing, for the drawn-row budget
 *
 * The budget is the component's own — `../utils/scale`'s `MAX_DRAWN_ROWS` —
 * restated so the counts below are stated numbers rather than whatever the
 * window currently does.
 * ---------------------------------------------------------------------------
 */

/** The most operations the chart draws at once, however often more is asked for. */
const DRAWN_ROW_BUDGET = 2000;

/**
 * Siblings under one root for the paging cases: with the root, two whole
 * windows and one operation more, so the last window holds a single frame.
 */
const PAGED_SIBLING_COUNT = 2 * DRAWN_ROW_BUDGET;

/** The control that moves the drawn window back. */
const PREVIOUS_NAME = 'Previous operations';

/** The control that moves the drawn window on. */
const NEXT_NAME = 'Next operations';

/** The badge every partial result carries. */
const PARTIAL_RESULT_BADGE = 'Partial result';

/** The chain's length in the depth-ended fixture: past the depth bound. */
const DEPTH_ENDED_CHAIN_LEVELS = 40;

/**
 * A trace whose operations within the depth bound number exactly one drawn
 * window while the trace itself holds more — the chain levels below the bound
 * — which is the case a paging control would misreport: no page holds them.
 *
 * One root holds a chain of {@link DEPTH_ENDED_CHAIN_LEVELS} levels and enough
 * 1 ms leaves that the operations the depth bound lets through — the root,
 * chain levels 1 … {@link ICICLE_DEPTH_BOUND}, and the leaves — number exactly
 * {@link DRAWN_ROW_BUDGET}.
 *
 * @returns The correlated trace.
 */
function depthEndedTree(): TraceTree {
  const reachableChainLevels = ICICLE_DEPTH_BOUND;
  const leafCount = DRAWN_ROW_BUDGET - 1 - reachableChainLevels;
  const windowMs = leafCount + DEEP_CHAIN_ROOT_DURATION_MS;
  const rootSpanId = spanIdFor(3000);

  // Built from the innermost level outward, each level at its own depth: the
  // chain hangs one level below the root, so `nest`'s zero-based depths would
  // not fit it.
  let chain: TraceNode | undefined;
  for (let level = DEPTH_ENDED_CHAIN_LEVELS - 1; level >= 1; level -= 1) {
    chain = makeTraceNode(
      makeEvent({
        id: `event-example-ended-chain-${String(level).padStart(4, '0')}`,
        spanId: spanIdFor(3000 + level),
        parentSpanId: level === 1 ? rootSpanId : spanIdFor(3000 + level - 1),
        name: `example.chain.${String(level).padStart(3, '0')}`,
        kind: 'function',
        tier: 'server',
        startTime: BASE_START_MS + leafCount + level,
        duration: DEEP_CHAIN_ROOT_DURATION_MS - 2 * level,
        seq: level,
        ingestSeq: level + 1,
      }),
      chain === undefined ? [] : [chain],
      level,
    );
  }
  if (chain === undefined) {
    throw new Error('the depth-ended chain needs at least one level');
  }

  const leaves = Array.from({ length: leafCount }, (_unused, index) =>
    makeTraceNode(
      makeEvent({
        id: `event-example-ended-leaf-${String(index).padStart(4, '0')}`,
        spanId: spanIdFor(4000 + index),
        parentSpanId: rootSpanId,
        name: `example.leaf.${String(index).padStart(4, '0')}`,
        kind: 'function',
        tier: 'server',
        startTime: BASE_START_MS + index,
        duration: 1,
        seq: DEPTH_ENDED_CHAIN_LEVELS + index,
        ingestSeq: DEPTH_ENDED_CHAIN_LEVELS + index + 1,
      }),
      [],
      1,
    ),
  );

  const root = makeEvent({
    id: 'event-example-ended-root',
    spanId: rootSpanId,
    name: 'example.batch',
    kind: 'route.handler',
    tier: 'server',
    startTime: BASE_START_MS,
    duration: windowMs,
    seq: 0,
    ingestSeq: 1,
  });

  return makeTree([makeTraceNode(root, [...leaves, chain], 0)]);
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
    // empty state — an unsettled query is not an answer.
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
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

    // Announced as the settled status, placed in the view's own empty box, and
    // carrying a short title and a decorative glyph like every other view's
    // empty capture.
    const state = screen.getByRole('status');
    expect(state.contains(message)).toBe(true);
    expect(state.parentElement?.classList.contains('dg-flame__empty')).toBe(true);
    expect(state.querySelector('.dg-empty-state__title')?.textContent).toBe('No trace');
    expect(state.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');

    // An empty trace is a success, so it is drawn as an absence and not as a
    // failure — and there is no picture to imply frames behind it.
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.parentElement?.classList.contains('dg-flame__error')).toBe(true);

    // What the reader is told: the shared lead, the cause the provider stated
    // and the failure's code — the same words any other node would use.
    expect(alert.textContent).toContain(VIEW_FAILURE_LEAD);
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, and compared as a value rather
    // than as a spelling, so a reader can tell which interaction went
    // unanswered.
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

    // No frames were invented behind the failure.
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('reports a node whose query names a source it cannot draw, and asks for nothing', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode({ query: { source: 'spans' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');

    // The node's own query is what the reader is shown, as a value, and no
    // retry is offered: re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'spans' });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();
    expect(alert.textContent).toContain('"trace"');
    expect(alert.textContent).toContain('"spans"');

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it.each(['missing', 'mistyped'] as const)(
    'reports a payload whose nodeCount is %s instead of crashing on it',
    async (variant) => {
      const stub = wrongShapeProvider(variant);
      const user = userEvent.setup();

      renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

      // The payload carries a trace's envelope but not the fields this view reads,
      // so it would otherwise be read as a tree and throw inside a render. It is
      // reported as the host's own response check reports a refused payload: the
      // view-failure title, the shared lead and a cause of its own, the code that
      // check uses, the query as a value, and a retry.
      const alert = await screen.findByRole('alert');
      expect(alert.parentElement?.classList.contains('dg-flame__error')).toBe(true);

      const parts = errorStateParts(alert);
      expect(parts.title).toBe(VIEW_FAILURE_TITLE);
      expect(parts.paragraphs[0]?.startsWith(`${VIEW_FAILURE_LEAD} `)).toBe(true);
      expect(parts.paragraphs[0]).toContain('"trace"');
      expect(parts.paragraphs[0]).toContain('cannot read');
      expect(parts.code).toBe('PROTOCOL_INVALID_MESSAGE');

      const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
      expect(JSON.parse(shown.textContent ?? '')).toEqual({
        source: 'trace',
        filter: { traceId: TRACE_ID },
      });

      // The shape the guard required is developer detail, kept behind the closed
      // disclosure rather than on the lines a reader meets first.
      const disclosure = alert.querySelector('details');
      expect(disclosure?.open).toBe(false);
      expect(disclosure?.textContent).toContain('nodeCount');
      expect(parts.paragraphs.join(' ')).not.toContain('nodeCount');

      expect(screen.queryByRole('tree')).toBeNull();
      expect(stub.resolve).toHaveBeenCalledTimes(1);

      // A provider that answered in the wrong form once may answer in the right
      // form next time, so the retry really asks again.
      await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));
      expect(stub.resolve).toHaveBeenCalledTimes(2);
      expect(queryOfCall(stub, 2)).toEqual(queryOfCall(stub, 1));
    },
  );

  it('draws a rejected query through the shared error-state contract', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.', {
        hint: 'Reconnect the panel and ask again.',
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A lone failure alerts: nothing else on screen failed with it.
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-error-state')).toBe(true);

    // Title, then the generic lead followed by the provider's own cause, then
    // the provider's hint on a line of its own, then the code chip.
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
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode({ query: { source: 'spans', limit: 20 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.parentElement?.classList.contains('dg-flame__error')).toBe(true);

    // The contract's title and code, and a message worded from the node
    // catalog: what this view reads next to what it was asked for.
    const parts = errorStateParts(alert);
    expect(parts.title).toBe(UNSUPPORTED_TITLE);
    expect(parts.paragraphs).toEqual([
      `The ${catalogEntryFor('flame').label} view reads "trace" data, but this panel asks it for "spans".`,
    ]);
    expect(parts.code).toBe('PANEL_INVALID');

    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'spans', limit: 20 });

    // A defect in the panel, not a failed request: nothing to retry.
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();
    expect(alert.querySelector(`[${RETRY_FOCUS_ATTRIBUTE}]`)).toBeNull();
    expect(stub.resolve).not.toHaveBeenCalled();
  });

  it('renders its own empty message, not an error, when no trace matched the query', async () => {
    const stub = noTraceProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `null` is the service's answer for a capture holding no matching trace:
    // an empty capture, drawn as the same absence an empty trace is.
    const message = await screen.findByText(/no trace was captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-flame__empty')).not.toBeNull();

    // Not the malformed-payload path: no alert, so no retry, and nothing drawn.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: RETRY_NAME })).toBeNull();
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('FlameChart hierarchy', () => {
  it('draws the root first and one depth row per level, downward', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

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

  it('packs a re-attached frame that overlaps its sibling onto a row of its own', async () => {
    const stub = resolvingProvider(ORPHAN_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // No row paints one frame over another: the orphan ran inside the
    // request's window, so the two cannot share a row.
    expect(sameRowOverlaps()).toEqual([]);

    // Depth 1 takes two rows — the request's and the orphan's, below it — and
    // both sit beneath the root, so the icicle still reads downward.
    const root = drawnFrameNamed(INTERACTION_EVENT.name);
    const request = drawnFrameNamed(REQUEST_EVENT.name);
    const orphan = drawnFrameNamed(ORPHAN_EVENT.name);
    expect(icicleRows()).toHaveLength(3);
    expect(root.y).toBeLessThan(request.y);
    expect(request.y).toBeLessThan(orphan.y);

    // The orphan is still marked as one on the canvas and in the list.
    const orphanBars = canvas().querySelectorAll('rect.dg-flame__frame.dg-is-orphan');
    expect(orphanBars).toHaveLength(1);
    expect(rowNamed(ORPHAN_EVENT.name).classList.contains('dg-is-orphan')).toBe(true);
    expect(rowNamed(ORPHAN_EVENT.name).getAttribute('aria-level')).toBe('2');
  });

  it('packs siblings widened to the minimum visible width instead of stacking them', async () => {
    const tree = shortSiblingsTree();
    const stub = resolvingProvider(tree);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // Every sibling is drawn, and none on top of another.
    expect(drawnFrames()).toHaveLength(tree.nodeCount);
    expect(sameRowOverlaps()).toEqual([]);

    // Their depth needed more than one row, and every one of those rows lies
    // below the root's.
    const root = drawnFrameNamed('example.batch');
    const siblingRows = new Set(
      drawnFrames()
        .filter((frame) => frame.name !== 'example.batch')
        .map((frame) => frame.y),
    );
    expect(siblingRows.size).toBeGreaterThan(1);
    for (const y of siblingRows) {
      expect(y).toBeGreaterThan(root.y);
    }
    expect(icicleRows()).toHaveLength(1 + siblingRows.size);
  });

  it('keeps siblings that only touch on one row', async () => {
    const stub = resolvingProvider(TOUCHING_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // One ends exactly as the other begins: they share an edge, not a span of
    // time, so the depth keeps a single row.
    expect(drawnFrameNamed('example.first').y).toBe(drawnFrameNamed('example.second').y);
    expect(sameRowOverlaps()).toEqual([]);
    expect(icicleRows()).toHaveLength(2);
  });

  it('aligns a leaf’s name with the foldable rows at its depth', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // A foldable row's disclosure control and a leaf's empty placeholder carry
    // the same class, so both reserve the same box before the name.
    for (const name of [INTERACTION_EVENT.name, REQUEST_EVENT.name]) {
      const toggle = within(rowNamed(name)).getByRole('button', { name: /^Collapse the / });
      expect(toggle.classList.contains('dg-flame__toggle')).toBe(true);
    }

    const leaf = rowNamed(HANDLER_EVENT.name);
    expect(within(leaf).queryByRole('button', { name: /^(Expand|Collapse) the / })).toBeNull();

    const placeholder = leaf.querySelector('.dg-flame__toggle');
    if (!(placeholder instanceof HTMLElement)) {
      throw new Error('a leaf row must hold the toggle placeholder');
    }
    expect(placeholder.tagName).toBe('SPAN');
    expect(placeholder.childElementCount).toBe(0);
    expect(placeholder.textContent).toBe('');
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    expect(placeholder.getAttribute('tabindex')).toBeNull();

    // It comes first in the row, where the control sits on a foldable row.
    expect(leaf.firstElementChild).toBe(placeholder);
  });

  it('carries every frame in a keyboard-reachable list beside the picture', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // One entry per node in the trace — the text equivalent is complete, not a
    // sample of it.
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
      // reference rather than a length.
      expect(row.getAttribute('aria-level')).toBe(String(index + 1));
      expect(row.getAttribute('style')).toContain(`--dgc-depth: ${String(index)}`);
    }

    // The keyboard reaches the tree without passing through the picture: the
    // canvas exposes no focusable bar, so the first Tab lands on the first row.
    await user.tab();
    const [firstRow] = frameRows();
    if (firstRow === undefined) {
      throw new Error('the text equivalent rendered no rows');
    }
    expect(document.activeElement).toBe(firstRow);

    // The picture is an image with a text alternative, and the list is named
    // separately: neither representation stands alone.
    const picture = canvas();
    expect(picture.getAttribute('aria-label')).toContain('operations');
    expect(picture.getAttribute('aria-hidden')).toBeNull();
    expect(frameList().getAttribute('aria-label')).toContain('operations');
  });

  it('inks every frame label with the ink paired with that frame’s own fill', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // A label is text on its frame's fill, so its colour is the fill's paired
    // ink (held to the 4.5:1 text contrast bar), not one colour for every
    // frame: on the light scale no single ink clears that bar on every fill.
    // The pairs themselves are measured by the token suite; this checks the
    // view wires each label to its own frame's pair.
    const kindByName = new Map(CHAIN_EVENTS.map((event) => [event.name, event.kind]));
    const labels = Array.from(canvas().querySelectorAll('text.dg-flame__frame-label'));
    expect(labels.length).toBeGreaterThan(0);

    for (const label of labels) {
      const frame = label.parentElement?.querySelector('rect.dg-flame__frame');
      const name = frame?.querySelector('title')?.textContent?.split('\n')[0] ?? '';
      const kind = kindByName.get(name);
      if (frame === null || frame === undefined || kind === undefined) {
        throw new Error(`the label "${label.textContent ?? ''}" sits beside no known frame`);
      }

      expect(frame.getAttribute('style')).toContain(kindColorVar(kind));
      expect(label.getAttribute('style')).toContain(`--dgc-frame-ink: ${kindInkColorVar(kind)}`);
    }

    // The case the pairing exists for: the fetch fill takes its own ink token.
    const fetchLabel = labels.find(
      (label) =>
        label.parentElement?.querySelector('title')?.textContent?.split('\n')[0] ===
        REQUEST_EVENT.name,
    );
    expect(fetchLabel?.getAttribute('style')).toContain('var(--dg-kind-fetch-ink)');
  });

  it('never describes itself as a profile, a sample or CPU time', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    const container = renderComponent(makeNode({ title: 'Nested timing' }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('tree');

    // The on-screen statement of what a bar actually is.
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
    await screen.findByRole('tree');

    const firstNames = frameNames();
    const firstTitles = barTitles();

    cleanup();

    const second = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: second.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

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

    await screen.findByRole('tree');

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

    await screen.findByRole('tree');

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
    // this one acts on the object it is handed.
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

    await screen.findByRole('tree');

    const row = rowNamed(INTERACTION_EVENT.name);

    expect(within(row).queryByRole('button', { name: /^Open / })).toBeNull();
    expect(row.textContent).not.toContain(SOURCE_FILE);

    // Exactly one frame in this trace resolved, so exactly one chip exists.
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(1);
  });
});

/** How many 1 ms siblings the bounded-tree cases list under their root. */
const LONG_SIBLING_COUNT = 499;

/**
 * The most rows the tree may put in the document at once.
 *
 * Deliberately looser than the component's own page: the contract of the
 * cases that use it is that the list is BOUNDED, not what the bound is, and a
 * case pinned to the exact page would fail on a tuning change that broke
 * nothing.
 */
const RENDERED_ROW_CEILING = 100;

/**
 * How many rows one page of the tree holds: the component's text-row budget.
 *
 * Pinned exactly, unlike {@link RENDERED_ROW_CEILING}, by the cases that turn
 * pages: the page's own statement names its rows — "Rows 61–120 of …" — and
 * those numbers are what a reader hears.
 */
const TEXT_ROW_BUDGET = 60;

/** The row control that turns the tree to the page before its own. */
const PREVIOUS_ROWS_NAME = 'Previous rows';

/** The row control that turns the tree to the page after its own. */
const NEXT_ROWS_NAME = 'Next rows';

/**
 * The tree's page statement, as the chart words it: which rows of the list
 * the page shows, of how many.
 *
 * Spelled out here rather than read back from the component, so a case pins
 * the words a reader hears.
 *
 * @param start The page's first row, 0-based among the tree's rows.
 * @param count How many rows the page shows.
 * @param total How many rows the tree lists in all.
 * @returns The sentence.
 */
function rowPageStatement(start: number, count: number, total: number): string {
  return count === 1
    ? `Row ${formatCount(start + 1)} of ${formatCount(total)} in this list is shown.`
    : `Rows ${formatCount(start + 1)}–${formatCount(start + count)} of ${formatCount(
        total,
      )} in this list are shown.`;
}

/**
 * The first row of the last page of a tree of `total` rows: pages are aligned
 * at multiples of {@link TEXT_ROW_BUDGET}.
 */
function lastPageStart(total: number): number {
  return Math.floor((total - 1) / TEXT_ROW_BUDGET) * TEXT_ROW_BUDGET;
}

/** A resolved location carried by one sibling past the tree's first page. */
const LATER_SOURCE: SourceLocation = {
  file: 'src/example/steps.ts',
  line: 212,
  column: 5,
  symbol: 'runLaterStep',
  resolvedBy: 'code-graph',
  confidence: 0.8,
};

/** The accessible name of {@link LATER_SOURCE}'s chip (`SourceLink`'s own shape). */
const LATER_CHIP_NAME = `Open ${LATER_SOURCE.file}:${String(LATER_SOURCE.line)}:${String(
  LATER_SOURCE.column,
)}`;

describe('FlameChart keyboard', () => {
  it('is one tab stop, however many rows and controls it holds', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // One row is in the Tab order — the first, since nothing is selected — and
    // nothing else inside the tree is: the disclosure controls, the names and
    // the source chip are all out of it.
    const [firstRow] = frameRows();
    if (firstRow === undefined) {
      throw new Error('the text equivalent rendered no rows');
    }
    expect(tabStops()).toEqual([firstRow]);
    expect(tabbableInTree()).toEqual([firstRow]);
    for (const row of frameRows()) {
      expect(nameControlOf(row).getAttribute('tabindex')).toBe('-1');
    }
    expect(screen.getByRole('button', { name: SOURCE_CHIP_NAME }).getAttribute('tabindex')).toBe(
      '-1',
    );

    // Tab enters on that row, and the next Tab leaves the tree altogether.
    await user.tab();
    expect(document.activeElement).toBe(firstRow);
    await user.tab();
    expect(frameList().contains(document.activeElement)).toBe(false);

    // Shift+Tab comes back to the row that was left.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(firstRow);
  });

  it('starts the tab stop on the selected frame, and moves it with focus', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // Selecting a frame with the pointer makes its row the stop.
    await user.click(nameControlOf(rowNamed(HANDLER_EVENT.name)));
    expect(tabStops().map(nameOfRow)).toEqual([HANDLER_EVENT.name]);

    // The arrow keys move it, and it is never on two rows at once.
    await user.keyboard('{ArrowUp}');
    expect(nameOfRow(focusedRow())).toBe(REQUEST_EVENT.name);
    expect(tabStops()).toEqual([focusedRow()]);
  });

  it('moves between rows with the arrow keys, Home and End', async () => {
    const stub = resolvingProvider(ORPHAN_TREE);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');
    await user.tab();

    const visited = [nameOfRow(focusedRow())];
    for (const key of [
      '{ArrowDown}',
      '{ArrowDown}',
      '{ArrowDown}',
      '{ArrowUp}',
      '{Home}',
      '{End}',
    ]) {
      await user.keyboard(key);
      visited.push(nameOfRow(focusedRow()));
      expect(tabStops()).toEqual([focusedRow()]);
    }

    // Down, down, down at the last row stays put, up, then the two ends.
    expect(visited).toEqual([
      INTERACTION_EVENT.name,
      REQUEST_EVENT.name,
      ORPHAN_EVENT.name,
      ORPHAN_EVENT.name,
      REQUEST_EVENT.name,
      INTERACTION_EVENT.name,
      ORPHAN_EVENT.name,
    ]);
  });

  it('folds, opens and steps through the hierarchy with ArrowLeft and ArrowRight', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree');
    await user.tab();

    const root = focusedRow();
    expect(root.getAttribute('aria-expanded')).toBe('true');

    // ArrowLeft on an open row folds it, keeps focus on it, and reports the
    // state after the gesture.
    await user.keyboard('{ArrowLeft}');
    expect(frameNames()).toEqual([INTERACTION_EVENT.name]);
    expect(focusedRow().getAttribute('aria-expanded')).toBe('false');
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, INTERACTION_EVENT.spanId, false);

    // ArrowRight on a folded row opens it, and on an open row steps inside.
    await user.keyboard('{ArrowRight}');
    expect(frameNames()).toEqual([...CHAIN_NAMES]);
    expect(nameOfRow(focusedRow())).toBe(INTERACTION_EVENT.name);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, INTERACTION_EVENT.spanId, true);

    await user.keyboard('{ArrowRight}');
    expect(nameOfRow(focusedRow())).toBe(REQUEST_EVENT.name);
    await user.keyboard('{ArrowRight}');
    expect(nameOfRow(focusedRow())).toBe(HANDLER_EVENT.name);

    // A leaf has nothing to open or step into; ArrowLeft steps out to its parent.
    await user.keyboard('{ArrowRight}');
    expect(nameOfRow(focusedRow())).toBe(HANDLER_EVENT.name);
    expect(focusedRow().getAttribute('aria-expanded')).toBeNull();
    await user.keyboard('{ArrowLeft}');
    expect(nameOfRow(focusedRow())).toBe(REQUEST_EVENT.name);

    // Fold the parent, then step out to the root.
    await user.keyboard('{ArrowLeft}');
    expect(frameNames()).toEqual([INTERACTION_EVENT.name, REQUEST_EVENT.name]);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, REQUEST_EVENT.spanId, false);
    await user.keyboard('{ArrowLeft}');
    expect(nameOfRow(focusedRow())).toBe(INTERACTION_EVENT.name);

    // Three disclosures, each reported once; moving between rows reports none.
    expect(spies.onExpand).toHaveBeenCalledTimes(3);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('selects with Enter and Space, and opens the source with Shift+Enter', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree');
    await user.tab();

    // Enter selects the focused frame, naming it as the event it stands for.
    await user.keyboard('{Enter}');
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: INTERACTION_EVENT.id,
      spanId: INTERACTION_EVENT.spanId,
      traceId: INTERACTION_EVENT.traceId,
    });
    expect(focusedRow().getAttribute('aria-selected')).toBe('true');

    // Shift+Enter on a row with no resolved location does nothing at all.
    expect(focusedRow().getAttribute('aria-keyshortcuts')).toBeNull();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    // Space selects too.
    await user.keyboard('{End}');
    await user.keyboard('[Space]');
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(2);
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: HANDLER_EVENT.id,
      spanId: HANDLER_EVENT.spanId,
      traceId: HANDLER_EVENT.traceId,
    });
    expect(rowNamed(INTERACTION_EVENT.name).getAttribute('aria-selected')).toBe('false');
    expect(focusedRow().getAttribute('aria-selected')).toBe('true');

    // The row that resolved to a location advertises the chord, and the chord
    // hands the host that very location — and selects nothing.
    const expectedKeys = Object.keys({ ...BASE_SOURCE }).sort();
    expect(focusedRow().getAttribute('aria-keyshortcuts')).toBe('Shift+Enter');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    const [call] = spies.onOpenSource.mock.calls;
    if (call === undefined) {
      throw new Error('the open-source handler recorded no call');
    }
    expect(call[0]).toEqual(BASE_SOURCE);
    expect(Object.keys(call[0]).sort()).toEqual(expectedKeys);
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(2);
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('names each row with its whole detail and reveals that detail on keyboard focus', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // The row's name carries what only its tooltip shows on screen: the
    // measured duration, the ancestry and the nested-call count.
    const request = rowNamed(REQUEST_EVENT.name);
    const label = request.getAttribute('aria-label') ?? '';
    expect(label).toContain(REQUEST_EVENT.name);
    expect(label).toContain(`duration ${formatDuration(REQUEST_EVENT.duration)}`);
    expect(label).toContain(`inside ${INTERACTION_EVENT.name}`);
    expect(label).toContain('1 nested call');

    // Nothing is revealed until a row takes keyboard focus…
    expect(frameList().querySelector('.dg-tooltip__bubble.dg-is-open')).toBeNull();

    await user.tab();
    await user.keyboard('{ArrowDown}');

    // …and then the focused row's detail is shown, hidden from assistive
    // technology because the row's name already says it.
    const revealed = within(focusedRow()).getByRole('tooltip', { hidden: true });
    expect(revealed.classList.contains('dg-is-open')).toBe(true);
    expect(revealed.getAttribute('aria-hidden')).toBe('true');
    // Placed by the primitive's own measurement, as a hovered bubble is: an open
    // bubble is fixed to the viewport, and one nothing placed paints at its corner.
    expect(revealed.style.getPropertyValue('--dgc-tooltip-block')).not.toBe('');
    expect(revealed.style.getPropertyValue('--dgc-tooltip-inline')).not.toBe('');
    expect(revealed.textContent).toContain(`inside ${INTERACTION_EVENT.name}`);

    // Escape dismisses it without moving focus.
    await user.keyboard('{Escape}');
    expect(frameList().querySelector('.dg-tooltip__bubble.dg-is-open')).toBeNull();
    expect(nameOfRow(focusedRow())).toBe(REQUEST_EVENT.name);
  });
});

/**
 * The time a case that pages through a long tree or draws full windows is
 * allowed, in milliseconds.
 *
 * Each full window is two thousand frames with their labels and titles, which
 * the test DOM builds in about a second, and the bounded tree's paging cases
 * turn every page of a long tree; a case that pages through several windows or
 * pages exceeds the runner's five-second default on a shared, loaded machine
 * without anything being wrong. Generous, not unbounded: a window or page that
 * never settles still fails the case.
 */
const WINDOW_CASE_TIMEOUT_MS = 30_000;

/*
 * Its paging cases turn every page of a long tree, so the group runs under
 * {@link WINDOW_CASE_TIMEOUT_MS} rather than the default.
 */
describe('FlameChart bounded tree', { timeout: WINDOW_CASE_TIMEOUT_MS }, () => {
  it('renders one page of a long tree while every row states its place', async () => {
    const tree = shortSiblingsTree(LONG_SIBLING_COUNT);
    const stub = resolvingProvider(tree);
    const user = userEvent.setup();
    const rowTotal = tree.nodeCount;
    const lastStart = lastPageStart(rowTotal);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // Every frame is drawn on the canvas, but only one page of rows is in the
    // document, and the statement beside the row controls says which. The
    // page is a count, not a measurement: nothing is laid out here, and the
    // same rows render in a browser.
    expect(rowTotal).toBe(LONG_SIBLING_COUNT + 1);
    expect(drawnFrames()).toHaveLength(rowTotal);
    const rendered = frameRows();
    expect(rendered).toHaveLength(TEXT_ROW_BUDGET);
    const statement = screen.getByText(rowPageStatement(0, TEXT_ROW_BUDGET, rowTotal));

    // The rows sit in normal flow, owned by the tree directly: no positioning
    // wrapper, and no scroll height advertised from an estimate of row sizes.
    expect(rendered.every((row) => row.parentElement === frameList())).toBe(true);
    expect(frameList().querySelector('.dg-virtual-row')).toBeNull();
    expect(frameList().style.getPropertyValue('--dgc-virtual-total')).toBe('');

    // Each rendered row still states its level and its position among ALL of
    // its siblings, not among the rendered ones.
    const [root, firstChild] = rendered;
    if (root === undefined || firstChild === undefined) {
      throw new Error('the window rendered fewer than two rows');
    }
    expect(root.getAttribute('aria-level')).toBe('1');
    expect(root.getAttribute('aria-setsize')).toBe('1');
    expect(root.getAttribute('aria-posinset')).toBe('1');
    expect(firstChild.getAttribute('aria-level')).toBe('2');
    expect(firstChild.getAttribute('aria-setsize')).toBe(String(LONG_SIBLING_COUNT));
    expect(firstChild.getAttribute('aria-posinset')).toBe('1');

    // End reaches the last row, on the last page, which the tree turns to,
    // and it is focused.
    await user.tab();
    await user.keyboard('{End}');
    const last = focusedRow();
    expect(nameOfRow(last)).toBe(`example.step.${String(LONG_SIBLING_COUNT - 1).padStart(3, '0')}`);
    expect(last.getAttribute('aria-posinset')).toBe(String(LONG_SIBLING_COUNT));
    expect(last.getAttribute('aria-setsize')).toBe(String(LONG_SIBLING_COUNT));
    expect(statement.textContent).toBe(rowPageStatement(lastStart, rowTotal - lastStart, rowTotal));
    expect(frameRows()).toHaveLength(rowTotal - lastStart);
    expect(tabStops()).toEqual([last]);

    // ArrowUp from there stays on that page, and Home goes back to the first.
    await user.keyboard('{ArrowUp}');
    expect(focusedRow().getAttribute('aria-posinset')).toBe(String(LONG_SIBLING_COUNT - 1));
    expect(statement.textContent).toBe(rowPageStatement(lastStart, rowTotal - lastStart, rowTotal));
    await user.keyboard('{Home}');
    expect(nameOfRow(focusedRow())).toBe('example.batch');
    expect(statement.textContent).toBe(rowPageStatement(0, TEXT_ROW_BUDGET, rowTotal));
    expect(frameRows()).toHaveLength(TEXT_ROW_BUDGET);
  });

  it('names what a later page of rows is nested inside, above the tree and outside it', async () => {
    const tree = nestedSiblingsTree(LONG_SIBLING_COUNT);
    const user = userEvent.setup();
    const rowTotal = tree.nodeCount;

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');

    // The first page opens at the root: nothing to give context for. One
    // drawn window holds the whole trace, so the canvas has no band either.
    expect(contextList()).toBeNull();
    expect(contextBarNames()).toEqual([]);

    // The second page opens among the siblings, whose root and group are
    // rows of the first page: they are named above the tree, outermost first,
    // indented by their own depth, and marked as context by their caption.
    await user.click(pagingControl(NEXT_ROWS_NAME));
    expect(
      screen.getByText(rowPageStatement(TEXT_ROW_BUDGET, TEXT_ROW_BUDGET, rowTotal)),
    ).toBeDefined();
    const list = contextList();
    if (list === null) {
      throw new Error('the second page of rows carries no context list');
    }
    expect(contextRowNames(list)).toEqual(['example.batch', NESTED_GROUP_NAME]);
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.style.getPropertyValue('--dgc-depth'))).toEqual(['0', '1']);
    expect(screen.getByText(TREE_CONTEXT_CAPTION)).toBeDefined();

    // None of it is a row of the page: the tree still holds exactly the
    // page's rows, the first of them the first sibling past the first page,
    // and the tree is still one tab stop — the context holds none.
    expect(frameList().contains(list)).toBe(false);
    expect(frameRows()).toHaveLength(TEXT_ROW_BUDGET);
    const [pageFirst] = frameRows();
    expect(pageFirst?.getAttribute('aria-level')).toBe('3');
    expect(nameOfRow(pageFirst ?? frameList())).toBe(pagedSiblingName(TEXT_ROW_BUDGET - 2));
    expect(tabStops()).toHaveLength(1);
    expect(list.querySelectorAll('button, a[href], input, [tabindex]')).toHaveLength(0);

    // Back on the first page, the context is gone again.
    await user.click(pagingControl(PREVIOUS_ROWS_NAME));
    expect(contextList()).toBeNull();
  });

  it('turns to a later page by pointer, where a row’s source chip opens its own location', async () => {
    // The sibling past the first page that resolved to a location: its row is
    // row 72 of the tree (the root is the first), on the second page.
    const sourcedIndex = TEXT_ROW_BUDGET + 10;
    const tree = shortSiblingsTree(LONG_SIBLING_COUNT, {
      index: sourcedIndex,
      source: LATER_SOURCE,
    });
    const spies = makeActions();
    const user = userEvent.setup();
    const rowTotal = tree.nodeCount;
    const target = pagedSiblingName(sourcedIndex);

    // Taken BEFORE the render, as in the first-page source case: a component
    // that added a field to the fixture in place must not pass.
    const expectedKeys = Object.keys({ ...LATER_SOURCE }).sort();

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: spies.actions,
    });
    await screen.findByRole('tree');

    // On the first page the row is not mounted, and neither is its chip.
    expect(frameRows()).toHaveLength(TEXT_ROW_BUDGET);
    expect(frameNames()).not.toContain(target);
    expect(screen.queryByRole('button', { name: LATER_CHIP_NAME })).toBeNull();

    // One click on the row control turns to the next page, which mounts it,
    // and asks the browser — once, by the least distance — to bring that
    // page's first row into the tree's viewport, so the page opens at its
    // top. The spy records the request; nothing is laid out or measured.
    const reveal = spyOnReveal();
    await user.click(pagingControl(NEXT_ROWS_NAME));
    expect(
      screen.getByText(rowPageStatement(TEXT_ROW_BUDGET, TEXT_ROW_BUDGET, rowTotal)),
    ).toBeDefined();
    const [pageFirst] = frameRows();
    if (pageFirst === undefined) {
      throw new Error('the second page rendered no rows');
    }
    expect(nameOfRow(pageFirst)).toBe(pagedSiblingName(TEXT_ROW_BUDGET - 1));
    expect(revealedElements(reveal)).toEqual([pageFirst]);
    expect(reveal).toHaveBeenLastCalledWith(ROW_REVEAL_OPTIONS);
    const row = rowNamed(target);
    const treeIndex = TEXT_ROW_BUDGET + frameRows().indexOf(row);
    expect(treeIndex).toBe(sourcedIndex + 1);
    expect(treeIndex).toBeGreaterThan(TEXT_ROW_BUDGET);
    expect(row.getAttribute('aria-posinset')).toBe(String(sourcedIndex + 1));

    // Its chip hands the host that very location, once, and selects nothing.
    await user.click(within(row).getByRole('button', { name: LATER_CHIP_NAME }));
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    const [call] = spies.onOpenSource.mock.calls;
    if (call === undefined) {
      throw new Error('the open-source handler recorded no call');
    }
    expect(call[0]).toEqual(LATER_SOURCE);
    expect(Object.keys(call[0]).sort()).toEqual(expectedKeys);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();

    // Turning the page drew nothing new and dropped nothing: the canvas still
    // draws every frame.
    expect(drawnFrames()).toHaveLength(rowTotal);
  });

  it('states which rows are shown, and spends each row control at its end', async () => {
    const tree = shortSiblingsTree(LONG_SIBLING_COUNT);
    const spies = makeActions();
    const user = userEvent.setup();
    const rowTotal = tree.nodeCount;
    const lastStart = lastPageStart(rowTotal);

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: spies.actions,
    });
    await screen.findByRole('tree');

    // The first page: stated politely, so every page is announced, with only
    // the control that can turn it enabled.
    const statement = screen.getByText(rowPageStatement(0, TEXT_ROW_BUDGET, rowTotal));
    expect(statement.getAttribute('aria-live')).toBe('polite');
    expect(pagingControl(PREVIOUS_ROWS_NAME).disabled).toBe(true);
    expect(pagingControl(NEXT_ROWS_NAME).disabled).toBe(false);

    // Every page in turn, to the last: the same statement element says which
    // rows it shows, exactly those rows are mounted, and the one tab stop
    // moved to the page's first row — a row that is in the document.
    for (let start = TEXT_ROW_BUDGET; start < rowTotal; start += TEXT_ROW_BUDGET) {
      await user.click(pagingControl(NEXT_ROWS_NAME));
      const count = Math.min(TEXT_ROW_BUDGET, rowTotal - start);
      expect(statement.isConnected).toBe(true);
      expect(statement.textContent).toBe(rowPageStatement(start, count, rowTotal));
      expect(frameRows()).toHaveLength(count);
      expect(tabStops().map(nameOfRow)).toEqual([pagedSiblingName(start - 1)]);
      expect(pagingControl(PREVIOUS_ROWS_NAME).disabled).toBe(false);
    }

    // The last page spends its control, and the focus it held moves to the
    // other control rather than to the document.
    expect(statement.textContent).toBe(rowPageStatement(lastStart, rowTotal - lastStart, rowTotal));
    expect(pagingControl(NEXT_ROWS_NAME).disabled).toBe(true);
    expect(document.activeElement).toBe(pagingControl(PREVIOUS_ROWS_NAME));

    // And back to the first page, where the other control is spent in turn.
    for (let start = lastStart - TEXT_ROW_BUDGET; start >= 0; start -= TEXT_ROW_BUDGET) {
      await user.click(pagingControl(PREVIOUS_ROWS_NAME));
      expect(statement.textContent).toBe(rowPageStatement(start, TEXT_ROW_BUDGET, rowTotal));
    }
    expect(pagingControl(PREVIOUS_ROWS_NAME).disabled).toBe(true);
    expect(document.activeElement).toBe(pagingControl(NEXT_ROWS_NAME));
    expect(tabStops().map(nameOfRow)).toEqual(['example.batch']);

    // The keyboard turns it too: Enter on the focused control, which keeps
    // its focus, and Shift+Tab back past the other control enters the tree on
    // the new page's first row.
    await user.keyboard('{Enter}');
    expect(statement.textContent).toBe(
      rowPageStatement(TEXT_ROW_BUDGET, TEXT_ROW_BUDGET, rowTotal),
    );
    expect(document.activeElement).toBe(pagingControl(NEXT_ROWS_NAME));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(pagingControl(PREVIOUS_ROWS_NAME));
    await user.tab({ shift: true });
    expect(nameOfRow(focusedRow())).toBe(pagedSiblingName(TEXT_ROW_BUDGET - 1));
    expect(tabStops()).toEqual([focusedRow()]);

    // Turning pages is neither a selection nor a disclosure.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('turns the page when a key steps past either edge of it, keeping one tab stop', async () => {
    const tree = shortSiblingsTree(LONG_SIBLING_COUNT);
    const user = userEvent.setup();
    const rowTotal = tree.nodeCount;
    const lastStart = lastPageStart(rowTotal);

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');
    const statement = screen.getByText(rowPageStatement(0, TEXT_ROW_BUDGET, rowTotal));

    // Down to the last row of the first page: still the first page.
    await user.tab();
    expect(nameOfRow(focusedRow())).toBe('example.batch');
    await user.keyboard(`{ArrowDown>${String(TEXT_ROW_BUDGET - 1)}/}`);
    expect(nameOfRow(focusedRow())).toBe(pagedSiblingName(TEXT_ROW_BUDGET - 2));
    expect(statement.textContent).toBe(rowPageStatement(0, TEXT_ROW_BUDGET, rowTotal));

    // One more step leaves the page: the next page is mounted in its place,
    // and its first row holds focus and the one tab stop.
    await user.keyboard('{ArrowDown}');
    const first = focusedRow();
    expect(nameOfRow(first)).toBe(pagedSiblingName(TEXT_ROW_BUDGET - 1));
    expect(statement.textContent).toBe(
      rowPageStatement(TEXT_ROW_BUDGET, TEXT_ROW_BUDGET, rowTotal),
    );
    expect(frameRows()).toHaveLength(TEXT_ROW_BUDGET);
    expect(frameRows()[0]).toBe(first);
    expect(frameNames()).not.toContain('example.batch');
    expect(tabStops()).toEqual([first]);
    expect(tabbableInTree()).toEqual([first]);

    // ArrowUp steps back across the edge, onto the last row of the first page.
    await user.keyboard('{ArrowUp}');
    expect(nameOfRow(focusedRow())).toBe(pagedSiblingName(TEXT_ROW_BUDGET - 2));
    expect(statement.textContent).toBe(rowPageStatement(0, TEXT_ROW_BUDGET, rowTotal));
    expect(tabStops()).toEqual([focusedRow()]);

    // End and Home turn to the last and the first page.
    await user.keyboard('{End}');
    expect(statement.textContent).toBe(rowPageStatement(lastStart, rowTotal - lastStart, rowTotal));
    expect(tabStops()).toEqual([focusedRow()]);
    await user.keyboard('{Home}');
    expect(statement.textContent).toBe(rowPageStatement(0, TEXT_ROW_BUDGET, rowTotal));
    expect(tabStops()).toEqual([focusedRow()]);
  });
});

describe('FlameChart honesty', () => {
  it('says so when the correlator itself truncated the trace', async () => {
    const stub = resolvingProvider(makeTree([nest(CHAIN_EVENTS)], { truncated: true }));

    const container = renderComponent(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('tree');

    // The honesty note still comes first, because it frames everything under
    // it; the truncation is a partial result rather than a note.
    const notes = Array.from(container.querySelectorAll('.dg-flame__note')).map(
      (note) => note.textContent ?? '',
    );
    expect(notes[0]).toMatch(/recorded operation/i);
    expect(notes.some((note) => /arrived incomplete/i.test(note))).toBe(false);

    // The notice carries the badge, says what happened and gives the refine
    // route — and offers no control, because nothing more is in memory.
    const badge = screen.getByText(PARTIAL_RESULT_BADGE);
    const notice = screen.getByText(/arrived incomplete/i);
    expect(notice.textContent).toMatch(/narrow the query or capture a shorter interaction/i);
    expect(badge.parentElement).toBe(notice.parentElement);
    expect(screen.queryByRole('button', { name: PREVIOUS_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: NEXT_NAME })).toBeNull();

    // The picture says so too, and the notice precedes it.
    expect(canvas().getAttribute('aria-label')).toMatch(/arrived incomplete/i);
    expect(notice.compareDocumentPosition(canvas()) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

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

    await screen.findByRole('tree');

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

    // Neither reduction is a partial result, and no page holds what either
    // leaves out, so there is no badge and no control to offer.
    expect(screen.queryByText(PARTIAL_RESULT_BADGE)).toBeNull();
    expect(screen.queryByRole('button', { name: NEXT_NAME })).toBeNull();

    // The picture and the list agree about what is on screen.
    expect(canvas().querySelectorAll('rect.dg-flame__frame')).toHaveLength(rows.length);
  });

  it('opens a folded subtree on request and reports the disclosure', async () => {
    const stub = resolvingProvider(deepChain(CLAMPED_CHAIN_LEVELS));
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree');

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
    await screen.findByRole('tree');

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

/*
 * ---------------------------------------------------------------------------
 * The shared selection
 *
 * Under a panel host the selected frame is the host's, not this chart's: the
 * frame and its list row mark whatever the host's selection context carries,
 * matched by event id or by the same trace and span, and an activation is
 * reported for the host to record rather than kept here.
 * ---------------------------------------------------------------------------
 */

/**
 * The component inside the host contexts, the selection context included:
 * {@link hostedChart}'s tree for the chain's node, under the host's shared
 * selection.
 *
 * @param selection The selection the host provides.
 * @param context The provider to resolve the query and the actions to report to.
 * @returns The element tree to render.
 */
function selectionHostedChart(
  selection: PanelSelectionState,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): ReactElement {
  return (
    <PanelSelectionContext.Provider value={selection}>
      {hostedChart(makeNode(), context)}
    </PanelSelectionContext.Provider>
  );
}

/** The first line of the SVG title of every frame carrying the selected state. */
function selectedFrameNames(): string[] {
  return Array.from(canvas().querySelectorAll('rect.dg-flame__frame.dg-is-selected')).map(
    (frame) => (frame.querySelector('title')?.textContent ?? '').split('\n')[0] ?? '',
  );
}

/** The names of the list rows carrying the selected state and `aria-current`. */
function currentRowNames(): string[] {
  return frameRows()
    .filter(
      (row) =>
        row.classList.contains('dg-is-selected') && row.getAttribute('aria-current') === 'true',
    )
    .map((row) => nameControlOf(row).textContent ?? '');
}

describe('FlameChart shared selection', () => {
  it('marks the frame the panel selection names, by event id or by trace and span, and keeps none of its own', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const spies = makeActions();
    const user = userEvent.setup();
    const context = { provider: stub.provider, actions: spies.actions };

    const { rerender } = render(
      selectionHostedChart({ selection: { eventId: HANDLER_EVENT.id } }, context),
    );
    await screen.findByRole('tree');

    // The provided selection is what the frame and its row show, and only it.
    expect(currentRowNames()).toEqual([HANDLER_EVENT.name]);
    expect(selectedFrameNames()).toEqual([HANDLER_EVENT.name]);

    // Another record's id naming this trace and this span still lands on it.
    rerender(
      selectionHostedChart(
        {
          selection: {
            eventId: 'event-example-elsewhere',
            traceId: TRACE_ID,
            spanId: REQUEST_EVENT.spanId,
          },
        },
        context,
      ),
    );

    expect(currentRowNames()).toEqual([REQUEST_EVENT.name]);
    expect(selectedFrameNames()).toEqual([REQUEST_EVENT.name]);

    // Activating a frame reports it and leaves the marking to the host: a host
    // that has not recorded the report still shows its own selection.
    await user.click(nameControlOf(rowNamed(INTERACTION_EVENT.name)));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: INTERACTION_EVENT.id,
      spanId: INTERACTION_EVENT.spanId,
      traceId: INTERACTION_EVENT.traceId,
    });
    expect(currentRowNames()).toEqual([REQUEST_EVENT.name]);

    // A span of another trace is not this chart's to mark, and neither is an
    // empty host selection.
    rerender(
      selectionHostedChart(
        {
          selection: {
            eventId: 'event-example-elsewhere',
            traceId: 'c8d2e3f405162738495a6b7c8d9e0f1a',
            spanId: REQUEST_EVENT.spanId,
          },
        },
        context,
      ),
    );
    expect(currentRowNames()).toEqual([]);
    expect(selectedFrameNames()).toEqual([]);

    rerender(selectionHostedChart({ selection: undefined }, context));
    expect(currentRowNames()).toEqual([]);
    expect(selectedFrameNames()).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Hover detail and its dismissal (WCAG 1.4.13)
 *
 * A frame's SVG title is the user agent's tooltip, so the view draws its own
 * hover detail — the frame's list row, marked while the frame is hovered — and
 * Escape dismisses it without moving the pointer. The keyboard reaches the same
 * facts through the row name's description, which opens on focus and closes on
 * Escape.
 * ---------------------------------------------------------------------------
 */

/**
 * The frame on the canvas whose SVG title names `name` on its first line.
 *
 * @param name The frame's name.
 * @returns That frame.
 */
function frameNamed(name: string): Element {
  const frame = Array.from(canvas().querySelectorAll('rect.dg-flame__frame')).find(
    (candidate) => (candidate.querySelector('title')?.textContent ?? '').split('\n')[0] === name,
  );

  if (frame === undefined) {
    throw new Error(`no frame on the canvas is named "${name}"`);
  }

  return frame;
}

/** The names of the list rows carrying the hover state, in document order. */
function hoveredRowNames(): string[] {
  return frameRows()
    .filter((row) => row.classList.contains('dg-is-hovered'))
    .map((row) => nameControlOf(row).textContent ?? '');
}

describe('FlameChart hover detail and dismissal', () => {
  it('marks the list row of the frame under the pointer, and Escape dismisses it without moving the pointer', async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    expect(hoveredRowNames()).toEqual([]);

    await user.hover(frameNamed(REQUEST_EVENT.name));
    expect(hoveredRowNames()).toEqual([REQUEST_EVENT.name]);

    // The mark follows the pointer from frame to frame.
    await user.hover(frameNamed(HANDLER_EVENT.name));
    expect(hoveredRowNames()).toEqual([HANDLER_EVENT.name]);

    // The pointer moves no focus, so the key arrives at the page body. It
    // dismisses the mark there and is not consumed.
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
    expect(hoveredRowNames()).toEqual([]);

    // Nothing was selected by it, and the next frame entered is marked again.
    expect(frameRows().filter((row) => row.classList.contains('dg-is-selected'))).toHaveLength(0);

    await user.hover(frameNamed(INTERACTION_EVENT.name));
    expect(hoveredRowNames()).toEqual([INTERACTION_EVENT.name]);

    await user.unhover(frameNamed(INTERACTION_EVENT.name));
    expect(hoveredRowNames()).toEqual([]);
  });

  it("opens a row's full description on keyboard focus, and Escape closes it without moving focus", async () => {
    const stub = resolvingProvider(CHAIN_TREE);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });
    await screen.findByRole('tree');

    // The name is out of the Tab order — the row is the tree's one stop, and
    // the keyboard suite covers what focusing the row reveals — so focus is
    // moved onto it directly, as a pointer press would move it.
    const row = rowNamed(INTERACTION_EVENT.name);
    const name = nameControlOf(row);
    act(() => {
      name.focus();
    });
    expect(document.activeElement).toBe(name);

    const bubble = row.querySelector<HTMLElement>('.dg-tooltip__bubble.dg-is-open');
    if (bubble === null) {
      throw new Error('the focused name did not open its description');
    }
    expect(bubble.textContent).toContain(INTERACTION_EVENT.name);
    expect(bubble.textContent).toContain('own time');

    await user.keyboard('{Escape}');
    expect(row.querySelector('.dg-tooltip__bubble.dg-is-open')).toBeNull();
    expect(document.activeElement).toBe(name);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Marks and reveals on the bounded tree
 *
 * The tree renders only one page of its rows, so the selected or hovered
 * frame's row may not be in the document. Both marks are keyed by frame id and
 * land whenever that row renders. A selection made anywhere but the tree takes
 * the tab stop — and with it the rendered page — to its row, and asks the
 * browser, once, to scroll that row into the tree's own viewport by the least
 * distance; a hover never does, and neither does the tree's own activation.
 *
 * The request is the component's side of the reveal, and the browser does the
 * rest from its own layout. happy-dom scrolls nothing, so the cases record the
 * request itself with a spy on `scrollIntoView` — happy-dom's own no-op, called
 * through — which the suite's `afterEach` restores. No size, offset or scroll
 * position is read or faked.
 * ---------------------------------------------------------------------------
 */

/** The index, among the long tree's siblings, of the one a host selects. */
const FAR_SIBLING_INDEX = 300;

/** The long tree's sibling at `index`: its event id and its frame name. */
function longSibling(index: number): { readonly eventId: string; readonly name: string } {
  const suffix = String(index).padStart(3, '0');
  return { eventId: `event-example-short-${suffix}`, name: `example.step.${suffix}` };
}

/**
 * The options the tree hands `scrollIntoView`: the least distance on both
 * axes, confined to the nearest scroll container — the tree's own viewport —
 * so the page never moves.
 */
const ROW_REVEAL_OPTIONS = { block: 'nearest', inline: 'nearest', container: 'nearest' };

/**
 * Records every `scrollIntoView` request, calling through to happy-dom's own
 * no-op. A behaviour spy: it observes what the component asks of the browser,
 * and answers no layout question.
 */
function spyOnReveal(): Mock<Element['scrollIntoView']> {
  return vi.spyOn(Element.prototype, 'scrollIntoView');
}

/** The elements `scrollIntoView` was called on, in call order. */
function revealedElements(reveal: Mock<Element['scrollIntoView']>): unknown[] {
  return reveal.mock.contexts;
}

describe('FlameChart marks and reveals on the bounded tree', () => {
  it('marks a host selection far down a long tree, and keys the hover mark by frame', async () => {
    const tree = shortSiblingsTree(LONG_SIBLING_COUNT);
    const far = longSibling(FAR_SIBLING_INDEX);
    const near = longSibling(10);
    const reveal = spyOnReveal();
    const user = userEvent.setup();

    render(
      selectionHostedChart(
        { selection: { eventId: far.eventId } },
        { provider: resolvingProvider(tree).provider, actions: makeActions().actions },
      ),
    );
    await screen.findByRole('tree');

    // The tree renders the page holding its tab stop, which starts on the
    // selected frame: so the selected row is rendered, marked in every way a
    // row states selection, and is the one stop.
    expect(frameRows().length).toBeLessThan(RENDERED_ROW_CEILING);
    const selectedRow = rowNamed(far.name);
    expect(currentRowNames()).toEqual([far.name]);
    expect(selectedRow.getAttribute('aria-selected')).toBe('true');
    expect(tabStops()).toEqual([selectedRow]);
    expect(selectedFrameNames()).toEqual([far.name]);

    // The host's selection arrived from elsewhere, so its row was revealed —
    // once, and without taking focus.
    expect(revealedElements(reveal)).toEqual([selectedRow]);
    expect(document.activeElement).toBe(document.body);

    // The hover mark lands on the rendered row of the frame under the pointer.
    await user.hover(frameNamed(far.name));
    expect(hoveredRowNames()).toEqual([far.name]);

    // A frame whose row is outside the window is marked by id: no rendered
    // row carries the mark, and the window does not move to it.
    await user.hover(frameNamed(near.name));
    expect(hoveredRowNames()).toEqual([]);
    expect(frameNames()).not.toContain(near.name);
    expect(frameNames()).toContain(far.name);

    // Back on a rendered row's frame, the mark follows; Escape dismisses it.
    await user.hover(frameNamed(far.name));
    expect(hoveredRowNames()).toEqual([far.name]);
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
    expect(hoveredRowNames()).toEqual([]);

    // No hover asked for a reveal.
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('asks the browser to reveal a selection made elsewhere, never one made in the tree', async () => {
    const reveal = spyOnReveal();
    const spies = makeActions();
    const context = { provider: resolvingProvider(CHAIN_TREE).provider, actions: spies.actions };
    const user = userEvent.setup();

    const { rerender } = render(selectionHostedChart({ selection: undefined }, context));
    await screen.findByRole('tree');

    // Nothing is selected, so nothing is revealed.
    expect(reveal).not.toHaveBeenCalled();

    // Another view selects the handler: its row is asked, once, to come into
    // the tree's viewport by the least distance, and focus does not move.
    rerender(selectionHostedChart({ selection: { eventId: HANDLER_EVENT.id } }, context));
    expect(currentRowNames()).toEqual([HANDLER_EVENT.name]);
    expect(revealedElements(reveal)).toEqual([rowNamed(HANDLER_EVENT.name)]);
    expect(reveal).toHaveBeenLastCalledWith(ROW_REVEAL_OPTIONS);
    expect(document.activeElement).toBe(document.body);

    // A row activated in the tree is one the reader is looking at: when the
    // host records that selection, nothing is revealed.
    reveal.mockClear();
    await user.click(nameControlOf(rowNamed(REQUEST_EVENT.name)));
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: REQUEST_EVENT.id,
      spanId: REQUEST_EVENT.spanId,
      traceId: REQUEST_EVENT.traceId,
    });
    rerender(selectionHostedChart({ selection: { eventId: REQUEST_EVENT.id } }, context));
    expect(currentRowNames()).toEqual([REQUEST_EVENT.name]);
    expect(reveal).not.toHaveBeenCalled();

    // Each new selection from elsewhere is revealed once, and a re-render for
    // any other reason reveals nothing.
    rerender(selectionHostedChart({ selection: { eventId: HANDLER_EVENT.id } }, context));
    expect(revealedElements(reveal)).toEqual([rowNamed(HANDLER_EVENT.name)]);
    rerender(selectionHostedChart({ selection: { eventId: HANDLER_EVENT.id } }, context));
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('brings a selection made elsewhere into the rendered rows before revealing it', async () => {
    const tree = shortSiblingsTree(LONG_SIBLING_COUNT);
    const far = longSibling(FAR_SIBLING_INDEX);
    const reveal = spyOnReveal();
    const context = { provider: resolvingProvider(tree).provider, actions: makeActions().actions };

    const { rerender } = render(selectionHostedChart({ selection: undefined }, context));
    await screen.findByRole('tree');

    // The window opens at the top of the list, and the far sibling is not in it.
    expect(frameRows().length).toBeLessThan(RENDERED_ROW_CEILING);
    expect(frameNames()).not.toContain(far.name);
    expect(tabStops().map((row) => nameOfRow(row))).toEqual(['example.batch']);

    // A host selection of it moves the tab stop, and the rendered rows with
    // it, to its row — which is then asked, once, to come into view. The list
    // stays bounded and focus stays where the reader left it.
    rerender(selectionHostedChart({ selection: { eventId: far.eventId } }, context));
    const selectedRow = rowNamed(far.name);
    expect(currentRowNames()).toEqual([far.name]);
    expect(tabStops()).toEqual([selectedRow]);
    expect(revealedElements(reveal)).toEqual([selectedRow]);
    expect(reveal).toHaveBeenLastCalledWith(ROW_REVEAL_OPTIONS);
    expect(frameRows().length).toBeLessThan(RENDERED_ROW_CEILING);
    expect(document.activeElement).toBe(document.body);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The canvas's coordinate system
 *
 * The chain above spans 120 ms: the interaction [0, 120], the request [4, 104]
 * and the handler [10, 90]. The canvas is always the same fixed 1 000-unit
 * logical space, whatever its container, so it draws 25/3 units per
 * millisecond and every placement below is exact arithmetic. The numbers are
 * the component's own geometry, restated so a case asserts a stated number.
 * ---------------------------------------------------------------------------
 */

/** The width of the canvas's logical space: `../utils/scale`'s `CHART_VIEWBOX_WIDTH`. */
const CANVAS_VIEWBOX_WIDTH = 1000;

/** The gap between a frame's left edge and its label, in user units. */
const LABEL_INSET = 4;

/**
 * The narrowest bar the scale draws, in user units: `../utils/scale`'s minimum
 * visible width, restated so the packing case below asserts a stated number.
 */
const MIN_VISIBLE_BAR_WIDTH = 2;

describe('FlameChart canvas', () => {
  it('draws in one fixed 1 000-unit space that its container sizes', async () => {
    const stub = resolvingProvider(CHAIN_TREE);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // Relational width over a fixed logical space exactly as tall as what it
    // draws, scaled uniformly from its top-left corner: nothing is stretched,
    // and nothing about the container was read to decide any of it.
    const picture = canvas();
    const [minX, minY, boxWidth, boxHeight] = viewBoxOf();
    expect(picture.getAttribute('width')).toBe('100%');
    expect([minX, minY, boxWidth]).toEqual([0, 0, CANVAS_VIEWBOX_WIDTH]);
    expect(picture.getAttribute('height')).toBe(String(boxHeight));
    expect(picture.getAttribute('preserveAspectRatio')).toBe('xMinYMin meet');

    // Exact per-mille placements of the 120 ms window.
    expect(drawnFrame(INTERACTION_EVENT.name)).toMatchObject({ x: 0, width: CANVAS_VIEWBOX_WIDTH });
    const request = drawnFrame(REQUEST_EVENT.name);
    expect(request.x).toBeCloseTo((4 / 120) * CANVAS_VIEWBOX_WIDTH, 6);
    expect(request.width).toBeCloseTo((100 / 120) * CANVAS_VIEWBOX_WIDTH, 6);
    const handler = drawnFrame(HANDLER_EVENT.name);
    expect(handler.x).toBeCloseTo((10 / 120) * CANVAS_VIEWBOX_WIDTH, 6);
    expect(handler.width).toBeCloseTo((80 / 120) * CANVAS_VIEWBOX_WIDTH, 6);

    // Labels sit inside their frames at the inset, and fit whole at these widths.
    for (const event of CHAIN_EVENTS) {
      const frame = drawnFrame(event.name);
      expect(frame.label).toBe(event.name);
      expect(frame.labelX).toBe(frame.x + LABEL_INSET);
    }
  });

  it('packs overlapping siblings at the logical width they are drawn at', async () => {
    // Forty back-to-back 1 ms siblings under a 1 000 ms root. Each is one unit
    // of the 1 000-unit space, widened to the scale's two-unit minimum, so two
    // of them stack over one point — the next one only touches the first —
    // and the depth needs two sub-rows.
    const stub = resolvingProvider(shortSiblingsTree());

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // Never one bar over another.
    expect(canvas().getAttribute('width')).toBe('100%');
    expect(drawnFrameNamed('example.batch')).toMatchObject({ x: 0, width: CANVAS_VIEWBOX_WIDTH });
    expect(drawnFrameNamed('example.step.001').x).toBeCloseTo(1, 6);
    expect(drawnFrameNamed('example.step.001').width).toBe(MIN_VISIBLE_BAR_WIDTH);
    expect(sameRowOverlaps()).toEqual([]);

    // The root's row and the siblings' two, each below the root; the canvas
    // is as tall as the rows it draws.
    const root = drawnFrameNamed('example.batch');
    const siblingRows = new Set(
      drawnFrames()
        .filter((frame) => frame.name !== 'example.batch')
        .map((frame) => frame.y),
    );
    expect(siblingRows.size).toBe(2);
    for (const y of siblingRows) {
      expect(y).toBeGreaterThan(root.y);
    }
    expect(icicleRows()).toHaveLength(3);
    expect(viewBoxOf()[3]).toBeGreaterThan(Math.max(...siblingRows));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Crowded levels, drawn on a bounded number of rows
 *
 * A level takes at most three rows. One whose operations stack deeper than
 * that keeps its longest operations as bars on two sub-rows and gathers the
 * rest into "+N" marks on ONE row beneath them, so the levels under it stay
 * near the top of the canvas; one whose operations fit in three rows is drawn
 * exactly as the optimal packing lays it out, every operation a bar. The
 * crowded fixture spans 1 000 ms, so the canvas draws one unit per
 * millisecond and every extent below is exact arithmetic. Its root holds three
 * crowds whose members start together:
 *
 *   A at   0 ms: `crowdSize` operations, the first 100 ms long and each one
 *                shorter than the one before, down to just over 50 ms;
 *   B at 500 ms: 50, 45 and 40 ms;
 *   C at 800 ms: 12, 11 and 10 ms;
 *
 * and a two-level chain hangs under the last (shortest) member of crowd A. With
 * two rows, each keeps one member of every crowd — the longest of each on the
 * first, the next on the second — and each crowd's remainder becomes one mark:
 * the rest of A over the extent of its longest remaining member, B's last over
 * its 40 units, and C's last over 10 units, too narrow to hold its count.
 * ---------------------------------------------------------------------------
 */

/** The most sub-rows a crowded level draws its frames on: the component's own bound, restated. */
const LEVEL_SUB_ROW_BOUND = 2;

/** The most rows any level takes: its sub-rows and the overflow row beneath them. */
const LEVEL_ROW_BOUND = LEVEL_SUB_ROW_BOUND + 1;

/**
 * Three siblings over one instant: a level that needs exactly
 * {@link LEVEL_ROW_BOUND} rows, which gathering could not shorten.
 */
const THREE_DEEP_TREE = labelTree([
  { name: 'example.overlap.first', offsetMs: 0, durationMs: 300 },
  { name: 'example.overlap.second', offsetMs: 10, durationMs: 300 },
  { name: 'example.overlap.third', offsetMs: 20, durationMs: 40 },
]);

/** How many members crowd A holds in the default fixture. */
const CROWD_SIZE = 10;

/** A crowd A far larger than any level could draw one row per member for. */
const LARGE_CROWD_SIZE = 300;

/** Crowd B's durations, in milliseconds, longest first. */
const CROWD_B_MS: readonly number[] = [50, 45, 40];

/** Crowd C's durations, in milliseconds, longest first. */
const CROWD_C_MS: readonly number[] = [12, 11, 10];

/** The crowded fixture's root. */
const CROWD_ROOT_NAME = 'example.crowd.root';

/** The operation nested under crowd A's last member. */
const CROWD_CHILD_NAME = 'example.crowd.child';

/** The operation nested under {@link CROWD_CHILD_NAME}. */
const CROWD_GRANDCHILD_NAME = 'example.crowd.grandchild';

/** The name of a crowd's member. */
function crowdName(crowd: 'a' | 'b' | 'c', index: number): string {
  return `example.crowd.${crowd}.${String(index).padStart(3, '0')}`;
}

/** The event id of the crowded fixture's operation named `name`. */
function crowdEventId(name: string): string {
  return `event-${name}`;
}

/** How long crowd A's member at `index` lasts: 100 ms, shortening evenly towards 50 ms. */
function crowdADurationMs(index: number, crowdSize: number): number {
  return 100 - (index * 50) / crowdSize;
}

/**
 * The crowded fixture: a 1 000 ms root over crowds A, B and C, and the chain
 * under crowd A's last member.
 *
 * @param crowdSize How many members crowd A holds; at most 399, so its span
 * ids never reach crowd B's.
 * @returns The correlated trace.
 */
function crowdedTree(crowdSize: number = CROWD_SIZE): TraceTree {
  const rootSpanId = spanIdFor(3000);

  const member = (
    name: string,
    ordinal: number,
    parentSpanId: string,
    offsetMs: number,
    durationMs: number,
    depth: number,
    children: readonly TraceNode[] = [],
  ): TraceNode =>
    makeTraceNode(
      makeEvent({
        id: crowdEventId(name),
        spanId: spanIdFor(ordinal),
        parentSpanId,
        name,
        kind: 'function',
        tier: 'server',
        startTime: BASE_START_MS + offsetMs,
        duration: durationMs,
        seq: ordinal - 3000,
        ingestSeq: ordinal - 2999,
      }),
      children,
      depth,
    );

  const lastOfA = crowdSize - 1;
  const grandchild = member(CROWD_GRANDCHILD_NAME, 3601, spanIdFor(3600), 0, 25, 3);
  const chainChild = member(CROWD_CHILD_NAME, 3600, spanIdFor(3001 + lastOfA), 0, 50, 2, [
    grandchild,
  ]);
  const crowdA = Array.from({ length: crowdSize }, (_unused, index) =>
    member(
      crowdName('a', index),
      3001 + index,
      rootSpanId,
      0,
      crowdADurationMs(index, crowdSize),
      1,
      index === lastOfA ? [chainChild] : [],
    ),
  );
  const crowdB = CROWD_B_MS.map((durationMs, index) =>
    member(crowdName('b', index), 3400 + index, rootSpanId, 500, durationMs, 1),
  );
  const crowdC = CROWD_C_MS.map((durationMs, index) =>
    member(crowdName('c', index), 3500 + index, rootSpanId, 800, durationMs, 1),
  );

  const root = makeEvent({
    id: crowdEventId(CROWD_ROOT_NAME),
    spanId: rootSpanId,
    name: CROWD_ROOT_NAME,
    kind: 'route.handler',
    tier: 'server',
    startTime: BASE_START_MS,
    duration: 1000,
    seq: 0,
    ingestSeq: 1,
  });

  return makeTree([makeTraceNode(root, [...crowdA, ...crowdB, ...crowdC], 0)]);
}

/**
 * The names of the frames drawn as bars on one row, left to right.
 *
 * @param index The row's 0-based index, top to bottom.
 * @returns The first line of each bar's title.
 */
function frameNamesOnRow(index: number): string[] {
  const group = icicleRows()[index];

  if (group === undefined) {
    throw new Error(`the canvas draws no row ${String(index)}`);
  }

  return Array.from(group.querySelectorAll('rect.dg-flame__frame')).map(
    (rect) => (rect.querySelector('title')?.textContent ?? '').split('\n')[0] ?? '',
  );
}

/**
 * A mark's title, as the chart words it: how many operations it gathers, the
 * stretch of the trace they cover, measured from the axis's zero, and that
 * each is still listed in the tree. Spelled out here, so a case pins the words
 * a reader hears.
 *
 * @param count How many operations the mark gathers.
 * @param fromMs Where the earliest gathered operation starts, from the axis's zero.
 * @param toMs Where the latest gathered operation ends, from the axis's zero.
 * @returns The title.
 */
function overflowTitle(count: number, fromMs: number, toMs: number): string {
  const gathered = count === 1 ? '1 operation' : `${formatCount(count)} operations`;
  const listed = count === 1 ? 'it is listed' : 'every one is listed';
  return `${gathered} from ${formatDuration(fromMs)} to ${formatDuration(
    toMs,
  )} gathered here, where this level overlaps more deeply than its ${String(
    LEVEL_SUB_ROW_BOUND,
  )} rows can draw; ${listed} in the tree below.`;
}

/**
 * The note — and the sentence of the canvas's text alternative — a drawing
 * that gathered operations owes its reader.
 *
 * @param gathered How many operations the drawn window gathered.
 * @param marks How many marks they were gathered into.
 * @returns The sentence.
 */
function compactionNote(gathered: number, marks: number): string {
  return `Where more operations of one level overlap than its ${String(
    LEVEL_SUB_ROW_BOUND,
  )} rows can hold, those rows keep the longest, and the ${formatCount(
    gathered,
  )} operations that did not fit are gathered into ${String(
    marks,
  )} marks on a row beneath them; every one is listed in the tree below.`;
}

/** Every note above the chart, as the reader reads it. */
function noteTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.dg-flame__note')).map(
    (note) => note.textContent ?? '',
  );
}

/** The crowd members no row of the default fixture can hold: all but two of each crowd. */
const GATHERED_NAMES: readonly string[] = [
  ...Array.from({ length: CROWD_SIZE - LEVEL_SUB_ROW_BOUND }, (_unused, index) =>
    crowdName('a', index + LEVEL_SUB_ROW_BOUND),
  ),
  crowdName('b', 2),
  crowdName('c', 2),
];

/** The row the crowded level's marks sit on: beneath the root's and the level's own rows. */
const OVERFLOW_ROW_INDEX = 1 + LEVEL_SUB_ROW_BOUND;

describe('FlameChart crowded levels', () => {
  it('draws a level crowded past its rows on those rows and one row of marks beneath them', async () => {
    const tree = crowdedTree();

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');

    // Ten operations stack over the start of crowd A, so the optimal packing
    // alone would give that level ten rows. It takes its two, and one of marks.
    const levelRows = new Set([
      ...drawnFrames()
        .filter((frame) => /^example\.crowd\.[abc]\./.test(frame.name))
        .map((frame) => rowIndexOf(frame.name)),
      ...overflowMarks().map((mark) => mark.row),
    ]);
    expect([...levelRows].sort((left, right) => left - right)).toEqual([1, 2, OVERFLOW_ROW_INDEX]);
    expect(levelRows.size).toBeLessThanOrEqual(LEVEL_ROW_BOUND);
    expect(icicleRows()).toHaveLength(1 + LEVEL_ROW_BOUND + 2);

    // The rows keep the longest of every crowd, left to right, and the level
    // stays depth-major: the root above it, the chain below its marks.
    expect(frameNamesOnRow(0)).toEqual([CROWD_ROOT_NAME]);
    expect(frameNamesOnRow(1)).toEqual([crowdName('a', 0), crowdName('b', 0), crowdName('c', 0)]);
    expect(frameNamesOnRow(2)).toEqual([crowdName('a', 1), crowdName('b', 1), crowdName('c', 1)]);
    expect(frameNamesOnRow(OVERFLOW_ROW_INDEX)).toEqual([]);
    expect(frameNamesOnRow(OVERFLOW_ROW_INDEX + 1)).toEqual([CROWD_CHILD_NAME]);
    expect(frameNamesOnRow(OVERFLOW_ROW_INDEX + 2)).toEqual([CROWD_GRANDCHILD_NAME]);
    expect(sameRowOverlaps()).toEqual([]);

    // Nothing is lost: the canvas accounts for every operation, as a bar or in
    // a mark's count, and the tree still lists every one, in traversal order.
    expect(canvasOperationCount()).toBe(tree.nodeCount);
    expect(frameNames()).toEqual([
      CROWD_ROOT_NAME,
      ...Array.from({ length: CROWD_SIZE }, (_unused, index) => crowdName('a', index)),
      CROWD_CHILD_NAME,
      CROWD_GRANDCHILD_NAME,
      ...CROWD_B_MS.map((_duration, index) => crowdName('b', index)),
      ...CROWD_C_MS.map((_duration, index) => crowdName('c', index)),
    ]);
  });

  it('marks each run of gathered operations with its count, and says each is listed below', async () => {
    renderComponent(makeNode(), {
      provider: resolvingProvider(crowdedTree()).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');

    // One mark per run of overlapping gathered bars, each over the extent its
    // run covers, on the one overflow row. The count is drawn when it fits
    // whole — never cut — and the title always carries it.
    const marks = overflowMarks();
    expect(marks.map(({ count, label, row, title }) => ({ count, label, row, title }))).toEqual([
      {
        count: CROWD_SIZE - LEVEL_SUB_ROW_BOUND,
        label: `+${String(CROWD_SIZE - LEVEL_SUB_ROW_BOUND)}`,
        row: OVERFLOW_ROW_INDEX,
        // Crowd A's gathered members all start with the root; the longest of
        // them — the first the two rows could not keep — sets where the run ends.
        title: overflowTitle(
          CROWD_SIZE - LEVEL_SUB_ROW_BOUND,
          0,
          crowdADurationMs(LEVEL_SUB_ROW_BOUND, CROWD_SIZE),
        ),
      },
      { count: 1, label: '+1', row: OVERFLOW_ROW_INDEX, title: overflowTitle(1, 500, 540) },
      {
        count: 1,
        label: undefined,
        row: OVERFLOW_ROW_INDEX,
        title: overflowTitle(1, 800, 810),
      },
    ]);
    // The stretch is what tells the marks apart when a reader moves through the
    // canvas's images by name: no two of them share a name.
    expect(new Set(marks.map((mark) => mark.title)).size).toBe(marks.length);
    const [runA, runB, runC] = marks;
    if (runA === undefined || runB === undefined || runC === undefined) {
      throw new Error('the crowded level drew fewer than three marks');
    }
    expect(runA.x).toBeCloseTo(0, 6);
    expect(runA.width).toBeCloseTo(crowdADurationMs(LEVEL_SUB_ROW_BOUND, CROWD_SIZE), 6);
    expect(runB.x).toBeCloseTo(500, 6);
    expect(runB.width).toBeCloseTo(40, 6);
    expect(runC.x).toBeCloseTo(800, 6);
    expect(runC.width).toBeCloseTo(10, 6);

    // A gathered operation is in a mark's count, not drawn as a bar of its own.
    const drawnNames = drawnFrames().map((frame) => frame.name);
    for (const name of GATHERED_NAMES) {
      expect(drawnNames).not.toContain(name);
    }
    expect(marks.reduce((sum, mark) => sum + mark.count, 0)).toBe(GATHERED_NAMES.length);
  });

  it('keeps the levels beneath a crowded one at the same rows, however crowded it is', async () => {
    const tree = crowdedTree(LARGE_CROWD_SIZE);

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');

    // Three hundred operations stack over one instant, and the chain under them
    // still starts on the row right after the level's marks — the row it takes
    // under a crowd of ten.
    expect(rowIndexOf(CROWD_CHILD_NAME)).toBe(OVERFLOW_ROW_INDEX + 1);
    expect(rowIndexOf(CROWD_GRANDCHILD_NAME)).toBe(OVERFLOW_ROW_INDEX + 2);
    expect(icicleRows()).toHaveLength(1 + LEVEL_ROW_BOUND + 2);
    expect(overflowMarks()[0]?.count).toBe(LARGE_CROWD_SIZE - LEVEL_SUB_ROW_BOUND);
    expect(canvasOperationCount()).toBe(tree.nodeCount);
  });

  it.each([
    { fixture: 'one row per level', tree: CHAIN_TREE, rows: 3 },
    { fixture: 'a re-attached frame on a second row', tree: ORPHAN_TREE, rows: 3 },
    { fixture: 'widened siblings on two rows', tree: shortSiblingsTree(), rows: 3 },
    {
      fixture: 'three overlapping siblings on three rows',
      tree: THREE_DEEP_TREE,
      rows: 1 + LEVEL_ROW_BOUND,
    },
  ])(
    'draws $fixture exactly as the packing always has, with no mark and no note',
    async ({ tree, rows }) => {
      const container = renderComponent(makeNode(), {
        provider: resolvingProvider(tree).provider,
        actions: makeActions().actions,
      });
      await screen.findByRole('tree');

      // No level needs more rows than it may draw, so every operation is a bar
      // on the rows the optimal packing gives it, and nothing is gathered.
      expect(icicleRows()).toHaveLength(rows);
      expect(drawnFrames()).toHaveLength(tree.nodeCount);
      expect(overflowMarks()).toEqual([]);
      expect(sameRowOverlaps()).toEqual([]);
      expect(noteTexts(container).some((note) => /gathered/.test(note))).toBe(false);
      expect(canvas().getAttribute('aria-label')).not.toMatch(/gathered/);
    },
  );

  it('states what it gathered in a note and in the picture’s text alternative, only when it gathered anything', async () => {
    const container = renderComponent(makeNode(), {
      provider: resolvingProvider(crowdedTree()).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');

    // Ten operations gathered into three marks, stated once above the chart
    // and in the picture's own description, with the bound that caused it.
    const note = compactionNote(GATHERED_NAMES.length, 3);
    expect(noteTexts(container).filter((text) => /gathered/.test(text))).toEqual([note]);
    expect(canvas().getAttribute('aria-label')).toContain(note);

    // The same view over a trace the bound never touches says nothing of it.
    cleanup();
    const quiet = renderComponent(makeNode(), {
      provider: resolvingProvider(shortSiblingsTree()).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');
    expect(noteTexts(quiet).some((text) => /gathered/.test(text))).toBe(false);
    expect(canvas().getAttribute('aria-label')).not.toMatch(/gathered/);
  });

  it('draws a gathered frame the panel selects over its mark, and moves no row', async () => {
    const context = {
      provider: resolvingProvider(crowdedTree()).provider,
      actions: makeActions().actions,
    };
    const gathered = crowdName('a', 5);

    const { rerender } = render(
      selectionHostedChart({ selection: { eventId: crowdEventId(gathered) } }, context),
    );
    await screen.findByRole('tree');

    // The selection is marked in the picture, as a bar at its own extent on
    // the overflow row, and in the list; its mark still counts it, and gives
    // its band to the bar rather than drawing its count under it.
    expect(selectedFrameNames()).toEqual([gathered]);
    expect(currentRowNames()).toEqual([gathered]);
    expect(rowIndexOf(gathered)).toBe(OVERFLOW_ROW_INDEX);
    expect(drawnFrameNamed(gathered).x).toBeCloseTo(0, 6);
    expect(drawnFrameNamed(gathered).width).toBeCloseTo(crowdADurationMs(5, CROWD_SIZE), 6);
    expect(overflowMarks().map(({ count, label }) => ({ count, label }))).toEqual([
      { count: CROWD_SIZE - LEVEL_SUB_ROW_BOUND, label: undefined },
      { count: 1, label: '+1' },
      { count: 1, label: undefined },
    ]);

    // The layout does not depend on the selection: every row holds what it
    // held without one.
    expect(icicleRows()).toHaveLength(1 + LEVEL_ROW_BOUND + 2);
    expect(frameNamesOnRow(1)).toEqual([crowdName('a', 0), crowdName('b', 0), crowdName('c', 0)]);
    expect(frameNamesOnRow(2)).toEqual([crowdName('a', 1), crowdName('b', 1), crowdName('c', 1)]);

    // A selection a row already draws is marked there, and the overflow row
    // holds marks alone again, with their counts.
    rerender(
      selectionHostedChart({ selection: { eventId: crowdEventId(crowdName('a', 0)) } }, context),
    );
    expect(selectedFrameNames()).toEqual([crowdName('a', 0)]);
    expect(frameNamesOnRow(OVERFLOW_ROW_INDEX)).toEqual([]);
    expect(overflowMarks()[0]?.label).toBe(`+${String(CROWD_SIZE - LEVEL_SUB_ROW_BOUND)}`);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Frame labels, fitted in logical units
 *
 * Every trace below spans 1 000 ms, so the fixed 1 000-unit canvas draws
 * exactly one unit per millisecond. Labels are fitted in those units with the
 * deterministic advance estimate at the 11-unit label size: 0.6 em = 6.6 units
 * per narrow grapheme (the ellipsis included) and 1.25 em = 13.75 units per
 * wide one. The label and its frame scale together, so a fit holds at every
 * panel width. The long name is 243 UTF-16 units: a 133-grapheme head, one
 * emoji — a single code point outside the BMP, so a surrogate pair — and a
 * 108-grapheme tail, with no whitespace anywhere near a cut, so each expected
 * label below is a hand calculation rather than a re-run of the fitting search.
 * ---------------------------------------------------------------------------
 */

/** The label font size the estimate assumes, in user units. */
const LABEL_FONT_SIZE = 11;

/** The truncation mark a fitted label ends with: U+2026. */
const ELLIPSIS_MARK = '\u2026';

/** A wide grapheme, stored as a surrogate pair. */
const WIDE_NAME_GRAPHEME = '\u{1F680}';

/** The long name's head: 133 narrow graphemes. */
const LONG_NAME_HEAD = `example.${'aggregate-'.repeat(12)}final`;

/** A 243-unit operation name with a wide grapheme after its head. */
const LONG_FRAME_NAME = `${LONG_NAME_HEAD}${WIDE_NAME_GRAPHEME}${'-overflow'.repeat(12)}`;

/**
 * An unpaired surrogate. Under the `u` flag a well-formed pair is one code
 * point, so this class matches only half of a split pair.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** One child of a label fixture's root: a name and its window, in ms from the root's start. */
interface LabelFixtureChild {
  readonly name: string;
  readonly offsetMs: number;
  readonly durationMs: number;
}

/**
 * A 1 000 ms root named `example.root` with the given children one level down.
 *
 * @param children The children, in canonical order.
 * @returns The correlated trace they form.
 */
function labelTree(children: readonly LabelFixtureChild[]): TraceTree {
  const rootSpanId = spanIdFor(2000);
  const root = makeEvent({
    id: 'event-example-label-0000',
    spanId: rootSpanId,
    name: 'example.root',
    startTime: BASE_START_MS,
    duration: 1000,
    seq: 0,
    ingestSeq: 1,
  });

  return makeTree([
    makeTraceNode(
      root,
      children.map((child, index) =>
        makeTraceNode(
          makeEvent({
            id: `event-example-label-${String(index + 1).padStart(4, '0')}`,
            spanId: spanIdFor(2001 + index),
            parentSpanId: rootSpanId,
            name: child.name,
            startTime: BASE_START_MS + child.offsetMs,
            duration: child.durationMs,
            seq: index + 1,
            ingestSeq: index + 2,
          }),
          [],
          1,
        ),
      ),
      0,
    ),
  ]);
}

/**
 * Asserts the properties every drawn label owes its frame: it is the name or a
 * prefix of it ending in the ellipsis, it keeps every surrogate pair whole, and
 * it fits between the insets — measured with the same estimate, in the same
 * logical units, the component fits with.
 *
 * @param frame The frame as the canvas drew it.
 * @param name The frame's recorded name.
 * @returns The label, known to be drawn.
 */
function expectLabelInsideFrame(frame: LabelledFrame, name: string): string {
  const { label, labelX } = frame;

  if (label === undefined || labelX === undefined) {
    throw new Error(`the frame named "${name}" carries no label`);
  }

  const kept = label.endsWith(ELLIPSIS_MARK) ? label.slice(0, -ELLIPSIS_MARK.length) : label;
  expect(name.startsWith(kept)).toBe(true);
  expect(LONE_SURROGATE.test(label)).toBe(false);
  expect(estimateTextWidth(label, LABEL_FONT_SIZE)).toBeLessThanOrEqual(
    frame.width - 2 * LABEL_INSET,
  );
  expect(labelX + estimateTextWidth(label, LABEL_FONT_SIZE)).toBeLessThanOrEqual(
    frame.x + frame.width - LABEL_INSET,
  );

  return label;
}

/** The text of every label the canvas draws, in document order. */
function frameLabels(): string[] {
  return Array.from(canvas().querySelectorAll('text.dg-flame__frame-label')).map(
    (text) => text.textContent ?? '',
  );
}

describe('FlameChart frame labels', () => {
  it('cuts a long name to its frame in logical units, with the ellipsis inside the frame', async () => {
    const stub = resolvingProvider(
      labelTree([{ name: LONG_FRAME_NAME, offsetMs: 0, durationMs: 900 }]),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    expect(LONG_FRAME_NAME).toHaveLength(243);

    // A 900-unit frame leaves 892 between the insets. The head and the ellipsis
    // are 134 narrow graphemes, 884.4 units; the emoji would add 13.75, making
    // 898.15, which does not fit. So the cut lands before the emoji, whole.
    const frame = drawnFrame(LONG_FRAME_NAME);
    expect(frame.width).toBeCloseTo(900, 6);
    const label = expectLabelInsideFrame(frame, LONG_FRAME_NAME);
    expect(label).toBe(`${LONG_NAME_HEAD}${ELLIPSIS_MARK}`);
    expect(label.includes(WIDE_NAME_GRAPHEME)).toBe(false);

    // The root's short name fits whole and is not marked as cut.
    expect(expectLabelInsideFrame(drawnFrame('example.root'), 'example.root')).toBe('example.root');
  });

  it('keeps a wide grapheme whole when the cut falls after it', async () => {
    const stub = resolvingProvider(
      labelTree([{ name: LONG_FRAME_NAME, offsetMs: 0, durationMs: 950 }]),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    // 942 units between the insets: the head (877.8) and the emoji (13.75)
    // take 891.55, six tail graphemes and the ellipsis 46.2 more — 937.75 —
    // and a seventh tail grapheme would reach 944.35.
    const label = expectLabelInsideFrame(drawnFrame(LONG_FRAME_NAME), LONG_FRAME_NAME);
    expect(label).toBe(`${LONG_NAME_HEAD}${WIDE_NAME_GRAPHEME}-overf${ELLIPSIS_MARK}`);
  });

  it('draws no label in a frame too narrow for a legible fragment', async () => {
    const stub = resolvingProvider(
      labelTree([
        // 33 units: wide enough to be considered, but the 25 between the insets
        // cannot hold three graphemes and the ellipsis (26.4).
        { name: LONG_FRAME_NAME, offsetMs: 0, durationMs: 33 },
        // 31 units: below the 32-unit floor, although "run" (19.8) would fit.
        { name: 'run', offsetMs: 200, durationMs: 31 },
        // 40 units: above the floor, and "set" fits whole.
        { name: 'set', offsetMs: 300, durationMs: 40 },
      ]),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree');

    expect(drawnFrame(LONG_FRAME_NAME).label).toBeUndefined();
    expect(drawnFrame('run').label).toBeUndefined();
    expect(expectLabelInsideFrame(drawnFrame('set'), 'set')).toBe('set');

    // No fragment of the long name is painted anywhere on the canvas.
    const labels = frameLabels();
    expect(labels).toEqual(['example.root', 'set']);
    expect(labels.some((text) => text.includes('aggregate'))).toBe(false);
  });
});

/**
 * The drawn window's statement, as the chart words it: the operations drawn
 * and, for each side that holds any, how many it leaves undrawn.
 *
 * Spelled out here rather than read back from the component, so a case pins
 * the words a reader hears.
 *
 * @param start The first drawn operation's 0-based index among the shown ones.
 * @param count How many are drawn.
 * @param total How many are shown in all.
 * @returns The sentence.
 */
function windowStatement(start: number, count: number, total: number): string {
  const drawn =
    count === 1
      ? `Operation ${formatCount(start + 1)} of ${formatCount(total)} is drawn`
      : `Operations ${formatCount(start + 1)}–${formatCount(start + count)} of ${formatCount(
          total,
        )} are drawn`;
  const before = start;
  const after = total - start - count;
  const sides = [
    ...(before > 0 ? [`${formatCount(before)} before`] : []),
    ...(after > 0 ? [`${formatCount(after)} after`] : []),
  ];

  return sides.length === 0
    ? `${drawn}.`
    : `${drawn}; ${sides.join(' and ')} ${before + after === 1 ? 'is' : 'are'} not.`;
}

/**
 * A paging control, obtained by role and name: one of the operations controls
 * above the canvas, or one of the row controls beneath the tree.
 *
 * @param name {@link PREVIOUS_NAME} or {@link NEXT_NAME}, or
 * {@link PREVIOUS_ROWS_NAME} or {@link NEXT_ROWS_NAME}.
 * @returns The control, typed as the button it is.
 */
function pagingControl(name: string): HTMLButtonElement {
  const control = screen.getByRole('button', { name });

  if (!(control instanceof HTMLButtonElement)) {
    throw new Error(`the "${name}" control is not a button`);
  }

  return control;
}

/** The long trace's sibling at `index` among the root's children: its name. */
function pagedSiblingName(index: number): string {
  return `example.step.${String(index).padStart(3, '0')}`;
}

/*
 * The context a page that opens below the root is drawn with, as the chart
 * words it. Spelled out here rather than read back from the component, so a
 * case pins the words a reader sees and hears.
 */

/** The caption, and accessible name, of the tree's list of context rows. */
const TREE_CONTEXT_CAPTION =
  'Context from an earlier page, not rows of this one: the rows below are nested inside';

/** The last line of every context bar's title. */
const CONTEXT_BAR_NOTE =
  'Drawn for context: an operation this window’s operations are nested inside, listed with its own operations in an earlier window.';

/** The name of the middle level of {@link nestedSiblingsTree}. */
const NESTED_GROUP_NAME = 'example.group';

/** The event id of the middle level of {@link nestedSiblingsTree}. */
const NESTED_GROUP_EVENT_ID = 'event-example-0101';

/**
 * {@link shortSiblingsTree} with one more level between the root and its
 * siblings: the root, one group operation inside it, and `count` consecutive
 * 1 ms operations inside the group — so a window or a page that opens among
 * the siblings has a context of two operations.
 *
 * @param count How many siblings the group holds.
 * @returns The correlated trace.
 */
function nestedSiblingsTree(count: number): TraceTree {
  const [flat] = shortSiblingsTree(count).roots;
  if (flat === undefined) {
    throw new Error('the short-siblings fixture built no root');
  }

  const group = makeEvent({
    id: NESTED_GROUP_EVENT_ID,
    spanId: spanIdFor(101),
    parentSpanId: flat.event.spanId,
    name: NESTED_GROUP_NAME,
    kind: 'function',
    tier: 'server',
    startTime: flat.event.startTime,
    duration: flat.event.duration,
    seq: count + 1,
    ingestSeq: count + 2,
  });
  const siblings = flat.children.map((child) =>
    makeTraceNode({ ...child.event, parentSpanId: group.spanId }, [], 2),
  );

  return makeTree([makeTraceNode(flat.event, [makeTraceNode(group, siblings, 1)], 0)]);
}

/**
 * The tree's list of context rows: the operations the page's rows are nested
 * inside, named by its caption.
 *
 * @returns The list, or `null` when the page has no context.
 */
function contextList(): HTMLElement | null {
  return screen.queryByRole('list', { name: TREE_CONTEXT_CAPTION });
}

/**
 * The names the context list shows, outermost first.
 *
 * @param list The context list.
 * @returns One name per context row.
 */
function contextRowNames(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getByText(FRAME_NAME_PATTERN).textContent ?? '');
}

/*
 * Every case below draws at least one full window, so the group runs under
 * {@link WINDOW_CASE_TIMEOUT_MS} rather than the default.
 */
describe('FlameChart drawn-row budget', { timeout: WINDOW_CASE_TIMEOUT_MS }, () => {
  it('never draws more than the budget, and pages a window through the whole trace', async () => {
    const tree = shortSiblingsTree(PAGED_SIBLING_COUNT);
    const total = tree.nodeCount;
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: spies.actions,
    });

    await screen.findByRole('tree');

    // The first window: one budget's worth of operations — each a bar, or
    // counted by a "+N" mark where the siblings stack deeper than a level's
    // rows — and a statement, in the notice and in the canvas's text
    // alternative alike, of what is drawn and what follows undrawn. Paging is
    // not a partial result: every operation is one page away.
    expect(total).toBe(PAGED_SIBLING_COUNT + 1);
    const first = windowStatement(0, DRAWN_ROW_BUDGET, total);
    const statement = screen.getByText(first);
    expect(statement.getAttribute('aria-live')).toBe('polite');
    expect(canvas().getAttribute('aria-label')).toContain(first);
    expect(canvasOperationCount()).toBe(DRAWN_ROW_BUDGET);
    expect(drawnFrames().length).toBeLessThanOrEqual(DRAWN_ROW_BUDGET);
    expect(screen.queryByText(PARTIAL_RESULT_BADGE)).toBeNull();
    expect(pagingControl(PREVIOUS_NAME).disabled).toBe(true);
    expect(pagingControl(NEXT_NAME).disabled).toBe(false);

    // A row states its place among ALL of its siblings, drawn or not.
    expect(frameRows()[1]?.getAttribute('aria-setsize')).toBe(String(PAGED_SIBLING_COUNT));

    // The next window MOVES the drawing rather than growing it: the same
    // number of operations, the ones after the first window, and the same
    // live statement element, so the page is announced. The root those
    // operations hang from is not one of them: it is drawn above them as
    // context, which the first window, opening at the root, has none of.
    expect(contextBarNames()).toEqual([]);
    await user.click(pagingControl(NEXT_NAME));
    expect(statement.isConnected).toBe(true);
    expect(statement.textContent).toBe(windowStatement(DRAWN_ROW_BUDGET, DRAWN_ROW_BUDGET, total));
    expect(canvasOperationCount()).toBe(DRAWN_ROW_BUDGET);
    expect(drawnFrames()[0]?.name).toBe(pagedSiblingName(DRAWN_ROW_BUDGET - 1));
    expect(drawnFrames().some((frame) => frame.name === 'example.batch')).toBe(false);
    expect(contextBarNames()).toEqual(['example.batch']);
    const [firstOfSecond] = frameRows();
    expect(firstOfSecond?.getAttribute('aria-level')).toBe('2');
    expect(firstOfSecond?.getAttribute('aria-posinset')).toBe(String(DRAWN_ROW_BUDGET));
    expect(firstOfSecond?.getAttribute('aria-setsize')).toBe(String(PAGED_SIBLING_COUNT));
    expect(pagingControl(PREVIOUS_NAME).disabled).toBe(false);

    // The last window holds the single operation left. Its control is spent,
    // and the focus it held moves to the other control, not to the document.
    await user.click(pagingControl(NEXT_NAME));
    expect(statement.textContent).toBe(windowStatement(2 * DRAWN_ROW_BUDGET, 1, total));
    expect(drawnFrames()).toHaveLength(1);
    expect(pagingControl(NEXT_NAME).disabled).toBe(true);
    expect(document.activeElement).toBe(pagingControl(PREVIOUS_NAME));

    // However often more is asked for, the drawing never exceeds the budget,
    // and its context never more than one bar per level the layout draws.
    for (const name of [PREVIOUS_NAME, PREVIOUS_NAME, NEXT_NAME, NEXT_NAME, NEXT_NAME, NEXT_NAME]) {
      const control = pagingControl(name);
      if (!control.disabled) {
        await user.click(control);
      }
      expect(drawnFrames().length).toBeLessThanOrEqual(DRAWN_ROW_BUDGET);
      expect(frameRows().length).toBeLessThanOrEqual(DRAWN_ROW_BUDGET);
      expect(contextBars().length).toBeLessThanOrEqual(ICICLE_DEPTH_BOUND);
    }

    // Back to the first window, the statement is the first one again.
    await user.click(pagingControl(PREVIOUS_NAME));
    await user.click(pagingControl(PREVIOUS_NAME));
    expect(statement.textContent).toBe(first);
    expect(document.activeElement).toBe(pagingControl(NEXT_NAME));

    // Paging is neither a selection nor a disclosure.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('draws what a later window is nested inside as context, never as its own content', async () => {
    const tree = nestedSiblingsTree(PAGED_SIBLING_COUNT);
    const total = tree.nodeCount;
    const spies = makeActions();
    const user = userEvent.setup();

    const container = renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: spies.actions,
    });
    await screen.findByRole('tree');

    // The first window opens at the root, so it has no context: no band, no
    // list, and the context statement — mounted, so it can announce — is
    // empty and visually hidden.
    const statement = screen.getByText(windowStatement(0, DRAWN_ROW_BUDGET, total));
    expect(contextBarNames()).toEqual([]);
    expect(contextList()).toBeNull();
    const contextStatement = container.querySelector('p.dg-visually-hidden[aria-live="polite"]');
    expect(contextStatement?.textContent).toBe('');

    // The second window opens among the group's siblings. The two operations
    // they hang from are drawn above them, outermost at the top, each on a row
    // of its own above every row of the window — and neither is counted as
    // one of the window's operations.
    await user.click(pagingControl(NEXT_NAME));
    expect(statement.textContent).toBe(windowStatement(DRAWN_ROW_BUDGET, DRAWN_ROW_BUDGET, total));
    // The window's operations are its bars and whatever a crowded depth
    // gathered into "+N" marks; the context band adds to neither.
    expect(canvasOperationCount()).toBe(DRAWN_ROW_BUDGET);
    expect(drawnFrames()[0]?.name).toBe(pagedSiblingName(DRAWN_ROW_BUDGET - 2));
    expect(contextBarNames()).toEqual(['example.batch', NESTED_GROUP_NAME]);
    const [outer, inner] = contextBars();
    const firstWindowRow = Math.min(...drawnFrames().map((frame) => frame.y));
    expect(outer?.y ?? Number.NaN).toBeLessThan(inner?.y ?? Number.NaN);
    expect(inner?.y ?? Number.NaN).toBeLessThan(firstWindowRow);
    for (const mark of overflowMarks()) {
      expect(inner?.y ?? Number.NaN).toBeLessThan(mark.y);
    }

    // Marked as context in words and in fill: its label opens with the word,
    // its title ends by saying what it is, and it is filled from outside the
    // span-kind scale every window frame is filled from.
    for (const name of ['example.batch', NESTED_GROUP_NAME]) {
      const rect = contextRect(name);
      const label = rect.nextElementSibling;
      expect(label?.matches('text.dg-flame__frame-label')).toBe(true);
      expect(label?.textContent).toBe(`Context: ${name}`);
      expect(rect.querySelector('title')?.textContent?.split('\n').at(-1)).toBe(CONTEXT_BAR_NOTE);
      expect(rect.style.getPropertyValue('--dgc-frame-color')).toBe('var(--dg-text-muted)');
    }

    // Stated for a reader who cannot see the band — in the canvas's text
    // alternative, and in the polite statement, which announces it.
    const sentence = `The top 2 rows of the chart are drawn for context: example.batch › ${NESTED_GROUP_NAME}, the operations the drawn operations are nested inside, from an earlier window.`;
    expect(canvas().getAttribute('aria-label')).toContain(sentence);
    expect(contextStatement?.textContent).toBe(sentence);
    expect(contextStatement?.classList.contains('dg-visually-hidden')).toBe(false);

    // The tree's first page of this window: its rows are the window's, and the
    // context is a captioned list outside the tree with no control in it.
    const list = contextList();
    if (list === null) {
      throw new Error('the second window’s rows carry no context list');
    }
    expect(contextRowNames(list)).toEqual(['example.batch', NESTED_GROUP_NAME]);
    expect(frameList().contains(list)).toBe(false);
    expect(list.querySelectorAll('button, a[href], input, [tabindex]')).toHaveLength(0);
    expect(frameRows()).toHaveLength(TEXT_ROW_BUDGET);
    expect(frameRows()[0]?.getAttribute('aria-level')).toBe('3');
    expect(nameOfRow(frameRows()[0] ?? frameList())).toBe(pagedSiblingName(DRAWN_ROW_BUDGET - 2));

    // Activating a context bar selects that operation, which pages the
    // drawing back to the window that draws it as content.
    await user.click(contextRect(NESTED_GROUP_NAME));
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventId: NESTED_GROUP_EVENT_ID }),
    );
    expect(statement.textContent).toBe(windowStatement(0, DRAWN_ROW_BUDGET, total));
    expect(contextBarNames()).toEqual([]);
    expect(drawnFrames().some((frame) => frame.name === NESTED_GROUP_NAME)).toBe(true);
  });

  it('starts from the first window again when the node’s query changes', async () => {
    const tree = shortSiblingsTree(PAGED_SIBLING_COUNT);
    const context = { provider: resolvingProvider(tree).provider, actions: makeActions().actions };
    const user = userEvent.setup();

    const { rerender } = render(hostedChart(makeNode(), context));
    await screen.findByRole('tree');
    await user.click(pagingControl(NEXT_NAME));
    expect(
      screen.getByText(windowStatement(DRAWN_ROW_BUDGET, DRAWN_ROW_BUDGET, tree.nodeCount)),
    ).toBeDefined();

    rerender(
      hostedChart(
        makeNode({ query: { source: 'trace', filter: { traceId: OTHER_TRACE_ID } } }),
        context,
      ),
    );

    expect(
      await screen.findByText(windowStatement(0, DRAWN_ROW_BUDGET, tree.nodeCount)),
    ).toBeDefined();
    expect(canvasOperationCount()).toBe(DRAWN_ROW_BUDGET);
    expect(drawnFrames()[0]?.name).toBe('example.batch');
  });

  it('opens the rows of a newly drawn window, and of a changed query, on their first page', async () => {
    const tree = shortSiblingsTree(PAGED_SIBLING_COUNT);
    const context = { provider: resolvingProvider(tree).provider, actions: makeActions().actions };
    const user = userEvent.setup();
    const firstPage = rowPageStatement(0, TEXT_ROW_BUDGET, DRAWN_ROW_BUDGET);

    const { rerender } = render(hostedChart(makeNode(), context));
    await screen.findByRole('tree');

    // Two pages into the first drawn window's rows.
    const rowsShown = screen.getByText(firstPage);
    await user.click(pagingControl(NEXT_ROWS_NAME));
    await user.click(pagingControl(NEXT_ROWS_NAME));
    expect(rowsShown.textContent).toBe(
      rowPageStatement(2 * TEXT_ROW_BUDGET, TEXT_ROW_BUDGET, DRAWN_ROW_BUDGET),
    );
    expect(frameNames()[0]).toBe(pagedSiblingName(2 * TEXT_ROW_BUDGET - 1));

    // The next drawn window lists other rows, and opens on its first page with
    // the tab stop on its first row.
    await user.click(pagingControl(NEXT_NAME));
    expect(rowsShown.textContent).toBe(firstPage);
    expect(frameNames()[0]).toBe(pagedSiblingName(DRAWN_ROW_BUDGET - 1));
    expect(tabStops().map(nameOfRow)).toEqual([pagedSiblingName(DRAWN_ROW_BUDGET - 1)]);

    // Paged straight back, the first drawn window opens on its first page too,
    // not on the page the reader left it at.
    await user.click(pagingControl(PREVIOUS_NAME));
    expect(rowsShown.textContent).toBe(firstPage);
    expect(tabStops().map(nameOfRow)).toEqual(['example.batch']);

    // A changed query starts over as well.
    await user.click(pagingControl(NEXT_ROWS_NAME));
    expect(rowsShown.textContent).toBe(
      rowPageStatement(TEXT_ROW_BUDGET, TEXT_ROW_BUDGET, DRAWN_ROW_BUDGET),
    );
    rerender(
      hostedChart(
        makeNode({ query: { source: 'trace', filter: { traceId: OTHER_TRACE_ID } } }),
        context,
      ),
    );
    expect(await screen.findByText(firstPage)).toBeDefined();
    expect(frameNames()[0]).toBe('example.batch');
    expect(tabStops().map(nameOfRow)).toEqual(['example.batch']);
  });

  it('pages to the window holding a selection made elsewhere, and lets the reader page away', async () => {
    const tree = shortSiblingsTree(PAGED_SIBLING_COUNT);
    const context = { provider: resolvingProvider(tree).provider, actions: makeActions().actions };
    const user = userEvent.setup();
    const total = tree.nodeCount;

    // Sibling 3 000 is operation 3 001 of the walk (the root is the first), so
    // it is drawn by the second window.
    const far = longSibling(3000);
    const { rerender } = render(
      selectionHostedChart({ selection: { eventId: far.eventId } }, context),
    );
    await screen.findByRole('tree');

    const second = windowStatement(DRAWN_ROW_BUDGET, DRAWN_ROW_BUDGET, total);
    const statement = screen.getByText(second);
    expect(selectedFrameNames()).toEqual([far.name]);
    expect(currentRowNames()).toEqual([far.name]);

    // The reader may page away from it: the selection is not drawn there, so
    // nothing carries its mark, and nothing pulls the window back.
    await user.click(pagingControl(PREVIOUS_NAME));
    const first = windowStatement(0, DRAWN_ROW_BUDGET, total);
    expect(statement.textContent).toBe(first);
    expect(selectedFrameNames()).toEqual([]);
    expect(currentRowNames()).toEqual([]);
    rerender(selectionHostedChart({ selection: { eventId: far.eventId } }, context));
    expect(statement.textContent).toBe(first);

    // A NEW selection outside the window moves it again, and clearing the
    // selection leaves the window where it is.
    const other = longSibling(2500);
    rerender(selectionHostedChart({ selection: { eventId: other.eventId } }, context));
    expect(statement.textContent).toBe(second);
    expect(selectedFrameNames()).toEqual([other.name]);
    expect(currentRowNames()).toEqual([other.name]);

    rerender(selectionHostedChart({ selection: undefined }, context));
    expect(statement.textContent).toBe(second);
    expect(selectedFrameNames()).toEqual([]);
  });

  it('crosses the drawn window with the arrow keys, Home and End', async () => {
    const tree = shortSiblingsTree(PAGED_SIBLING_COUNT);
    const user = userEvent.setup();
    const total = tree.nodeCount;

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');
    const statement = screen.getByText(windowStatement(0, DRAWN_ROW_BUDGET, total));

    // The paging controls come first in the Tab order — "Previous operations"
    // is disabled on the first page, so one stop — and the tree after them.
    await user.tab();
    expect(document.activeElement).toBe(pagingControl(NEXT_NAME));
    await user.tab();
    expect(nameOfRow(focusedRow())).toBe('example.batch');

    // End reaches the trace's last operation, on the last page.
    await user.keyboard('{End}');
    expect(nameOfRow(focusedRow())).toBe(pagedSiblingName(PAGED_SIBLING_COUNT - 1));
    expect(statement.textContent).toBe(windowStatement(2 * DRAWN_ROW_BUDGET, 1, total));
    expect(tabStops()).toEqual([focusedRow()]);

    // ArrowUp past the first drawn row lands on the last row of the window
    // before it, and ArrowDown past the last drawn row on the first of the next.
    await user.keyboard('{ArrowUp}');
    expect(nameOfRow(focusedRow())).toBe(pagedSiblingName(PAGED_SIBLING_COUNT - 2));
    expect(statement.textContent).toBe(windowStatement(DRAWN_ROW_BUDGET, DRAWN_ROW_BUDGET, total));
    await user.keyboard('{ArrowDown}');
    expect(nameOfRow(focusedRow())).toBe(pagedSiblingName(PAGED_SIBLING_COUNT - 1));
    expect(statement.textContent).toBe(windowStatement(2 * DRAWN_ROW_BUDGET, 1, total));

    // ArrowLeft steps out to a parent drawn on another page.
    await user.keyboard('{ArrowLeft}');
    expect(nameOfRow(focusedRow())).toBe('example.batch');
    expect(statement.textContent).toBe(windowStatement(0, DRAWN_ROW_BUDGET, total));
    expect(tabStops()).toEqual([focusedRow()]);

    // Home from anywhere is the trace's first operation.
    await user.keyboard('{End}');
    await user.keyboard('{Home}');
    expect(nameOfRow(focusedRow())).toBe('example.batch');
    expect(statement.textContent).toBe(windowStatement(0, DRAWN_ROW_BUDGET, total));
  });

  it('keeps folding working across windows, and pages over what is left open', async () => {
    const tree = shortSiblingsTree(PAGED_SIBLING_COUNT);
    const spies = makeActions();
    const user = userEvent.setup();
    const total = tree.nodeCount;

    const container = renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: spies.actions,
    });
    await screen.findByRole('tree');

    // From the second page, the tab stop is its first row; ArrowLeft steps out
    // to the root, one page back, and ArrowLeft again folds it.
    await user.click(pagingControl(NEXT_NAME));
    await user.tab();
    expect(nameOfRow(focusedRow())).toBe(pagedSiblingName(DRAWN_ROW_BUDGET - 1));
    await user.keyboard('{ArrowLeft}');
    expect(nameOfRow(focusedRow())).toBe('example.batch');
    await user.keyboard('{ArrowLeft}');

    // One operation is left open, so the whole of it is drawn: no statement,
    // no controls, and the fold note counts what it hides.
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, spanIdFor(100), false);
    expect(drawnFrames()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: NEXT_NAME })).toBeNull();
    expect(screen.queryByText(/are drawn;/)).toBeNull();
    const notes = Array.from(container.querySelectorAll('.dg-flame__note')).map(
      (note) => note.textContent ?? '',
    );
    expect(
      notes.some((note) =>
        note.includes(`1 subtree is folded, hiding ${formatCount(PAGED_SIBLING_COUNT)} operations`),
      ),
    ).toBe(true);

    // Opening it again pages over every operation once more, from the first.
    await user.keyboard('{ArrowRight}');
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, spanIdFor(100), true);
    expect(screen.getByText(windowStatement(0, DRAWN_ROW_BUDGET, total))).toBeDefined();
    expect(canvasOperationCount()).toBe(DRAWN_ROW_BUDGET);
    expect(nameOfRow(focusedRow())).toBe('example.batch');
  });

  it('lists a tree that holds more than it declares only as far as its own count allows', async () => {
    // One window's worth of siblings and the root, declaring ten nodes: the
    // walk stops at one window — the floor under a count it cannot believe —
    // and the partial-result notice says the rest is not listed.
    const actual = shortSiblingsTree(DRAWN_ROW_BUDGET);
    const tree: TraceTree = { ...actual, nodeCount: 10 };

    renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: makeActions().actions,
    });
    await screen.findByRole('tree');

    const sentence = `This trace holds more operations than it reports, so only the first ${formatCount(
      DRAWN_ROW_BUDGET,
    )} operations of it are listed.`;
    const notice = screen.getByText(sentence);
    expect(screen.getByText(PARTIAL_RESULT_BADGE).parentElement).toBe(notice.parentElement);
    expect(canvas().getAttribute('aria-label')).toContain(sentence);
    expect(canvasOperationCount()).toBe(DRAWN_ROW_BUDGET);
    expect(screen.queryByRole('button', { name: NEXT_NAME })).toBeNull();
  });

  it('offers no paging when the depth bound, not the budget, left operations out', async () => {
    const tree = depthEndedTree();

    const container = renderComponent(makeNode(), {
      provider: resolvingProvider(tree).provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('tree');

    // The trace holds more than one window, and every operation the depth
    // bound lets through is already drawn: no page holds the rest.
    expect(tree.nodeCount).toBeGreaterThan(DRAWN_ROW_BUDGET);
    expect(drawnFrames().length).toBeLessThanOrEqual(DRAWN_ROW_BUDGET);
    expect(screen.queryByText(PARTIAL_RESULT_BADGE)).toBeNull();
    expect(screen.queryByRole('button', { name: PREVIOUS_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: NEXT_NAME })).toBeNull();
    expect(canvas().getAttribute('aria-label')).not.toMatch(/are drawn;/);

    // What is left out is the depth bound's, and its note says so.
    expect(
      Array.from(container.querySelectorAll('.dg-flame__note')).some((note) =>
        new RegExp(`deeper than ${String(ICICLE_DEPTH_BOUND)} levels`, 'i').test(
          note.textContent ?? '',
        ),
      ),
    ).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The shape of a trace whose durations are not all measurements: a root over a
 * call recorded with a negative duration and one recorded with no number at
 * all, which a malformed record can carry.
 * ---------------------------------------------------------------------------
 */

/** A call recorded with a negative duration: a corrupt measurement, not a fast one. */
const NEGATIVE_CALL_EVENT = makeEvent({
  id: 'event-example-0901',
  spanId: spanIdFor(0x901),
  parentSpanId: spanIdFor(0x900),
  name: 'example.negative-call',
  kind: 'fetch',
  tier: 'browser',
  startTime: BASE_START_MS + 10,
  duration: -5,
  seq: 1,
  ingestSeq: 2,
});

/**
 * A call whose duration arrived as no number at all — `null` in a malformed
 * record, which the schema's type does not admit and a stored row can carry.
 */
const UNSET_CALL_EVENT = makeEvent({
  id: 'event-example-0902',
  spanId: spanIdFor(0x902),
  parentSpanId: spanIdFor(0x900),
  name: 'example.unset-call',
  kind: 'fetch',
  tier: 'browser',
  startTime: BASE_START_MS + 20,
  duration: null as unknown as number,
  seq: 2,
  ingestSeq: 3,
});

/** The root both calls hang from. */
const UNMEASURED_ROOT_EVENT = makeEvent({
  id: 'event-example-0900',
  spanId: spanIdFor(0x900),
  name: 'example.unmeasured-root',
  kind: 'interaction',
  tier: 'browser',
  startTime: BASE_START_MS,
  duration: 200,
  seq: 0,
  ingestSeq: 1,
});

/** The trace those three form. */
const UNMEASURED_TREE = makeTree([
  makeTraceNode(
    UNMEASURED_ROOT_EVENT,
    [makeTraceNode(NEGATIVE_CALL_EVENT, [], 1), makeTraceNode(UNSET_CALL_EVENT, [], 1)],
    0,
  ),
]);

/** The canvas frame drawing the operation named `name`. */
function frameRectNamed(name: string): Element {
  const rect = Array.from(canvas().querySelectorAll('rect.dg-flame__frame')).find(
    (frame) => frame.querySelector('title')?.textContent.split('\n')[0] === name,
  );
  if (rect === undefined) {
    throw new Error(`no frame on the canvas is named "${name}"`);
  }
  return rect;
}

describe('FlameChart chart accessible names', () => {
  it('names the canvas as a figure and every frame as an image named like its tree row', async () => {
    renderComponent(makeNode(), {
      provider: resolvingProvider(CHAIN_TREE).provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('tree');

    const picture = canvas();
    expect(picture.tagName.toLowerCase()).toBe('svg');
    expect(picture.getAttribute('role')).toBe('figure');
    expect(picture.getAttribute('aria-label')).not.toBeNull();

    // One named image per frame, named by the sentence its tree row is named
    // by: the hover information is in the accessibility tree, not only in the
    // native tooltip.
    const images = within(picture).getAllByRole('img');
    expect(images).toHaveLength(CHAIN_EVENTS.length);
    for (const event of CHAIN_EVENTS) {
      const frame = frameRectNamed(event.name);
      expect(frame.getAttribute('role')).toBe('img');
      expect(frame.getAttribute('aria-label')).toBe(
        rowNamed(event.name).getAttribute('aria-label'),
      );
      expect(frame.getAttribute('aria-label')?.startsWith(`${event.name} · `)).toBe(true);
    }

    // The axis and the visible labels repeat those names and are hidden.
    expect(picture.querySelector('.dg-flame__axis')?.getAttribute('aria-hidden')).toBe('true');
    const labels = Array.from(picture.querySelectorAll('text.dg-flame__frame-label'));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('names every "+N" mark as an image stating what it gathers', async () => {
    renderComponent(makeNode(), {
      provider: resolvingProvider(crowdedTree()).provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('tree');

    const marks = Array.from(canvas().querySelectorAll('rect.dg-flame__overflow'));
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.getAttribute('role')).toBe('img');
      expect(mark.getAttribute('aria-label')).toBe(mark.querySelector('title')?.textContent);
      expect(mark.getAttribute('aria-label')).toMatch(/listed in the tree below\.$/);
    }
    for (const label of Array.from(canvas().querySelectorAll('text.dg-flame__overflow-label'))) {
      expect(label.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('FlameChart durations that are not measurements', () => {
  it('states a negative or missing duration as n/a in the frame name, its tooltip and its row, and still draws it', async () => {
    renderComponent(makeNode(), {
      provider: resolvingProvider(UNMEASURED_TREE).provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('tree');

    for (const event of [NEGATIVE_CALL_EVENT, UNSET_CALL_EVENT]) {
      // Drawn — the frame still marks where the call began.
      const frame = frameRectNamed(event.name);
      expect(Number(frame.getAttribute('width'))).toBeGreaterThan(0);

      const name = frame.getAttribute('aria-label') ?? '';
      expect(name).toContain(`duration ${NOT_AVAILABLE_LABEL}`);
      expect(name).toContain(`own time ${NOT_AVAILABLE_LABEL}`);
      expect(name).not.toContain(`duration ${formatDuration(0)}`);

      const tooltip = frame.querySelector('title')?.textContent ?? '';
      expect(tooltip).toContain(`Duration ${NOT_AVAILABLE_LABEL}`);
      expect(tooltip).toContain(`Own time ${NOT_AVAILABLE_LABEL}`);

      const row = rowNamed(event.name);
      expect(row.getAttribute('aria-label')).toBe(name);
      expect(figuresOf(row)).toEqual({
        duration: NOT_AVAILABLE_LABEL,
        ownTime: NOT_AVAILABLE_LABEL,
      });
      for (const cell of ownDurationCells(row)) {
        expect(cell.classList.contains('dg-is-unavailable')).toBe(true);
      }
    }

    // The measured root is unaffected.
    expect(figuresOf(rowNamed(UNMEASURED_ROOT_EVENT.name)).duration).toBe(formatDuration(200));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Direction controls in captured text
 *
 * The QA report's payload — an escaped script tag behind a right-to-left
 * override, which a browser draws backwards while `textContent` still holds the
 * logical string — as a frame's name, so it reaches the frame's own label,
 * title and accessible name and, through the ancestry, its child's. Written
 * with escapes, never with the characters.
 * ---------------------------------------------------------------------------
 */

/** A frame name carrying an override and its pop around escaped markup. */
const BIDI_NAME = 'example.QA_BIDI \u202E</td><script>alert(7)</script>\u202C';

/** That name as it must display: both controls as their printable escapes. */
const BIDI_SHOWN = 'example.QA_BIDI \\u202E</td><script>alert(7)</script>\\u202C';

/** A node title carrying the same pair, and how it must display. */
const BIDI_TITLE = 'Flame \u202Etitle\u202C';
const BIDI_TITLE_SHOWN = 'Flame \\u202Etitle\\u202C';

/** The hostile frame's event id, carrying an override that must reach the host raw. */
const BIDI_EVENT_ID = 'event-\u202Eflame-0001';

/** The root whose name carries the payload. */
const BIDI_ROOT_EVENT = makeEvent({
  id: BIDI_EVENT_ID,
  spanId: spanIdFor(1),
  name: BIDI_NAME,
  kind: 'interaction',
  tier: 'browser',
  startTime: BASE_START_MS,
  duration: 120,
  seq: 0,
  ingestSeq: 1,
});

/** Its child, whose ancestry names the hostile root. */
const BIDI_CHILD_EVENT = makeEvent({
  id: 'event-example-0002',
  spanId: spanIdFor(2),
  parentSpanId: spanIdFor(1),
  name: 'example.child',
  kind: 'fetch',
  tier: 'browser',
  startTime: BASE_START_MS + 4,
  duration: 100,
  seq: 1,
  ingestSeq: 2,
});

/**
 * The window frame whose `<title>` opens with `name`.
 *
 * @param name The frame's name as its title shows it.
 * @returns Its `<rect>`.
 */
function frameRectTitled(name: string): Element {
  const rect = Array.from(canvas().querySelectorAll(WINDOW_FRAME_SELECTOR)).find(
    (candidate) => drawnFrameOf(candidate).name === name,
  );

  if (rect === undefined) {
    throw new Error(`the canvas draws no frame titled "${name}"`);
  }

  return rect;
}

/**
 * Asserts nothing in the document displays a raw direction control — not its
 * text, which includes every SVG `<title>` and `<text>`, and not a `title` or
 * `aria-label` — and that the payload's escaped markup never became an element.
 */
function expectNothingReorders(): void {
  const root = document.body;
  expect(containsDirectionControl(root.textContent)).toBe(false);
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of ['title', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (value !== null) {
        expect(containsDirectionControl(value)).toBe(false);
      }
    }
  }
  expect(root.querySelector('script')).toBeNull();
}

describe('FlameChart direction controls in captured text', () => {
  it('draws, names and lists a hostile frame in its logical order, and selects it raw', async () => {
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode({ title: BIDI_TITLE }), {
      provider: resolvingProvider(makeTree([nest([BIDI_ROOT_EVENT, BIDI_CHILD_EVENT])])).provider,
      actions: spies.actions,
    });

    // The tree and the canvas are both named by the revealed node title.
    await screen.findByRole('tree', { name: (name) => name.startsWith(`${BIDI_TITLE_SHOWN}: `) });
    expect(canvas().getAttribute('aria-label')?.startsWith(`${BIDI_TITLE_SHOWN}: `)).toBe(true);

    // The hostile frame's title opens with its revealed name, and its
    // accessible name is the revealed description its tree row carries too.
    const root = frameRectTitled(BIDI_SHOWN);
    const rootName = root.getAttribute('aria-label') ?? '';
    expect(rootName.startsWith(`${BIDI_SHOWN} · `)).toBe(true);
    expect(rowNamed(BIDI_SHOWN).getAttribute('aria-label')).toBe(rootName);

    // The child names its hostile ancestor, revealed, in both carriers.
    const child = frameRectTitled(BIDI_CHILD_EVENT.name);
    expect(child.getAttribute('aria-label')).toContain(`inside ${BIDI_SHOWN}`);
    expect(child.querySelector('title')?.textContent).toContain(`Inside ${BIDI_SHOWN}`);

    // The label drawn on the hostile frame is revealed, whole or cut.
    const labels = Array.from(canvas().querySelectorAll('text.dg-flame__frame-label')).map(
      (label) => label.textContent,
    );
    expect(labels.some((label) => label.startsWith('example.QA_BIDI \\u202E'))).toBe(true);

    expectNothingReorders();

    // Selecting the frame hands the host the raw coordinates of its record.
    await user.click(nameControlOf(rowNamed(BIDI_SHOWN)));
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: BIDI_EVENT_ID,
      spanId: BIDI_ROOT_EVENT.spanId,
      traceId: BIDI_ROOT_EVENT.traceId,
    });

    // The selected row's tooltip and marks are revealed like everything else.
    expectNothingReorders();
  });
});
