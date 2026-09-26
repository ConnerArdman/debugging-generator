/**
 * Unit spec for `../src/panel/data-provider.ts` — the DevTools panel's
 * `DataProvider`, and the drawer's event lookup built on it.
 *
 * Two product guarantees run through that module, and this spec holds them:
 *
 * - **Identical concurrent queries are one request.** Two nodes asking for the
 *   same page of the same session under the same capture while it is
 *   outstanding — a `Timeline` and a `FlameChart` of one trace — share one
 *   port request (and so one HTTP call and one store read), keyed by the
 *   session, the store's capture and the renderer's `stableQueryKey` of the
 *   whole normalised query; the same query under a new capture is a request of
 *   its own. Each caller still settles on its own: its abort rejects only its
 *   own promise, the shared request is aborted only when the last caller has
 *   left, and a timeout, port loss or a failed request rejects every caller.
 *   Nothing settled is cached, so the same query issued afterwards is sent
 *   again.
 * - **A selected event is resolved however far into the capture it lies.** The
 *   drawer's `resolveEvent` pages `events` — within the event's trace when it
 *   is known, across the whole capture until it is found when it is not —
 *   then pages the trace for the ancestry. Each of the two passes has a page
 *   budget of its own; a pass that spends it reports where it stopped,
 *   distinctly from "not in the capture", and a later call resumes it there.
 *   A lookup bound to a rendered panel sends that panel's id with every page
 *   of both passes, so the service answers from that panel's capture. A
 *   bounded trace cache, scoped by session, evidence scope (the lookup's
 *   panel, or for a live lookup the store's capture) and trace, answers only
 *   when it holds the event *and* its complete chain and only while the panel
 *   is authorised for the session (it fails closed, and is emptied on port
 *   loss); a capture change drops only live entries, a switch to another
 *   panel only the other panels'. An abort between pages rejects with the
 *   same failure an aborted query does.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). The provider's request function,
 * port-loss registration, session and capture getters, cache authorisation
 * predicate and logger are recording fakes local to this file, the getters
 * reading a mutable harness state a test changes mid-run exactly as the store
 * would — no `vi.mock`, no port, no network. The request fake either
 * answers each call from an in-memory capture (paging exactly as the service
 * documents: `total` before paging, `nextOffset` null on the last page) or
 * hands the test a deferred answer to settle by hand. Vitest's fake timers
 * drive the timeout. Session, trace, span and event ids are neutral synthetic
 * values (AAP §0.5.4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT } from '@debuggen/panel-schema';
import type { DataQuery } from '@debuggen/panel-schema';
import type { DataResultFor, TelemetryEvent } from '@debuggen/protocol';
import { DebuggenError } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import {
  buildEventParentChain,
  createPanelDataProvider,
  EVENT_RESOLUTION_MAX_EVENTS,
  EVENT_RESOLUTION_PAGE_BUDGET,
  EVENT_TRACE_CACHE_MAX_TRACES,
  panelDataRequestKey,
} from '../src/panel/data-provider';
import type {
  PanelDataDisconnectRegistration,
  PanelDataProvider,
  PanelDataRequestFunction,
} from '../src/panel/data-provider';
import type { PanelPortDisconnectListener } from '../src/panel/state/connection';

/*
 * ===========================================================================
 * Fixtures — neutral, obviously synthetic values
 * ===========================================================================
 */

/** The payload the provider sends: the session and the normalised query. */
type SentPayload = Parameters<PanelDataRequestFunction>[1];

/** The worker's success answer: the service's wire-form `DataResult`. */
type PanelDataAnswer = Awaited<ReturnType<PanelDataRequestFunction>>;

const SESSION_A = 'session-test-a';
const SESSION_B = 'session-test-b';
const CAPTURE_ID = 'capture-test-1';
const CAPTURE_ID_B = 'capture-test-2';

/** The injected timeout, small so the fake clock reaches it in one step. */
const TIMEOUT_MS = 1_000;

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

/** The trace the lookup tests resolve within. */
const TRACE_T = traceIdOf(0x7a);

/** What {@link makeEvent} needs to know about one event. */
interface EventSpec {
  readonly id: string;
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
    name: 'synthetic event',
    startTime: BASE_TIME_MS + spec.index,
    duration: 1,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: 'producer-test',
    seq: spec.index,
    sessionId: SESSION_A,
    captureId: CAPTURE_ID,
    ingestSeq: spec.index + 1,
  };
}

/**
 * `count` root events, each in a trace of its own, numbered from `from` —
 * the unrelated bulk of a capture.
 */
function fillerEvents(count: number, from: number): TelemetryEvent[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = from + offset;
    return makeEvent({
      id: `filler-${String(index)}`,
      traceId: traceIdOf(0x1_0000 + index),
      spanId: spanIdOf(0x1_0000 + index),
      index,
    });
  });
}

/** Root → parent → target within {@link TRACE_T}: the lineage the lookup must rebuild. */
const ROOT = makeEvent({ id: 'event-root', traceId: TRACE_T, spanId: spanIdOf(1), index: 1 });
const PARENT = makeEvent({
  id: 'event-parent',
  traceId: TRACE_T,
  spanId: spanIdOf(2),
  parentSpanId: spanIdOf(1),
  index: 2,
});
const TARGET = makeEvent({
  id: 'event-target',
  traceId: TRACE_T,
  spanId: spanIdOf(3),
  parentSpanId: spanIdOf(2),
  index: 3,
});

/** `count` further children of {@link ROOT} in {@link TRACE_T}: a trace too big for one page. */
function traceSiblings(count: number): TelemetryEvent[] {
  return Array.from({ length: count }, (_, offset) =>
    makeEvent({
      id: `event-sibling-${String(offset)}`,
      traceId: TRACE_T,
      spanId: spanIdOf(0x100 + offset),
      parentSpanId: spanIdOf(1),
      index: 10 + offset,
    }),
  );
}

/** A wire-form `events` answer for a page the test states explicitly. */
function eventsAnswer(
  events: readonly TelemetryEvent[],
  page: { readonly total: number; readonly offset: number; readonly nextOffset: number | null },
): DataResultFor<'events'> {
  return {
    source: 'events',
    events: [...events],
    total: page.total,
    limit: DATA_QUERY_MAX_LIMIT,
    offset: page.offset,
    nextOffset: page.nextOffset,
  };
}

/**
 * The service's answer to an `events` query over an in-memory capture:
 * `filter.traceId` narrows, `limit`/`offset` page, `total` counts before
 * paging and `nextOffset` is `null` on the last page — as the route documents.
 */
function serveEvents(capture: readonly TelemetryEvent[], query: DataQuery): PanelDataAnswer {
  const traceId = query.filter?.traceId;
  const matching =
    traceId === undefined ? capture : capture.filter((event) => event.traceId === traceId);
  const limit = query.limit ?? DATA_QUERY_DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  const items = matching.slice(offset, offset + limit);
  const following = offset + items.length;
  return {
    source: 'events',
    events: items,
    total: matching.length,
    limit,
    offset,
    nextOffset: items.length > 0 && following < matching.length ? following : null,
  };
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
  reject(cause: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  const handlers: { resolve?: (value: T) => void; reject?: (cause: unknown) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    handlers.resolve = resolve;
    handlers.reject = reject;
  });
  return {
    promise,
    resolve: (value) => {
      handlers.resolve?.(value);
    },
    reject: (cause) => {
      handlers.reject?.(cause);
    },
  };
}

/** One call of the fake request function, as it was made. */
interface SentRequest {
  readonly payload: SentPayload;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  /** Settles the call; already resolved when the harness serves a capture. */
  readonly answer: Deferred<PanelDataAnswer>;
}

/** One recorded log call. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A `Logger` that records every call, children included, into one list. */
function createRecordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (more) => createRecordingLogger(entries, { ...bindings, ...more }),
  };
}

/** How a harness is built. */
interface HarnessOptions {
  /**
   * The capture each call is answered from at once. Omitted, every call waits
   * on its deferred answer for the test to settle.
   */
  readonly capture?: readonly TelemetryEvent[] | undefined;
  /** What the store reports as the panel's session; `SESSION_A` by default. */
  readonly shownSession?: string | undefined;
  /**
   * Whether `canServeCached` is injected at all; `true` by default, so the
   * trace cache is usable unless a test withdraws the authorisation.
   */
  readonly injectCanServeCached?: boolean | undefined;
}

/**
 * What the fake store and connection report, read by the injected getters on
 * every call — so a test changes the capture, the shown session or the
 * binding mid-test exactly as the real store would.
 */
interface HarnessState {
  /** `getSessionId()`'s answer. */
  shownSession: string | undefined;
  /** `getCaptureId()`'s answer. */
  captureId: string | undefined;
  /** When set, `getCaptureId()` throws instead of answering. */
  failCaptureRead: boolean;
  /** `canServeCached()`'s answer, when it is injected. */
  canServeCached: boolean;
  /** Every session `canServeCached` was asked about, in order. */
  readonly authorisationChecks: string[];
}

interface Harness {
  readonly provider: PanelDataProvider;
  readonly sent: SentRequest[];
  readonly logs: LogEntry[];
  /** The port-loss listeners currently registered. */
  readonly disconnectListeners: Set<PanelPortDisconnectListener>;
  /** The mutable answers of the injected getters. */
  readonly state: HarnessState;
}

/**
 * Every harness built by the running test. Several tests leave a request
 * deliberately unanswered (with its caller's promise voided); `afterEach`
 * answers each of them, so no provider timeout outlives its test and rejects
 * an abandoned promise while a later test runs.
 */
const liveHarnesses: Harness[] = [];

function createHarness(options: HarnessOptions = {}): Harness {
  const sent: SentRequest[] = [];
  const logs: LogEntry[] = [];
  const disconnectListeners = new Set<PanelPortDisconnectListener>();
  const state: HarnessState = {
    shownSession: 'shownSession' in options ? options.shownSession : SESSION_A,
    captureId: CAPTURE_ID,
    failCaptureRead: false,
    canServeCached: true,
    authorisationChecks: [],
  };
  const { capture } = options;

  const request: PanelDataRequestFunction = (_kind, payload, requestOptions) => {
    const answer = createDeferred<PanelDataAnswer>();
    sent.push({
      payload,
      signal: requestOptions?.signal,
      timeoutMs: requestOptions?.timeoutMs,
      answer,
    });
    if (capture !== undefined) {
      answer.resolve(serveEvents(capture, payload.query));
    }
    return answer.promise;
  };
  const onPortDisconnect: PanelDataDisconnectRegistration = (listener) => {
    disconnectListeners.add(listener);
    return () => {
      disconnectListeners.delete(listener);
    };
  };

  const canServeCached = (sessionId: string): boolean => {
    state.authorisationChecks.push(sessionId);
    return state.canServeCached;
  };
  const provider = createPanelDataProvider({
    request,
    getSessionId: () => state.shownSession,
    getCaptureId: () => {
      if (state.failCaptureRead) {
        throw new Error('The store could not be read.');
      }
      return state.captureId;
    },
    ...(options.injectCanServeCached === false ? {} : { canServeCached }),
    onPortDisconnect,
    timeoutMs: TIMEOUT_MS,
    logger: createRecordingLogger(logs),
  });
  const harness: Harness = { provider, sent, logs, disconnectListeners, state };
  liveHarnesses.push(harness);
  return harness;
}

/** The `index`-th sent request; fails the test when it was never sent. */
function sentAt(harness: Harness, index: number): SentRequest {
  const request = harness.sent[index];
  if (request === undefined) {
    throw new Error(`Expected request #${String(index)} to have been sent.`);
  }
  return request;
}

/** Let every queued promise reaction run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The typed rejection a promise settled with; fails the test when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<DebuggenError> {
  try {
    await promise;
  } catch (cause: unknown) {
    expect(DebuggenError.is(cause)).toBe(true);
    return DebuggenError.from(cause);
  }
  throw new Error('Expected the promise to reject.');
}

/** A trace-filtered `events` query for `traceId`, as a node would carry it. */
function traceQuery(traceId: string): DataQuery & { source: 'events' } {
  return { source: 'events', filter: { traceId }, limit: 50 };
}

afterEach(() => {
  // Answer whatever a test left outstanding with an empty page echoing its own
  // query — settling an already-settled deferred is a no-op — so every shared
  // request settles, clears its timer and resolves its callers.
  for (const harness of liveHarnesses.splice(0)) {
    for (const request of harness.sent) {
      request.answer.resolve(serveEvents([], request.payload.query));
    }
  }
  vi.useRealTimers();
});

describe('createPanelDataProvider — coalescing identical in-flight queries', () => {
  it('sends one request for two concurrent identical queries and resolves both', async () => {
    const harness = createHarness();
    const first = harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    const second = harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    await flush();

    expect(harness.sent).toHaveLength(1);
    expect(harness.provider.pendingCount()).toBe(1);
    expect(sentAt(harness, 0).payload).toEqual({
      sessionId: SESSION_A,
      query: { source: 'events', filter: { traceId: TRACE_T }, limit: 50, offset: 0 },
    });

    sentAt(harness, 0).answer.resolve(
      eventsAnswer([ROOT, PARENT], { total: 2, offset: 0, nextOffset: null }),
    );
    const [one, two] = await Promise.all([first, second]);
    expect(one.data.map((event) => event.id)).toEqual(['event-root', 'event-parent']);
    expect(two.data.map((event) => event.id)).toEqual(['event-root', 'event-parent']);
    expect(one.total).toBe(2);
    expect(two.nextOffset).toBeNull();
    expect(harness.provider.pendingCount()).toBe(0);
  });

  it('treats reordered keys, explicit undefined members and filled-in defaults as the same request', async () => {
    const harness = createHarness();
    void harness.provider.query(SESSION_A, {
      source: 'events',
      filter: { traceId: TRACE_T, minDuration: 5 },
      limit: 50,
    });
    void harness.provider.query(SESSION_A, {
      limit: 50,
      filter: { minDuration: 5, traceId: TRACE_T, component: undefined },
      sort: undefined,
      source: 'events',
    });
    void harness.provider.query(SESSION_A, { source: 'events' });
    void harness.provider.query(SESSION_A, {
      source: 'events',
      limit: DATA_QUERY_DEFAULT_LIMIT,
      offset: 0,
    });
    await flush();

    expect(harness.sent).toHaveLength(2);
    expect(harness.provider.pendingCount()).toBe(2);
  });

  it('keeps a different session, offset or filter a separate request', async () => {
    // The store knows no session, so both sessions pass the guard.
    const harness = createHarness({ shownSession: undefined });
    void harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    void harness.provider.query(SESSION_B, traceQuery(TRACE_T));
    void harness.provider.query(SESSION_A, { ...traceQuery(TRACE_T), offset: 50 });
    void harness.provider.query(SESSION_A, traceQuery(traceIdOf(0x7b)));
    await flush();

    expect(harness.sent).toHaveLength(4);
    expect(harness.sent.map((request) => request.payload.sessionId)).toEqual([
      SESSION_A,
      SESSION_B,
      SESSION_A,
      SESSION_A,
    ]);
    expect(harness.provider.pendingCount()).toBe(4);
  });

  it('keys a request by the quoted session, the quoted capture and the whole normalised query', () => {
    const sent = { source: 'events', filter: { traceId: TRACE_T }, limit: 50, offset: 0 } as const;
    expect(panelDataRequestKey(SESSION_A, CAPTURE_ID, sent)).toBe(
      panelDataRequestKey(SESSION_A, CAPTURE_ID, {
        offset: 0,
        limit: 50,
        filter: { traceId: TRACE_T },
        source: 'events',
      }),
    );
    expect(panelDataRequestKey(SESSION_A, CAPTURE_ID, sent)).not.toBe(
      panelDataRequestKey(SESSION_B, CAPTURE_ID, sent),
    );
    expect(panelDataRequestKey(SESSION_A, CAPTURE_ID, sent)).not.toBe(
      panelDataRequestKey(SESSION_A, CAPTURE_ID_B, sent),
    );
    // An unknown capture is a scope of its own, distinct from a capture id
    // that happens to spell `null`.
    expect(panelDataRequestKey(SESSION_A, undefined, sent)).not.toBe(
      panelDataRequestKey(SESSION_A, 'null', sent),
    );
    // A session or capture id holding the separator cannot imitate another triple.
    expect(panelDataRequestKey('a":{"source', CAPTURE_ID, { source: 'events' })).not.toBe(
      panelDataRequestKey('a', CAPTURE_ID, { source: 'events' }),
    );
    expect(panelDataRequestKey(SESSION_A, 'c":"d', { source: 'events' })).not.toBe(
      panelDataRequestKey(SESSION_A, 'c', { source: 'events' }),
    );
  });

  it('never joins a request opened under another capture of the same session', async () => {
    const harness = createHarness();
    const underA = harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    await flush();

    // A new capture starts: the session is unchanged, the question is not.
    harness.state.captureId = CAPTURE_ID_B;
    const underB = harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    const alsoUnderB = harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    await flush();

    expect(harness.sent).toHaveLength(2);
    expect(harness.provider.pendingCount()).toBe(2);
    expect(sentAt(harness, 1).payload).toEqual(sentAt(harness, 0).payload);

    sentAt(harness, 0).answer.resolve(
      eventsAnswer([ROOT], { total: 1, offset: 0, nextOffset: null }),
    );
    sentAt(harness, 1).answer.resolve(
      eventsAnswer([TARGET], { total: 1, offset: 0, nextOffset: null }),
    );
    expect((await underA).data.map((event) => event.id)).toEqual(['event-root']);
    expect((await underB).data.map((event) => event.id)).toEqual(['event-target']);
    expect((await alsoUnderB).data.map((event) => event.id)).toEqual(['event-target']);
  });

  it('treats a capture it cannot read as unknown: a scope of its own, logged by error name only', async () => {
    const harness = createHarness();
    harness.state.failCaptureRead = true;
    void harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    // A blank capture is unknown too, so it joins the request above.
    harness.state.failCaptureRead = false;
    harness.state.captureId = ' ';
    void harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    harness.state.captureId = CAPTURE_ID;
    void harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    await flush();

    expect(harness.sent).toHaveLength(2);
    const warning = harness.logs.find(
      (entry) =>
        entry.message === 'Reading the panel capture failed; treating the capture as unknown.',
    );
    expect(warning).toMatchObject({ level: 'warn', fields: { error: 'Error' } });
  });

  it('rejects only the caller that aborted, and leaves the shared request running for the other', async () => {
    const harness = createHarness();
    const leaving = new AbortController();
    const aborted = harness.provider.query(SESSION_A, traceQuery(TRACE_T), {
      signal: leaving.signal,
    });
    const staying = harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    await flush();

    leaving.abort();
    const error = await rejectionOf(aborted);
    expect(error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(error.details).toMatchObject({ source: 'events', reason: 'aborted' });
    expect(sentAt(harness, 0).signal?.aborted).toBe(false);
    expect(harness.provider.pendingCount()).toBe(1);

    sentAt(harness, 0).answer.resolve(
      eventsAnswer([TARGET], { total: 1, offset: 0, nextOffset: null }),
    );
    const answer = await staying;
    expect(answer.data.map((event) => event.id)).toEqual(['event-target']);
  });

  it('aborts the shared request when its last caller leaves, and drops the late answer', async () => {
    const harness = createHarness();
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();
    const first = harness.provider.query(SESSION_A, traceQuery(TRACE_T), {
      signal: firstCaller.signal,
    });
    const second = harness.provider.query(SESSION_A, traceQuery(TRACE_T), {
      signal: secondCaller.signal,
    });
    await flush();
    expect(harness.disconnectListeners.size).toBe(1);

    firstCaller.abort();
    expect(sentAt(harness, 0).signal?.aborted).toBe(false);
    secondCaller.abort();
    expect(sentAt(harness, 0).signal?.aborted).toBe(true);
    expect(harness.provider.pendingCount()).toBe(0);
    expect(harness.disconnectListeners.size).toBe(0);
    expect((await rejectionOf(first)).details).toMatchObject({ reason: 'aborted' });
    expect((await rejectionOf(second)).details).toMatchObject({ reason: 'aborted' });

    sentAt(harness, 0).answer.resolve(
      eventsAnswer([TARGET], { total: 1, offset: 0, nextOffset: null }),
    );
    await flush();
    expect(harness.logs.map((entry) => entry.message)).toContain(
      'Dropped a panel-data answer that arrived after its request settled.',
    );
  });

  it('refuses an already-aborted call without joining or sending anything', async () => {
    const harness = createHarness();
    const gone = new AbortController();
    gone.abort();
    const error = await rejectionOf(
      harness.provider.query(SESSION_A, traceQuery(TRACE_T), { signal: gone.signal }),
    );
    expect(error.details).toMatchObject({ reason: 'aborted' });
    expect(harness.sent).toHaveLength(0);
  });

  it('caches nothing settled: the same query after settlement is sent again', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    await harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    await harness.provider.query(SESSION_A, traceQuery(TRACE_T));
    expect(harness.sent).toHaveLength(2);
    expect(harness.provider.pendingCount()).toBe(0);
  });

  it('rejects every subscriber when the shared request times out, and aborts it', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const outcomes = Promise.allSettled([
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sent).toHaveLength(1);
    expect(sentAt(harness, 0).timeoutMs).toBe(TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const settled = await outcomes;
    for (const outcome of settled) {
      expect(outcome.status).toBe('rejected');
      const error = outcome.status === 'rejected' ? DebuggenError.from(outcome.reason) : undefined;
      expect(error?.code).toBe('TRANSPORT_DISCONNECTED');
      expect(error?.details).toMatchObject({ source: 'events', reason: 'timeout' });
      // Nothing private reaches an error: no session id, no filter value.
      expect(JSON.stringify([error?.message, error?.hint, error?.details])).not.toMatch(
        new RegExp(`${SESSION_A}|${TRACE_T}`, 'u'),
      );
    }
    expect(sentAt(harness, 0).signal?.aborted).toBe(true);
    expect(harness.provider.pendingCount()).toBe(0);
  });

  it('rejects every subscriber on port loss and holds the subscription only while requests are in flight', async () => {
    const harness = createHarness();
    expect(harness.disconnectListeners.size).toBe(0);
    const outcomes = Promise.allSettled([
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
    ]);
    await flush();
    expect(harness.disconnectListeners.size).toBe(1);

    const loss = new DebuggenError('TRANSPORT_DISCONNECTED', 'The panel port closed.', {
      details: { reason: 'disconnected' },
    });
    for (const listener of [...harness.disconnectListeners]) {
      listener({ reason: 'disconnected', error: loss });
    }
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe('rejected');
      const error = outcome.status === 'rejected' ? DebuggenError.from(outcome.reason) : undefined;
      expect(error?.message).toBe('The panel port closed.');
      expect(error?.details).toMatchObject({ source: 'events', reason: 'disconnected' });
    }
    expect(harness.disconnectListeners.size).toBe(0);
    expect(harness.provider.pendingCount()).toBe(0);
  });

  it('rejects every subscriber when the request itself fails, keeping the worker’s code', async () => {
    const harness = createHarness();
    const outcomes = Promise.allSettled([
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
    ]);
    await flush();
    sentAt(harness, 0).answer.reject(
      new DebuggenError('SESSION_NOT_FOUND', 'The session is not known to the service.'),
    );
    for (const outcome of await outcomes) {
      const error = outcome.status === 'rejected' ? DebuggenError.from(outcome.reason) : undefined;
      expect(error?.code).toBe('SESSION_NOT_FOUND');
    }
    expect(harness.provider.pendingCount()).toBe(0);
  });

  it('maps the shared answer for each caller, refusing a mismatched one for every caller', async () => {
    const harness = createHarness();
    const outcomes = Promise.allSettled([
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
    ]);
    await flush();
    sentAt(harness, 0).answer.resolve({
      source: 'metrics',
      metrics: [],
      total: 0,
      limit: 50,
      offset: 0,
      nextOffset: null,
    });
    for (const outcome of await outcomes) {
      const error = outcome.status === 'rejected' ? DebuggenError.from(outcome.reason) : undefined;
      expect(error?.code).toBe('PROTOCOL_INVALID_MESSAGE');
    }
  });

  it('counts distinct requests in pendingCount and rejectAllPending, and rejects every caller', async () => {
    const harness = createHarness();
    const outcomes = Promise.allSettled([
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
      harness.provider.query(SESSION_A, traceQuery(TRACE_T)),
      harness.provider.query(SESSION_A, { source: 'events', limit: 10 }),
    ]);
    await flush();
    expect(harness.sent).toHaveLength(2);
    expect(harness.provider.pendingCount()).toBe(2);

    expect(harness.provider.rejectAllPending()).toBe(2);
    const settled = await outcomes;
    expect(settled.map((outcome) => outcome.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
    for (const outcome of settled) {
      const error = outcome.status === 'rejected' ? DebuggenError.from(outcome.reason) : undefined;
      expect(error?.code).toBe('TRANSPORT_DISCONNECTED');
      expect(error?.details).toMatchObject({ reason: 'disconnected' });
    }
    expect(harness.sent.every((request) => request.signal?.aborted === true)).toBe(true);
    expect(harness.provider.pendingCount()).toBe(0);
    expect(harness.provider.rejectAllPending()).toBe(0);
  });
});

/*
 * ===========================================================================
 * The parent chain
 * ===========================================================================
 */

describe('buildEventParentChain', () => {
  it('answers the ancestors root first, and an empty chain for a root', () => {
    expect(buildEventParentChain(TARGET, [TARGET, PARENT, ROOT])).toEqual([ROOT, PARENT]);
    expect(buildEventParentChain(ROOT, [ROOT])).toEqual([]);
  });

  it('answers undefined when an ancestor is missing or the links cycle', () => {
    expect(buildEventParentChain(TARGET, [TARGET, PARENT])).toBeUndefined();
    const looped = makeEvent({
      id: 'event-looped',
      traceId: TRACE_T,
      spanId: spanIdOf(1),
      parentSpanId: spanIdOf(3),
      index: 4,
    });
    expect(buildEventParentChain(TARGET, [looped, PARENT])).toBeUndefined();
  });

  it('never borrows an ancestor from another trace', () => {
    const elsewhere = { ...PARENT, traceId: traceIdOf(0x7b) };
    expect(buildEventParentChain(TARGET, [elsewhere, ROOT])).toBeUndefined();
  });
});

describe('createPanelDataProvider — resolveEvent', () => {
  it('finds an event on the second page of its trace with its ancestors on the first', async () => {
    // Root and parent first, then enough siblings to fill the first page; the
    // target is the 5 001st event of its trace.
    const trace = [ROOT, PARENT, ...traceSiblings(DATA_QUERY_MAX_LIMIT - 2), TARGET];
    const harness = createHarness({ capture: [...fillerEvents(20, 1_000), ...trace] });

    const resolution = await harness.provider.resolveEvent(SESSION_A, {
      eventId: TARGET.id,
      traceId: TRACE_T,
    });

    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') {
      return;
    }
    expect(resolution.event).toEqual(TARGET);
    expect(resolution.chainComplete).toBe(true);
    expect(resolution.budgetExhausted).toBe(false);
    expect(resolution.pagesRead).toBe(2);
    expect(buildEventParentChain(resolution.event, resolution.trace)).toEqual([ROOT, PARENT]);
    expect(harness.sent.map((request) => request.payload.query)).toEqual([
      { source: 'events', filter: { traceId: TRACE_T }, limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: DATA_QUERY_MAX_LIMIT,
      },
    ]);
  });

  it('pages the whole capture for an unknown trace, then pages the trace for the ancestry', async () => {
    // Root and parent lie on the first unfiltered page, the target on the
    // second — which therefore cannot complete its chain on its own.
    const capture = [
      ROOT,
      PARENT,
      ...fillerEvents(DATA_QUERY_MAX_LIMIT + 10, 1_000),
      TARGET,
      ...fillerEvents(5, 20_000),
    ];
    const harness = createHarness({ capture });

    const resolution = await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id });

    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') {
      return;
    }
    expect(resolution.chainComplete).toBe(true);
    expect(resolution.pagesRead).toBe(3);
    expect(buildEventParentChain(resolution.event, resolution.trace)).toEqual([ROOT, PARENT]);
    expect(harness.sent.map((request) => request.payload.query)).toEqual([
      { source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
      { source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset: DATA_QUERY_MAX_LIMIT },
      { source: 'events', filter: { traceId: TRACE_T }, limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
    ]);
  });

  it('skips the trace pass when the page the event was found on already holds its chain', async () => {
    const capture = [...fillerEvents(DATA_QUERY_MAX_LIMIT + 3, 1_000), ROOT, PARENT, TARGET];
    const harness = createHarness({ capture });

    const resolution = await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id });

    expect(resolution).toMatchObject({ status: 'found', chainComplete: true, pagesRead: 2 });
    expect(harness.sent.every((request) => request.payload.query.filter === undefined)).toBe(true);
  });

  it('reports not-found only after every page that could hold the event was read', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, ...fillerEvents(3, 1_000)] });

    await expect(harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id })).resolves.toEqual(
      { status: 'not-found', pagesRead: 1 },
    );
    await expect(
      harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id, traceId: TRACE_T }),
    ).resolves.toEqual({ status: 'not-found', pagesRead: 1 });
  });

  it('reports budget exhaustion distinctly from not-found, with where to resume', async () => {
    // The target lies one event past the most one find pass reads.
    const capture = [...fillerEvents(EVENT_RESOLUTION_MAX_EVENTS, 1_000), TARGET];
    const harness = createHarness({ capture });

    const resolution = await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id });

    expect(resolution).toEqual({
      status: 'budget-exhausted',
      scope: 'capture',
      searchedFrom: 0,
      resumeOffset: EVENT_RESOLUTION_MAX_EVENTS,
      eventsSearched: EVENT_RESOLUTION_MAX_EVENTS,
      pagesRead: EVENT_RESOLUTION_PAGE_BUDGET,
    });
    expect(harness.sent).toHaveLength(EVENT_RESOLUTION_PAGE_BUDGET);
    expect(harness.logs.map((entry) => entry.message)).toContain(
      'Stopped an event lookup at its page budget.',
    );
  });

  it('gives the ancestry pass a budget of its own when the event is found on the find pass’s last page', async () => {
    // Found on the tenth and last page the find pass allows (offset 45 000),
    // its ancestors on the first page, far behind.
    const capture = [ROOT, PARENT, ...fillerEvents(EVENT_RESOLUTION_MAX_EVENTS - 3, 1_000), TARGET];
    const harness = createHarness({ capture });

    const resolution = await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id });

    expect(resolution).toMatchObject({
      status: 'found',
      chainComplete: true,
      budgetExhausted: false,
      pagesRead: EVENT_RESOLUTION_PAGE_BUDGET + 1,
    });
    if (resolution.status !== 'found') {
      return;
    }
    expect(resolution.ancestryResumeOffset).toBeUndefined();
    expect(buildEventParentChain(resolution.event, resolution.trace)).toEqual([ROOT, PARENT]);
    expect(harness.sent).toHaveLength(EVENT_RESOLUTION_PAGE_BUDGET + 1);
    expect(sentAt(harness, EVENT_RESOLUTION_PAGE_BUDGET - 1).payload.query).toEqual({
      source: 'events',
      limit: DATA_QUERY_MAX_LIMIT,
      offset: (EVENT_RESOLUTION_PAGE_BUDGET - 1) * DATA_QUERY_MAX_LIMIT,
    });
    expect(sentAt(harness, EVENT_RESOLUTION_PAGE_BUDGET).payload.query).toEqual({
      source: 'events',
      filter: { traceId: TRACE_T },
      limit: DATA_QUERY_MAX_LIMIT,
      offset: 0,
    });
  });

  it('resumes a find pass from its resumeOffset and reaches an event beyond the first pass', async () => {
    // Ancestors first; the target twelve events past the most one pass reads.
    const capture = [
      ROOT,
      PARENT,
      ...fillerEvents(EVENT_RESOLUTION_MAX_EVENTS + 10, 1_000),
      TARGET,
    ];
    const harness = createHarness({ capture });

    const first = await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id });
    expect(first).toEqual({
      status: 'budget-exhausted',
      scope: 'capture',
      searchedFrom: 0,
      resumeOffset: EVENT_RESOLUTION_MAX_EVENTS,
      eventsSearched: EVENT_RESOLUTION_MAX_EVENTS,
      pagesRead: EVENT_RESOLUTION_PAGE_BUDGET,
    });
    if (first.status !== 'budget-exhausted') {
      return;
    }
    const sentBefore = harness.sent.length;

    const resumed = await harness.provider.resolveEvent(
      SESSION_A,
      { eventId: TARGET.id },
      { resumeFrom: first.resumeOffset },
    );

    expect(resumed).toMatchObject({
      status: 'found',
      chainComplete: true,
      budgetExhausted: false,
      pagesRead: 2,
    });
    if (resumed.status === 'found') {
      expect(buildEventParentChain(resumed.event, resumed.trace)).toEqual([ROOT, PARENT]);
    }
    // The resumed find pass starts where the first stopped; the ancestry pass
    // still reads the trace from its start, where the ancestors lie.
    expect(harness.sent.slice(sentBefore).map((request) => request.payload.query)).toEqual([
      { source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset: EVENT_RESOLUTION_MAX_EVENTS },
      { source: 'events', filter: { traceId: TRACE_T }, limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
    ]);
  });

  it('reports a resumed pass that also stops at its budget with its own range', async () => {
    const capture = [...fillerEvents(2 * EVENT_RESOLUTION_MAX_EVENTS + 1, 1_000), TARGET];
    const harness = createHarness({ capture });

    const resumed = await harness.provider.resolveEvent(
      SESSION_A,
      { eventId: TARGET.id },
      { resumeFrom: EVENT_RESOLUTION_MAX_EVENTS },
    );

    expect(resumed).toEqual({
      status: 'budget-exhausted',
      scope: 'capture',
      searchedFrom: EVENT_RESOLUTION_MAX_EVENTS,
      resumeOffset: 2 * EVENT_RESOLUTION_MAX_EVENTS,
      eventsSearched: EVENT_RESOLUTION_MAX_EVENTS,
      pagesRead: EVENT_RESOLUTION_PAGE_BUDGET,
    });
  });

  it('resumes a trace-scoped find pass, then reads the trace from its start for the ancestry', async () => {
    // The target is the 50 001st event of its trace; its ancestors open it.
    const trace = [ROOT, PARENT, ...traceSiblings(EVENT_RESOLUTION_MAX_EVENTS - 2), TARGET];
    const harness = createHarness({ capture: trace });
    const target = { eventId: TARGET.id, traceId: TRACE_T };

    const first = await harness.provider.resolveEvent(SESSION_A, target);
    expect(first).toEqual({
      status: 'budget-exhausted',
      scope: 'trace',
      searchedFrom: 0,
      resumeOffset: EVENT_RESOLUTION_MAX_EVENTS,
      eventsSearched: EVENT_RESOLUTION_MAX_EVENTS,
      pagesRead: EVENT_RESOLUTION_PAGE_BUDGET,
    });
    const sentBefore = harness.sent.length;

    const resumed = await harness.provider.resolveEvent(SESSION_A, target, {
      resumeFrom: EVENT_RESOLUTION_MAX_EVENTS,
    });

    expect(resumed).toMatchObject({ status: 'found', chainComplete: true, pagesRead: 2 });
    if (resumed.status === 'found') {
      expect(buildEventParentChain(resumed.event, resumed.trace)).toEqual([ROOT, PARENT]);
    }
    expect(harness.sent.slice(sentBefore).map((request) => request.payload.query)).toEqual([
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: EVENT_RESOLUTION_MAX_EVENTS,
      },
      { source: 'events', filter: { traceId: TRACE_T }, limit: DATA_QUERY_MAX_LIMIT, offset: 0 },
    ]);
  });

  it('starts a lookup with a malformed resumeFrom, or an unusable resumeAncestry, at the first event', async () => {
    const harness = createHarness({
      capture: [ROOT, PARENT, TARGET],
      injectCanServeCached: false,
    });
    const options = [
      { resumeFrom: -5 },
      { resumeFrom: 1.5 },
      { resumeFrom: Number.NaN },
      // The continuation's pool does not hold the target: ignored.
      { resumeAncestry: { from: DATA_QUERY_MAX_LIMIT, trace: [ROOT] } },
    ];
    for (const resolveOptions of options) {
      await expect(
        harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id }, resolveOptions),
      ).resolves.toMatchObject({ status: 'found', chainComplete: true });
    }
    expect(harness.sent.map((request) => request.payload.query)).toEqual(
      options.map(() => ({ source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset: 0 })),
    );
  });

  it('reports an ancestry pass stopped at its budget with where to continue, and continues it', async () => {
    // The target and its parent open the trace; the root lies beyond what one
    // ancestry pass reads after the page the target was found on.
    const trace = [
      TARGET,
      PARENT,
      ...traceSiblings(EVENT_RESOLUTION_MAX_EVENTS + DATA_QUERY_MAX_LIMIT),
      ROOT,
    ];
    const harness = createHarness({ capture: trace });
    const target = { eventId: TARGET.id, traceId: TRACE_T };

    const first = await harness.provider.resolveEvent(SESSION_A, target);
    const stoppedAt = EVENT_RESOLUTION_MAX_EVENTS + DATA_QUERY_MAX_LIMIT;
    expect(first).toMatchObject({
      status: 'found',
      chainComplete: false,
      budgetExhausted: true,
      ancestryResumeOffset: stoppedAt,
      pagesRead: EVENT_RESOLUTION_PAGE_BUDGET + 1,
    });
    if (first.status !== 'found' || first.ancestryResumeOffset === undefined) {
      throw new Error('Expected an ancestry pass stopped at its budget.');
    }
    expect(buildEventParentChain(first.event, first.trace)).toBeUndefined();
    // The ancestry pass continued after the find page rather than re-reading it.
    expect(sentAt(harness, 1).payload.query).toMatchObject({ offset: DATA_QUERY_MAX_LIMIT });
    const sentBefore = harness.sent.length;

    const continued = await harness.provider.resolveEvent(SESSION_A, target, {
      resumeAncestry: { from: first.ancestryResumeOffset, trace: first.trace },
    });

    expect(continued).toMatchObject({
      status: 'found',
      chainComplete: true,
      budgetExhausted: false,
      pagesRead: 1,
    });
    if (continued.status === 'found') {
      expect(continued.ancestryResumeOffset).toBeUndefined();
      expect(buildEventParentChain(continued.event, continued.trace)).toEqual([ROOT, PARENT]);
    }
    expect(harness.sent.slice(sentBefore).map((request) => request.payload.query)).toEqual([
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: stoppedAt,
      },
    ]);
  });

  it('answers a complete cache hit without sending anything, for the event and its ancestors', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET, ...fillerEvents(3, 1_000)] });
    await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id, traceId: TRACE_T });
    const sentBefore = harness.sent.length;

    const again = await harness.provider.resolveEvent(SESSION_A, {
      eventId: TARGET.id,
      traceId: TRACE_T,
    });
    const ancestor = await harness.provider.resolveEvent(SESSION_A, { eventId: PARENT.id });

    expect(harness.sent).toHaveLength(sentBefore);
    expect(again).toMatchObject({ status: 'found', chainComplete: true, pagesRead: 0 });
    expect(ancestor).toMatchObject({ status: 'found', chainComplete: true, pagesRead: 0 });
    if (ancestor.status === 'found') {
      expect(ancestor.event).toEqual(PARENT);
    }
  });

  it('re-queries a cached trace that lacks an ancestor, and finds it once the capture holds it', async () => {
    const capture: TelemetryEvent[] = [ROOT, TARGET];
    const harness = createHarness({ capture });

    const partial = await harness.provider.resolveEvent(SESSION_A, {
      eventId: TARGET.id,
      traceId: TRACE_T,
    });
    expect(partial).toMatchObject({ status: 'found', chainComplete: false, pagesRead: 1 });

    capture.push(PARENT);
    const complete = await harness.provider.resolveEvent(SESSION_A, {
      eventId: TARGET.id,
      traceId: TRACE_T,
    });
    expect(complete).toMatchObject({ status: 'found', chainComplete: true, pagesRead: 1 });
    expect(harness.sent).toHaveLength(2);
  });

  it('evicts the least recently used trace beyond the cache bound', async () => {
    const traces = Array.from({ length: EVENT_TRACE_CACHE_MAX_TRACES + 1 }, (_, index) =>
      makeEvent({
        id: `event-trace-${String(index)}`,
        traceId: traceIdOf(0x2_0000 + index),
        spanId: spanIdOf(0x2_0000 + index),
        index,
      }),
    );
    const harness = createHarness({ capture: traces });
    for (const event of traces) {
      await harness.provider.resolveEvent(SESSION_A, { eventId: event.id, traceId: event.traceId });
    }
    const [oldest] = traces;
    const newest = traces.at(-1);
    if (oldest === undefined || newest === undefined) {
      throw new Error('Expected the synthetic traces to exist.');
    }

    const sentBefore = harness.sent.length;
    await harness.provider.resolveEvent(SESSION_A, { eventId: newest.id, traceId: newest.traceId });
    expect(harness.sent).toHaveLength(sentBefore);
    await harness.provider.resolveEvent(SESSION_A, { eventId: oldest.id, traceId: oldest.traceId });
    expect(harness.sent).toHaveLength(sentBefore + 1);
  });

  it('never answers one session from another session’s cached trace', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id, traceId: TRACE_T });
    const sentBefore = harness.sent.length;

    // The panel now shows, and is authorised for, the other session.
    harness.state.shownSession = SESSION_B;
    await harness.provider.resolveEvent(SESSION_B, { eventId: TARGET.id, traceId: TRACE_T });
    expect(harness.sent).toHaveLength(sentBefore + 1);
    expect(sentAt(harness, sentBefore).payload.sessionId).toBe(SESSION_B);
    expect(harness.state.authorisationChecks).toContain(SESSION_B);
  });

  it('never serves a trace cached under one capture once the store shows another, and empties the cache', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target);
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(1);

    harness.state.captureId = CAPTURE_ID_B;
    await expect(harness.provider.resolveEvent(SESSION_A, target)).resolves.toMatchObject({
      status: 'found',
      pagesRead: 1,
    });
    expect(harness.sent).toHaveLength(2);

    // Back to the first capture: its entry went with the switch, so it is
    // asked again rather than answered from what was cached before.
    harness.state.captureId = CAPTURE_ID;
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(3);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        message: 'Dropped cached traces the event drawer can no longer use.',
        fields: { reason: 'capture-changed', count: 1 },
      }),
    );
  });

  it('never caches under an unknown capture', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    harness.state.captureId = undefined;
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target);
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(2);
    expect(harness.disconnectListeners.size).toBe(0);
  });

  it('does not serve the cache, and empties it, while canServeCached answers false', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(1);

    harness.state.canServeCached = false;
    await expect(harness.provider.resolveEvent(SESSION_A, target)).resolves.toMatchObject({
      status: 'found',
      chainComplete: true,
      pagesRead: 1,
    });
    expect(harness.sent).toHaveLength(2);
    expect(harness.state.authorisationChecks).toContain(SESSION_A);

    // Authorised again: the cache was emptied, and the unauthorised lookup
    // recorded nothing, so the service is asked once more.
    harness.state.canServeCached = true;
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(3);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        message: "Emptied the event drawer's trace cache.",
        fields: { reason: 'not-authorised' },
      }),
    );
  });

  it('never serves the cache when canServeCached is not injected', async () => {
    const harness = createHarness({
      capture: [ROOT, PARENT, TARGET],
      injectCanServeCached: false,
    });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target);
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(2);
    expect(harness.disconnectListeners.size).toBe(0);
  });

  it('does not serve the cache, and empties it, while the store shows no session', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target);

    // The tab unbound: the store keeps no session, the specification's own
    // session is still routed — and the service, not the cache, answers.
    harness.state.shownSession = undefined;
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(2);

    harness.state.shownSession = SESSION_A;
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(3);
  });

  it('empties the cache on port loss, holding the subscription only while it has entries', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    expect(harness.disconnectListeners.size).toBe(0);
    await harness.provider.resolveEvent(SESSION_A, target);
    // No request is in flight, but a cached trace keeps the subscription.
    expect(harness.provider.pendingCount()).toBe(0);
    expect(harness.disconnectListeners.size).toBe(1);

    const loss = new DebuggenError('TRANSPORT_DISCONNECTED', 'The panel port closed.', {
      details: { reason: 'disconnected' },
    });
    for (const listener of [...harness.disconnectListeners]) {
      listener({ reason: 'disconnected', error: loss });
    }
    expect(harness.disconnectListeners.size).toBe(0);
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(2);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        message: "Emptied the event drawer's trace cache.",
        fields: { reason: 'port-lost' },
      }),
    );

    // `rejectAllPending` is the same loss when an owner wires the port itself.
    expect(harness.disconnectListeners.size).toBe(1);
    expect(harness.provider.rejectAllPending()).toBe(0);
    expect(harness.disconnectListeners.size).toBe(0);
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(3);
  });

  it('shares each page with an identical concurrent lookup', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const [one, two] = await Promise.all([
      harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id, traceId: TRACE_T }),
      harness.provider.resolveEvent(SESSION_A, { eventId: PARENT.id, traceId: TRACE_T }),
    ]);
    expect(one.status).toBe('found');
    expect(two.status).toBe('found');
    expect(harness.sent).toHaveLength(1);
  });

  it('rejects with the aborted failure when aborted between pages, sending no further page', async () => {
    const harness = createHarness();
    const lookup = new AbortController();
    const resolution = harness.provider.resolveEvent(
      SESSION_A,
      { eventId: TARGET.id, traceId: TRACE_T },
      { signal: lookup.signal },
    );
    await flush();
    const firstPage = sentAt(harness, 0);

    // Registered after the provider's own reaction, so it runs once the page
    // has been handed to the lookup and before the lookup asks for the next.
    void firstPage.answer.promise.then(() => {
      lookup.abort();
    });
    firstPage.answer.resolve(
      eventsAnswer([ROOT, PARENT], {
        total: DATA_QUERY_MAX_LIMIT + 1,
        offset: 0,
        nextOffset: DATA_QUERY_MAX_LIMIT,
      }),
    );

    const error = await rejectionOf(resolution);
    expect(error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(error.details).toMatchObject({
      source: 'events',
      reason: 'aborted',
      offset: DATA_QUERY_MAX_LIMIT,
    });
    expect(harness.sent).toHaveLength(1);
    expect(firstPage.signal?.aborted).toBe(false);
  });

  it('rejects with the aborted failure when aborted during a page, aborting that page', async () => {
    const harness = createHarness();
    const lookup = new AbortController();
    const resolution = harness.provider.resolveEvent(
      SESSION_A,
      { eventId: TARGET.id },
      { signal: lookup.signal },
    );
    await flush();
    lookup.abort();

    const error = await rejectionOf(resolution);
    expect(error.details).toMatchObject({ reason: 'aborted', offset: 0 });
    expect(sentAt(harness, 0).signal?.aborted).toBe(true);
    expect(harness.provider.pendingCount()).toBe(0);
  });

  it('rejects a failed page with its typed error rather than answering empty', async () => {
    const harness = createHarness();
    const resolution = harness.provider.resolveEvent(SESSION_A, {
      eventId: TARGET.id,
      traceId: TRACE_T,
    });
    await flush();
    sentAt(harness, 0).answer.reject(
      new DebuggenError('STORE_ERROR', 'The capture could not be read.'),
    );
    expect((await rejectionOf(resolution)).code).toBe('STORE_ERROR');
  });

  it('guards the session before consulting the cache, and refuses a selection naming no event', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id, traceId: TRACE_T });
    const sentBefore = harness.sent.length;

    expect(
      (await rejectionOf(harness.provider.resolveEvent(undefined, { eventId: TARGET.id }))).code,
    ).toBe('TAB_NOT_BOUND');
    expect(
      (
        await rejectionOf(
          harness.provider.resolveEvent(SESSION_B, { eventId: TARGET.id, traceId: TRACE_T }),
        )
      ).code,
    ).toBe('TAB_NOT_BOUND');
    expect(
      (await rejectionOf(harness.provider.resolveEvent(SESSION_A, { eventId: ' ' }))).code,
    ).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(harness.sent).toHaveLength(sentBefore);
  });
});

describe('createPanelDataProvider — resolveEvent bound to a rendered panel', () => {
  /** The rendered panel the lookups below read the evidence of. */
  const PANEL_A = 'panel-test-a';
  /** A second panel of the same session. */
  const PANEL_B = 'panel-test-b';

  it('sends the panel id with every page of the find and ancestry passes across the capture', async () => {
    const capture = [
      ROOT,
      PARENT,
      ...fillerEvents(DATA_QUERY_MAX_LIMIT + 10, 1_000),
      TARGET,
      ...fillerEvents(5, 20_000),
    ];
    const harness = createHarness({ capture });

    const resolution = await harness.provider.resolveEvent(
      SESSION_A,
      { eventId: TARGET.id },
      { panelId: PANEL_A },
    );

    expect(resolution).toMatchObject({ status: 'found', chainComplete: true, pagesRead: 3 });
    expect(harness.sent.map((request) => request.payload.query)).toEqual([
      { source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset: 0, panelId: PANEL_A },
      {
        source: 'events',
        limit: DATA_QUERY_MAX_LIMIT,
        offset: DATA_QUERY_MAX_LIMIT,
        panelId: PANEL_A,
      },
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: 0,
        panelId: PANEL_A,
      },
    ]);
  });

  it('sends the panel id with every page of both passes within a known trace', async () => {
    // The target opens its trace, so the find pass stops on the first page
    // without the chain; the ancestry pass reads on to the page holding it.
    const trace = [TARGET, ...traceSiblings(DATA_QUERY_MAX_LIMIT), PARENT, ROOT];
    const harness = createHarness({ capture: trace });

    const resolution = await harness.provider.resolveEvent(
      SESSION_A,
      { eventId: TARGET.id, traceId: TRACE_T },
      { panelId: PANEL_A },
    );

    expect(resolution).toMatchObject({ status: 'found', chainComplete: true, pagesRead: 2 });
    if (resolution.status === 'found') {
      expect(buildEventParentChain(resolution.event, resolution.trace)).toEqual([ROOT, PARENT]);
    }
    expect(harness.sent.map((request) => request.payload.query)).toEqual([
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: 0,
        panelId: PANEL_A,
      },
      {
        source: 'events',
        filter: { traceId: TRACE_T },
        limit: DATA_QUERY_MAX_LIMIT,
        offset: DATA_QUERY_MAX_LIMIT,
        panelId: PANEL_A,
      },
    ]);
  });

  it('sends no panel id at all for a live lookup', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    await harness.provider.resolveEvent(SESSION_A, { eventId: TARGET.id, traceId: TRACE_T });
    expect(harness.sent).toHaveLength(1);
    expect('panelId' in sentAt(harness, 0).payload.query).toBe(false);
  });

  it('refuses a blank panel id with PANEL_INVALID, sending nothing and consulting no cache', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A });
    const sentBefore = harness.sent.length;
    const checksBefore = harness.state.authorisationChecks.length;

    for (const panelId of ['', '   ']) {
      const error = await rejectionOf(
        harness.provider.resolveEvent(SESSION_A, target, { panelId }),
      );
      expect(error.code).toBe('PANEL_INVALID');
      // Only that the lookup was panel-bound is stated, never a panel id.
      expect(error.details).toMatchObject({ source: 'events', panelBound: true, panelId: 'blank' });
    }
    expect(harness.sent).toHaveLength(sentBefore);
    // The cache was never asked: its authorisation was not even checked.
    expect(harness.state.authorisationChecks).toHaveLength(checksBefore);
  });

  it('never answers a panel-bound lookup from a live-cached trace', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(1);

    const bound = await harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A });
    expect(bound).toMatchObject({ status: 'found', chainComplete: true, pagesRead: 1 });
    expect(harness.sent).toHaveLength(2);
    expect(sentAt(harness, 1).payload.query).toMatchObject({ panelId: PANEL_A });

    // Each scope now answers from its own entry.
    await expect(
      harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A }),
    ).resolves.toMatchObject({ status: 'found', pagesRead: 0 });
    await expect(harness.provider.resolveEvent(SESSION_A, target)).resolves.toMatchObject({
      status: 'found',
      pagesRead: 0,
    });
    expect(harness.sent).toHaveLength(2);
  });

  it('never answers a live lookup from a panel’s cached trace, with or without its trace', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    await harness.provider.resolveEvent(
      SESSION_A,
      { eventId: TARGET.id, traceId: TRACE_T },
      { panelId: PANEL_A },
    );
    expect(harness.sent).toHaveLength(1);

    // A traceless live lookup walks the cache: the panel's pool must not answer it.
    const traceless = await harness.provider.resolveEvent(SESSION_A, { eventId: PARENT.id });
    expect(traceless).toMatchObject({ status: 'found', pagesRead: 1 });
    expect(harness.sent).toHaveLength(2);
    expect('panelId' in sentAt(harness, 1).payload.query).toBe(false);

    // A traceless lookup of the same panel is answered from that panel's pool.
    await expect(
      harness.provider.resolveEvent(SESSION_A, { eventId: ROOT.id }, { panelId: PANEL_A }),
    ).resolves.toMatchObject({ status: 'found', pagesRead: 0 });
    expect(harness.sent).toHaveLength(2);
  });

  it('never shares a cached trace between two panels', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A });

    const other = await harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_B });
    expect(other).toMatchObject({ status: 'found', pagesRead: 1 });
    expect(harness.sent).toHaveLength(2);
    expect(sentAt(harness, 1).payload.query).toMatchObject({ panelId: PANEL_B });
  });

  it('drops the first panel’s traces when a lookup names another panel, keeping the live ones', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target);
    await harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A });
    await harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_B });
    expect(harness.sent).toHaveLength(3);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        message: 'Dropped cached traces the event drawer can no longer use.',
        fields: { reason: 'panel-changed', count: 1 },
      }),
    );

    // Back to the first panel: its entry went with the switch.
    await expect(
      harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A }),
    ).resolves.toMatchObject({ status: 'found', pagesRead: 1 });
    expect(harness.sent).toHaveLength(4);
    // The live entry was never a panel's, so the switches left it in place.
    await expect(harness.provider.resolveEvent(SESSION_A, target)).resolves.toMatchObject({
      status: 'found',
      pagesRead: 0,
    });
    expect(harness.sent).toHaveLength(4);
  });

  it('keeps a panel’s traces across a capture change, and drops only the live ones', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A });
    await harness.provider.resolveEvent(SESSION_A, target);
    expect(harness.sent).toHaveLength(2);

    // A newer capture starts while the panel stays on screen.
    harness.state.captureId = CAPTURE_ID_B;
    await expect(
      harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A }),
    ).resolves.toMatchObject({ status: 'found', pagesRead: 0 });
    await expect(harness.provider.resolveEvent(SESSION_A, target)).resolves.toMatchObject({
      status: 'found',
      pagesRead: 1,
    });
    expect(harness.sent).toHaveLength(3);
    expect('panelId' in sentAt(harness, 2).payload.query).toBe(false);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        message: 'Dropped cached traces the event drawer can no longer use.',
        fields: { reason: 'capture-changed', count: 1 },
      }),
    );
  });

  it('still fails closed for a panel-bound lookup while canServeCached answers false', async () => {
    const harness = createHarness({ capture: [ROOT, PARENT, TARGET] });
    const target = { eventId: TARGET.id, traceId: TRACE_T };
    await harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A });

    harness.state.canServeCached = false;
    await expect(
      harness.provider.resolveEvent(SESSION_A, target, { panelId: PANEL_A }),
    ).resolves.toMatchObject({ status: 'found', pagesRead: 1 });
    expect(harness.sent).toHaveLength(2);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        message: "Emptied the event drawer's trace cache.",
        fields: { reason: 'not-authorised' },
      }),
    );
  });
});
