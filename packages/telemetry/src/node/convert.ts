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
 * `(producerId, captureId)` (AAP §0.2.3): {@link createSeqAllocator} restarts
 * at zero whenever the capture changes. It matters because the correlator's
 * canonical ordering is *parent before child*, then `startTime`, then
 * `(producerId, seq)`, then the store-assigned `ingestSeq` — so `seq` is what
 * separates two events of one producer that share a millisecond. Gaps are
 * harmless (a skipped span consumes no number); going backwards is not, which
 * is why the counter is never recomputed from anything else.
 *
 * ## Three fields this file must never set
 *
 * `sessionId`, `captureId` and `ingestSeq` belong to the **persisted** schema
 * only. `../schema/event.ts` makes the ingress schema strict, so any one of
 * them would be a hard rejection at ingest — which is the intended outcome,
 * because attribution is the service's job
 * (`apps/local-service/src/telemetry/attribute.ts`). `source` is left unset for
 * the same reason: server-side source resolution runs in the service, through
 * the code graph, the route map and recorded patch metadata, and a preload that
 * guessed at a location would be inventing evidence. `redacted` belongs to
 * `../redaction/redactor.ts`, and `attributes.request_key` is computed at
 * ingest from the *unredacted* URL under a per-session HMAC key — writing one
 * here would both be wrong and leak the grouping key.
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
  hrTimeDurationMs,
  hrTimeToEpochMs,
  isSpanId,
  isTraceId,
  newEventId,
  roundMs,
} from '@debuggen/shared';
import type { HrTime } from '@debuggen/shared';
import { SpanKind } from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';

import {
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
 * `pg.query:<COMMAND>[ <database>]` for the driver.
 */
export const DB_SPAN_NAME_PREFIXES = Object.freeze({
  /** ORM span names, client and engine alike. */
  orm: 'prisma:',
  /** Driver query span names. */
  driver: 'pg.query',
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
 */
export const FUNCTION_SPAN_MARKER_ATTRIBUTE = 'debuggenFunction';

/** Accepted spellings of {@link FUNCTION_SPAN_MARKER_ATTRIBUTE}, canonical first. */
export const FUNCTION_SPAN_MARKER_ATTRIBUTES: readonly string[] = Object.freeze([
  FUNCTION_SPAN_MARKER_ATTRIBUTE,
  'debuggen.function',
  'debuggen.span',
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

/** Whether an instrumentation scope name belongs to a database instrumentation. */
function isDatabaseScope(scope: string): boolean {
  return (
    scope === DB_INSTRUMENTATION_SCOPES.orm ||
    scope.startsWith(DB_INSTRUMENTATION_SCOPES.ormScopePrefix) ||
    scope === DB_INSTRUMENTATION_SCOPES.driver
  );
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

    if (
      isDatabaseScope(scope) ||
      name.startsWith(DB_SPAN_NAME_PREFIXES.orm) ||
      name.startsWith(DB_SPAN_NAME_PREFIXES.driver) ||
      hasDatabaseAttributes(attributes)
    ) {
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
 * The `db.client` value for a database span: which producer emitted it.
 *
 * Derived rather than read, because neither instrumentation reports it and a
 * consumer needs it to tell an ORM span from the driver span underneath it
 * instead of counting one query twice.
 */
function deriveDbClient(facts: SpanFacts): string | undefined {
  if (
    facts.scope === DB_INSTRUMENTATION_SCOPES.orm ||
    facts.scope.startsWith(DB_INSTRUMENTATION_SCOPES.ormScopePrefix) ||
    facts.name.startsWith(DB_SPAN_NAME_PREFIXES.orm)
  ) {
    return DB_CLIENT_VALUES.orm;
  }
  if (
    facts.scope === DB_INSTRUMENTATION_SCOPES.driver ||
    facts.name.startsWith(DB_SPAN_NAME_PREFIXES.driver)
  ) {
    return DB_CLIENT_VALUES.driver;
  }
  return undefined;
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
 */
function deriveDbOperation(facts: SpanFacts): string | undefined {
  if (facts.name.startsWith(DB_SPAN_NAME_PREFIXES.driver)) {
    const separator = facts.name.indexOf(':');
    if (separator < 0) {
      return undefined;
    }
    const tail = facts.name.slice(separator + 1).trim();
    const space = tail.indexOf(' ');
    const command = space < 0 ? tail : tail.slice(0, space);
    return command.length > 0 ? command : undefined;
  }

  if (facts.name.startsWith(DB_SPAN_NAME_PREFIXES.orm)) {
    const segments = facts.name.split(':').filter((segment) => segment.length > 0);
    const operation = segments.at(-1);
    // A bare `prisma:` name carries no operation; the prefix itself is not one.
    return operation !== undefined && operation !== DB_CLIENT_VALUES.orm ? operation : undefined;
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
 * Pass D is where the bounds apply, because an attribute nobody declared is an
 * attribute nobody reasoned about: at most {@link MAX_TRACKED_KEYS} keys in
 * total, string values cut to {@link MAX_PREVIEW_LENGTH}, primitives only.
 * Declared keys are never the ones a full budget drops — the largest declared
 * set is a small fraction of the budget and it is filled first — and the
 * pass-through order is the span's own key order, so the result is
 * deterministic.
 *
 * `request_key` can never appear: every key of
 * {@link SERVICE_ASSIGNED_ATTRIBUTE_KEYS} is filtered out of all four passes,
 * whoever set it.
 */
function buildAttributes(
  span: ReadableSpan,
  kind: TelemetryKind,
  facts: SpanFacts,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Pass A - the keys this kind declares, in catalog order.
  for (const key of attributeKeysFor(kind)) {
    if (SERVICE_ASSIGNED_KEYS.has(key)) {
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

  // Pass D - bounded pass-through of everything the catalog does not declare.
  let emitted = Object.keys(result).length;
  for (const [key, value] of Object.entries(facts.attributes)) {
    if (emitted >= MAX_TRACKED_KEYS) {
      break;
    }
    if (
      result[key] !== undefined ||
      ALIAS_KEYS.has(key) ||
      SERVICE_ASSIGNED_KEYS.has(key) ||
      !isEmittableAttributeValue(value)
    ) {
      continue;
    }
    result[key] = typeof value === 'string' ? boundText(value, MAX_PREVIEW_LENGTH) : value;
    emitted += 1;
  }

  return result;
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
 * A monotonic sequence counter for one producer, scoped to the capture it is
 * numbering.
 *
 * One process is one producer, so an allocator is per process — or, in a test,
 * per fixed producer id. Sharing one allocator between two producer ids would
 * interleave their sequences and break the `(producerId, seq)` tie-breaker the
 * correlator depends on.
 */
export interface SeqAllocator {
  /**
   * The next sequence number for `captureId`, starting at zero and restarting
   * at zero whenever `captureId` differs from the previous call's.
   *
   * @param captureId The active capture window's id, or `null` outside a
   * capture. `null` is a scope like any other: an event emitted outside a
   * capture is numbered in its own sequence.
   */
  next(captureId: string | null): number;
}

/**
 * Creates a sequence allocator.
 *
 * Zero-based, and it counts *emitted events* rather than spans: a skipped span
 * consumes no number, so the sequence has no gap where a span was dropped — and
 * a gap would be harmless anyway, while going backwards would not, since `seq`
 * is what orders two events of one producer that share a millisecond (module
 * documentation).
 *
 * Exported so `convert.test.ts` can assert the three properties that matter —
 * strictly increasing within one capture, reset on a capture change, unaffected
 * by spans that were skipped — against an instance it owns, without the
 * module-level counter making one test depend on another.
 */
export function createSeqAllocator(): SeqAllocator {
  let scoped = false;
  let scope: string | null = null;
  let next = 0;

  return {
    next(captureId: string | null): number {
      if (!scoped || captureId !== scope) {
        scoped = true;
        scope = captureId;
        next = 0;
      }
      const value = next;
      next += 1;
      return value;
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
   * A caller that overrides {@link producerId} should override this too: a
   * sequence belongs to the `(producerId, captureId)` pair, not to the module.
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
 * The emitted object is exactly the ingress field set — `sessionId`,
 * `captureId`, `ingestSeq`, `source` and `redacted` are never set, and
 * `attributes.request_key` can never appear — because the ingress schema is
 * strict and performs no coercion: one extra key is a hard rejection of an
 * event the capture cannot recover.
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

    const attributes = buildAttributes(span, kind, facts);
    const derivedName = deriveName(kind, facts, attributes);
    const parentSpanId = readParentSpanId(span, ids.spanId);
    const allocator = context?.seq ?? processSeqAllocator;

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
      producerId: resolveProducerId(context?.producerId),
      // Drawn last, so a span rejected by any check above consumes no number.
      seq: allocator.next(context?.captureId ?? null),
    };
  } catch {
    // The same contract as `classifySpan`: a span whose own getters throw is
    // not evidence, and a throw here would travel into the developer's
    // dev-server process, which must keep serving.
    return null;
  }
}
