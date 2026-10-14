/**
 * The four invariant checks this monorepo throws with, and the boundary between
 * an impossible state and an expected failure.
 *
 * Four processes cooperate in this product — the local service, the VS Code
 * extension host, the DevTools panel and the page agent — and each of them runs
 * state that must hold or nothing downstream means anything: the session state
 * machine only reaches `generated` through a validated analysis and a validated
 * panel, the installer applies patch records whose hashes it recorded itself,
 * and the correlator builds one ordered tree out of spans from three tiers. When
 * one of those invariants does not hold, the useful outcome is a loud, coded
 * failure at the line that noticed — not a `null` threaded through four more
 * layers until it surfaces as an empty panel.
 *
 * These helpers are that failure, in one shape: a {@link DebuggenError} with a
 * {@link DebuggenErrorCode}, so a boundary can decide what to do from the code
 * instead of parsing a message, and so the failure travels as the protocol's
 * `error` payload like any other.
 *
 * ## These run in production. Nothing strips them.
 *
 * This is not `node:assert`, and it is not a development-only macro. There is no
 * `NODE_ENV` guard around any check below, no build step removes one, and none
 * of the bundlers in this repository does the dead-code elimination that would:
 * every workspace is bundled by tsup (or esbuild, or Vite) from this source,
 * with the call and the `throw` intact in `dist/`. A call you write here is a
 * call that executes in a developer's editor, in their browser and in their dev
 * server.
 *
 * Two consequences follow, and both matter more than the convenience of a
 * one-line check.
 *
 * 1. **Relying on them for a genuine invariant is safe.** The check is still
 *    there in the shipped artefact, so an impossible state cannot pass silently
 *    in a build where the assertion "was compiled out".
 * 2. **Using them for an expected failure is wrong.** A planned signal that
 *    cannot be enabled, a patch target that has moved, a capture that collected
 *    nothing, a model output that failed its schema, a path that escaped the
 *    project root — every one of those is an ordinary outcome with a defined
 *    recovery path and a defined thing to show the developer. Those return a
 *    `Result` (see `./result.js`) so each user interface can render the message
 *    and the recovery action the graceful-failure contract specifies. Throwing
 *    there replaces that with a stack trace, which tells the developer nothing
 *    they can act on.
 *
 * The rule of thumb: if you can write the sentence a developer should read when
 * this happens, it is a `Result`. If the only honest sentence is "this cannot
 * happen", it is an assertion.
 *
 * ## Narrowing only works on a direct call
 *
 * {@link assert} and {@link assertDefined} carry assertion signatures
 * (`asserts condition`, `asserts value is NonNullable<T>`), which TypeScript
 * applies only when the call target is a reference with an explicit type — an
 * imported function declaration, called directly:
 *
 * ```ts
 * import { assert, assertDefined } from '@debuggen/shared';
 *
 * assertDefined(session, 'Session must exist here.'); // narrows
 * ```
 *
 * It does **not** apply through a re-assigned alias (`const check = assert`), a
 * property of an object you built, or a namespace obtained from a dynamic
 * `import()`. In those positions the call still throws at runtime — the check is
 * real — but the compiler declines to narrow, and the code after it keeps the
 * wider type. Consumers therefore import these names from `@debuggen/shared`
 * and call them directly; there is no supported indirect form.
 *
 * ## Position in the module graph
 *
 * This module imports exactly one thing, `./errors.js`, and nothing else: no
 * workspace package, no third-party package, no Node builtin. `@debuggen/shared`
 * is the base layer of the acyclic package graph, and its root entry is bundled
 * into a page by the browser telemetry agent, the DevTools panel and the VS Code
 * webview — so `node:assert` is not an option here, and neither is `process`.
 * Node-only helpers live under `src/node/**` behind the separate `"./node"`
 * entry.
 *
 * The edge runs one way and stays shallow: `src/index.ts` re-exports this
 * module, and nothing else inside this package imports it. A sibling that needs
 * an invariant throws `DebuggenError` directly rather than adding an edge to
 * this file.
 *
 * @example Guarding an impossible state, and choosing a code that says why
 * ```ts
 * import { assert, assertDefined, assertNever, fail } from '@debuggen/shared';
 *
 * function describe(status: SessionStatus): string {
 *   switch (status) {
 *     case 'created':
 *       return 'Session created';
 *     case 'capturing':
 *       return 'Capturing';
 *     // …every other member handled…
 *     default:
 *       // Adding a status without extending this switch fails to compile here.
 *       return assertNever(status, 'Unhandled session status');
 *   }
 * }
 *
 * function apply(record: ModificationRecord, currentHash: string): void {
 *   assertDefined(record.backupPath, 'An applied record must have a backup.');
 *   assert(
 *     currentHash === record.instrumentedHash,
 *     'Cleanup reached a file whose hash was already checked.',
 *     'MODIFICATION_CONFLICT',
 *   );
 *   restore(record.backupPath);
 * }
 *
 * function encode(node: PanelNode): never {
 *   return fail(`No encoder for ${node.type}.`, 'NOT_IMPLEMENTED');
 * }
 * ```
 */

import { DebuggenError } from './errors.js';
import type { DebuggenErrorCode } from './errors.js';

/**
 * How much of a rendered primitive reaches an {@link assertNever} message.
 *
 * The same bound the telemetry privacy model uses for a captured prop or state
 * preview, for the same reason: a message is logged, persisted with a session
 * and shown in a user interface, so an unexpectedly long string — a URL with a
 * query, a serialised row — is truncated rather than carried whole.
 */
const MAX_VALUE_PREVIEW_LENGTH = 120;

/**
 * How many own key names of an unexpected object reach an {@link assertNever}
 * message.
 *
 * Key *names* identify which variant of a discriminated union leaked through a
 * switch, which is the diagnostic that matters; key *values* are exactly what
 * must not end up in a message, so none is ever read. Eight is enough to
 * recognise a message envelope, a panel node or a telemetry event, and short
 * enough to stay on one line of a log.
 */
const MAX_DESCRIBED_KEYS = 8;

/** The message {@link assertNever} uses when the caller supplies none. */
const DEFAULT_UNHANDLED_MESSAGE = 'Unhandled value';

/**
 * Throws a {@link DebuggenError} unless `condition` is truthy.
 *
 * The general form: use it where a state is impossible by construction and the
 * code after the call is written on that basis. It narrows `condition` for the
 * compiler, so `assert(typeof raw === 'string', …)` leaves `raw` typed `string`
 * on every following line — provided the call is direct, as described in this
 * module's documentation.
 *
 * This check runs in production. It is not removed by any build in this
 * repository, which is what makes it trustworthy for a real invariant and wrong
 * for an expected failure: those return a `Result` (`./result.js`) so a user
 * interface can render a recovery path instead of a stack trace.
 *
 * Truthiness is the test, not definedness. `0`, `''`, `NaN` and `false` are all
 * failures here — which is usually what a condition expression means, and never
 * what a *value* means. For a value, reach for {@link assertDefined}.
 *
 * @param condition The expression that must hold. Typed `unknown` so any
 * expression is accepted without a cast, and so a type predicate on the left of
 * the call site narrows through it.
 * @param message A complete sentence stating the invariant that did not hold,
 * for the error's message line and for the log.
 * @param code The failure to report. Defaults to `INTERNAL`, the code for an
 * unexpected failure; pass a specific code — `SESSION_INVALID_STATE`,
 * `MODIFICATION_CONFLICT`, `PROTOCOL_INVALID_MESSAGE` — whenever the broken
 * invariant has one, because `INTERNAL` tells a user interface nothing.
 * @throws A {@link DebuggenError} carrying `code` and `message` when `condition`
 * is falsy.
 */
export function assert(
  condition: unknown,
  message: string,
  code: DebuggenErrorCode = 'INTERNAL',
): asserts condition {
  if (!condition) {
    throw new DebuggenError(code, message);
  }
}

/**
 * Throws a {@link DebuggenError} when `value` is `null` or `undefined`, and
 * narrows it to `NonNullable<T>` otherwise.
 *
 * The distinction from {@link assert} is the entire reason this exists beside
 * it: only nullishness fails here. `0`, `''`, `false`, `NaN`, an empty array and
 * an empty object all pass, because each is a legitimate value that a truthiness
 * check would reject — a zero duration, an empty SQL parameter, a render count
 * of nought, a `false` flag on an agent hook configuration. Asserting a value is
 * present is a different question from asserting it is interesting, and this is
 * the helper for the first one.
 *
 * Like every check in this module it runs in production and is never stripped;
 * an absent-but-expected value (a session that does not exist, a symbol the code
 * graph does not know) belongs in a `Result` (`./result.js`) instead.
 *
 * @typeParam T The declared type of `value`, normally inferred. The assertion
 * narrows it to `NonNullable<T>`, so the call is pointless — though harmless —
 * on a type that already excludes `null` and `undefined`.
 * @param value The value that must be present.
 * @param message A complete sentence stating what was missing and why it should
 * not have been.
 * @param code The failure to report. Defaults to `INTERNAL`; pass a specific
 * code when one fits.
 * @throws A {@link DebuggenError} carrying `code` and `message` when `value` is
 * `null` or `undefined`.
 */
export function assertDefined<T>(
  value: T,
  message: string,
  code: DebuggenErrorCode = 'INTERNAL',
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new DebuggenError(code, message);
  }
}

/**
 * Throws a {@link DebuggenError} for a value a `switch` was supposed to have
 * handled exhaustively.
 *
 * This is the exhaustiveness guard that makes the discriminated unions this
 * product is built on safe to extend. The protocol's message union, the session
 * status enum, the panel node catalog and the telemetry `kind` list all grow
 * over the life of this codebase, and each one is switched on in several
 * workspaces. Ending such a switch with `assertNever(value)` turns the compiler
 * into the reviewer: because the parameter is typed `never`, a new member that
 * no `case` handles still has a type at the default branch, the call stops
 * compiling, and the error points at every switch that has to say something
 * about the new variant. That is the point — an unhandled variant is found at
 * build time, and, in the case that reaches production anyway (a frame from a
 * newer peer, say), it fails loudly at the one place it arrives instead of
 * being rendered as an empty panel.
 *
 * Always `return assertNever(…)` (or `throw`) in the default branch, so
 * `noImplicitReturns` and the compiler's reachability analysis both see that the
 * branch produces no value.
 *
 * The message includes a bounded, safe rendering of the unexpected value: its
 * `typeof`, plus a truncated preview for a primitive (the text itself for a
 * string, a symbol's description, `String()` for a number, bigint or boolean)
 * and a constructor name with own key *names* for an object. No key's value is
 * ever read, `JSON.stringify` is never called on it — it throws on a cycle and
 * on a `bigint`, which is not a failure mode an error reporter may have — and
 * any foreign getter or proxy trap that throws while the value is being
 * described degrades the rendering to the `typeof` alone rather than replacing
 * this assertion's failure with an unrelated one.
 *
 * Reported as `INTERNAL`, deliberately and without a `code` parameter: an
 * unhandled union member is not one of the product's expected failures, it is
 * the code being out of date with its own types.
 *
 * @param value The unhandled value. Typed `never`, so a call only compiles
 * where the compiler has already proved every declared member handled.
 * @param message A short statement of what was being switched on, for instance
 * `'Unhandled telemetry kind'`. Defaults to `'Unhandled value'`.
 * @returns Never; the return type exists so the call can be `return`ed from a
 * branch that must produce a value.
 * @throws A {@link DebuggenError} with code `INTERNAL`, always.
 */
export function assertNever(value: never, message: string = DEFAULT_UNHANDLED_MESSAGE): never {
  throw new DebuggenError('INTERNAL', `${message}: ${describeUnexpected(value)}`);
}

/**
 * Throws a {@link DebuggenError} unconditionally.
 *
 * The unconditional form, for a branch that must not be reached and has no
 * condition to test: a code path deliberately not built (`NOT_IMPLEMENTED`), a
 * defensive `default` over something that is not a union, the tail of a function
 * whose earlier branches have covered every case the design allows. Its return
 * type is `never`, so it satisfies a position that owes a value and the compiler
 * treats everything after it as unreachable.
 *
 * It is the right tool only when the branch genuinely cannot be reached by a
 * supported input. A branch a developer can reach by using the product — an
 * unsupported patch target, a provider that is not configured — is an expected
 * failure with a message and a recovery path, and belongs in a `Result`
 * (`./result.js`).
 *
 * @param message A complete sentence stating what was reached and why it should
 * not have been.
 * @param code The failure to report. Defaults to `INTERNAL`; `NOT_IMPLEMENTED`
 * is the code for a path that was deliberately left unbuilt, and a specific code
 * is better than either when one fits.
 * @returns Never.
 * @throws A {@link DebuggenError} carrying `code` and `message`, always.
 */
export function fail(message: string, code: DebuggenErrorCode = 'INTERNAL'): never {
  throw new DebuggenError(code, message);
}

/**
 * Renders an unexpected value for an {@link assertNever} message, safely.
 *
 * Module-private, and the only reason this file has any logic in it at all.
 * "Safely" carries three obligations, each of which has a failure mode that has
 * bitten real error reporters:
 *
 * - **It must not run foreign code that can throw.** `String()` on an object
 *   invokes whatever `toString` that object has; a proxy throws from its own
 *   traps. Objects are therefore described by their constructor name and own key
 *   names, and the whole description is wrapped so that a throw degrades to the
 *   `typeof` instead of replacing the assertion's failure with an unrelated one.
 * - **It must not leak data.** Key names are read with `Object.keys`, which does
 *   not invoke getters, and no value behind a key is ever read. Primitives are
 *   truncated. An error message is logged, persisted with a session and shown in
 *   a user interface, so it is held to the same standard as any other diagnostic
 *   context.
 * - **It must not be `JSON.stringify`.** That throws on a circular reference and
 *   on a `bigint`, both of which are ordinary values to find in a union member.
 *
 * @param value The value to describe, typed `unknown` because the caller's
 * `never` says only that this should be unreachable.
 * @returns A short, single-line description. Never throws.
 */
function describeUnexpected(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const kind = typeof value;

  try {
    // Each branch below tests `value` itself, and every kind is matched
    // positively rather than left to an `else`. The alias is for the message
    // and the fallback only: narrowing `unknown` by *excluding* kinds leaves a
    // type that still admits an object, so the stringification below would no
    // longer be provably safe — and the safety of that call is the entire
    // argument of this function.
    if (typeof value === 'string') {
      return `string ${truncate(value)}`;
    }

    if (typeof value === 'function') {
      const name = value.name;
      return name.length > 0 ? `function ${name}` : 'function';
    }

    if (typeof value === 'object') {
      return describeObject(value);
    }

    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
      // `String` on a number, bigint or boolean consults no prototype and runs
      // no user code, so it can neither throw nor reveal anything the value
      // does not already say.
      return `${kind} ${truncate(String(value))}`;
    }

    if (typeof value === 'symbol') {
      // A symbol's description is an own, inert string, and reading it calls no
      // user code. This branch exists separately because interpolating a symbol
      // into a template literal throws at runtime, so the generic path above
      // must never see one.
      const description = value.description;
      return description === undefined || description.length === 0
        ? 'symbol'
        : `symbol ${truncate(description)}`;
    }

    // `undefined` is the only kind left, and its name is the whole of it.
    return kind;
  } catch {
    return kind;
  }
}

/**
 * Describes an object by its constructor name and own key names.
 *
 * Module-private, called only by {@link describeUnexpected} and only from inside
 * its guard, since both the property access and `Object.keys` can throw on a
 * proxy.
 *
 * The constructor name distinguishes a class instance (`DebuggenError`, `Map`),
 * while the key names are what identifies a plain object — which is the common
 * case, because an unhandled union member is normally an object literal off the
 * wire. Keys are sorted so two descriptions of the same shape read the same, and
 * bounded by {@link MAX_DESCRIBED_KEYS} with an explicit ellipsis rather than a
 * silent cut.
 *
 * @param value The object to describe.
 * @returns A description such as `object Object { kind, name, spanId }` or
 * `object Map`.
 */
function describeObject(value: object): string {
  const constructorName = readConstructorName(value);
  const label = constructorName === undefined ? 'object' : `object ${constructorName}`;

  // Plain `sort()` — code-unit order — rather than `localeCompare`: the same
  // shape must describe identically on every machine, and a locale-sensitive
  // comparison is the one part of this that could differ between a developer's
  // laptop and a continuous-integration runner.
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    return label;
  }

  const shown = keys.slice(0, MAX_DESCRIBED_KEYS);
  const suffix = keys.length > shown.length ? ', …' : '';
  return `${label} { ${truncate(shown.join(', '))}${suffix} }`;
}

/**
 * Reads an object's constructor name, when it has a usable one.
 *
 * Module-private. `constructor` is read through a widening type rather than
 * `Object.getPrototypeOf`, because the property is what a subclass overrides and
 * what a plain object inherits; a null-prototype object simply has none, and an
 * anonymous class has an empty name. Both of those answer `undefined`, which the
 * caller renders as the bare kind.
 *
 * @param value The object to inspect.
 * @returns The constructor's name, or `undefined` when there is nothing useful
 * to report.
 */
function readConstructorName(value: object): string | undefined {
  const candidate: unknown = (value as { constructor?: unknown }).constructor;
  if (typeof candidate !== 'function') {
    return undefined;
  }

  const name: unknown = candidate.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Truncates a rendered fragment to {@link MAX_VALUE_PREVIEW_LENGTH} characters.
 *
 * Module-private. The ellipsis is added rather than the text silently cut, so a
 * reader can tell a short value from a long one that was shortened.
 *
 * @param text The already-rendered fragment.
 * @returns `text`, or its first {@link MAX_VALUE_PREVIEW_LENGTH} characters
 * followed by an ellipsis.
 */
function truncate(text: string): string {
  return text.length > MAX_VALUE_PREVIEW_LENGTH
    ? `${text.slice(0, MAX_VALUE_PREVIEW_LENGTH)}…`
    : text;
}
