/**
 * `components/MetricCards` — the colocated suite for the `metricCards` node.
 *
 * ## What this suite is protecting
 *
 * `MetricCards` is one of only three components that recur across otherwise
 * dissimilar panels (AAP 0.6.5, with the summary header and the source chip): a
 * slow-interaction panel opens with the per-tier durations, a re-render panel
 * with the render counts, a duplicate-request panel with the request counts, and
 * **the same component draws all three**. The only thing that differs between
 * them is the node's `metrics` option, so three of the cases below are the
 * mechanical proof of that mechanism rather than tests of pixels:
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
 *     node's own, unmodified (AAP 0.2.3 — "`metrics` kept as the node's
 *     option").
 *
 * Alongside those, AAP 0.8.3 asks every component suite in this folder for the
 * three states of a query-backed view — loading, empty and error — and for the
 * click-to-source payload. The first three are driven through a stub
 * `DataProvider` that respectively never settles, resolves an empty page and
 * rejects.
 *
 * **On the click-to-source case, which this suite deliberately substitutes
 * for** (so a reader does not think it was forgotten): a metric is an aggregate
 * of the whole capture, `MetricValue` carries no source location and no event
 * reference, and the component imports no `PanelActions`. There is therefore no
 * payload to assert. Its place is taken by the two properties that matter here
 * instead:
 *
 *   - **the absent-label contract** (AAP 0.6.6): an unobservable value renders
 *     the package's own {@link NOT_AVAILABLE_LABEL} — never `0`, never a blank
 *     tile — and carries no unit and no severity colour, because an absence
 *     dressed as a measurement is a fabricated observation. The label is
 *     imported rather than spelled out anywhere below, so a change to the
 *     product's spelling of absence cannot pass this suite unnoticed;
 *   - **no fabricated interaction**: the group holds no control tied to a tile
 *     value, and clicking a tile raises nothing on a host's actions, which is
 *     what stops a click from having to invent a target.
 *
 * The remaining cases pin the two render-trigger metrics apart
 * (`unchanged_render_count` versus `render_trigger_unknown_count`, AAP 0.2.3 —
 * an unevaluated render is not an unnecessary one, and nothing may show their
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
 *     it receives is recorded in an array the cases assert on.
 *   - **In-file synthetic builders, no fixture files**: {@link makeMetric} and
 *     {@link makeNode}, both taking overrides.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4). Metric ids are the
 *     product's own closed vocabulary and belong here; every label and note
 *     below is product prose naming no application, demonstration or
 *     otherwise. `METRIC_IDS` is deliberately **not** imported as a runtime
 *     value — the component may not read it and neither may its test, so the
 *     ids a case needs are written out.
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

import type { DataQuery, MetricCardsNode } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import type { MetricId, MetricUnit, MetricValue } from '@debuggen/telemetry';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DataProviderContext, createDataProvider } from '../host/DataProvider';
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
  formatBytes,
  formatCount,
  formatDurationParts,
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
 * Generic by construction (AAP 0.5.4): these are the kind of sentences the
 * aggregate layer writes about coverage, and they name no inspected project.
 */
const COVERAGE_NOTE = 'Reported for same-origin responses only.';
const TOTAL_DURATION_LABEL = 'Total duration';
const RENDER_COUNT_LABEL = 'Renders';
const UNCHANGED_RENDERS_LABEL = 'Renders with stable inputs';
const UNKNOWN_TRIGGER_LABEL = 'Renders with an undetermined trigger';

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
 * `metrics` sits on the node and **never inside `query`** (AAP 0.2.3): the
 * renderer reads the id list from the node, and a `metrics` tidied under the
 * query would leave the node parsing while rendering nothing. One case below
 * asserts that shape directly.
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
 * implementation for: the code it carries is what the error state renders
 * (AAP 0.5.5).
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
      <PanelActionsContext.Provider value={actions}>
        <MetricCards node={node} className={className} />
      </PanelActionsContext.Provider>
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

    // Nothing is drawn yet: no group, therefore no tiles, and above all no
    // empty state — an unsettled query is not an answer (AAP 0.5.5).
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
    // project (AAP 0.5.4).
    const message = await screen.findByText(/no metrics were computed/i);

    expect(message.classList.contains('dg-empty-state__message')).toBe(true);
    expect(message.parentElement?.parentElement?.classList.contains('dg-metric-cards__empty')).toBe(
      true,
    );

    // An empty response is a success, so it is drawn as an absence and not as a
    // failure — and not as a row of `n/a` tiles either, since there is no value
    // whose absence could be reported.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
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
    // from its use in another (AAP 0.6.5).
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
    // AAP 0.2.3: normalisation gives this node the implicit
    // `query: { source: "metrics" }` and keeps `metrics` as the node's own
    // option. Both halves are asserted — the shape of the node, and the query
    // the provider actually receives.
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
    // a scalar view of the whole capture has no page to narrow, and a renderer
    // that narrowed the request would be choosing evidence.
    expect(soleQuery(stub)).toEqual({ source: METRICS_SOURCE });
    expect('metrics' in soleQuery(stub)).toBe(false);
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
    // The AAP 0.6.6 gap this component owns: a transfer size is exposed by the
    // browser for same-origin responses only and by a server span not at all.
    // Printing `0` there would turn an absence into an observation.
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
    // outright (AAP 0.6.4).
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

  it('shows a measured byte size as a single figure, since the byte scale has no split', async () => {
    const stub = resolvingProvider([
      makeMetric('transferred_bytes', { unit: 'bytes', value: TRANSFERRED_BYTES_VALUE }),
    ]);

    renderCards(makeNode(['transferred_bytes']), { provider: stub.provider });

    const card = cardAt(await findCards(1), 0);

    expect(isUnavailable(card)).toBe(false);
    expect(textOf(card, 'value')).toBe(formatBytes(TRANSFERRED_BYTES_VALUE));
    expect(partOf(card, 'unit')).toBeNull();
    expect(severityStyleOf(card)).toBeNull();
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
    // AAP 0.2.3: `unchanged_render_count` counts renders whose inputs were
    // provably stable, `render_trigger_unknown_count` counts renders whose
    // trigger could not be evaluated at all. An unevaluated render is not an
    // unnecessary one, so they are never added, grouped or relabelled.
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
      name: `${TOTAL_DURATION_LABEL}: ${duration.value} ${duration.unit}`,
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

    // `Tooltip` always mounts its bubble, so the description is in the
    // accessibility tree even while the bubble is visually closed.
    const bubble = within(card).getByRole('tooltip');

    expect(bubble.textContent).toBe(COVERAGE_NOTE);
    expect((affordance.getAttribute('aria-describedby') ?? '').split(/\s+/u)).toContain(bubble.id);
  });

  it('offers no control tied to a tile value, and raises nothing when a tile is clicked', async () => {
    // This case stands in for the click-to-source payload assertion AAP 0.8.3
    // asks every component suite here for (see the file note): a metric is an
    // aggregate of the whole capture and references no single record, so a
    // clickable tile would have to invent a target — fabricated evidence.
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
