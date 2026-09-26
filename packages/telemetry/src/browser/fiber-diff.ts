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
 * ## Purity
 *
 * No side effects at import time, no DOM access at module scope, no timers, no
 * clock, no randomness, no shared mutable state. Every exported function is
 * synchronous. The one mutable structure — the visited set and node budget a
 * preview walk carries — is allocated per call and dies with it, so two
 * concurrent callers cannot observe each other and a pathological value cannot
 * poison a later summary.
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
 */
export interface ContextChange {
  /** Zero-based position in the fiber's context-dependency chain. */
  index: number;
  /** Context display name, or the category of its default value. */
  label?: string;
  /** Summary of the consumed value at the previous render. */
  from: ValueSummary;
  /** Summary of the consumed value at this render. */
  to: ValueSummary;
}

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

/** A dimension that could not be compared. A fresh object per call. */
function unevaluableDimension<TChange>(): DimensionResult<TChange> {
  return { changed: [], evaluable: false, truncated: false };
}

/**
 * A dimension whose equality is proven without a scan — the two sides are the
 * same object, or neither side has anything to compare. A fresh object per
 * call.
 */
function stableDimension<TChange>(): DimensionResult<TChange> {
  return { changed: [], evaluable: true, truncated: false };
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
 * @param changed - The changes the scan positively observed, already bounded.
 * @param evaluable - Whether the comparison was possible at all, before the
 * bound is taken into account (a context dependency with no counterpart, for
 * instance, has already made the dimension unevaluable).
 * @param truncated - Whether either side's scan overflowed the bound.
 */
function scannedDimension<TChange>(
  changed: TChange[],
  evaluable: boolean,
  truncated: boolean,
): DimensionResult<TChange> {
  return { changed, evaluable: evaluable && !truncated, truncated };
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
  const alternate = readProperty(fiber, 'alternate').value;
  if (!isObjectLike(alternate)) {
    return unevaluableDimension();
  }
  const nextProps = readProperty(fiber, 'memoizedProps').value;
  const previousProps = readProperty(alternate, 'memoizedProps').value;
  if (!isObjectLike(nextProps) || !isObjectLike(previousProps)) {
    return unevaluableDimension();
  }
  if (nextProps === previousProps) {
    // React reuses the props object when it bails out of a subtree: the same
    // object cannot differ from itself, so no key needs reading.
    return stableDimension();
  }
  const nextScan = collectOwnKeys(nextProps, MAX_TRACKED_KEYS);
  const previousScan = collectOwnKeys(previousProps, MAX_TRACKED_KEYS);
  if (nextScan.failed || previousScan.failed) {
    return unevaluableDimension();
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

  const changed: PropChange[] = [];
  for (const key of keys) {
    const before = readProperty(previousProps, key);
    const after = readProperty(nextProps, key);
    if (!before.ok || !after.ok) {
      continue;
    }
    if (Object.is(before.value, after.value)) {
      continue;
    }
    changed.push({
      key,
      from: summarizeValue(before.value, key),
      to: summarizeValue(after.value, key),
    });
  }
  return scannedDimension(changed, true, truncated);
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
  const alternate = readProperty(fiber, 'alternate').value;
  if (!isObjectLike(alternate)) {
    return unevaluableDimension();
  }
  const nextHead = readProperty(fiber, 'memoizedState').value;
  const previousHead = readProperty(alternate, 'memoizedState').value;
  const nextPresent = isObjectLike(nextHead);
  const previousPresent = isObjectLike(previousHead);
  if (!nextPresent && !previousPresent) {
    // A component with no hooks: React leaves `memoizedState` null on both
    // sides. Nothing to compare, and nothing changed — which is a genuine
    // "unchanged" contribution, not an unknown.
    return stableDimension();
  }
  if (nextPresent !== previousPresent) {
    // Hooks appeared or disappeared between renders, which React does not do
    // for a well-formed component. Positional pairing is meaningless here.
    return unevaluableDimension();
  }
  if (nextHead === previousHead) {
    // The bailout path keeps the current fiber's hook list, so the chains are
    // the same objects and no hook's value can have changed.
    return stableDimension();
  }
  if (!isHookNode(nextHead) || !isHookNode(previousHead)) {
    return unevaluableDimension();
  }
  const nextScan = collectChain(nextHead, 'next');
  const previousScan = collectChain(previousHead, 'next');
  if (nextScan.failed || previousScan.failed) {
    return unevaluableDimension();
  }
  if (nextScan.nodes.length !== previousScan.nodes.length) {
    return unevaluableDimension();
  }

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
    const label = hookLabel(kind);
    const from = summarizeValue(before.value);
    const to = summarizeValue(after.value);
    changed.push(label === undefined ? { index, from, to } : { index, label, from, to });
  }
  return scannedDimension(changed, true, nextScan.overflow || previousScan.overflow);
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
 * @param fiber - A React fiber; every read is guarded.
 */
export function diffContexts(fiber: unknown): DimensionResult<ContextChange> {
  const alternate = readProperty(fiber, 'alternate').value;
  if (!isObjectLike(alternate)) {
    return unevaluableDimension();
  }
  const nextDependencies = readProperty(fiber, 'dependencies').value;
  const previousDependencies = readProperty(alternate, 'dependencies').value;
  const nextHead = isObjectLike(nextDependencies)
    ? readProperty(nextDependencies, 'firstContext').value
    : undefined;
  const previousHead = isObjectLike(previousDependencies)
    ? readProperty(previousDependencies, 'firstContext').value
    : undefined;
  const nextPresent = isObjectLike(nextHead);
  const previousPresent = isObjectLike(previousHead);
  if (!nextPresent && !previousPresent) {
    return stableDimension();
  }
  if (!nextPresent || !previousPresent) {
    return unevaluableDimension();
  }
  const nextScan = collectChain(nextHead, 'next');
  const previousScan = collectChain(previousHead, 'next');
  if (nextScan.failed || previousScan.failed) {
    return unevaluableDimension();
  }

  let evaluable = true;
  const changed: ContextChange[] = [];
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
    const label = contextLabel(dependency);
    const from = summarizeValue(before.value);
    const to = summarizeValue(after.value);
    changed.push(label === undefined ? { index, from, to } : { index, label, from, to });
  }
  return scannedDimension(changed, evaluable, nextScan.overflow || previousScan.overflow);
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
  if (input.propChanges.length > 0) {
    return asTrigger('props');
  }
  if (input.hookChanges.length > 0) {
    return asTrigger('state');
  }
  if (input.contextChanges.length > 0) {
    return asTrigger('context');
  }
  const { props, state, context } = input.evaluable;
  if (props && state && context) {
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
    evaluable: { props: false, state: false, context: false },
    truncated: false,
  };
}

/**
 * Analyses one rendered fiber: what changed across all three dimensions, why
 * it rendered, and the bounded summaries of every changed value.
 *
 * This is the function `../browser/react.ts` calls for every composite fiber of
 * every commit, so it does the minimum that answers the question: three
 * bounded comparisons, summaries only for the values that actually changed,
 * and no serialisation of anything the page owns. Nothing is sorted beyond a
 * capped key selection, no user function is called, and no value is
 * stringified except through {@link summarizeValue}'s bounded composition.
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
    const props = diffProps(fiber);
    const hooks = diffHookState(fiber);
    const contexts = diffContexts(fiber);
    const evaluable: DimensionEvaluability = {
      props: props.evaluable,
      state: hooks.evaluable,
      context: contexts.evaluable,
    };
    const trigger = classifyRenderTrigger({
      propChanges: props.changed,
      hookChanges: hooks.changed,
      contextChanges: contexts.changed,
      evaluable,
    });
    return {
      trigger,
      changedProps: props.changed.map((change) => change.key),
      propChanges: props.changed,
      hookChanges: hooks.changed,
      contextChanges: contexts.changed,
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
