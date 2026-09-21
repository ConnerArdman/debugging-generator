/**
 * Tests for `./assert.ts`: the four invariant checks every workspace in this
 * monorepo throws with.
 *
 * Three things are on trial here, and each of them fails a long way from this
 * file when it is wrong.
 *
 * 1. **The assertion signatures, which are checked by the compiler rather than
 *    at run time.** `assert` declares `asserts condition` and `assertDefined`
 *    declares `asserts value is NonNullable<T>`; consumers all over the product
 *    are written on the strength of that — a session record's optional backup
 *    path used as a `string` on the next line, an array element used under
 *    `noUncheckedIndexedAccess` without a second guard. If a signature
 *    regresses to `void`, nothing in a test *run* notices: the checks still
 *    throw, the suites still pass, and the breakage surfaces as hundreds of
 *    "possibly undefined" errors in eleven other workspaces. The narrowing
 *    cases below therefore have no `as` cast and no non-null assertion in them
 *    on purpose — they are assertions the `pnpm typecheck` gate makes, and they
 *    stop compiling the moment a signature is weakened.
 *
 * 2. **The difference between `assert` and `assertDefined`, which is the only
 *    reason both exist.** `assert` tests truthiness, so `0`, `''`, `false` and
 *    `NaN` are failures; `assertDefined` tests presence, so every one of those
 *    passes. A zero duration, an empty SQL parameter, a render count of nought
 *    and a `false` agent-hook flag are all legitimate values that the wrong
 *    helper would reject, and the two tables below pin each helper to its own
 *    contract so a "simplification" that merges them fails here first.
 *
 * 3. **`assertNever`'s message builder, which must not become the failure it is
 *    reporting.** It runs on a value the type system said could not exist — a
 *    frame from a newer peer, a variant added without extending a `switch` —
 *    and it is reached at exactly the moment the process is already confused.
 *    Interpolating a symbol into a template literal throws `TypeError`,
 *    `String()` on an object runs whatever `toString` that object brought with
 *    it, `JSON.stringify` throws on a cycle and on a `bigint`, and a proxy
 *    throws from its own traps. Any of those replaces a precise
 *    `DebuggenError` with an unrelated error raised inside the error reporter,
 *    which is how a diagnostic tool loses the diagnosis. The hostile inputs
 *    below are each one of those traps.
 *
 * A fourth property is asserted once per helper rather than once per case:
 * every value these four functions throw satisfies `DebuggenError.is` and
 * carries a code from the closed `DEBUGGEN_ERROR_CODES` set. Four processes
 * bundle their own copy of the error class, so `instanceof` is not a question
 * worth asking across a boundary; the brand is what the protocol layer, both
 * user interfaces and every `catch` block in the product actually rely on, and
 * a helper that threw a bare `Error` would be invisible to all of them.
 *
 * Two habits in here are deliberate. Expected *messages* are asserted whole,
 * not matched loosely, because the rendering bounds are a privacy constraint
 * (an error message is logged, persisted with a session and shown in a user
 * interface) and a substring match would not notice a bound being lifted. And
 * the implementation's module-private constants are restated locally instead of
 * exported for the test, so a change to one of them shows up here as a failing
 * expectation rather than as a test that silently re-derives the new behaviour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assert, assertDefined, assertNever, fail } from './assert.js';
import { DEBUGGEN_ERROR_CODES, DebuggenError, type DebuggenErrorCode } from './errors.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/** Sentinel distinguishing "threw `undefined`" from "did not throw at all". */
const NOTHING_THROWN = Symbol('nothing thrown');

/**
 * How much of a rendered primitive `assertNever` lets into a message.
 *
 * Restated rather than imported: `assert.ts` keeps the constant module-private,
 * and the bound is a privacy constraint on what may reach a log, a stored
 * session and a user interface. Stating it independently means raising it shows
 * up as a failing expectation here instead of as a longer preview nobody
 * reviewed.
 */
const MAX_VALUE_PREVIEW_LENGTH = 120;

/** How many own key *names* of an unexpected object reach a message. */
const MAX_DESCRIBED_KEYS = 8;

/** The message `assertNever` uses when the caller supplies none. */
const DEFAULT_UNHANDLED_MESSAGE = 'Unhandled value';

/**
 * The message most cases assert on: one complete sentence, the form the
 * documentation of every helper in `assert.ts` asks callers for.
 */
const MESSAGE = 'The capture must own the span it is about to attribute.';

/**
 * Run `operation`, require it to throw, and hand back the thrown value narrowed
 * to a `DebuggenError`.
 *
 * Membership is tested with `DebuggenError.is` and never with `instanceof`,
 * which is the supported test in this repository: the local service, the
 * VS Code extension host, the DevTools panel and the page agent each bundle
 * their own copy of the class, so constructor identity answers `false` for an
 * error that is structurally exactly one. Asserting the brand here is asserting
 * what every `catch` block in the product relies on.
 *
 * @param operation The call expected to fail.
 * @returns The thrown `DebuggenError`, typed, so callers assert on `code`,
 * `message` and `hint` without a cast.
 */
function expectDebuggenError(operation: () => unknown): DebuggenError {
  let thrown: unknown = NOTHING_THROWN;

  try {
    operation();
  } catch (caught: unknown) {
    thrown = caught;
  }

  expect(thrown, 'the operation was expected to throw').not.toBe(NOTHING_THROWN);
  expect(DebuggenError.is(thrown), 'the thrown value must be a DebuggenError').toBe(true);

  if (!DebuggenError.is(thrown)) {
    // Unreachable: the expectation above has already failed the test. Present
    // so this function's return type is `DebuggenError` rather than `unknown`.
    throw new Error('Expected a DebuggenError to have been thrown.');
  }

  return thrown;
}

/**
 * Hands `value` back at its declared type, defeating the narrowing a literal
 * initializer would hand out for free.
 *
 * This exists for the narrowing cases only, and it is what makes them real
 * tests. `const value: string | number = 'checkout'` is narrowed to `string` by
 * control-flow analysis at the declaration itself, so a following
 * `value.toUpperCase()` would compile whether or not `assert` narrows anything.
 * Routing the value through a function whose return type *is* the union
 * restores the wide type, leaving the assertion as the only thing that can
 * narrow it.
 *
 * @typeParam T The type to hand the value back at, stated explicitly at each
 * call site.
 * @param value The value to widen.
 * @returns `value`, typed `T`.
 */
function widen<T>(value: T): T {
  return value;
}

/**
 * Hands a real value to a parameter declared `never`.
 *
 * `assertNever`'s `never` parameter is the compile-time half of the
 * exhaustiveness guard: a call only compiles where the compiler has already
 * proved every declared member handled, which is precisely why a test cannot
 * reach the function without a cast. The cast is legitimate exactly here —
 * these cases are the *runtime* half of the same guard, the branch a `switch`
 * with a missing `case` reaches when a variant this build has never heard of
 * arrives from a newer peer, and that branch has to end in a coded failure
 * rather than in a `TypeError` from the message builder.
 *
 * Keeping the cast inside one typed helper is also why no `eslint-disable`
 * comment appears in this file: every case calls a function with an honest
 * signature instead of writing `as never` inline.
 *
 * @param value The value the type system said could not exist.
 * @returns `value`, typed `never`.
 */
function unhandled(value: unknown): never {
  return value as never;
}

/** A labelled fixture value, so `it.each` titles name the case they run. */
interface LabelledValue {
  readonly label: string;
  readonly value: unknown;
}

/**
 * Conditions `assert` must accept. Truthiness is the whole test, so the set
 * ranges over every kind that is truthy rather than over booleans alone.
 */
const TRUTHY_CONDITIONS: readonly LabelledValue[] = [
  { label: 'true', value: true },
  { label: 'a positive number', value: 1 },
  { label: 'a negative number', value: -1 },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: 'a non-empty string', value: 'ready' },
  { label: 'the string "0"', value: '0' },
  { label: 'the string "false"', value: 'false' },
  { label: 'a non-zero bigint', value: 1n },
  { label: 'an empty object', value: {} },
  { label: 'an empty array', value: [] },
  { label: 'a symbol', value: Symbol('present') },
  { label: 'a function', value: (): void => undefined },
];

/**
 * Conditions `assert` must reject. Four of these — `0`, `-0`, `''` and `NaN` —
 * are the values `assertDefined` accepts, which is the seam between the two
 * helpers and the reason both tables exist.
 */
const FALSY_CONDITIONS: readonly LabelledValue[] = [
  { label: 'false', value: false },
  { label: 'zero', value: 0 },
  { label: 'negative zero', value: -0 },
  { label: 'the empty string', value: '' },
  { label: 'NaN', value: Number.NaN },
  { label: 'the zero bigint', value: 0n },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
];

/**
 * Values that are falsy but present, which `assertDefined` must accept.
 *
 * Every entry is a value the product genuinely carries: a zero duration on a
 * span that started and ended in the same millisecond, an empty SQL parameter
 * list, a `false` flag on an agent hook configuration, a `NaN` from an
 * unavailable performance entry, an empty attribute bag on an event.
 */
const DEFINED_BUT_FALSY: readonly LabelledValue[] = [
  { label: 'zero', value: 0 },
  { label: 'negative zero', value: -0 },
  { label: 'the empty string', value: '' },
  { label: 'false', value: false },
  { label: 'NaN', value: Number.NaN },
  { label: 'the zero bigint', value: 0n },
  { label: 'an empty array', value: [] },
  { label: 'an empty object', value: {} },
];

/** The two values `assertDefined` exists to reject, and nothing else. */
const NULLISH_VALUES: readonly LabelledValue[] = [
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
];

/**
 * Specific codes, checked so that the `code` parameter is genuinely forwarded
 * rather than defaulted.
 *
 * One per concern the product has to distinguish at a boundary: the conflict
 * that must never overwrite a developer's edit, the state machine's refusal, a
 * frame that did not parse, and a path deliberately left unbuilt. `INTERNAL`
 * is absent on purpose — it is the default, so it cannot prove forwarding.
 */
const SPECIFIC_CODES: readonly DebuggenErrorCode[] = [
  'MODIFICATION_CONFLICT',
  'SESSION_INVALID_STATE',
  'PROTOCOL_INVALID_MESSAGE',
  'NOT_IMPLEMENTED',
];

/** Undoes any environment stub a case installed, so none of them can leak. */
afterEach(() => {
  vi.unstubAllEnvs();
});

/*
 * ---------------------------------------------------------------------------
 * assert — the general form, and the one that narrows a condition
 * ---------------------------------------------------------------------------
 */

describe('assert', () => {
  it('returns undefined and does not throw for a truthy condition', () => {
    expect(assert(true, MESSAGE)).toBeUndefined();
  });

  it.each(TRUTHY_CONDITIONS)('passes silently for $label', (entry: LabelledValue) => {
    expect(() => {
      assert(entry.value, MESSAGE);
    }).not.toThrow();
  });

  it.each(FALSY_CONDITIONS)('throws a DebuggenError for $label', (entry: LabelledValue) => {
    const thrown = expectDebuggenError(() => {
      assert(entry.value, MESSAGE);
    });

    expect(thrown.message).toBe(MESSAGE);
  });

  it('defaults to the INTERNAL code when none is passed', () => {
    const thrown = expectDebuggenError(() => {
      assert(false, MESSAGE);
    });

    expect(thrown.code).toBe('INTERNAL');
  });

  it.each(SPECIFIC_CODES)('reports the %s code when it is passed', (code: DebuggenErrorCode) => {
    const thrown = expectDebuggenError(() => {
      assert(false, MESSAGE, code);
    });

    expect(thrown.code).toBe(code);
    expect(thrown.message).toBe(MESSAGE);
  });

  it('carries the message verbatim, without decorating it', () => {
    const awkward = 'Cleanup found 2 records: "a.ts" and `b.ts` (100% of the plan).';
    const thrown = expectDebuggenError(() => {
      assert(false, awkward, 'CLEANUP_PARTIAL');
    });

    // The whole message, not a match: a helper that appended the code, the
    // value or a stack summary would still satisfy `toContain`.
    expect(thrown.message).toBe(awkward);
    expect(thrown.toPayload()).toEqual({ code: 'CLEANUP_PARTIAL', message: awkward });
  });

  it('attaches no hint, details or cause of its own', () => {
    const thrown = expectDebuggenError(() => {
      assert(false, MESSAGE);
    });

    // Key *presence*, not `=== undefined`: these travel as own properties, and
    // a present-but-undefined `hint` becomes `"hint": null` after a JSON round
    // trip, which the protocol's error payload schema rejects.
    expect('hint' in thrown).toBe(false);
    expect('details' in thrown).toBe(false);
    expect('cause' in thrown).toBe(false);
  });

  it('evaluates the condition eagerly, so a falsy result is not deferred', () => {
    let evaluations = 0;
    const condition = (): boolean => {
      evaluations += 1;
      return false;
    };

    expectDebuggenError(() => {
      assert(condition(), MESSAGE);
    });

    expect(evaluations).toBe(1);
  });

  it('narrows a union through a type predicate, with no cast on the far side', () => {
    // `widen` keeps the declared type wide (see its documentation), so the
    // `toUpperCase()` call below compiles only because `assert` is declared
    // `asserts condition`. This case is checked by `pnpm typecheck` as much as
    // by the runner: a signature regressed to `void` fails the build here.
    const value = widen<string | number>('checkout');

    assert(typeof value === 'string', 'The captured target must be a string.');

    expect(value.toUpperCase()).toBe('CHECKOUT');
    expect(value.length).toBe(8);
  });

  it('narrows an indexed access, which is what noUncheckedIndexedAccess needs', () => {
    // Every array read in this repository is `T | undefined`, so this is the
    // shape the product's own call sites take: index, assert, use.
    const spanIds: readonly string[] = ['0123456789abcdef'];
    const first = spanIds[0];

    assert(first !== undefined, 'The trace must carry at least one span.');

    // Read as a `string`, not handed to a matcher that tolerates `undefined`:
    // the point of the case is that the narrowing happened.
    expect(first.length).toBe(16);
    expect(first.slice(0, 2)).toBe('01');
  });

  it('narrows a discriminated union to the member a switch would have matched', () => {
    type Outcome =
      | { readonly status: 'generated'; readonly panelId: string }
      | { readonly status: 'failed'; readonly stage: string };

    const outcome = widen<Outcome>({ status: 'generated', panelId: 'panel-1' });

    assert(outcome.status === 'generated', 'The session must have produced a panel.');

    expect(outcome.panelId).toBe('panel-1');
  });

  it('still throws when NODE_ENV says production, because nothing strips it', () => {
    // `assert.ts` reads no environment variable and no build in this
    // repository eliminates the call — which is what makes these checks
    // trustworthy for a real invariant. A guard added later fails here.
    vi.stubEnv('NODE_ENV', 'production');

    const thrown = expectDebuggenError(() => {
      assert(false, MESSAGE, 'SESSION_INVALID_STATE');
    });

    expect(thrown.code).toBe('SESSION_INVALID_STATE');
  });
});

/*
 * ---------------------------------------------------------------------------
 * assertDefined — presence, which is a different question from truthiness
 * ---------------------------------------------------------------------------
 */

describe('assertDefined', () => {
  it('returns undefined and does not throw for a present value', () => {
    expect(assertDefined('present', MESSAGE)).toBeUndefined();
  });

  it.each(DEFINED_BUT_FALSY)(
    'accepts $label, which is falsy but present',
    (entry: LabelledValue) => {
      // The behavioural difference from `assert`, and the reason both helpers
      // exist: every value in this table would fail a truthiness check and is a
      // legitimate value in this product.
      expect(() => {
        assertDefined(entry.value, MESSAGE);
      }).not.toThrow();
    },
  );

  it.each(FALSY_CONDITIONS.filter((entry) => entry.value !== null && entry.value !== undefined))(
    'accepts $label, which `assert` rejects',
    (entry: LabelledValue) => {
      // Read against the `assert` table directly, so the two contracts cannot
      // drift apart: everything `assert` rejects except the two nullish
      // entries must pass here.
      expect(() => {
        assertDefined(entry.value, MESSAGE);
      }).not.toThrow();
    },
  );

  it.each(NULLISH_VALUES)('throws a DebuggenError for $label', (entry: LabelledValue) => {
    const thrown = expectDebuggenError(() => {
      assertDefined(entry.value, MESSAGE);
    });

    expect(thrown.message).toBe(MESSAGE);
  });

  it('defaults to the INTERNAL code when none is passed', () => {
    const thrown = expectDebuggenError(() => {
      assertDefined(null, MESSAGE);
    });

    expect(thrown.code).toBe('INTERNAL');
  });

  it.each(SPECIFIC_CODES)('reports the %s code when it is passed', (code: DebuggenErrorCode) => {
    const thrown = expectDebuggenError(() => {
      assertDefined(undefined, MESSAGE, code);
    });

    expect(thrown.code).toBe(code);
    expect(thrown.message).toBe(MESSAGE);
  });

  it('attaches no hint, details or cause of its own', () => {
    const thrown = expectDebuggenError(() => {
      assertDefined(undefined, MESSAGE);
    });

    expect('hint' in thrown).toBe(false);
    expect('details' in thrown).toBe(false);
    expect('cause' in thrown).toBe(false);
  });

  it('narrows an optional value to its non-optional type, with no cast', () => {
    // Compile-time assertion as much as a runtime one: `startsWith` resolves
    // only because `assertDefined` is declared `asserts value is
    // NonNullable<T>`.
    const candidate = widen<string | undefined>('session-3f9c');

    assertDefined(candidate, 'A session id must be present at this point.');

    expect(candidate.startsWith('session-')).toBe(true);
  });

  it('narrows a nullable property, removing null as well as undefined', () => {
    // The product's own shape: an applied modification record must have a
    // backup path, and cleanup reads it on the next line.
    const record = widen<{ readonly backupPath: string | null | undefined }>({
      backupPath: '/backups/0f1e2d/route.ts',
    });

    assertDefined(record.backupPath, 'An applied record must have a backup.');

    expect(record.backupPath.endsWith('route.ts')).toBe(true);
  });

  it('narrows a falsy-but-present value without rejecting it', () => {
    // Both halves of this helper's contract in one case: `0` survives the
    // check *and* comes out typed `number`, so the arithmetic compiles.
    const duration = widen<number | undefined>(0);

    assertDefined(duration, 'A settled span must carry a duration.');

    expect(duration.toFixed(1)).toBe('0.0');
    expect(duration + 1).toBe(1);
  });

  it('still throws when NODE_ENV says production, because nothing strips it', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const thrown = expectDebuggenError(() => {
      assertDefined(null, MESSAGE, 'TAB_NOT_BOUND');
    });

    expect(thrown.code).toBe('TAB_NOT_BOUND');
  });
});

/*
 * ---------------------------------------------------------------------------
 * assertNever — the exhaustiveness guard, and its message builder
 *
 * The rendering is asserted exactly rather than loosely on purpose: the two
 * bounds it applies (a 120-character preview, eight key names) are the privacy
 * constraint on a string that reaches a log, a stored session and a user
 * interface, and a substring match would not notice either bound being lifted.
 * ---------------------------------------------------------------------------
 */

/** A named function declaration, for the `function <name>` rendering path. */
function namedHandler(): void {
  // Intentionally empty: only this function's *name* is under test.
}

/** A class instance, for the constructor-name rendering path. */
class TelemetryEnvelope {
  readonly kind = 'log';
  readonly spanId = '0123456789abcdef';
}

/** An unexpected value and the description `assertNever` must render for it. */
interface UnexpectedCase {
  readonly label: string;
  readonly value: unknown;
  readonly rendered: string;
}

/**
 * One case per branch of the implementation's renderer, each with the exact
 * text it must produce.
 *
 * The object entries also pin two properties that are easy to lose: key names
 * are sorted (in code-unit order, so a continuous-integration runner and a
 * developer's laptop agree) and no key's *value* appears anywhere.
 */
const UNEXPECTED_VALUES: readonly UnexpectedCase[] = [
  { label: 'a string', value: 'route.handler', rendered: 'string route.handler' },
  { label: 'a number', value: 42, rendered: 'number 42' },
  { label: 'a bigint', value: 9007199254740993n, rendered: 'bigint 9007199254740993' },
  { label: 'a boolean', value: true, rendered: 'boolean true' },
  { label: 'null', value: null, rendered: 'null' },
  { label: 'undefined', value: undefined, rendered: 'undefined' },
  {
    label: 'a symbol with a description',
    value: Symbol('render.unexpected'),
    rendered: 'symbol render.unexpected',
  },
  { label: 'a symbol without a description', value: Symbol(), rendered: 'symbol' },
  {
    label: 'a plain object, with its keys sorted',
    value: { zeta: 1, alpha: 2 },
    rendered: 'object Object { alpha, zeta }',
  },
  { label: 'an empty object', value: {}, rendered: 'object Object' },
  { label: 'an array', value: ['a', 'b'], rendered: 'object Array { 0, 1 }' },
  { label: 'a Map', value: new Map<string, string>(), rendered: 'object Map' },
  {
    label: 'a class instance',
    value: new TelemetryEnvelope(),
    rendered: 'object TelemetryEnvelope { kind, spanId }',
  },
  {
    label: 'a null-prototype object',
    value: Object.assign(Object.create(null) as object, { tier: 'server' }),
    rendered: 'object { tier }',
  },
  { label: 'a named function', value: namedHandler, rendered: 'function namedHandler' },
];

describe('assertNever', () => {
  it.each(UNEXPECTED_VALUES)(
    'throws an INTERNAL DebuggenError describing $label',
    (entry: UnexpectedCase) => {
      const thrown = expectDebuggenError(() => assertNever(unhandled(entry.value)));

      expect(thrown.message).toBe(`${DEFAULT_UNHANDLED_MESSAGE}: ${entry.rendered}`);
      expect(thrown.code).toBe('INTERNAL');
      expect(thrown.name).toBe('DebuggenError');
    },
  );

  it('prefixes the description with the supplied message', () => {
    const thrown = expectDebuggenError(() =>
      assertNever(unhandled('route.handler'), 'Unhandled telemetry kind'),
    );

    expect(thrown.message).toBe('Unhandled telemetry kind: string route.handler');
  });

  it('never reports a code other than INTERNAL, because this is a stale build', () => {
    // Deliberately no `code` parameter on this helper: an unhandled union
    // member is not one of the product's expected failures, it is the code
    // being out of date with its own types.
    const thrown = expectDebuggenError(() =>
      assertNever(unhandled({ status: 'unknown' }), 'Unhandled session status'),
    );

    expect(thrown.code).toBe('INTERNAL');
    expect('hint' in thrown).toBe(false);
    expect('details' in thrown).toBe(false);
  });

  it('describes a symbol without interpolating it, which would be a TypeError', () => {
    // The regression this case exists for: `${symbol}` throws
    // `TypeError: Cannot convert a Symbol value to a string`, which would
    // replace this assertion's coded failure with an unrelated error raised
    // inside the error reporter.
    const rogue = Symbol('kind.render.unexpected');

    const thrown = expectDebuggenError(() => assertNever(unhandled(rogue), 'Unhandled kind'));

    expect(thrown.message).toBe('Unhandled kind: symbol kind.render.unexpected');
    expect(thrown.name).toBe('DebuggenError');
    expect(thrown instanceof TypeError).toBe(false);
  });

  it('describes an object without calling its toString', () => {
    // `String(value)` on an object runs whatever `toString` the value brought
    // with it. This one throws, so a renderer that called it would surface the
    // wrong error entirely.
    const hostile = {
      kind: 'commit',
      toString(): string {
        throw new Error('toString must never be called while describing a value.');
      },
    };

    const thrown = expectDebuggenError(() => assertNever(unhandled(hostile), 'Unhandled message'));

    expect(thrown.message).toBe('Unhandled message: object Object { kind, toString }');
    expect(thrown.code).toBe('INTERNAL');
  });

  it('reads key names without reading their values, so nothing leaks', () => {
    // A redactable value behind an accessor. `Object.keys` does not invoke a
    // getter, so the key name reaches the message and the value never does —
    // which is the property that lets an error message be logged and stored.
    const secret = 'REDACTED_TOKEN_PLACEHOLDER_VALUE';
    const envelope = {
      get token(): string {
        return secret;
      },
    };

    const thrown = expectDebuggenError(() => assertNever(unhandled(envelope)));

    expect(thrown.message).toBe(`${DEFAULT_UNHANDLED_MESSAGE}: object Object { token }`);
    expect(thrown.message).not.toContain(secret);
  });

  it('degrades to the bare kind when describing the value throws', () => {
    // A proxy throws from its own traps, so even `Object.keys` is not safe on
    // an arbitrary value. The renderer must lose the detail, not the failure.
    const hostile = new Proxy(
      {},
      {
        ownKeys(): string[] {
          throw new Error('ownKeys refuses to answer.');
        },
      },
    );

    const thrown = expectDebuggenError(() => assertNever(unhandled(hostile), 'Unhandled node'));

    expect(thrown.message).toBe('Unhandled node: object');
    expect(thrown.code).toBe('INTERNAL');
  });

  it('describes a cyclic object, which JSON.stringify could not', () => {
    const cyclic: { self?: unknown; tier?: string } = { tier: 'browser' };
    cyclic.self = cyclic;

    // Proof the two are different code paths, not an assumption about them.
    expect(() => JSON.stringify(cyclic)).toThrow(TypeError);

    const thrown = expectDebuggenError(() => assertNever(unhandled(cyclic)));

    expect(thrown.message).toBe(`${DEFAULT_UNHANDLED_MESSAGE}: object Object { self, tier }`);
  });

  it('describes an anonymous function as its kind alone', () => {
    const makeAnonymous = (): unknown =>
      function (): void {
        // Intentionally empty: this function exists to have no name.
      };

    const thrown = expectDebuggenError(() => assertNever(unhandled(makeAnonymous())));

    expect(thrown.message).toBe(`${DEFAULT_UNHANDLED_MESSAGE}: function`);
  });

  it('truncates a long primitive to the preview bound, with an ellipsis', () => {
    const statement = 'x'.repeat(MAX_VALUE_PREVIEW_LENGTH + 40);

    const thrown = expectDebuggenError(() => assertNever(unhandled(statement)));

    expect(thrown.message).toBe(
      `${DEFAULT_UNHANDLED_MESSAGE}: string ${'x'.repeat(MAX_VALUE_PREVIEW_LENGTH)}…`,
    );
    expect(thrown.message).not.toContain(statement);
  });

  it('leaves a primitive at the bound untouched', () => {
    const statement = 'y'.repeat(MAX_VALUE_PREVIEW_LENGTH);

    const thrown = expectDebuggenError(() => assertNever(unhandled(statement)));

    expect(thrown.message).toBe(`${DEFAULT_UNHANDLED_MESSAGE}: string ${statement}`);
    expect(thrown.message.endsWith('…')).toBe(false);
  });

  it('bounds the number of key names, with an explicit ellipsis', () => {
    const keys = Array.from(
      { length: MAX_DESCRIBED_KEYS + 4 },
      (_unused, index) => `k${String(index).padStart(2, '0')}`,
    );
    const wide = Object.fromEntries(keys.map((key) => [key, true] as const));

    const thrown = expectDebuggenError(() => assertNever(unhandled(wide)));

    const shown = keys.slice(0, MAX_DESCRIBED_KEYS).join(', ');
    expect(thrown.message).toBe(`${DEFAULT_UNHANDLED_MESSAGE}: object Object { ${shown}, … }`);
    expect(thrown.message).not.toContain('k08');
  });

  it('is reachable only from a switch the compiler has proved exhaustive', () => {
    type Tier = 'browser' | 'server' | 'db';

    // The compile-time half of the guard: adding a member to `Tier` without a
    // matching `case` stops this function from compiling, which is the point
    // of the `never` parameter. The runtime half is the two calls below.
    const describeTier = (tier: Tier): string => {
      switch (tier) {
        case 'browser':
          return 'Browser';
        case 'server':
          return 'Server';
        case 'db':
          return 'Database';
        default:
          return assertNever(tier, 'Unhandled telemetry tier');
      }
    };

    expect(describeTier('browser')).toBe('Browser');
    expect(describeTier('db')).toBe('Database');

    const thrown = expectDebuggenError(() => describeTier(unhandled('edge')));

    expect(thrown.message).toBe('Unhandled telemetry tier: string edge');
  });
});

/*
 * ---------------------------------------------------------------------------
 * fail — the unconditional form
 * ---------------------------------------------------------------------------
 */

describe('fail', () => {
  it('always throws, carrying the supplied message', () => {
    const thrown = expectDebuggenError(() => fail(MESSAGE));

    expect(thrown.message).toBe(MESSAGE);
    expect(thrown.name).toBe('DebuggenError');
  });

  it('defaults to the INTERNAL code when none is passed', () => {
    const thrown = expectDebuggenError(() => fail(MESSAGE));

    expect(thrown.code).toBe('INTERNAL');
  });

  it('honours NOT_IMPLEMENTED, the code for a path deliberately left unbuilt', () => {
    const thrown = expectDebuggenError(() =>
      fail('No encoder for this node type.', 'NOT_IMPLEMENTED'),
    );

    expect(thrown.code).toBe('NOT_IMPLEMENTED');
    expect(thrown.message).toBe('No encoder for this node type.');
  });

  it.each(SPECIFIC_CODES)('reports the %s code when it is passed', (code: DebuggenErrorCode) => {
    const thrown = expectDebuggenError(() => fail(MESSAGE, code));

    expect(thrown.code).toBe(code);
  });

  it('attaches no hint, details or cause of its own', () => {
    const thrown = expectDebuggenError(() => fail(MESSAGE, 'PATCH_UNSUPPORTED'));

    expect('hint' in thrown).toBe(false);
    expect('details' in thrown).toBe(false);
    expect('cause' in thrown).toBe(false);
    expect(thrown.toPayload()).toEqual({ code: 'PATCH_UNSUPPORTED', message: MESSAGE });
  });

  it('satisfies a branch that owes a value, because it returns never', () => {
    // The compile-time half: `encode` is declared to return `string`, and the
    // `return fail(...)` below type-checks only because `fail`'s return type is
    // `never`. A regression to `void` fails the typecheck gate here.
    const encode = (
      node: { readonly type: 'timeline' } | { readonly type: 'sourceLink' },
    ): string => {
      if (node.type === 'timeline') {
        return 'timeline';
      }
      return fail(`No encoder for ${node.type}.`, 'NOT_IMPLEMENTED');
    };

    expect(encode({ type: 'timeline' })).toBe('timeline');

    const thrown = expectDebuggenError(() => encode({ type: 'sourceLink' }));

    expect(thrown.message).toBe('No encoder for sourceLink.');
    expect(thrown.code).toBe('NOT_IMPLEMENTED');
  });

  it('still throws when NODE_ENV says production, because nothing strips it', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const thrown = expectDebuggenError(() => fail(MESSAGE, 'STORE_ERROR'));

    expect(thrown.code).toBe('STORE_ERROR');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The guarantee every helper shares
 *
 * Asserted once per helper rather than once per case: the protocol layer, both
 * user interfaces and every `catch` block in the product recognise a failure
 * through `DebuggenError.is` and act on its code, so a helper that threw a bare
 * `Error` — or one carrying a code outside the closed set — would be invisible
 * to all of them.
 * ---------------------------------------------------------------------------
 */

/** A helper under test, paired with a call that must fail. */
interface ThrowingHelper {
  readonly label: string;
  readonly throwIt: () => unknown;
}

const THROWING_HELPERS: readonly ThrowingHelper[] = [
  { label: 'assert', throwIt: (): void => assert(false, MESSAGE, 'SESSION_INVALID_STATE') },
  { label: 'assertDefined', throwIt: (): void => assertDefined(undefined, MESSAGE) },
  {
    label: 'assertNever',
    throwIt: (): never => assertNever(unhandled('unexpected'), 'Unhandled value'),
  },
  { label: 'fail', throwIt: (): never => fail(MESSAGE, 'NOT_IMPLEMENTED') },
];

describe('every helper', () => {
  it.each(THROWING_HELPERS)(
    '$label throws a value that satisfies DebuggenError.is',
    (helper: ThrowingHelper) => {
      const thrown = expectDebuggenError(helper.throwIt);

      // `is` reads an own, JSON-safe brand rather than a prototype, which is
      // what makes an error recognisable after it has crossed a bundle or a
      // serialisation boundary.
      expect(DebuggenError.is(thrown)).toBe(true);
      expect(thrown.name).toBe('DebuggenError');
      expect(thrown).toBeInstanceOf(Error);
    },
  );

  it.each(THROWING_HELPERS)(
    '$label throws a code from the closed DEBUGGEN_ERROR_CODES set',
    (helper: ThrowingHelper) => {
      const thrown = expectDebuggenError(helper.throwIt);

      expect(DEBUGGEN_ERROR_CODES).toContain(thrown.code);
    },
  );

  it.each(THROWING_HELPERS)(
    '$label throws a non-empty message and a usable stack',
    (helper: ThrowingHelper) => {
      const thrown = expectDebuggenError(helper.throwIt);

      expect(thrown.message.length).toBeGreaterThan(0);
      // The stack is what points at the line that noticed, which is the whole
      // argument for throwing here instead of threading a null onwards.
      expect(typeof thrown.stack).toBe('string');
    },
  );

  it.each(THROWING_HELPERS)(
    '$label throws a payload the protocol can carry',
    (helper: ThrowingHelper) => {
      const thrown = expectDebuggenError(helper.throwIt);
      const payload = thrown.toPayload();

      expect(Object.keys(payload).sort()).toEqual(['code', 'message']);
      expect(payload.code).toBe(thrown.code);
      expect(payload.message).toBe(thrown.message);
      // Serialisable as it stands: the payload is what crosses the WebSocket,
      // and a `hint` key holding `undefined` would arrive as `null` and fail
      // the protocol's schema at the receiving end.
      expect(JSON.stringify(payload)).toBe(
        JSON.stringify({ code: thrown.code, message: thrown.message }),
      );
    },
  );
});
