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
 * Which of the two a render is gets decided **per fiber**, from whether React
 * holds a previous fiber for it: no `alternate` is a `mount`, an `alternate`
 * an `update`. That is deliberately not what bippy's traversal did. It diffed
 * each root against the last fiber tree it had seen for that root, so the
 * first commit observed after the hook was subscribed was walked as a whole
 * *mount pass* — a capture armed on an already-rendered page opened with a
 * baseline commit that reported updates as mounts and, by the rule above,
 * withheld every `trigger`, which is exactly the evidence an excessive-render
 * question is asked about. The first commit this module observes now reports
 * the update it actually is, and a fiber React has genuinely just created is
 * still a mount.
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
 * returned"), and it is complete: after a detach this module observes nothing,
 * holds no counts and no fiber tree, and a commit costs one comparison.
 *
 * The one thing a detach may *not* do is throw away the means of finishing.
 * `instrument()`'s release is the only handle that can remove the handlers it
 * installed, so a release that fails leaves them installed — and a dropped
 * handle would leave them installed for the life of the document, with a later
 * {@link attachReact} stacking a second subscription on top and doubling every
 * commit event. The handle is therefore *retained* until a call to it returns
 * normally, the next detach retries it, and the observing flag that gates the
 * callbacks is separate from it so a failed release still stops every event
 * (AAP 0.5.1). The failure itself is reported as an `agent.error`
 * `producer-failure` frame rather than merely counted, because a capture that
 * lost a signal must be a capture known to have lost it (AAP 0.5.5), and the
 * subscription it left behind stays readable through {@link hasReactResidue},
 * so `./agent.js` can name it in the announcement it makes after every detach
 * instead of concluding that everything was released.
 *
 * ## Cost, and why the hot path looks the way it does
 *
 * The commit callback runs inside React's commit phase, on the developer's own
 * click path, for every commit their application performs. So:
 *
 * - Host fibers are skipped immediately (`isCompositeFiber`). A commit touches
 *   several times more DOM fibers than components, none of which a
 *   `renderTable` reader wants, and each one would cost an event.
 * - **The walk is this module's own**, iterative and bounded on both axes.
 *   bippy's `traverseRenderedFibers` recurses over the whole changed subtree
 *   and ignores what its callback returns, so there is no way to ask it to
 *   stop: bounding the *events* a commit produces would leave the *walk*
 *   unbounded on the developer's click path, which is a cost this file may not
 *   hand them. {@link collectRenders} therefore keeps an explicit stack, emits
 *   a fiber when bippy's own `isCompositeFiber` and `didFiberRender` (React's
 *   `PerformedWork` flag) both hold, and descends into a fiber's children only
 *   when it has no `alternate` — everything below it is new — or its `child`
 *   pointer differs from that alternate's, which is React having reconciled
 *   those children. Identical pointers mean React reused the subtree and
 *   nothing inside it rendered. That is the pruning React DevTools performs,
 *   and it is what keeps an update commit proportional to the subtree that
 *   changed rather than to the whole tree.
 * - Renders are collected into drafts and handed over in **one**
 *   {@link emitMany} call after the traversal: one capture gate, consecutive
 *   sequence numbers, and — the reason for the ordering — a commit event whose
 *   `renderCount` is the exact count rather than an estimate made before the
 *   work was done. The commit draft leads that batch, so the parent's sequence
 *   number precedes its children's.
 * - A commit is bounded twice: at {@link MAX_RENDERS_PER_COMMIT} render events
 *   and at {@link MAX_FIBER_VISITS_PER_COMMIT} fibers visited. The demo's
 *   seeded defect 2 re-renders 48 catalogue cards on a 250 ms ticker
 *   (AAP 0.8.2); one pathological commit must not consume the transport's
 *   whole 5 000-event buffer, and — this is what the second bound buys — must
 *   not consume an unbounded slice of the commit phase either. The commit
 *   event says it was cut, and `renderedFiberCount` says how much of it was
 *   counted.
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
 * Swallowed is not silent. Every one of those guards also calls
 * `./transport.js`'s {@link reportProducerFailure}, which posts a bounded
 * `agent.error` frame naming this producer, the stage that failed and the
 * thrown value's type — never a prop, a state value or an error message. One
 * frame per source per capture is the whole budget
 * (`MAX_PRODUCER_FAILURE_REPORTS`), so a render storm that fails on every
 * commit costs one frame rather than one per commit, and that bound lives in
 * the transport: nothing here rate-limits, because two independent limiters
 * would each be reasoning about half the traffic. Without the reports a
 * capture could lose every render event — the entire evidence base for "why is
 * this component rendering so many times?" (AAP 0.8.4) — while both UIs showed
 * a capture that had succeeded, which AAP 0.5.5 forbids.
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
  didFiberRender,
  getDisplayName,
  getFiberId,
  getRDTHook,
  hasRDTHook,
  instrument,
  isCompositeFiber,
  traverseFiber,
} from 'bippy';
import type { Fiber, FiberRoot } from 'bippy';

import { analyzeFiber } from './fiber-diff.js';
import type { ContextChange, FiberDiff, HookChange } from './fiber-diff.js';
import { newSpanId } from './ids.js';
import { resolveEventContext } from './interaction.js';
import type { EventContext } from './interaction.js';
import { recordStateTransitions } from './state.js';
import type { RecordTransitionsInput } from './state.js';
import { emitMany, nowEpochMs, reportProducerFailure, toEpochMs } from './transport.js';
import type { EventDraft } from './transport.js';
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
 * service's request. None is a tuning knob: raising the per-commit bounds
 * raises what one commit may cost the developer's page, and raising the tree
 * bounds raises what one snapshot event carries.
 *
 * One constant here is *not* exported — the visited-to-emitted ratio the two
 * visit bounds are derived from. It is an input to those contracts rather than
 * a contract itself, and it sits here so both walks read the same number.
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
 * how many rendered fibers the walk counted. It bounds the *events*, not the
 * walk — {@link MAX_FIBER_VISITS_PER_COMMIT} is what bounds the walk.
 */
export const MAX_RENDERS_PER_COMMIT = 500;

/**
 * How many fibers a bounded walk may visit per fiber it is allowed to emit: 16.
 *
 * Host, text, fragment and offscreen fibers are stepped over rather than
 * emitted, so a walk legitimately visits several times more fibers than it
 * reports — a card of six DOM elements around one component, say. Sixteen is
 * generous for that ratio and still bounds a walk absolutely, which is what
 * keeps a DOM-heavy page from turning a commit traversal, or a snapshot, into
 * the expensive part of the work it is observing.
 *
 * Stated once because the two bounded walks in this file justify it the same
 * way: {@link MAX_FIBER_VISITS_PER_COMMIT} derives from it, and
 * {@link snapshotComponentTree} multiplies its node budget by it. Two numbers
 * would drift apart.
 */
const MAX_VISITS_PER_EMITTED_FIBER = 16;

/**
 * The most fibers one commit's traversal may visit: 8 000, which is
 * {@link MAX_RENDERS_PER_COMMIT} × {@link MAX_VISITS_PER_EMITTED_FIBER}.
 *
 * The event bound above stops drafts being built; it does not stop the walk,
 * which would otherwise keep descending through the developer's tree inside
 * React's commit phase. This is the bound on the walk itself, and it is what
 * makes a commit cost the page a predictable amount whatever the tree looks
 * like. A commit stopped by it reports `truncated`, exactly as one cut by the
 * event bound does, and `renderedFiberCount` is then the count as far as the
 * walk got.
 *
 * It is also how the traversal terminates on a malformed or hand-built
 * structure whose `child`/`sibling` links form a cycle. The commit callback is
 * far too hot for the `Set` of visited fibers {@link snapshotComponentTree}
 * can afford, and a bound on visits needs no such memory; React's own trees
 * never contain a cycle.
 *
 * Exported for the same reason as its neighbours: a panel that tells the
 * developer a render list was cut is only honest if the bound that cut it can
 * be named.
 */
export const MAX_FIBER_VISITS_PER_COMMIT = MAX_RENDERS_PER_COMMIT * MAX_VISITS_PER_EMITTED_FIBER;

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
 * Set to `true` on a commit that either of the two per-commit bounds cut:
 * {@link MAX_RENDERS_PER_COMMIT} render events, or
 * {@link MAX_FIBER_VISITS_PER_COMMIT} fibers visited.
 *
 * **Addition**, spelled `truncated` — the same spelling `./state.ts` uses for
 * the same kind of statement, and at the same level: it describes the *list*,
 * never one render.
 */
const KEY_TRUNCATED = 'truncated';

/**
 * How many rendered fibers the traversal counted, before the event bound was
 * applied.
 *
 * **Addition**, spelled `renderedFiberCount`. It is the difference between
 * "this commit rendered 500 components" and "this commit rendered 8 000 and we
 * reported 500 of them", which is a conclusion a reader would otherwise draw
 * wrongly from a truncated list.
 *
 * Counting continues past {@link MAX_RENDERS_PER_COMMIT}, so for every commit
 * the walk completed this is the exact total. Where the walk was stopped by
 * {@link MAX_FIBER_VISITS_PER_COMMIT} it is the count as far as the walk got,
 * which is a lower bound; `truncated` is on the commit in both cases.
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
 * DOM node or a fiber: the snapshot crosses the page channel as JSON inside
 * an event's attributes, so anything that could not be serialised — or
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
 *   which is the observable form of a capture that has stopped observing.
 * - `renders` — `render` events handed to `./transport.js`.
 * - `truncatedCommits` — commits cut by {@link MAX_RENDERS_PER_COMMIT} or by
 *   {@link MAX_FIBER_VISITS_PER_COMMIT}. Non-zero means a panel's render list
 *   is incomplete for those commits, which the events themselves also say.
 * - `failures` — commit bodies, per-fiber iterations, teardown steps or a
 *   subscription release that failed and was swallowed. Never the page's fault
 *   to fix; a non-zero value is this module's bug report, and every one of
 *   them is also stated on the channel as an `agent.error` `producer-failure`
 *   frame (AAP 0.5.5), bounded by `./transport.js`.
 *
 * Four numbers, and the set is closed: whether a release is still outstanding
 * is internal state that shows up in behaviour — a retried release, no second
 * subscription — rather than in a field a reader would have to interpret.
 */
export interface ReactStats {
  /** Commits observed since the last reset. */
  commits: number;
  /** `render` events emitted since the last reset. */
  renders: number;
  /** Commits cut by either per-commit bound. */
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
  /** The render drafts, in traversal order, bounded by the event bound. */
  readonly drafts: EventDraft[];
  /** The transitions to hand to `./state.js` once the drafts are away. */
  readonly transitions: PendingTransitions[];
  /**
   * How many composite fibers the walk found had rendered, counted past the
   * event bound and therefore the true total for a walk that completed.
   */
  readonly renderedFibers: number;
  /** How many of those were mounts, for the commit's phase summary. */
  readonly mounts: number;
  /** Whether either per-commit bound stopped the walk or the list short. */
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
 * One page document's worth. {@link detachReact} clears every field, because
 * AAP 0.5.1 requires a cleared hook to be disabled rather than idled:
 * afterwards this module holds no counts and no reference into the developer's
 * fiber tree, and observes nothing.
 *
 * {@link subscriptionRelease} — together with
 * {@link subscriptionReleaseFailed}, which says whether a call to it ever
 * returned — is the single exception, and only while a release has failed. See
 * their own documentation, and the module documentation's note on why the
 * handle outlives the detach that could not use it.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether the commit handlers are *observing* right now.
 *
 * Deliberately not "whether a subscription exists": the two are different
 * facts, and conflating them is what let a failed release be mistaken for a
 * completed one. This flag is the gate every handler body checks and the value
 * {@link isReactAttached} reports, so clearing it is sufficient to make a
 * capture stop producing events — whatever the state of the subscription
 * underneath.
 */
let armed = false;

/**
 * The function `instrument()` returned, **retained until calling it succeeds**.
 *
 * It is the only thing that can remove the handlers `instrument()` installed
 * (AAP 0.5.1), which makes dropping it unrecoverable: bippy's release deletes
 * this module's entry from the set every commit is dispatched to, so an
 * un-released subscription keeps calling into this module for the life of the
 * document and a fresh `instrument()` would add a *second* entry — two
 * dispatches per commit, every event doubled. So the handle is cleared only by
 * a call that returned normally. Until then {@link detachReact} retries it on
 * every call and {@link attachReact} re-arms *this* subscription instead of
 * making another.
 *
 * Typed as a plain callable rather than as bippy's `Unsubscribe` (which also
 * declares `Symbol.dispose`) because calling it is the entire use, and the
 * narrower type cannot be mistaken for a disposable this module manages.
 */
let subscriptionRelease: (() => void) | undefined;

/**
 * Whether the last release attempt on {@link subscriptionRelease} failed to
 * return — the one fact that tells a *live* subscription apart from one a
 * detach could not get rid of.
 *
 * The handle alone cannot make that distinction, and neither can {@link armed}:
 * an armed capture holds the handle on purpose, and {@link attachReact} re-arms
 * *through* a handle a failed release left behind, so a predicate reading only
 * those two would call a working subscription residue or miss residue the
 * re-arm path adopted. This flag records the release itself: {@link detachReact}
 * sets it before it calls the handle — the pessimistic order, because a call
 * that never returns proves nothing — and clears it only from inside a call
 * that did return. It is what {@link hasReactResidue} reads, and it exists
 * because AAP 0.5.1 requires an incomplete cleanup to be visible rather than
 * assumed complete.
 *
 * `false` while nothing has been released yet, which is the honest answer
 * before the first {@link attachReact} and during a capture: no release has
 * failed, so no handler of this module's is outliving a detach.
 */
let subscriptionReleaseFailed = false;

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
 * Queue one fiber's children for the commit walk, in fiber order.
 *
 * Pushed in reverse because the pending list is a stack: that is what makes
 * the emitted events read parent before child, with siblings in the order
 * React holds them, which is the order `../aggregate/renders.ts` rebuilds a
 * component tree from.
 *
 * The sibling scan is bounded by the visits the walk has left over what is
 * already queued. A fiber queued past that point could never be visited —
 * {@link MAX_FIBER_VISITS_PER_COMMIT} stops the walk first — so scanning on
 * could only cost time, and the bound is also what keeps a hand-built
 * `sibling` chain that loops from spinning here rather than at the walk's own
 * bound.
 *
 * @param fiber The fiber whose children are to be walked.
 * @param pending The walk's stack, pushed in place.
 * @param visitBudget How many more fibers the walk may hold and visit.
 * @returns `true` when the sibling list was longer than the budget, which is a
 * truncation the commit event has to report.
 */
function queueCommitChildren(fiber: Fiber, pending: Fiber[], visitBudget: number): boolean {
  const children: Fiber[] = [];
  let child: Fiber | null = fiber.child;
  while (child !== null && children.length < visitBudget) {
    children.push(child);
    child = child.sibling;
  }
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const entry = children[index];
    if (entry !== undefined) {
      pending.push(entry);
    }
  }
  return child !== null;
}

/**
 * One commit's traversal: a draft per rendered composite fiber, and the state
 * transitions to hand on afterwards.
 *
 * The walk is product-owned, iterative and bounded on both axes, for the
 * reason the module documentation gives: bippy's `traverseRenderedFibers`
 * recurses through the whole changed subtree and discards whatever its
 * callback returns, so bounding the drafts left the walk itself unbounded
 * inside React's commit phase. Three rules define it, and they are chosen to
 * emit exactly the set of fibers bippy's walkers emitted:
 *
 * - **Emission.** `isCompositeFiber` keeps host, text, fragment and offscreen
 *   fibers out — the same fibers bippy filtered, and a commit touches several
 *   times more of them than it renders — and `didFiberRender` is React's
 *   `PerformedWork` flag, which is what "rendered in this commit" means. Both
 *   readings go through the renderer's work-tag map inside bippy and throw for
 *   a fiber whose renderer it does not recognise, which is why they sit inside
 *   the per-fiber `try`.
 * - **Phase.** No `alternate` is a `mount`, an `alternate` an `update`, per
 *   fiber rather than per pass.
 * - **Descent.** Into the children when the fiber has no `alternate`
 *   (everything below it is new) or its `child` pointer differs from that
 *   alternate's (React reconciled them). Identical pointers mean React reused
 *   the subtree, so nothing in it rendered and there is nothing to find.
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

  const rootFiber = readRootFiber(root);
  if (rootFiber === undefined) {
    // A root React has torn down, or one mid-teardown: there is no tree to
    // walk, and the commit event is still worth emitting without renders.
    return { drafts, transitions, renderedFibers, mounts, truncated };
  }

  // Seeded with the committed tree's root fiber and never its siblings: a
  // `HostRoot` has none, and `readRootFiber` has already resolved whichever
  // of the two shapes the hook was handed.
  const pending: Fiber[] = [rootFiber];
  let visits = 0;

  while (pending.length > 0) {
    const fiber = pending.pop();
    if (fiber === undefined) {
      break;
    }

    visits += 1;
    if (visits > MAX_FIBER_VISITS_PER_COMMIT) {
      // The walk's own bound, and the reason a commit costs the page a
      // predictable amount: the event bound below stops drafts, this stops
      // work. It is also what terminates a cyclic hand-built structure, which
      // is why this hot path carries no set of visited fibers.
      truncated = true;
      break;
    }

    try {
      // The descent decision is taken before this fiber's own readings, which
      // are the ones that can throw: two pointer comparisons cost nothing,
      // and a subtree kept when one hostile fiber above it failed is evidence
      // that would otherwise be lost for a reason the developer cannot see.
      const previous: Fiber | null = fiber.alternate ?? null;
      if (previous === null || fiber.child !== previous.child) {
        if (
          queueCommitChildren(fiber, pending, MAX_FIBER_VISITS_PER_COMMIT - visits - pending.length)
        ) {
          truncated = true;
        }
      }

      if (!isCompositeFiber(fiber) || !didFiberRender(fiber)) {
        // Not a component, or a component React did not render in this commit:
        // either way there is no render to report, and its children have
        // already been queued above.
        continue;
      }

      // React keeps the previous fiber of an instance as its `alternate`, so
      // the absence of one is this instance's first render. Annotated so the
      // literal is held to the catalog's vocabulary, which `RenderPhase` is.
      const phase: RenderPhase = previous === null ? 'mount' : 'update';

      renderedFibers += 1;
      if (phase === 'mount') {
        mounts += 1;
      }

      if (drafts.length >= MAX_RENDERS_PER_COMMIT) {
        // Counting continues past the event bound so `renderedFiberCount` is
        // the true total rather than "at least the cap", which is the
        // difference between a reader concluding "500 components rendered" and
        // "8 000 did, and 500 are listed". The walk carries on under the visit
        // bound, and stops there.
        truncated = true;
        continue;
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
    } catch (error) {
      failureCount += 1;
      // One fiber's worth of the commit is missing from the render table, and
      // the report is what keeps that absence from reading as "this component
      // did not render".
      reportProducerFailure('react', 'commit-traversal', error);
    }
  }

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
 * The fiber tree the hook was handed, read defensively.
 *
 * Two shapes, resolved the way bippy's own traversal resolved them: a
 * `FiberRoot` carries the tree on `current`, while a renderer with no root
 * object would hand the callback the root *fiber* itself. A container with a
 * `current` property is therefore read through it, and one without is taken to
 * be the fiber. The second case is defensive — bippy's installed hook reads
 * `root.current` before it dispatches, so nothing reaching these handlers
 * through it can be a bare fiber — and it costs one `in` check on a path that
 * runs once per commit.
 *
 * A `FiberRoot` from React always has a current fiber; a hand-built root in a
 * test, or a root mid-teardown, may not, and the commit event is still worth
 * emitting without the root's timings and without renders. The single reader
 * is shared by the commit walk, the commit event's timings, the unmount
 * housekeeping and {@link snapshotComponentTree}, so all four agree on what
 * the tree is.
 */
function readRootFiber(root: FiberRoot): Fiber | undefined {
  try {
    // Cast through a nullable structural type rather than asserted upon: the
    // value arrives from the page's React, so "is it even an object" is a
    // question that has to be asked before `in` can be.
    const container = root as unknown as { current?: unknown } | null;
    if (container === null || typeof container !== 'object') {
      return undefined;
    }
    if (!('current' in container)) {
      return container as unknown as Fiber;
    }
    const current: unknown = container.current;
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
    } catch (error) {
      failureCount += 1;
      reportProducerFailure('react', 'state-transitions', error);
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
    if (!armed) {
      // A batch already in flight when the hooks were cleared must produce
      // nothing — and so must every commit after a release that failed, which
      // is why the gate is a flag of its own rather than "a handle exists".
      // AAP 0.5.1 asks for a disabled hook, not an idle one.
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
  } catch (error) {
    failureCount += 1;
    // The whole commit is missing: no commit event, no render events, and
    // therefore no evidence of a render storm the developer is asking about.
    // Reporting it is the difference between a capture that lost its renders
    // and a capture that appears to have observed none (AAP 0.5.5).
    reportProducerFailure('react', 'commit', error);
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
 *
 * It is the one handler with no `try`/`catch` and no failure report, because
 * an empty body has nothing to contain and nothing to lose: a guard here would
 * be a `catch` no input can reach and a stage no reader would ever see. Any
 * work added to this function must arrive with a guard and a
 * `reportProducerFailure('react', 'post-commit', …)` call, like its two
 * siblings.
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
  } catch (error) {
    failureCount += 1;
    reportProducerFailure('react', 'unmount', error);
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
  const maxVisits = maxNodes * MAX_VISITS_PER_EMITTED_FIBER;

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
 * Run one teardown step, contained and reported.
 *
 * The reason {@link detachReact} is a list of these rather than one `try` over
 * the whole body: with a single guard the first step that throws skips every
 * step after it, and a detach that stopped halfway would leave the render
 * counts of a finished capture — or a reference into the developer's fiber
 * tree — behind while reporting nothing. One guard per step makes every step
 * independent of its neighbours' luck.
 *
 * No step is assumed safe. This code runs in the page's own world, where
 * `Map.prototype.clear` and the subscription's own release function belong to
 * the developer's page and can have been replaced by anything, so the uniform
 * guard costs one `try` and removes a class of failure rather than a line.
 *
 * @param stage The step's short, stable identifier, for the failure report.
 * @param step The step. Whatever it throws is counted and reported, never
 * propagated: `./agent.js` calls this on the capture-stop path.
 */
function detachStep(stage: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    failureCount += 1;
    reportProducerFailure('react', stage, error);
  }
}

/**
 * Subscribe to React's commit hook.
 *
 * Called by `./agent.js` when an `agent.config` arms the React hook. Does
 * **not** install the DevTools hook — that happened at `document_start`,
 * before React loaded, and is the precondition this module cannot create for
 * itself (see the module documentation).
 *
 * Three cases, in this order, and the middle one is the repair:
 *
 * 1. **Already observing** — return without touching the subscription. A
 *    service-worker reconnect re-sends the configuration mid-capture, and
 *    re-subscribing would double every event.
 * 2. **A retained release** ({@link subscriptionRelease} set while not armed)
 *    — a previous {@link detachReact} could not release the handlers, so they
 *    are *still installed and still dispatching into this module*. Re-arming
 *    the gate is therefore all that is needed, and calling `instrument()`
 *    again would add a second subscription on top of the first: two dispatches
 *    per commit, every render event duplicated.
 * 3. **Neither** — subscribe, and keep the handle.
 *
 * Cannot throw. A page with no hook, or one whose hook belongs to the real
 * React DevTools extension in a shape bippy declines to patch, leaves this
 * module detached and the agent's other hooks unaffected; the failure is
 * counted and reported as `producer-failure` (AAP 0.5.5).
 */
export function attachReact(): void {
  try {
    if (armed) {
      return;
    }

    if (subscriptionRelease !== undefined) {
      // Case 2: the handlers are already installed. Arming the gate resumes
      // observation through the subscription that was never released.
      armed = true;
      return;
    }

    // Published before `instrument` returns, so a commit dispatched during
    // registration — React can commit at any moment — finds the module
    // observing rather than dropping its batch.
    armed = true;

    subscriptionRelease = instrument({
      name: 'debuggen',
      onCommitFiberRoot,
      onPostCommitFiberRoot,
      onCommitFiberUnmount,
    });
  } catch (error) {
    // `instrument()` threw, so it returned no handle and there is nothing to
    // retain: no handler of this module's can fire, and leaving a claim behind
    // would make the next call take the repair path with no subscription to
    // repair.
    armed = false;
    subscriptionRelease = undefined;
    failureCount += 1;
    reportProducerFailure('react', 'subscribe', error);
  }
}

/**
 * Stop observing, forget everything this capture observed, and release the
 * subscription.
 *
 * The order is the contract:
 *
 * 1. **Stop observing.** The gate the handlers check is cleared first, so a
 *    commit delivered during the teardown — or one delivered for ever after,
 *    because the release below failed — produces nothing. AAP 0.5.1 asks for a
 *    disabled hook, not an idle one, and this is the part of that guarantee
 *    that cannot fail.
 * 2. **Forget.** The counters, the per-component render counts and the
 *    retained fiber root, each in its own guard (see {@link detachStep}), so
 *    one failing step never skips the rest.
 * 3. **Release.** Call the function `instrument()` returned, which removes
 *    exactly the handlers {@link attachReact} registered (AAP 0.5.1). On
 *    success the handle is dropped and this module holds nothing at all.
 *    **On failure the handle is kept**: it is the only way those handlers can
 *    ever be removed, the next call to this function retries it, and
 *    {@link attachReact} re-arms through it rather than stacking a second
 *    subscription. The failure is counted in {@link getReactStats} and posted
 *    as an `agent.error` `producer-failure` frame, so an incomplete cleanup is
 *    stated rather than assumed complete (AAP 0.5.5).
 *
 * The DevTools hook itself is left installed, on purpose: React is already
 * attached to it and the real React DevTools extension may be using it too, so
 * removing it would break both. What the developer removes by ending a session
 * is the *capture*, and an installed hook with no subscribers observes nothing.
 *
 * Safe to call when already detached, safe to call repeatedly — which is what
 * makes the retry above reachable — and cannot throw.
 */
export function detachReact(): void {
  // Step 1. Not guarded because a boolean assignment cannot fail, which is
  // exactly why the flag and the handle are separate pieces of state.
  armed = false;

  // Step 2. The counters go first, so a failure in a later step is still
  // visible in `getReactStats().failures` after this call returns.
  detachStep('reset-stats', () => {
    commitCount = 0;
    renderEventCount = 0;
    truncatedCommitCount = 0;
    failureCount = 0;
  });
  detachStep('clear-counts', () => {
    componentRenderCounts.clear();
  });
  detachStep('release-root', releaseRoot);

  // Step 3. Read once: a release that succeeds must clear the same handle it
  // was taken from, and a release that throws must leave it in place.
  const release = subscriptionRelease;
  if (release === undefined) {
    return;
  }

  // Assumed failed until the call proves otherwise, for the same reason the
  // handle is kept until then: a release that throws — or one this module never
  // gets an answer from — leaves the handlers installed, and the interval
  // between the two assignments below is the only place a truthful residue
  // answer can come from (see {@link subscriptionReleaseFailed}).
  subscriptionReleaseFailed = true;

  detachStep('release', () => {
    release();
    // Only a call that returned normally proves the handlers are gone.
    subscriptionRelease = undefined;
    subscriptionReleaseFailed = false;
  });
}

/**
 * Whether the commit handlers are *observing* right now.
 *
 * `./agent.js` reports it in the readiness and status frames the DevTools
 * panel shows. "Attached" is this folder's uniform vocabulary for an armed
 * hook, and this answer is about observation alone: `false` after a detach,
 * including a detach whose release failed. The residue of such a detach is the
 * retained handle {@link detachReact} will retry, reported by
 * {@link hasReactResidue} — never a flag claiming an observation that is not
 * happening.
 */
export function isReactAttached(): boolean {
  return armed;
}

/**
 * Whether this module still holds a bippy subscription its last detach could
 * not release.
 *
 * The counterpart of {@link isReactAttached}, and a second function rather than
 * a different answer from that one, because they answer different questions.
 * "Attached" is this folder's word for *observing*, and a subscription whose
 * release failed observes nothing — {@link armed} is cleared first, by design.
 * So `./agent.js` needs both: its readiness and status frames say what is being
 * recorded, while the `hooks-not-released` announcement it posts after asking
 * every producer to detach has to name what survived those calls. Deriving that
 * from {@link isReactAttached} would answer the observation question and
 * conclude that everything was released — which AAP 0.5.1 does not allow, since
 * a cleared hook must be disabled rather than idled and a cleanup that did not
 * complete has to be visible rather than assumed.
 *
 * `true` means {@link detachReact} called the function `instrument()` returned
 * and that call did not return normally, so bippy's entry for this module is
 * still in the set every commit is dispatched to: the handlers are installed,
 * they are inert (every one of them gates on {@link armed}), and only a later
 * release can remove them. `false` means no release is outstanding — before the
 * first {@link attachReact}, after a detach whose release returned, and after a
 * retry that finally succeeded.
 *
 * **An armed subscription is not residue.** During a capture the handle is held
 * on purpose, so this is `false` for as long as this module is observing. That
 * includes the re-arm: {@link attachReact}, finding a retained handle while not
 * armed, adopts *that* subscription — arming the gate again rather than calling
 * `instrument()` a second time, which would put two entries in the dispatch set
 * and double every render event — and from that moment the handlers are a live
 * subscription again rather than residue. They become residue again the moment a
 * detach cannot release them, which is why the outstanding-release fact lives in
 * its own field ({@link subscriptionReleaseFailed}) instead of being guessed
 * from the handle or from the gate.
 *
 * Reports state and changes none: two boolean reads, one reference read, and it
 * cannot throw, so `./agent.js` may call it on every disarm.
 */
export function hasReactResidue(): boolean {
  return !armed && subscriptionReleaseFailed && subscriptionRelease !== undefined;
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
  } catch (error) {
    failureCount += 1;
    // `undefined` reads as "no tree to report", which is also the answer for a
    // page that never committed; the report is what distinguishes the two.
    reportProducerFailure('react', 'tree-snapshot', error);
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
