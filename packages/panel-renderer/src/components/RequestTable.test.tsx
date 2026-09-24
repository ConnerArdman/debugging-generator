/**
 * `components/RequestTable` — the colocated suite for the `requestTable` node,
 * the renderer side of the product's third demonstrated question.
 *
 * ## The one property this suite exists for
 *
 * Duplicate detection happens **upstream**, on the request as it was actually
 * made: the service computes an HMAC over the method, the path and the sorted
 * query pairs of the *unredacted* URL, and the telemetry aggregate groups by
 * that key (AAP 0.5.2). What reaches this component is the redacted display
 * form, whose query-parameter values have been replaced per key — so two
 * requests that differ only in a parameter arrive with **byte-identical** text.
 *
 * A client-side grouping or de-duplication pass would therefore merge two
 * genuinely different calls and report a duplicate that never happened. The
 * load-bearing case below is the mechanical guard on that: two groups whose
 * `method`, `url` and `path` strings are identical and whose `requestKey`
 * values differ must render as **two** rows, each carrying its own `count`. A
 * component that collapsed them — by URL, by path, by label, by anything it can
 * see — fails here and nowhere else in the repository at this level.
 *
 * The end-to-end assertion about a real duplicate group lives in
 * `tests/e2e/demo-duplicate-requests.spec.ts`; this suite makes sure the
 * renderer cannot manufacture one.
 *
 * ## What else is asserted, and why each one is here
 *
 *   - **The three states of a query-backed view** — loading, empty, error with a
 *     working retry — which AAP 0.8.3 asks of every component suite in this
 *     folder, driven through a stub `DataProvider` that respectively never
 *     settles, resolves an empty page and rejects.
 *   - **The click-to-source payload**: the object the host receives when an
 *     initiator chip is activated, compared by value *and* by key set, because
 *     every hop after this one acts blind on what it is handed (AAP 0.4.2).
 *   - **An absent transfer size renders the unavailable label**, never `0`: a
 *     same-origin response is the only kind whose size the browser exposes, so
 *     the absence is the ordinary case and AAP 0.6.6 records it as a known gap.
 *     A zero here would read as a response that carried nothing.
 *   - **The paging contract** (AAP 0.4.2): the footer states how much of the
 *     result is on screen, and "Load more" asks for the `offset` the *service*
 *     reported rather than one derived from the rows in hand — and only when
 *     that offset moves forward from the page it answered.
 *   - **The page size as authored**: an explicit `limit: 0` reaches the
 *     provider as zero and is never paged, an omitted limit stays omitted, and
 *     an over-sized one is held to the contract ceiling.
 *   - **An empty page is not an empty capture**: a count-only query, a page
 *     past the end, a page inside a positive total and a later page without a
 *     total each say which absence they are, and only a zero total — or an
 *     unreported one for the whole result — says nothing was captured.
 *   - **Ordering is a re-query, never a local sort**: a sortable header
 *     activation issues a new provider call carrying the mapped
 *     `DataQuerySort`, and the rows then follow the second response.
 *   - **Honest labelling of what the data marks**: a group formed from the
 *     coarser `method-path` key says so, a bounded occurrence list says it is
 *     bounded, and the local duplicates filter says it applies only to the
 *     groups loaded so far.
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`. The `panel-renderer`
 *     project does enable `globals`, but only so `@testing-library/react` can
 *     register its automatic cleanup on a global `afterEach`; every suite in
 *     this repository still names what it uses.
 *   - **`afterEach(cleanup)` registered explicitly**, because a suite that
 *     leaks a mounted tree between cases fails later with a multiple-match
 *     error that reads like a component bug.
 *   - **Stub providers built with the library's own `createDataProvider`**, so
 *     these cases exercise the very seam the DevTools panel and the editor
 *     webview implement. The resolver is a `vi.fn` and every query it receives
 *     is recorded: what the component *asked for* is as much of its contract as
 *     what it drew.
 *   - **In-file synthetic builders, no fixture files.** {@link makeOccurrence},
 *     {@link makeDuplicateWindow}, {@link makeRequestGroup} and
 *     {@link makeNode} take overrides. The aggregate's own `aggregateRequests`
 *     and `countDuplicateRequests` are deliberately **never** called: a fixture
 *     built by the code under discussion could not distinguish the renderer's
 *     behaviour from the aggregate's, so the group shapes are written by hand
 *     and only their *types* are imported.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): a resource path, two
 *     component-shaped initiator labels and two file paths that belong to no
 *     application, demonstrated or otherwise. `scripts/check-no-hardcoding.mjs`
 *     scans this text with the rest of `packages/**`.
 *   - **Queries by role and accessible name**, with a class read only off an
 *     element already obtained semantically, since no `jest-dom` matcher is
 *     available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…` or `waitFor`, and every
 *     interaction through `userEvent`.
 *
 * @see ./RequestTable for the component, its columns and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 */

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  catalogEntryFor,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, RequestTableNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { DuplicateWindow, RequestGroup, RequestOccurrence } from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  formatOffset,
  formatStatusLabel,
  humanizeLabel,
} from '../utils/format';
import { RequestTable } from './RequestTable';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral (AAP 0.5.4): no route, component,
 * service or symbol of any inspected project appears here, in the fixtures or
 * in the comments. The shapes are the capture's own — a 32-hex trace id, 16-hex
 * span ids, epoch-millisecond start times, millisecond durations, a redacted
 * URL whose parameter VALUE is already replaced — because those are the fields
 * the component reads and formats.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every occurrence below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Far enough from zero that a relative performance timestamp could not be
 * mistaken for one, which is what makes the "no epoch value is rendered"
 * assertion meaningful.
 */
const BASE_START_MS = 1_767_225_600_000;

/** The method most fixtures use, and the one the write-shaped group uses. */
const METHOD_READ = 'GET';
const METHOD_WRITE = 'POST';

/**
 * The redacted URL of the repeated request, and its path.
 *
 * The `?` after `parameter=` is not a placeholder in this file's prose: it is
 * what redaction leaves behind, a key whose value was replaced (AAP 0.5.2).
 * Two requests that differed only in that value arrive here looking exactly
 * like each other, which is the condition the re-grouping case turns into a
 * failing assertion.
 */
const RESOURCE_PATH = '/example/resource';
const RESOURCE_URL = `${RESOURCE_PATH}?parameter=?`;

/** A second, distinct request: different method, different path, no parameters. */
const COLLECTION_PATH = '/example/collection';
const COLLECTION_URL = COLLECTION_PATH;

/** The distinct callers a group can record, sorted as the aggregate sorts them. */
const INITIATOR_PANEL = 'ExamplePanel';
const INITIATOR_WIDGET = 'ExampleWidget';

/** A caller no occurrence resolved to a location for: it must render as text. */
const INITIATOR_SHELL = 'ExampleShell';

/** Project-relative, POSIX locations for the two callers that resolved. */
const WIDGET_SOURCE: SourceLocation = {
  file: 'src/example/widget.tsx',
  line: 84,
  column: 9,
  symbol: 'useExampleResource',
  resolvedBy: 'source-map',
  confidence: 0.8,
};

const PANEL_SOURCE: SourceLocation = {
  file: 'src/example/panel.tsx',
  line: 31,
  column: 5,
  symbol: 'ExamplePanelBody',
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

/** The accessible name a source chip announces (`SourceLink`'s own shape). */
function chipName(location: SourceLocation): string {
  return `Open ${location.file}:${String(location.line)}:${String(location.column)}`;
}

/** The identity of the node under test, as the panel normaliser assigns one. */
const NODE_ID = 'layout.0.requestTable';

/**
 * The three orderings the data query vocabulary offers, held as typed constants
 * so a case names the contract rather than a bare string that happens to match.
 *
 * `count_desc` is this view's own default — the repeats are the finding, so the
 * largest group belongs at the top — and the only one a column of this table
 * can claim, which is why the header case starts from a different one.
 */
const MOST_OCCURRENCES_FIRST: DataQuerySort = 'count_desc';
const LONGEST_FIRST: DataQuerySort = 'duration_desc';

/** The accessible name of the one sortable header control. */
const COUNT_SORT_NAME = 'Occurrences';

/** The toolbar's own controls and indicators. */
const TOOLBAR_NAME = 'Request ordering and filters';
const DUPLICATES_ONLY_NAME = 'Duplicates only';
const FALLBACK_GROUPING_TEXT = 'Fallback grouping';
const MIXED_GROUPING_TEXT = 'Mixed grouping';

/** The footer control that asks for the next page, and the error state's retry. */
const LOAD_MORE_NAME = 'Load more';
const RETRY_NAME = 'Retry';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/** The two grouping badges, in the component's own wording. */
const KEYED_GROUPING_TEXT = humanizeLabel('request-key');
const FALLBACK_GROUPING_BADGE_TEXT = humanizeLabel('method-path');

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 *
 * Hand-written group shapes, never aggregate output. Each optional field of the
 * aggregate's types is declared `?: T` WITHOUT `| undefined`, so under this
 * repository's `exactOptionalPropertyTypes` a key must be absent rather than
 * explicitly `undefined`; the override types below admit `undefined` and the
 * builders drop the key, which is how a case asks for a group with no request
 * key, no transfer size or an occurrence with no location.
 * ---------------------------------------------------------------------------
 */

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/** An event id derived from the same ordinal, in the store's own shape. */
function eventIdFor(ordinal: number): string {
  return `event-example-${ordinal.toString().padStart(4, '0')}`;
}

/** Overrides accepted by {@link makeOccurrence}. */
type OccurrenceOverrides = Partial<
  Pick<
    RequestOccurrence,
    'id' | 'eventId' | 'spanId' | 'traceId' | 'startTime' | 'durationMs' | 'status' | 'kind'
  >
> & {
  readonly statusCode?: number | undefined;
  readonly initiator?: string | undefined;
  readonly source?: SourceLocation | undefined;
};

/**
 * One observed execution of a request.
 *
 * `id` and `eventId` are the same value by the aggregate's own contract — one
 * names the stable paging key, the other the event a panel selects — so the
 * builder derives both from a single ordinal rather than letting a case set
 * them apart, which no producer would do. `endTime` is derived rather than
 * passed for the same reason: it is `startTime + durationMs` upstream, and a
 * fixture free to contradict that would test a shape that cannot occur.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh occurrence; nothing is shared between calls.
 */
function makeOccurrence(overrides: OccurrenceOverrides = {}): RequestOccurrence {
  const {
    startTime = BASE_START_MS,
    durationMs = 120,
    eventId = eventIdFor(1),
    id = eventId,
    spanId = spanIdFor(1),
    traceId = TRACE_ID,
    status = 'ok',
    kind = 'fetch',
    statusCode = 200,
    initiator,
    source,
  } = overrides;

  return {
    id,
    eventId,
    spanId,
    traceId,
    startTime,
    durationMs,
    endTime: startTime + durationMs,
    status,
    tier: 'browser',
    kind,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(initiator === undefined ? {} : { initiator }),
    ...(source === undefined ? {} : { source }),
  };
}

/** Overrides accepted by {@link makeDuplicateWindow}. */
type WindowOverrides = Partial<
  Pick<DuplicateWindow, 'id' | 'startTime' | 'endTime' | 'count' | 'eventIds'>
>;

/**
 * One cluster of occurrences issued close together.
 *
 * `redundantCount` is `count - 1` by the aggregate's definition and is derived
 * here, so a case cannot describe an impossible cluster. The window's measured
 * span (`endTime - startTime`) is what the duplicate tooltip must report, and
 * the duplicate case varies it precisely to prove the sentence is read off the
 * datum rather than off a detector constant.
 *
 * @param overrides Fields to replace.
 * @returns A fresh window.
 */
function makeDuplicateWindow(overrides: WindowOverrides = {}): DuplicateWindow {
  const {
    id = 'request-group-example-0001:0',
    startTime = BASE_START_MS,
    endTime = BASE_START_MS + 22,
    count = 4,
    eventIds = [eventIdFor(1), eventIdFor(2), eventIdFor(3), eventIdFor(4)],
  } = overrides;

  return { id, startTime, endTime, count, redundantCount: count - 1, eventIds };
}

/** Overrides accepted by {@link makeRequestGroup}. */
type GroupOverrides = Partial<
  Pick<
    RequestGroup,
    | 'id'
    | 'groupedBy'
    | 'method'
    | 'url'
    | 'path'
    | 'count'
    | 'duplicateCount'
    | 'hasDuplicates'
    | 'duplicateWindows'
    | 'firstStartTime'
    | 'lastStartTime'
    | 'totalDurationMs'
    | 'averageDurationMs'
    | 'maxDurationMs'
    | 'minDurationMs'
    | 'statusCodes'
    | 'errorCount'
    | 'initiators'
    | 'occurrences'
    | 'occurrencesTruncated'
  >
> & {
  readonly requestKey?: string | undefined;
  readonly transferredBytes?: number | undefined;
};

/**
 * All observed executions of one logical request, as the `requests` result
 * carries them.
 *
 * Nothing is computed from anything else here beyond the two derivations noted
 * on the occurrence and window builders: the counts, the duplicate evidence,
 * the timing aggregates and the initiator set are all passed through as
 * written. That is deliberate — the component renders them as received, so a
 * builder that recomputed them would quietly assert the fixture's arithmetic
 * instead of the component's rendering.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh group; nothing is shared between calls.
 */
function makeRequestGroup(overrides: GroupOverrides = {}): RequestGroup {
  const {
    id = 'request-group-example-0001',
    requestKey = 'request-key-example-0001',
    groupedBy = 'request-key',
    method = METHOD_READ,
    url = RESOURCE_URL,
    path = RESOURCE_PATH,
    count = 1,
    duplicateCount = 0,
    hasDuplicates = false,
    duplicateWindows = [],
    firstStartTime = BASE_START_MS,
    lastStartTime = BASE_START_MS,
    totalDurationMs = 120,
    averageDurationMs = 120,
    maxDurationMs = 120,
    minDurationMs = 120,
    statusCodes = [200],
    errorCount = 0,
    initiators = [INITIATOR_WIDGET],
    occurrences = [makeOccurrence({ initiator: INITIATOR_WIDGET, source: WIDGET_SOURCE })],
    occurrencesTruncated = false,
    transferredBytes,
  } = overrides;

  return {
    id,
    groupedBy,
    method,
    url,
    path,
    count,
    duplicateCount,
    hasDuplicates,
    duplicateWindows,
    firstStartTime,
    lastStartTime,
    totalDurationMs,
    averageDurationMs,
    maxDurationMs,
    minDurationMs,
    statusCodes,
    errorCount,
    initiators,
    occurrences,
    occurrencesTruncated,
    ...(requestKey === undefined ? {} : { requestKey }),
    ...(transferredBytes === undefined ? {} : { transferredBytes }),
  };
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<RequestTableNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `requestTable` node, as the panel normaliser produces one: an
 * id, no heading of its own (the host's section owns that), and a query whose
 * source and ordering are already explicit.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): RequestTableNode {
  const {
    id = NODE_ID,
    query = { source: 'requests', sort: MOST_OCCURRENCES_FIRST },
    title,
    description,
  } = overrides;

  return {
    type: 'requestTable',
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
 * echoes `requests` (the one source this node's catalog entry permits) rather
 * than the source it received.
 * ---------------------------------------------------------------------------
 */

/** One page a stub provider can answer with. */
interface RequestPage {
  /** The groups of the page, in the order the service returned them. */
  readonly data: readonly RequestGroup[];

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
   * The assertion surface for the ordering and paging cases: what the component
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

/**
 * A provider that answers each successive call with the next page, repeating
 * the last one once the list is exhausted.
 *
 * The builder the ordering and paging cases use: a re-query has to be able to
 * answer differently from the query before it, or "the rows follow the second
 * response" could not be told from "the rows were re-ordered locally".
 *
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(pages: readonly RequestPage[]): StubProvider {
  return recordingProvider((_query, call) => {
    const page = pages[Math.min(call, pages.length) - 1];

    if (page === undefined) {
      throw new Error('the stub provider was built with no pages');
    }

    return Promise.resolve<DataQueryResponse>({
      source: 'requests',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    });
  });
}

/**
 * A provider that resolves one page for every query.
 *
 * @param data The groups of the page, in the order they should be drawn.
 * @param extra The paging counters to report, if any.
 * @returns The stub provider.
 */
function resolvingProvider(
  data: readonly RequestGroup[],
  extra: Omit<RequestPage, 'data'> = {},
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

  /** The disclosure spy. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** The filter/sort report spy. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies.
 *
 * All four members are supplied — the two required ones because a host missing
 * either is not a host, and the two optional ones so that every case can assert
 * not only that the intent it exercised was raised but also that the others
 * were not: activating a source chip must not also select an occurrence, and
 * expanding a group must not report a filter change.
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
 * Returns the render result so a case that needs a second, independent mount —
 * the duplicate-description case, which renders two different windows to prove
 * the sentence is read off the data — can unmount the first cleanly rather than
 * relying on the suite's `afterEach`.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 * @returns The Testing Library render result.
 */
function renderComponent(
  node: RequestTableNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): RenderResult {
  return render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <RequestTable node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );
}

/**
 * The grid's data rows, in document order.
 *
 * Narrowed by the attribute the primitive writes on a data row, because the
 * header row and every expanded detail row are `role="row"` too and a bare role
 * query would count them.
 *
 * @returns The data rows.
 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-row-index') !== null);
}

/**
 * The expanded detail rows, in document order.
 *
 * Identified by the class the grid primitive gives the detail row, read off an
 * element already obtained by role.
 *
 * @returns The detail rows.
 */
function detailRows(): HTMLElement[] {
  return screen
    .getAllByRole('row')
    .filter((row) => row.classList.contains('dg-data-table__expanded'));
}

/**
 * The redacted URL text of one data row.
 *
 * Read off the row's header cell — obtained by role — and then from the URL
 * element the component places inside it, so a row carrying a method badge and
 * a grouping badge contributes its URL and nothing else.
 *
 * @param row A data row.
 * @returns The URL as rendered.
 */
function rowUrl(row: HTMLElement): string {
  const header = within(row).getByRole('rowheader');

  return header.querySelector('.dg-request-table__url')?.textContent ?? '';
}

/**
 * The URL text of every data row, in document order.
 *
 * @returns One URL per row.
 */
function renderedUrls(): string[] {
  return dataRows().map((row) => rowUrl(row));
}

/**
 * One row's cells, by the column they belong to.
 *
 * Positional by necessity — the grid exposes cells in column order — and safe
 * because the column order itself is asserted once, against the catalog's own
 * column list, in the first rendering case below. Reading a named cell rather
 * than searching the row for a formatted string is what keeps a per-column
 * assertion from passing on another column's identical value: a group whose
 * average, slowest and total durations are equal is the ordinary shape of a
 * group with one occurrence.
 *
 * @param row A data row.
 * @returns That row's eight data cells.
 */
function cellsOf(row: HTMLElement): {
  readonly status: HTMLElement;
  readonly count: HTMLElement;
  readonly duplicates: HTMLElement;
  readonly average: HTMLElement;
  readonly slowest: HTMLElement;
  readonly total: HTMLElement;
  readonly transferred: HTMLElement;
  readonly initiators: HTMLElement;
} {
  const cells = within(row).getAllByRole('gridcell');
  const [status, count, duplicates, average, slowest, total, transferred, initiators] = cells;

  if (
    status === undefined ||
    count === undefined ||
    duplicates === undefined ||
    average === undefined ||
    slowest === undefined ||
    total === undefined ||
    transferred === undefined ||
    initiators === undefined
  ) {
    throw new Error(`a data row rendered ${String(cells.length)} cells, not eight`);
  }

  return { status, count, duplicates, average, slowest, total, transferred, initiators };
}

/**
 * The text of every tooltip bubble inside an element.
 *
 * The tooltip primitive keeps its bubble mounted for the trigger's whole life —
 * `aria-describedby` has to resolve at the moment a reader reaches the trigger —
 * so its text is in the accessibility tree whether or not it is visible, which
 * is what lets a case assert on a description without hovering.
 *
 * @param scope The element to search.
 * @returns One string per bubble.
 */
function tooltipTexts(scope: HTMLElement): string[] {
  return within(scope)
    .queryAllByRole('tooltip')
    .map((bubble) => bubble.textContent ?? '');
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
 * The two groups most cases draw
 *
 * Distinct in every field a per-row assertion reads — method, URL, path,
 * counts, status codes, timing, callers, transfer size — so no assertion can
 * pass by matching the wrong row. One carries duplicate evidence and a transfer
 * size; the other carries neither, which is what makes it the unavailable-size
 * and no-duplicates case without a fixture of its own.
 * ---------------------------------------------------------------------------
 */

/** The window the repeated group's duplicates fell into: four issuances, 22 ms. */
const REPEATED_WINDOW = makeDuplicateWindow({
  id: 'request-group-example-0001:0',
  startTime: BASE_START_MS,
  endTime: BASE_START_MS + 22,
  count: 4,
});

/** The four occurrences of the repeated group, in canonical order. */
const REPEATED_OCCURRENCES: readonly RequestOccurrence[] = [
  makeOccurrence({
    eventId: eventIdFor(1),
    spanId: spanIdFor(1),
    startTime: BASE_START_MS,
    durationMs: 90,
    initiator: INITIATOR_WIDGET,
    source: WIDGET_SOURCE,
  }),
  makeOccurrence({
    eventId: eventIdFor(2),
    spanId: spanIdFor(2),
    startTime: BASE_START_MS + 8,
    durationMs: 180,
    initiator: INITIATOR_PANEL,
    source: PANEL_SOURCE,
  }),
  makeOccurrence({
    eventId: eventIdFor(3),
    spanId: spanIdFor(3),
    startTime: BASE_START_MS + 15,
    durationMs: 105,
    initiator: INITIATOR_WIDGET,
  }),
  makeOccurrence({
    eventId: eventIdFor(4),
    spanId: spanIdFor(4),
    startTime: BASE_START_MS + 22,
    durationMs: 96,
    initiator: INITIATOR_PANEL,
  }),
];

/**
 * A request issued four times inside one cluster, by two distinct callers.
 *
 * Two callers rather than one on purpose: a duplicate group with two initiators
 * is a different finding from one caller firing twice (AAP 0.8.2), and the
 * initiator cases below are what keep the column from collapsing to the first.
 */
const REPEATED_GROUP = makeRequestGroup({
  id: 'request-group-example-0001',
  requestKey: 'request-key-example-0001',
  groupedBy: 'request-key',
  method: METHOD_READ,
  url: RESOURCE_URL,
  path: RESOURCE_PATH,
  count: 4,
  duplicateCount: 3,
  hasDuplicates: true,
  duplicateWindows: [REPEATED_WINDOW],
  firstStartTime: BASE_START_MS,
  lastStartTime: BASE_START_MS + 22,
  totalDurationMs: 471,
  averageDurationMs: 118,
  maxDurationMs: 180,
  minDurationMs: 90,
  statusCodes: [200],
  errorCount: 0,
  initiators: [INITIATOR_PANEL, INITIATOR_WIDGET],
  occurrences: REPEATED_OCCURRENCES,
  transferredBytes: 2048,
});

/**
 * A request issued once, with no duplicate evidence and no exposed size.
 *
 * Its transfer size is absent rather than zero, which is the ordinary case for
 * a response whose bytes nothing measured (AAP 0.6.6).
 */
const SINGLE_GROUP = makeRequestGroup({
  id: 'request-group-example-0002',
  requestKey: 'request-key-example-0002',
  groupedBy: 'request-key',
  method: METHOD_WRITE,
  url: COLLECTION_URL,
  path: COLLECTION_PATH,
  count: 1,
  duplicateCount: 0,
  hasDuplicates: false,
  duplicateWindows: [],
  firstStartTime: BASE_START_MS + 40,
  lastStartTime: BASE_START_MS + 40,
  totalDurationMs: 42,
  averageDurationMs: 42,
  maxDurationMs: 42,
  minDurationMs: 42,
  statusCodes: [201],
  errorCount: 0,
  initiators: [INITIATOR_SHELL],
  occurrences: [
    makeOccurrence({
      eventId: eventIdFor(9),
      spanId: spanIdFor(9),
      startTime: BASE_START_MS + 40,
      durationMs: 42,
      statusCode: 201,
      initiator: INITIATOR_SHELL,
    }),
  ],
});

/**
 * The page most cases resolve, deliberately **not** in occurrence-count order
 * (1 then 4) while the node asks for `count_desc`.
 *
 * The service applied the ordering it was given (AAP 0.4.2), so a component
 * that re-ranked the page locally would show an order no response ever
 * reported — which is what the ordering case turns into a failure.
 */
const PROVIDER_ORDER: readonly RequestGroup[] = [SINGLE_GROUP, REPEATED_GROUP];

/** The URLs of that page, in the same order. */
const PROVIDER_ORDER_URLS: readonly string[] = PROVIDER_ORDER.map((group) => group.url);

/** Every column of this table, in the order the component declares them. */
const COLUMN_HEADERS: readonly string[] = [
  'Request',
  'Status',
  'Occurrences',
  'Duplicates',
  'Average',
  'Slowest',
  'Total',
  'Transferred',
  'Initiated by',
];

describe('RequestTable states', () => {
  it('renders the loading state, and no rows, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes only the
    // element class that places it.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.classList.contains('dg-request-table__loading')).toBe(true);

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();

    // The toolbar stays mounted so the ordering control does not appear and
    // disappear under a reader, and its one toggle is disabled while there is
    // nothing loaded for it to filter.
    const toolbar = screen.getByRole('group', { name: TOOLBAR_NAME });
    expect(
      within(toolbar).getByRole('button', { name: DUPLICATES_ONLY_NAME }).hasAttribute('disabled'),
    ).toBe(true);

    // One query, and it was issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders its own empty message, and no rows, for a successful empty page', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic substring of the product's own copy rather than by a
    // restatement of the sentence, then checked to be exactly that: product
    // vocabulary, naming no inspected project (AAP 0.5.4).
    const message = await screen.findByText(/no network requests were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);

    for (const url of PROVIDER_ORDER_URLS) {
      expect(message.textContent).not.toContain(url);
    }

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure, and there is no grid to hold rows.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-request-table__error')).toBe(true);

    // The failure is stated in this view's own words — what could not be
    // resolved, and that the capture is untouched — with the provider's code
    // carried through so the reader can act on it. The provider's raw message is
    // deliberately NOT shown as analysis (AAP 0.5.5): it is logged, not read
    // back to the developer as a finding.
    expect(alert.textContent).toContain(
      'The grouped requests for this panel could not be resolved',
    );
    expect(alert.textContent).toContain('The capture is unchanged');
    expect(within(alert).getByText('TRANSPORT_DISCONNECTED').classList.contains('dg-badge')).toBe(
      true,
    );

    // The query that failed is shown in full, and compared as a value rather
    // than as a spelling. No `limit`: the node authored none, so none is
    // invented and the side that resolves the query applies the contract's own
    // default (AAP 0.4.2).
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'requests',
      sort: MOST_OCCURRENCES_FIRST,
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

describe('RequestTable rows', () => {
  it('draws one row per group, with its method, URL, statuses, counts and timing', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The grid is named by the node's caption, which falls back to the catalog's
    // own label when the node carries no title of its own. Spelled out rather
    // than read back through `catalogEntryFor`, so this case pins the label a
    // reader hears instead of restating whatever the catalog currently holds.
    await screen.findByRole('grid', { name: 'Request table' });
    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);

    // Every column the component declares, in its declared order. The cell
    // readers below are positional against exactly this list.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      ...COLUMN_HEADERS,
    ]);

    for (const group of PROVIDER_ORDER) {
      const row = dataRows()[PROVIDER_ORDER_URLS.indexOf(group.url)];

      if (row === undefined) {
        throw new Error(`no rendered row draws the group at ${group.url}`);
      }

      // The identity cell is the row's header, so a reader hears the row named
      // by the request it stands for: the method as a badge, then the URL.
      const header = within(row).getByRole('rowheader');
      expect(within(header).getByText(group.method).classList.contains('dg-badge')).toBe(true);
      expect(rowUrl(row)).toBe(group.url);

      const cells = cellsOf(row);

      // Status codes as received, ascending and distinct; nothing re-derives them.
      for (const code of group.statusCodes) {
        expect(within(cells.status).getByText(String(code))).toBeDefined();
      }

      // Counts are printed through the shared count formatter, so a grouped
      // thousand reads as one. The duplicates figure is queried rather than
      // read off the cell, because a group with duplicates wraps its badge in a
      // tooltip whose description is part of the cell's text.
      expect(cells.count.textContent).toBe(formatCount(group.count));
      expect(within(cells.duplicates).getByText(formatCount(group.duplicateCount))).toBeDefined();

      // Each duration cell draws its own aggregate, formatted with its unit and
      // placed by the duration primitive.
      expect(cells.average.textContent).toBe(formatDuration(group.averageDurationMs));
      expect(cells.slowest.textContent).toBe(formatDuration(group.maxDurationMs));
      expect(cells.total.textContent).toBe(formatDuration(group.totalDurationMs));
      expect(
        within(cells.average)
          .getByText(formatDuration(group.averageDurationMs))
          .classList.contains('dg-duration-cell'),
      ).toBe(true);

      // No epoch timestamp is rendered anywhere in the row: a group's times are
      // aggregates and offsets, never wall-clock readings (AAP 0.2.3).
      expect(row.textContent).not.toContain(String(group.firstStartTime));
      expect(row.textContent).not.toContain(String(group.lastStartTime));
    }

    // One literal each, to prove the durations and sizes are rendered as scaled
    // quantities rather than as the raw numbers the capture carried.
    const repeated = dataRows()[PROVIDER_ORDER_URLS.indexOf(REPEATED_GROUP.url)];

    if (repeated === undefined) {
      throw new Error('the repeated group rendered no row');
    }

    expect(cellsOf(repeated).total.textContent).toBe('471.00 ms');
    expect(cellsOf(repeated).transferred.textContent).toBe('2.0 kB');
    expect(cellsOf(repeated).transferred.textContent).toBe(formatBytes(2048));
  });

  it('uses the node title as the grid caption when the node carries one', async () => {
    const stub = resolvingProvider([REPEATED_GROUP]);

    renderComponent(makeNode({ title: 'Repeated requests' }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: 'Repeated requests' });
  });

  it('keeps two groups apart when only their request keys differ', async () => {
    /*
     * THE LOAD-BEARING CASE (AAP 0.5.2).
     *
     * Both groups carry the same method, the same path and the same redacted
     * URL — byte for byte — because redaction replaced the query value that
     * distinguished them. Only `requestKey` tells them apart, and that key is
     * computed by the service from the request as it was actually made, so it
     * is not something this component can see or reproduce.
     *
     * Two rows must therefore render, each with its own count. A component that
     * re-grouped, de-duplicated or merged by anything it CAN see would collapse
     * them into one row and report a duplicate that never happened.
     */
    const twinA = makeRequestGroup({
      id: 'request-group-example-0011',
      requestKey: 'request-key-example-0011',
      method: METHOD_READ,
      url: RESOURCE_URL,
      path: RESOURCE_PATH,
      count: 4,
      duplicateCount: 3,
      hasDuplicates: true,
      duplicateWindows: [makeDuplicateWindow({ id: 'request-group-example-0011:0', count: 4 })],
      statusCodes: [200],
      initiators: [INITIATOR_WIDGET],
      occurrences: [makeOccurrence({ initiator: INITIATOR_WIDGET })],
    });
    const twinB = makeRequestGroup({
      id: 'request-group-example-0012',
      requestKey: 'request-key-example-0012',
      method: METHOD_READ,
      url: RESOURCE_URL,
      path: RESOURCE_PATH,
      count: 2,
      duplicateCount: 0,
      hasDuplicates: false,
      duplicateWindows: [],
      statusCodes: [200],
      initiators: [INITIATOR_WIDGET],
      occurrences: [makeOccurrence({ eventId: eventIdFor(5), initiator: INITIATOR_WIDGET })],
    });

    const stub = resolvingProvider([twinA, twinB]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const rows = dataRows();
    expect(rows).toHaveLength(2);

    // Identical text, and rendered exactly as supplied: the redacted form is
    // what the reader sees, unparsed and unreconstructed.
    expect(renderedUrls()).toEqual([RESOURCE_URL, RESOURCE_URL]);
    expect(twinA.url).toBe(twinB.url);
    expect(twinA.path).toBe(twinB.path);
    expect(twinA.requestKey).not.toBe(twinB.requestKey);

    const [first, second] = rows;

    if (first === undefined || second === undefined) {
      throw new Error('the grid did not render both rows of the page');
    }

    // Each row states its own counts. A merged row would read `6`, and a row
    // that had absorbed the other's evidence would badge duplicates on both.
    expect(cellsOf(first).count.textContent).toBe(formatCount(4));
    expect(cellsOf(second).count.textContent).toBe(formatCount(2));
    expect(within(cellsOf(first).duplicates).getByText(formatCount(3))).toBeDefined();
    expect(cellsOf(second).duplicates.textContent).toBe(formatCount(0));

    // The key itself is evidence the service holds, not text for a reader: it
    // is never printed, and neither is any grouping claim derived from it here.
    expect(screen.getByRole('grid').textContent).not.toContain('request-key-example-0011');

    // No affordance offers a body, a payload or a captured result anywhere in
    // this view: bodies are never captured, so none can be shown (AAP 0.5.2).
    expect(screen.queryByRole('button', { name: /body|payload/i })).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/body|payload/i);
  });

  it('renders rows in the order the provider returned them, without re-ranking', async () => {
    // The page is deliberately not in count order (1, then 4) while the node
    // asks for `count_desc`: the service applied that ordering, so a local
    // re-rank would draw an order no response ever reported.
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    expect(renderedUrls()).toEqual([...PROVIDER_ORDER_URLS]);

    // Stated as a property too, so the intent survives a fixture change: the
    // rendered order is not the count ranking.
    const counts = PROVIDER_ORDER.map((group) => group.count);
    expect(counts).not.toEqual([...counts].sort((left, right) => right - left));
    expect(soleQuery(stub).sort).toBe(MOST_OCCURRENCES_FIRST);
  });
});

describe('RequestTable duplicate evidence', () => {
  it('badges a group with duplicates and describes its largest cluster from the data', async () => {
    /*
     * The description has to be a statement about THIS capture, not about the
     * detector's configuration, so the case renders two groups whose windows
     * differ only in span and asserts the sentence moves with them. A component
     * that named a constant window — the aggregate's default, say — would pass
     * the first expectation and fail the second.
     */
    const spans: readonly number[] = [22, 7];
    const seen: string[] = [];

    for (const [ordinal, span] of spans.entries()) {
      const groupId = `request-group-example-002${String(ordinal)}`;
      const group = makeRequestGroup({
        id: groupId,
        count: 4,
        duplicateCount: 3,
        hasDuplicates: true,
        duplicateWindows: [
          makeDuplicateWindow({
            id: `${groupId}:0`,
            startTime: BASE_START_MS,
            endTime: BASE_START_MS + span,
            count: 4,
          }),
        ],
        lastStartTime: BASE_START_MS + span,
      });
      const stub = resolvingProvider([group]);
      const view = renderComponent(makeNode(), {
        provider: stub.provider,
        actions: makeActions().actions,
      });

      await screen.findByRole('grid');

      const [row] = dataRows();

      if (row === undefined) {
        throw new Error('the grid rendered no data row');
      }

      const cell = cellsOf(row).duplicates;

      // The redundant count is badged rather than printed plainly, and the row
      // carries the duplicate state class the stylesheet emphasises.
      const badge = within(cell).getByText(formatCount(group.duplicateCount));
      expect(badge.classList.contains('dg-badge')).toBe(true);
      expect(badge.classList.contains('dg-request-table__duplicate-badge')).toBe(true);
      expect(within(row).getByRole('rowheader').querySelector('.dg-is-duplicate') !== null).toBe(
        true,
      );

      const [description] = tooltipTexts(cell);

      if (description === undefined) {
        throw new Error('the duplicates cell rendered no description');
      }

      // Every number in the sentence comes from the group: the redundant count
      // against the total, how many clusters there were, and the MEASURED span
      // of the largest one.
      expect(description).toContain(`${formatCount(3)} of ${formatCount(4)}`);
      expect(description).toContain(`Clusters: ${formatCount(1)}`);
      expect(description).toContain(formatDuration(span));

      seen.push(description);
      view.unmount();
      cleanup();
    }

    const [first, second] = seen;

    if (first === undefined || second === undefined) {
      throw new Error('both windows should have produced a description');
    }

    // The two descriptions differ, and each names its own window's span: the
    // sentence is read off the datum, not off a constant.
    expect(first).not.toBe(second);
    expect(first).toContain(formatDuration(22));
    expect(second).not.toContain(formatDuration(22));
  });

  it('prints a plain redundant count, and no badge, for a group without duplicates', async () => {
    const stub = resolvingProvider([SINGLE_GROUP]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const [row] = dataRows();

    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    const cell = cellsOf(row).duplicates;

    // Zero redundant occurrences is an observation, so it is printed — and it is
    // printed as text, with no badge and no cluster description to explain
    // evidence that does not exist.
    expect(cell.textContent).toBe(formatCount(0));
    expect(cell.querySelector('.dg-badge')).toBeNull();
    expect(tooltipTexts(cell)).toEqual([]);
  });

  it('says at page level when a fallback-grouped row shares the page with a keyed one', async () => {
    const fallbackGroup = makeRequestGroup({
      id: 'request-group-example-0031',
      requestKey: undefined,
      groupedBy: 'method-path',
      method: METHOD_WRITE,
      url: COLLECTION_URL,
      path: COLLECTION_PATH,
      count: 3,
      statusCodes: [202],
      initiators: [INITIATOR_SHELL],
      occurrences: [makeOccurrence({ eventId: eventIdFor(7), initiator: INITIATOR_SHELL })],
    });
    const stub = resolvingProvider([REPEATED_GROUP, fallbackGroup]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const rows = dataRows();
    const [keyedRow, fallbackRow] = rows;

    if (keyedRow === undefined || fallbackRow === undefined) {
      throw new Error('the grid did not render both rows of the page');
    }

    // Each row states its own grouping, in the component's own wording, and the
    // fallback row's note states the CONSEQUENCE: its counts are an upper bound.
    const keyedHeader = within(keyedRow).getByRole('rowheader');
    const fallbackHeader = within(fallbackRow).getByRole('rowheader');

    expect(within(keyedHeader).getByText(KEYED_GROUPING_TEXT)).toBeDefined();
    expect(within(fallbackHeader).getByText(FALLBACK_GROUPING_BADGE_TEXT)).toBeDefined();

    const keyedNotes = tooltipTexts(keyedHeader).join(' ');
    const fallbackNotes = tooltipTexts(fallbackHeader).join(' ');

    expect(fallbackNotes).toContain('no request key was available');
    expect(fallbackNotes).toContain('upper bound');
    // The keyed row makes no fallback claim of its own.
    expect(keyedNotes).not.toContain('upper bound');
    expect(keyedNotes).toContain('before its query values were redacted');

    // And the page says it mixes the two, rather than implying one grouping
    // throughout.
    const toolbar = screen.getByRole('group', { name: TOOLBAR_NAME });
    expect(within(toolbar).getByText(MIXED_GROUPING_TEXT)).toBeDefined();
    expect(within(toolbar).queryByText(FALLBACK_GROUPING_TEXT)).toBeNull();
  });

  it('says the whole page is fallback-grouped when no row carries a key', async () => {
    const stub = resolvingProvider([
      makeRequestGroup({
        id: 'request-group-example-0041',
        requestKey: undefined,
        groupedBy: 'method-path',
        count: 2,
      }),
    ]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const toolbar = screen.getByRole('group', { name: TOOLBAR_NAME });
    expect(within(toolbar).getByText(FALLBACK_GROUPING_TEXT)).toBeDefined();
    expect(within(toolbar).queryByText(MIXED_GROUPING_TEXT)).toBeNull();
  });

  it('claims no fallback when every row was formed from a request key', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const toolbar = screen.getByRole('group', { name: TOOLBAR_NAME });
    expect(within(toolbar).queryByText(FALLBACK_GROUPING_TEXT)).toBeNull();
    expect(within(toolbar).queryByText(MIXED_GROUPING_TEXT)).toBeNull();
  });
});

/**
 * A group with three distinct callers, two of which resolved to a location.
 *
 * The third is what proves a label without a location renders as text rather
 * than as a chip that leads nowhere, and the two that resolved are what prove
 * the column is never collapsed to its first entry (AAP 0.8.2).
 */
const MIXED_INITIATOR_GROUP = makeRequestGroup({
  id: 'request-group-example-0051',
  requestKey: 'request-key-example-0051',
  method: METHOD_READ,
  url: RESOURCE_URL,
  path: RESOURCE_PATH,
  count: 3,
  firstStartTime: BASE_START_MS,
  lastStartTime: BASE_START_MS + 15,
  totalDurationMs: 375,
  averageDurationMs: 125,
  maxDurationMs: 180,
  minDurationMs: 90,
  statusCodes: [200],
  initiators: [INITIATOR_PANEL, INITIATOR_SHELL, INITIATOR_WIDGET],
  occurrences: [
    makeOccurrence({
      eventId: eventIdFor(1),
      spanId: spanIdFor(1),
      startTime: BASE_START_MS,
      durationMs: 90,
      initiator: INITIATOR_WIDGET,
      source: WIDGET_SOURCE,
    }),
    makeOccurrence({
      eventId: eventIdFor(2),
      spanId: spanIdFor(2),
      startTime: BASE_START_MS + 8,
      durationMs: 180,
      initiator: INITIATOR_PANEL,
      source: PANEL_SOURCE,
    }),
    makeOccurrence({
      eventId: eventIdFor(3),
      spanId: spanIdFor(3),
      startTime: BASE_START_MS + 15,
      durationMs: 105,
      initiator: INITIATOR_SHELL,
    }),
  ],
});

describe('RequestTable callers and click-to-source', () => {
  it('renders every distinct caller, linking the ones that resolved to a location', async () => {
    const stub = resolvingProvider([MIXED_INITIATOR_GROUP]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const [row] = dataRows();

    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    const cell = cellsOf(row).initiators;

    // All three labels are on screen — the set is never collapsed to the first.
    for (const initiator of MIXED_INITIATOR_GROUP.initiators) {
      expect(within(cell).getByText(initiator)).toBeDefined();
    }

    // Exactly the two callers an occurrence resolved a location for are chips,
    // each naming its own location.
    expect(within(cell).getAllByRole('button')).toHaveLength(2);
    expect(within(cell).getByRole('button', { name: chipName(WIDGET_SOURCE) })).toBeDefined();
    expect(within(cell).getByRole('button', { name: chipName(PANEL_SOURCE) })).toBeDefined();

    // The third is plain text rather than a dead link: no occurrence attributed
    // to it carried a location, and a chip that opens nothing is the feature
    // failing quietly.
    const unlinked = within(cell).getByText(INITIATOR_SHELL);
    expect(unlinked.classList.contains('dg-request-table__initiator')).toBe(true);
    expect(unlinked.closest('button')).toBeNull();
  });

  it('hands the host the very location the activated caller resolved to', async () => {
    const stub = resolvingProvider([MIXED_INITIATOR_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    // Taken BEFORE the render and compared afterwards: comparing the emitted
    // object's keys against the live fixture alone would be satisfied by a
    // component that added a field to it in place.
    const expectedKeys = Object.keys({ ...WIDGET_SOURCE }).sort();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    const chip = await screen.findByRole('button', { name: chipName(WIDGET_SOURCE) });

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
    expect(Object.keys(received).sort()).toEqual(expectedKeys);
    expect(received.file).toBe(WIDGET_SOURCE.file);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.line).toBe(WIDGET_SOURCE.line);
    expect(received.column).toBe(WIDGET_SOURCE.column);
    expect(received.symbol).toBe(WIDGET_SOURCE.symbol);

    // Opening source is not selecting an occurrence, expanding a group or
    // changing a filter: the chip's activation stops at the chip.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });
});

describe('RequestTable transfer size', () => {
  it('shows the unavailable label, and never a zero, for a group with no exposed size', async () => {
    const stub = resolvingProvider([SINGLE_GROUP]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const [row] = dataRows();

    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    const cell = cellsOf(row).transferred;

    // The label the whole product uses for an unobservable quantity, imported
    // rather than spelled, so a change to it cannot leave this case asserting
    // yesterday's text (AAP 0.6.6).
    expect(within(cell).getByText(NOT_AVAILABLE_LABEL)).toBeDefined();
    expect(cell.textContent).toContain(NOT_AVAILABLE_LABEL);

    // Not a zero, and not a formatted zero either: `0 B` would read as a
    // response that carried nothing, which is a different claim.
    expect(within(cell).queryByText('0')).toBeNull();
    expect(within(cell).queryByText(formatBytes(0))).toBeNull();

    // And the absence is explained where the reader meets it.
    expect(tooltipTexts(cell).join(' ')).toContain('No transfer size was exposed');
  });

  it('formats a measured size through the shared byte formatter', async () => {
    const stub = resolvingProvider([REPEATED_GROUP]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const [row] = dataRows();

    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    const cell = cellsOf(row).transferred;
    expect(cell.textContent).toBe(formatBytes(2048));
    expect(within(cell).queryByText(NOT_AVAILABLE_LABEL)).toBeNull();
  });
});

/** The accessible name of a group's disclosure control, in either state. */
function disclosureName(group: RequestGroup, expanded: boolean): string {
  return `${expanded ? 'Hide occurrences' : 'Show occurrences'}: ${group.method} ${group.path}`;
}

/** The accessible name of one occurrence's selection control. */
function occurrenceName(group: RequestGroup, occurrence: RequestOccurrence): string {
  return `Select the occurrence at ${formatOffset(occurrence.startTime, group.firstStartTime)}`;
}

describe('RequestTable occurrences', () => {
  it('reports a disclosure and lists every occurrence of the opened group', async () => {
    const stub = resolvingProvider([REPEATED_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    // Nothing is open until the developer asks, and nothing has been reported.
    expect(detailRows()).toHaveLength(0);
    expect(spies.onExpand).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: disclosureName(REPEATED_GROUP, false) }));

    // The state AFTER the gesture, as the interface specifies, keyed by this
    // node's own id so a host with several request tables can tell them apart.
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
    expect(spies.onExpand).toHaveBeenCalledWith(NODE_ID, REPEATED_GROUP.id, true);
    expect(spies.onFilterChange).not.toHaveBeenCalled();

    const [detail] = detailRows();

    if (detail === undefined) {
      throw new Error('the opened group rendered no detail row');
    }

    // Every occurrence, each with its own offset from the group's first
    // issuance, its own duration and its own caller.
    for (const occurrence of REPEATED_GROUP.occurrences) {
      const control = within(detail).getByRole('button', {
        name: occurrenceName(REPEATED_GROUP, occurrence),
      });
      expect(control).toBeDefined();
      expect(within(detail).getByText(formatDuration(occurrence.durationMs))).toBeDefined();

      // The offset is relative, so no epoch reading is printed for it.
      expect(detail.textContent).not.toContain(String(occurrence.startTime));
    }

    for (const initiator of REPEATED_GROUP.initiators) {
      expect(within(detail).getAllByText(initiator).length).toBeGreaterThan(0);
    }

    // A complete occurrence list makes no claim about being bounded.
    expect(detail.textContent).not.toContain('Occurrences shown:');

    // Closing reports the same disclosure with the state after that gesture.
    await user.click(screen.getByRole('button', { name: disclosureName(REPEATED_GROUP, true) }));

    expect(spies.onExpand).toHaveBeenCalledTimes(2);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, REPEATED_GROUP.id, false);
    expect(detailRows()).toHaveLength(0);
  });

  it('selects one occurrence as the event it stands for', async () => {
    const stub = resolvingProvider([REPEATED_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: disclosureName(REPEATED_GROUP, false) }));

    // The second occurrence, so a handler that reached for the group's first
    // occurrence — or for the group itself — cannot pass.
    const target = REPEATED_GROUP.occurrences[1];

    if (target === undefined) {
      throw new Error('the fixture group holds fewer than two occurrences');
    }

    await user.click(screen.getByRole('button', { name: occurrenceName(REPEATED_GROUP, target) }));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;

    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    const ref = call[0];

    // The three identifiers the host needs to resolve the record, taken from
    // that occurrence and nothing else. An aggregate row is not one event, so
    // no coordinate is fabricated for it.
    expect(ref).toEqual({
      eventId: target.eventId,
      spanId: target.spanId,
      traceId: target.traceId,
    });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // Selecting a record is not opening its source, and it is not a filter.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('says how many occurrences it holds when the datum marks the list bounded', async () => {
    const truncated = makeRequestGroup({
      id: 'request-group-example-0061',
      requestKey: 'request-key-example-0061',
      count: 9,
      duplicateCount: 8,
      hasDuplicates: true,
      duplicateWindows: [makeDuplicateWindow({ id: 'request-group-example-0061:0', count: 9 })],
      lastStartTime: BASE_START_MS + 22,
      occurrences: [
        makeOccurrence({
          eventId: eventIdFor(1),
          spanId: spanIdFor(1),
          durationMs: 90,
          initiator: INITIATOR_WIDGET,
        }),
        makeOccurrence({
          eventId: eventIdFor(2),
          spanId: spanIdFor(2),
          startTime: BASE_START_MS + 8,
          durationMs: 180,
          initiator: INITIATOR_WIDGET,
        }),
      ],
      occurrencesTruncated: true,
    });
    const stub = resolvingProvider([truncated]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: disclosureName(truncated, false) }));

    const [detail] = detailRows();

    if (detail === undefined) {
      throw new Error('the opened group rendered no detail row');
    }

    // The list says what it is: two of the nine the count claims. Silence here
    // would let a reader take a bounded sample for the whole group.
    expect(
      within(detail).getByText(
        `Occurrences shown: ${formatCount(truncated.occurrences.length)} of ${formatCount(
          truncated.count,
        )}.`,
      ),
    ).toBeDefined();

    // And the count the row states is unaffected by the bound on the samples.
    const [row] = dataRows();

    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    expect(cellsOf(row).count.textContent).toBe(formatCount(9));
  });

  it('explains an empty occurrence list rather than opening onto nothing', async () => {
    const withoutSamples = makeRequestGroup({
      id: 'request-group-example-0071',
      requestKey: 'request-key-example-0071',
      count: 2,
      initiators: [],
      occurrences: [],
    });
    const stub = resolvingProvider([withoutSamples]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: disclosureName(withoutSamples, false) }));

    const [detail] = detailRows();

    if (detail === undefined) {
      throw new Error('the opened group rendered no detail row');
    }

    expect(within(detail).getByText(/no individual occurrences were returned/i)).toBeDefined();

    // A group whose callers were never reported says so with the same label an
    // unmeasured quantity uses, rather than with a blank cell.
    const [row] = dataRows();

    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    expect(within(cellsOf(row).initiators).getByText(NOT_AVAILABLE_LABEL)).toBeDefined();
  });
});

/** The footer's coverage statement, as one string. */
function footerNote(): string {
  return screen.getByText(/^Groups loaded:/).textContent ?? '';
}

/** The header cell of the one sortable column, for its `aria-sort`. */
function countHeader(): Element | null {
  return screen.getByRole('button', { name: COUNT_SORT_NAME }).closest('[role="columnheader"]');
}

describe('RequestTable ordering', () => {
  it('turns a header activation into a new query and follows the response', async () => {
    // Two pages: the node's own `duration_desc` ordering, then whatever the
    // service returns for `count_desc`. The second page is a different order of
    // the same groups, which is the only way to tell "the rows follow the new
    // response" from "the rows were re-ordered in the browser".
    const reordered: readonly RequestGroup[] = [REPEATED_GROUP, SINGLE_GROUP];
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: reordered }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(
      makeNode({
        query: { source: 'requests', sort: LONGEST_FIRST, limit: DATA_QUERY_DEFAULT_LIMIT },
      }),
      { provider: stub.provider, actions: spies.actions },
    );

    await screen.findByRole('grid');
    expect(renderedUrls()).toEqual([...PROVIDER_ORDER_URLS]);
    expect(soleQuery(stub).sort).toBe(LONGEST_FIRST);

    // A group carries three durations and two timestamps, and the contract does
    // not say which one its duration ordering ranks by, so no column claims it:
    // the occurrence column reports `none` while that ordering is in force.
    expect(countHeader()?.getAttribute('aria-sort')).toBe('none');

    await user.click(screen.getByRole('button', { name: COUNT_SORT_NAME }));

    // A re-query, in the ordering vocabulary the data layer understands.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const requeried = queryOfCall(stub, 2);
    expect(requeried.sort).toBe(MOST_OCCURRENCES_FIRST);
    expect(requeried.source).toBe('requests');
    expect(requeried.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    // A new ordering is a new page sequence, so it starts at the node's offset.
    expect(requeried.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    // And the rows follow that response, in its order — the first page held the
    // same groups, so an order matching the second response could only have
    // come from the second response.
    await waitFor(() => {
      expect(renderedUrls()).toEqual(reordered.map((group) => group.url));
    });
    expect(countHeader()?.getAttribute('aria-sort')).toBe('descending');

    // The host is told, so it can remember the reader's choice. It is a report
    // of a selection in the component's own vocabulary and carries no query
    // shape (AAP 0.4.2).
    expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).toHaveBeenCalledWith(NODE_ID, {
      sort: MOST_OCCURRENCES_FIRST,
      duplicatesOnly: 'false',
    });
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('does not re-query when the activated column already holds the applied order', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    // The node already asks for `count_desc`, and the contract offers one
    // direction per ordering, so a second activation has nothing to request —
    // and above all must not re-rank the page locally instead.
    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    expect(countHeader()?.getAttribute('aria-sort')).toBe('descending');

    await user.click(screen.getByRole('button', { name: COUNT_SORT_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(renderedUrls()).toEqual([...PROVIDER_ORDER_URLS]);
  });
});

/**
 * An authored offset past the first page, so a case can tell the page's own
 * offset from the contract default and a position from an index.
 */
const AUTHORED_OFFSET = 5;

/** A node query that asks for the total of its source and no rows. */
const COUNT_ONLY_QUERY: DataQuery = { source: 'requests', sort: MOST_OCCURRENCES_FIRST, limit: 0 };

/** The empty-state titles of a count-only page and of an empty page within a result. */
const COUNT_ONLY_TITLE = 'Count only';
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/** The view's own empty state, for a capture that held no requests at all. */
const NOTHING_CAPTURED_TITLE = 'No requests';
const NOTHING_CAPTURED_MESSAGE = 'No network requests were captured for this interaction.';

/**
 * Wait for the empty state and assert its exact title and message.
 *
 * Both are found by their text, then checked to be the `EmptyState` parts
 * placed inside this view's empty container, so a sentence that happened to
 * appear elsewhere could not satisfy the case. The capture-wide copy is
 * asserted absent whenever another absence is expected: the two are different
 * claims, and only one of them may be made.
 *
 * @param title The expected title.
 * @param message The expected message.
 */
async function expectEmptyPage(title: string, message: string): Promise<void> {
  const shownTitle = await screen.findByText(title);
  expect(shownTitle.classList.contains('dg-empty-state__title')).toBe(true);
  expect(shownTitle.closest('.dg-request-table__empty')).not.toBeNull();

  const shownMessage = screen.getByText(message);
  expect(shownMessage.classList.contains('dg-empty-state__message')).toBe(true);
  expect(shownMessage.closest('.dg-request-table__empty')).toBe(
    shownTitle.closest('.dg-request-table__empty'),
  );

  if (title !== NOTHING_CAPTURED_TITLE) {
    expect(screen.queryByText(NOTHING_CAPTURED_MESSAGE)).toBeNull();
  }

  // An empty page is a success: no failure is drawn and no rows are invented.
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryAllByRole('row')).toHaveLength(0);
}

describe('RequestTable paging', () => {
  it('says how much of the result is on screen and appends the next page', async () => {
    // `nextOffset` deliberately differs from the length of the page: the
    // contract is that a view copies the offset the service reported, never one
    // it derived from what arrived, which drifts the moment a limit is clamped.
    const stub = pagingProvider([
      { data: [REPEATED_GROUP], total: 18, nextOffset: 1 },
      { data: [SINGLE_GROUP], total: 18, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(
      makeNode({
        query: {
          source: 'requests',
          sort: MOST_OCCURRENCES_FIRST,
          limit: DATA_QUERY_DEFAULT_LIMIT,
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // One group of eighteen, said plainly rather than implied by a bare count.
    await screen.findByText(`Groups loaded: ${formatCount(1)} of ${formatCount(18)}.`);
    expect(dataRows()).toHaveLength(1);

    const first = soleQuery(stub);
    expect(first.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(first.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next page is requested at the offset the SERVICE reported.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const second = queryOfCall(stub, 2);
    expect(second.offset).toBe(1);
    expect(second.offset ?? 0).toBeGreaterThan(first.offset ?? DATA_QUERY_DEFAULT_OFFSET);
    expect(second.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(second.sort).toBe(MOST_OCCURRENCES_FIRST);
    expect(second.source).toBe('requests');

    // Appended, not replaced: the page the reader was already reading stays,
    // and the footer counts both.
    await waitFor(() => {
      expect(renderedUrls()).toEqual([REPEATED_GROUP.url, SINGLE_GROUP.url]);
    });
    expect(footerNote()).toBe(`Groups loaded: ${formatCount(2)} of ${formatCount(18)}.`);
  });

  it('states only what it loaded when the service reported no total', async () => {
    const stub = resolvingProvider([REPEATED_GROUP]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A service that reported no total leaves this view unable to know whether
    // more groups exist, so it states the count it has and claims nothing about
    // the whole capture (AAP 0.4.2).
    await screen.findByText(`Groups loaded: ${formatCount(1)}.`);
    expect(footerNote()).not.toContain(' of ');

    // And with no next offset reported, no paging control is offered.
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('offers no paging control for a next offset that does not move forward', async () => {
    // Two answers a paging loop must never follow: an echo of the page's own
    // offset, which would re-request the page on screen, and an offset behind
    // it, which would step back into one already read.
    for (const nextOffset of [AUTHORED_OFFSET, AUTHORED_OFFSET - 1]) {
      const stub = resolvingProvider([REPEATED_GROUP], { total: 18, nextOffset });
      const view = renderComponent(
        makeNode({
          query: { source: 'requests', sort: MOST_OCCURRENCES_FIRST, offset: AUTHORED_OFFSET },
        }),
        { provider: stub.provider, actions: makeActions().actions },
      );

      await screen.findByRole('grid');
      expect(soleQuery(stub).offset).toBe(AUTHORED_OFFSET);
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
      expect(stub.resolve).toHaveBeenCalledTimes(1);

      view.unmount();
    }
  });
});

describe('RequestTable page size', () => {
  it('sends an authored limit of zero as zero and never pages a count-only query', async () => {
    // The provider echoes the page's own offset as its next one — the shape a
    // count-only answer can take, since skipping zero rows lands where it began.
    // Following it would re-request the same empty page for ever.
    const stub = resolvingProvider([], { total: 42, nextOffset: DATA_QUERY_DEFAULT_OFFSET });

    renderComponent(makeNode({ query: COUNT_ONLY_QUERY }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    // Said as the count it is, with the total the service reported, and never
    // as a capture that held nothing.
    await expectEmptyPage(
      COUNT_ONLY_TITLE,
      `This view requests a count without rows: ${formatCount(42)} request groups matched its query.`,
    );

    // Zero on the wire, exactly: never raised to one row nobody asked for.
    const query = soleQuery(stub);
    expect(query.limit).toBe(0);
    expect(query.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    // No rows were drawn and no paging control is offered, so nothing can ask
    // for a second page of a query whose every page is empty by request.
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('never pages a count-only query, even past a forward next offset', async () => {
    // A forward offset on a zero-row page could only lead to another zero-row
    // page, so the count-only request itself — not the offset's direction — is
    // what withholds the paging control.
    const stub = resolvingProvider([], { total: 42, nextOffset: AUTHORED_OFFSET });

    renderComponent(makeNode({ query: COUNT_ONLY_QUERY }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(COUNT_ONLY_TITLE);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('leaves an omitted limit off the query so the resolver applies its default', async () => {
    const stub = resolvingProvider([REPEATED_GROUP]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // Absent, not filled in: the default page size belongs to the side that
    // resolves the query, so the page it applies and the page asked for agree.
    expect(Object.hasOwn(soleQuery(stub), 'limit')).toBe(false);
  });

  it('holds an over-sized authored limit to the contract ceiling', async () => {
    const stub = resolvingProvider([REPEATED_GROUP]);

    renderComponent(
      makeNode({ query: { source: 'requests', sort: MOST_OCCURRENCES_FIRST, limit: 9000 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid');
    expect(soleQuery(stub).limit).toBe(DATA_QUERY_MAX_LIMIT);
  });
});

describe('RequestTable empty pages', () => {
  it('says a count-only query found one group, in the singular', async () => {
    const stub = resolvingProvider([], { total: 1 });

    renderComponent(makeNode({ query: COUNT_ONLY_QUERY }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyPage(
      COUNT_ONLY_TITLE,
      `This view requests a count without rows: ${formatCount(1)} request group matched its query.`,
    );
  });

  it('says a count-only query reported no total rather than inventing one', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode({ query: COUNT_ONLY_QUERY }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await expectEmptyPage(
      COUNT_ONLY_TITLE,
      'This view requests a count without rows, and no total was reported for its query.',
    );
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('keeps the capture-wide empty copy when the reported total is zero', async () => {
    const stub = resolvingProvider([], { total: 0 });

    renderComponent(
      makeNode({
        query: { source: 'requests', sort: MOST_OCCURRENCES_FIRST, offset: AUTHORED_OFFSET },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // Zero matched, so the capture really held nothing for this query, whatever
    // offset the page started at.
    await expectEmptyPage(NOTHING_CAPTURED_TITLE, NOTHING_CAPTURED_MESSAGE);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('says a page starting past the end of a positive total is past the end', async () => {
    const offset = 25;
    const stub = resolvingProvider([], { total: 18 });

    renderComponent(
      makeNode({ query: { source: 'requests', sort: MOST_OCCURRENCES_FIRST, offset } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // One-based, as a reader counts: skipping 25 groups starts at the 26th.
    await expectEmptyPage(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(offset + 1)}, past the end of the ${formatCount(
        18,
      )} request groups that matched this query.`,
    );
    expect(soleQuery(stub).offset).toBe(offset);
  });

  it('states the total when a page inside it came back empty', async () => {
    const stub = resolvingProvider([], { total: 18 });

    renderComponent(
      makeNode({
        query: { source: 'requests', sort: MOST_OCCURRENCES_FIRST, offset: AUTHORED_OFFSET },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await expectEmptyPage(
      EMPTY_PAGE_TITLE,
      `${formatCount(18)} request groups matched this query, but none are shown on this page.`,
    );
  });

  it('names where a later page starts when the service reported no total', async () => {
    const stub = resolvingProvider([]);

    renderComponent(
      makeNode({
        query: { source: 'requests', sort: MOST_OCCURRENCES_FIRST, offset: AUTHORED_OFFSET },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await expectEmptyPage(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(
        AUTHORED_OFFSET + 1,
      )} and holds no request groups; no total was reported for this query.`,
    );
  });

  it('keeps an empty page followed by more pageable, at exactly the reported offset', async () => {
    const reportedNextOffset = 7;
    const stub = pagingProvider([
      { data: [], total: 18, nextOffset: reportedNextOffset },
      { data: [REPEATED_GROUP], total: 18 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Positive total, first page, nothing on it: an empty page, not an empty
    // capture, and the service says more follows.
    await expectEmptyPage(
      EMPTY_PAGE_TITLE,
      `${formatCount(18)} request groups matched this query, but none are shown on this page.`,
    );

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).offset).toBe(reportedNextOffset);

    await waitFor(() => {
      expect(renderedUrls()).toEqual([REPEATED_GROUP.url]);
    });
    expect(screen.queryByText(EMPTY_PAGE_TITLE)).toBeNull();
  });

  it('never calls a first page followed by more an empty capture, even without a total', async () => {
    const stub = resolvingProvider([], { nextOffset: AUTHORED_OFFSET });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The service reported no total but did report a next page, so this page
    // is not the whole result and "nothing was captured" would be false.
    await expectEmptyPage(
      EMPTY_PAGE_TITLE,
      `This page starts at position ${formatCount(
        DATA_QUERY_DEFAULT_OFFSET + 1,
      )} and holds no request groups; no total was reported for this query.`,
    );
    expect(screen.getByRole('button', { name: LOAD_MORE_NAME }).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

describe('RequestTable local duplicates filter', () => {
  it('narrows the loaded groups without re-querying, and says that is its scope', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    expect(dataRows()).toHaveLength(2);

    const toggle = screen.getByRole('button', { name: DUPLICATES_ONLY_NAME });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    await user.click(toggle);

    // Only the group whose own `hasDuplicates` flag is set survives; the flag is
    // read as received and no two rows are ever compared.
    await waitFor(() => {
      expect(renderedUrls()).toEqual([REPEATED_GROUP.url]);
    });
    expect(
      screen.getByRole('button', { name: DUPLICATES_ONLY_NAME }).getAttribute('aria-pressed'),
    ).toBe('true');

    // The query contract cannot express "duplicates only", so this narrowing is
    // local — which is exactly why nothing was asked of the provider again and
    // why the footer states the scope it applies to.
    expect(stub.resolve).toHaveBeenCalledTimes(1);

    const note = footerNote();
    expect(note).toContain(
      `Matching the duplicates filter: ${formatCount(1)} of ${formatCount(2)}.`,
    );
    expect(note).toContain('the groups loaded so far');

    // Reported to the host as the selection it is, with no query shape in it.
    expect(spies.onFilterChange).toHaveBeenCalledWith(NODE_ID, {
      sort: MOST_OCCURRENCES_FIRST,
      duplicatesOnly: 'true',
    });

    // Releasing the toggle restores the page exactly as it arrived.
    await user.click(screen.getByRole('button', { name: DUPLICATES_ONLY_NAME }));

    await waitFor(() => {
      expect(renderedUrls()).toEqual([...PROVIDER_ORDER_URLS]);
    });
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('says the filter excluded every loaded group, not that nothing was captured', async () => {
    const stub = resolvingProvider([SINGLE_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: DUPLICATES_ONLY_NAME }));

    // The two absences are different claims, and the component makes the right
    // one: groups were loaded, and none of them has a duplicate occurrence.
    expect(await screen.findByText(/none of the groups loaded so far/i)).toBeDefined();
    expect(screen.queryByText(/no network requests were captured/i)).toBeNull();
    expect(dataRows()).toHaveLength(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Pending requests
 *
 * A request the producer saw start and not settle before the capture ended is
 * an in-flight snapshot: `pending: true` on the occurrence, `pendingCount` on
 * its group. The fixtures below are built by spreading those fields over the
 * shared builders, never by recomputing them, and the cases pin the one
 * distinction the component must keep: an absent status code is NOT pending
 * unless the producer said so.
 * ---------------------------------------------------------------------------
 */

/** The visible word of the Pending badge. */
const PENDING_TEXT = 'Pending';

/**
 * A copy of an occurrence with no status code at all.
 *
 * Needed because {@link makeOccurrence} applies its default code when handed
 * `undefined` for it, so the builder alone cannot describe a request that
 * settled — or had not settled — without one. The key is removed rather than
 * set to `undefined`, as `exactOptionalPropertyTypes` requires of an absent
 * optional field.
 *
 * @param occurrence The occurrence to copy.
 * @returns The same occurrence without `statusCode`.
 */
function withoutStatusCode(occurrence: RequestOccurrence): RequestOccurrence {
  const copy: { -readonly [Key in keyof RequestOccurrence]: RequestOccurrence[Key] } = {
    ...occurrence,
  };

  delete copy.statusCode;

  return copy;
}

/**
 * One in-flight occurrence, as the contract describes it: no status code, span
 * status `unset`, and the producer's flag.
 *
 * @param ordinal Identity ordinal, for distinct event and span ids.
 * @param startOffsetMs Start relative to {@link BASE_START_MS}.
 * @param durationMs Elapsed time until the capture ended.
 * @returns A fresh pending occurrence.
 */
function pendingOccurrence(
  ordinal: number,
  startOffsetMs: number,
  durationMs: number,
): RequestOccurrence {
  return {
    ...withoutStatusCode(
      makeOccurrence({
        eventId: eventIdFor(ordinal),
        spanId: spanIdFor(ordinal),
        startTime: BASE_START_MS + startOffsetMs,
        durationMs,
        status: 'unset',
      }),
    ),
    pending: true,
  };
}

/**
 * A group carrying the producer's pending count.
 *
 * @param overrides Fields of the shared builder to replace.
 * @param pendingCount The count of occurrences still in flight.
 * @returns A fresh group.
 */
function pendingGroup(overrides: GroupOverrides, pendingCount: number): RequestGroup {
  return { ...makeRequestGroup(overrides), pendingCount };
}

/**
 * Render one group and return its only data row.
 *
 * @param group The group to resolve.
 * @returns The row the grid drew for it.
 */
async function renderSoleGroup(group: RequestGroup): Promise<HTMLElement> {
  const stub = resolvingProvider([group]);

  renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

  await screen.findByRole('grid');

  const [row] = dataRows();

  if (row === undefined) {
    throw new Error('the grid rendered no data row');
  }

  return row;
}

/**
 * Assert an element is the Pending badge: the base status chip with the info
 * tone, the outline fill and a decorative icon, and no class of its own.
 *
 * @param badge The element found by its visible text.
 */
function expectPendingBadge(badge: HTMLElement): void {
  expect(badge.classList.contains('dg-badge')).toBe(true);
  expect(badge.classList.contains('dg-badge--info')).toBe(true);
  expect(badge.classList.contains('dg-badge--outline')).toBe(true);
  expect(badge.classList.contains('dg-request-table__status')).toBe(true);
  expect(badge.querySelector('.dg-badge__icon svg')).not.toBeNull();
  expect(badge.querySelector('.dg-badge__icon')?.getAttribute('aria-hidden')).toBe('true');

  // The modifier is the Badge's own token-backed classes: nothing this file
  // emits names the pending state, so the stylesheet needs no new rule.
  for (const name of Array.from(badge.classList)) {
    expect(name).not.toMatch(/pending/i);
  }
}

describe('RequestTable pending requests', () => {
  it('badges a group whose every occurrence was in flight, with no unavailable code', async () => {
    const group = pendingGroup(
      {
        id: 'request-group-example-0081',
        requestKey: 'request-key-example-0081',
        count: 2,
        statusCodes: [],
        occurrences: [pendingOccurrence(21, 0, 310), pendingOccurrence(22, 12, 298)],
      },
      2,
    );
    const row = await renderSoleGroup(group);
    const cell = cellsOf(row).status;

    // The word is visible, with the count because the group holds more than one
    // occurrence.
    expectPendingBadge(within(cell).getByText(`${PENDING_TEXT} ${formatCount(2)}`));

    // Every occurrence is pending, so the missing codes are fully explained and
    // the unavailable label would claim a settled occurrence that never existed.
    expect(within(cell).queryByText(NOT_AVAILABLE_LABEL)).toBeNull();

    const description = tooltipTexts(cell).join(' ');
    expect(description).toContain(
      `Still in flight when the capture ended: ${formatCount(2)} of ${formatCount(2)} occurrences.`,
    );
    expect(description).toContain('no status code');
    expect(description).toContain('lower bound');
    expect(description).not.toContain('settled occurrences only');
    expect(cell.querySelector('[class*="pending"]')).toBeNull();
  });

  it('says Pending without a count for a single in-flight request', async () => {
    const group = pendingGroup(
      {
        id: 'request-group-example-0082',
        requestKey: 'request-key-example-0082',
        count: 1,
        statusCodes: [],
        occurrences: [pendingOccurrence(23, 0, 540)],
      },
      1,
    );
    const row = await renderSoleGroup(group);
    const cell = cellsOf(row).status;

    expectPendingBadge(within(cell).getByText(PENDING_TEXT));
    expect(within(cell).queryByText(NOT_AVAILABLE_LABEL)).toBeNull();

    const description = tooltipTexts(cell).join(' ');
    expect(description).toContain('This request was still in flight when the capture ended.');
    expect(description).toContain('no status code');
    expect(description).toContain('lower bound');
  });

  it('shows the settled codes beside the pending count on a mixed group', async () => {
    const group = pendingGroup(
      {
        id: 'request-group-example-0083',
        requestKey: 'request-key-example-0083',
        count: 4,
        statusCodes: [200],
      },
      1,
    );
    const row = await renderSoleGroup(group);
    const cell = cellsOf(row).status;

    expect(within(cell).getByText('200').classList.contains('dg-request-table__status--ok')).toBe(
      true,
    );
    expectPendingBadge(within(cell).getByText(`${PENDING_TEXT} ${formatCount(1)}`));
    expect(within(cell).queryByText(NOT_AVAILABLE_LABEL)).toBeNull();

    // The codes shown describe the settled occurrences only, and the tooltip
    // says so rather than letting one code stand for all four.
    const description = tooltipTexts(cell).join(' ');
    expect(description).toContain(`${formatCount(1)} of ${formatCount(4)} occurrences`);
    expect(description).toContain('settled occurrences only');
  });

  it('keeps the unavailable label beside Pending when settled occurrences had no code', async () => {
    const group = pendingGroup(
      {
        id: 'request-group-example-0084',
        requestKey: 'request-key-example-0084',
        count: 3,
        statusCodes: [],
      },
      1,
    );
    const row = await renderSoleGroup(group);
    const cell = cellsOf(row).status;

    // Both things were observed: two settled occurrences without a code, and one
    // that had not settled.
    expect(within(cell).getByText(NOT_AVAILABLE_LABEL).classList.contains('dg-badge')).toBe(true);
    expectPendingBadge(within(cell).getByText(`${PENDING_TEXT} ${formatCount(1)}`));
  });

  it('never reads a missing status code as pending when the producer reported none', async () => {
    const withoutCodes = makeRequestGroup({
      id: 'request-group-example-0085',
      requestKey: 'request-key-example-0085',
      count: 2,
      statusCodes: [],
      occurrences: [
        withoutStatusCode(makeOccurrence({ eventId: eventIdFor(24), status: 'unset' })),
      ],
    });
    const row = await renderSoleGroup(withoutCodes);
    const cell = cellsOf(row).status;

    expect(within(cell).getByText(NOT_AVAILABLE_LABEL)).toBeDefined();
    expect(within(cell).queryByText(new RegExp(`^${PENDING_TEXT}`))).toBeNull();
    expect(tooltipTexts(row).join(' ')).not.toMatch(/in flight/i);
  });

  it('marks an in-flight occurrence Pending and leaves settled ones as they were', async () => {
    const inFlight = pendingOccurrence(31, 0, 820);
    const settledUnreported = withoutStatusCode(
      makeOccurrence({
        eventId: eventIdFor(32),
        spanId: spanIdFor(32),
        startTime: BASE_START_MS + 10,
        status: 'unset',
      }),
    );
    const settledError = withoutStatusCode(
      makeOccurrence({
        eventId: eventIdFor(33),
        spanId: spanIdFor(33),
        startTime: BASE_START_MS + 20,
        status: 'error',
      }),
    );
    const settledOk = makeOccurrence({
      eventId: eventIdFor(34),
      spanId: spanIdFor(34),
      startTime: BASE_START_MS + 30,
      statusCode: 200,
    });
    const group = pendingGroup(
      {
        id: 'request-group-example-0086',
        requestKey: 'request-key-example-0086',
        count: 4,
        statusCodes: [200],
        errorCount: 1,
        lastStartTime: BASE_START_MS + 30,
        occurrences: [inFlight, settledUnreported, settledError, settledOk],
      },
      1,
    );
    const user = userEvent.setup();

    // None of the three carries a code, so the distinction drawn below rests on
    // the producer's flag alone.
    for (const occurrence of [inFlight, settledUnreported, settledError]) {
      expect('statusCode' in occurrence).toBe(false);
    }

    await renderSoleGroup(group);
    await user.click(screen.getByRole('button', { name: disclosureName(group, false) }));

    const [detail] = detailRows();

    if (detail === undefined) {
      throw new Error('the opened group rendered no detail row');
    }

    const occurrenceRow = (occurrence: RequestOccurrence): HTMLElement => {
      const found = within(detail)
        .getByRole('button', { name: occurrenceName(group, occurrence) })
        .closest<HTMLElement>('.dg-request-table__occurrence-row');

      if (found === null) {
        throw new Error(`no occurrence row holds the control for ${occurrence.eventId}`);
      }

      return found;
    };

    // The in-flight occurrence: Pending instead of the span status it carries,
    // its elapsed time as the duration, and a tooltip that says what both mean.
    const pendingRow = occurrenceRow(inFlight);
    expectPendingBadge(within(pendingRow).getByText(PENDING_TEXT));
    expect(within(pendingRow).queryByText(formatStatusLabel('unset'))).toBeNull();
    expect(within(pendingRow).getByText(formatDuration(inFlight.durationMs))).toBeDefined();

    const note = tooltipTexts(pendingRow).join(' ');
    expect(note).toContain('still in flight when the capture ended');
    expect(note).toContain('time elapsed until then');

    // Settled occurrences without a code keep their span status, and none of
    // them is called pending — the same `unset` status included.
    const unreportedRow = occurrenceRow(settledUnreported);
    expect(within(unreportedRow).getByText(formatStatusLabel('unset'))).toBeDefined();
    expect(within(unreportedRow).queryByText(PENDING_TEXT)).toBeNull();

    const errorRow = occurrenceRow(settledError);
    expect(within(errorRow).getByText(formatStatusLabel('error'))).toBeDefined();
    expect(within(errorRow).queryByText(PENDING_TEXT)).toBeNull();

    const okRow = occurrenceRow(settledOk);
    expect(within(okRow).getByText('200')).toBeDefined();
    expect(within(okRow).queryByText(PENDING_TEXT)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Keyboard access to tooltip descriptions
 *
 * A tooltip opens on focus, so a trigger that cannot take focus hides its
 * description from every keyboard reader. Each trigger below must be a plain
 * tab stop — no button role, no accessible-name override — whose focus opens
 * the bubble its `aria-describedby` names, and whose Escape and blur close it.
 * Focus is moved with `act(() => element.focus())` because React's `onFocus`
 * listens for `focusin`, which a synthetic `focus` event would not deliver.
 * ---------------------------------------------------------------------------
 */

/**
 * A redacted URL longer than the row's preview budget, so the row shows it
 * shortened and the full value only in its tooltip.
 */
const LONG_URL = `${RESOURCE_PATH}?${Array.from(
  { length: 16 },
  (_, index) => `parameter${String(index)}=?`,
).join('&')}`;

/** The in-flight occurrence of {@link DISCLOSURE_GROUP}. */
const DISCLOSURE_PENDING_OCCURRENCE = pendingOccurrence(41, 40, 610);

/**
 * A group that exercises every tooltip trigger the component draws at once: a
 * shortened URL, the fallback grouping, more status codes than the row shows,
 * a failure, duplicates, no exposed size and one occurrence still in flight.
 */
const DISCLOSURE_GROUP = pendingGroup(
  {
    id: 'request-group-example-0091',
    requestKey: undefined,
    groupedBy: 'method-path',
    url: LONG_URL,
    path: RESOURCE_PATH,
    count: 5,
    duplicateCount: 2,
    hasDuplicates: true,
    duplicateWindows: [
      makeDuplicateWindow({
        id: 'request-group-example-0091:0',
        endTime: BASE_START_MS + 14,
        count: 3,
        eventIds: [eventIdFor(42), eventIdFor(43), eventIdFor(44)],
      }),
    ],
    lastStartTime: BASE_START_MS + 40,
    statusCodes: [200, 201, 204, 304, 404],
    errorCount: 1,
    occurrences: [
      makeOccurrence({ eventId: eventIdFor(42), spanId: spanIdFor(42), startTime: BASE_START_MS }),
      DISCLOSURE_PENDING_OCCURRENCE,
    ],
  },
  1,
);

/**
 * The tooltip bubble a trigger's `aria-describedby` resolves to.
 *
 * @param trigger The focusable trigger.
 * @returns The one `role="tooltip"` element among the ids it names.
 */
function describingTooltip(trigger: HTMLElement): HTMLElement {
  const ids = (trigger.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((id) => id.length > 0);
  const bubbles = ids
    .map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement => element?.getAttribute('role') === 'tooltip');

  expect(bubbles).toHaveLength(1);

  const [bubble] = bubbles;

  if (bubble === undefined) {
    throw new Error('the trigger is described by no tooltip');
  }

  return bubble;
}

/** Whether a tooltip bubble is currently shown. */
function isShown(bubble: HTMLElement): boolean {
  return bubble.classList.contains('dg-is-open');
}

/**
 * Assert the whole keyboard contract of one tooltip trigger.
 *
 * @param trigger The element carrying the tooltip.
 * @param expected Text the description must contain.
 */
function expectKeyboardDisclosure(trigger: HTMLElement, expected: string): void {
  // A plain tab stop: in the sequential order, and nothing more.
  expect(trigger.tabIndex).toBe(0);
  expect(trigger.getAttribute('tabindex')).toBe('0');
  expect(trigger.hasAttribute('role')).toBe(false);
  expect(trigger.hasAttribute('aria-label')).toBe(false);

  const bubble = describingTooltip(trigger);
  expect(bubble.textContent).toContain(expected);
  expect(isShown(bubble)).toBe(false);

  // Focus opens the description at once.
  act(() => {
    trigger.focus();
  });
  expect(document.activeElement).toBe(trigger);
  expect(isShown(bubble)).toBe(true);

  // Escape dismisses it without moving focus.
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(isShown(bubble)).toBe(false);
  expect(document.activeElement).toBe(trigger);

  // Leaving and returning opens it again, and blur closes it.
  act(() => {
    trigger.blur();
  });
  act(() => {
    trigger.focus();
  });
  expect(isShown(bubble)).toBe(true);
  act(() => {
    trigger.blur();
  });
  expect(isShown(bubble)).toBe(false);
}

/** One group-level tooltip trigger: how to find it and what it must describe. */
interface TriggerCase {
  /** The trigger, for the case title. */
  readonly name: string;

  /** Find the trigger inside the group's row. */
  readonly find: (row: HTMLElement) => HTMLElement;

  /** Text the description must contain. */
  readonly expected: string;
}

/** The rendered URL element of a row, read off its row header. */
function urlElementOf(row: HTMLElement): HTMLElement {
  const url = within(row)
    .getByRole('rowheader')
    .querySelector<HTMLElement>('.dg-request-table__url');

  if (url === null) {
    throw new Error('the row header rendered no URL');
  }

  return url;
}

const GROUP_TRIGGERS: readonly TriggerCase[] = [
  {
    name: 'status overflow badge',
    find: (row) => within(cellsOf(row).status).getByText(`+${formatCount(2)}`),
    expected: 'All status codes observed: 200, 201, 204, 304, 404.',
  },
  {
    name: 'failure count badge',
    find: (row) => within(cellsOf(row).status).getByText(formatCount(1)),
    expected: `Occurrences that failed: ${formatCount(1)} of ${formatCount(5)}.`,
  },
  {
    name: 'group Pending badge',
    find: (row) => within(cellsOf(row).status).getByText(`${PENDING_TEXT} ${formatCount(1)}`),
    expected: `Still in flight when the capture ended: ${formatCount(1)} of ${formatCount(5)}`,
  },
  {
    name: 'duplicate badge',
    find: (row) => within(cellsOf(row).duplicates).getByText(formatCount(2)),
    expected: `Redundant occurrences: ${formatCount(2)} of ${formatCount(5)}.`,
  },
  {
    name: 'unavailable transfer size',
    find: (row) => within(cellsOf(row).transferred).getByText(NOT_AVAILABLE_LABEL),
    expected: 'No transfer size was exposed',
  },
  {
    name: 'shortened URL',
    find: urlElementOf,
    expected: LONG_URL,
  },
  {
    name: 'grouping badge',
    find: (row) =>
      within(within(row).getByRole('rowheader')).getByText(FALLBACK_GROUPING_BADGE_TEXT),
    expected: 'no request key was available',
  },
];

describe('RequestTable keyboard access to tooltip descriptions', () => {
  it.each(GROUP_TRIGGERS)(
    'makes the $name a tab stop whose focus opens its description',
    async ({ find, expected }) => {
      const row = await renderSoleGroup(DISCLOSURE_GROUP);

      expectKeyboardDisclosure(find(row), expected);
    },
  );

  it('discloses the full URL, and only the full URL, behind the shortened one', async () => {
    const row = await renderSoleGroup(DISCLOSURE_GROUP);
    const url = urlElementOf(row);

    expect(url.textContent).not.toBe(LONG_URL);
    expect(describingTooltip(url).textContent).toBe(LONG_URL);
  });

  it('makes the occurrence Pending badge a tab stop whose focus opens its description', async () => {
    const user = userEvent.setup();

    await renderSoleGroup(DISCLOSURE_GROUP);
    await user.click(screen.getByRole('button', { name: disclosureName(DISCLOSURE_GROUP, false) }));

    const [detail] = detailRows();

    if (detail === undefined) {
      throw new Error('the opened group rendered no detail row');
    }

    const occurrenceRow = within(detail)
      .getByRole('button', {
        name: occurrenceName(DISCLOSURE_GROUP, DISCLOSURE_PENDING_OCCURRENCE),
      })
      .closest<HTMLElement>('.dg-request-table__occurrence-row');

    if (occurrenceRow === null) {
      throw new Error('no occurrence row holds the in-flight occurrence');
    }

    expectKeyboardDisclosure(
      within(occurrenceRow).getByText(PENDING_TEXT),
      'still in flight when the capture ended',
    );
  });

  it('leaves a URL shown in full out of the tab order', async () => {
    const row = await renderSoleGroup(SINGLE_GROUP);
    const url = urlElementOf(row);

    // Nothing is shortened, so the disabled tooltip has nothing to disclose and
    // the element adds no stop that would open nothing.
    expect(url.textContent).toBe(SINGLE_GROUP.url);
    expect(url.hasAttribute('tabindex')).toBe(false);
    expect(url.tabIndex).toBe(-1);

    // And were focus to arrive by any other route, the disabled tooltip still
    // opens nothing.
    act(() => {
      url.focus();
    });
    expect(isShown(describingTooltip(url))).toBe(false);
  });

  it('keeps a focused trigger out of the grid row navigation', async () => {
    const row = await renderSoleGroup(DISCLOSURE_GROUP);
    const trigger = within(cellsOf(row).duplicates).getByText(formatCount(2));

    act(() => {
      trigger.focus();
    });

    // The grid reads the row index off the focused element itself, so an arrow
    // key pressed on a descendant is not consumed and focus stays put.
    const notCancelled = fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(notCancelled).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(isShown(describingTooltip(trigger))).toBe(true);
  });
});

describe('RequestTable pending signal provenance', () => {
  it('draws the Pending state from a field its catalog entry declares', () => {
    // The Pending badges are projected by the aggregate from the request
    // kinds' `inFlight` attribute. The catalog entry's `reads` is the field set
    // this view is written against and the one semantic validation consults,
    // so the pending signal must be part of it rather than an undeclared read.
    const { reads, telemetryKinds } = catalogEntryFor('requestTable');

    expect(telemetryKinds.length).toBeGreaterThan(0);
    expect(reads).toContain('inFlight');
    expect(reads).toContain('http.status_code');
  });
});
