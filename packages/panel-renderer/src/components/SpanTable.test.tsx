/**
 * `components/SpanTable` — the colocated suite, and the stub-provider harness
 * the other query-backed component suites in this folder follow.
 *
 * ## What this suite is protecting
 *
 * The `table` node draws one page of records that the coordination service has
 * already filtered, ordered and paged: `POST /sessions/:id/panel-data` applies
 * `filter`, `sort`, `limit` and `offset` and answers with `total` and
 * `nextOffset` (AAP 0.4.2). Two of the cases below are the mechanical proof of
 * that contract rather than tests of pixels:
 *
 *   - **order preserved** renders a deliberately unsorted page and asserts the
 *     rows appear in the provider's own order, so a local `.sort()` added to
 *     the component later fails here;
 *   - **sort is a re-query** activates a sortable header and asserts a *new*
 *     provider call carrying the mapped `DataQuerySort`, with the rows then
 *     following the second response — not a client-side re-ordering of the
 *     first.
 *
 * The paging case holds the other half of the same contract: a page is a page,
 * the footer says how much of the result is on screen, and "Load more" advances
 * `offset` on the query the provider receives instead of guessing from the
 * length of what arrived.
 *
 * Alongside those, AAP 0.8.3 asks every component suite here for the three
 * states of a query-backed view — loading, empty and error — and for the
 * click-to-source payload. Each state is driven through a stub `DataProvider`
 * that respectively never settles, resolves an empty page and rejects; the
 * payload cases assert what the host actually receives, because every hop after
 * this one acts blind on the object it is handed (AAP 0.4.2, hop 1 of five).
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
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): span names, a file path
 *     and a symbol that belong to no application, demonstration or otherwise.
 *     `scripts/check-no-hardcoding.mjs` scans this text with the rest of
 *     `packages/**`.
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
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
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
 * Every string below is application-neutral (AAP 0.5.4): no component, route,
 * service or symbol of any inspected project appears here, in the fixtures or
 * in the comments. The identifiers are shaped as the capture shapes them — a
 * 32-hex trace id, 16-hex span ids, epoch-millisecond start times, millisecond
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
 * The accessible names of the two sortable header controls, taken from the
 * component's `headerLabel` copy.
 *
 * Spelled out here rather than derived, so this suite pins the names the
 * controls announce instead of restating whatever the component currently
 * passes.
 */
const DURATION_SORT_NAME = 'Duration, longest first';
const START_SORT_NAME = 'Start, relative to the earliest listed operation';

/** The footer control that asks for the next page. */
const LOAD_MORE_NAME = 'Load more';

/** The error state's retry control. */
const RETRY_NAME = 'Retry';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

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

  /** The offset of the next page, when one exists. */
  readonly nextOffset?: number | undefined;
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

/**
 * Renders the component inside both host contexts.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 */
function renderComponent(
  node: TableNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <SpanTable node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );
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

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer (AAP 0.5.5).
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
    // vocabulary, naming no inspected project (AAP 0.5.4).
    const message = await screen.findByText(/no spans matched/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.textContent).toContain('spans');

    for (const name of PROVIDER_ORDER_NAMES) {
      expect(message.textContent).not.toContain(name);
    }
    expect(message.textContent).not.toContain(SOURCE_FILE);

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure, and there is no grid to hold rows.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
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
    // it was given (AAP 0.4.2), so a component that re-ranked the page locally
    // would show an order no response ever reported.
    const stub = resolvingProvider('spans', PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);

    // Stated as a property too, so the intent survives a fixture change: the
    // rendered order is not the duration ranking.
    const durations = PROVIDER_ORDER.map((event) => event.duration);
    expect(durations).not.toEqual([...durations].sort((left, right) => right - left));
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

  it('does not re-query when the activated column is already the applied order', async () => {
    const stub = resolvingProvider('spans', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    // The node already asks for `duration_desc`, and the data layer offers one
    // direction per column, so a second activation has nothing to request.
    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: DURATION_SORT_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).not.toHaveBeenCalled();
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
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
    // this one acts on the object it is handed (AAP 0.4.2).
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

    // One row of forty-two, said plainly rather than implied by a bare count.
    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(42)} spans.`);
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
      screen.getByText(`Showing ${formatCount(2)} of ${formatCount(42)} spans.`),
    ).toBeDefined();
  });

  it('says the total is unknown rather than implying the page is the whole result', async () => {
    const stub = resolvingProvider('spans', [FUNCTION_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A service that reported no total leaves this view unable to know whether
    // more rows exist, and saying so is the only truthful option (AAP 0.4.2).
    const coverage = await screen.findByText(/^Showing 1 span\./);
    expect(coverage.textContent).toContain('not reported');
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
      `Showing ${formatCount(1)} of ${formatCount(42)} spans, from position ${formatCount(21)}.`,
    );
    expect(soleQuery(stub).offset).toBe(20);
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
    // No ordering was authored, so none is invented: the rows are drawn in the
    // order the service returned them.
    expect(query.sort).toBeUndefined();
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
