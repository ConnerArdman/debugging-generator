/**
 * `useQuery` — the one module in this library that talks to a {@link DataProvider}.
 *
 * Twelve of the node catalog's thirteen visualization types are query-backed:
 * each carries a `DataQuery` and draws whatever that query resolves to. This is
 * how they resolve it, and it is the only place in the package that calls a
 * provider at all. A component therefore never sees a promise, a socket, a
 * message port or an abort signal — it reads a `status`, renders one of its three
 * states, and hands `retry` to its error state.
 *
 * ## One page, exactly as it was given
 *
 * The hook resolves **one** query into **one** page and reports what came back
 * verbatim. Ordering, filtering and paging are applied by the side that owns the
 * whole capture (AAP 0.4.2): `sort`, `filter`, `limit` and `offset` travel on the
 * query, `total` and `nextOffset` come back on the response, and the default page
 * size, the default offset and the page ceiling are the constants the schema
 * package publishes (`DATA_QUERY_DEFAULT_LIMIT`, `DATA_QUERY_DEFAULT_OFFSET`,
 * `DATA_QUERY_MAX_LIMIT`) — applied by whoever resolves the query, never here.
 *
 * Nothing below re-sorts, merges, concatenates, de-duplicates, truncates,
 * filters or otherwise transforms a page. A view that wants the next page raises
 * `offset` on the query it passes in and receives a new page; the previous one
 * is replaced rather than appended, because a renderer that stitched pages
 * together would be showing something no single response ever said.
 *
 * ## The response is checked before it is drawn
 *
 * The one thing done to an answer before it is reported is a structural check,
 * `checkDataQueryResponse` from `./DataProvider`, applied to **every**
 * provider's answer, whether or not a library factory built that provider: the
 * response must answer for the query's own `source`, its `data` must be the
 * right kind of container for that source (with the identifying fields of each
 * element or tree, and no more than one page of items), and its paging counters
 * must be absent or non-negative whole numbers. An answer that fails is
 * reported as `status: "error"` with the check's `PROTOCOL_INVALID_MESSAGE`
 * error — retryable like any other failure — rather than as a success a
 * component would read the wrong fields of. The check reads; it never alters
 * what it reads, and a page that passes is reported exactly as it arrived.
 *
 * ## A failure is never dressed as data
 *
 * AAP 0.5.5 governs the state machine here: a failure is never presented as a
 * successful analysis. Concretely, and each of these is a rule this module keeps
 * rather than an accident of its shape:
 *
 * - a rejected call becomes `status: "error"` with the rejection preserved as a
 *   {@link DebuggenError}, never `status: "success"` with an empty page — and
 *   with a faithful code: a provider's own `DebuggenError` keeps the one it
 *   chose, an HTTP failure is mapped by its status (a `503` is
 *   `TRANSPORT_DISCONNECTED`, never `INTERNAL`), and a timeout, network or
 *   foreign abort error is `TRANSPORT_DISCONNECTED` (see {@link toQueryError});
 * - an empty page is a success, because "the capture holds nothing for this
 *   query" is a real answer, and the component's empty state is how it is shown;
 * - an error clears `data`, so no component can render rows from an earlier page
 *   underneath an error banner;
 * - a missing provider, or a missing session to address the query to, is an
 *   error with a code and a remedy in its details rather than an empty result —
 *   a query-backed node mounted outside a host that provides both is a defect
 *   in that host surface, and it is reported where a developer sees it, behind
 *   the error state's technical details rather than on the hint line a panel
 *   user reads;
 * - a request that was aborted, because the node unmounted or because its query
 *   changed, reports nothing at all: no state is written on behalf of a component
 *   that has gone, and a superseded answer never overwrites a newer one.
 *
 * ## No transport, no cache, no timer
 *
 * The only thing this module knows about how data arrives is the
 * {@link DataProvider} interface (AAP 0.1.2): no `fetch`, no socket, no host
 * bridge, no polling, no debouncing and no retry policy of its own. Interaction
 * timing belongs to the components, and a retry is an explicit act by the
 * developer, which is why {@link UseQueryResult.retry} is part of the result
 * instead of a schedule hidden in here.
 *
 * It also holds no cache. Exactly one settlement is kept — the answer to the
 * request currently described by the provider, the session, the query and the
 * attempt counter — so returning to a query that was resolved earlier resolves
 * it again. That is the honest behaviour for a library that cannot know whether
 * a capture has grown since, and it is what keeps all three states derivable
 * from one value instead of from a store whose invalidation nothing here could
 * reason about.
 *
 * What a provider does behind the interface is its own business, within the
 * obligations `DataProvider` states. In particular a provider may coalesce
 * identical requests that are *in flight at the same time* — two nodes of one
 * panel asking for the same trace share one round trip — as long as each call
 * still settles on its own and honours its own signal. A provider that does so
 * decides "identical" with {@link stableQueryKey}, exported for exactly that
 * reason, so the hook and the provider can never disagree about which two
 * queries are the same request.
 *
 * ## Why the query is keyed by value
 *
 * A query-backed component rebuilds its query on every render: the node's own
 * query merged with the local sort, filter and offset the toolbar owns. The
 * object identity of that value therefore changes constantly and means nothing,
 * so this hook keys its work on {@link stableQueryKey} — a deterministic
 * serialisation of the query's *contents* — and never on the object. Keying on
 * identity would refetch on every render; keying on the value refetches exactly
 * when a sort, a filter, a limit or an offset actually changed.
 *
 * ## One failure contract for every node
 *
 * Twelve components render a failed query, and before this module owned the
 * wording each one wrote its own: three title wordings, three query formats,
 * generic text in some nodes and the provider's cause in others (B1-F16,
 * B2-F14). The failure's presentation is therefore composed here, once, by
 * pure helpers a component spreads onto `primitives/ErrorState`:
 *
 * - {@link queryFailureProps} turns a failed result and its query into the
 *   error state's props — a title per {@link QueryFailureScope}, a generic lead
 *   followed by the provider's cause, the error's hint, its code, the query
 *   serialised by {@link formatDataQuery}, the error's details as
 *   pretty-printed JSON for the closed "Technical details" disclosure, the
 *   announcement politeness and the retry;
 * - {@link unsupportedQueryProps} is the same for a node whose query names a
 *   source its component cannot draw, worded from the node catalog;
 * - {@link formatDataQuery} is the one serialisation of a query any error
 *   block shows.
 *
 * ## One alert per burst
 *
 * When the service goes away, every query-backed node of a panel fails within
 * a few milliseconds, and twelve simultaneous `role="alert"` regions interrupt
 * one another until a screen-reader user hears none of them (B2-F14). Each
 * error settlement therefore carries an {@link UseQueryResult.announcement},
 * decided once when the query settles — never during render, where the answer
 * would depend on render order and on how often React chose to render:
 *
 * - a module-private registry holds the failures currently on screen, each
 *   with the time it settled;
 * - a new failure is `"assertive"` unless another active failure settled
 *   within the last {@link FAILURE_BURST_WINDOW_MS}, in which case it is
 *   `"polite"` — so a burst is announced assertively once and politely for the
 *   rest, while an unrelated failure seconds later alerts again;
 * - a failure leaves the registry the moment its settlement stops being the
 *   reported one — a retry, a new query, provider or session, disabling, or an
 *   unmount — and entries older than the window are pruned on every claim, so
 *   a failure whose release was somehow missed can never silence a later one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PANEL_NODE_CATALOG, catalogEntryFor } from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySource, PanelNodeType } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { DebuggenErrorCode } from '@debuggen/shared';

import type { ErrorStateProps } from '../primitives/ErrorState';
import {
  checkDataQueryResponse,
  isAddressableSessionId,
  useDataProvider,
  usePanelSessionId,
} from './DataProvider';
import type { DataProvider, DataQueryResponse, DataResultFor } from './DataProvider';

/*
 * ---------------------------------------------------------------------------
 * Stable query keys
 *
 * One exported function and its module-private recursive helper. It is the one
 * definition of "the same request" in the panel-data contract: this hook keys
 * its effect on it, and a host surface's provider that coalesces identical
 * in-flight requests keys its registry on it (the DevTools panel's
 * `apps/chrome-extension/src/panel/data-provider.ts` does). It lives here, next
 * to its first consumer, rather than in `src/utils/**` — which is shared
 * presentation code with no serialisation vocabulary this belongs in — and is
 * re-exported from the package entry beside `useQuery`.
 * ---------------------------------------------------------------------------
 */

/**
 * The deterministic identity of a query's contents — the one definition of
 * "the same request" shared by {@link useQuery} and by any provider that
 * coalesces identical requests in flight.
 *
 * Two queries that would resolve to the same page produce the same key, and two
 * that would not produce different keys. Three properties make that true:
 *
 * - **object keys are sorted**, so a query assembled field by field in one order
 *   matches one assembled in another;
 * - **array order is preserved**, because the order of a list inside a filter is
 *   part of what it asks for, not incidental;
 * - **members holding `undefined` are omitted**, so an explicitly absent field
 *   is the same request as an omitted one — which matters because the schema
 *   infers every optional field as `?: T | undefined`, and a component spreading
 *   local state into a query routinely produces the explicit form.
 *
 * Written for the JSON values a schema-valid `DataQuery` holds: strings, finite
 * numbers, booleans, `null`, arrays and plain objects. A value outside that set —
 * a function, a symbol, a non-finite number — cannot appear on a query that
 * passed validation, and is folded to `null` rather than throwing: this runs
 * during render, where an exception would take the whole panel down over a
 * malformed query that the error state could otherwise report.
 *
 * Cost is bounded and small. A `DataQuery` has at most four fields beside its
 * source and a filter of at most five, so this is a handful of string
 * concatenations per render — cheaper than the `useMemo` that would be needed to
 * avoid it, which would itself need a stable key to memoize on.
 *
 * The key is for comparison only: it is never parsed, and no consumer may depend
 * on its exact spelling. A consumer that coalesces requests across sessions
 * combines it with the session itself, because the key describes the query's
 * contents and nothing else.
 *
 * @example A provider coalescing identical in-flight requests:
 * ```ts
 * const key = `${sessionId}\n${stableQueryKey(normalizedQuery)}`;
 * const shared = inFlight.get(key) ?? dispatch(key, sessionId, normalizedQuery);
 * ```
 *
 * @param query - The query whose contents identify the request.
 * @returns A string that is equal for equal query contents.
 */
export function stableQueryKey(query: DataQuery): string {
  return serializeStably(query);
}

/**
 * Serialise one JSON-shaped value into the canonical form described on
 * {@link stableQueryKey}.
 *
 * The output is JSON-like but is never parsed: it exists only to be compared, so
 * no consumer may depend on its exact spelling.
 *
 * @param value - Any value reachable inside a query.
 * @returns Its canonical serialisation.
 */
function serializeStably(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'object') {
    if (isUnknownArray(value)) {
      // Order-preserving, and holes and `undefined` members serialise as `null`
      // exactly as `JSON.stringify` renders them — an array position cannot be
      // omitted without shifting every position after it.
      return `[${value.map(serializeStably).join(',')}]`;
    }

    // The one type assertion in this module, and it is sound: `typeof value`
    // is `"object"`, `value` is not `null` and it is not an array, so indexing
    // it by string key is exactly what it supports. The assertion buys back the
    // string index signature that the `object` type does not carry; every value
    // read through it stays `unknown` and is serialised by the same recursion.
    const record = value as Readonly<Record<string, unknown>>;

    // `Array.prototype.sort` with no comparator orders by UTF-16 code unit,
    // which is a total order over the key set and therefore deterministic. The
    // keys of a query are ASCII schema field names, so no locale, normalisation
    // or collation question arises.
    const members = Object.keys(record)
      .sort()
      .filter((name) => record[name] !== undefined)
      .map((name) => `${JSON.stringify(name)}:${serializeStably(record[name])}`);

    return `{${members.join(',')}}`;
  }

  switch (typeof value) {
    case 'string':
      // Quoted and escaped, so a value containing a brace, a comma or a colon
      // cannot imitate the structure around it.
      return JSON.stringify(value);
    case 'number':
      // `NaN` and the infinities have no JSON form and cannot survive schema
      // validation; folding them together is safe because a query can hold
      // neither.
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      // Not reachable through a validated query, but distinguishing two bigints
      // costs one line and prevents a key collision that would suppress a
      // refetch.
      return `${value.toString()}n`;
    default:
      // `undefined`, `function` and `symbol`. None can appear on a validated
      // query, and none has a JSON form.
      return 'null';
  }
}

/**
 * Whether an object is an array, narrowing it to a readonly list of `unknown`.
 *
 * `Array.isArray` on its own narrows to `any[]`, which would leak `any` into the
 * recursion above and through the template literal that consumes it. This
 * predicate keeps the narrowing at `readonly unknown[]`, so every element stays
 * a value the recursion has to inspect rather than one the compiler stops
 * checking.
 *
 * @param value - A non-null object.
 * @returns `true` when `value` is an array.
 */
function isUnknownArray(value: object): value is readonly unknown[] {
  return Array.isArray(value);
}

/*
 * ---------------------------------------------------------------------------
 * The public result
 * ---------------------------------------------------------------------------
 */

/**
 * What {@link useQuery} answers with: one status, the page that status refers to,
 * and a retry.
 *
 * The three statuses are exhaustive and mutually exclusive, and the companion
 * fields are consistent with the status by construction — they are read off a
 * single value, so `"success"` can never arrive with an `error` set and
 * `"error"` can never arrive with rows attached (see {@link useQuery} for the
 * state design that guarantees it):
 *
 * - `"loading"` — nothing is settled yet. `data`, `error`, `announcement` and
 *   the four paging counters are all `undefined`. This is also the status of a
 *   query that is disabled or absent; see the note on
 *   {@link UseQueryOptions.enabled}.
 * - `"success"` — `data` holds the page, exactly as the provider ordered and
 *   paged it, and `error` is `undefined`. An **empty** page is a success: the
 *   capture legitimately holds nothing for this query, which a component renders
 *   as its empty state. So is a `null` trace or component tree, the wire's
 *   "nothing matched".
 * - `"error"` — `error` holds the failure, `announcement` how urgently to
 *   announce it, and `data` is `undefined`, so no component can draw a stale
 *   page beneath an error banner. The component renders its error state —
 *   through {@link queryFailureProps} — and offers
 *   {@link UseQueryResult.retry}. A provider whose answer failed the response
 *   check (see the module documentation) lands here too, with a
 *   `PROTOCOL_INVALID_MESSAGE` error.
 *
 * @typeParam T - The result type of the query's source.
 */
export interface UseQueryResult<T> {
  /** Which of the three states the consumer should render. */
  status: 'loading' | 'error' | 'success';

  /**
   * The resolved page, present only on `"success"`.
   *
   * Owned by the provider and treated as immutable: read it, copy it if
   * something has to be derived from it, never sort or splice it in place. It is
   * the page the query asked for and no more — the array-valued sources report
   * how much more exists through {@link UseQueryResult.total} and
   * {@link UseQueryResult.nextOffset}.
   */
  data: T | undefined;

  /**
   * The failure, present only on `"error"`.
   *
   * Always a `DebuggenError`, whatever the provider rejected with: a code and,
   * where the provider supplied one, a hint an error state can act on. A
   * provider that rejected with its own `DebuggenError` is preserved unchanged,
   * code and all; any other rejection is mapped as faithfully as it allows —
   * an HTTP status to the code it means, a timeout or network failure to
   * `TRANSPORT_DISCONNECTED` — and only a rejection that says nothing about
   * itself becomes `INTERNAL`.
   */
  error: DebuggenError | undefined;

  /**
   * How urgently this failure should be announced, present only on
   * `"error"`.
   *
   * `"assertive"` for a failure that stands alone, `"polite"` for one that
   * settled within {@link FAILURE_BURST_WINDOW_MS} of another failure still on
   * screen — see "One alert per burst" in this module's documentation. Decided
   * once, when the query settled, and stable for as long as this failure is
   * reported. An error state receives it as its `announce` prop, which
   * {@link queryFailureProps} forwards.
   */
  announcement: 'assertive' | 'polite' | undefined;

  /**
   * How many items the source holds in total after the query's filter, before
   * its limit and offset — `undefined` unless the provider reported it.
   *
   * Absent for the sources that are not paged, and absent for any provider that
   * cannot know the total. A footer that says how much of a source a page covers
   * reads it; nothing here computes it.
   */
  total: number | undefined;

  /**
   * The page size the provider reports the service applied — the query's own
   * `limit` or the default filled in for an omitted one — or `undefined` unless
   * the provider reported it.
   *
   * An echo for a footer that states the page size; a view never uses it to
   * compute an offset (see {@link UseQueryResult.nextOffset}).
   */
  limit: number | undefined;

  /**
   * How many items the provider reports the service skipped before this page,
   * or `undefined` unless the provider reported it.
   */
  offset: number | undefined;

  /**
   * The offset that would return the next page, or `undefined` when this page is
   * the last one — or when the source is not paged.
   *
   * `undefined` is the only end-of-data value a component ever sees. The
   * provider may report the last page either by omitting the counter or with the
   * wire's own `null` (see `DataQueryResponse.nextOffset`); this hook folds both
   * into `undefined`, so a view's `nextOffset === undefined` test is complete and
   * a `null` can never read as "another page exists".
   *
   * A view advances paging by copying this value into the `offset` of the query
   * it passes in on the next render. It must never derive an offset from the
   * length of `data`, which drifts the moment a limit is clamped.
   */
  nextOffset: number | undefined;

  /**
   * Resolve the current query again.
   *
   * Referentially stable for the lifetime of the hook, so it can be handed to a
   * memoized error state without defeating the memoization. Calling it returns
   * the result to `"loading"` and calls the provider again — including after a
   * failure, which is the point: the error state a component renders is only
   * useful if the retry it offers really retries. Calling it while a request is
   * in flight abandons that request (it is aborted) and starts a fresh one.
   */
  retry: () => void;
}

/**
 * Options for {@link useQuery}. Every member is optional, and the default
 * behaviour is to resolve the query that was passed.
 */
export interface UseQueryOptions {
  /**
   * Whether the query should be resolved at all. Defaults to `true`.
   *
   * Pass `false` to hold a query back without unmounting the component that owns
   * it — a collapsed section, a view whose sibling owns the visible page, a
   * toolbar mid-edit. While it is `false` the provider is **not** called, an
   * in-flight request is aborted, and the result reads as `"loading"` with no
   * data: the union of statuses is closed at three members, so there is no
   * fourth "idle" status to report, and `"loading"` is the honest member of the
   * three — nothing has been resolved, and nothing about the query has failed.
   * A consumer that must distinguish the two cases knows which it asked for.
   *
   * Passing a query of `undefined` has the same effect and reads the same way,
   * which is what lets a component call this hook unconditionally — as the rules
   * of hooks require — for a node whose query it has not derived yet.
   */
  readonly enabled?: boolean | undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Internal state
 * ---------------------------------------------------------------------------
 */

/**
 * One settled request: the answer, plus a stamp of the request it answered.
 *
 * This is the hook's entire result state, held as **one** value so the reported
 * status and its companion fields cannot disagree — there is no way to write a
 * success that leaves a previous error behind, because both are replaced in the
 * same assignment. `"loading"` is the *absence* of a matching settlement rather
 * than a fourth field, which removes the last inconsistent combination: a
 * settlement that is being superseded cannot linger as "loading with data".
 *
 * The stamp is what makes staleness decidable during render rather than by a
 * follow-up state write. A settlement describes the current request only while
 * the provider, the session, the query key and the attempt counter all still
 * match; the moment any of them changes, the previous answer stops being
 * reported and the result reads as `"loading"` in the very same render that
 * changed it. No component ever draws one query's page while another query's
 * request is in flight, and no reset write is needed to make that true.
 *
 * @typeParam Data - The result type of the query's source.
 */
interface QuerySettlement<Data> {
  /**
   * The provider that produced this answer, and `undefined` for the
   * missing-provider error, which no provider produced. Compared by identity,
   * which is why a provider is expected to be created once per host surface.
   */
  readonly provider: DataProvider | undefined;

  /**
   * The session value in context when the request was made: the session the
   * request was addressed to, or — for the missing-session error — the absent
   * or blank value that made it unaddressable. Part of the stamp so an answer
   * for one session is never reported under a panel for another: the same query
   * shape asked of two sessions is two different requests.
   */
  readonly sessionId: string | undefined;

  /** The {@link stableQueryKey} of the query this answers. */
  readonly key: string;

  /** The value of the attempt counter when the request was made. */
  readonly attempt: number;

  /** Settled requests are one of two things; `"loading"` is their absence. */
  readonly status: 'error' | 'success';

  /** The page, on success. */
  readonly data: Data | undefined;

  /** The failure, on error. */
  readonly error: DebuggenError | undefined;

  /** The failure's announcement politeness, on error; see {@link FailureClaim}. */
  readonly announcement: FailureAnnouncement | undefined;

  /**
   * The failure's entry in the active-failure registry, on error — the token
   * the effects release when this settlement stops being reported.
   */
  readonly claim: FailureClaim | undefined;

  /** The provider's reported total, when it reported one. */
  readonly total: number | undefined;

  /** The provider's reported applied page size, when it reported one. */
  readonly limit: number | undefined;

  /** The provider's reported applied offset, when it reported one. */
  readonly offset: number | undefined;

  /** The provider's reported next offset, when it reported one. */
  readonly nextOffset: number | undefined;
}

/**
 * Whether a settlement answers the request currently described by the provider,
 * the session, the query key and the attempt counter.
 *
 * Every condition is compared explicitly rather than through optional chaining:
 * `settlement?.key === key` is `true` when both are `undefined`, which would
 * report an old answer for a query that has since been removed.
 *
 * @param settlement - The settlement held in state, if any.
 * @param provider - The provider currently in context.
 * @param sessionId - The session currently in context, if any.
 * @param key - The current query's stable key, or `undefined` for no query.
 * @param attempt - The current attempt counter.
 * @returns `true` when the settlement is the answer to the current request.
 */
function describesCurrentRequest<Data>(
  settlement: QuerySettlement<Data> | undefined,
  provider: DataProvider | undefined,
  sessionId: string | undefined,
  key: string | undefined,
  attempt: number,
): settlement is QuerySettlement<Data> {
  return (
    settlement !== undefined &&
    key !== undefined &&
    settlement.key === key &&
    settlement.attempt === attempt &&
    settlement.provider === provider &&
    settlement.sessionId === sessionId
  );
}

/**
 * The error reported for a query-backed node that has no provider above it.
 *
 * A programming error in the host surface, not a data condition, and
 * deliberately not silence: an absent provider renders as an error state naming
 * the missing piece, because the alternative — an empty-looking panel — is the
 * outcome AAP 0.5.5 rules out. `INTERNAL` is the code for it: the closed
 * vocabulary of `DebuggenError` has no member for a renderer host that was
 * assembled wrongly, and `INTERNAL` is the documented default when nothing more
 * specific fits. The details name the source that went unanswered — a member
 * of a closed vocabulary, so nothing sensitive travels with it — and, as
 * `remedy`, the fix. The fix is an instruction to whoever assembled the host,
 * so it is deliberately not the error's `hint`: the hint is the line a panel
 * user reads first, while the details sit behind the error state's closed
 * "Technical details" disclosure (B1-F16).
 *
 * @param source - The source of the query that could not be resolved.
 * @returns A fresh error, so its stack points at the render that needed data.
 */
function missingProviderError(source: DataQuerySource): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    `No data provider is available to resolve the "${source}" query this view is built from.`,
    {
      details: {
        source,
        remedy:
          'Render this view inside a panel host that provides a DataProvider through DataProviderContext.',
      },
    },
  );
}

/**
 * The error reported for a query-backed node that has a provider but no session
 * to address its query to.
 *
 * The same kind of defect as a missing provider, and reported the same way for
 * the same reason: `POST /sessions/:id/panel-data` cannot be addressed without
 * an id, and inventing one — or letting a provider fall back to whichever
 * session it last served — would draw another capture's evidence under this
 * panel's title. `PanelHost` always provides its specification's `sessionId`,
 * so reaching this means a surface mounted query-backed views on its own and
 * provided only half of the data contract. The details name the source and,
 * as `remedy`, the integration fix — kept off the hint line for the reason
 * {@link missingProviderError} records; the unusable value itself is not
 * echoed.
 *
 * @param source - The source of the query that could not be addressed.
 * @returns A fresh error, so its stack points at the render that needed data.
 */
function missingSessionError(source: DataQuerySource): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    `No session is available to address the "${source}" query this view is built from.`,
    {
      details: {
        source,
        remedy:
          "Render this view inside a panel host, which provides its specification's sessionId through PanelSessionContext.",
      },
    },
  );
}

/*
 * ---------------------------------------------------------------------------
 * Rejections: a faithful code for whatever a provider rejected with
 * ---------------------------------------------------------------------------
 */

/**
 * The own-property brand `@debuggen/shared` puts on every `DebuggenError`,
 * spelled through the class's own key so a rename fails to compile here.
 */
const DEBUGGEN_ERROR_BRAND = '__isDebuggenError__' satisfies keyof DebuggenError;

/**
 * The `name`s of the standard errors a transport raises when the connection,
 * rather than the request, failed: a `fetch` or `AbortSignal.timeout` timeout,
 * a network failure, and an abort this hook did not cause. The hook's own
 * abort never reaches {@link toQueryError} — its settlement is discarded by the
 * cancellation guard first — so an `AbortError` arriving here was raised by
 * something below the provider giving up on the request.
 */
const TRANSPORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TimeoutError',
  'NetworkError',
  'AbortError',
]);

/** The lowest HTTP status that reports a failure. */
const HTTP_FAILURE_STATUS_MIN = 400;

/** The highest HTTP status this mapping recognises. */
const HTTP_FAILURE_STATUS_MAX = 599;

/** The lowest server-side HTTP failure status. */
const HTTP_SERVER_FAILURE_STATUS_MIN = 500;

/**
 * One member of a value of unknown shape, read without letting it throw.
 *
 * A rejection can be anything — a proxy, an object with a throwing getter —
 * and this runs inside a promise callback, where an exception would leave the
 * node loading forever instead of showing its error state. `Reflect.get` is
 * used rather than an index expression so no type assertion is needed to read
 * a member off an `object`.
 *
 * @param value - The object to read.
 * @param name - The member's name.
 * @returns The member's value, or `undefined` when it is absent or reading it threw.
 */
function readMember(value: object, name: string): unknown {
  try {
    const member: unknown = Reflect.get(value, name);
    return member;
  } catch {
    return undefined;
  }
}

/**
 * Whether a value is an HTTP status in the failure range this mapping knows.
 *
 * @param value - A candidate status.
 * @returns `true` for a whole number from 400 to 599.
 */
function isHttpFailureStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= HTTP_FAILURE_STATUS_MIN &&
    value <= HTTP_FAILURE_STATUS_MAX
  );
}

/**
 * The HTTP failure status a rejection carries, wherever the common client
 * libraries put it: `status` (the `fetch` `Response` and most wrappers),
 * `statusCode` (Node's `http` family), or `response.status` (clients that
 * attach the response to the error they throw).
 *
 * @param cause - The rejection, known to be an object.
 * @returns The status, or `undefined` when none of the three holds one.
 */
function httpFailureStatusOf(cause: object): number | undefined {
  const status = readMember(cause, 'status');
  if (isHttpFailureStatus(status)) {
    return status;
  }

  const statusCode = readMember(cause, 'statusCode');
  if (isHttpFailureStatus(statusCode)) {
    return statusCode;
  }

  const response = readMember(cause, 'response');
  if (typeof response === 'object' && response !== null) {
    const responseStatus = readMember(response, 'status');
    if (isHttpFailureStatus(responseStatus)) {
      return responseStatus;
    }
  }

  return undefined;
}

/**
 * The error code an HTTP failure status means, in the closed vocabulary of
 * `@debuggen/shared`.
 *
 * Mirrors how the service itself answers the panel-data route: `401`/`403`
 * are a credential it refused, `404` a session it does not hold, `409` a
 * session in a state that cannot answer, `429` a rate limit, `501` a route it
 * does not implement, and `502`/`503`/`504` a service that could not be
 * reached through whatever sits in front of it — a transport failure, which
 * retrying may cure. Any other server status is `INTERNAL`, and any other
 * client status is a request the far side refused as malformed.
 *
 * @param status - An HTTP failure status, 400–599.
 * @returns The code to report it with.
 */
function codeForHttpStatus(status: number): DebuggenErrorCode {
  switch (status) {
    case 401:
    case 403:
      return 'UNAUTHORIZED';
    case 404:
      return 'SESSION_NOT_FOUND';
    case 409:
      return 'SESSION_INVALID_STATE';
    case 429:
      return 'RATE_LIMITED';
    case 501:
      return 'NOT_IMPLEMENTED';
    case 502:
    case 503:
    case 504:
      return 'TRANSPORT_DISCONNECTED';
    default:
      return status >= HTTP_SERVER_FAILURE_STATUS_MIN ? 'INTERNAL' : 'PROTOCOL_INVALID_MESSAGE';
  }
}

/**
 * A rejection's own message, when it has one worth showing.
 *
 * @param cause - The rejection, known to be an object.
 * @returns Its trimmed `message` when that is a non-blank string, else `undefined`.
 */
function ownMessageOf(cause: object): string | undefined {
  const message = readMember(cause, 'message');
  if (typeof message !== 'string') {
    return undefined;
  }

  const trimmed = message.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Normalise whatever a provider rejected with into the `DebuggenError` a node
 * reports, with the most faithful code the rejection allows.
 *
 * `DebuggenError.from` alone wraps every non-`DebuggenError` as `INTERNAL`,
 * which is how a `503` from a service behind a proxy reached a panel as
 * "internal error" (B2-F14). So, in order:
 *
 * 1. **A `DebuggenError`, or a value carrying its brand** — including one from
 *    another bundle, or a revived one — goes through `DebuggenError.from`
 *    unchanged: the provider chose that code, hint and details deliberately.
 * 2. **An object carrying an HTTP failure status** (see
 *    {@link httpFailureStatusOf}) becomes a new error with the code that status
 *    means ({@link codeForHttpStatus}), the rejection's own message when it
 *    has a non-blank one and a sentence naming the status when it does not,
 *    `{ status }` as its details, and the rejection as its `cause`.
 * 3. **An error named `TimeoutError`, `NetworkError` or `AbortError`** becomes
 *    `TRANSPORT_DISCONNECTED`, keeping its message, with its name in the
 *    details and itself as the cause.
 * 4. **Anything else** goes through `DebuggenError.from`, which is `INTERNAL`
 *    with the value preserved as the cause.
 *
 * Total: every read is guarded, and a rejection so hostile that normalising it
 * throws still produces an `INTERNAL` error rather than an exception inside a
 * promise callback, where it would leave the node loading forever.
 *
 * @param cause - The provider's rejection reason, as caught.
 * @returns The error to settle the query with.
 */
function toQueryError(cause: unknown): DebuggenError {
  try {
    if (typeof cause !== 'object' || cause === null) {
      return DebuggenError.from(cause);
    }

    if (DebuggenError.is(cause) || readMember(cause, DEBUGGEN_ERROR_BRAND) === true) {
      return DebuggenError.from(cause);
    }

    const status = httpFailureStatusOf(cause);
    if (status !== undefined) {
      return new DebuggenError(
        codeForHttpStatus(status),
        ownMessageOf(cause) ??
          `The request for this view's data failed with HTTP ${String(status)}.`,
        { details: { status }, cause },
      );
    }

    const name = readMember(cause, 'name');
    if (typeof name === 'string' && TRANSPORT_ERROR_NAMES.has(name)) {
      return new DebuggenError(
        'TRANSPORT_DISCONNECTED',
        ownMessageOf(cause) ?? `The connection carrying this view's data failed (${name}).`,
        { details: { name }, cause },
      );
    }

    return DebuggenError.from(cause);
  } catch {
    return new DebuggenError('INTERNAL', "The request for this view's data failed.", { cause });
  }
}

/*
 * ---------------------------------------------------------------------------
 * Announcements: one alert per burst of failures
 * ---------------------------------------------------------------------------
 */

/** The two politenesses an error state announces with, read off its own prop. */
type FailureAnnouncement = NonNullable<ErrorStateProps['announce']>;

/**
 * How close together two failures must settle to count as one burst, in
 * milliseconds.
 *
 * A panel whose service went away sees every node fail within a few
 * milliseconds of the first — each node's request was already in flight — so
 * one second covers the whole burst with a wide margin, while a failure a
 * reader causes by acting on the panel afterwards (a retry, a new filter)
 * almost always falls outside it and alerts again.
 */
const FAILURE_BURST_WINDOW_MS = 1000;

/**
 * One failure's place in the active-failure registry: the politeness it was
 * given and the time it settled.
 *
 * The object itself is the registry key, so the claim is its own token: a
 * settlement carries it, and releasing it needs nothing else.
 */
interface FailureClaim {
  /** The politeness decided for this failure when it settled. */
  readonly announcement: FailureAnnouncement;

  /** When it settled, on the clock {@link currentTime} reads. */
  readonly settledAt: number;
}

/**
 * The failures currently reported by some mounted `useQuery`, each with the
 * time it settled.
 *
 * Module state, deliberately: the question "did another node just fail?" is
 * about every node on the page, which no single hook instance can see, and
 * threading a coordinator through context would make every query-backed
 * component depend on a provider that exists only to answer it. It is written
 * only from effects and promise callbacks — never during render — so a render
 * React discards or repeats cannot change it.
 */
const activeFailures = new Map<FailureClaim, number>();

/**
 * A monotonic millisecond clock: `performance.now()` where the runtime has it,
 * which every browser and supported Node does, and `Date.now()` otherwise.
 *
 * @returns The current time, in milliseconds on one consistent clock.
 */
function currentTime(): number {
  return typeof globalThis.performance === 'object' ? globalThis.performance.now() : Date.now();
}

/**
 * Register a failure that has just settled and decide how it is announced.
 *
 * Entries older than {@link FAILURE_BURST_WINDOW_MS} are pruned first, so a
 * failure whose release never ran — a settlement superseded before it was
 * ever reported, say — can only suppress announcements for one window. Of
 * what remains, any entry at all means a burst is in progress and this
 * failure is `"polite"`; an empty registry means it stands alone and is
 * `"assertive"`.
 *
 * @returns The new claim, already registered.
 */
function claimFailureAnnouncement(): FailureClaim {
  const settledAt = currentTime();
  let burstInProgress = false;

  // Deleting the entry being visited is safe during `Map` iteration.
  for (const [held, heldAt] of activeFailures) {
    if (settledAt - heldAt >= FAILURE_BURST_WINDOW_MS) {
      activeFailures.delete(held);
    } else {
      burstInProgress = true;
    }
  }

  const claim: FailureClaim = {
    announcement: burstInProgress ? 'polite' : 'assertive',
    settledAt,
  };
  activeFailures.set(claim, settledAt);

  return claim;
}

/**
 * Re-register a claim that is being reported. Idempotent, with the claim's
 * original settle time, so an effect that is torn down and set up again —
 * StrictMode's development double mount, or a subtree hidden and shown again
 * — leaves the registry exactly as it found it.
 *
 * @param claim - The claim of the settlement now on screen.
 */
function holdFailureClaim(claim: FailureClaim): void {
  activeFailures.set(claim, claim.settledAt);
}

/**
 * Remove a claim from the registry. Idempotent: releasing a claim that was
 * already released, or pruned, does nothing.
 *
 * @param claim - The claim of a settlement that is no longer reported.
 */
function releaseFailureClaim(claim: FailureClaim): void {
  activeFailures.delete(claim);
}

/*
 * ---------------------------------------------------------------------------
 * The hook
 * ---------------------------------------------------------------------------
 */

/**
 * Resolve one page of one `DataQuery` through the ambient {@link DataProvider}.
 *
 * The hook every query-backed visualization component calls, and the only caller
 * of a provider in this library. It is generic over the query's source, so the
 * resolved page is typed precisely at the call site — a query for render
 * statistics resolves to render statistics, a query for a correlated trace to a
 * trace tree — with no cast and no re-checking in the component.
 *
 * ## What it does, in order
 *
 * 1. Reads the provider and the panel's session id from context. A missing
 *    provider, or a missing or blank session id, is reported as an error (see
 *    {@link missingProviderError} and {@link missingSessionError}); it never
 *    throws, because a throw here would take down a panel instead of showing a
 *    node's error state.
 * 2. Computes the query's {@link stableQueryKey}. That key, the provider's
 *    identity, the session id and the attempt counter together identify "the
 *    current request".
 * 3. Resolves that request once through `provider.query(sessionId, query, …)` —
 *    the session id exactly as the context holds it, the query exactly as the
 *    node carried it — with an `AbortController` whose signal travels on the
 *    call. The effect's cleanup aborts it, so a request is abandoned the moment
 *    the node unmounts, the query changes, the provider or the session changes,
 *    the query is disabled or a retry supersedes it — and the settlement of an
 *    abandoned request is discarded rather than written, which is what keeps a
 *    slow first answer from overwriting a fast second one.
 * 4. Checks an answer with `checkDataQueryResponse` before reporting it: an
 *    answer for another source, a payload that is not this source's container,
 *    or an unusable paging counter settles as an error stamped with the very
 *    request it answered, so {@link UseQueryResult.retry} asks the provider the
 *    same query again.
 * 5. Reports the outcome as one of the three states of {@link UseQueryResult},
 *    with the provider's `null` end-of-data marker folded into `undefined` and,
 *    for a failure, the announcement politeness decided when it settled (see
 *    "One alert per burst" above).
 *
 * ## States
 *
 * See {@link UseQueryResult} for the field-by-field contract and
 * {@link UseQueryOptions.enabled} for the disabled and absent-query cases, which
 * read as `"loading"` with no data and make no call. Every consumer is expected
 * to render all three states — loading, empty (a successful empty page) and
 * error — which is what AAP 0.6.2 requires of a query-backed view.
 *
 * @example
 * ```ts
 * const { status, data, error, total, limit, nextOffset, retry } = useQuery(
 *   { source: 'spans', sort: 'duration_desc', limit: pageSize, offset },
 * );
 * ```
 *
 * @typeParam S - The query's source, inferred from `query.source`.
 * @param query - The query to resolve, or `undefined` to resolve nothing. Passed
 * to the provider untouched; rebuild it freely on every render, since the hook
 * compares its contents and not its identity.
 * @param options - See {@link UseQueryOptions}.
 * @returns The current state of that one query.
 */
export function useQuery<S extends DataQuerySource>(
  query: (DataQuery & { source: S }) | undefined,
  options?: UseQueryOptions,
): UseQueryResult<DataResultFor<S>> {
  const provider = useDataProvider();
  const sessionId = usePanelSessionId();
  const enabled = options?.enabled ?? true;

  // Recomputed every render, deliberately: the key is what makes an unstable
  // query object comparable, so memoizing it would need the very key it
  // computes. See `stableQueryKey` for the cost.
  const key = query === undefined ? undefined : stableQueryKey(query);

  // The retry nonce. Incrementing it changes the identity of the current
  // request, which both re-runs the effect below and — because the held
  // settlement no longer matches — returns the reported state to `"loading"` in
  // the same render, with no reset write anywhere.
  const [attempt, setAttempt] = useState(0);

  const [settlement, setSettlement] = useState<QuerySettlement<DataResultFor<S>> | undefined>(
    undefined,
  );

  // The query the fetch effect resolves, reachable without being a dependency of
  // it. The effect must re-run when the query's *contents* change and not when
  // its identity does, so it depends on `key` and reads the query from here.
  //
  // The invariant that makes this sound: this ref is synchronised by the effect
  // immediately below, which is declared *before* the fetch effect and therefore
  // runs before it in every commit (React flushes a fiber's effects in hook
  // order), while `useRef`'s initial value covers the first one. So whenever the
  // fetch effect runs, this holds a query whose stable key is exactly the `key`
  // that effect was keyed on.
  const latestQuery = useRef(query);

  useEffect(() => {
    latestQuery.current = query;
  }, [query]);

  useEffect(() => {
    if (!enabled || key === undefined) {
      // Disabled, or no query to resolve. Nothing is called and nothing is
      // written: the reported state already reads as `"loading"` because no
      // settlement can match an absent key, and a disabled hook reports the
      // same. Any request that was in flight has just been aborted by this
      // effect's previous cleanup.
      return undefined;
    }

    const pending = latestQuery.current;
    if (pending === undefined) {
      // Unreachable by the ref invariant above — a defined `key` is derived from
      // a defined query, and the ref was synchronised with that same query
      // earlier in this commit. Kept because the compiler cannot see the
      // invariant, and written as "resolve nothing" rather than as an error,
      // since there is no query to attribute a failure to.
      return undefined;
    }

    // The failure this run of the effect reports, if its request fails. Every
    // error settlement written below is stamped with exactly this effect's
    // dependencies — provider, session, key, attempt — and is reported only
    // while it is enabled, so the settlement stops being the reported one at
    // precisely the moment this effect is cleaned up. The cleanup is therefore
    // where the claim is released, which also covers a settlement that was
    // written but superseded before any render reported it.
    let claim: FailureClaim | undefined;

    const releaseClaim = (): void => {
      if (claim !== undefined) {
        releaseFailureClaim(claim);
        claim = undefined;
      }
    };

    // Every failure settles through here, so every one of them — rejection,
    // refused response, missing provider, missing session — is announced by
    // the same policy, decided once, at settle time.
    const settleFailure = (error: DebuggenError, answeredBy: DataProvider | undefined): void => {
      claim = claimFailureAnnouncement();
      setSettlement({
        provider: answeredBy,
        sessionId,
        key,
        attempt,
        status: 'error',
        data: undefined,
        error,
        announcement: claim.announcement,
        claim,
        total: undefined,
        limit: undefined,
        offset: undefined,
        nextOffset: undefined,
      });
    };

    if (provider === undefined) {
      settleFailure(missingProviderError(pending.source), undefined);
      return releaseClaim;
    }

    if (!isAddressableSessionId(sessionId)) {
      // A provider with nowhere to address the query. Reported rather than
      // forwarded: the provider would reject a blank session anyway, but only
      // after a transport hop, and a query must never go out addressed to a
      // session this panel does not name. Stamped with the unusable value that
      // is in context, so providing a real session afterwards supersedes it.
      settleFailure(missingSessionError(pending.source), provider);
      return releaseClaim;
    }

    // Flipped by the cleanup below. Every settlement is written through this
    // guard, so an answer that arrives for a request nobody is waiting for any
    // more — a provider that ignores its abort signal, or simply one that was
    // already resolving when the query changed — is dropped instead of
    // overwriting a newer request's state or updating a component that unmounted.
    let cancelled = false;
    const controller = new AbortController();

    // `void`, because the promise is deliberately not awaited by anything: both
    // outcomes are handled here, so there is nothing left for a caller to catch.
    // The type argument is explicit so the response's `data` is typed as this
    // source's result rather than inferred from an intersection — which is why
    // no cast is needed anywhere in this module. The session id is the one the
    // context holds, passed exactly: `PanelHost` puts its specification's own
    // `sessionId` there, and that is the only session this panel may read.
    void provider.query<S>(sessionId, pending, { signal: controller.signal }).then(
      (response: DataQueryResponse<S>) => {
        if (cancelled) {
          return;
        }

        // Checked before anything reads it, whichever provider answered: the
        // generic signature promised this source's response, but nothing at
        // runtime made a hand-written provider keep that promise. An answer
        // for another source, a payload that is not this source's container,
        // or an unusable counter is a failure, never a success a component
        // would draw the wrong evidence from or throw on. It settles as an
        // error stamped with this very request — provider, session, key and
        // attempt — so the retry the error state offers re-issues the same
        // query, and a later correct answer supersedes it like any other.
        const problem = checkDataQueryResponse(pending, response);
        if (problem !== undefined) {
          settleFailure(problem, provider);
          return;
        }

        // A checked answer is written through verbatim: no transformation, no
        // re-ordering, no merging with a previous page (AAP 0.4.2). An empty
        // page is a success, and the component's empty state is how it shows.
        // The one normalisation is of spelling, not of meaning: the wire's
        // `nextOffset: null` ("this is the last page") becomes the `undefined`
        // every component already reads as end-of-data.
        setSettlement({
          provider,
          sessionId,
          key,
          attempt,
          status: 'success',
          data: response.data,
          error: undefined,
          announcement: undefined,
          claim: undefined,
          total: response.total,
          limit: response.limit,
          offset: response.offset,
          nextOffset: response.nextOffset ?? undefined,
        });
      },
      (cause: unknown) => {
        if (cancelled) {
          // Includes the abort this hook itself caused, which is not a failure
          // and must not be reported as one.
          return;
        }

        // `toQueryError` returns a provider's own `DebuggenError` unchanged —
        // preserving the code and hint it chose, even across a bundle boundary
        // — and maps anything else to the most faithful code it allows, so a
        // component always has a typed error to render (AAP 0.5.5). `data` is
        // cleared with it, so an error state can never be drawn over rows from
        // an earlier answer.
        settleFailure(toQueryError(cause), provider);
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
      releaseClaim();
    };
  }, [provider, sessionId, key, enabled, attempt]);

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  // Staleness is decided here, during render, rather than by a state write: a
  // settlement is reported only while it still answers the current request, so
  // changing a sort, advancing an offset, retrying, disabling the query, or
  // swapping the provider or the session reads as `"loading"` immediately and
  // without a second render.
  const settled =
    enabled && describesCurrentRequest(settlement, provider, sessionId, key, attempt)
      ? settlement
      : undefined;

  // The failure on screen, if any, holds its place in the active-failure
  // registry for exactly as long as it is reported. Set up idempotently with
  // the claim's own settle time, so an effect torn down and set up again
  // without its settlement changing — StrictMode's development remount, a
  // subtree hidden and shown again — re-registers the failure still on screen
  // rather than leaving it out; torn down, it releases the claim, which the
  // fetch effect's cleanup also does for the same settlement.
  const reportedClaim = settled?.claim;

  useEffect(() => {
    if (reportedClaim === undefined) {
      return undefined;
    }

    holdFailureClaim(reportedClaim);

    return () => {
      releaseFailureClaim(reportedClaim);
    };
  }, [reportedClaim]);

  // Memoized because twelve components read this inside render and some of them
  // pass it, or its `retry`, into memoized children. Both dependencies are
  // stable: `settled` changes only when the settlement or the request it answers
  // changes, and `retry` never changes.
  return useMemo<UseQueryResult<DataResultFor<S>>>(
    () => ({
      status: settled === undefined ? 'loading' : settled.status,
      data: settled?.data,
      error: settled?.error,
      announcement: settled?.announcement,
      total: settled?.total,
      limit: settled?.limit,
      offset: settled?.offset,
      nextOffset: settled?.nextOffset,
      retry,
    }),
    [settled, retry],
  );
}

/*
 * ---------------------------------------------------------------------------
 * Failure presentation: the one error-state contract every node spreads
 *
 * Pure, module-level functions rather than part of the hook, so a component
 * can call them only in its error branch, with the query it actually asked,
 * and so they can be tested without rendering anything.
 * ---------------------------------------------------------------------------
 */

/** The title of a node whose own data could not be loaded. */
export const QUERY_FAILURE_TITLE = 'Could not load this view';

/**
 * The title of a failed next page, for a view that keeps the rows it already
 * shows and reports the page below them.
 */
export const PAGE_FAILURE_TITLE = 'Could not load the next page';

/** The title of a node whose query names a source its component cannot draw. */
export const UNSUPPORTED_QUERY_TITLE = 'This view cannot draw the requested data';

/**
 * What failed: the view's own data (`"view"`, the default), or the next page
 * of a view that already shows earlier rows (`"page"`).
 */
export type QueryFailureScope = 'view' | 'page';

/**
 * The error-state props {@link queryFailureProps} composes: every member of
 * `primitives/ErrorState`'s props that describes a failed query, and nothing
 * else, so spreading it leaves a component free to add only layout.
 */
export interface QueryFailureProps {
  /** The first line, by scope: {@link QUERY_FAILURE_TITLE} or {@link PAGE_FAILURE_TITLE}. */
  title: string;

  /** The generic lead for the scope, followed by the provider's own cause. */
  message: string;

  /** What the reader can do, when the error carries a non-blank hint. */
  hint: string | undefined;

  /** The error's machine code; `INTERNAL` when no error was supplied. */
  code: string;

  /** The failing query, serialised by {@link formatDataQuery}. */
  query: string;

  /** The error's details as pretty-printed JSON, when it has any. */
  details: string | undefined;

  /** The announcement politeness the query settled with. */
  announce: 'assertive' | 'polite';

  /** The hook's retry, which asks the provider the same query again. */
  onRetry: () => void;
}

/** The copy that differs between the two failure scopes. */
interface FailureScopeCopy {
  /** The error state's first line. */
  readonly title: string;

  /** The sentence the message opens with, before the provider's cause. */
  readonly lead: string;
}

/**
 * The title and lead of each scope. A total lookup, so a third scope cannot be
 * added without its wording.
 *
 * The leads say what failed in reader terms and nothing about why — the why is
 * the provider's cause, appended after the lead — and the page lead also says
 * what did not fail, because a reader looking at a table with an error beneath
 * it needs to know whether the rows above are still true.
 */
const FAILURE_SCOPE_COPY: Readonly<Record<QueryFailureScope, FailureScopeCopy>> = {
  view: {
    title: QUERY_FAILURE_TITLE,
    lead: 'The data for this view could not be loaded.',
  },
  page: {
    title: PAGE_FAILURE_TITLE,
    lead: 'The next page of this view could not be loaded. The rows already shown are unaffected.',
  },
};

/** The code reported when a caller composes failure props with no error at all. */
const UNKNOWN_FAILURE_CODE: DebuggenErrorCode = 'INTERNAL';

/** The indentation every serialised block uses: two spaces, as `JSON.stringify` counts it. */
const JSON_INDENT = 2;

/**
 * The members of a `DataQuery`, in the order a reader scans them: what is
 * read, how it is narrowed, how it is ordered, how much of it, from where.
 */
const DATA_QUERY_MEMBER_ORDER: readonly string[] = ['source', 'filter', 'sort', 'limit', 'offset'];

/**
 * A sentence that already ends in terminal punctuation, allowing for a closing
 * quotation mark or bracket after it.
 */
const TERMINAL_PUNCTUATION = /[.!?…]["'”’)\]]*$/u;

/**
 * Whether a value is a plain, non-array object, narrowing it to a record whose
 * every member stays `unknown`.
 *
 * @param value - Any value.
 * @returns `true` for a non-null object that is not an array.
 */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A record's defined members as entries, keys sorted by UTF-16 code unit.
 *
 * @param record - The record to read.
 * @returns `[key, value]` pairs, sorted, with `undefined` members omitted.
 */
function sortedDefinedEntries(record: Readonly<Record<string, unknown>>): [string, unknown][] {
  return Object.keys(record)
    .sort()
    .filter((name) => record[name] !== undefined)
    .map((name): [string, unknown] => [name, record[name]]);
}

/**
 * The canonical shape of a query: its members in {@link DATA_QUERY_MEMBER_ORDER}
 * followed by any other member in key order, the filter's members in key
 * order, and every `undefined` member omitted.
 *
 * Built with `Object.fromEntries`, which defines each member as an own data
 * property, so a member named like a prototype accessor cannot reach the
 * result's prototype.
 *
 * @param query - The query to reshape.
 * @returns A fresh object with the same contents, in canonical order.
 */
function canonicalQueryShape(query: DataQuery): Readonly<Record<string, unknown>> {
  const record: Readonly<Record<string, unknown>> = query;
  const entries: [string, unknown][] = [];

  for (const name of DATA_QUERY_MEMBER_ORDER) {
    const value = record[name];
    if (value !== undefined) {
      entries.push([
        name,
        name === 'filter' && isPlainRecord(value)
          ? Object.fromEntries(sortedDefinedEntries(value))
          : value,
      ]);
    }
  }

  for (const entry of sortedDefinedEntries(record)) {
    if (!DATA_QUERY_MEMBER_ORDER.includes(entry[0])) {
      entries.push(entry);
    }
  }

  return Object.fromEntries(entries);
}

/**
 * Serialise a query into the one form every error block in this package shows
 * it in.
 *
 * Pretty-printed JSON with a two-space indent, so a reader can check a
 * request member by member, and canonical, so two nodes that asked for the
 * same thing print the same text: `source`, `filter`, `sort`, `limit`,
 * `offset` in that order, then any other member in key order; the filter's
 * members in key order; `undefined` members omitted, so an explicitly absent
 * field reads the same as an omitted one; array order preserved, because the
 * order of a list inside a filter is part of what it asks for.
 *
 * Never throws: this runs inside an error branch, where an exception would
 * replace the failure being reported with a crash. A query that cannot be
 * serialised — a value no validated query holds, such as a `bigint` or a cycle
 * — is shown by its source alone.
 *
 * @example
 * ```ts
 * formatDataQuery({ limit: 50, source: 'spans', filter: { tier: 'server', kind: 'db.query' } });
 * // {
 * //   "source": "spans",
 * //   "filter": {
 * //     "kind": "db.query",
 * //     "tier": "server"
 * //   },
 * //   "limit": 50
 * // }
 * ```
 *
 * @param query - The query to serialise.
 * @returns The query's canonical pretty-printed JSON form.
 */
export function formatDataQuery(query: DataQuery): string {
  try {
    return JSON.stringify(canonicalQueryShape(query), null, JSON_INDENT);
  } catch {
    return formatQuerySource(query);
  }
}

/**
 * The last-resort form of {@link formatDataQuery}: the query's source alone,
 * in the same JSON layout.
 *
 * @param query - The query that could not be serialised in full.
 * @returns `{ "source": … }`, or `{}` when even the source cannot be read.
 */
function formatQuerySource(query: DataQuery): string {
  try {
    return JSON.stringify({ source: query.source }, null, JSON_INDENT);
  } catch {
    return '{}';
  }
}

/**
 * A sentence ending in terminal punctuation: the text as given when it already
 * ends in some, and with a full stop appended when it does not.
 *
 * @param sentence - A trimmed, non-blank sentence.
 * @returns The sentence, terminated.
 */
function asSentence(sentence: string): string {
  return TERMINAL_PUNCTUATION.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * The message of a failure: the scope's generic lead, then the provider's own
 * cause as a sentence of its own.
 *
 * The lead is what every reader needs and the cause is what makes this failure
 * this one, so both are kept: the lead alone hides the cause, and the cause
 * alone reads differently from node to node (B2-F14). A blank cause, or one
 * identical to the lead, adds nothing and is omitted.
 *
 * @param lead - The scope's lead sentence.
 * @param cause - The error's message, if any.
 * @returns The composed message.
 */
function composeFailureMessage(lead: string, cause: string | undefined): string {
  const trimmed = cause?.trim() ?? '';
  if (trimmed === '' || trimmed === lead) {
    return lead;
  }

  return `${lead} ${asSentence(trimmed)}`;
}

/**
 * A hint worth a line of its own.
 *
 * @param hint - The error's hint, if any.
 * @returns The trimmed hint, or `undefined` when it is absent or blank.
 */
function nonBlankHint(hint: string | undefined): string | undefined {
  const trimmed = hint?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * An error's diagnostic details, serialised for the error state's closed
 * "Technical details" disclosure.
 *
 * Pretty-printed with the same indent as the query block. The details of a
 * `DebuggenError` are restricted by `@debuggen/shared` to values that are safe
 * to show, and they arrive already redacted, so nothing is filtered here —
 * but the serialisation is guarded, because a provider's details can hold a
 * value `JSON.stringify` refuses, and an error branch must not throw.
 *
 * @param details - The error's details, if any.
 * @returns The JSON text, or `undefined` for absent, empty or unserialisable details.
 */
function formatErrorDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (details === undefined || Object.keys(details).length === 0) {
    return undefined;
  }

  try {
    return JSON.stringify(details, null, JSON_INDENT);
  } catch {
    return undefined;
  }
}

/**
 * Compose the error-state props of a failed query — the one contract every
 * query-backed node renders its failure with.
 *
 * - `title` — {@link QUERY_FAILURE_TITLE}, or {@link PAGE_FAILURE_TITLE} for
 *   `scope: "page"`;
 * - `message` — the scope's generic lead ("The data for this view could not be
 *   loaded.") followed by the error's own message as a sentence of its own,
 *   omitted when blank or identical to the lead;
 * - `hint` — the error's hint, when non-blank;
 * - `code` — the error's code, `INTERNAL` when no error was supplied;
 * - `query` — the query as {@link formatDataQuery} prints it;
 * - `details` — the error's details as pretty-printed JSON, when it has any;
 * - `announce` — the politeness the query settled with (`"assertive"` when the
 *   result carries none);
 * - `onRetry` — the hook's retry.
 *
 * Pure: it reads its arguments and returns a fresh object, so calling it in
 * render is free of effects.
 *
 * @example
 * ```tsx
 * const result = useQuery(query);
 * if (result.status === 'error') {
 *   return <ErrorState {...queryFailureProps(result, query)} />;
 * }
 * // A failed next page below rows that are still shown:
 * <ErrorState {...queryFailureProps(pageResult, pageQuery, { scope: 'page' })} />
 * ```
 *
 * @param result - The hook's result, or the three members of it that describe a failure.
 * @param query - The query that failed, exactly as it was asked.
 * @param options - `scope`: what failed, `"view"` by default.
 * @returns The props to spread onto `ErrorState`.
 */
export function queryFailureProps(
  result: Pick<UseQueryResult<unknown>, 'error' | 'announcement' | 'retry'>,
  query: DataQuery,
  options?: { readonly scope?: QueryFailureScope | undefined },
): QueryFailureProps {
  const { error, announcement, retry } = result;
  const copy = FAILURE_SCOPE_COPY[options?.scope ?? 'view'];

  return {
    title: copy.title,
    message: composeFailureMessage(copy.lead, error?.message),
    hint: nonBlankHint(error?.hint),
    code: error?.code ?? UNKNOWN_FAILURE_CODE,
    query: formatDataQuery(query),
    details: formatErrorDetails(error?.details),
    announce: announcement ?? 'assertive',
    onRetry: retry,
  };
}

/**
 * A list of source names in prose: `"a"`, `"a" or "b"`, `"a", "b" or "c"`.
 *
 * @param sources - The names to list; at least one.
 * @returns The quoted, joined list.
 */
function quotedAlternatives(sources: readonly string[]): string {
  const quoted = sources.map((source) => `"${source}"`);
  const last = quoted.pop();

  if (last === undefined) {
    return '';
  }

  return quoted.length === 0 ? last : `${quoted.join(', ')} or ${last}`;
}

/**
 * Compose the error-state props of a node whose query names a source its
 * component cannot draw.
 *
 * A defect in the panel rather than a failed request, so there is no retry
 * and no announcement override: asking again cannot change the answer, and a
 * lone structural defect warrants the default alert. The message is worded
 * from the node catalog — the component's `label` and the `sources` it
 * reads — so it states exactly what the view can draw next to what it was
 * asked for, and never drifts from the catalog it describes.
 *
 * @example
 * ```ts
 * unsupportedQueryProps('renderTable', { source: 'spans' }).message;
 * // 'The Render table view reads "renders" data, but this panel asks it for "spans".'
 * ```
 *
 * @param nodeType - The node type whose component received the query.
 * @param query - The query it cannot draw.
 * @returns The props to spread onto `ErrorState`.
 */
export function unsupportedQueryProps(
  nodeType: PanelNodeType,
  query: DataQuery,
): { title: string; message: string; code: 'PANEL_INVALID'; query: string } {
  return {
    title: UNSUPPORTED_QUERY_TITLE,
    message: unsupportedQueryMessage(nodeType, query.source),
    code: 'PANEL_INVALID',
    query: formatDataQuery(query),
  };
}

/**
 * The sentence {@link unsupportedQueryProps} states.
 *
 * The catalog is consulted with an own-property test first: the type admits
 * only catalogued node types, but this runs in an error branch that exists
 * because a document reached a component it did not fit, and a lookup that
 * threw here would replace the failure with a crash.
 *
 * @param nodeType - The node type whose component received the query.
 * @param requested - The source the query names.
 * @returns The message.
 */
function unsupportedQueryMessage(nodeType: PanelNodeType, requested: DataQuerySource): string {
  if (!Object.hasOwn(PANEL_NODE_CATALOG, nodeType)) {
    return `This view reads no catalogued data, but this panel asks it for "${requested}".`;
  }

  const { label, sources } = catalogEntryFor(nodeType);
  const readable = sources.length === 0 ? 'no query' : quotedAlternatives(sources);

  return `The ${label} view reads ${readable} data, but this panel asks it for "${requested}".`;
}
