/**
 * `components/Waterfall` — the colocated suite of the node catalog's
 * `waterfall` type.
 *
 * ## What this suite is protecting
 *
 * A waterfall is one of the three views the slow-interaction acceptance panel
 * is assembled from (AAP 0.6.5, 0.8.3), and it is the one that has to answer
 * *what was waiting on what*. Two properties carry that answer, and a
 * regression in either turns the view into a list of unrelated bars that still
 * renders perfectly:
 *
 *   - **Offsets are relative to the first *included* call.** The case below
 *     deliberately puts an earlier record of a kind this view does not draw in
 *     the same page: the window must still start at the earliest drawn call, so
 *     the leftmost bar sits at zero and every printed offset is a wait rather
 *     than a wall-clock reading.
 *   - **Children nest under the call that was blocked by them.** A collapsed
 *     row discloses its nested calls, the disclosure is reported to the host,
 *     and a record whose immediate parent is of an undrawn kind still lands
 *     beneath its nearest drawn ancestor.
 *
 * Alongside those, AAP 0.8.3 asks every component suite here for the three
 * states of a query-backed view — loading, empty and error — and for the
 * click-to-source payload, and AAP 0.4.2 asks for honest paging: what a footer
 * claims about coverage, and that "load more" advances the offset the *service*
 * reported on the query the provider actually receives.
 *
 * ## The privacy cases, and why they are byte-comparisons (AAP 0.5.2)
 *
 * A redacted URL and a parameterized statement arrive in their final display
 * form: query-parameter values are already replaced per key, and statement
 * literals are already replaced. This view's whole obligation is to render them
 * unchanged, so the two cases below compare the rendered text *byte for byte*
 * against the fixture rather than asserting that it "contains" a path — a
 * component that re-assembled a URL from parts, unescaped a mask, pretty-printed
 * a statement or substituted a placeholder back would satisfy a containment
 * check and fail these.
 *
 * Three further assertions hold the rest of that boundary. Bodies and row
 * contents are never captured, so the fixtures carry attribute keys that would
 * be exactly that if a producer smuggled them in, and no case may find their
 * values on screen; a database row shows a *count*; and no control anywhere
 * offers to reveal a raw value, a body or a result set. A transferred-byte
 * figure the runtime genuinely could not observe renders as
 * {@link NOT_AVAILABLE_LABEL} and never as a zero that would read as "nothing
 * was transferred" (AAP 0.6.6).
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`, and `afterEach(cleanup)`
 *     registered explicitly, even though the `panel-renderer` project enables
 *     globals for `@testing-library/react`'s automatic cleanup.
 *   - **Stub providers built with the library's own `createDataProvider`**, so
 *     these cases drive the very seam both host surfaces implement. Every query
 *     the component issues is recorded: what it *asked for* is as much of its
 *     contract as what it drew.
 *   - **In-file synthetic builders, no fixture files.** {@link makeEvent} and
 *     {@link makeNode} take overrides, and the telemetry shapes are imported as
 *     types only — nothing here calls a telemetry runtime helper to build a
 *     record, and nothing is read from disk.
 *   - **No layout stubbing.** `getBoundingClientRect` and `ResizeObserver` are
 *     left alone on purpose: the time scale's range is a percentage interval, so
 *     the view must be correct from data alone under happy-dom, where every
 *     measurement answers zero.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): a loopback URL, an
 *     `/example/…` path, an `example_…` table and a `src/example/…` file, none
 *     of which belongs to any inspected application.
 *   - **Queries by role and accessible name**, with a class read only off an
 *     element already obtained semantically (no `jest-dom` matchers exist in
 *     this repository), and no timers — post-resolution assertions go through
 *     `await screen.findBy…`.
 *
 * @see ./Waterfall for the component, its four states and its row contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 */

import { DATA_QUERY_DEFAULT_OFFSET } from '@debuggen/panel-schema';
import type { DataQuery, WaterfallNode } from '@debuggen/panel-schema';
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
import {
  NOT_AVAILABLE_LABEL,
  formatBytes,
  formatCount,
  formatDuration,
  formatDurationCompact,
  formatKindLabel,
  formatTierLabel,
} from '../utils/format';
import { Waterfall } from './Waterfall';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral (AAP 0.5.4): no component, route,
 * service, table or symbol of any inspected project appears here, in the
 * fixtures or in the comments. The identifiers are shaped as a capture shapes
 * them — a 32-hex trace id, 16-hex span ids, epoch-millisecond start times,
 * millisecond durations — because the component reads those fields and formats
 * them.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every record below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2';

/** The fixture session and capture the persisted records are attributed to. */
const SESSION_ID = 'session-example-0001';
const CAPTURE_ID = 'capture-example-0001';

/** The producer that reported them. */
const PRODUCER_ID = 'producer-example-0001';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Far enough from zero that a relative performance timestamp could not be
 * mistaken for one, which is what makes "no row prints a wall-clock time" a
 * meaningful assertion.
 */
const BASE_START_MS = 1_767_225_600_000;

/**
 * The request URL as it arrives: every query-parameter *value* already replaced
 * per key with the redaction mask, the path retained (AAP 0.5.2).
 *
 * This exact string is what the row must render — it is already the correct
 * display form, and re-deriving any part of it is the defect the verbatim case
 * below exists to catch.
 */
const REQUEST_URL = 'http://127.0.0.1:3000/example/resource?tenant=?&page=?';

/** The request method, as the producer reported it. */
const REQUEST_METHOD = 'POST';

/** The matched server route, which labels a server request better than its name. */
const SERVER_ROUTE = '/example/resource';

/**
 * The statement as it arrives: parameterized, with the driver's own `$1`
 * placeholder kept and the inline literals already replaced by the redaction
 * mask. Rendered verbatim, never re-assembled with values put back.
 */
const SQL_STATEMENT =
  'SELECT id, total FROM example_ledger WHERE tenant_id = $1 AND recorded_at > ? LIMIT ?';

/** How many rows that statement touched. Row *contents* are never captured. */
const SQL_ROW_COUNT = 1240;

/** Bytes transferred for the request that carried a resource-timing figure. */
const TRANSFERRED_BYTES = 2048;

/*
 * Values a producer must never report and this view must never render. They sit
 * in the fixtures' attribute bags under body- and row-shaped keys so that the
 * privacy cases are a statement about the RENDERER: bodies and row contents are
 * not captured (AAP 0.5.2), and a bag that carried them anyway — a producer
 * from a future build, a hand-built fixture — must still draw nothing.
 */
const UNRENDERABLE_REQUEST_BODY = 'unrendered-request-payload';
const UNRENDERABLE_RESPONSE_BODY = 'unrendered-response-payload';
const UNRENDERABLE_ROW_CONTENTS = 'unrendered-row-contents';

/** A project-relative, POSIX path for the one record that resolved to source. */
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
const NODE_ID = 'layout.0.waterfall';

/*
 * The accessible names of the controls and containers the cases reach for.
 * Spelled out rather than derived, so this suite pins what a reader hears
 * instead of restating whatever the component currently passes.
 */
const TREE_NAME = 'Captured calls, nested under the call that was waiting on them';
const EXPAND_NAME = 'Expand nested calls';
const COLLAPSE_NAME = 'Collapse nested calls';
const LOAD_MORE_NAME = 'Load more';
const RETRY_NAME = 'Retry';
const FAILING_QUERY_NAME = 'Failing query';

/** A generic substring of the component's own empty copy. */
const EMPTY_MESSAGE = /no network or database calls were captured/i;

/**
 * Anything that would offer to reveal a captured body, a raw value or a result
 * set. No control in this view may match it: the data behind such a control was
 * never captured, so the control could only ever mislead (AAP 0.5.2).
 */
const BODY_CONTROL = /\braw\b|\bbody\b|payload|result set|row data|contents/i;

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
    | 'attributes'
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

/** An event id derived from the same ordinal, for the same reason. */
function eventIdFor(ordinal: number): string {
  return `event-example-${ordinal.toString().padStart(4, '0')}`;
}

/**
 * One persisted record for a row to draw.
 *
 * Complete and schema-shaped by construction: a 32-hex `traceId`, a 16-hex
 * `spanId`, an epoch-millisecond `startTime`, a millisecond `duration`, and a
 * `kind`/`tier` pair the event schema's cross-field rule permits (`fetch` and
 * `xhr` on `browser`, `http.server` and `http.client` on `server`, `db.query`
 * only on `db`).
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh record; nothing is shared between calls.
 */
function makeEvent(overrides: EventOverrides = {}): TelemetryEvent {
  const {
    id = eventIdFor(1),
    traceId = TRACE_ID,
    spanId = spanIdFor(1),
    parentSpanId,
    kind = 'fetch',
    name = 'example.call',
    startTime = BASE_START_MS,
    duration = 12,
    tier = 'browser',
    status = 'ok',
    attributes = {},
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
type NodeOverrides = Partial<Pick<WaterfallNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `waterfall` node, as the panel normaliser produces one: an id, no
 * heading (the host's section owns that) and the flat-record query its catalog
 * entry permits.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): WaterfallNode {
  const { id = NODE_ID, query = { source: 'spans' }, title, description } = overrides;

  return {
    type: 'waterfall',
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
   * The assertion surface for the paging and retry cases: the offset a view
   * advances to is only correct if the provider actually received it.
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
 * A provider that answers each successive call with the next page, repeating the
 * last one once the list is exhausted.
 *
 * The builder the paging case uses: a second call has to be able to answer
 * differently from the first, or "the page was appended" could not be told from
 * "the same page was drawn twice".
 *
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(pages: readonly SpanPage[]): StubProvider {
  return recordingProvider((_query, call) => {
    const page = pages[Math.min(call, pages.length) - 1];

    if (page === undefined) {
      throw new Error('the stub provider was built with no pages');
    }

    return Promise.resolve<DataQueryResponse>({
      source: 'spans',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    });
  });
}

/**
 * A provider that resolves one page for every query.
 *
 * @param data The records of the page, in the order the service returned them.
 * @param extra The paging counters to report, if any.
 * @returns The stub provider.
 */
function resolvingProvider(
  data: readonly TelemetryEvent[],
  extra: Omit<SpanPage, 'data'> = {},
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

  /** The optional disclosure spy, supplied so cases can assert on it. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host —
 * and the optional disclosure report is supplied too, so every case can assert
 * not only that the intent it exercised was raised but also that the others
 * were not: activating a source chip must not also select a row, and expanding
 * a row must not select it either.
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
 */
function renderComponent(
  node: WaterfallNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelActionsContext.Provider value={context.actions}>
        <Waterfall node={node} />
      </PanelActionsContext.Provider>
    </DataProviderContext.Provider>,
  );
}

/**
 * Every drawn row, in document order — a collapsed subtree contributes none,
 * because it is not in the document at all.
 *
 * @returns The rows currently on screen.
 */
function drawnRows(): HTMLElement[] {
  return screen.queryAllByRole('treeitem');
}

/**
 * What each drawn row announces itself as, in document order.
 *
 * The row's `aria-label` is the component's own one-line description of the
 * call — label, kind, tier, offset, duration and the figures that do not fit on
 * it — so this is where the offset and transfer assertions read from.
 *
 * @returns One description per row.
 */
function rowDescriptions(): string[] {
  return drawnRows().map((row) => row.getAttribute('aria-label') ?? '');
}

/**
 * The accessible name of every control on screen.
 *
 * Read from `aria-label` first and from the control's text second, which is the
 * order the platform computes a name in for the two shapes this view renders —
 * an icon-only disclosure button and a labelled footer button.
 *
 * @returns One name per control.
 */
function controlNames(): string[] {
  return screen
    .queryAllByRole('button')
    .map((control) => control.getAttribute('aria-label') ?? control.textContent ?? '');
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

/**
 * The description of the row at `index`, in document order.
 *
 * @param index Zero-based row index.
 * @returns That row's accessible description.
 */
function descriptionAt(index: number): string {
  const description = rowDescriptions()[index];

  if (description === undefined) {
    throw new Error(`no row was drawn at index ${String(index)}`);
  }

  return description;
}

/**
 * The row whose visible label is exactly `label`.
 *
 * Obtained from the label element and then widened to the row that holds it,
 * which is how a case names a row by the call it stands for — a redacted URL, a
 * matched route, a parameterized statement — rather than by a position.
 *
 * @param label The row's visible label, in full.
 * @returns That row.
 */
function rowLabelled(label: string): HTMLElement {
  const row = screen.getByText(label).closest<HTMLElement>('[role="treeitem"]');

  if (row === null) {
    throw new Error(`the element labelled "${label}" is not inside a row`);
  }

  return row;
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
 * The correlated chain most cases draw
 *
 * A browser request, the server request it reached, and the statement that
 * server request ran — the shape of the interaction the slow-button panel is
 * built for (AAP 0.4.2). The records are linked by `parentSpanId`, so a page
 * holding all three draws one row with two levels nested inside it, while a
 * page holding any one of them alone draws it as a top-level row: a parent link
 * that points outside the page is an unresolved ancestry, which this view is
 * honest about rather than inventing.
 *
 * The attribute bags are named constants so that a case needing a record on its
 * own builds one with the same attributes rather than restating them.
 * ---------------------------------------------------------------------------
 */

/**
 * The browser request's attributes, including two keys a producer must never
 * report: bodies are not captured (AAP 0.5.2), and no row may render one.
 */
const REQUEST_ATTRIBUTES: TelemetryEvent['attributes'] = {
  'http.method': REQUEST_METHOD,
  url: REQUEST_URL,
  'http.status_code': 200,
  transferSize: TRANSFERRED_BYTES,
  initiator: 'fetch',
  requestBody: UNRENDERABLE_REQUEST_BODY,
  responseBody: UNRENDERABLE_RESPONSE_BODY,
};

/** The server request's attributes: method, matched route and status. */
const SERVER_ATTRIBUTES: TelemetryEvent['attributes'] = {
  'http.method': REQUEST_METHOD,
  'http.route': SERVER_ROUTE,
  'http.status_code': 200,
};

/**
 * The statement's attributes: the parameterized text, the count of rows it
 * touched, and — again as a key that must draw nothing — something shaped like
 * the rows themselves.
 */
const STATEMENT_ATTRIBUTES: TelemetryEvent['attributes'] = {
  'db.system': 'postgresql',
  'db.statement': SQL_STATEMENT,
  'db.rowCount': SQL_ROW_COUNT,
  resultRows: UNRENDERABLE_ROW_CONTENTS,
};

/** The browser request: the outermost call, and the one that resolved to source. */
const REQUEST_EVENT = makeEvent({
  id: eventIdFor(1),
  spanId: spanIdFor(1),
  kind: 'fetch',
  tier: 'browser',
  name: 'example.call',
  startTime: BASE_START_MS,
  duration: 1175,
  attributes: REQUEST_ATTRIBUTES,
  seq: 0,
  ingestSeq: 1,
  source: BASE_SOURCE,
});

/** The server request the browser call was waiting on. */
const SERVER_EVENT = makeEvent({
  id: eventIdFor(2),
  spanId: spanIdFor(2),
  parentSpanId: spanIdFor(1),
  kind: 'http.server',
  tier: 'server',
  name: 'example.server-request',
  startTime: BASE_START_MS + 8,
  duration: 1120,
  attributes: SERVER_ATTRIBUTES,
  seq: 1,
  ingestSeq: 2,
});

/** The statement the server request ran, and where most of the time went. */
const QUERY_EVENT = makeEvent({
  id: eventIdFor(3),
  spanId: spanIdFor(3),
  parentSpanId: spanIdFor(2),
  kind: 'db.query',
  tier: 'db',
  name: 'example.statement',
  startTime: BASE_START_MS + 18,
  duration: 640,
  attributes: STATEMENT_ATTRIBUTES,
  seq: 2,
  ingestSeq: 3,
});

/** The three of them, as one page. */
const CHAIN: readonly TelemetryEvent[] = [REQUEST_EVENT, SERVER_EVENT, QUERY_EVENT];

/**
 * A React commit: captured evidence, and a record this view does not draw.
 *
 * Present in several pages below as the thing that must produce no row — a
 * waterfall is about calls, and a page of commits holds nothing for it.
 */
const RENDER_EVENT = makeEvent({
  id: eventIdFor(9),
  spanId: spanIdFor(9),
  kind: 'render',
  tier: 'browser',
  name: 'example.render',
  startTime: BASE_START_MS,
  duration: 47,
  seq: 9,
  ingestSeq: 9,
});

describe('Waterfall states', () => {
  it('renders the loading state, and no rows, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes only the
    // element class that places it.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.closest('.dg-waterfall__loading')).not.toBeNull();
    expect(within(busy).getByText('Loading captured calls')).toBeTruthy();

    // Nothing is drawn yet: no tree, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('tree')).toBeNull();
    expect(drawnRows()).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

    // One query, and it was issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders its own empty message for a page holding only kinds it does not draw', async () => {
    const stub = resolvingProvider([RENDER_EVENT]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The page is a success and it is not empty — it simply holds no call — so
    // the kind filter is what has to produce the absence. A view that drew a
    // record of any kind would render an axis and one bar here instead.
    const message = await screen.findByText(EMPTY_MESSAGE);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-waterfall__empty')).not.toBeNull();

    expect(screen.queryByRole('tree')).toBeNull();
    expect(drawnRows()).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain(RENDER_EVENT.name);
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-waterfall__error')).not.toBeNull();

    // The component owns the sentence; the provider's own code reaches the
    // reader beside it, which is what makes the failure actionable (AAP 0.5.5).
    expect(alert.textContent).toContain('The captured calls could not be loaded.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, including the offset it was made
    // at. Compared as a value rather than as a spelling.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'spans',
      offset: DATA_QUERY_DEFAULT_OFFSET,
    });

    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The retry an error state offers is only useful if it really re-queries.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual(queryOfCall(stub, 1));

    // No rows, and no axis, were invented behind the failure.
    expect(drawnRows()).toHaveLength(0);
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('Waterfall rows', () => {
  it('draws a row for each call kind it reads, and none for any other record', async () => {
    // One top-level record of each kind a waterfall draws — the two browser
    // request kinds, the server request, the statement and the outgoing
    // server-side call — mixed with two records it does not.
    const drawn: readonly TelemetryEvent[] = [
      makeEvent({
        id: eventIdFor(21),
        spanId: spanIdFor(21),
        kind: 'fetch',
        tier: 'browser',
        name: 'example.fetch',
        startTime: BASE_START_MS,
        duration: 300,
        seq: 0,
        ingestSeq: 1,
      }),
      makeEvent({
        id: eventIdFor(22),
        spanId: spanIdFor(22),
        kind: 'xhr',
        tier: 'browser',
        name: 'example.xhr',
        startTime: BASE_START_MS + 10,
        duration: 80,
        seq: 1,
        ingestSeq: 2,
      }),
      makeEvent({
        id: eventIdFor(23),
        spanId: spanIdFor(23),
        kind: 'http.server',
        tier: 'server',
        name: 'example.incoming',
        startTime: BASE_START_MS + 20,
        duration: 250,
        seq: 2,
        ingestSeq: 3,
      }),
      makeEvent({
        id: eventIdFor(24),
        spanId: spanIdFor(24),
        kind: 'db.query',
        tier: 'db',
        name: 'example.statement',
        startTime: BASE_START_MS + 30,
        duration: 180,
        seq: 3,
        ingestSeq: 4,
      }),
      makeEvent({
        id: eventIdFor(25),
        spanId: spanIdFor(25),
        kind: 'http.client',
        tier: 'server',
        name: 'example.outgoing',
        startTime: BASE_START_MS + 40,
        duration: 120,
        seq: 4,
        ingestSeq: 5,
      }),
    ];
    const undrawn: readonly TelemetryEvent[] = [
      RENDER_EVENT,
      makeEvent({
        id: eventIdFor(26),
        spanId: spanIdFor(26),
        kind: 'interaction',
        tier: 'browser',
        name: 'example.interaction',
        startTime: BASE_START_MS,
        duration: 1200,
        seq: 5,
        ingestSeq: 6,
      }),
    ];
    const stub = resolvingProvider([...undrawn, ...drawn]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    expect(drawnRows()).toHaveLength(drawn.length);

    for (const event of drawn) {
      // Each of these records carries neither a URL nor a route, so its own
      // name is the label — which is what lets one assertion loop name every
      // kind without five different label rules.
      const row = rowLabelled(event.name);
      expect(row.getAttribute('aria-label') ?? '').toContain(
        `${formatKindLabel(event.kind)} · ${formatTierLabel(event.tier)}`,
      );
      expect(within(row).getByText(formatDuration(event.duration))).toBeTruthy();
    }

    // The two records of other kinds are absent from the rows AND from what the
    // rows announce: a filter that hid a bar but kept its name in a description
    // would still be reporting evidence this view cannot place.
    for (const event of undrawn) {
      expect(screen.queryByText(event.name)).toBeNull();
      expect(rowDescriptions().some((description) => description.includes(event.name))).toBe(false);
    }

    // The count states the calls it drew, not the records it received.
    expect(screen.getByText(`${formatCount(drawn.length)} calls`)).toBeTruthy();
  });

  it('measures every offset from the first call it drew, not from the earliest record', async () => {
    const first = makeEvent({
      id: eventIdFor(11),
      spanId: spanIdFor(11),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.first-call',
      startTime: BASE_START_MS,
      duration: 40,
      seq: 0,
      ingestSeq: 1,
    });
    const second = makeEvent({
      id: eventIdFor(12),
      spanId: spanIdFor(12),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.second-call',
      startTime: BASE_START_MS + 120,
      duration: 60,
      seq: 1,
      ingestSeq: 2,
    });

    // The page also holds a record that starts HALF A SECOND EARLIER and is of
    // a kind this view does not draw. The window must still begin at the first
    // drawn call, or every offset on screen would be inflated by that lead —
    // which is exactly the staircase reading a waterfall exists to give
    // (AAP 0.4.2).
    const earlier = makeEvent({
      id: eventIdFor(13),
      spanId: spanIdFor(13),
      kind: 'render',
      tier: 'browser',
      name: 'example.earlier-render',
      startTime: BASE_START_MS - 500,
      duration: 4,
      seq: 2,
      ingestSeq: 3,
    });

    // Handed over out of order, so the time ordering of the rows is the view's
    // own rather than the page's.
    const stub = resolvingProvider([earlier, second, first]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    expect(drawnRows()).toHaveLength(2);

    expect(descriptionAt(0)).toContain(`starts ${formatDuration(0)} into the window`);
    expect(descriptionAt(0)).toContain(`took ${formatDuration(40)}`);
    expect(descriptionAt(1)).toContain(`starts ${formatDuration(120)} into the window`);
    expect(descriptionAt(1)).toContain(`took ${formatDuration(60)}`);

    // The 120 ms gap is the whole point, so it is also asserted as a
    // difference rather than only as two independent strings.
    expect(descriptionAt(1)).not.toContain(`starts ${formatDuration(620)} into the window`);

    // The axis spans the drawn calls: first start to last end, 180 ms.
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      `Time axis spanning ${formatDurationCompact(180)} from the first call`,
    );

    // An offset is a wait, never a wall-clock reading: the epoch value the
    // capture carried appears nowhere, in text or in a description.
    for (const description of rowDescriptions()) {
      expect(description).not.toContain(String(BASE_START_MS));
    }
    expect(document.body.textContent ?? '').not.toContain(String(BASE_START_MS));
  });

  it('renders the method, the status code and the duration, and marks a failure', async () => {
    const failedUrl = 'http://127.0.0.1:3000/example/resource?attempt=?';
    const okUrl = 'http://127.0.0.1:3000/example/collection?page=?';
    const failed = makeEvent({
      id: eventIdFor(31),
      spanId: spanIdFor(31),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.failed-call',
      startTime: BASE_START_MS,
      duration: 420,
      status: 'error',
      attributes: { 'http.method': REQUEST_METHOD, url: failedUrl, 'http.status_code': 503 },
      seq: 0,
      ingestSeq: 1,
    });
    const succeeded = makeEvent({
      id: eventIdFor(32),
      spanId: spanIdFor(32),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.call',
      startTime: BASE_START_MS + 500,
      duration: 60,
      attributes: { 'http.method': 'GET', url: okUrl, 'http.status_code': 200 },
      seq: 1,
      ingestSeq: 2,
    });
    const stub = resolvingProvider([failed, succeeded]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    const failedRow = rowLabelled(failedUrl);

    const method = within(failedRow).getByText(REQUEST_METHOD);
    expect(method.classList.contains('dg-badge')).toBe(true);
    expect(method.classList.contains('dg-badge--outline')).toBe(true);

    // A server failure is marked as one through the chip's TONE, which resolves
    // to a token inside `Badge`; no colour is chosen by this component.
    const failedStatus = within(failedRow).getByText('503');
    expect(failedStatus.classList.contains('dg-waterfall__status')).toBe(true);
    expect(failedStatus.classList.contains('dg-badge--danger')).toBe(true);
    expect(failedRow.classList.contains('dg-is-error')).toBe(true);
    expect(failedRow.getAttribute('aria-label') ?? '').toContain('status 503');

    const duration = within(failedRow).getByText(formatDuration(420));
    expect(duration.classList.contains('dg-duration-cell')).toBe(true);
    expect(duration.classList.contains('dg-waterfall__duration')).toBe(true);

    // And a success is not marked as a failure, which is what makes the tone
    // above a statement about the status rather than a constant.
    const okRow = rowLabelled(okUrl);
    const okStatus = within(okRow).getByText('200');
    expect(okStatus.classList.contains('dg-badge--success')).toBe(true);
    expect(okStatus.classList.contains('dg-badge--danger')).toBe(false);
    expect(okRow.classList.contains('dg-is-error')).toBe(false);
    expect(within(okRow).getByText(formatDuration(60))).toBeTruthy();
  });
});

describe('Waterfall nesting', () => {
  it('discloses the calls that ran inside a row, and reports the disclosure', async () => {
    const stub = resolvingProvider(CHAIN);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    // One row on screen, and two calls nested inside it: a collapsed subtree is
    // not in the document at all.
    expect(drawnRows()).toHaveLength(1);
    expect(rowLabelled(REQUEST_URL).getAttribute('aria-level')).toBe('1');
    expect(rowLabelled(REQUEST_URL).getAttribute('aria-expanded')).toBe('false');

    const disclosure = within(rowLabelled(REQUEST_URL)).getByRole('button', { name: EXPAND_NAME });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    await user.click(disclosure);

    // Both the row and its control report the state after the gesture.
    expect(rowLabelled(REQUEST_URL).getAttribute('aria-expanded')).toBe('true');
    expect(
      within(rowLabelled(REQUEST_URL))
        .getByRole('button', { name: COLLAPSE_NAME })
        .getAttribute('aria-expanded'),
    ).toBe('true');

    // The call the browser request was waiting on is now visible, one level in,
    // inside the group its parent owns.
    expect(drawnRows()).toHaveLength(2);
    const server = rowLabelled(SERVER_ROUTE);
    expect(server.getAttribute('aria-level')).toBe('2');
    const group = server.parentElement;
    expect(group?.getAttribute('role')).toBe('group');
    expect(rowLabelled(REQUEST_URL).getAttribute('aria-owns')).toBe(group?.getAttribute('id'));

    // The host is told which view, which row and which state — not asked to
    // work out a parity (AAP 0.4.2).
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
    expect(spies.onExpand).toHaveBeenCalledWith(NODE_ID, REQUEST_EVENT.id, true);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // The statement two levels down keeps its place under the server request
    // that issued it, which is the reading the whole view exists for.
    await user.click(within(server).getByRole('button', { name: EXPAND_NAME }));

    expect(drawnRows()).toHaveLength(3);
    expect(rowLabelled(SQL_STATEMENT).getAttribute('aria-level')).toBe('3');
    expect(spies.onExpand).toHaveBeenCalledTimes(2);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, SERVER_EVENT.id, true);

    // Collapsing the outermost row takes its whole subtree with it, and reports
    // the state after that gesture too.
    await user.click(within(rowLabelled(REQUEST_URL)).getByRole('button', { name: COLLAPSE_NAME }));

    expect(drawnRows()).toHaveLength(1);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, REQUEST_EVENT.id, false);

    // Disclosure is not selection, at any point.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('nests a call under its nearest drawn ancestor when the span between is another kind', async () => {
    // The service correlated a function span between the server request and the
    // statement it ran. A waterfall does not draw function spans, and dropping
    // the statement to the top level because of that would break the one
    // reading the view is for: the row that held the time must stay visibly
    // INSIDE the row that was blocked by it.
    const bridging = makeEvent({
      id: eventIdFor(4),
      spanId: spanIdFor(4),
      parentSpanId: spanIdFor(2),
      kind: 'function',
      tier: 'server',
      name: 'example.step',
      startTime: BASE_START_MS + 12,
      duration: 900,
      seq: 3,
      ingestSeq: 4,
    });
    const nested = makeEvent({
      id: eventIdFor(5),
      spanId: spanIdFor(5),
      parentSpanId: spanIdFor(4),
      kind: 'db.query',
      tier: 'db',
      name: 'example.statement',
      startTime: BASE_START_MS + 18,
      duration: 640,
      attributes: STATEMENT_ATTRIBUTES,
      seq: 4,
      ingestSeq: 5,
    });
    const stub = resolvingProvider([REQUEST_EVENT, SERVER_EVENT, bridging, nested]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    await user.click(within(rowLabelled(REQUEST_URL)).getByRole('button', { name: EXPAND_NAME }));
    await user.click(within(rowLabelled(SERVER_ROUTE)).getByRole('button', { name: EXPAND_NAME }));

    // Three rows, not four: the bridging span is collapsed through rather than
    // drawn, and the statement sits directly under the server request.
    expect(drawnRows()).toHaveLength(3);
    expect(rowLabelled(SQL_STATEMENT).getAttribute('aria-level')).toBe('3');
    expect(screen.queryByText(bridging.name)).toBeNull();
    expect(rowDescriptions().some((description) => description.includes(bridging.name))).toBe(
      false,
    );
  });
});

describe('Waterfall privacy', () => {
  it('renders the redacted URL and the parameterized statement exactly as they arrived', async () => {
    const stub = resolvingProvider(CHAIN);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    await user.click(within(rowLabelled(REQUEST_URL)).getByRole('button', { name: EXPAND_NAME }));
    await user.click(within(rowLabelled(SERVER_ROUTE)).getByRole('button', { name: EXPAND_NAME }));

    // Byte comparisons rather than containment checks: both strings arrive in
    // their final display form, and re-assembling a URL from parts,
    // unescaping a mask, pretty-printing a statement or putting a placeholder's
    // value back would each satisfy a looser assertion (AAP 0.5.2).
    const url = screen.getByText(REQUEST_URL);
    expect(url.textContent).toBe(REQUEST_URL);
    expect(url.textContent).toContain('tenant=?');

    const statement = screen.getByText(SQL_STATEMENT);
    expect(statement.textContent).toBe(SQL_STATEMENT);
    expect(statement.textContent).toContain('$1');
    // A statement keeps its monospaced type role, so a reader can tell a
    // statement from a URL without reading either.
    expect(statement.tagName.toLowerCase()).toBe('code');

    // No control anywhere offers a raw value, a body or a result set: none of
    // that was captured, so such a control could only mislead. The list is
    // checked for being non-empty first, or the loop would pass vacuously.
    const names = controlNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(BODY_CONTROL);
    }

    // The body- and row-shaped attribute values a producer must never report
    // reach neither the screen nor a description.
    const smuggled = [
      UNRENDERABLE_REQUEST_BODY,
      UNRENDERABLE_RESPONSE_BODY,
      UNRENDERABLE_ROW_CONTENTS,
    ];
    const rendered = document.body.textContent ?? '';
    for (const value of smuggled) {
      expect(rendered).not.toContain(value);
      expect(rowDescriptions().some((description) => description.includes(value))).toBe(false);
    }
  });

  it('states how many rows a statement touched, and never what was in them', async () => {
    // The statement on its own: its parent link points outside the page, so it
    // is drawn as a top-level row.
    const stub = resolvingProvider([QUERY_EVENT]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    const row = rowLabelled(SQL_STATEMENT);
    const count = within(row).getByText(`${formatCount(SQL_ROW_COUNT)} rows`);
    expect(count.classList.contains('dg-badge')).toBe(true);
    expect(row.getAttribute('aria-label') ?? '').toContain(
      `${formatCount(SQL_ROW_COUNT)} rows touched`,
    );

    // A count, and nothing that resembles the rows themselves.
    expect(row.textContent ?? '').not.toContain(UNRENDERABLE_ROW_CONTENTS);
    expect(row.getAttribute('aria-label') ?? '').not.toContain(UNRENDERABLE_ROW_CONTENTS);
  });

  it('states an unobserved transfer size as unavailable rather than as zero', async () => {
    const unmeasuredUrl = 'http://127.0.0.1:3000/example/collection?page=?';
    const unmeasured = makeEvent({
      id: eventIdFor(34),
      spanId: spanIdFor(34),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.call',
      startTime: BASE_START_MS + 20,
      duration: 90,
      attributes: { 'http.method': 'GET', url: unmeasuredUrl, 'http.status_code': 200 },
      seq: 3,
      ingestSeq: 4,
    });
    const stub = resolvingProvider([REQUEST_EVENT, unmeasured, SERVER_EVENT]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    // Observed: the figure, formatted as a quantity.
    expect(rowLabelled(REQUEST_URL).getAttribute('aria-label') ?? '').toContain(
      `transferred ${formatBytes(TRANSFERRED_BYTES)}`,
    );

    // Not observed, though this kind of call would normally carry it: stated as
    // unavailable, never as a zero that would read as "nothing was
    // transferred" (AAP 0.6.6).
    const unmeasuredRow = rowLabelled(unmeasuredUrl);
    const unmeasuredDescription = unmeasuredRow.getAttribute('aria-label') ?? '';
    expect(unmeasuredDescription).toContain(`transferred ${NOT_AVAILABLE_LABEL}`);
    expect(unmeasuredDescription).not.toContain(`transferred ${formatBytes(0)}`);
    // Reachable by pointer as well as by assistive technology: the tooltip
    // carries the same sentence.
    expect(
      within(unmeasuredRow).getByRole('tooltip', { hidden: true }).textContent ?? '',
    ).toContain(`transferred ${NOT_AVAILABLE_LABEL}`);

    // A server span has no resource timing behind it, so the figure is not
    // expected there and is not claimed to be missing either.
    await user.click(within(rowLabelled(REQUEST_URL)).getByRole('button', { name: EXPAND_NAME }));
    expect(rowLabelled(SERVER_ROUTE).getAttribute('aria-label') ?? '').not.toContain('transferred');
  });
});

describe('Waterfall interactions', () => {
  it('hands the host the very location a row resolved to, and selects nothing', async () => {
    const stub = resolvingProvider([REQUEST_EVENT]);
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
    // this one acts blind on the object it is handed (AAP 0.4.2).
    expect(received).toEqual(BASE_SOURCE);
    expect(Object.keys(received).sort()).toEqual(expectedKeys);
    expect(received.file).toBe(SOURCE_FILE);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.line).toBe(SOURCE_LINE);
    expect(received.column).toBe(SOURCE_COLUMN);
    expect(received.symbol).toBe(SOURCE_SYMBOL);

    // Opening source is not selecting the row the chip sits in: the chip's
    // activation stops at the chip.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(rowLabelled(REQUEST_URL).getAttribute('aria-selected')).toBe('false');
  });

  it('reports an activated row as the record it stands for', async () => {
    // The server request alone: nothing nested under it and no resolved
    // location, so the row holds no control of its own and the click can only
    // be the row's own activation.
    const stub = resolvingProvider([SERVER_EVENT]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    const row = rowLabelled(SERVER_ROUTE);
    expect(row.getAttribute('aria-selected')).toBe('false');
    expect(within(row).queryAllByRole('button')).toHaveLength(0);

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
      eventId: SERVER_EVENT.id,
      spanId: SERVER_EVENT.spanId,
      traceId: TRACE_ID,
    });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // The row shows that the click landed where the reader aimed.
    expect(rowLabelled(SERVER_ROUTE).getAttribute('aria-selected')).toBe('true');
    expect(rowLabelled(SERVER_ROUTE).classList.contains('dg-is-selected')).toBe(true);

    // Selecting a record is not opening its source, and it is not a disclosure.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('activates a focused row from the keyboard as well as the pointer', async () => {
    const stub = resolvingProvider([SERVER_EVENT]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    // Every row is its own tab stop, so reaching one and pressing Enter is the
    // keyboard route to the same intent a click raises.
    const row = rowLabelled(SERVER_ROUTE);
    row.focus();
    expect(document.activeElement).toBe(row);

    await user.keyboard('{Enter}');

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: SERVER_EVENT.id,
      spanId: SERVER_EVENT.spanId,
      traceId: TRACE_ID,
    });
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });
});

describe('Waterfall paging', () => {
  it('says how much of the result is on screen and appends the next page', async () => {
    // `nextOffset` is deliberately not the length of the page: the contract is
    // that a view copies the offset the SERVICE reported, never one it derived
    // from what arrived, which drifts the moment a limit is clamped
    // (AAP 0.4.2).
    const firstCall = makeEvent({
      id: eventIdFor(41),
      spanId: spanIdFor(41),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.first-call',
      startTime: BASE_START_MS,
      duration: 120,
      seq: 0,
      ingestSeq: 1,
    });
    const secondCall = makeEvent({
      id: eventIdFor(42),
      spanId: spanIdFor(42),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.second-call',
      startTime: BASE_START_MS + 200,
      duration: 80,
      seq: 1,
      ingestSeq: 2,
    });
    const stub = pagingProvider([
      { data: [firstCall], total: 30, nextOffset: 1 },
      { data: [secondCall], total: 30, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // One call of thirty, said plainly rather than implied by a bare count.
    await screen.findByText(
      `${formatCount(1)} calls · loaded ${formatCount(1)} of ${formatCount(30)}`,
    );
    expect(drawnRows()).toHaveLength(1);

    const first = soleQuery(stub);
    expect(first.source).toBe('spans');
    expect(first.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next page is requested at the offset the service reported.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const second = queryOfCall(stub, 2);
    expect(second.offset).toBe(1);
    expect(second.offset ?? DATA_QUERY_DEFAULT_OFFSET).toBeGreaterThan(
      first.offset ?? DATA_QUERY_DEFAULT_OFFSET,
    );
    expect(second.source).toBe('spans');

    // Appended, not replaced: the call the reader was already looking at stays,
    // and the footer counts both.
    await waitFor(() => {
      expect(drawnRows()).toHaveLength(2);
    });
    expect(
      screen.getByText(`${formatCount(2)} calls · loaded ${formatCount(2)} of ${formatCount(30)}`),
    ).toBeTruthy();
    expect(screen.getByText(firstCall.name)).toBeTruthy();
    expect(screen.getByText(secondCall.name)).toBeTruthy();

    // And the appended page joins the same window rather than restarting it:
    // the second call began 200 ms after the first.
    expect(descriptionAt(0)).toContain(`starts ${formatDuration(0)} into the window`);
    expect(descriptionAt(1)).toContain(`starts ${formatDuration(200)} into the window`);
  });

  it('offers no next page, and states only what it drew, when the service reported neither', async () => {
    const stub = resolvingProvider([REQUEST_EVENT, SERVER_EVENT, QUERY_EVENT]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Three calls arrived and three rows exist, two of them nested; with no
    // total reported, claiming coverage would be an invention, so the footer
    // says what it drew and nothing about a remainder.
    await screen.findByText(`${formatCount(CHAIN.length)} calls`);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(soleQuery(stub).offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
  });
});
