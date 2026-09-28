/**
 * `components/StateTransitionViewer` — the colocated suite for the
 * `stateTransitions` node.
 *
 * ## What this suite is protecting
 *
 * This view is the one place a panel says *why* a component updated, and two
 * findings that look alike on screen are not alike at all:
 *
 *   - **"no trigger could be determined"** — the capture could not attribute the
 *     transition to a record that can be opened, so nothing is claimed about
 *     what caused it;
 *   - **"no values were reported"** — the producer observed a change it could
 *     not describe, which is emphatically *not* a statement that the value
 *     stayed the same.
 *
 * Only one of them could ever support a conclusion about a re-render, and
 * neither may be presented as the other: the render trigger vocabulary keeps
 * `unchanged` apart from `unknown` (see `docs/ARCHITECTURE.md`,
 * "Computed metrics"), and a panel keeps observed facts apart from likely
 * causes. Four cases below pin that distinction: the undetermined trigger
 * renders a non-interactive label whose row text never claims "unchanged"; an
 * attributed-but-unopenable trigger says why it cannot be opened instead of
 * claiming to be undetermined; a `changed: false` row carries the *no values
 * reported* chip with its own state class and the hint that denies the
 * equality reading; and a `changed: true` row carries neither.
 *
 * The second guarantee this suite holds is the capture's privacy bound (see
 * `docs/SECURITY.md`, "Never captured"): hook values arrive as bounded,
 * already-scrubbed summaries of at most {@link MAX_PREVIEW_LENGTH} code points,
 * and **no opt-in for full values exists in v1**. So a 120-code-point summary
 * must render byte-identically, a longer one must be shortened rather than
 * shown, and no control anywhere in a value cell may offer to expand, parse or
 * reveal one — there is nothing to reveal, and an affordance implying
 * otherwise would promise what the product deliberately never captured.
 *
 * A cell still clips what its track cannot hold, so the clipped-cell cases pin
 * where the rest of the *displayed* text is readable: a whole summary's and a
 * name's own `title`, and the expanded detail, which repeats the component, the
 * hook and both displayed summaries unclipped — byte-identical to the row, and
 * for a shortened summary the shortened preview only. The stylesheet rules that
 * bound a cell to its track are pinned by reading the sheet itself, because the
 * happy-dom environment computes no layout.
 *
 * ## Two places this suite pins the component's contract precisely
 *
 * Both are deliberate decisions of the code under test, documented in its own
 * header and in `../host/useQuery`:
 *
 *   1. **"Load more" advances to the provider's `nextOffset` and appends.**
 *      Every request of a sequence carries the same `limit`, and the next one
 *      starts at exactly the offset the previous response reported — never a
 *      wider window at the old offset, never an offset counted from a page's
 *      length, and never a stop at `DATA_QUERY_MAX_LIMIT` rows, which bounds
 *      one request and not how far a reader can go. So the paging cases assert
 *      the second request's offset and limit, rows appended in provider order
 *      and de-duplicated by key, loaded rows kept while the next page is in
 *      flight or has failed, a chain of offsets past 5 000, no control when no
 *      usable `nextOffset` is reported, and a restart from the first page when
 *      the order or the component narrowing changes. An authored `limit: 0` is
 *      a count-only request: sent as `0`, answered by a count-only empty state
 *      that states the total, and never paged, whatever `nextOffset` the
 *      provider echoes. An empty page is an empty capture only for a total of
 *      zero or an unreported total on a first page with nothing after it; a
 *      page past the end, inside a positive total, or later with no total says
 *      so instead.
 *   2. **`changed: false` is labelled "No values reported", not "unchanged".**
 *      The flag records whether the producer could describe the transition, and
 *      it is never computed by comparing two previews — two values differing
 *      only past the truncation bound have identical previews. The state class
 *      (`dg-is-unchanged`) is what the stylesheet keys on; the *word* on screen
 *      is the honest one, and this suite asserts both.
 *
 * Grouping by component is on by default and is presentational only, so the
 * order cases split in two: with grouping off the rendered order is the
 * provider's array exactly, and with grouping on the output is a permutation
 * that preserves each component's own order and says so in the footer.
 *
 * ## Harness conventions (shared with `./SpanTable.test.tsx`)
 *
 *   - **Test API imported explicitly** from `vitest`, and `afterEach(cleanup)`
 *     registered explicitly. The `panel-renderer` project does enable
 *     `globals`, but only so `@testing-library/react` can register its
 *     automatic cleanup; every suite here still names what it uses.
 *   - **Stub providers built with the library's own `createDataProvider`**, so
 *     these cases drive the very seam the DevTools panel and the editor webview
 *     implement — including its check that a response answers for the source it
 *     was asked about. Every query the component issues is recorded, because
 *     what it *asked for* is as much of its contract as what it drew.
 *   - **In-file synthetic builders, no fixture files**: {@link makeTransition}
 *     and {@link makeNode} take overrides and share nothing with another suite.
 *   - **`StateTransition` imported as a type only.** The aggregate that
 *     produces one (`aggregateStateTransitions`) is never called here: this is
 *     a renderer suite, and computing the fixture with the same code that
 *     produced the contract would test neither.
 *   - **Generic fixture vocabulary only**: `ExampleWidget`, `useExampleValue`,
 *     `src/example/widget.tsx`. Nothing from any inspected application,
 *     demonstration or otherwise; `scripts/check-no-hardcoding.mjs` skips test
 *     files, so this suite keeps the product's neutral vocabulary by convention.
 *   - **Queries by role and accessible name.** A class is read only off an
 *     element already obtained semantically, since no `jest-dom` matcher is
 *     available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…` or `waitFor`, and
 *     interactions through `userEvent`.
 *
 * @see ./StateTransitionViewer for the component, its states and its class
 * contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the one-page resolution contract and the
 * `nextOffset` the paging cases assert.
 * @see ../primitives/Code for the element a value summary is rendered into:
 * opaque text, never parsed content.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, StateTransitionsNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { StateTransition } from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext, PanelSelectionContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef, PanelSelection } from '../host/PanelActions';
import { FOCUS_KEY_ATTRIBUTE } from '../primitives/ErrorState';
import {
  ELLIPSIS,
  MAX_PREVIEW_LENGTH,
  NOT_AVAILABLE_LABEL,
  containsDirectionControl,
  formatCount,
  formatUntrustedText,
  humanizeLabel,
  oneLinePreview,
} from '../utils/format';
import { sourceLinkAccessibleName } from './SourceLink';
import { StateTransitionViewer } from './StateTransitionViewer';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Application-neutral throughout. The identifiers are shaped as a capture
 * shapes them — a 32-hex trace id, 16-hex span ids, epoch-millisecond
 * observation times — because the component reads and displays those fields.
 * ---------------------------------------------------------------------------
 */

/** The fixture trace every transition below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'b1c2d3e4f5061728394a5b6c7d8e9f01';

/**
 * The reference observation time, in Unix epoch milliseconds:
 * 2026-01-01T00:00:00Z. Far enough from zero that a relative performance
 * timestamp could not be mistaken for one.
 */
const BASE_START_MS = 1_767_225_600_000;

/** The two components the fixtures attribute transitions to. */
const COMPONENT_WIDGET = 'ExampleWidget';
const COMPONENT_PANEL = 'ExamplePanel';

/** Two hook labels, as a producer that could infer one reports them. */
const HOOK_VALUE_LABEL = 'useExampleValue';
const HOOK_FLAG_LABEL = 'useExampleFlag';

/** A project-relative, POSIX path for the rows that resolved to source. */
const SOURCE_FILE = 'src/example/widget.tsx';

/** The symbol at that location, and its 1-based coordinates. */
const SOURCE_SYMBOL = 'useExampleValue';
const SOURCE_LINE = 84;
const SOURCE_COLUMN = 9;

/** A complete, resolved location for the source-chip case. */
const BASE_SOURCE: SourceLocation = {
  file: SOURCE_FILE,
  line: SOURCE_LINE,
  column: SOURCE_COLUMN,
  symbol: SOURCE_SYMBOL,
  resolvedBy: 'react-owner',
  confidence: 0.75,
};

/** The accessible name the source chip announces (`SourceLink`'s own shape). */
const SOURCE_CHIP_NAME = `Open ${SOURCE_FILE}:${String(SOURCE_LINE)}:${String(SOURCE_COLUMN)}`;

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.stateTransitions';

/**
 * The two orderings this node offers, held as typed constants so a case names
 * the data layer's vocabulary rather than a bare string that happens to match.
 *
 * `count_desc`, the third member, ranks *groups*: every row here is one
 * observed transition, so no control claims it.
 */
const CHRONOLOGICAL: DataQuerySort = 'start_asc';
const LONGEST_FIRST: DataQuerySort = 'duration_desc';

/** The record ids the interactive triggers link to. */
const TRIGGER_EVENT_ID = 'evt_example_trigger_01';
const OTHER_TRIGGER_EVENT_ID = 'evt_example_trigger_02';

/** The names and kinds those records carry when the slice holds them. */
const TRIGGER_NAME = 'example.interaction';
const OTHER_TRIGGER_NAME = 'example.commit';

/*
 * ---------------------------------------------------------------------------
 * Product copy this suite pins
 *
 * Spelled out rather than re-imported from the component, so these cases fix
 * the words a reader actually gets instead of restating whatever the module
 * currently holds. None of them names an inspected application.
 * ---------------------------------------------------------------------------
 */

/** The grid's accessible name when the node carries no title: the catalog's label. */
const CAPTION = 'State transitions';

/** The six column headers, left to right — the "before → trigger → after" reading order. */
const COLUMN_HEADERS: readonly string[] = [
  'Component',
  'Hook',
  'Value before',
  'Trigger',
  'Value after',
  'Reported',
];

/** The loading state's announced label. */
const LOADING_LABEL = 'Loading state transitions…';

/** The error state's retry control, and the accessible name of the query it shows. */
const RETRY_NAME = 'Retry';
const FAILING_QUERY_NAME = 'Failing query';

/** The toolbar's accessible name and the names of its four controls. */
const TOOLBAR_NAME = 'State transition filters';
// Names what it orders: a panel sets several tables' order controls side by
// side, and a bare "Order" would be one name shared by all of them.
const ORDER_CONTROL_NAME = 'Order state transitions';
const COMPONENT_CONTROL_NAME = 'Component';
const CHANGED_ONLY_NAME = 'Changed only';
const GROUPING_NAME = 'Group by component';

/** Two option labels of those pickers. */
const ALL_COMPONENTS_LABEL = 'All components';
const LONGEST_FIRST_LABEL = 'Longest first';

/** The footer's control that requests the next page. */
const LOAD_MORE_NAME = 'Load more';

/** The same control while that page is in flight. */
const LOADING_MORE_NAME = 'Loading more…';

/**
 * The package's one failure contract, as a reader meets it: the title and the
 * generic lead of a view that failed, and of a next page that failed behind
 * rows already on screen (see `queryFailureProps` in `../host/useQuery`).
 * Spelled out rather than imported, so these cases pin the words a reader
 * hears rather than whatever the module currently holds.
 */
const VIEW_FAILURE_TITLE = 'Could not load this view';
const VIEW_FAILURE_LEAD = 'The data for this view could not be loaded.';
const PAGE_FAILURE_TITLE = 'Could not load the next page';
const PAGE_ERROR_TEXT =
  'The next page of this view could not be loaded. The rows already shown are unaffected.';

/** The focus key every error state's retry carries, for the host's node frame. */
const RETRY_FOCUS_KEY = 'error-state-retry';

/** The node's own empty-capture sentence, shown only when nothing was captured. */
const EMPTY_CAPTURE_MESSAGE = 'No state transitions were captured for this interaction.';

/** The short title above that sentence, which only the empty capture carries. */
const EMPTY_CAPTURE_TITLE = 'No transitions';

/** The empty state's title for a count-only request. */
const COUNT_ONLY_TITLE = 'Count only';

/** The empty state's title for a page that holds no rows while the result may hold some. */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/** Either of those titles, for asserting that neither is shown. */
const ANY_EMPTY_PAGE_TITLE = /^(Count only|Nothing on this page)$/u;

/**
 * The row-level disclosure control's name, in both of its states: the action,
 * then the row it acts on — its component, then its hook when the producer
 * identified one, exactly as the row header and the hook cell show them.
 *
 * @param identity The row's identity, as {@link WIDGET_VALUE_IDENTITY} spells one.
 * @returns The toggle's accessible name.
 */
function showDetailsName(identity: string): string {
  return `Show details of ${identity}`;
}

/** The same control's name while the row's detail is open; see {@link showDetailsName}. */
function hideDetailsName(identity: string): string {
  return `Hide details of ${identity}`;
}

/** The identity of a row of {@link COMPONENT_WIDGET} whose hook was labelled {@link HOOK_VALUE_LABEL}. */
const WIDGET_VALUE_IDENTITY = `${COMPONENT_WIDGET} ${HOOK_VALUE_LABEL}`;

/** The identity of a row of {@link COMPONENT_WIDGET} whose hook was labelled {@link HOOK_FLAG_LABEL}. */
const WIDGET_FLAG_LABEL_IDENTITY = `${COMPONENT_WIDGET} ${HOOK_FLAG_LABEL}`;

/**
 * The identity of a row of {@link COMPONENT_WIDGET} whose hook the producer
 * could place at index 2 but not name: the index is printed, never a guessed
 * name.
 */
const WIDGET_SECOND_HOOK_IDENTITY = `${COMPONENT_WIDGET} Hook #2`;

/** The trigger cell's two non-interactive labels. */
const UNDETERMINED_LABEL = 'Undetermined';
const GENERIC_TRIGGER_LABEL = 'Triggering record';

/** The three chips of the reported-state column. */
const CHANGED_LABEL = 'Changed';
const UNREPORTED_LABEL = 'No values reported';
const TRUNCATED_LABEL = 'Transitions dropped';

/** The label for a row whose producer could not name a component. */
const UNNAMED_COMPONENT_LABEL = 'Component not named';

/**
 * The word the trigger cell's kind chip shows, for exactly the trigger kinds
 * the fixtures below attribute a transition to.
 *
 * Spelled out here rather than derived from the formatter the component calls:
 * an oracle computed by the code under test moves with it, so a formatter that
 * went blank or wrong would change both sides of the assertion and pass. Read
 * through {@link triggerKindLabel}, which refuses a kind missing from here.
 */
const TRIGGER_KIND_LABELS: Readonly<
  Partial<Record<NonNullable<StateTransition['triggerKind']>, string>>
> = Object.freeze({
  interaction: 'Interaction',
  commit: 'Commit',
});

/**
 * The pinned chip word for a fixture's trigger kind.
 *
 * Throws for a kind {@link TRIGGER_KIND_LABELS} does not spell — a fixture that
 * starts using another kind must pin its word there — and asserts the word is
 * not blank, so no case can pass by finding an empty string in a cell.
 *
 * @param kind The trigger kind a fixture carries.
 * @returns The literal word the chip must show.
 */
function triggerKindLabel(kind: StateTransition['triggerKind']): string {
  const label = kind === undefined ? undefined : TRIGGER_KIND_LABELS[kind];

  if (label === undefined) {
    throw new Error(`no chip word is pinned for the trigger kind "${String(kind)}"`);
  }

  expect(label.trim()).not.toBe('');

  return label;
}

/*
 * ---------------------------------------------------------------------------
 * Value summaries
 *
 * Opaque, bounded, already-scrubbed text — that is the whole contract, and
 * these fixtures are shaped to test its edges. Every one is a single line with
 * single spaces, so the renderer's whitespace collapsing cannot account for a
 * difference between what was given and what was drawn.
 * ---------------------------------------------------------------------------
 */

/** Distinct summaries, so a per-row assertion cannot pass by matching another row. */
const NUMBER_BEFORE = 'number 1';
const NUMBER_AFTER = 'number 2';
const FLAG_BEFORE = 'boolean false';
const FLAG_AFTER = 'boolean true';
const OBJECT_BEFORE = 'object { items: 3 }';
const OBJECT_AFTER = 'object { items: 4 }';

/**
 * A summary of exactly {@link MAX_PREVIEW_LENGTH} code points: the largest a
 * producer is permitted to report, and therefore the one that must reach the
 * screen untouched. Padded to the bound so the length is a property of the
 * fixture rather than of how carefully it was typed; the case asserts the
 * length before asserting the rendering.
 */
const AT_BOUND_SUMMARY =
  'object { id: "example", items: 12, cursor: "example-cursor", note: "a bounded summary" }'.padEnd(
    MAX_PREVIEW_LENGTH,
    '.',
  );

/**
 * A summary past the bound, which only a producer that ignored the guarantee
 * could send. The renderer shortens it rather than widening what a panel shows
 * beyond what the guarantee promises, and the tail below must never appear.
 */
const OVER_BOUND_TAIL = ', extra: "past the capture bound"';
const OVER_BOUND_SUMMARY = `${AT_BOUND_SUMMARY}${OVER_BOUND_TAIL}`;

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/**
 * A 16-hex span id derived from a small ordinal, so ids stay readable.
 *
 * @param ordinal A small positive integer.
 * @returns A 16-hex span id.
 */
function spanIdFor(ordinal: number): string {
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/**
 * The optional fields of a transition admit `undefined` explicitly, which
 * `Partial` does not under this repository's `exactOptionalPropertyTypes`:
 * passing `{ component: undefined }` is how a case asks for a row *without* a
 * component, and {@link makeTransition} drops the key rather than storing the
 * value.
 */
type TransitionOverrides = Partial<
  Pick<StateTransition, 'id' | 'eventId' | 'spanId' | 'traceId' | 'startTime' | 'changed'>
> & {
  readonly component?: string | undefined;
  readonly hookIndex?: number | undefined;
  readonly hookLabel?: string | undefined;
  readonly previousValue?: string | undefined;
  readonly nextValue?: string | undefined;
  readonly valueType?: StateTransition['valueType'] | undefined;
  readonly triggerEventId?: string | undefined;
  readonly triggerSpanId?: string | undefined;
  readonly triggerName?: string | undefined;
  readonly triggerKind?: StateTransition['triggerKind'] | undefined;
  readonly transitionSource?: StateTransition['transitionSource'] | undefined;
  readonly renderSpanId?: string | undefined;
  readonly fiberId?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly droppedTransitions?: number | undefined;
  readonly source?: SourceLocation | undefined;
};

/**
 * One aggregated state transition for a row to draw.
 *
 * Complete and contract-shaped by construction: the five required identity and
 * timing fields plus `changed`, and every optional field present only when a
 * case asked for it — which is exactly how the aggregate emits them, and what
 * lets a case state "the producer reported no hook label" as an absence rather
 * than as a sentinel.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh transition; nothing is shared between calls.
 */
function makeTransition(overrides: TransitionOverrides = {}): StateTransition {
  const {
    id = 'evt_example_0001',
    eventId = id,
    spanId = spanIdFor(1),
    traceId = TRACE_ID,
    startTime = BASE_START_MS,
    changed = true,
    component,
    hookIndex,
    hookLabel,
    previousValue,
    nextValue,
    valueType,
    triggerEventId,
    triggerSpanId,
    triggerName,
    triggerKind,
    transitionSource,
    renderSpanId,
    fiberId,
    truncated,
    droppedTransitions,
    source,
  } = overrides;

  return {
    id,
    eventId,
    spanId,
    traceId,
    startTime,
    changed,
    ...(component === undefined ? {} : { component }),
    ...(hookIndex === undefined ? {} : { hookIndex }),
    ...(hookLabel === undefined ? {} : { hookLabel }),
    ...(previousValue === undefined ? {} : { previousValue }),
    ...(nextValue === undefined ? {} : { nextValue }),
    ...(valueType === undefined ? {} : { valueType }),
    ...(triggerEventId === undefined ? {} : { triggerEventId }),
    ...(triggerSpanId === undefined ? {} : { triggerSpanId }),
    ...(triggerName === undefined ? {} : { triggerName }),
    ...(triggerKind === undefined ? {} : { triggerKind }),
    ...(transitionSource === undefined ? {} : { transitionSource }),
    ...(renderSpanId === undefined ? {} : { renderSpanId }),
    ...(fiberId === undefined ? {} : { fiberId }),
    ...(truncated === undefined ? {} : { truncated }),
    ...(droppedTransitions === undefined ? {} : { droppedTransitions }),
    ...(source === undefined ? {} : { source }),
  };
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<StateTransitionsNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
};

/**
 * A normalised `stateTransitions` node, as the panel normaliser produces one:
 * an id, no heading of its own, and a data query whose ordering is explicit.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): StateTransitionsNode {
  const {
    id = NODE_ID,
    query = { source: 'stateTransitions', sort: CHRONOLOGICAL },
    title,
  } = overrides;

  return {
    type: 'stateTransitions',
    id,
    query,
    ...(title === undefined ? {} : { title }),
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
interface TransitionPage {
  /** The transitions of the page, in the order the service returned them. */
  readonly data: readonly StateTransition[];

  /** The total the service reports for the whole query, when it reports one. */
  readonly total?: number | undefined;

  /** The offset of the next page, when more rows exist beyond this window. */
  readonly nextOffset?: number | undefined;
}

/** A stub provider, the queries it has received and the resolver behind it. */
interface StubProvider {
  /** The provider to hand to {@link renderComponent}. */
  readonly provider: DataProvider;

  /**
   * Every query the component has asked for, in call order.
   *
   * The assertion surface for the ordering, narrowing and paging cases: what
   * the component *requested* is as much of its contract as what it drew.
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
 * The builder every re-query case uses: a second request has to be able to
 * answer differently from the first, or "the rows follow the second response"
 * could not be told from "the rows were re-ordered locally".
 *
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(pages: readonly TransitionPage[]): StubProvider {
  return recordingProvider((_query, call) => {
    const page = pages[Math.min(call, pages.length) - 1];

    if (page === undefined) {
      throw new Error('the stub provider was built with no pages');
    }

    return Promise.resolve<DataQueryResponse>({
      source: 'stateTransitions',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    });
  });
}

/**
 * A provider that resolves one page for every query.
 *
 * @param data The transitions of the page, in the order they should be drawn.
 * @param extra The paging counters to report, if any.
 * @returns The stub provider.
 */
function resolvingProvider(
  data: readonly StateTransition[],
  extra: Omit<TransitionPage, 'data'> = {},
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

  /** The event-selection spy: a row activation and a trigger activation both reach it. */
  readonly onSelectEvent: Mock<(ref: PanelEventRef) => void>;

  /** The open-source spy. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;

  /** The optional disclosure report, supplied so cases can assert on it. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** The optional filter report, supplied for the same reason. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host —
 * and both optional reports are supplied too, so every case can assert not only
 * that the intent it exercised was raised but also that the others were not:
 * opening a source is not selecting a record, and disclosing a row is neither.
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
  node: StateTransitionsNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <StateTransitionViewer node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );
}

/**
 * The grid's data rows, in document order.
 *
 * Obtained by role and then narrowed by the attribute the primitive writes on a
 * data row, because the header row and any open detail row are `role="row"` too
 * and a bare role query would count them.
 *
 * @returns The data rows.
 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-row-index') !== null);
}

/** The six cells of one row, named by the column they belong to. */
interface RowCells {
  /** The row header: disclosure control, component name, optional source chip. */
  readonly component: HTMLElement;
  /** The hook's identity and the dimension that changed. */
  readonly hook: HTMLElement;
  /** The value-before summary. */
  readonly previous: HTMLElement;
  /** The trigger control, or the label standing in for one. */
  readonly trigger: HTMLElement;
  /** The value-after summary. */
  readonly next: HTMLElement;
  /** What the producer reported, and any disclosure riding on the row. */
  readonly changed: HTMLElement;
}

/**
 * One row's cells, obtained by role and mapped onto the column order.
 *
 * The order itself is pinned separately by the column-header case, so this
 * mapping is a reading of a verified contract rather than an assumption about
 * it. The row header is the first column, which is why it is fetched by its own
 * role.
 *
 * @param row A data row from {@link dataRows}.
 * @returns Its six cells.
 */
function cellsOf(row: HTMLElement): RowCells {
  const component = within(row).getByRole('rowheader');
  const [hook, previous, trigger, next, changed] = within(row).getAllByRole('gridcell');

  if (
    hook === undefined ||
    previous === undefined ||
    trigger === undefined ||
    next === undefined ||
    changed === undefined
  ) {
    throw new Error('a data row rendered fewer than the six cells of this node');
  }

  return { component, hook, previous, trigger, next, changed };
}

/**
 * The element carrying a class inside an already-obtained scope.
 *
 * The class contract of the component under test is part of what the stylesheet
 * keys on, so a state class is worth asserting — but only ever on an element
 * reached from something obtained semantically, never as a way of finding
 * content that a role or a name should have found.
 *
 * @param scope The element to search inside.
 * @param className The class to look for.
 * @returns The first matching element.
 */
function elementWithClass(scope: HTMLElement, className: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(`.${className}`);

  if (found === null) {
    throw new Error(`no element with class "${className}" was rendered inside the given scope`);
  }

  return found;
}

/**
 * The element a disclosure control's `aria-controls` names, failing when the
 * attribute is missing, names more than one id, or names nothing in the
 * document.
 *
 * Resolved through the attribute rather than by position, because this is the
 * very link assistive technology follows from the toggle to what it reveals.
 *
 * @param control The disclosure control.
 * @returns The element it controls.
 */
function controlledElementOf(control: HTMLElement): HTMLElement {
  const id = control.getAttribute('aria-controls') ?? '';

  if (id.length === 0 || /\s/u.test(id)) {
    throw new Error(`the control names no single element in aria-controls ("${id}")`);
  }

  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`aria-controls names "${id}", which is not in the document`);
  }

  return element;
}

/**
 * The one explanation bubble a cell carries, opened the way a reader opens it.
 *
 * The tooltip primitive keeps every bubble mounted — its trigger's
 * `aria-describedby` always names it — but a closed bubble carries the `hidden`
 * attribute, so it is out of the accessibility tree and no role query finds
 * it. The cell's triggers are therefore focused in document order — focus
 * opens a bubble at once — until a role query finds one bubble shown, and that
 * bubble is returned, still open, for the case to read. A trigger that showed
 * nothing is blurred again before the next one is tried.
 *
 * @param scope The cell whose explanation is wanted.
 * @returns The open bubble.
 */
function openedTooltipIn(scope: HTMLElement): HTMLElement {
  const triggers = [...scope.querySelectorAll<HTMLElement>('.dg-tooltip__trigger > *')];

  for (const trigger of triggers) {
    fireEvent.focus(trigger);

    const [bubble] = within(scope).queryAllByRole('tooltip');
    if (bubble !== undefined) {
      return bubble;
    }

    fireEvent.blur(trigger);
  }

  throw new Error('no trigger in the given scope opens an explanation');
}

/**
 * The empty state a rendered sentence belongs to, found from the sentence.
 *
 * The sentence is obtained by its text first, so the class checks below read
 * off an element already reached semantically: the sentence is the primitive's
 * message, and the block around it is this component's empty state.
 *
 * @param message The empty state's sentence, as found by its text.
 * @returns The empty-state block, for reading its title.
 */
function emptyStateOf(message: HTMLElement): HTMLElement {
  expect(message.classList.contains('dg-empty-state__message')).toBe(true);

  const block = message.parentElement;

  if (block === null) {
    throw new Error('the empty-state sentence was rendered outside any block');
  }

  expect(block.classList.contains('dg-state-transitions__empty')).toBe(true);

  return block;
}

/**
 * The text of a value cell: the summary run when the producer reported one, and
 * the cell's own text otherwise.
 *
 * Reading the summary element rather than the cell keeps the tooltip that
 * explains the privacy bound out of the comparison — that bubble is mounted for
 * the life of the cell by design (it is what makes `aria-describedby` resolve),
 * and it describes the bound rather than the value.
 *
 * @param cell A value cell from {@link cellsOf}.
 * @returns The summary as drawn.
 */
function valueTextOf(cell: HTMLElement): string {
  const summary = cell.querySelector<HTMLElement>('.dg-state-transitions__value');

  return (summary ?? cell).textContent ?? '';
}

/**
 * The value-before summary of each rendered row, in document order.
 *
 * The identity the ordering cases compare on: every fixture summary is
 * distinct, so this is a faithful projection of which row is where.
 *
 * @returns One summary per row.
 */
function renderedValuesBefore(): string[] {
  return dataRows().map((row) => valueTextOf(cellsOf(row).previous));
}

/**
 * The row whose value-before summary is `summary`.
 *
 * @param summary The summary to find.
 * @returns That row.
 */
function rowWithValueBefore(summary: string): HTMLElement {
  const row = dataRows()[renderedValuesBefore().indexOf(summary)];

  if (row === undefined) {
    throw new Error(`no rendered row shows "${summary}" as its value before`);
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
 * The detail block of the one disclosed row.
 *
 * Found by role first: the detail beneath a data row is a `role="row"` of its
 * own that carries no `data-row-index`, and the header row is the other row
 * without one, told apart by holding the column headers. The block this
 * component renders inside it is then read by its class, off that row.
 *
 * @returns The expanded row's detail block.
 */
function disclosedDetail(): HTMLElement {
  const detailRows = screen
    .getAllByRole('row')
    .filter(
      (row) =>
        row.getAttribute('data-row-index') === null &&
        within(row).queryAllByRole('columnheader').length === 0,
    );

  expect(detailRows).toHaveLength(1);

  const [detailRow] = detailRows;

  if (detailRow === undefined) {
    throw new Error('no row detail is disclosed');
  }

  return elementWithClass(detailRow, 'dg-state-transitions__detail');
}

/**
 * The value element of one captioned field of a disclosed detail.
 *
 * The caption is found by its exact text; the value is the element rendered
 * right after it, which is how the detail's fields pair a caption with what it
 * captions.
 *
 * @param detail A detail block from {@link disclosedDetail}.
 * @param caption The field's caption.
 * @returns The field's value element.
 */
function detailFieldValue(detail: HTMLElement, caption: string): HTMLElement {
  const value = within(detail).getByText(caption).nextElementSibling;

  if (!(value instanceof HTMLElement)) {
    throw new Error(`the detail field "${caption}" renders no value after its caption`);
  }

  return value;
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
 * The three transitions most cases draw
 *
 * Two components, three distinct value summaries, two distinct triggers, and
 * one resolved source location — so a per-row assertion cannot pass by matching
 * the wrong row, and the source-chip case can activate a chip that exists in
 * exactly one row.
 *
 * Contiguous by component in this order, so the default grouping is a no-op on
 * it and the rendered order is the provider's own. The interleaved,
 * deliberately non-chronological page the ordering cases use is separate.
 * ---------------------------------------------------------------------------
 */

/** A hook the producer could name, changed by an interaction it could link to. */
const WIDGET_VALUE_TRANSITION = makeTransition({
  id: 'evt_example_0001',
  spanId: spanIdFor(1),
  startTime: BASE_START_MS + 10,
  component: COMPONENT_WIDGET,
  hookIndex: 0,
  hookLabel: HOOK_VALUE_LABEL,
  previousValue: NUMBER_BEFORE,
  nextValue: NUMBER_AFTER,
  valueType: 'number',
  transitionSource: 'state',
  triggerEventId: TRIGGER_EVENT_ID,
  triggerSpanId: spanIdFor(9),
  triggerName: TRIGGER_NAME,
  triggerKind: 'interaction',
  renderSpanId: spanIdFor(8),
  fiberId: 41,
  source: BASE_SOURCE,
});

/** A second hook of the same component, which the producer could not name. */
const WIDGET_FLAG_TRANSITION = makeTransition({
  id: 'evt_example_0002',
  spanId: spanIdFor(2),
  startTime: BASE_START_MS + 20,
  component: COMPONENT_WIDGET,
  hookIndex: 2,
  previousValue: FLAG_BEFORE,
  nextValue: FLAG_AFTER,
  valueType: 'boolean',
  transitionSource: 'state',
  triggerEventId: TRIGGER_EVENT_ID,
  triggerName: TRIGGER_NAME,
  triggerKind: 'interaction',
});

/** A context value consumed by the other component, moved by a commit. */
const PANEL_CONTEXT_TRANSITION = makeTransition({
  id: 'evt_example_0003',
  spanId: spanIdFor(3),
  startTime: BASE_START_MS + 30,
  component: COMPONENT_PANEL,
  hookLabel: HOOK_FLAG_LABEL,
  previousValue: OBJECT_BEFORE,
  nextValue: OBJECT_AFTER,
  valueType: 'object',
  transitionSource: 'context',
  triggerEventId: OTHER_TRIGGER_EVENT_ID,
  triggerName: OTHER_TRIGGER_NAME,
  triggerKind: 'commit',
});

/** The three rows in the order the provider returns them below. */
const PROVIDER_ORDER: readonly StateTransition[] = [
  WIDGET_VALUE_TRANSITION,
  WIDGET_FLAG_TRANSITION,
  PANEL_CONTEXT_TRANSITION,
];

/** Their value-before summaries, in that same order. */
const PROVIDER_ORDER_VALUES: readonly string[] = PROVIDER_ORDER.map(
  (transition) => transition.previousValue ?? '',
);

/*
 * ---------------------------------------------------------------------------
 * The interleaved page the ordering cases draw
 *
 * Deliberately neither grouped by component nor chronological, so a rendered
 * order that happened to match either could not be mistaken for the provider's.
 * ---------------------------------------------------------------------------
 */

/** A widget transition, observed last of the three. */
const INTERLEAVED_FIRST = makeTransition({
  id: 'evt_example_0011',
  spanId: spanIdFor(11),
  startTime: BASE_START_MS + 30,
  component: COMPONENT_WIDGET,
  hookLabel: HOOK_VALUE_LABEL,
  previousValue: NUMBER_BEFORE,
  nextValue: NUMBER_AFTER,
  transitionSource: 'state',
  triggerEventId: TRIGGER_EVENT_ID,
  triggerName: TRIGGER_NAME,
  triggerKind: 'interaction',
});

/** A panel transition between the two widget ones, observed first. */
const INTERLEAVED_SECOND = makeTransition({
  id: 'evt_example_0012',
  spanId: spanIdFor(12),
  startTime: BASE_START_MS + 10,
  component: COMPONENT_PANEL,
  hookLabel: HOOK_FLAG_LABEL,
  previousValue: OBJECT_BEFORE,
  nextValue: OBJECT_AFTER,
  transitionSource: 'context',
  triggerEventId: OTHER_TRIGGER_EVENT_ID,
  triggerName: OTHER_TRIGGER_NAME,
  triggerKind: 'commit',
});

/** The second widget transition, observed between the other two. */
const INTERLEAVED_THIRD = makeTransition({
  id: 'evt_example_0013',
  spanId: spanIdFor(13),
  startTime: BASE_START_MS + 20,
  component: COMPONENT_WIDGET,
  hookIndex: 2,
  previousValue: FLAG_BEFORE,
  nextValue: FLAG_AFTER,
  transitionSource: 'state',
  triggerEventId: TRIGGER_EVENT_ID,
  triggerName: TRIGGER_NAME,
  triggerKind: 'interaction',
});

/** The page, in the order the provider hands it over. */
const INTERLEAVED_ORDER: readonly StateTransition[] = [
  INTERLEAVED_FIRST,
  INTERLEAVED_SECOND,
  INTERLEAVED_THIRD,
];

/** Its value-before summaries, in that order. */
const INTERLEAVED_VALUES: readonly string[] = [NUMBER_BEFORE, OBJECT_BEFORE, FLAG_BEFORE];

/** The same rows grouped by component, first appearance first. */
const GROUPED_VALUES: readonly string[] = [NUMBER_BEFORE, FLAG_BEFORE, OBJECT_BEFORE];

/** The same rows in the order they were observed, which is neither of the above. */
const CHRONOLOGICAL_VALUES: readonly string[] = [OBJECT_BEFORE, FLAG_BEFORE, NUMBER_BEFORE];

/**
 * A transition whose producer described neither side.
 *
 * `changed: false` says the record arrived with nothing showable — it is not a
 * claim that the value stayed the same, which is what the reported-state cases
 * below pin.
 */
const UNREPORTED_TRANSITION = makeTransition({
  id: 'evt_example_0021',
  spanId: spanIdFor(21),
  startTime: BASE_START_MS + 40,
  component: COMPONENT_PANEL,
  hookLabel: HOOK_FLAG_LABEL,
  transitionSource: 'state',
  changed: false,
  triggerEventId: OTHER_TRIGGER_EVENT_ID,
  triggerName: OTHER_TRIGGER_NAME,
  triggerKind: 'commit',
});

/**
 * The footer's separator, spelled once: a middle dot with single spaces around
 * it, exactly as the component composes its counts.
 */
const COUNT_SEPARATOR = ' \u00b7 ';

/**
 * The footer's counts sentence.
 *
 * Three facts, never conflated: what is drawn after the reader's own narrowing,
 * what the page holds, and what the source holds after the query's filter —
 * the last omitted entirely when the provider reported no total, because
 * nothing may be claimed about it.
 *
 * @param drawn Rows on screen.
 * @param loaded Rows in the resolved page.
 * @param total The provider's reported total, when it reported one.
 * @returns The sentence the footer renders.
 */
function countsText(drawn: number, loaded: number, total?: number): string {
  const head = `${formatCount(drawn)} shown${COUNT_SEPARATOR}${formatCount(loaded)} loaded`;

  return total === undefined ? head : `${head}${COUNT_SEPARATOR}${formatCount(total)} in total`;
}

describe('StateTransitionViewer states', () => {
  it('renders the loading state, and no rows, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes the
    // element class that places it and the label that names what is loading.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.classList.contains('dg-state-transitions__loading')).toBe(true);
    expect(busy.textContent).toContain(LOADING_LABEL);

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer.
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();

    // The footer's counts are claims about a page that exists, so none is made.
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // The toolbar stays mounted across the states, so a re-query raised from
    // one of its controls does not make that control disappear mid-interaction.
    expect(screen.getByRole('group', { name: TOOLBAR_NAME })).toBeDefined();

    // One query, issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders its own empty message, and no rows, for a successful empty page', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // Queried by a generic substring of the product's own copy, then checked to
    // be exactly that: product vocabulary, naming no inspected project.
    const message = await screen.findByText(/no state transitions were captured/i);
    expect(message.textContent).toBe(EMPTY_CAPTURE_MESSAGE);

    // The first page with no total and no page after it is the one empty page
    // that is an empty capture, so it carries neither empty-page title — it
    // carries its own, with a decorative glyph, as the settled status.
    const block = emptyStateOf(message);
    expect(within(block).queryByText(ANY_EMPTY_PAGE_TITLE)).toBeNull();
    expect(block.querySelector('.dg-empty-state__title')?.textContent).toBe(EMPTY_CAPTURE_TITLE);
    expect(block.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('status')).toBe(block);

    for (const value of PROVIDER_ORDER_VALUES) {
      expect(message.textContent).not.toContain(value);
    }
    expect(message.textContent).not.toContain(SOURCE_FILE);

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure, and there is no grid to hold rows.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);

    // A settled empty capture, reached with no narrowing of the reader's, has
    // nothing for a control to act on and no count beyond its own sentence: no
    // toolbar, no footer, and no page to load.
    expect(screen.queryByRole('group', { name: TOOLBAR_NAME })).toBeNull();
    expect(screen.queryByText(countsText(0, 0))).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-state-transitions__error')).toBe(true);

    // What failed, in the package's shared error-state design: the generic
    // lead, then the provider's own cause as a sentence of its own, plus its
    // CODE so a developer has something to search for. The cause is stated
    // inside the error box, never where an analysis goes, so it cannot read as
    // a finding about the capture.
    expect(alert.textContent).toContain(VIEW_FAILURE_LEAD);
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, including the window and offset
    // the view applied on top of what the node authored. Compared as a value
    // rather than as a spelling.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'stateTransitions',
      sort: CHRONOLOGICAL,
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

    // The shared error-state design, one for every failed node, in its fixed
    // order: the default glyph, the view-scope title, the generic lead followed
    // by the provider's own cause, the provider's hint on a line of its own,
    // the code as a chip, the query, and a retry.
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
      source: 'stateTransitions',
      sort: CHRONOLOGICAL,
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

    renderComponent(makeNode({ query: { source: 'renders' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-state-transitions__error')).toBe(true);

    // A defect in the panel rather than in the capture, said by the package's
    // one contract for it — worded from the node catalog, naming the source it
    // was asked for — with a code a developer can search for.
    expect(alert.textContent).toContain('This view cannot draw the requested data');
    expect(alert.textContent).toContain('but this panel asks it for "renders".');
    expect(alert.textContent).toContain('PANEL_INVALID');

    // The node's own query is what the reader is shown, and no retry is
    // offered: re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'renders' });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

    // Nothing was asked of the provider, and nothing was drawn as if it had
    // been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('grid')).toBeNull();
  });
});

describe('StateTransitionViewer rows', () => {
  it('draws one row per transition, with its component, hook, values and trigger', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The grid is named by the node's caption, which falls back to the catalog's
    // own label when the node carries no title. Spelled out rather than read
    // back through the catalog, so this case pins the name a reader hears.
    await screen.findByRole('grid', { name: CAPTION });
    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);

    // Six columns, left to right: the "value before → trigger → value after"
    // reading order this node's contract fixes.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      ...COLUMN_HEADERS,
    ]);

    // Three rows for two components, in the provider's own order.
    expect(renderedValuesBefore()).toEqual([...PROVIDER_ORDER_VALUES]);

    for (const transition of PROVIDER_ORDER) {
      const cells = cellsOf(rowWithValueBefore(transition.previousValue ?? ''));

      // The component is the row's header, so a reader hears the row named.
      expect(within(cells.component).getByText(transition.component ?? '')).toBeDefined();

      // The hook's identity: the producer's own label, or the hook's position
      // printed as the zero-based index it is — never a name invented here.
      const identity =
        transition.hookLabel ?? `Hook #${String(transition.hookIndex ?? Number.NaN)}`;
      expect(within(cells.hook).getByText(identity)).toBeDefined();

      // Which dimension the producer said changed, through the shared label
      // humanizer so this suite spells none of that vocabulary.
      expect(
        within(cells.hook).getByText(humanizeLabel(transition.transitionSource ?? '')),
      ).toBeDefined();

      // Both summaries, each on its own side of the row and each as given.
      expect(valueTextOf(cells.previous)).toBe(transition.previousValue);
      expect(valueTextOf(cells.next)).toBe(transition.nextValue);

      // Every one of these rows names a record, so every trigger is a control.
      expect(
        within(cells.trigger).getByRole('button', { name: transition.triggerName ?? '' }),
      ).toBeDefined();

      // And the producer described the change, so the row says exactly that.
      expect(within(cells.changed).getByText(CHANGED_LABEL)).toBeDefined();
    }

    // The order the rows are in is the order that was requested, not one
    // applied here.
    expect(soleQuery(stub).sort).toBe(CHRONOLOGICAL);
  });

  it('uses the node title as the grid caption when the node carries one', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);

    renderComponent(makeNode({ title: 'Updates during the interaction' }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: 'Updates during the interaction' });
  });

  it('shows the kind of the record a transition is attributed to', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NUMBER_BEFORE));
    expect(
      within(cells.trigger).getByText(triggerKindLabel(WIDGET_VALUE_TRANSITION.triggerKind)),
    ).toBeDefined();
  });

  it('says what the producer could not name, instead of guessing at it', async () => {
    // No component, no hook label, no hook index and no value after: four
    // absences, each of which the view has a word for. A producer that could
    // not name something is a fact about the capture, and inventing a name for
    // it would present a guess as evidence.
    const bare = makeTransition({
      id: 'evt_example_0031',
      spanId: spanIdFor(31),
      previousValue: NUMBER_BEFORE,
      triggerEventId: TRIGGER_EVENT_ID,
      triggerName: TRIGGER_NAME,
      triggerKind: 'interaction',
    });
    const stub = resolvingProvider([bare]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NUMBER_BEFORE));
    expect(within(cells.component).getByText(UNNAMED_COMPONENT_LABEL)).toBeDefined();
    expect(cells.hook.textContent).toBe(NOT_AVAILABLE_LABEL);
    expect(valueTextOf(cells.next)).toBe(NOT_AVAILABLE_LABEL);

    // An unnamed component is still a described transition, so the reported
    // column is unaffected by any of it.
    expect(within(cells.changed).getByText(CHANGED_LABEL)).toBeDefined();
  });

  it('places each summary on its own side of the row, as opaque code', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NUMBER_BEFORE));

    // Both spellings of the value cells ride on the same element: the
    // stylesheet addresses them as `__from`/`__to`, this node's contract as
    // `__previous`/`__next`.
    const before = elementWithClass(cells.previous, 'dg-state-transitions__previous');
    expect(before.classList.contains('dg-state-transitions__from')).toBe(true);

    const after = elementWithClass(cells.next, 'dg-state-transitions__next');
    expect(after.classList.contains('dg-state-transitions__to')).toBe(true);

    // A captured summary is presented as code and never as prose or as parsed
    // content: the `Code` primitive's class is the mechanical statement of it.
    const value = elementWithClass(cells.previous, 'dg-state-transitions__value');
    expect(value.classList.contains('dg-code')).toBe(true);
    expect(value.textContent).toBe(NUMBER_BEFORE);
  });
});

describe('StateTransitionViewer order', () => {
  it('renders the provider order exactly once grouping is off', async () => {
    const stub = resolvingProvider(INTERLEAVED_ORDER);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // Grouping is on by default, so it is turned off first: with it off, the
    // rendered order is the provider's array and nothing else. A local
    // `.sort()` added to the component later fails here.
    const grouping = screen.getByRole('button', { name: GROUPING_NAME });
    expect(grouping.getAttribute('aria-pressed')).toBe('true');

    await user.click(grouping);

    expect(screen.getByRole('button', { name: GROUPING_NAME }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(renderedValuesBefore()).toEqual([...INTERLEAVED_VALUES]);

    // Stated as a property too, so the intent survives a fixture change: the
    // rendered order is neither the chronological order nor the grouped one.
    expect(renderedValuesBefore()).not.toEqual([...CHRONOLOGICAL_VALUES]);
    expect(renderedValuesBefore()).not.toEqual([...GROUPED_VALUES]);

    // Grouping is presentational, so toggling it asked the provider for
    // nothing: the page on screen is still the one page that was resolved.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/grouped by component/)).toBeNull();
  });

  it('groups by component without reordering a component within itself', async () => {
    const stub = resolvingProvider(INTERLEAVED_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // A permutation and nothing more: first appearance decides a component's
    // position, and each component keeps the order the capture returned —
    // which is the only order this view may claim.
    expect(renderedValuesBefore()).toEqual([...GROUPED_VALUES]);
    expect([...renderedValuesBefore()].sort()).toEqual([...INTERLEAVED_VALUES].sort());

    // The two widget rows are still in the provider's relative order.
    const drawn = renderedValuesBefore();
    expect(drawn.indexOf(NUMBER_BEFORE)).toBeLessThan(drawn.indexOf(FLAG_BEFORE));

    // Nothing was merged, summed or dropped, and no chronological order was
    // imposed on the way.
    expect(dataRows()).toHaveLength(INTERLEAVED_ORDER.length);
    expect(drawn).not.toEqual([...CHRONOLOGICAL_VALUES]);

    // And the footer says the rows are grouped, so a reader is never left
    // inferring an order the capture did not report.
    expect(screen.getByText(/grouped by component/)).toBeDefined();
  });
});

describe('StateTransitionViewer value summaries', () => {
  it('renders a summary at the capture bound byte-identically', async () => {
    // The fixture's own bound, asserted before the rendering it is about: a
    // padded fixture that drifted past 120 code points would otherwise make
    // this case pass for the wrong reason.
    expect([...AT_BOUND_SUMMARY]).toHaveLength(MAX_PREVIEW_LENGTH);

    const stub = resolvingProvider([
      makeTransition({
        id: 'evt_example_0041',
        spanId: spanIdFor(41),
        component: COMPONENT_WIDGET,
        hookLabel: HOOK_VALUE_LABEL,
        previousValue: AT_BOUND_SUMMARY,
        nextValue: NUMBER_AFTER,
        valueType: 'object',
        transitionSource: 'state',
        triggerEventId: TRIGGER_EVENT_ID,
        triggerName: TRIGGER_NAME,
        triggerKind: 'interaction',
      }),
    ]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(AT_BOUND_SUMMARY));
    const value = elementWithClass(cells.previous, 'dg-state-transitions__value');

    // Byte-identical: the producer's string, not a re-quoted, re-serialised or
    // pretty-printed rendering of it.
    expect(value.textContent).toBe(AT_BOUND_SUMMARY);
    expect(value.textContent).not.toBe(JSON.stringify(AT_BOUND_SUMMARY));
    expect(value.textContent?.startsWith('"')).toBe(false);

    // Nothing shortened it, so no truncation is claimed either.
    expect(value.classList.contains('dg-is-truncated')).toBe(false);
    expect(value.textContent).not.toContain(ELLIPSIS);
  });

  it('offers no control to expand, parse or reveal a summary', async () => {
    const stub = resolvingProvider([
      makeTransition({
        id: 'evt_example_0042',
        spanId: spanIdFor(42),
        component: COMPONENT_WIDGET,
        hookLabel: HOOK_VALUE_LABEL,
        previousValue: AT_BOUND_SUMMARY,
        nextValue: OVER_BOUND_SUMMARY,
        transitionSource: 'state',
        triggerEventId: TRIGGER_EVENT_ID,
        triggerName: TRIGGER_NAME,
        triggerKind: 'interaction',
      }),
    ]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(AT_BOUND_SUMMARY));

    // The producer captures only a bounded, redacted summary and no opt-in for
    // the full value exists, so an affordance promising one would promise
    // something this product deliberately cannot deliver. Neither value cell
    // holds a control of any kind — not a button, not a link, not a checkbox.
    for (const cell of [cells.previous, cells.next]) {
      expect(within(cell).queryAllByRole('button')).toHaveLength(0);
      expect(within(cell).queryAllByRole('link')).toHaveLength(0);
      expect(within(cell).queryAllByRole('checkbox')).toHaveLength(0);
      expect(cell.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);
    }
  });

  it('shortens a summary past the bound rather than widening what it shows', async () => {
    const expected = oneLinePreview(OVER_BOUND_SUMMARY);

    // The renderer's own bound is the producer's: it can never present more
    // than the capture was allowed to take.
    expect([...expected]).toHaveLength(MAX_PREVIEW_LENGTH);
    expect(expected.endsWith(ELLIPSIS)).toBe(true);

    const stub = resolvingProvider([
      makeTransition({
        id: 'evt_example_0043',
        spanId: spanIdFor(43),
        component: COMPONENT_WIDGET,
        hookLabel: HOOK_VALUE_LABEL,
        previousValue: OVER_BOUND_SUMMARY,
        nextValue: NUMBER_AFTER,
        transitionSource: 'state',
        triggerEventId: TRIGGER_EVENT_ID,
        triggerName: TRIGGER_NAME,
        triggerKind: 'interaction',
      }),
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(expected));
    const value = elementWithClass(cells.previous, 'dg-state-transitions__value');

    expect(value.textContent).toBe(expected);
    expect(value.classList.contains('dg-is-truncated')).toBe(true);

    // The cell says that it shortened something, and explains the bound rather
    // than offering the rest.
    const hint = openedTooltipIn(cells.previous);
    expect(hint.textContent).toContain('bounded summary');
    expect(within(cells.previous).queryAllByRole('button')).toHaveLength(0);

    // The part past the bound reached no part of the document — not the cell,
    // not a title attribute, not a tooltip. The shortened summary carries no
    // title at all: its hover belongs to the tooltip explaining the bound.
    expect(document.body.textContent).not.toContain(OVER_BOUND_TAIL);
    expect(value.getAttribute('title')).toBeNull();
    const titles = [...document.querySelectorAll('[title]')].map(
      (element) => element.getAttribute('title') ?? '',
    );
    expect(titles.some((title) => title.includes(OVER_BOUND_TAIL))).toBe(false);

    // And disclosing the row's detail does not produce it: the detail repeats
    // the row's displayed summary — the shortened preview, whole — and never a
    // fuller value.
    await user.click(
      within(cells.component).getByRole('button', { name: showDetailsName(WIDGET_VALUE_IDENTITY) }),
    );
    await screen.findByRole('button', { name: hideDetailsName(WIDGET_VALUE_IDENTITY) });

    expect(detailFieldValue(disclosedDetail(), 'Value before').textContent).toBe(expected);
    expect(document.body.textContent).not.toContain(OVER_BOUND_TAIL);
    expect(document.body.textContent).not.toContain(OVER_BOUND_SUMMARY);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Clipped cells
 *
 * Every cell is bounded to its grid track, so a summary, a name or a trigger
 * label wider than the track ellipsizes inside it rather than painting across
 * the next column. These cases pin where the clipped part of the DISPLAYED
 * text stays readable, and the stylesheet rules that do the bounding.
 * ---------------------------------------------------------------------------
 */

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

/** One declaration of a stylesheet rule, as written. */
interface Declaration {
  /** The property name. */
  readonly property: string;
  /** The value, trimmed, without the terminating semicolon. */
  readonly value: string;
}

/**
 * Every declaration of every rule in {@link COMPONENT_STYLESHEET} whose
 * selector list names `selector` exactly, in source order, failing when no rule
 * names it.
 *
 * Comments are removed first, so prose that quotes a declaration cannot satisfy
 * or fail an assertion. A rule nested in an at-rule is read like a top-level
 * one: the pattern only ever matches an innermost brace pair. An exact entry of
 * a comma-separated list is required, so `.a.b` or `.a:hover` never stands in
 * for `.a`.
 *
 * @param selector One selector, exactly as it is written in its list.
 * @returns The declarations of every rule naming it.
 */
function declarationsFor(selector: string): Declaration[] {
  const sheet = COMPONENT_STYLESHEET.replace(/\/\*[\s\S]*?\*\//gu, '');
  const declarations: Declaration[] = [];
  let rules = 0;

  for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const [, selectorList = '', body = ''] = match;
    const selectors = selectorList.split(',').map((entry) => entry.trim());

    if (!selectors.includes(selector)) {
      continue;
    }

    rules += 1;

    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');

      if (colon > 0) {
        declarations.push({
          property: declaration.slice(0, colon).trim(),
          value: declaration.slice(colon + 1).trim(),
        });
      }
    }
  }

  expect(rules).toBeGreaterThan(0);

  return declarations;
}

describe('StateTransitionViewer clipped cells', () => {
  it("carries a whole summary's displayed text as its title, and gives a shortened one none", async () => {
    const shortened = oneLinePreview(OVER_BOUND_SUMMARY);
    const stub = resolvingProvider([
      makeTransition({
        id: 'evt_example_0044',
        spanId: spanIdFor(44),
        component: COMPONENT_WIDGET,
        hookLabel: HOOK_VALUE_LABEL,
        previousValue: AT_BOUND_SUMMARY,
        nextValue: OVER_BOUND_SUMMARY,
        transitionSource: 'state',
        triggerEventId: TRIGGER_EVENT_ID,
        triggerName: TRIGGER_NAME,
        triggerKind: 'interaction',
      }),
    ]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(AT_BOUND_SUMMARY));

    // Shown whole, so its title is its displayed text byte for byte: a cell
    // that clips it still lets the reader hover the rest into view.
    const whole = elementWithClass(cells.previous, 'dg-state-transitions__value');
    expect(whole.classList.contains('dg-is-truncated')).toBe(false);
    expect(whole.getAttribute('title')).toBe(AT_BOUND_SUMMARY);
    expect(whole.getAttribute('title')).toBe(whole.textContent);

    // Shortened by the display bound, so no title: its hover belongs to the
    // tooltip explaining the bound, and there is no fuller string to put there.
    const cut = elementWithClass(cells.next, 'dg-state-transitions__value');
    expect(cut.classList.contains('dg-is-truncated')).toBe(true);
    expect(cut.textContent).toBe(shortened);
    expect(cut.getAttribute('title')).toBeNull();
    expect(document.body.innerHTML).not.toContain(OVER_BOUND_TAIL);
  });

  it('names every clipped component, hook, trigger and chip in full as its own title', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    for (const transition of PROVIDER_ORDER) {
      const cells = cellsOf(rowWithValueBefore(transition.previousValue ?? ''));
      const component = transition.component ?? '';
      const hook = transition.hookLabel ?? `Hook #${String(transition.hookIndex ?? Number.NaN)}`;
      const dimension = humanizeLabel(transition.transitionSource ?? '');
      const trigger = transition.triggerName ?? '';
      const kind = triggerKindLabel(transition.triggerKind);

      expect(within(cells.component).getByText(component).getAttribute('title')).toBe(component);
      expect(within(cells.hook).getByText(hook).getAttribute('title')).toBe(hook);

      // The title repeats the label; the control's accessible name is still
      // its label, which is how it was found.
      expect(
        within(cells.trigger).getByRole('button', { name: trigger }).getAttribute('title'),
      ).toBe(trigger);

      // A chip clips at its own border in a track narrower than its word, so
      // each plain chip carries its word whole as its title too.
      for (const [cell, word] of [
        [cells.hook, dimension],
        [cells.trigger, kind],
        [cells.changed, CHANGED_LABEL],
      ] as const) {
        const chip = within(cell).getByText(word).closest<HTMLElement>('.dg-badge');

        expect(chip?.getAttribute('title')).toBe(word);
      }
    }
  });

  it('lets the chips of the trigger and hook cells wrap onto a line of their own', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NUMBER_BEFORE));

    // The trigger control and its kind chip share one Stack, found from the
    // control, which is the cell's semantic anchor.
    const control = within(cells.trigger).getByRole('button', { name: TRIGGER_NAME });
    const triggerStack = control.closest<HTMLElement>('.dg-stack');

    if (triggerStack === null) {
      throw new Error('the trigger control was rendered outside any Stack');
    }

    expect(triggerStack.classList.contains('dg-stack--wrap')).toBe(true);
    expect(
      within(triggerStack).getByText(triggerKindLabel(WIDGET_VALUE_TRANSITION.triggerKind)),
    ).toBeDefined();

    // The hook label and its changed-dimension chip, likewise.
    const hookStack = elementWithClass(cells.hook, 'dg-state-transitions__hook');
    expect(hookStack.classList.contains('dg-stack')).toBe(true);
    expect(hookStack.classList.contains('dg-stack--wrap')).toBe(true);
    expect(within(hookStack).getByText(humanizeLabel('state'))).toBeDefined();
  });

  it("repeats the row's identity and both displayed summaries, unclipped, in its detail", async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NUMBER_BEFORE));
    const rowBefore = valueTextOf(cells.previous);
    const rowAfter = valueTextOf(cells.next);

    // The row's one disclosure toggle, named by the row's identity (see
    // {@link showDetailsName}); the cell holds no other "Show details" control.
    await user.click(within(cells.component).getByRole('button', { name: /^Show details of / }));

    const detail = disclosedDetail();

    expect(detailFieldValue(detail, 'Component').textContent).toBe(COMPONENT_WIDGET);
    expect(detailFieldValue(detail, 'Hook').textContent).toBe(HOOK_VALUE_LABEL);

    // Byte-identical to what the row displays, so the detail shows the part a
    // cell clips and nothing the row was not given.
    const before = detailFieldValue(detail, 'Value before');
    const after = detailFieldValue(detail, 'Value after');
    expect(before.textContent).toBe(rowBefore);
    expect(before.textContent).toBe(NUMBER_BEFORE);
    expect(after.textContent).toBe(rowAfter);
    expect(after.textContent).toBe(NUMBER_AFTER);

    // Opaque code that wraps instead of clipping, and not a second row summary:
    // the row-summary class is the one the stylesheet clips to a single line.
    for (const value of [before, after]) {
      expect(value.classList.contains('dg-code')).toBe(true);
      expect(value.classList.contains('dg-code--wrap')).toBe(true);
      expect(value.classList.contains('dg-state-transitions__value')).toBe(false);
    }

    // The row's own summaries are still the only ones the row helpers read.
    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE]);
  });

  it('says in its detail what the producer could not name or describe', async () => {
    const bare = makeTransition({
      id: 'evt_example_0045',
      spanId: spanIdFor(45),
      previousValue: NUMBER_BEFORE,
      triggerEventId: TRIGGER_EVENT_ID,
      triggerName: TRIGGER_NAME,
      triggerKind: 'interaction',
    });
    const stub = resolvingProvider([bare]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NUMBER_BEFORE));

    // The row's one disclosure toggle, named by the row's identity (see
    // {@link showDetailsName}); the cell holds no other "Show details" control.
    await user.click(within(cells.component).getByRole('button', { name: /^Show details of / }));

    const detail = disclosedDetail();

    // The same words the row uses for each absence, never a guess.
    expect(detailFieldValue(detail, 'Component').textContent).toBe(UNNAMED_COMPONENT_LABEL);
    expect(detailFieldValue(detail, 'Hook').textContent).toBe(NOT_AVAILABLE_LABEL);
    expect(detailFieldValue(detail, 'Value before').textContent).toBe(NUMBER_BEFORE);

    const after = detailFieldValue(detail, 'Value after');
    expect(after.textContent).toBe(NOT_AVAILABLE_LABEL);
    expect(after.classList.contains('dg-code')).toBe(false);
  });

  it('bounds each value, trigger and chip to its own cell in the stylesheet', () => {
    // The value cells: bounded to the track, and no display or cross-axis
    // alignment of their own — an inline-flex, baseline-aligned cell once let
    // the summary's row size itself from its content, so the ellipsis never
    // triggered and a long summary painted across the next column.
    for (const selector of [
      '.dg-state-transitions__from',
      '.dg-state-transitions__to',
      '.dg-state-transitions__previous',
      '.dg-state-transitions__next',
    ]) {
      const declarations = declarationsFor(selector);
      const properties = declarations.map((declaration) => declaration.property);

      expect(declarations).toContainEqual({ property: 'min-inline-size', value: '0' });
      expect(declarations).toContainEqual({
        property: 'max-inline-size',
        value: 'var(--dg-size-full)',
      });
      expect(properties).not.toContain('display');
      expect(properties).not.toContain('align-items');
    }

    // The summary itself ellipsizes on one line inside that bound.
    const summary = declarationsFor('.dg-state-transitions__value');
    expect(summary).toContainEqual({ property: 'min-inline-size', value: '0' });
    expect(summary).toContainEqual({ property: 'max-inline-size', value: 'var(--dg-size-full)' });
    expect(summary).toContainEqual({ property: 'overflow', value: 'hidden' });
    expect(summary).toContainEqual({ property: 'text-overflow', value: 'ellipsis' });
    expect(summary).toContainEqual({ property: 'white-space', value: 'nowrap' });

    // The trigger control may shrink below its label inside its track.
    const trigger = declarationsFor('.dg-state-transitions__trigger');
    expect(trigger).toContainEqual({ property: 'min-inline-size', value: '0' });
    expect(trigger).toContainEqual({ property: 'max-inline-size', value: 'var(--dg-size-full)' });

    // And every chip in a row's cells shrinks with its cell and clips at its
    // own border instead of overflowing into the next column.
    const chip = declarationsFor('.dg-state-transitions .dg-data-table__cell .dg-badge');
    expect(chip).toContainEqual({ property: 'min-inline-size', value: '0' });
    expect(chip).toContainEqual({ property: 'overflow', value: 'hidden' });
  });
});

describe('StateTransitionViewer trigger', () => {
  it('links a trigger the capture attributed, and reports only that record', async () => {
    const stub = resolvingProvider([WIDGET_FLAG_TRANSITION]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const row = rowWithValueBefore(FLAG_BEFORE);
    const control = within(cellsOf(row).trigger).getByRole('button', { name: TRIGGER_NAME });

    // Rendering a control is not activating it.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();

    await user.click(control);

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    // The record id alone. The row's own span and trace describe the
    // TRANSITION, not the trigger, so attaching them here would tell the host
    // to look for the trigger inside the transition's span.
    expect(call[0]).toEqual({ eventId: TRIGGER_EVENT_ID });
    expect(Object.keys(call[0])).toEqual(['eventId']);

    // Activating a control inside a row is not activating the row, and it is
    // neither a source request nor a filter.
    expect(dataRows()[0]?.getAttribute('aria-selected')).toBe('false');
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('says a trigger is undetermined without ever claiming the value was unchanged', async () => {
    // Nothing to attribute the transition to: no record id, no span id, no
    // name and no kind. The producer described the change itself, so this row
    // is a described transition with an undetermined trigger — the one
    // combination that makes the distinction visible.
    const undetermined = makeTransition({
      id: 'evt_example_0051',
      spanId: spanIdFor(51),
      component: COMPONENT_WIDGET,
      hookLabel: HOOK_VALUE_LABEL,
      previousValue: NUMBER_BEFORE,
      nextValue: NUMBER_AFTER,
      transitionSource: 'state',
      changed: true,
    });
    const stub = resolvingProvider([undetermined]);
    const spies = makeActions();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const row = rowWithValueBefore(NUMBER_BEFORE);
    const cells = cellsOf(row);

    // An explicit label, and not a control: there is nothing to open, and a
    // disabled control dressed as a link would suggest otherwise.
    const label = within(cells.trigger).getByText(UNDETERMINED_LABEL);
    expect(label.tagName.toLowerCase()).not.toBe('button');
    expect(within(cells.trigger).queryAllByRole('button')).toHaveLength(0);
    expect(within(cells.trigger).queryAllByRole('link')).toHaveLength(0);
    expect(within(cells.trigger).queryByRole('button', { name: GENERIC_TRIGGER_LABEL })).toBeNull();

    // Why it reads that way, and what is explicitly NOT being claimed.
    const hint = openedTooltipIn(cells.trigger);
    expect(hint.textContent).toContain('Nothing is claimed about what caused it');

    // "No trigger could be determined" and "the value did not change" are
    // different findings with different consequences, and only one of them
    // could support a conclusion about a re-render. This row asserts the first
    // and must not imply the second anywhere in its text.
    expect(cells.trigger.textContent).not.toMatch(/unchanged/iu);
    expect(row.textContent).not.toMatch(/unchanged/iu);

    // The reported column is untouched by an undetermined trigger: the
    // producer described this change, so the row says so.
    expect(within(cells.changed).getByText(CHANGED_LABEL)).toBeDefined();
    expect(within(cells.changed).queryByText(UNREPORTED_LABEL)).toBeNull();
    expect(
      elementWithClass(cells.changed, 'dg-state-transitions__changed').classList.contains(
        'dg-is-changed',
      ),
    ).toBe(true);
  });

  it('explains a trigger it knows of but cannot open, instead of calling it undetermined', async () => {
    // A producer that named a trigger SPAN outside the loaded page: the
    // attribution exists, the record to open does not, and those are two
    // different facts from "nothing could be attributed".
    const outsidePage = makeTransition({
      id: 'evt_example_0052',
      spanId: spanIdFor(52),
      component: COMPONENT_WIDGET,
      hookLabel: HOOK_VALUE_LABEL,
      previousValue: FLAG_BEFORE,
      nextValue: FLAG_AFTER,
      transitionSource: 'state',
      triggerSpanId: spanIdFor(9),
    });
    const stub = resolvingProvider([outsidePage]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(FLAG_BEFORE));

    expect(within(cells.trigger).getByText(GENERIC_TRIGGER_LABEL)).toBeDefined();
    expect(within(cells.trigger).queryByText(UNDETERMINED_LABEL)).toBeNull();
    expect(within(cells.trigger).queryAllByRole('button')).toHaveLength(0);

    const hint = openedTooltipIn(cells.trigger);
    expect(hint.textContent).toContain('outside the page loaded here');
    expect(cells.trigger.textContent).not.toMatch(/unchanged/iu);
  });
});

describe('StateTransitionViewer reported state', () => {
  it('marks a row whose values were not reported, and denies the equality reading', async () => {
    const stub = resolvingProvider([UNREPORTED_TRANSITION]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NOT_AVAILABLE_LABEL));

    // A word, not a colour: the state is legible to a reader who cannot see
    // the tone at all. The chip's own text IS the indicator.
    const badge = within(cells.changed).getByText(UNREPORTED_LABEL);
    expect(badge.textContent).toBe(UNREPORTED_LABEL);
    expect(badge.classList.contains('dg-badge')).toBe(true);

    // The stylesheet's state hook for the same row. `dg-is-unchanged` is the
    // class the sheet keys on; the WORD on screen is the honest one, and this
    // case pins both so neither can drift into the other.
    const state = elementWithClass(cells.changed, 'dg-state-transitions__changed');
    expect(state.classList.contains('dg-is-unchanged')).toBe(true);
    expect(state.classList.contains('dg-is-changed')).toBe(false);

    // And the sentence that keeps the two findings apart, in full.
    const hint = openedTooltipIn(cells.changed);
    expect(hint.textContent).toContain('not a statement that the value stayed the same');

    // Neither side is shown, because neither was described — said as "not
    // available" rather than as an empty value.
    expect(valueTextOf(cells.previous)).toBe(NOT_AVAILABLE_LABEL);
    expect(valueTextOf(cells.next)).toBe(NOT_AVAILABLE_LABEL);
    expect(within(cells.changed).queryByText(CHANGED_LABEL)).toBeNull();
  });

  it('marks a row the producer could describe as changed, with no hedging', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NUMBER_BEFORE));

    const badge = within(cells.changed).getByText(CHANGED_LABEL);
    expect(badge.textContent).toBe(CHANGED_LABEL);

    const state = elementWithClass(cells.changed, 'dg-state-transitions__changed');
    expect(state.classList.contains('dg-is-changed')).toBe(true);
    expect(state.classList.contains('dg-is-unchanged')).toBe(false);

    // Nothing to qualify, so nothing qualifies it: no unreported chip, no
    // disclosure chip and no explanatory bubble in this cell at all.
    expect(within(cells.changed).queryByText(UNREPORTED_LABEL)).toBeNull();
    expect(within(cells.changed).queryByText(TRUNCATED_LABEL)).toBeNull();
    expect(within(cells.changed).queryAllByRole('tooltip')).toHaveLength(0);
    expect(cells.changed.querySelectorAll('.dg-tooltip')).toHaveLength(0);
  });

  it('draws the capture truncation disclosure as a disclosure, not as a transition', async () => {
    // The aggregate's sentinel: it discloses that a bound cut the transition
    // list, describes no value, and must never be read as one.
    const sentinel = makeTransition({
      id: 'evt_example_0061',
      spanId: spanIdFor(61),
      startTime: BASE_START_MS + 50,
      changed: false,
      truncated: true,
      droppedTransitions: 12,
    });
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION, sentinel]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // The toolbar warns that the page is incomplete, once for the whole page.
    expect(screen.getByText(TRUNCATED_LABEL)).toBeDefined();

    const cells = cellsOf(rowWithValueBefore(NOT_AVAILABLE_LABEL));

    // The count is printed because the producer disclosed one, and the bubble
    // says it is a floor rather than a total.
    expect(within(cells.changed).getByText(`${TRUNCATED_LABEL}: ${formatCount(12)}`)).toBeDefined();

    const hint = openedTooltipIn(cells.changed);
    expect(hint.textContent).toContain('not a total');

    // It describes a list and no value, so it claims neither state of the
    // reported column.
    expect(within(cells.changed).queryByText(CHANGED_LABEL)).toBeNull();
    expect(within(cells.changed).queryByText(UNREPORTED_LABEL)).toBeNull();

    // The real transition beside it is unaffected.
    const described = cellsOf(rowWithValueBefore(NUMBER_BEFORE));
    expect(within(described.changed).getByText(CHANGED_LABEL)).toBeDefined();
  });
});

describe('StateTransitionViewer interactions', () => {
  it('hands the host the very location a transition resolved to, and selects nothing', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);
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
    // `confidence` and an invented extra field both fail here. This handler is
    // the first hop of the path a click takes to the editor, and every hop
    // after it acts on the object it is handed (see `docs/ARCHITECTURE.md`,
    // "A click, end to end").
    expect(received).toEqual(BASE_SOURCE);
    expect(Object.keys(received).sort()).toEqual(expectedKeys);
    expect(received.file).toBe(SOURCE_FILE);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.line).toBe(SOURCE_LINE);
    expect(received.column).toBe(SOURCE_COLUMN);
    expect(received.symbol).toBe(SOURCE_SYMBOL);

    // Opening source is not selecting a record, disclosing a row or filtering:
    // the chip's activation stops at the chip.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('draws no chip for a transition the capture could not resolve to a location', async () => {
    const stub = resolvingProvider([WIDGET_FLAG_TRANSITION]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(FLAG_BEFORE));
    expect(cells.component.textContent).not.toContain(SOURCE_FILE);
    expect(within(cells.component).queryByRole('button', { name: SOURCE_CHIP_NAME })).toBeNull();
  });

  it('announces an activated row as the transition it stands for', async () => {
    const stub = resolvingProvider([WIDGET_FLAG_TRANSITION]);
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
    // that row's own transition and nothing else.
    expect(ref).toEqual({
      eventId: WIDGET_FLAG_TRANSITION.eventId,
      spanId: WIDGET_FLAG_TRANSITION.spanId,
      traceId: WIDGET_FLAG_TRANSITION.traceId,
    });
    expect(Object.keys(ref).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // The row shows that the click landed where the reader aimed.
    expect(dataRows()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('discloses one row of identifiers on request, and reports the disclosure', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    const cells = cellsOf(rowWithValueBefore(NUMBER_BEFORE));

    await user.click(
      within(cells.component).getByRole('button', { name: showDetailsName(WIDGET_VALUE_IDENTITY) }),
    );

    expect(spies.onExpand).toHaveBeenCalledTimes(1);
    expect(spies.onExpand).toHaveBeenCalledWith(NODE_ID, WIDGET_VALUE_TRANSITION.id, true);

    // Identifiers and categories, which the columns have no room for. The two
    // summaries the detail repeats are the row's own displayed strings — the
    // clipped-cell cases pin that — because this panel holds nothing more of
    // them.
    expect(screen.getByText(WIDGET_VALUE_TRANSITION.eventId)).toBeDefined();
    expect(screen.getByText(WIDGET_VALUE_TRANSITION.traceId)).toBeDefined();

    // The same control now offers the opposite action, and the second
    // activation is reported as a collapse rather than as another disclosure —
    // a host told "expanded" twice would keep a row open that is closed.
    await user.click(screen.getByRole('button', { name: hideDetailsName(WIDGET_VALUE_IDENTITY) }));

    expect(spies.onExpand).toHaveBeenCalledTimes(2);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, WIDGET_VALUE_TRANSITION.id, false);

    // Disclosing a row is not selecting its record.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
  });

  it('names each disclosure toggle by the row it opens, and reports its state on the toggle', async () => {
    // A row neither component nor hook of which the producer could name: its
    // toggle says the component is not named and adds no hook at all, rather
    // than a guessed name or a not-available token.
    const bare = makeTransition({
      id: 'evt_example_0032',
      spanId: spanIdFor(32),
      startTime: BASE_START_MS + 50,
      previousValue: OBJECT_AFTER,
      triggerEventId: TRIGGER_EVENT_ID,
      triggerName: TRIGGER_NAME,
      triggerKind: 'interaction',
    });
    const stub = resolvingProvider([...PROVIDER_ORDER, bare]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // One toggle per row, named by that row's component and — when the
    // producer identified one — its hook label or index, in the row's order.
    const expected: readonly { readonly component: string; readonly identity: string }[] = [
      { component: COMPONENT_WIDGET, identity: WIDGET_VALUE_IDENTITY },
      { component: COMPONENT_WIDGET, identity: WIDGET_SECOND_HOOK_IDENTITY },
      { component: COMPONENT_PANEL, identity: `${COMPONENT_PANEL} ${HOOK_FLAG_LABEL}` },
      { component: UNNAMED_COMPONENT_LABEL, identity: UNNAMED_COMPONENT_LABEL },
    ];
    const rows = dataRows();
    expect(rows).toHaveLength(expected.length);

    rows.forEach((row, index) => {
      const entry = expected[index];
      if (entry === undefined) {
        throw new Error(`no expected identity for row ${String(index)}`);
      }

      const cells = cellsOf(row);
      const toggle = within(cells.component).getByRole('button', {
        name: showDetailsName(entry.identity),
      });

      // The name contains the component the row header shows beside it, and
      // never the not-available token a missing hook would otherwise leave.
      expect(within(cells.component).getByText(entry.component)).toBeDefined();
      expect(toggle.getAttribute('aria-label')).toContain(entry.component);
      expect(toggle.getAttribute('aria-label')).not.toContain(NOT_AVAILABLE_LABEL);

      // Closed: the toggle says so and names no element, since the detail row
      // it would control is not in the document.
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.hasAttribute('aria-controls')).toBe(false);
      expect(row.hasAttribute('aria-expanded')).toBe(false);
    });

    // No two rows of this page share a toggle name.
    const names = screen
      .getAllByRole('button', { name: /^Show details of / })
      .map((toggle) => toggle.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);

    // Opened: the same control takes the opposite action for the same row,
    // reports the open state, and names the detail row it revealed.
    const [firstRow] = rows;
    if (firstRow === undefined) {
      throw new Error('the grid rendered no data row');
    }

    await user.click(
      within(cellsOf(firstRow).component).getByRole('button', {
        name: showDetailsName(WIDGET_VALUE_IDENTITY),
      }),
    );

    const opened = within(cellsOf(firstRow).component).getByRole('button', {
      name: hideDetailsName(WIDGET_VALUE_IDENTITY),
    });
    expect(opened.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(controlledElementOf(opened)).getByText(WIDGET_VALUE_TRANSITION.eventId),
    ).toBeDefined();
    expect(firstRow.hasAttribute('aria-expanded')).toBe(false);
  });
});

describe('StateTransitionViewer narrowing', () => {
  it('turns a component choice into a new query, and follows the response', async () => {
    const stub = pagingProvider([
      { data: PROVIDER_ORDER },
      { data: [PANEL_CONTEXT_TRANSITION] },
      { data: PROVIDER_ORDER },
    ]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    expect(soleQuery(stub).filter).toBeUndefined();

    const picker = screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME });
    expect(within(picker).getByRole('option', { name: ALL_COMPONENTS_LABEL })).toBeDefined();

    await user.selectOptions(picker, COMPONENT_PANEL);

    // A narrowing is a re-query against the whole capture, not a filter over
    // the page that happens to be loaded.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const narrowed = queryOfCall(stub, 2);
    expect(narrowed.filter).toEqual({ component: COMPONENT_PANEL });
    expect(narrowed.source).toBe('stateTransitions');
    expect(narrowed.sort).toBe(CHRONOLOGICAL);
    expect(narrowed.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    // And the rows follow that response.
    await waitFor(() => {
      expect(renderedValuesBefore()).toEqual([OBJECT_BEFORE]);
    });

    // The host is told, so it can remember the reader's choice — as the whole
    // toolbar state, the same snapshot every other control reports, so the
    // latest report alone restores the view.
    expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).toHaveBeenCalledWith(NODE_ID, {
      sort: CHRONOLOGICAL,
      component: COMPONENT_PANEL,
      changedOnly: 'false',
      grouped: 'true',
    });

    // Widening again clears the narrowing on the query rather than keeping it
    // and filtering locally.
    const reopened = screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME });
    await user.selectOptions(
      reopened,
      within(reopened).getByRole('option', { name: ALL_COMPONENTS_LABEL }),
    );

    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3).filter).toBeUndefined();
    // "Every component" is spelled by the narrowing's absence, never by a
    // sentinel value a host would have to know.
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, {
      sort: CHRONOLOGICAL,
      changedOnly: 'false',
      grouped: 'true',
    });
  });

  it('merges a reader narrowing into the filter the node authored', async () => {
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: [PANEL_CONTEXT_TRANSITION] }]);
    const user = userEvent.setup();

    renderComponent(
      makeNode({
        query: {
          source: 'stateTransitions',
          sort: CHRONOLOGICAL,
          filter: { traceId: TRACE_ID },
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid');
    expect(soleQuery(stub).filter).toEqual({ traceId: TRACE_ID });

    await user.selectOptions(
      screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME }),
      COMPONENT_PANEL,
    );

    // The node's own narrowing survives: a panel that asked for one
    // interaction still means one interaction after the reader narrows further.
    expect(queryOfCall(stub, 2).filter).toEqual({
      traceId: TRACE_ID,
      component: COMPONENT_PANEL,
    });
  });

  it('turns an order choice into a new query rather than re-ranking the page', async () => {
    // The second page is the same three transitions in a different order,
    // which is the only way to tell "the rows follow the new response" from
    // "the rows were re-ordered in the browser". Both pages are contiguous by
    // component, so the presentational grouping cannot account for either.
    const reordered: readonly StateTransition[] = [
      PANEL_CONTEXT_TRANSITION,
      WIDGET_VALUE_TRANSITION,
      WIDGET_FLAG_TRANSITION,
    ];
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: reordered }]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    expect(renderedValuesBefore()).toEqual([...PROVIDER_ORDER_VALUES]);

    const order = screen.getByRole('combobox', { name: ORDER_CONTROL_NAME });
    expect(within(order).getByRole('option', { name: LONGEST_FIRST_LABEL })).toBeDefined();

    // The name is the visible label, whole: a label bound to the control and
    // shown on screen, so what a sighted reader sees is what speech input can
    // say (WCAG 2.5.3) — and it names what it orders, unlike a bare "Order"
    // another table's control would share.
    const orderLabel = screen.getByText(ORDER_CONTROL_NAME);
    expect(orderLabel.tagName).toBe('LABEL');
    expect(orderLabel.getAttribute('for')).toBe(order.id);
    expect(orderLabel.classList.contains('dg-visually-hidden')).toBe(false);

    await user.selectOptions(order, LONGEST_FIRST);

    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const requeried = queryOfCall(stub, 2);
    expect(requeried.sort).toBe(LONGEST_FIRST);
    expect(requeried.source).toBe('stateTransitions');
    // A new order is a new page sequence, so it starts at the node's offset.
    expect(requeried.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    await waitFor(() => {
      expect(renderedValuesBefore()).toEqual([OBJECT_BEFORE, NUMBER_BEFORE, FLAG_BEFORE]);
    });
  });

  it('states the scope of the local changed-only narrowing in its counts', async () => {
    const stub = resolvingProvider(
      [WIDGET_VALUE_TRANSITION, WIDGET_FLAG_TRANSITION, UNREPORTED_TRANSITION],
      { total: 3 },
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    expect(dataRows()).toHaveLength(3);

    const toggle = screen.getByRole('button', { name: CHANGED_ONLY_NAME });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    await user.click(toggle);

    expect(
      screen.getByRole('button', { name: CHANGED_ONLY_NAME }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(dataRows()).toHaveLength(2);

    // Client-side, so no page was requested for it...
    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // ...and because it is client-side, the footer both separates the three
    // counts and says plainly which of them the narrowing applies to. A filter
    // that silently covered part of the evidence would misrepresent the rest.
    expect(screen.getByText(countsText(2, 3, 3))).toBeDefined();
    expect(screen.getByText(/applies to the rows loaded here/)).toBeDefined();
  });

  it('says when a reader narrowing emptied the page, not the capture', async () => {
    const stub = resolvingProvider([UNREPORTED_TRANSITION]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    await user.click(screen.getByRole('button', { name: CHANGED_ONLY_NAME }));

    // The two empty states are different claims, and the one shown is the one
    // that is true: the capture held a transition, the reader's own filter
    // hid it.
    expect(await screen.findByText(/no transitions in this page match/i)).toBeDefined();
    expect(screen.queryByText(/were captured for this interaction/i)).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The narrowing that emptied the view stays where it was made, pressed, so
    // it can be undone, and the footer keeps stating what was loaded.
    const toolbar = screen.getByRole('group', { name: TOOLBAR_NAME });
    expect(
      within(toolbar).getByRole('button', { name: CHANGED_ONLY_NAME }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByText(countsText(0, 1))).toBeDefined();
  });

  it('keeps its toolbar and footer when a component narrowing empties the result', async () => {
    const stub = pagingProvider([
      { data: PROVIDER_ORDER },
      { data: [], total: 0 },
      { data: PROVIDER_ORDER },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');
    await user.selectOptions(
      screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME }),
      COMPONENT_PANEL,
    );

    // The narrowed query matched nothing. That is the reader's narrowing
    // speaking, not an empty capture: the narrowing copy, no capture title or
    // glyph, and the toolbar and footer both kept.
    const block = emptyStateOf(await screen.findByText(/no transitions in this page match/i));
    expect(within(block).queryByText(EMPTY_CAPTURE_TITLE)).toBeNull();
    expect(block.querySelector('.dg-empty-state__icon')).toBeNull();
    expect(screen.queryByText(EMPTY_CAPTURE_MESSAGE)).toBeNull();
    expect(screen.getByRole('group', { name: TOOLBAR_NAME })).toBeDefined();
    expect(screen.getByText(countsText(0, 0, 0))).toBeDefined();

    // And the kept control undoes it: widening again re-queries and the rows
    // of the whole capture return.
    const picker = screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME });
    await user.selectOptions(
      picker,
      within(picker).getByRole('option', { name: ALL_COMPONENTS_LABEL }),
    );

    await screen.findByRole('grid');
    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3).filter).toBeUndefined();
  });
});

describe('StateTransitionViewer paging', () => {
  /*
   * Local to this block: the offset-aware stubs below are built per case on
   * top of `recordingProvider`, so each case states the sequence it pages
   * through in its own body, and nothing here changes a shared helper.
   */

  /**
   * One response of the `stateTransitions` source, with only the paging
   * counters a case asked for.
   *
   * @param data The page's rows, in the order the service returned them.
   * @param counters The total and next offset to report, when reported.
   * @returns The resolved response.
   */
  function transitionsResponse(
    data: readonly StateTransition[],
    counters: { readonly total?: number; readonly nextOffset?: number } = {},
  ): Promise<DataQueryResponse> {
    return Promise.resolve<DataQueryResponse>({
      source: 'stateTransitions',
      data,
      ...(counters.total === undefined ? {} : { total: counters.total }),
      ...(counters.nextOffset === undefined ? {} : { nextOffset: counters.nextOffset }),
    });
  }

  /**
   * A transition that occupies one position of a long paged sequence, with an
   * id, span and value summary no other position shares.
   *
   * @param position A small positive integer, below 128.
   * @returns The transition.
   */
  function sequenceTransition(position: number): StateTransition {
    return makeTransition({
      id: `evt_example_sequence_${String(position)}`,
      spanId: spanIdFor(128 + position),
      startTime: BASE_START_MS + position,
      component: COMPONENT_WIDGET,
      hookLabel: HOOK_VALUE_LABEL,
      previousValue: sequenceValue(position),
      nextValue: sequenceValue(position + 1),
      transitionSource: 'state',
      triggerEventId: TRIGGER_EVENT_ID,
      triggerName: TRIGGER_NAME,
      triggerKind: 'interaction',
    });
  }

  /**
   * The value-before summary {@link sequenceTransition} draws for a position.
   *
   * @param position The position.
   * @returns Its summary.
   */
  function sequenceValue(position: number): string {
    return `number ${String(1000 + position)}`;
  }

  /** A `stateTransitions` node with one page size, and a first offset when given. */
  function pagedNode(limit: number, offset?: number): StateTransitionsNode {
    return makeNode({
      query: {
        source: 'stateTransitions',
        sort: CHRONOLOGICAL,
        limit,
        ...(offset === undefined ? {} : { offset }),
      },
    });
  }

  it('says how much of the result is loaded, and requests the next page at the reported offset', async () => {
    const stub = pagingProvider([
      { data: [WIDGET_VALUE_TRANSITION], total: 14, nextOffset: 1 },
      { data: [WIDGET_FLAG_TRANSITION], total: 14, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(pagedNode(1), { provider: stub.provider, actions: makeActions().actions });

    // One row of fourteen, said as three separate facts rather than implied by
    // a bare count.
    await screen.findByText(countsText(1, 1, 14));
    expect(dataRows()).toHaveLength(1);

    const first = soleQuery(stub);
    expect(first.limit).toBe(1);
    expect(first.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const second = queryOfCall(stub, 2);

    // The NEXT page: exactly the offset the first response reported, with the
    // same page size. A component that widened the window at the old offset
    // (and so re-requested every row already on screen) fails here.
    expect(second.offset).toBe(1);
    expect(second.limit).toBe(first.limit);
    expect(second.sort).toBe(CHRONOLOGICAL);
    expect(second.source).toBe('stateTransitions');
    expect(second.filter).toBeUndefined();

    // And the second page is appended after the first, counted together.
    await screen.findByText(countsText(2, 2, 14));
    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE, FLAG_BEFORE]);
  });

  it('announces the counts through a polite live region that stays mounted as they change', async () => {
    // The second page holds a row whose values were not reported, so the local
    // "changed only" narrowing below has one row to hide.
    const stub = pagingProvider([
      { data: [WIDGET_VALUE_TRANSITION], total: 14, nextOffset: 1 },
      { data: [UNREPORTED_TRANSITION], total: 14, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(pagedNode(1), { provider: stub.provider, actions: makeActions().actions });

    // Polite, so the announcement waits for the reader; atomic, so the whole
    // sentence is read rather than one changed figure out of context.
    const counts = await screen.findByText(countsText(1, 1, 14));
    expect(counts.getAttribute('aria-live')).toBe('polite');
    expect(counts.getAttribute('aria-atomic')).toBe('true');

    // A live region is only heard when it CHANGES while mounted, so the same
    // element must carry the next sentence rather than being replaced by one.
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(2, 2, 14));
    expect(counts.textContent).toBe(countsText(2, 2, 14));
    expect(counts.getAttribute('aria-live')).toBe('polite');

    // The local narrowing changes the counts too, through the same region.
    await user.click(screen.getByRole('button', { name: CHANGED_ONLY_NAME }));
    await screen.findByText(countsText(1, 2, 14));
    expect(counts.isConnected).toBe(true);
    expect(counts.textContent).toBe(countsText(1, 2, 14));
    expect(counts.getAttribute('aria-live')).toBe('polite');
  });

  it('appends the next page in provider order, keeping the first copy of a repeated row', async () => {
    // The second page repeats the flag transition the first page already
    // delivered, as a result that shifted between two requests would.
    const stub = recordingProvider((query) =>
      query.offset === 2
        ? transitionsResponse([WIDGET_FLAG_TRANSITION, PANEL_CONTEXT_TRANSITION], { total: 4 })
        : transitionsResponse([WIDGET_VALUE_TRANSITION, WIDGET_FLAG_TRANSITION], {
            total: 4,
            nextOffset: 2,
          }),
    );
    const user = userEvent.setup();

    renderComponent(pagedNode(2), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(countsText(2, 2, 4));

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // Three distinct rows, in the order the pages delivered them: the repeated
    // key is drawn once, where it first arrived.
    await screen.findByText(countsText(3, 3, 4));
    expect(renderedValuesBefore()).toEqual([...PROVIDER_ORDER_VALUES]);
    expect(renderedValuesBefore().filter((value) => value === FLAG_BEFORE)).toHaveLength(1);

    // The first page was never requested again: one request per page.
    expect(stub.queries.map((query) => query.offset)).toEqual([DATA_QUERY_DEFAULT_OFFSET, 2]);
    expect(stub.queries.map((query) => query.limit)).toEqual([2, 2]);

    // The second response reported no next page, so nothing more is offered.
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('keeps the loaded rows on screen while the next page is in flight', async () => {
    let releaseNextPage: (response: DataQueryResponse) => void = () => undefined;
    const nextPage = new Promise<DataQueryResponse>((resolve) => {
      releaseNextPage = resolve;
    });
    const stub = recordingProvider((query) =>
      query.offset === 1
        ? nextPage
        : transitionsResponse([WIDGET_VALUE_TRANSITION], { total: 2, nextOffset: 1 }),
    );
    const user = userEvent.setup();

    renderComponent(pagedNode(1), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(countsText(1, 1, 2));

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);

    // The rows already loaded stay exactly where they are: no loading state
    // replaces the grid, and the counts keep the total the provider reported.
    expect(screen.getByRole('grid')).toBeDefined();
    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE]);
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.getByText(countsText(1, 1, 2))).toBeDefined();

    // The footer reports the load, and the control cannot request it twice.
    const busy = screen.getByRole('button', { name: LOADING_MORE_NAME });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    await act(async () => {
      releaseNextPage({ source: 'stateTransitions', data: [WIDGET_FLAG_TRANSITION], total: 2 });
      await nextPage;
    });

    await screen.findByText(countsText(2, 2, 2));
    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE, FLAG_BEFORE]);
    expect(screen.queryByRole('button', { name: LOADING_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps the loaded rows and offers a retry in the footer when the next page fails', async () => {
    let nextPageAttempts = 0;
    const stub = recordingProvider((query) => {
      if (query.offset !== 1) {
        return transitionsResponse([WIDGET_VALUE_TRANSITION], { total: 2, nextOffset: 1 });
      }

      nextPageAttempts += 1;

      return nextPageAttempts === 1
        ? Promise.reject(
            new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
          )
        : transitionsResponse([WIDGET_FLAG_TRANSITION], { total: 2 });
    });
    const user = userEvent.setup();

    renderComponent(pagedNode(1), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(countsText(1, 1, 2));
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // Reported in the footer, beside the counts of the rows it left untouched —
    // never by replacing those rows with an error state — in the contract's
    // page scope: the next-page title, a lead that says the rows above are
    // unaffected, then the provider's own cause and its code.
    const alert = await screen.findByRole('alert');
    expect(alert.closest('.dg-state-transitions__footer')).not.toBeNull();
    expect(alert.textContent).toContain(PAGE_FAILURE_TITLE);
    expect(alert.textContent).toContain(PAGE_ERROR_TEXT);
    expect(alert.textContent).toContain('The channel to the service is closed.');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The request that failed is the next page's, offset included.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'stateTransitions',
      sort: CHRONOLOGICAL,
      limit: 1,
      offset: 1,
    });

    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE]);
    expect(screen.getByText(countsText(1, 1, 2))).toBeDefined();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // The retry asks for the same page again, and the page is appended.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(3);
    expect(queryOfCall(stub, 3)).toEqual(queryOfCall(stub, 2));

    await screen.findByText(countsText(2, 2, 2));
    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE, FLAG_BEFORE]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('follows the reported offsets past 5 000, one fixed-size request per page', async () => {
    const stub = recordingProvider((query) => {
      switch (query.offset) {
        case 4900:
          return transitionsResponse([sequenceTransition(1)], { total: 5600, nextOffset: 5100 });
        case 5100:
          return transitionsResponse([sequenceTransition(2)], { total: 5600, nextOffset: 5300 });
        default:
          return transitionsResponse([sequenceTransition(3)], { total: 5600 });
      }
    });
    const user = userEvent.setup();

    renderComponent(pagedNode(DATA_QUERY_DEFAULT_LIMIT, 4900), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(countsText(1, 1, 5600));
    expect(soleQuery(stub).offset).toBe(4900);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(2, 2, 5600));

    // Past the 5 000 mark, at exactly the offset reported: the contract's
    // per-request maximum bounds one page and never how far a reader can go.
    expect(queryOfCall(stub, 2).offset).toBe(5100);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(3, 3, 5600));

    expect(queryOfCall(stub, 3).offset).toBe(5300);
    expect(stub.queries.map((query) => query.limit)).toEqual([
      DATA_QUERY_DEFAULT_LIMIT,
      DATA_QUERY_DEFAULT_LIMIT,
      DATA_QUERY_DEFAULT_LIMIT,
    ]);
    expect(renderedValuesBefore()).toEqual([sequenceValue(1), sequenceValue(2), sequenceValue(3)]);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('keeps paging at the largest page size, which caps a request and not the sequence', async () => {
    const stub = recordingProvider((query) => {
      switch (query.offset) {
        case DATA_QUERY_DEFAULT_OFFSET:
          return transitionsResponse([sequenceTransition(1)], {
            total: 12_000,
            nextOffset: DATA_QUERY_MAX_LIMIT,
          });
        case DATA_QUERY_MAX_LIMIT:
          return transitionsResponse([sequenceTransition(2)], {
            total: 12_000,
            nextOffset: DATA_QUERY_MAX_LIMIT * 2,
          });
        default:
          return transitionsResponse([sequenceTransition(3)], { total: 12_000 });
      }
    });
    const user = userEvent.setup();

    renderComponent(pagedNode(DATA_QUERY_MAX_LIMIT), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByText(countsText(1, 1, 12_000));

    // Once a page of the largest size has loaded, the control is still "Load
    // more" rather than a note that nothing more can be reached.
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(2, 2, 12_000));
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(3, 3, 12_000));

    expect(stub.queries.map((query) => query.offset)).toEqual([
      DATA_QUERY_DEFAULT_OFFSET,
      DATA_QUERY_MAX_LIMIT,
      DATA_QUERY_MAX_LIMIT * 2,
    ]);
    expect(stub.queries.map((query) => query.limit)).toEqual([
      DATA_QUERY_MAX_LIMIT,
      DATA_QUERY_MAX_LIMIT,
      DATA_QUERY_MAX_LIMIT,
    ]);
    expect(screen.queryByText(/largest page/i)).toBeNull();
  });

  it('offers no Load more without a reported next offset, whatever the total says', async () => {
    // Fourteen reported, one loaded, and no next offset: the total says how
    // much exists, not where a next page starts, so nothing is inferred from it.
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION], { total: 14 });

    renderComponent(pagedNode(1), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(countsText(1, 1, 14));
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: LOADING_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('treats a next offset that does not move past its page as the end of the data', async () => {
    // A provider pointing back at the page it just answered would otherwise
    // have "Load more" request the same rows forever.
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION], { total: 14, nextOffset: 3 });

    renderComponent(pagedNode(1, 3), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(countsText(1, 1, 14));
    expect(soleQuery(stub).offset).toBe(3);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('sends an authored limit of 0 exactly, and never pages a count-only request', async () => {
    // The provider echoes a next offset equal to the page it answered, as a
    // resolver that computes `offset + limit` for a zero-row page would.
    const stub = resolvingProvider([], { total: 42, nextOffset: 0 });

    renderComponent(pagedNode(0), { provider: stub.provider, actions: makeActions().actions });

    // Zero is a request for a total without rows, not an unset field: it is
    // neither raised to one row nor replaced by the default page size.
    await screen.findByText(countsText(0, 0, 42));
    const query = soleQuery(stub);
    expect(query.limit).toBe(0);
    expect(query.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);

    // The answer is the count, said as one, and never the empty-capture copy:
    // forty-two transitions matched, and none were asked for.
    const message = screen.getByText(
      `This view requests a count without rows: ${formatCount(42)} state transitions matched its query.`,
    );
    const block = emptyStateOf(message);
    expect(within(block).getByText(COUNT_ONLY_TITLE)).toBeDefined();
    expect(screen.queryByText(EMPTY_CAPTURE_MESSAGE)).toBeNull();

    // Nothing to page: no control, and no second request.
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: LOADING_MORE_NAME })).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('offers no Load more for a count-only request even when the provider reports a forward offset', async () => {
    // A zero-row page cannot move a sequence forward, so a forward-looking
    // `nextOffset` on one is a request for nothing again, not a next page.
    const stub = resolvingProvider([], { total: 42, nextOffset: 200 });

    renderComponent(pagedNode(0), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(countsText(0, 0, 42));
    expect(soleQuery(stub).limit).toBe(0);
    expect(screen.getByText(COUNT_ONLY_TITLE)).toBeDefined();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      total: 1,
      reading: 'one reported transition',
      message: `This view requests a count without rows: ${formatCount(1)} state transition matched its query.`,
    },
    {
      total: undefined,
      reading: 'no reported total',
      message: 'This view requests a count without rows, and no total was reported for its query.',
    },
  ])('states a count-only answer truthfully for $reading', async ({ total, message }) => {
    const stub = resolvingProvider([], total === undefined ? {} : { total });

    renderComponent(pagedNode(0), { provider: stub.provider, actions: makeActions().actions });

    // Without a total the view says none was reported rather than implying a
    // count of zero, and its footer claims no total either.
    const block = emptyStateOf(await screen.findByText(message));
    expect(within(block).getByText(COUNT_ONLY_TITLE)).toBeDefined();
    expect(screen.getByText(countsText(0, 0, total))).toBeDefined();
    expect(screen.queryByText(EMPTY_CAPTURE_MESSAGE)).toBeNull();
    expect(soleQuery(stub).limit).toBe(0);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it.each([
    { authored: undefined, sent: DATA_QUERY_DEFAULT_LIMIT, reading: 'an omitted limit' },
    { authored: 9000, sent: DATA_QUERY_MAX_LIMIT, reading: 'a limit above the maximum' },
    { authored: 12.9, sent: 12, reading: 'a fractional limit' },
    { authored: Number.NaN, sent: DATA_QUERY_DEFAULT_LIMIT, reading: 'a non-finite limit' },
  ])('sends $sent as the page size for $reading', async ({ authored, sent }) => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION], { total: 1 });

    renderComponent(
      makeNode({
        query: {
          source: 'stateTransitions',
          sort: CHRONOLOGICAL,
          ...(authored === undefined ? {} : { limit: authored }),
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByText(countsText(1, 1, 1));
    expect(soleQuery(stub).limit).toBe(sent);
  });

  it.each([
    {
      reading: 'a page past the end of a positive total',
      offset: 200,
      total: 42,
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(201)}, past the end of the ${formatCount(42)} state transitions that matched this query.`,
    },
    {
      reading: 'a page starting exactly at the end',
      offset: 42,
      total: 42,
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(43)}, past the end of the ${formatCount(42)} state transitions that matched this query.`,
    },
    {
      reading: 'a page past the end of a single transition',
      offset: 5000,
      total: 1,
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(5001)}, past the end of the ${formatCount(1)} state transition that matched this query.`,
    },
    {
      reading: 'an empty page inside a positive total',
      offset: 10,
      total: 42,
      title: EMPTY_PAGE_TITLE,
      message: `${formatCount(42)} state transitions matched this query, but none are shown on this page.`,
    },
    {
      reading: 'a later page with no reported total',
      offset: 200,
      total: undefined,
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(201)} and holds no state transitions; no total was reported for this query.`,
    },
    {
      reading: 'a later page of a total of zero',
      offset: 400,
      total: 0,
      title: EMPTY_CAPTURE_TITLE,
      message: EMPTY_CAPTURE_MESSAGE,
    },
  ])('says what $reading holds, and nothing more', async ({ offset, total, title, message }) => {
    const stub = resolvingProvider([], total === undefined ? {} : { total });

    renderComponent(pagedNode(DATA_QUERY_DEFAULT_LIMIT, offset), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    const block = emptyStateOf(await screen.findByText(message));

    if (title === EMPTY_CAPTURE_TITLE) {
      // A reported total of zero is an empty capture wherever the page starts:
      // its own title rather than an empty-page one, and neither the toolbar
      // nor the footer, since no control could reach anything and the sentence
      // already says what the footer's zeros would.
      expect(within(block).queryByText(ANY_EMPTY_PAGE_TITLE)).toBeNull();
      expect(within(block).getByText(EMPTY_CAPTURE_TITLE)).toBeDefined();
      expect(screen.queryByRole('group', { name: TOOLBAR_NAME })).toBeNull();
      expect(screen.queryByText(countsText(0, 0, total))).toBeNull();
    } else {
      // Anything else with a positive or unknown total is an empty page, and
      // the empty-capture copy would contradict the provider's own count. The
      // footer states the same counts, under the toolbar.
      expect(within(block).getByText(title)).toBeDefined();
      expect(screen.queryByText(EMPTY_CAPTURE_MESSAGE)).toBeNull();
      expect(screen.getByText(countsText(0, 0, total))).toBeDefined();
      expect(screen.getByRole('group', { name: TOOLBAR_NAME })).toBeDefined();
    }

    // The authored offset was requested as authored, and no page past the
    // provider's last one is offered.
    expect(soleQuery(stub).offset).toBe(offset);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('keeps Load more on an empty page the provider says is followed by another, and follows it', async () => {
    const stub = recordingProvider((query) =>
      query.offset === DATA_QUERY_DEFAULT_LIMIT
        ? transitionsResponse([WIDGET_VALUE_TRANSITION])
        : transitionsResponse([], { nextOffset: DATA_QUERY_DEFAULT_LIMIT }),
    );
    const user = userEvent.setup();

    renderComponent(pagedNode(DATA_QUERY_DEFAULT_LIMIT), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    // More exists, so this first page is not an empty capture: it says where it
    // starts and claims nothing about the rest.
    const block = emptyStateOf(
      await screen.findByText(
        `This page starts at position ${formatCount(1)} and holds no state transitions; no total was reported for this query.`,
      ),
    );
    expect(within(block).getByText(EMPTY_PAGE_TITLE)).toBeDefined();
    expect(screen.queryByText(EMPTY_CAPTURE_MESSAGE)).toBeNull();

    // The next page is requested at exactly the reported offset.
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await screen.findByRole('grid');
    expect(stub.queries.map((query) => query.offset)).toEqual([
      DATA_QUERY_DEFAULT_OFFSET,
      DATA_QUERY_DEFAULT_LIMIT,
    ]);
    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE]);
    expect(screen.getByText(countsText(1, 1))).toBeDefined();
    expect(screen.queryByText(EMPTY_PAGE_TITLE)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('starts again from the first page when the order or the component narrowing changes', async () => {
    const stub = recordingProvider((query) => {
      const offset = query.offset ?? DATA_QUERY_DEFAULT_OFFSET;

      if (query.filter?.component === COMPONENT_PANEL) {
        return transitionsResponse([PANEL_CONTEXT_TRANSITION]);
      }

      if (query.sort === LONGEST_FIRST) {
        return offset === DATA_QUERY_DEFAULT_OFFSET
          ? transitionsResponse([PANEL_CONTEXT_TRANSITION], { nextOffset: 1 })
          : transitionsResponse([WIDGET_VALUE_TRANSITION], { nextOffset: 2 });
      }

      return offset === DATA_QUERY_DEFAULT_OFFSET
        ? transitionsResponse([WIDGET_VALUE_TRANSITION], { nextOffset: 1 })
        : transitionsResponse([WIDGET_FLAG_TRANSITION], { nextOffset: 2 });
    });
    const user = userEvent.setup();

    renderComponent(pagedNode(1), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(countsText(1, 1));
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(2, 2));
    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE, FLAG_BEFORE]);

    // A new order is a new sequence: its first page, and none of the rows the
    // previous ordering accumulated.
    await user.selectOptions(
      screen.getByRole('combobox', { name: ORDER_CONTROL_NAME }),
      LONGEST_FIRST,
    );

    expect(queryOfCall(stub, 3).sort).toBe(LONGEST_FIRST);
    expect(queryOfCall(stub, 3).offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    await waitFor(() => {
      expect(renderedValuesBefore()).toEqual([OBJECT_BEFORE]);
    });
    expect(screen.getByText(countsText(1, 1))).toBeDefined();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(2, 2));
    expect(queryOfCall(stub, 4).offset).toBe(1);

    // So is a new component narrowing.
    await user.selectOptions(
      screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME }),
      COMPONENT_PANEL,
    );

    expect(queryOfCall(stub, 5).filter).toEqual({ component: COMPONENT_PANEL });
    expect(queryOfCall(stub, 5).offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    await waitFor(() => {
      expect(renderedValuesBefore()).toEqual([OBJECT_BEFORE]);
    });
    expect(screen.getByText(countsText(1, 1))).toBeDefined();
    expect(stub.queries.map((query) => query.offset)).toEqual([0, 1, 0, 1, 0]);
    expect(stub.queries.map((query) => query.limit)).toEqual([1, 1, 1, 1, 1]);
  });

  it('keeps the selected and the disclosed row across an appended page', async () => {
    const stub = pagingProvider([
      { data: [WIDGET_VALUE_TRANSITION], nextOffset: 1 },
      { data: [WIDGET_FLAG_TRANSITION] },
    ]);
    const user = userEvent.setup();

    renderComponent(pagedNode(1), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    await user.click(row);
    await user.click(
      within(cellsOf(row).component).getByRole('button', {
        name: showDetailsName(WIDGET_VALUE_IDENTITY),
      }),
    );

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(2, 2));

    // Appending a page is neither a new selection nor a collapse. The open
    // state is reported by the toggle, never by the row: `aria-expanded` is not
    // a state a `grid` row supports.
    const selected = rowWithValueBefore(NUMBER_BEFORE);
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.hasAttribute('aria-expanded')).toBe(false);
    expect(rowWithValueBefore(FLAG_BEFORE).getAttribute('aria-selected')).toBe('false');

    const toggle = within(cellsOf(selected).component).getByRole('button', {
      name: hideDetailsName(WIDGET_VALUE_IDENTITY),
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // And the toggle names the detail row it opened, which holds the row's
    // identifiers: an `aria-controls` that resolves, to that transition.
    const detail = controlledElementOf(toggle);
    expect(detail.getAttribute('role')).toBe('row');
    expect(within(detail).getByText(WIDGET_VALUE_TRANSITION.traceId)).toBeDefined();

    // The collapsed row next to it reports its state and names nothing.
    const collapsed = within(cellsOf(rowWithValueBefore(FLAG_BEFORE)).component).getByRole(
      'button',
      { name: showDetailsName(WIDGET_SECOND_HOOK_IDENTITY) },
    );
    expect(collapsed.getAttribute('aria-expanded')).toBe('false');
    expect(collapsed.hasAttribute('aria-controls')).toBe(false);
  });

  it('claims no total when the provider reported none, and offers no next page', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A provider that reported no total leaves this view unable to know
    // whether more rows exist, and saying nothing about it is the only
    // truthful option.
    await screen.findByText(countsText(1, 1));
    expect(screen.queryByText(/in total/)).toBeNull();
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('asks for the published default page from the first item, and names its order', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);

    renderComponent(makeNode({ query: { source: 'stateTransitions' } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid');

    const query = soleQuery(stub);
    expect(query.source).toBe('stateTransitions');
    expect(query.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(query.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(query.filter).toBeUndefined();

    // A sequence of state changes is a narrative, so this node always names an
    // order even when the panel did not: chronological, applied by the side
    // that holds the whole capture rather than here.
    expect(query.sort).toBe(CHRONOLOGICAL);
  });

  it('starts over from the authored first page, painting none of the old rows, when the data provider is replaced', async () => {
    const earlier = recordingProvider((query) =>
      query.offset === 1
        ? transitionsResponse([WIDGET_FLAG_TRANSITION], { total: 2 })
        : transitionsResponse([WIDGET_VALUE_TRANSITION], { total: 2, nextOffset: 1 }),
    );
    let releaseLater: (response: DataQueryResponse) => void = () => undefined;
    const laterPage = new Promise<DataQueryResponse>((resolve) => {
      releaseLater = resolve;
    });
    const later = recordingProvider(() => laterPage);
    const { actions } = makeActions();
    const user = userEvent.setup();
    const node = pagedNode(1);

    // One node, one query, two providers: a host rebinding a mounted panel to
    // another session swaps the provider without remounting the node.
    const view = render(
      <DataProviderContext.Provider value={earlier.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <StateTransitionViewer node={node} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );

    await screen.findByText(countsText(1, 1, 2));
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await screen.findByText(countsText(2, 2, 2));
    expect(renderedValuesBefore()).toEqual([NUMBER_BEFORE, FLAG_BEFORE]);

    view.rerender(
      <DataProviderContext.Provider value={later.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <StateTransitionViewer node={node} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );

    // The new provider is asked for the authored first page — not the offset
    // the previous provider's pages reached — and while it loads nothing of the
    // previous provider's is on screen.
    expect(later.resolve).toHaveBeenCalledTimes(1);
    const first = queryOfCall(later, 1);
    expect(first.offset).toBe(DATA_QUERY_DEFAULT_OFFSET);
    expect(first.limit).toBe(1);
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByText(countsText(2, 2, 2))).toBeNull();

    await act(async () => {
      releaseLater({ source: 'stateTransitions', data: [PANEL_CONTEXT_TRANSITION], total: 1 });
      await laterPage;
    });

    await screen.findByText(countsText(1, 1, 1));
    expect(dataRows()).toHaveLength(1);
    expect(renderedValuesBefore()).not.toContain(NUMBER_BEFORE);
    expect(renderedValuesBefore()).not.toContain(FLAG_BEFORE);
    expect(earlier.resolve).toHaveBeenCalledTimes(2);
  });
});

describe('StateTransitionViewer keyboard model', () => {
  /*
   * The APG grid pattern, as `../primitives/DataTable` implements it and this
   * view adopts it: the grid is ONE Tab stop — its active row — and every
   * control and explanation inside a row is `tabIndex={-1}`, reached by the
   * grid's arrow keys rather than by Tab. A tooltip opens on any focus, so an
   * arrow key landing on its trigger shows the explanation, and the first
   * Escape closes it before the second returns to the row.
   */

  /**
   * An upper bound on the Tab presses one pass through the rendered document
   * can take: the toolbar's controls, the grid's single stop and the footer,
   * with room to spare. Reaching it means focus never left the sequence, which
   * fails the case rather than looping.
   */
  const MAX_TAB_PRESSES = 24;

  /** Every element the grid could make focusable: `DataTable`'s own reach. */
  const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

  /** A shortened value before, and a trigger the capture knows of but cannot open. */
  const SHORTENED_ROW = makeTransition({
    id: 'evt_example_0081',
    spanId: spanIdFor(81),
    startTime: BASE_START_MS + 10,
    component: COMPONENT_WIDGET,
    hookLabel: HOOK_VALUE_LABEL,
    previousValue: OVER_BOUND_SUMMARY,
    nextValue: NUMBER_AFTER,
    transitionSource: 'state',
    triggerSpanId: spanIdFor(9),
  });

  /** Neither value described, no attributed trigger, and a disclosed cut list. */
  const UNDESCRIBED_ROW = makeTransition({
    id: 'evt_example_0082',
    spanId: spanIdFor(82),
    startTime: BASE_START_MS + 20,
    component: COMPONENT_WIDGET,
    hookLabel: HOOK_FLAG_LABEL,
    transitionSource: 'state',
    changed: false,
    truncated: true,
    droppedTransitions: 3,
  });

  /**
   * The bubble a trigger's own `aria-describedby` names.
   *
   * Resolved through the attribute rather than by role, because one cell can
   * hold two tooltips, and because this is the very link a screen reader
   * follows: a trigger that lost it would fail here.
   *
   * @param trigger The tooltip's trigger.
   * @returns The bubble describing it.
   */
  function describedBubble(trigger: HTMLElement): HTMLElement {
    const ids = (trigger.getAttribute('aria-describedby') ?? '').split(/\s+/u);

    for (const id of ids) {
      const element = id.length === 0 ? null : document.getElementById(id);

      if (element !== null && element.getAttribute('role') === 'tooltip') {
        return element;
      }
    }

    throw new Error('the trigger names no tooltip in its aria-describedby');
  }

  /**
   * The elements inside the grid that are in the page's Tab order: those with
   * a `tabindex` of `0`. `DataTable` writes one explicitly on its active row,
   * and no control inside the grid may carry one.
   *
   * @param grid The grid.
   * @returns Its Tab stops, in document order.
   */
  function tabStopsIn(grid: HTMLElement): HTMLElement[] {
    return [...grid.querySelectorAll<HTMLElement>('[tabindex="0"]')];
  }

  /**
   * Every focusable element inside the grid that is not a data row: the
   * disclosure toggles, the trigger controls and labels, the source chips and
   * the explained chips — everything the arrow keys, and never Tab, reach.
   *
   * @param grid The grid.
   * @returns Those elements, in document order.
   */
  function inRowControlsOf(grid: HTMLElement): HTMLElement[] {
    return [...grid.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (element) => element.getAttribute('data-row-index') === null,
    );
  }

  /**
   * Press Tab until `target` holds focus, failing if it never does.
   *
   * @param user The session pressing the keys.
   * @param target The element Tab must reach.
   */
  async function tabUntil(
    user: ReturnType<typeof userEvent.setup>,
    target: HTMLElement,
  ): Promise<void> {
    for (let press = 0; press < MAX_TAB_PRESSES && document.activeElement !== target; press += 1) {
      await user.tab();
    }

    expect(document.activeElement).toBe(target);
  }

  /**
   * Walk the whole Tab sequence once, from the document's start until focus
   * falls back to the body, and record every element Tab stopped on.
   *
   * @param user The session pressing the keys.
   * @returns The Tab stops, in the order Tab reached them.
   */
  async function tabSequence(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement[]> {
    const stops: HTMLElement[] = [];

    for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
      await user.tab();

      const focused = document.activeElement;

      if (!(focused instanceof HTMLElement) || focused === document.body) {
        return stops;
      }

      stops.push(focused);
    }

    throw new Error('Tab never left the rendered document within the press bound');
  }

  /** The two rows, and the tooltip triggers each of them carries. */
  interface ExplainedRows {
    readonly grid: HTMLElement;
    readonly first: HTMLElement;
    readonly second: HTMLElement;
    readonly firstToggle: HTMLElement;
    readonly secondToggle: HTMLElement;
    readonly firstTriggers: readonly HTMLElement[];
    readonly secondTriggers: readonly HTMLElement[];
  }

  /**
   * Render both rows and find their controls semantically.
   *
   * @returns The grid, its rows, their toggles and their tooltip triggers, in
   * document order.
   */
  async function renderExplainedRows(): Promise<ExplainedRows> {
    const stub = resolvingProvider([SHORTENED_ROW, UNDESCRIBED_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid');

    const [first, second] = dataRows();
    if (first === undefined || second === undefined) {
      throw new Error('the grid rendered fewer than the two rows of this case');
    }

    const firstCells = cellsOf(first);
    const secondCells = cellsOf(second);

    return {
      grid,
      first,
      second,
      firstToggle: within(firstCells.component).getByRole('button', {
        name: showDetailsName(WIDGET_VALUE_IDENTITY),
      }),
      secondToggle: within(secondCells.component).getByRole('button', {
        name: showDetailsName(WIDGET_FLAG_LABEL_IDENTITY),
      }),
      firstTriggers: [
        elementWithClass(firstCells.previous, 'dg-state-transitions__value'),
        within(firstCells.trigger).getByText(GENERIC_TRIGGER_LABEL),
      ],
      secondTriggers: [
        within(secondCells.trigger).getByText(UNDETERMINED_LABEL),
        within(secondCells.changed).getByText(UNREPORTED_LABEL),
        within(secondCells.changed).getByText(`${TRUNCATED_LABEL}: ${formatCount(3)}`),
      ],
    };
  }

  it('keeps the grid one Tab stop: Tab enters on the row, walks that row alone and leaves', async () => {
    const user = userEvent.setup();
    const { grid, first, second, firstTriggers, secondTriggers } = await renderExplainedRows();

    // Before focus enters, the grid holds exactly one stop, its first row, and
    // every control and explanation inside it is focusable yet out of the Tab
    // order.
    expect(tabStopsIn(grid)).toEqual([first]);
    expect(second.getAttribute('tabindex')).toBe('-1');

    const controls = inRowControlsOf(grid);
    expect(controls.length).toBeGreaterThanOrEqual(firstTriggers.length + secondTriggers.length);
    for (const control of controls) {
      expect(control.getAttribute('tabindex')).toBe('-1');
    }
    for (const trigger of [...firstTriggers, ...secondTriggers]) {
      expect(controls).toContain(trigger);
    }

    // The active row's own controls, in document order: the ones Tab walks
    // after the row (`primitives/DataTable`'s keyboard model). The second row's
    // controls are never among them.
    const firstRowControls = controls.filter((control) => first.contains(control));
    expect(firstRowControls.length).toBeGreaterThan(0);
    for (const trigger of firstTriggers) {
      expect(firstRowControls).toContain(trigger);
    }

    // One pass of Tab through the whole document stops inside the grid on the
    // active row, then on that row's controls, and then leaves it: no other row
    // adds a stop.
    const stops = await tabSequence(user);
    expect(stops.filter((stop) => grid.contains(stop))).toEqual([first, ...firstRowControls]);

    const lastInGrid = stops.indexOf(firstRowControls.at(-1) ?? first);
    const afterGrid = stops[lastInGrid + 1];
    if (afterGrid !== undefined) {
      expect(grid.contains(afterGrid)).toBe(false);
    }

    // Tab back in lands on the row again, and focus there leaves the grid
    // still holding exactly one stop.
    await tabUntil(user, first);
    expect(tabStopsIn(grid)).toEqual([first]);

    // The next Tab walks into the row, and Shift+Tab walks back to it.
    await user.tab();
    expect(document.activeElement).toBe(firstRowControls[0]);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(first);
    expect(tabStopsIn(grid)).toEqual([first]);
  });

  it('reaches every explanation of a row with the arrow keys, and opens each on focus', async () => {
    const user = userEvent.setup();
    const { grid, first, second, firstToggle, secondToggle, firstTriggers, secondTriggers } =
      await renderExplainedRows();
    const [shortenedValue, outOfPageTrigger] = firstTriggers;
    const [undeterminedTrigger, unreportedChip, truncatedChip] = secondTriggers;

    if (
      shortenedValue === undefined ||
      outOfPageTrigger === undefined ||
      undeterminedTrigger === undefined ||
      unreportedChip === undefined ||
      truncatedChip === undefined
    ) {
      throw new Error('a tooltip trigger of this case was not rendered');
    }

    // No explanation sits in a column header, where it would be nested inside
    // a sort control. Closed bubbles are hidden, so the query counts hidden
    // ones too: a mounted-but-closed bubble in a header would still be one.
    for (const header of screen.getAllByRole('columnheader')) {
      expect(within(header).queryAllByRole('tooltip', { hidden: true })).toHaveLength(0);
    }

    await tabUntil(user, first);

    // ArrowRight on a collapsed row opens its detail and keeps focus on the
    // row; the next one enters the row on its first control, the toggle, which
    // now reports the open state.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(first);
    expect(firstToggle.getAttribute('aria-expanded')).toBe('true');

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(firstToggle);

    // ArrowRight walks the row's explanations in reading order, and focus by
    // arrow key opens each exactly as Tab would. Before its turn a bubble is
    // mounted and named by its trigger's `aria-describedby`, but none is shown:
    // it is `hidden`, out of the accessibility tree. The text of each is read
    // while it is open.
    const explanations = new Map<HTMLElement, string>();

    for (const trigger of firstTriggers) {
      const bubble = describedBubble(trigger);
      expect(bubble.hidden).toBe(true);
      expect(bubble.classList.contains('dg-is-open')).toBe(false);

      await user.keyboard('{ArrowRight}');

      expect(document.activeElement).toBe(trigger);
      expect(bubble.hidden).toBe(false);
      expect(bubble.classList.contains('dg-is-open')).toBe(true);
      explanations.set(trigger, bubble.textContent);
    }

    // The last control keeps focus on a further ArrowRight, and ArrowLeft walks
    // back to the toggle and then out to the row.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(outOfPageTrigger);
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(document.activeElement).toBe(firstToggle);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(first);

    // ArrowDown moves the roving stop to the next row, and F2 enters it
    // without opening its detail.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(second);
    expect(tabStopsIn(grid)).toEqual([second]);

    await user.keyboard('{F2}');
    expect(document.activeElement).toBe(secondToggle);
    expect(secondToggle.getAttribute('aria-expanded')).toBe('false');

    for (const trigger of secondTriggers) {
      await user.keyboard('{ArrowRight}');

      const bubble = describedBubble(trigger);
      expect(document.activeElement).toBe(trigger);
      expect(bubble.classList.contains('dg-is-open')).toBe(true);
      explanations.set(trigger, bubble.textContent);
    }

    // Each bubble said what its trigger needs explained.
    expect(explanations.get(shortenedValue)).toContain('bounded summary');
    expect(explanations.get(outOfPageTrigger)).toContain('outside the page loaded here');
    expect(explanations.get(undeterminedTrigger)).toContain(
      'Nothing is claimed about what caused it',
    );
    expect(explanations.get(unreportedChip)).toContain(
      'not a statement that the value stayed the same',
    );
    expect(explanations.get(truncatedChip)).toContain('not a total');

    // Home and End jump across the row's controls.
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(secondToggle);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(truncatedChip);

    // The first Escape dismisses the bubble the keyboard opened and keeps
    // focus on its trigger, leaving no explanation shown anywhere while the
    // trigger's description still resolves; the second returns to the row.
    expect(describedBubble(truncatedChip).classList.contains('dg-is-open')).toBe(true);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(truncatedChip);
    expect(describedBubble(truncatedChip).classList.contains('dg-is-open')).toBe(false);
    expect(describedBubble(truncatedChip).hidden).toBe(true);
    expect(document.querySelector('.dg-tooltip__bubble.dg-is-open')).toBeNull();
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(second);
    expect(tabStopsIn(grid)).toEqual([second]);
  });

  it('reaches the trigger control and both source chips by arrow key, and each keeps its own action', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    const grid = await screen.findByRole('grid');
    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    await tabUntil(user, row);

    // Open the detail, then enter the row: the toggle, the compact chip, the
    // trigger control and — in the open detail — the full chip, in document
    // order, every one of them out of the Tab order.
    await user.keyboard('{ArrowRight}{ArrowRight}');

    const cells = cellsOf(row);
    const toggle = within(cells.component).getByRole('button', {
      name: hideDetailsName(WIDGET_VALUE_IDENTITY),
    });
    const compactChip = within(cells.component).getByRole('button', { name: SOURCE_CHIP_NAME });
    const trigger = within(cells.trigger).getByRole('button', { name: TRIGGER_NAME });
    const detailChip = within(controlledElementOf(toggle)).getByRole('button', {
      name: sourceLinkAccessibleName({ location: BASE_SOURCE }),
    });

    expect(document.activeElement).toBe(toggle);

    for (const control of [compactChip, trigger, detailChip]) {
      expect(control.getAttribute('tabindex')).toBe('-1');

      await user.keyboard('{ArrowRight}');

      expect(document.activeElement).toBe(control);
    }

    expect(tabStopsIn(grid)).toEqual([row]);

    // Enter on the trigger control opens the attributed record — its id alone,
    // once — and activates neither the row nor anything else.
    await user.keyboard('{Home}{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(trigger);

    await user.keyboard('{Enter}');

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).toHaveBeenCalledWith({ eventId: TRIGGER_EVENT_ID });
    expect(row.getAttribute('aria-selected')).toBe('false');
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    // Enter on the compact chip hands the host the very location the row
    // resolved to.
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(compactChip);

    await user.keyboard('{Enter}');

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toBe(BASE_SOURCE);
    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
  });

  it('moves the roving stop to the row of a control a pointer focuses, and keeps row navigation', async () => {
    const user = userEvent.setup();
    const { grid, first, second, secondTriggers } = await renderExplainedRows();
    const [undeterminedTrigger] = secondTriggers;

    if (undeterminedTrigger === undefined) {
      throw new Error('a tooltip trigger of this case was not rendered');
    }

    await tabUntil(user, first);

    // A click focuses the explanation itself — it is focusable, only out of
    // the Tab order — and its row becomes the grid's one stop.
    await user.click(undeterminedTrigger);

    expect(document.activeElement).toBe(undeterminedTrigger);
    expect(describedBubble(undeterminedTrigger).classList.contains('dg-is-open')).toBe(true);
    expect(tabStopsIn(grid)).toEqual([second]);
    expect(first.getAttribute('tabindex')).toBe('-1');

    // The arrow keys still move between rows from there.
    await user.keyboard('{ArrowUp}');

    expect(document.activeElement).toBe(first);
    expect(tabStopsIn(grid)).toEqual([first]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The panel's shared selection, and the toolbar's filter reports
 *
 * Under the panel host the selected row is the panel's one selection — the
 * record any view or evidence chip last selected — rather than a state of this
 * view, so the events an evidence chip selects are marked here as they are in
 * every other view. These cases provide that selection directly through
 * `PanelSelectionContext`, which is exactly what the host mounts, and
 * re-render with another value to move it.
 *
 * Every toolbar change is reported through `onFilterChange` as the whole
 * toolbar state it leaves — the order, both toggles and any component
 * narrowing — in plain strings and never as a query shape.
 * ---------------------------------------------------------------------------
 */

/**
 * The component inside every host context, the panel's selection included.
 *
 * @param node The node to draw.
 * @param context The provider, the actions and the selection the host provides.
 * @returns The element tree.
 */
function selectionTree(
  node: StateTransitionsNode,
  context: {
    readonly provider: DataProvider;
    readonly actions: PanelActions;
    readonly selection: PanelSelection | undefined;
  },
): ReactElement {
  return (
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <PanelSelectionContext.Provider value={{ selection: context.selection }}>
            <StateTransitionViewer node={node} />
          </PanelSelectionContext.Provider>
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>
  );
}

describe('StateTransitionViewer shared selection', () => {
  it('marks the transition whose record the panel selection names, and no other', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    render(
      selectionTree(makeNode(), {
        provider: stub.provider,
        actions: makeActions().actions,
        selection: { eventId: WIDGET_FLAG_TRANSITION.eventId },
      }),
    );

    await screen.findByRole('grid');

    const selected = rowWithValueBefore(FLAG_BEFORE);
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.classList.contains('dg-is-selected')).toBe(true);
    expect(rowWithValueBefore(NUMBER_BEFORE).getAttribute('aria-selected')).toBe('false');
    expect(rowWithValueBefore(OBJECT_BEFORE).getAttribute('aria-selected')).toBe('false');
  });

  it('marks a transition a selection names by its trace and span alone', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    render(
      selectionTree(makeNode(), {
        provider: stub.provider,
        actions: makeActions().actions,
        // Another record's id, but this transition's own span in its own trace:
        // the pair is the span's identity across tiers, so it names this row.
        selection: {
          eventId: 'evt_example_elsewhere',
          traceId: PANEL_CONTEXT_TRANSITION.traceId,
          spanId: PANEL_CONTEXT_TRANSITION.spanId,
        },
      }),
    );

    await screen.findByRole('grid');

    expect(rowWithValueBefore(OBJECT_BEFORE).getAttribute('aria-selected')).toBe('true');
    expect(rowWithValueBefore(NUMBER_BEFORE).getAttribute('aria-selected')).toBe('false');
  });

  it('follows the panel selection instead of keeping one of its own', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();
    const context = { provider: stub.provider, actions: spies.actions };

    const view = render(selectionTree(makeNode(), { ...context, selection: undefined }));

    await screen.findByRole('grid');
    await user.click(rowWithValueBefore(NUMBER_BEFORE));

    // The activation is reported with the transition's own record, exactly as
    // outside a host...
    expect(spies.onSelectEvent).toHaveBeenCalledWith({
      eventId: WIDGET_VALUE_TRANSITION.eventId,
      spanId: WIDGET_VALUE_TRANSITION.spanId,
      traceId: WIDGET_VALUE_TRANSITION.traceId,
    });

    // ...but the mark is the host's to move: until the panel's selection names
    // the record, no row claims to be selected.
    expect(rowWithValueBefore(NUMBER_BEFORE).getAttribute('aria-selected')).toBe('false');

    view.rerender(
      selectionTree(makeNode(), {
        ...context,
        selection: { eventId: WIDGET_VALUE_TRANSITION.eventId },
      }),
    );
    expect(rowWithValueBefore(NUMBER_BEFORE).getAttribute('aria-selected')).toBe('true');

    // A selection made in another view moves the mark here as well.
    view.rerender(
      selectionTree(makeNode(), {
        ...context,
        selection: { eventId: PANEL_CONTEXT_TRANSITION.eventId },
      }),
    );
    expect(rowWithValueBefore(NUMBER_BEFORE).getAttribute('aria-selected')).toBe('false');
    expect(rowWithValueBefore(OBJECT_BEFORE).getAttribute('aria-selected')).toBe('true');
  });

  it('marks nothing for a selected record the reader narrowed away', async () => {
    const stub = resolvingProvider([WIDGET_VALUE_TRANSITION, UNREPORTED_TRANSITION]);
    const user = userEvent.setup();

    render(
      selectionTree(makeNode(), {
        provider: stub.provider,
        actions: makeActions().actions,
        selection: { eventId: UNREPORTED_TRANSITION.eventId },
      }),
    );

    await screen.findByRole('grid');
    expect(dataRows().filter((row) => row.getAttribute('aria-selected') === 'true')).toHaveLength(
      1,
    );

    await user.click(screen.getByRole('button', { name: CHANGED_ONLY_NAME }));

    // The narrowed-away record leaves no neighbour marked in its place.
    expect(dataRows()).toHaveLength(1);
    expect(dataRows()[0]?.getAttribute('aria-selected')).toBe('false');
  });
});

describe('StateTransitionViewer toolbar filter reports', () => {
  it('reports each toggle as the toolbar state it leaves, in plain strings', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    await user.click(screen.getByRole('button', { name: CHANGED_ONLY_NAME }));

    expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, {
      sort: CHRONOLOGICAL,
      changedOnly: 'true',
      grouped: 'true',
    });

    await user.click(screen.getByRole('button', { name: GROUPING_NAME }));

    expect(spies.onFilterChange).toHaveBeenCalledTimes(2);
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, {
      sort: CHRONOLOGICAL,
      changedOnly: 'true',
      grouped: 'false',
    });

    // Both reports agree with what the toolbar now shows.
    expect(
      screen.getByRole('button', { name: CHANGED_ONLY_NAME }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: GROUPING_NAME }).getAttribute('aria-pressed')).toBe(
      'false',
    );

    // Every value is a string: the report carries what the toolbar holds and
    // no query shape.
    for (const [, filter] of spies.onFilterChange.mock.calls) {
      expect(Object.values(filter).every((value) => typeof value === 'string')).toBe(true);
    }

    // A local narrowing requests no page.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('reports a new order as the toolbar state it leaves, keeping the toggles', async () => {
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: PROVIDER_ORDER }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    // A toggle first, so the order's report is seen to carry it.
    await user.click(screen.getByRole('button', { name: CHANGED_ONLY_NAME }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: ORDER_CONTROL_NAME }),
      LONGEST_FIRST,
    );

    expect(spies.onFilterChange).toHaveBeenCalledTimes(2);
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, {
      sort: LONGEST_FIRST,
      changedOnly: 'true',
      grouped: 'true',
    });

    // The report names the order the next request carries.
    expect(queryOfCall(stub, 2).sort).toBe(LONGEST_FIRST);
  });

  it('includes the component narrowing and the chosen order in a toggle report', async () => {
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: [PANEL_CONTEXT_TRANSITION] }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode({ query: { source: 'stateTransitions', sort: LONGEST_FIRST } }), {
      provider: stub.provider,
      actions: spies.actions,
    });

    await screen.findByRole('grid');
    await user.selectOptions(
      screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME }),
      COMPONENT_PANEL,
    );
    await waitFor(() => {
      expect(renderedValuesBefore()).toEqual([OBJECT_BEFORE]);
    });

    await user.click(screen.getByRole('button', { name: GROUPING_NAME }));

    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, {
      sort: LONGEST_FIRST,
      component: COMPONENT_PANEL,
      changedOnly: 'false',
      grouped: 'false',
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Direction controls in captured text
 *
 * A component name, a hook label, a value preview, a trigger's name and a
 * location are captured text, and an invisible right-to-left override (U+202E)
 * in one of them draws the characters after it backwards. Every place this
 * view puts such text — the row header and toggle, the hook, both previews,
 * the trigger control, the source chip, the grid's name and the component
 * picker's native options — prints each control as its visible escape
 * (`\u202E`); a short preview is not called shortened merely because it
 * carries one; and every value handed back to the host stays as captured.
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

describe('StateTransitionViewer direction controls', () => {
  const component = `Example${RLO}Widget${PDF}`;
  const before = `"${RLO}</td><script>alert(7)</script>${PDF}"`;
  const after = `"done${RLO}"`;
  const bidiSource: SourceLocation = {
    file: `src/example/${RLO}widget.tsx`,
    line: 12,
    column: 3,
    symbol: component,
    resolvedBy: 'react-owner',
    confidence: 0.7,
  };
  const bidiTransition = makeTransition({
    id: `evt_${RLO}example`,
    component,
    hookLabel: `use${RLO}Flag`,
    previousValue: before,
    nextValue: after,
    valueType: 'string',
    triggerEventId: `evt_trigger_${RLO}0001`,
    triggerName: `click ${RLO}button`,
    triggerKind: 'interaction',
    transitionSource: 'state',
    source: bidiSource,
  });

  it('prints every control as its escape, the picker included', async () => {
    const title = `State ${RLO}changes`;
    const stub = resolvingProvider([bidiTransition]);

    renderComponent(makeNode({ title }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: formatUntrustedText(title) });

    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }
    const cells = cellsOf(row);

    // Both previews are whole, revealed, and not marked as shortened.
    expect(valueTextOf(cells.previous)).toBe(formatUntrustedText(before));
    expect(valueTextOf(cells.next)).toBe(formatUntrustedText(after));
    expect(cells.previous.querySelector('.dg-is-truncated')).toBeNull();
    expect(cells.next.querySelector('.dg-is-truncated')).toBeNull();

    // The trigger control, the hook and the row header show the markers.
    expect(
      within(cells.trigger).getByRole('button', {
        name: formatUntrustedText(bidiTransition.triggerName ?? ''),
      }),
    ).toBeDefined();
    expect(cells.hook.textContent).toContain(`use${RLO_MARKER}Flag`);
    expect(cells.component.textContent).toContain(formatUntrustedText(component));

    // The picker offers the captured component by its revealed label.
    const picker = screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME });
    const option = within(picker).getByRole('option', { name: formatUntrustedText(component) });
    expect(option.getAttribute('value')).toBe(component);
    expect(option.textContent).toContain(RLO_MARKER);

    // Nothing else a reader sees, hovers or hears carries a raw control — the
    // option's `value` is the filter's data, never displayed — and the markup
    // in the preview is only text.
    expect(rawDirectionSinks(document.body).filter((sink) => sink !== 'option[value]')).toEqual([]);
    expect(document.body.querySelector('script, td')).toBeNull();
  });

  it('narrows by, reports, selects and opens the raw values', async () => {
    const stub = pagingProvider([{ data: [bidiTransition] }, { data: [bidiTransition] }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');

    // The picker's value is the captured name: the re-query and the report
    // carry it raw.
    const picker = screen.getByRole('combobox', { name: COMPONENT_CONTROL_NAME });
    await user.selectOptions(
      picker,
      within(picker).getByRole('option', { name: formatUntrustedText(component) }),
    );

    expect(queryOfCall(stub, 2).filter).toEqual({ component });
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(
      NODE_ID,
      expect.objectContaining({ component }),
    );

    await waitFor(() => {
      expect(dataRows()).toHaveLength(1);
    });
    const [row] = dataRows();
    if (row === undefined) {
      throw new Error('the grid rendered no data row');
    }

    // The trigger reports the raw record id.
    await user.click(
      within(cellsOf(row).trigger).getByRole('button', {
        name: formatUntrustedText(bidiTransition.triggerName ?? ''),
      }),
    );
    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: bidiTransition.triggerEventId,
    });

    // The chip hands over the very location.
    await user.click(
      within(cellsOf(row).component).getByRole('button', {
        name: sourceLinkAccessibleName({ location: bidiSource, compact: true }),
      }),
    );
    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toEqual(bidiSource);
    expect(spies.onOpenSource.mock.calls[0]?.[0]?.file).toContain(RLO);
  });
});
