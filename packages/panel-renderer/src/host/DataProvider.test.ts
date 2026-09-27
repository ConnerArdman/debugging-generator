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
 *   kind and never echoes it, so no caller-supplied text reaches its message,
 *   hint or details.
 * - **Sharing, for panel-bound reads only.** Identical queries of one bound
 *   panel share one request while it is in flight and its settled success for
 *   the wrapper's lifetime, within a bound; a failure or an abort is never
 *   kept; each caller's signal cancels that caller alone, and the request only
 *   once nobody waits on it; another panel, session, query or wrapper — and a
 *   live read — shares nothing.
 */

import type { DataQuery } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import { describe, expect, it, vi } from 'vitest';

import { bindPanelIdentity, createDataProvider, createPanelDataProvider } from './DataProvider';
import type {
  DataQueryOptions,
  DataQueryResolver,
  DataQueryResponse,
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
  return vi.fn<DataQueryResolver>((query) => Promise.resolve(emptyView(query)));
}

/**
 * The view form of an empty answer to `query`: `null` for the correlated
 * trace, whose empty value that is, and an empty page for every other source
 * a case below asks for.
 *
 * @param query The query answered.
 * @returns Its empty view-form response.
 */
function emptyView(query: DataQuery): DataQueryResponse {
  return query.source === 'trace'
    ? { source: 'trace', data: null }
    : { source: query.source, data: [] };
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

/** One held answer of {@link pendingResolver}: the call it answers and how to settle it. */
interface HeldCall {
  /** The query the call carried. */
  readonly query: DataQuery;
  /** The context the call carried. */
  readonly context: DataQueryResolverContext;
  /** Resolves the call with the empty answer to its own query ({@link emptyView}). */
  readonly succeed: () => void;
  /** Rejects the call with `error`. */
  readonly fail: (error: Error) => void;
}

/**
 * A view-form resolver that holds every call open until the case settles it,
 * so a case can issue identical calls while one is still in flight.
 *
 * @returns The recording resolver, the calls it holds, and `settle(n)`, which
 * answers the n-th call (0-based) with {@link emptyView}.
 */
function pendingResolver() {
  const held: HeldCall[] = [];
  const resolve = vi.fn<DataQueryResolver>(
    (query, context) =>
      new Promise((succeedWith, failWith) => {
        held.push({
          query,
          context,
          succeed: () => {
            succeedWith(emptyView(query));
          },
          fail: failWith,
        });
      }),
  );

  const settle = (index: number): void => {
    const call = held[index];
    if (call === undefined) {
      throw new Error(`the resolver holds no call ${String(index)}`);
    }
    call.succeed();
  };

  return { resolve, held, settle };
}

/**
 * Lets every queued microtask run — the wrapper defers abandoning a request
 * by one — and every promise reaction chained on them.
 */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * The context a recording resolver received on its only call.
 *
 * @param resolve A resolver called exactly once.
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

/**
 * The parts of an error a reader or a log can see, serialised for a leak check.
 *
 * @param error A refusal.
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

  it('hands the provider a signal of its own, which the call’s abort cancels', async () => {
    const { resolve, settle } = pendingResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);
    const controller = new AbortController();

    const pending = bound.query(SESSION_ID, SPANS_QUERY, { signal: controller.signal });

    // The request is shared by every identical caller, so the provider is
    // handed the wrapper's signal rather than any one caller's.
    const context = onlyContext(resolve);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.signal).not.toBe(controller.signal);
    expect(context.signal?.aborted).toBe(false);
    expect(context.panelId).toBe(PANEL_ID);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flushMicrotasks();
    expect(context.signal?.aborted).toBe(true);
    settle(0);
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

/** The number of settled answers one bound wrapper keeps, as its documentation states it. */
const KEPT_ANSWER_BOUND = 32;

/** The query two nodes of one panel commonly share: the whole correlated trace. */
const TRACE_QUERY = { source: 'trace' } as const;

describe('bindPanelIdentity — sharing identical panel-bound reads', () => {
  it('sends identical concurrent queries once, and answers every caller from it', async () => {
    const { resolve, settle } = pendingResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);

    // A timeline and a flame chart of one trace, mounted in the same commit;
    // the second spells an absent member explicitly, which is the same request.
    const first = bound.query(SESSION_ID, TRACE_QUERY);
    const second = bound.query(SESSION_ID, { source: 'trace', filter: undefined });

    expect(resolve).toHaveBeenCalledTimes(1);
    settle(0);

    const [answerOne, answerTwo] = await Promise.all([first, second]);
    expect(answerOne).toEqual({ source: 'trace', data: null });
    expect(answerTwo).toBe(answerOne);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('answers an identical query issued after the first settled without asking again', async () => {
    const { resolve, settle } = pendingResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);

    const first = bound.query(SESSION_ID, TRACE_QUERY);
    settle(0);
    const answer = await first;

    // A node that mounts later, or remounts, reads the kept answer.
    const later = await bound.query(SESSION_ID, TRACE_QUERY);
    const remount = await bound.query(SESSION_ID, { source: 'trace' });

    expect(later).toBe(answer);
    expect(remount).toBe(answer);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('never keeps a failure: every caller waiting receives it, and a retry asks again', async () => {
    const failure = new DebuggenError('SESSION_NOT_FOUND', 'The session is gone.');
    const { resolve, held, settle } = pendingResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);

    const first = bound.query(SESSION_ID, TRACE_QUERY);
    const second = bound.query(SESSION_ID, TRACE_QUERY);
    held[0]?.fail(failure);

    // The very rejection the provider produced, code and hint intact.
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    const retried = bound.query(SESSION_ID, TRACE_QUERY);
    expect(resolve).toHaveBeenCalledTimes(2);
    settle(1);
    await expect(retried).resolves.toEqual({ source: 'trace', data: null });
  });

  it('cancels only the caller whose signal aborts, and keeps the request for the others', async () => {
    const { resolve, settle } = pendingResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);
    const leaving = new AbortController();

    const cancelled = bound.query(SESSION_ID, TRACE_QUERY, { signal: leaving.signal });
    const staying = bound.query(SESSION_ID, TRACE_QUERY);
    const context = onlyContext(resolve);

    leaving.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await flushMicrotasks();

    // Someone is still waiting, so the one request goes on and is answered.
    expect(context.signal?.aborted).toBe(false);
    settle(0);
    await expect(staying).resolves.toEqual({ source: 'trace', data: null });

    // Its success is kept like any other.
    await bound.query(SESSION_ID, TRACE_QUERY);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('aborts the request once every caller has left, and never keeps its late answer', async () => {
    const { resolve, settle } = pendingResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);
    const one = new AbortController();
    const two = new AbortController();

    const first = bound.query(SESSION_ID, TRACE_QUERY, { signal: one.signal });
    const second = bound.query(SESSION_ID, TRACE_QUERY, { signal: two.signal });
    const context = onlyContext(resolve);

    one.abort();
    two.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await flushMicrotasks();
    expect(context.signal?.aborted).toBe(true);

    // A provider that ignores its signal and answers anyway: the answer is
    // dropped, so the next identical query asks again.
    settle(0);
    await flushMicrotasks();
    const fresh = bound.query(SESSION_ID, TRACE_QUERY);
    expect(resolve).toHaveBeenCalledTimes(2);
    settle(1);
    await expect(fresh).resolves.toEqual({ source: 'trace', data: null });
  });

  it('keeps the request when a caller leaves and an identical one asks in the same turn', async () => {
    const { resolve, settle } = pendingResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);
    const firstMount = new AbortController();

    // React's development double-invoke: the first effect's request is
    // cancelled and the same query is issued again before the turn ends.
    const abandoned = bound.query(SESSION_ID, TRACE_QUERY, { signal: firstMount.signal });
    const context = onlyContext(resolve);
    firstMount.abort();
    const remounted = bound.query(SESSION_ID, TRACE_QUERY);

    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    await flushMicrotasks();
    expect(context.signal?.aborted).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);

    settle(0);
    await expect(remounted).resolves.toEqual({ source: 'trace', data: null });
  });

  it('refuses a call whose signal is already aborted, sending and reading nothing', async () => {
    const { resolve, settle } = pendingResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);

    const warm = bound.query(SESSION_ID, TRACE_QUERY);
    settle(0);
    await warm;

    // Not even a kept answer resolves an aborted call.
    const reason = new DOMException('The node unmounted.', 'AbortError');
    const aborted = AbortSignal.abort(reason);
    await expect(bound.query(SESSION_ID, TRACE_QUERY, { signal: aborted })).rejects.toBe(reason);
    await expect(bound.query(SESSION_ID, SPANS_QUERY, { signal: aborted })).rejects.toBe(reason);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('shares nothing across panels, sessions, queries or wrappers', async () => {
    const resolve = viewResolver();
    const provider = createDataProvider(resolve);
    const bound = bindPanelIdentity(provider, PANEL_ID);
    const otherVersion = bindPanelIdentity(provider, OTHER_PANEL_ID);

    await bound.query(SESSION_ID, TRACE_QUERY);
    // The same query of another panel reads another capture — by a call's own
    // id, or through the next version's wrapper.
    await bound.query(SESSION_ID, TRACE_QUERY, { panelId: OTHER_PANEL_ID });
    await otherVersion.query(SESSION_ID, TRACE_QUERY);
    // Another session, and another query, are other requests.
    await bound.query('ses_2Bz9Qm4Xc7RpT1vL', TRACE_QUERY);
    await bound.query(SESSION_ID, { source: 'trace', filter: { traceId: 'a'.repeat(32) } });

    expect(resolve).toHaveBeenCalledTimes(5);
    expect(resolve.mock.calls.map((call) => call[1].panelId)).toEqual([
      PANEL_ID,
      OTHER_PANEL_ID,
      OTHER_PANEL_ID,
      PANEL_ID,
      PANEL_ID,
    ]);

    // Each of them is kept under its own identity: asked again, none is sent.
    await bound.query(SESSION_ID, TRACE_QUERY, { panelId: OTHER_PANEL_ID });
    await otherVersion.query(SESSION_ID, TRACE_QUERY);
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it('reads an omitted limit or offset as the default the service applies, and nothing more', async () => {
    const resolve = viewResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);
    const omitted = { source: 'spans' } as const;

    // A waterfall that names no page and a span table that names the default
    // one ask for the same page, and it is sent once, as the first caller spelt it.
    await bound.query(SESSION_ID, omitted);
    await bound.query(SESSION_ID, { source: 'spans', limit: 200, offset: 0 });
    await bound.query(SESSION_ID, { source: 'spans', offset: 0 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe(omitted);

    // A page of another size, or at another offset, is another request.
    await bound.query(SESSION_ID, { source: 'spans', limit: 25 });
    await bound.query(SESSION_ID, { source: 'spans', offset: 200 });
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('never shares a live read made on the provider it wraps', async () => {
    const resolve = viewResolver();
    const provider = createDataProvider(resolve);
    bindPanelIdentity(provider, PANEL_ID);

    await provider.query(SESSION_ID, TRACE_QUERY);
    await provider.query(SESSION_ID, TRACE_QUERY);

    expect(resolve).toHaveBeenCalledTimes(2);
    for (const call of resolve.mock.calls) {
      expect(Object.hasOwn(call[1], 'panelId')).toBe(false);
    }
  });

  it('keeps a bounded number of answers, evicting the least recently read first', async () => {
    const resolve = viewResolver();
    const bound = bindPanelIdentity(createDataProvider(resolve), PANEL_ID);
    const page = (offset: number) => ({ source: 'spans', limit: 25, offset }) as const;

    for (let offset = 0; offset <= KEPT_ANSWER_BOUND; offset += 1) {
      await bound.query(SESSION_ID, page(offset));
      // Page 1 is read again every time, so it stays the most recently read.
      await bound.query(SESSION_ID, page(1));
    }
    expect(resolve).toHaveBeenCalledTimes(KEPT_ANSWER_BOUND + 1);

    // One answer past the bound: page 0, the least recently read, is gone and
    // is asked for again; page 1 and the newest page are still kept.
    await bound.query(SESSION_ID, page(1));
    await bound.query(SESSION_ID, page(KEPT_ANSWER_BOUND));
    expect(resolve).toHaveBeenCalledTimes(KEPT_ANSWER_BOUND + 1);
    await bound.query(SESSION_ID, page(0));
    expect(resolve).toHaveBeenCalledTimes(KEPT_ANSWER_BOUND + 2);
  });

  it('shares through the wire-form factory too, with the answer in the view form', async () => {
    const resolve = wireResolver();
    const bound = bindPanelIdentity(createPanelDataProvider(resolve), PANEL_ID);

    const [one, two] = await Promise.all([
      bound.query(SESSION_ID, SPANS_QUERY),
      bound.query(SESSION_ID, SPANS_QUERY),
    ]);
    const three = await bound.query(SESSION_ID, SPANS_QUERY);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(one).toEqual({
      source: 'spans',
      data: [],
      total: 0,
      limit: 25,
      offset: 0,
      nextOffset: null,
    });
    expect(two).toBe(one);
    expect(three).toBe(one);
  });
});
