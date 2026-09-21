/**
 * The closed vocabularies of the evidence layer: telemetry **kinds**, **tiers**
 * and **statuses**, plus the named kind *groups* the consumers filter by.
 *
 * This module is the single definition of those vocabularies for the whole
 * monorepo (AAP 0.2.3; AAP 0.9.1 lists `packages/telemetry/src/schema/**` among
 * the single-definition schema sources). A second list of kind strings anywhere
 * in the repository — an inline `['fetch', 'xhr']`, a re-declared union, a
 * `switch` over kinds that spells its own set — is a defect, not a convenience:
 * the vocabulary crosses four processes and three storage formats, and a copy
 * that drifts silently mis-attributes evidence instead of failing loudly. Every
 * set of kinds the product filters by is therefore declared here as a named
 * group, so no other module ever has to hard-code one.
 *
 * ## The metric ids these groups feed
 *
 * Several group declarations below name the computed metrics they are consumed
 * by — `render_count`, `blocking_time`, `query_count` and the rest. Those ids
 * are a closed vocabulary of their own, and they are declared in
 * `./attributes.ts` beside the attribute keys the aggregates read from these
 * kinds: not here, because this module is about what a producer may *emit*,
 * and not in `../aggregate/summary.ts`, which computes their *values* rather
 * than owning their names (AAP 0.2.3). A kind added here that warrants a new
 * metric is therefore a change in both files — the group it joins in this one,
 * and the metric vocabulary in that one.
 *
 * ## Deliberately dependency-free
 *
 * This file imports **nothing** — no schema library, no sibling module, not
 * even a type. The runtime-neutral library, the page-injected browser agent
 * and the dev-server Node preload all need this vocabulary at runtime, and the
 * agent is bundled into an IIFE that is injected into the developer's page at
 * `document_start`; its build audits the bundle's inputs and fails when one
 * resolves to a schema library, a cross-package runtime dependency or a Node
 * builtin. Keeping this module import-free is what lets the page agent, the
 * preload and the service share one vocabulary rather than three.
 *
 * Consequences for edits: only `const` tuples, derived types, frozen lookup
 * tables and small total predicates belong here. Anything that needs a schema
 * library, a Node builtin or a DOM global belongs in `./event.ts`,
 * `../browser/**` or `../node/**` instead.
 *
 * ## Consumers
 *
 * `./event.ts` (the event schema and its kind/tier cross-field check),
 * `./attributes.ts` (the per-kind attribute keys), `../redaction/**`,
 * `../correlation/**`, `../aggregate/**`, `../browser/**` (the page agent),
 * `../node/**` (the preload and its span conversion), the panel node catalog in
 * `packages/panel-schema` and the coordination service in `apps/local-service`.
 *
 * Every export is frozen and every type is read-only: these are vocabularies,
 * not state.
 */

/**
 * Every telemetry kind the product can produce, in declaration order: the
 * browser-tier kinds first, then the server-tier kinds, then the database
 * kind, with the two cross-tier kinds (`function`, `log`) in the positions
 * fixed by AAP 0.2.3.
 *
 * The list is closed. A producer that needs to describe something new adds a
 * member here — which makes the compiler demand an entry in
 * {@link KIND_ALLOWED_TIERS}, an attribute-key declaration in
 * `./attributes.ts` and a decision about every named group below — rather than
 * inventing a string at the call site.
 *
 * Frozen: the array is a read-only vocabulary shared by three runtimes.
 */
export const TELEMETRY_KINDS = Object.freeze([
  /**
   * Browser agent; a user-interaction root span, timed from the capture-phase
   * listener and the `PerformanceObserver('event')` handler entry. The root of
   * a correlated trace: every other kind in the trace descends from one of
   * these.
   */
  'interaction',
  /**
   * Browser agent; one rendered fiber, observed by traversing the fibers a
   * React commit actually rendered.
   */
  'render',
  /**
   * Browser agent; one React commit, observed through the fiber hook's
   * commit callback. Parent of that commit's `render` events.
   */
  'commit',
  /**
   * Browser agent; a call through the patched `window.fetch`. For a
   * same-origin request this is the span whose id the agent injects as the
   * `traceparent` header, which is what joins the browser trace to the server
   * one.
   */
  'fetch',
  /** Browser agent; a request through the patched `XMLHttpRequest`. */
  'xhr',
  /** Browser agent; a `PerformanceNavigationTiming` entry for the document. */
  'navigation',
  /** Browser agent; a `longtask` performance entry. */
  'perf.longtask',
  /**
   * Browser agent; any other captured `PerformanceEntry` — resource, paint,
   * mark or measure.
   */
  'perf.entry',
  /** Browser agent; an `error` or `unhandledrejection` event on the page. */
  'error',
  /**
   * Browser agent; one React hook state transition, derived from the fiber's
   * `memoizedState` chain compared against its alternate.
   */
  'state',
  /**
   * Node preload; the framework's incoming-request span. This is where the
   * browser's `traceparent` is extracted, so it is the server-side root of the
   * correlated trace.
   */
  'http.server',
  /** Node preload; the framework's App Router route-handler span. */
  'route.handler',
  /**
   * Either tier; a named application function timed through the
   * `globalThis.__DEBUGGEN__.span` helper that the reversible AST patch
   * installs. The only signal that requires modifying a file in the
   * developer's project, which is why it is planned per symbol rather than
   * enabled wholesale.
   */
  'function',
  /**
   * Node preload; a database span from the ORM or driver instrumentation. Its
   * statement is stored parameterized and its row contents are never captured.
   */
  'db.query',
  /** Node preload; an outgoing server-side `fetch`. */
  'http.client',
  /** Node preload; an exception raised while handling a server-side request. */
  'server.error',
  /** Either tier; an explicit log record correlated into a trace. */
  'log',
] as const);

/**
 * One member of the closed kind vocabulary.
 *
 * Derived from {@link TELEMETRY_KINDS} so the runtime list and the static type
 * cannot disagree.
 */
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

/**
 * Widened view of {@link TELEMETRY_KINDS} used by {@link isTelemetryKind}.
 *
 * The annotation is the whole point: it lets an arbitrary `string` be tested
 * for membership without asserting anything about the value under test, which
 * is what keeps the predicate honest at a trust boundary.
 */
const KIND_VALUES: readonly string[] = TELEMETRY_KINDS;

/**
 * Narrow an untrusted value to a {@link TelemetryKind} by membership in
 * {@link TELEMETRY_KINDS}.
 *
 * Every event reaching the service arrives from another process, so a kind is
 * validated rather than trusted. The schema in `./event.ts` is the primary
 * gate; this predicate is for the places that classify a value before a schema
 * is available — the page agent's own transport, log-line parsing, and stored
 * rows read back from the session store.
 */
export function isTelemetryKind(value: unknown): value is TelemetryKind {
  return typeof value === 'string' && KIND_VALUES.includes(value);
}

/**
 * The three tiers a telemetry event can be produced in.
 *
 * - `browser` — the page-injected agent: interactions, React work, patched
 *   network calls, performance entries, page errors.
 * - `server` — the dev-server Node preload: incoming requests, route
 *   handlers, outgoing requests, server-side errors.
 * - `db` — database spans from the ORM or driver instrumentation, reported by
 *   the same preload but tiered separately because they are attributed to the
 *   datastore rather than to application code.
 *
 * The split is not cosmetic: it is what makes `frontend_duration`,
 * `backend_duration` and `database_duration` computable from a capture, and
 * what gives the timeline its per-tier lanes (AAP 0.2.3, 0.6.2). A tier is a
 * property of the producer, never of the name of a span, which is why it is a
 * required field on every event rather than something inferred downstream.
 *
 * Frozen: a read-only vocabulary.
 */
export const TELEMETRY_TIERS = Object.freeze(['browser', 'server', 'db'] as const);

/** One member of the closed tier vocabulary. */
export type TelemetryTier = (typeof TELEMETRY_TIERS)[number];

/** Widened view of {@link TELEMETRY_TIERS} used by {@link isTelemetryTier}. */
const TIER_VALUES: readonly string[] = TELEMETRY_TIERS;

/**
 * Narrow an untrusted value to a {@link TelemetryTier} by membership in
 * {@link TELEMETRY_TIERS}.
 */
export function isTelemetryTier(value: unknown): value is TelemetryTier {
  return typeof value === 'string' && TIER_VALUES.includes(value);
}

/**
 * The status of a completed telemetry event.
 *
 * This is the lower-case mirror of the OpenTelemetry span status codes
 * (`UNSET` / `OK` / `ERROR`): the span model of this product is OpenTelemetry's
 * by design (AAP 0.1.1), so the vocabulary follows it rather than inventing a
 * parallel one. Two deliberate differences:
 *
 * - The values are the lower-case strings above, because every event is
 *   persisted and transported as JSON and queried by hand; a numeric code
 *   would need a legend at every read site.
 * - There is no nested status object. Error *detail* — type, message,
 *   stack — travels in the `error.*` attribute keys declared in
 *   `./attributes.ts`, which keeps the persisted row small and every field
 *   directly filterable.
 *
 * Frozen: a read-only vocabulary.
 */
export const TELEMETRY_STATUSES = Object.freeze(['unset', 'ok', 'error'] as const);

/** One member of the closed status vocabulary. */
export type TelemetryStatus = (typeof TELEMETRY_STATUSES)[number];

/** Widened view of {@link TELEMETRY_STATUSES} used by {@link isTelemetryStatus}. */
const STATUS_VALUES: readonly string[] = TELEMETRY_STATUSES;

/**
 * Narrow an untrusted value to a {@link TelemetryStatus} by membership in
 * {@link TELEMETRY_STATUSES}.
 */
export function isTelemetryStatus(value: unknown): value is TelemetryStatus {
  return typeof value === 'string' && STATUS_VALUES.includes(value);
}

/**
 * Mapping from the numeric OpenTelemetry span status codes to this module's
 * {@link TelemetryStatus} vocabulary.
 *
 * The span converter in `../node/**` reads a finished span's numeric
 * `status.code` and needs the string form; it looks it up here so the
 * correspondence is stated once instead of being re-spelled at the conversion
 * site.
 *
 * Compatibility note: the keys `0 | 1 | 2` are the values of OpenTelemetry's
 * `SpanStatusCode` enum (`UNSET`, `OK`, `ERROR`). They are written as literals
 * rather than imported because this module stays dependency-free for the page
 * agent bundle (see the module documentation), and the numeric values are
 * structurally compatible by design — an enum member is assignable to its
 * literal type, so the preload can index this table with a `SpanStatusCode`
 * directly. If the upstream enum ever gains a code, this table gains a key and
 * the compiler will point at every converter that has to decide what it means.
 *
 * Frozen: a read-only lookup table.
 */
export const OTEL_STATUS_CODE_TO_STATUS: Readonly<Record<0 | 1 | 2, TelemetryStatus>> =
  Object.freeze({
    0: 'unset',
    1: 'ok',
    2: 'error',
  } as const);

/*
 * ---------------------------------------------------------------------------
 * Named kind groups
 *
 * Several consumers select events by a *set* of kinds, and the AAP fixes each
 * of those sets. They are declared here, once, so that "no other module may
 * hard-code a kind string list" is achievable rather than aspirational: a
 * consumer imports the group it needs and filters with it.
 *
 * Each group is annotated `readonly TelemetryKind[]` rather than left as a
 * literal tuple. The annotation earns two things at once: the compiler rejects
 * a member that is not a kind, and a caller can still write
 * `GROUP.includes(event.kind)` for an arbitrary `TelemetryKind` — which a
 * narrow tuple type would reject, pushing the caller back towards its own
 * inline list.
 *
 * A group is a filter, not a partition: the groups overlap (a `fetch` event
 * belongs to both the request and the waterfall groups) and they do not cover
 * every kind.
 * ---------------------------------------------------------------------------
 */

/**
 * Requests initiated by the page.
 *
 * Grouped by `../aggregate/requests.ts` into request groups keyed by the
 * pre-redaction request key, which is what duplicate detection and the
 * `request_count` and `duplicate_request_count` metrics are computed from.
 * Server-side outgoing requests (`http.client`) are deliberately excluded: a
 * duplicate there is a different finding with a different remedy.
 */
export const REQUEST_KINDS: readonly TelemetryKind[] = Object.freeze(['fetch', 'xhr'] as const);

/**
 * Every kind the waterfall visualization draws a row for: the browser's
 * requests, the server span that answered one, the database work underneath it
 * and the server's own outgoing requests (AAP 0.6.2).
 *
 * This is the one group that spans all three tiers, which is the point — the
 * waterfall is where a single request's cost is attributed across them.
 */
export const WATERFALL_KINDS: readonly TelemetryKind[] = Object.freeze([
  'fetch',
  'xhr',
  'http.server',
  'db.query',
  'http.client',
] as const);

/**
 * React rendering work: the individual rendered fibers and the commits that
 * contain them.
 *
 * Consumed by `../aggregate/renders.ts` for the per-component render
 * statistics and the component-tree snapshot behind the render-table and
 * component-tree panel sources, and by the `render_count`,
 * `unchanged_render_count` and `render_trigger_unknown_count` metrics.
 */
export const RENDER_KINDS: readonly TelemetryKind[] = Object.freeze(['render', 'commit'] as const);

/**
 * Performance-timeline entries.
 *
 * Consumed by `../aggregate/summary.ts` for `blocking_time`,
 * `long_task_count` and `transferred_bytes` (the last from the resource
 * entries carried as `perf.entry`, which is the only place a transferred size
 * is observable at all).
 */
export const PERF_KINDS: readonly TelemetryKind[] = Object.freeze([
  'perf.longtask',
  'perf.entry',
] as const);

/**
 * Failures, from either tier.
 *
 * Consumed by the `error_count` metric and by the event log's error filter. A
 * failed operation of another kind carries `status: 'error'` instead; these two
 * kinds are the events whose *subject* is the failure.
 */
export const ERROR_KINDS: readonly TelemetryKind[] = Object.freeze([
  'error',
  'server.error',
] as const);

/**
 * Database work.
 *
 * Consumed by `../aggregate/queries.ts`, which groups by normalised statement
 * for the query-table panel source, and by the `query_count` and
 * `database_duration` metrics. A one-member group is still declared here: it is
 * the member list that must not be duplicated, not its length.
 */
export const QUERY_KINDS: readonly TelemetryKind[] = Object.freeze(['db.query'] as const);

/**
 * React hook state transitions.
 *
 * Consumed by the state-transition panel source, which pairs each transition
 * with the event that triggered it.
 */
export const STATE_KINDS: readonly TelemetryKind[] = Object.freeze(['state'] as const);

/*
 * ---------------------------------------------------------------------------
 * Kind/tier compatibility
 *
 * The tier arrays below are shared between the kinds that permit the same
 * tiers. Sharing is safe — they are frozen and typed read-only — and it makes
 * the table below read as the four rules it encodes rather than as seventeen
 * unrelated literals.
 * ---------------------------------------------------------------------------
 */

/** Tier list for a kind only the page agent can produce. */
const BROWSER_ONLY: readonly TelemetryTier[] = Object.freeze(['browser'] as const);

/** Tier list for a kind only the server-side preload can produce. */
const SERVER_ONLY: readonly TelemetryTier[] = Object.freeze(['server'] as const);

/** Tier list for a kind attributed to the datastore. */
const DB_ONLY: readonly TelemetryTier[] = Object.freeze(['db'] as const);

/** Tier list for a kind either runtime can produce. */
const BROWSER_OR_SERVER: readonly TelemetryTier[] = Object.freeze(['browser', 'server'] as const);

/**
 * For each kind, the tiers a well-formed producer may report it in.
 *
 * This is the single place in the monorepo that says which tier a kind belongs
 * to. The event schema's cross-field check consults it, the aggregates rely on
 * it instead of re-deciding per metric, and nothing else restates it. The
 * annotation makes the table total by construction: adding a member to
 * {@link TELEMETRY_KINDS} without an entry here is a compile error.
 *
 * The rules it encodes:
 *
 * - `browser` only — everything the page agent observes.
 * - `server` only — everything the dev-server preload observes about request
 *   handling.
 * - `db` only — database spans, tiered by their subject rather than by the
 *   process that reported them.
 * - `browser` or `server` — the two cross-tier kinds: a named function can be
 *   timed on either side (AAP 0.5.1), and a correlated log record can
 *   originate on either side.
 *
 * Maintenance rule: if a producer legitimately needs another tier for a kind,
 * **widen this map** — and say why in the entry. Never weaken the check in
 * `./event.ts`, which is the only thing standing between a mis-tiered event
 * and a per-tier duration that silently does not add up.
 *
 * Frozen: a read-only lookup table.
 */
export const KIND_ALLOWED_TIERS: Readonly<Record<TelemetryKind, readonly TelemetryTier[]>> =
  Object.freeze({
    interaction: BROWSER_ONLY,
    render: BROWSER_ONLY,
    commit: BROWSER_ONLY,
    fetch: BROWSER_ONLY,
    xhr: BROWSER_ONLY,
    navigation: BROWSER_ONLY,
    'perf.longtask': BROWSER_ONLY,
    'perf.entry': BROWSER_ONLY,
    error: BROWSER_ONLY,
    state: BROWSER_ONLY,
    'http.server': SERVER_ONLY,
    'route.handler': SERVER_ONLY,
    function: BROWSER_OR_SERVER,
    'db.query': DB_ONLY,
    'http.client': SERVER_ONLY,
    'server.error': SERVER_ONLY,
    log: BROWSER_OR_SERVER,
  });

/**
 * The tiers `kind` may be reported in.
 *
 * Total: {@link KIND_ALLOWED_TIERS} has an entry for every member of
 * {@link TELEMETRY_KINDS}, and the key type is that same closed union, so the
 * lookup is exact and the result is never `undefined` — no fallback and no
 * non-null assertion is needed even under `noUncheckedIndexedAccess`.
 *
 * The returned array is frozen and shared; treat it as read-only. Callers that
 * need a mutable copy take one (`[...allowedTiersFor(kind)]`).
 */
export function allowedTiersFor(kind: TelemetryKind): readonly TelemetryTier[] {
  return KIND_ALLOWED_TIERS[kind];
}

/**
 * Whether `tier` is a tier that `kind` may be reported in.
 *
 * The cross-field check behind the event schema, and the assertion the
 * ingestion path uses to reject an event whose producer mislabelled itself
 * before it can distort a per-tier duration.
 */
export function isTierAllowedForKind(kind: TelemetryKind, tier: TelemetryTier): boolean {
  return KIND_ALLOWED_TIERS[kind].includes(tier);
}
