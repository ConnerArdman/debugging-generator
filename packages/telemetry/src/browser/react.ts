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
 *   commit's renders. Its `renderCount` attribute is how many rendered fibers
 *   the commit's `render` events stand for, which is the number a developer
 *   recognises as "this many components re-rendered when I typed one
 *   character".
 * - **`render`** — one event per *group* of composite fibers that rendered in
 *   the commit for the same reason: one component, one phase, one trigger and
 *   one sorted list of changed props. It carries the component name, the
 *   phase, the running per-capture render count, the props that changed, and —
 *   for an update — **why** it rendered; `instanceCount` says how many fibers
 *   it stands for when that is more than one (see "Coalescing" below).
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
 * entirely rather than set to anything. {@link buildGroupAttributes} is where
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
 *   classifies the render — `captureFiber` inside the commit, which records
 *   the pointers, and `analyzeCapturedFiber` afterwards, which compares them.
 *   No field of a fiber that holds application data — `memoizedProps`,
 *   `memoizedState`, `dependencies` — is touched here; a second reader of
 *   those fields would be a second privacy boundary to audit, and there is
 *   exactly one (AAP 0.5.2).
 * - **`./state.js`** turns the hook and context changes that diff found into
 *   `state` events. This module hands them over and reads no hook itself.
 *   Emitting them from here as well would double the evidence. Their values
 *   are summarised only while that module is armed (`isStateAttached`), since
 *   nothing else reads them.
 * - **`./interaction.js`** decides which trace a commit belongs to. Asked once
 *   per commit, never per fiber, so every render of one commit lands in one
 *   tree and the answer cannot change halfway through a traversal.
 * - **`./transport.js`** stamps, bounds and posts. Outside a capture it drops
 *   everything, which is why this file holds no capture state of its own.
 * - **`./agent.js`** owns the lifecycle: it installs bippy's hook at
 *   `document_start` (see below), calls {@link attachReact} when a capture
 *   arms the React hook, {@link resetReactCounters} at the start of each
 *   capture, {@link snapshotComponentTree} when a capture stops, and
 *   {@link detachReact} when the hooks are cleared — and
 *   {@link flushPendingReactWork} before each of those terminal points, so no
 *   observed commit is still waiting for an idle slice when its capture ends.
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
 * holds no counts, no fiber tree and no queued commit — the queue is
 * *discarded*, never processed, and its scheduled idle callback cancelled and
 * disarmed — and a commit costs one comparison.
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
 *   hand them. {@link captureRenders} therefore keeps an explicit stack, emits
 *   a fiber when bippy's own `isCompositeFiber` and `didFiberRender` (React's
 *   `PerformedWork` flag) both hold, and descends into a fiber's children only
 *   when it has no `alternate` — everything below it is new — or its `child`
 *   pointer differs from that alternate's, which is React having reconciled
 *   those children. Identical pointers mean React reused the subtree and
 *   nothing inside it rendered. That is the pruning React DevTools performs,
 *   and it is what keeps an update commit proportional to the subtree that
 *   changed rather than to the whole tree.
 * - **Capture now, analyse later.** Inside the commit this module does only
 *   what cannot wait: it resolves the trace, reads the root's timings, walks
 *   the changed subtree and, per rendered component, records the phase, the
 *   profiler's readings and the pointers `./fiber-diff.js`'s `captureFiber`
 *   returns. Everything else — the prop, hook and context comparisons, the
 *   names, the ancestry, the span ids, the attribute bags, the hand-off to the
 *   transport and to `./state.js` — runs later, in idle time
 *   (`requestIdleCallback` with a {@link IDLE_TIMEOUT_MS} deadline, a timer
 *   where the host has none), a whole commit at a time and in commit order.
 *   The QA measurement behind this split: doing all of it inside the commit
 *   doubled click-to-next-frame latency on the demo storefront (PERF-F07).
 *   Deferral is correct because React double-buffers fibers: the objects a
 *   commit held are not rewritten when the alternate becomes the next render's
 *   work in progress, and the capture holds those objects rather than the
 *   fields that pointed at them (`./fiber-diff.ts` documents the one caveat —
 *   an in-place mutation between commit and analysis shows in a preview, never
 *   in a classification). The profiler's readings (`actualDuration`,
 *   `actualStartTime`, the children's durations behind `selfTime`) *are*
 *   rewritten when a fiber is reused, which is why they are read in the commit.
 * - **The queue is bounded.** At most {@link MAX_PENDING_COMMITS} commits and
 *   {@link MAX_PENDING_RENDERS} captured renders wait for idle time; past
 *   either the backlog is worked off on the next task instead of the next idle
 *   period, and past twice either the oldest commit is analysed inside the
 *   commit callback — the cost the synchronous design always paid — so memory
 *   stays bounded under any commit storm and nothing observed is dropped.
 *   {@link flushPendingReactWork} empties the queue synchronously; `./agent.js`
 *   calls it at every point where a capture's evidence must be complete.
 * - **Coalescing.** The rendered fibers of one commit that share a component
 *   name, a phase, a trigger and a sorted changed-prop list become **one**
 *   `render` event: the demo's 48 memoised product cards re-rendered by one
 *   context tick are one event, not 48. One event per fiber was what made a
 *   busy page emit faster than the pipeline could ingest and lose a third to a
 *   half of its capture at the producer (PERF-F08). The event's `startTime` is
 *   the earliest instance's, its `duration` and `actualDuration` the sum of the
 *   instances', `maxInstanceDuration` the slowest one's, and its `fiberId`,
 *   `parentFiberId`, `key` and `ownerChain` the first instance's in traversal
 *   order; `instanceCount` is present when the group has more than one member.
 *   `state` transitions stay per instance, each parented to its group's span.
 * - Renders are handed over in **one** {@link emitMany} call per commit: one
 *   capture gate, consecutive sequence numbers, and — the reason for the
 *   ordering — a commit event whose `renderCount` is the exact count rather
 *   than an estimate made before the work was done. The commit draft leads
 *   that batch, so the parent's sequence number precedes its children's. The
 *   batch is emitted when the commit is analysed, so its sequence numbers can
 *   follow those of events that happened after it; every event carries its
 *   own `startTime`, which is what readers order by.
 * - A commit is bounded twice: at {@link MAX_RENDERS_PER_COMMIT} rendered
 *   fibers captured, and therefore at most that many render events, and at
 *   {@link MAX_FIBER_VISITS_PER_COMMIT} fibers visited. A context provider
 *   that updates several times a second re-renders every one of its dozens of
 *   consumers on each tick; one pathological commit must not consume the
 *   transport's whole 5 000-event buffer, and — this is what the second bound
 *   buys — must not consume an unbounded slice of the commit phase either. The
 *   commit event says it was cut, and `renderedFiberCount` says how much of it
 *   was counted.
 * - Nothing here sorts, clones, stringifies or retains application values
 *   beyond the bounded queue, which holds references, never copies.
 *
 * ## Nothing here throws, ever
 *
 * A throw inside `onCommitFiberRoot` surfaces inside React's commit phase and
 * can break the developer's application — the one failure this product may
 * never cause. Every handler body sits inside a `try`/`catch`, and **each
 * per-fiber iteration has its own** — in the commit walk and again in the
 * deferred analysis — so a single hostile fiber costs itself and not the rest
 * of the commit. The idle callback and {@link flushPendingReactWork} are
 * guarded the same way, since a throw there would surface in the page's own
 * task. Failures are counted in {@link getReactStats} and swallowed, which is
 * the same contract `./transport.js`, `./state.js` and `./perf.ts` keep.
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
  onRendererInject,
} from 'bippy';
import type { Fiber, FiberRoot } from 'bippy';

import { analyzeCapturedFiber, captureFiber, createSummaryMemo } from './fiber-diff.js';
import type {
  CapturedFiber,
  CapturedFiberAnalysisOptions,
  ContextAttribution,
  ContextChange,
  HookChange,
  RenderAnalysis,
} from './fiber-diff.js';
import { newSpanId } from './ids.js';
import { resolveEventContext } from './interaction.js';
import type { EventContext } from './interaction.js';
import { isStateAttached, recordStateTransitions } from './state.js';
import type { RecordTransitionsInput } from './state.js';
import { emitMany, nowEpochMs, reportProducerFailure, toEpochMs } from './transport.js';
import type { EventDraft } from './transport.js';
import { MAX_OWNER_CHAIN_LENGTH, MAX_TRACKED_KEYS } from '../schema/attributes.js';
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
 * The most rendered fibers one commit may report: 500 — and therefore the
 * most `render` events it may produce, since each event stands for at least
 * one of them.
 *
 * Chosen against the two numbers it sits between. The transport buffers 5 000
 * events for a whole capture (`MAX_BUFFERED_EVENTS` in `./transport.ts`), and
 * an excessive-render pattern re-renders dozens of list items several times a
 * second; 500 is an order of magnitude above any commit worth reading fiber by
 * fiber, and a tenth of the buffer, so one runaway commit cannot evict the
 * interaction, request and query evidence the same capture needs. It is also
 * what bounds one commit's share of the pending queue and one commit's
 * deferred analysis, which is a single uninterrupted piece of work.
 *
 * A commit that reaches the bound still reports the truth about itself: the
 * `truncated` attribute says the list was cut and `renderedFiberCount` says
 * how many rendered fibers the walk counted. It bounds the *captured fibers*,
 * not the walk — {@link MAX_FIBER_VISITS_PER_COMMIT} is what bounds the walk.
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
 *
 * Declared once, as `MAX_OWNER_CHAIN_LENGTH` in `../schema/attributes.ts`, and
 * re-exported here under this module's name: `../aggregate/renders.ts` infers
 * from a chain of exactly this length that the walk was cut before the root,
 * so the producer's bound and the reader's inference must be one number.
 */
export const MAX_OWNER_CHAIN = MAX_OWNER_CHAIN_LENGTH;

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

/**
 * The most commits the pending queue holds before its backlog is worked off
 * on the next task rather than in idle time: 32.
 *
 * The queue exists so the analysis of a commit runs after the frame it
 * belongs to, not inside it. A page that commits faster than it idles — a
 * burst of typing, a render loop — must not turn that deferral into an
 * unbounded buffer of references into its fiber tree, so past this bound the
 * scheduler stops waiting for idle time; past **twice** this bound the oldest
 * commit is analysed inside the commit callback that would have exceeded it,
 * which is the cost the synchronous design paid on every commit, now paid only
 * by a storm. Nothing observed is dropped at either bound.
 */
export const MAX_PENDING_COMMITS = 32;

/**
 * The most captured rendered fibers the pending queue holds before its backlog
 * is worked off on the next task: 2 000, four commits at
 * {@link MAX_RENDERS_PER_COMMIT}. Twice this is the hard bound, with the same
 * two-stage behaviour as {@link MAX_PENDING_COMMITS}.
 *
 * Counted separately from commits because the retained memory is per fiber:
 * each captured render holds its fiber and six pointers `./fiber-diff.ts`
 * reads, so a few very large commits bound the queue sooner than many small
 * ones.
 */
export const MAX_PENDING_RENDERS = MAX_RENDERS_PER_COMMIT * 4;

/**
 * The longest a queued commit waits for idle time, in milliseconds: 200.
 *
 * `requestIdleCallback`'s `timeout`. On a page that never idles — the demo's
 * shipping estimate ticks every 250 ms — this is what keeps a capture's
 * evidence arriving at the transport's own cadence (`FLUSH_INTERVAL_MS`,
 * 250 ms) rather than never; on a page that idles, the analysis runs well
 * before it, in the gap after a frame.
 */
export const IDLE_TIMEOUT_MS = 200;

/**
 * The longest one slice of deferred work may run when the host gives it no
 * idle deadline to respect, in milliseconds: 8.
 *
 * Applies to the timer fallback (a host without `requestIdleCallback`), to an
 * idle callback that fired on its timeout (`didTimeout`, whose
 * `timeRemaining()` is zero) and to the backlog task. Half a 60 Hz frame, so a
 * slice that lands between two frames does not push the second one out. A
 * slice always processes at least one whole commit, and commits are never
 * split, so the bound is on how many commits a slice takes on, not a hard
 * wall-clock cut.
 */
const SLICE_BUDGET_MS = 8;

/**
 * How long the timer fallback waits before its slice, in milliseconds: 16.
 *
 * A host without `requestIdleCallback` gives no signal that a frame has been
 * produced; one frame's length is the cheapest approximation of "after the
 * paint this commit was for" that does not also postpone the evidence.
 */
const FALLBACK_DELAY_MS = 16;

/**
 * The idle time below which a slice stops taking on another commit, in
 * milliseconds: 1. Starting a commit's analysis with less than this left would
 * overrun the idle period the browser offered.
 */
const MIN_IDLE_REMAINING_MS = 1;

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
 * exactly why it is useful for telling the last row of a list from the first —
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

/**
 * Running count for this component within the capture, starting at 1 and
 * advanced by the event's instance count.
 */
const KEY_RENDER_COUNT: RenderAttributeKey = 'renderCount';

/** Names of the props that were not equal to the previous render's. */
const KEY_CHANGED_PROPS: RenderAttributeKey = 'changedProps';

/** Why the fibers rendered. Present on an update, absent on a mount. */
const KEY_TRIGGER: RenderAttributeKey = 'trigger';

/**
 * React's own reported render time, including descendants, summed over the
 * event's instances.
 */
const KEY_ACTUAL_DURATION: RenderAttributeKey = 'actualDuration';

/** The instances' cost excluding their descendants, summed. */
const KEY_SELF_TIME: RenderAttributeKey = 'selfTime';

/** Ancestor component names of the first instance, nearest first. */
const KEY_OWNER_CHAIN: RenderAttributeKey = 'ownerChain';

/**
 * How many rendered fibers the event stands for; written only when more than
 * one, so an event without it is exactly one fiber (see
 * `../schema/attributes.ts`).
 */
const KEY_INSTANCE_COUNT: RenderAttributeKey = 'instanceCount';

/**
 * The slowest single instance's `actualDuration`; written with
 * {@link KEY_INSTANCE_COUNT} when at least one instance was measured, because
 * a sum cannot say whether one card was slow or all of them were.
 */
const KEY_MAX_INSTANCE_DURATION: RenderAttributeKey = 'maxInstanceDuration';

/**
 * Which consumed contexts changed, each named by the component that provides
 * it. Present on an update whose consumed contexts changed and could be named;
 * absent otherwise, and always absent on a mount.
 */
const KEY_CHANGED_CONTEXTS: RenderAttributeKey = 'changedContexts';

/** `mount` or `update` for the commit as a whole. */
const KEY_COMMIT_PHASE: CommitAttributeKey = 'phase';

/**
 * How many rendered fibers this commit's `render` events stand for — the sum
 * of their instance counts. Not the number of events, and not a per-component
 * count. Equal to {@link KEY_RENDERED_FIBER_COUNT} unless a bound cut the
 * commit or a fiber could not be analysed.
 */
const KEY_COMMIT_RENDER_COUNT: CommitAttributeKey = 'renderCount';

/** Which root committed, so concurrent roots on one page stay apart. */
const KEY_ROOT_NAME: CommitAttributeKey = 'rootName';

/**
 * The fiber's identity within this document (bippy's `getFiberId`) — on a
 * coalesced event, the first instance's.
 *
 * **Addition**, spelled `fiberId` — the same spelling `./state.ts` emits, so
 * the two producers describe one instance the same way. Two components with
 * the same display name are one row when grouped by `component`; this is what
 * distinguishes the last row of a list from the first. The `state` events of
 * a coalesced group carry each instance's own id.
 */
const KEY_FIBER_ID = 'fiberId';

/**
 * The fiber id of the first instance's nearest composite ancestor.
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
 * - `commits` — commits observed, counted inside the commit callback. Stops
 *   growing after {@link detachReact}, which is the observable form of a
 *   capture that has stopped observing.
 * - `renders` — `render` events handed to `./transport.js`: coalesced events,
 *   not fibers, counted when a commit is analysed. A commit still waiting for
 *   idle time is in `commits` and not yet in `renders`;
 *   {@link flushPendingReactWork} makes the two agree.
 * - `truncatedCommits` — analysed commits cut by {@link MAX_RENDERS_PER_COMMIT}
 *   or by {@link MAX_FIBER_VISITS_PER_COMMIT}. Non-zero means a panel's render
 *   list is incomplete for those commits, which the events themselves also say.
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
 * analysis so that a transition's sequence number follows the render it sits
 * inside; the alternative put children before parents in a raw event log
 * ordered by sequence. Only summaries travel in here — `./fiber-diff.js` has
 * already reduced every value to a type and a bounded preview — so holding
 * them for the length of one commit retains nothing of the application's data.
 * One entry per *instance*, never per coalesced group: each instance's state
 * is its own, and `renderSpanId` is the group's span it rendered under.
 */
interface PendingTransitions {
  /** The component the transitions belong to. */
  readonly component: string;
  /** The fiber's identity, when one was resolved. */
  readonly fiberId: number | undefined;
  /** The render span the transitions were observed in: the group's. */
  readonly renderSpanId: string;
  /** The instance's own render start, in epoch milliseconds. */
  readonly startTime: number;
  /** The fiber's own state-bearing hooks that changed. */
  readonly hookChanges: readonly HookChange[];
  /** The consumed context values that changed, when context was readable. */
  readonly contextChanges: readonly ContextChange[] | undefined;
}

/**
 * One composite ancestor on the walk's current path: the fiber and the link
 * above it.
 *
 * Built top-down while the commit walk descends — one small record per
 * composite fiber whose children it queues — so a rendered fiber's ancestry is
 * a pointer to its nearest composite ancestor's link rather than a walk up
 * `return` pointers. That matters twice. The upward walk ran once per rendered
 * fiber, inside the commit; the links cost one allocation per descended-into
 * component and are shared by every child below it. And an upward walk run
 * later, from an idle slice, would find `return` cleared on any fiber React
 * deleted in between; the links record the path the commit actually had.
 * Only the fiber is held — its name and id are resolved when the owner chain
 * is built, from fields React does not clear on deletion (`elementType`,
 * `type`) and from bippy's own id map.
 */
interface AncestorLink {
  /** The composite ancestor. */
  readonly fiber: Fiber;
  /** The composite ancestor above it, or `undefined` at the top. */
  readonly parent: AncestorLink | undefined;
}

/**
 * What the commit callback records about one rendered composite fiber, for
 * the analysis that runs later.
 *
 * Exactly the readings that would not survive until then, and references for
 * everything that will: the profiler's numbers are rewritten when React reuses
 * the fiber, so they are copied now; the fiber itself (for its name, id and
 * key, which React does not rewrite), the ancestry link and
 * `./fiber-diff.js`'s captured pointers are held.
 */
interface CapturedRender {
  /** The fiber that rendered. */
  readonly fiber: Fiber;
  /** Its nearest composite ancestor on the walk's path. */
  readonly parent: AncestorLink | undefined;
  /** `mount` without an alternate, `update` with one. */
  readonly phase: RenderPhase;
  /** `actualStartTime` on the monotonic clock, when React recorded one. */
  readonly relativeStart: number | undefined;
  /** `actualDuration`, when React measured it. */
  readonly actualDuration: number | undefined;
  /** The fiber's cost excluding its direct children, from the same readings. */
  readonly selfTime: number | undefined;
  /** The pointers the prop, hook and context comparisons need. */
  readonly inputs: CapturedFiber;
}

/**
 * One observed commit, waiting in the pending queue for its analysis.
 *
 * Everything the commit event needs is resolved in the callback — its trace,
 * span, timings, root name and the walk's counts — so the event describes the
 * commit as it was, whenever it is emitted.
 */
interface PendingCommit {
  /** The trace and parent resolved once, before the walk. */
  readonly context: EventContext;
  /** The commit event's span, which every render event nests under. */
  readonly spanId: string;
  /** When the callback ran, in epoch milliseconds: the fallback start. */
  readonly observedAt: number;
  /** The commit event's start: the root fiber's render start, or the fallback. */
  readonly startTime: number;
  /** React's measurement of the commit, or the time the callback took. */
  readonly duration: number;
  /** The renderer that committed, when it reported a usable id. */
  readonly rendererId: number | undefined;
  /** The scheduling priority, when it was a finite number. */
  readonly priority: number | undefined;
  /** Which root committed, when its container could be named. */
  readonly rootName: string | undefined;
  /** The captured renders, in traversal order, bounded per commit. */
  readonly renders: readonly CapturedRender[];
  /**
   * How many composite fibers the walk found had rendered, counted past the
   * capture bound and therefore the true total for a walk that completed.
   */
  readonly renderedFibers: number;
  /** How many of those were mounts, for the commit's phase summary. */
  readonly mounts: number;
  /** Whether either per-commit bound stopped the walk or the list short. */
  readonly truncated: boolean;
}

/**
 * The rendered fibers of one commit that one `render` event stands for.
 *
 * Grouped by component name, phase, trigger (for an update), the sorted
 * changed-prop list and the changed-context names — the five things a render
 * event states — so coalescing never merges two renders a reader would have
 * told apart from their events.
 */
interface RenderGroup {
  /** The component's display name. */
  readonly component: string;
  /** The phase every instance shares. */
  readonly phase: RenderPhase;
  /** The trigger every instance shares; absent for a mount, by the rule above. */
  readonly trigger: RenderTrigger | undefined;
  /** The changed-prop names every instance shares, already sorted. */
  readonly changedProps: readonly string[];
  /** The changed-context names every instance shares; empty for a mount. */
  readonly changedContexts: readonly string[];
  /** The first instance in traversal order, whose identity the event carries. */
  readonly representative: CapturedRender;
  /** The group's span, allocated when the group is formed. */
  readonly spanId: string;
  /** How many instances the group holds. */
  instanceCount: number;
  /** The earliest instance start, in epoch milliseconds. */
  startTime: number;
  /** Whether any instance carried a usable `actualDuration`. */
  measured: boolean;
  /** Summed `actualDuration` of the measured instances. */
  totalDuration: number;
  /** Summed self time of the measured instances. */
  totalSelfTime: number;
  /** The largest single `actualDuration`. */
  maxDuration: number;
}

/** The ancestry of one rendered fiber, from its ancestor links. */
interface Ancestry {
  /** Ancestor component names, nearest first, bounded by the owner cap. */
  readonly ownerChain: string[];
  /** The nearest composite ancestor's fiber id, when one was resolved. */
  readonly parentFiberId: number | undefined;
}

/**
 * How the next slice of deferred work is scheduled, so it can be cancelled:
 * an idle callback, or a timer (the fallback, and the backlog task).
 */
type ScheduledSlice =
  | { readonly kind: 'idle'; readonly handle: number }
  | { readonly kind: 'task'; readonly handle: ReturnType<typeof setTimeout> };

/** The host's `requestIdleCallback`, as read off the page's global. */
type RequestIdle = (
  callback: (deadline: IdleDeadline) => void,
  options?: IdleRequestOptions,
) => number;

/** The host's `cancelIdleCallback`. */
type CancelIdle = (handle: number) => void;

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

/**
 * Observed commits waiting for their analysis, oldest first.
 *
 * Bounded by {@link MAX_PENDING_COMMITS} and {@link MAX_PENDING_RENDERS} (see
 * their documentation for the two-stage behaviour), emptied by
 * {@link flushPendingReactWork}, and **discarded** by {@link detachReact} and
 * {@link resetReactCounters}: a queued commit holds references into the
 * developer's fiber tree, and AAP 0.5.1's cleared hook holds none.
 */
let pendingCommits: PendingCommit[] = [];

/** Captured renders across {@link pendingCommits}, for the render bound. */
let pendingRenderCount = 0;

/** The slice currently scheduled, when one is. */
let scheduledSlice: ScheduledSlice | undefined;

/**
 * Advanced every time a slice is scheduled or cancelled; a slice runs only if
 * it still carries the current value.
 *
 * The generation gate `./interaction.js` uses for its deferrals, for the same
 * reason: a cancellation is a request to the page's own timer functions, which
 * can have been replaced by anything, so the callback itself refuses to run
 * once it has been superseded. That is what guarantees that a slice scheduled
 * during one capture can never emit into the next, or after a detach.
 */
let sliceGeneration = 0;

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
 * The ancestor component names and nearest composite parent of one rendered
 * fiber, from the ancestor links the commit walk recorded.
 *
 * Both answers come from one pass because they are the same chain asked
 * twice: the names are the chain, the parent id is the first link's identity.
 * The pass stops as soon as the chain is full, so a deep tree costs
 * {@link MAX_OWNER_CHAIN} steps rather than its depth. Host fibers never
 * became links — a `<div>` between two components is not a level of the
 * component tree — and neither did the rendered fiber itself, so the chain is
 * exactly the composite fibers above it, nearest first: what an upward walk of
 * `return` pointers over the committed tree reads. Called once per coalesced
 * group, for its representative.
 */
function ancestryFrom(link: AncestorLink | undefined): Ancestry {
  const ownerChain: string[] = [];
  let parentFiberId: number | undefined;

  try {
    for (
      let current = link;
      current !== undefined && ownerChain.length < MAX_OWNER_CHAIN;
      current = current.parent
    ) {
      if (ownerChain.length === 0) {
        parentFiberId = fiberIdOf(current.fiber);
      }
      ownerChain.push(componentNameOf(current.fiber));
    }
  } catch {
    // Both readings are guarded already, so this is unreachable by
    // construction; kept because a lost ancestry costs this group its
    // `ownerChain` and nothing else — the event is still worth emitting.
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
 * Advance and read the per-capture count for one component.
 *
 * Advanced before the event is built, so the first render of a component in
 * a capture reports `1` rather than `0` — the number a developer counts the
 * same way — and advanced by the event's instance count, so a group of 48
 * cards moves the count by 48 and the attribute still reads "renders of this
 * component so far in the capture", not "events so far".
 */
function nextRenderCount(component: string, instances: number): number {
  const next = (componentRenderCounts.get(component) ?? 0) + instances;
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
 * The `changedContexts` list of one update: which consumed contexts changed,
 * each named by the component that provides it.
 *
 * `./fiber-diff.js` resolves the names — `provider`, the component rendering
 * the nearest provider of the context, and `contextName`, the context's own
 * `displayName` for when no provider component could be read. A change with
 * neither is skipped: an unnamed entry says nothing a `context` trigger does
 * not already say. De-duplicated in first-seen order, because one provider can
 * supply several changed dependencies; at most {@link MAX_TRACKED_KEYS}
 * entries, the bound every per-render key list shares; and each name cut to
 * {@link MAX_COMPONENT_NAME_LENGTH}, exactly as a `component` attribute is, so
 * an entry equals the `component` of that provider's own `render` event.
 */
function changedContextNames(changes: readonly ContextAttribution[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (names.length >= MAX_TRACKED_KEYS) {
      break;
    }
    const name = boundedString(change.provider ?? change.contextName, MAX_COMPONENT_NAME_LENGTH);
    if (name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * The attribute bag for one coalesced group of rendered fibers.
 *
 * Four decisions are recorded here because each looks like an oversight to a
 * reader who does not know the contract:
 *
 * - **`trigger` is written only for an update.** See the module
 *   documentation: a mount's `unknown` classification is an artefact of having
 *   no previous fiber, and emitting it would inflate
 *   `render_trigger_unknown_count` with the one case nobody needs explained
 *   (AAP 0.2.3). This is the single most consequential line in the file for
 *   the excessive-render acceptance test. A group never mixes the two phases,
 *   so the rule holds per event exactly as it held per fiber.
 * - **`changedProps` is the plain key list.** `./fiber-diff.js` compares the
 *   prop values and reports their names; it composes no summary of them on
 *   this path at all, because the names are what `../aggregate/renders.ts`
 *   and the `renderTable` read, and the values of hooks and contexts belong to
 *   the `state` events `./state.js` emits, where a single privacy boundary
 *   governs them.
 * - **`instanceCount` and `maxInstanceDuration` only for a real group.** An
 *   event that stands for one fiber is written exactly as before coalescing
 *   existed, so every reader that predates the two keys — and every event
 *   recorded before them — reads a single-instance event correctly by
 *   defaulting the weight to one.
 * - **`changedContexts` is names only, and only for an update.** It says which
 *   context a `context` trigger refers to — "context change: ‹provider›" (AAP
 *   0.8.2) — by the providing component's name, never by the value, which
 *   stays with the `state` events. A mount has no previous value to have
 *   changed from, so it never carries the key; an update carries it whenever a
 *   consumed context changed and could be named, including one whose trigger
 *   is `props` because a prop changed too. The names are part of the group's
 *   key, so every instance of a group shares them.
 * - **Every absent field is omitted rather than written as `null`.** Absence
 *   is how this product says "not observed", and the aggregates read it that
 *   way.
 */
function buildGroupAttributes(group: RenderGroup, context: EventContext): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    [KEY_COMPONENT]: group.component,
    [KEY_PHASE]: group.phase,
    [KEY_RENDER_COUNT]: nextRenderCount(group.component, group.instanceCount),
    [KEY_CHANGED_PROPS]: [...group.changedProps],
  };

  if (group.phase === 'update' && group.trigger !== undefined) {
    // The classification is `./fiber-diff.js`'s; the annotation on the field
    // is the compile-time check that its vocabulary is still the catalog's,
    // since the two are declared independently.
    attributes[KEY_TRIGGER] = group.trigger;
    if (group.changedContexts.length > 0) {
      attributes[KEY_CHANGED_CONTEXTS] = [...group.changedContexts];
    }
  }

  if (group.measured) {
    attributes[KEY_ACTUAL_DURATION] = group.totalDuration;
    attributes[KEY_SELF_TIME] = group.totalSelfTime;
  }

  if (group.instanceCount > 1) {
    attributes[KEY_INSTANCE_COUNT] = group.instanceCount;
    if (group.measured) {
      attributes[KEY_MAX_INSTANCE_DURATION] = group.maxDuration;
    }
  }

  const representative = group.representative;
  const ancestry = ancestryFrom(representative.parent);
  if (ancestry.ownerChain.length > 0) {
    attributes[KEY_OWNER_CHAIN] = ancestry.ownerChain;
  }
  const fiberId = fiberIdOf(representative.fiber);
  if (fiberId !== undefined) {
    attributes[KEY_FIBER_ID] = fiberId;
  }
  if (ancestry.parentFiberId !== undefined) {
    attributes[KEY_PARENT_FIBER_ID] = ancestry.parentFiberId;
  }

  const key = keyOf(representative.fiber);
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
 * @param link The nearest composite ancestor link the children sit under.
 * @param pending The walk's stack, pushed in place.
 * @param pendingLinks The stack of the links for {@link pending}'s entries,
 * pushed in step with it.
 * @param visitBudget How many more fibers the walk may hold and visit.
 * @returns `true` when the sibling list was longer than the budget, which is a
 * truncation the commit event has to report.
 */
function queueCommitChildren(
  fiber: Fiber,
  link: AncestorLink | undefined,
  pending: Fiber[],
  pendingLinks: (AncestorLink | undefined)[],
  visitBudget: number,
): boolean {
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
      pendingLinks.push(link);
    }
  }
  return child !== null;
}

/** What one commit's walk recorded. */
interface WalkResult {
  /** The captured renders, in traversal order, bounded by the capture bound. */
  readonly renders: CapturedRender[];
  /** Rendered composite fibers counted, past the capture bound. */
  readonly renderedFibers: number;
  /** How many of those were mounts. */
  readonly mounts: number;
  /** Whether either per-commit bound stopped the walk or the list short. */
  readonly truncated: boolean;
}

/**
 * One commit's traversal, inside the commit: a {@link CapturedRender} per
 * rendered composite fiber, for the analysis that runs later.
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
 * What it records per rendered fiber is only what the deferred analysis
 * cannot read later (see {@link CapturedRender}): a handful of property reads,
 * `./fiber-diff.js`'s `captureFiber` and, for a component whose children are
 * walked, one {@link AncestorLink}. No comparison, name, id, span or event is
 * built here.
 *
 * Every per-fiber body is inside its own `try`, which is the point of the loop
 * being written this way: a fiber from a renderer this module has not seen
 * costs itself and is counted, while the rest of the commit is still observed.
 * A commit is the unit a developer reads, and losing all of it to one bad
 * fiber would be the failure mode hardest to explain.
 */
function captureRenders(rootFiber: Fiber | undefined): WalkResult {
  const renders: CapturedRender[] = [];
  let renderedFibers = 0;
  let mounts = 0;
  let truncated = false;

  if (rootFiber === undefined) {
    // A root React has torn down, or one mid-teardown: there is no tree to
    // walk, and the commit event is still worth emitting without renders.
    return { renders, renderedFibers, mounts, truncated };
  }

  // Seeded with the committed tree's root fiber and never its siblings: a
  // `HostRoot` has none, and `readRootFiber` has already resolved whichever
  // of the two shapes the hook was handed. The link stack runs in step with
  // the fiber stack: entry `i` of one is the nearest composite ancestor of
  // entry `i` of the other.
  const pending: Fiber[] = [rootFiber];
  const pendingLinks: (AncestorLink | undefined)[] = [undefined];
  let visits = 0;

  while (pending.length > 0) {
    const fiber = pending.pop();
    const link = pendingLinks.pop();
    if (fiber === undefined) {
      break;
    }

    visits += 1;
    if (visits > MAX_FIBER_VISITS_PER_COMMIT) {
      // The walk's own bound, and the reason a commit costs the page a
      // predictable amount: the capture bound below stops records, this stops
      // work. It is also what terminates a cyclic hand-built structure, which
      // is why this hot path carries no set of visited fibers.
      truncated = true;
      break;
    }

    try {
      // Whether this fiber is a component decides the link its children sit
      // under, so it is asked before they are queued — but a renderer bippy
      // does not recognise throws here, and the descent decision must not be
      // lost to that: a subtree kept when one hostile fiber above it failed is
      // evidence that would otherwise be lost for a reason the developer
      // cannot see. So the failure is held until the children are queued, and
      // the fiber is stepped over like a host fiber in the meantime.
      let composite = false;
      let compositeFailure: { readonly error: unknown } | undefined;
      try {
        composite = isCompositeFiber(fiber);
      } catch (error) {
        compositeFailure = { error };
      }

      const previous: Fiber | null = fiber.alternate ?? null;
      if (previous === null || fiber.child !== previous.child) {
        const childLink: AncestorLink | undefined = composite ? { fiber, parent: link } : link;
        if (
          queueCommitChildren(
            fiber,
            childLink,
            pending,
            pendingLinks,
            MAX_FIBER_VISITS_PER_COMMIT - visits - pending.length,
          )
        ) {
          truncated = true;
        }
      }

      if (compositeFailure !== undefined) {
        // Reported exactly as the per-fiber guard below reports, now that the
        // children are safe on the stack.
        failureCount += 1;
        reportProducerFailure('react', 'commit-traversal', compositeFailure.error);
        continue;
      }

      if (!composite || !didFiberRender(fiber)) {
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

      if (renders.length >= MAX_RENDERS_PER_COMMIT) {
        // Counting continues past the capture bound so `renderedFiberCount` is
        // the true total rather than "at least the cap", which is the
        // difference between a reader concluding "500 components rendered" and
        // "8 000 did, and 500 are listed". The walk carries on under the visit
        // bound, and stops there.
        truncated = true;
        continue;
      }

      // The profiler's readings are copied now: React rewrites them when it
      // next reuses this fiber, which can happen before the analysis runs.
      const actualDuration = durationValue((fiber as ProfiledFiber).actualDuration);
      renders.push({
        fiber,
        parent: link,
        phase,
        relativeStart: finiteNumber((fiber as ProfiledFiber).actualStartTime),
        actualDuration,
        selfTime: selfTimeOf(fiber, actualDuration),
        inputs: captureFiber(fiber),
      });
    } catch (error) {
      failureCount += 1;
      // One fiber's worth of the commit is missing from the render table, and
      // the report is what keeps that absence from reading as "this component
      // did not render".
      reportProducerFailure('react', 'commit-traversal', error);
    }
  }

  return { renders, renderedFibers, mounts, truncated };
}

/**
 * Everything the commit callback records about one commit: its trace and
 * span, the root's timings and name, and the walk.
 *
 * The synchronous half of the commit's handling, and deliberately all of it
 * that has to be: the trace is resolved once, before any fiber is visited, so
 * an interaction window cannot close mid-traversal and split one commit
 * across two traces; the root's profiler readings are rewritten by React's
 * next render; and the walk reads the tree React holds *now*. The root name is
 * two property reads on the container element, taken here so the queue does
 * not have to hold the root.
 *
 * `startTime` is the root fiber's own render start rather than the instant
 * this callback ran: React invokes the hook *after* the render phase, so a
 * wall-clock reading here would place the commit after the renders it
 * contains, and the timeline would draw children starting before their parent.
 */
function captureCommit(rendererId: number, root: FiberRoot, priority: unknown): PendingCommit {
  const context = resolveEventContext();
  const spanId = newSpanId();
  const observedAt = nowEpochMs();

  const rootFiber: Fiber | undefined = readRootFiber(root);
  const rootDuration =
    rootFiber === undefined
      ? undefined
      : durationValue((rootFiber as ProfiledFiber).actualDuration);
  const rootStart =
    rootFiber === undefined
      ? undefined
      : finiteNumber((rootFiber as ProfiledFiber).actualStartTime);

  const walk = captureRenders(rootFiber);

  return {
    context,
    spanId,
    observedAt,
    startTime: rootStart !== undefined && rootStart > 0 ? toEpochMs(rootStart) : observedAt,
    // React's own measurement of the commit where it made one; otherwise the
    // time this module spent observing it, which is an honest lower bound and
    // is never negative.
    duration: rootDuration ?? Math.max(0, nowEpochMs() - observedAt),
    rendererId: finiteNumber(rendererId),
    priority: finiteNumber(priority),
    rootName: rootNameOf(root),
    renders: walk.renders,
    renderedFibers: walk.renderedFibers,
    mounts: walk.mounts,
    truncated: walk.truncated,
  };
}

/**
 * The commit event: the parent span of the render events built under it.
 *
 * Built **after** the render groups so `renderCount` is the exact number of
 * fibers the commit's render events stand for. It still leads the emitted
 * batch, so its sequence number precedes its children's and a raw event log
 * ordered by sequence reads parent-first.
 *
 * @param commit The commit as the callback recorded it.
 * @param reportedFibers The instances the emitted render events stand for.
 */
function buildCommitDraft(commit: PendingCommit, reportedFibers: number): EventDraft {
  const attributes: Record<string, unknown> = {
    [KEY_COMMIT_RENDER_COUNT]: reportedFibers,
    [KEY_RENDERED_FIBER_COUNT]: commit.renderedFibers,
  };

  if (commit.renderedFibers > 0) {
    // A commit in which every rendered fiber was a mount is a mount; one that
    // updated anything is an update. A commit that rendered nothing — React
    // committing effects only — gets no phase, because neither value would be
    // true of it. Annotated so the summary is held to the same vocabulary as a
    // render's own phase.
    const phaseSummary: RenderPhase = commit.mounts === commit.renderedFibers ? 'mount' : 'update';
    attributes[KEY_COMMIT_PHASE] = phaseSummary;
  }
  if (commit.rendererId !== undefined) {
    attributes[KEY_RENDERER_ID] = commit.rendererId;
  }
  if (commit.rootName !== undefined) {
    attributes[KEY_ROOT_NAME] = commit.rootName;
  }
  if (commit.truncated) {
    attributes[KEY_TRUNCATED] = true;
  }
  if (commit.priority !== undefined) {
    attributes[KEY_PRIORITY] = commit.priority;
  }

  mergeLineage(attributes, commit.context.attributes);

  const draft: EventDraft = {
    traceId: commit.context.traceId,
    spanId: commit.spanId,
    kind: COMMIT_KIND,
    name: COMMIT_EVENT_NAME,
    startTime: commit.startTime,
    duration: commit.duration,
    attributes,
    status: OK_STATUS,
  };

  if (commit.context.parentSpanId !== undefined) {
    draft.parentSpanId = commit.context.parentSpanId;
  }

  return draft;
}

/**
 * The key two instances of one commit must share to be one `render` event.
 *
 * Exactly the four things the event states about *why* its fibers rendered —
 * component, phase, trigger and the sorted changed-prop names — so coalescing
 * never merges two renders a reader could have told apart. Encoded as JSON so
 * the key is unambiguous whatever a display name contains; `changedProps`
 * arrives sorted from `./fiber-diff.js`, so two instances whose props changed
 * in a different order still share a key.
 */
function groupKeyOf(
  component: string,
  phase: RenderPhase,
  trigger: RenderTrigger | undefined,
  changedProps: readonly string[],
  changedContexts: readonly string[],
): string {
  return JSON.stringify([component, phase, trigger ?? null, changedProps, changedContexts]);
}

/** An instance's render start, in epoch milliseconds, or the commit's fallback. */
function instanceStartOf(instance: CapturedRender, commit: PendingCommit): number {
  const relative = instance.relativeStart;
  return relative !== undefined && relative > 0 ? toEpochMs(relative) : commit.observedAt;
}

/**
 * Folds one analysed instance into its group, creating the group on first
 * sight, and queues the instance's state transitions under the group's span.
 */
function addToGroup(
  groups: Map<string, RenderGroup>,
  order: RenderGroup[],
  transitions: PendingTransitions[],
  commit: PendingCommit,
  instance: CapturedRender,
  analysis: RenderAnalysis,
): void {
  const component = componentNameOf(instance.fiber);
  // The mount rule, applied before grouping so a group key can never carry a
  // mount's artefactual `unknown` (see the module documentation).
  const trigger: RenderTrigger | undefined =
    instance.phase === 'update' ? analysis.trigger : undefined;
  // Names only, and only for an update (see `buildGroupAttributes`).
  const changedContexts =
    instance.phase === 'update' ? changedContextNames(analysis.changedContexts) : [];
  const key = groupKeyOf(
    component,
    instance.phase,
    trigger,
    analysis.changedProps,
    changedContexts,
  );
  const startTime = instanceStartOf(instance, commit);

  let group = groups.get(key);
  if (group === undefined) {
    group = {
      component,
      phase: instance.phase,
      trigger,
      changedProps: analysis.changedProps,
      changedContexts,
      representative: instance,
      spanId: newSpanId(),
      instanceCount: 0,
      startTime,
      measured: false,
      totalDuration: 0,
      totalSelfTime: 0,
      maxDuration: 0,
    };
    groups.set(key, group);
    order.push(group);
  }

  group.instanceCount += 1;
  if (startTime < group.startTime) {
    group.startTime = startTime;
  }
  if (instance.actualDuration !== undefined) {
    group.measured = true;
    group.totalDuration += instance.actualDuration;
    group.totalSelfTime += instance.selfTime ?? 0;
    if (instance.actualDuration > group.maxDuration) {
      group.maxDuration = instance.actualDuration;
    }
  }

  if (analysis.hookChanges.length > 0 || analysis.contextChanges.length > 0) {
    transitions.push({
      component,
      fiberId: fiberIdOf(instance.fiber),
      renderSpanId: group.spanId,
      startTime,
      hookChanges: analysis.hookChanges,
      // Present when the dimension was read — an empty list then means
      // "nothing changed" — and absent when it could not be evaluated, which
      // is the distinction `./state.js` documents on its input.
      contextChanges:
        analysis.contextChanges.length > 0 || analysis.evaluable.context
          ? analysis.contextChanges
          : undefined,
    });
  }
}

/** One group as its `render` draft, nested under the commit's span. */
function buildGroupDraft(commit: PendingCommit, group: RenderGroup): EventDraft {
  return {
    traceId: commit.context.traceId,
    spanId: group.spanId,
    // The commit, not the interaction: a render nests inside the commit that
    // performed it, and the commit nests under the interaction. That is what
    // makes the timeline's band-inside-band reading correct.
    parentSpanId: commit.spanId,
    kind: RENDER_KIND,
    name: group.component,
    startTime: group.startTime,
    duration: group.measured ? group.totalDuration : 0,
    attributes: buildGroupAttributes(group, commit.context),
    status: OK_STATUS,
  };
}

/**
 * Analyses one queued commit and emits it: the deferred half of the commit's
 * handling.
 *
 * Each captured instance is compared (`./fiber-diff.js`'s
 * `analyzeCapturedFiber`, describing hook and context transitions only when
 * `transitions` says `./state.js` will record them), named and folded into its
 * group, inside its own `try`; the groups become render drafts in the order
 * their first instances were walked; the commit draft is built last, so its
 * `renderCount` is exact, and leads the one {@link emitMany} batch; the
 * per-instance transitions follow.
 *
 * @param commit The commit, as the callback recorded it.
 * @param options The analysis options for this pass: whether to describe
 * transitions, and the pass's summary memo.
 */
function processCommit(commit: PendingCommit, options: CapturedFiberAnalysisOptions): void {
  const groups = new Map<string, RenderGroup>();
  const order: RenderGroup[] = [];
  const transitions: PendingTransitions[] = [];

  for (const instance of commit.renders) {
    try {
      addToGroup(
        groups,
        order,
        transitions,
        commit,
        instance,
        analyzeCapturedFiber(instance.inputs, options, instance.fiber),
      );
    } catch (error) {
      failureCount += 1;
      // One instance is missing from its group's count, and the report is what
      // keeps that absence from reading as "this component did not render".
      reportProducerFailure('react', 'commit-analysis', error);
    }
  }

  const drafts: EventDraft[] = [];
  let reportedFibers = 0;
  for (const group of order) {
    try {
      drafts.push(buildGroupDraft(commit, group));
      reportedFibers += group.instanceCount;
    } catch (error) {
      failureCount += 1;
      reportProducerFailure('react', 'commit-analysis', error);
    }
  }

  renderEventCount += drafts.length;
  if (commit.truncated) {
    truncatedCommitCount += 1;
  }

  // One hand-off: one capture gate, consecutive sequence numbers for the
  // whole commit, and the commit event ahead of the renders it parents.
  emitMany([buildCommitDraft(commit, reportedFibers), ...drafts]);

  flushTransitions(commit.context, transitions);
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
 * The pending queue and its scheduler
 *
 * Commits are analysed in arrival order, a whole commit at a time, from idle
 * slices. Every entry point here is total: an idle callback or timer that
 * threw would surface in the page's own task, and a flush that threw would
 * surface in `./agent.js`'s capture-stop path.
 * ---------------------------------------------------------------------------
 */

/**
 * The analysis options for one processing pass.
 *
 * Hook and context values are summarised only while `./state.js` is armed:
 * `state` events are their only reader, and `recordStateTransitions` drops
 * everything outside an armed capture anyway, so summarising them otherwise
 * would compose and scrub previews nobody receives. The memo is per pass —
 * one slice, or one flush — because a pass is synchronous: a value met twice
 * in it is summarised identically both times, and the demo's cart context
 * value is met by close to a hundred consumers per commit.
 */
function passOptions(): CapturedFiberAnalysisOptions {
  let transitions = false;
  try {
    transitions = isStateAttached();
  } catch {
    // `isStateAttached` reads one module flag and cannot throw; guarded
    // because a failure here must cost the transitions, never the renders.
  }
  return transitions ? { transitions, memo: createSummaryMemo() } : {};
}

/**
 * {@link processCommit}, contained: a commit whose analysis or hand-off throws
 * costs that commit, is counted and reported, and never stops the loop that
 * is working off the rest of the queue — whether that loop is an idle slice,
 * a drain or the commit callback's overflow path.
 */
function processCommitSafely(commit: PendingCommit, options: CapturedFiberAnalysisOptions): void {
  try {
    processCommit(commit, options);
  } catch (error) {
    failureCount += 1;
    // The whole commit is missing: no commit event, no render events. The
    // report is what keeps that absence from reading as a quiet page.
    reportProducerFailure('react', 'commit-processing', error);
  }
}

/** Takes the oldest queued commit off the queue, keeping the render count in step. */
function takeOldestPending(): PendingCommit | undefined {
  const commit = pendingCommits.shift();
  if (commit !== undefined) {
    pendingRenderCount = Math.max(0, pendingRenderCount - commit.renders.length);
  }
  return commit;
}

/** Whether the queue is past its soft bound, so the next slice should not wait for idle. */
function isBacklogged(): boolean {
  return pendingCommits.length > MAX_PENDING_COMMITS || pendingRenderCount > MAX_PENDING_RENDERS;
}

/** Whether the queue is past its hard bound, twice the soft one. */
function isOverflowing(): boolean {
  return (
    pendingCommits.length > MAX_PENDING_COMMITS * 2 || pendingRenderCount > MAX_PENDING_RENDERS * 2
  );
}

/** A monotonic reading for slice budgets, or `NaN` when the clock is unreadable. */
function monotonicNow(): number {
  try {
    return performance.now();
  } catch {
    // A page that replaced `performance` with a throwing accessor gets
    // one-commit slices: `NaN` fails every budget comparison.
    return Number.NaN;
  }
}

/**
 * Whether a slice that began at `startedAt` may take on another commit.
 *
 * An idle deadline that has not timed out is the browser's own answer; every
 * other slice — the timer fallback, the backlog task and an idle callback that
 * fired on its `timeout` — is held to {@link SLICE_BUDGET_MS} of the monotonic
 * clock. A clock that does not advance (a test's frozen clock) lets a slice
 * finish the queue, which terminates because the queue is finite.
 */
function sliceHasTime(deadline: IdleDeadline | undefined, startedAt: number): boolean {
  try {
    if (deadline !== undefined && !deadline.didTimeout) {
      return deadline.timeRemaining() > MIN_IDLE_REMAINING_MS;
    }
    return monotonicNow() - startedAt < SLICE_BUDGET_MS;
  } catch {
    return false;
  }
}

/**
 * Cancels the scheduled slice, if there is one, and disarms it whatever the
 * cancellation does.
 *
 * The generation is advanced first, so a slice whose timer the page's
 * `clearTimeout` failed to cancel still refuses to run (see
 * {@link sliceGeneration}).
 */
function cancelScheduledSlice(): void {
  sliceGeneration += 1;
  const slice = scheduledSlice;
  scheduledSlice = undefined;
  if (slice === undefined) {
    return;
  }
  try {
    if (slice.kind === 'idle') {
      const cancel = (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
      if (typeof cancel === 'function') {
        (cancel as CancelIdle).call(globalThis, slice.handle);
      }
    } else {
      clearTimeout(slice.handle);
    }
  } catch {
    // The generation above has already disarmed the callback, so a
    // cancellation the page's timer functions refused costs one no-op call.
  }
}

/**
 * Makes sure a slice is scheduled for the queued work.
 *
 * An idle callback with the {@link IDLE_TIMEOUT_MS} deadline normally, a timer
 * where the host has no `requestIdleCallback` (or it throws), and a zero-delay
 * task when `urgent` — the queue is past its soft bound — which also replaces
 * a pending idle callback. A slice already scheduled at the requested urgency
 * is left alone, so a burst of commits schedules one slice, not one each.
 */
function scheduleSlice(urgent: boolean): void {
  if (scheduledSlice !== undefined) {
    if (!urgent || scheduledSlice.kind === 'task') {
      return;
    }
    cancelScheduledSlice();
  }

  sliceGeneration += 1;
  const generation = sliceGeneration;

  if (!urgent) {
    try {
      const request = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
      if (typeof request === 'function') {
        const handle = (request as RequestIdle).call(
          globalThis,
          (deadline) => {
            runSlice(generation, deadline);
          },
          { timeout: IDLE_TIMEOUT_MS },
        );
        scheduledSlice = { kind: 'idle', handle };
        return;
      }
    } catch {
      // A page that broke `requestIdleCallback` gets the timer below instead.
    }
  }

  try {
    const handle = setTimeout(
      () => {
        runSlice(generation, undefined);
      },
      urgent ? 0 : FALLBACK_DELAY_MS,
    );
    scheduledSlice = { kind: 'task', handle };
  } catch (error) {
    // Nothing will run the queue on its own now; it is still bounded (the
    // commit callback works off the oldest commit past the hard bound) and
    // still drained at every terminal point, so no evidence is lost — but a
    // capture whose renders arrive late is one the developer should know is
    // degraded.
    failureCount += 1;
    reportProducerFailure('react', 'commit-schedule', error);
  }
}

/**
 * One slice of deferred work: whole commits, oldest first, while the slice
 * has time — always at least one — and then another slice for whatever is
 * left.
 *
 * @param generation The generation the slice was scheduled under; a slice
 * that has been superseded or cancelled returns without touching anything.
 * @param deadline The idle deadline, when the host provided one.
 */
function runSlice(generation: number, deadline: IdleDeadline | undefined): void {
  try {
    if (generation !== sliceGeneration) {
      return;
    }
    scheduledSlice = undefined;

    const options = passOptions();
    const startedAt = monotonicNow();
    let commit = takeOldestPending();
    while (commit !== undefined) {
      processCommitSafely(commit, options);
      if (pendingCommits.length === 0 || !sliceHasTime(deadline, startedAt)) {
        break;
      }
      commit = takeOldestPending();
    }

    if (pendingCommits.length > 0) {
      scheduleSlice(isBacklogged());
    }
  } catch (error) {
    failureCount += 1;
    // A slice that failed part-way leaves the rest of the queue for the next
    // slice or the next flush; the report is what says a commit went missing.
    reportProducerFailure('react', 'commit-processing', error);
    if (pendingCommits.length > 0 && scheduledSlice === undefined) {
      scheduleSlice(true);
    }
  }
}

/**
 * Analyses and emits every queued commit now, synchronously and in order.
 *
 * The deferred pipeline's drain. `./agent.js` calls it wherever a capture's
 * evidence has to be complete before the next step — before a capture stops
 * (so the component-tree snapshot's counts and the final transport flush
 * include every observed commit), before `pagehide` and a hidden page's flush,
 * before a capture change or reconfiguration resets the producers, and before
 * {@link detachReact} when the React hook alone is being cleared.
 * {@link snapshotComponentTree} calls it too, so a snapshot's render counts are
 * never behind the events already observed.
 *
 * Idempotent and cheap on an empty queue; cancels the scheduled slice either
 * way, since there is nothing left for it. Emits through `./transport.js`,
 * which drops everything outside an armed capture — so a drain after the
 * transport was disabled loses exactly what a synchronous emission at that
 * moment would have lost, and a caller that wants the evidence drains first.
 * Never throws.
 *
 * @example
 * ```ts
 * flushPendingReactWork(); // every observed commit is now in the transport's buffer
 * flush();                 // ./transport.js: post it
 * ```
 */
export function flushPendingReactWork(): void {
  try {
    cancelScheduledSlice();
    if (pendingCommits.length === 0) {
      return;
    }
    const options = passOptions();
    for (let commit = takeOldestPending(); commit !== undefined; commit = takeOldestPending()) {
      processCommitSafely(commit, options);
    }
  } catch (error) {
    failureCount += 1;
    reportProducerFailure('react', 'commit-processing', error);
  }
}

/**
 * Whether any observed commit is still waiting for its analysis.
 *
 * For diagnostics and tests: `false` after {@link flushPendingReactWork},
 * {@link detachReact} and {@link resetReactCounters}, which is the observable
 * form of "this module holds no reference into the page's fiber tree beyond
 * the retained root". Cannot throw.
 */
export function hasPendingReactWork(): boolean {
  return pendingCommits.length > 0 || scheduledSlice !== undefined;
}

/**
 * Drops every queued commit unprocessed and cancels the scheduled slice.
 *
 * What a cleared hook and a new capture both require: a queued commit belongs
 * to the capture that observed it, and a hook that has been cleared emits
 * nothing more (AAP 0.5.1). Evidence a caller wants kept is drained with
 * {@link flushPendingReactWork} *before* this runs.
 */
function discardPendingReactWork(): void {
  cancelScheduledSlice();
  pendingCommits = [];
  pendingRenderCount = 0;
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
 * One React commit: record it, and leave its analysis to an idle slice.
 *
 * The order of the steps is the contract:
 *
 * 1. Retain the root, so a snapshot taken later has a tree to walk even if
 *    this commit rendered nothing.
 * 2. Resolve the trace **once**, before any fiber is visited. Asking per fiber
 *    — or at analysis time — would let an interaction window close
 *    mid-traversal and split one commit across two traces, or attribute it to
 *    whatever happened next.
 * 3. Walk the changed subtree, capturing each rendered component under the
 *    per-commit bounds ({@link captureCommit}).
 * 4. Queue the capture and make sure a slice is scheduled. Past the queue's
 *    hard bound the oldest commit is analysed here and now, which is the cost
 *    the synchronous design paid on every commit and bounds memory under any
 *    storm.
 *
 * The analysis — comparisons, grouping, drafts, emission and the hand-off to
 * `./state.js` — happens in {@link processCommit}.
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

    const commit = captureCommit(rendererId, root, priority);
    pendingCommits.push(commit);
    pendingRenderCount += commit.renders.length;

    if (isOverflowing()) {
      const options = passOptions();
      while (isOverflowing()) {
        const oldest = takeOldestPending();
        if (oldest === undefined) {
          break;
        }
        processCommitSafely(oldest, options);
      }
    }

    scheduleSlice(isBacklogged());
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
 * 2. **Forget.** The counters, the pending queue, the per-component render
 *    counts and the retained fiber root, each in its own guard (see
 *    {@link detachStep}), so one failing step never skips the rest. The queue
 *    is **discarded**, not processed: a detach is the hook being cleared, and
 *    a cleared hook emits nothing more (AAP 0.5.1) — its scheduled slice is
 *    cancelled and disarmed by generation, so not even a timer the page failed
 *    to cancel can emit after this returns. `./agent.js` drains the queue with
 *    {@link flushPendingReactWork} before it detaches, while the capture that
 *    observed those commits can still receive them.
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
  detachStep('discard-pending', discardPendingReactWork);
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
 * Be told when a React renderer registers with the DevTools hook — the moment
 * {@link detectReact} turns true.
 *
 * Callable while dormant, for the same reason {@link detectReact} is: the
 * `agent.ready` frame announced at `document_start` says `reactDetected:
 * false` whenever the application's bundle has not run yet, which is the
 * ordinary case, and the service judges the page by that frame. `./agent.js`
 * uses this to announce the correction when React actually registers, rather
 * than whenever something next happens to prompt a re-check.
 *
 * It observes nothing of the application. The listener rides on the hook's
 * own renderer registry — bippy's `onRendererInject`, called from the hook's
 * `inject`, which React calls once per renderer as `react-dom` initialises —
 * and receives no fiber, no root and no commit. Nothing is patched here:
 * `bippy/install-hook-only` already installed or patched the hook at
 * `document_start`, and bippy re-patches a hook that replaces it.
 *
 * - **No hook, no subscription.** `hasRDTHook()` is asked first because
 *   subscribing goes through bippy's `getRDTHook()`, which *installs* a hook
 *   when none is present, and a notice must not change the page it watches.
 *   `undefined` is returned, and the caller relies on its other re-checks.
 * - **Never into React's `inject`.** The listener runs inside React's own
 *   registration call, so whatever it throws is contained here.
 * - **Only future registrations.** A renderer registered before the call is
 *   not reported; ask {@link detectReact} right after subscribing.
 *
 * @param listener Called once per renderer that registers after this call.
 * @returns Releases the listener, idempotently and without throwing; or
 * `undefined` when no subscription was made.
 *
 * @example
 * ```ts
 * const release = watchReactRegistration(() => announce());
 * if (detectReact()) { release?.(); announce(); }
 * ```
 */
export function watchReactRegistration(listener: () => void): (() => void) | undefined {
  try {
    if (!hasRDTHook()) {
      return undefined;
    }

    const unsubscribe = onRendererInject(() => {
      try {
        listener();
      } catch {
        // Contained: this runs inside React's registration call.
      }
    });
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;
      try {
        unsubscribe();
      } catch {
        // The listener is dropped with the handle either way.
      }
    };
  } catch {
    return undefined;
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
 * Queued commits are drained first ({@link flushPendingReactWork}): each
 * node's `renderCount` is read from the per-capture counts, which advance when
 * a commit is analysed, so a snapshot taken with commits still queued would
 * report fewer renders than the capture observed — and fewer than its own
 * `render` events, once those arrive.
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
    flushPendingReactWork();
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
 * It **does** discard the pending queue. A commit still queued here was
 * observed during the previous capture; analysed after this reset it would be
 * counted into the new capture's render counts and — once `./agent.js`
 * reconfigures the transport — stamped with the new capture's id, which is
 * evidence from one capture presented as another's. `./agent.js` drains the
 * queue with {@link flushPendingReactWork} before it resets, while the
 * transport still carries the old capture, so the discard is the guarantee
 * rather than the mechanism.
 *
 * Cannot throw.
 */
export function resetReactCounters(): void {
  discardPendingReactWork();
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
