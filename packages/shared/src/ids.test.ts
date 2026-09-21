/**
 * Tests for `./ids.ts`: every identifier this product mints, and the two ways
 * minting one can fail.
 *
 * These identifiers are the join keys of the whole product, which is why a unit
 * test of what looks like string formatting is worth this much attention. Four
 * processes mint them independently — the page agent, the Node preload, the
 * local service and the protocol envelope — and nothing downstream re-derives
 * them: a value is stamped once at its source and then travels through a
 * `traceparent` request header, a `postMessage` batch, a WebSocket frame, a
 * SQLite primary key and a filesystem path. There is no negotiation step at
 * which a malformed one would be rejected and retried.
 *
 * Two contracts are therefore on trial here, and they fail in different ways.
 *
 * 1. **The W3C shapes are load-bearing for correlation.** `traceparent` is
 *    defined over 32 and 16 *lowercase* hex characters, with the all-zero value
 *    explicitly invalid, and a receiver is required to ignore a malformed
 *    header rather than complain about it. A trace id that is one character
 *    short, uppercase, or all zeros therefore raises no error anywhere — it
 *    produces a click that silently never joins the route handler and database
 *    queries it caused, which is exactly the end-to-end tree this product
 *    exists to show. The suites below assert the accepting cases *and* the
 *    rejecting ones, because a pattern that accepts too much is as useless as a
 *    generator that produces too little.
 *
 * 2. **The opaque shapes are load-bearing for storage.** A session id is
 *    interpolated into `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>`
 *    before the patcher writes a single byte into the developer's project —
 *    that backup is the entire reversibility guarantee — and the same value is
 *    a store key and a URL path segment. A character that changes meaning in a
 *    path (`/`, `.`, `-`, a space) would turn a debugging session into a
 *    filesystem bug, so the alphabet is checked character by character rather
 *    than trusted.
 *
 * Two habits in here are deliberate.
 *
 * - **Failures name the offender.** Batch assertions filter for the values that
 *   broke the rule and compare the filtered list to `[]`, rather than comparing
 *   two counts, so a failure reports the id that was malformed instead of the
 *   fact that some id was.
 * - **Nothing pins a random value.** A generator's contract is its shape, its
 *   distinctness and its refusal to emit a reserved value; the bytes behind it
 *   belong to the host. Where an exact output *is* asserted, the randomness
 *   source is a stub that supplies known bytes, which is the only way hex
 *   rendering itself can be checked. Batch sizes are large enough to catch a
 *   broken generator — a constant, a counter, a truncated pool — and small
 *   enough to keep this file in the millisecond range, since it runs inside the
 *   blocking `pnpm test` gate.
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { DebuggenError } from './errors.js';
import {
  ID_PREFIXES,
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  isSpanId,
  isTraceId,
  newActionId,
  newAnalysisId,
  newCaptureId,
  newEventId,
  newId,
  newMessageId,
  newModificationId,
  newPanelId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  type SpanId,
  type TraceId,
} from './ids.js';
// The nine opaque id aliases come from the package's public entry rather than
// from `./ids.js`, because that is the specifier every consumer writes: the
// local service, both extensions, the page agent and the Node preload all
// reach these types through `@debuggen/shared`, whose `.` export resolves to
// this barrel. Importing them here is what makes both hops — the declaration
// and its re-export — a tested contract rather than an assumption; see the
// type-surface suite at the end of this file.
import type {
  ActionId,
  AnalysisId,
  CaptureId,
  EventId,
  MessageId,
  ModificationId,
  PanelId,
  ProducerId,
  SessionId,
} from './index.js';

/*
 * ---------------------------------------------------------------------------
 * Shapes and sizes
 * ---------------------------------------------------------------------------
 */

/** Characters in a trace id: 16 random bytes rendered as hex. */
const TRACE_ID_LENGTH = 32;

/** Characters in a span id: 8 random bytes rendered as hex. */
const SPAN_ID_LENGTH = 16;

/**
 * The one shape every opaque entity id in the product matches.
 *
 * Restated here rather than imported because `ids.ts` exports no pattern for
 * it: the *reason* the alphabet is restricted is that this regex holds for
 * every kind of id, so stating it independently is what turns an accidental
 * widening of the alphabet — nanoid's URL-safe default, say, with its `-` and
 * `_` — into a failing test here instead of a broken backup path later.
 */
const OPAQUE_ID_PATTERN = /^[a-z]{3}_[0-9a-z]{16}$/;

/** The body of an opaque id: everything after `<prefix>_`. */
const OPAQUE_BODY_PATTERN = /^[0-9a-z]{16}$/;

/**
 * The alphabet the body of an opaque id is drawn from, restated for the same
 * reason as {@link OPAQUE_ID_PATTERN}: `ids.ts` keeps its `ID_ALPHABET`
 * constant module-private, so an independent copy is what makes a change to it
 * visible instead of self-consistent.
 */
const OPAQUE_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Characters in a three-letter kind prefix, before the `_` separator. */
const OPAQUE_PREFIX_LENGTH = 3;

/** Index of the single `_` separator in every opaque id. */
const OPAQUE_SEPARATOR_INDEX = OPAQUE_PREFIX_LENGTH;

/** Characters in a full opaque id: `<3 letters>_<16 alphabet characters>`. */
const OPAQUE_ID_LENGTH = OPAQUE_PREFIX_LENGTH + 1 + 16;

/** Anything a filesystem path, a URL path segment or a store key would object to. */
const PATH_HOSTILE_CHARACTER = /[^0-9a-z_]/;

/*
 * ---------------------------------------------------------------------------
 * Batch sizes
 *
 * Every batch below runs in single-digit milliseconds on the pinned runtime.
 * They are sized by what they have to catch, not by ambition:
 * ---------------------------------------------------------------------------
 */

/**
 * Draws used to check that no generated hex id is the reserved all-zero value.
 *
 * A correct generator produces it with probability 2^-64 or less, so this batch
 * is not looking for bad luck — it is looking for an implementation that lost
 * its randomness (a zero-filled buffer that is returned unexamined) and would
 * fail on the very first draw.
 */
const ZERO_CHECK_BATCH = 1_000;

/**
 * Draws used to check distinctness.
 *
 * Four thousand is far below the birthday bound for a 64-bit span id
 * (a collision is expected around 2^32 draws, and the chance of one here is
 * about 4 x 10^-13), so a failure means a genuinely broken generator — a
 * constant, a value cached per module, or a random pool being re-read from the
 * same offset — rather than a coincidence. The suite is deterministic in
 * practice for that reason.
 */
const UNIQUENESS_BATCH = 4_000;

/**
 * Draws used to check the character-level rules of an opaque id, per kind.
 *
 * Two hundred ids is 3 200 body characters, which reaches every corner of a
 * 36-symbol alphabet many times over, so an alphabet that has quietly widened
 * shows up here rather than in one id out of thousands in production.
 */
const SHAPE_BATCH = 200;

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/** A value with a name, so `it.each` can title itself. */
interface LabelledValue {
  readonly label: string;
  readonly value: unknown;
}

/**
 * Values that are not strings at all.
 *
 * `isTraceId` and `isSpanId` are the boundary guards for values the compiler
 * knows only as `unknown` — an event batch relayed from a page, a header field,
 * a row read back out of the store — so every one of these arrives in practice.
 * The two entries that matter most are the last ones: a guard that coerced its
 * argument before matching would accept an object whose `toString` returns a
 * well-formed id, and one that tested `value.length` instead of the string type
 * would accept a 32-element array. Both would then propagate a non-string into
 * a `traceparent` header.
 */
const NON_STRING_VALUES: readonly LabelledValue[] = [
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'a number', value: 42 },
  { label: 'NaN', value: Number.NaN },
  { label: 'a boolean', value: true },
  { label: 'a plain object', value: {} },
  { label: 'a symbol', value: Symbol('abcdef0123456789') },
  { label: 'a Uint8Array of 16 bytes', value: new Uint8Array(SPAN_ID_LENGTH) },
  { label: 'an array of hex characters', value: Array.from({ length: 32 }, () => 'a') },
  {
    label: 'an object whose toString returns a valid id',
    value: { toString: () => 'a'.repeat(32) },
  },
];

/** A malformation applied to a canonical id, so `it.each` can title itself. */
interface MalformedCase {
  readonly label: string;
  readonly build: (canonical: string) => string;
}

/**
 * Every way a hex id can be wrong that the patterns must reject.
 *
 * Each case is derived from the family's canonical value, so one table serves
 * both the 32-character and the 16-character family and neither can drift out
 * of step with the other. The anchoring cases — leading whitespace, a trailing
 * newline, a padded value — are not pedantry: an unanchored pattern would
 * happily find a valid id *inside* a longer string, which is how a header value
 * with a stray space, or a log line pasted into a filter box, ends up treated
 * as an identifier.
 */
const MALFORMED_HEX_CASES: readonly MalformedCase[] = [
  { label: 'one character short', build: (canonical) => canonical.slice(0, -1) },
  { label: 'one character too long', build: (canonical) => `${canonical}0` },
  { label: 'twice the length', build: (canonical) => `${canonical}${canonical}` },
  { label: 'uppercase hex', build: (canonical) => canonical.toUpperCase() },
  {
    label: 'mixed case',
    build: (canonical) => `${canonical.slice(0, -1).toUpperCase()}${canonical.slice(-1)}`,
  },
  { label: 'a non-hex letter', build: (canonical) => `${canonical.slice(0, -1)}g` },
  { label: 'a hyphen', build: (canonical) => `${canonical.slice(0, -1)}-` },
  { label: 'an embedded space', build: (canonical) => `${canonical.slice(0, -1)} ` },
  { label: 'leading whitespace', build: (canonical) => ` ${canonical}` },
  { label: 'a trailing newline', build: (canonical) => `${canonical}\n` },
  { label: 'a 0x prefix in place of two digits', build: (canonical) => `0x${canonical.slice(2)}` },
  { label: 'the empty string', build: () => '' },
];

/** One of the two W3C identifier families, with everything a suite needs. */
interface HexIdFamily {
  /** The exported pattern's name, used as the suite title. */
  readonly patternName: string;
  /** The generator's name, used in test titles. */
  readonly generatorName: string;
  /** The type guard's name, used as a suite title. */
  readonly guardName: string;
  /** The exported pattern under test. */
  readonly pattern: RegExp;
  /** The generator under test. */
  readonly generate: () => string;
  /** The exported type guard for this family. */
  readonly guard: (value: unknown) => boolean;
  /** The generator of the *other* family, which this one must not accept. */
  readonly generateOther: () => string;
  /** Required character count. */
  readonly length: number;
  /**
   * A canonical, valid value written out by hand.
   *
   * Deliberately a literal rather than a generated id: the malformation cases
   * above include `toUpperCase()`, and a generated id that happened to contain
   * no letters would be unchanged by it, which would make that assertion pass
   * for the wrong reason roughly once in every few thousand runs for a span id.
   * A literal containing both letters and digits removes the flake entirely.
   */
  readonly canonical: string;
  /** The reserved all-zero value of this family. */
  readonly allZero: string;
}

/** The two families, each tested by the same shared suites below. */
const HEX_ID_FAMILIES: readonly HexIdFamily[] = [
  {
    patternName: 'TRACE_ID_PATTERN',
    generatorName: 'newTraceId',
    guardName: 'isTraceId',
    pattern: TRACE_ID_PATTERN,
    generate: newTraceId,
    guard: isTraceId,
    generateOther: newSpanId,
    length: TRACE_ID_LENGTH,
    canonical: 'abcdef0123456789abcdef0123456789',
    allZero: '0'.repeat(TRACE_ID_LENGTH),
  },
  {
    patternName: 'SPAN_ID_PATTERN',
    generatorName: 'newSpanId',
    guardName: 'isSpanId',
    pattern: SPAN_ID_PATTERN,
    generate: newSpanId,
    guard: isSpanId,
    generateOther: newTraceId,
    length: SPAN_ID_LENGTH,
    canonical: 'abcdef0123456789',
    allZero: '0'.repeat(SPAN_ID_LENGTH),
  },
];

/** The kinds of opaque id the product mints, as named by `ID_PREFIXES`. */
type IdKind = keyof typeof ID_PREFIXES;

/**
 * The generator behind each kind of opaque id.
 *
 * Typed `Record<IdKind, …>`, which is the point: the key set comes from
 * `ID_PREFIXES` itself, so a prefix added there without a generator (or a
 * generator added here without a prefix) is a **compile** error in this file
 * rather than a test that keeps passing while the two lists drift. Every
 * runtime assertion about prefixes below reads `ID_PREFIXES[kind]` for the same
 * reason — a second hand-written copy of the mapping would agree with itself
 * and with nothing else.
 */
const GENERATORS: Readonly<Record<IdKind, () => string>> = {
  session: newSessionId,
  capture: newCaptureId,
  panel: newPanelId,
  analysis: newAnalysisId,
  modification: newModificationId,
  action: newActionId,
  event: newEventId,
  message: newMessageId,
  producer: newProducerId,
};

/**
 * The kinds of {@link GENERATORS}, narrowed back to the union `Object.keys`
 * widens away.
 *
 * The single type assertion in this file, and it is sound by construction: the
 * own enumerable keys of a `Record<IdKind, …>` object literal are exactly
 * `IdKind`. Isolating it in one helper keeps every call site free of casts.
 */
function idKinds(): IdKind[] {
  return Object.keys(GENERATORS) as IdKind[];
}

/** One kind of opaque id, paired with its generator, for `it.each` titles. */
interface OpaqueIdCase {
  readonly kind: IdKind;
  readonly generatorName: string;
  readonly generate: () => string;
}

/** Every opaque generator, derived from {@link GENERATORS}. */
const OPAQUE_ID_CASES: readonly OpaqueIdCase[] = idKinds().map((kind) => ({
  kind,
  // `Function.prototype.name` rather than a hand-written string: a renamed
  // export shows up in the test title instead of the title lying about it.
  generatorName: GENERATORS[kind].name,
  generate: GENERATORS[kind],
}));

/**
 * The published prefix vocabulary, written out once.
 *
 * This is a *contract pin*, not a second copy of the mapping tested above: the
 * three-letter prefixes appear in store keys, in protocol payloads, in log
 * lines a developer greps and in backup directory names already on disk, so
 * renaming one is a breaking change across the monorepo. Pinning the table here
 * means such a rename fails this test — which is the intended way to find every
 * place that has to change — instead of landing quietly because every other
 * assertion derives from `ID_PREFIXES` and would follow it anywhere.
 */
const PUBLISHED_ID_PREFIXES: Readonly<Record<IdKind, string>> = {
  session: 'ses',
  capture: 'cap',
  panel: 'pnl',
  analysis: 'ana',
  modification: 'mod',
  action: 'act',
  event: 'evt',
  message: 'msg',
  producer: 'prd',
};

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Call `produce` `count` times and collect the results.
 *
 * @param count How many values to produce.
 * @param produce The generator to call.
 * @returns The produced values, in order.
 */
function times<T>(count: number, produce: () => T): T[] {
  return Array.from({ length: count }, produce);
}

/** Sentinel distinguishing "threw `undefined`" from "did not throw at all". */
const NOTHING_THROWN = Symbol('nothing thrown');

/**
 * Run `operation`, require it to throw, and hand back the thrown value narrowed
 * to a `DebuggenError`.
 *
 * `DebuggenError.is` is the supported check and `instanceof` is deliberately not
 * used: the brand is what makes an error recognisable after it has crossed a
 * bundle or serialisation boundary, and asserting the brand here is asserting
 * the thing every `catch` block in the product actually relies on.
 *
 * @param operation The call expected to fail.
 * @returns The thrown `DebuggenError`, typed, so callers assert on `code`,
 * `message` and `hint` without a cast.
 */
function expectDebuggenError(operation: () => unknown): DebuggenError {
  let thrown: unknown = NOTHING_THROWN;

  try {
    operation();
  } catch (error: unknown) {
    thrown = error;
  }

  expect(thrown, 'the operation was expected to throw').not.toBe(NOTHING_THROWN);
  expect(DebuggenError.is(thrown)).toBe(true);

  if (!DebuggenError.is(thrown)) {
    // Unreachable: the assertion above has already failed the test. It exists so
    // this function's return type is `DebuggenError` rather than `unknown`.
    throw new Error('Expected a DebuggenError to have been thrown.');
  }

  return thrown;
}

/** The single method of the Web Crypto global that `ids.ts` uses. */
interface RandomSourceStub {
  getRandomValues: (buffer: Uint8Array) => Uint8Array;
}

/**
 * A randomness source that fills nothing, so every draw is all-zero bytes.
 *
 * `new Uint8Array(n)` is already zero-filled, so returning the buffer untouched
 * is exactly the "randomness source that is not random" condition `ids.ts`
 * refuses to paper over.
 */
function zeroFillingRandomSource(): RandomSourceStub {
  return { getRandomValues: (buffer: Uint8Array): Uint8Array => buffer };
}

/**
 * A randomness source that fills every byte with `value`, for the two tests
 * that assert an exact rendered id.
 *
 * @param value The byte to write into every position.
 */
function constantRandomSource(value: number): RandomSourceStub {
  return {
    getRandomValues: (buffer: Uint8Array): Uint8Array => buffer.fill(value),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The W3C identifier patterns
 *
 * One suite, run against both families, because the rule is the same rule at
 * two lengths and a copy of it would be a copy that can rot.
 * ---------------------------------------------------------------------------
 */

describe.each(HEX_ID_FAMILIES)('$patternName', (family: HexIdFamily) => {
  it('accepts the canonical lowercase-hex form', () => {
    expect(family.canonical).toHaveLength(family.length);
    expect(family.pattern.test(family.canonical)).toBe(true);
  });

  it('accepts a freshly generated id', () => {
    expect(family.pattern.test(family.generate())).toBe(true);
  });

  it.each(MALFORMED_HEX_CASES)('rejects $label', ({ build }: MalformedCase) => {
    expect(family.pattern.test(build(family.canonical))).toBe(false);
  });

  it('rejects an id from the other family, so the two cannot be interchanged', () => {
    // Length is the only thing distinguishing them, and both are valid hex, so
    // a pattern that dropped an anchor or a quantifier would accept both and a
    // span id would pass as a trace id all the way into a `traceparent` header.
    expect(family.pattern.test(family.generateOther())).toBe(false);
  });

  it('carries neither the g nor the y flag', () => {
    // A global or sticky regex owns a mutable `lastIndex` that `test` advances.
    // These patterns are module-level constants shared by the telemetry event
    // schema, the store and both producers, so a stateful matcher would make
    // one validation's answer depend on the previous one — an order-dependent
    // bug that shows up only once several ids are validated in a row.
    expect(family.pattern.global).toBe(false);
    expect(family.pattern.sticky).toBe(false);
    expect(family.pattern.flags).toBe('');
  });

  it('gives the same answer however many times it is asked', () => {
    // The behavioural counterpart of the flag assertions above: the property
    // that actually matters is that repeated calls are independent.
    expect(times(3, () => family.pattern.test(family.canonical))).toEqual([true, true, true]);
    expect(times(3, () => family.pattern.test(family.canonical.slice(1)))).toEqual([
      false,
      false,
      false,
    ]);
    expect(family.pattern.lastIndex).toBe(0);
  });

  it('accepts the reserved all-zero value, which the generator never produces', () => {
    // Documented behaviour, not an oversight: the pattern answers the *syntax*
    // question only, while the W3C validity rule that excludes the all-zero
    // value is enforced where ids are created. Pinned here so the division of
    // labour cannot be changed on one side without the other noticing.
    expect(family.pattern.test(family.allZero)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The W3C identifier generators
 * ---------------------------------------------------------------------------
 */

describe.each(HEX_ID_FAMILIES)('$generatorName', (family: HexIdFamily) => {
  it('returns the required number of lowercase hex characters', () => {
    const id = family.generate();

    expect(id).toHaveLength(family.length);
    expect(id).toMatch(family.pattern);
    // Asserted against the value's own lowercase form as well as against the
    // pattern: `traceparent` is defined over lowercase hex, and two spellings
    // of one id would split a single trace in two, because the correlator joins
    // spans by string equality.
    expect(id).toBe(id.toLowerCase());
  });

  it('never returns the reserved all-zero value', () => {
    const ids = times(ZERO_CHECK_BATCH, family.generate);

    // Filtered rather than counted, so a failure prints the offending draw.
    expect(ids.filter((id) => id === family.allZero)).toEqual([]);
    expect(ids.filter((id) => !family.pattern.test(id))).toEqual([]);
    expect(ids).toHaveLength(ZERO_CHECK_BATCH);
  });

  it('returns a distinct value every time', () => {
    const ids = times(UNIQUENESS_BATCH, family.generate);

    expect(new Set(ids).size).toBe(UNIQUENESS_BATCH);
  });

  it('returns a value its own guard accepts', () => {
    expect(family.guard(family.generate())).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The W3C identifier type guards
 * ---------------------------------------------------------------------------
 */

describe.each(HEX_ID_FAMILIES)('$guardName', (family: HexIdFamily) => {
  it('accepts a freshly generated id', () => {
    expect(family.guard(family.generate())).toBe(true);
  });

  it('accepts the canonical form', () => {
    expect(family.guard(family.canonical)).toBe(true);
  });

  it.each(NON_STRING_VALUES)('rejects $label', ({ value }: LabelledValue) => {
    // The string check has to come before the pattern test: a guard that
    // matched first would coerce its argument, and an object whose `toString`
    // happens to return a well-formed id would then be waved through into a
    // request header or a store key as if it were one.
    expect(family.guard(value)).toBe(false);
  });

  it.each(MALFORMED_HEX_CASES)('rejects a string that is $label', ({ build }: MalformedCase) => {
    expect(family.guard(build(family.canonical))).toBe(false);
  });

  it('rejects an id from the other family', () => {
    expect(family.guard(family.generateOther())).toBe(false);
  });

  it('accepts the reserved all-zero value, as its documentation states', () => {
    // The same syntax-only contract as the pattern: a caller that needs the
    // W3C validity rule rejects this value explicitly, and this assertion is
    // what tells that caller the guard will not do it for them.
    expect(family.guard(family.allZero)).toBe(true);
  });
});

describe('the W3C type guards as narrowing predicates', () => {
  it('narrows an unknown value to a TraceId', () => {
    // `unknown` is what these guards actually receive — a relayed event batch,
    // a header field, a row out of the store — so the test starts from it.
    const value: unknown = newTraceId();

    expect(isTraceId(value)).toBe(true);

    if (isTraceId(value)) {
      // The compile-time half of the contract: inside this block the value is
      // a `TraceId`, and this assignment is what would fail to compile if the
      // predicate signature ever regressed to `boolean`.
      const narrowed: TraceId = value;

      expect(narrowed).toHaveLength(TRACE_ID_LENGTH);
    }
  });

  it('narrows an unknown value to a SpanId', () => {
    const value: unknown = newSpanId();

    expect(isSpanId(value)).toBe(true);

    if (isSpanId(value)) {
      const narrowed: SpanId = value;

      expect(narrowed).toHaveLength(SPAN_ID_LENGTH);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The opaque entity id generators
 * ---------------------------------------------------------------------------
 */

describe.each(OPAQUE_ID_CASES)('$generatorName', ({ kind, generate }: OpaqueIdCase) => {
  /** The prefix this kind is contracted to produce, read from `ID_PREFIXES`. */
  const prefix = ID_PREFIXES[kind];

  it('returns its documented prefix, one underscore, then 16 alphabet characters', () => {
    const id = generate();

    expect(id).toMatch(OPAQUE_ID_PATTERN);
    expect(id).toHaveLength(OPAQUE_ID_LENGTH);
    expect(id.startsWith(`${prefix}_`)).toBe(true);
    expect(id.slice(0, OPAQUE_PREFIX_LENGTH)).toBe(prefix);
    expect(id.slice(OPAQUE_SEPARATOR_INDEX + 1)).toMatch(OPAQUE_BODY_PATTERN);
  });

  it('separates the prefix from the body with exactly one underscore', () => {
    const ids = times(SHAPE_BATCH, generate);

    // The underscore is the delimiter, so one inside the random body would make
    // the boundary ambiguous and defeat a split on it. nanoid's *default*
    // alphabet is URL-safe base64, which contains both `_` and `-`, so this is
    // the assertion that catches a generator built on the default by mistake.
    expect(ids.filter((id) => id.indexOf('_') !== OPAQUE_SEPARATOR_INDEX)).toEqual([]);
    expect(ids.filter((id) => id.lastIndexOf('_') !== OPAQUE_SEPARATOR_INDEX)).toEqual([]);
    expect(ids.filter((id) => id.includes('-'))).toEqual([]);
  });

  it('returns nothing but lowercase characters', () => {
    const ids = times(SHAPE_BATCH, generate);

    // One case means an id cannot differ from another only by case, so a
    // case-insensitive comparison — a store collation, a case-preserving
    // filesystem, a developer retyping an id from a log — cannot collide two
    // distinct ids or fail to find one that exists.
    expect(ids.filter((id) => id !== id.toLowerCase())).toEqual([]);
  });

  it('returns only characters that are safe in a path, a URL and a store key', () => {
    const ids = times(SHAPE_BATCH, generate);

    // Why this matters beyond tidiness: a session id is interpolated straight
    // into `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>` — the backup the
    // patcher writes *before* it touches a single byte of the developer's
    // project, and the whole reason a temporary edit stays reversible — and the
    // same value is a SQLite key and a URL path segment. A `/`, a `.`, a `-` or
    // a space here would not read as an ugly id; it would read as a backup
    // written somewhere other than where cleanup looks for it.
    expect(ids.filter((id) => PATH_HOSTILE_CHARACTER.test(id))).toEqual([]);
    expect(ids.filter((id) => id.includes('/') || id.includes('\\'))).toEqual([]);
    expect(ids.filter((id) => id.includes('.'))).toEqual([]);
    expect(ids.filter((id) => id.trim() !== id)).toEqual([]);
    expect(ids.filter((id) => encodeURIComponent(id) !== id)).toEqual([]);
  });

  it('draws the body only from the documented alphabet', () => {
    const bodyCharacters = new Set(
      times(SHAPE_BATCH, generate)
        .map((id) => id.slice(OPAQUE_SEPARATOR_INDEX + 1))
        .join(''),
    );
    const unexpected = [...bodyCharacters].filter(
      (character) => !OPAQUE_ID_ALPHABET.includes(character),
    );

    expect(unexpected).toEqual([]);
    // The alphabet is 36 symbols and the sample is 3 200 body characters, so a
    // correct generator reaches nearly all of them; a sharply smaller set means
    // the alphabet or the sampling has narrowed.
    expect(bodyCharacters.size).toBeGreaterThan(OPAQUE_ID_ALPHABET.length / 2);
  });

  it('returns a distinct id every time', () => {
    const ids = times(SHAPE_BATCH, generate);

    expect(new Set(ids).size).toBe(SHAPE_BATCH);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The prefix vocabulary
 * ---------------------------------------------------------------------------
 */

describe('ID_PREFIXES', () => {
  it('has an entry for every generator, and no entry without one', () => {
    // The compile-time half of this is the `Record<IdKind, …>` type on
    // GENERATORS, which already makes a mismatch a type error. This is the
    // runtime restatement, so the expectation is legible in a test report.
    expect(Object.keys(ID_PREFIXES).sort()).toEqual(Object.keys(GENERATORS).sort());
  });

  it('spells every prefix as exactly three lowercase letters', () => {
    const malformed = Object.entries(ID_PREFIXES).filter(
      ([, prefix]) => !/^[a-z]{3}$/.test(prefix),
    );

    expect(malformed).toEqual([]);
  });

  it('gives every kind a distinct prefix', () => {
    // Two kinds sharing a prefix would make an id in a log line, a store key or
    // a backup directory name ambiguous about what it identifies.
    const prefixes = Object.values(ID_PREFIXES);

    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it.each(OPAQUE_ID_CASES)(
    'matches what $generatorName actually produces',
    ({ kind, generate }: OpaqueIdCase) => {
      // Derived from `ID_PREFIXES` rather than from a second hand-written list:
      // the two cannot drift apart if only one of them exists.
      expect(generate().startsWith(`${ID_PREFIXES[kind]}_`)).toBe(true);
    },
  );

  it('publishes the prefix vocabulary the rest of the monorepo depends on', () => {
    // A contract pin, and the one place in this file that names the prefixes
    // literally. Every other assertion follows `ID_PREFIXES` wherever it goes,
    // which is right for consistency and useless for catching a rename — and a
    // rename here invalidates store keys, protocol payloads and backup
    // directories that already exist on disk. Failing this test is the intended
    // way to discover every place that has to change.
    expect(ID_PREFIXES).toEqual(PUBLISHED_ID_PREFIXES);
  });
});

/*
 * ---------------------------------------------------------------------------
 * newId
 * ---------------------------------------------------------------------------
 */

describe('newId', () => {
  it('honours an arbitrary prefix and keeps the documented body shape', () => {
    const id = newId('custom');

    expect(id.startsWith('custom_')).toBe(true);
    expect(id).toHaveLength('custom_'.length + 16);
    expect(id.slice('custom_'.length)).toMatch(OPAQUE_BODY_PATTERN);
  });

  it('produces the canonical shape when given a prefix from ID_PREFIXES', () => {
    expect(newId(ID_PREFIXES.capture)).toMatch(OPAQUE_ID_PATTERN);
  });

  it('draws the body independently of the prefix it is given', () => {
    // The prefix is a label, not a seed: two calls with the same prefix must
    // differ, and a call with a different prefix must not change the body's
    // shape. A generator that folded the prefix into its randomness would make
    // ids of one kind correlate with each other.
    const first = newId('aaa');
    const second = newId('aaa');

    expect(first).not.toBe(second);
    expect(first.slice(OPAQUE_SEPARATOR_INDEX + 1)).toMatch(OPAQUE_BODY_PATTERN);
    expect(second.slice(OPAQUE_SEPARATOR_INDEX + 1)).toMatch(OPAQUE_BODY_PATTERN);
  });

  it('returns a distinct id across several thousand calls', () => {
    const ids = times(UNIQUENESS_BATCH, () => newId(ID_PREFIXES.event));

    expect(new Set(ids).size).toBe(UNIQUENESS_BATCH);
    expect(ids.filter((id) => !OPAQUE_ID_PATTERN.test(id))).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The randomness source
 *
 * `ids.ts` resolves `globalThis.crypto` at CALL time, on every call, and never
 * captures it in a module-level constant. These suites are what that
 * requirement exists for: the stubs below have any effect at all only while
 * access stays lazy, so a future refactor that hoists the lookup to module
 * scope fails here rather than silently making the failure path untestable.
 *
 * Scope note: only `newTraceId` and `newSpanId` are exercised against a broken
 * global. The opaque generators reach the same global through nanoid, which
 * buffers a pool of random bytes internally — so whether a particular call
 * under a stubbed-away `crypto` throws depends on how much of that pool is
 * left. That is a fact about nanoid's buffering, not about this module's
 * contract, and a blanket "every generator throws" assertion would be asserting
 * it. Each assertion below is therefore scoped to the function whose contract
 * it tests.
 * ---------------------------------------------------------------------------
 */

/** Hosts that provide no usable `getRandomValues`, however they fail to. */
const UNUSABLE_RANDOM_SOURCES: readonly LabelledValue[] = [
  { label: 'no crypto global at all', value: undefined },
  { label: 'a crypto object with no getRandomValues', value: {} },
  { label: 'a crypto whose getRandomValues is a string', value: { getRandomValues: 'nope' } },
  { label: 'a crypto whose getRandomValues is null', value: { getRandomValues: null } },
];

describe('identifier generation without a usable Web Crypto global', () => {
  afterEach(() => {
    // Restored after every test in this suite, including a failing one, so
    // neither the rest of this file nor another file sharing the worker
    // inherits a crippled global. The last test in the suite asserts that this
    // cleanup actually happened.
    vi.unstubAllGlobals();
  });

  it.each(UNUSABLE_RANDOM_SOURCES)(
    'newTraceId reports INTERNAL when the host provides $label',
    ({ value }: LabelledValue) => {
      vi.stubGlobal('crypto', value);

      const failure = expectDebuggenError(() => newTraceId());

      expect(failure.code).toBe('INTERNAL');
      // The message names the missing capability exactly, because that string
      // is what a developer reads in a log and searches for: an id that cannot
      // be generated has no session, no panel and no other surface to report
      // itself on.
      expect(failure.message).toContain('globalThis.crypto.getRandomValues');
    },
  );

  it.each(UNUSABLE_RANDOM_SOURCES)(
    'newSpanId reports INTERNAL when the host provides $label',
    ({ value }: LabelledValue) => {
      vi.stubGlobal('crypto', value);

      const failure = expectDebuggenError(() => newSpanId());

      expect(failure.code).toBe('INTERNAL');
      expect(failure.message).toContain('globalThis.crypto.getRandomValues');
    },
  );

  it('carries a developer-facing hint alongside the message', () => {
    vi.stubGlobal('crypto', undefined);

    const failure = expectDebuggenError(() => newTraceId());

    // The hint is the field both user interfaces show beneath the message, so
    // an empty one turns a recoverable condition into a dead end.
    expect(failure.hint).toBeTypeOf('string');
    expect(failure.hint ?? '').not.toBe('');
  });

  it('records how many bytes it wanted, which names the id family in a log', () => {
    vi.stubGlobal('crypto', undefined);

    const traceFailure = expectDebuggenError(() => newTraceId());
    const spanFailure = expectDebuggenError(() => newSpanId());

    expect(traceFailure.details?.['requestedBytes']).toBe(TRACE_ID_LENGTH / 2);
    expect(spanFailure.details?.['requestedBytes']).toBe(SPAN_ID_LENGTH / 2);
  });

  it('resolves the global lazily, so removing the stub restores generation', () => {
    vi.stubGlobal('crypto', undefined);

    expectDebuggenError(() => newTraceId());

    vi.unstubAllGlobals();

    // Both halves are load-bearing. A reference captured at module load would
    // have ignored the stub, so the assertion above would not have thrown; and
    // generation working immediately here shows nothing was cached from the
    // stubbed state either. Together they are the lazy-resolution requirement.
    expect(newTraceId()).toMatch(TRACE_ID_PATTERN);
    expect(newSpanId()).toMatch(SPAN_ID_PATTERN);
  });

  it('is left unaffected by the stubs of the tests above', () => {
    // Runs with `afterEach` cleanup already applied to every preceding test in
    // this suite. Both id families are checked, the opaque one included,
    // because nanoid's pool is the part most likely to carry a stubbed state
    // forward if cleanup were incomplete.
    expect(newTraceId()).toMatch(TRACE_ID_PATTERN);
    expect(newSpanId()).toMatch(SPAN_ID_PATTERN);
    expect(newSessionId()).toMatch(OPAQUE_ID_PATTERN);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A randomness source that is present but not random
 * ---------------------------------------------------------------------------
 */

describe('identifier generation against a broken randomness source', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never returns an all-zero trace id, reporting INTERNAL instead', () => {
    let draws = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (buffer: Uint8Array): Uint8Array => {
        draws += 1;
        // A fresh Uint8Array is already zero-filled, so returning it untouched
        // is precisely a source that produces no randomness.
        return buffer;
      },
    } satisfies RandomSourceStub);

    const failure = expectDebuggenError(() => newTraceId());

    expect(failure.code).toBe('INTERNAL');
    expect(failure.message).toContain('all-zero');
    // An all-zero draw has probability 2^-128 for a trace id, so a run of them
    // is a broken host rather than bad luck: the implementation redraws a
    // bounded number of times and then reports, and the reported count is the
    // number of draws that actually happened.
    expect(draws).toBeGreaterThan(1);
    expect(failure.details?.['attempts']).toBe(draws);
  });

  it('never returns an all-zero span id, reporting INTERNAL instead', () => {
    vi.stubGlobal('crypto', zeroFillingRandomSource());

    const failure = expectDebuggenError(() => newSpanId());

    expect(failure.code).toBe('INTERNAL');
    expect(failure.message).toContain('all-zero');
  });

  it('redraws after an all-zero draw and returns the next usable value', () => {
    const zeroDraws = 3;
    let draws = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (buffer: Uint8Array): Uint8Array => {
        draws += 1;
        return draws > zeroDraws ? buffer.fill(0xab) : buffer;
      },
    } satisfies RandomSourceStub);

    const id = newTraceId();

    // The retry budget exists to survive a transient zero draw, not only to
    // refuse a permanent one, so the successful path through it is asserted
    // too: three refusals, then the first usable bytes, rendered.
    expect(draws).toBe(zeroDraws + 1);
    expect(id).toBe('ab'.repeat(TRACE_ID_LENGTH / 2));
    expect(id).toMatch(TRACE_ID_PATTERN);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Hex rendering, against a source that supplies known bytes
 *
 * The only assertions in this file that pin exact output, and the only way to
 * check the rendering itself: with real randomness there is nothing to compare
 * against but the shape.
 * ---------------------------------------------------------------------------
 */

describe('rendering random bytes as an identifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders every byte as two lowercase hex characters', () => {
    vi.stubGlobal('crypto', constantRandomSource(0xfe));

    expect(newTraceId()).toBe('fe'.repeat(TRACE_ID_LENGTH / 2));
    expect(newSpanId()).toBe('fe'.repeat(SPAN_ID_LENGTH / 2));
  });

  it('keeps the leading zero of a byte below 0x10', () => {
    vi.stubGlobal('crypto', constantRandomSource(0x0a));

    // Without the pad, every byte under 0x10 would contribute one character
    // instead of two and the id would come out short. That failure would not
    // read as a formatting bug: the length-anchored patterns would reject the
    // id, the `traceparent` header would be ignored by its receiver, and the
    // symptom would be "correlation stopped working".
    const id = newTraceId();

    expect(id).toBe('0a'.repeat(TRACE_ID_LENGTH / 2));
    expect(id).toMatch(TRACE_ID_PATTERN);
  });

  it('preserves byte order and accepts zero bytes inside a non-zero id', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (buffer: Uint8Array): Uint8Array => {
        for (let index = 0; index < buffer.length; index += 1) {
          buffer[index] = index;
        }
        return buffer;
      },
    } satisfies RandomSourceStub);

    // Bytes 0x00 through 0x07, rendered in the order they were drawn: byte
    // order is what makes an id reproducible across the producer that stamps it
    // and the store that reads it back. It also shows that a zero *byte* is
    // perfectly fine — only an entirely zero id is the reserved value.
    const id = newSpanId();

    expect(id).toBe('0001020304050607');
    expect(isSpanId(id)).toBe(true);
    expect(id).not.toBe('0'.repeat(SPAN_ID_LENGTH));
  });
});

/*
 * ---------------------------------------------------------------------------
 * The exported type surface
 *
 * `ids.ts` exports eleven type aliases alongside its generators, and they are
 * how a signature elsewhere says which identifier it means — the consumers
 * this module's own overview names: the message envelope's `MessageId` in
 * `@debuggen/protocol`, action and modification ids in
 * `@debuggen/instrumentation`, and the session, capture, panel and analysis
 * ids that `apps/local-service` also uses as store primary keys. Every runtime
 * suite above would pass unchanged if one of those `export` modifiers were
 * dropped or an alias renamed, because types are erased before Vitest ever
 * runs the file.
 *
 * The assertions below are therefore compile-time, checked by `tsc -b`
 * (`pnpm typecheck`) because `packages/shared/tsconfig.json` includes the
 * colocated tests in the program. Two things have teeth:
 *
 * - **The imports.** Removing an `export`, renaming an alias or dropping it
 *   from the barrel is a compile error in this file.
 * - **The exact return types.** Each alias resolves to `string` today, so a
 *   pin against the alias and a pin against `string` agree — but they stop
 *   agreeing the moment an alias becomes a branded or narrowed type, and this
 *   is where a generator that still returns a bare string fails. `newId` is
 *   pinned to plain `string` for the same reason from the other direction: it
 *   takes an arbitrary prefix, so it has no entity type to promise.
 * ---------------------------------------------------------------------------
 */

describe('the exported identifier type surface', () => {
  it('types each opaque generator as the alias its consumers import', () => {
    expectTypeOf(newSessionId).returns.toEqualTypeOf<SessionId>();
    expectTypeOf(newCaptureId).returns.toEqualTypeOf<CaptureId>();
    expectTypeOf(newPanelId).returns.toEqualTypeOf<PanelId>();
    expectTypeOf(newAnalysisId).returns.toEqualTypeOf<AnalysisId>();
    expectTypeOf(newModificationId).returns.toEqualTypeOf<ModificationId>();
    expectTypeOf(newActionId).returns.toEqualTypeOf<ActionId>();
    expectTypeOf(newEventId).returns.toEqualTypeOf<EventId>();
    expectTypeOf(newMessageId).returns.toEqualTypeOf<MessageId>();
    expectTypeOf(newProducerId).returns.toEqualTypeOf<ProducerId>();

    // The runtime witnesses: each annotation is the assertion — a generator
    // whose result no longer satisfies its alias fails to compile here — and
    // the shared pattern check proves the annotated values are the real ids
    // rather than a type-level fiction.
    const sessionId: SessionId = newSessionId();
    const captureId: CaptureId = newCaptureId();
    const panelId: PanelId = newPanelId();
    const analysisId: AnalysisId = newAnalysisId();
    const modificationId: ModificationId = newModificationId();
    const actionId: ActionId = newActionId();
    const eventId: EventId = newEventId();
    const messageId: MessageId = newMessageId();
    const producerId: ProducerId = newProducerId();
    const minted = [
      sessionId,
      captureId,
      panelId,
      analysisId,
      modificationId,
      actionId,
      eventId,
      messageId,
      producerId,
    ];

    expect(minted).toHaveLength(idKinds().length);
    expect(minted.filter((id) => !OPAQUE_ID_PATTERN.test(id))).toEqual([]);
  });

  it('types the W3C generators as TraceId and SpanId, and newId as a plain string', () => {
    expectTypeOf(newTraceId).returns.toEqualTypeOf<TraceId>();
    expectTypeOf(newSpanId).returns.toEqualTypeOf<SpanId>();
    // `newId` is the escape hatch for a prefix `ID_PREFIXES` does not name, so
    // it promises the shape and no entity identity.
    expectTypeOf(newId).returns.toEqualTypeOf<string>();
    expectTypeOf(newId).parameters.toEqualTypeOf<[string]>();

    const traceId: TraceId = newTraceId();
    const spanId: SpanId = newSpanId();

    expect(traceId).toMatch(TRACE_ID_PATTERN);
    expect(spanId).toMatch(SPAN_ID_PATTERN);
  });

  it('types the guards as predicates over those aliases', () => {
    const candidate: unknown = newTraceId();

    expectTypeOf(isTraceId).parameters.toEqualTypeOf<[unknown]>();
    expectTypeOf(isSpanId).parameters.toEqualTypeOf<[unknown]>();

    if (isTraceId(candidate)) {
      // Narrowing to the alias, not to `string`: a guard that regressed to
      // `boolean` would leave `candidate` as `unknown` and fail to compile.
      const narrowed: TraceId = candidate;

      expect(narrowed).toMatch(TRACE_ID_PATTERN);
    } else {
      expect.unreachable('a freshly generated trace id must satisfy isTraceId');
    }
  });
});
