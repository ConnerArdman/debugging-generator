/**
 * `components/RenderTable` — the colocated suite, and the renderer half of the
 * render-count acceptance flow of the end-to-end suite: render counts and timing
 * per component, trigger attribution (context/props/state) where determinable,
 * and component names that link to their declarations.
 *
 * ## The one thing this suite exists for
 *
 * `tests/e2e/demo-excessive-renders.spec.ts` proves that a generated
 * re-render panel is materially different from a latency panel — a different
 * set of node types over a different capture. What an end-to-end run cannot
 * prove cheaply is the **semantics the panel rests on**, and this table carries
 * the one distinction the whole product's honesty depends on:
 *
 *   - `unchangedRenderCount` — props were shallow-equal, the component's own
 *     hook state was unchanged and no consumed context value changed. All
 *     three inputs were **evaluated**, and none had changed.
 *   - `unknownTriggerCount` — at least one of those three could **not** be
 *     evaluated, so nothing is claimed.
 *
 * "We checked and nothing changed" is an actionable observation; "we could not
 * check" is the absence of one. A view that added, defaulted or substituted one
 * for the other would turn an unevidenced claim into a headline figure through
 * the renderer rather than through the model — a claim no analysis may ever
 * contain. The never-merge cases below therefore assert the two figures under
 * their own labels, assert that the full five-member trigger vocabulary is
 * drawn including its zeros (an absent chip cannot say which of "nothing fell
 * in this bucket" and "this bucket is not shown" it means), and assert that
 * **the digit of their sum appears nowhere in the row**.
 *
 * ## The rest of what it pins, in the order the file asserts it
 *
 *  1. **All three states of a query-backed view**, driven through a stub
 *     `DataProvider`: a promise that never settles, a successful empty page and
 *     a rejection — with the failing query shown verbatim and a retry that
 *     really re-queries. The node's fixed empty sentence is asserted exactly.
 *  2. **Rows, figures and column order**: one row per component, counts and
 *     durations formatted by the package's own helpers rather than by literals
 *     restated here, and the eleven columns in their display order — each with a
 *     non-zero floor, so a narrow panel scrolls instead of squeezing a column
 *     to nothing.
 *  3. **Prop names only, never values**: the names render, no control exists to
 *     reveal a value, no cell pairs a name with one, and the expanded row
 *     states that values are never captured.
 *  4. **Bounded evidence is declared as bounded**: the footer says how much of
 *     the result is on screen; "Load more" requests the next page at exactly
 *     the provider's `nextOffset` with an unchanged `limit` and appends it,
 *     de-duplicated, beneath the rows already loaded — past the 5 000-row page
 *     ceiling too, and never without a `nextOffset`; a page beyond the
 *     contract's ceiling is clamped before it is requested; an explicit
 *     `limit: 0` is sent as zero, never pages and states its count; an empty
 *     page of a non-empty result says so with its position and total instead
 *     of claiming an empty capture; and a row whose per-render list the
 *     producer truncated says so when it is expanded.
 *  5. **The interaction contract**: the component name itself is the link to
 *     its declaration and the row's only source control, and clicking it hands
 *     `onOpenSource` the very `SourceLocation` the row carries, once; a name
 *     with no location is text with its full name as a tooltip and no control;
 *     an individual render selects itself through `onSelectEvent`; and an
 *     **aggregate row selects nothing**, because it stands for many events and
 *     has no id of its own — a fabricated coordinate would open a details
 *     drawer on evidence the reader never pointed at.
 *  6. **Ordering belongs to the data layer**: rows appear in the provider's own
 *     order, and a sort gesture is a re-query carrying the mapped
 *     `DataQuerySort` rather than a local re-ranking of one page — and it
 *     starts the page sequence over. Neither gesture unmounts the control it
 *     came from: the toolbar's select and a header's sort button stay the same
 *     focused element while the re-ordered first page loads, fails, comes back
 *     empty or arrives, with no row of the previous order in between.
 *  7. **The grid is one Tab stop, and the keyboard reaches everything in it**:
 *     exactly one element in the grid is in the Tab order — the active row —
 *     so Tab enters on it and the next Tab leaves; every control in a cell, an
 *     open detail row and the header is `tabIndex={-1}` and reached by the
 *     grid's arrow keys, ArrowRight first opening a collapsed row; every
 *     description — a header definition, an outlier's explanation, an unlinked
 *     component's full name — opens as an arrow key lands on its trigger, none
 *     sits inside a sortable header's button, and Escape closes an open one
 *     before it returns to the row. Every bubble stays mounted and resolves
 *     through `aria-describedby`, yet none is shown at rest: a closed one is
 *     `hidden`, and a pointer resting on a marked figure shows its explanation
 *     until the pointer leaves.
 *  8. **Names identify their row, and state lives where ARIA allows it**: a
 *     disclosure toggle carries `aria-expanded` and an `aria-controls` that
 *     resolves to the detail row it opened (never the row itself, which a
 *     `grid` does not allow), toggle and selection names carry the component
 *     name and the visible offset, the order control has a name no other
 *     table shares, and the footer's count is a polite live region.
 *  9. **One selection, shared**: the render that is the panel's selected event
 *     is marked by `dg-is-selected` and `aria-pressed` alike — the view's own
 *     last selection outside a host, the host's shared selection under one,
 *     matched by event id or by trace and span — and an evidence chip of the
 *     summary and a render in the table move one mark.
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
 *     so these cases exercise the seam the DevTools panel and the editor
 *     webview implement. Every query the component issues is recorded, because
 *     what it *asked for* is as much of its contract as what it drew.
 *   - **In-file synthetic builders, no fixture files**, and the aggregate
 *     shapes are hand-constructed: {@link makeRenderStat} and
 *     {@link makeOccurrence} never call `aggregateRenders`, so these assertions
 *     stand independent of the aggregation implementation and fail on a
 *     renderer change rather than on a producer change. The vocabularies
 *     themselves (`RENDER_TRIGGERS`, `RENDER_PHASES`) and the row-id prefix are
 *     imported, so no spelling is restated.
 *   - **Generic fixture vocabulary only**: two component names, one
 *     project-relative path, two prop names — none of which belongs to any
 *     application, demonstration or otherwise. `scripts/check-no-hardcoding.mjs`
 *     skips test files, so this suite keeps the product's neutral vocabulary by
 *     convention.
 *   - **Queries by role and accessible name.** The grid, its rows, its cells,
 *     its header controls, the chips and the footer button are all reached that
 *     way; a class or an attribute is read only off an element already obtained
 *     semantically, since no `jest-dom` matcher is available in this repository.
 *   - **No timers, no fake clocks, no arbitrary waits.** Post-resolution
 *     assertions go through `await screen.findBy…` or `waitFor`, and every
 *     interaction through `userEvent`.
 *
 * @see ./RenderTable for the component, its four states and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 * @see ../primitives/DataTable for the grid roles these queries rely on.
 */

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  PANEL_SPEC_VERSION,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySort, PanelSpec, RenderTableNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { RENDER_PHASES, RENDER_STAT_ID_PREFIX, RENDER_TRIGGERS } from '@debuggen/telemetry';
import type {
  RenderOccurrence,
  RenderPhase,
  RenderPhaseCounts,
  RenderStat,
  RenderTrigger,
  RenderTriggerHistogram,
} from '@debuggen/telemetry';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext, PanelSelectionContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef, PanelSelection } from '../host/PanelActions';
import { PanelHost } from '../host/PanelHost';
import { DATA_TABLE_COLUMN_TRACKS } from '../primitives/DataTable';
import type { DataTableColumnWidth } from '../primitives/DataTable';
import { DESIGN_TOKENS, cssVar } from '../tokens/tokens';
import type { TokenKey, TokenValues } from '../tokens/tokens';
import { RENDER_TRIGGER_TOKEN_KEYS } from '../utils/color';
import {
  MAX_PREVIEW_LENGTH,
  containsDirectionControl,
  formatCount,
  formatDuration,
  formatOffset,
  formatRenderTriggerLabel,
  formatSourceTooltip,
  formatUntrustedText,
  truncate,
} from '../utils/format';
import { RenderTable } from './RenderTable';
import { sourceLinkAccessibleName } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Application-neutral throughout: the component names, the file path, the
 * symbol and the prop names below belong to no inspected project, and neither
 * do the comments. The identifiers are shaped as a capture shapes them
 * — a 32-hex trace id, 16-hex span ids, epoch-millisecond start times,
 * millisecond durations — because those are the fields this view formats.
 * ---------------------------------------------------------------------------
 */

/** The component most cases draw a row for. */
const WIDGET_COMPONENT = 'ExampleWidget';

/** A second component, so a per-row assertion cannot pass against the wrong row. */
const LIST_COMPONENT = 'ExampleList';

/** A project-relative, POSIX path: the one location a row resolves to. */
const SOURCE_FILE = 'src/example/widget.tsx';

/** The symbol declared at that location. */
const SOURCE_SYMBOL = 'ExampleWidget';

/** Its 1-based coordinates. */
const SOURCE_LINE = 42;
const SOURCE_COLUMN = 7;

/** A complete, resolved location for the source-chip cases. */
const WIDGET_SOURCE: SourceLocation = {
  file: SOURCE_FILE,
  line: SOURCE_LINE,
  column: SOURCE_COLUMN,
  symbol: SOURCE_SYMBOL,
  resolvedBy: 'code-graph',
  confidence: 0.9,
};

/** The accessible name `SourceLink` gives its interactive form. */
const SOURCE_CHIP_NAME = `Open ${SOURCE_FILE}:${String(SOURCE_LINE)}:${String(SOURCE_COLUMN)}`;

/**
 * The accessible name of a row's linked component name, computed by
 * `SourceLink`'s own exported rule from the props the component passes it: the
 * name it shows, then the location it opens.
 *
 * @param component The component name the chip is captioned with.
 * @param location The location the chip opens.
 * @returns The chip's accessible name.
 */
function nameChipName(component: string, location: SourceLocation = WIDGET_SOURCE): string {
  return sourceLinkAccessibleName({ location, label: component, compact: true });
}

/**
 * A component name far longer than any column is wide, yet well inside the
 * shared preview budget, so every surface that shows it must show it whole: the
 * column's width may ellipsize it on screen, and nothing may shorten its text.
 */
const LONG_COMPONENT = 'ExampleWidgetWithADeliberatelyLongDescriptiveName';

/**
 * The heading an expanded row puts over the component's whole name. Spelled out
 * rather than imported, so the suite pins the word a reader sees.
 */
const COMPONENT_NAME_HEADING = 'Component';

/**
 * The width role of each column, in display order, as the component declares
 * them. See `COLUMN_WIDTHS` in `./RenderTable` for why each column takes its
 * role. Pinned exactly, because the role decides the column's floor, and a floor
 * of zero is the defect this list guards against — every column collapsing to
 * its padding in a narrow panel, and a name, a chip or a header painting over
 * the column beside it.
 */
const COLUMN_WIDTHS: readonly DataTableColumnWidth[] = [
  'text',
  'count',
  'quantity',
  'quantity',
  'quantity',
  'text',
  'count',
  'count',
  'text',
  'text',
  'label',
];

/**
 * A reference to one of the values a role track is built from: a column-geometry
 * token, the two layout tokens a truncating track measures its row by, or one of
 * the sums the grid publishes for it. Removing every such reference from a track
 * template must leave nothing but math frames, operators and the spaces between
 * tracks: no number and no unit is the component's own.
 */
const COLUMN_TOKEN_REFERENCE =
  /var\(--(?:dg-column-(?:(?:min|share)-[a-z]+|yield)|dg-space-2|dg-size-full|dgc-(?:readable-inline|min-inline|yield-count|column-count))\)/gu;

/** Every theme's token set, each of which must give every column a floor. */
const THEMES: readonly TokenValues[] = [
  DESIGN_TOKENS.dark,
  DESIGN_TOKENS.light,
  DESIGN_TOKENS.highContrast,
];

/** The fixture trace every render below belongs to: 32 lower-case hex digits. */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z.
 *
 * Far enough from zero that a relative performance timestamp could not be
 * mistaken for one, which is what makes the "offsets, never wall-clock times"
 * assertion in the expansion cases meaningful.
 */
const BASE_START_MS = 1_767_225_600_000;

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.renderTable';

/** The two prop names a row reports as changed. Names only: prop values are never captured. */
const FIRST_PROP = 'alpha';
const SECOND_PROP = 'beta';

/**
 * Two members of the data layer's sort vocabulary, held as typed constants so a
 * case names the vocabulary rather than a bare string that happens to match it.
 *
 * `count_desc` is the order this view opens in — the question it answers is
 * "how often" — and `duration_desc` is the one a header activation maps to.
 */
const MOST_RENDERS_FIRST: DataQuerySort = 'count_desc';
const LONGEST_TOTAL_FIRST: DataQuerySort = 'duration_desc';

/**
 * The grid's accessible name, which this component fixes rather than taking
 * from the node: spelled out here so the suite pins the name a reader hears.
 */
const GRID_NAME = 'Render statistics per component';

/** The node type's fixed empty sentence, asserted exactly. */
const EMPTY_MESSAGE = 'No renders were captured for this interaction.';

/** The first line above {@link EMPTY_MESSAGE}: the empty capture's short title. */
const NOTHING_CAPTURED_TITLE = 'No renders';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/** The error state's retry control. */
const RETRY_NAME = 'Retry';

/**
 * The shared error-state contract, which every failed node reads by: the titles
 * of a failed view and of a failed next page and the generic lead each message
 * opens with, as `queryFailureProps` in `../host/useQuery` composes them, and
 * the focus key the retry control of `ErrorState` carries. The shared contract
 * is spelled out rather than imported, so a drift in its wording fails here too.
 */
const VIEW_FAILURE_TITLE = 'Could not load this view';
const VIEW_FAILURE_LEAD = 'The data for this view could not be loaded.';
const PAGE_FAILURE_TITLE = 'Could not load the next page';
const PAGE_FAILURE_LEAD =
  'The next page of this view could not be loaded. The rows already shown are unaffected.';
const RETRY_FOCUS_KEY = 'error-state-retry';

/** A provider rejection as the contract renders it: its sentence, code and hint. */
const PROVIDER_FAILURE_MESSAGE = 'The channel to the service is closed.';
const PROVIDER_FAILURE_CODE = 'TRANSPORT_DISCONNECTED';
const PROVIDER_FAILURE_HINT = 'Start the local service, then retry.';

/** The footer control that asks for a larger page. */
const LOAD_MORE_NAME = 'Load more';

/**
 * The toolbar's order control: named for what it orders, so it is not one of
 * several controls in a panel all announced as the same word.
 */
const SORT_CONTROL_NAME = 'Order renders';

/**
 * The disclosure control's name while its row is collapsed. It names the
 * component of its row, so no two rows' toggles are announced alike.
 *
 * @param component The component name the row draws.
 * @returns The toggle's accessible name.
 */
function expandNameOf(component: string): string {
  return `Show individual renders of ${component}`;
}

/**
 * The disclosure control's name while its row is open.
 *
 * @param component The component name the row draws.
 * @returns The toggle's accessible name.
 */
function collapseNameOf(component: string): string {
  return `Hide individual renders of ${component}`;
}

/**
 * The name of the control that selects one individual render as the panel's
 * evidence. It contains the offset the control shows, verbatim (WCAG 2.5.3),
 * and the component the render belongs to.
 *
 * @param component The component name the row draws.
 * @param offset The offset text the control shows.
 * @returns The control's accessible name.
 */
function selectOccurrenceNameOf(component: string, offset: string): string {
  return `Select ${component} render at ${offset}`;
}

/**
 * Matches the select control of any individual render of one component,
 * whatever offset it shows — for the cases that count or pick them.
 *
 * @param component The component name the row draws.
 * @returns A pattern anchored at the start of the name.
 */
function selectOccurrencePatternOf(component: string): RegExp {
  return new RegExp(`^Select ${component} render at `);
}

/**
 * The columns in display order, by the header each one shows.
 *
 * The list is the suite's coordinate system: a cell is addressed by its
 * column's label (see {@link cellFor}), so a case reads "the figure under
 * `Stable inputs`" instead of "the seventh cell". `Stable inputs` and
 * `Unclassified` are two entries here for the same reason they are two columns
 * in the component — they are different observations.
 */
const COLUMN_LABELS = [
  'Component',
  'Renders',
  'Total',
  'Average',
  'Longest',
  'Triggers',
  'Stable inputs',
  'Unclassified',
  'Changed props',
  'Changed contexts',
  'Phases',
] as const;

/** One column's label. */
type ColumnLabel = (typeof COLUMN_LABELS)[number];

/** The two figure columns whose conflation this suite exists to prevent. */
const STABLE_INPUTS_COLUMN: ColumnLabel = 'Stable inputs';
const UNCLASSIFIED_COLUMN: ColumnLabel = 'Unclassified';

/** The two sortable columns, named by the control their header renders. */
const RENDERS_SORT_NAME: ColumnLabel = 'Renders';
const TOTAL_SORT_NAME: ColumnLabel = 'Total';

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 *
 * Hand-constructed aggregates, never computed ones: nothing below calls
 * `aggregateRenders` or `summarizeRenderTriggers`, so a change in how the
 * producer folds events into rows cannot silently change what these cases
 * assert about the renderer.
 * ---------------------------------------------------------------------------
 */

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/**
 * A trigger histogram over the whole vocabulary, zero-filled.
 *
 * Written key by key rather than derived, so the compiler requires an entry for
 * every member: a member added to `RENDER_TRIGGERS` fails to compile here,
 * beside the fixture that has to grow. `triggersCoverTheVocabulary` below is
 * the runtime half of the same guarantee.
 *
 * @param counts The buckets that are not zero.
 * @returns A complete histogram.
 */
function makeTriggers(counts: Partial<Record<RenderTrigger, number>> = {}): RenderTriggerHistogram {
  return {
    props: counts.props ?? 0,
    state: counts.state ?? 0,
    context: counts.context ?? 0,
    unchanged: counts.unchanged ?? 0,
    unknown: counts.unknown ?? 0,
  };
}

/**
 * Phase counts over the whole commit vocabulary, zero-filled, on the same terms
 * as {@link makeTriggers}.
 *
 * @param counts The buckets that are not zero.
 * @returns Complete phase counts.
 */
function makePhases(counts: Partial<Record<RenderPhase, number>> = {}): RenderPhaseCounts {
  return {
    mount: counts.mount ?? 0,
    update: counts.update ?? 0,
  };
}

/**
 * The optional fields of an occurrence admit `undefined` explicitly, which
 * `Partial` does not under this repository's `exactOptionalPropertyTypes`:
 * passing `{ source: undefined }` is how a case asks for a render *without* a
 * location, and {@link makeOccurrence} drops the key rather than storing it.
 */
type OccurrenceOverrides = Partial<
  Pick<
    RenderOccurrence,
    'id' | 'eventId' | 'spanId' | 'traceId' | 'startTime' | 'durationMs' | 'trigger'
  >
> & {
  readonly phase?: RenderPhase | undefined;
  readonly changedPropKeys?: readonly string[] | undefined;
  readonly changedContexts?: readonly string[] | undefined;
  readonly source?: SourceLocation | undefined;
  /** The group size of a coalesced render; omitted for a single render. */
  readonly instanceCount?: number | undefined;
  /** The slowest instance of a coalesced render; omitted for a single render. */
  readonly maxInstanceDurationMs?: number | undefined;
};

/**
 * One observed render, as the `renders` aggregate reports it inside a row.
 *
 * `id` defaults to `eventId`, which is the contract the aggregate keeps (the
 * row identity of an occurrence *is* its event id), so the selection case can
 * assert that the reference the host receives names that event and nothing
 * invented.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh occurrence; nothing is shared between calls.
 */
function makeOccurrence(overrides: OccurrenceOverrides = {}): RenderOccurrence {
  const {
    eventId = 'event-example-0001',
    spanId = spanIdFor(1),
    traceId = TRACE_ID,
    startTime = BASE_START_MS,
    durationMs = 12,
    trigger = 'props',
    phase = 'update',
    changedPropKeys = [FIRST_PROP],
    changedContexts = [],
    source,
    instanceCount,
    maxInstanceDurationMs,
  } = overrides;

  return {
    id: overrides.id ?? eventId,
    eventId,
    spanId,
    traceId,
    startTime,
    durationMs,
    trigger,
    phase,
    changedPropKeys,
    changedContexts,
    ...(source === undefined ? {} : { source }),
    ...(instanceCount === undefined ? {} : { instanceCount }),
    ...(maxInstanceDurationMs === undefined ? {} : { maxInstanceDurationMs }),
  };
}

/** Overrides accepted by {@link makeRenderStat}, with the same `undefined` policy. */
type RenderStatOverrides = Partial<
  Pick<
    RenderStat,
    | 'id'
    | 'component'
    | 'renderCount'
    | 'totalDurationMs'
    | 'averageDurationMs'
    | 'maxDurationMs'
    | 'firstStartTime'
    | 'lastStartTime'
    | 'triggers'
    | 'unchangedRenderCount'
    | 'unknownTriggerCount'
    | 'phaseCounts'
    | 'changedPropKeys'
    | 'changedPropCounts'
    | 'changedContexts'
    | 'changedContextCounts'
    | 'declaredInProject'
    | 'occurrences'
    | 'occurrencesTruncated'
  >
> & {
  readonly source?: SourceLocation | undefined;
};

/**
 * One component's render statistics, complete and internally consistent.
 *
 * Two defaults encode invariants the aggregate publishes rather than numbers
 * chosen for convenience, so a fixture cannot quietly assert something the
 * producer would never emit:
 *
 *   - `id` is the aggregate's own deterministic identity, the imported prefix
 *     followed by the component name;
 *   - `unchangedRenderCount` and `unknownTriggerCount` default to the matching
 *     buckets of `triggers`, which is exactly what the aggregate guarantees
 *     (`RenderStat.unchangedRenderCount` *is* `triggers.unchanged`) — and they
 *     stay overridable so a case can hand the component a row that disagrees
 *     with itself and watch it print what it was given rather than a repair.
 *
 * The default row reports counts only, with no per-render list and
 * `occurrencesTruncated: true`, which is what the service answers when
 * occurrences were not requested; the expansion cases supply their own. It
 * names no changed context, and it is declared in the project — so no default
 * page mixes project and outside rows, and the scope control stays out of
 * every case that does not ask for it.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh row; nothing is shared between calls.
 */
function makeRenderStat(overrides: RenderStatOverrides = {}): RenderStat {
  const {
    component = WIDGET_COMPONENT,
    renderCount = 12,
    totalDurationMs = 480,
    averageDurationMs = 40,
    maxDurationMs = 96,
    firstStartTime = BASE_START_MS,
    lastStartTime = BASE_START_MS + 900,
    triggers = makeTriggers({ props: 4, state: 2, context: 1, unchanged: 3, unknown: 2 }),
    phaseCounts = makePhases({ mount: 1, update: 11 }),
    changedPropKeys = [FIRST_PROP, SECOND_PROP],
    changedPropCounts = { [FIRST_PROP]: 4, [SECOND_PROP]: 2 },
    changedContexts = [],
    changedContextCounts = {},
    declaredInProject = true,
    occurrences = [],
    occurrencesTruncated = true,
    source,
  } = overrides;

  return {
    id: overrides.id ?? `${RENDER_STAT_ID_PREFIX}${component}`,
    component,
    renderCount,
    totalDurationMs,
    averageDurationMs,
    maxDurationMs,
    firstStartTime,
    lastStartTime,
    triggers,
    unchangedRenderCount: overrides.unchangedRenderCount ?? triggers.unchanged,
    unknownTriggerCount: overrides.unknownTriggerCount ?? triggers.unknown,
    phaseCounts,
    changedPropKeys,
    changedPropCounts,
    changedContexts,
    changedContextCounts,
    declaredInProject,
    occurrences,
    occurrencesTruncated,
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * A copy of a fixture with some of its fields removed — the shape a stored
 * answer from a build that predates those fields arrives in. The type still
 * claims every field, exactly as it does for a consumer reading such a row.
 *
 * @param value The fixture to copy; it is not modified.
 * @param keys The fields to leave out of the copy.
 * @returns A shallow copy without those fields.
 */
function without<T extends object>(value: T, ...keys: readonly (keyof T & string)[]): T {
  const copy = { ...value };

  for (const key of keys) {
    Reflect.deleteProperty(copy, key);
  }

  return copy;
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
type NodeOverrides = Partial<Pick<RenderTableNode, 'id' | 'query'>> & {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/**
 * A normalised `renderTable` node, as the panel normaliser produces one: an id,
 * no heading (the host's section owns that) and a query whose source and
 * ordering are already explicit.
 *
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(overrides: NodeOverrides = {}): RenderTableNode {
  const {
    id = NODE_ID,
    query = { source: 'renders', sort: MOST_RENDERS_FIRST },
    title,
    description,
  } = overrides;

  return {
    type: 'renderTable',
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
 * exactly this shape: one resolver answering every query. It brings the single
 * type assertion the generic `DataProvider.query` signature would otherwise
 * force into this file, and its own check that a response answers for the
 * source it was asked about.
 * ---------------------------------------------------------------------------
 */

/** One page a stub provider can answer with. */
interface RenderPage {
  /** The rows of the page, in the order the service returned them. */
  readonly data: readonly RenderStat[];

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
   * Every query the component has asked for, in call order — the assertion
   * surface for the paging, ordering and clamping cases.
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
 * The builder the ordering and paging cases need: a re-query has to be able to
 * answer differently from the query before it, or "the rows follow the second
 * response" could not be told from "the rows were re-ordered in the browser".
 *
 * @param pages The pages, in call order. At least one.
 * @returns The stub provider.
 */
function pagingProvider(pages: readonly RenderPage[]): StubProvider {
  return recordingProvider((_query, call) => {
    const page = pages[Math.min(call, pages.length) - 1];

    if (page === undefined) {
      throw new Error('the stub provider was built with no pages');
    }

    return Promise.resolve<DataQueryResponse>({
      source: 'renders',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    });
  });
}

/**
 * A provider that resolves one page for every query.
 *
 * @param data The rows of the page, in the order they should be drawn.
 * @param extra The paging counters to report, if any.
 * @returns The stub provider.
 */
function resolvingProvider(
  data: readonly RenderStat[],
  extra: Omit<RenderPage, 'data'> = {},
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
 * implementation for: the code it carries is what the error state renders.
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

  /** The order-report spy. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies: both required members and both optional ones.
 *
 * All four are supplied so that every case can assert not only that the intent
 * it exercised was raised, but also that the others were not — activating a
 * source chip must not also select an event, and selecting a render must not
 * report an order change.
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
  node: RenderTableNode,
  context: { readonly provider: DataProvider; readonly actions: PanelActions },
): void {
  render(
    <DataProviderContext.Provider value={context.provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={context.actions}>
          <RenderTable node={node} />
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

/**
 * The open detail rows, in document order.
 *
 * Narrowed by the class `../primitives/DataTable` declares for the detail row
 * it fills from `renderExpandedRow`, which is the only thing that distinguishes
 * it from the header row — both are `role="row"` without a row index.
 *
 * @returns The detail rows of whichever rows are expanded.
 */
function detailRows(): HTMLElement[] {
  return screen
    .getAllByRole('row')
    .filter((row) => row.classList.contains('dg-data-table__expanded'));
}

/**
 * The component name of each data row, in document order.
 *
 * Read off the row's header cell — obtained by role — and then from the
 * component's own name element inside it: the text of an unlinked name, or the
 * visible caption of the source link a linked name is. The link's glyph has no
 * text and its tooltip sits outside it, so each row contributes its component
 * name and nothing else.
 *
 * @returns One name per row.
 */
function renderedNames(): string[] {
  return dataRows().map((row) => {
    const header = within(row).getByRole('rowheader');

    return header.querySelector('.dg-render-table__component-cell')?.textContent ?? '';
  });
}

/**
 * The data row whose component name is `component`.
 *
 * @param component The component name to find.
 * @returns That row.
 */
function rowFor(component: string): HTMLElement {
  const row = dataRows()[renderedNames().indexOf(component)];

  if (row === undefined) {
    throw new Error(`no rendered row is named "${component}"`);
  }

  return row;
}

/**
 * The element that draws a row's component name: the text of an unlinked
 * name, or the source-link button a linked name is.
 *
 * Read from the row's header cell, where the name is the only element carrying
 * the name class, so the case holds the very element a reader sees and clicks.
 *
 * @param row The data row.
 * @returns The name element.
 */
function nameOf(row: HTMLElement): HTMLElement {
  const name = within(row)
    .getByRole('rowheader')
    .querySelector<HTMLElement>('.dg-render-table__component-cell');

  if (name === null) {
    throw new Error('the row header draws no component name');
  }

  return name;
}

/**
 * The magnitude, in `ch`, that a role's floor token resolves to in one theme.
 *
 * @param width The column's width role.
 * @param theme The token set to resolve against.
 * @returns The floor in `ch`, or `undefined` when the floor is no `ch` token.
 */
function floorChOf(width: DataTableColumnWidth, theme: TokenValues): number | undefined {
  const { floor } = DATA_TABLE_COLUMN_TRACKS[width];
  const keys = Object.keys(theme) as TokenKey[];
  const key = keys.find((candidate) => cssVar(candidate) === floor);
  const magnitude = key === undefined ? undefined : /^(\d+(?:\.\d+)?)ch$/u.exec(theme[key])?.[1];

  return magnitude === undefined ? undefined : Number(magnitude);
}

/**
 * The cells of one data row, in column order.
 *
 * The identity column is a `rowheader` and the other ten are `gridcell`s, so
 * the two role queries are concatenated in that order — which is the columns'
 * own order, since the identity column is the leftmost.
 *
 * @param row The data row.
 * @returns Its eleven cells.
 */
function cellsOf(row: HTMLElement): HTMLElement[] {
  return [...within(row).getAllByRole('rowheader'), ...within(row).getAllByRole('gridcell')];
}

/**
 * The cell of one data row under the column with the given header.
 *
 * @param row The data row.
 * @param label The column's header, from {@link COLUMN_LABELS}.
 * @returns That cell.
 */
function cellFor(row: HTMLElement, label: ColumnLabel): HTMLElement {
  const cell = cellsOf(row)[COLUMN_LABELS.indexOf(label)];

  if (cell === undefined) {
    throw new Error(`the row has no cell under "${label}"`);
  }

  return cell;
}

/**
 * The header cell of the column with the given header text.
 *
 * Matched by prefix rather than by equality: six of the eleven headers carry a
 * `Tooltip`, whose bubble stays mounted — hidden — while it is closed, so the
 * cell's text is its label followed by its description.
 *
 * @param label The column's header, from {@link COLUMN_LABELS}.
 * @returns That header cell.
 */
function headerFor(label: ColumnLabel): HTMLElement {
  const header = screen
    .getAllByRole('columnheader')
    .find((cell) => (cell.textContent ?? '').startsWith(label));

  if (header === undefined) {
    throw new Error(`no column is headed "${label}"`);
  }

  return header;
}

/**
 * The `aria-sort` a sortable column reports.
 *
 * Read off the header CELL rather than off the control inside it, which is
 * where `../primitives/DataTable` writes it: a reader asks the column how it is
 * sorted, not the button.
 *
 * @param label The sortable column's header.
 * @returns Its reported ordering.
 */
function ariaSortOf(label: ColumnLabel): string | null {
  const cell = screen.getByRole('button', { name: label }).closest('[role="columnheader"]');

  if (cell === null) {
    throw new Error(`the control named "${label}" is not inside a column header`);
  }

  return cell.getAttribute('aria-sort');
}

/**
 * The toolbar's order control, narrowed to the element type its value is read
 * from.
 *
 * @returns The `<select>` the `Toolbar` rendered.
 */
function orderControl(): HTMLSelectElement {
  const control = screen.getByRole('combobox', { name: SORT_CONTROL_NAME });

  if (!(control instanceof HTMLSelectElement)) {
    throw new Error('the order control is not a select element');
  }

  return control;
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

/**
 * The detail row of the one row that is expanded.
 *
 * @returns That detail row.
 */
function onlyDetailRow(): HTMLElement {
  const rows = detailRows();

  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('no row is expanded');
  }

  return row;
}

/**
 * The disclosure toggle of one data row: the one button in its component cell
 * that reports an expanded state.
 *
 * Found by role and then narrowed by `aria-expanded`, whatever its current
 * name, so a case can read the toggle's state in either direction without
 * restating which of its two names it carries at that moment.
 *
 * @param component The component name of the row.
 * @returns That row's toggle.
 */
function toggleOf(component: string): HTMLElement {
  const toggles = within(cellFor(rowFor(component), 'Component'))
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('aria-expanded'));

  expect(toggles).toHaveLength(1);

  const [toggle] = toggles;

  if (toggle === undefined) {
    throw new Error(`the row "${component}" has no disclosure toggle`);
  }

  return toggle;
}

/**
 * Asserts that an open toggle reports its state and names the detail row it
 * revealed, by an id that resolves in the document to exactly that element —
 * the `aria-controls` relationship an assistive technology follows.
 *
 * @param toggle The row's disclosure toggle.
 * @param detail The detail row the grid rendered for that row.
 */
function expectControlsDetail(toggle: HTMLElement, detail: HTMLElement): void {
  const controls = toggle.getAttribute('aria-controls');

  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(controls).not.toBeNull();
  expect(controls).toBe(detail.id);
  expect(document.getElementById(controls ?? '')).toBe(detail);
}

/**
 * The `role="tooltip"` elements a trigger is described by, resolved through
 * its `aria-describedby` exactly as an assistive technology resolves them.
 * Every id it names must resolve: a description pointing at nothing is a
 * defect in itself.
 *
 * `Tooltip` keeps its bubble mounted for the trigger's whole life, with its
 * `id` and `role` fixed, so a closed trigger is described by its bubble too —
 * one carrying `hidden`, which no role query finds and no reader is shown.
 * Whether a description is being shown is {@link isShownBubble}'s question.
 *
 * @param trigger The trigger.
 * @returns Its tooltip descriptions, shown or not.
 */
function describingBubbles(trigger: HTMLElement): HTMLElement[] {
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
 * Whether a tooltip bubble is being shown.
 *
 * `Tooltip` writes the two halves of that state together: open, the bubble
 * carries `dg-is-open` and no `hidden` attribute; closed, it carries `hidden`
 * — out of the accessibility tree and of every role query — and no open class.
 * The halves are asserted to agree, because a bubble with one and not the
 * other would be shown to one audience and withheld from another.
 *
 * @param bubble A `role="tooltip"` element.
 * @returns `true` while the bubble is open.
 */
function isShownBubble(bubble: HTMLElement): boolean {
  const open = bubble.classList.contains('dg-is-open');

  expect(bubble.hidden).toBe(!open);

  return open;
}

/**
 * The descriptions of every tooltip inside `scope`, each opened the way a
 * keyboard reader opens it — focus arriving on its trigger — read while it is
 * shown, and closed again as focus leaves.
 *
 * Only a shown bubble's text counts: every bubble is mounted, so its text is
 * in the document even while closed, and a description that did not open on
 * focus is one the reader never heard.
 *
 * @param scope The element whose tooltips to read.
 * @returns One text per opened description, in document order.
 */
function openedDescriptions(scope: HTMLElement): string[] {
  return [...scope.querySelectorAll<HTMLElement>('.dg-tooltip__trigger > *')].flatMap((trigger) => {
    fireEvent.focus(trigger);
    const texts = describingBubbles(trigger)
      .filter(isShownBubble)
      .map((bubble) => bubble.textContent ?? '');
    fireEvent.blur(trigger);

    expect(describingBubbles(trigger).filter(isShownBubble)).toHaveLength(0);

    return texts;
  });
}

/*
 * ---------------------------------------------------------------------------
 * The rows most cases draw
 *
 * Distinct component names, distinct counts and, within each row, three
 * distinct durations, so a per-row assertion cannot pass by matching another
 * row or another column. Neither row's rendered text contains the digit `5`,
 * which is what lets the never-merge case assert the absence of the sum of its
 * two figures rather than merely the presence of each.
 *
 * Deliberately NOT in count order: the ordering cases render them exactly as
 * the provider hands them over.
 * ---------------------------------------------------------------------------
 */

/**
 * A component with a mixed trigger histogram: four renders with changed props,
 * two with changed state, one with a changed context value, three with stable
 * inputs and two that could not be classified — twelve in all.
 */
const WIDGET_ROW = makeRenderStat();

/** A second component, quieter, reporting no prop changes at all. */
const LIST_ROW = makeRenderStat({
  component: LIST_COMPONENT,
  renderCount: 4,
  totalDurationMs: 64,
  averageDurationMs: 16,
  maxDurationMs: 24,
  triggers: makeTriggers({ props: 2, state: 1, unchanged: 1 }),
  phaseCounts: makePhases({ mount: 1, update: 3 }),
  changedPropKeys: [],
  changedPropCounts: {},
});

/** The two rows in the order the provider returns them below. */
const PROVIDER_ORDER: readonly RenderStat[] = [LIST_ROW, WIDGET_ROW];

/** Their component names, in that same order. */
const PROVIDER_ORDER_NAMES: readonly string[] = PROVIDER_ORDER.map((stat) => stat.component);

describe('RenderTable states', () => {
  it('renders the loading state, and no rows, while the query has not settled', () => {
    const stub = pendingProvider();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // `LoadingState` owns the announcement; this component contributes the
    // element class that places it and the label it announces.
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.classList.contains('dg-render-table__loading')).toBe(true);
    expect(within(busy).getByText(/loading render statistics/i)).toBeDefined();

    // Nothing is drawn yet: no grid, therefore no rows, and above all no empty
    // state — an unsettled query is not an answer.
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

    // One query, issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders the empty sentence for this node, and no rows, for a successful empty page', async () => {
    const stub = resolvingProvider([]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The node's fixed empty sentence, exactly: generic product vocabulary
    // that names the class of evidence and says the capture holds none of it,
    // and no inspected project.
    const message = await screen.findByText(EMPTY_MESSAGE);
    expect(message.classList.contains('dg-empty-state__message')).toBe(true);

    for (const name of PROVIDER_ORDER_NAMES) {
      expect(message.textContent).not.toContain(name);
    }
    expect(message.textContent).not.toContain(SOURCE_FILE);

    // An empty page is a success, so it is drawn as an absence and not as a
    // failure — and there is no grid to hold rows, and no order control, since
    // reordering nothing is a control that cannot act.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByRole('combobox', { name: SORT_CONTROL_NAME })).toBeNull();
  });

  it('renders an alert carrying the failed query, and retries it on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-render-table__error')).toBe(true);

    // What failed, and the provider's code so a developer can act on it. The
    // sentence states the failure and never what it might mean.
    expect(within(alert).getByText(/could not be loaded/i)).toBeDefined();
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, and compared as a value rather
    // than as a spelling. `limit` is the contract's published default because
    // the node authored none; `offset` is absent for the same reason — the side
    // that resolves the query applies that default, and this view invents none.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'renders',
      sort: MOST_RENDERS_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
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
      new DebuggenError(PROVIDER_FAILURE_CODE, PROVIDER_FAILURE_MESSAGE, {
        hint: PROVIDER_FAILURE_HINT,
      }),
    );

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // One failure on its own is the assertive announcement.
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-render-table__error')).toBe(true);

    // The glyph every error state draws, decorative and hidden from the name.
    const glyph = alert.querySelector('.dg-error-state__icon');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.querySelector('svg.dg-icon')).not.toBeNull();

    // The shared title, then the generic lead followed by the provider's own
    // cause, then the provider's hint on a line of its own.
    const title = within(alert).getByText(VIEW_FAILURE_TITLE);
    expect(title.classList.contains('dg-error-state__title')).toBe(true);
    const lines = Array.from(alert.querySelectorAll('.dg-error-state__message')).map(
      (line) => line.textContent ?? '',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith(VIEW_FAILURE_LEAD)).toBe(true);
    expect(lines[0]).toContain(PROVIDER_FAILURE_MESSAGE);
    expect(lines[1]).toBe(PROVIDER_FAILURE_HINT);

    // The code as a chip, not as prose.
    expect(within(alert).getByText(PROVIDER_FAILURE_CODE).closest('.dg-badge')).not.toBeNull();

    // The query block holds exactly the query that was asked.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual(soleQuery(stub));

    // The retry carries the key the host frame restores focus by.
    const retry = within(alert).getByRole('button', { name: RETRY_NAME });
    expect(retry.getAttribute('data-dg-focus-key')).toBe(RETRY_FOCUS_KEY);
  });
});

describe('RenderTable rows', () => {
  it('draws one row per component, with its counts, its timing and its phases', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // The grid is named by this component's own caption rather than by the
    // node, so the name a reader hears is the same in every panel that uses it.
    await screen.findByRole('grid', { name: GRID_NAME });
    expect(dataRows()).toHaveLength(PROVIDER_ORDER.length);

    // Eleven columns, in display order. Matched by prefix because six of the
    // headers carry a description that stays in the accessibility tree.
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(COLUMN_LABELS.length);
    COLUMN_LABELS.forEach((label, index) => {
      expect(headers[index]?.textContent ?? '').toMatch(new RegExp(`^${label}`));
    });

    for (const stat of PROVIDER_ORDER) {
      const row = rowFor(stat.component);

      // The identity cell is the row's header, so a reader hears the row named.
      expect(cellFor(row, 'Component')).toBe(within(row).getByRole('rowheader'));

      // The count, formatted by the package's own helper. With two rows there
      // is no distribution to stand out from, so the figure carries no outlier
      // mark and the cell is the number alone.
      expect(cellFor(row, 'Renders').textContent).toBe(formatCount(stat.renderCount));

      // Three durations, each scaled and carrying its unit.
      const total = within(row).getByText(formatDuration(stat.totalDurationMs));
      expect(total.classList.contains('dg-duration-cell')).toBe(true);
      expect(within(row).getByText(formatDuration(stat.averageDurationMs))).toBeDefined();
      expect(within(row).getByText(formatDuration(stat.maxDurationMs))).toBeDefined();

      // Both commit phases are drawn, zeros included, over the whole
      // vocabulary — so a bucket is never inferred from a missing chip.
      const phases = cellFor(row, 'Phases');
      for (const phase of RENDER_PHASES) {
        expect(
          within(phases).getByText(`${phase} ${formatCount(stat.phaseCounts[phase])}`),
        ).toBeDefined();
      }

      // Epoch milliseconds are a time base, not text a reader is shown.
      expect(row.textContent).not.toContain(String(stat.firstStartTime));
      expect(row.textContent).not.toContain(String(stat.lastStartTime));
    }

    // One literal, to prove a duration is rendered as a scaled quantity rather
    // than as the raw millisecond number the aggregate carried.
    expect(within(rowFor(WIDGET_COMPONENT)).getByText('480.00 ms')).toBeDefined();

    // The toolbar reports the order that was actually applied.
    expect(orderControl().value).toBe(MOST_RENDERS_FIRST);
  });

  it('marks a count that stands out from the loaded page, and explains the mark', async () => {
    // Four rows, so there is a distribution to stand out from: three components
    // rendered twice and one forty times. The threshold is derived from the
    // loaded page rather than fixed, because what counts as a lot of renders
    // depends entirely on the interaction.
    const quiet = ['ExampleCard', 'ExamplePanel', LIST_COMPONENT].map((component) =>
      makeRenderStat({
        component,
        renderCount: 2,
        totalDurationMs: 24,
        averageDurationMs: 12,
        maxDurationMs: 16,
        triggers: makeTriggers({ props: 1, unchanged: 1 }),
        phaseCounts: makePhases({ mount: 1, update: 1 }),
      }),
    );
    const loud = makeRenderStat({ renderCount: 40, totalDurationMs: 1_600 });
    const stub = resolvingProvider([loud, ...quiet]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // The marked figure, obtained by its text inside its own column's cell.
    const marked = cellFor(rowFor(WIDGET_COMPONENT), 'Renders');
    const figure = within(marked).getByText(formatCount(loud.renderCount));
    expect(figure.classList.contains('dg-render-table__count-cell')).toBe(true);
    expect(figure.classList.contains('dg-is-outlier')).toBe(true);

    // Not by colour alone: a glyph carries the mark on a monochrome surface,
    // and the cell states what the mark means rather than passing a heuristic
    // off as a verdict.
    expect(figure.querySelector('.dg-icon')).not.toBeNull();
    expect(openedDescriptions(marked).join(' ')).toMatch(/median of the loaded rows/i);

    // And no quiet row is marked: their cells are the figure and nothing else.
    for (const stat of quiet) {
      const cell = cellFor(rowFor(stat.component), 'Renders');
      expect(cell.textContent).toBe(formatCount(stat.renderCount));
      expect(within(cell).getByText(formatCount(stat.renderCount)).classList).not.toContain(
        'dg-is-outlier',
      );
    }
  });

  it('forces its own source onto the query, whatever source the node named', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    // A node that reached a renderer has been validated against the catalog,
    // whose `renderTable` entry permits one source. A malformed one must not
    // make this view ask the provider for a shape it could not draw.
    renderComponent(makeNode({ query: { source: 'spans', sort: MOST_RENDERS_FIRST } }), {
      provider: stub.provider,
      actions: makeActions().actions,
    });

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(soleQuery(stub).source).toBe('renders');
  });

  it('gives every column a non-zero floor, so a narrow panel scrolls instead of squeezing', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });
    const template = grid.style.getPropertyValue('--dgc-columns');

    // One role per column, resolved to the design system's track for that role
    // and to nothing the component sized itself.
    expect(COLUMN_WIDTHS).toHaveLength(COLUMN_LABELS.length);
    expect(template).toBe(
      COLUMN_WIDTHS.map((width) => DATA_TABLE_COLUMN_TRACKS[width].track).join(' '),
    );
    expect(
      template.replace(COLUMN_TOKEN_REFERENCE, '').replace(/\b(?:minmax|clamp|calc|max)\(/gu, '('),
    ).toMatch(/^[(), +*/-]+$/u);

    // Not one track is a floorless `minmax(0, …)`, which would let the name,
    // the histogram and the prop list collapse to their padding in a narrow
    // panel while their content paints over the next column's: each role's
    // floor is a positive length in every theme. And the name column is never
    // narrower than any other: it is what identifies the row, and the link to
    // its declaration.
    expect(template).not.toContain('minmax(0');
    for (const theme of THEMES) {
      const floors = COLUMN_WIDTHS.map((width) => floorChOf(width, theme) ?? 0);

      for (const floor of floors) {
        expect(floor).toBeGreaterThan(0);
      }
      expect(floors[0]).toBe(Math.max(...floors));
    }

    // Every column's minimum and readable floor reach the grid's own sums, which
    // decide whether a narrow panel truncates its name and text columns to fit or,
    // too narrow even for the minimums, keeps every floor and scrolls.
    expect(grid.style.getPropertyValue('--dgc-min-inline')).toBe(
      `calc(${COLUMN_WIDTHS.map((width) => DATA_TABLE_COLUMN_TRACKS[width].minimum).join(' + ')})`,
    );
    expect(grid.style.getPropertyValue('--dgc-readable-inline')).toBe(
      `calc(${COLUMN_WIDTHS.map((width) => DATA_TABLE_COLUMN_TRACKS[width].floor).join(' + ')})`,
    );
    expect(grid.style.getPropertyValue('--dgc-column-count')).toBe(String(COLUMN_LABELS.length));
  });
});

describe('RenderTable trigger attribution', () => {
  it('keeps stable-input renders and unclassified renders apart, and never adds them', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);
    const stable = cellFor(row, STABLE_INPUTS_COLUMN);
    const unclassified = cellFor(row, UNCLASSIFIED_COLUMN);

    // Two figures, two columns, two meanings: three renders were observed to
    // have stable inputs, and two could not be classified at all.
    expect(stable.textContent).toBe(formatCount(WIDGET_ROW.unchangedRenderCount));
    expect(unclassified.textContent).toBe(formatCount(WIDGET_ROW.unknownTriggerCount));
    expect(stable.textContent).not.toBe(unclassified.textContent);

    // And their sum is nowhere on the row. The fixture's every other figure is
    // free of this digit, so the assertion covers the columns above as well as
    // these two: a view that reported `unchanged + unknown` under either
    // heading, or that defaulted one to the other, fails here.
    const merged = formatCount(WIDGET_ROW.unchangedRenderCount + WIDGET_ROW.unknownTriggerCount);
    for (const cell of cellsOf(row)) {
      expect((cell.textContent ?? '').trim()).not.toBe(merged);
    }
    expect(row.textContent).not.toContain(merged);

    // The histogram beside them states both buckets separately, each as its own
    // chip carrying its own vocabulary member.
    const triggers = cellFor(row, 'Triggers');
    expect(
      within(triggers)
        .getByText(`unchanged ${formatCount(WIDGET_ROW.triggers.unchanged)}`)
        .getAttribute('data-trigger'),
    ).toBe('unchanged');
    expect(
      within(triggers)
        .getByText(`unknown ${formatCount(WIDGET_ROW.triggers.unknown)}`)
        .getAttribute('data-trigger'),
    ).toBe('unknown');

    // Each column states its own definition in full rather than leaving the
    // difference to be inferred from two adjacent words.
    expect(openedDescriptions(headerFor(STABLE_INPUTS_COLUMN)).join(' ')).toMatch(
      /none of them had changed/i,
    );

    const unclassifiedHeader = openedDescriptions(headerFor(UNCLASSIFIED_COLUMN)).join(' ');
    expect(unclassifiedHeader).toMatch(/could not be evaluated/i);
    expect(unclassifiedHeader).toMatch(/never as a stable-input render/i);
  });

  it('draws every trigger bucket, including the ones that are zero', async () => {
    // One component whose renders all had changed props: four of the five
    // buckets are empty, and an absent chip could not say whether the bucket
    // was empty or merely not shown — for `unchanged` and `unknown` those two
    // readings support opposite conclusions.
    const stat = makeRenderStat({
      renderCount: 6,
      totalDurationMs: 72,
      averageDurationMs: 12,
      maxDurationMs: 20,
      triggers: makeTriggers({ props: 6 }),
      phaseCounts: makePhases({ mount: 1, update: 5 }),
    });
    const stub = resolvingProvider([stat]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const triggers = cellFor(rowFor(WIDGET_COMPONENT), 'Triggers');

    // The vocabulary is five members, and the fixture builder covers it in
    // full, so "all five buckets" below is the vocabulary's own five rather
    // than a number this suite chose.
    expect(RENDER_TRIGGERS).toHaveLength(5);
    expect(Object.keys(makeTriggers()).toSorted()).toEqual([...RENDER_TRIGGERS].toSorted());

    for (const trigger of RENDER_TRIGGERS) {
      const chip = within(triggers).getByText(`${trigger} ${formatCount(stat.triggers[trigger])}`);
      expect(chip.getAttribute('data-trigger')).toBe(trigger);
    }

    // Five chips and no more, so no bucket is drawn twice and none is folded
    // into another.
    expect(within(triggers).getAllByText(/^[a-z]+ \d+$/)).toHaveLength(RENDER_TRIGGERS.length);

    // The two that matter are present as explicit zeros.
    expect(within(triggers).getByText(`unchanged ${formatCount(0)}`)).toBeDefined();
    expect(within(triggers).getByText(`unknown ${formatCount(0)}`)).toBeDefined();

    // And the two figure columns agree with them, still separately.
    const row = rowFor(WIDGET_COMPONENT);
    expect(cellFor(row, STABLE_INPUTS_COLUMN).textContent).toBe(formatCount(0));
    expect(cellFor(row, UNCLASSIFIED_COLUMN).textContent).toBe(formatCount(0));
  });

  it('tells the triggers apart by hue, draws empty buckets idle and dashes unknown', async () => {
    // Three populated inputs, a populated `unchanged` bucket and an empty
    // `unknown` one: the three inputs must not share one colour, a populated
    // `unchanged` bucket carries the warning, and an empty bucket — whatever
    // its trigger — carries no colour claim at all.
    const stat = makeRenderStat({
      triggers: makeTriggers({ props: 4, state: 2, context: 1, unchanged: 3, unknown: 0 }),
      unchangedRenderCount: 3,
      unknownTriggerCount: 0,
    });
    const stub = resolvingProvider([stat]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    const triggers = cellFor(rowFor(WIDGET_COMPONENT), 'Triggers');
    const chipFor = (trigger: RenderTrigger): HTMLElement =>
      within(triggers).getByText(`${trigger} ${formatCount(stat.triggers[trigger])}`);

    const inputHues = (['props', 'state', 'context'] as const).map((trigger) =>
      chipFor(trigger).style.getPropertyValue('--dgc-badge-color'),
    );
    expect(inputHues).toEqual([
      cssVar(RENDER_TRIGGER_TOKEN_KEYS.props),
      cssVar(RENDER_TRIGGER_TOKEN_KEYS.state),
      cssVar(RENDER_TRIGGER_TOKEN_KEYS.context),
    ]);
    expect(new Set(inputHues).size).toBe(3);

    const unchanged = chipFor('unchanged');
    expect(unchanged.style.getPropertyValue('--dgc-badge-color')).toBe(cssVar('warning'));
    expect(unchanged.classList.contains('dg-badge--warning')).toBe(true);
    expect(unchanged.hasAttribute('data-trigger-idle')).toBe(false);

    const unknown = chipFor('unknown');
    expect(unknown.getAttribute('data-trigger-idle')).toBe('true');
    expect(unknown.style.getPropertyValue('--dgc-badge-color')).toBe(cssVar('textMuted'));
    expect(unknown.classList.contains('dg-badge--neutral')).toBe(true);
    expect(unknown.classList.contains('dg-trigger-chip--dashed')).toBe(true);
    expect(unknown.classList.contains('dg-trigger-chip--idle')).toBe(true);
    expect(unchanged.classList.contains('dg-trigger-chip--idle')).toBe(false);

    for (const trigger of ['props', 'state', 'context', 'unchanged'] as const) {
      expect(chipFor(trigger).classList.contains('dg-trigger-chip--dashed'), trigger).toBe(false);
      expect(chipFor(trigger).classList.contains('dg-trigger-chip'), trigger).toBe(true);
    }
  });

  it('draws an empty unchanged bucket idle rather than as a warning', async () => {
    const stat = makeRenderStat({
      triggers: makeTriggers({ props: 6 }),
      unchangedRenderCount: 0,
      unknownTriggerCount: 0,
    });
    const stub = resolvingProvider([stat]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    const chip = within(cellFor(rowFor(WIDGET_COMPONENT), 'Triggers')).getByText(
      `unchanged ${formatCount(0)}`,
    );

    expect(chip.getAttribute('data-trigger-idle')).toBe('true');
    expect(chip.classList.contains('dg-badge--warning')).toBe(false);
    expect(chip.style.getPropertyValue('--dgc-badge-color')).toBe(cssVar('textMuted'));
  });

  it('prints the figures a row reports rather than recomputing them from the histogram', async () => {
    // A row that disagrees with itself — the aggregate guarantees these two
    // fields equal the matching buckets, so this can only arrive from a stored
    // row written by another build. The view states what it was given: a
    // renderer that "repaired" it would be inventing a count, and one that
    // filled a missing figure from the other bucket would be committing exactly
    // the conflation this table exists to prevent.
    const stat = makeRenderStat({
      triggers: makeTriggers({ props: 4, state: 2, context: 1, unchanged: 3, unknown: 2 }),
      unchangedRenderCount: 1,
      unknownTriggerCount: 0,
    });
    const stub = resolvingProvider([stat]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);
    expect(cellFor(row, STABLE_INPUTS_COLUMN).textContent).toBe(formatCount(1));
    expect(cellFor(row, UNCLASSIFIED_COLUMN).textContent).toBe(formatCount(0));

    // The histogram is still the histogram it was handed.
    const triggers = cellFor(row, 'Triggers');
    expect(within(triggers).getByText(`unchanged ${formatCount(3)}`)).toBeDefined();
    expect(within(triggers).getByText(`unknown ${formatCount(2)}`)).toBeDefined();
  });
});

describe('RenderTable changed props', () => {
  it('lists prop names, with no value and no way to ask for one', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const cell = cellFor(rowFor(WIDGET_COMPONENT), 'Changed props');

    // Names, which is all the producer sends: the fiber diff reports key names
    // and change counts and never a value, and opt-in full values are not
    // implemented.
    expect(within(cell).getByText(FIRST_PROP)).toBeDefined();
    expect(within(cell).getByText(SECOND_PROP)).toBeDefined();

    // No name is paired with anything, so nothing in this cell can be read as a
    // value: no assignment, no colon, no quoted text.
    expect(cell.textContent ?? '').not.toMatch(/[=:"']/);

    // And no affordance offers one — not in the cell, and not anywhere in the
    // view. A control that promised a value could only ever fail to deliver it.
    expect(within(cell).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /value/i })).toBeNull();
    expect(screen.queryByText(/show (the )?full value/i)).toBeNull();
  });

  it('says a row reported no prop changes instead of leaving the cell blank', async () => {
    const stub = resolvingProvider([LIST_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // An empty list means "nothing was reported", which is not the same claim
    // as "nothing changed" — so the cell says the first and never the second.
    const cell = cellFor(rowFor(LIST_COMPONENT), 'Changed props');
    expect(within(cell).getByText(/no prop changes reported/i)).toBeDefined();
  });

  it('states that values are never captured, and lists names with counts, when a row is expanded', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const detail = onlyDetailRow();

    // The expansion says what its prop list is, so its length is never read as
    // the width of a props object.
    expect(within(detail).getByText(/prop values are never captured/i)).toBeDefined();

    // Every reported name, with the number of renders it changed at — and
    // nothing else: each chip is the name followed by its count.
    for (const key of WIDGET_ROW.changedPropKeys) {
      const count = WIDGET_ROW.changedPropCounts[key];
      expect(count).toBeDefined();

      const chip = within(detail).getByText(new RegExp(`^${key}\\b`));
      expect(chip.textContent ?? '').toMatch(
        new RegExp(`^${key}\\b\\D*${formatCount(count ?? 0)}$`),
      );
      expect(chip.textContent ?? '').not.toMatch(/[=:"']/);
    }
  });
});

describe('RenderTable changed contexts', () => {
  /**
   * Six providers, in the aggregate's order — most frequent first — with
   * distinct counts, so an assertion on the order or on one count cannot pass
   * against another. Application-neutral names, like every fixture here.
   */
  const PROVIDERS: readonly (readonly [string, number])[] = [
    ['ExampleProviderA', 9],
    ['ExampleProviderB', 7],
    ['ExampleProviderC', 4],
    ['ExampleProviderD', 3],
    ['ExampleProviderE', 2],
    ['ExampleProviderF', 1],
  ];

  /** The provider names alone, in that order. */
  const PROVIDER_NAMES: readonly string[] = PROVIDERS.map(([name]) => name);

  /** A row whose context renders name all six providers. */
  const CONTEXT_ROW = makeRenderStat({
    triggers: makeTriggers({ props: 4, state: 2, context: 9, unchanged: 3, unknown: 2 }),
    renderCount: 20,
    changedContexts: PROVIDER_NAMES,
    changedContextCounts: Object.fromEntries(PROVIDERS),
  });

  /** The chip text of one provider: its name, then its count behind `×`. */
  function chipText(name: string, count: number): string {
    return `${name} ×${formatCount(count)}`;
  }

  it('names each changed context by its provider, with its count, most frequent first, and caps the cell', async () => {
    const stub = resolvingProvider([CONTEXT_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // Right after the changed props, as its own column.
    expect(COLUMN_LABELS.indexOf('Changed contexts')).toBe(
      COLUMN_LABELS.indexOf('Changed props') + 1,
    );

    const cell = cellFor(rowFor(WIDGET_COMPONENT), 'Changed contexts');
    const chips = [...cell.querySelectorAll('.dg-code')].map((chip) => chip.textContent);

    // The first four providers, in the order the aggregate gave them — the
    // provider behind most of the row's context renders is the first chip —
    // and the remainder counted, not hidden.
    expect(chips).toEqual(PROVIDERS.slice(0, 4).map(([name, count]) => chipText(name, count)));
    expect(within(cell).getByText(`+${formatCount(2)} more`)).toBeDefined();

    // Names and counts only: nothing in the cell reads as a value, and no
    // control offers one.
    expect(cell.textContent ?? '').not.toMatch(/[=:"']/);
    expect(within(cell).queryAllByRole('button')).toHaveLength(0);

    // The header says what a name is: the component providing the context.
    const header = openedDescriptions(headerFor('Changed contexts')).join(' ');
    expect(header).toMatch(/component that provides a context whose value changed/i);
    expect(header).toMatch(/context values are never captured/i);
  });

  it('says a row reported no context changes, also for a row stored without the field', async () => {
    const legacy = without(
      makeRenderStat({ component: LIST_COMPONENT }),
      'changedContexts',
      'changedContextCounts',
      'declaredInProject',
    );
    const stub = resolvingProvider([WIDGET_ROW, legacy]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // An empty list and an absent one are the same answer: nothing reported,
    // which is not the claim that nothing changed.
    for (const component of [WIDGET_COMPONENT, LIST_COMPONENT]) {
      const row = rowFor(component);
      const cell = cellFor(row, 'Changed contexts');

      expect(cell.textContent).toBe('No context changes reported');

      // And with no provider to name, the `context` chip is the plain chip its
      // header explains: no description, and no focus stop.
      const chip = within(cellFor(row, 'Triggers')).getByText(/^context \d+$/);
      expect(chip.hasAttribute('tabindex')).toBe(false);
      expect(chip.getAttribute('aria-describedby')).toBeNull();
    }
  });

  it('describes the context chip of the histogram with the providers the row names', async () => {
    const stub = resolvingProvider([CONTEXT_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const triggers = cellFor(rowFor(WIDGET_COMPONENT), 'Triggers');

    // The one described chip is `context`, focusable but never a Tab stop, and
    // its description names the leading providers with their counts.
    const context = within(triggers).getByText(`context ${formatCount(9)}`);
    expect(context.getAttribute('tabindex')).toBe('-1');
    expect(openedDescriptions(triggers)).toEqual([
      `Contexts that changed, by providing component: ${PROVIDERS.slice(0, 3)
        .map(([name, count]) => chipText(name, count))
        .join(', ')}, +${formatCount(3)} more.`,
    ]);

    // Every other bucket stays the plain, unfocusable chip.
    for (const trigger of RENDER_TRIGGERS.filter((member) => member !== 'context')) {
      const chip = within(triggers).getByText(
        `${trigger} ${formatCount(CONTEXT_ROW.triggers[trigger])}`,
      );
      expect(chip.hasAttribute('tabindex')).toBe(false);
    }
  });

  it('lists every changed context with its count, and what the names are, in the expanded row', async () => {
    const stub = resolvingProvider([CONTEXT_ROW]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const detail = onlyDetailRow();

    expect(within(detail).getByText('Changed contexts')).toBeDefined();
    expect(within(detail).getByText(/context values are never captured/i)).toBeDefined();

    // All six, where the cell showed four and a remainder.
    for (const [name, count] of PROVIDERS) {
      expect(within(detail).getByText(chipText(name, count))).toBeDefined();
    }
  });

  it('names the contexts that changed at an individual render beside its trigger chip', async () => {
    const named = makeOccurrence({
      eventId: 'event-example-0031',
      spanId: spanIdFor(31),
      startTime: BASE_START_MS,
      trigger: 'context',
      changedContexts: ['ExampleProviderA', 'ExampleProviderB'],
    });
    const unnamed = without(
      makeOccurrence({
        eventId: 'event-example-0032',
        spanId: spanIdFor(32),
        startTime: BASE_START_MS + 40,
        trigger: 'context',
      }),
      'changedContexts',
    );
    const stat = makeRenderStat({
      renderCount: 2,
      triggers: makeTriggers({ context: 2 }),
      phaseCounts: makePhases({ update: 2 }),
      changedContexts: ['ExampleProviderA', 'ExampleProviderB'],
      changedContextCounts: { ExampleProviderA: 1, ExampleProviderB: 1 },
      occurrences: [named, unnamed],
      occurrencesTruncated: false,
    });
    const stub = resolvingProvider([stat]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const lines = [
      ...onlyDetailRow().querySelectorAll<HTMLElement>('.dg-render-table__occurrence'),
    ];
    expect(lines).toHaveLength(2);

    const [namedLine, unnamedLine] = lines;
    if (namedLine === undefined || unnamedLine === undefined) {
      throw new Error('the expanded row lists fewer than two renders');
    }

    // `context · <ProviderA>, <ProviderB>`: the chip keeps its own word and
    // description, and the names follow it as text — the separator hidden from
    // assistive technology, which hears a lead naming the list instead.
    const chip = within(namedLine).getByText('context');
    expect(chip.getAttribute('data-trigger')).toBe('context');

    const names = within(namedLine).getByText('ExampleProviderA, ExampleProviderB', {
      exact: false,
    });
    expect(names.textContent).toBe('· Changed contexts: ExampleProviderA, ExampleProviderB');
    expect(within(names).getByText('·').getAttribute('aria-hidden')).toBe('true');
    expect(
      within(names).getByText('Changed contexts:').classList.contains('dg-visually-hidden'),
    ).toBe(true);

    // Text, not a control: nothing in it can take focus.
    expect(names.querySelector('[tabindex]')).toBeNull();
    expect(names.hasAttribute('tabindex')).toBe(false);

    // A render that names no context — here, one stored without the field —
    // shows its chip alone.
    expect(within(unnamedLine).getByText('context')).toBeDefined();
    expect(unnamedLine.textContent ?? '').not.toContain('Changed contexts');
    expect(unnamedLine.textContent ?? '').not.toContain('ExampleProvider');
  });
});

describe('RenderTable component scope', () => {
  /** The scope control, named for this table like the order control. */
  const SCOPE_CONTROL_NAME = 'Render table components';

  /** The toolbar's name while it holds both controls. */
  const SCOPED_TOOLBAR_NAME = 'Render table order and scope';

  /** The mark an outside row carries under "All components". */
  const OUTSIDE_MARK = 'Outside project';

  /**
   * Two components outside the project, named as a minifier names them — the
   * shape that made an unscoped table unreadable — and rendering far more
   * often than the project's own, so provider order puts them first.
   */
  const OUTSIDE_FIRST = makeRenderStat({
    component: 'xq',
    renderCount: 124,
    declaredInProject: false,
  });
  const OUTSIDE_SECOND = makeRenderStat({
    component: 'yr',
    renderCount: 34,
    declaredInProject: false,
  });

  /** Two components the project declares. */
  const PROJECT_FIRST = makeRenderStat({ renderCount: 29, declaredInProject: true });
  const PROJECT_SECOND = makeRenderStat({
    component: LIST_COMPONENT,
    renderCount: 12,
    declaredInProject: true,
  });

  /** A row stored by a build that predates the field: it says neither. */
  const UNSAID = without(
    makeRenderStat({ component: 'ExampleUnsaid', renderCount: 8 }),
    'declaredInProject',
  );

  /** A mixed page, in provider order: outside rows interleaved with the rest. */
  const MIXED_PAGE: readonly RenderStat[] = [
    OUTSIDE_FIRST,
    PROJECT_FIRST,
    OUTSIDE_SECOND,
    PROJECT_SECOND,
    UNSAID,
  ];

  /** The scope control, narrowed to the element its value and options are read from. */
  function scopeControl(): HTMLSelectElement {
    const control = screen.getByRole('combobox', { name: SCOPE_CONTROL_NAME });

    if (!(control instanceof HTMLSelectElement)) {
      throw new Error('the scope control is not a select element');
    }

    return control;
  }

  /** The texts of a select's options, in order. */
  function optionTexts(control: HTMLSelectElement): string[] {
    return [...control.options].map((option) => option.textContent);
  }

  it('leads with the project’s own components when the loaded rows hold both kinds, and says how many it hides', async () => {
    const stub = resolvingProvider(MIXED_PAGE, { total: MIXED_PAGE.length });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // Only the rows marked outside are out of view — a row that does not say
    // stays — and the rows kept are in provider order, not re-ranked.
    expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT, 'ExampleUnsaid']);

    // The control is offered beside the order control, defaulting to the
    // project, and each option states how many loaded rows it shows.
    const control = scopeControl();
    expect(control.value).toBe('project');
    expect(optionTexts(control)).toEqual([
      `Project components (${formatCount(3)})`,
      `All components (${formatCount(5)})`,
    ]);
    expect(screen.getByRole('group', { name: SCOPED_TOOLBAR_NAME })).toBeDefined();
    expect(orderControl().value).toBe(MOST_RENDERS_FIRST);

    // The paging counter still counts every loaded row, and the rows the scope
    // hides are stated in the same live line.
    const footer = screen.getByText(
      `Showing ${formatCount(5)} of ${formatCount(5)} components. ${formatCount(2)} components outside the project hidden.`,
    );
    expect(footer.getAttribute('aria-live')).toBe('polite');

    // Nothing in view is marked as outside: nothing outside is in view.
    expect(screen.queryByText(OUTSIDE_MARK)).toBeNull();

    // A scope is not a query.
    expect(soleQuery(stub)).toEqual({
      source: 'renders',
      sort: MOST_RENDERS_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
    });
  });

  it('shows every loaded row under “All components”, marks the outside ones, and reports the scope', async () => {
    const stub = resolvingProvider(MIXED_PAGE, { total: MIXED_PAGE.length });
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.selectOptions(scopeControl(), 'all');

    // Every loaded row, in provider order.
    await waitFor(() => {
      expect(renderedNames()).toEqual(MIXED_PAGE.map((stat) => stat.component));
    });
    expect(scopeControl().value).toBe('all');
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, { componentScope: 'all' });

    // The two outside rows carry the mark beside their name — never inside
    // it — described as what it means and reachable by the grid's keys only.
    for (const stat of [OUTSIDE_FIRST, OUTSIDE_SECOND]) {
      const cell = cellFor(rowFor(stat.component), 'Component');
      const mark = within(cell).getByText(OUTSIDE_MARK);

      expect(mark.classList.contains('dg-badge--neutral')).toBe(true);
      expect(mark.getAttribute('tabindex')).toBe('-1');
      expect(nameOf(rowFor(stat.component)).textContent).toBe(stat.component);
      expect(openedDescriptions(cell)).toContain(
        'Not declared in this project’s source — typically a framework or library component that the project’s own code renders.',
      );
    }

    // No project row, and not the row that does not say, carries it.
    for (const component of [WIDGET_COMPONENT, LIST_COMPONENT, 'ExampleUnsaid']) {
      expect(within(cellFor(rowFor(component), 'Component')).queryByText(OUTSIDE_MARK)).toBeNull();
    }

    // Nothing is hidden, so the footer is the paging counter alone.
    expect(
      screen.getByText(`Showing ${formatCount(5)} of ${formatCount(5)} components.`),
    ).toBeDefined();

    // Back to the project, reported the same way; and neither change asked the
    // provider for anything.
    await user.selectOptions(scopeControl(), 'project');
    await waitFor(() => {
      expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT, 'ExampleUnsaid']);
    });
    expect(spies.onFilterChange).toHaveBeenLastCalledWith(NODE_ID, {
      componentScope: 'project',
    });
    expect(spies.onFilterChange).toHaveBeenCalledTimes(2);
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('offers no scope, and hides and marks nothing, when the loaded rows are all of one kind', async () => {
    for (const page of [
      [OUTSIDE_FIRST, OUTSIDE_SECOND],
      [PROJECT_FIRST, PROJECT_SECOND],
      [PROJECT_FIRST, UNSAID],
    ]) {
      const stub = resolvingProvider(page);

      renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

      await screen.findByRole('grid', { name: GRID_NAME });

      expect(renderedNames()).toEqual(page.map((stat) => stat.component));
      expect(screen.queryByRole('combobox', { name: SCOPE_CONTROL_NAME })).toBeNull();
      expect(screen.getByRole('group', { name: 'Render table order' })).toBeDefined();
      expect(screen.queryByText(OUTSIDE_MARK)).toBeNull();
      expect(screen.queryByText(/outside the project hidden/)).toBeNull();

      cleanup();
    }
  });

  it('keeps paging over every loaded row, and offers the scope once a later page brings the other kind', async () => {
    const stub = pagingProvider([
      { data: [PROJECT_FIRST, PROJECT_SECOND], total: 4, nextOffset: 2 },
      { data: [OUTSIDE_FIRST, OUTSIDE_SECOND], total: 4 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(4)} components.`);
    expect(screen.queryByRole('combobox', { name: SCOPE_CONTROL_NAME })).toBeNull();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next page is requested exactly as before — at the provider's offset,
    // with the same page size — and counted in full, though the project scope
    // the control now offers keeps both of its rows out of view.
    expect(queryOfCall(stub, 2)).toEqual({
      source: 'renders',
      sort: MOST_RENDERS_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: 2,
    });
    await screen.findByText(
      `Showing ${formatCount(4)} of ${formatCount(4)} components. ${formatCount(2)} components outside the project hidden.`,
    );
    expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT]);
    expect(scopeControl().value).toBe('project');
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // Under "All components" the appended rows follow the first page's.
    await user.selectOptions(scopeControl(), 'all');
    await waitFor(() => {
      expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT, 'xq', 'yr']);
    });
    expect(stub.resolve).toHaveBeenCalledTimes(2);
  });

  it('measures the outlier mark against the rows in view', async () => {
    // In view under the project scope: counts 2, 2, 2 and 40 — a median of two,
    // so forty stands out. Under "All components" three outside rows at 100
    // join them, the median becomes forty, and nothing stands out any more.
    const quiet = ['ExampleCard', 'ExamplePanel', 'ExampleForm'].map((component) =>
      makeRenderStat({ component, renderCount: 2, declaredInProject: true }),
    );
    const loud = makeRenderStat({ renderCount: 40, declaredInProject: true });
    const outside = ['xa', 'xb', 'xc'].map((component) =>
      makeRenderStat({ component, renderCount: 100, declaredInProject: false }),
    );
    const stub = resolvingProvider([...outside, loud, ...quiet]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const figure = (): HTMLElement =>
      within(cellFor(rowFor(WIDGET_COMPONENT), 'Renders')).getByText(formatCount(40));

    expect(figure().classList.contains('dg-is-outlier')).toBe(true);
    expect(openedDescriptions(cellFor(rowFor(WIDGET_COMPONENT), 'Renders')).join(' ')).toMatch(
      /median of the loaded rows in view/i,
    );

    await user.selectOptions(scopeControl(), 'all');
    await waitFor(() => {
      expect(renderedNames()).toHaveLength(7);
    });

    expect(figure().classList.contains('dg-is-outlier')).toBe(false);
    for (const component of ['xa', 'xb', 'xc']) {
      expect(
        within(cellFor(rowFor(component), 'Renders'))
          .getByText(formatCount(100))
          .classList.contains('dg-is-outlier'),
      ).toBe(false);
    }
  });
});

describe('RenderTable expansion', () => {
  /** Two individual renders of one component, 320 ms apart. */
  const OCCURRENCES: readonly RenderOccurrence[] = [
    makeOccurrence({
      eventId: 'event-example-0001',
      spanId: spanIdFor(1),
      startTime: BASE_START_MS,
      durationMs: 12,
      trigger: 'props',
      phase: 'mount',
    }),
    makeOccurrence({
      eventId: 'event-example-0002',
      spanId: spanIdFor(2),
      startTime: BASE_START_MS + 320,
      durationMs: 24,
      trigger: 'unchanged',
      phase: 'update',
      changedPropKeys: [],
    }),
  ];

  /** A row whose per-render list is complete: two renders, two occurrences. */
  const COMPLETE_ROW = makeRenderStat({
    renderCount: 2,
    totalDurationMs: 36,
    averageDurationMs: 18,
    maxDurationMs: 24,
    triggers: makeTriggers({ props: 1, unchanged: 1 }),
    phaseCounts: makePhases({ mount: 1, update: 1 }),
    changedPropKeys: [FIRST_PROP],
    changedPropCounts: { [FIRST_PROP]: 1 },
    occurrences: OCCURRENCES,
    occurrencesTruncated: false,
  });

  it('reports the disclosure to the host and lists the individual renders', async () => {
    const stub = resolvingProvider([COMPLETE_ROW]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // The disclosure state lives on the toggle, never on the row: a `grid` row
    // does not support `aria-expanded`. Closed, the toggle names no controlled
    // element, because the detail row it would name is not in the document.
    const row = rowFor(WIDGET_COMPONENT);
    const toggle = toggleOf(WIDGET_COMPONENT);
    expect(row.getAttribute('aria-expanded')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    expect(detailRows()).toHaveLength(0);

    await user.click(within(row).getByRole('button', { name: expandNameOf(WIDGET_COMPONENT) }));

    // The state after the gesture, with this node's id and the row's own id, so
    // a host with two render tables can tell them apart and persist either.
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
    expect(spies.onExpand).toHaveBeenCalledWith(NODE_ID, COMPLETE_ROW.id, true);

    // Open, the toggle reports it and names the detail row that is now
    // rendered — by an id that resolves to exactly that element.
    const detail = onlyDetailRow();
    expectControlsDetail(toggleOf(WIDGET_COMPONENT), detail);
    expect(rowFor(WIDGET_COMPONENT).getAttribute('aria-expanded')).toBeNull();

    // The list says how much of the component's work it holds, and this row's
    // list is complete, so no truncation note is shown.
    expect(within(detail).getByText(/individual renders/i)).toBeDefined();
    expect(within(detail).getByText(/listing 2 of 2 renders/i)).toBeDefined();
    expect(within(detail).queryByText(/not every render is listed/i)).toBeNull();

    // One row per render, each offset from the component's own first observed
    // render rather than stamped with a wall-clock time.
    for (const occurrence of OCCURRENCES) {
      expect(
        within(detail).getByText(formatOffset(occurrence.startTime, COMPLETE_ROW.firstStartTime)),
      ).toBeDefined();
      expect(within(detail).getByText(formatDuration(occurrence.durationMs))).toBeDefined();
    }
    expect(detail.textContent).not.toContain(String(BASE_START_MS));
    expect(
      within(detail).getAllByRole('button', { name: selectOccurrencePatternOf(WIDGET_COMPONENT) }),
    ).toHaveLength(OCCURRENCES.length);

    // Each render states its own trigger, in the same vocabulary the histogram
    // uses — including the one that means "stable inputs".
    expect(within(detail).getByText('props')).toBeDefined();
    expect(within(detail).getByText('unchanged')).toBeDefined();

    // Collapsing is reported as the state it produced, not as a toggle.
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: collapseNameOf(WIDGET_COMPONENT),
      }),
    );

    expect(spies.onExpand).toHaveBeenCalledTimes(2);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, COMPLETE_ROW.id, false);
    expect(detailRows()).toHaveLength(0);
    expect(toggleOf(WIDGET_COMPONENT).getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf(WIDGET_COMPONENT).getAttribute('aria-controls')).toBeNull();

    // A disclosure is not a query: the page on screen is the page that was
    // resolved, and expanding it asked the provider for nothing.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('says outright when the producer bounded a row per-render list', async () => {
    // Twelve renders, two of them listed: the producer's own bound. An
    // expansion that silently showed a prefix would invite the reader to count
    // renders that are not there.
    const truncated = makeRenderStat({
      occurrences: OCCURRENCES,
      occurrencesTruncated: true,
    });
    const stub = resolvingProvider([truncated]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const detail = onlyDetailRow();
    expect(within(detail).getByText(/listing 2 of 12 renders/i)).toBeDefined();
    expect(within(detail).getByText(/not every render is listed/i)).toBeDefined();
  });

  it('counts a coalesced line as the renders it stands for and says its time is their total', async () => {
    // One line for eleven fibers that rendered alike in one commit, plus one
    // single render: twelve renders, all listed. Counting lines would print
    // "Listing 2 of 12" and read as truncation when nothing was bounded.
    const grouped = makeOccurrence({
      eventId: 'event-example-0003',
      spanId: spanIdFor(3),
      startTime: BASE_START_MS,
      durationMs: 44,
      instanceCount: 11,
      maxInstanceDurationMs: 7.5,
      trigger: 'context',
    });
    const single = makeOccurrence({
      eventId: 'event-example-0004',
      spanId: spanIdFor(4),
      startTime: BASE_START_MS + 250,
      durationMs: 3,
      trigger: 'context',
    });
    const coalesced = makeRenderStat({
      renderCount: 12,
      occurrences: [grouped, single],
      occurrencesTruncated: false,
    });
    const stub = resolvingProvider([coalesced]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const detail = onlyDetailRow();
    expect(within(detail).getByText(/listing 12 of 12 renders/i)).toBeDefined();
    expect(within(detail).queryByText(/not every render is listed/i)).toBeNull();

    // Only the grouped line is badged, with its size.
    const badges = detail.querySelectorAll<HTMLElement>('[data-instance-count]');
    expect(badges).toHaveLength(1);
    const badge = badges[0] as HTMLElement;
    expect(badge.textContent).toBe('×11');
    expect(badge.getAttribute('data-instance-count')).toBe('11');

    // The badge's description says the duration beside it is a total and how
    // long the slowest instance took.
    const [bubble] = describingBubbles(badge);
    expect(bubble?.textContent ?? '').toContain('11 renders of this component in one commit');
    expect(bubble?.textContent ?? '').toContain('The time shown is their total');
    expect(bubble?.textContent ?? '').toContain(`the slowest took ${formatDuration(7.5)}`);

    // Both lines stay selectable as the one event each of them is.
    expect(
      within(detail).getAllByRole('button', { name: selectOccurrencePatternOf(WIDGET_COMPONENT) }),
    ).toHaveLength(2);
  });

  it('treats a malformed instance count as one render', async () => {
    const malformed = makeOccurrence({ instanceCount: 2.5 });
    const stub = resolvingProvider([
      makeRenderStat({ renderCount: 1, occurrences: [malformed], occurrencesTruncated: false }),
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const detail = onlyDetailRow();
    expect(within(detail).getByText(/listing 1 of 1 renders/i)).toBeDefined();
    expect(detail.querySelectorAll('[data-instance-count]')).toHaveLength(0);
  });

  it('says a row carrying counts reported no individual renders at all', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const detail = onlyDetailRow();
    expect(within(detail).getByText(/no individual renders were reported/i)).toBeDefined();
    expect(
      within(detail).queryAllByRole('button', {
        name: selectOccurrencePatternOf(WIDGET_COMPONENT),
      }),
    ).toHaveLength(0);
  });

  it('keeps the whole of a name past the preview budget reachable, linked or not', async () => {
    // Longer than the shared preview budget, so the Component column's caption
    // is the budgeted preview and the column ellipsizes even that. The rest of
    // the name must still be somewhere a reader can get to.
    const unlinkedName = `ExampleUnlinked${'WidgetSegment'.repeat(9)}Tail`;
    const linkedName = `ExampleLinked${'WidgetSegment'.repeat(9)}Tail`;
    for (const name of [unlinkedName, linkedName]) {
      expect(Array.from(name).length).toBeGreaterThan(MAX_PREVIEW_LENGTH);
    }
    const stub = resolvingProvider([
      makeRenderStat({ component: unlinkedName }),
      makeRenderStat({ component: linkedName, source: WIDGET_SOURCE }),
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // An unlinked name's tooltip is the WHOLE name, not the caption it describes.
    const unlinkedTrigger = nameOf(rowFor(truncate(unlinkedName)));
    expect(unlinkedTrigger.textContent).toBe(truncate(unlinkedName));
    const unlinkedBubble = document.getElementById(
      unlinkedTrigger.getAttribute('aria-describedby') ?? '',
    );
    expect(unlinkedBubble?.getAttribute('role')).toBe('tooltip');
    expect(unlinkedBubble?.textContent).toBe(unlinkedName);

    // A linked name's chip leads its tooltip with the WHOLE name as well, ahead
    // of the location it opens, while its caption stays the budgeted preview.
    const linkedChip = nameOf(rowFor(truncate(linkedName)));
    expect(linkedChip.tagName.toLowerCase()).toBe('button');
    expect(linkedChip.textContent).toBe(truncate(linkedName));
    const linkedBubble = document.getElementById(linkedChip.getAttribute('aria-describedby') ?? '');
    expect(linkedBubble?.getAttribute('role')).toBe('tooltip');
    expect(linkedBubble?.textContent?.startsWith(`${linkedName} — `)).toBe(true);

    // And each row's detail opens with the whole name, as captured, whether the
    // row's name is text or the link to its declaration.
    for (const name of [unlinkedName, linkedName]) {
      await user.click(toggleOf(truncate(name)));

      const detail = onlyDetailRow();
      expect(within(detail).getByText(COMPONENT_NAME_HEADING)).toBeDefined();
      const whole = within(detail).getByText(name);
      expect(whole.tagName.toLowerCase()).toBe('code');
      expect(whole.classList.contains('dg-code--wrap')).toBe(true);

      await user.click(toggleOf(truncate(name)));
      expect(detailRows()).toHaveLength(0);
    }
  });

  it('shows no name heading over a blank component name', async () => {
    const stub = resolvingProvider([makeRenderStat({ component: '  ' })]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(toggleOf('  '));

    expect(within(onlyDetailRow()).queryByText(COMPONENT_NAME_HEADING)).toBeNull();
  });
});

describe('RenderTable interactions', () => {
  it('makes the component name the link to its declaration, handing the host that very location once', async () => {
    const located = makeRenderStat({ source: WIDGET_SOURCE });
    const stub = resolvingProvider([located]);
    const spies = makeActions();
    const user = userEvent.setup();

    // Taken BEFORE the render and compared afterwards: comparing the emitted
    // object's keys against the live fixture alone would be satisfied by a
    // component that added a field to it in place.
    const expectedKeys = Object.keys({ ...WIDGET_SOURCE }).toSorted();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    const chip = await screen.findByRole('button', { name: nameChipName(WIDGET_COMPONENT) });

    // The control IS the name, and activating it is how the row raises
    // `onOpenSource`: the element that draws the component name in the row
    // header is this button, captioned with the name, and the row offers its
    // location through nothing else — no second chip beside the name.
    const row = rowFor(WIDGET_COMPONENT);
    expect(nameOf(row)).toBe(chip);
    expect(chip.textContent).toBe(WIDGET_COMPONENT);
    expect(within(row).getByRole('rowheader').contains(chip)).toBe(true);
    expect(within(row).getAllByRole('button', { name: /open src\//iu })).toEqual([chip]);
    expect(row.querySelectorAll('.dg-source-link')).toHaveLength(1);

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

    // The very object the row carried, by reference — not a copy and not a
    // rebuilt location — and therefore equal with the same key set: a dropped
    // `symbol`, `resolvedBy` or `confidence` and an invented extra field both
    // fail here. Every hop after this one acts on the object it is handed.
    expect(received).toBe(WIDGET_SOURCE);
    expect(received).toEqual(WIDGET_SOURCE);
    expect(Object.keys(received).toSorted()).toEqual(expectedKeys);
    expect(received.file).toBe(SOURCE_FILE);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.line).toBe(SOURCE_LINE);
    expect(received.column).toBe(SOURCE_COLUMN);
    expect(received.symbol).toBe(SOURCE_SYMBOL);

    // Opening a declaration is not selecting evidence, and not expanding a row:
    // the chip's activation stops at the chip.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onFilterChange).not.toHaveBeenCalled();
  });

  it('describes a linked name by its full text and location, and keeps the name in its row header', async () => {
    // A name far wider than its column, declared at a symbol of the same name:
    // the column may ellipsize the caption, so the description is where a
    // reader finds it whole — beside the place it links to.
    const location: SourceLocation = { ...WIDGET_SOURCE, symbol: LONG_COMPONENT };
    const stub = resolvingProvider([
      makeRenderStat({ component: LONG_COMPONENT, source: location }),
    ]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(LONG_COMPONENT);
    const link = nameOf(row);

    // Captioned with the whole name: the column's width clips it on screen and
    // nothing shortens its text.
    expect(link.textContent).toBe(LONG_COMPONENT);

    // The description resolves exactly as an assistive technology resolves it,
    // to a tooltip naming the component in full and the place it links to.
    const bubble = document.getElementById(link.getAttribute('aria-describedby') ?? '');
    expect(bubble?.getAttribute('role')).toBe('tooltip');
    expect(bubble?.textContent).toBe(formatSourceTooltip(location));
    expect(bubble?.textContent ?? '').toContain(LONG_COMPONENT);
    expect(bubble?.textContent ?? '').toContain(SOURCE_CHIP_NAME.replace(/^Open /u, ''));

    // Focus is how a keyboard reader opens it.
    act(() => {
      link.focus();
    });
    expect(bubble?.classList.contains('dg-is-open')).toBe(true);
  });

  it('keeps a linked name in its row header even when the location names no symbol', async () => {
    // The link is named by its location, so without the name escorted beside it
    // a location with no symbol would leave the row header — which a screen
    // reader announces for every cell of the row — without the component.
    const unnamed: SourceLocation = {
      file: SOURCE_FILE,
      line: SOURCE_LINE,
      column: SOURCE_COLUMN,
      resolvedBy: 'code-graph',
      confidence: 0.9,
    };
    const stub = resolvingProvider([
      makeRenderStat({ component: LONG_COMPONENT, source: unnamed }),
    ]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(LONG_COMPONENT);
    expect(nameOf(row).getAttribute('aria-label')).toBe(nameChipName(LONG_COMPONENT, unnamed));
    expect(
      within(row).getByRole('rowheader', {
        name: (accessibleName) => accessibleName.includes(LONG_COMPONENT),
      }),
    ).toBe(within(row).getByRole('rowheader'));

    // The chip's own name carries the component, so no hidden copy escorts it:
    // a second one would make a screen reader announce the name twice. A
    // closed tooltip bubble is visually hidden too, so it is set aside by role.
    const escorts = [
      ...within(row)
        .getByRole('rowheader')
        .querySelectorAll('.dg-visually-hidden:not([role="tooltip"])'),
    ];
    expect(escorts).toHaveLength(0);
  });

  it('draws no chip for a component the capture could not resolve to a location', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);
    expect(within(row).queryByRole('button', { name: /^Open / })).toBeNull();
    expect(row.querySelector('.dg-source-link')).toBeNull();
    expect(row.textContent).not.toContain(SOURCE_FILE);
  });

  it('draws an unlinked name as text described by its full name, with no control', async () => {
    const stub = resolvingProvider([makeRenderStat({ component: LONG_COMPONENT })]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(LONG_COMPONENT);
    const name = nameOf(row);

    // Text, whole: no button, no link, and the disclosure toggle is the row
    // header's only control.
    expect(name.tagName).toBe('SPAN');
    expect(name.closest('button')).toBeNull();
    expect(name.textContent).toBe(LONG_COMPONENT);
    expect(within(row).getByRole('rowheader').querySelectorAll('button')).toHaveLength(1);
    expect(
      within(within(row).getByRole('rowheader')).getByRole('button').getAttribute('aria-label'),
    ).toBe(expandNameOf(LONG_COMPONENT));

    // Described by its full name, so an ellipsized name is still readable.
    const bubble = document.getElementById(name.getAttribute('aria-describedby') ?? '');
    expect(bubble?.getAttribute('role')).toBe('tooltip');
    expect(bubble?.textContent).toBe(LONG_COMPONENT);

    // Clicking a label opens nothing.
    await user.click(name);
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('selects an individual render as the one captured event it stands for', async () => {
    const occurrence = makeOccurrence({
      eventId: 'event-example-0007',
      spanId: spanIdFor(7),
      startTime: BASE_START_MS + 48,
      durationMs: 16,
      trigger: 'context',
    });
    const stat = makeRenderStat({
      renderCount: 1,
      totalDurationMs: 16,
      averageDurationMs: 16,
      maxDurationMs: 16,
      triggers: makeTriggers({ context: 1 }),
      phaseCounts: makePhases({ update: 1 }),
      occurrences: [occurrence],
      occurrencesTruncated: false,
    });
    const stub = resolvingProvider([stat]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const detail = onlyDetailRow();
    await user.click(
      within(detail).getByRole('button', { name: selectOccurrencePatternOf(WIDGET_COMPONENT) }),
    );

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);

    const [call] = spies.onSelectEvent.mock.calls;
    if (call === undefined) {
      throw new Error('the selection handler recorded no call');
    }

    const ref = call[0];

    // Every coordinate is that render's own, and there are exactly three of
    // them: nothing is synthesised, and nothing is dropped.
    expect(ref).toEqual({
      eventId: occurrence.eventId,
      spanId: occurrence.spanId,
      traceId: occurrence.traceId,
    });
    expect(Object.keys(ref).toSorted()).toEqual(['eventId', 'spanId', 'traceId']);

    // Selecting a render is not opening its declaration.
    expect(spies.onOpenSource).not.toHaveBeenCalled();
  });

  it('raises no selection for an aggregate row, which stands for many renders', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const row = rowFor(WIDGET_COMPONENT);

    // A row of counts has no single event id. Activating it must therefore do
    // nothing at all rather than nominate a representative render: a
    // fabricated coordinate opens a details drawer on evidence the reader did
    // not point at, which is worse than an absent one.
    await user.click(row);

    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();

    // And the row claims no selected state, because this view offers none.
    expect(row.getAttribute('aria-selected')).toBeNull();
  });
});

describe('RenderTable ordering', () => {
  it('renders rows in the order the provider returned them, without re-ranking', async () => {
    // The page is deliberately not in count order (4 renders, then 12) while
    // the node asks for `count_desc`: the service applied the ordering it was
    // given, so a component that re-ranked the page locally would show an
    // order no response ever reported — and would rank a page against a total
    // it is only part of.
    const stub = resolvingProvider(PROVIDER_ORDER);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);

    // Stated as a property too, so the intent survives a fixture change: the
    // rendered order is not the count ranking.
    const counts = PROVIDER_ORDER.map((stat) => stat.renderCount);
    expect(counts).not.toEqual(counts.toSorted((left, right) => right - left));
  });

  it('turns a header activation into a new query and follows the response', async () => {
    // Two pages: the node's own `count_desc` ordering, then whatever the
    // service returns for `duration_desc`. The second page is a different order
    // of the same rows, which is the only way to tell "the rows follow the new
    // response" from "the rows were re-ordered in the browser".
    const reordered: readonly RenderStat[] = [WIDGET_ROW, LIST_ROW];
    const stub = pagingProvider([{ data: PROVIDER_ORDER }, { data: reordered }]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
    expect(soleQuery(stub).sort).toBe(MOST_RENDERS_FIRST);

    // The grid reports the ordering that was applied, on the column that ranks
    // by it, and nothing on the column that does not.
    expect(ariaSortOf(RENDERS_SORT_NAME)).toBe('descending');
    expect(ariaSortOf(TOTAL_SORT_NAME)).toBe('none');

    await user.click(screen.getByRole('button', { name: TOTAL_SORT_NAME }));

    // A re-query, in the vocabulary the data layer understands.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const requeried = queryOfCall(stub, 2);
    expect(requeried.sort).toBe(LONGEST_TOTAL_FIRST);
    expect(requeried.source).toBe('renders');
    expect(requeried.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);

    // And the rows follow that response, in its order.
    const reorderedNames = reordered.map((stat) => stat.component);
    await waitFor(() => {
      expect(renderedNames()).toEqual(reorderedNames);
    });
    expect(ariaSortOf(TOTAL_SORT_NAME)).toBe('descending');
    expect(ariaSortOf(RENDERS_SORT_NAME)).toBe('none');
    expect(orderControl().value).toBe(LONGEST_TOTAL_FIRST);

    // The host is told, so it can remember the reader's choice; the report is a
    // selection and carries no query shape.
    expect(spies.onFilterChange).toHaveBeenCalledTimes(1);
    expect(spies.onFilterChange).toHaveBeenCalledWith(NODE_ID, { sort: LONGEST_TOTAL_FIRST });
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
  });

  it('does not re-query when the activated column is already the applied order', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const user = userEvent.setup();

    // The node already asks for `count_desc`, and the vocabulary offers one
    // direction per column, so a second activation has nothing to request —
    // and must not reverse into an order the data layer cannot express.
    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(screen.getByRole('button', { name: RENDERS_SORT_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(1);
    expect(ariaSortOf(RENDERS_SORT_NAME)).toBe('descending');
    expect(renderedNames()).toEqual([...PROVIDER_ORDER_NAMES]);
  });
});

describe('RenderTable focus across an order change', () => {
  /*
   * A new order is a new page sequence: the gesture releases every loaded row,
   * and the view has none to draw until the re-ordered first page arrives. The
   * control the reader used must survive that moment — the same element, still
   * in the document, still focused — or keyboard focus falls to the document
   * after every change. The stub below answers the first query at once and
   * holds every later one open until the case answers it by its order, so the
   * moment between the gesture and the answer is asserted on its own rather
   * than raced, and a case cannot pass by answering the wrong request.
   */

  /** The two outcomes of one request the stub is holding open. */
  interface HeldRequest {
    /** Answers the request. */
    readonly resolve: (response: DataQueryResponse) => void;

    /** Fails the request. */
    readonly reject: (error: DebuggenError) => void;
  }

  /** The stub, the queries it received and the handles that answer a held request. */
  interface HeldStub {
    /** The provider to hand to {@link renderComponent}. */
    readonly provider: DataProvider;

    /** Every query received, in call order. */
    readonly queries: readonly DataQuery[];

    /** Answers the request held open for `sort` with `page`. */
    readonly settle: (sort: DataQuerySort, page: RenderPage) => void;

    /** Fails the request held open for `sort` with `error`. */
    readonly fail: (sort: DataQuerySort, error: DebuggenError) => void;
  }

  /** The chronological member of the vocabulary: reachable from the toolbar, ranked by no column. */
  const EARLIEST_FIRST: DataQuerySort = 'start_asc';

  /** A third component, so three answers can each order the rows differently. */
  const CARD_COMPONENT = 'ExampleCard';

  const CARD_ROW = makeRenderStat({
    component: CARD_COMPONENT,
    renderCount: 2,
    totalDurationMs: 24,
    averageDurationMs: 12,
    maxDurationMs: 16,
    triggers: makeTriggers({ props: 1, unchanged: 1 }),
    phaseCounts: makePhases({ mount: 1, update: 1 }),
  });

  /** The first page, answering the node's own `count_desc`. */
  const OPENING_ROWS: readonly RenderStat[] = [LIST_ROW, WIDGET_ROW, CARD_ROW];

  /** The page the service answers a `duration_desc` request with. */
  const LONGEST_TOTAL_ROWS: readonly RenderStat[] = [WIDGET_ROW, CARD_ROW, LIST_ROW];

  /**
   * The reader's three changes from the toolbar, in turn, each with the page
   * the service answers it with. Every page orders the same rows differently
   * from the page before it, so rows that followed the answer cannot be
   * mistaken for rows left over from the order just left — and the last change
   * returns to the opening order with a different answer, so a restored
   * earlier page cannot pass for a re-query either.
   */
  const ORDER_CHANGES: readonly {
    readonly sort: DataQuerySort;
    readonly rows: readonly RenderStat[];
  }[] = [
    { sort: LONGEST_TOTAL_FIRST, rows: LONGEST_TOTAL_ROWS },
    { sort: EARLIEST_FIRST, rows: [CARD_ROW, LIST_ROW, WIDGET_ROW] },
    { sort: MOST_RENDERS_FIRST, rows: [WIDGET_ROW, LIST_ROW, CARD_ROW] },
  ];

  /**
   * The component names of a page, in its order.
   *
   * @param rows The page's rows.
   * @returns Their names.
   */
  function namesOf(rows: readonly RenderStat[]): string[] {
    return rows.map((stat) => stat.component);
  }

  /**
   * The response a page stands for, with its counters present only when set.
   *
   * @param page The page.
   * @returns The response.
   */
  function responseOf(page: RenderPage): DataQueryResponse {
    return {
      source: 'renders',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    };
  }

  /**
   * Builds the stub: the first query is answered with `opening`, every later
   * one is held open under its own order.
   *
   * @param opening The first page.
   * @returns The stub.
   */
  function heldProvider(opening: RenderPage): HeldStub {
    const queries: DataQuery[] = [];
    const held = new Map<DataQuerySort, HeldRequest>();

    const provider = createDataProvider((query) => {
      queries.push(query);

      if (queries.length === 1) {
        return Promise.resolve(responseOf(opening));
      }

      const sort = query.sort;

      if (sort === undefined) {
        return Promise.reject(new Error('the view sent a re-query that names no order'));
      }

      return new Promise<DataQueryResponse>((resolve, reject) => {
        held.set(sort, { resolve, reject });
      });
    });

    const take = (sort: DataQuerySort): HeldRequest => {
      const request = held.get(sort);

      if (request === undefined) {
        throw new Error(`no request ordered by "${sort}" is being held`);
      }

      held.delete(sort);

      return request;
    };

    return {
      provider,
      queries,
      settle: (sort, page) => {
        take(sort).resolve(responseOf(page));
      },
      fail: (sort, error) => {
        take(sort).reject(error);
      },
    };
  }

  /**
   * Asserts that `element` is still the element in the document with focus —
   * not a replacement for it, and not the document itself.
   *
   * @param element The control the reader operated.
   */
  function expectStillFocused(element: HTMLElement): void {
    expect(element.isConnected).toBe(true);
    expect(document.activeElement).toBe(element);
  }

  /**
   * Asserts the moment between an order gesture and its first page: the
   * silhouette beneath a header that is still mounted, no row of the order just
   * left, and no count line, because a first page in flight has nothing to
   * count.
   */
  function expectReloading(): void {
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.classList.contains('dg-render-table__loading')).toBe(true);

    expect(screen.getByRole('grid', { name: GRID_NAME })).toBeDefined();
    expect(screen.getAllByRole('columnheader')).toHaveLength(COLUMN_LABELS.length);
    expect(dataRows()).toHaveLength(0);
    for (const name of namesOf(OPENING_ROWS)) {
      expect(screen.queryByText(name)).toBeNull();
    }

    expect(screen.queryByText(/components loaded\.$|^Showing /)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  }

  it('keeps the order control focused, as the same element, through three changes and their reloads', async () => {
    const stub = heldProvider({ data: OPENING_ROWS });
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(renderedNames()).toEqual(namesOf(OPENING_ROWS));

    // The reader's control, captured once: every assertion below is about this
    // very element, never about whichever select happens to be on screen.
    const select = orderControl();
    act(() => {
      select.focus();
    });
    expectStillFocused(select);

    for (const [index, change] of ORDER_CHANGES.entries()) {
      await user.selectOptions(select, change.sort);

      // A re-query for the chosen order, from the first page.
      expect(stub.queries).toHaveLength(index + 2);
      expect(stub.queries.at(-1)).toEqual({
        source: 'renders',
        sort: change.sort,
        limit: DATA_QUERY_DEFAULT_LIMIT,
      });

      // While it is in flight, the reader is still on the control they used,
      // and it names the order that was requested.
      expect(orderControl()).toBe(select);
      expectStillFocused(select);
      expect(select.value).toBe(change.sort);
      expectReloading();

      stub.settle(change.sort, { data: change.rows });

      // The rows follow the answer, and the control is still the one in hand.
      await waitFor(() => {
        expect(renderedNames()).toEqual(namesOf(change.rows));
      });
      expect(orderControl()).toBe(select);
      expectStillFocused(select);
      expect(select.value).toBe(change.sort);
      expect(screen.queryByRole('status')).toBeNull();
      expect(
        screen.getByText(`${formatCount(change.rows.length)} components loaded.`),
      ).toBeDefined();
    }

    // Each change was one report to the host, in the order it was made.
    expect(spies.onFilterChange.mock.calls).toEqual(
      ORDER_CHANGES.map((change) => [NODE_ID, { sort: change.sort }]),
    );
  });

  it('keeps a sortable header focused, as the same element, while its order reloads', async () => {
    const stub = heldProvider({ data: OPENING_ROWS });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const header = screen.getByRole('button', { name: TOTAL_SORT_NAME });
    await user.click(header);

    expect(stub.queries.map((query) => query.sort)).toEqual([
      MOST_RENDERS_FIRST,
      LONGEST_TOTAL_FIRST,
    ]);

    // The header the reader activated is still the focused element, and the
    // grid reports the order that was requested while its rows are on the way.
    expect(screen.getByRole('button', { name: TOTAL_SORT_NAME })).toBe(header);
    expectStillFocused(header);
    expectReloading();
    expect(ariaSortOf(TOTAL_SORT_NAME)).toBe('descending');
    expect(ariaSortOf(RENDERS_SORT_NAME)).toBe('none');

    stub.settle(LONGEST_TOTAL_FIRST, { data: LONGEST_TOTAL_ROWS });

    await waitFor(() => {
      expect(renderedNames()).toEqual(namesOf(LONGEST_TOTAL_ROWS));
    });
    expect(screen.getByRole('button', { name: TOTAL_SORT_NAME })).toBe(header);
    expectStillFocused(header);
    expect(orderControl().value).toBe(LONGEST_TOTAL_FIRST);
  });

  it('keeps the controls, and focus, when the re-ordered first page fails, and retries that order', async () => {
    const stub = heldProvider({ data: OPENING_ROWS });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const select = orderControl();
    await user.selectOptions(select, LONGEST_TOTAL_FIRST);
    stub.fail(
      LONGEST_TOTAL_FIRST,
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );

    // The failure of the first page, with the query that failed, drawn beneath
    // the header — and no row of either order behind it.
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('dg-render-table__error')).toBe(true);
    expect(within(alert).getByText(/could not be loaded/i)).toBeDefined();
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'renders',
      sort: LONGEST_TOTAL_FIRST,
      limit: DATA_QUERY_DEFAULT_LIMIT,
    });
    expect(screen.getByRole('grid', { name: GRID_NAME })).toBeDefined();
    expect(dataRows()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();

    // The reader is still on the control they used, so another order is one
    // keystroke away rather than a search for the control.
    expect(orderControl()).toBe(select);
    expectStillFocused(select);

    // And the retry re-requests the order that failed.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.queries.map((query) => query.sort)).toEqual([
      MOST_RENDERS_FIRST,
      LONGEST_TOTAL_FIRST,
      LONGEST_TOTAL_FIRST,
    ]);
    expect(stub.queries.at(-1)).toEqual(stub.queries.at(-2));

    stub.settle(LONGEST_TOTAL_FIRST, { data: LONGEST_TOTAL_ROWS });

    await waitFor(() => {
      expect(renderedNames()).toEqual(namesOf(LONGEST_TOTAL_ROWS));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(orderControl()).toBe(select);
  });

  it('keeps the controls, and focus, when the re-ordered result comes back empty', async () => {
    const stub = heldProvider({ data: OPENING_ROWS });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const select = orderControl();
    await user.selectOptions(select, EARLIEST_FIRST);
    stub.settle(EARLIEST_FIRST, { data: [], total: 0 });

    // The node's own empty sentence, in its own box, beneath the header — the
    // same empty capture the block draws before any order is chosen: its title,
    // its decorative glyph, and the polite status, never the busy one.
    const message = await screen.findByText(EMPTY_MESSAGE);
    const box = message.closest('.dg-render-table__empty');
    expect(box).not.toBeNull();
    expect(box?.querySelector('.dg-empty-state__title')?.textContent).toBe(NOTHING_CAPTURED_TITLE);
    expect(box?.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('grid', { name: GRID_NAME })).toBeDefined();
    expect(dataRows()).toHaveLength(0);
    expect(screen.getByRole('status')).toBe(box);
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/components loaded\.$|^Showing /)).toBeNull();

    expect(orderControl()).toBe(select);
    expectStillFocused(select);
    expect(select.value).toBe(EARLIEST_FIRST);
  });

  it('keeps the controls, and offers the next page, when the re-ordered page is empty but names one', async () => {
    const stub = heldProvider({ data: OPENING_ROWS });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    const select = orderControl();
    await user.selectOptions(select, EARLIEST_FIRST);
    stub.settle(EARLIEST_FIRST, { data: [], total: 42, nextOffset: DATA_QUERY_DEFAULT_LIMIT });

    // The page is described as a page, and the paging line is exactly the one
    // an empty page that names a next page has before any order is chosen.
    const message = await screen.findByText(
      'This page of render statistics held no components. More of the result remains to be loaded.',
    );
    expect(message.closest('.dg-render-table__empty')).not.toBeNull();
    expect(screen.queryAllByText(EMPTY_MESSAGE)).toHaveLength(0);
    expect(
      screen.getByText(`Showing ${formatCount(0)} of ${formatCount(42)} components.`),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: LOAD_MORE_NAME })).toBeDefined();

    expect(orderControl()).toBe(select);
    expectStillFocused(select);
  });
});

describe('RenderTable paging', () => {
  it('says how much of the result is on screen and asks the provider for the next page', async () => {
    // The provider answers each call with the next page. "Load more" advances
    // the sequence to the provider's own `nextOffset` and appends the answer
    // beneath the page already on screen; it never grows one request.
    const stub = pagingProvider([
      { data: [WIDGET_ROW], total: 12, nextOffset: 1 },
      { data: [LIST_ROW], total: 12, nextOffset: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 1 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // One component of twelve, said plainly rather than implied by a bare count.
    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(12)} components.`);
    expect(dataRows()).toHaveLength(1);

    const first = soleQuery(stub);
    expect(first.limit).toBe(1);
    expect(first.offset).toBeUndefined();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The next page of the same query: same source, same ordering, same page
    // size, starting exactly where the provider said it starts.
    expect(stub.resolve).toHaveBeenCalledTimes(2);

    const second = queryOfCall(stub, 2);
    expect(second.limit).toBe(first.limit);
    expect(second.source).toBe('renders');
    expect(second.sort).toBe(MOST_RENDERS_FIRST);
    expect(second.offset).toBe(1);

    // And the reader keeps what they were reading, with the new row beneath it.
    await waitFor(() => {
      expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT]);
    });
    expect(
      screen.getByText(`Showing ${formatCount(2)} of ${formatCount(12)} components.`),
    ).toBeDefined();

    // The second page reported a further one, so the control is still offered.
    expect(screen.getByRole('button', { name: LOAD_MORE_NAME })).toBeDefined();
  });

  it('offers no paging control once the response reports no further page', async () => {
    const stub = resolvingProvider([WIDGET_ROW], { total: 1 });

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(1)} components.`);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('counts what it loaded rather than implying the page is the whole result', async () => {
    const stub = resolvingProvider([WIDGET_ROW]);

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    // A service that reported no total leaves this view unable to say how much
    // of the source it drew, and stating the count it has is the only truthful
    // option.
    const coverage = await screen.findByText(`${formatCount(1)} components loaded.`);
    expect(coverage.textContent).not.toMatch(/\bof\b/);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();
  });

  it('clamps a page beyond the published maximum, and keeps paging past it', async () => {
    const stub = resolvingProvider([WIDGET_ROW], {
      total: 9_000,
      nextOffset: DATA_QUERY_MAX_LIMIT,
    });
    const user = userEvent.setup();

    // A node whose `limit` exceeds the contract's ceiling: the service would
    // reject the query, so the request is bounded here instead. The ceiling
    // bounds one page, not the sequence: the provider reports a next page, so
    // the control is offered and follows it.
    renderComponent(
      makeNode({
        query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: DATA_QUERY_MAX_LIMIT + 1_000 },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });

    expect(soleQuery(stub).limit).toBe(DATA_QUERY_MAX_LIMIT);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2).offset).toBe(DATA_QUERY_MAX_LIMIT);
    expect(queryOfCall(stub, 2).limit).toBe(DATA_QUERY_MAX_LIMIT);

    // The stub repeats its page, so the second answer reports the offset it was
    // requested at: a `nextOffset` that does not advance ends the sequence, and
    // the repeated row is drawn once.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();
    });
    expect(renderedNames()).toEqual([WIDGET_COMPONENT]);
  });
});

describe('RenderTable page size', () => {
  /*
   * The page size every request carries: an omitted limit takes the published
   * default, an explicit zero stays zero — the schema's count-only request, never
   * raised to one row — and anything else is floored to whole rows and capped at
   * the per-request ceiling. The provider answers a zero-limit query with no
   * rows, as the contract requires, so every case settles on the state its
   * request produces.
   */

  /** One case: its description, the node's authored limit and the limit sent. */
  type PageSizeCase = readonly [description: string, authored: number | undefined, sent: number];

  const PAGE_SIZE_CASES: readonly PageSizeCase[] = [
    [
      'sends the published default when the node authored no limit',
      undefined,
      DATA_QUERY_DEFAULT_LIMIT,
    ],
    ['sends an explicit zero limit as zero rather than one row', 0, 0],
    ['floors a fractional limit to whole rows', 2.9, 2],
    ['caps a limit above the ceiling at the published maximum', 9_000, DATA_QUERY_MAX_LIMIT],
  ];

  it.each(PAGE_SIZE_CASES)('%s', async (_description, authored, sent) => {
    const stub = recordingProvider((query) =>
      Promise.resolve<DataQueryResponse>({
        source: 'renders',
        data: query.limit === 0 ? [] : [WIDGET_ROW],
        total: 1,
      }),
    );

    renderComponent(
      makeNode({
        query: {
          source: 'renders',
          sort: MOST_RENDERS_FIRST,
          ...(authored === undefined ? {} : { limit: authored }),
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await waitFor(() => {
      expect(screen.queryByRole('status', { busy: true })).toBeNull();
    });

    expect(soleQuery(stub).limit).toBe(sent);
  });

  it('never pages a count-only query, even when the provider echoes the offset it was asked at', async () => {
    // A zero-limit page holds no rows by request, and a service that computes
    // `nextOffset` as `offset + limit` answers with the offset it was given. A
    // control following it would re-request the same empty page forever.
    const stub = resolvingProvider([], { total: 42, nextOffset: DATA_QUERY_DEFAULT_OFFSET });

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 0 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // The count the query asked for, stated as a count — not as a capture that
    // observed no renders.
    await screen.findByText(
      `This view requests a count without rows: ${formatCount(42)} components matched its query.`,
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

    expect(soleQuery(stub).limit).toBe(0);
    expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('never pages a count-only query, even when the provider names a later offset', async () => {
    // Every page of a count-only sequence repeats the same count, so a forward
    // `nextOffset` still leads nowhere a zero-row request could show.
    const stub = resolvingProvider([], { total: 42, nextOffset: 10 });

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 0 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByText(
      `This view requests a count without rows: ${formatCount(42)} components matched its query.`,
    );

    expect(soleQuery(stub).limit).toBe(0);
    expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('RenderTable empty results', () => {
  /*
   * An empty page is not an empty capture. The "nothing was captured" sentence
   * is pinned to a result the provider counted as empty, or left uncounted at
   * position zero. A count-only query, a page at or past the end of a counted
   * result, an empty page below a positive total and a later page with no total
   * each get their own sentence, stating the total that is known. Figures go
   * through the package's own `formatCount`, so no digit grouping is restated.
   */

  /** The first line of a count-only state. */
  const COUNT_ONLY_TITLE = 'Count only';

  /** The first line of an empty page of a result that is not known to be empty. */
  const EMPTY_PAGE_TITLE = 'Nothing on this page';

  /** One empty answer: what the node asked for, what the provider reported, what is said. */
  interface EmptyCase {
    /** The case's name. */
    readonly description: string;

    /** The node's authored limit, when it authored one. */
    readonly limit?: number | undefined;

    /** The node's authored offset, when it authored one. */
    readonly offset?: number | undefined;

    /** The provider's reported total, when it reported one. */
    readonly total?: number | undefined;

    /** The provider's reported next offset, when it reported one. */
    readonly nextOffset?: number | undefined;

    /** The expected first line, or `undefined` when the sentence stands alone. */
    readonly title: string | undefined;

    /** The expected sentence. */
    readonly message: string;
  }

  const EMPTY_CASES: readonly EmptyCase[] = [
    {
      description: 'reports the total of a count-only query rather than an empty capture',
      limit: 0,
      total: 42,
      nextOffset: DATA_QUERY_DEFAULT_OFFSET,
      title: COUNT_ONLY_TITLE,
      message: `This view requests a count without rows: ${formatCount(42)} components matched its query.`,
    },
    {
      description: 'names a single matching component of a count-only query in the singular',
      limit: 0,
      total: 1,
      title: COUNT_ONLY_TITLE,
      message: `This view requests a count without rows: ${formatCount(1)} component matched its query.`,
    },
    {
      description: 'says a count-only query reported no total rather than inventing one',
      limit: 0,
      title: COUNT_ONLY_TITLE,
      message: 'This view requests a count without rows, and no total was reported for its query.',
    },
    {
      description: 'shows total 0 on page 1 as empty capture',
      total: 0,
      title: NOTHING_CAPTURED_TITLE,
      message: EMPTY_MESSAGE,
    },
    {
      description: 'shows total 0 on page 2 as empty capture',
      offset: 200,
      total: 0,
      title: NOTHING_CAPTURED_TITLE,
      message: EMPTY_MESSAGE,
    },
    {
      description: 'says a page past the end of a counted result starts beyond it',
      offset: 300,
      total: 120,
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(301)}, past the end of the ${formatCount(120)} components that matched this query.`,
    },
    {
      description: 'treats a page that starts exactly at the total as past the end',
      offset: 120,
      total: 120,
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(121)}, past the end of the ${formatCount(120)} components that matched this query.`,
    },
    {
      description: 'groups the digits of a large position and total',
      offset: 12_345,
      total: 10_000,
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(12_346)}, past the end of the ${formatCount(10_000)} components that matched this query.`,
    },
    {
      description: 'says components matched when the provider left a page empty below its total',
      total: 42,
      nextOffset: DATA_QUERY_DEFAULT_OFFSET,
      title: EMPTY_PAGE_TITLE,
      message: `${formatCount(42)} components matched this query, but none are shown on this page.`,
    },
    {
      description: 'describes only the page when a later page is empty and no total was reported',
      offset: 200,
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${formatCount(201)} and holds no components; no total was reported for this query.`,
    },
  ];

  it.each(EMPTY_CASES)('$description', async (emptyCase) => {
    const { limit, offset, total, nextOffset, title, message } = emptyCase;
    const stub = resolvingProvider([], { total, nextOffset });

    renderComponent(
      makeNode({
        query: {
          source: 'renders',
          sort: MOST_RENDERS_FIRST,
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // The sentence, in the empty box this component places, under the first
    // line the case expects — or none.
    const shown = await screen.findByText(message);
    expect(shown.classList.contains('dg-empty-state__message')).toBe(true);

    const box = shown.closest('.dg-render-table__empty');
    expect(box).not.toBeNull();
    expect(box?.querySelector('.dg-empty-state__title')?.textContent ?? undefined).toBe(title);

    // The empty-capture sentence appears only for the cases that are one, and
    // only that case carries the view's decorative glyph.
    expect(screen.queryAllByText(EMPTY_MESSAGE)).toHaveLength(message === EMPTY_MESSAGE ? 1 : 0);
    expect(box?.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden') ?? null).toBe(
      message === EMPTY_MESSAGE ? 'true' : null,
    );

    // Every settled empty state is the polite status, never the busy one.
    expect(screen.getByRole('status')).toBe(box);
    expect(screen.queryByRole('status', { busy: true })).toBeNull();

    // An answer, not a failure or a table, with nothing further to load: one
    // request, carrying the authored page exactly.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();

    const sent = soleQuery(stub);
    expect(sent.limit).toBe(limit ?? DATA_QUERY_DEFAULT_LIMIT);
    expect(sent.offset).toBe(offset);
  });
});

describe('RenderTable page sequence', () => {
  /*
   * An offset-aware stub, local to these cases: each request is answered by
   * the page defined at its own `offset` (and, for the ordering case, its own
   * `sort`), so a component that re-requested the prefix, grew a window or
   * derived an offset from what arrived would receive the wrong page and fail
   * visibly rather than by coincidence. A request may also be held open, so the
   * state between "Load more" and the next answer can be asserted, or rejected.
   */

  /** How the stub answers one request: a page, a request held open, or a failure. */
  type SequenceAnswer = RenderPage | 'pending' | DebuggenError;

  /** The stub, the queries it received and the handle that settles a held request. */
  interface SequenceStub {
    /** The provider to hand to {@link renderComponent}. */
    readonly provider: DataProvider;

    /** Every query received, in call order. */
    readonly queries: readonly DataQuery[];

    /**
     * Answers the request held open at `offset` with `page`. Synchronous: the
     * caller awaits the resulting render through `waitFor`.
     */
    readonly settle: (offset: number, page: RenderPage) => void;
  }

  /** The label the paging control carries while the next page is in flight. */
  const LOADING_MORE_NAME = 'Loading more…';

  /** Anything whose accessible name starts with "Load" — both paging labels. */
  const ANY_PAGING_CONTROL = /^Load/;

  /**
   * The position a query asks for, with the contract's default applied — the
   * same default the side resolving a query applies to one that carries none.
   *
   * @param query The received query.
   * @returns Its offset.
   */
  function offsetOf(query: DataQuery): number {
    return query.offset ?? DATA_QUERY_DEFAULT_OFFSET;
  }

  /**
   * The response a page stands for, with its counters present only when set.
   *
   * @param page The page.
   * @returns The response.
   */
  function responseFor(page: RenderPage): DataQueryResponse {
    return {
      source: 'renders',
      data: page.data,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    };
  }

  /**
   * Builds the offset-aware stub.
   *
   * @param answer Called with each query and its 1-based call number.
   * @returns The stub.
   */
  function sequenceProvider(
    answer: (query: DataQuery, call: number) => SequenceAnswer,
  ): SequenceStub {
    const queries: DataQuery[] = [];
    const held = new Map<number, (response: DataQueryResponse) => void>();

    const provider = createDataProvider((query) => {
      queries.push(query);

      const answered = answer(query, queries.length);

      if (answered === 'pending') {
        return new Promise<DataQueryResponse>((resolve) => {
          held.set(offsetOf(query), resolve);
        });
      }

      if (answered instanceof DebuggenError) {
        return Promise.reject(answered);
      }

      return Promise.resolve(responseFor(answered));
    });

    const settle = (offset: number, page: RenderPage): void => {
      const resolve = held.get(offset);

      if (resolve === undefined) {
        throw new Error(`no request at offset ${String(offset)} is being held`);
      }

      held.delete(offset);
      resolve(responseFor(page));
    };

    return { provider, queries, settle };
  }

  /**
   * The query received on the given 1-based call.
   *
   * @param stub The stub.
   * @param call The call number.
   * @returns That query.
   */
  function requestOf(stub: SequenceStub, call: number): DataQuery {
    const query = stub.queries[call - 1];

    if (query === undefined) {
      throw new Error(`the stub received no query for call ${String(call)}`);
    }

    return query;
  }

  /**
   * A quiet component: two renders, so a louder one stands out against it.
   *
   * @param component The component name.
   * @returns The row.
   */
  function quietRow(component: string): RenderStat {
    return makeRenderStat({
      component,
      renderCount: 2,
      totalDurationMs: 24,
      averageDurationMs: 12,
      maxDurationMs: 16,
      triggers: makeTriggers({ props: 1, unchanged: 1 }),
      phaseCounts: makePhases({ mount: 1, update: 1 }),
    });
  }

  const CARD_COMPONENT = 'ExampleCard';
  const PANEL_COMPONENT = 'ExamplePanel';
  const FORM_COMPONENT = 'ExampleForm';
  const CARD_ROW = quietRow(CARD_COMPONENT);
  const PANEL_ROW = quietRow(PANEL_COMPONENT);
  const FORM_ROW = quietRow(FORM_COMPONENT);

  it('requests the next page at the provider nextOffset with the same limit, and appends it once', async () => {
    const stub = sequenceProvider((query) =>
      offsetOf(query) === 0 ? { data: [LIST_ROW, WIDGET_ROW], total: 4, nextOffset: 2 } : 'pending',
    );
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByText(`Showing ${formatCount(2)} of ${formatCount(4)} components.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The same query, moved to exactly the offset the provider reported: the
    // same source, filter, order and page size — one new page, not a larger one.
    expect(stub.queries).toHaveLength(2);
    const first = requestOf(stub, 1);
    const second = requestOf(stub, 2);
    expect(second).toEqual({ ...first, offset: 2 });
    expect(second.limit).toBe(2);
    expect(first.limit).toBe(2);

    // While it is in flight, the loaded rows stay where the reader is reading,
    // under their total, with a busy control rather than the block's silhouette.
    expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT]);
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(
      screen.getByText(`Showing ${formatCount(2)} of ${formatCount(4)} components.`),
    ).toBeDefined();
    const busy = screen.getByRole('button', { name: LOADING_MORE_NAME });
    expect(busy instanceof HTMLButtonElement && busy.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: LOAD_MORE_NAME })).toBeNull();

    // The next page repeats a row the reader already has: it is drawn once, in
    // its original place, and the new row lands beneath the loaded ones.
    stub.settle(2, { data: [WIDGET_ROW, CARD_ROW], total: 4 });

    await waitFor(() => {
      expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT, CARD_COMPONENT]);
    });
    expect(
      screen.getByText(`Showing ${formatCount(3)} of ${formatCount(4)} components.`),
    ).toBeDefined();

    // No further page was reported, so none is offered — and nothing already
    // on screen was requested a second time.
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
    expect(stub.queries).toHaveLength(2);
  });

  it('keeps following the reported offsets past the 5 000-row page ceiling', async () => {
    const pagesAt = new Map<number, RenderPage>([
      [4_800, { data: [CARD_ROW], total: 6_000, nextOffset: 4_900 }],
      [4_900, { data: [PANEL_ROW], total: 6_000, nextOffset: 5_100 }],
      [5_100, { data: [FORM_ROW], total: 6_000 }],
    ]);
    const stub = sequenceProvider((query) => {
      const page = pagesAt.get(offsetOf(query));

      if (page === undefined) {
        throw new Error(`no page is defined at offset ${String(offsetOf(query))}`);
      }

      return page;
    });
    const user = userEvent.setup();

    renderComponent(
      makeNode({
        query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 100, offset: 4_800 },
      }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await waitFor(() => {
      expect(renderedNames()).toEqual([CARD_COMPONENT]);
    });

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([CARD_COMPONENT, PANEL_COMPONENT]);
    });

    // The provider skipped ahead; the view follows it rather than counting rows,
    // and a request beyond the ceiling is issued like any other.
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([CARD_COMPONENT, PANEL_COMPONENT, FORM_COMPONENT]);
    });

    expect(stub.queries.map((query) => query.offset)).toEqual([4_800, 4_900, 5_100]);
    expect(stub.queries.map((query) => query.limit)).toEqual([100, 100, 100]);
    expect(requestOf(stub, 3).offset ?? 0).toBeGreaterThan(DATA_QUERY_MAX_LIMIT);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
  });

  it('offers no paging control without a nextOffset, however large the total', async () => {
    // Fifty components reported and one delivered, but no next offset: the
    // provider did not say where more rows start, so none are requested.
    const stub = sequenceProvider(() => ({ data: [WIDGET_ROW], total: 50 }));

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByText(`Showing ${formatCount(1)} of ${formatCount(50)} components.`);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
    expect(stub.queries).toHaveLength(1);
  });

  it('treats a nextOffset that does not move past the current page as the end', async () => {
    // Following it would re-request the page on screen, and loop on it.
    const stub = sequenceProvider(() => ({ data: [WIDGET_ROW], total: 50, nextOffset: 3 }));

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, offset: 3 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(requestOf(stub, 1).offset).toBe(3);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
    expect(stub.queries).toHaveLength(1);
  });

  it('starts the sequence over from the first page when the order changes', async () => {
    const stub = sequenceProvider((query) => {
      const firstPage =
        query.sort === LONGEST_TOTAL_FIRST ? [WIDGET_ROW, LIST_ROW] : [LIST_ROW, WIDGET_ROW];

      return offsetOf(query) === 0
        ? { data: firstPage, total: 3, nextOffset: 2 }
        : { data: [CARD_ROW], total: 3 };
    });
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT, CARD_COMPONENT]);
    });

    // A header activation is a new ordering, so a new sequence: its first page,
    // with the node's own (absent) offset and the same page size.
    await user.click(screen.getByRole('button', { name: TOTAL_SORT_NAME }));

    expect(stub.queries).toHaveLength(3);
    expect(requestOf(stub, 3)).toEqual({ ...requestOf(stub, 1), sort: LONGEST_TOTAL_FIRST });

    // The rows loaded under the old order are released, not carried over.
    await waitFor(() => {
      expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT]);
    });

    // The new sequence pages on its own offsets.
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    expect(requestOf(stub, 4)).toEqual({
      ...requestOf(stub, 1),
      sort: LONGEST_TOTAL_FIRST,
      offset: 2,
    });
    await waitFor(() => {
      expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT, CARD_COMPONENT]);
    });

    // The toolbar is the other way to change the order, and it resets the same way.
    await user.selectOptions(orderControl(), MOST_RENDERS_FIRST);

    expect(requestOf(stub, 5)).toEqual(requestOf(stub, 1));
    await waitFor(() => {
      expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT]);
    });
  });

  it('keeps the loaded rows when the next page fails, and retries exactly that page', async () => {
    let nextPageAttempts = 0;
    const stub = sequenceProvider((query) => {
      if (offsetOf(query) === 0) {
        return { data: [LIST_ROW, WIDGET_ROW], total: 3, nextOffset: 2 };
      }

      nextPageAttempts += 1;

      return nextPageAttempts === 1
        ? new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.')
        : { data: [CARD_ROW], total: 3 };
    });
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    // The failure is reported beneath the rows, with the query that failed —
    // at the reported offset — and the rows already loaded are untouched. The
    // page scope of the shared contract says so in its title and lead, and the
    // provider's own cause follows the lead.
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(PAGE_FAILURE_TITLE)).toBeDefined();
    expect(alert.textContent).toContain(`${PAGE_FAILURE_LEAD} ${PROVIDER_FAILURE_MESSAGE}`);
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    expect(JSON.parse(shown.textContent ?? '')).toEqual({
      source: 'renders',
      sort: MOST_RENDERS_FIRST,
      limit: 2,
      offset: 2,
    });
    expect(screen.getByRole('grid', { name: GRID_NAME })).toBeDefined();
    expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT]);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();

    // The retry re-requests the page that failed, and its rows are appended.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.queries).toHaveLength(3);
    expect(requestOf(stub, 3)).toEqual(requestOf(stub, 2));
    await waitFor(() => {
      expect(renderedNames()).toEqual([LIST_COMPONENT, WIDGET_COMPONENT, CARD_COMPONENT]);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an open row open, and marks outliers over every loaded row, as pages append', async () => {
    const loud = makeRenderStat({ renderCount: 40, totalDurationMs: 1_600 });
    const stub = sequenceProvider((query) =>
      offsetOf(query) === 0
        ? { data: [loud, quietRow(LIST_COMPONENT)], total: 5, nextOffset: 2 }
        : { data: [CARD_ROW, PANEL_ROW, FORM_ROW], total: 5 },
    );
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByRole('grid', { name: GRID_NAME });

    // Two rows are no distribution, so nothing is marked yet.
    const figure = (): HTMLElement =>
      within(cellFor(rowFor(WIDGET_COMPONENT), 'Renders')).getByText(formatCount(40));
    expect(figure().classList.contains('dg-is-outlier')).toBe(false);

    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );
    expect(detailRows()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(dataRows()).toHaveLength(5);
    });

    // Five loaded rows with a median of two: the loud one now stands out, and
    // the row the reader opened is still open.
    expect(figure().classList.contains('dg-is-outlier')).toBe(true);
    expect(openedDescriptions(cellFor(rowFor(WIDGET_COMPONENT), 'Renders')).join(' ')).toMatch(
      /median of the loaded rows/i,
    );
    expectControlsDetail(toggleOf(WIDGET_COMPONENT), onlyDetailRow());
    expect(rowFor(WIDGET_COMPONENT).getAttribute('aria-expanded')).toBeNull();
  });

  it('offers the next page after a resolved page that held no rows but named one', async () => {
    const stub = sequenceProvider((query) =>
      offsetOf(query) === 0
        ? { data: [], total: 2, nextOffset: 2 }
        : { data: [WIDGET_ROW, LIST_ROW], total: 2 },
    );
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    // The empty page is reported as a page, never as a capture without renders,
    // and the offset it named stays reachable.
    await screen.findByText(`Showing ${formatCount(0)} of ${formatCount(2)} components.`);
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(stub.queries).toHaveLength(2);
    expect(requestOf(stub, 2)).toEqual({ ...requestOf(stub, 1), offset: 2 });
    expect(renderedNames()).toEqual([WIDGET_COMPONENT, LIST_COMPONENT]);
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
  });

  it('describes an empty followed page by the position it was requested at', async () => {
    // The first page is empty and names a next one; that page is empty too and
    // names none. The sequence holds no rows, yet the provider counted two, so
    // the page is described — at the offset it was followed to — and the
    // capture is never said to be empty.
    const stub = sequenceProvider((query) =>
      offsetOf(query) === 0 ? { data: [], total: 2, nextOffset: 2 } : { data: [], total: 2 },
    );
    const user = userEvent.setup();

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    await screen.findByText(`Showing ${formatCount(0)} of ${formatCount(2)} components.`);
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await screen.findByText(
      `This page starts at position ${formatCount(3)}, past the end of the ${formatCount(2)} components that matched this query.`,
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
    expect(screen.queryByRole('button', { name: ANY_PAGING_CONTROL })).toBeNull();
    expect(stub.queries).toHaveLength(2);
    expect(requestOf(stub, 2)).toEqual({ ...requestOf(stub, 1), offset: 2 });
  });

  it('starts over from the authored first page, painting none of the old rows, when the data provider is replaced', async () => {
    const earlier = sequenceProvider((query) =>
      offsetOf(query) === 0
        ? { data: [WIDGET_ROW, LIST_ROW], total: 4, nextOffset: 2 }
        : { data: [CARD_ROW, PANEL_ROW], total: 4 },
    );
    const later = sequenceProvider(() => 'pending');
    const { actions } = makeActions();
    const user = userEvent.setup();
    const node = makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } });

    // One node, one query, two providers: a host rebinding a mounted panel to
    // another session swaps the provider without remounting the node.
    const view = render(
      <DataProviderContext.Provider value={earlier.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <RenderTable node={node} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));
    await waitFor(() => {
      expect(dataRows()).toHaveLength(4);
    });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );
    expect(detailRows()).toHaveLength(1);

    view.rerender(
      <DataProviderContext.Provider value={later.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={actions}>
            <RenderTable node={node} />
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );

    // The new provider is asked for the authored first page — not the offset
    // the previous provider's pages reached — and while it loads nothing of the
    // previous provider's is on screen, open rows included.
    expect(later.queries).toHaveLength(1);
    expect(requestOf(later, 1)).toEqual(requestOf(earlier, 1));
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByText(WIDGET_COMPONENT)).toBeNull();

    act(() => {
      later.settle(DATA_QUERY_DEFAULT_OFFSET, { data: [PANEL_ROW], total: 1 });
    });

    await screen.findByRole('grid', { name: GRID_NAME });
    expect(renderedNames()).toEqual([PANEL_COMPONENT]);
    expect(detailRows()).toHaveLength(0);
    expect(earlier.queries).toHaveLength(2);
  });
});

describe('RenderTable accessible names', () => {
  /** Two individual renders of one component, 320 ms apart. */
  const NAMED_OCCURRENCES: readonly RenderOccurrence[] = [
    makeOccurrence({
      eventId: 'event-example-0031',
      spanId: spanIdFor(31),
      startTime: BASE_START_MS,
      durationMs: 12,
      trigger: 'props',
    }),
    makeOccurrence({
      eventId: 'event-example-0032',
      spanId: spanIdFor(32),
      startTime: BASE_START_MS + 320,
      durationMs: 24,
      trigger: 'unchanged',
    }),
  ];

  /** A row whose per-render list holds both of them. */
  const LISTED_ROW = makeRenderStat({
    renderCount: 2,
    totalDurationMs: 36,
    averageDurationMs: 18,
    maxDurationMs: 24,
    triggers: makeTriggers({ props: 1, unchanged: 1 }),
    phaseCounts: makePhases({ mount: 1, update: 1 }),
    occurrences: NAMED_OCCURRENCES,
    occurrencesTruncated: false,
  });

  it('names each disclosure toggle after the component of its own row', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // Each toggle is named from its row's data, so no two rows' toggles are
    // announced alike and none carries the bare generic stem.
    for (const component of PROVIDER_ORDER_NAMES) {
      const toggle = toggleOf(component);

      expect(toggle.getAttribute('aria-label')).toBe(expandNameOf(component));
      expect(within(rowFor(component)).getByRole('button', { name: expandNameOf(component) })).toBe(
        toggle,
      );
    }
    expect(
      screen.queryAllByRole('button', { name: /^(Show|Hide) individual renders$/ }),
    ).toHaveLength(0);

    // Opening one row renames its toggle, and only its toggle.
    await user.click(toggleOf(WIDGET_COMPONENT));

    expect(toggleOf(WIDGET_COMPONENT).getAttribute('aria-label')).toBe(
      collapseNameOf(WIDGET_COMPONENT),
    );
    expect(toggleOf(LIST_COMPONENT).getAttribute('aria-label')).toBe(expandNameOf(LIST_COMPONENT));
  });

  it('names each individual render by its component and by the offset it shows', async () => {
    const stub = resolvingProvider([LISTED_ROW]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(toggleOf(WIDGET_COMPONENT));

    const detail = onlyDetailRow();
    const buttons = within(detail).getAllByRole('button', {
      name: selectOccurrencePatternOf(WIDGET_COMPONENT),
    });

    expect(buttons).toHaveLength(NAMED_OCCURRENCES.length);

    for (const [index, occurrence] of NAMED_OCCURRENCES.entries()) {
      const offset = formatOffset(occurrence.startTime, LISTED_ROW.firstStartTime);
      const button = buttons[index];

      if (button === undefined) {
        throw new Error(`no select control was drawn for render ${String(index + 1)}`);
      }

      // The name contains exactly the text the control shows (label in name),
      // and the component the render belongs to.
      expect(button.textContent).toBe(offset);
      expect(button.getAttribute('aria-label')).toBe(
        selectOccurrenceNameOf(WIDGET_COMPONENT, offset),
      );
      expect(button.getAttribute('aria-label') ?? '').toContain(button.textContent);
    }
  });

  it('falls back to the generic names for a row whose component name is blank', async () => {
    const blankName = '   ';
    const blank = makeRenderStat({ ...LISTED_ROW, id: 'render-stat-blank', component: blankName });
    const stub = resolvingProvider([blank]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // No name ends in a dangling "of": the stem stands alone.
    expect(toggleOf(blankName).getAttribute('aria-label')).toBe('Show individual renders');

    await user.click(toggleOf(blankName));

    expect(toggleOf(blankName).getAttribute('aria-label')).toBe('Hide individual renders');

    const [first] = NAMED_OCCURRENCES;
    if (first === undefined) {
      throw new Error('the fixture lists no render');
    }
    const offset = formatOffset(first.startTime, blank.firstStartTime);

    expect(
      within(onlyDetailRow()).getAllByRole('button', { name: `Select render at ${offset}` }),
    ).toHaveLength(1);
  });

  it('gives the order control a name of its own, and announces the count politely as pages load', async () => {
    const stub = pagingProvider([
      { data: [WIDGET_ROW], total: 2, nextOffset: 1 },
      { data: [LIST_ROW], total: 2 },
    ]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // The toolbar's control says what it orders; the bare word two other
    // tables of a panel could share names nothing here.
    expect(orderControl().value).toBe(MOST_RENDERS_FIRST);
    expect(screen.queryByRole('combobox', { name: 'Order' })).toBeNull();

    // The count is a polite live region, read whole, and it is the same
    // element before and after a page is appended — so the change itself is
    // what an assistive technology announces.
    const count = screen.getByText(`Showing ${formatCount(1)} of ${formatCount(2)} components.`);
    expect(count.getAttribute('aria-live')).toBe('polite');
    expect(count.getAttribute('aria-atomic')).toBe('true');

    await user.click(screen.getByRole('button', { name: LOAD_MORE_NAME }));

    await waitFor(() => {
      expect(count.textContent).toBe(`Showing ${formatCount(2)} of ${formatCount(2)} components.`);
    });
    expect(count.isConnected).toBe(true);
  });

  it('announces the count of an empty page that still names a next one', async () => {
    const stub = resolvingProvider([], { total: 2, nextOffset: 2 });

    renderComponent(
      makeNode({ query: { source: 'renders', sort: MOST_RENDERS_FIRST, limit: 2 } }),
      { provider: stub.provider, actions: makeActions().actions },
    );

    const count = await screen.findByText(
      `Showing ${formatCount(0)} of ${formatCount(2)} components.`,
    );
    expect(count.getAttribute('aria-live')).toBe('polite');
    expect(count.getAttribute('aria-atomic')).toBe('true');
  });
});

describe('RenderTable keyboard model', () => {
  /**
   * How long a case waits for a hovered description to be shown: comfortably
   * past `Tooltip`'s hover dwell, so a busy host does not turn the dwell into a
   * flake.
   */
  const HOVER_OPEN_WAIT_MS = 2_000;

  /** The six columns whose header carries a definition, in display order. */
  const DESCRIBED_COLUMNS: readonly ColumnLabel[] = [
    'Triggers',
    STABLE_INPUTS_COLUMN,
    UNCLASSIFIED_COLUMN,
    'Changed props',
    'Changed contexts',
    'Phases',
  ];

  /**
   * Everything a grid descendant can be focused as, whatever its Tab index —
   * the same selector `../primitives/DataTable` walks with its arrow keys.
   */
  const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

  /** The line the individual render below was declared at, distinct from the row's own. */
  const OCCURRENCE_LINE = SOURCE_LINE + 3;

  /** Where the individual render below was declared. */
  const OCCURRENCE_SOURCE: SourceLocation = { ...WIDGET_SOURCE, line: OCCURRENCE_LINE };

  /** The accessible name of that render's compact source chip. */
  const OCCURRENCE_CHIP_NAME = `Open ${SOURCE_FILE}:${String(OCCURRENCE_LINE)}:${String(SOURCE_COLUMN)}`;

  /**
   * A loud component carrying every kind of control this view renders: a
   * source chip beside its name, a count far above the median (so its figure
   * is marked and explained), and one individual render with its own trigger
   * description and source chip.
   */
  const LOUD_WIDGET = makeRenderStat({
    renderCount: 40,
    totalDurationMs: 1_600,
    source: WIDGET_SOURCE,
    occurrences: [
      makeOccurrence({
        eventId: 'event-example-0021',
        spanId: spanIdFor(21),
        startTime: BASE_START_MS + 96,
        durationMs: 8,
        trigger: 'context',
        source: OCCURRENCE_SOURCE,
      }),
    ],
    occurrencesTruncated: true,
  });

  /** A second loud component, so a case can move between two marked rows. */
  const LOUD_LIST = makeRenderStat({
    component: LIST_COMPONENT,
    renderCount: 50,
    totalDurationMs: 2_000,
  });

  /** The component of the first quiet row, which follows the two loud ones. */
  const FIRST_QUIET_COMPONENT = 'ExampleCard';

  /** Three quiet components: the median of two the loud rows stand out from. */
  const QUIET_ROWS: readonly RenderStat[] = [
    FIRST_QUIET_COMPONENT,
    'ExamplePanel',
    'ExampleForm',
  ].map((component) =>
    makeRenderStat({
      component,
      renderCount: 2,
      totalDurationMs: 24,
      averageDurationMs: 12,
      maxDurationMs: 16,
      triggers: makeTriggers({ props: 1, unchanged: 1 }),
      phaseCounts: makePhases({ mount: 1, update: 1 }),
    }),
  );

  /** The page the keyboard cases draw, in provider order. */
  const KEYBOARD_ROWS: readonly RenderStat[] = [LOUD_WIDGET, LOUD_LIST, ...QUIET_ROWS];

  /**
   * The tooltip trigger inside an element: the one element `Tooltip` wraps in
   * its trigger slot, which exists whether the bubble is open or not.
   *
   * @param container Where to look.
   * @returns The trigger.
   */
  function triggerIn(container: HTMLElement): HTMLElement {
    const triggers = [...container.querySelectorAll<HTMLElement>('.dg-tooltip__trigger > *')];

    expect(triggers).toHaveLength(1);

    const [trigger] = triggers;

    if (trigger === undefined) {
      throw new Error('no tooltip trigger was found');
    }

    return trigger;
  }

  /**
   * The one bubble a trigger is described by, resolved through its
   * `aria-describedby` exactly as an assistive technology resolves it.
   * `Tooltip` keeps that bubble mounted whether or not it is shown, so it
   * resolves for a closed trigger as well as for an open one.
   *
   * @param trigger The trigger.
   * @returns The bubble.
   */
  function bubbleOf(trigger: HTMLElement): HTMLElement {
    const bubbles = describingBubbles(trigger);
    const [bubble] = bubbles;

    if (bubble === undefined || bubbles.length !== 1) {
      throw new Error(`expected one describing bubble, found ${String(bubbles.length)}`);
    }

    return bubble;
  }

  /**
   * Whether a trigger's description is being shown: its one bubble — mounted
   * either way — is in the shown state {@link isShownBubble} reads. A closed
   * trigger is still described by its bubble; none is shown.
   *
   * @param trigger The trigger.
   * @returns `true` while the bubble is open.
   */
  function isOpen(trigger: HTMLElement): boolean {
    return isShownBubble(bubbleOf(trigger));
  }

  /**
   * Every focusable element inside a container, in document order.
   *
   * @param container Where to look.
   * @returns The elements matching {@link FOCUSABLE_SELECTOR}.
   */
  function focusablesIn(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
  }

  /**
   * Whether the Tab key can land on an element: not disabled, and either
   * natively focusable with no `tabindex` or carrying a non-negative one. Read
   * off the attribute, which is what the component writes.
   *
   * @param element A focusable element.
   * @returns `true` when the element is in the Tab order.
   */
  function isTabStop(element: HTMLElement): boolean {
    if (element.hasAttribute('disabled')) {
      return false;
    }

    const tabIndex = element.getAttribute('tabindex');

    return tabIndex === null || Number.parseInt(tabIndex, 10) >= 0;
  }

  /**
   * The grid's Tab stops, in document order.
   *
   * @param grid The grid.
   * @returns Every element inside it the Tab key can land on.
   */
  function tabStopsIn(grid: HTMLElement): HTMLElement[] {
    return focusablesIn(grid).filter(isTabStop);
  }

  /**
   * The count figure of one row, under the `Renders` column.
   *
   * @param component The row's component name.
   * @param count The count the row reports.
   * @returns The figure element.
   */
  function figureOf(component: string, count: number): HTMLElement {
    return within(cellFor(rowFor(component), 'Renders')).getByText(formatCount(count));
  }

  /**
   * The trigger chip of the one individual render an open detail row lists.
   *
   * @param detail The open detail row.
   * @returns That chip.
   */
  function occurrenceTriggerChip(detail: HTMLElement): HTMLElement {
    const chip = detail.querySelector<HTMLElement>('[data-trigger]');

    if (chip === null) {
      throw new Error('the open detail row lists no trigger chip');
    }

    return chip;
  }

  it('keeps the grid one Tab stop: Tab enters on the active row, walks that row alone and leaves', async () => {
    const stub = resolvingProvider(KEYBOARD_ROWS, {
      total: KEYBOARD_ROWS.length + 4,
      nextOffset: KEYBOARD_ROWS.length,
    });
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });
    const loadMore = screen.getByRole('button', { name: LOAD_MORE_NAME });

    // Every row's toggle, the source chip, both marked figures, the two sort
    // buttons and the five header definitions are all focusable — and the
    // only element in the Tab order is the active row, the first one.
    const rowsInGrid = dataRows();
    const controls = focusablesIn(grid).filter((element) => !rowsInGrid.includes(element));
    expect(controls.length).toBeGreaterThanOrEqual(
      KEYBOARD_ROWS.length + 1 + 2 + 2 + DESCRIBED_COLUMNS.length,
    );
    for (const control of controls) {
      expect(control.getAttribute('tabindex')).toBe('-1');
    }
    expect(tabStopsIn(grid)).toEqual([rowFor(WIDGET_COMPONENT)]);
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    // Tab from the control before the grid lands on the active row; further
    // Tabs walk THAT row's controls in document order - its toggle, its name
    // chip and its marked figure, whose explanation opens as focus lands - and
    // the Tab after the last one leaves the grid for the control after it,
    // past every other row's controls.
    act(() => {
      orderControl().focus();
    });
    await user.tab();
    expect(document.activeElement).toBe(rowFor(WIDGET_COMPONENT));
    const activeRow = rowFor(WIDGET_COMPONENT);
    const figure = figureOf(WIDGET_COMPONENT, 40);
    for (const control of [
      toggleOf(WIDGET_COMPONENT),
      within(activeRow).getByRole('button', { name: nameChipName(WIDGET_COMPONENT) }),
      figure,
    ]) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }
    expect(isOpen(figure)).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(loadMore);

    // Shift+Tab walks back the same way: onto the row, then out before it.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rowFor(WIDGET_COMPONENT));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(orderControl());

    // The stop roves: after ArrowDown the next row is the one Tab enters on.
    act(() => {
      rowFor(WIDGET_COMPONENT).focus();
    });
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowFor(LIST_COMPONENT));
    expect(tabStopsIn(grid)).toEqual([rowFor(LIST_COMPONENT)]);
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    // An open detail row adds its select button, its trigger chip and its
    // source chip — each focusable, none a Tab stop.
    await user.click(toggleOf(WIDGET_COMPONENT));
    const detailControls = focusablesIn(onlyDetailRow());
    expect(detailControls).toHaveLength(3);
    for (const control of detailControls) {
      expect(control.getAttribute('tabindex')).toBe('-1');
    }
    expect(tabStopsIn(grid)).toEqual([rowFor(WIDGET_COMPONENT)]);

    act(() => {
      loadMore.focus();
    });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rowFor(WIDGET_COMPONENT));
  });

  it('opens a collapsed row with ArrowRight, then walks its controls and its open detail', async () => {
    const stub = resolvingProvider(KEYBOARD_ROWS);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    act(() => {
      rowFor(WIDGET_COMPONENT).focus();
    });

    // The first ArrowRight opens the collapsed row, reports it to the host
    // exactly as the toggle would, and leaves focus on the row.
    await user.keyboard('{ArrowRight}');
    expect(spies.onExpand).toHaveBeenCalledTimes(1);
    expect(spies.onExpand).toHaveBeenCalledWith(NODE_ID, LOUD_WIDGET.id, true);
    const detail = onlyDetailRow();
    expectControlsDetail(toggleOf(WIDGET_COMPONENT), detail);
    expect(document.activeElement).toBe(rowFor(WIDGET_COMPONENT));

    // Each further ArrowRight moves to the next control, in document order,
    // across the row and on into its open detail.
    const row = rowFor(WIDGET_COMPONENT);
    const figure = figureOf(WIDGET_COMPONENT, 40);
    const chip = occurrenceTriggerChip(detail);
    const expected: readonly HTMLElement[] = [
      toggleOf(WIDGET_COMPONENT),
      within(row).getByRole('button', { name: nameChipName(WIDGET_COMPONENT) }),
      figure,
      within(detail).getByRole('button', { name: selectOccurrencePatternOf(WIDGET_COMPONENT) }),
      chip,
      within(detail).getByRole('button', { name: OCCURRENCE_CHIP_NAME }),
    ];

    for (const control of expected) {
      await user.keyboard('{ArrowRight}');
      expect(document.activeElement).toBe(control);

      // A description opens the moment an arrow key lands on its trigger.
      if (control === figure || control === chip) {
        expect(isOpen(control)).toBe(true);
      }
    }

    const [first] = expected;
    const last = expected.at(-1);

    // The last control holds; Home and End jump to either end of the scope;
    // ArrowLeft from the first control goes back to the row.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(last);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(last);
    await user.keyboard('{Home}{ArrowLeft}');
    expect(document.activeElement).toBe(rowFor(WIDGET_COMPONENT));

    // ArrowLeft on the open row closes it, reported as the state it produced.
    await user.keyboard('{ArrowLeft}');
    expect(detailRows()).toHaveLength(0);
    expect(spies.onExpand).toHaveBeenLastCalledWith(NODE_ID, LOUD_WIDGET.id, false);
    expect(toggleOf(WIDGET_COMPONENT).getAttribute('aria-expanded')).toBe('false');
  });

  it('reaches every header definition from the first row, and nests none in a sort button', async () => {
    const stub = resolvingProvider(PROVIDER_ORDER);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });

    // No header control holds a tooltip, so each sort button is named by its
    // header text alone and no description hides behind a button's focus.
    for (const header of screen.getAllByRole('columnheader')) {
      for (const button of within(header).queryAllByRole('button')) {
        expect(button.querySelector('[role="tooltip"]')).toBeNull();
        expect(button.querySelector('[aria-describedby]')).toBeNull();
      }
    }
    const rendersSort = screen.getByRole('button', { name: RENDERS_SORT_NAME });
    const totalSort = screen.getByRole('button', { name: TOTAL_SORT_NAME });

    const triggers = DESCRIBED_COLUMNS.map((label) => {
      const trigger = triggerIn(headerFor(label));

      // The header text itself is the trigger: focusable, out of the Tab
      // order while the grid has rows, like the grid's own sort buttons.
      expect(trigger.textContent).toBe(label);
      expect(trigger.getAttribute('tabindex')).toBe('-1');
      expect(trigger.closest('button')).toBeNull();
      expect(isOpen(trigger)).toBe(false);

      return trigger;
    });
    expect(rendersSort.getAttribute('tabindex')).toBe('-1');
    expect(totalSort.getAttribute('tabindex')).toBe('-1');

    // ArrowUp from the first row reaches the header's first control; from
    // there ArrowRight walks the sort buttons and then the six definitions in
    // display order, each opening as focus arrives and closing as it leaves.
    // What each open bubble says is kept, because that is what the reader heard.
    const [firstRow] = dataRows();
    if (firstRow === undefined) {
      throw new Error('the grid rendered no data row');
    }
    act(() => {
      firstRow.focus();
    });

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rendersSort);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(totalSort);

    let previous: HTMLElement | undefined;
    const heard = new Map<ColumnLabel, string>();

    for (const [index, trigger] of triggers.entries()) {
      await user.keyboard('{ArrowRight}');

      expect(document.activeElement).toBe(trigger);
      expect(isOpen(trigger)).toBe(true);

      const label = DESCRIBED_COLUMNS[index];

      if (label !== undefined) {
        heard.set(label, bubbleOf(trigger).textContent ?? '');
      }

      if (previous !== undefined) {
        expect(isOpen(previous)).toBe(false);
      }

      previous = trigger;
    }

    // ArrowDown returns to the row the reader came from.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(firstRow);

    // The two definitions that must never be read as one stay distinct.
    expect(heard.get(STABLE_INPUTS_COLUMN)).toMatch(/evaluated and none of them had changed/i);
    expect(heard.get(UNCLASSIFIED_COLUMN)).toMatch(/could not be evaluated/i);
  });

  it('moves the roving stop to the row of a control a pointer focuses, and answers the keys there', async () => {
    const stub = resolvingProvider(KEYBOARD_ROWS);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });

    // A marked figure is described and focusable, never a Tab stop; an
    // unmarked one takes no focus at all.
    const figure = figureOf(LIST_COMPONENT, 50);
    expect(figure.getAttribute('tabindex')).toBe('-1');
    expect(bubbleOf(figure).textContent ?? '').toMatch(/median of the loaded rows/i);
    expect(figureOf(FIRST_QUIET_COMPONENT, 2).getAttribute('tabindex')).toBeNull();

    // A linked component's name is the chip that opens its declaration, on the
    // same terms: focusable but never a Tab stop, and described by its own
    // tooltip, which leads with the name.
    const name = nameOf(rowFor(WIDGET_COMPONENT));
    expect(name.getAttribute('tabindex')).toBe('-1');
    expect(bubbleOf(name).textContent ?? '').toContain(WIDGET_COMPONENT);

    // A click focuses the figure, opens its explanation and moves the grid's
    // one Tab stop to the figure's row.
    await user.click(figure);
    expect(document.activeElement).toBe(figure);
    expect(isOpen(figure)).toBe(true);
    expect(tabStopsIn(grid)).toEqual([rowFor(LIST_COMPONENT)]);

    // The first Escape closes the description and keeps focus; the second
    // returns to the row.
    await user.keyboard('{Escape}');
    expect(isOpen(figure)).toBe(false);
    expect(document.activeElement).toBe(figure);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowFor(LIST_COMPONENT));

    // A vertical key on a control moves to the adjacent row, counted from the
    // control's own row.
    await user.click(figure);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowFor(FIRST_QUIET_COMPONENT));
    expect(tabStopsIn(grid)).toEqual([rowFor(FIRST_QUIET_COMPONENT)]);
  });

  it('shows the explanation of a marked figure while a pointer rests on it, and none at rest', async () => {
    const stub = resolvingProvider(KEYBOARD_ROWS);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    const grid = await screen.findByRole('grid', { name: GRID_NAME });

    // At rest no description is shown anywhere in the grid: every bubble is
    // mounted but hidden, so a role query finds none.
    expect(within(grid).queryAllByRole('tooltip')).toHaveLength(0);

    // No figure is a Tab stop — the grid is one — yet each is still described:
    // a pointer resting on it shows the explanation its description resolves
    // to, and leaving hides it again.
    for (const [component, count] of [
      [WIDGET_COMPONENT, 40],
      [LIST_COMPONENT, 50],
    ] as const) {
      const figure = figureOf(component, count);
      expect(figure.getAttribute('tabindex')).toBe('-1');
      expect(isOpen(figure)).toBe(false);

      await user.hover(figure);
      await waitFor(
        () => {
          expect(isOpen(figureOf(component, count))).toBe(true);
        },
        { timeout: HOVER_OPEN_WAIT_MS },
      );
      expect(bubbleOf(figureOf(component, count)).textContent ?? '').toMatch(
        /median of the loaded rows/i,
      );
      expect(within(grid).getAllByRole('tooltip')).toEqual([bubbleOf(figureOf(component, count))]);

      await user.unhover(figureOf(component, count));
      expect(isOpen(figureOf(component, count))).toBe(false);
      expect(within(grid).queryAllByRole('tooltip')).toHaveLength(0);
    }

    // A pointer moves no focus: the grid's one Tab stop is still its first row.
    expect(tabStopsIn(grid)).toEqual([rowFor(WIDGET_COMPONENT)]);
  });

  it('opens the trigger description of an individual render when an arrow key reaches it', async () => {
    const occurrence = makeOccurrence({
      eventId: 'event-example-0011',
      spanId: spanIdFor(11),
      startTime: BASE_START_MS + 64,
      durationMs: 8,
      trigger: 'context',
    });
    const stat = makeRenderStat({
      renderCount: 1,
      totalDurationMs: 8,
      averageDurationMs: 8,
      maxDurationMs: 8,
      triggers: makeTriggers({ context: 1 }),
      phaseCounts: makePhases({ update: 1 }),
      occurrences: [occurrence],
      occurrencesTruncated: false,
    });
    const stub = resolvingProvider([stat]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );

    const chip = triggerIn(onlyDetailRow());
    expect(chip.getAttribute('data-trigger')).toBe('context');
    // Focusable, never a Tab stop, and described while closed: the bubble is
    // mounted and hidden, so its description resolves though none is shown.
    expect(chip.getAttribute('tabindex')).toBe('-1');
    expect(bubbleOf(chip).textContent).toBe(formatRenderTriggerLabel('context'));
    expect(isOpen(chip)).toBe(false);

    // Focus is on the disclosure control the reader just used; ArrowRight
    // moves on through the row — first the unlinked name, whose full text
    // opens — and then through the open row: its select control, then the
    // chip, whose description opens as focus lands.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(nameOf(rowFor(WIDGET_COMPONENT)));
    expect(isOpen(nameOf(rowFor(WIDGET_COMPONENT)))).toBe(true);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(
      within(onlyDetailRow()).getByRole('button', {
        name: selectOccurrencePatternOf(WIDGET_COMPONENT),
      }),
    );
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(chip);
    expect(isOpen(chip)).toBe(true);
    expect(bubbleOf(chip).textContent).toBe(formatRenderTriggerLabel('context'));

    // Escape closes the description first, then returns to the row.
    await user.keyboard('{Escape}');
    expect(isOpen(chip)).toBe(false);
    expect(document.activeElement).toBe(chip);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowFor(WIDGET_COMPONENT));
  });
});

describe('RenderTable shared selection', () => {
  /** The earlier of the two renders the cases below expand to. */
  const FIRST_RENDER = makeOccurrence({
    eventId: 'event-example-0021',
    spanId: spanIdFor(21),
    startTime: BASE_START_MS,
    durationMs: 8,
  });

  /** The later one. */
  const SECOND_RENDER = makeOccurrence({
    eventId: 'event-example-0022',
    spanId: spanIdFor(22),
    startTime: BASE_START_MS + 32,
    durationMs: 12,
  });

  /** A component row whose per-render list holds both. */
  const TWO_RENDERS_ROW = makeRenderStat({
    renderCount: 2,
    totalDurationMs: 20,
    averageDurationMs: 10,
    maxDurationMs: 12,
    triggers: makeTriggers({ props: 2 }),
    phaseCounts: makePhases({ update: 2 }),
    occurrences: [FIRST_RENDER, SECOND_RENDER],
    occurrencesTruncated: false,
  });

  /** The caption of the evidence chip the host case cites the second render with. */
  const CHIP_LABEL = 'the later render';

  /**
   * The line of each individual render in the open row, in display order, with
   * its select control — found by the name every such control carries, which
   * names the row's component and ends with the offset it shows.
   *
   * @returns One entry per render.
   */
  function renderLines(): { readonly line: HTMLElement; readonly control: HTMLElement }[] {
    return within(onlyDetailRow())
      .getAllByRole('button', { name: selectOccurrencePatternOf(WIDGET_COMPONENT) })
      .map((control) => {
        const line = control.closest<HTMLElement>('.dg-render-table__occurrence');

        if (line === null) {
          throw new Error('a select control sits outside any render line');
        }

        return { line, control };
      });
  }

  /**
   * The select control of one render line.
   *
   * @param index The line's position in display order.
   * @returns That line's control.
   */
  function controlAt(index: number): HTMLElement {
    const entry = renderLines()[index];

    if (entry === undefined) {
      throw new Error(`no render line at position ${String(index)}`);
    }

    return entry.control;
  }

  /**
   * Which renders are drawn as the selected event, one flag per line, each
   * asserted to agree with its control's `aria-pressed`.
   *
   * @returns One flag per render line, in display order.
   */
  function selectedFlags(): boolean[] {
    return renderLines().map(({ line, control }) => {
      const selected = line.classList.contains('dg-is-selected');

      expect(control.getAttribute('aria-pressed')).toBe(String(selected));

      return selected;
    });
  }

  /**
   * Expands the one component row and waits for its per-render list.
   *
   * @param user The user-event session.
   */
  async function expandWidgetRow(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await screen.findByRole('grid', { name: GRID_NAME });
    await user.click(
      within(rowFor(WIDGET_COMPONENT)).getByRole('button', {
        name: expandNameOf(WIDGET_COMPONENT),
      }),
    );
  }

  it('marks the render a reader selects, and only that one, when no host is mounted', async () => {
    const stub = resolvingProvider([TWO_RENDERS_ROW]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });
    await expandWidgetRow(user);

    // Nothing is selected yet, and every control says so.
    expect(selectedFlags()).toEqual([false, false]);

    await user.click(controlAt(1));

    // The standalone fallback keeps the view's own last selection, so the
    // render stays marked by class and by `aria-pressed` alike.
    expect(selectedFlags()).toEqual([false, true]);
    expect(spies.onSelectEvent.mock.calls).toEqual([
      [
        {
          eventId: SECOND_RENDER.eventId,
          spanId: SECOND_RENDER.spanId,
          traceId: SECOND_RENDER.traceId,
        },
      ],
    ]);

    // A second selection moves the one mark rather than adding another.
    await user.click(controlAt(0));

    expect(selectedFlags()).toEqual([true, false]);
  });

  it('follows the panel selection a host provides, and keeps no selection of its own', async () => {
    const stub = resolvingProvider([TWO_RENDERS_ROW]);
    const spies = makeActions();
    const user = userEvent.setup();

    /**
     * The view, under a host whose shared selection is `selection`.
     *
     * @param selection The panel's current selection.
     * @returns The element tree.
     */
    const tree = (selection: PanelSelection | undefined) => (
      <DataProviderContext.Provider value={stub.provider}>
        <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
          <PanelActionsContext.Provider value={spies.actions}>
            <PanelSelectionContext.Provider value={{ selection }}>
              <RenderTable node={makeNode()} />
            </PanelSelectionContext.Provider>
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
    );

    // Selected by id alone, as a host surface driving the selection from its
    // details drawer names it.
    const { rerender } = render(tree({ eventId: SECOND_RENDER.eventId }));
    await expandWidgetRow(user);

    expect(selectedFlags()).toEqual([false, true]);

    // Selected by trace and span, as a view that drew the same span under
    // another record's id reports it: still the same render.
    rerender(
      tree({ eventId: 'event-example-other', traceId: TRACE_ID, spanId: FIRST_RENDER.spanId }),
    );

    expect(selectedFlags()).toEqual([true, false]);

    // Under a host the view reports and the host records: activating a render
    // raises the report, and the mark stays with what the host provides.
    await user.click(controlAt(1));

    expect(spies.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(selectedFlags()).toEqual([true, false]);

    // Another view's selection, or none, leaves no render marked.
    rerender(tree({ eventId: 'event-example-elsewhere' }));
    expect(selectedFlags()).toEqual([false, false]);

    rerender(tree(undefined));
    expect(selectedFlags()).toEqual([false, false]);
  });

  it('shares one selection with the summary chips when mounted by the panel host', async () => {
    const stub = resolvingProvider([TWO_RENDERS_ROW]);
    const spies = makeActions();
    const user = userEvent.setup();

    const spec: PanelSpec = {
      version: PANEL_SPEC_VERSION,
      id: 'panel-example-0001',
      sessionId: PANEL_SESSION_ID,
      panelVersion: 1,
      title: 'Example panel',
      summary: {
        observed: [
          {
            statement: 'One component rendered twice.',
            evidence: [{ eventId: SECOND_RENDER.eventId, label: CHIP_LABEL }],
          },
        ],
        likelyCauses: [],
      },
      layout: [makeNode()],
    };

    render(<PanelHost spec={spec} dataProvider={stub.provider} actions={spies.actions} />);
    await expandWidgetRow(user);

    const chip = screen.getByRole('button', { name: CHIP_LABEL });

    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(selectedFlags()).toEqual([false, false]);

    // An evidence chip selects the event it cites, and the render that is that
    // event is marked in the table beneath.
    await user.click(chip);

    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.classList.contains('dg-is-selected')).toBe(true);
    expect(selectedFlags()).toEqual([false, true]);

    // A render selected in the table moves the one selection: the chip that
    // cites another event is released.
    await user.click(controlAt(0));

    expect(selectedFlags()).toEqual([true, false]);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.classList.contains('dg-is-selected')).toBe(false);
    expect(spies.onSelectEvent.mock.calls.map(([ref]) => ref.eventId)).toEqual([
      SECOND_RENDER.eventId,
      FIRST_RENDER.eventId,
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Direction controls in captured names
 *
 * A component name, a changed prop key, a context name and a location are
 * captured text, and an invisible right-to-left override (U+202E) in one of
 * them draws the characters after it backwards. Every place this table puts
 * such text — the name chip and its tooltip, the unlinked name, the toggle and
 * occurrence names, the changed props and contexts, the detail — prints each
 * control as its visible escape (`\u202E`), and every value handed back to the
 * host stays as captured.
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

describe('RenderTable direction controls', () => {
  const linked = `Example${RLO}Widget${PDF}`;
  const unlinked = `Example${RLO}List`;
  const propKey = `on${RLO}Change`;
  const contextName = `Theme${RLO}Context`;

  /** A location whose symbol is the component itself, with a control in its path. */
  const bidiSource: SourceLocation = {
    ...WIDGET_SOURCE,
    file: `src/example/${RLO}widget.tsx`,
    symbol: linked,
  };

  const occurrence = makeOccurrence({
    eventId: `event-${RLO}example-0001`,
    trigger: 'context',
    changedPropKeys: [propKey],
    changedContexts: [contextName],
    source: bidiSource,
  });

  const linkedRow = makeRenderStat({
    component: linked,
    changedPropKeys: [propKey],
    changedPropCounts: { [propKey]: 2 },
    changedContexts: [contextName],
    changedContextCounts: { [contextName]: 1 },
    occurrences: [occurrence],
    occurrencesTruncated: false,
    source: bidiSource,
  });

  const unlinkedRow = makeRenderStat({ component: unlinked, occurrences: [] });

  it('prints every control as its escape, in the rows and the detail', async () => {
    const stub = resolvingProvider([linkedRow, unlinkedRow]);
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: makeActions().actions });

    await screen.findByRole('grid');

    // Both names are shown revealed: one captions its chip, one is plain text.
    expect(renderedNames()).toEqual([formatUntrustedText(linked), formatUntrustedText(unlinked)]);

    // The chip is named by its own rule, revealed, and its tooltip does not
    // repeat the caption the symbol-first description already names.
    const chip = within(rowFor(formatUntrustedText(linked))).getByRole('button', {
      name: nameChipName(linked, bidiSource),
    });
    expect(chip.getAttribute('aria-label')).toContain(RLO_MARKER);
    const bubble = chip.closest('.dg-tooltip')?.querySelector('[role="tooltip"]');
    expect(bubble?.textContent).toBe(formatSourceTooltip(bidiSource));

    await user.click(toggleOf(formatUntrustedText(linked)));

    const detail = onlyDetailRow();
    expect(detail.textContent).toContain(formatUntrustedText(linked));
    expect(detail.textContent).toContain(`on${RLO_MARKER}Change`);
    expect(detail.textContent).toContain(`Theme${RLO_MARKER}Context`);
    expect(
      within(detail).getByRole('button', {
        name: selectOccurrenceNameOf(
          formatUntrustedText(linked),
          formatOffset(occurrence.startTime, linkedRow.firstStartTime),
        ),
      }),
    ).toBeDefined();

    // Nothing a reader sees, hovers or hears carries a raw control.
    expect(rawDirectionSinks(document.body)).toEqual([]);
  });

  it('hands the host the raw location and the raw event id', async () => {
    const stub = resolvingProvider([linkedRow]);
    const spies = makeActions();
    const user = userEvent.setup();

    renderComponent(makeNode(), { provider: stub.provider, actions: spies.actions });

    await screen.findByRole('grid');
    await user.click(
      within(rowFor(formatUntrustedText(linked))).getByRole('button', {
        name: nameChipName(linked, bidiSource),
      }),
    );

    expect(spies.onOpenSource).toHaveBeenCalledTimes(1);
    expect(spies.onOpenSource.mock.calls[0]?.[0]).toEqual(bidiSource);
    expect(spies.onOpenSource.mock.calls[0]?.[0]?.file).toContain(RLO);

    await user.click(toggleOf(formatUntrustedText(linked)));
    await user.click(
      within(onlyDetailRow()).getByRole('button', {
        name: selectOccurrenceNameOf(
          formatUntrustedText(linked),
          formatOffset(occurrence.startTime, linkedRow.firstStartTime),
        ),
      }),
    );

    expect(spies.onSelectEvent).toHaveBeenLastCalledWith({
      eventId: occurrence.eventId,
      spanId: occurrence.spanId,
      traceId: occurrence.traceId,
    });
    expect(containsDirectionControl(occurrence.eventId)).toBe(true);
  });
});
