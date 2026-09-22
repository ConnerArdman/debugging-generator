/**
 * The attribute-key catalog: the single declaration of *which keys appear in a
 * telemetry event's `attributes` bag for each kind*, of the small value
 * vocabularies those keys draw on, of the bounds that cap what a summarised
 * value and a serialized component tree may carry, of the one event *name*
 * that identifies a record by more than its kind
 * ({@link COMPONENT_TREE_EVENT_NAME}), and of the closed set of computed
 * metric ids a capture can report.
 *
 * Treat this as a published contract rather than an internal note. Two
 * consumers read it directly — `packages/panel-schema/src/catalog.ts`, which
 * declares each panel node's `reads` list from {@link KIND_ATTRIBUTE_KEYS} and
 * validates a `metricCards` node's `metrics` against {@link METRIC_IDS}, and
 * `../aggregate/*`, which reads event fields by these exact key strings and
 * publishes its summary under those exact metric ids (AAP 0.2.3, 0.6.2) — and
 * `../browser/*` plus `../node/*` write them. A key or a metric id spelled one
 * way here and another way at a producer or a consumer does not fail loudly:
 * it yields an empty column or an `n/a` card in a generated panel, which is
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
 * `../redaction/redactor.ts`. The metric ids at the end of the module are the
 * same kind of declaration: the vocabulary lives here, while every value
 * behind it is computed by `../aggregate/summary.ts`. What lives here is
 * `const` tuples, derived types, frozen lookup tables and small total
 * accessors.
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
 * `resourceTimingUrl` is the request's absolute URL as the Performance
 * Timeline names it — resolved against the document base at the moment the
 * request was opened — and is the identity `../aggregate/requests.ts` joins a
 * request to its `perf.entry` resource entry on (AAP 0.6.6). It is masked by
 * the same URL rule as `url`, so both sides of the join see the same spelling.
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
  'resourceTimingUrl',
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
  'resourceTimingUrl',
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
 * `transferSizeExposed` carries the same verdict as on `perf.entry`: whether
 * the document's own byte counts were exposed by the host or are placeholders.
 *
 * Read by `../aggregate/timeline.ts` and the `timeline` and `eventLog` nodes.
 */
export const NAVIGATION_ATTRIBUTE_KEYS = Object.freeze([
  'url',
  'navigation.type',
  'domContentLoaded',
  'loadEventEnd',
  'transferSize',
  'transferSizeExposed',
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
 * unavailable otherwise (AAP 0.6.6). `transferSizeExposed` is the producer's
 * verdict on whether the host actually exposed those byte counts — a
 * cross-origin resource without `Timing-Allow-Origin` reports zeros that are
 * not measurements — so a consumer can tell "0 bytes" from "not observable"
 * without re-deriving the CORS rule.
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
  'transferSizeExposed',
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
 * `state` — one React hook state transition, or one changed consumed-context
 * value.
 *
 * Written by `../browser/state.ts` from the bounded, scrubbed summaries
 * `../browser/fiber-diff.ts` produces by walking a fiber's `memoizedState`
 * hook chain and its context dependencies against the alternate. `hookIndex`
 * is the hook's position in that chain and `hookLabel` a human-readable label
 * where one can be derived; `previousValue` and `nextValue` are
 * {@link AttributeValueSummary} values — never the state itself.
 *
 * ## Two trigger keys, because there are two identifier spaces
 *
 * `triggerEventId` and `triggerSpanId` both name the operation a transition is
 * attributed to, and they are **not** interchangeable. An event id (`evt_…`,
 * minted by `../browser/transport.ts` when an event is queued) and a span id
 * (16 hex characters) are different identifier spaces, and a producer holds
 * whichever one it has: the page agent knows the interaction's — or a settled
 * request's — *span* id at the moment a commit runs, so it writes
 * `triggerSpanId`, while a producer that knows the trigger's *event* id writes
 * `triggerEventId`. Both are declared here so that neither producer has to
 * invent a spelling and neither value is silently unread:
 * `../aggregate/timeline.ts`'s trigger resolution takes `triggerEventId`
 * first, then resolves `triggerSpanId` through its span index, and only then
 * falls back to walking the parent chain.
 *
 * ## What the rest of the description says
 *
 * `transitionSource` says which dimension changed — a member of
 * {@link TRANSITION_SOURCES} — which is what separates "this component's own
 * state changed" from "a context it consumes changed": two observations
 * supporting different conclusions, since the second one indicts a provider
 * rather than the component. `renderSpanId` repeats the render the transition
 * was observed inside (the event's own `parentSpanId`) as a filterable,
 * groupable attribute, and `fiberId` identifies the *instance*, so two mounted
 * copies of one component are two rows rather than one.
 *
 * ## Truncation is disclosed on the evidence, not only in the producer
 *
 * `../browser/state.ts` bounds how many transitions one commit and one capture
 * may report. `truncated` marks the last event of a run a bound cut — and,
 * when the capture-wide bound left no room for a run at all, one bounded
 * sentinel event whose only job is to disclose the loss — while
 * `droppedTransitions` carries how many reported transitions produced no event
 * of their own. Note the level: these describe the *list of transitions*,
 * whereas the `truncated` field inside a {@link AttributeValueSummary}
 * describes one preview. Neither implies the other.
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
  'triggerSpanId',
  'transitionSource',
  'renderSpanId',
  'fiberId',
  'truncated',
  'droppedTransitions',
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
 * The event `name` a component-tree snapshot travels under.
 *
 * The snapshot is one event, emitted by `../browser/agent.ts` at capture stop
 * while the retained React root is still reachable, and it is the only source
 * of the `componentTree` data result that describes the page as it actually
 * was — AAP 0.4.2 specifies that structure "at the last commit of the
 * capture", and a tree reconstructed afterwards from owner chains covers only
 * the components that happened to render.
 *
 * It is a **named event rather than a new kind**: AAP 0.2.3 fixes the kind
 * vocabulary (`./kinds.ts`), `log` is the cross-tier kind a correlated record
 * travels as, and the name is what identifies this record among log records.
 * `../aggregate/renders.ts` selects the latest event with this name and reads
 * {@link COMPONENT_TREE_ATTRIBUTE_KEYS} off it; a producer that instead
 * attaches the serialized tree to its `commit` event writes the same
 * `componentTree` key, so there is one spelling either way.
 *
 * Dotted-lowercase like the framework span names the timeline shows beside it,
 * and deliberately generic: it names a React concept, not an application's.
 */
export const COMPONENT_TREE_EVENT_NAME = 'react.component-tree';

/**
 * The attribute keys a component-tree snapshot carries.
 *
 * - `componentTree` is the forest **as JSON text**, bounded by
 *   {@link MAX_COMPONENT_TREE_JSON_CHARS}. Text, not a nested object, and that
 *   is load-bearing: `../browser/transport.ts` rebuilds every attribute bag
 *   into clone-safe values and replaces a container nested deeper than two
 *   levels with a type tag, so a tree posted as structure would arrive with
 *   its grandchildren's children erased. A string is immune to that walk.
 * - `componentTreeNodeCount` is how many nodes that text carries, so a
 *   consumer can report the size of the tree without parsing it.
 * - `componentTreeTruncated` says the producer had to fall back to a bound
 *   below the one it was asked for, which is what lets a panel present a
 *   partial tree *as* partial instead of as the page's whole structure.
 *
 * Because the text is a structure rather than a preview, it has a redaction
 * route of its own: `../redaction/redactor.ts` parses it, keeps the structural
 * fields, scrubs and bounds every component name and React key inside it, and
 * re-serialises valid JSON. The generic string rules would cut the document to
 * a 120-code-point preview and hand the aggregate something unparseable, which
 * is precisely why this key is declared rather than left to fall through.
 *
 * Declared under the `log` kind below (the kind the snapshot travels as) and
 * exported separately so the producer, the redactor and the aggregate bind the
 * same three strings.
 */
export const COMPONENT_TREE_ATTRIBUTE_KEYS = Object.freeze([
  'componentTree',
  'componentTreeNodeCount',
  'componentTreeTruncated',
] as const);

/**
 * The field a node of the serialized tree carries its own truncation marker
 * under: `truncated`.
 *
 * Two bounds cut a component tree, and they cut it in different places.
 * `componentTreeTruncated` (above) is a statement about the **document**: the
 * producer had to serialise a smaller tree than it was asked for. This field
 * is a statement about **one node**: the walk stopped here, so this node's
 * descendants are not all in the document — which is the only way a reader can
 * tell a component that rendered nothing from a component whose subtree was
 * left out.
 *
 * It is declared here, beside the attribute keys, because three modules have
 * to agree on the spelling for the disclosure to survive the trip:
 * `../browser/react.ts` sets it while walking the fiber tree,
 * `../redaction/redactor.ts` keeps it in the structural allowlist when it
 * rebuilds the document at ingest, and `../aggregate/renders.ts` folds it into
 * the snapshot's `truncated` and `degraded` flags. A spelling that drifted at
 * any of the three would not fail loudly — it would present a partial tree as
 * the page's whole structure, which is exactly the claim this product must
 * never make (AAP 0.5.5).
 *
 * The other field names of a node — the component name, the React key, the
 * children, the render count, the fiber id — are each read by the module that
 * needs them; this one is singled out because it is the only field whose
 * *absence* changes what the evidence means.
 */
export const COMPONENT_TREE_TRUNCATED_FIELD = 'truncated';

/**
 * The longest serialized component tree that may travel on an event: 128 KiB
 * of JSON text.
 *
 * Two ceilings sit above it and both would cost the whole snapshot rather than
 * trimming it — `../browser/transport.ts` refuses a frame larger than 512 KiB,
 * and `../aggregate/renders.ts` refuses serialized text longer than 512 KiB —
 * so the producer and the redactor bound their output at a quarter of that,
 * which leaves room for the rest of a batch and is still several times any
 * tree worth reading (a snapshot is capped at a couple of thousand nodes, and
 * those serialise to well under this).
 *
 * Counted in code points, like {@link MAX_PREVIEW_LENGTH}, so the bound cannot
 * split a surrogate pair. It is a transport and cost bound rather than a
 * privacy guarantee — the privacy guarantee for the values *inside* the tree
 * is {@link MAX_PREVIEW_LENGTH}, applied per component name and per key.
 */
export const MAX_COMPONENT_TREE_JSON_CHARS = 128 * 1024;

/**
 * `log` — an explicit log record correlated into a trace, from either tier,
 * and the component-tree snapshot.
 *
 * Written by whichever side produced the record: the page agent for a captured
 * console record, `../node/exporter.ts` for a server one. `logger.name`
 * identifies the emitting logger so a record can be traced to its source
 * without parsing the message, and `log.message` is scrubbed and truncated —
 * a log line is free-form text and therefore the most likely attribute to
 * quote a credential.
 *
 * The three {@link COMPONENT_TREE_ATTRIBUTE_KEYS} are declared here as well,
 * because the snapshot of {@link COMPONENT_TREE_EVENT_NAME} is a `log` event:
 * they appear on that one event and on no other log record, which is what the
 * event name distinguishes. Spread rather than retyped, so the keys have one
 * declaration.
 *
 * Read by the `eventLog` node, which renders log records inline with the spans
 * they were emitted under, and — for the snapshot keys — by
 * `../aggregate/renders.ts`, which builds the `componentTree` data result from
 * them.
 */
export const LOG_ATTRIBUTE_KEYS = Object.freeze([
  'log.level',
  'log.message',
  'logger.name',
  ...COMPONENT_TREE_ATTRIBUTE_KEYS,
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
 * The two values `attributes.transitionSource` may take on a `state` event:
 * which dimension of a fiber's inputs changed.
 *
 * - `state` — the fiber's own hook state published a new value.
 * - `context` — a context value the fiber consumes changed, which is a
 *   provider's doing rather than the component's.
 *
 * {@link RENDER_TRIGGERS} is deliberately *not* reused. That vocabulary
 * classifies **why a fiber rendered** and has members (`props`, `unchanged`,
 * `unknown`) that describe no transition at all; this one says **which value
 * changed**, and a transition exists only because something did. Two
 * vocabularies, two questions — a consumer that conflated them would report a
 * render cause as a state change.
 *
 * Declared here rather than in `../browser/state.ts`, which writes the
 * attribute, because `../aggregate/timeline.ts` reads it back and an aggregate
 * cannot import a page-agent module: the schema layer is where a vocabulary
 * both sides need has to live.
 *
 * Frozen: a read-only vocabulary.
 */
export const TRANSITION_SOURCES = Object.freeze(['state', 'context'] as const);

/** One member of the closed transition-source vocabulary. */
export type TransitionSource = (typeof TRANSITION_SOURCES)[number];

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

/*
 * ---------------------------------------------------------------------------
 * Computed metric ids
 *
 * The closed vocabulary of the *numbers* a capture can report, declared beside
 * the keys they are computed from so that the module computing them
 * (`../aggregate/summary.ts`), the schema that lets a generated panel ask for
 * one (`packages/panel-schema/src/catalog.ts`, whose `metricCards` node
 * validates its `metrics` list against this set), the component that renders
 * them and the prose layer that names one in a sentence all spell every id
 * identically. A metric named one way here and another way at any of them does
 * not fail loudly — it yields a card reading `n/a` next to a number the
 * capture did record — which is the same failure the key catalog above exists
 * to prevent, and it is prevented the same way: one declaration, imported.
 *
 * Vocabulary only: the ids live here, their values do not. `MetricValue`, the
 * `CaptureSummary` that carries them and every line of arithmetic behind them
 * belong to `../aggregate/summary.ts` (AAP 0.2.3), and nothing in this module
 * reads an event or computes anything. The per-id documentation below states
 * what each metric *means*, which is the part every consumer has to agree on;
 * how it is derived from the event stream is that module's business.
 *
 * Adding a metric is four changes: a member of {@link METRIC_IDS}, an entry in
 * {@link METRIC_ID_UNITS}, a place in exactly one of the semantic groups
 * below, and the computation in `../aggregate/summary.ts`. The compiler
 * demands the second, the colocated suite pins the first and the third, and
 * only the computation is left to a reader to remember.
 * ---------------------------------------------------------------------------
 */

/**
 * Every computed metric a capture can report, in the order AAP 0.2.3 fixes:
 * the total duration and its three per-tier parts, the render counts, the
 * request and query counts, the two resource measures, then the remaining
 * counts.
 *
 * The list is **closed**, and closedness is load-bearing rather than tidy: a
 * generated panel's `metricCards` node names ids from this set and is rejected
 * by panel validation when it names anything else, which is what stops a model
 * from inventing a metric nobody computes and presenting an empty card as
 * evidence (AAP 0.2.3, 0.5.3).
 *
 * The **order** is part of the contract too. It is the order the plan lists,
 * it is the order the semantic groups below preserve, and it is the order a
 * consumer that iterates the vocabulary rather than a model-authored list
 * presents them in — the deterministic fallback panel, whose cards come from
 * whatever the capture reported (AAP 0.5.3), being the case that matters.
 *
 * Frozen: a read-only vocabulary shared by the aggregates, the panel schema,
 * the renderer and the deterministic prose layer.
 */
export const METRIC_IDS = Object.freeze([
  /**
   * Wall-clock duration of the whole interaction: from the start of the
   * `interaction` root span to the end of the last event attributed to its
   * trace, including anything attributed through a continuation window. The
   * denominator the other durations are read against.
   */
  'total_duration',
  /** Time accounted for by `browser`-tier events of the interaction's trace. */
  'frontend_duration',
  /** Time accounted for by `server`-tier events of the interaction's trace. */
  'backend_duration',
  /**
   * Time accounted for by `db`-tier events of the interaction's trace. Split
   * out from the server total because a slow query and slow application code
   * on the same request support different conclusions.
   */
  'database_duration',
  /**
   * How many fibers the capture saw render — the `render` events of
   * `RENDER_KINDS`, counted across the capture or for one component when the
   * asking node filters by one.
   */
  'render_count',
  /**
   * How many of those renders had **stable inputs**: `attributes.trigger` was
   * `unchanged`, meaning props were shallow-equal, own hook state was
   * unchanged *and* no consumed context value changed (AAP 0.2.3). The
   * interesting subset of {@link METRIC_IDS} for a re-render question, and the
   * reason {@link RENDER_TRIGGERS} distinguishes `unchanged` from `unknown`.
   */
  'unchanged_render_count',
  /**
   * How many renders could **not** be classified: `attributes.trigger` was
   * `unknown` because at least one of the three dimensions was unevaluable.
   * Counted separately and never folded into `unchanged_render_count`, so a
   * capture can never report a stable-input re-render it did not observe.
   */
  'render_trigger_unknown_count',
  /**
   * How many requests the page issued: the `fetch` and `xhr` events of
   * `REQUEST_KINDS`.
   */
  'request_count',
  /** How many database statements ran: the `db.query` events of `QUERY_KINDS`. */
  'query_count',
  /**
   * Bytes transferred over the network, summed from the `transferSize` key
   * where the browser reports one.
   *
   * The one metric that is legitimately **unobservable**: `transferSize` is
   * available from resource timing for same-origin responses only, and server
   * spans cannot report it at all, so a capture may have no value to give
   * (AAP 0.6.6). A card with no value reads `n/a`; it is never rendered as
   * zero, which would be a measurement the capture never made.
   */
  'transferred_bytes',
  /**
   * Total time the main thread was blocked, summed from the `blockingTime`
   * key of the `perf.longtask` events of `PERF_KINDS`. A duration, not a
   * count — see {@link METRIC_ID_UNITS}.
   */
  'blocking_time',
  /**
   * How many requests repeated a request the capture had already seen: the
   * occurrences past the first in each group keyed by `request_key`, which is
   * computed at ingest from the *unredacted* URL so that two requests
   * differing only in a parameter value are not counted as duplicates of each
   * other (AAP 0.5.2).
   */
  'duplicate_request_count',
  /** How many long tasks occurred: the `perf.longtask` events of `PERF_KINDS`. */
  'long_task_count',
  /**
   * How many failures the capture recorded: the `error` and `server.error`
   * events of `ERROR_KINDS`. An operation of another kind that failed carries
   * `status: 'error'` and is not counted here.
   */
  'error_count',
] as const);

/** One member of the closed computed-metric vocabulary. */
export type MetricId = (typeof METRIC_IDS)[number];

/** Widened view of {@link METRIC_IDS} used by {@link isMetricId}. */
const METRIC_ID_VALUES: readonly string[] = METRIC_IDS;

/**
 * Whether `value` is one of the metric ids this module declares.
 *
 * The membership test for the places that classify a metric id before a schema
 * is available: a stored panel specification read back from the session store,
 * a metrics list arriving from another process, a node option being narrowed
 * before a card is rendered. `packages/panel-schema` validates the same set
 * structurally, through a schema built from {@link METRIC_IDS}; this predicate
 * is for everywhere a schema is not at hand.
 *
 * Accepts `unknown` and narrows, so a caller need not prove it holds a string
 * first.
 */
export function isMetricId(value: unknown): value is MetricId {
  return typeof value === 'string' && METRIC_ID_VALUES.includes(value);
}

/**
 * What a metric's number *is*, and therefore how it may be rendered and
 * summed.
 *
 * - `milliseconds` — a duration, on the millisecond time base every event
 *   uses (AAP 0.2.3). Comparable with a span's `duration` and eligible for the
 *   duration-severity treatment the design tokens define (AAP 0.6.3).
 * - `count` — a whole number of observed things. Never formatted as a
 *   duration, never given a unit suffix.
 * - `bytes` — a transferred size.
 *
 * Declared as a vocabulary rather than left implicit in each consumer because
 * the mistake it prevents is silent: a count rendered through a duration
 * formatter reads as a plausible `4 ms`, and nothing about the number itself
 * says otherwise.
 *
 * Frozen: a read-only vocabulary.
 */
export const METRIC_UNITS = Object.freeze(['milliseconds', 'count', 'bytes'] as const);

/** One member of the closed metric-unit vocabulary. */
export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * The unit each metric's value carries.
 *
 * The single place the monorepo says what kind of number a metric id names, so
 * that the aggregate producing it, the card rendering it and the sentence
 * quoting it cannot disagree. The annotation makes the table total by
 * construction: adding a member to {@link METRIC_IDS} without an entry here is
 * a compile error, and an entry here for an id the vocabulary does not declare
 * is one too.
 *
 * Frozen: a read-only lookup table.
 */
export const METRIC_ID_UNITS: Readonly<Record<MetricId, MetricUnit>> = Object.freeze({
  total_duration: 'milliseconds',
  frontend_duration: 'milliseconds',
  backend_duration: 'milliseconds',
  database_duration: 'milliseconds',
  render_count: 'count',
  unchanged_render_count: 'count',
  render_trigger_unknown_count: 'count',
  request_count: 'count',
  query_count: 'count',
  transferred_bytes: 'bytes',
  blocking_time: 'milliseconds',
  duplicate_request_count: 'count',
  long_task_count: 'count',
  error_count: 'count',
});

/**
 * The unit `metricId`'s value carries.
 *
 * The accessor consumers use instead of reaching into
 * {@link METRIC_ID_UNITS}, so the table's shape stays an implementation detail
 * of this module.
 *
 * Total: the table is exhaustive over the closed metric-id union, so the
 * lookup always succeeds and no fallback or non-null assertion is needed under
 * `noUncheckedIndexedAccess`. A caller holding an unvalidated string narrows it
 * with {@link isMetricId} first.
 *
 * @param metricId - The metric whose unit is wanted.
 */
export function metricUnitFor(metricId: MetricId): MetricUnit {
  return METRIC_ID_UNITS[metricId];
}

/*
 * ---------------------------------------------------------------------------
 * Semantic groups
 *
 * The three groups partition {@link METRIC_IDS} by unit: every id belongs to
 * exactly one, and each group keeps the canonical order of the whole
 * vocabulary.
 *
 * Each group is declared twice on purpose — once as a type derived with
 * `Extract` from {@link MetricId}, once as the frozen list of its members
 * annotated with that type — and neither half is a restatement of the
 * vocabulary. The type cannot admit an id the vocabulary does not declare
 * (`Extract` keeps only what is already a `MetricId`), and the annotated list
 * cannot hold a misspelling, because a string outside the derived union is not
 * assignable to it. A consumer that wants only durations therefore gets a type
 * it can narrow with *and* a list it can iterate, both provably drawn from the
 * one vocabulary above. The colocated suite asserts the third property the
 * compiler cannot see: that the three groups together cover the vocabulary
 * exactly once.
 * ---------------------------------------------------------------------------
 */

/** The metric ids whose value is a duration in milliseconds. */
export type DurationMetricId = Extract<
  MetricId,
  | 'total_duration'
  | 'frontend_duration'
  | 'backend_duration'
  | 'database_duration'
  | 'blocking_time'
>;

/**
 * The duration metrics, in canonical order.
 *
 * The per-tier split (`frontend`, `backend`, `database`) sums to less than
 * `total_duration` whenever an interaction spent time in none of the three —
 * waiting, or in work no signal covered — so a consumer presenting them as a
 * breakdown accounts for the remainder rather than assuming it is zero.
 *
 * Frozen.
 */
export const DURATION_METRIC_IDS: readonly DurationMetricId[] = Object.freeze([
  'total_duration',
  'frontend_duration',
  'backend_duration',
  'database_duration',
  'blocking_time',
] as const);

/**
 * The metric ids whose value is a count of observed things.
 *
 * `packages/model-provider/src/deterministic/templates.ts` carries the noun
 * each of these reads with in a sentence, and restates this member list
 * locally: that package may import `@debuggen/shared` and nothing else of the
 * monorepo (AAP 0.2.2 edge list, AAP 0.5.3 — the provider boundary stays free
 * of telemetry, plan and panel types, and `eslint.config.js` enforces it), so
 * it cannot derive the list from here. This group is the authority the
 * restatement is checked against.
 */
export type CountMetricId = Extract<
  MetricId,
  | 'render_count'
  | 'unchanged_render_count'
  | 'render_trigger_unknown_count'
  | 'request_count'
  | 'query_count'
  | 'duplicate_request_count'
  | 'long_task_count'
  | 'error_count'
>;

/**
 * The counting metrics, in canonical order.
 *
 * Frozen.
 */
export const COUNT_METRIC_IDS: readonly CountMetricId[] = Object.freeze([
  'render_count',
  'unchanged_render_count',
  'render_trigger_unknown_count',
  'request_count',
  'query_count',
  'duplicate_request_count',
  'long_task_count',
  'error_count',
] as const);

/**
 * The metric ids whose value is a transferred size in bytes.
 *
 * One member today. It is declared as a group rather than as a lone constant
 * for the reason the one-member kind groups in `./kinds.ts` are: it is the
 * member list that must not be duplicated, not its length — and a consumer
 * formatting sizes asks for the group, so a second size metric needs no change
 * anywhere but here.
 */
export type ByteMetricId = Extract<MetricId, 'transferred_bytes'>;

/**
 * The size metrics, in canonical order.
 *
 * Frozen.
 */
export const BYTE_METRIC_IDS: readonly ByteMetricId[] = Object.freeze([
  'transferred_bytes',
] as const);
