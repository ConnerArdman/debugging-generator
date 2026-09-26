/**
 * Tests for the panel identity a {@link DataProvider} call carries —
 * `DataQueryOptions.panelId`, its hand-over by the two factories and
 * {@link bindPanelIdentity} — in `./DataProvider.ts`.
 *
 * What is on trial is the one property that decides which evidence a node
 * draws. A node's query names neither a capture nor a panel; the panel being
 * rendered does, and its id must reach the transport on every call or the
 * service answers from live evidence — another capture's data under an older
 * panel's findings, with nothing on screen to say so. So the cases hold:
 *
 * - **Forwarding.** Both factories hand a present `panelId` to their resolver
 *   unchanged, beside the session and the signal, and a live read's context
 *   carries no `panelId` key at all.
 * - **Binding.** `bindPanelIdentity` sets the bound id on every call, lets a
 *   call's own id win, keeps the call's signal, and leaves the provider it wraps
 *   untouched for the live reads the rest of a surface makes.
 * - **Refusal, never a silent downgrade.** A blank or non-string panel id is a
 *   `PANEL_INVALID` rejection before anything is sent — never dropped, which
 *   would turn a panel-bound read into a live one — and binding itself never
 *   throws, because it runs during a render. A refusal describes the value by
 *   kind and never echoes it (AAP 0.5.2).
 */

import { DebuggenError } from '@debuggen/shared';
import { describe, expect, it, vi } from 'vitest';

import { bindPanelIdentity, createDataProvider, createPanelDataProvider } from './DataProvider';
import type {
  DataQueryOptions,
  DataQueryResolver,
  DataQueryResolverContext,
  PanelDataResolver,
} from './DataProvider';

/** The session every call is addressed to. */
const SESSION_ID = 'ses_4Vq8Lm2Xc9RpT1zB';

/** The panel a provider is bound to, in the form the product mints. */
const PANEL_ID = 'pnl_7Qm2Xc9LpR4tVz1B';

/** A second panel id: a newer version of the same session's answer. */
const OTHER_PANEL_ID = 'pnl_9Hs3Kd7WqN2cYx5E';

/** Distinctive text for the leak checks: it must never appear in a refusal. */
const SENTINEL = 'sentinel-panel-identity-value';

/** The query every case sends: one page of spans. */
const SPANS_QUERY = { source: 'spans', limit: 25, offset: 0 } as const;

/**
 * A view-form resolver answering every query with an empty page of its own
 * source, recording the context it was handed.
 *
 * @returns The recording resolver.
 */
function viewResolver() {
  return vi.fn<DataQueryResolver>((query) => Promise.resolve({ source: query.source, data: [] }));
}

/**
 * A wire-form resolver answering with the service's empty `spans` body,
 * recording the context it was handed.
 *
 * @returns The recording resolver.
 */
function wireResolver() {
  return vi.fn<PanelDataResolver>(() =>
    Promise.resolve({
      source: 'spans' as const,
      spans: [],
      total: 0,
      limit: 25,
      offset: 0,
      nextOffset: null,
    }),
  );
}

/**
 * The context a recording resolver received on its only call.
 *
 * @param resolve - A resolver called exactly once.
 * @returns Its second argument.
 */
function onlyContext(
  resolve: ReturnType<typeof viewResolver> | ReturnType<typeof wireResolver>,
): DataQueryResolverContext {
  expect(resolve).toHaveBeenCalledTimes(1);
  const context = resolve.mock.calls[0]?.[1];
  if (context === undefined) {
    throw new Error('the resolver was called without a context');
  }
  return context;
}

/**
 * Await a refusal and return it as a `DebuggenError`.
 *
 * @param pending - A call expected to reject with a typed error.
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

/**
 * The parts of an error a reader or a log can see, serialised for a leak check.
 *
 * @param error - A refusal.
 * @returns Its message, hint and details as one string.
 */
function visible(error: DebuggenError): string {
  return JSON.stringify({ message: error.message, hint: error.hint, details: error.details });
}

/** The two factories, each with a matching recording resolver. */
const FACTORIES = [
  {
    name: 'createDataProvider',
    build: () => {
      const resolve = viewResolver();
      return { provider: createDataProvider(resolve), resolve };
    },
  },
  {
    name: 'createPanelDataProvider',
    build: () => {
      const resolve = wireResolver();
      return { provider: createPanelDataProvider(resolve), resolve };
    },
  },
] as const;

describe.each(FACTORIES)('$name — the panel identity on the resolver context', ({ build }) => {
  it('forwards a present panelId unchanged, beside the session and the signal', async () => {
    const { provider, resolve } = build();
    const controller = new AbortController();

    await provider.query(SESSION_ID, SPANS_QUERY, {
      signal: controller.signal,
      panelId: PANEL_ID,
    });

    const context = onlyContext(resolve);
    expect(context.sessionId).toBe(SESSION_ID);
    expect(context.signal).toBe(controller.signal);
    expect(context.panelId).toBe(PANEL_ID);
    expect(resolve.mock.calls[0]?.[0]).toBe(SPANS_QUERY);
  });

  it('carries no panelId key for a live read', async () => {
    const { provider, resolve } = build();

    await provider.query(SESSION_ID, SPANS_QUERY);
    await provider.query(SESSION_ID, SPANS_QUERY, { panelId: undefined });

    expect(resolve).toHaveBeenCalledTimes(2);
    for (const call of resolve.mock.calls) {
      expect(Object.hasOwn(call[1], 'panelId')).toBe(false);
      expect(call[1].sessionId).toBe(SESSION_ID);
    }
  });

  it.each(['', '   ', '\t\n'])(
    'refuses the blank panelId %j with PANEL_INVALID before the resolver runs',
    async (blank) => {
      const { provider, resolve } = build();

      const error = await refusal(provider.query(SESSION_ID, SPANS_QUERY, { panelId: blank }));

      expect(error.code).toBe('PANEL_INVALID');
      expect(error.details).toMatchObject({ source: 'spans', panelId: 'a blank string' });
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-string panelId by its kind, without echoing it', async () => {
    const { provider, resolve } = build();
    const untyped = { panelId: { id: SENTINEL } } as unknown as DataQueryOptions;

    const error = await refusal(provider.query(SESSION_ID, SPANS_QUERY, untyped));

    expect(error.code).toBe('PANEL_INVALID');
    expect(error.details).toMatchObject({ panelId: 'an object' });
    expect(visible(error)).not.toContain(SENTINEL);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('still refuses a call naming no session first, whatever its panelId', async () => {
    const { provider, resolve } = build();

    const error = await refusal(provider.query('  ', SPANS_QUERY, { panelId: PANEL_ID }));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('bindPanelIdentity — binding a provider to the rendered panel', () => {
  it('sets the bound panelId on a call that names none', async () => {
    const resolve = viewResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);

    const response = await bound.query(SESSION_ID, SPANS_QUERY);

    expect(response).toEqual({ source: 'spans', data: [] });
    const context = onlyContext(resolve);
    expect(context.panelId).toBe(PANEL_ID);
    expect(context.sessionId).toBe(SESSION_ID);
    expect(resolve.mock.calls[0]?.[0]).toBe(SPANS_QUERY);
  });

  it('keeps the call’s signal', async () => {
    const resolve = viewResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);
    const controller = new AbortController();

    await bound.query(SESSION_ID, SPANS_QUERY, { signal: controller.signal });

    const context = onlyContext(resolve);
    expect(context.signal).toBe(controller.signal);
    expect(context.panelId).toBe(PANEL_ID);
  });

  it('lets a call’s own panelId win over the bound one', async () => {
    const resolve = viewResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);

    await bound.query(SESSION_ID, SPANS_QUERY, { panelId: OTHER_PANEL_ID });

    expect(onlyContext(resolve).panelId).toBe(OTHER_PANEL_ID);
  });

  it('leaves the wrapped provider untouched for live reads', async () => {
    const resolve = viewResolver();
    // Frozen, so any write to it — module code runs in strict mode — would throw.
    const provider = Object.freeze(createDataProvider(resolve));

    const bound = bindPanelIdentity(provider, PANEL_ID);
    await provider.query(SESSION_ID, SPANS_QUERY);

    expect(bound).not.toBe(provider);
    expect(Object.hasOwn(onlyContext(resolve), 'panelId')).toBe(false);
  });

  it('forwards the panel identity through the wire-form factory too', async () => {
    const resolve = wireResolver();
    const bound = bindPanelIdentity(createPanelDataProvider(resolve), PANEL_ID);

    const response = await bound.query(SESSION_ID, SPANS_QUERY);

    expect(response).toEqual({
      source: 'spans',
      data: [],
      total: 0,
      limit: 25,
      offset: 0,
      nextOffset: null,
    });
    expect(onlyContext(resolve).panelId).toBe(PANEL_ID);
  });

  it.each(['', '   '])(
    'never throws while binding the blank id %j, and refuses its queries with PANEL_INVALID',
    async (blank) => {
      const resolve = viewResolver();
      const provider = createDataProvider(resolve);

      let bound: ReturnType<typeof bindPanelIdentity> | undefined;
      expect(() => {
        bound = bindPanelIdentity(provider, blank);
      }).not.toThrow();

      const pending = bound?.query(SESSION_ID, SPANS_QUERY) ?? Promise.resolve();
      const error = await refusal(pending);

      expect(error.code).toBe('PANEL_INVALID');
      expect(error.details).toMatchObject({ source: 'spans', panelId: 'a blank string' });
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('refuses a blank per-call panelId instead of replacing it with the bound one', async () => {
    const resolve = viewResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);

    const error = await refusal(bound.query(SESSION_ID, SPANS_QUERY, { panelId: ' ' }));

    expect(error.code).toBe('PANEL_INVALID');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a null per-call panelId from an untyped caller rather than replacing it', async () => {
    const resolve = viewResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);
    const untyped = { panelId: null } as unknown as DataQueryOptions;

    const error = await refusal(bound.query(SESSION_ID, SPANS_QUERY, untyped));

    expect(error.code).toBe('PANEL_INVALID');
    expect(error.details).toMatchObject({ panelId: 'null' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a non-string bound id without echoing it', async () => {
    const resolve = viewResolver();
    const untyped = { id: SENTINEL } as unknown as string;
    const bound = bindPanelIdentity(createDataProvider(resolve), untyped);

    const error = await refusal(bound.query(SESSION_ID, SPANS_QUERY));

    expect(error.code).toBe('PANEL_INVALID');
    expect(visible(error)).not.toContain(SENTINEL);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('passes the wrapped provider’s own refusal through unchanged', async () => {
    const failure = new DebuggenError('SESSION_NOT_FOUND', 'The session is gone.');
    const resolve = vi.fn<DataQueryResolver>(() => Promise.reject(failure));
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);

    await expect(bound.query(SESSION_ID, SPANS_QUERY)).rejects.toBe(failure);
  });

  it('reports a wrapped provider that throws synchronously as a rejection', async () => {
    const failure = new DebuggenError('INTERNAL', 'The provider broke its promise.');
    const throwing = {
      query: () => {
        throw failure;
      },
    };
    const bound = bindPanelIdentity(throwing, PANEL_ID);

    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = bound.query(SESSION_ID, SPANS_QUERY);
    }).not.toThrow();
    await expect(pending).rejects.toBe(failure);
  });
});
