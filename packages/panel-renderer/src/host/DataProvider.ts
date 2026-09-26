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
 * ## What it mirrors: the wire form and the view form
 *
 * The shape below is the client-side face of the service's panel-data contract,
 * `POST /sessions/:id/panel-data` (AAP 0.4.2): the route is addressed by a
 * session id, the request body is a `DataQuery` and the response is
 * discriminated on `source`. Each host surface implements this interface over
 * whatever channel it owns — the DevTools panel proxies the call through its
 * extension service worker, the editor webview through host messaging — and
 * both return the same {@link DataQueryResponse}. Because the two sides of that
 * contract are described once, in `@debuggen/panel-schema` (the query) and
 * `@debuggen/telemetry` (the results), nothing here restates a data shape: every
 * result type below is an `import type` from the package that owns it.
 *
 * The contract has two spellings, and this module owns the one translation
 * between them:
 *
 * - **The wire form** ({@link PanelDataResult}) is what the service sends: one
 *   member per source, carrying its payload under a key named after the source
 *   (`{ source: 'trace', trace }`, `{ source: 'spans', spans, total, limit,
 *   offset, nextOffset }`, …), with all four paging fields required on the
 *   array-valued sources. It is structurally identical to the protocol
 *   package's `DataResult` union (`dataResultSchema` in
 *   `packages/protocol/src/http.ts`), so a host can return the value
 *   `parseDataResult` produced without a cast — but it is derived here from the
 *   telemetry result shapes rather than imported, because the renderer sits
 *   below the protocol in the package graph and may never import it.
 * - **The view form** ({@link DataQueryResponse}) is what `./useQuery` and every
 *   component read: the payload always under `data`, whatever the source, so a
 *   component is written once against `data` and switches on `source` alone.
 *
 * {@link createPanelDataProvider} and {@link mapPanelDataResult} convert the
 * first into the second, validating as they go; `./useQuery` validates the
 * second for every provider through {@link checkDataQueryResponse}. The two
 * forms can therefore never be confused silently: a service body handed to a
 * component as if it were a view is refused, never read as `data: undefined`.
 *
 * ## Which session a query belongs to
 *
 * Every call names its session explicitly, as the first argument of
 * {@link DataProvider.query}. The authoritative value is the `sessionId` of the
 * panel specification being drawn: `PanelHost` places it in
 * {@link PanelSessionContext} and `./useQuery` forwards it on every call,
 * unchanged. A provider therefore never has to remember which session it was
 * built for — the same provider object serves a reopened session's panel and
 * the current one side by side, and a panel can never fetch another session's
 * evidence because a closure outlived the panel it was created for.
 *
 * ## Which capture a query reads
 *
 * A session holds several captures and panel versions, and a node's query names
 * neither. The panel being drawn is what knows which one it describes, so its
 * identity travels as {@link DataQueryOptions.panelId}: the surface that renders
 * a specification wraps its provider with {@link bindPanelIdentity} for that
 * specification's own `id`, every call through the wrapper carries it, and a
 * provider forwards it beside the query as the panel-data request's `panelId`.
 * The service then answers from the capture that panel was generated from. A
 * call with no `panelId` is a live read — the session's open capture, else its
 * most recent one — which is what a view with no rendered panel behind it
 * wants. A present `panelId` is never dropped: a panel-bound read that became a
 * live one would draw another capture's evidence under the panel's findings.
 *
 * ## Paging counters, as the wire carries them
 *
 * The service's response marks the last page with `nextOffset: null` and always
 * reports `total`, `limit` and `offset` for the array-valued sources (the
 * protocol's `DataPage` echo, mirrored here as {@link PanelDataPage}).
 * {@link DataQueryResponse} carries the same four counters, optional because a
 * view-form provider that cannot know them may omit them, and accepts the
 * wire's `null` as it stands — `null` and an absent key both mean "no further
 * page" — so the mapping forwards the decoded counters as they arrived instead
 * of translating them. `./useQuery` then reports end-of-data to components one
 * way only, as an `undefined` `nextOffset`.
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
 * The result mapping ({@link DataResultMap}, {@link DataResultFor}), the view
 * form of a response ({@link DataQueryResponse}, {@link AnyDataQueryResponse}),
 * the wire form of one ({@link PanelDataResult}, {@link PanelDataResultFor},
 * {@link PanelDataPage}), the interface and its options ({@link DataProvider},
 * {@link DataQueryOptions}), two factories for implementing it — from a
 * resolver that returns the service's body ({@link createPanelDataProvider},
 * {@link PanelDataResolver}), which is what a host surface over a transport
 * uses, and from one that already speaks the view form
 * ({@link createDataProvider}, {@link DataQueryResolver}), which is what an
 * in-process stub or a recorded fixture uses — with the context both hand a
 * resolver ({@link DataQueryResolverContext}), the wrapper that binds a
 * provider to a rendered panel's identity ({@link bindPanelIdentity}), the two
 * checks those factories and `./useQuery` apply ({@link mapPanelDataResult},
 * {@link checkDataQueryResponse}), the two React contexts `PanelHost` provides
 * ({@link DataProviderContext}, {@link PanelSessionContext}) and the hooks that
 * read them ({@link useDataProvider}, {@link usePanelSessionId}). The paging
 * constants of the contract are re-exported from `@debuggen/panel-schema` so
 * that no consumer restates them.
 */

import { createContext, useContext } from 'react';

import { DATA_QUERY_MAX_LIMIT, isDataQuerySource } from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySource } from '@debuggen/panel-schema';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
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
   *
   * `null` when no trace in the capture matched the query — the service's own
   * answer for a session whose capture collected nothing correlated, and an
   * ordinary result rather than a failure: a view renders its empty state for it,
   * never an error.
   */
  trace: TraceTree | null;
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
   *
   * `null` when the capture holds no render evidence to build a tree from — the
   * wire's spelling of "no tree", since an absent value does not survive a JSON
   * round trip. Like a `null` trace, it is an empty capture and renders as the
   * view's empty state, never as a malformed payload.
   */
  componentTree: ComponentTreeSnapshot | null;
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
   * Present for the array-valued sources, where the service always reports it
   * (as a non-negative whole number, never `null`) and it is what lets a view
   * say how much of the source the page it drew actually covers. The scalar
   * sources — the correlated tree, the component-tree snapshot, the dependency
   * graph — are not paged and omit it, as does any provider that cannot know the
   * total.
   */
  readonly total?: number | undefined;
  /**
   * The page size the service actually applied — the query's own `limit`, or
   * the default it filled in for an omitted one — as a non-negative whole
   * number no larger than `DATA_QUERY_MAX_LIMIT`.
   *
   * An echo, not an instruction: a view that wants to say "showing 200 per
   * page" reads it here rather than assuming the default, which the service may
   * have clamped. Present for the array-valued sources when the answer came off
   * the wire, and absent for the unpaged sources and for any view-form provider
   * that does not report it.
   */
  readonly limit?: number | undefined;
  /**
   * How many items the service skipped before this page — the query's own
   * `offset`, or the default it filled in — as a non-negative whole number.
   *
   * Present and absent under exactly the same conditions as
   * {@link DataQueryResponse.limit}.
   */
  readonly offset?: number | undefined;
  /**
   * The `offset` that would return the next page; `null` or absent when this
   * page is the last one.
   *
   * `null` is the wire's own spelling of "no further page" — the service sends
   * `nextOffset: null` on the last page of every array-valued source, because
   * JSON has no `undefined` and the protocol states the end explicitly rather
   * than by omission — so a host surface forwards the decoded value untouched.
   * Absent is the same answer, for the unpaged sources and for any provider
   * that does not page. `./useQuery` folds both into one `undefined`, so no
   * component has to know two spellings.
   *
   * A view advances paging by copying this value into the next query's
   * `offset`; it never computes an offset from the length of what it received,
   * which would drift the moment the service clamped a `limit`.
   */
  readonly nextOffset?: number | null | undefined;
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
 * Which sources the service pages, and the single runtime statement of it.
 *
 * A total record rather than a list, and checked twice by the compiler: the
 * mapped type makes it exhaustive (a source added to `DATA_QUERY_SOURCES`
 * without an entry here fails to compile), and the conditional in it pins each
 * entry to its result shape — a source is `'paged'` exactly when its result is
 * an array — so a source cannot be marked paged while answering with one tree,
 * or single while answering with a list. The protocol draws the same line: its
 * array-valued `DataResult` members carry the `DataPage` echo and its three
 * single-value members do not.
 */
const DATA_QUERY_PAGING = {
  trace: 'single',
  spans: 'paged',
  events: 'paged',
  renders: 'paged',
  componentTree: 'single',
  requests: 'paged',
  queries: 'paged',
  stateTransitions: 'paged',
  graph: 'single',
  metrics: 'paged',
} as const satisfies {
  readonly [Source in DataQuerySource]: DataResultShapes[Source] extends readonly unknown[]
    ? 'paged'
    : 'single';
};

/** The array-valued sources: the ones whose wire member carries {@link PanelDataPage}. */
type PagedDataQuerySource = {
  [Source in DataQuerySource]: (typeof DATA_QUERY_PAGING)[Source] extends 'paged' ? Source : never;
}[DataQuerySource];

/**
 * The paging echo every array-valued wire member carries, all four fields
 * required.
 *
 * Mirrors the protocol's `DataPage` field for field, and must stay structurally
 * identical to it: `total` is how many items the filtered source holds, `limit`
 * and `offset` are what the service applied (defaults included), and
 * `nextOffset` is the offset of the following page or `null` on the last one.
 * All four are non-negative whole numbers, and `limit` is bounded by
 * `DATA_QUERY_MAX_LIMIT`; {@link mapPanelDataResult} enforces exactly that.
 */
export interface PanelDataPage {
  /** How many items the filtered source holds in total, before limit and offset. */
  readonly total: number;
  /** The page size the service applied. */
  readonly limit: number;
  /** How many items the service skipped before this page. */
  readonly offset: number;
  /** The offset of the following page, or `null` when this page is the last one. */
  readonly nextOffset: number | null;
}

/**
 * The wire form of the answer to one source's query: the service's
 * `POST /sessions/:id/panel-data` body for that source.
 *
 * The payload sits under a key named after the source, and the array-valued
 * sources carry the {@link PanelDataPage} echo beside it:
 *
 * - `PanelDataResultFor<'trace'>` is `{ source: 'trace'; trace: TraceTree | null }`;
 * - `PanelDataResultFor<'renders'>` is
 *   `{ source: 'renders'; renders: readonly RenderStat[] } & PanelDataPage`.
 *
 * Derived from the same result table as the view form, so the two can never
 * disagree about what a source's payload is, and structurally identical to the
 * protocol's `DataResultFor<S>` — which is what lets a host hand
 * `parseDataResult(body).value` to {@link createPanelDataProvider} with no cast.
 * A change to the protocol's `dataResultSchema` member names or page fields must
 * be mirrored here in the same change.
 *
 * @typeParam Source - The source this result answers for.
 */
export type PanelDataResultFor<Source extends DataQuerySource> = {
  readonly source: Source;
} & { readonly [Member in Source]: DataResultShapes[Member] } & (Source extends PagedDataQuerySource
    ? PanelDataPage
    : unknown);

/**
 * The wire form of a panel-data answer for any source, as a discriminated union
 * on `source` — the renderer-side mirror of the protocol's `DataResult`.
 *
 * What a {@link PanelDataResolver} returns and what {@link mapPanelDataResult}
 * translates into the {@link DataQueryResponse} a component reads.
 */
export type PanelDataResult = {
  [Source in DataQuerySource]: PanelDataResultFor<Source>;
}[DataQuerySource];

/**
 * Per-call options for {@link DataProvider.query}.
 *
 * Deliberately minimal, and deliberately not a place for transport knobs: no
 * URL, no timeout, no headers, no retry count. Anything of that kind belongs to
 * the implementation behind the interface. What it does carry is contract: the
 * call's cancellation and the identity of the panel the query belongs to.
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
  /**
   * The id of the panel specification the querying node belongs to — the
   * rendered `PanelSpec`'s own `id`.
   *
   * A session holds several captures and panel versions, and a node's query
   * names neither, so this is what says which evidence the node describes. A
   * provider forwards it, unchanged, beside the query (the panel-data request's
   * `panelId`), and the service answers from the capture that panel was
   * generated from — so a panel still on screen after a newer capture started
   * keeps drawing the evidence its own findings cite. Absent, the call is a
   * **live** read: the session's open capture, else its most recent one.
   *
   * Present means a string with a visible character. A provider must never drop
   * a present value — that would silently turn a panel-bound read into a live
   * one — and the factories below refuse an unusable one with `PANEL_INVALID`
   * before their resolver runs. {@link bindPanelIdentity} is how a surface sets
   * it once for every node of a rendered panel.
   */
  readonly panelId?: string | undefined;
}

/**
 * The interface every host surface implements to feed the renderer, and the only
 * way data reaches a panel node.
 *
 * One method, promise-returning and transport-agnostic. It is generic over the
 * query's `source` so that the response's `data` is typed precisely at each call
 * site: `query(sessionId, { source: 'renders', … })` resolves to render
 * statistics, and no caller has to cast or re-check what it received.
 *
 * The session is the first argument because the service's route is addressed by
 * it (`POST /sessions/:id/panel-data`) and because the panel being drawn is what
 * knows it: `./useQuery` passes the `sessionId` of the specification `PanelHost`
 * is rendering, read from {@link PanelSessionContext}, on every call.
 *
 * ## Implementer obligations
 *
 * An implementation is trusted by every component in this library, so it owes
 * each of the following. They are requirements, not suggestions: the library's
 * loading, empty and error states are only honest if they hold.
 *
 * 0. **Route by the session it was given.** Address the request to exactly the
 *    `sessionId` argument, never to a session remembered from construction or
 *    from an earlier call. The argument is the panel's own claim about which
 *    session it describes, and the service authorises and resolves against it.
 *    Forward `options.panelId` beside the query, unchanged, whenever it is
 *    present: it is the panel's claim about which *capture* it describes, and
 *    dropping it would answer the node from live evidence instead.
 * 1. **Echo the source.** Resolve with a response whose `source` equals the
 *    request's `source`. Components switch on it.
 * 2. **Never dress a failure as data.** A failed call must reject. Resolving
 *    with an empty array, a zeroed result or any sentinel turns a failure into a
 *    plausible-looking empty panel, which AAP 0.5.5 forbids — a failure is never
 *    presented as a successful analysis. An empty result is legitimate only when
 *    the capture genuinely holds nothing for the query.
 * 3. **Reject with a typed error where possible.** `DebuggenError` from
 *    `@debuggen/shared` carries the code and hint the error state renders, and
 *    its details reach the error state's "Technical details" disclosure. Any
 *    other rejection is mapped by the caller as faithfully as it allows — an
 *    HTTP status or a timeout, network or abort error to the code it means —
 *    but loses whatever hint a typed error could have carried. Write the hint
 *    for the reader of the panel and put integration instructions in
 *    `details`, as this module's own refusals do.
 * 4. **Honour `options.signal`.** Stop the work and reject with an abort-shaped
 *    error; do not resolve an aborted call.
 * 5. **Resolve one page, as given, in the view form.** Pass `filter`, `sort`,
 *    `limit` and `offset` through to the side that owns the capture and return
 *    its answer untouched — no client-side re-ordering, no merging of pages, no
 *    de-duplication — with the payload under `data` and the service's `total`,
 *    `limit`, `offset` and `nextOffset` beside it for the array-valued sources,
 *    `null` included where the service sent one. The service itself answers in
 *    the wire form ({@link PanelDataResult}), whose payload sits under a
 *    source-named key; an implementation over a transport converts it with
 *    {@link createPanelDataProvider} (or {@link mapPanelDataResult}) rather
 *    than by hand, because returning the body as it arrived would reach every
 *    component as a response with no `data` — which `./useQuery` refuses as a
 *    malformed response rather than drawing.
 * 6. **Preserve redaction.** Attribute values, URLs and statements arrive
 *    already redacted and truncated (AAP 0.5.2). An implementation must never
 *    enrich, expand or reconstruct them.
 * 7. **Stay referentially stable.** The provider object is passed through React
 *    context and is part of the query effect's dependencies, so a new object per
 *    render would refetch every node forever. Create it once per host surface
 *    and keep it: because the session travels on every call, one provider serves
 *    every session that surface shows.
 * 8. **Report every failure through the promise.** `query` must not throw
 *    synchronously — not for a disconnected channel, not for a query it rejects.
 *    The caller runs it inside a React effect, where a synchronous throw escapes
 *    the state machine that owns the error state and surfaces as a render-time
 *    crash instead of a retryable message.
 *
 * ## Implementing it
 *
 * An implementation that answers every source through one channel — which both
 * host surfaces and every test stub do — is easiest to write through one of the
 * two factories, and that is the recommended route: a host surface whose
 * channel returns the service's body passes a {@link PanelDataResolver} to
 * {@link createPanelDataProvider}, and an in-process stub or fixture that
 * already builds the view form passes a {@link DataQueryResolver} to
 * {@link createDataProvider}. The reason is a property of the generic signature
 * rather than a matter of taste: inside a generic `query`, `Source` is an
 * unresolved type parameter, so a value that satisfies one source (an empty
 * list, or whatever a transport decoded) is not statically a
 * `DataResultFor<Source>` — every uniform implementation therefore needs one
 * type assertion, and the factory is where this library keeps it so that no
 * consumer has to write its own.
 */
export interface DataProvider {
  /**
   * Resolve one page of one query for one session.
   *
   * @typeParam Source - The source named by `query.source`, inferred from it.
   * @param sessionId - The session the query is addressed to: the `sessionId`
   * of the panel specification being rendered, passed exactly as it carries it.
   * @param query - The declarative request carried by the node being rendered.
   * @param options - Per-call options; `signal` cancels the request and
   * `panelId` names the panel whose capture answers it.
   * @returns The response for that source, with its paging counters.
   */
  query<Source extends DataQuerySource>(
    sessionId: string,
    query: DataQuery & { source: Source },
    options?: DataQueryOptions,
  ): Promise<DataQueryResponse<Source>>;
}

/**
 * What {@link createDataProvider} hands a {@link DataQueryResolver} beside the
 * query: the session the call is addressed to, and the per-call options.
 *
 * One object rather than further positional arguments, so the resolver's first
 * parameter stays the query it answers — the one thing a stub that serves a
 * single fixed capture reads — while the session a real transport routes by is
 * always present on the second. `sessionId` is required: the factory rejects a
 * call that names no session before the resolver ever runs, so a resolver can
 * address its request without re-checking it.
 *
 * `panelId` is inherited from {@link DataQueryOptions} and follows the same
 * rule: present only when the caller named a panel — the key is omitted, not
 * set to `undefined`, for a live read — and already checked to be usable, so a
 * resolver forwards it as it stands.
 */
export interface DataQueryResolverContext extends DataQueryOptions {
  /**
   * The session the query is addressed to, exactly as the caller passed it to
   * {@link DataProvider.query}. Never blank.
   */
  readonly sessionId: string;
}

/**
 * A source-agnostic resolver that answers in the view form: one function that
 * answers any query with the `{ source, data, … }` response for whichever
 * source it was asked about.
 *
 * This is the shape an in-process answer naturally has — a test stub, a
 * recorded fixture, a surface that computes a view without a round trip.
 * {@link createDataProvider} turns it into a {@link DataProvider}, moving the
 * provider's positional `sessionId` onto {@link DataQueryResolverContext}. A
 * channel that returns the service's own body answers in the wire form instead,
 * and belongs behind {@link PanelDataResolver} and
 * {@link createPanelDataProvider}, which translate it.
 *
 * The same obligations listed on {@link DataProvider} apply to a resolver —
 * route by `context.sessionId`, honour `context.signal` — with one relaxation:
 * it need not thread the request's source into its return type, because the
 * factory checks at runtime that the two agree (with
 * {@link checkDataQueryResponse}, payload and counters included). The return type is therefore
 * the uncorrelated `DataQueryResponse<DataQuerySource>`, which accepts both a
 * value built from the request (`{ source: query.source, data: … }`) and a
 * precisely discriminated {@link AnyDataQueryResponse} that a transport decoded.
 *
 * @example A stub answering every query from a view already held in memory.
 * ```ts
 * const provider = createDataProvider((query, { sessionId }) =>
 *   recordedViews.answer(sessionId, query),
 * );
 * ```
 *
 * @param query - The query to resolve, exactly as the node carried it.
 * @param context - The session to address and the per-call options.
 * @returns The response for the query's own source.
 */
export type DataQueryResolver = (
  query: DataQuery,
  context: DataQueryResolverContext,
) => Promise<DataQueryResponse>;

/**
 * Whether a value can address a session: a string with a visible character.
 *
 * The one runtime check on the session argument: {@link createDataProvider} and
 * {@link createPanelDataProvider} apply it before their resolver runs, and
 * `./useQuery` applies it before it calls a provider at all, reporting a
 * failure as the node's error state. A blank id would address
 * `/sessions//panel-data`, which no service answers meaningfully, so it is
 * refused before any transport runs.
 *
 * @param sessionId - The candidate session id.
 * @returns `true` when the id is usable as a route segment's value.
 */
export function isAddressableSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && sessionId.trim() !== '';
}

/*
 * ---------------------------------------------------------------------------
 * Response checking
 *
 * One set of shallow, per-source payload guards, shared by the wire-to-view
 * mapping ({@link mapPanelDataResult}) and by the view check `./useQuery` runs
 * for every provider ({@link checkDataQueryResponse}), so the two paths cannot
 * disagree about what a well-formed payload is.
 *
 * Shallow on purpose, and mirroring the protocol's own guards for the same
 * members: a container of the right kind, a page no longer than the largest a
 * query may ask for, and — for each element or tree — the identifying fields
 * the views index by. That is the failure a transport boundary actually
 * produces (a missing field, a payload under the wrong key, a JSON round trip
 * that dropped a value); a deep re-validation of shapes computed by the
 * package that defines them would be a second definition of those shapes.
 *
 * Every diagnostic names sources, field paths and value *kinds* only. A payload
 * holds redacted URLs, parameterized statements and prop-name summaries, and
 * none of it may reach an error message or its details (AAP 0.5.2).
 * ---------------------------------------------------------------------------
 */

/**
 * The keys of `Shape` that every value of it carries: its required members.
 *
 * What lets each guard below name the fields it checks for *as* members of the
 * element type it guards. A key that is optional on the shape — one a
 * well-formed value may legitimately omit — is not a member of this union, so
 * a guard that demanded it would fail to compile instead of refusing valid
 * data; a key renamed upstream fails to compile here too.
 *
 * @typeParam Shape - The result or element type a guard is written for.
 */
type RequiredKeyOf<Shape> = {
  [Key in keyof Shape]-?: Shape extends Readonly<Record<Key, unknown>> ? Key : never;
}[keyof Shape] &
  string;

/**
 * The required keys of `Shape` whose value is a list — the collections a tree
 * or graph guard checks are arrays.
 *
 * @typeParam Shape - The tree or graph type a guard is written for.
 */
type RequiredListKeyOf<Shape> = {
  [Key in keyof Shape]-?: Shape extends Readonly<Record<Key, readonly unknown[]>> ? Key : never;
}[keyof Shape] &
  string;

/**
 * What one check found wrong, described without the value that was wrong.
 *
 * Phrased so that "`path` should be `expected`, but is `received`" reads as a
 * sentence, which is how {@link malformedResponseError} renders it.
 */
interface ResponseDefect {
  /**
   * Where, relative to the object that was checked: `spans`, `spans[3]`,
   * `spans[3].spanId`, `trace.roots`, `limit`.
   */
  readonly path: string;
  /** What that position should hold, in words: `"an array"`, `"present"`. */
  readonly expected: string;
  /**
   * What it held, as a kind — `"missing"`, `"null"`, `"a string"`,
   * `"a negative number"` — never the value itself.
   */
  readonly received: string;
}

/**
 * A shallow check of one source's payload.
 *
 * @param payload - The payload, read from the response as `unknown`.
 * @param path - The payload's own path, prefixed to every defect's path.
 * @returns The first defect found, or `undefined` for a well-formed payload.
 */
type PayloadGuard = (payload: unknown, path: string) => ResponseDefect | undefined;

/** A plain, non-array object read field by field; every field stays `unknown`. */
type UnknownRecord = Readonly<Record<string, unknown>>;

/**
 * Whether a value is a plain, non-array object, narrowing it to a record whose
 * every field is `unknown` — the same test as the protocol's `isPlainRecord`.
 *
 * @param value - Any value.
 * @returns `true` for a non-null, non-array object.
 */
function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is an array, narrowing it to a readonly list of `unknown`
 * rather than to the `any[]` that `Array.isArray` alone would leave.
 *
 * @param value - Any value.
 * @returns `true` for an array.
 */
function isUnknownList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Whether a value is a non-negative whole number in the safe-integer range — the
 * protocol's `z.int().min(0)` for every paging counter.
 *
 * @param value - Any value.
 * @returns `true` for `0`, `1`, `2`, … up to `Number.MAX_SAFE_INTEGER`.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The kind of a value, in words, for a diagnostic that must not quote it.
 *
 * Numbers are described by the property that disqualified them rather than by
 * their digits, which says why a counter was refused without echoing it.
 *
 * @param value - The value that was found where something else was expected.
 * @returns A short noun phrase: `"null"`, `"an array"`, `"a fractional number"`.
 */
function describeKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (isUnknownList(value)) {
    return 'an array';
  }

  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) {
        return 'a non-finite number';
      }
      if (!Number.isInteger(value)) {
        return 'a fractional number';
      }
      if (value < 0) {
        return 'a negative number';
      }
      return Number.isSafeInteger(value) ? 'a number' : 'an integer beyond the safe range';
    case 'string':
      return 'a string';
    case 'boolean':
      return 'a boolean';
    case 'bigint':
      return 'a bigint';
    case 'symbol':
      return 'a symbol';
    case 'function':
      return 'a function';
    case 'undefined':
      return 'undefined';
    default:
      return 'an object';
  }
}

/**
 * The kind of a record's field, distinguishing an absent key from one that is
 * present and holds something unusable.
 *
 * @param record - The object the field was read from.
 * @param key - The field's name.
 * @returns `"missing"` for a key the record does not own, else its kind.
 */
function describeField(record: UnknownRecord, key: string): string {
  return Object.hasOwn(record, key) ? describeKind(record[key]) : 'missing';
}

/**
 * A guard for an array-valued payload: a list of at most one page of plain
 * objects, each owning every named identifying key.
 *
 * @typeParam List - The source's result type, e.g. `DataResultFor<'renders'>`;
 * its element type is what the keys are checked against.
 * @param keys - Required members of the element type every element must own.
 * @returns The guard.
 */
function listGuard<List extends readonly object[]>(
  keys: readonly RequiredKeyOf<List[number]>[],
): PayloadGuard {
  return (payload, path) => {
    if (!isUnknownList(payload)) {
      return { path, expected: 'an array', received: describeKind(payload) };
    }

    // The page ceiling a query's own `limit` carries: a longer list is not a
    // page any request could have asked for, and bounding it keeps one
    // malformed answer from becoming unbounded work on the render path.
    if (payload.length > DATA_QUERY_MAX_LIMIT) {
      return {
        path,
        expected: `an array of at most ${String(DATA_QUERY_MAX_LIMIT)} items`,
        received: `an array of ${String(payload.length)} items`,
      };
    }

    for (let index = 0; index < payload.length; index += 1) {
      const element = payload[index];
      const at = `${path}[${String(index)}]`;

      if (!isUnknownRecord(element)) {
        return { path: at, expected: 'an object', received: describeKind(element) };
      }

      const absent = keys.find((key) => !Object.hasOwn(element, key));
      if (absent !== undefined) {
        return { path: `${at}.${absent}`, expected: 'present', received: 'missing' };
      }
    }

    return undefined;
  };
}

/**
 * What {@link recordGuard} checks on a single-value payload.
 *
 * @typeParam Shape - The source's result type, `null` included where the wire
 * permits it.
 */
interface RecordGuardSpec<Shape> {
  /**
   * Whether `null` is an ordinary answer. Typed by the result shape itself, so
   * a nullable source cannot be declared non-nullable here or the reverse.
   */
  readonly nullable: null extends Shape ? true : false;
  /** Required members the object must own. */
  readonly keys: readonly RequiredKeyOf<NonNullable<Shape>>[];
  /** Required list members the object must own as arrays. */
  readonly lists: readonly RequiredListKeyOf<NonNullable<Shape>>[];
}

/**
 * A guard for a single-value payload — a tree or a graph: a plain object owning
 * its identifying keys and its top-level collections as arrays, or `null`
 * where the source permits "nothing matched".
 *
 * @typeParam Shape - The source's result type, e.g. `DataResultFor<'trace'>`.
 * @param spec - See {@link RecordGuardSpec}.
 * @returns The guard.
 */
function recordGuard<Shape>(spec: RecordGuardSpec<Shape>): PayloadGuard {
  const expected = spec.nullable ? 'an object or null' : 'an object';

  return (payload, path) => {
    if (payload === null && spec.nullable) {
      return undefined;
    }

    if (!isUnknownRecord(payload)) {
      return { path, expected, received: describeKind(payload) };
    }

    const absent = spec.keys.find((key) => !Object.hasOwn(payload, key));
    if (absent !== undefined) {
      return { path: `${path}.${absent}`, expected: 'present', received: 'missing' };
    }

    const notAList = spec.lists.find((key) => !isUnknownList(payload[key]));
    if (notAList !== undefined) {
      return {
        path: `${path}.${notAList}`,
        expected: 'an array',
        received: describeField(payload, notAList),
      };
    }

    return undefined;
  };
}

/**
 * The payload guard of every source, keyed exhaustively by the source
 * vocabulary.
 *
 * The identifying keys are the ones the protocol's `dataResultSchema` checks for
 * the same member — the event identity and its correlation coordinates for the
 * two event lists, each aggregate's id and headline fields, the tree and graph
 * collections — so an answer the service's own schema accepts is accepted here,
 * and every key is proved by the compiler to be a required member of the type
 * the source resolves to. `trace` and `componentTree` accept `null`, the
 * wire's "nothing matched" (a view renders its empty state for it); `graph`
 * does not, because an empty graph is `{ nodes: [], edges: [] }`.
 *
 * The two tree-shaped sources also require the members their views read
 * before drawing — a trace's `nodeCount`; a snapshot's `origin`, `degraded`
 * and `nodeCount` — so a payload missing one is refused here, on the one path
 * every failure takes through `./useQuery` (its announcement, its wording, its
 * retry), rather than being caught later by a view's own shape check.
 */
const DATA_PAYLOAD_GUARDS: { readonly [Source in DataQuerySource]: PayloadGuard } = {
  trace: recordGuard<DataResultFor<'trace'>>({
    nullable: true,
    keys: ['traceId', 'nodeCount'],
    lists: ['roots'],
  }),
  spans: listGuard<DataResultFor<'spans'>>(['id', 'traceId', 'spanId', 'kind', 'tier']),
  events: listGuard<DataResultFor<'events'>>(['id', 'traceId', 'spanId', 'kind', 'tier']),
  renders: listGuard<DataResultFor<'renders'>>(['id', 'component', 'renderCount']),
  componentTree: recordGuard<DataResultFor<'componentTree'>>({
    nullable: true,
    keys: ['capturedAt', 'origin', 'degraded', 'nodeCount'],
    lists: ['roots'],
  }),
  requests: listGuard<DataResultFor<'requests'>>(['id', 'method', 'url', 'count']),
  queries: listGuard<DataResultFor<'queries'>>(['id', 'normalizedStatement', 'executionCount']),
  stateTransitions: listGuard<DataResultFor<'stateTransitions'>>(['id', 'eventId']),
  graph: recordGuard<DataResultFor<'graph'>>({
    nullable: false,
    keys: [],
    lists: ['nodes', 'edges'],
  }),
  metrics: listGuard<DataResultFor<'metrics'>>(['id', 'available']),
};

/** Whether a response's paging counters must all be present (the wire) or may be absent (the view). */
type CounterPresence = 'required' | 'optional';

/** The three whole-number counters of the paging echo. */
type PageCounter = 'total' | 'limit' | 'offset';

/** The paging counters as read off a checked response; any may be absent in the view form. */
interface PageEcho {
  readonly total: number | undefined;
  readonly limit: number | undefined;
  readonly offset: number | undefined;
  readonly nextOffset: number | null | undefined;
}

/**
 * Read one whole-number paging counter off a response.
 *
 * @param record - The response.
 * @param counter - Which counter.
 * @param presence - Whether an absent counter is a defect.
 * @returns The counter (or `undefined` where absence is allowed), or the defect.
 */
function readCounter(
  record: UnknownRecord,
  counter: PageCounter,
  presence: CounterPresence,
): Result<number | undefined, ResponseDefect> {
  const value = record[counter];
  const expected =
    counter === 'limit'
      ? `a non-negative integer no larger than ${String(DATA_QUERY_MAX_LIMIT)}`
      : 'a non-negative integer';

  if (value === undefined) {
    return presence === 'optional'
      ? ok(undefined)
      : err({ path: counter, expected, received: describeField(record, counter) });
  }

  if (!isNonNegativeInteger(value)) {
    return err({ path: counter, expected, received: describeKind(value) });
  }

  if (counter === 'limit' && value > DATA_QUERY_MAX_LIMIT) {
    return err({ path: counter, expected, received: 'a larger number' });
  }

  return ok(value);
}

/**
 * Read the next-page offset off a response: a non-negative whole number, or
 * the wire's `null` for "this is the last page".
 *
 * @param record - The response.
 * @param presence - Whether an absent key is a defect. The wire always states
 * it, `null` included, so absence there is a producer that dropped it.
 * @returns The offset, `null`, or `undefined` where absence is allowed; or the defect.
 */
function readNextOffset(
  record: UnknownRecord,
  presence: CounterPresence,
): Result<number | null | undefined, ResponseDefect> {
  const value = record['nextOffset'];
  const expected = 'a non-negative integer or null';

  if (value === undefined) {
    return presence === 'optional'
      ? ok(undefined)
      : err({ path: 'nextOffset', expected, received: describeField(record, 'nextOffset') });
  }

  if (value !== null && !isNonNegativeInteger(value)) {
    return err({ path: 'nextOffset', expected, received: describeKind(value) });
  }

  return ok(value);
}

/**
 * Read and check all four paging counters of a response.
 *
 * @param record - The response.
 * @param presence - `'required'` for a paged wire member, `'optional'` for the view form.
 * @returns The counters, or the first defect among them.
 */
function readPageEcho(
  record: UnknownRecord,
  presence: CounterPresence,
): Result<PageEcho, ResponseDefect> {
  const total = readCounter(record, 'total', presence);
  if (!total.ok) {
    return total;
  }

  const limit = readCounter(record, 'limit', presence);
  if (!limit.ok) {
    return limit;
  }

  const offset = readCounter(record, 'offset', presence);
  if (!offset.ok) {
    return offset;
  }

  const nextOffset = readNextOffset(record, presence);
  if (!nextOffset.ok) {
    return nextOffset;
  }

  return ok({
    total: total.value,
    limit: limit.value,
    offset: offset.value,
    nextOffset: nextOffset.value,
  });
}

/**
 * The response form a check was applied to, which decides the remedy a refusal
 * carries: each names the factory that produces the form the check expected.
 */
type ResponseForm = 'wire' | 'view';

/*
 * Two audiences, two fields (B1-F16).
 *
 * A refusal is read by two different people. The reader of the panel sees the
 * error state's message and hint first, and can do exactly two things about a
 * refused response: ask again, or report it. The developer who wrote the host
 * or the provider needs the integration instruction — which form to return,
 * which factory maps it — and finds it in the error's details, which the error
 * state shows behind a closed "Technical details" disclosure. So the hint is
 * written for the first audience and `details.remedy` for the second, and no
 * integration vocabulary (a factory name, a context name, "provider") reaches
 * the hint line or the message. Every remedy below is a constant: none of them
 * interpolates anything, so none can quote a refused value.
 */

/**
 * The hint every refused response carries: what a panel reader can do about it.
 *
 * Exported for the views whose own shape check refuses a payload this module's
 * structural check let through (a correlated trace or a component-tree
 * snapshot whose deeper members are unusable), so that refusal carries the
 * same words as every other one rather than a copy of them.
 */
export const REFUSED_RESPONSE_HINT =
  'Retry to request the data again. If it keeps failing, report it with the technical details shown here.';

/**
 * The reader-facing sentence of a payload that arrived in a form its view
 * cannot read.
 *
 * One sentence for every such refusal — this module's structural check and a
 * view's deeper shape check alike — naming only the source that was asked
 * for. What exactly was wrong is developer detail, carried in the refusal's
 * `details` and shown behind the error state's closed disclosure.
 *
 * @param source - The source that was requested.
 * @returns The message.
 */
export function unreadableDataMessage(source: DataQuerySource): string {
  return `The "${source}" data for this view arrived in a form it cannot read.`;
}

/** The hint of a query refused before it was sent: nothing a retry can change. */
const UNADDRESSED_QUERY_HINT =
  'Reload the panel. If it keeps failing, report it with the technical details shown here.';

/** The integration remedy of a malformed response, per the form it was checked as. */
const RESPONSE_FORM_REMEDIES: { readonly [Form in ResponseForm]: string } = {
  wire: "Return the service's panel-data body for the requested source unchanged: its payload under the source-named key and, for a paged source, all four of total, limit, offset and nextOffset.",
  view: 'Return the view form for the requested source: its payload under data, with any paging counters as non-negative integers. A service body belongs behind createPanelDataProvider, which maps it.',
};

/** The integration remedy of a response answering for another known source. */
const MISROUTED_RESPONSE_REMEDY =
  'Return the response for the source that was requested; a view reads the payload according to it.';

/** The integration remedy of a response naming no known source. */
const UNNAMED_SOURCE_REMEDY =
  'Echo the requested source on the response; a view reads the payload according to it.';

/** The integration remedy of a query addressed to no session. */
const UNADDRESSED_QUERY_REMEDY =
  'Pass the sessionId of the panel being rendered; PanelHost provides it through PanelSessionContext.';

/** The integration remedy of a query naming a panel identity that cannot name a panel. */
const UNUSABLE_PANEL_ID_REMEDY =
  "Pass the id of the panel specification being rendered (the spec's own id) as panelId, or omit panelId for a live read; bindPanelIdentity binds it for every node of a panel.";

/**
 * The error a response that fails a structural check is refused with.
 *
 * `PROTOCOL_INVALID_MESSAGE`, like the protocol's own parse failures: the
 * response broke the panel-data contract. The message states the defect in
 * reader terms; the hint says what the reader can do; the details repeat the
 * defect in machine-readable form — the source, a field path and two kind
 * phrases, nothing read out of the payload — beside the integration `remedy`
 * for the developer.
 *
 * @param source - The source that was requested.
 * @param defect - What was wrong, and where.
 * @param form - The form the response was checked as.
 * @returns A fresh error.
 */
function malformedResponseError(
  source: DataQuerySource,
  defect: ResponseDefect,
  form: ResponseForm,
): DebuggenError {
  // The message names the source and nothing structural: the field path and
  // the two kind phrases are developer detail, and they travel in `details`,
  // which the error state keeps behind its closed "Technical details"
  // disclosure (B1-F16). A view whose own, deeper shape check refuses a
  // payload words it with this same sentence, so a reader meets one fault in
  // one form whichever check caught it.
  return new DebuggenError('PROTOCOL_INVALID_MESSAGE', unreadableDataMessage(source), {
    hint: REFUSED_RESPONSE_HINT,
    details: {
      source,
      form,
      field: defect.path,
      expected: defect.expected,
      received: defect.received,
      remedy: RESPONSE_FORM_REMEDIES[form],
    },
  });
}

/**
 * The error a response answering for another source is refused with.
 *
 * The received source is named only when it is a member of the source
 * vocabulary. Anything else in that position is not a source at all, may be
 * any value a producer put there, and is reported by its kind instead. Both
 * branches carry the reader hint and put the integration remedy in the
 * details, as {@link malformedResponseError} does.
 *
 * @param requested - The source that was requested.
 * @param received - The value the response carried as its `source`.
 * @param form - The form the response was checked as.
 * @returns A fresh error.
 */
function sourceMismatchError(
  requested: DataQuerySource,
  received: unknown,
  form: ResponseForm,
): DebuggenError {
  if (isDataQuerySource(received)) {
    return new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      `The "${requested}" data for this view was answered with "${received}" data.`,
      {
        hint: REFUSED_RESPONSE_HINT,
        details: { requested, received, form, remedy: MISROUTED_RESPONSE_REMEDY },
      },
    );
  }

  const receivedKind = received === undefined ? 'missing' : describeKind(received);

  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    `The "${requested}" data for this view was answered with data naming no known source (its source is ${receivedKind}).`,
    {
      hint: REFUSED_RESPONSE_HINT,
      details: { requested, receivedKind, form, remedy: UNNAMED_SOURCE_REMEDY },
    },
  );
}

/**
 * Check a response's envelope — a plain object whose `source` is the one that
 * was requested — before anything inside it is read.
 *
 * @param requested - The source that was requested.
 * @param response - The response, as `unknown`.
 * @param form - The form the response is being checked as.
 * @returns The response as a record, or the error it is refused with.
 */
function checkEnvelope(
  requested: DataQuerySource,
  response: unknown,
  form: ResponseForm,
): Result<UnknownRecord, DebuggenError> {
  if (!isUnknownRecord(response)) {
    return err(
      malformedResponseError(
        requested,
        { path: 'the response', expected: 'an object', received: describeKind(response) },
        form,
      ),
    );
  }

  if (response['source'] !== requested) {
    return err(sourceMismatchError(requested, response['source'], form));
  }

  return ok(response);
}

/**
 * Check the payload a response carries under `member` against the requested
 * source's guard.
 *
 * @param requested - The source that was requested, which selects the guard.
 * @param record - The response whose envelope has already been checked.
 * @param member - Where the payload sits: the source's own name on the wire,
 * `data` in the view form.
 * @returns The first defect found, or `undefined`.
 */
function payloadDefect(
  requested: DataQuerySource,
  record: UnknownRecord,
  member: string,
): ResponseDefect | undefined {
  if (!Object.hasOwn(record, member)) {
    return { path: member, expected: 'present', received: 'missing' };
  }

  return DATA_PAYLOAD_GUARDS[requested](record[member], member);
}

/**
 * The error both factories refuse a call naming no usable session with, before
 * their resolver runs.
 *
 * A retry asks with the same missing session, so the reader hint points at a
 * reload instead; the integration remedy — which argument to pass, and where
 * `PanelHost` provides it — is in the details.
 *
 * @param source - The source of the query that could not be addressed. The
 * unusable session value itself is not echoed.
 * @returns A fresh error.
 */
function unaddressedQueryError(source: DataQuerySource): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    `The "${source}" data for this view was requested without a session to address it to.`,
    {
      hint: UNADDRESSED_QUERY_HINT,
      details: { source, remedy: UNADDRESSED_QUERY_REMEDY },
    },
  );
}

/**
 * Whether a value can name a panel: a string with a visible character — the
 * same test {@link isAddressableSessionId} applies to a session.
 *
 * @param panelId - The candidate panel id.
 * @returns `true` when the id can be forwarded as the request's `panelId`.
 */
function isUsablePanelId(panelId: unknown): panelId is string {
  return typeof panelId === 'string' && panelId.trim() !== '';
}

/**
 * The error a query naming an unusable panel identity is refused with, before
 * anything is sent.
 *
 * `PANEL_INVALID`: the panel the node belongs to has no identity a request can
 * carry, so no capture can be chosen for it — and falling back to a live read
 * would draw other evidence under that panel's findings. Like
 * {@link unaddressedQueryError}, a retry would ask with the same identity, so
 * the reader hint points at a reload and the integration remedy is in the
 * details. The value itself is never echoed, only its kind.
 *
 * @param source - The source of the query that was refused.
 * @param panelId - The unusable value, described by kind only.
 * @returns A fresh error.
 */
function unusablePanelIdError(source: DataQuerySource, panelId: unknown): DebuggenError {
  return new DebuggenError(
    'PANEL_INVALID',
    `The "${source}" data for this view was requested for a panel with no usable id.`,
    {
      hint: UNADDRESSED_QUERY_HINT,
      details: {
        source,
        panelId: typeof panelId === 'string' ? 'a blank string' : describeKind(panelId),
        remedy: UNUSABLE_PANEL_ID_REMEDY,
      },
    },
  );
}

/**
 * The context both factories hand their resolver: the checked session, the
 * caller's signal and — only when the caller named one — the checked panel id.
 *
 * Throws the refusal rather than returning it; both callers are `async`
 * methods, so the throw is the rejection obligation 8 on {@link DataProvider}
 * asks for. `panelId` is spread in conditionally so a live read carries no
 * `panelId` key at all, which is what a resolver that serialises its context
 * must see.
 *
 * @param sessionId - The session the call names.
 * @param source - The query's source, for the refusal wording.
 * @param options - The caller's per-call options.
 * @returns The resolver context.
 * @throws {DebuggenError} `PROTOCOL_INVALID_MESSAGE` for an unusable session,
 * `PANEL_INVALID` for a present but unusable panel id.
 */
function resolverContext(
  sessionId: string,
  source: DataQuerySource,
  options: DataQueryOptions | undefined,
): DataQueryResolverContext {
  if (!isAddressableSessionId(sessionId)) {
    throw unaddressedQueryError(source);
  }

  const panelId = options?.panelId;
  if (panelId !== undefined && !isUsablePanelId(panelId)) {
    throw unusablePanelIdError(source, panelId);
  }

  return {
    sessionId,
    signal: options?.signal,
    ...(panelId === undefined ? {} : { panelId }),
  };
}

/**
 * Build a {@link DataProvider} from a source-agnostic {@link DataQueryResolver}.
 *
 * Three things are gained by going through here rather than implementing the
 * generic interface by hand. The first is the type assertion the generic
 * signature forces on any uniform implementation: it lives on one line below,
 * guarded, instead of once per host surface and once per test stub. The second
 * is enforcement of the first obligation on {@link DataProvider} — a response
 * must answer for the source it was asked about — through
 * {@link checkDataQueryResponse}, which also checks the payload container and
 * the paging counters. A resolver that answers a request for one source with
 * another source's payload is a defect that would otherwise surface far away,
 * inside a component that had already switched on `source` and started
 * reading fields the data does not have; here it becomes a rejection with a
 * code and a hint, which a node renders as its error state. (`./useQuery`
 * applies the same check to every provider, so a hand-written one is held to
 * it too; running it here as well keeps the factory's own promise true for a
 * caller that reads a provider without the hook.)
 *
 * A third is the session hand-over: the provider's positional `sessionId` is
 * checked with {@link isAddressableSessionId} and passed to the resolver on
 * {@link DataQueryResolverContext}, unchanged. A call naming no usable session
 * is rejected with a code and a hint before the resolver runs, so no transport
 * ever sends a request addressed to nobody. The panel identity travels the same
 * way: a present `options.panelId` is checked and forwarded on the context as it
 * stands, an unusable one is rejected with `PANEL_INVALID` before the resolver
 * runs, and a live read's context carries no `panelId` key.
 *
 * The returned provider is a new object, so create it once per host surface (or
 * per test) and keep the reference: it is part of the query effect's
 * dependencies. It also satisfies the last obligation on {@link DataProvider}
 * for free: the resolver is invoked inside an `async` method, so even a
 * resolver that throws synchronously — one that reads a channel it has not
 * opened, say — produces a rejected promise rather than an exception in the
 * middle of a render.
 *
 * @param resolve - The resolver to adapt. Called once per query.
 * @returns A provider that delegates every query to `resolve`.
 */
export function createDataProvider(resolve: DataQueryResolver): DataProvider {
  return {
    async query<Source extends DataQuerySource>(
      sessionId: string,
      query: DataQuery & { source: Source },
      options?: DataQueryOptions,
    ): Promise<DataQueryResponse<Source>> {
      const response = await resolve(query, resolverContext(sessionId, query.source, options));

      const problem = checkDataQueryResponse(query, response);
      if (problem !== undefined) {
        throw problem;
      }

      // The assertion this factory exists to contain. It is sound because of
      // the check above: `response.source` equals `query.source`, and `data`
      // passed that source's payload guard, so the member of the union that
      // survived is the one this signature promises. What the compiler cannot
      // see is only the correlation between a generic `Source` and the
      // resolver's uncorrelated return type.
      return response as DataQueryResponse<Source>;
    },
  };
}

/**
 * Translate the service's answer to one query — the wire form — into the view
 * form every component reads, validating it on the way.
 *
 * The host-boundary half of the panel-data contract, for all ten sources: the
 * payload the service sent under the source-named key (`result.trace`,
 * `result.spans`, …) becomes `data`, and for the array-valued sources the four
 * paging counters are carried across as they arrived — `nextOffset: null`
 * included, which `./useQuery` folds into its one end-of-data value.
 *
 * The result is accepted only when it is a plain object answering for the
 * requested source, its source-named payload passes that source's shallow
 * guard (the same guards {@link checkDataQueryResponse} applies to the view
 * form), and, for a paged source, `total`, `limit` and `offset` are
 * non-negative integers with `limit` no larger than `DATA_QUERY_MAX_LIMIT` and
 * `nextOffset` is a non-negative integer or `null` — all four present, as the
 * service always sends them. Anything else is returned as a
 * `PROTOCOL_INVALID_MESSAGE` error whose message and details name the source,
 * the field and the kind of value found, never the value. That includes a
 * response already in the view form (`{ source: 'spans', data: […] }`): it
 * carries no `spans` member, and accepting it would confuse the two forms in
 * the direction opposite to the one this mapping exists to rule out.
 *
 * Total, like the protocol's parse helpers: a refusal is a returned value, so a
 * caller outside a promise chain need not catch. {@link createPanelDataProvider}
 * is the usual caller; call this directly only where a response arrives outside
 * a {@link DataProvider} call — a recorded body replayed into a fixture, say.
 *
 * @example
 * ```ts
 * const mapped = mapPanelDataResult({ source: 'renders' }, JSON.parse(body));
 * if (mapped.ok) {
 *   mapped.value.data; // readonly RenderStat[]
 * }
 * ```
 *
 * @typeParam Source - The requested source, inferred from `query.source`.
 * @param query - The query the result answers; only its `source` is read.
 * @param result - The service's answer, as `unknown`: a parsed JSON body, or a
 * {@link PanelDataResult} a transport already decoded.
 * @returns `ok(response)` in the view form, or `err(error)`.
 */
export function mapPanelDataResult<Source extends DataQuerySource>(
  query: DataQuery & { source: Source },
  result: unknown,
): Result<DataQueryResponse<Source>, DebuggenError> {
  const requested = query.source;

  const envelope = checkEnvelope(requested, result, 'wire');
  if (!envelope.ok) {
    return envelope;
  }

  const record = envelope.value;
  const defect = payloadDefect(requested, record, requested);
  if (defect !== undefined) {
    return err(malformedResponseError(requested, defect, 'wire'));
  }

  // The one assertion of the mapping, and it is sound: `record[requested]` is
  // the payload the service keyed by the requested source, and it has just
  // passed that source's guard. What the compiler cannot see is only the
  // correlation between a generic `Source` and the guard table's entry for it.
  const data = record[requested] as DataResultFor<Source>;

  if (DATA_QUERY_PAGING[requested] === 'single') {
    return ok({ source: requested, data });
  }

  const page = readPageEcho(record, 'required');
  if (!page.ok) {
    return err(malformedResponseError(requested, page.error, 'wire'));
  }

  return ok({ source: requested, data, ...page.value });
}

/**
 * Check that a view-form response really answers the query it was returned for
 * — the check `./useQuery` applies to every provider's answer before a
 * component may read it.
 *
 * A {@link DataProvider} is an interface any host may implement by hand, and
 * its generic signature promises a `DataQueryResponse<Source>` that nothing at
 * runtime enforces: a provider can answer a `renders` query with a `requests`
 * response, put the payload under the wrong key, or hand over the service's
 * wire-form body untranslated. Any of those reaching a component would draw
 * the wrong evidence under the node's title, or throw mid-render, instead of
 * showing a retryable error state. This is where each is caught, whichever
 * factory — or none — built the provider.
 *
 * The response is accepted only when it is a plain object whose `source` equals
 * `query.source`, whose `data` passes that source's shallow payload guard (the
 * same guards {@link mapPanelDataResult} applies on the wire: the right kind of
 * container, at most `DATA_QUERY_MAX_LIMIT` items, the identifying fields of
 * each element or tree, `null` only for `trace` and `componentTree`), whose
 * `total`, `limit` and `offset` are each absent or a non-negative integer —
 * `limit` no larger than `DATA_QUERY_MAX_LIMIT` — and whose `nextOffset` is
 * absent, `null` or a non-negative integer. It reads nothing else and changes
 * nothing: no element is re-sorted, filtered or copied.
 *
 * @param query - The query the response was returned for; only its `source` is read.
 * @param response - The provider's answer, as `unknown`.
 * @returns `undefined` when the response may be drawn, or the
 * `PROTOCOL_INVALID_MESSAGE` error to report instead — its message and details
 * name the sources, the field and the kind of value found, never the value.
 */
export function checkDataQueryResponse(
  query: DataQuery,
  response: unknown,
): DebuggenError | undefined {
  const requested = query.source;

  const envelope = checkEnvelope(requested, response, 'view');
  if (!envelope.ok) {
    return envelope.error;
  }

  const record = envelope.value;
  const defect = payloadDefect(requested, record, 'data');
  if (defect !== undefined) {
    return malformedResponseError(requested, defect, 'view');
  }

  const page = readPageEcho(record, 'optional');
  if (!page.ok) {
    return malformedResponseError(requested, page.error, 'view');
  }

  return undefined;
}

/**
 * A source-agnostic resolver that answers in the wire form: one function that
 * forwards any query over a host surface's channel and returns the service's
 * `POST /sessions/:id/panel-data` body for it.
 *
 * The shape the DevTools panel and the editor webview have — their channel
 * returns the body the service sent, which the protocol's `parseDataResult`
 * turns into a typed `DataResult` that is assignable to {@link PanelDataResult}
 * as it stands. {@link createPanelDataProvider} turns it into a
 * {@link DataProvider} that maps each answer into the view form.
 *
 * The obligations on {@link DataProvider} apply — route by `context.sessionId`,
 * honour `context.signal`, reject rather than resolve on failure — except the
 * view-form ones, which the factory discharges: the resolver returns the body
 * untouched and never builds `data` itself. Like {@link DataQueryResolver}, its
 * return type is uncorrelated with the request's source, because the factory
 * checks at runtime that the two agree.
 *
 * @param query - The query to resolve, exactly as the node carried it.
 * @param context - The session to address and the per-call options.
 * @returns The service's answer for the query's own source, in the wire form.
 */
export type PanelDataResolver = (
  query: DataQuery,
  context: DataQueryResolverContext,
) => Promise<PanelDataResult>;

/**
 * Build a {@link DataProvider} from a {@link PanelDataResolver} — the factory a
 * host surface whose transport returns the service's body uses.
 *
 * Everything {@link createDataProvider} guarantees holds here too: a call that
 * names no usable session, or a present but unusable panel id, is refused
 * before the resolver runs, the session and any panel id are handed to the
 * resolver unchanged beside the abort signal, and a resolver that throws
 * synchronously still produces a rejected promise because it is invoked inside
 * an `async` method. The difference is the answer: each result
 * is translated into the view form by {@link mapPanelDataResult}, and a result
 * that fails that mapping — a misrouted source, a payload under the wrong key,
 * a missing or malformed paging counter — rejects with its
 * `PROTOCOL_INVALID_MESSAGE` error, which a node renders as its error state
 * with a retry, instead of reaching a component as a response with no `data`.
 *
 * Create it once per host surface and keep the reference (obligation 7 on
 * {@link DataProvider}): the session travels on every call, so one provider
 * serves every panel that surface shows.
 *
 * @example The DevTools panel over its port to the service worker.
 * ```ts
 * const provider = createPanelDataProvider(async (query, { sessionId, signal, panelId }) => {
 *   // The request body is the node's query plus, for a panel-bound read, its panel id.
 *   const body = await port.request(
 *     { sessionId, query: panelId === undefined ? query : { ...query, panelId } },
 *     signal,
 *   );
 *   const parsed = parseDataResult(body); // from @debuggen/protocol, in the host
 *   if (!parsed.ok) {
 *     throw parsed.error;
 *   }
 *   return parsed.value;
 * });
 * ```
 *
 * @param resolve - The resolver to adapt. Called once per query.
 * @returns A provider that delegates every query to `resolve` and maps its answer.
 */
export function createPanelDataProvider(resolve: PanelDataResolver): DataProvider {
  return {
    async query<Source extends DataQuerySource>(
      sessionId: string,
      query: DataQuery & { source: Source },
      options?: DataQueryOptions,
    ): Promise<DataQueryResponse<Source>> {
      const result = await resolve(query, resolverContext(sessionId, query.source, options));
      const mapped = mapPanelDataResult(query, result);

      if (!mapped.ok) {
        throw mapped.error;
      }

      return mapped.value;
    },
  };
}

/**
 * Bind a {@link DataProvider} to the panel specification being rendered, so
 * every query made through it names that panel's identity.
 *
 * The returned provider delegates each call to `provider` with the same session,
 * the same query and the same options — `signal` included — and with
 * `options.panelId` set: the call's own `panelId` when it names one, otherwise
 * the bound `panelId`. That is what makes every node of a rendered panel read
 * the capture that panel was generated from rather than live evidence, without
 * any node, `./useQuery` or `PanelHost` having to know the panel's id: the
 * surface that renders the specification wraps its long-lived provider once
 * per panel and hands the wrapper to `PanelHost`.
 *
 * The input provider is not touched, so the same long-lived provider keeps
 * serving live reads elsewhere on the surface. The wrapper is a new object:
 * memoize it on the provider and the panel id (obligation 7 on
 * {@link DataProvider}), which also means a newly rendered panel version gets a
 * new wrapper and its views resolve again against their own capture.
 *
 * Binding never throws, so a render cannot crash on it. A bound or per-call
 * `panelId` that cannot name a panel — not a string, or blank — is refused at
 * query time instead, with a `PANEL_INVALID` rejection, before `provider` is
 * called: silently dropping it would turn a panel-bound read into a live one.
 *
 * @example Binding in the surface that renders a specification.
 * ```tsx
 * const panelProvider = useMemo(
 *   () => (spec === undefined ? dataProvider : bindPanelIdentity(dataProvider, spec.id)),
 *   [dataProvider, spec?.id],
 * );
 * return <PanelHost spec={spec} dataProvider={panelProvider} actions={actions} />;
 * ```
 *
 * @param provider - The provider to delegate to. Not modified.
 * @param panelId - The id of the panel specification the provider's queries
 * belong to: the rendered `PanelSpec`'s own `id`.
 * @returns A provider that forwards every query to `provider` with `panelId` set.
 */
export function bindPanelIdentity(provider: DataProvider, panelId: string): DataProvider {
  return {
    async query<Source extends DataQuerySource>(
      sessionId: string,
      query: DataQuery & { source: Source },
      options?: DataQueryOptions,
    ): Promise<DataQueryResponse<Source>> {
      // An explicit `undefined` check rather than `??`, so a per-call `null`
      // from an untyped caller is refused below instead of quietly replaced.
      const requested: unknown = options?.panelId;
      const effective = requested === undefined ? panelId : requested;

      if (!isUsablePanelId(effective)) {
        throw unusablePanelIdError(query.source, effective);
      }

      return provider.query(sessionId, query, { ...options, panelId: effective });
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

/**
 * The session the panel beneath it belongs to, provided by `PanelHost` and read
 * by `./useQuery`, which passes it as the first argument of every
 * {@link DataProvider.query} call.
 *
 * `PanelHost` provides `spec.sessionId` — the specification's own statement of
 * which session's capture it describes, and therefore the only value a panel's
 * queries may be addressed to. A surface that mounts query-backed views without
 * a `PanelHost` provides it itself, beside {@link DataProviderContext}.
 *
 * A separate context from the provider on purpose. The value is a string, so it
 * is stable by value and costs the host no memoization; it changes exactly when
 * the panel being drawn moves to another session, which is precisely when every
 * query beneath it must be resolved again; and the provider object stays the
 * one long-lived instance per host surface that obligation 7 on
 * {@link DataProvider} asks for.
 *
 * The default is `undefined`, for the same reason as the provider context's: a
 * query addressed to an invented session would be answered with someone else's
 * evidence or with nothing, and both would look like a successful panel. An
 * absent session is reported by `./useQuery` as a typed error state instead.
 */
export const PanelSessionContext = createContext<string | undefined>(undefined);

PanelSessionContext.displayName = 'DebuggenPanelSessionContext';

/**
 * Read the ambient session id, or `undefined` when none is provided.
 *
 * Never throws, for the reasons given on {@link useDataProvider}: components
 * that need no data are mounted with neither context on purpose, and a view that
 * does need data reports the absence as its error state through `./useQuery`.
 *
 * @returns The session id from context, or `undefined` when the tree has none.
 */
export function usePanelSessionId(): string | undefined {
  return useContext(PanelSessionContext);
}
