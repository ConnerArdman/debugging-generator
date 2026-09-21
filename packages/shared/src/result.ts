/**
 * The failure vocabulary every workspace in this monorepo uses instead of
 * throwing.
 *
 * A debugger that writes into a developer's working tree, drives their dev
 * server and calls a model provider fails in a great many ordinary ways: a
 * planned signal cannot be enabled, a patch target is not where the plan said
 * it was, a model returns output that does not satisfy its schema, a path
 * escapes the project root. None of those is exceptional, and each has a
 * defined recovery path and a defined thing to show the developer — so each is
 * a *value* this code returns, not a control-flow event it raises. That is the
 * point of the type defined here: a caller cannot reach a success value
 * without having said something about the failure case first, and a failure is
 * therefore never presented as a successful analysis.
 *
 * `throw` keeps exactly two jobs in this codebase: a genuine programmer error
 * (an invariant that cannot hold), and {@link unwrap}, whose entire purpose is
 * to convert a proven-successful `Result` back into a plain value at a call
 * site that has already established success.
 *
 * ## Position in the module graph
 *
 * This is the second module of `@debuggen/shared`, the base layer of the
 * acyclic package graph. It imports exactly one thing — `./errors.js`, for the
 * default error type — and nothing else: no workspace package, no third-party
 * package, no Node builtin. `src/index.ts` re-exports it behind the
 * browser-safe `"."` entry, which the browser telemetry agent, the DevTools
 * panel and the VS Code webview all bundle, so a single Node builtin specifier
 * here would break three bundles at once. Node-only helpers live under
 * `src/node/**` and are published through the separate `"./node"` entry
 * instead.
 *
 * The edge to `./errors.js` runs one way. `errors.ts` must never import this
 * module: it sits below it, and a back-edge would make the two modules
 * mutually dependent for no gain — an error is a value a `Result` can carry,
 * while a `Result` is never part of building an error.
 *
 * ## The surface is fixed
 *
 * Eleven workspaces speak this dialect — `paths.ts` and `source-location.ts`
 * in this package, `@debuggen/code-analysis`, `@debuggen/instrumentation`'s
 * installer and cleanup, `@debuggen/model-provider`'s structured-output
 * rejection path, `@debuggen/panel-schema`'s validators and every pipeline
 * stage in the local service. The exports below are all of them, deliberately:
 * no `match`, no `fold`, no async variant beyond {@link fromPromise}. A helper
 * added here is a helper eleven packages then have to reason about, and the
 * `if (isOk(result))` it would replace is shorter than learning it.
 *
 * @example Returning and consuming a `Result`
 * ```ts
 * function parsePort(raw: string): Result<number> {
 *   const port = Number.parseInt(raw, 10);
 *   if (!Number.isInteger(port) || port < 1 || port > 65_535) {
 *     return err(new DebuggenError('CONFIG_INVALID', `Not a port: ${raw}`));
 *   }
 *   return ok(port);
 * }
 *
 * const parsed = parsePort(configuredPort);
 * if (isOk(parsed)) {
 *   listen(parsed.value);
 * } else {
 *   logger.error(parsed.error.message, { hint: parsed.error.hint });
 * }
 * ```
 */

import { DebuggenError } from './errors.js';
import type { DebuggenErrorCode } from './errors.js';

/**
 * A successful outcome carrying its value.
 *
 * `ok` is a literal `true`, which is what makes {@link Result} a discriminated
 * union: `if (result.ok)` narrows to this interface with no helper, no cast
 * and no `in` check, and a `switch (result.ok)` is exhaustive. The discriminant
 * is the *only* thing that decides success, so an `Ok<undefined>` — the shape
 * of a `Result<void>` — is just as successful as any other, and a falsy value
 * never reads as a failure.
 *
 * Both members are `readonly`. A `Result` crosses pipeline stage boundaries in
 * the local service and is handed between adapters in
 * `@debuggen/instrumentation`, and a receiver that cannot mutate it does not
 * need to copy it defensively.
 *
 * @typeParam T The value produced on success.
 */
export interface Ok<T> {
  /** The literal discriminant marking this outcome as successful. */
  readonly ok: true;

  /** The value produced. May legitimately be `undefined` for a `Result<void>`. */
  readonly value: T;
}

/**
 * A failed outcome carrying its error.
 *
 * The counterpart of {@link Ok}, with `ok` fixed to the literal `false` so the
 * `else` branch of `if (result.ok)` narrows to this interface and `result.error`
 * is reachable without a cast.
 *
 * The error type is a parameter rather than fixed to `DebuggenError` because
 * some producers have a more precise failure type of their own — a Zod issue
 * list, an enumerated reason — and {@link mapErr} is how such a failure is
 * re-coded before it reaches a boundary. Most producers leave it at the
 * {@link Result} default.
 *
 * @typeParam E The error produced on failure.
 */
export interface Err<E> {
  /** The literal discriminant marking this outcome as failed. */
  readonly ok: false;

  /** The error produced. Never `undefined` in first-party code. */
  readonly error: E;
}

/**
 * Either an {@link Ok} carrying a value or an {@link Err} carrying an error.
 *
 * The error type defaults to `DebuggenError`, which is what keeps the type
 * readable at the hundreds of call sites that use it: `Result<string>` is the
 * common case — a value or one of the product's closed set of failure codes —
 * and only a producer with a more specific error names the second parameter.
 *
 * Narrow it with {@link isOk} or {@link isErr}, or directly on the `ok`
 * discriminant; both are equivalent to the compiler, and the guards exist for
 * the positions where a predicate function is what reads best (an
 * `Array.prototype.filter` callback, for instance).
 *
 * @typeParam T The value produced on success.
 * @typeParam E The error produced on failure. Defaults to `DebuggenError`.
 */
export type Result<T, E = DebuggenError> = Ok<T> | Err<E>;

/**
 * Builds a successful {@link Ok}.
 *
 * @typeParam T The value type, normally inferred from `value`.
 * @param value The value produced. Pass `undefined` for a `Result<void>`.
 * @returns `{ ok: true, value }`.
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * Builds a failed {@link Err}.
 *
 * Nothing is wrapped or normalised here: the error is stored as given, so a
 * producer that has already chosen a specific `DebuggenErrorCode` keeps it, and
 * a producer with its own error type keeps that. Use {@link tryCatch} or
 * {@link fromPromise} when the failure arrives as an unknown thrown value that
 * still has to be normalised.
 *
 * @typeParam E The error type, normally inferred from `error`.
 * @param error The error produced.
 * @returns `{ ok: false, error }`.
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Whether `result` succeeded, as a type guard.
 *
 * @typeParam T The result's value type.
 * @typeParam E The result's error type.
 * @param result The result to inspect.
 * @returns `true` when `result` is an {@link Ok}, narrowing it to `Ok<T>` in
 * the guarded branch and to `Err<E>` in the `else`.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/**
 * Whether `result` failed, as a type guard.
 *
 * The mirror image of {@link isOk}, for the call sites that read better stated
 * negatively — an early return that reports a failure and leaves the success
 * path unindented.
 *
 * @typeParam T The result's value type.
 * @typeParam E The result's error type.
 * @param result The result to inspect.
 * @returns `true` when `result` is an {@link Err}, narrowing it to `Err<E>` in
 * the guarded branch and to `Ok<T>` in the `else`.
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Returns the value of a successful result, or **throws** for a failed one.
 *
 * This is the one function in this module that throws, and it is reserved for
 * call sites that have already proven success: a test asserting a parser
 * accepted its input, or an invariant that cannot be false without the program
 * being wrong (a lookup into a map the same function just populated).
 * Production code on a path a developer can reach branches on {@link isOk}
 * instead — the reason this vocabulary exists is that a failure there has a
 * message, a hint and a recovery path to show, and an exception thrown past
 * the boundary has none of those.
 *
 * The thrown value is always a `DebuggenError`, normalised through
 * `DebuggenError.from`: an `Err` already holding one is thrown unchanged, so
 * the specific code a deeper layer chose survives, and anything else — a
 * native `Error`, a string, a Zod issue list — is wrapped with the `INTERNAL`
 * code and the original as its `cause`. A caller that does catch it therefore
 * catches one type, never a bare string.
 *
 * @typeParam T The result's value type.
 * @typeParam E The result's error type.
 * @param result The result to unwrap.
 * @returns The value, when `result` is an {@link Ok}.
 * @throws A `DebuggenError` built by `DebuggenError.from(result.error)`, when
 * `result` is an {@link Err}.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw DebuggenError.from(result.error);
}

/**
 * Returns the value of a successful result, or `fallback` for a failed one.
 *
 * The failure is discarded, so this belongs where the failure genuinely does
 * not matter — an optional configuration value with a documented default, a
 * display string with a placeholder. Where the developer should learn that
 * something failed, branch on {@link isOk} and report it; a silently
 * substituted default is how a broken signal comes to look like a working one.
 *
 * @typeParam T The result's value type.
 * @typeParam E The result's error type.
 * @param result The result to unwrap.
 * @param fallback The value to return for an {@link Err}. Evaluated by the
 * caller, so keep it cheap; there is no lazy variant on purpose.
 * @returns `result.value` for an {@link Ok}, `fallback` otherwise.
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Transforms the value of a successful result, leaving a failure untouched.
 *
 * `fn` runs only for an {@link Ok}. An {@link Err} is returned as the very
 * same object — not a rebuilt one — so the error identity a producer created
 * is preserved all the way to the boundary that reports it, and a chain of
 * `map` calls costs one allocation per successful step and none per failing
 * one.
 *
 * Use it for a pure shape change that cannot itself fail (parsing a number
 * that has already been validated, projecting a record). When the
 * transformation can fail, it returns a `Result` of its own and
 * {@link andThen} is the combinator that keeps the nesting flat.
 *
 * @typeParam T The input result's value type.
 * @typeParam U The transformed value type.
 * @typeParam E The error type, carried through unchanged.
 * @param result The result to transform.
 * @param fn Applied to the value of an {@link Ok}. Must not throw; wrap a
 * fallible body in {@link tryCatch} and use {@link andThen} instead.
 * @returns `ok(fn(result.value))` for an {@link Ok}, `result` itself
 * otherwise.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

/**
 * Transforms the error of a failed result, leaving a success untouched.
 *
 * This is the mechanism by which a generic failure is re-coded for the layer
 * that reports it. The path helpers in `paths.ts` and the parsers in
 * `source-location.ts` do not know which stage called them, so they report
 * what they know (`PATH_OUTSIDE_PROJECT`, a malformed location); the caller
 * that does know maps that into the specific `DebuggenErrorCode` its own
 * failure deserves — a click-to-source request refused becomes one thing, a
 * plan naming an unreachable file another — before the error reaches the
 * protocol's `error` payload, where the code is all a user interface has to
 * choose a message from.
 *
 * `fn` runs only for an {@link Err}; an {@link Ok} is returned as the same
 * object, so mapping errors never disturbs a value in flight.
 *
 * @typeParam T The value type, carried through unchanged.
 * @typeParam E The input result's error type.
 * @typeParam F The transformed error type.
 * @param result The result to transform.
 * @param fn Applied to the error of an {@link Err}. Must not throw.
 * @returns `err(fn(result.error))` for an {@link Err}, `result` itself
 * otherwise.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (result.ok) {
    return result;
  }
  return err(fn(result.error));
}

/**
 * Chains a fallible step onto a successful result, short-circuiting a failure.
 *
 * `fn` is invoked only for an {@link Ok}, and its own `Result` becomes the
 * answer, so a sequence of steps that can each fail reads as a flat chain
 * rather than nested conditionals: resolve a project root, then index it, then
 * locate a symbol in the index, with the first failure of the three ending the
 * chain and reaching the caller unchanged. An {@link Err} is returned as the
 * same object and `fn` never runs — which also means a step with a side effect
 * is skipped, exactly as an early `return` would skip it.
 *
 * Both sides share one error type. Where a step fails differently, normalise
 * it with {@link mapErr} first; that keeps the union the caller has to handle
 * explicit instead of accumulating silently.
 *
 * @typeParam T The input result's value type.
 * @typeParam U The chained step's value type.
 * @typeParam E The error type shared by this result and the chained step.
 * @param result The result to chain onto.
 * @param fn Applied to the value of an {@link Ok}; returns the next `Result`.
 * @returns `fn(result.value)` for an {@link Ok}, `result` itself otherwise.
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}

/**
 * Runs a synchronous function and converts a thrown value into an
 * {@link Err}.
 *
 * This is the adapter at the edge of code that does not use this vocabulary —
 * a third-party library, a Node builtin reached through this package's `./node`
 * entry, `JSON.parse`, a getter on a foreign object. Everything downstream of
 * such a call then branches on a `Result` like every other producer instead of
 * carrying a `try`/`catch` of its own.
 *
 * Whatever is thrown is normalised by `DebuggenError.from`, which is why the
 * error type is fixed to `DebuggenError` here: `catch` binds `unknown`, and a
 * boundary still has to report something typed. A thrown value that already
 * *is* a `DebuggenError` keeps its own code — `code` never overrides one that
 * exists — so wrapping a call that itself used this helper stays idempotent.
 *
 * @typeParam T The function's return type.
 * @param fn The function to run. Its return value becomes the {@link Ok}
 * value, including `undefined`.
 * @param code The `DebuggenErrorCode` to apply to a thrown value that carries
 * none. Defaults to `INTERNAL`; name the code of the operation that failed
 * whenever it is known, because `INTERNAL` tells a user interface nothing.
 * @returns `ok(fn())`, or `err(DebuggenError.from(thrown, code))` when `fn`
 * throws.
 *
 * @example
 * ```ts
 * const parsed = tryCatch(() => JSON.parse(raw) as unknown, 'STORE_ERROR');
 * ```
 */
export function tryCatch<T>(fn: () => T, code?: DebuggenErrorCode): Result<T, DebuggenError> {
  try {
    return ok(fn());
  } catch (thrown) {
    return err(DebuggenError.from(thrown, code ?? 'INTERNAL'));
  }
}

/**
 * Awaits a promise and converts a rejection into an {@link Err}.
 *
 * The asynchronous counterpart of {@link tryCatch}, and the only async helper
 * in this module. **The returned promise never rejects**: every outcome of
 * `promise` arrives as a fulfilled `Result`, so a caller writes
 * `const result = await fromPromise(...)` with no `try`/`catch` and no
 * floating-rejection risk — which matters most in the places that use it, such
 * as an adapter's `install` or a fetch to the local service, where an
 * unhandled rejection would take down a session rather than fail one step of
 * it.
 *
 * The parameter is `PromiseLike<T>` rather than `Promise<T>` on purpose: a
 * thenable returned by a bundled dependency (a query builder, a deferred from
 * an older library) is accepted without the caller first wrapping it in
 * `Promise.resolve`.
 *
 * A rejection reason is normalised exactly as {@link tryCatch} normalises a
 * thrown value — a rejection reason is an arbitrary value, frequently not an
 * `Error` at all — and an already-`DebuggenError` reason keeps its code.
 *
 * @typeParam T The promise's resolution type.
 * @param promise The promise or thenable to await.
 * @param code The `DebuggenErrorCode` to apply to a rejection reason that
 * carries none. Defaults to `INTERNAL`.
 * @returns A promise that always fulfils: `ok(value)` on resolution,
 * `err(DebuggenError.from(reason, code))` on rejection.
 */
export async function fromPromise<T>(
  promise: PromiseLike<T>,
  code?: DebuggenErrorCode,
): Promise<Result<T, DebuggenError>> {
  try {
    return ok(await promise);
  } catch (thrown) {
    return err(DebuggenError.from(thrown, code ?? 'INTERNAL'));
  }
}

/**
 * Collects an iterable of results into one result holding every value,
 * **short-circuiting on the first failure**.
 *
 * The short-circuit is the contract, not an optimisation. The installer in
 * `@debuggen/instrumentation` checks each planned action for feasibility and
 * must abort on the first infeasible one — continuing would install part of a
 * plan whose remainder cannot work, leaving instrumentation in the developer's
 * files for a capture that was never going to produce the signal it was for.
 * The same applies to the panel validators and to every stage that maps a list
 * of inputs through a fallible step: the first failure is the one to report,
 * and the reported error is the *first* one, never the last.
 *
 * Because the input is an `Iterable`, a lazy source — a generator that
 * validates one action at a time, or one that opens a file per item — stops
 * being pulled as soon as a failure is seen, so the work after it is never
 * done. The values of a fully successful run are returned in input order in a
 * fresh array, so the caller may keep and mutate it freely. An empty iterable
 * succeeds with an empty array, which is the right answer for a plan with no
 * actions.
 *
 * @typeParam T The value type of each input result.
 * @typeParam E The error type shared by the input results.
 * @param results The results to collect, in the order they should appear.
 * @returns `ok(values)` in input order when every result succeeded, or the
 * first {@link Err} encountered, returned as the same object.
 *
 * @example
 * ```ts
 * const resolved = collect(actions.map((action) => resolveTarget(action)));
 * if (isErr(resolved)) {
 *   return resolved; // first infeasible action aborts the install
 * }
 * install(resolved.value);
 * ```
 */
export function collect<T, E>(results: Iterable<Result<T, E>>): Result<T[], E> {
  const values: T[] = [];
  // `for...of` rather than an index: `noUncheckedIndexedAccess` makes every
  // indexed read `T | undefined`, and an `Iterable` has no index to read in
  // the first place — which is also what lets a lazy source stop early.
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
    values.push(result.value);
  }
  return ok(values);
}
