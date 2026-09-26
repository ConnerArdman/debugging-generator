/**
 * Tests for the in-flight request snapshot: what `./fetch.ts` reports for a
 * request still on the wire when its capture ends, and when `./agent.ts`
 * reports it.
 *
 * ## Why the snapshot exists
 *
 * A request event is emitted when the request *settles*. A capture boundary —
 * the developer stopping the capture, or the tab moving to the next one —
 * advances the producer generation, and a record from an earlier generation
 * settles in silence so that no capture receives evidence that is not its own
 * (AAP 0.5.1). Before the snapshot, that left a request outstanding at the
 * boundary with no evidence anywhere, and a panel could only guess at it from a
 * missing status code — which a network error, an abort and an opaque response
 * all share. The snapshot is the evidence, and `../aggregate/requests.ts`
 * reads its marker to publish the request as *pending*.
 *
 * ## What these cases pin
 *
 * - **The shape.** One event per outstanding request: the request's own span,
 *   no status code, span status `unset`, and the marker under exactly the key
 *   the aggregate reads — imported from the aggregate here, because the page
 *   bundle may not import it and a one-sided rename would otherwise go
 *   unnoticed.
 * - **Once, and only while outstanding.** A second report emits nothing; a
 *   settled or abandoned request is never reported; after a generation
 *   boundary nothing is reported and the late settle stays silent.
 * - **The ordering at the agent.** The snapshot is only evidence if it reaches
 *   the transport while the ending capture is still configured: before the
 *   transport is disabled at a stop, and before it is re-configured at a
 *   capture change. The transport seam below records both calls in one log
 *   and whether each draft was actually accepted.
 * - **The round trip.** A draft the producer really emitted, completed into a
 *   persisted event, reaches the aggregate as a pending occurrence — and the
 *   settled event of the same span supersedes it.
 *
 * ## How the page is simulated
 *
 * As in `./resource-timing.test.ts`: `fetch` and the three `XMLHttpRequest`
 * prototype methods are replaced with stubs **before** the patch is installed,
 * so the module under test wraps the stub and nothing reaches the network. A
 * stubbed `fetch` answers with a promise the case settles itself, which is how
 * a request is kept on the wire across a boundary. `./transport.ts` is mocked
 * at `emit` and `configureTransport` only, and both forward to the real
 * implementations, so the agent-level cases exercise the real capture gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REQUEST_IN_FLIGHT_ATTRIBUTE, aggregateRequests } from '../aggregate/requests.js';
import { isTelemetryEvent } from '../schema/event.js';
import type { TelemetryEvent } from '../schema/event.js';
import type { EventDraft, TransportConfig } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * The transport seam
 *
 * One ordered log of the two calls whose order is under test. `emit` records
 * the draft, the capture the transport was last configured with, and whether
 * the real transport accepted it — the sequence counter advances exactly when
 * a draft is stamped into a capture — so "reached the transport while the
 * ending capture was live" is observed rather than inferred.
 * ---------------------------------------------------------------------------
 */

/** One call through the mocked seam. */
type SeamEntry =
  | {
      readonly op: 'emit';
      readonly draft: EventDraft;
      /** The capture the last `configureTransport` named, while enabled. */
      readonly capture: string | undefined;
      /** Whether the real transport stamped the draft into a capture. */
      readonly accepted: boolean;
    }
  | { readonly op: 'configure'; readonly config: TransportConfig };

const seam: SeamEntry[] = [];

/** The capture the transport is configured with, as the seam last saw it. */
let configuredCapture: string | undefined;

/** Make the next `emit` throw, once; the case for a contained failure. */
let failNextEmit = false;

vi.mock('./transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport.js')>();
  return {
    ...actual,
    emit: (draft: EventDraft): void => {
      if (failNextEmit) {
        failNextEmit = false;
        throw new TypeError('the transport refuses this draft by design');
      }
      const before = actual.getTransportStats().seq;
      actual.emit(draft);
      const accepted = actual.getTransportStats().seq === before + 1;
      seam.push({ op: 'emit', draft, capture: configuredCapture, accepted });
    },
    configureTransport: (config: TransportConfig): void => {
      seam.push({ op: 'configure', config });
      configuredCapture = config.enabled ? config.captureId : undefined;
      actual.configureTransport(config);
    },
  };
});

const { advanceFetchGeneration, attachFetch, detachFetch, getFetchStats, reportInFlightRequests } =
  await import('./fetch.js');
const { applyConfig } = await import('./agent.js');
const { resetTransport } = await import('./transport.js');
const { getProducerId, newEventId } = await import('./ids.js');

/*
 * ---------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------
 */

/** The response status code key, as the `fetch` vocabulary spells it. */
const STATUS_CODE_ATTRIBUTE = 'http.status_code';

/** The request URL every case issues; invented, and relative as written. */
const ITEMS_URL = '/api/items';

/** The session every agent-level case arms. */
const SESSION_ID = 'ses-in-flight';

/** The capture that ends in every agent-level case. */
const ENDING_CAPTURE = 'cap-in-flight-a';

/** The capture that replaces it in the capture-change case. */
const NEXT_CAPTURE = 'cap-in-flight-b';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** A response the case decides when to deliver. */
interface DeferredResponse {
  readonly promise: Promise<Response>;
  readonly resolve: () => void;
}

/** A `fetch` answer that stays on the wire until `resolve` is called. */
function deferredResponse(): DeferredResponse {
  let settle: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      settle?.(new Response('', { status: 200 }));
    },
  };
}

/** Replace `fetch` with a stub answering each call with the next response. */
function stubFetch(...responses: DeferredResponse[]): void {
  const queue = [...responses];
  globalThis.fetch = vi.fn(() => {
    const next = queue.shift();
    return next === undefined ? new Promise<Response>(() => undefined) : next.promise;
  });
}

/** Every draft emitted so far, in order. */
function emittedDrafts(): EventDraft[] {
  return seam.flatMap((entry) => (entry.op === 'emit' ? [entry.draft] : []));
}

/** Whether a draft is an in-flight snapshot. */
function isSnapshot(draft: EventDraft): boolean {
  return draft.attributes[REQUEST_IN_FLIGHT_ATTRIBUTE] === true;
}

/** The emitted in-flight snapshots, in order. */
function snapshots(): EventDraft[] {
  return emittedDrafts().filter(isSnapshot);
}

/** The single snapshot a case produced, or a failure showing how many there were. */
function onlySnapshot(): EventDraft {
  const found = snapshots();
  expect(found).toHaveLength(1);
  const [draft] = found;
  if (draft === undefined) {
    throw new Error('no in-flight snapshot was emitted');
  }
  return draft;
}

/** The index in the seam of the first entry `predicate` accepts. */
function seamIndex(predicate: (entry: SeamEntry) => boolean): number {
  const index = seam.findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

/** The seam entry of the first in-flight snapshot, with its acceptance record. */
function snapshotEntry(): Extract<SeamEntry, { op: 'emit' }> {
  const entry =
    seam[seamIndex((candidate) => candidate.op === 'emit' && isSnapshot(candidate.draft))];
  if (entry?.op !== 'emit') {
    throw new Error('no in-flight snapshot reached the transport');
  }
  return entry;
}

/** Let the patch's settle handlers run. */
async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * A draft completed into the persisted event shape, exactly as the transport
 * stamps it and the service attributes it — so the aggregate reads the
 * producer's real output rather than a hand-written fixture.
 */
function persistedFrom(draft: EventDraft, ingestSeq: number): TelemetryEvent {
  const event = {
    id: newEventId(),
    traceId: draft.traceId,
    spanId: draft.spanId,
    ...(draft.parentSpanId !== undefined ? { parentSpanId: draft.parentSpanId } : {}),
    kind: draft.kind,
    name: draft.name,
    startTime: draft.startTime,
    duration: draft.duration,
    tier: 'browser',
    attributes: draft.attributes,
    status: draft.status,
    producerId: getProducerId(),
    seq: ingestSeq - 1,
    sessionId: SESSION_ID,
    captureId: ENDING_CAPTURE,
    ingestSeq,
  };
  if (!isTelemetryEvent(event)) {
    throw new Error('the emitted draft does not complete into a persisted event');
  }
  return event;
}

/*
 * ---------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------------
 */

/** The `XMLHttpRequest` methods this file replaces with stubs. */
const STUBBED_XHR_METHODS = ['open', 'send', 'setRequestHeader'] as const;

let originalFetch: typeof globalThis.fetch;
const originalXhrMethods = new Map<string, unknown>();

beforeEach(() => {
  seam.length = 0;
  configuredCapture = undefined;
  failNextEmit = false;
  resetTransport();
  // Frames are not under test here, and no bridge is connected: the agent
  // dispatches nothing on its private channel before a handshake, so nothing a
  // case does leaves the page and nothing reaches the agent's inbound listener.

  originalFetch = globalThis.fetch;
  originalXhrMethods.clear();
  for (const name of STUBBED_XHR_METHODS) {
    originalXhrMethods.set(name, Reflect.get(XMLHttpRequest.prototype, name));
  }
  stubFetch();
  Reflect.set(XMLHttpRequest.prototype, 'open', function stubOpen(): void {
    // The state this module needs is recorded by its own patch.
  });
  Reflect.set(XMLHttpRequest.prototype, 'send', function stubSend(): void {
    // Never settles: no `loadend` is dispatched, so the request stays on the
    // wire for as long as the case needs.
  });
  Reflect.set(XMLHttpRequest.prototype, 'setRequestHeader', function stubSetRequestHeader(): void {
    // Headers are not asserted here.
  });
});

afterEach(() => {
  // Disarm through the agent first, then the module's own teardown, and only
  // then put the platform's methods back underneath both.
  applyConfig({});
  detachFetch();
  resetTransport();
  vi.restoreAllMocks();

  globalThis.fetch = originalFetch;
  for (const [name, method] of originalXhrMethods) {
    Reflect.set(XMLHttpRequest.prototype, name, method);
  }
});

/*
 * ---------------------------------------------------------------------------
 * `./fetch.ts` — the snapshot itself
 * ---------------------------------------------------------------------------
 */

describe('reportInFlightRequests', () => {
  it('reports a request still on the wire as one snapshot of its own span', async () => {
    const response = deferredResponse();
    stubFetch(response);
    attachFetch();

    const call = globalThis.fetch(ITEMS_URL);
    expect(emittedDrafts()).toHaveLength(0);
    const emittedBefore = getFetchStats().emitted;

    expect(reportInFlightRequests()).toBe(1);
    const snapshot = onlySnapshot();
    expect(snapshot.status).toBe('unset');
    expect(snapshot.kind).toBe('fetch');
    expect(STATUS_CODE_ATTRIBUTE in snapshot.attributes).toBe(false);
    expect(snapshot.attributes['url']).toBe(ITEMS_URL);
    expect(snapshot.duration).toBeGreaterThanOrEqual(0);
    // The count is the boundary's to release, and the event was counted.
    expect(getFetchStats().inFlight).toBe(1);
    expect(getFetchStats().emitted).toBe(emittedBefore + 1);

    // Settling in the same generation — nothing ended it here — emits the
    // settled event, which identifies the very span the snapshot described.
    response.resolve();
    await call;
    const settled = emittedDrafts().filter((draft) => !isSnapshot(draft));
    expect(settled).toHaveLength(1);
    expect(settled[0]?.spanId).toBe(snapshot.spanId);
    expect(settled[0]?.traceId).toBe(snapshot.traceId);
    expect(settled[0]?.startTime).toBe(snapshot.startTime);
    expect(settled[0]?.name).toBe(snapshot.name);
  });

  it('writes the marker under exactly the key the aggregate reads', () => {
    attachFetch();
    void globalThis.fetch(ITEMS_URL);

    reportInFlightRequests();

    // The page bundle cannot import the aggregate, so this is the one place the
    // producer's spelling and the consumer's constant meet.
    const { attributes } = onlySnapshot();
    expect(Object.keys(attributes)).toContain(REQUEST_IN_FLIGHT_ATTRIBUTE);
    expect(attributes[REQUEST_IN_FLIGHT_ATTRIBUTE]).toBe(true);
  });

  it('reports each outstanding request once', () => {
    attachFetch();
    void globalThis.fetch(ITEMS_URL);
    void globalThis.fetch(`${ITEMS_URL}/detail`);

    expect(reportInFlightRequests()).toBe(2);
    expect(reportInFlightRequests()).toBe(0);
    expect(snapshots()).toHaveLength(2);
  });

  it('never reports a request that has settled', async () => {
    const response = deferredResponse();
    stubFetch(response);
    attachFetch();

    const call = globalThis.fetch(ITEMS_URL);
    response.resolve();
    await call;

    expect(reportInFlightRequests()).toBe(0);
    expect(snapshots()).toHaveLength(0);
    expect(emittedDrafts()).toHaveLength(1);
  });

  it('never reports a request the host refused to start', () => {
    globalThis.fetch = vi.fn(() => {
      throw new TypeError('the host refuses this request by design');
    });
    attachFetch();

    expect(() => globalThis.fetch(ITEMS_URL)).toThrow(TypeError);
    expect(reportInFlightRequests()).toBe(0);
  });

  it('reports nothing after a capture change, and the late settle stays silent', async () => {
    const response = deferredResponse();
    stubFetch(response);
    attachFetch();
    const call = globalThis.fetch(ITEMS_URL);

    advanceFetchGeneration();

    expect(reportInFlightRequests()).toBe(0);
    response.resolve();
    await call;
    await settleMicrotasks();
    expect(emittedDrafts()).toHaveLength(0);
  });

  it('reports nothing after a detach, and the late settle stays silent', async () => {
    const response = deferredResponse();
    stubFetch(response);
    attachFetch();
    const call = globalThis.fetch(ITEMS_URL);

    detachFetch();

    expect(reportInFlightRequests()).toBe(0);
    response.resolve();
    await call;
    await settleMicrotasks();
    expect(emittedDrafts()).toHaveLength(0);
  });

  it('reports an outstanding XMLHttpRequest the same way', () => {
    attachFetch();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', ITEMS_URL);
    xhr.send();

    expect(reportInFlightRequests()).toBe(1);
    const snapshot = onlySnapshot();
    expect(snapshot.kind).toBe('xhr');
    expect(snapshot.status).toBe('unset');
    expect(STATUS_CODE_ATTRIBUTE in snapshot.attributes).toBe(false);
  });

  it('contains a failure to one snapshot, states it, and reports the rest', () => {
    attachFetch();
    void globalThis.fetch(ITEMS_URL);
    void globalThis.fetch(`${ITEMS_URL}/detail`);
    const failuresBefore = getFetchStats().failures;

    failNextEmit = true;
    expect(() => reportInFlightRequests()).not.toThrow();

    expect(getFetchStats().failures).toBe(failuresBefore + 1);
    expect(snapshots()).toHaveLength(1);
    // The failed record was removed before its emit, so it is not retried.
    expect(reportInFlightRequests()).toBe(0);
  });

  it('reaches the aggregate as a pending occurrence that its settled event supersedes', async () => {
    const response = deferredResponse();
    stubFetch(response);
    attachFetch();
    const call = globalThis.fetch(ITEMS_URL);

    reportInFlightRequests();
    const snapshot = persistedFrom(onlySnapshot(), 1);

    const [pendingGroup] = aggregateRequests([snapshot]);
    expect(pendingGroup?.count).toBe(1);
    expect(pendingGroup?.pendingCount).toBe(1);
    expect(pendingGroup?.statusCodes).toStrictEqual([]);
    expect(pendingGroup?.errorCount).toBe(0);
    expect(pendingGroup?.occurrences[0]?.pending).toBe(true);
    expect(pendingGroup?.occurrences[0]?.eventId).toBe(snapshot.id);

    response.resolve();
    await call;
    const settledDraft = emittedDrafts().find((draft) => !isSnapshot(draft));
    if (settledDraft === undefined) {
      throw new Error('the settled request emitted nothing');
    }
    const settled = persistedFrom(settledDraft, 2);

    const groups = aggregateRequests([snapshot, settled]);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.count).toBe(1);
    expect(group?.duplicateCount).toBe(0);
    expect(group !== undefined && Object.hasOwn(group, 'pendingCount')).toBe(false);
    expect(group?.occurrences[0]?.eventId).toBe(settled.id);
    expect(group?.statusCodes).toStrictEqual([200]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `./agent.ts` — when the snapshot is taken
 * ---------------------------------------------------------------------------
 */

describe('in-flight snapshots at the agent’s capture boundaries', () => {
  it('reports an outstanding request to the capture that is stopping', () => {
    applyConfig({ sessionId: SESSION_ID, captureId: ENDING_CAPTURE, hooks: { network: true } });
    void globalThis.fetch(ITEMS_URL);
    seam.length = 0;

    applyConfig({});

    const entry = snapshotEntry();
    expect(entry.capture).toBe(ENDING_CAPTURE);
    expect(entry.accepted).toBe(true);
    // Before the transport stopped accepting anything: afterwards the snapshot
    // would have been dropped and the stop discards what was queued.
    const disabledAt = seamIndex(
      (candidate) => candidate.op === 'configure' && !candidate.config.enabled,
    );
    expect(seam.indexOf(entry)).toBeLessThan(disabledAt);
    expect(snapshots()).toHaveLength(1);
  });

  it('reports an outstanding request to its own capture when the capture changes', async () => {
    const response = deferredResponse();
    stubFetch(response);
    applyConfig({ sessionId: SESSION_ID, captureId: ENDING_CAPTURE, hooks: { network: true } });
    const call = globalThis.fetch(ITEMS_URL);
    seam.length = 0;

    applyConfig({ sessionId: SESSION_ID, captureId: NEXT_CAPTURE, hooks: { network: true } });

    const entry = snapshotEntry();
    expect(entry.capture).toBe(ENDING_CAPTURE);
    expect(entry.accepted).toBe(true);
    // Before the transport was told about the next capture, which is the call
    // that would otherwise stamp the snapshot with capture B.
    const reconfiguredAt = seamIndex(
      (candidate) => candidate.op === 'configure' && candidate.config.captureId === NEXT_CAPTURE,
    );
    expect(seam.indexOf(entry)).toBeLessThan(reconfiguredAt);

    // The boundary made the record stale: nothing more is reported for it, and
    // its settle — now inside capture B — emits nothing at all.
    expect(reportInFlightRequests()).toBe(0);
    const emittedBefore = emittedDrafts().length;
    response.resolve();
    await call;
    await settleMicrotasks();
    expect(emittedDrafts()).toHaveLength(emittedBefore);
  });

  it('reports nothing at a boundary with nothing outstanding', () => {
    applyConfig({ sessionId: SESSION_ID, captureId: ENDING_CAPTURE, hooks: { network: true } });
    applyConfig({ sessionId: SESSION_ID, captureId: NEXT_CAPTURE, hooks: { network: true } });
    applyConfig({});

    expect(snapshots()).toHaveLength(0);
  });

  it('reports nothing when the network hook was never armed', () => {
    applyConfig({ sessionId: SESSION_ID, captureId: ENDING_CAPTURE, hooks: { errors: true } });
    void globalThis.fetch(ITEMS_URL);

    applyConfig({});

    expect(snapshots()).toHaveLength(0);
  });
});
