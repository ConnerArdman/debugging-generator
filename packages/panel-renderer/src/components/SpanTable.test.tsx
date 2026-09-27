/**
 * `components/SpanTable` — the colocated suite, and the stub-provider harness
 * the other query-backed component suites in this folder follow.
 *
 * ## What this suite is protecting
 *
 * The `table` node draws one page of records that the coordination service has
 * already filtered, ordered and paged: `POST /sessions/:id/panel-data` applies
 * `filter`, `sort`, `limit` and `offset` and answers with `total` and
 * `nextOffset` (`docs/ARCHITECTURE.md`, "Panel data"). Two of the cases below
 * are the mechanical proof of that contract rather than tests of pixels:
 *
 *   - **order preserved** renders a deliberately unsorted page and asserts the
 *     rows appear in the provider's own order, so a local `.sort()` of a
 *     service-ordered page added to the component later fails here;
 *   - **a service order is a re-query** activates a sortable header and
 *     asserts a *new* provider call carrying the mapped `DataQuerySort`, with
 *     the rows then following the second response — not a client-side
 *     re-ordering of the first.
 *
 * The ordering cases hold the rest of that contract. The data layer orders a
 * span list only by longest duration and by earliest start, so every other
 * column and direction is a *view order*: the loaded rows are arranged in the
 * component, stably, with no query, the header reports that order, and while
 * the loaded rows are not the whole result the footer says the order covers
 * only them. Re-activating the sorted Duration header therefore flips the
 * order rather than doing nothing, and the header control the reader activated
 * keeps its element and its focus across the re-query a service order causes.
 *
 * The paging case holds the other half of the same contract: a page is a page,
 * the footer says how much of the result is on screen, and "Load more" advances
 * `offset` on the query the provider receives instead of guessing from the
 * length of what arrived. The service's `nextOffset` is the only authority on
 * whether another page exists: `null`, an omitted counter, or an offset that
 * does not move forward offers no further page even when `total` counts more
 * rows, and the footer says so instead of inventing one.
 *
 * The empty-page cases hold the rule that an empty page is not an empty
 * capture: an explicit `limit: 0` is sent as zero and drawn as a count, and a
 * page past the end, or one the total says should hold rows, names that total
 * rather than claiming nothing matched.
 *
 * Alongside those, every component suite here covers the three states of a
 * query-backed view — loading, empty and error — and the click-to-source
 * payload. Each state is driven through a stub `DataProvider` that respectively
 * never settles, resolves an empty page and rejects; the payload cases assert
 * what the host actually receives, because every hop after this one acts blind
 * on the object it is handed (this is the first hop of the path
 * `docs/ARCHITECTURE.md` traces under "A click, end to end").
 *
 * ## Harness conventions (shared with `./SourceLink.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`. The `panel-renderer`
 *     project does enable `globals`, but only so `@testing-library/react` can
 *     register its automatic cleanup on a global `afterEach`; every suite in
 *     this repository still names what it uses.
 *   - **`afterEach(cleanup)` registered explicitly**, for the same reason: a
 *     suite that leaks a mounted tree between cases fails later with a
 *     multiple-match error that reads like a component bug.
 *   - **Stub providers are built with the library's own `createDataProvider`**,
 *     so these cases exercise the very seam the DevTools panel and the editor
 *     webview implement — including its guarantee that a response answers for
 *     the source it was asked about. The resolver is a `vi.fn`, and every query
 *     it receives is recorded in an array the cases assert on: what the
 *     component *asked for* is as much of its contract as what it drew.
 *   - **In-file synthetic builders, no fixture files.** {@link makeEvent} and
 *     {@link makeNode} take overrides; nothing here is read from disk or shared
 *     with another suite.
 *   - **Generic fixture vocabulary only**: span names, a file path and a
 *     symbol that belong to no application, demonstration or otherwise.
 *     `scripts/check-no-hardcoding.mjs` skips test files, so this suite keeps
 *     the product's neutral vocabulary by convention.
 *   - **Queries by role and accessible name.** The grid, its rows, its header
 *     controls, the chips and the footer button are all reached that way; a
 *     class is read only off an element already obtained semantically, since no
 *     `jest-dom` matcher is available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…`, and interactions through
 *     `userEvent`.
 *
 * @see ./SpanTable for the component, its four states and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 */

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, TableNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { TelemetryEvent } from '@debuggen/telemetry';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext, PanelSelectionContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef, PanelSelection } from '../host/PanelActions';
import { Button } from '../primitives/Button';
import { kindColorVar, tierColorVar } from '../utils/color';
import {
  formatCount,
  formatDuration,
  formatKindLabel,
  formatOffset,
  formatTierLabel,
} from '../utils/format';
import { SpanTable } from './SpanTable';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral: no component, route, service or
 * symbol of any inspected project appears here, in the fixtures or in the
 * comments. The identifiers are shaped as the capture shapes them — a 32-hex
 * trace id, 16-hex span ids, epoch-millisecond start times, millisecond
 * durations — because the component reads those fields and formats them.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every row below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** The fixture session and capture the persisted events are attributed to. */
const SESSION_ID = 'session-example-0001';
const CAPTURE_ID = 'capture-example-0001';

/** The producer that reported them, and its per-capture sequence base. */
const PRODUCER_ID = 'producer-example-0001';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Inside the window the event schema accepts, and far enough from zero that a
 * relative performance timestamp could not be mistaken for one.
 */
const BASE_START_MS = 1_767_225_600_000;

/** A project-relative, POSIX path for the one row that resolved to source. */
const SOURCE_FILE = 'src/example/service.ts';

/** The symbol at that location. */
const SOURCE_SYMBOL = 'runExample';

/** Its 1-based coordinates. */
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
const NODE_ID = 'layout.0.table';

/**
 * The two orderings a data query can carry for a span list, held as typed
 * constants so a case names the data layer's vocabulary rather than a bare
 * string that happens to match it.
 *
 * `count_desc`, the third member of the vocabulary, is a grouped-source
 * ordering: a span list has no count, so no column of this table claims it.
 */
const SLOWEST_FIRST: DataQuerySort = 'duration_desc';
const EARLIEST_FIRST: DataQuerySort = 'start_asc';

/**
 * The accessible names of the five sortable header controls: each column's
 * own name, and for Start the reference point its relative values are taken
 * from. None names a direction — every column sorts both ways and the
 * direction in force is the header cell's `aria-sort`.
 *
 * Spelled out here rather than derived, so this suite pins the names the
 * controls announce instead of restating whatever the component currently
 * passes.
 */
const OPERATION_SORT_NAME = 'Operation';
const KIND_SORT_NAME = 'Kind';
const TIER_SORT_NAME = 'Tier';
const DURATION_SORT_NAME = 'Duration';
const START_SORT_NAME = 'Start, relative to the earliest listed operation';

/**
 * The sentence the footer adds while a view order arranges rows that are not
 * the whole result, for a given count of loaded rows. Spelled out, like the
 * header names above, so this suite pins the copy.
 *
 * @param loaded How many rows are loaded.
 * @returns The scope sentence.
 */
function viewOrderScopeSentence(loaded: number): string {
  return `This order covers only the ${formatCount(loaded)} loaded ${
    loaded === 1 ? 'span' : 'spans'
  }; the service orders the full result only by longest duration or earliest start.`;
}

/**
 * The sentence the footer adds while a further page is offered or loading: the
 * page size each "Load more" asks for. Spelled out to pin the copy.
 *
 * @param limit The page size the node's query requests.
 * @returns The page-size sentence.
 */
function pageSizeSentence(limit: number): string {
  return `Each page holds up to ${formatCount(limit)} ${limit === 1 ? 'span' : 'spans'}.`;
}

/** The footer control that asks for the next page. */
const LOAD_MORE_NAME = 'Load more';

/** The same control while the page it requested is still in flight. */
const LOADING_MORE_NAME = 'Loading…';

/**
 * The first line of the state a count-only query (`limit: 0`) resolves to.
 * Spelled out, like the header names above, so this suite pins the copy.
 */
const COUNT_ONLY_TITLE = 'Count only';

/** The first line of an empty page that is not an empty capture. */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/**
 * The sentence reserved for a query that matched nothing at all — worded as
 * every other view's empty capture is, about the interaction rather than the
 * query.
 */
const EMPTY_CAPTURE_MESSAGE = 'No spans were captured for this interaction.';

/** The short title above that sentence, the empty capture's alone. */
const NOTHING_CAPTURED_TITLE = 'No spans';

/** The error state's retry control. */
const RETRY_NAME = 'Retry';

/**
 * The two controls the keyboard cases place around the table, so a Tab can be
 * pressed from just before the grid and seen to land just after it.
 */
const BEFORE_TABLE = 'Before the table';
const AFTER_TABLE = 'After the table';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/**
 * The shared error-state contract every query-backed node renders a failure
 * with, spelled out rather than read back from the host's constants, so this
 * suite pins the words a reader actually sees: the title and generic lead of a
 * failed view and of a failed next page, and the focus key the host's node
 * frame uses to restore focus to the retry control after a remount.
 */
const QUERY_FAILURE_TITLE = 'Could not load this view';
const QUERY_FAILURE_LEAD = 'The data for this view could not be loaded.';
const PAGE_FAILURE_TITLE = 'Could not load the next page';
const PAGE_FAILURE_LEAD =
  'The next page of this view could not be loaded. The rows already shown are unaffected.';
const RETRY_FOCUS_KEY = 'error-state-retry';

/** A provider's cause and hint for the shared-contract cases. */
const PROVIDER_CAUSE = 'The channel to the service is closed.';
const PROVIDER_HINT = 'Start the Debug Generator service, then retry.';

/** What the first page's loading state announces. */
const LOADING_LABEL = 'Loading captured spans…';

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/**
 * The optional fields of an event admit `undefined` explicitly, which `Partial`
 * does not under this repository's `exactOptionalPropertyTypes`: passing
 * `{ source: undefined }` is how a case asks for a row *without* a location,
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
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/**
 * One persisted span record for a row to draw.
 *
 * Complete and schema-shaped by construction: a 32-hex `traceId`, a 16-hex
 * `spanId`, an epoch-millisecond `startTime`, a millisecond `duration`, and a
 * `kind`/`tier` pair the event schema's cross-field rule permits (`function`
 * may be reported on either tier, `db.query` only on `db`).
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

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<TableNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `table` node, as the panel normaliser produces one: an id, no
 * heading (the host's section owns that), and a data query whose page size and
 * ordering are already explicit.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): TableNode {
  const {
    id = NODE_ID,
    query = { source: 'spans', sort: SLOWEST_FIRST, limit: DATA_QUERY_DEFAULT_LIMIT },
    title,
    description,
  } = overrides;

  return {
    type: 'table',
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
 * response answers for the source it was asked about, which is why each stub
 * echoes the source it was *built* with rather than the one it received.
 * ---------------------------------------------------------------------------
 */

/** The two sources the `table` node's catalog entry permits. */
type SpanSource = 'spans' | 'events';

/** One page a stub provider can answer with. */
interface SpanPage {
  /** The records of the page, in the order the service returned them. */
  readonly data: readonly TelemetryEvent[];

  /** The total the service reports for the whole query, when it reports one. */
  readonly total?: number | undefined;

  /**
   * The offset of the next page, when one exists.
   *
   * `null` is the wire's own spelling of "this is the last page", and is passed
   * through to the response verbatim so a case can prove the component reads it
   * as the end of the data; `undefined` omits the counter altogether.
   */
  readonly nextOffset?: number | null | undefined;
}

/** A stub provider, the queries it has received and the resolver behind it. */
interface StubProvider {
  /** The provider to hand to {@link renderComponent}. */
  readonly provider: DataProvider;

  /**
   * Every query the component has asked for, in call order.
   *
   * The assertion surface for the paging, ordering and clamping cases: what the
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
 * A provider that answers each successive call with the next page, repeating
 * the last one once the list is exhausted.
 *
 * The builder the ordering and paging cases use: a re-query has to be able to
 * answer differently from the query before it, or "the rows follow the second
 * response" could not be told from "the rows were re-ordered locally".
 *
 * @param source The source the responses answer for.
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(source: SpanSource, pages: readonly SpanPage[]): StubProvider {
  return recordingProvider((_query, call) => {
    const page = pages[Math.min(call, pages.length) - 1];

    if (page === undefined) {
      throw new Error('the stub provider was built with no pages');
    }

    return Promise.resolve<DataQueryResponse>({
      source,
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    });
  });
}

/**
 * A provider that resolves one page for every query.
 *
 * @param source The source the response answers for.
 * @param data The records of the page, in the order they should be drawn.
 * @param extra The paging counters to report, if any.
 * @returns The stub provider.
 */
function resolvingProvider(
  source: SpanSource,
  data: readonly TelemetryEvent[],
  extra: Omit<SpanPage, 'data'> = {},
): StubProvider {
  return pagingProvider(source, [{ data, ...extra }]);
}

/**
 * A provider that answers each query with the page its SESSION and OFFSET
 * select, and rejects any query no page was built for.
 *
 * The builder the page-identity cases use: what they prove is which slice of
 * which session's result the table asked for after its node or its session
 * changed, so the answer has to depend on exactly those two coordinates rather
 * than on how many calls came before.
 *
 * @param source The source the responses answer for.
 * @param pageFor The page for a session and a requested offset, or `undefined`
 * when the case built none for them.
 * @returns The stub provider.
 */
function slicingProvider(
  source: SpanSource,
  pageFor: (sessionId: string, offset: number) => SpanPage | undefined,
): StubProvider {
  const queries: DataQuery[] = [];
  const resolve = vi.fn<DataQueryResolver>((query, context) => {
    queries.push(query);

    const offset = query.offset ?? DATA_QUERY_DEFAULT_OFFSET;
    const page = pageFor(context.sessionId, offset);

    if (page === undefined) {
      return Promise.reject(
        new Error(`no page was built for ${context.sessionId} at offset ${String(offset)}`),
      );
    }

    return Promise.resolve<DataQueryResponse>({
      source,
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    });
  });

  return { provider: createDataProvider(resolve), queries, resolve };
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

  /** The optional filter/sort report spy, supplied so cases can assert on it. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host —
 * and the optional sort report is supplied too, so every case can assert not
 * only that the intent it exercised was raised but also that the others were
 * not: activating a chip must not also select a row, and selecting a row must
 * not report a filter change.
 *
 * @returns The actions object and its three spies.
 */
function makeActions(): ActionSpies {
  const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
  const onOpenSource = vi.fn<(location: SourceLocation) => void>();
  const onFilterChange = vi.fn<(nodeId: string, filter: Record<string, string>) => void>();

  return {
    actions: { onSelectEvent, onOpenSource, onFilterChange },
    onSelectEvent,
    onOpenSource,
    onFilterChange,
  };
}

/** What the component is rendered inside: the host's provider, actions and session. */
interface HostContext {
  /** The provider that resolves the node's query. */
  readonly provider: DataProvider;

  /** The actions the component reports to. */
  readonly actions: PanelActions;

  /** The session `PanelSessionContext` carries; the fixture session when omitted. */
  readonly sessionId?: string | undefined;
}

/**
 * The component inside all three host contexts, as `PanelHost` nests them.
 *
 * @param node The node to draw.
 * @param context The provider, actions and session to render it inside.
 * @returns The element tree.
 */
function hostTree(node: TableNode, context: HostContext): ReactElement {
  return (
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={context.sessionId ?? SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <SpanTable node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>
  );
}

/**
 * Renders the component inside both host contexts.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 * @returns The render result, for a case that re-renders the same mounted table.
 */
function renderComponent(node: TableNode, context: HostContext): RenderResult {
  return render(hostTree(node, context));
}

/**
 * Re-renders an already mounted table with a new node or a new host context —
 * the same component instance, so its paging state survives unless the
 * component itself decides it no longer applies.
 *
 * @param view What {@link renderComponent} returned.
 * @param node The node to draw now.
 * @param context The provider, actions and session to render it inside now.
 */
function rerenderComponent(view: RenderResult, node: TableNode, context: HostContext): void {
  view.rerender(hostTree(node, context));
}

/**
 * Renders the component between two ordinary controls, for the keyboard cases:
 * the Tab order is only observable against something before and after it.
 *
 * @param node The node to draw.
 * @param context The provider, actions and session to render it inside.
 * @returns The render result.
 */
function renderBetweenControls(node: TableNode, context: HostContext): RenderResult {
  return render(
    <>
      <Button>{BEFORE_TABLE}</Button>
      {hostTree(node, context)}
      <Button>{AFTER_TABLE}</Button>
    </>,
  );
}

/**
 * Moves focus to an element directly, as a reader's previous Tab would have.
 *
 * @param element The element to focus.
 */
function focusDirectly(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
}

/**
 * Every element inside the grid that is in the page's Tab order.
 *
 * Read off the DOM property rather than the attribute, so a button that
 * carries no `tabindex` attribute — and is therefore a Tab stop by default —
 * counts, exactly as a browser would count it.
 *
 * @param grid The grid.
 * @returns Its Tab stops, in document order.
 */
function tabStopsIn(grid: HTMLElement): HTMLElement[] {
  return Array.from(
    grid.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
  ).filter((element) => element.tabIndex >= 0);
}

/**
 * The tooltip bubble a trigger names among its `aria-describedby` tokens.
 *
 * @param trigger The trigger.
 * @returns The bubble.
 */
function bubbleOf(trigger: HTMLElement): HTMLElement {
  const tokens = (trigger.getAttribute('aria-describedby') ?? '').split(/\s+/);
  const bubble = tokens
    .map((token) => document.getElementById(token))
    .find((element) => element?.getAttribute('role') === 'tooltip');

  if (bubble === undefined || bubble === null) {
    throw new Error('the trigger names no tooltip bubble');
  }

  return bubble;
}

/**
 * A row's operation name: the text in its header cell, which is also the
 * trigger of the tooltip holding the whole name.
 *
 * @param row A data row.
 * @returns The name element.
 */
function nameTriggerIn(row: HTMLElement): HTMLElement {
  const name = within(row)
    .getByRole('rowheader')
    .querySelector<HTMLElement>('.dg-span-table__name-cell');

  if (name === null) {
    throw new Error('the row renders no operation name');
  }

  return name;
}

/**
 * The bubble of the name's tooltip. The name reads its own text out, so the
 * bubble describes nothing and is not named by `aria-describedby`; it is the
 * tooltip inside the name's own wrapper.
 *
 * @param name The name element.
 * @returns Its bubble.
 */
function nameBubbleOf(name: HTMLElement): HTMLElement {
  const bubble = name.closest('.dg-tooltip')?.querySelector<HTMLElement>('[role="tooltip"]');

  if (bubble === undefined || bubble === null) {
    throw new Error('the name carries no tooltip');
  }

  return bubble;
}

/**
 * The grid's data rows, in document order.
 *
 * Obtained by role and then narrowed by the attribute the primitive writes on
 * a data row, because the header row and any detail row are `role="row"` too
 * and a bare role query would count them.
 *
 * @returns The data rows.
 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-row-index') !== null);
}

/**
 * The identity text of each data row, in document order.
 *
 * Read off the row's header cell — obtained by role — and then from the
 * component's own name element inside it, so a row carrying a status chip or a
 * source chip contributes its operation name and nothing else.
 *
 * @returns One name per row.
 */
function renderedNames(): string[] {
  return dataRows().map((row) => {
    const header = within(row).getByRole('rowheader');

    return header.querySelector('.dg-span-table__name-cell')?.textContent ?? '';
  });
}

/**
 * The data row whose operation name is `name`.
 *
 * @param name The operation name to find.
 * @returns That row.
 */
function rowNamed(name: string): HTMLElement {
  const row = dataRows()[renderedNames().indexOf(name)];

  if (row === undefined) {
    throw new Error(`no rendered row is named "${name}"`);
  }

  return row;
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

/**
 * What the header cell holding the named sort control reports as `aria-sort`.
 *
 * Read off the cell, never the control: the primitive reports an ordering on
 * the `columnheader`, which is where a reader asks for it.
 *
 * @param name The accessible name of the column's sort control.
 * @returns The cell's `aria-sort`, or `null` when it carries none.
 */
function sortStateOf(name: string): string | null {
  const cell = screen.getByRole('button', { name }).closest('[role="columnheader"]');

  if (cell === null) {
    throw new Error(`the "${name}" sort control sits in no column header`);
  }

  return cell.getAttribute('aria-sort');
}

/**
 * The footer's text, found by the coverage sentence every footer opens with.
 *
 * @returns The footer text, or `null` when no footer is rendered.
 */
function footerText(): string | null {
  return screen.queryByText(/^Showing /)?.textContent ?? null;
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
 * The three rows most cases draw
 *
 * Distinct durations, distinct kinds and distinct tiers, so a per-row
 * assertion cannot pass by matching the wrong row; one of them carries a
 * resolved source location and the others do not, which is what lets the
 * selection case activate a row with no chip in it.
 *
 * Deliberately NOT in duration order: the ordering cases render them exactly
 * as the provider hands them over.
 * ---------------------------------------------------------------------------
 */

/** A server-tier function span with a resolved source location. */
const FUNCTION_ROW = makeEvent({
  id: 'event-example-0001',
  spanId: spanIdFor(1),
  name: 'example.operation',
  kind: 'function',
  tier: 'server',
  startTime: BASE_START_MS + 8,
  duration: 640,
  seq: 0,
  ingestSeq: 1,
  source: BASE_SOURCE,
});

/** A database span, the slowest of the three, with no resolved location. */
const QUERY_ROW = makeEvent({
  id: 'event-example-0002',
  spanId: spanIdFor(2),
  name: 'example.query',
  kind: 'db.query',
  tier: 'db',
  startTime: BASE_START_MS + 24,
  duration: 1175,
  seq: 1,
  ingestSeq: 2,
});

/** The earliest span, and the fastest: the origin of the relative start column. */
const REQUEST_ROW = makeEvent({
  id: 'event-example-0003',
  spanId: spanIdFor(3),
  name: 'example.request',
  kind: 'http.server',
  tier: 'server',
  startTime: BASE_START_MS,
  duration: 12,
  seq: 2,
  ingestSeq: 3,
});

/** The three rows in the order the provider returns them below. */
const PROVIDER_ORDER: readonly TelemetryEvent[] = [FUNCTION_ROW, QUERY_ROW, REQUEST_ROW];

/**
 * A browser-tier fetch span, for the view-order cases: with it the page spans
 * all three tiers, and its name, kind label, start and duration each fall
 * strictly between two of the other rows'.
 */
const FETCH_ROW = makeEvent({
  id: 'event-example-0004',
  spanId: spanIdFor(4),
  name: 'example.fetch',
  kind: 'fetch',
  tier: 'browser',
  startTime: BASE_START_MS + 16,
  duration: 300,
  seq: 3,
  ingestSeq: 4,
});

/**
 * Four rows in an order matching none of the view orders the cases ask for —
 * by name, kind label, tier, start or duration, in either direction — so every
 * arrangement asserted below can only have been produced by the component.
 * The two server-tier rows are not adjacent, which is what lets the Tier cases
 * prove the tie-break is the provider's position in both directions.
 */
const MIXED_ORDER: readonly TelemetryEvent[] = [REQUEST_ROW, QUERY_ROW, FETCH_ROW, FUNCTION_ROW];

/**
 * A page of `count` distinct server-tier function spans, for the paging cases
 * whose assertion depends on how many rows arrived rather than on which.
 *
 * Ids, span ids, sequence numbers and names are all derived from the ordinal,
 * so no two rows of a page — or of two pages built from different ordinal bases
 * — share an identity.
 *
 * @param count How many rows the page holds.
 * @param first The ordinal of the first row; later rows count up from it.
 * @returns A fresh page.
 */
function makePage(count: number, first = 1): TelemetryEvent[] {
  return Array.from({ length: count }, (_unused, index) => {
    const ordinal = first + index;

    return makeEvent({
      id: `event-example-page-${String(ordinal).padStart(4, '0')}`,
      spanId: spanIdFor(ordinal),
      name: `example.page.operation.${String(ordinal)}`,
      startTime: BASE_START_MS + ordinal,
      duration: ordinal,
      seq: ordinal,
      ingestSeq: ordinal,
    });
  });
}

/** Their names, in that same order. */
const PROVIDER_ORDER_NAMES: readonly string[] = PROVIDER_ORDER.map((event) => event.name);

describe('SpanTable states', () => {
  it('renders the loading state, and no rows, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes only the
    // element class that places it.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.classList.contains('dg-span-table__loading')).toBe(true);

    // Labelled with what is resolving, not the bare default.
    expect(busy.textContent).toBe(LOADING_LABEL);

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer.
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();

    // One query, and it was issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders its own empty message, and no rows, for a successful empty page', async () => {
    const stub = resolvingProvider('spans', []);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic substring of the product's own copy rather than by a
    // restatement of the sentence, then checked to be exactly that: product
    // vocabulary, naming no inspected project.
    const message = await screen.findByText(/no spans were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.textContent).toBe(EMPTY_CAPTURE_MESSAGE);

    for (const name of PROVIDER_ORDER_NAMES) {
      expect(message.textContent).not.toContain(name);
    }
    expect(message.textContent).not.toContain(SOURCE_FILE);

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure, and there is no grid to hold rows.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-span-table__error')).toBe(true);

    // The provider's own message and code reach the reader, rather than a
    // generic sentence written over them.
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full. It serialises as JSON with sorted
    // keys, so it is compared as a value rather than as a spelling.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'spans',
      sort: SLOWEST_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
    });

    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The retry an error state offers is only useful if it really re-queries.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual(queryOfCall(stub, 1));

    // No rows were invented behind the failure.
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('renders a provider rejection through the shared error-state contract', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', PROVIDER_CAUSE, { hint: PROVIDER_HINT }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A lone failure is the assertive announcement.
    const alert = await screen.findByRole('alert');

    // The one title every failed view carries, and a message that opens with the
    // generic lead and keeps the provider's own cause after it.
    expect(within(alert).getByText(QUERY_FAILURE_TITLE)).toBeDefined();

    const message = alert.querySelector('.dg-error-state__message');
    expect(message?.textContent?.startsWith(QUERY_FAILURE_LEAD)).toBe(true);
    expect(message?.textContent).toContain(PROVIDER_CAUSE);

    // The hint stands on its own line, and the code is a chip rather than prose.
    expect(within(alert).getByText(PROVIDER_HINT).classList).toContain('dg-error-state__message');
    expect(within(alert).getByText('TRANSPORT_DISCONNECTED').closest('.dg-badge')).not.toBeNull();

    // The query block holds exactly the query that was asked. `<details>` is a
    // group too, so the block is always looked up by its name.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual(soleQuery(stub));

    // The retry carries the key the host's node frame restores focus by.
    expect(
      within(alert).getByRole('button', { name: RETRY_NAME }).getAttribute('data-dg-focus-key'),
    ).toBe(RETRY_FOCUS_KEY);
  });

  it('reports a node whose query names a source it cannot draw, and asks for nothing', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);

    renderComponent(makeNode({ query: { source: 'renders' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-span-table__error')).toBe(true);

    // The node's own query is what the reader is shown, and no retry is offered:
    // re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'renders' });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('grid')).toBeNull();
  });
});

describe('SpanTable rows', () => {
  it('draws one row per record, with its name, kind, tier, start and duration', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The grid is named by the node's caption, which falls back to the catalog's
    // own label when the node carries no title of its own. Spelled out rather
    // than read back through `catalogEntryFor`, so this case pins the label a
    // reader hears instead of restating whatever the catalog currently holds.
    await screen.findByRole('grid', { name: 'Span table' });
    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);

    // The earliest record on screen is the reference point for the relative
    // start column, whatever order the rows are in.
    const origin = Math.min(...PROVIDER_ORDER.map((event) => event.startTime));

    for (const event of PROVIDER_ORDER) {
      const row = rowNamed(event.name);

      // The identity cell is the row's header, so a reader hears the row named.
      const header = within(row).getByRole('rowheader');
      expect(header.querySelector('.dg-span-table__name-cell')?.textContent).toBe(event.name);

      // The kind chip carries the kind scale as a token reference, never a colour.
      const kindChip = within(row).getByText(formatKindLabel(event.kind));
      expect(kindChip.classList.contains('dg-badge')).toBe(true);
      expect(kindChip.classList.contains('dg-badge--soft')).toBe(true);
      expect(kindChip.getAttribute('style')).toContain(kindColorVar(event.kind));

      // The tier chip is the outline variant of the same primitive.
      const tierChip = within(row).getByText(formatTierLabel(event.tier));
      expect(tierChip.classList.contains('dg-badge--outline')).toBe(true);
      expect(tierChip.getAttribute('style')).toContain(tierColorVar(event.tier));

      // Formatted, with its unit, and placed by this component's element class.
      const duration = within(row).getByText(formatDuration(event.duration));
      expect(duration.classList.contains('dg-duration-cell')).toBe(true);
      expect(duration.classList.contains('dg-span-table__duration-cell')).toBe(true);

      // The start column is an offset from that origin, not a wall-clock time.
      expect(within(row).getByText(formatOffset(event.startTime, origin))).toBeDefined();
      expect(row.textContent).not.toContain(String(event.startTime));
    }

    // One literal, to prove a duration is rendered as a scaled quantity rather
    // than as the raw millisecond number the capture carried.
    expect(within(rowNamed(QUERY_ROW.name)).getByText('1.175 s')).toBeDefined();
    expect(within(rowNamed(REQUEST_ROW.name)).getByText('12.00 ms')).toBeDefined();

    // Five columns, in the catalog's order: every field the `table` entry reads.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Operation',
      'Kind',
      'Tier',
      'Start',
      'Duration',
    ]);
  });

  it('uses the node title as the grid caption when the node carries one', async () => {
    const stub = resolvingProvider('spans', [FUNCTION_ROW]);

    renderComponent(makeNode({ title: 'Slowest operations' }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: 'Slowest operations' });
  });

  it('renders rows in the order the provider returned them, without re-sorting', async () => {
    // The page is deliberately not in duration order (640 ms, 1175 ms, 12 ms)
    // while the node asks for `duration_desc`: the service applied the ordering
    // it was given, so a component that re-ranked the page locally would show
    // an order no response ever reported.
    const stub = resolvingProvider('spans', PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);

    // Stated as a property too, so the intent survives a fixture change: the
    // rendered order is not the duration ranking.
    const durations = PROVIDER_ORDER.map((event) => event.duration);
    expect(durations).not.toEqual([...durations].sort((left, right) => right - left));
  });

  it('keeps the whole of an ellipsized operation name one hover or focus away', async () => {
    // Far wider than any Operation column: the cell ellipsizes it, so the
    // tooltip is where the reader finds the rest - down to its last word.
    const longName = `${'example.long-operation-segment.'.repeat(8)}final-segment`;
    const record = makeEvent({ ...FUNCTION_ROW, name: longName });
    const stub = resolvingProvider('spans', [record]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    const name = nameTriggerIn(rowNamed(longName));
    const bubble = nameBubbleOf(name);

    // The cell itself still truncates: the text is whole, the ellipsis is CSS.
    expect(name.classList.contains('dg-span-table__name-cell')).toBe(true);
    expect(name.textContent).toBe(longName);

    // The bubble carries the whole name, and describes nothing: the name reads
    // its own text out, so a reader hears it once.
    expect(bubble.textContent).toBe(longName);
    expect(bubble.getAttribute('aria-hidden')).toBe('true');
    expect(name.hasAttribute('aria-describedby')).toBe(false);
    expect(name.hasAttribute('title')).toBe(false);

    // Focus opens it - the route the grid's keys take onto the name.
    expect(name.getAttribute('tabindex')).toBe('-1');
    act(() => {
      name.focus();
    });
    expect(bubble.classList.contains('dg-is-open')).toBe(true);
  });
});

describe('SpanTable ordering', () => {
  it('turns a header activation into a new query and follows the response', async () => {
    // Two pages: the node's own `start_asc` ordering, then whatever the service
    // returns for `duration_desc`. The second page is a different order of the
    // same records, which is the only way to tell "the rows follow the new
    // response" from "the rows were re-ordered in the browser".
    const reordered: readonly TelemetryEvent[] = [QUERY_ROW, FUNCTION_ROW, REQUEST_ROW];
    const stub = pagingProvider('spans', [{ data: PROVIDER_ORDER }, { data: reordered }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(
      makeNode({
        query: { source: 'spans', sort: EARLIEST_FIRST, limit: DATA_QUERY_DEFAULT_LIMIT },
      }),
      { provider: stub.provider, actions: spies.actions },
    );

    await screen.findByRole('grid');
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
    expect(soleQuery(stub).sort).toBe(EARLIEST_FIRST);

    // The header reports the ordering that was applied, not one the service was
    // never asked for.
    const durationHeader = screen
      .getByRole('button', { name: DURATION_SORT_NAME })
      .closest('[role="columnheader"]');
    expect(durationHeader?.getAttribute('aria-sort')).toBe('none');
    expect(
      screen
        .getByRole('button', { name: START_SORT_NAME })
        .closest('[role="columnheader"]')
        ?.getAttribute('aria-sort'),
    ).toBe('ascending');

    await user.click(screen.getByRole('button', { name: DURATION_SORT_NAME }));

    // A re-query, with the ordering the data layer understands.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const requeried = queryOfCall(stub, 2);
    expect(requeried.sort).toBe(SLOWEST_FIRST);
    expect(requeried.source).toBe('spans');
    expect(requeried.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    // A new ordering is a new page sequence, so it starts at the node's offset.
    expect(requeried.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    // And the rows follow that response, in its order — the rows of the first
    // page are the same records, so an order that matched the second response
    // could only have come from the second response.
    const reorderedNames = reordered.map((event) => event.name);
    await waitFor(() => {
      expect(renderedNames()).toEqual(reorderedNames);
    });
    expect(
      screen
        .getByRole('button', { name: DURATION_SORT_NAME })
        .closest('[role="columnheader"]')
        ?.getAttribute('aria-sort'),
    ).toBe('descending');

    // The host is told, so it can remember the reader's choice; it is a report
    // of a selection and carries no query shape.
    expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).toHaveBeenCalledWith(NODE_ID, { sort: 'duration_desc' });
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('flips the applied Duration order over the loaded rows, and flips it back, without a query', async () => {
    // The node asks for `duration_desc` and the service applied it, so the page
    // is drawn as the service ranked it; no total is reported, so the loaded
    // rows cannot be known to be the whole result.
    const stub = resolvingProvider('spans', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    expect(sortStateOf(DURATION_SORT_NAME)).toBe('descending');

    await user.click(screen.getByRole('button', { name: DURATION_SORT_NAME }));

    // Shortest first is not an ordering the data layer offers, so it is a view
    // order: no query, the loaded rows arranged by duration, and the header
    // reporting the order that is on screen rather than staying descending.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(sortStateOf(DURATION_SORT_NAME)).toBe('ascending');
    expect(renderedNames()).toEqual([REQUEST_ROW.name, FUNCTION_ROW.name, QUERY_ROW.name]);
    expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { sort: 'duration_asc' });

    // The order covers only what is loaded, and the footer says so.
    expect(footerText()).toBe(
      `Showing ${formatCount(3)} spans. The total for this query was not reported. ${viewOrderScopeSentence(3)}`,
    );

    await user.click(screen.getByRole('button', { name: DURATION_SORT_NAME }));

    // Longest first is the order the service already applied: returning to it
    // clears the view order with no re-query, and the rows are the service's
    // own again, in its order.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(sortStateOf(DURATION_SORT_NAME)).toBe('descending');
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
    expect(spies.onFilterChange).toHaveBeenCalledTimes(2);
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { sort: 'duration_desc' });
    expect(screen.queryByText(/This order covers only/)).toBeNull();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it.each([{ source: 'spans' as const }, { source: 'events' as const }])(
    'opens a $source node that names no order longest first, asked for and stated, so the first Duration activation flips it',
    async ({ source }) => {
      // No `sort` authored. The table asks for its own opening order rather
      // than leaving the order to a per-source service default it would have
      // to guess, and the header states that order from the first paint.
      const stub = resolvingProvider(source, PROVIDER_ORDER);
      const spies = makeActions();
      const user = userEvent.setup();

      renderComponent(makeNode({ query: { source, limit: DATA_QUERY_DEFAULT_LIMIT } }), {
        provider: stub.provider,
        actions: spies.actions,
      });

      await screen.findByRole('grid');
      expect(soleQuery(stub).sort).toBe(SLOWEST_FIRST);
      expect(sortStateOf(DURATION_SORT_NAME)).toBe('descending');
      expect(sortStateOf(START_SORT_NAME)).toBe('none');
      expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);

      // The first activation of the Duration header is a visible change:
      // shortest first, over the loaded rows, with no re-query — never a
      // "descending" announced over the order already on screen.
      await user.click(screen.getByRole('button', { name: DURATION_SORT_NAME }));
      expect(stub.resolve).toHaveBeenCalledTimes(1);
      expect(sortStateOf(DURATION_SORT_NAME)).toBe('ascending');
      expect(renderedNames()).toEqual([REQUEST_ROW.name, FUNCTION_ROW.name, QUERY_ROW.name]);
      expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
      expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { sort: 'duration_asc' });

      // And back: the opening order is the applied service order, so returning
      // to it clears the view order without a query.
      await user.click(screen.getByRole('button', { name: DURATION_SORT_NAME }));
      expect(stub.resolve).toHaveBeenCalledTimes(1);
      expect(sortStateOf(DURATION_SORT_NAME)).toBe('descending');
      expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
      expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { sort: 'duration_desc' });
    },
  );

  it.each([
    {
      column: 'Operation, by name',
      control: OPERATION_SORT_NAME,
      report: 'name',
      ascending: [FETCH_ROW, FUNCTION_ROW, QUERY_ROW, REQUEST_ROW],
      descending: [REQUEST_ROW, QUERY_ROW, FUNCTION_ROW, FETCH_ROW],
    },
    {
      column: 'Kind, by the label its chip displays',
      control: KIND_SORT_NAME,
      report: 'kind',
      ascending: [QUERY_ROW, FETCH_ROW, FUNCTION_ROW, REQUEST_ROW],
      descending: [REQUEST_ROW, FUNCTION_ROW, FETCH_ROW, QUERY_ROW],
    },
    {
      // Pipeline order, then its reverse. The two server rows keep the
      // provider's relative order in BOTH directions: the tie-break is the
      // service's position, never reversed with the order.
      column: 'Tier, in pipeline order',
      control: TIER_SORT_NAME,
      report: 'tier',
      ascending: [FETCH_ROW, REQUEST_ROW, FUNCTION_ROW, QUERY_ROW],
      descending: [QUERY_ROW, REQUEST_ROW, FUNCTION_ROW, FETCH_ROW],
    },
  ])(
    'orders $column both ways over the loaded rows, without a query',
    async ({ control, report, ascending, descending }) => {
      // The whole result is on the one page: four of four, and no further page.
      const stub = resolvingProvider('spans', MIXED_ORDER, {
        total: MIXED_ORDER.length,
        nextOffset: null,
      });
      const spies = makeActions();
      const user = userEvent.setup();

      renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

      await screen.findByRole('grid');
      expect(sortStateOf(control)).toBe('none');

      await user.click(screen.getByRole('button', { name: control }));

      expect(sortStateOf(control)).toBe('ascending');
      expect(sortStateOf(DURATION_SORT_NAME)).toBe('none');
      expect(renderedNames()).toEqual(ascending.map((event) => event.name));
      expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { sort: `${report}_asc` });

      await user.click(screen.getByRole('button', { name: control }));

      expect(sortStateOf(control)).toBe('descending');
      expect(renderedNames()).toEqual(descending.map((event) => event.name));
      expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { sort: `${report}_desc` });
      expect(spies.onFilterChange).toHaveBeenCalledTimes(2);

      // Neither arrangement asked the service for anything, and — every row the
      // query matched being loaded — neither needed a word about its scope.
      expect(stub.resolve).toHaveBeenCalledTimes(1);
      expect(footerText()).toBe(`Showing ${formatCount(4)} of ${formatCount(4)} spans.`);
      expect(spies.onSelectEvent).not.toHaveBeenCalled();
    },
  );

  it('orders Start earliest first through the service, and latest first over the loaded rows', async () => {
    const earliestFirst: readonly TelemetryEvent[] = [
      REQUEST_ROW,
      FUNCTION_ROW,
      FETCH_ROW,
      QUERY_ROW,
    ];
    const stub = pagingProvider('spans', [
      { data: MIXED_ORDER, total: MIXED_ORDER.length, nextOffset: null },
      { data: earliestFirst, total: earliestFirst.length, nextOffset: null },
    ]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: START_SORT_NAME }));

    // Earliest first is the service's `start_asc`: a re-query, reported under
    // exactly the data layer's name, with the rows following its response.
    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).sort).toBe(EARLIEST_FIRST);
    expect(queryOfCall(stub, 2).offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    await waitFor(() => {
      expect(renderedNames()).toEqual(earliestFirst.map((event) => event.name));
    });
    expect(sortStateOf(START_SORT_NAME)).toBe('ascending');
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { sort: 'start_asc' });

    await user.click(screen.getByRole('button', { name: START_SORT_NAME }));

    // Latest first is a view order over those rows: no further query.
    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(sortStateOf(START_SORT_NAME)).toBe('descending');
    expect(renderedNames()).toEqual(
      [QUERY_ROW, FETCH_ROW, FUNCTION_ROW, REQUEST_ROW].map((event) => event.name),
    );
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { sort: 'start_desc' });
    expect(spies.onFilterChange).toHaveBeenCalledTimes(2);
  });

  it('compares operation names with their digit runs read as numbers', async () => {
    // A character-by-character comparison would put `…10` between `…1` and `…2`.
    const page = [...makePage(1, 10), ...makePage(1, 2), ...makePage(1, 1)];
    const stub = resolvingProvider('spans', page, { total: page.length, nextOffset: null });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: OPERATION_SORT_NAME }));

    expect(renderedNames()).toEqual([
      'example.page.operation.1',
      'example.page.operation.2',
      'example.page.operation.10',
    ]);
  });

  it('keeps the activated header control, and its focus, while a service re-query loads', async () => {
    // The first call answers at once; the re-query waits until the case
    // releases it, so the in-flight state can be observed without a timer.
    const releases: ((response: DataQueryResponse) => void)[] = [];
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({ source: 'spans', data: PROVIDER_ORDER })
        : new Promise<DataQueryResponse>((resolve) => {
            releases.push(resolve);
          }),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const control = screen.getByRole('button', { name: START_SORT_NAME });

    await user.click(control);

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).sort).toBe(EARLIEST_FIRST);

    // The grid and its header stay mounted while the re-query is in flight: the
    // loading state sits in the grid's empty slot, outside its rows, and no row
    // of the previous order is drawn under the new indicator. The control the
    // reader activated is the very same element, and it still holds focus.
    const grid = screen.getByRole('grid');
    const busy = screen.getByRole('status');
    expect(busy.classList.contains('dg-span-table__loading')).toBe(true);
    expect(within(grid).queryByRole('status')).toBeNull();
    expect(dataRows()).toHaveLength(0);
    expect(sortStateOf(START_SORT_NAME)).toBe('ascending');
    expect(screen.getByRole('button', { name: START_SORT_NAME })).toBe(control);
    expect(document.activeElement).toBe(control);

    const release = releases[0];
    if (release === undefined) {
      throw new Error('the re-query was never issued');
    }

    const earliestFirst: readonly TelemetryEvent[] = [REQUEST_ROW, FUNCTION_ROW, QUERY_ROW];
    release({ source: 'spans', data: earliestFirst });

    await waitFor(() => {
      expect(renderedNames()).toEqual(earliestFirst.map((event) => event.name));
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('grid')).toBe(grid);
    expect(screen.getByRole('button', { name: START_SORT_NAME })).toBe(control);
    expect(document.activeElement).toBe(control);
  });

  it('keeps the header on screen when a service re-query fails, and retries it', async () => {
    const stub = recordingProvider((_query, call) =>
      call === 2
        ? Promise.reject(
            new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
          )
        : Promise.resolve<DataQueryResponse>({ source: 'spans', data: PROVIDER_ORDER }),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const control = screen.getByRole('button', { name: START_SORT_NAME });

    await user.click(control);

    // The failure is stated in the grid's empty slot, with the query that failed
    // and a retry; the header — and the reader's focus on it — stays put.
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-span-table__error')).toBe(true);
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');
    expect(
      JSON.parse(within(alert).getByRole('group', { name: FAILING_QUERY_NAME }).textContent ?? ''),
    ).toEqual({
      source: 'spans',
      sort: EARLIEST_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
    });
    expect(within(screen.getByRole('grid')).queryByRole('alert')).toBeNull();
    expect(dataRows()).toHaveLength(0);
    expect(screen.getByRole('button', { name: START_SORT_NAME })).toBe(control);
    expect(document.activeElement).toBe(control);

    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3)).toEqual(queryOfCall(stub, 2));
    await waitFor(() => {
      expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a view order covers only the loaded rows, and keeps it across Load more', async () => {
    // A four-row result in two pages, each in the service's `duration_desc`
    // order as the node asks.
    const stub = pagingProvider('spans', [
      { data: [QUERY_ROW, FUNCTION_ROW], total: 4, nextOffset: 2 },
      { data: [FETCH_ROW, REQUEST_ROW], total: 4, nextOffset: null },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // The service's own order ranks the whole result: nothing to qualify.
    expect(screen.queryByText(/This order covers only/)).toBeNull();

    await user.click(screen.getByRole('button', { name: OPERATION_SORT_NAME }));

    // Two of four rows are loaded, so the arrangement is of those two only, and
    // the footer says so rather than letting them pass for the whole ranking.
    expect(renderedNames()).toEqual([FUNCTION_ROW.name, QUERY_ROW.name]);
    expect(footerText()).toBe(
      `Showing ${formatCount(2)} of ${formatCount(4)} spans. ${pageSizeSentence(DATA_QUERY_DEFAULT_LIMIT)} ${viewOrderScopeSentence(2)}`,
    );

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next page is requested in the SERVICE's order from the offset it
    // named: a view order never reaches the query.
    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual({
      source: 'spans',
      sort: SLOWEST_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: 2,
    });

    // And the view order is re-applied to every accumulated row.
    await waitFor(() => {
      expect(renderedNames()).toEqual(
        [FETCH_ROW, FUNCTION_ROW, QUERY_ROW, REQUEST_ROW].map((event) => event.name),
      );
    });
    expect(sortStateOf(OPERATION_SORT_NAME)).toBe('ascending');

    // Every row the query matched is loaded now, so the order covers all of it
    // and the footer is the count alone.
    expect(screen.queryByText(/This order covers only/)).toBeNull();
    expect(footerText()).toBe(`Showing ${formatCount(4)} of ${formatCount(4)} spans.`);
  });
});

describe('SpanTable interactions', () => {
  it('hands the host the very location a row resolved to, and selects nothing', async () => {
    const stub = resolvingProvider('spans', [FUNCTION_ROW]);
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

    // Opening source is not selecting a row: the chip's activation stops at the
    // chip, so the row it sits in is not activated as well.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('draws no chip for a row the capture could not resolve to a location', async () => {
    const stub = resolvingProvider('spans', [QUERY_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const row = within(await screen.findByRole('grid')).getByRole('row', { name: /example.query/ });

    expect(within(row).queryByRole('button')).toBeNull();
    expect(row.textContent).not.toContain(SOURCE_FILE);
  });

  it('announces the activated row as the event it stands for', async () => {
    const stub = resolvingProvider('spans', [QUERY_ROW]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    expect(row.getAttribute('aria-selected')).toBe('false');

    await user.click(row);

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    const ref = call[0];

    // The three identifiers the host needs to resolve the record, taken from
    // that row's own event and nothing else.
    expect(ref).toEqual({
      eventId: QUERY_ROW.id,
      spanId: QUERY_ROW.spanId,
      traceId: QUERY_ROW.traceId,
    });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // The row shows that the click landed where the reader aimed.
    expect(dataRows()[0]?.getAttribute('aria-selected')).toBe('true');

    // Selecting a record is not opening its source, and it is not a filter.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });
});

describe('SpanTable keyboard', () => {
  it('is one Tab stop of the page, entered on the active row, whose Tab walks that row alone', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);
    const user = userEvent.setup();

    renderBetweenControls(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid');
    const chip = within(grid).getByRole('button', { name: SOURCE_CHIP_NAME });
    const [firstRow, secondRow] = dataRows();
    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('the grid rendered fewer than two data rows');
    }
    const name = nameTriggerIn(firstRow);

    // The name and the chip stay focusable, and leave the page's Tab order.
    expect(chip.getAttribute('tabindex')).toBe('-1');
    expect(name.getAttribute('tabindex')).toBe('-1');

    // Before focus: one stop in the whole grid, and it is the active row.
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(tabStopsIn(grid)).toEqual([firstRow]);

    focusDirectly(screen.getByRole('button', { name: BEFORE_TABLE }));
    await user.tab();
    expect(document.activeElement).toBe(firstRow);
    expect(tabStopsIn(grid)).toEqual([firstRow]);

    // Tab walks the active row's own controls, in document order: the name,
    // whose whole value opens with its focus, then the source chip.
    await user.tab();
    expect(document.activeElement).toBe(name);
    expect(nameBubbleOf(name).classList.contains('dg-is-open')).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(chip);

    // The Tab after the row's last control leaves the grid, past every other
    // row and the header's sort controls.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: AFTER_TABLE }));

    // Moving the roving stop keeps exactly one of it, and Tab returns to it.
    await user.tab({ shift: true });
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(secondRow);
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(tabStopsIn(grid)).toEqual([secondRow]);
  });

  it('reaches the name, then the source chip, with ArrowRight and returns with ArrowLeft and Escape', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderBetweenControls(makeNode(), { provider: stub.provider, actions: spies.actions });

    const grid = await screen.findByRole('grid');
    const chip = within(grid).getByRole('button', { name: SOURCE_CHIP_NAME });
    const firstRow = rowNamed(FUNCTION_ROW.name);
    const name = nameTriggerIn(firstRow);

    focusDirectly(screen.getByRole('button', { name: BEFORE_TABLE }));
    await user.tab();
    expect(document.activeElement).toBe(firstRow);

    // Into the row: the name takes focus first, and its whole value opens.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(name);
    expect(nameBubbleOf(name).classList.contains('dg-is-open')).toBe(true);

    // Then the chip, whose full location opens with it.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chip);
    expect(bubbleOf(chip).classList.contains('dg-is-open')).toBe(true);
    expect(nameBubbleOf(name).classList.contains('dg-is-open')).toBe(false);

    // A focused control moves no Tab stop onto itself.
    expect(tabStopsIn(grid)).toEqual([firstRow]);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(name);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(firstRow);

    // Escape takes two presses: the open description first, then back to the row.
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(chip);
    await user.keyboard('{Escape}');
    expect(bubbleOf(chip).classList.contains('dg-is-open')).toBe(false);
    expect(document.activeElement).toBe(chip);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(firstRow);

    // Moving through a row is not acting on it.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('opens source exactly once from a focused chip, and selects nothing', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderBetweenControls(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    focusDirectly(screen.getByRole('button', { name: BEFORE_TABLE }));
    await user.tab();

    // Enter on a control is the control's own key, never the row's: past the
    // name, onto the chip, and activated there.
    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}');

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource).toHaveBeenCalledWith(BASE_SOURCE);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(rowNamed(FUNCTION_ROW.name).getAttribute('aria-selected')).toBe('false');
  });

  it('moves between rows with the arrow, Home and End keys, and selects with Enter and Space', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderBetweenControls(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    focusDirectly(screen.getByRole('button', { name: BEFORE_TABLE }));
    await user.tab();

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowNamed(QUERY_ROW.name));

    // Enter on the row selects it: the host hears the record, the row shows it.
    await user.keyboard('{Enter}');
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: QUERY_ROW.id,
      spanId: QUERY_ROW.spanId,
      traceId: QUERY_ROW.traceId,
    });
    expect(rowNamed(QUERY_ROW.name).getAttribute('aria-selected')).toBe('true');
    expect(rowNamed(QUERY_ROW.name).classList.contains('dg-is-selected')).toBe(true);

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rowNamed(REQUEST_ROW.name));

    // Space selects too, and the selection moves rather than accumulating.
    await user.keyboard(' ');
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(2);
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: REQUEST_ROW.id,
      spanId: REQUEST_ROW.spanId,
      traceId: REQUEST_ROW.traceId,
    });
    expect(rowNamed(REQUEST_ROW.name).classList.contains('dg-is-selected')).toBe(true);
    expect(rowNamed(QUERY_ROW.name).classList.contains('dg-is-selected')).toBe(false);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rowNamed(FUNCTION_ROW.name));
    expect(tabStopsIn(screen.getByRole('grid'))).toEqual([rowNamed(FUNCTION_ROW.name)]);

    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });
});

describe('SpanTable paging', () => {
  it('says how much of the result is on screen and appends the next page', async () => {
    // `nextOffset` deliberately differs from the length of the page: the
    // contract is that a view copies the offset the service reported, never one
    // it derived from what arrived, which drifts the moment a limit is clamped.
    const stub = pagingProvider('spans', [
      { data: [FUNCTION_ROW], total: 42, nextOffset: 5 },
      { data: [QUERY_ROW], total: 42, nextOffset: 6 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // One row of forty-two, said plainly rather than implied by a bare count,
    // with the page size each further page is requested at.
    await screen.findByText(
      `Showing ${formatCount(1)} of ${formatCount(42)} spans. ${pageSizeSentence(DATA_QUERY_DEFAULT_LIMIT)}`,
    );
    expect(dataRows()).toHaveLength(1);

    const first = soleQuery(stub);
    expect(first.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(first.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next page is requested at the offset the SERVICE reported, not at one
    // derived from the length of what arrived.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const second = queryOfCall(stub, 2);
    expect(second.offset).toBe(5);
    expect(second.offset).toBeGreaterThan(first.offset ?? DATA_QUERY_DEFAULT_OFFSET);
    expect(second.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(second.sort).toBe(SLOWEST_FIRST);
    expect(second.source).toBe('spans');

    // Appended, not replaced: the page the reader was already reading stays.
    await waitFor(() => {
      expect(renderedNames()).toEqual([FUNCTION_ROW.name, QUERY_ROW.name]);
    });
    expect(
      screen.getByText(
        `Showing ${formatCount(2)} of ${formatCount(42)} spans. ${pageSizeSentence(DATA_QUERY_DEFAULT_LIMIT)}`,
      ),
    ).toBeDefined();
  });

  it('announces the footer count politely as each page arrives', async () => {
    const stub = pagingProvider('spans', [
      { data: [FUNCTION_ROW], total: 42, nextOffset: 5 },
      { data: [QUERY_ROW], total: 42, nextOffset: 6 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The coverage sentence is its own polite region, and not a `status` role:
    // the loading state keeps that one. While a further page is offered the
    // same region also names the page size, so the reader hears both together.
    const coverage = await screen.findByText(
      `Showing ${formatCount(1)} of ${formatCount(42)} spans. ${pageSizeSentence(DATA_QUERY_DEFAULT_LIMIT)}`,
    );
    expect(coverage.getAttribute('aria-live')).toBe('polite');
    expect(coverage.getAttribute('aria-atomic')).toBe('true');
    expect(coverage.getAttribute('role')).toBeNull();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The same region, still mounted, now carries the new count — which is
    // what makes a reader hear it rather than nothing.
    await waitFor(() => {
      expect(coverage.textContent).toBe(
        `Showing ${formatCount(2)} of ${formatCount(42)} spans. ${pageSizeSentence(DATA_QUERY_DEFAULT_LIMIT)}`,
      );
    });
    expect(coverage.isConnected).toBe(true);
    expect(coverage.getAttribute('aria-live')).toBe('polite');
  });

  it('says the total is unknown rather than implying the page is the whole result', async () => {
    const stub = resolvingProvider('spans', [FUNCTION_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A service that reported no total leaves this view unable to know whether
    // more rows exist, and saying so is the only truthful option.
    const coverage = await screen.findByText(/^Showing 1 span\./);
    expect(coverage.textContent).toContain('not reported');
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('keeps the count footer when every row the query matched is loaded', async () => {
    // The whole result on one page: three of three, and the last page.
    const stub = resolvingProvider('spans', PROVIDER_ORDER, {
      total: PROVIDER_ORDER.length,
      nextOffset: null,
    });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // The count is how a reader knows the table is complete, so it is stated
    // here too — with nothing about pages, because no further page exists.
    expect(footerText()).toBe(`Showing ${formatCount(3)} of ${formatCount(3)} spans.`);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('treats an authored limit as the page size, says so, and loads past it', async () => {
    // A node authored with `limit: 2` over a three-row result: two rows first,
    // then the one the service's next page holds.
    const authoredLimit = 2;
    const stub = pagingProvider('spans', [
      { data: [QUERY_ROW, FUNCTION_ROW], total: 3, nextOffset: 2 },
      { data: [REQUEST_ROW], total: 3, nextOffset: null },
    ]);
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'spans', sort: SLOWEST_FIRST, limit: authoredLimit } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid');
    expect(soleQuery(stub).limit).toBe(authoredLimit);

    // The footer counts the page against the total and names the page size, so
    // two of three does not read as a table the panel meant to stop at two.
    expect(footerText()).toBe(
      `Showing ${formatCount(2)} of ${formatCount(3)} spans. ${pageSizeSentence(authoredLimit)}`,
    );

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The limit is the size of each page, not a cap on the table: the next page
    // is requested at that size from the offset the service named.
    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual({
      source: 'spans',
      sort: SLOWEST_FIRST,
      limit: authoredLimit,
      offset: 2,
    });

    await waitFor(() => {
      expect(renderedNames()).toEqual([QUERY_ROW.name, FUNCTION_ROW.name, REQUEST_ROW.name]);
    });
    expect(footerText()).toBe(`Showing ${formatCount(3)} of ${formatCount(3)} spans.`);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('names the starting position when the node pages from part-way through', async () => {
    const stub = resolvingProvider('spans', [FUNCTION_ROW], { total: 42, nextOffset: 21 });

    renderComponent(
      makeNode({
        query: {
          source: 'spans',
          sort: SLOWEST_FIRST,
          limit: DATA_QUERY_DEFAULT_LIMIT,
          offset: 20,
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByText(
      `Showing ${formatCount(1)} of ${formatCount(42)} spans, from position ${formatCount(21)}. ${pageSizeSentence(DATA_QUERY_DEFAULT_LIMIT)}`,
    );
    expect(soleQuery(stub).offset).toBe(20);
  });

  it('requests exactly the next offset the service reported, not one counted from the page', async () => {
    // Five rows arrive and the service names 7 as the next offset. A view that
    // counted what arrived would ask for 5; the contract is to copy the 7.
    const firstPage = makePage(5);
    const secondPage = makePage(2, 8);
    const stub = pagingProvider('spans', [
      { data: firstPage, total: 42, nextOffset: 7 },
      { data: secondPage, total: 42, nextOffset: 9 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(
      `Showing ${formatCount(5)} of ${formatCount(42)} spans. ${pageSizeSentence(DATA_QUERY_DEFAULT_LIMIT)}`,
    );
    expect(soleQuery(stub).offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).offset).toBe(7);

    await waitFor(() => {
      expect(renderedNames()).toEqual([...firstPage, ...secondPage].map((event) => event.name));
    });
  });

  it.each([
    { label: 'reports the last page with null', nextOffset: null },
    { label: 'omits the next offset', nextOffset: undefined },
  ])(
    'offers no further page when the service $label, and says why the total disagrees',
    async ({ nextOffset }) => {
      // The total counts forty-one rows beyond the one on screen, but the
      // service is the authority on paging: no page is invented to reach them.
      const stub = resolvingProvider('spans', [FUNCTION_ROW], { total: 42, nextOffset });

      renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

      await screen.findByText(
        `Showing ${formatCount(1)} of ${formatCount(42)} spans. The service reported no further page past this one, so the remaining ${formatCount(41)} spans cannot be loaded here.`,
      );
      expect(dataRows()).toHaveLength(1);
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
      expect(stub.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: 'stands still at the page offset', nextOffset: 20 },
    { label: 'steps back before the page offset', nextOffset: 10 },
  ])('offers no further page when the reported next offset $label', async ({ nextOffset }) => {
    const stub = resolvingProvider('spans', [FUNCTION_ROW], { total: 42, nextOffset });

    renderComponent(
      makeNode({
        query: {
          source: 'spans',
          sort: SLOWEST_FIRST,
          limit: DATA_QUERY_DEFAULT_LIMIT,
          offset: 20,
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // Following that offset would re-request the page on screen, or one the
    // service never named, so it is read as the end of the data.
    await screen.findByText(
      `Showing ${formatCount(1)} of ${formatCount(42)} spans, from position ${formatCount(21)}. The service reported no further page past this one, so the remaining ${formatCount(21)} spans cannot be loaded here.`,
    );
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer whose next offset is not a whole number, and offers no further page', async () => {
    // The host's response check rejects a counter that is not a non-negative
    // integer before the view sees the page, so no row of that answer is drawn
    // and no page is offered past it: the failure is stated, with its code.
    const stub = resolvingProvider('spans', [FUNCTION_ROW], { total: 42, nextOffset: 20.5 });

    renderComponent(
      makeNode({
        query: {
          source: 'spans',
          sort: SLOWEST_FIRST,
          limit: DATA_QUERY_DEFAULT_LIMIT,
          offset: 20,
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('PROTOCOL_INVALID_MESSAGE')).toBeDefined();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByText(FUNCTION_ROW.name)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows on screen and shows the page in flight after a forward request', async () => {
    // The first call answers with a forward page; the second never settles, so
    // the in-flight state can be observed without a timer.
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({
            source: 'spans',
            data: [FUNCTION_ROW],
            total: 42,
            nextOffset: 5,
          })
        : new Promise<DataQueryResponse>(() => undefined),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await user.click(await screen.findByRole('button', { name: LOAD_MORE_NAME }));

    expect(queryOfCall(stub, 2).offset).toBe(5);

    // The control reports the page in flight and cannot be pressed twice, and
    // the page the reader was already reading stays where it was.
    const inFlight = await screen.findByRole('button', { name: LOADING_MORE_NAME });
    expect(inFlight.hasAttribute('disabled')).toBe(true);
    expect(renderedNames()).toEqual([FUNCTION_ROW.name]);
    expect(
      screen.getByText(
        `Showing ${formatCount(1)} of ${formatCount(42)} spans. ${pageSizeSentence(DATA_QUERY_DEFAULT_LIMIT)}`,
      ),
    ).toBeDefined();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
  });

  it('reports a failed next page below the rows it keeps, scoped to that page', async () => {
    // The first call answers with a forward page; the second rejects, so the
    // failure arrives behind rows the reader is already reading.
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({
            source: 'spans',
            data: [FUNCTION_ROW],
            total: 42,
            nextOffset: 5,
          })
        : Promise.reject(new DebuggenError('TRANSPORT_DISCONNECTED', PROVIDER_CAUSE)),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await user.click(await screen.findByRole('button', { name: LOAD_MORE_NAME }));

    const alert = await screen.findByRole('alert');

    // The rows stay, and the failure says so: the page title and lead, then the
    // provider's own cause.
    expect(renderedNames()).toEqual([FUNCTION_ROW.name]);
    expect(within(alert).getByText(PAGE_FAILURE_TITLE)).toBeDefined();
    expect(alert.querySelector('.dg-error-state__message')?.textContent).toBe(
      `${PAGE_FAILURE_LEAD} ${PROVIDER_CAUSE}`,
    );

    // The query shown is the page that failed, at the offset the service named.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual(queryOfCall(stub, 2));
    expect(queryOfCall(stub, 2).offset).toBe(5);
  });
});

describe('SpanTable empty pages', () => {
  /**
   * Renders a node paging from `offset`, answered by one empty page.
   *
   * @param offset The node's authored offset, or `undefined` to author none.
   * @param extra The paging counters the empty page reports.
   * @returns The stub provider.
   */
  function renderEmptyPage(
    offset: number | undefined,
    extra: Omit<SpanPage, 'data'>,
  ): StubProvider {
    const stub = resolvingProvider('spans', [], extra);

    renderComponent(
      makeNode({
        query: {
          source: 'spans',
          sort: SLOWEST_FIRST,
          limit: DATA_QUERY_DEFAULT_LIMIT,
          ...(offset === undefined ? {} : { offset }),
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    return stub;
  }

  /**
   * Asserts the empty state carries exactly this title and message, as the
   * component's own empty element, with no grid, no alert and no busy region.
   *
   * @param title The expected first line, or `undefined` for none.
   * @param message The expected sentence.
   */
  async function expectEmptyState(title: string | undefined, message: string): Promise<void> {
    const shown = await screen.findByText(message);
    expect(shown.classList.contains('dg-empty-state__message')).toBe(true);

    const block = shown.closest('.dg-span-table__empty');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.dg-empty-state__title')?.textContent).toBe(title);

    // Only the empty capture carries the view's decorative glyph; every
    // settled empty state is the polite status rather than the busy one.
    expect(block?.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden') ?? null).toBe(
      message === EMPTY_CAPTURE_MESSAGE ? 'true' : null,
    );
    expect(screen.getByRole('status')).toBe(block);

    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
  }

  it.each([
    { label: 'a zero total from the first item', offset: undefined, total: 0 },
    { label: 'a zero total part-way through', offset: 20, total: 0 },
    { label: 'no total from the first item', offset: 0, total: undefined },
  ])('keeps the empty-capture sentence for $label', async ({ offset, total }) => {
    const stub = renderEmptyPage(offset, { total, nextOffset: null });

    await expectEmptyState(NOTHING_CAPTURED_TITLE, EMPTY_CAPTURE_MESSAGE);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'past the end', offset: 50, position: 51 },
    { label: 'exactly at the end', offset: 42, position: 43 },
  ])('says a page starting $label lies past the rows that matched', async (row) => {
    const stub = renderEmptyPage(row.offset, { total: 42, nextOffset: null });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(row.position)}, past the end of the ${formatCount(42)} spans that matched this query.`,
    );
    expect(screen.queryByText(EMPTY_CAPTURE_MESSAGE)).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(soleQuery(stub).offset).toBe(row.offset);
  });

  // The total counts rows at or after this page's position, yet the service
  // declared the end of the data: the state names the total, explains that the
  // service's paging ends here, and says how many matched rows past this
  // position cannot be loaded - without offering a page the service never named.
  it.each([
    {
      label: 'from the first item',
      offset: undefined,
      total: 42,
      noun: 'spans',
      remaining: 42,
      remainingNoun: 'spans',
    },
    {
      label: 'part-way through',
      offset: 20,
      total: 42,
      noun: 'spans',
      remaining: 22,
      remainingNoun: 'spans',
    },
    {
      label: 'for a single match',
      offset: undefined,
      total: 1,
      noun: 'span',
      remaining: 1,
      remainingNoun: 'span',
    },
  ])(
    'names the total and explains the end-of-data disagreement, $label',
    async ({ offset, total, noun, remaining, remainingNoun }) => {
      const stub = renderEmptyPage(offset, { total, nextOffset: null });

      await expectEmptyState(
        EMPTY_PAGE_TITLE,
        `${formatCount(total)} ${noun} matched this query, but none are shown on this page. The service reported no further page past this one, so the remaining ${formatCount(remaining)} ${remainingNoun} cannot be loaded here.`,
      );
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      expect(stub.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it('says where the page starts when no total was reported part-way through', async () => {
    renderEmptyPage(20, { nextOffset: null });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(21)} and holds no spans; no total was reported for this query.`,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it.each([
    {
      label: 'naming the total',
      total: 42,
      message: `This page holds none of the ${formatCount(42)} spans that matched this query, and the service reported a further page.`,
    },
    {
      label: 'with no total',
      total: undefined,
      message: 'This page holds no spans, and the service reported a further page.',
    },
  ])(
    'keeps the next page reachable from an empty page the service says is not the last, $label',
    async ({ total, message }) => {
      const stub = pagingProvider('spans', [
        { data: [], total, nextOffset: 200 },
        { data: [FUNCTION_ROW], total, nextOffset: null },
      ]);
      const user = userEvent.setup();

      renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

      await expectEmptyState(EMPTY_PAGE_TITLE, message);

      // The control sits inside the empty state, and requests exactly the
      // offset the service named.
      const loadMore = screen.getByRole('button', { name: LOAD_MORE_NAME });
      expect(loadMore.closest('.dg-span-table__empty')).not.toBeNull();

      await user.click(loadMore);

      expect(stub.resolve).toHaveBeenCalledTimes(2);
      expect(queryOfCall(stub, 2).offset).toBe(200);

      await screen.findByRole('grid');
      expect(renderedNames()).toEqual([FUNCTION_ROW.name]);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Which page sequence the accumulated pages belong to
 *
 * "Load more" keeps earlier pages in state and advances the offset. Those
 * pages belong to ONE sequence — this session, this query as authored, the
 * offset it starts from included — and the cases below re-render the SAME
 * mounted table with that sequence changed, which is how a host swaps a
 * regenerated panel in or reopens another session in the same view. The rows
 * carried from the old sequence must be dropped and the request must return to
 * the authored base offset; the advanced offset is where the OLD sequence had
 * got to, and means nothing in the new one.
 * ---------------------------------------------------------------------------
 */

/** A second fixture session, for the case that switches the panel to it. */
const OTHER_SESSION_ID = 'session-example-0002';

describe('SpanTable page identity', () => {
  it('starts over at a newly authored offset and draws nothing the previous slice accumulated', async () => {
    const stub = slicingProvider('spans', (_sessionId, offset) => {
      switch (offset) {
        case 0:
          return { data: [FUNCTION_ROW], total: 60, nextOffset: 5 };
        case 5:
          return { data: [QUERY_ROW], total: 60, nextOffset: 6 };
        case 40:
          return { data: [REQUEST_ROW], total: 60, nextOffset: 41 };
        default:
          return undefined;
      }
    });
    const context: HostContext = { provider: stub.provider, actions: makeActions().actions };
    const user = userEvent.setup();
    const authored = {
      source: 'spans',
      sort: SLOWEST_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
    } as const;

    const view = renderComponent(makeNode({ query: { ...authored, offset: 0 } }), context);

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([FUNCTION_ROW.name, QUERY_ROW.name]);
    });
    expect(queryOfCall(stub, 2).offset).toBe(5);

    // The same node, with a query identical in every respect but the offset it
    // was authored to start from: another slice of the result.
    rerenderComponent(view, makeNode({ query: { ...authored, offset: 40 } }), context);

    await waitFor(() => {
      expect(renderedNames()).toEqual([REQUEST_ROW.name]);
    });
    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3)).toEqual({ ...authored, offset: 40 });
    expect(dataRows()).toHaveLength(1);
  });

  it('starts over at the authored offset in a new session and draws nothing the earlier session answered', async () => {
    const stub = slicingProvider('spans', (sessionId, offset) => {
      if (sessionId === SESSION_ID && offset === 0) {
        return { data: [FUNCTION_ROW], total: 20, nextOffset: 5 };
      }
      if (sessionId === SESSION_ID && offset === 5) {
        return { data: [QUERY_ROW], total: 20, nextOffset: 6 };
      }
      if (sessionId === OTHER_SESSION_ID && offset === 0) {
        return { data: [REQUEST_ROW], total: 5, nextOffset: 1 };
      }
      return undefined;
    });
    const actions = makeActions().actions;
    const node = makeNode();
    const user = userEvent.setup();

    const view = renderComponent(node, { provider: stub.provider, actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([FUNCTION_ROW.name, QUERY_ROW.name]);
    });
    expect(queryOfCall(stub, 2).offset).toBe(5);

    // The very same node, drawn for another session.
    rerenderComponent(view, node, {
      provider: stub.provider,
      actions,
      sessionId: OTHER_SESSION_ID,
    });

    await waitFor(() => {
      expect(renderedNames()).toEqual([REQUEST_ROW.name]);
    });
    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(stub.resolve.mock.calls[2]?.[1].sessionId).toBe(OTHER_SESSION_ID);
    expect(queryOfCall(stub, 3).offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(dataRows()).toHaveLength(1);
  });
});

describe('SpanTable query bounds', () => {
  it('clamps a page size beyond the published maximum before asking for it', async () => {
    const stub = resolvingProvider('spans', [FUNCTION_ROW]);

    // A node whose `limit` exceeds the contract's ceiling: the service would
    // reject the query, so the request is bounded here instead.
    renderComponent(makeNode({ query: { source: 'spans', limit: DATA_QUERY_MAX_LIMIT + 1_000 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid');

    const limit = soleQuery(stub).limit ?? Number.POSITIVE_INFINITY;
    expect(limit).toBeLessThanOrEqual(DATA_QUERY_MAX_LIMIT);
    expect(limit).toBe(DATA_QUERY_MAX_LIMIT);
  });

  it.each([
    { label: 'a fractional page size down to a whole one', authored: 2.7, sent: 2 },
    { label: 'a negative page size up to zero', authored: -3, sent: 0 },
  ])('clamps $label before asking for it', async ({ authored, sent }) => {
    const stub = resolvingProvider('spans', [], { total: 0, nextOffset: null });

    renderComponent(makeNode({ query: { source: 'spans', limit: authored } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await waitFor(() => {
      expect(stub.resolve).toHaveBeenCalledTimes(1);
    });
    expect(soleQuery(stub).limit).toBe(sent);
  });

  it.each([
    { label: 'echoes the page offset as the next one', nextOffset: 0 },
    { label: 'names a forward next offset', nextOffset: 5 },
    { label: 'reports the last page', nextOffset: null },
  ])(
    'sends an explicit zero page size unchanged and never pages it when the service $label',
    async ({ nextOffset }) => {
      const stub = resolvingProvider('spans', [], { total: 42, nextOffset });

      renderComponent(makeNode({ query: { source: 'spans', limit: 0 } }), {
        provider: stub.provider,
        actions: makeActions().actions,
      });

      // A count, stated as one: the total the service reported, and a title that
      // says no rows were asked for, rather than a claim that nothing matched.
      const title = await screen.findByText(COUNT_ONLY_TITLE);
      expect(title.classList.contains('dg-empty-state__title')).toBe(true);
      expect(title.closest('.dg-span-table__empty')).not.toBeNull();
      expect(
        screen.getByText(
          `This view requests a count without rows: ${formatCount(42)} spans matched its query.`,
        ),
      ).toBeDefined();
      expect(screen.queryByText(EMPTY_CAPTURE_MESSAGE)).toBeNull();

      // Zero is a legitimate request for a total without rows: it reaches the
      // provider as zero, not raised to a one-row page.
      const query = soleQuery(stub);
      expect(query.limit).toBe(0);
      expect(query.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

      // A page of nothing cannot advance, so no control offers another one, and
      // no second request is made however the service answered.
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      expect(screen.queryByRole('grid')).toBeNull();
      expect(stub.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it('says a count-only query reported no total when the service gave none', async () => {
    const stub = resolvingProvider('spans', []);

    renderComponent(makeNode({ query: { source: 'spans', limit: 0 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(COUNT_ONLY_TITLE);
    expect(
      screen.getByText(
        'This view requests a count without rows, and no total was reported for its query.',
      ),
    ).toBeDefined();
    expect(soleQuery(stub).limit).toBe(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('says a count of one in the singular', async () => {
    const stub = resolvingProvider('spans', [], { total: 1, nextOffset: null });

    renderComponent(makeNode({ query: { source: 'spans', limit: 0 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(
      `This view requests a count without rows: ${formatCount(1)} span matched its query.`,
    );
  });

  it('asks for the published default page from the first item when the node names neither', async () => {
    const stub = resolvingProvider('events', [REQUEST_ROW]);

    renderComponent(makeNode({ query: { source: 'events' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid');

    const query = soleQuery(stub);
    expect(query.source).toBe('events');
    expect(query.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(query.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    // No ordering was authored, so the table asks for its own opening order —
    // longest first — rather than leaving it to a service default, and the
    // header states it.
    expect(query.sort).toBe(SLOWEST_FIRST);
    expect(sortStateOf(DURATION_SORT_NAME)).toBe('descending');
    expect(query.filter).toBeUndefined();
  });

  it('passes a node filter through untouched', async () => {
    const stub = resolvingProvider('spans', [FUNCTION_ROW]);

    renderComponent(
      makeNode({
        query: {
          source: 'spans',
          sort: SLOWEST_FIRST,
          limit: DATA_QUERY_DEFAULT_LIMIT,
          filter: { traceId: TRACE_ID, minDuration: 5 },
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid');

    expect(soleQuery(stub).filter).toEqual({ traceId: TRACE_ID, minDuration: 5 });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The panel's shared selection
 *
 * Under the panel host the selected row is the panel's one selection — the
 * event any view or evidence chip last selected — rather than a state of this
 * table: an evidence chip selects the underlying events, and every view marks
 * them. These cases provide that selection directly through
 * `PanelSelectionContext`, which is exactly what the host mounts, and
 * re-render with another value to move it.
 * ---------------------------------------------------------------------------
 */

/**
 * The component inside every host context, the panel's selection included.
 *
 * @param node The node to draw.
 * @param context The provider and actions to render it inside.
 * @param selection The panel's selection, or `undefined` for none.
 * @returns The element tree.
 */
function selectionTree(
  node: TableNode,
  context: HostContext,
  selection: PanelSelection | undefined,
): ReactElement {
  return (
    <PanelSelectionContext.Provider value={{ selection }}>
      {hostTree(node, context)}
    </PanelSelectionContext.Provider>
  );
}

describe('SpanTable shared selection', () => {
  it('marks the row whose event the panel selection names, and no other', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);

    render(
      selectionTree(
        makeNode(),
        { provider: stub.provider, actions: makeActions().actions },
        { eventId: QUERY_ROW.id },
      ),
    );

    await screen.findByRole('grid');

    const selected = rowNamed(QUERY_ROW.name);
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.classList.contains('dg-is-selected')).toBe(true);
    expect(rowNamed(FUNCTION_ROW.name).getAttribute('aria-selected')).toBe('false');
    expect(rowNamed(REQUEST_ROW.name).getAttribute('aria-selected')).toBe('false');
  });

  it('marks a row a selection names by its trace and span alone', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);

    // Another record's id, but this row's own span in its own trace: the pair
    // is the span's identity across tiers, so it names this row.
    render(
      selectionTree(
        makeNode(),
        { provider: stub.provider, actions: makeActions().actions },
        { eventId: 'event-example-elsewhere', traceId: TRACE_ID, spanId: REQUEST_ROW.spanId },
      ),
    );

    await screen.findByRole('grid');

    expect(rowNamed(REQUEST_ROW.name).getAttribute('aria-selected')).toBe('true');
    expect(rowNamed(QUERY_ROW.name).getAttribute('aria-selected')).toBe('false');
  });

  it('follows the panel selection instead of keeping one of its own', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();
    const context: HostContext = { provider: stub.provider, actions: spies.actions };

    const view = render(selectionTree(makeNode(), context, undefined));

    await screen.findByRole('grid');
    await user.click(rowNamed(FUNCTION_ROW.name));

    // The activation is reported with the row's own event, exactly as outside
    // a host...
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: FUNCTION_ROW.id,
      spanId: FUNCTION_ROW.spanId,
      traceId: FUNCTION_ROW.traceId,
    });

    // ...but the mark is the host's to move: until the panel's selection names
    // the event, no row claims to be selected.
    expect(rowNamed(FUNCTION_ROW.name).getAttribute('aria-selected')).toBe('false');

    view.rerender(selectionTree(makeNode(), context, { eventId: FUNCTION_ROW.id }));
    expect(rowNamed(FUNCTION_ROW.name).getAttribute('aria-selected')).toBe('true');

    // A selection made in another view moves the mark here as well.
    view.rerender(selectionTree(makeNode(), context, { eventId: QUERY_ROW.id }));
    expect(rowNamed(FUNCTION_ROW.name).getAttribute('aria-selected')).toBe('false');
    expect(rowNamed(QUERY_ROW.name).getAttribute('aria-selected')).toBe('true');
  });

  it('marks a selected event it had not loaded once a page brings it', async () => {
    const later = makeEvent({
      id: 'event-example-0099',
      spanId: spanIdFor(99),
      name: 'example.later',
      startTime: BASE_START_MS + 64,
      duration: 4,
      seq: 3,
      ingestSeq: 4,
    });
    const stub = pagingProvider('spans', [
      { data: PROVIDER_ORDER, total: 4, nextOffset: 3 },
      { data: [later], total: 4 },
    ]);
    const user = userEvent.setup();

    render(
      selectionTree(
        makeNode(),
        { provider: stub.provider, actions: makeActions().actions },
        { eventId: later.id },
      ),
    );

    await screen.findByRole('grid');

    // Nothing on screen stands for it, so nothing is marked in its place.
    expect(dataRows().every((row) => row.getAttribute('aria-selected') === 'false')).toBe(true);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await waitFor(() => {
      expect(renderedNames()).toContain(later.name);
    });
    expect(rowNamed(later.name).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the selected event marked, on the same record, wherever a view order places it', async () => {
    // A second record of FETCH_ROW's own span — same trace, same span id — and
    // shorter, so the service ranks it after FETCH_ROW and "shortest first"
    // places it before.
    const twin = makeEvent({
      id: 'event-example-0005',
      spanId: FETCH_ROW.spanId,
      name: 'example.fetch.response',
      kind: 'fetch',
      tier: 'browser',
      startTime: BASE_START_MS + 20,
      duration: 20,
      seq: 4,
      ingestSeq: 5,
    });
    const page: readonly TelemetryEvent[] = [...MIXED_ORDER, twin];
    const stub = resolvingProvider('spans', page, { total: page.length, nextOffset: null });
    const spies = makeActions();
    const user = userEvent.setup();

    // The selection names the span alone, so both records stand for it; the
    // first the service returned carries the mark.
    render(
      selectionTree(
        makeNode(),
        { provider: stub.provider, actions: spies.actions },
        { eventId: 'event-example-elsewhere', traceId: TRACE_ID, spanId: FETCH_ROW.spanId },
      ),
    );

    await screen.findByRole('grid');

    const selectedNames = (): string[] =>
      dataRows()
        .filter((row) => row.getAttribute('aria-selected') === 'true')
        .map(
          (row) =>
            within(row).getByRole('rowheader').querySelector('.dg-span-table__name-cell')
              ?.textContent ?? '',
        );

    expect(selectedNames()).toEqual([FETCH_ROW.name]);

    // Shortest first puts the twin ahead of FETCH_ROW. A view order changes the
    // arrangement only: the mark stays on the record it was on.
    await user.click(screen.getByRole('button', { name: DURATION_SORT_NAME }));

    expect(sortStateOf(DURATION_SORT_NAME)).toBe('ascending');
    expect(renderedNames().indexOf(twin.name)).toBeLessThan(
      renderedNames().indexOf(FETCH_ROW.name),
    );
    expect(selectedNames()).toEqual([FETCH_ROW.name]);
    expect(rowNamed(FETCH_ROW.name).classList.contains('dg-is-selected')).toBe(true);

    // Re-arranging is not selecting: nothing was reported and nothing re-queried.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});
