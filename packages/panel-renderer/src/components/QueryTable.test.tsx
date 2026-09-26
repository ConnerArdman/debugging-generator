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
 * a result is a row *count*. So the cases below assert that the statement is
 * **displayed, never transformed**: the expanded block holds the received text
 * byte for byte, the collapsed cell holds this package's own documented display
 * preview of it and carries the untouched text beside it, no placeholder is ever
 * filled in, no control offers to run, copy or reveal anything, and nothing
 * resembling a result row is rendered anywhere.
 *
 * Byte fidelity here is not pedantry. The parameterized statement *is* the
 * guarantee: a later "nicer SQL display" — a trim, a re-case, a pretty-print, a
 * substituted placeholder — would either destroy the guarantee's auditability or
 * suggest the product holds data it never captured. An exact comparison is the
 * only assertion that keeps such a change honest, which is why these cases
 * compare against the fixture string and not against a normalised variant of it.
 *
 * **Second, the end of the click-to-source flow.** The click-to-source flow ends
 * at this table's caller chip, which opens the editor at the statement's call
 * site. The caller case asserts what the host actually receives through
 * `PanelActions.onOpenSource` — equal to the location the resolver produced,
 * with the same key set — because every hop after this one acts blind on the
 * object it is handed, and a caller the resolver could not place must render as
 * text rather than as a control leading nowhere.
 *
 * **Third, the paging and ordering contract.** `POST /sessions/:id/panel-data`
 * applies `filter`, `sort`, `limit` and `offset` and answers with `total` and
 * `nextOffset`, so ordering is a *re-query* rather than a local re-ranking, a
 * page is appended at the offset the service reported, the footer says how much
 * of the result is on screen, and a bounded occurrence list says that it is
 * bounded.
 *
 * Alongside those, every component suite here covers the three states of a
 * query-backed view — loading, empty and error — each driven through a stub
 * `DataProvider` that respectively never settles, resolves an empty page and
 * rejects.
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
 *   - **Generic fixture vocabulary only**: a statement over a table named
 *     `example_items`, callers in `src/example/repository.ts`. No table, column,
 *     component, service or route name of any inspected application appears
 *     here, in the fixtures or in the comments.
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
 * @see docs/SECURITY.md, "Redaction", for the SQL placeholder and row-count treatment.
 * @see docs/ARCHITECTURE.md, "Panel data", "The renderer contract" and "A click, end to end",
 * for the paging contract, the three states and the click-to-source path.
 */

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, QueryTableNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { QueryCaller, QueryGroup, QueryOccurrence } from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext, PanelSelectionContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef, PanelSelection } from '../host/PanelActions';
import { DATA_TABLE_COLUMN_TRACKS } from '../primitives/DataTable';
import type { DataTableColumnWidth } from '../primitives/DataTable';
import { FOCUS_KEY_ATTRIBUTE } from '../primitives/ErrorState';
import { DESIGN_TOKENS, cssVar } from '../tokens/tokens';
import type { TokenKey, TokenValues } from '../tokens/tokens';
import {
  NOT_AVAILABLE_LABEL,
  formatCompactPath,
  formatCount,
  formatDuration,
  formatOffset,
  formatStatusLabel,
  oneLinePreview,
} from '../utils/format';
import { QueryTable } from './QueryTable';
import { sourceLinkAccessibleName } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Application-neutral throughout. The identifiers are shaped as a capture
 * shapes them — a 32-hex trace id, 16-hex span ids, epoch-millisecond start
 * times, millisecond durations — because the component reads those fields and
 * formats them.
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
 * A complete, resolved location — the object the click-to-source flow must
 * deliver to the host unchanged.
 */
const BASE_SOURCE: SourceLocation = {
  file: SOURCE_FILE,
  line: SOURCE_LINE,
  column: SOURCE_COLUMN,
  symbol: SOURCE_SYMBOL,
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

/**
 * The accessible name the caller chip announces.
 *
 * Asked of `SourceLink`'s own naming rule with exactly the props the component
 * passes — the location alone, so the chip captions itself from the location
 * (its symbol and compacted `file:line`) — rather than restated here: the rule
 * is pinned by `./SourceLink.test.tsx`, and these cases need the name the chip
 * actually carries.
 */
const SOURCE_CHIP_NAME = sourceLinkAccessibleName({ location: BASE_SOURCE });

/**
 * The caller chip's visible caption: the location's symbol, then its compacted
 * `file:line`, joined by the single space `SourceLink` renders between the runs.
 * Built from the package's own path formatter, so this suite pins which parts
 * of the location the caption shows rather than how a path is shortened.
 */
const SOURCE_CHIP_CAPTION = `${SOURCE_SYMBOL} ${formatCompactPath(SOURCE_FILE)}:${String(SOURCE_LINE)}`;

/** The full location the chip opens, as the end of its accessible name spells it. */
const SOURCE_TARGET = `${SOURCE_FILE}:${String(SOURCE_LINE)}:${String(SOURCE_COLUMN)}`;

/**
 * The accessible name of an execution's own chip in an expanded row, which is
 * the dense form a row embeds.
 */
const OCCURRENCE_CHIP_NAME = sourceLinkAccessibleName({ location: BASE_SOURCE, compact: true });

/** The name of the caller that resolved to {@link BASE_SOURCE}. */
const RESOLVED_CALLER_NAME = 'exampleRepository.loadItems';

/**
 * How a resolved caller's span name is shown beside its chip: as context in
 * plain text, never as the chip's caption.
 */
const RESOLVED_CALLER_CONTEXT = `via ${RESOLVED_CALLER_NAME}`;

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

/**
 * The accessible name of a row's disclosure control while the row is closed.
 *
 * The control names the row it opens: the verb, then the statement preview the
 * row header shows — `oneLinePreview` of the received text, the package's own
 * display form — so a reader on any row hears which statement it discloses and
 * two rows never share one name.
 *
 * @param statement The row's statement, exactly as received.
 * @returns The control's name.
 */
function expandRowName(statement: string): string {
  return `Show the executions of ${oneLinePreview(statement)}`;
}

/**
 * The same control's name while the row is open; see {@link expandRowName}.
 *
 * @param statement The row's statement, exactly as received.
 * @returns The control's name.
 */
function collapseRowName(statement: string): string {
  return `Hide the executions of ${oneLinePreview(statement)}`;
}

/** The disclosure names of the default fixture group, which most cases open. */
const EXPAND_ROW_NAME = expandRowName(STATEMENT);
const COLLAPSE_ROW_NAME = collapseRowName(STATEMENT);

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

/**
 * The package's one failure contract, as a reader meets it: the title and the
 * generic lead of a view that failed, and the lead of a next page that failed
 * behind rows already on screen (see `queryFailureProps` in `../host/useQuery`).
 * Spelled out rather than imported, so these cases pin the words a reader
 * hears rather than whatever the module currently holds.
 */
const VIEW_FAILURE_TITLE = 'Could not load this view';
const VIEW_FAILURE_LEAD = 'The data for this view could not be loaded.';
const PAGE_FAILURE_LEAD =
  'The next page of this view could not be loaded. The rows already shown are unaffected.';

/** The focus key every error state's retry carries, for the host's node frame. */
const RETRY_FOCUS_KEY = 'error-state-retry';

/** The busy region's announced label while the first page resolves. */
const LOADING_LABEL = 'Loading captured database queries…';

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
 * values a placeholder stands for. None of that evidence was ever captured, so
 * none of these controls may exist — and asserting their absence by name is
 * what would catch one arriving later under a plausible label.
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
 * implementation for: the code and hint it carries are what the error state renders.
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

  /** The open-source spy — where the click-to-source flow reaches the host. */
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
  node: QueryTableNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <QueryTable node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
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

    // Announced like every other busy region of the package: the label ends in
    // the single-character ellipsis (`…`) every loading label carries.
    expect(busy.textContent).toContain(LOADING_LABEL);

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer.
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
    // restatement of the sentence: product vocabulary, naming no inspected application.
    const message = await screen.findByText(EMPTY_MESSAGE_PATTERN);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);

    // An absence is described as an absence. It names no statement, because
    // there was none to name.
    expect(message.textContent).not.toContain('example_items');
    expect(message.textContent).not.toContain('$1');

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure, and there is no grid to hold rows.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
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

  it('renders a provider rejection through the shared error contract', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.', {
        hint: 'Start the local service and reconnect.',
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // One error-state design for every failed node, in its fixed order: the
    // default glyph, the view-scope title, the generic lead followed by the
    // provider's own cause, the provider's hint on a line of its own, the code
    // as a chip, the query, and a retry.
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('.dg-error-state__icon svg')).not.toBeNull();
    expect(
      within(alert).getByText(VIEW_FAILURE_TITLE).classList.contains('dg-error-state__title'),
    ).toBe(true);

    const [message, hint] = Array.from(
      alert.querySelectorAll('.dg-error-state__message'),
      (line) => line.textContent ?? '',
    );
    expect(message?.startsWith(VIEW_FAILURE_LEAD)).toBe(true);
    expect(message).toContain('The channel to the service is closed.');
    expect(hint).toBe('Start the local service and reconnect.');
    expect(within(alert).getByText('TRANSPORT_DISCONNECTED').classList.contains('dg-badge')).toBe(
      true,
    );

    // The query asked, printed by the package's one formatter: pretty JSON with
    // its members in the canonical order, so every node prints it alike.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    const asked = {
      source: 'queries',
      sort: SLOWEST_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: DATA_QUERY_DEFAULT_OFFSET,
    };
    expect(JSON.parse(shown.textContent ?? '')).toEqual(asked);
    expect(shown.textContent).toBe(JSON.stringify(asked, null, 2));

    // The retry carries the key the host's node frame returns focus by.
    expect(
      within(alert).getByRole('button', { name: RETRY_NAME }).getAttribute(FOCUS_KEY_ATTRIBUTE),
    ).toBe(RETRY_FOCUS_KEY);
  });

  it('reports a node whose query names a source it cannot draw, and asks for nothing', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode({ query: { source: 'requests' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-query-table__error')).toBe(true);

    // A defect in the panel rather than in the capture, said by the package's
    // one contract for it — worded from the node catalog, naming the source it
    // was asked for — with a code a developer can search for.
    expect(alert.textContent).toContain('This view cannot draw the requested data');
    expect(alert.textContent).toContain('but this panel asks it for "requests".');
    expect(alert.textContent).toContain('PANEL_INVALID');

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
    // it was given, so a component that re-ranked the page locally would show an
    // order no response ever reported.
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
    // leading indentation, in the order they arrived.
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

    // It travels as the cell's description: the bubble is in the document for
    // the preview's whole life — hidden while closed, so it is never read out of
    // context — and opens the moment focus or a pointer reaches the preview, so
    // the received text is never more than a hover away and is never rewritten
    // on the way there.
    const header = within(row).getByRole('rowheader');

    expect(describingTooltip(soleMatch(header, 'code.dg-query-table__statement')).textContent).toBe(
      STATEMENT,
    );
    expect(openedTooltipTexts(header)).toEqual([STATEMENT]);

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
    // the single-code-point ellipsis, which is the privacy bound on every
    // captured preview rather than a layout preference.
    expect(collapsed).toBe(oneLinePreview(LONG_STATEMENT));
    expect([...collapsed]).toHaveLength(120);
    expect(collapsed.endsWith('…')).toBe(true);

    // Expansion restores the original exactly — not a re-wrapped, re-indented or
    // re-cased approximation of it.
    await user.click(screen.getByRole('button', { name: expandRowName(LONG_STATEMENT) }));

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
    // to build one was never captured.
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

    // The note that makes the number unambiguous, in as many words, opened from
    // the row's own descriptions.
    expect(openedTooltipTexts(row)).toContain(ROW_COUNT_TOOLTIP);
  });

  it('says a row count was never reported rather than printing zero', async () => {
    // A producer that reports no row counts says nothing about a result. Zero
    // would turn "never measured" into the observation "returned no rows", and
    // the two must not look alike.
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
    expect(within(row).getByText(UNRESOLVED_CALLER_NAME)).toBeDefined();

    // The chip says where it goes (WCAG 2.5.3): its caption is the location's
    // own symbol and compacted `file:line`, never the name of the span the
    // statement ran under, and its accessible name starts with that caption and
    // ends with the full location it opens.
    expect(chip.textContent).toBe(SOURCE_CHIP_CAPTION);
    expect(chip.textContent).not.toContain(RESOLVED_CALLER_NAME);
    expect(chip.getAttribute('aria-label')?.startsWith(SOURCE_CHIP_CAPTION)).toBe(true);
    expect(chip.getAttribute('aria-label')?.endsWith(SOURCE_TARGET)).toBe(true);

    // The span that issued the statement stays on screen as context, as plain
    // text beside the chip and outside every control.
    const context = within(row).getByText(RESOLVED_CALLER_CONTEXT);
    expect(chip.contains(context)).toBe(false);
    expect(context.closest('button, [role="button"]')).toBeNull();

    const callerGroup = chip.closest<HTMLElement>('.dg-query-table__caller');
    expect(context.closest('.dg-query-table__caller')).toBe(callerGroup);

    // In reading order the chip is followed by its own execution count, and the
    // span name comes after both, so the figure stays beside the location it
    // counts executions for.
    const count = callerGroup?.querySelector<HTMLElement>('.dg-badge');

    if (count === null || count === undefined) {
      throw new Error('the resolved caller carries no execution count');
    }

    expect(chip.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(count.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

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
    // this one acts on the object it is handed, and the click-to-source flow
    // ends at this table's caller chip.
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

/*
 * ---------------------------------------------------------------------------
 * Column layout
 *
 * happy-dom performs no layout, so these cases pin the INPUTS the browser lays
 * the grid out from: the width role of each column the component hands
 * `DataTable`, the token-built track template and floor `DataTable` derives
 * from them, and the `Stack` variants the caller cell is built from. Each of
 * them decides, in a real browser, whether the caller chips stay inside their
 * column or spill over the Rows and Executions values beside it.
 * ---------------------------------------------------------------------------
 */

/**
 * The width role of each of the eight columns, left to right. See
 * `COLUMN_WIDTH` in `./QueryTable` for why each column takes its role.
 */
const COLUMN_WIDTHS: readonly DataTableColumnWidth[] = [
  'text',
  'label',
  'count',
  'quantity',
  'quantity',
  'quantity',
  'count',
  'name',
];

/**
 * A reference to one of the column-geometry tokens a role track is built from.
 * Removing every such reference from a track template must leave nothing but
 * the `minmax()` frames and the spaces between tracks: no number and no unit is
 * the component's own.
 */
const COLUMN_TOKEN_REFERENCE = /var\(--dg-column-(?:min|share)-[a-z]+\)/gu;

/** Every theme's token set, each of which must give every column a floor. */
const THEMES: readonly TokenValues[] = [
  DESIGN_TOKENS.dark,
  DESIGN_TOKENS.light,
  DESIGN_TOKENS.highContrast,
];

/**
 * The magnitude, in `ch`, that a role's floor token resolves to in one theme.
 *
 * @param width The column's width role.
 * @param theme The token set to resolve against.
 * @returns The floor in `ch`, or `undefined` when the floor is no `ch` token.
 */
function floorChOf(width: DataTableColumnWidth, theme: TokenValues): number | undefined {
  const { minimum } = DATA_TABLE_COLUMN_TRACKS[width];
  const keys = Object.keys(theme) as TokenKey[];
  const key = keys.find((candidate) => cssVar(candidate) === minimum);
  const magnitude = key === undefined ? undefined : /^(\d+(?:\.\d+)?)ch$/u.exec(theme[key])?.[1];

  return magnitude === undefined ? undefined : Number(magnitude);
}

describe('QueryTable column layout', () => {
  it('gives every column a non-zero floor, so a narrow panel scrolls instead of squeezing', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid');
    const template = grid.style.getPropertyValue('--dgc-columns');

    // One role per column, resolved to the design system's track for that role
    // and to nothing the component sized itself.
    expect(COLUMN_WIDTHS).toHaveLength(HEADERS.length);
    expect(template).toBe(
      COLUMN_WIDTHS.map((width) => DATA_TABLE_COLUMN_TRACKS[width].track).join(' '),
    );
    expect(template.replace(COLUMN_TOKEN_REFERENCE, '')).toMatch(/^(?:minmax\(, \)| )+$/u);

    // Not one track is a floorless `minmax(0, …)`, which would let every column
    // collapse to its padding and a caller chip paint over the Rows and
    // Executions values beside it: each role's floor is a positive length in
    // every theme.
    expect(template).not.toContain('minmax(0');
    for (const theme of THEMES) {
      for (const width of COLUMN_WIDTHS) {
        expect(floorChOf(width, theme) ?? 0, `the ${width} floor`).toBeGreaterThan(0);
      }
    }

    // Every column's floor reaches the grid's own minimum inline size, which is
    // what turns a panel narrower than the columns need into a horizontal scroll.
    expect(grid.style.getPropertyValue('--dgc-min-inline')).toBe(
      `calc(${COLUMN_WIDTHS.map((width) => DATA_TABLE_COLUMN_TRACKS[width].minimum).join(' + ')})`,
    );
    expect(grid.style.getPropertyValue('--dgc-column-count')).toBe(String(HEADERS.length));

    // The header row and every data row inherit the one template, so each
    // column sits under its own header whatever its content.
    expect(screen.getAllByRole('columnheader')).toHaveLength(COLUMN_WIDTHS.length);
    for (const row of dataRows()) {
      expect(within(row).getAllByRole('gridcell').length + 1).toBe(COLUMN_WIDTHS.length);
    }
  });

  it('stretches the caller list across its cell and starts every caller at the cell edge', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    for (const [index, group] of PROVIDER_ORDER.entries()) {
      const list = soleMatch(dataRow(index), '.dg-query-table__callers');

      // The vertical list stretches its callers to the cell's width. A centred
      // list would let a chip wider than the column overflow both edges,
      // starting before the cell and ending over the Rows column.
      expect(list.classList.contains('dg-stack--vertical')).toBe(true);
      expect(list.classList.contains('dg-stack--align-stretch')).toBe(true);
      expect(list.classList.contains('dg-stack--align-center')).toBe(false);

      const callers = [...list.querySelectorAll<HTMLElement>('.dg-query-table__caller')];
      expect(callers).toHaveLength(group.callers.length);

      for (const [position, caller] of callers.entries()) {
        const expected = group.callers[position];

        if (expected === undefined) {
          throw new Error(`the fixture group carries no caller at index ${String(position)}`);
        }

        // Each caller packs its chip and count at the START of the inline
        // axis. Its `align` variant is the cross (vertical) axis only.
        expect(caller.classList.contains('dg-stack--horizontal')).toBe(true);
        expect(caller.classList.contains('dg-stack--justify-start')).toBe(true);
        expect(caller.classList.contains('dg-stack--justify-center')).toBe(false);
        expect(caller.classList.contains('dg-stack--justify-end')).toBe(false);

        // The count directly follows the chip and carries the class the
        // stylesheet keeps at full width, so the chip before it is what
        // ellipsizes and the count stays whole. The caller's span name, when
        // it follows, is plain text after both and never the chip's caption.
        const rows = [...caller.children].filter((child) =>
          child.classList.contains('dg-stack__items'),
        );
        const [items] = rows;

        if (items === undefined || rows.length !== 1) {
          throw new Error(`expected one item row in a caller, found ${String(rows.length)}`);
        }

        const count = soleMatch(items, '.dg-query-table__caller-count');
        const countSlot = [...items.children].find((child) => child.contains(count));

        if (countSlot === undefined) {
          throw new Error('the caller row renders no count slot');
        }

        expect(count.classList.contains('dg-badge')).toBe(true);
        expect(count.textContent).toBe(formatCount(expected.executionCount));
        expect(countSlot.querySelector('.dg-source-link')).toBeNull();
        expect(items.firstElementChild?.contains(count)).toBe(false);
        expect(caller.textContent).toContain(expected.name);
      }
    }
  });

  it('opens exactly the location of the caller clicked, once per click, from a crowded cell', async () => {
    // Two resolved callers whose names are far longer than their column. The
    // chips are clipped inside the cell, and each click still sends exactly the
    // clicked caller's location, once.
    const nearSource: SourceLocation = {
      file: 'src/example/items/list-service.ts',
      line: 88,
      column: 23,
      endLine: 96,
      symbol: 'listExampleItemsForTheCurrentTenant',
      resolvedBy: 'patch',
      confidence: 1,
    };
    const farSource: SourceLocation = { ...BASE_SOURCE };
    const group = makeQueryGroup({
      callers: [
        makeCaller({
          id: 'caller-example-0010',
          name: 'exampleItemsService.listExampleItemsForTheCurrentTenantAndRegion',
          executionCount: 12,
          source: nearSource,
        }),
        makeCaller({
          id: 'caller-example-0011',
          name: 'exampleRepository.loadItemsWithTheirGroupsAndRegionsAcrossPages',
          executionCount: 3,
          source: farSource,
        }),
      ],
    });
    const stub = resolvingProvider([group]);
    const spies = makeActions();
    const user = userEvent.setup();

    // Taken before the render, so a component that added a key to the object
    // in place could not pass.
    const expectedKeys = Object.keys({ ...nearSource }).sort();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const chip = within(dataRow(0)).getByRole('button', {
      name: sourceLinkAccessibleName({ location: nearSource }),
    });

    await user.click(chip);

    // Once, and the resolver's own object: the same reference, the same keys,
    // `endLine` and `resolvedBy` and `confidence` intact.
    const [received] = soleCall(spies.onOpenSource);
    expect(received).toBe(nearSource);
    expect(received).toEqual({
      file: 'src/example/items/list-service.ts',
      line: 88,
      column: 23,
      endLine: 96,
      symbol: 'listExampleItemsForTheCurrentTenant',
      resolvedBy: 'patch',
      confidence: 1,
    });
    expect(Object.keys(received).sort()).toEqual(expectedKeys);

    // A second click is a second request for the same place, nothing more.
    await user.click(chip);

    expect(spies.onOpenSource).toHaveBeenCalledTimes(2);
    expect(spies.onOpenSource.mock.calls.every(([location]) => location === nearSource)).toBe(true);
    expect(spies.onOpenSource.mock.calls.some(([location]) => location === farSource)).toBe(false);

    // The chip's activation stops at the chip.
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(detailRowCount()).toBe(0);
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
    await user.click(screen.getByRole('button', { name: expandRowName(SECOND_STATEMENT) }));

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
    // difference between a bounded list and a wrong one.
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
    // printing a placeholder where a number belongs.
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
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('raises the full error state for a failed further page, and keeps the rows', async () => {
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({
            source: 'queries',
            data: [FIRST_GROUP],
            total: 9,
            nextOffset: 5,
          })
        : Promise.reject(
            new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.', {
              hint: 'Start the local service and reconnect.',
            }),
          ),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // A failed second page gets the same error contract as a failed first page:
    // an alert carrying the rejection's message, hint and code.
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-query-table__error')).toBe(true);
    expect(alert.textContent).toContain('Could not load the next page');
    expect(alert.textContent).toContain(PAGE_FAILURE_LEAD);
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('Start the local service and reconnect.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query shown is the one that FAILED — the second page, at the offset
    // the service reported — not the first page that succeeded.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'queries',
      sort: SLOWEST_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: 5,
    });

    // The rows already read stay on screen, and the failure is never dressed as
    // an empty result. A failed page reports no total, so the footer states only
    // the count it holds, and offers no page past the failure.
    expect(screen.getByRole('grid')).toBeDefined();
    expect(collapsedStatements()).toEqual([oneLinePreview(STATEMENT)]);
    expect(screen.getByText(`Showing ${formatCount(1)} statements`)).toBeDefined();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // The retry re-issues exactly the failed request: the same page, at the
    // same offset — never the first page again and never a derived offset.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    await user.click(within(alert).getByRole('button', { name: RETRY_PAGE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3)).toEqual(queryOfCall(stub, 2));
    expect(queryOfCall(stub, 3).offset).toBe(5);
  });

  it.each<[string, number, number]>([
    ['repeats', 0, 0],
    ['rewinds', 10, 3],
  ])(
    'offers no Load More for a next offset that %s the current page',
    async (_movement, offset, nextOffset) => {
      // Following a counter that does not move forward would re-request — and
      // re-append — the rows already on screen, so paging stops there.
      const stub = resolvingProvider([FIRST_GROUP], { total: 20, nextOffset });

      renderComponent(pagedNode({ offset }), {
        provider: stub.provider,
        actions: makeActions().actions,
      });

      await screen.findByRole('grid');
      expect(dataRows()).toHaveLength(1);
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
      expect(soleQuery(stub).offset).toBe(offset);
    },
  );

  it.each<[string, number, number]>([
    ['a fractional limit truncated', 7.9, 7],
    ['an oversized limit capped at the ceiling', DATA_QUERY_MAX_LIMIT + 1, DATA_QUERY_MAX_LIMIT],
    ['a negative limit floored at zero', -3, 0],
  ])('requests %s', async (_description, authored, sent) => {
    const stub = resolvingProvider([]);

    renderComponent(pagedNode({ limit: authored }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await waitFor(() => {
      expect(stub.resolve).toHaveBeenCalledTimes(1);
    });
    expect(soleQuery(stub).limit).toBe(sent);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Empty pages and count-only queries
 *
 * An empty page is not an empty capture. `limit: 0` is a legal request for a
 * total without rows, and an offset past the end is an empty page rather than
 * an error (`packages/panel-schema/src/nodes/query.ts`), so a successful request
 * that put no rows on screen says what it actually means, shows the total the
 * provider counted, and pages only along a forward `nextOffset`. Only a capture
 * that holds nothing keeps the component's "nothing captured" copy.
 * ---------------------------------------------------------------------------
 */

/** The first line of the count-only empty state. */
const COUNT_ONLY_TITLE = 'Count only';

/** The first line of an empty page whose capture is not known to be empty. */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/** The first line of the empty capture, the one empty state that carries a glyph. */
const NOTHING_CAPTURED_TITLE = 'No queries';

/** The paging fields a case authors on its node's query. */
interface AuthoredPaging {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A `queryTable` node reading the `queries` source with the given paging.
 *
 * @param paging The `limit` and `offset` to author; omitted ones stay unset.
 * @returns A fresh node.
 */
function pagedNode(paging: AuthoredPaging): QueryTableNode {
  return makeNode({ query: { source: 'queries', sort: SLOWEST_FIRST, ...paging } });
}

/** An empty state as rendered: its container and its first line, if any. */
interface RenderedEmptyState {
  readonly box: HTMLElement;
  readonly title: string | null;
}

/**
 * The empty state carrying exactly `message`, once the query has settled.
 *
 * @param message The empty state's full message.
 * @returns Its container, checked to be this component's empty state, and its title.
 */
async function findEmptyState(message: string): Promise<RenderedEmptyState> {
  const text = await screen.findByText(message);
  expect(text.classList.contains('dg-empty-state__message')).toBe(true);

  const box = text.closest<HTMLElement>('.dg-empty-state');

  if (box === null) {
    throw new Error('the message is not inside an empty state');
  }

  expect(box.classList.contains('dg-query-table__empty')).toBe(true);

  return { box, title: box.querySelector('.dg-empty-state__title')?.textContent ?? null };
}

describe('QueryTable empty pages and count-only queries', () => {
  it('sends an explicit limit of zero and shows the count it asked for, without paging', async () => {
    // A zero-size page echoes a `nextOffset` equal to its own offset. Following
    // it would request the same page forever, so a count-only query never pages.
    const stub = resolvingProvider([], { total: 42, nextOffset: DATA_QUERY_DEFAULT_OFFSET });

    renderComponent(pagedNode({ limit: 0 }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const empty = await findEmptyState(
      `This view requests a count without rows: ${formatCount(42)} queries matched its query.`,
    );
    expect(empty.title).toBe(COUNT_ONLY_TITLE);

    // Zero is sent as zero — never raised to a row the node did not ask for —
    // and it is the only request made.
    const sent = soleQuery(stub);
    expect(sent.limit).toBe(0);
    expect(sent.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE_PATTERN)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('agrees the count-only noun with a total of one', async () => {
    const stub = resolvingProvider([], { total: 1 });

    renderComponent(pagedNode({ limit: 0 }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const empty = await findEmptyState(
      `This view requests a count without rows: ${formatCount(1)} query matched its query.`,
    );
    expect(empty.title).toBe(COUNT_ONLY_TITLE);
  });

  it('says a count-only query reported no total, and never pages it', async () => {
    // Even a forward-looking counter is not followed: a page size of zero has
    // no next page to read.
    const stub = resolvingProvider([], { nextOffset: 5 });

    renderComponent(pagedNode({ limit: 0 }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const empty = await findEmptyState(
      'This view requests a count without rows, and no total was reported for its query.',
    );
    expect(empty.title).toBe(COUNT_ONLY_TITLE);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(soleQuery(stub).limit).toBe(0);
  });

  it.each<[number, number]>([
    [200, 42],
    [42, 42],
  ])('says a page at offset %i starts past the end of a total of %i', async (offset, total) => {
    const stub = resolvingProvider([], { total });

    renderComponent(pagedNode({ offset }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const empty = await findEmptyState(
      `This page starts at position ${formatCount(offset + 1)}, past the end of the ${formatCount(total)} queries that matched this query.`,
    );
    expect(empty.title).toBe(EMPTY_PAGE_TITLE);

    // The authored offset is what was asked for, at the default page size.
    const sent = soleQuery(stub);
    expect(sent.offset).toBe(offset);
    expect(sent.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    expect(screen.queryByText(EMPTY_MESSAGE_PATTERN)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it.each<[number, string]>([
    [3, 'queries'],
    [1, 'query'],
  ])('says an empty page inside a total of %i %s is not an empty capture', async (total, noun) => {
    const stub = resolvingProvider([], { total });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const empty = await findEmptyState(
      `${formatCount(total)} ${noun} matched this query, but none are shown on this page.`,
    );
    expect(empty.title).toBe(EMPTY_PAGE_TITLE);
    expect(screen.queryByText(EMPTY_MESSAGE_PATTERN)).toBeNull();
  });

  it('names the position of an empty later page when no total was reported', async () => {
    const stub = resolvingProvider([]);

    renderComponent(pagedNode({ offset: 50 }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const empty = await findEmptyState(
      `This page starts at position ${formatCount(51)} and holds no queries; no total was reported for this query.`,
    );
    expect(empty.title).toBe(EMPTY_PAGE_TITLE);
    expect(screen.queryByText(EMPTY_MESSAGE_PATTERN)).toBeNull();
  });

  it('keeps the nothing-captured copy when the provider counted zero, at any offset', async () => {
    const stub = resolvingProvider([], { total: 0 });

    renderComponent(pagedNode({ offset: 200 }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const message = await screen.findByText(EMPTY_MESSAGE_PATTERN);
    const box = message.closest<HTMLElement>('.dg-empty-state');

    expect(box?.classList.contains('dg-query-table__empty')).toBe(true);
    expect(screen.queryByText(EMPTY_PAGE_TITLE)).toBeNull();
    expect(screen.queryByText(COUNT_ONLY_TITLE)).toBeNull();

    // The empty capture reads like every other view's: its own short title, a
    // decorative glyph, and the polite settled status — never the busy one.
    expect(box?.querySelector('.dg-empty-state__title')?.textContent).toBe(NOTHING_CAPTURED_TITLE);
    expect(box?.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('status')).toBe(box);
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
  });

  it('keeps Load More on an empty page the provider says is followed by another', async () => {
    const stub = pagingProvider([
      { data: [], total: 9, nextOffset: 5 },
      { data: [FIRST_GROUP], total: 9 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const empty = await findEmptyState(
      `${formatCount(9)} queries matched this query, but none are shown on this page.`,
    );
    expect(empty.title).toBe(EMPTY_PAGE_TITLE);

    await user.click(within(empty.box).getByRole('button', { name: LOAD_MORE_NAME }));

    // Exactly the offset the service reported, and the rows it holds.
    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).offset).toBe(5);

    await screen.findByRole('grid');
    expect(collapsedStatements()).toEqual([oneLinePreview(STATEMENT)]);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('claims no empty capture for a first page followed by another when no total was reported', async () => {
    const stub = resolvingProvider([], { nextOffset: 5 });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const empty = await findEmptyState(
      `This page starts at position ${formatCount(1)} and holds no queries; no total was reported for this query.`,
    );
    expect(empty.title).toBe(EMPTY_PAGE_TITLE);
    expect(within(empty.box).getByRole('button', { name: LOAD_MORE_NAME })).toBeDefined();
    expect(screen.queryByText(EMPTY_MESSAGE_PATTERN)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Keyboard-reachable descriptions
 *
 * Every tooltip in this view carries text a reader needs — the whole statement
 * behind an abbreviated preview, and the meaning of a bare count — so every
 * trigger must open by keyboard focus as well as by hover (WCAG 2.1.1). Each
 * trigger sits inside the grid, whose single Tab stop is the active row, so it
 * is focusable but out of the Tab order (`tabIndex={-1}`) and the grid's arrow
 * keys are what move focus onto it. The cases below move real focus onto each
 * trigger, follow its `aria-describedby` to the bubble it announces, and check
 * that the triggers add no control: a trigger is described, never operated.
 * ---------------------------------------------------------------------------
 */

/**
 * The sentence the caller-count tooltip carries, spelled out so this suite pins
 * the explanation a reader hears beside a bare number.
 */
const CALLER_COUNT_TOOLTIP = 'How many of this statement’s executions came from this location.';

/**
 * The aggregate's "no readable statement" key, typed against its upstream
 * declaration so a changed spelling fails to compile here rather than letting
 * this case silently test an ordinary statement.
 */
const UNKNOWN_STATEMENT: typeof import('@debuggen/telemetry').UNKNOWN_STATEMENT_KEY =
  '(unknown statement)';

/** The state class `Tooltip` writes on its bubble while the bubble is shown. */
const OPEN_BUBBLE_CLASS = 'dg-is-open';

/**
 * The utility class `Tooltip` writes on its bubble while the bubble is closed,
 * together with the `hidden` attribute: the bubble stays mounted, so the
 * trigger's `aria-describedby` always resolves, but it is out of rendering and
 * out of the accessibility tree, so no role query finds it.
 */
const CLOSED_BUBBLE_CLASS = 'dg-visually-hidden';

/**
 * Every element focus can land on inside the grid: a native control or
 * anything carrying a `tabindex` — the same set `../primitives/DataTable`'s
 * arrow keys walk. A data row carries a `tabindex` of its own, so a case that
 * means "the controls inside a row" searches the row's cells, not the row.
 */
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

/** The user-event instance a case drives its keyboard with. */
type KeyboardUser = ReturnType<typeof userEvent.setup>;

/**
 * The one element matching `selector` inside `scope`, failing on any other count.
 *
 * @param scope The element to search within.
 * @param selector A CSS selector.
 * @returns The single match.
 */
function soleMatch(scope: ParentNode, selector: string): HTMLElement {
  const matches = [...scope.querySelectorAll<HTMLElement>(selector)];
  const [only] = matches;

  if (only === undefined || matches.length !== 1) {
    throw new Error(`expected exactly one "${selector}", found ${String(matches.length)}`);
  }

  return only;
}

/**
 * The tooltips a trigger announces, resolved the way an assistive technology
 * resolves them: through the ids in its `aria-describedby`. Every id it names
 * must resolve — a description pointing at nothing is a defect in itself.
 *
 * @param trigger The described element.
 * @returns The `role="tooltip"` elements among its descriptions, possibly none.
 */
function describingTooltips(trigger: HTMLElement): HTMLElement[] {
  const described = (trigger.getAttribute('aria-describedby') ?? '')
    .split(/\s+/u)
    .filter((id) => id.length > 0)
    .map((id) => document.getElementById(id));

  expect(described).not.toContain(null);

  return described.filter(
    (element): element is HTMLElement => element?.getAttribute('role') === 'tooltip',
  );
}

/**
 * The one tooltip a trigger announces.
 *
 * `Tooltip` mounts its bubble for the trigger's whole life, so this resolves
 * whether the bubble is shown or not, and it is the same element across every
 * open and close; {@link isShown} says which state it is in.
 *
 * @param trigger The described element.
 * @returns The single `role="tooltip"` element among its descriptions.
 */
function describingTooltip(trigger: HTMLElement): HTMLElement {
  const bubbles = describingTooltips(trigger);
  const [only] = bubbles;

  if (only === undefined || bubbles.length !== 1) {
    throw new Error(`expected exactly one describing tooltip, found ${String(bubbles.length)}`);
  }

  return only;
}

/**
 * Whether a tooltip bubble is currently shown.
 *
 * Shown means all three of `Tooltip`'s open-state markers at once: the bubble
 * is in the document, it no longer carries the `hidden` attribute that keeps a
 * closed bubble out of the accessibility tree, and it carries the open class.
 *
 * @param bubble The `role="tooltip"` element.
 * @returns `true` while `Tooltip` holds it open.
 */
function isShown(bubble: HTMLElement): boolean {
  return bubble.isConnected && !bubble.hidden && bubble.classList.contains(OPEN_BUBBLE_CLASS);
}

/**
 * Asserts that a trigger is described but shows no description right now.
 *
 * Its `aria-describedby` still names a mounted bubble — the description always
 * resolves — and every bubble it names is closed the way `Tooltip` closes one:
 * the `hidden` attribute and the visually-hidden utility, no open class, and so
 * no presence in the accessibility tree for a role query to find.
 *
 * @param trigger The described element.
 */
function expectNoneShown(trigger: HTMLElement): void {
  const bubbles = describingTooltips(trigger);

  expect(bubbles.length).toBeGreaterThan(0);

  for (const bubble of bubbles) {
    expect(isShown(bubble)).toBe(false);
    expect(bubble.isConnected).toBe(true);
    expect(bubble.hidden).toBe(true);
    expect(bubble.classList.contains(CLOSED_BUBBLE_CLASS)).toBe(true);
    expect(bubble.classList.contains(OPEN_BUBBLE_CLASS)).toBe(false);
  }

  expect(screen.queryAllByRole('tooltip').filter((bubble) => bubbles.includes(bubble))).toEqual([]);
}

/**
 * The text of every tooltip inside `scope`, each opened the way a keyboard
 * reader opens it — focus arriving on its trigger — read, and closed again.
 *
 * A closed bubble is in the document but `hidden`, out of the accessibility
 * tree and of every role query, so a reader receives its text only once it
 * opens. This reads each one in that state, without moving the reader's real
 * focus, and counts only a bubble that actually opened.
 *
 * @param scope The element whose tooltips to read.
 * @returns One text per tooltip that opened, in document order.
 */
function openedTooltipTexts(scope: HTMLElement): string[] {
  return [...scope.querySelectorAll<HTMLElement>('.dg-tooltip__trigger > *')].flatMap((trigger) => {
    fireEvent.focus(trigger);
    const texts = describingTooltips(trigger)
      .filter((bubble) => isShown(bubble))
      .map((bubble) => bubble.textContent ?? '');
    fireEvent.blur(trigger);

    return texts;
  });
}

/**
 * Drives one trigger through the whole keyboard contract of a tooltip inside
 * the grid: it is focusable but out of the Tab order, it is described at all
 * times by one mounted bubble carrying exactly `description` and shown only
 * while open, focus opens that bubble at once, the first Escape dismisses it
 * without taking focus away, the second returns focus to the data row the
 * trigger belongs to, and leaving the trigger closes the bubble — after which
 * focus opens it again.
 *
 * It also pins what the trigger is NOT: no role, no accessible name of its own
 * and no enclosing control, so the visible figure or preview is what is read
 * and the bubble is its description.
 *
 * @param user The user-event instance of the case.
 * @param trigger The tooltip's trigger element.
 * @param description The exact text its bubble must carry.
 * @param row The data row the trigger belongs to — for a trigger in an open
 * detail row, the data row that detail discloses.
 */
async function expectKeyboardDisclosure(
  user: KeyboardUser,
  trigger: HTMLElement,
  description: string,
  row: HTMLElement,
): Promise<void> {
  // Focusable, and reached by the grid's arrow keys rather than by Tab: the
  // grid is one Tab stop, its active row.
  expect(trigger.getAttribute('tabindex')).toBe('-1');
  expect(trigger.tabIndex).toBe(-1);
  expect(trigger.getAttribute('role')).toBeNull();
  expect(trigger.getAttribute('aria-label')).toBeNull();
  expect(trigger.closest('button, [role="button"]')).toBeNull();

  // At rest the trigger is already described — its bubble is mounted, carries
  // exactly the description and resolves through `aria-describedby` — but none
  // is shown, so nothing is in the accessibility tree yet.
  const bubble = describingTooltip(trigger);

  expect(bubble.textContent).toBe(description);
  expectNoneShown(trigger);

  act(() => {
    trigger.focus();
  });

  expect(document.activeElement).toBe(trigger);
  expect(describingTooltip(trigger)).toBe(bubble);
  expect(isShown(bubble)).toBe(true);

  // Shown, it is in the accessibility tree: the role query that finds no
  // closed bubble finds this one.
  expect(screen.getAllByRole('tooltip')).toContain(bubble);

  // Escape belongs to the open bubble first, and dismisses the description
  // rather than the reader's place.
  await user.keyboard('{Escape}');

  expectNoneShown(trigger);
  expect(document.activeElement).toBe(trigger);

  // With nothing left to dismiss, the next Escape is the grid's: back to the
  // row, which closes nothing and leaves the bubble closed.
  await user.keyboard('{Escape}');

  expect(document.activeElement).toBe(row);
  expectNoneShown(trigger);

  // Leaving clears the dismissal, so the next arrival opens it again — the same
  // bubble, never a remounted one — and the next departure closes it.
  act(() => {
    trigger.focus();
  });

  expect(describingTooltip(trigger)).toBe(bubble);
  expect(bubble.textContent).toBe(description);
  expect(isShown(bubble)).toBe(true);

  act(() => {
    trigger.blur();
  });

  expectNoneShown(trigger);
  expect(describingTooltip(trigger)).toBe(bubble);
}

describe('QueryTable keyboard-reachable descriptions', () => {
  it('opens the whole statement behind an abbreviated preview on keyboard focus', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const header = within(dataRow(0)).getByRole('rowheader');
    const preview = soleMatch(header, 'code.dg-query-table__statement');

    // The preview is abbreviated — the premise of the tooltip — and the bubble
    // carries the received statement byte for byte, not a re-derived form.
    expect(preview.textContent).toBe(oneLinePreview(STATEMENT));
    expect(preview.textContent).not.toBe(STATEMENT);

    await expectKeyboardDisclosure(user, preview, STATEMENT, dataRow(0));

    // Reached by the grid's keys, straight after the row's disclosure control,
    // which is the order a keyboard reader walks the cell in: F2 moves into the
    // row without opening it, onto its first control, and ArrowRight moves on to
    // the preview, whose arrival opens the description. The bubble is mounted
    // for the preview's whole life, so it is the same element before and after
    // that arrival; only whether it is shown changes.
    const toggle = within(header).getByRole('button', { name: EXPAND_ROW_NAME });
    const bubble = describingTooltip(preview);

    act(() => {
      dataRow(0).focus();
    });
    await user.keyboard('{F2}');

    expect(document.activeElement).toBe(toggle);
    expect(detailRowCount()).toBe(0);
    expectNoneShown(preview);

    await user.keyboard('{ArrowRight}');

    expect(document.activeElement).toBe(preview);
    expect(describingTooltip(preview)).toBe(bubble);
    expect(isShown(bubble)).toBe(true);
    expect(bubble.textContent).toBe(STATEMENT);

    // Focus displays; it never transforms.
    expect(preview.textContent).toBe(oneLinePreview(STATEMENT));
  });

  it('explains the row-count column on keyboard focus, reported or not', async () => {
    const unreported = makeQueryGroup({
      id: 'query-example-0003',
      statement: SECOND_STATEMENT,
      normalizedStatement: SECOND_STATEMENT,
      totalRowCount: undefined,
    });
    const stub = resolvingProvider([FIRST_GROUP, unreported]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const figures = [formatCount(DEFAULT_ROW_COUNT), NOT_AVAILABLE_LABEL];

    for (const [index, figure] of figures.entries()) {
      const cell = soleMatch(dataRow(index), 'code.dg-query-table__rows');

      expect(cell.textContent).toBe(figure);

      await expectKeyboardDisclosure(user, cell, ROW_COUNT_TOOLTIP, dataRow(index));
    }
  });

  it('explains every caller execution count on keyboard focus', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const callers = [...dataRow(0).querySelectorAll<HTMLElement>('.dg-query-table__caller')];

    // Both callers — the one that resolved to a chip and the one that did not —
    // carry a count, and each count is reachable on its own.
    expect(callers).toHaveLength(FIRST_GROUP.callers.length);

    for (const [index, caller] of callers.entries()) {
      const expected = FIRST_GROUP.callers[index];

      if (expected === undefined) {
        throw new Error(`the fixture group carries no caller at index ${String(index)}`);
      }

      const count = soleMatch(caller, '.dg-badge');

      expect(count.textContent).toBe(formatCount(expected.executionCount));

      await expectKeyboardDisclosure(user, count, CALLER_COUNT_TOOLTIP, dataRow(0));
    }
  });

  it('explains the row count of every execution in an expanded row on keyboard focus', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    const detail = detailRow();
    const executions = [...detail.querySelectorAll<HTMLElement>('.dg-query-table__occurrence-row')];

    expect(executions).toHaveLength(FIRST_GROUP.occurrences.length);

    for (const [index, execution] of executions.entries()) {
      const rowCount = FIRST_GROUP.occurrences[index]?.rowCount;

      if (rowCount === undefined) {
        throw new Error(`the fixture execution at index ${String(index)} reports no row count`);
      }

      const cell = soleMatch(execution, 'code.dg-query-table__rows');

      expect(cell.textContent).toBe(formatCount(rowCount));

      // Escape from a control in the open detail returns to the data row that
      // detail discloses.
      await expectKeyboardDisclosure(user, cell, ROW_COUNT_TOOLTIP, dataRow(0));
    }

    // The expanded statement blocks leave the Tab order too — overriding the
    // scrollable-box default their primitive gives them — and stay focusable,
    // so the grid's arrow keys reach them and a block that overflows still
    // scrolls from the keyboard once focused.
    const blocks = statementBlocks(detail);

    expect(blocks).toHaveLength(2);

    for (const block of blocks) {
      expect(block.getAttribute('tabindex')).toBe('-1');
      expect(block.tabIndex).toBe(-1);
    }

    expect(blocks[0]?.textContent).toBe(STATEMENT);
    expect(blocks[1]?.textContent).toBe(NORMALIZED_STATEMENT);
  });

  it('adds no focus stop where there is nothing to disclose', async () => {
    const whole = makeQueryGroup({
      id: 'query-example-0004',
      statement: SECOND_STATEMENT,
      normalizedStatement: SECOND_STATEMENT,
    });
    const unknown = makeQueryGroup({
      id: 'query-example-0005',
      statement: UNKNOWN_STATEMENT,
      normalizedStatement: UNKNOWN_STATEMENT,
    });
    const stub = resolvingProvider([whole, unknown]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // A preview that is already the whole statement: no tooltip, so no stop and
    // no description that would repeat what is on screen.
    expect(oneLinePreview(SECOND_STATEMENT)).toBe(SECOND_STATEMENT);

    const wholeHeader = within(dataRow(0)).getByRole('rowheader');
    const wholeStatement = soleMatch(wholeHeader, 'code.dg-query-table__statement');

    expect(wholeStatement.textContent).toBe(SECOND_STATEMENT);
    expect(wholeStatement.getAttribute('tabindex')).toBeNull();
    expect(wholeStatement.getAttribute('aria-describedby')).toBeNull();

    // Counted in the DOM rather than by role: a closed bubble is `hidden` and no
    // role query finds it, so only this proves that no tooltip — shown or
    // closed — was rendered here at all.
    expect(wholeHeader.querySelectorAll('[role="tooltip"]')).toHaveLength(0);

    // The aggregate's word for an absence is prose, never code, and carries no
    // tooltip either — so the disclosure control is the header's only stop.
    const unknownHeader = within(dataRow(1)).getByRole('rowheader');

    expect(unknownHeader.querySelector('code')).toBeNull();
    expect(within(unknownHeader).getByText(UNKNOWN_STATEMENT)).toBeDefined();
    expect(unknownHeader.querySelectorAll('[role="tooltip"]')).toHaveLength(0);

    // Precisely: neither header adds a Tab stop, and each holds exactly one
    // element the grid's arrow keys can land on — its disclosure control, named
    // by the statement text the header shows, prose included.
    const headers: readonly (readonly [HTMLElement, string])[] = [
      [wholeHeader, SECOND_STATEMENT],
      [unknownHeader, UNKNOWN_STATEMENT],
    ];

    for (const [header, statement] of headers) {
      expect(header.querySelectorAll('[tabindex="0"]')).toHaveLength(0);

      const focusable = [...header.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const toggle = within(header).getByRole('button', { name: expandRowName(statement) });

      expect(focusable).toEqual([toggle]);
      expect(toggle.tabIndex).toBe(-1);
    }
  });

  it('adds focus stops without adding a control or disturbing the row keys', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    // The control surface is exactly the one the privacy case pins: every new
    // stop is a described element, never a button.
    expect(controlNames()).toEqual(
      [
        EXECUTIONS_SORT_NAME,
        TOTAL_TIME_SORT_NAME,
        EXPAND_ROW_NAME,
        expandRowName(SECOND_STATEMENT),
        SOURCE_CHIP_NAME,
        SOURCE_CHIP_NAME,
      ].sort(),
    );

    // A key pressed on a control inside a row never activates the row: Enter
    // and Space on a focused count expand nothing, select nothing, open nothing
    // and leave focus where the reader put it.
    const count = soleMatch(dataRow(0), 'code.dg-query-table__rows');
    const preview = soleMatch(
      within(dataRow(0)).getByRole('rowheader'),
      'code.dg-query-table__statement',
    );

    act(() => {
      count.focus();
    });
    await user.keyboard('{Enter}{ }');

    expect(document.activeElement).toBe(count);
    expect(detailRowCount()).toBe(0);
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    // The arrows are the grid's cell navigation: ArrowLeft moves to the previous
    // focusable element of the row — here the abbreviated statement, since the
    // system, execution and timing cells hold nothing focusable — and ArrowLeft
    // from the row's first control, its disclosure toggle, returns to the row.
    await user.keyboard('{ArrowLeft}');

    expect(document.activeElement).toBe(preview);

    await user.keyboard('{ArrowLeft}');

    expect(document.activeElement).toBe(
      within(dataRow(0)).getByRole('button', { name: EXPAND_ROW_NAME }),
    );

    await user.keyboard('{ArrowLeft}');

    expect(document.activeElement).toBe(dataRow(0));

    // ArrowDown on a control moves to the next row, counted from the row the
    // control belongs to, and the roving stop goes with it.
    act(() => {
      count.focus();
    });
    await user.keyboard('{ArrowDown}');

    expect(document.activeElement).toBe(dataRow(1));
    expect(dataRow(1).tabIndex).toBe(0);
    expect(dataRow(0).tabIndex).toBe(-1);

    // Still nothing was expanded, selected or opened by any of it.
    expect(detailRowCount()).toBe(0);
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    // And the rows still answer their own keys: the grid's navigation is intact.
    await user.keyboard('{ArrowUp}');

    expect(document.activeElement).toBe(dataRow(0));

    // Opening a row adds the executions' own controls and nothing else, as the
    // privacy case pins for a single row.
    await user.click(within(dataRow(0)).getByRole('button', { name: EXPAND_ROW_NAME }));

    const occurrenceNames = FIRST_GROUP.occurrences.map(
      (occurrence) =>
        `Select the execution at +${formatOffset(occurrence.startTime, FIRST_GROUP.firstStartTime)}`,
    );

    expect(controlNames()).toEqual(
      [
        EXECUTIONS_SORT_NAME,
        TOTAL_TIME_SORT_NAME,
        COLLAPSE_ROW_NAME,
        expandRowName(SECOND_STATEMENT),
        SOURCE_CHIP_NAME,
        SOURCE_CHIP_NAME,
        ...occurrenceNames,
      ].sort(),
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * One Tab stop, row-identifying names and a live count
 *
 * The table follows the grid pattern: the whole grid is ONE stop in the page's
 * Tab order — the active row — and every control a cell or an open detail row
 * renders is reached by the grid's own keys instead. A disclosure toggle names
 * the row it opens and reports its state itself, because a `grid` row cannot
 * carry `aria-expanded`; and the sentence saying how much of the result is on
 * screen is announced when paging changes it.
 * ---------------------------------------------------------------------------
 */

/**
 * The elements in `scope` a Tab key can land on: those whose `tabindex` is `0`.
 * Nothing this view renders carries a positive index.
 *
 * @param scope The element to search within.
 * @returns The Tab stops, in document order.
 */
function tabStopsIn(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('[tabindex="0"]')];
}

/**
 * Asserts the grid is one Tab stop: `active` is the only element in it with a
 * `tabindex` of `0`, and every other element focus can land on inside it — the
 * other rows, the header's sort controls and every control of every cell and
 * open detail — is focusable but out of the Tab order.
 *
 * @param grid The grid element.
 * @param active The data row that should hold the roving stop.
 */
function expectSingleTabStop(grid: HTMLElement, active: HTMLElement): void {
  expect(tabStopsIn(grid)).toEqual([active]);

  const others = [...grid.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element !== active,
  );

  expect(others.length).toBeGreaterThan(0);

  for (const element of others) {
    expect(element.tabIndex).toBe(-1);
  }
}

/**
 * A group whose one carried execution resolved to source, so an open row also
 * renders that execution's own chip beside its selector and row-count trigger.
 */
const SOURCED_GROUP = makeQueryGroup({
  occurrences: [
    makeOccurrence({
      startTime: BASE_START_MS + 12,
      durationMs: 104,
      rowCount: 24,
      source: BASE_SOURCE,
    }),
  ],
});

describe('QueryTable grid keyboard model and names', () => {
  it('keeps the whole grid one Tab stop before and after focus moves inside it', async () => {
    const stub = resolvingProvider([SOURCED_GROUP, SECOND_GROUP]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid');

    // Before anything is focused: the first row is the stop, and every chip,
    // toggle, trigger and header control is out of the Tab order.
    expectSingleTabStop(grid, dataRow(0));

    // An open row brings the detail's own controls — the statement blocks, the
    // execution's selector, its row-count trigger and its source chip — and
    // none of them adds a stop either.
    await user.click(within(dataRow(0)).getByRole('button', { name: EXPAND_ROW_NAME }));

    expect(within(detailRow()).getByRole('button', { name: OCCURRENCE_CHIP_NAME })).toBeDefined();
    expectSingleTabStop(grid, dataRow(0));

    // Focus landing on a control in another row moves the roving stop to that
    // row, so Tab back into the grid returns to where the reader last was — and
    // the grid is still exactly one stop.
    const chip = within(dataRow(1)).getByRole('button', { name: SOURCE_CHIP_NAME });

    act(() => {
      chip.focus();
    });

    expect(document.activeElement).toBe(chip);
    expectSingleTabStop(grid, dataRow(1));
  });

  it('enters the grid on the active row with Tab and leaves it with the next Tab', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER, { total: 9, nextOffset: 2 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const order = screen.getByRole('combobox', { name: ORDER_CONTROL_NAME });
    const loadMore = screen.getByRole('button', { name: LOAD_MORE_NAME });

    // From the control before the grid, one Tab lands on the active row, and the
    // next leaves for the control after it: no chip, count or toggle in between.
    act(() => {
      order.focus();
    });
    await user.tab();

    expect(document.activeElement).toBe(dataRow(0));

    await user.tab();

    expect(document.activeElement).toBe(loadMore);

    // Shift+Tab walks the same single stop back.
    await user.tab({ shift: true });

    expect(document.activeElement).toBe(dataRow(0));

    await user.tab({ shift: true });

    expect(document.activeElement).toBe(order);

    // The stop is where the reader left it: after moving down a row and leaving,
    // Tab returns to that row rather than to the first.
    act(() => {
      dataRow(0).focus();
    });
    await user.keyboard('{ArrowDown}');
    await user.tab();

    expect(document.activeElement).toBe(loadMore);

    await user.tab({ shift: true });

    expect(document.activeElement).toBe(dataRow(1));
  });

  it('walks a row and its open detail with the arrow keys, and Escape returns to the row', async () => {
    const stub = resolvingProvider([SOURCED_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const row = dataRow(0);

    act(() => {
      row.focus();
    });

    // ArrowRight opens a collapsed row first, leaving focus on the row.
    await user.keyboard('{ArrowRight}');

    expect(detailRowCount()).toBe(1);
    expect(document.activeElement).toBe(row);
    expect(soleCall(spies.onExpand)).toEqual([NODE_ID, SOURCED_GROUP.id, true]);

    // The next ArrowRight enters the row on its first control: the toggle, now
    // named for closing and reporting the open state itself.
    await user.keyboard('{ArrowRight}');

    const toggle = within(row).getByRole('button', { name: COLLAPSE_ROW_NAME });

    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // End reaches the last control of the scope — the row and its open detail,
    // in document order — which is the execution's own source chip.
    await user.keyboard('{End}');

    const detail = detailRow();

    expect(document.activeElement).toBe(
      within(detail).getByRole('button', { name: OCCURRENCE_CHIP_NAME }),
    );

    // ArrowLeft steps back through the execution: its row-count trigger, then
    // its selector.
    await user.keyboard('{ArrowLeft}');

    expect(document.activeElement).toBe(
      soleMatch(detail, '.dg-query-table__occurrence-row code.dg-query-table__rows'),
    );

    await user.keyboard('{ArrowLeft}');

    const [occurrence] = SOURCED_GROUP.occurrences;

    if (occurrence === undefined) {
      throw new Error('the sourced fixture group carries no occurrence');
    }

    const selector = within(detail).getByRole('button', {
      name: `Select the execution at +${formatOffset(occurrence.startTime, SOURCED_GROUP.firstStartTime)}`,
    });

    expect(document.activeElement).toBe(selector);

    // Enter on a control is the control's own: it selects the execution, and it
    // neither toggles nor activates the row.
    await user.keyboard('{Enter}');

    expect(soleCall(spies.onSelectEvent)).toEqual([
      { eventId: occurrence.eventId, spanId: occurrence.spanId, traceId: occurrence.traceId },
    ]);
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
    expect(detailRowCount()).toBe(1);

    // ArrowLeft carries on across the detail's statement blocks — the grouping
    // basis, then the received statement — and back into the data row's own
    // controls, arriving on its last: the unresolved caller's execution count.
    const [statementBlock, basisBlock] = statementBlocks(detail);

    await user.keyboard('{ArrowLeft}');

    expect(document.activeElement).toBe(basisBlock);

    await user.keyboard('{ArrowLeft}');

    expect(document.activeElement).toBe(statementBlock);
    expect(statementBlock?.textContent).toBe(STATEMENT);

    await user.keyboard('{ArrowLeft}');

    const callerCounts = [
      ...row.querySelectorAll<HTMLElement>('.dg-query-table__caller .dg-badge'),
    ];

    expect(document.activeElement).toBe(callerCounts.at(-1));

    // Home jumps to the first control, and Escape from a control with nothing
    // of its own to dismiss returns to the row.
    await user.keyboard('{Home}');

    expect(document.activeElement).toBe(toggle);

    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(row);

    // On the open row, ArrowLeft closes it.
    await user.keyboard('{ArrowLeft}');

    expect(detailRowCount()).toBe(0);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, SOURCED_GROUP.id, false);
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('names each disclosure control by its statement and points it at the open detail row', async () => {
    const unknown = makeQueryGroup({
      id: 'query-example-0006',
      statement: UNKNOWN_STATEMENT,
      normalizedStatement: UNKNOWN_STATEMENT,
    });
    const groups: readonly QueryGroup[] = [FIRST_GROUP, SECOND_GROUP, unknown];
    const stub = resolvingProvider(groups);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // One toggle per row, each named by the statement preview its row header
    // shows, so no two rows share a name.
    const toggles = groups.map((group, index) =>
      within(dataRow(index)).getByRole('button', { name: expandRowName(group.statement) }),
    );

    expect(new Set(toggles.map((toggle) => toggle.getAttribute('aria-label'))).size).toBe(
      groups.length,
    );

    // Spelled out once in full, so the copy itself is pinned and not only the
    // helper that builds it: a whole statement names its row as received, and
    // the aggregate's word for an absence names its row as the header prints it.
    expect(toggles[1]?.getAttribute('aria-label')).toBe(
      `Show the executions of ${SECOND_STATEMENT}`,
    );
    expect(toggles[2]?.getAttribute('aria-label')).toBe(
      `Show the executions of ${UNKNOWN_STATEMENT}`,
    );

    // Collapsed: the toggle reports it, and controls nothing that does not
    // exist. The row itself never reports the state — a `grid` row cannot.
    for (const [index, toggle] of toggles.entries()) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.hasAttribute('aria-controls')).toBe(false);
      expect(dataRow(index).hasAttribute('aria-expanded')).toBe(false);
    }

    await user.click(within(dataRow(0)).getByRole('button', { name: EXPAND_ROW_NAME }));

    // Open: the toggle's `aria-controls` resolves to the detail row the grid
    // rendered for it, and still no row carries `aria-expanded`.
    const open = within(dataRow(0)).getByRole('button', { name: COLLAPSE_ROW_NAME });
    const controlled = document.getElementById(open.getAttribute('aria-controls') ?? '');

    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(controlled).toBe(detailRow());
    expect(dataRow(0).hasAttribute('aria-expanded')).toBe(false);
    expect(toggles[1]?.hasAttribute('aria-controls')).toBe(false);

    // Naming a row by its statement transforms nothing: the element it points
    // at holds the received statement byte for byte, the collapsed cell still
    // shows the package preview, and the cell's description — resolved through
    // the preview's `aria-describedby`, since a closed bubble is `hidden` and no
    // role query finds it — is the exact text, with none of it shown at rest.
    const preview = soleMatch(
      within(dataRow(0)).getByRole('rowheader'),
      'code.dg-query-table__statement',
    );

    expect(statementBlocks(detailRow())[0]?.textContent).toBe(STATEMENT);
    expect(collapsedStatement(dataRow(0))).toBe(oneLinePreview(STATEMENT));
    expect(describingTooltip(preview).textContent).toBe(STATEMENT);
    expectNoneShown(preview);

    // Closed again: `aria-controls` goes with the detail row, so it never names
    // an element that is no longer in the document.
    await user.click(open);

    const closed = within(dataRow(0)).getByRole('button', { name: EXPAND_ROW_NAME });

    expect(detailRowCount()).toBe(0);
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    expect(closed.hasAttribute('aria-controls')).toBe(false);
  });

  it('announces the count of statements on screen through a polite live region', async () => {
    const stub = pagingProvider([
      { data: [FIRST_GROUP], total: 9, nextOffset: 5 },
      { data: [SECOND_GROUP], total: 9, nextOffset: 6 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const count = await screen.findByText(
      `Showing ${formatCount(1)} of ${formatCount(9)} statements`,
    );

    // Polite and atomic: the whole sentence is read once the reader's current
    // speech finishes. A live region rather than `role="status"`, which this
    // view reserves for the first page's loading state.
    expect(count.getAttribute('aria-live')).toBe('polite');
    expect(count.getAttribute('aria-atomic')).toBe('true');
    expect(count.getAttribute('role')).toBeNull();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The SAME element changes its text in place, which is what makes the
    // change an announcement: a region mounted afresh with new text is not.
    await waitFor(() => {
      expect(count.textContent).toBe(`Showing ${formatCount(2)} of ${formatCount(9)} statements`);
    });
    expect(count.isConnected).toBe(true);
    expect(count.getAttribute('aria-live')).toBe('polite');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The panel's shared selection
 *
 * An execution is the one place in this view where a single event exists to
 * select, and it is the same event the timeline, the waterfall and the span
 * table draw. A reader who selects it anywhere must see it marked here — by the
 * row's state class and by its select control's `aria-pressed` — and a reader
 * who selects it here must not be shown a second, contradicting selection
 * while the host holds another one. Outside a host the view marks what it was
 * last activated on.
 * ---------------------------------------------------------------------------
 */

/** The class an execution row carries. */
const OCCURRENCE_ROW_SELECTOR = '.dg-query-table__occurrence-row';

/** A second trace, sharing span ids with the fixture one and nothing else. */
const OTHER_TRACE_ID = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';

/**
 * The component inside the host contexts plus the host's selection holder, as
 * `PanelHost` provides it.
 *
 * @param provider The provider that resolves the node's query.
 * @param actions The actions the component reports to.
 * @param selection What the host currently holds as selected.
 * @returns The element tree.
 */
function selectionTree(
  provider: DataProvider,
  actions: PanelActions,
  selection: PanelSelection | undefined,
): ReactElement {
  return (
    <DataProviderContext.Provider value={provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={actions}>
          <PanelSelectionContext.Provider value={{ selection }}>
            <QueryTable node={makeNode()} />
          </PanelSelectionContext.Provider>
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>
  );
}

/**
 * The select control of one of the first group's executions.
 *
 * @param index The execution's position in the group.
 * @returns Its select button.
 */
function occurrenceButton(index: number): HTMLElement {
  const occurrence = FIRST_GROUP.occurrences[index];
  if (occurrence === undefined) {
    throw new Error(`the fixture group has no execution at ${String(index)}`);
  }
  return screen.getByRole('button', {
    name: `Select the execution at +${formatOffset(occurrence.startTime, FIRST_GROUP.firstStartTime)}`,
  });
}

/**
 * Which of the open row's executions the view marks as selected, by position —
 * and fails when the class and the control's pressed state disagree, because a
 * mark drawn only in colour is not a mark every reader receives.
 *
 * @returns The positions of the marked executions.
 */
function markedOccurrences(): number[] {
  const rows = Array.from(detailRow().querySelectorAll<HTMLElement>(OCCURRENCE_ROW_SELECTOR));
  expect(rows).toHaveLength(FIRST_GROUP.occurrences.length);

  const marked: number[] = [];
  rows.forEach((row, index) => {
    const classed = row.classList.contains('dg-is-selected');
    const pressed = within(row).queryByRole('button')?.getAttribute('aria-pressed');
    if (pressed !== undefined) {
      expect(pressed).toBe(classed ? 'true' : 'false');
    }
    if (classed) {
      marked.push(index);
    }
  });
  return marked;
}

describe('QueryTable shared selection', () => {
  it('marks the execution another view selected, and follows the host as it moves', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();
    const [first, second] = FIRST_GROUP.occurrences;
    if (first === undefined || second === undefined) {
      throw new Error('the fixture group has fewer than two executions');
    }

    const view = render(
      selectionTree(stub.provider, spies.actions, {
        eventId: second.eventId,
        traceId: second.traceId,
        spanId: second.spanId,
      }),
    );

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    // Selected elsewhere, marked here.
    expect(markedOccurrences()).toEqual([1]);
    expect(occurrenceButton(1).getAttribute('aria-pressed')).toBe('true');
    expect(occurrenceButton(0).getAttribute('aria-pressed')).toBe('false');

    // A view that keys the span under another record id still names the same
    // trace and span — the span's identity — so the execution matches.
    view.rerender(
      selectionTree(stub.provider, spies.actions, {
        eventId: 'event-from-another-view',
        traceId: TRACE_ID,
        spanId: first.spanId,
      }),
    );

    expect(markedOccurrences()).toEqual([0]);

    // The same span id in another trace is a different span.
    view.rerender(
      selectionTree(stub.provider, spies.actions, {
        eventId: 'event-from-another-view',
        traceId: OTHER_TRACE_ID,
        spanId: first.spanId,
      }),
    );

    expect(markedOccurrences()).toEqual([]);

    view.rerender(selectionTree(stub.provider, spies.actions, undefined));

    expect(markedOccurrences()).toEqual([]);

    // Following the host is not reporting to it.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('reports an execution to the host and marks only what the host then holds', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    const view = render(selectionTree(stub.provider, spies.actions, undefined));

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));
    await user.click(occurrenceButton(1));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }
    const second = FIRST_GROUP.occurrences[1];
    expect(call[0]).toEqual({
      eventId: second?.eventId,
      spanId: second?.spanId,
      traceId: second?.traceId,
    });

    // The host has not recorded it, so nothing is marked: this view draws the
    // host's selection, never a local copy that could contradict it.
    expect(markedOccurrences()).toEqual([]);

    view.rerender(selectionTree(stub.provider, spies.actions, call[0]));

    expect(markedOccurrences()).toEqual([1]);
  });

  it('marks its own activation when no host holds a selection, one execution at a time', async () => {
    const stub = resolvingProvider([FIRST_GROUP]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: EXPAND_ROW_NAME }));

    expect(markedOccurrences()).toEqual([]);

    await user.click(occurrenceButton(0));
    expect(markedOccurrences()).toEqual([0]);

    await user.click(occurrenceButton(1));
    expect(markedOccurrences()).toEqual([1]);
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(2);
  });
});
