/**
 * The request patch: where a browser trace becomes a server trace.
 *
 * A developer clicks something, the click's handler calls `fetch`, and a Next.js
 * route handler runs SQL. Those are three processes and two runtimes, and the
 * only thing that makes them one tree is a `traceparent` header on the request
 * in the middle. Next.js's own tracer *extracts* incoming trace context but
 * cannot create it (AAP 0.1.1), so if this module does not inject the header
 * nobody does: the panel shows a browser half and a server half with no edge
 * between them, and the question "why is this button slow?" cannot be answered
 * past the network boundary.
 *
 * ## What this module does, in the order it happens
 *
 * 1. **Decides which trace the request belongs to**, by asking
 *    `./interaction.ts` once — {@link resolveEventContext} — rather than
 *    keeping an ambient "current trace" of its own.
 * 2. **Injects `traceparent`** carrying a *fresh span id for this request*
 *    while the context is traced and the request is same-origin. That span id
 *    becomes the parent of Next.js's `http.server` span, which is why the
 *    header must not carry the interaction's own span id:
 *    `../correlation/correlator.ts` asserts `interaction ⊃ fetch ⊃
 *    http.server`, and injecting the interaction's id would flatten the fetch
 *    out of the tree.
 * 3. **Records a request span** — one `fetch` or `xhr` event per request, with
 *    the call-site stack as its `initiator` so the service can map it back to
 *    TypeScript through
 *    `packages/code-analysis/src/source-map/{fetch-map,resolver,normalize}.ts`.
 * 4. **Drives the continuation handshake**: the request is registered with
 *    `./continuation.ts` when it starts and settled when it finishes, which is
 *    what lets the React commit that renders the response stay in the
 *    interaction's trace after the interaction window has closed (AAP 0.4.2).
 * 5. **Reports what is still on the wire when a capture ends.** A request
 *    that has not settled by a capture boundary would otherwise leave no
 *    evidence at all, because its later settle belongs to a generation that
 *    has ended and emits nothing. {@link reportInFlightRequests} emits one
 *    in-flight snapshot per such request — the same span, no status code,
 *    span status `unset`, the elapsed time as its duration and
 *    {@link KEY_IN_FLIGHT} set — and `./agent.ts` calls it while the ending
 *    capture is still the one the transport stamps. That is what lets
 *    `../aggregate/requests.ts` show a request as *pending* rather than guess
 *    it from a missing status code.
 *
 * ## The rules this module will not break
 *
 * It patches `window.fetch` and three `XMLHttpRequest.prototype` methods —
 * two of the most heavily used APIs in the developer's own application — so
 * every rule below is about *their* application, not about this product's
 * completeness. A debugging tool that changes the behaviour of the code under
 * investigation is worse than no tool at all.
 *
 * - **Never change application behaviour.** No body is read, nothing is
 *   cloned, no caller-owned object is mutated, no header other than
 *   `traceparent` is added, and no header value is ever read (a request's
 *   `Authorization` must not be observable through this module, so the only
 *   question asked of a header bag is whether it *has* a `traceparent`). A
 *   fulfilled `fetch` resolves with the **same `Response` instance** the
 *   original produced, and a rejected one rejects with the **same** reason: the
 *   settle handlers return and rethrow rather than re-wrapping, so a caller
 *   comparing identity or matching on `error.name` sees exactly what it would
 *   have seen unpatched. Nothing adds an `unhandledrejection` listener, and no
 *   rejection is observed in a way that could mark it handled.
 * - **Never throw.** Every instrumentation step sits in its own `try`/`catch`;
 *   on any internal failure the original function is called with the original
 *   arguments and the failure is counted in {@link getFetchStats}. The page
 *   keeps working even when this module does not.
 * - **Never fail silently.** Counting a contained failure is not reporting it:
 *   a capture that lost its network signal would otherwise be indistinguishable
 *   from one whose page made no requests, and with the requests go the
 *   `traceparent` edges the whole browser-to-server correlation rests on. Every
 *   contained failure therefore also posts a bounded, sanitized `agent.error`
 *   frame through `./transport.ts`'s `reportProducerFailure` (AAP 0.5.5). The
 *   frame names the *step* — `'fetch-plan'`, `'xhr-restore-open'` — and the
 *   thrown value's type, and nothing else: a URL, a header, a body or an error
 *   message is application data, control frames are not redacted at ingest, and
 *   this module's whole reason for not normalising a URL is that the service
 *   redacts it there instead.
 * - **Never inject cross-origin.** A `traceparent` on a third-party request
 *   would ship correlation ids off the developer's machine, so the header goes
 *   only to `location.origin`. The decision is recorded on the event
 *   (`sameOrigin`, `traceparentInjected` and a skip reason) so an uncorrelated
 *   request reads as an explained gap rather than a lost span.
 * - **Never normalise the URL.** `../redaction/request-key.ts` computes
 *   `request_key` at ingest from the **unredacted** URL, and duplicate
 *   detection — the whole evidence base of the duplicate-request
 *   investigation — depends on byte-identical URLs colliding (AAP 0.5.2). The
 *   `url` attribute is therefore the string the caller wrote, verbatim; the
 *   absolute form computed for the origin test is used for that test and for
 *   the event's path-only label, and never emitted in its place. Redaction
 *   happens once, in the service, where `../redaction/url.ts` is deliberately
 *   byte-faithful for the same reason.
 * - **Restore exactly.** {@link detachFetch} puts each original back only if
 *   the current value is still the function this module installed, so a
 *   library that patched over us keeps its patch instead of being silently
 *   uninstalled (AAP 0.5.1 requires the hooks to be *disabled*, and
 *   `tests/e2e/cleanup.spec.ts` requires the restoration to be exact).
 *
 * ## Two transports, one shape
 *
 * `fetch` and `XMLHttpRequest` are instrumented through the same planning and
 * settling helpers, and differ only in how the header is applied and how a
 * settle is observed: a promise's `then(onOk, onErr)` for `fetch`, a
 * `loadend` listener added with `{ once: true }` for XHR — which leaves the
 * application's own `onload` / `onreadystatechange` handlers untouched, since
 * a listener and a handler property are independent registrations. The
 * resulting events differ only in `kind` (`fetch` versus `xhr`), which is what
 * `../schema/kinds.ts` groups as the request kinds and what
 * `../aggregate/requests.ts` reads together.
 *
 * ## Bounds
 *
 * Instrumentation is capped at {@link MAX_IN_FLIGHT} concurrent requests; past
 * the cap a new request is forwarded uninstrumented and counted as skipped,
 * because a page that leaks requests must not be able to leak this module's
 * memory with them. The initiator stack is capped at
 * {@link MAX_INITIATOR_FRAMES} frames and {@link MAX_INITIATOR_CHARS}
 * characters, which is several times the depth the source-map route resolves.
 * Teardown is bounded too: a patch the page refuses to let this module remove
 * is remembered — per prototype, so replacing `XMLHttpRequest` cannot strand
 * one (see {@link xhrPatchRecords}) — and at
 * {@link MAX_XHR_PATCH_RECORDS} outstanding records a further install is
 * refused rather than granted at the cost of forgetting an original.
 * {@link hasFetchResidue} is how `./agent.ts` learns that anything is still
 * outstanding.
 *
 * ## Imports: four page modules and two vocabularies
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this file into the IIFE
 * injected into the developer's page at `document_start` and hard-fails on any
 * input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared/node` or `zod`. The imports below are therefore the whole
 * list and are a constraint rather than a coincidence: ids, transport,
 * interaction and continuation for behaviour, and the two dependency-free
 * schema vocabularies for the kind and attribute-key spellings — type-only, so
 * no vocabulary object reaches the page bundle at runtime.
 * `@opentelemetry/instrumentation-fetch` is deliberately not used: AAP 0.3.2
 * records it as not adopted because this agent owns correlation, and its
 * `ZoneContextManager` dependency does not work with ES2017+ output.
 *
 * Nothing here is done at import time: the patches are installed only by
 * {@link attachFetch}, so importing this module into the service or the Node
 * preload — both of which pull the package in for its schema — touches no
 * global.
 *
 * @see ./interaction.ts for which trace a request joins and why.
 * @see ./continuation.ts for the window a settled request opens.
 * @see ../schema/attributes.ts for the `fetch` / `xhr` attribute vocabulary.
 */

import {
  cancelPendingContinuation,
  registerPendingContinuation,
  settleContinuation,
} from './continuation.js';
import { formatTraceparent, newSpanId } from './ids.js';
import { isTracedContext, resolveEventContext, type EventContext } from './interaction.js';
import { emit, nowEpochMs, reportProducerFailure, type EventDraft } from './transport.js';
import type { FETCH_ATTRIBUTE_KEYS } from '../schema/attributes.js';
import type { TelemetryKind, TelemetryStatus } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Contract constants
 *
 * Exported because each one is part of a contract a sibling module, a
 * document or a test reasons about, not a tuning knob.
 * ---------------------------------------------------------------------------
 */

/**
 * How many stack frames of a request's call site are kept.
 *
 * The frames exist to answer "which component started this request?", and the
 * answer is in the innermost few: `packages/code-analysis`'s source-map route
 * resolves frames in stack order and stops well before this depth, so a deeper
 * capture would cost bytes on every request and buy nothing. Ten leaves room
 * for the hook-inside-effect-inside-component shape that the
 * duplicate-request investigation turns on.
 */
export const MAX_INITIATOR_FRAMES = 10;

/**
 * The hard character ceiling on a captured initiator stack.
 *
 * A frame bound alone is not a size bound: a bundled chunk URL with a cache
 * key can run to hundreds of characters, and ten of them travel in every
 * request event of a capture. This is the ceiling that keeps a batch inside
 * the transport's message budget regardless of how long the host's frames are.
 */
export const MAX_INITIATOR_CHARS = 2048;

/**
 * How many requests may be instrumented concurrently.
 *
 * Each in-flight request holds a small record and, for XHR, an entry in a
 * `WeakMap`; a page with a runaway request loop must not be able to grow that
 * without bound. Past the cap a request is forwarded **uninstrumented** — the
 * application's call is never delayed or altered — and counted in
 * {@link FetchStats.skipped}, so the omission is visible instead of silent.
 *
 * Generous on purpose: a browser caps same-origin HTTP/1.1 connections at six
 * and HTTP/2 multiplexing rarely exceeds a few dozen in-flight requests, so a
 * capture of an ordinary interaction never approaches this number.
 */
export const MAX_IN_FLIGHT = 256;

/**
 * The W3C Trace Context header this module injects.
 *
 * Lower-case, which is both the specification's spelling and the form
 * `Headers` normalises to, so a `has` / `set` pair never disagrees about
 * whether the application already set one.
 */
export const TRACEPARENT_HEADER = 'traceparent';

/*
 * ---------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------
 */

/** The kind of an event produced by the `fetch` patch. */
const FETCH_KIND: TelemetryKind = 'fetch';

/** The kind of an event produced by the `XMLHttpRequest` patch. */
const XHR_KIND: TelemetryKind = 'xhr';

/**
 * One member of `FETCH_ATTRIBUTE_KEYS`, the `fetch` vocabulary.
 *
 * `XHR_ATTRIBUTE_KEYS` mirrors it key for key by that catalog's own
 * statement — both kinds describe a request the page made — so one tuple
 * types every declared key below and the other needs no import. The same
 * idiom, for the same reason, is in `../aggregate/requests.ts`.
 */
type DeclaredRequestKey = (typeof FETCH_ATTRIBUTE_KEYS)[number];

/** The request method, upper-cased: `GET`, `POST`. */
const KEY_METHOD: DeclaredRequestKey = 'http.method';

/** The request URL exactly as the caller wrote it, unredacted. */
const KEY_URL: DeclaredRequestKey = 'url';

/** The response status code, when the request produced one. */
const KEY_STATUS_CODE: DeclaredRequestKey = 'http.status_code';

/** The call-site stack, for the source-map resolution route. */
const KEY_INITIATOR: DeclaredRequestKey = 'initiator';

/** Whether the request went to `location.origin`. */
const KEY_SAME_ORIGIN: DeclaredRequestKey = 'sameOrigin';

/** Whether a `traceparent` header was injected on this request. */
const KEY_TRACEPARENT_INJECTED: DeclaredRequestKey = 'traceparentInjected';

/**
 * Why no `traceparent` was injected, when none was.
 *
 * **Invented here.** `FETCH_ATTRIBUTE_KEYS` declares the boolean
 * `traceparentInjected` but no reason beside it, and the boolean alone cannot
 * distinguish "this request went to Stripe" from "the agent could not rebuild
 * the `Request`" — a distinction a developer staring at a request with no
 * server span needs, and the one AAP 0.4.2 asks for when it requires the skip
 * reason to be visible. Written only when the header was **not** injected, and
 * always one of the short, closed {@link SkipReason} literals, so a consumer
 * can switch on it; `attributes.ts` should adopt it beside the boolean.
 */
const KEY_TRACEPARENT_SKIP_REASON = 'traceparentSkipReason';

/**
 * Present and `true` when the request was aborted by the application.
 *
 * **Invented here.** An abort is not a failure of the application under
 * investigation — a component unmounting mid-request aborts on purpose — so an
 * `error`-status event with no further information would read as a broken
 * request. Written only when the terminal signal was an abort, never as
 * `false`: absence is how this product says "not observed".
 */
const KEY_ABORTED = 'aborted';

/**
 * Present and `true` on an **in-flight snapshot**: the one event
 * {@link reportInFlightRequests} emits for a request that had started and not
 * settled when its capture ended.
 *
 * **Declared** in the `fetch` and `xhr` tuples of `../schema/attributes.ts`,
 * which is why it is typed as a {@link DeclaredRequestKey} like the keys above.
 * Like {@link KEY_ABORTED}, and for the reason that constant states, it is
 * written only as `true`, never as `false`. It is the only thing that makes a
 * request *pending* to a consumer; an absent status code is not, because a
 * network error, an abort and an opaque response all settle without one.
 *
 * `../aggregate/requests.ts` reads it through `REQUEST_IN_FLIGHT_ATTRIBUTE`,
 * typed against the same declaration. This module cannot import that constant
 * — the page bundle must not pull in an aggregate, and
 * `packages/telemetry/esbuild.agent.mjs` audits what the bundle reaches — so
 * `./in-flight-requests.test.ts` additionally pins the emitted key to it.
 */
const KEY_IN_FLIGHT: DeclaredRequestKey = 'inFlight';

/**
 * The span status of an in-flight snapshot.
 *
 * `unset` rather than `ok` or `error`, because neither has happened yet: the
 * request is observed outstanding, and the status a consumer reads must say no
 * more than that.
 */
const IN_FLIGHT_STATUS: TelemetryStatus = 'unset';

/**
 * `Response.type` for a `fetch` that fulfilled: `basic`, `cors`, `opaque`,
 * `opaqueredirect` or `error`.
 *
 * **Invented here.** It is the one cheap property that explains a fulfilled
 * response carrying no status code: an `opaque` (`no-cors`) response reports
 * status `0` by specification, and without this key that looks like a bug in
 * the capture. Read as a plain property — never a body read — and omitted when
 * the host does not expose it.
 */
const KEY_RESPONSE_TYPE = 'response.type';

/**
 * The absolute URL this request appears under in the Resource Timing buffer.
 *
 * **Invented here**, and the identity half of a join rather than a display
 * field. `./perf.ts` observes `PerformanceResourceTiming` — the only place a
 * transferred size is observable at all (AAP 0.6.6) — and its entries are
 * named by the *resolved absolute* URL the browser fetched, while {@link
 * KEY_URL} carries the URL exactly as the application wrote it, which is
 * usually relative. `../aggregate/requests.ts` joins the two by URL and start
 * time, so without this key a request written `fetch("/api/items")` can never
 * be matched to its own resource entry and the bytes it transferred are never
 * attributed to it.
 *
 * Three properties make it safe to add:
 *
 * - **It is redacted exactly like `url`.** `../redaction/url.ts` recognises
 *   any attribute whose name ends in `Url`, so the query values are masked by
 *   the same handler, with no preview truncation — which is what makes the
 *   masked form here byte-identical to the masked form of the resource entry's
 *   own `url` for the same raw URL, and therefore a usable key.
 * - **It is never a grouping or hashing input.** `request_key` is computed at
 *   ingest from {@link KEY_URL} alone (AAP 0.5.2), and duplicate detection
 *   groups on that digest, so this attribute cannot influence either.
 * - **It adds no byte accounting to this module.** The size stays with the
 *   producer that can measure it; this is only the handle that lets the
 *   aggregate find it.
 *
 * The fragment is stripped, because a fetch is issued without one and a
 * resource entry is never named with one. `../schema/attributes.ts` should
 * adopt the spelling in the `fetch` and `xhr` tuples, at which point the
 * consumer side in `../aggregate/requests.ts` reads it from the catalog
 * instead of re-declaring it.
 */
const KEY_RESOURCE_TIMING_URL = 'resourceTimingUrl';

/**
 * The character ceiling on an event's `name`.
 *
 * `../schema/event.ts` bounds `name` at 512 characters; this is the tighter
 * product bound, because the name is read in a timeline row and a waterfall
 * label. The name is `‹METHOD› ‹path›` with **no query string**: query values
 * are user data, they are redacted on the `url` attribute at ingest, and the
 * `name` field is not part of that redaction contract — so the query never
 * enters it in the first place.
 */
const MAX_NAME_CHARS = 256;

/**
 * How many leading stack frames are dropped when this module's own source
 * could not be identified at all.
 *
 * The agent is bundled and minified, so function names are no guide to which
 * frames belong to it. When the source *is* known (the normal case, detected
 * once per attach — see {@link detectAgentScriptUrl}) the leading frames
 * naming it are dropped precisely, however many there are. This count is the
 * last resort for a host whose frames carry no recognisable source at all,
 * and it is three because three is exactly what this module contributes to
 * every stack it captures: the capture helper, the planner that called it, and
 * the installed patch the application called.
 */
const AGENT_FRAME_FALLBACK = 3;

/**
 * The source of a stack frame — a URL or a path — without its `:line:column`
 * suffix.
 *
 * Deliberately permissive about the form, because the agent's own frames are
 * spelled differently in each place this module runs: `http://…/agent.iife.js`
 * in a page served by the dev server, `chrome-extension://…` in an extension
 * page, `file:///…` under a module loader, and a bare absolute path such as
 * `/repo/packages/telemetry/src/browser/fetch.ts` under a test runner. A
 * pattern that recognised only a scheme-bearing URL would silently stop
 * trimming this module's frames in exactly the environment where they are
 * easiest to notice.
 *
 * The non-greedy body with an anchored `:line:column` tail is what makes the
 * match stop at the source and not swallow the position, and what keeps
 * `http://host:3000/x.js:2:1` from being cut at the port.
 */
const FRAME_SOURCE_PATTERN =
  /((?:[A-Za-z][A-Za-z\d+.-]*:\/\/|\/|[A-Za-z]:[\\/])[^\s()]*?)(?::\d+){1,2}\)?\s*$/;

/** A V8 (`    at fn (url:1:2)`) or SpiderMonkey/JavaScriptCore (`fn@url:1:2`) frame. */
const V8_FRAME_PATTERN = /^\s*at\s/;

/**
 * A frame of the span helper's `span` method — the call every function-timing
 * patch makes (`__dbg.span(name, meta, () => __orig.apply(…))`, see
 * `packages/instrumentation/src/patch/wrap-template.ts`).
 *
 * The agent is minified, so the method is matched by the property it is called
 * through rather than by its own name: V8 writes `Object.kT [as span]` for a
 * renamed method and `Object.span` or `span` for an unrenamed one, and
 * SpiderMonkey/JavaScriptCore write `span@url:1:2`.
 */
const SPAN_HELPER_FRAME_PATTERN = /(?:\[as span\]|(?:^\s*at\s+|\.)span)\s+\(|(?:^|[./<])span@/;

/** Listener options for the XHR terminal listeners: fire once, never capture. */
const ONCE_OPTIONS: AddEventListenerOptions = { once: true };

/** The method assumed when a caller supplies none, matching `fetch`'s default. */
const DEFAULT_METHOD = 'GET';

/*
 * The host's own arity for each patched function — the FALLBACK each
 * replacement reports when the function it replaced states no usable
 * `Function.length` of its own.
 *
 * Every patch forwards the caller's own argument list through a rest
 * parameter — the only way to leave `arguments.length` untouched, see
 * {@link withDeclaredArity} — and a rest signature reports a
 * `Function.length` of 0, so an arity has to be written back onto each
 * replacement for a page that reads one. The value written is the replaced
 * function's own ({@link arityOf}), because what was on the property at attach
 * time may be another library's wrapper with an arity of its own; these four
 * numbers are what the *host* declares, which is the right answer only when
 * the captured value cannot supply one. Each is the number of arguments WebIDL
 * declares **required**, which is the `length` a host operation reports:
 * `fetch(input, init?)` reports 1, `open(method, url, async?, username?,
 * password?)` reports 2, `send(body?)` reports 0, and
 * `setRequestHeader(name, value)` reports 2.
 */

/** `window.fetch`'s own `length`, as the host declares it. */
const FETCH_ARITY = 1;

/** `XMLHttpRequest.prototype.open`'s own `length`, as the host declares it. */
const XHR_OPEN_ARITY = 2;

/** `XMLHttpRequest.prototype.send`'s own `length`, as the host declares it. */
const XHR_SEND_ARITY = 0;

/** `setRequestHeader`'s own `length`, as the host declares it. */
const XHR_SET_REQUEST_HEADER_ARITY = 2;

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * A cheap, honest picture of the patch, for `./agent.ts`'s diagnostics and for
 * tests.
 *
 * `inFlight` is the only number scoped to the current **producer generation**:
 * it is zeroed by {@link detachFetch} and by {@link advanceFetchGeneration},
 * because a request planned in an earlier generation reports nothing when it
 * settles and so would never be subtracted again. Every other number is
 * cumulative for the life of the document, exactly as `./transport.ts`'s
 * counters are, so a reader can tell "forty requests were correlated and two
 * were not" from "nothing has happened yet".
 */
export interface FetchStats {
  /**
   * Instrumented requests of the **current generation** that have started and
   * not yet settled; see {@link generation} for what a generation is.
   */
  inFlight: number;
  /** Requests a `traceparent` header was injected on, cumulative. */
  injected: number;
  /**
   * Requests that were **not** correlated, cumulative: an untraced context, a
   * cross-origin target, a header the application had already set, a URL that
   * would not resolve, a `Request` that could not be rebuilt, and a request
   * past {@link MAX_IN_FLIGHT}.
   */
  skipped: number;
  /**
   * Request events handed to `./transport.ts`, cumulative — settled requests
   * and the in-flight snapshots of {@link reportInFlightRequests} alike.
   */
  emitted: number;
  /**
   * Internal failures, cumulative: an instrumentation step that threw (and
   * was therefore skipped in favour of the untouched call), and a patched
   * property that could not be installed or, at detach, was no longer ours to
   * restore.
   */
  failures: number;
}

/*
 * ---------------------------------------------------------------------------
 * Internal types
 * ---------------------------------------------------------------------------
 */

/**
 * Why a request carries no `traceparent`.
 *
 * A closed set, because it is emitted as an attribute value and read by a
 * panel: every member is a stable, short literal a consumer may switch on.
 *
 * - `untraced-context` — no interaction window and no continuation window was
 *   open, so the request is a root of its own (a poll, a prefetch, a
 *   page-load request). Propagating a synthetic root would make the
 *   developer's server emit spans for traffic nobody asked about.
 * - `cross-origin` — the target is not `location.origin`. Never injected: the
 *   header is a correlation id and a third party must not receive it.
 * - `unresolvable-url` — the URL could not be resolved against the document,
 *   so the origin test could not be made. Treated as cross-origin.
 * - `existing-header` — the application set its own `traceparent`, which is
 *   left exactly as written.
 * - `malformed-ids` — `formatTraceparent` rejected the ids, which is an agent
 *   bug and still not a reason to break the request.
 * - `header-unavailable` — the host exposes no usable `Headers`, so no header
 *   bag could be built.
 * - `request-rebuild-failed` — a `Request` object could not be reconstructed
 *   with the extra header (a consumed or streaming body), so the original was
 *   forwarded untouched.
 * - `capacity` — {@link MAX_IN_FLIGHT} instrumented requests were already in
 *   flight. Counted only; no event is emitted for such a request, so this
 *   member never reaches an attribute bag.
 */
type SkipReason =
  | 'untraced-context'
  | 'cross-origin'
  | 'unresolvable-url'
  | 'existing-header'
  | 'malformed-ids'
  | 'header-unavailable'
  | 'request-rebuild-failed'
  | 'capacity';

/** The XHR event that terminated a request, when it was not a plain load. */
type XhrTerminal = 'error' | 'timeout' | 'abort';

/** The result of applying the header to one transport's carrier. */
type Injection<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: SkipReason };

/**
 * One instrumented request, from the moment it starts to the moment it
 * settles.
 *
 * The identity fields are `readonly` because they are decided once, before the
 * request is made, and an event that reported a different trace than the
 * header carried would be worse than no event. The three mutable fields are
 * the settle bookkeeping: whether this record has already been accounted for
 * (a `fetch` can settle twice if a caller attaches both a `then` and a
 * `catch`, and an XHR fires `abort` and then `loadend`), whether a pending
 * continuation is outstanding, and which terminal XHR event was seen.
 */
interface RequestRecord {
  /**
   * The producer generation this record was planned in; see
   * {@link isCurrentGeneration}.
   */
  readonly generation: number;
  /** `fetch` or `xhr`. */
  readonly kind: TelemetryKind;
  /** The trace the request joins. */
  readonly traceId: string;
  /** This request's own span id — the id the header carries. */
  readonly spanId: string;
  /** The interaction or settled request this one hangs from. */
  readonly parentSpanId: string | undefined;
  /** Lineage annotation from `./continuation.ts`, to be merged, never replaced. */
  readonly lineageAttributes: Record<string, unknown> | undefined;
  /** The upper-cased method, for the label and the `http.method` attribute. */
  readonly method: string;
  /** The URL exactly as the caller wrote it. */
  readonly url: string;
  /**
   * The absolute URL this request will appear under in the Resource Timing
   * buffer, or `undefined` when it could not be resolved.
   *
   * Resolved once here rather than at settle time: a single-page navigation
   * between the call and the response changes `location.href`, and a relative
   * URL re-resolved afterwards would name a resource the page never asked for.
   */
  readonly resourceTimingUrl: string | undefined;
  /** `‹METHOD› ‹path›`, bounded, query-free. */
  readonly name: string;
  /** When the request started, in epoch milliseconds. */
  readonly startedAt: number;
  /** Whether the target is `location.origin`. */
  readonly sameOrigin: boolean;
  /** Whether a `traceparent` header was injected. */
  readonly injected: boolean;
  /** Why it was not, when it was not. */
  readonly skipReason: SkipReason | undefined;
  /** The captured call-site stack, when the host produced one. */
  readonly initiator: string | undefined;
  /** Whether a pending continuation is outstanding for this span. */
  continuation: boolean;
  /** Whether this record has been accounted for. */
  settled: boolean;
  /** The terminal XHR event, when one was seen before `loadend`. */
  terminal: XhrTerminal | undefined;
}

/**
 * What was learned when a request settled — or, for the in-flight snapshot of
 * {@link reportInFlightRequests}, what was known when it was observed still
 * outstanding.
 */
interface RequestOutcome {
  /**
   * When it settled, in epoch milliseconds; for an in-flight snapshot, the
   * instant it was observed unsettled.
   */
  readonly settledAt: number;
  /**
   * `ok` for a completed request, including 4xx and 5xx; `error` for one that
   * failed; `unset` for an in-flight snapshot, which has done neither yet.
   */
  readonly status: TelemetryStatus;
  /** The response status code, when there was one. */
  readonly statusCode: number | undefined;
  /** Whether the application aborted the request. */
  readonly aborted: boolean;
  /** `Response.type`, for a `fetch` that fulfilled. */
  readonly responseType: string | undefined;
}

/** What the `fetch` patch decided, and the arguments it will forward. */
interface FetchPlan {
  readonly record: RequestRecord;
  readonly callInput: RequestInfo | URL;
  readonly callInit: RequestInit | undefined;
}

/** Per-instance state of a patched `XMLHttpRequest`, keyed in a `WeakMap`. */
interface XhrState {
  /** The upper-cased method from the last `open`. */
  method: string;
  /** The URL from the last `open`, as the caller wrote it. */
  url: string;
  /**
   * The absolute URL that `open` resolved, or `undefined` when it could not be
   * resolved then.
   *
   * Captured at `open` rather than at `send` because that is when the platform
   * resolves it: `XMLHttpRequest.open()` parses its URL against the base in
   * force at that moment and stores the result, so a page that opens `item` at
   * `/before/page`, navigates the history to `/after/page` and only then calls
   * `send()` requests — and times — `/before/item`. Re-resolving at send would
   * name `/after/item`: an identity matching no resource-timing entry, and an
   * origin test answering for a URL the request never went to.
   *
   * Stored as the resolved href rather than as a `URL`, so nothing holds a
   * platform object for the lifetime of a request.
   */
  resolvedHref: string | undefined;
  /**
   * Whether the application set its own `traceparent` on this request.
   *
   * Reset by every `open`, because `open()` clears the author request headers
   * by specification — a flag that survived would suppress injection on the
   * next request made through a reused instance.
   */
  explicitTraceparent: boolean;
}

/** The shape of `window.fetch`, for the saved original and the patch. */
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The shape of `XMLHttpRequest.prototype.open`. */
type XhrOpenFn = typeof XMLHttpRequest.prototype.open;

/** The shape of `XMLHttpRequest.prototype.send`. */
type XhrSendFn = typeof XMLHttpRequest.prototype.send;

/** The shape of `XMLHttpRequest.prototype.setRequestHeader`. */
type XhrSetRequestHeaderFn = typeof XMLHttpRequest.prototype.setRequestHeader;

/**
 * `window.fetch` seen as *a call to forward*: the saved original, through a
 * signature that accepts the caller's own argument list rather than the two
 * parameters WebIDL declares.
 *
 * The patches forward with `Reflect.apply(original, receiver, args)`, and the
 * two reasons are worth stating together. The list, because `original` is
 * whatever was on the property when this module attached — a page's or a
 * library's pre-existing wrapper is ordinary JavaScript and may branch on
 * `arguments.length`, which rebuilding the call from named parameters would
 * change (see {@link createFetchPatch}). `Reflect.apply` rather than
 * `original.apply`, because the latter is a property *of the original* that a
 * wrapper may have replaced; `Reflect.apply` reads nothing off the function it
 * calls, so an exotic `apply` cannot misdirect the forward.
 *
 * The cast to this type is safe in exactly the direction that matters: every
 * parameter is `unknown`, so anything the host declares can be passed, and the
 * receiver is still the window the original was taken from.
 */
type ForwardedFetchFn = (this: Window & typeof globalThis, ...args: unknown[]) => Promise<Response>;

/**
 * An `XMLHttpRequest.prototype` method seen as a call to forward, for the same
 * reasons as {@link ForwardedFetchFn}.
 *
 * One type for all three methods: `open`, `send` and `setRequestHeader` differ
 * only in the arguments the caller passed, which is precisely what is being
 * forwarded verbatim, and all three return `undefined`. The receiver stays the
 * calling `XMLHttpRequest`, which is what the host requires — the originals
 * are captured unbound for that reason — and forwarding through this type
 * changes nothing about it.
 */
type ForwardedXhrFn = (this: XMLHttpRequest, ...args: unknown[]) => void;

/**
 * One of the three patched `XMLHttpRequest.prototype` properties.
 *
 * Named rather than positional because every step of the install and the
 * restore is now per-slot: which slots this module actually holds is the
 * difference between a rollback that undoes what it did and one that either
 * forgets a patch or overwrites a property it never touched.
 */
type XhrSlot = 'open' | 'send' | 'setRequestHeader';

/**
 * One prototype property this module patched and has not yet put back.
 *
 * A record is the *whole* route from an installed patch to the host's own
 * function: the object the property lives on, which property it is, the
 * function found there before the patch, and the patch itself. Nothing about
 * it is keyed on "the current `XMLHttpRequest`", which is the point — see
 * {@link xhrPatchRecords} for the defect that shape removes.
 *
 * Discriminated on {@link XhrSlot} rather than holding a union of the three
 * function types, so a restore reads and writes the property the record names
 * with no cast: `record.slot === 'open'` narrows `original` and `installed` to
 * {@link XhrOpenFn} together.
 */
type XhrPatchRecord =
  | {
      /** The prototype the patch was installed on. */
      readonly prototype: XMLHttpRequest;
      /** Which property this record owns. */
      readonly slot: 'open';
      /** The function found in the property before the patch. */
      readonly original: XhrOpenFn;
      /** The function this module assigned into the property. */
      readonly installed: XhrOpenFn;
    }
  | {
      /** The prototype the patch was installed on. */
      readonly prototype: XMLHttpRequest;
      /** Which property this record owns. */
      readonly slot: 'send';
      /** The function found in the property before the patch. */
      readonly original: XhrSendFn;
      /** The function this module assigned into the property. */
      readonly installed: XhrSendFn;
    }
  | {
      /** The prototype the patch was installed on. */
      readonly prototype: XMLHttpRequest;
      /** Which property this record owns. */
      readonly slot: 'setRequestHeader';
      /** The function found in the property before the patch. */
      readonly original: XhrSetRequestHeaderFn;
      /** The function this module assigned into the property. */
      readonly installed: XhrSetRequestHeaderFn;
    };

/**
 * What one attempt at putting an original back achieved.
 *
 * - `restored` — the original is in place; this slot's saved references are
 *   now stale and are dropped.
 * - `foreign` — the property is no longer the function this module installed,
 *   so another library patched over us. Theirs is left alone (see
 *   {@link restoreFetchPatch}) and our references are dropped, because nothing
 *   of ours is installed any more.
 * - `retained` — the restoration failed, so **our patch is still installed**.
 *   The references are kept so a later {@link detachFetch} can try again, and
 *   so a later {@link attachFetch} re-adopts the patch instead of wrapping it.
 */
type RestoreOutcome = 'restored' | 'foreign' | 'retained';

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * All of it installed by {@link attachFetch} and released by
 * {@link detachFetch}; none of it touched at import time.
 * ---------------------------------------------------------------------------
 */

/** Whether the patches are installed right now. */
let attached = false;

/**
 * Which **producer generation** is current, advanced by {@link attachFetch},
 * by {@link detachFetch} and by every capture boundary
 * ({@link advanceFetchGeneration}).
 *
 * This is how an in-flight request survives the end of the capture it belongs
 * to without escaping into the next one. A record carries the generation it
 * was planned in; when it settles, a record from any other generation emits
 * nothing, settles no continuation and moves no counter, so neither a capture
 * the developer has stopped nor the capture that follows it can be extended by
 * a request that was already on the wire (AAP 0.5.1).
 *
 * Three events advance it, and each is a boundary a plain boolean would let a
 * request cross:
 *
 * - **attach** — every record planned from now on belongs to this generation,
 *   and every record from before it is already invalid.
 * - **detach** — without this, a stop/start pair would let a request planned
 *   before the stop report into the capture after it.
 * - **a direct capture change** — `agent.config` can move a bound tab from
 *   capture A to capture B with the network hook still enabled, so the patches
 *   stay installed and nothing detaches. A request still on the wire from A
 *   would settle inside B and be stamped with B's `captureId` and a `seq` from
 *   B's restarted sequence, since AAP 0.2.3 scopes `seq` to
 *   `(producerId, captureId)`. That is capture A's evidence inside capture B,
 *   carrying a sequence number that belongs to another event.
 *
 * Hence "generation" rather than "attach cycle": the counter identifies which
 * run of this producer a record belongs to, and attaching is only one of the
 * three ways a run can end.
 */
let generation = 0;

/** This module's own script URL, for dropping its frames from a stack. */
let agentScriptUrl: string | undefined;

/** The window whose `fetch` was patched, and the receiver the original is called with. */
let host: (Window & typeof globalThis) | undefined;

/** The `fetch` this module installed, for the identity check at detach. */
let installedFetch: FetchFn | undefined;

/** The `fetch` that was there before, restored at detach. */
let originalFetch: FetchFn | undefined;

/**
 * How many {@link XhrPatchRecord}s may be outstanding at once.
 *
 * Records are not per attach: one survives a detach exactly when its
 * restoration failed, so in ordinary operation the list is the three slots of
 * the one live prototype and is empty between captures. It grows only when the
 * page refuses a restoration *and* then replaces the `XMLHttpRequest`
 * constructor, which is how a bound becomes necessary at all: a page that
 * swapped the constructor in a loop while refusing every restoration would
 * otherwise make this module retain a record — and, through it, the replaced
 * prototype and two functions — for every iteration.
 *
 * Four prototypes' worth of slots. Deliberately small: a real application
 * replaces `XMLHttpRequest` at most once (a mock, a polyfill, a tracing
 * library installing its own transport), and residue past the fourth
 * unrestorable prototype is a page actively fighting the teardown rather than
 * a case worth holding memory for. What happens at the bound is in
 * {@link reserveXhrRecordRoom}: the install is *refused* and reported, never
 * granted at the cost of overwriting a record.
 */
const MAX_XHR_PATCH_RECORDS = 12;

/** How many prototype properties one XHR install patches; see {@link XhrSlot}. */
const XHR_SLOT_COUNT = 3;

/**
 * Every `XMLHttpRequest.prototype` property this module has patched and not
 * yet put back, oldest install first.
 *
 * **This list replaces a single tracked prototype, and that is the fix for
 * R1-F23.** The earlier shape held one `xhrPrototype` and one saved original
 * per slot, so an install on a *replaced* constructor's prototype overwrote
 * the only reference to the previous prototype's original — and any patch
 * whose restoration had failed on that prototype became unremovable for the
 * life of the document, which AAP 0.5.1's reversibility guarantee forbids. A
 * record is per prototype *and* per slot, so a new install can never overwrite
 * an unresolved original: it appends.
 *
 * The trade, stated: memory is held per unrestored patch rather than per
 * module, and the walk in {@link restoreXhrRecords} is O(records) at every
 * detach instead of O(1). Both are bounded by
 * {@link MAX_XHR_PATCH_RECORDS} — twelve records, twelve retried assignments
 * on a teardown — which buys the property that residue on an *earlier*
 * prototype is retried at every detach and cleared the moment the page lets it
 * back, instead of being forgotten at the next attach. The alternative,
 * refusing to install on a new prototype while residue on the old one stands,
 * would cost the capture its whole XHR signal for the rest of the session
 * because a sealed property never unseals; this shape only refuses at the
 * bound.
 *
 * The invariants, once any function in the installation section has returned:
 *
 * - a record's patch is installed in its property, or was and its restoration
 *   failed; either way this module knows the function to put back;
 * - a property this module never successfully wrote has no record (see the
 *   drop in {@link installXhrPatch});
 * - order is install order, and {@link restoreXhrRecords} walks it oldest
 *   first, so the prototype that was patched first is the one whose
 *   restoration is retried first.
 */
let xhrPatchRecords: XhrPatchRecord[] = [];

/**
 * Per-instance XHR state.
 *
 * A `WeakMap` rather than a property on the instance: an expando is observable
 * by the application, can collide with its own fields, and survives into
 * anything that serialises the object. The map is created at attach and
 * dropped at detach, so a detached module holds no reference to any request
 * the developer made.
 */
let xhrStates: WeakMap<XMLHttpRequest, XhrState> | undefined;

/** Instrumented requests in flight; see {@link FetchStats.inFlight}. */
let inFlightCount = 0;

/**
 * The instrumented requests of the current generation that have started and
 * not yet settled, been abandoned or been reported by
 * {@link reportInFlightRequests}.
 *
 * The list a capture boundary walks: without it, a request still on the wire
 * when its capture ends leaves no evidence, because its settle arrives in a
 * later generation and emits nothing. Its lifecycle follows
 * {@link inFlightCount} exactly — a record joins where it is counted, leaves
 * where it is settled or abandoned, and the list is cleared wherever the count
 * is zeroed — so it holds at most {@link MAX_IN_FLIGHT} records and never
 * outlives the generation its records belong to. A snapshot removes its record
 * without releasing the count, which is the boundary's job.
 *
 * A `Set` of the records themselves rather than of span ids, so a snapshot
 * reads exactly the identity and decisions the eventual settle would have
 * reported, and removal is O(1) on every settle.
 */
const outstandingRequests = new Set<RequestRecord>();

/** Requests a header was injected on; see {@link FetchStats.injected}. */
let injectedTotal = 0;

/** Requests that were not correlated; see {@link FetchStats.skipped}. */
let skippedTotal = 0;

/** Events handed to the transport; see {@link FetchStats.emitted}. */
let emittedTotal = 0;

/** Internal failures; see {@link FetchStats.failures}. */
let failureTotal = 0;

/*
 * ---------------------------------------------------------------------------
 * Small helpers
 *
 * Every one of them is total: it answers for any input the page can hand it,
 * including a hostile one, and none of them throws.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a record still belongs to the live producer generation.
 *
 * The guard on every settle path. A record from an earlier generation belongs
 * to a capture that has ended — stopped by the developer, or replaced by the
 * next capture on the same tab — and the contract is that nothing escapes a
 * capture it does not belong to: no event, no continuation, no counter
 * movement. See {@link generation} for the three boundaries that end a
 * generation.
 */
function isCurrentGeneration(record: RequestRecord): boolean {
  return attached && record.generation === generation;
}

/**
 * A duration in milliseconds, never negative and never non-finite.
 *
 * Both readings come from `nowEpochMs`, which is derived from the monotonic
 * document clock where the host supplies one, so the difference is ordinarily
 * monotonic. It degrades to `Date.now()` on a host without a usable
 * `performance`, and a wall-clock adjustment between the two reads could then
 * produce a negative value — which the event schema rejects, taking the event
 * with it. Clamping keeps the request visible with a zero duration instead.
 */
function measureDuration(startedAt: number, settledAt: number): number {
  const elapsed = settledAt - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

/**
 * The method as a label: trimmed and upper-cased, defaulting to `GET`.
 *
 * **This never changes the request.** The value is used for the event's
 * `http.method` attribute and its name only; the method the application
 * supplied is forwarded verbatim, because `init.method` is not written by this
 * module. Upper-casing matches both the wire (a browser normalises the known
 * methods) and `../redaction/request-key.ts`, which upper-cases before keying,
 * so a `fetch` written `get` groups with one written `GET`.
 *
 * Accepts `unknown` because the value comes from the page: an application may
 * pass a `String` object, a number, or nothing at all.
 */
function normalizeMethod(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_METHOD;
  }
  const trimmed = value.trim();
  return trimmed === '' ? DEFAULT_METHOD : trimmed.toUpperCase();
}

/**
 * A URL as the caller wrote it.
 *
 * A string is returned byte for byte. A `URL` instance has no "as written"
 * form other than its `href`, which is already the normalised spelling its own
 * constructor produced. Nothing else is done to the value — see the module
 * header on why normalising a URL here would break duplicate detection.
 *
 * Total over `unknown`, because both call sites take their value from the
 * page: `fetch`'s first argument may be a `Request` from another realm whose
 * duck test failed, and `open`'s second argument may be any object with a
 * `toString`. An unusable value yields `''`, which
 * `../aggregate/requests.ts` reads as an absent URL — an honest "not
 * observed" rather than a fabricated one.
 */
function readUrlString(value: unknown): string {
  try {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && value !== null) {
      const href: unknown = (value as { href?: unknown }).href;
      if (typeof href === 'string') {
        return href;
      }
      const url: unknown = (value as { url?: unknown }).url;
      if (typeof url === 'string') {
        return url;
      }
    }
    const coerced: string = String(value);
    // `String({})` is `[object Object]`, which is not a URL and would be
    // indexed as one; an empty string says "unknown" instead.
    return coerced.startsWith('[object ') ? '' : coerced;
  } catch {
    // An object whose `toString` or property getter throws is the page's
    // business; the request still goes out.
    return '';
  }
}

/**
 * The base a relative request URL is resolved against: the document's base
 * URL, exactly as the platform uses.
 *
 * `document.baseURI` and **not** `location.href`, because those two differ
 * whenever the page carries a `<base href>` — and when they differ, the
 * platform follows `baseURI`. A page at `/page` with `<base href="/base/">`
 * that fetches `item` requests `/base/item` and files its resource-timing
 * entry under that name, so resolving against `location.href` would produce
 * `/item`: an identity matching no entry, and an origin test answering for a
 * request the page never made. The origin test is the reason this matters
 * beyond the join — with a cross-origin `<base>`, resolving against
 * `location.href` would call a third-party request same-origin and inject a
 * `traceparent` into it, which AAP 0.4.2 forbids outright.
 *
 * Falls back to `location.href` where there is no document (a worker context)
 * and yields `undefined` where there is neither, which the caller reads as
 * "origin not establishable".
 */
function documentBaseUrl(): string | undefined {
  try {
    if (typeof document !== 'undefined') {
      const baseUri: unknown = document.baseURI;
      if (typeof baseUri === 'string' && baseUri.length > 0) {
        return baseUri;
      }
    }
    if (typeof location !== 'undefined') {
      const href: unknown = location.href;
      if (typeof href === 'string' && href.length > 0) {
        return href;
      }
    }
    return undefined;
  } catch {
    // A host that throws while reading either cannot establish a base, which
    // the caller treats exactly as it treats an unparseable URL.
    return undefined;
  }
}

/**
 * Resolve a URL against the document's base, for the origin test, the label
 * and the resource-timing identity.
 *
 * Returns `undefined` rather than throwing for a URL no parser accepts and for
 * a host with no `URL` or no base (the Node preload imports this package, and
 * a worker context has neither in the same shape). The caller treats an
 * unresolvable URL as cross-origin: a request whose origin cannot be
 * established must not receive a correlation id.
 *
 * @see documentBaseUrl for why the base is the document's rather than the
 * location's.
 */
function resolveAbsolute(url: string): URL | undefined {
  try {
    if (typeof URL === 'undefined') {
      return undefined;
    }
    const base = documentBaseUrl();
    if (base === undefined) {
      return undefined;
    }
    return new URL(url, base);
  } catch {
    // A malformed or exotic URL is the application's business; ours is only to
    // decline to inject into it.
    return undefined;
  }
}

/**
 * The identity this request will carry in the Resource Timing buffer.
 *
 * `URL.href` is the browser's own normalised spelling of the absolute URL,
 * which is what `PerformanceResourceTiming.name` reports, so no normalisation
 * of our own is applied — and none may be, for the reason the module header
 * gives about URLs generally. The fragment is removed by a plain string cut
 * rather than by mutating the `URL` (cheaper, and it cannot disturb an object
 * the caller might hold): a fetch never sends one, and an entry is never named
 * with one, so leaving it on would break the match for a page that fetches a
 * URL carrying a hash.
 *
 * @param resolved The absolute URL, or `undefined` when resolution failed.
 * @returns The identity, or `undefined` when there is none to report.
 */
function resourceTimingIdentity(resolved: URL | undefined): string | undefined {
  try {
    if (resolved === undefined) {
      return undefined;
    }
    const href = resolved.href;
    if (typeof href !== 'string' || href.length === 0) {
      return undefined;
    }
    const hashIndex = href.indexOf('#');
    return hashIndex < 0 ? href : href.slice(0, hashIndex);
  } catch {
    // A `URL` whose `href` getter throws is not one this module will describe;
    // the request still goes out untouched.
    return undefined;
  }
}

/** Whether a resolved URL points at the document's own origin. */
function isSameOrigin(resolved: URL): boolean {
  try {
    return typeof location !== 'undefined' && resolved.origin === location.origin;
  } catch {
    // A host that throws while reading `location.origin` cannot establish the
    // origin, which is the same answer as "not same-origin".
    return false;
  }
}

/**
 * Whether this request may carry a `traceparent` at all, and why not when it
 * may not.
 *
 * The three preconditions AAP 0.4.2 states, in the order that makes the
 * reported reason the most informative: a traced context first (a background
 * poll is not a failed correlation, it is an uncorrelated request by design),
 * then a resolvable URL, then the origin. The header the application may have
 * set itself is checked by the transport-specific injection step, which is the
 * only place that can see it.
 */
function eligibility(context: EventContext, resolved: URL | undefined): SkipReason | undefined {
  if (!isTracedContext(context)) {
    return 'untraced-context';
  }
  if (resolved === undefined) {
    return 'unresolvable-url';
  }
  if (!isSameOrigin(resolved)) {
    return 'cross-origin';
  }
  return undefined;
}

/**
 * The event's `name`: `‹METHOD› ‹path›`, bounded and query-free.
 *
 * The path comes from the resolved URL where there is one and from the raw
 * string cut at its first `?` or `#` otherwise — a cut, not a parse, so a URL
 * the parser rejected still yields a usable label without inventing a base.
 * The query is excluded deliberately: see {@link MAX_NAME_CHARS}.
 */
function requestName(method: string, url: string, resolved: URL | undefined): string {
  let path: string;
  if (resolved !== undefined) {
    path = resolved.pathname;
  } else {
    const [beforeQuery] = url.split(/[?#]/u);
    path = beforeQuery ?? url;
  }

  const label = path === '' ? method : `${method} ${path}`;
  const bounded = label.length > MAX_NAME_CHARS ? label.slice(0, MAX_NAME_CHARS) : label;
  // `name` is required to be non-empty by the event schema, and every branch
  // above can be defeated by a pathological input.
  return bounded === '' ? method : bounded;
}

/**
 * This module's own source, detected from a stack captured inside it.
 *
 * Called once per attach, from {@link attachFetch}, and it reads the
 * **innermost** frame only. That frame is this function itself, so whatever it
 * names — the minified agent bundle in a page, this file under a test runner —
 * is by construction the source every frame this module contributes to a
 * captured stack will also name.
 *
 * Reading only the innermost frame is the whole point, and the alternative is
 * a real bug: scanning for the first frame that *looks like* a source would,
 * under a runner whose own frames are spelled differently from the
 * application's, return the runner's URL and leave this module's frames in
 * every initiator stack — a developer clicking through to source would land in
 * the agent instead of their own component.
 *
 * Returns `undefined` on a host that produces no stack or no recognisable
 * source, where {@link AGENT_FRAME_FALLBACK} takes over.
 */
function detectAgentScriptUrl(): string | undefined {
  try {
    const stack = new Error().stack;
    if (typeof stack !== 'string') {
      return undefined;
    }

    const [innermost] = stack.split('\n').filter(isFrameLine);
    if (innermost === undefined) {
      return undefined;
    }

    const source = FRAME_SOURCE_PATTERN.exec(innermost)?.[1];
    return source !== undefined && source !== '' ? source : undefined;
  } catch {
    // A host without stacks simply gets the fallback heuristic.
    return undefined;
  }
}

/**
 * Whether a line of a stack string is a frame rather than the message header.
 *
 * V8 writes `Error` (or `Error: message`) first and then `    at …` frames;
 * SpiderMonkey and JavaScriptCore write `fn@url:1:2` with no header. Matching
 * both forms is what keeps the frame budget honest on every engine instead of
 * spending one slot on a header.
 */
function isFrameLine(line: string): boolean {
  return V8_FRAME_PATTERN.test(line) || line.includes('@');
}

/**
 * The application's call site, as a bounded stack string.
 *
 * Captured **synchronously, before the original is called**, which is the only
 * moment the application's frames are still on the stack. The frames are
 * generated-chunk coordinates by design — a dev-server chunk, a line and a
 * column — and are passed through **verbatim**, including their indentation:
 * `packages/code-analysis/src/source-map/resolver.ts` parses exactly this
 * format and maps it back to the developer's TypeScript, so any rewriting here
 * would be a second, divergent parser.
 *
 * The agent's own frames, and the frames a function-timing patch adds, are
 * dropped first (see {@link applicationFrames}), then at most
 * {@link MAX_INITIATOR_FRAMES} frames and {@link MAX_INITIATOR_CHARS}
 * characters are kept. `undefined` when the host produced no stack or nothing
 * survived the drop, because an empty `initiator` would be a claim of an
 * unknown call site rather than an absence of one — and
 * `../aggregate/requests.ts` reads a blank value as absent anyway.
 */
function captureInitiatorStack(): string | undefined {
  try {
    const stack = new Error().stack;
    if (typeof stack !== 'string' || stack === '') {
      return undefined;
    }

    const kept = applicationFrames(stack.split('\n').filter(isFrameLine), agentScriptUrl).slice(
      0,
      MAX_INITIATOR_FRAMES,
    );
    if (kept.length === 0) {
      return undefined;
    }

    const joined = kept.join('\n');
    return joined.length > MAX_INITIATOR_CHARS ? joined.slice(0, MAX_INITIATOR_CHARS) : joined;
  } catch {
    // A host with an exotic `Error.prototype.stack` costs this request its
    // click-to-source chip and nothing else.
    return undefined;
  }
}

/**
 * The frames of a captured stack that the application wrote, innermost first
 * — the stack as it would read with no instrumentation installed.
 *
 * - The leading frames naming `agentSource` (this module's patch and capture
 *   helpers) are dropped; when `agentSource` is unknown, or names none of the
 *   leading frames, the first {@link AGENT_FRAME_FALLBACK} frames are dropped
 *   instead.
 * - A later run of frames naming `agentSource` is the span helper a
 *   function-timing patch called. The run is dropped together with its two
 *   neighbours, which exist only because of the patch: the template's callback
 *   (`() => __orig.apply(…)`) directly inside it, and the patched function's
 *   own frame, which did nothing but call the helper, directly outside it. The
 *   `__orig` frame stays, at the position the patched function held, and still
 *   carries the original body's line. Without this, two patched functions
 *   spend six of the {@link MAX_INITIATOR_FRAMES} frames on instrumentation,
 *   and the frames that tell two call sites apart are cut off.
 * - Any other later frame naming `agentSource` is dropped on its own, so a
 *   click-to-source chip never lands in the agent.
 *
 * @param frames The stack's frame lines, innermost first, without its header.
 * @param agentSource The agent's own script source, when it was detected.
 * @returns The application's frames, unbounded; the caller applies the budget.
 */
export function applicationFrames(
  frames: readonly string[],
  agentSource: string | undefined,
): string[] {
  const isAgentFrame = (index: number): boolean =>
    agentSource !== undefined && (frames[index] ?? '').includes(agentSource);

  let start = 0;
  while (start < frames.length && isAgentFrame(start)) {
    start += 1;
  }
  if (start === 0) {
    start = Math.min(AGENT_FRAME_FALLBACK, frames.length);
  }

  const kept: string[] = [];
  let index = start;
  while (index < frames.length) {
    if (!isAgentFrame(index)) {
      kept.push(frames[index] ?? '');
      index += 1;
      continue;
    }
    let spanHelper = false;
    while (index < frames.length && isAgentFrame(index)) {
      spanHelper = spanHelper || SPAN_HELPER_FRAME_PATTERN.test(frames[index] ?? '');
      index += 1;
    }
    if (spanHelper) {
      kept.pop();
      index += 1;
    }
  }
  return kept;
}

/**
 * The first argument of `fetch` as a `Request`, when that is what it is.
 *
 * `instanceof` first, then a duck test on `url` and `method`, because a
 * `Request` constructed inside an iframe or another realm fails `instanceof`
 * against this realm's constructor — and treating one as a string would turn
 * it into the useless URL `[object Request]`. Nothing is read from it here
 * beyond the type check itself.
 */
function asRequestLike(input: RequestInfo | URL): Request | undefined {
  try {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return input;
    }
    if (typeof input !== 'object' || input === null || input instanceof URL) {
      return undefined;
    }
    const candidate = input as { url?: unknown; method?: unknown };
    if (typeof candidate.url === 'string' && typeof candidate.method === 'string') {
      // `RequestInfo | URL` minus `string` (excluded by the `typeof` above)
      // and minus `URL` is `Request`, so the compiler has already narrowed it.
      return input;
    }
    return undefined;
  } catch {
    // A proxy that throws on `instanceof` or a property read is treated as a
    // plain input; the worst case is a skipped injection.
    return undefined;
  }
}

/**
 * Apply the header to a `Request` by building a new one.
 *
 * The caller's `Request` is never mutated: a copy of its headers gains the one
 * entry and `new Request(input, { headers })` carries everything else — mode,
 * credentials, cache, redirect, referrer, integrity, keepalive and the abort
 * signal — across by specification.
 *
 * Three declines, all of them leaving the original request to be forwarded
 * untouched: the application already set a `traceparent`; the body has already
 * been consumed, so rebuilding could disturb it; and the construction itself
 * threw, which is what a streaming (duplex) body or a `navigate`-mode request
 * does. `input.body` is never read — `bodyUsed` is a boolean property, not a
 * body read.
 */
function injectIntoRequest(request: Request, value: string): Injection<Request> {
  let headers: Headers;
  try {
    headers = new Headers(request.headers);
  } catch {
    // A host that will not copy a header bag cannot be given one.
    return { ok: false, reason: 'header-unavailable' };
  }

  try {
    if (headers.has(TRACEPARENT_HEADER)) {
      return { ok: false, reason: 'existing-header' };
    }
    if (request.bodyUsed) {
      return { ok: false, reason: 'request-rebuild-failed' };
    }
    headers.set(TRACEPARENT_HEADER, value);
  } catch {
    // The only header this module ever touches is its own, and failing to set
    // it is not a reason to interfere with the request.
    return { ok: false, reason: 'header-unavailable' };
  }

  try {
    return { ok: true, value: new Request(request, { headers }) };
  } catch {
    // A consumed or streaming body, or a request whose mode forbids
    // reconstruction: the untouched original is forwarded instead.
    return { ok: false, reason: 'request-rebuild-failed' };
  }
}

/**
 * Apply the header to a `RequestInit` by shallow-copying it.
 *
 * The caller's `init` object and its `headers` are left exactly as they were —
 * an application that reuses one init across several requests must not find a
 * `traceparent` in it afterwards — so a fresh object carries a fresh `Headers`
 * built from whichever of the three accepted forms (`Headers`, `string[][]`,
 * plain record) the application used. `new Headers` handles all three, which is
 * why no form-specific branch is needed here.
 */
function injectIntoInit(init: RequestInit | undefined, value: string): Injection<RequestInit> {
  let headers: Headers;
  try {
    headers = new Headers(init?.headers);
  } catch {
    // An exotic headers value the host refuses to copy.
    return { ok: false, reason: 'header-unavailable' };
  }

  try {
    if (headers.has(TRACEPARENT_HEADER)) {
      return { ok: false, reason: 'existing-header' };
    }
    headers.set(TRACEPARENT_HEADER, value);
  } catch {
    return { ok: false, reason: 'header-unavailable' };
  }

  return { ok: true, value: { ...init, headers } };
}

/**
 * Whether a rejection reason is an abort.
 *
 * Duck-typed on `name`, because the reason may be a `DOMException` from
 * another realm, or the application's own reason handed to
 * `AbortController.abort(reason)`. Nothing else about the reason is inspected
 * and nothing about it is ever transported: a rejection reason is application
 * data, and the failure it describes is already carried by the event's
 * `error` status.
 */
function isAbortError(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    return (error as { name?: unknown }).name === 'AbortError';
  } catch {
    // A throwing getter on the reason tells us nothing; the event is still
    // emitted with `error` status.
    return false;
  }
}

/**
 * Give a patched function the `length` of the function it replaces.
 *
 * Each patch below is written with a **rest parameter**, because forwarding
 * the caller's exact argument list is the only way to leave `arguments.length`
 * alone for a pre-existing wrapper that branches on it — and a rest signature
 * reports a `Function.length` of 0, where `fetch` reports 1 and `open`
 * 2. Restoring the declared arity is what keeps the two halves of "never
 * change application behaviour" from trading places: a library that
 * feature-detects by arity, or that copies the descriptor onto a wrapper of
 * its own, must read the patch as the same function it was handed.
 *
 * **The arity copied is the replaced function's own, not the host's.** What was
 * on the property when this module attached may already be somebody else's
 * wrapper, reporting an arity of its own, and that is exactly the situation the
 * forwarding rules exist for — so {@link arityOf} asks the captured value first
 * and falls back to the host's constant (the {@link FETCH_ARITY} group) only
 * when it has no usable `length` to copy.
 *
 * `length` is a configurable own property of every function by specification,
 * so writing it is the sanctioned operation and not a trick; `value` alone is
 * passed, which leaves the non-writable, non-enumerable flags a function's own
 * `length` already carries exactly as they were. The alternative — leading
 * optional parameters, whose emitted arity is already right — was rejected
 * because such a signature cannot express "the caller passed nothing here"
 * separately from "the caller passed `undefined` here", and that distinction
 * is exactly what the forwarding exists to preserve.
 *
 * Returns its argument so a call site can
 * `return withDeclaredArity(patch, original, n)`, and never throws: a host that
 * refuses the definition keeps the arity it has, the failure is counted in
 * {@link getFetchStats}, and the patch still forwards every call correctly.
 *
 * @param patch The replacement this module installs.
 * @param replaced The function it replaces, whose arity is copied.
 * @param fallback The host's own arity, for a `replaced` that cannot state one.
 */
function withDeclaredArity<T extends (...args: never[]) => unknown>(
  patch: T,
  replaced: unknown,
  fallback: number,
): T {
  try {
    Object.defineProperty(patch, 'length', {
      value: arityOf(replaced, fallback),
      configurable: true,
    });
  } catch {
    // A frozen function object or a host that rejects the redefinition: the
    // patch is installed regardless, reporting a rest signature's arity.
    failureTotal += 1;
  }
  return patch;
}

/**
 * The arity a replacement should report: the one the function being replaced
 * reports, and the host's constant only when that cannot be read.
 *
 * The distinction is the whole point of taking the replaced function as an
 * argument. `window.fetch` and the three `XMLHttpRequest.prototype` methods may
 * already be somebody else's wrapper by the time this module attaches — that is
 * the case the argument-forwarding rules exist for — and such a wrapper is free
 * to report an arity of its own. Copying the host's constant over it would make
 * the patch describe a function nobody installed, so the captured value is
 * asked first and the constant is the fallback for a wrapper whose `length` is
 * missing, negative, fractional or not a number at all.
 *
 * @param replaced The original this module captured.
 * @param fallback The host's own arity for that operation; see the
 * {@link FETCH_ARITY} group.
 * @returns A non-negative integer.
 */
function arityOf(replaced: unknown, fallback: number): number {
  try {
    const declared = (replaced as { readonly length?: unknown }).length;
    if (typeof declared === 'number' && Number.isInteger(declared) && declared >= 0) {
      return declared;
    }
  } catch {
    // A throwing `length` accessor on a foreign wrapper: the host's constant is
    // the better of the two answers available.
    failureTotal += 1;
  }
  return fallback;
}

/*
 * ---------------------------------------------------------------------------
 * Request lifecycle
 *
 * The part both transports share: how a request is registered when it starts,
 * what it reports when it settles, and what happens when it can report
 * nothing at all.
 * ---------------------------------------------------------------------------
 */

/**
 * Register a request that is about to be made.
 *
 * Called once per instrumented request, after the injection decision has been
 * made (the record reports what was decided, not what was intended) and
 * before the original transport is invoked.
 *
 * The continuation is registered for **any traced context, injected or not**,
 * and the distinction matters: a cross-origin request received no header and
 * will produce no server span, but the React work that renders its response
 * still belongs to the interaction that caused it, and that attribution is
 * `./continuation.ts`'s job rather than the header's.
 */
function beginRequest(input: {
  readonly kind: TelemetryKind;
  readonly context: EventContext;
  readonly spanId: string;
  readonly method: string;
  readonly url: string;
  readonly resolved: URL | undefined;
  readonly startedAt: number;
  readonly injected: boolean;
  readonly skipReason: SkipReason | undefined;
  readonly initiator: string | undefined;
}): RequestRecord {
  const record: RequestRecord = {
    generation,
    kind: input.kind,
    traceId: input.context.traceId,
    spanId: input.spanId,
    parentSpanId: input.context.parentSpanId,
    lineageAttributes: input.context.attributes,
    method: input.method,
    url: input.url,
    resourceTimingUrl: resourceTimingIdentity(input.resolved),
    name: requestName(input.method, input.url, input.resolved),
    startedAt: input.startedAt,
    sameOrigin: input.resolved !== undefined && isSameOrigin(input.resolved),
    injected: input.injected,
    skipReason: input.skipReason,
    initiator: input.initiator,
    continuation: false,
    settled: false,
    terminal: undefined,
  };

  if (input.injected) {
    injectedTotal += 1;
  } else {
    skippedTotal += 1;
  }
  inFlightCount += 1;
  // Registered where it is counted, so the two can never disagree about what
  // is outstanding; see `outstandingRequests`.
  outstandingRequests.add(record);

  if (isTracedContext(input.context)) {
    registerPendingContinuation({
      traceId: record.traceId,
      spanId: record.spanId,
      name: record.name,
      startedAt: record.startedAt,
    });
    record.continuation = true;
  }

  return record;
}

/**
 * The attribute bag of a request event.
 *
 * The lineage annotation from `./interaction.ts` goes in **first** and is
 * merged rather than replacing anything: dropping it costs the panel the
 * dashed edge that marks an attribution as a best candidate instead of a
 * certainty, and none of this module's own keys collide with it.
 *
 * Every declared key comes from the `fetch` / `xhr` vocabulary of
 * `../schema/attributes.ts`; the four invented ones are documented at their
 * constants. A value that is unknown for this request is **omitted rather
 * than sent as `null`**, which is how the rest of this folder says "not
 * observed".
 *
 * Notably absent: `transferSize`, which only `PerformanceResourceTiming` can
 * supply and which `./perf.ts` owns (AAP 0.6.6), and `request_key`, which the
 * service computes at ingest from the unredacted URL and which a producer must
 * never set. Present instead of the size is
 * {@link KEY_RESOURCE_TIMING_URL} — the identity under which this request's
 * resource entry will appear, which is what lets
 * `../aggregate/requests.ts` find that entry and attribute its bytes to this
 * request. Emitting the handle rather than the number keeps each measurement
 * with the producer that can actually make it.
 */
function buildAttributes(record: RequestRecord, outcome: RequestOutcome): Record<string, unknown> {
  const attributes: Record<string, unknown> = { ...record.lineageAttributes };

  attributes[KEY_METHOD] = record.method;
  attributes[KEY_URL] = record.url;
  attributes[KEY_SAME_ORIGIN] = record.sameOrigin;
  attributes[KEY_TRACEPARENT_INJECTED] = record.injected;

  // Written whenever the URL resolved, including when it is byte-identical to
  // `url`: the aggregate must not have to guess whether the display URL is
  // already the absolute form the resource entry is named by.
  if (record.resourceTimingUrl !== undefined) {
    attributes[KEY_RESOURCE_TIMING_URL] = record.resourceTimingUrl;
  }

  if (!record.injected && record.skipReason !== undefined) {
    attributes[KEY_TRACEPARENT_SKIP_REASON] = record.skipReason;
  }
  if (record.initiator !== undefined) {
    attributes[KEY_INITIATOR] = record.initiator;
  }
  if (outcome.statusCode !== undefined) {
    attributes[KEY_STATUS_CODE] = outcome.statusCode;
  }
  if (outcome.aborted) {
    attributes[KEY_ABORTED] = true;
  }
  if (outcome.responseType !== undefined) {
    attributes[KEY_RESPONSE_TYPE] = outcome.responseType;
  }

  return attributes;
}

/**
 * Hand one request event to the transport.
 *
 * The span's parent is the context's — the interaction's root span, or the
 * settled request a continuation attributed it to — and its own `spanId` is
 * the id the `traceparent` header carried, which is what makes Next.js's
 * `http.server` span a child of this event rather than a sibling.
 *
 * `./transport.ts` drops the event when no capture is active, so this function
 * neither checks nor knows about the capture state; the producer generation is
 * the only gate applied here (see {@link settleRequest}).
 */
function emitRequestEvent(record: RequestRecord, outcome: RequestOutcome): void {
  const draft: EventDraft = {
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    kind: record.kind,
    name: record.name,
    startTime: record.startedAt,
    duration: measureDuration(record.startedAt, outcome.settledAt),
    attributes: buildAttributes(record, outcome),
    status: outcome.status,
  };
  emit(draft);
  emittedTotal += 1;
}

/**
 * Hand one in-flight snapshot to the transport: the event a request would
 * have reported, as far as it is known before a response.
 *
 * The same span as the settled event — trace, span, parent, kind, name and
 * start are the record's, exactly as {@link emitRequestEvent} writes them — so
 * `../aggregate/requests.ts` can recognise the two as one request should both
 * ever reach it. The attribute bag is {@link buildAttributes}'s over an
 * outcome that observed nothing — no status code, no abort, no response type —
 * plus {@link KEY_IN_FLIGHT}; the status is {@link IN_FLIGHT_STATUS}; and the
 * duration is the time the request had been outstanding at `observedAt`,
 * which is a lower bound on its real duration.
 *
 * @param record A current-generation record that has not settled.
 * @param observedAt The instant the snapshot describes, in epoch milliseconds.
 */
function emitInFlightSnapshot(record: RequestRecord, observedAt: number): void {
  const outcome: RequestOutcome = {
    settledAt: observedAt,
    status: IN_FLIGHT_STATUS,
    statusCode: undefined,
    aborted: false,
    responseType: undefined,
  };
  const attributes = buildAttributes(record, outcome);
  attributes[KEY_IN_FLIGHT] = true;

  const draft: EventDraft = {
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    kind: record.kind,
    name: record.name,
    startTime: record.startedAt,
    duration: measureDuration(record.startedAt, outcome.settledAt),
    attributes,
    status: outcome.status,
  };
  emit(draft);
  emittedTotal += 1;
}

/**
 * Account for a settled request: emit its event and close its continuation
 * window.
 *
 * Idempotent, because a settle can be observed twice — a `fetch` whose caller
 * attached both a fulfilment and a rejection handler, an XHR that fires
 * `abort` and then `loadend` — and a second event would double every request
 * count in the capture.
 *
 * Nothing is reported for a record from an earlier producer generation: the
 * capture it belonged to has ended, and a capture that has ended must receive
 * nothing — neither the stopped capture, which AAP 0.5.1 requires to be left
 * alone, nor the capture that replaced it, whose `(producerId, captureId)`
 * sequence the event would be stamped with (see {@link generation}). Such a
 * record is still marked settled, so it can never be reconsidered, and the
 * in-flight counter it was holding is released by whichever boundary ended its
 * generation rather than here.
 *
 * The continuation is settled for **both** outcomes. A network error is still
 * a response arriving, and the React work that renders the failure belongs to
 * the request that failed exactly as a successful render belongs to the
 * request that succeeded.
 */
function settleRequest(record: RequestRecord, outcome: RequestOutcome): void {
  try {
    if (record.settled) {
      return;
    }
    record.settled = true;
    // Before the generation test: a settled record is never outstanding,
    // whichever generation it belongs to.
    outstandingRequests.delete(record);

    if (!isCurrentGeneration(record)) {
      return;
    }

    inFlightCount = inFlightCount > 0 ? inFlightCount - 1 : 0;
    emitRequestEvent(record, outcome);

    if (record.continuation) {
      settleContinuation(record.spanId, outcome.settledAt);
    }
  } catch (error: unknown) {
    // The settle path runs inside the application's own promise chain and its
    // event listeners, so a failure here costs one event and never the
    // request it describes. The event is lost either way; what the report adds
    // is that the capture *knows* a request went unrecorded (AAP 0.5.5).
    failureTotal += 1;
    reportProducerFailure('fetch', 'settle', error);
  }
}

/**
 * Give up on a request that will never be observed settling.
 *
 * The one path that can produce such a record is an XHR whose terminal
 * listeners could not be registered. Withdrawing the pending continuation is
 * what keeps `./continuation.ts` honest: a pending entry that never settles
 * would sit in its map until an age bound evicted it, and until then the
 * bound would be spent on a request nobody is waiting for.
 *
 * The in-flight counter is released only for a record of the current producer
 * generation, for the reason {@link settleRequest} states: an earlier
 * generation's count was already zeroed by the boundary that ended it, and
 * subtracting again would make the number describe fewer requests than are
 * actually in flight.
 */
function abandonRequest(record: RequestRecord): void {
  try {
    if (record.settled) {
      return;
    }
    record.settled = true;
    // An abandoned request is one this module has stopped observing — refused
    // by the host before it started, or an XHR whose settle cannot be seen —
    // so whether it is still outstanding at a capture boundary is unknown, and
    // reporting it as in flight would state something nobody observed.
    outstandingRequests.delete(record);

    if (isCurrentGeneration(record)) {
      inFlightCount = inFlightCount > 0 ? inFlightCount - 1 : 0;
    }
    if (record.continuation) {
      cancelPendingContinuation(record.spanId);
    }
  } catch (error: unknown) {
    // Best effort by construction: both steps above are independent. A
    // continuation that could not be withdrawn holds one entry in
    // `./continuation.ts`'s bound until it ages out, which is worth stating.
    failureTotal += 1;
    reportProducerFailure('fetch', 'abandon', error);
  }
}

/**
 * What a fulfilled `fetch` reports.
 *
 * `status: 'ok'` for **every** response the network produced, including 4xx
 * and 5xx: the request completed, and its failure is carried by
 * `http.status_code`, where an analysis can read it as an application outcome
 * rather than as a transport failure. `status` and `type` are plain property
 * reads; the body is never touched, and the response is returned to the
 * application exactly as it arrived.
 */
function responseOutcome(response: Response): RequestOutcome {
  let statusCode: number | undefined;
  let responseType: string | undefined;

  try {
    const status = response.status;
    if (typeof status === 'number' && Number.isFinite(status) && status > 0) {
      statusCode = status;
    }
    const type: unknown = response.type;
    if (typeof type === 'string' && type !== '') {
      responseType = type;
    }
  } catch (error: unknown) {
    // An opaque or exotic response object still produces an event; the two
    // fields above are simply absent from it, and the report says the event
    // was emitted with less than it should carry.
    failureTotal += 1;
    reportProducerFailure('fetch', 'response-read', error);
  }

  return {
    settledAt: nowEpochMs(),
    status: 'ok',
    statusCode,
    aborted: false,
    responseType,
  };
}

/**
 * What a rejected `fetch` reports.
 *
 * A network failure, a CORS refusal and an abort all arrive here. The reason
 * itself is not transported (see {@link isAbortError}); only whether it was an
 * abort, which is the one distinction that changes how a reader should judge
 * the request.
 */
function rejectionOutcome(error: unknown): RequestOutcome {
  return {
    settledAt: nowEpochMs(),
    status: 'error',
    statusCode: undefined,
    aborted: isAbortError(error),
    responseType: undefined,
  };
}

/**
 * What a settled `XMLHttpRequest` reports.
 *
 * `xhr.status` is `0` for a network error, a timeout, an abort and a
 * cross-origin refusal, which is exactly the set that makes the event an
 * `error`; any other status means the exchange completed and is reported as
 * `ok` with its code, 4xx and 5xx included. The terminal event seen before
 * `loadend` refines that judgement — it is the only thing that can tell an
 * abort from a network error.
 */
function xhrOutcome(xhr: XMLHttpRequest, record: RequestRecord): RequestOutcome {
  let statusCode: number | undefined;
  try {
    const status = xhr.status;
    if (typeof status === 'number' && Number.isFinite(status) && status > 0) {
      statusCode = status;
    }
  } catch (error: unknown) {
    // A host that throws while reading `status` in this state leaves the code
    // absent, which the `error` status below already implies.
    failureTotal += 1;
    reportProducerFailure('fetch', 'xhr-status-read', error);
  }

  const terminal = record.terminal;
  const failed = terminal !== undefined || statusCode === undefined;

  return {
    settledAt: nowEpochMs(),
    status: failed ? 'error' : 'ok',
    statusCode,
    aborted: terminal === 'abort',
    responseType: undefined,
  };
}

/*
 * ---------------------------------------------------------------------------
 * The `fetch` patch
 * ---------------------------------------------------------------------------
 */

/**
 * Decide everything about a `fetch` call before it is made, and produce the
 * arguments to forward.
 *
 * Returns `undefined` when the request will not be instrumented at all — past
 * {@link MAX_IN_FLIGHT} — in which case the caller forwards the caller's own
 * arguments untouched.
 *
 * Order is load-bearing. The clock is read once and the same instant decides
 * the context, the span start and the continuation registration, so the three
 * cannot disagree; the initiator stack is captured while the application's
 * frames are still on the stack; and the header is applied to a *copy* of
 * whichever carrier the application used, so neither the `Request` nor the
 * `init` the caller holds is ever modified.
 */
function planFetch(input: RequestInfo | URL, init: RequestInit | undefined): FetchPlan | undefined {
  if (inFlightCount >= MAX_IN_FLIGHT) {
    skippedTotal += 1;
    return undefined;
  }

  const startedAt = nowEpochMs();
  const requestLike = asRequestLike(input);

  // Which carrier the host will actually read, which is not always the one the
  // caller looks like they used. `fetch(request, init)` is specified as
  // `new Request(request, init)`, so an `init` that names `headers` *replaces*
  // the request's entire header list and an `init` that names `method`
  // overrides its method. Injecting into the request in that case would put
  // the header on an object whose headers the host then discards — the event
  // would report `traceparentInjected: true` for a request that arrived
  // without it, which is worse than reporting an honest skip.
  const initCarriesHeaders = init !== undefined && init.headers !== undefined;
  const injectIntoRequestObject = requestLike !== undefined && !initCarriesHeaders;
  const method = normalizeMethod(init?.method ?? requestLike?.method);
  const url = requestLike !== undefined ? requestLike.url : readUrlString(input);
  const resolved = resolveAbsolute(url);
  const context = resolveEventContext(startedAt);
  const spanId = newSpanId();
  const initiator = captureInitiatorStack();

  let callInput: RequestInfo | URL = input;
  let callInit: RequestInit | undefined = init;
  let injected = false;
  let skipReason = eligibility(context, resolved);

  if (skipReason === undefined) {
    const value = formatTraceparent(context.traceId, spanId);
    if (value === '') {
      // `./ids.ts` returns '' for a malformed or all-zero id, which a receiver
      // would ignore: injecting it would look like correlation had been
      // attempted and failed.
      skipReason = 'malformed-ids';
    } else if (typeof Headers === 'undefined') {
      skipReason = 'header-unavailable';
    } else if (injectIntoRequestObject && requestLike !== undefined) {
      const applied = injectIntoRequest(requestLike, value);
      if (applied.ok) {
        callInput = applied.value;
        injected = true;
      } else {
        skipReason = applied.reason;
      }
    } else {
      const applied = injectIntoInit(init, value);
      if (applied.ok) {
        callInit = applied.value;
        injected = true;
      } else {
        skipReason = applied.reason;
      }
    }
  }

  const record = beginRequest({
    kind: FETCH_KIND,
    context,
    spanId,
    method,
    url,
    resolved,
    startedAt,
    injected,
    skipReason,
    initiator,
  });

  return { record, callInput, callInit };
}

/**
 * Build the replacement for `window.fetch`.
 *
 * A closure over the captured original and its receiver, rather than a
 * module-level function reading module state, so there is no reachable state
 * in which the patch exists without the original it must call — the one
 * failure mode that would leave the page without a working `fetch`.
 *
 * **The caller's own argument list is what reaches the original.** The patch
 * takes a rest parameter and forwards it with `Reflect.apply` (see
 * {@link ForwardedFetchFn}), instead of rebuilding the call from named
 * parameters. Rebuilding is equivalent *by WebIDL* — `fetch(url)` and
 * `fetch(url, undefined)` are the same request to the host's own native
 * function — and that equivalence is beside the point: `original` is whatever
 * was on `window.fetch` when this module attached, and a page's or a library's
 * pre-existing wrapper is ordinary JavaScript. Mocking libraries, polyfills
 * and other instrumentation SDKs routinely branch on `arguments.length`, so
 * handing such a wrapper two arguments where the application passed one is a
 * change in the behaviour of the code under investigation, which is the first
 * thing this module may not do. The only substitutions made are the copied
 * carriers the injection produced, each in the slot it came from.
 *
 * The settle handlers `return response` and `throw error` rather than
 * producing values of their own, so the promise this function returns settles
 * with **the same** `Response` instance or **the same** rejection reason the
 * original produced. A caller that compares identity, or that matches on
 * `error.name`, cannot tell the difference.
 */
function createFetchPatch(original: FetchFn, receiver: Window & typeof globalThis): FetchFn {
  const forward = original as ForwardedFetchFn;

  const patchedFetch = (...args: unknown[]): Promise<Response> => {
    let plan: FetchPlan | undefined;
    // `fetch()` with no arguments at all is a `TypeError` the host owes the
    // application, so it is never planned: instrumenting it would invent a
    // request nobody made, and injecting an `init` into it would turn the
    // error into a real request to the document's own URL. The empty list
    // falls through to the forward below and the original throws its own.
    if (args.length > 0) {
      try {
        // The two carrier slots, read through the types the host declares for
        // them. A page may of course pass anything at all, which is why every
        // helper that reads either value — `asRequestLike`, `readUrlString`,
        // `normalizeMethod` — is total over an arbitrary input, and why this
        // assertion narrows the forwarded list without ever narrowing what is
        // forwarded.
        plan = planFetch(args[0] as RequestInfo | URL, args[1] as RequestInit | undefined);
      } catch (error: unknown) {
        // Any failure in planning costs the observation, never the request:
        // the application's own arguments are forwarded below as if this
        // module were not installed. An uninstrumented request is a hole in
        // the trace — and therefore in the browser-to-server correlation — so
        // it is stated rather than only counted (AAP 0.5.5).
        failureTotal += 1;
        reportProducerFailure('fetch', 'fetch-plan', error);
        plan = undefined;
      }
    }

    if (plan === undefined) {
      // Planning was skipped, declined (capacity) or failed: the list goes
      // through completely untouched, length included.
      return Reflect.apply(forward, receiver, args);
    }

    // The caller's list, with nothing changed but the carriers the injection
    // copied. `planFetch` returns the caller's own values unless it built a
    // copy to hold the header, so an identity comparison is exactly the
    // question "was a copy built for this slot?".
    const forwarded: unknown[] = [...args];
    if (plan.callInput !== forwarded[0]) {
      // A `Request` copy carrying the header. Same slot, same length: the
      // application's own `Request` is untouched and is simply not the object
      // the host is handed.
      forwarded[0] = plan.callInput;
    }
    if (plan.callInit !== forwarded[1]) {
      // A copy of `init` carrying the header — and the one legitimate case in
      // which the forwarded length may GROW, from one argument to two, when
      // the application passed no `init` for the header to go in. It is the
      // unavoidable cost of injecting a header on a call whose only other
      // carrier would be a `Request` object this call does not have: without
      // it there is no `traceparent`, and without the header the developer's
      // browser half and server half are two disconnected traces (AAP 0.4.2).
      // Nothing else about the list changes, and the growth cannot happen on a
      // call that passed an `init` of its own.
      forwarded[1] = plan.callInit;
    }

    const { record } = plan;
    let pending: Promise<Response>;
    try {
      pending = Reflect.apply(forward, receiver, forwarded);
    } catch (error: unknown) {
      // `fetch` reports its failures by rejecting, so a synchronous throw
      // means the host refused to start the request at all. Nothing went on
      // the wire, so nothing is reported: the record is withdrawn — which also
      // releases its pending continuation, so no later render is attributed to
      // a request that never happened — and the error is rethrown unchanged.
      abandonRequest(record);
      throw error;
    }

    return pending.then(
      (response: Response): Response => {
        settleRequest(record, responseOutcome(response));
        return response;
      },
      (error: unknown): never => {
        settleRequest(record, rejectionOutcome(error));
        throw error;
      },
    );
  };

  return withDeclaredArity(patchedFetch, original, FETCH_ARITY);
}

/*
 * ---------------------------------------------------------------------------
 * The `XMLHttpRequest` patch
 *
 * Three methods, patched together because the instrumentation needs all
 * three: `open` is where the method and URL are stated, `setRequestHeader` is
 * where the application may state its own `traceparent`, and `send` is where
 * the request actually starts and is therefore where the trace decision
 * belongs.
 * ---------------------------------------------------------------------------
 */

/**
 * Record what an `open` call stated, for the `send` that will follow.
 *
 * `explicitTraceparent` is reset here rather than carried forward: `open()`
 * clears the author request headers by specification, so a reused instance
 * starts each request with no header of its own, and a flag that survived
 * would silently suppress injection for the rest of the instance's life.
 *
 * The URL is **resolved here as well as recorded**, because `open` is where
 * the platform resolves it; see {@link XhrState.resolvedHref}. Resolution is
 * the only work this function does beyond storing three values, and it cannot
 * throw: `resolveAbsolute` answers `undefined` for anything it cannot parse.
 *
 * Both values are taken as `unknown`, because they are the page's own
 * arguments and this is an **observation**, not the call: `open` forwards the
 * caller's list verbatim (see {@link createOpenPatch}), so the only thing that
 * happens to a method or a URL here is that `normalizeMethod` and
 * `readUrlString` — both total over any input — turn it into a label for the
 * event. Coercing before the forward would be the argument rewriting this
 * module must not do; declining to instrument an unusual value would lose the
 * request from the capture for no gain.
 */
function noteOpen(xhr: XMLHttpRequest, method: unknown, url: unknown): void {
  const states = xhrStates;
  if (states === undefined) {
    return;
  }
  const asWritten = readUrlString(url);
  states.set(xhr, {
    method: normalizeMethod(method),
    url: asWritten,
    resolvedHref: resolveAbsolute(asWritten)?.href,
    explicitTraceparent: false,
  });
}

/**
 * Decide everything about an XHR before it is sent, injecting the header
 * through the **original** `setRequestHeader`.
 *
 * The original rather than the installed patch, for one reason worth stating:
 * the patch's only job is to notice an application-set `traceparent`, and
 * routing this call through it would make the module observe itself — the flag
 * would be set by our own injection and the next request through a reused
 * instance would decline to inject. Calling the original keeps the
 * application's statement and this module's injection strictly separate.
 *
 * Returns `undefined` when the request will not be instrumented: `send`
 * without a preceding `open` (which the original will reject as the
 * application expects), a detached module, or {@link MAX_IN_FLIGHT} requests
 * already in flight.
 */
function planXhr(xhr: XMLHttpRequest, setHeader: XhrSetRequestHeaderFn): RequestRecord | undefined {
  const states = xhrStates;
  if (states === undefined) {
    return undefined;
  }

  const state = states.get(xhr);
  if (state === undefined) {
    return undefined;
  }

  if (inFlightCount >= MAX_IN_FLIGHT) {
    skippedTotal += 1;
    return undefined;
  }

  const startedAt = nowEpochMs();
  // The `open`-time resolution, which is the one the platform will use. Only a
  // request whose URL could not be resolved then is re-tried here, and then
  // only so that a host which failed to resolve at `open` is no worse off than
  // it was.
  const resolved =
    state.resolvedHref === undefined
      ? resolveAbsolute(state.url)
      : resolveAbsolute(state.resolvedHref);
  const context = resolveEventContext(startedAt);
  const spanId = newSpanId();
  const initiator = captureInitiatorStack();

  let injected = false;
  let skipReason = eligibility(context, resolved);

  if (skipReason === undefined) {
    if (state.explicitTraceparent) {
      skipReason = 'existing-header';
    } else {
      const value = formatTraceparent(context.traceId, spanId);
      if (value === '') {
        skipReason = 'malformed-ids';
      } else {
        try {
          setHeader.call(xhr, TRACEPARENT_HEADER, value);
          injected = true;
        } catch {
          // `setRequestHeader` throws for a request in the wrong state and for
          // a forbidden header name; neither is a reason to fail the send.
          skipReason = 'header-unavailable';
        }
      }
    }
  }

  return beginRequest({
    kind: XHR_KIND,
    context,
    spanId,
    method: state.method,
    url: state.url,
    resolved,
    startedAt,
    injected,
    skipReason,
    initiator,
  });
}

/**
 * Observe an XHR settling, without touching how the application observes it.
 *
 * `addEventListener` with `{ once: true }` for every listener, which is
 * independent of the `onload` / `onerror` / `onreadystatechange` *properties*
 * the application assigns: those are a separate registration, so they still
 * fire, exactly once, in their usual order.
 *
 * `loadend` is the single settle point — it fires after `load`, `error`,
 * `timeout` and `abort` alike — and the other three listeners exist only to
 * record *which* terminal event happened, which is the difference between an
 * abort the application asked for and a network failure it did not.
 *
 * A failure to register leaves nothing to settle the record, so the record is
 * abandoned rather than left pending.
 */
function observeXhr(xhr: XMLHttpRequest, record: RequestRecord): void {
  try {
    const noteTerminal = (terminal: XhrTerminal) => (): void => {
      record.terminal = terminal;
    };

    xhr.addEventListener('error', noteTerminal('error'), ONCE_OPTIONS);
    xhr.addEventListener('timeout', noteTerminal('timeout'), ONCE_OPTIONS);
    xhr.addEventListener('abort', noteTerminal('abort'), ONCE_OPTIONS);
    xhr.addEventListener(
      'loadend',
      (): void => {
        settleRequest(record, xhrOutcome(xhr, record));
      },
      ONCE_OPTIONS,
    );
  } catch (error: unknown) {
    // A host or a page that refuses a listener on this object costs the
    // request its event; the send below still happens.
    failureTotal += 1;
    reportProducerFailure('fetch', 'xhr-observe', error);
    abandonRequest(record);
  }
}

/**
 * Build the replacement for `XMLHttpRequest.prototype.open`.
 *
 * **Every argument is forwarded exactly as the caller wrote it**, through the
 * caller's own list: `open(m, u)` reaches the original with two arguments,
 * `open(m, u, false)` with three and a `false` that is still `false`, and a
 * sixth argument nobody has ever passed with six. No slot is defaulted here.
 * WebIDL would indeed resolve an omitted `async` to `true` and an omitted
 * `username` / `password` to `null` for the host's own `open` — but the
 * function being called is whatever was on the prototype when this module
 * attached, and substituting a specification default for an omission is a
 * different call for any wrapper that counts its arguments (see
 * {@link createFetchPatch} for the same reasoning on `fetch`).
 *
 * The observation is taken before the forward, from the same arguments, and
 * `noteOpen` normalises them for the *event* only.
 */
function createOpenPatch(original: XhrOpenFn): XhrOpenFn {
  const forward = original as ForwardedXhrFn;

  const patchedOpen = function patchedOpen(this: XMLHttpRequest, ...args: unknown[]): void {
    try {
      noteOpen(this, args[0], args[1]);
    } catch (error: unknown) {
      // A page that hands `open` an exotic method or URL object still gets its
      // request opened; only the observation is lost — which is exactly what a
      // reader of the capture needs told.
      failureTotal += 1;
      reportProducerFailure('fetch', 'xhr-note-open', error);
    }

    Reflect.apply(forward, this, args);
  };

  return withDeclaredArity(patchedOpen, original, XHR_OPEN_ARITY);
}

/**
 * Build the replacement for `XMLHttpRequest.prototype.setRequestHeader`.
 *
 * Reads the header **name** only, and only to compare it with
 * `traceparent` — a header value set by the application is never read, copied
 * or transported, which is what keeps an `Authorization` header out of this
 * module entirely. The call is then forwarded as the caller's own list,
 * whatever the comparison said and however many arguments there were: a third
 * argument the specification does not declare is still the application's call
 * to make and not this module's to drop.
 */
function createSetRequestHeaderPatch(original: XhrSetRequestHeaderFn): XhrSetRequestHeaderFn {
  const forward = original as ForwardedXhrFn;

  const patchedSetRequestHeader = function patchedSetRequestHeader(
    this: XMLHttpRequest,
    ...args: unknown[]
  ): void {
    try {
      const name = args[0];
      if (typeof name === 'string' && name.toLowerCase() === TRACEPARENT_HEADER) {
        const state = xhrStates?.get(this);
        if (state !== undefined) {
          state.explicitTraceparent = true;
        }
      }
    } catch (error: unknown) {
      // The worst case of a failure here is that this module injects its own
      // header over an application header it failed to notice, which
      // `injectIntoRequest`'s equivalent check makes impossible for `fetch`
      // and which the host resolves for XHR by keeping both values. The header
      // *name* is the only thing this block reads and neither it nor the value
      // goes into the report.
      failureTotal += 1;
      reportProducerFailure('fetch', 'xhr-note-header', error);
    }

    Reflect.apply(forward, this, args);
  };

  return withDeclaredArity(patchedSetRequestHeader, original, XHR_SET_REQUEST_HEADER_ARITY);
}

/**
 * Build the replacement for `XMLHttpRequest.prototype.send`.
 *
 * The body is never inspected and never rewritten: the caller's own list is
 * forwarded, so `send()` reaches the original with **zero** arguments and
 * `send(body)` with one. The specification would resolve an explicit
 * `undefined` to the same `null` an omission resolves to, and that is again a
 * statement about the host's own `send` rather than about the function on the
 * prototype (see {@link createFetchPatch}); a wrapper that distinguishes "no
 * body" from "a body of `undefined`" must keep seeing the difference.
 *
 * Instrumentation happens strictly before the forward, so the `traceparent`
 * header is set while the request is still in the state that accepts headers.
 */
function createSendPatch(original: XhrSendFn, setHeader: XhrSetRequestHeaderFn): XhrSendFn {
  const forward = original as ForwardedXhrFn;

  const patchedSend = function patchedSend(this: XMLHttpRequest, ...args: unknown[]): void {
    let record: RequestRecord | undefined;
    try {
      record = planXhr(this, setHeader);
    } catch (error: unknown) {
      // As for `fetch`: the observation is lost, the request is not, and the
      // loss is stated.
      failureTotal += 1;
      reportProducerFailure('fetch', 'xhr-plan', error);
      record = undefined;
    }

    if (record !== undefined) {
      observeXhr(this, record);
    }

    try {
      Reflect.apply(forward, this, args);
    } catch (error: unknown) {
      // `send` throws `InvalidStateError` when the host refuses to start the
      // request — no `open`, or an instance already sent. No request means no
      // span, so the record is withdrawn (its terminal listeners are already
      // registered and will find it settled) and the error is rethrown
      // unchanged for the application to handle.
      if (record !== undefined) {
        abandonRequest(record);
      }
      throw error;
    }
  };

  // `send` declares no required argument, so the host's fallback is zero — but
  // the arity actually published is the replaced function's own, which a
  // pre-existing wrapper may state differently.
  return withDeclaredArity(patchedSend, original, XHR_SEND_ARITY);
}

/*
 * ---------------------------------------------------------------------------
 * Installation and restoration
 *
 * Four patched properties — `window.fetch` and three
 * `XMLHttpRequest.prototype` methods — installed independently and restored
 * independently. The restore of each is guarded by an identity check, because
 * "put the original back" and "put *our* original back over whatever is there
 * now" are different operations and only the first is correct.
 *
 * Six rules hold across every function in this section. They are not tidiness:
 * this module mutates two of the most heavily used APIs of somebody else's
 * running application, and a patch that cannot be removed is a permanent
 * modification of it — the exact opposite of the reversibility AAP 0.5.1
 * requires and `../../tests/e2e/cleanup.spec.ts` asserts.
 *
 * 1. **Disarm before restoring.** {@link detachFetch} invalidates the attach
 *    cycle and clears `attached` before a single property is touched, and
 *    {@link restoreXhrPatch} releases the per-instance map whatever its
 *    restorations achieved. A patch that outlives its restoration therefore
 *    observes nothing: {@link isCurrentCycle} is false for every record,
 *    {@link noteOpen} and {@link planXhr} return immediately, and no event and
 *    no continuation can come out of it.
 * 2. **One guard per step.** Every read, every assignment and every reference
 *    drop sits in its own `try`. A property the page refuses to let us write
 *    can never skip the restoration of the next one — the defect this section
 *    was rewritten to remove.
 * 3. **Retain what did not restore.** A slot's record is dropped only after
 *    its own restoration has returned. A patch that is still installed is a
 *    patch this module still knows how to remove, so the next
 *    {@link detachFetch} tries again instead of having forgotten the original
 *    for the life of the document.
 * 4. **Publish before mutating.** The whole rollback state reaches module
 *    scope before the first assignment, so a throw part-way through an install
 *    has everything it needs to undo the assignments that did land.
 * 5. **Re-attaching repairs.** An install that finds its own retained patch
 *    still in place re-adopts it and keeps the original it already saved,
 *    instead of wrapping its own patch a second time — which would produce two
 *    events and two `traceparent` decisions per request and would put the
 *    host's own function permanently out of reach.
 * 6. **Never overwrite an unresolved original.** The XHR rollback state is a
 *    bounded list of per-prototype, per-slot {@link XhrPatchRecord}s
 *    ({@link xhrPatchRecords}) rather than one set of references to "the"
 *    prototype, because a page may replace the `XMLHttpRequest` constructor
 *    between two captures. An install on a new prototype appends; it cannot
 *    reach the records of an earlier one, so a patch whose restoration failed
 *    on the prototype the page discarded stays known, is retried at every
 *    detach and comes back out the moment the page allows it. At the bound the
 *    install is refused and reported rather than granted
 *    ({@link reserveXhrRecordRoom}) — a capture with no XHR signal is a stated
 *    gap, a stranded patch is a permanent modification of the developer's
 *    application.
 *
 * Every contained failure is also *stated*: `reportProducerFailure` posts a
 * bounded, sanitized `agent.error` frame so a capture that lost the network
 * signal is a capture known to have lost it (AAP 0.5.5), rather than one that
 * merely counts the loss in {@link FetchStats.failures}. The frames carry a
 * slot name and the thrown value's type — never a URL, a header, a body or a
 * message, which are the application's data and are not redacted on the
 * control channel.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a patched property currently holds what we think it holds, for a
 * check that must not throw either.
 *
 * The predicates handed to the two functions below read a property of a page
 * object, and a page can back a prototype property with a throwing getter. A
 * check that cannot be made is answered `false`, which is the conservative
 * direction in both callers: an install does not claim a patch, and a restore
 * keeps the references it would otherwise have dropped.
 */
function checkQuietly(predicate: () => boolean): boolean {
  try {
    return predicate();
  } catch {
    return false;
  }
}

/**
 * Perform one patched-property assignment and report whether our function is
 * in place afterwards.
 *
 * The verification read is not redundant with the `try`: a property backed by
 * a setter that ignores its argument accepts the assignment *without throwing*
 * and leaves the host's own function installed. Claiming that as a patch would
 * publish rollback state for a property this module never changed, and the
 * detach that followed would restore over — or count as foreign — a function
 * it had never fought with.
 *
 * @param stage Short, stable identifier of the slot, for the failure report.
 * No application data: a slot name only.
 * @param assign Performs the assignment. Whatever it throws is contained.
 * @param isInstalled Reads the property back and compares it, by identity,
 * with the function {@link assign} installs.
 * @returns Whether the property now holds this module's patch.
 */
function installPatchedSlot(
  stage: string,
  assign: () => void,
  isInstalled: () => boolean,
): boolean {
  try {
    assign();
    if (isInstalled()) {
      return true;
    }

    // Accepted and discarded. The page keeps its own function and this module
    // holds nothing here, which is a lost signal and so is reported.
    failureTotal += 1;
    reportProducerFailure('fetch', stage);
    return false;
  } catch (error: unknown) {
    // A sealed prototype, a non-writable property, a setter that throws. The
    // identity check decides whether anything landed *before* the throw — a
    // setter may take the value and then fail — because a patch that is
    // installed must be tracked whether or not the assignment reported success.
    failureTotal += 1;
    reportProducerFailure('fetch', stage, error);
    return checkQuietly(isInstalled);
  }
}

/**
 * Put one original back, if the property is still ours to put back.
 *
 * The three outcomes are the whole of rule 3: only `restored` and `foreign`
 * license the caller to forget the slot, and `retained` means our patch is
 * still installed and must stay known. See {@link RestoreOutcome}.
 *
 * @param stage Short, stable identifier of the slot, for the failure report.
 * @param isOurs Whether the property still holds the function this module
 * installed.
 * @param putBack Performs the restoring assignment.
 * @returns What the attempt achieved.
 */
function restorePatchedSlot(
  stage: string,
  isOurs: () => boolean,
  putBack: () => void,
): RestoreOutcome {
  try {
    if (!isOurs()) {
      // Another library patched over this module after it attached.
      // Overwriting theirs would uninstall a working instrumentation the
      // developer may depend on, so theirs is left in place and the anomaly is
      // counted in `FetchStats.failures`. It is an observation about the page
      // rather than a failure of this teardown, which is why it is counted and
      // not reported as a cleanup error.
      failureTotal += 1;
      return 'foreign';
    }

    putBack();

    if (isOurs()) {
      // The restoring assignment was swallowed by a setter that keeps its own
      // value: our patch is still installed, so its references are kept and
      // the next detach tries again.
      failureTotal += 1;
      reportProducerFailure('fetch', stage);
      return 'retained';
    }

    return 'restored';
  } catch (error: unknown) {
    // A frozen window or prototype, a cross-realm object at teardown, a
    // throwing accessor. Our patch is presumed still installed.
    failureTotal += 1;
    reportProducerFailure('fetch', stage, error);
    return 'retained';
  }
}

/**
 * Install the `fetch` patch on a window.
 *
 * Idempotent in the way that matters (rule 5): called while our own retained
 * patch is still on the window — which is the state a failed restoration
 * leaves — it re-adopts that patch and the original saved with it rather than
 * wrapping itself.
 *
 * @param target The window whose `fetch` is patched and whose receiver the
 * original is called with.
 * @returns Whether this module's patch is now installed on `target.fetch`.
 */
function installFetchPatch(target: Window & typeof globalThis): boolean {
  let current: unknown;
  try {
    // The original is deliberately kept unbound: it is re-invoked as
    // `Reflect.apply(original, receiver, args)` so the host sees its own
    // receiver and the caller's own argument list, and `restoreFetchPatch`
    // puts it back by identity — which a bound wrapper would defeat, since it
    // would install a function the host never had.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- kept unbound on purpose; called with an explicit receiver and restored by identity.
    current = target.fetch;
  } catch (error: unknown) {
    // A window that throws while reading `fetch`: the module simply does not
    // observe `fetch` here.
    failureTotal += 1;
    reportProducerFailure('fetch', 'fetch-read', error);
    return false;
  }

  if (typeof current !== 'function') {
    return false;
  }

  const held = installedFetch;
  if (host === target && held !== undefined && current === held && originalFetch !== undefined) {
    // Rule 5. The patch is live, the original behind it is still saved, and
    // the fresh attach cycle is enough to re-arm it.
    return true;
  }

  const original = current as FetchFn;
  const patched = createFetchPatch(original, target);

  // Rule 4: published before the assignment, so a host that takes the value
  // and *then* throws does not leave a patch nothing can restore.
  host = target;
  originalFetch = original;
  installedFetch = patched;

  const installed = installPatchedSlot(
    'fetch-install',
    () => {
      target.fetch = patched;
    },
    () => target.fetch === patched,
  );
  if (installed) {
    return true;
  }

  // Nothing of ours reached the window — a `fetch` that is a non-writable own
  // property, or a host that refused the assignment outright. The references
  // are dropped so a later detach neither restores over nor counts as foreign
  // a property this module never wrote.
  host = undefined;
  originalFetch = undefined;
  installedFetch = undefined;
  return false;
}

/**
 * Restore `window.fetch`, if it is still ours to restore.
 *
 * Nothing is dropped in a `finally`: the saved original is this module's only
 * route back to the host's own `fetch`, and forgetting it because the
 * assignment failed would make the patch permanent. On `retained` the
 * references stay exactly as they are, which both lets the next
 * {@link detachFetch} try again and lets {@link installFetchPatch} re-adopt
 * the patch instead of wrapping it.
 */
function restoreFetchPatch(): void {
  const target = host;
  const installed = installedFetch;
  const original = originalFetch;
  if (target === undefined || installed === undefined || original === undefined) {
    return;
  }

  const outcome = restorePatchedSlot(
    'fetch-restore',
    // An identity comparison, not a call: the reference is never invoked, and
    // `unbound-method` exempts a comparison for exactly that reason.
    () => target.fetch === installed,
    () => {
      target.fetch = original;
    },
  );

  if (outcome === 'retained') {
    return;
  }

  host = undefined;
  installedFetch = undefined;
  originalFetch = undefined;
}

/**
 * The record this module holds for one prototype property, newest first.
 *
 * Newest first because a foreign patch installed *over* a retained one leaves
 * two records for the same property: the older one is buried under someone
 * else's wrapper and can no longer be restored by identity, while the newer
 * one is the patch actually in the property. Adoption (rule 5) must consider
 * the newer one, and the caller confirms by identity in any case.
 *
 * Returns the union; the caller narrows with `record.slot === …`, which is
 * what gives `original` and `installed` their concrete function types without
 * a cast.
 *
 * @param prototype The prototype the record must belong to. A record for
 * another prototype is never returned, which is rule 6: an install on a
 * replaced constructor cannot see — and so cannot overwrite — the rollback
 * state of the prototype the page discarded.
 * @param slot Which property is being asked about.
 * @returns The most recent record for that prototype and property, or
 * `undefined` if this module holds none.
 */
function findXhrRecord(prototype: XMLHttpRequest, slot: XhrSlot): XhrPatchRecord | undefined {
  for (let index = xhrPatchRecords.length - 1; index >= 0; index -= 1) {
    const record = xhrPatchRecords[index];
    if (record !== undefined && record.prototype === prototype && record.slot === slot) {
      return record;
    }
  }
  return undefined;
}

/**
 * Forget one record, by identity.
 *
 * Called only where this module holds nothing in the property the record names
 * — an assignment that did not land, or a restoration that did — so that what
 * is retained is exactly what is still installed (rule 3).
 *
 * @param target The record to drop. Identity comparison, so a record for the
 * same prototype and slot installed since is left alone.
 */
function dropXhrRecord(target: XhrPatchRecord): void {
  xhrPatchRecords = xhrPatchRecords.filter((record) => record !== target);
}

/**
 * Put one record's original back, if its property is still ours to put back.
 *
 * The `switch` is the whole reason {@link XhrPatchRecord} is discriminated: in
 * each arm `installed` and `original` have the one function type the property
 * accepts, so the identity check and the restoring assignment need no cast and
 * no shared supertype.
 *
 * @param record The prototype, property, original and patch to reverse.
 * @returns What the attempt achieved; `retained` means the patch is still
 * installed and the record must be kept.
 */
function restoreXhrRecord(record: XhrPatchRecord): RestoreOutcome {
  const { prototype } = record;

  // The two references are read into locals inside each arm, not destructured
  // ahead of the `switch`: destructuring the union loses the discrimination,
  // and each arm needs the one function type its property accepts.
  switch (record.slot) {
    case 'open': {
      const { installed, original } = record;
      return restorePatchedSlot(
        'xhr-restore-open',
        () => prototype.open === installed,
        () => {
          prototype.open = original;
        },
      );
    }
    case 'send': {
      const { installed, original } = record;
      return restorePatchedSlot(
        'xhr-restore-send',
        () => prototype.send === installed,
        () => {
          prototype.send = original;
        },
      );
    }
    case 'setRequestHeader': {
      const { installed, original } = record;
      return restorePatchedSlot(
        'xhr-restore-set-request-header',
        () => prototype.setRequestHeader === installed,
        () => {
          prototype.setRequestHeader = original;
        },
      );
    }
  }
}

/**
 * Walk the records oldest first, restoring each and keeping only what did not
 * come back.
 *
 * Oldest first so that residue on a prototype the page has since replaced is
 * retried *before* the live prototype's own slots — it has been waiting
 * longest, and a page that unseals it (a mock removed, a library's own
 * teardown running) gets it back at the very next detach (rule 6).
 *
 * The list is snapshotted before the walk because every step calls into page
 * code — a setter on the prototype property — and the module state it would
 * re-enter is this list. Records the walk resolved are then removed by
 * identity, which leaves both the retained ones and anything a re-entrant
 * install appended in their install order.
 *
 * @param shouldAttempt Which records to try. The bound path passes a predicate
 * that excludes the prototype an install is about to adopt on, because
 * restoring a slot that install intends to re-adopt would leave it claiming a
 * patch that is no longer installed.
 */
function restoreXhrRecords(shouldAttempt: (record: XhrPatchRecord) => boolean): void {
  const walked = [...xhrPatchRecords];
  const resolved = new Set<XhrPatchRecord>();

  for (const record of walked) {
    if (!shouldAttempt(record)) {
      continue;
    }
    if (restoreXhrRecord(record) !== 'retained') {
      resolved.add(record);
    }
  }

  if (resolved.size === 0) {
    return;
  }

  xhrPatchRecords = xhrPatchRecords.filter((record) => !resolved.has(record));
}

/**
 * Decide whether an install has room for the records it needs, and make room
 * if it can.
 *
 * The bound exists because records are retained across a detach exactly when
 * the page refused a restoration, and a page can replace `XMLHttpRequest`
 * without limit. Its enforcement is the one place rule 6 has to choose between
 * two bad outcomes, and it chooses the visible one:
 *
 * 1. Room already available — install.
 * 2. Otherwise, retry the residue on *other* prototypes first. A record that
 *    finally restores frees its room, so the common case of one long-dead
 *    prototype whose property the page has since unsealed resolves itself here
 *    and the install proceeds. The prototype being installed on is excluded:
 *    its own records are what an adopting install re-adopts.
 * 3. Still no room — **refuse**. No patch is installed, the XHR signal is
 *    absent for this capture and says so through
 *    `reportProducerFailure('fetch', 'xhr-residue-bound')` (AAP 0.5.5), and
 *    every retained record keeps pointing at the original it can still put
 *    back. The alternative — dropping the oldest record to make room — would
 *    strand that patch in the developer's application for the life of the
 *    document, which is precisely the defect this design removes.
 *
 * @param prototype The prototype the install would patch.
 * @param adopted How many of the three slots are already installed and are
 * being re-adopted rather than assigned; each of those already has its record.
 * @returns Whether the install may proceed.
 */
function reserveXhrRecordRoom(prototype: XMLHttpRequest, adopted: number): boolean {
  const needed = XHR_SLOT_COUNT - adopted;
  if (xhrPatchRecords.length + needed <= MAX_XHR_PATCH_RECORDS) {
    return true;
  }

  restoreXhrRecords((record) => record.prototype !== prototype);

  if (xhrPatchRecords.length + needed <= MAX_XHR_PATCH_RECORDS) {
    return true;
  }

  failureTotal += 1;
  reportProducerFailure('fetch', 'xhr-residue-bound', undefined, {
    retained: xhrPatchRecords.length,
  });
  return false;
}

/**
 * The three originals and the three patches an install will use, decided
 * before anything is assigned.
 *
 * Deciding first is what makes rule 4 possible: the rollback state cannot be
 * published ahead of the first assignment unless every part of it is already
 * known, and `createSendPatch` must be given the *original*
 * `setRequestHeader` (see {@link planXhr}) rather than whatever the prototype
 * holds once patching has begun.
 */
interface XhrInstallPlan {
  /** The prototype the patches go on, read once. */
  readonly prototype: XMLHttpRequest;
  /** The `open` to restore, which for an adopted slot is the one already saved. */
  readonly originalOpen: XhrOpenFn;
  /** The `send` to restore. */
  readonly originalSend: XhrSendFn;
  /** The `setRequestHeader` to restore, and the one `send` injects through. */
  readonly originalSetRequestHeader: XhrSetRequestHeaderFn;
  /** The `open` patch to install, or the one already installed. */
  readonly patchedOpen: XhrOpenFn;
  /** The `send` patch to install, or the one already installed. */
  readonly patchedSend: XhrSendFn;
  /** The `setRequestHeader` patch to install, or the one already installed. */
  readonly patchedSetRequestHeader: XhrSetRequestHeaderFn;
  /**
   * Slots that already hold this module's patch from an earlier install whose
   * restoration failed, and are therefore re-adopted rather than assigned
   * (rule 5).
   */
  readonly adopted: ReadonlySet<XhrSlot>;
}

/**
 * Decide what an XHR install would do, without doing any of it.
 *
 * Returns `undefined` on a host with no `XMLHttpRequest`, or one whose three
 * methods are not all functions — the instrumentation needs the URL from
 * `open`, the application's own header from `setRequestHeader` and the start
 * from `send`, so a prototype missing any of them is not instrumented at all.
 */
function planXhrInstall(): XhrInstallPlan | undefined {
  try {
    if (typeof XMLHttpRequest === 'undefined') {
      return undefined;
    }

    const prototype = XMLHttpRequest.prototype;
    /* eslint-disable @typescript-eslint/unbound-method -- prototype methods
       are captured unbound on purpose: each is re-invoked with the calling
       instance as its receiver (`original.call(this, …)`) and restored by
       identity at detach. Binding them would break both. */
    const currentOpen: unknown = prototype.open;
    const currentSend: unknown = prototype.send;
    const currentSetRequestHeader: unknown = prototype.setRequestHeader;
    /* eslint-enable @typescript-eslint/unbound-method */

    if (
      typeof currentOpen !== 'function' ||
      typeof currentSend !== 'function' ||
      typeof currentSetRequestHeader !== 'function'
    ) {
      return undefined;
    }

    // Rule 5 applies per slot, and rule 6 confines it to the prototype the
    // record was taken on: a page that swapped the global constructor gets a
    // fresh install on the new prototype, and the records of the old one are
    // left untouched for a later detach to retry.
    const adopted = new Set<XhrSlot>();

    const openRecord = findXhrRecord(prototype, 'open');
    let originalOpenFn: XhrOpenFn;
    let patchedOpenFn: XhrOpenFn;
    if (
      openRecord !== undefined &&
      openRecord.slot === 'open' &&
      currentOpen === openRecord.installed
    ) {
      originalOpenFn = openRecord.original;
      patchedOpenFn = openRecord.installed;
      adopted.add('open');
    } else {
      originalOpenFn = currentOpen as XhrOpenFn;
      patchedOpenFn = createOpenPatch(originalOpenFn);
    }

    const headerRecord = findXhrRecord(prototype, 'setRequestHeader');
    let originalSetRequestHeaderFn: XhrSetRequestHeaderFn;
    let patchedSetRequestHeaderFn: XhrSetRequestHeaderFn;
    if (
      headerRecord !== undefined &&
      headerRecord.slot === 'setRequestHeader' &&
      currentSetRequestHeader === headerRecord.installed
    ) {
      originalSetRequestHeaderFn = headerRecord.original;
      patchedSetRequestHeaderFn = headerRecord.installed;
      adopted.add('setRequestHeader');
    } else {
      originalSetRequestHeaderFn = currentSetRequestHeader as XhrSetRequestHeaderFn;
      patchedSetRequestHeaderFn = createSetRequestHeaderPatch(originalSetRequestHeaderFn);
    }

    const sendRecord = findXhrRecord(prototype, 'send');
    let originalSendFn: XhrSendFn;
    let patchedSendFn: XhrSendFn;
    if (
      sendRecord !== undefined &&
      sendRecord.slot === 'send' &&
      currentSend === sendRecord.installed
    ) {
      originalSendFn = sendRecord.original;
      patchedSendFn = sendRecord.installed;
      adopted.add('send');
    } else {
      originalSendFn = currentSend as XhrSendFn;
      // The send patch injects through the *original* `setRequestHeader`, not
      // through the patch installed beside it; see `planXhr`. The original of
      // an adopted header slot is the one saved at its first install, which is
      // why that slot is resolved above this one.
      patchedSendFn = createSendPatch(originalSendFn, originalSetRequestHeaderFn);
    }

    return {
      prototype,
      originalOpen: originalOpenFn,
      originalSend: originalSendFn,
      originalSetRequestHeader: originalSetRequestHeaderFn,
      patchedOpen: patchedOpenFn,
      patchedSend: patchedSendFn,
      patchedSetRequestHeader: patchedSetRequestHeaderFn,
      adopted,
    };
  } catch (error: unknown) {
    // A prototype whose methods cannot be read, or a `createXPatch` that
    // failed: nothing has been mutated, so there is nothing to undo.
    failureTotal += 1;
    reportProducerFailure('fetch', 'xhr-plan-install', error);
    return undefined;
  }
}

/**
 * Install the three `XMLHttpRequest.prototype` patches.
 *
 * All three or none: the instrumentation needs the URL from `open`, the
 * application's own header from `setRequestHeader` and the start from `send`,
 * and a partial install would produce events with missing fields rather than
 * no events. A failure part-way through rolls back exactly the slots that
 * landed — which is only possible because each slot's {@link XhrPatchRecord}
 * reaches module state before its assignment (rule 4) and is dropped again
 * only when nothing of ours landed — and leaves this module **not** attached
 * to XHR.
 *
 * The records are appended, never overwritten (rule 6), so an install on a
 * prototype the page installed after a failed teardown cannot cost the
 * previous prototype its route back. {@link reserveXhrRecordRoom} is what
 * keeps that unbounded-looking promise bounded, and what refuses the install
 * when it cannot be kept.
 *
 * @returns Whether all three patches are now installed.
 */
function installXhrPatch(): boolean {
  try {
    const plan = planXhrInstall();
    if (plan === undefined) {
      return false;
    }

    const { prototype } = plan;

    if (!reserveXhrRecordRoom(prototype, plan.adopted.size)) {
      // Refused, reported, and nothing mutated: the capture has no XHR signal
      // rather than a patch this module could not promise to remove.
      return false;
    }

    // Rule 2: three independent assignments. Rule 4: each slot's record is in
    // module scope before its property is written, and is dropped again only
    // when the assignment left nothing of ours behind — so rollback state for
    // a property that was never changed is never mistaken for a patch. An
    // adopted slot is already installed and already has its record.
    let openInstalled = plan.adopted.has('open');
    if (!openInstalled) {
      const patched = plan.patchedOpen;
      const record: XhrPatchRecord = {
        prototype,
        slot: 'open',
        original: plan.originalOpen,
        installed: patched,
      };
      xhrPatchRecords.push(record);
      openInstalled = installPatchedSlot(
        'xhr-install-open',
        () => {
          prototype.open = patched;
        },
        () => prototype.open === patched,
      );
      if (!openInstalled) {
        dropXhrRecord(record);
      }
    }

    let sendInstalled = plan.adopted.has('send');
    if (!sendInstalled) {
      const patched = plan.patchedSend;
      const record: XhrPatchRecord = {
        prototype,
        slot: 'send',
        original: plan.originalSend,
        installed: patched,
      };
      xhrPatchRecords.push(record);
      sendInstalled = installPatchedSlot(
        'xhr-install-send',
        () => {
          prototype.send = patched;
        },
        () => prototype.send === patched,
      );
      if (!sendInstalled) {
        dropXhrRecord(record);
      }
    }

    let headerInstalled = plan.adopted.has('setRequestHeader');
    if (!headerInstalled) {
      const patched = plan.patchedSetRequestHeader;
      const record: XhrPatchRecord = {
        prototype,
        slot: 'setRequestHeader',
        original: plan.originalSetRequestHeader,
        installed: patched,
      };
      xhrPatchRecords.push(record);
      headerInstalled = installPatchedSlot(
        'xhr-install-set-request-header',
        () => {
          prototype.setRequestHeader = patched;
        },
        () => prototype.setRequestHeader === patched,
      );
      if (!headerInstalled) {
        dropXhrRecord(record);
      }
    }

    if (openInstalled && sendInstalled && headerInstalled) {
      // The map is created last, on the success path only: it is what arms the
      // patches (`noteOpen`, `planXhr`), so a rolled-back install never leaves
      // an armed patch behind.
      xhrStates = new WeakMap();
      return true;
    }

    // A partial patch is not an instrumentation, and leaving one installed
    // would be a change to the application this module could not undo. The
    // failing slot has already reported itself; this undoes exactly the slots
    // that landed, retaining anything that will not come back out so the next
    // detach can try again.
    restoreXhrPatch();
    return false;
  } catch (error: unknown) {
    // Structural: every step above guards itself, and this is the guarantee
    // that an install cannot throw into the page whatever a host does.
    failureTotal += 1;
    reportProducerFailure('fetch', 'xhr-install', error);
    restoreXhrPatch();
    return false;
  }
}

/**
 * Restore every `XMLHttpRequest.prototype` property this module still holds,
 * on every prototype it holds one on, each independently of the others.
 *
 * The prototypes come from {@link xhrPatchRecords} rather than from
 * `XMLHttpRequest.prototype` read again, because a page may have replaced the
 * global constructor — possibly several times — since the patches went on. The
 * methods to restore are the ones that were patched, not whichever object the
 * name now resolves to, and that includes the prototype of a constructor the
 * page has already discarded: its patch is still installed in it, so it is
 * still this module's to remove (rule 6).
 *
 * Nothing is dropped in a `finally`. A single `try` around all the
 * restorations, with the records released regardless of the outcome, is
 * precisely the shape that leaves methods patched for the life of the document
 * with their originals forgotten; each record is therefore dropped only after
 * its own restoration has returned (rule 3), and a record that did not come
 * back is retried at the next detach.
 */
function restoreXhrPatch(): void {
  restoreXhrRecords(() => true);

  // Rule 1, and unconditional: the per-instance map is what arms the patches,
  // so releasing it disarms even a patch that could not be removed — `noteOpen`
  // and `planXhr` both return immediately without it. It is also this module's
  // only reference to any request the developer made.
  xhrStates = undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Patch `fetch` and `XMLHttpRequest` so that requests carry trace context and
 * are recorded.
 *
 * Called by `./agent.ts` when the service arms the network hook through
 * `agent.config`, and never at import time — a page the developer is merely
 * browsing has both APIs exactly as the host provided them.
 *
 * **Idempotent.** A second call while attached does nothing, which matters
 * because an `agent.config` is re-sent after every reconnect: patching over
 * our own patch would produce two spans and two `traceparent` decisions per
 * request, and would make the original unrecoverable at detach.
 *
 * Each transport is installed independently, so a host that exposes only one
 * of them is still observed through that one. Without a `window` there is
 * nothing to patch, so the module stays detached and {@link isFetchAttached}
 * says so; the Node preload and the service import this package without ever
 * reaching this function.
 *
 * **Re-attaching repairs.** A previous detach that could not put a property
 * back leaves this module's patch installed *and known*; this call re-adopts
 * such a patch with the original already saved behind it, instead of wrapping
 * it a second time (see rule 5 of the installation section). That is why a
 * transport is reported installed only when its patch — every one of the three
 * XHR properties — is actually in place: a partial XHR patch is rolled back and
 * reported rather than counted as an attachment.
 *
 * Never throws. A failure part-way through detaches, so the module is either
 * fully attached or fully detached and never holds a patch it cannot restore.
 */
export function attachFetch(): void {
  try {
    if (attached || typeof window === 'undefined') {
      return;
    }

    // Advanced before anything is installed: every record planned from here
    // on belongs to this generation, and every record from a previous one is
    // already invalid (see `generation`).
    generation += 1;
    agentScriptUrl = detectAgentScriptUrl();

    const fetchInstalled = installFetchPatch(window);
    const xhrInstalled = installXhrPatch();
    attached = fetchInstalled || xhrInstalled;

    if (!attached) {
      // Neither transport could be patched. Release the little state that was
      // taken so the module is indistinguishable from never having attached,
      // and say so: a capture whose network signal is missing entirely must
      // not look like one that simply saw no requests (AAP 0.5.5).
      reportProducerFailure('fetch', 'attach-unavailable');
      detachFetch();
    }
  } catch (error: unknown) {
    failureTotal += 1;
    reportProducerFailure('fetch', 'attach', error);
    detachFetch();
  }
}

/**
 * Restore both transports and release everything held.
 *
 * Called by `./agent.ts` when the service clears the hooks — an `agent.config`
 * with every hook false, which AAP 0.5.1 requires to leave the agent
 * "disabled, not merely idled". Afterwards `window.fetch` and the three
 * `XMLHttpRequest.prototype` methods are the host's own functions again, this
 * module holds no reference to any request the developer made, and
 * `../../tests/e2e/cleanup.spec.ts`'s expectation that the application is left
 * as it was found holds for the two APIs it patches.
 *
 * **Requests already on the wire are left alone.** They complete normally and
 * deliver their responses to the application, and they report *nothing*: the
 * producer generation they were planned in is no longer current, so their
 * settle handlers emit no event and settle no continuation. An event that
 * arrived after the developer stopped the capture would be an observation of a
 * capture that had ended. That they *were* outstanding is reported before this
 * call, while the capture is still live: `./agent.ts` calls
 * {@link reportInFlightRequests} first, and this call then discards the list
 * of outstanding records with the generation it belonged to.
 *
 * **A property that will not come back out is retried, not forgotten.** Each
 * of the four is restored in its own guard, and one that fails keeps its saved
 * original so a later call can put it back — while this call still leaves the
 * module disarmed and detached, because {@link isFetchAttached} means
 * "observing" and a patch this module has stopped listening to observes
 * nothing. The failure is reported as an `agent.error` frame (AAP 0.5.5), so a
 * capture cannot end with a silently unremoved patch.
 *
 * Safe to call when already detached, and never throws.
 *
 * @see advanceFetchGeneration for the same invalidation *without* detaching,
 * which is what a move from one capture to the next needs.
 */
export function detachFetch(): void {
  try {
    // First, and unconditionally: together these disarm every patch still
    // installed — `isCurrentGeneration` is false for every in-flight record and
    // for every record a retained patch could still plan — and they must hold
    // even if a restore below fails.
    generation += 1;
    attached = false;

    restoreFetchPatch();
    restoreXhrPatch();
  } catch (error: unknown) {
    // Both restores guard their own bodies and each of their steps; this is the
    // structural guarantee that a teardown cannot throw into the agent's hook
    // handling.
    failureTotal += 1;
    reportProducerFailure('fetch', 'detach', error);
  } finally {
    inFlightCount = 0;
    // Cleared with the count it mirrors: every record in it belongs to the
    // generation that just ended, and a detached module holds no reference to
    // any request the developer made.
    outstandingRequests.clear();
    agentScriptUrl = undefined;
    attached = false;
  }
}

/**
 * Start a new producer generation, leaving both patches installed.
 *
 * Called by `./agent.ts`'s `arm()` when an `agent.config` moves the bound tab
 * from one capture to the next — a new `captureId` with the network hook still
 * enabled. Nothing may detach: the developer is still capturing requests, and
 * a detach/attach pair would restore and re-patch two of the application's
 * most heavily used APIs for no reason and would lose any request opened but
 * not yet sent. What must not survive the boundary is the *evidence* of the
 * capture that just ended. A request that went on the wire during capture A
 * settles during capture B; `./transport.ts` has already restarted its
 * sequence for B, so the event would be stamped with B's `captureId` and a
 * `seq` from B's sequence — AAP 0.2.3 scopes `seq` to
 * `(producerId, captureId)` — and capture A's request would be reported as
 * part of capture B's evidence, under a sequence number that belongs to
 * another event.
 *
 * Advancing the generation makes every record planned before this call stale,
 * which {@link isCurrentGeneration} already turns into the three guarantees
 * that matter: no event, no continuation settle, no counter movement.
 *
 * `inFlightCount` is zeroed for exactly the reason {@link detachFetch} zeroes
 * it. A stale record returns from {@link settleRequest} *before* the
 * decrement, so a count left standing would never come back down: it would
 * climb with every capture boundary until every later request was forwarded
 * uninstrumented against {@link MAX_IN_FLIGHT}, and a capture would silently
 * lose its requests. The number therefore describes the current generation and
 * not the document, which is what {@link FetchStats.inFlight} says.
 *
 * The list of outstanding records is cleared with the count, for the same
 * reason: every record in it has just become stale, and a stale record can
 * never again be reported. What those records were is reported *before* this
 * call — `./agent.ts`'s `arm()` calls {@link reportInFlightRequests} first,
 * while the transport still stamps the outgoing capture — so clearing the list
 * here loses no evidence.
 *
 * What this deliberately does **not** do is cancel the stale records' pending
 * continuations. `./agent.ts`'s `arm()` calls `resetContinuations()` in the
 * same capture-changed branch, which clears `./continuation.ts`'s maps
 * wholesale; walking the outstanding records to withdraw each span here would
 * be the same work done twice.
 *
 * Idempotent in the sense that matters — a second call starts a second
 * generation and leaves the same nothing in flight — safe to call while
 * detached, where there is nothing to invalidate and the module stays
 * detached, and it cannot throw: two counter writes and the clearing of a
 * module-owned `Set` have no failure mode, and arming must never fail on a
 * counter.
 */
export function advanceFetchGeneration(): void {
  generation += 1;
  inFlightCount = 0;
  outstandingRequests.clear();
}

/**
 * Report every request still on the wire, as one in-flight snapshot each.
 *
 * Called by `./agent.ts` at the two boundaries that end a capture while
 * requests may be outstanding — `disarm()`, before its flush, and `arm()` when
 * the capture changes, before {@link advanceFetchGeneration} — so each snapshot
 * is stamped with the capture the request belongs to. After either boundary
 * the request's own settle emits nothing (see {@link generation}), so without
 * this call a request that outlived its capture would leave no evidence at
 * all, and a consumer could only guess at it from a missing status code.
 *
 * For each current-generation record that has not settled, one event is
 * emitted through the same transport path a settle uses, with the record's own
 * span identity, the attributes decided when it started, no status code, span
 * status `unset`, {@link KEY_IN_FLIGHT} set to `true`, and the time it had
 * been outstanding as its duration. Every snapshot of one call describes the
 * same instant, read once, which is the capture boundary.
 *
 * What it deliberately leaves alone:
 *
 * - **The record is not settled** and its continuation is not touched. The
 *   request is still running in the application, and the boundary that follows
 *   this call is what makes its eventual settle report nothing and what resets
 *   continuations.
 * - **The in-flight count is not released.** That, too, is the boundary's job
 *   — it zeroes the count for the whole generation — and releasing it here
 *   would let a page's later requests be instrumented past
 *   {@link MAX_IN_FLIGHT} before the boundary had happened.
 *
 * The record is removed from the outstanding list, so a second call emits
 * nothing more. Should a request nevertheless settle in the same generation —
 * a caller that reports without a boundary following — its settled event
 * shares the snapshot's span, and `../aggregate/requests.ts` lets the settled
 * event supersede the snapshot rather than count the request twice.
 *
 * Never throws: each record is reported inside its own guard, and a failure
 * costs that record's snapshot, is counted in {@link getFetchStats}' `failures`
 * and is stated through `reportProducerFailure` (AAP 0.5.5). Safe to call while
 * detached, where the list is empty.
 *
 * @returns How many snapshots were handed to the transport.
 *
 * @example
 * ```ts
 * // At a capture boundary, before anything invalidates the generation:
 * reportInFlightRequests();
 * advanceFetchGeneration();
 * ```
 */
export function reportInFlightRequests(): number {
  let reported = 0;
  try {
    if (outstandingRequests.size === 0) {
      return 0;
    }

    // A copy, because each record is removed as it is visited; one clock read,
    // so every snapshot describes the same boundary.
    const records = [...outstandingRequests];
    const observedAt = nowEpochMs();

    for (const record of records) {
      try {
        // Removed first, so a record whose snapshot fails is not retried by a
        // later call and can never be reported twice.
        outstandingRequests.delete(record);
        if (record.settled || !isCurrentGeneration(record)) {
          continue;
        }
        emitInFlightSnapshot(record, observedAt);
        reported += 1;
      } catch (error: unknown) {
        failureTotal += 1;
        reportProducerFailure('fetch', 'in-flight-snapshot', error);
      }
    }
  } catch (error: unknown) {
    // Structural: every step above is guarded or cannot fail, and this is the
    // guarantee that a capture boundary never throws into the agent.
    failureTotal += 1;
    reportProducerFailure('fetch', 'in-flight-snapshot', error);
  }
  return reported;
}

/**
 * Whether the patches are installed right now.
 *
 * `./agent.ts` reports this in its readiness and status frames. `false` in a
 * context with no `window` even after {@link attachFetch} was called, because
 * nothing was patched there.
 */
export function isFetchAttached(): boolean {
  return attached;
}

/**
 * Whether the page still carries a patch this module's last detach could
 * not restore — a modification of the developer's application that outlived
 * the capture it was installed for.
 *
 * {@link isFetchAttached} answers "is this module *observing*", which is the
 * question the readiness and status frames ask and is `false` the moment
 * {@link detachFetch} has disarmed the patches. That deliberately says nothing
 * about whether the patches came *out*: a property the page refuses to let us
 * write is retained, retried at the next detach, and invisible to a caller
 * reading `isFetchAttached()` alone. This is the other half, and it is what
 * lets `./agent.ts` name `fetch` in its `hooks-not-released` announcement —
 * the developer is the only party who can act on residue, by reloading the
 * tab, and they can only act on what they are told (AAP 0.5.1, 0.5.5).
 *
 * `true` when this module holds an installed patch it has not been able to put
 * back:
 *
 * - `window.fetch` is still, by identity, the function this module installed,
 *   and the host's own `fetch` is still saved behind it; or
 * - any {@link XhrPatchRecord} is still outstanding — on the current
 *   `XMLHttpRequest.prototype` or on the prototype of a constructor the page
 *   has since replaced.
 *
 * `false` when everything this module installed has been restored, and
 * `false` while it is attached: a live patch during a capture is
 * instrumentation, not residue, and a caller that treated it as residue would
 * announce every armed capture as an unreleased hook. The corollary is that
 * residue is a *post-detach* reading — which is exactly when `./agent.ts`
 * takes it.
 *
 * Never throws and never mutates: every property read goes through
 * {@link checkQuietly}, because a page can back `window.fetch` with a throwing
 * getter and this question must still have an answer. An unanswerable read is
 * answered `false`, the same conservative direction the install and the
 * restore take.
 *
 * @returns Whether an unrestored patch of this module's is still installed in
 * the page.
 */
export function hasFetchResidue(): boolean {
  try {
    if (attached) {
      return false;
    }

    const target = host;
    const installed = installedFetch;
    if (
      target !== undefined &&
      installed !== undefined &&
      originalFetch !== undefined &&
      checkQuietly(() => target.fetch === installed)
    ) {
      return true;
    }

    // A record exists only for a property this module successfully wrote and
    // has not put back, so its mere presence after a detach is residue; see
    // `xhrPatchRecords`.
    return xhrPatchRecords.length > 0;
  } catch {
    // Structural. Nothing above can throw, and this is the guarantee that a
    // diagnostic question never becomes a failure of the page.
    return false;
  }
}

/**
 * A snapshot of this module's counters.
 *
 * Cheap enough to call on every render of a diagnostics view: it reads
 * module-scope numbers and allocates one small object. See {@link FetchStats}
 * for what each number counts and which of them survive a detach.
 */
export function getFetchStats(): FetchStats {
  return {
    inFlight: inFlightCount,
    injected: injectedTotal,
    skipped: skippedTotal,
    emitted: emittedTotal,
    failures: failureTotal,
  };
}
