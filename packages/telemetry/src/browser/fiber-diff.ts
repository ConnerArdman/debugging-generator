/**
 * Fiber diffing: **why** a React component re-rendered, and the
 * privacy-bounded value summaries a `render` or `state` event carries.
 *
 * `../browser/react.ts` walks the fibers a commit actually rendered (bippy's
 * `traverseRenderedFibers`) and asks this module two questions about each of
 * them: what changed, and what may be said about the values that changed. The
 * answers become `attributes.trigger` and `attributes.changedProps` on a
 * `render` event, and the `previousValue`/`nextValue` pair on a `state` event
 * (`../schema/attributes.ts`). `attributes.trigger` in turn drives the
 * `unchanged_render_count` and `render_trigger_unknown_count` metrics, which
 * are the evidence behind "why is this component rendering so many times?", so
 * a classification this module gets wrong is a conclusion a generated panel
 * states wrongly.
 *
 * ## Why this file exists at all
 *
 * bippy 0.7.3 hands over fibers and nothing else. Its export surface is
 * `instrument`, `installRDTHook`, `hasRDTHook`, `getRDTHook`,
 * `traverseRenderedFibers`, `traverseFiber`, `didFiberRender`,
 * `isCompositeFiber`, `isHostFiber`, `getDisplayName`,
 * `getFiberFromHostInstance`, `getFiberId` and the `Fiber`, `Props` and
 * `MemoizedState` types. There is no prop, hook-state or context traversal
 * helper, and no `secure` wrapper that would make a read of page data safe. So
 * every read here is written the way a library helper would have had to write
 * it: defensively, and with the assumption that whatever is on the other side
 * of a property access is the developer's code.
 *
 * ## Two invariants
 *
 * **1. Nothing here throws.** These functions run inside React's commit
 * callback, on the page's own stack. An exception escaping into a commit
 * breaks the developer's application, which would make the debugger the worst
 * bug in the session. Every property read that can reach a user getter, a
 * revoked `Proxy` or a hostile `Symbol.toStringTag` sits in its own
 * `try`/`catch`, a failure degrades to a narrower answer (a key skipped, a
 * dimension reported unevaluable, an `unknown` classification) and
 * {@link analyzeFiber} additionally wraps its whole body.
 *
 * **2. No user code is ever invoked.** Nothing here calls a function it found
 * on a value: no `toString()`, no `toJSON()`, no `JSON.stringify` of an
 * arbitrary prop, no `valueOf`, no reducer, no `dispatch`, no effect
 * `destroy`, no `Symbol.toPrimitive`. Property *reads* are unavoidable — a
 * getter is user code too, which is why every one of them is guarded — but a
 * call never is.
 *
 * ## The privacy boundary
 *
 * This is the **first** redaction boundary and the only one that ever sees raw
 * application values. The service redacts again at ingest and the model
 * provider a third time on the outbound path, but neither of them can put back
 * what a leak here already sent: a prop value that reaches the transport has
 * left the page. AAP 0.5.2 states the rule for this category — React props and
 * state are "captured as key names plus type/summary and change flags, values
 * truncated to 120 characters and passed through the same pattern rules" — and
 * {@link summarizeValue} is where it is enforced:
 *
 * - a category from the catalog vocabulary, never the value's own shape;
 * - a preview that carries content only for the categories where content is
 *   diagnostic (strings, numbers, booleans, bigints, array and object
 *   *structure*) and names the shape for every category where it is not (a
 *   function, a DOM node, a React element, a promise, an error);
 * - scrubbing through `../redaction/rules.ts` **after** the preview is
 *   composed, so a credential split across an object's keys is still caught;
 * - truncation to `MAX_PREVIEW_LENGTH`, after scrubbing and never before,
 *   because a value cut first can leave a credential half-matched and
 *   therefore unreplaced.
 *
 * Both bounds are imported rather than restated. `MAX_TRACKED_KEYS` and
 * `MAX_PREVIEW_LENGTH` live in `../schema/attributes.ts` and are consumed by
 * `../node/convert.ts` and the service's `../redaction/redactor.ts` as well, so
 * importing them is what keeps one privacy guarantee true on every tier.
 *
 * ## Imports: exactly two modules
 *
 * The page-injected agent bundles this file (`esbuild.agent.mjs`), and that
 * build fails if any input resolves to a Node builtin, a cross-package runtime
 * dependency or a schema library. `../schema/attributes.ts` and
 * `../redaction/rules.ts` are both dependency-free by contract — the latter has
 * no imports at all, asserted by its own test suite, precisely so that this
 * file can use it inside the page. Nothing else may be imported here at
 * runtime: not `../redaction/redactor.js` (it imports the schemas, which would
 * drag a schema library into the page), not `../schema/event.js` as a value,
 * not `@debuggen/shared`, not `@debuggen/protocol`, not `@opentelemetry/*`, and
 * no `node:` builtin.
 *
 * ## Capture now, analyse later
 *
 * The comparison is split in two so that almost none of it runs inside React's
 * commit phase, which is the developer's own click path (PERF-F07):
 *
 * 1. **{@link captureFiber}** runs synchronously in the commit callback and
 *    reads six pointers — the fiber's and its alternate's `memoizedProps`, the
 *    heads of both `memoizedState` hook lists, and the heads of both
 *    `dependencies.firstContext` chains. Nothing is compared, walked,
 *    summarised or scrubbed; a mount (no alternate) reads one field.
 * 2. **{@link analyzeCapturedFiber}** runs later, off the commit, over what was
 *    captured, and answers the same questions {@link analyzeFiber} answers.
 *
 * Pointer capture is what makes the deferred answer the *commit's* answer.
 * React double-buffers fibers: the alternate is reused as the next render's
 * work-in-progress, and a fiber deleted by a later commit has its
 * `memoizedProps`, `memoizedState`, `dependencies` and `alternate` nulled once
 * that commit's passive effects run. Reading those fields at analysis time
 * could therefore compare the wrong renders, or nothing at all. The objects the
 * captured pointers reach are not rewritten by React after the commit — a
 * props object is replaced rather than mutated, each render builds a fresh hook
 * list and a fresh context-dependency chain — so every identity comparison is
 * exactly the one the commit would have made. **One caveat is inherent and
 * stated rather than hidden:** a *preview* is composed from the value as it is
 * when the analysis runs, so an application that mutates a state object in
 * place between the commit and the analysis — a few milliseconds, one idle
 * period — is described by its mutated contents. Classification never depends
 * on a preview, only on identity, and is unaffected.
 *
 * The deferred analysis is also leaner than {@link analyzeFiber}, because the
 * render path reads less than the full diff carries: a `render` event carries
 * changed-prop *names* and a trigger, never a prop's value, so
 * {@link analyzeCapturedFiber} composes no prop summary at all; hook and
 * context summaries are composed only when the caller asks for transitions
 * (`./state.ts` is armed), and then through a caller-owned
 * {@link SummaryMemo} so a value shared by many consumers — one provider value
 * read by a hundred components — is summarised once per pass.
 *
 * ## Purity
 *
 * No side effects at import time, no DOM access at module scope, no timers, no
 * clock, no randomness, no shared mutable state. Every exported function is
 * synchronous. The mutable structures are per call or per caller: the visited
 * set and node budget a preview walk carries, and the pending sets and name
 * map a provider lookup carries, are allocated per call and die with it, and a
 * {@link SummaryMemo} belongs to the caller that created it, for the one
 * processing pass it was created for — so two concurrent callers cannot
 * observe each other and a pathological value cannot poison a later summary.
 *
 * @module packages/telemetry/src/browser/fiber-diff
 */

import { TRUNCATION_SUFFIX, scrub, scrubNamedValue, truncate } from '../redaction/rules.js';
import {
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  RENDER_TRIGGERS,
  type AttributeValueType,
} from '../schema/attributes.js';

/*
 * ---------------------------------------------------------------------------
 * Public vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * Why a fiber rendered.
 *
 * Written as a literal union rather than re-exported from the catalog so that
 * a reader of this file sees the five values, and kept identical to
 * `RENDER_TRIGGERS` by {@link asTrigger}, whose `includes` call fails to
 * compile if this union ever gains a member the catalog does not have.
 *
 * The distinction that matters: `unchanged` means all three dimensions were
 * evaluated and none had changed, while `unknown` means at least one could not
 * be evaluated. They are counted by two different metrics
 * (`unchanged_render_count`, `render_trigger_unknown_count`) because "we
 * checked and nothing changed" and "we could not check" support completely
 * different conclusions (AAP 0.2.3).
 */
export type RenderTrigger = 'props' | 'state' | 'context' | 'unchanged' | 'unknown';

/**
 * A value as it is allowed to travel: a category, a bounded and scrubbed
 * preview, and whether the preview was cut.
 *
 * Field-for-field the shape of `AttributeValueSummary` in
 * `../schema/attributes.ts`, with one deliberate difference: `truncated` is
 * optional here and **present only when it is `true`**, which under this
 * repository's `exactOptionalPropertyTypes` setting keeps an untruncated
 * summary down to the two fields that carry information. The catalog interface
 * requires the flag, so `../browser/react.ts` writes
 * `truncated: summary.truncated === true` when it lifts a summary onto an
 * event.
 */
export interface ValueSummary {
  /**
   * Category of the original value: a member of `ATTRIBUTE_VALUE_TYPES` where
   * that vocabulary covers the case, and one of this module's own tags
   * otherwise (see {@link LOCAL_VALUE_TAGS}).
   */
  type: string;
  /**
   * Scrubbed, bounded rendering of the value: at most `MAX_PREVIEW_LENGTH`
   * code points, and never the contents of a function, a DOM node, a React
   * element, a promise or an error.
   */
  preview: string;
  /** Present and `true` only when the preview was shortened to fit the bound. */
  truncated?: boolean;
}

/**
 * One prop whose value was not `Object.is`-equal to the previous render's.
 *
 * `from` and `to` are summaries, never values. The pair maps onto
 * `ChangedPropEntry` from `../schema/attributes.ts` (`from` → `previous`,
 * `to` → `next`) when `../browser/react.ts` builds the `changedProps`
 * attribute; the names differ because this module describes a *transition*
 * while the event schema describes two *slots*, either of which may be absent
 * on the wire.
 *
 * A prop that was added has a `from` summary of type `undefined`, and one that
 * was removed a `to` summary of type `undefined`: the transition is always
 * reported with both ends, and it is the event schema that drops a slot.
 */
export interface PropChange {
  /** The prop's name. */
  key: string;
  /** Summary of the value at the previous render. */
  from: ValueSummary;
  /** Summary of the value at this render. */
  to: ValueSummary;
}

/**
 * One of the fiber's own state-bearing hooks whose value changed.
 *
 * `index` is the hook's position in the fiber's hook list, which is the only
 * stable identifier a hook has — hooks are anonymous, and their order is the
 * contract React itself relies on. `label` names the kind of hook where it
 * could be inferred (`state`, `reducer`) and is absent otherwise; it is
 * diagnostic only and never affects classification.
 *
 * Only state-bearing hooks appear here. See {@link diffHookState} for why a
 * `useMemo` cache, a `useRef` box and an effect record are deliberately not
 * treated as state.
 */
export interface HookChange {
  /** Zero-based position in the fiber's hook list. */
  index: number;
  /** Inferred hook kind, when one could be inferred. */
  label?: string;
  /** Summary of the value at the previous render. */
  from: ValueSummary;
  /** Summary of the value at this render. */
  to: ValueSummary;
}

/**
 * One context the fiber consumes whose value changed.
 *
 * `index` is the position in the fiber's dependency chain. `label` carries the
 * context's `displayName` when it has one, and otherwise the category of its
 * default value, which is often enough to recognise which context is meant;
 * it never carries the context value beyond the `from`/`to` summaries.
 *
 * `provider` and `contextName` are what turn a bare `context` trigger into
 * "context change: ‹provider›" (AAP 0.8.2). `provider` is the name a developer
 * navigates by — the component that renders the context's provider, which is
 * the component holding the value that changed and the row a render table
 * lists that component under — and `contextName` is the context's own name
 * for when no such component can be read. Both are names from the
 * developer's code, never the context value, and both are resolved only for a
 * dependency that changed (see {@link diffContexts}).
 */
export interface ContextChange {
  /** Zero-based position in the fiber's context-dependency chain. */
  index: number;
  /** Context display name, or the category of its default value. */
  label?: string;
  /**
   * Display name of the composite component that renders the **nearest**
   * provider of this context above the consuming fiber — the provider whose
   * value this fiber read.
   *
   * Named the way `./react.ts` names that component's own `render` events
   * (`displayName`, then `name`, from `elementType` and then `type`), and cut
   * at the same length, so the name matches that component's own row. Absent
   * when no provider of the context was found within the walk's bound, or when
   * the first component above the provider has no readable name.
   */
  provider?: string;
  /** The context's own `displayName`, when the developer set one. */
  contextName?: string;
  /** Summary of the consumed value at the previous render. */
  from: ValueSummary;
  /** Summary of the consumed value at this render. */
  to: ValueSummary;
}

/**
 * The names a changed consumed context is attributed by — the providing
 * component and the context's own `displayName` — without its values.
 */
export type ContextAttribution = Pick<ContextChange, 'provider' | 'contextName'>;

/**
 * Which of the three dimensions was compared **completely**.
 *
 * A flag is `true` only when equality across the whole dimension was
 * established, because that is the claim {@link classifyRenderTrigger} turns
 * into `unchanged`. Two things make a dimension unevaluable:
 *
 * - **The information is not on the fiber.** There is no alternate (a mount),
 *   the props of one side are not an object, the hook chains cannot be paired
 *   positionally, or React dropped the alternate's context-dependency chain.
 * - **The scan overflowed `MAX_TRACKED_KEYS`.** The entries past the bound
 *   were never read, so their equality is unknown and the dimension cannot
 *   claim that nothing changed. Whatever the scanned part *did* observe is
 *   still reported — a positive finding outranks an unknown — but an empty
 *   truncated scan means "we could not check", never "nothing changed".
 *
 * Both cases are what keep an unobservable render out of
 * `unchanged_render_count` and in `render_trigger_unknown_count` instead (AAP
 * 0.2.3). {@link FiberDiff.truncated} is what tells the two apart.
 */
export interface DimensionEvaluability {
  /** Whether props were compared against the alternate's props in full. */
  props: boolean;
  /** Whether the fiber's own hook state was compared in full. */
  state: boolean;
  /** Whether consumed context values were compared in full. */
  context: boolean;
}

/**
 * The complete answer for one rendered fiber.
 *
 * `changedProps` is the plain key list `../browser/react.ts` puts into the
 * `changedProps` attribute declared by `RENDER_ATTRIBUTE_KEYS`; the detailed
 * transitions sit alongside it in `propChanges`, so a consumer that wants only
 * the names does not have to walk the summaries.
 */
export interface FiberDiff {
  /** Why the fiber rendered. */
  trigger: RenderTrigger;
  /** Names of the props that changed, in the order they were reported. */
  changedProps: string[];
  /** The prop transitions behind {@link changedProps}. */
  propChanges: PropChange[];
  /** Transitions of the fiber's own state-bearing hooks. */
  hookChanges: HookChange[];
  /** Transitions of the context values the fiber consumes. */
  contextChanges: ContextChange[];
  /**
   * The names of every consumed context that changed, in scan order — the
   * attribution {@link contextChanges} also carries, without the values.
   */
  changedContexts: ContextAttribution[];
  /** Which dimensions were compared in full. */
  evaluable: DimensionEvaluability;
  /**
   * Whether any dimension had more entries than `MAX_TRACKED_KEYS` allows.
   *
   * A truncated dimension also reports `evaluable: false` for itself, so this
   * flag is what distinguishes "capped at the bound" from "the fiber did not
   * carry the information" rather than being the thing that protects the
   * classification.
   */
  truncated: boolean;
}

/** What one dimension reports back to {@link analyzeFiber}. */
interface DimensionResult<TChange> {
  /** The changes found, bounded by `MAX_TRACKED_KEYS`. */
  changed: TChange[];
  /**
   * Whether the dimension was compared in full, which is the only basis on
   * which it may be read as "nothing changed". False for a scan that
   * overflowed the bound, whatever the scanned part showed.
   */
  evaluable: boolean;
  /** Whether entries past the bound were dropped. */
  truncated: boolean;
}

/**
 * The pointers one rendered fiber's analysis needs, read at commit time by
 * {@link captureFiber}.
 *
 * Six references and a flag, and nothing derived from them: the record exists
 * so the comparison can run after React's commit has returned, against exactly
 * the objects the commit held (see "Capture now, analyse later" above). The
 * fields are typed `unknown` because they are page objects whose shape varies
 * by React version; {@link analyzeCapturedFiber} narrows every one of them by
 * guarded reads, exactly as the live comparison does.
 *
 * Holding a record holds the application objects it points at, so a caller
 * must bound how many it retains and for how long — `./react.ts` holds them
 * for one bounded idle queue and releases them as each commit is processed.
 */
export interface CapturedFiber {
  /**
   * Whether the fiber had an alternate — a previous render — when it was
   * captured. `false` is a mount, and every other field is then `undefined`:
   * with nothing to compare against there is nothing worth reading.
   */
  readonly hasAlternate: boolean;
  /** `fiber.memoizedProps`: this render's props object. */
  readonly nextProps: unknown;
  /** `fiber.alternate.memoizedProps`: the previous render's props object. */
  readonly previousProps: unknown;
  /** `fiber.memoizedState`: the head of this render's hook list. */
  readonly nextHooks: unknown;
  /** `fiber.alternate.memoizedState`: the head of the previous render's hook list. */
  readonly previousHooks: unknown;
  /** `fiber.dependencies.firstContext`: this render's consumed-context chain. */
  readonly nextContexts: unknown;
  /** `fiber.alternate.dependencies.firstContext`: the previous render's chain. */
  readonly previousContexts: unknown;
}

/**
 * A per-pass memo of unnamed value summaries, keyed by value identity.
 *
 * Created by the caller with {@link createSummaryMemo} for one processing pass
 * and dropped with it. Within one synchronous pass a value cannot change, so a
 * value summarised once is summarised identically every other time it is met
 * — and the demo's cart provider publishes one value object that close to a
 * hundred consumers report as a changed context in the same commit. The memo
 * turns those hundred previews, and the hundred scrubs behind them, into one.
 *
 * Only *unnamed* summaries are memoised (hook state and context values, the
 * slots {@link summarizeValue} is called for without a key): a named summary
 * is scrubbed through the name rule as well, so the same value under two names
 * may legitimately preview differently. The memoised summaries are frozen,
 * because one object is handed to every change that shares the value.
 */
export interface SummaryMemo {
  /** The summaries composed so far in this pass. */
  readonly summaries: Map<unknown, ValueSummary>;
}

/**
 * What {@link analyzeCapturedFiber} may compute beyond the classification.
 */
export interface CapturedFiberAnalysisOptions {
  /**
   * Summarise the hook-state and consumed-context values that changed, so they
   * can become `state` events. Defaults to `false`: without it the changes are
   * *counted* — the trigger needs to know that state changed — but no value is
   * summarised and {@link RenderAnalysis.hookChanges} and
   * {@link RenderAnalysis.contextChanges} are empty.
   */
  readonly transitions?: boolean;
  /**
   * A memo shared by every analysis of one processing pass; see
   * {@link SummaryMemo}. Optional: without one every summary is composed
   * afresh.
   */
  readonly memo?: SummaryMemo;
}

/**
 * The deferred, render-path answer for one captured fiber: the classification
 * and changed-prop names every `render` event carries, and the value
 * transitions only when they were asked for.
 *
 * The same shape as {@link FiberDiff} minus `propChanges`: the render path
 * reads prop *names* only, so no prop summary is composed. `hookChanges` and
 * `contextChanges` carry summarised transitions when
 * {@link CapturedFiberAnalysisOptions.transitions} was set, and are empty
 * otherwise — which then means "not summarised", never "nothing changed";
 * {@link trigger} is what says whether anything did.
 */
export interface RenderAnalysis {
  /** Why the fiber rendered. */
  trigger: RenderTrigger;
  /** Names of the props that changed, sorted, bounded by `MAX_TRACKED_KEYS`. */
  changedProps: string[];
  /** Transitions of the fiber's own state-bearing hooks, when requested. */
  hookChanges: HookChange[];
  /** Transitions of the context values the fiber consumes, when requested. */
  contextChanges: ContextChange[];
  /**
   * The names of every consumed context that changed, in scan order, whether
   * or not its transition was requested: its own `displayName` and, when the
   * analysis was handed the fiber, the component rendering its nearest
   * provider. Empty when no consumed context value changed.
   */
  changedContexts: ContextAttribution[];
  /** Which dimensions were compared in full. */
  evaluable: DimensionEvaluability;
  /** Whether any dimension had more entries than `MAX_TRACKED_KEYS` allows. */
  truncated: boolean;
}

/**
 * One dimension's scan: how many changes were positively observed, their
 * descriptions when they were asked for, and whether the comparison was
 * complete.
 *
 * The count is separate from the list because the render path classifies
 * without describing: a trigger needs to know *that* a hook changed, and only
 * a `state` event needs to know what it changed from and to.
 */
interface DimensionScan<TChange> {
  /** Changes positively observed, whether or not they were described. */
  count: number;
  /** Their descriptions, in scan order; empty when none were requested. */
  changed: TChange[];
  /** Whether the dimension was compared in full; see {@link DimensionResult}. */
  evaluable: boolean;
  /** Whether entries past the bound were dropped. */
  truncated: boolean;
}

/** A consumed-context scan, with the names of every context it found changed. */
interface ContextScan extends DimensionScan<ContextChange> {
  /** One attribution per changed context, in scan order, described or not. */
  attributions: ContextAttribution[];
}

/**
 * Composes the summary of one unnamed value. Either {@link summarizeValue}
 * itself or its memoised form; see {@link summarizerFor}.
 */
type Summarizer = (value: unknown) => ValueSummary;

/*
 * ---------------------------------------------------------------------------
 * Value-category vocabulary
 *
 * `ValueSummary.type` is declared as `string` because this module emits two
 * kinds of tag: the ones the catalog already defines, and a handful of finer
 * categories it does not. The rule, so that the two files can converge later
 * without a guess:
 *
 *   **Prefer the catalog vocabulary wherever it covers the case, and fall back
 *   to a local tag only where it does not.**
 *
 * The union below is therefore written as `AttributeValueType | …` rather
 * than as twelve restated literals plus seven local ones. That is the
 * coupling: every `return` and `case` site in this module is checked against
 * the catalog's own type, so if `ATTRIBUTE_VALUE_TYPES` renamed or dropped a
 * member this file would stop compiling instead of quietly emitting a tag no
 * consumer recognises. Note in particular that the catalog spells a DOM node
 * `dom` — that is the tag emitted here, and `../schema/attributes.ts` names
 * this module as its producer.
 *
 * The seven local tags each exist because the distinction changes what a
 * *panel* can say: a prop that turned from one `date` into another reads very
 * differently from an `object` that did, and `react-element` is what tells a
 * reviewer that an inline JSX `children` prop is the thing changing identity
 * on every render. Every one of them previews as its shape and never its
 * contents, so widening the vocabulary widens description, never exposure.
 * ---------------------------------------------------------------------------
 */

/** Every category {@link summarizeValue} can report. */
type ValueTypeTag =
  AttributeValueType | 'date' | 'regexp' | 'map' | 'set' | 'promise' | 'error' | 'react-element';

/*
 * ---------------------------------------------------------------------------
 * Bounds and fixed previews
 *
 * `MAX_TRACKED_KEYS` and `MAX_PREVIEW_LENGTH` are imported, never restated:
 * they are documented privacy guarantees owned by `../schema/attributes.ts`
 * and shared with the Node tier and the service's redactor. The bounds below
 * are this module's own, and each one exists to keep a single commit callback
 * cheap on a value the page chose.
 * ---------------------------------------------------------------------------
 */

/**
 * How deep a preview walk descends. Depth 0 is the value itself, depth 1 its
 * elements, depth 2 the structure of those elements; anything deeper is
 * elided. Two levels are what distinguish `Array(3) [{ id: number }, …]` from
 * `Array(3)` without turning a preview into a serialiser.
 */
const MAX_PREVIEW_DEPTH = 2;

/** Array elements summarised before the rest is elided. */
const MAX_ARRAY_ELEMENTS = 3;

/**
 * Object keys named before the rest is elided. Key names are diagnostic (AAP
 * 0.5.2 allows them explicitly); the values behind them are not, so an object
 * previews as its keys and their categories.
 */
const MAX_OBJECT_KEYS = 8;

/**
 * Values a single {@link summarizeValue} call may visit.
 *
 * The depth, element and key bounds already cap a well-shaped value; this caps
 * a hostile one — a wide array of wide objects — so no single prop can stall a
 * commit no matter how it is nested.
 */
const MAX_VISITED_NODES = 64;

/** Bound on any identifier embedded in a preview: a function or component name, an element id, a class name. */
const MAX_NAME_LENGTH = 40;

/** Class names named in a DOM node's descriptor. */
const MAX_CLASS_NAMES = 2;

/** Prefix of the well-known symbols React uses to mark its element types. */
const REACT_SYMBOL_PREFIX = 'react.';

/**
 * Name React gives the reducer behind `useState`, which is how a `useState`
 * hook is told from a `useReducer` one.
 *
 * Diagnostic only: it feeds {@link HookChange.label} and never the
 * classification, because a minified React build renames the function and the
 * heuristic then reads a `useState` hook as a reducer. A wrong label costs a
 * word in a panel; a wrong trigger would cost a wrong conclusion.
 */
const BASIC_STATE_REDUCER_NAME = 'basicStateReducer';

/** Preview of a value whose category could not be read at all. */
const UNREADABLE_PREVIEW = '[unreadable]';

/** Preview of an object already visited in this walk (a cycle, or a repeat). */
const CIRCULAR_PREVIEW = '[circular]';

/** Preview of a property whose getter threw, used inside a composed preview. */
const UNREADABLE_SLOT = 'unreadable';

/** Fallback name for a React element whose component could not be named. */
const ANONYMOUS_COMPONENT = 'Anonymous';

/** Fallback descriptor for a DOM node with no readable `nodeName`. */
const UNKNOWN_NODE_NAME = 'node';

/*
 * ---------------------------------------------------------------------------
 * Guarded reads
 *
 * Everything below this line touches values the developer's application
 * created. A property read can run a getter, a `Proxy` trap or nothing at all
 * (a revoked `Proxy` throws for every operation, including `Object.hasOwn` and
 * `for…in`), so each read is wrapped and each failure is *reported* rather
 * than swallowed: the callers need to tell "this value is `undefined`" from
 * "this value could not be read", because the first is a comparison and the
 * second is an unevaluable dimension.
 * ---------------------------------------------------------------------------
 */

/** Outcome of one guarded property read. */
interface PropertyRead {
  /** Whether the read completed. `false` means a getter or trap threw. */
  ok: boolean;
  /** The value read, or `undefined` when the read failed. */
  value: unknown;
}

/** The single failed-read result, frozen so it cannot become shared state. */
const FAILED_READ: PropertyRead = Object.freeze({ ok: false, value: undefined });

/**
 * Whether a value can carry properties, and can therefore be read from and
 * tracked in the visited set.
 *
 * Functions are included: a callback prop's `name` is read for its preview,
 * and a component type carries `displayName`. `null` is excluded, which is
 * what makes every call site below safe without a second check.
 */
function isPropertyBag(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * Whether a value is a non-null object — the shape props, hook nodes and
 * context dependencies must have before they can be compared.
 *
 * Narrower than {@link isPropertyBag}: a function is not a props object, and
 * treating one as a hook node would pair a component against a hook list.
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads one property, reporting failure instead of propagating it.
 *
 * Accepts `unknown` so a caller never has to narrow before asking: a value
 * that cannot carry properties reports a failed read, which every caller
 * already handles.
 */
function readProperty(target: unknown, key: string): PropertyRead {
  if (!isPropertyBag(target)) {
    return FAILED_READ;
  }
  try {
    return { ok: true, value: target[key] };
  } catch {
    // A getter threw, or `target` is a revoked Proxy. Either way the value is
    // not observable, and asking again will not change that.
    return FAILED_READ;
  }
}

/** Reads a property and keeps it only if it is a non-empty string. */
function readStringProperty(target: unknown, key: string): string | undefined {
  const read = readProperty(target, key);
  if (typeof read.value === 'string' && read.value.length > 0) {
    return read.value;
  }
  return undefined;
}

/** Whether `target` has `key` as an own property, without running a getter. */
function hasOwnProperty(target: unknown, key: string): boolean {
  if (!isPropertyBag(target)) {
    return false;
  }
  try {
    return Object.hasOwn(target, key);
  } catch {
    // A revoked Proxy throws for `getOwnPropertyDescriptor` as well.
    return false;
  }
}

/**
 * The result of a bounded own-enumerable-key scan.
 *
 * `failed` is separate from an empty `keys` list on purpose: a value whose
 * keys cannot be enumerated at all must not be reported as "no keys changed",
 * which would let a revoked `Proxy` masquerade as an unchanged render.
 */
interface KeyScan {
  /** Own enumerable keys, in first-seen order, at most `limit` of them. */
  keys: string[];
  /** Whether more keys existed than `limit` allowed. */
  overflow: boolean;
  /** Whether enumeration itself threw. */
  failed: boolean;
}

/**
 * Collects at most `limit` own enumerable keys, stopping as soon as the bound
 * is reached.
 *
 * `for…in` with an own-property check and an early break is deliberate:
 * `Object.keys` would materialise every key of a ten-thousand-key props object
 * before the bound could discard them, and this runs inside a commit. The
 * order is the object's own property order, which is stable for a given object
 * and therefore deterministic; the caller sorts the far smaller selected set
 * (see {@link diffProps}) rather than sorting the whole key space.
 */
function collectOwnKeys(target: object, limit: number): KeyScan {
  const keys: string[] = [];
  let overflow = false;
  try {
    for (const key in target) {
      if (!Object.hasOwn(target, key)) {
        continue;
      }
      if (keys.length >= limit) {
        overflow = true;
        break;
      }
      keys.push(key);
    }
  } catch {
    // Enumeration threw: an `ownKeys` trap, or a revoked Proxy. Whatever was
    // collected before the throw is returned, and `failed` tells the caller
    // that the list cannot be treated as complete.
    return { keys, overflow, failed: true };
  }
  return { keys, overflow, failed: false };
}

/**
 * The internal class of an object (`Date`, `RegExp`, `Map`, `Promise`, …),
 * read from `Object.prototype.toString` and never from `constructor.name`,
 * which a page can set to anything.
 *
 * The read is guarded because `Object.prototype.toString` consults
 * `Symbol.toStringTag`, which may be a getter, and because a revoked `Proxy`
 * throws. An empty string means "could not tell", which sends the caller to
 * its structural fallbacks.
 */
function internalClassOf(value: object): string {
  try {
    const tag = Object.prototype.toString.call(value);
    if (tag.startsWith(TO_STRING_PREFIX) && tag.endsWith(TO_STRING_SUFFIX)) {
      return tag.slice(TO_STRING_PREFIX.length, tag.length - TO_STRING_SUFFIX.length);
    }
    return '';
  } catch {
    return '';
  }
}

/*
 * ---------------------------------------------------------------------------
 * Categorising a value
 * ---------------------------------------------------------------------------
 */

/** Opening of the string `Object.prototype.toString` returns. */
const TO_STRING_PREFIX = '[object ';

/** Closing of the string `Object.prototype.toString` returns. */
const TO_STRING_SUFFIX = ']';

/**
 * Whether a value is a DOM node.
 *
 * Duck-typed on `nodeType` and `nodeName` rather than tested with
 * `value instanceof Node`, for two reasons: `Node` does not exist in the
 * runtime-neutral contexts this module is also type-checked for, and a node
 * from an iframe belongs to a different realm's `Node`, so `instanceof` would
 * miss it and the node would then be previewed as a plain object — which is
 * exactly the case where the preview must *not* walk its keys.
 */
function isDomNode(value: object): boolean {
  if (typeof readProperty(value, 'nodeType').value !== 'number') {
    return false;
  }
  return typeof readProperty(value, 'nodeName').value === 'string';
}

/**
 * The suffix of a `Symbol.for('react.…')` marker, or `undefined` for any other
 * symbol. Version-agnostic by construction: React 19 marks elements with
 * `react.transitional.element` where earlier majors used `react.element`, and
 * both answer this test.
 */
function reactSymbolSuffix(marker: symbol): string | undefined {
  try {
    const description = marker.description;
    if (typeof description === 'string' && description.startsWith(REACT_SYMBOL_PREFIX)) {
      return description.slice(REACT_SYMBOL_PREFIX.length);
    }
  } catch {
    // A `description` getter cannot normally throw, but this value came from
    // the page and the cost of the guard is nothing.
  }
  return undefined;
}

/** Whether a value is a React element, identified by its `$$typeof` marker. */
function isReactElement(value: object): boolean {
  const marker = readProperty(value, '$$typeof').value;
  return typeof marker === 'symbol' && reactSymbolSuffix(marker) !== undefined;
}

/**
 * Whether a value is promise-like. Reached only after the internal class says
 * it is not a native `Promise`, so this catches a library thenable — whose
 * `then` is *read* and never called.
 */
function isThenable(value: object): boolean {
  return typeof readProperty(value, 'then').value === 'function';
}

/**
 * `Array.isArray`, guarded.
 *
 * The one intrinsic used here that can throw on its own: applied to a revoked
 * `Proxy` it raises rather than answering, because the answer lives in the
 * target the proxy no longer has. Every other read in this module is already
 * guarded, so without this wrapper a revoked `Proxy` in a prop slot would be
 * the single input able to abort a categorisation.
 */
function isArrayValue(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/** Category of a non-null object, in the order the checks must be applied. */
function objectTagOf(value: object): ValueTypeTag {
  // DOM nodes and React elements first: both would otherwise fall through to
  // the object branch, whose preview names keys. A node's keys reach its
  // subtree and an element's reach its props.
  if (isDomNode(value)) {
    return 'dom';
  }
  if (isReactElement(value)) {
    return 'react-element';
  }
  if (isArrayValue(value)) {
    return 'array';
  }
  switch (internalClassOf(value)) {
    case 'Date':
      return 'date';
    case 'RegExp':
      return 'regexp';
    case 'Map':
    case 'WeakMap':
      return 'map';
    case 'Set':
    case 'WeakSet':
      return 'set';
    case 'Promise':
      return 'promise';
    case 'Error':
      return 'error';
    default:
      break;
  }
  return isThenable(value) ? 'promise' : 'object';
}

/**
 * Category of any value. Total: every input yields a tag, and an input whose
 * category cannot be determined yields `unknown` rather than a guess.
 */
function typeTagOf(value: unknown): ValueTypeTag {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
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
    case 'object':
      return value === null ? 'null' : objectTagOf(value);
    default:
      return 'unknown';
  }
}

/*
 * ---------------------------------------------------------------------------
 * Composing a preview
 *
 * Every function in this section answers one question: what may be *said*
 * about this value? Two groups, and the line between them is the privacy
 * boundary:
 *
 *   - **Shape only.** A function, a DOM node, a React element, a promise, an
 *     error, a date, a regular expression. Their contents are either code, the
 *     developer's page, or a message that routinely carries user data, so the
 *     preview names the shape — a function's name, a node's tag, a component's
 *     name, an error's class — and stops there. No `toString`, no
 *     `textContent`, no `innerHTML`, no message, no stack, no props.
 *   - **Bounded content.** Strings, numbers, booleans, bigints, and the
 *     *structure* of arrays and objects. These are what let a developer
 *     recognise which value changed, and they are the ones that then pass
 *     through the deny-list scrub and the length bound.
 * ---------------------------------------------------------------------------
 */

/** The per-call state of one preview walk. Allocated per call, never shared. */
interface PreviewBudget {
  /** Objects already described in this walk, so a repeat can be reported. */
  readonly visited: WeakSet<object>;
  /** Values the walk may still visit. */
  nodes: number;
}

/** Renders a scalar whose category is already known. */
function scalarPreview(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return UNREADABLE_PREVIEW;
}

/** Bounds any identifier a preview embeds. */
function boundedName(name: string): string {
  return truncate(name, MAX_NAME_LENGTH);
}

/**
 * `[function]`, or `[function handleSubmit]` when the name is readable.
 *
 * The name is the whole point — it is what tells a developer that the callback
 * prop changing identity on every render is theirs — and `fn.toString()`,
 * which would return the body, is never called.
 */
function functionPreview(value: object): string {
  const name = readStringProperty(value, 'name');
  return name === undefined ? '[function]' : '[function ' + boundedName(name) + ']';
}

/**
 * A tag-only DOM descriptor: `<div#main.row.active>`.
 *
 * Tag name, `id` and at most {@link MAX_CLASS_NAMES} class names, each bounded.
 * Never `textContent`, `innerHTML`, `outerHTML`, `value` or any other
 * attribute: those hold the developer's page and, on a form control, whatever
 * the user typed into it.
 */
function domPreview(node: object): string {
  const nodeName = readStringProperty(node, 'nodeName');
  let descriptor = boundedName((nodeName ?? UNKNOWN_NODE_NAME).toLowerCase());
  const id = readStringProperty(node, 'id');
  if (id !== undefined) {
    descriptor += '#' + boundedName(id);
  }
  const className = readStringProperty(node, 'className');
  if (className !== undefined) {
    // `className` is a string on HTML elements and an `SVGAnimatedString` on
    // SVG ones, which `readStringProperty` has already filtered out. Bound the
    // source before splitting: a utility-class stylesheet can put hundreds of
    // classes on one element.
    const names = truncate(className, MAX_PREVIEW_LENGTH)
      .split(/\s+/)
      .filter((name) => name.length > 0)
      .slice(0, MAX_CLASS_NAMES);
    for (const name of names) {
      descriptor += '.' + boundedName(name);
    }
  }
  return '<' + descriptor + '>';
}

/** A component's own name, from `displayName` then `name`. */
function componentName(type: unknown): string | undefined {
  const displayName = readStringProperty(type, 'displayName');
  if (displayName !== undefined) {
    return displayName;
  }
  return readStringProperty(type, 'name');
}

/**
 * The element's component name: a host tag (`div`), a component name
 * (`UserAvatar`), a React built-in (`fragment`), or {@link ANONYMOUS_COMPONENT}.
 *
 * One level of `memo`/`forwardRef` unwrapping is applied, because an anonymous
 * wrapper around a named component is the common case and reporting it as
 * anonymous would hide which component the element is.
 */
function reactElementName(element: object): string {
  const type = readProperty(element, 'type').value;
  if (typeof type === 'string') {
    return boundedName(type);
  }
  if (typeof type === 'symbol') {
    const suffix = reactSymbolSuffix(type);
    return suffix === undefined ? ANONYMOUS_COMPONENT : boundedName(suffix);
  }
  if (isPropertyBag(type)) {
    const direct = componentName(type);
    if (direct !== undefined) {
      return boundedName(direct);
    }
    // `memo` keeps the wrapped component under `type`, `forwardRef` under
    // `render`. Reading them is a property read, never a render.
    const wrapped = componentName(readProperty(type, 'type').value);
    if (wrapped !== undefined) {
      return boundedName(wrapped);
    }
    const rendered = componentName(readProperty(type, 'render').value);
    if (rendered !== undefined) {
      return boundedName(rendered);
    }
  }
  return ANONYMOUS_COMPONENT;
}

/** `[error: TypeError]` — the class, never the message and never the stack. */
function errorPreview(value: object): string {
  const name = readStringProperty(value, 'name');
  return '[error: ' + boundedName(name ?? 'Error') + ']';
}

/** `Map(3)` / `Set(0)` — the entry count, never an entry. */
function sizedPreview(label: string, value: object): string {
  const size = readProperty(value, 'size').value;
  if (typeof size === 'number' && Number.isFinite(size)) {
    return label + '(' + String(size) + ')';
  }
  // A `WeakMap`/`WeakSet` has no `size`, by design: it cannot be enumerated.
  return '[' + label.toLowerCase() + ']';
}

/** An array's length, read defensively; a hostile `length` reports as empty. */
function readArrayLength(value: object): number {
  const length = readProperty(value, 'length').value;
  if (typeof length === 'number' && Number.isFinite(length) && length > 0) {
    return Math.floor(length);
  }
  return 0;
}

/**
 * `Array(12) ["item-1", { id: number }, …]` — the length, then at most
 * {@link MAX_ARRAY_ELEMENTS} summarised elements.
 *
 * The length alone answers most render questions ("the list grew"), and the
 * first few elements answer the rest ("the list is the same items in a new
 * array").
 */
function arrayPreview(value: object, depth: number, budget: PreviewBudget): string {
  const length = readArrayLength(value);
  const head = 'Array(' + String(length) + ')';
  if (depth >= MAX_PREVIEW_DEPTH || length === 0) {
    return head;
  }
  const shown = Math.min(length, MAX_ARRAY_ELEMENTS);
  const parts: string[] = [];
  for (let index = 0; index < shown; index += 1) {
    if (budget.nodes <= 0) {
      parts.push(TRUNCATION_SUFFIX);
      return head + ' [' + parts.join(', ') + ']';
    }
    const element = readProperty(value, String(index));
    parts.push(element.ok ? nestedPreview(element.value, depth + 1, budget) : UNREADABLE_SLOT);
  }
  if (length > shown) {
    parts.push(TRUNCATION_SUFFIX);
  }
  return head + ' [' + parts.join(', ') + ']';
}

/**
 * `{ id: number, tags: array, onSelect: function }` — key names and the
 * *category* of each value, never a value.
 *
 * This is the asymmetry AAP 0.5.2 asks for: key names are diagnostic and safe,
 * while the values behind them are the developer's data. Knowing that
 * `options.filter` turned from `undefined` into an `object` is what explains a
 * re-render; knowing what the filter contained is not needed for that and
 * cannot be un-sent.
 */
function objectPreview(value: object, depth: number, budget: PreviewBudget): string {
  if (depth >= MAX_PREVIEW_DEPTH) {
    return '{' + TRUNCATION_SUFFIX + '}';
  }
  const scan = collectOwnKeys(value, MAX_OBJECT_KEYS);
  if (scan.failed && scan.keys.length === 0) {
    return UNREADABLE_PREVIEW;
  }
  const parts: string[] = [];
  for (const key of scan.keys) {
    if (budget.nodes <= 0) {
      parts.push(TRUNCATION_SUFFIX);
      break;
    }
    budget.nodes -= 1;
    const entry = readProperty(value, key);
    // The key is bounded like any other identifier a preview embeds. A prop's
    // own name comes from source and is always short, but the keys *inside* a
    // value come from the application's data — a record keyed by an email
    // address, say — so the same bound applies to them as to a class name.
    parts.push(boundedName(key) + ': ' + (entry.ok ? typeTagOf(entry.value) : UNREADABLE_SLOT));
  }
  if (scan.overflow || scan.failed) {
    parts.push(TRUNCATION_SUFFIX);
  }
  return parts.length === 0 ? '{}' : '{ ' + parts.join(', ') + ' }';
}

/** Renders a value whose category is already known, at the given depth. */
function composePreview(
  value: unknown,
  tag: ValueTypeTag,
  depth: number,
  budget: PreviewBudget,
): string {
  switch (tag) {
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'string':
      // Reached at depth 0 only: `nestedPreview` quotes and pre-scrubs a
      // nested string itself. The raw value is returned here because
      // `summarizeValue` scrubs and bounds it immediately afterwards.
      return typeof value === 'string' ? value : UNREADABLE_PREVIEW;
    case 'number':
    case 'boolean':
    case 'bigint':
      return scalarPreview(value);
    case 'symbol':
      // Never the description: it is authored text, but it is authored by the
      // page and there is no diagnostic need for it.
      return '[symbol]';
    default:
      break;
  }
  if (!isPropertyBag(value)) {
    return UNREADABLE_PREVIEW;
  }
  switch (tag) {
    case 'function':
      return functionPreview(value);
    case 'dom':
      return domPreview(value);
    case 'react-element':
      return '<' + reactElementName(value) + '/>';
    case 'promise':
      return '[promise]';
    case 'error':
      return errorPreview(value);
    case 'date':
      // A date is a *value*, and a date-of-birth or an appointment time is the
      // developer's user's data. Identity is what a render question needs, and
      // the change itself already carries that.
      return '[date]';
    case 'regexp':
      return '[regexp]';
    case 'map':
      return sizedPreview('Map', value);
    case 'set':
      return sizedPreview('Set', value);
    case 'array':
      return arrayPreview(value, depth, budget);
    default:
      return objectPreview(value, depth, budget);
  }
}

/**
 * Renders a value nested inside another, charging the node budget and
 * reporting a repeat visit as {@link CIRCULAR_PREVIEW}.
 *
 * A nested string is scrubbed and bounded here rather than left for the final
 * pass, in the contract's order (scrub, then truncate), which keeps the
 * composed preview linear in the bounds rather than in the page's data — and
 * the whole composition is scrubbed again afterwards, so a credential split
 * across two nested pieces is still caught.
 */
function nestedPreview(value: unknown, depth: number, budget: PreviewBudget): string {
  if (budget.nodes <= 0) {
    return TRUNCATION_SUFFIX;
  }
  budget.nodes -= 1;
  if (isPropertyBag(value)) {
    if (budget.visited.has(value)) {
      return CIRCULAR_PREVIEW;
    }
    budget.visited.add(value);
  }
  if (typeof value === 'string') {
    return '"' + truncate(scrub(value), MAX_PREVIEW_LENGTH) + '"';
  }
  return composePreview(value, typeTagOf(value), depth, budget);
}

/**
 * Summarises one application value into the only representation allowed to
 * leave the page: a category, a scrubbed and bounded preview, and whether the
 * preview was cut.
 *
 * The order of the last three steps is the contract, not an implementation
 * detail:
 *
 * 1. **Compose** the preview from the value's category and structure.
 * 2. **Scrub** the composed string — `scrubNamedValue(key, …)` when the value
 *    was captured under a name, so a prop called `apiKey` is replaced whole
 *    however short its value is, and `scrub(…)` otherwise. Scrubbing after
 *    composition is what catches a credential split across an object's keys,
 *    and it runs on the exact string that will be emitted.
 * 3. **Truncate** to `MAX_PREVIEW_LENGTH` code points. Never before scrubbing:
 *    a cut value can leave a credential half-matched and therefore unreplaced.
 *
 * Never throws, for any input: a value that defeats every read is reported as
 * `unknown` / {@link UNREADABLE_PREVIEW} rather than raised.
 *
 * @param value - The application value, exactly as the page created it.
 * @param key - Name the value was captured under, when there is one. Supplying
 * it is what enables name-driven redaction; omit it for an anonymous slot such
 * as a hook's state.
 */
export function summarizeValue(value: unknown, key?: string): ValueSummary {
  let tag: ValueTypeTag = 'unknown';
  let composed = UNREADABLE_PREVIEW;
  try {
    tag = typeTagOf(value);
    const budget: PreviewBudget = { visited: new WeakSet<object>(), nodes: MAX_VISITED_NODES };
    if (isPropertyBag(value)) {
      budget.visited.add(value);
    }
    composed = composePreview(value, tag, 0, budget);
  } catch {
    // A hostile value defeated even the guarded reads. The category may still
    // be known, and `composed` stays at the unreadable marker.
  }
  try {
    const scrubbed = key === undefined ? scrub(composed) : scrubNamedValue(key, composed);
    const bounded = truncate(scrubbed, MAX_PREVIEW_LENGTH);
    return bounded.length === scrubbed.length
      ? { type: tag, preview: bounded }
      : { type: tag, preview: bounded, truncated: true };
  } catch {
    // The redaction primitives are documented as total, so this is
    // unreachable; it is here because a summary must exist either way.
    return { type: tag, preview: UNREADABLE_PREVIEW };
  }
}

/**
 * The most summaries one {@link SummaryMemo} holds.
 *
 * A pass handles a bounded queue of commits, so the memo is bounded by what
 * that queue can report anyway; this is the explicit ceiling on top, so a pass
 * over a pathological capture — thousands of distinct values changing at once —
 * cannot turn the memo into a second copy of the page's state. Past it, a
 * summary is still composed, only no longer remembered.
 */
const MAX_MEMOIZED_SUMMARIES = 4096;

/**
 * A fresh, empty {@link SummaryMemo} for one processing pass.
 *
 * @example
 * ```ts
 * const memo = createSummaryMemo();
 * for (const captured of commit) {
 *   analyzeCapturedFiber(captured, { transitions: true, memo });
 * }
 * // The memo — and every value it references — is dropped with the pass.
 * ```
 */
export function createSummaryMemo(): SummaryMemo {
  return { summaries: new Map<unknown, ValueSummary>() };
}

/**
 * The summarizer one analysis uses for unnamed values: the memo's, when there
 * is a memo, and {@link summarizeValue} itself otherwise.
 *
 * `Map` compares keys by SameValueZero, which is exactly the identity a
 * summary depends on: two references to one object share a summary, two
 * equal-looking objects do not, and `NaN` meets `NaN`. A memo whose `Map`
 * the page has broken (its prototype methods are the page's) degrades to
 * composing every summary afresh rather than to a failed analysis.
 */
function summarizerFor(memo: SummaryMemo | undefined): Summarizer {
  if (memo === undefined) {
    return (value) => summarizeValue(value);
  }
  return (value) => {
    try {
      const known = memo.summaries.get(value);
      if (known !== undefined) {
        return known;
      }
      const summary = Object.freeze(summarizeValue(value));
      if (memo.summaries.size < MAX_MEMOIZED_SUMMARIES) {
        memo.summaries.set(value, summary);
      }
      return summary;
    } catch {
      return summarizeValue(value);
    }
  };
}

/*
 * ---------------------------------------------------------------------------
 * The three dimensions
 *
 * Each of the three exported comparisons answers two things: what changed, and
 * whether the comparison could be made **in full**. The second is as important
 * as the first — a dimension that could not be evaluated must never be
 * reported as "nothing changed", because that is what would put an
 * unobservable render into `unchanged_render_count` and let a panel claim a
 * stable-input re-render that was never observed.
 *
 * "In full" is the part that is easy to lose. A scan stops at
 * `MAX_TRACKED_KEYS`, and the entries beyond the bound are never read: a
 * 33-prop component whose only changed prop is the 33rd looks exactly like a
 * component whose props are all equal, so a truncated scan that found nothing
 * has established nothing. {@link scannedDimension} is where that rule lives,
 * and it is applied by every dimension whose answer came from a bounded scan.
 * ---------------------------------------------------------------------------
 */

/**
 * A dimension that could not be compared. A fresh object per call, so a
 * caller that appends to its list cannot reach another caller's.
 */
function unevaluableScan<TChange>(): DimensionScan<TChange> {
  return { count: 0, changed: [], evaluable: false, truncated: false };
}

/**
 * A dimension whose equality is proven without a scan — the two sides are the
 * same object, or neither side has anything to compare. A fresh object per
 * call.
 */
function stableScan<TChange>(): DimensionScan<TChange> {
  return { count: 0, changed: [], evaluable: true, truncated: false };
}

/**
 * The result of a bounded scan, with the one rule that makes the bound honest:
 * **equality may only be claimed over a complete scan.**
 *
 * A scan that overflowed `MAX_TRACKED_KEYS` left entries unread, so it cannot
 * report the dimension as evaluated however equal the entries it did read
 * were. What it *positively observed* is preserved and returned — those
 * changes are real, and {@link classifyRenderTrigger} ranks a positive finding
 * above an unknown — but an empty truncated scan resolves to `unknown` rather
 * than to `unchanged`, which is what AAP 0.2.3 requires of
 * `unchanged_render_count`.
 *
 * @param count - How many changes the scan positively observed.
 * @param changed - Their descriptions, when descriptions were requested.
 * @param evaluable - Whether the comparison was possible at all, before the
 * bound is taken into account (a context dependency with no counterpart, for
 * instance, has already made the dimension unevaluable).
 * @param truncated - Whether either side's scan overflowed the bound.
 */
function scannedDimension<TChange>(
  count: number,
  changed: TChange[],
  evaluable: boolean,
  truncated: boolean,
): DimensionScan<TChange> {
  return { count, changed, evaluable: evaluable && !truncated, truncated };
}

/**
 * A scan as the exported per-dimension functions report it: the descriptions,
 * the evaluability and the truncation. Those functions always request
 * descriptions, so the list is the whole of what the scan observed.
 */
function toDimensionResult<TChange>(scan: DimensionScan<TChange>): DimensionResult<TChange> {
  return { changed: scan.changed, evaluable: scan.evaluable, truncated: scan.truncated };
}

/**
 * Compares the fiber's props against its alternate's, shallowly.
 *
 * The comparison is `Object.is` per key over the union of both sides' own
 * enumerable keys — which is what "props were shallow-equal" means, and the
 * reason a new object or a new inline callback with identical contents counts
 * as a change: React's own bailout works on identity too, so a prop that
 * changed identity is a prop that caused the render.
 *
 * Bounds and failure modes:
 *
 * - No `alternate` means a mount, and a mount has nothing to compare against:
 *   the dimension is unevaluable, never "unchanged".
 * - The key union is bounded by `MAX_TRACKED_KEYS`. Keys past the bound are
 *   dropped, `truncated` is set and the dimension reports itself unevaluable
 *   (see {@link scannedDimension}): the changes listed are the ones that are
 *   *known*, and the props that were never read cannot be claimed as equal.
 *   The identical-object fast path above is unaffected — it proves equality
 *   without reading a key, so it stays evaluable.
 * - A key whose getter throws is skipped and the dimension stays evaluable:
 *   one hostile prop must not blind the comparison of the other thirty-one.
 * - A props object that cannot be enumerated at all (a revoked `Proxy`) makes
 *   the dimension unevaluable, because an empty key list is indistinguishable
 *   from an unchanged one.
 *
 * `children` is deliberately part of the comparison. An inline-JSX `children`
 * prop changes identity on every parent render and is one of the most common
 * genuine causes of a re-render, so excluding it would hide the answer; it is
 * summarised as a React element (or an array of them), which names the
 * component and never walks into its props.
 *
 * @param fiber - A React fiber, typed `unknown` because fibers are page
 * objects whose shape varies by React version; every read is guarded.
 */
export function diffProps(fiber: unknown): DimensionResult<PropChange> {
  const scan = scanProps(captureFiber(fiber), true);
  return { changed: scan.changes, evaluable: scan.evaluable, truncated: scan.truncated };
}

/** What {@link scanProps} reports: the changed names, and their transitions when asked. */
interface PropScan {
  /** Names of the props that changed, sorted — always present. */
  keys: string[];
  /** The transitions behind {@link keys}; empty unless summaries were requested. */
  changes: PropChange[];
  /** Whether the props were compared in full. */
  evaluable: boolean;
  /** Whether keys past the bound were dropped. */
  truncated: boolean;
}

/**
 * The props comparison {@link diffProps} documents, over captured pointers.
 *
 * `summarize` decides only whether each changed prop's two values are
 * summarised: the names, the evaluability and the truncation are computed the
 * same way either way, which is what keeps the render path's lean answer and
 * {@link analyzeFiber}'s full one classifying every fiber identically.
 */
function scanProps(captured: CapturedFiber, summarize: boolean): PropScan {
  if (!captured.hasAlternate) {
    return { keys: [], changes: [], evaluable: false, truncated: false };
  }
  const nextProps = captured.nextProps;
  const previousProps = captured.previousProps;
  if (!isObjectLike(nextProps) || !isObjectLike(previousProps)) {
    return { keys: [], changes: [], evaluable: false, truncated: false };
  }
  if (nextProps === previousProps) {
    // React reuses the props object when it bails out of a subtree: the same
    // object cannot differ from itself, so no key needs reading.
    return { keys: [], changes: [], evaluable: true, truncated: false };
  }
  const nextScan = collectOwnKeys(nextProps, MAX_TRACKED_KEYS);
  const previousScan = collectOwnKeys(previousProps, MAX_TRACKED_KEYS);
  if (nextScan.failed || previousScan.failed) {
    return { keys: [], changes: [], evaluable: false, truncated: false };
  }

  // First-seen order across both sides, capped, then sorted. Sorting the
  // capped selection rather than the whole key space is what keeps a
  // ten-thousand-key props object cheap while the reported order stays
  // deterministic.
  const seen = new Set<string>();
  const keys: string[] = [];
  let truncated = nextScan.overflow || previousScan.overflow;
  for (const source of [nextScan.keys, previousScan.keys]) {
    for (const key of source) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (keys.length >= MAX_TRACKED_KEYS) {
        truncated = true;
        break;
      }
      keys.push(key);
    }
  }
  keys.sort();

  const changedKeys: string[] = [];
  const changes: PropChange[] = [];
  for (const key of keys) {
    const before = readProperty(previousProps, key);
    const after = readProperty(nextProps, key);
    if (!before.ok || !after.ok) {
      continue;
    }
    if (Object.is(before.value, after.value)) {
      continue;
    }
    changedKeys.push(key);
    if (summarize) {
      changes.push({
        key,
        from: summarizeValue(before.value, key),
        to: summarizeValue(after.value, key),
      });
    }
  }
  // The rule {@link scannedDimension} states for every dimension: equality is
  // claimed only over a complete scan.
  return { keys: changedKeys, changes, evaluable: !truncated, truncated };
}

/** The hook kinds this module can tell apart. */
type HookKind = 'state' | 'reducer' | 'ref' | 'memo' | 'effect' | 'unclassified';

/**
 * The kinds treated as the fiber's own state.
 *
 * `ref`, `memo` and `effect` are deliberately absent, and that exclusion is
 * load-bearing rather than an optimisation:
 *
 * - A `useRef` box keeps its identity for the fiber's whole life and mutating
 *   `.current` does not schedule a render, so a ref can never be the reason a
 *   render happened.
 * - A `useMemo`/`useCallback` cache is *replaced* whenever its dependencies
 *   change, which happens **during** the render it would otherwise be blamed
 *   for. Counting it as state would report "state changed" for every render of
 *   a component whose memo dependencies include an unstable inline object —
 *   precisely the pattern that makes a render `unchanged` — and
 *   `unchanged_render_count` would then read zero exactly when it matters most.
 * - An effect record is a queue entry, not a value the component rendered from.
 *
 * `unclassified` is included: a hook whose kind could not be inferred but
 * whose `memoizedState` changed identity is far more likely to be a state
 * carrier the heuristics below do not recognise (`useSyncExternalStore`, a
 * future hook, a synthetic fiber) than one of the three excluded kinds, all of
 * which have a recognisable shape.
 */
const STATE_BEARING_HOOK_KINDS: readonly HookKind[] = ['state', 'reducer', 'unclassified'];

/**
 * Whether a value looks like a node of React's hook list.
 *
 * Every hook React creates carries `memoizedState`, `baseState`, `baseQueue`,
 * `queue` and `next` as own properties, so `memoizedState` or `queue` being
 * *own* is enough to recognise one — and is what distinguishes a hook list
 * from a class component's `memoizedState`, which is the component's state
 * object and has the application's own keys.
 */
function isHookNode(value: unknown): boolean {
  return hasOwnProperty(value, 'memoizedState') || hasOwnProperty(value, 'queue');
}

/** The result of walking one singly-linked chain of fiber-owned nodes. */
interface ChainScan {
  /** The nodes walked, in chain order, at most `MAX_TRACKED_KEYS` of them. */
  nodes: Record<string, unknown>[];
  /** Whether the chain was longer than the bound allows. */
  overflow: boolean;
  /** Whether the walk hit a cycle or an unreadable link. */
  failed: boolean;
}

/**
 * Walks a `next`-linked chain, bounded by `MAX_TRACKED_KEYS` and guarded
 * against a cycle.
 *
 * The visited set belongs to *one* chain: React reuses the current fiber's
 * hook objects when it bails out, so the two chains being compared routinely
 * share nodes, and a shared set would read that legitimate sharing as a cycle.
 */
function collectChain(head: unknown, linkKey: string): ChainScan {
  const visited = new WeakSet<object>();
  const nodes: Record<string, unknown>[] = [];
  let overflow = false;
  let cursor: unknown = head;
  while (isObjectLike(cursor)) {
    if (visited.has(cursor)) {
      return { nodes, overflow, failed: true };
    }
    visited.add(cursor);
    if (nodes.length >= MAX_TRACKED_KEYS) {
      overflow = true;
      break;
    }
    nodes.push(cursor);
    const link = readProperty(cursor, linkKey);
    if (!link.ok) {
      return { nodes, overflow, failed: true };
    }
    cursor = link.value;
  }
  return { nodes, overflow, failed: false };
}

/**
 * Infers a hook's kind from the shape React gives each one, without calling
 * anything:
 *
 * - `useState`/`useReducer` own a `queue` carrying a `dispatch` function; the
 *   two are told apart by the name of `queue.lastRenderedReducer`, which is
 *   React's `basicStateReducer` for `useState`.
 * - `useEffect` and friends hold an effect record (`create`, `destroy`,
 *   `deps`, `tag`) — whose `destroy` is never read through, let alone called.
 * - `useRef` holds `{ current }`.
 * - `useMemo`/`useCallback` hold `[value, deps]`.
 */
function classifyHook(node: Record<string, unknown>): HookKind {
  const queue = readProperty(node, 'queue').value;
  if (isObjectLike(queue) && typeof readProperty(queue, 'dispatch').value === 'function') {
    const reducer = readProperty(queue, 'lastRenderedReducer').value;
    const reducerName = readStringProperty(reducer, 'name');
    return reducerName === undefined || reducerName === BASIC_STATE_REDUCER_NAME
      ? 'state'
      : 'reducer';
  }
  const memoized = readProperty(node, 'memoizedState').value;
  if (isObjectLike(memoized)) {
    if (
      hasOwnProperty(memoized, 'create') ||
      hasOwnProperty(memoized, 'destroy') ||
      hasOwnProperty(memoized, 'tag')
    ) {
      return 'effect';
    }
    if (hasOwnProperty(memoized, 'current')) {
      return 'ref';
    }
    if (isArrayValue(memoized) && readArrayLength(memoized) === 2) {
      return 'memo';
    }
  }
  return 'unclassified';
}

/** The label a change of this kind carries, or none when nothing was inferred. */
function hookLabel(kind: HookKind): string | undefined {
  return kind === 'unclassified' ? undefined : kind;
}

/**
 * Compares the fiber's own hook state against its alternate's.
 *
 * Hooks are anonymous and their order is the contract React itself relies on,
 * so pairing is positional and the two chains must line up. Where they cannot
 * — one side absent, different lengths, a cyclic `next`, an unreadable link —
 * the dimension is reported unevaluable rather than guessed at, because a
 * mispaired chain would compare one hook's value against another's and invent
 * a state change out of nothing.
 *
 * Only state-bearing hooks are compared; see {@link STATE_BEARING_HOOK_KINDS}
 * for why a memo cache and a ref box are not state.
 *
 * Both chains are bounded by `MAX_TRACKED_KEYS`. A chain longer than the bound
 * leaves its tail unread, so the dimension reports itself unevaluable
 * ({@link scannedDimension}) while still listing the hooks whose values were
 * observed to change: a component with thirty-three hooks whose only changed
 * one is the thirty-third must classify as `unknown`, never as `unchanged`.
 *
 * A class component reaches this function too, and its `memoizedState` is the
 * component's state object rather than a hook list. That is reported
 * unevaluable — "we could not check the fiber's *hook* state" is the honest
 * answer, and a class render therefore classifies as `unknown` rather than
 * being compared against a shape this code would have to guess at.
 *
 * @param fiber - A React fiber; every read is guarded.
 */
export function diffHookState(fiber: unknown): DimensionResult<HookChange> {
  return toDimensionResult(scanHookState(captureFiber(fiber), summarizerFor(undefined)));
}

/**
 * The hook-state comparison {@link diffHookState} documents, over captured
 * pointers.
 *
 * `summarize` is the summarizer for the changed values, or `undefined` to
 * count the changes without describing them — the render path's case when no
 * `state` event will be emitted. Every other decision is identical either way.
 */
function scanHookState(
  captured: CapturedFiber,
  summarize: Summarizer | undefined,
): DimensionScan<HookChange> {
  if (!captured.hasAlternate) {
    return unevaluableScan();
  }
  const nextHead = captured.nextHooks;
  const previousHead = captured.previousHooks;
  const nextPresent = isObjectLike(nextHead);
  const previousPresent = isObjectLike(previousHead);
  if (!nextPresent && !previousPresent) {
    // A component with no hooks: React leaves `memoizedState` null on both
    // sides. Nothing to compare, and nothing changed — which is a genuine
    // "unchanged" contribution, not an unknown.
    return stableScan();
  }
  if (nextPresent !== previousPresent) {
    // Hooks appeared or disappeared between renders, which React does not do
    // for a well-formed component. Positional pairing is meaningless here.
    return unevaluableScan();
  }
  if (nextHead === previousHead) {
    // The bailout path keeps the current fiber's hook list, so the chains are
    // the same objects and no hook's value can have changed.
    return stableScan();
  }
  if (!isHookNode(nextHead) || !isHookNode(previousHead)) {
    return unevaluableScan();
  }
  const nextScan = collectChain(nextHead, 'next');
  const previousScan = collectChain(previousHead, 'next');
  if (nextScan.failed || previousScan.failed) {
    return unevaluableScan();
  }
  if (nextScan.nodes.length !== previousScan.nodes.length) {
    return unevaluableScan();
  }

  let count = 0;
  const changed: HookChange[] = [];
  for (const [index, nextNode] of nextScan.nodes.entries()) {
    const previousNode = previousScan.nodes[index];
    if (previousNode === undefined) {
      continue;
    }
    const kind = classifyHook(nextNode);
    if (!STATE_BEARING_HOOK_KINDS.includes(kind)) {
      continue;
    }
    const after = readProperty(nextNode, 'memoizedState');
    const before = readProperty(previousNode, 'memoizedState');
    if (!after.ok || !before.ok) {
      continue;
    }
    if (Object.is(before.value, after.value)) {
      continue;
    }
    count += 1;
    if (summarize !== undefined) {
      const label = hookLabel(kind);
      const from = summarize(before.value);
      const to = summarize(after.value);
      changed.push(label === undefined ? { index, from, to } : { index, label, from, to });
    }
  }
  return scannedDimension(count, changed, true, nextScan.overflow || previousScan.overflow);
}

/**
 * The previous-render dependency that corresponds to `dependency`: the one
 * carrying the same `context` object, or — when the contexts cannot be matched
 * by identity — the one at the same position.
 *
 * Identity first because a conditional `useContext` can reorder the chain
 * between renders, and comparing two different contexts' values would
 * manufacture a change.
 */
function findContextCounterpart(
  previous: readonly Record<string, unknown>[],
  dependency: Record<string, unknown>,
  index: number,
): Record<string, unknown> | undefined {
  const context = readProperty(dependency, 'context').value;
  if (isObjectLike(context)) {
    for (const candidate of previous) {
      if (readProperty(candidate, 'context').value === context) {
        return candidate;
      }
    }
  }
  return previous[index];
}

/**
 * A context's display name, or the category of the value it currently holds.
 *
 * Never the value itself: that travels only as the `from`/`to` summaries,
 * which have been through the scrub and the length bound.
 */
function contextLabel(dependency: Record<string, unknown>): string | undefined {
  const context = readProperty(dependency, 'context').value;
  if (!isObjectLike(context)) {
    return undefined;
  }
  const displayName = readStringProperty(context, 'displayName');
  if (displayName !== undefined) {
    return boundedName(displayName);
  }
  const current = readProperty(context, '_currentValue');
  return current.ok ? typeTagOf(current.value) : undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Context attribution
 *
 * A `context` trigger says *that* a consumed context changed; the developer's
 * next question is *which*, and the answer they can act on is the component
 * that provides it — the one holding the value that keeps changing. React does
 * not record that on the consumer: a dependency carries the context object and
 * the value read, nothing about where the value came from. So the provider is
 * found the way React itself resolves a context read, by walking `return` from
 * the consumer to the nearest provider fiber of that context, and the name is
 * taken from the first component above that provider.
 *
 * The walk reads four fiber fields — `return`, `tag`, `type`, `elementType` —
 * none of which holds application data: a provider fiber's *value* lives in its
 * `memoizedProps`, which this section never touches. Every read is guarded,
 * the walk is bounded, and everything it allocates dies with the call.
 * ---------------------------------------------------------------------------
 */

/**
 * React's work tag for a context-provider fiber: 10.
 *
 * The same number in every React release since 16.6, React 18 and 19
 * included, which is every entry of bippy 0.7.3's work-tag map from
 * `16.6.0-beta.0` on. Stated here rather than read from bippy, for two
 * reasons: this file imports exactly two dependency-free modules (see the
 * module documentation), and bippy's per-fiber lookup
 * (`getReactWorkTagsForFiber`) walks the whole `return` chain without a bound
 * and writes a module-level cache on every call, which this file's purity
 * contract rules out on the commit path. `./fiber-diff.test.ts` builds its
 * provider fibers from bippy's own map, so a divergence fails there.
 *
 * The tag is what keeps a **consumer** from being taken for a provider. The
 * two carry the same context under shapes that overlap across majors: a
 * production React 18 `<Ctx.Consumer>` fiber has the context itself as `type`
 * — React 19's provider shape — and a React 19 one has `{ _context: Ctx }` —
 * React 18's provider shape. Only the tag (9 for a consumer) tells them apart.
 */
const CONTEXT_PROVIDER_WORK_TAG = 10;

/**
 * Work tags of the fibers a component name belongs to: function (0), class
 * (1), `forwardRef` (11), `memo` (14) and simple `memo` (15).
 *
 * Exactly the set bippy's `isCompositeFiber` accepts, which is the set
 * `./react.ts` emits `render` events for, so the component a provider is
 * attributed to is always one that has a row of its own. Stable across the
 * same React releases as {@link CONTEXT_PROVIDER_WORK_TAG}, and restated for
 * the same reasons.
 */
const COMPOSITE_WORK_TAGS: readonly number[] = [0, 1, 11, 14, 15];

/**
 * The most `return` links one provider lookup follows: 512.
 *
 * Far deeper than the path from any component to its root in a real page —
 * host elements, boundaries and a framework router's layers included — so a
 * provider that exists is found, while the cost stays fixed on a pathological
 * tree. It is also what ends a cyclic `return` chain, which React never builds
 * and a hand-built fiber can: the commit path carries no visited set.
 */
const MAX_PROVIDER_WALK_STEPS = 512;

/**
 * The longest provider or context name reported: 200 UTF-16 code units, cut as
 * a prefix and never marked.
 *
 * Deliberately not {@link boundedName}'s 40 with a suffix: `provider` is a join
 * key as much as a label — "context change: ‹provider›" leads a reader to that
 * provider's own row — so it must equal the `component` attribute `./react.ts`
 * writes for the same component, which that module cuts the same way at the
 * same length (`MAX_COMPONENT_NAME_LENGTH`). Restated rather than imported,
 * because this file imports nothing from `./react.ts`. `./react.ts` cuts every
 * entry to its own bound again when it writes the attribute, so this one only
 * has to be no shorter than that; `./react.test.tsx` asserts the equality
 * against a real render, so a bound set lower fails there.
 */
const MAX_ATTRIBUTION_NAME_LENGTH = 200;

/** Bounds a name reported in a {@link ContextChange} attribution field. */
function attributionName(name: string): string {
  return name.length > MAX_ATTRIBUTION_NAME_LENGTH
    ? name.slice(0, MAX_ATTRIBUTION_NAME_LENGTH)
    : name;
}

/**
 * How many `memo`/`forwardRef` wrappers a name lookup looks through: 8.
 *
 * Real code nests two at most (`memo(forwardRef(…))`); the bound exists so a
 * wrapper whose `type` points back at itself ends the lookup instead of
 * spinning.
 */
const MAX_WRAPPER_DEPTH = 8;

/**
 * The function a chain of `memo` and `forwardRef` wrappers ends in: each
 * wrapper's `type` (`memo`), or its `render` where it has no `type`
 * (`forwardRef`), until a function is reached.
 */
function innermostComponent(type: unknown): unknown {
  let cursor = type;
  for (let depth = 0; depth <= MAX_WRAPPER_DEPTH; depth += 1) {
    if (typeof cursor === 'function') {
      return cursor;
    }
    if (!isObjectLike(cursor)) {
      return undefined;
    }
    const wrapped = readProperty(cursor, 'type').value;
    cursor =
      wrapped === undefined || wrapped === null ? readProperty(cursor, 'render').value : wrapped;
  }
  return undefined;
}

/**
 * The name of a component type: its own `displayName` or `name`, else that of
 * the function its `memo`/`forwardRef` wrappers end in.
 *
 * The resolution bippy's `getDisplayName` performs, which is what
 * `./react.ts` names a rendered fiber with, so a provider named here reads the
 * same as that provider's own `render` event — bounded here, where bippy's
 * unwrapping is not. Property reads only: a wrapper is never called.
 */
function typeComponentName(type: unknown): string | undefined {
  if (!isPropertyBag(type)) {
    return undefined;
  }
  return componentName(type) ?? componentName(innermostComponent(type));
}

/**
 * A composite fiber's component name, from `elementType` first and `type`
 * second — the order `./react.ts` uses, because a `memo` or `forwardRef`
 * wrapper carries the `displayName` the developer set while `type` holds the
 * inner function.
 */
function fiberComponentName(fiber: object): string | undefined {
  const name =
    typeComponentName(readProperty(fiber, 'elementType').value) ??
    typeComponentName(readProperty(fiber, 'type').value);
  return name === undefined ? undefined : attributionName(name);
}

/**
 * Which of the `wanted` contexts a fiber provides, if it is a provider of one.
 *
 * React 19 renders `<Ctx value>` — and `Ctx.Provider`, which is `Ctx` itself —
 * as a fiber whose `type` is the context; React 18 and earlier render
 * `<Ctx.Provider>` as a fiber whose `type` is a provider object carrying the
 * context as `_context`. Both are accepted, and only on a fiber tagged
 * {@link CONTEXT_PROVIDER_WORK_TAG}.
 */
function providedContext(fiber: object, wanted: ReadonlySet<object>): object | undefined {
  if (readProperty(fiber, 'tag').value !== CONTEXT_PROVIDER_WORK_TAG) {
    return undefined;
  }
  const type = readProperty(fiber, 'type').value;
  if (!isObjectLike(type)) {
    return undefined;
  }
  if (wanted.has(type)) {
    return type;
  }
  const wrapped = readProperty(type, '_context').value;
  return isObjectLike(wrapped) && wanted.has(wrapped) ? wrapped : undefined;
}

/**
 * The provider name of each of `contexts`, from one bounded walk up the
 * consuming fiber's `return` chain.
 *
 * One walk serves every context, because every provider the fiber can read
 * from lies on that one chain and so does the component above each of them.
 * The walk keeps two lists as it climbs: the contexts whose provider has not
 * been seen yet, and the ones whose provider has been seen and which are
 * waiting for the next composite fiber, which names them. The **nearest**
 * provider of a context wins — the one React resolved the read against — and
 * a context provided again higher up is not looked at twice. The walk stops as
 * soon as both lists are empty, at a link it cannot read, or after
 * {@link MAX_PROVIDER_WALK_STEPS}.
 *
 * A provider whose first composite ancestor has no readable name is left
 * unnamed rather than attributed to a component further up, which would name
 * a component that does not render it. Nothing here throws: every read is
 * guarded and a failed one ends the walk with whatever it has found.
 *
 * @param fiber - The consuming fiber.
 * @param contexts - The context objects whose provider is wanted.
 * @returns A per-call map from context object to provider name, holding only
 * the contexts that were named.
 */
function nearestProviderNames(fiber: unknown, contexts: readonly object[]): Map<object, string> {
  const names = new Map<object, string>();
  const unresolved = new Set<object>(contexts);
  let awaitingComponent: object[] = [];
  let cursor = readProperty(fiber, 'return');

  for (
    let step = 0;
    step < MAX_PROVIDER_WALK_STEPS && (unresolved.size > 0 || awaitingComponent.length > 0);
    step += 1
  ) {
    const node = cursor.value;
    if (!cursor.ok || !isObjectLike(node)) {
      break;
    }
    if (awaitingComponent.length > 0) {
      const tag = readProperty(node, 'tag').value;
      if (typeof tag === 'number' && COMPOSITE_WORK_TAGS.includes(tag)) {
        const name = fiberComponentName(node);
        if (name !== undefined) {
          for (const context of awaitingComponent) {
            names.set(context, name);
          }
        }
        awaitingComponent = [];
      }
    }
    if (unresolved.size > 0) {
      const provided = providedContext(node, unresolved);
      if (provided !== undefined) {
        unresolved.delete(provided);
        awaitingComponent.push(provided);
      }
    }
    cursor = readProperty(node, 'return');
  }
  return names;
}

/** A context's own `displayName`, bounded, when the developer set one. */
function contextDisplayName(context: unknown): string | undefined {
  const displayName = readStringProperty(context, 'displayName');
  return displayName === undefined ? undefined : attributionName(displayName);
}

/**
 * Compares the values of the contexts the fiber consumes against the values it
 * consumed on the previous render.
 *
 * React records a consumed context on the fiber as a `dependencies` chain of
 * `{ context, memoizedValue, next }` nodes, rebuilt on each render that reads
 * context and dropped when a render does not. The three cases that follow from
 * that:
 *
 * - **Neither side has a chain.** The component consumes no context, so no
 *   consumed context value changed. Evaluable, and no change — without this
 *   case `unchanged` would be unreachable for the overwhelming majority of
 *   components and `unchanged_render_count` would always read zero.
 * - **One side has a chain and the other does not.** The previous value of a
 *   context that is consumed now is unavailable, which is exactly the case AAP
 *   0.7.1 names as producing `unknown`. Unevaluable.
 * - **Both sides have a chain.** Paired by context identity, falling back to
 *   position, and compared with `Object.is` — the same comparison React uses
 *   to decide whether to propagate a context change to its consumers.
 *
 * A dependency with no counterpart leaves the dimension unevaluable while any
 * change found on the other dependencies is still reported: a positive finding
 * outranks an unknown in {@link classifyRenderTrigger}. A chain longer than
 * `MAX_TRACKED_KEYS` has the same effect for the same reason — the
 * dependencies past the bound were never compared, so the dimension cannot
 * report that no consumed context value changed
 * ({@link scannedDimension}).
 *
 * Each change is then **attributed**: `contextName` from the context's own
 * `displayName`, and `provider` from one bounded walk up the fiber's `return`
 * chain to the nearest provider of each changed context and the component
 * that renders it ({@link nearestProviderNames}). Attribution never affects
 * the classification or evaluability, and it runs only when at least one
 * consumed value changed, so the walk costs nothing on the renders where no
 * context did.
 *
 * @param fiber - A React fiber; every read is guarded.
 */
export function diffContexts(fiber: unknown): DimensionResult<ContextChange> {
  return toDimensionResult(scanContexts(captureFiber(fiber), summarizerFor(undefined), fiber));
}

/**
 * The consumed-context comparison {@link diffContexts} documents, over
 * captured chain heads.
 *
 * `summarize` has the meaning it has in {@link scanHookState}: `undefined`
 * counts the changed contexts without describing them. A context's label is
 * part of its description and is read only when one is being built. Every
 * changed context is attributed either way ({@link ContextScan.attributions}):
 * its own `displayName`, and — when `fiber` is given — the component that
 * renders its nearest provider, found by one walk up `fiber`'s `return` chain.
 */
function scanContexts(
  captured: CapturedFiber,
  summarize: Summarizer | undefined,
  fiber: unknown,
): ContextScan {
  if (!captured.hasAlternate) {
    return { ...unevaluableScan<ContextChange>(), attributions: [] };
  }
  const nextHead = captured.nextContexts;
  const previousHead = captured.previousContexts;
  const nextPresent = isObjectLike(nextHead);
  const previousPresent = isObjectLike(previousHead);
  if (!nextPresent && !previousPresent) {
    return { ...stableScan<ContextChange>(), attributions: [] };
  }
  if (!nextPresent || !previousPresent) {
    return { ...unevaluableScan<ContextChange>(), attributions: [] };
  }
  const nextScan = collectChain(nextHead, 'next');
  const previousScan = collectChain(previousHead, 'next');
  if (nextScan.failed || previousScan.failed) {
    return { ...unevaluableScan<ContextChange>(), attributions: [] };
  }

  let evaluable = true;
  let count = 0;
  const changed: ContextChange[] = [];
  const named: ContextAttribution[] = [];
  // The context object behind each attribution, where it is one — with the
  // change it describes, when one was described — so the providers can be
  // resolved in one walk once the changed set is known.
  const attributions: {
    readonly attribution: ContextAttribution;
    readonly change: ContextChange | undefined;
    readonly context: object;
  }[] = [];
  for (const [index, dependency] of nextScan.nodes.entries()) {
    const counterpart = findContextCounterpart(previousScan.nodes, dependency, index);
    if (counterpart === undefined) {
      evaluable = false;
      continue;
    }
    const after = readProperty(dependency, 'memoizedValue');
    const before = readProperty(counterpart, 'memoizedValue');
    if (!after.ok || !before.ok) {
      evaluable = false;
      continue;
    }
    if (Object.is(before.value, after.value)) {
      continue;
    }
    count += 1;
    let change: ContextChange | undefined;
    if (summarize !== undefined) {
      const label = contextLabel(dependency);
      const from = summarize(before.value);
      const to = summarize(after.value);
      change = label === undefined ? { index, from, to } : { index, label, from, to };
      changed.push(change);
    }
    // Every changed context is attributed, described or not: its names are
    // what a `render` event's `changedContexts` carries, and they are names
    // from the developer's code, never the value.
    const attribution: ContextAttribution = {};
    named.push(attribution);
    const context = readProperty(dependency, 'context').value;
    if (isObjectLike(context)) {
      const contextName = contextDisplayName(context);
      if (contextName !== undefined) {
        attribution.contextName = contextName;
        if (change !== undefined) {
          change.contextName = contextName;
        }
      }
      attributions.push({ attribution, change, context });
    }
  }
  if (attributions.length > 0 && fiber !== undefined) {
    // Only here, after the comparison: the walk is paid for by renders a
    // context change caused, never by the ones where nothing changed.
    const providers = nearestProviderNames(
      fiber,
      attributions.map((entry) => entry.context),
    );
    for (const { attribution, change, context } of attributions) {
      const provider = providers.get(context);
      if (provider !== undefined) {
        attribution.provider = provider;
        if (change !== undefined) {
          change.provider = provider;
        }
      }
    }
  }
  return {
    ...scannedDimension(count, changed, evaluable, nextScan.overflow || previousScan.overflow),
    attributions: named,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Classification
 * ---------------------------------------------------------------------------
 */

/**
 * Passes a classification through the catalog vocabulary.
 *
 * The `includes` call is the drift guard: `RENDER_TRIGGERS` is a literal tuple,
 * so if {@link RenderTrigger} ever gained a value the catalog does not have,
 * this argument would not type-check and the build would fail here rather than
 * a panel silently receiving a trigger no consumer recognises.
 */
function asTrigger(candidate: RenderTrigger): RenderTrigger {
  return RENDER_TRIGGERS.includes(candidate) ? candidate : 'unknown';
}

/**
 * Decides why the fiber rendered, from what the three dimensions found.
 *
 * Precedence, exactly as AAP 0.7.1 states it: props, then own hook state, then
 * a consumed context value, then `unchanged`, with `unknown` when a dimension
 * could not be evaluated. Two rules resolve the overlap the precedence list
 * leaves open:
 *
 * - **A positive finding outranks an unknown.** A changed prop explains the
 *   render whether or not the context chain could be read, so the first
 *   dimension with a change wins even when another is unevaluable.
 * - **`unchanged` requires all three.** It is returned only when props, own
 *   hook state *and* consumed contexts were all evaluated and all found
 *   nothing, which is what makes `unchanged_render_count` mean what AAP 0.2.3
 *   says it means: props shallow-equal, own hook state unchanged and no
 *   consumed context value changed. Anything less is `unknown`, counted
 *   separately as `render_trigger_unknown_count`.
 *
 * `input.evaluable` is therefore a claim of **complete** comparison, not of
 * "the comparison was attempted". The three dimensions of this module make
 * that claim only for a scan that ran to the end (see
 * {@link scannedDimension}), so a change hidden past `MAX_TRACKED_KEYS`
 * arrives here as an unevaluable dimension with empty change lists and
 * classifies as `unknown`. A caller assembling this input by hand owes the
 * same rule: passing `evaluable: true` for a dimension it only partly compared
 * is what would let an unobservable render be counted as a stable-input one.
 *
 * A mount has no alternate, so all three dimensions are unevaluable and the
 * result is `unknown`. **`../browser/react.ts` must omit the `trigger`
 * attribute entirely for a `phase: "mount"` render** rather than emitting that
 * `unknown`: a mount's cause is not in doubt, the `phase` attribute already
 * carries it, and letting mounts through would inflate
 * `render_trigger_unknown_count` with the one case nobody needs explained.
 *
 * @param input - The three change lists and the evaluability flags, as the
 * dimensions reported them.
 */
export function classifyRenderTrigger(
  input: Pick<FiberDiff, 'propChanges' | 'hookChanges' | 'contextChanges' | 'evaluable'>,
): RenderTrigger {
  return classifyCounts(
    input.propChanges.length,
    input.hookChanges.length,
    input.contextChanges.length,
    input.evaluable,
  );
}

/**
 * {@link classifyRenderTrigger}'s precedence over change *counts*, which is
 * all the rule reads.
 *
 * The one implementation of the precedence, shared by the full diff — whose
 * counts are the lengths of its described change lists — and by the render
 * path, which counts changes it does not describe. Two implementations would
 * be two chances for `unchanged_render_count` to mean two different things.
 */
function classifyCounts(
  propChanges: number,
  hookChanges: number,
  contextChanges: number,
  evaluable: DimensionEvaluability,
): RenderTrigger {
  if (propChanges > 0) {
    return asTrigger('props');
  }
  if (hookChanges > 0) {
    return asTrigger('state');
  }
  if (contextChanges > 0) {
    return asTrigger('context');
  }
  if (evaluable.props && evaluable.state && evaluable.context) {
    return asTrigger('unchanged');
  }
  return asTrigger('unknown');
}

/**
 * The answer for a fiber nothing could be learned from: an `unknown` trigger,
 * no changes, and all three dimensions unevaluable.
 *
 * A function rather than a frozen constant so that a caller which mutates the
 * arrays it receives — appending to `changedProps`, say — cannot reach across
 * into another caller's result.
 */
function unknownDiff(): FiberDiff {
  return {
    trigger: 'unknown',
    changedProps: [],
    propChanges: [],
    hookChanges: [],
    contextChanges: [],
    changedContexts: [],
    evaluable: { props: false, state: false, context: false },
    truncated: false,
  };
}

/**
 * The capture of a fiber with no previous render: shared, because a mount
 * carries nothing worth pointing at and a commit that mounts a whole page
 * would otherwise allocate one empty record per fiber on the commit path.
 * Frozen, so the sharing cannot become shared state.
 */
const MOUNT_CAPTURE: CapturedFiber = Object.freeze({
  hasAlternate: false,
  nextProps: undefined,
  previousProps: undefined,
  nextHooks: undefined,
  previousHooks: undefined,
  nextContexts: undefined,
  previousContexts: undefined,
});

/** The head of a fiber's consumed-context chain, or `undefined` when it has none. */
function firstContextOf(fiber: unknown): unknown {
  const dependencies = readProperty(fiber, 'dependencies').value;
  return isObjectLike(dependencies) ? readProperty(dependencies, 'firstContext').value : undefined;
}

/**
 * Reads the pointers a later {@link analyzeCapturedFiber} needs, and nothing
 * else — the synchronous half of "Capture now, analyse later".
 *
 * This is what `./react.ts` calls inside React's commit for every rendered
 * composite fiber, so its whole cost is a handful of guarded property reads:
 * the alternate, both `memoizedProps`, both `memoizedState` heads and both
 * `dependencies.firstContext` heads. No key is enumerated, no chain is walked,
 * no value is compared or summarised. A fiber with no alternate — a mount —
 * reads one field and shares one frozen record.
 *
 * Never throws: every read is guarded, and a fiber that defeats them yields a
 * record the analysis reports as unevaluable, exactly as {@link analyzeFiber}
 * reports the live fiber. Writes nothing to the fiber.
 *
 * @param fiber - A React fiber; typed `unknown` for the reason
 * {@link analyzeFiber} gives.
 */
export function captureFiber(fiber: unknown): CapturedFiber {
  try {
    const alternate = readProperty(fiber, 'alternate').value;
    if (!isObjectLike(alternate)) {
      return MOUNT_CAPTURE;
    }
    return {
      hasAlternate: true,
      nextProps: readProperty(fiber, 'memoizedProps').value,
      previousProps: readProperty(alternate, 'memoizedProps').value,
      nextHooks: readProperty(fiber, 'memoizedState').value,
      previousHooks: readProperty(alternate, 'memoizedState').value,
      nextContexts: firstContextOf(fiber),
      previousContexts: firstContextOf(alternate),
    };
  } catch {
    // Unreachable by construction — every read is guarded — and kept because
    // this runs inside React's commit, where a throw is the one outcome this
    // module may never produce. Unevaluable is the honest answer.
    return MOUNT_CAPTURE;
  }
}

/**
 * Analyses one rendered fiber: what changed across all three dimensions, why
 * it rendered, and the bounded summaries of every changed value.
 *
 * The synchronous composition of {@link captureFiber} and the full
 * comparison: three bounded comparisons, summaries for every value that
 * actually changed — props included — and no serialisation of anything the
 * page owns. Nothing is sorted beyond a capped key selection, no user function
 * is called, and no value is stringified except through
 * {@link summarizeValue}'s bounded composition. `./react.ts` no longer calls
 * this on the commit path — it captures there and calls
 * {@link analyzeCapturedFiber} later — and the two classify every fiber
 * identically, because both run the same scans over the same pointers.
 *
 * Never throws. A failure anywhere inside degrades to {@link unknownDiff},
 * which is the honest report — "this fiber could not be analysed" — and keeps
 * the render out of `unchanged_render_count`.
 *
 * @param fiber - A React fiber, typed `unknown` deliberately: real fibers vary
 * by React version and a synthetic fiber-shaped object is a legitimate input,
 * so the shape is narrowed by guarded reads rather than asserted.
 */
export function analyzeFiber(fiber: unknown): FiberDiff {
  try {
    const captured = captureFiber(fiber);
    const summarize = summarizerFor(undefined);
    const props = scanProps(captured, true);
    const hooks = scanHookState(captured, summarize);
    const contexts = scanContexts(captured, summarize, fiber);
    const evaluable: DimensionEvaluability = {
      props: props.evaluable,
      state: hooks.evaluable,
      context: contexts.evaluable,
    };
    const trigger = classifyRenderTrigger({
      propChanges: props.changes,
      hookChanges: hooks.changed,
      contextChanges: contexts.changed,
      evaluable,
    });
    return {
      trigger,
      changedProps: props.keys,
      propChanges: props.changes,
      hookChanges: hooks.changed,
      contextChanges: contexts.changed,
      changedContexts: contexts.attributions,
      evaluable,
      truncated: props.truncated || hooks.truncated || contexts.truncated,
    };
  } catch {
    // Unreachable by construction — every read below is already guarded — and
    // kept because "the debugger threw inside a commit" is the one outcome
    // this module may never produce.
    return unknownDiff();
  }
}

/**
 * The deferred, render-path half of "Capture now, analyse later": classifies
 * a fiber from what {@link captureFiber} recorded at its commit.
 *
 * Produces exactly the classification, changed-prop names, evaluability and
 * truncation {@link analyzeFiber} would have produced at the commit — the same
 * scans run over the same pointers — and deliberately *less* description:
 *
 * - **No prop summary is composed.** A `render` event carries the changed
 *   prop names and the trigger; the two value summaries per changed prop that
 *   {@link analyzeFiber} builds would be composed, scrubbed and discarded.
 * - **Hook and context summaries only on request**
 *   ({@link CapturedFiberAnalysisOptions.transitions}), which `./react.ts`
 *   sets while `./state.ts` is armed — the only consumer of those values.
 *   Without the request the changes are counted, which is all the trigger
 *   needs.
 * - **Through the caller's memo**, when one is passed, so a value shared by
 *   many consumers of one pass is summarised once.
 *
 * Never throws; a failure degrades to an `unknown`, unevaluable answer.
 *
 * @param captured - What {@link captureFiber} returned at the commit.
 * @param options - Whether to describe transitions, and the pass's memo.
 * @param fiber - The fiber the capture was taken from, when the caller still
 * holds it: what names the provider of each changed context
 * ({@link RenderAnalysis.changedContexts}). Walked only when a consumed
 * context changed; a fiber React has since detached yields the context's own
 * `displayName` alone.
 */
export function analyzeCapturedFiber(
  captured: CapturedFiber,
  options?: CapturedFiberAnalysisOptions,
  fiber?: unknown,
): RenderAnalysis {
  try {
    const summarize = options?.transitions === true ? summarizerFor(options.memo) : undefined;
    const props = scanProps(captured, false);
    const hooks = scanHookState(captured, summarize);
    const contexts = scanContexts(captured, summarize, fiber);
    const evaluable: DimensionEvaluability = {
      props: props.evaluable,
      state: hooks.evaluable,
      context: contexts.evaluable,
    };
    return {
      trigger: classifyCounts(props.keys.length, hooks.count, contexts.count, evaluable),
      changedProps: props.keys,
      hookChanges: hooks.changed,
      contextChanges: contexts.changed,
      changedContexts: contexts.attributions,
      evaluable,
      truncated: props.truncated || hooks.truncated || contexts.truncated,
    };
  } catch {
    // Unreachable by construction, for the reason {@link analyzeFiber} gives.
    return {
      trigger: 'unknown',
      changedProps: [],
      hookChanges: [],
      contextChanges: [],
      changedContexts: [],
      evaluable: { props: false, state: false, context: false },
      truncated: false,
    };
  }
}
