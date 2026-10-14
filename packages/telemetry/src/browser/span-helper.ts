/**
 * `globalThis.__DEBUGGEN__` **in the page** — the browser twin of
 * `../node/span-helper.ts`, and the runtime half of the reversible AST patch
 * contract on the front end.
 *
 * `packages/instrumentation` plans a `function-timing` action for a named
 * symbol and rewrites that function so its body becomes the template below
 * (AAP §0.5.1, quoted there verbatim):
 *
 * ```ts
 * const __dbg = (globalThis as { __DEBUGGEN__?: __DebuggenSpanHelper }).__DEBUGGEN__;
 * if (__dbg && typeof __dbg.span === 'function')
 *   return __dbg.span(name, meta, () => __orig.apply(this, arguments as never));
 * return __orig.apply(this, arguments as never);
 * ```
 *
 * together with a one-line alias at the top of a patched `.ts`/`.tsx` file so a
 * strict target project keeps type-checking without gaining a dependency:
 *
 * ```ts
 * type __DebuggenSpanHelper = {
 *   span<T>(name: string, meta: Record<string, unknown>, fn: () => T): T;
 * };
 * ```
 *
 * `../node/span-helper.ts` is the **authoritative** statement of that shape and
 * {@link BrowserSpanHelper} is assignable to it: three parameters in that
 * order, `meta` as `Record<string, unknown>`, a generic return of `T`, and no
 * additional *required* parameter — ever. The extra members here
 * ({@link BrowserSpanHelper.version}, {@link BrowserSpanHelper.config},
 * {@link BrowserSpanHelper.describeTarget}) are additions the page needs and
 * the template never touches.
 *
 * ## The four behavioural guarantees
 *
 * The patch must not change what the application does; a patched page that
 * behaves differently is the one failure this product cannot afford. Everything
 * else in this file is detail, and an edit that weakens one of these is a
 * defect however tidy it looks:
 *
 * 1. **`fn` is invoked exactly once, on every path** — dormant, enabled,
 *    degraded, and every error path. The template branches on the helper's
 *    *availability* rather than on its return value, so "a `null`/`undefined`
 *    result never re-invokes the body" (AAP §0.5.1); this file honours the
 *    other half of that bargain. The single textual `fn()` call site below,
 *    inside one `invoke` closure guarded by an `invoked` flag, is what keeps
 *    that provable by inspection.
 * 2. **The callback's value is returned unchanged** — same reference, same
 *    falsiness, never awaited, wrapped, cloned or coerced. {@link span} is
 *    deliberately **not** `async`: an `async` helper would turn every patched
 *    synchronous function in the developer's project into one that returns a
 *    promise.
 * 3. **A returned promise ends the span when it settles**, observed on a *side
 *    branch* that carries both handlers, with the original promise handed back
 *    untouched — so the caller's own `catch` still runs and this module never
 *    manufactures an `unhandledrejection` the page did not have. The branch is
 *    *terminated* on promise machinery captured at `document_start`
 *    ({@link NATIVE_PROMISE}), because the promise the application's `then`
 *    derives belongs to the application's implementation and can reject on its
 *    own; see {@link observeSettlement}. A synchronous throw rethrows the
 *    **original** error, preserving its identity and stack, and records the
 *    error's `name` and nothing else (AAP §0.5.2 keeps values out: no message,
 *    no stack, no arguments).
 * 4. **This module never throws an error the application did not throw.**
 *    Every interaction with the clock, with the id generator, with the
 *    developer's `meta` object and with the transport is wrapped, and a failure
 *    degrades to running the function uninstrumented. A capture with no
 *    function spans is a correct outcome; a page broken by its debugger never
 *    is.
 *
 * ## Why an explicit stack, where the Node twin uses a context manager
 *
 * The preload nests spans through OpenTelemetry's `AsyncLocalStorage` context
 * manager: `context.with(...)` makes whatever the callback starts a child of
 * the active span. The page has no equivalent — AAP §0.2.4 rejected
 * `@opentelemetry/context-zone` for ES2017+ output, and no OpenTelemetry SDK
 * ships inside the agent bundle at all — so nesting here is an explicit
 * module-local stack ({@link MAX_SPAN_STACK_DEPTH} deep) plus
 * `resolveEventContext()` from `./interaction.js` as the fallback parent.
 *
 * The consequences of that difference, stated because they are the two things a
 * reader comparing the two files will want to know:
 *
 * - The stack is **popped synchronously**, in a `finally`, before any returned
 *   promise settles. Two patched `async` functions running concurrently
 *   therefore never adopt each other's frames; what an `await` cannot carry
 *   across is not pretended to be carried.
 * - A patched function called *after* an `await` — outside its caller's
 *   synchronous run — is parented by `resolveEventContext()` rather than by the
 *   caller. That resolves to the open interaction or continuation window, which
 *   is the same trace, so the span lands in the right tree at a shallower
 *   depth rather than in the wrong tree.
 *
 * ## Imports, and the ones that are banned
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this folder into the static
 * `world: "MAIN"` content script the Chrome extension copies verbatim, and it
 * hard-fails on any input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared`'s Node entry, `@opentelemetry/*` or `zod`. So: `./ids.js`
 * and `../redaction/rules.js` (both import-free by construction),
 * `../schema/attributes.js` (vocabulary only), `./transport.js` (the agent's
 * one way out) and `./interaction.js` (trace attribution).
 *
 * `@debuggen/shared` is not imported **in any form, not even for a type**: its
 * barrel value-imports `zod` for the `SourceLocation` schema, and a `type`
 * keyword dropped in a future refactor would put that in the bundle. The price
 * is {@link PatchSourceLocation}, a local structural mirror of
 * `sourceLocationSchema` that must stay in sync with it field for field.
 *
 * ## About the `__DEBUGGEN__` marker
 *
 * The literals `__DEBUGGEN__` and `__DebuggenSpanHelper` are deliberate product
 * vocabulary and belong here: they are the names the patch template emits and
 * therefore the only names this module may install and document.
 * `scripts/check-no-residual-instrumentation.mjs` greps for them **only under
 * `apps/demo-app`**, where their presence in tracked source would mean a
 * session left instrumentation behind. Their presence in this file is correct
 * and expected.
 *
 * @example Installed by the agent, used by patched code, retired by cleanup
 * ```ts
 * installSpanHelper({ describeTarget });   // agent.ts, once, at document_start
 * setSpanHelperEnabled(true, captureId);   // when a capture arms the agent
 * // …the patched function in the developer's project, unchanged semantics:
 * globalThis.__DEBUGGEN__?.span('handleCheckout', { symbol: 'handleCheckout' }, () => orig());
 * setSpanHelperEnabled(false);             // capture stopped: inert, still installed
 * ```
 *
 * @module packages/telemetry/src/browser/span-helper
 */

import {
  isSensitiveKeyName,
  REDACTION_MARKER,
  scrubNamedValue,
  truncate,
} from '../redaction/rules.js';
import {
  CORRELATION_ATTRIBUTE_KEYS,
  LINEAGE_ATTRIBUTE_KEYS,
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
} from '../schema/attributes.js';
import { resolveEventContext } from './interaction.js';
import { newSpanId } from './ids.js';
import { emit, nowEpochMs, type EventDraft } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * The helper object this module installs at `globalThis.__DEBUGGEN__`.
 *
 * Assignable to the `__DebuggenSpanHelper` alias the patcher inserts into a
 * patched file, which is the whole point: the template's call site and this
 * declaration are the same signature, so a change here is a breaking change to
 * every patched function in every project a session has ever touched.
 *
 * {@link span} is a **plain callable own property** — never a getter, never a
 * `Proxy` trap, never lazily defined. The template tests
 * `typeof __dbg.span === 'function'` *before* it calls anything, so a
 * side-effecting getter would run at availability-check time, in code that has
 * not decided to instrument anything yet.
 */
export interface BrowserSpanHelper {
  /**
   * Run `fn` as a `function`-kind span, returning exactly what `fn` returned.
   *
   * @param name The span name; the patched symbol's name. Truncated to
   * {@link MAX_SPAN_NAME_LENGTH} and never redacted — a symbol name is not
   * user data, and the service matches it against the code graph.
   * @param meta Attribute candidates from the patch (`symbol`, `module`,
   * `actionId`) plus the patch-recorded `file`, `line` and `column`. Treated as
   * untrusted and bounded — see this module's privacy notes.
   * @param fn The original function body, invoked exactly once.
   * @returns `fn`'s return value, by reference and unmodified.
   */
  span<T>(name: string, meta: Record<string, unknown>, fn: () => T): T;

  /**
   * The helper protocol version, {@link SPAN_HELPER_VERSION}.
   *
   * Read by the DevTools panel and by `./agent.ts`'s diagnostics to tell which
   * agent build a page is carrying, which matters because the agent is a static
   * content script: a page loaded before an extension update keeps running the
   * bundle it was loaded with.
   */
  readonly version: number;

  /**
   * What the last `agent.config` was read as, for diagnostics only.
   *
   * The normalised projection `./agent.ts` publishes (its `publishedConfig`),
   * never the relayed payload: a closed, JSON-compliant key set built from the
   * decisions that module took, so a key the wire payload carries cannot
   * appear on this page-visible global by arriving.
   *
   * Nothing in this module reads it — configuration flows through
   * {@link setSpanHelperEnabled} and `configureTransport` — and it is typed
   * `unknown` so that no consumer can treat it as a contract.
   */
  config?: unknown;

  /**
   * Describe a DOM element for the element-selection path, published by
   * `./agent.ts` from `./dom-target.js`.
   *
   * Optional because this module never provides it, and JSON-returning because
   * `apps/chrome-extension/src/devtools/devtools.ts` evaluates
   * `window.__DEBUGGEN__.describeTarget($0)` through
   * `chrome.devtools.inspectedWindow.eval`, which can only transport
   * JSON-compliant values.
   */
  describeTarget?(el: unknown): unknown;
}

/**
 * Members `./agent.ts` publishes onto the helper when it installs it.
 *
 * A separate type from {@link BrowserSpanHelper} because these are *inputs*:
 * the agent owns element description and knows its own build version, and this
 * module owns `span`. Both optional, so `installSpanHelper()` with no argument
 * is a complete call.
 */
export interface SpanHelperExtras {
  /** See {@link BrowserSpanHelper.describeTarget}. */
  describeTarget?(el: unknown): unknown;

  /**
   * Publish a version other than {@link SPAN_HELPER_VERSION}.
   *
   * Only ever raises it: a merge into an existing helper keeps the higher of
   * the two, so an older bundle that got to the global first cannot advertise
   * capabilities the newer one has, and a newer one cannot silently downgrade
   * what patched code already saw.
   */
  version?: number;
}

/**
 * Where in the developer's project a patched function lives.
 *
 * A **local structural mirror** of `sourceLocationSchema` in
 * `packages/shared/src/source-location.ts`, restated here because that module's
 * package barrel value-imports `zod`, which the agent bundle forbids (see this
 * module's import notes). It must stay in sync with that schema field for
 * field: a location this file builds is validated against the real schema at
 * ingest, and a field this mirror gets wrong is an event silently dropped.
 *
 * Deliberately narrower than the schema in two ways, both of which fail closed:
 * `resolvedBy` is fixed to `'patch'` (this file is the only producer of a
 * patch-resolved location — the patcher recorded the position when it wrote the
 * wrapper, which is why it is the most precise of the routes), and `endLine` is
 * omitted because a patch records a point, not a region.
 */
interface PatchSourceLocation {
  /** Project-relative POSIX path; see {@link isSafePatchPath}. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /**
   * The patched symbol's name, when `meta` carried a usable one.
   *
   * Declared to accept an explicit `undefined` as well as absence because the
   * repository compiles with `exactOptionalPropertyTypes`; the builder below
   * still omits the key entirely rather than writing `undefined` into it.
   */
  symbol?: string | undefined;
  /** Always `'patch'`. */
  resolvedBy: 'patch';
  /** Always {@link PATCH_CONFIDENCE}. */
  confidence: number;
}

/**
 * A structural view of the one global property this module owns.
 *
 * `../node/span-helper.ts` already writes `declare global { var __DEBUGGEN__:
 * DebuggenSpanHelper | undefined }`, and both files are inputs of the same
 * TypeScript program (`packages/telemetry/tsconfig.json` includes all of
 * `src/**`). A second `declare global` for the same name with a different type
 * is a hard error (TS2403/TS2451), and two structurally identical but
 * separately declared interfaces are not the same type — so this file declares
 * no global at all and reaches `globalThis` through this view instead, exactly
 * as the twin's declaration instructs.
 *
 * The double assertion below is required rather than stylistic: the program's
 * `typeof globalThis` types this property as the twin's narrower interface,
 * which is neither a supertype nor a subtype of {@link BrowserSpanHelper}, so a
 * direct assertion would be rejected as a mistake (TS2352).
 */
interface DebuggenGlobalScope {
  /** The helper a patched function reaches for, or absent while none is installed. */
  __DEBUGGEN__?: BrowserSpanHelper;
}

/*
 * ---------------------------------------------------------------------------
 * Published constants
 * ---------------------------------------------------------------------------
 */

/**
 * The helper protocol version this build publishes.
 *
 * Bumped when {@link BrowserSpanHelper} gains or changes a member, so that a
 * panel talking to a page loaded from an older bundle can tell. The `span`
 * signature itself is **not** versioned: it can never change (see the module
 * overview), so nothing needs to negotiate it.
 */
export const SPAN_HELPER_VERSION = 1;

/**
 * How deep nested patched functions may nest before {@link span} degrades to a
 * plain pass-through.
 *
 * A recursive patched function is the case this bound exists for: without it,
 * a thousand-deep recursion would mint a thousand span ids, allocate a thousand
 * records and emit a thousand events describing one call the developer asked one
 * question about. Beyond this depth the function still runs — uninstrumented,
 * at zero cost — which is the honest degradation: losing telemetry is
 * recoverable, growing the page's memory inside someone's call stack is not.
 */
export const MAX_SPAN_STACK_DEPTH = 64;

/**
 * The longest span name this module reports, in code points.
 *
 * Comfortably below the 512 the event schema accepts (`../schema/event.ts`), and
 * far longer than any real symbol name: a patched symbol is
 * `handleCheckout`, not an essay. The bound matters because `name` arrives from
 * generated code in a project that may not be type-checked at all, so it is
 * ultimately page-influenced input.
 */
export const MAX_SPAN_NAME_LENGTH = 200;

/*
 * ---------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------
 */

/**
 * The property name this module installs on `globalThis`.
 *
 * A deliberate duplicate of `DEBUGGEN_GLOBAL_KEY` in `../node/span-helper.ts`:
 * that module value-imports the OpenTelemetry API, which the agent bundle
 * forbids, so the spelling is restated rather than imported. It is the same
 * spelling `packages/instrumentation/src/patch/wrap-template.ts` emits and
 * `scripts/check-no-residual-instrumentation.mjs` looks for, and the two copies
 * must never diverge.
 */
const DEBUGGEN_GLOBAL_KEY = '__DEBUGGEN__';

/**
 * Span name used when the caller supplied nothing usable.
 *
 * The event schema requires a non-empty `name`, so an empty or whitespace-only
 * argument cannot simply be passed through; it is also not worth failing a
 * developer's capture over. Same value as the Node twin's fallback, so one
 * unnamed function span reads identically whichever tier produced it.
 */
const FALLBACK_SPAN_NAME = 'debuggen.function';

/**
 * Attribute recording whether the span ended on a settled promise (`true`) or
 * on a plain return (`false`).
 *
 * Written on both paths rather than only the asynchronous one: a missing
 * attribute would be ambiguous, and the flag is what makes an awaited
 * function's duration interpretable. One of the declared `function` keys in
 * `../schema/attributes.ts`.
 */
const ASYNC_ATTRIBUTE_KEY = 'async';

/**
 * Attribute carrying the **name** of a thrown error, and nothing else.
 *
 * The canonical key `../node/convert.ts` maps an exception's type onto, so a
 * failed function span reads the same from either tier. No message, no stack,
 * no argument values: AAP §0.5.2 keeps captured values out, and an error
 * message is the most likely string in a page to quote one.
 */
const ERROR_TYPE_ATTRIBUTE_KEY = 'error.type';

/**
 * Keys {@link span} owns, and therefore never copies out of `meta`.
 *
 * `meta` is generated code running in someone else's page: it may not overwrite
 * the asynchrony flag or the error type that only this module can determine,
 * nor forge the lineage and correlation annotations that belong to
 * `./continuation.js` and the service's correlator, nor supply the
 * service-assigned `request_key` that duplicate detection is computed from
 * (`../schema/attributes.ts` declares all three groups).
 */
const RESERVED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  ASYNC_ATTRIBUTE_KEY,
  ERROR_TYPE_ATTRIBUTE_KEY,
  ...LINEAGE_ATTRIBUTE_KEYS,
  ...CORRELATION_ATTRIBUTE_KEYS,
  ...SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
]);

/**
 * `meta` keys consumed by a successfully built {@link PatchSourceLocation}.
 *
 * They are not copied into the attribute bag as well: `source` is the
 * structured, validated home for a location, and duplicating three fields onto
 * every function span would cost bytes on the hot path for nothing. When the
 * location is **rejected**, they are copied like any other `meta` entry, so the
 * malformed hint stays visible to whoever has to explain the missing link.
 */
const SOURCE_META_KEYS: ReadonlySet<string> = new Set(['file', 'line', 'column']);

/**
 * Confidence reported for a patch-resolved location.
 *
 * Mirrors `DEFAULT_RESOLUTION_CONFIDENCE.patch` in
 * `packages/shared/src/source-location.ts` — hardcoded because that module
 * cannot be imported here (see this module's import notes), and `1` because a
 * patch location is exact by construction: the patcher recorded the file, line
 * and column of the function it wrapped rather than inferring them afterwards.
 */
const PATCH_CONFIDENCE = 1;

/**
 * The longest `file` this module accepts in a location, in UTF-16 units.
 *
 * A path cannot be truncated — a shortened path is a *different* path, and one
 * the editor would open at the wrong place or not at all — so an over-long
 * value is rejected instead, which omits the location and keeps the event.
 * Longer than any real project-relative path, short enough that a page calling
 * the helper directly cannot push an unbounded string into the store.
 */
const MAX_SOURCE_PATH_LENGTH = 512;

/** Highest UTF-16 code unit of the C0 control block (U+0000–U+001F), NUL included. */
const LAST_C0_CONTROL = 0x1f;

/** DELETE (U+007F), the first code unit treated as a C1-range control. */
const FIRST_C1_CONTROL = 0x7f;

/** Highest UTF-16 code unit of the C1 control block (U+009F). */
const LAST_C1_CONTROL = 0x9f;

/** A Windows drive-letter prefix: one ASCII letter followed by a colon. */
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * How many attachments deep {@link terminateSettlementBranch} follows the
 * settlement side branch before it stops looking.
 *
 * One pass closes the branch in every realm whose promise machinery is intact,
 * because {@link attachTerminalObserver} reports a provably terminated branch
 * rather than a value to follow. The extra two exist for the realm where that
 * is not available — a replaced `Promise.prototype.then` handing back a fresh
 * rejecting thenable from each attachment — and the bound is what stops this
 * module from iterating page-controlled code without end: a loop whose exit
 * the application decides is a hang inside the developer's own call stack, and
 * guarantee 4 of the module overview forbids that. What the bound gives up is
 * stated where it is spent.
 */
const MAX_SETTLEMENT_OBSERVER_DEPTH = 3;

/*
 * ---------------------------------------------------------------------------
 * Internal types
 * ---------------------------------------------------------------------------
 */

/**
 * `Promise.prototype.then` as the terminal settlement observer calls it: two
 * mandatory handlers, an unconstrained receiver, and a result of `unknown`.
 *
 * Declared locally rather than spelled `typeof Promise.prototype.then` because
 * both of those widenings are load-bearing. The receiver is `unknown` because
 * the function is invoked with `.call(…)` on a promise this module built, and
 * the result is `unknown` because `then` derives its promise through
 * `SpeciesConstructor` — so "what comes back is a promise" holds only while the
 * realm's species is intact, which is precisely the assumption
 * {@link observeSettlement} refuses to make. Reading the member through
 * {@link memberView} (see {@link captureNativeThen}) rather than off the
 * prototype directly also keeps it an ordinary value rather than an unbound
 * method reference.
 */
type SettlementThen = (
  this: unknown,
  onFulfilled: (value: unknown) => void,
  onRejected: (reason: unknown) => void,
) => unknown;

/**
 * One frame of the nesting stack: the trace a span joined and its own id.
 *
 * Pushed for the synchronous extent of an enabled {@link span} call and popped
 * in that call's `finally`, which is what makes a nested patched function a
 * child of the one that called it.
 */
interface SpanFrame {
  /** The trace the span joined: 32 lowercase hex characters. */
  readonly traceId: string;
  /** The span's own id: 16 lowercase hex characters. */
  readonly spanId: string;
}

/**
 * Everything an in-flight span needs in order to finish itself.
 *
 * Captured once, at the start of the call, so that a span settling after its
 * caller returned — an awaited patched function — still reports the trace,
 * parent and attributes it began with rather than whatever the stack happens to
 * hold at settlement.
 */
interface SpanRecord {
  /** This span's frame, as pushed onto the stack. */
  readonly frame: SpanFrame;
  /** The span this one hangs from, or absent when it is a trace root. */
  readonly parentSpanId: string | undefined;
  /** The normalised span name. */
  readonly name: string;
  /** When the call started, in Unix epoch milliseconds. */
  readonly startTime: number;
  /** Attributes gathered from the attribution context and from `meta`. */
  readonly attributes: Record<string, unknown>;
  /** The patch-recorded location, when `meta` carried a usable one. */
  readonly source: PatchSourceLocation | undefined;
  /**
   * The value of {@link captureGeneration} when the span opened: the capture
   * this span's work belongs to.
   *
   * As `readonly` as the span's other identity fields, and for the same reason
   * — a span cannot change which capture observed it. {@link finishSpan} emits
   * only while it still matches, which is what keeps a promise opened in one
   * capture from reporting into the next.
   */
  readonly generation: number;
  /** Whether the event has been emitted, so it can never be emitted twice. */
  ended: boolean;
}

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * Module scope is per JavaScript context and the agent bundle is evaluated once
 * per page document, so this state is exactly one document's helper. Declaring
 * an empty array and a few flags is not a side effect, and neither is reading
 * the realm's promise intrinsic below: nothing observable happens until a
 * function is called, which is the invariant `./agent.ts` relies on to be the
 * only module in this folder that acts when it is evaluated.
 * ---------------------------------------------------------------------------
 */

/**
 * A structural view of the global object, through which this module reads and
 * writes its one property. See {@link DebuggenGlobalScope} for why the double
 * assertion is required rather than stylistic.
 */
const globalScope = globalThis as unknown as DebuggenGlobalScope;

/**
 * The realm's own `Promise` constructor, captured at module evaluation.
 *
 * Captured rather than resolved at call time — the opposite of what `./ids.ts`
 * does for `crypto`, and for a reason worth stating. `Promise` is an
 * ECMAScript intrinsic, present from the instant the realm exists, where a
 * host global may still be arriving at `document_start`; and the agent bundle
 * is a MAIN-world content script that runs **at** `document_start`, before any
 * page script has executed. So what this constant holds is the page's own
 * promise machinery as the page received it, which is exactly the property
 * {@link attachTerminalObserver} needs: a later replacement of `Promise`,
 * `Promise.prototype.then` or the promise species cannot reach it.
 *
 * `undefined` on an exotic host with no `Promise` at all — a realm the fallback
 * path in {@link attachTerminalObserver} still copes with.
 */
const NATIVE_PROMISE: PromiseConstructor | undefined =
  typeof Promise === 'function' ? Promise : undefined;

/**
 * `Promise.prototype.then` as it stood when {@link NATIVE_PROMISE} was
 * captured, or `undefined` when there was none to have.
 *
 * Held separately from the constructor because it is the member a page is most
 * likely to replace — every promise-instrumentation library does — and the
 * terminal observer has to attach its handlers through the real one, whose
 * return value is a promise, rather than through a replacement whose return
 * value is anyone's guess. See {@link captureNativeThen} for why the read is
 * wrapped.
 */
const NATIVE_PROMISE_THEN: SettlementThen | undefined = captureNativeThen();

/** The nesting stack; empty whenever no enabled `span` call is in progress. */
const spanStack: SpanFrame[] = [];

/**
 * Whether {@link span} instruments at all.
 *
 * Starts `false` — a page the developer is merely browsing, or a session that
 * has ended, must cost nothing — and is raised by {@link setSpanHelperEnabled}
 * when a capture arms the agent. Named for the state rather than for the
 * setter's parameter so the two can never be confused inside that function.
 */
let armed = false;

/**
 * The normalised capture id of the last configuration handed to
 * {@link setSpanHelperEnabled}, or `undefined` when none was usably stated.
 *
 * Remembered only to decide whether {@link setSpanHelperEnabled} was handed a
 * *different* configuration; nothing stamps it onto an event, because
 * `./transport.js` owns the `captureId` an event carries and one module
 * deciding that twice is how the two would drift apart.
 */
let armedCaptureId: string | undefined;

/**
 * Which capture generation is current, advanced by {@link setSpanHelperEnabled}
 * whenever the armed configuration actually changes and by
 * {@link uninstallSpanHelper}.
 *
 * This is how an `async` patched function survives a capture boundary without
 * escaping into the next capture. A {@link SpanRecord} carries the generation
 * it was opened in; when it settles, a record from any other generation emits
 * nothing, so a promise opened in capture A and settled during capture B
 * reports into neither. A bare `armed` flag cannot express that: it is `true`
 * in both captures, and `./transport.js` would stamp the late event with
 * capture B's `captureId` and capture B's restarted per-capture `seq` (AAP
 * §0.2.3 scopes `seq` to `(producerId, captureId)`) — work nobody observed,
 * inside somebody else's capture. `./fetch.ts` prevents the same class of
 * defect with the same mechanism for requests already on the wire.
 */
let captureGeneration = 0;

/**
 * The helper object this module installed, for identity-tracked removal.
 *
 * {@link uninstallSpanHelper} removes the global only while it still holds
 * *this* object, so a helper installed by a second copy of the agent bundle, or
 * by a page, is never deleted by our cleanup.
 */
let installedHelper: BrowserSpanHelper | undefined;

/** The last configuration handed to {@link setSpanHelperConfig}, if any. */
let lastConfig: unknown;

/** Whether {@link lastConfig} holds a payload, since `undefined` is a valid one. */
let hasConfig = false;

/*
 * ---------------------------------------------------------------------------
 * Internals
 *
 * Every function below is total and never throws. That is not defensive habit:
 * each of them runs inside a call the developer's application made, on a stack
 * this module has no right to unwind.
 * ---------------------------------------------------------------------------
 */

/**
 * Read `then` off {@link NATIVE_PROMISE}'s prototype, once, at module
 * evaluation.
 *
 * Wrapped even though the read happens before any page script could have
 * installed a throwing accessor: this one runs while the module is still being
 * evaluated, where an exception would take the whole agent bundle down instead
 * of costing a single span, so guarantee 4 of the module overview applies here
 * more than anywhere else. A realm that refuses the read simply leaves the
 * fallback path of {@link attachTerminalObserver} in charge.
 *
 * The member is read through {@link memberView}, which yields a plain
 * `unknown`, so the `typeof` guard below is the only thing that decides whether
 * there is a function to keep.
 *
 * @returns The realm's own `then`, or `undefined` when there is none.
 */
function captureNativeThen(): SettlementThen | undefined {
  if (NATIVE_PROMISE === undefined) {
    return undefined;
  }

  try {
    const candidate = memberView(NATIVE_PROMISE.prototype)['then'];
    return typeof candidate === 'function' ? (candidate as SettlementThen) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Round to microsecond precision, the resolution the event contract keeps.
 *
 * @param value Any number.
 * @returns `value` rounded to three decimal places, or `0` when it is not
 * finite — a duration is a number or it is nothing.
 */
function round3(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 1000) / 1000;
}

/**
 * Whether a UTF-16 code unit is a C0 or C1 control character.
 *
 * Mirrors `isControlCode` in `packages/shared/src/paths.ts`. Control characters
 * have no place in a path: NUL truncates one at the boundary of many C string
 * APIs — so `'a\u0000.ts'` can open `'a'` — and ESC begins a terminal escape
 * sequence, which is how a path echoed into a log rewrites the rest of the line.
 *
 * @param code A UTF-16 code unit.
 */
function isControlCode(code: number): boolean {
  return code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL);
}

/**
 * Normalise a relative POSIX path lexically: no filesystem, no cwd, no symlink
 * resolution.
 *
 * Mirrors the relative branch of `normalizePosix` in
 * `packages/shared/src/paths.ts`: repeated separators collapse, `'.'` segments
 * are dropped, a `'..'` cancels the real segment before it, and a leading
 * `'..'` with nothing to cancel is **preserved** so {@link isSafePatchPath} can
 * refuse it. An empty result becomes `'.'`, as it does there.
 *
 * @param path A path with `/` separators.
 * @returns The lexically normalised form.
 */
function normalizeRelativePosix(path: string): string {
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }

    if (segment === '..') {
      const last = segments.at(-1);
      if (last !== undefined && last !== '..') {
        segments.pop();
      } else {
        segments.push('..');
      }
      continue;
    }

    segments.push(segment);
  }

  return segments.length === 0 ? '.' : segments.join('/');
}

/**
 * Whether a string is a project-relative POSIX path safe to put in a
 * {@link PatchSourceLocation}.
 *
 * Mirrors `isSafeRelativePath` in `packages/shared/src/paths.ts`, which is the
 * refinement `sourceLocationSchema` applies at ingest — replicated because that
 * package cannot be imported here. Every case fails closed, and a rejection
 * costs the location rather than the event:
 *
 * - empty, or whitespace-only before **or** after normalisation;
 * - longer than {@link MAX_SOURCE_PATH_LENGTH} (this file's own bound: the
 *   schema has none, and a path cannot be truncated);
 * - any control character, any backslash;
 * - POSIX-absolute (`'/src/a.ts'`), which also covers the UNC `'//server/a'`;
 * - a Windows drive prefix in either slash direction (`'C:/a'`, `'C:a'`);
 * - any `'..'` segment surviving normalisation — leading, interior or whole. An
 *   interior `'..'` that resolves back inside is fine (`'src/../src/a.ts'`),
 *   because normalisation has already removed it;
 * - the project root itself (`'.'`, or anything normalising to it), which is
 *   stricter than the shared predicate: that one answers "is this path safe",
 *   and a *function* lives in a file, never in a directory.
 *
 * This is a string-level check, as the shared one is. It cannot see that a
 * path is a symlink out of the project; `fs.realpath` in
 * `apps/vscode-extension/src/uri-handler.ts` and `O_NOFOLLOW` in
 * `@debuggen/shared`'s `safe-fs` are what close that gap.
 *
 * @param path The candidate project-relative path.
 * @returns `true` only when the path is safe to treat as project-relative.
 */
function isSafePatchPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_SOURCE_PATH_LENGTH || path.trim().length === 0) {
    return false;
  }

  for (let index = 0; index < path.length; index += 1) {
    if (isControlCode(path.charCodeAt(index))) {
      return false;
    }
  }

  if (path.includes('\\') || path.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(path)) {
    return false;
  }

  const normalized = normalizeRelativePosix(path);
  if (normalized === '.' || normalized.trim().length === 0) {
    return false;
  }

  return !normalized.split('/').includes('..');
}

/**
 * Read a 1-based line or column out of `meta`.
 *
 * @param value The raw `meta.line` or `meta.column`.
 * @returns The value when it is an integer of at least one — what
 * `sourceLocationSchema` requires — or `undefined`, which omits the location.
 */
function toPositionNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

/**
 * Build the patch-recorded source location from `meta`, or nothing.
 *
 * **This file's exclusive privilege.** No other browser producer can report a
 * `'patch'`-resolved location, because no other one is called from code the
 * patcher wrote and therefore from a call site whose file, line and column were
 * recorded when the wrapper was applied.
 *
 * All or nothing, deliberately: the strict `sourceLocationSchema` rejects a
 * malformed location at ingest and the **whole event** would be dropped with
 * it, so a location that cannot be vouched for is omitted and the span still
 * arrives with its timing intact.
 *
 * @param meta The object the patch template passed, of any shape.
 * @returns A valid location, or `undefined` to omit `source` entirely.
 */
function sourceFromMeta(meta: unknown): PatchSourceLocation | undefined {
  if (typeof meta !== 'object' || meta === null) {
    return undefined;
  }

  try {
    const candidate = meta as Record<string, unknown>;

    const file = candidate.file;
    if (typeof file !== 'string' || !isSafePatchPath(file)) {
      return undefined;
    }

    const line = toPositionNumber(candidate.line);
    const column = toPositionNumber(candidate.column);
    if (line === undefined || column === undefined) {
      return undefined;
    }

    const symbol = candidate.symbol;
    const location: PatchSourceLocation = {
      file,
      line,
      column,
      resolvedBy: 'patch',
      confidence: PATCH_CONFIDENCE,
    };

    // `symbol` is optional in the schema and constrained to a non-empty string,
    // so an empty name is dropped rather than sent as a blank label. The key is
    // omitted rather than set to `undefined`, which keeps the posted frame free
    // of a field that means nothing.
    if (typeof symbol === 'string' && symbol.trim().length > 0) {
      location.symbol = truncate(symbol, MAX_PREVIEW_LENGTH);
    }

    return location;
  } catch {
    // An exotic `meta` — a proxy with a throwing getter — yields no location
    // rather than an exception on the application's stack.
    return undefined;
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
 * @returns A non-empty name bounded by {@link MAX_SPAN_NAME_LENGTH}. Never
 * scrubbed: a symbol name is not user data, and the service matches it against
 * the code graph.
 */
function spanNameFor(name: string): string {
  if (typeof name !== 'string') {
    return FALLBACK_SPAN_NAME;
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return FALLBACK_SPAN_NAME;
  }

  return truncate(trimmed, MAX_SPAN_NAME_LENGTH);
}

/**
 * Normalise the capture id {@link setSpanHelperEnabled} was handed.
 *
 * The value arrives on a relayed `agent.config` message and generated code can
 * call the setter too, so the `typeof` check is not redundant in practice — the
 * same reasoning that makes the setter compare `enabled` against `true` rather
 * than coercing it. An empty string is the one further reading of "no capture
 * stated", and collapsing it to `undefined` keeps two spellings of the same
 * absence from looking like two different captures and advancing the generation
 * for nothing.
 *
 * **The id is compared verbatim, by no method call at all.** This module runs
 * in the page's MAIN world and a configuration arrives long after page scripts
 * have run, so `String.prototype.trim` — or any other method reachable from a
 * value the page can influence — may have been replaced with something that
 * throws. A throw here would escape {@link setSpanHelperEnabled} into
 * `./agent.js`'s arming sequence and abort a capture transition part-way
 * through, which is precisely the cross-capture leak the generation exists to
 * prevent. A capture id is a service-generated identifier that is already
 * canonical (`../../protocol` mints it), so there was never anything to
 * normalise beyond its presence, and an id with surrounding whitespace is
 * simply a different capture from one without.
 *
 * @param captureId The raw second argument, of any type at runtime.
 * @returns The id exactly as given, or `undefined` when none was usably
 * stated. Never truncated: the id is only ever compared with itself here, never
 * reported.
 */
function normalizeCaptureId(captureId: unknown): string | undefined {
  if (typeof captureId !== 'string' || captureId === '') {
    return undefined;
  }

  return captureId;
}

/**
 * Convert one `meta` entry into an attribute value, or skip it.
 *
 * Only the three primitive types survive. Strings are scrubbed **before** being
 * truncated — the order is part of `../redaction/rules.ts`'s contract, because
 * cutting first can leave a credential half-matched and therefore unreplaced —
 * and a value under a credential-like name is replaced whole whatever its type,
 * keeping the key's presence while hiding what it held. Non-finite numbers are
 * dropped: `NaN` and `Infinity` have no JSON form, and this value is destined
 * for an ingest payload.
 *
 * @param key The key the value was supplied under.
 * @param value The raw value from `meta`.
 * @returns An attribute value, or `undefined` to skip the entry entirely.
 */
function toAttributeValue(key: string, value: unknown): string | number | boolean | undefined {
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
  // throw on the application's stack — `./transport.ts` would also refuse to
  // clone one — and an argument's *value* is not ours to capture (AAP §0.5.2).
  return undefined;
}

/**
 * Copy the usable entries of `meta` into an attribute bag.
 *
 * At most {@link MAX_TRACKED_KEYS} keys are taken, reserved keys are skipped,
 * and the keys a valid location already carries are skipped too (see
 * {@link SOURCE_META_KEYS}). The whole walk is wrapped: an exotic `meta` — a
 * proxy with a throwing `ownKeys` or getter — contributes whatever it managed
 * before it misbehaved rather than an exception.
 *
 * The patch supplies `symbol`, `module` and `actionId`, which are the declared
 * `function` keys in `../schema/attributes.ts`; anything else it carries is
 * copied under the same bounds, because that catalog declares what a kind says
 * about itself and is explicitly not a whitelist.
 *
 * @param meta The object the patch template passed, of any shape.
 * @param skipSourceKeys Whether a location was built and its keys are therefore
 * already reported.
 * @param into The bag to fill; existing entries are never overwritten by
 * `meta`, so the attribution context keeps its say.
 */
function collectMetaAttributes(
  meta: unknown,
  skipSourceKeys: boolean,
  into: Record<string, unknown>,
): void {
  if (typeof meta !== 'object' || meta === null) {
    return;
  }

  let copied = 0;
  try {
    const candidate = meta as Record<string, unknown>;

    for (const key of Object.keys(candidate)) {
      if (copied >= MAX_TRACKED_KEYS) {
        break;
      }

      if (
        key.length === 0 ||
        RESERVED_ATTRIBUTE_KEYS.has(key) ||
        (skipSourceKeys && SOURCE_META_KEYS.has(key)) ||
        Object.prototype.hasOwnProperty.call(into, key)
      ) {
        continue;
      }

      const attribute = toAttributeValue(key, candidate[key]);
      if (attribute === undefined) {
        continue;
      }

      into[truncate(key, MAX_PREVIEW_LENGTH)] = attribute;
      copied += 1;
    }
  } catch {
    // A hostile `meta` contributes what it managed to before it threw.
  }
}

/**
 * The name of a thrown value, and nothing else.
 *
 * @param error The caught value, of any type.
 * @returns The error's `name` when it has a usable one, or `undefined` — for a
 * thrown string, number or bare object there is nothing to report that would
 * not be its *content*, and `status: 'error'` already says what happened.
 */
function errorNameOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  try {
    const name = (error as { readonly name?: unknown }).name;
    if (typeof name !== 'string') {
      return undefined;
    }

    const trimmed = name.trim();
    return trimmed.length === 0 ? undefined : truncate(trimmed, MAX_PREVIEW_LENGTH);
  } catch {
    // A throwing `name` getter is simply not observable.
    return undefined;
  }
}

/**
 * Whether a value is a thenable, by duck-typing rather than by constructor.
 *
 * A patched function may return a native promise, a userland promise
 * implementation, or a plain object that happens to expose `then` — and the
 * observation below behaves correctly for all three. Reading `then` can itself
 * throw (a getter, an exotic proxy), which is treated as "not a thenable"
 * rather than allowed to escape.
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
    return false;
  }
}

/**
 * Remove a frame, and any residue left above it, from the nesting stack.
 *
 * Identity-based and truncating rather than a plain `pop`: the frames above
 * ours can only exist if a nested call's own `finally` did not run — which
 * nothing in this module allows, and which a page that tampers with the stack's
 * prototype could still contrive — and leaving residue behind would misparent
 * every later span in the document. A frame that is no longer on the stack (a
 * {@link resetSpanStack} in between) is simply not there to remove.
 *
 * @param frame The frame pushed by this call.
 */
function popFrame(frame: SpanFrame): void {
  const index = spanStack.lastIndexOf(frame);
  if (index >= 0) {
    spanStack.length = index;
  }
}

/**
 * Open a span: resolve its parent, mint its id, gather its attributes and push
 * its frame.
 *
 * Parenting has two routes, in order (see the module overview for why the
 * browser needs both where the Node twin needs neither):
 *
 * 1. **The stack** — a frame is on it, so this call happened inside another
 *    patched function's synchronous extent and is its child, in its trace.
 * 2. **`resolveEventContext()`** — otherwise the open interaction window, the
 *    open continuation window, or a fresh synthetic root, with whatever lineage
 *    attributes that attribution contributed merged in first so `meta` cannot
 *    overwrite them.
 *
 * @param name The name the patch template supplied.
 * @param meta The `meta` object it supplied.
 * @returns A record to finish the span with, or `undefined` when the span must
 * not be opened at all — the stack is already {@link MAX_SPAN_STACK_DEPTH} deep,
 * or something in the preparation failed. Both cases degrade {@link span} to a
 * pass-through, which is the outcome that cannot change the application's
 * behaviour.
 */
function beginSpan(name: string, meta: Record<string, unknown>): SpanRecord | undefined {
  try {
    if (spanStack.length >= MAX_SPAN_STACK_DEPTH) {
      return undefined;
    }

    const attributes: Record<string, unknown> = {};
    let traceId: string;
    let parentSpanId: string | undefined;

    const parent = spanStack.at(-1);
    if (parent === undefined) {
      const attribution = resolveEventContext();
      traceId = attribution.traceId;
      parentSpanId = attribution.parentSpanId;
      if (attribution.attributes !== undefined) {
        // `./continuation.js` owns the lineage vocabulary; the bag it filled is
        // merged verbatim, never re-spelled here.
        Object.assign(attributes, attribution.attributes);
      }
    } else {
      traceId = parent.traceId;
      parentSpanId = parent.spanId;
    }

    const source = sourceFromMeta(meta);
    collectMetaAttributes(meta, source !== undefined, attributes);

    const frame: SpanFrame = { traceId, spanId: newSpanId() };
    const record: SpanRecord = {
      frame,
      parentSpanId,
      name: spanNameFor(name),
      startTime: nowEpochMs(),
      attributes,
      source,
      // Stamped at the moment the span opens, never read again until it
      // settles: this is the capture that asked for the work.
      generation: captureGeneration,
      ended: false,
    };

    // Pushed last, once nothing else can fail: a frame on the stack with no
    // record to pop it would misparent every span that followed.
    spanStack.push(frame);
    return record;
  } catch {
    // A failure here costs the span, never the call: the caller falls through
    // to running the patched function uninstrumented.
    return undefined;
  }
}

/**
 * Emit the span's event, exactly once.
 *
 * Idempotent through {@link SpanRecord.ended}, which matters because a thenable
 * can call both of the handlers {@link observeSettlement} attaches if it is a
 * badly behaved userland promise: a second event for one call would double-count
 * the function in every duration the capture reports.
 *
 * Nothing is emitted while the helper is disabled, **and nothing is emitted
 * into a capture other than the one the span opened in**. A span that was
 * opened inside a capture and settles after it stopped therefore reports
 * nothing, which is the honest outcome: `./transport.js` would drop it anyway
 * with no `captureId` in force. A span that settles once a *different* capture
 * has been armed reports nothing either — that is the {@link SpanRecord.generation}
 * check, and without it `./transport.js` would stamp the late event with the
 * new capture's `captureId` and its restarted per-capture `seq`, putting work
 * nobody observed inside somebody else's trace.
 *
 * @param record The record {@link beginSpan} returned.
 * @param status The outcome: `ok`, `error`, or `unset` when the outcome could
 * not be observed at all.
 * @param asynchronous Whether the span ended on a settled thenable rather than
 * on a plain return.
 * @param errorName The thrown value's `name`, when there was one and it had a
 * usable name. Never its message or stack.
 */
function finishSpan(
  record: SpanRecord,
  status: EventDraft['status'],
  asynchronous: boolean,
  errorName?: string,
): void {
  if (record.ended) {
    return;
  }
  record.ended = true;

  // Both halves of the capture gate, in the order they can fail: the helper may
  // have been disarmed since the span opened, and — the case a Boolean cannot
  // see — the helper may have been re-armed for a *different* capture while
  // this span was in flight.
  if (!armed || record.generation !== captureGeneration) {
    return;
  }

  try {
    const attributes: Record<string, unknown> = {
      ...record.attributes,
      [ASYNC_ATTRIBUTE_KEY]: asynchronous,
    };
    if (errorName !== undefined) {
      attributes[ERROR_TYPE_ATTRIBUTE_KEY] = errorName;
    }

    // One clock for both readings. `nowEpochMs()` is derived from
    // `performance.timeOrigin + performance.now()` where the host allows it and
    // from `Date.now()` otherwise, and both forms are epoch milliseconds — so a
    // start/end pair from it needs no second, monotonic clock to compare
    // against, and the degraded case costs precision rather than correctness.
    const duration = round3(Math.max(0, nowEpochMs() - record.startTime));

    const draft: EventDraft = {
      traceId: record.frame.traceId,
      spanId: record.frame.spanId,
      ...(record.parentSpanId !== undefined ? { parentSpanId: record.parentSpanId } : {}),
      kind: 'function',
      name: record.name,
      startTime: record.startTime,
      duration,
      attributes,
      status,
      ...(record.source !== undefined ? { source: record.source } : {}),
    };

    emit(draft);
  } catch {
    // `emit` never throws by contract; this guard covers the attribute merge
    // over a bag built from a hostile `meta`, and costs one event rather than
    // the application call that produced it.
  }
}

/**
 * The terminal observer's handler, used for both outcomes.
 *
 * Deliberately empty, and named rather than inlined twice: its entire job is to
 * *exist*, because a promise that carries a rejection handler is a handled
 * promise and never reaches `unhandledrejection`. Naming it also makes it
 * visible in a profile and provable by inspection that fulfilment and rejection
 * are treated identically — the observer reports nothing, it only absorbs.
 */
function ignoreSettlement(): void {
  // Intentionally empty; see this function's documentation.
}

/**
 * Whether a value carries the internal slots the native `then` requires.
 *
 * `instanceof` is the closest test available — a promise's slots are not
 * readable from script — so it is right for the question being asked and wrong
 * for one case: a `Proxy` over a promise inherits the prototype and passes,
 * while the native `then` still rejects it as a receiver. That is why the
 * in-place path of {@link attachTerminalObserver} has a fallback rather than a
 * guarantee, and why this predicate may be optimistic.
 *
 * @param value A value {@link isThenable} has already accepted.
 * @returns `true` when the native `then` can probably be called on it directly.
 */
function isNativePromise(value: PromiseLike<unknown>): boolean {
  if (NATIVE_PROMISE === undefined) {
    return false;
  }

  try {
    return value instanceof NATIVE_PROMISE;
  } catch {
    // A `Proxy` whose `getPrototypeOf` trap throws answers nothing, and the
    // adoption path copes with it.
    return false;
  }
}

/**
 * Whether `then` on this promise would derive its result through the
 * *intrinsic* promise constructor, so that attaching two non-throwing handlers
 * can only produce a promise that fulfils.
 *
 * `then` builds its result with `SpeciesConstructor(promise, %Promise%)`: it
 * reads the promise's `constructor` and then that constructor's
 * `Symbol.species`. Two readings return the intrinsic — an absent
 * `constructor`, for which the algorithm returns the default, and the intrinsic
 * `Promise` itself, whose inherited species getter returns the receiver. Both
 * are checked here, and anything else — a subclass, a replaced
 * `Promise.prototype.constructor`, a replaced species getter — is reported as
 * *not provably intrinsic* rather than as hostile, because the two are
 * indistinguishable from script and only the safe reading may be assumed.
 *
 * Asking the question at all is what keeps {@link attachTerminalObserver} from
 * writing on a promise in the overwhelmingly common case where it has no need
 * to.
 *
 * @param promise A promise {@link isNativePromise} has accepted.
 * @returns `true` only when both reads say the intrinsic.
 */
function derivesThroughIntrinsic(promise: PromiseLike<unknown>): boolean {
  try {
    const constructor = memberView(promise)['constructor'];
    if (constructor === undefined) {
      return true;
    }
    if (constructor !== NATIVE_PROMISE) {
      return false;
    }
    return (constructor as PromiseConstructor)[Symbol.species] === NATIVE_PROMISE;
  } catch {
    // A throwing `constructor` accessor: nothing is provable, so nothing is
    // assumed.
    return false;
  }
}

/**
 * Make one promise derive its `then` result through the intrinsic constructor,
 * by giving it an own `constructor` of `undefined`.
 *
 * `SpeciesConstructor` returns its default when `constructor` is `undefined`,
 * so this one own property is what turns a subverted species into the
 * intrinsic. It is a **write on an object this module does not own**, so it is
 * paired with {@link restoreOwnConstructor} on every path and held for the
 * shortest time a write can be held: `then` performs its species lookup
 * synchronously, inside the call, so the property goes back the moment that
 * call returns and no application code can observe it in between (see
 * {@link attachTerminalObserver}).
 *
 * `Reflect.defineProperty` reports a refusal instead of throwing, and
 * `configurable` is what keeps the restore able to take the property off again.
 *
 * @param promise The promise to pin.
 * @returns Whether the property is now in place, and therefore whether the
 * caller owes a restore.
 */
function forceIntrinsicSpecies(promise: PromiseLike<unknown>): boolean {
  try {
    return Reflect.defineProperty(promise, 'constructor', {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  } catch {
    return false;
  }
}

/**
 * Put a promise's own `constructor` back exactly as it was found.
 *
 * The counterpart of {@link forceIntrinsicSpecies}, and deliberately stated in
 * terms of the *descriptor* rather than of a value: a promise the application
 * owns may legitimately carry an own `constructor` of its own — a shared
 * instance of a subclass, say — and replacing that with a deletion would leave
 * the object changed in a way its owner can see. An absent descriptor is
 * restored by deleting, which is the same absence it started with.
 *
 * @param promise The promise the pin was applied to.
 * @param prior The descriptor read before the pin, or `undefined` when the
 * property was not an own property at all.
 */
function restoreOwnConstructor(
  promise: PromiseLike<unknown>,
  prior: PropertyDescriptor | undefined,
): void {
  try {
    if (prior === undefined) {
      Reflect.deleteProperty(promise, 'constructor');
      return;
    }
    Reflect.defineProperty(promise, 'constructor', prior);
  } catch {
    // A host that refuses both operations leaves an own `constructor` of
    // `undefined` on an object whose species lookup has already happened;
    // nothing further is available to try.
  }
}

/**
 * Read a promise's own `constructor` descriptor, for the restore that follows
 * a pin.
 *
 * Separate from the pin so that the read happens *before* anything is written,
 * which is the only order in which "exactly as it was found" is knowable.
 *
 * @param promise The promise about to be pinned.
 * @returns Its own `constructor` descriptor, or `undefined` when it has none —
 * including when the read itself is refused, which is the same thing as far as
 * the restore is concerned.
 */
function ownConstructorDescriptor(promise: PromiseLike<unknown>): PropertyDescriptor | undefined {
  try {
    return Reflect.getOwnPropertyDescriptor(promise, 'constructor');
  } catch {
    return undefined;
  }
}

/**
 * Attach rejection-swallowing handlers to one value on the settlement side
 * branch, through the promise machinery this module captured rather than
 * through the page's.
 *
 * Two paths, and which one runs decides whether the branch ends here:
 *
 * 1. **A native promise, observed in place.** The handlers go straight onto it
 *    with the captured `then`. The species is read first
 *    ({@link derivesThroughIntrinsic}) and pinned only when it is not provably
 *    the intrinsic already ({@link forceIntrinsicSpecies}) — the common case
 *    writes nothing at all — and a pin is taken back off in a `finally`, from
 *    the descriptor read before it went on, because `then` performs its species
 *    lookup synchronously inside the call. Either way the promise `then`
 *    derives is a native one carrying two handlers that cannot throw, so it can
 *    only fulfil: the branch is provably terminated and there is nothing left
 *    to chase.
 * 2. **A foreign thenable, whose own `then` is called directly** and whose
 *    return value is handed back. Calling it is what registers a handler on the
 *    value; returning its result is what lets the caller keep following the
 *    chain. Deliberately **not** promise adoption: resolving a native promise
 *    with a thenable does call that thenable's `then`, but the specification's
 *    thenable-adoption job *discards* what that call returns, so a `then` that
 *    hands back a rejecting promise would go unobserved — an
 *    instrumentation-only rejection, which is the whole defect this function
 *    exists to prevent.
 *
 * A `then` that throws synchronously, or a `then` accessor that throws on this
 * second read having succeeded for {@link isThenable}, produced nothing to
 * observe; the throw is swallowed and the branch reported terminated, because a
 * value that was never created cannot reject.
 *
 * @param thenable A thenable sitting on the side branch.
 * @returns `undefined` when the branch is provably terminated, or the value the
 * foreign `then` produced, which may itself still need observing.
 */
function attachTerminalObserver(thenable: PromiseLike<unknown>): unknown {
  const nativeThen = NATIVE_PROMISE_THEN;

  if (nativeThen !== undefined && isNativePromise(thenable)) {
    // Asked, and the descriptor read, before anything is written: both answers
    // are only knowable ahead of the pin.
    const intrinsic = derivesThroughIntrinsic(thenable);
    const prior = intrinsic ? undefined : ownConstructorDescriptor(thenable);
    const pinned = intrinsic ? false : forceIntrinsicSpecies(thenable);
    try {
      nativeThen.call(thenable, ignoreSettlement, ignoreSettlement);
      return undefined;
    } catch {
      // `instanceof` said promise and the native `then` disagreed: a `Proxy`
      // over one. It is the application's object, so the pin comes off in the
      // `finally` below and the value is observed as a foreign thenable
      // instead, through the proxy's own traps.
    } finally {
      if (pinned) {
        restoreOwnConstructor(thenable, prior);
      }
    }
  }

  try {
    return thenable.then(ignoreSettlement, ignoreSettlement);
  } catch {
    // Nothing was created, so nothing can reject, and this module does not
    // raise on the application's stack over it.
    return undefined;
  }
}

/**
 * Follow the settlement side branch until nothing on it can reject, at most
 * {@link MAX_SETTLEMENT_OBSERVER_DEPTH} attachments deep.
 *
 * The loop exists because every attachment produces a *new* value, and in a
 * realm whose promise species has been subverted that value can be another
 * rejecting thenable. It terminates on the first non-thenable — a value with no
 * `then` cannot reject — which is what {@link attachTerminalObserver} returns
 * whenever it could guarantee the outcome itself, so the ordinary case costs
 * one pass.
 *
 * @param value Whatever the application's `then` returned.
 */
function terminateSettlementBranch(value: unknown): void {
  let current = value;

  for (let depth = 0; depth < MAX_SETTLEMENT_OBSERVER_DEPTH; depth += 1) {
    if (!isThenable(current)) {
      // Nothing left that can reject: the branch is closed.
      return;
    }

    const next = attachTerminalObserver(current);
    if (next === undefined) {
      // Provably terminated — a native promise carrying two swallowing
      // handlers, which can only fulfil.
      return;
    }

    current = next;
  }

  // The bound is spent, which takes a foreign `then` handing back a fresh
  // thenable at every level: a native promise never gets here, because
  // observing one in place terminates the branch. The value in hand may
  // nonetheless be a native promise the last foreign `then` produced, and that
  // one *can* reach `unhandledrejection`, so it gets the one attachment that is
  // terminal by construction.
  if (isThenable(current) && isNativePromise(current)) {
    attachTerminalObserver(current);
    return;
  }

  // What is left unobserved is a *foreign* thenable: its rejection is its own
  // implementation's business and cannot raise `unhandledrejection`, which the
  // host fires for native promises only. That is the honest end of the chain —
  // better than following application code around a loop whose exit the
  // application controls, which guarantee 4 of the module overview forbids.
}

/**
 * Observe a returned thenable **without altering it**.
 *
 * The caller keeps the exact reference the patched function produced, so its
 * own `await`, `then` and `catch` behave as they did before instrumentation:
 * this is a side branch, never a replacement.
 *
 * The branch's own end is this module's responsibility. `then` here is the
 * *application's* — a userland promise implementation, or a native subclass
 * whose species has been changed — so the promise it derives is the
 * application's too, and swallowing handlers do not make that derived promise
 * incapable of rejecting. Discarding it would hand the page an
 * `unhandledrejection` that exists only because this module is installed, which
 * guarantee 3 of the module overview forbids; so the value is captured and
 * terminated on machinery captured at `document_start`
 * ({@link terminateSettlementBranch}).
 *
 * @param thenable The value the callback returned.
 * @param record The record to finish when it settles.
 */
function observeSettlement(thenable: PromiseLike<unknown>, record: SpanRecord): void {
  let derived: unknown;

  try {
    // Called exactly once, with both handlers, and deliberately unawaited: this
    // is an observation, not a link in the caller's chain. What it returns is
    // no longer discarded, for the reason in this function's documentation.
    derived = thenable.then(
      () => {
        finishSpan(record, 'ok', true);
      },
      (reason: unknown) => {
        finishSpan(record, 'error', true, errorNameOf(reason));
      },
    );
  } catch {
    // A thenable whose `then` throws synchronously cannot be observed. The span
    // is closed now with an unset status rather than left open for the rest of
    // the document's life: the duration is real, the outcome is genuinely
    // unknown, and saying so is better than claiming either. There is no
    // derived value to terminate — `then` never returned one.
    finishSpan(record, 'unset', true);
    return;
  }

  terminateSettlementBranch(derived);
}

/**
 * Run `fn` as a `function`-kind span and return exactly what it returned.
 *
 * The function installed at `globalThis.__DEBUGGEN__.span`. It upholds the four
 * guarantees of the module overview; read those before changing anything here.
 *
 * There are three textual `fn()` call sites, one per mutually exclusive path —
 * dormant, degraded, instrumented — and every path through this function
 * evaluates exactly one of them, exactly once. The dormant path is literally
 * `return fn()`, with no closure allocated and no clock read, because a patched
 * function on a page nobody is capturing must cost nothing at all.
 *
 * @param name The patched symbol's name; becomes the span name.
 * @param meta Attribute candidates and the patch-recorded location.
 * @param fn The original function body. Invoked exactly once.
 * @returns `fn`'s return value, by reference and unmodified.
 * @throws Whatever `fn` throws, with its identity and stack preserved. Nothing
 * else: no failure of this module's own is ever surfaced to the caller.
 */
function span<T>(name: string, meta: Record<string, unknown>, fn: () => T): T {
  if (!armed) {
    return fn();
  }

  const record = beginSpan(name, meta);
  if (record === undefined) {
    return fn();
  }

  let result: T;
  try {
    result = fn();
  } catch (error) {
    finishSpan(record, 'error', false, errorNameOf(error));
    // The original value, rethrown unchanged: the application's error, with its
    // identity, its `instanceof` and its stack intact.
    throw error;
  } finally {
    // Popped synchronously, before any returned promise settles, so two
    // concurrent asynchronous calls cannot adopt each other's frames.
    popFrame(record.frame);
  }

  if (isThenable(result)) {
    observeSettlement(result, record);
    return result;
  }

  finishSpan(record, 'ok', false);
  return result;
}

/*
 * ---------------------------------------------------------------------------
 * Global plumbing
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a value already satisfies the patch contract at runtime.
 *
 * Exactly the test the patch template performs — `typeof value.span ===
 * 'function'` — so that "a helper is already present" means here precisely what
 * a patched function would conclude.
 *
 * @param value A candidate `globalThis.__DEBUGGEN__`.
 */
function isSpanHelperLike(value: unknown): value is BrowserSpanHelper {
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
 * Read the global property, tolerating a host that refuses.
 *
 * @returns Whatever occupies `globalThis.__DEBUGGEN__`, as `unknown`: the page
 * may have put anything there.
 */
function readGlobal(): unknown {
  try {
    return globalScope.__DEBUGGEN__;
  } catch {
    // A throwing accessor on the global object is not a helper.
    return undefined;
  }
}

/**
 * Write the global property.
 *
 * @param helper The helper to publish.
 * @returns `true` when the write took effect. A page that made the property
 * non-writable keeps its value, and this module then tracks no installation, so
 * {@link uninstallSpanHelper} will not try to remove something it never placed.
 */
function writeGlobal(helper: BrowserSpanHelper): boolean {
  try {
    globalScope.__DEBUGGEN__ = helper;
    return readGlobal() === helper;
  } catch {
    return false;
  }
}

/**
 * A mutable, structural view of a helper's members.
 *
 * Writes go through this view for two reasons: {@link BrowserSpanHelper.version}
 * is `readonly` to its consumers, and the object being merged into may be a
 * *foreign* helper from another copy of the agent bundle, whose members are
 * exactly as typed as any other value that arrived from the page. Reading a
 * member through it also yields a plain `unknown` rather than an unbound
 * method reference.
 *
 * @param helper The helper to view.
 */
function memberView(helper: object): Record<string, unknown> {
  return helper as unknown as Record<string, unknown>;
}

/**
 * Build the helper object, carrying over a foreign global's own members.
 *
 * A value at `globalThis.__DEBUGGEN__` with no callable `span` is not a helper,
 * but it may still be something's state — a future agent module could keep its
 * own flag there. Copying its own enumerable properties across means installing
 * the helper adds a capability instead of destroying one.
 *
 * @param existing Whatever occupied the global, if anything.
 * @returns A fresh helper whose `span` is {@link span}.
 */
function createHelper(existing: unknown): BrowserSpanHelper {
  const helper: BrowserSpanHelper = { span, version: SPAN_HELPER_VERSION };

  if (typeof existing !== 'object' || existing === null) {
    return helper;
  }

  const target = memberView(helper);
  try {
    const carried = existing as Record<string, unknown>;
    for (const key of Object.keys(carried)) {
      if (key === 'span' || key === 'version') {
        continue;
      }
      target[key] = carried[key];
    }
  } catch {
    // An unreadable foreign object is simply not carried over.
  }

  return helper;
}

/**
 * Merge the agent's extras, this module's version and the last configuration
 * into a helper.
 *
 * Version handling is "raise only": an explicit `extras.version` wins when it
 * is higher than what the helper already advertises, and
 * {@link SPAN_HELPER_VERSION} is written only when the helper carries no usable
 * number at all — so a foreign helper from an older bundle keeps describing
 * *its* `span` rather than being relabelled with a version it does not
 * implement, and a newer one is never downgraded.
 *
 * @param helper The helper to publish onto; may be foreign.
 * @param extras What `./agent.ts` supplied, if anything.
 */
function publishExtras(helper: BrowserSpanHelper, extras: SpanHelperExtras | undefined): void {
  const target = memberView(helper);

  try {
    if (extras !== undefined) {
      const source = memberView(extras);

      const describeTarget = source.describeTarget;
      if (typeof describeTarget === 'function') {
        target.describeTarget = describeTarget;
      }

      const requested = source.version;
      const current = target.version;
      if (
        typeof requested === 'number' &&
        Number.isFinite(requested) &&
        (typeof current !== 'number' || !Number.isFinite(current) || requested > current)
      ) {
        target.version = requested;
      }
    }

    const published = target.version;
    if (typeof published !== 'number' || !Number.isFinite(published)) {
      target.version = SPAN_HELPER_VERSION;
    }

    if (hasConfig) {
      target.config = lastConfig;
    }
  } catch {
    // A frozen or hostile helper object keeps whatever it already had; `span`
    // is what patched code needs, and that is either already there or was set
    // when the object was created.
  }
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Install the helper at `globalThis.__DEBUGGEN__`, idempotently, and return it.
 *
 * Called by `./agent.ts` as the agent initialises at `document_start`, before
 * the page's own scripts run, so a function patched at any point during the
 * session finds the helper already there. Installing is cheap and observes
 * nothing: the helper starts **disabled**, and whether a span is recorded is
 * decided later by {@link setSpanHelperEnabled} and by the capture gate in
 * `./transport.js`.
 *
 * Three cases, in order:
 *
 * 1. The global already holds a value with a callable `span` — this module's
 *    helper, or one from a second injection of the agent bundle into the same
 *    document. **Not replaced**: patched code has already captured nothing but
 *    the global's name, yet a live `span` belongs to whichever module's state is
 *    driving it, and swapping the object would strand in-flight spans. The
 *    extras are merged into it and it is returned.
 * 2. The global holds some other value — a fresh helper is installed, carrying
 *    that value's own members across so nothing is destroyed.
 * 3. The global is empty — a fresh helper is installed.
 *
 * @param extras Members `./agent.ts` publishes; see {@link SpanHelperExtras}.
 * @returns The helper now at `globalThis.__DEBUGGEN__` — or, in the rare case
 * of a global property that refused the write, the helper this call built, which
 * is still usable directly.
 */
export function installSpanHelper(extras?: SpanHelperExtras): BrowserSpanHelper {
  const existing = readGlobal();

  if (isSpanHelperLike(existing)) {
    publishExtras(existing, extras);
    return existing;
  }

  const helper = createHelper(existing);
  publishExtras(helper, extras);
  if (writeGlobal(helper)) {
    installedHelper = helper;
  }
  return helper;
}

/**
 * Remove the helper this module installed, if it is still the one in place, and
 * return the module to its dormant state.
 *
 * **Not what `./agent.ts` calls when a capture stops.** That path calls
 * {@link setSpanHelperEnabled} with `false`: code patched during the session may
 * still be loaded in the page — the dev server's hot update replaces a module,
 * it does not un-run the one that is executing — and a patched function whose
 * helper has vanished still works (the template branches on availability), but
 * one whose helper is *disabled* works and costs nothing. Removing the global is
 * for a full agent teardown and for tests.
 *
 * Identity-tracked in both directions: a helper installed by someone else is
 * never removed, and a global replaced after our install is left alone. Calling
 * this without a preceding install, or twice, is a no-op.
 */
export function uninstallSpanHelper(): void {
  const helper = installedHelper;
  installedHelper = undefined;
  armed = false;
  armedCaptureId = undefined;
  // Advanced unconditionally, and before the global is touched: a teardown is a
  // capture boundary whatever state the helper was in, so a span opened before
  // it must not report if a later install and arm lets it settle. A test that
  // uninstalls and reinstalls between cases gets the same isolation.
  captureGeneration += 1;
  spanStack.length = 0;

  if (helper === undefined || readGlobal() !== helper) {
    return;
  }

  // Removing the property outright is tidier than leaving an `undefined`
  // behind, and `Reflect.deleteProperty` reports a refusal instead of throwing
  // on a non-configurable property. Nothing here creates one, but the global
  // object is shared with the page, so the assignment fallback stays: it is all
  // the patch template's availability check needs.
  let removed = false;
  try {
    removed = Reflect.deleteProperty(globalThis, DEBUGGEN_GLOBAL_KEY);
  } catch {
    // A refusal leaves `removed` false and takes the assignment below.
  }

  if (!removed) {
    try {
      memberView(globalThis)[DEBUGGEN_GLOBAL_KEY] = undefined;
    } catch {
      // A non-writable property keeps its value; there is nothing further to
      // try, and a helper left in place is inert because it is disabled.
    }
  }
}

/**
 * The helper currently at `globalThis.__DEBUGGEN__`, when one satisfies the
 * patch contract.
 *
 * Deliberately not restricted to the helper *this* module installed: the page
 * has exactly one `__DEBUGGEN__`, and `./agent.ts` and the DevTools panel want
 * to know what patched code will actually call. A foreign helper is returned as
 * it is; {@link installSpanHelper} is what normalises its `version`.
 */
export function getSpanHelper(): BrowserSpanHelper | undefined {
  const existing = readGlobal();
  return isSpanHelperLike(existing) ? existing : undefined;
}

/**
 * Arm or disarm instrumentation.
 *
 * Called by `./agent.ts` from the `agent.config` payload: `true` when a capture
 * opens with function timing among its signals, `false` when it closes. While
 * disabled, {@link span} is exactly `return fn()` — AAP §0.5.1's "the helper
 * stays installed but inert" — and that is also the state before the first
 * capture of a session.
 *
 * The nesting stack is cleared on every call. A capture boundary never falls
 * inside a patched function's synchronous extent, so there is nothing legitimate
 * to preserve, and a frame left over from a previous capture would misparent the
 * first span of the next one.
 *
 * **The capture generation advances only when the configuration actually
 * changes** — a different armed state, or a different capture id. Re-sending
 * the live configuration is therefore a no-op, which is load-bearing rather
 * than an optimisation: the Chrome service worker re-sends `agent.config` after
 * every reconnect and after every same-origin navigation, with the *same*
 * `captureId` continuing (AAP §0.5.5), and an in-flight `async` span must
 * survive that. A genuine change invalidates every span still in flight, which
 * is what {@link SpanRecord.generation} exists for.
 *
 * @param enabled Whether instrumentation is armed. Compared against `true`
 * rather than coerced, because the value ultimately comes off a relayed
 * message and generated code can call this too.
 * @param captureId The capture being armed, when the caller knows it. Optional
 * because arming is meaningful without it — the gate that matters is `enabled`,
 * and `./transport.js` is what stamps an event's `captureId` — so a caller that
 * has not been wired to pass it keeps working unchanged. An *optional
 * parameter* rather than one declared `string | undefined`: the two behave
 * identically for every caller (an optional parameter accepts omission, an
 * explicit `undefined` and a `string | undefined` value alike, and
 * `exactOptionalPropertyTypes` governs properties, not parameters), and the
 * explicit union on a parameter is an
 * `@typescript-eslint/no-duplicate-type-constituents` error under
 * `--max-warnings 0`. Read exactly as defensively as `enabled` is compared,
 * since it arrives from the same relayed message: anything that is not a
 * non-empty string is treated as "not stated" rather than as an identity of its
 * own (see {@link normalizeCaptureId}).
 *
 * **Total.** Nothing in this function can throw: it compares two primitives,
 * assigns three variables and truncates an array this module owns, and it calls
 * nothing on a value the page can influence. That matters beyond guarantee 4 of
 * the module overview — `./agent.js`'s `arm()` calls this in the middle of a
 * capture transition, and an exception here would leave that transition part
 * done, with the transport on the new capture while a producer was still on the
 * old generation.
 */
export function setSpanHelperEnabled(enabled: boolean, captureId?: string): void {
  const nextArmed = enabled === true;
  const nextCaptureId = normalizeCaptureId(captureId);

  if (nextArmed !== armed || nextCaptureId !== armedCaptureId) {
    // A real capture boundary: every span still in flight was opened for work
    // the previous configuration asked about, and belongs to neither side of
    // the boundary from here on.
    captureGeneration += 1;
  }

  armed = nextArmed;
  armedCaptureId = nextCaptureId;
  spanStack.length = 0;
}

/**
 * Record what the last `agent.config` was read as, for diagnostics.
 *
 * Published on {@link BrowserSpanHelper.config} so that a developer inspecting
 * `window.__DEBUGGEN__` in the console, and the DevTools panel reading it
 * through `chrome.devtools.inspectedWindow.eval`, can see what the page was
 * told. Nothing in this module reads it, and it is remembered even when no
 * helper is installed yet, so a later {@link installSpanHelper} publishes it.
 *
 * @param config The normalised projection `./agent.ts` builds from the parsed
 * configuration (its `publishedConfig`) — not the relayed payload, which is
 * never published on a page-visible global. Typed `unknown` because this module
 * only stores it.
 */
export function setSpanHelperConfig(config: unknown): void {
  lastConfig = config;
  hasConfig = true;

  const helper = getSpanHelper();
  if (helper === undefined) {
    return;
  }

  try {
    memberView(helper).config = config;
  } catch {
    // A frozen helper simply carries no diagnostic copy.
  }
}

/**
 * Empty the nesting stack.
 *
 * Every frame is popped by the `finally` of the call that pushed it, so the
 * stack is empty whenever no patched function is running. This exists for the
 * cases that reasoning does not cover: `./agent.ts` calls it when it detaches,
 * and a test calls it between cases. The next span then starts from
 * `resolveEventContext()` rather than from a stale parent — which is the safe
 * direction, because a wrong parent puts real work under an operation that did
 * not cause it.
 */
export function resetSpanStack(): void {
  spanStack.length = 0;
}
