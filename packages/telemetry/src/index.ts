/**
 * `@debuggen/telemetry` — the evidence layer of the Debug Generator.
 *
 * This package holds the single definition of the telemetry event shape that
 * every tier produces (the browser agent in the inspected page, the Node preload
 * inside the target project's dev server) and every other process consumes (the
 * local service, the DevTools panel, the editor webview), together with the
 * deterministic machinery that turns a flat batch of such events into evidence:
 * the redaction rules that run before an event is persisted or broadcast, the
 * correlator that resolves one interaction into one ordered trace tree, and the
 * capture aggregates — render statistics, request and query groups, timeline
 * lanes, state transitions, the dependency graph and the fixed metric set — that
 * the analysis stage cites and the generated panels query.
 *
 * ## This entry is environment-neutral, and must stay that way
 *
 * The package publishes exactly two entries, and this file is the only one a
 * library consumer imports:
 *
 * - `"."` — **this file**. It is bundled with `platform: "neutral"`, reaches for
 *   no `node:` builtin and no DOM global, and is loaded in four processes: the
 *   local service, the DevTools panel, the editor webview and the shared panel
 *   component library. Nothing it re-exports may pull in the OpenTelemetry SDK,
 *   a Prisma or `pg` instrumentation, or a platform-only API.
 * - `"./node/register"` — the dev-server **preload**, `dist/node/register.mjs`,
 *   which the service (or `scripts/dev-instrumented.mjs`) loads into the target
 *   project's `next dev` process through `NODE_OPTIONS=--import`. It registers a
 *   tracer provider and the database instrumentations and posts server spans to
 *   the service. It is reached only through that export condition and is
 *   deliberately **not** re-exported here: its import graph carries
 *   `@opentelemetry/sdk-trace-node`, `@prisma/instrumentation`,
 *   `@opentelemetry/instrumentation-pg` and Node builtins, any one of which
 *   would break the neutral bundle and drag the whole tracing SDK into the two
 *   browser surfaces that import this package for types.
 *
 * The page agent under `src/browser/**` is likewise absent. It is built by
 * `esbuild.agent.mjs` into the self-contained `dist/browser-agent.iife.js`,
 * copied verbatim into the Chrome extension and injected into the developer's
 * page at `document_start`; it touches DOM globals and is never imported by a
 * library consumer. The runtime-neutral modules below are what both the agent
 * and the preload share with everyone else.
 *
 * `@debuggen/shared` is not re-exported either: consumers depend on it directly,
 * so `SourceLocation` — the one shape this package borrows from it — keeps a
 * single import path.
 *
 * ## What lives behind this entry
 *
 * The four neutral subtrees, re-exported in dependency order:
 *
 * - `schema` — `kinds` (the closed `kind`, `tier` and `status` vocabularies and
 *   the kind→tier rule), `attributes` (the kind-specific attribute keys, the
 *   render phase and trigger vocabularies, the metric ids and units, the
 *   preview/size bounds for captured props and state), `clock-offset` (the
 *   bound, HTTP `Date` parser and interval estimator behind each producer's
 *   informational `clockOffsetMs`) and `event` (the
 *   `TelemetryEventIngress` schema every producer sends and the persisted
 *   `TelemetryEvent` schema the store assigns `sessionId`, `captureId` and
 *   `ingestSeq` to, with their parsers and guards).
 * - `redaction` — `rules` (the deny-list patterns, entropy test, sensitive key
 *   names and the `scrub`/`truncate` primitives), `headers`, `url` and `sql`
 *   (the specialised handlers for header values, query-string values and
 *   inline SQL literals), `request-key` (the pre-redaction HMAC that keys
 *   duplicate detection without retaining the value it keyed) and `redactor`
 *   (the event-level entry point that applies all of them).
 * - `correlation` — `tree` (the `TraceTree`/`TraceNode` shape, its builder and
 *   its walkers, including orphan attachment) and `correlator` (the canonical
 *   ordering — parent before child, then `startTime`, then producer sequence,
 *   then `ingestSeq` — and `correlateEvents`/`correlateTrace`).
 * - `aggregate` — `renders` (`RenderStat`, trigger histograms and the
 *   `ComponentTreeSnapshot`), `requests` (`RequestGroup` with duplicate
 *   detection over the request key), `queries` (`QueryGroup` by normalised
 *   statement with callers), `timeline` (`TimelineView` lanes, `StateTransition`
 *   and `DependencyGraphData`) and `summary` (`CaptureSummary`, `MetricValue`
 *   and `computeCaptureSummary`, the one place the fixed metric set is
 *   computed).
 *
 * Two names collide across the flat re-export and are resolved here by explicit
 * named re-exports rather than by renaming a source symbol: `requests` and
 * `queries` each define their own `DEFAULT_MAX_OCCURRENCES_PER_GROUP`, so that
 * generic name is exported by neither and each bound is reachable under an
 * unambiguous one — `DEFAULT_MAX_REQUEST_OCCURRENCES_PER_GROUP` (the alias
 * `requests` itself provides) and `DEFAULT_MAX_QUERY_OCCURRENCES_PER_GROUP`.
 * `summary` re-exports the metric ids and units it consumes from `attributes`,
 * which is the same binding and therefore not a clash.
 *
 * Importing this module has no side effect: every export is a declaration, and
 * nothing here reads an environment variable, mutates a global, starts a timer
 * or writes to the console at load time.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// schema — the one definition of the event shape and its vocabularies
// ---------------------------------------------------------------------------
export * from './schema/kinds.js';
export * from './schema/attributes.js';
export * from './schema/clock-offset.js';
export * from './schema/event.js';

// ---------------------------------------------------------------------------
// redaction — applied before persistence, before broadcast, before any prompt
// ---------------------------------------------------------------------------
export * from './redaction/rules.js';
export * from './redaction/headers.js';
export * from './redaction/url.js';
export * from './redaction/sql.js';
export * from './redaction/request-key.js';
export * from './redaction/redactor.js';

// ---------------------------------------------------------------------------
// correlation — one interaction, one ordered trace tree
// ---------------------------------------------------------------------------
export * from './correlation/tree.js';
export * from './correlation/correlator.js';

// ---------------------------------------------------------------------------
// aggregate — the capture summary and every array-valued data result
// ---------------------------------------------------------------------------
export * from './aggregate/renders.js';

export {
  DEFAULT_DUPLICATE_WINDOW_MS,
  DEFAULT_MAX_REQUEST_OCCURRENCES_PER_GROUP,
  REQUEST_GROUPED_BY,
  UNKNOWN_METHOD_LABEL,
  UNKNOWN_URL_LABEL,
  aggregateRequests,
  countDuplicateRequests,
} from './aggregate/requests.js';
export type {
  DuplicateWindow,
  RequestAggregateOptions,
  RequestGroup,
  RequestGroupedBy,
  RequestOccurrence,
} from './aggregate/requests.js';

export {
  DEFAULT_MAX_CALLERS_PER_GROUP,
  DEFAULT_MAX_OCCURRENCES_PER_GROUP as DEFAULT_MAX_QUERY_OCCURRENCES_PER_GROUP,
  MAX_CALLER_LOOKUP_HOPS,
  MAX_QUERY_TRACE_IDS_PER_GROUP,
  UNKNOWN_DB_SYSTEM_LABEL,
  UNKNOWN_STATEMENT_KEY,
  aggregateQueries,
} from './aggregate/queries.js';
export type {
  QueryAggregateOptions,
  QueryCaller,
  QueryGroup,
  QueryOccurrence,
} from './aggregate/queries.js';

export * from './aggregate/timeline.js';
export * from './aggregate/summary.js';
