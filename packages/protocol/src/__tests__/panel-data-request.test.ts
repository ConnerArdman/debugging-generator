/**
 * Tests for the `POST /sessions/:id/panel-data` request body,
 * `panelDataRequestSchema` in `../http.ts`: a panel node's own `DataQuery`
 * plus the optional `panelId` of the panel specification it was rendered from.
 *
 * What is on trial is the one field this package adds to panel-schema's query
 * and the two properties the extension must not cost it:
 *
 * - **`panelId` is optional, opaque and bounded.** Present, it names which
 *   panel's capture the service answers from, so it must be a non-empty string
 *   of at most sixty-four characters — the bound every identifier in the route
 *   module carries. Absent, the body is a live read; a bare `DataQuery` must
 *   therefore stay a valid body exactly as it is.
 * - **The object stays strict.** Extending a strict object must not turn it
 *   into one that strips an unknown key: a producer that invented `captureId`,
 *   or tucked the panel id into the filter, must be told so rather than have
 *   the field silently dropped and the read quietly answered from live evidence.
 * - **No default is applied.** The parsed body equals what was sent, key for
 *   key — an omitted `limit`, `offset` or `panelId` stays omitted, because the
 *   service applies the paging defaults and an invented `panelId` would bind a
 *   live read to a panel nobody asked for.
 *
 * `parseHttpRequest('panel.data', …)` — the entry both the service's route and
 * the protocol's HTTP client validate through — is held to the same verdicts,
 * and a refusal names the offending field without echoing its value (AAP
 * §0.5.2).
 */

import { describe, expect, it, vi } from 'vitest';

import { HttpClient } from '../client/http-client.js';
import type { FetchLike, HttpResponseLike } from '../client/http-client.js';
import { HTTP_ROUTES, panelDataPath, panelDataRequestSchema, parseHttpRequest } from '../http.js';
import type { PanelDataRequest } from '../http.js';

/** A panel id in the form the product mints: a prefix and sixteen alphanumerics. */
const PANEL_ID = 'pnl_7Qm2Xc9LpR4tVz1B';

/** The longest `panelId` the route accepts — the module's identifier bound. */
const MAX_PANEL_ID_LENGTH = 64;

/** Distinctive text for the leak checks: it must never appear in a refusal. */
const SENTINEL = 'sentinel-panel-identity-value';

/** The session the client cases address. */
const SESSION_ID = 'ses_4Vq8Lm2Xc9RpT1zB';

/** The loopback origin the client cases send to. */
const ORIGIN = 'http://127.0.0.1:43117';

/** A valid `spans` answer: an empty last page. */
const EMPTY_SPANS_PAGE = {
  source: 'spans',
  spans: [],
  total: 0,
  limit: 25,
  offset: 0,
  nextOffset: null,
} as const;

/**
 * A fake transport that answers every call with an empty `spans` page.
 *
 * @returns A spy satisfying {@link FetchLike}.
 */
function answeringFetch() {
  const response: HttpResponseLike = {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(EMPTY_SPANS_PAGE)),
  };
  return vi.fn<FetchLike>(() => Promise.resolve(response));
}

/** Valid bodies without a panel identity: live reads. */
const LIVE_BODIES: readonly PanelDataRequest[] = [
  { source: 'spans' },
  { source: 'trace', filter: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' } },
  { source: 'renders', sort: 'count_desc', limit: 0 },
  { source: 'events', filter: { kinds: ['fetch', 'db.query'] }, limit: 25, offset: 50 },
  { source: 'metrics' },
];

/** The same bodies, each bound to the panel it was rendered from. */
const PANEL_BOUND_BODIES: readonly PanelDataRequest[] = LIVE_BODIES.map((body) => ({
  ...body,
  panelId: PANEL_ID,
}));

/** Bodies the route must refuse, each for one reason. */
const REFUSED_BODIES: readonly { readonly name: string; readonly body: unknown }[] = [
  { name: 'an empty panelId', body: { source: 'spans', panelId: '' } },
  {
    name: 'a panelId over the identifier bound',
    body: { source: 'spans', panelId: 'p'.repeat(MAX_PANEL_ID_LENGTH + 1) },
  },
  { name: 'a numeric panelId', body: { source: 'spans', panelId: 42 } },
  { name: 'a null panelId', body: { source: 'spans', panelId: null } },
  { name: 'a boolean panelId', body: { source: 'spans', panelId: true } },
  { name: 'an object panelId', body: { source: 'spans', panelId: { id: PANEL_ID } } },
  { name: 'an array panelId', body: { source: 'spans', panelId: [PANEL_ID] } },
  { name: 'an unknown top-level key', body: { source: 'spans', captureId: 'cap_1' } },
  {
    name: 'a panel id inside the filter',
    body: { source: 'spans', filter: { panelId: PANEL_ID } },
  },
  {
    name: 'a query wrapped under `query`',
    body: { query: { source: 'spans' }, panelId: PANEL_ID },
  },
  { name: 'a panelId with no query', body: { panelId: PANEL_ID } },
];

describe('panelDataRequestSchema — the panel-data request body', () => {
  it('is the schema the route table binds for panel.data', () => {
    expect(HTTP_ROUTES['panel.data'].request).toBe(panelDataRequestSchema);
  });

  it('accepts a DataQuery without a panelId, unchanged', () => {
    for (const body of LIVE_BODIES) {
      const parsed = panelDataRequestSchema.safeParse(body);

      expect(parsed.success, body.source).toBe(true);
      expect(parsed.data).toStrictEqual(body);
      expect(parsed.data !== undefined && 'panelId' in parsed.data).toBe(false);
    }
  });

  it('accepts a DataQuery with a panelId, unchanged', () => {
    for (const body of PANEL_BOUND_BODIES) {
      const parsed = panelDataRequestSchema.safeParse(body);

      expect(parsed.success, body.source).toBe(true);
      expect(parsed.data).toStrictEqual(body);
      expect(parsed.data?.panelId).toBe(PANEL_ID);
    }
  });

  it('accepts a panelId exactly at the identifier bound, and one character', () => {
    const atBound = { source: 'spans', panelId: 'p'.repeat(MAX_PANEL_ID_LENGTH) };
    const single = { source: 'spans', panelId: 'p' };

    expect(panelDataRequestSchema.safeParse(atBound).success).toBe(true);
    expect(panelDataRequestSchema.safeParse(single).success).toBe(true);
  });

  it('applies no default: an omitted limit, offset or panelId stays omitted', () => {
    const parsed = panelDataRequestSchema.parse({ source: 'requests' });

    expect(Object.keys(parsed)).toEqual(['source']);
  });

  it.each(REFUSED_BODIES)('refuses $name', ({ body }) => {
    expect(panelDataRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("parseHttpRequest('panel.data', …)", () => {
  it('agrees with the schema on every accepted body, and returns it unchanged', () => {
    for (const body of [...LIVE_BODIES, ...PANEL_BOUND_BODIES]) {
      const parsed = parseHttpRequest('panel.data', body);

      expect(parsed.ok, body.source).toBe(true);
      expect(parsed.ok && parsed.value).toStrictEqual(body);
    }
  });

  it.each(REFUSED_BODIES)('agrees with the schema in refusing $name', ({ body }) => {
    const parsed = parseHttpRequest('panel.data', body);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? undefined : parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('names a refused panelId by its path and never echoes its value', () => {
    const overLong = `${SENTINEL}-${'x'.repeat(MAX_PANEL_ID_LENGTH)}`;
    const parsed = parseHttpRequest('panel.data', { source: 'spans', panelId: overLong });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    const rendered = JSON.stringify({
      message: parsed.error.message,
      hint: parsed.error.hint,
      details: parsed.error.details,
    });

    expect(rendered).toContain('panelId');
    expect(rendered).not.toContain(SENTINEL);
  });
});

describe("HttpClient.request('panel.data', …) — what reaches the wire", () => {
  it('posts a panel-bound body with its panelId, field for field', async () => {
    const fetch = answeringFetch();
    const client = new HttpClient({ baseUrl: ORIGIN, token: 'tok-devtools-1', fetch });
    const body: PanelDataRequest = { source: 'spans', limit: 25, offset: 0, panelId: PANEL_ID };

    const result = await client.request('panel.data', { params: { id: SESSION_ID }, body });

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}${panelDataPath(SESSION_ID)}`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body ?? 'null')).toStrictEqual(body);
  });

  it('posts a live read with no panelId key at all', async () => {
    const fetch = answeringFetch();
    const client = new HttpClient({ baseUrl: ORIGIN, token: 'tok-devtools-1', fetch });

    await client.request('panel.data', {
      params: { id: SESSION_ID },
      body: { source: 'spans', limit: 25, offset: 0 },
    });

    const init = fetch.mock.calls[0]?.[1];
    const sent: unknown = JSON.parse(init?.body ?? 'null');
    expect(sent).toStrictEqual({ source: 'spans', limit: 25, offset: 0 });
  });

  it('refuses an unusable panelId before anything is sent', async () => {
    const fetch = answeringFetch();
    const client = new HttpClient({ baseUrl: ORIGIN, token: 'tok-devtools-1', fetch });

    const result = await client.request('panel.data', {
      params: { id: SESSION_ID },
      body: { source: 'spans', panelId: '' },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(fetch).not.toHaveBeenCalled();
  });
});
