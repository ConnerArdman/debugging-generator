/**
 * Tests for the span status a browser request event carries: what
 * `./fetch.ts` reports when a `fetch` or an `XMLHttpRequest` settles.
 *
 * ## The rule under test
 *
 * A browser request span is the **client** side of an HTTP exchange, and the
 * OpenTelemetry HTTP semantic conventions set span status Error on a client
 * span for every 4xx and 5xx answer. So:
 *
 * - an answer below 400 — 200, 301, 304 — is `ok`;
 * - an answer of 400 or above — 404, 500 — is `error`, and still carries its
 *   `http.status_code`;
 * - an answer that exposes no code (an `opaque` response) arrived and is `ok`;
 * - a request that got no answer — a network error, a timeout, an abort — is
 *   `error` with no status code, and an abort is marked `aborted`.
 *
 * ## What must not change with it
 *
 * The status used to be `ok` for every answer that arrived, and two behaviours
 * keyed on "the answer arrived" rather than on a success. They must still do
 * so for an error answer:
 *
 * - **The clock sample.** A same-origin 500 was produced by the dev server just
 *   then, so its `Date` feeds the document's `clockOffsetMs` exactly as a
 *   200's does.
 * - **The continuation window.** A traced request that is answered 500 still
 *   opens the window that attributes the React work rendering the failure to
 *   the request that failed (AAP 0.4.2).
 *
 * ## How the page is simulated
 *
 * As in `./in-flight-requests.test.ts`: `fetch` and the three
 * `XMLHttpRequest` prototype methods are replaced with stubs **before** the
 * patch is installed, so the module under test wraps the stub and nothing
 * reaches a network. A case decides the answer: the stubbed `fetch` resolves
 * or rejects with what the case hands it, and an XHR is settled by the case
 * dispatching its terminal events itself. `./transport.ts` is mocked at `emit`
 * only, forwarding to the real implementation, so every draft the patch
 * produced is read exactly as it was handed over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventDraft } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * The transport seam
 * ---------------------------------------------------------------------------
 */

/** Every draft handed to the transport, in order. */
const drafts: EventDraft[] = [];

vi.mock('./transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport.js')>();
  return {
    ...actual,
    emit: (draft: EventDraft): void => {
      drafts.push(draft);
      actual.emit(draft);
    },
  };
});

const { attachFetch, detachFetch, getFetchStats } = await import('./fetch.js');
const { attachInteractions, detachInteractions } = await import('./interaction.js');
const { getContinuationStats, getLineage, resetContinuations } = await import('./continuation.js');
const { getClockOffsetStats, resetTransport } = await import('./transport.js');

/*
 * ---------------------------------------------------------------------------
 * Vocabulary
 *
 * Neutral: nothing below names a route or component of any particular
 * project.
 * ---------------------------------------------------------------------------
 */

/** The response status code key, as the `fetch` / `xhr` vocabulary spells it. */
const STATUS_CODE_ATTRIBUTE = 'http.status_code';

/** The key present and `true` on an aborted request. */
const ABORTED_ATTRIBUTE = 'aborted';

/** The key carrying `Response.type`. */
const RESPONSE_TYPE_ATTRIBUTE = 'response.type';

/** A path on the document's own origin; relative, as an application writes it. */
const SAME_ORIGIN_PATH = '/api/items';

/** The `XMLHttpRequest` methods replaced with stubs. */
const STUBBED_XHR_METHODS = ['open', 'send', 'setRequestHeader'] as const;

/** Answers below 400: the exchange succeeded, or was redirected / revalidated. */
const OK_STATUS_CODES = [200, 301, 304] as const;

/** Answers of 400 and above: the client did not get what it asked for. */
const ERROR_STATUS_CODES = [404, 500] as const;

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * The request drafts of one kind, in emission order.
 *
 * @param kind `fetch` or `xhr`.
 * @returns The drafts the patch emitted for that transport.
 */
function requestDrafts(kind: 'fetch' | 'xhr'): EventDraft[] {
  return drafts.filter((draft) => draft.kind === kind);
}

/**
 * The single request draft of one kind, failing when there is not exactly one.
 *
 * @param kind `fetch` or `xhr`.
 * @returns The draft.
 */
function onlyRequestDraft(kind: 'fetch' | 'xhr'): EventDraft {
  const found = requestDrafts(kind);
  expect(found).toHaveLength(1);
  const [draft] = found;
  if (draft === undefined) {
    throw new Error(`no ${kind} draft was emitted`);
  }
  return draft;
}

/**
 * A response as the network would hand it to the page, with the final URL a
 * real response carries — a constructed `Response` has an empty `url`, and the
 * clock sample judges it.
 *
 * @param status The answer's status code.
 * @param headers Its headers.
 * @returns The response.
 */
function networkResponse(status: number, headers: Record<string, string> = {}): Response {
  const response = new Response(null, { status, headers });
  Object.defineProperty(response, 'url', {
    value: new URL(SAME_ORIGIN_PATH, window.location.href).href,
  });
  return response;
}

/**
 * A whole-second `Date` value at the page clock's current reading.
 *
 * @returns The IMF-fixdate spelling a server would send.
 */
function serverDateNow(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toUTCString();
}

/**
 * Settle an XHR the way the platform does: the terminal event, when there is
 * one, then `loadend`.
 *
 * @param xhr A sent request.
 * @param answer The status code the request ended with, or the terminal event
 *   that ended it without an answer.
 */
function settleXhr(
  xhr: XMLHttpRequest,
  answer: { readonly status: number } | { readonly terminal: 'error' | 'timeout' | 'abort' },
): void {
  if ('status' in answer) {
    Object.defineProperty(xhr, 'status', { value: answer.status });
    Object.defineProperty(xhr, 'responseURL', {
      value: new URL(SAME_ORIGIN_PATH, window.location.href).href,
    });
  } else {
    xhr.dispatchEvent(new Event(answer.terminal));
  }
  xhr.dispatchEvent(new Event('loadend'));
}

/**
 * Open and send one same-origin XHR through the patch.
 *
 * @returns The sent request, not yet settled.
 */
function sendXhr(): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', SAME_ORIGIN_PATH);
  xhr.send();
  return xhr;
}

/**
 * Run `action` inside a user interaction, the way a developer's click handler
 * runs: the patch's capture-phase listener opens the interaction window first,
 * so a request started here is traced and registers a pending continuation.
 *
 * @param action What the handler does.
 */
function duringClick(action: () => void): void {
  const handler = (): void => {
    action();
  };
  window.addEventListener('click', handler);
  try {
    window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  } finally {
    window.removeEventListener('click', handler);
  }
}

/*
 * ---------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------------
 */

let originalFetch: typeof globalThis.fetch;
const originalXhrMethods = new Map<string, unknown>();

/** What the stubbed `fetch` answers the next call with. */
let nextAnswer: () => Promise<Response>;

beforeEach(() => {
  drafts.length = 0;
  resetTransport();
  resetContinuations();

  originalFetch = globalThis.fetch;
  originalXhrMethods.clear();
  for (const name of STUBBED_XHR_METHODS) {
    originalXhrMethods.set(name, Reflect.get(XMLHttpRequest.prototype, name));
  }
  nextAnswer = (): Promise<Response> => Promise.resolve(networkResponse(200));
  globalThis.fetch = vi.fn(() => nextAnswer());
  Reflect.set(XMLHttpRequest.prototype, 'open', function stubOpen(): void {
    // The state the patch needs is recorded by its own `open` wrapper.
  });
  Reflect.set(XMLHttpRequest.prototype, 'send', function stubSend(): void {
    // Settled by the case, which dispatches the terminal events itself.
  });
  Reflect.set(XMLHttpRequest.prototype, 'setRequestHeader', function stubSetHeader(): void {
    // Injection is not under test here.
  });

  attachFetch();
});

afterEach(() => {
  // The patch first, so each original goes back underneath it.
  detachInteractions();
  detachFetch();
  resetContinuations();
  resetTransport();
  vi.restoreAllMocks();

  globalThis.fetch = originalFetch;
  for (const [name, method] of originalXhrMethods) {
    Reflect.set(XMLHttpRequest.prototype, name, method);
  }
});

/*
 * ---------------------------------------------------------------------------
 * `fetch`
 * ---------------------------------------------------------------------------
 */

describe('the status of a fetch span', () => {
  it.each(OK_STATUS_CODES)('is ok for an answer of %i, which keeps its code', async (code) => {
    const response = networkResponse(code);
    nextAnswer = (): Promise<Response> => Promise.resolve(response);

    // The application receives the very response the network produced.
    await expect(globalThis.fetch(SAME_ORIGIN_PATH)).resolves.toBe(response);

    const draft = onlyRequestDraft('fetch');
    expect(draft.status).toBe('ok');
    expect(draft.attributes[STATUS_CODE_ATTRIBUTE]).toBe(code);
    expect(draft.attributes).not.toHaveProperty(ABORTED_ATTRIBUTE);
    expect(getFetchStats().failures).toBe(0);
  });

  it.each(ERROR_STATUS_CODES)(
    'is error for an answer of %i, which keeps its code',
    async (code) => {
      const response = networkResponse(code);
      nextAnswer = (): Promise<Response> => Promise.resolve(response);

      // An error answer is still an answer: it resolves, unchanged.
      await expect(globalThis.fetch(SAME_ORIGIN_PATH)).resolves.toBe(response);

      const draft = onlyRequestDraft('fetch');
      expect(draft.status).toBe('error');
      expect(draft.attributes[STATUS_CODE_ATTRIBUTE]).toBe(code);
      expect(draft.attributes).not.toHaveProperty(ABORTED_ATTRIBUTE);
      expect(getFetchStats().failures).toBe(0);
    },
  );

  it('is ok for an opaque answer, which exposes no code', async () => {
    // A `no-cors` answer reports status 0 by specification, which a
    // constructed `Response` refuses, so the network's object is stood in for.
    const opaque = {
      status: 0,
      type: 'opaque',
      url: '',
      headers: new Headers(),
    } as unknown as Response;
    nextAnswer = (): Promise<Response> => Promise.resolve(opaque);

    await expect(globalThis.fetch('https://third-party.example/pixel')).resolves.toBe(opaque);

    const draft = onlyRequestDraft('fetch');
    expect(draft.status).toBe('ok');
    expect(draft.attributes).not.toHaveProperty(STATUS_CODE_ATTRIBUTE);
    expect(draft.attributes[RESPONSE_TYPE_ATTRIBUTE]).toBe('opaque');
  });

  it('is error with no code for a network failure, rethrown unchanged', async () => {
    const refusal = new TypeError('the network refused the request');
    nextAnswer = (): Promise<Response> => Promise.reject(refusal);

    await expect(globalThis.fetch(SAME_ORIGIN_PATH)).rejects.toBe(refusal);

    const draft = onlyRequestDraft('fetch');
    expect(draft.status).toBe('error');
    expect(draft.attributes).not.toHaveProperty(STATUS_CODE_ATTRIBUTE);
    expect(draft.attributes).not.toHaveProperty(ABORTED_ATTRIBUTE);
  });

  it('is error with no code for an abort, and says it was aborted', async () => {
    const abort = new DOMException('the application aborted the request', 'AbortError');
    nextAnswer = (): Promise<Response> => Promise.reject(abort);

    await expect(globalThis.fetch(SAME_ORIGIN_PATH)).rejects.toBe(abort);

    const draft = onlyRequestDraft('fetch');
    expect(draft.status).toBe('error');
    expect(draft.attributes).not.toHaveProperty(STATUS_CODE_ATTRIBUTE);
    expect(draft.attributes[ABORTED_ATTRIBUTE]).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `XMLHttpRequest`
 * ---------------------------------------------------------------------------
 */

describe('the status of an XMLHttpRequest span', () => {
  it.each(OK_STATUS_CODES)('is ok for an answer of %i, which keeps its code', (code) => {
    settleXhr(sendXhr(), { status: code });

    const draft = onlyRequestDraft('xhr');
    expect(draft.status).toBe('ok');
    expect(draft.attributes[STATUS_CODE_ATTRIBUTE]).toBe(code);
    expect(draft.attributes).not.toHaveProperty(ABORTED_ATTRIBUTE);
    expect(getFetchStats().failures).toBe(0);
  });

  it.each(ERROR_STATUS_CODES)('is error for an answer of %i, which keeps its code', (code) => {
    settleXhr(sendXhr(), { status: code });

    const draft = onlyRequestDraft('xhr');
    expect(draft.status).toBe('error');
    expect(draft.attributes[STATUS_CODE_ATTRIBUTE]).toBe(code);
    expect(draft.attributes).not.toHaveProperty(ABORTED_ATTRIBUTE);
    expect(getFetchStats().failures).toBe(0);
  });

  it.each(['error', 'timeout'] as const)(
    'is error with no code when it ended with %s and no answer',
    (terminal) => {
      settleXhr(sendXhr(), { terminal });

      const draft = onlyRequestDraft('xhr');
      expect(draft.status).toBe('error');
      expect(draft.attributes).not.toHaveProperty(STATUS_CODE_ATTRIBUTE);
      expect(draft.attributes).not.toHaveProperty(ABORTED_ATTRIBUTE);
    },
  );

  it('is error with no code for an abort, and says it was aborted', () => {
    settleXhr(sendXhr(), { terminal: 'abort' });

    const draft = onlyRequestDraft('xhr');
    expect(draft.status).toBe('error');
    expect(draft.attributes).not.toHaveProperty(STATUS_CODE_ATTRIBUTE);
    expect(draft.attributes[ABORTED_ATTRIBUTE]).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * What keys on the answer arriving, not on its status
 * ---------------------------------------------------------------------------
 */

describe('an error answer that arrived', () => {
  it('still feeds the clock offset from a same-origin fetch answered 500', async () => {
    const before = getClockOffsetStats();
    nextAnswer = (): Promise<Response> =>
      Promise.resolve(networkResponse(500, { date: serverDateNow() }));

    await globalThis.fetch(SAME_ORIGIN_PATH);

    const after = getClockOffsetStats();
    expect(after.samples - before.samples).toBe(1);
    expect(after.rejected - before.rejected).toBe(0);
    expect(after.accepted + after.resets - (before.accepted + before.resets)).toBe(1);
    expect(after.offsetMs).toBeDefined();
    expect(onlyRequestDraft('fetch').status).toBe('error');
    expect(getFetchStats().failures).toBe(0);
  });

  it('still feeds the clock offset from a same-origin XMLHttpRequest answered 500', () => {
    const before = getClockOffsetStats();
    const date = serverDateNow();
    const readHeader = vi.fn((name: string): string | null =>
      name.toLowerCase() === 'date' ? date : null,
    );

    const xhr = sendXhr();
    Object.defineProperty(xhr, 'getResponseHeader', { value: readHeader });
    settleXhr(xhr, { status: 500 });

    const after = getClockOffsetStats();
    expect(after.samples - before.samples).toBe(1);
    expect(after.rejected - before.rejected).toBe(0);
    expect(readHeader.mock.calls.map(([name]) => name)).toEqual(['age', 'date']);
    expect(onlyRequestDraft('xhr').status).toBe('error');
  });

  it('takes no clock sample from a request that got no answer', async () => {
    const before = getClockOffsetStats();
    const readHeader = vi.fn((): string => serverDateNow());

    nextAnswer = (): Promise<Response> => Promise.reject(new TypeError('offline'));
    await expect(globalThis.fetch(SAME_ORIGIN_PATH)).rejects.toThrow('offline');

    const xhr = sendXhr();
    Object.defineProperty(xhr, 'getResponseHeader', { value: readHeader });
    settleXhr(xhr, { terminal: 'error' });

    expect(readHeader).not.toHaveBeenCalled();
    expect(getClockOffsetStats().samples).toBe(before.samples);
  });

  it('still opens the continuation window of a traced fetch answered 500', async () => {
    attachInteractions();
    nextAnswer = (): Promise<Response> => Promise.resolve(networkResponse(500));

    let pending: Promise<Response> | undefined;
    duringClick(() => {
      pending = globalThis.fetch(SAME_ORIGIN_PATH);
    });
    if (pending === undefined) {
      throw new Error('the click handler made no request');
    }
    // Registered while on the wire, as a traced request is.
    expect(getContinuationStats()).toMatchObject({ pending: 1, open: 0 });
    await pending;

    const draft = onlyRequestDraft('fetch');
    expect(draft.status).toBe('error');
    expect(draft.attributes[STATUS_CODE_ATTRIBUTE]).toBe(500);
    expect(getContinuationStats()).toMatchObject({ pending: 0, open: 1, settled: 1 });
    // The work that renders the failure hangs from the request that failed.
    expect(getLineage()).toMatchObject({ traceId: draft.traceId, parentSpanId: draft.spanId });
  });

  it('still opens the continuation window of a traced XMLHttpRequest answered 404', () => {
    attachInteractions();

    let xhr: XMLHttpRequest | undefined;
    duringClick(() => {
      xhr = sendXhr();
    });
    if (xhr === undefined) {
      throw new Error('the click handler made no request');
    }
    expect(getContinuationStats()).toMatchObject({ pending: 1, open: 0 });
    settleXhr(xhr, { status: 404 });

    const draft = onlyRequestDraft('xhr');
    expect(draft.status).toBe('error');
    expect(getContinuationStats()).toMatchObject({ pending: 0, open: 1, settled: 1 });
    expect(getLineage()).toMatchObject({ traceId: draft.traceId, parentSpanId: draft.spanId });
  });
});
