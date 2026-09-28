/**
 * `components/MetricCards` — the colocated suite for the `metricCards` node.
 *
 * ## What this suite is protecting
 *
 * `MetricCards` is one of only three components that recur across otherwise
 * dissimilar panels (with the summary header and the source chip): a
 * slow-interaction panel opens with the per-tier durations, a re-render panel
 * with the render counts, a duplicate-request panel with the request counts,
 * and **the same component draws all three**. The only thing that differs
 * between them is the node's `metrics` option, so three of the cases below are
 * the mechanical proof of that mechanism rather than tests of pixels:
 *
 *   - **order** renders a response whose order disagrees with the node's and
 *     asserts the tiles follow the *node*, because the id list is the panel
 *     author's emphasis; with no ids named, the response's own order stands.
 *   - **requested-but-missing** asks for three ids against a response holding
 *     two and asserts **three** tiles, the third marked unavailable. A silently
 *     dropped tile would leave a reader scanning a row that quietly answers a
 *     different question.
 *   - **the id list lives on the node** asserts `metrics` is a node option and
 *     never a query field, and that the query the provider receives is the
 *     node's own, unmodified: normalisation keeps `metrics` as the node's
 *     option (`docs/ARCHITECTURE.md`, "What normalisation does").
 *
 * The `metrics` source is paged by the same `DataPage` rule as every
 * array-valued source, so a further group pins how the tiles read it:
 *
 *   - **pages are followed by the service's counter**: the first request is the
 *     node's query unmodified, and each later one differs from it only in
 *     `offset`, set to the `nextOffset` the service reported. A page is
 *     followed only while a requested id is still missing, the counter
 *     advances and the page added an id, so a count-only `limit: 0` page, a
 *     stalled counter and a page that repeats itself each end the read.
 *   - **not on the pages read is not "not computed"**: a requested id that a
 *     partial read — count-only, an authored offset, a stopped follow — did not
 *     reach is drawn as not on the page, never as the absent label, which would
 *     state that the capture lacks it. Only a complete read from the first item
 *     earns the absent label, and only a zero total or a complete read earns
 *     the "nothing was computed" empty state.
 *   - **states span the whole read**: the loading state holds until the last
 *     page needed settles, and a failed later page is reported with its own
 *     query and a retry that re-requests exactly that page.
 *
 * Alongside those, every component suite in this folder covers the three states
 * of a query-backed view — loading, empty and error — and the click-to-source
 * payload. The first three are driven through a stub `DataProvider` that
 * respectively never settles, resolves an empty page and rejects.
 *
 * **On the click-to-source case, which this suite deliberately substitutes
 * for** (so a reader does not think it was forgotten): a metric is an aggregate
 * of the whole capture, `MetricValue` carries no source location and no event
 * reference, and the component imports no `PanelActions`. There is therefore no
 * payload to assert. Its place is taken by the two properties that matter here
 * instead:
 *
 *   - **the absent-label contract**: an unobservable value renders the
 *     package's own {@link NOT_AVAILABLE_LABEL} — never `0`, never a blank tile
 *     — and carries no unit and no severity colour, because an absence dressed
 *     as a measurement is a fabricated observation. The label is imported
 *     rather than spelled out anywhere below, so a change to the product's
 *     spelling of absence cannot pass this suite unnoticed;
 *   - **no fabricated interaction**: the group holds no control tied to a tile
 *     value, and clicking a tile raises nothing on a host's actions, which is
 *     what stops a click from having to invent a target.
 *
 * The remaining cases pin the two render-trigger metrics apart
 * (`unchanged_render_count` versus `render_trigger_unknown_count` — an
 * unevaluated render is not an unnecessary one, and nothing may show their
 * sum), the figure/unit split, the severity treatment across the product's own
 * duration thresholds, and the accessible naming a screen-reader user hears.
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
 *     webview implement — including its guarantee that a response answers for
 *     the source it was asked about. The resolver is a `vi.fn`, and every query
 *     it receives is recorded in an array the cases assert on. The paging
 *     cases state their pages as data: {@link pagedProvider} answers each
 *     query from a table keyed by its offset, with the `total` and `nextOffset`
 *     echo the service attaches (`null` on the last page, as the wire spells
 *     it), and rejects an offset the case did not declare.
 *   - **In-file synthetic builders, no fixture files**: {@link makeMetric} and
 *     {@link makeNode}, both taking overrides.
 *   - **Generic fixture vocabulary only.** Metric ids are the product's own
 *     closed vocabulary and belong here; every label and note below is product
 *     prose naming no application, demonstration or otherwise. `METRIC_IDS` is
 *     deliberately **not** imported as a runtime value — the component may not
 *     read it and neither may its test, so the ids a case needs are written
 *     out.
 *   - **Queries by role and accessible name.** The group, its tiles, the busy
 *     announcement, the alert and the note's description are all reached that
 *     way; a class is read only off an element already obtained semantically,
 *     since no `jest-dom` matcher is available in this repository.
 *   - **No colour literals.** Severity is asserted through the token reference
 *     `../utils/color` computes, and the thresholds come from the same module,
 *     so a case says "above the critical threshold" rather than restating a
 *     number the product owns. Spellings of formatted figures come from
 *     `../utils/format` for the same reason.
 *   - **No timers and no fake clocks.** Post-resolution assertions go through
 *     `await screen.findBy…`, and interactions through `userEvent`.
 *
 * @see ./MetricCards for the component, its four states and its class contract.
 * @see ../host/DataProvider for the seam the stubs below implement.
 * @see ../host/useQuery for the loading/empty/error machine they drive.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DataQuery, MetricCardsNode } from '@debuggen/panel-schema';
import { DATA_QUERY_DEFAULT_OFFSET } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { MetricId, MetricUnit, MetricValue } from '@debuggen/telemetry';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import {
  DURATION_CRITICAL_THRESHOLD_MS,
  DURATION_NORMAL_THRESHOLD_MS,
  durationColorVar,
} from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  containsDirectionControl,
  formatBytes,
  formatBytesParts,
  formatCount,
  formatDurationParts,
  formatUntrustedText,
  humanizeLabel,
} from '../utils/format';
import { MetricCards } from './MetricCards';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * The one source these tiles draw, and the only one a stub below answers for.
 *
 * `satisfies` rather than an annotation, exactly as the component does it: the
 * literal type is what makes a stub's echoed response and the node's query
 * agree, while the check still fails to compile if the source vocabulary is
 * ever renamed.
 */
const METRICS_SOURCE = 'metrics' satisfies DataQuery['source'];

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.metrics';

/** The accessible name of the tile group: the node catalog's own label. */
const GROUP_NAME = 'Metrics';

/** The accessible name of the note affordance the component renders. */
const NOTE_AFFORDANCE_NAME = 'Coverage note';

/** The accessible name `ErrorState` gives the serialised query it shows. */
const FAILING_QUERY_NAME = 'Failing query';

/** The error state's retry control. */
const RETRY_NAME = 'Retry';

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

/** What a service behind a proxy answers when it is down, as a plain rejection. */
const SERVICE_UNAVAILABLE_MESSAGE = 'The service answered 503 Service Unavailable.';
const SERVICE_UNAVAILABLE_STATUS = 503;

/**
 * A duration in the critical severity bucket, and one in the fast bucket.
 *
 * Expressed as offsets from the product's own thresholds rather than as bare
 * numbers, so these fixtures follow a threshold change instead of silently
 * landing in a different bucket than the case names.
 */
const CRITICAL_MS = DURATION_CRITICAL_THRESHOLD_MS + 140;
const FAST_MS = DURATION_NORMAL_THRESHOLD_MS - 38;

/** A measured byte size, which the byte scale formats as one figure. */
const TRANSFERRED_BYTES_VALUE = 1_500_000;

/** A transfer below one kilobyte, which the byte scale shows in whole bytes. */
const SMALL_TRANSFER_BYTES = 512;

/** The default value {@link makeMetric} gives a count. */
const DEFAULT_COUNT = 1;

/**
 * The three render counts of the trigger-split case.
 *
 * Chosen so that the sum of the two trigger counts (47) is neither displayed
 * nor a substring of any displayed figure, which is what makes "nothing shows
 * their sum" an assertion rather than a coincidence.
 */
const RENDER_COUNT = 48;
const UNCHANGED_RENDERS = 44;
const UNKNOWN_TRIGGER_RENDERS = 3;

/**
 * Product prose for the fixtures that need a heading or a caveat of their own.
 *
 * Generic by construction: these are the kind of sentences the aggregate layer
 * writes about coverage, and they name no inspected project.
 */
const COVERAGE_NOTE = 'Reported for same-origin responses only.';
const TOTAL_DURATION_LABEL = 'Total duration';
const RENDER_COUNT_LABEL = 'Renders';
const UNCHANGED_RENDERS_LABEL = 'Renders with stable inputs';
const UNKNOWN_TRIGGER_LABEL = 'Renders with an undetermined trigger';

/** A heading a later page repeats an id under, which the tiles must not show. */
const REPEATED_LABEL = 'Repeated value';

/**
 * The line each tier duration's tile carries under its heading, restated
 * rather than imported so a changed word is a failing case: every one says the
 * figure is wall-clock time and how overlapping work is treated, which is what
 * tells it apart from a dependency graph's summed participant time. No other
 * metric carries one.
 */
const DURATION_QUALIFIERS: Readonly<Partial<Record<MetricId, string>>> = {
  total_duration: 'wall clock: first start to last end',
  frontend_duration: 'wall clock, not covered by the server',
  backend_duration: 'wall clock: parallel work counted once',
  database_duration: 'wall clock: overlapping statements counted once',
};

/**
 * The heading part of a tile's accessible name: the heading, followed by its
 * qualifier in parentheses for a metric that has one.
 */
function namedHeading(id: MetricId, label: string): string {
  const qualifier = DURATION_QUALIFIERS[id];
  return qualifier === undefined ? label : `${label} (${qualifier})`;
}

/**
 * The component's module-private copy, recognised by generic substrings rather
 * than restated sentences — the way the empty-state case reads its message —
 * so each case pins which statement a tile makes, not its exact wording.
 *
 *   - {@link NOT_ON_PAGE_FIGURE} and {@link NOT_ON_PAGE_NOTE}: the figure and
 *     note of a requested id that lies outside the page or pages read.
 *   - {@link NOT_COMPUTED_NOTE}: the note of one a complete read did not find.
 *   - {@link NOTHING_COMPUTED}: the empty state of a capture that computed none.
 *   - {@link OUTSIDE_THE_PAGE}: the empty state of a read that holds no values
 *     although the capture may hold some.
 */
const NOT_ON_PAGE_FIGURE = /not on page/iu;
const NOT_ON_PAGE_NOTE = /outside the page/iu;
const NOT_COMPUTED_NOTE = /not part of the computed set/iu;
const NOTHING_COMPUTED = /no metrics were computed/iu;
const OUTSIDE_THE_PAGE = /outside the page/iu;

/** The failure the paging error case rejects its second request with. */
const DISCONNECTED_CODE = 'TRANSPORT_DISCONNECTED';

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/**
 * The overrides {@link makeMetric} accepts.
 *
 * `value` admits `undefined` explicitly, and passing `{ value: undefined }` is
 * how a case asks for an **unmeasured** metric: the key is then omitted from
 * the built value rather than stored as `undefined`, which is what this
 * repository's `exactOptionalPropertyTypes` requires and what the aggregate
 * layer itself produces.
 */
interface MetricOverrides {
  /** The heading the aggregate layer attached, or `''` for a malformed one. */
  readonly label?: string;
  /** The unit the value carries. Defaults to a count. */
  readonly unit?: MetricUnit;
  /** The availability flag, defaulting to whether a value was given. */
  readonly available?: boolean;
  /** The measured number, or `undefined` for a metric the capture could not measure. */
  readonly value?: number | undefined;
  /** A coverage caveat, shown as an advisory note. */
  readonly note?: string | undefined;
}

/**
 * One computed metric value, as the aggregate layer produces one.
 *
 * The default heading is the humanized id, which is what the real vocabulary's
 * labels read like; a case that needs to tell a *response* label from the
 * component's own fallback passes one explicitly.
 *
 * @param id The metric this value is for.
 * @param overrides Fields to replace, `{ value: undefined }` to omit the number.
 * @returns A fresh value; nothing is shared between calls.
 */
function makeMetric(id: MetricId, overrides: MetricOverrides = {}): MetricValue {
  const { label = humanizeLabel(id), unit = 'count', note } = overrides;
  const value = 'value' in overrides ? overrides.value : DEFAULT_COUNT;
  const available = overrides.available ?? value !== undefined;

  return {
    id,
    label,
    unit,
    available,
    ...(value === undefined ? {} : { value }),
    ...(note === undefined ? {} : { note }),
  };
}

/** A measured duration metric, in the unit the duration formatters split. */
function makeDuration(id: MetricId, ms: number, label?: string): MetricValue {
  return makeMetric(id, {
    unit: 'milliseconds',
    value: ms,
    ...(label === undefined ? {} : { label }),
  });
}

/** Overrides accepted by {@link makeNode}, with the same `undefined` policy. */
interface NodeOverrides {
  /** The node's id. */
  readonly id?: string;
  /** The data query to issue, defaulting to the implicit metrics query. */
  readonly query?: DataQuery;
}

/**
 * A normalised `metricCards` node, as the panel normaliser produces one.
 *
 * `metrics` sits on the node and **never inside `query`**: the renderer reads
 * the id list from the node, and a `metrics` tidied under the query would leave
 * the node parsing while rendering nothing. One case below asserts that shape
 * directly.
 *
 * @param metrics The ids to show, in display order.
 * @param overrides Fields to replace.
 * @returns A fresh node.
 */
function makeNode(metrics: readonly MetricId[], overrides: NodeOverrides = {}): MetricCardsNode {
  const { id = NODE_ID, query = { source: METRICS_SOURCE } } = overrides;

  return { type: 'metricCards', id, query, metrics: [...metrics] };
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
 * echoes `metrics` rather than whatever it received.
 * ---------------------------------------------------------------------------
 */

/** A stub provider, the queries it has received and the resolver behind it. */
interface StubProvider {
  /** The provider to hand to {@link renderCards}. */
  readonly provider: DataProvider;

  /**
   * Every query the component has asked for, in call order.
   *
   * What the component *requested* is as much of its contract as what it drew:
   * the node's query must arrive unmodified, and a retry must re-issue it.
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
 * A provider that answers every query with the same computed values.
 *
 * @param values The values of the response, in the order the service returned them.
 * @returns The stub provider.
 */
function resolvingProvider(values: readonly MetricValue[]): StubProvider {
  return recordingProvider(() =>
    Promise.resolve<DataQueryResponse>({ source: METRICS_SOURCE, data: values }),
  );
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

/**
 * One page a paged stub serves: its values and the paging echo the service
 * attaches to every array-valued page.
 *
 * `nextOffset` admits the wire's own `null` for "this is the last page", which
 * is how the paging cases spell the end, so the fold into `undefined` that
 * `../host/useQuery` performs is exercised rather than bypassed.
 */
interface StubPage {
  /** The values of the page, in the order the service returned them. */
  readonly data: readonly MetricValue[];
  /** How many values the source holds before `limit` and `offset`. */
  readonly total?: number | undefined;
  /** The offset of the next page, or `null` on the last one. */
  readonly nextOffset?: number | null | undefined;
}

/** A page table: each page keyed by the offset whose request it answers. */
type StubPages = ReadonlyMap<number, StubPage>;

/**
 * Answers one query from a page table, by the query's offset.
 *
 * An offset the table does not hold rejects with a code rather than resolving
 * empty, so a case that requested a page it did not declare fails on an error
 * state instead of quietly drawing an empty read.
 *
 * @param pages The table to serve from.
 * @param query The query to answer.
 * @returns The page's response, echoing the source it was asked about.
 */
function servePage(pages: StubPages, query: DataQuery): Promise<DataQueryResponse> {
  const offset = query.offset ?? DATA_QUERY_DEFAULT_OFFSET;
  const page = pages.get(offset);

  if (page === undefined) {
    return Promise.reject(
      new DebuggenError('INTERNAL', `No page is recorded at offset ${String(offset)}.`),
    );
  }

  return Promise.resolve<DataQueryResponse>({ source: METRICS_SOURCE, ...page });
}

/**
 * A provider that serves a page table, recording every query it receives.
 *
 * @param pages The pages, keyed by offset.
 * @returns The stub provider.
 */
function pagedProvider(pages: StubPages): StubProvider {
  return recordingProvider((query) => servePage(pages, query));
}

/*
 * ---------------------------------------------------------------------------
 * Actions, rendering and DOM readers
 * ---------------------------------------------------------------------------
 */

/** A host's `PanelActions`, with every member a view could raise spied on. */
interface ActionSpies {
  /** The object to provide through {@link PanelActionsContext}. */
  readonly actions: PanelActions;

  /** The event-selection spy. */
  readonly onSelectEvent: Mock<(ref: PanelEventRef) => void>;

  /** The open-source spy. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;

  /** The disclosure spy, supplied so a case can assert it was not called either. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;
}

/**
 * Fresh action spies.
 *
 * Both required members are supplied — a host missing either is not a host —
 * and the optional disclosure report is supplied too, so the
 * no-fabricated-interaction case can assert that *nothing* a host offers is
 * reached by a tile.
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

/** What {@link renderCards} needs beyond the node. */
interface RenderOptions {
  /** The provider resolving the node's query. */
  readonly provider: DataProvider;

  /** The host actions to report to. Fresh spies by default. */
  readonly actions?: PanelActions | undefined;

  /** A caller class name, for the composition case. */
  readonly className?: string | undefined;
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
 * @param options The provider, the actions and an optional class name.
 * @returns The render container, for the two cases that assert on the root.
 */
function renderCards(node: MetricCardsNode, options: RenderOptions): HTMLElement {
  const { provider, actions = makeActions().actions, className } = options;

  const view = render(
    <DataProviderContext.Provider value={provider}>
      <PanelSessionContext.Provider value={PANEL_SESSION_ID}>
        <PanelActionsContext.Provider value={actions}>
          <MetricCards node={node} className={className} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );

  return view.container;
}

/**
 * The tile group once the query has settled.
 *
 * @returns The group, named by the node catalog's own label.
 */
async function findGroup(): Promise<HTMLElement> {
  return screen.findByRole('list', { name: GROUP_NAME });
}

/**
 * The tiles of the settled group, in document order.
 *
 * @param expected How many tiles the case requires. Asserted here, so a case
 *   that reads `cards[2]` cannot silently read `undefined`.
 * @returns One element per tile.
 */
async function findCards(expected: number): Promise<HTMLElement[]> {
  const group = await findGroup();
  const cards = within(group).getAllByRole('listitem');

  expect(cards).toHaveLength(expected);

  return cards;
}

/** The tile at `index`, having already been counted by {@link findCards}. */
function cardAt(cards: readonly HTMLElement[], index: number): HTMLElement {
  const card = cards[index];

  if (card === undefined) {
    throw new Error(`no tile was rendered at index ${String(index)}`);
  }

  return card;
}

/** One part of a tile, read off a tile that was obtained semantically. */
function partOf(card: HTMLElement, part: 'label' | 'value' | 'unit'): HTMLElement | null {
  return card.querySelector<HTMLElement>(`.dg-metric-card__${part}`);
}

/** The text of one part of a tile, or `undefined` when the part is not rendered. */
function textOf(card: HTMLElement, part: 'label' | 'value' | 'unit'): string | undefined {
  return partOf(card, part)?.textContent ?? undefined;
}

/** The heading of each tile, in document order. */
function labelsOf(cards: readonly HTMLElement[]): (string | undefined)[] {
  return cards.map((card) => textOf(card, 'label'));
}

/** The figure of each tile, in document order. */
function figuresOf(cards: readonly HTMLElement[]): (string | undefined)[] {
  return cards.map((card) => textOf(card, 'value'));
}

/** Whether a tile carries the unavailable state the stylesheet mutes. */
function isUnavailable(card: HTMLElement): boolean {
  return card.classList.contains('dg-is-unavailable');
}

/** The severity custom property a tile's figure carries, if any. */
function severityStyleOf(card: HTMLElement): string | null {
  return partOf(card, 'value')?.getAttribute('style') ?? null;
}

/**
 * The formatted figure and unit of a measured duration.
 *
 * Taken from the package's own formatter rather than restated, so a case pins
 * the split (a number and its unit as two elements) instead of a spelling.
 *
 * @param ms The duration in milliseconds.
 * @returns Its figure and unit.
 */
function durationFigure(ms: number): { readonly value: string; readonly unit: string } {
  const parts = formatDurationParts(ms);

  if (!parts.available) {
    throw new Error(`the fixture duration ${String(ms)} is not measurable`);
  }

  return { value: parts.value, unit: parts.unit };
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

/** The query a stub provider received on the given 1-based call. */
function queryOfCall(stub: StubProvider, call: number): DataQuery {
  const query = stub.queries[call - 1];

  if (query === undefined) {
    throw new Error(`the stub provider recorded no query for call ${String(call)}`);
  }

  return query;
}

/**
 * The text of a tile's advisory note, read off the tooltip that describes it.
 *
 * `Tooltip` mounts its bubble only while it is open, so the note is opened the
 * way a keyboard reader opens it — focus arriving on its affordance — read, and
 * closed again, leaving the tile as it was.
 */
function noteOf(card: HTMLElement): string {
  const affordance = within(card).getByLabelText(NOTE_AFFORDANCE_NAME);

  fireEvent.focus(affordance);
  const text = within(card).getByRole('tooltip').textContent ?? '';
  fireEvent.blur(affordance);

  return text;
}

/**
 * Asserts that a tile is the not-on-page tile for `id`.
 *
 * Muted and unmeasured, like the absent-label tile, but saying less: the
 * component's own off-page figure — never the absent label, a digit or a dash —
 * under the humanized heading, with no unit and no severity colour, a note that
 * the value lies outside the page or pages requested, and an accessible name
 * that carries the figure so the distinction is heard as well as seen.
 *
 * @param card The tile, obtained semantically.
 * @param id The metric id the tile stands for.
 */
function expectNotOnPage(card: HTMLElement, id: MetricId): void {
  const figure = textOf(card, 'value') ?? '';

  expect(isUnavailable(card)).toBe(true);
  expect(figure).toMatch(NOT_ON_PAGE_FIGURE);
  expect(figure).not.toBe(NOT_AVAILABLE_LABEL);
  expect(figure).not.toMatch(/[\d\u2012-\u2015-]/u);
  expect(textOf(card, 'label')).toBe(humanizeLabel(id));
  expect(partOf(card, 'unit')).toBeNull();
  expect(severityStyleOf(card)).toBeNull();
  expect(noteOf(card)).toMatch(NOT_ON_PAGE_NOTE);
  expect(noteOf(card)).not.toMatch(NOT_COMPUTED_NOTE);
  expect(card.getAttribute('aria-label')).toBe(`${namedHeading(id, humanizeLabel(id))}: ${figure}`);
}

/**
 * Asserts that a tile is the absent-label tile for `id`: a complete read did
 * not find it, so the tile says the value is not part of this capture.
 *
 * @param card The tile, obtained semantically.
 * @param id The metric id the tile stands for.
 */
function expectNotComputed(card: HTMLElement, id: MetricId): void {
  expect(isUnavailable(card)).toBe(true);
  expect(textOf(card, 'value')).toBe(NOT_AVAILABLE_LABEL);
  expect(textOf(card, 'label')).toBe(humanizeLabel(id));
  expect(noteOf(card)).toMatch(NOT_COMPUTED_NOTE);
  expect(noteOf(card)).not.toMatch(NOT_ON_PAGE_NOTE);
}

// Explicit, per the harness note above: automatic cleanup belongs to the
// runner's configuration, this guarantee belongs to the suite. Restoring spies
// in the same place keeps one case's mock out of the next.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MetricCards states', () => {
  it('announces the query as busy, and draws no tiles, while it has not settled', () => {
    const stub = pendingProvider();

    renderCards(makeNode(['total_duration']), { provider: stub.provider });

    // `LoadingState` owns the announcement; this component contributes only the
    // state box that places it.
    const busy = screen.getByRole('status');

    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.classList.contains('dg-loading-state')).toBe(true);
    expect(busy.parentElement?.classList.contains('dg-metric-cards__loading')).toBe(true);

    // The announced label ends in the single ellipsis every busy region uses.
    expect(busy.textContent).toBe('Loading the computed values of this capture…');

    // Nothing is drawn yet: no group, therefore no tiles, and above all no
    // empty state — an unsettled query is not an answer.
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();

    // One query, issued without waiting to be asked twice.
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });

  it('renders its own empty message, and no tiles, when the capture computed nothing', async () => {
    const stub = resolvingProvider([]);

    renderCards(makeNode(['total_duration']), { provider: stub.provider });

    // Queried by a generic substring of the product's own copy rather than by a
    // restatement of the sentence: product vocabulary, naming no inspected
    // project.
    const message = await screen.findByText(/no metrics were computed/i);

    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.parentElement?.parentElement?.classList.contains('dg-metric-cards__empty')).toBe(
      true,
    );

    // Announced as the settled status, with a short title and a decorative
    // glyph above the sentence, like every other view's empty capture.
    const state = screen.getByRole('status');
    expect(state).toBe(message.parentElement);
    expect(state.querySelector('.dg-empty-state__title')?.textContent).toBe('No metrics');
    expect(state.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');

    // An empty response is a success, so it is drawn as an absence and not as a
    // failure — and not as a row of `n/a` tiles either, since there is no value
    // whose absence could be reported.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status', { busy: true })).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(message.textContent).not.toContain(NOT_AVAILABLE_LABEL);
  });

  it('raises an alert carrying the failed query, and retries that same query on request', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', 'The channel to the service is closed.'),
    );
    const user = userEvent.setup();

    renderCards(makeNode(['total_duration']), { provider: stub.provider });

    const alert = await screen.findByRole('alert');

    expect(alert.classList.contains('dg-error-state')).toBe(true);
    expect(alert.parentElement?.classList.contains('dg-metric-cards__error')).toBe(true);

    // The failure's own code reaches the reader beside the generic sentence, and
    // no part of either is presented as a computed value.
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');

    // The query that failed is shown in full, and compared as a value rather
    // than as a spelling.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });

    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: METRICS_SOURCE });
    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // The retry an error state offers is only useful if it really re-queries,
    // with the same query and not a narrowed one.
    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    expect(stub.resolve).toHaveBeenCalledTimes(2);
    expect(queryOfCall(stub, 2)).toEqual(queryOfCall(stub, 1));

    // No tiles were invented behind the failure.
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('renders a provider rejection through the shared error-state contract', async () => {
    const stub = rejectingProvider(
      new DebuggenError('TRANSPORT_DISCONNECTED', PROVIDER_CAUSE, { hint: PROVIDER_HINT }),
    );

    renderCards(makeNode(['total_duration']), { provider: stub.provider });

    // A lone failure is the assertive announcement.
    const alert = await screen.findByRole('alert');

    // The one title every failed view carries, and a message that opens with the
    // generic lead and keeps the provider's own cause after it.
    expect(within(alert).getByText(QUERY_FAILURE_TITLE)).toBeDefined();

    const message = alert.querySelector('.dg-error-state__message');

    expect(message?.textContent?.startsWith(QUERY_FAILURE_LEAD)).toBe(true);
    expect(message?.textContent).toContain(PROVIDER_CAUSE);

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
  });

  it('reports a plain 503 rejection as a lost transport, never as an internal error', async () => {
    const stub = recordingProvider(() =>
      Promise.reject(
        Object.assign(new Error(SERVICE_UNAVAILABLE_MESSAGE), {
          status: SERVICE_UNAVAILABLE_STATUS,
        }),
      ),
    );

    renderCards(makeNode(['total_duration']), { provider: stub.provider });

    const alert = await screen.findByRole('alert');
    const message = alert.querySelector('.dg-error-state__message');

    // The status maps to the code it means, and the generic lead is followed
    // by the renderer's own sentence naming the status: a plain rejection's
    // text is foreign, so it is never shown.
    expect(within(alert).getByText('TRANSPORT_DISCONNECTED').closest('.dg-badge')).not.toBeNull();
    expect(within(alert).queryByText('INTERNAL')).toBeNull();
    expect(message?.textContent).toBe(
      `${QUERY_FAILURE_LEAD} The request for this view's data failed with HTTP 503.`,
    );
    expect(message?.textContent).not.toContain(SERVICE_UNAVAILABLE_MESSAGE);
  });

  it('reports a node whose query names another source, and asks the provider for nothing', async () => {
    const stub = resolvingProvider([makeDuration('total_duration', CRITICAL_MS)]);

    renderCards(makeNode(['total_duration'], { query: { source: 'spans' } }), {
      provider: stub.provider,
    });

    const alert = await screen.findByRole('alert');

    // The node's own query is what the reader is shown, and no retry is offered:
    // re-issuing it cannot change the answer.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });

    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: 'spans' });
    expect(within(alert).queryByRole('button', { name: RETRY_NAME })).toBeNull();

    // Nothing was asked of the provider, and nothing was drawn as if it had been.
    expect(stub.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it("keeps the caller's class name on the root while loading and once settled", async () => {
    const pending = renderCards(makeNode(['total_duration']), {
      provider: pendingProvider().provider,
      className: 'panel-slot',
    });

    expect(pending.querySelector('.dg-metric-cards.panel-slot')).not.toBeNull();

    cleanup();

    renderCards(makeNode(['total_duration']), {
      provider: resolvingProvider([makeDuration('total_duration', CRITICAL_MS)]).provider,
      className: 'panel-slot',
    });

    const group = await findGroup();

    expect(group.tagName).toBe('UL');
    expect(group.classList.contains('dg-metric-cards')).toBe(true);
    expect(group.classList.contains('panel-slot')).toBe(true);
  });
});

describe('MetricCards selection and order', () => {
  it("draws one tile per requested id, in the node's order and not the response's", async () => {
    // The response arrives in the vocabulary's own order; the node asks for the
    // reverse. The node wins: its order is the panel author's emphasis, and it
    // is the only thing that distinguishes this component's use in one panel
    // from its use in another.
    const stub = resolvingProvider([
      makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
      makeMetric('render_count', { label: RENDER_COUNT_LABEL, value: RENDER_COUNT }),
    ]);

    renderCards(makeNode(['render_count', 'total_duration']), { provider: stub.provider });

    expect(labelsOf(await findCards(2))).toEqual([RENDER_COUNT_LABEL, TOTAL_DURATION_LABEL]);
  });

  it('follows the response order when the node names no ids', async () => {
    const stub = resolvingProvider([
      makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
      makeMetric('render_count', { label: RENDER_COUNT_LABEL, value: RENDER_COUNT }),
    ]);

    // An empty id list is not a specification the schema permits, but a
    // hand-built node can express one and the component must still draw
    // something legible rather than nothing.
    renderCards(makeNode([]), { provider: stub.provider });

    expect(labelsOf(await findCards(2))).toEqual([TOTAL_DURATION_LABEL, RENDER_COUNT_LABEL]);
  });

  it('draws a requested id the capture did not compute as a third, unavailable tile', async () => {
    // Three ids requested, two computed. The one the capture holds no value for
    // is still a tile, still in the position the author put it in, and says
    // plainly that the value is absent — never dropped, and never a zero.
    const stub = resolvingProvider([
      makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
      makeDuration('frontend_duration', FAST_MS),
    ]);

    renderCards(makeNode(['total_duration', 'frontend_duration', 'database_duration']), {
      provider: stub.provider,
    });

    const cards = await findCards(3);
    const missing = cardAt(cards, 2);

    expect(isUnavailable(missing)).toBe(true);
    expect(textOf(missing, 'value')).toBe(NOT_AVAILABLE_LABEL);

    // No response entry carried a heading for this id, so the heading a reader
    // sees can only be the component's own humanized fallback.
    expect(textOf(missing, 'label')).toBe(humanizeLabel('database_duration'));

    // The two computed tiles are unaffected by the third's absence.
    expect(isUnavailable(cardAt(cards, 0))).toBe(false);
    expect(isUnavailable(cardAt(cards, 1))).toBe(false);
  });

  it('keeps the id list on the node and issues the node\u2019s query unmodified', async () => {
    // Normalisation gives this node the implicit `query: { source: "metrics" }`
    // and keeps `metrics` as the node's own option. Both halves are asserted —
    // the shape of the node, and the query the provider actually receives.
    const node = makeNode(['total_duration', 'render_count']);

    expect(node.metrics).toEqual(['total_duration', 'render_count']);
    expect(Object.keys(node.query)).toEqual(['source']);
    expect('metrics' in node.query).toBe(false);

    const stub = resolvingProvider([
      makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
      makeMetric('render_count', { label: RENDER_COUNT_LABEL, value: RENDER_COUNT }),
    ]);

    renderCards(node, { provider: stub.provider });

    await findCards(2);

    // Unmodified: no filter, no sort, no limit and no offset are added, because
    // a renderer that narrowed the request would be choosing evidence. Every
    // requested id was on that first page, so no further page is asked for.
    expect(soleQuery(stub)).toEqual({ source: METRICS_SOURCE });
    expect('metrics' in soleQuery(stub)).toBe(false);
  });
});

describe('MetricCards paging', () => {
  it('follows nextOffset to the next page, changing only the offset, and draws tiles from both', async () => {
    // The authored limit leaves the second requested id off the first page.
    // The follow-up keeps that limit and advances only the offset, to the
    // counter the service reported — never to one derived from the page length.
    const nodeQuery: DataQuery = { source: METRICS_SOURCE, limit: 2 };
    const stub = pagedProvider(
      new Map<number, StubPage>([
        [
          0,
          {
            data: [
              makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
              makeMetric('request_count'),
            ],
            total: 3,
            nextOffset: 2,
          },
        ],
        [
          2,
          {
            data: [makeMetric('render_count', { label: RENDER_COUNT_LABEL, value: RENDER_COUNT })],
            total: 3,
            nextOffset: null,
          },
        ],
      ]),
    );

    renderCards(
      makeNode(['render_count', 'total_duration', 'database_duration'], { query: nodeQuery }),
      { provider: stub.provider },
    );

    const cards = await findCards(3);

    // One tile from each page, in the node's order, each showing exactly what
    // its own page said about its id.
    expect(labelsOf(cards).slice(0, 2)).toEqual([RENDER_COUNT_LABEL, TOTAL_DURATION_LABEL]);
    expect(figuresOf(cards).slice(0, 2)).toEqual([
      formatCount(RENDER_COUNT),
      durationFigure(CRITICAL_MS).value,
    ]);
    expect(isUnavailable(cardAt(cards, 0))).toBe(false);
    expect(isUnavailable(cardAt(cards, 1))).toBe(false);

    // The read started at the first item and ran to the service's end with
    // every item accounted for, so the id no page carried is not computed.
    expectNotComputed(cardAt(cards, 2), 'database_duration');

    expect(stub.queries).toEqual([nodeQuery, { ...nodeQuery, offset: 2 }]);
  });

  it('stops requesting once every requested id is found, though a further page is reported', async () => {
    // Any further request would be answered by the stub's undeclared-page
    // rejection, so reaching the tiles at all proves none was made.
    const stub = pagedProvider(
      new Map<number, StubPage>([
        [
          0,
          {
            data: [
              makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
              makeMetric('render_count', { label: RENDER_COUNT_LABEL, value: RENDER_COUNT }),
            ],
            total: 5,
            nextOffset: 2,
          },
        ],
      ]),
    );

    renderCards(makeNode(['render_count']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);

    expect(isUnavailable(card)).toBe(false);
    expect(textOf(card, 'value')).toBe(formatCount(RENDER_COUNT));
    expect(soleQuery(stub)).toEqual({ source: METRICS_SOURCE });
  });

  it('answers a count-only query with one request and not-on-page tiles, never "not computed"', async () => {
    // `limit: 0` asks for the total and no values. A page that returned
    // nothing is the last page, so the service reports no further one and
    // exactly one request is made — and since the total says values exist that
    // no page carried, none is called absent.
    const nodeQuery: DataQuery = { source: METRICS_SOURCE, limit: 0 };
    const stub = pagedProvider(
      new Map<number, StubPage>([[0, { data: [], total: 3, nextOffset: null }]]),
    );

    renderCards(makeNode(['total_duration', 'render_count'], { query: nodeQuery }), {
      provider: stub.provider,
    });

    const cards = await findCards(2);

    expectNotOnPage(cardAt(cards, 0), 'total_duration');
    expectNotOnPage(cardAt(cards, 1), 'render_count');

    // A positive total is not an empty capture, so no empty state is drawn.
    expect(screen.queryByText(NOTHING_COMPUTED)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(soleQuery(stub)).toEqual(nodeQuery);
  });

  it('draws the nothing-computed empty state for a count-only query whose total is zero', async () => {
    const nodeQuery: DataQuery = { source: METRICS_SOURCE, limit: 0 };
    const stub = pagedProvider(
      new Map<number, StubPage>([[0, { data: [], total: 0, nextOffset: null }]]),
    );

    renderCards(makeNode(['total_duration'], { query: nodeQuery }), { provider: stub.provider });

    const message = await screen.findByText(NOTHING_COMPUTED);

    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(soleQuery(stub)).toEqual(nodeQuery);
  });

  it('tells a node naming no ids that its values lie outside the requested page, with the total', async () => {
    // With no ids named there is no tile to mark, so the absence is an empty
    // state — but one that says where the values are, not that there are none.
    const reportedTotal = 3;
    const stub = pagedProvider(
      new Map<number, StubPage>([[0, { data: [], total: reportedTotal, nextOffset: null }]]),
    );

    renderCards(makeNode([], { query: { source: METRICS_SOURCE, limit: 0 } }), {
      provider: stub.provider,
    });

    const message = await screen.findByText(OUTSIDE_THE_PAGE);

    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.parentElement?.parentElement?.classList.contains('dg-metric-cards__empty')).toBe(
      true,
    );
    expect(message.textContent).toContain(formatCount(reportedTotal));
    expect(message.textContent).not.toMatch(NOTHING_COMPUTED);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(stub.resolve).toHaveBeenCalledTimes(1);

    // Titled as an empty page, in the words every paged view uses, and never
    // as the empty capture; the same glyph and settled status as that state.
    const state = screen.getByRole('status');
    expect(state).toBe(message.parentElement);
    expect(state.querySelector('.dg-empty-state__title')?.textContent).toBe('Nothing on this page');
    expect(state.querySelector('.dg-empty-state__icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws a requested id an authored offset did not reach as not on the page', async () => {
    // A read that starts past the first item cannot have seen the items before
    // it, so an id it did not find may well be one of them.
    const nodeQuery: DataQuery = { source: METRICS_SOURCE, offset: 2 };
    const stub = pagedProvider(
      new Map<number, StubPage>([
        [
          2,
          {
            data: [makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL)],
            total: 3,
            nextOffset: null,
          },
        ],
      ]),
    );

    renderCards(makeNode(['total_duration', 'database_duration'], { query: nodeQuery }), {
      provider: stub.provider,
    });

    const cards = await findCards(2);

    expect(isUnavailable(cardAt(cards, 0))).toBe(false);
    expectNotOnPage(cardAt(cards, 1), 'database_duration');
    expect(soleQuery(stub)).toEqual(nodeQuery);
  });

  it('draws a requested id a complete read from the first item did not find as not computed', async () => {
    // The control case for the one above: the same page contents, read from
    // offset zero to the service's end, do support the absent label.
    const stub = pagedProvider(
      new Map<number, StubPage>([
        [
          0,
          {
            data: [makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL)],
            total: 1,
            nextOffset: null,
          },
        ],
      ]),
    );

    renderCards(makeNode(['total_duration', 'database_duration']), { provider: stub.provider });

    const cards = await findCards(2);

    expect(isUnavailable(cardAt(cards, 0))).toBe(false);
    expectNotComputed(cardAt(cards, 1), 'database_duration');
    expect(textOf(cardAt(cards, 1), 'value')).not.toMatch(NOT_ON_PAGE_FIGURE);
    expect(soleQuery(stub)).toEqual({ source: METRICS_SOURCE });
  });

  it('never calls a value not computed when the reported total exceeds what the pages held', async () => {
    // A self-contradicting last page — an empty first page of a query that asked
    // for values, no further page, yet a total the read does not account for —
    // cannot support "not computed": the service's own count says values exist
    // that no page carried.
    const nodeQuery: DataQuery = { source: METRICS_SOURCE };
    const stub = pagedProvider(
      new Map<number, StubPage>([[0, { data: [], total: 3, nextOffset: null }]]),
    );

    renderCards(makeNode(['render_count'], { query: nodeQuery }), { provider: stub.provider });

    expectNotOnPage(cardAt(await findCards(1), 0), 'render_count');
    expect(screen.queryByText(NOTHING_COMPUTED)).toBeNull();
    expect(soleQuery(stub)).toEqual(nodeQuery);
  });

  it('stops after one request when the reported next offset does not advance past the page', async () => {
    // A counter equal to the page's own offset would only repeat the request.
    const stub = pagedProvider(
      new Map<number, StubPage>([
        [
          0,
          {
            data: [makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL)],
            total: 4,
            nextOffset: 0,
          },
        ],
      ]),
    );

    renderCards(makeNode(['total_duration', 'render_count']), { provider: stub.provider });

    const cards = await findCards(2);

    expect(isUnavailable(cardAt(cards, 0))).toBe(false);
    expectNotOnPage(cardAt(cards, 1), 'render_count');
    expect(soleQuery(stub)).toEqual({ source: METRICS_SOURCE });
  });

  it('stops when an advancing page repeats only ids already collected', async () => {
    // The second page advances the counter but adds nothing new, so the read
    // is making no progress and the third page is never asked for. The repeat
    // is dropped: the first page's value for the id is the one drawn.
    const stub = pagedProvider(
      new Map<number, StubPage>([
        [
          0,
          {
            data: [makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL)],
            total: 3,
            nextOffset: 1,
          },
        ],
        [
          1,
          {
            data: [makeDuration('total_duration', FAST_MS, REPEATED_LABEL)],
            total: 3,
            nextOffset: 2,
          },
        ],
        [
          2,
          {
            data: [makeMetric('render_count', { label: RENDER_COUNT_LABEL, value: RENDER_COUNT })],
            total: 3,
            nextOffset: null,
          },
        ],
      ]),
    );

    renderCards(makeNode(['total_duration', 'render_count']), { provider: stub.provider });

    const cards = await findCards(2);

    expect(textOf(cardAt(cards, 0), 'label')).toBe(TOTAL_DURATION_LABEL);
    expect(textOf(cardAt(cards, 0), 'value')).toBe(durationFigure(CRITICAL_MS).value);
    expectNotOnPage(cardAt(cards, 1), 'render_count');
    expect(stub.queries).toEqual([
      { source: METRICS_SOURCE },
      { source: METRICS_SOURCE, offset: 1 },
    ]);
  });

  it('draws every computed value across pages when the node names no ids, first occurrence winning', async () => {
    const stub = pagedProvider(
      new Map<number, StubPage>([
        [
          0,
          {
            data: [makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL)],
            total: 3,
            nextOffset: 1,
          },
        ],
        [
          1,
          {
            data: [
              makeDuration('total_duration', FAST_MS, REPEATED_LABEL),
              makeMetric('render_count', { label: RENDER_COUNT_LABEL, value: RENDER_COUNT }),
            ],
            total: 3,
            nextOffset: null,
          },
        ],
      ]),
    );

    renderCards(makeNode([]), { provider: stub.provider });

    const cards = await findCards(2);

    // Arrival order, one tile per id, and the repeated id keeps the heading and
    // figure its first page gave it.
    expect(labelsOf(cards)).toEqual([TOTAL_DURATION_LABEL, RENDER_COUNT_LABEL]);
    expect(figuresOf(cards)).toEqual([
      durationFigure(CRITICAL_MS).value,
      formatCount(RENDER_COUNT),
    ]);
    expect(screen.queryByText(REPEATED_LABEL)).toBeNull();
    expect(stub.queries).toEqual([
      { source: METRICS_SOURCE },
      { source: METRICS_SOURCE, offset: 1 },
    ]);
  });

  it('keeps the loading state until the follow-up page settles, drawing no partial tiles', async () => {
    // The follow-up never settles, so the first page's value must not be drawn
    // on its own — a partial read shown as tiles would mislabel the rest.
    const firstPage: DataQueryResponse = {
      source: METRICS_SOURCE,
      data: [makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL)],
      total: 2,
      nextOffset: 1,
    };
    const stub = recordingProvider((query) =>
      (query.offset ?? DATA_QUERY_DEFAULT_OFFSET) === DATA_QUERY_DEFAULT_OFFSET
        ? Promise.resolve(firstPage)
        : new Promise<DataQueryResponse>(() => undefined),
    );

    renderCards(makeNode(['total_duration', 'render_count']), { provider: stub.provider });

    await waitFor(() => {
      expect(stub.resolve).toHaveBeenCalledTimes(2);
    });

    expect(queryOfCall(stub, 2)).toEqual({ source: METRICS_SOURCE, offset: 1 });

    const busy = screen.getByRole('status');

    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.parentElement?.classList.contains('dg-metric-cards__loading')).toBe(true);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByText(NOTHING_COMPUTED)).toBeNull();
  });

  it('reports a failed follow-up page with its own query, and its retry re-requests that page', async () => {
    const pages = new Map<number, StubPage>([
      [
        0,
        {
          data: [makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL)],
          total: 2,
          nextOffset: 1,
        },
      ],
      [
        1,
        {
          data: [makeMetric('render_count', { label: RENDER_COUNT_LABEL, value: RENDER_COUNT })],
          total: 2,
          nextOffset: null,
        },
      ],
    ]);
    const stub = recordingProvider((query, call) =>
      call === 2
        ? Promise.reject(
            new DebuggenError(DISCONNECTED_CODE, 'The channel to the service is closed.'),
          )
        : servePage(pages, query),
    );
    const user = userEvent.setup();

    renderCards(makeNode(['total_duration', 'render_count']), { provider: stub.provider });

    const alert = await screen.findByRole('alert');

    expect(alert.parentElement?.classList.contains('dg-metric-cards__error')).toBe(true);
    expect(alert.textContent).toContain(DISCONNECTED_CODE);

    // The query shown is the page that failed — the node's own with the
    // service's counter as its offset — not the first page that succeeded.
    const shown = within(alert).getByRole('group', { name: FAILING_QUERY_NAME });

    expect(JSON.parse(shown.textContent ?? '')).toEqual({ source: METRICS_SOURCE, offset: 1 });

    // No tile from the page that did arrive is drawn beneath the failure.
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);

    await user.click(within(alert).getByRole('button', { name: RETRY_NAME }));

    const cards = await findCards(2);

    expect(labelsOf(cards)).toEqual([TOTAL_DURATION_LABEL, RENDER_COUNT_LABEL]);
    expect(isUnavailable(cardAt(cards, 0))).toBe(false);
    expect(isUnavailable(cardAt(cards, 1))).toBe(false);

    // The retry re-requested the failed page alone; the first page stood.
    expect(stub.queries).toEqual([
      { source: METRICS_SOURCE },
      { source: METRICS_SOURCE, offset: 1 },
      { source: METRICS_SOURCE, offset: 1 },
    ]);
  });
});

describe('MetricCards figures', () => {
  it('splits a measured duration into a figure and a separate unit element', async () => {
    const stub = resolvingProvider([
      makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
    ]);

    renderCards(makeNode(['total_duration']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);
    const expected = durationFigure(CRITICAL_MS);

    // Two elements, not one string: the figure sits in the prominent numeric
    // role and the unit beside it, so the number never carries a suffix.
    expect(partOf(card, 'unit')).not.toBeNull();
    expect(textOf(card, 'value')).toBe(expected.value);
    expect(textOf(card, 'unit')).toBe(expected.unit);
    expect(textOf(card, 'value')).not.toContain(expected.unit);
    expect(isUnavailable(card)).toBe(false);
  });

  it('renders an unobservable value as the absent label, never as a zero', async () => {
    // The unobservable value this component owns: a transfer size is exposed by
    // the browser for same-origin responses only and by a server span not at
    // all. Printing `0` there would turn an absence into an observation.
    const stub = resolvingProvider([
      makeMetric('transferred_bytes', { unit: 'bytes', value: undefined, note: COVERAGE_NOTE }),
    ]);

    renderCards(makeNode(['transferred_bytes']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);

    expect(isUnavailable(card)).toBe(true);
    expect(textOf(card, 'value')).toBe(NOT_AVAILABLE_LABEL);

    // Not a zero anywhere in the tile, standalone or grouped: the whole point of
    // the absent label is that no digit stands in for an unmeasured value.
    expect(card.textContent ?? '').not.toMatch(/\d/u);

    // An absence is never dressed as a measurement: no unit, no severity colour.
    expect(partOf(card, 'unit')).toBeNull();
    expect(severityStyleOf(card)).toBeNull();
  });

  it('treats a value no formatter can express as unavailable even when flagged available', async () => {
    // A contradictory record — available, but with a value fixed notation
    // cannot express — must not be styled as a measurement while showing the
    // absent label. This is the totality the two availability checks exist for.
    const stub = resolvingProvider([
      makeMetric('frontend_duration', {
        unit: 'milliseconds',
        available: true,
        value: Number.NaN,
      }),
    ]);

    renderCards(makeNode(['frontend_duration']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);

    expect(isUnavailable(card)).toBe(true);
    expect(textOf(card, 'value')).toBe(NOT_AVAILABLE_LABEL);
    expect(severityStyleOf(card)).toBeNull();
  });

  it('distinguishes a critical duration from a fast one by its severity treatment', async () => {
    // Severity is read against the product's four shared thresholds and arrives
    // as a token reference. Asserted through the reference `../utils/color`
    // computes — never as a colour literal, which this package forbids
    // outright.
    const stub = resolvingProvider([
      makeDuration('backend_duration', CRITICAL_MS),
      makeDuration('frontend_duration', FAST_MS),
    ]);

    renderCards(makeNode(['backend_duration', 'frontend_duration']), { provider: stub.provider });

    const cards = await findCards(2);
    const critical = severityStyleOf(cardAt(cards, 0));
    const fast = severityStyleOf(cardAt(cards, 1));

    expect(critical).toContain('--dgc-severity-color');
    expect(critical).toContain(durationColorVar(CRITICAL_MS));
    expect(fast).toContain(durationColorVar(FAST_MS));

    // Two buckets, two treatments: a panel that drew both the same would hide
    // the one figure a reader is scanning for.
    expect(durationColorVar(CRITICAL_MS)).not.toBe(durationColorVar(FAST_MS));
    expect(critical).not.toBe(fast);
  });

  it('gives a count its grouped figure, with no unit element and no severity colour', async () => {
    const stub = resolvingProvider([
      makeMetric('request_count', { value: RENDER_COUNT, label: RENDER_COUNT_LABEL }),
    ]);

    renderCards(makeNode(['request_count']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);

    expect(textOf(card, 'value')).toBe(formatCount(RENDER_COUNT));
    expect(partOf(card, 'unit')).toBeNull();

    // A count has no duration threshold to be read against, so it carries no
    // severity property at all rather than a neutral one.
    expect(severityStyleOf(card)).toBeNull();
  });

  it('splits a measured byte size into its figure and its unit, as a duration is', async () => {
    const stub = resolvingProvider([
      makeMetric('transferred_bytes', { unit: 'bytes', value: TRANSFERRED_BYTES_VALUE }),
    ]);

    renderCards(makeNode(['transferred_bytes']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);
    const parts = formatBytesParts(TRANSFERRED_BYTES_VALUE);
    if (!parts.available) {
      throw new Error('the byte size under test is not measurable');
    }

    // The number in the prominent role and the unit in its own muted element —
    // never the unit concatenated into the figure — and the pair reads as the
    // one joined label every other surface shows.
    expect(isUnavailable(card)).toBe(false);
    expect(textOf(card, 'value')).toBe(parts.value);
    expect(textOf(card, 'unit')).toBe(parts.unit);
    expect(textOf(card, 'value')).not.toContain(parts.unit);
    expect(`${textOf(card, 'value') ?? ''} ${textOf(card, 'unit') ?? ''}`).toBe(
      formatBytes(TRANSFERRED_BYTES_VALUE),
    );
    expect(card.getAttribute('aria-label')).toBe(
      `${humanizeLabel('transferred_bytes')}: ${formatBytes(TRANSFERRED_BYTES_VALUE)}`,
    );

    // A size has no duration threshold to be read against, so no severity.
    expect(severityStyleOf(card)).toBeNull();
  });

  it('splits every step of the byte scale, whole bytes included', async () => {
    const stub = resolvingProvider([
      makeMetric('transferred_bytes', { unit: 'bytes', value: SMALL_TRANSFER_BYTES }),
    ]);

    renderCards(makeNode(['transferred_bytes']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);

    expect(textOf(card, 'value')).toBe(formatCount(SMALL_TRANSFER_BYTES));
    expect(textOf(card, 'unit')).toBe('B');
  });

  it('falls back to the humanized id when a value arrives with a blank heading', async () => {
    const stub = resolvingProvider([
      makeMetric('blocking_time', { unit: 'milliseconds', value: FAST_MS, label: '' }),
    ]);

    renderCards(makeNode(['blocking_time']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);

    // A tile with no heading is a number with no subject, so the same humanizer
    // the absent-value tile uses stands in for the malformed label.
    expect(textOf(card, 'label')).toBe(humanizeLabel('blocking_time'));
  });
});

describe('MetricCards render-trigger split', () => {
  it('keeps the two render-trigger metrics apart and shows no total of them', async () => {
    // `unchanged_render_count` counts renders whose inputs were provably
    // stable, `render_trigger_unknown_count` counts renders whose trigger could
    // not be evaluated at all. An unevaluated render is not an unnecessary one,
    // so they are never added, grouped or relabelled.
    const stub = resolvingProvider([
      makeMetric('render_count', { value: RENDER_COUNT, label: RENDER_COUNT_LABEL }),
      makeMetric('unchanged_render_count', {
        value: UNCHANGED_RENDERS,
        label: UNCHANGED_RENDERS_LABEL,
      }),
      makeMetric('render_trigger_unknown_count', {
        value: UNKNOWN_TRIGGER_RENDERS,
        label: UNKNOWN_TRIGGER_LABEL,
      }),
    ]);

    renderCards(
      makeNode(['render_count', 'unchanged_render_count', 'render_trigger_unknown_count']),
      { provider: stub.provider },
    );

    const cards = await findCards(3);
    const labels = labelsOf(cards);
    const figures = figuresOf(cards);

    // Three tiles, three distinct headings, three distinct figures: in
    // particular the two trigger metrics neither share a heading nor a figure.
    expect(labels).toEqual([RENDER_COUNT_LABEL, UNCHANGED_RENDERS_LABEL, UNKNOWN_TRIGGER_LABEL]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(figures).toEqual([
      formatCount(RENDER_COUNT),
      formatCount(UNCHANGED_RENDERS),
      formatCount(UNKNOWN_TRIGGER_RENDERS),
    ]);
    expect(new Set(figures).size).toBe(figures.length);

    // Nothing on screen is their sum: a merged figure would present renders
    // whose trigger was never evaluated as renders that were provably needless.
    const merged = formatCount(UNCHANGED_RENDERS + UNKNOWN_TRIGGER_RENDERS);

    expect(figures).not.toContain(merged);
    expect(screen.queryByText(merged)).toBeNull();
    expect((await findGroup()).textContent ?? '').not.toContain(merged);
  });
});

describe('MetricCards accessibility and interaction', () => {
  it('names each tile by pairing its heading with its figure and unit', async () => {
    // A list item takes its name from the author rather than from its contents,
    // and a figure announced without its heading is a number with no subject.
    const stub = resolvingProvider([
      makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
      makeMetric('render_count', { value: RENDER_COUNT, label: RENDER_COUNT_LABEL }),
    ]);

    renderCards(makeNode(['total_duration', 'render_count']), { provider: stub.provider });

    const group = await findGroup();
    const duration = durationFigure(CRITICAL_MS);

    // Queried *by* the accessible name, so the case fails if the pairing is
    // dropped rather than merely if the attribute text changes.
    const durationCard = within(group).getByRole('listitem', {
      name: `${TOTAL_DURATION_LABEL} (wall clock: first start to last end): ${duration.value} ${duration.unit}`,
    });
    const countCard = within(group).getByRole('listitem', {
      name: `${RENDER_COUNT_LABEL}: ${formatCount(RENDER_COUNT)}`,
    });

    expect(textOf(durationCard, 'label')).toBe(TOTAL_DURATION_LABEL);
    expect(textOf(countCard, 'value')).toBe(formatCount(RENDER_COUNT));
  });

  it('states the list and list-item roles explicitly, whatever the stylesheet sets display to', async () => {
    // The stylesheet lays the grid out with `display: grid` and each tile with
    // `display: flex`, and a changed display value drops the implicit list
    // semantics in WebKit-derived engines.
    const stub = resolvingProvider([makeDuration('total_duration', CRITICAL_MS)]);

    renderCards(makeNode(['total_duration']), { provider: stub.provider });

    const group = await findGroup();

    expect(group.getAttribute('role')).toBe('list');
    expect(group.getAttribute('aria-label')).toBe(GROUP_NAME);
    expect(cardAt(within(group).getAllByRole('listitem'), 0).getAttribute('role')).toBe('listitem');
  });

  it('exposes a coverage note as a keyboard-reachable accessible description', async () => {
    const user = userEvent.setup();
    const stub = resolvingProvider([
      makeMetric('transferred_bytes', { unit: 'bytes', value: undefined, note: COVERAGE_NOTE }),
    ]);

    renderCards(makeNode(['transferred_bytes']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);
    const affordance = within(card).getByLabelText(NOTE_AFFORDANCE_NAME);

    // Focusable on purpose: focus is how a keyboard reader opens a tooltip, and
    // it is the only focusable thing in the group.
    expect(affordance.getAttribute('tabindex')).toBe('0');

    await user.tab();

    expect(document.activeElement).toBe(affordance);

    // Focus opened the bubble, which `Tooltip` mounts only while it is open, and
    // the affordance names it as its description for exactly that long.
    const bubble = within(card).getByRole('tooltip');

    expect(bubble.textContent).toBe(COVERAGE_NOTE);
    expect((affordance.getAttribute('aria-describedby') ?? '').split(/\s+/u)).toContain(bubble.id);
  });

  it('offers no control tied to a tile value, and raises nothing when a tile is clicked', async () => {
    // This case stands in for the click-to-source payload assertion every other
    // component suite here makes (see the file note): a metric is an aggregate
    // of the whole capture and references no single record, so a clickable tile
    // would have to invent a target — fabricated evidence.
    const user = userEvent.setup();
    const spies = makeActions();
    const stub = resolvingProvider([
      makeDuration('total_duration', CRITICAL_MS, TOTAL_DURATION_LABEL),
      makeMetric('transferred_bytes', { unit: 'bytes', value: undefined, note: COVERAGE_NOTE }),
    ]);

    renderCards(makeNode(['total_duration', 'transferred_bytes']), {
      provider: stub.provider,
      actions: spies.actions,
    });

    const group = await findGroup();
    const cards = within(group).getAllByRole('listitem');

    // Nothing in the group is a control, and no tile is focusable: the only
    // focusable element is the advisory-note affordance, which is a described
    // span rather than a button.
    expect(within(group).queryAllByRole('button')).toHaveLength(0);
    expect(within(group).queryAllByRole('link')).toHaveLength(0);
    expect(within(group).queryAllByRole('checkbox')).toHaveLength(0);
    expect(cardAt(cards, 0).getAttribute('tabindex')).toBeNull();

    await user.click(cardAt(cards, 0));
    await user.click(within(cardAt(cards, 1)).getByLabelText(NOTE_AFFORDANCE_NAME));

    // No host intent is raised by either gesture, and no further query is made.
    expect(spies.onSelectEvent).not.toHaveBeenCalled();
    expect(spies.onOpenSource).not.toHaveBeenCalled();
    expect(spies.onExpand).not.toHaveBeenCalled();
    expect(stub.resolve).toHaveBeenCalledTimes(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The stylesheet half of the tile contract
 *
 * The test environment applies no stylesheet, so the three presentational
 * guarantees below are pinned in two halves: the markup the component emits,
 * asserted on the rendered tiles, and the rule `../styles/components.css`
 * declares for that markup, read from disk with the `import.meta.url`
 * convention `../tokens/tokens.test.ts` documents. The path is joined with
 * `node:path` because under happy-dom the global `URL` is the DOM's, which
 * Node's `fileURLToPath` rejects.
 * ---------------------------------------------------------------------------
 */

/** The component stylesheet, comments removed so a commented rule cannot match. */
const COMPONENT_STYLESHEET = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'components.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//gu, '');

/** One top-level rule of the stylesheet: its selector list and its declarations. */
interface StyleRule {
  readonly selectors: readonly string[];
  readonly declarations: readonly string[];
}

/**
 * The stylesheet's top-level rules. A rule nested in an at-rule splits into
 * more than two parts at its braces and is left out, which is sound here: every
 * rule this block reads is a top-level one.
 */
const STYLE_RULES: readonly StyleRule[] = COMPONENT_STYLESHEET.split('}')
  .map((chunk) => chunk.split('{'))
  .filter((parts): parts is [string, string] => parts.length === 2)
  .map(([selectorText, body]) => ({
    selectors: selectorText
      .split(',')
      .map((selector) => selector.trim())
      .filter((selector) => selector !== ''),
    declarations: body
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration !== ''),
  }));

/**
 * Every declaration the stylesheet gives one selector, across all the rules
 * whose selector list names it exactly.
 *
 * @param selector The selector as written in the stylesheet.
 * @returns The declarations, in stylesheet order.
 */
function declarationsFor(selector: string): readonly string[] {
  return STYLE_RULES.filter((rule) => rule.selectors.includes(selector)).flatMap(
    (rule) => rule.declarations,
  );
}

describe('MetricCards tile presentation', () => {
  it('draws an unavailable tile in a shape of its own, not only in the muted colour', async () => {
    // A measured zero duration is muted too: the fast-duration token is the
    // muted text colour. So the unavailable tile must differ in shape — a
    // dashed edge and an italic figure — and the zero must not.
    const stub = resolvingProvider([
      makeDuration('frontend_duration', 0),
      makeMetric('transferred_bytes', { unit: 'bytes', value: undefined, note: COVERAGE_NOTE }),
    ]);

    renderCards(makeNode(['frontend_duration', 'transferred_bytes']), {
      provider: stub.provider,
    });

    const cards = await findCards(2);
    const zero = cardAt(cards, 0);
    const absent = cardAt(cards, 1);
    const zeroParts = formatDurationParts(0);

    // The zero is a measurement: its figure and unit, the fast severity, and
    // no unavailable state. The absence carries the state and nothing else.
    expect(isUnavailable(zero)).toBe(false);
    expect(textOf(zero, 'value')).toBe(zeroParts.value);
    expect(severityStyleOf(zero)).toContain(durationColorVar(0));
    expect(isUnavailable(absent)).toBe(true);
    expect(textOf(absent, 'value')).toBe(NOT_AVAILABLE_LABEL);

    // And the state's rules change the shape as well as the colour.
    expect(declarationsFor('.dg-metric-card.dg-is-unavailable')).toContain('border-style: dashed');
    expect(declarationsFor('.dg-metric-card.dg-is-unavailable .dg-metric-card__value')).toEqual(
      expect.arrayContaining(['color: var(--dg-text-muted)', 'font-style: italic']),
    );
  });

  it('holds each heading at the top of its tile and its figure at the bottom', async () => {
    // A heading that wraps onto a second line must not lower its own figure
    // below the figures of the tiles beside it in the same grid row.
    const stub = resolvingProvider([
      makeMetric('render_count', { value: RENDER_COUNT, label: RENDER_COUNT_LABEL }),
      makeMetric('render_trigger_unknown_count', {
        value: UNKNOWN_TRIGGER_RENDERS,
        label: UNKNOWN_TRIGGER_LABEL,
      }),
    ]);

    renderCards(makeNode(['render_count', 'render_trigger_unknown_count']), {
      provider: stub.provider,
    });

    for (const card of await findCards(2)) {
      // Two children: the heading first, the figure's group last.
      expect(card.children).toHaveLength(2);
      expect(card.firstElementChild).toBe(partOf(card, 'label'));
      expect(card.lastElementChild?.contains(partOf(card, 'value'))).toBe(true);
    }

    for (const selector of ['.dg-metric-card', '.dg-metric-cards__card']) {
      expect(declarationsFor(selector)).toEqual(
        expect.arrayContaining(['flex-direction: column', 'justify-content: space-between']),
      );
    }
  });

  it("says under each tier duration's heading what kind of time it is, and keeps its figure at the bottom", async () => {
    // The tier durations are wall-clock spans with overlapping work counted
    // once; a dependency graph beside them sums its participants' records.
    // Without the qualifier, a database participant showing more time than the
    // database tile reads as a contradiction.
    const durations: readonly MetricId[] = [
      'total_duration',
      'frontend_duration',
      'backend_duration',
      'database_duration',
    ];
    const stub = resolvingProvider([
      ...durations.map((id, index) => makeDuration(id, FAST_MS + index)),
      makeMetric('render_count', { value: RENDER_COUNT, label: RENDER_COUNT_LABEL }),
    ]);

    renderCards(makeNode([...durations, 'render_count']), { provider: stub.provider });

    const cards = await findCards(5);
    for (const [index, id] of durations.entries()) {
      const card = cardAt(cards, index);
      const qualifier = DURATION_QUALIFIERS[id] ?? '';
      const headingBlock = card.firstElementChild;
      const figure = durationFigure(FAST_MS + index);

      // Still two children — the heading block and the figure row — so the
      // tile's space-between keeps the figure level with its neighbours'.
      expect(card.children).toHaveLength(2);
      expect(card.lastElementChild?.contains(partOf(card, 'value'))).toBe(true);

      // The heading element holds the heading alone; the qualifier follows it,
      // inside the same heading block, in the smaller muted role.
      if (!(headingBlock instanceof HTMLElement)) {
        throw new Error(`the ${id} tile rendered no heading block`);
      }
      const label = partOf(card, 'label');
      expect(headingBlock.contains(label)).toBe(true);
      expect(textOf(card, 'label')).toBe(humanizeLabel(id));
      const qualifierLine = within(headingBlock).getByText(qualifier);
      expect(label?.contains(qualifierLine)).toBe(false);
      expect(
        (label?.compareDocumentPosition(qualifierLine) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(qualifierLine.classList.contains('dg-text--xs')).toBe(true);
      expect(qualifierLine.classList.contains('dg-text--muted')).toBe(true);
      expect(qualifierLine.getAttribute('style')).toBeNull();

      // And a screen reader hears it with the heading.
      expect(card.getAttribute('aria-label')).toBe(
        `${humanizeLabel(id)} (${qualifier}): ${figure.value} ${figure.unit}`,
      );
    }
    expect(new Set(durations.map((id) => DURATION_QUALIFIERS[id])).size).toBe(durations.length);

    // A count is no span of time: no qualifier, and its heading stays the
    // tile's first child exactly as before.
    const count = cardAt(cards, 4);
    expect(count.firstElementChild).toBe(partOf(count, 'label'));
    expect(count.textContent).not.toMatch(/wall clock/u);
    expect(count.getAttribute('aria-label')).toBe(
      `${RENDER_COUNT_LABEL}: ${formatCount(RENDER_COUNT)}`,
    );
  });

  it('qualifies a duration tile even when its value is absent or off the page', async () => {
    const stub = resolvingProvider([makeDuration('total_duration', FAST_MS)]);

    renderCards(makeNode(['total_duration', 'database_duration']), { provider: stub.provider });

    // A complete read that did not find the database duration: still the same
    // measure, so still the same qualifier, beside the absent figure.
    const absent = cardAt(await findCards(2), 1);
    expectNotComputed(absent, 'database_duration');
    expect(absent.textContent).toContain(DURATION_QUALIFIERS.database_duration);
    expect(absent.getAttribute('aria-label')).toBe(
      `${namedHeading('database_duration', humanizeLabel('database_duration'))}: ${NOT_AVAILABLE_LABEL}`,
    );
  });

  it('spans each state box across every track of the tile grid', async () => {
    const stub = resolvingProvider([]);

    renderCards(makeNode(['total_duration']), { provider: stub.provider });

    // The empty state sits in its box, which is an item of the tile grid.
    const message = await screen.findByText(NOTHING_COMPUTED);
    const box = message.parentElement?.parentElement;
    expect(box?.classList.contains('dg-metric-cards__empty')).toBe(true);
    expect(box?.parentElement?.classList.contains('dg-metric-cards')).toBe(true);

    // The tile grid names the lines before its first track and after its
    // last, whatever number of tracks `auto-fit` settles on, and each state box
    // spans from one to the other.
    const template = declarationsFor('.dg-metric-cards')
      .find((declaration) => declaration.startsWith('grid-template-columns:'))
      ?.replace(/\s+/gu, ' ');
    expect(template).toMatch(
      /^grid-template-columns: \[full-start\] repeat\( ?auto-fit, .+\) \[full-end\]$/u,
    );
    for (const state of ['empty', 'loading', 'error']) {
      expect(declarationsFor(`.dg-metric-cards__${state}`)).toContain('grid-column: full');
    }

    // A column box whose state grows to fill it, so the copy is centred in the
    // node rather than shrink-wrapped at its inline start.
    expect(declarationsFor('.dg-metric-cards__empty')).toContain('flex-direction: column');
    expect(declarationsFor('.dg-metric-cards__empty > .dg-empty-state')).toContain('flex: auto');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Direction controls in a tile's heading
 *
 * A tile's heading and note arrive over the wire with the value, and an
 * invisible right-to-left override (U+202E) in one of them would draw the
 * characters after it backwards. The heading is printed through `Text`, and
 * the tile's name is written onto its raw `<li>` — both must print each
 * control as its visible escape (`\u202E`), so what is announced is what is
 * shown.
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
 * @param root The rendered container.
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

describe('MetricCards direction controls', () => {
  it('reveals a heading and a note in the tile, its tooltip and its name', async () => {
    const label = `Requests ${RLO}</li><script>alert(7)</script>${PDF}`;
    const note = `Counted ${RLO}once${PDF}.`;
    const container = renderCards(makeNode(['request_count']), {
      provider: resolvingProvider([makeMetric('request_count', { label, value: 3, note })])
        .provider,
    });

    const [card] = await findCards(1);
    if (card === undefined) {
      throw new Error('no tile was rendered');
    }

    // The heading shows the marker where the control was, and the tile is named
    // with the same revealed heading.
    expect(textOf(card, 'label')).toBe(formatUntrustedText(label));
    expect(card.getAttribute('aria-label')).toBe(`${formatUntrustedText(label)}: 3`);
    expect(card.getAttribute('aria-label')).toContain(RLO_MARKER);
    expect(within(card).getByRole('tooltip', { hidden: true }).textContent).toBe(
      formatUntrustedText(note),
    );

    // Nothing a reader sees, hovers or hears carries a raw control, and the
    // markup in the heading is only text.
    expect(rawDirectionSinks(container)).toEqual([]);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });
});
