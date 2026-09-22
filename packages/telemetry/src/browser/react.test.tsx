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
 * {@link expectWellFormedCommits}, or through the single-commit
 * {@link expectWellFormedCommit} built on it, and is exercised twice: once by a
 * real React 19.3.0 tree rendered with `react-dom/client` under happy-dom, and
 * once by a hand-built fiber root driven straight through the installed hook
 * (`getRDTHook().onCommitFiberRoot(1, root)`). The synthetic path is not a
 * stand-in — it is how the bounds (`MAX_RENDERS_PER_COMMIT`,
 * `MAX_FIBER_VISITS_PER_COMMIT`, `MAX_OWNER_CHAIN`) and the hostile-value
 * cases (an absent or negative `actualDuration`, a `child` link that loops)
 * are reached at all, since React will not produce them on request. The React
 * path carries what a hand-built fiber cannot honestly claim: the structures
 * React 19.3.0 actually builds, including a `React.Suspense` boundary and the
 * `React.lazy` child it re-parents into an offscreen fragment while a fallback
 * is showing, and a memoized component React re-renders only because a context
 * it reads changed — the fiber shape of the demo's excessive-render defect
 * (AAP §0.8.2) and the one case where the traversal's descent rule could be
 * wrong with every other test still green.
 *
 * **Neither path is optional.** AAP §0.8.3 names React 19.3.0, `react-dom` and
 * bippy 0.7.3 as the runtime combination this file exists to verify, and all
 * three are exact devDependencies of `packages/telemetry`. So a failure to
 * import them is **suite setup failure**, not a reason to skip: a suite that
 * skipped exactly when its subject was unavailable would report green for the
 * one outcome it was written to catch. {@link loadReactRuntime} therefore
 * rethrows with the diagnostic, which fails this file's collection, and every
 * block below is registered unconditionally. Synthetic fibers cover cases
 * React cannot be asked to produce; they are not equivalent evidence for the
 * real renderer and are never treated as a fallback for it.
 *
 * **Timing is asserted exactly, against a clock this suite owns.**
 * `actualDuration` and `actualStartTime` come from React's profiling timer, and
 * a render's `startTime` is `performance.timeOrigin + actualStartTime` — so on
 * a live clock the only true assertion is "somewhere near now", which is also
 * true of a *document-relative* reading mistaken for an epoch one, and of an
 * epoch reading computed from the wrong origin. Those are the errors that
 * matter here, because the correlator orders browser, server and database
 * events on one epoch-millisecond base (AAP §0.2.3). {@link installFixedClock}
 * therefore pins `performance.timeOrigin`, `performance.now()` and `Date.now()`
 * for the duration of each test, which makes every timestamp the producer
 * derives an exact, stated number ({@link expectEventTiming} for the invariant,
 * {@link epochAt} for the value) while leaving the *kind* assertions AAP §0.8.3
 * asks for — finite, non-negative durations — in place. A frozen clock also
 * means React measures every render as taking zero milliseconds, which is why
 * no test asserts a duration above zero.
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
  MAX_FIBER_VISITS_PER_COMMIT,
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
 * Both modules are **required**: AAP §0.8.3 defines this file as the proof that
 * the product's commit observation works against React 19.3.0 with bippy
 * installed first, and `react` 19.3.0 and `react-dom` 19.3.0 are exact
 * devDependencies of `packages/telemetry` for that reason. (AAP §0.3.2 listed
 * only `react`, as bippy's peer; `react-dom`, `@types/react` and
 * `@types/react-dom` were added at the same exact pin to make the React path
 * runnable.)
 *
 * So an import failure is rethrown with its cause rather than swallowed, and
 * this file then fails to load. That is the intended outcome: the alternative —
 * returning `undefined` and skipping the React block — hides a broken or
 * missing dependency behind a green run, which is precisely the state the
 * suite is meant to detect. The synthetic cases below cover inputs React
 * cannot be asked for; they are not a substitute for the real renderer.
 */
async function loadReactRuntime(): Promise<ReactRuntime> {
  try {
    const react = await import('react');
    const { createRoot } = await import('react-dom/client');
    return { react, createRoot };
  } catch (cause) {
    throw new Error(
      'react and react-dom/client are required by this suite (AAP 0.8.3) and are exact devDependencies of @debuggen/telemetry; importing one of them failed, so the React 19.3.0 commit-traversal evidence cannot be produced',
      { cause },
    );
  }
}

/**
 * The loaded runtime.
 *
 * Non-optional by construction — {@link loadReactRuntime} throws instead of
 * reporting absence — so every test below uses it directly and no test carries
 * a guard that could quietly become a skip.
 */
const reactRuntime: ReactRuntime = await loadReactRuntime();

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
const SUSPENSE_SHELL = 'SuspenseShell';
const FALLBACK = 'Fallback';
const LAZY_LEAF = 'LazyLeaf';
const CONTEXT_APP = 'ContextApp';
const CONSUMER = 'Consumer';
const QUIET = 'Quiet';

/** The prop the lazily loaded component renders, so the DOM proves it ran. */
const LAZY_LABEL = 'lazy-label';

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
 * The document time origin every test runs against: 2026-01-01T00:00:00Z.
 *
 * Pinned rather than read, because the product's whole time contract is that a
 * borrowed document-relative reading becomes epoch milliseconds by adding this
 * number (AAP §0.2.3, `./transport.ts`'s `toEpochMs`). With the origin known,
 * "did the producer convert?" has an exact answer — `epochAt(12)` and not "a
 * number near now" — and the two failures a loose window cannot see, a
 * relative reading emitted unconverted and a conversion against the wrong
 * origin, both fail immediately: this value is 1.767 × 10¹², while every
 * relative reading in this suite is below {@link FIXED_NOW_MS}.
 */
const FIXED_TIME_ORIGIN = 1_767_225_600_000;

/**
 * What `performance.now()` reads while a test runs: 5 000 ms into the document.
 *
 * Non-zero on purpose, so a producer that forgot the origin and emitted the
 * relative reading is still distinguishable from one that emitted the origin
 * alone; and larger than every synthetic `actualStartTime` below, so "this
 * event started at or before now" is a real bound rather than one the fixtures
 * violate.
 */
const FIXED_NOW_MS = 5_000;

/**
 * The current reading of the fixed clock, in document-relative milliseconds.
 *
 * Only {@link installFixedClock} and {@link advanceClock} write it, so a test
 * that does not advance it observes one instant — every timestamp of a commit
 * is then exactly {@link FIXED_TIME_ORIGIN} plus a number the test chose.
 */
let clockNow = FIXED_NOW_MS;

/** The own `performance.now` property descriptor displaced by the fixed clock. */
let savedPerformanceNow: PropertyDescriptor | undefined;

/** The own `performance.timeOrigin` descriptor displaced by the fixed clock. */
let savedTimeOrigin: PropertyDescriptor | undefined;

/** `Date.now` as the host implements it, restored after each test. */
let savedDateNow: (() => number) | undefined;

/** Whether the fixed clock is currently installed. */
let clockInstalled = false;

/**
 * Pin the document clock for one test.
 *
 * All three readings the producer can reach are pinned together —
 * `performance.timeOrigin` and `performance.now()` because
 * `./transport.ts`'s `nowEpochMs`/`toEpochMs` prefer them, and `Date.now()`
 * because those functions fall back to it when a clock cannot be read — so
 * there is exactly one instant in play however the code under test asks for
 * it.
 *
 * Installed by defining **own** properties over the `Performance` instance and
 * restored by deleting them, rather than through `vi.spyOn`: one test below
 * calls `vi.restoreAllMocks()` in its body to remove the transport recorder,
 * and a clock restored there would leave the assertions after it reading the
 * host's clock instead. `Reflect.deleteProperty` is the typed way to remove a
 * property TypeScript declares as always present.
 *
 * A frozen `performance.now()` is also what makes React's profiling timer
 * deterministic: every fiber of a commit records the same `actualStartTime`
 * and an `actualDuration` of zero. React's scheduler tolerates it because the
 * work `act()` drives is flushed synchronously — no code waits for the clock
 * to advance.
 */
function installFixedClock(): void {
  clockNow = FIXED_NOW_MS;
  savedPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
  savedTimeOrigin = Object.getOwnPropertyDescriptor(performance, 'timeOrigin');
  savedDateNow = Date.now;

  Object.defineProperty(performance, 'now', {
    configurable: true,
    enumerable: true,
    value: (): number => clockNow,
    writable: true,
  });
  Object.defineProperty(performance, 'timeOrigin', {
    configurable: true,
    enumerable: true,
    value: FIXED_TIME_ORIGIN,
    writable: true,
  });
  Date.now = (): number => FIXED_TIME_ORIGIN + clockNow;
  clockInstalled = true;
}

/** Hand the clock back to the host, exactly as it was found. */
function restoreFixedClock(): void {
  if (!clockInstalled) {
    return;
  }
  clockInstalled = false;

  if (savedPerformanceNow === undefined) {
    Reflect.deleteProperty(performance, 'now');
  } else {
    Object.defineProperty(performance, 'now', savedPerformanceNow);
  }
  if (savedTimeOrigin === undefined) {
    Reflect.deleteProperty(performance, 'timeOrigin');
  } else {
    Object.defineProperty(performance, 'timeOrigin', savedTimeOrigin);
  }
  if (savedDateNow !== undefined) {
    Date.now = savedDateNow;
  }
  savedPerformanceNow = undefined;
  savedTimeOrigin = undefined;
  savedDateNow = undefined;
}

/**
 * Move the fixed clock forward, for a test that needs two distinguishable
 * instants.
 *
 * @param ms Milliseconds to advance; fractional values are allowed, because
 * the event contract's sub-millisecond precision is part of what is asserted.
 */
function advanceClock(ms: number): void {
  clockNow += ms;
}

/**
 * The epoch-millisecond value a document-relative reading must become.
 *
 * The one conversion `./transport.ts` performs, restated here so an assertion
 * states the arithmetic it expects instead of importing the code that
 * performs it.
 */
function epochAt(relativeMs: number): number {
  return FIXED_TIME_ORIGIN + relativeMs;
}

/**
 * React's own work tags for a function component, a host component and a host
 * root.
 *
 * Needed by the synthetic fiber cases, because bippy reads a fiber's `tag`
 * through its version map and exposes that map only via
 * `getReactWorkTagsForFiber`, which needs a fiber that already carries a tag —
 * so the values cannot be derived from the library and are stated here. All
 * three have been stable across every React version in bippy's map.
 */
const WORK_TAG_FUNCTION_COMPONENT = 0;
const WORK_TAG_HOST_COMPONENT = 5;
const WORK_TAG_HOST_ROOT = 3;

/**
 * React's `PerformedWork` fiber flag.
 *
 * "Rendered in this commit" is this bit, and it is what `./react.ts` asks
 * bippy's `didFiberRender` for before emitting a fiber; a synthetic composite
 * fiber without it is stepped over, and the commit then carries no renders at
 * all. bippy exports the flag table as `ReactFiberFlags` but the agent
 * prompt's verified surface for bippy 0.7.3 does not include it, so the one
 * bit this file needs is stated rather than imported.
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
 * The timing invariants every draft must satisfy, on the fixed clock.
 *
 * Two separate statements, kept separate on purpose:
 *
 * - **The duration is finite and non-negative**, because the service's ingress
 *   schema rejects anything else and a panel must never render a negative
 *   cost. This is a *kind* assertion and stays one: React's profiling timer
 *   reports what it reports, and on a frozen clock that is zero.
 * - **The start time is an epoch-millisecond reading of this document's
 *   clock**, bounded exactly: at or after {@link FIXED_TIME_ORIGIN} and at or
 *   before the current reading of that clock. A document-relative value
 *   emitted unconverted fails the lower bound by twelve orders of magnitude,
 *   and a value from a different origin fails one of the two. Individual tests
 *   add the exact equality for the reading they chose ({@link epochAt}); this
 *   is the floor under all of them.
 */
function expectEventTiming(draft: EventDraft): void {
  expect(Number.isFinite(draft.duration)).toBe(true);
  expect(draft.duration).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(draft.startTime)).toBe(true);
  expect(draft.startTime).toBeGreaterThanOrEqual(FIXED_TIME_ORIGIN);
  expect(draft.startTime).toBeLessThanOrEqual(epochAt(clockNow));
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
 * Every structural guarantee each observed commit must satisfy, whatever
 * produced it and however many there are.
 *
 * The relationships asserted here are the ones the timeline's band-inside-band
 * reading and a generated panel's evidence references both depend on: every
 * render parented to a commit that was actually emitted, one trace per commit,
 * distinct span ids across the whole recording, each commit ahead of its own
 * renders, a phase from the closed vocabulary, a `trigger` exactly when the
 * phase is an update, epoch timings and a JSON-safe payload.
 *
 * Written per commit rather than for one, because a case can legitimately
 * produce two: a Suspense boundary commits its fallback and then, when the
 * lazy module settles, its resolved content. Holding both to the same rules is
 * the point — {@link expectWellFormedCommit} is this function plus the two
 * assertions that are only true of a single-commit case.
 *
 * @returns One shape per commit, in emission order.
 */
function expectWellFormedCommits(): CommitShape[] {
  const commits = draftsOfKind('commit');
  expect(commits.length).toBeGreaterThan(0);
  const renders = draftsOfKind('render');
  const commitSpanIds = new Set(commits.map((commit) => commit.spanId));

  // No orphans: a render parented to a span that was never emitted would leave
  // the timeline with a band whose container does not exist.
  for (const render of renders) {
    expect(typeof render.parentSpanId).toBe('string');
    expect(commitSpanIds.has(render.parentSpanId ?? '')).toBe(true);
  }

  const spanIds = new Set<string>();
  const shapes: CommitShape[] = [];

  for (const commit of commits) {
    const own = renders.filter((render) => render.parentSpanId === commit.spanId);

    expect(commit.name).toBe('React commit');
    expect(commit.attributes['renderCount']).toBe(own.length);

    for (const draft of [commit, ...own]) {
      expect(draft.traceId).toMatch(TRACE_ID_SHAPE);
      expect(draft.spanId).toMatch(SPAN_ID_SHAPE);
      // One commit is one moment, so it is one trace: `./react.ts` resolves the
      // context once, before the first fiber is visited, precisely so an
      // interaction window closing mid-traversal cannot split a commit in two.
      expect(draft.traceId).toBe(commit.traceId);
      expect(draft.status).toBe('ok');
      spanIds.add(draft.spanId);
      expectEventTiming(draft);
      expectJsonSafe(draft);
    }

    for (const render of own) {
      // The commit event leads its own batch, so a raw log ordered by sequence
      // reads parent before children.
      expect(captured.indexOf(commit)).toBeLessThan(captured.indexOf(render));
      expect(render.name).toBe(render.attributes['component']);
      const phase = render.attributes['phase'];
      expect(isRenderPhase(phase)).toBe(true);
      expect(render.attributes['renderCount']).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(render.attributes['changedProps'])).toBe(true);

      if (phase === 'mount') {
        // The rule that keeps `render_trigger_unknown_count` honest (AAP
        // §0.2.3): a mount has no previous fiber, so "why did it render" has no
        // answer, and an absent key is how this product says "not observed".
        expect('trigger' in render.attributes).toBe(false);
      } else {
        expect(isRenderTrigger(render.attributes['trigger'])).toBe(true);
      }
    }

    shapes.push({ commit, renders: own });
  }

  expect(spanIds.size).toBe(commits.length + renders.length);
  return shapes;
}

/**
 * The single-commit case: {@link expectWellFormedCommits} plus the two things
 * only one commit can be held to — that it is the batch's first event, and
 * that every render it parents reports the phase the test expects.
 *
 * @param expectedPhase The phase every render of this commit must report.
 * @returns The commit and its renders, for assertions specific to one case.
 */
function expectWellFormedCommit(expectedPhase: RenderPhase): CommitShape {
  const shapes = expectWellFormedCommits();
  expect(shapes).toHaveLength(1);
  const shape = first(shapes, 'commit draft');
  expect(shape.renders.length).toBeGreaterThan(0);
  expect(captured.indexOf(shape.commit)).toBe(0);
  expect(shape.commit.attributes['phase']).toBe(expectedPhase);

  for (const render of shape.renders) {
    expect(render.attributes['phase']).toBe(expectedPhase);
  }

  return shape;
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
 * The root fiber's `memoizedState`, in the shape a live React `HostRoot`
 * carries: an `element` and no `isDehydrated` flag.
 *
 * Not read by the module under test, which decides mount-versus-update per
 * fiber from that fiber's `alternate`. It is read by the layer above: bippy's
 * installed hook wrapper inspects `root.current.memoizedState` on every commit
 * to decide whether the root is still mounted and worth tracking. A synthetic
 * root that omits it is dispatched to the subscriber all the same, but it is
 * dropped from bippy's own root registry — so the realistic shape is the one
 * to hand it, and it is the piece of this structure a reader would never
 * guess.
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
 * One host fiber — a DOM node React committed — in the shape React 19 gives
 * one.
 *
 * A component is not the only thing a commit contains, and the walk has to
 * step over these: they are not emitted, but they are visited, which is what
 * the visit bound counts. Built without `alternate`, so the walk descends
 * through it, and with `PerformedWork` set, so the bound is reached for the
 * right reason rather than because the flag stopped the walk early.
 */
function syntheticHostFiber(): Fiber {
  const fiber: Record<string, unknown> = {
    tag: WORK_TAG_HOST_COMPONENT,
    key: null,
    elementType: 'div',
    type: 'div',
    stateNode: null,
    return: null,
    child: null,
    sibling: null,
    index: 0,
    memoizedProps: {},
    memoizedState: null,
    dependencies: null,
    mode: 0,
    flags: FIBER_FLAG_PERFORMED_WORK,
    subtreeFlags: FIBER_FLAG_PERFORMED_WORK,
    lanes: 0,
    childLanes: 0,
    alternate: null,
  };

  return fiber as unknown as Fiber;
}

/**
 * Link `fibers` into a parent-to-child chain, outermost first.
 *
 * Shared by the composite and host chain builders so both produce the same
 * shape of `child`/`return` links.
 */
function linkChain(fibers: readonly Fiber[]): void {
  fibers.forEach((fiber, index) => {
    const child = fibers[index + 1];
    if (child !== undefined) {
      mutateFiber(fiber, 'child', child);
      mutateFiber(child, 'return', fiber);
    }
  });
}

/**
 * A chain of `depth` host fibers with one composite fiber at the bottom.
 *
 * The structure a commit walk cannot short-circuit: nothing in it is emitted
 * until the very last fiber, so a walk bounded only by the events it produces
 * would descend the whole chain. Used to reach
 * `MAX_FIBER_VISITS_PER_COMMIT`.
 *
 * @param depth How many host fibers to stack above the composite leaf.
 * @param leafName The display name the leaf would report if it were reached.
 * @returns The outermost fiber of the chain.
 */
function syntheticHostChain(depth: number, leafName: string): Fiber {
  const hosts = Array.from({ length: depth }, () => syntheticHostFiber());
  const leaf = syntheticFiber({ name: leafName });
  const chain = [...hosts, leaf];
  linkChain(chain);
  return first(chain, 'host chain fiber');
}

/**
 * A nested chain of composite fibers: the first spec is the outermost.
 *
 * Returned in the same order as the specs, so a caller can assert on any level
 * of the chain it built.
 */
function syntheticChain(specs: readonly SyntheticFiberSpec[]): Fiber[] {
  const fibers = specs.map((spec) => syntheticFiber(spec));
  linkChain(fibers);
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
 * `previousChildren` builds the root's `alternate` — React's other tree — which
 * is what makes the root a *re-render* rather than a first render: the
 * traversal descends into a fiber's children when it has no `alternate` or when
 * its `child` pointer differs from that alternate's, and skips the subtree when
 * the pointers are identical, exactly as React DevTools does. Two distinct
 * child lists therefore keep the walk descending.
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
    await inAct(reactRuntime, () => {
      tree.root.unmount();
    });
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

/** The provider tree, and the control that changes the context value. */
interface ContextFixture {
  /** A provider over one memoized consumer and one memoized non-consumer. */
  readonly App: ComponentType<Record<string, never>>;
  /** Publish a new context value, without changing any prop below. */
  bumpTick(): void;
}

/**
 * A provider whose value changes, over two memoized children: one reads the
 * context, one does not.
 *
 * This is the fiber shape of the demo's seeded excessive-render defect (AAP
 * §0.8.2) and the one case where the traversal's descent rule can be wrong
 * without any other test noticing. React bails out on both memoized children
 * at the props level — their props are identical — and re-renders only the one
 * whose context changed, reaching it through fibers it cloned on the way down.
 * A traversal that treated an unchanged parent as an unchanged subtree would
 * report the provider and lose the consumer, which is exactly the render the
 * developer's question is about.
 */
function createContextFixture(runtime: ReactRuntime): ContextFixture {
  const react = runtime.react;
  const TickContext = react.createContext(0);
  TickContext.displayName = 'TickContext';

  function ConsumerImplementation(): ReactNode {
    const tick = react.useContext(TickContext);
    return <span data-tick={String(tick)} />;
  }
  ConsumerImplementation.displayName = CONSUMER;
  const Consumer = react.memo(ConsumerImplementation);
  Consumer.displayName = CONSUMER;

  function QuietImplementation(): ReactNode {
    return <span data-quiet="stable" />;
  }
  QuietImplementation.displayName = QUIET;
  const Quiet = react.memo(QuietImplementation);
  Quiet.displayName = QUIET;

  /** A `useState` setter, narrowed to the functional form the fixture uses. */
  type Bump = (updater: (previous: number) => number) => void;

  let bumpTickState: Bump | undefined;

  function ContextApp(): ReactNode {
    const [tick, setTick] = react.useState(0);
    // Captured during render for the same reason as the three-level fixture
    // above: the test needs the setter before any effect has run.
    bumpTickState = setTick;
    return (
      <TickContext.Provider value={tick}>
        <div className="context-app">
          <Consumer />
          <Quiet />
        </div>
      </TickContext.Provider>
    );
  }
  ContextApp.displayName = CONTEXT_APP;

  return {
    App: ContextApp,
    bumpTick: () => {
      if (bumpTickState === undefined) {
        throw new Error(`bumpTick is unavailable: ${CONTEXT_APP} has not rendered yet`);
      }
      bumpTickState((previous) => previous + 1);
    },
  };
}

/** Props of the component loaded behind the Suspense boundary. */
interface LazyLeafProps {
  /** Rendered into the DOM, so a commit's effect is observable there too. */
  readonly label: string;
}

/** The lazy tree, and the control that lets its module settle. */
interface SuspenseFixture {
  /** A shell whose Suspense boundary wraps a `React.lazy` component. */
  readonly Shell: ComponentType<Record<string, never>>;
  /** Resolve the lazy module, so React can commit the primary content. */
  settleLazy(): void;
}

/**
 * A `React.lazy` component behind a `React.Suspense` boundary, with the
 * module's arrival under the test's control.
 *
 * The structure worth covering here is not the API but the *fibers*: a
 * Suspense boundary wraps its children in fibers that are not components —
 * the boundary itself and the offscreen fragment React re-parents the primary
 * content into while a fallback is showing — and a lazy child begins life as a
 * fiber with no component at all, which React retags once the module arrives.
 * A traversal that named those fibers would put structure a developer never
 * wrote into the render table, and one that stopped at them would lose the
 * component underneath. Both mistakes are invisible without a case that
 * suspends, which is why this fixture exists (AAP §0.8.3's "expected
 * components, phases and durations" over a real React tree).
 *
 * The loader returns a promise the test settles rather than an `import()`, so
 * both commits — the fallback, then the resolved content — are observed
 * deliberately instead of raced against a module graph.
 */
function createSuspenseFixture(runtime: ReactRuntime): SuspenseFixture {
  const react = runtime.react;

  function LazyLeafImplementation(props: LazyLeafProps): ReactNode {
    return <span data-lazy={props.label}>{props.label}</span>;
  }
  LazyLeafImplementation.displayName = LAZY_LEAF;

  let settle: (() => void) | undefined;
  const loaded = new Promise<{ default: ComponentType<LazyLeafProps> }>((resolve) => {
    settle = () => {
      resolve({ default: LazyLeafImplementation });
    };
  });
  const Lazy = react.lazy(() => loaded);

  function Fallback(): ReactNode {
    return <span data-fallback="pending" />;
  }
  Fallback.displayName = FALLBACK;

  function SuspenseShell(): ReactNode {
    return (
      <div className="suspense-shell">
        <react.Suspense fallback={<Fallback />}>
          <Lazy label={LAZY_LABEL} />
        </react.Suspense>
      </div>
    );
  }
  SuspenseShell.displayName = SUSPENSE_SHELL;

  return {
    Shell: SuspenseShell,
    settleLazy: () => {
      if (settle === undefined) {
        throw new Error('the lazy module cannot settle: its promise has no resolver yet');
      }
      settle();
    },
  };
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
 * three hooks before it unmounts anything, resets the transport, and hands the
 * clock back last: the unmounts it performs run under the same fixed clock the
 * test did.
 * ---------------------------------------------------------------------------
 */

beforeEach(() => {
  clearCaptured();
  // Before anything renders, so React's profiling timer and every timestamp
  // the producer derives read the one pinned instant.
  installFixedClock();
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
  restoreFixedClock();
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

  it('sees a registered renderer once react-dom has been imported', () => {
    // Unconditional: `react-dom` is a required devDependency and its import
    // failure fails this file's collection, so there is no state in which this
    // assertion may be skipped rather than made.
    expect(hasRDTHook()).toBe(true);
    expect(rendererCount()).toBeGreaterThanOrEqual(1);
    expect(rendererCount()).toBeGreaterThan(RENDERERS_BEFORE_REACT_DOM);
    expect(detectReact()).toBe(true);
  });

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

    // The conversion the event contract turns on (AAP 0.2.3): each fiber's
    // document-relative `actualStartTime` plus this document's time origin,
    // exactly. `12` emitted as `12` would be a relative reading escaping to
    // the service, where it would sort a whole capture before every span the
    // Node preload produced.
    expect(renderOf(PARENT)?.startTime).toBe(epochAt(12));
    expect(renderOf(CHILD)?.startTime).toBe(epochAt(13));
    expect(renderOf(LEAF)?.startTime).toBe(epochAt(14));
    expect(renderOf(PARENT)?.duration).toBe(6);
    expect(renderOf(CHILD)?.duration).toBe(4);
    expect(renderOf(LEAF)?.duration).toBe(2);
    // The synthetic root fiber carries no profiling values, so the commit is
    // stamped with the instant the callback ran, read from the same clock;
    // its duration is this module's own measurement of a traversal that took
    // no measurable time on a clock that did not move.
    expect(commit.startTime).toBe(epochAt(FIXED_NOW_MS));
    expect(commit.duration).toBe(0);

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
      // No usable relative start either — absent, negative and infinite are
      // all rejected — so each render falls back to the commit's own instant,
      // which is an epoch reading and not a `-1` or a `NaN` reaching the
      // service's ingress schema.
      expect(render.startTime).toBe(epochAt(FIXED_NOW_MS));
    }
    expect(getReactStats().failures).toBe(0);
  });

  it('converts each fiber start against the document origin as the clock moves', () => {
    const fibers = syntheticChain([
      // Fractional, because the event contract keeps sub-millisecond
      // precision: two renders of one commit routinely start inside the same
      // millisecond and `../correlation/correlator.ts` orders by `startTime`
      // first.
      { name: PARENT, actualDuration: 1.25, actualStartTime: 12.5 },
      { name: CHILD, actualDuration: 0.5, actualStartTime: 13.75 },
    ]);
    const root = syntheticRoot([first(fibers, 'synthetic fiber')], 'synthetic-clock');

    attachReact();
    commitSynthetic(root);

    expect(renderOf(PARENT)?.startTime).toBe(epochAt(12.5));
    expect(renderOf(CHILD)?.startTime).toBe(epochAt(13.75));
    expect(renderOf(PARENT)?.duration).toBe(1.25);
    expect(first(draftsOfKind('commit'), 'commit draft').startTime).toBe(epochAt(FIXED_NOW_MS));

    // A second commit 40.5 ms later. A producer that had captured the origin,
    // or the instant, once at import time would stamp this commit with the
    // first one's time.
    clearCaptured();
    advanceClock(40.5);
    commitSynthetic(root);

    const later = first(draftsOfKind('commit'), 'commit draft');
    expect(later.startTime).toBe(epochAt(FIXED_NOW_MS + 40.5));
    // The fibers still carry their own relative starts, which are anchored to
    // the document origin rather than to when the commit was observed — so
    // they do not move with the clock.
    expect(renderOf(PARENT)?.startTime).toBe(epochAt(12.5));
    expect(renderOf(CHILD)?.startTime).toBe(epochAt(13.75));
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
    // The bound cuts the list; it does not cut the truth about the list. The
    // walk itself runs to the end of this tree, which is well inside
    // `MAX_FIBER_VISITS_PER_COMMIT`, so the count is the exact total.
    expect(total).toBeLessThan(MAX_FIBER_VISITS_PER_COMMIT);
    expect(commit.attributes['renderedFiberCount']).toBe(total);
    expect(commit.attributes['truncated']).toBe(true);
    expect(getReactStats().truncatedCommits).toBe(1);
    expect(getReactStats().renders).toBe(MAX_RENDERS_PER_COMMIT);
  });

  it('stops the walk at MAX_FIBER_VISITS_PER_COMMIT when nothing is being emitted', () => {
    // The case the event bound cannot bound: a chain of host fibers, none of
    // which is a component, with one component at the bottom. Emitting stops
    // after zero events because there is nothing to emit — so a traversal
    // bounded only by its output would descend every one of these fibers
    // inside React's commit phase, on the developer's click path. The walk has
    // to stop on its own, and it must not reach the leaf.
    const depth = MAX_FIBER_VISITS_PER_COMMIT + 50;
    const chain = syntheticHostChain(depth, 'UnreachableLeaf');
    const root = syntheticRoot([chain], 'synthetic-visit-bound');

    attachReact();
    commitSynthetic(root);

    const commits = draftsOfKind('commit');
    expect(commits).toHaveLength(1);
    const commit = first(commits, 'commit draft');
    expect(draftsOfKind('render')).toHaveLength(0);
    expect(renderedComponents()).not.toContain('UnreachableLeaf');
    // Truncation is stated even though no list was cut: what was cut is the
    // walk, and a reader of this commit has to know the tree was not fully
    // examined.
    expect(commit.attributes['truncated']).toBe(true);
    expect(commit.attributes['renderCount']).toBe(0);
    expect(commit.attributes['renderedFiberCount']).toBe(0);
    // A commit that rendered nothing gets no phase summary: neither `mount`
    // nor `update` would be true of it.
    expect('phase' in commit.attributes).toBe(false);
    expect(getReactStats()).toStrictEqual({
      commits: 1,
      renders: 0,
      truncatedCommits: 1,
      // Stopping at a bound is not a failure: nothing threw, and a non-zero
      // count here would be this module reporting its own bug.
      failures: 0,
    });
    expectJsonSafe(commit);
  });

  it('counts rendered fibers only as far as the visit bound let the walk go', () => {
    // Wide rather than deep, and every fiber a component: the event bound cuts
    // the list at 500 while counting continues — but only as far as the walk
    // goes, and the walk may hold and visit at most
    // `MAX_FIBER_VISITS_PER_COMMIT` fibers including the root it starts from.
    // So the count stops one short of that bound, and on a tree this large it
    // is a lower bound rather than the total, which is the one thing
    // `renderedFiberCount` must not overstate.
    const total = MAX_FIBER_VISITS_PER_COMMIT + 1_000;
    const rows = Array.from({ length: total }, (_unused, index) =>
      syntheticFiber({ name: `Wide${String(index)}` }),
    );
    const root = syntheticRoot(rows, 'synthetic-visit-bound-wide');

    attachReact();
    commitSynthetic(root);

    const { commit, renders } = expectWellFormedCommit('mount');
    expect(renders).toHaveLength(MAX_RENDERS_PER_COMMIT);
    expect(commit.attributes['renderedFiberCount']).toBe(MAX_FIBER_VISITS_PER_COMMIT - 1);
    expect(commit.attributes['renderedFiberCount']).toBeLessThan(total);
    expect(commit.attributes['truncated']).toBe(true);
    expect(getReactStats().truncatedCommits).toBe(1);
    expect(getReactStats().failures).toBe(0);
  });

  it('terminates on a fiber whose child link points back into the walk', () => {
    // No structure React builds, and exactly what a bounded walk with no set
    // of visited fibers has to survive: the visit bound is the termination
    // argument, so this test is the one that proves it.
    const [outer, inner] = syntheticChain([{ name: PARENT }, { name: CHILD }]);
    if (outer === undefined || inner === undefined) {
      throw new Error('expected two synthetic fibers');
    }
    mutateFiber(inner, 'child', outer);
    const root = syntheticRoot([outer], 'synthetic-cyclic');

    attachReact();
    expect(() => {
      commitSynthetic(root);
    }).not.toThrow();

    const commit = first(draftsOfKind('commit'), 'commit draft');
    expect(commit.attributes['truncated']).toBe(true);
    // The two components are reported over and over as the cycle is walked,
    // up to the event bound — evidence that is odd but honest, and bounded.
    expect(draftsOfKind('render')).toHaveLength(MAX_RENDERS_PER_COMMIT);
    expect(new Set(renderedComponents())).toStrictEqual(new Set([PARENT, CHILD]));
    expect(getReactStats().failures).toBe(0);
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
 * The suite AAP 0.8.3 names, and the reason this file exists: a hand-built
 * fiber proves what the walk does with a structure, while only the real
 * renderer proves the structure is the one React 19.3.0 actually builds.
 * Registered unconditionally — `react` and `react-dom` are required
 * devDependencies and an import failure fails this file's collection
 * ({@link loadReactRuntime}), so this block can never be quietly absent from a
 * green run.
 * ---------------------------------------------------------------------------
 */

describe('commit traversal — React 19 under happy-dom', () => {
  it('mounts a three-level tree as one commit with a render per component', async () => {
    await mountTree(reactRuntime, 'react-mount');

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

    // The AAP's "durations" half, on a clock this suite pinned. React's
    // profiling timer reads `performance.now()`, which does not move while the
    // tree renders, so every fiber of this commit records the same start and a
    // duration of zero — and the product's own fallback, the instant the
    // commit callback ran, is that same reading. Both routes therefore land on
    // one stated epoch value, which is what makes this an equality rather than
    // a window.
    for (const draft of [commit, ...renders]) {
      expect(draft.startTime).toBe(epochAt(FIXED_NOW_MS));
      expect(draft.duration).toBe(0);
    }

    expect(getReactStats()).toStrictEqual({
      commits: 1,
      renders: 3,
      truncatedCommits: 0,
      failures: 0,
    });
    expect(rendererCount()).toBeGreaterThanOrEqual(1);
  });

  it('carries no trigger key at all on a mount render', async () => {
    await mountTree(reactRuntime, 'react-mount-trigger');

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
    const { fixture } = await mountTree(reactRuntime, 'react-update');
    clearCaptured();

    await inAct(reactRuntime, () => {
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
    const { fixture } = await mountTree(reactRuntime, 'react-quiet');
    clearCaptured();

    await inAct(reactRuntime, () => {
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

  it('reports the fallback commit of a suspended lazy component', async () => {
    const fixture = createSuspenseFixture(reactRuntime);
    const tree = createHostRoot(reactRuntime, 'react-suspense-fallback');

    attachReact();
    await inAct(reactRuntime, () => {
      tree.root.render(<fixture.Shell />);
    });

    // React rendered the shell, hit the unresolved lazy child, and committed
    // the boundary's fallback instead of the primary content. The DOM says so
    // independently of the events.
    expect(
      document
        .querySelector('#react-suspense-fallback [data-fallback]')
        ?.getAttribute('data-fallback'),
    ).toBe('pending');
    expect(document.querySelector('#react-suspense-fallback [data-lazy]')).toBeNull();

    // Two commits, which is React 19.3.0's own behaviour for a mount that
    // suspends: the boundary's fallback is committed, and a second commit
    // follows for the same root that renders no fiber at all. Both are
    // reported, because a commit that rendered nothing is still a commit a
    // reader may need to account for — and the second one is where a producer
    // that assumed "a commit has renders" would emit a phase summary or a
    // count it cannot support.
    const shapes = expectWellFormedCommits();
    expect(shapes).toHaveLength(2);
    const rendering = first(shapes, 'fallback commit');
    const empty = shapes[1];
    if (empty === undefined) {
      throw new Error('expected a second commit for the suspended boundary');
    }

    // The components a developer wrote, and only those: the Suspense boundary
    // and the offscreen fragment React re-parents the primary tree into are
    // not components and are stepped over, while the lazy child has no
    // component yet and so has nothing to report.
    expect(renderedComponents()).toStrictEqual([SUSPENSE_SHELL, FALLBACK]);
    expect(renderedComponents()).not.toContain(LAZY_LEAF);
    expect(rendering.commit.attributes['rootName']).toBe('#react-suspense-fallback');
    expect(rendering.commit.attributes['renderedFiberCount']).toBe(2);
    expect(rendering.commit.attributes['phase']).toBe('mount');
    expect(rendering.renders).toHaveLength(2);

    expect(empty.renders).toStrictEqual([]);
    expect(empty.commit.attributes['renderCount']).toBe(0);
    expect(empty.commit.attributes['renderedFiberCount']).toBe(0);
    // Neither `mount` nor `update` would be true of a commit that rendered
    // nothing, so the key is omitted rather than guessed.
    expect('phase' in empty.commit.attributes).toBe(false);

    // Parentage twice over: every render nests in the commit that performed
    // it, and the fallback's owner chain names the shell above it — the
    // boundary's own fibers are not levels of the component tree.
    for (const render of rendering.renders) {
      expect(render.parentSpanId).toBe(rendering.commit.spanId);
      expect(render.attributes['phase']).toBe('mount');
      expect('trigger' in render.attributes).toBe(false);
      expect(render.startTime).toBe(epochAt(FIXED_NOW_MS));
      expect(Number.isFinite(render.duration)).toBe(true);
      expect(render.duration).toBeGreaterThanOrEqual(0);
    }
    expect(renderOf(FALLBACK)?.attributes['ownerChain']).toStrictEqual([SUSPENSE_SHELL]);
    expect('ownerChain' in (renderOf(SUSPENSE_SHELL)?.attributes ?? {})).toBe(false);
  });

  it('reports the resolved commit once the lazy module settles', async () => {
    const fixture = createSuspenseFixture(reactRuntime);
    const tree = createHostRoot(reactRuntime, 'react-suspense-resolved');

    attachReact();
    await inAct(reactRuntime, () => {
      tree.root.render(<fixture.Shell />);
    });
    expect(renderedComponents()).toStrictEqual([SUSPENSE_SHELL, FALLBACK]);
    const fallbackCommitSpanIds = new Set(draftsOfKind('commit').map((draft) => draft.spanId));
    clearCaptured();

    // 3 ms later, so the second commit is distinguishable from the first by
    // its timestamp as well as by its contents.
    advanceClock(3);
    await inAct(reactRuntime, () => {
      fixture.settleLazy();
    });

    expect(
      document.querySelector('#react-suspense-resolved [data-lazy]')?.getAttribute('data-lazy'),
    ).toBe(LAZY_LABEL);
    expect(document.querySelector('#react-suspense-resolved [data-fallback]')).toBeNull();

    // Exactly one commit, and not one already seen: the module settling starts
    // a fresh render pass rather than continuing the commit that showed the
    // fallback.
    const resolved = expectWellFormedCommit('mount');
    expect(fallbackCommitSpanIds.has(resolved.commit.spanId)).toBe(false);
    expect(resolved.renders).toHaveLength(1);
    expect(resolved.commit.attributes['renderedFiberCount']).toBe(1);
    expect(resolved.commit.attributes['rootName']).toBe('#react-suspense-resolved');

    // The component React retagged from the lazy placeholder, named from the
    // implementation the module exported, and a mount — this instance has no
    // previous fiber, so there is no `trigger` to report and none is written
    // (AAP §0.2.3).
    const lazyRender = renderOf(LAZY_LEAF);
    if (lazyRender === undefined) {
      throw new Error(
        `expected a render for ${LAZY_LEAF}, observed ${JSON.stringify(renderedComponents())}`,
      );
    }
    expect(lazyRender.name).toBe(LAZY_LEAF);
    expect(lazyRender.attributes['phase']).toBe('mount');
    expect('trigger' in lazyRender.attributes).toBe(false);
    expect(lazyRender.attributes['ownerChain']).toStrictEqual([SUSPENSE_SHELL]);
    expect(lazyRender.parentSpanId).toBe(resolved.commit.spanId);
    expect(lazyRender.startTime).toBe(epochAt(FIXED_NOW_MS + 3));
    expect(Number.isFinite(lazyRender.duration)).toBe(true);
    expect(lazyRender.duration).toBeGreaterThanOrEqual(0);

    // The fallback left the tree; an unmount is not a render, so nothing is
    // reported for it.
    expect(renderedComponents()).not.toContain(FALLBACK);
    expect(getReactStats().failures).toBe(0);
    for (const draft of captured) {
      expectJsonSafe(draft);
    }
  });

  it('reports a context-driven render inside a memoized subtree', async () => {
    const fixture = createContextFixture(reactRuntime);
    const tree = createHostRoot(reactRuntime, 'react-context');

    attachReact();
    await inAct(reactRuntime, () => {
      tree.root.render(<fixture.App />);
    });
    expect(renderedComponents()).toStrictEqual([CONTEXT_APP, CONSUMER, QUIET]);
    clearCaptured();

    await inAct(reactRuntime, () => {
      fixture.bumpTick();
    });

    // The shape of the demo's seeded excessive-render defect (AAP §0.8.2), and
    // the case the traversal's descent rule has to get right: the memoized
    // consumer's props are identical, so React bails out on it at the props
    // level and only reaches it because a context it reads changed. A walk
    // that pruned the subtree on its parent's unchanged children would report
    // the provider's render and silently lose the render the developer is
    // asking about.
    const { renders } = expectWellFormedCommit('update');
    expect(renderedComponents()).toStrictEqual([CONTEXT_APP, CONSUMER]);
    expect(renderOf(CONTEXT_APP)?.attributes['trigger']).toBe('state');
    expect(renderOf(CONSUMER)?.attributes['trigger']).toBe('context');
    expect(renderOf(CONSUMER)?.attributes['changedProps']).toStrictEqual([]);
    expect(renderOf(CONSUMER)?.attributes['renderCount']).toBe(2);

    // The memoized component that reads nothing did not render, so there is no
    // event for it — `unchanged_render_count` counts components React did
    // re-render with stable inputs, not components it correctly skipped.
    expect(renderOf(QUIET)).toBeUndefined();
    expect(renders).toHaveLength(2);
    expect(document.querySelector('#react-context [data-tick]')?.getAttribute('data-tick')).toBe(
      '1',
    );
  });

  it('counts renders per component within the capture and restarts after a reset', async () => {
    const { fixture } = await mountTree(reactRuntime, 'react-counts');

    expect(renderOf(PARENT)?.attributes['renderCount']).toBe(1);
    expect(renderOf(CHILD)?.attributes['renderCount']).toBe(1);
    expect(renderOf(LEAF)?.attributes['renderCount']).toBe(1);

    clearCaptured();
    await inAct(reactRuntime, () => {
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
    await inAct(reactRuntime, () => {
      fixture.bumpLabel();
    });
    expect(renderOf(PARENT)?.attributes['renderCount']).toBe(1);
    expect(renderOf(LEAF)?.attributes['renderCount']).toBe(1);
    expect(getReactStats().commits).toBe(1);
  });

  it('joins the interaction trace when a click drives the commit', async () => {
    const { tree } = await mountTree(reactRuntime, 'react-interaction');
    attachInteractions();
    expect(isInteractionsAttached()).toBe(true);
    clearCaptured();

    const target = tree.container.querySelector('.parent');
    expect(target).not.toBeNull();
    await inAct(reactRuntime, () => {
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
    const { fixture } = await mountTree(reactRuntime, 'react-state');
    attachState();
    clearCaptured();

    await inAct(reactRuntime, () => {
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
    const { fixture } = await mountTree(reactRuntime, 'react-detach');
    expect(isReactAttached()).toBe(true);
    expect(getReactStats().commits).toBe(1);

    detachReact();
    expect(isReactAttached()).toBe(false);
    clearCaptured();

    await inAct(reactRuntime, () => {
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
    const fixture = createTreeFixture(reactRuntime);
    const tree = createHostRoot(reactRuntime, 'react-idempotent');

    attachReact();
    attachReact();
    expect(isReactAttached()).toBe(true);

    await inAct(reactRuntime, () => {
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
    const { fixture } = await mountTree(reactRuntime, 'react-tree');
    clearCaptured();
    await inAct(reactRuntime, () => {
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
    await mountTree(reactRuntime, 'react-tree-bounds');

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
    const Shell = createExplodingTree(reactRuntime);
    let caught = 0;
    const tree = createHostRoot(reactRuntime, 'react-boundary', () => {
      caught += 1;
    });

    attachReact();
    await inAct(reactRuntime, () => {
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
    // The recorder is removed for this case on purpose: the point is that
    // the real `emitMany` is in the path and that its capture gate decides.
    vi.restoreAllMocks();
    transport.resetTransport();
    attachReact();

    transport.configureTransport({ enabled: false });
    const dormantFixture = createTreeFixture(reactRuntime);
    const dormantTree = createHostRoot(reactRuntime, 'react-dormant');
    await inAct(reactRuntime, () => {
      dormantTree.root.render(<dormantFixture.Parent />);
    });
    // A dormant agent on a page the developer is merely browsing keeps
    // nothing: no buffer growth, no sequence consumed (AAP 0.5.1).
    expect(transport.getTransportStats().buffered).toBe(0);
    expect(transport.getTransportStats().seq).toBe(0);
    expect(getReactStats().commits).toBe(1);

    transport.configureTransport({ sessionId: SESSION_ID, captureId: CAPTURE_ID, enabled: true });
    const armedFixture = createTreeFixture(reactRuntime);
    const armedTree = createHostRoot(reactRuntime, 'react-armed');
    await inAct(reactRuntime, () => {
      armedTree.root.render(<armedFixture.Parent />);
    });
    // One commit and one render per component, in one hand-off, consuming
    // consecutive sequence numbers.
    expect(transport.getTransportStats().seq).toBe(4);
    expect(transport.getTransportStats().buffered).toBe(4);
    expect(transport.getTransportStats().dropped).toBe(0);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A release that fails, and the failures a swallowing producer owes the channel
 *
 * Two guarantees the suites above cannot reach, because bippy 0.7.3's real
 * unsubscribe deletes one entry from a `Set` and has nothing in it that can
 * throw:
 *
 * 1. **A cleanup that fails is not a cleanup that lied** (AAP §0.5.1). The
 *    function `instrument()` returned is the only thing that can remove the
 *    handlers it installed, so `detachReact()` keeps it when calling it throws
 *    and retries on the next call, while the flag the handlers gate on is
 *    cleared first — a capture that could not be released still observes
 *    nothing. Dropping the handle instead would leave those handlers installed
 *    for the life of the document, and the next `attachReact()` would stack a
 *    *second* subscription on top: two dispatches per commit, every render
 *    event duplicated.
 * 2. **A swallowed failure is stated, not merely counted** (AAP §0.5.5). Every
 *    guard in `./react.ts` also posts an `agent.error` frame with
 *    `code: 'producer-failure'`, so a capture that lost its render evidence —
 *    the whole basis of "why is this component rendering so many times?"
 *    (AAP §0.8.4) — cannot present itself to either UI as a capture that
 *    succeeded.
 *
 * Everything needed to provoke that path is built **inside** the tests, never
 * at module scope, so the cases above keep running against the real library
 * through this file's static imports:
 *
 * - `vi.doMock` is not hoisted, so it may close over locals and applies only
 *   to imports made after it;
 * - its factory starts from `await vi.importActual('bippy')` and overrides
 *   `instrument` alone, leaving the traversal, the work-tag tables and the
 *   hook helpers real;
 * - `vi.resetModules()` then `await import('./react.js')` gives the module a
 *   fresh graph, `./transport.js` included — which is why the transport this
 *   section observes is imported the same way rather than reused from the top
 *   of the file;
 * - the `finally` unmocks and resets the registry, so no later test file
 *   inherits any of it.
 *
 * The failure frames are read off `window.postMessage`, because a control
 * frame needs no bridge handshake: `postControl` posts it whether or not a
 * bridge has announced itself, which is what makes a producer failure
 * reportable during teardown.
 * ---------------------------------------------------------------------------
 */

/** The callbacks `./react.ts` registers, as the faked `instrument()` sees them. */
interface RegisteredHandlers {
  /** React's commit callback: the source of every event in this file. */
  onCommitFiberRoot?: (rendererId: number, root: FiberRoot, priority?: unknown) => unknown;
  /** React's post-commit callback. */
  onPostCommitFiberRoot?: (rendererId: number, root: FiberRoot) => unknown;
  /** React's unmount callback. */
  onCommitFiberUnmount?: (rendererId: number, fiber: Fiber) => unknown;
}

/**
 * Import `./react.ts` against a bippy whose release throws its first
 * `releaseFailures` calls and succeeds afterwards.
 *
 * The counter is explicit rather than read off the spy so the schedule is a
 * property of the fake and not of the assertion order.
 *
 * @param releaseFailures How many release attempts throw before one succeeds.
 * @returns The freshly imported module, its fresh transport, the two spies and
 * the handlers the module registered.
 */
async function mockedReactModule(releaseFailures: number) {
  let releaseAttempts = 0;
  const release = vi.fn(() => {
    releaseAttempts += 1;
    if (releaseAttempts <= releaseFailures) {
      throw new TypeError('react.test.tsx: deliberate release failure');
    }
  });

  let registered: RegisteredHandlers = {};
  const instrumentFake = vi.fn((options: RegisteredHandlers) => {
    registered = options;
    return release;
  });

  vi.doMock('bippy', async () => {
    const actual = await vi.importActual<typeof import('bippy')>('bippy');
    return { ...actual, instrument: instrumentFake };
  });
  vi.resetModules();

  const reactModule = await import('./react.js');
  const transportModule = await import('./transport.js');

  return {
    /** The module under test, on its own module graph. */
    react: reactModule,
    /** The transport instance that module posts through. */
    transport: transportModule,
    /** The faked release; its call count is the retry evidence. */
    release,
    /** The faked `instrument`; its call count is the no-double-subscribe evidence. */
    instrument: instrumentFake,
    /** The handlers the module registered, empty until it subscribes. */
    handlers: (): RegisteredHandlers => registered,
  };
}

/**
 * Run `scenario` against a freshly imported `./react.ts` and undo the mock
 * whatever the scenario does.
 *
 * @param releaseFailures Handed to {@link mockedReactModule}.
 * @param scenario The case body, which receives the harness.
 */
async function withMockedBippy(
  releaseFailures: number,
  scenario: (harness: Awaited<ReturnType<typeof mockedReactModule>>) => Promise<void> | void,
): Promise<void> {
  const harness = await mockedReactModule(releaseFailures);
  try {
    await scenario(harness);
  } finally {
    vi.doUnmock('bippy');
    vi.resetModules();
  }
}

/** Dispatch one commit to the handlers the module registered. */
function dispatchCommit(handlers: RegisteredHandlers, root: FiberRoot): void {
  const onCommitFiberRoot = handlers.onCommitFiberRoot;
  if (onCommitFiberRoot === undefined) {
    throw new Error('expected ./react.ts to have registered an onCommitFiberRoot handler');
  }
  onCommitFiberRoot(RENDERER_ID, root, undefined);
}

/** A one-component synthetic root, named so two roots stay distinguishable. */
function oneComponentRoot(containerId: string): FiberRoot {
  return syntheticRoot([first(syntheticChain([{ name: PARENT }]), 'synthetic fiber')], containerId);
}

/**
 * The `producer-failure` payloads a spied `window.postMessage` observed.
 *
 * Filtered on the agent's source tag, so an unrelated frame — a page's own
 * `postMessage`, a bridge frame — is never read as a report.
 *
 * @param messages The first argument of each recorded `postMessage` call.
 * @returns The payload of each `agent.error` frame that reports a producer
 * failure, in the order they were posted.
 */
function producerFailurePayloads(messages: readonly unknown[]): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      continue;
    }
    const frame = message as { source?: unknown; type?: unknown; payload?: unknown };
    if (frame.source !== 'debuggen-agent' || frame.type !== 'agent.error') {
      continue;
    }
    const payload = frame.payload;
    if (typeof payload !== 'object' || payload === null) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    if (record['code'] === 'producer-failure') {
      payloads.push(record);
    }
  }
  return payloads;
}

describe('cleanup that cannot complete, and the failures it reports', () => {
  it('stops observing and reports producer-failure when the release throws', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');

    await withMockedBippy(
      1,
      ({ react: reactModule, release, instrument: instrumentFake, handlers }) => {
        reactModule.attachReact();
        expect(instrumentFake).toHaveBeenCalledTimes(1);
        expect(reactModule.isReactAttached()).toBe(true);

        reactModule.detachReact();

        expect(release).toHaveBeenCalledTimes(1);
        // The gate is cleared before the release is attempted, so "attached"
        // keeps meaning "observing" — never a flag claiming an observation that
        // is not happening.
        expect(reactModule.isReactAttached()).toBe(false);
        expect(reactModule.getReactStats().failures).toBe(1);

        // The handlers really are still installed — that is why the handle is
        // retained — and a commit dispatched to them produces nothing at all.
        dispatchCommit(handlers(), oneComponentRoot('release-failure-gate'));
        expect(reactModule.getReactStats().commits).toBe(0);
        expect(reactModule.getReactStats().renders).toBe(0);

        const failures = producerFailurePayloads(
          postSpy.mock.calls.map((call) => call[0] as unknown),
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]?.['source']).toBe('react');
        expect(failures[0]?.['stage']).toBe('release');
        // The thrown value's type, and nothing the developer's page could have
        // put in its message.
        expect(failures[0]?.['error']).toBe('TypeError');
        expect(failures[0]?.['occurrence']).toBe(1);
      },
    );
  });

  it('retries the retained release on the next detachReact and drops it once it succeeds', async () => {
    await withMockedBippy(1, ({ react: reactModule, release }) => {
      reactModule.attachReact();

      reactModule.detachReact();
      expect(release).toHaveBeenCalledTimes(1);

      // The retry: the handle a failed release left behind is the only thing
      // that can still remove those handlers (AAP §0.5.1).
      reactModule.detachReact();
      expect(release).toHaveBeenCalledTimes(2);
      expect(reactModule.isReactAttached()).toBe(false);
      // Nothing failed this time, so the counters a detach resets stay reset.
      expect(reactModule.getReactStats()).toStrictEqual({
        commits: 0,
        renders: 0,
        truncatedCommits: 0,
        failures: 0,
      });

      // A call that returned normally proved the handlers are gone, so there
      // is nothing left to retry.
      reactModule.detachReact();
      expect(release).toHaveBeenCalledTimes(2);
    });
  });

  it('re-arms the retained subscription instead of instrumenting a second time', async () => {
    await withMockedBippy(
      1,
      ({ react: reactModule, release, instrument: instrumentFake, handlers }) => {
        reactModule.attachReact();
        reactModule.detachReact();
        expect(release).toHaveBeenCalledTimes(1);
        expect(reactModule.isReactAttached()).toBe(false);

        reactModule.attachReact();

        // The regression this case exists for: a second `instrument()` adds a
        // second entry to bippy's dispatch set, and every commit from then on
        // would be observed — and emitted — twice.
        expect(instrumentFake).toHaveBeenCalledTimes(1);
        expect(reactModule.isReactAttached()).toBe(true);

        // Observation resumed through the subscription that was never released:
        // one dispatch, one commit, one render.
        dispatchCommit(handlers(), oneComponentRoot('release-failure-rearm'));
        expect(reactModule.getReactStats().commits).toBe(1);
        expect(reactModule.getReactStats().renders).toBe(1);

        reactModule.detachReact();
        expect(release).toHaveBeenCalledTimes(2);
        expect(reactModule.isReactAttached()).toBe(false);
      },
    );
  });

  it('reports a commit whose body throws once and keeps it away from React', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');

    await withMockedBippy(0, ({ react: reactModule, transport: freshTransport, handlers }) => {
      // The hand-off is the last step of the commit body, so a throw here is a
      // whole commit lost: no commit event, no render events, no evidence.
      vi.spyOn(freshTransport, 'emitMany').mockImplementation(() => {
        throw new TypeError('react.test.tsx: deliberate emit failure');
      });

      reactModule.attachReact();
      const root = oneComponentRoot('commit-body-failure');

      // A throw out of here would surface inside React's commit phase, which
      // is the one failure this product may never cause.
      expect(() => {
        dispatchCommit(handlers(), root);
      }).not.toThrow();

      expect(reactModule.getReactStats().commits).toBe(1);
      expect(reactModule.getReactStats().failures).toBe(1);

      const failures = producerFailurePayloads(
        postSpy.mock.calls.map((call) => call[0] as unknown),
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.['source']).toBe('react');
      expect(failures[0]?.['stage']).toBe('commit');
      expect(failures[0]?.['error']).toBe('TypeError');
      // Bounded by the transport, not by a second limiter here: a source gets
      // one frame per capture (`MAX_PRODUCER_FAILURE_REPORTS`), so the frame
      // this commit produced is also the last one this source gets.
      expect(failures[0]?.['final']).toBe(true);
    });
  });
});
