/**
 * `components/QueryTable` — the colocated suite for the `queryTable` node.
 *
 * ## What this suite is protecting
 *
 * **First, a privacy guarantee, and it is the reason most of these cases
 * compare strings exactly rather than loosely.** A `db.statement` reaches this
 * component already redacted and already parameterized — `$n` placeholders as
 * the driver wrote them, inline literals replaced with `?` by
 * `packages/telemetry/src/redaction/sql.ts` — and the only thing recorded about
 * a result is a row *count* (AAP 0.5.2). So the cases below assert that the
 * statement is **displayed, never transformed**: the expanded block holds the
 * received text byte for byte, the collapsed cell holds this package's own
 * documented display preview of it and carries the untouched text beside it, no
 * placeholder is ever filled in, no control offers to run, copy or reveal
 * anything, and nothing resembling a result row is rendered anywhere.
 *
 * Byte fidelity here is not pedantry. The parameterized statement *is* the
 * guarantee: a later "nicer SQL display" — a trim, a re-case, a pretty-print, a
 * substituted placeholder — would either destroy the guarantee's auditability or
 * suggest the product holds data it never captured. An exact comparison is the
 * only assertion that keeps such a change honest, which is why these cases
 * compare against the fixture string and not against a normalised variant of it.
 *
 * **Second, the click that ends the acceptance flow.** Acceptance test 1
 * (AAP 0.8.4) finishes in this table: the caller chip of a statement opens the
 * editor at the call site. The caller case asserts what the host actually
 * receives through `PanelActions.onOpenSource` — equal to the location the
 * resolver produced, with the same key set — because every hop after this one
 * acts blind on the object it is handed (AAP 0.4.2), and a caller the resolver
 * could not place must render as text rather than as a control leading nowhere.
 *
 * **Third, the paging and ordering contract.** `POST /sessions/:id/panel-data`
 * applies `filter`, `sort`, `limit` and `offset` and answers with `total` and
 * `nextOffset` (AAP 0.4.2), so ordering is a *re-query* rather than a local
 * re-ranking, a page is appended at the offset the service reported, the footer
 * says how much of the result is on screen, and a bounded occurrence list says
 * that it is bounded.
 *
 * Alongside those, AAP 0.8.3 asks every component suite here for the three
 * states of a query-backed view — loading, empty and error — each driven
 * through a stub `DataProvider` that respectively never settles, resolves an
 * empty page and rejects.
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`. The `panel-renderer`
 *     project does enable `globals`, but only so `@testing-library/react` can
 *     register its automatic cleanup on a global `afterEach`.
 *   - **`afterEach(cleanup)` registered explicitly**, so a suite cannot leak a
 *     mounted tree into the next case and fail it with a multiple-match error
 *     that reads like a component bug.
 *   - **Stub providers built with the library's own `createDataProvider`**, so
 *     these cases exercise the seam the DevTools panel and the editor webview
 *     implement — including its guarantee that a response answers for the source
 *     it was asked about. Every query the component issues is recorded, because
 *     what it *asked for* is as much of its contract as what it drew.
 *   - **In-file synthetic builders, no fixture files**: {@link makeQueryGroup},
 *     {@link makeCaller}, {@link makeOccurrence} and {@link makeNode} take
 *     overrides, and the aggregate result types are imported as **types only** —
 *     nothing here calls `aggregateQueries` or `normalizeSqlStatement`, since a
 *     suite that computed its own fixtures could not tell a component that
 *     displayed a value from one that recomputed it.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): a statement over a table
 *     named `example_items`, callers in `src/example/repository.ts`. No table,
 *     column, component, service or route name of any inspected application
 *     appears here, in the fixtures or in the comments.
 *   - **Queries by role and accessible name.** The grid, its rows, the header
 *     controls, the chips, the tooltips and the footer buttons are all reached
 *     that way; a class is read only off an element already obtained
 *     semantically, since no `jest-dom` matcher is available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…` or `waitFor`, and
 *     interactions through `userEvent`.
 *
 * @see ./QueryTable for the component, its four states and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 */

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_DEFAULT_OFFSET } from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, QueryTableNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { QueryCaller, QueryGroup, QueryOccurrence } from '@debuggen/telemetry';
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
  formatCount,
  formatDuration,
  formatOffset,
  formatStatusLabel,
  oneLinePreview,
} from '../utils/format';
import { QueryTable } from './QueryTable';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Application-neutral throughout (AAP 0.5.4). The identifiers are shaped as a
 * capture shapes them — a 32-hex trace id, 16-hex span ids, epoch-millisecond
 * start times, millisecond durations — because the component reads those fields
 * and formats them.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every execution below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Far enough from zero that a relative performance timestamp could not be
 * mistaken for one.
 */
const BASE_START_MS = 1_767_225_600_000;

/**
 * The statement the privacy cases are built on, and the single most important
 * string in this file.
 *
 * Every property that a display transformation would quietly destroy is in it,
 * deliberately: a `$1` placeholder as a driver writes one, a `?` where the
 * redactor replaced an inline literal, runs of more than one interior space, and
 * newlines with leading indentation. Written as one explicit literal — not
 * assembled from parts and not read from a fixture file — so that the exact
 * bytes a case compares against are legible at the point they are declared.
 */
const STATEMENT =
  'SELECT id,   label\n  FROM example_items\n WHERE tenant_id = $1\n   AND state = ?\n ORDER BY  label ASC';

/**
 * The grouping key the aggregate reported for {@link STATEMENT}, deliberately
 * **different** from it.
 *
 * What collapsed several executions into one row. The component displays it and
 * must never recompute it, so this is a plausible normalisation that is
 * nonetheless not derivable from `STATEMENT` by the helpers this package has:
 * it differs in case and in placeholder shape, so a component that re-derived a
 * key from the statement could not produce this string.
 */
const NORMALIZED_STATEMENT =
  'select id, label from example_items where tenant_id = $? and state = $? order by label asc';

/** A second statement, so the multi-row cases cannot pass by matching one row. */
const SECOND_STATEMENT = 'UPDATE example_items SET state = ? WHERE id = $1';

/**
 * A statement whose one-line form exceeds the package's 120-code-point preview
 * budget, for the truncation case.
 *
 * Long enough that `oneLinePreview` must cut it, and still carrying the `$1`,
 * `$2` and `?` placeholders after the cut point so the expanded form can be
 * shown to have restored them.
 */
const LONG_STATEMENT =
  'SELECT  item.id,  item.label,  item.unit_price,  item.updated_at\n  FROM example_items AS item\n  JOIN example_groups AS grp ON grp.id = item.group_id\n WHERE item.tenant_id = $1\n   AND item.state = ?\n   AND grp.region = $2\n ORDER BY  item.updated_at DESC';

/** The engine the fixture groups report through `db.system`. */
const DB_SYSTEM = 'postgresql';

/**
 * The rows the default fixture group reports across its executions.
 *
 * Named because two cases need the same number from opposite sides: one asserts
 * that a reported count renders as that plain count, the other that its absence
 * renders as "not available" and never as `0`.
 */
const DEFAULT_ROW_COUNT = 48;

/** A project-relative, POSIX path for the callers that resolved to source. */
const SOURCE_FILE = 'src/example/repository.ts';

/** The symbol at that location. */
const SOURCE_SYMBOL = 'loadExampleItems';

/** Its 1-based coordinates. */
const SOURCE_LINE = 84;
const SOURCE_COLUMN = 9;

/**
 * A complete, resolved location — the object the acceptance hop must deliver to
 * the host unchanged.
 */
const BASE_SOURCE: SourceLocation = {
  file: SOURCE_FILE,
  line: SOURCE_LINE,
  column: SOURCE_COLUMN,
  symbol: SOURCE_SYMBOL,
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

/** The accessible name the caller chip announces (`SourceLink`'s own shape). */
const SOURCE_CHIP_NAME = `Open ${SOURCE_FILE}:${String(SOURCE_LINE)}:${String(SOURCE_COLUMN)}`;

/** The name of the caller that resolved to {@link BASE_SOURCE}. */
const RESOLVED_CALLER_NAME = 'exampleRepository.loadItems';

/** The name of a caller the resolver could not place. */
const UNRESOLVED_CALLER_NAME = 'exampleWorker.refresh';

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.queryTable';

/**
 * The orderings a query for a grouped source can carry, held as typed constants
 * so a case names the data layer's vocabulary rather than a bare string that
 * happens to match it.
 */
const SLOWEST_FIRST: DataQuerySort = 'duration_desc';
const MOST_EXECUTIONS_FIRST: DataQuerySort = 'count_desc';
const EARLIEST_FIRST: DataQuerySort = 'start_asc';

/**
 * The accessible names of the two sortable header controls.
 *
 * The component passes no `headerLabel`, so each control is named by its header
 * text; spelled out here rather than derived, so this suite pins the names a
 * reader hears. They are also the only two columns the closed sort vocabulary
 * can order, which is why no other header is queried as a control.
 */
const EXECUTIONS_SORT_NAME = 'Executions';
const TOTAL_TIME_SORT_NAME = 'Total time';

/** The eight column headers, left to right. */
const HEADERS: readonly string[] = [
  'Statement',
  'System',
  'Executions',
  'Total time',
  'Average time',
  'Slowest',
  'Rows',
  'Called from',
];

/** The accessible name of the row-disclosure control, closed and open. */
const EXPAND_ROW_NAME = 'Show the executions of this statement';
const COLLAPSE_ROW_NAME = 'Hide the executions of this statement';

/** The toolbar's ordering control, by its rendered label. */
const ORDER_CONTROL_NAME = 'Order by';

/** The toolbar's own accessible group name. */
const TOOLBAR_NAME = 'Query table controls';

/** The footer control that asks for the next page. */
const LOAD_MORE_NAME = 'Load more';

/** The error state's retry control, and the footer's. */
const RETRY_NAME = 'Retry';
const RETRY_PAGE_NAME = 'Try again';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/** The sentence the component shows while a further page is in flight. */
const LOADING_MORE_MESSAGE = 'Loading more statements…';

/**
 * The privacy sentence the row-count tooltip carries.
 *
 * Asserted rather than merely allowed: the number beside a statement is
 * ambiguous on its own, and this is the wording that tells a reader the product
 * counted rows without ever holding one.
 */
const ROW_COUNT_TOOLTIP =
  'Rows this execution reported returning. Row contents are never captured.';

/** A fragment of the sentence that introduces the grouping basis. */
const GROUPING_BASIS_PATTERN = /grouped by this normalised form/i;

/** A fragment of the component's own empty message. */
const EMPTY_MESSAGE_PATTERN = /no database queries were captured/i;

/**
 * Names of affordances this view must never offer, as one pattern.
 *
 * Each word names a control that would imply the product holds a result set, can
 * re-issue a statement against the developer's database, or can reveal the
 * values a placeholder stands for. None of that evidence was ever captured
 * (AAP 0.5.2), so none of these controls may exist — and asserting their absence
 * by name is what would catch one arriving later under a plausible label.
 */
const FORBIDDEN_CONTROL_PATTERN = /run|execute|re-?issue|explain|copy|reveal|parameter|value|row/i;

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 *
 * The optional fields of the aggregate shapes are declared upstream without
 * `| undefined`, which `Partial` cannot widen under this repository's
 * `exactOptionalPropertyTypes`: passing `{ totalRowCount: undefined }` is how a
 * case asks for a group *without* a reported row count, so each optional field
 * is redeclared here with `| undefined` and the builder drops the key rather
 * than storing the value.
 * ---------------------------------------------------------------------------
 */

/** Overrides accepted by {@link makeOccurrence}. */
type OccurrenceOverrides = Partial<
  Pick<QueryOccurrence, 'id' | 'spanId' | 'traceId' | 'startTime' | 'durationMs' | 'status'>
> & {
  readonly rowCount?: number | undefined;
  readonly source?: SourceLocation | undefined;
};

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/**
 * One execution of a statement, as the aggregate carries it inside a group.
 *
 * `id` and `eventId` are one value under two names upstream — a list renderer
 * keys on the first, a generated panel's fact cites the second — so this builder
 * keeps them equal by construction rather than letting a case set them apart.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh occurrence; nothing is shared between calls.
 */
function makeOccurrence(overrides: OccurrenceOverrides = {}): QueryOccurrence {
  const {
    id = 'event-example-0001',
    spanId = spanIdFor(1),
    traceId = TRACE_ID,
    startTime = BASE_START_MS,
    durationMs = 104,
    status = 'ok',
    rowCount,
    source,
  } = overrides;

  return {
    id,
    eventId: id,
    spanId,
    traceId,
    startTime,
    durationMs,
    endTime: startTime + durationMs,
    status,
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(source === undefined ? {} : { source }),
  };
}

/** Overrides accepted by {@link makeCaller}. */
type CallerOverrides = Partial<
  Pick<QueryCaller, 'id' | 'name' | 'executionCount' | 'totalDurationMs'>
> & {
  readonly source?: SourceLocation | undefined;
};

/**
 * One code location that ran a statement, with its share of the executions.
 *
 * @param overrides Fields to replace, or `undefined` to omit the location.
 * @returns A fresh caller.
 */
function makeCaller(overrides: CallerOverrides = {}): QueryCaller {
  const {
    id = 'caller-example-0001',
    name = RESOLVED_CALLER_NAME,
    executionCount = 3,
    totalDurationMs = 480,
    source,
  } = overrides;

  return {
    id,
    name,
    executionCount,
    totalDurationMs,
    ...(source === undefined ? {} : { source }),
  };
}

/** Overrides accepted by {@link makeQueryGroup}. */
type GroupOverrides = Partial<
  Pick<
    QueryGroup,
    | 'id'
    | 'normalizedStatement'
    | 'statement'
    | 'executionCount'
    | 'totalDurationMs'
    | 'averageDurationMs'
    | 'minDurationMs'
    | 'maxDurationMs'
    | 'firstStartTime'
    | 'lastStartTime'
    | 'errorCount'
    | 'traceIds'
    | 'callers'
    | 'occurrences'
    | 'occurrencesTruncated'
  >
> & {
  readonly system?: string | undefined;
  readonly totalRowCount?: number | undefined;
};

/**
 * One group of executions of one statement, as the `queries` source resolves it.
 *
 * Complete and aggregate-shaped by construction: distinct durations so a
 * per-row assertion cannot pass by matching the wrong figure, a caller that
 * resolved to source and one that did not, and a bounded occurrence sample whose
 * `occurrencesTruncated` flag says so.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh group; nothing is shared between calls.
 */
function makeQueryGroup(overrides: GroupOverrides = {}): QueryGroup {
  // The two optional fields are read by KEY PRESENCE rather than through a
  // destructuring default, which is the difference between "not overridden, so
  // take the fixture's value" and "explicitly overridden to absent". A default
  // would collapse the two — `{ totalRowCount: undefined }` would silently get
  // the fixture's count back — and the absent case is exactly what the row-count
  // case has to render.
  const system = 'system' in overrides ? overrides.system : DB_SYSTEM;
  const totalRowCount = 'totalRowCount' in overrides ? overrides.totalRowCount : DEFAULT_ROW_COUNT;

  const {
    id = 'query-example-0001',
    normalizedStatement = NORMALIZED_STATEMENT,
    statement = STATEMENT,
    executionCount = 4,
    totalDurationMs = 640,
    averageDurationMs = 160,
    minDurationMs = 96,
    maxDurationMs = 232,
    firstStartTime = BASE_START_MS + 12,
    lastStartTime = BASE_START_MS + 320,
    errorCount = 0,
    traceIds = [TRACE_ID],
    callers = [
      makeCaller({ source: BASE_SOURCE }),
      makeCaller({ id: 'caller-example-0002', name: UNRESOLVED_CALLER_NAME, executionCount: 1 }),
    ],
    occurrences = [
      makeOccurrence({ startTime: BASE_START_MS + 12, durationMs: 104, rowCount: 24 }),
      makeOccurrence({
        id: 'event-example-0002',
        spanId: spanIdFor(2),
        startTime: BASE_START_MS + 320,
        durationMs: 208,
        rowCount: 24,
      }),
    ],
    occurrencesTruncated = true,
  } = overrides;

  return {
    id,
    normalizedStatement,
    statement,
    executionCount,
    totalDurationMs,
    averageDurationMs,
    minDurationMs,
    maxDurationMs,
    firstStartTime,
    lastStartTime,
    errorCount,
    traceIds,
    callers,
    occurrences,
    occurrencesTruncated,
    ...(system === undefined ? {} : { system }),
    ...(totalRowCount === undefined ? {} : { totalRowCount }),
  };
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<QueryTableNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `queryTable` node, as the panel normaliser produces one: an id,
 * no heading (the host's section owns that), and a data query whose ordering is
 * already explicit.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): QueryTableNode {
  const {
    id = NODE_ID,
    query = { source: 'queries', sort: SLOWEST_FIRST },
    title,
    description,
  } = overrides;

  return {
    type: 'queryTable',
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

/** One page a stub provider can answer with. */
interface QueryPage {
  /** The groups of the page, in the order the service returned them. */
  readonly data: readonly QueryGroup[];

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
 * A provider that answers each successive call with the next page, repeating the
 * last one once the list is exhausted.
 *
 * The builder the ordering and paging cases use: a re-query has to be able to
 * answer differently from the query before it, or "the rows follow the second
 * response" could not be told from "the rows were re-ordered locally".
 *
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(pages: readonly QueryPage[]): StubProvider {
  return recordingProvider((_query, call) => {
    const page = pages[Math.min(call, pages.length) - 1];

    if (page === undefined) {
      throw new Error('the stub provider was built with no pages');
    }

    return Promise.resolve<DataQueryResponse>({
      source: 'queries',
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
  data: readonly QueryGroup[],
  extra: Omit<QueryPage, 'data'> = {},
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
 * A provider that resolves the first page and leaves every later one in flight.
 *
 * The incremental loading state, which is deliberately not the first-page one:
 * blanking a table the reader is using in order to re-show a skeleton would lose
 * their place, so the rows stay and the footer carries the state.
 *
 * @param first The page to resolve for the first call.
 * @returns The stub provider.
 */
function pendingAfterFirstProvider(first: QueryPage): StubProvider {
  return recordingProvider((_query, call) =>
    call === 1
      ? Promise.resolve<DataQueryResponse>({
          source: 'queries',
          data: first.data,
          ...(first.total === undefined ? {} : { total: first.total }),
          ...(first.nextOffset === undefined ? {} : { nextOffset: first.nextOffset }),
        })
      : new Promise<DataQueryResponse>(() => undefined),
  );
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

  /** The open-source spy — the last hop of the acceptance flow. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;

  /** The disclosure spy. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** The filter/sort report spy. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host — and
 * both optional ones are supplied too, so every case can assert not only that
 * the intent it exercised was raised but also that the others were not:
 * activating a caller chip must not also expand its row, and expanding a row
 * must not select an event.
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
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 */
function renderComponent(
  node: QueryTableNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelActionsContext.Provider value={context.actions}>
        <QueryTable node={node} />
      </PanelActionsContext.Provider>
    </DataProviderContext.Provider>,
  );
}

/**
 * The grid's data rows, in document order.
 *
 * Narrowed by the attribute the primitive writes on a data row, because the
 * header row and any open detail row are `role="row"` too and a bare role query
 * would count them.
 *
 * @returns The data rows.
 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-row-index') !== null);
}

/**
 * The data row at `index`, failing loudly rather than returning `undefined`.
 *
 * @param index The row's position in the rendered page.
 * @returns That row.
 */
function dataRow(index: number): HTMLElement {
  const row = dataRows()[index];

  if (row === undefined) {
    throw new Error(`the grid rendered no data row at index ${String(index)}`);
  }

  return row;
}

/**
 * The statement as the collapsed cell shows it.
 *
 * Read off the row's header cell — obtained by role — and then off the inline
 * code element the component places the statement in, so a row is never asked
 * for its whole text when the question is about the statement alone.
 *
 * @param row A data row.
 * @returns The cell's exact text.
 */
function collapsedStatement(row: HTMLElement): string {
  const cell = within(row).getByRole('rowheader').querySelector('code.dg-query-table__statement');

  if (cell === null) {
    throw new Error('the row header carries no statement cell');
  }

  return cell.textContent ?? '';
}

/**
 * The collapsed statement of every rendered row, in document order.
 *
 * @returns One statement per row.
 */
function collapsedStatements(): string[] {
  return dataRows().map((row) => collapsedStatement(row));
}

/**
 * The single open detail row.
 *
 * @returns The detail row.
 */
function detailRow(): HTMLElement {
  const open = screen
    .getAllByRole('row')
    .filter((row) => row.classList.contains('dg-data-table__expanded'));

  const [only] = open;

  if (only === undefined || open.length !== 1) {
    throw new Error(`expected exactly one open detail row, found ${String(open.length)}`);
  }

  return only;
}

/**
 * How many detail rows are open.
 *
 * Counted rather than fetched, so a case can assert that none is — which
 * {@link detailRow} cannot, since it fails when there is nothing to return.
 *
 * @returns The number of open detail rows.
 */
function detailRowCount(): number {
  return screen
    .queryAllByRole('row')
    .filter((row) => row.classList.contains('dg-data-table__expanded')).length;
}

/**
 * The block-form statement elements inside a scope, in document order.
 *
 * The expanded detail renders the received statement as the first block and —
 * only when the aggregate's grouping key differs from it — the key as the
 * second. Selected by tag as well as class, so the inline cell above can never
 * be mistaken for one of them.
 *
 * @param scope The element to search within.
 * @returns The block elements.
 */
function statementBlocks(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('pre.dg-query-table__statement')];
}

/**
 * The accessible name of every control on screen, sorted.
 *
 * An `aria-label` wins, as it does in the accessibility tree; otherwise the
 * control is named by its text. The privacy case asserts on the whole set rather
 * than on one control's absence, because a "show values" affordance arriving
 * later would arrive under a name nobody predicted.
 *
 * @returns One name per control.
 */
function controlNames(): string[] {
  return screen
    .getAllByRole('button')
    .map((control) => (control.getAttribute('aria-label') ?? control.textContent ?? '').trim())
    .sort();
}

/**
 * The `aria-sort` a column's header cell reports.
 *
 * Read off the CELL rather than off the control inside it, which is where the
 * primitive writes it: a reader asks the column how it is sorted, not the button.
 *
 * @param name The sortable control's accessible name.
 * @returns The reported ordering, or `null` when the cell reports none.
 */
function ariaSortOf(name: string): string | null {
  const cell = screen.getByRole('button', { name }).closest('[role="columnheader"]');

  if (cell === null) {
    throw new Error(`the control "${name}" is not inside a column header`);
  }

  return cell.getAttribute('aria-sort');
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
 * The single recorded argument list of a spy, failing on any other count.
 *
 * @param spy The spy to read.
 * @returns Its one call's arguments.
 */
function soleCall<Args extends unknown[]>(spy: Mock<(...args: Args) => void>): Args {
  expect(spy).toHaveBeenCalledTimes(1);

  const [call] = spy.mock.calls;

  if (call === undefined) {
    throw new Error('the spy recorded no call');
  }

  return call;
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
 * Distinct statements, distinct systems-worth of numbers and distinct durations,
 * so a per-row assertion cannot pass by matching the wrong row. Deliberately
 * NOT in duration order: the ordering cases render them exactly as the provider
 * hands them over.
 * ---------------------------------------------------------------------------
 */

/** The group whose statement carries the placeholders and the whitespace. */
const FIRST_GROUP = makeQueryGroup();

/** A second group, slower in total but run fewer times. */
const SECOND_GROUP = makeQueryGroup({
  id: 'query-example-0002',
  statement: SECOND_STATEMENT,
  normalizedStatement: SECOND_STATEMENT,
  executionCount: 2,
  totalDurationMs: 1175,
  averageDurationMs: 520,
  minDurationMs: 240,
  maxDurationMs: 935,
  firstStartTime: BASE_START_MS + 40,
  lastStartTime: BASE_START_MS + 600,
  totalRowCount: 6,
  occurrencesTruncated: false,
  callers: [makeCaller({ id: 'caller-example-0003', executionCount: 2, source: BASE_SOURCE })],
  occurrences: [
    makeOccurrence({
      id: 'event-example-0003',
      spanId: spanIdFor(3),
      startTime: BASE_START_MS + 40,
      durationMs: 240,
      rowCount: 3,
    }),
    makeOccurrence({
      id: 'event-example-0004',
      spanId: spanIdFor(4),
      startTime: BASE_START_MS + 600,
      durationMs: 935,
      rowCount: 3,
      status: 'error',
    }),
  ],
});

/** The two groups in the order the provider returns them below. */
const PROVIDER_ORDER: readonly QueryGroup[] = [FIRST_GROUP, SECOND_GROUP];

/** Their collapsed statements, in that same order. */
const PROVIDER_ORDER_PREVIEWS: readonly string[] = PROVIDER_ORDER.map((group) =>
  oneLinePreview(group.statement),
);

/**
 * The text of a numeric cell placed by one of the component's element classes.
 *
 * Read by class rather than by text because the figures in a row are not unique
 * within it — a group that ran twice can have a caller that ran twice — and a
 * text query would then match a chip instead of the cell under assertion.
 *
 * @param row A data row.
 * @param element The element class, without the block prefix.
 * @returns The cell's exact text.
 */
function numericCell(row: HTMLElement, element: 'count' | 'rows'): string {
  const cell = row.querySelector(`code.dg-query-table__${element}`);

  if (cell === null) {
    throw new Error(`the row carries no "${element}" cell`);
  }

  return cell.textContent ?? '';
}

describe('QueryTable states', () => {
  it('renders the loading state, and no rows, while the first page has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes only the
    // element class that places it.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.classList.contains('dg-query-table__loading')).toBe(true);

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer (AAP 0.5.5).
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();

    // One query, issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders its own empty message, and no rows, for a successful empty page', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic substring of the product's own copy rather than by a
    // restatement of the sentence: product vocabulary, naming no inspected
    // application (AAP 0.5.4).
    const message = await screen.findByText(EMPTY_MESSAGE_PATTERN);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);

    // An absence is described as an absence. It names no statement, because
    // there was none to name.
    expect(message.textContent).not.toContain('example_items');
    expect(message.textContent).not.toContain('$1');

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure, and there is no grid to hold rows.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.', {
        hint: 'Start the local service and reconnect.',
      }),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-query-table__error')).toBe(true);

    // The provider's own message, hint and code reach the reader, rather than a
    // generic sentence written over them.
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('Start the local service and reconnect.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, and is compared as a value rather
    // than as a spelling. It is the RESOLVED query: the page size and offset the
    // component actually asked for, which is what a developer needs to see.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'queries',
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
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode({ query: { source: 'requests' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-query-table__error')).toBe(true);

    // The node's own query is what the reader is shown, and no retry is offered:
    // re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'requests' });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('grid')).toBeNull();
  });
});

describe('QueryTable rows', () => {
  it('draws one row per group, with its statement, system, counts and timings', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Named by the component's own caption when the node carries no title.
    await screen.findByRole('grid', {
      name: 'Database statements captured during this interaction',
    });
    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);

    // The ordering control is present and reports the ordering in force, so a
    // reader can change it without guessing which one produced these rows.
    const toolbar = screen.getByRole('group', { name: TOOLBAR_NAME });
    const order = within(toolbar).getByRole('combobox', { name: ORDER_CONTROL_NAME });
    expect(order).toHaveProperty('value', SLOWEST_FIRST);

    for (const [index, group] of PROVIDER_ORDER.entries()) {
      const row = dataRow(index);

      // The statement is the row's header, so a reader hears the row named by
      // the statement rather than by a number.
      expect(collapsedStatement(row)).toBe(oneLinePreview(group.statement));

      // The engine that ran it, as a chip rather than as bare text.
      const system = within(row).getByText(DB_SYSTEM);
      expect(system.classList.contains('dg-badge')).toBe(true);

      // How often it ran: the figure a duplicate-query question is answered
      // with, formatted through the package's own count formatter.
      expect(numericCell(row, 'count')).toBe(formatCount(group.executionCount));

      // Three timings, each formatted with its unit and placed by this
      // component's element class.
      for (const ms of [group.totalDurationMs, group.averageDurationMs, group.maxDurationMs]) {
        const duration = within(row).getByText(formatDuration(ms));
        expect(duration.classList.contains('dg-duration-cell')).toBe(true);
        expect(duration.classList.contains('dg-query-table__duration')).toBe(true);
      }

      // No wall-clock instant: the row carries measurements, and an epoch
      // timestamp would be noise beside the statement it belongs to.
      expect(row.textContent).not.toContain(String(group.firstStartTime));
    }

    // One literal, to prove a duration is rendered as a scaled quantity rather
    // than as a millisecond count.
    expect(within(dataRow(1)).getByText('1.175 s')).toBeDefined();

    // Eight columns, in the order the component declares them: every field the
    // `queryTable` catalog entry reads.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      ...HEADERS,
    ]);
  });

  it('uses the node title as the grid caption when the node carries one', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);

    renderComponent(makeNode({ title: 'Slowest statements' }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: 'Slowest statements' });
  });

  it('renders rows in the order the provider returned them, without re-sorting', async () => {
    // The page is deliberately not in total-time order (640 ms, then 1175 ms)
    // while the node asks for `duration_desc`: the service applied the ordering
    // it was given (AAP 0.4.2), so a component that re-ranked the page locally
    // would show an order no response ever reported.
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    expect(collapsedStatements()).toEqual([...PROVIDER_ORDER_PREVIEWS]);

    // Stated as a property too, so the intent survives a fixture change: the
    // rendered order is not the duration ranking.
    const totals = PROVIDER_ORDER.map((group) => group.totalDurationMs);
    expect(totals).not.toEqual([...totals].sort((left, right) => right - left));
  });
});

describe('QueryTable statement fidelity', () => {
  it('shows the received statement byte for byte when the row is expanded', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    const [statement] = statementBlocks(detailRow());

    if (statement === undefined) {
      throw new Error('the expanded row carries no statement block');
    }

    // THE assertion of this file. Equality against the fixture string itself,
    // not against a normalised variant of it: every `$1`, the `?` the redactor
    // left, all three runs of interior spaces, every newline and every unit of
    // leading indentation, in the order they arrived (AAP 0.5.2).
    expect(statement.textContent).toBe(STATEMENT);

    // Stated again as the properties a "nicer SQL display" would break, so that
    // a future change cannot satisfy the equality above by coincidence.
    expect(statement.textContent).toContain('$1');
    expect(statement.textContent).toContain('state = ?');
    expect(statement.textContent).toContain('id,   label');
    expect(statement.textContent).toContain('\n  FROM example_items');
    expect(statement.textContent).not.toBe(STATEMENT.trim().replace(/\s+/gu, ' '));

    // The block form preserves that whitespace when it is displayed, which is a
    // property of the element and not of the string: `<pre>` rather than a
    // `<div>` that would collapse every run above into one space.
    expect(statement.tagName).toBe('PRE');
  });

  it('shows the package preview in the collapsed cell and carries the exact text beside it', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const row = dataRow(0);
    const preview = oneLinePreview(STATEMENT);

    // The one string operation the component may apply: this package's own
    // documented display preview, asserted as that function's exact output.
    expect(collapsedStatement(row)).toBe(preview);

    // And it really is a transformation of the display only — the statement's
    // own whitespace does not survive one line, which is exactly why the
    // untouched text has to travel with it.
    expect(preview).not.toBe(STATEMENT);

    // It travels as the cell's description, which is in the document whether the
    // bubble is shown or not, so the received text is never more than a hover
    // away and is never rewritten on the way there.
    const description = within(within(row).getByRole('rowheader')).getByRole('tooltip');
    expect(description.textContent).toBe(STATEMENT);

    // No placeholder was completed and no literal invented: the collapsed form
    // still shows the placeholders the producer sent.
    expect(collapsedStatement(row)).toContain('$1');
    expect(collapsedStatement(row)).toContain('= ?');
  });

  it('truncates an over-long statement in the formatter documented form, and restores it in full', async () => {
    const group = makeQueryGroup({
      statement: LONG_STATEMENT,
      normalizedStatement: LONG_STATEMENT,
    });
    const stub = resolvingProvider([group]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const collapsed = collapsedStatement(dataRow(0));

    // The formatter's form, and the bound it enforces: 120 code points including
    // the single-code-point ellipsis, which is the privacy bound AAP 0.5.2 fixes
    // on any captured preview rather than a layout preference.
    expect(collapsed).toBe(oneLinePreview(LONG_STATEMENT));
    expect([...collapsed]).toHaveLength(120);
    expect(collapsed.endsWith('…')).toBe(true);

    // Expansion restores the original exactly — not a re-wrapped, re-indented or
    // re-cased approximation of it.
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    const [statement] = statementBlocks(detailRow());
    expect(statement?.textContent).toBe(LONG_STATEMENT);

    // Including the placeholders that sat beyond the cut point.
    expect(statement?.textContent).toContain('grp.region = $2');
    expect(statement?.textContent).toContain('item.state = ?');
  });

  it('offers no way to run a statement, reveal a value or list a result row', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // The complete control surface of a collapsed table: two sortable headers,
    // one row disclosure and one caller chip. Asserted as a set rather than by
    // the absence of a named control, because an affordance added later would
    // arrive under a name this file could not have predicted — and the evidence
    // to build one was never captured (AAP 0.5.2).
    expect(controlNames()).toEqual(
      [EXECUTIONS_SORT_NAME, TOTAL_TIME_SORT_NAME, EXPAND_ROW_NAME, SOURCE_CHIP_NAME].sort(),
    );

    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    const detail = detailRow();
    const occurrenceNames = FIRST_GROUP.occurrences.map(
      (occurrence) =>
        `Select the execution at +${formatOffset(occurrence.startTime, FIRST_GROUP.firstStartTime)}`,
    );

    // Opening a row adds the executions themselves and nothing else.
    expect(controlNames()).toEqual(
      [
        EXECUTIONS_SORT_NAME,
        TOTAL_TIME_SORT_NAME,
        COLLAPSE_ROW_NAME,
        SOURCE_CHIP_NAME,
        ...occurrenceNames,
      ].sort(),
    );

    for (const name of controlNames()) {
      // Every control on screen names a measurement, a disclosure or a place in
      // the code. None names data, under any of the labels such an affordance
      // would plausibly wear.
      expect(name).not.toMatch(FORBIDDEN_CONTROL_PATTERN);
    }

    // And nothing resembling a result set is rendered: one grid in the document,
    // and the detail of an open row holds no grid, table or row of its own.
    expect(screen.getAllByRole('grid')).toHaveLength(1);
    expect(within(detail).queryAllByRole('grid')).toHaveLength(0);
    expect(within(detail).queryAllByRole('table')).toHaveLength(0);
    expect(within(detail).queryAllByRole('row')).toHaveLength(0);
  });

  it('renders a reported row count as a plain count, under the privacy note', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const row = dataRow(0);

    // A count, and only a count: the cell's whole text is the formatted number,
    // with no sample, no preview and no "view rows" affordance beside it.
    expect(numericCell(row, 'rows')).toBe(formatCount(DEFAULT_ROW_COUNT));

    // The note that makes the number unambiguous, in as many words.
    const notes = within(row)
      .getAllByRole('tooltip')
      .map((bubble) => bubble.textContent);
    expect(notes).toContain(ROW_COUNT_TOOLTIP);
  });

  it('says a row count was never reported rather than printing zero', async () => {
    // A producer that reports no row counts says nothing about a result. Zero
    // would turn "never measured" into the observation "returned no rows", and
    // the two must not look alike (AAP 0.5.2).
    const stub = resolvingProvider([makeQueryGroup({ totalRowCount: undefined })]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    expect(numericCell(dataRow(0), 'rows')).toBe(NOT_AVAILABLE_LABEL);
    expect(numericCell(dataRow(0), 'rows')).not.toBe('0');
    expect(numericCell(dataRow(0), 'rows')).not.toBe(formatCount(0));
  });

  it('renders the execution count that makes a repeated statement legible', async () => {
    // The figure a "why did this query run twice" follow-up is answered with.
    const stub = resolvingProvider([makeQueryGroup({ executionCount: 2 })]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    expect(numericCell(dataRow(0), 'count')).toBe(formatCount(2));
    expect(numericCell(dataRow(0), 'count')).toBe('2');
  });
});

describe('QueryTable callers', () => {
  it('hands the host the very location a caller resolved to — the acceptance hop', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    // Taken BEFORE the render and compared afterwards: comparing the emitted
    // object's keys against the live fixture alone would be satisfied by a
    // component that added a field to it in place.
    const expectedKeys = Object.keys({ ...BASE_SOURCE }).sort();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const row = dataRow(0);

    // Both callers are listed: the one that resolved and the one that did not.
    // A group's executions are attributed to places in the code, and dropping
    // the unresolved one would misreport how the executions were shared.
    const chip = within(row).getByRole('button', { name: SOURCE_CHIP_NAME });
    expect(chip.textContent).toContain(RESOLVED_CALLER_NAME);
    expect(within(row).getByText(UNRESOLVED_CALLER_NAME)).toBeDefined();

    // Each carries its share of the group's executions, which is what makes a
    // caller list an explanation rather than a decoration.
    const callerCounts = [...row.querySelectorAll('.dg-query-table__caller')].map(
      (caller) => caller.querySelector('.dg-badge')?.textContent,
    );
    expect(callerCounts).toEqual([formatCount(3), formatCount(1)]);

    // Rendering a chip is not activating it: nothing opens an editor until the
    // developer asks.
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    await user.click(chip);

    const [received] = soleCall(spies.onOpenSource);

    // Equal, and the same key set: a dropped `symbol`, `resolvedBy` or
    // `confidence` and an invented extra field both fail here. Every hop after
    // this one acts on the object it is handed (AAP 0.4.2), and this is the last
    // hop of acceptance test 1 (AAP 0.8.4).
    expect(received).toEqual(BASE_SOURCE);
    expect(Object.keys(received).sort()).toEqual(expectedKeys);
    expect(received.file).toBe(SOURCE_FILE);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.line).toBe(SOURCE_LINE);
    expect(received.column).toBe(SOURCE_COLUMN);
    expect(received.symbol).toBe(SOURCE_SYMBOL);

    // Opening source is not expanding the row it sits in, and it is not a
    // selection: the chip's activation stops at the chip.
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
    expect(detailRowCount()).toBe(0);
  });

  it('renders a caller the resolver could not place as text, with no control', async () => {
    const stub = resolvingProvider([
      makeQueryGroup({ callers: [makeCaller({ name: UNRESOLVED_CALLER_NAME })] }),
    ]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const name = within(dataRow(0)).getByText(UNRESOLVED_CALLER_NAME);

    // A control that leads nowhere is the feature failing quietly, so there is
    // no control: neither an element nor an ancestor of it claims to be one.
    expect(name.closest('button')).toBeNull();
    expect(name.closest('[role="button"]')).toBeNull();
    expect(within(dataRow(0)).queryByRole('button', { name: SOURCE_CHIP_NAME })).toBeNull();
    expect(dataRow(0).textContent).not.toContain(SOURCE_FILE);
  });

  it('says so rather than naming a caller, when no execution could be attributed', async () => {
    const stub = resolvingProvider([makeQueryGroup({ callers: [] })]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = within(dataRow(0)).getAllByRole('gridcell');
    const callers = cells.at(-1);

    expect(callers?.textContent).toBe(NOT_AVAILABLE_LABEL);
    expect(callers?.textContent).not.toContain(RESOLVED_CALLER_NAME);
  });
});

describe('QueryTable provenance', () => {
  it('shows the aggregate grouping key, exactly as the aggregate reported it', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    const detail = detailRow();

    // Several executions collapsed into one row, and the basis of that is
    // discoverable rather than implied: the sentence that says so, and the key
    // itself beneath it.
    expect(within(detail).getByText(GROUPING_BASIS_PATTERN)).toBeDefined();

    const blocks = statementBlocks(detail);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.textContent).toBe(STATEMENT);

    // DISPLAYED, never recomputed. The fixture's key is deliberately not
    // derivable from its statement by anything this package can do — it differs
    // in case and in placeholder shape — so a component that re-derived a key
    // could not produce this string.
    expect(blocks[1]?.textContent).toBe(NORMALIZED_STATEMENT);
    expect(blocks[1]?.textContent).not.toBe(STATEMENT);
    expect(blocks[1]?.textContent).not.toBe(oneLinePreview(STATEMENT));
    expect(blocks[1]?.textContent).not.toBe(STATEMENT.toLowerCase());
  });

  it('shows one statement and no grouping basis when the two are the same text', async () => {
    const stub = resolvingProvider([SECOND_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    const detail = detailRow();

    // Nothing to explain, so nothing is said: a second identical block would
    // suggest a normalisation that never happened.
    expect(within(detail).queryByText(GROUPING_BASIS_PATTERN)).toBeNull();

    const blocks = statementBlocks(detail);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe(SECOND_STATEMENT);
  });
});

describe('QueryTable expansion', () => {
  it('reports the state after the gesture and lists the executions it carries', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const toggle = screen.getByRole('button', { name: EXPAND_ROW_NAME });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(detailRowCount()).toBe(0);

    await user.click(toggle);

    // The state AFTER the gesture, keyed by the node and the group, so a host
    // with two query tables in one panel can tell them apart and can persist
    // disclosure without tracking a parity.
    expect(soleCall(spies.onExpand)).toEqual([NODE_ID, FIRST_GROUP.id, true]);

    const detail = detailRow();

    // Each execution names when it ran relative to the group's first, how long
    // it took, how many rows it reported and how it ended.
    for (const occurrence of FIRST_GROUP.occurrences) {
      const offset = formatOffset(occurrence.startTime, FIRST_GROUP.firstStartTime);
      const control = within(detail).getByRole('button', {
        name: `Select the execution at +${offset}`,
      });
      expect(control.textContent).toBe(`+${offset}`);
      expect(within(detail).getByText(formatDuration(occurrence.durationMs))).toBeDefined();
    }
    expect(within(detail).getAllByText(formatStatusLabel('ok'))).toHaveLength(
      FIRST_GROUP.occurrences.length,
    );

    // The group's fastest execution, which the table has no column for.
    expect(within(detail).getByText('Fastest')).toBeDefined();
    expect(within(detail).getByText(formatDuration(FIRST_GROUP.minDurationMs))).toBeDefined();

    // A bounded list that says it is bounded: the aggregate carried two of four
    // executions while keeping every count exact, and saying so is the
    // difference between a bounded list and a wrong one (AAP 0.4.2).
    const notice = within(detail).getByText(/the rest were not carried/i);
    expect(notice.textContent).toContain(formatCount(FIRST_GROUP.occurrences.length));
    expect(notice.textContent).toContain(formatCount(FIRST_GROUP.executionCount));

    // Closing reports the same way round, and takes the detail away with it.
    await user.click(screen.getByRole('button', { name: COLLAPSE_ROW_NAME }));

    expect(spies.onExpand).toHaveBeenCalledTimes(2);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, FIRST_GROUP.id, false);
    expect(detailRowCount()).toBe(0);

    // Disclosure asked nothing of the data layer and selected nothing.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('announces an activated execution as the event it stands for', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    const [occurrence] = FIRST_GROUP.occurrences;

    if (occurrence === undefined) {
      throw new Error('the fixture group carries no occurrences');
    }

    await user.click(
      within(detailRow()).getByRole('button', {
        name: `Select the execution at +${formatOffset(occurrence.startTime, FIRST_GROUP.firstStartTime)}`,
      }),
    );

    // The three identifiers a host needs to resolve the record, taken from that
    // execution's own event and nothing else. The aggregate ROW above has no
    // single event — it stands for many — so it never reports one, and no
    // identifier is invented to fill the gap.
    const [ref] = soleCall(spies.onSelectEvent);
    expect(ref).toEqual({
      eventId: occurrence.eventId,
      spanId: occurrence.spanId,
      traceId: occurrence.traceId,
    });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // Selecting an execution is not opening its source, and it is not a second
    // disclosure report.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
  });
});

describe('QueryTable ordering', () => {
  it('turns a header activation into a new query and follows the response', async () => {
    // Two pages: the node's own `duration_desc`, then whatever the service
    // returns for `count_desc`. The second page is a different order of the same
    // groups, which is the only way to tell "the rows follow the new response"
    // from "the rows were re-ordered in the browser".
    const reordered: readonly QueryGroup[] = [SECOND_GROUP, FIRST_GROUP];
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: reordered }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    expect(collapsedStatements()).toEqual([...PROVIDER_ORDER_PREVIEWS]);
    expect(soleQuery(stub).sort).toBe(SLOWEST_FIRST);

    // The header reports the ordering that was applied, not one the service was
    // never asked for.
    expect(ariaSortOf(TOTAL_TIME_SORT_NAME)).toBe('descending');
    expect(ariaSortOf(EXECUTIONS_SORT_NAME)).toBe('none');

    await user.click(screen.getByRole('button', { name: EXECUTIONS_SORT_NAME }));

    // A re-query, with the ordering the data layer understands.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const requeried = queryOfCall(stub, 2);
    expect(requeried.sort).toBe(MOST_EXECUTIONS_FIRST);
    expect(requeried.source).toBe('queries');
    expect(requeried.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    // A new ordering is a new page sequence, so it starts at the node's offset.
    expect(requeried.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    // And the rows follow that response, in its order — the first page held the
    // same groups, so an order matching the second response could only have come
    // from the second response.
    await waitFor(() => {
      expect(collapsedStatements()).toEqual(
        reordered.map((group) => oneLinePreview(group.statement)),
      );
    });
    expect(ariaSortOf(EXECUTIONS_SORT_NAME)).toBe('descending');
    expect(ariaSortOf(TOTAL_TIME_SORT_NAME)).toBe('none');

    // The host is told, so it can remember the reader's choice; it is a report
    // of a selection and carries no query shape.
    expect(soleCall(spies.onFilterChange)).toEqual([NODE_ID, { sort: MOST_EXECUTIONS_FIRST }]);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('does not re-query when the activated column is already the applied order', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    // The node already asks for `duration_desc`, and the closed vocabulary holds
    // one direction per ordering, so a second activation of that column has
    // nothing to request: the flipped direction is an ordering the data layer
    // cannot express, and approximating it would apply an order the reader did
    // not ask for.
    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: TOTAL_TIME_SORT_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).not.toHaveBeenCalled();
    expect(collapsedStatements()).toEqual([...PROVIDER_ORDER_PREVIEWS]);
    // The header keeps reporting the order the rows really are in.
    expect(ariaSortOf(TOTAL_TIME_SORT_NAME)).toBe('descending');
  });

  it('re-queries for an ordering chosen through the toolbar', async () => {
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: PROVIDER_ORDER }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    await user.selectOptions(
      screen.getByRole('combobox', { name: ORDER_CONTROL_NAME }),
      EARLIEST_FIRST,
    );

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).sort).toBe(EARLIEST_FIRST);
    expect(soleCall(spies.onFilterChange)).toEqual([NODE_ID, { sort: EARLIEST_FIRST }]);

    // No column of this table claims an ordering by start time, so no header may
    // report one: the rows are in the data layer's natural order for it.
    await waitFor(() => {
      expect(ariaSortOf(TOTAL_TIME_SORT_NAME)).toBe('none');
    });
    expect(ariaSortOf(EXECUTIONS_SORT_NAME)).toBe('none');
  });
});

describe('QueryTable paging', () => {
  it('says how much of the result is on screen and appends the next page', async () => {
    // `nextOffset` deliberately differs from the length of the page: the
    // contract is that a view copies the offset the service reported, never one
    // it derived from what arrived, which drifts the moment a limit is clamped.
    const stub = pagingProvider([
      { data: [FIRST_GROUP], total: 9, nextOffset: 5 },
      { data: [SECOND_GROUP], total: 9, nextOffset: 6 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // One statement of nine, said plainly rather than implied by a bare count.
    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(9)} statements`);
    expect(dataRows()).toHaveLength(1);

    const first = soleQuery(stub);
    expect(first.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(first.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next page is requested at the offset the SERVICE reported.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const second = queryOfCall(stub, 2);
    expect(second.offset).toBe(5);
    expect(second.offset).toBeGreaterThan(first.offset ?? DATA_QUERY_DEFAULT_OFFSET);
    expect(second.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(second.sort).toBe(SLOWEST_FIRST);
    expect(second.source).toBe('queries');

    // Appended, not replaced: the page the reader was already reading stays, in
    // the order the data layer paged it.
    await waitFor(() => {
      expect(collapsedStatements()).toEqual([...PROVIDER_ORDER_PREVIEWS]);
    });
    expect(
      screen.getByText(`Showing ${formatCount(2)} of ${formatCount(9)} statements`),
    ).toBeDefined();
  });

  it('states only what is known when the service reports no total', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A service that reported no total leaves this view unable to know whether
    // more rows exist, so the sentence states the count it has rather than
    // printing a placeholder where a number belongs (AAP 0.4.2).
    await screen.findByText(`Showing ${formatCount(2)} statements`);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('keeps the rows on screen while a further page is in flight', async () => {
    const stub = pendingAfterFirstProvider({ data: [FIRST_GROUP], total: 9, nextOffset: 5 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // Blanking a table the reader is using in order to re-show a skeleton would
    // lose their place, so the incremental state lives in the footer beside the
    // control that asked for it — and the first-page loading state stays away.
    await screen.findByText(LOADING_MORE_MESSAGE);
    expect(dataRows()).toHaveLength(1);
    expect(collapsedStatements()).toEqual([oneLinePreview(STATEMENT)]);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('offers a retry in the footer when a further page fails, and keeps the rows', async () => {
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({
            source: 'queries',
            data: [FIRST_GROUP],
            total: 9,
            nextOffset: 5,
          })
        : Promise.reject(
            new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
          ),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // A failed second page is reported where it was asked for. The rows already
    // read stay, and the failure is never dressed as an empty result
    // (AAP 0.5.5).
    const retry = await screen.findByRole('button', { name: RETRY_PAGE_NAME });
    expect(dataRows()).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(retry);

    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3)).toEqual(queryOfCall(stub, 2));
  });
});
