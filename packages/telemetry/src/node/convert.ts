/**
 * The span → event conversion: one `ReadableSpan` finished inside the
 * developer's dev-server process becomes one {@link TelemetryEventIngress}, the
 * product's single event shape.
 *
 * Everything the service later attributes, correlates, aggregates, renders and
 * links back to source on the **server** side passes through this file. The
 * browser tier has its own producer (`../browser/*`); this one covers the two
 * tiers a Node process can speak for — `server` and `db` — and never emits a
 * `browser` event.
 *
 * `./exporter.ts` is the only caller: its `SpanProcessor.onEnd` classifies a
 * span with {@link classifySpan} to ask its capture gate whether that signal is
 * enabled, then converts with {@link spanToIngressEvent} and drops a `null`.
 *
 * ## The time base is canonical, and this file does not re-derive it
 *
 * `startTime` is Unix epoch **milliseconds as a double with sub-millisecond
 * precision** and `duration` is milliseconds (AAP §0.2.3). Both are produced
 * exclusively with `@debuggen/shared`'s helpers — `hrTimeToEpochMs`,
 * `hrTimeDurationMs`, `clampNonNegative` and `roundMs` — because
 * `packages/shared/src/time.test.ts` declares its conversion vectors canonical
 * *for this file*, and its `HrTime` tuple exists precisely so an OpenTelemetry
 * `[seconds, nanoseconds]` pair can be handed in without the base package
 * taking an `@opentelemetry/*` dependency. Re-deriving the arithmetic here
 * would put a second answer in the repository; there is exactly one.
 *
 * Nanosecond remainders are kept as a fraction of a millisecond and rounded to
 * three decimals, so two spans that start inside the same millisecond — which
 * every fast handler and its query do — still order correctly, and stored JSON
 * is stable at microsecond resolution rather than carrying binary noise.
 *
 * ## Framework and instrumentation names live in one table
 *
 * Every literal this file matches on — Next.js's span types and span-name
 * shapes, the Prisma and `pg` instrumentation scope names, the exception event
 * convention, and the alias→canonical attribute spellings — is declared in the
 * constant tables at the top of the module and nowhere else. A framework or
 * instrumentation upgrade is therefore a one-place change, and the sibling
 * `convert.test.ts` can iterate the tables instead of restating them. The
 * names are the *framework's* vocabulary, never an application's: no name,
 * route or symbol of any particular project appears here, which is what
 * `scripts/check-no-hardcoding.mjs` enforces.
 *
 * ## `seq` is scoped to `(producerId, captureId)`
 *
 * `seq` is a zero-based per-producer counter, and its scope is the pair
 * `(producerId, captureId)` (AAP §0.2.3): {@link createSeqAllocator} keeps one
 * counter per producer id and restarts it at zero whenever that producer's
 * capture changes. Both halves of the scope are the allocator's arguments
 * rather than one argument and one convention, because the correlator's
 * canonical ordering is *parent before child*, then `startTime`, then
 * `(producerId, seq)`, then the store-assigned `ingestSeq` — so `seq` is what
 * separates two events of one producer that share a millisecond, and a counter
 * two producers drew from in turn would report each of them as a producer whose
 * events arrived out of order. Gaps are harmless (a skipped span consumes no
 * number); going backwards is not, which is why the counter is never recomputed
 * from anything else.
 *
 * ## Four fields this file must never set, and one it may
 *
 * `sessionId`, `captureId` and `ingestSeq` belong to the **persisted** schema
 * only. `../schema/event.ts` makes the ingress schema strict, so any one of
 * them would be a hard rejection at ingest — which is the intended outcome,
 * because attribution is the service's job
 * (`apps/local-service/src/telemetry/attribute.ts`). `redacted` belongs to
 * `../redaction/redactor.ts`, and `attributes.request_key` is computed at
 * ingest from the *unredacted* URL under a per-session HMAC key — writing one
 * here would both be wrong and leak the grouping key.
 *
 * `source` is the exception, and only on one kind. The first of the four source
 * routes (AAP §0.4.2) is the metadata a reversible patch *recorded* when it
 * wrapped a function: `packages/instrumentation/src/patch/wrap-template.ts`
 * emits a project-relative POSIX `file`, a 1-based `line` and `column` and the
 * wrapped `symbol` into the `meta` literal of every wrapper it writes, and
 * `./span-helper.ts` puts them on the span. Forwarding recorded evidence is not
 * guessing at a location, so {@link spanToIngressEvent} emits it as
 * `resolvedBy: 'patch'` — see {@link deriveFunctionSource}, which validates the
 * candidate against the one shared schema and omits the field entirely rather
 * than emitting a location it cannot vouch for. Every other kind's location is
 * still resolved in the service through the code graph, the route map and
 * source maps, and this file invents nothing for them.
 *
 * ## Redaction happens downstream; widening is what is forbidden here
 *
 * This file does not redact. `apps/local-service/src/telemetry/ingest.ts` runs
 * `../redaction/*` before anything is persisted or broadcast, and
 * `packages/model-provider/src/redact-guard.ts` runs again on any outbound
 * prompt (AAP §0.5.2). What this file owes the privacy model is a faithful and
 * *bounded* translation that never widens what was captured: no request or
 * response body, no query result rows, no unbounded pass-through of an
 * attribute nobody declared. `db.statement` is expected to arrive as
 * parameterized text (`$1` placeholders) and is scrubbed and length-bounded by
 * `../redaction/sql.ts` at ingest, which is why it is copied verbatim here
 * instead of being cut to a preview length that would ruin the query table.
 *
 * The keys the product declares are a reviewed set; anything else on a span is
 * whatever a third-party instrumentation in the host process chose to attach,
 * and it reaches the store, the live tail and a model prompt. The downstream
 * redactor recognises *patterns* (a token-shaped value) and *declared* keys (a
 * URL, a statement, a header), which is exactly what a body, a result row or a
 * customer's e-mail address under an undeclared key is not — and a one-line
 * `name=Alice&email=…` under `request.data` is a body that looks like a label
 * to every rule except one. So the pass-through pass admits a key only when a
 * reviewer has vouched for it ({@link isAdmissibleAttributeKey}: the product's
 * catalog, this module's reviewed vocabulary, or the product's own namespace),
 * and refuses whole families of key on top of that
 * ({@link DENIED_ATTRIBUTE_KEY_FAMILIES}).
 *
 * ## Failure contract
 *
 * {@link spanToIngressEvent} returns `null` for a span it deliberately does not
 * emit and **never throws**. A span reaching the host process's span pipeline
 * may come from any third-party instrumentation and have any shape, and a throw
 * here would propagate into the developer's dev server — which AAP §0.5.1's
 * "the application keeps serving" guarantee forbids. Every field access is
 * guarded, a surprise is a skip, and the module is pure apart from the sequence
 * allocator's counter: no I/O, no timers, no network. `./exporter.ts` owns
 * transport.
 *
 * @example Converting inside a span processor
 * ```ts
 * onEnd(span: ReadableSpan): void {
 *   const classification = classifySpan(span);
 *   if (classification === null || !gate.isKindEnabled(classification.kind)) return;
 *   const event = spanToIngressEvent(span, {
 *     captureId: gate.captureId,
 *     producerId: config.producerId,
 *   });
 *   if (event !== null) this.enqueue(event);
 * }
 * ```
 */

import {
  clampNonNegative,
  DEFAULT_RESOLUTION_CONFIDENCE,
  hrTimeDurationMs,
  hrTimeToEpochMs,
  isSourceLocation,
  isSpanId,
  isTraceId,
  newEventId,
  normalizePosix,
  roundMs,
} from '@debuggen/shared';
import type { HrTime, SourceLocation } from '@debuggen/shared';
import { SpanKind } from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';

import {
  ALL_ATTRIBUTE_KEYS,
  attributeKeysFor,
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
} from '../schema/attributes.js';
import { MAX_EPOCH_MS, MIN_EPOCH_MS } from '../schema/event.js';
import type { TelemetryEventIngress } from '../schema/event.js';
import { isTierAllowedForKind, OTEL_STATUS_CODE_TO_STATUS } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryStatus, TelemetryTier } from '../schema/kinds.js';
import { PRODUCER_ID, TRACER_NAME } from './config.js';

/*
 * ---------------------------------------------------------------------------
 * Framework vocabulary
 *
 * The literals below are how the *installed*, pinned versions spell
 * themselves — read out of the packages on disk rather than from a tutorial —
 * and they are the only place in the repository that names them. Each entry
 * records where it comes from, so an upgrade is checked against one table.
 * ---------------------------------------------------------------------------
 */

/**
 * The attribute Next.js sets on every span it creates, naming the *type* of
 * framework operation.
 *
 * Preferred over the span's display name wherever both are available: the
 * display name is a presentation string the framework rewrites mid-request
 * (a request span is renamed from `GET` to `GET /route` once the route is
 * known), whereas the type is a stable enum member.
 */
export const NEXT_SPAN_TYPE_ATTRIBUTE = 'next.span_type';

/**
 * The attribute Next.js sets alongside {@link NEXT_SPAN_TYPE_ATTRIBUTE}
 * carrying the span's display name.
 *
 * Declared because it is part of the framework's own key set and is passed
 * through on the kinds that declare it (`http.server`, `route.handler`); the
 * conversion reads the span's `name` rather than this attribute, because the
 * two agree and `name` is present even when the attribute is not.
 */
export const NEXT_SPAN_NAME_ATTRIBUTE = 'next.span_name';

/**
 * The Next.js span types this file classifies, with the kind each becomes.
 *
 * Values are the framework's enum members (`next/dist/server/lib/trace/
 * constants.js`): `BaseServerSpan.handleRequest`,
 * `AppRouteRouteHandlersSpan.runHandler`, `NodeSpan.runHandler`,
 * `AppRenderSpan.fetch` and `NextNodeServerSpan.internalFetch`.
 *
 * Everything else the framework emits is deliberately absent — see
 * {@link classifySpan} for why an unclassified span is skipped rather than
 * stored under an approximate kind.
 */
export const NEXT_SPAN_TYPES = Object.freeze({
  /** The incoming-request span, and the server-side root of a correlated trace. */
  request: 'BaseServer.handleRequest',
  /** The App Router route-handler span. */
  appRouteHandler: 'AppRouteRouteHandlers.runHandler',
  /** The Pages Router API-handler span, which the same kind describes. */
  pagesApiHandler: 'Node.runHandler',
  /** An outgoing `fetch` made while rendering or handling a request. */
  serverFetch: 'AppRender.fetch',
  /** An outgoing `fetch` the framework makes on its own behalf. */
  internalFetch: 'internalFetch',
} as const);

/**
 * Span-name shapes used as a secondary signal, for a span that carries no
 * {@link NEXT_SPAN_TYPE_ATTRIBUTE} — a framework version that stops setting
 * it, or a span created by a compatible adapter.
 *
 * Both are prefixes, because the framework appends per-request information:
 * `executing api route (app) <route>` / `executing api route (pages) <page>`,
 * and `fetch <METHOD> <URL>`.
 */
export const NEXT_SPAN_NAME_PREFIXES = Object.freeze({
  /** Matches the `(app)` and `(pages)` route-handler variants and any suffix. */
  apiRouteHandler: 'executing api route',
  /** The leading token of an outgoing-request span name; requires client span kind. */
  serverFetch: 'fetch ',
} as const);

/**
 * Instrumentation scope names that mark a span as a database span.
 *
 * Deliberately version-free. `@prisma/instrumentation` registers itself under
 * its package name but *creates* its spans through a tracer named `prisma`, so
 * both spellings are matched — the exact name and the package prefix — and the
 * driver instrumentation is matched by its package name.
 */
export const DB_INSTRUMENTATION_SCOPES = Object.freeze({
  /** The tracer name the ORM instrumentation creates its spans with. */
  orm: 'prisma',
  /** Package prefix covering the ORM instrumentation's own scope name. */
  ormScopePrefix: '@prisma/',
  /** The driver instrumentation's package name, which is also its scope name. */
  driver: '@opentelemetry/instrumentation-pg',
} as const);

/**
 * Span-name prefixes the database instrumentations use, matched as a secondary
 * signal when a scope name is missing.
 *
 * `prisma:client:<operation>` and `prisma:engine:<operation>` for the ORM;
 * `pg.query:<COMMAND>[ <database>]` for the driver's statements, plus the
 * driver's two connection-acquisition spans, which are the pinned
 * `@opentelemetry/instrumentation-pg` 0.74.0 `SpanNames.CONNECT` and
 * `SpanNames.POOL_CONNECT`.
 *
 * The two connect names are here because they are database spans that carry no
 * `db.statement`: a capture that acquires a pooled connection spends real
 * database-tier time on it, and a span this table did not know would be judged
 * by span kind instead — the driver reports a client-kind span, so it would be
 * mistaken for an outgoing HTTP request. They are also what lets
 * {@link deriveDbOperation} name a connection acquisition `connect`, which is
 * how `../aggregate/queries.ts` can tell lifecycle work from a statement
 * execution rather than inferring it from an absent attribute.
 */
export const DB_SPAN_NAME_PREFIXES = Object.freeze({
  /** ORM span names, client and engine alike. */
  orm: 'prisma:',
  /** Driver query span names. */
  driver: 'pg.query',
  /** The driver's span for acquiring a connection directly. */
  driverConnect: 'pg.connect',
  /** The driver's span for acquiring a connection from its pool. */
  driverPoolConnect: 'pg-pool.connect',
} as const);

/**
 * Values of the `db.client` attribute: which producer a database span came
 * from.
 *
 * Declared in `../schema/attributes.ts` as the key that lets a consumer tell an
 * ORM span from the driver span underneath it and so avoid counting one query
 * twice. Derived from the instrumentation scope, because neither
 * instrumentation reports it.
 */
export const DB_CLIENT_VALUES = Object.freeze({
  /** The ORM's own span. */
  orm: 'prisma',
  /** The driver's span. */
  driver: 'pg',
} as const);

/**
 * {@link DB_SPAN_NAME_PREFIXES}, grouped by the {@link DB_CLIENT_VALUES} each
 * prefix identifies.
 *
 * One table, two readers: {@link classifySpan} iterates *every* prefix in it to
 * decide that a span is database work at all, and {@link deriveDbClient}
 * iterates one group to decide which library reported it. Iterating a table
 * rather than naming `orm` and `driver` in each function is what keeps a prefix
 * added above from being honoured by one reader and ignored by the other — the
 * failure mode that would classify a span as `db.query` and then leave its
 * `db.client` empty, which is the attribute the aggregates use to tell two
 * observations of one statement apart.
 *
 * Every value of the prefix table appears in exactly one group, and
 * `convert.test.ts` asserts that behaviourally: it drives
 * `Object.values(DB_SPAN_NAME_PREFIXES)` through {@link classifySpan} and
 * {@link classifyDatabaseSource} and requires an answer from both, so a prefix
 * added to the table without a group here fails a test instead of silently
 * losing its client attribution.
 */
const DB_SPAN_NAME_PREFIXES_BY_CLIENT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [DB_CLIENT_VALUES.orm]: Object.freeze([DB_SPAN_NAME_PREFIXES.orm]),
  [DB_CLIENT_VALUES.driver]: Object.freeze([
    DB_SPAN_NAME_PREFIXES.driver,
    DB_SPAN_NAME_PREFIXES.driverConnect,
    DB_SPAN_NAME_PREFIXES.driverPoolConnect,
  ]),
});

/**
 * The driver's connection-acquisition span names, as the one list both the
 * client derivation and the operation derivation read.
 *
 * A connection acquisition is the driver's own lifecycle work rather than a
 * statement, and its span name carries no `:<COMMAND>` segment to parse, so it
 * is named rather than parsed; see {@link DRIVER_CONNECT_OPERATION}.
 */
const DRIVER_CONNECT_SPAN_NAMES: readonly string[] = Object.freeze([
  DB_SPAN_NAME_PREFIXES.driverConnect,
  DB_SPAN_NAME_PREFIXES.driverPoolConnect,
]);

/**
 * The `db.operation` value of the driver's two connection-acquisition spans.
 *
 * Neither span reports an operation and neither name carries one, so without
 * this a connection acquisition would arrive as a database span with no
 * statement *and* no operation — indistinguishable from a statement whose text
 * the producer failed to report. Naming it is what lets a consumer say what the
 * span was, and `../aggregate/queries.ts` documents the same distinction from
 * the reading end.
 */
const DRIVER_CONNECT_OPERATION = 'connect';

/**
 * The separator inside a segmented database span name
 * (`prisma:client:<operation>`, `pg.query:<COMMAND>`).
 *
 * Read by {@link deriveDbOperation} to tell a segmented ORM span name from the
 * engine's bare ones (`start_transaction`, `commit_transaction`,
 * `transaction`), whose whole name *is* the operation.
 */
const DB_SPAN_NAME_SEGMENT_SEPARATOR = ':';

/**
 * The attribute `./span-helper.ts` sets on a span it created for an
 * AST-patched application function, and the accepted spellings of it.
 *
 * **The agreement, stated at this end of it:** the *primary* signal for the
 * `function` kind is the instrumentation scope name, which is `TRACER_NAME`
 * from `./config.js` — a constant both files import, so it cannot drift. This
 * marker is the *secondary* signal, for a span produced through a tracer the
 * helper did not name itself (a provider that rewrites scopes, a test double).
 * The first entry is canonical; the rest are accepted so that a marker spelled
 * in a neighbouring style still classifies rather than silently becoming
 * framework noise. The same note appears in `./span-helper.ts`.
 *
 * A marker is honoured whatever its value: presence is the signal, and a
 * helper that sets `true` and one that sets the action id both work.
 *
 * The canonical spelling is exactly `./span-helper.ts`'s
 * `FUNCTION_SPAN_MARKER_KEY`, whose value carries the `TelemetryKind` the span
 * converts to. The two are stated at both ends rather than imported here: this
 * module is the one table of the vocabulary it matches on and takes no
 * dependency on the helper, so `convert.test.ts` pins the literal from this
 * side and a change to either end fails there instead of silently disabling
 * the secondary signal.
 */
export const FUNCTION_SPAN_MARKER_ATTRIBUTE = 'debuggen.kind';

/** Accepted spellings of {@link FUNCTION_SPAN_MARKER_ATTRIBUTE}, canonical first. */
export const FUNCTION_SPAN_MARKER_ATTRIBUTES: readonly string[] = Object.freeze([
  FUNCTION_SPAN_MARKER_ATTRIBUTE,
  'debuggenFunction',
  'debuggen.function',
  'debuggen.span',
]);

/**
 * The attribute keys carrying the location a reversible patch recorded, as
 * `./span-helper.ts` leaves them on a function span.
 *
 * **Where the values come from.**
 * `packages/instrumentation/src/patch/wrap-template.ts` builds the wrapper's
 * `meta` literal from its own `PATCH_META_KEYS` — `file`, `line`, `column`,
 * `symbol` — with `file` already normalised to a project-relative POSIX path
 * and `line`/`column` already 1-based, because the patcher read them off the
 * declaration it was wrapping. `./span-helper.ts` copies `meta`'s primitives
 * onto the span it creates. So these four keys are *recorded evidence*, not an
 * inference, which is what makes the location they describe
 * `resolvedBy: 'patch'` — the most precise of AAP §0.4.2's four routes.
 *
 * Stated at this end rather than imported, for the same reason
 * {@link FUNCTION_SPAN_MARKER_ATTRIBUTE} is: `@debuggen/telemetry` sits *below*
 * `@debuggen/instrumentation` in the layering (AAP §0.2.2), so the dependency
 * would be backwards. `convert.test.ts` pins these literals from this side, and
 * `packages/instrumentation`'s own suite pins them from the other, so a rename
 * at either end fails a test instead of silently emptying every function
 * span's source link.
 *
 * `symbol` is deliberately *also* a declared `function` attribute
 * (`../schema/attributes.ts`): it is the span's label as well as the location's,
 * so it travels in both places. `file`, `line` and `column` are consumed into
 * the location — see {@link SOURCE_ONLY_ATTRIBUTE_KEYS}.
 */
export const PATCH_SOURCE_ATTRIBUTES = Object.freeze({
  /** Project-relative POSIX path of the patched declaration. */
  file: 'file',
  /** 1-based line of the patched declaration. */
  line: 'line',
  /** 1-based column of the patched declaration. */
  column: 'column',
  /** The wrapped symbol's name, as the code graph knows it. */
  symbol: 'symbol',
} as const);

/**
 * The patch-metadata keys a successfully built location **consumes**.
 *
 * `source` is the structured, validated home for a location, so repeating three
 * fields in the attribute bag of every function span would cost bytes on the
 * hot path for nothing, and would leave two answers to one question where a
 * consumer could pick the unvalidated one. When the location is *rejected* they
 * travel like any other undeclared attribute, so the malformed hint stays
 * visible to whoever has to explain a missing source link.
 *
 * Exactly the rule `../browser/span-helper.ts` applies to the same metadata on
 * the page side, so a function span means the same thing on both tiers.
 */
const SOURCE_ONLY_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  PATCH_SOURCE_ATTRIBUTES.file,
  PATCH_SOURCE_ATTRIBUTES.line,
  PATCH_SOURCE_ATTRIBUTES.column,
]);

/**
 * The OpenTelemetry span-event name a recorded exception uses, and the event
 * attributes it carries.
 *
 * Written out rather than imported from `@opentelemetry/semantic-conventions`:
 * that package is not an import this file is allowed, and these four strings
 * are part of the same one-table discipline as the framework names above. They
 * are the convention's `exception` event with `exception.type`,
 * `exception.message` and `exception.stacktrace`.
 */
export const EXCEPTION_EVENT_NAME = 'exception';

/** Event attributes of an {@link EXCEPTION_EVENT_NAME} event, mapped onto the `error.*` keys. */
export const EXCEPTION_EVENT_ATTRIBUTES = Object.freeze({
  /** Becomes `error.type`. */
  type: 'exception.type',
  /** Becomes `error.message`. */
  message: 'exception.message',
  /** Becomes `error.stack`. */
  stack: 'exception.stacktrace',
} as const);

/*
 * ---------------------------------------------------------------------------
 * Canonical attribute keys and the alias translation
 * ---------------------------------------------------------------------------
 */

/**
 * The canonical product spellings this file writes, referenced by the
 * derivations below so no key string appears twice in the module.
 *
 * These are the spellings AAP §0.2.3 and §0.6.2 fixed and that
 * `../schema/attributes.ts` declares: deliberately the *older* semantic
 * convention names, because `packages/panel-schema`'s node catalog and
 * `../aggregate/*` read these exact strings. They are not renamed to follow a
 * newer convention; instead {@link ATTRIBUTE_KEY_TRANSLATIONS} maps whatever
 * the installed instrumentations emit onto them.
 */
const CANONICAL = Object.freeze({
  httpMethod: 'http.method',
  httpRoute: 'http.route',
  httpStatusCode: 'http.status_code',
  url: 'url',
  nextRoute: 'next.route',
  dbSystem: 'db.system',
  dbStatement: 'db.statement',
  dbRowCount: 'db.rowCount',
  dbOperation: 'db.operation',
  dbName: 'db.name',
  dbClient: 'db.client',
  symbol: 'symbol',
  errorType: 'error.type',
  errorMessage: 'error.message',
  errorStack: 'error.stack',
} as const);

/**
 * Incoming attribute spelling → canonical product spelling, in precedence
 * order.
 *
 * The one table that absorbs every difference between what an instrumentation
 * emits and what the product reads, so that **nothing downstream of this
 * conversion ever sees an instrumentation's own spelling** and nothing
 * downstream has to be changed to accommodate one.
 *
 * Why each entry exists, from the pinned versions:
 *
 * - `http.request.method`, `http.response.status_code`, `url.full` — the
 *   current HTTP semantic conventions, which a third-party instrumentation in
 *   the host process may use.
 * - `http.target` — the framework's request span carries the request URL here.
 * - `http.url` — the framework's outgoing-fetch span carries the target here.
 * - `db.system.name`, `db.query.text`, `db.operation.name`, `db.namespace`,
 *   `db.response.returned_rows` — the current database semantic conventions,
 *   which the pinned driver instrumentation emits. The product has no newer
 *   equivalent of `db.rowCount` at all, which is one reason the older
 *   spellings are the canonical ones.
 *
 * Ordering is the precedence: an alias is applied only when its canonical key
 * is still unset, so a span carrying both a canonical key and an alias keeps
 * the canonical value, and a span carrying two aliases of one key keeps the
 * earlier entry here. That makes the result independent of the order in which
 * a producer happened to set its attributes.
 *
 * An alias key is **consumed**: it never also travels under its own name.
 *
 * Frozen. The pairs are literal tuples, so the freeze is shallow by
 * construction rather than by omission.
 */
export const ATTRIBUTE_KEY_TRANSLATIONS: readonly (readonly [string, string])[] = Object.freeze([
  ['http.request.method', CANONICAL.httpMethod],
  ['http.response.status_code', CANONICAL.httpStatusCode],
  ['http.target', CANONICAL.url],
  ['http.url', CANONICAL.url],
  ['url.full', CANONICAL.url],
  ['db.system.name', CANONICAL.dbSystem],
  ['db.query.text', CANONICAL.dbStatement],
  ['db.operation.name', CANONICAL.dbOperation],
  ['db.namespace', CANONICAL.dbName],
  ['db.response.returned_rows', CANONICAL.dbRowCount],
] as const);

/**
 * The alias keys of {@link ATTRIBUTE_KEY_TRANSLATIONS} as a set, so the
 * pass-through pass can drop them in constant time.
 */
const ALIAS_KEYS: ReadonlySet<string> = new Set(
  ATTRIBUTE_KEY_TRANSLATIONS.map(([incoming]) => incoming),
);

/**
 * Keys the service assigns at ingest, which this producer must never emit.
 *
 * Read from `../schema/attributes.ts` rather than restated: today it is
 * `request_key` alone, and a key added there is filtered here without an edit.
 */
const SERVICE_ASSIGNED_KEYS: ReadonlySet<string> = new Set(SERVICE_ASSIGNED_ATTRIBUTE_KEYS);

/**
 * Every key the product's catalog declares, for any kind, as a set.
 *
 * Half of the pass-through pass's **allowlist**: a key in here is one the
 * product reasoned about — `../schema/attributes.ts` documents what it means,
 * an aggregate or a panel node reads it, and `../redaction/*` knows how to
 * treat it.
 *
 * `ALL_ATTRIBUTE_KEYS` is *not* a whitelist for the schema (that module says so
 * itself: an event may legally carry keys outside it). It is one *here*, for
 * this producer's pass-through decision only, which is a different question:
 * the schema asks "is this event well-formed", and this file asks "may this
 * process forward a value nobody reviewed".
 */
const DECLARED_KEYS: ReadonlySet<string> = new Set(ALL_ATTRIBUTE_KEYS);

/**
 * The other half of the allowlist: keys the product does not declare but has
 * **reviewed**, from the vocabulary of the pinned framework, instrumentations
 * and semantic conventions.
 *
 * Each one is metadata about an operation — a route shape, a host, a port, a
 * protocol, a code location, a runtime version, a scope name — and none of them
 * can carry a request body, a result row or a person's details, which is the
 * standard for being on this list. A key that would be *useful* but is missing
 * is added here, by a reviewer, rather than admitted by a rule that would let
 * every unknown key through with it.
 *
 * Why an exact-key list and not a namespace rule: the leak this list closes is
 * the *unknown* key with the *innocuous* name. `http.request.data` carrying
 * `name=Alice&email=…` is in the `http` namespace, has no word the deny list
 * refuses, and is one line of ordinary text — so a namespace rule, a name rule
 * and a shape rule all admit it, and only an allowlist does not. AAP §0.5.2
 * puts bodies and row contents outside what may be captured at all, and that is
 * a rule about what arrives, not a hope about what a later layer recognises.
 *
 * Grouped by where each spelling comes from, so an upgrade is checked against
 * one table.
 */
export const PASS_THROUGH_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  // The framework's own span vocabulary, beyond the keys the catalog declares.
  'next.span_name',
  'next.page',
  'next.rsc',
  'next.segment',
  // The position a reversible patch recorded. Written by the product's own
  // patch template rather than by a foreign instrumentation, and consumed into
  // `source` when the location validates - so they are forwarded only when it
  // did not, which is what keeps a malformed hint visible.
  PATCH_SOURCE_ATTRIBUTES.file,
  PATCH_SOURCE_ATTRIBUTES.line,
  PATCH_SOURCE_ATTRIBUTES.column,
  // HTTP and network metadata: who was talked to, over what, never what was
  // said. The two body *sizes* are the semantic conventions' own spellings and
  // are the `transferred_bytes` evidence AAP 0.6.6 asks for; the bodies
  // themselves have no spelling on this list.
  'http.scheme',
  'http.host',
  'http.flavor',
  'http.request.body.size',
  'http.response.body.size',
  'net.transport',
  'net.peer.name',
  'net.peer.port',
  'net.host.name',
  'net.host.port',
  'network.transport',
  'network.protocol.name',
  'network.protocol.version',
  'server.address',
  'server.port',
  'url.scheme',
  'url.path',
  // Code location, which is evidence of exactly the kind this product exists to
  // show: where an operation runs.
  'code.function',
  'code.function.name',
  'code.namespace',
  'code.filepath',
  'code.file.path',
  'code.lineno',
  'code.line.number',
  'code.column',
  'code.column.number',
  // The database clients' own operation vocabulary. Deliberately no
  // connection string, no database user and no statement spelling the catalog
  // does not already declare.
  'db.collection.name',
  'method',
  'model',
  // The SDK, the service and the process, as the pinned SDK reports them.
  'otel.status_code',
  'otel.status_description',
  'otel.scope.name',
  'otel.scope.version',
  'otel.library.name',
  'otel.library.version',
  'service.name',
  'service.version',
  'service.instance.id',
  'process.pid',
  'process.runtime.name',
  'process.runtime.version',
  'thread.id',
  'thread.name',
  // Remote-call metadata, for an instrumentation that reports one.
  'rpc.system',
  'rpc.service',
  'rpc.method',
  // Exception metadata. The message and the stack arrive through pass C's
  // `error.*` keys instead, where the redactor knows to scrub them.
  'exception.type',
  'exception.escaped',
]);

/** {@link PASS_THROUGH_ATTRIBUTE_KEYS} as a set. */
const REVIEWED_KEYS: ReadonlySet<string> = new Set(PASS_THROUGH_ATTRIBUTE_KEYS);

/**
 * The namespace only this product's own code writes.
 *
 * `./span-helper.ts`'s marker, and any marker a sibling module adds for the
 * exporter's capture gate to read, live under it. Admitted by prefix rather
 * than enumerated because the writer is the product itself — nothing in this
 * namespace comes from a foreign instrumentation, so nothing in it can be
 * captured application data. The deny list still applies to it, which is why
 * `convert.test.ts` sweeps the denied families through this prefix: not even
 * the product's own namespace may carry content.
 */
const PRODUCT_ATTRIBUTE_PREFIX = 'debuggen.';

/*
 * ---------------------------------------------------------------------------
 * The pass-through deny list
 *
 * Declared here, with the rest of the vocabulary, because it is matched on
 * exactly like the framework names above: one table, checked in one place.
 *
 * It applies to pass D only, *after* the allowlist has admitted the key, so it
 * is defence in depth over the reviewed sets rather than the thing that keeps
 * unknown keys out — {@link isAdmissibleAttributeKey} does that. A deliberately
 * blunt name test will always refuse something harmless, so what it costs is
 * measured rather than assumed: across the product's whole key catalog it
 * refuses `request_key` (which this file never emits anyway),
 * `domContentLoaded`, `previousValue` and `nextValue` (all `navigation` and
 * `state` keys, which are browser-tier and so never reach this Node producer),
 * and `db.statement` — which passes A and B carry verbatim on the one kind that
 * declares it, and which is dropped only when some *other* kind's span
 * volunteers a statement. That is the whole of the collateral, and
 * `convert.test.ts` holds it there twice over: every key a kind declares
 * survives conversion of that kind, and every key of
 * {@link PASS_THROUGH_ATTRIBUTE_KEYS} survives too, so the two tables can never
 * drift into contradicting each other.
 * ---------------------------------------------------------------------------
 */

/**
 * Key name tokens that mark an attribute as carrying **captured content**
 * rather than a measurement of it.
 *
 * The categories AAP §0.5.2 excludes outright — request and response bodies,
 * query result rows, bound parameter values — plus the three carriers a
 * downstream redactor can only scrub when it *recognises the key*: a header
 * bag, a cookie, and a statement or query string. An undeclared
 * `http.request.header.authorization` is a credential the pattern rules may
 * well catch, but an undeclared `response.content` holding a customer record is
 * not a pattern at all, and `env` is the whole process environment.
 *
 * Matched as tokens, never as substrings: see {@link tokenizeAttributeKey} for
 * why (`cardinality` contains `card`, `keyboard` contains `key`).
 *
 * Exempt when the key *measures* the content instead of carrying it — see
 * {@link MEASUREMENT_TOKENS} — so `http.request.body.size` survives while
 * `http.request.body` does not.
 */
export const CONTENT_ATTRIBUTE_TOKENS: readonly string[] = Object.freeze([
  'body',
  'bodies',
  'payload',
  'content',
  'contents',
  'row',
  'rows',
  'record',
  'records',
  'result',
  'results',
  'value',
  'values',
  'param',
  'params',
  'parameter',
  'parameters',
  'arg',
  'args',
  'argument',
  'arguments',
  'query',
  'statement',
  'sql',
  'header',
  'headers',
  'cookie',
  'cookies',
  'env',
  'environ',
  'environment',
]);

/**
 * Key name tokens that mark an attribute as carrying a **credential**.
 *
 * Never exempted by {@link MEASUREMENT_TOKENS}: the length of a password is not
 * evidence anybody asked for, and a "token count" is not worth the risk of
 * admitting `auth.token`.
 *
 * `key` is included even though it is a generic word. The cost is a dropped
 * cache-key attribute; the alternative cost is `api_key` reaching a model
 * prompt, and the product's own declared keys — the ones a panel actually
 * reads — are admitted by {@link DECLARED_KEYS} before this list is consulted
 * at all.
 */
export const CREDENTIAL_ATTRIBUTE_TOKENS: readonly string[] = Object.freeze([
  'password',
  'passwd',
  'pwd',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'token',
  'tokens',
  'apikey',
  'key',
  'keys',
  'auth',
  'authorization',
  'authentication',
  'bearer',
  'jwt',
  'signature',
  'private',
  'certificate',
  'cert',
  'salt',
  'otp',
  'passphrase',
]);

/**
 * Key name tokens that mark an attribute as carrying **personal data**.
 *
 * The identifiers a storefront's own instrumentation attaches most readily —
 * the signed-in customer, their contact details, their payment instrument —
 * and the ones a developer debugging a slow checkout has no need of: the
 * product reasons about *timing and shape*, never about whose order it was.
 *
 * `address` is deliberately absent: `server.address` and `net.peer.address` are
 * hostnames of the developer's own machine and are useful in a waterfall, while
 * a postal address is caught by `postal`, `street` and `zip`. `user` is
 * deliberately present, which also refuses `http.user_agent` — a fingerprint
 * this product has no use for, since a developer debugging their own page knows
 * which browser they opened it in.
 */
export const PERSONAL_DATA_ATTRIBUTE_TOKENS: readonly string[] = Object.freeze([
  'user',
  'users',
  'username',
  'enduser',
  'customer',
  'email',
  'mail',
  'phone',
  'telephone',
  'mobile',
  'firstname',
  'lastname',
  'surname',
  'fullname',
  'birthdate',
  'birthday',
  'dob',
  'ssn',
  'nino',
  'passport',
  'iban',
  'creditcard',
  'card',
  'cvv',
  'cvc',
  'postal',
  'postcode',
  'street',
  'zip',
  'latitude',
  'longitude',
  'geo',
  'gender',
]);

/**
 * The three families, in the order a diagnostic reads best, so a caller (and
 * `convert.test.ts`) can iterate them instead of restating the lists.
 *
 * `exempt` records whether {@link MEASUREMENT_TOKENS} may rescue a key of that
 * family: a measurement *of* content is a number, while a measurement of a
 * credential or of a person is still about the credential or the person.
 */
export const DENIED_ATTRIBUTE_KEY_FAMILIES: readonly {
  readonly family: string;
  readonly tokens: readonly string[];
  readonly exempt: boolean;
}[] = Object.freeze([
  Object.freeze({ family: 'content', tokens: CONTENT_ATTRIBUTE_TOKENS, exempt: true }),
  Object.freeze({ family: 'credential', tokens: CREDENTIAL_ATTRIBUTE_TOKENS, exempt: false }),
  Object.freeze({ family: 'personal', tokens: PERSONAL_DATA_ATTRIBUTE_TOKENS, exempt: false }),
]);

/**
 * Final key tokens that turn a content-family key into a measurement of the
 * content rather than the content itself.
 *
 * Only as the **last** token, which is where a semantic convention puts the
 * unit (`http.request.body.size`, `db.rows.count`). A leading or interior
 * `size` says nothing about what the value holds (`size.body`).
 */
export const MEASUREMENT_TOKENS: readonly string[] = Object.freeze([
  'size',
  'length',
  'count',
  'bytes',
  'total',
  'duration',
]);

/** One family's tokens as a set, with the exemption that applies to it. */
interface DeniedTokenSet {
  /** The family's tokens, for a constant-time membership test. */
  readonly tokens: ReadonlySet<string>;
  /** Whether {@link MEASUREMENT_TOKENS} may rescue a key of this family. */
  readonly exempt: boolean;
}

/** {@link DENIED_ATTRIBUTE_KEY_FAMILIES} as sets, built once at module load. */
const DENIED_TOKEN_SETS: readonly DeniedTokenSet[] = Object.freeze(
  DENIED_ATTRIBUTE_KEY_FAMILIES.map((entry) =>
    Object.freeze({ tokens: new Set(entry.tokens), exempt: entry.exempt }),
  ),
);

/** {@link MEASUREMENT_TOKENS} as a set. */
const MEASUREMENT_TOKEN_SET: ReadonlySet<string> = new Set(MEASUREMENT_TOKENS);

/**
 * The longest attribute key this file will tokenize.
 *
 * A key longer than this is refused by the pass-through pass rather than
 * examined: a name that long is not a name anybody reads, and bounding the
 * input is what keeps the tokenizer's cost independent of what a foreign
 * instrumentation attached.
 */
const MAX_ATTRIBUTE_KEY_LENGTH = 256;

/**
 * The longest `name` this file emits.
 *
 * Deliberately below the event schema's own name bound — which
 * `../schema/event.ts` keeps module-private, so there is nothing to import and
 * nothing may be invented to mirror it — and comfortably long enough for a
 * `<METHOD> <route>` label, a qualified symbol name or a driver's
 * `<command> <database>` label. A longer name is cut rather than passed on,
 * because a name over the schema's bound would be rejected at ingest and the
 * evidence lost for a presentation detail.
 */
export const MAX_EVENT_NAME_LENGTH = 256;

/**
 * The longest `file` this file accepts in a source location.
 *
 * A path cannot be truncated — a shortened path is a *different* path, and one
 * the editor would open at the wrong place or not at all — so an over-long
 * value costs the location rather than being cut. The number is the one both
 * ends of the patch contract already state:
 * `packages/instrumentation/src/patch/wrap-template.ts`'s
 * `MAX_META_FILE_LENGTH` (what the wrapper is allowed to emit) and
 * `../browser/span-helper.ts`'s `MAX_SOURCE_PATH_LENGTH` (what the page tier
 * accepts). Longer than any real project-relative path, and short enough that
 * a foreign instrumentation setting a `file` attribute cannot push an
 * unbounded string into the store.
 */
export const MAX_SOURCE_FILE_LENGTH = 512;

/** An attribute bag with nothing in it, shared by the guarded readers below. */
const EMPTY_ATTRIBUTES: Readonly<Record<string, unknown>> = Object.freeze({});

/*
 * ---------------------------------------------------------------------------
 * Guarded readers
 *
 * A `ReadableSpan` handed to this file is typed but not trusted: it may come
 * from a third-party instrumentation loaded into the developer's process, a
 * provider that implements the interface loosely, or a test double. Every
 * reader below therefore checks the shape it was promised and returns a
 * neutral value instead of throwing.
 * ---------------------------------------------------------------------------
 */

/** Whether `value` is a usable `[seconds, nanoseconds]` pair. */
function isHrTimePair(value: unknown): value is HrTime {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

/** The span's attribute bag, or an empty bag when it is not an object. */
function readAttributes(span: ReadableSpan): Readonly<Record<string, unknown>> {
  const attributes = span.attributes;
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return EMPTY_ATTRIBUTES;
  }
  return attributes;
}

/** The span's instrumentation scope name, trimmed, or `''` when absent. */
function readScopeName(span: ReadableSpan): string {
  const name: unknown = span.instrumentationScope?.name;
  return typeof name === 'string' ? name.trim() : '';
}

/** The span's display name, trimmed, or `''` when absent. */
function readSpanName(span: ReadableSpan): string {
  const name: unknown = span.name;
  return typeof name === 'string' ? name.trim() : '';
}

/** The span's recorded events, or an empty list when it has none. */
function readSpanEvents(span: ReadableSpan): readonly TimedEvent[] {
  const events = span.events;
  return Array.isArray(events) ? events : [];
}

/**
 * A non-empty string attribute, or `undefined`.
 *
 * Empty strings are treated as absent: an instrumentation that sets a key it
 * could not fill is saying nothing, and an empty value in a panel column reads
 * as a measurement rather than as a gap.
 */
function readStringAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = attributes[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Whether any attribute in `keys` is present on the bag, whatever its value. */
function hasAnyAttribute(
  attributes: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => attributes[key] !== undefined);
}

/**
 * The lower-case product status for an OpenTelemetry status code.
 *
 * Uses {@link OTEL_STATUS_CODE_TO_STATUS} from `../schema/kinds.ts`, which
 * exists for this conversion, rather than a local switch over the enum — and
 * narrows the code to the table's key type first, so a provider reporting
 * something outside the enum degrades to `unset` instead of producing
 * `undefined` where the schema requires a member.
 */
function toStatus(span: ReadableSpan): TelemetryStatus {
  const code: unknown = span.status?.code;
  if (code === 0 || code === 1 || code === 2) {
    return OTEL_STATUS_CODE_TO_STATUS[code];
  }
  return 'unset';
}

/** The developer-facing message on the span's status, or `undefined`. */
function readStatusMessage(span: ReadableSpan): string | undefined {
  const message: unknown = span.status?.message;
  if (typeof message !== 'string') {
    return undefined;
  }
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Cuts `value` to `limit` code units without splitting a surrogate pair, and
 * marks the cut.
 *
 * Linear in `limit` rather than in the input, so a pathologically long value
 * costs nothing to bound. The ellipsis is a reader's cue that something was
 * removed; it carries no contract, and a consumer that needs to know a value
 * is partial reads the bound rather than the character.
 */
function boundText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  let head = value.slice(0, limit - 1);
  const lastUnit = head.charCodeAt(head.length - 1);
  // A lone high surrogate at the cut would render as a replacement character
  // and could not survive a JSON round trip intact.
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return `${head}\u2026`;
}

/*
 * ---------------------------------------------------------------------------
 * Classification
 * ---------------------------------------------------------------------------
 */

/**
 * The kind and tier a span was classified as.
 *
 * A pair rather than a kind alone, because the tier is a property of the
 * producer and of the operation's subject — a database span is `db` whichever
 * process reported it — and `../schema/kinds.ts` validates the two together.
 */
export interface SpanClassification {
  /** The event kind, from the closed vocabulary in `../schema/kinds.ts`. */
  readonly kind: TelemetryKind;
  /** The tier: only `server` and `db` are ever produced here. */
  readonly tier: TelemetryTier;
}

/** A named application function timed by the product's own span helper. */
const FUNCTION_SPAN: SpanClassification = Object.freeze({ kind: 'function', tier: 'server' });

/** A database span from the ORM or the driver instrumentation. */
const DB_QUERY_SPAN: SpanClassification = Object.freeze({ kind: 'db.query', tier: 'db' });

/** The framework's incoming-request span, or any other server-kind span. */
const HTTP_SERVER_SPAN: SpanClassification = Object.freeze({ kind: 'http.server', tier: 'server' });

/** The framework's route-handler span. */
const ROUTE_HANDLER_SPAN: SpanClassification = Object.freeze({
  kind: 'route.handler',
  tier: 'server',
});

/** An outgoing server-side request. */
const HTTP_CLIENT_SPAN: SpanClassification = Object.freeze({ kind: 'http.client', tier: 'server' });

/** A failure raised while handling a server-side request. */
const SERVER_ERROR_SPAN: SpanClassification = Object.freeze({
  kind: 'server.error',
  tier: 'server',
});

/** Whether the span carries any accepted spelling of the function-span marker. */
function hasFunctionMarker(attributes: Readonly<Record<string, unknown>>): boolean {
  return hasAnyAttribute(attributes, FUNCTION_SPAN_MARKER_ATTRIBUTES);
}

/**
 * Whether an instrumentation scope name is the ORM's.
 *
 * Both spellings, for the reason {@link DB_INSTRUMENTATION_SCOPES} records: the
 * instrumentation registers under its package name and creates its spans
 * through a tracer named `prisma`.
 */
function isOrmScope(scope: string): boolean {
  return (
    scope === DB_INSTRUMENTATION_SCOPES.orm ||
    scope.startsWith(DB_INSTRUMENTATION_SCOPES.ormScopePrefix)
  );
}

/** Whether an instrumentation scope name belongs to a database instrumentation. */
function isDatabaseScope(scope: string): boolean {
  return isOrmScope(scope) || scope === DB_INSTRUMENTATION_SCOPES.driver;
}

/**
 * Whether a span name starts with any prefix a database instrumentation uses.
 *
 * Iterates {@link DB_SPAN_NAME_PREFIXES_BY_CLIENT}, which covers every value of
 * {@link DB_SPAN_NAME_PREFIXES}, so a prefix added to that table is honoured
 * here without this function being edited.
 */
function hasDatabaseSpanName(name: string): boolean {
  for (const prefixes of Object.values(DB_SPAN_NAME_PREFIXES_BY_CLIENT)) {
    for (const prefix of prefixes) {
      if (name.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

/** Whether a span name is one of the driver's connection-acquisition spans. */
function isDriverConnectSpanName(name: string): boolean {
  return DRIVER_CONNECT_SPAN_NAMES.some((prefix) => name.startsWith(prefix));
}

/**
 * Whether the span describes a database operation by its attributes alone.
 *
 * The secondary signal for a database span, so an ORM or driver whose scope
 * name this file does not know still lands on `db.query` when it reports a
 * statement or a system — either spelling of them.
 */
function hasDatabaseAttributes(attributes: Readonly<Record<string, unknown>>): boolean {
  return hasAnyAttribute(attributes, [
    CANONICAL.dbStatement,
    CANONICAL.dbSystem,
    'db.query.text',
    'db.system.name',
  ]);
}

/**
 * Classifies a framework span by its span type, falling back to its display
 * name.
 *
 * The type attribute is preferred because it is an enum member the framework
 * sets before any user attribute, while the display name is rewritten during
 * the request. A framework span whose type is known to the framework but not
 * to this table — the render, component-tree and response-writing spans —
 * returns `null` here and is then judged by span kind and status like any
 * other span, which for an internal span means it is skipped.
 */
function classifyFrameworkSpan(
  span: ReadableSpan,
  attributes: Readonly<Record<string, unknown>>,
  name: string,
): SpanClassification | null {
  const spanType = readStringAttribute(attributes, NEXT_SPAN_TYPE_ATTRIBUTE);

  if (spanType === NEXT_SPAN_TYPES.request) {
    return HTTP_SERVER_SPAN;
  }
  if (
    spanType === NEXT_SPAN_TYPES.appRouteHandler ||
    spanType === NEXT_SPAN_TYPES.pagesApiHandler
  ) {
    return ROUTE_HANDLER_SPAN;
  }
  if (spanType === NEXT_SPAN_TYPES.serverFetch || spanType === NEXT_SPAN_TYPES.internalFetch) {
    return HTTP_CLIENT_SPAN;
  }

  // Name-based fallbacks. The request span keeps its type name only until the
  // route is resolved, so both the bare name and the `<name> <route>` form are
  // matched; the handler and fetch spans are matched by prefix because the
  // framework appends the route and the target URL respectively.
  if (name === NEXT_SPAN_TYPES.request || name.startsWith(`${NEXT_SPAN_TYPES.request} `)) {
    return HTTP_SERVER_SPAN;
  }
  if (name.startsWith(NEXT_SPAN_NAME_PREFIXES.apiRouteHandler)) {
    return ROUTE_HANDLER_SPAN;
  }
  if (name.startsWith(NEXT_SPAN_NAME_PREFIXES.serverFetch) && span.kind === SpanKind.CLIENT) {
    return HTTP_CLIENT_SPAN;
  }

  return null;
}

/**
 * The kind and tier a span becomes, or `null` for a span this file does not
 * emit.
 *
 * Exported separately from {@link spanToIngressEvent} for two callers:
 * `./exporter.ts` asks for the kind before converting, so a signal its capture
 * gate has disabled costs nothing beyond this call, and `convert.test.ts`
 * table-tests the mapping directly.
 *
 * The order of the checks is the order of confidence:
 *
 * 1. **The product's own tracer scope**, or the marker attribute — a span the
 *    AST patch's runtime helper created for a named application function.
 *    First, because such a span may legitimately also carry database or HTTP
 *    attributes copied from its `meta`.
 * 2. **A database instrumentation scope**, a database span name prefix, or
 *    database attributes → `db.query` on the `db` tier. Ahead of the framework
 *    and generic rules because the driver's query span is a client-kind span
 *    and would otherwise be mistaken for an outgoing HTTP request.
 * 3. **The framework's own spans**, by span type and then by name shape.
 * 4. **Span kind**: a server-kind span is an incoming request and a
 *    client-kind span is an outgoing one, which is how a third-party
 *    instrumentation in the host process is understood.
 * 5. **An error status** with no better classification → `server.error`, so a
 *    failure is never lost merely because the operation had no recognised
 *    shape.
 *
 * ## A database span is not necessarily a statement
 *
 * Both instrumentations also span their own lifecycle work: the ORM's
 * `prisma:client:serialize`, `prisma:client:operation` and transaction spans,
 * and the driver's `pg.connect` and `pg-pool.connect`. Every one of them is
 * emitted here as `db.query` on the `db` tier, because `../schema/kinds.ts` has
 * exactly one database kind and that time really was spent in the database
 * tier: dropping them would remove real nodes from the waterfall and the flame
 * view and would shrink `database_duration` below what the process actually
 * spent. What they are *not* is statement executions, and that distinction is
 * drawn where it can be: this file names each one's `db.operation` (see
 * {@link deriveDbOperation}) and `../aggregate/queries.ts` selects the spans
 * that carry a `db.statement` when it counts executions and groups statements.
 *
 * ## Why anything left over is skipped
 *
 * A span that reaches the end of that list is internal framework machinery
 * with no error to report — the render, component-tree, page-module and
 * response-writing spans, of which a single page request produces many. The
 * AAP prefers skipping pure framework noise over flooding the store, and
 * skipping is safe because the framework does not break its context chain for
 * the spans it never delegates: the operations this product reasons about —
 * request, route handler, named function, query, outgoing request — nest
 * directly under one another. Where an intermediate span *is* skipped, the
 * event underneath it names a parent that never arrived, and the correlator
 * attaches it to the trace root flagged `orphaned` rather than dropping it
 * (AAP §0.4.2), so its work still counts towards every duration in the
 * capture. Nothing is dropped on the basis of its trace, and an event's
 * `traceId` is never rewritten: it is the only thing that joins a click to the
 * queries it caused.
 *
 * Never throws: a span of any shape is answered, `null` at worst.
 *
 * @param span A finished span from the host process's span pipeline.
 * @returns The kind and tier to emit it as, or `null` to skip it.
 */
export function classifySpan(span: ReadableSpan): SpanClassification | null {
  try {
    if (typeof span !== 'object' || span === null) {
      return null;
    }

    const attributes = readAttributes(span);
    const name = readSpanName(span);
    const scope = readScopeName(span);

    if (scope === TRACER_NAME || hasFunctionMarker(attributes)) {
      return FUNCTION_SPAN;
    }

    if (isDatabaseScope(scope) || hasDatabaseSpanName(name) || hasDatabaseAttributes(attributes)) {
      return DB_QUERY_SPAN;
    }

    const framework = classifyFrameworkSpan(span, attributes, name);
    if (framework !== null) {
      return framework;
    }

    if (span.kind === SpanKind.SERVER) {
      return HTTP_SERVER_SPAN;
    }
    if (span.kind === SpanKind.CLIENT) {
      return HTTP_CLIENT_SPAN;
    }
    if (toStatus(span) === 'error') {
      return SERVER_ERROR_SPAN;
    }

    return null;
  } catch {
    // A getter on a foreign span object threw. There is nothing to report it
    // on and nothing to report it to from here, and a throw would travel into
    // the host's span pipeline: the span is simply not evidence.
    return null;
  }
}

/**
 * Whether {@link spanToIngressEvent} would emit an event for this span's
 * shape.
 *
 * A classification-only predicate, so a caller filtering a list — or a test
 * tabulating which framework spans survive — does not have to build an event
 * to find out. It says nothing about the span's timestamps or identifiers,
 * which are checked during conversion.
 */
export function isEmittableSpan(span: ReadableSpan): boolean {
  return classifySpan(span) !== null;
}

/**
 * Which database instrumentation produced a span: `'prisma'` for the ORM's own
 * span, `'pg'` for the driver's.
 *
 * The values are {@link DB_CLIENT_VALUES}, so the type a caller switches on and
 * the `db.client` attribute a panel reads are the same two strings.
 */
export type DatabaseSpanSource = (typeof DB_CLIENT_VALUES)[keyof typeof DB_CLIENT_VALUES];

/**
 * The instrumentation a database span came from, or `null` when the span's
 * scope and name identify neither.
 *
 * {@link classifySpan} answers with a *kind*, and `../schema/kinds.ts` has one
 * database kind: a query is database work whether the ORM's instrumentation or
 * the driver's reported it. That is right for rendering and wrong for gating —
 * `server-agent.config` carries an independent `prisma` and `pg` switch (AAP
 * §0.4.2), so a plan that asked for ORM tracing alone must not collect the
 * driver's spans. The kind cannot express that difference, so this second,
 * independent axis exists alongside it: `./exporter.ts` asks for the source of
 * every `db.query` span and `./control.ts` answers whether the capture wanted
 * it.
 *
 * Derived from the same evidence as the `db.client` attribute — the
 * instrumentation scope name, then the span-name prefix — through the one
 * function that owns that derivation, so the gate and the attribute can never
 * disagree about which library reported a query.
 *
 * Never throws: a foreign span whose own getters fail answers `null`, which the
 * gate treats as unattributable rather than as either source.
 *
 * @param span A finished span, normally one {@link classifySpan} called
 * `db.query`.
 * @returns The producing instrumentation, or `null` when it cannot be told.
 */
export function classifyDatabaseSource(span: ReadableSpan): DatabaseSpanSource | null {
  try {
    if (typeof span !== 'object' || span === null) {
      return null;
    }
    const client = deriveDbClient({
      attributes: readAttributes(span),
      name: readSpanName(span),
      scope: readScopeName(span),
    });
    if (client === DB_CLIENT_VALUES.orm) {
      return DB_CLIENT_VALUES.orm;
    }
    if (client === DB_CLIENT_VALUES.driver) {
      return DB_CLIENT_VALUES.driver;
    }
    return null;
  } catch {
    return null;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Attributes
 *
 * Four passes, in a fixed order, so the result depends only on the span's
 * content and never on the order in which its producer happened to set a key:
 *
 *   A. the keys the kind declares, copied under their canonical spelling;
 *   B. the alias translation, applied only where a canonical key is still
 *      unset, and consuming the alias;
 *   C. the derivations this file owes a kind that no instrumentation reports;
 *   D. bounded pass-through of everything left.
 * ---------------------------------------------------------------------------
 */

/** The facts about a span that both the attribute and the name derivation need. */
interface SpanFacts {
  /** The span's attribute bag, guarded to an object. */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** The span's display name, trimmed. */
  readonly name: string;
  /** The span's instrumentation scope name, trimmed. */
  readonly scope: string;
}

/**
 * Whether a value may travel on an event's attribute bag.
 *
 * Primitives only. An object or an array is dropped rather than serialised —
 * a fiber, a DOM node or a cyclic structure must never be able to turn one
 * span into a large event or to throw inside this conversion — and a function
 * or a symbol is rejected by the event schema's own transportability check
 * anyway. A `bigint` is dropped for a blunter reason: `JSON.stringify` throws
 * on one, which would fail the whole batch in `./exporter.ts` rather than the
 * one attribute. A non-finite number is dropped because JSON renders it as
 * `null`, which would read as a measurement of zero.
 */
function isEmittableAttributeValue(value: unknown): value is string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Splits an attribute key into lower-case word tokens.
 *
 * Both spellings an instrumentation may use are handled by one pass: the
 * separated forms (`http.request.body`, `request_body`, `request-body`) split
 * on the separator, and the camel-cased form (`requestBody`) splits at the
 * lower-to-upper transition. ASCII only: a letter outside it is treated as a
 * separator, which can only ever split a token further and so can only make the
 * deny check *more* permissive — never a false positive on a key nobody meant.
 *
 * **Why tokens rather than substrings.** A substring test on short words is
 * wrong and quietly so: `keyboard` contains `key`, `cardinality` and `discard`
 * contain `card`, `tokenizer` contains `token`, so a deny list matched on
 * characters would refuse a pile of harmless keys while still missing a body
 * spelled in a way nobody enumerated. A token test answers the question the
 * deny list actually asks — "is one of this key's *words* the name of a thing
 * we refuse to forward".
 *
 * @param key An attribute key of any shape.
 * @returns Its lower-case tokens, in order; empty for a key with no
 * alphanumeric character at all.
 */
function tokenizeAttributeKey(key: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let previousWasLowerOrDigit = false;

  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    const isUpper = code >= 0x41 && code <= 0x5a;
    const isLower = code >= 0x61 && code <= 0x7a;
    const isDigit = code >= 0x30 && code <= 0x39;

    if (!isUpper && !isLower && !isDigit) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      previousWasLowerOrDigit = false;
      continue;
    }

    if (isUpper && previousWasLowerOrDigit && current.length > 0) {
      tokens.push(current);
      current = '';
    }

    current += isUpper ? String.fromCharCode(code + 0x20) : key.charAt(index);
    previousWasLowerOrDigit = isLower || isDigit;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Whether a key belongs to one of {@link DENIED_ATTRIBUTE_KEY_FAMILIES}.
 *
 * Every token is tested against every family, so a key in two families is
 * refused by the stricter one: `token.count` measures a credential and is
 * refused, while `body.count` measures content and is admitted.
 *
 * @param key An attribute key of any shape.
 * @returns `true` when the key must not be forwarded.
 */
function isDeniedAttributeKey(key: string): boolean {
  const tokens = tokenizeAttributeKey(key);
  if (tokens.length === 0) {
    return false;
  }

  const last = tokens.at(-1) ?? '';
  const measuresRatherThanCarries = MEASUREMENT_TOKEN_SET.has(last);

  for (const token of tokens) {
    for (const family of DENIED_TOKEN_SETS) {
      if (!family.tokens.has(token)) {
        continue;
      }
      if (family.exempt && measuresRatherThanCarries) {
        continue;
      }
      return true;
    }
  }

  return false;
}

/**
 * Whether a key is one this producer is allowed to forward at all.
 *
 * The admission requirement of the pass-through pass, and the answer to "may
 * this process forward a value nobody reviewed": no. Three ways to be
 * admissible, each of them a reviewed decision rather than a shape:
 *
 * 1. the product's catalog declares the key ({@link DECLARED_KEYS});
 * 2. this module's reviewed vocabulary lists it
 *    ({@link PASS_THROUGH_ATTRIBUTE_KEYS});
 * 3. it is in the product's own namespace
 *    ({@link PRODUCT_ATTRIBUTE_PREFIX}), which only this product writes.
 *
 * Everything else is dropped — a key from a third-party instrumentation nobody
 * has read, whatever its name and whatever its value looks like. That is the
 * only rule that keeps a one-line request body out of the store, because a
 * body under an innocuous name is indistinguishable from a label (see
 * {@link PASS_THROUGH_ATTRIBUTE_KEYS} for the worked example), and AAP §0.5.2
 * excludes bodies and row contents from what may be captured rather than from
 * what may be displayed.
 *
 * @param key An attribute key of any shape.
 * @returns `true` when the key is one a reviewer has vouched for.
 */
function isAdmissibleAttributeKey(key: string): boolean {
  return (
    DECLARED_KEYS.has(key) || REVIEWED_KEYS.has(key) || key.startsWith(PRODUCT_ATTRIBUTE_PREFIX)
  );
}

/**
 * Whether a string looks like a scalar label rather than serialised data.
 *
 * The second half of the pass-through gate, and the half the deny list cannot
 * do: a body, a result row or a serialised record under an *innocuous* key —
 * `cache.extra`, `vendor.detail` — is caught by its shape instead of its name.
 * Two signals, both cheap and both one-directional (they refuse; they never
 * admit something a name refused):
 *
 * - **A control character**, newline and tab included. Every label a panel
 *   renders is one line; a value with a line break is a document.
 * - **An opening bracket, brace, angle bracket or quote** as the first
 *   non-space character — JSON, an array, markup or a quoted blob.
 *
 * Applied to the *bounded* value, so the cost is a fixed number of characters
 * whatever a foreign instrumentation attached, and so the check describes
 * exactly what would be emitted.
 *
 * @param value The bounded candidate value.
 * @returns `true` when the value may be forwarded.
 */
function isScalarLabel(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }

  const first = value.trimStart().charCodeAt(0);
  // `{`, `[`, `<`, `"` - the four openings of a serialised structure. `NaN`
  // from an empty string compares false against all of them, which is right:
  // an empty value is not a document.
  return first !== 0x7b && first !== 0x5b && first !== 0x3c && first !== 0x22;
}

/**
 * The `db.client` value for a database span: which producer emitted it.
 *
 * Derived rather than read, because neither instrumentation reports it and a
 * consumer needs it to tell an ORM span from the driver span underneath it
 * instead of counting one query twice.
 */
function deriveDbClient(facts: SpanFacts): string | undefined {
  if (isOrmScope(facts.scope) || matchesAnyPrefix(facts.name, DB_CLIENT_VALUES.orm)) {
    return DB_CLIENT_VALUES.orm;
  }
  if (
    facts.scope === DB_INSTRUMENTATION_SCOPES.driver ||
    matchesAnyPrefix(facts.name, DB_CLIENT_VALUES.driver)
  ) {
    return DB_CLIENT_VALUES.driver;
  }
  return undefined;
}

/**
 * Whether a span name starts with any of one client's span-name prefixes.
 *
 * The lookup that lets {@link deriveDbClient} read
 * {@link DB_SPAN_NAME_PREFIXES_BY_CLIENT} instead of restating which prefixes
 * belong to which library. A client with no group answers `false` rather than
 * throwing, because this function is on the conversion path of a foreign span.
 */
function matchesAnyPrefix(name: string, client: string): boolean {
  const prefixes = DB_SPAN_NAME_PREFIXES_BY_CLIENT[client] ?? [];
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * The `db.operation` value parsed out of a database span's name, for the
 * instrumentations that put it there instead of in an attribute.
 *
 * The driver names a query span `pg.query:<COMMAND>[ <database>]`, so the
 * command is the text between the colon and the first space; the ORM names its
 * spans `prisma:client:<operation>` and `prisma:engine:<operation>`, so the
 * operation is the last colon-separated segment. Both formats are the pinned
 * versions' own, declared in {@link DB_SPAN_NAME_PREFIXES}, and this parse runs
 * only when the attribute is absent.
 *
 * Two lifecycle shapes are named rather than parsed, so that **every** database
 * span this file emits says what operation it was:
 *
 * - the driver's `pg.connect` and `pg-pool.connect` carry no segment at all and
 *   become {@link DRIVER_CONNECT_OPERATION};
 * - an ORM-scope span whose name carries no separator is the engine naming one
 *   operation and nothing else (`start_transaction`, `commit_transaction`,
 *   `transaction`), so the name itself is the operation.
 *
 * Without those two, a connection acquisition and a transaction boundary would
 * arrive with neither a `db.statement` nor a `db.operation`, which is precisely
 * the shape a consumer cannot tell from a statement whose text went missing.
 */
function deriveDbOperation(facts: SpanFacts): string | undefined {
  if (isDriverConnectSpanName(facts.name)) {
    return DRIVER_CONNECT_OPERATION;
  }

  if (facts.name.startsWith(DB_SPAN_NAME_PREFIXES.driver)) {
    const separator = facts.name.indexOf(DB_SPAN_NAME_SEGMENT_SEPARATOR);
    if (separator < 0) {
      return undefined;
    }
    const tail = facts.name.slice(separator + 1).trim();
    const space = tail.indexOf(' ');
    const command = space < 0 ? tail : tail.slice(0, space);
    return command.length > 0 ? command : undefined;
  }

  if (facts.name.startsWith(DB_SPAN_NAME_PREFIXES.orm)) {
    const segments = facts.name
      .split(DB_SPAN_NAME_SEGMENT_SEPARATOR)
      .filter((segment) => segment.length > 0);
    const operation = segments.at(-1);
    // A bare `prisma:` name carries no operation; the prefix itself is not one.
    return operation !== undefined && operation !== DB_CLIENT_VALUES.orm ? operation : undefined;
  }

  if (isOrmScope(facts.scope) && !facts.name.includes(DB_SPAN_NAME_SEGMENT_SEPARATOR)) {
    const operation = facts.name.trim();
    return operation.length > 0 ? operation : undefined;
  }

  return undefined;
}

/**
 * The `error.*` values of a span that recorded an exception.
 *
 * `recordException` adds an {@link EXCEPTION_EVENT_NAME} span event carrying
 * the exception's type, message and stack trace, and the catalog states that
 * this file converts a span that recorded one. The first such event wins: a
 * span that recorded several failures is described by the first, and the rest
 * are visible in the trace through the spans that recorded them.
 *
 * The stack is copied whole rather than cut to a preview length. A server stack
 * is exactly the evidence a developer needs, and it is scrubbed and bounded by
 * `../redaction/rules.ts` at ingest before it is persisted, broadcast or put
 * in front of a model.
 */
function readRecordedException(
  span: ReadableSpan,
): { type?: string; message?: string; stack?: string } | undefined {
  for (const event of readSpanEvents(span)) {
    if (typeof event !== 'object' || event === null || event.name !== EXCEPTION_EVENT_NAME) {
      continue;
    }

    const attributes = event.attributes;
    if (typeof attributes !== 'object' || attributes === null) {
      return {};
    }

    const type = readStringAttribute(attributes, EXCEPTION_EVENT_ATTRIBUTES.type);
    const message = readStringAttribute(attributes, EXCEPTION_EVENT_ATTRIBUTES.message);
    const stack = readStringAttribute(attributes, EXCEPTION_EVENT_ATTRIBUTES.stack);

    return {
      ...(type === undefined ? {} : { type }),
      ...(message === undefined ? {} : { message }),
      ...(stack === undefined ? {} : { stack }),
    };
  }

  return undefined;
}

/**
 * Fills a canonical key only if nothing has claimed it yet.
 *
 * The rule that makes the four passes composable: an earlier, more trustworthy
 * pass always wins, so a derivation can never overwrite something the
 * instrumentation actually reported.
 */
function fillIfAbsent(
  target: Record<string, unknown>,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined || target[key] !== undefined) {
    return;
  }
  target[key] = value;
}

/**
 * Pass C: the values this file owes a kind that no instrumentation reports.
 *
 * - `http.route` and `next.route` are filled from each other. The framework
 *   sets both on a request span but only its own spelling on a handler span,
 *   and both are keys the product declares for those kinds, so a consumer that
 *   reads either one finds a route.
 * - `db.client` and `db.operation` are derived from the scope and the span
 *   name (see their own documentation).
 * - `error.type`, `error.message` and `error.stack` come from a recorded
 *   exception, and the message falls back to the status message — the only
 *   failure description a span that set a status without recording an
 *   exception carries.
 *
 * `route.handler`'s `symbol` is deliberately **not** derived. The framework's
 * handler span names the route, not the exported function it invoked, and the
 * request method that would identify it lives on the parent span; the service's
 * source resolver answers that question from the route map instead. Declaring a
 * key is a statement about what a consumer may look for, not a promise that
 * every event carries it.
 */
function applyDerivedAttributes(
  span: ReadableSpan,
  kind: TelemetryKind,
  facts: SpanFacts,
  result: Record<string, unknown>,
): void {
  if (kind === 'http.server' || kind === 'route.handler') {
    fillIfAbsent(result, CANONICAL.httpRoute, readStringAttribute(result, CANONICAL.nextRoute));
    fillIfAbsent(result, CANONICAL.nextRoute, readStringAttribute(result, CANONICAL.httpRoute));
    return;
  }

  if (kind === 'db.query') {
    fillIfAbsent(result, CANONICAL.dbClient, deriveDbClient(facts));
    fillIfAbsent(result, CANONICAL.dbOperation, deriveDbOperation(facts));
    return;
  }

  if (kind === 'server.error') {
    const recorded = readRecordedException(span);
    fillIfAbsent(result, CANONICAL.errorType, recorded?.type);
    fillIfAbsent(result, CANONICAL.errorMessage, recorded?.message ?? readStatusMessage(span));
    fillIfAbsent(result, CANONICAL.errorStack, recorded?.stack);
  }
}

/**
 * The event's attribute bag: the span's attributes mapped onto the product's
 * key catalog.
 *
 * Passes A to C write canonical keys **verbatim**, without a length bound.
 * That is deliberate and is the one place where the privacy bounds are not
 * applied: a statement, a URL or a stack is the evidence a panel renders, and
 * cutting it to a value-preview length here would ruin the query table and the
 * error log while protecting nothing — the redaction layer scrubs and bounds
 * every one of them at ingest, before anything is persisted, broadcast or sent
 * to a model.
 *
 * Pass D is where the bounds and the privacy gate apply, because an attribute
 * nobody reviewed is an attribute nobody reasoned about. In order: the key must
 * be admissible ({@link isAdmissibleAttributeKey}), must not belong to a denied
 * family ({@link isDeniedAttributeKey}), must be shorter than
 * {@link MAX_ATTRIBUTE_KEY_LENGTH}, and — unless the catalog declares it — must
 * carry a value that looks like a label rather than serialised data
 * ({@link isScalarLabel}); then at most {@link MAX_TRACKED_KEYS} keys in total,
 * string values cut to {@link MAX_PREVIEW_LENGTH}, primitives only. Declared
 * keys are never the ones a full budget drops — the largest declared set is a
 * small fraction of the budget and it is filled first — and the pass-through
 * order is the span's own key order, so the result is deterministic.
 *
 * The gate is pass D's alone, deliberately. Passes A to C write keys the
 * product's catalog declares, each with documented meaning, a consumer that
 * reads it and a redaction rule that knows how to treat it: `db.statement` is
 * scrubbed by `../redaction/sql.ts`, `url` by `../redaction/url.ts`,
 * `db.rowCount` is a count of rows and never a row. Running the deny list over
 * them would drop exactly the evidence the product is built to show, which is
 * why an alias such as `db.query.text` still delivers its value — under the
 * canonical spelling a redactor recognises.
 *
 * `request_key` can never appear: every key of
 * {@link SERVICE_ASSIGNED_ATTRIBUTE_KEYS} is filtered out of all four passes,
 * whoever set it.
 *
 * @param consumeSourceKeys Whether {@link SOURCE_ONLY_ATTRIBUTE_KEYS} were
 * taken into a validated `source` and must therefore not travel here as well.
 */
function buildAttributes(
  span: ReadableSpan,
  kind: TelemetryKind,
  facts: SpanFacts,
  consumeSourceKeys: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Pass A - the keys this kind declares, in catalog order.
  for (const key of attributeKeysFor(kind)) {
    if (SERVICE_ASSIGNED_KEYS.has(key)) {
      continue;
    }
    // Consumed means consumed, whichever pass would have written it: a catalog
    // that declares a position key for this kind must not reintroduce the
    // second, unvalidated answer that `source` exists to replace.
    if (consumeSourceKeys && SOURCE_ONLY_ATTRIBUTE_KEYS.has(key)) {
      continue;
    }
    const value = facts.attributes[key];
    if (isEmittableAttributeValue(value)) {
      result[key] = value;
    }
  }

  // Pass B - the alias translation, in declared precedence order.
  for (const [incoming, canonical] of ATTRIBUTE_KEY_TRANSLATIONS) {
    if (result[canonical] !== undefined || SERVICE_ASSIGNED_KEYS.has(canonical)) {
      continue;
    }
    const value = facts.attributes[incoming];
    if (isEmittableAttributeValue(value)) {
      result[canonical] = value;
    }
  }

  // Pass C - the derivations.
  applyDerivedAttributes(span, kind, facts, result);

  // Pass D - bounded, gated pass-through of everything left.
  let emitted = Object.keys(result).length;
  for (const [key, value] of Object.entries(facts.attributes)) {
    if (emitted >= MAX_TRACKED_KEYS) {
      break;
    }
    if (
      result[key] !== undefined ||
      ALIAS_KEYS.has(key) ||
      SERVICE_ASSIGNED_KEYS.has(key) ||
      (consumeSourceKeys && SOURCE_ONLY_ATTRIBUTE_KEYS.has(key)) ||
      !isEmittableAttributeValue(value)
    ) {
      continue;
    }
    // The allowlist first: a key no reviewer has vouched for is dropped
    // whatever it is called and whatever it holds. Then the deny list, as
    // defence in depth over the reviewed sets themselves - an unreadably long
    // key is refused before tokenizing, which also keeps this pass's cost
    // independent of what a foreign instrumentation attached.
    if (!isAdmissibleAttributeKey(key)) {
      continue;
    }
    if (key.length > MAX_ATTRIBUTE_KEY_LENGTH || isDeniedAttributeKey(key)) {
      continue;
    }

    if (typeof value !== 'string') {
      result[key] = value;
      emitted += 1;
      continue;
    }

    const bounded = boundText(value, MAX_PREVIEW_LENGTH);
    // A key the catalog declares is vouched for by the catalog; anything else
    // has to look like the label a panel would render.
    if (!DECLARED_KEYS.has(key) && !isScalarLabel(bounded)) {
      continue;
    }
    result[key] = bounded;
    emitted += 1;
  }

  return result;
}

/*
 * ---------------------------------------------------------------------------
 * Source location
 * ---------------------------------------------------------------------------
 */

/**
 * A 1-based line or column from an attribute, or `undefined`.
 *
 * `sourceLocationSchema` requires an integer of at least one on both axes, so a
 * fractional value, a zero, a negative or a numeric string is rejected here
 * rather than turned into a plausible-looking guess. A patch records both
 * exactly; anything else did not come from a patch.
 */
function readPositionAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = attributes[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

/**
 * The location a reversible patch recorded for a function span, or `undefined`.
 *
 * **Why this file may report one at all.** AAP §0.4.2's first and most precise
 * source route is the metadata the patcher recorded when it wrapped the
 * function: `packages/instrumentation/src/patch/wrap-template.ts` writes a
 * project-relative POSIX `file`, a 1-based `line` and `column` and the wrapped
 * `symbol` into the wrapper's `meta`, and `./span-helper.ts` puts them on the
 * span. Forwarding that is not inference — it is the position the patcher read
 * off the declaration — and without it a server function row in a generated
 * panel has nothing to click through to, while the identical row from the page
 * tier has (`../browser/span-helper.ts` builds the same location there).
 * `../aggregate/queries.ts` reads exactly this field to name the caller of a
 * query, so the link is consumed and not decorative.
 *
 * **Only on `function`.** The location is vouched for by the patch, and a
 * `function` classification means the span came from the product's own tracer
 * scope or carried its marker — the only spans a patch can have created. A
 * framework or driver span carrying a `file` attribute of its own says nothing
 * about the developer's project, so no other kind is offered a location here;
 * theirs are resolved in the service through the code graph, the route map and
 * source maps.
 *
 * **All or nothing.** The candidate is validated with `@debuggen/shared`'s
 * `isSourceLocation` — the *same* schema, refinements included, that the
 * ingress boundary applies — rather than with a local restatement of its rules,
 * so a location this file emits cannot be one ingest would reject. A malformed
 * candidate omits the field and keeps the event: the timing is still evidence,
 * and `sourceLocationSchema` would otherwise take the whole event down with the
 * location. The three metadata keys then travel as ordinary attributes
 * ({@link SOURCE_ONLY_ATTRIBUTE_KEYS}) so the malformed hint stays visible.
 *
 * Never throws: every read is guarded, and the validator is a predicate.
 *
 * @param kind The classified kind; only `function` can carry a patch location.
 * @param attributes The span's attribute bag, guarded to an object.
 * @returns A schema-valid location, or `undefined` to omit the field.
 */
function deriveFunctionSource(
  kind: TelemetryKind,
  attributes: Readonly<Record<string, unknown>>,
): SourceLocation | undefined {
  if (kind !== 'function') {
    return undefined;
  }

  const file = readStringAttribute(attributes, PATCH_SOURCE_ATTRIBUTES.file);
  if (file === undefined || file.length > MAX_SOURCE_FILE_LENGTH) {
    return undefined;
  }
  // One rule stricter than `sourceLocationSchema`, and the same one
  // `../browser/span-helper.ts` applies: the shared refinement answers "is this
  // path safe to treat as project-relative", and `'.'` is - but a function
  // lives in a file, never in a directory, so a path that normalises to the
  // project root did not come from a patch.
  if (normalizePosix(file) === '.') {
    return undefined;
  }

  const line = readPositionAttribute(attributes, PATCH_SOURCE_ATTRIBUTES.line);
  const column = readPositionAttribute(attributes, PATCH_SOURCE_ATTRIBUTES.column);
  if (line === undefined || column === undefined) {
    return undefined;
  }

  // `symbol` is optional in the schema and constrained to a non-empty string.
  // It is bounded like any other label: the location's `file` is the part that
  // must arrive whole, and a symbol name long enough to need cutting is a
  // presentation detail either way.
  const symbol = readStringAttribute(attributes, PATCH_SOURCE_ATTRIBUTES.symbol);

  const candidate: SourceLocation = {
    file,
    line,
    column,
    // Omitted rather than set to `undefined`: the schema is strict about the
    // difference and the package compiles with `exactOptionalPropertyTypes`.
    ...(symbol === undefined ? {} : { symbol: boundText(symbol, MAX_PREVIEW_LENGTH) }),
    resolvedBy: 'patch',
    // The route's own confidence, from the one table that ranks the four
    // routes, so this location sorts against the others correctly instead of
    // carrying a number invented here.
    confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
  };

  return isSourceLocation(candidate) ? candidate : undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Name
 * ---------------------------------------------------------------------------
 */

/**
 * The short, human-meaningful label a timeline row, a table cell and the event
 * log show.
 *
 * A label, never an identifier: nothing keys off it, and grouping is done on
 * `request_key`, on a normalised statement or on a component attribute. Per
 * kind:
 *
 * - `http.server` — the `<METHOD> <route>` form the framework has already put
 *   on the span once the route is resolved. Before that the display name is
 *   the framework's span type, which says nothing to a developer, so the label
 *   is composed from the method and route attributes instead.
 * - `db.query` — the instrumentations' own span names are already compact
 *   operation labels (`pg.query:SELECT <database>`,
 *   `prisma:client:<operation>`), so they are kept; a nameless span is
 *   labelled from its operation, database and system attributes.
 * - `function` — the symbol the patch recorded, which is the name the
 *   developer wrote, in preference to whatever the helper called the span.
 * - `server.error` — the failing operation's name, or the error type when the
 *   span had none.
 * - everything else — the span's own name, which the framework and the
 *   instrumentations spell usefully.
 *
 * Returns `''` when a span carries nothing usable; the caller substitutes the
 * kind, so an event always satisfies the schema's non-empty `name`.
 */
function deriveName(
  kind: TelemetryKind,
  facts: SpanFacts,
  attributes: Readonly<Record<string, unknown>>,
): string {
  if (kind === 'http.server') {
    if (facts.name.length > 0 && facts.name !== NEXT_SPAN_TYPES.request) {
      return facts.name;
    }
    const method = readStringAttribute(attributes, CANONICAL.httpMethod);
    const route =
      readStringAttribute(attributes, CANONICAL.httpRoute) ??
      readStringAttribute(attributes, CANONICAL.nextRoute);
    if (method !== undefined) {
      return route === undefined ? method : `${method} ${route}`;
    }
    return route ?? facts.name;
  }

  if (kind === 'db.query') {
    if (facts.name.length > 0) {
      return facts.name;
    }
    const operation = readStringAttribute(attributes, CANONICAL.dbOperation);
    const database = readStringAttribute(attributes, CANONICAL.dbName);
    if (operation !== undefined) {
      return database === undefined ? operation : `${operation} ${database}`;
    }
    return readStringAttribute(attributes, CANONICAL.dbSystem) ?? '';
  }

  if (kind === 'function') {
    return readStringAttribute(attributes, CANONICAL.symbol) ?? facts.name;
  }

  if (kind === 'server.error') {
    return facts.name.length > 0
      ? facts.name
      : (readStringAttribute(attributes, CANONICAL.errorType) ?? '');
  }

  return facts.name;
}

/*
 * ---------------------------------------------------------------------------
 * Time
 * ---------------------------------------------------------------------------
 */

/**
 * Decimal places kept on a persisted millisecond value.
 *
 * Passed explicitly to `roundMs` even though it is that helper's own default,
 * because this is the product's documented precision floor — microsecond
 * resolution, which is all a double retains at a present-day epoch value —
 * and a reader of this file should not have to open another one to learn what
 * precision an event carries.
 */
const PERSISTED_DECIMALS = 3;

/** The zero pair, so a relative duration pair can be measured with the same helper. */
const ZERO_HR_TIME: HrTime = Object.freeze([0, 0] as const);

/**
 * The span's start as epoch milliseconds, or `null` when it is not usable.
 *
 * `null` is returned for a start that is not a well-formed pair and for one
 * that converts outside {@link MIN_EPOCH_MS}…{@link MAX_EPOCH_MS} — which
 * catches a producer reporting a relative, seconds-precision, microsecond or
 * nanosecond timestamp. Such a value is a bug in the host process rather than
 * evidence: emitting it would either be rejected by the schema at ingest or,
 * worse, drag the timeline's origin decades away from the capture.
 */
function convertStartTime(span: ReadableSpan): number | null {
  if (!isHrTimePair(span.startTime)) {
    return null;
  }

  const startTime = roundMs(hrTimeToEpochMs(span.startTime), PERSISTED_DECIMALS);
  if (!Number.isFinite(startTime) || startTime < MIN_EPOCH_MS || startTime > MAX_EPOCH_MS) {
    return null;
  }
  return startTime;
}

/**
 * The span's duration in milliseconds: never negative, never `NaN`.
 *
 * Computed from the start and end pairs, which keeps the full nanosecond
 * resolution — differencing two epoch-millisecond doubles at a present-day
 * value would quantise a short query's duration to noise. The SDK's own
 * `duration` pair is the fallback for a span that reports one without usable
 * endpoints, and it is measured from the zero pair with the same helper rather
 * than by re-deriving the arithmetic.
 *
 * `clampNonNegative` is the last step before rounding, so a wall-clock
 * adjustment between the two readings can never publish a negative bar in a
 * waterfall, and a span with no usable timing at all is reported as an instant
 * rather than dropped — its identity, parentage and attributes are still
 * evidence.
 */
function convertDuration(span: ReadableSpan): number {
  if (isHrTimePair(span.startTime) && isHrTimePair(span.endTime)) {
    return roundMs(
      clampNonNegative(hrTimeDurationMs(span.startTime, span.endTime)),
      PERSISTED_DECIMALS,
    );
  }

  if (isHrTimePair(span.duration)) {
    return roundMs(
      clampNonNegative(hrTimeDurationMs(ZERO_HR_TIME, span.duration)),
      PERSISTED_DECIMALS,
    );
  }

  return 0;
}

/*
 * ---------------------------------------------------------------------------
 * Identifiers
 * ---------------------------------------------------------------------------
 */

/**
 * The invalid span id of the W3C trace-context model, which an
 * unsampled or invalid span context reports.
 *
 * Syntactically a span id, semantically the absence of one, so it is treated
 * as "no parent" rather than persisted as a parent nothing will ever match.
 * The trace-id counterpart is checked the same way, for a sharper reason: every
 * event carrying an all-zero trace id would correlate into one enormous
 * fictitious trace.
 */
const ALL_ZERO_SPAN_ID = '0000000000000000';

/** The all-zero trace id, rejected for the reason given on {@link ALL_ZERO_SPAN_ID}. */
const ALL_ZERO_TRACE_ID = '00000000000000000000000000000000';

/**
 * The span's own correlation identifiers, or `null` when either is unusable.
 *
 * OpenTelemetry already produces 32 and 16 lowercase hex characters, and the
 * guards are `@debuggen/shared`'s — the same patterns the event schema
 * validates against — so a span from a provider that does not is skipped here
 * instead of being rejected at ingest, where the reason would be a validation
 * issue rather than a producer to look at.
 *
 * `traceId` is never rewritten, normalised or substituted. It is the only thing
 * that joins a browser interaction to the route handler and queries it caused,
 * and the service's attribution joins the server tier to the browser tier on it
 * alone.
 */
function readSpanContextIds(span: ReadableSpan): { traceId: string; spanId: string } | null {
  if (typeof span.spanContext !== 'function') {
    return null;
  }

  const spanContext = span.spanContext();
  const traceId: unknown = spanContext?.traceId;
  const spanId: unknown = spanContext?.spanId;

  if (!isTraceId(traceId) || traceId === ALL_ZERO_TRACE_ID) {
    return null;
  }
  if (!isSpanId(spanId) || spanId === ALL_ZERO_SPAN_ID) {
    return null;
  }

  return { traceId, spanId };
}

/**
 * The parent span's id, or `undefined` when this span is a trace root.
 *
 * Read from the SDK 2.x `parentSpanContext` (earlier versions exposed a
 * `parentSpanId` field directly; the pinned 2.11.0 type definitions do not).
 * The key is **omitted** rather than set to `undefined` when there is no
 * parent: absence means trace root and is meaningful, and the ingress schema is
 * strict about the difference.
 *
 * A malformed, all-zero or self-referential parent is treated as absent. A span
 * naming itself as its own parent would be a cycle in the correlated tree,
 * which no ordering can resolve.
 */
function readParentSpanId(span: ReadableSpan, spanId: string): string | undefined {
  const parentSpanId: unknown = span.parentSpanContext?.spanId;
  if (!isSpanId(parentSpanId) || parentSpanId === ALL_ZERO_SPAN_ID || parentSpanId === spanId) {
    return undefined;
  }
  return parentSpanId;
}

/**
 * The producer id to stamp on the event.
 *
 * The context's value when it is usable — `./exporter.ts` passes the one from
 * the preload configuration, and a test passes a fixed one — and
 * {@link PRODUCER_ID} otherwise. Falling back rather than skipping is the
 * right failure here: the id identifies the process, an unusable one would only
 * be rejected at ingest, and the process's own id is always correct.
 *
 * Only emptiness and surrounding whitespace are checked, both of which the
 * schema rejects. Its length bound is private to `../schema/event.ts`, so there
 * is nothing to import and a local copy of the number would be the duplicate
 * definition that file exists to prevent.
 */
function resolveProducerId(candidate: string | undefined): string {
  if (typeof candidate !== 'string') {
    return PRODUCER_ID;
  }
  if (candidate.length === 0 || candidate.trim().length !== candidate.length) {
    return PRODUCER_ID;
  }
  return candidate;
}

/*
 * ---------------------------------------------------------------------------
 * The `(producerId, captureId)`-scoped sequence
 * ---------------------------------------------------------------------------
 */

/**
 * A monotonic sequence counter, scoped to the `(producerId, captureId)` pair
 * the correlator orders on.
 *
 * Both halves of the scope are arguments, because both halves matter and only
 * one of them was ever enforceable by convention. A process is normally one
 * producer, so one allocator would do — but nothing about an allocator's
 * ownership *proves* that, and a counter drawn from by two producer ids in turn
 * reports each of them as a producer whose events arrived out of order: within
 * `(producerId, captureId)` the numbers must increase, and interleaving them
 * makes each subsequence jump forwards and backwards. Keying by the pair makes
 * a shared allocator correct rather than merely discouraged.
 */
export interface SeqAllocator {
  /**
   * The next sequence number for `(producerId, captureId)`: zero-based within
   * that pair, restarting at zero whenever the producer's capture changes.
   *
   * @param producerId The producer the event will be stamped with — the
   * *resolved* id, the one that reaches the event, never the caller's raw
   * candidate.
   * @param captureId The active capture window's id, or `null` outside a
   * capture. `null` is a scope like any other: an event emitted outside a
   * capture is numbered in its own sequence.
   */
  next(producerId: string, captureId: string | null): number;
}

/**
 * The number of producer ids one allocator tracks with a counter of its own.
 *
 * A dev-server process is one producer, and a test is a handful, so the bound
 * is never reached in practice. It exists because the producer id arrives from
 * a caller: an allocator lives for the whole process (`./exporter.ts`
 * constructs one per span processor and never resets it), and a map keyed by
 * something a caller supplies would otherwise be an unbounded structure in
 * somebody else's dev server.
 */
export const MAX_TRACKED_PRODUCERS = 16;

/** One producer's counter: the capture it is numbering, and the next number. */
interface ProducerSequence {
  /** The capture this counter is scoped to; `null` is a scope of its own. */
  capture: string | null;
  /** The number the next call will return. */
  next: number;
}

/**
 * Creates a sequence allocator.
 *
 * Zero-based per pair, and it counts *emitted events* rather than spans: a
 * skipped span consumes no number, so the sequence has no gap where a span was
 * dropped — and a gap would be harmless anyway, while going backwards would
 * not, since `seq` is what orders two events of one producer that share a
 * millisecond (module documentation).
 *
 * Past {@link MAX_TRACKED_PRODUCERS} distinct producers, further producers draw
 * from one shared counter that **never restarts**. That degradation is chosen
 * deliberately: numbers drawn from a strictly increasing counter are still
 * strictly increasing when read per producer, so ordering — the property the
 * correlator depends on — survives, and only the cosmetic restart-at-zero is
 * lost. Evicting a counter instead would hand the same pair a number it had
 * already used, which is the one failure no ordering can repair.
 *
 * Exported so `convert.test.ts` can assert the properties that matter — strictly
 * increasing within one pair, reset on a capture change, independent between
 * producers, unaffected by spans that were skipped — against an instance it
 * owns, without the module-level counter making one test depend on another.
 */
export function createSeqAllocator(): SeqAllocator {
  const perProducer = new Map<string, ProducerSequence>();
  let overflow = 0;

  return {
    next(producerId: string, captureId: string | null): number {
      const existing = perProducer.get(producerId);
      if (existing !== undefined) {
        if (existing.capture !== captureId) {
          existing.capture = captureId;
          existing.next = 0;
        }
        const value = existing.next;
        existing.next = value + 1;
        return value;
      }

      if (perProducer.size >= MAX_TRACKED_PRODUCERS) {
        const value = overflow;
        overflow = value + 1;
        return value;
      }

      perProducer.set(producerId, { capture: captureId, next: 1 });
      return 0;
    },
  };
}

/**
 * The allocator used when a caller supplies none: this process's sequence.
 *
 * The single piece of state in the module, and the reason the rest of it is
 * documented as pure "apart from the sequence allocator".
 */
const processSeqAllocator = createSeqAllocator();

/*
 * ---------------------------------------------------------------------------
 * Conversion
 * ---------------------------------------------------------------------------
 */

/**
 * What the conversion needs to know that the span cannot tell it.
 *
 * Everything here is injectable so the sibling test can pin the values that
 * would otherwise vary per process, and so `./exporter.ts` can hand over its
 * capture gate's state without this file reaching for it.
 */
export interface ConvertContext {
  /**
   * The active capture window's id, or `null` outside a capture.
   *
   * It scopes the sequence counter and **nothing else**: it is deliberately not
   * written onto the event, because `captureId` is one of the three fields the
   * service assigns (module documentation). `./exporter.ts` drops spans outside
   * a capture before converting them, so `null` arrives here only from a caller
   * that chose to convert anyway.
   */
  readonly captureId: string | null;

  /**
   * The producer id to stamp, defaulting to {@link PRODUCER_ID} — this
   * process's id, minted once at module load in `./config.js`.
   */
  readonly producerId?: string | undefined;

  /**
   * The sequence allocator to draw from, defaulting to this process's.
   *
   * Overriding {@link producerId} without overriding this one is safe: an
   * allocator keys its counters by the `(producerId, captureId)` pair, so two
   * producers sharing an allocator keep separate sequences. A caller still
   * owns one per test to keep one case's numbering out of another's.
   */
  readonly seq?: SeqAllocator | undefined;
}

/**
 * Converts one finished span into one event ready for ingest, or returns
 * `null` for a span this file deliberately does not emit.
 *
 * `null` means one of five things, each of them a decision recorded above: the
 * span's kind and tier could not be established ({@link classifySpan}); the
 * pair is not one the kind vocabulary permits, which would be a programming
 * error here rather than a producer's mistake; its trace or span id is not a
 * usable correlation id; its start time converts outside the plausible epoch
 * range; or a foreign span object threw while being read. `./exporter.ts`
 * filters those out and counts them.
 *
 * The emitted object is within the ingress field set — `sessionId`,
 * `captureId`, `ingestSeq` and `redacted` are never set, and
 * `attributes.request_key` can never appear — because the ingress schema is
 * strict and performs no coercion: one extra key is a hard rejection of an
 * event the capture cannot recover. `source` is present only on a `function`
 * span whose patch metadata validated ({@link deriveFunctionSource}), and
 * omitted as a key otherwise.
 *
 * Never throws, whatever the span's shape.
 *
 * @param span A finished span from the host process's span pipeline.
 * @param context The capture scope, producer id and sequence allocator.
 * @returns The event to ingest, or `null` to skip this span.
 */
export function spanToIngressEvent(
  span: ReadableSpan,
  context: ConvertContext,
): TelemetryEventIngress | null {
  try {
    if (typeof span !== 'object' || span === null) {
      return null;
    }

    const classification = classifySpan(span);
    if (classification === null) {
      return null;
    }

    const { kind, tier } = classification;
    // Every pair this file produces is a frozen constant, so this can only fail
    // if `KIND_ALLOWED_TIERS` and those constants disagree - which the sibling
    // test asserts they do not. Checked anyway, because a mis-tiered event
    // would silently move time between `frontend_duration`,
    // `backend_duration` and `database_duration` and make every number in the
    // generated panel wrong in a way no reader could detect.
    if (!isTierAllowedForKind(kind, tier)) {
      return null;
    }

    const ids = readSpanContextIds(span);
    if (ids === null) {
      return null;
    }

    const startTime = convertStartTime(span);
    if (startTime === null) {
      return null;
    }

    const facts: SpanFacts = {
      attributes: readAttributes(span),
      name: readSpanName(span),
      scope: readScopeName(span),
    };

    // Resolved before the attribute passes, because a location that validated
    // consumes the three metadata keys it was built from, and one that did not
    // leaves them visible as ordinary attributes.
    const source = deriveFunctionSource(kind, facts.attributes);
    const attributes = buildAttributes(span, kind, facts, source !== undefined);
    const derivedName = deriveName(kind, facts, attributes);
    const parentSpanId = readParentSpanId(span, ids.spanId);
    const allocator = context?.seq ?? processSeqAllocator;
    // One value, used twice: the id stamped on the event is the id its sequence
    // is scoped to, so the two can never describe different producers.
    const producerId = resolveProducerId(context?.producerId);

    return {
      id: newEventId(),
      traceId: ids.traceId,
      spanId: ids.spanId,
      // Omitted, never `undefined`: absence means trace root.
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      kind,
      name: boundText(derivedName.length > 0 ? derivedName : kind, MAX_EVENT_NAME_LENGTH),
      startTime,
      duration: convertDuration(span),
      tier,
      attributes,
      status: toStatus(span),
      // Omitted, never `undefined`: the strict schema distinguishes the two,
      // and absence means no resolver could commit to a location.
      ...(source === undefined ? {} : { source }),
      producerId,
      // Drawn last, so a span rejected by any check above consumes no number.
      seq: allocator.next(producerId, context?.captureId ?? null),
    };
  } catch {
    // The same contract as `classifySpan`: a span whose own getters throw is
    // not evidence, and a throw here would travel into the developer's
    // dev-server process, which must keep serving.
    return null;
  }
}
