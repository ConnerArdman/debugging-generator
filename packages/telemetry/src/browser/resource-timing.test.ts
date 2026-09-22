/**
 * Tests for the resource-timing contract the two browser producers share:
 * `./fetch.ts`'s request identity, `./perf.ts`'s transfer-size exposure
 * verdict, and the capture boundary that decides which performance entries
 * belong to a capture at all.
 *
 * ## Why one file for two modules
 *
 * No request API can report how many bytes crossed the wire; only
 * `PerformanceResourceTiming` can (AAP 0.6.6). So the `transferred_bytes`
 * metric and every byte figure on a request row are produced by *two* modules
 * agreeing on two things — the URL under which a request appears in the timing
 * buffer, and whether a byte count beside it is a measurement — and joined by
 * `../aggregate/requests.ts`. A contract with two producers and one consumer
 * breaks in the gap between them, and that gap is what this file holds:
 * `../aggregate/requests.test.ts` owns the join itself and can only assert on
 * events it writes by hand, so the halves each producer actually emits are
 * pinned here.
 *
 * ## The three failures these cases exist to prevent
 *
 * - **An identity that is not the one the browser used.** A request's
 *   resource-timing entry is named by the URL the platform resolved, against
 *   the *document base URL* and at the moment the platform resolved it. Two
 *   ways to get that wrong both produce an identity matching no entry, so the
 *   bytes are silently lost: resolving against `location.href`, which ignores
 *   a `<base href>`; and resolving an `XMLHttpRequest` at `send` rather than
 *   at `open`, which a history navigation in between makes wrong. Both are
 *   asserted, and both would otherwise be invisible — a missing join looks
 *   exactly like a cross-origin response.
 * - **A withheld byte count read as a measurement.** A cross-origin response
 *   reports `transferSize: 0` when the timing-allow check fails, which is
 *   indistinguishable by value from the genuine zero of a same-origin cache
 *   hit. The discriminating case is a CORS response *without*
 *   `Timing-Allow-Origin`: it carries a real `responseStatus` beside three
 *   zero sizes, so any predicate that trusts a status certifies exactly the
 *   absence it was written to catch (AAP 0.6.6, 0.8.4).
 * - **A capture claiming a boundary it does not have.** The filter that keeps
 *   pre-capture entries out is measured against the instant the hook attached,
 *   and a host that cannot provide the hook must report no boundary rather
 *   than one no observer stands behind.
 *
 * ## How the page is simulated
 *
 * happy-dom supplies `document.baseURI` (honouring a `<base href>`),
 * `history.pushState` and `XMLHttpRequest`; `fetch` and the three XHR
 * prototype methods are replaced with stubs **before** the patch is installed,
 * so the module under test wraps the stub and no test opens a socket.
 * `./transport.ts` is mocked at `emit` alone — every other export stays real,
 * including the epoch clock both producers timestamp with — so a case reads
 * the draft a producer built rather than a frame that survived batching.
 *
 * `PerformanceObserver` is replaced by a stub that records each `observe`
 * init and replays entries on demand, which is the only way to deliver an
 * entry whose fields a case chose. Entry `startTime` is document-relative, as
 * the platform's is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * ---------------------------------------------------------------------------
 * The transport seam
 *
 * `emit` is intercepted; `nowEpochMs`, `toEpochMs` and the rest are the real
 * implementations, because the capture-boundary cases compare an entry's
 * converted `startTime` against the instant `attachPerf` recorded and both
 * readings must come from the same clock.
 * ---------------------------------------------------------------------------
 */

/** One draft a producer handed to the transport. */
interface CapturedDraft {
  readonly kind: string;
  readonly name: string;
  readonly attributes: Record<string, unknown>;
}

const captured: CapturedDraft[] = [];

vi.mock('./transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport.js')>();
  return {
    ...actual,
    emit: (draft: CapturedDraft) => {
      captured.push(draft);
    },
  };
});

const { attachFetch, detachFetch } = await import('./fetch.js');
const {
  BUFFERED_ENTRY_TYPES,
  OBSERVED_ENTRY_TYPES,
  attachPerf,
  detachPerf,
  getCaptureStartTime,
  getPerfStats,
  isPerfAttached,
} = await import('./perf.js');

/*
 * ---------------------------------------------------------------------------
 * Vocabulary
 *
 * The attribute names are the two producers' own spellings. Both are invented
 * keys that `../schema/attributes.ts` has not adopted yet, and
 * `../aggregate/requests.ts` exports the consumer-side constants that pin
 * them; those are imported rather than retyped so this file cannot disagree
 * with the join about which attribute it is asserting on.
 * ---------------------------------------------------------------------------
 */

const { RESOURCE_TIMING_URL_ATTRIBUTE, TRANSFER_SIZE_EXPOSED_ATTRIBUTE } =
  await import('../aggregate/requests.js');

/** The resource entry's own URL, and a request's display URL. */
const URL_ATTRIBUTE = 'url';

/** Bytes over the wire, as `PerformanceResourceTiming` spells it. */
const TRANSFER_SIZE_ATTRIBUTE = 'transferSize';

/** The two body sizes, withheld or exposed with the transfer size. */
const ENCODED_BODY_SIZE_ATTRIBUTE = 'encodedBodySize';
const DECODED_BODY_SIZE_ATTRIBUTE = 'decodedBodySize';

/*
 * ---------------------------------------------------------------------------
 * The `PerformanceObserver` stub
 * ---------------------------------------------------------------------------
 */

/** What one `observe` call asked for. */
interface ObserveInit {
  readonly type: string;
  readonly buffered?: boolean;
}

const observeInits: ObserveInit[] = [];
const observerCallbacks = new Map<string, (list: { getEntries: () => unknown[] }) => void>();

/** Records every `observe` and replays entries the case chooses. */
class StubPerformanceObserver {
  constructor(private readonly callback: (list: { getEntries: () => unknown[] }) => void) {}

  observe(init: ObserveInit): void {
    observeInits.push(init);
    observerCallbacks.set(init.type, this.callback);
  }

  disconnect(): void {
    // The stub holds no platform resource; `detachPerf` still calls this.
  }
}

/** Deliver `entries` to the observer registered for `type`. */
function replay(type: string, entries: readonly unknown[]): void {
  const callback = observerCallbacks.get(type);
  if (callback === undefined) {
    throw new Error(`no observer is registered for "${type}"`);
  }
  callback({ getEntries: () => [...entries] });
}

/**
 * A `PerformanceEntry`-shaped object.
 *
 * `startTime` is document-relative like the platform's, and the default
 * duration is long enough that `startTime + duration` lands after the capture
 * began — which is what the boundary filter tests, and what every case that is
 * about something else needs not to trip over.
 */
function entry(fields: Record<string, unknown>): Record<string, unknown> {
  return { name: 'entry', startTime: 0, duration: 60_000_000, ...fields };
}

/*
 * ---------------------------------------------------------------------------
 * Narrowing helpers
 * ---------------------------------------------------------------------------
 */

/** The attributes of the single draft a case produced. */
function onlyAttributes(): Record<string, unknown> {
  expect(captured.map((draft) => draft.kind)).toHaveLength(1);
  const draft = captured[0];
  if (draft === undefined) {
    throw new Error('no draft was emitted');
  }
  return draft.attributes;
}

/** A string attribute, or a failure naming what was found instead. */
function stringAttribute(attributes: Record<string, unknown>, key: string): string {
  const value = attributes[key];
  if (typeof value !== 'string') {
    throw new Error(`attribute "${key}" is ${typeof value}, not a string`);
  }
  return value;
}

/*
 * ---------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------------
 */

/** The document location every case starts from. */
const START_PATH = '/page';

/**
 * The `XMLHttpRequest` methods this file replaces with stubs.
 *
 * Saved and restored through `Reflect` rather than by naming each one: a
 * prototype method held for later restoration is exactly the unbound
 * reference `@typescript-eslint/unbound-method` exists to catch, and a loop
 * over the names it owns says what it is doing without three suppressions.
 */
const STUBBED_XHR_METHODS = ['open', 'send', 'setRequestHeader'] as const;

let originalFetch: typeof globalThis.fetch;
const originalXhrMethods = new Map<string, unknown>();
let originalPerformanceObserver: unknown;

beforeEach(() => {
  captured.length = 0;
  observeInits.length = 0;
  observerCallbacks.clear();

  document.head.innerHTML = '';
  history.pushState({}, '', START_PATH);

  originalFetch = globalThis.fetch;
  originalXhrMethods.clear();
  for (const name of STUBBED_XHR_METHODS) {
    originalXhrMethods.set(name, Reflect.get(XMLHttpRequest.prototype, name));
  }
  originalPerformanceObserver = (globalThis as { PerformanceObserver?: unknown })
    .PerformanceObserver;

  // Stubs installed *before* the patch, so the module under test wraps these
  // and no case reaches the network.
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response('', { status: 204 })));
  Reflect.set(XMLHttpRequest.prototype, 'open', function stubOpen(): void {
    // The state this module needs is recorded by its own patch.
  });
  Reflect.set(XMLHttpRequest.prototype, 'send', function stubSend(this: XMLHttpRequest): void {
    // Settled synchronously: the patch registers its `loadend` listener before
    // calling through, so the request's event is emitted inside `send`.
    this.dispatchEvent(new Event('loadend'));
  });
  Reflect.set(XMLHttpRequest.prototype, 'setRequestHeader', function stubSetRequestHeader(): void {
    // Headers are never asserted here; injection has its own suite.
  });
  (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = StubPerformanceObserver;
});

afterEach(() => {
  // The producers' own teardown first: `detachFetch` unwinds only its own
  // layer, so the platform's methods have to go back underneath it.
  detachFetch();
  detachPerf();

  globalThis.fetch = originalFetch;
  for (const [name, method] of originalXhrMethods) {
    Reflect.set(XMLHttpRequest.prototype, name, method);
  }
  (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver =
    originalPerformanceObserver;

  document.head.innerHTML = '';
  history.pushState({}, '', START_PATH);
});

/*
 * ---------------------------------------------------------------------------
 * `./fetch.ts` — the request identity
 * ---------------------------------------------------------------------------
 */

describe('request resource-timing identity', () => {
  it('resolves a relative URL to the absolute form the timing entry is named by', async () => {
    attachFetch();

    await globalThis.fetch('/api/items?productId=7');

    const attributes = onlyAttributes();
    // The display URL stays exactly as the caller wrote it: the service
    // computes `request_key` from it, and duplicate detection depends on that
    // digest (AAP 0.5.2).
    expect(attributes[URL_ATTRIBUTE]).toBe('/api/items?productId=7');
    expect(attributes[RESOURCE_TIMING_URL_ATTRIBUTE]).toBe(
      `${location.origin}/api/items?productId=7`,
    );
  });

  it('resolves against a document base, not the location', async () => {
    // The decisive identity case. A page carrying `<base href>` fetches
    // `item` and the platform requests — and times — `/base/item`; resolving
    // against `location.href` would name `/item`, an identity matching no
    // entry, and the bytes would be lost with no symptom but an empty column.
    document.head.innerHTML = '<base href="/base/">';
    attachFetch();

    await globalThis.fetch('item');

    expect(onlyAttributes()[RESOURCE_TIMING_URL_ATTRIBUTE]).toBe(`${location.origin}/base/item`);
  });

  it('keeps an absolute URL verbatim and strips a fragment', async () => {
    attachFetch();

    await globalThis.fetch('http://cdn.example/lib.js');
    expect(stringAttribute(onlyAttributes(), RESOURCE_TIMING_URL_ATTRIBUTE)).toBe(
      'http://cdn.example/lib.js',
    );

    captured.length = 0;
    // A fetch is issued without a fragment and no entry is named with one, so
    // leaving it on would break the match for a page that fetches a hash URL.
    await globalThis.fetch('/api/items#section');
    expect(onlyAttributes()[RESOURCE_TIMING_URL_ATTRIBUTE]).toBe(`${location.origin}/api/items`);
  });

  it('never reports a byte count, which only a timing entry can measure', async () => {
    attachFetch();

    await globalThis.fetch('/api/items');

    const attributes = onlyAttributes();
    expect(TRANSFER_SIZE_ATTRIBUTE in attributes).toBe(false);
    expect(TRANSFER_SIZE_EXPOSED_ATTRIBUTE in attributes).toBe(false);
  });

  it('identifies an XHR by the URL its open resolved, not its send', () => {
    // `XMLHttpRequest.open()` parses its URL against the base in force at that
    // moment and stores the result, so this request goes to — and is timed
    // as — `/before/item` even though the document has moved on by the time
    // `send()` runs. An identity resolved at send would name `/after/item`.
    history.pushState({}, '', '/before/page');
    attachFetch();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'item');
    history.pushState({}, '', '/after/page');
    xhr.send();

    const attributes = onlyAttributes();
    expect(attributes[RESOURCE_TIMING_URL_ATTRIBUTE]).toBe(`${location.origin}/before/item`);
    expect(attributes[URL_ATTRIBUTE]).toBe('item');
  });

  it('identifies an XHR against a document base too', () => {
    document.head.innerHTML = '<base href="/base/">';
    attachFetch();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'item');
    xhr.send();

    expect(onlyAttributes()[RESOURCE_TIMING_URL_ATTRIBUTE]).toBe(`${location.origin}/base/item`);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `./perf.ts` — the exposure verdict
 * ---------------------------------------------------------------------------
 */

describe('transfer-size exposure verdict', () => {
  it('certifies a same-origin entry, so a real zero travels as a measurement', () => {
    // A response served from cache transferred nothing. That is evidence, and
    // the same-origin route is what lets it be published instead of hidden
    // behind `n/a`.
    attachPerf();

    replay('resource', [
      entry({
        name: `${location.origin}/static/app.css`,
        transferSize: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
        nextHopProtocol: '',
        responseStatus: 0,
      }),
    ]);

    const attributes = onlyAttributes();
    expect(attributes[TRANSFER_SIZE_EXPOSED_ATTRIBUTE]).toBe(true);
    expect(attributes[TRANSFER_SIZE_ATTRIBUTE]).toBe(0);
  });

  it('refuses a CORS response without Timing-Allow-Origin, status and all', () => {
    // The discriminating case. `Access-Control-Allow-Origin` alone makes the
    // response readable, so Resource Timing exposes a real `responseStatus`
    // while the timing-allow check still withholds every byte count. A
    // predicate that trusted the status would certify this as a measurement of
    // zero bytes — the exact absence-as-observation AAP 0.8.4 forbids.
    attachPerf();

    replay('resource', [
      entry({
        name: 'http://cdn.example/lib.js',
        transferSize: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
        nextHopProtocol: '',
        responseStatus: 200,
      }),
    ]);

    const attributes = onlyAttributes();
    expect(attributes[TRANSFER_SIZE_EXPOSED_ATTRIBUTE]).toBe(false);
    // Omitted rather than sent as zero: this module's rule is a readable value
    // or no key at all.
    expect(TRANSFER_SIZE_ATTRIBUTE in attributes).toBe(false);
    expect(ENCODED_BODY_SIZE_ATTRIBUTE in attributes).toBe(false);
    expect(DECODED_BODY_SIZE_ATTRIBUTE in attributes).toBe(false);
  });

  it('certifies a cross-origin entry whose TAO-gated fields came through', () => {
    // `nextHopProtocol` is withheld with the sizes when the check fails, so a
    // non-empty one is proof it passed — unlike the status.
    attachPerf();

    replay('resource', [
      entry({
        name: 'http://cdn.example/lib.js',
        transferSize: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
        nextHopProtocol: 'h2',
        responseStatus: 200,
      }),
    ]);

    const attributes = onlyAttributes();
    expect(attributes[TRANSFER_SIZE_EXPOSED_ATTRIBUTE]).toBe(true);
    expect(attributes[TRANSFER_SIZE_ATTRIBUTE]).toBe(0);
  });

  it('certifies a cross-origin entry that reported bytes', () => {
    attachPerf();

    replay('resource', [
      entry({
        name: 'http://cdn.example/lib.js',
        transferSize: 4096,
        encodedBodySize: 4000,
        decodedBodySize: 9000,
      }),
    ]);

    const attributes = onlyAttributes();
    expect(attributes[TRANSFER_SIZE_EXPOSED_ATTRIBUTE]).toBe(true);
    expect(attributes[TRANSFER_SIZE_ATTRIBUTE]).toBe(4096);
    expect(attributes[ENCODED_BODY_SIZE_ATTRIBUTE]).toBe(4000);
    expect(attributes[DECODED_BODY_SIZE_ATTRIBUTE]).toBe(9000);
  });

  it('carries the verdict on the document’s own navigation entry', () => {
    attachPerf();

    replay('navigation', [entry({ name: `${location.origin}/`, transferSize: 0, duration: 120 })]);

    const attributes = onlyAttributes();
    expect(attributes[TRANSFER_SIZE_EXPOSED_ATTRIBUTE]).toBe(true);
    expect(attributes[TRANSFER_SIZE_ATTRIBUTE]).toBe(0);
  });

  it('emits the raw absolute URL the join matches on', () => {
    attachPerf();
    const url = `${location.origin}/api/items?productId=7`;

    replay('resource', [entry({ name: url, transferSize: 10, initiatorType: 'fetch' })]);

    const attributes = onlyAttributes();
    // Unredacted and unnormalised: the service redacts at ingest and needs the
    // raw form for `request_key` and for the join (AAP 0.5.2, 0.4.2).
    expect(attributes[URL_ATTRIBUTE]).toBe(url);
    expect(attributes['initiator.type']).toBe('fetch');
    expect(attributes['entry.type']).toBe('resource');
  });
});

/*
 * ---------------------------------------------------------------------------
 * `./perf.ts` — the capture boundary
 * ---------------------------------------------------------------------------
 */

describe('the capture boundary', () => {
  it('replays only the document-lifecycle entry types', () => {
    attachPerf();

    const buffered = observeInits
      .filter((init) => init.buffered === true)
      .map((init) => init.type)
      .sort();
    const unbuffered = observeInits
      .filter((init) => init.buffered === false)
      .map((init) => init.type)
      .sort();

    expect(observeInits).toHaveLength(OBSERVED_ENTRY_TYPES.length);
    expect(buffered).toStrictEqual([...BUFFERED_ENTRY_TYPES].sort());
    // The two continuous streams start empty, so a capture cannot open with up
    // to `MAX_ENTRIES_PER_TYPE` entries about a moment nobody asked about.
    expect(unbuffered).toStrictEqual(['longtask', 'resource']);
  });

  it('discards an entry that had finished before the capture was armed', () => {
    attachPerf();

    // `performance.timeOrigin + 0` is far in the past, so a zero-duration
    // entry at document-relative 0 ended long before this attachment began.
    replay('resource', [entry({ name: 'http://old.example/asset.js', duration: 0 })]);

    expect(captured).toStrictEqual([]);
    expect(getPerfStats().preCapture).toBe(1);
    // Charged to its own counter, never to the per-type bound: it was never
    // this capture's to hold, so it is not evidence the capture lost.
    expect(getPerfStats().dropped).toBe(0);
  });

  it('keeps an entry that was still running when the capture was armed', () => {
    attachPerf();

    replay('resource', [entry({ name: 'http://old.example/asset.js' })]);

    expect(captured).toHaveLength(1);
    expect(getPerfStats().preCapture).toBe(0);
  });

  it('exempts the replayed types, which is the whole point of replaying them', () => {
    attachPerf();

    replay('navigation', [entry({ name: `${location.origin}/`, duration: 0 })]);
    replay('paint', [entry({ name: 'first-contentful-paint', duration: 0 })]);

    expect(captured).toHaveLength(2);
    expect(getPerfStats().preCapture).toBe(0);
  });

  it('reports a boundary exactly while it is attached', () => {
    expect(getCaptureStartTime()).toBeUndefined();

    attachPerf();
    expect(isPerfAttached()).toBe(true);
    expect(getCaptureStartTime()).toBeDefined();

    detachPerf();
    expect(isPerfAttached()).toBe(false);
    expect(getCaptureStartTime()).toBeUndefined();
  });

  it('reports no boundary in a host with no Performance Timeline', () => {
    // The hook was asked for and the host cannot provide it. Reporting a
    // boundary here would describe a capture that never began.
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = undefined;

    attachPerf();

    expect(isPerfAttached()).toBe(false);
    expect(getCaptureStartTime()).toBeUndefined();
    expect([...getPerfStats().unavailable]).toStrictEqual([...OBSERVED_ENTRY_TYPES]);
  });

  it('reports no boundary when the host refuses every entry type', () => {
    class RefusingObserver extends StubPerformanceObserver {
      override observe(init: ObserveInit): void {
        observeInits.push(init);
        throw new TypeError(`"${init.type}" is not a supported entry type`);
      }
    }
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = RefusingObserver;

    attachPerf();

    expect(isPerfAttached()).toBe(false);
    expect(getCaptureStartTime()).toBeUndefined();
    // The availability report survives, because that is the value of this
    // state: "no long tasks" and "no long-task timing" are different answers
    // (AAP 0.5.5).
    expect([...getPerfStats().unavailable]).toStrictEqual([...OBSERVED_ENTRY_TYPES]);
  });
});
