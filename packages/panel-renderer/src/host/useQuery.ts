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
 * Nothing below re-sorts, merges, concatenates, de-duplicates, truncates or
 * validates a page. A view that wants the next page raises `offset` on the query
 * it passes in and receives a new page; the previous one is replaced rather than
 * appended, because a renderer that stitched pages together would be showing
 * something no single response ever said.
 *
 * ## A failure is never dressed as data
 *
 * AAP 0.5.5 governs the state machine here: a failure is never presented as a
 * successful analysis. Concretely, and each of these is a rule this module keeps
 * rather than an accident of its shape:
 *
 * - a rejected call becomes `status: "error"` with the rejection preserved as a
 *   {@link DebuggenError}, never `status: "success"` with an empty page;
 * - an empty page is a success, because "the capture holds nothing for this
 *   query" is a real answer, and the component's empty state is how it is shown;
 * - an error clears `data`, so no component can render rows from an earlier page
 *   underneath an error banner;
 * - a missing provider is an error with a code and a hint rather than an empty
 *   result — a query-backed node mounted outside a host that provides data is a
 *   defect in that host surface, and it is reported where a developer sees it;
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
 * request currently described by the provider, the query and the attempt counter
 * — so returning to a query that was resolved earlier resolves it again. That is
 * the honest behaviour for a library that cannot know whether a capture has grown
 * since, and it is what keeps all three states derivable from one value instead
 * of from a store whose invalidation nothing here could reason about.
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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DataQuery, DataQuerySource } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';

import { useDataProvider } from './DataProvider';
import type { DataProvider, DataQueryResponse, DataResultFor } from './DataProvider';

/*
 * ---------------------------------------------------------------------------
 * Stable query keys
 *
 * One module-private function and its recursive helper. Deliberately local: it
 * describes what "the same request" means for this hook and for nothing else,
 * and `src/utils/**` — which is shared, exported presentation code — has no
 * serialisation vocabulary this belongs in.
 * ---------------------------------------------------------------------------
 */

/**
 * The deterministic identity of a query's contents.
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
 * @param query - The query whose contents identify the request.
 * @returns A string that is equal for equal query contents.
 */
function stableQueryKey(query: DataQuery): string {
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
 * - `"loading"` — nothing is settled yet. `data`, `error`, `total` and
 *   `nextOffset` are all `undefined`. This is also the status of a query that is
 *   disabled or absent; see the note on {@link UseQueryOptions.enabled}.
 * - `"success"` — `data` holds the page, exactly as the provider ordered and
 *   paged it, and `error` is `undefined`. An **empty** page is a success: the
 *   capture legitimately holds nothing for this query, which a component renders
 *   as its empty state.
 * - `"error"` — `error` holds the failure and `data` is `undefined`, so no
 *   component can draw a stale page beneath an error banner. The component
 *   renders its error state and offers {@link UseQueryResult.retry}.
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
   * code and all.
   */
  error: DebuggenError | undefined;

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
   * The offset that would return the next page, or `undefined` when this page is
   * the last one — or when the source is not paged.
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
 * the provider, the query key and the attempt counter all still match; the
 * moment any of them changes, the previous answer stops being reported and the
 * result reads as `"loading"` in the very same render that changed it. No
 * component ever draws one query's page while another query's request is in
 * flight, and no reset write is needed to make that true.
 *
 * @typeParam Data - The result type of the query's source.
 */
interface QuerySettlement<Data> {
  /**
   * The provider that produced this answer, and `undefined` for the
   * missing-provider error, which no provider produced. Compared by identity,
   * which is why a provider is expected to be created once per session.
   */
  readonly provider: DataProvider | undefined;

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

  /** The provider's reported total, when it reported one. */
  readonly total: number | undefined;

  /** The provider's reported next offset, when it reported one. */
  readonly nextOffset: number | undefined;
}

/**
 * Whether a settlement answers the request currently described by the provider,
 * the query key and the attempt counter.
 *
 * Every condition is compared explicitly rather than through optional chaining:
 * `settlement?.key === key` is `true` when both are `undefined`, which would
 * report an old answer for a query that has since been removed.
 *
 * @param settlement - The settlement held in state, if any.
 * @param provider - The provider currently in context.
 * @param key - The current query's stable key, or `undefined` for no query.
 * @param attempt - The current attempt counter.
 * @returns `true` when the settlement is the answer to the current request.
 */
function describesCurrentRequest<Data>(
  settlement: QuerySettlement<Data> | undefined,
  provider: DataProvider | undefined,
  key: string | undefined,
  attempt: number,
): settlement is QuerySettlement<Data> {
  return (
    settlement !== undefined &&
    key !== undefined &&
    settlement.key === key &&
    settlement.attempt === attempt &&
    settlement.provider === provider
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
 * specific fits. The hint names the fix, and the details name the source that
 * went unanswered — a member of a closed vocabulary, so nothing sensitive
 * travels with it.
 *
 * @param source - The source of the query that could not be resolved.
 * @returns A fresh error, so its stack points at the render that needed data.
 */
function missingProviderError(source: DataQuerySource): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    `No data provider is available to resolve the "${source}" query this view is built from.`,
    {
      hint: 'Render this view inside a panel host that provides a DataProvider through DataProviderContext.',
      details: { source },
    },
  );
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
 * 1. Reads the provider from context. A missing provider is reported as an error
 *    (see {@link missingProviderError}); it never throws, because a throw here
 *    would take down a panel instead of showing a node's error state.
 * 2. Computes the query's {@link stableQueryKey}. That key, the provider's
 *    identity and the attempt counter together identify "the current request".
 * 3. Resolves that request once through `provider.query`, with an
 *    `AbortController` whose signal travels on the call. The effect's cleanup
 *    aborts it, so a request is abandoned the moment the node unmounts, the
 *    query changes, the provider changes, the query is disabled or a retry
 *    supersedes it — and the settlement of an abandoned request is discarded
 *    rather than written, which is what keeps a slow first answer from
 *    overwriting a fast second one.
 * 4. Reports the outcome as one of the three states of {@link UseQueryResult}.
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
 * const { status, data, error, total, nextOffset, retry } = useQuery(
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

    if (provider === undefined) {
      setSettlement({
        provider: undefined,
        key,
        attempt,
        status: 'error',
        data: undefined,
        error: missingProviderError(pending.source),
        total: undefined,
        nextOffset: undefined,
      });
      return undefined;
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
    // no cast is needed anywhere in this module.
    void provider.query<S>(pending, { signal: controller.signal }).then(
      (response: DataQueryResponse<S>) => {
        if (cancelled) {
          return;
        }

        // Written through verbatim: no validation, no transformation, no
        // re-ordering, no merging with a previous page (AAP 0.4.2). An empty
        // page is a success, and the component's empty state is how it shows.
        setSettlement({
          provider,
          key,
          attempt,
          status: 'success',
          data: response.data,
          error: undefined,
          total: response.total,
          nextOffset: response.nextOffset,
        });
      },
      (cause: unknown) => {
        if (cancelled) {
          // Includes the abort this hook itself caused, which is not a failure
          // and must not be reported as one.
          return;
        }

        // `from` returns a provider's own `DebuggenError` unchanged — preserving
        // the code and hint it chose, even across a bundle boundary — and wraps
        // anything else, so a component always has a typed error to render
        // (AAP 0.5.5). `data` is cleared with it, so an error state can never be
        // drawn over rows from an earlier answer.
        setSettlement({
          provider,
          key,
          attempt,
          status: 'error',
          data: undefined,
          error: DebuggenError.from(cause),
          total: undefined,
          nextOffset: undefined,
        });
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [provider, key, enabled, attempt]);

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  // Staleness is decided here, during render, rather than by a state write: a
  // settlement is reported only while it still answers the current request, so
  // changing a sort, advancing an offset, retrying, disabling the query or
  // swapping the provider reads as `"loading"` immediately and without a second
  // render.
  const settled =
    enabled && describesCurrentRequest(settlement, provider, key, attempt) ? settlement : undefined;

  // Memoized because twelve components read this inside render and some of them
  // pass it, or its `retry`, into memoized children. Both dependencies are
  // stable: `settled` changes only when the settlement or the request it answers
  // changes, and `retry` never changes.
  return useMemo<UseQueryResult<DataResultFor<S>>>(
    () => ({
      status: settled === undefined ? 'loading' : settled.status,
      data: settled?.data,
      error: settled?.error,
      total: settled?.total,
      nextOffset: settled?.nextOffset,
      retry,
    }),
    [settled, retry],
  );
}
