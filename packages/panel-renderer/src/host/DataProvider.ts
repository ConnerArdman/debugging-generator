/**
 * The renderer's data seam: transport-agnostic access to the prepared views of a
 * capture that a panel node draws.
 *
 * This module declares one interface — {@link DataProvider} — plus the result
 * types it resolves to and the React context that carries it down the tree. It
 * contains no transport of any kind: no socket, no `fetch`, no message port, no
 * host bridge. That is the whole point of the file. A visualization component
 * receives a `DataQuery` on its node, hands it to the ambient provider, and
 * renders what comes back; where the answer came from is the host surface's
 * business and nothing the library may depend on (AAP 0.1.2, 0.6.2).
 *
 * ## What it mirrors
 *
 * The shape below is the client-side face of the service's panel-data contract,
 * `POST /sessions/:id/panel-data` (AAP 0.4.2): the request body is a `DataQuery`
 * and the response is discriminated on `source`. Each host surface implements
 * this interface over whatever channel it owns — the DevTools panel proxies the
 * call through its extension service worker, the editor webview through host
 * messaging — and both return the same {@link DataQueryResponse}. Because the
 * two sides of that contract are described once, in `@debuggen/panel-schema`
 * (the query) and `@debuggen/telemetry` (the results), nothing here restates a
 * data shape: every result type below is an `import type` from the package that
 * owns it.
 *
 * ## What it deliberately does not do
 *
 * No caching, no request de-duplication, no retry policy, no ordering and no
 * paging arithmetic live in this interface. Ordering, filtering and paging are
 * applied by the service, which holds the whole capture; a client that re-sorted
 * a page would silently disagree with the `total` and `nextOffset` it was handed.
 * Single-page resolution, abort handling and the loading/error/empty state
 * machine belong to `./useQuery`, the one caller of this interface inside the
 * library.
 *
 * ## What is exported here
 *
 * The result mapping ({@link DataResultMap}, {@link DataResultFor}), the
 * response shapes ({@link DataQueryResponse}, {@link AnyDataQueryResponse}), the
 * interface and its options ({@link DataProvider}, {@link DataQueryOptions}),
 * one factory for implementing it from a source-agnostic resolver
 * ({@link createDataProvider}, {@link DataQueryResolver}), the React context
 * `PanelHost` provides ({@link DataProviderContext}) and the hook that reads it
 * ({@link useDataProvider}). The paging constants of the contract are re-exported
 * from `@debuggen/panel-schema` so that no consumer restates them.
 */

import { createContext, useContext } from 'react';

import type { DataQuery, DataQuerySource } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type {
  ComponentTreeSnapshot,
  DependencyGraphData,
  MetricValue,
  QueryGroup,
  RenderStat,
  RequestGroup,
  StateTransition,
  TelemetryEvent,
  TraceTree,
} from '@debuggen/telemetry';

/**
 * The paging vocabulary of the panel-data contract, re-exported from the package
 * that owns it so that a consumer of this library never restates the numbers.
 *
 * `limit` defaults to {@link DATA_QUERY_DEFAULT_LIMIT} and may not exceed
 * {@link DATA_QUERY_MAX_LIMIT}; `offset` defaults to
 * {@link DATA_QUERY_DEFAULT_OFFSET}. The defaults are the reader's, not the
 * schema's: a stored query is replayed verbatim, so an omitted `limit` stays
 * omitted and the side that resolves the query applies the default. A footer
 * that wants to say how large a page is, or a provider that wants to clamp an
 * authored `limit` before it reaches the wire, reads it from here.
 *
 * Re-exported rather than merely referenced because one of this library's two
 * consumers cannot reach the owning package at all: the editor surface may
 * depend only on the protocol, this library and the shared base layer, so
 * without this line the three numbers would be restated there — which is the
 * one thing a contract constant exists to prevent. Nothing else borrowed from a
 * dependency is re-exported: the result shapes below stay on their own import
 * path.
 */
export {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';

/**
 * One result shape per query source, and the single place the mapping is
 * written.
 *
 * Module-private on purpose: {@link DataResultMap} is the exported view of it,
 * and it is derived by mapping over `DataQuerySource` rather than declared
 * alongside it. That derivation is a compile-time exhaustiveness proof — a
 * source added to `DATA_QUERY_SOURCES` with no entry here fails to compile,
 * instead of quietly resolving to something wider — and it is why the two
 * declarations are separate types rather than one interface.
 *
 * The shapes themselves are owned by `@debuggen/telemetry`, whose aggregates
 * compute them; this file only says which one answers which source.
 */
interface DataResultShapes {
  /**
   * One correlated interaction as an ordered tree spanning every tier. A capture
   * holds many, so the query names one with a `traceId` filter.
   */
  trace: TraceTree;
  /**
   * The span-shaped records of the capture, flat — the view for ranking work by
   * duration across tiers.
   */
  spans: readonly TelemetryEvent[];
  /** Every captured record, flat and of any kind, for a chronological log. */
  events: readonly TelemetryEvent[];
  /** Per-component render statistics: counts, timing, trigger and changed props. */
  renders: readonly RenderStat[];
  /**
   * The component structure as of the last commit of the capture, annotated with
   * cumulative render counts.
   */
  componentTree: ComponentTreeSnapshot;
  /**
   * Network calls grouped so that byte-identical requests collide and
   * differently parameterized ones do not — the view duplicate detection reads.
   */
  requests: readonly RequestGroup[];
  /**
   * Database statements grouped by their normalised, parameterized text, with
   * per-group counts, timing and callers. Statements only: no row contents are
   * ever captured, so none can be returned.
   */
  queries: readonly QueryGroup[];
  /** Hook state changes: what each moved from and to, and what triggered it. */
  stateTransitions: readonly StateTransition[];
  /** The correlated flow as nodes and edges, for a dependency view. */
  graph: DependencyGraphData;
  /** The computed metric values of the capture, addressed by metric id. */
  metrics: readonly MetricValue[];
}

/**
 * The full source-to-result mapping of the panel-data contract, keyed by every
 * member of `DataQuerySource`.
 *
 * Exported so that a host surface implementing {@link DataProvider} — or a
 * fixture that records a response — can name a single source's result type
 * (`DataResultMap['renders']`) without re-deriving it. Prefer
 * {@link DataResultFor} in generic positions; this is the table it reads.
 *
 * Extending the vocabulary means adding a member to `DATA_QUERY_SOURCES` and an
 * entry to the private shape list above, in that order; the mapping below is
 * what makes the second step mandatory rather than optional.
 */
export type DataResultMap = { [Source in DataQuerySource]: DataResultShapes[Source] };

/**
 * The result type a given query source resolves to.
 *
 * The array-valued sources are `readonly`: the data belongs to the provider (and
 * beyond it, to the service that paged and ordered it), and a component that
 * sorted or spliced it in place would be rendering something other than the page
 * it was handed. Read it, copy it if you must derive from it, never mutate it.
 *
 * @typeParam Source - One member of the closed source vocabulary.
 */
export type DataResultFor<Source extends DataQuerySource> = DataResultMap[Source];

/**
 * What a resolved query answers with: the source it answered for, its data, and
 * the paging counters for the array-valued sources.
 *
 * `source` is the discriminant, and it is load-bearing rather than redundant. A
 * node whose catalog entry permits more than one source — a view that accepts
 * either the correlated tree or a flat span list, say — decides how to read
 * `data` by switching on `source`, never by sniffing the payload's shape: two
 * sources can answer with structurally similar data, and a duck-typed branch
 * would then draw the wrong thing without failing.
 *
 * @typeParam Source - The source this response answers for.
 */
export interface DataQueryResponse<Source extends DataQuerySource = DataQuerySource> {
  /** The source of the request this response answers, echoed back verbatim. */
  readonly source: Source;
  /** The prepared view itself, exactly as the service ordered and paged it. */
  readonly data: DataResultFor<Source>;
  /**
   * How many items the source holds in total after `filter` is applied, before
   * `limit` and `offset`.
   *
   * Present only for the array-valued sources, where it is what lets a view say
   * how much of the source the page it drew actually covers. The scalar sources
   * — the correlated tree, the component-tree snapshot, the dependency graph —
   * are not paged and omit it, as does any provider that cannot know the total.
   */
  readonly total?: number | undefined;
  /**
   * The `offset` that would return the next page, or absent when this page is
   * the last one.
   *
   * Present only for the array-valued sources. A view advances paging by copying
   * this value into the next query's `offset`; it never computes an offset from
   * the length of what it received, which would drift the moment the service
   * clamped a `limit`.
   */
  readonly nextOffset?: number | undefined;
}

/**
 * A response for any source, as a discriminated union.
 *
 * The type for code that handles a response before it knows which source it
 * belongs to: a host surface decoding a message from its transport, or a stored
 * fixture. Narrowing on `source` gives the exact `data` type, which
 * `DataQueryResponse<DataQuerySource>` on its own cannot — there, `source` and
 * `data` widen independently and a `metrics` response would type-check with a
 * trace payload.
 */
export type AnyDataQueryResponse = {
  [Source in DataQuerySource]: DataQueryResponse<Source>;
}[DataQuerySource];

/**
 * Per-call options for {@link DataProvider.query}.
 *
 * Deliberately minimal, and deliberately not a place for transport knobs: no
 * URL, no timeout, no headers, no retry count. Anything of that kind belongs to
 * the implementation behind the interface.
 */
export interface DataQueryOptions {
  /**
   * Cancellation signal for the call.
   *
   * `./useQuery` creates an `AbortController` per request and aborts it when the
   * node unmounts or its query changes, so an implementation that ignores this
   * keeps work alive that nothing will render. Honour it by rejecting with an
   * abort-shaped error (a `DOMException` of name `AbortError`, or the signal's
   * own `reason`) rather than by resolving with empty data.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * The interface every host surface implements to feed the renderer, and the only
 * way data reaches a panel node.
 *
 * One method, promise-returning and transport-agnostic. It is generic over the
 * query's `source` so that the response's `data` is typed precisely at each call
 * site: `query({ source: 'renders', … })` resolves to render statistics, and no
 * caller has to cast or re-check what it received.
 *
 * ## Implementer obligations
 *
 * An implementation is trusted by every component in this library, so it owes
 * each of the following. They are requirements, not suggestions: the library's
 * loading, empty and error states are only honest if they hold.
 *
 * 1. **Echo the source.** Resolve with a response whose `source` equals the
 *    request's `source`. Components switch on it.
 * 2. **Never dress a failure as data.** A failed call must reject. Resolving
 *    with an empty array, a zeroed result or any sentinel turns a failure into a
 *    plausible-looking empty panel, which AAP 0.5.5 forbids — a failure is never
 *    presented as a successful analysis. An empty result is legitimate only when
 *    the capture genuinely holds nothing for the query.
 * 3. **Reject with a typed error where possible.** `DebuggenError` from
 *    `@debuggen/shared` carries the code and hint the error state renders; any
 *    other rejection is wrapped by the caller, losing that detail.
 * 4. **Honour `options.signal`.** Stop the work and reject with an abort-shaped
 *    error; do not resolve an aborted call.
 * 5. **Resolve one page, as given.** Pass `filter`, `sort`, `limit` and `offset`
 *    through to the side that owns the capture and return its answer untouched —
 *    no client-side re-ordering, no merging of pages, no de-duplication — along
 *    with its `total` and `nextOffset` for the array-valued sources.
 * 6. **Preserve redaction.** Attribute values, URLs and statements arrive
 *    already redacted and truncated (AAP 0.5.2). An implementation must never
 *    enrich, expand or reconstruct them.
 * 7. **Stay referentially stable.** The provider object is passed through React
 *    context and is part of the query effect's dependencies, so a new object per
 *    render would refetch every node forever. Create it once per session.
 * 8. **Report every failure through the promise.** `query` must not throw
 *    synchronously — not for a disconnected channel, not for a query it rejects.
 *    The caller runs it inside a React effect, where a synchronous throw escapes
 *    the state machine that owns the error state and surfaces as a render-time
 *    crash instead of a retryable message.
 *
 * ## Implementing it
 *
 * An implementation that answers every source through one channel — which both
 * host surfaces and every test stub do — is easiest to write as a
 * {@link DataQueryResolver} passed to {@link createDataProvider}, and that is
 * the recommended route. The reason is a property of the generic signature
 * rather than a matter of taste: inside a generic `query`, `Source` is an
 * unresolved type parameter, so a value that satisfies one source (an empty
 * list, or whatever a transport decoded) is not statically a
 * `DataResultFor<Source>` — every uniform implementation therefore needs one
 * type assertion, and the factory is where this library keeps it so that no
 * consumer has to write its own.
 */
export interface DataProvider {
  /**
   * Resolve one page of one query.
   *
   * @typeParam Source - The source named by `query.source`, inferred from it.
   * @param query - The declarative request carried by the node being rendered.
   * @param options - Per-call options; `signal` cancels the request.
   * @returns The response for that source, with its paging counters.
   */
  query<Source extends DataQuerySource>(
    query: DataQuery & { source: Source },
    options?: DataQueryOptions,
  ): Promise<DataQueryResponse<Source>>;
}

/**
 * A source-agnostic resolver: one function that answers any query with the
 * response for whichever source it was asked about.
 *
 * This is the shape a host surface naturally has — one channel carrying every
 * query, one decoded response back — and the shape a test stub naturally has.
 * {@link createDataProvider} turns it into a {@link DataProvider}.
 *
 * The same obligations listed on {@link DataProvider} apply to a resolver, with
 * one relaxation: it need not thread the request's source into its return type,
 * because the factory checks at runtime that the two agree. The return type is
 * therefore the uncorrelated `DataQueryResponse<DataQuerySource>`, which accepts
 * both a value built from the request (`{ source: query.source, data: … }`) and
 * a precisely discriminated {@link AnyDataQueryResponse} that a transport
 * decoded.
 *
 * @param query - The query to resolve, exactly as the node carried it.
 * @param options - Per-call options; `signal` cancels the request.
 * @returns The response for the query's own source.
 */
export type DataQueryResolver = (
  query: DataQuery,
  options?: DataQueryOptions,
) => Promise<DataQueryResponse>;

/**
 * Build a {@link DataProvider} from a source-agnostic {@link DataQueryResolver}.
 *
 * Two things are gained by going through here rather than implementing the
 * generic interface by hand. The first is the type assertion the generic
 * signature forces on any uniform implementation: it lives on one line below,
 * guarded, instead of once per host surface and once per test stub. The second
 * is enforcement of the first obligation on {@link DataProvider} — a response
 * must answer for the source it was asked about. A resolver that answers a
 * request for one source with another source's payload is a defect that would
 * otherwise surface far away, inside a component that had already switched on
 * `source` and started reading fields the data does not have; here it becomes a
 * rejection with a code and a hint, which a node renders as its error state.
 *
 * The returned provider is a new object, so create it once per session (or per
 * test) and keep the reference: it is part of the query effect's dependencies.
 * It also satisfies the last obligation on {@link DataProvider} for free: the
 * resolver is invoked inside an `async` method, so even a resolver that throws
 * synchronously — one that reads a channel it has not opened, say — produces a
 * rejected promise rather than an exception in the middle of a render.
 *
 * @param resolve - The resolver to adapt. Called once per query.
 * @returns A provider that delegates every query to `resolve`.
 */
export function createDataProvider(resolve: DataQueryResolver): DataProvider {
  return {
    async query<Source extends DataQuerySource>(
      query: DataQuery & { source: Source },
      options?: DataQueryOptions,
    ): Promise<DataQueryResponse<Source>> {
      const response = await resolve(query, options);

      if (response.source !== query.source) {
        throw new DebuggenError(
          'PROTOCOL_INVALID_MESSAGE',
          `The data provider answered a "${query.source}" query with a "${response.source}" response.`,
          {
            hint: 'Return the response for the source that was requested; a view reads the payload according to it.',
            details: { requested: query.source, received: response.source },
          },
        );
      }

      // The single assertion this module exists to contain. It is sound because
      // of the guard above: `response.source` equals `query.source`, and the
      // union's members pair each source with its own result type, so the
      // member that survived that comparison is the one this signature promises.
      // Nothing is trusted about `data` beyond that pairing, which is precisely
      // what the resolver's return type already established.
      return response as DataQueryResponse<Source>;
    },
  };
}

/**
 * The ambient {@link DataProvider}, provided by `PanelHost` and read by
 * `./useQuery`.
 *
 * The default is `undefined` rather than a stub implementation. A stub would
 * answer queries with invented emptiness, and an empty panel that looks
 * successful is exactly what AAP 0.5.5 rules out; absence is instead reported as
 * an error state by the hook, where a developer can see it.
 *
 * `PanelHost` provides it directly (`<DataProviderContext.Provider value={…}>`),
 * so this module exports no wrapper component: one less indirection between the
 * host surface and the tree, and one less place for a provider value to be
 * rebuilt per render.
 */
export const DataProviderContext = createContext<DataProvider | undefined>(undefined);

DataProviderContext.displayName = 'DebuggenDataProviderContext';

/**
 * Read the ambient {@link DataProvider}, or `undefined` when none is provided.
 *
 * **This hook never throws, and that is a deliberate API decision — please do
 * not "fix" it into a throwing hook.** Components from this library are mounted
 * outside a `PanelHost` on purpose: the editor webview reuses the primitives and
 * the summary chrome without a panel around them, and a source-location chip is
 * useful with no provider in sight. Throwing here would take those surfaces down
 * for a dependency they never needed.
 *
 * A missing provider still matters when something actually wants data, and that
 * case is surfaced where it can be rendered: `./useQuery` reports it as an error
 * status with a typed error, so a node shows its error state instead of an
 * empty-looking success or a blank area.
 *
 * @returns The provider from context, or `undefined` when the tree has none.
 */
export function useDataProvider(): DataProvider | undefined {
  return useContext(DataProviderContext);
}
