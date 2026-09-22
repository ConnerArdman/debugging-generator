// @vitest-environment happy-dom
/**
 * Colocated tests for `./react.ts` — the fiber-hook observer that turns React's
 * commits into the `commit` and `render` events every render-related panel node
 * is built from.
 *
 * **What this suite owns.** AAP §0.8.3 names this file by path in the row
 * "React fiber hook compatibility and privacy": it must "render a React 19.3.0
 * tree under happy-dom with bippy 0.7.3 installed first and assert commit
 * traversal yields the expected components, phases and durations". It is
 * therefore the only automated proof of three things the rest of the product
 * merely assumes:
 *
 * 1. **The hook-before-React ordering is achievable** (AAP §0.1.1). The agent
 *    is a MAIN-world content script at `document_start` precisely so the
 *    DevTools hook exists before the page's React registers with it. Nothing
 *    downstream can recover from getting that wrong — React registers once —
 *    so the ordering is asserted mechanically here rather than described.
 * 2. **The traversal produces the attribute vocabulary the aggregates read**
 *    (AAP §0.2.3). `component`, `phase`, `renderCount`, `changedProps` and
 *    `trigger` feed `render_count`, `unchanged_render_count` and
 *    `render_trigger_unknown_count`; the second of those metrics is only
 *    honest if a **mount carries no `trigger` at all**, which is the single
 *    most consequential assertion below.
 * 3. **A cleared hook is disabled rather than idled** (AAP §0.5.1).
 *    `detachReact()` must call the function `instrument()` returned, and the
 *    observable form of that is: a later commit produces nothing.
 *
 * **The hoisting hazard, and how this file answers it.** An `import` statement
 * runs before any module-level code, so a static `import { createRoot } from
 * "react-dom/client"` at the top would load the renderer before
 * `installRDTHook()` could run and the suite would then pass, or fail, for a
 * reason that has nothing to do with the product. Only `react-dom` registers a
 * renderer with the hook, and it does so at module evaluation, so the renderer
 * is loaded through a **dynamic** `await import(…)` that cannot be hoisted
 * above the install. Two module-scope readings taken either side of that
 * import — {@link RENDERERS_BEFORE_REACT_DOM} and the renderer count the first
 * suite reads afterwards — are the mechanical proof, and they are assertions
 * rather than comments.
 *
 * `react` itself is a different matter and is deliberately not fought: bippy's
 * own entry point imports it (`import * as React from "react"`), and the
 * automatic JSX runtime this `.tsx` file compiles against adds a hoisted
 * `react/jsx-runtime` import of its own. Neither touches the hook — loading
 * the `react` package registers no renderer — which is exactly why the
 * ordering assertion is written against `renderers.size` and not against
 * whether the `react` module happens to be evaluated.
 *
 * **Two paths, one set of assertions.** Every commit assertion goes through
 * {@link expectWellFormedCommit} and is exercised twice: once by a real React
 * 19.3.0 tree rendered with `react-dom/client` under happy-dom, and once by a
 * hand-built fiber root driven straight through the installed hook
 * (`getRDTHook().onCommitFiberRoot(1, root)`). The synthetic path is not a
 * stand-in — it is how the bounds (`MAX_RENDERS_PER_COMMIT`,
 * `MAX_OWNER_CHAIN`) and the hostile-value cases (an absent or negative
 * `actualDuration`) are reached at all, since React will not produce them on
 * request — and it also means the traversal contract stays proven if
 * `react-dom` is ever unavailable, in which case the React block *skips* with
 * a stated reason instead of vanishing.
 *
 * **Why no duration is ever asserted exactly.** `actualDuration` and
 * `actualStartTime` come from React's profiling timer in a development build,
 * on a shared CI host, under happy-dom's clock. The product's value is in the
 * relative ordering and the aggregate counts, not in microsecond accuracy —
 * which is why AAP §0.8.3 asks for "the expected components, phases and
 * durations" and not for numbers. Every timing assertion here is therefore a
 * *kind* assertion: finite, non-negative, and an epoch-millisecond reading of
 * this machine's clock ({@link expectAdvisoryTiming}). A later contributor
 * must not tighten them into equalities; they would pass locally and flake
 * everywhere else.
 *
 * **Harness.** The root `vitest.config.ts` collects this file into the
 * `telemetry` project, which already runs under happy-dom; the docblock on
 * line 1 states the requirement locally anyway, because this file mounts into
 * a real document and must keep working whatever the project default becomes.
 * Events are captured by spying on `./transport.ts`'s `emitMany` — the one
 * function both `./react.ts` and `./state.ts` hand their drafts to — which is
 * synchronous and sidesteps the 250 ms batch timer entirely. The transport is
 * still configured with a capture in `beforeEach`, so the module under test
 * runs against the same state it sees in production, and one test deliberately
 * removes the spy to prove the capture gate really is in the path.
 *
 * No `node:` builtin is imported and no fixture file is read: this module is
 * bundled into the page-injected agent IIFE (`esbuild.agent.mjs` hard-fails on
 * a Node builtin), so every input below is constructed inline.
 *
 * @see ./react.ts for the module under test.
 * @see ./fiber-diff.test.ts for the privacy half of the same AAP §0.8.3 row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRDTHook, hasRDTHook, installRDTHook } from 'bippy';
import type { Fiber, FiberRoot } from 'bippy';

import {
  attachInteractions,
  detachInteractions,
  isInteractionWindowOpen,
  isInteractionsAttached,
} from './interaction.js';
import {
  MAX_OWNER_CHAIN,
  MAX_RENDERS_PER_COMMIT,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  attachReact,
  detachReact,
  detectReact,
  getReactStats,
  isReactAttached,
  resetReactCounters,
  snapshotComponentTree,
} from './react.js';
import type { ComponentTreeNode } from './react.js';
import { attachState, detachState, getStateStats } from './state.js';
import * as transport from './transport.js';
import type { EventDraft } from './transport.js';
import { RENDER_PHASES, RENDER_TRIGGERS } from '../schema/attributes.js';
import type { RenderPhase, RenderTrigger } from '../schema/attributes.js';

/*
 * ---------------------------------------------------------------------------
 * Hook installation — the first executable statements in the file
 *
 * Everything in this block runs before the dynamic import below, which is the
 * whole point: the readings taken here are "what the page looked like before
 * the renderer loaded", and they are consumed by the first suite as
 * assertions.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a hook was already present when this module started.
 *
 * Recorded rather than asserted to a fixed value, because bippy installs one
 * as an import side effect: its entry point re-exports `bippy/install-hook-only`,
 * so the hook exists the moment `./react.ts` is imported. That makes the
 * explicit {@link installRDTHook} call below idempotent, and it makes "a hook
 * exists" the wrong thing to measure — {@link RENDERERS_BEFORE_REACT_DOM} is
 * the reading that distinguishes "the agent arrived first" from "React did".
 */
const HOOK_PRESENT_BEFORE_INSTALL: boolean = hasRDTHook();

installRDTHook();

/** Whether a hook is present after the explicit install. Must be `true`. */
const HOOK_PRESENT_AFTER_INSTALL: boolean = hasRDTHook();

/**
 * How many renderers had registered with the hook before `react-dom` loaded.
 *
 * `getRDTHook()` is only reached *after* {@link installRDTHook}, because it
 * installs a hook when none is present and a reading that changes the page it
 * inspects would prove nothing.
 */
const RENDERERS_BEFORE_REACT_DOM: number = rendererCount();

/** What `./react.ts` reported about React before `react-dom` loaded. */
const REACT_DETECTED_BEFORE_REACT_DOM: boolean = detectReact();

/**
 * How many renderers the hook knows about right now.
 *
 * A function declaration, so it is hoisted and usable by the module-scope
 * constants above without moving the install any later in the file. `-1` when
 * the hook or its registry cannot be read at all, which is distinguishable
 * from a legitimate `0`.
 */
function rendererCount(): number {
  return getRDTHook()?.renderers?.size ?? -1;
}

/*
 * ---------------------------------------------------------------------------
 * React runtime, loaded after the hook
 * ---------------------------------------------------------------------------
 */

/** React's node type, reached without a static `react` import statement. */
type ReactNode = import('react').ReactNode;

/** React's component type, reached the same way. */
type ComponentType<TProps> = import('react').ComponentType<TProps>;

/** A `react-dom/client` root handle. */
type ReactRoot = import('react-dom/client').Root;

/** The two modules the React-rendered cases need, once they have loaded. */
interface ReactRuntime {
  /** The `react` module namespace: `useState`, `memo`, `act`, `Component`. */
  readonly react: typeof import('react');
  /** `react-dom/client`'s root factory. */
  readonly createRoot: typeof import('react-dom/client').createRoot;
}

/**
 * Load React and its DOM renderer, dynamically and after the hook install.
 *
 * `undefined` rather than a throw when either module is missing, so the React
 * block can skip with a stated reason while the synthetic block still proves
 * the traversal contract. AAP §0.3.2 did not list `react-dom` as a dependency
 * of this package — `react` is there only as bippy's peer — so it was added
 * (exact `19.3.0`, like every pin in this repository) to make the React path
 * runnable; this function is what keeps the suite meaningful if that ever
 * regresses.
 */
async function loadReactRuntime(): Promise<ReactRuntime | undefined> {
  try {
    const react = await import('react');
    const { createRoot } = await import('react-dom/client');
    return { react, createRoot };
  } catch {
    return undefined;
  }
}

/** The loaded runtime, or `undefined` when `react-dom` is unavailable. */
const reactRuntime: ReactRuntime | undefined = await loadReactRuntime();

/** Stated on the skipped React block so a skip is never silent. */
const REACT_SKIP_REASON =
  'react-dom/client could not be imported; the synthetic fiber-root cases below still cover the traversal contract';

/**
 * The loaded runtime, for use inside a test body.
 *
 * The React block is registered with `describe.skipIf`, and a skipped suite's
 * *bodies* never run, so this never throws there. It exists because
 * `describe.skipIf` still evaluates the suite callback at collection time,
 * which means the components cannot be built at collection time from a runtime
 * that may be absent — they are built per test instead.
 */
function requireRuntime(): ReactRuntime {
  if (reactRuntime === undefined) {
    throw new Error(REACT_SKIP_REASON);
  }
  return reactRuntime;
}

/*
 * ---------------------------------------------------------------------------
 * Constants the assertions are written against
 * ---------------------------------------------------------------------------
 */

/** The capture every test configures the transport with. */
const CAPTURE_ID = 'cap_react_test';

/** The session every test configures the transport with. */
const SESSION_ID = 'ses_react_test';

/** Display names the traversal assertions look for. Explicit, never inferred. */
const PARENT = 'Parent';
const CHILD = 'Child';
const LEAF = 'Leaf';
const SHELL = 'Shell';
const SIBLING = 'Sibling';
const EXPLODER = 'Exploder';
const BOUNDARY = 'Boundary';

/**
 * The W3C trace-context id shapes, restated locally on purpose.
 *
 * `./ids.ts` owns the same two patterns, but it is not a dependency of this
 * file, and restating them is the better answer anyway: a test that imported
 * the producer's own regex could not catch the producer changing it. These are
 * wire constants from the W3C specification — 32 and 16 lowercase hex
 * characters — not tunable values.
 */
const TRACE_ID_SHAPE = /^[0-9a-f]{32}$/;
const SPAN_ID_SHAPE = /^[0-9a-f]{16}$/;

/**
 * How far an event's `startTime` may sit from `Date.now()`: ten minutes.
 *
 * Deliberately loose. The assertion being made is "this is an
 * epoch-millisecond reading of this machine's clock", which is what the
 * correlator and the service's ingest schema require, and nothing narrower is
 * true: a render's `startTime` is `performance.timeOrigin + actualStartTime`,
 * so it is anchored to when the document was created rather than to when the
 * assertion runs, and the synthetic cases supply relative offsets of their
 * own. Narrowing this window would buy no information and would fail on a
 * loaded host.
 */
const CLOCK_WINDOW_MS = 10 * 60 * 1000;

/**
 * React's own work tags for a function component and a host root.
 *
 * Needed by the synthetic fiber cases, because bippy reads a fiber's `tag`
 * through its version map and exposes that map only via
 * `getReactWorkTagsForFiber`, which needs a fiber that already carries a tag —
 * so the two values cannot be derived from the library and are stated here.
 * Both have been stable across every React version in bippy's map.
 */
const WORK_TAG_FUNCTION_COMPONENT = 0;
const WORK_TAG_HOST_ROOT = 3;

/**
 * React's `PerformedWork` fiber flag.
 *
 * `traverseRenderedFibers` only visits a fiber that rendered, which it decides
 * from this flag; a synthetic fiber without it is skipped, and the commit then
 * carries no renders at all. bippy exports the flag table as `ReactFiberFlags`
 * but the agent prompt's verified surface for bippy 0.7.3 does not include it,
 * so the one bit this file needs is stated rather than imported.
 */
const FIBER_FLAG_PERFORMED_WORK = 1;

/*
 * ---------------------------------------------------------------------------
 * Recording
 *
 * One helper, used by every test, so each reads the same way. `emitMany` is
 * the target because it is the single function `./react.ts` hands a whole
 * commit to — and the same one `./state.ts` uses, so the state-transition
 * cases need no second channel.
 * ---------------------------------------------------------------------------
 */

/** Every draft the modules under test emitted during the current test. */
const captured: EventDraft[] = [];

/** Replace `emitMany` with a synchronous recorder for the current test. */
function startRecording(): void {
  vi.spyOn(transport, 'emitMany').mockImplementation((drafts) => {
    captured.push(...drafts);
  });
}

/** The recorded drafts of one kind, in emission order. */
function draftsOfKind(kind: EventDraft['kind']): EventDraft[] {
  return captured.filter((draft) => draft.kind === kind);
}

/** The recorded `render` draft for one component, if the commit produced one. */
function renderOf(component: string): EventDraft | undefined {
  return draftsOfKind('render').find((draft) => draft.attributes['component'] === component);
}

/** Every component named by a recorded `render` draft, in emission order. */
function renderedComponents(): unknown[] {
  return draftsOfKind('render').map((draft) => draft.attributes['component']);
}

/**
 * The first element of a list, or a failure naming what was missing.
 *
 * `noUncheckedIndexedAccess` makes every index read `T | undefined`; this
 * keeps the narrowing in one place instead of scattering assertions that would
 * report "undefined" without saying what was expected.
 */
function first<T>(values: readonly T[], what: string): T {
  const value = values[0];
  if (value === undefined) {
    throw new Error(`expected at least one ${what}, found none`);
  }
  return value;
}

/*
 * ---------------------------------------------------------------------------
 * Shared assertions
 *
 * Used by both the React-rendered and the synthetic cases, which is what makes
 * the two paths comparable rather than merely coexistent.
 * ---------------------------------------------------------------------------
 */

/** Whether a value is a member of the closed render-phase vocabulary. */
function isRenderPhase(value: unknown): value is RenderPhase {
  return typeof value === 'string' && (RENDER_PHASES as readonly string[]).includes(value);
}

/** Whether a value is a member of the closed render-trigger vocabulary. */
function isRenderTrigger(value: unknown): value is RenderTrigger {
  return typeof value === 'string' && (RENDER_TRIGGERS as readonly string[]).includes(value);
}

/**
 * The timing assertions, and the only ones any test makes about a duration.
 *
 * Finite and non-negative, because the service's ingress schema rejects
 * anything else and a panel must never render a negative cost; and an
 * epoch-millisecond reading, because that single time base is what lets the
 * correlator order browser, server and database events in one trace. Never an
 * equality: see the note on {@link CLOCK_WINDOW_MS} and the module
 * documentation.
 */
function expectAdvisoryTiming(draft: EventDraft, now: number): void {
  expect(Number.isFinite(draft.duration)).toBe(true);
  expect(draft.duration).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(draft.startTime)).toBe(true);
  expect(draft.startTime).toBeGreaterThan(now - CLOCK_WINDOW_MS);
  expect(draft.startTime).toBeLessThan(now + CLOCK_WINDOW_MS);
}

/**
 * Whether a draft survives the journey it is about to make.
 *
 * Every event crosses `window.postMessage` to the isolated-world bridge and is
 * then validated by the service's strict ingress schema, which admits no
 * function and no symbol in an attribute bag. A structural round trip through
 * JSON is the cheapest honest proxy for both.
 */
function expectJsonSafe(draft: EventDraft): void {
  const roundTripped: unknown = JSON.parse(JSON.stringify(draft));
  expect(roundTripped).toStrictEqual(draft);
}

/** What one well-formed commit looked like, for a caller's own assertions. */
interface CommitShape {
  /** The single `commit` draft. */
  readonly commit: EventDraft;
  /** The `render` drafts parented to it, in traversal order. */
  readonly renders: EventDraft[];
}

/**
 * Every structural guarantee one commit must satisfy, whatever produced it.
 *
 * The relationships asserted here are the ones the timeline's band-inside-band
 * reading and a generated panel's evidence references both depend on: one
 * commit event, every render parented to it, one trace across the whole
 * commit, distinct span ids, a phase from the closed vocabulary, advisory
 * timings and a JSON-safe payload.
 *
 * @param expectedPhase The phase every render of this commit must report.
 * @returns The commit and its renders, for assertions specific to one case.
 */
function expectWellFormedCommit(expectedPhase: RenderPhase): CommitShape {
  const now = Date.now();
  const commits = draftsOfKind('commit');
  expect(commits).toHaveLength(1);
  const commit = first(commits, 'commit draft');
  const renders = draftsOfKind('render');
  expect(renders.length).toBeGreaterThan(0);

  const all = [commit, ...renders];
  const spanIds = new Set<string>();
  for (const draft of all) {
    expect(draft.traceId).toMatch(TRACE_ID_SHAPE);
    expect(draft.spanId).toMatch(SPAN_ID_SHAPE);
    // One commit is one moment, so it is one trace: `./react.ts` resolves the
    // context once, before the first fiber is visited, precisely so an
    // interaction window closing mid-traversal cannot split a commit in two.
    expect(draft.traceId).toBe(commit.traceId);
    expect(draft.status).toBe('ok');
    spanIds.add(draft.spanId);
    expectAdvisoryTiming(draft, now);
    expectJsonSafe(draft);
  }
  expect(spanIds.size).toBe(all.length);

  // The commit event leads the batch, so a raw log ordered by sequence reads
  // parent before children.
  expect(captured.indexOf(commit)).toBe(0);
  expect(commit.name).toBe('React commit');
  expect(commit.attributes['renderCount']).toBe(renders.length);
  expect(commit.attributes['phase']).toBe(expectedPhase);

  for (const render of renders) {
    expect(render.parentSpanId).toBe(commit.spanId);
    expect(render.name).toBe(render.attributes['component']);
    const phase = render.attributes['phase'];
    expect(isRenderPhase(phase)).toBe(true);
    expect(phase).toBe(expectedPhase);
    expect(render.attributes['renderCount']).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(render.attributes['changedProps'])).toBe(true);

    if (expectedPhase === 'mount') {
      // The rule that keeps `render_trigger_unknown_count` honest (AAP
      // §0.2.3): a mount has no previous fiber, so "why did it render" has no
      // answer, and an absent key is how this product says "not observed".
      expect('trigger' in render.attributes).toBe(false);
    } else {
      expect(isRenderTrigger(render.attributes['trigger'])).toBe(true);
    }
  }

  return { commit, renders };
}

/** Forget what has been recorded, between the phases of one test. */
function clearCaptured(): void {
  captured.length = 0;
}

/*
 * ---------------------------------------------------------------------------
 * Synthetic fiber roots
 *
 * Hand-built structures driven straight through the installed hook. They are
 * how the per-commit and owner-chain bounds are reached, and how a fiber
 * carrying a hostile profiling value is produced at all — React will not make
 * one on request. They also keep the traversal contract proven if `react-dom`
 * is ever unavailable.
 * ---------------------------------------------------------------------------
 */

/** React's id for the renderer a synthetic commit claims to come from. */
const RENDERER_ID = 1;

/**
 * The root fiber's `memoizedState`, in the shape the traversal requires before
 * it will call a second commit of the same root an update.
 *
 * `traverseRenderedFibers` decides mount-versus-update from the root fiber it
 * remembers per `FiberRoot`, and takes the update path only when both the
 * remembered and the current root fiber look like a live React root — a
 * `memoizedState` carrying an `element` and no `isDehydrated` flag. A
 * synthetic root that omits it is treated as a mount for ever, which is the
 * one piece of this structure a reader would never guess.
 */
const HYDRATED_ROOT_STATE = { element: {}, isDehydrated: false };

/** What one synthetic composite fiber should look like. */
interface SyntheticFiberSpec {
  /** The `displayName` the traversal must report as `component`. */
  readonly name: string;
  /** `memoizedProps` for this render. */
  readonly props?: Record<string, unknown>;
  /** Whatever React might have written as `actualDuration`, including junk. */
  readonly actualDuration?: unknown;
  /** Whatever React might have written as `actualStartTime`, including junk. */
  readonly actualStartTime?: unknown;
}

/** Write one field of a fiber-shaped object, which is untyped by construction. */
function mutateFiber(fiber: Fiber, key: string, value: unknown): void {
  (fiber as unknown as Record<string, unknown>)[key] = value;
}

/**
 * One composite fiber, in the shape React 19 gives a function component.
 *
 * The field list is taken from a real fiber observed under this exact React
 * and bippy pairing, so the structure the traversal walks is the structure it
 * walks in a developer's page rather than a convenient approximation.
 */
function syntheticFiber(spec: SyntheticFiberSpec): Fiber {
  function SyntheticComponent(): null {
    return null;
  }
  SyntheticComponent.displayName = spec.name;

  const fiber: Record<string, unknown> = {
    tag: WORK_TAG_FUNCTION_COMPONENT,
    key: null,
    elementType: SyntheticComponent,
    type: SyntheticComponent,
    stateNode: null,
    return: null,
    child: null,
    sibling: null,
    index: 0,
    memoizedProps: spec.props ?? {},
    memoizedState: null,
    dependencies: null,
    mode: 0,
    flags: FIBER_FLAG_PERFORMED_WORK,
    subtreeFlags: FIBER_FLAG_PERFORMED_WORK,
    lanes: 0,
    childLanes: 0,
    alternate: null,
    actualDuration: spec.actualDuration,
    actualStartTime: spec.actualStartTime,
  };

  return fiber as unknown as Fiber;
}

/**
 * Make two fibers each other's `alternate`, as React does across two renders
 * of one component instance.
 *
 * Both directions, because `./fiber-diff.ts` reads `fiber.alternate` to decide
 * what changed while the traversal reads the pairing from the other side.
 */
function pairAlternates(current: Fiber, previous: Fiber): void {
  mutateFiber(current, 'alternate', previous);
  mutateFiber(previous, 'alternate', current);
}

/**
 * A nested chain of composite fibers: the first spec is the outermost.
 *
 * Returned in the same order as the specs, so a caller can assert on any level
 * of the chain it built.
 */
function syntheticChain(specs: readonly SyntheticFiberSpec[]): Fiber[] {
  const fibers = specs.map((spec) => syntheticFiber(spec));
  fibers.forEach((fiber, index) => {
    const child = fibers[index + 1];
    if (child !== undefined) {
      mutateFiber(fiber, 'child', child);
      mutateFiber(child, 'return', fiber);
    }
  });
  return fibers;
}

/** One host-root fiber over `children` as its child list. */
function syntheticRootFiber(children: readonly Fiber[]): Fiber {
  const rootFiber: Record<string, unknown> = {
    tag: WORK_TAG_HOST_ROOT,
    key: null,
    elementType: null,
    type: null,
    stateNode: null,
    return: null,
    child: children[0] ?? null,
    sibling: null,
    index: 0,
    memoizedProps: null,
    memoizedState: HYDRATED_ROOT_STATE,
    dependencies: null,
    mode: 0,
    flags: FIBER_FLAG_PERFORMED_WORK,
    subtreeFlags: FIBER_FLAG_PERFORMED_WORK,
    lanes: 0,
    childLanes: 0,
    alternate: null,
  };
  const root = rootFiber as unknown as Fiber;

  children.forEach((child, index) => {
    mutateFiber(child, 'return', root);
    mutateFiber(child, 'sibling', children[index + 1] ?? null);
  });

  return root;
}

/**
 * A fiber root over `children`, optionally with a previous tree behind it.
 *
 * `previousChildren` builds the root's `alternate` — React's other tree — and
 * that pairing is what a second commit of the same root needs before the
 * traversal will descend into the children as updates: it compares the two
 * roots' `child` pointers and recurses only where they differ, exactly as
 * React DevTools does.
 *
 * @param containerId Becomes the commit's `rootName`, so two roots in one test
 * stay distinguishable.
 */
function syntheticRoot(
  children: readonly Fiber[],
  containerId: string,
  previousChildren?: readonly Fiber[],
): FiberRoot {
  const container = document.createElement('div');
  container.id = containerId;

  const current = syntheticRootFiber(children);
  if (previousChildren !== undefined) {
    pairAlternates(current, syntheticRootFiber(previousChildren));
  }

  return { current, containerInfo: container } as unknown as FiberRoot;
}

/** Dispatch one commit of a synthetic root through the installed hook. */
function commitSynthetic(root: FiberRoot): void {
  const hook = getRDTHook();
  expect(hook).toBeDefined();
  hook?.onCommitFiberRoot?.(RENDERER_ID, root);
}

/*
 * ---------------------------------------------------------------------------
 * React 19 harness
 * ---------------------------------------------------------------------------
 */

/** Tell React it is running inside `act`, so it emits no warning. */
function enableActEnvironment(): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

/**
 * Run `scope` inside one `act` window and let React settle before it closes.
 *
 * The callback is `async` and awaits a microtask turn for two reasons: React's
 * scheduled work and any microtask-queued effect must land inside the same
 * window, and `act` returns a plain `void` for a synchronous callback — which
 * cannot be awaited — so the promise-returning overload is the one to take.
 */
async function inAct(runtime: ReactRuntime, scope: () => void): Promise<void> {
  await runtime.react.act(async () => {
    scope();
    await Promise.resolve();
  });
}

/** A mounted React root and the element it owns. */
interface MountedTree {
  /** The `react-dom/client` root handle. */
  readonly root: ReactRoot;
  /** The container element, whose `id` becomes the commit's `rootName`. */
  readonly container: HTMLElement;
}

/** Every root mounted by the current test, unmounted by `afterEach`. */
const mounted: MountedTree[] = [];

/**
 * Create a root over a fresh container.
 *
 * @param containerId The element id, which `./react.ts` reports as the
 * commit's `rootName` — so two roots in one test stay distinguishable.
 * @param onCaughtError Handed to `createRoot` so an error a boundary catches
 * is reported to the test instead of to the console.
 */
function createHostRoot(
  runtime: ReactRuntime,
  containerId: string,
  onCaughtError?: () => void,
): MountedTree {
  const container = document.createElement('div');
  container.id = containerId;
  document.body.append(container);
  const root =
    onCaughtError === undefined
      ? runtime.createRoot(container)
      : runtime.createRoot(container, { onCaughtError });
  const tree: MountedTree = { root, container };
  mounted.push(tree);
  return tree;
}

/** Unmount every root the current test created, inside `act`. */
async function unmountAll(): Promise<void> {
  const trees = mounted.splice(0, mounted.length);
  for (const tree of trees) {
    if (reactRuntime !== undefined) {
      await inAct(reactRuntime, () => {
        tree.root.unmount();
      });
    }
    tree.container.remove();
  }
}

/** Props of the memoized leaf. */
interface LeafProps {
  /** The one prop whose change must appear in `changedProps`. */
  readonly label: string;
}

/** The three-level tree the traversal cases render, plus its two triggers. */
interface TreeFixture {
  /** The root component: `Parent` renders `Child`, which renders `memo(Leaf)`. */
  readonly Parent: ComponentType<Record<string, never>>;
  /** Change `Parent`'s state **and** the `label` handed down to `Leaf`. */
  bumpLabel(): void;
  /** Change `Parent`'s state while every prop below it stays identical. */
  bumpQuietly(): void;
}

/**
 * Build the three-level tree.
 *
 * Every component carries an explicit `displayName`, so neither minification
 * nor the way an anonymous function happens to be named can move the
 * assertions. `Leaf` is wrapped in `memo` with the display name on the
 * **wrapper**, which is what React DevTools shows and what `./react.ts` reads
 * first — the inner implementation is named differently on purpose, so a
 * regression that read the fiber instead of its `elementType` would fail here.
 */
function createTreeFixture(runtime: ReactRuntime): TreeFixture {
  const react = runtime.react;

  function LeafImplementation(props: LeafProps): ReactNode {
    return <span data-label={props.label}>{props.label}</span>;
  }
  LeafImplementation.displayName = 'LeafImplementation';

  const Leaf = react.memo(LeafImplementation);
  Leaf.displayName = LEAF;

  function Child(props: LeafProps): ReactNode {
    return (
      <div className="child">
        <Leaf label={props.label} />
      </div>
    );
  }
  Child.displayName = CHILD;

  /** A `useState` setter, narrowed to the functional form the fixture uses. */
  type Bump = (updater: (previous: number) => number) => void;

  let bumpLabelState: Bump | undefined;
  let bumpQuietState: Bump | undefined;

  function Parent(): ReactNode {
    const [labelSeq, setLabelSeq] = react.useState(0);
    // The second slot is never read: incrementing it re-renders `Parent`
    // without changing any prop below it, which is the "quiet" update the
    // `unchanged` trigger and the `memo` bailout are observed through.
    const [, setQuietSeq] = react.useState(0);
    // Captured during render rather than through a ref or an effect: the test
    // needs the setters before any effect has run, and a harness may be
    // impure in a way a component may not.
    bumpLabelState = setLabelSeq;
    bumpQuietState = setQuietSeq;
    return (
      <div
        className="parent"
        onClick={() => {
          // A real handler, so the interaction case can drive a commit with a
          // click rather than by calling a setter next to one.
          setLabelSeq((previous) => previous + 1);
        }}
      >
        <Child label={`label-${String(labelSeq)}`} />
      </div>
    );
  }
  Parent.displayName = PARENT;

  function bump(setter: Bump | undefined, what: string): void {
    if (setter === undefined) {
      throw new Error(`${what} is unavailable: ${PARENT} has not rendered yet`);
    }
    setter((previous) => previous + 1);
  }

  return {
    Parent,
    bumpLabel: () => {
      bump(bumpLabelState, 'bumpLabel');
    },
    bumpQuietly: () => {
      bump(bumpQuietState, 'bumpQuietly');
    },
  };
}

/** Mount the three-level tree, attached and recording, and clear the mount. */
async function mountTree(
  runtime: ReactRuntime,
  containerId: string,
): Promise<{ fixture: TreeFixture; tree: MountedTree }> {
  const fixture = createTreeFixture(runtime);
  const tree = createHostRoot(runtime, containerId);
  attachReact();
  await inAct(runtime, () => {
    tree.root.render(<fixture.Parent />);
  });
  return { fixture, tree };
}

/** Every node of a snapshot, outermost first, as a flat list. */
function flattenTree(node: ComponentTreeNode): ComponentTreeNode[] {
  return [node, ...node.children.flatMap((child) => flattenTree(child))];
}

/** Props of the error boundary the robustness case renders. */
interface BoundaryProps {
  /** The subtree whose failure the boundary contains. */
  readonly children: ReactNode;
}

/** State of the error boundary. */
interface BoundaryState {
  /** Whether the boundary has caught a render failure. */
  readonly failed: boolean;
}

/**
 * A tree whose middle component throws during render, behind a boundary.
 *
 * A class boundary because that is the only kind React offers, and a boundary
 * at all because the point of the case is that the *rest* of the commit is
 * still observed: without one, React would tear the whole root down and there
 * would be nothing left to observe.
 */
function createExplodingTree(runtime: ReactRuntime): ComponentType<Record<string, never>> {
  class Boundary extends runtime.react.Component<BoundaryProps, BoundaryState> {
    static displayName = BOUNDARY;

    static getDerivedStateFromError(): BoundaryState {
      return { failed: true };
    }

    constructor(props: BoundaryProps) {
      super(props);
      this.state = { failed: false };
    }

    override render(): ReactNode {
      return this.state.failed ? <span data-boundary="caught" /> : this.props.children;
    }
  }

  function Exploder(): ReactNode {
    throw new Error('react.test.tsx: deliberate render failure');
  }
  Exploder.displayName = EXPLODER;

  function Sibling(): ReactNode {
    return <span data-sibling="ok" />;
  }
  Sibling.displayName = SIBLING;

  function Shell(): ReactNode {
    return (
      <div className="shell">
        <Sibling />
        <Boundary>
          <Exploder />
        </Boundary>
      </div>
    );
  }
  Shell.displayName = SHELL;

  return Shell;
}

/*
 * ---------------------------------------------------------------------------
 * Lifecycle
 *
 * A leaked subscription would make every later assertion non-deterministic —
 * two attached observers double every event — so the teardown detaches all
 * three hooks before it unmounts anything, and resets the transport last.
 * ---------------------------------------------------------------------------
 */

beforeEach(() => {
  clearCaptured();
  enableActEnvironment();
  transport.resetTransport();
  transport.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_ID, enabled: true });
  resetReactCounters();
  startRecording();
});

afterEach(async () => {
  detachState();
  detachReact();
  detachInteractions();
  await unmountAll();
  vi.restoreAllMocks();
  transport.resetTransport();
  clearCaptured();
});

/*
 * ---------------------------------------------------------------------------
 * The hook-before-React guarantee (AAP 0.1.1)
 * ---------------------------------------------------------------------------
 */

describe('hook installation before React', () => {
  it('leaves a hook with no registered renderer before react-dom loads', () => {
    // A hook exists either way — bippy installs one as an import side effect —
    // so the install is idempotent and "a hook exists" is not the measurement.
    expect(typeof HOOK_PRESENT_BEFORE_INSTALL).toBe('boolean');
    expect(HOOK_PRESENT_AFTER_INSTALL).toBe(true);

    // This pair is the mechanical proof of the product's `installedBeforeReact`
    // claim: at the instant the hook was installed no renderer had registered
    // with it, which is exactly the state a `document_start` agent is in.
    expect(RENDERERS_BEFORE_REACT_DOM).toBe(0);
    expect(REACT_DETECTED_BEFORE_REACT_DOM).toBe(false);
  });

  it.skipIf(reactRuntime === undefined)(
    'sees a registered renderer once react-dom has been imported',
    () => {
      expect(hasRDTHook()).toBe(true);
      expect(rendererCount()).toBeGreaterThanOrEqual(1);
      expect(rendererCount()).toBeGreaterThan(RENDERERS_BEFORE_REACT_DOM);
      expect(detectReact()).toBe(true);
    },
  );

  it('answers detectReact without a commit having been observed', () => {
    expect(getReactStats().commits).toBe(0);
    expect(isReactAttached()).toBe(false);
    expect(() => detectReact()).not.toThrow();
    expect(typeof detectReact()).toBe('boolean');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Commit traversal, driven by a hand-built fiber root
 * ---------------------------------------------------------------------------
 */

describe('commit traversal — synthetic fiber root', () => {
  it('reports one commit and a render per composite fiber, parented to the commit', () => {
    const fibers = syntheticChain([
      { name: PARENT, props: { level: 0 }, actualDuration: 6, actualStartTime: 12 },
      { name: CHILD, props: { label: 'a' }, actualDuration: 4, actualStartTime: 13 },
      { name: LEAF, props: { label: 'a' }, actualDuration: 2, actualStartTime: 14 },
    ]);
    const root = syntheticRoot([first(fibers, 'synthetic fiber')], 'synthetic-mount');

    attachReact();
    commitSynthetic(root);

    const { commit, renders } = expectWellFormedCommit('mount');
    expect(renders).toHaveLength(3);
    expect(renderedComponents()).toStrictEqual([PARENT, CHILD, LEAF]);
    expect(commit.attributes['renderedFiberCount']).toBe(3);
    expect(commit.attributes['rendererId']).toBe(RENDERER_ID);
    expect(commit.attributes['rootName']).toBe('#synthetic-mount');
    expect('truncated' in commit.attributes).toBe(false);

    // Interactions are dormant in this suite, so `resolveEventContext` answers
    // with a synthetic origin: the commit is its own trace root and carries no
    // parent. The interaction case in the React suite is the contrast.
    expect(isInteractionsAttached()).toBe(false);
    expect(commit.parentSpanId).toBeUndefined();

    // The owner chain is the component ancestry, nearest first — host fibers
    // are not levels of it, and neither is the root.
    expect(renderOf(LEAF)?.attributes['ownerChain']).toStrictEqual([CHILD, PARENT]);
    expect('ownerChain' in (renderOf(PARENT)?.attributes ?? {})).toBe(false);

    expect(getReactStats()).toStrictEqual({
      commits: 1,
      renders: 3,
      truncatedCommits: 0,
      failures: 0,
    });
  });

  it('reports an update whose trigger comes from the closed vocabulary', () => {
    const current = first(
      syntheticChain([
        { name: PARENT, props: { label: 'next' }, actualDuration: 3, actualStartTime: 9 },
      ]),
      'synthetic fiber',
    );
    const previous = first(
      syntheticChain([{ name: PARENT, props: { label: 'previous' } }]),
      'synthetic fiber',
    );
    pairAlternates(current, previous);
    const root = syntheticRoot([current], 'synthetic-update', [previous]);

    attachReact();
    // The first commit of any root is a mount, whatever its alternates look
    // like — React's own traversal remembers one root fiber per `FiberRoot` and
    // has nothing to compare against until it has seen one. The update is the
    // second commit of the same root.
    commitSynthetic(root);
    expect(renderedComponents()).toStrictEqual([PARENT]);
    clearCaptured();

    commitSynthetic(root);

    const { renders } = expectWellFormedCommit('update');
    expect(renders).toHaveLength(1);
    const parent = renderOf(PARENT);
    expect(isRenderTrigger(parent?.attributes['trigger'])).toBe(true);
    expect(parent?.attributes['trigger']).toBe('props');
    expect(parent?.attributes['changedProps']).toStrictEqual(['label']);
    expect(getReactStats().commits).toBe(2);
  });

  it('emits a zero duration for an absent, negative or non-finite actualDuration', () => {
    const fibers = syntheticChain([
      // Nothing at all: a production build, or a fiber React never profiled.
      { name: PARENT },
      // Values React must never write, and a reader must never be shown.
      { name: CHILD, actualDuration: -5, actualStartTime: -1 },
      { name: LEAF, actualDuration: Number.NaN, actualStartTime: Number.POSITIVE_INFINITY },
    ]);
    const root = syntheticRoot([first(fibers, 'synthetic fiber')], 'synthetic-junk-timings');

    attachReact();
    expect(() => {
      commitSynthetic(root);
    }).not.toThrow();

    const { renders } = expectWellFormedCommit('mount');
    expect(renders).toHaveLength(3);
    for (const render of renders) {
      expect(render.duration).toBe(0);
      // Absence is how this product says "not observed"; a zero attribute
      // would read as a measurement of zero.
      expect('actualDuration' in render.attributes).toBe(false);
      expect('selfTime' in render.attributes).toBe(false);
    }
    expect(getReactStats().failures).toBe(0);
  });

  it('cuts a commit at MAX_RENDERS_PER_COMMIT and still reports the true total', () => {
    const total = MAX_RENDERS_PER_COMMIT + 7;
    const rows = Array.from({ length: total }, (_unused, index) =>
      syntheticFiber({ name: `Row${String(index)}` }),
    );
    const root = syntheticRoot(rows, 'synthetic-bounded');

    attachReact();
    commitSynthetic(root);

    const { commit, renders } = expectWellFormedCommit('mount');
    expect(renders).toHaveLength(MAX_RENDERS_PER_COMMIT);
    // The bound cuts the list; it does not cut the truth about the list.
    expect(commit.attributes['renderedFiberCount']).toBe(total);
    expect(commit.attributes['truncated']).toBe(true);
    expect(getReactStats().truncatedCommits).toBe(1);
    expect(getReactStats().renders).toBe(MAX_RENDERS_PER_COMMIT);
  });

  it('bounds a deep ownerChain at MAX_OWNER_CHAIN', () => {
    const depth = MAX_OWNER_CHAIN + 3;
    const fibers = syntheticChain(
      Array.from({ length: depth }, (_unused, index) => ({ name: `Level${String(index)}` })),
    );
    const root = syntheticRoot([first(fibers, 'synthetic fiber')], 'synthetic-deep');

    attachReact();
    commitSynthetic(root);

    expectWellFormedCommit('mount');
    const deepest = renderOf(`Level${String(depth - 1)}`);
    expect(deepest).toBeDefined();
    expect(deepest?.attributes['ownerChain']).toHaveLength(MAX_OWNER_CHAIN);
    const shallowest = renderOf('Level1');
    expect(shallowest?.attributes['ownerChain']).toStrictEqual(['Level0']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Commit traversal, driven by a real React 19.3.0 render
 *
 * The suite AAP 0.8.3 names. Skipped — never deleted — with a stated reason if
 * `react-dom` cannot be imported, in which case the synthetic suite above is
 * what keeps the traversal contract proven.
 * ---------------------------------------------------------------------------
 */

describe.skipIf(reactRuntime === undefined)('commit traversal — React 19 under happy-dom', () => {
  it('mounts a three-level tree as one commit with a render per component', async () => {
    const runtime = requireRuntime();
    await mountTree(runtime, 'react-mount');

    const { commit, renders } = expectWellFormedCommit('mount');
    expect(renders).toHaveLength(3);
    // The AAP-named assertion: the components React actually rendered, by
    // the display names their authors set — `Leaf`'s on the `memo` wrapper,
    // which is what React DevTools shows and what a developer would type.
    expect(renderedComponents()).toStrictEqual([PARENT, CHILD, LEAF]);
    expect(commit.attributes['rootName']).toBe('#react-mount');
    expect(commit.attributes['renderedFiberCount']).toBe(3);
    expect(commit.attributes['rendererId']).toBe(RENDERER_ID);
    expect(renderOf(LEAF)?.attributes['ownerChain']).toStrictEqual([CHILD, PARENT]);

    expect(getReactStats()).toStrictEqual({
      commits: 1,
      renders: 3,
      truncatedCommits: 0,
      failures: 0,
    });
    expect(rendererCount()).toBeGreaterThanOrEqual(1);
  });

  it('carries no trigger key at all on a mount render', async () => {
    const runtime = requireRuntime();
    await mountTree(runtime, 'react-mount-trigger');

    const renders = draftsOfKind('render');
    expect(renders).toHaveLength(3);
    for (const render of renders) {
      expect(render.attributes['phase']).toBe('mount');
      // Asserted two ways on purpose: the key must be absent, not present
      // and undefined, because an event travels as JSON where the two are
      // indistinguishable and the aggregates read absence as "not observed".
      expect('trigger' in render.attributes).toBe(false);
      expect(Object.keys(render.attributes)).not.toContain('trigger');
    }
  });

  it('reports an update whose trigger and changedProps name the changed prop', async () => {
    const runtime = requireRuntime();
    const { fixture } = await mountTree(runtime, 'react-update');
    clearCaptured();

    await inAct(runtime, () => {
      fixture.bumpLabel();
    });

    const { renders } = expectWellFormedCommit('update');
    expect(renders).toHaveLength(3);
    expect(renderedComponents()).toStrictEqual([PARENT, CHILD, LEAF]);

    // The component whose own hook state changed is attributed to `state`;
    // the two below it received a new prop value and are attributed to it.
    expect(renderOf(PARENT)?.attributes['trigger']).toBe('state');
    expect(renderOf(PARENT)?.attributes['changedProps']).toStrictEqual([]);
    for (const component of [CHILD, LEAF]) {
      const render = renderOf(component);
      expect(render?.attributes['trigger']).toBe('props');
      expect(render?.attributes['changedProps']).toStrictEqual(['label']);
    }
  });

  it('reports a stable-input re-render as unchanged, or not at all when memo bails out', async () => {
    const runtime = requireRuntime();
    const { fixture } = await mountTree(runtime, 'react-quiet');
    clearCaptured();

    await inAct(runtime, () => {
      fixture.bumpQuietly();
    });

    const { renders } = expectWellFormedCommit('update');
    expect(renderOf(PARENT)?.attributes['trigger']).toBe('state');

    // `Child` is not memoized, so React re-renders it although every prop is
    // shallow-equal, it owns no hook state and it consumes no context. All
    // three dimensions were evaluated and none changed, which is precisely
    // the `unchanged` classification `unchanged_render_count` counts — and
    // precisely what must never be conflated with `unknown` (AAP 0.2.3).
    const child = renderOf(CHILD);
    expect(child?.attributes['trigger']).toBe('unchanged');
    expect(child?.attributes['changedProps']).toStrictEqual([]);

    // `Leaf` is memoized and its `label` is identical, so React may bail out
    // of that subtree. Whether it does is React's decision and not this
    // product's, so both outcomes are accepted explicitly: no render event
    // for it, or one classified `unchanged`. Neither may be `props`.
    const leaf = renderOf(LEAF);
    if (leaf === undefined) {
      expect(renderedComponents()).not.toContain(LEAF);
    } else {
      expect(leaf.attributes['trigger']).toBe('unchanged');
    }
    expect(renders.length).toBeGreaterThanOrEqual(2);
  });

  it('counts renders per component within the capture and restarts after a reset', async () => {
    const runtime = requireRuntime();
    const { fixture } = await mountTree(runtime, 'react-counts');

    expect(renderOf(PARENT)?.attributes['renderCount']).toBe(1);
    expect(renderOf(CHILD)?.attributes['renderCount']).toBe(1);
    expect(renderOf(LEAF)?.attributes['renderCount']).toBe(1);

    clearCaptured();
    await inAct(runtime, () => {
      fixture.bumpLabel();
    });
    expect(renderOf(PARENT)?.attributes['renderCount']).toBe(2);
    expect(renderOf(CHILD)?.attributes['renderCount']).toBe(2);
    expect(renderOf(LEAF)?.attributes['renderCount']).toBe(2);

    // A new capture begins. `renderCount` means "renders in this capture", so
    // a count carried over would be added to a number the developer reads as
    // this interaction's (AAP 0.2.3).
    resetReactCounters();
    clearCaptured();
    await inAct(runtime, () => {
      fixture.bumpLabel();
    });
    expect(renderOf(PARENT)?.attributes['renderCount']).toBe(1);
    expect(renderOf(LEAF)?.attributes['renderCount']).toBe(1);
    expect(getReactStats().commits).toBe(1);
  });

  it('joins the interaction trace when a click drives the commit', async () => {
    const runtime = requireRuntime();
    const { tree } = await mountTree(runtime, 'react-interaction');
    attachInteractions();
    expect(isInteractionsAttached()).toBe(true);
    clearCaptured();

    const target = tree.container.querySelector('.parent');
    expect(target).not.toBeNull();
    await inAct(runtime, () => {
      target?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      // The capture-phase listener opens the window before the page's own
      // handler runs, which is what makes the commit below attributable.
      expect(isInteractionWindowOpen()).toBe(true);
    });

    const { commit } = expectWellFormedCommit('update');
    // One click, one ordered tree: the interaction's root span parents the
    // commit, and the commit parents every render (asserted in the helper).
    expect(commit.parentSpanId).toMatch(SPAN_ID_SHAPE);
    expect(commit.parentSpanId).not.toBe(commit.spanId);
    expect(renderedComponents()).toContain(PARENT);
  });

  it('emits a state transition for a useState update', async () => {
    const runtime = requireRuntime();
    const { fixture } = await mountTree(runtime, 'react-state');
    attachState();
    clearCaptured();

    await inAct(runtime, () => {
      fixture.bumpLabel();
    });

    const { commit } = expectWellFormedCommit('update');
    const transitions = draftsOfKind('state');
    expect(transitions.length).toBeGreaterThanOrEqual(1);

    const transition = first(transitions, 'state draft');
    expect(transition.attributes['component']).toBe(PARENT);
    expect(transition.attributes['transitionSource']).toBe('state');
    expect(transition.traceId).toBe(commit.traceId);
    // A transition sits inside the render that observed it.
    expect(transition.parentSpanId).toBe(renderOf(PARENT)?.spanId);
    expect(transition.attributes['hookIndex']).toBe(0);

    // `previousValue`/`nextValue` are the catalog's key spellings. Each is a
    // plain summary object — a type and a bounded, scrubbed preview — and
    // never the application's value (AAP 0.5.2). The previews are asserted
    // concretely because the hook counted from zero to one, which is the one
    // thing about this transition that is not timing-dependent.
    const expectedSummaries: Record<string, string> = { previousValue: '0', nextValue: '1' };
    for (const [key, preview] of Object.entries(expectedSummaries)) {
      expect(transition.attributes[key]).toStrictEqual({
        type: 'number',
        preview,
        truncated: false,
      });
    }

    expect(getStateStats().emitted).toBeGreaterThanOrEqual(1);
    expect(getStateStats().failures).toBe(0);
    expectJsonSafe(transition);
  });

  it('stops observing after detachReact', async () => {
    const runtime = requireRuntime();
    const { fixture } = await mountTree(runtime, 'react-detach');
    expect(isReactAttached()).toBe(true);
    expect(getReactStats().commits).toBe(1);

    detachReact();
    expect(isReactAttached()).toBe(false);
    clearCaptured();

    await inAct(runtime, () => {
      fixture.bumpLabel();
    });

    // The DOM below proves React really performed the commit, so the absence
    // of events is the subscription having been released — the observable
    // form of `instrument()`'s unsubscribe actually being called (AAP 0.5.1)
    // — and not a missing update.
    expect(document.querySelector('#react-detach [data-label]')?.getAttribute('data-label')).toBe(
      'label-1',
    );
    expect(captured).toHaveLength(0);
    expect(draftsOfKind('commit')).toHaveLength(0);
    expect(draftsOfKind('render')).toHaveLength(0);
    expect(getReactStats().commits).toBe(0);
  });

  it('tolerates attachReact and detachReact being called twice', async () => {
    const runtime = requireRuntime();
    const fixture = createTreeFixture(runtime);
    const tree = createHostRoot(runtime, 'react-idempotent');

    attachReact();
    attachReact();
    expect(isReactAttached()).toBe(true);

    await inAct(runtime, () => {
      tree.root.render(<fixture.Parent />);
    });

    // A second subscription would double every event, which is what a
    // service-worker reconnect re-sending `agent.config` would otherwise do.
    expectWellFormedCommit('mount');
    expect(draftsOfKind('render')).toHaveLength(3);
    expect(getReactStats().commits).toBe(1);

    expect(() => {
      detachReact();
      detachReact();
    }).not.toThrow();
    expect(isReactAttached()).toBe(false);
  });

  it('snapshots the component tree as JSON-safe nodes', async () => {
    const runtime = requireRuntime();
    const { fixture } = await mountTree(runtime, 'react-tree');
    clearCaptured();
    await inAct(runtime, () => {
      fixture.bumpLabel();
    });

    const snapshot = snapshotComponentTree();
    if (snapshot === undefined) {
      throw new Error('expected a component tree snapshot after a commit');
    }

    // A synthetic container named from the root element, then the
    // application's components — host fibers stepped over, not emitted.
    expect(flattenTree(snapshot).map((node) => node.name)).toStrictEqual([
      '#react-tree',
      PARENT,
      CHILD,
      LEAF,
    ]);
    for (const node of flattenTree(snapshot).slice(1)) {
      expect(node.renderCount).toBe(2);
      expect(typeof node.fiberId).toBe('number');
      expect('truncated' in node).toBe(false);
    }

    // The snapshot crosses `window.postMessage` inside an event's attributes,
    // so it must hold no cycle, no fiber and no DOM node.
    expect(JSON.parse(JSON.stringify(snapshot))).toStrictEqual(snapshot);
    // Asking for the documented defaults explicitly is the same request.
    expect(
      snapshotComponentTree({ maxNodes: MAX_TREE_NODES, maxDepth: MAX_TREE_DEPTH }),
    ).toStrictEqual(snapshot);
  });

  it('respects the snapshot bounds and reports no tree once detached', async () => {
    const runtime = requireRuntime();
    await mountTree(runtime, 'react-tree-bounds');

    const truncated = snapshotComponentTree({ maxNodes: 2 });
    if (truncated === undefined) {
      throw new Error('expected a bounded component tree snapshot');
    }
    expect(flattenTree(truncated).map((node) => node.name)).toStrictEqual([
      '#react-tree-bounds',
      PARENT,
    ]);
    // A truncation that is not stated reads as a component with no children.
    const parent = first(truncated.children, 'top-level component node');
    expect(parent.truncated).toBe(true);
    expect(parent.children).toStrictEqual([]);

    expect(snapshotComponentTree({ maxNodes: 0 })).toBeUndefined();
    expect(snapshotComponentTree({ maxDepth: 0 })).toBeUndefined();

    // Detaching releases the retained root, so there is no tree to report
    // rather than a stale one.
    detachReact();
    expect(snapshotComponentTree()).toBeUndefined();
  });

  it('keeps observing the rest of a commit when a component throws', async () => {
    const runtime = requireRuntime();
    const Shell = createExplodingTree(runtime);
    let caught = 0;
    const tree = createHostRoot(runtime, 'react-boundary', () => {
      caught += 1;
    });

    attachReact();
    await inAct(runtime, () => {
      tree.root.render(<Shell />);
    });

    // React caught it, the boundary rendered its fallback, and the failure
    // never reached this test.
    expect(caught).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('#react-boundary [data-boundary]')).not.toBeNull();

    const names = renderedComponents();
    expect(names).toContain(SHELL);
    expect(names).toContain(SIBLING);
    expect(names).toContain(BOUNDARY);
    // The thrower rendered nothing, so it has no render to report.
    expect(names).not.toContain(EXPLODER);
    expect(draftsOfKind('commit').length).toBeGreaterThanOrEqual(1);

    // A failure is reported through the counters rather than raised: the
    // traversal runs inside React's commit phase, where an exception would
    // break the developer's application.
    const stats = getReactStats();
    expect(Number.isInteger(stats.failures)).toBe(true);
    expect(stats.failures).toBeGreaterThanOrEqual(0);
    for (const draft of captured) {
      expectJsonSafe(draft);
    }
  });

  it('hands a commit to the transport only while a capture is armed', async () => {
    const runtime = requireRuntime();
    // The recorder is removed for this case on purpose: the point is that
    // the real `emitMany` is in the path and that its capture gate decides.
    vi.restoreAllMocks();
    transport.resetTransport();
    attachReact();

    transport.configureTransport({ enabled: false });
    const dormantFixture = createTreeFixture(runtime);
    const dormantTree = createHostRoot(runtime, 'react-dormant');
    await inAct(runtime, () => {
      dormantTree.root.render(<dormantFixture.Parent />);
    });
    // A dormant agent on a page the developer is merely browsing keeps
    // nothing: no buffer growth, no sequence consumed (AAP 0.5.1).
    expect(transport.getTransportStats().buffered).toBe(0);
    expect(transport.getTransportStats().seq).toBe(0);
    expect(getReactStats().commits).toBe(1);

    transport.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_ID, enabled: true });
    const armedFixture = createTreeFixture(runtime);
    const armedTree = createHostRoot(runtime, 'react-armed');
    await inAct(runtime, () => {
      armedTree.root.render(<armedFixture.Parent />);
    });
    // One commit and one render per component, in one hand-off, consuming
    // consecutive sequence numbers.
    expect(transport.getTransportStats().seq).toBe(4);
    expect(transport.getTransportStats().buffered).toBe(4);
    expect(transport.getTransportStats().dropped).toBe(0);
  });
});
