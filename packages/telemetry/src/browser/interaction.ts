/**
 * The interaction window: where a trace begins, and which trace every other
 * browser signal belongs to.
 *
 * A developer clicks something and asks why it was slow. Everything the
 * product does after that hangs off one decision made here — that this click
 * is a trace, with this `traceId` and this root `spanId` — because the promise
 * the whole pipeline exists to keep is "one click resolves to one ordered
 * tree" (AAP 0.4.2). The `interaction` event this module emits is that tree's
 * root: it carries **no `parentSpanId`**, and its `spanId` is the parent that
 * `./fetch.ts` records on the request it injects `traceparent` into, which in
 * turn becomes the parent of the Next.js server span, the route handler, the
 * service functions and the SQL beneath them. `../correlation/correlator.ts`
 * asserts exactly that chain (`interaction ⊃ fetch ⊃ http.server ⊃
 * route.handler ⊃ function ⊃ db.query`), so a deviation here is not a local
 * defect — it is a broken acceptance test and a panel that shows two
 * disconnected halves of one interaction.
 *
 * ## The two things this module does
 *
 * 1. **It measures the interaction.** One `interaction` event per gesture,
 *    emitted once the window closes so its duration is final: how long the
 *    developer's own handlers ran, what was interacted with, and — when the
 *    host supplies a `PerformanceEventTiming` entry — how much of the delay
 *    was input delay rather than handler work.
 * 2. **It answers "which trace is this?"** {@link resolveEventContext} is the
 *    contract six sibling modules read on every event they emit
 *    (`./fetch.ts`, `./react.ts`, `./state.ts`, `./perf.ts`, `./errors.ts`,
 *    and `./agent.ts` for its own diagnostics). This module is the **only**
 *    place the precedence between an open interaction window, a continuation
 *    window and a fresh synthetic root is decided, which is why those modules
 *    import this one and this one imports none of them: the dependency runs
 *    one way and the reverse would close a cycle.
 *
 * ## Why the listener is capture-phase, on `window`
 *
 * React 19 attaches its own listeners at the root container, not on the
 * element, so a bubble-phase listener runs *after* the application's handler
 * has already started its `fetch`. A capture-phase listener on `window` runs
 * before any of it: `window` is the first node in the capture path, so by the
 * time the developer's handler executes, the window is open, the trace exists,
 * and a request issued synchronously inside that handler is already
 * correlated. Registering late would cost precisely the request the developer
 * asked about.
 *
 * The listeners are `{ capture: true, passive: true }` and nothing in this
 * module calls `preventDefault`, `stopPropagation` or
 * `stopImmediatePropagation`. Observing a page must not change what the page
 * does, and `passive` states that contract to the host as well as to the
 * reader.
 *
 * ## How the window is timed
 *
 * The synchronous part of an interaction is bounded by the dispatch itself, so
 * it is measured with a `setTimeout(…, 0)` scheduled from inside the
 * capture-phase handler: when that callback runs, the dispatch and every
 * microtask the handlers queued have completed, and `performance.now()` is the
 * end of the synchronous window. The window then stays open for a bounded tail
 * ({@link INTERACTION_TAIL_MS}) so that a request started from a microtask or
 * a promise continuation — the common shape of `await` in a handler — still
 * finds it open.
 *
 * `PerformanceObserver('event')` refines that measurement when the host
 * provides an entry: `processingStart`, `processingEnd`, `duration` and
 * `interactionId` are recorded, the close deadline is extended to
 * `processingEnd` plus the tail, and the entry's fields are carried as
 * evidence. The refinement is never *depended* on. The specification clamps
 * `durationThreshold` to a minimum of {@link PERF_EVENT_DURATION_THRESHOLD_MS}
 * milliseconds, so a fast interaction produces no entry at all, and some hosts
 * do not support the `event` entry type. The `setTimeout` measurement is the
 * primary signal; the observer only ever makes it better.
 *
 * Lineage after the window belongs to `./continuation.js`, not here. This
 * module closes the window and forgets it — the closed record is kept as a
 * diagnostic and as the match target for a late performance entry, never as an
 * ambient "current trace", which is the failure mode AAP 0.4.2 rules out.
 *
 * ## Coalescing: one gesture is one interaction
 *
 * A single tap produces `pointerdown` and then `click`; submitting a form
 * produces `pointerdown`, `click` and `submit`. Those are one interaction, and
 * Chrome's own `interactionId` groups them the same way. An event of a listed
 * type arriving while a window is open therefore **joins** the open
 * interaction — its type is recorded, the synchronous window is re-measured
 * for the new dispatch, and the close deadline moves out — rather than
 * starting a second trace that would split one gesture's evidence in half.
 *
 * ## Nothing here throws, nothing leaks, and nothing is lost in silence
 *
 * Every handler body, every timer callback and every export sits inside a
 * `try`/`catch`: this code runs on the page's own stack, inside the
 * developer's click handler, where an escaping exception would break the
 * application under investigation. `attachInteractions` is idempotent and
 * {@link detachInteractions} returns the module to observing nothing —
 * ordinarily holding no listener, no observer, no timer and no record either —
 * because AAP 0.5.1 requires runtime hooks to be "disabled, not merely idled":
 * a dormant agent holds no observation of the developer's page.
 *
 * Teardown reaches that state **one guarded step at a time**, and the reason
 * is the failure mode a single enclosing `try` has: a page that has replaced
 * `removeEventListener`, or a host that throws from `PerformanceObserver`'s
 * `disconnect`, would abort the rest of the sequence — the remaining listener
 * types, the observer, both timers, the state reset — while the module still
 * reported itself detached. That is the opposite of what AAP 0.5.1 asks for:
 * the agent would be attached to the page and say it was not. So
 * {@link detachInteractions} disarms first (nothing observes while it works),
 * guards each removal on its own, **sweeps every declared event type** rather
 * than only the ones it believes it registered, and **retains whatever did not
 * come back** — the listener types still believed registered and an observer
 * that refused to disconnect — so the next detach retries them and a re-attach
 * repairs instead of duplicating. The sweep is unconditional because a page
 * can register a listener inside its own `addEventListener` wrapper and *then*
 * throw: that registration is real and no bookkeeping here can know of it, so
 * teardown has to attempt the removal anyway (a removal for a type that was
 * never registered is a specified no-op). What survives is readable rather
 * than merely reported: {@link hasInteractionsResidue} answers "does the page
 * still carry anything of ours", which is the fact `./agent.ts` puts in its
 * `hooks-not-released` frame.
 *
 * ## One capture's evidence never lands in another
 *
 * Disarming is not sufficient on its own, because the flag goes true again:
 * a page that broke `clearTimeout` leaves the close timer of the interaction
 * in flight pending, and if the developer starts a second capture before it
 * fires it would find the module attached and emit a gesture that happened
 * before that capture began — stamped with the new capture's id and sequence,
 * indistinguishable from a real interaction. So each observation period has a
 * number ({@link attachGeneration}), every interaction record carries the
 * number it was opened in, and every deferred callback compares the two before
 * it acts ({@link isLiveDeferral}). Residue of an ended capture returns
 * silently; a live interaction is unaffected, since its record's generation is
 * the current one.
 *
 * A contained failure is also a *reported* failure. Every `catch` that costs
 * the capture evidence calls `reportProducerFailure` from `./transport.js`,
 * which posts a bounded, sanitized `agent.error` frame carrying the stage and
 * the thrown value's type and nothing else — never a message, a URL or
 * anything read off the page. Swallowing keeps the developer's application
 * alive; reporting is what stops a capture that lost every interaction from
 * looking like a capture that succeeded (AAP 0.5.5). The few guards that cost
 * only clock resolution or an unavailable host capability are deliberately
 * silent, and each says so where it sits, so that a real failure is never
 * buried under a page's worth of noise.
 *
 * Nothing observable happens at import time. Module scope here is one page
 * document, the same scope `./transport.js` numbers its sequence in and
 * `./ids.ts` memoizes its producer id in.
 *
 * ## Imports: four page modules and two vocabularies
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this file into the IIFE
 * injected into the developer's page at `document_start` and hard-fails on any
 * input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared/node` or `zod`. The imports below are therefore the whole
 * list and are a constraint rather than a coincidence: ids, transport,
 * continuation and dom-target for behaviour, and the two dependency-free
 * schema vocabularies for the kind and the attribute key spellings (type-only,
 * so no vocabulary reaches the page bundle at runtime).
 *
 * @see ./continuation.ts for lineage after this window closes.
 * @see ../schema/attributes.ts for the `interaction` attribute vocabulary.
 */

import { applyLineageAttributes, getLineage, notifyInteraction } from './continuation.js';
import {
  describeElement,
  isElementPickActive,
  nearestComponentName,
  type TargetDescriptor,
} from './dom-target.js';
import { newSpanId, newTraceId } from './ids.js';
import {
  emit,
  nowEpochMs,
  reportProducerFailure,
  toEpochMs,
  type EventDraft,
} from './transport.js';
import type { INTERACTION_ATTRIBUTE_KEYS } from '../schema/attributes.js';
import type { TelemetryKind } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Contract constants
 *
 * Exported because each one is part of the contract a sibling module or a test
 * reasons about, not a tuning knob: `./fetch.ts` relies on the tail existing,
 * and the lifetime ceiling is the guarantee that a leaked window cannot
 * misattribute a later event.
 * ---------------------------------------------------------------------------
 */

/**
 * How long the interaction window stays open after the synchronous dispatch
 * has finished, in milliseconds.
 *
 * AAP 0.4.2 names this bound explicitly: the window "closes after the event's
 * `processingEnd` plus a bounded 50 ms tail for microtask-scheduled requests".
 * The tail is what makes `await`-shaped handlers work. A handler that does
 * `await fetch(...)` returns to the event loop before the request is even
 * created in some polyfilled paths, and a handler that schedules its request
 * from a `Promise.resolve().then(...)` always does; without a tail, those
 * requests would miss the window by a microtask and start traces of their own.
 *
 * Bounded, and deliberately short: the tail is the one interval during which
 * an *unrelated* timer-driven request could be adopted by this interaction, so
 * it covers microtask latency and nothing more. Work that arrives later is
 * attributed by evidence instead, through `./continuation.js`.
 *
 * This is the only place the number is written. Every other reference — the
 * close scheduling below, the tests, the sibling modules — reads this
 * constant.
 */
export const INTERACTION_TAIL_MS = 50;

/**
 * The event types that open (or join) an interaction window, in capture phase.
 *
 * Chosen to cover the gestures a developer asks about while staying off the
 * high-frequency stream: `pointerdown` is the earliest reliable signal that a
 * gesture has begun (it precedes `mousedown`/`click` and covers touch and pen
 * without a second listener), `click` is the activation itself, `keydown`
 * covers keyboard activation and typing, and `submit` and `change` are the
 * form semantics that routinely trigger the network request under
 * investigation.
 *
 * Deliberately absent: `pointermove`, `mousemove`, `scroll`, `wheel`,
 * `keyup`, `input` and the rest of the continuous streams. One of those would
 * open hundreds of windows a second, each minting a trace and each closing
 * with an emitted event, which would bury the interaction the developer cares
 * about in its own telemetry.
 *
 * One registration at `window` is enough for all five: the capture phase
 * traverses from `window` down to the target, so a capture-phase listener
 * there observes every event dispatched inside the document — including a
 * non-bubbling one, which a bubble-phase listener at `window` would never
 * see.
 */
export const INTERACTION_EVENT_TYPES = [
  'pointerdown',
  'click',
  'keydown',
  'submit',
  'change',
] as const;

/**
 * The `durationThreshold` asked of `PerformanceObserver('event')`, in
 * milliseconds.
 *
 * The Event Timing specification clamps this value to a minimum of 16 ms — the
 * length of one frame at 60 Hz — so asking for less changes nothing and
 * pretending otherwise would be the bug: **an interaction shorter than this
 * produces no entry at all.** That is exactly why the `setTimeout`-measured
 * baseline is the primary signal and the observer is a refinement. 16 is asked
 * for rather than a larger value so that every entry the host is willing to
 * report is received.
 */
export const PERF_EVENT_DURATION_THRESHOLD_MS = 16;

/**
 * The hard ceiling on how long one interaction window may stay open, in
 * milliseconds.
 *
 * A window that never closes is an ambient current trace, and it is worse than
 * having none: every later event — a polling request, an idle re-render, an
 * unrelated error — would be attributed to a click that did not cause it, and
 * nothing in the capture would say so. Ten seconds is far longer than any
 * gesture's synchronous work plus its tail, so reaching this ceiling means the
 * close timer was starved (a backgrounded tab throttles timers) or a handler
 * blocked the main thread for that long. Either way the window is forced
 * closed, the interaction is emitted with the duration actually measured, and
 * attribution moves on.
 *
 * Enforced twice, because the two failure modes are different: the close
 * deadline is capped at `start + MAX_INTERACTION_LIFETIME_MS` when it is
 * scheduled, and every read of the window (see {@link isInteractionWindowOpen}
 * and {@link resolveEventContext}) rejects — and finalises — a window already
 * past that age, which is the case a starved timer cannot fix by itself.
 */
export const MAX_INTERACTION_LIFETIME_MS = 10_000;

/*
 * ---------------------------------------------------------------------------
 * Internal bounds
 *
 * Implementation budgets rather than contract: a caller has no reason to
 * reason about them, and the behaviour they bound is observable only through
 * the exported constants above.
 * ---------------------------------------------------------------------------
 */

/**
 * How many distinct event types one coalesced interaction records.
 *
 * A gesture contributes at most three or four (`pointerdown`, `click`,
 * `change`, `submit`), and types are recorded as a set, so this ceiling is
 * reached only by a page dispatching synthetic events in a loop. It exists so
 * that such a page costs a bounded array rather than an unbounded one on the
 * click path.
 */
const MAX_COALESCED_EVENT_TYPES = 8;

/**
 * How far outside an interaction's own window a `PerformanceEventTiming` entry
 * may start and still be matched to it, in milliseconds.
 *
 * Three sources of skew have to fit inside this tolerance. Chrome coarsens an
 * event entry's `startTime` to 8 ms granularity as a privacy measure, so the
 * entry's start and the timestamp on the `Event` object differ by construction.
 * The capture-phase listener reads its own clock after the host stamped the
 * event, so the two readings differ by the input delay. And an entry may be
 * reported for a dispatch that happened marginally after the window's close
 * deadline was computed. Sixty-four milliseconds absorbs all three while
 * staying far below the gap between two deliberate gestures.
 */
const ENTRY_MATCH_TOLERANCE_MS = 64;

/**
 * The largest value accepted as a document-relative `Event.timeStamp`, in
 * milliseconds.
 *
 * `Event.timeStamp` is a `DOMHighResTimeStamp` measured from
 * `performance.timeOrigin`, and the conversion to the product's epoch base
 * ({@link toEpochMs}) adds the origin to it. A host that instead reports an
 * epoch-scaled timestamp — as pre-`DOMHighResTimeStamp` browsers did, and as a
 * page that constructs its own `Event`-like object may — would therefore
 * produce a start time tens of thousands of years in the future, which the
 * ingress schema rejects, taking the whole event with it. Nothing legitimate is
 * above this bound: it is roughly thirty-one years of document uptime, while
 * any epoch-scaled value is above 1.7 × 10¹², so the two cannot be confused.
 * A timestamp at or above it is treated as unusable and the clock is read
 * instead.
 */
const MAX_RELATIVE_TIMESTAMP_MS = 1e12;

/**
 * The `kind` every event this module emits carries.
 *
 * Typed as {@link TelemetryKind} rather than left as a bare string literal so
 * the spelling is checked against `../schema/kinds.ts`'s closed vocabulary at
 * compile time. `interaction` is declared there as a browser-only kind, which
 * is what the event schema's kind/tier agreement check requires of a producer
 * on this tier.
 */
const INTERACTION_KIND: TelemetryKind = 'interaction';

/*
 * ---------------------------------------------------------------------------
 * Attribute keys
 *
 * Every key this module writes, bound to `../schema/attributes.ts` where that
 * module declares an equivalent. The declared ones are typed as members of the
 * `interaction` tuple, so renaming or dropping one there fails compilation
 * here rather than silently producing an event whose attributes no consumer
 * reads; the invented ones are typed as plain strings and each documents what
 * `attributes.ts` should adopt.
 * ---------------------------------------------------------------------------
 */

/** One member of `INTERACTION_ATTRIBUTE_KEYS`, the `interaction` vocabulary. */
type DeclaredInteractionKey = (typeof INTERACTION_ATTRIBUTE_KEYS)[number];

/** The gesture's primary event type, for example `click`. */
const KEY_EVENT_TYPE: DeclaredInteractionKey = 'event.type';

/** The interacted element's CSS selector, from `./dom-target.ts`. */
const KEY_TARGET_SELECTOR: DeclaredInteractionKey = 'target.selector';

/** The interacted element's lowercased tag name. */
const KEY_TARGET_TAG_NAME: DeclaredInteractionKey = 'target.tagName';

/** The interacted element's bounded, scrubbed visible text. */
const KEY_TARGET_TEXT: DeclaredInteractionKey = 'target.text';

/** The React owner chain above the interacted element, nearest first. */
const KEY_COMPONENT_CHAIN: DeclaredInteractionKey = 'componentChain';

/** `PerformanceEventTiming.interactionId`, when the host reported one. */
const KEY_INTERACTION_ID: DeclaredInteractionKey = 'interactionId';

/** Milliseconds between the input event and the start of event dispatch. */
const KEY_INPUT_DELAY: DeclaredInteractionKey = 'inputDelay';

/** When event dispatch started, in epoch milliseconds. */
const KEY_PROCESSING_START: DeclaredInteractionKey = 'processingStart';

/** When the last event handler finished, in epoch milliseconds. */
const KEY_PROCESSING_END: DeclaredInteractionKey = 'processingEnd';

/**
 * Every event type this interaction coalesced, in the order they were seen.
 *
 * **Invented here.** `INTERACTION_ATTRIBUTE_KEYS` declares the singular
 * `event.type` only, which cannot express a gesture — a tap is `pointerdown`
 * then `click`, and a form submission adds `submit` — and a panel reading one
 * type would misreport what the developer did. Written only when more than one
 * type was coalesced, so the ordinary single-type interaction stays one
 * attribute smaller. `../schema/attributes.ts` should adopt this spelling in
 * the `interaction` tuple; it is deliberately the plural of the declared key
 * rather than a new vocabulary.
 */
const KEY_EVENT_TYPES = 'event.types';

/**
 * How long event dispatch itself took: `processingEnd - processingStart`, in
 * milliseconds.
 *
 * **Invented here.** The declared tuple carries the two instants but not the
 * interval between them, and that interval is the number the analysis stage
 * actually reasons about — it separates "the handler was slow" from "the
 * handler started late", which is the whole point of carrying the entry's
 * fields (see the `interaction` entry's own documentation in
 * `../schema/attributes.ts`). Derivable from the two instants, and named
 * anyway so no consumer has to re-derive it. `../schema/attributes.ts` should
 * adopt this spelling.
 */
const KEY_PROCESSING_DURATION = 'processingDuration';

/**
 * The nearest React component above the interacted element.
 *
 * **Not in the `interaction` tuple**, but not a new word either: `component`
 * is the spelling `RENDER_ATTRIBUTE_KEYS` and `STATE_ATTRIBUTE_KEYS` already
 * use for exactly this value, and a panel that joins an interaction to the
 * renders it caused compares the two. Typed as a plain string because the
 * `interaction` tuple does not declare it yet;
 * `../schema/attributes.ts` should add it there, next to `componentChain`.
 */
const KEY_COMPONENT = 'component';

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * The interaction whose window is open right now, as
 * {@link getActiveInteraction} reports it.
 *
 * A read-only snapshot for diagnostics — `./agent.ts`'s status frame and the
 * tests. The trace and span it names are the ones every event emitted during
 * the window adopts, so this is also the shape a reader inspects when an event
 * appears under an unexpected parent.
 *
 * Optional members declare `| undefined` explicitly because the repository
 * compiles with `exactOptionalPropertyTypes`: a field that is genuinely
 * unknown for this interaction (no element was interacted with, no performance
 * entry arrived) is absent, and a consumer that builds one of these values
 * conditionally does not have to use a conditional spread to say so.
 */
export interface ActiveInteraction {
  /** The trace this interaction opened: 32 lowercase hex characters. */
  traceId: string;

  /**
   * The root span of that trace: 16 lowercase hex characters.
   *
   * This is the `parentSpanId` every event emitted inside the window carries,
   * and the span id `./fetch.ts` names as the parent of the request it
   * correlates. The `interaction` event itself has no parent.
   */
  spanId: string;

  /** When the interaction began: Unix epoch milliseconds as a double. */
  startTime: number;

  /**
   * The same instant on the document's monotonic clock
   * (`performance.now()`), which is the basis every interval in this module
   * is measured on.
   *
   * Kept beside {@link startTime} because the two answer different questions:
   * the epoch value is what the event carries and what the service orders
   * traces by, while the monotonic value is immune to a wall-clock adjustment
   * mid-capture and is therefore what durations are computed from.
   */
  startPerfMs: number;

  /**
   * The event types this interaction has coalesced, in the order they were
   * seen — `['pointerdown', 'click']` for a tap.
   *
   * A fresh array per snapshot: the caller may keep or sort it without
   * affecting the interaction it came from.
   */
  eventTypes: string[];

  /**
   * Whether the window is still open, and therefore whether
   * {@link resolveEventContext} is still attributing events to this
   * interaction.
   */
  windowOpen: boolean;

  /**
   * What was interacted with, as `./dom-target.ts` described it: selector,
   * tag name, bounded text, React owner chain and the document URL.
   *
   * Absent when the event's target was not an element — a key event dispatched
   * at `window` or `document`, a synthetic event aimed at a text node — which
   * is a routine case rather than a failure.
   */
  target?: TargetDescriptor | undefined;

  /**
   * The nearest React component name above the target, when one was
   * reachable.
   *
   * Absent on a page without React, on a node React never rendered, and on a
   * production build whose fibers the hook cannot reach.
   */
  component?: string | undefined;

  /**
   * When the last event handler of this interaction finished, on the
   * monotonic clock, as reported by a `PerformanceEventTiming` entry.
   *
   * Absent whenever no entry arrived, which the Event Timing threshold makes
   * the common case for a fast interaction (see
   * {@link PERF_EVENT_DURATION_THRESHOLD_MS}).
   */
  processingEndPerfMs?: number | undefined;
}

/**
 * Why an event carries the trace it carries — the provenance of an
 * {@link EventContext}, and the one field a consumer needs in order to know
 * how much the attribution is worth.
 *
 * - `interaction` — an interaction window was open. The strongest
 *   attribution there is: the event happened while the developer's gesture was
 *   still being processed.
 * - `continuation` — the window had closed, and `./continuation.js` attributed
 *   the event to a settled request whose continuation window was still open.
 *   Evidence-based, and flagged as such on the event by
 *   `applyLineageAttributes`.
 * - `synthetic` — neither applied, so the event is the root of a fresh trace
 *   of its own. The honest answer for work with no evidenced cause: a page-load
 *   performance entry, a polling request, an error thrown by a timer.
 */
export type EventContextOrigin = 'interaction' | 'continuation' | 'synthetic';

/**
 * The trace an event should join, and the span it should hang from.
 *
 * Returned by {@link resolveEventContext} and consumed by every browser
 * producer. Two rules make it usable:
 *
 * 1. **`traceId` is always present.** There is no "no trace" answer: an event
 *    with no evidenced cause gets a fresh root rather than an absent trace, so
 *    a producer never has to invent one and every event is part of exactly one
 *    tree.
 * 2. **{@link attributes} must be merged into the event's own attribute bag**
 *    before it is emitted. It is absent for the `interaction` and `synthetic`
 *    origins and carries the lineage annotation for `continuation`; dropping
 *    it costs the panel the dashed-edge rendering that says an attribution was
 *    a best candidate rather than a certainty.
 */
export interface EventContext {
  /** The trace the event joins: 32 lowercase hex characters. */
  traceId: string;

  /**
   * The span the event hangs from: 16 lowercase hex characters.
   *
   * Absent only for a `synthetic` origin, where the event *is* the root of
   * its trace.
   */
  parentSpanId?: string | undefined;

  /**
   * Attributes the attribution itself contributed, to be merged into the
   * event's own bag — never to replace it.
   *
   * Written only by `./continuation.js`'s `applyLineageAttributes`, which owns
   * the lineage vocabulary; this module never spells those keys itself.
   * Absent when the attribution contributed nothing.
   */
  attributes?: Record<string, unknown> | undefined;

  /** Where the attribution came from; see {@link EventContextOrigin}. */
  origin: EventContextOrigin;
}

/*
 * ---------------------------------------------------------------------------
 * Internal types
 * ---------------------------------------------------------------------------
 */

/**
 * An interaction as this module tracks it: the public snapshot fields plus the
 * measurements only the lifecycle needs.
 *
 * The split is deliberate. {@link ActiveInteraction} is what a diagnostic
 * reader can act on; everything below is monotonic-clock bookkeeping whose
 * meaning depends on the timing machinery in this file, and exposing it would
 * invite a consumer to re-derive a duration that is already computed here.
 */
interface InteractionRecord extends ActiveInteraction {
  /**
   * The value {@link attachGeneration} held when this interaction opened —
   * which capture's observation period it belongs to.
   *
   * Every piece of deferred work this module schedules carries the generation
   * it was scheduled in and compares it with the module's current one before
   * it does anything (see {@link isLiveDeferral}), so a record cannot be
   * emitted, extended or refined by a capture that replaced the one it was
   * opened in. Kept on the record rather than only captured in each closure
   * because the observer's callback outlives a detach and is *adopted* by the
   * next attach: its closure's generation would be stale for work that is
   * genuinely current, while the record's is exact.
   */
  generation: number;

  /**
   * The interaction's start on the monotonic clock, taken from the input
   * event's own `timeStamp` when the host reported a usable one.
   *
   * Distinct from {@link ActiveInteraction.startPerfMs}, which is this
   * module's clock read *inside* the listener and therefore already includes
   * the input delay. Every interval that should be comparable with a
   * performance entry is measured from this field, so that the interaction's
   * duration begins where the host says the input happened rather than where
   * the agent noticed it.
   */
  startRelativeMs: number;

  /**
   * When the synchronous dispatch — and every microtask its handlers
   * queued — was observed to have completed, on the monotonic clock.
   *
   * Set by the `setTimeout(…, 0)` probe. The primary duration signal: it is
   * always available for a real dispatch, whereas a performance entry may
   * never arrive.
   */
  syncEndPerfMs?: number | undefined;

  /**
   * `PerformanceEventTiming.processingStart` — when event dispatch began — as
   * the earliest such value reported for this interaction.
   *
   * The earliest is kept because a coalesced gesture reports one entry per
   * event type and input delay is a property of the *first* of them.
   */
  processingStartPerfMs?: number | undefined;

  /**
   * The user-perceived end of the interaction as an entry reports it:
   * `entry.startTime + entry.duration`, which includes the presentation delay
   * up to the next paint.
   *
   * Used only to extend the close deadline, never as the emitted duration: a
   * React commit that renders the gesture's result frequently lands in exactly
   * that presentation interval, and holding the window open through it is what
   * attributes the commit to the interaction instead of to a fresh root.
   */
  entryEndPerfMs?: number | undefined;

  /**
   * `PerformanceEventTiming.interactionId`, the host's own grouping of the
   * events of one gesture, when it reported a non-zero one.
   */
  interactionId?: number | undefined;

  /**
   * The monotonic-clock instant the window is scheduled to close at, already
   * capped by {@link MAX_INTERACTION_LIFETIME_MS}.
   */
  closeDeadlinePerfMs?: number | undefined;

  /**
   * Whether the `interaction` event has been emitted.
   *
   * What makes closing idempotent, and the reason an emitted event is never
   * revised: the close timer, the safety valve on the read path and
   * {@link detachInteractions} can all race, and exactly one of them may emit.
   */
  emitted: boolean;
}

/**
 * `PerformanceObserverInit` plus the field this module actually needs.
 *
 * `durationThreshold` is part of the Event Timing specification but absent
 * from TypeScript 6.0.3's `lib.dom.d.ts`, so the option is declared here and
 * passed as a *typed variable* rather than as a fresh object literal — an
 * excess-property check applies to the literal but not to the variable, and
 * the alternative (an `any` cast on `observe`) would lose the type of every
 * other field.
 */
interface EventTimingObserverInit extends PerformanceObserverInit {
  /**
   * Report only interactions at least this many milliseconds long. The
   * specification clamps the value to a minimum of
   * {@link PERF_EVENT_DURATION_THRESHOLD_MS}.
   */
  durationThreshold?: number | undefined;
}

/**
 * A performance entry carrying the `PerformanceEventTiming` fields this module
 * reads.
 *
 * Narrowed structurally by {@link isEventTimingEntry} rather than with
 * `instanceof PerformanceEventTiming`: the constructor is absent in some
 * hosts (happy-dom, where this module's suites run) and an entry that came
 * from another realm would fail the identity check even where it exists, while
 * the fields themselves are all this module wants.
 */
type EventTimingEntry = PerformanceEntry & {
  readonly processingStart: number;
  readonly processingEnd: number;
  readonly interactionId?: number | undefined;
};

/**
 * One member of {@link INTERACTION_EVENT_TYPES}.
 *
 * Used for {@link registeredEventTypes} so that the set of currently
 * registered types is checked against the tuple at compile time: a type added
 * to or removed from the tuple cannot leave a stale member behind in the
 * bookkeeping that drives attach and detach.
 */
type InteractionEventType = (typeof INTERACTION_EVENT_TYPES)[number];

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * Module scope is one page document, which is the right scope for all of it: a
 * reload gives a new document, a new producer id in `./ids.ts` and a fresh
 * sequence in `./transport.ts`, and therefore a clean interaction state as
 * well. Declaring these bindings is not a side effect — nothing observable
 * happens until a function below is called.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether this module is observing interactions right now.
 *
 * "Observing", not "has listeners": it is set **false first** by
 * {@link detachInteractions}, before any removal is attempted, and every
 * callback in this file returns immediately while it is false. That makes the
 * flag the disarm switch rather than an inventory — a listener the page
 * refused to remove is inert the moment this becomes false, which is what
 * turns a failed removal from a producer that keeps opening windows after
 * detach into a reference that {@link registeredEventTypes} remembers to
 * retry.
 *
 * What is actually still registered is therefore never read from here. It is
 * read from {@link registeredEventTypes} and {@link observer}, which are the
 * only honest record of it, and it is exposed to `./agent.ts` as
 * {@link hasInteractionsResidue}.
 */
let attached = false;

/**
 * Which observation period this module is in: incremented on every
 * {@link attachInteractions} and every {@link detachInteractions}.
 *
 * **Why a counter and not just the {@link attached} flag.** The flag answers
 * "is this module observing now", and a timer that outlived a teardown can
 * find it `true` again: a page that broke `clearTimeout` leaves the close
 * timer of capture A pending, the developer starts capture B, and the flag
 * says "attached" while the pending callback still holds capture A's record.
 * Emitting it then would stamp an event that belongs to a capture that has
 * ended with the sequence and the capture id of the one that replaced it —
 * evidence in the wrong capture, which is worse than evidence lost, because a
 * reader cannot tell it apart from a real interaction.
 *
 * The counter makes each period distinguishable. Every record carries the
 * generation it opened in ({@link InteractionRecord.generation}) and every
 * deferred callback tests it against this value before acting
 * ({@link isLiveDeferral}), so residue of an ended capture returns silently
 * instead of producing telemetry. It advances on *both* transitions so that a
 * detach alone — not only a following attach — is enough to invalidate
 * everything the previous period scheduled.
 *
 * A double counts every integer up to 2^53 exactly, so a page cannot exhaust
 * this by arming and disarming; it is monotonic for the life of the document
 * and is deliberately never reset.
 */
let attachGeneration = 0;

/**
 * The one listener registered for every type in
 * {@link INTERACTION_EVENT_TYPES}.
 *
 * Held so that {@link detachInteractions} can remove it by the same function
 * identity and the same capture flag it was added with, which is the only way
 * `removeEventListener` removes anything.
 *
 * Kept — deliberately — across a detach that could not remove every type: the
 * identity is the *only* handle that can ever remove those registrations, so
 * dropping it would strand them on the page forever. It is released once
 * {@link registeredEventTypes} is empty, which is the state a clean detach
 * reaches.
 */
let eventListener: ((event: Event) => void) | undefined;

/**
 * Which of {@link INTERACTION_EVENT_TYPES} this module **believes** are
 * registered with {@link eventListener} right now.
 *
 * "Believes", not "are": the page owns `addEventListener` and
 * `removeEventListener` and can replace either with a wrapper that performs
 * the native call and *then* throws, so no set can be evidence of what the
 * window actually holds. What this one records is the conservative answer to
 * the only question that has to be answered — may
 * {@link attachInteractions} add a listener for this type? — and the two
 * behaviours that depend on it:
 *
 * 1. **A re-attach repairs rather than duplicates.**
 *    {@link attachInteractions} registers only the types the set does not
 *    already hold, so a detach that failed on `click` followed by a re-attach
 *    leaves one `click` listener and not two — which would otherwise emit two
 *    interactions for one gesture.
 * 2. **A later detach retries.** What could not be removed is still listed,
 *    so the next {@link detachInteractions} sees it as residue
 *    ({@link hasInteractionsResidue}) even though the sweep no longer needs
 *    the set to decide what to attempt.
 *
 * A type is added when `addEventListener` returned, and also when it threw
 * *and* the immediate removal of that same registration threw too — a throwing
 * wrapper may have registered before it threw, and the only safe assumption
 * about a registration that could not be undone is that it exists. It is
 * deleted only once `removeEventListener` returned for it. What is **not**
 * derived from this set is which types teardown attempts: that is every
 * declared type, unconditionally (see {@link detachInteractions}), because a
 * registration this set never learned about must still come off the page.
 */
const registeredEventTypes = new Set<InteractionEventType>();

/**
 * The one `PerformanceObserver`, when the host supports `event` timing.
 *
 * Cleared only when `disconnect()` actually returned. A host that throws from
 * `disconnect` has refused to stop the observer, so the reference is retained:
 * the next detach retries the disconnect, and a re-attach adopts this observer
 * rather than constructing a second one that would deliver every entry twice.
 * While detached the observer delivers nothing, because {@link handleEntries}
 * returns on the disarmed {@link attached} flag.
 */
let observer: PerformanceObserver | undefined;

/** The `setTimeout(…, 0)` probe that measures the end of the dispatch. */
let syncTimer: ReturnType<typeof setTimeout> | undefined;

/** The timer that closes the window and emits the interaction. */
let closeTimer: ReturnType<typeof setTimeout> | undefined;

/** The interaction whose window is open, if any. */
let activeInteraction: InteractionRecord | undefined;

/**
 * The most recently closed interaction.
 *
 * Kept for two narrow purposes and no others: it is the match target for a
 * performance entry that arrives after the window closed, and it is a
 * diagnostic. It is emphatically **not** a fallback trace — lineage after the
 * window belongs to `./continuation.js`, and reading this record instead would
 * reintroduce the ambient current trace AAP 0.4.2 rules out.
 */
let lastInteraction: InteractionRecord | undefined;

/*
 * ---------------------------------------------------------------------------
 * Listener options and event-type precedence
 * ---------------------------------------------------------------------------
 */

/**
 * The options every listener is added — and removed — with.
 *
 * `capture: true` is what puts this module ahead of React's root listeners
 * (see the module header) and is matched on removal, so the same object serves
 * both calls and the two cannot drift apart. `passive: true` tells the host
 * this listener will not call `preventDefault`, which is a promise the module
 * keeps: nothing here touches the event beyond reading `type`, `timeStamp` and
 * `target`.
 */
const LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

/** The delay of the probe that measures the end of the synchronous dispatch. */
const SYNC_PROBE_DELAY_MS = 0;

/**
 * Which coalesced event type names the interaction, most meaningful first.
 *
 * A tap on a submit button coalesces `pointerdown`, `click` and `submit`, and
 * the label a developer recognises is the one that describes the *intent*, not
 * the first hardware signal. `submit` therefore outranks `click`, which
 * outranks the value-change and keyboard signals, and `pointerdown` — present
 * on nearly every gesture — ranks last.
 */
const EVENT_TYPE_PRECEDENCE = ['submit', 'click', 'change', 'keydown', 'pointerdown'] as const;

/**
 * The plausibility ceiling for a duration computed on the monotonic clock, in
 * milliseconds.
 *
 * Both readings a duration is computed from come from {@link perfNow}, so they
 * share a basis — unless the page's `performance` object became unusable
 * mid-interaction and the function fell back to the wall clock, which would
 * subtract a document-relative value from an epoch one and yield a number
 * around 1.7 × 10¹². A result above this ceiling is therefore not a slow
 * interaction but a mixed basis, and the epoch-difference measurement is used
 * instead. The ceiling is above {@link MAX_INTERACTION_LIFETIME_MS} so that a
 * genuinely long interaction, forced closed by the safety valve, still reports
 * what it measured.
 */
const MONOTONIC_DURATION_CEILING_MS = MAX_INTERACTION_LIFETIME_MS + INTERACTION_TAIL_MS;

/*
 * ---------------------------------------------------------------------------
 * Clock and arithmetic helpers
 * ---------------------------------------------------------------------------
 */

/**
 * The document's monotonic clock, in milliseconds since its time origin.
 *
 * Every interval in this module is measured with this one function, so the two
 * readings of any interval always share a basis. Without a usable
 * `performance` object it degrades to the wall clock, which costs resolution
 * and immunity to a clock adjustment but keeps the intervals internally
 * consistent; {@link MONOTONIC_DURATION_CEILING_MS} covers the one case that
 * consistency cannot — a clock that becomes unusable between two readings.
 */
function perfNow(): number {
  try {
    if (typeof performance !== 'undefined') {
      const reading: unknown = performance.now();
      if (typeof reading === 'number' && Number.isFinite(reading)) {
        return reading;
      }
    }
  } catch {
    // A page that replaced `performance` with a throwing accessor still gets a
    // usable reading; reading a clock must never abort an interaction.
    //
    // Deliberately not reported: the fallback keeps every interval in this
    // module internally consistent, so nothing is lost but resolution, and
    // this runs several times per event — a report here would spend this
    // source's whole failure budget on a degradation no consumer can act on.
  }
  return Date.now();
}

/**
 * The caller's instant in epoch milliseconds, or the clock when they supplied
 * none.
 *
 * The same defaulting `./continuation.js` applies, and for the same reason: a
 * test may inject one consistent time base, and a single decision never mixes
 * a supplied value with a fresh read.
 */
function epochInstant(now?: number): number {
  return typeof now === 'number' && Number.isFinite(now) ? now : nowEpochMs();
}

/** The later of two optional monotonic readings, or whichever one is defined. */
function laterOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return a > b ? a : b;
}

/**
 * A finite, non-negative millisecond interval.
 *
 * A negative interval is not a measurement — it is a clock that moved, or two
 * readings taken in the wrong order — and the event schema rejects a negative
 * duration outright, so zero is the honest floor.
 */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The input event's own timestamp, when it is usable as a document-relative
 * reading.
 *
 * Rejected: a non-number (a synthetic event-like object from the page), a
 * non-finite value, a non-positive value, and anything at or above
 * {@link MAX_RELATIVE_TIMESTAMP_MS}, which is an epoch-scaled timestamp
 * wearing a `DOMHighResTimeStamp`'s name. In every rejected case the caller
 * reads the clock instead, which costs the input delay and nothing else.
 */
function readEventTimeStamp(event: Event): number | undefined {
  try {
    const timeStamp: unknown = event.timeStamp;
    if (typeof timeStamp !== 'number' || !Number.isFinite(timeStamp)) {
      return undefined;
    }
    if (timeStamp <= 0 || timeStamp >= MAX_RELATIVE_TIMESTAMP_MS) {
      return undefined;
    }
    return timeStamp;
  } catch {
    // Same treatment as the clock read above, and for the same reason: a
    // throwing `timeStamp` accessor costs the input delay, the caller reads
    // the clock instead, and the interaction is still measured and emitted —
    // so this is a degradation rather than a lost signal to report.
    return undefined;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Capture isolation
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a deferred callback may still act on the record it was scheduled
 * for.
 *
 * The one test every timer callback in this file makes before it touches an
 * interaction, and it is three conditions rather than one because each covers
 * a different way the callback can be residue:
 *
 * 1. **The module is observing.** {@link attached} is set `false` before
 *    teardown releases anything, so a callback that outlived a detach — the
 *    page broke `clearTimeout`, or the tab was throttled — measures nothing.
 * 2. **The generation still matches.** A capture that ended and a capture that
 *    replaced it both see `attached === true`, so the flag alone cannot tell
 *    them apart: the counter can (see {@link attachGeneration}). Without this
 *    condition an interaction from capture A whose close timer survived
 *    teardown is emitted into capture B, carrying B's capture id and its
 *    sequence — a record of a gesture that happened before B began.
 * 3. **The record is still the current one.** `activeInteraction === record`
 *    keeps a callback from reviving an interaction the module has already
 *    retired inside the same generation (the lifetime safety valve closed it,
 *    or a second gesture replaced it), which is the pre-existing invariant
 *    every step of the lifecycle already asserted.
 *
 * @param record The interaction the callback was scheduled for.
 * @param generation The value {@link attachGeneration} held when the callback
 * was scheduled.
 * @returns `true` only when all three hold; a `false` answer means the
 * callback must return silently, having lost nothing that still exists.
 */
function isLiveDeferral(record: InteractionRecord, generation: number): boolean {
  return attached && generation === attachGeneration && activeInteraction === record;
}

/*
 * ---------------------------------------------------------------------------
 * Timers
 *
 * Two at most, both owned by the active interaction: one probe that measures
 * the end of the dispatch and one deadline that closes the window. Both are
 * cleared by {@link detachInteractions}, because a dormant agent may hold no
 * scheduled work (AAP 0.5.1).
 * ---------------------------------------------------------------------------
 */

/** Cancel the dispatch probe, if one is pending. */
function clearSyncTimer(): void {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
    syncTimer = undefined;
  }
}

/** Cancel the close deadline, if one is pending. */
function clearCloseTimer(): void {
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
}

/**
 * Schedule the probe that measures the end of the synchronous dispatch.
 *
 * A `setTimeout(…, 0)` scheduled from inside the capture-phase listener is the
 * cheapest correct measurement available: a macrotask cannot run until the
 * dispatch has finished *and* the microtask queue the handlers filled has
 * drained, so when the callback runs, `performance.now()` is the end of the
 * synchronous window. A second call — a coalescing event joining the same
 * interaction — replaces the pending probe, so the measurement always covers
 * the most recent dispatch of the gesture.
 */
function scheduleSyncProbe(record: InteractionRecord): void {
  clearSyncTimer();
  // Captured at scheduling time: the callback has to compare the period it was
  // scheduled in against the module's current one, and reading the counter
  // inside the callback would compare the current period with itself.
  const generation = record.generation;
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    // A timer whose `clearTimeout` failed during teardown still fires, and by
    // the time it does the module may have been armed again for a *different*
    // capture. Both cases are residue of a period that has ended and neither
    // may measure anything (AAP 0.5.1); see {@link isLiveDeferral}.
    if (!isLiveDeferral(record, generation)) {
      return;
    }
    try {
      completeSyncWindow(record);
    } catch (error) {
      // A timer callback has no caller to catch for it. The window still
      // closes: either an entry extends the deadline, or the safety valve on
      // the read path finalises the interaction. Reported because the
      // interaction's primary duration signal was the thing that was lost.
      reportProducerFailure('interaction', 'sync-probe', error);
    }
  }, SYNC_PROBE_DELAY_MS);
}

/**
 * Record the end of the synchronous dispatch and schedule the window's close.
 *
 * Runs once per dispatch of the gesture. The greatest reading wins, so a
 * coalesced `click` following a `pointerdown` extends the measurement rather
 * than shortening it.
 */
function completeSyncWindow(record: InteractionRecord): void {
  if (activeInteraction !== record || record.emitted) {
    return;
  }

  const syncEnd = perfNow();
  record.syncEndPerfMs = laterOf(record.syncEndPerfMs, syncEnd) ?? syncEnd;
  extendWindow(record, syncEnd + INTERACTION_TAIL_MS);
}

/**
 * Move the close deadline out to `candidate`, if that is later than the
 * deadline already scheduled, and arm the timer.
 *
 * Capped at {@link MAX_INTERACTION_LIFETIME_MS} past the interaction's start:
 * a stream of events or entries can extend the window repeatedly, and the cap
 * is what stops that from becoming an interaction that never ends. Never
 * shortens an existing deadline — the window is a guarantee to the producers
 * reading {@link resolveEventContext}, not a moving target.
 */
function extendWindow(record: InteractionRecord, candidate: number): void {
  // The generation test belongs here as well as in the callers' own gates:
  // this is the single place a timer is armed for a record, so a record from
  // an ended observation period cannot schedule work in the current one even
  // if some future caller forgets to check (capture isolation, item 1.2).
  if (activeInteraction !== record || record.emitted || record.generation !== attachGeneration) {
    return;
  }

  const ceiling = record.startRelativeMs + MAX_INTERACTION_LIFETIME_MS;
  const deadline = Math.min(candidate, ceiling);
  const current = record.closeDeadlinePerfMs;
  if (current !== undefined && deadline <= current && closeTimer !== undefined) {
    return;
  }

  record.closeDeadlinePerfMs =
    current === undefined ? deadline : (laterOf(current, deadline) ?? deadline);
  armCloseTimer(record);
}

/**
 * Arm (or re-arm) the single close timer for this interaction's deadline.
 *
 * A deadline already in the past yields a zero delay rather than a negative
 * one, so a window whose deadline was computed before a long blocking task
 * closes on the next turn of the event loop instead of waiting for a clock
 * that has already passed.
 */
function armCloseTimer(record: InteractionRecord): void {
  clearCloseTimer();

  const deadline = record.closeDeadlinePerfMs;
  if (deadline === undefined) {
    return;
  }

  const delay = nonNegative(deadline - perfNow());
  // Captured at arming time, for the reason {@link scheduleSyncProbe} states.
  const generation = record.generation;
  closeTimer = setTimeout(() => {
    closeTimer = undefined;
    // Same reasoning as the dispatch probe, and this is the callback the
    // reasoning was written for: detaching **drops** the interaction in flight
    // rather than emitting it, so a close timer that outlived teardown must
    // emit neither into the capture the developer ended nor — the case the
    // disarm flag alone does not cover — into the capture that replaced it.
    if (!isLiveDeferral(record, generation)) {
      return;
    }
    try {
      closeInteraction(record);
    } catch (error) {
      // See scheduleSyncProbe: a throw here would escape into the page's task
      // queue, and the interaction is already recorded as emitted.
      reportProducerFailure('interaction', 'close-timer', error);
    }
  }, delay);
}

/*
 * ---------------------------------------------------------------------------
 * Interaction lifecycle
 * ---------------------------------------------------------------------------
 */

/**
 * The capture-phase handler for every type in
 * {@link INTERACTION_EVENT_TYPES}.
 *
 * Two outcomes only: the event joins the open interaction, or it opens a new
 * one. The body never touches the event beyond reading `type`, `timeStamp` and
 * `target`, and the whole of it sits inside a `try` because it runs on the
 * page's own dispatch path — ahead of the application's own handler, which is
 * the point — where an escaping exception would surface as an error in the
 * application under investigation.
 *
 * **Gated on {@link attached}.** A registration the page would not let
 * {@link detachInteractions} remove still delivers events, and without this
 * gate it would go on minting traces and arming timers for a capture that has
 * ended — the difference between a residue the module remembers to retry and
 * a producer that is still running. The gate is what makes "disabled, not
 * merely idled" (AAP 0.5.1) true even when removal itself fails.
 *
 * **Gated on the element picker as well.** While `./dom-target.ts` has a pick
 * in flight ({@link isElementPickActive}), the gesture the developer makes is
 * the choice of an element for "Pick element", not an interaction with the
 * application: the picker consumes it so the application never sees it, and
 * recording it here would open a window — and a continuation window after it
 * — for a click that caused nothing. This listener is usually registered
 * before the picker's, so it runs first on the very click that ends the pick;
 * the check is therefore made here rather than left to the picker's
 * `stopImmediatePropagation`.
 */
function handleInteractionEvent(event: Event): void {
  if (!attached || isElementPickActive()) {
    return;
  }

  try {
    const type: unknown = event.type;
    if (typeof type !== 'string' || type === '') {
      return;
    }

    const open = currentOpenInteraction();
    if (open !== undefined) {
      coalesceInteraction(open, type);
      return;
    }

    startInteraction(event, type);
  } catch (error) {
    // Never into the page. Losing one interaction costs a trace; a thrown
    // exception costs the developer's application. The loss is reported so a
    // capture with no interactions is known to have lost them rather than
    // read as a developer who never clicked (AAP 0.5.5).
    reportProducerFailure('interaction', 'interaction-event', error);
  }
}

/**
 * Join an event of a listed type to the interaction already in flight.
 *
 * A gesture is one interaction (see the module header), so the type is
 * recorded as a member of a set, the dispatch probe is re-armed for this new
 * dispatch, and the close deadline moves out when that probe reports. The type
 * set is bounded by {@link MAX_COALESCED_EVENT_TYPES}; a page dispatching
 * synthetic events in a loop therefore costs a bounded array and nothing else.
 */
function coalesceInteraction(record: InteractionRecord, type: string): void {
  if (!record.eventTypes.includes(type) && record.eventTypes.length < MAX_COALESCED_EVENT_TYPES) {
    record.eventTypes.push(type);
  }
  scheduleSyncProbe(record);
}

/**
 * Open a new interaction: mint the trace, end the previous interaction's
 * continuation attribution, describe the target and start the clock.
 *
 * Order matters here and is worth stating.
 *
 * 1. The record is created and published **before** anything that could fail,
 *    so the window is open for the developer's own handler, which runs next.
 * 2. `notifyInteraction` is called immediately, because once the developer has
 *    clicked again, work following the *previous* response belongs to this
 *    click and not to that response (AAP 0.4.2). Passing this interaction's
 *    start keeps `./continuation.js` on one time base.
 * 3. The dispatch probe is scheduled before the target is described, so an
 *    interaction always has a close deadline coming even if describing the
 *    element yields nothing.
 * 4. The target is described last, from the same event, and attached to the
 *    record. `./dom-target.ts` bounds that work and returns `undefined` for a
 *    non-element target, so no guard is needed here beyond its contract.
 */
function startInteraction(event: Event, type: string): void {
  const timeStamp = readEventTimeStamp(event);
  const startPerfMs = perfNow();

  const record: InteractionRecord = {
    traceId: newTraceId(),
    spanId: newSpanId(),
    // Stamped at birth and never revised: this gesture belongs to the capture
    // that was armed when it happened, and to no later one.
    generation: attachGeneration,
    startTime: timeStamp === undefined ? nowEpochMs() : toEpochMs(timeStamp),
    startPerfMs,
    startRelativeMs: timeStamp ?? startPerfMs,
    eventTypes: [type],
    windowOpen: true,
    emitted: false,
  };

  activeInteraction = record;
  notifyInteraction(record.startTime);
  scheduleSyncProbe(record);
  describeInteractionTarget(record, event);
}

/**
 * Attach the target descriptor and nearest component name to a freshly opened
 * interaction.
 *
 * Separated from {@link startInteraction} so that a failure to describe the
 * element — which `./dom-target.ts` already guards against, and which a
 * hostile page's exotic `target` could still provoke — cannot cost the
 * interaction its trace or its close deadline.
 */
function describeInteractionTarget(record: InteractionRecord, event: Event): void {
  try {
    const target: unknown = event.target;

    const descriptor = describeElement(target);
    if (descriptor !== undefined) {
      record.target = descriptor;
    }

    const component = nearestComponentName(target);
    if (component !== undefined) {
      record.component = component;
    }
  } catch (error) {
    // An interaction with no target descriptor is still a complete, correlated
    // trace root; the panel shows the event type and the component chain is
    // simply absent. Reported because "which element was clicked" is evidence
    // the developer asked for, and its absence is otherwise indistinguishable
    // from a gesture on a non-element target.
    reportProducerFailure('interaction', 'target-describe', error);
  }
}

/**
 * The interaction whose window is genuinely open right now, applying the
 * lifetime safety valve.
 *
 * The single definition of "is a window open", used by every read and by the
 * event handler, so the answer cannot differ between them. A window past
 * {@link MAX_INTERACTION_LIFETIME_MS} is not merely reported as closed, it is
 * *finalised* — the interaction is emitted with what was measured and the
 * record is retired — because a starved close timer would otherwise leave a
 * stale window adopting every later event, which is the one failure this
 * module must not have.
 *
 * @param now The reader's instant in epoch milliseconds; defaults to the
 * clock.
 */
function currentOpenInteraction(now?: number): InteractionRecord | undefined {
  const record = activeInteraction;
  if (record === undefined || !record.windowOpen || record.emitted) {
    return undefined;
  }

  if (epochInstant(now) - record.startTime > MAX_INTERACTION_LIFETIME_MS) {
    closeInteraction(record);
    return undefined;
  }

  return record;
}

/**
 * Close the window and emit the interaction, exactly once.
 *
 * Idempotent by the `emitted` flag: the close timer, the safety valve on the
 * read path and a second close attempt all funnel through here, and only the
 * first does anything. The event is built *after* the window closes so its
 * duration is final — an event is immutable once emitted, and revising one
 * afterwards is impossible by design rather than merely discouraged.
 */
function closeInteraction(record: InteractionRecord): void {
  if (record.emitted) {
    return;
  }

  record.emitted = true;
  record.windowOpen = false;

  if (activeInteraction === record) {
    activeInteraction = undefined;
    lastInteraction = record;
    clearSyncTimer();
    clearCloseTimer();
  }

  emitInteraction(record);
}

/**
 * How long the interaction took, in milliseconds.
 *
 * Preference order, each step more informative than the next:
 *
 * 1. **`processingEnd` from a performance entry**, measured from the input
 *    event's own timestamp. The host's own account of the interaction, and the
 *    only one that includes the input delay on both ends.
 * 2. **The dispatch probe's reading**, which is always available for a real
 *    dispatch. When the event carried no usable timestamp,
 *    `startRelativeMs === startPerfMs` and this degenerates exactly to
 *    "synchronous end minus listener entry".
 * 3. **The elapsed wall-clock interval** since the interaction started, used
 *    when neither monotonic reading is available or when the monotonic result
 *    is implausible (see {@link MONOTONIC_DURATION_CEILING_MS}).
 *
 * Always finite and never negative, which is what the event schema accepts.
 */
function measureDuration(record: InteractionRecord): number {
  const end = record.processingEndPerfMs ?? record.syncEndPerfMs;

  if (end !== undefined) {
    const measured = end - record.startRelativeMs;
    if (Number.isFinite(measured) && measured <= MONOTONIC_DURATION_CEILING_MS) {
      return nonNegative(measured);
    }
  }

  return nonNegative(nowEpochMs() - record.startTime);
}

/**
 * The event type that names the interaction: the most meaningful of the
 * coalesced types (see {@link EVENT_TYPE_PRECEDENCE}).
 *
 * Falls back to the first type recorded, and then to the kind's own name,
 * which is unreachable in practice — an interaction is created with exactly
 * one type — and is stated so the function is total.
 */
function primaryEventTypeOf(record: InteractionRecord): string {
  for (const candidate of EVENT_TYPE_PRECEDENCE) {
    if (record.eventTypes.includes(candidate)) {
      return candidate;
    }
  }
  return record.eventTypes[0] ?? INTERACTION_KIND;
}

/**
 * The event's `name`: a short, stable label such as `click button`.
 *
 * Deliberately **not** the element's text. A label is read in a timeline row
 * and an event log, so it has to be stable across renders and identical for
 * two interactions of the same shape; the text — which is user data, and which
 * changes with the application's state — travels as a bounded, scrubbed
 * attribute instead.
 */
function interactionName(record: InteractionRecord): string {
  const type = primaryEventTypeOf(record);
  const tagName = record.target?.tagName;
  return tagName === undefined || tagName === '' ? type : `${type} ${tagName}`;
}

/**
 * The attribute bag of the emitted event.
 *
 * Every key comes from the constants above — the `interaction` vocabulary of
 * `../schema/attributes.ts` where it declares an equivalent — and a value that
 * is unknown for this interaction is **omitted rather than sent as `null`**:
 * absence is how this product says "not observed", and a consumer that
 * distinguishes an absent `interactionId` from a zero one is reading the
 * distinction the host itself makes.
 *
 * Arrays are copied. The record is handed out by
 * {@link getActiveInteraction} and the descriptor is reachable from it, so
 * sharing an array would let a later reader observe (or mutate) what an
 * already-emitted event carries.
 */
function buildAttributes(record: InteractionRecord): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  attributes[KEY_EVENT_TYPE] = primaryEventTypeOf(record);
  if (record.eventTypes.length > 1) {
    attributes[KEY_EVENT_TYPES] = [...record.eventTypes];
  }

  const target = record.target;
  if (target !== undefined) {
    attributes[KEY_TARGET_SELECTOR] = target.selector;
    attributes[KEY_TARGET_TAG_NAME] = target.tagName;
    if (target.text !== undefined) {
      attributes[KEY_TARGET_TEXT] = target.text;
    }
    if (target.componentChain.length > 0) {
      attributes[KEY_COMPONENT_CHAIN] = [...target.componentChain];
    }
  }

  if (record.component !== undefined) {
    attributes[KEY_COMPONENT] = record.component;
  }

  if (record.interactionId !== undefined) {
    attributes[KEY_INTERACTION_ID] = record.interactionId;
  }

  const processingStart = record.processingStartPerfMs;
  if (processingStart !== undefined) {
    attributes[KEY_PROCESSING_START] = toEpochMs(processingStart);
    attributes[KEY_INPUT_DELAY] = nonNegative(processingStart - record.startRelativeMs);
  }

  const processingEnd = record.processingEndPerfMs;
  if (processingEnd !== undefined) {
    attributes[KEY_PROCESSING_END] = toEpochMs(processingEnd);
    if (processingStart !== undefined) {
      attributes[KEY_PROCESSING_DURATION] = nonNegative(processingEnd - processingStart);
    }
  }

  return attributes;
}

/**
 * Emit the one `interaction` event for a closed interaction.
 *
 * **No `parentSpanId`.** This event is the root of its trace, and
 * `../correlation/correlator.ts` builds the tree the panels render on exactly
 * that assumption; a parent here would produce an orphaned root and a
 * timeline missing its first row.
 *
 * `./transport.ts` drops the event when no capture is active, so an attached
 * agent on a page the developer is merely browsing records nothing — which is
 * why this function neither checks nor knows about the capture state.
 */
function emitInteraction(record: InteractionRecord): void {
  try {
    const draft: EventDraft = {
      traceId: record.traceId,
      spanId: record.spanId,
      kind: INTERACTION_KIND,
      name: interactionName(record),
      startTime: record.startTime,
      duration: measureDuration(record),
      attributes: buildAttributes(record),
      status: 'ok',
    };
    emit(draft);
  } catch (error) {
    // `emit` never throws by contract; this guard covers the attribute build
    // over a descriptor from a hostile page, and costs one event rather than
    // the close path that called it. An interaction that was measured and then
    // never emitted is the most expensive loss this module can have, so it is
    // always stated.
    reportProducerFailure('interaction', 'emit', error);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Performance-entry refinement
 *
 * Everything below improves an interaction that is already being measured. It
 * may never become a precondition: the Event Timing threshold means a fast
 * interaction produces no entry at all, and some hosts reject the `event`
 * entry type outright.
 * ---------------------------------------------------------------------------
 */

/** Whether an entry is an `event` entry carrying the fields this module reads. */
function isEventTimingEntry(entry: PerformanceEntry): entry is EventTimingEntry {
  if (entry.entryType !== 'event') {
    return false;
  }

  const candidate = entry as PerformanceEntry & Partial<EventTimingEntry>;
  const { processingStart, processingEnd } = candidate;
  return (
    typeof processingStart === 'number' &&
    Number.isFinite(processingStart) &&
    typeof processingEnd === 'number' &&
    Number.isFinite(processingEnd) &&
    typeof candidate.name === 'string' &&
    typeof candidate.startTime === 'number' &&
    Number.isFinite(candidate.startTime)
  );
}

/**
 * Whether an entry describes this interaction.
 *
 * Two conditions, and both are needed. The entry's `name` must be one of the
 * types the interaction coalesced — that is what tells a `click` entry apart
 * from the `keydown` entry of a different gesture — and the entry must have
 * started inside the interaction's own window, widened by
 * {@link ENTRY_MATCH_TOLERANCE_MS}.
 *
 * The window rather than the start instant is compared because a gesture is
 * coalesced: the `click` of a slow tap starts hundreds of milliseconds after
 * the `pointerdown` that opened the interaction, so proximity to the start
 * alone would reject the entry that matters most. The lower bound is the
 * earlier of the two start readings and the upper bound is the close deadline,
 * which grows exactly as the interaction does, so the interval never outlives
 * the interaction it describes. `buffered: true` replays entries from before
 * the agent attached; they fall below every record's lower bound and are
 * ignored.
 */
function matchesEntry(record: InteractionRecord, entry: EventTimingEntry): boolean {
  if (!record.eventTypes.includes(entry.name)) {
    return false;
  }

  const start = Math.min(record.startRelativeMs, record.startPerfMs);
  const lower = start - ENTRY_MATCH_TOLERANCE_MS;
  const upper = (record.closeDeadlinePerfMs ?? record.startPerfMs) + ENTRY_MATCH_TOLERANCE_MS;
  return entry.startTime >= lower && entry.startTime <= upper;
}

/**
 * The interaction an entry belongs to: the open one, or the one that just
 * closed.
 *
 * The closed record is included because an entry is reported asynchronously
 * and can arrive after the window has closed. Applying it then refines the
 * diagnostic record only — the emitted event is immutable — which is the
 * documented cost of a host that reports late.
 */
function findRecordForEntry(entry: EventTimingEntry): InteractionRecord | undefined {
  const active = activeInteraction;
  if (active !== undefined && isCurrentGeneration(active) && matchesEntry(active, entry)) {
    return active;
  }

  const previous = lastInteraction;
  if (previous !== undefined && isCurrentGeneration(previous) && matchesEntry(previous, entry)) {
    return previous;
  }

  return undefined;
}

/**
 * Whether a record belongs to the observation period the module is in now.
 *
 * The entry path's half of {@link isLiveDeferral}: an observer whose
 * `disconnect()` threw is retained and adopted by the next attach (see
 * {@link observer}), so its batches can arrive in a period later than the one
 * the entries describe — including the `buffered: true` replay. Identity is
 * not enough there, because refinement legitimately applies to
 * {@link lastInteraction} as well as to the active record; the generation is
 * what separates "a late entry for this capture's gesture" from "an entry
 * about a capture that has ended", and applying the latter would extend a
 * closed window and emit through {@link extendWindow} into the wrong capture.
 */
function isCurrentGeneration(record: InteractionRecord): boolean {
  return record.generation === attachGeneration;
}

/**
 * Fold one entry's measurements into an interaction and extend its window.
 *
 * Which reading wins is chosen per field rather than by recency, because a
 * coalesced gesture reports one entry per event type: the **earliest**
 * `processingStart` is the input delay of the gesture, the **latest**
 * `processingEnd` is when its handlers finished, and the first non-zero
 * `interactionId` is the host's grouping of all of them. `entry.duration`
 * carries the presentation delay up to the next paint, and is used to hold the
 * window open through the commit that renders the gesture's result.
 */
function applyEntry(record: InteractionRecord, entry: EventTimingEntry): void {
  const { processingStart, processingEnd } = entry;

  record.processingStartPerfMs =
    record.processingStartPerfMs === undefined
      ? processingStart
      : Math.min(record.processingStartPerfMs, processingStart);

  record.processingEndPerfMs = laterOf(record.processingEndPerfMs, processingEnd) ?? processingEnd;

  const interactionId = entry.interactionId;
  if (
    record.interactionId === undefined &&
    typeof interactionId === 'number' &&
    Number.isFinite(interactionId) &&
    interactionId > 0
  ) {
    record.interactionId = interactionId;
  }

  const duration: unknown = entry.duration;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
    const entryEnd = entry.startTime + duration;
    record.entryEndPerfMs = laterOf(record.entryEndPerfMs, entryEnd) ?? entryEnd;
  }

  const end = laterOf(record.processingEndPerfMs, record.entryEndPerfMs);
  if (end !== undefined) {
    extendWindow(record, end + INTERACTION_TAIL_MS);
  }
}

/**
 * Handle one batch of observed entries.
 *
 * Runs in a task of its own, not on the click path, so the cost of the scan is
 * paid off the developer's critical path; an entry that matches nothing is
 * simply dropped.
 *
 * **Gated on {@link attached}**, for the same reason the event handler is: an
 * observer whose `disconnect()` threw is retained rather than forgotten (see
 * {@link observer}) and keeps delivering batches, and a detached module must
 * refine nothing — including the `buffered: true` replay a re-attach's
 * adoption would otherwise hand to a capture that has ended.
 */
function handleEntries(list: PerformanceObserverEntryList): void {
  if (!attached) {
    return;
  }

  try {
    for (const entry of list.getEntries()) {
      if (!isEventTimingEntry(entry)) {
        continue;
      }
      const record = findRecordForEntry(entry);
      if (record !== undefined) {
        applyEntry(record, entry);
      }
    }
  } catch (error) {
    // A host whose entry list or entries misbehave costs the refinement and
    // nothing else: the dispatch probe has already measured the interaction.
    // Reported at the lowest stakes in this file — the input-delay breakdown
    // is what goes missing — and reported anyway, because a panel showing no
    // input delay should not be read as an interaction that had none.
    reportProducerFailure('interaction', 'entry-batch', error);
  }
}

/**
 * Create and start the one `event`-timing observer, when the host has one.
 *
 * Both steps are guarded, and for different reasons: the constructor is absent
 * in hosts without the Performance Timeline at all, and `observe` throws
 * `TypeError` in a host that has `PerformanceObserver` but does not support
 * the `event` entry type. A failed `observe` disconnects what was constructed,
 * so no half-started observer is left holding a callback.
 *
 * Neither failure is reported through `reportProducerFailure`, and that is a
 * decision rather than an omission: both mean "this host does not offer event
 * timing", which is a capability difference (Firefox, happy-dom) and not a
 * producer that broke. Reporting it would spend this source's whole failure
 * budget on every such page and bury the failures that are real, while the
 * refinement it costs is one this module never depends on.
 *
 * @returns The started observer, or `undefined` when the refinement is
 * unavailable — in which case interactions are still measured and still
 * emitted.
 */
function createEventObserver(): PerformanceObserver | undefined {
  if (typeof PerformanceObserver === 'undefined') {
    return undefined;
  }

  let created: PerformanceObserver;
  try {
    created = new PerformanceObserver((list) => {
      handleEntries(list);
    });
  } catch {
    return undefined;
  }

  try {
    const init: EventTimingObserverInit = {
      type: 'event',
      buffered: true,
      durationThreshold: PERF_EVENT_DURATION_THRESHOLD_MS,
    };
    created.observe(init);
    return created;
  } catch {
    try {
      created.disconnect();
    } catch {
      // Nothing was observing; there is nothing left to release.
    }
    return undefined;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Listener registration
 * ---------------------------------------------------------------------------
 */

/**
 * Undo an `addEventListener` that threw, and say whether the type has to be
 * treated as registered anyway.
 *
 * **Why an add that threw needs an undo at all.** `addEventListener` is the
 * page's own function, and a page, an extension or a polyfill can replace it
 * with a wrapper that forwards to the native implementation — registering the
 * listener for real — and only then throws from its own bookkeeping. The
 * throw says nothing about whether the registration landed. Treating it as
 * "not registered" is what left a live, unrecorded listener on the window:
 * teardown would never attempt that type, the listener identity would be
 * released once the set emptied, and the next attach would add a second
 * closure beside the first, so one gesture would be observed twice by two
 * listeners under one gate. So the exact inverse call is attempted
 * immediately, with the same type, the same listener identity and the same
 * options object `removeEventListener` matches on.
 *
 * A removal for a type that was never registered is specified as a no-op, so
 * the attempt is free in the case where the throw happened before the native
 * call — which is why it is made unconditionally rather than guessed at.
 *
 * **The trade when the removal throws too**, stated the way `./errors.ts`
 * states the same one for its adoption rule: the type is then recorded as
 * believed-registered, and a later {@link attachInteractions} skips it. On a
 * page that has broken *both* functions that costs this module the events of
 * that one gesture type for the life of the document. The alternative —
 * assuming it is absent and adding again — costs a duplicated interaction per
 * gesture and a listener nobody can ever remove, which is the worse of the
 * two, and both failures report themselves so the frames say which happened.
 *
 * @param type The event type whose `addEventListener` threw.
 * @param listener The exact identity that was passed to it.
 * @returns `true` when the registration could not be undone and must be
 * treated as live; `false` once `removeEventListener` has returned for it, or
 * when there is no `window` and nothing can have been registered.
 */
function rollbackFailedAdd(type: InteractionEventType, listener: (event: Event) => void): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    window.removeEventListener(type, listener, LISTENER_OPTIONS);
    return false;
  } catch (error) {
    // Reported with its own stage id: this is the one failure that leaves a
    // registration this module can neither use nor remove, and it is a
    // different fact from the add that preceded it (AAP 0.5.5). The event type
    // is the developer's own vocabulary, not page data.
    reportProducerFailure('interaction', 'listener-add-rollback', error, { eventType: type });
    return true;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Start observing interactions: register the capture-phase listeners and the
 * `event`-timing observer.
 *
 * Called by `./agent.ts` when the service arms the interaction hook through
 * `agent.config`, and never at import time — a page the developer is merely
 * browsing gets no listener at all.
 *
 * **Idempotent.** A second call while attached does nothing, so a
 * re-configuration after a reconnect cannot double-register and produce two
 * interactions per click.
 *
 * Without a `window` there is nothing to listen to, so the module stays
 * detached and {@link isInteractionsAttached} says so; the Node preload and
 * the service import this package without ever reaching this function.
 *
 * **A re-attach is a repair, not a second install.** Teardown can leave
 * residue — a listener type the page refused to remove, an observer that threw
 * from `disconnect` (see {@link detachInteractions}) — and this function
 * adopts that residue instead of adding to it: only the types missing from
 * {@link registeredEventTypes} are registered, and a retained
 * {@link observer} is reused rather than replaced. Without that rule a
 * partial detach followed by a re-attach would leave two listeners for one
 * event type and two observers for one entry stream, which is two
 * interactions and two refinements for one gesture.
 *
 * Never throws. A per-type guard means one refused registration costs that
 * type and not the other four; the failure is reported, and the module is
 * attached with what it has — a partial signal that is stated is worth more
 * than no signal at all (AAP 0.5.5). A registration attempt that yields
 * nothing at all is treated as a failed attach: teardown runs and
 * {@link isInteractionsAttached} stays false, because a module with no
 * listener is not observing.
 *
 * **An `addEventListener` that throws is also rolled back**, because the throw
 * does not mean the registration did not happen: a wrapper around the page's
 * own `addEventListener` can forward to the native implementation and then
 * throw from its own bookkeeping, leaving a live listener this module never
 * recorded. {@link rollbackFailedAdd} attempts the exact inverse call at once
 * and the type is marked believed-registered when even that fails, so the
 * registration stays reachable by teardown instead of becoming a listener that
 * fires beside the next attach's fresh closure (AAP 0.5.1).
 */
export function attachInteractions(): void {
  try {
    if (attached || typeof window === 'undefined') {
      return;
    }

    // A new observation period begins here, before anything can be registered
    // or recorded. Everything the previous period left scheduled — a close
    // timer a broken `clearTimeout` would not cancel, a retained observer's
    // buffered replay — now carries a stale generation and is inert, so this
    // capture's telemetry cannot contain the previous capture's gestures
    // (see {@link attachGeneration}).
    attachGeneration += 1;

    // The identity a retained registration can be removed by is the identity
    // it was added with, so a listener held from a partial detach is reused
    // rather than replaced; a fresh one would make the residue unremovable.
    const listener =
      eventListener ??
      ((event: Event): void => {
        handleInteractionEvent(event);
      });

    // Published before the loop so that a failure part-way through leaves
    // every listener that *was* registered removable by the detach below.
    eventListener = listener;
    for (const type of INTERACTION_EVENT_TYPES) {
      if (registeredEventTypes.has(type)) {
        // Already on the page from an earlier attach whose detach could not
        // remove it. Registering again would double-fire this gesture.
        continue;
      }
      try {
        window.addEventListener(type, listener, LISTENER_OPTIONS);
        registeredEventTypes.add(type);
      } catch (error) {
        // The event type is the developer's own vocabulary (`click`), not page
        // data, so it travels as detail and says which gesture is unobserved.
        reportProducerFailure('interaction', 'listener-add', error, { eventType: type });
        // A wrapper that registered and *then* threw has left a live listener
        // behind; the inverse call is attempted at once and the type is
        // recorded as registered only if that removal failed as well (see
        // {@link rollbackFailedAdd}). Recording it on the way out of a throw
        // is what keeps the page's actual registrations reachable.
        if (rollbackFailedAdd(type, listener)) {
          registeredEventTypes.add(type);
        }
      }
    }

    if (registeredEventTypes.size === 0) {
      // Not one type registered, so there is no gesture to observe and no
      // interaction can be measured. Teardown releases the listener identity
      // and any observer retained from an earlier cycle, and `attached` stays
      // false: claiming to observe here would put a capability in
      // `./agent.ts`'s status frame that this module does not have.
      reportProducerFailure('interaction', 'attach-no-listener');
      detachInteractions();
      return;
    }

    observer = observer ?? createEventObserver();
    attached = true;
  } catch (error) {
    // Reached only by a host that breaks outside the per-step guards above.
    // Teardown is the safe state: it is itself guarded and it retains
    // whatever it cannot release.
    reportProducerFailure('interaction', 'attach', error);
    detachInteractions();
  }
}

/**
 * Stop observing interactions and release everything held.
 *
 * Called by `./agent.ts` when the service clears the hooks — an `agent.config`
 * with every hook false, which AAP 0.5.1 requires to leave the agent
 * "disabled, not merely idled". Afterwards this module observes nothing: a
 * later click emits nothing, measures nothing and schedules nothing. In the
 * ordinary case it also *holds* nothing — no listener, no observer, no timer
 * and no record of anything the developer did — and in the case where the page
 * refuses a removal, what could not be released is retained on purpose and
 * inert (rule 3 below), because a reference nobody remembers is a leak nobody
 * can fix.
 *
 * The interaction in flight, if any, is **dropped rather than emitted**.
 * Detaching means the capture has stopped, and an event emitted after that
 * point would extend a capture the developer has already ended.
 *
 * Does **not** reset `./continuation.js`: teardown ordering across the agent's
 * hooks belongs to `./agent.ts`, which calls `resetContinuations()` itself.
 * Safe to call when already detached, and never throws.
 *
 * ## Seven rules, because one `try` around all of it is a lie
 *
 * The page owns `removeEventListener`, and a page — or an extension, or a
 * polyfill — can replace it with something that throws. A host can throw from
 * `PerformanceObserver.disconnect` or from `clearTimeout`. With the whole
 * sequence in one `try`, the first such failure would skip the remaining
 * listener types, the observer, both timers and the state reset, and the
 * module would still have said it was detached. AAP 0.5.1 requires the
 * opposite — hooks "disabled, not merely idled" — so teardown is built to
 * these rules:
 *
 * 1. **Disarm first.** {@link attached} is set `false` before anything is
 *    removed, so every callback in this file is inert from this instant even
 *    if nothing below succeeds.
 * 2. **One guard per step.** Each listener removal, the observer disconnect,
 *    each timer clear and the state reset stand alone. A failure in one is
 *    contained, reported with its own stage id, and the next step still runs.
 * 3. **Retain what did not come back.** A type that was not removed stays in
 *    {@link registeredEventTypes} and an observer that would not disconnect
 *    stays in {@link observer}, so the next detach retries them and a
 *    re-attach adopts them (see {@link attachInteractions}).
 * 4. **Attached state is derived, not asserted.**
 *    {@link isInteractionsAttached} means "observing" and is `false` from
 *    rule 1 onwards; what is genuinely still on the page lives in the
 *    retained set and reference, not in a flag that would have to lie, and
 *    {@link hasInteractionsResidue} is how a caller reads it.
 * 5. **Nothing is silent.** Each contained failure posts one bounded
 *    `agent.error` frame, so a teardown that could not complete is visible in
 *    both UIs instead of being a clean-looking detach (AAP 0.5.5).
 * 6. **The sweep is authoritative, the set is not.** While a listener identity
 *    is held, removal is attempted for **every** member of
 *    {@link INTERACTION_EVENT_TYPES} rather than for the types the set happens
 *    to list. The set is a belief about the page (see
 *    {@link registeredEventTypes}) and a page that registers a listener and
 *    then throws from its own `addEventListener` wrapper produces a
 *    registration the belief cannot name: driving teardown from the set would
 *    skip that type, drop the listener identity once the set emptied, and
 *    leave a listener firing beside the next attach's own — two observations
 *    of one gesture, one of them unreachable for ever. Attempting a removal
 *    for a type that was never registered is a specified no-op, so the
 *    unconditional sweep is the cheap half of the trade.
 * 7. **The observation period ends here.** {@link attachGeneration} advances
 *    beside the disarm, so every record this period opened and every callback
 *    it scheduled is residue from this instant — including the close timer of
 *    an interaction in flight, which a page that broke `clearTimeout` leaves
 *    pending. Without it, that timer would find {@link attached} `true` again
 *    once the developer started the next capture and would emit a gesture that
 *    happened before that capture began, stamped with its capture id and its
 *    sequence number. An event that belongs to a capture that ended must never
 *    be attributed to the capture that replaced it.
 */
export function detachInteractions(): void {
  // Rule 1 — disarm before releasing anything. From here the event handler,
  // the observer callback and both timer callbacks return immediately, so a
  // registration that survives the steps below observes nothing.
  attached = false;

  // Rule 7 — end the observation period in the same breath. The flag alone
  // goes true again on the next attach, so it cannot keep this period's
  // residue out of the *next* capture; the generation can, and advancing it
  // here means a detach on its own is enough to invalidate everything this
  // period scheduled, even if not one of the releases below succeeds.
  attachGeneration += 1;

  try {
    const listener = eventListener;
    if (listener !== undefined && typeof window !== 'undefined') {
      // Rule 6 — the sweep, not the set, decides what is attempted. Every
      // declared type is tried while a listener identity is held, because a
      // registration this module never recorded (an `addEventListener` wrapper
      // that registered and then threw) is exactly the one the set cannot name
      // and the one that would otherwise stay on the page for the life of the
      // document. A removal for a type that was never registered is a
      // specified no-op, so the extra attempts cost nothing.
      for (const type of INTERACTION_EVENT_TYPES) {
        try {
          window.removeEventListener(type, listener, LISTENER_OPTIONS);
          // Rule 3 — deleted only once removal returned.
          registeredEventTypes.delete(type);
        } catch (error) {
          // What throws is residue: recorded (or kept) as believed-registered
          // so the next detach retries it, a re-attach adopts rather than
          // duplicates it, and {@link hasInteractionsResidue} can name it.
          registeredEventTypes.add(type);
          reportProducerFailure('interaction', 'listener-remove', error, { eventType: type });
        }
      }
    }

    // The listener identity is released only when nothing is believed
    // registered with it any more; holding it is the only way a retained
    // registration can ever be removed.
    if (registeredEventTypes.size === 0) {
      eventListener = undefined;
    }

    const current = observer;
    if (current !== undefined) {
      try {
        current.disconnect();
        observer = undefined;
      } catch (error) {
        // Retained, not dropped: the host refused to stop it, so the next
        // detach retries and a re-attach adopts this one instead of adding a
        // second observer to the same entry stream.
        reportProducerFailure('interaction', 'observer-disconnect', error);
      }
    }

    // Both timers clear their own handle only after `clearTimeout` returned,
    // so a failure here leaves the handle for the next detach as well. The
    // disarm above is what makes a timer that still fires harmless.
    try {
      clearSyncTimer();
    } catch (error) {
      reportProducerFailure('interaction', 'sync-timer-clear', error);
    }

    try {
      clearCloseTimer();
    } catch (error) {
      reportProducerFailure('interaction', 'close-timer-clear', error);
    }

    try {
      // The interaction in flight is dropped rather than emitted, and the
      // closed record goes with it: a dormant agent holds no observation of
      // what the developer did (AAP 0.5.1). Guarded like every other step —
      // two assignments to module bindings cannot throw today, and the guard
      // is what keeps that from being a precondition of the rule above, so a
      // step added here inherits the containment and the report rather than
      // reintroducing the all-or-nothing teardown this sequence replaced.
      activeInteraction = undefined;
      lastInteraction = undefined;
    } catch (error) {
      reportProducerFailure('interaction', 'state-reset', error);
    }
  } catch (error) {
    // Unreachable while every step above carries its own guard, and kept so
    // that "detach never throws into the page" holds structurally rather than
    // by inspection of the body.
    reportProducerFailure('interaction', 'detach', error);
  }
}

/**
 * Whether this module is observing interactions right now.
 *
 * `./agent.ts` reports this in its readiness and status frames, and it is
 * `false` in a context with no `window` even after {@link attachInteractions}
 * was called, because nothing was registered there.
 *
 * Precisely "observing", which is the question every caller is actually
 * asking: `false` means no interaction is measured, no trace is minted and no
 * timer is armed, whatever the page did with the removals in
 * {@link detachInteractions}. A registration that could not be removed does
 * **not** make this `true` — it is inert (see {@link handleInteractionEvent}),
 * it is remembered in {@link registeredEventTypes}, it is reported as an
 * `agent.error` when it happens, and it is readable at any time through
 * {@link hasInteractionsResidue} — which is where a caller that needs to know
 * whether the page is clean asks. Having this answer "attached" for a listener
 * that observes nothing would give `./agent.ts` a status frame nobody could
 * act on.
 */
export function isInteractionsAttached(): boolean {
  return attached;
}

/**
 * Whether the page still carries a registration this module's last detach
 * could not remove — a listener, an observer or a scheduled timer.
 *
 * The companion to {@link isInteractionsAttached}, and the reason both exist:
 * "observing" and "clean" are different questions and a single answer to both
 * would have to lie about one of them. `isInteractionsAttached()` is `false`
 * the instant teardown disarms, which is what makes a surviving registration
 * inert; this function is what makes that survival **visible**, so
 * `./agent.ts` can name this hook in the `hooks-not-released` frame AAP 0.5.1
 * and 0.5.5 require — the developer is the only party who can act on it, by
 * reloading the tab, and they cannot act on a fact nobody reports.
 *
 * `true` when any of three things is still held after a detach:
 *
 * - a type in {@link registeredEventTypes}, which means a capture-phase
 *   listener is still on the window (or could not be proved absent — see that
 *   set for the belief it records);
 * - a retained {@link observer}, which means `disconnect()` threw and the host
 *   is still delivering entry batches;
 * - an uncleared {@link syncTimer} or {@link closeTimer}, which means
 *   `clearTimeout` threw and a callback is still scheduled in the page.
 *
 * `false` while {@link attached} is `true`: an armed module's listeners,
 * observer and timers are its live instrumentation, not residue, and reporting
 * them as unreleased during a capture would make the announcement meaningless.
 * `false` also — and this is the case a clean teardown reaches — when nothing
 * at all is held.
 *
 * Never throws: it is read from a diagnostic path that runs while the agent is
 * being torn down, so a failure here must not become the reason teardown ends
 * badly. A read that could not complete answers `true`, because it cannot
 * prove the page is clean, and states itself as a producer failure.
 */
export function hasInteractionsResidue(): boolean {
  try {
    if (attached) {
      return false;
    }

    return (
      registeredEventTypes.size > 0 ||
      observer !== undefined ||
      syncTimer !== undefined ||
      closeTimer !== undefined
    );
  } catch (error) {
    reportProducerFailure('interaction', 'residue-read', error);
    return true;
  }
}

/**
 * A snapshot of the interaction whose window is open, or `undefined` when
 * none is.
 *
 * For diagnostics — `./agent.ts`'s status frame and the tests. A fresh object
 * with a copied `eventTypes` array, so a reader cannot disturb the
 * interaction; the target descriptor is shared and is read-only by the
 * contract of `./dom-target.ts`.
 *
 * Applies the same lifetime safety valve as every other read (see
 * {@link currentOpenInteraction}), so a diagnostic read can finalise a window
 * whose close timer was starved. That is deliberate: one definition of "open"
 * for every caller is worth more than a side-effect-free getter, and the
 * alternative is a reader that sees a window {@link isInteractionWindowOpen}
 * calls closed.
 */
export function getActiveInteraction(): ActiveInteraction | undefined {
  try {
    const record = currentOpenInteraction();
    if (record === undefined) {
      return undefined;
    }

    const snapshot: ActiveInteraction = {
      traceId: record.traceId,
      spanId: record.spanId,
      startTime: record.startTime,
      startPerfMs: record.startPerfMs,
      eventTypes: [...record.eventTypes],
      windowOpen: record.windowOpen,
    };

    if (record.target !== undefined) {
      snapshot.target = record.target;
    }
    if (record.component !== undefined) {
      snapshot.component = record.component;
    }
    if (record.processingEndPerfMs !== undefined) {
      snapshot.processingEndPerfMs = record.processingEndPerfMs;
    }

    return snapshot;
  } catch (error) {
    // A status frame that reported "no interaction" for a failed read would be
    // indistinguishable from an idle page, so the failure is stated instead.
    reportProducerFailure('interaction', 'snapshot-read', error);
    return undefined;
  }
}

/**
 * Whether an interaction window is open at `now`.
 *
 * True from inside the capture-phase dispatch — so the developer's own handler
 * runs inside an open window — until {@link INTERACTION_TAIL_MS} after the
 * synchronous dispatch ended, extended to `processingEnd` plus that tail when
 * a performance entry says the handlers ran longer.
 *
 * @param now The reader's instant in **epoch milliseconds**, the same base
 * `./continuation.js` uses; defaults to the clock. Supplying it lets one
 * decision be made against one instant rather than against three reads of a
 * moving clock.
 */
export function isInteractionWindowOpen(now?: number): boolean {
  try {
    return currentOpenInteraction(now) !== undefined;
  } catch (error) {
    // `false` is the safe answer — it costs `./fetch.ts` a `traceparent`
    // injection rather than propagating a trace that may not exist — and it
    // costs the capture the server half of that request, so it is reported.
    reportProducerFailure('interaction', 'window-read', error);
    return false;
  }
}

/**
 * Which trace an event being emitted right now belongs to, and which span it
 * hangs from.
 *
 * The contract `./fetch.ts`, `./react.ts`, `./state.ts`, `./perf.ts` and
 * `./errors.ts` call once per event, and the only place the precedence between
 * the two windows is decided:
 *
 * 1. **An interaction window is open** → the event is a child of the
 *    interaction's root span, in the interaction's trace. `origin:
 *    'interaction'`.
 * 2. **Otherwise `./continuation.js` has an open continuation window** → the
 *    event is a child of the settled request that opened it, in that request's
 *    trace, with the lineage annotation written by that module's
 *    `applyLineageAttributes`. `origin: 'continuation'`.
 * 3. **Otherwise** → a fresh root. A standalone error, a page-load performance
 *    entry or a polling request is still a valid, self-contained trace, and a
 *    fresh root says "no evidenced cause" where a borrowed trace id would
 *    quietly claim one. `origin: 'synthetic'`.
 *
 * **Callers must merge {@link EventContext.attributes} into their own
 * attribute record before emitting** — this is the part that is easy to miss,
 * and missing it costs the panel the dashed edge that marks an ambiguous
 * attribution:
 *
 * ```ts
 * const context = resolveEventContext();
 * const attributes: Record<string, unknown> = { ...context.attributes, component };
 * emit({ traceId: context.traceId, parentSpanId: context.parentSpanId, attributes, ... });
 * ```
 *
 * Cheap and allocation-light: one object on the interaction path, one object
 * and one attribute bag on the continuation path, and one minted trace id on
 * the synthetic path. It runs once per emitted event, including once per
 * rendered component in a React commit.
 *
 * @param now The instant the event landed, in epoch milliseconds; defaults to
 * the clock. One value is used for both the interaction check and the lineage
 * lookup, so the two cannot disagree about which window was open.
 */
export function resolveEventContext(now?: number): EventContext {
  try {
    const at = epochInstant(now);

    const active = currentOpenInteraction(at);
    if (active !== undefined) {
      return { traceId: active.traceId, parentSpanId: active.spanId, origin: 'interaction' };
    }

    const lineage = getLineage(at);
    if (lineage !== undefined) {
      // `./continuation.js` is the single writer of the lineage vocabulary, so
      // the bag is handed to it rather than filled in here.
      const attributes: Record<string, unknown> = {};
      applyLineageAttributes(attributes, lineage);
      return {
        traceId: lineage.traceId,
        parentSpanId: lineage.parentSpanId,
        attributes,
        origin: 'continuation',
      };
    }

    return { traceId: newTraceId(), origin: 'synthetic' };
  } catch (error) {
    // An event must always have a trace to belong to. A fresh synthetic root
    // is the answer that cannot be wrong about causation — and it detaches the
    // event from the gesture that caused it, which is exactly the kind of
    // silent evidence loss AAP 0.5.5 requires the capture to state.
    reportProducerFailure('interaction', 'context-resolve', error);
    return { traceId: newTraceId(), origin: 'synthetic' };
  }
}

/**
 * Whether a context descends from an observed interaction, rather than being
 * a root of its own.
 *
 * `./fetch.ts` uses this as the precondition for injecting `traceparent` on a
 * same-origin request. The reasoning, recorded here because it is the one
 * judgement in this module that is not mechanical: AAP 0.4.2 specifies
 * injection "while an interaction window is active", and a
 * continuation-derived context *is* that same interaction — the continuation
 * window exists precisely to carry the interaction's trace across the
 * response that the interaction caused, and the request it parents belongs to
 * the same tree. A synthetic root does not qualify: propagating it would make
 * the developer's server emit spans for background traffic nobody asked
 * about, and every one of those traces would be a root with no interaction
 * above it.
 *
 * @param context A context from {@link resolveEventContext}.
 */
export function isTracedContext(context: EventContext): boolean {
  return context !== null && typeof context === 'object' && context.origin !== 'synthetic';
}
