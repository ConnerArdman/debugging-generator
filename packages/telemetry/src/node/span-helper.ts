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
 *    inside one `invoke` closure with an `invoked` flag, is how that is kept
 *    provable by inspection.
 * 2. **The callback's value is returned unchanged.** Same reference, same
 *    falsiness, not awaited, not wrapped, not cloned. {@link span} is
 *    deliberately **not** `async` and returns `T` rather than `Promise<T>`: an
 *    `async` helper would turn every patched synchronous function in the
 *    developer's project into one that returns a promise.
 * 3. **A returned promise ends the span when it settles.** Detected by
 *    duck-typing (`then` is callable), observed on a *side branch* that carries
 *    both handlers, and the original promise is handed back untouched — so the
 *    caller's own `catch` still runs and this module never manufactures an
 *    unhandled rejection. A synchronous throw records the exception, sets
 *    `ERROR`, ends the span and rethrows the **original** error, preserving its
 *    identity and its stack. `span.end()` happens exactly once per span on
 *    every one of those paths; a second end, or a span never ended, corrupts
 *    the correlated tree the whole product is built on.
 *
 * A fourth rule follows from the first three: **this module never throws an
 * error the application did not throw.** Every interaction with the
 * OpenTelemetry API, with the developer's `meta` object and with the logger is
 * wrapped, and a failure degrades to running the function uninstrumented. A
 * dev server with no telemetry is a correct outcome; a dev server broken by its
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
   * (`warn`) unless the developer sets `DEBUGGEN_LOG_LEVEL` — everything this
   * module logs is `debug`, so the default is silence in someone else's
   * terminal. `register.ts` passes its own logger so every preload line shares
   * one prefix and one threshold.
   */
  readonly logger?: Logger | undefined;
}

/**
 * The property name this module installs on `globalThis`, as one constant.
 *
 * The declaration above and the removal in {@link uninstallSpanHelper} are the
 * only writers of that property, and `Reflect.deleteProperty` needs the name as
 * a string, so the spelling lives here rather than twice as a literal. It is
 * the same spelling `packages/instrumentation/src/patch/wrap-template.ts` emits
 * and `scripts/check-no-residual-instrumentation.mjs` looks for.
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
 * Observe a returned promise **without altering it**.
 *
 * The caller keeps the exact reference the patched function produced, so its
 * own `await`, `then` and `catch` behave as they did before instrumentation.
 * The derived promise created here is a side branch with handlers on both
 * outcomes, each of which swallows, so it always settles fulfilled and can
 * never become an unhandled rejection of this module's making.
 *
 * @param thenable The value the callback returned.
 * @param span The span to end when it settles.
 */
function observeSettlement(thenable: PromiseLike<unknown>, span: Span): void {
  try {
    // Deliberately unawaited: this is an observation, not a link in the
    // caller's chain. `void` states that for the reader and for
    // `@typescript-eslint/no-floating-promises`.
    void thenable.then(
      () => {
        endSpan(span);
      },
      (reason: unknown) => {
        failSpan(span, reason);
      },
    );
  } catch {
    // A thenable whose `then` throws synchronously cannot be observed; close
    // the span now rather than leaving it open for the rest of the process.
    endSpan(span);
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
 * `invoked` flag it sets is what distinguishes "the application function threw"
 * — rethrow, unchanged — from "the context manager threw before the application
 * function ran", where the function still has to run, uninstrumented. There is
 * no path on which `fn` runs twice, and none on which it does not run at all.
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
  let invoked = false;
  const invoke = (): T => {
    invoked = true;
    return fn();
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
    if (!invoked) {
      // The context manager failed before `fn` ran. The application's function
      // still owes its caller a result, so run it outside the span.
      endSpan(started);
      reportTracerFailure(error);
      return invoke();
    }
    failSpan(started, error);
    throw error;
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
 * @param options See {@link InstallSpanHelperOptions}.
 */
export function installSpanHelper(options: InstallSpanHelperOptions = {}): void {
  logger = options.logger ?? createPreloadLogger();
  reportedTracerFailure = false;

  const existing: unknown = globalThis.__DEBUGGEN__;
  if (existing !== undefined && existing === installedHelper) {
    debug('span helper already installed');
    return;
  }
  if (isSpanHelper(existing)) {
    debug('a __DEBUGGEN__ span helper is already present; leaving it in place');
    return;
  }

  const helper = createHelper(existing);
  globalThis.__DEBUGGEN__ = helper;
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
 */
export function uninstallSpanHelper(): void {
  const helper = installedHelper;
  installedHelper = undefined;

  if (helper === undefined) {
    debug('span helper was not installed by this module; nothing to remove');
    return;
  }
  if (globalThis.__DEBUGGEN__ !== helper) {
    debug('__DEBUGGEN__ was replaced after installation; leaving it in place');
    return;
  }

  // `delete globalThis.__DEBUGGEN__` cannot be written against a `var`
  // declaration (TypeScript requires the operand of `delete` to be optional),
  // and removing the property outright is tidier than leaving an `undefined`
  // behind, so the removal goes through `Reflect`. A non-configurable property
  // — nothing creates one, but the global object is shared — falls back to an
  // assignment, which is all the patch template's availability check needs.
  let removed = false;
  try {
    removed = Reflect.deleteProperty(globalThis, DEBUGGEN_GLOBAL_KEY);
  } catch {
    // A refusal leaves `removed` false and takes the assignment below.
  }
  if (!removed) {
    globalThis.__DEBUGGEN__ = undefined;
  }
  debug('span helper removed');
}
