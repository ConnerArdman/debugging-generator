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
 * The same object answers the event drawer, which renders outside `PanelHost`:
 * {@link PanelDataProvider.resolveEvent} resolves a selected event and the
 * stored events of its parent chain, however far into the capture they lie, by
 * paging `events` through this provider's own `query` — each of its two passes
 * within a page budget of its own, and resumable where it stopped. A lookup for
 * a rendered panel's evidence names that panel, exactly as the panel's nodes
 * do, so every one of its pages is answered from the capture that panel was
 * generated from.
 *
 * ## The seam, one-directional
 *
 * {@link createPanelDataProvider} is a factory, not a singleton, and it
 * acquires nothing: the request function (`panelRequest`, or
 * `getPanelConnection().request`), the port-loss registration
 * (`onPortDisconnect`), the session getter (`getSessionId` from
 * `./state/session-store.ts`), the capture getter, the trace cache's
 * authorisation predicate and the ended-session predicate (all reading that
 * store's snapshot) are all injected by `../App.tsx`. This module
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
 * - **The panel identity is forwarded, never dropped.** A node of a rendered
 *   panel queries through a provider `./components/PanelView.tsx` bound to
 *   that panel with the renderer's `bindPanelIdentity`, so its call carries
 *   `options.panelId` — the specification's own `id`. It is sent beside the
 *   query as the protocol's `PanelDataRequest` body (`{ ...query, panelId }`),
 *   and the service answers from the capture that panel was generated from, so
 *   an older panel still on screen never draws a newer capture under its own
 *   findings. A call with no `panelId` sends no `panelId` key and is a live
 *   read (the open capture, else the most recent). A present `panelId` that is
 *   not a string with a visible character is refused with `PANEL_INVALID`
 *   before anything is sent: dropping it would silently turn a panel-bound
 *   read into a live one. The `panelId` is part of the body the coalescing key
 *   is computed over, so a panel-bound read never joins a live one or a read
 *   bound to another panel.
 * - **Correlation is layered, and identical requests are coalesced.**
 *   `./state/connection.ts` correlates port frames with its own request ids;
 *   this module keeps its own registry of the *distinct* requests it has in
 *   flight, keyed by the session, the capture the panel's store shows and the
 *   renderer's `stableQueryKey` of the whole normalised query (see
 *   {@link panelDataRequestKey}). Two nodes asking for the same page at the
 *   same time — a `Timeline` and a `FlameChart` of one trace — therefore share
 *   one port request, one HTTP call and one store read. The capture is part of
 *   the identity because the service answers each call from the session's
 *   active (or latest) capture: a new capture changes what an identical query
 *   means without changing the session, so a query issued under capture B
 *   never joins a request opened under capture A. The capture is read from the
 *   injected `getCaptureId` on every call; when it is unknown the key says so,
 *   and such a request is shared only with others issued while it was unknown.
 *   Each shared request has its own `AbortController`, its own timeout
 *   and a set of subscribers, one per `query` call: a caller's abort rejects
 *   only that caller and detaches its listener, and when the last caller has
 *   left the shared request is aborted and forgotten. A timeout, port loss or
 *   a failed request rejects every subscriber; an answer resolves each of them
 *   through its own mapping. `../shared/messages` declares no cancel frame, so
 *   an abandoned or timed-out request is dropped locally and a late answer is
 *   discarded, never resolved into a promise that already settled.
 * - **In flight, never cached.** A request leaves the registry the moment it
 *   settles, so an identical query issued afterwards is sent afresh. The
 *   capture behind a session grows while it runs, and a settled cache would
 *   need an invalidation rule that nothing in the panel can state. Coalescing
 *   only requests that overlap in time — and only within one session and one
 *   capture — needs none: the answer a joining caller receives was still
 *   outstanding when it asked, for the capture it asked under, so it is never
 *   older than one round trip. (The drawer's trace cache behind
 *   {@link PanelDataProvider.resolveEvent} is the one bounded exception. Each
 *   entry is scoped by session, evidence scope and trace — the evidence scope
 *   being the panel a panel-bound lookup names, or the store's current capture
 *   for a live one — so observing another current capture drops the live
 *   entries, and a lookup bound to another panel drops every other panel's. It
 *   answers only while the panel's own tab is bound to the session and
 *   connected, so a cached trace never outlives the evidence it was read from,
 *   the binding that authorised it, or the port it arrived on.)
 * - **A failure is never data.** Every path that is not a checked answer ends
 *   in a rejected promise carrying a `DebuggenError` — which is what makes
 *   `useQuery` render its error state with a retry (AAP §0.5.5). No path
 *   resolves with an empty page on failure.
 * - **Nothing private reaches an error.** Messages, hints and details name the
 *   requested source and, at most, the numeric `limit` and `offset` — never the
 *   query's filter values, the answer's contents, a session id, a panel id
 *   (only whether the query was panel-bound), a token or a URL (AAP §0.5.2). A
 *   worker failure keeps the code, message and hint the worker and service
 *   chose.
 * - **No validation of panels.** The service validated the specification and
 *   the worker's protocol client parses both the request body against the
 *   route's schema and the answer; this module neither re-parses nor
 *   re-validates, and the shallow wire-to-view mapping is the renderer's.
 *
 * @example Building the provider once in `../App.tsx`, and binding it per
 * rendered panel in `./components/PanelView.tsx`:
 * ```tsx
 * const dataProvider = useMemo(
 *   () =>
 *     createPanelDataProvider({
 *       request: panelRequest,
 *       onPortDisconnect,
 *       getSessionId,
 *       getCaptureId: readCaptureId,
 *       canServeCached: canServeCachedTrace,
 *     }),
 *   [],
 * );
 * const panelProvider = useMemo(() => bindPanelIdentity(dataProvider, spec.id), [dataProvider, spec.id]);
 * return <PanelHost spec={spec} dataProvider={panelProvider} actions={actions} theme={theme} />;
 * ```
 *
 * @module apps/chrome-extension/src/panel/data-provider
 */

import { mapPanelDataResult, stableQueryKey } from '@debuggen/panel-renderer';
import type { DataProvider, DataQueryOptions, DataQueryResponse } from '@debuggen/panel-renderer';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
} from '@debuggen/panel-schema';
import type { DataQuery, DataQuerySource } from '@debuggen/panel-schema';
import type { PanelDataRequest, TelemetryEvent } from '@debuggen/protocol';
import { DebuggenError, noopLogger } from '@debuggen/shared';
import type { CaptureId, Logger, SessionId } from '@debuggen/shared';

import type {
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

/**
 * The most `events` pages **one pass** of a
 * {@link PanelDataProvider.resolveEvent} call requests: **10** pages of
 * `DATA_QUERY_MAX_LIMIT` (5 000) events, so one pass reads at most 50 000
 * stored events.
 *
 * A lookup has at most two passes, and each has this budget of its own: the
 * **find** pass, which pages until the selected event turns up, and the
 * **ancestry** pass, which pages the event's trace for the ancestors the find
 * pass did not already collect. So an event found on the find pass's last
 * page still gets a full ancestry pass, and one lookup requests at most twice
 * this many pages.
 *
 * The selection carries no filter the service can index an event by — the
 * query schema has no event-id field — so a lookup pages the capture. The
 * budget is what keeps one click from reading an arbitrarily large capture
 * into the panel, and it is a bound per call, not a horizon: a find pass that
 * stops at it is reported as `budget-exhausted` — distinctly from `not-found`
 * ("the capture does not hold it") — with the offset it stopped at, and a
 * later call resumes there (`resumeFrom`); an ancestry pass that stops at it
 * is reported on the `found` answer, and a later call continues it
 * (`resumeAncestry`). So the drawer never claims an event or an ancestor is
 * missing when it merely stopped looking, and every stored event stays
 * reachable. A selection that names its trace — every selection raised by a
 * timeline, a waterfall or an evidence chip does — is scanned within that
 * trace only, where the budget is never the limit in practice.
 */
export const EVENT_RESOLUTION_PAGE_BUDGET = 10;

/**
 * The most stored events **one pass** of a
 * {@link PanelDataProvider.resolveEvent} call reads:
 * {@link EVENT_RESOLUTION_PAGE_BUDGET} pages of `DATA_QUERY_MAX_LIMIT` events.
 * Derived, never restated, so the bound a pass applies and the bound the
 * drawer names can never disagree.
 */
export const EVENT_RESOLUTION_MAX_EVENTS = EVENT_RESOLUTION_PAGE_BUDGET * DATA_QUERY_MAX_LIMIT;

/**
 * How many traces the drawer's trace cache keeps: **16**, least recently used
 * evicted first. Enough for a developer walking back and forth between the
 * events of a handful of interactions, and small enough to be irrelevant to
 * the panel's memory.
 */
export const EVENT_TRACE_CACHE_MAX_TRACES = 16;

/**
 * How many stored events the drawer's trace cache keeps across all of its
 * traces: **20 000**, least recently used traces evicted first until the total
 * fits. A single trace larger than this is never cached.
 */
export const EVENT_TRACE_CACHE_MAX_EVENTS = 20_000;

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
  endedSession:
    'What this panel already shows stays on screen. Start a new session from the Debug Generator view in VS Code to capture again.',
  unusablePanel: 'Reload the panel; if it keeps failing, reopen Chrome DevTools.',
  disconnected: 'The panel reconnects on its own; retry in a moment.',
  timeout: 'Retry in a moment; if it keeps failing, reload the extension.',
  failed: 'Retry in a moment; if it keeps failing, reopen Chrome DevTools.',
  unidentified: 'Select the event again from the panel or the live tail.',
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
 * @param payload The session to address and the request body: the normalised
 * query, plus the `panelId` of the panel it belongs to for a panel-bound read.
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
   * The capture this panel's store shows — `capture.captureId` of the store's
   * snapshot: the running capture, or the most recent one after it stopped.
   *
   * Read on every call, because a new capture changes it without changing the
   * session, while the service answers each live call from the session's
   * active (or latest) capture. It is part of every request's identity (see
   * {@link panelDataRequestKey}) and the evidence scope of every trace-cache
   * entry a **live** lookup writes; a panel-bound lookup is scoped by its
   * panel instead, whose capture its id fixes. Omitted, returning a blank
   * value, or throwing (logged, never rethrown), the capture counts as
   * **unknown**: requests are then coalesced only with others issued while it
   * was unknown, and the trace cache answers no live lookup.
   */
  readonly getCaptureId?: (() => CaptureId | undefined) | undefined;
  /**
   * Whether the drawer's trace cache may answer for `sessionId` right now —
   * in `../App.tsx`, whether the panel is connected and its inspected tab is
   * bound to exactly that session.
   *
   * The cache fails closed (AAP §0.5.6: a devtools client may read panel data
   * only for the session bound to its tab). It answers only when
   * `getSessionId()` returns exactly `sessionId` **and** this predicate is
   * present and returns `true`; in every other case — the predicate omitted,
   * answering anything but `true`, or throwing (logged, never rethrown) — the
   * cache is emptied and the lookup goes to the service, which authorises the
   * request against the tab's binding. So a trace cached while the tab was
   * bound is never served after the tab unbinds, leaves, or loses its
   * credential. Read at every cache read and write, never remembered.
   */
  readonly canServeCached?: ((sessionId: SessionId) => boolean) | undefined;
  /**
   * Whether `sessionId` is an ended session this panel still shows —
   * `isEndedSessionShown` from `./state/session-store.ts`, injected by
   * `../App.tsx`: the ended session on screen on a tab no longer bound.
   *
   * Ending a session unbinds its tab, and the store keeps the ended session's
   * final state on screen, rendered views included. A read that view makes
   * afterwards — another page, an expanded row, an event lookup — cannot
   * succeed: a devtools client reads panel data only for the session bound to
   * its tab (AAP §0.5.6), and a session that has ended accepts no binding. So
   * such a read is refused here, before anything is sent, with copy that says
   * why and that the views on screen stay — rather than a worker refusal whose
   * hint to reopen the panel would discard them.
   *
   * Read at every call, never remembered. Omitted, answering anything but
   * exactly `true`, or throwing (logged with the error's name only), the query
   * is sent as usual and the worker and service decide.
   */
  readonly isSessionEnded?: ((sessionId: SessionId) => boolean) | undefined;
  /**
   * `onPortDisconnect` from `./state/connection.ts`. When given, the provider
   * subscribes while it has queries in flight **or** holds cached traces: the
   * moment the port closes (the worker suspends after about thirty seconds
   * idle) it rejects every query in flight, so no node keeps a spinner for a
   * port that is gone, and empties the trace cache, whose entries were
   * authorised over that port. With neither left, it unsubscribes.
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
 * What {@link PanelDataProvider.resolveEvent} looks up: the store's selection,
 * as far as it is known.
 */
export interface PanelEventTarget {
  /** The selected event's id. */
  readonly eventId: string;
  /**
   * The selected event's trace, when the selection or the live tail knows it.
   * Known, the scan is narrowed to that trace; unknown (or blank), the whole
   * capture is paged until the event is found.
   */
  readonly traceId?: string | undefined;
}

/**
 * Where a lookup continues an ancestry pass that stopped at its page budget:
 * the `ancestryResumeOffset` and the `trace` of the `found` answer it
 * continues.
 */
export interface PanelAncestryResume {
  /**
   * The first offset of the event's trace that pass did not read — the
   * earlier answer's `ancestryResumeOffset`.
   */
  readonly from: number;
  /**
   * The stored events of the trace that pass collected — the earlier answer's
   * `trace`. It must hold the selected event; the continuation pages the
   * trace from `from` on top of it, so nothing already read is read again.
   */
  readonly trace: readonly TelemetryEvent[];
}

/** Per-call options for {@link PanelDataProvider.resolveEvent}. */
export interface PanelEventResolveOptions {
  /**
   * Cancels the lookup. Checked before every page and honoured by every page
   * request; an abort rejects with the same `TRANSPORT_DISCONNECTED` /
   * `reason: "aborted"` failure an aborted `query` rejects with.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * The rendered panel the selection belongs to — the `PanelSpec`'s own `id`.
   * Every `events` page of the lookup, on both passes, is sent with it, so the
   * service answers from the capture that panel was generated from, and the
   * lookup reads and writes only trace-cache entries of that panel. Omitted,
   * the lookup is a **live** read: the session's open capture, else its most
   * recent one, cached under the capture the store shows. A present value that
   * is not a string with a visible character rejects with `PANEL_INVALID`
   * before the cache is consulted or anything is sent — the same refusal
   * `query` applies, so a panel-bound lookup never silently turns live.
   */
  readonly panelId?: string | undefined;
  /**
   * Resume a find pass that stopped at its page budget: the find pass starts
   * at this offset — an earlier `budget-exhausted` answer's `resumeOffset` —
   * instead of at the first stored event, with a full page budget of its own.
   * The offset is into the same sequence the earlier pass paged: the whole
   * capture when the target names no trace, the target's trace when it does.
   * Normalised like a query's `offset` (a malformed value starts at the
   * first event). The ancestry pass, when one is needed, still pages the
   * trace from its start, because the ancestors may lie before this offset.
   */
  readonly resumeFrom?: number | undefined;
  /**
   * Continue an ancestry pass that stopped at its page budget (see
   * {@link PanelAncestryResume}). Used only when its `trace` holds the target
   * event of the target's trace; otherwise it is ignored and the lookup runs
   * from the start. Takes precedence over `resumeFrom`.
   */
  readonly resumeAncestry?: PanelAncestryResume | undefined;
}

/**
 * What {@link PanelDataProvider.resolveEvent} established — always a real
 * answer about the stored capture; a failure to reach it rejects instead.
 *
 * - `found` — the capture holds the event. `trace` is the pool of stored
 *   events of its trace that were collected, which is what
 *   {@link buildEventParentChain} builds the parent chain from; `chainComplete`
 *   says whether it holds every ancestor up to the root. When it does not,
 *   `budgetExhausted` says why: `true` — the ancestry pass stopped at
 *   {@link EVENT_RESOLUTION_PAGE_BUDGET}, and `ancestryResumeOffset` is the
 *   first offset of the trace it did not read (continue with
 *   `resumeAncestry`); `false` — every page of the trace was read, so the
 *   missing ancestors were never stored.
 * - `not-found` — every page that could hold the event was read, and none did.
 * - `budget-exhausted` — the find pass stopped at its page budget without
 *   finding it; the capture may hold it further on. `scope` names what was
 *   paged — the whole `capture`, or the target's `trace` — and the pass read
 *   offsets `searchedFrom` up to (not including) `resumeOffset` of it,
 *   `eventsSearched` events in all. Resume with `resumeFrom: resumeOffset`.
 *
 * `pagesRead` counts the `events` pages requested by the call, across its
 * passes; `0` is a cache hit.
 */
export type PanelEventResolution =
  | {
      readonly status: 'found';
      readonly event: TelemetryEvent;
      readonly trace: readonly TelemetryEvent[];
      readonly chainComplete: boolean;
      readonly budgetExhausted: boolean;
      /** Present exactly when `budgetExhausted` is `true`. */
      readonly ancestryResumeOffset?: number | undefined;
      readonly pagesRead: number;
    }
  | { readonly status: 'not-found'; readonly pagesRead: number }
  | {
      readonly status: 'budget-exhausted';
      readonly scope: 'capture' | 'trace';
      readonly searchedFrom: number;
      readonly resumeOffset: number;
      readonly eventsSearched: number;
      readonly pagesRead: number;
    };

/**
 * The provider {@link createPanelDataProvider} returns: the renderer's
 * {@link DataProvider}, the drawer's event lookup, and the two hooks its owner
 * and its tests need.
 *
 * Assignable to `DataProvider` as it stands, so `PanelHost`'s `dataProvider`
 * prop takes it without a cast.
 */
export interface PanelDataProvider extends DataProvider {
  /**
   * Resolve a selected event — and the stored events its parent chain is built
   * from — against the session's stored capture, however far into the capture
   * it lies.
   *
   * The query schema has no event-id filter, so the lookup pages `events`
   * through this provider's own `query` (identical concurrent pages are
   * therefore shared with every other caller), `DATA_QUERY_MAX_LIMIT` at a
   * time, following each page's `nextOffset`:
   *
   * 1. **The find pass** — pages from `resumeFrom` (default: the first stored
   *    event) until the event is collected: `filter: { traceId }` when the
   *    trace is known, the unfiltered capture when it is not. It stops early
   *    once the pages collected so far also hold the event's complete
   *    ancestor chain (by `parentSpanId` within the trace).
   * 2. **The ancestry pass** — when the find pass found the event but not its
   *    whole chain, pages `filter: { traceId }` of the event's trace, on top of
   *    what the find pass collected, until the chain is complete or the
   *    trace's pages end. It continues where the find pass stopped when that
   *    pass paged the same trace from its start, and starts at the trace's
   *    first event otherwise.
   *
   * Each pass has its own {@link EVENT_RESOLUTION_PAGE_BUDGET}. A pass that
   * spends it reports where it stopped, and a later call resumes there —
   * `resumeFrom` for the find pass, `resumeAncestry` for the ancestry pass —
   * so no stored event is beyond reach, however large the capture.
   *
   * Every page carries the lookup's `panelId` when it names one (see
   * {@link PanelEventResolveOptions.panelId}), so a panel's evidence is read
   * from that panel's capture however many captures the session has since
   * started; a lookup naming none reads live evidence.
   *
   * Before any page is requested, a bounded least-recently-used cache of trace
   * pools (keyed by session, evidence scope and trace — the scope being the
   * lookup's panel, or for a live lookup the capture the store shows) is
   * consulted, and it answers **only** from an entry of the lookup's own
   * session and scope, when that entry holds the event and its complete chain
   * *and* the cache is authorised (see
   * {@link PanelDataProviderOptions.canServeCached}): stored events are
   * immutable once written, so such an answer is exactly what a scan would
   * find, whereas a pool missing the event or an ancestor may be missing
   * something the growing capture now holds, and is re-queried. A live lookup
   * under an unknown capture neither reads nor writes the cache.
   *
   * @param sessionId The session the selection belongs to. Missing, blank or
   * foreign to the panel's store, the call rejects with `TAB_NOT_BOUND`
   * exactly as `query` does — before the cache is consulted.
   * @param target The selected event's id and, when known, its trace.
   * @param options The lookup's abort signal, the panel it is bound to, and
   * where to resume a pass an earlier call stopped at its budget.
   * @returns What the stored capture says about the event. Rejects with a
   * `DebuggenError` — never an empty success — when a page cannot be read, the
   * target names no event, the `panelId` cannot name a panel, or the call is
   * aborted.
   */
  resolveEvent(
    sessionId: SessionId | undefined,
    target: PanelEventTarget,
    options?: PanelEventResolveOptions,
  ): Promise<PanelEventResolution>;
  /**
   * Reject every request this provider has in flight — every caller waiting on
   * each of them — with a transport failure naming the request's own source,
   * abort the underlying requests and forget them; their answers are dropped if
   * they arrive later. The drawer's trace cache is emptied too: its entries
   * were authorised over the port that is gone.
   *
   * Called by the provider itself on port loss when `onPortDisconnect` was
   * injected; exposed so that an owner wiring the port some other way can
   * trigger the same thing.
   *
   * @param error The loss to report. Its code, message and hint are kept and
   * each rejection's details gain the query's source; when omitted, a
   * `TRANSPORT_DISCONNECTED` "the port closed" failure is used.
   * @returns How many **distinct requests** were rejected — the unit
   * {@link PanelDataProvider.pendingCount} counts. Three callers coalesced into
   * one request count once, although all three promises reject.
   */
  rejectAllPending(error?: DebuggenError): number;
  /**
   * How many **distinct requests** are in flight: sent, and neither answered
   * nor rejected nor abandoned by their last caller. Identical concurrent
   * queries share one request (see the module documentation), so this is the
   * number of `panelData.query` port requests outstanding, not the number of
   * `query` calls waiting.
   */
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

/**
 * The identity of one request as this provider coalesces it: the session it
 * is addressed to, the capture the panel's store showed when it was issued,
 * and the renderer's `stableQueryKey` of the query **as it is sent** — after
 * {@link normalizePanelDataQuery}.
 *
 * - Computed over the whole normalised query, not over a chosen list of
 *   fields, so any field the query schema gains participates without a change
 *   here: two queries share a request exactly when they would send the same
 *   payload to the same session under the same capture.
 * - Normalised first, so `{ source: 'events' }` and
 *   `{ source: 'events', limit: 200, offset: 0 }` are one request — they are
 *   one page — while keys in another order and members explicitly `undefined`
 *   fold together by `stableQueryKey`'s own rules.
 * - Scoped by capture, because the service answers from the session's active
 *   (or latest) capture: the same query under a new capture is another
 *   question. An unknown capture is its own scope (`null`), distinct from
 *   every known one — including a capture whose id is the text `null`.
 * - The session and the capture are JSON-encoded before their separators. A
 *   JSON string ends at its first unescaped quote and `null` is a fixed token,
 *   so both segments are self-delimiting and no triple of a session, a capture
 *   and a query can spell the key of another triple, whatever characters any
 *   of them holds.
 *
 * The key holds the session id, the capture id and the filter values, so it
 * is compared and never logged, shown or placed in an error.
 *
 * @param sessionId The session the query is addressed to.
 * @param captureId The capture the panel's store shows, or `undefined` when it
 * is unknown.
 * @param sent The request body exactly as it will be sent: the normalised
 * query, plus the `panelId` of a panel-bound read — so a read bound to one
 * panel never shares an answer with a live read or with another panel's.
 * @returns A string equal for exactly the requests that may share one answer.
 */
export function panelDataRequestKey(
  sessionId: SessionId,
  captureId: CaptureId | undefined,
  sent: DataQuery,
): string {
  return `${JSON.stringify(sessionId)}:${JSON.stringify(captureId ?? null)}:${stableQueryKey(sent)}`;
}

/**
 * An event's ancestors, from the trace root to its immediate parent, built
 * only from events in `pool` — never synthesised from `parentSpanId` alone.
 *
 * The one definition of "the parent chain" in the panel: the drawer renders
 * what it answers, and {@link PanelDataProvider.resolveEvent} stops paging
 * once it answers a chain, so the two can never disagree about when the chain
 * is complete.
 *
 * - A root event (no `parentSpanId`) answers an empty chain.
 * - Ancestors are looked up by span id among the pool's events of the same
 *   trace; when several share a span id, the first in pool order is used.
 * - When an ancestor is missing from `pool` (a partial page, or a parent that
 *   never arrived), or the links form a cycle, the chain cannot be stated from
 *   the root and `undefined` is answered, so a caller omits it rather than
 *   presenting a fragment as the whole lineage.
 *
 * @param event The event whose ancestry is wanted.
 * @param pool Stored or streamed events to look ancestors up in.
 * @returns The ancestors, root first, or `undefined` when incomplete.
 */
export function buildEventParentChain(
  event: TelemetryEvent,
  pool: readonly TelemetryEvent[],
): readonly TelemetryEvent[] | undefined {
  const bySpan = new Map<string, TelemetryEvent>();
  for (const candidate of pool) {
    if (candidate.traceId === event.traceId && !bySpan.has(candidate.spanId)) {
      bySpan.set(candidate.spanId, candidate);
    }
  }
  const chain: TelemetryEvent[] = [];
  const visited = new Set<string>([event.spanId]);
  let parentSpanId = event.parentSpanId;
  while (parentSpanId !== undefined) {
    const parent = bySpan.get(parentSpanId);
    if (parent === undefined || visited.has(parentSpanId)) {
      return undefined;
    }
    visited.add(parentSpanId);
    chain.push(parent);
    parentSpanId = parent.parentSpanId;
  }
  return chain.reverse();
}

/**
 * Which evidence one drawer lookup reads, and so which cached traces it may
 * use:
 *
 * - `panel` — a lookup bound to a rendered panel: its pages carry `panelId`,
 *   and the service answers from the capture that panel was generated from.
 *   The id fixes that capture, so the scope needs no capture of its own.
 * - `live` — a lookup naming no panel: the service answers from the session's
 *   open capture, else its most recent one, which is the capture the store
 *   shows (`captureId`) when the lookup starts.
 *
 * Holds a panel id or a capture id, so it is compared only, never logged.
 */
type EvidenceScope =
  | { readonly kind: 'panel'; readonly panelId: string }
  | { readonly kind: 'live'; readonly captureId: CaptureId };

/** The id an evidence scope is keyed by: its panel's, or its capture's. */
function evidenceScopeId(scope: EvidenceScope): string {
  return scope.kind === 'panel' ? scope.panelId : scope.captureId;
}

/** Whether two evidence scopes read the same evidence: same kind, same id. */
function sameEvidenceScope(left: EvidenceScope, right: EvidenceScope): boolean {
  return left.kind === right.kind && evidenceScopeId(left) === evidenceScopeId(right);
}

/**
 * Where the drawer's trace cache holds one trace of one evidence scope of one
 * session. Every part — the session, the scope's kind, the scope's id and the
 * trace — is JSON-quoted, so the key is self-delimiting (see
 * {@link panelDataRequestKey}) and a panel and a capture that share an id
 * never share an entry; compared only, never logged.
 */
function traceCacheKey(sessionId: SessionId, scope: EvidenceScope, traceId: string): string {
  return [sessionId, scope.kind, evidenceScopeId(scope), traceId]
    .map((part) => JSON.stringify(part))
    .join(':');
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

/**
 * A query addressed to the ended session this panel still shows: no binding
 * can authorise it any more (see {@link PanelDataProviderOptions.isSessionEnded}).
 * `SESSION_INVALID_STATE`, the code the service refuses a bind to an ended
 * session with.
 */
function endedSessionError(source: DataQuerySource): DebuggenError {
  return new DebuggenError(
    'SESSION_INVALID_STATE',
    `The "${source}" data for this view cannot be requested: the session has ended, and DevTools reads captured evidence only while its tab is bound to a live session.`,
    { hint: HINTS.endedSession, details: { source, session: 'ended' } },
  );
}

/** The kind of an unusable panel id, for a detail — never the value itself. */
function panelIdKind(panelId: unknown): string {
  if (typeof panelId === 'string') {
    return 'blank';
  }
  return panelId === null ? 'null' : typeof panelId;
}

/**
 * A query naming a panel identity that cannot name a panel: not a string, or
 * blank. `PANEL_INVALID`, like the renderer's own refusal of the same value.
 * The value is described by its kind only — a panel id never reaches an error.
 */
function unusablePanelError(source: DataQuerySource, panelId: unknown): DebuggenError {
  return new DebuggenError(
    'PANEL_INVALID',
    `The "${source}" data for this view was requested for a panel with no usable id.`,
    {
      hint: HINTS.unusablePanel,
      details: { source, panelBound: true, panelId: panelIdKind(panelId) },
    },
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

/** An event lookup whose target names no event: a defect in the caller's selection. */
function unidentifiedEventError(): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    'The selected event cannot be looked up: the selection does not name an event.',
    { hint: HINTS.unidentified, details: { source: 'events', eventId: 'missing' } },
  );
}

/*
 * ===========================================================================
 * Section E — the provider
 * ===========================================================================
 */

/** A platform timer handle, whichever runtime's `setTimeout` produced it. */
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/**
 * One caller waiting on a shared request: one `query` call.
 *
 * Settled at most once, by whichever comes first — the shared request's
 * outcome, or the caller's own abort.
 */
interface Subscriber {
  /** Hands the caller the worker's answer, for it to map with its own query. */
  readonly resolve: (answer: PanelDataQueryAnswer) => void;
  /** Rejects the caller with a typed error. */
  readonly reject: (error: DebuggenError) => void;
  /** Detaches the caller's abort listener. Idempotent. */
  readonly detach: () => void;
}

/**
 * One distinct request in flight, shared by every caller that asked for the
 * same page of the same session while it was outstanding.
 */
interface SharedRequest {
  /** Its {@link panelDataRequestKey}: where the registry holds it. */
  readonly key: string;
  /** The query's source and paging, for the rejection wording. */
  readonly context: QueryContext;
  /**
   * Cancels the underlying request. Owned by the shared request, never a
   * caller's: one caller leaving must not cancel the answer others still wait
   * for.
   */
  readonly controller: AbortController;
  /** The callers waiting on it; the request is abandoned when the last one leaves. */
  readonly subscribers: Set<Subscriber>;
  /** Its timeout, until it settles. */
  timer: TimerHandle | undefined;
  /** Whether it has settled: answered, failed or abandoned. Set exactly once. */
  settled: boolean;
}

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
 *    `getSessionId` reports, with `TAB_NOT_BOUND`, and a call whose
 *    `options.panelId` is present but not a string with a visible character
 *    with `PANEL_INVALID`;
 * 2. normalises `limit` and `offset` (see {@link normalizePanelDataQuery});
 * 3. refuses an already-aborted call without sending anything;
 * 4. reads the store's capture through `getCaptureId`, computes the request's
 *    {@link panelDataRequestKey} over the session, that capture and the
 *    request body — the protocol's `PanelDataRequest`: the normalised query,
 *    plus `panelId` when the call named one — and joins the identical request already in flight
 *    under the same capture, when there is one; otherwise it opens a new
 *    shared request — its own `AbortController`, its own timeout, registered
 *    for port loss — and sends one `panelData.query` port request with that
 *    controller's signal (never a caller's) and this provider's timeout;
 * 5. waits as one subscriber of that request: its own signal's abort rejects
 *    this call alone and detaches its listener, and abandons the request —
 *    aborting it and dropping any late answer — once no caller is left, while
 *    a timeout, port loss or a failed request rejects every subscriber;
 * 6. maps the worker's wire-form answer into the view form with the renderer's
 *    `mapPanelDataResult` and **its own** query, which rejects an answer for
 *    another source or with a malformed payload or page echo as
 *    `PROTOCOL_INVALID_MESSAGE`;
 * 7. resolves with `{ source, data }` plus, for a paged source, the `total`,
 *    `limit`, `offset` and `nextOffset` the service reported — `null` included
 *    — and nothing the service did not send.
 *
 * A joining caller shares the request's remaining time: it waits no longer
 * than the provider's timeout, and possibly less. Every failure — abort,
 * timeout, port loss, a worker's typed refusal, a mismatched answer — rejects
 * with a `DebuggenError` and leaves no entry, timer or listener behind once no
 * caller holds the request; `query` never throws synchronously and never
 * resolves a failure as data.
 *
 * {@link PanelDataProvider.resolveEvent}, the drawer's lookup, reads the
 * capture through this same `query` — so its pages are guarded, coalesced and
 * bounded exactly like any node's, and carry the lookup's `panelId` exactly as
 * a node's carry its panel's — and keeps its trace cache per provider, scoped
 * by session, evidence scope (the lookup's panel, or for a live lookup the
 * store's capture) and trace, authorised at every read and write by
 * `getSessionId` and `canServeCached`, and emptied on port loss.
 *
 * @param options The injected request function, session and capture getters,
 * cache authorisation predicate, optional port loss registration, timeout and
 * logger.
 * @returns The provider, with {@link PanelDataProvider.resolveEvent},
 * {@link PanelDataProvider.rejectAllPending} and
 * {@link PanelDataProvider.pendingCount} beside `query`.
 */
export function createPanelDataProvider(options: PanelDataProviderOptions): PanelDataProvider {
  const { request, getSessionId, getCaptureId, canServeCached, isSessionEnded, onPortDisconnect } =
    options;
  const logger = options.logger ?? noopLogger;
  const timeoutMs = usableTimeout(options.timeoutMs, PANEL_DATA_REQUEST_TIMEOUT_MS);

  // Per provider rather than per module, so two providers — two panel
  // documents' worth in one test — share no requests, no cached trace and no
  // subscription. Keyed by `panelDataRequestKey`; an entry is removed the
  // moment it settles.
  const inFlight = new Map<string, SharedRequest>();
  const traceCache = createTraceCache(EVENT_TRACE_CACHE_MAX_TRACES, EVENT_TRACE_CACHE_MAX_EVENTS);
  // The capture the provider last read from the store. Reading any other one
  // drops the live-scoped traces, so no live entry outlives the capture it was
  // read from; panel-scoped traces stay, because their panel fixes their
  // capture.
  let observedCapture: CaptureId | undefined;
  // The panel the last panel-bound lookup named. A lookup naming another one
  // drops the traces of every other panel: the drawer reads one rendered panel
  // at a time, so those entries could only crowd out the current panel's.
  let observedPanel: string | undefined;
  let unsubscribeDisconnect: (() => void) | undefined;

  function rejectAllPending(error?: DebuggenError): number {
    const loss =
      error === undefined ? undefined : DebuggenError.from(error, 'TRANSPORT_DISCONNECTED');
    // A copy: each settlement removes its own entry while this loop runs.
    const requests = [...inFlight.values()];
    for (const shared of requests) {
      fail(shared, disconnectedError(shared.context, loss), true);
    }
    // Every cached trace was authorised over the port that is gone; the next
    // lookup asks the service again, over whatever port replaces it.
    clearTraceCache('port-lost');
    return requests.length;
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

  // The port-loss subscription exists only while a query is in flight or the
  // trace cache holds an entry, so a provider that React builds and discards
  // (StrictMode's double invoke of `useMemo`) leaves no listener behind in the
  // connection module.
  function syncDisconnectWatch(): void {
    if (inFlight.size > 0 || traceCache.size() > 0) {
      watchDisconnect();
    } else {
      unwatchDisconnect();
    }
  }

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

  /**
   * Empty the trace cache, and drop the port-loss subscription when nothing
   * else holds it. Logged with a fixed reason word only.
   */
  function clearTraceCache(reason: 'port-lost' | 'not-authorised'): void {
    if (traceCache.size() === 0) {
      return;
    }
    traceCache.clear();
    logger.debug("Emptied the event drawer's trace cache.", { reason });
    syncDisconnectWatch();
  }

  /**
   * Drop the cached traces whose evidence no lookup can use any more — the
   * live ones once the store shows another capture, another panel's once a
   * lookup names a new one — and drop the port-loss subscription when nothing
   * else holds it. Logged with a fixed reason word and the count only, never
   * an id.
   */
  function evictTraces(
    reason: 'capture-changed' | 'panel-changed',
    unusable: (entry: CachedTrace) => boolean,
  ): void {
    const count = traceCache.evict(unusable);
    if (count === 0) {
      return;
    }
    logger.debug('Dropped cached traces the event drawer can no longer use.', { reason, count });
    syncDisconnectWatch();
  }

  /**
   * Claim a shared request's one settlement: stop its timer, take it out of
   * the registry — dropping the port-loss subscription with the last entry,
   * unless cached traces still hold it — and hand back the callers it still
   * had, each with its abort listener detached.
   *
   * @returns The callers to settle, or `undefined` when the request had
   * already settled (so a second outcome is dropped).
   */
  function settle(shared: SharedRequest): readonly Subscriber[] | undefined {
    if (shared.settled) {
      return undefined;
    }
    shared.settled = true;
    if (shared.timer !== undefined) {
      globalThis.clearTimeout(shared.timer);
      shared.timer = undefined;
    }
    if (inFlight.get(shared.key) === shared) {
      inFlight.delete(shared.key);
      syncDisconnectWatch();
    }
    const waiting = [...shared.subscribers];
    shared.subscribers.clear();
    for (const subscriber of waiting) {
      subscriber.detach();
    }
    return waiting;
  }

  /**
   * Reject every caller of a shared request with one typed error.
   *
   * @param abortRequest Whether the underlying request is still outstanding
   * and must be aborted — a timeout or port loss — rather than one that has
   * itself just failed. Its rejection after the abort finds the request
   * settled and is dropped.
   */
  function fail(shared: SharedRequest, error: DebuggenError, abortRequest: boolean): void {
    const waiting = settle(shared);
    if (waiting === undefined) {
      return;
    }
    if (abortRequest) {
      shared.controller.abort(error);
    }
    for (const subscriber of waiting) {
      subscriber.reject(error);
    }
  }

  /**
   * One caller leaves a shared request (its signal fired). The others keep
   * waiting; when it was the last one, the request is abandoned: settled,
   * forgotten and aborted, so a late answer is dropped.
   */
  function leave(shared: SharedRequest, subscriber: Subscriber, reason: unknown): void {
    if (!shared.subscribers.delete(subscriber)) {
      return;
    }
    subscriber.detach();
    if (shared.subscribers.size > 0 || settle(shared) === undefined) {
      return;
    }
    shared.controller.abort(abortedError(shared.context, reason));
    logger.debug('Cancelled a panel-data request that no caller is waiting for any more.', {
      source: shared.context.source,
    });
  }

  /**
   * Open and register a shared request, with its controller and its timeout.
   * Nothing is sent yet: the first caller subscribes before {@link send}, so a
   * request function that fails at once still has someone to reject.
   */
  function open(key: string, context: QueryContext): SharedRequest {
    const shared: SharedRequest = {
      key,
      context,
      controller: new AbortController(),
      subscribers: new Set(),
      timer: undefined,
      settled: false,
    };
    inFlight.set(key, shared);
    watchDisconnect();
    shared.timer = globalThis.setTimeout(() => {
      fail(shared, timeoutError(context, timeoutMs), true);
    }, timeoutMs);
    return shared;
  }

  /** Send a freshly opened shared request's one `panelData.query` port request. */
  function send(shared: SharedRequest, sessionId: SessionId, query: PanelDataRequest): void {
    let sent: Promise<PanelDataQueryAnswer>;
    try {
      sent = Promise.resolve(
        request(
          PANEL_DATA_QUERY_KIND,
          { sessionId, query },
          { signal: shared.controller.signal, timeoutMs },
        ),
      );
    } catch (cause) {
      // `panelRequest` never throws; an injected function that does is
      // reported like any other failed request, never as an exception.
      fail(shared, requestFailedError(shared.context, cause), false);
      return;
    }

    sent.then(
      (value) => {
        const waiting = settle(shared);
        if (waiting === undefined) {
          logger.debug('Dropped a panel-data answer that arrived after its request settled.', {
            source: shared.context.source,
          });
          return;
        }
        for (const subscriber of waiting) {
          subscriber.resolve(value);
        }
      },
      (cause: unknown) => {
        fail(shared, requestFailedError(shared.context, cause), false);
      },
    );
  }

  /**
   * Join a shared request as one caller, honouring that caller's own signal:
   * its abort rejects this caller alone, with the aborted failure, and leaves
   * the request to whoever else is waiting on it.
   */
  function subscribe(
    shared: SharedRequest,
    signal: AbortSignal | undefined,
  ): Promise<PanelDataQueryAnswer> {
    return new Promise<PanelDataQueryAnswer>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const subscriber: Subscriber = {
        resolve,
        reject,
        detach: () => {
          if (onAbort !== undefined) {
            signal?.removeEventListener('abort', onAbort);
            onAbort = undefined;
          }
        },
      };
      shared.subscribers.add(subscriber);
      if (signal === undefined) {
        return;
      }
      onAbort = (): void => {
        const reason: unknown = signal.reason;
        leave(shared, subscriber, reason);
        reject(abortedError(shared.context, reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * The session a call is addressed to: its own argument, once the guard has
   * passed. Throws (inside the async `query`, so as a rejection) otherwise.
   */
  function resolveSession(sessionId: unknown, source: DataQuerySource): SessionId {
    if (!isAddressable(sessionId)) {
      throw unboundError(source);
    }
    // A store that cannot answer proves nothing about which session is on
    // screen; the specification's own session is routed, and the worker and
    // service still authorise it against the tab's binding.
    const shown = readShownSession(
      'Reading the panel session failed; routing by the panel specification.',
    );
    if (isAddressable(shown) && shown !== sessionId) {
      throw foreignSessionError(source);
    }
    if (sessionEnded(sessionId)) {
      throw endedSessionError(source);
    }
    return sessionId;
  }

  /**
   * Whether the injected `isSessionEnded` answers exactly `true` for
   * `sessionId`; a missing predicate, any other answer or a throw (logged with
   * the error's name only) is `false`, and the query is sent.
   */
  function sessionEnded(sessionId: SessionId): boolean {
    if (isSessionEnded === undefined) {
      return false;
    }
    try {
      return isSessionEnded(sessionId) === true;
    } catch (cause) {
      logger.warn('Reading whether the panel session ended failed; sending the query.', {
        error: errorName(cause),
      });
      return false;
    }
  }

  /**
   * `getSessionId()`, or `undefined` — after logging `failureMessage` with the
   * error's name only — when the getter throws.
   */
  function readShownSession(failureMessage: string): SessionId | undefined {
    try {
      return getSessionId();
    } catch (cause) {
      logger.warn(failureMessage, { error: errorName(cause) });
      return undefined;
    }
  }

  /**
   * The capture the panel's store shows right now, or `undefined` when it is
   * unknown: no getter was injected, it answered a blank or non-string value,
   * or it threw (logged with the error's name only). Reading a capture other
   * than the one last read drops every live-scoped trace from the cache; the
   * traces of panel-bound lookups stay, since each panel's id fixes the
   * capture it is answered from.
   */
  function readCurrentCapture(): CaptureId | undefined {
    let candidate: unknown;
    try {
      candidate = getCaptureId?.();
    } catch (cause) {
      logger.warn('Reading the panel capture failed; treating the capture as unknown.', {
        error: errorName(cause),
      });
      candidate = undefined;
    }
    const captureId = isFilledString(candidate) ? candidate : undefined;
    if (captureId !== observedCapture) {
      observedCapture = captureId;
      evictTraces('capture-changed', (entry) => entry.scope.kind === 'live');
    }
    return captureId;
  }

  /**
   * Record that a lookup is bound to `panelId`. When it names a panel other
   * than the last panel-bound lookup did, the cached traces of every other
   * panel are dropped; live-scoped traces are left to the capture rule.
   */
  function observePanel(panelId: string): void {
    if (panelId === observedPanel) {
      return;
    }
    observedPanel = panelId;
    evictTraces(
      'panel-changed',
      (entry) => entry.scope.kind === 'panel' && entry.scope.panelId !== panelId,
    );
  }

  /**
   * The evidence scope of one lookup: its panel, when it is bound to one
   * (recorded through {@link observePanel}), otherwise the capture the store
   * shows as it starts — or `undefined` when that capture is unknown, in which
   * case the lookup neither reads nor writes the cache.
   */
  function lookupScope(panelId: string | undefined): EvidenceScope | undefined {
    if (panelId !== undefined) {
      observePanel(panelId);
      return { kind: 'panel', panelId };
    }
    const captureId = readCurrentCapture();
    return captureId === undefined ? undefined : { kind: 'live', captureId };
  }

  /**
   * Whether the injected `canServeCached` exists and answers exactly `true`
   * for `sessionId`. Absent, answering anything else or throwing (logged with
   * the error's name only), the answer is `false`: the cache fails closed.
   */
  function cacheAuthorised(sessionId: SessionId): boolean {
    if (canServeCached === undefined) {
      return false;
    }
    try {
      return canServeCached(sessionId) === true;
    } catch (cause) {
      logger.warn("Checking the trace cache's authorisation failed; asking the service instead.", {
        error: errorName(cause),
      });
      return false;
    }
  }

  /**
   * Whether the trace cache may be read or written right now for one lookup's
   * session and evidence scope — the fail-closed rule of
   * {@link PanelDataProviderOptions.canServeCached}, evaluated at every access
   * and never remembered:
   *
   * 1. for a live scope, its capture is still the store's current capture
   *    (reading another one has already dropped the live entries); a panel
   *    scope needs no such check, because its panel's id fixes its capture;
   * 2. `getSessionId()` returns exactly the lookup's session — `undefined`
   *    included, a store showing no session authorises nothing; and
   * 3. `canServeCached` answers `true` for it.
   *
   * A failure of 2 or 3 empties the whole cache, so what was cached under an
   * authorisation that has since lapsed is gone rather than merely skipped.
   */
  function traceCacheUsable(sessionId: SessionId, scope: EvidenceScope): boolean {
    if (scope.kind === 'live' && readCurrentCapture() !== scope.captureId) {
      return false;
    }
    const shown = readShownSession(
      "Reading the panel session failed; the event drawer's trace cache is not consulted.",
    );
    if (shown === sessionId && cacheAuthorised(sessionId)) {
      return true;
    }
    clearTraceCache('not-authorised');
    return false;
  }

  /**
   * The trace cache as one lookup sees it: scoped to the lookup's session and
   * evidence scope, and authorised by {@link traceCacheUsable} at every read
   * and every write, so a lookup that outlives its authorisation or its live
   * capture neither reads nor records anything more. With no scope — a live
   * lookup under an unknown capture — it reads and records nothing at all.
   */
  function scopedTraceCache(
    sessionId: SessionId,
    scope: EvidenceScope | undefined,
  ): ScopedTraceCache {
    return {
      lookup(eventId, traceId) {
        if (scope === undefined || !traceCacheUsable(sessionId, scope)) {
          return undefined;
        }
        return traceCache.lookup(sessionId, scope, eventId, traceId);
      },
      write(traceId, pool) {
        if (scope === undefined || !traceCacheUsable(sessionId, scope)) {
          return;
        }
        traceCache.write(sessionId, scope, traceId, pool);
        syncDisconnectWatch();
      },
    };
  }

  /**
   * The panel a call is bound to: `undefined` for a live read, else the
   * caller's `panelId`, once it has been checked. Throws (inside the async
   * `query`, so as a rejection) for a present value that cannot name a panel.
   */
  function resolvePanelId(panelId: unknown, source: DataQuerySource): string | undefined {
    if (panelId === undefined) {
      return undefined;
    }
    if (typeof panelId !== 'string' || panelId.trim() === '') {
      throw unusablePanelError(source, panelId);
    }
    return panelId;
  }

  async function query<Source extends DataQuerySource>(
    sessionId: string,
    dataQuery: DataQuery & { source: Source },
    queryOptions?: DataQueryOptions,
  ): Promise<DataQueryResponse<Source>> {
    const source = dataQuery.source;
    const session = resolveSession(sessionId, source);
    const panelId = resolvePanelId(queryOptions?.panelId, source);
    const normalised = normalizePanelDataQuery(dataQuery);
    const context: QueryContext = { source, limit: normalised.limit, offset: normalised.offset };
    // The route's body: the node's query, plus the panel it belongs to for a
    // panel-bound read. A live read carries no `panelId` key at all, and the
    // coalescing key below is computed over this body, so it scopes by panel.
    const sent: PanelDataRequest = panelId === undefined ? normalised : { ...normalised, panelId };

    const signal = queryOptions?.signal;
    if (signal?.aborted === true) {
      const reason: unknown = signal.reason;
      throw abortedError(context, reason);
    }

    // Join the identical request already in flight under the same capture, or
    // open one. The caller subscribes before anything is sent, so a request
    // function that fails at once still has this caller to reject.
    const key = panelDataRequestKey(session, readCurrentCapture(), sent);
    const joined = inFlight.get(key);
    const shared = joined ?? open(key, context);
    const pendingAnswer = subscribe(shared, signal);
    if (joined === undefined) {
      send(shared, session, sent);
    } else {
      logger.debug('Joined an identical panel-data request already in flight.', { source });
    }

    const answer = await pendingAnswer;
    // The renderer's wire-to-view translation, with this caller's own query:
    // the source-named payload becomes `data`, the page echo is carried
    // across as it arrived, and an answer for another source (or with a
    // malformed payload or echo) is refused. It returns the typed view, so no
    // cast is needed here.
    const mapped = mapPanelDataResult(dataQuery, answer);
    if (!mapped.ok) {
      logger.warn('Refused a panel-data answer that does not match its query.', {
        source,
        code: mapped.error.code,
      });
      throw mapped.error;
    }
    return mapped.value;
  }

  async function resolveEvent(
    sessionId: SessionId | undefined,
    target: PanelEventTarget,
    resolveOptions?: PanelEventResolveOptions,
  ): Promise<PanelEventResolution> {
    // The same guards every page applies, run first so a cache hit can never
    // answer for a session this panel is not showing, nor turn a lookup whose
    // panel identity is unusable into a live one.
    const session = resolveSession(sessionId, 'events');
    const panelId = resolvePanelId(resolveOptions?.panelId, 'events');
    if (!isFilledString(target.eventId)) {
      throw unidentifiedEventError();
    }
    const signal = resolveOptions?.signal;
    throwIfAborted(signal, DATA_QUERY_DEFAULT_OFFSET);

    // The lookup's evidence scope: its panel, or the capture the store shows
    // as it starts. A live scope's cache reads and writes stop the moment the
    // store shows another capture; a panel scope's hold for that panel.
    const cache = scopedTraceCache(session, lookupScope(panelId));
    // Both passes page through here, so every page — find and ancestry alike —
    // is sent with the lookup's panel, and a live lookup's with none.
    const page: EventPageQuery = (eventsQuery, pageSignal) =>
      query(session, eventsQuery, { signal: pageSignal, panelId });
    const resume: LookupResume = {
      from: normalizePanelDataOffset(resolveOptions?.resumeFrom),
      ancestry: resolveOptions?.resumeAncestry,
    };
    const resolution = await resolveStoredEvent({ page, cache, logger }, target, resume, signal);
    // An abort that landed after the last page settled still rejects: an
    // aborted call is never resolved.
    throwIfAborted(signal, DATA_QUERY_DEFAULT_OFFSET);
    return resolution;
  }

  return {
    query,
    resolveEvent,
    rejectAllPending,
    pendingCount(): number {
      return inFlight.size;
    },
  };
}

/*
 * ===========================================================================
 * Section F — the drawer's event resolution
 *
 * Module-level, and handed the provider's own `query` as its only way to read
 * the capture: every page is a guarded, coalesced, time-bounded request like
 * any node's, and nothing here sends anything itself.
 * ===========================================================================
 */

/**
 * One `events` page request: the provider's own `query`, bound to the lookup's
 * session and to its panel, when it has one.
 */
type EventPageQuery = (
  eventsQuery: DataQuery & { source: 'events' },
  signal: AbortSignal | undefined,
) => Promise<DataQueryResponse<'events'>>;

/** An event held by the trace cache, with the pool its complete chain is built from. */
interface CachedEvent {
  readonly event: TelemetryEvent;
  readonly pool: readonly TelemetryEvent[];
}

/**
 * One cached trace: the session and evidence scope it belongs to, and its
 * collected stored events.
 */
interface CachedTrace {
  readonly sessionId: SessionId;
  readonly scope: EvidenceScope;
  readonly pool: readonly TelemetryEvent[];
}

/**
 * The drawer's bounded, least-recently-used cache of stored trace pools, keyed
 * by session, evidence scope and trace. Pure storage: whether it may be read
 * or written at all is the provider's decision (see `scopedTraceCache`).
 */
interface TraceCache {
  /**
   * The cached event with `eventId` of `sessionId`'s evidence `scope` —
   * within `traceId`'s pool when the trace is known, otherwise within any pool
   * of that same session and scope — but only when that pool also holds the
   * event's complete parent chain. A hit becomes the most recently used entry.
   */
  lookup(
    sessionId: SessionId,
    scope: EvidenceScope,
    eventId: string,
    traceId: string | undefined,
  ): CachedEvent | undefined;
  /**
   * Hold `pool` as the trace's collected events within `sessionId`'s evidence
   * `scope`, replacing any earlier pool of that trace in that scope, then
   * evict least recently used traces until both bounds hold. An empty pool, or
   * one larger than the event bound, is not held.
   */
  write(
    sessionId: SessionId,
    scope: EvidenceScope,
    traceId: string,
    pool: readonly TelemetryEvent[],
  ): void;
  /**
   * Forget every trace for which `unusable` answers `true`.
   *
   * @returns How many traces were forgotten.
   */
  evict(unusable: (entry: CachedTrace) => boolean): number;
  /** How many traces are held. */
  size(): number;
  /** Forget every trace. */
  clear(): void;
}

/**
 * The trace cache as one lookup sees it: its session and evidence scope are
 * fixed, and every read and write is authorised afresh by the provider — an
 * unauthorised read misses, and an unauthorised write records nothing.
 */
interface ScopedTraceCache {
  /** See {@link TraceCache.lookup}, within the lookup's session and evidence scope. */
  lookup(eventId: string, traceId: string | undefined): CachedEvent | undefined;
  /** See {@link TraceCache.write}, within the lookup's session and evidence scope. */
  write(traceId: string, pool: readonly TelemetryEvent[]): void;
}

/**
 * Build a {@link TraceCache} bounded by trace count and by total events.
 *
 * A `Map`'s iteration order is its insertion order, and every hit or write
 * re-inserts its entry, so the first entry is always the least recently used
 * one and eviction walks from the front.
 *
 * @param maxTraces The most traces held.
 * @param maxEvents The most events held across all traces.
 */
function createTraceCache(maxTraces: number, maxEvents: number): TraceCache {
  const entries = new Map<string, CachedTrace>();
  let held = 0;

  function touch(key: string, entry: CachedTrace): void {
    entries.delete(key);
    entries.set(key, entry);
  }

  function completeHit(entry: CachedTrace, eventId: string): CachedEvent | undefined {
    const event = entry.pool.find((candidate) => candidate.id === eventId);
    if (event === undefined || buildEventParentChain(event, entry.pool) === undefined) {
      return undefined;
    }
    return { event, pool: entry.pool };
  }

  return {
    lookup(sessionId, scope, eventId, traceId) {
      if (traceId !== undefined) {
        const key = traceCacheKey(sessionId, scope, traceId);
        const entry = entries.get(key);
        const hit = entry === undefined ? undefined : completeHit(entry, eventId);
        if (entry !== undefined && hit !== undefined) {
          touch(key, entry);
        }
        return hit;
      }
      // A traceless walk: only pools of the lookup's own session and evidence
      // scope may answer, so a live lookup never borrows a panel's trace, nor
      // one panel another's.
      for (const [key, entry] of entries) {
        if (entry.sessionId !== sessionId || !sameEvidenceScope(entry.scope, scope)) {
          continue;
        }
        const hit = completeHit(entry, eventId);
        if (hit !== undefined) {
          // Returning at once, so re-inserting during the walk is safe.
          touch(key, entry);
          return hit;
        }
      }
      return undefined;
    },

    write(sessionId, scope, traceId, pool) {
      const key = traceCacheKey(sessionId, scope, traceId);
      const previous = entries.get(key);
      if (previous !== undefined) {
        entries.delete(key);
        held -= previous.pool.length;
      }
      if (pool.length === 0 || pool.length > maxEvents) {
        return;
      }
      entries.set(key, { sessionId, scope, pool });
      held += pool.length;
      for (const [staleKey, stale] of entries) {
        if (entries.size <= maxTraces && held <= maxEvents) {
          break;
        }
        entries.delete(staleKey);
        held -= stale.pool.length;
      }
    },

    evict(unusable) {
      let evicted = 0;
      // Deleting the entry just visited is safe during a `Map` walk.
      for (const [key, entry] of entries) {
        if (unusable(entry)) {
          entries.delete(key);
          held -= entry.pool.length;
          evicted += 1;
        }
      }
      return evicted;
    },

    size() {
      return entries.size;
    },

    clear() {
      entries.clear();
      held = 0;
    },
  };
}

/** What {@link resolveStoredEvent} is handed by the provider. */
interface EventResolutionDeps {
  readonly page: EventPageQuery;
  readonly cache: ScopedTraceCache;
  readonly logger: Logger;
}

/** Where one lookup resumes the passes an earlier lookup stopped at their budget. */
interface LookupResume {
  /** The find pass's first offset: {@link DATA_QUERY_DEFAULT_OFFSET} unless resumed. */
  readonly from: number;
  /** The ancestry pass to continue, when one is. */
  readonly ancestry: PanelAncestryResume | undefined;
}

/** Pages one lookup has requested so far, across its passes: its `pagesRead`. */
interface PageCount {
  used: number;
}

/** What one trace-filtered pass is asked to do. */
interface TraceScanRequest {
  /** The trace to page, as `filter: { traceId }`. */
  readonly traceId: string;
  /** The target event. */
  readonly eventId: string;
  /** The target event, when an earlier pass already holds it. */
  readonly known: TelemetryEvent | undefined;
  /** Events of this trace an earlier pass already collected. */
  readonly seed: readonly TelemetryEvent[];
  /** The first offset of the trace to read. */
  readonly from: number;
  /**
   * When the pass is done: a **find** pass stops on the page where the target
   * event is first collected (earlier, never later, than its chain); an
   * **ancestry** pass stops once the event's complete chain is collected.
   * Either stops at the trace's last page or at its own page budget.
   */
  readonly stopWhen: 'event-found' | 'chain-complete';
}

/** What one trace-filtered pass collected, and where it stopped. */
type TraceScan = {
  /** The trace's stored events collected, each once, in first-seen order. */
  readonly pool: readonly TelemetryEvent[];
  /** The target event, when collected (or already known). */
  readonly event: TelemetryEvent | undefined;
  /** Whether `pool` holds the event's complete parent chain. */
  readonly chainComplete: boolean;
  /** How many stored events this pass's pages held. */
  readonly eventsRead: number;
} & (
  | {
      /** The pass stopped at its page budget; the trace continues at `nextOffset`. */
      readonly budgetExhausted: true;
      readonly nextOffset: number;
    }
  | {
      /** The pass stopped because it was done, or the trace ended. */
      readonly budgetExhausted: false;
      /** The first offset the pass did not read; `undefined` when it read the trace's last page. */
      readonly nextOffset: number | undefined;
    }
);

/** Whether a value is a string with at least one non-whitespace character. */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Reject a lookup whose signal fired, with the aborted failure a `query` for
 * the page at `offset` would have rejected with.
 */
function throwIfAborted(signal: AbortSignal | undefined, offset: number): void {
  if (signal?.aborted === true) {
    const reason: unknown = signal.reason;
    throw abortedError({ source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset }, reason);
  }
}

/**
 * The offset of the page after `response`, or `undefined` when it was the
 * last. A `nextOffset` that does not advance past `offset` is read as the end,
 * so every paging loop here terminates whatever the service answers.
 */
function followingOffset(
  response: DataQueryResponse<'events'>,
  offset: number,
): number | undefined {
  const next = response.nextOffset;
  return typeof next === 'number' && next > offset ? next : undefined;
}

/**
 * One trace-filtered pass: page the trace from `request.from` until the pass
 * is done (see {@link TraceScanRequest.stopWhen}), the trace's pages end, or
 * the pass's own {@link EVENT_RESOLUTION_PAGE_BUDGET} is spent.
 *
 * @param deps The provider's page request.
 * @param request The trace, the target, what is already held, where to start
 * and when to stop.
 * @param count The lookup's pages so far; incremented per page requested.
 * @param signal The lookup's abort signal, checked before every page.
 */
async function scanTrace(
  deps: EventResolutionDeps,
  request: TraceScanRequest,
  count: PageCount,
  signal: AbortSignal | undefined,
): Promise<TraceScan> {
  const { traceId, eventId, stopWhen } = request;
  // Keyed by event id: a capture growing while it is paged can shift an event
  // across a page boundary, and the pool must hold it once.
  const collected = new Map<string, TelemetryEvent>();
  const collect = (candidate: TelemetryEvent): void => {
    if (candidate.traceId === traceId && !collected.has(candidate.id)) {
      collected.set(candidate.id, candidate);
    }
  };
  request.seed.forEach(collect);
  if (request.known !== undefined) {
    collect(request.known);
  }

  let event = request.known ?? collected.get(eventId);
  let offset = request.from;
  let eventsRead = 0;
  for (let pages = 0; pages < EVENT_RESOLUTION_PAGE_BUDGET; pages += 1) {
    throwIfAborted(signal, offset);
    count.used += 1;
    const response = await deps.page(
      { source: 'events', filter: { traceId }, limit: DATA_QUERY_MAX_LIMIT, offset },
      signal,
    );
    eventsRead += response.data.length;
    response.data.forEach(collect);
    event ??= collected.get(eventId);
    const pool = [...collected.values()];
    const chainComplete = event !== undefined && buildEventParentChain(event, pool) !== undefined;
    const next = followingOffset(response, offset);
    const done = chainComplete || (stopWhen === 'event-found' && event !== undefined);
    if (done || next === undefined) {
      return { pool, event, chainComplete, eventsRead, budgetExhausted: false, nextOffset: next };
    }
    offset = next;
  }
  return {
    pool: [...collected.values()],
    event,
    chainComplete: false,
    eventsRead,
    budgetExhausted: true,
    nextOffset: offset,
  };
}

/**
 * Turn a finished pass that holds the event into the lookup's `found` answer,
 * caching the pool; a pass that stopped at its budget is reported with the
 * offset a continuation resumes at.
 */
function concludeTraceScan(
  deps: EventResolutionDeps,
  traceId: string,
  scan: TraceScan,
  count: PageCount,
): PanelEventResolution {
  if (scan.event === undefined) {
    // Unreachable from the callers — an ancestry pass always starts from a
    // known event, and a find pass without it is concluded by its caller —
    // and answered truthfully rather than asserted: the pages read held no
    // such event.
    return { status: 'not-found', pagesRead: count.used };
  }
  deps.cache.write(traceId, scan.pool);
  const found = {
    status: 'found',
    event: scan.event,
    trace: scan.pool,
    chainComplete: scan.chainComplete,
    pagesRead: count.used,
  } as const;
  if (!scan.budgetExhausted) {
    return { ...found, budgetExhausted: false };
  }
  deps.logger.debug('Stopped an event lookup at its page budget.', {
    pagesRead: count.used,
    budget: EVENT_RESOLUTION_PAGE_BUDGET,
    pass: 'ancestry',
  });
  return { ...found, budgetExhausted: true, ancestryResumeOffset: scan.nextOffset };
}

/** A find pass that stopped at its budget, as the lookup's answer. */
function exhaustedResolution(
  deps: EventResolutionDeps,
  scope: 'capture' | 'trace',
  searchedFrom: number,
  resumeOffset: number,
  eventsSearched: number,
  count: PageCount,
): PanelEventResolution {
  deps.logger.debug('Stopped an event lookup at its page budget.', {
    pagesRead: count.used,
    budget: EVENT_RESOLUTION_PAGE_BUDGET,
    pass: 'find',
    traceKnown: scope === 'trace',
  });
  return {
    status: 'budget-exhausted',
    scope,
    searchedFrom,
    resumeOffset,
    eventsSearched,
    pagesRead: count.used,
  };
}

/** A cache hit, as the lookup's answer. */
function cachedResolution(hit: CachedEvent, count: PageCount): PanelEventResolution {
  return {
    status: 'found',
    event: hit.event,
    trace: hit.pool,
    chainComplete: true,
    budgetExhausted: false,
    pagesRead: count.used,
  };
}

/**
 * The ancestry pass `resume` asks to continue, when it can be: its `trace`
 * holds the target event, of the target's trace when that is known. The
 * offset is normalised like a query's.
 */
function ancestryContinuation(
  resume: PanelAncestryResume | undefined,
  eventId: string,
  traceId: string | undefined,
):
  | {
      readonly event: TelemetryEvent;
      readonly seed: readonly TelemetryEvent[];
      readonly from: number;
    }
  | undefined {
  if (resume === undefined) {
    return undefined;
  }
  const seed = resume.trace;
  const event = seed.find((candidate) => candidate.id === eventId);
  if (event === undefined || (traceId !== undefined && event.traceId !== traceId)) {
    return undefined;
  }
  return { event, seed, from: normalizePanelDataOffset(resume.from) };
}

/**
 * The trace-known lookup: a find pass over the trace from `from`, then —
 * when the event turned up without its whole chain — an ancestry pass over
 * the same trace with a budget of its own.
 */
async function resolveWithinTrace(
  deps: EventResolutionDeps,
  traceId: string,
  eventId: string,
  from: number,
  count: PageCount,
  signal: AbortSignal | undefined,
): Promise<PanelEventResolution> {
  const find = await scanTrace(
    deps,
    { traceId, eventId, known: undefined, seed: [], from, stopWhen: 'event-found' },
    count,
    signal,
  );
  if (find.event === undefined) {
    return find.budgetExhausted
      ? exhaustedResolution(deps, 'trace', from, find.nextOffset, find.eventsRead, count)
      : { status: 'not-found', pagesRead: count.used };
  }
  if (find.chainComplete) {
    return concludeTraceScan(deps, traceId, find, count);
  }
  // A find pass that read the trace from its start holds every event before
  // the one it found, so the ancestry pass continues after it — and when the
  // trace ended there, every stored ancestor has been read. A resumed find
  // pass skipped the trace's start, where ancestors may lie, so the ancestry
  // pass reads the trace from its first event.
  const ancestryFrom =
    from === DATA_QUERY_DEFAULT_OFFSET ? find.nextOffset : DATA_QUERY_DEFAULT_OFFSET;
  if (ancestryFrom === undefined) {
    return concludeTraceScan(deps, traceId, find, count);
  }
  const ancestry = await scanTrace(
    deps,
    {
      traceId,
      eventId,
      known: find.event,
      seed: find.pool,
      from: ancestryFrom,
      stopWhen: 'chain-complete',
    },
    count,
    signal,
  );
  return concludeTraceScan(deps, traceId, ancestry, count);
}

/**
 * The trace-unknown lookup: a find pass over the whole capture from `from`;
 * once the event turns up, unless the page it was found on already completes
 * its chain, an ancestry pass over its trace, from the trace's first event,
 * with a budget of its own.
 */
async function resolveAcrossCapture(
  deps: EventResolutionDeps,
  eventId: string,
  from: number,
  count: PageCount,
  signal: AbortSignal | undefined,
): Promise<PanelEventResolution> {
  let offset = from;
  let eventsRead = 0;
  for (let pages = 0; pages < EVENT_RESOLUTION_PAGE_BUDGET; pages += 1) {
    throwIfAborted(signal, offset);
    count.used += 1;
    const response = await deps.page(
      { source: 'events', limit: DATA_QUERY_MAX_LIMIT, offset },
      signal,
    );
    eventsRead += response.data.length;
    const found = response.data.find((candidate) => candidate.id === eventId);
    if (found !== undefined) {
      const foundTrace = found.traceId;
      const hit = deps.cache.lookup(eventId, foundTrace);
      if (hit !== undefined) {
        return cachedResolution(hit, count);
      }
      // The page it was found on often holds its whole ancestry already — a
      // trace's events lie close together in a capture — and only when it does
      // not is the trace paged for the rest.
      const seed = response.data.filter((candidate) => candidate.traceId === foundTrace);
      if (buildEventParentChain(found, seed) !== undefined) {
        deps.cache.write(foundTrace, seed);
        return {
          status: 'found',
          event: found,
          trace: seed,
          chainComplete: true,
          budgetExhausted: false,
          pagesRead: count.used,
        };
      }
      const ancestry = await scanTrace(
        deps,
        {
          traceId: foundTrace,
          eventId,
          known: found,
          seed,
          from: DATA_QUERY_DEFAULT_OFFSET,
          stopWhen: 'chain-complete',
        },
        count,
        signal,
      );
      return concludeTraceScan(deps, foundTrace, ancestry, count);
    }
    const next = followingOffset(response, offset);
    if (next === undefined) {
      return { status: 'not-found', pagesRead: count.used };
    }
    offset = next;
  }
  return exhaustedResolution(deps, 'capture', from, offset, eventsRead, count);
}

/**
 * The lookup behind {@link PanelDataProvider.resolveEvent}; see its
 * documentation for the passes, the budgets, resumption and the cache rule.
 *
 * @param deps The provider's page request (bound to the guarded session and
 * the lookup's panel), the trace cache scoped to that session and the lookup's
 * evidence scope, and the logger.
 * @param target The selection; its `eventId` is already known to be filled.
 * @param resume Where the find pass starts, and the ancestry pass to continue.
 * @param signal The lookup's abort signal.
 */
async function resolveStoredEvent(
  deps: EventResolutionDeps,
  target: PanelEventTarget,
  resume: LookupResume,
  signal: AbortSignal | undefined,
): Promise<PanelEventResolution> {
  const { eventId } = target;
  const traceId = isFilledString(target.traceId) ? target.traceId : undefined;
  const count: PageCount = { used: 0 };

  const cached = deps.cache.lookup(eventId, traceId);
  if (cached !== undefined) {
    return cachedResolution(cached, count);
  }

  const continuation = ancestryContinuation(resume.ancestry, eventId, traceId);
  if (continuation !== undefined) {
    const continuedTrace = continuation.event.traceId;
    const scan = await scanTrace(
      deps,
      {
        traceId: continuedTrace,
        eventId,
        known: continuation.event,
        seed: continuation.seed,
        from: continuation.from,
        stopWhen: 'chain-complete',
      },
      count,
      signal,
    );
    return concludeTraceScan(deps, continuedTrace, scan, count);
  }

  return traceId === undefined
    ? resolveAcrossCapture(deps, eventId, resume.from, count, signal)
    : resolveWithinTrace(deps, traceId, eventId, resume.from, count, signal);
}
