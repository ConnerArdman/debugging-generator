/**
 * The telemetry event: **the one and only definition** of what a runtime
 * observation looks like in this monorepo.
 *
 * AAP 0.2.3 fixes the field list below and AAP 0.9.1 lists
 * `packages/telemetry/src/schema/**` among the single-definition schema
 * sources, with the consequence stated plainly: *any second definition of
 * these shapes in an app is a defect*. Five processes describe runtime
 * evidence with the two schemas declared here — the MAIN-world page agent, the
 * dev-server Node preload, the Chrome service worker, the local service's
 * ingest/store/aggregate path and the panel renderer — so a re-declared union
 * or a hand-written copy in a consumer does not fail loudly; it drifts, and
 * silently mis-attributes evidence.
 *
 * ## Two schemas, one core
 *
 * The producer's event and the stored event differ by exactly three fields,
 * and the boundary between them is an ownership rule rather than a
 * convenience:
 *
 * - {@link telemetryEventIngressSchema} / {@link TelemetryEventIngress} — what
 *   **every** producer sends, browser agent and Node preload alike. It carries
 *   no session, capture or ingest field, because a producer does not know
 *   which session it is serving: the browser agent is armed per tab and the
 *   preload per process.
 * - {@link telemetryEventSchema} / {@link TelemetryEvent} — what the store
 *   holds **after attribution**. `apps/local-service/src/telemetry/attribute.ts`
 *   adds `sessionId` and `captureId` from the tab binding and the active
 *   capture window, and the store assigns `ingestSeq`.
 *
 * Both are built from one shape record, so "sharing a core" is structurally
 * true here rather than a comment that has to be believed: the persisted
 * schema's keys are the ingress schema's keys plus exactly `sessionId`,
 * `captureId` and `ingestSeq`, and the sibling `event.test.ts` proves that
 * mechanically from `.shape` instead of restating a key list.
 *
 * ## Both schemas are strict
 *
 * An unknown **top-level** key is a rejection, not a stripped property. A
 * producer and the service that ingests it are separate builds that a
 * developer can update independently, so an unrecognised field means a
 * version mismatch — worth failing at ingest, where one malformed event is
 * skipped and reported, rather than at read time, where a missing field looks
 * like missing evidence. Per-kind extensibility lives in the open
 * `attributes` record instead, whose keys are declared (not whitelisted) in
 * `./attributes.ts`.
 *
 * The useful corollary: strictness is what makes a producer that supplies
 * `sessionId`, `captureId` or `ingestSeq` a **rejection** rather than a silent
 * strip. Attribution is the service's job alone, and a producer that thinks
 * otherwise is a bug to be found.
 *
 * ## The canonical time base
 *
 * `startTime` is Unix epoch **milliseconds as a double** with sub-millisecond
 * precision, and `duration` is milliseconds. Never integers — a truncated
 * render duration is the difference between "this component re-rendered 300
 * times for 0 ms" and a real measurement. Only two helpers from
 * `@debuggen/shared` are sanctioned producers of the value:
 * `performanceToEpochMs()` in the browser (`performance.timeOrigin +
 * entry.startTime`) and `hrTimeToEpochMs()` in the preload, called from
 * `../node/convert.ts`. Both producers run on the developer's own machine, so
 * no clock alignment is applied beyond an informational per-producer
 * `clockOffsetMs` that the service records elsewhere.
 *
 * ## Ordering, and where it is implemented
 *
 * `seq` is a per-producer monotonic counter scoped to
 * `(producerId, captureId)` — it is *not* globally unique and must never be
 * used for ordering on its own. Canonical ordering within a trace is:
 * parent before child, then `startTime`, then `(producerId, seq)`, then
 * `ingestSeq` as the final, always-distinct tie-breaker. This module
 * documents that contract and deliberately does **not** implement it: the
 * comparator belongs to `../correlation/correlator.ts`, where
 * parent-before-child is a tree operation, and its test covers mixed
 * browser/Node inputs with equal timestamps. One comparator, one place.
 *
 * ## Validation only — never mutation
 *
 * There is no `.transform()`, no `.coerce`, no `.default()` and no `.catch()`
 * anywhere in this file, and none may be added. Parsing a valid event returns
 * an object deep-equal to its input, which is what lets the service persist
 * exactly what a producer observed rather than a normalised retelling of it.
 * A producer with no attributes sends `{}`; the schema does not invent one.
 *
 * ## Importing this module from the browser subtree
 *
 * `zod` is confined to this file within `src/schema/` — `./kinds.ts` and
 * `./attributes.ts` are dependency-free precisely so the page agent can share
 * their vocabularies, and `esbuild.agent.mjs` hard-fails the agent bundle if
 * any input resolves to a schema library. Files under `src/browser/**`
 * therefore must import event types with a **top-level `import type`**:
 *
 * ```ts
 * import type { TelemetryEventIngress } from '../schema/event.js';
 * ```
 *
 * Under `verbatimModuleSyntax` an inline `import { type TelemetryEventIngress }`
 * keeps the import *statement* alive in the emitted JavaScript, which would
 * drag zod into the page bundle and fail that build.
 *
 * ## Consumers
 *
 * `@debuggen/protocol` (the `telemetry.event` payload embeds
 * {@link TelemetryEventIngress}), `packages/panel-schema` (the node catalog's
 * `reads` references), `packages/panel-renderer` (types only),
 * `apps/local-service` (`telemetry/ingest.ts`, `attribute.ts`, `correlate.ts`,
 * the store and `panels/data.ts`), and inside this package
 * `../redaction/**`, `../correlation/**`, `../aggregate/**`, `../browser/**`
 * (types only) and `../node/**`.
 *
 * ## What this module does not own
 *
 * So that nobody duplicates it: `EventRef`, `Fact` and `Hypothesis` belong to
 * `packages/panel-schema`; `CaptureSummary`, the metric ids and the
 * `DataResult` shapes belong to `../aggregate/**`; `HrTime` and every time
 * conversion belong to `@debuggen/shared`; `SourceLocation` belongs to
 * `@debuggen/shared` and is embedded here, never restated; the kind, tier and
 * status vocabularies and the kind/tier table belong to `./kinds.ts`; the
 * attribute-key catalog belongs to `./attributes.ts`; and the ordering
 * comparator belongs to `../correlation/correlator.ts`.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

import {
  DebuggenError,
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  err,
  ok,
  sourceLocationSchema,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import {
  TELEMETRY_KINDS,
  TELEMETRY_STATUSES,
  TELEMETRY_TIERS,
  allowedTiersFor,
  isTelemetryKind,
  isTelemetryTier,
  isTierAllowedForKind,
} from './kinds.js';
import type { TelemetryKind, TelemetryTier } from './kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Bounds
 *
 * Every bound below is a documented decision rather than a defensive guess,
 * because each one can reject a real observation. They are exported where a
 * consumer or a test has a legitimate reason to know the number.
 * ---------------------------------------------------------------------------
 */

/**
 * The earliest `startTime` a well-formed producer can report:
 * `1_577_836_800_000`, which is 2020-01-01T00:00:00Z.
 *
 * This is not a guard against old data — there is none to have, since a
 * capture is minutes old at most. It exists to reject two whole classes of
 * producer bug that would otherwise corrupt every timeline **silently**,
 * because both produce a perfectly valid number:
 *
 * - a relative `performance.now()` value (order 1e3–1e7), which happens when
 *   a browser-side producer forgets `performance.timeOrigin`. Such an event
 *   would sort before every correctly stamped event in the capture and drag
 *   the timeline's origin back fifty years.
 * - a **seconds**-precision epoch value (order 1.7e9), which happens when a
 *   server-side producer passes a Unix timestamp straight through. Such an
 *   event would land in 1970 and its duration would be meaningless against
 *   its siblings.
 *
 * Use `performanceToEpochMs()` (browser) or `hrTimeToEpochMs()` (Node preload)
 * from `@debuggen/shared` and neither mistake is possible.
 */
export const MIN_EPOCH_MS = 1_577_836_800_000;

/**
 * The latest `startTime` a well-formed producer can report:
 * `4_102_444_800_000`, which is 2100-01-01T00:00:00Z.
 *
 * The mirror image of {@link MIN_EPOCH_MS}: it rejects microsecond-scale
 * (order 1e15) and nanosecond-scale (order 1e18) timestamps, which is what
 * arrives when a producer forwards an OpenTelemetry high-resolution value
 * without converting it. Such an event would sit millennia to the right of
 * the capture and stretch every relative offset the timeline computes to
 * nothing.
 *
 * The far bound is deliberately generous. A schema that rejected "next year"
 * would break on a developer whose machine clock is wrong, and a wrong clock
 * is a diagnosable annoyance rather than the silent corruption above.
 */
export const MAX_EPOCH_MS = 4_102_444_800_000;

/**
 * The longest an identifier field (`id`, `producerId`, `sessionId`,
 * `captureId`) may be.
 *
 * Every identifier the product generates is 20 characters
 * (`<three letters>_<sixteen alphanumerics>`, see `ID_PREFIXES` in
 * `@debuggen/shared`), so 64 is roomy enough for a future scheme and tight
 * enough that a stray blob of page data cannot arrive in an id field and be
 * persisted as a store key.
 *
 * Deliberately **no format check**. `@debuggen/shared`'s `ids.ts` exports
 * patterns for trace and span ids only; the opaque `evt_…` shape is asserted
 * in *that package's* tests and is not published as a regular expression, so
 * there is nothing to import and nothing may be invented here — a local copy
 * of that pattern is exactly the duplicate definition this file exists to
 * prevent.
 */
const MAX_IDENTIFIER_LENGTH = 64;

/**
 * The longest `name` a producer may report.
 *
 * Span names come from framework spans, component display names and route
 * templates, all of which are short; 512 leaves room for a deeply qualified
 * name while keeping a stored row small and making it impossible for a name
 * field to become a smuggling channel for page content.
 */
const MAX_NAME_LENGTH = 512;

/*
 * ---------------------------------------------------------------------------
 * Field-schema helpers
 *
 * Declared as small factories so that four identifier fields and two hex-id
 * fields cannot drift apart, and so that every message states an
 * *expectation* and never a received value (the privacy rule below).
 * ---------------------------------------------------------------------------
 */

/**
 * The failure message every identifier field reports.
 *
 * One string for all three checks (non-empty, bounded, already trimmed): a
 * producer reading it needs to know what an identifier must look like, not
 * which of the three bounds it missed, and one message means the value can
 * never be echoed back by accident.
 */
const IDENTIFIER_EXPECTATION = `expected a non-empty identifier of at most ${String(
  MAX_IDENTIFIER_LENGTH,
)} characters with no leading or trailing whitespace`;

/**
 * An opaque identifier field: non-empty, bounded, and free of surrounding
 * whitespace.
 *
 * Whitespace is rejected rather than trimmed. Trimming is a transform, and a
 * transform in these schemas would break the "parse returns its input"
 * invariant that lets the service persist exactly what it received — so a
 * padded id is a producer bug that gets reported instead of repaired.
 */
function opaqueIdentifier(): z.ZodString {
  return z
    .string()
    .min(1, { error: IDENTIFIER_EXPECTATION })
    .max(MAX_IDENTIFIER_LENGTH, { error: IDENTIFIER_EXPECTATION })
    .refine((value) => value.trim().length === value.length, {
      error: IDENTIFIER_EXPECTATION,
    });
}

/**
 * A hexadecimal correlation id field, validated against a pattern owned by
 * `@debuggen/shared`.
 *
 * @param pattern `TRACE_ID_PATTERN` or `SPAN_ID_PATTERN` — never a locally
 * written regular expression.
 * @param expectation What a well-formed value looks like, stated without
 * reference to what arrived.
 */
function hexIdentifier(pattern: RegExp, expectation: string): z.ZodString {
  return z.string().regex(pattern, { error: expectation });
}

/** What a `traceId` must look like, for the failure message. */
const TRACE_ID_EXPECTATION = 'expected 32 lowercase hex characters';

/** What a `spanId` and a `parentSpanId` must look like, for the message. */
const SPAN_ID_EXPECTATION = 'expected 16 lowercase hex characters';

/**
 * What an attribute *value* must be, for the failure message.
 *
 * Phrased as the rule rather than as the offending key's content, which must
 * never appear in an error raised here (see the privacy note on
 * {@link parseTelemetryEvent}).
 */
const ATTRIBUTE_VALUE_EXPECTATION =
  'expected a JSON-serialisable attribute value: a function or a symbol cannot be transported';

/**
 * Rejects top-level attribute values that cannot survive the journey.
 *
 * **Shallow by design, and the reason matters.** The check is O(keys), visits
 * each value once and never descends, so:
 *
 * - it costs nothing on the ingest hot path, where a capture delivers
 *   thousands of events in batches;
 * - it is cycle-safe. A recursive validator handed `{ self: <itself> }` —
 *   which a producer bug can easily construct from a React fiber or a DOM
 *   node — would recurse without bound and take the service's ingest loop
 *   with it.
 *
 * The full invariant, *"attribute values are JSON-serialisable primitives or
 * plain structures"*, is therefore **documented** here and **enforced** where
 * values are produced and cleaned: `../browser/fiber-diff.ts` summarises DOM
 * nodes, functions and cyclic objects instead of serialising them (see
 * `AttributeValueSummary` in `./attributes.ts`), and
 * `../redaction/redactor.ts` walks and scrubs the bag at ingest. What this
 * check catches is the one mistake those two cannot: a producer that assigned
 * a live callback or a symbol straight onto the bag, which would either throw
 * inside `JSON.stringify` at the transport boundary or, worse, serialise to
 * `undefined` and silently disappear.
 *
 * Issues are reported on the offending key's path — structure, never
 * content — and every offending key in one bag is reported at once.
 */
function checkAttributeValuesAreTransportable(
  payload: z.core.ParsePayload<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(payload.value)) {
    const valueType = typeof value;
    if (valueType !== 'function' && valueType !== 'symbol') {
      continue;
    }

    payload.issues.push({
      code: 'custom',
      path: [key],
      message: ATTRIBUTE_VALUE_EXPECTATION,
      // The raw issue's `input` is deliberately left empty rather than set to
      // the rejected value: zod strips it from a finalized issue anyway (no
      // `reportInput` is ever passed), and an attribute value is exactly the
      // kind of captured data that must not travel inside an error.
      input: undefined,
    });
  }
}

/**
 * The `attributes` bag: an open record of JSON-shaped values.
 *
 * Open on purpose. `./attributes.ts` declares the keys each kind is
 * *expected* to carry and is explicitly **not** a whitelist — an unknown
 * attribute key is well-formed, which is what lets a new signal ship without
 * a schema change and lets the redactor handle keys it has never seen. Key
 * *names* are therefore not validated here at all; in particular
 * `request_key` is computed and overwritten by the service at ingest, so
 * rejecting a producer-supplied one would contradict that contract.
 */
const telemetryAttributesSchema = z
  .record(z.string(), z.unknown())
  .check(checkAttributeValuesAreTransportable);

/*
 * ---------------------------------------------------------------------------
 * The shared core
 *
 * One record, one schema per field, consumed by both exported schemas below.
 * It stays module-internal: `.check()` preserves `.shape` on the result, so a
 * consumer or a test that needs the key set reads it from the schema itself
 * and there is no second surface to keep in step.
 * ---------------------------------------------------------------------------
 */

const telemetryEventCoreShape = {
  /**
   * The event's own identifier, minted by its producer (`newEventId()` in
   * `@debuggen/shared`, an `evt_…` value).
   *
   * Unique per event and used as the primary key of the `telemetry_events`
   * row and as the evidence reference a generated panel's facts cite, which
   * is why it is the producer's responsibility rather than the store's: a
   * panel must be able to point at an event the store already holds.
   */
  id: opaqueIdentifier(),

  /**
   * The correlation id shared by every event of one interaction, across all
   * three tiers: 32 lowercase hex characters.
   *
   * W3C Trace Context compatible by construction — `newTraceId()` in
   * `@debuggen/shared` produces 16 random bytes as hex and never all-zero, so
   * the value serialises straight into the `traceparent` header the browser
   * agent injects on same-origin requests. That header is the only thing that
   * joins a click to the route handler and database queries it caused, which
   * is why the format is validated against the pattern that package owns
   * rather than against a copy written here.
   */
  traceId: hexIdentifier(TRACE_ID_PATTERN, TRACE_ID_EXPECTATION),

  /**
   * This event's own span id: 16 lowercase hex characters, from
   * `newSpanId()`.
   *
   * Unique within its trace, and the value a child event names as its
   * `parentSpanId`. For a `fetch` event it is additionally the span id the
   * agent writes into the outgoing `traceparent`, which is how the server's
   * request span becomes this event's child.
   */
  spanId: hexIdentifier(SPAN_ID_PATTERN, SPAN_ID_EXPECTATION),

  /**
   * The span id of the operation that caused this one, when there is one.
   *
   * **Absent means trace root** — the interaction that started everything, or
   * a navigation. Absence is therefore meaningful and is never filled in with
   * a placeholder.
   *
   * A parent that never arrived is not an error either: the correlator
   * attaches such an event to the trace root and marks it with the `orphaned`
   * and `orphanedParentSpanId` attributes (AAP 0.4.2, and see
   * `CORRELATION_ATTRIBUTE_KEYS` in `./attributes.ts`) rather than dropping
   * it, because dropping an event silently removes all the work underneath it
   * from every duration in the capture.
   */
  parentSpanId: hexIdentifier(SPAN_ID_PATTERN, SPAN_ID_EXPECTATION).optional(),

  /**
   * What kind of operation this event describes, from the closed vocabulary in
   * `./kinds.ts`.
   *
   * Validated against the tuple directly, so the accepted set can never drift
   * from the one the page agent, the preload, the aggregates and the panel
   * catalog share. The inferred member type is exactly `TelemetryKind`.
   */
  kind: z.enum(TELEMETRY_KINDS),

  /**
   * The human-readable span name, as a developer would recognise it.
   *
   * Producer-supplied and displayed verbatim in timelines, tables and the
   * event log — for example `'click button'` for an interaction or
   * `'POST /api/example'` for a request. It is a label, not an identifier:
   * nothing keys off it, and grouping is done on `request_key`, on a
   * normalised statement or on a component attribute instead.
   */
  name: z.string().min(1).max(MAX_NAME_LENGTH),

  /**
   * When the operation started: Unix epoch **milliseconds as a double**, with
   * sub-millisecond precision preserved.
   *
   * Never an integer — see the module documentation for the time base and for
   * the two sanctioned producers of this value. The bounds
   * {@link MIN_EPOCH_MS} and {@link MAX_EPOCH_MS} reject the unit mistakes
   * that would otherwise pass validation and corrupt every relative offset in
   * the capture.
   */
  startTime: z
    .number()
    .min(MIN_EPOCH_MS, {
      error:
        'expected startTime in Unix epoch milliseconds (a relative performance timestamp or a seconds-precision epoch value is too small)',
    })
    .max(MAX_EPOCH_MS, {
      error:
        'expected startTime in Unix epoch milliseconds (a microsecond- or nanosecond-scale timestamp is too large)',
    }),

  /**
   * How long the operation took, in **milliseconds**, fractional allowed.
   *
   * Zero is legal and common: an `error`, a `state` transition and a `log`
   * record are instants, not intervals.
   *
   * Deliberately **no upper bound**. A slow request is precisely the evidence
   * this product exists to surface, so a ceiling here could only discard the
   * finding the developer asked about — do not "fix" this by adding one. The
   * only rejections are a negative value (which no clock produces and which
   * would invert a waterfall row) and the non-finite values `z.number()`
   * already refuses.
   */
  duration: z.number().min(0, {
    error: 'expected a duration in milliseconds of zero or more',
  }),

  /**
   * Which tier produced the event: `browser`, `server` or `db`.
   *
   * A property of the producer, not of the name of the span, and required on
   * every event because the per-tier metrics (`frontend_duration`,
   * `backend_duration`, `database_duration`) and the timeline's lanes are
   * computed from it. Its agreement with `kind` is enforced by the cross-field
   * check below.
   */
  tier: z.enum(TELEMETRY_TIERS),

  /**
   * Everything else this event observed, as an open bag of JSON-shaped
   * values.
   *
   * **Required.** A producer with nothing to add sends `{}`; there is no
   * `.default()`, because a default is a mutation and these schemas never
   * mutate. The keys each kind is expected to carry are declared in
   * `./attributes.ts`.
   */
  attributes: telemetryAttributesSchema,

  /**
   * Whether the operation succeeded: `unset`, `ok` or `error`.
   *
   * The lower-case mirror of the OpenTelemetry span status codes. Error
   * *detail* — type, message, stack — is not here: it travels in the
   * `error.*` attribute keys declared in `./attributes.ts`, which keeps this
   * field directly filterable and the row small.
   */
  status: z.enum(TELEMETRY_STATUSES),

  /**
   * Which producer emitted the event: a random id generated **once per page
   * document** by the browser agent (so a reload yields a new one) and **once
   * per process** by the Node preload.
   *
   * It exists for two jobs that nothing else can do. It scopes `seq`, since
   * two independent counters both starting at zero are otherwise
   * indistinguishable; and it disambiguates identical timestamps across
   * producers, which is what makes `(producerId, seq)` a usable tie-breaker in
   * the canonical ordering.
   */
  producerId: opaqueIdentifier(),

  /**
   * A per-producer monotonic counter, scoped to `(producerId, captureId)`.
   *
   * Zero-based, and it records the order in which one producer *emitted* its
   * events — which is finer-grained than its timestamps, because two events
   * can share a millisecond.
   *
   * **Not globally unique, and never an ordering key on its own.** Two
   * producers, or one producer across two captures, both emit a `seq` of `0`.
   * Ordering uses the full sequence documented on the module and implemented
   * in `../correlation/correlator.ts`.
   */
  seq: z.int().nonnegative({
    error: 'expected a zero-based per-producer sequence number',
  }),

  /**
   * Where in the developer's project this event came from, when a resolver
   * could say.
   *
   * The one shape defined by `@debuggen/shared`'s `sourceLocationSchema` and
   * embedded — never restated — here. Four routes can populate it (AAP 0.2.3):
   * the metadata a reversible patch recorded when it wrapped a function, the
   * code graph (component display name, route path, query call site), a source
   * map for a generated chunk, and a selected element's React owner chain.
   * Its presence is what makes a runtime item clickable through to VS Code, so
   * a resolver that cannot commit to a location omits the field rather than
   * guessing at one.
   */
  source: sourceLocationSchema.optional(),

  /**
   * The attribute paths whose values the redactor replaced, when any were.
   *
   * Absence means nothing was redacted — which is why the field is optional
   * rather than defaulted to `[]`.
   *
   * **Only `../redaction/redactor.ts` sets this, and producers never do.** It
   * is the record of what the privacy layer did, so a value arriving from a
   * producer would be a claim about work that had not happened yet. The
   * redaction subtree implements to this contract; a consumer reads it to show
   * a developer that a value is missing by policy rather than by accident.
   */
  redacted: z.array(z.string().min(1, { error: 'expected a non-empty attribute path' })).optional(),
};

/*
 * ---------------------------------------------------------------------------
 * The persisted extension
 *
 * Exactly three fields, all assigned by the service. A producer that sends
 * any of them is rejected by the strict ingress schema, which is the intended
 * outcome: attribution is the service's job alone.
 * ---------------------------------------------------------------------------
 */

const telemetryEventPersistedShape = {
  /**
   * The session this event belongs to.
   *
   * Assigned by `apps/local-service/src/telemetry/attribute.ts` at ingest,
   * from the tab binding for browser events and from the project root and
   * active capture window for server and database events. Producers never
   * send it — the browser agent is armed per tab and the preload runs per
   * process, so neither one knows which session it is serving.
   */
  sessionId: opaqueIdentifier(),

  /**
   * The capture window this event was recorded in.
   *
   * **Required, because every persisted event belongs to a capture.** Outside
   * one, the browser agent's hooks are all false and the Node preload drops
   * every span (AAP 0.5.1, 0.7.1), so an event with no capture is not a
   * partially attributed event — it is one that should never have been
   * ingested. The `telemetry_events` table carries the column for the same
   * reason: a follow-up question is answered from a stored capture.
   */
  captureId: opaqueIdentifier(),

  /**
   * The store's own monotonically increasing arrival number, assigned when the
   * row is written.
   *
   * One-based, so `0` is rejected: a persisted event always has a predecessor
   * count, and zero would read as "not yet assigned".
   *
   * Its role is precise. Canonical ordering within a trace is parent before
   * child, then `startTime`, then `(producerId, seq)`, then **`ingestSeq` as
   * the final, always-distinct tie-breaker** (AAP 0.2.3) — the one key that
   * can never tie, which is what makes the order total and therefore
   * reproducible between a timeline, a waterfall and an exported trace. The
   * comparator itself lives in `../correlation/correlator.ts`; this module
   * states the contract and implements none of it, so no second comparator can
   * appear.
   */
  ingestSeq: z.int().positive({
    error: 'expected a one-based store-assigned ingest sequence number',
  }),
};

/*
 * ---------------------------------------------------------------------------
 * Kind/tier agreement
 *
 * The one cross-field rule, applied identically to both schemas through the
 * same function so the two can never disagree about it.
 * ---------------------------------------------------------------------------
 */

/**
 * Renders a tier list for a failure message: `'browser'`, or
 * `'browser or server'` for the cross-tier kinds.
 */
function formatTierList(tiers: readonly TelemetryTier[]): string {
  return tiers.join(' or ');
}

/**
 * Rejects an event whose `tier` is not a tier its `kind` may be reported in.
 *
 * The permitted pairs live in `KIND_ALLOWED_TIERS` (`./kinds.ts`), which is
 * the single place in the monorepo that says which tier a kind belongs to.
 * This check is the only thing standing between a producer that mislabelled
 * itself and a per-tier duration that silently does not add up: a `db.query`
 * reported on `browser` would subtract from `database_duration` and add to
 * `frontend_duration`, and every number in the generated panel would be
 * wrong in a way no reader could detect.
 *
 * **Maintenance rule:** a producer that legitimately needs another tier for a
 * kind is fixed by *widening* `KIND_ALLOWED_TIERS` — with a note saying
 * why — never by weakening this check.
 *
 * The issue is reported on the `tier` path and names the kind and the tiers
 * it allows, and nothing else: no received value appears in it.
 */
function checkKindTierAgreement(
  payload: z.core.ParsePayload<{ kind: TelemetryKind; tier: TelemetryTier }>,
): void {
  const { kind, tier } = payload.value;

  // Defensive, and cheap. Zod runs an object's checks only once its fields
  // have parsed, so `kind` and `tier` are vocabulary members by the time this
  // runs and the lookup below is total. Should that ordering ever change, an
  // out-of-vocabulary `kind` would make the lookup `undefined` and throw a
  // TypeError inside the service's ingest loop - and AAP 0.5.5 requires that
  // one malformed event never crash it. The field schemas have already
  // reported such a value, so there is nothing to add here.
  if (!isTelemetryKind(kind) || !isTelemetryTier(tier)) {
    return;
  }

  if (isTierAllowedForKind(kind, tier)) {
    return;
  }

  payload.issues.push({
    code: 'custom',
    path: ['tier'],
    message: `expected kind "${kind}" to be reported on tier ${formatTierList(
      allowedTiersFor(kind),
    )}`,
    // Left empty on purpose: zod strips a finalized issue's `input` unless a
    // parse context asks for it, and an event that failed validation may carry
    // captured data that must not travel inside an error.
    input: undefined,
  });
}

/*
 * ---------------------------------------------------------------------------
 * The two schemas
 * ---------------------------------------------------------------------------
 */

/**
 * What a telemetry producer sends: every core field, and none of the three the
 * service assigns.
 *
 * Strict, so an unknown top-level key is a rejection — including
 * `sessionId`, `captureId` and `ingestSeq`, which a producer must never
 * supply (see the module documentation). The kind/tier agreement check is the
 * same function the persisted schema uses.
 *
 * Emitted in batches by the page agent (`../browser/transport.ts`, wrapped
 * into a protocol envelope by the Chrome service worker) and posted by the
 * Node preload's span processor (`../node/exporter.ts`); validated by
 * `apps/local-service/src/telemetry/ingest.ts` before anything is redacted,
 * keyed or stored.
 *
 * @example
 * ```ts
 * const event: TelemetryEventIngress = {
 *   id: newEventId(),
 *   traceId: newTraceId(),
 *   spanId: newSpanId(),
 *   kind: 'interaction',
 *   name: 'click button',
 *   startTime: performanceToEpochMs(entry.startTime),
 *   duration: entry.duration,
 *   tier: 'browser',
 *   attributes: {},
 *   status: 'ok',
 *   producerId,
 *   seq: nextSeq(),
 * };
 * ```
 */
export const telemetryEventIngressSchema = z
  .strictObject(telemetryEventCoreShape)
  .check(checkKindTierAgreement);

/**
 * What the store holds: the ingress shape plus the three attribution fields.
 *
 * Built from the same core record as {@link telemetryEventIngressSchema} and
 * checked by the same cross-field function, so the persisted key set is the
 * ingress key set plus exactly `sessionId`, `captureId` and `ingestSeq` — the
 * sibling test proves that from `.shape` rather than from a hand-written
 * list.
 *
 * Also strict: a row read back out of the store is re-validated against this
 * schema, and a column the current build does not know about means the store
 * was written by a different build, which is worth surfacing rather than
 * ignoring.
 */
export const telemetryEventSchema = z
  .strictObject({
    ...telemetryEventCoreShape,
    ...telemetryEventPersistedShape,
  })
  .check(checkKindTierAgreement);

/**
 * A runtime observation as its producer sends it.
 *
 * Inferred from {@link telemetryEventIngressSchema} rather than declared
 * beside it, so the validator and the type are one statement: a field added
 * to the schema appears here in the same edit, and no consumer can compile
 * against a shape the validator does not accept.
 *
 * Every {@link TelemetryEvent} satisfies this type — the persisted form only
 * adds fields — which is what lets the redaction, correlation and aggregate
 * helpers be written once against the narrower shape and used on both.
 */
export type TelemetryEventIngress = z.infer<typeof telemetryEventIngressSchema>;

/**
 * A runtime observation as the store holds it, after the service attributed it
 * to a session and a capture and assigned its arrival number.
 *
 * This is the type the panel data sources, the aggregates and the trace
 * correlator work with, and the type `@debuggen/protocol` embeds where a
 * stored event crosses a process boundary.
 */
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/*
 * ---------------------------------------------------------------------------
 * Parsing
 *
 * Non-throwing, `Result`-returning, and deliberately terse about *what*
 * failed: see the privacy note below.
 * ---------------------------------------------------------------------------
 */

/**
 * One validation failure, reduced to its structure.
 *
 * `path` is the dotted path of the offending field (the empty string for an
 * issue on the object itself, which is what an unknown top-level key
 * produces), and `code` is zod's issue code. `expected` is present only where
 * zod supplies it, which is on a type mismatch.
 */
interface SchemaIssueSummary {
  /** Dotted path of the offending field, or `''` for the object itself. */
  readonly path: string;
  /** Zod's issue code, for example `'invalid_type'` or `'custom'`. */
  readonly code: string;
  /** The type that was expected, where zod reports one. */
  readonly expected?: string;
}

/**
 * Reduces zod issues to {@link SchemaIssueSummary} values — **structure
 * only**.
 *
 * This is the privacy rule of AAP 0.5.2 applied to validation failures, and
 * it is not a theoretical concern: a rejected event can carry request URLs,
 * header values, database statements or React prop previews, and the error
 * built from it is logged, may be persisted with the session and may be shown
 * in both user interfaces. An error raised this deep in the call stack passes
 * through neither the redaction layer nor the outbound model guard, so the
 * only safe rule is that captured data never enters it.
 *
 * Concretely, what is kept is the field path, the issue code and — on a type
 * mismatch — the expected type. What is deliberately dropped:
 *
 * - `received` / `input`: the offending value itself. (Zod already strips a
 *   finalized issue's `input` unless a parse context asks for it, and no
 *   parse here asks.)
 * - the issue's own `message`: zod's default messages are safe today, but
 *   they are a library's formatting decision and not a contract this file can
 *   rely on. The field schemas above state their expectations without
 *   reference to what arrived, so nothing is lost.
 * - every other issue member, including `unrecognized_keys`' key list: a
 *   top-level key name is usually producer code, but it *can* be computed, and
 *   the path plus the code already identify the problem.
 *
 * `z.prettifyError`, `error.message` and `error.format()` are unusable for the
 * same reason — each can embed a received value — so none of them is used.
 */
function summariseIssues(issues: readonly z.core.$ZodIssue[]): SchemaIssueSummary[] {
  return issues.map((issue) => {
    // `path` segments are property keys, which may be array indices or
    // symbols, so each is stringified before joining.
    const path = issue.path.map((segment) => String(segment)).join('.');

    if (issue.code === 'invalid_type') {
      return { path, code: issue.code, expected: issue.expected };
    }

    return { path, code: issue.code };
  });
}

/** The hint offered when a producer's event fails validation. */
const INGRESS_HINT =
  'A telemetry event needs an id and producerId, a 32-hex traceId, a 16-hex spanId, a kind and tier that agree, a name, a Unix epoch millisecond startTime, a non-negative duration, a status, an attributes object and a zero-based seq. sessionId, captureId and ingestSeq are assigned by the service and must not be sent.';

/** The hint offered when a stored or attributed event fails validation. */
const PERSISTED_HINT =
  'A persisted telemetry event needs every field a producer sends plus the attribution the service assigns: sessionId, captureId and a one-based ingestSeq.';

/**
 * Builds the rejection for a failed parse: a coded {@link DebuggenError}
 * carrying the shape of the failure and none of the data that caused it.
 *
 * The code is `'PROTOCOL_INVALID_MESSAGE'` — the same code
 * `parseSourceLocation` uses in `@debuggen/shared`, and the right one here
 * because a transport is what delivered the value in every real case (a
 * WebSocket batch, an HTTP ingest body, a stored row). A caller at a stage
 * boundary that wants a different vocabulary maps it: `mapErr` to
 * `'STORE_ERROR'` for a row read back from the session store, for instance.
 * New codes are never invented — `@debuggen/shared`'s `errors.ts` owns that
 * vocabulary.
 */
function rejection(
  schemaName: string,
  hint: string,
  issues: readonly z.core.$ZodIssue[],
): DebuggenError {
  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    `A value did not match the ${schemaName} schema.`,
    {
      hint,
      details: { schema: schemaName, issues: summariseIssues(issues) },
    },
  );
}

/**
 * Validates an unknown value as a {@link TelemetryEventIngress}, without
 * throwing.
 *
 * This is how a batch element that arrived from the page agent or the Node
 * preload becomes a typed value. Non-throwing is a requirement rather than a
 * style: AAP 0.5.5 says one malformed event must never crash the ingest loop,
 * so the caller skips the offending element, reports it and keeps the capture.
 *
 * @param value Any value believed to be a producer's telemetry event.
 * @returns `ok(event)` with the parsed value, or `err(error)` describing the
 * shape of every issue found and nothing of the value that caused them.
 *
 * @example
 * ```ts
 * for (const candidate of batch.events) {
 *   const parsed = parseTelemetryEventIngress(candidate);
 *   if (!parsed.ok) {
 *     logger.warn('dropped a malformed telemetry event', parsed.error.details);
 *     continue;
 *   }
 *   ingest(parsed.value);
 * }
 * ```
 */
export function parseTelemetryEventIngress(value: unknown): Result<TelemetryEventIngress> {
  const parsed = telemetryEventIngressSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(rejection('telemetry event ingress', INGRESS_HINT, parsed.error.issues));
}

/**
 * Validates an unknown value as a {@link TelemetryEvent}, without throwing.
 *
 * Used where a persisted event re-enters the program: a row read back from
 * the session store, an event delivered inside a protocol message, or the
 * result of attribution before it is written. The same privacy discipline as
 * {@link parseTelemetryEventIngress} applies to the error it returns.
 *
 * @param value Any value believed to be a persisted telemetry event.
 * @returns `ok(event)` with the parsed value, or `err(error)` describing the
 * shape of every issue found.
 */
export function parseTelemetryEvent(value: unknown): Result<TelemetryEvent> {
  const parsed = telemetryEventSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(rejection('telemetry event', PERSISTED_HINT, parsed.error.issues));
}

/**
 * Whether a value is a {@link TelemetryEventIngress}.
 *
 * The boolean form of {@link parseTelemetryEventIngress}, over the same
 * schema and so with the same checks, for the paths that only need to ask —
 * a filter over a mixed array, a type guard at a message boundary. Use the
 * parsing form wherever the answer has to explain itself: a rejection with no
 * reason attached is a bug report nobody can act on.
 *
 * @param value Any value.
 * @returns `true` when `value` satisfies {@link telemetryEventIngressSchema},
 * narrowing it to {@link TelemetryEventIngress}.
 */
export function isTelemetryEventIngress(value: unknown): value is TelemetryEventIngress {
  return telemetryEventIngressSchema.safeParse(value).success;
}

/**
 * Whether a value is a {@link TelemetryEvent}.
 *
 * Note what this asks that {@link isTelemetryEventIngress} does not: a
 * producer's event is *not* a persisted event, because the three attribution
 * fields are missing — so this guard is also the honest way to ask "has this
 * event been attributed yet?".
 *
 * @param value Any value.
 * @returns `true` when `value` satisfies {@link telemetryEventSchema},
 * narrowing it to {@link TelemetryEvent}.
 */
export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  return telemetryEventSchema.safeParse(value).success;
}
