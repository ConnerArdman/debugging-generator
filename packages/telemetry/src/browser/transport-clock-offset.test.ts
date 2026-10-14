// @vitest-environment happy-dom
/**
 * Tests for the page producer's per-document `clockOffsetMs`: a recorded
 * per-producer estimate of the server `Date` header versus the local clock,
 * informational only (`docs/ARCHITECTURE.md` §5.2).
 *
 * ## What these cases pin
 *
 * - **Stamping, in `./transport.ts`.** No sample, no field. Once a sample
 *   exists, every event *created* afterwards carries the estimate, and an
 *   event created earlier is delivered exactly as it was created — including
 *   one that waited in the queue while the bridge was away and left after the
 *   estimate moved. An event is never restamped: a batch the bridge did not
 *   claim is re-dispatched with the very bytes of its first attempt, and an
 *   event the bridge claimed is never dispatched again, which is what keeps a
 *   replay of it byte-identical to its first delivery.
 * - **Informational only.** `startTime` and `duration` are identical to those
 *   of an unsampled control; the offset is never folded into them.
 * - **Document scope.** The estimate survives a capture change and
 *   `resetTransport()`, the two paths every capture boundary takes.
 * - **Rejection.** A malformed `Date` is a counted, rejected sample and
 *   stamps nothing; a draft that tries to carry its own `clockOffsetMs` is
 *   ignored.
 * - **Measurement, in `./fetch.ts`.** A fulfilled same-origin `fetch` and a
 *   completed same-origin XHR feed the estimate; a cross-origin request, a
 *   response carrying `Age`, a rejected `fetch` and a failed XHR do not.
 *
 * ## How the page is simulated
 *
 * Every case takes a **fresh module graph** (`vi.resetModules()` and dynamic
 * imports), because the estimate is document-scoped by design and no public
 * call clears it: a case that shared an instance would inherit the previous
 * case's samples. Importing `./fetch.js` after `./transport.js` in the same
 * graph gives the request patch the same transport instance the case observes.
 *
 * The page channel (version 3) is driven through the fake bridge every
 * telemetry browser suite uses, `./__tests__/page-channel.ts`, which does what
 * the isolated-world bridge does: it dispatches the one handshake request the
 * fresh instance will ever answer, takes the detached channel node from the
 * answer's `relatedTarget`, records every agent frame dispatched on that node
 * and acknowledges (`preventDefault()`) each one its claim policy takes. So a
 * case reads every outbound frame off the wire — the `detail` string the
 * module dispatched, parsed back — and "delivered" means *claimed by the
 * bridge*, exactly as the transport's custody rule defines it. Inbound
 * `bridge.ready` / `bridge.gone` frames are dispatched on the same node, and
 * each must be acknowledged, so a case never asserts on the aftermath of a
 * frame the agent did not accept. The node's frame listener exists only while
 * the instance is subscribed, so every instance holds a subscription for the
 * length of its case; teardown releases it, resets the instance and
 * disconnects its bridge. `fetch` and the three `XMLHttpRequest` prototype
 * methods are replaced with stubs before the patch is attached, so nothing
 * reaches a network.
 *
 * Instants are chosen so every expected estimate can be read off the
 * interval arithmetic of `../schema/clock-offset.ts`: a sample with header
 * value `D`, sent at `s` and received at `r`, bounds the offset to
 * `[D − r, D + 1000 − s]` and reports its midpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HTTP_DATE_RESOLUTION_MS } from '../schema/clock-offset.js';
import type { ClockOffsetSnapshot } from '../schema/clock-offset.js';
import { connectFakeBridge } from './__tests__/page-channel.js';
import type { FakeBridge, RecordedAgentFrame } from './__tests__/page-channel.js';
import type { EventDraft } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 *
 * Neutral vocabulary: nothing below names a component, route or symbol of any
 * particular project.
 * ---------------------------------------------------------------------------
 */

/** The transport module, as a fresh graph imports it. */
type TransportModule = typeof import('./transport.js');

/** The request patch, imported into the same graph as the transport. */
type FetchModule = typeof import('./fetch.js');

/** The session every capture belongs to. */
const SESSION_ID = `ses_${'1'.repeat(16)}`;

/** The capture every case starts under. */
const CAPTURE_A = `cap_${'a'.repeat(16)}`;

/** The capture a capture-change case moves to. */
const CAPTURE_B = `cap_${'b'.repeat(16)}`;

/** The trace every draft belongs to: 32 lowercase hex characters. */
const TRACE_ID = 'c'.repeat(32);

/** Characters in a span id. */
const SPAN_ID_WIDTH = 16;

/** A browser-tier kind, as this producer's are. */
const EVENT_KIND = 'render';

/**
 * A whole-second server instant: `Date` headers have one-second resolution, so
 * a header can only name such an instant.
 */
const SERVER_DATE_MS = 1_700_000_000_000;

/**
 * The first sample: the page clock reads 1.5 s behind the header when the
 * request leaves and 1.4 s behind it when the answer arrives. Its interval is
 * `[1 400, 2 500]`, whose midpoint is 1 950.
 */
const FIRST_SAMPLE = {
  dateMs: SERVER_DATE_MS,
  sentAt: SERVER_DATE_MS - 1_500,
  receivedAt: SERVER_DATE_MS - 1_400,
} as const;

/** What {@link FIRST_SAMPLE} alone yields. */
const FIRST_ESTIMATE: ClockOffsetSnapshot = {
  offsetMs: 1_950,
  lowerBoundMs: 1_400,
  upperBoundMs: 2_500,
  samples: 1,
  accepted: 1,
  resets: 0,
  rejected: 0,
};

/**
 * A second sample after the page clock stepped forward: it now reads 5 s
 * ahead of a header 10 s later. Its interval, `[−5 100, −4 000]`, is disjoint
 * from {@link FIRST_SAMPLE}'s, so the estimate restarts from it at −4 550.
 */
const STEPPED_SAMPLE = {
  dateMs: SERVER_DATE_MS + 10_000,
  sentAt: SERVER_DATE_MS + 15_000,
  receivedAt: SERVER_DATE_MS + 15_100,
} as const;

/** What {@link FIRST_SAMPLE} followed by {@link STEPPED_SAMPLE} yields. */
const STEPPED_ESTIMATE: ClockOffsetSnapshot = {
  offsetMs: -4_550,
  lowerBoundMs: -5_100,
  upperBoundMs: -4_000,
  samples: 2,
  accepted: 1,
  resets: 1,
  rejected: 0,
};

/** What an estimator that has seen nothing reports. */
const EMPTY_ESTIMATE: ClockOffsetSnapshot = {
  offsetMs: undefined,
  lowerBoundMs: undefined,
  upperBoundMs: undefined,
  samples: 0,
  accepted: 0,
  resets: 0,
  rejected: 0,
};

/** The key under test, spelled once. */
const CLOCK_OFFSET_KEY = 'clockOffsetMs';

/*
 * ---------------------------------------------------------------------------
 * Drafts
 * ---------------------------------------------------------------------------
 */

/**
 * One render draft whose index is legible in its span id and name.
 *
 * The start time carries a sub-millisecond fraction on purpose: it is the part
 * of a timestamp an offset folded in by mistake would disturb first.
 *
 * @param index The emission index.
 * @returns The draft, as a producer in this folder would build it.
 */
function renderDraft(index: number): EventDraft {
  return {
    traceId: TRACE_ID,
    spanId: (index + 1).toString(16).padStart(SPAN_ID_WIDTH, '0'),
    kind: EVENT_KIND,
    name: `render ${String(index)}`,
    startTime: SERVER_DATE_MS - 60_000 + index + 0.123_456,
    duration: 2.345_678,
    status: 'unset',
    attributes: { index },
  };
}

/*
 * ---------------------------------------------------------------------------
 * Outbound observation
 * ---------------------------------------------------------------------------
 */

/*
 * Every reader below works on what the fake bridge recorded: each agent frame
 * as the `detail` string the module dispatched on the channel node, parsed
 * back. Version 3 hands the bridge that string and nothing else — no object
 * reference crosses the channel — so these are the bytes that travelled, and
 * nothing the module does to its own objects afterwards can change them.
 */

/**
 * Narrow an unknown value to a record.
 *
 * @param value The value to narrow.
 * @param what What it was supposed to be, for the failure message.
 * @returns The value as a record.
 */
function asRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} was not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * The events one `telemetry.batch` frame carried, as it was dispatched.
 *
 * @param frame A recorded `telemetry.batch` frame.
 * @returns Its events, in batch order.
 */
function batchEvents(frame: RecordedAgentFrame): Readonly<Record<string, unknown>>[] {
  const events: unknown = frame.payload.events;
  if (!Array.isArray(events)) {
    throw new Error('a dispatched telemetry.batch carried no events array');
  }
  return (events as readonly unknown[]).map((event) => asRecord(event, 'a dispatched event'));
}

/**
 * The events of every `telemetry.batch` the bridge **claimed** — what was
 * delivered, under the transport's custody rule.
 *
 * @param bridge The fake bridge holding the instance's channel node.
 * @returns The delivered events, in delivery order.
 */
function deliveredEvents(bridge: FakeBridge): Readonly<Record<string, unknown>>[] {
  return bridge.claimedOfType('telemetry.batch').flatMap((frame) => batchEvents(frame));
}

/**
 * The one delivered event with `name`, failing when there is not exactly one.
 *
 * @param bridge The fake bridge holding the instance's channel node.
 * @param name The event's name.
 * @returns The event, as it was delivered.
 */
function deliveredNamed(bridge: FakeBridge, name: string): Readonly<Record<string, unknown>> {
  const found = deliveredEvents(bridge).filter((event) => event.name === name);
  expect(found).toHaveLength(1);
  const [event] = found;
  if (event === undefined) {
    throw new Error(`no event named ${name} was delivered`);
  }
  return event;
}

/**
 * The JSON of every dispatch of the event named `name`, claimed or not, in
 * dispatch order — so a replay can be compared with the attempt before it.
 *
 * Each event is re-rendered from the parsed `detail` with `JSON.stringify`.
 * The module's renderer emits exactly what `JSON.stringify` would, and parsing
 * keeps key order and every number's value, so the text equals the event's own
 * span of the dispatched `detail`: two entries differ exactly when the bytes
 * that travelled did.
 *
 * @param bridge The fake bridge holding the instance's channel node.
 * @param name The event's name.
 * @returns One JSON text per dispatch that carried the event.
 */
function dispatchedEventJson(bridge: FakeBridge, name: string): string[] {
  return bridge
    .framesOfType('telemetry.batch')
    .flatMap((frame) => batchEvents(frame))
    .filter((event) => event.name === name)
    .map((event) => JSON.stringify(event));
}

/**
 * An event's fields other than the ones that legitimately differ between two
 * producers, so a sampled event can be compared with an unsampled control.
 *
 * @param event A delivered event.
 * @param omitted The keys to leave out.
 * @returns The remaining fields.
 */
function withoutKeys(
  event: Readonly<Record<string, unknown>>,
  omitted: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => !omitted.includes(key)));
}

/*
 * ---------------------------------------------------------------------------
 * A fresh document
 * ---------------------------------------------------------------------------
 */

/** A transport instance a case has armed, with what it needs to talk to it. */
interface ArmedTransport {
  readonly transport: TransportModule;
  readonly fetchModule: FetchModule;
  /** The fake bridge holding the channel node this instance handed over. */
  readonly bridge: FakeBridge;
  /** Every subscription {@link holdChannel} took on it, released at teardown. */
  readonly subscriptions: (() => void)[];
}

/** Every instance armed in the current case, for teardown. */
const armed: ArmedTransport[] = [];

/**
 * Subscribe to an instance for the rest of the case.
 *
 * The node's frame listener exists only while the transport has a subscriber,
 * and every inbound frame a case sends goes through it; a
 * {@link TransportModule.resetTransport} removes it, and the next subscription
 * re-installs it on the same, document-scoped node the bridge still holds.
 *
 * @param instance The instance.
 */
function holdChannel(instance: ArmedTransport): void {
  instance.subscriptions.push(
    instance.transport.subscribe((): void => {
      // Inbound frames are not under test; the subscription is what keeps the
      // node's listener, which the bridge frames below are delivered to.
    }),
  );
}

/**
 * A fresh document's transport and request patch, handed to a fake bridge,
 * subscribed and configured into {@link CAPTURE_A}, with the bridge not yet
 * announced.
 *
 * {@link connectFakeBridge} performs the version-3 handshake exactly as the
 * isolated-world bridge does and throws unless exactly one answer carrying
 * the node arrived — which holds for a fresh instance only: every instance
 * armed earlier has answered its one request and listens for no other.
 *
 * @returns The armed instance.
 */
async function freshDocument(): Promise<ArmedTransport> {
  vi.resetModules();
  const transport = await import('./transport.js');
  const fetchModule = await import('./fetch.js');

  const bridge = connectFakeBridge(transport);
  const instance: ArmedTransport = { transport, fetchModule, bridge, subscriptions: [] };
  armed.push(instance);
  holdChannel(instance);
  transport.configureTransport({ enabled: true, sessionId: SESSION_ID, captureId: CAPTURE_A });
  return instance;
}

/**
 * Dispatch one bridge frame on an instance's channel node, and require the
 * agent to acknowledge it.
 *
 * An unacknowledged frame never reached the handling under test, so a case
 * that carried on would be asserting on what did not happen.
 *
 * @param instance The instance.
 * @param type The frame type.
 */
function announceBridge(instance: ArmedTransport, type: 'bridge.ready' | 'bridge.gone'): void {
  expect(instance.bridge.send(type), `the agent did not acknowledge ${type}`).toBe(true);
}

/**
 * Feed one sample to an instance's estimate, with a canonical `Date` value.
 *
 * @param instance The instance.
 * @param sample The header instant and the page's two clock readings.
 */
function observe(
  instance: ArmedTransport,
  sample: { readonly dateMs: number; readonly sentAt: number; readonly receivedAt: number },
): void {
  instance.transport.observeServerClock(
    new Date(sample.dateMs).toUTCString(),
    sample.sentAt,
    sample.receivedAt,
  );
}

afterEach(() => {
  for (const instance of armed) {
    for (const release of instance.subscriptions) {
      release();
    }
    instance.fetchModule.detachFetch();
    instance.transport.resetTransport();
    instance.bridge.disconnect();
  }
  armed.length = 0;
  vi.restoreAllMocks();
});

/*
 * ---------------------------------------------------------------------------
 * `./transport.ts` — stamping
 * ---------------------------------------------------------------------------
 */

describe('the page transport clock offset', () => {
  it('stamps nothing before the first usable sample, and a header-less response is no sample', async () => {
    const page = await freshDocument();

    page.transport.observeServerClock(null, FIRST_SAMPLE.sentAt, FIRST_SAMPLE.receivedAt);
    page.transport.observeServerClock(undefined, FIRST_SAMPLE.sentAt, FIRST_SAMPLE.receivedAt);
    page.transport.emit(renderDraft(0));
    announceBridge(page, 'bridge.ready');

    expect(page.transport.getClockOffsetStats()).toEqual(EMPTY_ESTIMATE);
    const event = deliveredNamed(page.bridge, 'render 0');
    expect(Object.hasOwn(event, CLOCK_OFFSET_KEY)).toBe(false);
  });

  it('stamps events created after a sample and delivers events queued before it as they were created', async () => {
    const page = await freshDocument();

    // The bridge is away, so both events wait in the queue: nothing is even
    // dispatched on the node until it announces itself.
    page.transport.emit(renderDraft(0));
    observe(page, FIRST_SAMPLE);
    page.transport.emit(renderDraft(1));
    expect(page.bridge.framesOfType('telemetry.batch')).toHaveLength(0);

    announceBridge(page, 'bridge.ready');

    expect(Object.hasOwn(deliveredNamed(page.bridge, 'render 0'), CLOCK_OFFSET_KEY)).toBe(false);
    expect(deliveredNamed(page.bridge, 'render 1')[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);
    expect(page.transport.getClockOffsetStats()).toEqual(FIRST_ESTIMATE);
  });

  it('stamps each event once: a moved estimate changes only events created after it moved', async () => {
    const page = await freshDocument();
    announceBridge(page, 'bridge.ready');
    observe(page, FIRST_SAMPLE);

    page.transport.emit(renderDraft(0));
    page.transport.flush();
    const firstDelivery = dispatchedEventJson(page.bridge, 'render 0');
    expect(firstDelivery).toHaveLength(1);
    expect(deliveredNamed(page.bridge, 'render 0')[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);

    // The bridge's runtime port dies while it holds the next batch: the frame
    // goes unclaimed, custody puts the event back at the front of the queue,
    // and the bridge is marked away.
    page.bridge.claim = false;
    page.transport.emit(renderDraft(1));
    page.transport.flush();
    const unclaimedAttempt = dispatchedEventJson(page.bridge, 'render 1');
    expect(unclaimedAttempt).toHaveLength(1);
    expect(deliveredEvents(page.bridge).map((event) => event.name)).toEqual(['render 0']);
    expect(page.transport.getTransportStats()).toMatchObject({ buffered: 1, bridgeReady: false });

    // The service worker suspends; one event is created under the first
    // estimate, the clock steps, and one more is created under the new one.
    announceBridge(page, 'bridge.gone');
    page.transport.emit(renderDraft(2));
    observe(page, STEPPED_SAMPLE);
    page.transport.emit(renderDraft(3));
    page.bridge.claim = true;
    announceBridge(page, 'bridge.ready');

    expect(page.transport.getClockOffsetStats()).toEqual(STEPPED_ESTIMATE);
    // Dispatched once under the first estimate, taken back, and re-delivered
    // after the estimate moved: byte for byte what its first attempt carried.
    expect(deliveredNamed(page.bridge, 'render 1')[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);
    expect(dispatchedEventJson(page.bridge, 'render 1')).toEqual([
      ...unclaimedAttempt,
      ...unclaimedAttempt,
    ]);
    // Queued across the reconnect, delivered after the estimate moved, and
    // still carrying the estimate it was created under.
    expect(deliveredNamed(page.bridge, 'render 2')[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);
    expect(deliveredNamed(page.bridge, 'render 3')[CLOCK_OFFSET_KEY]).toBe(
      STEPPED_ESTIMATE.offsetMs,
    );
    // The event delivered first was never dispatched again, so anything that
    // replays it replays the bytes it was first delivered with.
    expect(dispatchedEventJson(page.bridge, 'render 0')).toEqual(firstDelivery);
  });

  it('never alters startTime or duration: a sampled event matches an unsampled control', async () => {
    const draft: EventDraft = { ...renderDraft(7), id: `evt_${'d'.repeat(16)}` };

    const control = await freshDocument();
    announceBridge(control, 'bridge.ready');
    control.transport.emit(draft);
    control.transport.flush();
    const unsampled = deliveredNamed(control.bridge, 'render 7');
    control.transport.resetTransport();

    // Its own document, so its own handshake and its own bridge: nothing the
    // control dispatched can be read as the sampled instance's.
    const sampled = await freshDocument();
    announceBridge(sampled, 'bridge.ready');
    observe(sampled, FIRST_SAMPLE);
    sampled.transport.emit(draft);
    sampled.transport.flush();
    const stamped = deliveredNamed(sampled.bridge, 'render 7');

    expect(stamped[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);
    expect(stamped.startTime).toBe(unsampled.startTime);
    expect(stamped.duration).toBe(unsampled.duration);
    // Rounded to microseconds exactly as without a sample, and not shifted.
    expect(stamped.startTime).toBe(Math.round(draft.startTime * 1_000) / 1_000);
    // Every other field is the control's too; only the document's own
    // producer id and the offset itself differ.
    expect(withoutKeys(stamped, ['producerId', CLOCK_OFFSET_KEY])).toEqual(
      withoutKeys(unsampled, ['producerId']),
    );
  });

  it('counts a malformed Date header or a broken clock reading as rejected, and stamps nothing', async () => {
    const page = await freshDocument();

    // 31 February does not exist; `Date.parse` would roll it into March.
    page.transport.observeServerClock(
      'Fri, 31 Feb 2023 10:00:00 GMT',
      FIRST_SAMPLE.sentAt,
      FIRST_SAMPLE.receivedAt,
    );
    page.transport.observeServerClock('yesterday', FIRST_SAMPLE.sentAt, FIRST_SAMPLE.receivedAt);
    page.transport.observeServerClock(
      new Date(FIRST_SAMPLE.dateMs).toUTCString(),
      Number.NaN,
      FIRST_SAMPLE.receivedAt,
    );
    page.transport.emit(renderDraft(0));
    announceBridge(page, 'bridge.ready');

    expect(page.transport.getClockOffsetStats()).toEqual({
      ...EMPTY_ESTIMATE,
      samples: 3,
      rejected: 3,
    });
    expect(Object.hasOwn(deliveredNamed(page.bridge, 'render 0'), CLOCK_OFFSET_KEY)).toBe(false);
  });

  it('ignores a clockOffsetMs a producer tries to supply on its draft', async () => {
    const page = await freshDocument();
    announceBridge(page, 'bridge.ready');
    // A variable rather than a literal: the draft type omits the key, so only
    // a value built elsewhere — a mistaken or hostile caller — could carry it.
    const forged = { ...renderDraft(0), clockOffsetMs: 777 };
    const forgedAfterSample = { ...renderDraft(1), clockOffsetMs: 777 };

    page.transport.emit(forged);
    observe(page, FIRST_SAMPLE);
    page.transport.emit(forgedAfterSample);
    page.transport.flush();

    expect(Object.hasOwn(deliveredNamed(page.bridge, 'render 0'), CLOCK_OFFSET_KEY)).toBe(false);
    expect(deliveredNamed(page.bridge, 'render 1')[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);
  });

  it('keeps the estimate across a capture change and across resetTransport', async () => {
    const page = await freshDocument();
    announceBridge(page, 'bridge.ready');
    observe(page, FIRST_SAMPLE);

    page.transport.configureTransport({
      enabled: true,
      sessionId: SESSION_ID,
      captureId: CAPTURE_B,
    });
    expect(page.transport.getClockOffsetStats()).toEqual(FIRST_ESTIMATE);
    page.transport.emit(renderDraft(0));
    page.transport.flush();
    expect(deliveredNamed(page.bridge, 'render 0')[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);

    // The disarm → re-arm path of a second capture on one document.
    page.transport.resetTransport();
    expect(page.transport.getClockOffsetStats()).toEqual(FIRST_ESTIMATE);
    // Re-installs the node's listener; the node is the document's, and the
    // bridge still holds it — there is no second handshake.
    holdChannel(page);
    page.transport.configureTransport({
      enabled: true,
      sessionId: SESSION_ID,
      captureId: CAPTURE_A,
    });
    announceBridge(page, 'bridge.ready');
    page.transport.emit(renderDraft(1));
    page.transport.flush();

    expect(deliveredNamed(page.bridge, 'render 1')[CLOCK_OFFSET_KEY]).toBe(FIRST_ESTIMATE.offsetMs);
  });

  it('never throws into the page, whatever it is handed', async () => {
    const page = await freshDocument();
    // A value whose coercion throws: the sample must be type-checked, never
    // stringified.
    const exotic: unknown = {
      toString: (): never => {
        throw new Error('the clock sample coerced a value it should only have type-checked');
      },
    };

    expect(() => {
      page.transport.observeServerClock(exotic as string, Number.NaN, Number.POSITIVE_INFINITY);
    }).not.toThrow();
    expect(page.transport.getClockOffsetStats()).toEqual({
      ...EMPTY_ESTIMATE,
      samples: 1,
      rejected: 1,
    });
    expect(Object.isFrozen(page.transport.getClockOffsetStats())).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `./fetch.ts` — measurement
 *
 * The request patch wraps stubs installed before it attaches, so the "server"
 * is whatever response a case constructs. The page clock is not stubbed:
 * `sentAt` and `receivedAt` are whatever `nowEpochMs()` read inside the patch,
 * so each case brackets the request with two readings of the same clock and
 * asserts the sample's interval lies between what those brackets allow.
 * ---------------------------------------------------------------------------
 */

/** A path on the document's own origin; relative, as an application writes it. */
const SAME_ORIGIN_PATH = '/api/items';

/** A URL on another origin. */
const CROSS_ORIGIN_URL = 'https://third-party.example/api/items';

/** The `XMLHttpRequest` methods replaced with stubs. */
const STUBBED_XHR_METHODS = ['open', 'send', 'setRequestHeader'] as const;

/**
 * A response as the network would hand it to the page.
 *
 * A constructed `Response` has an empty `url`; a real one carries the final
 * URL after redirects, which the patch judges, so it is set here.
 *
 * @param finalUrl The URL the response was served from.
 * @param headers Its headers.
 * @returns The response.
 */
function networkResponse(finalUrl: string, headers: Record<string, string>): Response {
  const response = new Response(null, { status: 200, headers });
  Object.defineProperty(response, 'url', { value: new URL(finalUrl, window.location.href).href });
  return response;
}

/**
 * A whole-second `Date` value near the page clock's current reading.
 *
 * @param pageNow A reading of the transport's clock.
 * @returns The instant, and its IMF-fixdate spelling.
 */
function serverDateNear(pageNow: number): { readonly ms: number; readonly header: string } {
  const ms = Math.floor(pageNow / HTTP_DATE_RESOLUTION_MS) * HTTP_DATE_RESOLUTION_MS;
  return { ms, header: new Date(ms).toUTCString() };
}

/**
 * Assert one accepted sample whose interval is what a `Date` of `serverMs`,
 * sent and received between the two brackets, can produce.
 *
 * @param stats The estimator's snapshot.
 * @param serverMs The header's instant.
 * @param before A clock reading taken before the request was made.
 * @param after A clock reading taken after it settled.
 */
function expectOneSampleBetween(
  stats: ClockOffsetSnapshot,
  serverMs: number,
  before: number,
  after: number,
): void {
  expect(stats).toMatchObject({ samples: 1, accepted: 1, resets: 0, rejected: 0 });
  const { lowerBoundMs, upperBoundMs } = stats;
  if (lowerBoundMs === undefined || upperBoundMs === undefined) {
    throw new Error('an accepted sample left the estimate without an interval');
  }
  // lower = D − receivedAt, receivedAt ∈ [before, after].
  expect(lowerBoundMs).toBeGreaterThanOrEqual(serverMs - after);
  expect(lowerBoundMs).toBeLessThanOrEqual(serverMs - before);
  // upper = D + 1000 − sentAt, sentAt ∈ [before, after].
  expect(upperBoundMs).toBeGreaterThanOrEqual(serverMs + HTTP_DATE_RESOLUTION_MS - after);
  expect(upperBoundMs).toBeLessThanOrEqual(serverMs + HTTP_DATE_RESOLUTION_MS - before);
}

describe('the request patch as the clock-offset source', () => {
  let originalFetch: typeof globalThis.fetch;
  const originalXhrMethods = new Map<string, unknown>();

  /** What the stubbed `fetch` answers the next call with. */
  let nextAnswer: () => Promise<Response>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalXhrMethods.clear();
    for (const name of STUBBED_XHR_METHODS) {
      originalXhrMethods.set(name, Reflect.get(XMLHttpRequest.prototype, name));
    }
    nextAnswer = (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 }));
    globalThis.fetch = vi.fn(() => nextAnswer());
    Reflect.set(XMLHttpRequest.prototype, 'open', function stubOpen(): void {
      // The state the patch needs is recorded by its own `open` wrapper.
    });
    Reflect.set(XMLHttpRequest.prototype, 'send', function stubSend(): void {
      // Settled by the case, which dispatches `loadend` itself.
    });
    Reflect.set(XMLHttpRequest.prototype, 'setRequestHeader', function stubSetHeader(): void {
      // Injection is not under test here.
    });
  });

  afterEach(() => {
    // The patch first, so each original goes back underneath it.
    for (const instance of armed) {
      instance.fetchModule.detachFetch();
    }
    globalThis.fetch = originalFetch;
    for (const [name, method] of originalXhrMethods) {
      Reflect.set(XMLHttpRequest.prototype, name, method);
    }
  });

  it('samples a fulfilled same-origin fetch, before the request event is stamped', async () => {
    const page = await freshDocument();
    announceBridge(page, 'bridge.ready');
    page.fetchModule.attachFetch();

    const before = page.transport.nowEpochMs();
    const date = serverDateNear(before);
    const response = networkResponse(SAME_ORIGIN_PATH, { date: date.header });
    nextAnswer = (): Promise<Response> => Promise.resolve(response);

    const answered = await globalThis.fetch(SAME_ORIGIN_PATH);
    const after = page.transport.nowEpochMs();

    // The application receives the very response the network produced.
    expect(answered).toBe(response);
    const stats = page.transport.getClockOffsetStats();
    expectOneSampleBetween(stats, date.ms, before, after);

    // The request's own event already carries the estimate its response fed.
    page.transport.flush();
    const [requestEvent] = deliveredEvents(page.bridge).filter((event) => event.kind === 'fetch');
    expect(requestEvent?.[CLOCK_OFFSET_KEY]).toBe(stats.offsetMs);
    expect(page.fetchModule.getFetchStats().failures).toBe(0);
  });

  it('takes no sample from a cross-origin fetch, a cross-origin redirect or a cached response', async () => {
    const page = await freshDocument();
    page.fetchModule.attachFetch();
    const date = serverDateNear(page.transport.nowEpochMs());

    nextAnswer = (): Promise<Response> =>
      Promise.resolve(networkResponse(CROSS_ORIGIN_URL, { date: date.header }));
    await globalThis.fetch(CROSS_ORIGIN_URL);

    // Asked of this origin, answered from another after a redirect.
    nextAnswer = (): Promise<Response> =>
      Promise.resolve(networkResponse(CROSS_ORIGIN_URL, { date: date.header }));
    await globalThis.fetch(SAME_ORIGIN_PATH);

    // Served from a cache: `Date` is when it was first generated.
    nextAnswer = (): Promise<Response> =>
      Promise.resolve(networkResponse(SAME_ORIGIN_PATH, { date: date.header, age: '120' }));
    await globalThis.fetch(SAME_ORIGIN_PATH);

    expect(page.transport.getClockOffsetStats()).toEqual(EMPTY_ESTIMATE);
    expect(page.fetchModule.getFetchStats().failures).toBe(0);
  });

  it('takes no sample from a rejected fetch or from a response without a Date', async () => {
    const page = await freshDocument();
    page.fetchModule.attachFetch();

    const refusal = new TypeError('the network refused the request');
    nextAnswer = (): Promise<Response> => Promise.reject(refusal);
    await expect(globalThis.fetch(SAME_ORIGIN_PATH)).rejects.toBe(refusal);

    nextAnswer = (): Promise<Response> => Promise.resolve(networkResponse(SAME_ORIGIN_PATH, {}));
    await globalThis.fetch(SAME_ORIGIN_PATH);

    expect(page.transport.getClockOffsetStats()).toEqual(EMPTY_ESTIMATE);
  });

  it('samples a completed same-origin XMLHttpRequest at loadend', async () => {
    const page = await freshDocument();
    page.fetchModule.attachFetch();

    const before = page.transport.nowEpochMs();
    const date = serverDateNear(before);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', SAME_ORIGIN_PATH);
    xhr.send();

    const readHeader = vi.fn((name: string): string | null =>
      name.toLowerCase() === 'date' ? date.header : null,
    );
    Object.defineProperty(xhr, 'status', { value: 200 });
    Object.defineProperty(xhr, 'responseURL', {
      value: new URL(SAME_ORIGIN_PATH, window.location.href).href,
    });
    Object.defineProperty(xhr, 'getResponseHeader', { value: readHeader });
    xhr.dispatchEvent(new Event('loadend'));
    const after = page.transport.nowEpochMs();

    expectOneSampleBetween(page.transport.getClockOffsetStats(), date.ms, before, after);
    expect(readHeader.mock.calls.map(([name]) => name)).toEqual(['age', 'date']);
  });

  it('never reads a header of a failed or cross-origin XMLHttpRequest', async () => {
    const page = await freshDocument();
    page.fetchModule.attachFetch();
    const date = serverDateNear(page.transport.nowEpochMs());
    const readHeader = vi.fn((): string => date.header);

    // A network error: status 0 and an `error` event before `loadend`.
    const failed = new XMLHttpRequest();
    failed.open('GET', SAME_ORIGIN_PATH);
    failed.send();
    Object.defineProperty(failed, 'getResponseHeader', { value: readHeader });
    failed.dispatchEvent(new Event('error'));
    failed.dispatchEvent(new Event('loadend'));

    // A completed request to another origin.
    const foreign = new XMLHttpRequest();
    foreign.open('GET', CROSS_ORIGIN_URL);
    foreign.send();
    Object.defineProperty(foreign, 'status', { value: 200 });
    Object.defineProperty(foreign, 'responseURL', { value: CROSS_ORIGIN_URL });
    Object.defineProperty(foreign, 'getResponseHeader', { value: readHeader });
    foreign.dispatchEvent(new Event('loadend'));

    expect(readHeader).not.toHaveBeenCalled();
    expect(page.transport.getClockOffsetStats()).toEqual(EMPTY_ESTIMATE);
  });

  it('costs only the sample when a response refuses to be read', async () => {
    const page = await freshDocument();
    announceBridge(page, 'bridge.ready');
    page.fetchModule.attachFetch();

    const response = networkResponse(SAME_ORIGIN_PATH, {});
    Object.defineProperty(response, 'headers', {
      get: (): never => {
        throw new TypeError('this response exposes no headers');
      },
    });
    nextAnswer = (): Promise<Response> => Promise.resolve(response);

    await expect(globalThis.fetch(SAME_ORIGIN_PATH)).resolves.toBe(response);
    page.transport.flush();

    expect(page.transport.getClockOffsetStats()).toEqual(EMPTY_ESTIMATE);
    // Counted and reported like every contained failure, and the request is
    // still recorded.
    expect(page.fetchModule.getFetchStats().failures).toBe(1);
    expect(deliveredEvents(page.bridge).filter((event) => event.kind === 'fetch')).toHaveLength(1);
    // Every `agent.error` dispatched on the node, claimed or not: exactly the
    // one report, and the bridge took it.
    const errors = page.bridge.framesOfType('agent.error');
    expect(errors.map((frame) => ({ stage: frame.payload.stage, claimed: frame.claimed }))).toEqual(
      [{ stage: 'clock-sample', claimed: true }],
    );
  });
});
