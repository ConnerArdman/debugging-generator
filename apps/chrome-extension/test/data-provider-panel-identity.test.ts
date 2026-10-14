/**
 * Tests for the DevTools panel's `DataProvider`, `../src/panel/data-provider.ts`,
 * on the one property that decides which evidence a panel node draws: the
 * identity of the panel the node belongs to.
 *
 * A node's `DataQuery` names neither a capture nor a panel. The rendered panel
 * does — `../src/panel/components/PanelView.tsx` binds the provider to the
 * specification's own `id` with the renderer's `bindPanelIdentity` — and that
 * id must reach the `panelData.query` port payload, which the service worker
 * forwards verbatim as the `POST /sessions/:id/panel-data` body. If it were
 * dropped anywhere on the way, the service would answer from live evidence and
 * an older panel on screen would draw a newer capture under its own findings.
 * So the cases hold:
 *
 * - a `panelId` in the call's options reaches the payload's body beside the
 *   normalised query, and the body is one the protocol's route schema accepts;
 * - the `panelId` does not displace the call's `signal`: the caller can still
 *   cancel a panel-bound read. The provider coalesces identical requests, so
 *   what reaches the request function is a signal of its own, shared by every
 *   caller of that request, and it aborts once its last caller has aborted;
 * - a call with no `panelId` sends no `panelId` key — a live read;
 * - a present but unusable `panelId` is a typed `PANEL_INVALID` rejection and
 *   nothing is sent, rather than a silent downgrade to a live read, and the
 *   refusal says only that the query was panel-bound, never which panel.
 *
 * The last group renders `PanelView` itself over this provider, so the whole
 * client half is exercised end to end: a specification's `id`, through
 * `PanelHost` and the renderer's query hook, to the payload a node's query
 * sends — and a newer panel version sending its own id.
 *
 * The request function is injected, exactly as `../src/panel/App.tsx` injects
 * `panelRequest`, so no port, worker or `chrome.*` API is involved.
 */

import { bindPanelIdentity } from '@debuggen/panel-renderer';
import type { DataQueryOptions, PanelHostActions } from '@debuggen/panel-renderer';
import { PANEL_SPEC_VERSION } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import { parseHttpRequest } from '@debuggen/protocol';
import type { DataResult } from '@debuggen/protocol';
import { DebuggenError } from '@debuggen/shared';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanelView } from '../src/panel/components/PanelView';
import { createPanelDataProvider } from '../src/panel/data-provider';
import type { PanelDataRequestFunction } from '../src/panel/data-provider';

/** The session the panel shows and every query is addressed to. */
const SESSION_ID = 'ses_4Vq8Lm2Xc9RpT1zB';

/** The rendered panel's id, in the form the product mints. */
const PANEL_ID = 'pnl_7Qm2Xc9LpR4tVz1B';

/** Distinctive text for the leak checks: it must never appear in a refusal. */
const SENTINEL = 'sentinel-panel-identity-value';

/** A newer version of the same session's panel, as a follow-up stores it. */
const NEXT_PANEL_ID = 'pnl_9Hs3Kd7WqN2cYx5E';

/** The query the node carries: one page of spans. */
const SPANS_QUERY = { source: 'spans', limit: 25, offset: 0 } as const;

/**
 * A validated, normalized specification with one query-backed view: a span
 * table over one page of spans.
 *
 * @param id The panel's own id.
 * @param panelVersion Its version within the session.
 * @returns A fresh specification.
 */
function tableSpec(id: string, panelVersion: number): PanelSpec {
  return {
    version: PANEL_SPEC_VERSION,
    id,
    sessionId: SESSION_ID,
    panelVersion,
    title: 'Where the time went',
    summary: { observed: [], likelyCauses: [] },
    layout: [{ type: 'table', id: 'layout.0', query: { ...SPANS_QUERY } }],
  };
}

/** Actions that do nothing: these cases are about data, not interactions. */
const NO_ACTIONS: PanelHostActions = {
  selectEvent: () => undefined,
  openSource: () => undefined,
};

/**
 * The worker's answer to every query: the service's empty last page of spans.
 *
 * @returns A fresh wire-form result.
 */
function emptySpansPage(): DataResult {
  return { source: 'spans', spans: [], total: 0, limit: 25, offset: 0, nextOffset: null };
}

/**
 * A provider over a recording request function, bound to {@link SESSION_ID}.
 *
 * @returns The provider and the request spy it sends through.
 */
function harness() {
  const request = vi.fn<PanelDataRequestFunction>(() => Promise.resolve(emptySpansPage()));
  const provider = createPanelDataProvider({ request, getSessionId: () => SESSION_ID });
  return { provider, request };
}

/**
 * The payload of the only port request a spy received.
 *
 * @param request The request spy, called exactly once.
 * @returns The `panelData.query` payload.
 */
function onlyPayload(request: ReturnType<typeof harness>['request']) {
  expect(request).toHaveBeenCalledTimes(1);
  const call = request.mock.calls[0];
  if (call === undefined) {
    throw new Error('no port request was sent');
  }
  expect(call[0]).toBe('panelData.query');
  return call[1];
}

/**
 * Await a refusal and return it as a `DebuggenError`.
 *
 * @param pending A call expected to reject with a typed error.
 * @returns The rejection.
 */
async function refusal(pending: Promise<unknown>): Promise<DebuggenError> {
  const outcome = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(outcome).toBeInstanceOf(DebuggenError);
  if (!DebuggenError.is(outcome)) {
    throw new Error('the call did not reject with a DebuggenError');
  }
  return outcome;
}

describe('the panel data provider — the panel identity on the port payload', () => {
  it('sends a panelId from the call options in the body, beside the normalised query', async () => {
    const { provider, request } = harness();
    const controller = new AbortController();

    const response = await provider.query(SESSION_ID, SPANS_QUERY, {
      signal: controller.signal,
      panelId: PANEL_ID,
    });

    const payload = onlyPayload(request);
    expect(payload).toStrictEqual({
      sessionId: SESSION_ID,
      query: { source: 'spans', limit: 25, offset: 0, panelId: PANEL_ID },
    });
    // A signal is forwarded with the panel-bound body: the provider's own for
    // this (coalescable) request, which the caller's signal controls — see the
    // cancellation case below.
    expect(request.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    // The body the worker forwards is one the route's own schema accepts.
    expect(parseHttpRequest('panel.data', payload.query)).toMatchObject({
      ok: true,
      value: payload.query,
    });
    expect(response).toStrictEqual({
      source: 'spans',
      data: [],
      total: 0,
      limit: 25,
      offset: 0,
      nextOffset: null,
    });
  });

  it('cancels a panel-bound request when its caller’s signal aborts', async () => {
    // A worker that never answers, so the request is still in flight when the caller leaves.
    const request = vi.fn<PanelDataRequestFunction>(() => new Promise<DataResult>(() => undefined));
    const provider = createPanelDataProvider({ request, getSessionId: () => SESSION_ID });
    const controller = new AbortController();

    const pending = provider.query(SESSION_ID, SPANS_QUERY, {
      signal: controller.signal,
      panelId: PANEL_ID,
    });

    expect(onlyPayload(request).query).toMatchObject({ panelId: PANEL_ID });
    const forwarded = request.mock.calls[0]?.[2]?.signal;
    expect(forwarded?.aborted).toBe(false);

    controller.abort();

    const error = await refusal(pending);
    expect(error.details).toMatchObject({ source: 'spans', reason: 'aborted' });
    expect(forwarded?.aborted).toBe(true);
    expect(provider.pendingCount()).toBe(0);
  });

  it('sends the bound panel id for every node of a panel bound with bindPanelIdentity', async () => {
    const { provider, request } = harness();
    const panelProvider = bindPanelIdentity(provider, PANEL_ID);

    await panelProvider.query(SESSION_ID, { source: 'spans', sort: 'duration_desc' });

    expect(onlyPayload(request).query).toStrictEqual({
      source: 'spans',
      sort: 'duration_desc',
      limit: 200,
      offset: 0,
      panelId: PANEL_ID,
    });
  });

  it('sends no panelId key for a live read', async () => {
    const { provider, request } = harness();

    await provider.query(SESSION_ID, SPANS_QUERY);
    await provider.query(SESSION_ID, SPANS_QUERY, { panelId: undefined });

    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls) {
      expect(Object.hasOwn(call[1].query, 'panelId')).toBe(false);
      expect(call[1].query).toStrictEqual({ source: 'spans', limit: 25, offset: 0 });
    }
  });

  it('leaves the caller’s query object untouched', async () => {
    const { provider } = harness();
    const query = { source: 'spans' as const };

    await provider.query(SESSION_ID, query, { panelId: PANEL_ID });

    expect(query).toStrictEqual({ source: 'spans' });
  });

  it.each(['', '   ', '\n'])(
    'refuses the blank panelId %j with PANEL_INVALID and sends nothing',
    async (blank) => {
      const { provider, request } = harness();

      const error = await refusal(provider.query(SESSION_ID, SPANS_QUERY, { panelId: blank }));

      expect(error.code).toBe('PANEL_INVALID');
      expect(error.hint?.length ?? 0).toBeGreaterThan(0);
      expect(error.details).toStrictEqual({ source: 'spans', panelBound: true, panelId: 'blank' });
      expect(request).not.toHaveBeenCalled();
      expect(provider.pendingCount()).toBe(0);
    },
  );

  it('refuses a non-string panelId by its kind, without echoing it, and sends nothing', async () => {
    const { provider, request } = harness();
    const untyped = { panelId: { id: SENTINEL } } as unknown as DataQueryOptions;

    const error = await refusal(provider.query(SESSION_ID, SPANS_QUERY, untyped));

    expect(error.code).toBe('PANEL_INVALID');
    expect(error.details).toStrictEqual({ source: 'spans', panelBound: true, panelId: 'object' });
    expect(
      JSON.stringify({ message: error.message, hint: error.hint, details: error.details }),
    ).not.toContain(SENTINEL);
    expect(request).not.toHaveBeenCalled();
  });

  it('never names the panel in a refusal of a panel-bound query', async () => {
    const { provider } = harness();

    const error = await refusal(provider.query(SESSION_ID, SPANS_QUERY, { panelId: `  ` }));

    const visible = JSON.stringify({
      message: error.message,
      hint: error.hint,
      details: error.details,
    });
    expect(visible).not.toContain(PANEL_ID);
    expect(visible).not.toContain(SESSION_ID);
  });
});

describe('PanelView — every node of a rendered panel reads that panel’s capture', () => {
  afterEach(() => {
    cleanup();
  });

  it('sends the rendered specification’s own id with each node’s query', async () => {
    const { provider, request } = harness();

    render(
      createElement(PanelView, {
        spec: tableSpec(PANEL_ID, 1),
        dataProvider: provider,
        actions: NO_ACTIONS,
        theme: 'light',
      }),
    );

    await waitFor(() => {
      expect(request).toHaveBeenCalled();
    });
    // The span table states the order it opens in - slowest first - on every
    // query of a node that names none, so its header's `aria-sort` describes
    // the rows it receives (`@debuggen/panel-renderer` SpanTable).
    for (const call of request.mock.calls) {
      expect(call[1]).toStrictEqual({
        sessionId: SESSION_ID,
        query: { ...SPANS_QUERY, sort: 'duration_desc', panelId: PANEL_ID },
      });
    }
  });

  it('sends the newer panel’s id once a newer version is rendered in its place', async () => {
    const { provider, request } = harness();
    const props = { dataProvider: provider, actions: NO_ACTIONS, theme: 'light' } as const;

    const view = render(createElement(PanelView, { ...props, spec: tableSpec(PANEL_ID, 1) }));
    await waitFor(() => {
      expect(request).toHaveBeenCalled();
    });
    const firstVersionCalls = request.mock.calls.length;

    view.rerender(createElement(PanelView, { ...props, spec: tableSpec(NEXT_PANEL_ID, 2) }));
    await waitFor(() => {
      expect(request.mock.calls.length).toBeGreaterThan(firstVersionCalls);
    });

    const sentIds = request.mock.calls.map((call) => call[1].query.panelId);
    expect(sentIds.slice(0, firstVersionCalls).every((id) => id === PANEL_ID)).toBe(true);
    expect(sentIds.slice(firstVersionCalls).every((id) => id === NEXT_PANEL_ID)).toBe(true);
  });
});
