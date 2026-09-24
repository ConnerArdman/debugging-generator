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
 *     {@link makeNode} take overrides, and nothing here calls a telemetry
 *     runtime helper to build a record. The one telemetry runtime value read is
 *     `KIND_ALLOWED_TIERS`, the event schema's own kind-to-tier rule, so the
 *     case that draws every catalogued kind gives each record a tier the schema
 *     permits instead of a table retyped here; the node catalog's entry is read
 *     the same way, through `catalogEntryFor`. Nothing but the component
 *     stylesheet is read from disk.
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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_QUERY_DEFAULT_OFFSET, catalogEntryFor } from '@debuggen/panel-schema';
import type { DataQuery, WaterfallNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { KIND_ALLOWED_TIERS } from '@debuggen/telemetry';
import type { RequestGroup, RequestOccurrence, TelemetryEvent } from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
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
 * The headings of the two empty states that are not an empty capture: an
 * explicit count-only request, and a page that is empty while its query is not.
 */
const COUNT_ONLY_TITLE = 'Count only';
const EMPTY_PAGE_TITLE = 'Nothing on this page';

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
 * A provider that answers each query with the page its SESSION and OFFSET
 * select, and rejects any query no page was built for.
 *
 * The builder the page-identity cases use: what they prove is which slice of
 * which session's result the component asked for after its node or its session
 * changed, so the answer has to depend on exactly those two coordinates rather
 * than on how many calls came before.
 *
 * @param pageFor The page for a session and a requested offset, or `undefined`
 * when the case built none for them.
 * @returns The stub provider.
 */
function slicingProvider(
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
      source: 'spans',
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
function hostTree(node: WaterfallNode, context: HostContext): ReactElement {
  return (
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={context.sessionId ?? SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <Waterfall node={node} />
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
 * @returns The render result, for a case that re-renders the same mounted view.
 */
function renderComponent(node: WaterfallNode, context: HostContext): RenderResult {
  return render(hostTree(node, context));
}

/**
 * Re-renders an already mounted view with a new node or a new host context —
 * the same component instance, so its paging state survives unless the
 * component itself decides it no longer applies.
 *
 * @param view What {@link renderComponent} returned.
 * @param node The node to draw now.
 * @param context The provider, actions and session to render it inside now.
 */
function rerenderComponent(view: RenderResult, node: WaterfallNode, context: HostContext): void {
  view.rerender(hostTree(node, context));
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
    // record of any kind would render an axis and one bar here instead. The
    // record it filtered out is captured evidence, so the state counts it
    // rather than claiming the capture held nothing.
    const message = await screen.findByText(
      `${formatCount(1)} span is loaded, and it is not a network or database call; no total was reported for this query.`,
    );
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-waterfall__empty')).not.toBeNull();
    expect(screen.getByText(EMPTY_PAGE_TITLE).classList.contains('dg-empty-state__title')).toBe(
      true,
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

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

  // The catalog entry for this node type lists `spans` and `requests` only, and
  // says `trace` is deliberately absent. A node naming either of these — which
  // validation rejects, so only an unvalidated host can mount one — must be
  // reported as unsupported and must not reach the provider at all: a branch
  // that queried them would be one no valid specification could ever select.
  it.each(['events', 'trace'] as const)(
    'reports a node whose query names the uncatalogued %s source, and asks for nothing',
    async (source) => {
      const stub = resolvingProvider(CHAIN);

      renderComponent(makeNode({ query: { source } }), {
        provider: stub.provider,
        actions: makeActions().actions,
      });

      const alert = await screen.findByRole('alert');
      expect(alert.closest('.dg-waterfall__error')).not.toBeNull();
      expect(alert.textContent).toContain('This view cannot draw that data source');

      // The node's own query is what the reader is shown, and no retry is
      // offered: re-issuing it cannot change the answer.
      const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
      expect(JSON.parse(shown.textContent ?? '')).toEqual({
        source,
        offset: DATA_QUERY_DEFAULT_OFFSET,
      });
      expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

      // Nothing was asked of the provider, and nothing drawn as if it had been.
      expect(stub.resolve).not.toHaveBeenCalled();
      expect(stub.queries).toHaveLength(0);
      expect(screen.queryByRole('tree')).toBeNull();
      expect(drawnRows()).toHaveLength(0);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Empty pages are not empty captures
 *
 * A successful result that draws no row says which situation it is in, from
 * the counters the service reported: an explicit `limit: 0` asks for a total
 * without rows, an authored offset past the end is an empty page rather than
 * an error, and a page whose records are all of kinds this view does not draw
 * still holds captured evidence. Only a total of zero — or no total at all, at
 * the first offset, with nothing loaded — is the empty capture.
 * ---------------------------------------------------------------------------
 */

/** A browser interaction: captured evidence, of a kind this view does not draw. */
const INTERACTION_EVENT = makeEvent({
  id: eventIdFor(10),
  spanId: spanIdFor(10),
  kind: 'interaction',
  tier: 'browser',
  name: 'example.interaction',
  startTime: BASE_START_MS + 4,
  duration: 9,
  seq: 10,
  ingestSeq: 10,
});

/**
 * Waits for the empty state and asserts what it says — its heading, or the
 * absence of one, and its message — and that no chart, row, failure or next
 * page is offered beside it.
 *
 * @param title The heading the state carries, or `undefined` for none.
 * @param message The state's message, in full.
 */
async function expectEmptyState(title: string | undefined, message: string): Promise<void> {
  const shown = await screen.findByText(message);
  expect(shown.classList.contains('dg-empty-state__message')).toBe(true);
  expect(shown.closest('.dg-waterfall__empty')).not.toBeNull();

  for (const heading of [COUNT_ONLY_TITLE, EMPTY_PAGE_TITLE]) {
    const found = screen.queryByText(heading);
    if (heading === title) {
      expect(found?.classList.contains('dg-empty-state__title')).toBe(true);
    } else {
      expect(found).toBeNull();
    }
  }

  expect(screen.queryByRole('tree')).toBeNull();
  expect(drawnRows()).toHaveLength(0);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
}

describe('Waterfall empty pages', () => {
  it('states a count-only request as one, naming the total the service reported', async () => {
    const stub = resolvingProvider([], { total: 42 });

    renderComponent(makeNode({ query: { source: 'spans', limit: 0 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      COUNT_ONLY_TITLE,
      `This view requests a count without rows: ${formatCount(42)} spans matched its query.`,
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

    // The explicit zero reached the provider exactly as the node asked for it.
    expect(soleQuery(stub).limit).toBe(0);
  });

  it('states a count-only request as one even when the answer echoes its own offset', async () => {
    // A count-only answer names no next page; one that echoes its own offset
    // would only re-request the page already searched, so it is not a next page.
    const stub = resolvingProvider([], { total: 42, nextOffset: 0 });

    renderComponent(makeNode({ query: { source: 'spans', limit: 0 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      COUNT_ONLY_TITLE,
      `This view requests a count without rows: ${formatCount(42)} spans matched its query.`,
    );
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('offers no Load more for an undrawn page whose next offset does not advance', async () => {
    const stub = resolvingProvider([RENDER_EVENT], { total: 42, nextOffset: 0 });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `${formatCount(1)} of the ${formatCount(42)} spans that matched this query is loaded, and it is not a network or database call.`,
    );
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('states a count-only request with no reported total as unreported, not as empty', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode({ query: { source: 'spans', limit: 0 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      COUNT_ONLY_TITLE,
      'This view requests a count without rows, and no total was reported for its query.',
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it('says where a page past the end starts, and how many spans matched', async () => {
    const stub = resolvingProvider([], { total: 150 });

    renderComponent(makeNode({ query: { source: 'spans', offset: 200 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(201)}, past the end of the ${formatCount(150)} spans that matched this query.`,
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
    expect(soleQuery(stub).offset).toBe(200);
  });

  it.each([
    [
      'several records',
      [RENDER_EVENT, INTERACTION_EVENT],
      `${formatCount(2)} of the ${formatCount(42)} spans that matched this query are loaded, and none of them is a network or database call.`,
    ],
    [
      'one record',
      [RENDER_EVENT],
      `${formatCount(1)} of the ${formatCount(42)} spans that matched this query is loaded, and it is not a network or database call.`,
    ],
  ])(
    'counts %s the kind filter removed against the reported total',
    async (_description: string, page: readonly TelemetryEvent[], message: string) => {
      const stub = resolvingProvider(page, { total: 42 });

      renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

      await expectEmptyState(EMPTY_PAGE_TITLE, message);
      expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

      // Counted, never drawn: the records themselves stay off screen.
      const text = document.body.textContent ?? '';
      for (const event of page) {
        expect(text).not.toContain(event.name);
      }
    },
  );

  it('says how many spans matched when a page inside the result arrives empty', async () => {
    const stub = resolvingProvider([], { total: 42 });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `${formatCount(42)} spans matched this query, but none are shown on this page.`,
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it('says where a later page starts when no total was reported', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode({ query: { source: 'spans', offset: 200 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(201)} and holds no spans; no total was reported for this query.`,
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it('counts request groups, not spans, for a grouped network result', async () => {
    const stub = recordingProvider(() =>
      Promise.resolve<DataQueryResponse>({ source: 'requests', data: [], total: 3 }),
    );

    renderComponent(makeNode({ query: { source: 'requests', offset: 10 } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyState(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(11)}, past the end of the ${formatCount(3)} request groups that matched this query.`,
    );
    expect(soleQuery(stub).source).toBe('requests');
  });

  it('keeps the empty-capture message for a total of zero', async () => {
    const stub = resolvingProvider([], { total: 0 });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const message = await screen.findByText(EMPTY_MESSAGE);
    await expectEmptyState(undefined, message.textContent ?? '');
  });

  it('keeps the empty-capture message for a first page with no total and nothing on it', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const message = await screen.findByText(EMPTY_MESSAGE);
    await expectEmptyState(undefined, message.textContent ?? '');
  });
});

describe('Waterfall rows', () => {
  it('draws a row for each call kind its catalog entry lists, and none for any other record', async () => {
    // One top-level record of EVERY kind the node catalog says a waterfall
    // draws, read from the catalog entry itself rather than retyped here, so a
    // kind the catalog adds later is covered by this case the moment it lands —
    // and a component that kept a narrower list of its own fails it. Each
    // record takes the first tier the event schema's cross-field rule permits
    // for its kind, and they are mixed with two records the view does not draw.
    const kinds = catalogEntryFor('waterfall').telemetryKinds;
    expect(kinds.length).toBeGreaterThan(0);
    const drawn: readonly TelemetryEvent[] = kinds.map((kind, index) => {
      const [tier] = KIND_ALLOWED_TIERS[kind];
      if (tier === undefined) {
        throw new Error(`the event schema permits no tier for the ${kind} kind`);
      }
      return makeEvent({
        id: eventIdFor(21 + index),
        spanId: spanIdFor(21 + index),
        kind,
        tier,
        name: `example.${kind}-call`,
        startTime: BASE_START_MS + index * 10,
        // Distinct per record, so a per-row duration assertion cannot pass by
        // matching another row's figure.
        duration: 60 + (kinds.length - index) * 40,
        seq: index,
        ingestSeq: index + 1,
      });
    });
    // Ids below the drawn range, so a catalog that grows cannot collide with
    // them.
    const undrawn: readonly TelemetryEvent[] = [
      RENDER_EVENT,
      makeEvent({
        id: eventIdFor(20),
        spanId: spanIdFor(20),
        kind: 'interaction',
        tier: 'browser',
        name: 'example.interaction',
        startTime: BASE_START_MS,
        duration: 1200,
        seq: kinds.length,
        ingestSeq: kinds.length + 1,
      }),
    ];
    // The absence asserted below is only a statement about the view while
    // these kinds are genuinely outside the catalog's list.
    for (const event of undrawn) {
      expect(kinds).not.toContain(event.kind);
    }
    const stub = resolvingProvider([...undrawn, ...drawn]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    expect(drawnRows()).toHaveLength(drawn.length);

    for (const event of drawn) {
      // Each of these records carries neither a URL nor a route, so its own
      // name is the label — which is what lets one assertion loop name every
      // kind without a label rule per kind.
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

    // The tree is one tab stop, and with a single row on screen that row holds
    // it; reaching it and pressing Enter is the keyboard route to the same
    // intent a click raises.
    const row = rowLabelled(SERVER_ROUTE);
    expect(row.getAttribute('tabindex')).toBe('0');
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

/*
 * ---------------------------------------------------------------------------
 * Pages that hold nothing this view draws
 *
 * The node's query goes to the service as authored, and the kind filter is
 * applied to each page here — the flat path needs the undrawn records to nest
 * a statement under its request. So a page can hold only records of other
 * kinds while a later page holds the calls, and that page is NOT an empty
 * capture: the view must say what it searched, that more remains, and keep the
 * way to the next page in reach.
 * ---------------------------------------------------------------------------
 */

/** The title of the state for pages searched with nothing drawable yet. */
const UNDRAWN_PAGES_TITLE = 'No network or database calls loaded yet';

/** The accessible name of the "Load more" control while its page is in flight. */
const LOADING_MORE_NAME = 'Loading…';

/** The title of the state for a kind filter that selects nothing drawable. */
const DISJOINT_FILTER_TITLE = 'No call kind selected';

/** A browser request on the first page of the in-flight footer case. */
const LONE_PAGE_CALL = makeEvent({
  id: eventIdFor(120),
  spanId: spanIdFor(120),
  name: 'example.first-page-call',
  startTime: BASE_START_MS,
  duration: 40,
});

/** A browser request on the second page of the paged-filter cases. */
const SECOND_PAGE_CALL = makeEvent({
  id: eventIdFor(121),
  spanId: spanIdFor(121),
  name: 'example.second-page-call',
  startTime: BASE_START_MS + 60,
  duration: 90,
});

describe('Waterfall pages with nothing to draw yet', () => {
  it('keeps "Load more" when a page holds only undrawn kinds, and draws the call a later page holds', async () => {
    // The second page is settled by hand, so the in-flight state between the
    // two pages is observable rather than raced.
    let settleSecondPage: (response: DataQueryResponse) => void = () => undefined;
    const secondPage = new Promise<DataQueryResponse>((resolve) => {
      settleSecondPage = resolve;
    });
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({
            source: 'spans',
            data: [RENDER_EVENT],
            total: 2,
            nextOffset: 1,
          })
        : secondPage,
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // What was searched, against the total, and that more remains — and not
    // the verdict that nothing was captured.
    const title = await screen.findByText(UNDRAWN_PAGES_TITLE);
    const state = title.closest<HTMLElement>('.dg-waterfall__empty');
    expect(state).not.toBeNull();
    expect(state?.textContent ?? '').toContain(
      `Loaded ${formatCount(1)} of ${formatCount(2)} captured records so far`,
    );
    expect(state?.textContent ?? '').toContain('More records remain to be searched.');
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain(RENDER_EVENT.name);

    // The way to the next page is right there, inside the state.
    const loadMore = within(state ?? document.body).getByRole('button', { name: LOAD_MORE_NAME });
    expect(loadMore.hasAttribute('disabled')).toBe(false);

    await user.click(loadMore);

    // Asked at the offset the service reported, the query otherwise as authored.
    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual({ source: 'spans', offset: 1 });

    // While it is in flight, the searched pages are still stated — not replaced
    // by the full-view loading skeleton — and the control says it is busy.
    const busy = await screen.findByRole('button', { name: LOADING_MORE_NAME });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(UNDRAWN_PAGES_TITLE)).toBeTruthy();
    expect(screen.queryByText('Loading captured calls')).toBeNull();

    await act(async () => {
      settleSecondPage({ source: 'spans', data: [SECOND_PAGE_CALL], total: 2 });
      await Promise.resolve();
    });

    // The call the second page held is drawn, and the footer counts both pages.
    await screen.findByRole('tree', { name: TREE_NAME });
    expect(drawnRows()).toHaveLength(1);
    expect(rowLabelled(SECOND_PAGE_CALL.name)).toBeTruthy();
    expect(
      screen.getByText(`${formatCount(1)} calls · loaded ${formatCount(2)} of ${formatCount(2)}`),
    ).toBeTruthy();
    expect(screen.queryByText(UNDRAWN_PAGES_TITLE)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('reports a failed next page behind pages with nothing drawable as that page, with a retry', async () => {
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({
            source: 'spans',
            data: [RENDER_EVENT],
            total: 2,
            nextOffset: 1,
          })
        : Promise.reject(
            new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
          ),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await user.click(await screen.findByRole('button', { name: LOAD_MORE_NAME }));

    // The NEXT page failed: that is what the alert says, beside the statement
    // of what was already searched — not the full-view "could not be loaded".
    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-waterfall__error')).not.toBeNull();
    expect(alert.textContent).toContain('The next page of captured calls could not be loaded.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');
    expect(screen.queryByText('The captured calls could not be loaded.')).toBeNull();
    expect(screen.getByText(UNDRAWN_PAGES_TITLE)).toBeTruthy();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

    // The retry re-asks for the page that failed, at the offset it failed at.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));
    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3)).toEqual(queryOfCall(stub, 2));
    expect(queryOfCall(stub, 3).offset).toBe(1);
  });

  it('asks for nothing, and offers no next page, when the kind filter selects no kind it draws', () => {
    const stub = resolvingProvider([RENDER_EVENT], { total: 1, nextOffset: 1 });

    renderComponent(
      makeNode({ query: { source: 'spans', filter: { kinds: ['render', 'interaction'] } } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // Why nothing is drawn, and which kinds this view would draw.
    const title = screen.getByText(DISJOINT_FILTER_TITLE);
    const state = title.closest<HTMLElement>('.dg-waterfall__empty');
    expect(state).not.toBeNull();
    expect(state?.textContent ?? '').toContain(
      "This node's kind filter selects no kind this view draws",
    );
    for (const kind of catalogEntryFor('waterfall').telemetryKinds) {
      expect(state?.textContent ?? '').toContain(formatKindLabel(kind));
    }

    // No page could ever hold a row, so none was requested and none is offered.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it('keeps "Load more" on screen, disabled and busy, while the next page behind drawn rows is in flight', async () => {
    // The counterpart of the first case, with rows already drawn: `useQuery`
    // reports no `nextOffset` while a page loads, and a footer that keyed the
    // control on `nextOffset` alone would withdraw it mid-request.
    let settleSecondPage: (response: DataQueryResponse) => void = () => undefined;
    const secondPage = new Promise<DataQueryResponse>((resolve) => {
      settleSecondPage = resolve;
    });
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({
            source: 'spans',
            data: [LONE_PAGE_CALL],
            total: 2,
            nextOffset: 1,
          })
        : secondPage,
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await user.click(await screen.findByRole('button', { name: LOAD_MORE_NAME }));
    expect(queryOfCall(stub, 2)).toEqual({ source: 'spans', offset: 1 });

    // The page in flight is the NEXT one: the drawn call stays, and the control
    // stays too — disabled, and saying why.
    const busy = await screen.findByRole('button', { name: LOADING_MORE_NAME });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.closest('.dg-waterfall__footer')).not.toBeNull();
    expect(rowLabelled(LONE_PAGE_CALL.name)).toBeTruthy();
    expect(screen.queryByText('Loading captured calls')).toBeNull();

    await act(async () => {
      settleSecondPage({ source: 'spans', data: [SECOND_PAGE_CALL], total: 2 });
      await Promise.resolve();
    });

    // Both pages drawn, the result searched to its end, and no control left.
    await waitFor(() => {
      expect(drawnRows()).toHaveLength(2);
    });
    expect(screen.queryByRole('button', { name: LOADING_MORE_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Which page sequence the accumulated pages belong to
 *
 * "Load more" keeps earlier pages in state and advances the offset. Those
 * pages belong to ONE sequence — this session, this query as authored, the
 * offset it starts from included — and the cases below re-render the SAME
 * mounted view with that sequence changed, which is how a host swaps a
 * regenerated panel in or reopens another session in the same view. The pages
 * carried from the old sequence must be dropped and the request must return to
 * the authored base offset; the advanced offset is where the OLD sequence had
 * got to, and means nothing in the new one.
 * ---------------------------------------------------------------------------
 */

/** A second fixture session, for the case that switches the panel to it. */
const OTHER_SESSION_ID = 'session-example-0002';

describe('Waterfall page identity', () => {
  it('starts over at a newly authored offset and draws nothing the previous slice accumulated', async () => {
    const firstSliceCall = makeEvent({
      id: eventIdFor(101),
      spanId: spanIdFor(101),
      name: 'example.first-slice-call',
      startTime: BASE_START_MS,
      duration: 50,
    });
    const firstSliceNextCall = makeEvent({
      id: eventIdFor(102),
      spanId: spanIdFor(102),
      name: 'example.first-slice-next-call',
      startTime: BASE_START_MS + 100,
      duration: 40,
    });
    const laterSliceCall = makeEvent({
      id: eventIdFor(103),
      spanId: spanIdFor(103),
      name: 'example.later-slice-call',
      startTime: BASE_START_MS + 300,
      duration: 30,
    });
    const stub = slicingProvider((_sessionId, offset) => {
      switch (offset) {
        case 0:
          return { data: [firstSliceCall], total: 60, nextOffset: 1 };
        case 1:
          return { data: [firstSliceNextCall], total: 60, nextOffset: 2 };
        case 40:
          return { data: [laterSliceCall], total: 60, nextOffset: 41 };
        default:
          return undefined;
      }
    });
    const context: HostContext = { provider: stub.provider, actions: makeActions().actions };
    const user = userEvent.setup();

    const view = renderComponent(makeNode({ query: { source: 'spans', offset: 0 } }), context);

    await screen.findByText(firstSliceCall.name);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(firstSliceNextCall.name);
    expect(drawnRows()).toHaveLength(2);
    expect(queryOfCall(stub, 2).offset).toBe(1);

    // The same node, with a query identical in every respect but the offset it
    // was authored to start from: another slice of the result.
    rerenderComponent(view, makeNode({ query: { source: 'spans', offset: 40 } }), context);

    await screen.findByText(laterSliceCall.name);
    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3)).toEqual({ source: 'spans', offset: 40 });

    // Nothing the first slice accumulated is drawn or counted.
    expect(drawnRows()).toHaveLength(1);
    expect(screen.queryByText(firstSliceCall.name)).toBeNull();
    expect(screen.queryByText(firstSliceNextCall.name)).toBeNull();
    expect(
      screen.getByText(`${formatCount(1)} calls · loaded ${formatCount(1)} of ${formatCount(60)}`),
    ).toBeTruthy();
  });

  it('starts over at the authored offset in a new session and draws nothing the earlier session answered', async () => {
    const earlierSessionCall = makeEvent({
      id: eventIdFor(111),
      spanId: spanIdFor(111),
      name: 'example.earlier-session-call',
      startTime: BASE_START_MS,
      duration: 50,
    });
    const earlierSessionNextCall = makeEvent({
      id: eventIdFor(112),
      spanId: spanIdFor(112),
      name: 'example.earlier-session-next-call',
      startTime: BASE_START_MS + 100,
      duration: 40,
    });
    const laterSessionCall = makeEvent({
      id: eventIdFor(113),
      spanId: spanIdFor(113),
      name: 'example.later-session-call',
      startTime: BASE_START_MS + 300,
      duration: 30,
    });
    const stub = slicingProvider((sessionId, offset) => {
      if (sessionId === SESSION_ID && offset === 0) {
        return { data: [earlierSessionCall], total: 20, nextOffset: 1 };
      }
      if (sessionId === SESSION_ID && offset === 1) {
        return { data: [earlierSessionNextCall], total: 20, nextOffset: 2 };
      }
      if (sessionId === OTHER_SESSION_ID && offset === 0) {
        return { data: [laterSessionCall], total: 5, nextOffset: 1 };
      }
      return undefined;
    });
    const actions = makeActions().actions;
    const node = makeNode();
    const user = userEvent.setup();

    const view = renderComponent(node, { provider: stub.provider, actions });

    await screen.findByText(earlierSessionCall.name);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(earlierSessionNextCall.name);
    expect(queryOfCall(stub, 2).offset).toBe(1);

    // The very same node, drawn for another session.
    rerenderComponent(view, node, {
      provider: stub.provider,
      actions,
      sessionId: OTHER_SESSION_ID,
    });

    await screen.findByText(laterSessionCall.name);
    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(stub.resolve.mock.calls[2]?.[1].sessionId).toBe(OTHER_SESSION_ID);
    expect(queryOfCall(stub, 3).offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    // The earlier session's evidence is gone from the rows and the count.
    expect(drawnRows()).toHaveLength(1);
    expect(screen.queryByText(earlierSessionCall.name)).toBeNull();
    expect(screen.queryByText(earlierSessionNextCall.name)).toBeNull();
    expect(
      screen.getByText(`${formatCount(1)} calls · loaded ${formatCount(1)} of ${formatCount(5)}`),
    ).toBeTruthy();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The tree as one composite widget
 *
 * A `role="tree"` is ONE stop in the page's Tab order (a roving tab index):
 * exactly one visible row is tabbable, the arrow keys move between rows, and
 * the controls nested inside a row are out of the Tab order so that a row is
 * never two or three stops. The cases below read `tabindex` straight off the
 * elements the roles resolved to, because the attribute IS the contract.
 * ---------------------------------------------------------------------------
 */

/** A top-level call with no source and nothing nested, labelled by its name. */
const LONE_CALL = makeEvent({
  id: eventIdFor(51),
  spanId: spanIdFor(51),
  kind: 'fetch',
  tier: 'browser',
  name: 'example.lone-call',
  startTime: BASE_START_MS + 1300,
  duration: 30,
  seq: 5,
  ingestSeq: 6,
});

/** A second one, drawn after it. */
const LATER_CALL = makeEvent({
  id: eventIdFor(52),
  spanId: spanIdFor(52),
  kind: 'fetch',
  tier: 'browser',
  name: 'example.later-call',
  startTime: BASE_START_MS + 1400,
  duration: 20,
  seq: 6,
  ingestSeq: 7,
});

/** The rows currently in the page's Tab order. */
function tabbableRows(): HTMLElement[] {
  return drawnRows().filter((row) => row.getAttribute('tabindex') === '0');
}

/** The single row in the Tab order, failing when there is not exactly one. */
function soleTabStop(): HTMLElement {
  const rows = tabbableRows();
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) {
    throw new Error('no row holds the tab stop');
  }
  return row;
}

describe('Waterfall keyboard composite', () => {
  it('keeps exactly one row in the Tab order, and moves it with the arrow keys', async () => {
    const stub = resolvingProvider([...CHAIN, LONE_CALL, LATER_CALL]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    expect(drawnRows()).toHaveLength(3);

    // The stop starts on the first top-level row, and every other row is
    // reachable only through the tree's own keys.
    expect(soleTabStop()).toBe(rowLabelled(REQUEST_URL));
    for (const row of drawnRows().slice(1)) {
      expect(row.getAttribute('tabindex')).toBe('-1');
    }

    rowLabelled(REQUEST_URL).focus();

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowLabelled(LONE_CALL.name));
    expect(soleTabStop()).toBe(rowLabelled(LONE_CALL.name));

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rowLabelled(LATER_CALL.name));
    expect(soleTabStop()).toBe(rowLabelled(LATER_CALL.name));

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rowLabelled(REQUEST_URL));
    expect(soleTabStop()).toBe(rowLabelled(REQUEST_URL));

    // Opening a row and stepping into it moves the stop one level in, and the
    // nested rows join the tree without adding a stop.
    await user.keyboard('{ArrowRight}');
    expect(drawnRows()).toHaveLength(4);
    expect(soleTabStop()).toBe(rowLabelled(REQUEST_URL));

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(rowLabelled(SERVER_ROUTE));
    expect(soleTabStop()).toBe(rowLabelled(SERVER_ROUTE));

    // A collapse that hides the row holding the stop hands it to the nearest
    // row still on screen — its parent — rather than leaving the tree with no
    // stop at all. Dispatched without focus, so it is the fallback and not a
    // focus event that moves the stop.
    fireEvent.click(within(rowLabelled(REQUEST_URL)).getByRole('button', { name: COLLAPSE_NAME }));
    expect(drawnRows()).toHaveLength(3);
    expect(soleTabStop()).toBe(rowLabelled(REQUEST_URL));
  });

  it('leaves the tree on Tab and returns to the row it left, never stopping inside a row', async () => {
    // A next page exists, so the footer's "Load more" is the control after the
    // tree in the Tab order — which is what makes "Tab left the tree" provable.
    const stub = resolvingProvider([...CHAIN, LONE_CALL], { total: 30, nextOffset: 4 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    const loadMore = screen.getByRole('button', { name: LOAD_MORE_NAME });

    // Into the tree: the first row, which holds a disclosure button and a
    // source chip — and the next Tab passes over both.
    await user.tab();
    expect(document.activeElement).toBe(rowLabelled(REQUEST_URL));
    await user.tab();
    expect(document.activeElement).toBe(loadMore);

    // Back in, to the row that was left; then the stop follows the arrow keys,
    // and leaving and returning comes back to where the reader was.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rowLabelled(REQUEST_URL));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowLabelled(LONE_CALL.name));
    await user.tab();
    expect(document.activeElement).toBe(loadMore);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rowLabelled(LONE_CALL.name));
  });

  it('keeps the disclosure and the source chip out of the Tab order, and both still work by pointer', async () => {
    const stub = resolvingProvider(CHAIN);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    const row = rowLabelled(REQUEST_URL);
    const disclosure = within(row).getByRole('button', { name: EXPAND_NAME });
    const chip = within(row).getByRole('button', { name: SOURCE_CHIP_NAME });

    expect(disclosure.getAttribute('tabindex')).toBe('-1');
    expect(chip.getAttribute('tabindex')).toBe('-1');

    await user.click(disclosure);
    expect(rowLabelled(REQUEST_URL).getAttribute('aria-expanded')).toBe('true');
    expect(spies.onExpand).toHaveBeenCalledWith(NODE_ID, REQUEST_EVENT.id, true);

    await user.click(
      within(rowLabelled(REQUEST_URL)).getByRole('button', { name: SOURCE_CHIP_NAME }),
    );
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // Neither control became a stop by being used: the row still is the one.
    expect(soleTabStop()).toBe(rowLabelled(REQUEST_URL));
  });

  it('opens the source of the focused row on Shift+Enter, with the very location, and selects nothing', async () => {
    const stub = resolvingProvider([REQUEST_EVENT, LONE_CALL]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    const sourceRow = rowLabelled(REQUEST_URL);
    const plainRow = rowLabelled(LONE_CALL.name);

    // Advertised exactly where it does something.
    expect(sourceRow.getAttribute('aria-keyshortcuts')).toBe('Shift+Enter');
    expect(plainRow.getAttribute('aria-keyshortcuts')).toBeNull();

    sourceRow.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    const [call] = spies.onOpenSource.mock.calls;
    if (call === undefined) {
      throw new Error('the open-source handler recorded no call');
    }
    // The object the record carried, by reference — the same guarantee the
    // chip keeps — and opening a file is not choosing a record.
    expect(call[0]).toBe(BASE_SOURCE);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(rowLabelled(REQUEST_URL).getAttribute('aria-selected')).toBe('false');

    // On a row with nowhere to go, the chord is not consumed and does nothing.
    const notPrevented = fireEvent.keyDown(plainRow, { key: 'Enter', shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // Plain Enter still selects.
    rowLabelled(REQUEST_URL).focus();
    await user.keyboard('{Enter}');
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: REQUEST_EVENT.id,
      spanId: REQUEST_EVENT.spanId,
      traceId: TRACE_ID,
    });
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
  });

  it('keeps navigating from a nested control a pointer focused, and leaves its Enter to it', async () => {
    const stub = resolvingProvider([...CHAIN, LONE_CALL]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    // A pointer press leaves focus on the disclosure button, which is out of
    // the Tab order but still focusable — and the arrow keys must still work
    // from there, or a click would strand the keyboard inside the row.
    const disclosure = within(rowLabelled(REQUEST_URL)).getByRole('button', { name: EXPAND_NAME });
    await user.click(disclosure);
    expect(document.activeElement).toBe(disclosure);
    expect(soleTabStop()).toBe(rowLabelled(REQUEST_URL));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowLabelled(SERVER_ROUTE));
    expect(soleTabStop()).toBe(rowLabelled(SERVER_ROUTE));

    // Enter on a pointer-focused chip is the chip's own activation: it opens
    // the source again, and the row it sits in is not selected.
    const chip = within(rowLabelled(REQUEST_URL)).getByRole('button', { name: SOURCE_CHIP_NAME });
    await user.click(chip);
    expect(document.activeElement).toBe(chip);
    await user.keyboard('{Enter}');

    expect(spies.onOpenSource).toHaveBeenCalledTimes(2);
    for (const [location] of spies.onOpenSource.mock.calls) {
      expect(location).toBe(BASE_SOURCE);
    }
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });
});

/**
 * The bubble that carries a row's description: the one `role="tooltip"` in the
 * row whose text begins with the sentence the row is named by. A row with a
 * source chip holds a second tooltip — the chip's own — which this excludes,
 * and finding anything other than exactly one fails the case.
 *
 * @param row The row.
 * @returns Its description bubble.
 */
function descriptionBubble(row: HTMLElement): HTMLElement {
  const name = row.getAttribute('aria-label') ?? '';
  const bubbles = within(row)
    .queryAllByRole('tooltip', { hidden: true })
    .filter((bubble) => (bubble.textContent ?? '').startsWith(name));
  expect(bubbles).toHaveLength(1);
  const [bubble] = bubbles;
  if (bubble === undefined) {
    throw new Error('the row has no description bubble');
  }
  return bubble;
}

/** Whether a bubble is on screen: the open state, and not the hidden utility. */
function isShown(bubble: HTMLElement): boolean {
  return (
    bubble.classList.contains('dg-is-open') && !bubble.classList.contains('dg-visually-hidden')
  );
}

describe('Waterfall description for the keyboard', () => {
  it('reveals the full description on keyboard focus of a row, with the source hint where it applies', async () => {
    const stub = resolvingProvider([REQUEST_EVENT, LONE_CALL]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    expect(isShown(descriptionBubble(rowLabelled(REQUEST_URL)))).toBe(false);

    // Tab into the tree: the row that receives focus shows its description in
    // the tooltip's open form, and hides it from assistive technology, which
    // already hears the same sentence as the row's name.
    await user.tab();
    const sourceRow = rowLabelled(REQUEST_URL);
    expect(document.activeElement).toBe(sourceRow);
    const revealed = descriptionBubble(sourceRow);
    expect(isShown(revealed)).toBe(true);
    expect(revealed.getAttribute('aria-hidden')).toBe('true');
    expect(revealed.textContent ?? '').toContain(`transferred ${formatBytes(TRANSFERRED_BYTES)}`);
    // The row's source is one chord away, and the bubble says which.
    expect(revealed.textContent ?? '').toContain('opens the source');
    expect(within(revealed).getByText('Shift').tagName.toLowerCase()).toBe('kbd');
    expect(within(revealed).getByText('Enter').tagName.toLowerCase()).toBe('kbd');

    // The arrow keys carry the reveal with the focus; a row with no source
    // offers no hint it could not honour.
    await user.keyboard('{ArrowDown}');
    const plainRow = rowLabelled(LONE_CALL.name);
    expect(isShown(descriptionBubble(plainRow))).toBe(true);
    expect(descriptionBubble(plainRow).textContent ?? '').not.toContain('opens the source');
    expect(isShown(descriptionBubble(rowLabelled(REQUEST_URL)))).toBe(false);
  });

  it('dismisses the revealed description on Escape until focus leaves the row', async () => {
    const stub = resolvingProvider([REQUEST_EVENT, LONE_CALL]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    await user.tab();
    await user.keyboard('{ArrowDown}');
    const row = rowLabelled(LONE_CALL.name);
    expect(isShown(descriptionBubble(row))).toBe(true);

    // Consumed when there was something to dismiss, and only then: a second
    // Escape belongs to whatever sits above the tree.
    expect(fireEvent.keyDown(row, { key: 'Escape' })).toBe(false);
    expect(isShown(descriptionBubble(rowLabelled(LONE_CALL.name)))).toBe(false);
    expect(document.activeElement).toBe(rowLabelled(LONE_CALL.name));
    expect(fireEvent.keyDown(rowLabelled(LONE_CALL.name), { key: 'Escape' })).toBe(true);
    expect(isShown(descriptionBubble(rowLabelled(LONE_CALL.name)))).toBe(false);

    // Leaving and returning is a new visit, and the description comes back.
    await user.keyboard('{ArrowUp}');
    await user.keyboard('{ArrowDown}');
    expect(isShown(descriptionBubble(rowLabelled(LONE_CALL.name)))).toBe(true);
  });

  it('does not pop the description when a click focuses the row', async () => {
    const stub = resolvingProvider([REQUEST_EVENT, LONE_CALL]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    await user.click(rowLabelled(LONE_CALL.name));

    // The click focused and selected the row — and moved the tab stop to it —
    // but a pointer already has the hover tooltip, so nothing popped.
    const row = rowLabelled(LONE_CALL.name);
    expect(document.activeElement).toBe(row);
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(soleTabStop()).toBe(row);
    expect(isShown(descriptionBubble(row))).toBe(false);

    // The same row reached from the keyboard afterwards does reveal it.
    await user.keyboard('{ArrowUp}');
    await user.keyboard('{ArrowDown}');
    expect(isShown(descriptionBubble(rowLabelled(LONE_CALL.name)))).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Re-attached calls (orphans)
 *
 * A call the correlator re-attached to the top level because the parent it
 * named could not be resolved is evidence, drawn and FLAGGED — never dropped and
 * never disguised as an ordinary top-level row (AAP 0.4.2). The verdict is the
 * flag the service persisted on the flat record, which a parent present in the
 * page proves stale. The correlated `trace` tree is not a source this node type
 * reads (its catalog entry excludes it), so no case here draws one.
 * ---------------------------------------------------------------------------
 */

/** The badge word a re-attached row shows — the one Timeline uses too. */
const REATTACHED_BADGE = 'Re-attached';

/** The phrase every re-attached row's description starts its sentence with. */
const REATTACHED_PHRASE = 're-attached to the top level';

/** Whether a row carries the re-attached flag in all three of its forms. */
function isFlaggedReattached(row: HTMLElement): boolean {
  const badge = within(row).queryByText(REATTACHED_BADGE);
  const flagged = row.classList.contains('dg-is-orphan');
  const described = (row.getAttribute('aria-label') ?? '').includes(REATTACHED_PHRASE);
  // All three or none: a class with no word, or a word with no state, is the
  // half-signal this view must never emit.
  expect([badge !== null, described]).toEqual([flagged, flagged]);
  if (badge !== null) {
    expect(badge.classList.contains('dg-badge--warning')).toBe(true);
    expect(badge.classList.contains('dg-badge--outline')).toBe(true);
  }
  return flagged;
}

describe('Waterfall re-attached calls', () => {
  it('flags a flat record from its persisted flag, and ignores a flag its loaded parent proves stale', async () => {
    const ownFlag = makeEvent({
      id: eventIdFor(71),
      spanId: spanIdFor(71),
      parentSpanId: spanIdFor(70),
      kind: 'db.query',
      tier: 'db',
      name: 'example.persisted-orphan',
      startTime: BASE_START_MS,
      duration: 80,
      attributes: { orphaned: true, orphanedParentSpanId: spanIdFor(70) },
    });
    // Flagged, but with no recorded parent id: the sentence says so rather than
    // naming one.
    const bareFlag = makeEvent({
      id: eventIdFor(80),
      spanId: spanIdFor(80),
      parentSpanId: spanIdFor(81),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.bare-flag',
      startTime: BASE_START_MS + 50,
      duration: 30,
      attributes: { orphaned: true },
    });
    // An undrawn step flagged as re-attached (the string form of the flag), and
    // the drawn call it lifts to the top level.
    const flaggedStep = makeEvent({
      id: eventIdFor(77),
      spanId: spanIdFor(77),
      parentSpanId: spanIdFor(78),
      kind: 'function',
      tier: 'server',
      name: 'example.flagged-step',
      startTime: BASE_START_MS + 100,
      duration: 200,
      attributes: { orphaned: 'true', orphanedParentSpanId: spanIdFor(78) },
    });
    const liftedCall = makeEvent({
      id: eventIdFor(79),
      spanId: spanIdFor(79),
      parentSpanId: spanIdFor(77),
      kind: 'http.client',
      tier: 'server',
      name: 'example.lifted-call',
      startTime: BASE_START_MS + 110,
      duration: 90,
    });
    // Stale at the top level: the flagged call's parent is an unflagged,
    // undrawn step that IS in the page, so an earlier pass's verdict no longer
    // holds even though the call still sits at the top level.
    const placedStep = makeEvent({
      id: eventIdFor(75),
      spanId: spanIdFor(75),
      kind: 'function',
      tier: 'server',
      name: 'example.placed-step',
      startTime: BASE_START_MS + 400,
      duration: 100,
    });
    const staleTop = makeEvent({
      id: eventIdFor(76),
      spanId: spanIdFor(76),
      parentSpanId: spanIdFor(75),
      kind: 'http.client',
      tier: 'server',
      name: 'example.stale-top',
      startTime: BASE_START_MS + 410,
      duration: 60,
      attributes: { orphaned: true, orphanedParentSpanId: spanIdFor(75) },
    });
    // Stale and nested: the parent arrived and is drawn.
    const server = makeEvent({
      id: eventIdFor(73),
      spanId: spanIdFor(73),
      kind: 'http.server',
      tier: 'server',
      name: 'example.late-parent',
      startTime: BASE_START_MS + 600,
      duration: 150,
    });
    const staleNested = makeEvent({
      id: eventIdFor(74),
      spanId: spanIdFor(74),
      parentSpanId: spanIdFor(73),
      kind: 'db.query',
      tier: 'db',
      name: 'example.stale-nested',
      startTime: BASE_START_MS + 610,
      duration: 70,
      attributes: { orphaned: 'true', orphanedParentSpanId: spanIdFor(73) },
    });
    const stub = resolvingProvider([
      ownFlag,
      bareFlag,
      flaggedStep,
      liftedCall,
      placedStep,
      staleTop,
      server,
      staleNested,
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    expect(drawnRows()).toHaveLength(5);

    // A persisted flag records THAT the parent was unresolvable, not which of
    // the correlator's cases applied, so no reason is claimed.
    const ownRow = rowLabelled(ownFlag.name);
    expect(isFlaggedReattached(ownRow)).toBe(true);
    expect(ownRow.getAttribute('aria-label') ?? '').toContain(
      `${REATTACHED_PHRASE}: the parent ${spanIdFor(70)} of this call never arrived`,
    );
    expect(ownRow.getAttribute('aria-label') ?? '').not.toContain('(missing-parent)');

    expect(isFlaggedReattached(rowLabelled(bareFlag.name))).toBe(true);
    expect(rowLabelled(bareFlag.name).getAttribute('aria-label') ?? '').toContain(
      `${REATTACHED_PHRASE}: the parent this call names never arrived`,
    );

    const liftedRow = rowLabelled(liftedCall.name);
    expect(isFlaggedReattached(liftedRow)).toBe(true);
    expect(liftedRow.getAttribute('aria-label') ?? '').toContain(
      `${REATTACHED_PHRASE} with an enclosing call not drawn here: the parent ${spanIdFor(78)} of that call never arrived`,
    );

    // Stale flags draw nothing, at the top level and nested.
    expect(isFlaggedReattached(rowLabelled(staleTop.name))).toBe(false);
    expect(isFlaggedReattached(rowLabelled(server.name))).toBe(false);
    await user.click(within(rowLabelled(server.name)).getByRole('button', { name: EXPAND_NAME }));
    expect(isFlaggedReattached(rowLabelled(staleNested.name))).toBe(false);

    // The undrawn steps are not drawn for carrying a flag.
    expect(screen.queryByText(flaggedStep.name)).toBeNull();
    expect(screen.queryByText(placedStep.name)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Failure in words, and the two row states the stylesheet paints
 * ---------------------------------------------------------------------------
 */

/** The word a failed call without a failing status code shows. */
const ERROR_BADGE = 'Error';

/**
 * The component stylesheet, read from disk with the `import.meta.url`
 * convention `../tokens/tokens.test.ts` documents, so the working directory is
 * irrelevant. The path is joined with `node:path` rather than resolved with
 * `new URL(…)`: under happy-dom the global `URL` is the DOM's, which Node's
 * `fileURLToPath` rejects.
 */
const COMPONENT_STYLESHEET = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'components.css'),
  'utf8',
);

/**
 * The declaration block of one selector in {@link COMPONENT_STYLESHEET}, and
 * the offset its rule starts at, failing when the rule is absent.
 *
 * @param selector The selector exactly as written at the start of its rule.
 * @returns The rule's start offset and the text between its braces.
 */
function ruleOf(selector: string): { readonly start: number; readonly body: string } {
  const start = COMPONENT_STYLESHEET.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = COMPONENT_STYLESHEET.indexOf('{', start);
  const close = COMPONENT_STYLESHEET.indexOf('}', open);
  return { start, body: COMPONENT_STYLESHEET.slice(open + 1, close) };
}

describe('Waterfall failure and state styling', () => {
  it('says "Error" on a failed call no status code conveys, and never beside one that does', async () => {
    const failedQuery = makeEvent({
      id: eventIdFor(91),
      spanId: spanIdFor(91),
      kind: 'db.query',
      tier: 'db',
      name: 'example.failed-statement',
      startTime: BASE_START_MS,
      duration: 120,
      status: 'error',
    });
    // A failed outgoing call whose response code does not read as a failure:
    // the code alone would say "fine", so the word is added.
    const failedDespiteCode = makeEvent({
      id: eventIdFor(92),
      spanId: spanIdFor(92),
      kind: 'http.client',
      tier: 'server',
      name: 'example.failed-outgoing',
      startTime: BASE_START_MS + 150,
      duration: 60,
      status: 'error',
      attributes: { 'http.status_code': 200 },
    });
    const unavailable = makeEvent({
      id: eventIdFor(93),
      spanId: spanIdFor(93),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.unavailable',
      startTime: BASE_START_MS + 250,
      duration: 40,
      status: 'error',
      attributes: { 'http.status_code': 503 },
    });
    const succeeded = makeEvent({
      id: eventIdFor(94),
      spanId: spanIdFor(94),
      kind: 'db.query',
      tier: 'db',
      name: 'example.fine-statement',
      startTime: BASE_START_MS + 320,
      duration: 20,
      status: 'ok',
    });
    const stub = resolvingProvider([failedQuery, failedDespiteCode, unavailable, succeeded]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    for (const event of [failedQuery, failedDespiteCode]) {
      const row = rowLabelled(event.name);
      const badge = within(row).getByText(ERROR_BADGE);
      expect(badge.classList.contains('dg-badge')).toBe(true);
      expect(badge.classList.contains('dg-badge--danger')).toBe(true);
      expect(badge.classList.contains('dg-waterfall__status')).toBe(true);
      expect(row.classList.contains('dg-is-error')).toBe(true);
    }
    expect(rowLabelled(failedQuery.name).getAttribute('aria-label') ?? '').toContain(
      'status Error',
    );

    // A failing code already says it, in the danger tone; a second word beside
    // it would say the same thing twice.
    const unavailableRow = rowLabelled(unavailable.name);
    expect(within(unavailableRow).getByText('503').classList.contains('dg-badge--danger')).toBe(
      true,
    );
    expect(within(unavailableRow).queryByText(ERROR_BADGE)).toBeNull();
    expect(unavailableRow.classList.contains('dg-is-error')).toBe(true);

    // And a success is not marked at all.
    const fineRow = rowLabelled(succeeded.name);
    expect(within(fineRow).queryByText(ERROR_BADGE)).toBeNull();
    expect(fineRow.classList.contains('dg-is-error')).toBe(false);
  });

  it('paints the failed and re-attached row states from tokens, beneath the selected state', () => {
    const orphan = ruleOf('.dg-waterfall__row.dg-is-orphan');
    const failed = ruleOf('.dg-waterfall__row.dg-is-error');
    const selected = ruleOf('.dg-waterfall__row.dg-is-selected');

    expect(orphan.body).toContain('border-inline-start-color: var(--dg-warning);');
    expect(orphan.body).toContain('border-inline-start-style: dashed;');
    expect(failed.body).toContain('border-inline-start-color: var(--dg-danger);');

    // Equal specificity, so source order decides: selection's accent edge must
    // come last to win over both.
    expect(orphan.start).toBeLessThan(selected.start);
    expect(failed.start).toBeLessThan(selected.start);
    expect(selected.body).toContain('border-inline-start-color: var(--dg-accent);');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Calls still in flight when the capture ended
 *
 * A request that had started and not settled when the capture ended arrives as
 * an in-flight snapshot: a `requests` occurrence marked `pending` (counted by
 * its group's `pendingCount`), or a flat `fetch`/`xhr` record carrying the
 * boolean `inFlight` marker. Its duration is how long it had been outstanding —
 * a LOWER BOUND — and no response had arrived. Drawing it as a request that
 * "took" that long, with a status or a transfer figure, would present an
 * unfinished call as a completed one.
 * ---------------------------------------------------------------------------
 */

/** The badge word a pending row shows — the one the request table uses too. */
const PENDING_BADGE = 'Pending';

/** The whole text of a Pending badge: the word, and a count on a group row. */
const PENDING_BADGE_TEXT = /^Pending(?: \d+)?$/;

/** The words a pending row prints before its duration. */
const LOWER_BOUND_WORDS = 'at least';

/** What a pending single call's description says about the missing response. */
const IN_FLIGHT_SENTENCE = 'still in flight when the capture ended; no response had arrived';

/** The redacted URL of the grouped request the pending cases draw. */
const PENDING_URL = 'http://127.0.0.1:3000/example/outstanding?cursor=?';

/** Its path, as the request aggregate derives it. */
const PENDING_PATH = '/example/outstanding';

/**
 * One settled occurrence of a grouped request, typed against the aggregate's
 * own `RequestOccurrence`: a status code, an `ok` status and a transfer figure.
 *
 * @param ordinal The ordinal its ids derive from.
 * @param startOffsetMs Its start, relative to the fixture base time.
 * @param durationMs How long it took.
 * @returns A fresh occurrence.
 */
function settledOccurrence(
  ordinal: number,
  startOffsetMs: number,
  durationMs: number,
): RequestOccurrence {
  const startTime = BASE_START_MS + startOffsetMs;
  return {
    id: eventIdFor(ordinal),
    eventId: eventIdFor(ordinal),
    spanId: spanIdFor(ordinal),
    traceId: TRACE_ID,
    startTime,
    durationMs,
    endTime: startTime + durationMs,
    statusCode: 200,
    status: 'ok',
    transferredBytes: TRANSFERRED_BYTES,
    transferSource: 'request',
    tier: 'browser',
    kind: 'fetch',
  };
}

/**
 * One pending occurrence, exactly as the aggregate publishes an in-flight
 * snapshot: `pending: true`, span status `unset`, and neither a status code nor
 * a transfer figure, because no response had arrived.
 *
 * @param ordinal The ordinal its ids derive from.
 * @param startOffsetMs Its start, relative to the fixture base time.
 * @param durationMs How long it had been outstanding when observed.
 * @returns A fresh occurrence.
 */
function pendingOccurrence(
  ordinal: number,
  startOffsetMs: number,
  durationMs: number,
): RequestOccurrence {
  const startTime = BASE_START_MS + startOffsetMs;
  return {
    id: eventIdFor(ordinal),
    eventId: eventIdFor(ordinal),
    spanId: spanIdFor(ordinal),
    traceId: TRACE_ID,
    startTime,
    durationMs,
    endTime: startTime + durationMs,
    status: 'unset',
    pending: true,
    tier: 'browser',
    kind: 'fetch',
  };
}

/**
 * A `method-path` group over `occurrences`, with the figures the aggregate
 * derives from them: durations over every occurrence, status codes and the
 * transfer sum over the settled ones only, and `pendingCount` present only
 * when at least one occurrence is pending.
 *
 * @param occurrences The group's occurrences, in canonical order.
 * @returns A fresh group.
 */
function makeRequestGroup(occurrences: readonly RequestOccurrence[]): RequestGroup {
  const durations = occurrences.map((occurrence) => occurrence.durationMs);
  const starts = occurrences.map((occurrence) => occurrence.startTime);
  const settled = occurrences.filter((occurrence) => occurrence.pending !== true);
  const pendingCount = occurrences.length - settled.length;
  const statusCodes = [
    ...new Set(settled.flatMap((occurrence) => occurrence.statusCode ?? [])),
  ].sort((left, right) => left - right);
  const transfers = settled.flatMap((occurrence) => occurrence.transferredBytes ?? []);
  const totalDurationMs = durations.reduce((sum, duration) => sum + duration, 0);
  return {
    id: 'request-group-example-0101',
    groupedBy: 'method-path',
    method: 'GET',
    url: PENDING_URL,
    path: PENDING_PATH,
    count: occurrences.length,
    duplicateCount: 0,
    hasDuplicates: false,
    duplicateWindows: [],
    firstStartTime: Math.min(...starts),
    lastStartTime: Math.max(...starts),
    totalDurationMs,
    averageDurationMs: Math.round(totalDurationMs / occurrences.length),
    maxDurationMs: Math.max(...durations),
    minDurationMs: Math.min(...durations),
    statusCodes,
    errorCount: 0,
    ...(pendingCount > 0 ? { pendingCount } : {}),
    initiators: [],
    ...(transfers.length === 0
      ? {}
      : { transferredBytes: transfers.reduce((sum, bytes) => sum + bytes, 0) }),
    occurrences,
    occurrencesTruncated: false,
  };
}

/**
 * A provider answering every query with one page of grouped requests, for a
 * node whose query names the `requests` source.
 *
 * @param groups The groups of the page.
 * @returns The stub provider.
 */
function groupsProvider(groups: readonly RequestGroup[]): StubProvider {
  return recordingProvider(() =>
    Promise.resolve<DataQueryResponse>({ source: 'requests', data: groups, total: groups.length }),
  );
}

/** A `waterfall` node reading the grouped request result. */
const REQUESTS_NODE = makeNode({ query: { source: 'requests' } });

/**
 * Whether a row states itself as pending in every form it must: the badge
 * word, the lower-bound words beside the duration it prints, and "took at
 * least" in its description — or in none of them.
 *
 * @param row The row.
 * @param durationMs The duration the row prints.
 * @returns Whether the row is drawn as pending.
 */
function isDrawnPending(row: HTMLElement, durationMs: number): boolean {
  const badge = within(row).queryByText(PENDING_BADGE_TEXT);
  const lowerBound = within(row).queryByText(LOWER_BOUND_WORDS);
  const description = row.getAttribute('aria-label') ?? '';
  const described = description.includes(`took ${LOWER_BOUND_WORDS} ${formatDuration(durationMs)}`);
  // All three or none: a badge over a duration read as complete, or the words
  // with no state, is the half-signal this view must never emit.
  expect([lowerBound !== null, described]).toEqual([badge !== null, badge !== null]);
  if (badge !== null) {
    expect(badge.classList.contains('dg-badge--info')).toBe(true);
    expect(badge.classList.contains('dg-badge--outline')).toBe(true);
    expect(badge.classList.contains('dg-waterfall__status')).toBe(true);
    // The lower-bound words and the figure share the row's duration cell.
    const cell = lowerBound?.closest<HTMLElement>('.dg-waterfall__duration');
    expect(cell?.textContent ?? '').toContain(formatDuration(durationMs));
    expect(description).not.toContain(`took ${formatDuration(durationMs)}`);
  } else {
    expect(description).toContain(`took ${formatDuration(durationMs)}`);
  }
  return badge !== null;
}

describe('Waterfall calls still in flight', () => {
  it('draws a grouped request still in flight as pending, with no response and a lower-bound duration', async () => {
    const group = makeRequestGroup([pendingOccurrence(131, 0, 180)]);
    const stub = groupsProvider([group]);

    renderComponent(REQUESTS_NODE, { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    expect(soleQuery(stub).source).toBe('requests');
    expect(drawnRows()).toHaveLength(1);

    const row = rowLabelled(PENDING_URL);
    expect(isDrawnPending(row, 180)).toBe(true);
    expect(within(row).getByText(PENDING_BADGE).textContent).toBe(PENDING_BADGE);

    const description = row.getAttribute('aria-label') ?? '';
    expect(description).toContain(IN_FLIGHT_SENTENCE);

    // No response arrived, so nothing a response would have carried is claimed:
    // no status code or "Error" chip, no failure state, no status sentence, and
    // not even an "unavailable" transfer figure.
    expect(row.querySelectorAll('.dg-waterfall__status')).toHaveLength(1);
    expect(within(row).queryByText(ERROR_BADGE)).toBeNull();
    expect(row.classList.contains('dg-is-error')).toBe(false);
    expect(description).not.toContain('status ');
    expect(description).not.toContain('transferred');
  });

  it('flags a group holding a call still in flight, and each of its calls as what it was', async () => {
    const settled = settledOccurrence(132, 0, 120);
    const pending = pendingOccurrence(133, 200, 300);
    const group = makeRequestGroup([settled, pending]);
    expect(group.pendingCount).toBe(1);
    const stub = groupsProvider([group]);
    const user = userEvent.setup();

    renderComponent(REQUESTS_NODE, { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });
    expect(drawnRows()).toHaveLength(1);

    // The group row spans both calls — 0 to 500 ms — and since one of them had
    // not finished, that extent is a lower bound too. One call pending: the
    // word alone, and the count in the description.
    const [groupRow] = drawnRows();
    if (groupRow === undefined) {
      throw new Error('the group row was not drawn');
    }
    expect(isDrawnPending(groupRow, 500)).toBe(true);
    expect(within(groupRow).getByText(PENDING_BADGE).textContent).toBe(PENDING_BADGE);
    const groupDescription = groupRow.getAttribute('aria-label') ?? '';
    expect(groupDescription).toContain('1 call still in flight when the capture ended');
    expect(groupDescription).toContain(`${formatCount(2)} calls in this group`);
    // Its outcome is the settled call's, and the settled call's bytes are real.
    expect(groupRow.classList.contains('dg-is-error')).toBe(false);
    expect(groupDescription).toContain(`transferred ${formatBytes(TRANSFERRED_BYTES)}`);

    await user.click(within(groupRow).getByRole('button', { name: EXPAND_NAME }));
    expect(drawnRows()).toHaveLength(3);
    const [, settledRow, pendingRow] = drawnRows();
    if (settledRow === undefined || pendingRow === undefined) {
      throw new Error('the occurrence rows were not drawn');
    }

    // The settled call completed: its status, and a duration it really took.
    expect(isDrawnPending(settledRow, 120)).toBe(false);
    expect(within(settledRow).getByText('200').classList.contains('dg-waterfall__status')).toBe(
      true,
    );

    // The pending one did not: no status, a lower bound, and why.
    expect(isDrawnPending(pendingRow, 300)).toBe(true);
    expect(within(pendingRow).queryByText('200')).toBeNull();
    expect(pendingRow.getAttribute('aria-label') ?? '').toContain(IN_FLIGHT_SENTENCE);
    expect(pendingRow.getAttribute('aria-label') ?? '').not.toContain('transferred');
  });

  it('reads the in-flight marker on a flat request record, strictly as the boolean', async () => {
    const inFlightUrl = 'http://127.0.0.1:3000/example/in-flight?page=?';
    const settledUrl = 'http://127.0.0.1:3000/example/settled?page=?';
    // A snapshot carrying the marker — and, as a producer must not but a bag
    // might, a status code, a transfer size and an error status: none of them
    // describes a response, because none had arrived.
    const inFlight = makeEvent({
      id: eventIdFor(141),
      spanId: spanIdFor(141),
      kind: 'fetch',
      tier: 'browser',
      name: 'example.in-flight-call',
      startTime: BASE_START_MS,
      duration: 250,
      status: 'error',
      attributes: {
        'http.method': 'GET',
        url: inFlightUrl,
        'http.status_code': 200,
        transferSize: TRANSFERRED_BYTES,
        inFlight: true,
      },
    });
    // The string form is NOT the marker: this request settled.
    const settledCall = makeEvent({
      id: eventIdFor(142),
      spanId: spanIdFor(142),
      kind: 'xhr',
      tier: 'browser',
      name: 'example.settled-call',
      startTime: BASE_START_MS + 300,
      duration: 70,
      attributes: {
        'http.method': 'GET',
        url: settledUrl,
        'http.status_code': 200,
        inFlight: 'true',
      },
    });
    const stub = resolvingProvider([inFlight, settledCall]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('tree', { name: TREE_NAME });

    const inFlightRow = rowLabelled(inFlightUrl);
    expect(isDrawnPending(inFlightRow, 250)).toBe(true);
    const inFlightDescription = inFlightRow.getAttribute('aria-label') ?? '';
    expect(inFlightDescription).toContain(IN_FLIGHT_SENTENCE);
    expect(within(inFlightRow).queryByText('200')).toBeNull();
    expect(within(inFlightRow).queryByText(ERROR_BADGE)).toBeNull();
    expect(inFlightRow.classList.contains('dg-is-error')).toBe(false);
    expect(inFlightDescription).not.toContain('status ');
    expect(inFlightDescription).not.toContain('transferred');

    const settledRow = rowLabelled(settledUrl);
    expect(isDrawnPending(settledRow, 70)).toBe(false);
    expect(within(settledRow).getByText('200')).toBeTruthy();
    expect(settledRow.getAttribute('aria-label') ?? '').toContain('status 200');
  });
});
