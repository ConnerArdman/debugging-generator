/**
 * `components/EventLog` — the colocated suite for the `eventLog` node.
 *
 * ## What this suite is protecting
 *
 * The log is the view with no opinion: it draws one page of records the
 * coordination service has already filtered, ordered and paged
 * (`POST /sessions/:id/panel-data` applies `filter`, `sort`, `limit` and
 * `offset` and answers with `total` and `nextOffset`; `docs/ARCHITECTURE.md`,
 * "Panel data"), and it says out loud how much of the capture that page covers.
 * Six properties of that contract are mechanical rather than cosmetic, and each
 * has a case below:
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
 *     length of what arrived, which drifts the moment a limit is clamped, and
 *     only forward, so a `nextOffset` that does not move offers no control;
 *   - **the authored page is the one requested** — the sequence starts at the
 *     node's own `offset`, restarts when that offset changes, and the footer
 *     counts from it; an explicit `limit: 0` is sent as zero and never paged;
 *   - **an empty page is not always an empty capture** — a count-only query,
 *     an offset past the end and a page the service left empty each state the
 *     total or position they know, and only a total of zero (or no total from
 *     the first record) reads as "nothing was captured".
 *
 * Two further properties belong to the privacy model (`docs/SECURITY.md`,
 * "Never captured"). Attribute values arrive already redacted, and a preview
 * already bounded to {@link MAX_PREVIEW_LENGTH} characters, so this suite
 * asserts that a preview renders byte-for-byte as supplied — including one that
 * already ends in the upstream truncation marker — that a row showing every
 * value whole offers nothing to expand, and that the compact strip counts what
 * it does not show instead of unpacking a structured summary. A redacted URL or
 * a parameterized statement is not a preview and may be far longer: the strip
 * cuts it, and the suite asserts the whole value stays reachable — in the
 * chip's title and in the row's detail, opened by keyboard or pointer — exactly
 * as it arrived, with structured summaries still counted, never unpacked.
 * Where the host can open a record, the strip's count is also a control, and
 * the only thing it does is select the record for the host's detail drawer:
 * the strip still unpacks nothing.
 *
 * Alongside those, like every component suite here, this one covers the three
 * states of a query-backed view — loading, empty and error — and the
 * click-to-source payload. Each state is driven through a stub `DataProvider`
 * that respectively never settles, resolves an empty page and rejects; the
 * payload cases assert what the host actually receives, because this component
 * is the first hop of the click-to-source chain and every hop after it acts
 * blind on the object it is handed (`docs/ARCHITECTURE.md`, "A click, end to end").
 *
 * ## The case that guards a layering boundary
 *
 * `offers exactly the kinds its data and its node name` is not a test of a
 * picker. `@debuggen/telemetry` is a **type-only** dependency of this package,
 * so the kind vocabulary — a runtime value of that package — may not be
 * imported here. While the loaded page is the whole source, the component
 * discovers its options from the records that arrived plus the kinds the
 * panel's author named, and asks for nothing more; an edit that enumerated a
 * vocabulary instead would offer the whole taxonomy where the capture proves
 * a handful. Asserting the option set *exactly*, and that no count was asked
 * for, is the cheapest place to catch that. Only a page that falls short of
 * its source takes the kind census (the "kind census" cases), whose vocabulary
 * is the one the query filter schema of `@debuggen/panel-schema` admits.
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
 *     for* is as much of its contract as what it drew. The kind census's
 *     count-only requests are routed apart and recorded in their own array,
 *     so the paging cases read the page sequence alone. The provider and
 *     response types are imported from `../host/DataProvider` rather than
 *     restated here: a local copy of that contract would keep compiling after
 *     the real one changed, which is the one drift this suite is meant to
 *     catch.
 *   - **One transparent wrapper**: the code primitive is wrapped to count its
 *     renders (see `codeRenders`), the only observable of the cell cache. It
 *     renders the real primitive, so every DOM assertion reads real output.
 *   - **In-file synthetic builders, no fixture files.** {@link makeEvent} and
 *     {@link makeNode} take overrides; nothing here is read from disk or shared
 *     with another suite.
 *   - **Generic fixture vocabulary only**: record names, attribute keys, a file
 *     path and a symbol that belong to no application, demonstration or
 *     otherwise. The kinds are the product's own taxonomy.
 *     `scripts/check-no-hardcoding.mjs` skips test files, so this suite keeps
 *     the product's neutral vocabulary by convention.
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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  dataQueryFilterSchema,
} from '@debuggen/panel-schema';
import type { DataQuery, EventLogNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { TelemetryEvent, TelemetryKind } from '@debuggen/telemetry';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext, PanelSelectionContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef, PanelSelection } from '../host/PanelActions';
import { Button } from '../primitives/Button';
import type * as CodeModule from '../primitives/Code';
import { kindColorVar } from '../utils/color';
import {
  MAX_PREVIEW_LENGTH,
  NOT_AVAILABLE_LABEL,
  collapseWhitespace,
  containsDirectionControl,
  formatCount,
  formatKindLabel,
  formatOffset,
  formatStatusLabel,
  formatUntrustedText,
  oneLinePreview,
} from '../utils/format';
import { EventLog } from './EventLog';
import { sourceLinkAccessibleName } from './SourceLink';

/**
 * How many times the code primitive — the attribute strip's chip — has
 * rendered.
 *
 * The one observable of the cell cache: a row's cells are built once per row
 * model, so re-rendering the grid over the same rows (a selection, a scroll
 * step of the virtualizer) must not render a chip again. The wrapper renders
 * the real primitive, so every DOM assertion in this suite still reads the
 * real output. Hoisted, because Vitest lifts the `vi.mock` factory above the
 * imports and the factory closes over it.
 */
const codeRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('../primitives/Code', async (importOriginal) => {
  const actual = await importOriginal<typeof CodeModule>();
  const { createElement } = await import('react');

  const Code: typeof actual.Code = (props) => {
    codeRenders.count += 1;

    return createElement(actual.Code, props);
  };

  return { ...actual, Code };
});

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Every string below is application-neutral: no component, route, service or
 * symbol of any inspected project appears here, in the fixtures or in the
 * comments. The identifiers are shaped as a capture shapes them — a 32-hex
 * trace id, 16-hex span ids, epoch-millisecond start times, millisecond
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

/**
 * The control the keyboard cases place after the log, so a Tab can be seen to
 * leave the grid. The toolbar's kind picker is the control just before it.
 */
const AFTER_LOG = 'After the log';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/**
 * The shared error-state contract every query-backed node renders a failure
 * with, spelled out rather than read back from the host's constants, so this
 * suite pins the words a reader actually sees: the title, the generic lead the
 * provider's cause follows, and the focus key the host's node frame uses to
 * restore focus to the retry control after a remount.
 */
const QUERY_FAILURE_TITLE = 'Could not load this view';
const QUERY_FAILURE_LEAD = 'The data for this view could not be loaded.';
const RETRY_FOCUS_KEY = 'error-state-retry';

/** A provider's cause and hint for the shared-contract case. */
const PROVIDER_CAUSE = 'The channel to the service is closed.';
const PROVIDER_HINT = 'Start the Debug Generator service, then retry.';

/** The five column headers, left to right. */
const COLUMN_HEADERS: readonly string[] = ['Seq', 'Offset', 'Kind', 'Name', 'Attributes'];

/** The note that keeps the text filter honest, as the toolbar states it. */
const PARTIAL_SEARCH_NOTE = 'Text filter applies to loaded records only';

/** The control the no-match state offers to undo the text filter. */
const CLEAR_SEARCH_NAME = 'Clear text filter';

/** The heading of the state a count-only (`limit: 0`) query resolves to. */
const COUNT_ONLY_TITLE = 'Count only';

/** The heading of an empty page that is not an empty capture. */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/** The generic substring of the product's own empty-capture copy. */
const EMPTY_CAPTURE_PATTERN = /no records were captured/i;

/**
 * The accessible name of a row's "+N more" control: its visible count, the
 * counted noun, and what pressing it does.
 *
 * @param hidden How many attributes the strip does not show.
 * @returns The name, spelled out.
 */
function moreAttributesName(hidden: number): string {
  return `+${formatCount(hidden)} more ${hidden === 1 ? 'attribute' : 'attributes'}: select this record to see every attribute`;
}

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
   * Every PAGE query the component has asked for, in call order.
   *
   * The assertion surface for the paging and filtering cases: what the
   * component *requested* is as much of its contract as what it rendered. The
   * kind census's count-only requests are recorded apart, in
   * {@link StubProvider.censusQueries}, so a case about the page sequence reads
   * that sequence alone.
   */
  readonly queries: readonly DataQuery[];

  /** The recorded page resolver, for call counts; census requests never reach it. */
  readonly resolve: Mock<DataQueryResolver>;

  /** Every kind-census request the component has sent, in call order. */
  readonly censusQueries: readonly DataQuery[];
}

/**
 * How many records of each kind a stub's source holds, as the component's kind
 * census asks for them. A kind left out holds none.
 */
type CensusCounts = Readonly<Partial<Record<TelemetryKind, number>>>;

/**
 * Whether a query is one of the kind census's count-only requests rather than
 * a page of the log: `limit: 0` from the first record, narrowed to exactly one
 * kind, with no ordering. No page request of these cases has that shape — an
 * authored count-only node names no kind — so the split is exact.
 *
 * @param query A query the component sent.
 * @returns `true` for a census request.
 */
function isCensusQuery(query: DataQuery): boolean {
  return (
    query.limit === 0 &&
    query.offset === DATA_QUERY_DEFAULT_OFFSET &&
    query.sort === undefined &&
    query.filter?.kinds?.length === 1
  );
}

/**
 * The cause a stub with no census rejects census requests with, so every case
 * that is not about the census sees the component's fallback: the picker's
 * options discovered from what loaded.
 */
const CENSUS_UNAVAILABLE = 'This stub answers no kind counts.';

/**
 * A provider whose answers are computed per call.
 *
 * @param respond Called with each page query and the 1-based number of the
 * call.
 * @param census The kind counts census requests are answered with, or
 * `undefined` to reject them.
 * @returns The stub, its recorded queries and its resolver.
 */
function recordingProvider(
  respond: (query: DataQuery, call: number) => Promise<DataQueryResponse>,
  census?: CensusCounts,
): StubProvider {
  const queries: DataQuery[] = [];
  const censusQueries: DataQuery[] = [];
  const resolve = vi.fn<DataQueryResolver>((query) => {
    queries.push(query);

    return respond(query, queries.length);
  });
  const route: DataQueryResolver = (query, context) => {
    if (!isCensusQuery(query)) {
      return resolve(query, context);
    }

    censusQueries.push(query);

    const kind = query.filter?.kinds?.[0];

    if (census === undefined || kind === undefined) {
      return Promise.reject(new DebuggenError('TRANSPORT_DISCONNECTED', CENSUS_UNAVAILABLE));
    }

    return Promise.resolve<DataQueryResponse>({
      source: 'events',
      data: [],
      total: census[kind] ?? 0,
    });
  };

  return { provider: createDataProvider(route), queries, resolve, censusQueries };
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
 * @param census The kind counts census requests are answered with, or
 * `undefined` to reject them.
 * @returns The stub provider.
 */
function pagingProvider(
  source: EventLogSource,
  pages: readonly EventPage[],
  census?: CensusCounts,
): StubProvider {
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
  }, census);
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
 * @returns A function that re-renders the same mounted component, inside the
 * same contexts, with another node — how a host hands an existing panel slot a
 * changed specification, and what the page-sequence reset cases drive.
 */
function renderComponent(
  node: EventLogNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): (next: EventLogNode) => void {
  const tree = (current: EventLogNode): ReactElement => (
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <EventLog node={current} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>
  );
  const { rerender } = render(tree(node));

  return (next: EventLogNode): void => {
    rerender(tree(next));
  };
}

/**
 * Renders the component followed by an ordinary control, for the keyboard
 * cases: a Tab leaving the grid is only observable against something after it.
 *
 * @param node The node to draw.
 * @param context The provider to resolve its query and the actions to report to.
 */
function renderBeforeControl(
  node: EventLogNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <>
      <DataProviderContext.Provider value={context.provider}>
        <PanelSessionContext.Provider value={SESSION_ID}>
          <PanelActionsContext.Provider value={context.actions}>
            <EventLog node={node} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
      <Button>{AFTER_LOG}</Button>
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
 * The data row at a 0-based position of the whole result, found by the index
 * the primitive writes on it rather than by document order — under
 * virtualization only a window of the rows is mounted.
 *
 * @param index The row's position in the result.
 * @returns That row.
 */
function rowAtIndex(index: number): HTMLElement {
  const row = dataRows().find((candidate) => candidate.dataset.rowIndex === String(index));

  if (row === undefined) {
    throw new Error(`no data row at index ${String(index)} is mounted`);
  }

  return row;
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

/**
 * The block's live region: the one element that announces the text filter's
 * match count.
 *
 * It carries no role — the busy state owns the view's one `status` — so it is
 * reached from the filter row, which is obtained by role and name, and then by
 * the attributes that make it an atomic live region. Exactly one must exist
 * inside the block once the first page has settled, or an announcement would be
 * doubled. The paging footer is a live region of its own, announcing coverage
 * rather than the filter, and is not atomic, so it is not counted here.
 *
 * @returns That region.
 */
function liveRegion(): HTMLElement {
  const block = screen.getByRole('group', { name: TOOLBAR_NAME }).closest('.dg-event-log');

  if (block === null) {
    throw new Error('the filter row is not inside the event log block');
  }

  const regions = Array.from(
    block.querySelectorAll<HTMLElement>('[aria-live][aria-atomic="true"]'),
  );
  expect(regions).toHaveLength(1);

  const [region] = regions;
  if (region === undefined) {
    throw new Error('the event log block holds no live region');
  }

  return region;
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

/**
 * A node whose query starts at an authored offset, as a validated panel may
 * write one.
 *
 * @param offset The authored `offset`: a whole number, at least zero.
 * @param limit The authored `limit`, the default page size unless a case needs
 * another — zero included, which the schema accepts as "a total without rows".
 * @returns A fresh node.
 */
function nodeFrom(offset: number, limit: number = DATA_QUERY_DEFAULT_LIMIT): EventLogNode {
  return makeNode({ query: { source: 'events', limit, offset } });
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
    // state — an unsettled query is not an answer.
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
    // project.
    const message = await screen.findByText(/no records were captured/i);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    // Worded like every other view's empty capture: what was captured "for
    // this interaction", never "for this query", which names the mechanism
    // rather than what the reader did.
    expect(message.textContent).toContain('for this interaction');
    expect(message.textContent).not.toContain('query');

    for (const name of PROVIDER_ORDER_NAMES) {
      expect(message.textContent).not.toContain(name);
    }
    expect(message.textContent).not.toContain(SOURCE_FILE);

    // Announced as the settled status, with a short title and a decorative
    // glyph above the sentence, like every other view's empty capture.
    const state = screen.getByRole('status');
    expect(state.contains(message)).toBe(true);
    expect(state.parentElement?.classList.contains('dg-event-log__empty')).toBe(true);
    expect(state.querySelector('.dg-empty-state__title')?.textContent).toBe('No records');
    expect(state.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure, and there is no grid to hold rows.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);

    // Nothing loaded, so nothing is claimed about coverage and no page can be
    // asked for.
    expect(screen.queryByText(/records loaded/)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // A settled empty capture reached with no narrowing of the reader's leaves
    // no record for the text filter to search and nothing for a kind to
    // narrow, so the filter bar is not drawn over it.
    expect(screen.queryByRole('group', { name: TOOLBAR_NAME })).toBeNull();
    expect(screen.queryByRole('textbox', { name: SEARCH_NAME })).toBeNull();
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

  it('renders a provider rejection through the shared error-state contract', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', PROVIDER_CAUSE, { hint: PROVIDER_HINT }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A lone failure is the assertive announcement.
    const alert = await screen.findByRole('alert');

    // The one title every failed view carries, and a message that opens with the
    // generic lead and keeps the provider's own cause after it — the hint is
    // not folded into it.
    expect(within(alert).getByText(QUERY_FAILURE_TITLE)).toBeDefined();

    const message = alert.querySelector('.dg-error-state__message');
    expect(message?.textContent).toBe(`${QUERY_FAILURE_LEAD} ${PROVIDER_CAUSE}`);

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

    // Exactly one glyph: the primitive's own default, as on every other node.
    expect(alert.querySelectorAll('.dg-error-state__icon svg')).toHaveLength(1);
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
    // `start_asc`: the service applied the ordering it was given, so a
    // component that re-ranked the page locally would show an order no
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
    // which this package may use for types only, so an edit that enumerated it
    // here would offer every kind the taxonomy defines — among them the two
    // below, which this capture cannot prove exist.
    expect(kindOptions()).toHaveLength(4);

    const labels = kindOptions().map((option) => option.label);
    expect(labels).not.toContain(formatKindLabel('db.query'));
    expect(labels).not.toContain(formatKindLabel('http.server'));

    // The page is the whole source — no total beyond it, no further page — so
    // the records that arrived already prove every kind it holds, and no
    // count is asked for.
    expect(stub.censusQueries).toHaveLength(0);
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

  it('keeps its toolbar when a chosen kind narrows the result to nothing', async () => {
    // The capture holds records; the reader's kind narrows the query to none.
    const stub = pagingProvider('events', [{ data: PROVIDER_ORDER }, { data: [], total: 0 }]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.selectOptions(kindPicker(), 'fetch');

    // The narrowed result is empty, and it is the reader's own narrowing that
    // emptied it, so the bar that made the choice stays, still showing it, and
    // the choice can be undone where it was made.
    await screen.findByText(/no records were captured/i);
    expect(screen.getByRole('group', { name: TOOLBAR_NAME })).toBeDefined();
    const picker = kindPicker();
    expect(picker instanceof HTMLSelectElement ? picker.value : '').toBe('fetch');
    expect(searchField()).toBeDefined();
    expect(stub.resolve).toHaveBeenCalledTimes(2);
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
      screen.getByText(`${formatCount(1)} of ${formatCount(3)} loaded records matches`),
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

  it('clears an unmatched filter from its own empty state and returns focus to the field', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER, { total: 40, nextOffset: 3 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // Before any filtering there is nothing to clear, so nothing offers to.
    expect(screen.queryByRole('button', { name: CLEAR_SEARCH_NAME })).toBeNull();

    await user.type(searchField(), 'unmatched');

    // The control sits in the no-match state itself, beside a sentence that
    // names it in its own words, so the reader need not hunt for the field.
    const clear = await screen.findByRole('button', { name: CLEAR_SEARCH_NAME });
    expect(clear.closest('.dg-empty-state__action')).not.toBeNull();
    const message = screen.getByText(/no loaded records match this text filter/i);
    expect(message.textContent).toContain('Clear the text filter');

    await user.click(clear);

    // The filter is gone: the field is empty, every loaded row is back in the
    // provider's order, and no match statement remains to be shown or heard.
    const field = searchField();
    expect(field instanceof HTMLInputElement ? field.value : undefined).toBe('');
    await waitFor(() => {
      expect(renderedNames()).toEqual(PROVIDER_ORDER_NAMES);
    });
    expect(screen.queryByText(/loaded records match/)).toBeNull();
    expect(screen.queryByText(PARTIAL_SEARCH_NOTE)).toBeNull();
    expect(screen.queryByRole('button', { name: CLEAR_SEARCH_NAME })).toBeNull();

    // The button unmounted with the state it belonged to, and focus did not
    // fall to the document body with it: the reader is back in the field.
    expect(document.activeElement).toBe(field);

    // Clearing is local, like the filter it undoes: nothing was re-requested.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('announces the match count through one polite live region, silent while unfiltered', async () => {
    // A total equal to the loaded page, so the filter reached every record and
    // the announcement is the match statement alone.
    const stub = resolvingProvider('events', PROVIDER_ORDER, { total: 3 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // Mounted before anything is filtered, and empty: a region that appeared
    // with its text already in it would not be announced at all.
    const region = liveRegion();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.getAttribute('role')).toBeNull();
    expect(region.classList.contains('dg-visually-hidden')).toBe(true);
    expect(region.textContent).toBe('');

    await user.type(searchField(), 'click');

    // Exactly the statement the toolbar draws, so what is heard is what is shown.
    const statement = `${formatCount(1)} of ${formatCount(3)} loaded records matches`;
    await waitFor(() => {
      expect(liveRegion().textContent).toBe(statement);
    });
    expect(screen.getAllByText(statement)).toHaveLength(2);
    expect(screen.queryByText(PARTIAL_SEARCH_NOTE)).toBeNull();

    // Emptied with the filter, and the same element throughout: a replaced
    // region would lose the announcement that follows the replacement.
    await user.clear(searchField());
    await waitFor(() => {
      expect(liveRegion().textContent).toBe('');
    });
    expect(liveRegion()).toBe(region);
  });

  it('announces the partial-search note in the same sentence as the match count', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER, { total: 40, nextOffset: 3 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    await user.type(searchField(), 'unmatched');

    // One atomic sentence: both statements the toolbar draws, in its order, so
    // the limitation is heard with the count it qualifies.
    await waitFor(() => {
      expect(liveRegion().textContent).toBe(
        `${formatCount(0)} of ${formatCount(3)} loaded records match. ${PARTIAL_SEARCH_NOTE}`,
      );
    });

    // Each pill remains the only element whose own text is its statement.
    expect(
      screen.getAllByText(`${formatCount(0)} of ${formatCount(3)} loaded records match`),
    ).toHaveLength(1);
    expect(screen.getAllByText(PARTIAL_SEARCH_NOTE)).toHaveLength(1);
  });
});

describe('EventLog announcements', () => {
  /**
   * The region that announces the text filter's match count.
   *
   * It has no role — the busy state owns this view's one `status` — so it is
   * found by the two attributes that make it an atomic polite region, and the
   * case fails unless exactly one such region exists.
   *
   * @returns That region.
   */
  function matchCountRegion(): HTMLElement {
    const regions = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-live="polite"][aria-atomic="true"]'),
    ).filter((region) => region.getAttribute('role') === null);

    expect(regions).toHaveLength(1);

    const [region] = regions;

    if (region === undefined) {
      throw new Error('no match-count live region is mounted');
    }

    return region;
  }

  /**
   * Every live region whose text mentions the match count, so a case can prove
   * that one statement is announced once rather than by two regions at once.
   *
   * @returns The live regions carrying the count.
   */
  function liveCopiesOfMatchCount(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[aria-live]')).filter(
      (region) =>
        region.getAttribute('aria-live') !== 'off' &&
        (region.textContent ?? '').includes('loaded records match'),
    );
  }

  it('announces the match count politely as the text filter changes, and only then', async () => {
    // The whole source is loaded, so the count is the only statement.
    const stub = resolvingProvider('events', PROVIDER_ORDER, { total: PROVIDER_ORDER.length });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // Mounted before the reader types, and silent: a region inserted with its
    // text already in it would not be announced.
    const region = matchCountRegion();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.classList.contains('dg-visually-hidden')).toBe(true);
    expect(region.textContent).toBe('');

    // Two of the three records carry a dotted name.
    await user.type(searchField(), 'example.');

    const twoMatch = `${formatCount(2)} of ${formatCount(3)} loaded records match`;
    await waitFor(() => {
      expect(region.textContent).toBe(twoMatch);
    });

    // What is heard is what the toolbar shows, and the toolbar's pill is not a
    // second announcement of it: exactly one live copy exists.
    const shown = screen.getAllByText(twoMatch).filter((element) => element !== region);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.classList.contains('dg-badge')).toBe(true);
    expect(shown[0]?.closest('[aria-live]')).toBeNull();
    expect(liveCopiesOfMatchCount()).toEqual([region]);

    // Narrowing further updates the same, still-mounted region.
    await user.type(searchField(), 'c');
    await waitFor(() => {
      expect(region.textContent).toBe(
        `${formatCount(1)} of ${formatCount(3)} loaded records matches`,
      );
    });
    expect(matchCountRegion()).toBe(region);

    // Clearing the filter silences it again rather than unmounting it.
    await user.clear(searchField());
    await waitFor(() => {
      expect(region.textContent).toBe('');
    });
    expect(region.isConnected).toBe(true);
  });

  it('adds the loaded-only note to the announcement when the page is shorter than the source', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER, { total: 40, nextOffset: 3 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.type(searchField(), 'click');

    // One atomic sentence, the two toolbar statements in their toolbar order.
    await waitFor(() => {
      expect(matchCountRegion().textContent).toBe(
        `${formatCount(1)} of ${formatCount(3)} loaded records matches. ${PARTIAL_SEARCH_NOTE}`,
      );
    });
    expect(liveCopiesOfMatchCount()).toHaveLength(1);
  });

  it('announces the paging footer politely as each page arrives', async () => {
    const stub = pagingProvider('events', [
      { data: [RENDER_RECORD], total: 40, nextOffset: 1 },
      { data: [FETCH_RECORD], total: 40, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const coverage = await screen.findByText(
      `${formatCount(1)} of ${formatCount(40)} records loaded`,
    );
    expect(coverage.getAttribute('aria-live')).toBe('polite');
    expect(coverage.getAttribute('role')).toBeNull();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The same region, still mounted, now carries the new count.
    await waitFor(() => {
      expect(coverage.textContent).toBe(`${formatCount(2)} of ${formatCount(40)} records loaded`);
    });
    expect(coverage.isConnected).toBe(true);
  });

  it('keeps the total in the polite footer while the next page is in flight', async () => {
    // The second page is held open until the case settles it, so the footer can
    // be read in the state a reader would hear while it loads.
    const second: { settle?: (response: DataQueryResponse) => void } = {};
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve<DataQueryResponse>({
            source: 'events',
            data: [RENDER_RECORD],
            total: 40,
            nextOffset: 1,
          })
        : new Promise<DataQueryResponse>((resolve) => {
            second.settle = resolve;
          }),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const loadedOne = `${formatCount(1)} of ${formatCount(40)} records loaded`;
    const coverage = await screen.findByText(loadedOne);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    // In flight, the count keeps the total it was last given rather than
    // announcing one that claims no total was ever reported.
    expect(coverage.textContent).toBe(loadedOne);
    expect(screen.queryByText(`${formatCount(1)} record loaded`)).toBeNull();

    act(() => {
      second.settle?.({ source: 'events', data: [FETCH_RECORD], total: 40, nextOffset: 2 });
    });

    await waitFor(() => {
      expect(coverage.textContent).toBe(`${formatCount(2)} of ${formatCount(40)} records loaded`);
    });
  });
});

/**
 * The component stylesheet, read from disk with the `import.meta.url`
 * convention `../tokens/tokens.test.ts` documents, so the working directory is
 * irrelevant. The path is joined with `node:path` rather than resolved with
 * `new URL(…)`: under happy-dom the global `URL` is the DOM's, which Node's
 * `fileURLToPath` rejects.
 *
 * Read because the strip's layout is decided there and nowhere else: the
 * component measures nothing, and happy-dom lays nothing out, so the rules are
 * the contract a case can hold.
 */
const COMPONENT_STYLESHEET = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'components.css'),
  'utf8',
);

/**
 * The declaration block of one selector in {@link COMPONENT_STYLESHEET},
 * failing when the rule is absent.
 *
 * @param selector The selector exactly as written at the start of its rule.
 * @returns The text between the rule's braces.
 */
function ruleOf(selector: string): { readonly body: string } {
  const start = COMPONENT_STYLESHEET.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = COMPONENT_STYLESHEET.indexOf('{', start);
  const close = COMPONENT_STYLESHEET.indexOf('}', open);

  return { body: COMPONENT_STYLESHEET.slice(open + 1, close) };
}

/** How an attribute disclosure's name begins while its row is collapsed. */
const SHOW_ATTRIBUTES_PREFIX = 'Show the full attributes of';

/** How it begins while the row is expanded. */
const HIDE_ATTRIBUTES_PREFIX = 'Hide the full attributes of';

/**
 * The detail an expanded row shows: the element its disclosure controls,
 * which must be in the document, holding the component's detail block.
 *
 * @param row The expanded data row.
 * @returns The detail block.
 */
function attributeDetailOf(row: HTMLElement): HTMLElement {
  const disclosure = within(row).getByRole('button', {
    name: new RegExp(`^${HIDE_ATTRIBUTES_PREFIX} `),
  });
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  const controlled = document.getElementById(disclosure.getAttribute('aria-controls') ?? '');
  const detail = controlled?.querySelector<HTMLElement>('.dg-event-log__detail') ?? null;
  if (controlled === null || detail === null) {
    throw new Error('the expanded row controls no attribute detail');
  }
  // The detail is its own row after the data row, never part of the row's cells.
  expect(row.contains(detail)).toBe(false);
  return detail;
}

/**
 * The entries of a detail, as `[key, whole value]` pairs in document order:
 * each value block with the key printed directly above it.
 *
 * @param detail The detail block.
 * @returns Its entries.
 */
function detailEntries(detail: HTMLElement): (readonly [string, string])[] {
  return Array.from(detail.querySelectorAll('pre')).map(
    (block) => [block.previousElementSibling?.textContent ?? '', block.textContent ?? ''] as const,
  );
}

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

    // The fixture IS the bound, so this case fails if the bound moves rather
    // than silently testing a shorter string.
    expect(BOUNDED_VALUE).toHaveLength(MAX_PREVIEW_LENGTH);

    // Byte for byte, with the key joined to it and nothing else done to it.
    const bounded = within(row).getByText(`example.value=${BOUNDED_VALUE}`);
    expect(bounded.textContent).toBe(`example.value=${BOUNDED_VALUE}`);

    const preview = within(row).getByText(`example.preview=${TRUNCATED_VALUE}`);
    expect(preview.textContent).toBe(`example.preview=${TRUNCATED_VALUE}`);
    // The producer's own truncation marker survives: this view never re-parses,
    // re-expands or reconstructs a value it was handed.
    expect(preview.textContent?.endsWith(TRUNCATED_VALUE)).toBe(true);

    // A chip the cell cuts short is readable on hover. The hover shows the whole
    // pair, which for a value within the preview bound is the very text the
    // chip renders — never a fuller value than was captured.
    expect(bounded.getAttribute('title')).toBe(bounded.textContent);
    expect(preview.getAttribute('title')).toBe(preview.textContent);

    // Everything is shown whole already, so nothing offers more: the row holds
    // no control at all, and the strip claims nothing is withheld.
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
    // never dropped and never expanded on the row: an upstream summary stays a
    // summary, and the whole attribute bag belongs to the host's detail drawer.
    expect(within(row).getByText(`+${formatCount(2)} more`)).toBeDefined();
    expect(row.textContent).not.toContain('example.fourth');
    expect(row.textContent).not.toContain('delta');
    expect(row.textContent).not.toContain('nested');
    expect(row.textContent).not.toContain('kept-for-the-detail-drawer');

    // A primitive pair was left out, so the row opens into its detail: every
    // primitive whole, in the producer's order, and the structured summary
    // counted there too — still never unpacked, anywhere on the page.
    await userEvent
      .setup()
      .click(within(row).getByRole('button', { name: `${SHOW_ATTRIBUTES_PREFIX} ${record.name}` }));
    const detail = attributeDetailOf(rowNamed(record.name));
    expect(detailEntries(detail)).toEqual([
      ['example.first', 'alpha'],
      ['example.second', '2'],
      ['example.third', 'true'],
      ['example.fourth', 'delta'],
    ]);
    expect(within(detail).getByText('1 structured value not unpacked here')).toBeDefined();
    expect(document.body.textContent).not.toContain('nested');
    expect(document.body.textContent).not.toContain('kept-for-the-detail-drawer');
  });

  it('draws the pairs as shrinking chips, followed by a count that never shrinks', async () => {
    const pairTexts = [
      'example.first=alpha',
      `example.value=${BOUNDED_VALUE}`,
      'example.third=true',
    ];
    const record = makeEvent({
      attributes: {
        'example.first': 'alpha',
        'example.value': BOUNDED_VALUE,
        'example.third': true,
        'example.fourth': 'delta',
        'example.structured': { nested: 'kept-for-the-detail-drawer' },
      },
    });
    const stub = resolvingProvider('events', [record]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    const row = rowNamed(record.name);

    // Every chip carries the class that lets it shrink inside the strip, and
    // its own rendered text as its title.
    const chips = pairTexts.map((text) => within(row).getByText(text));
    for (const [index, chip] of chips.entries()) {
      expect(chip.classList.contains('dg-code')).toBe(true);
      expect(chip.classList.contains('dg-event-log__attr')).toBe(true);
      expect(chip.getAttribute('title')).toBe(pairTexts[index]);
    }

    // The count carries the class that keeps it whole, and it is the strip's
    // last item, directly after the chips — so the chips give way to it and
    // never the other way round. Under a host that can open a record it is
    // the control that does so, showing exactly the count.
    const more = within(row).getByRole('button', { name: moreAttributesName(2) });
    expect(more.textContent).toBe(`+${formatCount(2)} more`);
    expect(more.classList.contains('dg-event-log__more')).toBe(true);
    expect(more.classList.contains('dg-event-log__attr')).toBe(false);
    expect(more.closest('.dg-event-log__attrs')).not.toBeNull();
    expect(Array.from(more.parentElement?.children ?? [])).toEqual([...chips, more]);
  });

  it('declares the strip layout that keeps the count visible, with no measured width', () => {
    // The chips start from nothing, grow no further than their own text, and
    // ellipsize at their own border; the count never shrinks. Keywords and
    // the literals the package permits (`0`, `none`, `auto`, `inherit`,
    // `currentColor`, `transparent`) only.
    const chip = ruleOf('.dg-event-log__attr');
    for (const declaration of [
      'flex: auto;',
      'flex-basis: 0;',
      'min-inline-size: 0;',
      'max-inline-size: max-content;',
      'overflow: hidden;',
      'text-overflow: ellipsis;',
      'white-space: nowrap;',
    ]) {
      expect(chip.body).toContain(declaration);
    }
    // The zero basis follows the shorthand, which would otherwise reset it to
    // `auto` and start every chip from its whole text.
    expect(chip.body.indexOf('flex-basis: 0;')).toBeGreaterThan(chip.body.indexOf('flex: auto;'));

    expect(ruleOf('.dg-event-log__more').body).toContain('flex: none;');

    // The strip clips at its own box, which the count's button fills, so the
    // button's focus ring is pulled inward and drawn whole — by offset alone,
    // never by removing or restyling the ring.
    const focusRule = ruleOf('.dg-event-log__more:focus-visible').body;
    expect(focusRule).toContain('outline-offset: var(--dg-space-inverse-0);');
    expect(focusRule).not.toContain('outline:');
  });
});

describe('EventLog long values', () => {
  /** The words at the very end of the long URL, which only the whole value holds. */
  const URL_TAIL = 'tail=?';

  /** A redacted URL far past the preview budget: its query values already replaced. */
  const LONG_URL = `http://127.0.0.1:3000/example/${'segment/'.repeat(30)}resource?page=?&${URL_TAIL}`;

  /** The words at the very end of the long statement. */
  const STATEMENT_TAIL = 'example-end-of-statement';

  /** A parameterized statement laid out over lines, past the budget: literals already replaced. */
  const LONG_STATEMENT = [
    'SELECT',
    Array.from(
      { length: 30 },
      (_, at) => `  COALESCE(example_ledger.column_${String(at)}, ?) AS column_${String(at)}`,
    ).join(',\n'),
    'FROM example_ledger WHERE tenant_id = $1',
    `LIMIT ? /* ${STATEMENT_TAIL} */`,
  ].join('\n');

  /** A request record carrying both, as a server span of a database-backed route would. */
  const LONG_RECORD = makeEvent({
    id: 'event-example-0301',
    kind: 'http.server',
    tier: 'server',
    name: 'example.long-values',
    attributes: { 'http.method': 'GET', url: LONG_URL, 'db.statement': LONG_STATEMENT },
  });

  it('carries the whole of a cut value in its chip, and opens it whole from the keyboard', async () => {
    const stub = resolvingProvider('events', [LONG_RECORD]);
    const spies = makeActions();
    const onExpand = vi.fn<(nodeId: string, itemId: string, expanded: boolean) => void>();
    const user = userEvent.setup();

    renderBeforeControl(makeNode(), {
      provider: stub.provider,
      actions: { ...spies.actions, onExpand },
    });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });
    const row = rowNamed(LONG_RECORD.name);

    // The strip cuts both values to the preview budget; each chip's title holds
    // the whole pair, whitespace folded onto the chip's one line.
    const url = within(row).getByText(`url=${oneLinePreview(LONG_URL)}`);
    expect(url.textContent?.endsWith('…')).toBe(true);
    expect(url.textContent).not.toContain(URL_TAIL);
    expect(url.getAttribute('title')).toBe(`url=${LONG_URL}`);
    const statement = within(row).getByText(`db.statement=${oneLinePreview(LONG_STATEMENT)}`);
    expect(statement.getAttribute('title')).toBe(
      `db.statement=${collapseWhitespace(LONG_STATEMENT)}`,
    );
    expect(statement.getAttribute('title')).toContain(STATEMENT_TAIL);

    // The row is expandable through its disclosure, which leads the record's
    // name, names the record, and stays out of the Tab order.
    const show = within(row).getByRole('button', {
      name: `${SHOW_ATTRIBUTES_PREFIX} ${LONG_RECORD.name}`,
    });
    expect(show.closest('[role="rowheader"]')).not.toBeNull();
    expect(show.getAttribute('tabindex')).toBe('-1');
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(show.hasAttribute('aria-controls')).toBe(false);
    expect(tabStopsIn(grid)).toEqual([row]);

    // The keyboard: Tab onto the row, ArrowRight onto its disclosure, Enter.
    focusDirectly(kindPicker());
    await user.tab();
    expect(document.activeElement).toBe(row);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(show);
    await user.keyboard('{Enter}');
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onExpand).toHaveBeenLastCalledWith(NODE_ID, LONG_RECORD.id, true);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    // The detail: every primitive, whole and exactly as it arrived — the
    // statement's line breaks kept — in the producer's key order.
    const detail = attributeDetailOf(rowNamed(LONG_RECORD.name));
    expect(detailEntries(detail)).toEqual([
      ['http.method', 'GET'],
      ['url', LONG_URL],
      ['db.statement', LONG_STATEMENT],
    ]);

    // Each value is a wrapping code block the row's keyboard walk reaches: out
    // of the Tab order of the page, and the next stop after the disclosure.
    const blocks = Array.from(detail.querySelectorAll<HTMLElement>('pre'));
    for (const block of blocks) {
      expect(block.getAttribute('tabindex')).toBe('-1');
      expect(block.classList.contains('dg-code--block')).toBe(true);
      expect(block.classList.contains('dg-code--wrap')).toBe(true);
    }
    const hide = within(rowNamed(LONG_RECORD.name)).getByRole('button', {
      name: `${HIDE_ATTRIBUTES_PREFIX} ${LONG_RECORD.name}`,
    });
    expect(document.activeElement).toBe(hide);
    await user.tab();
    expect(document.activeElement).toBe(blocks[0]);
    expect(tabStopsIn(grid)).toEqual([rowNamed(LONG_RECORD.name)]);

    // Escape returns to the row; the disclosure closes the detail again.
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowNamed(LONG_RECORD.name));
    await user.click(hide);
    expect(onExpand).toHaveBeenLastCalledWith(NODE_ID, LONG_RECORD.id, false);
    expect(document.querySelector('.dg-event-log__detail')).toBeNull();
    expect(
      within(rowNamed(LONG_RECORD.name))
        .getByRole('button', { name: `${SHOW_ATTRIBUTES_PREFIX} ${LONG_RECORD.name}` })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('offers no disclosure when what it leaves out is only structured summaries', async () => {
    const record = makeEvent({
      attributes: {
        'example.first': 'alpha',
        'example.structured': { nested: 'kept-for-the-detail-drawer' },
      },
    });
    const stub = resolvingProvider('events', [record]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    const row = rowNamed(record.name);

    // The strip counts the summary; a detail would add nothing it may show,
    // so the row has no disclosure — its one control is the count's own.
    expect(within(row).getByText(`+${formatCount(1)} more`)).toBeDefined();
    expect(
      within(row).queryAllByRole('button', { name: `${SHOW_ATTRIBUTES_PREFIX} ${record.name}` }),
    ).toHaveLength(0);
    expect(document.querySelector('.dg-event-log__detail')).toBeNull();
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

    // A row that can be activated has a selected state, and none is selected
    // before the reader activates one.
    expect(row.getAttribute('aria-selected')).toBe('false');

    await user.click(row);

    // Outside a panel host the list marks the line last activated in it.
    expect(dataRows()[0]?.getAttribute('aria-selected')).toBe('true');
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
    // reader who cannot distinguish the hues.
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

describe('EventLog keyboard', () => {
  /** The reference a selection of `event` reports, in the shape the host receives. */
  function refOf(event: TelemetryEvent): PanelEventRef {
    return { eventId: event.id, spanId: event.spanId, traceId: event.traceId };
  }

  it('is one Tab stop, entered on the active row and left by the next Tab', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);
    const user = userEvent.setup();

    renderBeforeControl(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });
    const chip = within(grid).getByRole('button', { name: SOURCE_CHIP_NAME });
    const firstRow = rowNamed(RENDER_RECORD.name);

    // The chip stays a real, focusable button, and leaves the Tab order.
    expect(chip.getAttribute('tabindex')).toBe('-1');

    // Before focus: one stop in the whole grid, and it is the active row.
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(tabStopsIn(grid)).toEqual([firstRow]);

    // The kind picker is the toolbar's last control, so the next Tab enters the grid.
    focusDirectly(kindPicker());
    await user.tab();
    expect(document.activeElement).toBe(firstRow);
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(tabStopsIn(grid)).toEqual([firstRow]);

    // And the one after it leaves the grid, past the chip of every row.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: AFTER_LOG }));
  });

  it('reaches the source chip with ArrowRight and returns with ArrowLeft and Escape', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderBeforeControl(makeNode(), { provider: stub.provider, actions: spies.actions });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });
    const chip = within(grid).getByRole('button', { name: SOURCE_CHIP_NAME });

    focusDirectly(kindPicker());
    await user.tab();
    await user.keyboard('{ArrowDown}');

    const chipRow = rowNamed(FETCH_RECORD.name);
    expect(document.activeElement).toBe(chipRow);

    // Into the row: the chip takes focus, and its full location opens with it.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chip);
    expect(bubbleOf(chip).classList.contains('dg-is-open')).toBe(true);
    expect(tabStopsIn(grid)).toEqual([chipRow]);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(chipRow);

    // Escape takes two presses: the open description first, then back to the row.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chip);
    await user.keyboard('{Escape}');
    expect(bubbleOf(chip).classList.contains('dg-is-open')).toBe(false);
    expect(document.activeElement).toBe(chip);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(chipRow);

    // Moving through a row is not acting on it.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('selects a row with Enter, and opens source exactly once from a focused chip', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderBeforeControl(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    focusDirectly(kindPicker());
    await user.tab();

    // Enter on the row is the row's activation: the host hears that record.
    await user.keyboard('{Enter}');
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith(refOf(RENDER_RECORD));

    // Enter on a control is the control's own key, and never also the row's.
    await user.keyboard('{ArrowDown}{ArrowRight}{Enter}');
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource).toHaveBeenCalledWith(BASE_SOURCE);
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('keeps one Tab stop under virtualization, and reaches the last row with End', async () => {
    // Far more records than the table renders without measuring, so only a
    // window of rows is mounted and End has to bring the last one into it.
    const recordCount = 240;
    const lastIndex = recordCount - 1;
    const records = Array.from({ length: recordCount }, (_unused, index) =>
      makeEvent({
        id: `event-example-log-${String(index).padStart(4, '0')}`,
        spanId: spanIdFor(index + 1),
        name: `example.record.${String(index)}`,
        startTime: BASE_START_MS + index,
        seq: index,
        ingestSeq: index + 1,
        source: index === lastIndex ? BASE_SOURCE : undefined,
      }),
    );
    const stub = resolvingProvider('events', records, { total: recordCount });
    const user = userEvent.setup();

    renderBeforeControl(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });
    expect(dataRows().length).toBeLessThan(recordCount);
    expect(tabStopsIn(grid)).toEqual([rowAtIndex(0)]);

    focusDirectly(kindPicker());
    await user.tab();
    expect(document.activeElement).toBe(rowAtIndex(0));

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rowAtIndex(lastIndex));
    expect(tabStopsIn(grid)).toEqual([rowAtIndex(lastIndex)]);

    // The last row's chip is reached from its row, and left back to it.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(
      within(rowAtIndex(lastIndex)).getByRole('button', { name: SOURCE_CHIP_NAME }),
    );
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(rowAtIndex(lastIndex));

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rowAtIndex(0));
    expect(tabStopsIn(grid)).toEqual([rowAtIndex(0)]);
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
    // more records exist, and saying only what it has is the truthful option.
    const coverage = await screen.findByText(`${formatCount(1)} record loaded`);
    expect(coverage.textContent).not.toContain(' of ');
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });
});

describe('EventLog authored offset', () => {
  it('starts at the authored offset and counts the footer from that position', async () => {
    // Two hundred and forty records match; the node asks for those from
    // position 201 on, so forty remain from where it starts. `nextOffset` is
    // deliberately not 200 + the page length: the next request must carry the
    // service's own value.
    const stub = pagingProvider('events', [
      { data: [RENDER_RECORD, FETCH_RECORD], total: 240, nextOffset: 250 },
      { data: [INTERACTION_RECORD], total: 240 },
    ]);
    const user = userEvent.setup();

    renderComponent(nodeFrom(200), { provider: stub.provider, actions: makeActions().actions });

    // Relative to the authored start, and the start is stated: "2 of 240"
    // would read as coverage of the whole capture from its first record.
    await screen.findByText(
      `${formatCount(2)} of ${formatCount(40)} records loaded, from position ${formatCount(201)}`,
    );
    expect(screen.queryByText(new RegExp(`of ${formatCount(240)} records loaded`))).toBeNull();
    expect(renderedNames()).toEqual([RENDER_RECORD.name, FETCH_RECORD.name]);

    // The very first request honours the authored offset.
    const first = soleQuery(stub);
    expect(first.offset).toBe(200);
    expect(first.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // Exactly the service's `nextOffset`, not one derived from what arrived.
    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).offset).toBe(250);

    await waitFor(() => {
      expect(renderedNames()).toEqual([
        RENDER_RECORD.name,
        FETCH_RECORD.name,
        INTERACTION_RECORD.name,
      ]);
    });
    expect(
      screen.getByText(
        `${formatCount(3)} of ${formatCount(40)} records loaded, from position ${formatCount(201)}`,
      ),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('states the starting position alone when the service reported no total', async () => {
    const stub = resolvingProvider('events', [INTERACTION_RECORD]);

    renderComponent(nodeFrom(200), { provider: stub.provider, actions: makeActions().actions });

    const coverage = await screen.findByText(
      `${formatCount(1)} record loaded, from position ${formatCount(201)}`,
    );
    expect(coverage.textContent).not.toContain(' of ');
    expect(soleQuery(stub).offset).toBe(200);
  });

  it('starts a fresh page sequence when the authored offset changes', async () => {
    const stub = pagingProvider('events', [
      { data: [RENDER_RECORD], total: 240, nextOffset: 201 },
      { data: [FETCH_RECORD], total: 240, nextOffset: 202 },
      { data: [INTERACTION_RECORD], total: 240, nextOffset: 101 },
    ]);
    const user = userEvent.setup();

    const rerenderWith = renderComponent(nodeFrom(200), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([RENDER_RECORD.name, FETCH_RECORD.name]);
    });
    expect(queryOfCall(stub, 2).offset).toBe(201);

    // The same slot now carries a node that starts elsewhere: that is another
    // sequence, so its first request is at the new authored offset — not at
    // the offset the old sequence had reached — and nothing loaded for the old
    // one is carried under the new one's counts.
    rerenderWith(nodeFrom(100));

    await waitFor(() => {
      expect(stub.resolve).toHaveBeenCalledTimes(3);
    });
    expect(queryOfCall(stub, 3).offset).toBe(100);

    await waitFor(() => {
      expect(renderedNames()).toEqual([INTERACTION_RECORD.name]);
    });
    expect(
      screen.getByText(
        `${formatCount(1)} of ${formatCount(140)} records loaded, from position ${formatCount(101)}`,
      ),
    ).toBeDefined();
  });

  it.each([
    ['equal to the offset of the page it answered', 200],
    ['behind the offset of the page it answered', 150],
  ])('offers no Load More for a nextOffset %s', async (_label, nextOffset) => {
    // A `nextOffset` that does not move forward would re-request the page on
    // screen and append it twice; the control is withheld rather than offered.
    const stub = resolvingProvider('events', [RENDER_RECORD], { total: 240, nextOffset });

    renderComponent(nodeFrom(200), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(
      `${formatCount(1)} of ${formatCount(40)} records loaded, from position ${formatCount(201)}`,
    );
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer whose nextOffset is not a whole number, and offers no Load More', async () => {
    // The host's response check rejects a counter that is not a non-negative
    // integer before the view sees the page, so no row of that answer is drawn
    // and no page is offered past it: the failure is stated, with its code.
    const stub = resolvingProvider('events', [RENDER_RECORD], { total: 240, nextOffset: 200.5 });

    renderComponent(nodeFrom(200), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('PROTOCOL_INVALID_MESSAGE')).toBeDefined();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByText(RENDER_RECORD.name)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('EventLog page size', () => {
  it.each([
    ['an explicit zero as zero', 0, 0],
    ['a fractional limit truncated', 7.9, 7],
    ['a negative limit as zero', -3, 0],
    ['a limit above the ceiling at the ceiling', DATA_QUERY_MAX_LIMIT + 1, DATA_QUERY_MAX_LIMIT],
    ['a non-finite limit at the default', Number.NaN, DATA_QUERY_DEFAULT_LIMIT],
  ])('requests %s', (_label, authored, expected) => {
    // Zero is a legitimate authored value — a total without rows — and only
    // the absence of the field means "unset", so it is never raised to a row.
    const stub = pendingProvider();

    renderComponent(nodeFrom(0, authored), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    expect(soleQuery(stub).limit).toBe(expected);
  });

  it('requests the default page size when the node omits a limit', () => {
    const stub = pendingProvider();

    renderComponent(makeNode({ query: { source: 'events' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const query = soleQuery(stub);
    expect(query.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(query.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
  });

  it('never pages a count-only query, whatever nextOffset answers it', async () => {
    // A provider that answers `limit: 0` with a row and a forward `nextOffset`
    // anyway: the row is the service's business and is drawn, but a page
    // sequence of zero-row pages cannot advance, so nothing offers to ask again.
    const stub = resolvingProvider('events', [RENDER_RECORD], { total: 42, nextOffset: 1 });

    renderComponent(nodeFrom(0, 0), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(`${formatCount(1)} of ${formatCount(42)} records loaded`);
    expect(soleQuery(stub).limit).toBe(0);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('EventLog empty pages', () => {
  /**
   * The empty state's heading, obtained by its text, and checked to be the
   * heading of the component's own absence box rather than any other text.
   *
   * @param title The heading expected.
   * @returns That heading element.
   */
  async function emptyStateTitle(title: string): Promise<HTMLElement> {
    const heading = await screen.findByText(title);
    expect(heading.classList.contains('dg-empty-state__title')).toBe(true);
    expect(heading.closest('.dg-event-log__empty')).not.toBeNull();

    return heading;
  }

  /**
   * Asserts the empty state's sentence, exactly, and that it is the state's
   * message element.
   *
   * @param message The sentence expected.
   */
  function expectEmptyStateMessage(message: string): void {
    const element = screen.getByText(message);
    expect(element.classList.contains('dg-empty-state__message')).toBe(true);
  }

  it('states the total of a count-only query and never asks for a page', async () => {
    // The service points `nextOffset` at the very offset it answered: a
    // count-only query must neither offer nor make a second request for it.
    const stub = resolvingProvider('events', [], { total: 42, nextOffset: 0 });

    renderComponent(nodeFrom(0, 0), { provider: stub.provider, actions: makeActions().actions });

    await emptyStateTitle(COUNT_ONLY_TITLE);
    expectEmptyStateMessage(
      `This view requests a count without rows: ${formatCount(42)} events matched its query.`,
    );

    // Not an empty capture: forty-two records matched.
    expect(screen.queryByText(EMPTY_CAPTURE_PATTERN)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);

    // Zero was sent as zero, once, and nothing offers to page it.
    const query = soleQuery(stub);
    expect(query.limit).toBe(0);
    expect(query.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(screen.queryByText(/records loaded/)).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a total of one', 1, 'This view requests a count without rows: 1 event matched its query.'],
    ['a total of zero', 0, 'This view requests a count without rows: 0 events matched its query.'],
    [
      'no total',
      undefined,
      'This view requests a count without rows, and no total was reported for its query.',
    ],
  ])('phrases a count-only query answered with %s', async (_label, total, message) => {
    const stub = resolvingProvider('events', [], { total });

    renderComponent(nodeFrom(0, 0), { provider: stub.provider, actions: makeActions().actions });

    await emptyStateTitle(COUNT_ONLY_TITLE);
    expectEmptyStateMessage(message);
    expect(screen.queryByText(EMPTY_CAPTURE_PATTERN)).toBeNull();
  });

  it.each([
    ['well past the end', 500, 42, `${formatCount(501)}, past the end of the 42 events`],
    ['exactly at the end', 42, 42, `${formatCount(43)}, past the end of the 42 events`],
    ['past a single match', 5, 1, `${formatCount(6)}, past the end of the 1 event`],
  ])(
    'states the position and the total of an authored offset %s',
    async (_label, offset, total, expected) => {
      const stub = resolvingProvider('events', [], { total });

      renderComponent(nodeFrom(offset), {
        provider: stub.provider,
        actions: makeActions().actions,
      });

      await emptyStateTitle(EMPTY_PAGE_TITLE);
      expectEmptyStateMessage(`This page starts at position ${expected} that matched this query.`);

      // An offset past the end is an empty page, not an empty capture and not
      // an error, and it was requested exactly as authored.
      expect(screen.queryByText(EMPTY_CAPTURE_PATTERN)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(soleQuery(stub).offset).toBe(offset);
      expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    },
  );

  it.each([
    ['the first record', 0],
    ['an authored offset inside the matches', 10],
  ])('states the total when a page from %s holds nothing', async (_label, offset) => {
    const stub = resolvingProvider('events', [], { total: 42 });

    renderComponent(nodeFrom(offset), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await emptyStateTitle(EMPTY_PAGE_TITLE);
    expectEmptyStateMessage(
      `${formatCount(42)} events matched this query, but none are shown on this page.`,
    );
    expect(screen.queryByText(EMPTY_CAPTURE_PATTERN)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('states only the position of an empty page past the first record with no total', async () => {
    const stub = resolvingProvider('events', []);

    renderComponent(nodeFrom(300), { provider: stub.provider, actions: makeActions().actions });

    await emptyStateTitle(EMPTY_PAGE_TITLE);
    expectEmptyStateMessage(
      `This page starts at position ${formatCount(301)} and holds no events; no total was reported for this query.`,
    );
    expect(screen.queryByText(EMPTY_CAPTURE_PATTERN)).toBeNull();
  });

  it.each([
    ['from the first record', 0],
    ['from an authored offset', 300],
  ])('keeps the empty-capture message for a total of zero %s', async (_label, offset) => {
    const stub = resolvingProvider('events', [], { total: 0 });

    renderComponent(nodeFrom(offset), { provider: stub.provider, actions: makeActions().actions });

    const message = await screen.findByText(EMPTY_CAPTURE_PATTERN);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.closest('.dg-event-log__empty')).not.toBeNull();

    // The plain message, with no heading claiming anything else.
    expect(screen.queryByText(EMPTY_PAGE_TITLE)).toBeNull();
    expect(screen.queryByText(COUNT_ONLY_TITLE)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('keeps the next page reachable from an empty page with a forward nextOffset', async () => {
    const stub = pagingProvider('events', [
      { data: [], total: 42, nextOffset: 200 },
      { data: [FETCH_RECORD], total: 42 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await emptyStateTitle(EMPTY_PAGE_TITLE);
    expectEmptyStateMessage(
      `${formatCount(42)} events matched this query, but none are shown on this page.`,
    );
    expect(
      screen.getByText(`${formatCount(0)} of ${formatCount(42)} records loaded`),
    ).toBeDefined();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // Exactly the reported offset, and the rows follow its answer.
    expect(queryOfCall(stub, 2).offset).toBe(200);
    await waitFor(() => {
      expect(renderedNames()).toEqual([FETCH_RECORD.name]);
    });
    expect(
      screen.getByText(`${formatCount(1)} of ${formatCount(42)} records loaded`),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('does not call an empty first page with a forward nextOffset and no total an empty capture', async () => {
    const stub = resolvingProvider('events', [], { nextOffset: 200 });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await emptyStateTitle(EMPTY_PAGE_TITLE);
    expectEmptyStateMessage(
      `This page starts at position ${formatCount(1)} and holds no events; no total was reported for this query.`,
    );
    expect(screen.queryByText(EMPTY_CAPTURE_PATTERN)).toBeNull();
    expect(screen.getByRole('button', { name: LOAD_MORE_NAME })).toBeDefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The panel's shared selection
 *
 * Under the panel host the selected line is the panel's one selection — the
 * record any view or evidence chip last selected, since an evidence chip
 * selects the events it cites — rather than a state of this list, and it is
 * marked the way every selected grid row is: `aria-selected` plus the grid's
 * own `dg-is-selected`. A line activated here only reports its record; the
 * mark moves when the host's selection does. These cases provide the selection
 * directly through `PanelSelectionContext`, which is exactly what the host
 * mounts.
 * ---------------------------------------------------------------------------
 */

/** What {@link renderWithSelection} mounts the list inside. */
interface SelectionContext {
  /** The provider that resolves the node's query. */
  readonly provider: DataProvider;

  /** The actions to report to, or `undefined` for a surface that only displays. */
  readonly actions: PanelActions | undefined;

  /** The selection the host provides, or `undefined` for no host at all. */
  readonly hosted: { readonly selection: PanelSelection | undefined } | undefined;
}

/**
 * The list inside the host contexts a case names: always a provider and a
 * session, actions only when given, and the panel's selection only when the
 * case stands in for a host.
 *
 * @param node The node to draw.
 * @param context What to mount it inside.
 * @returns The element tree.
 */
function selectionTree(node: EventLogNode, context: SelectionContext): ReactElement {
  const log = <EventLog node={node} />;
  const withActions =
    context.actions === undefined ? (
      log
    ) : (
      <PanelActionsContext.Provider value={context.actions}>{log}</PanelActionsContext.Provider>
    );
  const withSelection =
    context.hosted === undefined ? (
      withActions
    ) : (
      <PanelSelectionContext.Provider value={context.hosted}>
        {withActions}
      </PanelSelectionContext.Provider>
    );

  return (
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={SESSION_ID}>
        {withSelection}
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>
  );
}

/**
 * Renders the list with {@link selectionTree}.
 *
 * @param node The node to draw.
 * @param context What to mount it inside.
 * @returns A function that re-renders the same mounted list inside another context.
 */
function renderWithSelection(
  node: EventLogNode,
  context: SelectionContext,
): (next: SelectionContext) => void {
  const { rerender } = render(selectionTree(node, context));

  return (next: SelectionContext): void => {
    rerender(selectionTree(node, next));
  };
}

describe('EventLog shared selection', () => {
  it('marks the line whose record the panel selection names, and no other', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);

    renderWithSelection(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
      hosted: { selection: { eventId: FETCH_RECORD.id } },
    });

    await screen.findByRole('grid');

    const selected = rowNamed(FETCH_RECORD.name);
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.classList.contains('dg-is-selected')).toBe(true);
    expect(rowNamed(RENDER_RECORD.name).getAttribute('aria-selected')).toBe('false');
    expect(rowNamed(INTERACTION_RECORD.name).getAttribute('aria-selected')).toBe('false');
    expect(rowNamed(INTERACTION_RECORD.name).classList.contains('dg-is-selected')).toBe(false);
  });

  it('marks a line a selection names by its trace and span alone', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);

    // Another record's id, but this record's own span in its own trace: the
    // pair is the span's identity across tiers, so it names this line.
    renderWithSelection(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
      hosted: {
        selection: {
          eventId: 'event-example-elsewhere',
          traceId: RENDER_RECORD.traceId,
          spanId: RENDER_RECORD.spanId,
        },
      },
    });

    await screen.findByRole('grid');

    expect(rowNamed(RENDER_RECORD.name).getAttribute('aria-selected')).toBe('true');
    expect(rowNamed(FETCH_RECORD.name).getAttribute('aria-selected')).toBe('false');
  });

  it('follows the panel selection instead of keeping one of its own', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();
    const base = { provider: stub.provider, actions: spies.actions };

    const rerender = renderWithSelection(makeNode(), { ...base, hosted: { selection: undefined } });

    await screen.findByRole('grid');

    // Under a host every line has a selected state, because any view may
    // select one of these records — none is selected yet.
    expect(dataRows().every((row) => row.getAttribute('aria-selected') === 'false')).toBe(true);

    await user.click(rowNamed(INTERACTION_RECORD.name));

    // The activation is reported with the record's own identifiers...
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: INTERACTION_RECORD.id,
      spanId: INTERACTION_RECORD.spanId,
      traceId: INTERACTION_RECORD.traceId,
    });

    // ...but the mark is the host's to move.
    expect(rowNamed(INTERACTION_RECORD.name).getAttribute('aria-selected')).toBe('false');

    rerender({ ...base, hosted: { selection: { eventId: INTERACTION_RECORD.id } } });
    expect(rowNamed(INTERACTION_RECORD.name).getAttribute('aria-selected')).toBe('true');

    // A selection made in another view moves the mark here as well.
    rerender({ ...base, hosted: { selection: { eventId: RENDER_RECORD.id } } });
    expect(rowNamed(INTERACTION_RECORD.name).getAttribute('aria-selected')).toBe('false');
    expect(rowNamed(RENDER_RECORD.name).getAttribute('aria-selected')).toBe('true');
  });

  it('marks no neighbour while the text filter hides the selected record', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);
    const user = userEvent.setup();

    renderWithSelection(makeNode(), {
      provider: stub.provider,
      actions: makeActions().actions,
      hosted: { selection: { eventId: FETCH_RECORD.id } },
    });

    await screen.findByRole('grid');
    await user.type(searchField(), 'click');

    await waitFor(() => {
      expect(renderedNames()).toEqual([INTERACTION_RECORD.name]);
    });
    expect(rowNamed(INTERACTION_RECORD.name).getAttribute('aria-selected')).toBe('false');

    // Clearing the filter draws the selected record again, marked.
    await user.clear(searchField());

    await waitFor(() => {
      expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
    });
    expect(rowNamed(FETCH_RECORD.name).getAttribute('aria-selected')).toBe('true');
  });

  it('claims no selected state for a list that only displays', async () => {
    const stub = resolvingProvider('events', PROVIDER_ORDER);

    // No host and no actions: no line can ever become selected, so none reports
    // a selected state — a grid of `aria-selected="false"` rows would claim a
    // selection model that does not exist.
    renderWithSelection(makeNode(), {
      provider: stub.provider,
      actions: undefined,
      hosted: undefined,
    });

    await screen.findByRole('grid');

    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);
    expect(dataRows().every((row) => row.getAttribute('aria-selected') === null)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The kind census
 *
 * A page that does not reach the end of its source cannot stand for the kinds
 * the source holds: a capture that opens with renders keeps its statements and
 * requests thousands of records further on. While the loaded page falls short,
 * the log counts every kind the query filter can name with one count-only
 * request each, and offers exactly the kinds the source holds, with their
 * counts. The expected vocabulary is read from the query schema — the contract
 * the census requests must satisfy — rather than from the component.
 * ---------------------------------------------------------------------------
 */

/** Every kind a `DataQueryFilter.kinds` entry may name, from the query schema. */
const FILTER_KINDS: readonly string[] = dataQueryFilterSchema.shape.kinds.unwrap().element.options;

/** A kind label as the picker shows it with a census count beside it. */
function countedLabel(label: string, count: number): string {
  return `${label} (${formatCount(count)})`;
}

describe('EventLog kind census', () => {
  it('offers every kind the source holds, with its count, when the page does not cover it', async () => {
    // The first page holds a render, a fetch and an interaction; the source
    // also holds statements the page never reached.
    const stub = pagingProvider('events', [{ data: PROVIDER_ORDER, total: 40, nextOffset: 3 }], {
      render: 20,
      fetch: 8,
      interaction: 2,
      'db.query': 10,
    });

    renderComponent(
      makeNode({
        query: { source: 'events', filter: { traceId: TRACE_ID }, limit: DATA_QUERY_DEFAULT_LIMIT },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid');

    // A kind no loaded record shows is offered, and every option says how many
    // records it narrows to; "all kinds" is the whole source.
    await waitFor(() => {
      expect(kindOptions()).toEqual([
        { value: '', label: countedLabel(ALL_KINDS_LABEL, 40) },
        { value: 'db.query', label: countedLabel(formatKindLabel('db.query'), 10) },
        { value: 'fetch', label: countedLabel(formatKindLabel('fetch'), 8) },
        { value: 'interaction', label: countedLabel(formatKindLabel('interaction'), 2) },
        { value: 'render', label: countedLabel(formatKindLabel('render'), 20) },
      ]);
    });

    // One count-only request per kind the filter can name, each the node's own
    // narrowing plus that one kind, from the first record — and none of them
    // part of the page sequence.
    expect(stub.censusQueries.map((query) => query.filter?.kinds?.[0])).toEqual([...FILTER_KINDS]);
    for (const query of stub.censusQueries) {
      expect(query).toEqual({
        source: 'events',
        filter: { traceId: TRACE_ID, kinds: [query.filter?.kinds?.[0]] },
        limit: 0,
        offset: DATA_QUERY_DEFAULT_OFFSET,
      });
    }
    expect(stub.queries).toHaveLength(1);
  });

  it('narrows to a kind the page never showed, and keeps its census without taking it again', async () => {
    const statement = makeEvent({
      id: 'event-example-0010',
      spanId: spanIdFor(10),
      kind: 'db.query',
      tier: 'db',
      name: 'example.statement',
      seq: 10,
    });
    const stub = pagingProvider(
      'events',
      [
        { data: PROVIDER_ORDER, total: 40, nextOffset: 3 },
        { data: [statement], total: 1 },
      ],
      { render: 20, fetch: 8, interaction: 2, 'db.query': 1 },
    );
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    await waitFor(() => {
      expect(kindOptions().map((option) => option.value)).toContain('db.query');
    });
    const counted = stub.censusQueries.length;

    await user.selectOptions(kindPicker(), 'db.query');

    // The narrowing is a re-query for that kind, and it draws the records the
    // first page could not have shown.
    expect(queryOfCall(stub, 2).filter).toEqual({ kinds: ['db.query'] });
    await waitFor(() => {
      expect(renderedNames()).toEqual([statement.name]);
    });
    expect(spies.onFilterChange).toHaveBeenCalledWith(NODE_ID, { kinds: 'db.query' });

    // The census counts what the reader can narrow TO, so narrowing never
    // re-takes it, and the other kinds stay on offer with their counts even
    // though the narrowed page now covers its own source.
    expect(stub.censusQueries).toHaveLength(counted);
    expect(kindOptions()).toEqual([
      { value: '', label: countedLabel(ALL_KINDS_LABEL, 31) },
      { value: 'db.query', label: countedLabel(formatKindLabel('db.query'), 1) },
      { value: 'fetch', label: countedLabel(formatKindLabel('fetch'), 8) },
      { value: 'interaction', label: countedLabel(formatKindLabel('interaction'), 2) },
      { value: 'render', label: countedLabel(formatKindLabel('render'), 20) },
    ]);
  });

  it('counts only the kinds the node narrows to, and drops the ones the source lacks', async () => {
    const stub = pagingProvider('events', [{ data: [RENDER_RECORD], total: 35, nextOffset: 1 }], {
      render: 30,
      'db.query': 5,
    });

    renderComponent(
      makeNode({
        query: {
          source: 'events',
          filter: { kinds: ['render', 'db.query', 'log'] },
          limit: DATA_QUERY_DEFAULT_LIMIT,
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid');

    // The reader can never narrow outside the node's own query, so only its
    // three kinds are counted; the one the source holds none of is not offered,
    // because choosing it could only draw nothing.
    await waitFor(() => {
      expect(kindOptions()).toEqual([
        { value: '', label: countedLabel(ALL_KINDS_LABEL, 35) },
        { value: 'db.query', label: countedLabel(formatKindLabel('db.query'), 5) },
        { value: 'render', label: countedLabel(formatKindLabel('render'), 30) },
      ]);
    });
    const authored = ['render', 'db.query', 'log'];
    expect(stub.censusQueries.map((query) => query.filter?.kinds)).toEqual(
      FILTER_KINDS.filter((kind) => authored.includes(kind)).map((kind) => [kind]),
    );
  });

  it('takes no census when the loaded page reaches the reported total', async () => {
    const stub = pagingProvider('events', [{ data: PROVIDER_ORDER, total: 3 }], { render: 1 });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(`${formatCount(3)} of ${formatCount(3)} records loaded`);

    expect(stub.censusQueries).toHaveLength(0);
    expect(kindOptions().map((option) => option.label)).toEqual([
      ALL_KINDS_LABEL,
      formatKindLabel('fetch'),
      formatKindLabel('interaction'),
      formatKindLabel('render'),
    ]);
  });

  it('takes no census for a node that starts at an authored offset', async () => {
    const stub = pagingProvider('events', [{ data: PROVIDER_ORDER, total: 240, nextOffset: 203 }], {
      render: 240,
    });

    renderComponent(nodeFrom(200), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // A window into its sequence: counting kinds the window can never reach
    // would offer narrowings that draw nothing from where it starts.
    expect(stub.censusQueries).toHaveLength(0);
    expect(kindOptions().map((option) => option.label)).not.toContain(
      countedLabel(ALL_KINDS_LABEL, 240),
    );
  });

  it('falls back to the kinds that loaded, with no error, when the census cannot be taken', async () => {
    // No census answer: every count request is rejected.
    const stub = pagingProvider('events', [{ data: PROVIDER_ORDER, total: 40, nextOffset: 3 }]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await waitFor(() => {
      expect(stub.censusQueries).toHaveLength(FILTER_KINDS.length);
    });

    // The log itself is unaffected: no failure is drawn for a census, and the
    // picker offers what the loaded records prove, as it would without one.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
    expect(kindOptions()).toEqual([
      { value: '', label: ALL_KINDS_LABEL },
      { value: 'fetch', label: formatKindLabel('fetch') },
      { value: 'interaction', label: formatKindLabel('interaction') },
      { value: 'render', label: formatKindLabel('render') },
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Appending a page
 *
 * A further page never replaces what is on screen: the grid stays the same
 * mounted element — so its virtualizer, its scroll position and its active row
 * survive the request — and the control that was pressed keeps its place and
 * its focus. A failure is reported beneath the rows it could not extend.
 * ---------------------------------------------------------------------------
 */

/** The paging control's name while the page it asked for is on its way. */
const LOADING_MORE_NAME = 'Loading more…';

/** The title the shared error contract gives a failed further page. */
const PAGE_FAILURE_TITLE = 'Could not load the next page';

/** The first page every appending case starts from: one of forty records. */
const FIRST_OF_FORTY: DataQueryResponse = {
  source: 'events',
  data: [RENDER_RECORD],
  total: 40,
  nextOffset: 1,
};

describe('EventLog appending a page', () => {
  it('keeps the grid, its rows and the focused control in place while the next page loads', async () => {
    const second: { settle?: (response: DataQueryResponse) => void } = {};
    const stub = recordingProvider((_query, call) =>
      call === 1
        ? Promise.resolve(FIRST_OF_FORTY)
        : new Promise<DataQueryResponse>((resolve) => {
            second.settle = resolve;
          }),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid');
    const control = screen.getByRole('button', { name: LOAD_MORE_NAME });

    await user.click(control);
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    // In flight: the same grid, the same rows, no view-wide busy state, and the
    // pressed control still there, still focused, saying what it is doing.
    expect(screen.getByRole('grid')).toBe(grid);
    expect(renderedNames()).toEqual([RENDER_RECORD.name]);
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.getByRole('button', { name: LOADING_MORE_NAME })).toBe(control);
    expect(document.activeElement).toBe(control);
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('aria-busy')).toBe('true');

    // Pressing it again asks for nothing more.
    await user.click(control);
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    act(() => {
      second.settle?.({ source: 'events', data: [FETCH_RECORD], total: 40, nextOffset: 2 });
    });

    // Appended into the same grid, and the control — the same element — is
    // ready again with focus still on it.
    await waitFor(() => {
      expect(renderedNames()).toEqual([RENDER_RECORD.name, FETCH_RECORD.name]);
    });
    expect(screen.getByRole('grid')).toBe(grid);
    expect(screen.getByRole('button', { name: LOAD_MORE_NAME })).toBe(control);
    expect(document.activeElement).toBe(control);
    expect(control.getAttribute('aria-disabled')).toBeNull();
    expect(control.getAttribute('aria-busy')).toBeNull();
  });

  it('moves a reader on the control to the grid when the last page arrives', async () => {
    const stub = pagingProvider('events', [
      { data: [RENDER_RECORD], total: 2, nextOffset: 1 },
      { data: [FETCH_RECORD], total: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await waitFor(() => {
      expect(renderedNames()).toEqual([RENDER_RECORD.name, FETCH_RECORD.name]);
    });

    // Nothing is left to load, so the control is gone — and the reader who was
    // on it is on the grid's tab stop, not on the document body.
    expect(screen.queryByRole('button', { name: /load/i })).toBeNull();
    expect(screen.getByRole('grid')).toBe(grid);

    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active?.getAttribute('role')).toBe('row');
    expect(active?.getAttribute('tabindex')).toBe('0');
    expect(active instanceof HTMLElement && grid.contains(active)).toBe(true);
  });

  it('reports a failed page beneath the rows it could not extend, and retries that page', async () => {
    const stub = recordingProvider((_query, call) => {
      if (call === 1) {
        return Promise.resolve(FIRST_OF_FORTY);
      }
      if (call === 2) {
        return Promise.reject(
          new DebuggenError('TRANSPORT_DISCONNECTED', PROVIDER_CAUSE, { hint: PROVIDER_HINT }),
        );
      }

      return Promise.resolve<DataQueryResponse>({
        source: 'events',
        data: [FETCH_RECORD],
        total: 40,
        nextOffset: 2,
      });
    });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    const alert = await screen.findByRole('alert');

    // The rows already read stay where they were, in the same grid, and the
    // footer keeps its count; the failure names the page, not the view.
    expect(screen.getByRole('grid')).toBe(grid);
    expect(renderedNames()).toEqual([RENDER_RECORD.name]);
    expect(within(alert).getByText(PAGE_FAILURE_TITLE)).toBeDefined();
    expect(within(alert).queryByText(QUERY_FAILURE_TITLE)).toBeNull();
    expect(within(alert).getByText(PROVIDER_CAUSE, { exact: false })).toBeDefined();
    expect(
      screen.getByText(`${formatCount(1)} of ${formatCount(40)} records loaded`),
    ).toBeDefined();
    expect(grid.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    // The reader who pressed the control is on the retry, which asks for
    // exactly the page that failed.
    const retry = within(alert).getByRole('button', { name: RETRY_NAME });
    expect(document.activeElement).toBe(retry);

    await user.click(retry);
    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3).offset).toBe(1);

    await waitFor(() => {
      expect(renderedNames()).toEqual([RENDER_RECORD.name, FETCH_RECORD.name]);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('grid')).toBe(grid);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: LOAD_MORE_NAME }));
  });
});

/*
 * ---------------------------------------------------------------------------
 * The hidden-attribute count
 * ---------------------------------------------------------------------------
 */

describe('EventLog hidden attributes', () => {
  /** A record with three shown pairs and two counted ones. */
  const WIDE_RECORD = makeEvent({
    attributes: {
      'example.first': 'alpha',
      'example.second': 2,
      'example.third': true,
      'example.fourth': 'delta',
      'example.structured': { nested: 'kept-for-the-detail-drawer' },
    },
  });

  it('selects the record from its count, so the host can show every attribute', async () => {
    const stub = resolvingProvider('events', [WIDE_RECORD]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    const grid = await screen.findByRole('grid');
    const row = rowNamed(WIDE_RECORD.name);
    const more = within(row).getByRole('button', { name: moreAttributesName(2) });

    // A control that adds no Tab stop: the grid stays one.
    expect(more.tabIndex).toBe(-1);
    expect(tabStopsIn(grid)).toHaveLength(1);
    expect(more.getAttribute('title')).toBe('Select this record to see all 5 attributes');

    await user.click(more);

    // It reports the selection a row activation reports, once, and nothing
    // else; the strip itself still unpacks nothing.
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: WIDE_RECORD.id,
      spanId: WIDE_RECORD.spanId,
      traceId: WIDE_RECORD.traceId,
    });
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(rowNamed(WIDE_RECORD.name).getAttribute('aria-selected')).toBe('true');
    });
    expect(row.textContent).not.toContain('kept-for-the-detail-drawer');
    expect(row.textContent).not.toContain('delta');
  });

  it('names a single hidden attribute in the singular', async () => {
    const record = makeEvent({
      attributes: { a: 1, b: 2, c: 3, d: 4 },
    });
    const stub = resolvingProvider('events', [record]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    const more = within(rowNamed(record.name)).getByRole('button', {
      name: moreAttributesName(1),
    });
    expect(more.textContent).toBe(`+${formatCount(1)} more`);
    expect(more.getAttribute('title')).toBe('Select this record to see all 4 attributes');
  });

  it('keeps the count as plain text where nothing can open the record', async () => {
    const stub = resolvingProvider('events', [WIDE_RECORD]);

    renderWithSelection(makeNode(), {
      provider: stub.provider,
      actions: undefined,
      hosted: undefined,
    });

    await screen.findByRole('grid');
    const row = rowNamed(WIDE_RECORD.name);

    // No control that cannot act: the count is text, with the same class. (The
    // row's disclosure, which opens its own detail, still acts here.)
    expect(within(row).queryAllByRole('button', { name: /select this record/u })).toHaveLength(0);
    const more = within(row).getByText(`+${formatCount(2)} more`);
    expect(more.closest('button')).toBeNull();
    expect(more.classList.contains('dg-event-log__more')).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Counted words
 * ---------------------------------------------------------------------------
 */

describe('EventLog counted words', () => {
  it('reads a one-record capture in the singular, in the footer and the match count', async () => {
    const stub = resolvingProvider('events', [RENDER_RECORD], { total: 1 });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(`${formatCount(1)} of ${formatCount(1)} record loaded`);
    expect(screen.queryByText(/\b1 of 1 records\b/)).toBeNull();

    await user.type(searchField(), RENDER_RECORD.name);

    await waitFor(() => {
      expect(liveRegion().textContent).toBe(
        `${formatCount(1)} of ${formatCount(1)} loaded record matches`,
      );
    });
    expect(
      within(screen.getByRole('group', { name: TOOLBAR_NAME })).getByText(
        `${formatCount(1)} of ${formatCount(1)} loaded record matches`,
      ),
    ).toBeDefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Rendering cost
 * ---------------------------------------------------------------------------
 */

describe('EventLog cell rendering', () => {
  it('renders each row’s cells once, however often the grid re-renders over the same rows', async () => {
    const records = [0, 1, 2].map((index) =>
      makeEvent({
        id: `event-example-01${String(index)}`,
        spanId: spanIdFor(20 + index),
        name: `example.row-${String(index)}`,
        seq: index,
        attributes: { 'example.first': `value-${String(index)}`, 'example.second': index },
      }),
    );
    const stub = resolvingProvider('events', records);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await waitFor(() => {
      expect(dataRows()).toHaveLength(records.length);
    });
    const settled = codeRenders.count;
    expect(settled).toBeGreaterThan(0);

    // A selection re-renders the grid and every row in its window — the path
    // each scroll step of the virtualizer takes — over the same row models, so
    // no chip is rendered again.
    const target = records[1];
    if (target === undefined) {
      throw new Error('the fixture has no second record');
    }
    await user.click(within(rowNamed(target.name)).getByRole('rowheader'));
    await waitFor(() => {
      expect(rowNamed(target.name).getAttribute('aria-selected')).toBe('true');
    });

    expect(codeRenders.count).toBe(settled);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Direction controls in captured text
 *
 * A record's name, its attribute values and its location are captured text,
 * and an invisible right-to-left override (U+202E) in one of them draws the
 * characters after it backwards: escaped markup still reads reversed. Every
 * place this log puts such text — the name and its title, the attribute chips
 * and their titles, the disclosure's name, the detail, the source chip and the
 * grid's name — prints each control as its visible escape (`\u202E`); a short
 * value is not called cut merely because it carries one; and every value
 * handed back to the host stays as captured.
 * ---------------------------------------------------------------------------
 */

/** The right-to-left override, and the pop that ends it. */
const RLO = '\u202E';
const PDF = '\u202C';

/** The visible escape printed in the override's place. */
const RLO_MARKER = '\\u202E';

/**
 * Every place in a rendered tree where a raw direction control would reach a
 * reader: the text, and every attribute but a `data-*` one (data, not display).
 *
 * @param root The rendered tree.
 * @returns A description of each offending sink; empty when there is none.
 */
function rawDirectionSinks(root: Element): string[] {
  const sinks: string[] = [];

  if (containsDirectionControl(root.textContent)) {
    sinks.push('textContent');
  }

  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (!attribute.name.startsWith('data-') && containsDirectionControl(attribute.value)) {
        sinks.push(`${element.tagName.toLowerCase()}[${attribute.name}]`);
      }
    }
  }

  return sinks;
}

describe('EventLog direction controls', () => {
  const bidiName = `QA_BIDI ${RLO}</td><script>alert(7)</script>${PDF}`;
  const bidiSource: SourceLocation = {
    file: `src/example/${RLO}handler.ts`,
    line: 12,
    column: 3,
    symbol: `on${RLO}Click`,
    resolvedBy: 'source-map',
    confidence: 0.8,
  };
  const bidiRecord = makeEvent({
    id: `event-${RLO}example-0001`,
    name: bidiName,
    status: 'error',
    attributes: { target: `#${RLO}buy${PDF}` },
    source: bidiSource,
  });

  it('prints every control as its escape and keeps the markup inert', async () => {
    const title = `Events ${RLO}logged`;
    const stub = resolvingProvider('events', [bidiRecord]);

    renderComponent(makeNode({ title }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: formatUntrustedText(title) });

    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    // The name and its title are the logical text, markers and all.
    const name = row.querySelector<HTMLElement>('.dg-event-log__name');
    expect(name?.textContent).toBe(formatUntrustedText(bidiName));
    expect(name?.getAttribute('title')).toBe(formatUntrustedText(bidiName));

    // The one short attribute is shown whole, so the row offers no detail for
    // it: a control is not a cut.
    const chip = row.querySelector<HTMLElement>('.dg-event-log__attr');
    expect(chip?.textContent).toBe(`target=#${RLO_MARKER}buy\\u202C`);
    expect(within(row).queryByRole('button', { name: /^Show the full attributes of / })).toBeNull();

    // Nothing a reader sees, hovers or hears carries a raw control, and the
    // markup in the name is only text.
    expect(rawDirectionSinks(document.body)).toEqual([]);
    expect(document.body.querySelector('script, td')).toBeNull();
  });

  it('still discloses a long value with a control, revealed in full', async () => {
    const long = `${'redacted-value-'.repeat(9)}${RLO}tail`;
    const stub = resolvingProvider('events', [
      makeEvent({ name: `example${RLO}.click`, attributes: { target: long } }),
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.click(
      screen.getByRole('button', {
        name: `Show the full attributes of ${formatUntrustedText(`example${RLO}.click`)}`,
      }),
    );

    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }
    expect(detailEntries(attributeDetailOf(row))).toEqual([['target', formatUntrustedText(long)]]);
    expect(rawDirectionSinks(document.body)).toEqual([]);
  });

  it('hands the host the raw record id and the raw location', async () => {
    const stub = resolvingProvider('events', [bidiRecord]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    await user.click(
      within(row).getByRole('button', {
        name: sourceLinkAccessibleName({ location: bidiSource, compact: true }),
      }),
    );
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toEqual(bidiSource);
    expect(spies.onOpenSource.mock.calls[0]?.[0]?.file).toContain(RLO);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    await user.click(row);
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent.mock.calls[0]?.[0]).toEqual({
      eventId: bidiRecord.id,
      spanId: bidiRecord.spanId,
      traceId: bidiRecord.traceId,
    });
    expect(containsDirectionControl(bidiRecord.id)).toBe(true);
  });

  it('filters on the marker a reader sees, and on a pasted raw control alike', async () => {
    // The control sits only in the name, so a match can come from nowhere else.
    const marked = makeEvent({ id: 'event-marked-0001', name: `example${RLO}.click` });
    const plain = makeEvent({ id: 'event-plain-0002', name: 'example.plain' });
    const stub = resolvingProvider('events', [marked, plain]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    await user.type(searchField(), RLO_MARKER);
    await waitFor(() => {
      expect(renderedNames()).toEqual([formatUntrustedText(marked.name)]);
    });

    await user.clear(searchField());
    await user.type(searchField(), RLO);
    await waitFor(() => {
      expect(renderedNames()).toEqual([formatUntrustedText(marked.name)]);
    });
  });
});
