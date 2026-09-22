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
import { emit, nowEpochMs, type EventDraft } from './transport.js';
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

/** Listener options for the XHR terminal listeners: fire once, never capture. */
const ONCE_OPTIONS: AddEventListenerOptions = { once: true };

/** The method assumed when a caller supplies none, matching `fetch`'s default. */
const DEFAULT_METHOD = 'GET';

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * A cheap, honest picture of the patch, for `./agent.ts`'s diagnostics and for
 * tests.
 *
 * `inFlight` is the current number of instrumented requests that have not
 * settled; it is reset by {@link detachFetch}, because a detached module is
 * observing nothing. Every other number is cumulative for the life of the
 * document, exactly as `./transport.ts`'s counters are, so a reader can tell
 * "forty requests were correlated and two were not" from "nothing has
 * happened yet".
 */
export interface FetchStats {
  /** Instrumented requests that have started and not yet settled. */
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
  /** Request events handed to `./transport.ts`, cumulative. */
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
  /** The attach cycle this record belongs to; see {@link isCurrentCycle}. */
  readonly cycle: number;
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

/** What was learned when a request settled. */
interface RequestOutcome {
  /** When it settled, in epoch milliseconds. */
  readonly settledAt: number;
  /** `ok` for a completed request, including 4xx and 5xx; `error` otherwise. */
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
 * Which attach cycle is current, incremented by **both**
 * {@link attachFetch} and {@link detachFetch}.
 *
 * This is how an in-flight request survives a detach without escaping it. A
 * record carries the cycle it was planned in; when it settles, a record from
 * any other cycle emits nothing and settles no continuation, so a capture that
 * the developer has stopped cannot be extended by a request that was already
 * on the wire (AAP 0.5.1). Incrementing on detach as well as on attach is what
 * makes that true across a stop/start pair, where a plain boolean would let a
 * request planned before the stop report into the capture after it.
 */
let cycle = 0;

/** This module's own script URL, for dropping its frames from a stack. */
let agentScriptUrl: string | undefined;

/** The window whose `fetch` was patched, and the receiver the original is called with. */
let host: (Window & typeof globalThis) | undefined;

/** The `fetch` this module installed, for the identity check at detach. */
let installedFetch: FetchFn | undefined;

/** The `fetch` that was there before, restored at detach. */
let originalFetch: FetchFn | undefined;

/** The prototype whose methods were patched, held so a later global swap cannot misdirect the restore. */
let xhrPrototype: XMLHttpRequest | undefined;

/** The `open` this module installed. */
let installedOpen: XhrOpenFn | undefined;

/** The `open` that was there before. */
let originalOpen: XhrOpenFn | undefined;

/** The `send` this module installed. */
let installedSend: XhrSendFn | undefined;

/** The `send` that was there before. */
let originalSend: XhrSendFn | undefined;

/** The `setRequestHeader` this module installed. */
let installedSetRequestHeader: XhrSetRequestHeaderFn | undefined;

/** The `setRequestHeader` that was there before. */
let originalSetRequestHeader: XhrSetRequestHeaderFn | undefined;

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
 * Whether a record still belongs to the live attach cycle.
 *
 * The guard on every settle path. A record from an earlier cycle belongs to a
 * capture that has been stopped, and the contract is that nothing escapes a
 * stopped capture: no event, no continuation, no counter movement.
 */
function isCurrentCycle(record: RequestRecord): boolean {
  return attached && record.cycle === cycle;
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
 * Resolve a URL against the document, for the origin test and the label.
 *
 * Returns `undefined` rather than throwing for a URL no parser accepts and for
 * a host with no `URL` or no `location` (the Node preload imports this
 * package, and a worker context has neither in the same shape). The caller
 * treats an unresolvable URL as cross-origin: a request whose origin cannot be
 * established must not receive a correlation id.
 */
function resolveAbsolute(url: string): URL | undefined {
  try {
    if (typeof URL === 'undefined' || typeof location === 'undefined') {
      return undefined;
    }
    return new URL(url, location.href);
  } catch {
    // A malformed or exotic URL is the application's business; ours is only to
    // decline to inject into it.
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
 * This module's own frames are dropped first (see
 * {@link AGENT_FRAME_FALLBACK}), then at most {@link MAX_INITIATOR_FRAMES}
 * frames and {@link MAX_INITIATOR_CHARS} characters are kept. `undefined` when
 * the host produced no stack or nothing survived the drop, because an empty
 * `initiator` would be a claim of an unknown call site rather than an absence
 * of one — and `../aggregate/requests.ts` reads a blank value as absent
 * anyway.
 */
function captureInitiatorStack(): string | undefined {
  try {
    const stack = new Error().stack;
    if (typeof stack !== 'string' || stack === '') {
      return undefined;
    }

    const frames = stack.split('\n').filter(isFrameLine);

    let start = 0;
    if (agentScriptUrl !== undefined) {
      while (start < frames.length && (frames[start] ?? '').includes(agentScriptUrl)) {
        start += 1;
      }
    }
    if (start === 0) {
      start = Math.min(AGENT_FRAME_FALLBACK, frames.length);
    }

    const kept = frames.slice(start, start + MAX_INITIATOR_FRAMES);
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
    cycle,
    kind: input.kind,
    traceId: input.context.traceId,
    spanId: input.spanId,
    parentSpanId: input.context.parentSpanId,
    lineageAttributes: input.context.attributes,
    method: input.method,
    url: input.url,
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
 * `../schema/attributes.ts`; the three invented ones are documented at their
 * constants. A value that is unknown for this request is **omitted rather
 * than sent as `null`**, which is how the rest of this folder says "not
 * observed". Notably absent: `transferSize`, which only
 * `PerformanceResourceTiming` can supply and which `./perf.ts` owns (AAP
 * 0.6.6), and `request_key`, which the service computes at ingest from the
 * unredacted URL and which a producer must never set.
 */
function buildAttributes(record: RequestRecord, outcome: RequestOutcome): Record<string, unknown> {
  const attributes: Record<string, unknown> = { ...record.lineageAttributes };

  attributes[KEY_METHOD] = record.method;
  attributes[KEY_URL] = record.url;
  attributes[KEY_SAME_ORIGIN] = record.sameOrigin;
  attributes[KEY_TRACEPARENT_INJECTED] = record.injected;

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
 * neither checks nor knows about the capture state; the attach cycle is the
 * only gate applied here (see {@link settleRequest}).
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
 * Account for a settled request: emit its event and close its continuation
 * window.
 *
 * Idempotent, because a settle can be observed twice — a `fetch` whose caller
 * attached both a fulfilment and a rejection handler, an XHR that fires
 * `abort` and then `loadend` — and a second event would double every request
 * count in the capture.
 *
 * Nothing is reported for a record from an earlier attach cycle: the capture
 * it belonged to has stopped, and AAP 0.5.1 requires a stopped capture to
 * receive nothing. Such a record is still marked settled, so it can never be
 * reconsidered.
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

    if (!isCurrentCycle(record)) {
      return;
    }

    inFlightCount = inFlightCount > 0 ? inFlightCount - 1 : 0;
    emitRequestEvent(record, outcome);

    if (record.continuation) {
      settleContinuation(record.spanId, outcome.settledAt);
    }
  } catch {
    // The settle path runs inside the application's own promise chain and its
    // event listeners, so a failure here costs one event and never the
    // request it describes.
    failureTotal += 1;
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
 */
function abandonRequest(record: RequestRecord): void {
  try {
    if (record.settled) {
      return;
    }
    record.settled = true;

    if (isCurrentCycle(record)) {
      inFlightCount = inFlightCount > 0 ? inFlightCount - 1 : 0;
    }
    if (record.continuation) {
      cancelPendingContinuation(record.spanId);
    }
  } catch {
    // Best effort by construction: both steps above are independent.
    failureTotal += 1;
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
  } catch {
    // An opaque or exotic response object still produces an event; the two
    // fields above are simply absent from it.
    failureTotal += 1;
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
  } catch {
    // A host that throws while reading `status` in this state leaves the code
    // absent, which the `error` status below already implies.
    failureTotal += 1;
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
 * The settle handlers `return response` and `throw error` rather than
 * producing values of their own, so the promise this function returns settles
 * with **the same** `Response` instance or **the same** rejection reason the
 * original produced. A caller that compares identity, or that matches on
 * `error.name`, cannot tell the difference.
 */
function createFetchPatch(original: FetchFn, receiver: Window & typeof globalThis): FetchFn {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let plan: FetchPlan | undefined;
    try {
      plan = planFetch(input, init);
    } catch {
      // Any failure in planning costs the observation, never the request: the
      // application's own arguments are forwarded below as if this module were
      // not installed.
      failureTotal += 1;
      plan = undefined;
    }

    if (plan === undefined) {
      return original.call(receiver, input, init);
    }

    const { record } = plan;
    let pending: Promise<Response>;
    try {
      pending = original.call(receiver, plan.callInput, plan.callInit);
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
 */
function noteOpen(xhr: XMLHttpRequest, method: string, url: string | URL): void {
  const states = xhrStates;
  if (states === undefined) {
    return;
  }
  states.set(xhr, {
    method: normalizeMethod(method),
    url: readUrlString(url),
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
  const resolved = resolveAbsolute(state.url);
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
  } catch {
    // A host or a page that refuses a listener on this object costs the
    // request its event; the send below still happens.
    failureTotal += 1;
    abandonRequest(record);
  }
}

/**
 * Build the replacement for `XMLHttpRequest.prototype.open`.
 *
 * Every argument is forwarded. The two-argument form is forwarded as such, and
 * the longer form normalises only `undefined` to the values the specification
 * itself defaults to (`async` is `true`, `username` and `password` are
 * `null`), so the request the host sees is the request the application asked
 * for.
 */
function createOpenPatch(original: XhrOpenFn): XhrOpenFn {
  return function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: [async?: boolean, username?: string | null, password?: string | null]
  ): void {
    try {
      noteOpen(this, method, url);
    } catch {
      // A page that hands `open` an exotic method or URL object still gets its
      // request opened; only the observation is lost.
      failureTotal += 1;
    }

    // One call form for both arities, and identical to either by
    // specification: `open()` declares `optional boolean async = true` and
    // `optional USVString? username = null` / `password = null`, and WebIDL
    // resolves an `undefined` argument to a declared default. So
    // `open(m, u)`, `open(m, u, undefined)` and `open(m, u, true, null, null)`
    // are the same request, which is what lets the arguments be forwarded
    // through a single typed call instead of through `arguments`.
    original.call(this, method, url, rest[0] ?? true, rest[1] ?? null, rest[2] ?? null);
  };
}

/**
 * Build the replacement for `XMLHttpRequest.prototype.setRequestHeader`.
 *
 * Reads the header **name** only, and only to compare it with
 * `traceparent` — a header value set by the application is never read, copied
 * or transported, which is what keeps an `Authorization` header out of this
 * module entirely. The call is always forwarded, unchanged, whatever the
 * comparison said.
 */
function createSetRequestHeaderPatch(original: XhrSetRequestHeaderFn): XhrSetRequestHeaderFn {
  return function patchedSetRequestHeader(this: XMLHttpRequest, name: string, value: string): void {
    try {
      if (typeof name === 'string' && name.toLowerCase() === TRACEPARENT_HEADER) {
        const state = xhrStates?.get(this);
        if (state !== undefined) {
          state.explicitTraceparent = true;
        }
      }
    } catch {
      // The worst case of a failure here is that this module injects its own
      // header over an application header it failed to notice, which
      // `injectIntoRequest`'s equivalent check makes impossible for `fetch`
      // and which the host resolves for XHR by keeping both values.
      failureTotal += 1;
    }

    original.call(this, name, value);
  };
}

/**
 * Build the replacement for `XMLHttpRequest.prototype.send`.
 *
 * The body is forwarded without being inspected, and the no-argument form is
 * forwarded as such. Instrumentation happens strictly before the forward, so
 * the `traceparent` header is set while the request is still in the state that
 * accepts headers.
 */
function createSendPatch(original: XhrSendFn, setHeader: XhrSetRequestHeaderFn): XhrSendFn {
  return function patchedSend(
    this: XMLHttpRequest,
    ...rest: [body?: Document | XMLHttpRequestBodyInit | null]
  ): void {
    let record: RequestRecord | undefined;
    try {
      record = planXhr(this, setHeader);
    } catch {
      // As for `fetch`: the observation is lost, the request is not.
      failureTotal += 1;
      record = undefined;
    }

    if (record !== undefined) {
      observeXhr(this, record);
    }

    try {
      // One call form for both arities, as in `open`: `send()` declares
      // `optional (Document or XMLHttpRequestBodyInit)? body = null`, so an
      // `undefined` argument resolves to the same `null` an omitted one does.
      // The body itself is never inspected.
      original.call(this, rest[0]);
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
}

/*
 * ---------------------------------------------------------------------------
 * Installation and restoration
 *
 * Four patched properties, installed independently and restored
 * independently. The restore of each is guarded by an identity check, because
 * "put the original back" and "put *our* original back over whatever is there
 * now" are different operations and only the first is correct.
 * ---------------------------------------------------------------------------
 */

/**
 * Install the `fetch` patch on a window.
 *
 * @returns Whether the patch is now installed.
 */
function installFetchPatch(target: Window & typeof globalThis): boolean {
  try {
    // The original is deliberately kept unbound: it is re-invoked as
    // `original.call(receiver, …)` so the host sees its own receiver, and
    // `restoreFetchPatch` puts it back by identity — which a bound wrapper
    // would defeat, since it would install a function the host never had.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- kept unbound on purpose; called with an explicit receiver and restored by identity.
    const current: unknown = target.fetch;
    if (typeof current !== 'function') {
      return false;
    }

    const original = current as FetchFn;
    const patched = createFetchPatch(original, target);
    target.fetch = patched;

    host = target;
    originalFetch = original;
    installedFetch = patched;
    return true;
  } catch {
    // A window whose `fetch` is a non-writable own property, or a host that
    // throws on assignment: the module simply does not observe `fetch` here.
    failureTotal += 1;
    host = undefined;
    originalFetch = undefined;
    installedFetch = undefined;
    return false;
  }
}

/**
 * Restore `window.fetch`, if it is still ours to restore.
 *
 * A mismatch means another library patched over this module after it
 * attached. Overwriting theirs would uninstall a working instrumentation the
 * developer may depend on, so theirs is left in place and the anomaly is
 * counted in {@link FetchStats.failures} — visible in the agent's diagnostics
 * rather than silent.
 */
function restoreFetchPatch(): void {
  try {
    const target = host;
    const installed = installedFetch;
    const original = originalFetch;
    if (target === undefined || installed === undefined || original === undefined) {
      return;
    }

    // An identity comparison, not a call: the reference is never invoked, and
    // `unbound-method` exempts a comparison for exactly that reason.
    if (target.fetch === installed) {
      target.fetch = original;
    } else {
      failureTotal += 1;
    }
  } catch {
    // A frozen or cross-realm window at teardown; the references are dropped
    // by the caller either way.
    failureTotal += 1;
  } finally {
    host = undefined;
    installedFetch = undefined;
    originalFetch = undefined;
  }
}

/**
 * Install the three `XMLHttpRequest.prototype` patches.
 *
 * All three or none: the instrumentation needs the URL from `open`, the
 * application's own header from `setRequestHeader` and the start from `send`,
 * and a partial install would produce events with missing fields rather than
 * no events. A failure part-way through rolls the whole thing back.
 *
 * @returns Whether the patches are now installed.
 */
function installXhrPatch(): boolean {
  try {
    if (typeof XMLHttpRequest === 'undefined') {
      return false;
    }

    const prototype = XMLHttpRequest.prototype;
    /* eslint-disable @typescript-eslint/unbound-method -- prototype methods
       are captured unbound on purpose: each is re-invoked with the calling
       instance as its receiver (`original.call(this, …)`) and restored by
       identity at detach. Binding them would break both. */
    const open: unknown = prototype.open;
    const send: unknown = prototype.send;
    const setRequestHeader: unknown = prototype.setRequestHeader;
    /* eslint-enable @typescript-eslint/unbound-method */

    if (
      typeof open !== 'function' ||
      typeof send !== 'function' ||
      typeof setRequestHeader !== 'function'
    ) {
      return false;
    }

    const originalOpenFn = open as XhrOpenFn;
    const originalSendFn = send as XhrSendFn;
    const originalSetRequestHeaderFn = setRequestHeader as XhrSetRequestHeaderFn;

    const patchedOpen = createOpenPatch(originalOpenFn);
    const patchedSetRequestHeader = createSetRequestHeaderPatch(originalSetRequestHeaderFn);
    // The send patch injects through the *original* `setRequestHeader`, not
    // through the patch installed below; see `planXhr`.
    const patchedSend = createSendPatch(originalSendFn, originalSetRequestHeaderFn);

    prototype.open = patchedOpen;
    prototype.send = patchedSend;
    prototype.setRequestHeader = patchedSetRequestHeader;

    xhrPrototype = prototype;
    originalOpen = originalOpenFn;
    originalSend = originalSendFn;
    originalSetRequestHeader = originalSetRequestHeaderFn;
    installedOpen = patchedOpen;
    installedSend = patchedSend;
    installedSetRequestHeader = patchedSetRequestHeader;
    xhrStates = new WeakMap();
    return true;
  } catch {
    // A sealed prototype, or a host that rejects one of the assignments: undo
    // whatever landed so the page is left exactly as it was.
    failureTotal += 1;
    restoreXhrPatch();
    return false;
  }
}

/**
 * Restore the three `XMLHttpRequest.prototype` methods, each only if it is
 * still ours.
 *
 * The prototype captured at install is used rather than
 * `XMLHttpRequest.prototype` read again, because a page may have replaced the
 * global constructor in between — in which case the methods to restore are
 * the ones that were patched, not whichever object the name now resolves to.
 */
function restoreXhrPatch(): void {
  const prototype = xhrPrototype;
  try {
    if (prototype === undefined) {
      return;
    }

    // Every read below is an identity comparison rather than a call, so no
    // receiver is ever lost and nothing is invoked unbound.
    if (installedOpen !== undefined && originalOpen !== undefined) {
      if (prototype.open === installedOpen) {
        prototype.open = originalOpen;
      } else {
        failureTotal += 1;
      }
    }

    if (installedSend !== undefined && originalSend !== undefined) {
      if (prototype.send === installedSend) {
        prototype.send = originalSend;
      } else {
        failureTotal += 1;
      }
    }

    if (installedSetRequestHeader !== undefined && originalSetRequestHeader !== undefined) {
      if (prototype.setRequestHeader === installedSetRequestHeader) {
        prototype.setRequestHeader = originalSetRequestHeader;
      } else {
        failureTotal += 1;
      }
    }
  } catch {
    // Each restore above is independent, so a failure in one leaves the
    // others done; the references are dropped below regardless.
    failureTotal += 1;
  } finally {
    xhrPrototype = undefined;
    installedOpen = undefined;
    originalOpen = undefined;
    installedSend = undefined;
    originalSend = undefined;
    installedSetRequestHeader = undefined;
    originalSetRequestHeader = undefined;
    xhrStates = undefined;
  }
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
 * Never throws. A failure part-way through detaches, so the module is either
 * fully attached or fully detached and never holds a patch it cannot restore.
 */
export function attachFetch(): void {
  try {
    if (attached || typeof window === 'undefined') {
      return;
    }

    // Bumped before anything is installed: every record planned from here on
    // belongs to this cycle, and every record from a previous one is already
    // invalid (see `cycle`).
    cycle += 1;
    agentScriptUrl = detectAgentScriptUrl();

    const fetchInstalled = installFetchPatch(window);
    const xhrInstalled = installXhrPatch();
    attached = fetchInstalled || xhrInstalled;

    if (!attached) {
      // Neither transport could be patched. Release the little state that was
      // taken so the module is indistinguishable from never having attached.
      detachFetch();
    }
  } catch {
    failureTotal += 1;
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
 * attach cycle they were planned in is no longer current, so their settle
 * handlers emit no event and settle no continuation. An event that arrived
 * after the developer stopped the capture would be an observation of a capture
 * that had ended.
 *
 * Safe to call when already detached, and never throws.
 */
export function detachFetch(): void {
  try {
    // First, and unconditionally: this is what invalidates every in-flight
    // record, and it must hold even if a restore below fails.
    cycle += 1;

    restoreFetchPatch();
    restoreXhrPatch();
  } catch {
    // Both restores guard their own bodies; this is the structural guarantee
    // that a teardown cannot throw into the agent's hook handling.
    failureTotal += 1;
  } finally {
    inFlightCount = 0;
    agentScriptUrl = undefined;
    attached = false;
  }
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
