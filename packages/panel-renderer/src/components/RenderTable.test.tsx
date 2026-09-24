/**
 * `components/RenderTable` — the colocated suite, and the renderer half of
 * acceptance test 2 (AAP 0.8.4: "render counts and timing per component;
 * trigger attribution (context/props/state) where determinable; component
 * names link to declarations").
 *
 * ## The one thing this suite exists for
 *
 * `tests/e2e/demo-excessive-renders.spec.ts` proves that a generated
 * re-render panel is materially different from a latency panel — a different
 * set of node types over a different capture. What an end-to-end run cannot
 * prove cheaply is the **semantics the panel rests on**, and this table carries
 * the one distinction the whole product's honesty depends on (AAP 0.2.3):
 *
 *   - `unchangedRenderCount` — props were shallow-equal, the component's own
 *     hook state was unchanged and no consumed context value changed. All
 *     three inputs were **evaluated**, and none had changed.
 *   - `unknownTriggerCount` — at least one of those three could **not** be
 *     evaluated, so nothing is claimed.
 *
 * "We checked and nothing changed" is an actionable observation; "we could not
 * check" is the absence of one. A view that added, defaulted or substituted one
 * for the other would turn an unevidenced claim into a headline figure through
 * the renderer rather than through the model — exactly what AAP 0.8.4 forbids
 * of an analysis. The never-merge cases below therefore assert the two figures
 * under their own labels, assert that the full five-member trigger vocabulary
 * is drawn including its zeros (an absent chip cannot say which of "nothing
 * fell in this bucket" and "this bucket is not shown" it means), and assert
 * that **the digit of their sum appears nowhere in the row**.
 *
 * ## The rest of what it pins, in the order the file asserts it
 *
 *  1. **All three states of a query-backed view** (AAP 0.8.3), driven through a
 *     stub `DataProvider`: a promise that never settles, a successful empty
 *     page and a rejection — with the failing query shown verbatim and a retry
 *     that really re-queries. The empty sentence is the wording AAP 0.6.2 gives
 *     this component, asserted exactly.
 *  2. **Rows, figures and column order**: one row per component, counts and
 *     durations formatted by the package's own helpers rather than by literals
 *     restated here, and the ten columns in their display order.
 *  3. **Prop names only, never values** (AAP 0.5.2): the names render, no
 *     control exists to reveal a value, no cell pairs a name with one, and the
 *     expanded row states that values are never captured.
 *  4. **Bounded evidence is declared as bounded** (AAP 0.4.2): the footer says
 *     how much of the result is on screen; "Load more" requests the next page at
 *     exactly the provider's `nextOffset` with an unchanged `limit` and appends
 *     it, de-duplicated, beneath the rows already loaded — past the 5 000-row
 *     page ceiling too, and never without a `nextOffset`; a page beyond the
 *     contract's ceiling is clamped before it is requested; and a row whose
 *     per-render list the producer truncated says so when it is expanded.
 *  5. **The interaction contract**: the very `SourceLocation` a row carries
 *     reaches `onOpenSource` field for field; an individual render selects
 *     itself through `onSelectEvent`; and an **aggregate row selects nothing**,
 *     because it stands for many events and has no id of its own — a
 *     fabricated coordinate would open a details drawer on evidence the reader
 *     never pointed at.
 *  6. **Ordering belongs to the data layer**: rows appear in the provider's own
 *     order, and a sort gesture is a re-query carrying the mapped
 *     `DataQuerySort` rather than a local re-ranking of one page — and it
 *     starts the page sequence over.
 *  7. **Tooltips are reachable from the keyboard** (AAP 0.6.2): every header
 *     description opens when its trigger takes focus and none sits inside a
 *     sortable header's button, and an in-row description is a tab stop only in
 *     the row the reader is standing on.
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`. The `panel-renderer`
 *     project does enable `globals`, but only so `@testing-library/react` can
 *     register its automatic cleanup on a global `afterEach`; every suite in
 *     this repository still names what it uses.
 *   - **`afterEach(cleanup)` registered explicitly**, for the same reason: a
 *     suite that leaks a mounted tree between cases fails later with a
 *     multiple-match error that reads like a component bug.
 *   - **Stub providers are built with the library's own `createDataProvider`**,
 *     so these cases exercise the seam the DevTools panel and the editor
 *     webview implement. Every query the component issues is recorded, because
 *     what it *asked for* is as much of its contract as what it drew.
 *   - **In-file synthetic builders, no fixture files**, and the aggregate
 *     shapes are hand-constructed: {@link makeRenderStat} and
 *     {@link makeOccurrence} never call `aggregateRenders`, so these assertions
 *     stand independent of the aggregation implementation and fail on a
 *     renderer change rather than on a producer change. The vocabularies
 *     themselves (`RENDER_TRIGGERS`, `RENDER_PHASES`) and the row-id prefix are
 *     imported, so no spelling is restated.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): two component names, one
 *     project-relative path, two prop names — none of which belongs to any
 *     application, demonstration or otherwise. `scripts/check-no-hardcoding.mjs`
 *     scans this text with the rest of `packages/**`.
 *   - **Queries by role and accessible name.** The grid, its rows, its cells,
 *     its header controls, the chips and the footer button are all reached that
 *     way; a class or an attribute is read only off an element already obtained
 *     semantically, since no `jest-dom` matcher is available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…` or `waitFor`, and every
 *     interaction through `userEvent`.
 *
 * @see ./RenderTable for the component, its four states and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 * @see ../primitives/DataTable for the grid roles these queries rely on.
 */

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, RenderTableNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { RENDER_PHASES, RENDER_STAT_ID_PREFIX, RENDER_TRIGGERS } from '@debuggen/telemetry';
import type {
  RenderOccurrence,
  RenderPhase,
  RenderPhaseCounts,
  RenderStat,
  RenderTrigger,
  RenderTriggerHistogram,
} from '@debuggen/telemetry';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import {
  formatCount,
  formatDuration,
  formatOffset,
  formatRenderTriggerLabel,
} from '../utils/format';
import { RenderTable } from './RenderTable';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Application-neutral throughout (AAP 0.5.4): the component names, the file
 * path, the symbol and the prop names below belong to no inspected project, and
 * neither do the comments. The identifiers are shaped as a capture shapes them
 * — a 32-hex trace id, 16-hex span ids, epoch-millisecond start times,
 * millisecond durations — because those are the fields this view formats.
 * ---------------------------------------------------------------------------
 */

/** The component most cases draw a row for. */
const WIDGET_COMPONENT = 'ExampleWidget';

/** A second component, so a per-row assertion cannot pass against the wrong row. */
const LIST_COMPONENT = 'ExampleList';

/** A project-relative, POSIX path: the one location a row resolves to. */
const SOURCE_FILE = 'src/example/widget.tsx';

/** The symbol declared at that location. */
const SOURCE_SYMBOL = 'ExampleWidget';

/** Its 1-based coordinates. */
const SOURCE_LINE = 42;
const SOURCE_COLUMN = 7;

/** A complete, resolved location for the source-chip cases. */
const WIDGET_SOURCE: SourceLocation = {
  file: SOURCE_FILE,
  line: SOURCE_LINE,
  column: SOURCE_COLUMN,
  symbol: SOURCE_SYMBOL,
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

/** The accessible name `SourceLink` gives its interactive form. */
const SOURCE_CHIP_NAME = `Open ${SOURCE_FILE}:${String(SOURCE_LINE)}:${String(SOURCE_COLUMN)}`;

/** The fixture trace every render below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Far enough from zero that a relative performance timestamp could not be
 * mistaken for one, which is what makes the "offsets, never wall-clock times"
 * assertion in the expansion cases meaningful.
 */
const BASE_START_MS = 1_767_225_600_000;

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.renderTable';

/** The two prop names a row reports as changed. Names only — see AAP 0.5.2. */
const FIRST_PROP = 'alpha';
const SECOND_PROP = 'beta';

/**
 * Two members of the data layer's sort vocabulary, held as typed constants so a
 * case names the vocabulary rather than a bare string that happens to match it.
 *
 * `count_desc` is the order this view opens in — the question it answers is
 * "how often" — and `duration_desc` is the one a header activation maps to.
 */
const MOST_RENDERS_FIRST: DataQuerySort = 'count_desc';
const LONGEST_TOTAL_FIRST: DataQuerySort = 'duration_desc';

/**
 * The grid's accessible name, which this component fixes rather than taking
 * from the node: spelled out here so the suite pins the name a reader hears.
 */
const GRID_NAME = 'Render statistics per component';

/** The empty sentence AAP 0.6.2 gives this node type, asserted exactly. */
const EMPTY_MESSAGE = 'No renders were captured for this interaction.';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/** The error state's retry control. */
const RETRY_NAME = 'Retry';

/** The footer control that asks for a larger page. */
const LOAD_MORE_NAME = 'Load more';

/** The toolbar's order control. */
const SORT_CONTROL_NAME = 'Order';

/** The disclosure control's two names. */
const EXPAND_NAME = 'Show individual renders';
const COLLAPSE_NAME = 'Hide individual renders';

/** The control that selects one individual render as the panel's evidence. */
const SELECT_OCCURRENCE_NAME = 'Select this render';

/**
 * The columns in display order, by the header each one shows.
 *
 * The list is the suite's coordinate system: a cell is addressed by its
 * column's label (see {@link cellFor}), so a case reads "the figure under
 * `Stable inputs`" instead of "the seventh cell". `Stable inputs` and
 * `Unclassified` are two entries here for the same reason they are two columns
 * in the component — they are different observations (AAP 0.2.3).
 */
const COLUMN_LABELS = [
  'Component',
  'Renders',
  'Total',
  'Average',
  'Longest',
  'Triggers',
  'Stable inputs',
  'Unclassified',
  'Changed props',
  'Phases',
] as const;

/** One column's label. */
type ColumnLabel = (typeof COLUMN_LABELS)[number];

/** The two figure columns whose conflation this suite exists to prevent. */
const STABLE_INPUTS_COLUMN: ColumnLabel = 'Stable inputs';
const UNCLASSIFIED_COLUMN: ColumnLabel = 'Unclassified';

/** The two sortable columns, named by the control their header renders. */
const RENDERS_SORT_NAME: ColumnLabel = 'Renders';
const TOTAL_SORT_NAME: ColumnLabel = 'Total';

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 *
 * Hand-constructed aggregates, never computed ones: nothing below calls
 * `aggregateRenders` or `summarizeRenderTriggers`, so a change in how the
 * producer folds events into rows cannot silently change what these cases
 * assert about the renderer.
 * ---------------------------------------------------------------------------
 */

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/**
 * A trigger histogram over the whole vocabulary, zero-filled.
 *
 * Written key by key rather than derived, so the compiler requires an entry for
 * every member: a member added to `RENDER_TRIGGERS` fails to compile here,
 * beside the fixture that has to grow. `triggersCoverTheVocabulary` below is
 * the runtime half of the same guarantee.
 *
 * @param counts The buckets that are not zero.
 * @returns A complete histogram.
 */
function makeTriggers(counts: Partial<Record<RenderTrigger, number>> = {}): RenderTriggerHistogram {
  return {
    props: counts.props ?? 0,
    state: counts.state ?? 0,
    context: counts.context ?? 0,
    unchanged: counts.unchanged ?? 0,
    unknown: counts.unknown ?? 0,
  };
}

/**
 * Phase counts over the whole commit vocabulary, zero-filled, on the same terms
 * as {@link makeTriggers}.
 *
 * @param counts The buckets that are not zero.
 * @returns Complete phase counts.
 */
function makePhases(counts: Partial<Record<RenderPhase, number>> = {}): RenderPhaseCounts {
  return {
    mount: counts.mount ?? 0,
    update: counts.update ?? 0,
  };
}

/**
 * The optional fields of an occurrence admit `undefined` explicitly, which
 * `Partial` does not under this repository's `exactOptionalPropertyTypes`:
 * passing `{ source: undefined }` is how a case asks for a render *without* a
 * location, and {@link makeOccurrence} drops the key rather than storing it.
 */
type OccurrenceOverrides = Partial<
  Pick<
    RenderOccurrence,
    'id' | 'eventId' | 'spanId' | 'traceId' | 'startTime' | 'durationMs' | 'trigger'
  >
> & {
  readonly phase?: RenderPhase | undefined;
  readonly changedPropKeys?: readonly string[] | undefined;
  readonly source?: SourceLocation | undefined;
};

/**
 * One observed render, as the `renders` aggregate reports it inside a row.
 *
 * `id` defaults to `eventId`, which is the contract the aggregate keeps (the
 * row identity of an occurrence *is* its event id), so the selection case can
 * assert that the reference the host receives names that event and nothing
 * invented.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh occurrence; nothing is shared between calls.
 */
function makeOccurrence(overrides: OccurrenceOverrides = {}): RenderOccurrence {
  const {
    eventId = 'event-example-0001',
    spanId = spanIdFor(1),
    traceId = TRACE_ID,
    startTime = BASE_START_MS,
    durationMs = 12,
    trigger = 'props',
    phase = 'update',
    changedPropKeys = [FIRST_PROP],
    source,
  } = overrides;

  return {
    id: overrides.id ?? eventId,
    eventId,
    spanId,
    traceId,
    startTime,
    durationMs,
    trigger,
    phase,
    changedPropKeys,
    ...(source === undefined ? {} : { source }),
  };
}

/** Overrides accepted by {@link makeRenderStat}, with the same `undefined` policy. */
type RenderStatOverrides = Partial<
  Pick<
    RenderStat,
    | 'id'
    | 'component'
    | 'renderCount'
    | 'totalDurationMs'
    | 'averageDurationMs'
    | 'maxDurationMs'
    | 'firstStartTime'
    | 'lastStartTime'
    | 'triggers'
    | 'unchangedRenderCount'
    | 'unknownTriggerCount'
    | 'phaseCounts'
    | 'changedPropKeys'
    | 'changedPropCounts'
    | 'occurrences'
    | 'occurrencesTruncated'
  >
> & {
  readonly source?: SourceLocation | undefined;
};

/**
 * One component's render statistics, complete and internally consistent.
 *
 * Two defaults encode invariants the aggregate publishes rather than numbers
 * chosen for convenience, so a fixture cannot quietly assert something the
 * producer would never emit:
 *
 *   - `id` is the aggregate's own deterministic identity, the imported prefix
 *     followed by the component name;
 *   - `unchangedRenderCount` and `unknownTriggerCount` default to the matching
 *     buckets of `triggers`, which is exactly what the aggregate guarantees
 *     (`RenderStat.unchangedRenderCount` *is* `triggers.unchanged`) — and they
 *     stay overridable so a case can hand the component a row that disagrees
 *     with itself and watch it print what it was given rather than a repair.
 *
 * The default row reports counts only, with no per-render list and
 * `occurrencesTruncated: true`, which is what the service answers when
 * occurrences were not requested; the expansion cases supply their own.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh row; nothing is shared between calls.
 */
function makeRenderStat(overrides: RenderStatOverrides = {}): RenderStat {
  const {
    component = WIDGET_COMPONENT,
    renderCount = 12,
    totalDurationMs = 480,
    averageDurationMs = 40,
    maxDurationMs = 96,
    firstStartTime = BASE_START_MS,
    lastStartTime = BASE_START_MS + 900,
    triggers = makeTriggers({ props: 4, state: 2, context: 1, unchanged: 3, unknown: 2 }),
    phaseCounts = makePhases({ mount: 1, update: 11 }),
    changedPropKeys = [FIRST_PROP, SECOND_PROP],
    changedPropCounts = { [FIRST_PROP]: 4, [SECOND_PROP]: 2 },
    occurrences = [],
    occurrencesTruncated = true,
    source,
  } = overrides;

  return {
    id: overrides.id ?? `${RENDER_STAT_ID_PREFIX}${component}`,
    component,
    renderCount,
    totalDurationMs,
    averageDurationMs,
    maxDurationMs,
    firstStartTime,
    lastStartTime,
    triggers,
    unchangedRenderCount: overrides.unchangedRenderCount ?? triggers.unchanged,
    unknownTriggerCount: overrides.unknownTriggerCount ?? triggers.unknown,
    phaseCounts,
    changedPropKeys,
    changedPropCounts,
    occurrences,
    occurrencesTruncated,
    ...(source === undefined ? {} : { source }),
  };
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<RenderTableNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `renderTable` node, as the panel normaliser produces one: an id,
 * no heading (the host's section owns that) and a query whose source and
 * ordering are already explicit.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): RenderTableNode {
  const {
    id = NODE_ID,
    query = { source: 'renders', sort: MOST_RENDERS_FIRST },
    title,
    description,
  } = overrides;

  return {
    type: 'renderTable',
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
 * exactly this shape: one resolver answering every query. It brings the single
 * type assertion the generic `DataProvider.query` signature would otherwise
 * force into this file, and its own check that a response answers for the
 * source it was asked about.
 * ---------------------------------------------------------------------------
 */

/** One page a stub provider can answer with. */
interface RenderPage {
  /** The rows of the page, in the order the service returned them. */
  readonly data: readonly RenderStat[];

  /** The total the service reports for the whole query, when it reports one. */
  readonly total?: number | undefined;

  /** The offset of the next page, when one exists. */
  readonly nextOffset?: number | undefined;
}

/** A stub provider, the queries it has received and the resolver behind it. */
interface StubProvider {
  /** The provider to hand to {@link renderComponent}. */
  readonly provider: DataProvider;

  /**
   * Every query the component has asked for, in call order — the assertion
   * surface for the paging, ordering and clamping cases.
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
 * A provider that answers each successive call with the next page, repeating
 * the last one once the list is exhausted.
 *
 * The builder the ordering and paging cases need: a re-query has to be able to
 * answer differently from the query before it, or "the rows follow the second
 * response" could not be told from "the rows were re-ordered in the browser".
 *
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(pages: readonly RenderPage[]): StubProvider {
  return recordingProvider((_query, call) => {
    const page = pages[Math.min(call, pages.length) - 1];

    if (page === undefined) {
      throw new Error('the stub provider was built with no pages');
    }

    return Promise.resolve<DataQueryResponse>({
      source: 'renders',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    });
  });
}

/**
 * A provider that resolves one page for every query.
 *
 * @param data The rows of the page, in the order they should be drawn.
 * @param extra The paging counters to report, if any.
 * @returns The stub provider.
 */
function resolvingProvider(
  data: readonly RenderStat[],
  extra: Omit<RenderPage, 'data'> = {},
): StubProvider {
  return pagingProvider([{ data, ...extra }]);
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
 * implementation for: the code it carries is what the error state renders
 * (AAP 0.5.5).
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

  /** The disclosure spy. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** The order-report spy. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies: both required members and both optional ones.
 *
 * All four are supplied so that every case can assert not only that the intent
 * it exercised was raised, but also that the others were not — activating a
 * source chip must not also select an event, and selecting a render must not
 * report an order change.
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
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 */
function renderComponent(
  node: RenderTableNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <RenderTable node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );
}

/**
 * The grid's data rows, in document order.
 *
 * Obtained by role and then narrowed by the attribute the primitive writes on a
 * data row, because the header row and any open detail row are `role="row"` too
 * and a bare role query would count them.
 *
 * @returns The data rows.
 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-row-index') !== null);
}

/**
 * The open detail rows, in document order.
 *
 * Narrowed by the class `../primitives/DataTable` declares for the detail row
 * it fills from `renderExpandedRow`, which is the only thing that distinguishes
 * it from the header row — both are `role="row"` without a row index.
 *
 * @returns The detail rows of whichever rows are expanded.
 */
function detailRows(): HTMLElement[] {
  return screen
    .getAllByRole('row')
    .filter((row) => row.classList.contains('dg-data-table__expanded'));
}

/**
 * The component name of each data row, in document order.
 *
 * Read off the row's header cell — obtained by role — and then from the
 * component's own name element inside it, so a row carrying a source chip
 * contributes its component name and nothing else.
 *
 * @returns One name per row.
 */
function renderedNames(): string[] {
  return dataRows().map((row) => {
    const header = within(row).getByRole('rowheader');

    return header.querySelector('.dg-render-table__component-cell')?.textContent ?? '';
  });
}

/**
 * The data row whose component name is `component`.
 *
 * @param component The component name to find.
 * @returns That row.
 */
function rowFor(component: string): HTMLElement {
  const row = dataRows()[renderedNames().indexOf(component)];

  if (row === undefined) {
    throw new Error(`no rendered row is named "${component}"`);
  }

  return row;
}

/**
 * The cells of one data row, in column order.
 *
 * The identity column is a `rowheader` and the other nine are `gridcell`s, so
 * the two role queries are concatenated in that order — which is the columns'
 * own order, since the identity column is the leftmost.
 *
 * @param row The data row.
 * @returns Its ten cells.
 */
function cellsOf(row: HTMLElement): HTMLElement[] {
  return [...within(row).getAllByRole('rowheader'), ...within(row).getAllByRole('gridcell')];
}

/**
 * The cell of one data row under the column with the given header.
 *
 * @param row The data row.
 * @param label The column's header, from {@link COLUMN_LABELS}.
 * @returns That cell.
 */
function cellFor(row: HTMLElement, label: ColumnLabel): HTMLElement {
  const cell = cellsOf(row)[COLUMN_LABELS.indexOf(label)];

  if (cell === undefined) {
    throw new Error(`the row has no cell under "${label}"`);
  }

  return cell;
}

/**
 * The header cell of the column with the given header text.
 *
 * Matched by prefix rather than by equality: five of the ten headers carry a
 * `Tooltip`, whose content stays in the accessibility tree while it is closed,
 * so the cell's text is its label followed by its description.
 *
 * @param label The column's header, from {@link COLUMN_LABELS}.
 * @returns That header cell.
 */
function headerFor(label: ColumnLabel): HTMLElement {
  const header = screen
    .getAllByRole('columnheader')
    .find((cell) => (cell.textContent ?? '').startsWith(label));

  if (header === undefined) {
    throw new Error(`no column is headed "${label}"`);
  }

  return header;
}

/**
 * The `aria-sort` a sortable column reports.
 *
 * Read off the header CELL rather than off the control inside it, which is
 * where `../primitives/DataTable` writes it: a reader asks the column how it is
 * sorted, not the button.
 *
 * @param label The sortable column's header.
 * @returns Its reported ordering.
 */
function ariaSortOf(label: ColumnLabel): string | null {
  const cell = screen.getByRole('button', { name: label }).closest('[role="columnheader"]');

  if (cell === null) {
    throw new Error(`the control named "${label}" is not inside a column header`);
  }

  return cell.getAttribute('aria-sort');
}

/**
 * The toolbar's order control, narrowed to the element type its value is read
 * from.
 *
 * @returns The `<select>` the `Toolbar` rendered.
 */
function orderControl(): HTMLSelectElement {
  const control = screen.getByRole('combobox', { name: SORT_CONTROL_NAME });

  if (!(control instanceof HTMLSelectElement)) {
    throw new Error('the order control is not a select element');
  }

  return control;
}

/** The single query a stub provider received, failing when it received another count. */
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

/**
 * The detail row of the one row that is expanded.
 *
 * @returns That detail row.
 */
function onlyDetailRow(): HTMLElement {
  const rows = detailRows();

  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('no row is expanded');
  }

  return row;
}

/*
 * ---------------------------------------------------------------------------
 * The rows most cases draw
 *
 * Distinct component names, distinct counts and, within each row, three
 * distinct durations, so a per-row assertion cannot pass by matching another
 * row or another column. Neither row's rendered text contains the digit `5`,
 * which is what lets the never-merge case assert the absence of the sum of its
 * two figures rather than merely the presence of each.
 *
 * Deliberately NOT in count order: the ordering cases render them exactly as
 * the provider hands them over.
 * ---------------------------------------------------------------------------
 */

/**
 * A component with a mixed trigger histogram: four renders with changed props,
 * two with changed state, one with a changed context value, three with stable
 * inputs and two that could not be classified — twelve in all.
 */
const WIDGET_ROW = makeRenderStat();

/** A second component, quieter, reporting no prop changes at all. */
const LIST_ROW = makeRenderStat({
  component: LIST_COMPONENT,
  renderCount: 4,
  totalDurationMs: 64,
  averageDurationMs: 16,
  maxDurationMs: 24,
  triggers: makeTriggers({ props: 2, state: 1, unchanged: 1 }),
  phaseCounts: makePhases({ mount: 1, update: 3 }),
  changedPropKeys: [],
  changedPropCounts: {},
});

/** The two rows in the order the provider returns them below. */
const PROVIDER_ORDER: readonly RenderStat[] = [LIST_ROW, WIDGET_ROW];

/** Their component names, in that same order. */
const PROVIDER_ORDER_NAMES: readonly string[] = PROVIDER_ORDER.map((stat) => stat.component);

describe('RenderTable states', () => {
  it('renders the loading state, and no rows, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes the
    // element class that places it and the label it announces.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.classList.contains('dg-render-table__loading')).toBe(true);
    expect(within(busy).getByText(/loading render statistics/i)).toBeDefined();

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

    // One query, issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders the empty sentence for this node, and no rows, for a successful empty page', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The exact wording AAP 0.6.2 gives this component: generic product
    // vocabulary that names the class of evidence and says the capture holds
    // none of it, and no inspected project (AAP 0.5.4).
    const message = await screen.findByText(EMPTY_MESSAGE);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);

    for (const name of PROVIDER_ORDER_NAMES) {
      expect(message.textContent).not.toContain(name);
    }
    expect(message.textContent).not.toContain(SOURCE_FILE);

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure — and there is no grid to hold rows, and no order control, since
    // reordering nothing is a control that cannot act.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('combobox', { name: SORT_CONTROL_NAME })).toBeNull();
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-render-table__error')).toBe(true);

    // What failed, and the provider's code so a developer can act on it. The
    // sentence states the failure and never what it might mean (AAP 0.5.5).
    expect(within(alert).getByText(/could not be loaded/i)).toBeDefined();
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, and compared as a value rather
    // than as a spelling. `limit` is the contract's published default because
    // the node authored none; `offset` is absent for the same reason — the side
    // that resolves the query applies that default, and this view invents none.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'renders',
      sort: MOST_RENDERS_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
    });

    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The retry an error state offers is only useful if it really re-queries.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual(queryOfCall(stub, 1));

    // No rows were invented behind the failure.
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
});

describe('RenderTable rows', () => {
  it('draws one row per component, with its counts, its timing and its phases', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The grid is named by this component's own caption rather than by the
    // node, so the name a reader hears is the same in every panel that uses it.
    await screen.findByRole('grid', { name: GRID_NAME });
    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);

    // Ten columns, in display order. Matched by prefix because five of the
    // headers carry a description that stays in the accessibility tree.
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(COLUMN_LABELS.length);
    COLUMN_LABELS.forEach((label, index) => {
      expect(headers[index]?.textContent ?? '').toMatch(new RegExp(`^${label}`));
    });

    for (const stat of PROVIDER_ORDER) {
      const row = rowFor(stat.component);

      // The identity cell is the row's header, so a reader hears the row named.
      expect(cellFor(row, 'Component')).toBe(within(row).getByRole('rowheader'));

      // The count, formatted by the package's own helper. With two rows there
      // is no distribution to stand out from, so the figure carries no outlier
      // mark and the cell is the number alone.
      expect(cellFor(row, 'Renders').textContent).toBe(formatCount(stat.renderCount));

      // Three durations, each scaled and carrying its unit.
      const total = within(row).getByText(formatDuration(stat.totalDurationMs));
      expect(total.classList.contains('dg-duration-cell')).toBe(true);
      expect(within(row).getByText(formatDuration(stat.averageDurationMs))).toBeDefined();
      expect(within(row).getByText(formatDuration(stat.maxDurationMs))).toBeDefined();

      // Both commit phases are drawn, zeros included, over the whole
      // vocabulary — so a bucket is never inferred from a missing chip.
      const phases = cellFor(row, 'Phases');
      for (const phase of RENDER_PHASES) {
        expect(
          within(phases).getByText(`${phase} ${formatCount(stat.phaseCounts[phase])}`),
        ).toBeDefined();
      }

      // Epoch milliseconds are a time base, not text a reader is shown.
      expect(row.textContent).not.toContain(String(stat.firstStartTime));
      expect(row.textContent).not.toContain(String(stat.lastStartTime));
    }

    // One literal, to prove a duration is rendered as a scaled quantity rather
    // than as the raw millisecond number the aggregate carried.
    expect(within(rowFor(WIDGET_COMPONENT)).getByText('480.00 ms')).toBeDefined();

    // The toolbar reports the order that was actually applied.
    expect(orderControl().value).toBe(MOST_RENDERS_FIRST);
  });

  it('marks a count that stands out from the loaded page, and explains the mark', async () => {
    // Four rows, so there is a distribution to stand out from: three components
    // rendered twice and one forty times. The threshold is derived from the
    // loaded page rather than fixed, because what counts as a lot of renders
    // depends entirely on the interaction.
    const quiet = ['ExampleCard', 'ExamplePanel', LIST_COMPONENT].map((component) =>
      makeRenderStat({
        component,
        renderCount: 2,
        totalDurationMs: 24,
        averageDurationMs: 12,
        maxDurationMs: 16,
        triggers: makeTriggers({ props: 1, unchanged: 1 }),
        phaseCounts: makePhases({ mount: 1, update: 1 }),
      }),
    );
    const loud = makeRenderStat({ renderCount: 40, totalDurationMs: 1_600 });
    const stub = resolvingProvider([loud, ...quiet]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // The marked figure, obtained by its text inside its own column's cell.
    const marked = cellFor(rowFor(WIDGET_COMPONENT), 'Renders');
    const figure = within(marked).getByText(formatCount(loud.renderCount));
    expect(figure.classList.contains('dg-render-table__count-cell')).toBe(true);
    expect(figure.classList.contains('dg-is-outlier')).toBe(true);

    // Not by colour alone: a glyph carries the mark on a monochrome surface,
    // and the cell states what the mark means rather than passing a heuristic
    // off as a verdict.
    expect(figure.querySelector('.dg-icon')).not.toBeNull();
    expect(marked.textContent ?? '').toMatch(/median of the loaded rows/i);

    // And no quiet row is marked: their cells are the figure and nothing else.
    for (const stat of quiet) {
      const cell = cellFor(rowFor(stat.component), 'Renders');
      expect(cell.textContent).toBe(formatCount(stat.renderCount));
      expect(within(cell).getByText(formatCount(stat.renderCount)).classList).not.toContain(
        'dg-is-outlier',
      );
    }
  });

  it('forces its own source onto the query, whatever source the node named', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    // A node that reached a renderer has been validated against the catalog,
    // whose `renderTable` entry permits one source. A malformed one must not
    // make this view ask the provider for a shape it could not draw.
    renderComponent(makeNode({ query: { source: 'spans', sort: MOST_RENDERS_FIRST } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(soleQuery(stub).source).toBe('renders');
  });
});

describe('RenderTable trigger attribution', () => {
  it('keeps stable-input renders and unclassified renders apart, and never adds them', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);
    const stable = cellFor(row, STABLE_INPUTS_COLUMN);
    const unclassified = cellFor(row, UNCLASSIFIED_COLUMN);

    // Two figures, two columns, two meanings (AAP 0.2.3): three renders were
    // observed to have stable inputs, and two could not be classified at all.
    expect(stable.textContent).toBe(formatCount(WIDGET_ROW.unchangedRenderCount));
    expect(unclassified.textContent).toBe(formatCount(WIDGET_ROW.unknownTriggerCount));
    expect(stable.textContent).not.toBe(unclassified.textContent);

    // And their sum is nowhere on the row. The fixture's every other figure is
    // free of this digit, so the assertion covers the columns above as well as
    // these two: a view that reported `unchanged + unknown` under either
    // heading, or that defaulted one to the other, fails here.
    const merged = formatCount(WIDGET_ROW.unchangedRenderCount + WIDGET_ROW.unknownTriggerCount);
    for (const cell of cellsOf(row)) {
      expect((cell.textContent ?? '').trim()).not.toBe(merged);
    }
    expect(row.textContent).not.toContain(merged);

    // The histogram beside them states both buckets separately, each as its own
    // chip carrying its own vocabulary member.
    const triggers = cellFor(row, 'Triggers');
    expect(
      within(triggers)
        .getByText(`unchanged ${formatCount(WIDGET_ROW.triggers.unchanged)}`)
        .getAttribute('data-trigger'),
    ).toBe('unchanged');
    expect(
      within(triggers)
        .getByText(`unknown ${formatCount(WIDGET_ROW.triggers.unknown)}`)
        .getAttribute('data-trigger'),
    ).toBe('unknown');

    // Each column states its own definition in full rather than leaving the
    // difference to be inferred from two adjacent words.
    expect(headerFor(STABLE_INPUTS_COLUMN).textContent ?? '').toMatch(/none of them had changed/i);

    const unclassifiedHeader = headerFor(UNCLASSIFIED_COLUMN).textContent ?? '';
    expect(unclassifiedHeader).toMatch(/could not be evaluated/i);
    expect(unclassifiedHeader).toMatch(/never as a stable-input render/i);
  });

  it('draws every trigger bucket, including the ones that are zero', async () => {
    // One component whose renders all had changed props: four of the five
    // buckets are empty, and an absent chip could not say whether the bucket
    // was empty or merely not shown — for `unchanged` and `unknown` those two
    // readings support opposite conclusions (AAP 0.2.3).
    const stat = makeRenderStat({
      renderCount: 6,
      totalDurationMs: 72,
      averageDurationMs: 12,
      maxDurationMs: 20,
      triggers: makeTriggers({ props: 6 }),
      phaseCounts: makePhases({ mount: 1, update: 5 }),
    });
    const stub = resolvingProvider([stat]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const triggers = cellFor(rowFor(WIDGET_COMPONENT), 'Triggers');

    // The vocabulary is five members, and the fixture builder covers it in
    // full, so "all five buckets" below is the vocabulary's own five rather
    // than a number this suite chose.
    expect(RENDER_TRIGGERS).toHaveLength(5);
    expect(Object.keys(makeTriggers()).toSorted()).toEqual([...RENDER_TRIGGERS].toSorted());

    for (const trigger of RENDER_TRIGGERS) {
      const chip = within(triggers).getByText(`${trigger} ${formatCount(stat.triggers[trigger])}`);
      expect(chip.getAttribute('data-trigger')).toBe(trigger);
    }

    // Five chips and no more, so no bucket is drawn twice and none is folded
    // into another.
    expect(within(triggers).getAllByText(/^[a-z]+ \d+$/)).toHaveLength(RENDER_TRIGGERS.length);

    // The two that matter are present as explicit zeros.
    expect(within(triggers).getByText(`unchanged ${formatCount(0)}`)).toBeDefined();
    expect(within(triggers).getByText(`unknown ${formatCount(0)}`)).toBeDefined();

    // And the two figure columns agree with them, still separately.
    const row = rowFor(WIDGET_COMPONENT);
    expect(cellFor(row, STABLE_INPUTS_COLUMN).textContent).toBe(formatCount(0));
    expect(cellFor(row, UNCLASSIFIED_COLUMN).textContent).toBe(formatCount(0));
  });

  it('prints the figures a row reports rather than recomputing them from the histogram', async () => {
    // A row that disagrees with itself — the aggregate guarantees these two
    // fields equal the matching buckets, so this can only arrive from a stored
    // row written by another build. The view states what it was given: a
    // renderer that "repaired" it would be inventing a count, and one that
    // filled a missing figure from the other bucket would be committing exactly
    // the conflation this table exists to prevent.
    const stat = makeRenderStat({
      triggers: makeTriggers({ props: 4, state: 2, context: 1, unchanged: 3, unknown: 2 }),
      unchangedRenderCount: 1,
      unknownTriggerCount: 0,
    });
    const stub = resolvingProvider([stat]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);
    expect(cellFor(row, STABLE_INPUTS_COLUMN).textContent).toBe(formatCount(1));
    expect(cellFor(row, UNCLASSIFIED_COLUMN).textContent).toBe(formatCount(0));

    // The histogram is still the histogram it was handed.
    const triggers = cellFor(row, 'Triggers');
    expect(within(triggers).getByText(`unchanged ${formatCount(3)}`)).toBeDefined();
    expect(within(triggers).getByText(`unknown ${formatCount(2)}`)).toBeDefined();
  });
});

describe('RenderTable changed props', () => {
  it('lists prop names, with no value and no way to ask for one', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const cell = cellFor(rowFor(WIDGET_COMPONENT), 'Changed props');

    // Names, which is all the producer sends: the fiber diff reports key names
    // and change counts and never a value, and opt-in full values are not
    // implemented (AAP 0.5.2).
    expect(within(cell).getByText(FIRST_PROP)).toBeDefined();
    expect(within(cell).getByText(SECOND_PROP)).toBeDefined();

    // No name is paired with anything, so nothing in this cell can be read as a
    // value: no assignment, no colon, no quoted text.
    expect(cell.textContent ?? '').not.toMatch(/[=:"']/);

    // And no affordance offers one — not in the cell, and not anywhere in the
    // view. A control that promised a value could only ever fail to deliver it.
    expect(within(cell).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /value/i })).toBeNull();
    expect(screen.queryByText(/show (the )?full value/i)).toBeNull();
  });

  it('says a row reported no prop changes instead of leaving the cell blank', async () => {
    const stub = resolvingProvider([LIST_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // An empty list means "nothing was reported", which is not the same claim
    // as "nothing changed" — so the cell says the first and never the second.
    const cell = cellFor(rowFor(LIST_COMPONENT), 'Changed props');
    expect(within(cell).getByText(/no prop changes reported/i)).toBeDefined();
  });

  it('states that values are never captured, and lists names with counts, when a row is expanded', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    await user.click(within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: EXPAND_NAME }));

    const detail = onlyDetailRow();

    // The expansion says what its prop list is, so its length is never read as
    // the width of a props object (AAP 0.5.2).
    expect(within(detail).getByText(/prop values are never captured/i)).toBeDefined();

    // Every reported name, with the number of renders it changed at — and
    // nothing else: each chip is the name followed by its count.
    for (const key of WIDGET_ROW.changedPropKeys) {
      const count = WIDGET_ROW.changedPropCounts[key];
      expect(count).toBeDefined();

      const chip = within(detail).getByText(new RegExp(`^${key}\\b`));
      expect(chip.textContent ?? '').toMatch(
        new RegExp(`^${key}\\b\\D*${formatCount(count ?? 0)}$`),
      );
      expect(chip.textContent ?? '').not.toMatch(/[=:"']/);
    }
  });
});

describe('RenderTable expansion', () => {
  /** Two individual renders of one component, 320 ms apart. */
  const OCCURRENCES: readonly RenderOccurrence[] = [
    makeOccurrence({
      eventId: 'event-example-0001',
      spanId: spanIdFor(1),
      startTime: BASE_START_MS,
      durationMs: 12,
      trigger: 'props',
      phase: 'mount',
    }),
    makeOccurrence({
      eventId: 'event-example-0002',
      spanId: spanIdFor(2),
      startTime: BASE_START_MS + 320,
      durationMs: 24,
      trigger: 'unchanged',
      phase: 'update',
      changedPropKeys: [],
    }),
  ];

  /** A row whose per-render list is complete: two renders, two occurrences. */
  const COMPLETE_ROW = makeRenderStat({
    renderCount: 2,
    totalDurationMs: 36,
    averageDurationMs: 18,
    maxDurationMs: 24,
    triggers: makeTriggers({ props: 1, unchanged: 1 }),
    phaseCounts: makePhases({ mount: 1, update: 1 }),
    changedPropKeys: [FIRST_PROP],
    changedPropCounts: { [FIRST_PROP]: 1 },
    occurrences: OCCURRENCES,
    occurrencesTruncated: false,
  });

  it('reports the disclosure to the host and lists the individual renders', async () => {
    const stub = resolvingProvider([COMPLETE_ROW]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(detailRows()).toHaveLength(0);

    await user.click(within(row).getByRole('button', { name: EXPAND_NAME }));

    // The state after the gesture, with this node's id and the row's own id, so
    // a host with two render tables can tell them apart and persist either.
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
    expect(spies.onExpand).toHaveBeenCalledWith(NODE_ID, COMPLETE_ROW.id, true);

    const detail = onlyDetailRow();
    expect(rowFor(WIDGET_COMPONENT).getAttribute('aria-expanded')).toBe('true');

    // The list says how much of the component's work it holds, and this row's
    // list is complete, so no truncation note is shown.
    expect(within(detail).getByText(/individual renders/i)).toBeDefined();
    expect(within(detail).getByText(/listing 2 of 2 renders/i)).toBeDefined();
    expect(within(detail).queryByText(/not every render is listed/i)).toBeNull();

    // One row per render, each offset from the component's own first observed
    // render rather than stamped with a wall-clock time.
    for (const occurrence of OCCURRENCES) {
      expect(
        within(detail).getByText(formatOffset(occurrence.startTime, COMPLETE_ROW.firstStartTime)),
      ).toBeDefined();
      expect(within(detail).getByText(formatDuration(occurrence.durationMs))).toBeDefined();
    }
    expect(detail.textContent).not.toContain(String(BASE_START_MS));
    expect(within(detail).getAllByRole('button', { name: SELECT_OCCURRENCE_NAME })).toHaveLength(
      OCCURRENCES.length,
    );

    // Each render states its own trigger, in the same vocabulary the histogram
    // uses — including the one that means "stable inputs".
    expect(within(detail).getByText('props')).toBeDefined();
    expect(within(detail).getByText('unchanged')).toBeDefined();

    // Collapsing is reported as the state it produced, not as a toggle.
    await user.click(within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: COLLAPSE_NAME }));

    expect(spies.onExpand).toHaveBeenCalledTimes(2);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, COMPLETE_ROW.id, false);
    expect(detailRows()).toHaveLength(0);

    // A disclosure is not a query: the page on screen is the page that was
    // resolved, and expanding it asked the provider for nothing.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('says outright when the producer bounded a row per-render list', async () => {
    // Twelve renders, two of them listed: the producer's own bound. An
    // expansion that silently showed a prefix would invite the reader to count
    // renders that are not there (AAP 0.4.2).
    const truncated = makeRenderStat({
      occurrences: OCCURRENCES,
      occurrencesTruncated: true,
    });
    const stub = resolvingProvider([truncated]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: EXPAND_NAME }));

    const detail = onlyDetailRow();
    expect(within(detail).getByText(/listing 2 of 12 renders/i)).toBeDefined();
    expect(within(detail).getByText(/not every render is listed/i)).toBeDefined();
  });

  it('says a row carrying counts reported no individual renders at all', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: EXPAND_NAME }));

    const detail = onlyDetailRow();
    expect(within(detail).getByText(/no individual renders were reported/i)).toBeDefined();
    expect(within(detail).queryAllByRole('button', { name: SELECT_OCCURRENCE_NAME })).toHaveLength(
      0,
    );
  });
});

describe('RenderTable interactions', () => {
  it('hands the host the very location a component resolved to, and selects nothing', async () => {
    const located = makeRenderStat({ source: WIDGET_SOURCE });
    const stub = resolvingProvider([located]);
    const spies = makeActions();
    const user = userEvent.setup();

    // Taken BEFORE the render and compared afterwards: comparing the emitted
    // object's keys against the live fixture alone would be satisfied by a
    // component that added a field to it in place.
    const expectedKeys = Object.keys({ ...WIDGET_SOURCE }).toSorted();

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
    expect(received).toEqual(WIDGET_SOURCE);
    expect(Object.keys(received).toSorted()).toEqual(expectedKeys);
    expect(received.file).toBe(SOURCE_FILE);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.line).toBe(SOURCE_LINE);
    expect(received.column).toBe(SOURCE_COLUMN);
    expect(received.symbol).toBe(SOURCE_SYMBOL);

    // Opening a declaration is not selecting evidence, and not expanding a row:
    // the chip's activation stops at the chip.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('draws no chip for a component the capture could not resolve to a location', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);
    expect(within(row).queryByRole('button', { name: /^Open / })).toBeNull();
    expect(row.textContent).not.toContain(SOURCE_FILE);
  });

  it('selects an individual render as the one captured event it stands for', async () => {
    const occurrence = makeOccurrence({
      eventId: 'event-example-0007',
      spanId: spanIdFor(7),
      startTime: BASE_START_MS + 48,
      durationMs: 16,
      trigger: 'context',
    });
    const stat = makeRenderStat({
      renderCount: 1,
      totalDurationMs: 16,
      averageDurationMs: 16,
      maxDurationMs: 16,
      triggers: makeTriggers({ context: 1 }),
      phaseCounts: makePhases({ update: 1 }),
      occurrences: [occurrence],
      occurrencesTruncated: false,
    });
    const stub = resolvingProvider([stat]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: EXPAND_NAME }));

    const detail = onlyDetailRow();
    await user.click(within(detail).getByRole('button', { name: SELECT_OCCURRENCE_NAME }));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    const ref = call[0];

    // Every coordinate is that render's own, and there are exactly three of
    // them: nothing is synthesised, and nothing is dropped.
    expect(ref).toEqual({
      eventId: occurrence.eventId,
      spanId: occurrence.spanId,
      traceId: occurrence.traceId,
    });
    expect(Object.keys(ref).toSorted()).toEqual(['eventId', 'spanId', 'traceId']);

    // Selecting a render is not opening its declaration.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('raises no selection for an aggregate row, which stands for many renders', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);

    // A row of counts has no single event id. Activating it must therefore do
    // nothing at all rather than nominate a representative render: a
    // fabricated coordinate opens a details drawer on evidence the reader did
    // not point at, which is worse than an absent one.
    await user.click(row);

    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    // And the row claims no selected state, because this view offers none.
    expect(row.getAttribute('aria-selected')).toBeNull();
  });
});

describe('RenderTable ordering', () => {
  it('renders rows in the order the provider returned them, without re-ranking', async () => {
    // The page is deliberately not in count order (4 renders, then 12) while
    // the node asks for `count_desc`: the service applied the ordering it was
    // given (AAP 0.4.2), so a component that re-ranked the page locally would
    // show an order no response ever reported — and would rank a page against a
    // total it is only part of.
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);

    // Stated as a property too, so the intent survives a fixture change: the
    // rendered order is not the count ranking.
    const counts = PROVIDER_ORDER.map((stat) => stat.renderCount);
    expect(counts).not.toEqual(counts.toSorted((left, right) => right - left));
  });

  it('turns a header activation into a new query and follows the response', async () => {
    // Two pages: the node's own `count_desc` ordering, then whatever the
    // service returns for `duration_desc`. The second page is a different order
    // of the same rows, which is the only way to tell "the rows follow the new
    // response" from "the rows were re-ordered in the browser".
    const reordered: readonly RenderStat[] = [WIDGET_ROW, LIST_ROW];
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: reordered }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
    expect(soleQuery(stub).sort).toBe(MOST_RENDERS_FIRST);

    // The grid reports the ordering that was applied, on the column that ranks
    // by it, and nothing on the column that does not.
    expect(ariaSortOf(RENDERS_SORT_NAME)).toBe('descending');
    expect(ariaSortOf(TOTAL_SORT_NAME)).toBe('none');

    await user.click(screen.getByRole('button', { name: TOTAL_SORT_NAME }));

    // A re-query, in the vocabulary the data layer understands.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const requeried = queryOfCall(stub, 2);
    expect(requeried.sort).toBe(LONGEST_TOTAL_FIRST);
    expect(requeried.source).toBe('renders');
    expect(requeried.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    // And the rows follow that response, in its order.
    const reorderedNames = reordered.map((stat) => stat.component);
    await waitFor(() => {
      expect(renderedNames()).toEqual(reorderedNames);
    });
    expect(ariaSortOf(TOTAL_SORT_NAME)).toBe('descending');
    expect(ariaSortOf(RENDERS_SORT_NAME)).toBe('none');
    expect(orderControl().value).toBe(LONGEST_TOTAL_FIRST);

    // The host is told, so it can remember the reader's choice; the report is a
    // selection and carries no query shape.
    expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).toHaveBeenCalledWith(NODE_ID, { sort: LONGEST_TOTAL_FIRST });
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('does not re-query when the activated column is already the applied order', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const user = userEvent.setup();

    // The node already asks for `count_desc`, and the vocabulary offers one
    // direction per column, so a second activation has nothing to request —
    // and must not reverse into an order the data layer cannot express.
    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(screen.getByRole('button', { name: RENDERS_SORT_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(ariaSortOf(RENDERS_SORT_NAME)).toBe('descending');
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
  });
});

describe('RenderTable paging', () => {
  it('says how much of the result is on screen and asks the provider for the next page', async () => {
    // The provider answers each call with the next page. "Load more" advances
    // the sequence to the provider's own `nextOffset` and appends the answer
    // beneath the page already on screen; it never grows one request.
    const stub = pagingProvider([
      { data: [WIDGET_ROW], total: 12, nextOffset: 1 },
      { data: [LIST_ROW], total: 12, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 1 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // One component of twelve, said plainly rather than implied by a bare count.
    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(12)} components.`);
    expect(dataRows()).toHaveLength(1);

    const first = soleQuery(stub);
    expect(first.limit).toBe(1);
    expect(first.offset).toBeUndefined();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next page of the same query: same source, same ordering, same page
    // size, starting exactly where the provider said it starts.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const second = queryOfCall(stub, 2);
    expect(second.limit).toBe(first.limit);
    expect(second.source).toBe('renders');
    expect(second.sort).toBe(MOST_RENDERS_FIRST);
    expect(second.offset).toBe(1);

    // And the reader keeps what they were reading, with the new row beneath it.
    await waitFor(() => {
      expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT]);
    });
    expect(
      screen.getByText(`Showing ${formatCount(2)} of ${formatCount(12)} components.`),
    ).toBeDefined();

    // The second page reported a further one, so the control is still offered.
    expect(screen.getByRole('button', { name: LOAD_MORE_NAME })).toBeDefined();
  });

  it('offers no paging control once the response reports no further page', async () => {
    const stub = resolvingProvider([WIDGET_ROW], { total: 1 });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(1)} components.`);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('counts what it loaded rather than implying the page is the whole result', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A service that reported no total leaves this view unable to say how much
    // of the source it drew, and stating the count it has is the only truthful
    // option (AAP 0.4.2).
    const coverage = await screen.findByText(`${formatCount(1)} components loaded.`);
    expect(coverage.textContent).not.toMatch(/\bof\b/);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('clamps a page beyond the published maximum, and keeps paging past it', async () => {
    const stub = resolvingProvider([WIDGET_ROW], {
      total: 9_000,
      nextOffset: DATA_QUERY_MAX_LIMIT,
    });
    const user = userEvent.setup();

    // A node whose `limit` exceeds the contract's ceiling: the service would
    // reject the query, so the request is bounded here instead. The ceiling
    // bounds one page, not the sequence: the provider reports a next page, so
    // the control is offered and follows it.
    renderComponent(
      makeNode({
        query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: DATA_QUERY_MAX_LIMIT + 1_000 },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });

    expect(soleQuery(stub).limit).toBe(DATA_QUERY_MAX_LIMIT);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).offset).toBe(DATA_QUERY_MAX_LIMIT);
    expect(queryOfCall(stub, 2).limit).toBe(DATA_QUERY_MAX_LIMIT);

    // The stub repeats its page, so the second answer reports the offset it was
    // requested at: a `nextOffset` that does not advance ends the sequence, and
    // the repeated row is drawn once.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();
    });
    expect(renderedNames()).toEqual([WIDGET_COMPONENT]);
  });
});

describe('RenderTable page sequence', () => {
  /*
   * An offset-aware stub, local to these cases: each request is answered by
   * the page defined at its own `offset` (and, for the ordering case, its own
   * `sort`), so a component that re-requested the prefix, grew a window or
   * derived an offset from what arrived would receive the wrong page and fail
   * visibly rather than by coincidence. A request may also be held open, so the
   * state between "Load more" and the next answer can be asserted, or rejected.
   */

  /** How the stub answers one request: a page, a request held open, or a failure. */
  type SequenceAnswer = RenderPage | 'pending' | DebuggenError;

  /** The stub, the queries it received and the handle that settles a held request. */
  interface SequenceStub {
    /** The provider to hand to {@link renderComponent}. */
    readonly provider: DataProvider;

    /** Every query received, in call order. */
    readonly queries: readonly DataQuery[];

    /**
     * Answers the request held open at `offset` with `page`. Synchronous: the
     * caller awaits the resulting render through `waitFor`.
     */
    readonly settle: (offset: number, page: RenderPage) => void;
  }

  /** The label the paging control carries while the next page is in flight. */
  const LOADING_MORE_NAME = 'Loading more…';

  /** Anything whose accessible name starts with "Load" — both paging labels. */
  const ANY_PAGING_CONTROL = /^Load/;

  /**
   * The position a query asks for, with the contract's default applied — the
   * same default the side resolving a query applies to one that carries none.
   *
   * @param query The received query.
   * @returns Its offset.
   */
  function offsetOf(query: DataQuery): number {
    return query.offset ?? DATA_QUERY_DEFAULT_OFFSET;
  }

  /**
   * The response a page stands for, with its counters present only when set.
   *
   * @param page The page.
   * @returns The response.
   */
  function responseFor(page: RenderPage): DataQueryResponse {
    return {
      source: 'renders',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    };
  }

  /**
   * Builds the offset-aware stub.
   *
   * @param answer Called with each query and its 1-based call number.
   * @returns The stub.
   */
  function sequenceProvider(
    answer: (query: DataQuery, call: number) => SequenceAnswer,
  ): SequenceStub {
    const queries: DataQuery[] = [];
    const held = new Map<number, (response: DataQueryResponse) => void>();

    const provider = createDataProvider((query) => {
      queries.push(query);

      const answered = answer(query, queries.length);

      if (answered === 'pending') {
        return new Promise<DataQueryResponse>((resolve) => {
          held.set(offsetOf(query), resolve);
        });
      }

      if (answered instanceof DebuggenError) {
        return Promise.reject(answered);
      }

      return Promise.resolve(responseFor(answered));
    });

    const settle = (offset: number, page: RenderPage): void => {
      const resolve = held.get(offset);

      if (resolve === undefined) {
        throw new Error(`no request at offset ${String(offset)} is being held`);
      }

      held.delete(offset);
      resolve(responseFor(page));
    };

    return { provider, queries, settle };
  }

  /**
   * The query received on the given 1-based call.
   *
   * @param stub The stub.
   * @param call The call number.
   * @returns That query.
   */
  function requestOf(stub: SequenceStub, call: number): DataQuery {
    const query = stub.queries[call - 1];

    if (query === undefined) {
      throw new Error(`the stub received no query for call ${String(call)}`);
    }

    return query;
  }

  /**
   * A quiet component: two renders, so a louder one stands out against it.
   *
   * @param component The component name.
   * @returns The row.
   */
  function quietRow(component: string): RenderStat {
    return makeRenderStat({
      component,
      renderCount: 2,
      totalDurationMs: 24,
      averageDurationMs: 12,
      maxDurationMs: 16,
      triggers: makeTriggers({ props: 1, unchanged: 1 }),
      phaseCounts: makePhases({ mount: 1, update: 1 }),
    });
  }

  const CARD_COMPONENT = 'ExampleCard';
  const PANEL_COMPONENT = 'ExamplePanel';
  const FORM_COMPONENT = 'ExampleForm';
  const CARD_ROW = quietRow(CARD_COMPONENT);
  const PANEL_ROW = quietRow(PANEL_COMPONENT);
  const FORM_ROW = quietRow(FORM_COMPONENT);

  it('requests the next page at the provider nextOffset with the same limit, and appends it once', async () => {
    const stub = sequenceProvider((query) =>
      offsetOf(query) === 0 ? { data: [LIST_ROW, WIDGET_ROW], total: 4, nextOffset: 2 } : 'pending',
    );
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(4)} components.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The same query, moved to exactly the offset the provider reported: the
    // same source, filter, order and page size — one new page, not a larger one.
    expect(stub.queries).toHaveLength(2);
    const first = requestOf(stub, 1);
    const second = requestOf(stub, 2);
    expect(second).toEqual({ ...first, offset: 2 });
    expect(second.limit).toBe(2);
    expect(first.limit).toBe(2);

    // While it is in flight, the loaded rows stay where the reader is reading,
    // under their total, with a busy control rather than the block's silhouette.
    expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT]);
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.getByText(`Showing ${formatCount(2)} of ${formatCount(4)} components.`),
    ).toBeDefined();
    const busy = screen.getByRole('button', { name: LOADING_MORE_NAME });
    expect(busy instanceof HTMLButtonElement && busy.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // The next page repeats a row the reader already has: it is drawn once, in
    // its original place, and the new row lands beneath the loaded ones.
    stub.settle(2, { data: [WIDGET_ROW, CARD_ROW], total: 4 });

    await waitFor(() => {
      expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT, CARD_COMPONENT]);
    });
    expect(
      screen.getByText(`Showing ${formatCount(3)} of ${formatCount(4)} components.`),
    ).toBeDefined();

    // No further page was reported, so none is offered — and nothing already
    // on screen was requested a second time.
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
    expect(stub.queries).toHaveLength(2);
  });

  it('keeps following the reported offsets past the 5 000-row page ceiling', async () => {
    const pagesAt = new Map<number, RenderPage>([
      [4_800, { data: [CARD_ROW], total: 6_000, nextOffset: 4_900 }],
      [4_900, { data: [PANEL_ROW], total: 6_000, nextOffset: 5_100 }],
      [5_100, { data: [FORM_ROW], total: 6_000 }],
    ]);
    const stub = sequenceProvider((query) => {
      const page = pagesAt.get(offsetOf(query));

      if (page === undefined) {
        throw new Error(`no page is defined at offset ${String(offsetOf(query))}`);
      }

      return page;
    });
    const user = userEvent.setup();

    renderComponent(
      makeNode({
        query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 100, offset: 4_800 },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await waitFor(() => {
      expect(renderedNames()).toEqual([CARD_COMPONENT]);
    });

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([CARD_COMPONENT, PANEL_COMPONENT]);
    });

    // The provider skipped ahead; the view follows it rather than counting rows,
    // and a request beyond the ceiling is issued like any other.
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([CARD_COMPONENT, PANEL_COMPONENT, FORM_COMPONENT]);
    });

    expect(stub.queries.map((query) => query.offset)).toEqual([4_800, 4_900, 5_100]);
    expect(stub.queries.map((query) => query.limit)).toEqual([100, 100, 100]);
    expect(requestOf(stub, 3).offset ?? 0).toBeGreaterThan(DATA_QUERY_MAX_LIMIT);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
  });

  it('offers no paging control without a nextOffset, however large the total', async () => {
    // Fifty components reported and one delivered, but no next offset: the
    // provider did not say where more rows start, so none are requested.
    const stub = sequenceProvider(() => ({ data: [WIDGET_ROW], total: 50 }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(50)} components.`);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
    expect(stub.queries).toHaveLength(1);
  });

  it('treats a nextOffset that does not move past the current page as the end', async () => {
    // Following it would re-request the page on screen, and loop on it.
    const stub = sequenceProvider(() => ({ data: [WIDGET_ROW], total: 50, nextOffset: 3 }));

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, offset: 3 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(requestOf(stub, 1).offset).toBe(3);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
    expect(stub.queries).toHaveLength(1);
  });

  it('starts the sequence over from the first page when the order changes', async () => {
    const stub = sequenceProvider((query) => {
      const firstPage =
        query.sort === LONGEST_TOTAL_FIRST ? [WIDGET_ROW, LIST_ROW] : [LIST_ROW, WIDGET_ROW];

      return offsetOf(query) === 0
        ? { data: firstPage, total: 3, nextOffset: 2 }
        : { data: [CARD_ROW], total: 3 };
    });
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT, CARD_COMPONENT]);
    });

    // A header activation is a new ordering, so a new sequence: its first page,
    // with the node's own (absent) offset and the same page size.
    await user.click(screen.getByRole('button', { name: TOTAL_SORT_NAME }));

    expect(stub.queries).toHaveLength(3);
    expect(requestOf(stub, 3)).toEqual({ ...requestOf(stub, 1), sort: LONGEST_TOTAL_FIRST });

    // The rows loaded under the old order are released, not carried over.
    await waitFor(() => {
      expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT]);
    });

    // The new sequence pages on its own offsets.
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    expect(requestOf(stub, 4)).toEqual({
      ...requestOf(stub, 1),
      sort: LONGEST_TOTAL_FIRST,
      offset: 2,
    });
    await waitFor(() => {
      expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT, CARD_COMPONENT]);
    });

    // The toolbar is the other way to change the order, and it resets the same way.
    await user.selectOptions(orderControl(), MOST_RENDERS_FIRST);

    expect(requestOf(stub, 5)).toEqual(requestOf(stub, 1));
    await waitFor(() => {
      expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT]);
    });
  });

  it('keeps the loaded rows when the next page fails, and retries exactly that page', async () => {
    let nextPageAttempts = 0;
    const stub = sequenceProvider((query) => {
      if (offsetOf(query) === 0) {
        return { data: [LIST_ROW, WIDGET_ROW], total: 3, nextOffset: 2 };
      }

      nextPageAttempts += 1;

      return nextPageAttempts === 1
        ? new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.')
        : { data: [CARD_ROW], total: 3 };
    });
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The failure is reported beneath the rows, with the query that failed —
    // at the reported offset — and the rows already loaded are untouched.
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText(/next page of render statistics could not be loaded/i),
    ).toBeDefined();
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'renders',
      sort: MOST_RENDERS_FIRST,
      limit: 2,
      offset: 2,
    });
    expect(screen.getByRole('grid', { name: GRID_NAME })).toBeDefined();
    expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT]);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();

    // The retry re-requests the page that failed, and its rows are appended.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.queries).toHaveLength(3);
    expect(requestOf(stub, 3)).toEqual(requestOf(stub, 2));
    await waitFor(() => {
      expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT, CARD_COMPONENT]);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an open row open, and marks outliers over every loaded row, as pages append', async () => {
    const loud = makeRenderStat({ renderCount: 40, totalDurationMs: 1_600 });
    const stub = sequenceProvider((query) =>
      offsetOf(query) === 0
        ? { data: [loud, quietRow(LIST_COMPONENT)], total: 5, nextOffset: 2 }
        : { data: [CARD_ROW, PANEL_ROW, FORM_ROW], total: 5 },
    );
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });

    // Two rows are no distribution, so nothing is marked yet.
    const figure = (): HTMLElement =>
      within(cellFor(rowFor(WIDGET_COMPONENT), 'Renders')).getByText(formatCount(40));
    expect(figure().classList.contains('dg-is-outlier')).toBe(false);

    await user.click(within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: EXPAND_NAME }));
    expect(detailRows()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(dataRows()).toHaveLength(5);
    });

    // Five loaded rows with a median of two: the loud one now stands out, and
    // the row the reader opened is still open.
    expect(figure().classList.contains('dg-is-outlier')).toBe(true);
    expect(cellFor(rowFor(WIDGET_COMPONENT), 'Renders').textContent ?? '').toMatch(
      /median of the loaded rows/i,
    );
    expect(rowFor(WIDGET_COMPONENT).getAttribute('aria-expanded')).toBe('true');
    expect(detailRows()).toHaveLength(1);
  });

  it('offers the next page after a resolved page that held no rows but named one', async () => {
    const stub = sequenceProvider((query) =>
      offsetOf(query) === 0
        ? { data: [], total: 2, nextOffset: 2 }
        : { data: [WIDGET_ROW, LIST_ROW], total: 2 },
    );
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // The empty page is reported as a page, never as a capture without renders,
    // and the offset it named stays reachable.
    await screen.findByText(`Showing ${formatCount(0)} of ${formatCount(2)} components.`);
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(stub.queries).toHaveLength(2);
    expect(requestOf(stub, 2)).toEqual({ ...requestOf(stub, 1), offset: 2 });
    expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT]);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
  });

  it('starts over from the authored first page, painting none of the old rows, when the data provider is replaced', async () => {
    const earlier = sequenceProvider((query) =>
      offsetOf(query) === 0
        ? { data: [WIDGET_ROW, LIST_ROW], total: 4, nextOffset: 2 }
        : { data: [CARD_ROW, PANEL_ROW], total: 4 },
    );
    const later = sequenceProvider(() => 'pending');
    const { actions } = makeActions();
    const user = userEvent.setup();
    const node = makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } });

    // One node, one query, two providers: a host rebinding a mounted panel to
    // another session swaps the provider without remounting the node.
    const view = render(
      <DataProviderContext.Provider value={earlier.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <RenderTable node={node} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(dataRows()).toHaveLength(4);
    });
    await user.click(within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: EXPAND_NAME }));
    expect(detailRows()).toHaveLength(1);

    view.rerender(
      <DataProviderContext.Provider value={later.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <RenderTable node={node} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );

    // The new provider is asked for the authored first page — not the offset
    // the previous provider's pages reached — and while it loads nothing of the
    // previous provider's is on screen, open rows included.
    expect(later.queries).toHaveLength(1);
    expect(requestOf(later, 1)).toEqual(requestOf(earlier, 1));
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByText(WIDGET_COMPONENT)).toBeNull();

    act(() => {
      later.settle(DATA_QUERY_DEFAULT_OFFSET, { data: [PANEL_ROW], total: 1 });
    });

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(renderedNames()).toEqual([PANEL_COMPONENT]);
    expect(detailRows()).toHaveLength(0);
    expect(earlier.queries).toHaveLength(2);
  });
});

describe('RenderTable keyboard descriptions', () => {
  /** The five columns whose header carries a definition, in display order. */
  const DESCRIBED_COLUMNS: readonly ColumnLabel[] = [
    'Triggers',
    STABLE_INPUTS_COLUMN,
    UNCLASSIFIED_COLUMN,
    'Changed props',
    'Phases',
  ];

  /**
   * The tooltip trigger inside an element: the one descendant carrying an
   * `aria-describedby`, which `Tooltip` merges onto the trigger it clones.
   *
   * @param container Where to look.
   * @returns The trigger.
   */
  function triggerIn(container: HTMLElement): HTMLElement {
    const triggers = [...container.querySelectorAll<HTMLElement>('[aria-describedby]')];

    expect(triggers).toHaveLength(1);

    const [trigger] = triggers;

    if (trigger === undefined) {
      throw new Error('no tooltip trigger was found');
    }

    return trigger;
  }

  /**
   * The bubble a trigger is described by, resolved through its
   * `aria-describedby` exactly as an assistive technology resolves it.
   *
   * @param trigger The trigger.
   * @returns The bubble.
   */
  function bubbleOf(trigger: HTMLElement): HTMLElement {
    const id = trigger.getAttribute('aria-describedby') ?? '';
    const bubble = document.getElementById(id);

    if (bubble === null) {
      throw new Error(`aria-describedby "${id}" resolves to no element`);
    }

    expect(bubble.getAttribute('role')).toBe('tooltip');

    return bubble;
  }

  /** Whether a bubble is being shown, by the class `Tooltip` couples to that state. */
  function isOpen(bubble: HTMLElement): boolean {
    return bubble.classList.contains('dg-is-open');
  }

  it('opens every header definition when Tab reaches it, and nests none in a sort button', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // No header control holds a tooltip, so each sort button is named by its
    // header text alone and no description hides behind a button's focus.
    for (const header of screen.getAllByRole('columnheader')) {
      for (const button of within(header).queryAllByRole('button')) {
        expect(button.querySelector('[role="tooltip"]')).toBeNull();
        expect(button.querySelector('[aria-describedby]')).toBeNull();
      }
    }
    expect(screen.getByRole('button', { name: RENDERS_SORT_NAME })).toBeDefined();
    expect(screen.getByRole('button', { name: TOTAL_SORT_NAME })).toBeDefined();

    const triggers = DESCRIBED_COLUMNS.map((label) => {
      const trigger = triggerIn(headerFor(label));

      // The header text itself is the trigger, and a tab stop of its own.
      expect(trigger.textContent).toBe(label);
      expect(trigger.tabIndex).toBe(0);
      expect(trigger.closest('button')).toBeNull();
      expect(isOpen(bubbleOf(trigger))).toBe(false);

      return trigger;
    });

    // From the last sort control, Tab walks the five definitions in display
    // order, and each one opens as focus arrives and closes as it leaves.
    act(() => {
      screen.getByRole('button', { name: TOTAL_SORT_NAME }).focus();
    });

    let previous: HTMLElement | undefined;

    for (const trigger of triggers) {
      await user.tab();

      expect(document.activeElement).toBe(trigger);
      expect(isOpen(bubbleOf(trigger))).toBe(true);

      if (previous !== undefined) {
        expect(isOpen(bubbleOf(previous))).toBe(false);
      }

      previous = trigger;
    }

    // The two definitions that must never be read as one stay distinct.
    expect(bubbleOf(triggerIn(headerFor(STABLE_INPUTS_COLUMN))).textContent).toMatch(
      /evaluated and none of them had changed/i,
    );
    expect(bubbleOf(triggerIn(headerFor(UNCLASSIFIED_COLUMN))).textContent).toMatch(
      /could not be evaluated/i,
    );
  });

  it('makes an in-row description a tab stop only in the row the reader is in', async () => {
    // Two components far above a median of two, so both counts are marked and
    // both carry an explanation.
    const quiet = ['ExampleCard', 'ExamplePanel', 'ExampleForm'].map((component) =>
      makeRenderStat({
        component,
        renderCount: 2,
        totalDurationMs: 24,
        averageDurationMs: 12,
        maxDurationMs: 16,
        triggers: makeTriggers({ props: 1, unchanged: 1 }),
        phaseCounts: makePhases({ mount: 1, update: 1 }),
      }),
    );
    const loudWidget = makeRenderStat({ renderCount: 40, totalDurationMs: 1_600 });
    const loudList = makeRenderStat({
      component: LIST_COMPONENT,
      renderCount: 50,
      totalDurationMs: 2_000,
    });
    const stub = resolvingProvider([loudWidget, loudList, ...quiet]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });

    const figureOf = (component: string, count: number): HTMLElement =>
      within(cellFor(rowFor(component), 'Renders')).getByText(formatCount(count));
    const tabbableFigures = (): Element[] => [
      ...grid.querySelectorAll('.dg-render-table__count-cell[tabindex="0"]'),
    ];

    // Before focus reaches any row, no figure is in the Tab sequence — yet each
    // is still described, and the description still resolves.
    for (const [component, count] of [
      [WIDGET_COMPONENT, 40],
      [LIST_COMPONENT, 50],
    ] as const) {
      const figure = figureOf(component, count);
      expect(figure.getAttribute('tabindex')).toBeNull();
      expect(bubbleOf(figure).textContent ?? '').toMatch(/median of the loaded rows/i);
    }
    expect(tabbableFigures()).toHaveLength(0);

    // The reader arrives on the first loud row: its figure joins the Tab
    // sequence, and no other row's does.
    act(() => {
      rowFor(WIDGET_COMPONENT).focus();
    });

    expect(figureOf(WIDGET_COMPONENT, 40).tabIndex).toBe(0);
    expect(figureOf(LIST_COMPONENT, 50).getAttribute('tabindex')).toBeNull();
    expect(tabbableFigures()).toEqual([figureOf(WIDGET_COMPONENT, 40)]);

    // Tab from the row passes its disclosure control and lands on the figure,
    // whose explanation opens.
    await user.tab();
    expect(document.activeElement).toBe(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: EXPAND_NAME }),
    );
    await user.tab();
    expect(document.activeElement).toBe(figureOf(WIDGET_COMPONENT, 40));
    expect(isOpen(bubbleOf(figureOf(WIDGET_COMPONENT, 40)))).toBe(true);

    // Moving to the other loud row moves the stop with it.
    act(() => {
      rowFor(LIST_COMPONENT).focus();
    });

    expect(figureOf(LIST_COMPONENT, 50).tabIndex).toBe(0);
    expect(figureOf(WIDGET_COMPONENT, 40).getAttribute('tabindex')).toBeNull();
    expect(tabbableFigures()).toEqual([figureOf(LIST_COMPONENT, 50)]);
    expect(isOpen(bubbleOf(figureOf(WIDGET_COMPONENT, 40)))).toBe(false);

    // A pointer click on a figure outside the focused row puts focus on that
    // figure's ROW, not on the figure, so the grid's arrow keys keep working
    // from where the reader clicked.
    await user.click(figureOf(WIDGET_COMPONENT, 40));
    expect(document.activeElement).toBe(rowFor(WIDGET_COMPONENT));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowFor(LIST_COMPONENT));
  });

  it('lets Tab reach the trigger description of an individual render in an open row', async () => {
    const occurrence = makeOccurrence({
      eventId: 'event-example-0011',
      spanId: spanIdFor(11),
      startTime: BASE_START_MS + 64,
      durationMs: 8,
      trigger: 'context',
    });
    const stat = makeRenderStat({
      renderCount: 1,
      totalDurationMs: 8,
      averageDurationMs: 8,
      maxDurationMs: 8,
      triggers: makeTriggers({ context: 1 }),
      phaseCounts: makePhases({ update: 1 }),
      occurrences: [occurrence],
      occurrencesTruncated: false,
    });
    const stub = resolvingProvider([stat]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(within(rowFor(WIDGET_COMPONENT)).getByRole('button', { name: EXPAND_NAME }));

    const chip = triggerIn(onlyDetailRow());
    expect(chip.getAttribute('data-trigger')).toBe('context');
    expect(chip.tabIndex).toBe(0);
    expect(bubbleOf(chip).textContent).toBe(formatRenderTriggerLabel('context'));
    expect(isOpen(bubbleOf(chip))).toBe(false);

    // Focus is on the disclosure control the reader just used; Tab moves on
    // through the open row — its select control, then the chip.
    await user.tab();
    expect(document.activeElement).toBe(
      within(onlyDetailRow()).getByRole('button', { name: SELECT_OCCURRENCE_NAME }),
    );
    await user.tab();
    expect(document.activeElement).toBe(chip);
    expect(isOpen(bubbleOf(chip))).toBe(true);
  });
});
