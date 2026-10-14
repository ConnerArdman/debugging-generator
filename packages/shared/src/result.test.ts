/**
 * Tests for `./result.ts`: the failure vocabulary every workspace in this
 * monorepo returns instead of throwing.
 *
 * `@debuggen/shared` is the bottom of the acyclic package graph, so these
 * twelve functions fail much further away than they are called. Four claims
 * are on trial here, each of them load-bearing for a product that writes into
 * a developer's working tree and then has to say what happened.
 *
 * 1. **The discriminant decides, never the value.** A `Result<void>` succeeds
 *    with `undefined`, and a successful lookup may legitimately produce `0`,
 *    `''` or `null`. An implementation that asked whether the value was truthy
 *    would report those as failures — which, in this product, is a working
 *    signal presented as a broken one. The suites below assert success for
 *    every falsy value there is.
 * 2. **Identity survives.** `map` and `andThen` hand a failure onward as the
 *    very same object, and `mapErr` does the same for a success; `unwrap` and
 *    `tryCatch` return an error that already is a `DebuggenError` unchanged.
 *    That is what preserves the specific `DebuggenErrorCode` a deeper layer
 *    chose — the only thing either user interface has to pick a recovery path
 *    from — through every re-wrapping on the way to the boundary. So the
 *    assertions here are `toBe`, not `toEqual`: a combinator that rebuilt an
 *    equal-looking error would pass the latter and still lose the code.
 * 3. **The short-circuit is a contract.** `andThen` must not invoke its
 *    callback for a failure and `collect` must stop pulling its iterable at
 *    the first failure, because the installer in `@debuggen/instrumentation`
 *    aborts on the first infeasible action: continuing would leave
 *    instrumentation in the developer's files for a capture that could never
 *    produce the signal it was for. Both are asserted with counters — a call
 *    counter for the callback, a pull counter inside a generator for the lazy
 *    source — rather than inferred from the returned value, because a
 *    combinator that ran the work and discarded the answer returns exactly the
 *    same thing.
 * 4. **The async helper never rejects.** `fromPromise` is used where an
 *    unhandled rejection would take down a whole session rather than fail one
 *    step of it, so every one of its outcomes must arrive as a *fulfilled*
 *    `Result`. Those tests therefore `await` it directly, with no `try`/`catch`
 *    and no `.catch`: a rejection escapes into the test and fails it.
 *
 * Two habits in here are deliberate. Counters are plain closure variables
 * rather than `vi.fn`, because the questions being asked are "exactly once"
 * and "never", and a number read off a closure states that without a mock's
 * lifecycle. And the narrowing assertions are written out inline — an
 * annotated `const` inside each branch of a real `if` — rather than hidden in
 * a helper, so that a guard which stopped narrowing fails `pnpm typecheck`
 * inside this file instead of somewhere downstream.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError, type DebuggenErrorCode } from './errors.js';
import {
  andThen,
  collect,
  err,
  type Err,
  fromPromise,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  type Ok,
  type Result,
  tryCatch,
  unwrap,
  unwrapOr,
} from './result.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/**
 * A code used wherever a test needs one that is not the `INTERNAL` default, so
 * an assertion about a default can never pass by coincidence.
 */
const SPECIFIC_CODE: DebuggenErrorCode = 'STORE_ERROR';

/**
 * The code a low-level helper reports with, standing in for the containment
 * failure `paths.ts` raises: it knows what went wrong but not which stage
 * asked.
 */
const GENERIC_CODE: DebuggenErrorCode = 'PATH_OUTSIDE_PROJECT';

/**
 * The stage-specific code that same failure is re-coded into by the caller
 * that does know — the mechanism {@link mapErr} exists for.
 */
const RECODED_CODE: DebuggenErrorCode = 'PATCH_TARGET_NOT_FOUND';

/** A fresh failure, fresh per call so identity assertions stay honest. */
function storeFailure(): DebuggenError {
  return new DebuggenError(SPECIFIC_CODE, 'The session store failed.', {
    hint: 'Check the session store.',
  });
}

/**
 * Produces a success whose *declared* type is the full union.
 *
 * Handing the value through a producer is not ceremony: `const result:
 * Result<number> = ok(7)` is narrowed to `Ok<number>` by control-flow analysis
 * at its own declaration, which makes the `else` branch of a guard `never` and
 * leaves the narrowing assertions testing the initializer rather than the
 * guard. A function whose return type is the union is also how every real
 * `Result` arrives at a call site.
 *
 * @typeParam T The value type.
 * @typeParam E The error type. Defaults to `DebuggenError`, as `Result` does.
 * @param value The value to succeed with.
 * @returns `ok(value)`, typed as the union.
 */
function succeeding<T, E = DebuggenError>(value: T): Result<T, E> {
  return ok(value);
}

/**
 * Produces a failure whose *declared* type is the full union, for the same
 * reason as {@link succeeding}.
 *
 * @typeParam T The value type the caller would have received.
 * @typeParam E The error type. Defaults to `DebuggenError`, as `Result` does.
 * @param error The error to fail with.
 * @returns `err(error)`, typed as the union.
 */
function failing<T, E = DebuggenError>(error: E): Result<T, E> {
  return err(error);
}

/**
 * Runs `call` and returns whatever it threw.
 *
 * Returning the thrown value rather than asserting on it here is what lets the
 * `unwrap` suite ask its real questions — does this satisfy
 * `DebuggenError.is`, is it the same object the `Err` carried, what is its
 * code — instead of the weaker "it threw something". A call that returns
 * instead of throwing ends the test where it happened.
 *
 * @param call The call under test, invoked once.
 * @returns The value `call` threw.
 */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (caught) {
    return caught;
  }
  return expect.unreachable('The call was expected to throw, and returned instead.');
}

/**
 * A function that throws `thrown`, typed as though it would have returned
 * normally.
 *
 * `() => never` is assignable to `() => T`, so a test can say "a call that
 * would have produced a number" and still have it fail — which is the shape
 * {@link tryCatch} is actually used in.
 *
 * @param thrown The value to throw. Any value may be thrown in JavaScript,
 * which is the whole reason `tryCatch` normalises what it catches.
 * @returns A function that throws `thrown` when called.
 */
function throwing(thrown: unknown): () => never {
  return () => {
    throw thrown;
  };
}

/**
 * A thenable that is **not** a `Promise`, for the `PromiseLike` half of
 * {@link fromPromise}'s signature.
 *
 * Built as a plain object whose `then` delegates to a real promise: the
 * delegation keeps the signature exact without reimplementing promise
 * semantics, while the object itself has no `Promise` prototype — so an
 * implementation that checked `instanceof Promise`, or that called anything
 * beyond `then`, would fail here. `onThen` records that the thenable was
 * consumed exactly once.
 *
 * @typeParam T The resolution type.
 * @param settled The promise the thenable delegates to.
 * @param onThen Invoked each time `then` is called.
 * @returns A `PromiseLike<T>` that is not a `Promise`.
 */
function thenableOf<T>(settled: Promise<T>, onThen: () => void): PromiseLike<T> {
  return {
    then(onFulfilled, onRejected) {
      onThen();
      return settled.then(onFulfilled, onRejected);
    },
  };
}

/**
 * A promise that rejects with an arbitrary value rather than an `Error`.
 *
 * Written with `throw` inside an `async` function rather than
 * `Promise.reject(value)`, because this repository lints the latter for a
 * non-`Error` reason — correctly, for product code. A rejection that arrives
 * from *outside* is under no such discipline: a library that throws a string,
 * a worker whose failure was revived from JSON, a `null` from a sloppy
 * callback. That is the input {@link fromPromise} has to fulfil for, and this
 * helper reproduces it.
 *
 * @typeParam T The resolution type the caller would have received.
 * @param reason The value the promise rejects with.
 * @returns A promise that rejects asynchronously with `reason`.
 */
async function rejectingWith<T>(reason: unknown): Promise<T> {
  await Promise.resolve();
  throw reason;
}

/**
 * Wraps results in a lazy generator that counts how many of them were pulled.
 *
 * {@link collect} takes an `Iterable`, and the promise that it stops pulling at
 * the first failure is only observable from the source's side: the returned
 * `Err` looks identical whether the rest of the work was done or not. The
 * counter is that observation.
 *
 * @typeParam T The value type of each result.
 * @typeParam E The error type shared by the results.
 * @param items The results to yield, in order.
 * @returns The single-use iterable and a reader for the pull count.
 */
function countingSource<T, E>(
  items: readonly Result<T, E>[],
): { source: Iterable<Result<T, E>>; pulled: () => number } {
  let pulled = 0;

  function* generate(): Generator<Result<T, E>> {
    for (const item of items) {
      pulled += 1;
      yield item;
    }
  }

  return { source: generate(), pulled: () => pulled };
}

/** A labelled case for the table-driven suites. */
interface LabelledValue {
  readonly label: string;
  readonly value: unknown;
}

/**
 * Every falsy value JavaScript has. Each one is a legitimate success value —
 * a zero duration, an empty component list, a deliberately absent selection —
 * and each is what an implementation that tested truthiness instead of the
 * discriminant would misreport as a failure.
 */
const FALSY_VALUES: readonly LabelledValue[] = [
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: 'zero', value: 0 },
  { label: 'negative zero', value: -0 },
  { label: 'NaN', value: Number.NaN },
  { label: 'false', value: false },
  { label: 'an empty string', value: '' },
  { label: 'zero as a bigint', value: 0n },
];

/**
 * Rejection reasons that are not `Error` instances. A rejected promise's
 * reason is an arbitrary value — a string from a serialised failure, a `null`
 * from a sloppy library — and {@link fromPromise} has to fulfil with a typed
 * `Err` for every one of them.
 */
const REJECTION_REASONS: readonly LabelledValue[] = [
  { label: 'a string', value: 'Serialised failure text' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'a number', value: 500 },
  { label: 'a plain object', value: { code: 'not-a-debuggen-error' } },
];

/*
 * ---------------------------------------------------------------------------
 * Constructors
 * ---------------------------------------------------------------------------
 */

describe('ok', () => {
  it('builds exactly { ok: true, value }', () => {
    const success: Ok<number> = ok(1175);

    expect(success.ok).toBe(true);
    expect(success.value).toBe(1175);
    // The exact key list, not a subset: this object is compared, logged and
    // handed across stage boundaries, and an extra key would travel with it.
    expect(Object.keys(success)).toEqual(['ok', 'value']);
    expect(success).toEqual({ ok: true, value: 1175 });
  });

  it('stores the value by identity, wrapping and copying nothing', () => {
    const summary = { traceId: 'a'.repeat(32), spans: 6 };

    expect(ok(summary).value).toBe(summary);
  });

  it('returns a fresh object for every call', () => {
    // Nothing is interned, so two successes carrying the same value are still
    // two objects — which is what makes the identity assertions in the `map`
    // and `andThen` suites meaningful.
    expect(ok(1)).not.toBe(ok(1));
  });

  it.each(FALSY_VALUES)('succeeds with $label', ({ value }: LabelledValue) => {
    const result = ok(value);

    expect(result.ok).toBe(true);
    expect(result.value).toBe(value);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
  });
});

describe('err', () => {
  it('builds exactly { ok: false, error }', () => {
    const failure: Err<DebuggenError> = err(storeFailure());

    expect(failure.ok).toBe(false);
    expect(failure.error.code).toBe(SPECIFIC_CODE);
    expect(Object.keys(failure)).toEqual(['ok', 'error']);
  });

  it('stores the error by identity, normalising nothing', () => {
    const failure = storeFailure();

    // Deliberately not `DebuggenError.from`: a producer that has already
    // chosen a code keeps it, and a producer with an error type of its own
    // keeps that. Normalisation belongs to `tryCatch` and `fromPromise`.
    expect(err(failure).error).toBe(failure);
  });

  it('accepts an error type that is not a DebuggenError', () => {
    // The `E` parameter exists for producers with a more precise failure type
    // — an enumerated reason, a validation issue list — which `mapErr` then
    // re-codes before the failure reaches a boundary.
    const failure: Result<number, 'symbol-absent'> = err('symbol-absent');

    expect(isErr(failure) && failure.error).toBe('symbol-absent');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Guards and narrowing
 * ---------------------------------------------------------------------------
 */

describe('isOk and isErr', () => {
  it('answer opposite questions about a success', () => {
    const success = succeeding(7);

    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
  });

  it('answer opposite questions about a failure', () => {
    const failure = failing<number>(storeFailure());

    expect(isOk(failure)).toBe(false);
    expect(isErr(failure)).toBe(true);
  });

  it('narrow a success to its value in the guarded branch and to its error in the else', () => {
    const result = succeeding(7);

    if (isOk(result)) {
      // No cast anywhere: the guard narrowed `Result<number>` to `Ok<number>`,
      // and the annotation is what turns a regression into a compile error.
      const value: number = result.value;

      expect(value).toBe(7);
    } else {
      // Unreachable at run time and deliberately compiled: the `else` branch
      // is `Err<DebuggenError>`, so `result.error` is reachable without a cast
      // or an `in` check. A guard that stopped narrowing fails here first.
      const code: DebuggenErrorCode = result.error.code;

      expect.unreachable(`ok(7) was narrowed to an Err carrying ${code}.`);
    }
  });

  it('narrow a failure to its error in the guarded branch and to its value in the else', () => {
    const failure = storeFailure();
    const result = failing<number>(failure);

    if (isErr(result)) {
      const error: DebuggenError = result.error;

      expect(error).toBe(failure);
      expect(error.hint).toBe('Check the session store.');
    } else {
      const value: number = result.value;

      expect.unreachable(`err(...) was narrowed to an Ok carrying ${value}.`);
    }
  });

  it('let the discriminant decide for a Result<void>, not the absent value', () => {
    // The shape every function that succeeds without producing anything
    // returns: a completed cleanup, an applied configuration.
    const completed = succeeding<void>(undefined);

    expect(isOk(completed)).toBe(true);
    expect(isErr(completed)).toBe(false);

    if (isOk(completed)) {
      const value: void = completed.value;

      expect(value).toBeUndefined();
    } else {
      expect.unreachable('ok(undefined) was narrowed to an Err.');
    }
  });

  it('narrow inside an Array.prototype.filter callback', () => {
    const failure = storeFailure();
    const results: Result<number>[] = [ok(1), err(failure), ok(3)];

    // The position the guards exist for, as opposed to the `if` form: the
    // filtered array is `Ok<number>[]`, so reading `.value` off each entry
    // needs no cast.
    const values = results.filter(isOk).map((entry) => entry.value);
    const errors = results.filter(isErr).map((entry) => entry.error);

    expect(values).toEqual([1, 3]);
    expect(errors).toEqual([failure]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Getting back to a plain value
 * ---------------------------------------------------------------------------
 */

describe('unwrap', () => {
  it('returns the value of a success', () => {
    expect(unwrap(ok(1175))).toBe(1175);
  });

  it('returns the absent value of a successful Result<void> rather than throwing', () => {
    const completed = succeeding<void>(undefined);

    // The discriminant decides here too: a `Result<void>` is as successful as
    // any other result, and an implementation that reached for the value's
    // truthiness would throw on the cleanup path.
    expect(unwrap(completed)).toBeUndefined();
  });

  it.each(FALSY_VALUES)('returns $label without throwing', ({ value }: LabelledValue) => {
    expect(unwrap(ok(value))).toBe(value);
  });

  it('throws for a failure, and the thrown value satisfies DebuggenError.is', () => {
    const failure = failing<number>(storeFailure());

    const thrown = thrownBy(() => unwrap(failure));

    // `DebuggenError.is`, not `instanceof`: the guard is the supported
    // question everywhere in this codebase, because an error that crossed a
    // bundle boundary is structurally this shape with a different prototype.
    expect(DebuggenError.is(thrown)).toBe(true);
  });

  it('throws the very error a failure carried, keeping its identity and code', () => {
    const failure = storeFailure();
    const result = failing<number>(failure);

    const thrown = thrownBy(() => unwrap(result));

    // Identity: `DebuggenError.from` returns an already-branded value
    // unchanged, so the specific code and hint a deeper layer chose reach the
    // catch site intact rather than as an `INTERNAL` re-wrap.
    expect(thrown).toBe(failure);
    expect(DebuggenError.is(thrown) && thrown.code).toBe(SPECIFIC_CODE);
    expect(DebuggenError.is(thrown) && thrown.hint).toBe('Check the session store.');
  });

  it('wraps a plain Error, keeping its message and itself as the cause', () => {
    const native = new TypeError('Cannot read properties of undefined');
    const result = failing<number, TypeError>(native);

    const thrown = thrownBy(() => unwrap(result));

    expect(DebuggenError.is(thrown)).toBe(true);
    expect(DebuggenError.is(thrown) && thrown.code).toBe('INTERNAL');
    expect(DebuggenError.is(thrown) && thrown.message).toBe('Cannot read properties of undefined');
    expect(DebuggenError.is(thrown) && thrown.cause).toBe(native);
  });

  it('wraps an error that is a bare string', () => {
    // A producer with its own error type may carry anything at all; the
    // contract is that a catch site still sees one type, never a bare string.
    const result = failing<number, string>('The plan named an absent symbol.');

    const thrown = thrownBy(() => unwrap(result));

    expect(DebuggenError.is(thrown)).toBe(true);
    expect(DebuggenError.is(thrown) && thrown.code).toBe('INTERNAL');
    expect(DebuggenError.is(thrown) && thrown.message).toBe('The plan named an absent symbol.');
  });
});

describe('unwrapOr', () => {
  it('returns the value of a success and ignores the fallback', () => {
    expect(unwrapOr(ok(1175), 0)).toBe(1175);
  });

  it('returns the fallback for a failure', () => {
    const failure = failing<number>(storeFailure());

    expect(unwrapOr(failure, 0)).toBe(0);
  });

  it('returns a falsy success value rather than substituting the fallback', () => {
    // The distinction that matters: a configured `0`, an empty string and an
    // explicit `false` are answers, and quietly replacing one with a default
    // is how a broken signal comes to look like a working one.
    expect(unwrapOr(ok(0), 30)).toBe(0);
    expect(unwrapOr(ok(''), 'fallback')).toBe('');
    expect(unwrapOr(ok(false), true)).toBe(false);
    expect(unwrapOr<number | null, DebuggenError>(ok(null), 30)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Combinators
 * ---------------------------------------------------------------------------
 */

describe('map', () => {
  it('transforms the value of a success into a new result', () => {
    const source = succeeding(1175);
    let calls = 0;

    const mapped: Result<string> = map(source, (value) => {
      calls += 1;
      return `${value}ms`;
    });

    expect(mapped).toEqual(ok('1175ms'));
    // A new object: the transformed value cannot be written into the source,
    // whose `value` is readonly and whose caller may still hold it.
    expect(mapped).not.toBe(source);
    expect(calls).toBe(1);
  });

  it('passes a failure through as the very same object, without calling the callback', () => {
    const failure = failing<number>(storeFailure());
    let calls = 0;

    const mapped = map(failure, (value) => {
      calls += 1;
      return `${value}ms`;
    });

    expect(mapped).toBe(failure);
    expect(calls).toBe(0);
  });

  it('transforms a falsy value like any other', () => {
    const source = succeeding(0);

    const mapped = map(source, (value) => value + 1);

    expect(mapped).toEqual(ok(1));
  });
});

describe('mapErr', () => {
  it('re-codes a generic failure into the code the calling stage reports', () => {
    // The mechanism this combinator exists for: a low-level helper reports
    // what it knows, and the caller that knows which stage asked maps it into
    // the specific code a user interface can choose a message from.
    const reported = new DebuggenError(GENERIC_CODE, 'The path escaped the project root.');
    const failure = failing<string>(reported);
    let calls = 0;

    const recoded = mapErr(failure, (error) => {
      calls += 1;
      return new DebuggenError(RECODED_CODE, error.message, {
        hint: 'Re-run investigation so the plan names a file inside the project.',
        cause: error,
      });
    });

    expect(calls).toBe(1);
    expect(isErr(recoded) && recoded.error.code).toBe(RECODED_CODE);
    expect(isErr(recoded) && recoded.error.message).toBe('The path escaped the project root.');
    // The original survives as the cause, so the log keeps the failure that
    // was actually raised while the surface renders the re-coded one.
    expect(isErr(recoded) && recoded.error.cause).toBe(reported);
  });

  it('may replace the error type entirely', () => {
    const failure = failing<string>(new DebuggenError(GENERIC_CODE, 'Outside the root.'));

    const codeOnly: Result<string, DebuggenErrorCode> = mapErr(failure, (error) => error.code);

    expect(isErr(codeOnly) && codeOnly.error).toBe(GENERIC_CODE);
  });

  it('passes a success through as the very same object, without calling the callback', () => {
    const success = succeeding('/tmp/project/src/index.ts');
    let calls = 0;

    const mapped = mapErr(success, (error) => {
      calls += 1;
      return error.code;
    });

    expect(mapped).toBe(success);
    expect(calls).toBe(0);
  });
});

describe('andThen', () => {
  it('chains a fallible step onto a success and returns the result of that step', () => {
    const source = succeeding('/tmp/project');
    let calls = 0;

    const chained = andThen(source, (root): Result<number> => {
      calls += 1;
      return ok(root.length);
    });

    expect(chained).toEqual(ok('/tmp/project'.length));
    expect(calls).toBe(1);
  });

  it('returns the failure a chained step produces', () => {
    const source = succeeding('/tmp/project');
    const raised = new DebuggenError('CODE_INDEX_FAILED', 'The project could not be indexed.');

    const chained = andThen(source, (): Result<number> => err(raised));

    expect(isErr(chained) && chained.error).toBe(raised);
  });

  it('short-circuits a failure as the same object and never invokes the callback', () => {
    const failure = failing<string>(storeFailure());
    let calls = 0;

    const chained = andThen(failure, (root): Result<number> => {
      calls += 1;
      return ok(root.length);
    });

    // Not invoking the callback is the contract, not an optimisation: the step
    // may have a side effect — opening a file, writing a patch — and skipping
    // it is exactly what an early `return` would have done.
    expect(calls).toBe(0);
    expect(chained).toBe(failure);
  });

  it('reports the first failure of a chain and skips every step after it', () => {
    const raised = new DebuggenError('PROJECT_NOT_FOUND', 'No project at that root.');
    let secondCalls = 0;
    let thirdCalls = 0;

    const resolved = succeeding('/tmp/project');
    const indexed = andThen(resolved, (): Result<number> => {
      secondCalls += 1;
      return err(raised);
    });
    const located = andThen(indexed, (count): Result<string> => {
      thirdCalls += 1;
      return ok(`${count} symbols`);
    });

    expect(secondCalls).toBe(1);
    expect(thirdCalls).toBe(0);
    // The failure the middle step produced reaches the end of the chain as the
    // same object, so the caller sees the code that step chose.
    expect(located).toBe(indexed);
    expect(isErr(located) && located.error).toBe(raised);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Adapting code that throws
 * ---------------------------------------------------------------------------
 */

describe('tryCatch', () => {
  it('returns a success carrying the value the function returned', () => {
    expect(tryCatch(() => 2 + 2)).toEqual(ok(4));
  });

  it('returns a success carrying undefined for a function that returns nothing', () => {
    const result = tryCatch((): void => undefined);

    expect(isOk(result)).toBe(true);
    expect(isOk(result) && result.value).toBeUndefined();
  });

  it('converts a thrown Error into a failure with the code it was given', () => {
    const native = new Error('SQLITE_BUSY');

    const result = tryCatch<number>(throwing(native), SPECIFIC_CODE);

    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.code).toBe(SPECIFIC_CODE);
    expect(isErr(result) && result.error.message).toBe('SQLITE_BUSY');
    expect(isErr(result) && result.error.cause).toBe(native);
  });

  it('falls back to INTERNAL when no code is supplied', () => {
    const result = tryCatch<number>(throwing(new Error('boom')));

    expect(isErr(result) && result.error.code).toBe('INTERNAL');
  });

  it('keeps the code of a thrown DebuggenError instead of overriding it', () => {
    const raised = storeFailure();

    const result = tryCatch<number>(throwing(raised), 'CONFIG_INVALID');

    // Idempotent by design: wrapping a call that already used this vocabulary
    // must not re-label the failure a deeper layer classified.
    expect(isErr(result) && result.error).toBe(raised);
    expect(isErr(result) && result.error.code).toBe(SPECIFIC_CODE);
  });

  it('converts a thrown value that is not an Error at all', () => {
    const result = tryCatch<number>(throwing('Serialised failure text'), SPECIFIC_CODE);

    expect(isErr(result) && result.error.code).toBe(SPECIFIC_CODE);
    expect(isErr(result) && result.error.message).toBe('Serialised failure text');
  });

  it('adapts a real throwing API — JSON.parse on malformed input', () => {
    // The shape this helper is actually used in: a third-party or builtin call
    // that reports failure by throwing, behind a `Result` like every other
    // producer, so nothing downstream carries a `try`/`catch` of its own.
    const parsed = tryCatch(() => JSON.parse('{ not json') as unknown, SPECIFIC_CODE);

    expect(isErr(parsed)).toBe(true);
    expect(isErr(parsed) && parsed.error.code).toBe(SPECIFIC_CODE);
    expect(isErr(parsed) && parsed.error.cause).toBeInstanceOf(SyntaxError);

    const valid = tryCatch(() => JSON.parse('{ "ok": true }') as unknown, SPECIFIC_CODE);

    expect(isOk(valid) && valid.value).toEqual({ ok: true });
  });
});

describe('fromPromise', () => {
  it('fulfils with a success for a resolved promise', async () => {
    const result = await fromPromise(Promise.resolve(1175));

    expect(result).toEqual(ok(1175));
  });

  it('fulfils with a failure for a rejected promise, carrying the code it was given', async () => {
    const reason = new Error('ECONNREFUSED 127.0.0.1:3000');

    // Awaited directly: no `try`/`catch`, no `.catch`, no `rejects` matcher.
    // The contract is that the returned promise always fulfils, so a
    // rejection escapes into the test body and fails this test.
    const result = await fromPromise(Promise.reject<number>(reason), 'DEV_SERVER_UNAVAILABLE');

    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(isErr(result) && result.error.message).toBe('ECONNREFUSED 127.0.0.1:3000');
    expect(isErr(result) && result.error.cause).toBe(reason);
  });

  it('falls back to INTERNAL when no code is supplied', async () => {
    const result = await fromPromise(Promise.reject<number>(new Error('boom')));

    expect(isErr(result) && result.error.code).toBe('INTERNAL');
  });

  it('keeps the code of a rejected DebuggenError instead of overriding it', async () => {
    const raised = storeFailure();

    const result = await fromPromise(Promise.reject<number>(raised), 'CONFIG_INVALID');

    expect(isErr(result) && result.error).toBe(raised);
    expect(isErr(result) && result.error.code).toBe(SPECIFIC_CODE);
  });

  it.each(REJECTION_REASONS)(
    'fulfils rather than rejecting for $label',
    async ({ value }: LabelledValue) => {
      const result = await fromPromise(rejectingWith<number>(value), SPECIFIC_CODE);

      expect(isErr(result)).toBe(true);
      expect(isErr(result) && DebuggenError.is(result.error)).toBe(true);
      expect(isErr(result) && result.error.code).toBe(SPECIFIC_CODE);
      expect(isErr(result) && result.error.message.length).toBeGreaterThan(0);
    },
  );

  it('fulfils with a success for a falsy resolution value', async () => {
    const result = await fromPromise(Promise.resolve(0));

    expect(isOk(result)).toBe(true);
    expect(isOk(result) && result.value).toBe(0);
  });

  it('accepts a thenable that is not a Promise, consuming it once', async () => {
    let thenCalls = 0;
    const thenable = thenableOf(Promise.resolve('a'.repeat(32)), () => {
      thenCalls += 1;
    });

    const result = await fromPromise(thenable);

    // `PromiseLike`, not `Promise`, is the declared parameter type, so a
    // deferred from an older library is accepted without the caller first
    // wrapping it in `Promise.resolve`.
    expect(isOk(result) && result.value).toBe('a'.repeat(32));
    expect(thenCalls).toBe(1);
  });

  it('converts a rejecting thenable into a failure', async () => {
    const reason = new Error('The deferred was rejected.');
    let thenCalls = 0;
    const thenable = thenableOf(Promise.reject<string>(reason), () => {
      thenCalls += 1;
    });

    const result = await fromPromise(thenable, SPECIFIC_CODE);

    expect(isErr(result) && result.error.code).toBe(SPECIFIC_CODE);
    expect(isErr(result) && result.error.cause).toBe(reason);
    expect(thenCalls).toBe(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Collecting many results into one
 * ---------------------------------------------------------------------------
 */

describe('collect', () => {
  it('returns every value in input order', () => {
    const collected = collect<number, DebuggenError>([ok(3), ok(1), ok(2)]);

    expect(collected).toEqual(ok([3, 1, 2]));
  });

  it('returns a fresh array the caller may keep and mutate', () => {
    const collected = collect<number, DebuggenError>([ok(1), ok(2)]);

    expect(isOk(collected)).toBe(true);

    const values = unwrap(collected);
    values.push(3);

    expect(values).toEqual([1, 2, 3]);
  });

  it('succeeds with an empty array for an empty iterable', () => {
    // The right answer for a plan with no actions: nothing failed, and there
    // is nothing to install.
    const empty: readonly Result<number>[] = [];

    expect(collect(empty)).toEqual(ok([]));
  });

  it('returns the first failure, not the last', () => {
    const first = new DebuggenError('PATCH_TARGET_NOT_FOUND', 'The first symbol is absent.');
    const second = new DebuggenError('PATCH_UNSUPPORTED', 'The second form cannot be wrapped.');
    const firstFailure = failing<number>(first);
    const secondFailure = failing<number>(second);

    const collected = collect([ok(1), firstFailure, ok(3), secondFailure]);

    // The same object, and the earlier one: the failure a developer is shown
    // has to be the one that came first, or the reported cause is arbitrary.
    expect(collected).toBe(firstFailure);
    expect(collected).not.toBe(secondFailure);
    expect(isErr(collected) && collected.error).toBe(first);
  });

  it('stops pulling a lazy source at the first failure', () => {
    const raised = new DebuggenError('PATCH_TARGET_NOT_FOUND', 'The symbol is absent.');
    const { source, pulled } = countingSource<number, DebuggenError>([
      ok(1),
      err(raised),
      ok(3),
      ok(4),
    ]);

    const collected = collect(source);

    // Two pulled — the success and the failure — and the two items after them
    // never produced. This is what lets the installer's feasibility pass abort
    // on the first infeasible action instead of doing the rest of the work
    // for a plan it is about to reject.
    expect(pulled()).toBe(2);
    expect(isErr(collected) && collected.error).toBe(raised);
  });

  it('pulls every item of a fully successful lazy source', () => {
    const { source, pulled } = countingSource<number, DebuggenError>([ok(1), ok(2), ok(3)]);

    const collected = collect(source);

    expect(pulled()).toBe(3);
    expect(collected).toEqual(ok([1, 2, 3]));
  });

  it('collects falsy values without mistaking one for a failure', () => {
    const collected = collect<number | null, DebuggenError>([ok(0), ok(null), ok(-0)]);

    expect(isOk(collected)).toBe(true);
    expect(unwrap(collected)).toEqual([0, null, -0]);
  });

  it('carries an error type that is not a DebuggenError', () => {
    type FeasibilityIssue = 'symbol-absent' | 'unsupported-form';
    const results: readonly Result<string, FeasibilityIssue>[] = [
      ok('action-1'),
      err('unsupported-form'),
      err('symbol-absent'),
    ];

    const collected = collect(results);

    expect(isErr(collected) && collected.error).toBe('unsupported-form');
  });
});
