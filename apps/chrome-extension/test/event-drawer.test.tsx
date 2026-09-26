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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import type { DataQuery, EventRef } from '@debuggen/panel-schema';
import type { DataResultFor, TelemetryEvent } from '@debuggen/protocol';
import { DebuggenError } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';

import { EventDrawer } from '../src/panel/App';
import type { EventDrawerProps } from '../src/panel/App';
import type { DevtoolsPanelActions } from '../src/panel/actions';
import {
  createPanelDataProvider,
  EVENT_RESOLUTION_MAX_EVENTS,
  EVENT_RESOLUTION_PAGE_BUDGET,
} from '../src/panel/data-provider';
import type { PanelDataRequestFunction } from '../src/panel/data-provider';

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
  const state: DrawerState = { shownSession: SESSION_A, handler: servingFrom(capture) };
  const request: PanelDataRequestFunction = (_kind, payload, options) => {
    sent.push({ payload, signal: options?.signal });
    return state.handler(payload);
  };
  const provider = createPanelDataProvider({
    request,
    getSessionId: () => state.shownSession,
    getCaptureId: () => CAPTURE_ID,
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

/** The props of one render: the harness's provider, no tail, session A. */
function drawerProps(harness: DrawerHarness, overrides: Partial<EventDrawerProps> = {}) {
  return {
    selected: { eventId: TARGET.id },
    liveTail: [],
    actions: createActions(),
    dataProvider: harness.provider,
    sessionId: SESSION_A,
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

/*
 * ===========================================================================
 * Reaching any stored event (FE-F07, PERF-F22)
 * ===========================================================================
 */

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

/*
 * ===========================================================================
 * An incomplete chain is stated, never dropped (FE-F07)
 * ===========================================================================
 */

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
