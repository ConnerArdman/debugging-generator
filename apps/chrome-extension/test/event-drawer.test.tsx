/**
 * Unit spec for `EventDrawer` in `../src/panel/App.tsx` — the DevTools panel's
 * right drawer, which resolves the store's selected `EventRef` to a stored
 * event and its parent chain.
 *
 * The drawer is driven over a **real** `createPanelDataProvider`, so what is
 * asserted is the whole path a selection takes: the drawer's lookup, the
 * provider's paged `resolveEvent`, its per-pass budgets, resumption and cache,
 * and the renderer's own wire-to-view mapping of every answer. The guarantees
 * held here:
 *
 * - **Any stored event is reachable.** A traceless selection whose event lies
 *   on the last page of the first pass, with its ancestors on the first page,
 *   renders with its parent chain; one beyond the first pass renders a
 *   "stopped searching" error naming the range read, and its Retry continues
 *   from the first event not read rather than starting over — while a Retry
 *   after a failure starts over.
 * - **Nothing is read that the live tail already answers.** A tail holding
 *   the event and its complete chain sends no request at all.
 * - **A missing chain is never presented as complete, nor silently dropped.**
 *   The details' Parent chain section says why, beside the part of the chain
 *   that is known: an ancestor was never captured (the whole trace was read,
 *   so there is nothing to continue or retry); the ancestry search stopped at
 *   its budget (with the count of stored events read, and a control beneath
 *   the details that continues the search from where it stopped); or the
 *   stored capture could not supply a tail-only event's ancestors (with a
 *   retry that reads the trace again).
 * - **A lookup reads the capture its evidence belongs to.** A selection bound
 *   to a panel sends the panel's id with every page, so it is answered from
 *   that panel's capture while the store shows a newer one — even when the
 *   live tail holds the same event id — and its parent chain is built only
 *   from events of the selected event's own capture: a live-tail event of
 *   another capture that shares the trace and a span id never stands in for a
 *   missing ancestor. An unbound selection is read live. Which binding a
 *   selection gets follows from where it was raised (`drawerEvidencePanel`).
 * - **A lookup never outlives its session.** Changing the session aborts the
 *   earlier lookup's request, and its late answer is never rendered.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom, `@testing-library/react`). The
 * provider's request function is a recording fake serving `events` pages in
 * the service's wire form (`DataResultFor<'events'>`: `total` before paging,
 * `nextOffset` null on the last page) from an in-memory capture, or handing
 * the test a deferred answer; the session and capture getters and the cache
 * predicate read a mutable state. Importing `App.tsx` touches no `chrome.*`
 * API at import time, so nothing is stubbed. Ids are neutral synthetic values
 * (AAP §0.5.4).
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import type { DataQuery, EventRef } from '@debuggen/panel-schema';
import type { DataResultFor, TelemetryEvent } from '@debuggen/protocol';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';

import { drawerEvidencePanel, EventDrawer } from '../src/panel/App';
import type { EventDrawerProps, SelectionProvenance } from '../src/panel/App';
import type { DevtoolsPanelActions } from '../src/panel/actions';
import {
  createPanelDataProvider,
  EVENT_RESOLUTION_MAX_EVENTS,
  EVENT_RESOLUTION_PAGE_BUDGET,
} from '../src/panel/data-provider';
import type { PanelDataProvider, PanelDataRequestFunction } from '../src/panel/data-provider';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/** The payload the provider sends: the session and the normalised query. */
type SentPayload = Parameters<PanelDataRequestFunction>[1];

/** The worker's success answer: the service's wire-form `DataResult`. */
type PanelDataAnswer = Awaited<ReturnType<PanelDataRequestFunction>>;

const SESSION_A = 'session-drawer-a';
const SESSION_B = 'session-drawer-b';
const CAPTURE_ID = 'capture-drawer-1';
const CAPTURE_ID_B = 'capture-drawer-2';

/** The rendered panel: generated from {@link CAPTURE_ID}. */
const PANEL_ID = 'panel-drawer-a';

/** The epoch the synthetic events start at. */
const BASE_TIME_MS = 1_700_000_000_000;

/** A 32-hex-digit trace id for `n`. */
function traceIdOf(n: number): string {
  return n.toString(16).padStart(32, '0');
}

/** A 16-hex-digit span id for `n`. */
function spanIdOf(n: number): string {
  return n.toString(16).padStart(16, '0');
}

/** The trace every selection below belongs to. */
const TRACE_T = traceIdOf(0x7a);

/** What {@link makeEvent} needs to know about one event. */
interface EventSpec {
  readonly id: string;
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly index: number;
}

/** One stored event, complete in every field the persisted schema declares. */
function makeEvent(spec: EventSpec): TelemetryEvent {
  return {
    id: spec.id,
    traceId: spec.traceId,
    spanId: spec.spanId,
    ...(spec.parentSpanId === undefined ? {} : { parentSpanId: spec.parentSpanId }),
    kind: 'interaction',
    name: spec.name,
    startTime: BASE_TIME_MS + spec.index,
    duration: 1,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: 'producer-drawer',
    seq: spec.index,
    sessionId: SESSION_A,
    captureId: CAPTURE_ID,
    ingestSeq: spec.index + 1,
  };
}

/** Root → parent → target within {@link TRACE_T}: the lineage the drawer shows. */
const ROOT = makeEvent({
  id: 'event-root',
  name: 'Synthetic root step',
  traceId: TRACE_T,
  spanId: spanIdOf(1),
  index: 1,
});
const PARENT = makeEvent({
  id: 'event-parent',
  name: 'Synthetic parent step',
  traceId: TRACE_T,
  spanId: spanIdOf(2),
  parentSpanId: spanIdOf(1),
  index: 2,
});
const TARGET = makeEvent({
  id: 'event-target',
  name: 'Synthetic selected step',
  traceId: TRACE_T,
  spanId: spanIdOf(3),
  parentSpanId: spanIdOf(2),
  index: 3,
});

/** `count` root events, each in a trace of its own: the unrelated bulk of a capture. */
function fillerEvents(count: number, from: number): TelemetryEvent[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = from + offset;
    return makeEvent({
      id: `filler-${String(index)}`,
      name: 'Synthetic filler step',
      traceId: traceIdOf(0x1_0000 + index),
      spanId: spanIdOf(0x1_0000 + index),
      index,
    });
  });
}

/** `count` further children of {@link ROOT} in {@link TRACE_T}: a trace too big for one pass. */
function traceSiblings(count: number): TelemetryEvent[] {
  return Array.from({ length: count }, (_, offset) =>
    makeEvent({
      id: `event-sibling-${String(offset)}`,
      name: 'Synthetic sibling step',
      traceId: TRACE_T,
      spanId: spanIdOf(0x100 + offset),
      parentSpanId: spanIdOf(1),
      index: 10 + offset,
    }),
  );
}

/**
 * The service's wire-form answer to an `events` query over an in-memory
 * capture: `filter.traceId` narrows, `limit`/`offset` page, `total` counts
 * before paging and `nextOffset` is `null` on the last page.
 */
function serveEvents(capture: readonly TelemetryEvent[], query: DataQuery): PanelDataAnswer {
  const traceId = query.filter?.traceId;
  const matching =
    traceId === undefined ? capture : capture.filter((event) => event.traceId === traceId);
  const limit = query.limit ?? DATA_QUERY_DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  const items = matching.slice(offset, offset + limit);
  const following = offset + items.length;
  const answer: DataResultFor<'events'> = {
    source: 'events',
    events: items,
    total: matching.length,
    limit,
    offset,
    nextOffset: items.length > 0 && following < matching.length ? following : null,
  };
  return answer;
}

/*
 * ===========================================================================
 * Harness
 * ===========================================================================
 */

/** A promise the test settles by hand. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      settle?.(value);
    },
  };
}

/** One call of the fake request function, as it was made. */
interface SentRequest {
  readonly payload: SentPayload;
  readonly signal: AbortSignal | undefined;
}

/** How the fake request function answers one call. */
type RequestHandler = (payload: SentPayload) => Promise<PanelDataAnswer>;

/** The fake store and connection the provider's getters read, mutable mid-test. */
interface DrawerState {
  shownSession: string | undefined;
  /** The capture the store shows: `getCaptureId()`'s answer. */
  captureId: string | undefined;
  handler: RequestHandler;
}

interface DrawerHarness {
  readonly provider: EventDrawerProps['dataProvider'];
  readonly sent: SentRequest[];
  readonly state: DrawerState;
}

/** A handler answering every call at once from `capture`. */
function servingFrom(capture: readonly TelemetryEvent[]): RequestHandler {
  return (payload) => Promise.resolve(serveEvents(capture, payload.query));
}

function createDrawerHarness(capture: readonly TelemetryEvent[]): DrawerHarness {
  const sent: SentRequest[] = [];
  const state: DrawerState = {
    shownSession: SESSION_A,
    captureId: CAPTURE_ID,
    handler: servingFrom(capture),
  };
  const request: PanelDataRequestFunction = (_kind, payload, options) => {
    sent.push({ payload, signal: options?.signal });
    return state.handler(payload);
  };
  const provider = createPanelDataProvider({
    request,
    getSessionId: () => state.shownSession,
    getCaptureId: () => state.captureId,
    canServeCached: (sessionId) => sessionId === state.shownSession,
  });
  return { provider, sent, state };
}

/** The drawer's actions, as recording fakes. */
function createActions(): DevtoolsPanelActions {
  return {
    onOpenSource: vi.fn<(location: SourceLocation) => void>(),
    onSelectEvent: vi.fn<(ref: EventRef) => void>(),
    clearSelectedEvent: vi.fn<() => void>(),
  };
}

/**
 * The props of one render: the harness's provider, no tail, session A, and
 * a live (unbound) lookup.
 */
function drawerProps(harness: DrawerHarness, overrides: Partial<EventDrawerProps> = {}) {
  return {
    selected: { eventId: TARGET.id },
    liveTail: [],
    actions: createActions(),
    dataProvider: harness.provider,
    sessionId: SESSION_A,
    panelId: undefined,
    ...overrides,
  } satisfies EventDrawerProps;
}

/** Let every queued promise reaction and the React updates they cause run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** The queries the harness sent, from `from` on. */
function queriesFrom(harness: DrawerHarness, from = 0): DataQuery[] {
  return harness.sent.slice(from).map((request) => request.payload.query);
}

/*
 * The Parent chain section's copy, as `EventDetails` states each lineage the
 * drawer hands it (`ancestry`), and the drawer's own controls beside it.
 */

/** `missing` above the immediate parent: the whole trace was read without an ancestor. */
const NEVER_CAPTURED =
  'An ancestor of this event names a parent span that is not part of the capture, so the chain above it is unknown.';

/** `missing` at the immediate parent. */
const PARENT_NEVER_CAPTURED =
  'This event names a parent span that is not part of the capture, so its ancestors are unknown.';

/** The first item of a partial chain whose gap was never captured. */
const UNKNOWN_ABOVE_NEVER_CAPTURED =
  'Ancestors above this point are unknown: a parent span is not part of the capture.';

/** The first item of a partial chain whose search stopped at its budget. */
const UNKNOWN_ABOVE_STOPPED =
  'Ancestors above this point are unknown: a parent span was not among the events read.';

/** Any `incomplete` statement, whatever its count. */
const ANY_SEARCH_STOPPED =
  / was not among the .*stored events? of this trace that w(?:as|ere) read/u;

/** The label of the span id a partial chain stops at. */
const MISSING_SPAN_LABEL = 'Missing span ID';

/** `loading`: announced while the ancestry lookup runs. */
const SEARCHING = 'Loading the parent chain…';

/** `error`: the stored capture could not supply a tail-only event's ancestors. */
const UNAVAILABLE = 'Could not load the parent chain';

/** The drawer's control beneath the details that continues a stopped ancestry search. */
const CONTINUE_LABEL = 'Continue the ancestry search';

/** The retry action of a failed lookup, the renderer `ErrorState`'s own label. */
const RETRY_LABEL = 'Retry';

/**
 * The `incomplete` statement for an ancestry search that stopped after reading
 * `eventsRead` stored events of the trace without finding a parent span above
 * the immediate parent — the count grouped as the drawer groups it.
 */
function searchStopped(eventsRead: number): string {
  const count = new Intl.NumberFormat(undefined, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(eventsRead);
  return `A parent span further up the chain was not among the ${count} stored events of this trace that were read, so the chain above it is not shown.`;
}

/** The drawer's Parent chain section — rendered for every shown event. */
function parentChainRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Parent chain' });
}

/** Assert that the Parent chain section states no gap, no wait and no failure. */
function expectNoChainGap(): void {
  for (const statement of [
    NEVER_CAPTURED,
    PARENT_NEVER_CAPTURED,
    ANY_SEARCH_STOPPED,
    SEARCHING,
    UNAVAILABLE,
  ]) {
    expect(screen.queryByText(statement)).toBeNull();
  }
  expect(screen.queryByRole('button', { name: CONTINUE_LABEL })).toBeNull();
}

/**
 * Wait for the parent chain to render, and assert that the Parent chain
 * section lists the root and the parent — as buttons, since the drawer passes
 * a selection handler — and states no gap.
 */
async function renderedChain(): Promise<void> {
  await screen.findByRole('button', { name: /Synthetic root step/u });
  const region = parentChainRegion();
  expect(within(region).getByRole('button', { name: /Synthetic root step/u })).toBeTruthy();
  expect(within(region).getByRole('button', { name: /Synthetic parent step/u })).toBeTruthy();
  expectNoChainGap();
}

/**
 * Assert that the Parent chain section shows the captured part of a chain
 * whose root span was never stored or not yet read: the parent, opened by the
 * `marker` saying that the ancestors above it are unknown, and the root's span
 * id as the one the chain stops at — never the root itself.
 */
function expectChainStoppedAtRoot(marker: string): void {
  const region = parentChainRegion();
  expect(within(region).getByText(marker)).toBeTruthy();
  expect(within(region).getByRole('button', { name: /Synthetic parent step/u })).toBeTruthy();
  expect(within(region).queryByRole('button', { name: /Synthetic root step/u })).toBeNull();
  expect(within(region).getByText(MISSING_SPAN_LABEL).parentElement?.textContent).toContain(
    ROOT.spanId,
  );
}

afterEach(() => {
  cleanup();
});

describe('EventDrawer — resolving a selection against the stored capture', () => {
  it('shows a traceless selection on the first pass’s last page with its ancestors from page one', async () => {
    // The target is the 50 000th stored event: on the page at offset 45 000.
    const capture = [ROOT, PARENT, ...fillerEvents(EVENT_RESOLUTION_MAX_EVENTS - 3, 1_000), TARGET];
    const harness = createDrawerHarness(capture);

    render(<EventDrawer {...drawerProps(harness)} />);

    await renderedChain();
    expect(screen.getByText('Synthetic selected step', { selector: 'p' })).toBeTruthy();
    expect(harness.sent).toHaveLength(EVENT_RESOLUTION_PAGE_BUDGET + 1);
    expect(harness.sent[EVENT_RESOLUTION_PAGE_BUDGET - 1]?.payload.query).toEqual({
      source: 'events',
      limit: DATA_QUERY_MAX_LIMIT,
      offset: 45_000,
    });
    expect(harness.sent[EVENT_RESOLUTION_PAGE_BUDGET]?.payload.query).toEqual({
      source: 'events',
      filter: { traceId: TRACE_T },
      limit: DATA_QUERY_MAX_LIMIT,
      offset: 0,
    });
  });

  it('names the range read when the find pass stops, and Retry continues from the next event', async () => {
    const capture = [...fillerEvents(EVENT_RESOLUTION_MAX_EVENTS, 1_000), ROOT, PARENT, TARGET];
    const harness = createDrawerHarness(capture);

    render(<EventDrawer {...drawerProps(harness)} />);

    expect(
      await screen.findByText(
        "The search for the selected event read stored events 1–50,000 of this session's stored capture without reaching it, the most this drawer reads at once (50,000); the capture may hold it further on.",
      ),
    ).toBeTruthy();
    expect(screen.getByText('Retry continues the search from stored event 50,001.')).toBeTruthy();
    const sentBefore = harness.sent.length;
    expect(sentBefore).toBe(EVENT_RESOLUTION_PAGE_BUDGET);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await renderedChain();
    expect(queriesFrom(harness, sentBefore)).toEqual([
      { source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset: EVENT_RESOLUTION_MAX_EVENTS },
    ]);
  });

  it('restarts the lookup from the first stored event when Retry follows a failure', async () => {
    const capture = [...fillerEvents(EVENT_RESOLUTION_MAX_EVENTS, 1_000), ROOT, PARENT, TARGET];
    const harness = createDrawerHarness(capture);
    render(<EventDrawer {...drawerProps(harness)} />);
    await screen.findByText('Retry continues the search from stored event 50,001.');

    // The continued search fails: its page cannot be read.
    harness.state.handler = () =>
      Promise.reject(new DebuggenError('STORE_ERROR', 'The capture could not be read.'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('The capture could not be read.')).toBeTruthy();

    harness.state.handler = servingFrom(capture);
    const sentBefore = harness.sent.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('Retry continues the search from stored event 50,001.');
    expect(queriesFrom(harness, sentBefore)[0]).toEqual({
      source: 'events',
      limit: DATA_QUERY_MAX_LIMIT,
      offset: 0,
    });
  });

  it('sends nothing when the live tail holds the event and its complete chain', async () => {
    const harness = createDrawerHarness([ROOT, PARENT, TARGET]);

    render(
      <EventDrawer
        {...drawerProps(harness, {
          selected: { eventId: TARGET.id, traceId: TRACE_T },
          liveTail: [ROOT, PARENT, TARGET],
        })}
      />,
    );

    await renderedChain();
    await settle();
    expect(harness.sent).toHaveLength(0);
    expectNoChainGap();
  });
});

describe('EventDrawer — an incomplete parent chain', () => {
  it('says that some ancestors were never captured, with nothing to retry', async () => {
    // The root was never stored: the whole trace is read, and it is not there.
    const harness = createDrawerHarness([PARENT, TARGET]);

    render(
      <EventDrawer
        {...drawerProps(harness, { selected: { eventId: TARGET.id, traceId: TRACE_T } })}
      />,
    );

    expect(await screen.findByText(NEVER_CAPTURED)).toBeTruthy();
    expect(screen.getByText('Synthetic selected step', { selector: 'p' })).toBeTruthy();
    // Only the captured part of the chain is listed, never presented as whole.
    expectChainStoppedAtRoot(UNKNOWN_ABOVE_NEVER_CAPTURED);
    // The whole trace was read: there is nothing to continue and nothing to retry.
    expect(screen.queryByRole('button', { name: CONTINUE_LABEL })).toBeNull();
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
    expect(screen.queryByText(ANY_SEARCH_STOPPED)).toBeNull();
  });

  it('says the same of a tail-only event whose stored trace lacks an ancestor', async () => {
    const harness = createDrawerHarness([PARENT, TARGET]);

    render(
      <EventDrawer
        {...drawerProps(harness, { selected: { eventId: TARGET.id }, liveTail: [TARGET] })}
      />,
    );

    expect(await screen.findByText(NEVER_CAPTURED)).toBeTruthy();
    expectChainStoppedAtRoot(UNKNOWN_ABOVE_NEVER_CAPTURED);
    expect(screen.queryByRole('button', { name: CONTINUE_LABEL })).toBeNull();
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
    // The tail named the trace, so the lookup was narrowed to it.
    expect(queriesFrom(harness)[0]).toMatchObject({ filter: { traceId: TRACE_T } });
  });

  it('completes the chain from the stored trace and the live tail together', async () => {
    // The store lacks the root, which the tail has streamed; the tail lacks the
    // parent, which the store holds. Together they are the whole lineage.
    const harness = createDrawerHarness([PARENT, TARGET]);

    render(
      <EventDrawer
        {...drawerProps(harness, { selected: { eventId: TARGET.id }, liveTail: [ROOT, TARGET] })}
      />,
    );

    await renderedChain();
  });

  it('says the ancestry search stopped at its budget, and continues it from where it stopped', async () => {
    // The target opens its trace; the root lies beyond what one ancestry pass
    // reads after the page the target was found on.
    const trace = [
      TARGET,
      PARENT,
      ...traceSiblings(EVENT_RESOLUTION_MAX_EVENTS + DATA_QUERY_MAX_LIMIT),
      ROOT,
    ];
    const harness = createDrawerHarness(trace);

    render(
      <EventDrawer
        {...drawerProps(harness, { selected: { eventId: TARGET.id, traceId: TRACE_T } })}
      />,
    );

    // The find pass's page, then one ancestry pass of its full budget: every
    // stored event of the trace read so far is counted.
    const eventsRead = DATA_QUERY_MAX_LIMIT + EVENT_RESOLUTION_MAX_EVENTS;
    expect(await screen.findByText(searchStopped(eventsRead))).toBeTruthy();
    expectChainStoppedAtRoot(UNKNOWN_ABOVE_STOPPED);
    // A stopped search is not a failure: it continues rather than retries.
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
    const sentBefore = harness.sent.length;
    expect(sentBefore).toBe(EVENT_RESOLUTION_PAGE_BUDGET + 1);

    fireEvent.click(screen.getByRole('button', { name: CONTINUE_LABEL }));
    // While it continues, the event it continues for stays on screen.
    expect(within(parentChainRegion()).getByText(SEARCHING)).toBeTruthy();
    expect(screen.getByText('Synthetic selected step', { selector: 'p' })).toBeTruthy();

    await renderedChain();
    expect(queriesFrom(harness, sentBefore)).toEqual([
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: EVENT_RESOLUTION_MAX_EVENTS + DATA_QUERY_MAX_LIMIT,
      },
    ]);
  });

  it('says the stored capture could not supply a tail-only event’s ancestors, and retries', async () => {
    const harness = createDrawerHarness([ROOT, PARENT, TARGET]);
    harness.state.handler = () =>
      Promise.reject(new DebuggenError('STORE_ERROR', 'The capture could not be read.'));

    render(
      <EventDrawer
        {...drawerProps(harness, { selected: { eventId: TARGET.id }, liveTail: [TARGET] })}
      />,
    );

    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    // The failure is the Parent chain's, with the reason the lookup gave.
    const region = parentChainRegion();
    expect(within(region).getByText(UNAVAILABLE)).toBeTruthy();
    expect(within(region).getByText('The capture could not be read.')).toBeTruthy();
    // The event itself is still shown, from the tail.
    expect(screen.getByText('Synthetic selected step', { selector: 'p' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: CONTINUE_LABEL })).toBeNull();

    harness.state.handler = servingFrom([ROOT, PARENT, TARGET]);
    const sentBefore = harness.sent.length;
    fireEvent.click(within(region).getByRole('button', { name: RETRY_LABEL }));

    await renderedChain();
    // The retry read the stored trace again, from its first event.
    expect(queriesFrom(harness, sentBefore)).toEqual([
      { source: 'events', filter: { traceId: TRACE_T }, limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
    ]);
  });
});

/** The names of {@link NEWER_TAIL}'s events, which no chain of the first capture may list. */
const NEWER_CAPTURE_NAME = /newer-capture/u;

/**
 * The live tail of the newer capture {@link CAPTURE_ID_B}: events of the same
 * trace under the span ids of {@link TARGET}'s parent and root — a parent span
 * that ended after the store moved on is stored under the newer capture.
 */
const NEWER_TAIL: readonly TelemetryEvent[] = [
  { ...ROOT, id: 'event-root-b', name: 'Synthetic newer-capture root', captureId: CAPTURE_ID_B },
  {
    ...PARENT,
    id: 'event-parent-b',
    name: 'Synthetic newer-capture parent',
    captureId: CAPTURE_ID_B,
  },
];

describe('EventDrawer — which capture a lookup reads', () => {
  it('reads the rendered panel’s capture for its evidence while the store shows a newer capture', async () => {
    // Panel A was generated from the first capture; the store has since moved
    // to capture B, whose live tail is empty. The service answers a lookup
    // bound to the panel from the panel's capture, and a live one from B's.
    const panelCapture = [ROOT, PARENT, ...fillerEvents(DATA_QUERY_MAX_LIMIT + 10, 1_000), TARGET];
    const harness = createDrawerHarness([]);
    harness.state.captureId = CAPTURE_ID_B;
    harness.state.handler = (payload) =>
      Promise.resolve(
        serveEvents(payload.query.panelId === PANEL_ID ? panelCapture : [], payload.query),
      );

    render(<EventDrawer {...drawerProps(harness, { panelId: PANEL_ID })} />);

    await renderedChain();
    expect(screen.getByText('Synthetic selected step', { selector: 'p' })).toBeTruthy();
    // The find pass's two capture pages and the ancestry pass's trace page.
    expect(queriesFrom(harness)).toEqual([
      { source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset: 0, panelId: PANEL_ID },
      {
        source: 'events',
        limit: DATA_QUERY_MAX_LIMIT,
        offset: DATA_QUERY_MAX_LIMIT,
        panelId: PANEL_ID,
      },
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: 0,
        panelId: PANEL_ID,
      },
    ]);
  });

  it('keeps a panel-bound lookup bound when the live tail holds the same event', async () => {
    // The tail holds the selection but not its ancestors, so a stored lookup is
    // sent — and an event id the tail also shows does not turn it live.
    const harness = createDrawerHarness([]);
    harness.state.handler = (payload) =>
      Promise.resolve(
        serveEvents(
          payload.query.panelId === PANEL_ID ? [ROOT, PARENT, TARGET] : [],
          payload.query,
        ),
      );

    render(<EventDrawer {...drawerProps(harness, { liveTail: [TARGET], panelId: PANEL_ID })} />);

    await renderedChain();
    expect(queriesFrom(harness)).toEqual([
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: 0,
        panelId: PANEL_ID,
      },
    ]);
  });

  it('never completes a panel event’s chain with a newer capture’s tail events', async () => {
    // Panel A's capture holds the selection and the root, but never stored the
    // parent span. The store has moved to capture B, whose live tail streamed
    // events of the same trace under the parent's and the root's span ids.
    const panelCapture = [ROOT, TARGET];
    const harness = createDrawerHarness([]);
    harness.state.captureId = CAPTURE_ID_B;
    harness.state.handler = (payload) =>
      Promise.resolve(
        serveEvents(payload.query.panelId === PANEL_ID ? panelCapture : NEWER_TAIL, payload.query),
      );

    render(
      <EventDrawer
        {...drawerProps(harness, {
          selected: { eventId: TARGET.id, traceId: TRACE_T },
          liveTail: NEWER_TAIL,
          panelId: PANEL_ID,
        })}
      />,
    );

    expect(await screen.findByText(PARENT_NEVER_CAPTURED)).toBeTruthy();
    expect(screen.getByText('Synthetic selected step', { selector: 'p' })).toBeTruthy();
    // Every page was read from the panel's capture.
    expect(harness.sent.length).toBeGreaterThan(0);
    for (const request of harness.sent) {
      expect(request.payload.query.panelId).toBe(PANEL_ID);
    }
    // Neither of capture B's look-alikes is listed as an ancestor of A's event.
    const region = parentChainRegion();
    expect(within(region).queryByRole('button', { name: NEWER_CAPTURE_NAME })).toBeNull();
    expect(within(region).queryByText(NEWER_CAPTURE_NAME)).toBeNull();
    expect(within(region).getByText(MISSING_SPAN_LABEL).parentElement?.textContent).toContain(
      PARENT.spanId,
    );
  });

  it('never treats a tail event’s chain as complete from another capture’s events', async () => {
    // The tail holds the selection of the first capture beside the second
    // capture's events under its ancestors' span ids: those events do not make
    // the chain complete, so the stored lookup is sent and its chain shown.
    const harness = createDrawerHarness([ROOT, PARENT, TARGET]);

    render(<EventDrawer {...drawerProps(harness, { liveTail: [...NEWER_TAIL, TARGET] })} />);

    await renderedChain();
    expect(queriesFrom(harness)).toEqual([
      { source: 'events', filter: { traceId: TRACE_T }, limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
    ]);
    const region = parentChainRegion();
    expect(within(region).queryByText(NEWER_CAPTURE_NAME)).toBeNull();
  });

  it('names no panel on any page of a live lookup', async () => {
    const harness = createDrawerHarness([ROOT, PARENT, TARGET]);

    render(
      <EventDrawer
        {...drawerProps(harness, { selected: { eventId: TARGET.id, traceId: TRACE_T } })}
      />,
    );

    await renderedChain();
    expect(queriesFrom(harness)).toEqual([
      { source: 'events', filter: { traceId: TRACE_T }, limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
    ]);
  });
});

describe('drawerEvidencePanel — whose evidence a selection is', () => {
  const OTHER_PANEL_ID = 'panel-drawer-b';

  /** A selection of {@link TARGET} raised by the panel `panelId`. */
  function raisedByPanel(panelId: string): SelectionProvenance {
    return { eventId: TARGET.id, origin: 'panel', panelId };
  }

  /** A selection of {@link TARGET} raised by the live tail while it streamed `captureId`. */
  function raisedByTail(captureId: string | undefined): SelectionProvenance {
    return { eventId: TARGET.id, origin: 'live', captureId };
  }

  it('binds a panel-raised selection to that panel, whatever is rendered or streamed now', () => {
    expect(drawerEvidencePanel(TARGET.id, raisedByPanel(PANEL_ID), PANEL_ID, CAPTURE_ID)).toBe(
      PANEL_ID,
    );
    // A newer panel version replaced it and the store moved to another capture.
    expect(
      drawerEvidencePanel(TARGET.id, raisedByPanel(PANEL_ID), OTHER_PANEL_ID, CAPTURE_ID_B),
    ).toBe(PANEL_ID);
    // No panel is rendered any more: the selection is still that panel's evidence.
    expect(drawerEvidencePanel(TARGET.id, raisedByPanel(PANEL_ID), undefined, CAPTURE_ID_B)).toBe(
      PANEL_ID,
    );
  });

  it('reads a tail-raised selection live while its capture is the store’s, whatever panel is rendered', () => {
    expect(
      drawerEvidencePanel(TARGET.id, raisedByTail(CAPTURE_ID), PANEL_ID, CAPTURE_ID),
    ).toBeUndefined();
    expect(
      drawerEvidencePanel(TARGET.id, raisedByTail(CAPTURE_ID), undefined, CAPTURE_ID),
    ).toBeUndefined();
  });

  it('binds a tail-raised selection to the rendered panel once the store shows another capture', () => {
    expect(drawerEvidencePanel(TARGET.id, raisedByTail(CAPTURE_ID), PANEL_ID, CAPTURE_ID_B)).toBe(
      PANEL_ID,
    );
    // With no panel rendered there is nothing to name, and the read stays live.
    expect(
      drawerEvidencePanel(TARGET.id, raisedByTail(CAPTURE_ID), undefined, CAPTURE_ID_B),
    ).toBeUndefined();
  });

  it('reads a selection with no recorded provenance as the rendered panel’s evidence, else live', () => {
    expect(drawerEvidencePanel(TARGET.id, undefined, PANEL_ID, CAPTURE_ID)).toBe(PANEL_ID);
    expect(drawerEvidencePanel(TARGET.id, undefined, undefined, CAPTURE_ID)).toBeUndefined();
  });

  it('ignores provenance recorded for another event', () => {
    const otherEvent = { ...raisedByTail(CAPTURE_ID), eventId: PARENT.id };
    expect(drawerEvidencePanel(TARGET.id, otherEvent, PANEL_ID, CAPTURE_ID)).toBe(PANEL_ID);
    const otherPanelEvent = { ...raisedByPanel(OTHER_PANEL_ID), eventId: PARENT.id };
    expect(drawerEvidencePanel(TARGET.id, otherPanelEvent, undefined, CAPTURE_ID)).toBeUndefined();
  });
});

/**
 * A provider whose every lookup rejects with `cause`, a plain `Error` — the
 * one way a value other than a typed product error can reach the drawer.
 */
function rejectingProvider(cause: Error): PanelDataProvider {
  return {
    query: () => Promise.reject(new DebuggenError('INTERNAL', 'This suite answers no query.')),
    resolveEvent: () => Promise.reject(cause),
    rejectAllPending: () => 0,
    pendingCount: () => 0,
  };
}

describe('EventDrawer — an unexpected lookup failure', () => {
  /**
   * A credential-shaped value, assembled from pieces so that the repository's
   * secret scan does not read this fixture as a committed credential.
   */
  const CREDENTIAL_SHAPED = ['gh', 'p_', 'x'.repeat(36)].join('');
  const PRIVATE_PATH = '/home/dev/.env';
  const PRIVATE_SQL = 'SELECT password FROM users';
  const PRIVATE_TEXT = `${PRIVATE_PATH}: ${PRIVATE_SQL} WHERE token='${CREDENTIAL_SHAPED}'`;
  const FIXED_MESSAGE =
    'The selected event could not be looked up: an unexpected error stopped the lookup in the Debug Generator panel.';
  const FIXED_HINT = 'Retry; if it keeps failing, reopen Chrome DevTools.';

  let consoleWarn: MockInstance;

  beforeEach(() => {
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleWarn.mockRestore();
  });

  /** Whether `text` holds any part of {@link PRIVATE_TEXT}. */
  function leaksPrivateText(text: string): boolean {
    return [PRIVATE_TEXT, PRIVATE_PATH, PRIVATE_SQL, CREDENTIAL_SHAPED].some((part) =>
      text.includes(part),
    );
  }

  /** The panel logged the closed code once, and nothing of the cause. */
  function expectClosedCodeLogged(): void {
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringMatching(/^\[panel\] /u), {
      code: 'INTERNAL',
    });
    expect(leaksPrivateText(JSON.stringify(consoleWarn.mock.calls))).toBe(false);
  }

  it('shows fixed copy with its retry for a selection the tail does not hold', async () => {
    const harness = createDrawerHarness([]);

    render(
      <EventDrawer
        {...drawerProps(harness, { dataProvider: rejectingProvider(new Error(PRIVATE_TEXT)) })}
      />,
    );

    expect(await screen.findByText(FIXED_MESSAGE)).toBeTruthy();
    expect(screen.getByText(FIXED_HINT)).toBeTruthy();
    expect(screen.getByRole('button', { name: RETRY_LABEL })).toBeTruthy();
    expect(leaksPrivateText(document.body.textContent)).toBe(false);
    expectClosedCodeLogged();
  });

  it('states a tail event’s parent chain as unavailable in fixed copy', async () => {
    const harness = createDrawerHarness([]);

    render(
      <EventDrawer
        {...drawerProps(harness, {
          liveTail: [TARGET],
          dataProvider: rejectingProvider(new Error(PRIVATE_TEXT)),
        })}
      />,
    );

    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    const region = parentChainRegion();
    expect(within(region).getByText(FIXED_MESSAGE)).toBeTruthy();
    expect(within(region).getByText(FIXED_HINT)).toBeTruthy();
    // The event itself is still shown, from the tail.
    expect(screen.getByText('Synthetic selected step', { selector: 'p' })).toBeTruthy();
    expect(leaksPrivateText(document.body.textContent)).toBe(false);
    expectClosedCodeLogged();
  });
});

/*
 * ===========================================================================
 * A lookup never outlives its session
 * ===========================================================================
 */

describe('EventDrawer — changing the session', () => {
  it('aborts the earlier lookup and never renders its late answer', async () => {
    const harness = createDrawerHarness([]);
    const answers: Deferred<PanelDataAnswer>[] = [];
    harness.state.handler = () => {
      const answer = createDeferred<PanelDataAnswer>();
      answers.push(answer);
      return answer.promise;
    };
    // The store knows no session yet, so the guard admits either one.
    harness.state.shownSession = undefined;
    const props = drawerProps(harness, { selected: { eventId: TARGET.id, traceId: TRACE_T } });

    const view = render(<EventDrawer {...props} />);
    await settle();
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.payload.sessionId).toBe(SESSION_A);

    view.rerender(<EventDrawer {...props} sessionId={SESSION_B} />);
    await settle();
    expect(harness.sent[0]?.signal?.aborted).toBe(true);
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]?.payload.sessionId).toBe(SESSION_B);

    // The first session's answer arrives late: it must never be shown.
    const stale = { ...TARGET, name: 'Synthetic stale step' };
    answers[0]?.resolve(
      serveEvents(
        [ROOT, PARENT, stale],
        harness.sent[0]?.payload.query ?? {
          source: 'events',
        },
      ),
    );
    await settle();
    expect(screen.queryByText('Synthetic stale step')).toBeNull();
    expect(screen.getByText(/^Loading event details/u)).toBeTruthy();

    answers[1]?.resolve(
      serveEvents([ROOT, PARENT, TARGET], harness.sent[1]?.payload.query ?? { source: 'events' }),
    );
    await renderedChain();
    expect(screen.queryByText('Synthetic stale step')).toBeNull();
  });
});
