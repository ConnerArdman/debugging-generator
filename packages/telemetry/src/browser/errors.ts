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
 * whole list: ids and transport for emission, interaction for attribution, and
 * the two dependency-free schema vocabularies type-only, so no vocabulary
 * table reaches the page bundle at runtime (the same shape `./interaction.ts`
 * uses). `./agent.ts` is deliberately absent — it drives this module, and an
 * import back would close a cycle.
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
import { emit, nowEpochMs, type EventDraft } from './transport.js';
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
   * The value's class, when the value was error-like: `TypeError`,
   * `DOMException`, whatever the application named its error subclass.
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

/** Whether {@link attachErrors} has registered the listeners. */
let attached = false;

/**
 * The exact `error` listener reference, kept for symmetric removal.
 *
 * `removeEventListener` matches on the function identity and the capture flag,
 * so a fresh closure or a mismatched flag at detach would leave the page with
 * a listener the agent can no longer reach.
 */
let errorListener: ((event: Event) => void) | undefined;

/** The exact `unhandledrejection` listener reference, for the same reason. */
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

/**
 * Whether a value is an `Error`, including one from another realm.
 *
 * `instanceof` answers the ordinary case. The duck-typed fallback is what
 * catches an error thrown inside an iframe or a worker, whose prototype chain
 * belongs to a different global and therefore fails `instanceof` while being
 * exactly the object whose three fields a developer wants to read. The cost of
 * the fallback admitting a plain `{ name, message }` object is three guarded
 * property reads and a message that reads like the one the application wrote,
 * which is a good trade for not losing a real error's stack.
 */
function isErrorLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  try {
    if (value instanceof Error) {
      return true;
    }
  } catch {
    // `instanceof` against a replaced `Error` can throw; fall through.
  }

  return (
    typeof readProperty(value, 'name') === 'string' &&
    typeof readProperty(value, 'message') === 'string'
  );
}

/**
 * Summarise a thrown value or a rejection reason: its class or category, its
 * message, its stack — and never the value itself.
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

  if (isErrorLike(value)) {
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
 *    a failure and swallowed. Not re-thrown: this runs on the page's own error
 *    path, where an escaping exception would become another error event and
 *    change what the developer's own handlers see.
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
  } catch {
    failureCount += 1;
  } finally {
    handling = false;
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
 * Without a `window` there is nothing to listen to, so the module stays
 * detached and {@link isErrorsAttached} says so; the Node preload and the
 * service import this package without ever reaching this function.
 *
 * Never throws. A failure part-way through registration detaches, so the
 * module is either fully attached or fully detached and never holds a listener
 * it cannot remove.
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

    const onError = (event: Event): void => {
      record(() =>
        isScriptError(event) ? captureScriptError(event) : captureResourceError(event),
      );
    };
    const onRejection = (event: Event): void => {
      record(() => captureRejection(event));
    };

    // Published before registration so that a failure part-way through leaves
    // every listener that *was* registered removable by the detach below.
    errorListener = onError;
    rejectionListener = onRejection;

    window.addEventListener(ERROR_EVENT_TYPE, onError, ERROR_LISTENER_OPTIONS);
    window.addEventListener(REJECTION_EVENT_TYPE, onRejection, REJECTION_LISTENER_OPTIONS);

    attached = true;
  } catch {
    detachErrors();
  }
}

/**
 * Stop recording failures and release both listeners.
 *
 * Called by `./agent.ts` when the service clears the hooks — an `agent.config`
 * with every hook false, which AAP 0.5.1 requires to leave the agent
 * "disabled, not merely idled". Afterwards the page carries no listener of
 * this module's and a later exception emits nothing.
 *
 * Removal passes the same listener references and the same capture flags used
 * at registration, because `removeEventListener` matches on both; a mismatch
 * would leave the developer's page holding a listener the agent can no longer
 * reach.
 *
 * The counters are deliberately **not** reset: "how many failures did that
 * capture have" is a question asked after the capture stopped.
 *
 * Safe to call when already detached, and never throws.
 */
export function detachErrors(): void {
  try {
    const onError = errorListener;
    errorListener = undefined;
    if (onError !== undefined && typeof window !== 'undefined') {
      window.removeEventListener(ERROR_EVENT_TYPE, onError, ERROR_LISTENER_OPTIONS);
    }

    const onRejection = rejectionListener;
    rejectionListener = undefined;
    if (onRejection !== undefined && typeof window !== 'undefined') {
      window.removeEventListener(REJECTION_EVENT_TYPE, onRejection, REJECTION_LISTENER_OPTIONS);
    }

    handling = false;
  } catch {
    // Best effort by construction: the two removals are independent, so a
    // failure in one leaves the other done.
  } finally {
    attached = false;
  }
}

/**
 * Whether both listeners are registered right now.
 *
 * `./agent.ts` reports this in its readiness and status frames, and it is
 * `false` in a context with no `window` even after {@link attachErrors} was
 * called, because nothing was registered there.
 */
export function isErrorsAttached(): boolean {
  return attached;
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
