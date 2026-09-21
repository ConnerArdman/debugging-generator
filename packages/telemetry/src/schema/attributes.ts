/**
 * The attribute-key catalog: the single declaration of *which keys appear in a
 * telemetry event's `attributes` bag for each kind*, of the small value
 * vocabularies those keys draw on, and of the two bounds that cap what a
 * summarised value may carry.
 *
 * Treat this as a published contract rather than an internal note. Two
 * consumers read it directly — `packages/panel-schema/src/catalog.ts`, which
 * declares each panel node's `reads` list from {@link KIND_ATTRIBUTE_KEYS},
 * and `../aggregate/*`, which reads event fields by these exact key strings
 * (AAP 0.2.3, 0.6.2) — and `../browser/*` plus `../node/*` write them. A key
 * spelled one way here and another way at a producer or a consumer does not
 * fail loudly: it yields an empty column in a generated panel, which is
 * precisely the failure this file exists to prevent by fixing every spelling
 * in one place.
 *
 * ## Key-naming rule (do not "tidy" these names)
 *
 * **Dotted keys are OpenTelemetry-derived and keep the spellings the plan
 * fixed.** `http.method`, `url`, `http.status_code`, `db.system`,
 * `db.statement`, `db.rowCount` and the framework's `next.*` keys are written
 * exactly as AAP 0.2.3 and 0.6.2 write them. These are deliberately the
 * *older* semantic-convention spellings: current semantic conventions would
 * say `http.request.method`, `http.response.status_code`, `db.query.text` and
 * `db.system.name`, and have no equivalent of `db.rowCount` at all. The panel
 * components and the aggregates read these exact strings, so the canonical
 * spelling is the one declared below — and `../node/convert.ts` owns the job
 * of mapping whatever key spellings the installed OpenTelemetry
 * instrumentations happen to emit onto these canonical keys. Nothing
 * downstream of that conversion ever sees an instrumentation's own spelling,
 * and nothing downstream may be changed to accommodate one.
 *
 * **Product-owned keys are camelCase.** `component`, `phase`, `renderCount`,
 * `changedProps`, `trigger`, `initiator`, `lineage`, `lineageAmbiguous`,
 * `lineageCandidates`, `hookIndex` and the rest describe things no
 * specification names, so they follow the repository's own convention rather
 * than borrowing a dotted namespace they do not belong to.
 *
 * **Exactly one key keeps an underscore: `request_key`.** It is the name of
 * the `telemetry_events` store column and of the grouping key that duplicate
 * detection is computed from (AAP 0.4.2, 0.5.2). Camel-casing it here would
 * split one concept across three spellings — column, group key and
 * attribute — so it stays as it is.
 *
 * ## The bag is open
 *
 * `attributes` is `Record<string, unknown>` on the event schema in
 * `./event.ts`. The catalog below declares the keys the product *relies on* —
 * the ones a producer is expected to set and a consumer may look for — and is
 * **not** an exhaustive whitelist. An event carrying a key this module never
 * mentions is well-formed: an unknown key is never a validation error, and the
 * redaction layer is written for keys it has never seen (see
 * `../redaction/headers.ts`, which recognises dotted header keys the catalog
 * does not list).
 *
 * ## Declaration-only, and dependency-free
 *
 * This module declares; it does not act. No summarising, no truncation, no
 * redaction, no classification happens here: the value summariser lives in
 * `../browser/fiber-diff.ts`, the scrub-and-truncate primitives in
 * `../redaction/rules.ts`, and the per-event redaction pass in
 * `../redaction/redactor.ts`. What lives here is `const` tuples, derived
 * types, two frozen lookups and one total accessor.
 *
 * Its only import is `./kinds.js`, and that is a constraint rather than an
 * accident. The page-injected agent needs these keys, vocabularies and bounds
 * **at runtime**, and its bundle audit fails the build when an input resolves
 * to a schema library, a cross-package runtime dependency or a Node builtin.
 * Keeping this module free of a schema library is what makes the agent bundle
 * legal; validation of an event against these declarations belongs to
 * `./event.ts`, which may import one.
 *
 * ## Deliberately absent
 *
 * There is no per-kind typed `attributes` interface. Every event crosses a
 * process boundary as JSON and its bag arrives as `Record<string, unknown>`;
 * a typed per-kind view would be reachable only through an unchecked cast,
 * trading a narrowing check at the read site for a silent lie — and the
 * redactor may legitimately have removed or replaced any value on the way.
 * Consumers therefore narrow what they read (`typeof value === 'number'`) and
 * use the key constants below to know what to look for.
 * {@link AttributeValueSummary} and {@link ChangedPropEntry} are the
 * exception: they are shapes a producer *constructs*, so they are declared as
 * types.
 *
 * Every constant is frozen and every lookup is read-only: this is a
 * vocabulary, not state.
 */

import { TELEMETRY_KINDS, type TelemetryKind } from './kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Per-kind attribute keys
 *
 * One frozen tuple per kind, in the declaration order of `TELEMETRY_KINDS`,
 * each naming the producer that sets the keys and the consumer that reads
 * them. The tuples keep their literal `as const` types so a derived key union
 * is available to a caller that wants one; a membership test against an
 * arbitrary string goes through `attributeKeysFor(kind)` instead, whose result
 * is widened to `readonly string[]`.
 *
 * The keys a tuple lists are the ones the product relies on for that kind.
 * None is guaranteed present on a given event: a producer sets what it can
 * observe, and the redaction pass may drop a value it cannot make safe.
 * ---------------------------------------------------------------------------
 */

/**
 * `interaction` — the user-interaction root span.
 *
 * Written by `../browser/interaction.ts`, which pairs the capture-phase
 * listener with the `PerformanceObserver('event')` entry for the same
 * interaction: `interactionId`, `inputDelay`, `processingStart` and
 * `processingEnd` are that entry's fields, carried through so a slow handler
 * can be told apart from a handler that merely started late. `event.type`,
 * `target.selector`, `target.tagName` and `target.text` describe what was
 * interacted with — `target.text` truncated and scrubbed like any other
 * preview — and `componentChain` is the React owner chain resolved for that
 * element by `../browser/dom-target.ts`, the same descriptor shape the panel's
 * target selection carries (AAP 0.4.2).
 *
 * Read by `../aggregate/timeline.ts` and the `timeline` and `eventLog` panel
 * nodes.
 */
export const INTERACTION_ATTRIBUTE_KEYS = Object.freeze([
  'event.type',
  'target.selector',
  'target.tagName',
  'target.text',
  'componentChain',
  'interactionId',
  'inputDelay',
  'processingStart',
  'processingEnd',
] as const);

/**
 * `render` — one fiber that a React commit actually rendered.
 *
 * Written by `../browser/react.ts` from the fiber hook's commit traversal,
 * with `changedProps` and `trigger` computed by `../browser/fiber-diff.ts`
 * (shallow prop comparison, own hook state, consumed context values).
 * `actualDuration` is the fiber's own reported render time and `selfTime` its
 * cost excluding descendants; `ownerChain` is the owner path up from the
 * rendered fiber, which is what lets the component-tree snapshot be rebuilt
 * from a flat event list. `renderCount` is the running count for that
 * component within the capture, so a single event is enough to show how often
 * the component rendered.
 *
 * Read by `../aggregate/renders.ts` and the `renderTable` and `componentTree`
 * panel nodes: component, render count, total and average time, trigger and
 * changed props (AAP 0.6.2). `trigger` additionally drives the
 * `unchanged_render_count` and `render_trigger_unknown_count` metrics — see
 * {@link RENDER_TRIGGERS} for why those two are not the same thing.
 */
export const RENDER_ATTRIBUTE_KEYS = Object.freeze([
  'component',
  'phase',
  'renderCount',
  'changedProps',
  'trigger',
  'actualDuration',
  'ownerChain',
  'selfTime',
] as const);

/**
 * `commit` — one React commit, the parent span of that commit's `render`
 * events.
 *
 * Written by `../browser/react.ts` in the fiber hook's commit callback.
 * `renderCount` here is the number of fibers the commit rendered (not a
 * per-component count), and `rootName` identifies the root that committed,
 * which distinguishes concurrent roots on one page.
 *
 * Read by `../aggregate/renders.ts` (renders per commit) and the `timeline`
 * node, which draws a commit as the band its renders sit inside.
 */
export const COMMIT_ATTRIBUTE_KEYS = Object.freeze(['phase', 'renderCount', 'rootName'] as const);

/**
 * `fetch` — a call through the patched `window.fetch`.
 *
 * Written by `../browser/fetch.ts`. `initiator` is the call site resolved from
 * a stack captured at the call (mapped back to project source through the
 * source-map route), and `transferSize` is filled from the matching resource
 * timing where one is observable, which feeds the `transferred_bytes` metric —
 * available for same-origin resource timing only (AAP 0.6.6).
 *
 * `sameOrigin` and `traceparentInjected` are recorded because the agent
 * injects `traceparent` only on a same-origin request while an interaction
 * window is open (AAP 0.4.2). Without them, a request with no server span
 * looks like a lost span; with them, the panel can say that no header was
 * injected and why, instead of leaving a silent gap.
 *
 * `request_key` is assigned at ingest, never by this producer — see
 * {@link SERVICE_ASSIGNED_ATTRIBUTE_KEYS}.
 *
 * Read by `../aggregate/requests.ts` (grouping and duplicate detection) and
 * the `requestTable`, `waterfall` and `timeline` panel nodes.
 */
export const FETCH_ATTRIBUTE_KEYS = Object.freeze([
  'http.method',
  'url',
  'http.status_code',
  'initiator',
  'request_key',
  'sameOrigin',
  'traceparentInjected',
  'transferSize',
] as const);

/**
 * `xhr` — a request through the patched `XMLHttpRequest`.
 *
 * Mirrors {@link FETCH_ATTRIBUTE_KEYS} key for key: both kinds describe a
 * request the page made, and every consumer treats them together (the request
 * group of `./kinds.ts` holds both). The tuple is declared separately rather
 * than aliased so the two can diverge if one transport ever exposes something
 * the other cannot, and so a reader of this catalog sees the keys for the kind
 * they looked up.
 *
 * Written by `../browser/fetch.ts`, which patches both transports; read by the
 * same aggregates and panel nodes as `fetch`.
 */
export const XHR_ATTRIBUTE_KEYS = Object.freeze([
  'http.method',
  'url',
  'http.status_code',
  'initiator',
  'request_key',
  'sameOrigin',
  'traceparentInjected',
  'transferSize',
] as const);

/**
 * `navigation` — the document's `PerformanceNavigationTiming` entry.
 *
 * Written by `../browser/perf.ts` when the agent is armed on a document.
 * `navigation.type` is the entry's type (a fresh load, a reload, a
 * back/forward restore), which is what tells a capture that spans a reload
 * apart from one that does not, and `domContentLoaded` and `loadEventEnd` are
 * the two milestones the timeline marks.
 *
 * Read by `../aggregate/timeline.ts` and the `timeline` and `eventLog` nodes.
 */
export const NAVIGATION_ATTRIBUTE_KEYS = Object.freeze([
  'url',
  'navigation.type',
  'domContentLoaded',
  'loadEventEnd',
  'transferSize',
] as const);

/**
 * `perf.longtask` — a `longtask` performance entry.
 *
 * Written by `../browser/perf.ts`. `attribution` carries the entry's
 * attribution summary (the container the long task was charged to) and
 * `blockingTime` the portion beyond the 50 ms threshold.
 *
 * Read by `../aggregate/summary.ts` for the `blocking_time` and
 * `long_task_count` metrics, and by the `timeline` node, which draws long
 * tasks as a hazard lane under the interaction they overlap.
 */
export const PERF_LONGTASK_ATTRIBUTE_KEYS = Object.freeze(['attribution', 'blockingTime'] as const);

/**
 * `perf.entry` — any other captured `PerformanceEntry`: resource, paint, mark
 * or measure.
 *
 * Written by `../browser/perf.ts`. `entry.type` says which of those it is, so
 * a consumer never has to infer the shape from the presence of a field.
 * `initiator.type`, `transferSize`, `encodedBodySize`, `decodedBodySize` and
 * `renderBlockingStatus` are the resource-timing fields; they are the only
 * place a transferred size is observable at all, which is why
 * `transferred_bytes` is computed from them where present and reported as
 * unavailable otherwise (AAP 0.6.6).
 *
 * Read by `../aggregate/summary.ts` and `../aggregate/requests.ts` (which
 * enriches a request with the timing of its resource) and by the `waterfall`
 * and `eventLog` nodes.
 */
export const PERF_ENTRY_ATTRIBUTE_KEYS = Object.freeze([
  'entry.type',
  'url',
  'initiator.type',
  'transferSize',
  'encodedBodySize',
  'decodedBodySize',
  'renderBlockingStatus',
] as const);

/**
 * `error` — an `error` or `unhandledrejection` event on the page.
 *
 * Written by `../browser/errors.ts`. `error.source` is the script location the
 * event reported and `component` the React component in scope when the failure
 * surfaced, where the agent can resolve one; `error.stack` is scrubbed and
 * truncated like any other preview, since a stack can quote source text.
 *
 * Read by `../aggregate/summary.ts` for `error_count` and by the `eventLog`
 * node's error filter.
 */
export const ERROR_ATTRIBUTE_KEYS = Object.freeze([
  'error.type',
  'error.message',
  'error.stack',
  'error.source',
  'component',
] as const);

/**
 * `state` — one React hook state transition.
 *
 * Written by `../browser/fiber-diff.ts`, which walks a fiber's `memoizedState`
 * hook chain against its alternate. `hookIndex` is the hook's position in that
 * chain and `hookLabel` a human-readable label where one can be derived;
 * `previousValue` and `nextValue` are {@link AttributeValueSummary} values —
 * never the state itself — and `triggerEventId` points at the event that
 * caused the transition.
 *
 * Read by the `stateTransitions` panel source and the `StateTransitionViewer`
 * node, which renders exactly component, hook index or label, old value
 * summary, triggering event and new value summary (AAP 0.6.2).
 */
export const STATE_ATTRIBUTE_KEYS = Object.freeze([
  'component',
  'hookIndex',
  'hookLabel',
  'previousValue',
  'nextValue',
  'triggerEventId',
] as const);

/**
 * `http.server` — the framework's incoming-request span, and the server-side
 * root of a correlated trace.
 *
 * Converted from the framework's own span by `../node/convert.ts`, which is
 * also where the installed instrumentations' key spellings are mapped onto the
 * canonical ones above. `http.route` is the matched route pattern rather than
 * the concrete path, so requests that differ only in their parameters group
 * together; `next.route` and `next.span_type` are the framework's own
 * attributes, kept because they distinguish a rendered page from a handled
 * route when `http.route` alone cannot.
 *
 * `request_key` is assigned at ingest (see
 * {@link SERVICE_ASSIGNED_ATTRIBUTE_KEYS}) and is what joins a server span to
 * the browser request that caused it when a trace id is missing — a request
 * made before the agent was armed, for instance.
 *
 * Read by `../aggregate/requests.ts`, `../correlation/tree.ts` and the
 * `waterfall`, `timeline` and `flame` panel nodes.
 */
export const HTTP_SERVER_ATTRIBUTE_KEYS = Object.freeze([
  'http.method',
  'url',
  'http.route',
  'http.status_code',
  'next.route',
  'next.span_type',
  'request_key',
] as const);

/**
 * `route.handler` — the framework's route-handler span, the child of an
 * `http.server` span.
 *
 * Converted by `../node/convert.ts`. It carries no `url`: the concrete URL
 * belongs to the request span above it, and repeating it here would invite two
 * answers to one question. `symbol` names the exported handler the framework
 * invoked, which is the hook the source resolver uses to turn the span into a
 * project-relative location through the route map.
 *
 * Read by `../correlation/tree.ts`, the `flame` and `waterfall` nodes, and the
 * source-resolution route for server spans.
 */
export const ROUTE_HANDLER_ATTRIBUTE_KEYS = Object.freeze([
  'http.method',
  'http.route',
  'next.route',
  'next.span_type',
  'symbol',
] as const);

/**
 * `function` — a named application function timed through the
 * `globalThis.__DEBUGGEN__.span` helper the reversible patch installs, on
 * either tier.
 *
 * Written by the helper itself — `../node/span-helper.ts` in the dev-server
 * process and `../browser/span-helper.ts` in the page — from the metadata the
 * patch template passes in. `symbol` is the patched function's name and
 * `module` its project-relative module path; `async` records whether the
 * helper ended the span on a settled promise rather than on return, which is
 * what makes an awaited function's duration interpretable.
 *
 * `actionId` links the span back to the instrumentation action whose patch
 * created it (AAP 0.2.3). That link is how a function span's source location
 * is known to be patch-resolved — the most precise of the resolution routes,
 * because the file, line and column were recorded when the patch was applied
 * rather than inferred afterwards.
 *
 * Read by `../correlation/tree.ts`, the `flame`, `timeline` and `table` nodes,
 * and the service's source resolver.
 */
export const FUNCTION_ATTRIBUTE_KEYS = Object.freeze([
  'symbol',
  'module',
  'actionId',
  'async',
] as const);

/**
 * `db.query` — a database span from the ORM or the driver instrumentation.
 *
 * Converted by `../node/convert.ts` from the span the instrumentation emitted.
 * Two privacy rules are part of this key set, not decorations on it
 * (AAP 0.5.2):
 *
 * - `db.statement` is **always** the parameterized statement text —
 *   placeholders such as `$1` left as they are, and any literal that survived
 *   into the text replaced with `?` by `../redaction/sql.ts`. A statement with
 *   inline values never reaches the store, the panel or a model prompt.
 * - Row *contents* are never captured. The only thing recorded about a result
 *   is `db.rowCount`, which is what lets a panel say a query returned far more
 *   rows than the view needed without ever holding one of them.
 *
 * `db.operation` is the statement's operation, `db.name` the database, and
 * `db.client` the producing client — `prisma` or `pg` — which is how a
 * consumer tells an ORM span from the driver span underneath it and avoids
 * counting one query twice.
 *
 * Read by `../aggregate/queries.ts` (grouping by normalised statement) and the
 * `queryTable`, `waterfall` and `flame` nodes.
 */
export const DB_QUERY_ATTRIBUTE_KEYS = Object.freeze([
  'db.system',
  'db.statement',
  'db.rowCount',
  'db.operation',
  'db.name',
  'db.client',
] as const);

/**
 * `http.client` — an outgoing request made by the server while handling a
 * request.
 *
 * Converted by `../node/convert.ts`. The key set is the request set minus the
 * browser-only fields: there is no initiator stack to capture and no header to
 * inject, because the server's own tracer already propagates context.
 *
 * `request_key` is assigned at ingest and lets the waterfall show that the
 * same outbound call was made more than once, which is a different finding
 * from a duplicated page request and is deliberately counted separately (see
 * the request group in `./kinds.ts`).
 *
 * Read by `../correlation/tree.ts` and the `waterfall` and `flame` nodes.
 */
export const HTTP_CLIENT_ATTRIBUTE_KEYS = Object.freeze([
  'http.method',
  'url',
  'http.status_code',
  'request_key',
] as const);

/**
 * `server.error` — an exception raised while handling a server-side request.
 *
 * Converted by `../node/convert.ts` from a span that recorded an exception.
 * `http.route` is the matched route it failed under, so a failure can be
 * attributed without joining back to the request span; `error.stack` is
 * scrubbed and truncated, since a server stack can quote source text and
 * environment values.
 *
 * Read by `../aggregate/summary.ts` for `error_count` and by the `eventLog`
 * node's error filter.
 */
export const SERVER_ERROR_ATTRIBUTE_KEYS = Object.freeze([
  'error.type',
  'error.message',
  'error.stack',
  'http.route',
] as const);

/**
 * `log` — an explicit log record correlated into a trace, from either tier.
 *
 * Written by whichever side produced the record: the page agent for a captured
 * console record, `../node/exporter.ts` for a server one. `logger.name`
 * identifies the emitting logger so a record can be traced to its source
 * without parsing the message, and `log.message` is scrubbed and truncated —
 * a log line is free-form text and therefore the most likely attribute to
 * quote a credential.
 *
 * Read by the `eventLog` node, which renders log records inline with the spans
 * they were emitted under.
 */
export const LOG_ATTRIBUTE_KEYS = Object.freeze([
  'log.level',
  'log.message',
  'logger.name',
] as const);

/*
 * ---------------------------------------------------------------------------
 * Cross-kind key groups
 *
 * Keys that may appear on an event of any kind, grouped by who writes them.
 * Unlike the per-kind tuples above, these are annotated `readonly string[]`
 * rather than left as literal tuples: their commonest use is a membership test
 * against a key that arrived from another process, and a literal tuple type
 * would reject `GROUP.includes(key)` for an arbitrary `string`, pushing the
 * caller back towards an inline list of its own.
 * ---------------------------------------------------------------------------
 */

/**
 * Lineage: how an event was attributed to a trace across an asynchronous
 * boundary.
 *
 * Written by `../browser/continuation.ts`, which keeps a continuation window
 * open on a settled request so the React work that follows a response joins
 * the interaction's trace rather than starting a new one (AAP 0.4.2):
 *
 * - `lineage` marks an event attributed across such a boundary. Its only
 *   current value is `'async-continuation'` — see {@link LINEAGE_VALUES}.
 * - `lineageAmbiguous` is set when more than one settled request had an open
 *   continuation window at the moment the event landed, so the attribution is
 *   the most recently settled candidate rather than a certainty.
 * - `lineageCandidates` carries the span ids of the other candidates, so the
 *   alternative attributions are inspectable instead of discarded.
 *
 * Read by the `timeline` and `flame` renderers, which draw an ambiguous edge
 * dashed rather than presenting a guess as a fact.
 */
export const LINEAGE_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  'lineage',
  'lineageAmbiguous',
  'lineageCandidates',
] as const);

/**
 * Correlation: what the correlator had to repair when it built the trace tree.
 *
 * Written by `apps/local-service/src/telemetry/correlate.ts` through
 * `../correlation/correlator.ts`. An event whose parent never arrived — the
 * parent was dropped, or its producer disconnected before flushing — is
 * attached to the trace root with `orphaned` set and its intended parent
 * recorded in `orphanedParentSpanId`, rather than being dropped (AAP 0.4.2).
 * Keeping the event and flagging it is what stops a missing span from silently
 * removing the work underneath it from every duration in the capture.
 *
 * Read by the `timeline`, `flame` and `eventLog` nodes, which mark a
 * re-attached subtree so the tree is not mistaken for the shape the
 * application actually had.
 */
export const CORRELATION_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  'orphaned',
  'orphanedParentSpanId',
] as const);

/**
 * Keys the service assigns at ingest, which a producer must never set.
 *
 * `request_key` is computed by `../redaction/request-key.ts` from the
 * **unredacted** URL — an HMAC over method, path and sorted query pairs under
 * a random per-session key that never leaves the store — so that duplicate
 * detection survives redaction: two byte-identical requests collide, while two
 * requests differing only in a parameter value do not, even though both URLs
 * are stored with their parameter values replaced (AAP 0.5.2).
 *
 * That is why the key is service-assigned. A producer cannot compute it (it
 * does not hold the session key), and a producer-supplied value would let a
 * page choose which requests are reported as duplicates of each other, so
 * `apps/local-service/src/telemetry/ingest.ts` overwrites whatever arrives
 * under this key.
 *
 * Read by `../aggregate/requests.ts`, which groups by it for the
 * `request_count` and `duplicate_request_count` metrics and the
 * `requestTable` node's duplicate badges.
 */
export const SERVICE_ASSIGNED_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  'request_key',
] as const);

/**
 * Every key that may appear on an event of any kind: the lineage, correlation
 * and service-assigned groups together.
 *
 * {@link KIND_ATTRIBUTE_KEYS} answers "what does this kind describe about
 * itself"; these keys answer "what did the pipeline record about this event",
 * which is a different question with different writers. The lineage and
 * correlation keys therefore appear in no per-kind tuple at all. `request_key`
 * is the one key in both places, and for a reason: it is declared on the
 * request-shaped kinds because those are the kinds it is assigned for, and
 * repeated here because the writer is the ingest path rather than the
 * producer.
 *
 * A consumer that wants both sets asks
 * `attributeKeysFor(kind, { includeCommon: true })`.
 */
export const COMMON_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  ...LINEAGE_ATTRIBUTE_KEYS,
  ...CORRELATION_ATTRIBUTE_KEYS,
  ...SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
]);

/*
 * ---------------------------------------------------------------------------
 * The registry
 * ---------------------------------------------------------------------------
 */

/**
 * For each kind, the attribute keys that kind declares — its own tuple,
 * without the common keys.
 *
 * This is the object `packages/panel-schema/src/catalog.ts` consults when it
 * declares each node's `reads` list, and the one an aggregate consults when it
 * needs the key set for a kind it was handed rather than one it was written
 * for.
 *
 * The annotation makes the registry total by construction: the key type is the
 * closed kind union, so adding a member to `TELEMETRY_KINDS` without an entry
 * here is a compile error — a future kind cannot be forgotten. Together with
 * `noUncheckedIndexedAccess`, it also makes every lookup exact: indexing with
 * a `TelemetryKind` yields `readonly string[]` and never `undefined`, so no
 * caller needs a fallback or a non-null assertion.
 *
 * The value type is widened to `readonly string[]` rather than kept as each
 * kind's literal tuple, which is what lets a caller test membership of a key
 * that arrived from another process.
 *
 * Frozen: a read-only lookup table shared by three runtimes.
 */
export const KIND_ATTRIBUTE_KEYS: Readonly<Record<TelemetryKind, readonly string[]>> =
  Object.freeze({
    interaction: INTERACTION_ATTRIBUTE_KEYS,
    render: RENDER_ATTRIBUTE_KEYS,
    commit: COMMIT_ATTRIBUTE_KEYS,
    fetch: FETCH_ATTRIBUTE_KEYS,
    xhr: XHR_ATTRIBUTE_KEYS,
    navigation: NAVIGATION_ATTRIBUTE_KEYS,
    'perf.longtask': PERF_LONGTASK_ATTRIBUTE_KEYS,
    'perf.entry': PERF_ENTRY_ATTRIBUTE_KEYS,
    error: ERROR_ATTRIBUTE_KEYS,
    state: STATE_ATTRIBUTE_KEYS,
    'http.server': HTTP_SERVER_ATTRIBUTE_KEYS,
    'route.handler': ROUTE_HANDLER_ATTRIBUTE_KEYS,
    function: FUNCTION_ATTRIBUTE_KEYS,
    'db.query': DB_QUERY_ATTRIBUTE_KEYS,
    'http.client': HTTP_CLIENT_ATTRIBUTE_KEYS,
    'server.error': SERVER_ERROR_ATTRIBUTE_KEYS,
    log: LOG_ATTRIBUTE_KEYS,
  });

/**
 * Every attribute key the catalog declares, deduplicated: each kind's keys in
 * kind-declaration order, then the common keys.
 *
 * The set of keys the product relies on anywhere, which is what a diagnostic
 * needs to report a key nobody declared (a `reads` entry in the panel node
 * catalog that no producer sets, or a producer that invented a spelling) and
 * what makes the answer to "is this key one we rely on" a single lookup rather
 * than a walk over seventeen tuples.
 *
 * It is emphatically **not** a whitelist: an event may carry keys outside this
 * list and remain well-formed (see the module documentation). Nothing in the
 * ingest path rejects, strips or warns about a key merely because it is absent
 * here.
 *
 * Derived from `TELEMETRY_KINDS` rather than from the tuples directly, so a
 * kind added to the vocabulary joins this list with its keys automatically.
 *
 * Frozen.
 */
export const ALL_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  ...new Set([
    ...TELEMETRY_KINDS.flatMap((kind) => KIND_ATTRIBUTE_KEYS[kind]),
    ...COMMON_ATTRIBUTE_KEYS,
  ]),
]);

/**
 * The attribute keys declared for `kind`.
 *
 * The accessor consumers use instead of reaching into
 * {@link KIND_ATTRIBUTE_KEYS}, so the registry's shape stays an implementation
 * detail of this module.
 *
 * Total and allocation-free on the default path: the registry is exhaustive
 * over the closed kind union, so the lookup always succeeds and the frozen
 * tuple is returned as it stands — no copy, no `undefined`, no fallback.
 * Passing `includeCommon: true` asks for the cross-kind keys of
 * {@link COMMON_ATTRIBUTE_KEYS} as well, which is the one path that allocates
 * (a fresh frozen array per call); a caller doing that inside a loop should
 * hoist the result.
 *
 * The returned array is frozen and, on the default path, shared. Treat it as
 * read-only; a caller that needs a mutable copy takes one
 * (`[...attributeKeysFor(kind)]`).
 *
 * @param kind - The kind whose declared keys are wanted.
 * @param options - `includeCommon` appends the lineage, correlation and
 * service-assigned keys. Accepts `undefined` explicitly so a caller may pass a
 * value it computed without narrowing it first.
 */
export function attributeKeysFor(
  kind: TelemetryKind,
  options?: { readonly includeCommon?: boolean | undefined },
): readonly string[] {
  const declared = KIND_ATTRIBUTE_KEYS[kind];
  if (options?.includeCommon !== true) {
    return declared;
  }
  return Object.freeze([...declared, ...COMMON_ATTRIBUTE_KEYS]);
}

/*
 * ---------------------------------------------------------------------------
 * Value vocabularies
 *
 * The value side of the keys above. They live here, next to the keys, so that
 * the producer (`../browser/fiber-diff.ts`, `../browser/react.ts`,
 * `../browser/continuation.ts`), the aggregates (`../aggregate/renders.ts`),
 * the redactor and the panel renderer all agree on one spelling of every
 * value.
 * ---------------------------------------------------------------------------
 */

/**
 * The two values `attributes.phase` may take on a `render` or `commit` event.
 *
 * The fiber hook's rendered-fiber traversal supplies exactly these two: a
 * fiber that had no alternate is a `mount`, one that did is an `update`. There
 * is deliberately no third value for an unmount — an unmounted fiber renders
 * nothing, so it produces no `render` event to phase.
 *
 * Frozen: a read-only vocabulary.
 */
export const RENDER_PHASES = Object.freeze(['mount', 'update'] as const);

/** One member of the closed render-phase vocabulary. */
export type RenderPhase = (typeof RENDER_PHASES)[number];

/**
 * The five values `attributes.trigger` may take on a `render` event: why the
 * fiber rendered.
 *
 * `../browser/fiber-diff.ts` classifies a render by comparing three inputs
 * against the fiber's alternate — its props, its own hook state, and the
 * values of the contexts it consumes:
 *
 * - `props` — at least one prop was not shallow-equal to the previous one.
 * - `state` — the fiber's own hook state changed.
 * - `context` — a consumed context value changed.
 * - `unchanged` — **all three** were evaluated and none changed: props were
 *   shallow-equal, own hook state was unchanged *and* no consumed context
 *   value changed. This is the interesting one — a re-render with stable
 *   inputs, caused by an ancestor rendering — and it is what
 *   `unchanged_render_count` counts.
 * - `unknown` — at least one of the three could **not** be evaluated (a
 *   consumed context whose previous value is unavailable, for instance).
 *
 * The distinction between the last two is load-bearing and is the semantic
 * most easily got wrong: an `unknown` render is **never** counted as
 * `unchanged`. It is counted separately, as
 * `render_trigger_unknown_count` (AAP 0.2.3), because "we checked and nothing
 * changed" and "we could not check" support completely different conclusions,
 * and conflating them would let a capture report a stable-input re-render that
 * was never observed. Any consumer that buckets triggers must keep them apart
 * for the same reason.
 *
 * Frozen: a read-only vocabulary.
 */
export const RENDER_TRIGGERS = Object.freeze([
  'props',
  'state',
  'context',
  'unchanged',
  'unknown',
] as const);

/** One member of the closed render-trigger vocabulary. */
export type RenderTrigger = (typeof RENDER_TRIGGERS)[number];

/**
 * The values `attributes.lineage` may take.
 *
 * One value today: an event attributed to a trace through a continuation
 * window opened on a settled request (AAP 0.4.2). It is declared as a
 * vocabulary rather than as a lone string constant because the key exists to
 * say *how* an attribution was made, and a second mechanism would add a value
 * here rather than overload this one.
 *
 * Frozen: a read-only vocabulary.
 */
export const LINEAGE_VALUES = Object.freeze(['async-continuation'] as const);

/** One member of the closed lineage vocabulary. */
export type LineageValue = (typeof LINEAGE_VALUES)[number];

/**
 * The vocabulary a summarised value's `type` may take.
 *
 * The first ten members are the categories a JavaScript value falls into, with
 * `array` split out from `object` because the two read differently in a panel.
 * The last two exist so that a value which must never be serialised can still
 * be *described*:
 *
 * - `dom` — a DOM node. Serialising one would pull a subtree of the
 *   developer's page, including its text, into the capture.
 * - `function` — a callback. Its source text is code, and a closure can hold
 *   anything.
 *
 * `../browser/fiber-diff.ts` emits those two types with a preview that names
 * the shape (a tag name, a function name) and never its contents, which is
 * what lets a panel show that a callback prop changed identity on every render
 * without the callback itself leaving the page.
 *
 * `unknown` is the total fallback: a value whose category could not be
 * determined is described as such rather than guessed at.
 *
 * Frozen: a read-only vocabulary.
 */
export const ATTRIBUTE_VALUE_TYPES = Object.freeze([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'bigint',
  'symbol',
  'function',
  'array',
  'object',
  'dom',
  'unknown',
] as const);

/** One member of the closed summarised-value-type vocabulary. */
export type AttributeValueType = (typeof ATTRIBUTE_VALUE_TYPES)[number];

/**
 * A value as it travels: its category, a bounded preview, and whether the
 * preview was cut.
 *
 * This is the **only** representation of an application value anywhere in the
 * evidence layer. A raw prop, a raw hook state value, a request or response
 * body and a database row never travel at all (AAP 0.5.2) — what travels is
 * this: a type from {@link ATTRIBUTE_VALUE_TYPES}, and a `preview` that has
 * been scrubbed of credential-shaped content and then truncated to
 * {@link MAX_PREVIEW_LENGTH} code points. `truncated` records that the cut
 * happened, so a consumer never presents a shortened preview as a whole value.
 *
 * Carried by the `changedProps` key on a `render` event (inside
 * {@link ChangedPropEntry}) and by the `previousValue` and `nextValue` keys on
 * a `state` event. Constructed by `../browser/fiber-diff.ts`; the scrubbing
 * and truncation primitives live in `../redaction/rules.ts`, and the order is
 * part of their contract — scrub first, then truncate, so a credential cannot
 * survive by being half-matched.
 */
export interface AttributeValueSummary {
  /** Category of the original value. */
  type: AttributeValueType;
  /**
   * Scrubbed, bounded rendering of the value: at most
   * {@link MAX_PREVIEW_LENGTH} code points, and never the contents of a DOM
   * node or a function.
   */
  preview: string;
  /** Whether {@link preview} was shortened to fit the bound. */
  truncated: boolean;
}

/**
 * One prop whose value was not shallow-equal to the previous render's, as
 * carried by the `changedProps` key on a `render` event.
 *
 * `previous` and `next` are summaries, never values, and either may be
 * **omitted**: a prop that was added has no `previous`, one that was removed
 * has no `next`, and one whose summary could not be produced has neither. Both
 * are declared optional rather than nullable, so — under this repository's
 * `exactOptionalPropertyTypes` setting — a producer omits the property instead
 * of assigning `undefined` to it. That is also how the pair survives the
 * journey: the event is transported as JSON, where an omitted property and a
 * property set to `undefined` are not distinguishable anyway.
 *
 * A render's entry list is bounded by {@link MAX_TRACKED_KEYS}; the keys past
 * the bound are not reported, which is why a consumer presents this list as
 * the changed props it knows about rather than as all of them.
 *
 * Constructed by `../browser/fiber-diff.ts`; read by
 * `../aggregate/renders.ts` and the `renderTable` panel node.
 */
export interface ChangedPropEntry {
  /** The prop's name. */
  key: string;
  /** Summary of the value at the previous render, absent if there was none. */
  previous?: AttributeValueSummary;
  /** Summary of the value at this render, absent if the prop was removed. */
  next?: AttributeValueSummary;
}

/*
 * ---------------------------------------------------------------------------
 * Privacy bounds
 *
 * Two numbers, defined here and nowhere else, so the producer, the redactor
 * and their tests cannot disagree about what a capture is allowed to carry.
 * `../redaction/rules.ts` deliberately takes its truncation bound as a
 * parameter rather than holding a default, precisely so that this module stays
 * the single definition.
 *
 * Both are documented privacy guarantees, not tuning knobs: raising either one
 * widens what leaves the developer's page and their dev-server process, so a
 * change here is a change to `docs/SECURITY.md` and to the guarantees stated
 * in AAP 0.5.2, and must be made in both places or not at all.
 * ---------------------------------------------------------------------------
 */

/**
 * The largest number of keys a single diff may report: prop keys on a `render`
 * event, hook entries on a `state` event.
 *
 * Fixed at 32 by AAP 0.7.1 ("bounded to 32 keys"). The bound is what keeps an
 * unusually wide props object from turning one render into a large event, and
 * it bounds exposure as well as size — a component holding hundreds of props
 * reports at most this many of them. Keys beyond the bound are dropped, not
 * summarised more coarsely, and a consumer therefore treats a reported list as
 * possibly partial ({@link ChangedPropEntry}).
 */
export const MAX_TRACKED_KEYS = 32;

/**
 * The largest preview, in code points, that a summarised value may carry.
 *
 * Fixed at 120 by AAP 0.5.2 ("values truncated to 120 characters") and
 * AAP 0.7.1 ("type + 120-character redacted preview"). Long enough to
 * recognise a value, short enough that a preview cannot become a copy of the
 * data it describes.
 *
 * Counted in code points rather than UTF-16 units, so a surrogate pair is
 * never split: `../redaction/rules.ts` implements that counting and accepts
 * this number as its bound.
 */
export const MAX_PREVIEW_LENGTH = 120;
