/**
 * Tests for `./event.ts` — the one and only definition of a runtime
 * observation — and, because they have no other test home, for the structural
 * invariants of `./kinds.ts` and `./attributes.ts`.
 *
 * ## What is on trial, and why it is worth a suite this size
 *
 * Five processes describe evidence with the two schemas under test: the
 * MAIN-world page agent, the dev-server Node preload, the Chrome service
 * worker that wraps a producer's batch into a protocol envelope, the local
 * service's ingest/store/aggregate path, and the panel renderer that reads the
 * result. None of them shares a runtime with the others, so a disagreement
 * about this shape is never a crash — it is a silently wrong number in a
 * generated panel. Four specific failures are what the cases below exist to
 * prevent:
 *
 * 1. **Attribution leaking into the producer contract.** `sessionId`,
 *    `captureId` and `ingestSeq` are the service's to assign (AAP §0.2.3). A
 *    producer that supplies one must be *rejected*, not quietly stripped, and
 *    the persisted schema must *require* all three — so the difference between
 *    the two key sets is asserted mechanically from `.shape` rather than from a
 *    list restated by hand.
 * 2. **A truncated time base.** `startTime` is Unix epoch milliseconds *as a
 *    double* and `duration` is milliseconds; an `.int()` creeping into either
 *    turns "this component re-rendered 300 times for 0 ms" into a plausible
 *    reading. The sub-millisecond cases below assert exact equality (`===`)
 *    with the input, which is the one assertion a rounding regression cannot
 *    survive.
 * 3. **A mis-tiered event.** A `db.query` reported on `browser` would subtract
 *    from `database_duration` and add to `frontend_duration`, and every number
 *    in the panel would be wrong in a way no reader could detect. Every
 *    kind/tier pair the vocabulary forbids is therefore exercised, not just the
 *    one the plan names.
 * 4. **Captured data escaping inside a validation failure.** An error raised
 *    this deep in the call stack passes through neither the redaction layer nor
 *    the outbound model guard, yet it is logged, may be persisted with the
 *    session and may be rendered in both user interfaces (AAP §0.5.2). The
 *    privacy suite feeds a recognisable sentinel through every rejection class
 *    and asserts it appears nowhere in the error.
 *
 * ## Why the two vocabularies are guarded from here
 *
 * `./kinds.ts` and `./attributes.ts` are dependency-free declarations — no zod,
 * no branches — so they are only ever wrong in one way: a member, an entry or a
 * documented bound changes and nothing notices. The compiler already makes the
 * two lookup tables *total* (both are annotated over the closed kind union, so
 * a missing entry is a compile error); what it cannot see is whether the
 * membership still matches the plan, whether a group still holds the kinds its
 * consumers filter on, and whether the two privacy bounds still carry their
 * published values. The sibling `./attributes.test.ts` covers the metric-id
 * vocabulary and explicitly delegates the per-kind key registry, the value
 * vocabularies and those bounds here; the suites at the end of this file are
 * that delegation discharged.
 *
 * ## Habits in here, each deliberate
 *
 * - **Invalid input is `unknown`, never a cast.** A rejection case that reached
 *   the schema through `as TelemetryEventIngress` would be testing a lie: these
 *   values arrive from a WebSocket batch, an HTTP ingest body or a stored row,
 *   where nothing has vouched for them. {@link makeIngress} and
 *   {@link makePersisted} therefore return an untyped {@link Candidate} bag.
 * - **Valid input is typed.** {@link FULL_EVENT} is a `TelemetryEvent`
 *   *literal*, so a field added to the schema without a value here fails
 *   `pnpm typecheck` in this file rather than at run time above it.
 * - **Fixtures are built from `@debuggen/shared`'s generators.** `newTraceId()`
 *   and friends are what the product actually emits, so the acceptance cases
 *   prove the schema accepts real producer output rather than a hand-written
 *   string that happens to match a regular expression.
 * - **Every rejection goes through all three entry points.** `safeParse`, the
 *   `Result`-returning parser and the boolean guard are one decision expressed
 *   three ways; a producer validating with one while a consumer filters with
 *   another is exactly the disagreement that would let a malformed event reach
 *   the store.
 * - **Narrowing is exercised, not bypassed.** `isOk`/`isErr` and the two
 *   guards are how this file reaches a value, so a guard that stopped narrowing
 *   fails the typecheck gate here.
 * - **Generic vocabulary only.** Every sample name is `src/lib/thing.ts`,
 *   `loadThing`, `MyComponent`, `click button`: `scripts/check-no-hardcoding.mjs`
 *   keeps knowledge of the demo application out of `packages/**` (AAP §0.5.4),
 *   and a test fixture is no place to start leaking it.
 *
 * ## The one thing this suite reads from disk
 *
 * Every case above is built in memory; the section at the end of the file is
 * the deliberate exception. Three curated corpora are committed under
 * `../../test/fixtures/` — `event-ingress-batch.json` (one capture's producer
 * events, browser and server alike), `event-persisted-batch.json` (the same
 * events as the store holds them, attributed) and `event-invalid-cases.json`
 * (an object of named producer bugs) — and a corpus with no executable
 * consumer is not evidence of anything: it can drift from the schema, lose a
 * case or contradict its own file name and nothing fails. So they are read
 * synchronously at module load and driven through both schemas, both parsers
 * and both guards, with their sizes and their case names pinned here, so a
 * corpus that shrinks fails this suite instead of quietly narrowing the
 * coverage its other readers assume.
 *
 * That read is the *only* filesystem access, and what it reads is
 * version-controlled repository data — identical on this machine, on a
 * developer's and in CI — never captured telemetry, an ambient path or
 * anything a clock or a network could change. Otherwise hermetic by
 * construction: no network, no timers, no fake clock. The only
 * non-determinism is identifier generation, which is the point of using it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  isErr,
  isOk,
  isSpanId,
  isTraceId,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  type Result,
  type SourceLocation,
} from '@debuggen/shared';

import {
  COMMON_ATTRIBUTE_KEYS,
  DB_QUERY_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  KIND_ATTRIBUTE_KEYS,
  LINEAGE_ATTRIBUTE_KEYS,
  LINEAGE_VALUES,
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_PHASES,
  RENDER_TRIGGERS,
  attributeKeysFor,
} from './attributes.js';
import { CLOCK_OFFSET_BOUND_MS } from './clock-offset.js';
import {
  MAX_EPOCH_MS,
  MIN_EPOCH_MS,
  isTelemetryEvent,
  isTelemetryEventIngress,
  parseTelemetryEvent,
  parseTelemetryEventIngress,
  telemetryEventIngressSchema,
  telemetryEventSchema,
  type TelemetryEvent,
  type TelemetryEventIngress,
} from './event.js';
import {
  ERROR_KINDS,
  KIND_ALLOWED_TIERS,
  OTEL_STATUS_CODE_TO_STATUS,
  PERF_KINDS,
  QUERY_KINDS,
  RENDER_KINDS,
  REQUEST_KINDS,
  STATE_KINDS,
  TELEMETRY_KINDS,
  TELEMETRY_STATUSES,
  TELEMETRY_TIERS,
  WATERFALL_KINDS,
  allowedTiersFor,
  isTelemetryKind,
  isTelemetryStatus,
  isTelemetryTier,
  isTierAllowedForKind,
  type TelemetryKind,
  type TelemetryStatus,
  type TelemetryTier,
} from './kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/**
 * A candidate event: an untyped bag of fields, which is what a batch element
 * *is* before the schema has vouched for it.
 *
 * Every negative case in this file is built as one of these, so no invalid
 * value ever reaches a schema through a type assertion.
 */
type Candidate = Record<string, unknown>;

/** The error code both rejections report (`./event.ts`'s `rejection`). */
const REJECTION_CODE = 'PROTOCOL_INVALID_MESSAGE';

/** The name the ingress rejection identifies itself by in `details.schema`. */
const INGRESS_SCHEMA_NAME = 'telemetry event ingress';

/** The name the persisted rejection identifies itself by. */
const PERSISTED_SCHEMA_NAME = 'telemetry event';

/**
 * A value that must never appear in a validation failure.
 *
 * Deliberately synthetic and deliberately *not* shaped like a real credential:
 * it carries no provider prefix, so `pnpm check:secrets` has nothing to report
 * while the string is still long, high-signal and unmistakable in a failure
 * message. Assembled from a prefix and a run of one character so that the
 * literal a reader sees is obviously a test sentinel.
 */
const LEAK_SENTINEL = `REDACT_ME_${'x'.repeat(40)}`;

/**
 * A fully valid producer event, as a {@link Candidate}.
 *
 * `startTime` carries a fractional part on purpose: the default fixture is the
 * one every other case starts from, so sub-millisecond precision is being
 * exercised even by the cases that are about something else. The kind/tier pair
 * is one `KIND_ALLOWED_TIERS` permits (`interaction` is browser-only), and
 * `attributes` is the empty bag a producer with nothing to add sends — there is
 * no default in the schema to invent one.
 *
 * @param overrides Fields to replace, valid or not. Untyped by design: a
 * negative case must be able to put a number in `traceId`.
 * @returns A fresh bag with freshly generated identifiers.
 */
function makeIngress(overrides: Candidate = {}): Candidate {
  return {
    id: newEventId(),
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind: 'interaction',
    name: 'click button',
    startTime: Date.now() + 0.25,
    duration: 12.5,
    tier: 'browser',
    attributes: {},
    status: 'unset',
    producerId: newProducerId(),
    seq: 0,
    ...overrides,
  };
}

/**
 * A fully valid persisted event: {@link makeIngress} plus the three fields the
 * service assigns at ingest.
 *
 * `ingestSeq` is `1` rather than `0`, because the store's arrival number is
 * one-based — a persisted event always has a predecessor count, and `0` reads
 * as "not yet assigned".
 *
 * @param overrides Fields to replace, valid or not.
 * @returns A fresh bag with freshly generated identifiers.
 */
function makePersisted(overrides: Candidate = {}): Candidate {
  return {
    ...makeIngress(),
    sessionId: newSessionId(),
    captureId: newCaptureId(),
    ingestSeq: 1,
    ...overrides,
  };
}

/**
 * The same bag with one key removed, for the missing-field cases.
 *
 * Rebuilt through `Object.entries` rather than `delete`, so the result is a
 * fresh object and the fixture the caller passed in is left alone.
 *
 * @param candidate The bag to copy.
 * @param key The field to omit.
 * @returns A copy without `key`.
 */
function withoutKey(candidate: Candidate, key: string): Candidate {
  return Object.fromEntries(Object.entries(candidate).filter(([name]) => name !== key));
}

/**
 * A source location every route could plausibly produce, typed so the compiler
 * checks it against the schema `@debuggen/shared` owns.
 *
 * Project-relative POSIX path, 1-based line and column, a symbol, a range and
 * the confidence its route reports by default — the shape `TelemetryEvent.source`
 * embeds rather than restates.
 */
const SOURCE: SourceLocation = {
  file: 'src/lib/thing.ts',
  line: 42,
  column: 3,
  symbol: 'loadThing',
  endLine: 57,
  resolvedBy: 'patch',
  confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
};

/**
 * Every field the persisted schema declares, populated, written as a typed
 * literal.
 *
 * Three jobs at once. It is the compile-time check that
 * {@link TelemetryEvent} is the schema's output type and that nothing has been
 * added to the schema without a value here; it is the input to the
 * non-mutation case, which needs an event carrying `parentSpanId`, `source`,
 * `redacted` and a populated `attributes` (the four fields a stray
 * `.transform()` would most plausibly touch); and its `kind`/`tier` pair is one
 * of the two cross-tier kinds, so the normal path exercises the interesting
 * half of the kind/tier table rather than the trivial half.
 */
const FULL_EVENT: TelemetryEvent = {
  id: newEventId(),
  traceId: newTraceId(),
  spanId: newSpanId(),
  parentSpanId: newSpanId(),
  kind: 'function',
  name: 'loadThing',
  startTime: 1_758_000_000_000.25,
  duration: 12.345,
  tier: 'server',
  attributes: {
    'function.name': 'loadThing',
    nested: { depth: 2, flag: false },
    list: [1, 'two', null],
  },
  status: 'ok',
  producerId: newProducerId(),
  seq: 7,
  clockOffsetMs: -3,
  source: SOURCE,
  redacted: ['attributes.authorization'],
  sessionId: newSessionId(),
  captureId: newCaptureId(),
  ingestSeq: 1,
};

/*
 * ---------------------------------------------------------------------------
 * Narrowing and inspection helpers
 *
 * All of them go through the exported guards rather than reading `.ok`
 * directly, so a guard that stopped narrowing fails `pnpm typecheck` in this
 * file. They throw rather than assert, because the throw carries the other
 * branch's content into the failure line — "expected Ok, received
 * PROTOCOL_INVALID_MESSAGE" says more than a boolean that was false.
 * ---------------------------------------------------------------------------
 */

/** One reported issue, reduced to the structure `./event.ts` publishes. */
interface ReportedIssue {
  /** Dotted path of the offending field, `''` for the object itself. */
  readonly path: string;
  /** Zod's issue code. */
  readonly code: string;
}

/**
 * The value a successful parse produced, or a failed test naming the error.
 *
 * @param result The `Result` a parse helper returned.
 * @returns The parsed value.
 */
function okValue<T>(result: Result<T>): T {
  if (isErr(result)) {
    throw new Error(`Expected Ok, received Err ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/**
 * The error a rejection produced, or a failed test naming the value that got
 * through.
 *
 * @param result The `Result` a parse helper returned.
 * @returns The rejection's error.
 */
function errorOf<T>(result: Result<T>): DebuggenError {
  if (isOk(result)) {
    throw new Error(`Expected Err, received Ok(${JSON.stringify(result.value)})`);
  }
  return result.error;
}

/**
 * Whether a value is an array of plain objects.
 *
 * A hand-written guard rather than a bare `Array.isArray`, so each entry is
 * reached as `Record<string, unknown>` and every field read below stays
 * `unknown` — which is why this file needs no type assertion anywhere.
 *
 * @param value Any value, typically `error.details?.issues`.
 * @returns `true` when every element is a non-null, non-array object.
 */
function isRecordArray(value: unknown): value is readonly Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    )
  );
}

/** The only members a reported issue may carry (`summariseIssues`). */
const ALLOWED_ISSUE_KEYS = ['code', 'expected', 'path'];

/**
 * The issues a rejection reported, with the privacy constraint checked on the
 * way through.
 *
 * The key-set assertion lives here rather than in one dedicated test so that it
 * holds for *every* case in *every* table: `summariseIssues` must publish the
 * path, the code and — on a type mismatch — the expected type, and nothing
 * else. In particular no `received`/`input` (the offending value), no zod
 * `message` (a library's formatting decision) and no `keys` list from an
 * `unrecognized_keys` issue, since a top-level key name can be computed.
 *
 * @param error The error a rejection produced.
 * @returns The reported issues, in the order the schema produced them.
 */
function issuesOf(error: DebuggenError): readonly ReportedIssue[] {
  const raw: unknown = error.details?.['issues'];

  if (!isRecordArray(raw)) {
    throw new Error(`Expected details.issues to be an array of objects: ${JSON.stringify(raw)}`);
  }

  expect(raw.length).toBeGreaterThan(0);

  return raw.map((entry, index): ReportedIssue => {
    expect(Object.keys(entry).filter((key) => !ALLOWED_ISSUE_KEYS.includes(key))).toEqual([]);

    const path = entry['path'];
    const code = entry['code'];

    if (typeof path !== 'string' || typeof code !== 'string') {
      throw new Error(
        `Issue ${String(index)} is not a { path, code } pair: ${JSON.stringify(entry)}`,
      );
    }

    return { path, code };
  });
}

/**
 * Asserts that a candidate is refused as a producer event by all three entry
 * points, and returns the issues so a caller can go on to assert the path.
 *
 * @param value The candidate under test, unvouched-for.
 * @returns The issues the refusal reported.
 */
function expectIngressRejected(value: unknown): readonly ReportedIssue[] {
  expect(telemetryEventIngressSchema.safeParse(value).success).toBe(false);
  expect(isTelemetryEventIngress(value)).toBe(false);

  const error = errorOf(parseTelemetryEventIngress(value));

  expect(DebuggenError.is(error)).toBe(true);
  expect(error.code).toBe(REJECTION_CODE);
  expect(error.details?.['schema']).toBe(INGRESS_SCHEMA_NAME);

  return issuesOf(error);
}

/**
 * Asserts that a candidate is refused as a persisted event by all three entry
 * points, and returns the issues.
 *
 * @param value The candidate under test, unvouched-for.
 * @returns The issues the refusal reported.
 */
function expectPersistedRejected(value: unknown): readonly ReportedIssue[] {
  expect(telemetryEventSchema.safeParse(value).success).toBe(false);
  expect(isTelemetryEvent(value)).toBe(false);

  const error = errorOf(parseTelemetryEvent(value));

  expect(DebuggenError.is(error)).toBe(true);
  expect(error.code).toBe(REJECTION_CODE);
  expect(error.details?.['schema']).toBe(PERSISTED_SCHEMA_NAME);

  return issuesOf(error);
}

/** The dotted paths a rejection reported, for the path assertions. */
function pathsOf(issues: readonly ReportedIssue[]): readonly string[] {
  return issues.map((issue) => issue.path);
}

/**
 * Compile-time proof that a persisted event *is* a producer event as far as the
 * type system is concerned: the persisted form only adds fields, which is what
 * lets the redaction, correlation and aggregate helpers be written once against
 * the narrower shape and used on both.
 *
 * Note what this does **not** claim: at run time a persisted event is *not*
 * accepted by the ingress schema, because that schema is strict and the three
 * attribution fields are unknown to it. The type relation and the validator's
 * answer are different questions, and the suite below asserts both.
 *
 * @param event A persisted event.
 * @returns The same event, seen as a producer's.
 */
function asIngressShape(event: TelemetryEvent): TelemetryEventIngress {
  return event;
}

/*
 * ---------------------------------------------------------------------------
 * Case tables
 *
 * One `it` per case through `it.each`, so a failure names the offending input
 * rather than an index.
 * ---------------------------------------------------------------------------
 */

/** A rejection case: an unvouched-for input and the path it must report. */
interface RejectionCase {
  /** What the input is, for the test name. */
  readonly label: string;
  /** The input, typed `unknown` because nothing has vouched for it. */
  readonly input: unknown;
  /** The dotted issue path the refusal must report. */
  readonly path: string;
  /** The issue code the refusal must report. */
  readonly code: string;
}

/**
 * A case expressed as fields to apply to the default fixture.
 *
 * Used by both the acceptance tables (where the overrides are legal) and the
 * privacy table (where they are not), because in both the interesting part is
 * the *difference* from a valid event rather than the whole bag.
 */
interface OverrideCase {
  /** What the case is, for the test name. */
  readonly label: string;
  /** The fields to apply to the default fixture. */
  readonly overrides: Candidate;
}

/** The twelve fields a producer's event cannot omit. */
const REQUIRED_INGRESS_FIELDS = [
  'id',
  'traceId',
  'spanId',
  'kind',
  'name',
  'startTime',
  'duration',
  'tier',
  'attributes',
  'status',
  'producerId',
  'seq',
];

/**
 * The three required fields whose value comes from a closed vocabulary.
 *
 * Their absence is reported as `invalid_value` rather than `invalid_type`,
 * because `undefined` is simply not one of the members zod was given — the
 * same outcome expressed with the enum's own code. The path, which is what a
 * producer acts on, is identical either way.
 */
const ENUM_INGRESS_FIELDS = ['kind', 'tier', 'status'];

/** The code the absence of `field` is reported with. */
function absenceCodeFor(field: string): string {
  return ENUM_INGRESS_FIELDS.includes(field) ? 'invalid_value' : 'invalid_type';
}

/** The three fields the service assigns and the store therefore requires. */
const ATTRIBUTION_FIELDS = ['sessionId', 'captureId', 'ingestSeq'];

/**
 * The all-zero trace id: 32 characters the shared pattern accepts and W3C
 * Trace Context defines as invalid.
 *
 * Built from the length of a generated id rather than typed out, so it cannot
 * drift from the width the pattern enforces.
 */
const ALL_ZERO_TRACE_ID = '0'.repeat(newTraceId().length);

/** The all-zero span id, the same case at span-id width. */
const ALL_ZERO_SPAN_ID = '0'.repeat(newSpanId().length);

/** Every way a `traceId` can fail to be 32 lowercase hex characters. */
const TRACE_ID_REJECTIONS: readonly RejectionCase[] = [
  { label: '31 hex characters', input: 'a'.repeat(31), path: 'traceId', code: 'invalid_format' },
  { label: '33 hex characters', input: 'a'.repeat(33), path: 'traceId', code: 'invalid_format' },
  {
    label: 'uppercase hex',
    input: 'ABCDEF0123456789ABCDEF0123456789',
    path: 'traceId',
    code: 'invalid_format',
  },
  {
    label: '32 non-hex characters',
    input: 'z'.repeat(32),
    path: 'traceId',
    code: 'invalid_format',
  },
  { label: 'an empty string', input: '', path: 'traceId', code: 'invalid_format' },
  {
    // The one rejection here that the shared pattern cannot produce: 32
    // lowercase hex characters, refused for what the value *means* rather than
    // for its shape. Reported as `custom`, the code a refinement carries.
    label: 'the all-zero trace id W3C Trace Context defines as invalid',
    input: ALL_ZERO_TRACE_ID,
    path: 'traceId',
    code: 'custom',
  },
  { label: 'a number', input: 12, path: 'traceId', code: 'invalid_type' },
  { label: 'a boolean', input: true, path: 'traceId', code: 'invalid_type' },
];

/** Every way a `spanId` can fail to be 16 lowercase hex characters. */
const SPAN_ID_REJECTIONS: readonly RejectionCase[] = [
  { label: '15 hex characters', input: 'a'.repeat(15), path: 'spanId', code: 'invalid_format' },
  { label: '17 hex characters', input: 'a'.repeat(17), path: 'spanId', code: 'invalid_format' },
  { label: 'uppercase hex', input: 'ABCDEF0123456789', path: 'spanId', code: 'invalid_format' },
  { label: '16 non-hex characters', input: 'z'.repeat(16), path: 'spanId', code: 'invalid_format' },
  { label: 'an empty string', input: '', path: 'spanId', code: 'invalid_format' },
  {
    // Applied to `parentSpanId` as well, since this table drives that field's
    // battery too: the all-zero span id is precisely the placeholder an SDK
    // reports for "no parent", and reading it as a trace root would attach
    // every such event to a span that does not exist.
    label: 'the all-zero span id W3C Trace Context defines as invalid',
    input: ALL_ZERO_SPAN_ID,
    path: 'spanId',
    code: 'custom',
  },
  { label: 'a number', input: 1, path: 'spanId', code: 'invalid_type' },
  { label: 'a boolean', input: false, path: 'spanId', code: 'invalid_type' },
];

/**
 * Every way a `startTime` can fail to be a Unix epoch millisecond value.
 *
 * The first three are the producer bugs `MIN_EPOCH_MS` and `MAX_EPOCH_MS` exist
 * to catch, and each one produces a perfectly valid number — which is exactly
 * why a bound rather than a type is what rejects them.
 */
const START_TIME_REJECTIONS: readonly RejectionCase[] = [
  {
    label: 'a relative performance.now() value',
    input: 1234.5,
    path: 'startTime',
    code: 'too_small',
  },
  {
    label: 'a seconds-precision epoch value',
    input: 1_758_000_000,
    path: 'startTime',
    code: 'too_small',
  },
  {
    label: 'a microsecond-scale timestamp',
    input: 1_758_000_000_000_000,
    path: 'startTime',
    code: 'too_big',
  },
  { label: 'NaN', input: Number.NaN, path: 'startTime', code: 'invalid_type' },
  {
    label: 'Infinity',
    input: Number.POSITIVE_INFINITY,
    path: 'startTime',
    code: 'invalid_type',
  },
  {
    label: '-Infinity',
    input: Number.NEGATIVE_INFINITY,
    path: 'startTime',
    code: 'invalid_type',
  },
  { label: 'a numeric string', input: '1758000000000', path: 'startTime', code: 'invalid_type' },
];

/** Every way a `duration` can fail to be a non-negative millisecond value. */
const DURATION_REJECTIONS: readonly RejectionCase[] = [
  { label: 'a negative value', input: -1, path: 'duration', code: 'too_small' },
  {
    label: 'a negative fraction',
    input: -0.001,
    path: 'duration',
    code: 'too_small',
  },
  { label: 'NaN', input: Number.NaN, path: 'duration', code: 'invalid_type' },
  { label: 'Infinity', input: Number.POSITIVE_INFINITY, path: 'duration', code: 'invalid_type' },
  { label: 'a numeric string', input: '5', path: 'duration', code: 'invalid_type' },
];

/** Every way an opaque identifier field can fail, applied to `id`. */
const ID_REJECTIONS: readonly RejectionCase[] = [
  { label: 'an empty string', input: '', path: 'id', code: 'too_small' },
  { label: 'a padded value', input: ' evt_0123456789abcdef ', path: 'id', code: 'custom' },
  { label: 'a value of 65 characters', input: 'a'.repeat(65), path: 'id', code: 'too_big' },
  { label: 'a number', input: 5, path: 'id', code: 'invalid_type' },
  { label: 'null', input: null, path: 'id', code: 'invalid_type' },
];

/** The same battery on `producerId`, the other opaque identifier a producer sets. */
const PRODUCER_ID_REJECTIONS: readonly RejectionCase[] = [
  { label: 'an empty string', input: '', path: 'producerId', code: 'too_small' },
  { label: 'a padded value', input: '\tprd_0123456789abcdef', path: 'producerId', code: 'custom' },
  {
    label: 'a value of 65 characters',
    input: 'a'.repeat(65),
    path: 'producerId',
    code: 'too_big',
  },
  { label: 'an array', input: [], path: 'producerId', code: 'invalid_type' },
];

/** Every way `seq` can fail to be a zero-based integer counter. */
const SEQ_REJECTIONS: readonly RejectionCase[] = [
  { label: 'a negative counter', input: -1, path: 'seq', code: 'too_small' },
  { label: 'a fractional counter', input: 1.5, path: 'seq', code: 'invalid_type' },
  { label: 'a numeric string', input: '0', path: 'seq', code: 'invalid_type' },
  { label: 'NaN', input: Number.NaN, path: 'seq', code: 'invalid_type' },
];

/** Every way `clockOffsetMs` can fail to be a bounded whole-millisecond offset. */
const CLOCK_OFFSET_REJECTIONS: readonly RejectionCase[] = [
  { label: 'a fractional offset', input: 12.5, path: 'clockOffsetMs', code: 'invalid_type' },
  {
    label: 'an offset beyond the bound ahead',
    input: CLOCK_OFFSET_BOUND_MS + 1,
    path: 'clockOffsetMs',
    code: 'too_big',
  },
  {
    label: 'an offset beyond the bound behind',
    input: -CLOCK_OFFSET_BOUND_MS - 1,
    path: 'clockOffsetMs',
    code: 'too_small',
  },
  { label: 'a numeric string', input: '0', path: 'clockOffsetMs', code: 'invalid_type' },
  { label: 'NaN', input: Number.NaN, path: 'clockOffsetMs', code: 'invalid_type' },
  {
    label: 'an infinite offset',
    input: Number.POSITIVE_INFINITY,
    path: 'clockOffsetMs',
    code: 'invalid_type',
  },
  { label: 'null', input: null, path: 'clockOffsetMs', code: 'invalid_type' },
];

/** Every way `ingestSeq` can fail to be the store's one-based arrival number. */
const INGEST_SEQ_REJECTIONS: readonly RejectionCase[] = [
  { label: 'zero, which reads as unassigned', input: 0, path: 'ingestSeq', code: 'too_small' },
  { label: 'a negative number', input: -1, path: 'ingestSeq', code: 'too_small' },
  { label: 'a fractional number', input: 1.5, path: 'ingestSeq', code: 'invalid_type' },
  { label: 'a numeric string', input: '1', path: 'ingestSeq', code: 'invalid_type' },
];

/** Every way the `attributes` bag can fail to be a record of values. */
const ATTRIBUTES_REJECTIONS: readonly RejectionCase[] = [
  { label: 'a string', input: 'nothing', path: 'attributes', code: 'invalid_type' },
  { label: 'null', input: null, path: 'attributes', code: 'invalid_type' },
  { label: 'an array', input: [], path: 'attributes', code: 'invalid_type' },
  { label: 'a number', input: 0, path: 'attributes', code: 'invalid_type' },
];

/** Every way the `redacted` record of the privacy layer's work can fail. */
const REDACTED_REJECTIONS: readonly RejectionCase[] = [
  {
    label: 'a bare string instead of a list',
    input: 'attributes.authorization',
    path: 'redacted',
    code: 'invalid_type',
  },
  { label: 'null', input: null, path: 'redacted', code: 'invalid_type' },
  { label: 'a numeric entry', input: [1], path: 'redacted.0', code: 'invalid_type' },
  { label: 'an empty entry', input: [''], path: 'redacted.0', code: 'too_small' },
];

/**
 * Every way an embedded `source` can fail.
 *
 * These are the assertions that prove the field delegates to
 * `sourceLocationSchema` from `@debuggen/shared` rather than carrying a local
 * copy: the paths are nested (`source.file`, `source.line`), which only happens
 * if the shared schema is running inside this one.
 */
const SOURCE_REJECTIONS: readonly RejectionCase[] = [
  {
    label: 'a zero line, which would select the wrong region',
    input: { ...SOURCE, line: 0 },
    path: 'source.line',
    code: 'too_small',
  },
  {
    label: 'a zero column',
    input: { ...SOURCE, column: 0 },
    path: 'source.column',
    code: 'too_small',
  },
  {
    label: 'an absolute file path',
    input: { ...SOURCE, file: '/home/dev/project/src/lib/thing.ts' },
    path: 'source.file',
    code: 'custom',
  },
  {
    label: 'a traversing file path',
    input: { ...SOURCE, file: '../outside/thing.ts' },
    path: 'source.file',
    code: 'custom',
  },
  {
    label: 'a resolution route outside the closed set',
    input: { ...SOURCE, resolvedBy: 'guesswork' },
    path: 'source.resolvedBy',
    code: 'invalid_value',
  },
  {
    label: 'a range that ends before it starts',
    input: { ...SOURCE, endLine: SOURCE.line - 1 },
    path: 'source.endLine',
    code: 'custom',
  },
  { label: 'null', input: null, path: 'source', code: 'invalid_type' },
];

/** The five non-objects a batch element might be. */
const NON_OBJECT_REJECTIONS: readonly RejectionCase[] = [
  { label: 'null', input: null, path: '', code: 'invalid_type' },
  { label: 'undefined', input: undefined, path: '', code: 'invalid_type' },
  { label: 'a string', input: 'interaction', path: '', code: 'invalid_type' },
  { label: 'a number', input: 42, path: '', code: 'invalid_type' },
  { label: 'an array of events', input: [makeIngress()], path: '', code: 'invalid_type' },
];

/**
 * One rejection per route by which captured data could enter a failure, each
 * carrying {@link LEAK_SENTINEL} somewhere a naive implementation would echo.
 *
 * The routes, in the order they appear: an attribute *value* on an event
 * rejected for an unrelated reason (the bag is where request URLs, database
 * statements and prop previews live); the offending value *itself*, where zod's
 * own `received` member is the temptation; a nested value inside the embedded
 * source location; a top-level key *name*, which an `unrecognized_keys` issue
 * carries in its `keys` member; and an attribute value rejected on its own
 * merits, where the issue path legitimately names the key but must not carry
 * the value. The remaining route — the whole value being the secret, with no
 * object to hang a path on — cannot be written as an override and has its own
 * case in the suite.
 *
 * Note which of these is *not* a leak and therefore not tested as one: an
 * attribute *key* is producer code — `'http.method'`, `'db.statement'` — and
 * `./event.ts` reports it as the issue path on purpose, because a failure with
 * no location is a bug report nobody can act on.
 */
const SENTINEL_CASES: readonly OverrideCase[] = [
  {
    label: 'a malformed traceId on an event whose attributes carry a secret',
    overrides: { traceId: 'not-a-trace-id', attributes: { authorization: LEAK_SENTINEL } },
  },
  {
    label: 'a name that is itself the secret, over the length bound',
    overrides: { name: LEAK_SENTINEL.repeat(20) },
  },
  {
    label: 'a source path carrying the secret outside the project',
    overrides: { source: { ...SOURCE, file: `/home/dev/${LEAK_SENTINEL}/thing.ts` } },
  },
  {
    label: 'an unknown top-level key named after the secret',
    overrides: { [LEAK_SENTINEL]: 'anything' },
  },
  {
    label: 'a callback assigned to an attribute beside a secret',
    overrides: {
      attributes: { callback: (): number => 1, authorization: LEAK_SENTINEL },
    },
  },
];

/*
 * ---------------------------------------------------------------------------
 * Ingress versus persisted
 * ---------------------------------------------------------------------------
 */

describe('the two schemas', () => {
  it("accepts a producer's event through every ingress entry point", () => {
    const candidate = makeIngress();

    expect(telemetryEventIngressSchema.safeParse(candidate).success).toBe(true);
    expect(isTelemetryEventIngress(candidate)).toBe(true);
    expect(okValue(parseTelemetryEventIngress(candidate))).toEqual(candidate);
  });

  it('accepts a persisted event through every persisted entry point', () => {
    const candidate = makePersisted();

    expect(telemetryEventSchema.safeParse(candidate).success).toBe(true);
    expect(isTelemetryEvent(candidate)).toBe(true);
    expect(okValue(parseTelemetryEvent(candidate))).toEqual(candidate);
  });

  it('answers "has this event been attributed yet" through the two guards', () => {
    // The honest use of the pair, and the reason both exist: a producer's event
    // is not a persisted event (no attribution), and a persisted event is not a
    // producer's (the strict ingress schema does not know those three keys).
    // The type relation runs one way; the validators are mutually exclusive.
    const producerEvent = makeIngress();
    const storedEvent = makePersisted();

    expect(isTelemetryEventIngress(producerEvent)).toBe(true);
    expect(isTelemetryEvent(producerEvent)).toBe(false);

    expect(isTelemetryEvent(storedEvent)).toBe(true);
    expect(isTelemetryEventIngress(storedEvent)).toBe(false);
  });

  it('differs by exactly the three fields the service assigns', () => {
    // Read from `.shape` on both schemas rather than from a list written here:
    // `./event.ts` builds both from one shape record, and this is the assertion
    // that keeps "sharing a core" structurally true instead of a comment that
    // has to be believed. The three names below are the contract of AAP 0.2.3.
    const ingressKeys = Object.keys(telemetryEventIngressSchema.shape);
    const persistedKeys = Object.keys(telemetryEventSchema.shape);

    const added = persistedKeys.filter((key) => !ingressKeys.includes(key));
    const removed = ingressKeys.filter((key) => !persistedKeys.includes(key));

    expect(added.sort()).toEqual([...ATTRIBUTION_FIELDS].sort());
    expect(removed).toEqual([]);
  });

  it('keeps the core fields in one order, so neither schema reorders the other', () => {
    // Stronger than a set comparison and free: the persisted schema spreads the
    // core record first, so its keys must *start* with the ingress keys in the
    // same order. A future edit that rebuilt the persisted shape by hand would
    // pass the set comparison above and fail here.
    const ingressKeys = Object.keys(telemetryEventIngressSchema.shape);
    const persistedKeys = Object.keys(telemetryEventSchema.shape);

    expect(persistedKeys.slice(0, ingressKeys.length)).toEqual(ingressKeys);
    expect(persistedKeys.slice(ingressKeys.length)).toEqual(ATTRIBUTION_FIELDS);
  });

  it('exposes a persisted event as a value every ingress-shaped helper accepts', () => {
    // A compile-time assertion with a run-time tail: `asIngressShape` demands
    // `TelemetryEventIngress`, so this file stops compiling if the persisted
    // type ever stops being assignable to the producer's. That assignability is
    // what lets redaction, correlation and the aggregates be written once.
    const asProducerEvent: TelemetryEventIngress = asIngressShape(FULL_EVENT);

    expect(asProducerEvent.id).toBe(FULL_EVENT.id);
    expect(asProducerEvent.traceId).toBe(FULL_EVENT.traceId);
    expect(asProducerEvent.kind).toBe(FULL_EVENT.kind);
  });

  it('infers kind, tier and status as the vocabularies themselves', () => {
    // Mutual assignability in both directions, so the inferred member types are
    // exactly the closed unions `./kinds.ts` declares — not widened `string`,
    // which would let a consumer switch on a value the schema never accepts.
    const event = okValue(parseTelemetryEvent(makePersisted()));

    const kind: TelemetryKind = event.kind;
    const tier: TelemetryTier = event.tier;
    const status: TelemetryStatus = event.status;

    const kindBack: TelemetryEvent['kind'] = kind;
    const tierBack: TelemetryEvent['tier'] = tier;
    const statusBack: TelemetryEvent['status'] = status;

    expect(TELEMETRY_KINDS).toContain(kindBack);
    expect(TELEMETRY_TIERS).toContain(tierBack);
    expect(TELEMETRY_STATUSES).toContain(statusBack);
  });

  it('narrows an unknown value through each guard', () => {
    const received: unknown = makePersisted();

    if (!isTelemetryEvent(received)) {
      throw new Error('Expected a fully attributed event to satisfy isTelemetryEvent');
    }

    // Reachable only because the guard narrowed `received`: a guard that
    // stopped narrowing fails the typecheck gate on the next lines.
    const narrowed: TelemetryEvent = received;
    const alsoIngress: TelemetryEventIngress = asIngressShape(narrowed);

    expect(narrowed.ingestSeq).toBe(1);
    expect(alsoIngress.seq).toBe(0);
  });
});

describe('the persisted schema requires the attribution', () => {
  it.each(ATTRIBUTION_FIELDS)('rejects an event with no %s', (field: string) => {
    const issues = expectPersistedRejected(withoutKey(makePersisted(), field));

    expect(pathsOf(issues)).toContain(field);
    expect(issues.filter((issue) => issue.path === field).map((issue) => issue.code)).toEqual([
      'invalid_type',
    ]);
  });

  it.each(INGEST_SEQ_REJECTIONS)(
    'rejects an ingestSeq that is $label',
    ({ input, path, code }: RejectionCase) => {
      const issues = expectPersistedRejected(makePersisted({ ingestSeq: input }));

      expect(issues).toContainEqual({ path, code });
    },
  );

  it('accepts the first arrival number the store can assign', () => {
    expect(okValue(parseTelemetryEvent(makePersisted({ ingestSeq: 1 }))).ingestSeq).toBe(1);
  });
});

describe('the ingress schema refuses the attribution a producer must not send', () => {
  it.each(ATTRIBUTION_FIELDS)('rejects a producer that supplies %s', (field: string) => {
    // Rejection rather than a silent strip is the whole point of the strict
    // object: attribution is the service's job alone, and a producer that
    // thinks otherwise is a bug to be found rather than papered over. The issue
    // lands on the object itself, because an unrecognised key has no path of
    // its own.
    const issues = expectIngressRejected(makeIngress({ [field]: 'anything' }));

    expect(issues).toContainEqual({ path: '', code: 'unrecognized_keys' });
  });

  it('rejects all three at once without naming them in the failure', () => {
    const issues = expectIngressRejected(makePersisted());

    expect(issues).toContainEqual({ path: '', code: 'unrecognized_keys' });

    // The key list zod attaches to an `unrecognized_keys` issue is dropped by
    // `summariseIssues`: a top-level key name is usually producer code, but it
    // can be computed, so the path and the code carry the whole report.
    const serialised = JSON.stringify(issues);

    for (const field of ATTRIBUTION_FIELDS) {
      expect(serialised).not.toContain(field);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Identifiers
 *
 * The correlation ids are the only fields whose format is validated against a
 * pattern this package does not own: `TRACE_ID_PATTERN` and `SPAN_ID_PATTERN`
 * live in `@debuggen/shared`, because the same values become the `traceparent`
 * header the agent injects on a same-origin request. A local copy of either
 * pattern is precisely the duplicate definition `./event.ts` exists to prevent,
 * so the suites below check the schema against values that only those patterns
 * accept.
 * ---------------------------------------------------------------------------
 */

describe('traceId', () => {
  it('accepts what the product generates', () => {
    const traceId = newTraceId();

    expect(TRACE_ID_PATTERN.test(traceId)).toBe(true);
    expect(okValue(parseTelemetryEventIngress(makeIngress({ traceId }))).traceId).toBe(traceId);
  });

  it.each(TRACE_ID_REJECTIONS)('rejects $label', ({ input, path, code }: RejectionCase) => {
    const issues = expectIngressRejected(makeIngress({ traceId: input }));

    expect(issues).toContainEqual({ path, code });
  });

  it('rejects a 32-character value the shared pattern also rejects', () => {
    // The round trip that proves the schema is running that pattern rather than
    // a length check of its own: same length, wrong alphabet, refused by both.
    const sameLengthNonHex = 'z'.repeat(32);

    expect(sameLengthNonHex).toHaveLength(newTraceId().length);
    expect(TRACE_ID_PATTERN.test(sameLengthNonHex)).toBe(false);
    expect(
      telemetryEventIngressSchema.safeParse(makeIngress({ traceId: sameLengthNonHex })).success,
    ).toBe(false);
  });

  it('rejects the all-zero trace id the shared pattern accepts', () => {
    // The mirror image of the case above, and the reason this rule lives in the
    // schema at all: `@debuggen/shared`'s pattern and guard answer a question
    // about *format*, and both say yes here — their documentation states that a
    // caller needing the W3C distinction must reject the value explicitly. This
    // schema is that caller, so the refusal has to be observable from the
    // pattern's own verdict rather than implied by it.
    expect(TRACE_ID_PATTERN.test(ALL_ZERO_TRACE_ID)).toBe(true);
    expect(isTraceId(ALL_ZERO_TRACE_ID)).toBe(true);

    expect(expectIngressRejected(makeIngress({ traceId: ALL_ZERO_TRACE_ID }))).toContainEqual({
      path: 'traceId',
      code: 'custom',
    });
  });

  it('applies the all-zero refusal to a persisted event too', () => {
    // One factory feeds one core shape feeds both schemas, so a stored row can
    // no more carry the value than a producer can send it. Without this, an
    // event could be refused at ingest and still be readable out of the store.
    expect(expectPersistedRejected(makePersisted({ traceId: ALL_ZERO_TRACE_ID }))).toContainEqual({
      path: 'traceId',
      code: 'custom',
    });
  });

  it('accepts a trace id that is mostly zeros but not all of them', () => {
    // The boundary that keeps the rule narrow: what is refused is the all-zero
    // id W3C defines as invalid, never the zero digit. A single non-zero nibble
    // makes a perfectly ordinary trace id, and a random one can look like this.
    const nearlyZero = `${'0'.repeat(newTraceId().length - 1)}1`;

    expect(nearlyZero).toHaveLength(newTraceId().length);
    expect(okValue(parseTelemetryEventIngress(makeIngress({ traceId: nearlyZero }))).traceId).toBe(
      nearlyZero,
    );
  });
});

describe('spanId', () => {
  it('accepts what the product generates', () => {
    const spanId = newSpanId();

    expect(SPAN_ID_PATTERN.test(spanId)).toBe(true);
    expect(okValue(parseTelemetryEventIngress(makeIngress({ spanId }))).spanId).toBe(spanId);
  });

  it.each(SPAN_ID_REJECTIONS)('rejects $label', ({ input, path, code }: RejectionCase) => {
    const issues = expectIngressRejected(makeIngress({ spanId: input }));

    expect(issues).toContainEqual({ path, code });
  });

  it('rejects a 16-character value the shared pattern also rejects', () => {
    const sameLengthNonHex = 'z'.repeat(16);

    expect(sameLengthNonHex).toHaveLength(newSpanId().length);
    expect(SPAN_ID_PATTERN.test(sameLengthNonHex)).toBe(false);
    expect(
      telemetryEventIngressSchema.safeParse(makeIngress({ spanId: sameLengthNonHex })).success,
    ).toBe(false);
  });

  it('rejects the all-zero span id the shared pattern accepts', () => {
    // A span id becomes a child's parent-id in the `traceparent` header the
    // agent injects, so the all-zero value is invalid for the same reason at
    // this width — and, as with the trace id, the shared guard says yes.
    expect(SPAN_ID_PATTERN.test(ALL_ZERO_SPAN_ID)).toBe(true);
    expect(isSpanId(ALL_ZERO_SPAN_ID)).toBe(true);

    expect(expectIngressRejected(makeIngress({ spanId: ALL_ZERO_SPAN_ID }))).toContainEqual({
      path: 'spanId',
      code: 'custom',
    });
  });

  it('accepts a span id that is mostly zeros but not all of them', () => {
    const nearlyZero = `${'0'.repeat(newSpanId().length - 1)}f`;

    expect(nearlyZero).toHaveLength(newSpanId().length);
    expect(okValue(parseTelemetryEventIngress(makeIngress({ spanId: nearlyZero }))).spanId).toBe(
      nearlyZero,
    );
  });
});

describe('parentSpanId', () => {
  it('is absent on a trace root, and stays absent', () => {
    // Absence is meaningful — it is what marks the interaction that started
    // everything — so it must never be filled in with a placeholder or turned
    // into a present-but-undefined key that becomes `null` on the wire.
    const parsed = okValue(parseTelemetryEventIngress(makeIngress()));

    expect('parentSpanId' in parsed).toBe(false);
  });

  it('accepts the span id of the operation that caused this one', () => {
    const parentSpanId = newSpanId();

    expect(okValue(parseTelemetryEventIngress(makeIngress({ parentSpanId }))).parentSpanId).toBe(
      parentSpanId,
    );
  });

  it('rejects null, because optional means absent rather than empty', () => {
    // A JSON round trip turns a present-but-undefined field into `null`, so a
    // schema that accepted `null` here would accept the artefact of a producer
    // bug as a legitimate trace root.
    const issues = expectIngressRejected(makeIngress({ parentSpanId: null }));

    expect(issues).toContainEqual({ path: 'parentSpanId', code: 'invalid_type' });
  });

  it.each(SPAN_ID_REJECTIONS)('rejects $label', ({ input, code }: RejectionCase) => {
    // The same battery as `spanId`, reported on this field's own path: both
    // fields are built by the same factory, so they cannot drift apart.
    const issues = expectIngressRejected(makeIngress({ parentSpanId: input }));

    expect(issues).toContainEqual({ path: 'parentSpanId', code });
  });

  it('refuses the all-zero span id rather than reading it as a trace root', () => {
    // The distinction this field turns on. An OpenTelemetry SDK reports the
    // all-zero span id for "no parent", and a producer forwarding it verbatim
    // is claiming a parent that does not exist — so the event is rejected,
    // which is a reported producer bug, instead of being accepted as a second
    // root that would silently split one interaction's tree in two. Omitting
    // the key is the only way to say "trace root", and `../node/convert.ts`
    // does exactly that for such a span.
    expect(expectIngressRejected(makeIngress({ parentSpanId: ALL_ZERO_SPAN_ID }))).toContainEqual({
      path: 'parentSpanId',
      code: 'custom',
    });
  });
});

describe('the opaque identifiers', () => {
  it('accepts the ids the product generates', () => {
    const id = newEventId();
    const producerId = newProducerId();

    const parsed = okValue(parseTelemetryEventIngress(makeIngress({ id, producerId })));

    expect(parsed.id).toBe(id);
    expect(parsed.producerId).toBe(producerId);
  });

  it.each(ID_REJECTIONS)('rejects an id that is $label', ({ input, path, code }: RejectionCase) => {
    const issues = expectIngressRejected(makeIngress({ id: input }));

    expect(issues).toContainEqual({ path, code });
  });

  it.each(PRODUCER_ID_REJECTIONS)(
    'rejects a producerId that is $label',
    ({ input, path, code }: RejectionCase) => {
      const issues = expectIngressRejected(makeIngress({ producerId: input }));

      expect(issues).toContainEqual({ path, code });
    },
  );

  it('rejects a padded id rather than trimming it', () => {
    // Trimming would be a transform, and a transform would break the "parse
    // returns its input" invariant that lets the service persist exactly what
    // it received. A padded id is a producer bug that gets reported.
    const padded = ` ${newEventId()} `;
    const issues = expectIngressRejected(makeIngress({ id: padded }));

    expect(issues).toContainEqual({ path: 'id', code: 'custom' });
  });

  it('accepts the same generated ids on the persisted fields', () => {
    const sessionId = newSessionId();
    const captureId = newCaptureId();

    const parsed = okValue(parseTelemetryEvent(makePersisted({ sessionId, captureId })));

    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.captureId).toBe(captureId);
  });

  it.each(ID_REJECTIONS)('rejects a sessionId that is $label', ({ input, code }: RejectionCase) => {
    const issues = expectPersistedRejected(makePersisted({ sessionId: input }));

    expect(issues).toContainEqual({ path: 'sessionId', code });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The time base
 *
 * `startTime` is Unix epoch milliseconds as a double and `duration` is
 * milliseconds — the single fact that lets the correlator order browser, server
 * and database events in one trace. The two bounds exist to reject unit
 * mistakes that produce a perfectly valid number, and the precision cases are
 * the anti-regression for any `.int()` or rounding creeping in.
 * ---------------------------------------------------------------------------
 */

describe('the epoch bounds', () => {
  it('are the documented values', () => {
    // 1_577_836_800_000 is 2020-01-01T00:00:00Z and 4_102_444_800_000 is
    // 2100-01-01T00:00:00Z. Both are published constants: a consumer that
    // validates a stored timestamp reads them from here, so a change to either
    // is a change to what the product accepts as evidence.
    expect(MIN_EPOCH_MS).toBe(1_577_836_800_000);
    expect(MAX_EPOCH_MS).toBe(4_102_444_800_000);

    expect(new Date(MIN_EPOCH_MS).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(MAX_EPOCH_MS).toISOString()).toBe('2100-01-01T00:00:00.000Z');
  });

  it('are inclusive at both ends', () => {
    expect(
      okValue(parseTelemetryEventIngress(makeIngress({ startTime: MIN_EPOCH_MS }))).startTime,
    ).toBe(MIN_EPOCH_MS);
    expect(
      okValue(parseTelemetryEventIngress(makeIngress({ startTime: MAX_EPOCH_MS }))).startTime,
    ).toBe(MAX_EPOCH_MS);
  });
});

describe('startTime', () => {
  it('preserves sub-millisecond precision exactly', () => {
    // The assertion a rounding regression cannot survive: strict equality
    // against a value with a fractional part, on both time fields. A truncated
    // render duration is the difference between "this component re-rendered 300
    // times for 0 ms" and a measurement.
    const startTime = 1_758_000_000_000.25;
    const duration = 12.345;

    const parsed = okValue(parseTelemetryEventIngress(makeIngress({ startTime, duration })));

    expect(parsed.startTime === startTime).toBe(true);
    expect(parsed.duration === duration).toBe(true);
    expect(Number.isInteger(parsed.startTime)).toBe(false);
    expect(Number.isInteger(parsed.duration)).toBe(false);
  });

  it('keeps a value the browser producer would compute', () => {
    // `performance.timeOrigin + entry.startTime` is a double with a fractional
    // part in practice; this is that shape, and it must survive untouched.
    const startTime = 1_758_000_123_456.789;

    expect(okValue(parseTelemetryEventIngress(makeIngress({ startTime }))).startTime).toBe(
      startTime,
    );
  });

  it.each(START_TIME_REJECTIONS)('rejects $label', ({ input, path, code }: RejectionCase) => {
    const issues = expectIngressRejected(makeIngress({ startTime: input }));

    expect(issues).toContainEqual({ path, code });
  });
});

describe('duration', () => {
  it('accepts zero, because an error, a state transition and a log are instants', () => {
    expect(okValue(parseTelemetryEventIngress(makeIngress({ duration: 0 }))).duration).toBe(0);
  });

  it('accepts a fractional measurement', () => {
    expect(okValue(parseTelemetryEventIngress(makeIngress({ duration: 0.125 }))).duration).toBe(
      0.125,
    );
  });

  it('accepts a duration no ceiling would allow, because slowness is the evidence', () => {
    // Deliberately no upper bound in the schema: a slow request is precisely
    // what this product exists to surface, so a ceiling here could only discard
    // the finding the developer asked about.
    const duration = 15 * 60 * 1000;

    expect(okValue(parseTelemetryEventIngress(makeIngress({ duration }))).duration).toBe(duration);
  });

  it.each(DURATION_REJECTIONS)('rejects $label', ({ input, path, code }: RejectionCase) => {
    const issues = expectIngressRejected(makeIngress({ duration: input }));

    expect(issues).toContainEqual({ path, code });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Malformed events, strictness and field semantics
 * ---------------------------------------------------------------------------
 */

describe('a malformed event', () => {
  it.each(REQUIRED_INGRESS_FIELDS)('is rejected when %s is missing', (field: string) => {
    const issues = expectIngressRejected(withoutKey(makeIngress(), field));

    expect(pathsOf(issues)).toContain(field);
    expect(issues.filter((issue) => issue.path === field).map((issue) => issue.code)).toEqual([
      absenceCodeFor(field),
    ]);
  });

  it('reports every missing field at once, so one round trip names them all', () => {
    // The ingest loop skips a malformed element and reports it (AAP 0.5.5).
    // Reporting one issue at a time would make a producer with several problems
    // take several captures to diagnose.
    const issues = expectIngressRejected({});

    expect([...pathsOf(issues)].sort()).toEqual([...REQUIRED_INGRESS_FIELDS].sort());
  });

  it.each(NON_OBJECT_REJECTIONS)(
    'is rejected when it is $label',
    ({ input, path, code }: RejectionCase) => {
      expect(expectIngressRejected(input)).toContainEqual({ path, code });
      expect(expectPersistedRejected(input)).toContainEqual({ path, code });
    },
  );

  it('is rejected when it carries an unknown top-level key', () => {
    // Strictness, and why it is worth a rejection: a producer and the service
    // that ingests it are separate builds a developer can update
    // independently, so an unrecognised field means a version mismatch — worth
    // failing at ingest, where one event is skipped, rather than at read time,
    // where a missing field looks like missing evidence.
    const issues = expectIngressRejected(makeIngress({ durationMs: 12 }));

    expect(issues).toContainEqual({ path: '', code: 'unrecognized_keys' });
  });

  it('is rejected when a stored row carries a column this build does not know', () => {
    const issues = expectPersistedRejected(makePersisted({ ingest_seq: 2 }));

    expect(issues).toContainEqual({ path: '', code: 'unrecognized_keys' });
  });
});

describe('the attributes bag', () => {
  it('accepts keys nobody declared, because it is not a whitelist', () => {
    // `./attributes.ts` declares what each kind is *expected* to carry so the
    // redactor, the aggregates and the panel catalog agree on spellings. It is
    // explicitly not a whitelist: a new signal must be able to ship without a
    // schema change, and the redactor must handle keys it has never seen.
    const attributes = { 'not.declared.anywhere': 1, alsoNew: 'value' };

    expect(okValue(parseTelemetryEventIngress(makeIngress({ attributes }))).attributes).toEqual(
      attributes,
    );
  });

  it('accepts the empty bag a producer with nothing to add sends', () => {
    const parsed = okValue(parseTelemetryEventIngress(makeIngress({ attributes: {} })));

    expect(parsed.attributes).toEqual({});
  });

  it('accepts nested plain structures', () => {
    const attributes = {
      'http.method': 'GET',
      changedProps: [{ key: 'label', changed: true }],
      nested: { depth: { deeper: [1, 2, null] } },
      flag: false,
      missing: null,
    };

    expect(okValue(parseTelemetryEventIngress(makeIngress({ attributes }))).attributes).toEqual(
      attributes,
    );
  });

  it('rejects a function value on the offending key, and only there', () => {
    // The one mistake `fiber-diff.ts` and the redactor cannot catch: a live
    // callback assigned straight onto the bag, which would either throw inside
    // `JSON.stringify` at the transport boundary or serialise to `undefined`
    // and silently disappear.
    const issues = expectIngressRejected(
      makeIngress({ attributes: { onSelect: (): void => undefined, component: 'MyComponent' } }),
    );

    expect(issues).toContainEqual({ path: 'attributes.onSelect', code: 'custom' });
    expect(pathsOf(issues)).not.toContain('attributes.component');
  });

  it('rejects a symbol value', () => {
    const issues = expectIngressRejected(makeIngress({ attributes: { marker: Symbol('marker') } }));

    expect(issues).toContainEqual({ path: 'attributes.marker', code: 'custom' });
  });

  it('reports every untransportable key in one bag', () => {
    const issues = expectIngressRejected(
      makeIngress({
        attributes: { first: (): void => undefined, second: Symbol('second'), third: 'fine' },
      }),
    );

    expect([...pathsOf(issues)].sort()).toEqual(['attributes.first', 'attributes.second']);
  });

  it('survives a cyclic attribute value instead of recursing into it', () => {
    // The check is shallow by design, and this is the reason: a producer bug
    // can easily build a cycle out of a React fiber or a DOM node, and a
    // recursive validator handed one would take the service's ingest loop with
    // it. A cycle is a value the schema accepts and the redactor cleans.
    const cyclic: Record<string, unknown> = { label: 'self-referential' };
    cyclic['self'] = cyclic;

    expect(telemetryEventIngressSchema.safeParse(makeIngress({ attributes: cyclic })).success).toBe(
      true,
    );
  });

  it.each(ATTRIBUTES_REJECTIONS)(
    'rejects a bag that is $label',
    ({ input, path, code }: RejectionCase) => {
      const issues = expectIngressRejected(makeIngress({ attributes: input }));

      expect(issues).toContainEqual({ path, code });
    },
  );
});

describe('the kind vocabulary', () => {
  for (const kind of TELEMETRY_KINDS) {
    it(`accepts "${kind}" on every tier its vocabulary permits`, () => {
      const tiers = allowedTiersFor(kind);

      expect(tiers.length).toBeGreaterThan(0);

      for (const tier of tiers) {
        const parsed = okValue(parseTelemetryEventIngress(makeIngress({ kind, tier })));

        expect(parsed.kind).toBe(kind);
        expect(parsed.tier).toBe(tier);
      }
    });
  }

  it('rejects a kind outside the closed set', () => {
    const issues = expectIngressRejected(makeIngress({ kind: 'perf.paint' }));

    expect(issues).toContainEqual({ path: 'kind', code: 'invalid_value' });
  });

  it('rejects a kind that differs only in case', () => {
    const issues = expectIngressRejected(makeIngress({ kind: 'Render' }));

    expect(issues).toContainEqual({ path: 'kind', code: 'invalid_value' });
  });

  it('rejects a non-string kind', () => {
    const issues = expectIngressRejected(makeIngress({ kind: 1 }));

    expect(pathsOf(issues)).toContain('kind');
  });
});

describe('the tier and status vocabularies', () => {
  it('accepts every tier on a kind that permits it', () => {
    for (const tier of TELEMETRY_TIERS) {
      const kind = TELEMETRY_KINDS.find((candidate) => isTierAllowedForKind(candidate, tier));

      if (kind === undefined) {
        throw new Error(`No kind may be reported on tier ${tier}`);
      }

      expect(okValue(parseTelemetryEventIngress(makeIngress({ kind, tier }))).tier).toBe(tier);
    }
  });

  it('accepts every status', () => {
    for (const status of TELEMETRY_STATUSES) {
      expect(okValue(parseTelemetryEventIngress(makeIngress({ status }))).status).toBe(status);
    }
  });

  it('rejects a tier outside the closed set', () => {
    expect(expectIngressRejected(makeIngress({ tier: 'edge' }))).toContainEqual({
      path: 'tier',
      code: 'invalid_value',
    });
  });

  it('rejects a status outside the closed set, including an OpenTelemetry spelling', () => {
    // The lower-case mirror of the OpenTelemetry codes, deliberately: `'OK'`
    // and `'ERROR'` are the OTel spellings and neither is this vocabulary.
    expect(expectIngressRejected(makeIngress({ status: 'OK' }))).toContainEqual({
      path: 'status',
      code: 'invalid_value',
    });
    expect(expectIngressRejected(makeIngress({ status: 'STATUS_CODE_ERROR' }))).toContainEqual({
      path: 'status',
      code: 'invalid_value',
    });
  });
});

describe('kind and tier must agree', () => {
  it('accepts a database span on the database tier', () => {
    const parsed = okValue(
      parseTelemetryEventIngress(makeIngress({ kind: 'db.query', tier: 'db' })),
    );

    expect(parsed.kind).toBe('db.query');
    expect(parsed.tier).toBe('db');
  });

  it('rejects a database span reported by the browser', () => {
    // The check that stands between a producer which mislabelled itself and a
    // per-tier duration that silently does not add up: this event would
    // subtract from `database_duration` and add to `frontend_duration`, and
    // every number in the panel would be wrong undetectably.
    const issues = expectIngressRejected(makeIngress({ kind: 'db.query', tier: 'browser' }));

    expect(issues).toContainEqual({ path: 'tier', code: 'custom' });
  });

  it('accepts a named function timed on either tier', () => {
    // AAP 0.5.1: function timing is the one signal that requires patching a
    // file, and it is planned per symbol on either side of the request.
    for (const tier of ['browser', 'server']) {
      expect(
        okValue(parseTelemetryEventIngress(makeIngress({ kind: 'function', tier }))).tier,
      ).toBe(tier);
    }
  });

  it('rejects a named function attributed to the datastore', () => {
    expect(expectIngressRejected(makeIngress({ kind: 'function', tier: 'db' }))).toContainEqual({
      path: 'tier',
      code: 'custom',
    });
  });

  for (const kind of TELEMETRY_KINDS) {
    const forbidden = TELEMETRY_TIERS.filter((tier) => !isTierAllowedForKind(kind, tier));

    it(`rejects "${kind}" on every tier its vocabulary forbids`, () => {
      // Mechanical rather than sampled: the table in `./kinds.ts` is the single
      // place that says which tier a kind belongs to, so every pair it forbids
      // is exercised instead of the one the plan happens to name.
      expect(forbidden.length).toBeGreaterThan(0);

      for (const tier of forbidden) {
        expect(expectIngressRejected(makeIngress({ kind, tier }))).toContainEqual({
          path: 'tier',
          code: 'custom',
        });
      }
    });
  }

  it('applies the same rule to a persisted event', () => {
    // One function, both schemas: the two can never disagree about a pair.
    expect(
      expectPersistedRejected(makePersisted({ kind: 'http.server', tier: 'browser' })),
    ).toContainEqual({ path: 'tier', code: 'custom' });
  });
});

describe('seq', () => {
  it('accepts the zero a producer starts its counter at', () => {
    expect(okValue(parseTelemetryEventIngress(makeIngress({ seq: 0 }))).seq).toBe(0);
  });

  it('accepts a counter far into a capture', () => {
    expect(okValue(parseTelemetryEventIngress(makeIngress({ seq: 4_999 }))).seq).toBe(4_999);
  });

  it.each(SEQ_REJECTIONS)('rejects $label', ({ input, path, code }: RejectionCase) => {
    expect(expectIngressRejected(makeIngress({ seq: input }))).toContainEqual({ path, code });
  });
});

describe('clockOffsetMs', () => {
  it('is absent until the producer has a usable sample', () => {
    expect('clockOffsetMs' in okValue(parseTelemetryEventIngress(makeIngress()))).toBe(false);
  });

  it.each([0, 1, -1, 437, -1_250, CLOCK_OFFSET_BOUND_MS, -CLOCK_OFFSET_BOUND_MS])(
    'accepts the whole-millisecond offset %d from a producer, unchanged',
    (clockOffsetMs: number) => {
      const input = makeIngress({ clockOffsetMs });

      expect(okValue(parseTelemetryEventIngress(input))).toEqual(input);
    },
  );

  it('is part of the core both schemas share, so the store keeps what the producer sent', () => {
    const persisted = makePersisted({ clockOffsetMs: -42 });

    expect(okValue(parseTelemetryEvent(persisted)).clockOffsetMs).toBe(-42);
  });

  it('is never an attribution field: a producer may send it', () => {
    expect(Object.keys(telemetryEventIngressSchema.shape)).toContain('clockOffsetMs');
    expect(ATTRIBUTION_FIELDS).not.toContain('clockOffsetMs');
  });

  it.each(CLOCK_OFFSET_REJECTIONS)('rejects $label', ({ input, path, code }: RejectionCase) => {
    expect(expectIngressRejected(makeIngress({ clockOffsetMs: input }))).toContainEqual({
      path,
      code,
    });
    expect(expectPersistedRejected(makePersisted({ clockOffsetMs: input }))).toContainEqual({
      path,
      code,
    });
  });
});

describe('source', () => {
  it('accepts the shape @debuggen/shared defines, unchanged', () => {
    const parsed = okValue(parseTelemetryEventIngress(makeIngress({ source: SOURCE })));

    expect(parsed.source).toEqual(SOURCE);
  });

  it('accepts a location with only the required fields', () => {
    const minimal: SourceLocation = {
      file: 'src/lib/thing.ts',
      line: 1,
      column: 1,
      resolvedBy: 'code-graph',
      confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
    };

    expect(okValue(parseTelemetryEventIngress(makeIngress({ source: minimal }))).source).toEqual(
      minimal,
    );
  });

  it('is absent when no resolver could commit to a location', () => {
    // A resolver that cannot say omits the field rather than guessing, so its
    // presence is what makes a runtime item clickable through to the editor.
    expect('source' in okValue(parseTelemetryEventIngress(makeIngress()))).toBe(false);
  });

  it.each(SOURCE_REJECTIONS)('rejects $label', ({ input, path, code }: RejectionCase) => {
    expect(expectIngressRejected(makeIngress({ source: input }))).toContainEqual({ path, code });
  });
});

describe('redacted', () => {
  it('is absent when the privacy layer replaced nothing', () => {
    // Absence means "nothing was redacted", which is why the field is optional
    // rather than defaulted to an empty list.
    expect('redacted' in okValue(parseTelemetryEventIngress(makeIngress()))).toBe(false);
  });

  it('accepts an empty list', () => {
    expect(okValue(parseTelemetryEventIngress(makeIngress({ redacted: [] }))).redacted).toEqual([]);
  });

  it('accepts the attribute paths the redactor replaced', () => {
    const redacted = ['attributes.authorization', 'attributes.url'];

    expect(okValue(parseTelemetryEventIngress(makeIngress({ redacted }))).redacted).toEqual(
      redacted,
    );
  });

  it.each(REDACTED_REJECTIONS)('rejects $label', ({ input, path, code }: RejectionCase) => {
    expect(expectIngressRejected(makeIngress({ redacted: input }))).toContainEqual({ path, code });
  });
});

describe('parsing', () => {
  it('returns an object deep-equal to its input, field for field', () => {
    // The invariant that lets the service persist exactly what a producer
    // observed rather than a normalised retelling of it: no `.transform()`, no
    // `.coerce`, no `.default()` and no `.catch()` anywhere in `./event.ts`. A
    // fully populated event is used because those four would most plausibly
    // touch the optional fields and the nested bag.
    const before = structuredClone(FULL_EVENT);

    const parsed = okValue(parseTelemetryEvent(FULL_EVENT));

    expect(parsed).toStrictEqual(FULL_EVENT);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(FULL_EVENT).sort());
    expect(parsed.attributes).toStrictEqual(FULL_EVENT.attributes);
    expect(parsed.source).toStrictEqual(SOURCE);
    expect(parsed.redacted).toStrictEqual(['attributes.authorization']);

    // And the input itself is untouched: a schema that mutated what it was
    // handed would corrupt the batch the caller is still iterating.
    expect(FULL_EVENT).toStrictEqual(before);
  });

  it('invents no field a producer did not send', () => {
    const candidate = makeIngress();
    const parsed = okValue(parseTelemetryEventIngress(candidate));

    expect(Object.keys(parsed).sort()).toEqual(Object.keys(candidate).sort());
  });

  it('returns Ok for a valid event and Err for an invalid one', () => {
    const valid = parseTelemetryEventIngress(makeIngress());
    const invalid = parseTelemetryEventIngress(makeIngress({ seq: -1 }));

    expect(isOk(valid)).toBe(true);
    expect(isErr(valid)).toBe(false);
    expect(isErr(invalid)).toBe(true);
    expect(isOk(invalid)).toBe(false);
  });

  it('never throws, so one malformed element cannot end a capture', () => {
    // AAP 0.5.5: the ingest loop skips the offending element, reports it and
    // keeps the capture, which is only possible if parsing is non-throwing for
    // every input — including the ones that are not objects at all.
    const hostile: readonly unknown[] = [
      undefined,
      null,
      'interaction',
      [makeIngress()],
      makeIngress({ attributes: { fn: (): void => undefined } }),
      makeIngress({ startTime: Number.NaN }),
    ];

    for (const candidate of hostile) {
      expect(() => parseTelemetryEventIngress(candidate)).not.toThrow();
      expect(() => parseTelemetryEvent(candidate)).not.toThrow();
      expect(() => isTelemetryEventIngress(candidate)).not.toThrow();
      expect(() => isTelemetryEvent(candidate)).not.toThrow();
    }
  });

  it('carries the hint a producer needs on an ingress failure', () => {
    const error = errorOf(parseTelemetryEventIngress(makeIngress({ traceId: 'short' })));

    expect(error.code).toBe(REJECTION_CODE);
    expect(error.hint).toContain('sessionId, captureId and ingestSeq are assigned by the service');
    expect(error.details?.['schema']).toBe(INGRESS_SCHEMA_NAME);
  });

  it('carries the hint a service needs on a persisted failure', () => {
    const error = errorOf(parseTelemetryEvent(withoutKey(makePersisted(), 'captureId')));

    expect(error.hint).toContain('sessionId, captureId and a one-based ingestSeq');
    expect(error.details?.['schema']).toBe(PERSISTED_SCHEMA_NAME);
  });

  it('reports the expected type on a mismatch, and nothing more', () => {
    const error = errorOf(parseTelemetryEventIngress(makeIngress({ duration: '5' })));
    const raw: unknown = error.details?.['issues'];

    if (!isRecordArray(raw)) {
      throw new Error('Expected details.issues to be an array of objects');
    }

    const durationIssue = raw.find((issue) => issue['path'] === 'duration');

    expect(durationIssue?.['code']).toBe('invalid_type');
    expect(durationIssue?.['expected']).toBe('number');
    expect(Object.keys(durationIssue ?? {}).sort()).toEqual(['code', 'expected', 'path']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Privacy of validation failures (AAP 0.5.2)
 *
 * A rejected event can carry request URLs, header values, database statements
 * or React prop previews, and the error built from it is logged, may be
 * persisted with the session and may be shown in both user interfaces. An error
 * raised this deep in the call stack passes through neither the redaction layer
 * nor the outbound model guard, so the only safe rule is that captured data
 * never enters it.
 * ---------------------------------------------------------------------------
 */

describe('a validation failure', () => {
  it.each(SENTINEL_CASES)('carries no captured data for $label', ({ overrides }: OverrideCase) => {
    const error = errorOf(parseTelemetryEventIngress(makeIngress(overrides)));

    const wholePayload = JSON.stringify({
      code: error.code,
      message: error.message,
      hint: error.hint,
      details: error.details,
      payload: error.toPayload(),
    });

    expect(error.message).not.toContain(LEAK_SENTINEL);
    expect(error.hint ?? '').not.toContain(LEAK_SENTINEL);
    expect(JSON.stringify(error.details)).not.toContain(LEAK_SENTINEL);
    expect(JSON.stringify(error.toPayload())).not.toContain(LEAK_SENTINEL);
    expect(wholePayload).not.toContain(LEAK_SENTINEL);

    // Neither of the two members that would carry a rejected value may exist,
    // whatever the issue code: zod strips a finalized issue's `input` unless a
    // parse context asks for it, and no parse in `./event.ts` asks.
    expect(wholePayload).not.toContain('"received"');
    expect(wholePayload).not.toContain('"input"');
  });

  it('carries no captured data when the whole value is the secret', () => {
    // The route the override table cannot express: there is no object to hang a
    // path on, so the issue is reported on the value itself — and the value is
    // precisely what must not travel.
    const error = errorOf(parseTelemetryEventIngress(LEAK_SENTINEL));

    expect(error.message).not.toContain(LEAK_SENTINEL);
    expect(JSON.stringify(error.details)).not.toContain(LEAK_SENTINEL);
    expect(issuesOf(error)).toContainEqual({ path: '', code: 'invalid_type' });
  });

  it('still identifies the problem usefully', () => {
    // Privacy must not cost diagnosability: the field path and the issue code
    // are what a developer acts on, and both survive the reduction.
    const issues = expectIngressRejected(
      makeIngress({ traceId: 'not-a-trace-id', attributes: { authorization: LEAK_SENTINEL } }),
    );

    expect(issues).toContainEqual({ path: 'traceId', code: 'invalid_format' });

    for (const issue of issues) {
      expect(issue.code.length).toBeGreaterThan(0);
    }
  });

  it('attaches nothing to details beyond the schema name and the issue list', () => {
    const error = errorOf(parseTelemetryEventIngress(makeIngress({ traceId: 'short' })));

    expect(Object.keys(error.details ?? {}).sort()).toEqual(['issues', 'schema']);
  });

  it('keeps a secret out of a persisted failure as well', () => {
    const error = errorOf(
      parseTelemetryEvent(
        makePersisted({ ingestSeq: 0, attributes: { 'db.statement': LEAK_SENTINEL } }),
      ),
    );

    expect(JSON.stringify(error.details)).not.toContain(LEAK_SENTINEL);
    expect(issuesOf(error)).toContainEqual({ path: 'ingestSeq', code: 'too_small' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The kind, tier and status vocabularies (`./kinds.ts`)
 *
 * These declarations have no other test home. The compiler already makes the
 * two lookup tables total over the closed kind union; what it cannot see is
 * whether the membership still matches the plan and whether each named group
 * still holds the kinds its consumers filter on. The expected lists below are
 * therefore written out as data — they are the independent copy that makes an
 * accidental edit to `./kinds.ts` fail here.
 * ---------------------------------------------------------------------------
 */

/** The seventeen kinds of AAP 0.2.3, in the order that section lists them. */
const CANONICAL_KINDS: readonly string[] = [
  'interaction',
  'render',
  'commit',
  'fetch',
  'xhr',
  'navigation',
  'perf.longtask',
  'perf.entry',
  'error',
  'state',
  'http.server',
  'route.handler',
  'function',
  'db.query',
  'http.client',
  'server.error',
  'log',
];

/**
 * The tier each kind may be reported in, restated from AAP 0.2.3 and 0.5.1.
 *
 * The four rules the table encodes: everything the page agent observes is
 * `browser`; everything the dev-server preload observes about request handling
 * is `server`; a database span is tiered by its subject, `db`; and the two
 * cross-tier kinds — a named function, which can be timed on either side of the
 * request, and a correlated log record — are `browser` or `server`.
 */
const CANONICAL_KIND_TIERS: Readonly<Record<string, readonly string[]>> = {
  interaction: ['browser'],
  render: ['browser'],
  commit: ['browser'],
  fetch: ['browser'],
  xhr: ['browser'],
  navigation: ['browser'],
  'perf.longtask': ['browser'],
  'perf.entry': ['browser'],
  error: ['browser'],
  state: ['browser'],
  'http.server': ['server'],
  'route.handler': ['server'],
  function: ['browser', 'server'],
  'db.query': ['db'],
  'http.client': ['server'],
  'server.error': ['server'],
  log: ['browser', 'server'],
};

/** Values no vocabulary member may be, for the guard rejection cases. */
const NON_MEMBERS: readonly unknown[] = [
  '',
  ' ',
  'nope',
  1,
  0,
  true,
  null,
  undefined,
  {},
  [],
  Symbol('member'),
];

describe('TELEMETRY_KINDS', () => {
  it('lists exactly the seventeen kinds of the plan, in its order', () => {
    expect([...TELEMETRY_KINDS]).toEqual(CANONICAL_KINDS);
    expect(TELEMETRY_KINDS).toHaveLength(17);
  });

  it('contains no duplicate', () => {
    expect(new Set(TELEMETRY_KINDS).size).toBe(TELEMETRY_KINDS.length);
  });

  it('is frozen, because three runtimes share it as a read-only vocabulary', () => {
    expect(Object.isFrozen(TELEMETRY_KINDS)).toBe(true);
  });

  it('is exactly the set the schema and the guard accept', () => {
    for (const kind of CANONICAL_KINDS) {
      expect(isTelemetryKind(kind)).toBe(true);
    }
  });
});

describe('TELEMETRY_TIERS and TELEMETRY_STATUSES', () => {
  it('name the three tiers, in the order the timeline lanes use', () => {
    expect([...TELEMETRY_TIERS]).toEqual(['browser', 'server', 'db']);
  });

  it('name the three statuses, as the lower-case mirror of the OTel codes', () => {
    expect([...TELEMETRY_STATUSES]).toEqual(['unset', 'ok', 'error']);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(TELEMETRY_TIERS)).toBe(true);
    expect(Object.isFrozen(TELEMETRY_STATUSES)).toBe(true);
  });
});

describe('OTEL_STATUS_CODE_TO_STATUS', () => {
  it('maps the three OpenTelemetry span status codes onto this vocabulary', () => {
    const unset: TelemetryStatus = OTEL_STATUS_CODE_TO_STATUS[0];
    const ok: TelemetryStatus = OTEL_STATUS_CODE_TO_STATUS[1];
    const failed: TelemetryStatus = OTEL_STATUS_CODE_TO_STATUS[2];

    expect(unset).toBe('unset');
    expect(ok).toBe('ok');
    expect(failed).toBe('error');
  });

  it('produces only values the event schema accepts', () => {
    for (const code of [0, 1, 2] as const) {
      const status = OTEL_STATUS_CODE_TO_STATUS[code];

      expect(isTelemetryStatus(status)).toBe(true);
      expect(okValue(parseTelemetryEventIngress(makeIngress({ status }))).status).toBe(status);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(OTEL_STATUS_CODE_TO_STATUS)).toBe(true);
  });
});

describe('the vocabulary guards', () => {
  it('accept every member of their own vocabulary', () => {
    for (const kind of TELEMETRY_KINDS) {
      expect(isTelemetryKind(kind)).toBe(true);
    }
    for (const tier of TELEMETRY_TIERS) {
      expect(isTelemetryTier(tier)).toBe(true);
    }
    for (const status of TELEMETRY_STATUSES) {
      expect(isTelemetryStatus(status)).toBe(true);
    }
  });

  it('reject a non-member and a non-string', () => {
    for (const value of NON_MEMBERS) {
      expect(isTelemetryKind(value)).toBe(false);
      expect(isTelemetryTier(value)).toBe(false);
      expect(isTelemetryStatus(value)).toBe(false);
    }
  });

  it('reject an uppercase variant of a real member', () => {
    // Case matters: the three vocabularies are lower-case by contract, and an
    // OpenTelemetry-style `'OK'` or a display-cased `'Render'` is a producer
    // that has not normalised its value.
    for (const kind of TELEMETRY_KINDS) {
      expect(isTelemetryKind(kind.toUpperCase())).toBe(false);
    }
    for (const tier of TELEMETRY_TIERS) {
      expect(isTelemetryTier(tier.toUpperCase())).toBe(false);
    }
    for (const status of TELEMETRY_STATUSES) {
      expect(isTelemetryStatus(status.toUpperCase())).toBe(false);
    }
  });

  it('narrow a value they accept', () => {
    const candidate: unknown = 'route.handler';

    if (!isTelemetryKind(candidate)) {
      throw new Error('Expected "route.handler" to be a member of the kind vocabulary');
    }

    // Reachable only because the guard narrowed `candidate` to `TelemetryKind`,
    // which is what `allowedTiersFor` demands.
    expect(allowedTiersFor(candidate)).toEqual(['server']);
  });
});

describe('KIND_ALLOWED_TIERS', () => {
  it('assigns every kind the tiers the plan gives it', () => {
    expect(Object.keys(KIND_ALLOWED_TIERS).sort()).toEqual([...CANONICAL_KINDS].sort());

    for (const kind of TELEMETRY_KINDS) {
      expect([...KIND_ALLOWED_TIERS[kind]]).toEqual(CANONICAL_KIND_TIERS[kind]);
    }
  });

  it('gives every kind a non-empty list of real tiers', () => {
    for (const kind of TELEMETRY_KINDS) {
      const tiers = KIND_ALLOWED_TIERS[kind];

      expect(tiers.length).toBeGreaterThan(0);

      for (const tier of tiers) {
        expect(isTelemetryTier(tier)).toBe(true);
      }
    }
  });

  it('agrees with allowedTiersFor and isTierAllowedForKind, kind by kind', () => {
    // Three ways of asking one question. The schema's cross-field check uses
    // the last two, so a disagreement here would be a disagreement between the
    // table a maintainer edits and the rule the ingest path enforces.
    for (const kind of TELEMETRY_KINDS) {
      expect(allowedTiersFor(kind)).toBe(KIND_ALLOWED_TIERS[kind]);

      for (const tier of TELEMETRY_TIERS) {
        expect(isTierAllowedForKind(kind, tier)).toBe(KIND_ALLOWED_TIERS[kind].includes(tier));
      }
    }
  });

  it('keeps exactly two kinds cross-tier', () => {
    const crossTier = TELEMETRY_KINDS.filter((kind) => allowedTiersFor(kind).length > 1);

    expect([...crossTier]).toEqual(['function', 'log']);
  });

  it('is frozen, table and entries alike', () => {
    expect(Object.isFrozen(KIND_ALLOWED_TIERS)).toBe(true);

    for (const kind of TELEMETRY_KINDS) {
      expect(Object.isFrozen(KIND_ALLOWED_TIERS[kind])).toBe(true);
    }
  });
});

describe('the named kind groups', () => {
  it('REQUEST_KINDS holds the two requests a page initiates', () => {
    // Server-side outgoing requests are deliberately excluded: a duplicate
    // there is a different finding with a different remedy.
    expect([...REQUEST_KINDS]).toEqual(['fetch', 'xhr']);
  });

  it('WATERFALL_KINDS is the waterfall filter of the design system', () => {
    // AAP 0.6.2: the one group that spans all three tiers, because the
    // waterfall is where a single request's cost is attributed across them.
    expect([...WATERFALL_KINDS]).toEqual([
      'fetch',
      'xhr',
      'http.server',
      'db.query',
      'http.client',
    ]);
  });

  it('RENDER_KINDS holds the rendering work the render metrics count', () => {
    expect([...RENDER_KINDS]).toEqual(['render', 'commit']);
  });

  it('PERF_KINDS holds the performance-timeline entries', () => {
    expect([...PERF_KINDS]).toEqual(['perf.longtask', 'perf.entry']);
  });

  it('ERROR_KINDS holds the two kinds whose subject is a failure', () => {
    expect([...ERROR_KINDS]).toEqual(['error', 'server.error']);
  });

  it('QUERY_KINDS and STATE_KINDS hold their single members', () => {
    expect([...QUERY_KINDS]).toEqual(['db.query']);
    expect([...STATE_KINDS]).toEqual(['state']);
  });

  it('names only kinds the vocabulary declares, and is frozen', () => {
    const groups = [
      REQUEST_KINDS,
      WATERFALL_KINDS,
      RENDER_KINDS,
      PERF_KINDS,
      ERROR_KINDS,
      QUERY_KINDS,
      STATE_KINDS,
    ];

    for (const group of groups) {
      expect(Object.isFrozen(group)).toBe(true);
      expect(new Set(group).size).toBe(group.length);

      for (const kind of group) {
        expect(isTelemetryKind(kind)).toBe(true);
        expect(TELEMETRY_KINDS).toContain(kind);
      }
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The attribute catalog (`./attributes.ts`)
 *
 * The sibling `./attributes.test.ts` owns the metric-id vocabulary and
 * delegates the rest here. What follows is that delegation: the registry's
 * totality, the key sets four panel nodes read, the two published privacy
 * bounds and the value vocabularies the render metrics are defined in terms of.
 * ---------------------------------------------------------------------------
 */

describe('KIND_ATTRIBUTE_KEYS', () => {
  it('declares keys for all seventeen kinds and nothing else', () => {
    expect(Object.keys(KIND_ATTRIBUTE_KEYS).sort()).toEqual([...CANONICAL_KINDS].sort());
  });

  it('declares no duplicate and no empty key in any entry', () => {
    for (const kind of TELEMETRY_KINDS) {
      const keys = KIND_ATTRIBUTE_KEYS[kind];

      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);

      for (const key of keys) {
        expect(key.trim()).toBe(key);
        expect(key.length).toBeGreaterThan(0);
      }
    }
  });

  it('is what attributeKeysFor returns, without copying', () => {
    // The accessor consumers use instead of reaching into the registry; its
    // default path is documented as allocation-free, so it must hand back the
    // frozen tuple itself.
    for (const kind of TELEMETRY_KINDS) {
      expect(attributeKeysFor(kind)).toBe(KIND_ATTRIBUTE_KEYS[kind]);
    }
  });

  it('appends the cross-kind keys only when asked', () => {
    for (const kind of TELEMETRY_KINDS) {
      expect([...attributeKeysFor(kind, { includeCommon: true })]).toEqual([
        ...KIND_ATTRIBUTE_KEYS[kind],
        ...COMMON_ATTRIBUTE_KEYS,
      ]);
      expect([...attributeKeysFor(kind, { includeCommon: false })]).toEqual([
        ...KIND_ATTRIBUTE_KEYS[kind],
      ]);
    }
  });

  it('points at the tuples the module exports rather than at copies of them', () => {
    expect(KIND_ATTRIBUTE_KEYS.render).toBe(RENDER_ATTRIBUTE_KEYS);
    expect(KIND_ATTRIBUTE_KEYS.fetch).toBe(FETCH_ATTRIBUTE_KEYS);
    expect(KIND_ATTRIBUTE_KEYS['db.query']).toBe(DB_QUERY_ATTRIBUTE_KEYS);
  });

  it('is frozen, table and entries alike', () => {
    expect(Object.isFrozen(KIND_ATTRIBUTE_KEYS)).toBe(true);

    for (const kind of TELEMETRY_KINDS) {
      expect(Object.isFrozen(KIND_ATTRIBUTE_KEYS[kind])).toBe(true);
    }
  });
});

describe('the attribute keys the panel contract reads', () => {
  it('declares what the render table and the component tree read', () => {
    // AAP 0.2.3 and 0.6.2: component, render count, total and average time,
    // trigger and changed props. The first five are these keys; the timings are
    // computed by the aggregates from `actualDuration` and the event durations.
    expect(KIND_ATTRIBUTE_KEYS.render).toEqual(
      expect.arrayContaining(['component', 'phase', 'renderCount', 'changedProps', 'trigger']),
    );
  });

  it('declares what the request table and the waterfall read', () => {
    expect(KIND_ATTRIBUTE_KEYS.fetch).toEqual(
      expect.arrayContaining(['http.method', 'url', 'http.status_code', 'initiator']),
    );
  });

  it('declares the same keys for the other request transport', () => {
    // Both kinds describe a request the page made and every consumer treats
    // them together, so a key added to one and not the other would make the
    // request table's columns depend on which transport the page happened to
    // use.
    expect([...KIND_ATTRIBUTE_KEYS.xhr]).toEqual([...KIND_ATTRIBUTE_KEYS.fetch]);
  });

  it('declares what the query table reads, and nothing about row contents', () => {
    expect(KIND_ATTRIBUTE_KEYS['db.query']).toEqual(
      expect.arrayContaining(['db.system', 'db.statement', 'db.rowCount']),
    );

    // AAP 0.5.2: only a row *count* is observable, never row contents.
    for (const key of KIND_ATTRIBUTE_KEYS['db.query']) {
      expect(key).not.toBe('db.rows');
      expect(key).not.toBe('db.parameters');
    }
  });

  it('declares the three lineage keys exactly, and in no per-kind entry', () => {
    // These answer "what did the pipeline record about this event", which is a
    // different question from "what does this kind describe about itself" — and
    // has a different writer, which is why they appear in no per-kind tuple.
    expect([...LINEAGE_ATTRIBUTE_KEYS]).toEqual([
      'lineage',
      'lineageAmbiguous',
      'lineageCandidates',
    ]);

    for (const kind of TELEMETRY_KINDS) {
      for (const lineageKey of LINEAGE_ATTRIBUTE_KEYS) {
        expect(KIND_ATTRIBUTE_KEYS[kind]).not.toContain(lineageKey);
      }
    }
  });

  it('offers every declared key as an attribute the schema accepts', () => {
    // The catalog is a declaration, not a whitelist, and the schema validates
    // values rather than key names — so every key it declares must be usable.
    for (const kind of TELEMETRY_KINDS) {
      const attributes = Object.fromEntries(
        attributeKeysFor(kind, { includeCommon: true }).map((key) => [key, 'value']),
      );
      const tier = allowedTiersFor(kind)[0];

      expect(
        okValue(parseTelemetryEventIngress(makeIngress({ kind, tier, attributes }))).attributes,
      ).toEqual(attributes);
    }
  });
});

describe('the published privacy bounds', () => {
  it('are the documented numbers', () => {
    // AAP 0.5.2 ("values truncated to 120 characters") and AAP 0.7.1 ("bounded
    // to 32 keys, values summarised as type + 120-character redacted
    // preview"). Both are guarantees stated in `docs/SECURITY.md`, so a change
    // to either is a change to a published promise rather than a tuning knob.
    expect(MAX_TRACKED_KEYS).toBe(32);
    expect(MAX_PREVIEW_LENGTH).toBe(120);
  });
});

describe('the value vocabularies', () => {
  it('names the five render triggers, in order', () => {
    // Load-bearing, and not interchangeable: `unchanged_render_count` counts
    // renders whose props, own hook state and consumed context values were all
    // unchanged, while `render_trigger_unknown_count` counts the ones where any
    // of the three could not be evaluated. An `unknown` render must never be
    // counted as `unchanged` — that would report a memoization bug the
    // developer does not have — so collapsing the last two members here would
    // silently corrupt both metrics.
    expect([...RENDER_TRIGGERS]).toEqual(['props', 'state', 'context', 'unchanged', 'unknown']);
  });

  it('names the two render phases and no third', () => {
    // A fiber with no alternate is a mount, one with an alternate is an update.
    // There is deliberately no unmount phase: an unmounted fiber renders
    // nothing, so it produces no render event to phase.
    expect([...RENDER_PHASES]).toEqual(['mount', 'update']);
  });

  it('names the continuation lineage value', () => {
    expect([...LINEAGE_VALUES]).toContain('async-continuation');
  });

  it('is frozen vocabulary by vocabulary', () => {
    expect(Object.isFrozen(RENDER_TRIGGERS)).toBe(true);
    expect(Object.isFrozen(RENDER_PHASES)).toBe(true);
    expect(Object.isFrozen(LINEAGE_VALUES)).toBe(true);
    expect(Object.isFrozen(LINEAGE_ATTRIBUTE_KEYS)).toBe(true);
    expect(Object.isFrozen(COMMON_ATTRIBUTE_KEYS)).toBe(true);
  });

  it('carries every trigger and phase through the event schema', () => {
    for (const trigger of RENDER_TRIGGERS) {
      for (const phase of RENDER_PHASES) {
        const attributes = { component: 'MyComponent', phase, trigger, renderCount: 4 };
        const parsed = okValue(
          parseTelemetryEventIngress(
            makeIngress({ kind: 'render', tier: 'browser', name: 'MyComponent', attributes }),
          ),
        );

        expect(parsed.attributes).toEqual(attributes);
      }
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The committed corpora (`../../test/fixtures/event-*.json`)
 *
 * Everything above proves the schemas against inputs this file authored. That
 * is the right way to reach an edge case, and the wrong way to establish that
 * the samples the rest of the repository ships are still the shape those
 * schemas accept: three JSON corpora are committed under
 * `packages/telemetry/test/fixtures/`, they are the curated redacted samples
 * AAP §0.9.1 ships as part of this package, and a corpus nothing executes is a document
 * rather than evidence.
 *
 * What the three files are, and the question each answers here:
 *
 * - `event-ingress-batch.json` — one capture's worth of producer events across
 *   both producers of AAP §0.2.3 (a browser agent and a Node preload) and all
 *   three tiers, carrying every `source.resolvedBy` route the product
 *   implements and the `redacted` marker the privacy layer leaves behind. Does
 *   the producer contract still accept what a producer sends, field for field?
 * - `event-persisted-batch.json` — the same events, in the same order, as the
 *   store holds them after attribution. Is the difference between a batch and
 *   its stored form *exactly* the three fields the service assigns?
 * - `event-invalid-cases.json` — an object of named producer bugs, each name a
 *   claim about why the event is invalid. Is every one of them still rejected,
 *   and still rejected *for the reason its name states*?
 *
 * Two mechanical properties are asserted on top of the per-event ones, both
 * aimed at silent shrinkage rather than at the schemas: the size of each
 * corpus is pinned, and the invalid corpus' case names are compared as an
 * exact ordered set against the table that drives them. A fixture that loses a
 * case therefore fails here instead of reducing this suite to whatever
 * survived.
 * ---------------------------------------------------------------------------
 */

/**
 * The directory the three corpora live in, resolved from this module's own
 * location so the suite behaves identically whether Vitest is invoked on this
 * file, on the package or on the repository root.
 *
 * The resolution is `fileURLToPath` **then** `join`, deliberately not
 * `new URL('../../test/fixtures/x.json', import.meta.url)` — the tidier
 * one-liner that `../../tsconfig.json` suggests in prose, and that does not
 * work here: the `telemetry` project runs under happy-dom, whose global `URL`
 * resolves a relative specifier against the document's origin instead of
 * against the `file:` base it was handed, and `readFileSync` then fails with
 * "The URL must be of scheme file". Converting the module URL to a path first
 * makes the rest pure path arithmetic, independent of the DOM environment —
 * the same reasoning, and the same shape, as `../redaction/rules.test.ts` and
 * `./attributes.test.ts`.
 *
 * The corpora are *read*, never `import`ed. This package's `tsconfig.json`
 * sets `rootDir` to `src` and excludes `test/**`, so a JSON import would not
 * compile from here; more importantly it would hand the suite a literal typed
 * by the fixture, and a fixture checked against a type derived from itself
 * proves nothing. Read as text and parsed as `unknown`, every field below is
 * vouched for by the schema or by a guard in this file.
 */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

/**
 * The parsed contents of one committed corpus.
 *
 * Both failure modes throw with the resolved path in the message, because both
 * mean the corpus is gone rather than that the schema is wrong: a suite that
 * answered an unreadable file with an empty case list would pass while the
 * evidence it exists to drive had been deleted or moved.
 *
 * @param fileName The corpus file name, relative to {@link FIXTURES_DIR}.
 * @returns Its parsed JSON, untyped — nothing has vouched for it yet.
 */
function readFixture(fileName: string): unknown {
  const fixturePath = join(FIXTURES_DIR, fileName);
  let text: string;

  try {
    text = readFileSync(fixturePath, 'utf8');
  } catch (cause) {
    throw new Error(
      `the committed corpus ${fileName} could not be read at ${fixturePath}. It is the evidence ` +
        'the cases below drive; if it has moved, point this suite at its new location rather ' +
        'than dropping the cases.',
      { cause },
    );
  }

  try {
    // Annotated rather than asserted: `JSON.parse` is typed `any`, and the
    // annotation is what stops that `any` from spreading into the corpus
    // handling below. The guards in this file take it from there.
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch (cause) {
    throw new Error(`the committed corpus ${fileName} at ${fixturePath} is not valid JSON.`, {
      cause,
    });
  }
}

/**
 * Whether a value is a plain object, so its members can be reached as
 * `unknown`.
 *
 * The object counterpart of {@link isRecordArray}, and written for the same
 * reason: it is what lets the named corpus be indexed without a type
 * assertion, keeping every case that reaches a schema an unvouched-for value.
 *
 * @param value Any value, typically a parsed corpus.
 * @returns `true` for a non-null, non-array object.
 */
function isRecordOfUnknown(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One corpus as a list of candidate events.
 *
 * @param fileName The corpus file name.
 * @returns Its elements, each an untyped {@link Candidate} bag.
 */
function readEventBatch(fileName: string): readonly Candidate[] {
  const parsed = readFixture(fileName);

  if (!isRecordArray(parsed)) {
    throw new Error(`the committed corpus ${fileName} must hold an array of event objects.`);
  }

  return parsed;
}

/**
 * The named-case corpus as a record of candidates.
 *
 * @param fileName The corpus file name.
 * @returns Its cases, keyed by the name each one claims.
 */
function readNamedCases(fileName: string): Readonly<Record<string, unknown>> {
  const parsed = readFixture(fileName);

  if (!isRecordOfUnknown(parsed)) {
    throw new Error(`the committed corpus ${fileName} must hold an object of named cases.`);
  }

  return parsed;
}

/** One capture's producer events, as the browser agent and the preload send them. */
const INGRESS_BATCH = readEventBatch('event-ingress-batch.json');

/** The same events as the store holds them, after attribution at ingest. */
const PERSISTED_BATCH = readEventBatch('event-persisted-batch.json');

/** The named producer bugs, keyed by the reason each name claims. */
const INVALID_CASES = readNamedCases('event-invalid-cases.json');

/**
 * How many events each valid corpus holds.
 *
 * Written here as a number rather than derived from the file, so that removing
 * an event from either corpus is a failing assertion instead of a quietly
 * smaller loop. The two corpora are the same batch before and after
 * attribution, so one constant governs both.
 */
const BATCH_SIZE = 10;

/**
 * How many named cases the invalid corpus holds.
 *
 * Pinned for the same reason, and checked twice over: against the file's key
 * count and against the length of {@link INVALID_FIXTURE_CASES}, which is what
 * makes "the table drives every case in the file" an assertion rather than an
 * assumption.
 */
const INVALID_CASE_COUNT = 14;

/**
 * The event at `index`, or a failure naming the corpus.
 *
 * `noUncheckedIndexedAccess` is in force, so an indexed read is
 * possibly-undefined; narrowing it by throwing keeps the comparison loops free
 * of optional chaining that would silently skip a missing event — which is
 * precisely the drift being guarded.
 *
 * @param batch The corpus to read from.
 * @param index The position to read.
 * @param corpus The file name, for the failure message.
 * @returns The event at that position.
 */
function eventAt(batch: readonly Candidate[], index: number, corpus: string): Candidate {
  const event = batch[index];

  if (event === undefined) {
    throw new Error(`${corpus} holds no event at index ${String(index)}`);
  }

  return event;
}

/**
 * The named case `name`, or a failure naming the corpus.
 *
 * Returns `unknown`: an invalid case must reach the schemas with nothing having
 * vouched for it, which is the same rule {@link Candidate} enforces for the
 * hand-built cases above.
 *
 * @param name The case name the table asks for.
 * @returns That case's value, untyped.
 */
function invalidCase(name: string): unknown {
  if (!Object.hasOwn(INVALID_CASES, name)) {
    throw new Error(
      `event-invalid-cases.json no longer holds a case named "${name}". The case is what the ` +
        'assertion below is about; restore it in the corpus rather than removing the row.',
    );
  }

  return INVALID_CASES[name];
}

/**
 * One named case of the invalid corpus, with the issue each schema must report
 * for it.
 *
 * The two issue members are what turns "it was rejected" into "it was rejected
 * for the reason its name claims": a `traceIdTooShort` case that happened to
 * fail on `status` would still be a rejection and would still be worthless as
 * coverage of the trace-id format.
 */
interface InvalidFixtureCase {
  /** The key the case is stored under, and the claim its name makes. */
  readonly name: string;
  /** What is wrong with the event, for the failure message. */
  readonly reason: string;
  /** The issue the ingress rejection must report. */
  readonly ingressIssue: ReportedIssue;
  /**
   * The issue the persisted rejection must report.
   *
   * The same issue as `ingressIssue` wherever the defect is in a field both
   * schemas declare and a *field* schema is what reports it. Two rows differ,
   * for two different measured reasons, and each says so in its own comment:
   * `ingressCarriesSessionId` (the defect is legal in the persisted shape) and
   * `tierNotAllowedForKind` (the cross-field check never runs, because every
   * case in this corpus is ingress-shaped and therefore already has field
   * issues under the persisted schema).
   */
  readonly persistedIssue: ReportedIssue;
}

/**
 * The fourteen named cases, each with the issue its name commits the schemas to
 * reporting.
 *
 * Order matters: the ordered key comparison below is what catches a case being
 * renamed, reordered or replaced rather than merely removed.
 */
const INVALID_FIXTURE_CASES: readonly InvalidFixtureCase[] = [
  {
    name: 'traceIdTooShort',
    reason: 'a 31-character traceId, one hex digit short of a W3C trace id',
    ingressIssue: { path: 'traceId', code: 'invalid_format' },
    persistedIssue: { path: 'traceId', code: 'invalid_format' },
  },
  {
    name: 'spanIdWrongLength',
    reason: 'a 15-character spanId',
    ingressIssue: { path: 'spanId', code: 'invalid_format' },
    persistedIssue: { path: 'spanId', code: 'invalid_format' },
  },
  {
    name: 'startTimeRelativePerformanceNow',
    reason: 'a relative performance.now() reading where epoch milliseconds belong',
    ingressIssue: { path: 'startTime', code: 'too_small' },
    persistedIssue: { path: 'startTime', code: 'too_small' },
  },
  {
    name: 'startTimeSeconds',
    reason: 'a seconds-precision epoch value, a thousand times too small',
    ingressIssue: { path: 'startTime', code: 'too_small' },
    persistedIssue: { path: 'startTime', code: 'too_small' },
  },
  {
    name: 'unknownKind',
    reason: 'a kind outside the seventeen the vocabulary declares',
    ingressIssue: { path: 'kind', code: 'invalid_value' },
    persistedIssue: { path: 'kind', code: 'invalid_value' },
  },
  {
    name: 'tierNotAllowedForKind',
    reason: 'a render reported on the database tier',
    // The cross-field check, and the one case here whose issue no field schema
    // could produce: both values are vocabulary members, only the pair is
    // wrong. Reported on `tier` as a `custom` issue, because the tier is what a
    // producer can fix.
    ingressIssue: { path: 'tier', code: 'custom' },
    // Measured, and worth stating rather than working around: zod runs an
    // object's `.check()` only once its fields have parsed without issues, and
    // this case — like every case in an ingress-shaped corpus — is already
    // missing the attribution under the persisted schema. So the persisted
    // refusal is about the attribution and the kind/tier check never runs. The
    // persisted half of that check is covered from an attributed event by
    // "applies the same rule to a persisted event" above; asserting a `tier`
    // issue here would assert behaviour the validator does not have.
    persistedIssue: { path: 'captureId', code: 'invalid_type' },
  },
  {
    name: 'unknownStatus',
    reason: "the OpenTelemetry spelling 'OK' instead of this schema's 'ok'",
    ingressIssue: { path: 'status', code: 'invalid_value' },
    persistedIssue: { path: 'status', code: 'invalid_value' },
  },
  {
    name: 'negativeDuration',
    reason: 'a negative duration, which no clock produces',
    ingressIssue: { path: 'duration', code: 'too_small' },
    persistedIssue: { path: 'duration', code: 'too_small' },
  },
  {
    name: 'unknownExtraField',
    reason: 'an extra top-level key both schemas are strict about',
    ingressIssue: { path: '', code: 'unrecognized_keys' },
    persistedIssue: { path: '', code: 'unrecognized_keys' },
  },
  {
    name: 'ingressCarriesSessionId',
    reason: 'a producer supplying the attribution the service assigns',
    ingressIssue: { path: '', code: 'unrecognized_keys' },
    // The asymmetric row. A `sessionId` is legal in the persisted shape, so the
    // persisted schema cannot object to it; what it objects to is the rest of
    // the attribution still being absent. Asserting the missing `captureId`
    // here keeps the row honest about *why* each schema refuses the value
    // instead of pretending the two refusals are the same one.
    persistedIssue: { path: 'captureId', code: 'invalid_type' },
  },
  {
    name: 'missingProducerId',
    reason: 'no producerId, so no producer to attribute the event to',
    ingressIssue: { path: 'producerId', code: 'invalid_type' },
    persistedIssue: { path: 'producerId', code: 'invalid_type' },
  },
  {
    name: 'allZeroTraceId',
    reason: 'the all-zero trace id W3C Trace Context defines as invalid',
    // The three rows below are the corpus' only *format-valid* ids: each one
    // satisfies the pattern `@debuggen/shared` owns and is refused for what it
    // means, so the issue is `custom` rather than `invalid_format`. They are
    // also the cases the hand-built tables could not cover on their own — a
    // committed wire-shaped event is what proves a real batch element carrying
    // these zeros never reaches the store.
    ingressIssue: { path: 'traceId', code: 'custom' },
    persistedIssue: { path: 'traceId', code: 'custom' },
  },
  {
    name: 'allZeroSpanId',
    reason: 'the all-zero span id, which would become an invalid parent-id on the wire',
    ingressIssue: { path: 'spanId', code: 'custom' },
    persistedIssue: { path: 'spanId', code: 'custom' },
  },
  {
    name: 'allZeroParentSpanId',
    reason: 'the SDK\'s all-zero placeholder for "no parent" sent instead of omitting the field',
    ingressIssue: { path: 'parentSpanId', code: 'custom' },
    persistedIssue: { path: 'parentSpanId', code: 'custom' },
  },
];

describe('the committed ingress corpus', () => {
  it('holds one capture of producer events, all distinct', () => {
    expect(INGRESS_BATCH).toHaveLength(BATCH_SIZE);
    expect(new Set(INGRESS_BATCH.map((event) => event['id'])).size).toBe(BATCH_SIZE);
  });

  it('covers both producers and all three tiers', () => {
    // What makes this corpus worth driving rather than one more single event:
    // it is the cross-process, cross-tier batch of AAP 0.2.3, and a schema that
    // only ever saw browser events would not be shown to accept a `db.query`
    // on the `db` tier from a different producer in the same trace.
    expect(new Set(INGRESS_BATCH.map((event) => event['producerId'])).size).toBe(2);
    expect(new Set(INGRESS_BATCH.map((event) => event['tier']))).toEqual(
      new Set(['browser', 'server', 'db']),
    );
  });

  it.each(INGRESS_BATCH)(
    'accepts the $kind event $id through every ingress entry point, unchanged',
    (event: Candidate) => {
      expect(telemetryEventIngressSchema.safeParse(event).success).toBe(true);
      expect(isTelemetryEventIngress(event)).toBe(true);

      const parsed = okValue(parseTelemetryEventIngress(event));

      // The round trip: no `.transform()`, no `.coerce`, no `.default()`
      // anywhere in `./event.ts`, so what comes out is what the corpus holds —
      // including the sub-millisecond `startTime`, the nested `attributes` bag
      // and the optional `parentSpanId`/`source`/`redacted` where the event
      // carries them. The key-set comparison is what *names* a field that
      // appeared or vanished; deep equality alone would print two whole events
      // and leave the reader to spot the difference.
      expect(parsed).toStrictEqual(event);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(event).sort());
    },
  );

  it.each(INGRESS_BATCH)(
    'refuses the $kind event $id as a persisted event, for want of attribution',
    (event: Candidate) => {
      // The ingress/persisted split of AAP 0.2.3 seen from the store's side: an
      // event straight off the wire is not a row, and the persisted schema says
      // so by naming each of the three fields ingest has yet to assign.
      const issues = expectPersistedRejected(event);

      expect(pathsOf(issues)).toEqual(expect.arrayContaining([...ATTRIBUTION_FIELDS]));

      for (const field of ATTRIBUTION_FIELDS) {
        expect(issues).toContainEqual({ path: field, code: 'invalid_type' });
      }
    },
  );
});

describe('the committed persisted corpus', () => {
  it('holds the attributed counterpart of one capture', () => {
    expect(PERSISTED_BATCH).toHaveLength(BATCH_SIZE);
    expect(new Set(PERSISTED_BATCH.map((event) => event['id'])).size).toBe(BATCH_SIZE);
  });

  it.each(PERSISTED_BATCH)(
    'accepts the attributed $kind event $id through every persisted entry point, unchanged',
    (event: Candidate) => {
      expect(telemetryEventSchema.safeParse(event).success).toBe(true);
      expect(isTelemetryEvent(event)).toBe(true);

      const parsed = okValue(parseTelemetryEvent(event));

      expect(parsed).toStrictEqual(event);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(event).sort());
    },
  );

  it.each(PERSISTED_BATCH)(
    'refuses the attributed $kind event $id as producer output',
    (event: Candidate) => {
      // The other direction, and the reason the ingress schema is strict: a row
      // read back out of the store is not something a producer may send, so a
      // component that validates with the wrong schema is caught rather than
      // silently stripping the attribution it was handed.
      const issues = expectIngressRejected(event);

      expect(issues).toContainEqual({ path: '', code: 'unrecognized_keys' });
    },
  );
});

describe('the two corpora are one batch before and after attribution', () => {
  it('carries the same events in the same order', () => {
    // Order is part of the claim: `seq` is per-producer and `ingestSeq` is the
    // store's arrival number, so a corpus whose two halves had drifted out of
    // step would still parse and would still make every per-event assertion
    // above pass, while the attribution comparison below compared unrelated
    // events.
    expect(PERSISTED_BATCH).toHaveLength(INGRESS_BATCH.length);

    for (let index = 0; index < BATCH_SIZE; index += 1) {
      const producerEvent = eventAt(INGRESS_BATCH, index, 'event-ingress-batch.json');
      const storedEvent = eventAt(PERSISTED_BATCH, index, 'event-persisted-batch.json');

      expect(storedEvent['id'], `the corpora disagree at index ${String(index)}`).toBe(
        producerEvent['id'],
      );
    }
  });

  it('adds exactly the three attribution fields, and alters nothing else', () => {
    for (let index = 0; index < BATCH_SIZE; index += 1) {
      const producerEvent = eventAt(INGRESS_BATCH, index, 'event-ingress-batch.json');
      const storedEvent = eventAt(PERSISTED_BATCH, index, 'event-persisted-batch.json');
      const label = `event ${String(producerEvent['id'])} at index ${String(index)}`;

      const added = Object.keys(storedEvent).filter((key) => !Object.hasOwn(producerEvent, key));
      const removed = Object.keys(producerEvent).filter((key) => !Object.hasOwn(storedEvent, key));

      expect(added.sort(), `${label} gained the wrong fields at ingest`).toEqual(
        [...ATTRIBUTION_FIELDS].sort(),
      );
      expect(removed, `${label} lost fields at ingest`).toEqual([]);

      // AAP 0.2.3: attribution adds, it does not normalise. Every value the
      // producer observed — the sub-millisecond `startTime`, the nested
      // `attributes` bag, the embedded `source`, the `redacted` list — must
      // survive byte for byte, because the panel reads the stored copy.
      for (const [key, value] of Object.entries(producerEvent)) {
        expect(storedEvent[key], `${label} had its ${key} rewritten at ingest`).toStrictEqual(
          value,
        );
      }
    }
  });

  it('attributes the batch to one session and one capture, with a strictly increasing ingestSeq', () => {
    // Read from the parsed values rather than the raw bags, so `ingestSeq` is
    // the schema's `number` and the comparison below is a numeric one.
    const attributed = PERSISTED_BATCH.map((event) => okValue(parseTelemetryEvent(event)));

    expect(new Set(attributed.map((event) => event.sessionId)).size).toBe(1);
    expect(new Set(attributed.map((event) => event.captureId)).size).toBe(1);

    // Zero is below every number the store can assign (`ingestSeq` is
    // one-based), so the first comparison is meaningful without special-casing
    // the first element.
    let previous = 0;

    for (const event of attributed) {
      expect(Number.isInteger(event.ingestSeq)).toBe(true);
      expect(event.ingestSeq, `ingestSeq did not increase at event ${event.id}`).toBeGreaterThan(
        previous,
      );

      previous = event.ingestSeq;
    }
  });
});

describe('the committed invalid corpus', () => {
  it('holds exactly the named cases the table drives, in order', () => {
    // Both directions at once: a case added to the file without a row here is
    // an untested case, and a row here without a case in the file is an
    // assertion about nothing.
    expect(INVALID_FIXTURE_CASES).toHaveLength(INVALID_CASE_COUNT);
    expect(Object.keys(INVALID_CASES)).toHaveLength(INVALID_CASE_COUNT);
    expect(Object.keys(INVALID_CASES)).toEqual(
      INVALID_FIXTURE_CASES.map((fixtureCase) => fixtureCase.name),
    );
  });

  it.each(INVALID_FIXTURE_CASES)(
    'refuses $name through every entry point, reporting $reason',
    ({ name, reason, ingressIssue, persistedIssue }: InvalidFixtureCase) => {
      const candidate = invalidCase(name);
      const label = `${name} (${reason})`;

      // AAP 0.5.5 first: whatever the corpus holds, none of the four entry
      // points may throw, because one malformed element must never end a
      // capture.
      expect(() => parseTelemetryEventIngress(candidate)).not.toThrow();
      expect(() => parseTelemetryEvent(candidate)).not.toThrow();
      expect(() => isTelemetryEventIngress(candidate)).not.toThrow();
      expect(() => isTelemetryEvent(candidate)).not.toThrow();

      // Each helper asserts the whole refusal: `safeParse` false, the guard
      // false, and a `Result` carrying a `DebuggenError` whose code is
      // `PROTOCOL_INVALID_MESSAGE` and whose `details.schema` names the schema
      // that refused — so a case that is rejected by one entry point and
      // accepted by another fails here.
      const ingressIssues = expectIngressRejected(candidate);
      const persistedIssues = expectPersistedRejected(candidate);

      // And the refusal is the one the case name claims. Without this, a case
      // that had drifted into being invalid for some unrelated reason would
      // still pass while covering nothing it is named for.
      expect(ingressIssues, `${label}: the ingress refusal named something else`).toContainEqual(
        ingressIssue,
      );
      expect(
        persistedIssues,
        `${label}: the persisted refusal named something else`,
      ).toContainEqual(persistedIssue);
    },
  );
});
