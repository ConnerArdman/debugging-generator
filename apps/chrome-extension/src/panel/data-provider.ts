/**
 * The DevTools panel's implementation of `@debuggen/panel-renderer`'s
 * {@link DataProvider} — how every query-backed node of a generated panel gets
 * its data.
 *
 * ## What this module is
 *
 * `PanelHost` draws a panel specification; each of its query-backed nodes hands
 * its `DataQuery` to the ambient provider through the renderer's `useQuery`.
 * In the DevTools panel that provider is the object built here, and its only
 * channel is the `chrome.runtime` port owned by `./state/connection.ts`: a
 * `panelData.query` request (the contract in `../shared/messages`) that the
 * service worker proxies to the service's `POST /sessions/:id/panel-data`
 * route, answering with the service's wire-form `DataResult` (AAP §0.7.1
 * Group 4, §0.4.2). The answer is translated into the renderer's view form by
 * the renderer's own `mapPanelDataResult`, which also refuses an answer for
 * another source — so no component ever narrows on a `source` that lies.
 *
 * ## The seam, one-directional
 *
 * {@link createPanelDataProvider} is a factory, not a singleton, and it
 * acquires nothing: the request function (`panelRequest`, or
 * `getPanelConnection().request`), the port-loss registration
 * (`onPortDisconnect`) and the session getter (`getSessionId` from
 * `./state/session-store.ts`) are all injected by `../App.tsx`. This module
 * never creates, holds or reconnects a port, never opens a socket and never
 * calls `fetch` — the worker owns every HTTP call, so the protocol package's
 * `HttpClient` (whose documentation lists this file among its consumers) is
 * deliberately *not* used here. Nothing runs at import time, and nothing reads
 * `chrome.devtools`: `tests/browser/panel-render.spec.ts` opens the panel page
 * directly as an extension page.
 *
 * ## Contract decisions, and where they come from
 *
 * - **The session is the call's own argument.** The renderer's interface takes
 *   `sessionId` as the first argument of `query` and obliges every provider to
 *   route by it, never by a session remembered elsewhere. The injected
 *   `getSessionId` is therefore a *guard*, not a source: a query naming no
 *   session, or one naming a session other than the one this panel's store
 *   shows, is refused with `TAB_NOT_BOUND` before anything is sent. When the
 *   store knows no session at all (a stored specification rendered in a panel
 *   page with no binding), the specification's own session is trusted and the
 *   worker and service decide.
 * - **Paging is normalised, never invented.** `limit` defaults to
 *   `DATA_QUERY_DEFAULT_LIMIT` and is clamped to `DATA_QUERY_MAX_LIMIT` (the
 *   service's route parses the strict query schema and would refuse a larger
 *   one outright); `offset` defaults to `DATA_QUERY_DEFAULT_OFFSET` and never
 *   goes below it. An explicit `limit: 0` is **preserved**: the query schema
 *   defines it as a legitimate count-only request that nothing downstream may
 *   read as "unset", so the lower bound is zero, not one. A malformed value —
 *   non-numeric, non-finite, fractional, or a negative `limit` — is coerced to
 *   the default rather than clamped, because clamping a negative `limit` to
 *   zero would turn a defect into an empty page that looks like a real answer.
 *   `filter` and `sort` travel untouched; their semantics are the service's.
 * - **Correlation is layered.** `./state/connection.ts` correlates port frames
 *   with its own request ids; this module keeps its own registry of the
 *   queries it has in flight, keyed by {@link newPortRequestId}, so that it can
 *   settle each exactly once, bound it with its own timeout, cancel it on
 *   abort and reject all of them on port loss — whatever request function was
 *   injected. `../shared/messages` declares no cancel frame, so an aborted or
 *   timed-out query is dropped locally and a late answer is discarded, never
 *   resolved into a promise that already settled.
 * - **A failure is never data.** Every path that is not a checked answer ends
 *   in a rejected promise carrying a `DebuggenError` — which is what makes
 *   `useQuery` render its error state with a retry (AAP §0.5.5). No path
 *   resolves with an empty page on failure.
 * - **Nothing private reaches an error.** Messages, hints and details name the
 *   requested source and, at most, the numeric `limit` and `offset` — never the
 *   query's filter values, the answer's contents, a session id, a token or a
 *   URL (AAP §0.5.2). A worker failure keeps the code, message and hint the
 *   worker and service chose.
 * - **No validation of panels.** The service validated the specification and
 *   the worker's protocol client parsed the answer; this module neither
 *   re-parses nor re-validates, and the shallow wire-to-view mapping is the
 *   renderer's.
 *
 * @example Building the provider once in `../App.tsx`:
 * ```tsx
 * const dataProvider = useMemo(
 *   () => createPanelDataProvider({ request: panelRequest, onPortDisconnect, getSessionId }),
 *   [],
 * );
 * return <PanelHost spec={spec} dataProvider={dataProvider} actions={actions} theme={theme} />;
 * ```
 *
 * @module apps/chrome-extension/src/panel/data-provider
 */

import { mapPanelDataResult } from '@debuggen/panel-renderer';
import type { DataProvider, DataQueryOptions, DataQueryResponse } from '@debuggen/panel-renderer';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySource } from '@debuggen/panel-schema';
import { DebuggenError, noopLogger } from '@debuggen/shared';
import type { Logger, SessionId } from '@debuggen/shared';

import { newPortRequestId } from '../shared/messages';
import type {
  PortRequestId,
  PortRequestKind,
  PortRequestPayloads,
  PortResponsePayloads,
} from '../shared/messages';

import { PANEL_PORT_REQUEST_TIMEOUT_MS } from './state/connection';
import type {
  PanelPortDisconnectListener,
  PanelRequestFailureReason,
  PanelRequestOptions,
} from './state/connection';

/*
 * ===========================================================================
 * Section A — constants
 * ===========================================================================
 */

/**
 * How long one panel-data query waits for its answer before it is rejected, in
 * milliseconds, unless {@link PanelDataProviderOptions.timeoutMs} says
 * otherwise.
 *
 * The panel's general port-request timeout, by reference rather than by a
 * second number: it is deliberately longer than the worker's own HTTP timeout,
 * so a slow service is reported by the worker's typed failure (which says
 * more) and this bound only fires when the worker went silent.
 */
export const PANEL_DATA_REQUEST_TIMEOUT_MS = PANEL_PORT_REQUEST_TIMEOUT_MS;

/** The largest delay a platform timer accepts without firing immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The one request kind this module sends. */
const PANEL_DATA_QUERY_KIND = 'panelData.query' satisfies PortRequestKind;

/** The payload the worker proxies: the session to address and the query. */
type PanelDataQueryPayload = PortRequestPayloads[typeof PANEL_DATA_QUERY_KIND];

/** The worker's success answer: the service's wire-form `DataResult`. */
type PanelDataQueryAnswer = PortResponsePayloads[typeof PANEL_DATA_QUERY_KIND];

/**
 * Hints for the failures this module raises itself. Written for the reader of
 * the panel — what they can do — and interpolating nothing.
 */
const HINTS = {
  unbound: 'Start a session from the Debug Generator view in VS Code, then reopen this panel.',
  foreignSession: 'Reload the panel to show the session this tab is bound to.',
  disconnected: 'The panel reconnects on its own; retry in a moment.',
  timeout: 'Retry in a moment; if it keeps failing, reload the extension.',
  failed: 'Retry in a moment; if it keeps failing, reopen Chrome DevTools.',
} as const;

/*
 * ===========================================================================
 * Section B — the public surface
 * ===========================================================================
 */

/**
 * The request function the provider sends through: the `panelData.query`
 * member of `./state/connection.ts`'s typed request function.
 *
 * Narrower than `PanelRequestFunction` on purpose — this module sends exactly
 * one kind — and satisfied by it as it stands, so `panelRequest` and
 * `getPanelConnection().request` are passed without an adapter, while a unit
 * suite can pass a plain function for the one kind.
 *
 * @param kind Always `'panelData.query'`.
 * @param payload The session to address and the normalised query.
 * @param options The caller's abort signal and this provider's timeout.
 * @returns The worker's answer: the service's wire-form `DataResult`.
 */
export type PanelDataRequestFunction = (
  kind: typeof PANEL_DATA_QUERY_KIND,
  payload: PanelDataQueryPayload,
  options?: PanelRequestOptions,
) => Promise<PanelDataQueryAnswer>;

/**
 * Registers a listener for port loss and answers its unsubscribe — the shape
 * of `./state/connection.ts`'s `onPortDisconnect`.
 */
export type PanelDataDisconnectRegistration = (listener: PanelPortDisconnectListener) => () => void;

/** Everything {@link createPanelDataProvider} needs, injected by `../App.tsx`. */
export interface PanelDataProviderOptions {
  /**
   * Sends one `panelData.query` port request: `panelRequest` or
   * `getPanelConnection().request` from `./state/connection.ts`, the panel's
   * only owner of `chrome.runtime.connect`.
   */
  readonly request: PanelDataRequestFunction;
  /**
   * The session this panel's store shows — `getSessionId` from
   * `./state/session-store.ts`. Read on every call, as a guard: see the
   * module documentation.
   */
  readonly getSessionId: () => SessionId | undefined;
  /**
   * `onPortDisconnect` from `./state/connection.ts`. When given, the provider
   * subscribes while it has queries in flight and rejects every one of them
   * the moment the port closes (the worker suspends after about thirty seconds
   * idle), so no node keeps a spinner for a port that is gone.
   */
  readonly onPortDisconnect?: PanelDataDisconnectRegistration | undefined;
  /**
   * How long one query waits for its answer, in milliseconds. Non-finite or
   * non-positive values fall back to {@link PANEL_DATA_REQUEST_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Where diagnostics go; defaults to the silent `noopLogger`. Nothing logged
   * here carries a payload, a session id, a token or a URL.
   */
  readonly logger?: Logger | undefined;
}

/**
 * The provider {@link createPanelDataProvider} returns: the renderer's
 * {@link DataProvider}, plus the two hooks its owner and its tests need.
 *
 * Assignable to `DataProvider` as it stands, so `PanelHost`'s `dataProvider`
 * prop takes it without a cast.
 */
export interface PanelDataProvider extends DataProvider {
  /**
   * Reject every query this provider has in flight, each with a transport
   * failure naming its own source, and forget them; their answers are dropped
   * if they arrive later.
   *
   * Called by the provider itself on port loss when `onPortDisconnect` was
   * injected; exposed so that an owner wiring the port some other way can
   * trigger the same thing.
   *
   * @param error The loss to report. Its code, message and hint are kept and
   * each rejection's details gain the query's source; when omitted, a
   * `TRANSPORT_DISCONNECTED` "the port closed" failure is used.
   * @returns How many queries were rejected.
   */
  rejectAllPending(error?: DebuggenError): number;
  /** How many queries are in flight: sent, and neither answered nor rejected. */
  pendingCount(): number;
}

/*
 * ===========================================================================
 * Section C — pure helpers
 * ===========================================================================
 */

/**
 * The `limit` a query is sent with.
 *
 * - absent, non-numeric, non-finite, fractional or negative →
 *   {@link DATA_QUERY_DEFAULT_LIMIT} (a malformed value is not a request for
 *   fewer rows, so it is never clamped to zero);
 * - above {@link DATA_QUERY_MAX_LIMIT} → the maximum;
 * - any other whole number, zero included, is kept: `limit: 0` is the schema's
 *   explicit count-only request.
 *
 * @param limit The query's own `limit`, read as `unknown`.
 * @returns A whole number from zero to {@link DATA_QUERY_MAX_LIMIT}.
 */
export function normalizePanelDataLimit(limit: unknown): number {
  // The sign test is the schema's own lower bound for `limit`, not a paging default.
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
    return DATA_QUERY_DEFAULT_LIMIT;
  }
  return Math.min(limit, DATA_QUERY_MAX_LIMIT);
}

/**
 * The `offset` a query is sent with.
 *
 * - absent, non-numeric, non-finite or fractional →
 *   {@link DATA_QUERY_DEFAULT_OFFSET};
 * - below {@link DATA_QUERY_DEFAULT_OFFSET} — the first item, which no query
 *   can precede — → that first item;
 * - beyond the safe-integer range → the largest safe integer, the most the
 *   schema's integer type admits (an offset past the end is an empty last
 *   page, which the service reports as such).
 *
 * @param offset The query's own `offset`, read as `unknown`.
 * @returns A whole number of zero or more.
 */
export function normalizePanelDataOffset(offset: unknown): number {
  if (typeof offset !== 'number' || !Number.isInteger(offset)) {
    return DATA_QUERY_DEFAULT_OFFSET;
  }
  return Math.min(Math.max(offset, DATA_QUERY_DEFAULT_OFFSET), Number.MAX_SAFE_INTEGER);
}

/**
 * The query as it is sent: the caller's own, with `limit` and `offset`
 * normalised and every other field — `source`, `filter`, `sort` — untouched.
 *
 * @typeParam Source The query's source.
 * @param query The query the node carried.
 * @returns A new query object with both paging fields present; the caller's is
 * not mutated.
 */
export function normalizePanelDataQuery<Source extends DataQuerySource>(
  query: DataQuery & { source: Source },
): DataQuery & { source: Source; limit: number; offset: number } {
  return {
    ...query,
    limit: normalizePanelDataLimit(query.limit),
    offset: normalizePanelDataOffset(query.offset),
  };
}

/** A usable timer delay: `candidate` when finite and positive, else `fallback`. */
function usableTimeout(candidate: number | undefined, fallback: number): number {
  const delay =
    candidate !== undefined && Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
  return Math.min(Math.ceil(delay), MAX_TIMER_DELAY_MS);
}

/** A session id that can address a route: a string with a visible character. */
function isAddressable(sessionId: unknown): sessionId is SessionId {
  return typeof sessionId === 'string' && sessionId.trim() !== '';
}

/** A value's error name for a log field or a detail — never its message. */
function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/*
 * ===========================================================================
 * Section D — typed rejections
 *
 * Every rejection names the requested source and, at most, the numeric paging
 * of the query that failed. Nothing read out of a query's filter, a worker's
 * answer or the session travels in a message, a hint or the details.
 * ===========================================================================
 */

/** What identifies a failing query in an error: its source and numeric paging. */
interface QueryContext {
  readonly source: DataQuerySource;
  readonly limit: number;
  readonly offset: number;
}

/** The details every transport-side rejection of a sent query carries. */
function contextDetails(context: QueryContext): Readonly<Record<string, unknown>> {
  return { source: context.source, limit: context.limit, offset: context.offset };
}

/** A query addressed to no session: nothing can route it. */
function unboundError(source: DataQuerySource): DebuggenError {
  return new DebuggenError(
    'TAB_NOT_BOUND',
    `The "${source}" data for this view cannot be requested: no session is bound to this panel.`,
    { hint: HINTS.unbound, details: { source, session: 'missing' } },
  );
}

/** A query addressed to a session other than the one this panel shows. */
function foreignSessionError(source: DataQuerySource): DebuggenError {
  return new DebuggenError(
    'TAB_NOT_BOUND',
    `The "${source}" data for this view is addressed to a session this panel is not showing.`,
    { hint: HINTS.foreignSession, details: { source, session: 'mismatched' } },
  );
}

/** The caller's signal fired before the worker answered. */
function abortedError(context: QueryContext, reason: unknown): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The "${context.source}" data request was cancelled before the extension's service worker answered.`,
    {
      details: {
        ...contextDetails(context),
        reason: 'aborted' satisfies PanelRequestFailureReason,
      },
      ...(reason === undefined ? {} : { cause: reason }),
    },
  );
}

/** No answer within the query's timeout. */
function timeoutError(context: QueryContext, timeoutMs: number): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The extension's service worker did not answer the "${context.source}" data request within ${String(timeoutMs)} ms.`,
    {
      hint: HINTS.timeout,
      details: {
        ...contextDetails(context),
        reason: 'timeout' satisfies PanelRequestFailureReason,
        timeoutMs,
      },
    },
  );
}

/**
 * The rejection for a query that was in flight when the port closed.
 *
 * With a typed loss from the connection, its code, message and hint are kept
 * and its details gain the query's context; without one, the port-closed
 * failure is built here.
 */
function disconnectedError(context: QueryContext, loss: DebuggenError | undefined): DebuggenError {
  if (loss !== undefined) {
    return withQueryContext(loss, context);
  }
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The connection to the extension's service worker closed before the "${context.source}" data was answered.`,
    {
      hint: HINTS.disconnected,
      details: {
        ...contextDetails(context),
        reason: 'disconnected' satisfies PanelRequestFailureReason,
      },
    },
  );
}

/**
 * A typed failure with the query's context added to its details.
 *
 * The code, message and hint are the ones the connection, the worker or the
 * service chose — a refused query keeps its `SESSION_NOT_FOUND` or
 * `UNAUTHORIZED`, a lost port its `TRANSPORT_DISCONNECTED` — and the existing
 * details (the connection's `reason`, a worker's `ref`) are kept beside the
 * source and paging, so `panelRequestFailureReason` still reads the reason.
 * The original stays reachable as the `cause`.
 */
function withQueryContext(error: DebuggenError, context: QueryContext): DebuggenError {
  return new DebuggenError(error.code, error.message, {
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    details: { ...error.details, ...contextDetails(context) },
    cause: error,
  });
}

/**
 * The rejection for a request function that failed.
 *
 * A `DebuggenError` — which is what `./state/connection.ts` always rejects
 * with, a worker's typed failure included — keeps its code, message and hint.
 * Anything else is a defect in the injected function; it is reported as a
 * transport failure with a message of this module's own, because a foreign
 * error's message could carry anything, and the original is kept as the cause.
 */
function requestFailedError(context: QueryContext, cause: unknown): DebuggenError {
  if (DebuggenError.is(cause)) {
    return withQueryContext(cause, context);
  }
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    `The "${context.source}" data request failed before the extension's service worker answered.`,
    {
      hint: HINTS.failed,
      details: { ...contextDetails(context), errorName: errorName(cause) },
      cause,
    },
  );
}

/*
 * ===========================================================================
 * Section E — the provider
 * ===========================================================================
 */

/** One query in flight, as a provider's registry holds it. */
interface PendingEntry {
  /** The query's source and paging, for the rejection wording. */
  readonly context: QueryContext;
  /** Reject the query with a typed error; a no-op once it has settled. */
  readonly fail: (error: DebuggenError) => void;
}

/** A sent query: its answer, and the cleanup that must run however it ends. */
interface InFlightQuery {
  /** Settles exactly once: the worker's answer, or a typed rejection. */
  readonly answer: Promise<PanelDataQueryAnswer>;
  /** Clears the timer, detaches the abort listener and forgets the entry. Idempotent. */
  readonly cleanup: () => void;
}

/** A platform timer handle, whichever runtime's `setTimeout` produced it. */
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/**
 * Build the DevTools panel's {@link DataProvider}.
 *
 * Create it **once** per panel document — `useMemo` in `../App.tsx` — and keep
 * the reference: the renderer lists the provider among each query effect's
 * dependencies, so a new object per render would refetch every node forever.
 * One provider serves every session the panel shows, because each call names
 * its session.
 *
 * Each `query` call, in order:
 *
 * 1. refuses a call naming no session, or naming a session other than the one
 *    `getSessionId` reports, with `TAB_NOT_BOUND`;
 * 2. normalises `limit` and `offset` (see {@link normalizePanelDataQuery});
 * 3. refuses an already-aborted call without sending anything;
 * 4. registers the query under a fresh {@link newPortRequestId}, starts its
 *    timeout and abort watch, and sends one `panelData.query` port request
 *    with the caller's signal and this provider's timeout;
 * 5. maps the worker's wire-form answer into the view form with the renderer's
 *    `mapPanelDataResult`, which rejects an answer for another source or with
 *    a malformed payload or page echo as `PROTOCOL_INVALID_MESSAGE`;
 * 6. resolves with `{ source, data }` plus, for a paged source, the `total`,
 *    `limit`, `offset` and `nextOffset` the service reported — `null` included
 *    — and nothing the service did not send.
 *
 * Every failure — abort, timeout, port loss, a worker's typed refusal, a
 * mismatched answer — rejects with a `DebuggenError` and leaves no entry, timer
 * or listener behind; `query` never throws synchronously and never resolves a
 * failure as data.
 *
 * @param options The injected request function, session getter, optional port
 * loss registration, timeout and logger.
 * @returns The provider, with {@link PanelDataProvider.rejectAllPending} and
 * {@link PanelDataProvider.pendingCount} beside `query`.
 */
export function createPanelDataProvider(options: PanelDataProviderOptions): PanelDataProvider {
  const { request, getSessionId, onPortDisconnect } = options;
  const logger = options.logger ?? noopLogger;
  const timeoutMs = usableTimeout(options.timeoutMs, PANEL_DATA_REQUEST_TIMEOUT_MS);

  // Per provider rather than per module, so two providers — two panel
  // documents' worth in one test — share no queries and no subscription.
  const pending = new Map<PortRequestId, PendingEntry>();
  let unsubscribeDisconnect: (() => void) | undefined;

  function rejectAllPending(error?: DebuggenError): number {
    const loss =
      error === undefined ? undefined : DebuggenError.from(error, 'TRANSPORT_DISCONNECTED');
    // A copy: each `fail` removes its own entry while this loop runs.
    const entries = [...pending.values()];
    for (const entry of entries) {
      entry.fail(disconnectedError(entry.context, loss));
    }
    return entries.length;
  }

  const handleDisconnect: PanelPortDisconnectListener = (event) => {
    const count = rejectAllPending(event.error);
    if (count > 0) {
      logger.debug('Rejected in-flight panel-data queries after the panel port closed.', {
        count,
        reason: event.reason,
      });
    }
  };

  // The port-loss subscription exists only while a query is in flight, so a
  // provider that React builds and discards (StrictMode's double invoke of
  // `useMemo`) leaves no listener behind in the connection module.
  function watchDisconnect(): void {
    if (onPortDisconnect === undefined || unsubscribeDisconnect !== undefined) {
      return;
    }
    try {
      unsubscribeDisconnect = onPortDisconnect(handleDisconnect);
    } catch (cause) {
      logger.warn('Subscribing to panel port loss failed; queries still time out on their own.', {
        error: errorName(cause),
      });
    }
  }

  function unwatchDisconnect(): void {
    const unsubscribe = unsubscribeDisconnect;
    if (unsubscribe === undefined) {
      return;
    }
    unsubscribeDisconnect = undefined;
    try {
      unsubscribe();
    } catch (cause) {
      logger.warn('Unsubscribing from panel port loss failed.', { error: errorName(cause) });
    }
  }

  function track(id: PortRequestId, entry: PendingEntry): void {
    pending.set(id, entry);
    watchDisconnect();
  }

  function untrack(id: PortRequestId): void {
    if (pending.delete(id) && pending.size === 0) {
      unwatchDisconnect();
    }
  }

  /**
   * The session a call is addressed to: its own argument, once the guard has
   * passed. Throws (inside the async `query`, so as a rejection) otherwise.
   */
  function resolveSession(sessionId: unknown, source: DataQuerySource): SessionId {
    if (!isAddressable(sessionId)) {
      throw unboundError(source);
    }
    let shown: SessionId | undefined;
    try {
      shown = getSessionId();
    } catch (cause) {
      // A store that cannot answer proves nothing about which session is on
      // screen; the specification's own session is routed, and the worker and
      // service still authorise it against the tab's binding.
      logger.warn('Reading the panel session failed; routing by the panel specification.', {
        error: errorName(cause),
      });
      shown = undefined;
    }
    if (isAddressable(shown) && shown !== sessionId) {
      throw foreignSessionError(source);
    }
    return sessionId;
  }

  /** Register and send one query; the returned answer settles exactly once. */
  function dispatch(
    sessionId: SessionId,
    query: DataQuery,
    context: QueryContext,
    signal: AbortSignal | undefined,
  ): InFlightQuery {
    const id = newPortRequestId();
    let settled = false;
    let timer: TimerHandle | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
        timer = undefined;
      }
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
      untrack(id);
    };

    // Claims the one settlement; every path — answer, refusal, abort,
    // timeout, port loss — goes through it, so a later one is dropped.
    const settle = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      cleanup();
      return true;
    };

    const answer = new Promise<PanelDataQueryAnswer>((resolve, reject) => {
      const fail = (error: DebuggenError): void => {
        if (settle()) {
          reject(error);
        }
      };

      track(id, { context, fail });

      onAbort = (): void => {
        const reason: unknown = signal?.reason;
        fail(abortedError(context, reason));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      timer = globalThis.setTimeout(() => {
        fail(timeoutError(context, timeoutMs));
      }, timeoutMs);

      let sent: Promise<PanelDataQueryAnswer>;
      try {
        sent = Promise.resolve(
          request(PANEL_DATA_QUERY_KIND, { sessionId, query }, { signal, timeoutMs }),
        );
      } catch (cause) {
        // `panelRequest` never throws; an injected function that does is
        // reported like any other failed request, never as an exception.
        fail(requestFailedError(context, cause));
        return;
      }

      sent.then(
        (value) => {
          if (settle()) {
            resolve(value);
            return;
          }
          logger.debug('Dropped a panel-data answer that arrived after its query settled.', {
            source: context.source,
          });
        },
        (cause: unknown) => {
          fail(requestFailedError(context, cause));
        },
      );
    });

    return { answer, cleanup };
  }

  return {
    async query<Source extends DataQuerySource>(
      sessionId: string,
      query: DataQuery & { source: Source },
      queryOptions?: DataQueryOptions,
    ): Promise<DataQueryResponse<Source>> {
      const source = query.source;
      const session = resolveSession(sessionId, source);
      const sent = normalizePanelDataQuery(query);
      const context: QueryContext = { source, limit: sent.limit, offset: sent.offset };

      const signal = queryOptions?.signal;
      if (signal?.aborted === true) {
        const reason: unknown = signal.reason;
        throw abortedError(context, reason);
      }

      const inFlight = dispatch(session, sent, context, signal);
      try {
        const answer = await inFlight.answer;
        // The renderer's wire-to-view translation: the source-named payload
        // becomes `data`, the page echo is carried across as it arrived, and an
        // answer for another source (or with a malformed payload or echo) is
        // refused. It returns the typed view, so no cast is needed here.
        const mapped = mapPanelDataResult(query, answer);
        if (!mapped.ok) {
          logger.warn('Refused a panel-data answer that does not match its query.', {
            source,
            code: mapped.error.code,
          });
          throw mapped.error;
        }
        return mapped.value;
      } finally {
        inFlight.cleanup();
      }
    },

    rejectAllPending,

    pendingCount(): number {
      return pending.size;
    },
  };
}
