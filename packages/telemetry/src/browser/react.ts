/**
 * React's commit phase, observed from outside the application.
 *
 * This is the module behind the second acceptance test — "Why is this
 * component rendering so many times?" (AAP 0.8.4) — and the only producer that
 * can answer it. A render is not visible in the network panel, in the
 * performance timeline or in any log the developer's application writes: it
 * exists only inside React's reconciler, and the one supported way to watch it
 * is the React DevTools global hook that React itself calls on every commit.
 * So the evidence this file emits is obtained with **no change to the
 * developer's source at all** (AAP 0.5.1's first principle: prefer an existing
 * runtime hook, patch a file only where no hook can supply the signal).
 *
 * ## What it produces, and who reads it
 *
 * Two event kinds, one commit at a time:
 *
 * - **`commit`** — one event per React commit, the parent span of that
 *   commit's renders. Its `renderCount` attribute is how many fibers the
 *   commit actually rendered, which is the number a developer recognises as
 *   "this many components re-rendered when I typed one character".
 * - **`render`** — one event per composite fiber that rendered, carrying the
 *   component name, the phase, the running per-capture render count, the props
 *   that changed, and — for an update — **why** it rendered.
 *
 * `../aggregate/renders.ts` turns those into the `renderTable` and
 * `componentTree` panel sources and into the `render_count`,
 * `unchanged_render_count` and `render_trigger_unknown_count` metrics
 * (AAP 0.2.3, 0.6.2). The correctness of this module is therefore visible on a
 * generated panel rather than internal: a component that rendered 400 times
 * with stable inputs is the finding, and it is produced by the `trigger`
 * attribute below being right.
 *
 * ## The one rule that must not be got wrong
 *
 * **`trigger` is emitted for an update and withheld from a mount.** A mount has
 * no previous fiber, so `./fiber-diff.js` cannot evaluate any of the three
 * dimensions and classifies it `unknown` — correctly, since nothing was
 * comparable. Emitting that `unknown` would inflate
 * `render_trigger_unknown_count`, a metric AAP 0.2.3 reserves for *updates*
 * whose cause genuinely could not be determined, and would bury the handful of
 * real unknowns under every mount in the capture. A mount's cause is not in
 * doubt and the `phase` attribute already states it, so the key is omitted
 * entirely rather than set to anything. {@link buildRenderAttributes} is where
 * that happens.
 *
 * ## Division of labour
 *
 * This module owns the *subscription* and the *events*. It deliberately owns
 * nothing else:
 *
 * - **`./fiber-diff.js`** reads props, hook state and consumed contexts and
 *   classifies the render. No field of a fiber that holds application data —
 *   `memoizedProps`, `memoizedState`, `dependencies` — is touched here; a
 *   second reader of those fields would be a second privacy boundary to audit,
 *   and there is exactly one (AAP 0.5.2).
 * - **`./state.js`** turns the hook and context changes that diff found into
 *   `state` events. This module hands them over and reads no hook itself.
 *   Emitting them from here as well would double the evidence.
 * - **`./interaction.js`** decides which trace a commit belongs to. Asked once
 *   per commit, never per fiber, so every render of one commit lands in one
 *   tree and the answer cannot change halfway through a traversal.
 * - **`./transport.js`** stamps, bounds and posts. Outside a capture it drops
 *   everything, which is why this file holds no capture state of its own.
 * - **`./agent.js`** owns the lifecycle: it installs bippy's hook at
 *   `document_start` (see below), calls {@link attachReact} when a capture
 *   arms the React hook, {@link resetReactCounters} at the start of each
 *   capture, {@link snapshotComponentTree} when a capture stops, and
 *   {@link detachReact} when the hooks are cleared.
 *
 * ## `installRDTHook` is not called here, and that is the whole design
 *
 * React registers with `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` when it
 * initialises. If the hook does not exist at that moment, React never
 * registers and **no commit is ever observable for the life of that document**
 * — no retry, no recovery. That is why the Chrome extension declares the agent
 * as a MAIN-world content script at `document_start` and why `./agent.js`
 * installs the hook there, before the page's own scripts run (AAP 0.1.1,
 * 0.7.1 Group 4). This module only subscribes, and it must not assume the hook
 * was early: {@link detectReact} reports what is actually true so the service
 * can offer the developer a one-click reload when the agent arrived late.
 *
 * {@link detachReact} likewise never *uninstalls* the hook. React is already
 * attached to it, and removing it would break the page and the real React
 * DevTools extension alongside it. Unsubscribing the handlers is what AAP
 * 0.5.1 asks for ("bippy handlers unsubscribed via the function `instrument()`
 * returned"), and it is complete: after a detach this module holds no
 * subscription, no counts and no fiber tree, and a commit costs one comparison.
 *
 * ## Cost, and why the hot path looks the way it does
 *
 * The commit callback runs inside React's commit phase, on the developer's own
 * click path, for every commit their application performs. So:
 *
 * - Host fibers are skipped immediately (`isCompositeFiber`). A commit touches
 *   several times more DOM fibers than components, none of which a
 *   `renderTable` reader wants, and each one would cost an event.
 * - The traversal already yields only fibers that performed work — that is what
 *   `traverseRenderedFibers` means, and bippy's walkers gate on the same
 *   `PerformedWork` flag `didFiberRender` reads — so no second per-fiber
 *   confirmation is made. It would be redundant work on the busiest path in
 *   the agent.
 * - Renders are collected into drafts and handed over in **one**
 *   {@link emitMany} call after the traversal: one capture gate, consecutive
 *   sequence numbers, and — the reason for the ordering — a commit event whose
 *   `renderCount` is the exact count rather than an estimate made before the
 *   work was done. The commit draft leads that batch, so the parent's sequence
 *   number precedes its children's.
 * - A commit is bounded at {@link MAX_RENDERS_PER_COMMIT} render events. The
 *   demo's seeded defect 2 re-renders 48 catalogue cards on a 250 ms ticker
 *   (AAP 0.8.2); one pathological commit must not consume the transport's
 *   whole 5 000-event buffer. The commit event says it was cut, and
 *   `renderedFiberCount` says by how much.
 * - Nothing here sorts, clones, stringifies or retains application values.
 *
 * ## Nothing here throws, ever
 *
 * A throw inside `onCommitFiberRoot` surfaces inside React's commit phase and
 * can break the developer's application — the one failure this product may
 * never cause. Every handler body sits inside a `try`/`catch`, and **each
 * per-fiber iteration has its own**, so a single hostile fiber costs itself and
 * not the rest of the commit. Failures are counted in {@link getReactStats}
 * and swallowed, which is the same contract `./transport.js`, `./state.js` and
 * `./perf.ts` keep.
 *
 * One consequence of bippy's traversal worth knowing when reading a capture:
 * it diffs each root against the last fiber tree it saw for that root, so the
 * **first commit observed after the hook starts being traversed is walked as a
 * mount pass**. A capture armed on an already-rendered page therefore opens
 * with a baseline commit reporting mounts, and — by the rule above — no
 * triggers. Every commit after it is a true update.
 *
 * Nothing observable happens at import time: the bindings are declared and the
 * first subscription is made only when {@link attachReact} runs. Module scope
 * is one page document, the scope `./ids.ts` memoizes its producer id in.
 *
 * ## Imports are a constraint, not a coincidence
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this file into the IIFE
 * injected into the developer's page and hard-fails on any input resolving to
 * a Node builtin, `@debuggen/protocol`, `@debuggen/shared`'s Node entry or
 * `zod`. `react` and `react-dom` are absent for a different reason: the React
 * on the page is the developer's, and bundling a second copy to talk to it
 * would be both wrong and enormous. bippy is the only third-party import, and
 * `../schema/attributes.js` is a dependency-free vocabulary.
 *
 * @see ./fiber-diff.ts for the render classification and its privacy bounds.
 * @see ./state.ts for the `state` events this module delegates.
 * @see ./interaction.ts for the trace and parent every commit adopts.
 * @see ../schema/attributes.ts for the `render` and `commit` vocabularies.
 * @see ../aggregate/renders.ts for the aggregate these events feed.
 */

import {
  getDisplayName,
  getFiberId,
  getRDTHook,
  hasRDTHook,
  instrument,
  isCompositeFiber,
  traverseFiber,
  traverseRenderedFibers,
} from 'bippy';
import type { Fiber, FiberRoot } from 'bippy';

import { analyzeFiber } from './fiber-diff.js';
import type { ContextChange, FiberDiff, HookChange } from './fiber-diff.js';
import { newSpanId } from './ids.js';
import { resolveEventContext } from './interaction.js';
import type { EventContext } from './interaction.js';
import { recordStateTransitions } from './state.js';
import type { RecordTransitionsInput } from './state.js';
import { emitMany, nowEpochMs, toEpochMs } from './transport.js';
import type { EventDraft } from './transport.js';
import { RENDER_PHASES } from '../schema/attributes.js';
import type {
  COMMIT_ATTRIBUTE_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  RenderPhase,
  RenderTrigger,
} from '../schema/attributes.js';

/*
 * ---------------------------------------------------------------------------
 * Contract constants
 *
 * Exported because each is part of a contract a caller or a test reasons
 * about — a panel's "list was cut" banner is only honest if the bound that cut
 * it can be named, and `./agent.js` passes the tree bounds through from the
 * service's request. None is a tuning knob: raising the per-commit bound
 * raises what one commit may cost the developer's page, and raising the tree
 * bounds raises what one snapshot event carries.
 * ---------------------------------------------------------------------------
 */

/**
 * The most `render` events one commit may produce: 500.
 *
 * Chosen against the two numbers it sits between. The transport buffers 5 000
 * events for a whole capture (`MAX_BUFFERED_EVENTS` in `./transport.ts`), and
 * the demo's excessive-render defect re-renders 48 cards several times a
 * second; 500 is an order of magnitude above any commit worth reading fiber by
 * fiber, and a tenth of the buffer, so one runaway commit cannot evict the
 * interaction, request and query evidence the same capture needs.
 *
 * A commit that reaches the bound still reports the truth about itself: the
 * `truncated` attribute says the list was cut and `renderedFiberCount` says
 * how many fibers actually rendered.
 */
export const MAX_RENDERS_PER_COMMIT = 500;

/**
 * The most ancestor names a render's `ownerChain` may carry: 8.
 *
 * The chain exists so `../aggregate/renders.ts` can rebuild a component tree
 * from a flat event list even when the explicit snapshot event is missing, and
 * so a panel can say where a component sits. Eight levels identify a component
 * unambiguously in any real application while keeping a `render` event small —
 * and a deep tree costs the bound, not the event: the walk stops, it does not
 * fail.
 */
export const MAX_OWNER_CHAIN = 8;

/**
 * Default node bound for {@link snapshotComponentTree}: 2 000.
 *
 * The same number `../aggregate/renders.ts` defaults its own component-tree
 * assembly to, so a snapshot taken in the page and a tree reconstructed in the
 * service are cut at the same size rather than at two sizes a reader would
 * have to reconcile.
 */
export const MAX_TREE_NODES = 2000;

/**
 * Default depth bound for {@link snapshotComponentTree}: 50.
 *
 * Deep enough for a real application's provider and router nesting, shallow
 * enough that a pathological or cyclic structure cannot turn a snapshot into
 * an unbounded walk.
 */
export const MAX_TREE_DEPTH = 50;

/*
 * ---------------------------------------------------------------------------
 * Internal bounds and labels
 * ---------------------------------------------------------------------------
 */

/**
 * The longest component name that may travel, in UTF-16 code units.
 *
 * A display name is code the developer wrote, so it is not sensitive, but it
 * is also not necessarily short: a generated or higher-order component name
 * can run to hundreds of characters, and the event schema caps `name` at 512.
 * Cutting at 200 keeps both the event's `name` and its `component` attribute
 * readable and bounded.
 */
const MAX_COMPONENT_NAME_LENGTH = 200;

/**
 * The longest root identifier that may travel, in UTF-16 code units.
 *
 * `rootName` is assembled from a container element's id or tag name, both of
 * which come from the page and are therefore bounded here rather than trusted.
 */
const MAX_ROOT_NAME_LENGTH = 120;

/**
 * The longest React `key` that may travel, in UTF-16 code units.
 *
 * A key is application-authored and frequently an identifier — which is
 * exactly why it is useful for telling the forty-eighth card from the first —
 * so it is bounded like every other borrowed string. It is a list identity,
 * not a value: `./fiber-diff.ts` remains the only module that summarises
 * application data.
 */
const MAX_KEY_LENGTH = 120;

/** What a composite fiber with no resolvable display name is called. */
const ANONYMOUS_COMPONENT = 'Anonymous';

/** The `name` every `commit` event carries. */
const COMMIT_EVENT_NAME = 'React commit';

/*
 * ---------------------------------------------------------------------------
 * Event shape constants
 *
 * The kind and status are annotated against `./transport.ts`'s draft type,
 * which is derived from the event schema, which is derived from the kind
 * vocabulary in `../schema/kinds.ts`. A misspelling here therefore does not
 * compile, which is the guarantee that importing the vocabulary would have
 * bought — without adding an import this file would otherwise not use.
 * ---------------------------------------------------------------------------
 */

/** One composite fiber that rendered. */
const RENDER_KIND: EventDraft['kind'] = 'render';

/** One React commit: the parent span of that commit's renders. */
const COMMIT_KIND: EventDraft['kind'] = 'commit';

/**
 * Every event here is reported as `ok`.
 *
 * A render is an observation, not an operation that can fail. React's own
 * error handling is reported by `./errors.ts` as an `error` event, where a
 * reader expects to find it; a commit that contained a thrown component would
 * otherwise be reported twice, once as evidence and once as a status.
 */
const OK_STATUS: EventDraft['status'] = 'ok';

/*
 * ---------------------------------------------------------------------------
 * Attribute keys
 *
 * Each key is spelled once, and the ones the catalog declares are annotated
 * against it so a rename in `../schema/attributes.ts` fails this file's
 * typecheck instead of silently emptying a panel column. The additions below
 * are marked as such, with the reason each one exists: the event schema's
 * attribute bag is open precisely so a producer can carry a signal the catalog
 * has not adopted yet (`../schema/event.ts`).
 * ---------------------------------------------------------------------------
 */

/** A key the catalog declares for the `render` kind. */
type RenderAttributeKey = (typeof RENDER_ATTRIBUTE_KEYS)[number];

/** A key the catalog declares for the `commit` kind. */
type CommitAttributeKey = (typeof COMMIT_ATTRIBUTE_KEYS)[number];

/** Display name of the component that rendered; the aggregates group by it. */
const KEY_COMPONENT: RenderAttributeKey = 'component';

/** `mount` or `update`, from the traversal. */
const KEY_PHASE: RenderAttributeKey = 'phase';

/** Running count for this component within the capture, starting at 1. */
const KEY_RENDER_COUNT: RenderAttributeKey = 'renderCount';

/** Names of the props that were not equal to the previous render's. */
const KEY_CHANGED_PROPS: RenderAttributeKey = 'changedProps';

/** Why the fiber rendered. Present on an update, absent on a mount. */
const KEY_TRIGGER: RenderAttributeKey = 'trigger';

/** React's own reported render time for the fiber, including descendants. */
const KEY_ACTUAL_DURATION: RenderAttributeKey = 'actualDuration';

/** The fiber's cost excluding its descendants. */
const KEY_SELF_TIME: RenderAttributeKey = 'selfTime';

/** Ancestor component names, nearest first. */
const KEY_OWNER_CHAIN: RenderAttributeKey = 'ownerChain';

/** `mount` or `update` for the commit as a whole. */
const KEY_COMMIT_PHASE: CommitAttributeKey = 'phase';

/** How many fibers this commit rendered — not a per-component count. */
const KEY_COMMIT_RENDER_COUNT: CommitAttributeKey = 'renderCount';

/** Which root committed, so concurrent roots on one page stay apart. */
const KEY_ROOT_NAME: CommitAttributeKey = 'rootName';

/**
 * The fiber's identity within this document (bippy's `getFiberId`).
 *
 * **Addition**, spelled `fiberId` — the same spelling `./state.ts` emits, so
 * the two producers describe one instance the same way. Two components with
 * the same display name are one row when grouped by `component`; this is what
 * distinguishes the forty-eighth card from the first.
 */
const KEY_FIBER_ID = 'fiberId';

/**
 * The fiber id of the nearest composite ancestor.
 *
 * **Addition**, spelled `parentFiberId`. With {@link KEY_OWNER_CHAIN} it is
 * what lets `../aggregate/renders.ts` rebuild a `ComponentTreeSnapshot` from a
 * flat event list when no snapshot event arrived — the chain gives the names,
 * this gives the identity, and a tree built from names alone cannot tell two
 * siblings of one component apart.
 */
const KEY_PARENT_FIBER_ID = 'parentFiberId';

/**
 * The fiber's React `key`, when it has one.
 *
 * **Addition**, spelled `key` to match the field a component-tree node already
 * carries in `../aggregate/renders.ts`. It is what identifies one item of a
 * list across commits, which is how a duplicated or remounting row is
 * recognised.
 */
const KEY_ELEMENT_KEY = 'key';

/**
 * The renderer that committed, as React numbers them.
 *
 * **Addition**, spelled `rendererId`. A page can have more than one React
 * renderer attached to the hook, and a capture that mixed two of them would
 * misreport every render count; this is what keeps them separable.
 */
const KEY_RENDERER_ID = 'rendererId';

/**
 * The scheduling priority React reported for the commit, when it is a number.
 *
 * **Addition**, spelled `priority`. A commit at transition priority and one at
 * discrete-input priority feel completely different to a user, and the value
 * is handed to the callback anyway.
 */
const KEY_PRIORITY = 'priority';

/**
 * Set to `true` on a commit whose render list was cut at
 * {@link MAX_RENDERS_PER_COMMIT}.
 *
 * **Addition**, spelled `truncated` — the same spelling `./state.ts` uses for
 * the same kind of statement, and at the same level: it describes the *list*,
 * never one render.
 */
const KEY_TRUNCATED = 'truncated';

/**
 * How many fibers the commit rendered, before any bound was applied.
 *
 * **Addition**, spelled `renderedFiberCount`. It is the difference between
 * "this commit rendered 500 components" and "this commit rendered 8 000 and we
 * reported 500 of them", which is a conclusion a reader would otherwise draw
 * wrongly from a truncated list.
 */
const KEY_RENDERED_FIBER_COUNT = 'renderedFiberCount';

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

/**
 * One component instance in a {@link snapshotComponentTree} result.
 *
 * Deliberately four fields and a child list, and **never** props, state, a
 * DOM node or a fiber: the snapshot crosses `window.postMessage` as JSON
 * inside an event's attributes, so anything that could not be serialised — or
 * should not be — has no place in it. `name` is the field
 * `../aggregate/renders.ts`'s tree parser accepts as a component's name
 * alongside its own `component` spelling, so a snapshot emitted from the page
 * reads back without a translation step.
 */
export interface ComponentTreeNode {
  /** The component's display name, or {@link ANONYMOUS_COMPONENT}. */
  name: string;
  /** The fiber's identity within this document, when one was resolved. */
  fiberId?: number;
  /**
   * The React `key`, when the element had a usable one.
   *
   * `null` is admitted as well as absence because that is what a fiber
   * carries for an element without a key, and a round trip through JSON does
   * not distinguish an omitted property from one set to `undefined` anyway.
   */
  key?: string | null;
  /**
   * How many times *this component* rendered during the capture.
   *
   * The same per-component count the `renderCount` attribute of a `render`
   * event carries — not a per-instance count. Two cards of one component
   * therefore report the same number, which is the count
   * `../aggregate/renders.ts` also groups by, and `0` means this component
   * recorded no render in the capture (it was mounted before the capture
   * began).
   */
  renderCount: number;
  /** Child components, in fiber order. */
  children: ComponentTreeNode[];
  /**
   * Present and `true` on the node where a bound stopped the walk.
   *
   * The marker a reader needs in order to present a partial tree as partial.
   * It is the one field beyond the four above, and it exists because a
   * truncation that is not stated reads as a component with no children.
   */
  truncated?: true;
}

/**
 * What this module has done since the last reset: cheap enough for a
 * diagnostics view and for `./agent.js`'s readiness frames to read often.
 *
 * - `commits` — commits observed. Stops growing after {@link detachReact},
 *   which is the observable proof that the subscription was released.
 * - `renders` — `render` events handed to `./transport.js`.
 * - `truncatedCommits` — commits whose render list was cut at
 *   {@link MAX_RENDERS_PER_COMMIT}. Non-zero means a panel's render list is
 *   incomplete for those commits, which the events themselves also say.
 * - `failures` — commit bodies or per-fiber iterations that failed and were
 *   swallowed. Never the page's fault to fix; a non-zero value is this
 *   module's bug report.
 */
export interface ReactStats {
  /** Commits observed since the last reset. */
  commits: number;
  /** `render` events emitted since the last reset. */
  renders: number;
  /** Commits whose render list was cut by the per-commit bound. */
  truncatedCommits: number;
  /** Swallowed failures, per commit body or per fiber. */
  failures: number;
}

/*
 * ---------------------------------------------------------------------------
 * Internal types
 * ---------------------------------------------------------------------------
 */

/**
 * The state transitions of one rendered fiber, held until the commit's events
 * have been emitted.
 *
 * `./state.js` is called *after* the render batch rather than inside the
 * traversal so that a transition's sequence number follows the render it sits
 * inside; the alternative put children before parents in a raw event log
 * ordered by sequence. Only summaries travel in here — `./fiber-diff.js` has
 * already reduced every value to a type and a bounded preview — so holding
 * them for the length of one commit retains nothing of the application's data.
 */
interface PendingTransitions {
  /** The component the transitions belong to. */
  readonly component: string;
  /** The fiber's identity, when one was resolved. */
  readonly fiberId: number | undefined;
  /** The render span the transitions were observed in. */
  readonly renderSpanId: string;
  /** The render's own start, in epoch milliseconds. */
  readonly startTime: number;
  /** The fiber's own state-bearing hooks that changed. */
  readonly hookChanges: readonly HookChange[];
  /** The consumed context values that changed, when context was readable. */
  readonly contextChanges: readonly ContextChange[] | undefined;
}

/** What one commit's traversal produced. */
interface CommitTally {
  /** The render drafts, in traversal order, bounded by the per-commit cap. */
  readonly drafts: EventDraft[];
  /** The transitions to hand to `./state.js` once the drafts are away. */
  readonly transitions: PendingTransitions[];
  /** How many composite fibers rendered, before the cap was applied. */
  readonly renderedFibers: number;
  /** How many of those were mounts, for the commit's phase summary. */
  readonly mounts: number;
  /** Whether the cap stopped the list short. */
  readonly truncated: boolean;
}

/** The ancestry of one rendered fiber, from a single upward walk. */
interface Ancestry {
  /** Ancestor component names, nearest first, bounded by the owner cap. */
  readonly ownerChain: string[];
  /** The nearest composite ancestor's fiber id, when one was resolved. */
  readonly parentFiberId: number | undefined;
}

/** The profiling fields React writes on a fiber, read as untrusted values. */
interface ProfiledFiber {
  /** Render time including descendants; present in development builds. */
  readonly actualDuration?: unknown;
  /** Render start on the document's monotonic clock, or `-1`. */
  readonly actualStartTime?: unknown;
}

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * One page document's worth. Every field is cleared by {@link detachReact},
 * because AAP 0.5.1 requires a cleared hook to be disabled rather than idled:
 * afterwards this module holds no subscription, no counts and no reference
 * into the developer's fiber tree.
 * ---------------------------------------------------------------------------
 */

/** Whether the commit handlers are subscribed right now. */
let attached = false;

/**
 * The function `instrument()` returned, kept so the handlers can be released.
 *
 * Typed as a plain callable rather than as bippy's `Unsubscribe` (which also
 * declares `Symbol.dispose`) because calling it is the entire use, and the
 * narrower type cannot be mistaken for a disposable this module manages.
 */
let unsubscribe: (() => void) | undefined;

/**
 * Renders per component name, for the current capture.
 *
 * Scoped to the capture by {@link resetReactCounters}, which `./agent.js`
 * calls when one begins: the `renderCount` attribute means "renders in this
 * capture", which is what the `render_count` metric reports (AAP 0.2.3). A
 * count carried over from a previous capture would be added to a number the
 * developer is reading as this interaction's.
 */
const componentRenderCounts = new Map<string, number>();

/**
 * The last committed root, held weakly where the host supports it.
 *
 * {@link snapshotComponentTree} needs a root to walk, and the only place one
 * is handed to this module is the commit callback. A `WeakRef` keeps a stopped
 * capture — or a torn-down root the page has forgotten — from being retained
 * by the agent; a host without `WeakRef` falls back to
 * {@link retainedRootStrong}, which {@link detachReact} clears, so the
 * guarantee holds either way.
 */
let retainedRootRef: WeakRef<FiberRoot> | undefined;

/** The strong fallback for a host with no `WeakRef`. */
let retainedRootStrong: FiberRoot | undefined;

/** Commits observed since the last reset. */
let commitCount = 0;

/** `render` events emitted since the last reset. */
let renderEventCount = 0;

/** Commits cut by the per-commit bound since the last reset. */
let truncatedCommitCount = 0;

/** Swallowed failures since the last reset. */
let failureCount = 0;

/*
 * ---------------------------------------------------------------------------
 * Value guards
 *
 * Every number and string below comes from a fiber, which is to say from the
 * developer's React — or, in a test, from a hand-built object. None of them is
 * trusted: the event schema rejects a non-finite number and bounds every
 * string, and an event rejected at ingest is evidence lost for no reason.
 * ---------------------------------------------------------------------------
 */

/** A finite number, or `undefined`. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A duration as an event may carry it: finite and non-negative.
 *
 * React writes `actualDuration` only when its profiling timer is enabled, and
 * initialises the field to `-1` before a fiber has been worked on, so both
 * absence and a negative reading are ordinary rather than exceptional. Either
 * yields `undefined` here and a duration of `0` on the event — a number that
 * says "not measured" without claiming a measurement.
 */
function durationValue(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric === undefined || numeric < 0 ? undefined : numeric;
}

/** A non-empty string, trimmed of nothing and cut to `limit` code units. */
function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * A member of the catalog's phase vocabulary, or `undefined`.
 *
 * bippy's traversal phase is `mount | unmount | update` while the product's
 * `RENDER_PHASES` is `mount | update` — deliberately, since an unmounted fiber
 * renders nothing and so has no render to phase. A phase outside the
 * vocabulary is therefore not a failure to count but a fiber to skip.
 */
function asRenderPhase(value: unknown): RenderPhase | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return RENDER_PHASES.find((phase) => phase === value);
}

/**
 * The fiber's identity, or `undefined` when bippy could not assign one.
 *
 * `getFiberId` keeps its mapping in a `WeakMap` of its own and writes nothing
 * to the fiber, so asking is free of side effects on the developer's tree. It
 * throws only for a value that is not a fiber at all, which is why the call is
 * guarded rather than assumed.
 */
function fiberIdOf(fiber: Fiber): number | undefined {
  try {
    const id = getFiberId(fiber);
    return typeof id === 'number' && Number.isInteger(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name a developer would recognise for the component that rendered.
 *
 * `elementType` is asked first and the fiber second, and the order is the
 * interesting part. For a `memo` or `forwardRef` component React puts the
 * wrapper on `elementType` and the inner function on `type`: asking the fiber
 * resolves to the inner function's name (`LeafImpl`), while asking
 * `elementType` returns the `displayName` the developer set on the wrapper
 * (`Leaf`) — the name React DevTools shows and the name in their source.
 * Where no `displayName` was set, bippy's own resolution falls through to the
 * inner function anyway, so the first question can only improve the answer.
 *
 * Never `fiber.type.toString()`: that is the component's source text, which is
 * both unbounded and the developer's code rather than a label.
 */
function componentNameOf(fiber: Fiber): string {
  try {
    const elementType: unknown = (fiber as { elementType?: unknown }).elementType;
    const fromElement = boundedString(getDisplayName(elementType), MAX_COMPONENT_NAME_LENGTH);
    if (fromElement !== undefined) {
      return fromElement;
    }
    return boundedString(getDisplayName(fiber), MAX_COMPONENT_NAME_LENGTH) ?? ANONYMOUS_COMPONENT;
  } catch {
    return ANONYMOUS_COMPONENT;
  }
}

/**
 * The React `key` of a fiber, when it has a usable one.
 *
 * A numeric key arrives as a string on a fiber, so no coercion is needed here;
 * the bound is applied because the value is application-authored.
 */
function keyOf(fiber: Fiber): string | undefined {
  try {
    return boundedString(fiber.key, MAX_KEY_LENGTH);
  } catch {
    return undefined;
  }
}

/**
 * The fiber's cost excluding its descendants, in milliseconds.
 *
 * React reports `actualDuration` inclusive of children, so the self time is
 * that duration minus the direct children's — the calculation React DevTools
 * performs for the same reason, and one a consumer cannot perform for itself
 * because the children it would need may have been filtered out of the event
 * stream as host fibers or by the per-commit bound.
 *
 * Clamped at zero: the subtraction is over values React wrote at different
 * points of one commit, and a reader must never be shown a negative cost.
 * `undefined` when the fiber carries no usable duration at all, which keeps
 * the attribute absent rather than inventing a zero.
 */
function selfTimeOf(fiber: Fiber, actualDuration: number | undefined): number | undefined {
  if (actualDuration === undefined) {
    return undefined;
  }
  try {
    let childTotal = 0;
    let child: Fiber | null = fiber.child;
    while (child !== null) {
      childTotal += durationValue((child as ProfiledFiber).actualDuration) ?? 0;
      child = child.sibling;
    }
    const self = actualDuration - childTotal;
    return self > 0 ? self : 0;
  } catch {
    return actualDuration;
  }
}

/**
 * The ancestor component names and nearest composite parent of one fiber, from
 * a single upward walk.
 *
 * Both answers come from one traversal because they are the same walk asked
 * twice: the chain is the names, the parent id is the first entry's identity.
 * The walk stops as soon as the chain is full — `traverseFiber` treats a
 * `true` from the selector as "stop here" — so a deep tree costs
 * {@link MAX_OWNER_CHAIN} steps rather than its depth. Host fibers are stepped
 * over without being named: a `<div>` between two components is not a level of
 * the component tree.
 */
function ancestryOf(fiber: Fiber): Ancestry {
  const ownerChain: string[] = [];
  let parentFiberId: number | undefined;

  try {
    traverseFiber(
      fiber,
      (node) => {
        if (node === fiber || !isCompositeFiber(node)) {
          return false;
        }
        if (ownerChain.length === 0) {
          parentFiberId = fiberIdOf(node);
        }
        ownerChain.push(componentNameOf(node));
        return ownerChain.length >= MAX_OWNER_CHAIN;
      },
      true,
    );
  } catch {
    // A malformed `return` chain costs this fiber its ancestry and nothing
    // else; the render event is still worth emitting without it.
  }

  return { ownerChain, parentFiberId };
}

/**
 * Which root committed, in a form a reader can tell two roots apart by.
 *
 * Taken from the root's own container element — its `id` where it has one,
 * since that is what the developer wrote, and its tag name otherwise. Absent
 * when neither can be read, because an invented root name would group two
 * roots that are not the same.
 */
function rootNameOf(root: FiberRoot): string | undefined {
  try {
    const container: unknown = (root as { containerInfo?: unknown }).containerInfo;
    if (container === null || typeof container !== 'object') {
      return undefined;
    }
    const id = boundedString((container as { id?: unknown }).id, MAX_ROOT_NAME_LENGTH);
    if (id !== undefined) {
      return `#${id}`;
    }
    const tagName = boundedString(
      (container as { tagName?: unknown }).tagName,
      MAX_ROOT_NAME_LENGTH,
    );
    return tagName === undefined ? undefined : tagName.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Retain the committed root for {@link snapshotComponentTree}. */
function retainRoot(root: FiberRoot): void {
  if (typeof WeakRef === 'function') {
    retainedRootRef = new WeakRef(root);
    retainedRootStrong = undefined;
    return;
  }
  retainedRootStrong = root;
  retainedRootRef = undefined;
}

/** The retained root, if one was observed and has not been collected. */
function retainedRoot(): FiberRoot | undefined {
  if (retainedRootRef !== undefined) {
    return retainedRootRef.deref();
  }
  return retainedRootStrong;
}

/** Forget the retained root, so a stopped capture holds no fiber tree. */
function releaseRoot(): void {
  retainedRootRef = undefined;
  retainedRootStrong = undefined;
}

/**
 * Bump and read the per-capture count for one component.
 *
 * Incremented before the event is built, so the first render of a component in
 * a capture reports `1` rather than `0` — the number a developer counts the
 * same way.
 */
function nextRenderCount(component: string): number {
  const next = (componentRenderCounts.get(component) ?? 0) + 1;
  componentRenderCounts.set(component, next);
  return next;
}

/**
 * Merge the attribution's own attributes beneath the event's.
 *
 * {@link EventContext.attributes} carries the lineage annotation
 * `./continuation.js` wrote — `lineage`, and the ambiguity flags where an
 * attribution was a best candidate rather than a certainty — and
 * `./interaction.js`'s contract is that a producer merges it into its own bag.
 * Dropping it costs the panel the dashed edge that says so. The event's own
 * keys win, because a description of the render may never be overwritten by a
 * description of how it was attributed.
 */
function mergeLineage(target: Record<string, unknown>, source: EventContext['attributes']): void {
  if (source === undefined || source === null || typeof source !== 'object') {
    return;
  }
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key in target) {
      continue;
    }
    target[key] = source[key];
  }
}

/*
 * ---------------------------------------------------------------------------
 * Draft assembly
 * ---------------------------------------------------------------------------
 */

/**
 * The attribute bag for one rendered fiber.
 *
 * Three decisions are recorded here because each looks like an oversight to a
 * reader who does not know the contract:
 *
 * - **`trigger` is written only for an update.** See the module
 *   documentation: a mount's `unknown` classification is an artefact of having
 *   no previous fiber, and emitting it would inflate
 *   `render_trigger_unknown_count` with the one case nobody needs explained
 *   (AAP 0.2.3). This is the single most consequential line in the file for
 *   the excessive-render acceptance test.
 * - **`changedProps` is the plain key list.** `./fiber-diff.js` also produces
 *   the full transitions, with a summary of each end, and they are
 *   deliberately not lifted onto the render event: the names are what
 *   `../aggregate/renders.ts` and the `renderTable` read, and the values
 *   belong to the `state` events `./state.js` emits, where a single privacy
 *   boundary governs them.
 * - **Every absent field is omitted rather than written as `null`.** Absence
 *   is how this product says "not observed", and the aggregates read it that
 *   way.
 */
function buildRenderAttributes(
  fiber: Fiber,
  phase: RenderPhase,
  component: string,
  context: EventContext,
  actualDuration: number | undefined,
  diff: FiberDiff,
  ancestry: Ancestry,
  fiberId: number | undefined,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    [KEY_COMPONENT]: component,
    [KEY_PHASE]: phase,
    [KEY_RENDER_COUNT]: nextRenderCount(component),
    [KEY_CHANGED_PROPS]: [...diff.changedProps],
  };

  if (phase === 'update') {
    // The classification is `./fiber-diff.js`'s; the annotation on the next
    // line is the compile-time check that its vocabulary is still the
    // catalog's, since the two are declared independently.
    const trigger: RenderTrigger = diff.trigger;
    attributes[KEY_TRIGGER] = trigger;
  }

  if (actualDuration !== undefined) {
    attributes[KEY_ACTUAL_DURATION] = actualDuration;
    const selfTime = selfTimeOf(fiber, actualDuration);
    if (selfTime !== undefined) {
      attributes[KEY_SELF_TIME] = selfTime;
    }
  }

  if (ancestry.ownerChain.length > 0) {
    attributes[KEY_OWNER_CHAIN] = ancestry.ownerChain;
  }
  if (fiberId !== undefined) {
    attributes[KEY_FIBER_ID] = fiberId;
  }
  if (ancestry.parentFiberId !== undefined) {
    attributes[KEY_PARENT_FIBER_ID] = ancestry.parentFiberId;
  }

  const key = keyOf(fiber);
  if (key !== undefined) {
    attributes[KEY_ELEMENT_KEY] = key;
  }

  mergeLineage(attributes, context.attributes);

  return attributes;
}

/**
 * One commit's traversal: a draft per rendered composite fiber, and the state
 * transitions to hand on afterwards.
 *
 * Every per-fiber body is inside its own `try`, which is the point of the loop
 * being written this way: a component whose props throw from a getter, or a
 * fiber from a renderer this module has not seen, costs itself and is counted,
 * while the rest of the commit is still observed. A commit is the unit a
 * developer reads, and losing all of it to one bad fiber would be the failure
 * mode hardest to explain.
 */
function collectRenders(
  root: FiberRoot,
  context: EventContext,
  commitSpanId: string,
  commitStart: number,
): CommitTally {
  const drafts: EventDraft[] = [];
  const transitions: PendingTransitions[] = [];
  let renderedFibers = 0;
  let mounts = 0;
  let truncated = false;

  traverseRenderedFibers(root, (fiber, rawPhase) => {
    try {
      if (!isCompositeFiber(fiber)) {
        // Host fibers — the DOM nodes React committed — are not components and
        // would swamp the render table many times over.
        return;
      }
      const phase = asRenderPhase(rawPhase);
      if (phase === undefined) {
        // `unmount` and anything else outside the catalog's vocabulary: a
        // fiber that rendered nothing has no render to report.
        return;
      }

      renderedFibers += 1;
      if (phase === 'mount') {
        mounts += 1;
      }

      if (drafts.length >= MAX_RENDERS_PER_COMMIT) {
        // Counting continues past the bound so `renderedFiberCount` is the
        // true total rather than "at least the cap", which is the difference
        // between a reader concluding "500 components rendered" and "8 000
        // did, and 500 are listed".
        truncated = true;
        return;
      }

      const component = componentNameOf(fiber);
      const fiberId = fiberIdOf(fiber);
      const actualDuration = durationValue((fiber as ProfiledFiber).actualDuration);
      const relativeStart = finiteNumber((fiber as ProfiledFiber).actualStartTime);
      const startTime =
        relativeStart !== undefined && relativeStart > 0 ? toEpochMs(relativeStart) : commitStart;
      const diff = analyzeFiber(fiber);
      const ancestry = ancestryOf(fiber);
      const spanId = newSpanId();

      drafts.push({
        traceId: context.traceId,
        spanId,
        // The commit, not the interaction: a render nests inside the commit
        // that performed it, and the commit nests under the interaction. That
        // is what makes the timeline's band-inside-band reading correct.
        parentSpanId: commitSpanId,
        kind: RENDER_KIND,
        name: component,
        startTime,
        duration: actualDuration ?? 0,
        attributes: buildRenderAttributes(
          fiber,
          phase,
          component,
          context,
          actualDuration,
          diff,
          ancestry,
          fiberId,
        ),
        status: OK_STATUS,
      });

      if (diff.hookChanges.length > 0 || diff.contextChanges.length > 0) {
        transitions.push({
          component,
          fiberId,
          renderSpanId: spanId,
          startTime,
          hookChanges: diff.hookChanges,
          // Present when the dimension was read — an empty list then means
          // "nothing changed" — and absent when it could not be evaluated,
          // which is the distinction `./state.js` documents on its input.
          contextChanges:
            diff.contextChanges.length > 0 || diff.evaluable.context
              ? diff.contextChanges
              : undefined,
        });
      }
    } catch {
      failureCount += 1;
    }
  });

  return { drafts, transitions, renderedFibers, mounts, truncated };
}

/**
 * The commit event: the parent span of the renders collected under it.
 *
 * Built **after** the traversal so `renderCount` is the exact number of render
 * events the commit produced. It still leads the emitted batch, so its
 * sequence number precedes its children's and a raw event log ordered by
 * sequence reads parent-first.
 *
 * `startTime` is the root fiber's own render start rather than the instant this
 * callback ran: React invokes the hook *after* the render phase, so a
 * wall-clock reading here would place the commit after the renders it
 * contains, and the timeline would draw children starting before their parent.
 */
function buildCommitDraft(
  root: FiberRoot,
  rendererId: number | undefined,
  priority: unknown,
  context: EventContext,
  commitSpanId: string,
  commitStart: number,
  tally: CommitTally,
): EventDraft {
  const rootFiber: Fiber | undefined = readRootFiber(root);
  const rootDuration =
    rootFiber === undefined
      ? undefined
      : durationValue((rootFiber as ProfiledFiber).actualDuration);
  const rootStart =
    rootFiber === undefined
      ? undefined
      : finiteNumber((rootFiber as ProfiledFiber).actualStartTime);

  const attributes: Record<string, unknown> = {
    [KEY_COMMIT_RENDER_COUNT]: tally.drafts.length,
    [KEY_RENDERED_FIBER_COUNT]: tally.renderedFibers,
  };

  if (tally.renderedFibers > 0) {
    // A commit in which every rendered fiber was a mount is a mount; one that
    // updated anything is an update. A commit that rendered nothing — React
    // committing effects only — gets no phase, because neither value would be
    // true of it. Annotated so the summary is held to the same vocabulary as a
    // render's own phase.
    const phaseSummary: RenderPhase = tally.mounts === tally.renderedFibers ? 'mount' : 'update';
    attributes[KEY_COMMIT_PHASE] = phaseSummary;
  }
  if (rendererId !== undefined) {
    attributes[KEY_RENDERER_ID] = rendererId;
  }
  const rootName = rootNameOf(root);
  if (rootName !== undefined) {
    attributes[KEY_ROOT_NAME] = rootName;
  }
  if (tally.truncated) {
    attributes[KEY_TRUNCATED] = true;
  }
  const priorityValue = finiteNumber(priority);
  if (priorityValue !== undefined) {
    attributes[KEY_PRIORITY] = priorityValue;
  }

  mergeLineage(attributes, context.attributes);

  const draft: EventDraft = {
    traceId: context.traceId,
    spanId: commitSpanId,
    kind: COMMIT_KIND,
    name: COMMIT_EVENT_NAME,
    startTime: rootStart !== undefined && rootStart > 0 ? toEpochMs(rootStart) : commitStart,
    // React's own measurement of the commit where it made one; otherwise the
    // time this module spent observing it, which is an honest lower bound and
    // is never negative.
    duration: rootDuration ?? Math.max(0, nowEpochMs() - commitStart),
    attributes,
    status: OK_STATUS,
  };

  if (context.parentSpanId !== undefined) {
    draft.parentSpanId = context.parentSpanId;
  }

  return draft;
}

/**
 * The root's current fiber, read defensively.
 *
 * A `FiberRoot` from React always has one; a hand-built root in a test, or a
 * root mid-teardown, may not, and the commit event is still worth emitting
 * without the root's timings.
 */
function readRootFiber(root: FiberRoot): Fiber | undefined {
  try {
    const current: unknown = (root as { current?: unknown }).current;
    return current !== null && typeof current === 'object' ? (current as Fiber) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hand the collected transitions to `./state.js`, after the render batch.
 *
 * One call per fiber that had changes, each self-guarding: `./state.js`
 * returns before it allocates when state capture is not armed, validates every
 * field on arrival and never throws. The trigger reference it is given is the
 * interaction (or settled request) this commit was attributed to — opaque to
 * that module by contract, because the attribution is this one's to make.
 */
function flushTransitions(context: EventContext, pending: readonly PendingTransitions[]): void {
  for (const entry of pending) {
    try {
      const input: RecordTransitionsInput = {
        component: entry.component,
        traceId: context.traceId,
        parentSpanId: entry.renderSpanId,
        startTime: entry.startTime,
        hookChanges: entry.hookChanges,
      };
      if (entry.fiberId !== undefined) {
        input.fiberId = entry.fiberId;
      }
      if (entry.contextChanges !== undefined) {
        input.contextChanges = entry.contextChanges;
      }
      if (context.parentSpanId !== undefined) {
        input.triggerSpanId = context.parentSpanId;
      }
      if (context.attributes !== undefined) {
        input.lineageAttributes = context.attributes;
      }
      recordStateTransitions(input);
    } catch {
      failureCount += 1;
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Hook handlers
 *
 * The three callbacks bippy dispatches to. Each is total: a body that throws
 * here would throw inside React's commit phase, which is the one thing this
 * product may never do to a developer's application.
 * ---------------------------------------------------------------------------
 */

/**
 * One React commit: emit the commit event and a render event per composite
 * fiber that rendered.
 *
 * The order of the four steps is the contract:
 *
 * 1. Retain the root, so a snapshot taken later has a tree to walk even if
 *    this commit rendered nothing.
 * 2. Resolve the trace **once**, before any fiber is visited. Asking per fiber
 *    would let an interaction window close mid-traversal and split one commit
 *    across two traces.
 * 3. Traverse, building drafts under the per-commit bound.
 * 4. Emit the commit draft and the render drafts in one batch, then hand the
 *    state transitions on.
 *
 * @param rendererId React's id for the renderer that committed.
 * @param root The fiber root that committed.
 * @param priority The scheduling priority React reported, when it reported
 * one. Typed as `unknown` because the value is informational and the hook's
 * own signature admits `void`.
 */
function onCommitFiberRoot(rendererId: number, root: FiberRoot, priority: unknown): void {
  try {
    if (!attached) {
      // A batch already in flight when the hooks were cleared must produce
      // nothing: AAP 0.5.1 asks for a disabled hook, not an idle one.
      return;
    }

    commitCount += 1;
    retainRoot(root);

    const context = resolveEventContext();
    const commitSpanId = newSpanId();
    const commitStart = nowEpochMs();

    const tally = collectRenders(root, context, commitSpanId, commitStart);
    const commitDraft = buildCommitDraft(
      root,
      finiteNumber(rendererId),
      priority,
      context,
      commitSpanId,
      commitStart,
      tally,
    );

    renderEventCount += tally.drafts.length;
    if (tally.truncated) {
      truncatedCommitCount += 1;
    }

    // One hand-off: one capture gate, consecutive sequence numbers for the
    // whole commit, and the commit event ahead of the renders it parents.
    emitMany([commitDraft, ...tally.drafts]);

    flushTransitions(context, tally.transitions);
  } catch {
    failureCount += 1;
  }
}

/**
 * React's post-commit callback: deliberately does nothing.
 *
 * It is registered so the subscription covers React's whole commit lifecycle
 * and so a reader of {@link attachReact} can see which callbacks exist, but it
 * has no work to do. The tempting use — refining the commit's duration with
 * the root's effect and passive-effect timings, which React fills in by the
 * time this runs — would mean holding the commit event back until this fires,
 * and it does not always fire: a root torn down before passive effects flush
 * would leave that commit's renders parented to a span that was never emitted.
 * A commit event that is certainly present and slightly narrower than the
 * truth beats an exact one that sometimes never arrives.
 */
function onPostCommitFiberRoot(): void {
  /* Intentionally empty; see the documentation above. */
}

/**
 * One unmounted fiber: never an event, and one cheap piece of housekeeping.
 *
 * A list unmounting produces an event per row — hundreds of them, describing
 * work that did not happen — so nothing is emitted here. What the callback is
 * good for is releasing the retained root when the fiber being unmounted *is*
 * that root's current fiber, which is React tearing the root down: a snapshot
 * afterwards should report that there is no tree rather than walk one that no
 * longer exists.
 *
 * Render counts are **not** decremented. `renderCount` means "renders during
 * this capture", and a component that rendered forty times and then unmounted
 * rendered forty times; erasing that would remove exactly the evidence an
 * excessive-render question is about.
 */
function onCommitFiberUnmount(_rendererId: number, fiber: Fiber): void {
  try {
    const root = retainedRoot();
    if (root === undefined) {
      return;
    }
    if (readRootFiber(root) === fiber) {
      releaseRoot();
    }
  } catch {
    failureCount += 1;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Component-tree snapshot
 *
 * An iterative walk, never a recursive one: the tree being walked belongs to
 * the developer's application, its depth is theirs to choose, and a stack
 * overflow inside a capture would be this module crashing their page.
 * ---------------------------------------------------------------------------
 */

/**
 * How many fibers one snapshot may visit per node it is allowed to emit.
 *
 * Host fibers are stepped over rather than emitted, so a walk legitimately
 * visits several times more fibers than it reports — a card of six DOM
 * elements around one component, say. Sixteen is generous for that ratio and
 * still bounds the walk absolutely, which is what keeps a DOM-heavy page from
 * turning a snapshot into the expensive part of stopping a capture.
 */
const MAX_TREE_VISITS_PER_NODE = 16;

/** What the synthetic container node is called when the root has no name. */
const DEFAULT_ROOT_LABEL = 'ReactRoot';

/** One fiber waiting to be visited, with where its node belongs. */
interface TreeFrame {
  /** The fiber to visit. */
  readonly fiber: Fiber;
  /** The node its node becomes a child of. */
  readonly parent: ComponentTreeNode;
  /** Component depth of the node it would become; the container root is 0. */
  readonly depth: number;
}

/**
 * Whether a fiber is a component, or `undefined` when the question could not
 * be answered.
 *
 * `isCompositeFiber` reads the fiber's work tag through the renderer's tag
 * map, which throws for a value that is not a fiber of a renderer bippy knows.
 * The three-valued answer keeps "a host node" apart from "not something this
 * walk can interpret", and the walk treats them differently: the first has
 * children worth stepping into, the second has nothing that can be trusted.
 */
function isComposite(fiber: Fiber): boolean | undefined {
  try {
    return isCompositeFiber(fiber);
  } catch {
    return undefined;
  }
}

/** A requested bound, defaulted and sanitised to a non-negative integer. */
function boundedCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

/** A composite fiber as a tree node, carrying nothing but its identity. */
function makeTreeNode(fiber: Fiber): ComponentTreeNode {
  const name = componentNameOf(fiber);
  const node: ComponentTreeNode = {
    name,
    renderCount: componentRenderCounts.get(name) ?? 0,
    children: [],
  };
  const fiberId = fiberIdOf(fiber);
  if (fiberId !== undefined) {
    node.fiberId = fiberId;
  }
  const key = keyOf(fiber);
  if (key !== undefined) {
    node.key = key;
  }
  return node;
}

/**
 * Queue a fiber's children, in fiber order.
 *
 * Pushed in reverse because the frames are a stack, which is what makes the
 * emitted children read in the order React holds them. The sibling scan is
 * bounded by the node budget: a list longer than the whole snapshot may emit
 * cannot contribute more nodes, so scanning past that point could only cost
 * time, and the cut is recorded on the parent.
 */
function queueChildren(
  fiber: Fiber,
  parent: ComponentTreeNode,
  depth: number,
  frames: TreeFrame[],
  siblingBudget: number,
): void {
  const children: Fiber[] = [];
  let child: Fiber | null = fiber.child;
  while (child !== null && children.length < siblingBudget) {
    children.push(child);
    child = child.sibling;
  }
  if (child !== null) {
    parent.truncated = true;
  }
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const entry = children[index];
    if (entry !== undefined) {
      frames.push({ fiber: entry, parent, depth });
    }
  }
}

/**
 * Walk the root's fiber tree into a bounded tree of component nodes.
 *
 * The returned node is a synthetic container for the root itself — named from
 * its container element, so two roots on one page are distinguishable — and
 * its children are the application's top-level components. A container rather
 * than the first component found, because a root may render several top-level
 * components and picking one would silently drop the rest.
 *
 * Every fiber is visited at most once (`seen`), which costs a set and buys
 * immunity to a malformed or hand-built structure whose `child`/`sibling`
 * links form a cycle; React's own trees never do, and a snapshot that looped
 * on one would hang the page.
 */
function buildTree(
  rootFiber: Fiber,
  root: FiberRoot,
  maxNodes: number,
  maxDepth: number,
): ComponentTreeNode {
  const container: ComponentTreeNode = {
    name: rootNameOf(root) ?? DEFAULT_ROOT_LABEL,
    renderCount: 0,
    children: [],
  };
  const rootFiberId = fiberIdOf(rootFiber);
  if (rootFiberId !== undefined) {
    container.fiberId = rootFiberId;
  }

  const frames: TreeFrame[] = [];
  const seen = new Set<Fiber>([rootFiber]);
  let visits = 0;
  let nodeCount = 1;
  const maxVisits = maxNodes * MAX_TREE_VISITS_PER_NODE;

  queueChildren(rootFiber, container, 1, frames, maxNodes);

  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame === undefined) {
      break;
    }

    visits += 1;
    if (visits > maxVisits) {
      frame.parent.truncated = true;
      break;
    }
    if (seen.has(frame.fiber)) {
      continue;
    }
    seen.add(frame.fiber);

    const composite = isComposite(frame.fiber);
    if (composite === undefined) {
      // Not a fiber this renderer understands: drop it rather than guess
      // whether it is a component or a host node.
      continue;
    }

    if (!composite) {
      // A host fiber is not a level of the component tree: its children
      // belong to the same parent, at the same component depth.
      queueChildren(frame.fiber, frame.parent, frame.depth, frames, maxNodes);
      continue;
    }

    if (nodeCount >= maxNodes || frame.depth > maxDepth) {
      frame.parent.truncated = true;
      continue;
    }

    const node = makeTreeNode(frame.fiber);
    frame.parent.children.push(node);
    nodeCount += 1;
    queueChildren(frame.fiber, node, frame.depth + 1, frames, maxNodes);
  }

  return container;
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Subscribe to React's commit hook.
 *
 * Called by `./agent.js` when an `agent.config` arms the React hook. Does
 * **not** install the DevTools hook — that happened at `document_start`,
 * before React loaded, and is the precondition this module cannot create for
 * itself (see the module documentation).
 *
 * Idempotent: a second call while attached returns without touching the
 * subscription, which matters because a service-worker reconnect re-sends the
 * configuration mid-capture and re-subscribing would double every event.
 *
 * Cannot throw. A page with no hook, or one whose hook belongs to the real
 * React DevTools extension in a shape bippy declines to patch, leaves this
 * module detached and the agent's other hooks unaffected.
 */
export function attachReact(): void {
  try {
    if (attached) {
      return;
    }

    // Published before `instrument` returns, so a commit dispatched during
    // registration — React can commit at any moment — finds the module
    // attached rather than dropping its batch.
    attached = true;

    unsubscribe = instrument({
      name: 'debuggen',
      onCommitFiberRoot,
      onPostCommitFiberRoot,
      onCommitFiberUnmount,
    });
  } catch {
    // Registration failed, so no handler can fire: leave no claim behind.
    attached = false;
    unsubscribe = undefined;
    failureCount += 1;
  }
}

/**
 * Release the subscription and forget everything this capture observed.
 *
 * Calls the function `instrument()` returned, which removes exactly the
 * handlers {@link attachReact} registered (AAP 0.5.1), then clears the render
 * counts, the retained root and the counters. Afterwards a commit costs one
 * comparison and this module holds no observation of the developer's page.
 *
 * The DevTools hook itself is left installed, on purpose: React is already
 * attached to it and the real React DevTools extension may be using it too, so
 * removing it would break both. What the developer removes by ending a session
 * is the *capture*, and an installed hook with no subscribers observes nothing.
 *
 * Safe to call when already detached, and cannot throw.
 */
export function detachReact(): void {
  const release = unsubscribe;

  // Cleared first, so a commit delivered while the handlers are being removed
  // finds the module detached and returns.
  attached = false;
  unsubscribe = undefined;

  try {
    release?.();
  } catch {
    // A hook that throws on unsubscribe has already stopped dispatching to
    // these handlers; the reference is dropped either way.
    failureCount += 1;
  }

  componentRenderCounts.clear();
  releaseRoot();
  commitCount = 0;
  renderEventCount = 0;
  truncatedCommitCount = 0;
  failureCount = 0;
}

/**
 * Whether the commit handlers are subscribed right now.
 *
 * `./agent.js` reports it in the readiness and status frames the DevTools
 * panel shows. "Attached" is this folder's uniform vocabulary for an armed
 * hook.
 */
export function isReactAttached(): boolean {
  return attached;
}

/**
 * Whether a React renderer has registered with the DevTools hook on this page.
 *
 * Callable while dormant, which is the point: `./agent.js` reports it in the
 * `agent.ready` frame so the service can tell a page that has React from one
 * that does not, and — with the agent's own record of whether the hook was
 * installed before React — offer a one-click reload when the agent arrived too
 * late to be registered with (AAP 0.5.5).
 *
 * Two conditions, both required. The hook must exist, and it must have at
 * least one renderer: an installed hook with no renderers is exactly the
 * "agent arrived first, React has not loaded yet" state, and reporting React
 * as present there would make the service skip a reload the developer needs.
 *
 * The order of the two calls is load-bearing. `hasRDTHook()` is asked first
 * because bippy's `getRDTHook()` *installs* a hook when none is present, and a
 * detection routine must not change the page it is inspecting.
 */
export function detectReact(): boolean {
  try {
    if (!hasRDTHook()) {
      return false;
    }
    const renderers = getRDTHook()?.renderers;
    return (renderers?.size ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * The component tree of the last committed root, as JSON-safe nodes.
 *
 * `./agent.js` emits this as a `log` event named `react.component-tree` when a
 * capture stops, and `../aggregate/renders.ts` prefers it over the tree it can
 * reconstruct from owner chains — a snapshot is the structure React actually
 * held, while a reconstruction covers only the components that rendered.
 *
 * Composite fibers become nodes and host fibers are stepped over, so the
 * result is a component tree rather than a DOM tree. Nothing but the fields of
 * {@link ComponentTreeNode} is carried: no props, no state, no DOM node, no
 * fiber. The walk is iterative and bounded on both axes, so neither a deep
 * tree nor a malformed one can turn a snapshot into an unbounded traversal.
 *
 * @param options `maxNodes` (default {@link MAX_TREE_NODES}) and `maxDepth`
 * (default {@link MAX_TREE_DEPTH}) bound the result; a node where a bound
 * stopped the walk carries `truncated: true`.
 * @returns The tree, or `undefined` when no commit has been observed, the
 * root has been collected or torn down, or the module is detached.
 */
export function snapshotComponentTree(options?: {
  maxNodes?: number;
  maxDepth?: number;
}): ComponentTreeNode | undefined {
  try {
    const root = retainedRoot();
    if (root === undefined) {
      return undefined;
    }
    const rootFiber = readRootFiber(root);
    if (rootFiber === undefined) {
      return undefined;
    }

    const maxNodes = boundedCount(options?.maxNodes, MAX_TREE_NODES);
    const maxDepth = boundedCount(options?.maxDepth, MAX_TREE_DEPTH);
    if (maxNodes === 0 || maxDepth === 0) {
      return undefined;
    }

    return buildTree(rootFiber, root, maxNodes, maxDepth);
  } catch {
    failureCount += 1;
    return undefined;
  }
}

/**
 * Start the per-component render counts over for a new capture.
 *
 * Called by `./agent.js` when a capture begins, which is what scopes
 * `renderCount` — and therefore the `render_count` metric — to the capture
 * rather than to the document's lifetime. The counters
 * {@link getReactStats} reports are reset with it, so a diagnostics reader
 * sees this capture's numbers and not the last one's.
 *
 * Deliberately does **not** touch the subscription or the retained root: a
 * capture beginning is not a reason to stop observing, and the tree React
 * currently holds is still the tree.
 *
 * Cannot throw.
 */
export function resetReactCounters(): void {
  componentRenderCounts.clear();
  commitCount = 0;
  renderEventCount = 0;
  truncatedCommitCount = 0;
  failureCount = 0;
}

/**
 * A snapshot of what this module has done since the last reset.
 *
 * Four module-scope numbers and one fresh object; nothing is traversed, so a
 * status view may call it as often as it likes.
 */
export function getReactStats(): ReactStats {
  return {
    commits: commitCount,
    renders: renderEventCount,
    truncatedCommits: truncatedCommitCount,
    failures: failureCount,
  };
}
