/**
 * Failures on the page: JavaScript exceptions, unhandled promise rejections
 * and resource-load errors, recorded as telemetry without changing one
 * observable thing about how the page reports them.
 *
 * An interaction that *fails* is the case a generated panel has to be able to
 * explain. A click that throws inside its handler produces no response, no
 * render and no server span — the timeline would simply stop, and the analysis
 * stage would have nothing to say about why. This module supplies the missing
 * row: one `error`-kind event per failure, attributed through
 * {@link resolveEventContext} to the interaction (or the continuation) that
 * was in flight, so the exception appears in the same trace as the click, the
 * fetch and the renders around it. That attribution is the whole value of the
 * signal — an error event with a fresh synthetic root says only "something
 * broke", while one parented on the interaction's span says "*this* click
 * broke, here, after these three requests". `error_count` is one of the fixed
 * metric ids of AAP 0.2.3 and is computed by `../aggregate/summary.ts` from
 * exactly these events.
 *
 * ## Absolute non-interference
 *
 * The page's error behaviour must be byte-for-byte what it was without the
 * agent attached, because a developer debugging a failure reads their own
 * console, their own error overlay and their own reporting pipeline while they
 * do it. The rules this module keeps, structurally rather than by inspection:
 *
 * - **`addEventListener` only.** `window.onerror` and
 *   `window.onunhandledrejection` are single-slot properties the application
 *   (or its framework, or Sentry) may own; assigning either would clobber that
 *   handler. Nothing here writes to them, and nothing here reads them.
 * - **Nothing is cancelled.** No `preventDefault`, no `stopPropagation`, no
 *   `stopImmediatePropagation` — which is also why both listeners are
 *   registered `passive: true`: the host then treats a cancellation as a no-op
 *   even if one were ever introduced here by accident. Cancelling an `error`
 *   event suppresses the console report, and cancelling an
 *   `unhandledrejection` event suppresses the unhandled-rejection report; both
 *   are the developer's evidence, not the agent's to withhold.
 * - **The rejected promise is never touched.** Attaching a `.catch` to
 *   `event.promise` would mark the rejection handled and silence the very
 *   report the developer is looking at, so this module does not read
 *   `promise` at all. Only `reason` is summarised.
 * - **Nothing is re-thrown, and nothing thrown escapes.** A throw from inside
 *   an `error` listener becomes a second error event, which would reach this
 *   same listener: the shape of an infinite loop. Every handler body sits
 *   inside a `try`/`catch`, and a re-entrancy guard makes the loop
 *   impossible rather than merely unlikely.
 *
 * ## Only a branded error has its fields read
 *
 * A thrown value or a rejection reason is an arbitrary application value, and
 * the three fields worth recording — `name`, `message`, `stack` — are read
 * only from a value the language itself vouches for as an error
 * ({@link isBrandedError}: `Error.isError`, the `[[ErrorData]]` internal-slot
 * check, whose answer is final where the host has it, and on a host without it
 * a brand the value cannot supply for itself). Every other value contributes
 * its category tag, `[object]` or `[array]` or `[dom]`, and no property of it
 * is touched at all.
 *
 * The predicate reads a *brand*, never a shape, and nothing forgeable may
 * overturn it. Duck typing is the failure it replaced: an object's `name` and
 * `message` are the application's to shape, so "looks like an error" is a test
 * the application passes whenever it rejects a record of its own — a response
 * payload, a validation model, a GraphQL error list — and every such record
 * would then be copied into the capture, persisted, tailed to DevTools and
 * aggregated into model input (AAP 0.5.2). `instanceof`, a prototype
 * declaration and a self-declared `Symbol.toStringTag` are all shapes of the
 * same failure, one indirection further out, which is why none of them is
 * consulted either.
 *
 * ## Why this file does not redact
 *
 * Messages and stacks are recorded verbatim (bounded, see below) and scrubbing
 * happens downstream: `apps/local-service/src/telemetry/ingest.ts` runs
 * `redactEvent()` before an event is persisted, broadcast or tailed, and
 * `packages/model-provider/src/redact-guard.ts` scrubs again on the outbound
 * model path (AAP 0.5.2). In-page redaction is reserved for React prop and
 * state previews in `./fiber-diff.ts`, whose raw values are of no use to
 * anything downstream and so are never allowed to leave the page in the first
 * place — an error message, by contrast, *is* the evidence the panel renders,
 * and scrubbing it twice at two different fidelities would leave the developer
 * reading a worse version of their own console.
 *
 * Bounding, unlike scrubbing, does happen here. {@link MAX_MESSAGE_CHARS} and
 * {@link MAX_STACK_CHARS} cut a message and a stack before either enters the
 * event buffer, and {@link MAX_ERRORS_PER_CAPTURE} caps how many events one
 * capture may contribute: an exception inside a render loop fires thousands of
 * times a second, and an unbounded producer would evict the rest of the
 * capture from `./transport.ts`'s queue to make room for the same stack
 * repeated. Drops are counted and reported through {@link getErrorStats} — a
 * cap that hides its own effect would understate `error_count`.
 *
 * ## Source locations stay strings
 *
 * A browser stack names generated chunks (`…/_next/static/chunks/page.js`), so
 * the frames here are worth nothing to an editor as they stand. They travel
 * verbatim as text and the service maps them back to project source with
 * `packages/code-analysis/src/source-map/*` (AAP 0.4.2, the source-resolution
 * path). This module therefore never builds a `SourceLocation`: only
 * `./span-helper.ts` may, and only from patch metadata it can trust.
 *
 * ## Scope
 *
 * The browser tier only. The Node preload has its own `server.error` kind for
 * an exception raised while handling a request (`../node/convert.ts`), and
 * emitting that kind from here would put a browser-tier event under a
 * server-only kind, which `../schema/event.ts`'s kind/tier check rejects
 * outright.
 *
 * ## Imports and side effects
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this file into the IIFE
 * injected into the developer's page at `document_start` and hard-fails on any
 * input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared/node` or `zod`. The four imports below are therefore the
 * whole list: ids and transport for emission and for the bounded
 * producer-failure report this module's guards send, interaction for
 * attribution, and the two dependency-free schema vocabularies type-only, so
 * no vocabulary table reaches the page bundle at runtime (the same shape
 * `./interaction.ts` uses). `./agent.ts` is deliberately absent — it drives
 * this module, and an import back would close a cycle.
 *
 * Nothing observable happens at import time. Module scope here is one page
 * document, and a listener exists only between {@link attachErrors} and
 * {@link detachErrors}: a dormant agent on a page the developer is merely
 * browsing observes no failure at all (AAP 0.5.1, runtime hooks are "disabled,
 * not merely idled").
 *
 * @see ./interaction.ts for the attribution contract every producer shares.
 * @see ../schema/attributes.ts for the `error` attribute vocabulary.
 */

import { resolveEventContext } from './interaction.js';
import { newSpanId } from './ids.js';
import { emit, nowEpochMs, reportProducerFailure, type EventDraft } from './transport.js';
import type { AttributeValueType, ERROR_ATTRIBUTE_KEYS } from '../schema/attributes.js';
import type { TelemetryKind, TelemetryStatus } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Contract constants
 *
 * Exported because each one is part of a contract a consumer reasons about
 * rather than a tuning knob: `./agent.ts` reports the stats these bounds
 * produce, and a test that asserts a cap has to name the same number the
 * producer applies.
 * ---------------------------------------------------------------------------
 */

/**
 * The three shapes of failure this module records, and the closed value set of
 * the `errorType` attribute.
 *
 * - `error` — a script error: an exception that reached the page's `error`
 *   event with a message, whether thrown synchronously or from a timer.
 * - `unhandledrejection` — a promise that rejected with nothing to handle it.
 * - `resource` — an element whose resource failed to load (an image, a script,
 *   a stylesheet). It arrives as an `error` event too, which is why the two
 *   are discriminated by this attribute and not by the event name.
 *
 * The three are one kind (`error`) rather than three, because every consumer
 * treats them together: `error_count` counts failures, and the event log's
 * error filter shows failures. The discriminator is what lets a panel say
 * *which* sort of failure it is showing.
 */
export const ERROR_TYPES = ['error', 'unhandledrejection', 'resource'] as const;

/** One member of the closed captured-error-type vocabulary. */
export type CapturedErrorType = (typeof ERROR_TYPES)[number];

/**
 * The largest stack, in UTF-16 code units, that may enter an event.
 *
 * A stack is the most useful attribute on an error event and the least
 * bounded thing a host will hand you: a deep React tree with an async chain
 * produces tens of kilobytes, and a recursion that overflowed the stack can
 * produce megabytes of identical frames. Four kilobytes is roughly forty
 * frames — far more than the source-map resolver needs to find the call site,
 * and small enough that a render loop's worth of them cannot crowd the rest of
 * the capture out of `./transport.ts`'s queue.
 */
export const MAX_STACK_CHARS = 4096;

/**
 * The largest message, URL or stringified rejection reason, in UTF-16 code
 * units, that may enter an event.
 *
 * Matches `../schema/event.ts`'s own bound on a span name, so a message and a
 * name are bounded alike, and is deliberately far above
 * `../schema/attributes.ts`'s 120-code-point preview bound: a preview
 * describes an application value the product has no business copying, whereas
 * a message is the sentence the developer is trying to read.
 */
export const MAX_MESSAGE_CHARS = 512;

/**
 * The most error events one capture may contribute.
 *
 * An exception thrown from a render or an effect repeats on every attempt, so
 * the natural volume of this signal is "as fast as the page can loop". The cap
 * bounds emission *attempts*, so a failing emit cannot loop either, and every
 * suppressed failure is counted in {@link ErrorStats.dropped}: the panel can
 * then say that the capture hit the cap instead of quietly reporting two
 * hundred as the total. The counters restart at {@link attachErrors}, which is
 * what makes the bound per capture rather than per document.
 */
export const MAX_ERRORS_PER_CAPTURE = 200;

/*
 * ---------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------
 */

/**
 * The `kind` every event this module emits carries.
 *
 * Typed as {@link TelemetryKind} so the spelling is checked against
 * `../schema/kinds.ts`'s closed vocabulary at compile time. `error` is
 * declared there as browser-only, which is exactly what a producer on this
 * tier needs for the event schema's kind/tier agreement check to pass — and
 * why `server.error`, the server tier's equivalent, can never be emitted from
 * here.
 */
const ERROR_KIND: TelemetryKind = 'error';

/**
 * The `status` every event this module emits carries.
 *
 * Typed against `../schema/kinds.ts`'s status vocabulary. A failure is the
 * event's subject, so `error` is not a detail of the outcome here — it *is*
 * the outcome, and a filter on `status` finds these events without knowing
 * the kind vocabulary.
 */
const ERROR_STATUS: TelemetryStatus = 'error';

/**
 * The duration every event this module emits carries.
 *
 * **Zero is deliberate, not a missing measurement.** An exception is an
 * instant: it has a moment and no extent, and the honest span for it is a
 * point. A nominal non-zero duration would draw a bar on the timeline and
 * enter the per-tier duration metrics as time the interaction never spent.
 */
const ERROR_DURATION_MS = 0;

/** The captured type of a script error, bound to {@link ERROR_TYPES}. */
const TYPE_SCRIPT: CapturedErrorType = 'error';

/** The captured type of an unhandled promise rejection. */
const TYPE_REJECTION: CapturedErrorType = 'unhandledrejection';

/** The captured type of a failed resource load. */
const TYPE_RESOURCE: CapturedErrorType = 'resource';

/**
 * Listener options for the `error` event.
 *
 * `capture: true` is load-bearing: a resource-load error does **not** bubble,
 * so a bubble-phase listener on `window` never sees a broken image or a script
 * that failed to load at all. The capture path starts at `window`, which also
 * means this listener runs before the application's own bubble-phase handler
 * rather than after it.
 *
 * `passive: true` states the non-interference contract to the host as well as
 * to the reader: a passive listener's `preventDefault` is a no-op, so the
 * page's own error reporting cannot be suppressed from here even by mistake.
 *
 * One frozen object, reused for `addEventListener` and `removeEventListener`,
 * because removal matches on the capture flag and a mismatched flag leaves a
 * listener attached after detach.
 */
const ERROR_LISTENER_OPTIONS: AddEventListenerOptions = Object.freeze({
  capture: true,
  passive: true,
});

/**
 * Listener options for the `unhandledrejection` event.
 *
 * Bubble phase (the default): the event is dispatched at `window` itself, so
 * there is no capture path to be early on. `passive: true` for the same reason
 * as above — a rejection report the developer expects must not be cancellable
 * from here.
 */
const REJECTION_LISTENER_OPTIONS: AddEventListenerOptions = Object.freeze({
  capture: false,
  passive: true,
});

/** The event type that carries script errors and resource-load failures. */
const ERROR_EVENT_TYPE = 'error';

/** The event type that carries unhandled promise rejections. */
const REJECTION_EVENT_TYPE = 'unhandledrejection';

/*
 * ---------------------------------------------------------------------------
 * Failure-report stages
 *
 * `./transport.ts`'s `reportProducerFailure('errors', stage, …)` turns one of
 * this module's contained failures into a single `agent.error` frame
 * (`code: 'producer-failure'`), bounded to `MAX_PRODUCER_FAILURE_REPORTS` per
 * source per capture and carrying only the source, the stage below and the
 * thrown value's *type* name. That bound and that sanitization live there, so
 * nothing here rate-limits and nothing here passes a page string — no
 * message, no URL, no rejection value — in a stage or a detail field.
 *
 * Why report at all: a swallowed failure used to be visible only as
 * `getErrorStats().failures`, which nothing outside the page reads, so a
 * capture could lose the error signal entirely while both UIs showed a
 * capture that succeeded. AAP 0.5.5 requires the missing signal to be stated
 * rather than inferred.
 *
 * One stage id per distinct thing that can go wrong, because the stage is what
 * a developer reads in the frame:
 *
 * - {@link STAGE_RECORD} — a failure arrived and could not be turned into an
 *   event. The capture is short one error row.
 * - {@link STAGE_ATTACH} — the hook could not be armed. The capture has no
 *   error signal at all.
 * - {@link STAGE_ERROR_LISTENER_REMOVE} /
 *   {@link STAGE_REJECTION_LISTENER_REMOVE} — a listener could not be taken
 *   off the window, so instrumentation outlived the capture (AAP 0.5.1).
 * - {@link STAGE_DETACH_RESIDUAL} — which listeners that detach left behind.
 * - {@link STAGE_DETACH_STATE_RESET} — the state reset itself failed.
 *
 * Deliberately *not* reported: the per-field guards in `readProperty`,
 * `isDomNode`, `isErrorLike` and `readTagName`. Each costs one attribute of
 * one event and leaves the event itself intact, they run once per property of
 * every failure on a page that may be failing in a loop, and one hostile
 * accessor would otherwise spend this source's whole four-frame budget on a
 * truncated stack while a genuinely lost signal went unreported.
 * ---------------------------------------------------------------------------
 */

/** A failure raised while summarising or emitting one observed failure. */
const STAGE_RECORD = 'record';

/** A failure raised while registering the listeners in {@link attachErrors}. */
const STAGE_ATTACH = 'attach';

/** A failure raised removing the `error` listener in {@link detachErrors}. */
const STAGE_ERROR_LISTENER_REMOVE = 'error-listener-remove';

/** A failure raised removing the `unhandledrejection` listener. */
const STAGE_REJECTION_LISTENER_REMOVE = 'rejection-listener-remove';

/** Listeners still on the window after {@link detachErrors} returned. */
const STAGE_DETACH_RESIDUAL = 'detach-residual';

/** A failure raised resetting module state in {@link detachErrors}. */
const STAGE_DETACH_STATE_RESET = 'detach-state-reset';

/*
 * ---------------------------------------------------------------------------
 * Attribute keys
 *
 * Every key this module writes, bound to `../schema/attributes.ts` where that
 * module declares an equivalent. The declared ones are typed as members of the
 * `error` tuple, so renaming or dropping one there fails compilation here
 * rather than silently producing an event whose attributes no consumer reads;
 * the invented ones are typed as plain strings and each documents what
 * `attributes.ts` should adopt.
 *
 * `ERROR_ATTRIBUTE_KEYS` — `KIND_ATTRIBUTE_KEYS.error`, equivalently
 * `attributeKeysFor('error')` — declares five keys: `error.type`,
 * `error.message`, `error.stack`, `error.source` and `component`. Four of the
 * five are written below. `component` is not: resolving the React component in
 * scope would mean reading the fiber tree through `./dom-target.ts` or
 * `./react.ts`, neither of which this module may import, and a guessed
 * component name on an error event would be worse than an absent one. The
 * attribution that matters is already carried structurally — the event's
 * `parentSpanId` is the interaction's span, so a panel joins the failure to
 * the click without a component attribute.
 * ---------------------------------------------------------------------------
 */

/** One member of `ERROR_ATTRIBUTE_KEYS`, the `error` vocabulary. */
type DeclaredErrorKey = (typeof ERROR_ATTRIBUTE_KEYS)[number];

/**
 * The failure's type as the language names it: `TypeError`, `RangeError`,
 * `DOMException`, or the value category of a thrown non-error
 * (`[string]`, `[object]`).
 *
 * The same meaning `../node/convert.ts` gives the key when it fills it from a
 * recorded exception's type on a `server.error` event, so a panel that groups
 * failures by type groups both tiers the same way. Absent when the host
 * reported no thrown value at all — a cross-origin script error, or a resource
 * that failed to load, neither of which has a class.
 */
const KEY_ERROR_TYPE: DeclaredErrorKey = 'error.type';

/** The failure's message, bounded by {@link MAX_MESSAGE_CHARS}. */
const KEY_ERROR_MESSAGE: DeclaredErrorKey = 'error.message';

/**
 * The stack as the host reported it, verbatim and bounded by
 * {@link MAX_STACK_CHARS}.
 *
 * Generated-chunk coordinates: the service's source-map resolver maps the
 * frames back to project source (AAP 0.4.2). Absent when the thrown value
 * carried no stack, which is the normal case for a thrown string and for a
 * cross-origin script error.
 */
const KEY_ERROR_STACK: DeclaredErrorKey = 'error.stack';

/**
 * The location the event itself reported: the script URL for a script error,
 * the resource URL (`src` or `href`) for a failed resource load.
 *
 * The URL is recorded raw rather than normalised — it is the string the host
 * gave, and the resolver needs it to match a chunk's source map — and bounded
 * by {@link MAX_MESSAGE_CHARS}. The line and column that complete the location
 * travel in {@link KEY_ERROR_LINENO} and {@link KEY_ERROR_COLNO}, so no
 * consumer has to parse a composite string.
 */
const KEY_ERROR_SOURCE: DeclaredErrorKey = 'error.source';

/**
 * Which shape of failure this is: one of {@link ERROR_TYPES}.
 *
 * **Invented here**, and named by the AAP's own description of this signal
 * ("`error`/`unhandledrejection` capture", AAP 0.7.1 Group 1). It is not
 * `error.type`: that key holds the exception's *class*, and collapsing the two
 * would make a `TypeError` thrown synchronously indistinguishable from the
 * same `TypeError` rejecting a promise — the distinction that tells a
 * developer whether their `await` is missing. Deliberately spelled without the
 * `error.` prefix so it cannot be mistaken for the OpenTelemetry-shaped
 * exception group. `../schema/attributes.ts` should adopt this spelling in the
 * `error` tuple.
 */
const KEY_ERROR_TYPE_CAPTURED = 'errorType';

/**
 * The 1-based line in {@link KEY_ERROR_SOURCE} the event reported.
 *
 * **Invented here.** The `error` tuple declares the source but not the
 * position inside it, and a file-level location is not enough to open an
 * editor at the failure — which is the interaction AAP 0.4.2 specifies for
 * every runtime item. Written only when the host reported a usable value;
 * hosts report `0` for "unknown", and a zero line would send the editor to
 * the top of a file and call it the answer. `../schema/attributes.ts` should
 * adopt this spelling.
 */
const KEY_ERROR_LINENO = 'error.lineno';

/**
 * The 1-based column in {@link KEY_ERROR_SOURCE} the event reported.
 *
 * **Invented here**, for the same reason as {@link KEY_ERROR_LINENO}: a source
 * map resolves a generated position, which is a line *and* a column, so
 * dropping the column costs the mapping its precision on a bundled line
 * holding several statements.
 */
const KEY_ERROR_COLNO = 'error.colno';

/**
 * The lowercased tag name of the element whose resource failed to load.
 *
 * **Not in the `error` tuple**, but not a new word either: `target.tagName` is
 * the spelling `INTERACTION_ATTRIBUTE_KEYS` already uses for an element's tag
 * name, and a panel that shows an interaction and a resource failure side by
 * side reads one key for both. Written only for a `resource` failure, and
 * accompanied by nothing else about the element — no text content, no other
 * attributes — because a failed `<img>` in a private application view is
 * evidence about a load, not an invitation to describe the page.
 * `../schema/attributes.ts` should add it to the `error` tuple.
 */
const KEY_TARGET_TAG_NAME = 'target.tagName';

/**
 * Whether a bound cut any of this event's text.
 *
 * **Invented here.** `../schema/attributes.ts` makes the principle explicit
 * for summarised values (`AttributeValueSummary.truncated`: "a consumer never
 * presents a shortened preview as a whole value"), and the same principle
 * applies to a stack: a resolver reading the last frame of a *cut* stack is
 * reading the point where this module stopped copying, not the bottom of the
 * call chain. Written only when something was actually cut, so an ordinary
 * error event carries one attribute fewer. `../schema/attributes.ts` should
 * adopt this spelling.
 */
const KEY_ERROR_TRUNCATED = 'error.truncated';

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * A cheap, honest picture of what this module has recorded, as
 * {@link getErrorStats} reports it.
 *
 * Cumulative for the current capture: the counters restart at
 * {@link attachErrors} and survive {@link detachErrors}, so a reader can ask
 * after a capture has stopped how many failures it contained. Every failure
 * this module saw is in exactly one of the three numbers, which is what makes
 * "the cap was reached" and "emission is broken" different observations
 * instead of one silence.
 */
export interface ErrorStats {
  /**
   * Events handed to `./transport.ts`'s `emit` without it throwing.
   *
   * What this module *emitted*, not what was delivered: the transport drops
   * everything outside a capture and reports its own queue, send and drop
   * counts through `getTransportStats()`. The two are read together.
   */
  emitted: number;
  /**
   * Failures observed and deliberately not emitted: those past
   * {@link MAX_ERRORS_PER_CAPTURE}, and those arriving re-entrantly while an
   * emission was already in progress.
   */
  dropped: number;
  /**
   * Failures whose handling threw: an emission that raised, or a host object
   * whose own property access raised.
   *
   * Never zero-cost to ignore — a non-zero value here means the error signal
   * is incomplete for a reason that is this module's fault rather than the
   * cap's — and never fatal: the page saw nothing.
   */
  failures: number;
}

/*
 * ---------------------------------------------------------------------------
 * Internal types
 * ---------------------------------------------------------------------------
 */

/** A string after a bound was applied, and whether the bound cut it. */
interface BoundedText {
  /** The kept prefix, at most the requested number of code units. */
  text: string;
  /** Whether anything was removed. */
  truncated: boolean;
}

/**
 * What could be learned about a thrown value or a rejection reason without
 * serialising it.
 *
 * Deliberately three optional strings and a type tag rather than the value
 * itself: AAP 0.5.2 keeps application data out of the capture, and an
 * arbitrary rejection reason is application data — a response object, a form
 * model, a class instance holding a session. An `Error` is the one shape whose
 * three well-known fields *are* the diagnostic, so those three are read (each
 * inside its own guard, because a getter on an application object is user
 * code) and nothing else ever is.
 */
interface DescribedValue {
  /**
   * The value's class, when the value was a branded error
   * ({@link isBrandedError}): `TypeError`, `DOMException`, whatever the
   * application named its error subclass.
   *
   * Kept apart from {@link type} because it is the one field fit to become an
   * event `name`: a class groups a hundred occurrences of one bug into one
   * row, whereas a category tag (`[string]`) says nothing a panel can group
   * on. Absent for every non-error value.
   */
  className?: string;
  /**
   * `error.type`: the class name when there was one, otherwise the value's
   * category tag (`[string]`, `[object]`, `[function]`).
   */
  type?: string;
  /**
   * An `Error`'s message, or a primitive's text, already bounded by
   * {@link MAX_MESSAGE_CHARS}. Absent for an object, which is described by its
   * tag alone.
   */
  message?: string;
  /**
   * An `Error`'s stack, already bounded by {@link MAX_STACK_CHARS}. Absent for
   * everything else — a thrown string has no stack, and inventing one would
   * point the source-map resolver at a frame that does not exist.
   */
  stack?: string;
  /** Whether a bound cut any of the three fields above. */
  truncated: boolean;
}

/**
 * One failure, fully summarised and bounded, ready to become an event.
 *
 * The handlers produce this and {@link emitCaptured} consumes it, which keeps
 * "what the host told us" separate from "what an event looks like": the
 * discrimination between a script error and a resource error is decided once,
 * in one place, and the emission path has no branches on the event's origin.
 */
interface CapturedError {
  /** Which shape of failure this is; becomes `errorType`. */
  errorType: CapturedErrorType;
  /** The event's `name`: a compact, low-cardinality label, never a message. */
  name: string;
  /** The exception's class or the thrown value's category tag. */
  type?: string;
  /** The bounded message. */
  message?: string;
  /** The bounded stack, verbatim from the host. */
  stack?: string;
  /** The bounded script or resource URL the event reported. */
  source?: string;
  /** The 1-based line the event reported, when it reported a usable one. */
  lineno?: number;
  /** The 1-based column the event reported, when it reported a usable one. */
  colno?: number;
  /** The lowercased tag name of a failed resource's element. */
  tagName?: string;
  /** Whether a bound cut the message, the stack or the URL. */
  truncated: boolean;
}

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * Module scope is one page document — the same scope `./transport.ts` numbers
 * its sequence in and `./ids.ts` memoizes its producer id in — so these are
 * one document's listeners and one capture's counters. Declaring two
 * `undefined`s, a few zeroes and two booleans is not a side effect: nothing
 * observable happens until a function is called.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether this module is *observing* — the single condition {@link record}
 * gates on.
 *
 * Deliberately not "whether a listener is registered": the two can disagree,
 * and when they do, this is the one that decides whether anything is recorded.
 * {@link detachErrors} clears it before it touches the window, so a listener
 * the page refuses to remove is inert from that moment on. What is still
 * registered is stated by {@link errorListener} and
 * {@link rejectionListener}, which are the residue a later detach retries.
 */
let attached = false;

/**
 * The exact `error` listener reference while it is (or may still be) on the
 * window, and `undefined` once its removal has returned.
 *
 * Two jobs, and the second is why it is cleared *after* the removal rather
 * than before it. First, `removeEventListener` matches on the function
 * identity and the capture flag, so a fresh closure or a mismatched flag at
 * detach would leave the page with a listener the agent can no longer reach.
 * Second, the reference *is* the record of un-finished teardown: a removal
 * that threw leaves it set, which is what lets the next {@link detachErrors}
 * retry the same listener and what stops {@link attachErrors} from adding a
 * second one beside it.
 */
let errorListener: ((event: Event) => void) | undefined;

/** The exact `unhandledrejection` listener reference, for the same reasons. */
let rejectionListener: ((event: Event) => void) | undefined;

/**
 * Whether a failure is being handled right now.
 *
 * The re-entrancy guard. An `error` listener that throws produces another
 * `error` event, which reaches this same listener: without a guard, one
 * failing emission is an unbounded loop inside the developer's page. With it,
 * the nested arrival is counted as a drop and returns immediately, so the
 * recursion is one frame deep by construction rather than by luck.
 */
let handling = false;

/** Events successfully handed to `emit` in this capture. */
let emittedCount = 0;

/** Failures observed and not emitted in this capture. */
let droppedCount = 0;

/** Failures whose handling threw in this capture. */
let failureCount = 0;

/*
 * ---------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------
 */

/**
 * Cut a string to at most `maxChars` UTF-16 code units without splitting a
 * surrogate pair, and report whether anything was removed.
 *
 * Cheap by construction: a string already inside the bound is returned as it
 * stands, and a long one costs one slice and one code-unit inspection — no
 * iteration, no array, no regular expression. That matters because the input
 * can be a multi-megabyte stack from a runaway recursion, arriving inside the
 * page's own error handling.
 *
 * Nothing is appended. An ellipsis would make the result longer than the bound
 * a caller asked for and would corrupt the last stack frame the resolver
 * reads; the cut is reported through {@link BoundedText.truncated} and ends up
 * on the event as `error.truncated` instead.
 *
 * Splitting a surrogate pair would leave a lone half at the end, which is a
 * well-formed JavaScript string but an ill-formed one to send: it survives
 * `postMessage` and then turns into a replacement character somewhere
 * downstream. Dropping the whole pair costs one character and keeps the text
 * valid all the way to the panel.
 */
function boundText(value: string, maxChars: number): BoundedText {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  let end = maxChars;
  const lastKept = value.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) {
    // A high surrogate at the boundary owns the code unit that follows it.
    end -= 1;
  }

  return { text: value.slice(0, end), truncated: true };
}

/**
 * Assign a bounded string to one of {@link CapturedError}'s text fields and
 * carry its truncation flag onto the record.
 *
 * One helper instead of three repetitions of bound-assign-or-flag: the
 * truncation flag is the kind of bookkeeping that is quietly forgotten at the
 * third call site, and forgetting it presents a cut stack as a whole one.
 */
function assignBounded(
  captured: CapturedError,
  field: 'message' | 'stack' | 'source',
  value: string,
  maxChars: number,
): void {
  const bounded = boundText(value, maxChars);
  captured[field] = bounded.text;
  if (bounded.truncated) {
    captured.truncated = true;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Reading values the page owns
 *
 * Everything below reads properties off objects the application created, on
 * the page's own error path. Three rules apply to all of it: every read is
 * individually guarded, because a property on an application object can be an
 * accessor and an accessor is user code that may throw; nothing is enumerated,
 * cloned or serialised, because AAP 0.5.2 keeps application data out of the
 * capture; and no method the page could have replaced is invoked on a value —
 * in particular neither `toJSON` nor `toString`, which is why a non-primitive
 * reason is described by a tag rather than by its own idea of itself.
 * ---------------------------------------------------------------------------
 */

/**
 * Read one property, or `undefined` if it cannot be read.
 *
 * Returns `unknown` deliberately: the caller narrows with a `typeof` check, so
 * nothing untyped from the page can flow into an event.
 */
function readProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }

  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    // A throwing accessor costs this one field and nothing else.
    return undefined;
  }
}

/** {@link readProperty} narrowed to a string. */
function readStringProperty(value: unknown, key: string): string | undefined {
  const read = readProperty(value, key);
  return typeof read === 'string' ? read : undefined;
}

/**
 * Read a 1-based source position (`lineno`, `colno`), or `undefined` when the
 * host did not report a usable one.
 *
 * Hosts report `0` for "unknown", and a zero line is worse than no line: it
 * would open the developer's editor at the top of a file and present that as
 * the failure site. Non-integral values are floored rather than rejected,
 * because the contract downstream is a 1-based integer position.
 */
function readPositionProperty(value: unknown, key: string): number | undefined {
  const read = readProperty(value, key);
  if (typeof read !== 'number' || !Number.isFinite(read) || read < 1) {
    return undefined;
  }
  return Math.floor(read);
}

/**
 * Render a value's category as a short, fixed string: `[string]`,
 * `[function]`, `[dom]`, `[object]`.
 *
 * The categories are `../schema/attributes.ts`'s `AttributeValueType`
 * vocabulary — the same words `./transport.ts` writes when it tags a value it
 * would not clone and `./fiber-diff.ts` writes in a value summary — so a panel
 * needs one way to read all three. The vocabulary is imported for its type
 * only; spelling a tag is a template literal, not a table lookup.
 */
function typeTag(type: AttributeValueType): string {
  return `[${type}]`;
}

/** Whether a value is, or convincingly claims to be, a DOM node. */
function isDomNode(value: unknown): boolean {
  try {
    return typeof Node !== 'undefined' && value instanceof Node;
  } catch {
    // A page that replaced `Node` with a throwing proxy gets the generic
    // object tag; the value is described either way.
    return false;
  }
}

/** The `AttributeValueType` category a value belongs to. */
function categoryOf(value: unknown): AttributeValueType {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (isDomNode(value)) {
    return 'dom';
  }

  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'function':
      return 'function';
    case 'undefined':
      return 'undefined';
    case 'object':
      return 'object';
    default:
      // No other `typeof` result exists today; a future one is described
      // honestly rather than guessed at.
      return 'unknown';
  }
}

/**
 * The text of a primitive, or `undefined` for anything that is not one.
 *
 * `String()` on a number, a boolean or a bigint runs the language's own
 * conversion rather than a method the page could have replaced, and a symbol
 * contributes its `description` — a string the program itself wrote — instead
 * of a `Symbol.prototype.toString` call. An object contributes nothing at all:
 * that is the "summarised, never serialised" rule, and it is why a rejection
 * carrying a response body leaves the body on the page.
 */
function primitiveTextOf(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return value.description;
    default:
      return undefined;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Error branding
 *
 * Only a value the language itself calls an error has its `name`, `message`
 * and `stack` read. Everything else — however error-shaped it looks — is
 * described by its category tag alone, and no property of it is ever touched.
 *
 * **The brand is proof, not resemblance, and a proven negative is final.**
 * Exactly one thing in the language answers "is this an error" from an
 * internal slot the page cannot write: `Error.isError`, which reads
 * `[[ErrorData]]`. Where the host has it, its answer *is* this module's
 * answer — including its `false`, which no weaker check may overturn. That
 * ordering is the whole design, because every other available signal is
 * forgeable in one line of page code:
 *
 * - `value instanceof Error` consults `Error[Symbol.hasInstance]` and the
 *   prototype chain, both of which the page owns, and it is already `true`
 *   for `Object.create(Error.prototype)` — an object with no error slot,
 *   whose `message` and `stack` are whatever the application put there.
 * - `Object.prototype.toString.call(value)` returns a value's
 *   `Symbol.toStringTag` — own **or inherited** — in preference to any
 *   internal slot, so `Object.create({ [Symbol.toStringTag]: 'Error' })`
 *   brands itself `[object Error]` while owning no property at all.
 *
 * So `instanceof` is not consulted here, and the brand string is trusted only
 * on a host with no `Error.isError` at all, and then only for a value that
 * carries no `@@toStringTag` anywhere on its prototype chain. That condition
 * is what separates the two: a real `Error` never carries a tag at any level,
 * because `Error.prototype` defines none, while a forgery has nowhere left to
 * put its claim.
 *
 * The consequence worth stating: on such a host a `DOMException` is described
 * as `[object]` rather than by its class, because nothing there can prove its
 * brand. That is the deliberate trade — an unprovable brand costs a class
 * name, while a forgeable one costs the developer's data (AAP 0.5.2) — and it
 * is unreachable on the hosts this product declares, where `Error.isError`
 * exists and WebIDL gives `DOMException` the same `[[ErrorData]]` slot a
 * built-in error has.
 *
 * Both intrinsics are captured here, at module evaluation, rather than read at
 * the moment a failure arrives. This module is bundled into the agent IIFE
 * injected at `document_start`, so module evaluation happens before the page's
 * first line of script: the references below are the realm's own whatever the
 * page later installs over `Error.isError` or `Object.prototype.toString`.
 * Read at call time, a polyfill bundle — or a page that deliberately reshapes
 * the intrinsics — would get a vote on what this module treats as an error,
 * and so on which of its own objects get copied into the capture.
 * ---------------------------------------------------------------------------
 */

/** The shape of `Error.isError`: a predicate over an arbitrary value. */
type ErrorBrandPredicate = (value: unknown) => boolean;

/** `Object.prototype.toString`'s answer for a genuine `Error`. */
const BRAND_ERROR = '[object Error]';

/**
 * Read `Error.isError` from the `Error` constructor, if this host has it.
 *
 * Reached through a capability read rather than a declaration because the
 * package compiles against `lib` `ES2023` + DOM (see
 * `packages/telemetry/tsconfig.json`) and `Error.isError` is typed only in
 * TypeScript's `esnext.error` library. Widening this program's `lib` to reach
 * one predicate would admit every other unshipped proposal into the preload
 * and the runtime-neutral modules too, so the single function is typed here
 * and its absence is handled ({@link hasErrorDataBrand}) instead of being
 * assumed away.
 */
function readIntrinsicIsError(): ErrorBrandPredicate | undefined {
  try {
    const candidate: unknown = (Error as unknown as { isError?: unknown }).isError;
    return typeof candidate === 'function' ? (candidate as ErrorBrandPredicate) : undefined;
  } catch {
    // A page that made `Error.isError` a throwing accessor costs this route
    // and nothing else: the brand check below still answers.
    return undefined;
  }
}

/**
 * The intrinsic error brand check, or `undefined` on a host without one.
 *
 * `Error.isError` is the one predicate exposed to script that answers from the
 * `[[ErrorData]]` internal slot — which is to say the one that answers "is
 * this an error" without consulting anything the page can forge. It is true
 * for `new Error`, for a `DOMException`, and for an error from another realm,
 * and false for `{ name, message, stack }` however carefully that object is
 * dressed.
 */
const intrinsicIsError: ErrorBrandPredicate | undefined = readIntrinsicIsError();

/**
 * `Object.prototype.toString`, captured before page script could replace it
 * and typed as the `this`-taking function it is.
 *
 * Used as a free function applied to a foreign value
 * (`intrinsicObjectToString.call(value)`), which is what it is: the function
 * is specified over its `this` argument and holds no state of its own.
 * Spelling that in the type is also what keeps the capture honest to the
 * reader — nothing here is "calling a method on `Object.prototype`".
 */
const intrinsicObjectToString = (
  Object.prototype as unknown as { readonly toString: (this: unknown) => string }
).toString;

/**
 * Whether a value carries `Symbol.toStringTag` **anywhere** on itself or its
 * prototype chain.
 *
 * The question {@link hasErrorDataBrand} turns on, and the reason it asks
 * about the whole chain rather than about an own property. A tag is what makes
 * `Object.prototype.toString` report something other than the value's
 * internal slot, and a forgery needs only to inherit one:
 * `Object.create({ [Symbol.toStringTag]: 'Error' })` owns no property at all
 * and still brands itself `[object Error]`. A real `Error` — in this realm or
 * any other — carries no tag at any level, because `Error.prototype` does not
 * define one, so requiring the whole chain to be free of it costs a genuine
 * error nothing and leaves a forgery nowhere to put its claim.
 *
 * A check that throws is answered `true`, which rejects the value: the `in`
 * operator runs a `Proxy`'s `has` trap, which is page code, and a value whose
 * shape cannot be established is not one to copy fields out of.
 */
function carriesToStringTag(value: object): boolean {
  try {
    return Symbol.toStringTag in value;
  } catch {
    return true;
  }
}

/**
 * Whether `Object.prototype.toString` reports this value's `[[ErrorData]]`
 * slot, and reports it because the host said so rather than because the value
 * claimed it.
 *
 * The **only** route on a host with no {@link intrinsicIsError}, and it exists
 * for one case: an error thrown inside an iframe or a worker has a prototype
 * chain belonging to a different global, so nothing about its identity in this
 * realm reveals what it is, while it is exactly the object whose three fields
 * a developer wants to read. `Object.prototype.toString` sees through the realm
 * boundary because `[[ErrorData]]` is a property of the object and not of its
 * realm.
 *
 * It sees through it only when no `@@toStringTag` intervenes, which is why
 * {@link carriesToStringTag} is not a refinement of this route but half of
 * it: a tag anywhere on the chain replaces the slot-derived answer with a
 * string the page wrote, and trusting the brand without that condition would
 * readmit, in one line, the forgery this whole section exists to keep out.
 *
 * A `DOMException` is therefore *not* accepted here — its platform prototype
 * carries a tag — and on such a host it is described as `[object]`. See the
 * section header for why that trade is the right way round.
 */
function hasErrorDataBrand(value: object): boolean {
  try {
    if (carriesToStringTag(value)) {
      return false;
    }

    return intrinsicObjectToString.call(value) === BRAND_ERROR;
  } catch {
    // A revoked proxy or a hostile trap: described by its category tag.
    return false;
  }
}

/**
 * Whether a value is an error the language will vouch for — and deliberately
 * **not** whether it looks like one.
 *
 * Named for the brand rather than for the shape on purpose. This predicate
 * used to be `isErrorLike` and used to accept any object carrying a string
 * `name` and a string `message`, which let an ordinary rejected application
 * record — an API error payload, a GraphQL error, a validation model, any
 * class instance with a `name` field — have its `name`, `message` and `stack`
 * copied into a telemetry event, persisted by the service, tailed into
 * DevTools and, after aggregation, sent to a model provider. AAP 0.5.2 keeps
 * application data out of the capture; a duck-typed predicate cannot, because
 * the duck is the application's to shape.
 *
 * One check decides it, and a second exists only for a host that lacks the
 * first:
 *
 * 1. {@link intrinsicIsError} — the `[[ErrorData]]` internal-slot check.
 *    Where the host has it, **its answer is the answer**, `true` or `false`.
 *    It accepts every real error, in this realm or another, and a
 *    `DOMException` with it; it refuses a plain record, an object rooted at
 *    `Error.prototype`, and a `Proxy` around a real error (a proxy has no slot
 *    of its own, and reading fields through page-written traps is the last
 *    thing this module should do). Nothing weaker may overturn that `false` —
 *    an `instanceof` that the page's `Symbol.hasInstance` or prototype graph
 *    can answer for, or a brand string the value supplies itself, would make
 *    the forgeable check the deciding one.
 * 2. {@link hasErrorDataBrand} — reached only when the host has no
 *    `Error.isError` at all, or when that predicate threw rather than
 *    answered, since a throw decides nothing either way.
 *
 * `instanceof` appears nowhere in this function, and that absence is the fix:
 * it is both forgeable and already `true` for objects that have no error slot.
 *
 * A negative costs nothing but the tag: {@link describeValue} then reports
 * `[object]`, `[array]` or `[dom]` and reads no property whatsoever.
 */
function isBrandedError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (intrinsicIsError !== undefined) {
    try {
      return intrinsicIsError(value) === true;
    } catch {
      // A predicate that throws on an exotic object decides nothing, so the
      // brand check below answers instead of the value being accepted.
    }
  }

  return hasErrorDataBrand(value);
}

/**
 * Summarise a thrown value or a rejection reason: its class or category, its
 * message, its stack — and never the value itself.
 *
 * The branch is {@link isBrandedError} and nothing else. A branded error has
 * its three well-known fields read, each inside its own guard because a
 * getter on an application object is user code. Any other value — a plain
 * object, an array, a DOM node, a class instance — contributes its category
 * tag and, if it is a primitive, its own bounded text; not one of its
 * properties is read (AAP 0.5.2).
 *
 * `undefined` in means `undefined` out. A host that reported no thrown value
 * and a program that literally threw `undefined` are indistinguishable at this
 * boundary, and "nothing was reported" is the reading that cannot invent
 * evidence.
 *
 * `null`, by contrast, **is** described — as `[null]` — because a rejection
 * reason of `null` is a value the program chose. The one place where `null`
 * means "not reported" is `ErrorEvent.error`, whose default it is, and
 * {@link captureScriptError} filters it there rather than here.
 */
function describeValue(value: unknown): DescribedValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  const described: DescribedValue = { truncated: false };

  if (isBrandedError(value)) {
    const className = readStringProperty(value, 'name');
    if (className !== undefined && className.length > 0) {
      const bounded = boundText(className, MAX_MESSAGE_CHARS);
      described.className = bounded.text;
      described.type = bounded.text;
      if (bounded.truncated) {
        described.truncated = true;
      }
    } else {
      described.type = typeTag(categoryOf(value));
    }

    const message = readStringProperty(value, 'message');
    if (message !== undefined && message.length > 0) {
      const bounded = boundText(message, MAX_MESSAGE_CHARS);
      described.message = bounded.text;
      if (bounded.truncated) {
        described.truncated = true;
      }
    }

    const stack = readStringProperty(value, 'stack');
    if (stack !== undefined && stack.length > 0) {
      const bounded = boundText(stack, MAX_STACK_CHARS);
      described.stack = bounded.text;
      if (bounded.truncated) {
        described.truncated = true;
      }
    }

    return described;
  }

  described.type = typeTag(categoryOf(value));

  const text = primitiveTextOf(value);
  if (text !== undefined && text.length > 0) {
    const bounded = boundText(text, MAX_MESSAGE_CHARS);
    described.message = bounded.text;
    if (bounded.truncated) {
      described.truncated = true;
    }
  }

  return described;
}

/** Copy a description's already-bounded fields onto a captured failure. */
function applyDescribed(captured: CapturedError, described: DescribedValue | undefined): void {
  if (described === undefined) {
    return;
  }

  if (described.type !== undefined) {
    captured.type = described.type;
  }
  if (described.message !== undefined) {
    captured.message = described.message;
  }
  if (described.stack !== undefined) {
    captured.stack = described.stack;
  }
  if (described.truncated) {
    captured.truncated = true;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Capture: turning a host event into a bounded record
 * ---------------------------------------------------------------------------
 */

/**
 * Whether an `error` event is a script error rather than a resource-load
 * failure.
 *
 * A script error arrives as an `ErrorEvent` and carries a string `message`; a
 * resource that failed to load arrives as a plain `Event` dispatched at the
 * element, with no message at all. Testing for the message is what separates
 * them, and it is more honest than testing the target: `event.target` is
 * `window` for some script errors and an element for others, while the message
 * is present exactly when the host has something to say about code.
 */
function isScriptError(event: Event): boolean {
  return typeof readProperty(event, 'message') === 'string';
}

/**
 * Summarise a script error: the host's message, the thrown value's class and
 * stack, and the location the event reported.
 *
 * The event's own `message` wins over the thrown value's when both exist,
 * because the host prefixes it (`Uncaught TypeError: …`) and that is the
 * sentence sitting in the developer's console — the panel should read the
 * same. The class, the stack and the truncation flag still come from the
 * thrown value, which is the only thing that has them.
 *
 * A `null` thrown value is treated as no thrown value: `ErrorEvent.error` is
 * specified to default to `null`, and that default is exactly what a
 * cross-origin script error delivers, so describing it as `[null]` would put
 * "null was thrown" on every event whose real content the browser withheld.
 */
function captureScriptError(event: Event): CapturedError {
  const thrown = readProperty(event, 'error');
  const described = thrown === null ? undefined : describeValue(thrown);

  const captured: CapturedError = {
    errorType: TYPE_SCRIPT,
    name: described?.className ?? TYPE_SCRIPT,
    truncated: false,
  };
  applyDescribed(captured, described);

  const message = readStringProperty(event, 'message');
  if (message !== undefined && message.length > 0) {
    assignBounded(captured, 'message', message, MAX_MESSAGE_CHARS);
  }

  const source = readStringProperty(event, 'filename');
  if (source !== undefined && source.length > 0) {
    assignBounded(captured, 'source', source, MAX_MESSAGE_CHARS);
  }

  const lineno = readPositionProperty(event, 'lineno');
  if (lineno !== undefined) {
    captured.lineno = lineno;
  }

  const colno = readPositionProperty(event, 'colno');
  if (colno !== undefined) {
    captured.colno = colno;
  }

  return captured;
}

/**
 * Summarise a resource-load failure: the element's tag name and the URL it
 * failed to load, and nothing else about it.
 *
 * Two fields is the whole of it by design. An element carries its text, its
 * attributes and its position in the developer's page, none of which explains
 * a failed load and all of which would be application data entering the
 * capture (AAP 0.5.2). The `src`/`href` value is recorded raw so that it can
 * be compared with a request the agent also observed.
 */
function captureResourceError(event: Event): CapturedError {
  const target = readProperty(event, 'target');
  const tagName = readTagName(target);

  const captured: CapturedError = {
    errorType: TYPE_RESOURCE,
    // Low cardinality on purpose: `resource img` groups every broken image of
    // a capture into one row, which is what a table keyed on `name` needs.
    name: tagName === undefined ? TYPE_RESOURCE : `${TYPE_RESOURCE} ${tagName}`,
    truncated: false,
  };

  if (tagName !== undefined) {
    captured.tagName = tagName;
  }

  const url = readResourceUrl(target);
  if (url !== undefined) {
    assignBounded(captured, 'source', url, MAX_MESSAGE_CHARS);
  }

  return captured;
}

/**
 * The lowercased tag name of an event target, when it has one.
 *
 * Lowercased because HTML reports `IMG` while every selector, log line and
 * panel row in this product is written in lowercase (`./dom-target.ts`
 * lowercases the same value for an interaction target). Bounded like any other
 * text: a custom element's name is author-controlled.
 */
function readTagName(target: unknown): string | undefined {
  try {
    const tagName = readStringProperty(target, 'tagName');
    if (tagName === undefined || tagName.length === 0) {
      return undefined;
    }
    return boundText(tagName.toLowerCase(), MAX_MESSAGE_CHARS).text;
  } catch {
    // A replaced `String.prototype.toLowerCase` costs the tag name, not the
    // event: the URL below is the attribute that identifies the failure.
    return undefined;
  }
}

/**
 * The URL an element failed to load: `src` for a script, an image or a media
 * element, `href` for a stylesheet link.
 *
 * Both are reflected properties whose value is the resolved absolute URL,
 * which is what makes them comparable with a request the fetch hook recorded.
 */
function readResourceUrl(target: unknown): string | undefined {
  const src = readStringProperty(target, 'src');
  if (src !== undefined && src.length > 0) {
    return src;
  }

  const href = readStringProperty(target, 'href');
  if (href !== undefined && href.length > 0) {
    return href;
  }

  return undefined;
}

/**
 * Summarise an unhandled rejection.
 *
 * The one rule worth stating in full, because it is the rule a future edit
 * would break first: **`event.promise` is never touched.** Reading the
 * property is harmless, but the only thing a caller would then be tempted to
 * do with it — attach a handler to inspect the reason — marks the rejection
 * handled and suppresses the report the developer is waiting for. `reason` is
 * the whole input, and it is summarised, never serialised.
 */
function captureRejection(event: Event): CapturedError {
  const described = describeValue(readProperty(event, 'reason'));

  const captured: CapturedError = {
    errorType: TYPE_REJECTION,
    name: described?.className ?? TYPE_REJECTION,
    truncated: false,
  };
  applyDescribed(captured, described);

  return captured;
}

/*
 * ---------------------------------------------------------------------------
 * Emission
 * ---------------------------------------------------------------------------
 */

/**
 * The event's `name`: bounded, never empty, and never the message.
 *
 * Panel tables group by `name`, so a name carrying the message would make
 * every occurrence of one bug a distinct row and hide the fact that it
 * happened four hundred times. The captured type is the fallback, which is
 * always a non-empty member of {@link ERROR_TYPES} — and non-empty matters,
 * because `../schema/event.ts` rejects an empty name and would take the whole
 * event with it.
 */
function eventName(captured: CapturedError): string {
  const bounded = boundText(captured.name, MAX_MESSAGE_CHARS).text;
  return bounded.length > 0 ? bounded : captured.errorType;
}

/**
 * The event's attribute bag: the attribution's own attributes first, then
 * every key this module writes.
 *
 * The context's attributes are merged rather than ignored — `./interaction.ts`
 * makes that the caller's obligation, and dropping them costs the panel the
 * dashed edge that marks an ambiguous lineage — and they are merged *first*,
 * so a key this module owns can never be overwritten by one.
 *
 * A value that is unknown for this failure is omitted rather than sent as
 * `null`: absence is how this product says "not observed", and a consumer
 * reading `error.stack` needs to know the difference between a stack that was
 * not reported and a stack that was empty.
 */
function buildAttributes(
  captured: CapturedError,
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = { ...context };

  attributes[KEY_ERROR_TYPE_CAPTURED] = captured.errorType;

  if (captured.type !== undefined) {
    attributes[KEY_ERROR_TYPE] = captured.type;
  }
  if (captured.message !== undefined) {
    attributes[KEY_ERROR_MESSAGE] = captured.message;
  }
  if (captured.stack !== undefined) {
    attributes[KEY_ERROR_STACK] = captured.stack;
  }
  if (captured.source !== undefined) {
    attributes[KEY_ERROR_SOURCE] = captured.source;
  }
  if (captured.lineno !== undefined) {
    attributes[KEY_ERROR_LINENO] = captured.lineno;
  }
  if (captured.colno !== undefined) {
    attributes[KEY_ERROR_COLNO] = captured.colno;
  }
  if (captured.tagName !== undefined) {
    attributes[KEY_TARGET_TAG_NAME] = captured.tagName;
  }
  if (captured.truncated) {
    attributes[KEY_ERROR_TRUNCATED] = true;
  }

  return attributes;
}

/**
 * Emit one `error` event for a captured failure.
 *
 * The instant is read once and handed to {@link resolveEventContext}, so the
 * event's `startTime` and the window the attribution was decided against
 * cannot disagree — the contract that module documents for exactly this
 * reason.
 *
 * `duration` is {@link ERROR_DURATION_MS}, and `status` is `error`: a failure
 * is an instant whose outcome is the failure itself.
 *
 * Nothing here consults the capture state. `./transport.ts` drops every event
 * outside a capture, which is what keeps an attached-but-idle agent from
 * recording a page's failures, and duplicating that check here would be a
 * second place for the rule to drift.
 */
function emitCaptured(captured: CapturedError): void {
  const startTime = nowEpochMs();
  const context = resolveEventContext(startTime);

  const draft: EventDraft = {
    traceId: context.traceId,
    spanId: newSpanId(),
    kind: ERROR_KIND,
    name: eventName(captured),
    startTime,
    duration: ERROR_DURATION_MS,
    attributes: buildAttributes(captured, context.attributes),
    status: ERROR_STATUS,
  };

  // Assigned only when the attribution resolved one: under
  // `exactOptionalPropertyTypes` an absent field and a field set to
  // `undefined` are different things, and a synthetic root has no parent.
  if (context.parentSpanId !== undefined) {
    draft.parentSpanId = context.parentSpanId;
  }

  emit(draft);
  emittedCount += 1;
}

/**
 * The one path from a host event to an emitted event, with every guard on it.
 *
 * In order, and each for a reason that has bitten a page somewhere:
 *
 * 1. **Detached** — a listener already invoked by a dispatch that is still
 *    running can outlive {@link detachErrors}. It records nothing: a stopped
 *    capture must not grow.
 * 2. **Re-entrant** — an emission that threw would produce another `error`
 *    event reaching this same handler. Counted as a drop and returned, so the
 *    recursion cannot go a second frame deep.
 * 3. **Capped** — past {@link MAX_ERRORS_PER_CAPTURE} attempts, failures are
 *    counted and not emitted. Attempts rather than successes, so a
 *    persistently throwing emission is bounded too.
 * 4. **Guarded** — anything thrown while summarising or emitting is counted as
 *    a failure, reported once (bounded) as an `agent.error` frame and
 *    swallowed. Not re-thrown: this runs on the page's own error path, where
 *    an escaping exception would become another error event and change what
 *    the developer's own handlers see. The report is what makes the loss
 *    visible outside the page: {@link ErrorStats.failures} is a number only a
 *    diagnostics view reads, and a capture that silently lost an error row
 *    would be presented as a complete one (AAP 0.5.5).
 *
 * @param capture Summarises the host event. Called inside the guard, because
 * reading a hostile object's properties is itself a thing that can throw.
 */
function record(capture: () => CapturedError): void {
  if (!attached) {
    return;
  }

  if (handling) {
    droppedCount += 1;
    return;
  }

  if (emittedCount + failureCount >= MAX_ERRORS_PER_CAPTURE) {
    droppedCount += 1;
    return;
  }

  handling = true;
  try {
    emitCaptured(capture());
  } catch (error) {
    failureCount += 1;
    reportProducerFailure('errors', STAGE_RECORD, error);
  } finally {
    handling = false;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Teardown
 * ---------------------------------------------------------------------------
 */

/**
 * Take one listener off the window under its own guard, and say whether it
 * came off.
 *
 * **Why one guard per listener rather than one around the teardown.** The two
 * removals are independent actions on the page's window, and either can fail
 * on its own: a page (or an extension, or a test double) that has replaced
 * `removeEventListener` makes the *first* call throw, and a single surrounding
 * `try` would then skip the second call entirely — leaving a listener on the
 * window for the life of the document while the module reported itself
 * detached. AAP 0.5.1 requires runtime hooks to be "disabled, not merely
 * idled", and a leaked `error` listener is a correctness problem for the
 * page's own error handling too, not only a leak. With a guard per step, a
 * failure costs exactly its own step.
 *
 * @param type The event type exactly as it was registered.
 * @param listener The exact reference registered, or `undefined` when this
 * module holds none — in which case there is nothing to do.
 * @param options The same frozen options object registration used; removal
 * matches on the capture flag, so re-using the object is what makes the
 * removal symmetric.
 * @param stage The failure-report stage id for this listener.
 * @returns The reference to retain: `undefined` once `removeEventListener` has
 * returned (the listener is off, or was never on), and the listener itself
 * when removal threw — it is still registered, so it stays known and the next
 * {@link detachErrors} retries it.
 */
function releaseListener(
  type: string,
  listener: ((event: Event) => void) | undefined,
  options: AddEventListenerOptions,
  stage: string,
): ((event: Event) => void) | undefined {
  if (listener === undefined) {
    return undefined;
  }

  // No window means nothing was ever registered — {@link attachErrors}
  // returns early without one — so there is nothing to remove and no residue
  // worth retaining.
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    window.removeEventListener(type, listener, options);
    return undefined;
  } catch (error) {
    reportProducerFailure('errors', stage, error);
    return listener;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Start recording failures: register the capture-phase `error` listener and
 * the `unhandledrejection` listener.
 *
 * Called by `./agent.ts` when the service arms the error hook through
 * `agent.config`, and never at import time — a page the developer is merely
 * browsing gets no listener at all.
 *
 * The counters {@link getErrorStats} reports are reset here, which is what
 * makes {@link MAX_ERRORS_PER_CAPTURE} a per-capture bound: arming the hook
 * for a new capture gives it a fresh budget, and the stats of the capture that
 * just ended stay readable until then.
 *
 * **Idempotent.** A second call while attached does nothing at all — it does
 * not re-register (which would emit two events per failure) and does not reset
 * the counters (which would hand a re-configuration after a reconnect a fresh
 * budget mid-capture).
 *
 * **Re-attaching is repair, not a second installation.** A detach whose
 * removal was refused by the page retains the listener reference it could not
 * release (see {@link releaseListener}), and that listener is still on the
 * window. Registering a fresh closure for that event type would leave the page
 * with *two* of this module's listeners: every failure would be recorded
 * twice, `error_count` would double, and one of the pair would be unreachable
 * for ever. So each event type is registered only when its reference is
 * absent, and a retained reference is re-adopted — the listener that is
 * already there becomes this capture's listener again. The trade the adoption
 * makes is deliberate: on a page that has broken *both* `addEventListener` and
 * `removeEventListener`, adoption can re-arm a handler that is not in fact
 * registered, which costs events. Duplicated events and a permanently
 * unreachable listener are the worse failure — and both removals report
 * themselves, so the frames say which happened.
 *
 * Without a `window` there is nothing to listen to, so the module stays
 * detached and {@link isErrorsAttached} says so; the Node preload and the
 * service import this package without ever reaching this function.
 *
 * Never throws. A failure part-way through registration is reported and then
 * detaches, so the module is either observing or not, and a listener it could
 * not remove stays recorded rather than lost.
 */
export function attachErrors(): void {
  try {
    if (attached || typeof window === 'undefined') {
      return;
    }

    emittedCount = 0;
    droppedCount = 0;
    failureCount = 0;
    handling = false;

    if (errorListener === undefined) {
      const onError = (event: Event): void => {
        record(() =>
          isScriptError(event) ? captureScriptError(event) : captureResourceError(event),
        );
      };

      // Published before registration so that a throw from `addEventListener`
      // leaves the listener — registered or not — removable by the detach in
      // the catch below.
      errorListener = onError;
      window.addEventListener(ERROR_EVENT_TYPE, onError, ERROR_LISTENER_OPTIONS);
    }

    if (rejectionListener === undefined) {
      const onRejection = (event: Event): void => {
        record(() => captureRejection(event));
      };

      rejectionListener = onRejection;
      window.addEventListener(REJECTION_EVENT_TYPE, onRejection, REJECTION_LISTENER_OPTIONS);
    }

    attached = true;
  } catch (error) {
    reportProducerFailure('errors', STAGE_ATTACH, error);
    detachErrors();
  }
}

/**
 * Stop recording failures and release both listeners.
 *
 * Called by `./agent.ts` when the service clears the hooks — an `agent.config`
 * with every hook false, which AAP 0.5.1 requires to leave the agent
 * "disabled, not merely idled". Afterwards a later exception emits nothing —
 * always — and the page carries none of this module's listeners unless it
 * refused a removal, in which case what is left is inert, recorded and
 * reported (see below).
 *
 * Removal passes the same listener references and the same capture flags used
 * at registration, because `removeEventListener` matches on both; a mismatch
 * would leave the developer's page holding a listener the agent can no longer
 * reach.
 *
 * Three independent steps, each under its own guard, in this order and for
 * these reasons:
 *
 * 1. **Disarm.** `attached` is cleared *before* the window is touched, because
 *    it is the flag {@link record} gates on: from that assignment on nothing
 *    is recorded, whether or not the removals below succeed. A listener that
 *    cannot be taken off the page is then inert rather than a producer still
 *    feeding a stopped capture.
 * 2. **Remove, one guard each.** A failure removing the `error` listener must
 *    not skip the `unhandledrejection` listener — the defect this shape
 *    exists to make impossible. Each removal reports its own failure with its
 *    own stage id and each keeps its listener reference when it fails, so the
 *    residue is known and the *next* call retries exactly what is left (see
 *    {@link releaseListener}).
 * 3. **Reset.** The re-entrancy flag is cleared and any residue is stated, in
 *    a third guard so that neither removal can decide whether this happens.
 *
 * What remains after a refused removal is therefore an inert, *recorded*
 * listener rather than a silent leak: a later {@link detachErrors} removes it
 * once the page allows it, and {@link attachErrors} re-adopts it instead of
 * adding a second one.
 *
 * The counters are deliberately **not** reset: "how many failures did that
 * capture have" is a question asked after the capture stopped.
 *
 * Safe to call when already detached, and never throws.
 */
export function detachErrors(): void {
  // Step 1 — disarm. One assignment, nothing that can throw, and it must not
  // sit behind anything that can.
  attached = false;

  // Step 2 — the two removals, independently guarded, each retaining its own
  // reference when the page refuses it.
  errorListener = releaseListener(
    ERROR_EVENT_TYPE,
    errorListener,
    ERROR_LISTENER_OPTIONS,
    STAGE_ERROR_LISTENER_REMOVE,
  );
  rejectionListener = releaseListener(
    REJECTION_EVENT_TYPE,
    rejectionListener,
    REJECTION_LISTENER_OPTIONS,
    STAGE_REJECTION_LISTENER_REMOVE,
  );

  // Step 3 — state reset and the residue statement. Guarded even though the
  // assignment cannot throw and the reporter is contracted not to: this
  // function is called from `./agent.ts`'s message handling and from
  // {@link attachErrors}'s own catch, and it may not throw into the page on
  // any future shape of this block either.
  try {
    handling = false;

    if (errorListener !== undefined || rejectionListener !== undefined) {
      // Which hook outlived the capture, in booleans — never a page value.
      // Without this, "the agent says it detached" and "the page still carries
      // an agent listener" would both be true and nothing would say so.
      reportProducerFailure('errors', STAGE_DETACH_RESIDUAL, undefined, {
        errorListenerRetained: errorListener !== undefined,
        rejectionListenerRetained: rejectionListener !== undefined,
      });
    }
  } catch (error) {
    reportProducerFailure('errors', STAGE_DETACH_STATE_RESET, error);
  }
}

/**
 * Whether this module is observing failures right now.
 *
 * `./agent.ts` reports this in its readiness and status frames, and it is
 * `false` in a context with no `window` even after {@link attachErrors} was
 * called, because nothing was registered there.
 *
 * It answers "is anything being recorded", which is the question both UIs ask,
 * and it is `false` after {@link detachErrors} whatever the page did with the
 * removals — a listener that could not be taken off the window records
 * nothing (see {@link attached}). "Is anything still installed" is a different
 * question: {@link hasErrorsResidue} is what answers it, and a refused removal
 * also states itself in an `agent.error` frame carrying the `detach-residual`
 * stage — neither makes this function lie in either direction.
 */
export function isErrorsAttached(): boolean {
  return attached;
}

/**
 * Whether the page still carries a listener this module's last detach could
 * not remove.
 *
 * The counterpart of {@link isErrorsAttached}, and deliberately a second
 * function rather than a different answer from that one. "Attached" is this
 * folder's word for *observing*, and a listener the page refused to remove
 * observes nothing — so the two facts diverge exactly where it matters, and
 * `./agent.ts` needs both of them: its readiness and status frames report what
 * is being recorded, while the `hooks-not-released` announcement it posts once
 * every producer's `detach()` has been called has to name the registrations
 * that survived those calls. Asking {@link isErrorsAttached} for that would
 * answer a different question and conclude that everything was released, which
 * AAP 0.5.1 does not allow: a cleared hook is disabled rather than idled, and a
 * cleanup that did not complete has to be visible instead of assumed.
 *
 * `true` means exactly one thing. {@link detachErrors} ran and
 * `removeEventListener` threw for the `error` listener, for the
 * `unhandledrejection` listener, or for both, so the reference it could not
 * release is still held (see {@link errorListener}) and that listener is still
 * on the window — inert, because {@link attached} is cleared before the window
 * is touched, but present for the life of the document unless a later detach
 * gets it off. `false` means both references have been released: before the
 * first {@link attachErrors}, after a detach whose removals returned, and in a
 * context with no `window`, where nothing was ever registered.
 *
 * **A live listener during a capture is not residue.** While this module is
 * attached both references are held on purpose — holding them is what makes
 * removal symmetric — so this is `false` for as long as it is observing,
 * including after {@link attachErrors} re-adopts a retained listener rather
 * than registering a second one beside it. Residue is what outlived a detach,
 * not what a capture is using; the retained reference becomes residue again the
 * moment a detach cannot release it.
 *
 * Reports state and changes none: two reference reads and a boolean, and it
 * cannot throw, so `./agent.ts` may call it on every disarm.
 */
export function hasErrorsResidue(): boolean {
  return !attached && (errorListener !== undefined || rejectionListener !== undefined);
}

/**
 * A snapshot of this capture's error counters.
 *
 * Cheap enough to call on every render of a diagnostics view: it reads three
 * module-scope numbers and allocates one small object.
 *
 * Read together with `getTransportStats()`: `emitted` here counts what this
 * module handed to the transport, and the transport counts what it queued,
 * sent and dropped. A capture whose panel reports fewer errors than
 * {@link ErrorStats.emitted} lost them downstream, not here.
 */
export function getErrorStats(): ErrorStats {
  return { emitted: emittedCount, dropped: droppedCount, failures: failureCount };
}
