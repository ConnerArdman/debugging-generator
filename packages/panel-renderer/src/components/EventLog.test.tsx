/**
 * `components/EventLog` — the colocated suite for the `eventLog` node.
 *
 * ## What this suite is protecting
 *
 * The log is the view with no opinion: it draws one page of records the
 * coordination service has already filtered, ordered and paged
 * (`POST /sessions/:id/panel-data` applies `filter`, `sort`, `limit` and
 * `offset` and answers with `total` and `nextOffset`, AAP 0.4.2), and it says
 * out loud how much of the capture that page covers. Four properties of that
 * contract are mechanical rather than cosmetic, and each has a case below:
 *
 *   - **the page is drawn as it arrived** — the rows appear in the provider's
 *     own order and none is dropped, so a local `.sort()` or `.slice()` added
 *     later fails here; no column offers a sort control, because re-ranking a
 *     page locally would disagree with the counters the same response carried;
 *   - **the kind filter is a re-query** — `kinds` is a field of the query's
 *     filter, so choosing a kind narrows the *request*, preserves the node's
 *     own narrowing, restarts paging and reports the choice to the host;
 *   - **the text filter is client-side and says so** — `DataQueryFilter` has no
 *     free-text field, so the filter reaches the loaded records only, and the
 *     toolbar states both the matching/loaded ratio and that limitation rather
 *     than implying the whole capture was searched;
 *   - **paging advances by the offset the service reported** — never by the
 *     length of what arrived, which drifts the moment a limit is clamped.
 *
 * Two further properties belong to the privacy model (AAP 0.5.2). Attribute
 * values arrive already redacted and already bounded to
 * {@link MAX_PREVIEW_LENGTH} characters, so this suite asserts that a preview
 * renders byte-for-byte as supplied — including one that already ends in the
 * upstream truncation marker — that no control offers to expand it, and that
 * the compact strip counts what it does not show instead of unpacking a
 * structured summary.
 *
 * Alongside those, AAP 0.8.3 asks every component suite here for the three
 * states of a query-backed view — loading, empty and error — and for the
 * click-to-source payload. Each state is driven through a stub `DataProvider`
 * that respectively never settles, resolves an empty page and rejects; the
 * payload cases assert what the host actually receives, because every hop after
 * this one acts blind on the object it is handed (AAP 0.4.2, hop 1 of five).
 *
 * ## The case that guards a layering boundary
 *
 * `renders exactly the kinds its data and its node name` is not a test of a
 * picker. `@debuggen/telemetry` is a **type-only** dependency of this package
 * (AAP 0.2.2), so the kind vocabulary — a runtime value of that package — may
 * not be imported here; the component discovers its options from the records
 * that arrived plus the kinds the panel's author named. An edit that reached
 * for the runtime vocabulary instead would pull zod-adjacent code into the
 * browser bundle, and the option list would grow from the handful the capture
 * can prove to the whole taxonomy. Asserting the option set *exactly* is the
 * cheapest place to catch that.
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
 *     so these cases exercise the very seam the DevTools panel and the editor
 *     webview implement. The resolver is a `vi.fn`, and every query it receives
 *     is recorded in an array the cases assert on: what the component *asked
 *     for* is as much of its contract as what it drew. The provider and
 *     response types are imported from `../host/DataProvider` rather than
 *     restated here: a local copy of that contract would keep compiling after
 *     the real one changed, which is the one drift this suite is meant to
 *     catch.
 *   - **In-file synthetic builders, no fixture files.** {@link makeEvent} and
 *     {@link makeNode} take overrides; nothing here is read from disk or shared
 *     with another suite.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): record names, attribute
 *     keys, a file path and a symbol that belong to no application,
 *     demonstration or otherwise. The kinds are the product's own taxonomy.
 *     `scripts/check-no-hardcoding.mjs` scans this text with the rest of
 *     `packages/**`.
 *   - **Queries by role and accessible name.** The grid, its rows, the toolbar
 *     controls, the chips and the footer button are all reached that way; a
 *     class is read only off an element already obtained semantically, since no
 *     `jest-dom` matcher is available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…` or `waitFor`, and
 *     interactions through `userEvent`.
 *
 * @see ./EventLog for the component, its four bodies and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/error/success machine they drive.
 */

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_DEFAULT_OFFSET } from '@debuggen/panel-schema';
import type { DataQuery, EventLogNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { TelemetryEvent } from '@debuggen/telemetry';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import { kindColorVar } from '../utils/color';
import {
  MAX_PREVIEW_LENGTH,
  NOT_AVAILABLE_LABEL,
  formatCount,
  formatKindLabel,
  formatOffset,
  formatStatusLabel,
} from '../utils/format';
import { EventLog } from './EventLog';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral (AAP 0.5.4): no component, route,
 * service or symbol of any inspected project appears here, in the fixtures or
 * in the comments. The identifiers are shaped as a capture shapes them — a
 * 32-hex trace id, 16-hex span ids, epoch-millisecond start times, millisecond
 * durations — because the component reads those fields and formats them.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every record below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'b2c3d4e5f60718293a4b5c6d7e8f9011';

/** The fixture session and capture the persisted records are attributed to. */
const SESSION_ID = 'session-example-0001';
const CAPTURE_ID = 'capture-example-0001';

/** The producer that reported them; `seq` is scoped to it. */
const PRODUCER_ID = 'producer-example-0001';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Inside the window the event schema accepts, and far enough from zero that a
 * relative performance timestamp could not be mistaken for one.
 */
const BASE_START_MS = 1_767_225_600_000;

/** A project-relative, POSIX path for the one record that resolved to source. */
const SOURCE_FILE = 'src/example/widget.tsx';

/** The symbol at that location. */
const SOURCE_SYMBOL = 'onExampleAction';

/** Its 1-based coordinates. */
const SOURCE_LINE = 42;
const SOURCE_COLUMN = 7;

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
const NODE_ID = 'layout.0.eventLog';

/**
 * The names the component announces, spelled out rather than read back through
 * `catalogEntryFor` or the component's own constants.
 *
 * A suite that derived them would assert only that the component is
 * self-consistent; spelled out, it pins the words a reader actually hears.
 */
const GRID_NAME = 'Event log';
const TOOLBAR_NAME = 'Event log filters';
const SEARCH_NAME = 'Filter loaded records';
const KIND_SELECT_NAME = 'Kind';
const ALL_KINDS_LABEL = 'All kinds';
const LOAD_MORE_NAME = 'Load more';
const RETRY_NAME = 'Retry';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/** The five column headers, left to right. */
const COLUMN_HEADERS: readonly string[] = ['Seq', 'Offset', 'Kind', 'Name', 'Attributes'];

/** The note that keeps the text filter honest, as the toolbar states it. */
const PARTIAL_SEARCH_NOTE = 'Text filter applies to loaded records only';

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/**
 * The optional fields of a record admit `undefined` explicitly, which `Partial`
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
    | 'attributes'
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
 * One persisted record for a row to draw.
 *
 * Complete and schema-shaped by construction: a 32-hex `traceId`, a 16-hex
 * `spanId`, an epoch-millisecond `startTime`, a millisecond `duration`, and a
 * `kind`/`tier` pair the event schema's cross-field rule permits (the browser
 * kinds are reported on the `browser` tier).
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh record; nothing is shared between calls.
 */
function makeEvent(overrides: EventOverrides = {}): TelemetryEvent {
  const {
    id = 'event-example-0001',
    traceId = TRACE_ID,
    spanId = spanIdFor(1),
    parentSpanId,
    kind = 'interaction',
    name = 'example.click',
    startTime = BASE_START_MS,
    duration = 4,
    tier = 'browser',
    status = 'ok',
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
    attributes,
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
type NodeOverrides = Partial<Pick<EventLogNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `eventLog` node, as the panel normaliser produces one: an id, no
 * heading (the host's section owns that), and a data query whose source and
 * page size are already explicit.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): EventLogNode {
  const {
    id = NODE_ID,
    query = { source: 'events', limit: DATA_QUERY_DEFAULT_LIMIT },
    title,
    description,
  } = overrides;

  return {
    type: 'eventLog',
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

/**
 * The one source this node's catalog entry permits.
 *
 * Written as a type rather than left implicit so that a stub cannot answer with
 * a payload this node could never have asked for: `eventLog` reads `events`,
 * the only prepared view that offers every record of any kind in capture order.
 */
type EventLogSource = 'events';

/** One page a stub provider can answer with. */
interface EventPage {
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
   * The assertion surface for the paging and filtering cases: what the
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
 * The builder the filtering and paging cases use: a re-query has to be able to
 * answer differently from the query before it, or "the rows follow the second
 * response" could not be told from "the rows were filtered locally".
 *
 * @param source The source the responses answer for.
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(source: EventLogSource, pages: readonly EventPage[]): StubProvider {
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
  source: EventLogSource,
  data: readonly TelemetryEvent[],
  extra: Omit<EventPage, 'data'> = {},
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

  /** The record-selection spy. */
  readonly onSelectEvent: Mock<(ref: PanelEventRef) => void>;

  /** The open-source spy. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;

  /** The optional filter report spy, supplied so cases can assert on it. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host —
 * and the optional filter report is supplied too, so every case can assert not
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
  node: EventLogNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelActionsContext.Provider value={context.actions}>
        <EventLog node={node} />
      </PanelActionsContext.Provider>
    </DataProviderContext.Provider>,
  );
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
 * The record name of each data row, in document order.
 *
 * Read off the row's header cell — obtained by role — and then from the
 * component's own name element inside it, so a row carrying a status chip or a
 * source chip contributes its record name and nothing else.
 *
 * @returns One name per row.
 */
function renderedNames(): string[] {
  return dataRows().map((row) => {
    const header = within(row).getByRole('rowheader');

    return header.querySelector('.dg-event-log__name')?.textContent ?? '';
  });
}

/**
 * The data row whose record name is `name`.
 *
 * @param name The record name to find.
 * @returns That row.
 */
function rowNamed(name: string): HTMLElement {
  const row = dataRows()[renderedNames().indexOf(name)];

  if (row === undefined) {
    throw new Error(`no rendered row is named "${name}"`);
  }

  return row;
}

/** The text field that filters the loaded records. */
function searchField(): HTMLElement {
  return screen.getByRole('textbox', { name: SEARCH_NAME });
}

/** The kind picker, which the component offers only when there is a kind to pick. */
function kindPicker(): HTMLElement {
  return screen.getByRole('combobox', { name: KIND_SELECT_NAME });
}

/** One option of the kind picker, as a reader sees it and as the control reports it. */
interface RenderedOption {
  /** The value the control would report if this option were chosen. */
  readonly value: string;

  /** The text the option shows. */
  readonly label: string;
}

/**
 * Every option of the kind picker, in document order.
 *
 * The value is read off the DOM property rather than the attribute, which is
 * what an option reports when chosen; the label is its text.
 *
 * @returns The options.
 */
function kindOptions(): RenderedOption[] {
  return within(kindPicker())
    .getAllByRole('option')
    .map((option) => ({
      value: option instanceof HTMLOptionElement ? option.value : '',
      label: option.textContent ?? '',
    }));
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
 * The three records most cases draw
 *
 * Distinct kinds, distinct names, distinct sequence numbers and distinct start
 * times, so a per-row assertion cannot pass by matching the wrong row; one of
 * them carries a resolved source location and the others do not, which is what
 * lets the selection case activate a row with no chip in it.
 *
 * Deliberately NOT in start order (4 ms, 16 ms, 0 ms) while the node below asks
 * for `start_asc`: the ordering cases draw them exactly as the provider hands
 * them over.
 * ---------------------------------------------------------------------------
 */

/** A React commit record, the earliest loaded but not the first returned. */
const RENDER_RECORD = makeEvent({
  id: 'event-example-0001',
  spanId: spanIdFor(1),
  kind: 'render',
  name: 'ExampleWidget',
  startTime: BASE_START_MS + 4,
  duration: 12,
  seq: 0,
  ingestSeq: 1,
});

/** A network record, and the only one that resolved to a project location. */
const FETCH_RECORD = makeEvent({
  id: 'event-example-0002',
  spanId: spanIdFor(2),
  kind: 'fetch',
  name: 'example.request',
  startTime: BASE_START_MS + 16,
  duration: 96,
  seq: 1,
  ingestSeq: 2,
  attributes: { 'http.method': 'GET' },
  source: BASE_SOURCE,
});

/** The interaction that started the trace, and the origin of the offset column. */
const INTERACTION_RECORD = makeEvent({
  id: 'event-example-0003',
  spanId: spanIdFor(3),
  kind: 'interaction',
  name: 'example.click',
  startTime: BASE_START_MS,
  duration: 4,
  seq: 2,
  ingestSeq: 3,
});

/** The three records in the order the provider returns them below. */
const PROVIDER_ORDER: readonly TelemetryEvent[] = [RENDER_RECORD, FETCH_RECORD, INTERACTION_RECORD];

/** Their names, in that same order. */
const PROVIDER_ORDER_NAMES: readonly string[] = PROVIDER_ORDER.map((event) => event.name);

/** The earliest start among them: what every rendered offset is measured from. */
const LOADED_ORIGIN_MS = Math.min(...PROVIDER_ORDER.map((event) => event.startTime));

/** A node that asks for an ordering, so the order-preserved case has something to defy. */
function orderedNode(): EventLogNode {
  return makeNode({
    query: { source: 'events', sort: 'start_asc', limit: DATA_QUERY_DEFAULT_LIMIT },
  });
}

describe('EventLog states', () => {
  it('renders the loading state, and no rows, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes the box
    // that places it, which is why the class is read off the ancestor.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.textContent).toContain('Loading captured records');
    expect(busy.closest('.dg-event-log__loading')).not.toBeNull();

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();

    // No paging footer either: a count of what has loaded would read as zero
    // records rather than as none yet.
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // The filter row is mounted throughout — a reader can type while the first
    // page resolves — but the kind picker is not, because no record has arrived
    // to name a kind and this component never enumerates the vocabulary.
    expect(screen.getByRole('group', { name: TOOLBAR_NAME })).toBeDefined();
    expect(searchField()).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();

    // One query, and it was issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders its own empty message, and no rows, for a successful empty page', async () => {
    const stub = resolvingProvider('events', []);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic substring of the product's own copy rather than by a
    // restatement of the sentence: product vocabulary, naming no inspected
    // project (AAP 0.5.4).
    const message = await screen.findByText(/no records were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);

    for (const name of PROVIDER_ORDER_NAMES) {
      expect(message.textContent).not.toContain(name);
    }
    expect(message.textContent).not.toContain(SOURCE_FILE);

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure, and there is no grid to hold rows.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);

    // Nothing loaded, so nothing is claimed about coverage and no page can be
    // asked for.
    expect(screen.queryByText(/records loaded/)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.', {
        hint: 'Reopen the panel once the service is reachable.',
      }),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-event-log__error')).not.toBeNull();

    // The provider's own message, hint and code reach the reader, rather than a
    // generic sentence written over them.
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('Reopen the panel once the service is reachable.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, and compared as a value rather
    // than as a spelling.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'events',
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
});

describe('EventLog rows', () => {
  it('draws one row per record, with its sequence, offset, kind and name', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The grid is named by the node's caption, which falls back to the catalog's
    // own label when the node carries no title of its own.
    await screen.findByRole('grid', { name: GRID_NAME });
    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);

    for (const event of PROVIDER_ORDER) {
      const row = rowNamed(event.name);

      // The name cell is the row's header, so a reader hears the row named.
      const header = within(row).getByRole('rowheader');
      expect(header.querySelector('.dg-event-log__name')?.textContent).toBe(event.name);

      // The producer's own sequence number, formatted and placed by this
      // component's element class.
      const seq = within(row).getByText(formatCount(event.seq));
      expect(seq.classList.contains('dg-event-log__seq')).toBe(true);

      // The start is an offset from the earliest loaded record, not a
      // wall-clock time.
      const offset = within(row).getByText(formatOffset(event.startTime, LOADED_ORIGIN_MS));
      expect(offset.classList.contains('dg-event-log__time')).toBe(true);
      expect(row.textContent).not.toContain(String(event.startTime));

      // The kind chip carries the kind scale as a token reference, never a
      // colour, and its label carries the meaning.
      const kindChip = within(row).getByText(formatKindLabel(event.kind));
      expect(kindChip.classList.contains('dg-badge')).toBe(true);
      expect(kindChip.getAttribute('style')).toContain(kindColorVar(event.kind));
    }

    // One record carried an attribute and two carried none; the strip says so
    // rather than rendering an empty cell.
    expect(within(rowNamed(FETCH_RECORD.name)).getByText('http.method=GET')).toBeDefined();
    expect(within(rowNamed(RENDER_RECORD.name)).getByText(NOT_AVAILABLE_LABEL)).toBeDefined();

    // Five columns, in the catalog's order.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      ...COLUMN_HEADERS,
    ]);
  });

  it('uses the node title as the grid caption when the node carries one', async () => {
    const stub = resolvingProvider('events', [INTERACTION_RECORD]);

    renderComponent(makeNode({ title: 'Captured records' }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: 'Captured records' });
  });

  it('draws the page as the provider ordered it, and offers no local re-sort', async () => {
    // The page is deliberately not in start order while the node asks for
    // `start_asc`: the service applied the ordering it was given (AAP 0.4.2),
    // so a component that re-ranked the page locally would show an order no
    // response ever reported.
    const stub = resolvingProvider('events', PROVIDER_ORDER, { total: PROVIDER_ORDER.length });

    renderComponent(orderedNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);

    // Stated as a property too, so the intent survives a fixture change: the
    // rendered order is not the start ranking.
    const starts = PROVIDER_ORDER.map((event) => event.startTime);
    expect(starts).not.toEqual([...starts].sort((left, right) => left - right));

    // No column is sortable, so no header offers a control and none claims a
    // sortable state: re-ordering a page locally would disagree with the
    // counters the same response carried.
    for (const header of screen.getAllByRole('columnheader')) {
      expect(within(header).queryAllByRole('button')).toHaveLength(0);
      expect(header.getAttribute('aria-sort')).toBeNull();
    }

    // And the whole page was drawn: the page size is the service's business,
    // never a second slice applied here.
    expect(soleQuery(stub).limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);
  });
});

describe('EventLog kind filter', () => {
  it('offers exactly the kinds its data and its node name, and no more', async () => {
    // Two kinds arrive and the node's own filter names a third. A stub is not
    // the resolver, so it may legitimately answer with records the authored
    // filter would have excluded; what matters is that the picker's options are
    // the union of what arrived and what the panel's author already named.
    const stub = resolvingProvider('events', [RENDER_RECORD, FETCH_RECORD]);

    renderComponent(
      makeNode({
        query: {
          source: 'events',
          filter: { kinds: ['interaction'] },
          limit: DATA_QUERY_DEFAULT_LIMIT,
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid');

    // The "no narrowing" choice first, then one option per discovered kind in a
    // locale-independent order.
    expect(kindOptions()).toEqual([
      { value: '', label: ALL_KINDS_LABEL },
      { value: 'fetch', label: formatKindLabel('fetch') },
      { value: 'interaction', label: formatKindLabel('interaction') },
      { value: 'render', label: formatKindLabel('render') },
    ]);

    // The union and nothing beyond it. This is the layering assertion of the
    // suite: the kind vocabulary is a runtime value of `@debuggen/telemetry`,
    // which this package may use for types only (AAP 0.2.2), so an edit that
    // enumerated it here would offer every kind the taxonomy defines — among
    // them the two below, which this capture cannot prove exist.
    expect(kindOptions()).toHaveLength(4);

    const labels = kindOptions().map((option) => option.label);
    expect(labels).not.toContain(formatKindLabel('db.query'));
    expect(labels).not.toContain(formatKindLabel('http.server'));
  });

  it('turns a chosen kind into a new query and follows the response', async () => {
    // Two pages: the node's own narrowing, then whatever the service returns
    // for the narrowed request. The second page is a subset of the first page's
    // records, which is the only way to tell "the rows follow the new response"
    // from "the rows were filtered in the browser".
    const stub = pagingProvider('events', [
      { data: PROVIDER_ORDER, total: 40, nextOffset: 3 },
      { data: [FETCH_RECORD], total: 12 },
    ]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(
      makeNode({
        query: { source: 'events', filter: { traceId: TRACE_ID }, limit: DATA_QUERY_DEFAULT_LIMIT },
      }),
      { provider: stub.provider, actions: spies.actions },
    );

    await screen.findByRole('grid');
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
    expect(soleQuery(stub).filter).toEqual({ traceId: TRACE_ID });

    await user.selectOptions(kindPicker(), 'fetch');

    // A re-query, because `kinds` is a field of the query's filter.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const requeried = queryOfCall(stub, 2);
    expect(requeried.source).toBe('events');
    // The node's own narrowing survives and the chosen kind is added to it: a
    // reader's choice may narrow what the panel asked for, never widen it.
    expect(requeried.filter).toEqual({ traceId: TRACE_ID, kinds: ['fetch'] });
    // A new narrowing is a new page sequence, so it starts at the node's offset.
    expect(requeried.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(requeried.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    // The rows, and the coverage statement, follow that second response.
    await waitFor(() => {
      expect(renderedNames()).toEqual([FETCH_RECORD.name]);
    });
    expect(
      screen.getByText(`${formatCount(1)} of ${formatCount(12)} records loaded`),
    ).toBeDefined();

    // The host is told which narrowing the reader asked for, and nothing else
    // was raised on its behalf.
    expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).toHaveBeenCalledWith(NODE_ID, { kinds: 'fetch' });
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    // Narrowing to one kind leaves the control able to show its own value and
    // to offer the kinds that were in hand when the reader narrowed.
    const picker = kindPicker();
    expect(picker instanceof HTMLSelectElement ? picker.value : '').toBe('fetch');
    expect(kindOptions().map((option) => option.value)).toEqual([
      '',
      'fetch',
      'interaction',
      'render',
    ]);
  });
});

describe('EventLog text filter', () => {
  it('narrows the loaded page and states how far the filter reached', async () => {
    // A loaded page shorter than the source is exactly when a reader could
    // mistake "nothing matched" for "nothing exists".
    const stub = resolvingProvider('events', PROVIDER_ORDER, { total: 40, nextOffset: 3 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    await user.type(searchField(), 'click');

    await waitFor(() => {
      expect(renderedNames()).toEqual([INTERACTION_RECORD.name]);
    });

    // Both ratios are stated: what the filter kept of the loaded page, and what
    // the loaded page covers of the source.
    expect(
      screen.getByText(`${formatCount(1)} of ${formatCount(3)} loaded records match`),
    ).toBeDefined();
    expect(
      screen.getByText(`${formatCount(3)} of ${formatCount(40)} records loaded`),
    ).toBeDefined();

    // And the limitation is stated in the reader's own vocabulary rather than
    // implied by the numbers.
    const note = screen.getByText(PARTIAL_SEARCH_NOTE);
    expect(note.classList.contains('dg-badge')).toBe(true);
    expect(note.classList.contains('dg-badge--warning')).toBe(true);

    // Nothing was asked of the service: the data query carries no free-text
    // field, so this filter is the loaded page's and says so.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(soleQuery(stub).filter).toBeUndefined();
  });

  it('reports an unmatched filter as the filter’s doing, not the capture’s', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER, { total: 40, nextOffset: 3 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    await user.type(searchField(), 'unmatched');

    // The table's own empty slot, with the filter's message — never the
    // capture's, which would tell the reader nothing was captured at all.
    const message = await screen.findByText(/no loaded records match this text filter/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(screen.queryByText(/no records were captured/i)).toBeNull();

    expect(dataRows()).toHaveLength(0);
    expect(
      screen.getByText(`${formatCount(0)} of ${formatCount(3)} loaded records match`),
    ).toBeDefined();

    // The loaded page is untouched behind the filter, and no page was fetched
    // in the hope of a match.
    expect(
      screen.getByText(`${formatCount(3)} of ${formatCount(40)} records loaded`),
    ).toBeDefined();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('EventLog attributes', () => {
  /** A value exactly as long as the preview bound a producer is held to. */
  const BOUNDED_VALUE = 'redacted-value-'.repeat(8);

  /** A value the producer had already truncated, its marker included. */
  const TRUNCATED_VALUE = `${'bounded-preview-'.repeat(6)}…`;

  it('renders a preview exactly as it arrived, and offers nothing to expand', async () => {
    const record = makeEvent({
      attributes: { 'example.value': BOUNDED_VALUE, 'example.preview': TRUNCATED_VALUE },
    });
    const stub = resolvingProvider('events', [record]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    const row = rowNamed(record.name);

    // The fixture IS the bound (AAP 0.5.2), so this case fails if the bound
    // moves rather than silently testing a shorter string.
    expect(BOUNDED_VALUE).toHaveLength(MAX_PREVIEW_LENGTH);

    // Byte for byte, with the key joined to it and nothing else done to it.
    const bounded = within(row).getByText(`example.value=${BOUNDED_VALUE}`);
    expect(bounded.textContent).toBe(`example.value=${BOUNDED_VALUE}`);

    const preview = within(row).getByText(`example.preview=${TRUNCATED_VALUE}`);
    expect(preview.textContent).toBe(`example.preview=${TRUNCATED_VALUE}`);
    // The producer's own truncation marker survives: this view never re-parses,
    // re-expands or reconstructs a value it was handed.
    expect(preview.textContent?.endsWith(TRUNCATED_VALUE)).toBe(true);

    // No affordance offers more than the producer was permitted to capture: the
    // row holds no control at all, and the strip claims nothing is withheld.
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
    expect(within(row).queryByText(/more$/)).toBeNull();
  });

  it('counts the attributes it does not show instead of unpacking them', async () => {
    const record = makeEvent({
      attributes: {
        'example.first': 'alpha',
        'example.second': 2,
        'example.third': true,
        'example.fourth': 'delta',
        'example.structured': { nested: 'kept-for-the-detail-drawer' },
      },
    });
    const stub = resolvingProvider('events', [record]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    const row = rowNamed(record.name);

    // Three primitive pairs, in the producer's own key order.
    expect(within(row).getByText('example.first=alpha')).toBeDefined();
    expect(within(row).getByText('example.second=2')).toBeDefined();
    expect(within(row).getByText('example.third=true')).toBeDefined();

    // The pair beyond the row's bound and the structured summary are counted,
    // never dropped and never expanded: an upstream summary stays a summary,
    // and the whole attribute bag belongs to the host's detail drawer.
    expect(within(row).getByText(`+${formatCount(2)} more`)).toBeDefined();
    expect(row.textContent).not.toContain('example.fourth');
    expect(row.textContent).not.toContain('delta');
    expect(row.textContent).not.toContain('nested');
    expect(row.textContent).not.toContain('kept-for-the-detail-drawer');
  });
});

describe('EventLog interactions', () => {
  it('announces the activated row as the record it stands for', async () => {
    const stub = resolvingProvider('events', [INTERACTION_RECORD]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    // This list drives the host's record-detail drawer and keeps no selection
    // of its own, so its rows deliberately report no selected state.
    expect(row.getAttribute('aria-selected')).toBeNull();

    await user.click(row);

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    const ref = call[0];

    // The three identifiers the host needs to resolve the record, taken from
    // that row's own record and nothing else.
    expect(ref).toEqual({
      eventId: INTERACTION_RECORD.id,
      spanId: INTERACTION_RECORD.spanId,
      traceId: INTERACTION_RECORD.traceId,
    });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // Selecting a record is not opening its source, and it is not a filter.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('hands the host the very location a record resolved to, and selects nothing', async () => {
    const stub = resolvingProvider('events', [FETCH_RECORD]);
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

  it('draws no chip for a record the capture could not resolve to a location', async () => {
    const stub = resolvingProvider('events', [RENDER_RECORD]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    const row = rowNamed(RENDER_RECORD.name);

    expect(within(row).queryByRole('button')).toBeNull();
    expect(row.textContent).not.toContain(SOURCE_FILE);
  });

  it('marks a failed record with the status the producer reported', async () => {
    const failed = makeEvent({
      id: 'event-example-0004',
      spanId: spanIdFor(4),
      kind: 'fetch',
      name: 'example.request.rejected',
      startTime: BASE_START_MS + 32,
      duration: 512,
      status: 'error',
      seq: 3,
      ingestSeq: 4,
    });
    const stub = resolvingProvider('events', [failed, INTERACTION_RECORD]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    const row = rowNamed(failed.name);

    // The captured status's own word, in a chip whose tone is a token class:
    // the meaning is in the label, so it survives the high-contrast theme and a
    // reader who cannot distinguish the hues (AAP 0.6.3).
    const statusChip = within(row).getByText(formatStatusLabel('error'));
    expect(statusChip.classList.contains('dg-badge')).toBe(true);
    expect(statusChip.classList.contains('dg-badge--danger')).toBe(true);

    // And it is part of the row's own announcement, not only of its appearance.
    expect(screen.getByRole('row', { name: new RegExp(formatStatusLabel('error')) })).toBe(row);

    // A record the producer reported as fine carries no such mark, so the
    // marking means something.
    expect(
      within(rowNamed(INTERACTION_RECORD.name)).queryByText(formatStatusLabel('error')),
    ).toBeNull();
  });
});

describe('EventLog paging', () => {
  it('says how much of the capture is on screen and appends the next page', async () => {
    const stub = pagingProvider('events', [
      { data: [RENDER_RECORD], total: 40, nextOffset: 1 },
      { data: [FETCH_RECORD], total: 40, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // One record of forty, said plainly rather than implied by a bare count.
    await screen.findByText(`${formatCount(1)} of ${formatCount(40)} records loaded`);
    expect(dataRows()).toHaveLength(1);

    const first = soleQuery(stub);
    expect(first.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(first.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const second = queryOfCall(stub, 2);
    expect(second.offset).toBe(1);
    expect(second.offset).toBeGreaterThan(first.offset ?? DATA_QUERY_DEFAULT_OFFSET);
    expect(second.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(second.source).toBe('events');

    // Appended, not replaced: the page the reader was already reading stays,
    // and the coverage statement follows it.
    await waitFor(() => {
      expect(renderedNames()).toEqual([RENDER_RECORD.name, FETCH_RECORD.name]);
    });
    expect(
      screen.getByText(`${formatCount(2)} of ${formatCount(40)} records loaded`),
    ).toBeDefined();
  });

  it('advances by the offset the service reported rather than one it derived', async () => {
    // `nextOffset` deliberately differs from the length of the page: the
    // contract is that a view copies the offset the service reported, never one
    // it computed from what arrived, which drifts the moment a limit is clamped.
    const stub = pagingProvider('events', [
      { data: [RENDER_RECORD, FETCH_RECORD], total: 40, nextOffset: 9 },
      { data: [INTERACTION_RECORD], total: 40 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    const second = queryOfCall(stub, 2);
    expect(second.offset).toBe(9);
    expect(second.offset).not.toBe(dataRows().length);

    // The last page reports no next offset, so the control that asked for one
    // is gone rather than left to ask again for nothing.
    await waitFor(() => {
      expect(renderedNames()).toEqual([
        RENDER_RECORD.name,
        FETCH_RECORD.name,
        INTERACTION_RECORD.name,
      ]);
    });
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('says only what has loaded when the service reported no total', async () => {
    const stub = resolvingProvider('events', [INTERACTION_RECORD]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A service that reported no total leaves this view unable to know whether
    // more records exist, and saying only what it has is the truthful option
    // (AAP 0.4.2).
    const coverage = await screen.findByText(`${formatCount(1)} records loaded`);
    expect(coverage.textContent).not.toContain(' of ');
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });
});
