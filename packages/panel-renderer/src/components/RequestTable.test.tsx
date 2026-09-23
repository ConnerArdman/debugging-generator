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
 *     reported rather than one derived from the rows in hand.
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

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_DEFAULT_OFFSET } from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, RequestTableNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { DuplicateWindow, RequestGroup, RequestOccurrence } from '@debuggen/telemetry';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
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
  formatOffset,
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
      <PanelActionsContext.Provider value={context.actions}>
        <RequestTable node={node} />
      </PanelActionsContext.Provider>
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
