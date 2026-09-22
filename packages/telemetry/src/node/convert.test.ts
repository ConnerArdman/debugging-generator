/**
 * Tests for `./convert.ts` — the one translation from a finished OpenTelemetry
 * `ReadableSpan` into the product's single event shape, and therefore the only
 * thing standing between a developer's dev-server process and every server- or
 * database-tier number a generated panel shows.
 *
 * ## What is on trial
 *
 * Five failures are what the cases below exist to prevent, each of them silent
 * rather than loud:
 *
 * 1. **A span classified wrongly, or not at all.** `kind` and `tier` decide
 *    which lane a span occupies, which aggregate counts it and which panel
 *    node reads it; a request span mistaken for an outgoing one moves time
 *    from `backend_duration` to nothing at all. Every framework and
 *    instrumentation literal the module matches on lives in its exported
 *    constant tables, so the mapping suite **iterates those tables** instead
 *    of restating them: a framework upgrade that renames a span type produces
 *    one clear list of failures here rather than an empty timeline in front of
 *    a developer.
 * 2. **A truncated time base.** `startTime` is Unix epoch milliseconds *as a
 *    double* and `duration` is milliseconds (AAP §0.2.3). A `Math.floor`
 *    anywhere in the conversion collapses the order of a fast handler and the
 *    query it issued, which no downstream sorting can recover. The vectors
 *    asserted here are the ones `packages/shared/src/time.test.ts` declares
 *    canonical *for this file*, restated rather than re-derived so the two
 *    suites cannot drift apart, and the sub-millisecond case asserts the
 *    emitted value is **not an integer**.
 * 3. **A broken sequence.** `seq` is scoped to `(producerId, captureId)` and is
 *    the tie-breaker the correlator uses between two events of one producer
 *    that share a millisecond (parent before child, then `startTime`, then
 *    `(producerId, seq)`, then `ingestSeq`). Monotonicity, the restart on a
 *    capture change and the "a skipped span consumes no number" rule are all
 *    pinned here, because an integration test cannot tell a gap from a
 *    reordering.
 * 4. **Attribution leaking into the producer contract.** `sessionId`,
 *    `captureId`, `ingestSeq`, `source`, `redacted` and
 *    `attributes.request_key` belong to the service. The ingress schema is
 *    strict and performs no coercion, so one extra key is a hard rejection of
 *    an event the capture cannot recover — which is why the decisive assertion
 *    in this suite is not a field-by-field expectation but a **round trip
 *    through `parseTelemetryEventIngress` for every kind the module emits**.
 *    The schema, not this file's expectations, is the arbiter of legality.
 * 5. **A throw reaching the host process.** A span handed to this module may
 *    come from any third-party instrumentation loaded into the developer's dev
 *    server. AAP §0.5.1's "the application keeps serving" guarantee makes
 *    `null` the only permitted failure, so the hostile-input suite feeds
 *    missing members, a `spanContext()` that answers nothing, a non-string
 *    name, a cyclic attribute value and a getter that throws, and asserts each
 *    one is answered rather than raised.
 *
 * ## Habits in here, each deliberate
 *
 * - **Spans are local fixtures, never a started SDK.** `buildSpan` assembles
 *   the exact member set of `@opentelemetry/sdk-trace-base@2.11.0`'s
 *   `ReadableSpan` — including the 2.x spellings `parentSpanContext` and
 *   `instrumentationScope`, which replaced `parentSpanId` and
 *   `instrumentationLibrary` — and {@link asReadableSpan} is the single cast
 *   boundary of the suite, so no case can quietly describe a span shape the
 *   installed SDK does not produce.
 * - **Bounds and vocabularies are imported, never written as numbers.**
 *   `MAX_TRACKED_KEYS`, `MAX_PREVIEW_LENGTH`, `MIN_EPOCH_MS`, `MAX_EPOCH_MS`,
 *   `OTEL_STATUS_CODE_TO_STATUS` and the per-kind key registry come from the
 *   schema package; a published bound that changes there must fail a
 *   *consumer* here rather than be silently agreed with.
 * - **Identifiers come from `@debuggen/shared`'s generators**, so the 32- and
 *   16-hex patterns the schema validates are satisfied without hand-typed hex,
 *   and the malformed-identifier cases are written out precisely because they
 *   must never pass.
 * - **Every allocator is owned by its test.** A context built here carries its
 *   own {@link createSeqAllocator} instance, so no case can depend on the
 *   module-level counter another case advanced; the two cases that deliberately
 *   exercise the process allocator say so.
 * - **No fixture string resembles a credential and none names an application.**
 *   The leak sentinel is assembled at runtime from fragments, and every symbol,
 *   route and statement below is neutral vocabulary — this file is tracked, and
 *   a demo identifier here would misrepresent what the product knows about any
 *   particular project.
 */

import { describe, expect, it } from 'vitest';

import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import type { SpanContext } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { ID_PREFIXES, isErr, isOk, newSpanId, newTraceId } from '@debuggen/shared';
import type { HrTime } from '@debuggen/shared';

import {
  attributeKeysFor,
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
} from '../schema/attributes.js';
import { MAX_EPOCH_MS, MIN_EPOCH_MS, parseTelemetryEventIngress } from '../schema/event.js';
import type { TelemetryEventIngress } from '../schema/event.js';
import { isTierAllowedForKind, OTEL_STATUS_CODE_TO_STATUS } from '../schema/kinds.js';
import type { TelemetryKind, TelemetryStatus, TelemetryTier } from '../schema/kinds.js';
import { PRODUCER_ID, TRACER_NAME } from './config.js';
import {
  ATTRIBUTE_KEY_TRANSLATIONS,
  classifySpan,
  createSeqAllocator,
  DB_CLIENT_VALUES,
  DB_INSTRUMENTATION_SCOPES,
  DB_SPAN_NAME_PREFIXES,
  EXCEPTION_EVENT_ATTRIBUTES,
  EXCEPTION_EVENT_NAME,
  FUNCTION_SPAN_MARKER_ATTRIBUTE,
  FUNCTION_SPAN_MARKER_ATTRIBUTES,
  isEmittableSpan,
  MAX_EVENT_NAME_LENGTH,
  NEXT_SPAN_NAME_PREFIXES,
  NEXT_SPAN_TYPE_ATTRIBUTE,
  NEXT_SPAN_TYPES,
  spanToIngressEvent,
} from './convert.js';
import type { ConvertContext, SeqAllocator } from './convert.js';

/*
 * ---------------------------------------------------------------------------
 * Time fixtures — the canonical vectors
 *
 * `packages/shared/src/time.test.ts` declares its conversion vectors canonical
 * for `./convert.ts`, so they are restated here as literals rather than
 * recomputed with the helpers under test. A number below that disagrees with
 * that suite is a defect in one of the two files, which is exactly the failure
 * this duplication is for.
 * ---------------------------------------------------------------------------
 */

/**
 * A present-day instant as the SDK hands one over: whole seconds since the
 * epoch plus a nanosecond remainder that is not a whole number of
 * milliseconds.
 *
 * `1_700_000_000 s` is 2023-11-14T22:13:20Z, the shared suite's
 * `PRESENT_DAY_HR_TIME` — a 2020s epoch value, which is where a double's
 * mantissa starts to matter and therefore where a conversion written for small
 * numbers would fail.
 */
const SPAN_START: HrTime = [1_700_000_000, 123_456_789];

/** {@link SPAN_START} plus 100 µs, the shared suite's 0.1 ms duration vector. */
const SPAN_END: HrTime = [1_700_000_000, 123_556_789];

/**
 * {@link SPAN_START} as the epoch-millisecond value `convert.ts` persists:
 * `roundMs(hrTimeToEpochMs(SPAN_START), 3)`.
 */
const SPAN_START_EPOCH_MS = 1_700_000_000_123.457;

/**
 * {@link SPAN_START} as epoch milliseconds *before* rounding, composed from
 * the whole second and the decimal remainder.
 *
 * A sum rather than one literal on purpose: `1_700_000_000_123.456789` is not
 * representable as a double (its nearest neighbour prints as
 * `1700000000123.4568`), so writing it out is itself a lint failure
 * (`no-loss-of-precision`). The sum evaluates to that same neighbour without
 * pretending otherwise, which is why the comparison against it is made to
 * three decimals — the representation, not the conversion, is what limits
 * precision at this magnitude.
 */
const SPAN_START_EPOCH_MS_UNROUNDED = 1_700_000_000_000 + 123.456789;

/** The duration {@link SPAN_START} → {@link SPAN_END} in milliseconds. */
const SPAN_DURATION_MS = 0.1;

/**
 * The sub-millisecond vector of the shared suite — 1_500_000 ns is exactly
 * 1.5 ms, and 1.5 is exactly representable in binary, so it is asserted with
 * `toBe` and a truncating implementation cannot survive it.
 *
 * It appears twice in this suite, deliberately: as a *duration* pair, where
 * 1.5 is the answer, and as a *start* time, where the same pair is the classic
 * producer bug — a relative `performance.now()`-style reading expressed as
 * seconds — and must be refused.
 */
const SUB_MILLISECOND_PAIR: HrTime = [0, 1_500_000];

/** The zero pair, which the module measures a relative duration from. */
const ZERO_PAIR: HrTime = [0, 0];

/*
 * ---------------------------------------------------------------------------
 * Vocabulary fixtures
 *
 * Neutral by construction: nothing here names a component, service function or
 * route of any particular project.
 * ---------------------------------------------------------------------------
 */

/** A span name that matches no prefix and no span type the module knows. */
const NEUTRAL_SPAN_NAME = 'unclassified internal work';

/** An instrumentation scope that is neither the product's nor a database's. */
const NEUTRAL_SCOPE_NAME = 'third-party-instrumentation';

/** A version on the neutral scope, so no case depends on one being absent. */
const NEUTRAL_SCOPE_VERSION = '1.2.3';

/** Request vocabulary for the server-tier fixtures. */
const REQUEST_METHOD = 'GET';

/** A route template that belongs to no particular project. */
const REQUEST_ROUTE = '/api/example';

/** An absolute target for the outgoing-request fixtures. */
const OUTGOING_URL = 'https://example.invalid/v1/resource';

/** The patched symbol a `function` span reports. */
const FUNCTION_SYMBOL = 'sampleOperation';

/** The module a `function` span reports, project-relative and POSIX. */
const FUNCTION_MODULE = 'src/lib/sample.ts';

/** A parameterized statement: placeholders only, never an inline literal. */
const DB_STATEMENT = 'SELECT id, label FROM widgets WHERE owner_id = $1 ORDER BY id LIMIT $2';

/** The database a `db.query` fixture reports. */
const DB_NAME = 'sample_db';

/** The database system a `db.query` fixture reports. */
const DB_SYSTEM = 'postgresql';

/**
 * A recognisable value that must never appear in a validation failure.
 *
 * Assembled at runtime from fragments so the tracked source of this file holds
 * no literal that a secret scanner could mistake for a credential, and long
 * enough that a partial echo is still obvious in a diff.
 */
const LEAK_SENTINEL = `REDACT_ME_${'x'.repeat(40)}`;

/** A fixed producer id, so a context's value can be traced through a conversion. */
const FIXED_PRODUCER_ID = `${ID_PREFIXES.producer}_${'0'.repeat(16)}`;

/** A fixed capture id: the sequence scope every case that does not vary it uses. */
const CAPTURE_A = `${ID_PREFIXES.capture}_${'a'.repeat(16)}`;

/** A second capture id, for the sequence's restart-on-scope-change rule. */
const CAPTURE_B = `${ID_PREFIXES.capture}_${'b'.repeat(16)}`;

/** The all-zero span id of the W3C trace-context model: syntax without meaning. */
const ALL_ZERO_SPAN_ID = '0'.repeat(16);

/** The all-zero trace id, refused for the same reason. */
const ALL_ZERO_TRACE_ID = '0'.repeat(32);

/*
 * ---------------------------------------------------------------------------
 * Span fixtures
 *
 * One builder, one cast. `buildSpan` produces the plain object; every hostile
 * variant is that object with a member replaced, so a case that is *meant* to
 * be malformed is malformed in exactly one respect and the rest of the shape
 * still matches the installed SDK.
 * ---------------------------------------------------------------------------
 */

/** A span event as `recordException` leaves one. */
interface SpanEventFixture {
  /** The event name; `'exception'` for a recorded failure. */
  readonly name: unknown;
  /** When it was recorded. */
  readonly time?: HrTime;
  /** The event's own attributes. */
  readonly attributes?: unknown;
}

/**
 * What a case says about a span; everything else is defaulted.
 *
 * `null` means *omit the member entirely* for the two members whose absence is
 * a distinct case (`endTime`, `scope`); `undefined` means "use the default".
 */
interface SpanFixture {
  readonly name?: string;
  readonly kind?: SpanKind;
  readonly traceId?: string;
  readonly spanId?: string;
  /** Present means the span has a parent; absent means it is a trace root. */
  readonly parentSpanId?: string;
  readonly startTime?: HrTime;
  readonly endTime?: HrTime | null;
  /** The SDK's own pair, which the module consults only when the endpoints are unusable. */
  readonly duration?: HrTime;
  /**
   * The span status. `code` is typed as a number rather than as
   * `SpanStatusCode` because the cast boundary below is what makes this object
   * a span, and the module deliberately accepts a code outside the enum by
   * degrading to `unset` — a case that could not be written at all if this
   * field were the enum type.
   */
  readonly status?: { readonly code?: number; readonly message?: unknown } | null;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly events?: readonly SpanEventFixture[];
  readonly scope?: { readonly name?: unknown; readonly version?: string } | null;
}

/**
 * The single cast boundary of this suite.
 *
 * A `ReadableSpan` is an interface, not a class, so a structurally complete
 * object *is* one — but the hostile cases below are deliberately incomplete or
 * wrongly typed, which is the shape the module promises to survive. Confining
 * the assertion to this one function keeps every other line of the suite
 * type-checked against the real interface.
 */
function asReadableSpan(span: Readonly<Record<string, unknown>>): ReadableSpan {
  return span as unknown as ReadableSpan;
}

/** The plain object behind a fixture, before it is presented as a span. */
function buildSpan(fixture: SpanFixture = {}): Record<string, unknown> {
  const traceId = fixture.traceId ?? newTraceId();
  const spanId = fixture.spanId ?? newSpanId();
  const spanContext: SpanContext = { traceId, spanId, traceFlags: TraceFlags.SAMPLED };

  const span: Record<string, unknown> = {
    name: fixture.name ?? NEUTRAL_SPAN_NAME,
    kind: fixture.kind ?? SpanKind.INTERNAL,
    spanContext: (): SpanContext => spanContext,
    startTime: fixture.startTime ?? SPAN_START,
    duration: fixture.duration ?? ZERO_PAIR,
    attributes: fixture.attributes ?? {},
    links: [],
    events: fixture.events ?? [],
    ended: true,
    resource: { attributes: {} },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };

  if (fixture.endTime !== null) {
    span.endTime = fixture.endTime ?? SPAN_END;
  }
  if (fixture.status !== null) {
    span.status = fixture.status ?? { code: SpanStatusCode.UNSET };
  }
  if (fixture.scope !== null) {
    span.instrumentationScope = {
      name: fixture.scope?.name ?? NEUTRAL_SCOPE_NAME,
      version: fixture.scope?.version ?? NEUTRAL_SCOPE_VERSION,
    };
  }
  if (fixture.parentSpanId !== undefined) {
    span.parentSpanContext = {
      traceId,
      spanId: fixture.parentSpanId,
      traceFlags: TraceFlags.SAMPLED,
    };
  }

  return span;
}

/**
 * A span from a fixture, with `raw` merged last so a case can replace any
 * member — including with a value the interface forbids.
 */
function makeSpan(
  fixture: SpanFixture = {},
  raw: Readonly<Record<string, unknown>> = {},
): ReadableSpan {
  return asReadableSpan({ ...buildSpan(fixture), ...raw });
}

/**
 * A span whose `member` throws when it is read.
 *
 * The one shape a plain object literal cannot express, and the one the
 * module's `catch` exists for: a foreign span object with an accessor that
 * fails.
 */
function makeSpanWithThrowingMember(member: string, fixture: SpanFixture = {}): ReadableSpan {
  const span = buildSpan(fixture);
  Object.defineProperty(span, member, {
    configurable: true,
    enumerable: true,
    get(): never {
      throw new Error('a foreign span member threw while being read');
    },
  });
  return asReadableSpan(span);
}

/** A recorded-exception span event, as `recordException` produces one. */
function exceptionEvent(type: string, message: string, stack: string): readonly SpanEventFixture[] {
  return [
    {
      name: EXCEPTION_EVENT_NAME,
      time: SPAN_END,
      attributes: {
        [EXCEPTION_EVENT_ATTRIBUTES.type]: type,
        [EXCEPTION_EVENT_ATTRIBUTES.message]: message,
        [EXCEPTION_EVENT_ATTRIBUTES.stack]: stack,
      },
    },
  ];
}

/*
 * ---------------------------------------------------------------------------
 * One builder per kind the module emits
 *
 * Each one is the shape the pinned producer actually reports, so the round-trip
 * suite validates realistic events rather than minimal ones. A case overrides
 * whatever it is about; `attributes` is replaced wholesale when overridden,
 * which keeps every attribute assertion explicit about its input.
 * ---------------------------------------------------------------------------
 */

/** The framework's incoming-request span, reported on span kind `SERVER`. */
function serverRequestSpan(fixture: SpanFixture = {}): ReadableSpan {
  return makeSpan({
    kind: SpanKind.SERVER,
    name: `${REQUEST_METHOD} ${REQUEST_ROUTE}`,
    attributes: {
      'http.method': REQUEST_METHOD,
      'http.route': REQUEST_ROUTE,
      'http.status_code': 200,
      url: REQUEST_ROUTE,
    },
    ...fixture,
  });
}

/** The framework's route-handler span, matched by its name prefix. */
function routeHandlerSpan(fixture: SpanFixture = {}): ReadableSpan {
  return makeSpan({
    name: `${NEXT_SPAN_NAME_PREFIXES.apiRouteHandler} (app) ${REQUEST_ROUTE}`,
    attributes: {
      [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.appRouteHandler,
      'next.route': REQUEST_ROUTE,
    },
    ...fixture,
  });
}

/** An outgoing request made while handling one, on span kind `CLIENT`. */
function serverFetchSpan(fixture: SpanFixture = {}): ReadableSpan {
  return makeSpan({
    kind: SpanKind.CLIENT,
    name: `${NEXT_SPAN_NAME_PREFIXES.serverFetch}POST ${OUTGOING_URL}`,
    attributes: {
      'http.method': 'POST',
      url: OUTGOING_URL,
      'http.status_code': 201,
    },
    ...fixture,
  });
}

/** A named application function timed by the product's own span helper. */
function functionSpan(fixture: SpanFixture = {}): ReadableSpan {
  return makeSpan({
    scope: { name: TRACER_NAME, version: '0.1.0' },
    name: FUNCTION_SYMBOL,
    attributes: {
      [FUNCTION_SPAN_MARKER_ATTRIBUTE]: 'function',
      symbol: FUNCTION_SYMBOL,
      module: FUNCTION_MODULE,
      async: true,
    },
    ...fixture,
  });
}

/** A database span from the driver instrumentation. */
function dbQuerySpan(fixture: SpanFixture = {}): ReadableSpan {
  return makeSpan({
    kind: SpanKind.CLIENT,
    scope: { name: DB_INSTRUMENTATION_SCOPES.driver, version: '0.74.0' },
    name: `${DB_SPAN_NAME_PREFIXES.driver}:SELECT ${DB_NAME}`,
    attributes: {
      'db.system': DB_SYSTEM,
      'db.statement': DB_STATEMENT,
      'db.rowCount': 3,
      'db.name': DB_NAME,
    },
    ...fixture,
  });
}

/** A failure with no better classification than the status it reported. */
function serverErrorSpan(fixture: SpanFixture = {}): ReadableSpan {
  return makeSpan({
    kind: SpanKind.INTERNAL,
    name: NEUTRAL_SPAN_NAME,
    status: { code: SpanStatusCode.ERROR, message: 'the operation failed' },
    events: exceptionEvent('SampleError', 'the operation failed', 'SampleError: at sample (a:1:1)'),
    attributes: { 'http.route': REQUEST_ROUTE },
    ...fixture,
  });
}

/*
 * ---------------------------------------------------------------------------
 * Conversion helpers
 * ---------------------------------------------------------------------------
 */

/** What a context may vary, with a fresh allocator unless one is supplied. */
interface ContextOptions {
  readonly captureId?: string | null;
  readonly producerId?: string | undefined;
  readonly seq?: SeqAllocator;
}

/**
 * A conversion context that owns its sequence allocator.
 *
 * Ownership is the point: a case that drew from the module-level counter would
 * depend on how many events the cases before it emitted, so only the two that
 * deliberately exercise the process allocator omit `seq`.
 */
function makeContext(options: ContextOptions = {}): ConvertContext {
  return {
    captureId: options.captureId === undefined ? CAPTURE_A : options.captureId,
    producerId: options.producerId,
    seq: options.seq ?? createSeqAllocator(),
  };
}

/** Converts with a context of this suite's defaults. */
function convert(
  span: ReadableSpan,
  context: ConvertContext = makeContext(),
): TelemetryEventIngress | null {
  return spanToIngressEvent(span, context);
}

/** Converts and asserts an event was emitted, narrowing away the `null`. */
function convertOk(span: ReadableSpan, context?: ConvertContext): TelemetryEventIngress {
  const event = context === undefined ? convert(span) : convert(span, context);
  expect(event).not.toBeNull();
  if (event === null) {
    throw new Error('expected the span to convert into an event');
  }
  return event;
}

/**
 * The ingress schema's verdict on an event, as `null` for "legal" and the
 * rejection's structural details otherwise.
 *
 * Shaped this way so a failing round trip *prints the issue list* rather than
 * only `expected true, received false`: the schema is the arbiter, and a
 * developer reading the failure needs to know which field it objected to.
 */
function ingressRejection(event: TelemetryEventIngress): unknown {
  const parsed = parseTelemetryEventIngress(event);
  return isOk(parsed) ? null : parsed.error.details;
}

/** Whether an own property exists on the emitted object at all. */
function hasKey(event: TelemetryEventIngress, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(event, key);
}

/*
 * ---------------------------------------------------------------------------
 * Classification: span → (kind, tier)
 *
 * Table-driven against the exported classifier, because the alternative — a
 * case per signal written by hand — hides which signal a regression broke. A
 * framework or instrumentation upgrade that renames a span type produces one
 * list of failures here, and the constant-table suites below make it
 * impossible to add an entry to the module's vocabulary without a mapping.
 * ---------------------------------------------------------------------------
 */

/** One classification expectation. */
interface ClassificationCase {
  /** What the case is about, interpolated into the test name. */
  readonly label: string;
  /** Built lazily, so every case gets fresh identifiers. */
  readonly span: () => ReadableSpan;
  readonly kind: TelemetryKind;
  readonly tier: TelemetryTier;
}

const CLASSIFICATION_CASES: readonly ClassificationCase[] = [
  // --- the framework's incoming-request span ------------------------------
  {
    label: 'the bare framework request-span name',
    span: () => makeSpan({ name: NEXT_SPAN_TYPES.request }),
    kind: 'http.server',
    tier: 'server',
  },
  {
    label: 'the framework request-span name with the route appended',
    span: () => makeSpan({ name: `${NEXT_SPAN_TYPES.request} ${REQUEST_METHOD} ${REQUEST_ROUTE}` }),
    kind: 'http.server',
    tier: 'server',
  },
  {
    label: 'the request span type, whatever the display name says',
    span: () =>
      makeSpan({
        name: `${REQUEST_METHOD} ${REQUEST_ROUTE}`,
        attributes: { [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.request },
      }),
    kind: 'http.server',
    tier: 'server',
  },
  {
    label: 'a rewritten display name on a server-kind span',
    span: () => serverRequestSpan(),
    kind: 'http.server',
    tier: 'server',
  },

  // --- the framework's route-handler span ---------------------------------
  {
    label: 'the App Router handler name',
    span: () =>
      makeSpan({ name: `${NEXT_SPAN_NAME_PREFIXES.apiRouteHandler} (app) ${REQUEST_ROUTE}` }),
    kind: 'route.handler',
    tier: 'server',
  },
  {
    label: 'the Pages Router handler name',
    span: () =>
      makeSpan({ name: `${NEXT_SPAN_NAME_PREFIXES.apiRouteHandler} (pages) ${REQUEST_ROUTE}` }),
    kind: 'route.handler',
    tier: 'server',
  },
  {
    label: 'the handler name prefix with nothing appended',
    span: () => makeSpan({ name: NEXT_SPAN_NAME_PREFIXES.apiRouteHandler }),
    kind: 'route.handler',
    tier: 'server',
  },
  {
    label: 'the App Router handler span type',
    span: () =>
      makeSpan({
        name: NEUTRAL_SPAN_NAME,
        attributes: { [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.appRouteHandler },
      }),
    kind: 'route.handler',
    tier: 'server',
  },
  {
    label: 'the Pages Router handler span type',
    span: () =>
      makeSpan({
        name: NEUTRAL_SPAN_NAME,
        attributes: { [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.pagesApiHandler },
      }),
    kind: 'route.handler',
    tier: 'server',
  },

  // --- outgoing requests ---------------------------------------------------
  {
    label: 'an outgoing-fetch span name on a client-kind span',
    span: () => serverFetchSpan(),
    kind: 'http.client',
    tier: 'server',
  },
  {
    label: 'the render-time fetch span type',
    span: () =>
      makeSpan({
        name: NEUTRAL_SPAN_NAME,
        attributes: { [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.serverFetch },
      }),
    kind: 'http.client',
    tier: 'server',
  },
  {
    label: "the framework's internal fetch span type",
    span: () =>
      makeSpan({
        name: NEUTRAL_SPAN_NAME,
        attributes: { [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.internalFetch },
      }),
    kind: 'http.client',
    tier: 'server',
  },
  {
    label: 'a client-kind span a third-party instrumentation reported',
    span: () => makeSpan({ kind: SpanKind.CLIENT }),
    kind: 'http.client',
    tier: 'server',
  },

  // --- database spans ------------------------------------------------------
  {
    label: "the ORM's own tracer scope",
    span: () => makeSpan({ scope: { name: DB_INSTRUMENTATION_SCOPES.orm } }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: "the ORM instrumentation's package scope",
    span: () => makeSpan({ scope: { name: `${DB_INSTRUMENTATION_SCOPES.ormScopePrefix}sample` } }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: "the driver instrumentation's scope",
    span: () => makeSpan({ scope: { name: DB_INSTRUMENTATION_SCOPES.driver } }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: 'an ORM span name under an unknown scope',
    span: () => makeSpan({ name: `${DB_SPAN_NAME_PREFIXES.orm}client:findMany` }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: 'a driver span name under an unknown scope',
    span: () => makeSpan({ name: `${DB_SPAN_NAME_PREFIXES.driver}:SELECT ${DB_NAME}` }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: 'a statement attribute alone',
    span: () => makeSpan({ attributes: { 'db.statement': DB_STATEMENT } }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: 'a system attribute alone',
    span: () => makeSpan({ attributes: { 'db.system': DB_SYSTEM } }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: 'the current database semantic conventions alone',
    span: () =>
      makeSpan({ attributes: { 'db.query.text': DB_STATEMENT, 'db.system.name': DB_SYSTEM } }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: 'a database span reported on client span kind',
    span: () => dbQuerySpan(),
    kind: 'db.query',
    tier: 'db',
  },

  // --- the product's own function spans ------------------------------------
  {
    label: "the product's tracer scope",
    span: () => makeSpan({ scope: { name: TRACER_NAME } }),
    kind: 'function',
    tier: 'server',
  },
  {
    label: 'the marker attribute under an unrelated scope',
    span: () => makeSpan({ attributes: { [FUNCTION_SPAN_MARKER_ATTRIBUTE]: 'function' } }),
    kind: 'function',
    tier: 'server',
  },
  {
    label: 'the marker attribute whatever its value',
    span: () => makeSpan({ attributes: { [FUNCTION_SPAN_MARKER_ATTRIBUTE]: true } }),
    kind: 'function',
    tier: 'server',
  },
  {
    label: 'a function span that also carries database attributes',
    span: () =>
      functionSpan({
        attributes: {
          [FUNCTION_SPAN_MARKER_ATTRIBUTE]: 'function',
          symbol: FUNCTION_SYMBOL,
          'db.statement': DB_STATEMENT,
        },
      }),
    kind: 'function',
    tier: 'server',
  },

  // --- failures with no better shape ---------------------------------------
  {
    label: 'an internal span that reported an error status',
    span: () => serverErrorSpan(),
    kind: 'server.error',
    tier: 'server',
  },
  {
    label: 'an error status with no recorded exception',
    span: () => serverErrorSpan({ events: [] }),
    kind: 'server.error',
    tier: 'server',
  },
];

describe('classifySpan', () => {
  it.each(CLASSIFICATION_CASES)(
    'reads $label as $kind on the $tier tier',
    ({ span, kind, tier }: ClassificationCase) => {
      expect(classifySpan(span())).toEqual({ kind, tier });
    },
  );

  it('prefers the span type over a display name that says otherwise', () => {
    // The framework rewrites a request span's display name mid-request, so the
    // type attribute is the more trustworthy of the two signals. A span whose
    // name is a handler name and whose type is the request type must follow the
    // type.
    const span = makeSpan({
      name: `${NEXT_SPAN_NAME_PREFIXES.apiRouteHandler} (app) ${REQUEST_ROUTE}`,
      attributes: { [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.request },
    });

    expect(classifySpan(span)).toEqual({ kind: 'http.server', tier: 'server' });
  });

  it('does not read an outgoing-fetch name on a non-client span as a request', () => {
    // The name prefix alone is not enough: the framework's fetch span is a
    // client-kind span, and an internal span merely named like one has not
    // made a request.
    const span = makeSpan({ name: `${NEXT_SPAN_NAME_PREFIXES.serverFetch}POST ${OUTGOING_URL}` });

    expect(classifySpan(span)).toBeNull();
  });

  it.each([undefined, '0.0.1', '7.10.0', '9.9.9-beta.1'])(
    'matches a database instrumentation scope independently of its version (%s)',
    (version: string | undefined) => {
      // A scope is `(name, version)`, and an instrumentation upgrade changes
      // only the version. Matching on the name is what keeps a database span a
      // database span across one.
      for (const name of [
        DB_INSTRUMENTATION_SCOPES.orm,
        `${DB_INSTRUMENTATION_SCOPES.ormScopePrefix}instrumentation`,
        DB_INSTRUMENTATION_SCOPES.driver,
      ]) {
        const scope = version === undefined ? { name } : { name, version };

        expect(classifySpan(makeSpan({ scope }))).toEqual({ kind: 'db.query', tier: 'db' });
      }
    },
  );

  it.each(FUNCTION_SPAN_MARKER_ATTRIBUTES)(
    'accepts %s as the function-span marker',
    (marker: string) => {
      expect(classifySpan(makeSpan({ attributes: { [marker]: 'function' } }))).toEqual({
        kind: 'function',
        tier: 'server',
      });
    },
  );

  it("spells the canonical marker as the span helper's own key", () => {
    // The agreement of AAP 0.5.1's patch path, stated from this side: the
    // helper in `./span-helper.ts` writes `debuggen.kind` on every span it
    // creates, and that attribute is the secondary signal for the `function`
    // kind when the instrumentation scope is unavailable. Pinning the literal
    // here is what makes a rename on either end fail a test instead of
    // silently disabling the signal.
    expect(FUNCTION_SPAN_MARKER_ATTRIBUTE).toBe('debuggen.kind');
    expect(FUNCTION_SPAN_MARKER_ATTRIBUTES[0]).toBe(FUNCTION_SPAN_MARKER_ATTRIBUTE);
  });

  it.each(Object.values(NEXT_SPAN_TYPES))(
    'maps the %s framework span type to a kind',
    (spanType: string) => {
      // The table is the module's whole vocabulary of framework span types, so
      // iterating it is what stops an entry being added without a mapping.
      const classification = classifySpan(
        makeSpan({
          name: NEUTRAL_SPAN_NAME,
          attributes: { [NEXT_SPAN_TYPE_ATTRIBUTE]: spanType },
        }),
      );

      expect(classification).not.toBeNull();
      expect(classification?.tier).toBe('server');
    },
  );

  it.each(Object.values(NEXT_SPAN_NAME_PREFIXES))(
    'maps the %s framework span-name prefix to a kind',
    (prefix: string) => {
      // The outgoing-request prefix requires a client-kind span (asserted
      // separately above), which is why every prefix is exercised on one.
      const classification = classifySpan(
        makeSpan({ kind: SpanKind.CLIENT, name: `${prefix}${REQUEST_ROUTE}` }),
      );

      expect(classification).not.toBeNull();
      expect(classification?.tier).toBe('server');
    },
  );

  it.each(Object.values(DB_INSTRUMENTATION_SCOPES))(
    'maps the %s instrumentation scope to a database span',
    (scopeName: string) => {
      expect(classifySpan(makeSpan({ scope: { name: scopeName } }))).toEqual({
        kind: 'db.query',
        tier: 'db',
      });
    },
  );

  it.each(Object.values(DB_SPAN_NAME_PREFIXES))(
    'maps the %s database span-name prefix to a database span',
    (prefix: string) => {
      expect(classifySpan(makeSpan({ name: `${prefix}sample` }))).toEqual({
        kind: 'db.query',
        tier: 'db',
      });
    },
  );

  it('skips a span it cannot describe rather than inventing a kind', () => {
    // The documented choice: internal framework machinery with no error to
    // report is skipped, not stored under an approximate kind. `log` is a kind
    // this module never produces - the page agent and the exporter own it - so
    // the assertion is `null`, not a fallback.
    expect(classifySpan(makeSpan())).toBeNull();
    expect(classifySpan(makeSpan({ kind: SpanKind.PRODUCER }))).toBeNull();
    expect(classifySpan(makeSpan({ kind: SpanKind.CONSUMER }))).toBeNull();
  });

  it('never claims the browser tier', () => {
    // The browser tier belongs to the page agent alone: a Node process can
    // speak for `server` and `db` and nothing else, and a mis-tiered event
    // would move time between `frontend_duration` and `backend_duration`
    // undetectably.
    const tiers = new Set<TelemetryTier>();
    for (const testCase of CLASSIFICATION_CASES) {
      const classification = classifySpan(testCase.span());
      expect(classification).not.toBeNull();
      if (classification !== null) {
        tiers.add(classification.tier);
      }
    }

    expect([...tiers].sort()).toEqual(['db', 'server']);
  });

  it('only returns kind and tier pairs the vocabulary permits', () => {
    // `../schema/kinds.ts` is the single authority on which tier a kind may be
    // reported in, and the conversion refuses a pair it disagrees with. This
    // asserts the classifier never produces such a pair in the first place, so
    // that refusal stays unreachable.
    const pairs = new Set<string>();
    for (const testCase of CLASSIFICATION_CASES) {
      const classification = classifySpan(testCase.span());
      if (classification === null) {
        continue;
      }
      expect(isTierAllowedForKind(classification.kind, classification.tier)).toBe(true);
      pairs.add(`${classification.kind}/${classification.tier}`);
    }

    expect([...pairs].sort()).toEqual([
      'db.query/db',
      'function/server',
      'http.client/server',
      'http.server/server',
      'route.handler/server',
      'server.error/server',
    ]);
  });

  it('answers a value that is not a span at all', () => {
    // `./exporter.ts` is the only caller today, but the module's contract is
    // that any value is answered rather than raised.
    expect(classifySpan(asReadableSpan({}))).toBeNull();
  });
});

describe('isEmittableSpan', () => {
  it.each(CLASSIFICATION_CASES)('agrees with the classifier about $label', ({ span }) => {
    expect(isEmittableSpan(span())).toBe(true);
  });

  it('reports a skipped span as not emittable', () => {
    expect(isEmittableSpan(makeSpan())).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The time base
 *
 * The vectors are the canonical ones of `packages/shared/src/time.test.ts`,
 * restated rather than recomputed. Exact equality where a value is exactly
 * representable in binary, three decimals where the representation itself
 * quantises — the same split that suite uses, and the reason a truncating
 * implementation cannot pass either of them.
 * ---------------------------------------------------------------------------
 */

describe('spanToIngressEvent: time', () => {
  it('converts a present-day start to rounded epoch milliseconds', () => {
    const event = convertOk(serverRequestSpan());

    expect(event.startTime).toBe(SPAN_START_EPOCH_MS);
    expect(event.startTime).toBeCloseTo(SPAN_START_EPOCH_MS_UNROUNDED, 3);
  });

  it('keeps the sub-millisecond remainder instead of truncating it', () => {
    // The assertion a `Math.floor` cannot survive. A fast handler and the query
    // it issued routinely start inside the same millisecond, and collapsing
    // their order is not recoverable by any downstream sort.
    const event = convertOk(serverRequestSpan());

    expect(Number.isInteger(event.startTime)).toBe(false);
    expect(event.startTime - Math.trunc(event.startTime)).toBeGreaterThan(0);
  });

  it('measures a duration from the endpoints in milliseconds', () => {
    const event = convertOk(serverRequestSpan());

    expect(event.duration).toBe(SPAN_DURATION_MS);
  });

  it('measures the sub-millisecond vector exactly', () => {
    // 1_500_000 ns is 1.5 ms and 1.5 is exactly representable, so this is
    // asserted with `toBe`: a conversion that quantised to whole milliseconds
    // would report `1` or `2` and pass any tolerant comparison.
    const start: HrTime = [SPAN_START[0], 0];
    const event = convertOk(
      serverRequestSpan({ startTime: start, endTime: [start[0], SUB_MILLISECOND_PAIR[1]] }),
    );

    expect(event.duration).toBe(1.5);
  });

  it('measures a duration across a second boundary', () => {
    // The shared suite's 900 ms → 1 100 ms vector, moved into the plausible
    // epoch range because a start time is validated as a real instant. The
    // arithmetic under test is the same: the seconds difference must carry.
    const event = convertOk(
      serverRequestSpan({
        startTime: [SPAN_START[0] + 10, 900_000_000],
        endTime: [SPAN_START[0] + 11, 100_000_000],
      }),
    );

    expect(event.duration).toBe(200);
  });

  it('clamps a reversed pair to zero rather than reporting negative time', () => {
    // A wall-clock adjustment between two readings must never publish a
    // negative bar in a waterfall. `-0` is normalised too, so a JSON round trip
    // and an `Object.is` comparison agree.
    const event = convertOk(serverRequestSpan({ startTime: SPAN_START, endTime: SPAN_START }));
    const reversed = convertOk(
      serverRequestSpan({ startTime: SPAN_END, endTime: SPAN_START, duration: ZERO_PAIR }),
    );

    expect(event.duration).toBe(0);
    expect(reversed.duration).toBe(0);
    expect(Object.is(reversed.duration, -0)).toBe(false);
  });

  it("falls back to the SDK's own duration pair when an endpoint is unusable", () => {
    const event = convertOk(serverRequestSpan({ endTime: null, duration: SUB_MILLISECOND_PAIR }));

    expect(event.duration).toBe(1.5);
  });

  it('reports an instant when no timing is usable at all', () => {
    // Identity, parentage and attributes are still evidence, so a span with no
    // usable duration is reported as taking approximately no time rather than
    // dropped.
    const event = convertOk(serverRequestSpan({ endTime: null }), makeContext());

    expect(event.duration).toBe(0);
  });

  it('rounds to three decimals, and the rounded value survives JSON', () => {
    // Stored JSON must be stable at microsecond resolution: the same instant
    // has to carry the same digits in a store row, a panel-data response and a
    // test snapshot.
    const start: HrTime = [SPAN_START[0], 0];
    const event = convertOk(
      serverRequestSpan({ startTime: start, endTime: [start[0], 1_234_567] }),
    );

    expect(event.duration).toBe(1.235);

    const roundTripped: unknown = JSON.parse(JSON.stringify(event));
    expect(roundTripped).toMatchObject({
      startTime: event.startTime,
      duration: event.duration,
    });
  });

  it.each([
    { label: 'the epoch itself', startTime: ZERO_PAIR },
    {
      label: 'a relative performance reading expressed as seconds',
      startTime: SUB_MILLISECOND_PAIR,
    },
    {
      label: 'a seconds-precision value one second below the floor',
      startTime: [MIN_EPOCH_MS / 1000 - 1, 0] as HrTime,
    },
    { label: 'a value above the ceiling', startTime: [MAX_EPOCH_MS / 1000 + 1, 0] as HrTime },
  ])('skips a span whose start is $label', ({ startTime }: { startTime: HrTime }) => {
    // Such a value is a bug in the host process rather than evidence: emitting
    // it would either be rejected at ingest or drag the timeline's origin
    // decades away from the capture.
    expect(convert(serverRequestSpan({ startTime }))).toBeNull();
  });

  it.each([
    { label: 'the floor', startTime: [MIN_EPOCH_MS / 1000, 0] as HrTime, expected: MIN_EPOCH_MS },
    { label: 'the ceiling', startTime: [MAX_EPOCH_MS / 1000, 0] as HrTime, expected: MAX_EPOCH_MS },
  ])(
    'accepts a start time exactly at $label',
    ({ startTime, expected }: { startTime: HrTime; expected: number }) => {
      const event = convertOk(serverRequestSpan({ startTime, endTime: startTime }));

      expect(event.startTime).toBe(expected);
      expect(ingressRejection(event)).toBeNull();
    },
  );

  it.each([
    { label: 'a string', startTime: 'not-a-pair' },
    { label: 'a one-member array', startTime: [SPAN_START[0]] },
    { label: 'a pair holding NaN', startTime: [Number.NaN, 0] },
    { label: 'a pair holding Infinity', startTime: [Number.POSITIVE_INFINITY, 0] },
    { label: 'nothing', startTime: undefined },
  ])('skips a span whose start time is $label', ({ startTime }: { startTime: unknown }) => {
    expect(convert(makeSpan({ kind: SpanKind.SERVER }, { startTime }))).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Identity, sequence and the fields the service owns
 * ---------------------------------------------------------------------------
 */

/** The shape `@debuggen/shared`'s generators produce for a product event id. */
const EVENT_ID_PATTERN = new RegExp(`^${ID_PREFIXES.event}_[0-9a-z]{16}$`);

/** Exactly the fields the ingress contract carries, for a span with a parent. */
const INGRESS_KEYS: readonly string[] = [
  'attributes',
  'duration',
  'id',
  'kind',
  'name',
  'parentSpanId',
  'producerId',
  'seq',
  'spanId',
  'startTime',
  'status',
  'tier',
  'traceId',
];

/** The three fields only the service may assign, plus the two it may fill in. */
const SERVICE_OWNED_FIELDS: readonly string[] = [
  'sessionId',
  'captureId',
  'ingestSeq',
  'source',
  'redacted',
];

describe('spanToIngressEvent: identity', () => {
  it('mints a fresh product event id that is not the span id', () => {
    const spanId = newSpanId();
    const event = convertOk(serverRequestSpan({ spanId }));
    const second = convertOk(serverRequestSpan({ spanId }));

    expect(event.id).toMatch(EVENT_ID_PATTERN);
    expect(event.id).not.toBe(spanId);
    expect(event.id).not.toBe(second.id);
  });

  it('carries the span context identifiers through unchanged', () => {
    // `traceId` is never rewritten, normalised or substituted: it is the only
    // thing that joins a browser interaction to the queries it caused.
    const traceId = newTraceId();
    const spanId = newSpanId();
    const parentSpanId = newSpanId();

    const event = convertOk(serverRequestSpan({ traceId, spanId, parentSpanId }));

    expect(event.traceId).toBe(traceId);
    expect(event.spanId).toBe(spanId);
    expect(event.parentSpanId).toBe(parentSpanId);
  });

  it.each([
    { label: 'a trace id that is too short', traceId: '0'.repeat(31) },
    { label: 'a trace id that is too long', traceId: `${'a'.repeat(32)}0` },
    { label: 'an upper-case trace id', traceId: 'A'.repeat(32) },
    { label: 'a trace id outside the hex alphabet', traceId: 'z'.repeat(32) },
    { label: 'the all-zero trace id', traceId: ALL_ZERO_TRACE_ID },
  ])('skips a span with $label', ({ traceId }: { traceId: string }) => {
    // Skipped here rather than rejected at ingest, where the reason would read
    // as a validation issue instead of naming a producer to look at. The
    // all-zero id is refused for a sharper reason: every event carrying it
    // would correlate into one enormous fictitious trace.
    expect(convert(serverRequestSpan({ traceId }))).toBeNull();
  });

  it.each([
    { label: 'a span id that is too short', spanId: '0'.repeat(15) },
    { label: 'an upper-case span id', spanId: 'B'.repeat(16) },
    { label: 'a span id outside the hex alphabet', spanId: 'y'.repeat(16) },
    { label: 'the all-zero span id', spanId: ALL_ZERO_SPAN_ID },
  ])('skips a span with $label', ({ spanId }: { spanId: string }) => {
    expect(convert(serverRequestSpan({ spanId }))).toBeNull();
  });

  it('skips a span whose context cannot be read', () => {
    expect(
      convert(makeSpan({ kind: SpanKind.SERVER }, { spanContext: () => undefined })),
    ).toBeNull();
    expect(convert(makeSpan({ kind: SpanKind.SERVER }, { spanContext: undefined }))).toBeNull();
  });

  it('omits parentSpanId entirely for a trace root', () => {
    // Absence means trace root and is meaningful; the ingress schema is strict
    // about the difference between an absent key and one set to `undefined`.
    const event = convertOk(serverRequestSpan());

    expect(hasKey(event, 'parentSpanId')).toBe(false);
    expect(Object.keys(event)).not.toContain('parentSpanId');
    expect(ingressRejection(event)).toBeNull();
  });

  it.each([
    { label: 'the all-zero span id', parent: ALL_ZERO_SPAN_ID },
    { label: 'a malformed span id', parent: 'not-a-span-id' },
  ])('treats a parent of $label as absent', ({ parent }: { parent: string }) => {
    const event = convertOk(serverRequestSpan({ parentSpanId: parent }));

    expect(hasKey(event, 'parentSpanId')).toBe(false);
  });

  it('treats a self-referential parent as absent', () => {
    // A span naming itself as its own parent would be a cycle in the correlated
    // tree, which no ordering can resolve.
    const spanId = newSpanId();
    const event = convertOk(serverRequestSpan({ spanId, parentSpanId: spanId }));

    expect(hasKey(event, 'parentSpanId')).toBe(false);
  });

  it('emits exactly the ingress field set', () => {
    // The decisive structural assertion: the emitted key set is the contract,
    // and one extra key is a hard rejection at ingest of an event the capture
    // cannot recover.
    const child = convertOk(serverRequestSpan({ parentSpanId: newSpanId() }));
    const root = convertOk(serverRequestSpan());

    expect(Object.keys(child).sort()).toEqual([...INGRESS_KEYS].sort());
    expect(Object.keys(root).sort()).toEqual(
      INGRESS_KEYS.filter((key) => key !== 'parentSpanId').sort(),
    );
  });

  it.each(SERVICE_OWNED_FIELDS)('never sets %s, which the service owns', (field: string) => {
    // Attribution (`sessionId`, `captureId`, `ingestSeq`) is assigned at ingest;
    // `source` is resolved there through the code graph, the route map and
    // recorded patch metadata; `redacted` is the redaction layer's record of
    // its own work. A producer that supplied any of them would be claiming work
    // that had not happened.
    const event = convertOk(dbQuerySpan({ parentSpanId: newSpanId() }));

    expect(hasKey(event, field)).toBe(false);
  });

  it('stamps the producer id the context supplies', () => {
    const event = convertOk(serverRequestSpan(), makeContext({ producerId: FIXED_PRODUCER_ID }));

    expect(event.producerId).toBe(FIXED_PRODUCER_ID);
  });

  it.each([
    { label: 'nothing', producerId: undefined },
    { label: 'an empty string', producerId: '' },
    { label: 'a padded value', producerId: ` ${FIXED_PRODUCER_ID} ` },
  ])(
    "falls back to this process's producer id when the context supplies $label",
    ({ producerId }: { producerId: string | undefined }) => {
      // Falling back rather than skipping is the right failure: the id
      // identifies the process, an unusable one would only be rejected at
      // ingest, and the process's own id is always correct.
      const event = convertOk(serverRequestSpan(), makeContext({ producerId }));

      expect(event.producerId).toBe(PRODUCER_ID);
    },
  );
});

describe('createSeqAllocator', () => {
  it('numbers from zero and strictly increases within one scope', () => {
    const allocator = createSeqAllocator();

    expect([
      allocator.next(CAPTURE_A),
      allocator.next(CAPTURE_A),
      allocator.next(CAPTURE_A),
    ]).toEqual([0, 1, 2]);
  });

  it('restarts at zero whenever the capture changes', () => {
    // `seq` is scoped to `(producerId, captureId)`, so a new capture is a new
    // sequence. Returning to an earlier capture restarts too: the allocator
    // compares against the previous call's scope, which is the documented rule.
    const allocator = createSeqAllocator();

    expect(allocator.next(CAPTURE_A)).toBe(0);
    expect(allocator.next(CAPTURE_A)).toBe(1);
    expect(allocator.next(CAPTURE_B)).toBe(0);
    expect(allocator.next(CAPTURE_A)).toBe(0);
  });

  it('treats no capture as a scope of its own', () => {
    const allocator = createSeqAllocator();

    expect([allocator.next(null), allocator.next(null)]).toEqual([0, 1]);
    expect(allocator.next(CAPTURE_A)).toBe(0);
    expect(allocator.next(null)).toBe(0);
  });
});

describe('spanToIngressEvent: sequence', () => {
  it('numbers successive events of one capture in order', () => {
    const context = makeContext({ captureId: CAPTURE_A });

    expect([
      convertOk(serverRequestSpan(), context).seq,
      convertOk(routeHandlerSpan(), context).seq,
      convertOk(dbQuerySpan(), context).seq,
    ]).toEqual([0, 1, 2]);
  });

  it('restarts the sequence when the capture changes', () => {
    // The regression this pins breaks the correlator's canonical ordering
    // silently: two captures numbered in one sequence look like one producer
    // whose events arrived out of order.
    const allocator = createSeqAllocator();
    const first = makeContext({ captureId: CAPTURE_A, seq: allocator });
    const second = makeContext({ captureId: CAPTURE_B, seq: allocator });

    expect(convertOk(serverRequestSpan(), first).seq).toBe(0);
    expect(convertOk(serverRequestSpan(), first).seq).toBe(1);
    expect(convertOk(serverRequestSpan(), second).seq).toBe(0);
    expect(convertOk(serverRequestSpan(), second).seq).toBe(1);
  });

  it('is not advanced by a span that was skipped', () => {
    // The number is drawn last, after every check that can reject the span, so
    // the sequence has no gap where a span was dropped.
    const context = makeContext({ captureId: CAPTURE_A });

    expect(convertOk(serverRequestSpan(), context).seq).toBe(0);
    expect(convert(makeSpan(), context)).toBeNull();
    expect(convert(serverRequestSpan({ startTime: ZERO_PAIR }), context)).toBeNull();
    expect(convert(serverRequestSpan({ traceId: ALL_ZERO_TRACE_ID }), context)).toBeNull();
    expect(convertOk(serverRequestSpan(), context).seq).toBe(1);
  });

  it("draws from this process's allocator when the context supplies none", () => {
    // One of the two cases that deliberately exercise the module-level counter.
    // A capture id no other case uses makes the first draw a scope change, so
    // the sequence starts from zero here as it does in a fresh process.
    const captureId = `${ID_PREFIXES.capture}_${'c'.repeat(16)}`;
    const context: ConvertContext = { captureId };

    const first = convertOk(serverRequestSpan(), context);
    const second = convertOk(serverRequestSpan(), context);

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(first.seq + 1);
  });

  it('numbers an event emitted outside a capture', () => {
    // `./exporter.ts` drops spans outside a capture before converting them, so
    // `null` arrives here only from a caller that chose to convert anyway - and
    // it is a sequence scope like any other, never a reason to refuse an event.
    const event = convertOk(serverRequestSpan(), makeContext({ captureId: null }));

    expect(event.seq).toBe(0);
    expect(ingressRejection(event)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------------
 */

describe('spanToIngressEvent: status', () => {
  it.each([
    { label: 'unset', code: 0 as const },
    { label: 'ok', code: 1 as const },
    { label: 'error', code: 2 as const },
  ])('maps the $label span status code', ({ code }: { code: 0 | 1 | 2 }) => {
    // Through the table in `../schema/kinds.ts` rather than a local switch, so
    // the lower-case product spellings cannot drift from the ones the schema
    // validates.
    const expected: TelemetryStatus = OTEL_STATUS_CODE_TO_STATUS[code];
    const event = convertOk(serverRequestSpan({ status: { code } }));

    expect(event.status).toBe(expected);
    expect(['unset', 'ok', 'error']).toContain(event.status);
  });

  it("lines up with the SDK's own status codes", () => {
    // The compatibility claim the table rests on: the numeric members of
    // `SpanStatusCode` are the keys of `OTEL_STATUS_CODE_TO_STATUS`, which is
    // what lets the preload index it with a code straight off a span.
    expect(Number(SpanStatusCode.UNSET)).toBe(0);
    expect(Number(SpanStatusCode.OK)).toBe(1);
    expect(Number(SpanStatusCode.ERROR)).toBe(2);
  });

  it.each([
    { label: 'no status member at all', status: null },
    { label: 'a status with no code', status: {} },
  ])('reports $label as unset', ({ status }: { status: { readonly code?: number } | null }) => {
    const event = convertOk(serverRequestSpan({ status }));

    expect(event.status).toBe('unset');
  });

  it('degrades a code outside the vocabulary to unset', () => {
    // A provider reporting something outside the enum must not produce
    // `undefined` where the schema requires a member.
    const event = convertOk(serverRequestSpan({ status: { code: 7 } }));

    expect(event.status).toBe('unset');
    expect(ingressRejection(event)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Attributes
 *
 * Four passes, in a fixed order, so the result depends only on the span's
 * content and never on the order its producer happened to set a key in. What
 * the cases below hold the module to: the declared keys arrive under the
 * product's own spelling, whatever an instrumentation calls them; the privacy
 * bounds apply to everything nobody declared; and no value that cannot be
 * transported ever reaches the bag.
 * ---------------------------------------------------------------------------
 */

/** An attribute value asserted to be a string, narrowed for the assertion. */
function stringAttribute(event: TelemetryEventIngress, key: string): string {
  const value = event.attributes[key];
  expect(typeof value).toBe('string');
  return typeof value === 'string' ? value : '';
}

describe('spanToIngressEvent: attributes', () => {
  it('copies the keys a kind declares under their own spelling', () => {
    const event = convertOk(
      serverRequestSpan({
        attributes: {
          'http.method': REQUEST_METHOD,
          url: REQUEST_ROUTE,
          'http.route': REQUEST_ROUTE,
          'http.status_code': 204,
          'next.route': REQUEST_ROUTE,
          [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.request,
        },
      }),
    );

    expect(event.attributes).toEqual({
      'http.method': REQUEST_METHOD,
      url: REQUEST_ROUTE,
      'http.route': REQUEST_ROUTE,
      'http.status_code': 204,
      'next.route': REQUEST_ROUTE,
      [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.request,
    });
  });

  it.each(ATTRIBUTE_KEY_TRANSLATIONS)(
    'surfaces %s under the product spelling %s',
    (incoming: string, canonical: string) => {
      // The one table that absorbs every difference between what an
      // instrumentation emits and what the product reads. Iterating it is what
      // makes an entry impossible to add without a translation, and the alias
      // is *consumed*: nothing downstream ever sees an instrumentation's own
      // spelling.
      const value = `${incoming}-value`;
      const event = convertOk(functionSpan({ attributes: { [incoming]: value } }));

      expect(event.attributes[canonical]).toBe(value);
      expect(Object.keys(event.attributes)).not.toContain(incoming);
    },
  );

  it('keeps a canonical value when an alias of it is also present', () => {
    // An earlier, more trustworthy pass always wins, so the result is
    // independent of which spelling a producer happened to set first.
    const event = convertOk(
      serverRequestSpan({
        attributes: { 'http.method': REQUEST_METHOD, 'http.request.method': 'POST' },
      }),
    );

    expect(event.attributes['http.method']).toBe(REQUEST_METHOD);
    expect(Object.keys(event.attributes)).not.toContain('http.request.method');
  });

  it('applies the declared precedence between two aliases of one key', () => {
    // Three spellings carry an outgoing target; the table's order is the
    // precedence, and it is what keeps the result deterministic.
    const event = convertOk(
      serverFetchSpan({
        attributes: {
          'http.target': `${OUTGOING_URL}/target`,
          'http.url': `${OUTGOING_URL}/url`,
          'url.full': `${OUTGOING_URL}/full`,
        },
      }),
    );

    expect(event.attributes.url).toBe(`${OUTGOING_URL}/target`);
  });

  it('maps the current HTTP semantic conventions onto the declared spellings', () => {
    const event = convertOk(
      serverRequestSpan({
        attributes: {
          'http.request.method': 'PUT',
          'http.response.status_code': 202,
          'http.target': REQUEST_ROUTE,
        },
      }),
    );

    expect(event.attributes).toMatchObject({
      'http.method': 'PUT',
      'http.status_code': 202,
      url: REQUEST_ROUTE,
    });
  });

  it('maps the current database semantic conventions onto the declared spellings', () => {
    const event = convertOk(
      dbQuerySpan({
        scope: { name: DB_INSTRUMENTATION_SCOPES.driver },
        name: `${DB_SPAN_NAME_PREFIXES.driver}:SELECT ${DB_NAME}`,
        attributes: {
          'db.system.name': DB_SYSTEM,
          'db.query.text': DB_STATEMENT,
          'db.response.returned_rows': 7,
          'db.operation.name': 'SELECT',
          'db.namespace': DB_NAME,
        },
      }),
    );

    expect(event.attributes).toMatchObject({
      'db.system': DB_SYSTEM,
      'db.statement': DB_STATEMENT,
      'db.rowCount': 7,
      'db.operation': 'SELECT',
      'db.name': DB_NAME,
    });
  });

  it('carries a declared statement verbatim rather than cutting it to a preview', () => {
    // The one place the value bounds deliberately do not apply: a statement is
    // the evidence the query table renders, and it is scrubbed and bounded by
    // the redaction layer at ingest instead of being ruined here. It arrives
    // parameterized - `$1` placeholders, never an inline literal.
    const padded = `${DB_STATEMENT}${' -- '.repeat(MAX_PREVIEW_LENGTH)}`;
    const event = convertOk(dbQuerySpan({ attributes: { 'db.statement': padded } }));

    expect(stringAttribute(event, 'db.statement')).toBe(padded);
    expect(stringAttribute(event, 'db.statement').length).toBeGreaterThan(MAX_PREVIEW_LENGTH);
  });

  it('emits no more keys than the tracked bound allows', () => {
    // An attribute nobody declared is an attribute nobody reasoned about, so
    // the pass-through is bounded - and the order is the span's own key order,
    // which is what makes the result deterministic.
    const attributes: Record<string, unknown> = {};
    for (let index = 0; index < MAX_TRACKED_KEYS * 2; index += 1) {
      attributes[`extra_${String(index).padStart(3, '0')}`] = index;
    }

    const event = convertOk(functionSpan({ attributes }));

    expect(Object.keys(event.attributes)).toHaveLength(MAX_TRACKED_KEYS);
    expect(Object.keys(event.attributes)).toEqual(
      Object.keys(attributes).slice(0, MAX_TRACKED_KEYS),
    );
  });

  it('cuts an undeclared string value to the preview bound', () => {
    const event = convertOk(
      functionSpan({ attributes: { extra: 'y'.repeat(MAX_PREVIEW_LENGTH * 3) } }),
    );
    const value = stringAttribute(event, 'extra');

    expect(value).toHaveLength(MAX_PREVIEW_LENGTH);
    expect(value.endsWith('\u2026')).toBe(true);
  });

  it('leaves an undeclared value inside the bound untouched', () => {
    const exact = 'y'.repeat(MAX_PREVIEW_LENGTH);
    const event = convertOk(functionSpan({ attributes: { extra: exact } }));

    expect(stringAttribute(event, 'extra')).toBe(exact);
  });

  it('passes the framework key set through even where no kind declares it', () => {
    // `next.span_name` is part of the framework's own key set. The conversion
    // reads the span's `name` rather than this attribute - the two agree, and
    // `name` is present even when the attribute is not - but the value still
    // travels, because dropping a key a framework set would be inventing
    // absence.
    const event = convertOk(
      routeHandlerSpan({
        attributes: {
          [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.appRouteHandler,
          'next.span_name': `${NEXT_SPAN_NAME_PREFIXES.apiRouteHandler} (app) ${REQUEST_ROUTE}`,
        },
      }),
    );

    expect(stringAttribute(event, 'next.span_name')).toContain(REQUEST_ROUTE);
  });

  it.each(SERVICE_ASSIGNED_ATTRIBUTE_KEYS)(
    'never emits %s, which the service assigns at ingest',
    (key: string) => {
      // `request_key` is an HMAC over the *unredacted* URL under a per-session
      // key that never leaves the store. A producer cannot compute one, and a
      // producer-supplied value would let a page choose which requests are
      // reported as duplicates of each other.
      const event = convertOk(serverRequestSpan({ attributes: { [key]: 'producer-supplied' } }));

      expect(Object.keys(event.attributes)).not.toContain(key);
      expect(attributeKeysFor('http.server')).toContain(key);
    },
  );

  it('drops every value that cannot be transported, and survives a cycle', () => {
    // A fiber, a DOM node or a cyclic structure must never turn one span into a
    // large event or throw inside the conversion; a `bigint` would make
    // `JSON.stringify` throw and fail a whole batch rather than one attribute;
    // and a non-finite number renders as `null`, which would read as a
    // measurement of zero.
    const cyclic: Record<string, unknown> = { label: 'cycle' };
    cyclic.self = cyclic;

    const attributes: Readonly<Record<string, unknown>> = {
      kept: 'value',
      keptNumber: 42,
      keptBoolean: false,
      callback: (): number => 1,
      marker: Symbol('marker'),
      nested: { depth: 1 },
      list: [1, 2, 3],
      cyclic,
      huge: 10n,
      notANumber: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      nothing: undefined,
      empty: null,
    };

    const span = functionSpan({ attributes });
    expect(() => convert(span)).not.toThrow();

    const event = convertOk(functionSpan({ attributes }));

    expect(Object.keys(event.attributes).sort()).toEqual(['kept', 'keptBoolean', 'keptNumber']);
    expect(() => JSON.stringify(event)).not.toThrow();
    expect(ingressRejection(event)).toBeNull();
  });

  it('fills the two route spellings from each other', () => {
    // The framework sets both on a request span but only its own spelling on a
    // handler span, and both are keys the product declares for those kinds, so
    // a consumer that reads either one finds a route.
    const fromNextRoute = convertOk(
      routeHandlerSpan({
        attributes: {
          [NEXT_SPAN_TYPE_ATTRIBUTE]: NEXT_SPAN_TYPES.appRouteHandler,
          'next.route': REQUEST_ROUTE,
        },
      }),
    );
    const fromHttpRoute = convertOk(
      serverRequestSpan({ attributes: { 'http.route': REQUEST_ROUTE } }),
    );

    expect(fromNextRoute.attributes['http.route']).toBe(REQUEST_ROUTE);
    expect(fromHttpRoute.attributes['next.route']).toBe(REQUEST_ROUTE);
  });

  it.each([
    {
      label: 'the ORM',
      scope: DB_INSTRUMENTATION_SCOPES.orm,
      name: `${DB_SPAN_NAME_PREFIXES.orm}client:findMany`,
      client: DB_CLIENT_VALUES.orm,
      operation: 'findMany',
    },
    {
      label: 'the driver',
      scope: DB_INSTRUMENTATION_SCOPES.driver,
      name: `${DB_SPAN_NAME_PREFIXES.driver}:SELECT ${DB_NAME}`,
      client: DB_CLIENT_VALUES.driver,
      operation: 'SELECT',
    },
  ])(
    'derives the producing client and the operation for $label',
    ({
      scope,
      name,
      client,
      operation,
    }: {
      scope: string;
      name: string;
      client: string;
      operation: string;
    }) => {
      // Neither instrumentation reports `db.client`, and a consumer needs it to
      // tell an ORM span from the driver span underneath it instead of counting
      // one query twice. The operation is parsed out of the span name only when
      // the attribute is absent.
      const event = convertOk(
        dbQuerySpan({ scope: { name: scope }, name, attributes: { 'db.statement': DB_STATEMENT } }),
      );

      expect(event.attributes['db.client']).toBe(client);
      expect(event.attributes['db.operation']).toBe(operation);
    },
  );

  it('prefers a reported operation over the one parsed from a span name', () => {
    const event = convertOk(
      dbQuerySpan({
        name: `${DB_SPAN_NAME_PREFIXES.driver}:SELECT ${DB_NAME}`,
        attributes: { 'db.statement': DB_STATEMENT, 'db.operation': 'INSERT' },
      }),
    );

    expect(event.attributes['db.operation']).toBe('INSERT');
  });

  it('derives no operation from a name that carries none', () => {
    const event = convertOk(
      dbQuerySpan({
        scope: { name: DB_INSTRUMENTATION_SCOPES.orm },
        name: DB_SPAN_NAME_PREFIXES.orm,
        attributes: { 'db.statement': DB_STATEMENT },
      }),
    );

    expect(Object.keys(event.attributes)).not.toContain('db.operation');
    expect(event.attributes['db.client']).toBe(DB_CLIENT_VALUES.orm);
  });

  it('describes a failure from the exception it recorded', () => {
    const event = convertOk(serverErrorSpan());

    expect(event.attributes).toMatchObject({
      'error.type': 'SampleError',
      'error.message': 'the operation failed',
      'http.route': REQUEST_ROUTE,
    });
    expect(stringAttribute(event, 'error.stack')).toContain('SampleError');
  });

  it('falls back to the status message when no exception was recorded', () => {
    // The only failure description a span that set a status without recording
    // an exception carries.
    const event = convertOk(serverErrorSpan({ events: [] }));

    expect(event.attributes['error.message']).toBe('the operation failed');
    expect(Object.keys(event.attributes)).not.toContain('error.type');
    expect(Object.keys(event.attributes)).not.toContain('error.stack');
  });

  it('describes a failure whose recorded exception carries nothing usable', () => {
    const event = convertOk(
      serverErrorSpan({ events: [{ name: EXCEPTION_EVENT_NAME, attributes: {} }] }),
    );

    expect(event.attributes['error.message']).toBe('the operation failed');
    expect(ingressRejection(event)).toBeNull();
  });

  it('emits an empty bag for a span that observed nothing else', () => {
    // A producer with nothing to add sends `{}`; the field is required and
    // never defaulted, because a default would be a mutation.
    const event = convertOk(makeSpan({ kind: SpanKind.CLIENT, attributes: {} }));

    expect(event.attributes).toEqual({});
  });
});

/*
 * ---------------------------------------------------------------------------
 * The event name
 *
 * A label, never an identifier: nothing keys off it, and grouping is done on
 * `request_key`, on a normalised statement or on a component attribute.
 * ---------------------------------------------------------------------------
 */

describe('spanToIngressEvent: name', () => {
  it('composes a request label when the display name is still the span type', () => {
    // Before the route is resolved the framework's display name is its own span
    // type, which says nothing to a developer.
    const event = convertOk(
      serverRequestSpan({
        name: NEXT_SPAN_TYPES.request,
        attributes: { 'http.method': REQUEST_METHOD, 'http.route': REQUEST_ROUTE },
      }),
    );

    expect(event.name).toBe(`${REQUEST_METHOD} ${REQUEST_ROUTE}`);
  });

  it.each([
    {
      label: 'the method alone when no route is known',
      attributes: { 'http.method': REQUEST_METHOD },
      expected: REQUEST_METHOD,
    },
    {
      label: 'the route alone when no method is known',
      attributes: { 'http.route': REQUEST_ROUTE },
      expected: REQUEST_ROUTE,
    },
    {
      label: "the framework's own route spelling",
      attributes: { 'next.route': REQUEST_ROUTE },
      expected: REQUEST_ROUTE,
    },
  ])(
    'labels a request with $label',
    ({
      attributes,
      expected,
    }: {
      attributes: Readonly<Record<string, unknown>>;
      expected: string;
    }) => {
      const event = convertOk(serverRequestSpan({ name: NEXT_SPAN_TYPES.request, attributes }));

      expect(event.name).toBe(expected);
    },
  );

  it('keeps a display name the framework has already rewritten', () => {
    const event = convertOk(serverRequestSpan());

    expect(event.name).toBe(`${REQUEST_METHOD} ${REQUEST_ROUTE}`);
  });

  it('labels a function span with the symbol the patch recorded', () => {
    // The name the developer wrote, in preference to whatever the helper called
    // the span.
    const event = convertOk(functionSpan({ name: 'wrapped-call' }));

    expect(event.name).toBe(FUNCTION_SYMBOL);
  });

  it("keeps an instrumentation's own compact query label", () => {
    const event = convertOk(dbQuerySpan());

    expect(event.name).toBe(`${DB_SPAN_NAME_PREFIXES.driver}:SELECT ${DB_NAME}`);
  });

  it.each([
    {
      label: 'its operation and database',
      attributes: {
        'db.statement': DB_STATEMENT,
        'db.operation': 'SELECT',
        'db.name': DB_NAME,
      },
      expected: `SELECT ${DB_NAME}`,
    },
    {
      label: 'its operation alone',
      attributes: { 'db.statement': DB_STATEMENT, 'db.operation': 'UPDATE' },
      expected: 'UPDATE',
    },
    {
      label: 'its system when nothing else is reported',
      attributes: { 'db.system': DB_SYSTEM },
      expected: DB_SYSTEM,
    },
  ])(
    'labels a nameless query span from $label',
    ({
      attributes,
      expected,
    }: {
      attributes: Readonly<Record<string, unknown>>;
      expected: string;
    }) => {
      const event = convertOk(makeSpan({ name: '', attributes }));

      expect(event.name).toBe(expected);
    },
  );

  it('labels a nameless failure with its error type', () => {
    const event = convertOk(serverErrorSpan({ name: '' }));

    expect(event.name).toBe('SampleError');
  });

  it('substitutes the kind when a span carries nothing usable as a label', () => {
    // An event always satisfies the schema's non-empty `name`, whatever the
    // span said.
    const nonString = convertOk(makeSpan({ kind: SpanKind.CLIENT, attributes: {} }, { name: 42 }));
    const empty = convertOk(makeSpan({ kind: SpanKind.SERVER, name: '   ', attributes: {} }));

    expect(nonString.name).toBe('http.client');
    expect(empty.name).toBe('http.server');
  });

  it('cuts a name that would be rejected at ingest', () => {
    // A name over the schema's own bound would cost the capture the whole
    // event, which is a poor trade for a presentation detail.
    const event = convertOk(serverRequestSpan({ name: 'n'.repeat(MAX_EVENT_NAME_LENGTH * 3) }));

    expect(event.name).toHaveLength(MAX_EVENT_NAME_LENGTH);
    expect(event.name.endsWith('\u2026')).toBe(true);
    expect(ingressRejection(event)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The schema round trip, and the failure contract
 *
 * The decisive assertions of the suite. The strict ingress schema - not this
 * file's expectations - is the arbiter of whether an emitted object is legal,
 * and `null` is the only failure the module is permitted, because a throw
 * would travel into the developer's dev-server process.
 * ---------------------------------------------------------------------------
 */

/** One emitted kind, built as the pinned producer actually reports it. */
interface EmittedCase {
  readonly label: string;
  readonly span: () => ReadableSpan;
  readonly kind: TelemetryKind;
  readonly tier: TelemetryTier;
}

const EMITTED_CASES: readonly EmittedCase[] = [
  {
    label: 'an incoming request',
    span: () => serverRequestSpan({ parentSpanId: newSpanId() }),
    kind: 'http.server',
    tier: 'server',
  },
  {
    label: 'a route handler',
    span: () => routeHandlerSpan({ parentSpanId: newSpanId() }),
    kind: 'route.handler',
    tier: 'server',
  },
  {
    label: 'an outgoing request',
    span: () => serverFetchSpan({ parentSpanId: newSpanId() }),
    kind: 'http.client',
    tier: 'server',
  },
  {
    label: 'a patched application function',
    span: () => functionSpan({ parentSpanId: newSpanId() }),
    kind: 'function',
    tier: 'server',
  },
  {
    label: 'a database query',
    span: () => dbQuerySpan({ parentSpanId: newSpanId() }),
    kind: 'db.query',
    tier: 'db',
  },
  {
    label: 'a server-side failure',
    span: () => serverErrorSpan({ parentSpanId: newSpanId() }),
    kind: 'server.error',
    tier: 'server',
  },
];

describe('spanToIngressEvent: the ingress contract', () => {
  it.each(EMITTED_CASES)(
    'emits $label as a valid $kind event on the $tier tier',
    ({ span, kind, tier }: EmittedCase) => {
      const event = convertOk(span());

      expect(event.kind).toBe(kind);
      expect(event.tier).toBe(tier);
      expect(isTierAllowedForKind(event.kind, event.tier)).toBe(true);
      // The assertion no hand-written field expectation can replace: an extra
      // key, a missing one or a wrong type is a rejection here.
      expect(ingressRejection(event)).toBeNull();
    },
  );

  it('covers every kind the module can emit', () => {
    // Keeps the round trip exhaustive: a kind the classifier learns to produce
    // must join this table, or this assertion fails.
    expect([...new Set(EMITTED_CASES.map((testCase) => testCase.kind))].sort()).toEqual([
      'db.query',
      'function',
      'http.client',
      'http.server',
      'route.handler',
      'server.error',
    ]);
  });

  it('never reports a Node-produced event on the browser tier', () => {
    for (const testCase of EMITTED_CASES) {
      expect(convertOk(testCase.span()).tier).not.toBe('browser');
    }
  });
});

/** A span shape the module promises to answer rather than raise on. */
interface HostileCase {
  readonly label: string;
  readonly span: () => ReadableSpan;
}

const HOSTILE_CASES: readonly HostileCase[] = [
  {
    label: 'no attribute bag',
    span: () => makeSpan({ kind: SpanKind.SERVER }, { attributes: undefined }),
  },
  {
    label: 'an attribute bag that is an array',
    span: () => makeSpan({ kind: SpanKind.SERVER }, { attributes: [] }),
  },
  {
    label: 'an attribute bag that is a string',
    span: () => makeSpan({ kind: SpanKind.SERVER }, { attributes: 'nope' }),
  },
  { label: 'no status member', span: () => serverRequestSpan({ status: null }) },
  { label: 'no instrumentation scope', span: () => serverRequestSpan({ scope: null }) },
  { label: 'a non-string scope name', span: () => serverRequestSpan({ scope: { name: {} } }) },
  { label: 'a non-string name', span: () => makeSpan({ kind: SpanKind.SERVER }, { name: 42 }) },
  {
    label: 'events that are not an array',
    span: () =>
      makeSpan({ kind: SpanKind.INTERNAL, status: { code: SpanStatusCode.ERROR } }, { events: 7 }),
  },
  {
    label: 'a span event that is not an object',
    span: () =>
      makeSpan(
        { kind: SpanKind.INTERNAL, status: { code: SpanStatusCode.ERROR } },
        { events: [null, 'nope'] },
      ),
  },
  {
    label: 'a span event whose attributes are not an object',
    span: () => serverErrorSpan({ events: [{ name: EXCEPTION_EVENT_NAME, attributes: 'nope' }] }),
  },
  {
    label: 'a span context that answers nothing',
    span: () => makeSpan({ kind: SpanKind.SERVER }, { spanContext: () => undefined }),
  },
  {
    label: 'a span context that is not a function',
    span: () => makeSpan({ kind: SpanKind.SERVER }, { spanContext: { traceId: newTraceId() } }),
  },
  {
    label: 'a parent span context that is not an object',
    span: () => makeSpan({ kind: SpanKind.SERVER }, { parentSpanContext: 'nope' }),
  },
  {
    label: 'a throwing name accessor',
    span: () => makeSpanWithThrowingMember('name', { kind: SpanKind.SERVER }),
  },
  {
    label: 'a throwing attributes accessor',
    span: () => makeSpanWithThrowingMember('attributes', { kind: SpanKind.SERVER }),
  },
  {
    label: 'a throwing span-context accessor',
    span: () => makeSpanWithThrowingMember('spanContext', { kind: SpanKind.SERVER }),
  },
  {
    label: 'a throwing status accessor',
    span: () => makeSpanWithThrowingMember('status', { kind: SpanKind.SERVER }),
  },
  {
    label: 'a throwing instrumentation-scope accessor',
    span: () => makeSpanWithThrowingMember('instrumentationScope', { kind: SpanKind.SERVER }),
  },
  { label: 'nothing at all', span: () => asReadableSpan({}) },
];

describe('spanToIngressEvent: the failure contract', () => {
  it.each(HOSTILE_CASES)('answers a span with $label without throwing', ({ span }: HostileCase) => {
    // A span reaching the host process's pipeline may come from any third-party
    // instrumentation and have any shape. AAP 0.5.1's "the application keeps
    // serving" guarantee makes a throw unacceptable, so a surprise is a skip -
    // and whatever *is* emitted must still satisfy the schema.
    const built = span();

    expect(() => classifySpan(built)).not.toThrow();
    expect(() => isEmittableSpan(built)).not.toThrow();
    expect(() => convert(built)).not.toThrow();

    const event = convert(built);
    if (event !== null) {
      expect(ingressRejection(event)).toBeNull();
    }
  });

  it('refuses a span whose kind and tier the vocabulary would reject', () => {
    // Unreachable through the classifier - every pair it returns is asserted
    // legal above - and checked anyway, because a mis-tiered event would move
    // time between the per-tier durations undetectably. The assertion that
    // stands in for it here is the schema's: the same rule, enforced at ingest.
    const event = convertOk(dbQuerySpan());
    const mistiered: unknown = { ...event, tier: 'browser' };

    expect(isErr(parseTelemetryEventIngress(mistiered))).toBe(true);
  });

  it('is not a leak path for captured data when validation fails', () => {
    // The privacy rule of AAP 0.5.2 applied to a rejection: an error raised
    // this deep passes through neither the redaction layer nor the outbound
    // model guard, yet it is logged, may be persisted with the session and may
    // be rendered in both user interfaces. `packages/telemetry/src/schema/
    // event.test.ts` pins the behaviour; this case documents that a converted
    // event cannot smuggle a value into one.
    const event = convertOk(
      dbQuerySpan({
        attributes: { 'db.statement': `${DB_STATEMENT} -- ${LEAK_SENTINEL}` },
      }),
    );
    const rejected: unknown = { ...event, startTime: 0 };
    const parsed = parseTelemetryEventIngress(rejected);

    expect(isErr(parsed)).toBe(true);
    if (isErr(parsed)) {
      const payload = JSON.stringify(parsed.error.toPayload());

      expect(parsed.error.message).not.toContain(LEAK_SENTINEL);
      expect(parsed.error.hint ?? '').not.toContain(LEAK_SENTINEL);
      expect(JSON.stringify(parsed.error.details)).not.toContain(LEAK_SENTINEL);
      expect(payload).not.toContain(LEAK_SENTINEL);
      expect(payload).not.toContain('"received"');
      expect(payload).not.toContain('"input"');
    }
  });
});
