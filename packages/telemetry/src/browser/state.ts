/**
 * React state-transition evidence: one `state` event per hook value and per
 * consumed context value that changed in a commit.
 *
 * "Why is this component rendering so many times?" is answered by three
 * things: how often it rendered, what its inputs were, and **what changed just
 * before it did**. The third is this module's product. `./fiber-diff.ts` has
 * already compared the fiber against its alternate and produced the bounded,
 * scrubbed summaries; `./react.ts` calls {@link recordStateTransitions} once
 * per rendered fiber from inside the commit callback; and what leaves here is
 * the row `StateTransitionViewer` renders as "old → trigger → new"
 * (AAP 0.6.2), assembled by `../aggregate/timeline.ts`'s
 * `aggregateStateTransitions` into the `stateTransitions` data source.
 *
 * ## What this module does not do
 *
 * - **No diffing.** It never touches a fiber, an alternate or a hook chain. A
 *   second implementation of that walk would mean two different privacy
 *   bounds in one repository, and the bound is a documented guarantee
 *   (AAP 0.5.2), not an implementation detail. Every value that reaches an
 *   event here arrived as a {@link ValueSummary} from `./fiber-diff.ts`.
 * - **No redaction.** Scrubbing and truncation happened inside
 *   `./fiber-diff.ts`, in the order its contract fixes (scrub, then
 *   truncate). Doing either again would truncate an already-truncated preview
 *   and tell the developer a value was cut twice as far as it was.
 *   `../redaction/redactor.ts` is still the service-side backstop; it is not a
 *   step this module performs.
 * - **No subscriptions, no DOM, no timers.** The fiber data arrives by call.
 *   There is nothing to listen to, which is why {@link attachState} has
 *   nothing to register — see the lifecycle note below.
 *
 * ## Why attach/detach exists at all
 *
 * `agent.config` can arm React render capture *without* state capture: the two
 * are separate hooks in the service's configuration, and a developer asking
 * about request duplication has no use for a provider's value transitions. So
 * this module needs an off switch of its own, and `./agent.ts` drives every
 * hook in this folder through one uniform lifecycle — attach, detach, ask
 * whether it is attached. {@link attachState} and {@link detachState}
 * therefore flip a flag and reset the counters, and that is the whole of it.
 * Detached, {@link recordStateTransitions} returns before it allocates, which
 * is what "disabled, not merely idled" (AAP 0.5.1) means for a module whose
 * input is a function argument rather than an event listener.
 *
 * ## Duration is zero, deliberately
 *
 * A transition is a point in time, not an interval: `useState` published a new
 * value, and there is no "how long did it take". `../schema/event.ts` declares
 * zero legal for exactly this case, and `Timeline`, `Waterfall` and
 * `FlameChart` draw a zero-duration event as an instant. A synthetic duration
 * — the commit's, the render's, one millisecond "so it shows up" — would be
 * added into `frontend_duration` and into every per-tier total on the panel,
 * inventing time the application never spent. Do not give this event a
 * duration.
 *
 * ## Attribute keys: the catalog's where it has them, four named additions
 *
 * `../schema/attributes.ts` is authoritative, and its `state` tuple supplies
 * `component`, `hookIndex`, `hookLabel`, `previousValue` (this module's
 * `from`) and `nextValue` (its `to`). Four keys have no equivalent there and
 * are spelled out below so that catalog can adopt them verbatim:
 * `transitionSource`, `renderSpanId`, `fiberId` and `truncated`.
 *
 * The one catalog key this module deliberately leaves **unset** is
 * `triggerEventId`, and the reason is a live consumer rather than a
 * preference. `../aggregate/timeline.ts`'s `resolveTrigger` reads that key,
 * looks the value up among event **ids** (`evt_…`, minted by `./transport.ts`)
 * and — when it is present — stops there instead of walking the parent chain.
 * What `./react.ts` holds is the interaction's, or a settled request's, **span
 * id**: a different identifier space. Writing it under `triggerEventId` would
 * give the viewer a link to an event that does not exist *and* suppress the
 * resolution that would have worked. So the span id travels under
 * `triggerSpanId`, matching the field name the aggregate's `StateTransition`
 * already uses, and the parent-chain route keeps answering. A producer that
 * one day knows the trigger's event id should write `triggerEventId` then.
 *
 * ## Bounds are load-bearing
 *
 * The demo's second seeded defect ticks a provider every 250 ms with 48 cards
 * consuming it (AAP 0.8.2): a minute of that is thousands of transitions. Two
 * bounds keep one capture from becoming a memory profile of the page —
 * {@link MAX_TRANSITIONS_PER_COMMIT} per call and
 * {@link MAX_TRANSITIONS_PER_CAPTURE} per capture — and when either bites, the
 * last event emitted says so with `truncated`. A panel that knows a list was
 * cut can tell the developer; a panel handed a silently short list presents it
 * as exhaustive, which is the failure this product exists to avoid.
 *
 * ## Imports are a constraint, not a coincidence
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this folder into the IIFE
 * injected into the developer's page at `document_start` and hard-fails on any
 * input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared/node` or `zod`. The four imports below are the whole list:
 * ids and transport for behaviour, `./fiber-diff.js` and `./interaction.js`
 * for the shapes that arrive (type-only, so no dependency direction is
 * implied at runtime), and the attribute catalog for the key spellings and the
 * shared privacy bound. `./react.js` is **not** imported and must never be:
 * that module imports this one, and the cycle would be a build failure rather
 * than a subtle bug.
 *
 * @see ./fiber-diff.ts for the diff and the privacy bounds it applies.
 * @see ../schema/attributes.ts for the `state` attribute vocabulary.
 * @see ../aggregate/timeline.ts for the aggregate these events feed.
 */

import { isSpanId, isTraceId, newSpanId } from './ids.js';
import { emitMany, nowEpochMs, type EventDraft } from './transport.js';
import type { ContextChange, HookChange, ValueSummary } from './fiber-diff.js';
import type { EventContext } from './interaction.js';
import {
  MAX_TRACKED_KEYS,
  type AttributeValueSummary,
  type STATE_ATTRIBUTE_KEYS,
} from '../schema/attributes.js';

/*
 * ---------------------------------------------------------------------------
 * Contract constants
 *
 * Exported because each one is part of a contract a caller or a test reasons
 * about — `./agent.ts` resets the per-capture counter, and a panel's "list was
 * cut" banner is only honest if the bound that cut it is nameable — and not
 * because either is a tuning knob. Both are frozen vocabularies or plain
 * numbers; neither is state.
 * ---------------------------------------------------------------------------
 */

/**
 * The most transitions one call may emit: 32.
 *
 * Taken from `MAX_TRACKED_KEYS` rather than restated, because that constant is
 * already the privacy bound for "hook entries on a `state` event"
 * (`../schema/attributes.ts`) and `./fiber-diff.ts` caps each dimension it
 * scans by the same number. Restating the literal here would let the emitter's
 * bound drift away from the differ's, and a capture would then carry more
 * transitions than the dimension they came from was allowed to report.
 *
 * One fiber can still exceed it: hook state and consumed contexts are two
 * dimensions of at most 32 entries each, and this bound applies to the pair
 * together. The excess is counted and marked, never dropped silently.
 */
export const MAX_TRANSITIONS_PER_COMMIT = MAX_TRACKED_KEYS;

/**
 * The most transitions one capture may emit: 5 000.
 *
 * A deliberate ceiling on the *cumulative* total since the last
 * {@link resetStateCounters}, which is a different quantity from
 * `./transport.ts`'s `MAX_BUFFERED_EVENTS` (a queue depth, drained on every
 * flush) even though the two numbers happen to agree. A provider publishing on
 * a timer produces transitions for as long as the developer leaves the capture
 * running, and past a few thousand the additional rows say nothing the first
 * few thousand did not: the pattern is already visible, and
 * `../aggregate/timeline.ts` pages its result at a thousand anyway.
 *
 * The bound is not a filter on *which* transitions are kept — they are the
 * earliest, in emission order — and reaching it is reported through
 * {@link getStateStats} and on the last emitted event.
 */
export const MAX_TRANSITIONS_PER_CAPTURE = 5000;

/**
 * The two kinds of value a transition can describe: the fiber's own hook state,
 * and a context value it consumes.
 *
 * Frozen, like every other vocabulary in this package: a reader of a `state`
 * event's `transitionSource` attribute is reading one of these two strings and
 * nothing else. `unchanged` and the rest of `RenderTrigger` are deliberately
 * absent — that vocabulary classifies *why a fiber rendered*, which is a
 * `render` event's business, while this one says *which dimension changed*.
 */
export const TRANSITION_SOURCES = Object.freeze(['state', 'context'] as const);

/** One member of the closed transition-source vocabulary. */
export type TransitionSource = (typeof TRANSITION_SOURCES)[number];

/*
 * ---------------------------------------------------------------------------
 * Attribute keys
 *
 * Every key this module writes, resolved once. The five the catalog declares
 * are annotated with its tuple's member union, so a rename there is a compile
 * error here rather than an attribute the aggregate silently stops finding.
 * The four it does not declare are plain string constants, each with the note
 * that names it as an addition.
 * ---------------------------------------------------------------------------
 */

/** A key the catalog declares for the `state` kind. */
type StateAttributeKey = (typeof STATE_ATTRIBUTE_KEYS)[number];

/** The component whose hook or context value changed. */
const KEY_COMPONENT: StateAttributeKey = 'component';

/** The hook's zero-based position in the fiber's hook list. */
const KEY_HOOK_INDEX: StateAttributeKey = 'hookIndex';

/** The inferred hook kind or context display name; diagnostic only. */
const KEY_HOOK_LABEL: StateAttributeKey = 'hookLabel';

/** Summary of the value before the transition — this module's `from`. */
const KEY_PREVIOUS_VALUE: StateAttributeKey = 'previousValue';

/** Summary of the value after the transition — this module's `to`. */
const KEY_NEXT_VALUE: StateAttributeKey = 'nextValue';

/**
 * Which dimension changed: a member of {@link TRANSITION_SOURCES}.
 *
 * **Addition**, spelled `transitionSource`, for `../schema/attributes.ts` to
 * adopt into `STATE_ATTRIBUTE_KEYS`. Without it a consumer cannot tell a hook
 * transition from a context transition, and those support different
 * conclusions: a component's own state changing is the component's doing,
 * while a consumed context changing is a provider's.
 */
const KEY_TRANSITION_SOURCE = 'transitionSource';

/**
 * The span id of the interaction, or of the settled request, that this work is
 * attributed to.
 *
 * **Addition**, spelled `triggerSpanId` to match the field
 * `../aggregate/timeline.ts`'s `StateTransition` already exposes. See the
 * module documentation for why the catalog's `triggerEventId` is not used for
 * a span id.
 */
const KEY_TRIGGER_SPAN_ID = 'triggerSpanId';

/**
 * The span id of the render this transition was observed in — the same value
 * as the event's `parentSpanId`.
 *
 * **Addition**, spelled `renderSpanId`. Duplicating the parent onto the
 * attribute bag costs sixteen characters and buys a filterable, groupable
 * field: the aggregates read attributes, and "every transition seen in this
 * render" is a question a panel asks without walking the trace tree.
 */
const KEY_RENDER_SPAN_ID = 'renderSpanId';

/**
 * The fiber's identity within the document, when `./react.ts` resolved one.
 *
 * **Addition**, spelled `fiberId`. Two components with the same display name
 * are one row when grouped by `component`; the fiber id is what distinguishes
 * the forty-eighth card from the first.
 */
const KEY_FIBER_ID = 'fiberId';

/**
 * Set to `true` on the last event of a call whose transition list was cut by
 * one of the two bounds.
 *
 * **Addition**, spelled `truncated`. Note the level: this is a statement about
 * the *list of transitions*, whereas the `truncated` field inside a
 * `previousValue` or `nextValue` summary is a statement about that one
 * preview. Both are needed and neither implies the other.
 */
const KEY_TRUNCATED = 'truncated';

/*
 * ---------------------------------------------------------------------------
 * Event shape constants
 *
 * The kind and status are annotated against `./transport.ts`'s draft type
 * rather than against `../schema/kinds.js`, which this folder's module list
 * does not put in this file's import whitelist. The effect is the same: the
 * draft type is derived from the event schema, which is derived from that
 * vocabulary, so a misspelling here does not compile.
 * ---------------------------------------------------------------------------
 */

/** Every event this module emits is of the `state` kind. */
const STATE_KIND: EventDraft['kind'] = 'state';

/**
 * Every transition is reported as `ok`.
 *
 * A state change is an observation, not an operation that can fail: there is
 * no failure mode of "the value changed". A diff this module could not read is
 * reported by the absence of a value summary, not by an error status, because
 * the transition itself was still observed.
 */
const TRANSITION_STATUS: EventDraft['status'] = 'ok';

/**
 * The duration every transition carries: zero.
 *
 * Named rather than inlined so the module documentation's reasoning has
 * something to attach to. See that section before changing it — a non-zero
 * value here distorts every per-tier duration on the panel.
 */
const TRANSITION_DURATION_MS = 0;

/**
 * The most code points of a component's display name that reach an event
 * *name*: 160.
 *
 * `../schema/event.ts` rejects a name longer than 512 characters, and a
 * display name comes from the developer's own code — usually a dozen
 * characters, occasionally a generated monster from a higher-order component
 * chain. Clamping the name keeps a pathological one from costing the whole
 * event, and the `component` **attribute** is deliberately left unclamped: the
 * aggregates group `state` and `render` events by that value, so a name
 * shortened here and not there would split one component into two rows.
 */
const MAX_NAME_COMPONENT_LENGTH = 160;

/** The slot word used in a hook transition's name. */
const HOOK_SLOT = 'hook';

/** The slot word used in a context transition's name. */
const CONTEXT_SLOT = 'context';

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * Everything one call needs: which component, which trace, which instant, and
 * the changes `./fiber-diff.ts` found.
 *
 * The three correlation fields are typed **through**
 * {@link EventContext} — the answer `./interaction.ts` gives to "which trace is
 * this?" — rather than as fresh `string`s, so the flattened form a caller
 * passes here cannot drift from the shape it received. `./react.ts` resolves
 * one context per commit and spreads it across the render event and the
 * transitions beneath it.
 *
 * Every field is validated on arrival: a malformed `traceId` costs the call
 * (counted in {@link getStateStats}), and a malformed parent, trigger, fiber id
 * or timestamp costs only itself. A commit callback is the wrong place to throw
 * and the wrong place to lose evidence, so the rule is "report what can be
 * described, say what could not".
 */
export interface RecordTransitionsInput {
  /**
   * Display name of the component whose values changed, from
   * `./react.ts`'s `getDisplayName`.
   *
   * Emitted verbatim as the `component` attribute — the key the render
   * aggregates group by — and clamped only where it appears inside the event's
   * name. A value that is not a non-empty string is omitted rather than
   * replaced with a placeholder: an invented component name would group real
   * transitions under a component that does not exist.
   */
  component: string;

  /**
   * The fiber's identity within this document, when one was resolved
   * (bippy's `getFiberId`).
   *
   * What separates the forty-eighth card from the first when both render the
   * same component. Omitted when unknown; a non-integer is ignored.
   */
  fiberId?: number;

  /** The trace the transitions join: 32 lowercase hex characters. */
  traceId: EventContext['traceId'];

  /**
   * The render span the transitions were observed in, which becomes each
   * event's `parentSpanId` so a transition sits *inside* its render.
   *
   * Absent — or not a well-formed span id — leaves the events parented at the
   * trace root, which `../correlation/correlator.ts` attaches rather than
   * drops. Parenting under the render is what lets the timeline nest the
   * transition where a reader expects it.
   */
  parentSpanId?: EventContext['parentSpanId'];

  /**
   * When the commit that observed the transitions started: Unix epoch
   * milliseconds as a double.
   *
   * All the transitions of one commit share it, which is correct — they were
   * observed at one instant — and their relative order is carried by the
   * per-producer `seq` that `./transport.ts` stamps, not by the timestamp. A
   * non-finite value degrades to the current instant rather than producing an
   * event the service's schema would reject.
   */
  startTime: number;

  /**
   * The fiber's own state-bearing hooks that changed, in hook-chain order.
   *
   * Read-only and never retained: this module copies what it needs into
   * attribute values and keeps no reference to the array or its summaries.
   */
  hookChanges: readonly HookChange[];

  /**
   * The consumed context values that changed, in dependency-chain order.
   *
   * Absent when context could not be evaluated, which is not the same as an
   * empty array (nothing changed); neither produces an event, and
   * `./fiber-diff.ts`'s `evaluable` flags are what carry the distinction on the
   * render event.
   */
  contextChanges?: readonly ContextChange[];

  /**
   * The span id of the interaction — or, under async continuation, of the
   * settled request — that caused this work.
   *
   * Treated as **opaque**: it is emitted verbatim under `triggerSpanId` and
   * never recomputed, re-resolved or parsed here. `./react.ts` owns the
   * attribution, and a second opinion formed in this module could only
   * disagree with it.
   */
  triggerSpanId?: string;

  /**
   * Attributes the trace attribution itself contributed —
   * {@link EventContext.attributes}, written by `./continuation.js`'s
   * `applyLineageAttributes`.
   *
   * Merged into every emitted event's bag **beneath** this module's own keys,
   * so the lineage annotation travels with the transition (a dashed timeline
   * edge where the attribution was a best candidate) and cannot overwrite the
   * transition's own description.
   */
  lineageAttributes?: EventContext['attributes'];
}

/*
 * ---------------------------------------------------------------------------
 * Internal types
 * ---------------------------------------------------------------------------
 */

/**
 * A value summary as it is emitted: the catalog's `AttributeValueSummary` with
 * its `type` widened to `string`.
 *
 * The one deviation, written as a transformation of the catalog's own
 * interface so the rest of the shape cannot drift. `./fiber-diff.ts` reports
 * seven categories the closed `AttributeValueType` vocabulary does not have
 * (`date`, `map`, `react-element` and the rest) because the distinction
 * changes what a panel can say, and narrowing them to `unknown` here would
 * throw that away; `../aggregate/timeline.ts` already maps an unrecognised
 * category to `unknown` for display. `truncated` is normalised to a required
 * boolean, which is what the catalog declares and what `./react.ts` does for
 * the same summaries on a `render` event.
 */
type EmittedValueSummary = Omit<AttributeValueSummary, 'type'> & { type: string };

/**
 * What one changed entry looks like, whichever dimension it came from.
 *
 * {@link HookChange} and {@link ContextChange} are field-for-field identical,
 * and the union is written explicitly rather than as one of them so that a
 * future divergence between the two shows up here.
 */
type Change = HookChange | ContextChange;

/** One dimension's changes, paired with the source they are reported under. */
interface ChangeRun {
  /** Which dimension these changes came from. */
  readonly source: TransitionSource;
  /** The changes, in the order `./fiber-diff.ts` produced them. */
  readonly changes: readonly Change[];
}

/** The outcome of planning one call: what to emit, and what was left out. */
interface TransitionPlan {
  /** The drafts to hand to `./transport.ts`, in emission order. */
  readonly drafts: EventDraft[];
  /** How many reported transitions produced no event. */
  readonly dropped: number;
}

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * Module scope is one page document, which is the same scope `./ids.ts`
 * memoizes its producer id in and `./transport.ts` keeps its queue in. A
 * reload gives a fresh document and fresh counters, which is what the
 * per-capture bound assumes.
 *
 * Declaring a `false` and three zeroes is not a side effect: nothing
 * observable happens until a function is called.
 * ---------------------------------------------------------------------------
 */

/** Whether the state hook is armed; see the lifecycle note on the module. */
let enabled = false;

/** Transitions handed to `./transport.ts` since the last reset. */
let emittedCount = 0;

/** Reported transitions that produced no event since the last reset. */
let truncatedCount = 0;

/** Calls that failed part-way and were swallowed, since the last reset. */
let failureCount = 0;

/*
 * ---------------------------------------------------------------------------
 * Fixed values used by the planner
 * ---------------------------------------------------------------------------
 */

/** The `state` member of the vocabulary, annotated so a typo does not compile. */
const STATE_SOURCE: TransitionSource = 'state';

/** The `context` member of the vocabulary. */
const CONTEXT_SOURCE: TransitionSource = 'context';

/**
 * The empty run, shared.
 *
 * Stands in for an absent `contextChanges` (and for a `hookChanges` a caller
 * omitted at runtime despite the type), so the planner walks one uniform
 * structure instead of branching per dimension. Frozen and shared because it
 * is never written to.
 */
const NO_CHANGES: readonly Change[] = Object.freeze([]);

/**
 * The one property name never copied out of a lineage bag.
 *
 * Assigning to `__proto__` on a plain object runs `Object.prototype`'s setter
 * instead of adding a key, which would mutate the prototype of the attribute
 * bag rather than describing the transition. The key cannot appear in the
 * lineage vocabulary this product writes; skipping it costs one comparison and
 * removes the possibility entirely.
 */
const PROTO_KEY = '__proto__';

/*
 * ---------------------------------------------------------------------------
 * Input reading
 *
 * Every helper below answers one question about one field and returns
 * `undefined` rather than throwing or substituting a placeholder. The rule
 * throughout: an unusable field is omitted, and only an unusable `traceId`
 * costs the call — because a transition with no trace cannot be correlated
 * into the tree the panel renders, which makes it evidence nobody can read.
 * ---------------------------------------------------------------------------
 */

/** Whether a value is a string with at least one character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Whether a value is object-like enough to read a change out of. */
function isChange(value: unknown): value is Change {
  return typeof value === 'object' && value !== null;
}

/**
 * A hook or context position, when it is a usable one.
 *
 * `../aggregate/timeline.ts` accepts `hookIndex` only as a non-negative
 * integer, so anything else is omitted here rather than emitted and dropped
 * there.
 */
function readIndex(change: Change): number | undefined {
  const { index } = change;
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** A fiber id, when it is a usable one. */
function readFiberId(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Normalises one {@link ValueSummary} into the shape an attribute carries, or
 * reports that there was nothing to carry.
 *
 * Takes `unknown` rather than `ValueSummary` on purpose: the parameter is
 * typed by the caller's contract, and this function is the place that stops
 * believing it. A summary assembled by anything other than
 * `./fiber-diff.ts` — a future producer, a test, a partially initialised
 * object — yields `undefined` instead of an attribute the aggregate would have
 * to guess at.
 *
 * `type` and `preview` are passed through **byte for byte**: they are already
 * scrubbed and bounded, and re-truncating them would understate what the
 * product captured while re-scrubbing them would cost a walk per transition.
 * Only `truncated` is normalised, from "present when true" to the required
 * boolean the catalog's `AttributeValueSummary` declares.
 */
function toEmittedSummary(summary: unknown): EmittedValueSummary | undefined {
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }

  const candidate = summary as Partial<ValueSummary>;
  const { type, preview } = candidate;
  if (typeof type !== 'string' || typeof preview !== 'string') {
    return undefined;
  }

  return { type, preview, truncated: candidate.truncated === true };
}

/**
 * Clamps a display name to {@link MAX_NAME_COMPONENT_LENGTH} code points.
 *
 * Code points rather than UTF-16 units, so a surrogate pair is never split
 * into a lone half — the same counting `./fiber-diff.ts` and
 * `../aggregate/timeline.ts` apply to a preview.
 */
function clampComponentLabel(component: string): string {
  const codePoints = [...component];
  if (codePoints.length <= MAX_NAME_COMPONENT_LENGTH) {
    return component;
  }
  return codePoints.slice(0, MAX_NAME_COMPONENT_LENGTH).join('');
}

/**
 * The event's name: `‹Component› hook[3]`, or `‹Component› context[0]`.
 *
 * **Never a value.** A name is displayed verbatim in a timeline, a table and
 * the event log, and it is the one field of an event that no redaction pass
 * treats as captured data — so a state value in it would leave the machine
 * outside the privacy model entirely (AAP 0.5.2). The slot label and the
 * component name are all that appear.
 *
 * With no usable component name the slot alone is the name, which keeps the
 * schema's "at least one character" satisfied without inventing a component
 * that does not exist.
 */
function transitionName(
  component: string | undefined,
  source: TransitionSource,
  index: number,
): string {
  const slot = `${source === CONTEXT_SOURCE ? CONTEXT_SLOT : HOOK_SLOT}[${String(index)}]`;
  return component === undefined ? slot : `${clampComponentLabel(component)} ${slot}`;
}

/**
 * Copies a lineage bag onto an attribute bag without disturbing what is
 * already there.
 *
 * Called **after** this module's own keys are written, which settles two
 * things at once. Precedence: a lineage key that collides with a transition's
 * own key loses, as {@link EventContext.attributes} requires ("to be merged
 * into the event's own bag — never to replace it"). And survival:
 * `./transport.ts` sanitizes an attribute bag down to its first 32 keys in
 * insertion order, so writing the transition's description first means a
 * pathologically wide lineage bag can cost its own keys but never the
 * transition's.
 */
function mergeLineage(target: Record<string, unknown>, lineage: unknown): void {
  if (typeof lineage !== 'object' || lineage === null || Array.isArray(lineage)) {
    return;
  }

  const bag = lineage as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    if (key === PROTO_KEY || key in target) {
      continue;
    }
    target[key] = bag[key];
  }
}

/**
 * The fields of one call that are the same for every transition it produces,
 * resolved once.
 *
 * Validating per call rather than per change matters at the bounds this module
 * works under: one commit of the demo's catalog grid can produce dozens of
 * transitions, and the component name, the render span, the trigger and the
 * timestamp are one answer for all of them.
 */
interface CallContext {
  /** The component name, when the caller supplied a usable one. */
  readonly component?: string | undefined;
  /** The fiber id, when the caller supplied a usable one. */
  readonly fiberId?: number | undefined;
  /** The trace every transition of this call joins. */
  readonly traceId: string;
  /** The render span the transitions nest under, when it is well-formed. */
  readonly renderSpanId?: string | undefined;
  /** The opaque trigger reference, when the caller supplied one. */
  readonly triggerSpanId?: string | undefined;
  /** The instant every transition of this call is stamped with. */
  readonly startTime: number;
  /** The caller's lineage bag, unread until it is merged. */
  readonly lineageAttributes?: unknown;
}

/**
 * Validates the call-wide fields once.
 *
 * `traceId` is **not** checked here — {@link recordStateTransitions} rejects a
 * malformed one before this runs, because it is the one field whose absence
 * cannot be degraded around.
 *
 * A non-finite or non-positive `startTime` degrades to the current instant
 * rather than producing an event `../schema/event.ts` would reject at ingest:
 * the transition was observed, and "now" is within a commit's worth of the
 * truth. Whether the value is epoch milliseconds at all remains the caller's
 * contract, as it is for every producer in this folder; `./transport.ts`'s
 * `nowEpochMs` is the same conversion those producers use.
 */
function resolveContext(input: RecordTransitionsInput): CallContext {
  return {
    component: isNonEmptyString(input.component) ? input.component : undefined,
    fiberId: readFiberId(input.fiberId),
    traceId: input.traceId,
    renderSpanId: isSpanId(input.parentSpanId) ? input.parentSpanId : undefined,
    triggerSpanId: isNonEmptyString(input.triggerSpanId) ? input.triggerSpanId : undefined,
    startTime:
      Number.isFinite(input.startTime) && input.startTime > 0 ? input.startTime : nowEpochMs(),
    lineageAttributes: input.lineageAttributes,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Draft assembly
 * ---------------------------------------------------------------------------
 */

/**
 * Builds the attribute bag for one transition.
 *
 * The order of the writes is the contract described on {@link mergeLineage}:
 * the transition's own description first, the attribution's contribution
 * afterwards. Every absent field is **omitted** rather than written as `null`
 * — absence is how this product says "not observed", and
 * `../aggregate/timeline.ts` reads it that way.
 */
function buildAttributes(
  context: CallContext,
  source: TransitionSource,
  change: Change,
  index: number | undefined,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  if (context.component !== undefined) {
    attributes[KEY_COMPONENT] = context.component;
  }
  if (index !== undefined) {
    attributes[KEY_HOOK_INDEX] = index;
  }
  if (isNonEmptyString(change.label)) {
    attributes[KEY_HOOK_LABEL] = change.label;
  }

  const from = toEmittedSummary(change.from);
  if (from !== undefined) {
    attributes[KEY_PREVIOUS_VALUE] = from;
  }
  const to = toEmittedSummary(change.to);
  if (to !== undefined) {
    attributes[KEY_NEXT_VALUE] = to;
  }

  attributes[KEY_TRANSITION_SOURCE] = source;

  if (context.triggerSpanId !== undefined) {
    attributes[KEY_TRIGGER_SPAN_ID] = context.triggerSpanId;
  }
  if (context.renderSpanId !== undefined) {
    attributes[KEY_RENDER_SPAN_ID] = context.renderSpanId;
  }
  if (context.fiberId !== undefined) {
    attributes[KEY_FIBER_ID] = context.fiberId;
  }

  mergeLineage(attributes, context.lineageAttributes);

  return attributes;
}

/**
 * Builds one draft for one changed entry.
 *
 * Three fields deserve their reasons recorded, because each one looks like an
 * oversight to a reader who does not know the contract:
 *
 * - **`spanId` is fresh per transition.** Two transitions of one commit are
 *   two observations and must be addressable separately; a shared span id
 *   would make the trace tree ambiguous and the evidence references a
 *   generated panel cites unresolvable.
 * - **`parentSpanId` is the render span**, so the transition sits inside the
 *   render that observed it. Absent when the caller had no well-formed one, in
 *   which case `../correlation/correlator.ts` attaches the event to the trace
 *   root and flags it rather than dropping it.
 * - **`duration` is zero.** See the module documentation; it is not a
 *   placeholder.
 *
 * `ordinal` is the transition's position in the run being emitted, used for the
 * name only when the reported index is unusable — a name still has to be
 * distinct and non-empty for the event log to be readable.
 */
function buildDraft(
  context: CallContext,
  source: TransitionSource,
  change: Change,
  ordinal: number,
): EventDraft {
  const index = readIndex(change);

  const draft: EventDraft = {
    traceId: context.traceId,
    spanId: newSpanId(),
    kind: STATE_KIND,
    name: transitionName(context.component, source, index ?? ordinal),
    startTime: context.startTime,
    duration: TRANSITION_DURATION_MS,
    attributes: buildAttributes(context, source, change, index),
    status: TRANSITION_STATUS,
  };

  if (context.renderSpanId !== undefined) {
    draft.parentSpanId = context.renderSpanId;
  }

  return draft;
}

/**
 * Plans one call: the drafts to emit, and how many reported transitions did
 * not become one.
 *
 * The budget is the tighter of the two bounds — the per-call bound and what is
 * left of the per-capture bound — and the loop **keeps counting past it**
 * rather than breaking out. That is what makes `dropped` the true remainder
 * instead of "at least one", and the difference is visible to a developer: a
 * panel can say a list of forty was cut to thirty-two rather than merely that
 * it was cut.
 *
 * Order is `hookChanges` then `contextChanges`, each in the order
 * `./fiber-diff.ts` produced it — positional hook-chain order, which is
 * deterministic — so the per-producer `seq` that `./transport.ts` stamps
 * reflects hook order and the store returns the transitions of one commit the
 * way the fiber held them.
 */
function planTransitions(context: CallContext, runs: readonly ChangeRun[]): TransitionPlan {
  const remainingInCapture = MAX_TRANSITIONS_PER_CAPTURE - emittedCount;
  const budget = Math.max(0, Math.min(MAX_TRANSITIONS_PER_COMMIT, remainingInCapture));

  const drafts: EventDraft[] = [];
  let considered = 0;

  for (const run of runs) {
    for (const change of run.changes) {
      considered += 1;
      if (drafts.length >= budget || !isChange(change)) {
        continue;
      }
      drafts.push(buildDraft(context, run.source, change, drafts.length));
    }
  }

  return { drafts, dropped: considered - drafts.length };
}

/**
 * Records on the last emitted event that the list was cut.
 *
 * The last one, not the first, because a consumer reads the run in order and
 * the honest place for "and there were more" is the end. When the per-capture
 * bound left no room at all there is nothing to mark — the loss is still
 * counted in {@link getStateStats}, and a capture that has reached five
 * thousand transitions has already told the developer everything this flag
 * would.
 */
function markTruncated(drafts: readonly EventDraft[]): void {
  const last = drafts[drafts.length - 1];
  if (last === undefined) {
    return;
  }
  last.attributes[KEY_TRUNCATED] = true;
}

/** Returns all three counters to zero. */
function clearCounters(): void {
  emittedCount = 0;
  truncatedCount = 0;
  failureCount = 0;
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Arm state capture.
 *
 * Called by `./agent.ts` when the service's `agent.config` enables the state
 * hook, and never at import time: a page the developer is merely browsing gets
 * nothing from this module, and nothing is registered anywhere by this call —
 * there is no listener, no observer and no timer to register (see the
 * lifecycle note on the module).
 *
 * **Idempotent.** A second call while armed does nothing at all, which
 * matters: a re-configuration after a service-worker reconnect arrives
 * mid-capture, and resetting the counters then would silently lift the
 * per-capture bound and restate an already-reported truncation as zero.
 *
 * Cannot throw: it assigns two module variables and calls no host API.
 */
export function attachState(): void {
  if (enabled) {
    return;
  }
  clearCounters();
  enabled = true;
}

/**
 * Disarm state capture and forget what this capture recorded.
 *
 * Called by `./agent.ts` when the hooks are cleared — an `agent.config` with
 * every hook false, which AAP 0.5.1 requires to leave the agent "disabled, not
 * merely idled". Afterwards {@link recordStateTransitions} returns before it
 * allocates, so a commit that happens after the developer ended the capture
 * produces nothing and costs one comparison.
 *
 * Does **not** flush or reset `./transport.ts`: the queue holds events from
 * every hook, and teardown ordering across the agent's hooks belongs to
 * `./agent.ts`. Safe to call when already detached, and cannot throw.
 */
export function detachState(): void {
  enabled = false;
  clearCounters();
}

/**
 * Whether state capture is armed right now.
 *
 * `./agent.ts` reports it in the readiness and status frames the panel shows.
 * "Attached" is this folder's uniform vocabulary for an armed hook; for this
 * module it is exactly the flag, because there is nothing else to be attached
 * to.
 */
export function isStateAttached(): boolean {
  return enabled;
}

/**
 * Emit the transitions of one rendered fiber: one `state` event per changed
 * hook, then one per changed consumed context.
 *
 * Called from inside the fiber hook's commit callback — the developer's own
 * render path — so it **never throws**, for any input. A failure part-way
 * through is counted in {@link getStateStats} and swallowed: a capture missing
 * one component's transitions is a gap in evidence, while an exception raised
 * here is a React commit that did not finish.
 *
 * What it does, in order:
 *
 * 1. Returns immediately when detached, before allocating anything.
 * 2. Rejects a malformed `traceId` (counted as a failure), because an event
 *    that cannot join a trace cannot be read by any panel.
 * 3. Resolves the call-wide fields once, degrading each unusable one.
 * 4. Plans the run under both bounds and marks a cut list.
 * 5. Hands the whole run to `./transport.ts` in one `emitMany` call, which
 *    takes the capture gate once and consumes consecutive sequence numbers —
 *    the numbers `../correlation/correlator.ts` orders two transitions by when
 *    they share a millisecond, as every transition of one commit does.
 *
 * Outside a capture `./transport.ts` drops the run, which is why this function
 * neither checks nor knows the capture state: `./agent.ts` arms the hook for
 * the capture's duration, and the counter below therefore measures the
 * capture.
 */
export function recordStateTransitions(input: RecordTransitionsInput): void {
  if (!enabled) {
    return;
  }

  try {
    if (!isTraceId(input.traceId)) {
      failureCount += 1;
      return;
    }

    const runs: readonly ChangeRun[] = [
      { source: STATE_SOURCE, changes: input.hookChanges ?? NO_CHANGES },
      { source: CONTEXT_SOURCE, changes: input.contextChanges ?? NO_CHANGES },
    ];

    const plan = planTransitions(resolveContext(input), runs);

    if (plan.dropped > 0) {
      truncatedCount += plan.dropped;
      markTruncated(plan.drafts);
    }

    if (plan.drafts.length === 0) {
      return;
    }

    // Counted before the hand-off, because the count is what the per-capture
    // bound governs: it records what this module decided to emit, and a later
    // queue overflow inside `./transport.ts` is that module's loss to report
    // (it does, in `TransportStats.dropped`) rather than a reason to let this
    // bound drift upward.
    emittedCount += plan.drafts.length;
    emitMany(plan.drafts);
  } catch {
    // An exotic iterable, a getter that throws, a hostile `label` — none of
    // them may cost the commit this ran inside.
    failureCount += 1;
  }
}

/**
 * Start the counters over for a new capture.
 *
 * Called by `./agent.ts` when a capture begins, which is what scopes
 * {@link MAX_TRANSITIONS_PER_CAPTURE} to a capture rather than to the
 * document's whole lifetime. {@link detachState} resets them too, so an
 * arm/disarm cycle needs no separate call.
 *
 * Cannot throw.
 */
export function resetStateCounters(): void {
  clearCounters();
}

/**
 * A snapshot of what this module has done since the last reset.
 *
 * Cheap enough for a diagnostics view to call on every render: three
 * module-scope numbers and one small object, with nothing traversed.
 *
 * - `emitted` — transitions handed to `./transport.ts`. The quantity
 *   {@link MAX_TRANSITIONS_PER_CAPTURE} bounds.
 * - `truncated` — reported transitions that produced no event: the remainder
 *   past either bound, plus any entry too malformed to describe. A non-zero
 *   value means a panel's transition list is incomplete, which is exactly what
 *   the `truncated` attribute on the last emitted event says.
 * - `failures` — calls that were rejected or that failed part-way and were
 *   swallowed. Non-zero means a caller is breaking the input contract; it is
 *   never the page's fault.
 */
export function getStateStats(): { emitted: number; truncated: number; failures: number } {
  return { emitted: emittedCount, truncated: truncatedCount, failures: failureCount };
}
