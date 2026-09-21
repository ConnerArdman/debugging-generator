/**
 * Tests for `./errors.ts`: the closed error-code vocabulary and the error class
 * every workspace in this monorepo throws and every boundary catches.
 *
 * This is the bottom of the package graph, so the two things on trial here fail
 * further away than they are raised.
 *
 * 1. **The code table is a contract, not a list.** `@debuggen/protocol`
 *    enumerates `DEBUGGEN_ERROR_CODES` when it builds its `error` and
 *    `instrumentation.failed` payload schemas, and both user interfaces pick a
 *    recovery path from the code rather than from the message text. A duplicate
 *    entry, a lowercase or hyphenated one, or a silently renamed code therefore
 *    reaches the wire as an unparseable frame or as a failure no surface knows
 *    how to render — after eleven workspaces have already imported it. The
 *    first suite below is the cheap place to catch that.
 *
 * 2. **The brand is what makes an error survive the trip — and the brand alone
 *    is not enough.** Four processes cooperate — the local service, the VS Code
 *    extension host, the DevTools panel and the page agent — and each bundles
 *    its own copy of this module. Two copies of a class are two constructor
 *    identities, so `instanceof` says `false` for an error that is structurally
 *    exactly a `DebuggenError`; a value that arrived through `postMessage`,
 *    `structuredClone` or JSON has no prototype left at all. `DebuggenError.is`
 *    therefore tests structure rather than constructor identity — but it
 *    narrows to the full class, so it has to test the *whole* structure the
 *    class declares: an **own** brand, the `name` the class names itself, a
 *    `code` from the closed vocabulary, a string `message`, and `stack`, `hint`
 *    and `details` of their declared types when they are present, plus a
 *    callable `toPayload`. A value that carries the brand and nothing else is
 *    not an error a caller can use; narrowing one would make
 *    `DebuggenError.from(caught).toPayload()` throw from inside the error
 *    reporter, would let an invented code reach the protocol's closed-set
 *    schema, and — for a numeric `hint`, which `toPayload` copies through
 *    verbatim — would put a payload on the wire that fails that schema at the
 *    far end. The `is` suite asserts the cross-bundle positives — including a
 *    locally declared class that is what another bundle's copy really looks
 *    like, and values carrying the optional members legitimately — and every
 *    incomplete shape that must stay out, one per member, each row otherwise
 *    complete so a failure names the condition that stopped being checked; the
 *    `from` suite asserts that those incomplete shapes are rebuilt into real
 *    instances, with the wrongly typed members dropped rather than copied,
 *    rather than discarded.
 *
 * Two assertion habits in here are deliberate and worth keeping.
 *
 * - **Key presence, not `undefined`.** `toPayload()` output is serialised onto
 *   the wire, where a present-but-`undefined` `hint` becomes `"hint": null`
 *   after a JSON round-trip and fails the protocol's schema. So the payload
 *   tests assert `'hint' in payload` and the exact `Object.keys` list, not
 *   `payload.hint === undefined`, which a broken implementation would satisfy.
 * - **Identity, not equality.** `cause`, `details` and the value `from` returns
 *   for something that already satisfies the contract are asserted with `toBe`.
 *   A wrapper that copied or re-serialised any of them would pass a `toEqual`
 *   and still lose the original stack, the caller's reference, or the specific
 *   code a deeper layer chose.
 * - **Every narrowed value is then used.** For each shape `is` accepts, the
 *   suite calls `toPayload()` on the narrowed value and asserts the object it
 *   returns. A guard that promises the class without checking for the method is
 *   only caught by calling it, which is what the table at the end of the `is`
 *   suite does.
 *
 * Runtime facts these tests encode, measured against Node 24 rather than
 * assumed: an instance's own enumerable properties are `name`, the brand,
 * `code` and whichever of `hint`/`details` was supplied (`message` and `stack`
 * are non-enumerable, which is exactly why the wire form is `toPayload()` and
 * not the instance, and why a JSON revival of an instance arrives without a
 * message); `structuredClone` of an `Error` *instance* keeps none of them, while
 * `structuredClone` of a plain object carrying the brand keeps the brand but
 * refuses a function-valued property outright, and symbol-keyed properties
 * survive neither.
 */

import { describe, expect, it } from 'vitest';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  type DebuggenErrorCode,
  type DebuggenErrorOptions,
} from './errors.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/**
 * The own-property name that marks a value as a `DebuggenError`.
 *
 * Restated here rather than imported on purpose: `errors.ts` keeps its
 * `DEBUGGEN_ERROR_BRAND` constant module-private, and the cross-bundle contract
 * *is* this string — a copy of the class from another bundle, possibly built
 * from a different revision of the file, agrees with this one only while the
 * literal stays byte-identical. Stating it independently means a rename shows
 * up here as a failing test instead of as a guard that quietly stops matching.
 */
const BRAND_KEY = '__isDebuggenError__';

/**
 * The `name` every `DebuggenError` carries, restated here for the same reason
 * as the brand: the class declares it as that exact literal, so it is part of
 * the structure `DebuggenError.is` narrows to, and a copy of the class from
 * another bundle agrees with this one only while the literal matches.
 */
const ERROR_NAME = 'DebuggenError';

/**
 * `SCREAMING_SNAKE_CASE`: an uppercase letter, then uppercase letters and
 * digits in underscore-separated groups, with no leading, trailing or doubled
 * underscore and no lowercase or hyphen anywhere.
 */
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/**
 * Codes other workspaces are specified to report with, spot-checked so a rename
 * at the bottom of the graph cannot land quietly.
 *
 * One per concern the product actually has to distinguish: the containment
 * failure and the filesystem-policy failure that guard the developer's project,
 * the conflict that must never overwrite their edit, the empty capture that is
 * a dead end rather than a defect, the two model-artifact refusals, the
 * unparseable frame, and the last-resort code `from` defaults to.
 *
 * Typed `readonly string[]` and not `readonly DebuggenErrorCode[]` on purpose:
 * as a `DebuggenErrorCode[]` a deleted code would fail to *compile* this file,
 * which reports the loss as a type error in a test rather than as the assertion
 * below naming the missing code.
 */
const REQUIRED_CODES: readonly string[] = [
  'PATH_OUTSIDE_PROJECT',
  'FS_UNSAFE_PATH',
  'MODIFICATION_CONFLICT',
  'CAPTURE_EMPTY',
  'MODEL_OUTPUT_INVALID',
  'PANEL_SEMANTIC_INVALID',
  'PROTOCOL_INVALID_MESSAGE',
  'INTERNAL',
];

/**
 * A code used wherever a test needs one that is not the `INTERNAL` default, so
 * an assertion about a default can never pass by coincidence.
 */
const SPECIFIC_CODE: DebuggenErrorCode = 'STORE_ERROR';

/**
 * A code that is deliberately *not* in `DEBUGGEN_ERROR_CODES`, standing for
 * what a hand-rolled imitation, a newer revision of a foreign bundle or a
 * corrupted frame carries.
 *
 * Typed `string`, because as a `DebuggenErrorCode` it would not compile — which
 * is the point: the vocabulary is closed at the type level inside this
 * repository, and `is`/`from` are what close it at run time for values that
 * arrive from outside it.
 */
const INVALID_CODE = 'NOT_A_REAL_CODE';

/** The message the foreign-bundle and branded-plain-object fixtures carry. */
const FOREIGN_MESSAGE = 'Raised by another copy of this module.';

/** The message the store-failure fixtures carry. */
const STORE_MESSAGE = 'The session store failed.';

/** The hint the store-failure fixtures carry. */
const STORE_HINT = 'Check the session store.';

/**
 * The closed vocabulary as a lookup set, restated here so a test can ask
 * whether a normalised code is a member without depending on the module-private
 * set `errors.ts` builds for the same purpose.
 */
const KNOWN_CODES: ReadonlySet<string> = new Set<string>(DEBUGGEN_ERROR_CODES);

/**
 * What another bundle's copy of `DebuggenError` actually looks like: a class of
 * its own, declared here rather than described, so the cross-bundle case is
 * tested against the thing it claims to be.
 *
 * Every property the contract asks for is present the way the real class
 * provides it — the brand and `code` as own enumerable fields, `message`
 * inherited from the `Error` base, `toPayload` on the prototype — while the
 * constructor identity is a different one, so `instanceof DebuggenError` is
 * `false` for every instance. That combination is exactly the capability the
 * brand exists for, and the reason `is` must not reach for `instanceof`.
 *
 * `code` is typed `string` rather than `DebuggenErrorCode` because a foreign
 * copy may be a revision ahead or behind this one; the same class therefore
 * builds both the in-vocabulary and the invented-code fixtures.
 */
class ForeignBundleError extends Error {
  /** The real class sets the same name, being the same source. */
  override readonly name = 'DebuggenError';

  /** The brand, own and enumerable exactly as the real class sets it. */
  readonly __isDebuggenError__ = true;

  /** Whatever code the other bundle's vocabulary held. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }

  /** The wire form, reached through the prototype just as the real one is. */
  toPayload(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

/**
 * A fresh foreign-bundle instance; fresh per call so identity tests are honest.
 *
 * @param code The code the other bundle chose. Defaults to a code this
 * revision knows.
 */
function foreignBundleError(code: string = SPECIFIC_CODE): ForeignBundleError {
  return new ForeignBundleError(code, FOREIGN_MESSAGE);
}

/**
 * The structural shape of a `DebuggenError` that satisfies the contract without
 * being an instance of anything: the brand, a code, a message and a callable
 * `toPayload`, on a plain object with `Object.prototype` behind it.
 *
 * This is what a hand-built error from a non-bundled producer looks like, and
 * the case that proves the guard is structural rather than prototype-based.
 * Written as an interface and a literal rather than by casting an instance,
 * because a cast would still produce the real class and prove nothing.
 */
interface BrandedErrorShape {
  readonly __isDebuggenError__: true;
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly toPayload: () => { code: string; message: string };
}

/**
 * A fresh structurally complete branded plain object.
 *
 * `name` is part of that completeness: the class declares it as the literal
 * `"DebuggenError"`, so an object without it would be narrowed to a type whose
 * `name` is a string while its runtime value is `undefined`.
 *
 * @param code The code to carry. Defaults to a code this revision knows.
 * @param message The message to carry.
 */
function brandedPlainError(
  code: string = SPECIFIC_CODE,
  message: string = FOREIGN_MESSAGE,
): BrandedErrorShape {
  return {
    __isDebuggenError__: true,
    name: ERROR_NAME,
    code,
    message,
    // An arrow rather than a method, so the callable is an own property and
    // nothing in the fixture depends on `this`.
    toPayload: () => ({ code, message }),
  };
}

/**
 * The complete branded shape as a mutable bag of own properties, which the
 * negative rows below derive from by spoiling or removing exactly one member.
 *
 * Typed `Record<string, unknown>` rather than {@link BrandedErrorShape} on
 * purpose: these fixtures stand for values that arrive from outside this
 * repository, where a member may be missing or hold the wrong type, and neither
 * is expressible in the interface the real shape satisfies.
 */
function completeBrandedShape(): Record<string, unknown> {
  return {
    [BRAND_KEY]: true,
    name: ERROR_NAME,
    code: SPECIFIC_CODE,
    message: STORE_MESSAGE,
    toPayload: () => ({ code: SPECIFIC_CODE, message: STORE_MESSAGE }),
  };
}

/**
 * The complete shape with one member replaced by a value of the wrong type.
 *
 * @param member The member to spoil.
 * @param value What to put there instead.
 */
function brandedShapeWith(member: string, value: unknown): Record<string, unknown> {
  const shape = completeBrandedShape();
  shape[member] = value;
  return shape;
}

/**
 * The complete shape with one member absent entirely.
 *
 * Built by filtering the entries rather than by deleting a key, so the result
 * is a fresh object with no trace of the removed member — an own property set
 * to `undefined` would be a different test.
 *
 * @param member The member to leave out.
 */
function brandedShapeWithout(member: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(completeBrandedShape()).filter(([key]) => key !== member),
  );
}

/**
 * A value that inherits the brand and everything else from a branded prototype
 * and owns nothing itself.
 *
 * Not a shape this product ever produces — every copy of the class installs the
 * brand as a per-instance field, and every revival, clone and literal carries
 * it as an own key — which is exactly why `is` may insist on own-ness. `from`
 * still reads through the chain and rebuilds it, so refusing the narrowing
 * costs the value nothing.
 */
function inheritedBrandShape(): unknown {
  return Object.create(completeBrandedShape()) as unknown;
}

/**
 * A real instance put through `JSON.stringify`/`JSON.parse`, which is what a
 * naive "send the error" implementation produces at a process boundary.
 *
 * The revival keeps the own enumerable properties — the brand, `name`, `code`
 * and `hint` — and loses `message` and `stack`, both non-enumerable, along with
 * the prototype and therefore `toPayload`. It is the concrete value behind the
 * rule that an error crosses a boundary as a `toPayload()` object.
 */
function revivedInstance(): unknown {
  const error = new DebuggenError(SPECIFIC_CODE, STORE_MESSAGE, { hint: STORE_HINT });
  const revived: unknown = JSON.parse(JSON.stringify(error));
  return revived;
}

/** A node in a self-referencing object graph. */
interface CyclicNode {
  label: string;
  self?: CyclicNode;
}

/**
 * A value `JSON.stringify` refuses: an error reporter that tried to stringify
 * an unknown input would throw *from the failure path*, replacing the original
 * failure with a `TypeError` about a circular structure.
 */
function cyclicValue(): CyclicNode {
  const node: CyclicNode = { label: 'cycle' };
  node.self = node;
  return node;
}

/** A labelled case for the table-driven suites. */
interface LabelledValue {
  readonly label: string;
  readonly value: unknown;
}

/**
 * Thrown values that are neither an `Error` nor branded. JavaScript allows
 * throwing any of these, and `catch` binds `unknown`, so `from` has to produce
 * a typed error for every one of them without inspecting the value beyond its
 * type.
 *
 * `10n` is here because `JSON.stringify` throws on a `bigint` just as it does
 * on a cycle, and the symbol because it is not concatenable — both are the
 * shapes that punish a reporter for reaching for stringification.
 */
const UNCLASSIFIABLE_VALUES: readonly LabelledValue[] = [
  { label: 'null', value: null },
  { label: 'a number', value: 42 },
  { label: 'a bigint', value: 10n },
  { label: 'false', value: false },
  { label: 'an empty string', value: '' },
  { label: 'a symbol', value: Symbol('reason') },
  { label: 'a plain object', value: { kind: 'plain' } },
  { label: 'an array', value: [1, 2] },
  { label: 'a function', value: () => undefined },
];

/**
 * Values `DebuggenError.is` must reject. The last four matter most: a truthy
 * brand that is not exactly `true` (a string, a number) is what a sloppy
 * hand-rolled copy or a mangled JSON revival looks like, and accepting one
 * would let an arbitrary object through the type guard and into a `catch` block
 * that then reads `.code` off it.
 */
const UNBRANDED_VALUES: readonly LabelledValue[] = [
  { label: 'a native Error', value: new Error('plain') },
  { label: 'a native TypeError', value: new TypeError('wrong type') },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'a string', value: 'DebuggenError' },
  { label: 'a number', value: 0 },
  { label: 'an array', value: [] },
  { label: 'an object with a code but no brand', value: { code: 'INTERNAL', message: 'nope' } },
  { label: 'an object whose brand is false', value: { [BRAND_KEY]: false, code: 'INTERNAL' } },
  { label: 'an object whose brand is the string "true"', value: { [BRAND_KEY]: 'true' } },
  { label: 'an object whose brand is the number 1', value: { [BRAND_KEY]: 1 } },
];

/**
 * A labelled case whose value is built fresh for each use, so a suite may
 * assert identity against it and a suite that hands it to `from` cannot be
 * affected by what an earlier test did with it.
 */
interface LabelledFactory {
  readonly label: string;
  readonly build: () => unknown;
}

/**
 * Values that carry the brand and fail the rest of the contract — the shapes
 * `is` must reject and `from` must rebuild.
 *
 * There is one row per member the contract checks, and each is built from the
 * complete shape by removing or spoiling exactly that member, so a failing row
 * names the condition that stopped being checked rather than failing for an
 * unrelated reason. The two deliberate exceptions are stated by their labels:
 * the first row carries the brand alone, and the last is a real revival — both
 * fail several conditions at once because that is what they look like in life.
 *
 * None of these is hypothetical: the brand-only row is what a value looks like
 * when only the brand was copied across, the revival is what `JSON.stringify`
 * of an instance produces, the invented code is what a foreign bundle a
 * revision ahead sends, the missing or non-callable `toPayload` is what every
 * clone and every JSON round-trip produces because a function cannot travel,
 * the numeric hint is what an untyped producer writes, and the inherited brand
 * is what an object assembled behind a branded prototype looks like.
 */
const INCOMPLETE_BRANDED_VALUES: readonly LabelledFactory[] = [
  {
    label: 'the brand and nothing else',
    build: () => ({ [BRAND_KEY]: true }),
  },
  {
    label: 'no message',
    build: () => brandedShapeWithout('message'),
  },
  {
    label: 'a message that is not a string',
    build: () => brandedShapeWith('message', 42),
  },
  {
    label: 'no code',
    build: () => brandedShapeWithout('code'),
  },
  {
    label: 'a code that is not in the closed vocabulary',
    build: () => brandedPlainError(INVALID_CODE),
  },
  {
    label: 'a complete instance from a foreign bundle one vocabulary revision ahead',
    build: () => foreignBundleError(INVALID_CODE),
  },
  {
    label: 'no toPayload',
    build: () => brandedShapeWithout('toPayload'),
  },
  {
    label: 'a toPayload that is not callable',
    build: () => brandedShapeWith('toPayload', 'not a function'),
  },
  {
    label: 'no name',
    build: () => brandedShapeWithout('name'),
  },
  {
    label: 'a name belonging to some other error class',
    build: () => brandedShapeWith('name', 'Error'),
  },
  {
    label: 'a name that is not a string',
    build: () => brandedShapeWith('name', 42),
  },
  {
    label: 'a stack that is not a string',
    build: () => brandedShapeWith('stack', 42),
  },
  {
    label: 'a hint that is not a string',
    build: () => brandedShapeWith('hint', 42),
  },
  {
    label: 'details that are an array',
    build: () => brandedShapeWith('details', [1]),
  },
  {
    label: 'details that are not an object at all',
    build: () => brandedShapeWith('details', 'sessions'),
  },
  {
    label: 'a brand it only inherits, owning nothing itself',
    build: inheritedBrandShape,
  },
  {
    label: 'an instance revived from its own JSON, which lost its message',
    build: revivedInstance,
  },
];

/** A labelled case that `is` must accept, with the payload it must then yield. */
interface NarrowableCase extends LabelledFactory {
  readonly payload: Readonly<Record<string, string>>;
}

/**
 * Every shape `is` accepts, each paired with the exact object `toPayload()` has
 * to return once the value has been narrowed.
 *
 * The table exists to be *called*, not merely recognised: a guard that promises
 * this class without checking for its method table is caught only by invoking
 * the method, and invoking it on a value the guard accepted is the assertion
 * that fails when the contract loosens again.
 */
const CONTRACT_SATISFYING_VALUES: readonly NarrowableCase[] = [
  {
    label: 'a real instance',
    build: () => new DebuggenError(SPECIFIC_CODE, STORE_MESSAGE),
    payload: { code: SPECIFIC_CODE, message: STORE_MESSAGE },
  },
  {
    label: 'a real instance carrying a hint',
    build: () => new DebuggenError(SPECIFIC_CODE, STORE_MESSAGE, { hint: STORE_HINT }),
    payload: { code: SPECIFIC_CODE, message: STORE_MESSAGE, hint: STORE_HINT },
  },
  {
    label: "a foreign bundle's instance",
    build: () => foreignBundleError(),
    payload: { code: SPECIFIC_CODE, message: FOREIGN_MESSAGE },
  },
  {
    label: 'a structurally complete branded plain object',
    build: () => brandedPlainError(),
    payload: { code: SPECIFIC_CODE, message: FOREIGN_MESSAGE },
  },
  {
    label: 'an error rebuilt by from() out of an incomplete branded value',
    build: () => DebuggenError.from(revivedInstance(), SPECIFIC_CODE),
    payload: { code: SPECIFIC_CODE, message: 'Unknown error', hint: STORE_HINT },
  },
  {
    // The optional members are checked only when present, so a value that
    // carries them of the right type must still be accepted — the guard has to
    // be sound in both directions for `hint` and `details` as well as for
    // `message`.
    label: 'a real instance carrying a hint and details',
    build: () =>
      new DebuggenError(SPECIFIC_CODE, STORE_MESSAGE, {
        hint: STORE_HINT,
        details: { table: 'sessions' },
      }),
    payload: { code: SPECIFIC_CODE, message: STORE_MESSAGE, hint: STORE_HINT },
  },
  {
    label: 'a branded plain object carrying a string hint and object details',
    build: () => ({
      ...completeBrandedShape(),
      hint: STORE_HINT,
      details: { table: 'sessions' },
      toPayload: () => ({ code: SPECIFIC_CODE, message: STORE_MESSAGE, hint: STORE_HINT }),
    }),
    payload: { code: SPECIFIC_CODE, message: STORE_MESSAGE, hint: STORE_HINT },
  },
];

/**
 * Assert that `value` satisfies `DebuggenError.is`, and hand it back narrowed.
 *
 * The narrowing is the point: the returned value is typed `DebuggenError`, so a
 * caller reads `code` and calls `toPayload()` exactly as production code does
 * after its own `is` check — which is what makes a guard that accepted an
 * incomplete value fail here rather than in a `catch` block somewhere else.
 *
 * @param value The value under test.
 * @returns `value`, typed as a `DebuggenError`.
 */
function narrowedError(value: unknown): DebuggenError {
  expect(DebuggenError.is(value), 'the value must satisfy DebuggenError.is').toBe(true);

  if (!DebuggenError.is(value)) {
    // Unreachable: the expectation above has already failed the test. Present
    // so this function's return type is `DebuggenError` rather than `unknown`.
    throw new Error('Expected the value to satisfy DebuggenError.is.');
  }

  return value;
}

/*
 * ---------------------------------------------------------------------------
 * The code table
 * ---------------------------------------------------------------------------
 */

describe('DEBUGGEN_ERROR_CODES', () => {
  it('is a non-empty table', () => {
    expect(DEBUGGEN_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('contains no duplicate codes', () => {
    const seen = new Set<string>();
    const duplicates = DEBUGGEN_ERROR_CODES.filter((code) => {
      const repeated = seen.has(code);
      seen.add(code);
      return repeated;
    });

    // Reported as the offending list rather than as a size comparison, so a
    // failure names the code that was added twice.
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(DEBUGGEN_ERROR_CODES.length);
  });

  it('spells every code in SCREAMING_SNAKE_CASE', () => {
    const malformed = DEBUGGEN_ERROR_CODES.filter(
      (code: string) =>
        typeof code !== 'string' || code.length === 0 || !SCREAMING_SNAKE.test(code),
    );

    expect(malformed).toEqual([]);
  });

  it('includes every code the rest of the product is specified to report', () => {
    const present = new Set<string>(DEBUGGEN_ERROR_CODES);
    const missing = REQUIRED_CODES.filter((code) => !present.has(code));

    expect(missing).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Construction
 * ---------------------------------------------------------------------------
 */

describe('new DebuggenError', () => {
  it('stores the code, the message, the hint and the details', () => {
    const details = { attempts: 3, stage: 'instrumenting' } as const;
    const options: DebuggenErrorOptions = {
      hint: 'Reload the page, then start capture again.',
      details,
    };
    const error = new DebuggenError(
      'AGENT_NOT_READY',
      'The page agent has not reported in.',
      options,
    );

    expect(error.code).toBe('AGENT_NOT_READY');
    expect(error.message).toBe('The page agent has not reported in.');
    expect(error.hint).toBe('Reload the page, then start capture again.');
    // Identity, not equality: details are handed through, never copied, so a
    // caller's object and the error's are the same reference.
    expect(error.details).toBe(details);
  });

  it('is an Error named DebuggenError', () => {
    const error = new DebuggenError('INTERNAL', 'Something gave way.');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DebuggenError);
    expect(error.name).toBe('DebuggenError');
    // The point of overriding `name`: both the standard string form and the
    // formatted stack name this class rather than the plain Error it extends.
    expect(String(error)).toBe('DebuggenError: Something gave way.');
    expect(error.stack ?? '').toContain('DebuggenError: Something gave way.');
  });

  it('preserves the cause it was given, by identity', () => {
    const root = new Error('root');
    const error = new DebuggenError('STORE_ERROR', 'The session store failed.', { cause: root });

    expect(error.cause).toBe(root);
  });

  it('creates no hint, details or cause property when none was given', () => {
    const error = new DebuggenError('CAPTURE_EMPTY', 'No telemetry was captured.');

    // `in`, not `=== undefined`: these properties must be absent, so that a
    // JSON round-trip of the error's own properties carries no null-valued key
    // and a `'hint' in error` check downstream answers honestly.
    expect('hint' in error).toBe(false);
    expect('details' in error).toBe(false);
    expect('cause' in error).toBe(false);
  });

  it('carries the brand as an own enumerable property', () => {
    const error = new DebuggenError(SPECIFIC_CODE, 'Branded.');

    // Own and enumerable is the requirement, not merely readable: a prototype
    // member would be invisible to every clone and to JSON, which is the whole
    // reason the brand is set on the instance.
    expect(Object.hasOwn(error, BRAND_KEY)).toBe(true);
    expect(Object.keys(error)).toContain(BRAND_KEY);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The wire form
 * ---------------------------------------------------------------------------
 */

describe('DebuggenError#toPayload', () => {
  it('returns exactly the code and the message when no hint was given', () => {
    const error = new DebuggenError('CAPTURE_EMPTY', 'No telemetry was captured.');
    const payload = error.toPayload();

    expect(payload).toEqual({ code: 'CAPTURE_EMPTY', message: 'No telemetry was captured.' });
    // The absence of the key itself, not an `undefined` value: this object is
    // serialised onto the wire, where a present `undefined` becomes `null` and
    // fails the protocol's schema at the receiving end.
    expect('hint' in payload).toBe(false);
    expect(Object.keys(payload)).toEqual(['code', 'message']);
  });

  it('includes the hint when the error has one', () => {
    const error = new DebuggenError('DEV_SERVER_UNAVAILABLE', 'No dev server answered.', {
      hint: 'Start the dev server, then try again.',
    });
    const payload = error.toPayload();

    expect(payload).toEqual({
      code: 'DEV_SERVER_UNAVAILABLE',
      message: 'No dev server answered.',
      hint: 'Start the dev server, then try again.',
    });
    expect(Object.keys(payload)).toEqual(['code', 'message', 'hint']);
  });

  it('never carries details or cause', () => {
    const error = new DebuggenError('STORE_ERROR', 'The session store failed.', {
      hint: 'Check the session store.',
      details: { table: 'sessions' },
      cause: new Error('SQLITE_BUSY'),
    });
    const payload = error.toPayload();

    // Details are diagnostic context for this process's log and a cause is
    // frequently an Error: neither is safe to assume serialisable, and neither
    // belongs in a message a user interface renders.
    expect('details' in payload).toBe(false);
    expect('cause' in payload).toBe(false);
    expect(Object.keys(payload)).toEqual(['code', 'message', 'hint']);
  });

  it('is JSON-safe and survives a round-trip unchanged', () => {
    const error = new DebuggenError('PANEL_SEMANTIC_INVALID', 'The panel cited absent evidence.', {
      hint: 'Regenerate the panel.',
      details: { missingEventIds: ['evt-1'] },
      cause: new Error('validation'),
    });
    const payload = error.toPayload();
    // Typed `unknown` rather than left as `JSON.parse`'s `any`, so nothing in
    // this assertion is exempt from the type-aware lint rules.
    const roundTripped: unknown = JSON.parse(JSON.stringify(payload));

    expect(roundTripped).toEqual(payload);
  });

  it('returns a fresh object each call, so a caller cannot mutate the error', () => {
    const error = new DebuggenError(SPECIFIC_CODE, 'The session store failed.');
    const first = error.toPayload();
    const second = error.toPayload();

    expect(first).not.toBe(second);

    first.hint = 'mutated';

    expect('hint' in second).toBe(false);
    expect('hint' in error).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Normalising anything a boundary catches
 * ---------------------------------------------------------------------------
 */

describe('DebuggenError.from', () => {
  it('returns the very same instance when the value already is a DebuggenError', () => {
    const existing = new DebuggenError('MODIFICATION_CONFLICT', 'The file was edited.', {
      hint: 'Open the diff.',
    });

    expect(DebuggenError.from(existing)).toBe(existing);
  });

  it('never lets a fallback code override an existing one', () => {
    const existing = new DebuggenError('MODIFICATION_CONFLICT', 'The file was edited.');

    // The specific code a deeper layer chose is the whole value of the code:
    // re-labelling it at a boundary would erase what the surface renders.
    expect(DebuggenError.from(existing, 'INTERNAL').code).toBe('MODIFICATION_CONFLICT');
  });

  it('is idempotent', () => {
    const first = DebuggenError.from(new Error('boom'));

    expect(DebuggenError.from(first)).toBe(first);
  });

  it("returns a foreign bundle's instance unchanged rather than rebuilding it", () => {
    const foreign = foreignBundleError();

    // Rebuilding would mint a new instance with a new stack and would drop
    // whatever else the other copy attached; the brand exists so a value that
    // satisfies the whole contract can be recognised and passed through
    // instead, even though `instanceof` answers false for it.
    expect(foreign instanceof DebuggenError).toBe(false);
    expect(DebuggenError.from(foreign)).toBe(foreign);
  });

  it('returns a structurally complete branded plain object unchanged', () => {
    const branded = brandedPlainError();

    // No prototype from this class, yet every element of the contract is
    // present: passing it through is safe precisely because `toPayload` is
    // callable on it.
    expect(DebuggenError.from(branded)).toBe(branded);
  });

  it.each(INCOMPLETE_BRANDED_VALUES)(
    'rebuilds a real error from a branded value with $label',
    ({ build }: LabelledFactory) => {
      const incomplete = build();
      const normalized = DebuggenError.from(incomplete, SPECIFIC_CODE);

      // Passing an incomplete value through is what made a later
      // `.toPayload()` throw from inside the error reporter, so `from`
      // rebuilds: the result is a real instance of this class, and of this
      // bundle's copy of it.
      expect(normalized).toBeInstanceOf(DebuggenError);
      expect(DebuggenError.is(normalized)).toBe(true);
      expect(normalized).not.toBe(incomplete);

      // Nothing is lost by rebuilding: the shape that arrived is still
      // reachable, by identity, for whoever logs the failure.
      expect(normalized.cause).toBe(incomplete);

      // The two fields the wire form carries are always usable: a code inside
      // the closed vocabulary, and a message that is not a blank line.
      expect(KNOWN_CODES.has(normalized.code)).toBe(true);
      expect(normalized.message.length).toBeGreaterThan(0);

      const payload = normalized.toPayload();

      expect(payload.code).toBe(normalized.code);
      expect(payload.message).toBe(normalized.message);
    },
  );

  it('keeps an incomplete branded value out of the protocol by clamping its code', () => {
    const invented = brandedPlainError(INVALID_CODE);

    // The fixture has to be genuinely outside the vocabulary for the rest of
    // this assertion to mean anything.
    expect(KNOWN_CODES.has(INVALID_CODE)).toBe(false);

    const normalized = DebuggenError.from(invented, SPECIFIC_CODE);

    // An invented code narrowed to `DebuggenErrorCode` would reach the
    // protocol's closed-set schema as an unparseable frame; the fallback is
    // what it becomes instead. The message it did carry is still salvaged.
    expect(normalized.code).toBe(SPECIFIC_CODE);
    expect(normalized.message).toBe(FOREIGN_MESSAGE);
    expect(normalized.cause).toBe(invented);
  });

  it('rebuilds a JSON-revived instance, salvaging its code and hint', () => {
    const revived = revivedInstance();
    const normalized = DebuggenError.from(revived);

    // The revival kept the code and the hint and lost the non-enumerable
    // message, so the code a deeper layer chose and the developer's recovery
    // instruction both survive the trip, and only the message falls back to the
    // sentinel. `from`'s own default code is never reached, because the revived
    // code is in the vocabulary.
    expect(normalized).toBeInstanceOf(DebuggenError);
    expect(normalized.code).toBe(SPECIFIC_CODE);
    expect(normalized.hint).toBe(STORE_HINT);
    expect(normalized.message).toBe('Unknown error');
    expect(normalized.cause).toBe(revived);
    expect(normalized.toPayload()).toEqual({
      code: SPECIFIC_CODE,
      message: 'Unknown error',
      hint: STORE_HINT,
    });
  });

  it('salvages a message and details from a branded value, and ignores the rest', () => {
    const details = { table: 'sessions', attempts: 2 } as const;
    const branded = {
      [BRAND_KEY]: true,
      message: STORE_MESSAGE,
      hint: 7,
      details,
      stack: 'not this process\u2019s stack',
    };
    const normalized = DebuggenError.from(branded, SPECIFIC_CODE);

    expect(normalized.message).toBe(STORE_MESSAGE);
    // Identity, not equality: details are handed through by reference, as the
    // constructor does for a caller.
    expect(normalized.details).toBe(details);
    // A non-string hint is not a hint. `in`, not `=== undefined`: the key must
    // be absent so `toPayload()` carries no null hint onto the wire.
    expect('hint' in normalized).toBe(false);
    expect(normalized.toPayload()).toEqual({ code: SPECIFIC_CODE, message: STORE_MESSAGE });
  });

  it('refuses to carry array details, which would render as a keyless bag', () => {
    const branded = {
      [BRAND_KEY]: true,
      code: SPECIFIC_CODE,
      message: STORE_MESSAGE,
      details: [1],
    };
    const normalized = DebuggenError.from(branded);

    expect('details' in normalized).toBe(false);
    expect(normalized.code).toBe(SPECIFIC_CODE);
  });

  it('cannot let a non-string hint reach the wire, however callable the value is', () => {
    // The shape that motivates checking `hint` rather than only `code`,
    // `message` and callability: everything a caller reaches for is present and
    // its `toPayload` answers — with a payload that fails the protocol's
    // `{ code, message, hint? }` schema at the far end, produced by a value the
    // guard would already have called an error.
    const hinted = brandedShapeWith('hint', 42);
    const ownPayload = (hinted['toPayload'] as () => Record<string, unknown>)();

    expect(ownPayload).toEqual({ code: SPECIFIC_CODE, message: STORE_MESSAGE });
    expect(DebuggenError.is(hinted)).toBe(false);

    const normalized = DebuggenError.from(hinted);

    // Rebuilt without the bad hint rather than with it coerced: a hint is the
    // one field a developer is expected to act on, and 42 is not an
    // instruction. `in`, not `=== undefined`, so no null hint is serialised.
    expect('hint' in normalized).toBe(false);
    expect(normalized.toPayload()).toEqual({
      code: SPECIFIC_CODE,
      message: STORE_MESSAGE,
    });
    expect(normalized.cause).toBe(hinted);
  });

  it('rebuilds a value that only inherits the brand, salvaging what it inherited', () => {
    const inherited = inheritedBrandShape();

    // `is` insists on an own brand, so this value is refused the narrowing —
    // but refusing is not discarding: `from` reads through the prototype chain
    // and rebuilds, so the code and message it carried still reach the surface.
    expect(DebuggenError.is(inherited)).toBe(false);

    const normalized = DebuggenError.from(inherited);

    expect(normalized).toBeInstanceOf(DebuggenError);
    expect(normalized.code).toBe(SPECIFIC_CODE);
    expect(normalized.message).toBe(STORE_MESSAGE);
    expect(normalized.cause).toBe(inherited);
  });

  it('gives a rebuilt error this class\u2019s own name, whatever the value claimed', () => {
    const misnamed = brandedShapeWith('name', 'Error');
    const normalized = DebuggenError.from(misnamed);

    // The rebuilt value is a real instance, so it names itself correctly and a
    // formatted stack or a log line no longer attributes it elsewhere.
    expect(normalized.name).toBe(ERROR_NAME);
    expect(String(normalized)).toBe(`${ERROR_NAME}: ${STORE_MESSAGE}`);
  });

  it('is idempotent for a branded value it had to rebuild', () => {
    const normalized = DebuggenError.from(revivedInstance(), SPECIFIC_CODE);

    // The rebuilt value is a real instance, so a second boundary that
    // normalises it again gets the same object back rather than a chain of
    // wrappers with the original buried under two causes.
    expect(DebuggenError.from(normalized)).toBe(normalized);
    expect(DebuggenError.from(normalized, 'INTERNAL').code).toBe(SPECIFIC_CODE);
  });

  it('wraps a native Error with the INTERNAL default, its message and itself as cause', () => {
    const native = new Error('boom');
    const error = DebuggenError.from(native);

    expect(DebuggenError.is(error)).toBe(true);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('boom');
    expect(error.cause).toBe(native);
  });

  it('uses an explicit fallback code instead of the default', () => {
    const error = DebuggenError.from(new Error('boom'), SPECIFIC_CODE);

    expect(error.code).toBe(SPECIFIC_CODE);
    expect(error.message).toBe('boom');
  });

  it('falls back to an Error subclass name when the message is empty', () => {
    // An error with no message at all reads as a blank line in a user
    // interface, so the name is used rather than nothing.
    expect(DebuggenError.from(new Error('')).message).toBe('Error');
    expect(DebuggenError.from(new TypeError('')).message).toBe('TypeError');
  });

  it('keeps a non-empty string as both the message and the cause', () => {
    const error = DebuggenError.from('Serialised failure text', SPECIFIC_CODE);

    expect(error.code).toBe(SPECIFIC_CODE);
    expect(error.message).toBe('Serialised failure text');
    expect(error.cause).toBe('Serialised failure text');
  });

  it('wraps undefined without inventing a cause property', () => {
    const error = DebuggenError.from(undefined);

    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('Unknown error');
    expect('cause' in error).toBe(false);
  });

  it('does not throw on a cyclic value, and keeps it as the cause', () => {
    const cyclic = cyclicValue();

    // The fixture is genuinely hostile: stringifying it is what an
    // over-eager reporter would do, and it throws.
    expect(() => JSON.stringify(cyclic)).toThrow(TypeError);

    let error: DebuggenError | undefined;
    expect(() => {
      error = DebuggenError.from(cyclic, SPECIFIC_CODE);
    }).not.toThrow();

    expect(error?.code).toBe(SPECIFIC_CODE);
    expect(error?.message).toBe('Unknown error');
    expect(error?.cause).toBe(cyclic);
  });

  it.each(UNCLASSIFIABLE_VALUES)(
    'produces a DebuggenError for $label without throwing',
    ({ value }: LabelledValue) => {
      let error: DebuggenError | undefined;
      expect(() => {
        error = DebuggenError.from(value);
      }).not.toThrow();

      expect(DebuggenError.is(error)).toBe(true);
      expect(error?.code).toBe('INTERNAL');
      expect(error?.message).toBe('Unknown error');
      expect(error?.cause).toBe(value);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * The cross-bundle guard
 * ---------------------------------------------------------------------------
 */

describe('DebuggenError.is', () => {
  it('accepts a real instance', () => {
    expect(DebuggenError.is(new DebuggenError('INTERNAL', 'Something gave way.'))).toBe(true);
  });

  it("accepts a foreign bundle's instance, which is not an instance of this class", () => {
    // This is the case the brand exists for. The local service, the VS Code
    // extension host, the DevTools panel and the page agent each bundle their
    // own copy of this module, so two copies of the class are two constructor
    // identities and `instanceof` answers false for a value that is exactly
    // this shape. A structural test is the only one that can answer true — and
    // this value earns the `true` on its own merits: brand and code as own
    // properties, `message` from the `Error` base, `toPayload` on its
    // prototype.
    const foreign = foreignBundleError();

    expect(foreign instanceof DebuggenError).toBe(false);
    expect(DebuggenError.is(foreign)).toBe(true);
    expect(narrowedError(foreign).toPayload()).toEqual({
      code: SPECIFIC_CODE,
      message: FOREIGN_MESSAGE,
    });
  });

  it('accepts a structurally complete branded plain object', () => {
    // The guard is structural rather than prototype-based, so a hand-built
    // object from a producer that does not bundle this class at all is a
    // `DebuggenError` as long as it carries everything the class declares —
    // including a callable `toPayload`, which is the part a caller reaches for.
    const branded = brandedPlainError();

    expect(branded instanceof DebuggenError).toBe(false);
    expect(DebuggenError.is(branded)).toBe(true);
    expect(narrowedError(branded).toPayload()).toEqual({
      code: SPECIFIC_CODE,
      message: FOREIGN_MESSAGE,
    });
  });

  it('accepts an error with an empty message, which is a legal instance', () => {
    // The one thing the guard must not demand is message *content*: this
    // constructor call is legal, so requiring a non-empty message would make
    // the guard unsound in the other direction and reject a real error.
    const empty = new DebuggenError('INTERNAL', '');

    expect(DebuggenError.is(empty)).toBe(true);
    expect(narrowedError(empty).toPayload()).toEqual({ code: 'INTERNAL', message: '' });
  });

  it('rejects an instance revived from its own JSON, which lost its message', () => {
    const revived = revivedInstance();

    // `message` and `stack` are non-enumerable, so a JSON round-trip of an
    // instance keeps the brand, the name, the code and the hint and loses the
    // message — and the prototype with it, so there is no `toPayload` left to
    // call. Narrowing this would hand a caller a value typed as a full error
    // with no message and no wire form; it is `from` that rebuilds it.
    expect(revived).toEqual({
      [BRAND_KEY]: true,
      name: 'DebuggenError',
      code: SPECIFIC_CODE,
      hint: STORE_HINT,
    });
    expect(DebuggenError.is(revived)).toBe(false);
  });

  it('rejects a structured clone of a branded plain object, whose method cannot travel', () => {
    const branded = brandedPlainError();

    // structuredClone refuses a function-valued property outright, which is
    // the whole point: the method table is exactly what cannot cross a
    // postMessage boundary, so a cloned error is always incomplete.
    expect(() => structuredClone(branded)).toThrow();

    const clone: unknown = structuredClone({
      [BRAND_KEY]: branded.__isDebuggenError__,
      code: branded.code,
      message: branded.message,
    });

    // The brand itself does travel — a string-keyed boolean is the form that
    // does. A symbol key would not: structuredClone drops symbol-keyed
    // properties entirely, so a private symbol brand would vanish on exactly
    // the hop it was meant to survive.
    expect(clone).toEqual({ [BRAND_KEY]: true, code: SPECIFIC_CODE, message: FOREIGN_MESSAGE });
    expect(Object.getOwnPropertySymbols(structuredClone({ [Symbol('brand')]: true }))).toEqual([]);

    // Recognisable, but not usable: `is` says no, and `from` rebuilds it.
    expect(DebuggenError.is(clone)).toBe(false);
    expect(DebuggenError.from(clone).message).toBe(FOREIGN_MESSAGE);
  });

  it('rejects a cloned Error instance, because cloning an Error is lossy', () => {
    const error = new DebuggenError(SPECIFIC_CODE, 'The session store failed.');
    const clone: unknown = structuredClone(error);

    // The structured-clone algorithm keeps only `name`, `message`, `stack` and
    // `cause` of an Error, so the code and the brand do not survive it. Stated
    // as a test rather than left to be discovered: an error travels as a
    // payload the protocol validates, never as a cloned instance.
    expect(DebuggenError.is(clone)).toBe(false);
  });

  it.each(UNBRANDED_VALUES)('rejects $label', ({ value }: LabelledValue) => {
    expect(DebuggenError.is(value)).toBe(false);
  });

  it.each(INCOMPLETE_BRANDED_VALUES)(
    'rejects a branded value with $label',
    ({ build }: LabelledFactory) => {
      // The brand says where the value came from; it does not say the value is
      // usable. Narrowing any of these would type it as a full error and let a
      // caller read a code that is not in the vocabulary, format a message that
      // is not a string, or call a method that is not there.
      expect(DebuggenError.is(build())).toBe(false);
    },
  );

  it.each(CONTRACT_SATISFYING_VALUES)(
    'narrows $label to a value whose toPayload() answers',
    ({ build, payload }: NarrowableCase) => {
      // The soundness property, stated as an assertion: everything this guard
      // accepts can be used as what it was narrowed to. Calling `toPayload()`
      // on the narrowed value is what fails if the guard ever again promises
      // the class without checking for its method table.
      const narrowed = narrowedError(build());

      expect(narrowed.toPayload()).toEqual(payload);
      expect(KNOWN_CODES.has(narrowed.code)).toBe(true);
      expect(typeof narrowed.message).toBe('string');
    },
  );
});
