/**
 * `globalThis.__DEBUGGEN__.span` — the **runtime half of the reversible AST
 * patch contract**, in the developer's dev-server process.
 *
 * `packages/instrumentation` plans a `function-timing` or `server-span` action
 * for a named symbol and rewrites that function so its body becomes the
 * template below (AAP §0.5.1, quoted there verbatim):
 *
 * ```ts
 * const __dbg = (globalThis as { __DEBUGGEN__?: __DebuggenSpanHelper }).__DEBUGGEN__;
 * if (__dbg && typeof __dbg.span === 'function')
 *   return __dbg.span(name, meta, () => __orig.apply(this, arguments as never));
 * return __orig.apply(this, arguments as never);
 * ```
 *
 * together with a one-line alias at the top of a patched `.ts`/`.tsx` file, so
 * that a strict target project keeps type-checking without gaining a
 * dependency:
 *
 * ```ts
 * type __DebuggenSpanHelper = {
 *   span<T>(name: string, meta: Record<string, unknown>, fn: () => T): T;
 * };
 * ```
 *
 * This module is the **authoritative definition of that shape**, and
 * `packages/instrumentation/src/patch/wrap-template.ts` is the file that must
 * match it: `packages/instrumentation` sits above `packages/telemetry` in the
 * layering of AAP §0.2.2 and is authored after it, so the template is written
 * against {@link DebuggenSpanHelper} rather than the other way round. Three
 * parameters, in that order, `meta` as `Record<string, unknown>`, a generic
 * return of `T`, and no additional *required* parameter — ever. A fourth
 * argument the template does not pass would leave every patched function in a
 * developer's project calling a function it no longer satisfies.
 *
 * ## The three behavioural guarantees
 *
 * The patch must not change what the application does. Everything else here is
 * detail; these three are the contract, and a future edit that weakens one of
 * them is a defect however tidy it looks:
 *
 * 1. **`fn` is invoked exactly once, on every path.** Including the path where
 *    no tracer provider is registered, the path where a broken provider throws,
 *    and every error path. The template deliberately branches on the helper's
 *    *availability* rather than on its return value — "a `null`/`undefined`
 *    result never re-invokes the body" (AAP §0.5.1) — and this file honours the
 *    other half of that bargain. The single textual `fn(` call site below, held
 *    inside one `invoke` closure that records what the callback did in a
 *    `CallbackOutcome`, is how that is kept provable by inspection.
 * 2. **The callback's value is returned unchanged.** Same reference, same
 *    falsiness, not awaited, not wrapped, not cloned. {@link span} is
 *    deliberately **not** `async` and returns `T` rather than `Promise<T>`: an
 *    `async` helper would turn every patched synchronous function in the
 *    developer's project into one that returns a promise. A callback that
 *    returned successfully hands that value back even when the instrumentation
 *    around it fails afterwards — see the `returned` case in {@link span}.
 * 3. **A returned promise ends the span when it settles.** Detected by
 *    duck-typing (`then` is callable), observed on a *side branch* that carries
 *    both handlers, and the original promise is handed back untouched — so the
 *    caller's own `catch` still runs. The branch's own derived promise is
 *    observed in turn (`sinkDerivedRejections`), because a userland `then` can
 *    return a promise that rejects for reasons our two swallowing handlers know
 *    nothing about, and this module never manufactures an unhandled rejection.
 *    A synchronous throw records the exception, sets `ERROR`, ends the span and
 *    rethrows the **original** error, preserving its identity and its stack.
 *    `span.end()` happens exactly once per span on every one of those paths —
 *    enforced by a flag, since a thenable is free to call both handlers — and a
 *    second end, or a span never ended, corrupts the correlated tree the whole
 *    product is built on.
 *
 * A fourth rule follows from the first three: **this module never throws an
 * error the application did not throw.** Every interaction with the
 * OpenTelemetry API, with the developer's `meta` object, with the shared
 * `globalThis` property and with the logger is wrapped. A failure before the
 * callback ran degrades to running the function uninstrumented; a failure after
 * it returned degrades to reporting the failure and handing back the value the
 * callback produced, because re-running someone's function or replacing their
 * result with an exception would be a worse outcome than lost telemetry. A dev
 * server with no telemetry is a correct outcome; a dev server broken by its
 * debugger never is.
 *
 * ## Why the tracer is resolved per call
 *
 * `trace.getTracer(…)` is called on every invocation and its result is never
 * cached. `control.ts` calls `trace.disable()` when a capture ends and
 * registers a fresh provider when the next one begins (AAP §0.5.1), so a
 * module-level tracer would keep pointing at a provider that has been torn
 * down and would silently stop producing spans after the first cleanup — the
 * kind of failure that only surfaces as "the second capture has no function
 * spans". The API's `ProxyTracer` makes the per-call lookup cheap.
 *
 * Outside a capture the lookup yields a no-op tracer, or a tracer whose gating
 * sampler returns `NOT_RECORD`, and `startSpan` therefore returns a
 * non-recording span. That is the **normal** state, not a failure: nothing here
 * requires a recording span, and the callback runs identically either way.
 *
 * ## Why the span is started in the active context
 *
 * The callback runs inside `context.with(trace.setSpan(context.active(), span),
 * …)`, which is load-bearing for correlation rather than a nicety. Parenting on
 * the active context is what nests a patched service function under whatever
 * Next.js request or route-handler span is in flight, and what makes the Prisma
 * and `pg` spans the function goes on to create children of *it* — the
 * `function` span S5 under route handler S4 with `db.query` S6 beneath it that
 * AAP §0.4.2's correlation sequence requires. The `AsyncLocalStorage` context
 * manager `register()` installs carries that across every `await`.
 *
 * ## Agreement with `convert.ts`
 *
 * A span from this helper becomes a `TelemetryEvent` of kind `function`
 * (`../schema/kinds.ts`). `convert.ts` recognises one two ways, and both ends
 * document the agreement:
 *
 * - **Primary:** the span's instrumentation scope is `(TRACER_NAME,
 *   TRACER_VERSION)` from `./config.ts` — no other tracer in the process has
 *   that name.
 * - **Secondary:** every span carries
 *   `{@link FUNCTION_SPAN_MARKER_KEY}: {@link FUNCTION_SPAN_MARKER_VALUE}`,
 *   which survives a scope the SDK could not report.
 *
 * The rest of a function span's attributes are the declared vocabulary of
 * `FUNCTION_ATTRIBUTE_KEYS` in `../schema/attributes.ts`: `symbol`, `module`
 * and `actionId` arrive in `meta` from the patch, and `async` is written here
 * because only this module knows whether the span ended on a settled promise
 * or on a return.
 *
 * ## Privacy
 *
 * `meta` is generated code from someone else's project, so it is treated as
 * untrusted input: only `string`, `number` and `boolean` values are copied —
 * functions, symbols, objects and arrays are skipped rather than serialised, so
 * a cyclic object or a DOM node can never throw here — strings are scrubbed and
 * truncated to `MAX_PREVIEW_LENGTH`, values under credential-like names are
 * replaced with `REDACTION_MARKER`, and at most `MAX_TRACKED_KEYS` keys are
 * taken. Those two bounds come from `../schema/attributes.ts` and are documented
 * privacy guarantees of AAP §0.5.2, not tuning knobs: argument *values* are
 * never captured wholesale.
 *
 * ## About the `__DEBUGGEN__` marker
 *
 * The literal `__DEBUGGEN__` is deliberate product vocabulary and belongs here:
 * it is the name the patch template emits and therefore the one name this
 * module may install. `scripts/check-no-residual-instrumentation.mjs` greps for
 * it **only under `apps/demo-app`**, where its presence in tracked source would
 * mean a session left instrumentation behind and is a build failure. Its
 * presence in this file is correct and expected.
 *
 * @example Installed by the preload, used by patched code
 * ```ts
 * installSpanHelper({ logger });          // register.ts, once
 * // …the patched function in the developer's project, unchanged semantics:
 * globalThis.__DEBUGGEN__?.span('loadCart', { symbol: 'loadCart' }, () => orig());
 * uninstallSpanHelper();                  // control.ts, on disable
 * ```
 */

import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { AttributeValue, Attributes, Context, Exception, Span } from '@opentelemetry/api';

import { noopLogger } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';

import {
  isSensitiveKeyName,
  REDACTION_MARKER,
  scrubNamedValue,
  truncate,
} from '../redaction/rules.js';
import {
  FUNCTION_ATTRIBUTE_KEYS,
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
} from '../schema/attributes.js';
import type { TelemetryKind } from '../schema/kinds.js';
import { createPreloadLogger, TRACER_NAME, TRACER_VERSION } from './config.js';

/**
 * The shape the patch template calls, and the one member of it that may ever be
 * required.
 *
 * Exported so that `packages/instrumentation/src/patch/wrap-template.ts`, the
 * browser twin (`../browser/span-helper.ts`) and the inserted
 * `type __DebuggenSpanHelper` alias all point at one written definition instead
 * of three hand-copied signatures. The template emits a *structural* copy — a
 * patched project cannot import from this package — so the signature here is
 * the specification, and changing it is a breaking change to every patched
 * function in every project a session has ever touched.
 *
 * `kind` is the single concession to a caller that is not the template: it is
 * optional and defaulted, which keeps a three-argument call site — the only
 * kind the template emits — valid forever.
 */
export interface DebuggenSpanHelper {
  /**
   * Run `fn` as a `function`-kind span, returning exactly what `fn` returned.
   *
   * @param name The span name; the patched symbol's name.
   * @param meta Attribute candidates from the patch: `symbol`, `module`,
   * `actionId`. Treated as untrusted and bounded — see this module's privacy
   * section.
   * @param fn The original function body, invoked exactly once.
   * @param kind An OpenTelemetry span kind; defaults to `INTERNAL`.
   */
  span<T>(name: string, meta: Record<string, unknown>, fn: () => T, kind?: SpanKind): T;
}

declare global {
  /**
   * The helper the patch template reaches for, or `undefined` while no session
   * has armed this process.
   *
   * ⚠️ **One declaration per TypeScript program.** TypeScript requires every
   * declaration of a global `var` to have the *same* type (TS2403), and two
   * structurally identical but separately declared interfaces are not the same
   * type. `../browser/span-helper.ts` installs the same global in the page with
   * additional members, and it must therefore either type its declaration as
   * this exact interface — `import type { DebuggenSpanHelper }` erases at build
   * time, so the agent bundle gains no input — or declare no `var` of its own
   * and reach `globalThis` through a local typed view. It must not write a
   * second, differently typed declaration of this name.
   */
  var __DEBUGGEN__: DebuggenSpanHelper | undefined;
}

/** Options for {@link installSpanHelper}. */
export interface InstallSpanHelperOptions {
  /**
   * Where this module's own diagnostics go.
   *
   * Defaults to `createPreloadLogger()` from `./config.ts`, which is quiet
   * (`warn`) unless the developer sets `DEBUGGEN_LOG_LEVEL`. Almost everything
   * this module logs is `debug`, so the default is silence in someone else's
   * terminal; the exceptions are the genuinely degraded outcomes — a global the
   * helper could not be installed into, and one it could not be removed from or
   * even read back to confirm the removal — which are `warn` precisely because
   * a developer who is not told would spend the session debugging an absence of
   * spans, or believe a product global had gone when it had not. `register.ts`
   * passes its own logger so every preload line shares one prefix and one
   * threshold.
   */
  readonly logger?: Logger | undefined;
}

/**
 * The property name this module installs on `globalThis`, as one constant.
 *
 * `readGlobalHelperSlot`, `globalHelperSlotAcceptsWrite` and
 * `writeGlobalHelperSlot` are the only accessors of that property, and each of
 * them needs the name as a string for `Reflect`, so the spelling lives here
 * rather than four times as a literal. It is the same spelling
 * `packages/instrumentation/src/patch/wrap-template.ts` emits and
 * `scripts/check-no-residual-instrumentation.mjs` looks for.
 */
export const DEBUGGEN_GLOBAL_KEY = '__DEBUGGEN__';

/**
 * Attribute key marking a span as one this product created, carrying the
 * `TelemetryKind` it converts to.
 *
 * The secondary half of the agreement with `convert.ts` described in this
 * module's overview: the instrumentation scope is the primary signal, and this
 * attribute is what still identifies the span if the scope is unavailable. It
 * sits outside the per-kind vocabulary of `../schema/attributes.ts` on purpose
 * — that catalog describes what a *kind* says about itself, not how a span is
 * classified — which is explicitly permitted there, since the catalog "is
 * emphatically not a whitelist".
 */
export const FUNCTION_SPAN_MARKER_KEY = 'debuggen.kind';

/**
 * Value of {@link FUNCTION_SPAN_MARKER_KEY} on every span this helper creates.
 *
 * Annotated as a {@link TelemetryKind} so the compiler rejects a spelling that
 * is not a member of the closed kind vocabulary: `convert.ts` reads this value
 * straight through to `TelemetryEvent.kind`, and a typo would produce an event
 * of a kind nothing renders.
 */
export const FUNCTION_SPAN_MARKER_VALUE: TelemetryKind = 'function';

/**
 * Attribute recording whether the span ended on a settled promise (`true`) or
 * on a plain return (`false`).
 *
 * Written on both paths rather than only the asynchronous one: a missing
 * attribute would be ambiguous, and the flag is what makes an awaited
 * function's duration interpretable (`../schema/attributes.ts`). Typed as a
 * member of `FUNCTION_ATTRIBUTE_KEYS` so this key cannot drift out of the
 * declared `function` vocabulary without a compile error.
 */
const ASYNC_ATTRIBUTE_KEY: (typeof FUNCTION_ATTRIBUTE_KEYS)[number] = 'async';

/**
 * Keys {@link span} owns, and therefore never copies out of `meta`.
 *
 * `meta` is generated code: it may not overwrite the marker that tells
 * `convert.ts` what this span is, nor the asynchrony flag that only this module
 * can determine.
 */
const RESERVED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  FUNCTION_SPAN_MARKER_KEY,
  ASYNC_ATTRIBUTE_KEY,
]);

/**
 * Span name used when the caller supplied nothing usable.
 *
 * An empty or whitespace-only name is not an error worth failing a developer's
 * request over, but an unnamed span is unreadable in a timeline, so it gets a
 * name that says what it is.
 */
const FALLBACK_SPAN_NAME = 'debuggen.function';

/**
 * Message recorded when a thrown value carries nothing usable as one.
 *
 * Deliberately value-free: the value may be anything at all, and describing it
 * would mean stringifying an object whose `toString` we do not control.
 */
const OPAQUE_THROWN_VALUE = 'a non-Error value was thrown';

/**
 * Where this module's diagnostics go, replaced by {@link installSpanHelper}.
 *
 * Starts as `noopLogger` so that nothing is written before the preload has
 * chosen a destination — and so that a helper reached before install (which the
 * global makes impossible, but the module does not depend on that) stays
 * silent.
 */
let logger: Logger = noopLogger;

/**
 * The helper instance this module installed, for identity-tracked removal.
 *
 * {@link uninstallSpanHelper} removes the global only when it still holds
 * *this* object, so a foreign helper installed afterwards is never deleted by
 * our cleanup.
 */
let installedHelper: DebuggenSpanHelper | undefined;

/**
 * Whether the "could not create a span" diagnostic has already been written.
 *
 * A broken provider fails on *every* call, and a patched function can be a hot
 * path, so the diagnostic is written once per install rather than once per
 * call: a debugger that floods the developer's dev-server terminal is its own
 * kind of breakage.
 */
let reportedTracerFailure = false;

/*
 * ---------------------------------------------------------------------------
 * Internals
 *
 * Every function below is total and never throws. That is not defensive
 * habit: each of them runs inside a call the developer's application made, on
 * a stack this module has no right to unwind.
 * ---------------------------------------------------------------------------
 */

/**
 * Write a debug record, swallowing anything the sink does.
 *
 * The logger is injected (`register.ts` passes its own) and its sink is
 * ultimately a `console` method the host application may have replaced, so even
 * logging is wrapped — guarantee four of the module overview admits no
 * exceptions, least of all a diagnostic one.
 *
 * @param message Human-readable, value-free description.
 * @param fields Optional structured context; never a credential.
 */
function debug(message: string, fields?: Record<string, unknown>): void {
  try {
    if (fields === undefined) {
      logger.debug(message);
      return;
    }
    logger.debug(message, fields);
  } catch {
    // A logger that throws must not become an application failure.
  }
}

/**
 * Write a warning record, swallowing anything the sink does.
 *
 * Reserved for the two outcomes that genuinely degrade the session: a global
 * this module could not install into, and a global it could not clean up.
 * Everything else stays at `debug`, because the default preload threshold is
 * `warn` and this module is a guest in someone else's terminal — but a
 * developer whose patched functions will silently produce no spans has to be
 * told, or they debug the absence instead of their application.
 *
 * @param message Human-readable, value-free description.
 * @param fields Optional structured context; never a credential, and never the
 * value found on the global.
 */
function warn(message: string, fields?: Record<string, unknown>): void {
  try {
    if (fields === undefined) {
      logger.warn(message);
      return;
    }
    logger.warn(message, fields);
  } catch {
    // A logger that throws must not become an application failure.
  }
}

/**
 * Report, once per install, that a span could not be created.
 *
 * @param error Whatever the OpenTelemetry API threw.
 */
function reportTracerFailure(error: unknown): void {
  if (reportedTracerFailure) {
    return;
  }
  reportedTracerFailure = true;
  debug('could not create a function span; running the patched function uninstrumented', {
    error,
  });
}

/**
 * Whether a value is a thenable, by duck-typing rather than by constructor.
 *
 * A patched function may return a native promise, a userland promise
 * implementation, or a non-promise object that happens to expose `then` — and
 * the observation below behaves correctly for all three. Reading `then` can
 * itself throw (a getter, an exotic proxy), which is treated as "not a
 * thenable" rather than allowed to escape.
 *
 * @param value The value the callback returned.
 * @returns `true` when the span should end on settlement rather than on return.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  try {
    return typeof (value as { readonly then?: unknown }).then === 'function';
  } catch {
    // A hostile or half-constructed object is simply not observable.
    return false;
  }
}

/**
 * End a span, once, whatever the SDK does about it.
 *
 * @param span The span to close.
 */
function endSpan(span: Span): void {
  try {
    span.end();
  } catch {
    // A span that cannot be ended is lost telemetry, not an application error.
  }
}

/**
 * Convert a thrown value into something `recordException` accepts.
 *
 * An `Error` is passed through so its message and stack reach the exception
 * event intact; anything else is reduced to a message. Redaction of exception
 * fields happens on the ingest path (`apps/local-service/src/telemetry/ingest.ts`,
 * AAP §0.5.2) rather than here, so this function neither scrubs nor truncates —
 * it only refuses to stringify a value whose `toString` it does not control.
 *
 * @param error The caught value, of any type.
 * @returns An OpenTelemetry {@link Exception}.
 */
function toException(error: unknown): Exception {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return { message: String(error) };
  }
  if (typeof error === 'object' && error !== null) {
    try {
      const message = (error as { readonly message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) {
        return { message };
      }
    } catch {
      // A throwing `message` getter falls through to the opaque message.
    }
  }
  return { message: OPAQUE_THROWN_VALUE };
}

/**
 * Record a failure on a span and end it, exactly once.
 *
 * The status carries no message on purpose: the exception event already holds
 * the detail, and a second copy of an application error string is a second
 * thing to redact.
 *
 * @param span The span to fail.
 * @param error The thrown value or rejection reason.
 */
function failSpan(span: Span, error: unknown): void {
  try {
    span.recordException(toException(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
  } catch {
    // Fall through to `endSpan`: an unended span is worse than an unstatused one.
  }
  endSpan(span);
}

/**
 * Set one attribute on a span, ignoring an SDK that refuses it.
 *
 * @param span The span to annotate.
 * @param key Attribute key.
 * @param value Attribute value.
 */
function setSpanAttribute(span: Span, key: string, value: AttributeValue): void {
  try {
    span.setAttribute(key, value);
  } catch {
    // An attribute the SDK rejects is missing detail, nothing more.
  }
}

/**
 * Terminal handler for a promise this module derived rather than received.
 *
 * Intentionally empty, and installed on *both* outcomes: the derived value
 * exists only because observing the application's promise created it, so
 * neither its value nor its rejection is the application's — and a userland
 * `then` that calls its first argument without checking it is callable must not
 * be handed `undefined`.
 */
function swallowDerivedSettlement(): void {
  // Nothing to do, by design: this is the last handler in a chain of our own
  // making, and its only job is to leave no rejection unobserved.
}

/**
 * Whether a thenable is a native promise still using the built-in `then`.
 *
 * Load-bearing for {@link sinkDerivedRejections}: `Promise.prototype.then`
 * rejects its derived promise only when one of the handlers passed to it
 * throws, and {@link swallowDerivedSettlement} cannot throw. Attaching that
 * pair to an intrinsic promise therefore yields a value that provably never
 * rejects, which is what makes one call terminal — nothing further is
 * allocated on the path patched functions take on every asynchronous call.
 *
 * @param value A thenable, already duck-typed by {@link isThenable}.
 * @returns `true` only for a genuine promise whose `then` is the intrinsic one.
 */
function isIntrinsicPromise(value: PromiseLike<unknown>): boolean {
  try {
    const then: unknown = (value as { readonly then?: unknown }).then;
    return value instanceof Promise && then === Promise.prototype.then;
  } catch {
    // A proxy with a throwing `getPrototypeOf` trap, or a throwing `then`
    // getter, is not an object whose behaviour may be assumed.
    return false;
  }
}

/**
 * Attach a terminal, provably non-rejecting observer to a value this module
 * derived.
 *
 * `thenable.then(…)` returns a *new* value, and for a userland promise
 * implementation that value is whatever its `then` chose to produce —
 * including a promise that rejects for reasons of its own, independently of
 * the two swallowing handlers {@link observeSettlement} attached. Nothing
 * observes that derived value unless this module does, and an unobserved
 * rejection is fatal to the process under Node's default
 * `--unhandled-rejections=throw`: dropping it would mean instrumentation
 * manufacturing the crash of a dev server that was working.
 *
 * So this function always terminates, and only in a state where what it holds
 * can reject nothing. There are exactly three, no loop and no hop budget:
 *
 * 1. **Not a thenable.** There is nothing that can reject and nothing to
 *    attach to.
 * 2. **An intrinsic promise** ({@link isIntrinsicPromise}). One
 *    `then(swallow, swallow)` through the built-in `then`, whose derived
 *    promise rejects only if a handler throws — and neither handler can. The
 *    common case, an `async` application function returning a native promise,
 *    ends here one call deep and allocates nothing beyond it.
 * 3. **Anything else**, which is a foreign thenable. It is *adopted* by a
 *    native promise rather than walked another hop: resolving a native promise
 *    with a thenable makes the runtime read and call that thenable's `then`
 *    and settle the native promise from it, so a rejection of the foreign
 *    chain — or a `then` that throws, or a `then` getter that throws, all of
 *    which the specification turns into a rejection rather than an exception —
 *    becomes the rejection of an *intrinsic* promise, which case 2's handler
 *    pair then settles for good. One bounded step, terminal whatever the
 *    foreign implementation does with its own derived values: a `then` that
 *    hands back a fresh rejecting thenable every time cannot outrun a single
 *    adoption, which is why the hop budget this function used to carry is gone
 *    rather than raised.
 *
 * The adoption is `new Promise((resolve) => resolve(value))` and deliberately
 * **not** `Promise.resolve(value)`: the latter hands *the same object* straight
 * back when the value is a native promise whose own `then` has been replaced
 * (a zone-patched or otherwise instrumented runtime does exactly that), and
 * attaching to that object would call the replacement `then` and leave us
 * holding an unobserved derived value again. The constructor always yields a
 * fresh intrinsic promise.
 *
 * The application's own promise is never passed here: this sees only the side
 * branch {@link observeSettlement} created, so nothing about the caller's
 * settlement, timing or handler set changes. Both attachments are wrapped,
 * because reaching a `then` at all means touching someone else's object.
 *
 * @param value The value a `then` call returned; usually a promise, possibly
 * something a non-conforming implementation made up.
 */
function sinkDerivedRejections(value: unknown): void {
  if (!isThenable(value)) {
    // A `then` that returned a plain value has nothing left that can reject.
    return;
  }
  try {
    if (isIntrinsicPromise(value)) {
      // Deliberately discarded rather than kept: the built-in `then` with two
      // handlers that cannot throw returns a promise that cannot reject, so
      // this is the end of the chain — nothing is left for this module to
      // observe, and `void` says so for the reader and for
      // `@typescript-eslint/no-floating-promises`.
      void value.then(swallowDerivedSettlement, swallowDerivedSettlement);
      return;
    }
    // Adoption, not another hop: `resolve` reads and calls the foreign `then`
    // itself and turns everything it can do — reject, throw, throw from its
    // getter, or produce yet another thenable — into the settlement of this
    // intrinsic promise.
    const adopted: Promise<unknown> = new Promise<unknown>((resolve) => {
      resolve(value);
    });
    // Terminal for exactly the reason the intrinsic branch above is.
    void adopted.then(swallowDerivedSettlement, swallowDerivedSettlement);
  } catch {
    // Reaching either `then` meant reading a property off an object this
    // module does not own, and the adoption needs the intrinsic `Promise`
    // constructor to be intact. A failure here means there is nothing left to
    // attach to, which is the one acceptable stopping point: what could not be
    // reached was never this module's to observe. The span is unaffected — it
    // was already closed by whichever handler ran, or will be.
  }
}

/**
 * Observe a returned promise **without altering it**.
 *
 * The caller keeps the exact reference the patched function produced, so its
 * own `await`, `then` and `catch` behave as they did before instrumentation.
 * The derived promise created here is a side branch with handlers on both
 * outcomes, each of which swallows, so it never rejects of its own accord — and
 * the value that branch produces is itself sunk by
 * {@link sinkDerivedRejections}, because a userland `then` can return a promise
 * that rejects for reasons those handlers know nothing about. Between the two,
 * this module leaves no rejection of its own making unobserved.
 *
 * @param thenable The value the callback returned.
 * @param span The span to end when it settles.
 */
function observeSettlement(thenable: PromiseLike<unknown>, span: Span): void {
  // A badly behaved userland thenable may call both handlers, or one of them
  // twice. "`span.end()` exactly once per span" is a stated guarantee of this
  // module, so it is enforced here rather than left to the SDK's own internal
  // guard, which is an implementation detail of whichever span this is.
  let settled = false;
  try {
    // The value `then` returns is kept rather than discarded: it is a promise
    // of this module's making, and an unobserved rejection on it would be a
    // crash instrumentation caused. Not `void`-ed, so there is no floating
    // promise for `@typescript-eslint/no-floating-promises` to flag either.
    const derived: unknown = thenable.then(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        endSpan(span);
      },
      (reason: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        failSpan(span, reason);
      },
    );
    sinkDerivedRejections(derived);
  } catch {
    // A thenable whose `then` throws synchronously cannot be observed; close
    // the span now rather than leaving it open for the rest of the process,
    // unless a handler already ran before the throw.
    if (!settled) {
      settled = true;
      endSpan(span);
    }
  }
}

/**
 * Normalise a span name.
 *
 * The `typeof` check is not redundant in practice: the caller is generated code
 * in a project that may not be type-checked at all, and an untyped call site
 * can pass anything.
 *
 * @param name The name the patch template supplied.
 * @returns A non-empty name, bounded by {@link MAX_PREVIEW_LENGTH}.
 */
function spanNameFor(name: string): string {
  if (typeof name !== 'string') {
    return FALLBACK_SPAN_NAME;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return FALLBACK_SPAN_NAME;
  }
  return truncate(trimmed, MAX_PREVIEW_LENGTH);
}

/**
 * Convert one `meta` entry into an attribute value, or skip it.
 *
 * Only the three primitive types an attribute can hold are copied. Strings are
 * scrubbed **before** being truncated — the order is part of `rules.ts`'s
 * contract, because cutting first can leave a credential half-matched and
 * therefore unreplaced — and a value under a credential-like name is replaced
 * whole regardless of its type, keeping the key's presence while hiding what it
 * held. Non-finite numbers are dropped: `NaN` and `Infinity` have no JSON form,
 * and this attribute is destined for an ingest payload.
 *
 * @param key The key the value was supplied under.
 * @param value The raw value from `meta`.
 * @returns An attribute value, or `undefined` to skip the entry entirely.
 */
function toAttributeValue(key: string, value: unknown): AttributeValue | undefined {
  if (typeof value === 'string') {
    return truncate(scrubNamedValue(key, value), MAX_PREVIEW_LENGTH);
  }
  if (typeof value === 'boolean') {
    return isSensitiveKeyName(key) ? REDACTION_MARKER : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return isSensitiveKeyName(key) ? REDACTION_MARKER : value;
  }
  // Functions, symbols, bigints, objects and arrays are skipped rather than
  // serialised: a cyclic object, a DOM node or a proxy must not be able to
  // throw on the application's stack, and an argument's *value* is not ours to
  // capture (AAP §0.5.2).
  return undefined;
}

/**
 * Build the attribute set for a span from the patch's `meta` object.
 *
 * Always carries the marker of {@link FUNCTION_SPAN_MARKER_KEY}, then at most
 * {@link MAX_TRACKED_KEYS} entries from `meta`. The whole walk is wrapped: an
 * exotic `meta` (a proxy with a throwing `ownKeys` or getter) yields whatever
 * was collected before it misbehaved rather than an exception.
 *
 * @param meta The object the patch template passed; typed `unknown` because
 * generated code in an unchecked project may pass anything.
 * @returns Attributes to start the span with.
 */
function toSpanAttributes(meta: unknown): Attributes {
  const attributes: Attributes = { [FUNCTION_SPAN_MARKER_KEY]: FUNCTION_SPAN_MARKER_VALUE };
  if (typeof meta !== 'object' || meta === null) {
    return attributes;
  }
  let copied = 0;
  try {
    for (const key of Object.keys(meta)) {
      if (copied >= MAX_TRACKED_KEYS) {
        break;
      }
      if (key.length === 0 || RESERVED_ATTRIBUTE_KEYS.has(key)) {
        continue;
      }
      const attribute = toAttributeValue(key, (meta as Record<string, unknown>)[key]);
      if (attribute === undefined) {
        continue;
      }
      attributes[truncate(key, MAX_PREVIEW_LENGTH)] = attribute;
      copied += 1;
    }
  } catch {
    // A hostile `meta` contributes what it managed to before it threw.
  }
  return attributes;
}

/**
 * The outcome of one guarded read of `globalThis.__DEBUGGEN__`.
 *
 * Tagged rather than a bare `unknown`, because "the slot holds `undefined`"
 * and "the slot could not be read" are different facts and only the first is
 * evidence of anything: a throwing accessor that yields nothing is not a slot
 * that was successfully emptied. Collapsing the two into one `undefined` is
 * what let {@link writeGlobalHelperSlot} report a write of `undefined` as
 * verified when its verification read had in fact thrown, and
 * {@link uninstallSpanHelper} report a removal it had not achieved. Every call
 * site now has to decide what an unreadable slot means for it, and each of the
 * three does so explicitly.
 */
type GlobalSlotRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * Read `globalThis.__DEBUGGEN__` without trusting the global object.
 *
 * The global is shared with the developer's application, its framework and
 * anything else loaded into the dev-server process. Any of them may have
 * defined this name as an accessor, and a getter that throws would otherwise
 * take the preload — and the dev server with it — down from inside a property
 * read. What the failure *means* is not decided here: this function reports
 * only whether the read succeeded, and the callers differ — the install treats
 * an unreadable slot as an absent one and lets the write be judged, while the
 * write and the uninstall treat it as a failed verification.
 *
 * @returns `{ ok: true, value }` carrying whatever the property yielded, or
 * `{ ok: false }` when reading it threw.
 */
function readGlobalHelperSlot(): GlobalSlotRead {
  try {
    return { ok: true, value: globalThis.__DEBUGGEN__ };
  } catch {
    // A throwing accessor on the global tells us nothing about what is there.
    return { ok: false };
  }
}

/**
 * Whether the global slot can be made to hold a value of ours at all.
 *
 * Checked *before* attempting a write so that a refusal is reported as one
 * rather than discovered as a thrown `TypeError` on the application's stack: in
 * ESM strict mode an assignment to a non-writable data property, or to an
 * accessor with no setter, throws. Two shapes cannot be satisfied, and both are
 * final because a non-configurable property cannot be redefined:
 *
 * - a data property with `writable: false` and `configurable: false`;
 * - an accessor with no `set` and `configurable: false`.
 *
 * Everything else is attemptable. A `writable: false` but *configurable* data
 * property is not a refusal: {@link writeGlobalHelperSlot} redefines it through
 * `Reflect.defineProperty`, which succeeds where an assignment would have
 * thrown — so the helper installs where the previous assignment-based code
 * crashed. An accessor with a setter is attemptable too, and the verification
 * read is what decides whether the setter actually kept the value.
 *
 * @returns `true` when a write may be attempted.
 */
function globalHelperSlotAcceptsWrite(): boolean {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(globalThis, DEBUGGEN_GLOBAL_KEY);
  } catch {
    // A global whose descriptor cannot even be read is not one to write to.
    return false;
  }
  if (descriptor === undefined) {
    // Absent: only a non-extensible global object can refuse the definition,
    // and `Object.isExtensible` is the one question left to ask.
    try {
      return Object.isExtensible(globalThis);
    } catch {
      return false;
    }
  }
  if (descriptor.configurable === true) {
    return true;
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return typeof descriptor.set === 'function';
  }
  return descriptor.writable === true;
}

/**
 * Write the global slot through `Reflect`, and confirm the write took.
 *
 * `Reflect.defineProperty` is used rather than an assignment because it reports
 * a refusal by returning `false` instead of throwing, and because the four
 * attributes below reproduce exactly what the assignment this replaced created
 * for a new property — a writable, enumerable, configurable data property — so
 * nothing observable about the installed global changes. `Reflect.set` is the
 * fallback for the one case where defining is wrong: a property whose owner
 * installed a setter, which is entitled to see the value.
 *
 * The verification read is not belt-and-braces. A setter may transform or
 * discard what it is given, and a host may refuse a definition for reasons no
 * descriptor shows; identity is the only proof that a patched function reaching
 * for this global will find our helper. A read that *fails* proves nothing and
 * is therefore a failed verification — including, and especially, when the
 * value being written is `undefined`, where a thrown getter would otherwise
 * look exactly like a slot successfully cleared.
 *
 * @param value The value the slot should hold afterwards.
 * @returns `true` only when the slot can be read back and yields exactly
 * `value`.
 */
function writeGlobalHelperSlot(value: DebuggenSpanHelper | undefined): boolean {
  let defined = false;
  try {
    defined = Reflect.defineProperty(globalThis, DEBUGGEN_GLOBAL_KEY, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Some hosts throw from `defineProperty` where the specification returns
    // false; either way the fallback below is what is left to try.
  }
  if (!defined) {
    try {
      Reflect.set(globalThis, DEBUGGEN_GLOBAL_KEY, value);
    } catch {
      // `Reflect.set` returns false rather than throwing for an ordinary
      // refusal; a throw here comes from a setter of someone else's, and the
      // verification below is what turns either into a reported refusal.
    }
  }
  const readBack = readGlobalHelperSlot();
  return readBack.ok && readBack.value === value;
}

/**
 * Whether a value already satisfies the patch contract at runtime.
 *
 * The same test the patch template performs — `typeof value.span === 'function'`
 * — so that "a helper is already present" means exactly what a patched function
 * would conclude.
 *
 * @param value A candidate `globalThis.__DEBUGGEN__`.
 */
function isSpanHelper(value: unknown): value is DebuggenSpanHelper {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  try {
    return typeof (value as { readonly span?: unknown }).span === 'function';
  } catch {
    return false;
  }
}

/**
 * Build the helper object, carrying over a foreign global's own members.
 *
 * A value sitting at `globalThis.__DEBUGGEN__` that does not expose a callable
 * `span` is not a helper, but it may still be something's state — the browser
 * twin, for instance, keeps its agent configuration on the same global. Copying
 * its own enumerable properties across means installing the helper adds a
 * capability instead of destroying one.
 *
 * @param existing Whatever occupied the global, if anything.
 * @returns A fresh helper whose `span` is {@link span}.
 */
function createHelper(existing: unknown): DebuggenSpanHelper {
  const carried: Record<string, unknown> = {};
  if (existing !== null && typeof existing === 'object') {
    try {
      for (const key of Object.keys(existing)) {
        if (key === 'span') {
          continue;
        }
        carried[key] = (existing as Record<string, unknown>)[key];
      }
    } catch {
      // An unreadable foreign object is simply not carried over.
    }
  }
  return { ...carried, span };
}

/**
 * What the application's callback did, recorded at the single `fn(` call site.
 *
 * `undefined` — the variable's initial value — means the callback has not run
 * yet, which is the only state in which {@link span} may still invoke it. The
 * two members then tell the two *successful observations* apart from each
 * other: `returned` carries the value by reference (never re-derived, never
 * awaited), `threw` carries the thrown value itself so its identity and stack
 * can be handed back to the application unchanged.
 *
 * Why a record rather than a boolean: `context.with` can fail *after* the
 * callback returned — its own cleanup, restoring the previous context, is code
 * this module does not own. A boolean "did it run" cannot distinguish that from
 * "the application threw", and reporting a successful call as a failure would
 * break both the second and the fourth guarantee of the module overview at
 * once: the caller would lose the value it produced *and* receive an error it
 * never threw.
 */
type CallbackOutcome<T> =
  | { readonly state: 'returned'; readonly value: T }
  | { readonly state: 'threw'; readonly error: unknown };

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Run `fn` as a `function`-kind span and return exactly what it returned.
 *
 * This is the function installed at `globalThis.__DEBUGGEN__.span`, exported so
 * the preload and its tests can reach it without going through the global. It
 * upholds the three guarantees of the module overview; read those before
 * changing anything here.
 *
 * The one textual `fn(` call site in this file is inside `invoke`, and the
 * {@link CallbackOutcome} it records is what tells the three ways a `catch`
 * around `context.with` can be reached apart:
 *
 * - **No outcome** — the context manager threw before the application function
 *   ran. The orphan span is ended, the tracer failure is reported once, and the
 *   function still has to run, uninstrumented: that is its first and only
 *   invocation.
 * - **`threw`** — the application function failed. The span records *its*
 *   error and the same error object is rethrown, so identity and stack are the
 *   application's. If what `context.with` rethrew is not that error, the
 *   difference is an instrumentation failure and is reported before the
 *   application's error goes back up.
 * - **`returned`** — the application function succeeded and `context.with`'s
 *   own cleanup failed afterwards. **That must never surface as an application
 *   failure.** The instrumentation failure is reported once and the stored
 *   value continues down the normal completion path, so the thenable check, the
 *   `async` attribute and the single `span.end()` all still happen and the
 *   caller receives exactly the value its function produced.
 *
 * There is no path on which `fn` runs twice, and none on which it does not run
 * at all.
 *
 * @param name The patched symbol's name; becomes the span name.
 * @param meta Attribute candidates from the patch (`symbol`, `module`,
 * `actionId`), treated as untrusted and bounded.
 * @param fn The original function body. Invoked exactly once.
 * @param kind Span kind; defaults to `SpanKind.INTERNAL`. The patch template
 * passes exactly three arguments, so this parameter is optional forever.
 * @returns `fn`'s return value, by reference and unmodified.
 * @throws Whatever `fn` throws, with its identity and stack preserved. Nothing
 * else — no failure of this module's own is ever surfaced to the caller.
 */
export function span<T>(
  name: string,
  meta: Record<string, unknown>,
  fn: () => T,
  kind: SpanKind = SpanKind.INTERNAL,
): T {
  let outcome: CallbackOutcome<T> | undefined;
  const invoke = (): T => {
    try {
      const value = fn();
      outcome = { state: 'returned', value };
      return value;
    } catch (error) {
      // Recorded and rethrown, not handled: the application's error keeps
      // travelling up its own stack, and the record is what stops a later
      // instrumentation failure from being mistaken for this one.
      outcome = { state: 'threw', error };
      throw error;
    }
  };

  // Resolved per call, never cached: see "Why the tracer is resolved per call".
  let started: Span | undefined;
  let scope: Context | undefined;
  try {
    started = trace
      .getTracer(TRACER_NAME, TRACER_VERSION)
      .startSpan(spanNameFor(name), { kind, attributes: toSpanAttributes(meta) });
    scope = trace.setSpan(context.active(), started);
  } catch (error) {
    // A provider that throws on `startSpan`, or a context API that cannot hold
    // the span, must not reach the application. Close an orphan span if one was
    // created before the failure, then continue uninstrumented.
    if (started !== undefined) {
      endSpan(started);
    }
    started = undefined;
    scope = undefined;
    reportTracerFailure(error);
  }

  if (started === undefined || scope === undefined) {
    return invoke();
  }

  let result: T;
  try {
    // The active context is the parent, which is what nests this span under the
    // request and route-handler spans and makes the Prisma/pg spans the callback
    // creates children of it.
    result = context.with(scope, invoke);
  } catch (error) {
    // Read once into a constant: `outcome` is written from a closure, and the
    // branches below must all reason about the same observation.
    const recorded = outcome;
    if (recorded === undefined) {
      // The context manager failed before `fn` ran. The application's function
      // still owes its caller a result, so run it outside the span.
      endSpan(started);
      reportTracerFailure(error);
      return invoke();
    }
    if (recorded.state === 'threw') {
      if (error !== recorded.error) {
        // The callback's error was swallowed or replaced on the way out of
        // `context.with`; that substitution is ours to report, not the
        // application's to receive.
        reportTracerFailure(error);
      }
      failSpan(started, recorded.error);
      throw recorded.error;
    }
    // The callback succeeded and only the context manager's own cleanup failed.
    // Guarantee four: that is this module's failure, so it is reported here and
    // the call continues through the normal completion path below with the
    // value `fn` produced — which is also the only way the span still gets its
    // `async` attribute and its single `end()`.
    reportTracerFailure(error);
    result = recorded.value;
  }

  if (isThenable(result)) {
    setSpanAttribute(started, ASYNC_ATTRIBUTE_KEY, true);
    observeSettlement(result, started);
    return result;
  }

  setSpanAttribute(started, ASYNC_ATTRIBUTE_KEY, false);
  endSpan(started);
  return result;
}

/**
 * Install {@link span} at `globalThis.__DEBUGGEN__`, idempotently.
 *
 * Called by `register.ts` while the preload boots, before the developer's
 * application code runs, so that a function patched at any point during the
 * session finds the helper already there. Installing is cheap and involves no
 * I/O: whether a span is actually recorded is decided later, per call, by
 * whichever provider is registered at the time.
 *
 * Three cases, in order:
 *
 * 1. The global already holds *this module's* helper — nothing to do.
 * 2. The global holds some other value that already exposes a callable `span` —
 *    left exactly as it is, and logged at debug level. A second copy of the
 *    preload in one process, or a twin that got there first, must not have its
 *    helper swapped out from under the functions already patched against it.
 * 3. Anything else (absent, or a non-conforming value) — the helper is
 *    installed, carrying over the own members of a non-conforming object so
 *    nothing is destroyed.
 *
 * Every read and every write of that property is guarded, and a global this
 * module cannot install into is a *refusal*, not an exception: one `warn`
 * naming the consequence — patched functions run uninstrumented — and no
 * ownership recorded, so a later {@link uninstallSpanHelper} cannot touch a
 * value this module does not own. The property is left exactly as its owner
 * defined it, and the session degrades to having no function spans, which is a
 * correct outcome where crashing the developer's dev server never is.
 *
 * @param options See {@link InstallSpanHelperOptions}.
 */
export function installSpanHelper(options: InstallSpanHelperOptions = {}): void {
  logger = options.logger ?? createPreloadLogger();
  reportedTracerFailure = false;

  // An unreadable slot is treated as an absent one: a throwing accessor
  // proves nothing either way, and treating it as absent is what lets the
  // install attempt proceed and be judged on whether the *write* took —
  // `globalHelperSlotAcceptsWrite` and the verified write below are what
  // decide, and both of them report a refusal rather than assuming one.
  const slot = readGlobalHelperSlot();
  const existing: unknown = slot.ok ? slot.value : undefined;
  if (existing !== undefined && existing === installedHelper) {
    debug('span helper already installed');
    return;
  }
  if (isSpanHelper(existing)) {
    debug('a __DEBUGGEN__ span helper is already present; leaving it in place');
    return;
  }

  if (!globalHelperSlotAcceptsWrite()) {
    warn(
      'the __DEBUGGEN__ global is not writable in this process; patched functions will run uninstrumented and produce no function spans',
      { property: DEBUGGEN_GLOBAL_KEY },
    );
    return;
  }

  const helper = createHelper(existing);
  if (!writeGlobalHelperSlot(helper)) {
    // The descriptor allowed an attempt and the attempt did not take: a setter
    // that kept something else, or a host that refused the definition anyway.
    warn(
      'the __DEBUGGEN__ span helper could not be installed on the global; patched functions will run uninstrumented and produce no function spans',
      { property: DEBUGGEN_GLOBAL_KEY },
    );
    return;
  }
  installedHelper = helper;
  debug('span helper installed', { tracer: TRACER_NAME, version: TRACER_VERSION });
}

/**
 * Remove the helper this module installed, if it is still the one in place.
 *
 * The disable path of `control.ts` may call this when a session ends. It is not
 * what makes cleanup safe — a patched function whose helper has gone still runs
 * its original body, because the template branches on availability — but it
 * leaves the process without a product global once there is nothing to record.
 *
 * Identity-tracked in both directions: a helper installed by someone else is
 * never removed, and a global replaced after our install is left alone. Calling
 * this without a preceding install, or twice, is a no-op.
 *
 * Removal never throws, and never claims a success it cannot demonstrate.
 * `span helper removed` is logged only where a *successful* read proves the
 * helper is no longer what the global yields; the two outcomes where that
 * proof cannot be obtained each produce exactly one value-free `warn` and a
 * normal return, because an unreported failed cleanup is how a developer ends
 * up with a product global they were told had gone:
 *
 * - **The slot cannot be read at all.** Identity cannot be established, so the
 *   property is left exactly as its owner defined it — deleting one this
 *   module cannot prove is its own would destroy someone else's — and the
 *   unverifiable state is reported.
 * - **The deletion was refused or unverifiable and the guarded write did not
 *   verify either.** What remains is the helper this module installed, still
 *   functional and still harmless: outside a capture `trace.getTracer` yields
 *   a non-recording span, so a patched function costs a lookup and records
 *   nothing.
 */
export function uninstallSpanHelper(): void {
  const helper = installedHelper;
  installedHelper = undefined;

  if (helper === undefined) {
    debug('span helper was not installed by this module; nothing to remove');
    return;
  }

  const before = readGlobalHelperSlot();
  if (!before.ok) {
    // Nothing can be concluded from a throwing accessor, and the second
    // direction of identity tracking — never touch a value that is not ours —
    // cannot be satisfied without reading it. Leave the property alone and say
    // so: this is a cleanup whose outcome is genuinely unknown.
    warn(
      'the __DEBUGGEN__ global could not be read, so removal of the span helper could not be confirmed; the property is left exactly as it stands',
      { property: DEBUGGEN_GLOBAL_KEY },
    );
    return;
  }
  if (before.value !== helper) {
    debug('__DEBUGGEN__ was replaced after installation; leaving it in place');
    return;
  }

  // `delete globalThis.__DEBUGGEN__` cannot be written against a `var`
  // declaration (TypeScript requires the operand of `delete` to be optional),
  // and removing the property outright is tidier than leaving an `undefined`
  // behind, so the removal goes through `Reflect`. A non-configurable property
  // — nothing here creates one, but the global object is shared — falls back to
  // the same guarded write the install uses, which is all the patch template's
  // availability check needs.
  let removed = false;
  try {
    removed = Reflect.deleteProperty(globalThis, DEBUGGEN_GLOBAL_KEY);
  } catch {
    // A refusal leaves `removed` false and takes the guarded write below.
  }
  if (removed) {
    const after = readGlobalHelperSlot();
    if (after.ok && after.value !== helper) {
      debug('span helper removed');
      return;
    }
    // The deletion reported success, but the slot still yields our helper (an
    // inherited property took the name over) or can no longer be read at all.
    // Either way the removal is unproven, so the guarded write below is what
    // is left to try — and its own verification decides.
  }
  if (writeGlobalHelperSlot(undefined)) {
    debug('span helper removed');
    return;
  }
  warn(
    'the __DEBUGGEN__ span helper could not be removed from the global; it stays in place and records nothing outside a capture',
    { property: DEBUGGEN_GLOBAL_KEY },
  );
}
