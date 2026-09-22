/**
 * The page agent's entry point and lifecycle owner: the one module in this
 * folder that runs on import, and the only one that decides when any of the
 * others observes anything.
 *
 * ## Where this code runs
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this file — and everything it
 * imports — into the self-contained IIFE `dist/browser-agent.iife.js`.
 * `scripts/copy-agent.mjs` then copies those bytes **verbatim** into
 * `apps/chrome-extension/public/agent.iife.js` and verifies the copy by
 * SHA-256, and `apps/chrome-extension/manifest.config.ts` declares that file
 * directly as a content script with `world: "MAIN"`, `run_at:
 * "document_start"` and `all_frames: false`, matched to the local app origins.
 * Three consequences follow, and every one of them is a constraint on this
 * file rather than on the build:
 *
 * 1. **The bundle must be self-contained.** No loader exists beneath it and
 *    nothing re-writes it on the way to Chrome. It may not reach for a Node
 *    builtin, for `@debuggen/protocol`, for `@debuggen/shared`'s Node entry or
 *    for `zod`; the build's resolver plugin and metafile audit fail the build
 *    if it does. What this file needs from the protocol — the shape of an
 *    `agent.config` payload — is therefore restated structurally below, in the
 *    same way `../node/control.ts` restates it for the server side.
 * 2. **It runs in the developer's own page, in the page's own realm.** Every
 *    global is shared with the application, so each one is reached behind a
 *    `typeof` guard, nothing here is allowed to throw into page code, and
 *    nothing is written to the page console unless the service explicitly asks
 *    for it (`debug: true` on the configuration).
 * 3. **It is minified with no banner.** Function and class names do not
 *    survive, so nothing may depend on them, and timer handles are typed
 *    `ReturnType<typeof setTimeout>` because this program also types the Node
 *    preload.
 *
 * `packages/telemetry/src/index.ts` must never re-export this subtree: the
 * agent is delivered as that static artifact, and re-exporting it would put
 * import-time side effects — hook installation and a global — into every
 * consumer that imports the package for its types.
 *
 * ## The opening sequence, and why its order is load-bearing
 *
 * React registers itself with `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` when it
 * initialises. If the hook is not already there at that instant, React never
 * registers, and **no commit is observable for the life of that document** —
 * there is no retry and no recovery. So the first thing that happens in this
 * bundle, before any statement of this module's body, is the installation of
 * that hook (step 1). The second is the installation of
 * `globalThis.__DEBUGGEN__` (step 2), because a function patched by
 * `packages/instrumentation/src/patch/function-timing.ts` can execute at any
 * moment and its wrapper's `if (__dbg && typeof __dbg.span === "function")`
 * check must find a helper. Both happen while the agent is **dormant**: no
 * listener, no observer, no patch and no subscription exists until the service
 * arms one.
 *
 * Then, in order: subscribe to the isolated-world bridge and announce
 * `agent.ready` (step 3); register the two flush hooks that get a capture's
 * tail out of a document that is going away (step 4); and stop (step 5). A
 * page the developer is merely browsing carries an installed hook, an inert
 * helper and two idle listeners, and nothing else.
 *
 * ## Dormant until armed, and disabled — not idled — afterwards
 *
 * `agent.config` is the only thing that arms a signal, and an `agent.config`
 * with every hook false (or with no `captureId`) returns the agent to the
 * dormant state above: listeners detached, the `fetch`/`XHR` patch restored to
 * the page's original functions, bippy's handlers unsubscribed through the
 * function `instrument()` returned, observers disconnected, buffers empty
 * (AAP 0.5.1). The span helper stays installed and becomes a pass-through
 * again, which is deliberate: code patched during the session may still be
 * loaded in the page, and an inert helper serves it at zero cost.
 *
 * Two races shape the rest of this file, and both are the Chrome extension's
 * doing rather than accidents:
 *
 * - **The bridge may not be listening yet.** The MAIN-world agent and the
 *   isolated-world bridge are two content scripts injected at the same moment,
 *   with no guaranteed relative order. `./transport.js` therefore buffers, and
 *   a `bridge.ready` frame is the cue to re-announce.
 * - **A configuration can arrive at any time.** After a same-origin
 *   navigation, `apps/chrome-extension/src/background/agent-control.ts`
 *   re-sends the live `agent.config` so the same `captureId` continues across
 *   the reload. {@link applyConfig} is consequently safe to receive
 *   immediately after install, twice in a row, or with a subset of the hooks
 *   it last saw.
 *
 * ## What this module does not do
 *
 * It holds no credential and never speaks to the local service: it posts to
 * the bridge, the bridge relays to the service worker, and the worker adds the
 * `tabId` and wraps the payload in a protocol envelope. It also produces no
 * telemetry of its own beyond one event — the component-tree snapshot taken as
 * a capture stops (see {@link applyConfig}) — because every signal belongs to
 * the sibling that owns it.
 */

/*
 * Step 1 of the opening sequence, expressed as the bundle's first import so
 * that ES module evaluation order puts it ahead of every statement in this
 * file.
 *
 * `bippy/install-hook-only` is a **side-effect-only** entry: its type
 * declaration is `export {}` and its whole body is `try { getRDTHook() }
 * catch {}`, which installs the React DevTools global hook when none exists
 * and patches the one that does. That is precisely the operation wanted here,
 * and it is why this is a bare import rather than a call:
 *
 * - The entry exports no function, so `installRDTHook` cannot be imported
 *   from it (`export {}` — TS2305 if tried).
 * - bippy's `installRDTHook()` from the package root must **not** be called
 *   when a hook may already exist: it unconditionally builds a fresh
 *   `renderers` map and redefines the global, so calling it after React (or
 *   the real React DevTools extension) registered would discard that
 *   registration and make every commit unobservable — the exact failure this
 *   step exists to prevent. `getRDTHook()`, which this entry runs, installs or
 *   patches and never discards.
 *
 * Reading the pre-existing renderer count *after* this import is still
 * accurate, which is what lets {@link getAgentState}'s `installedBeforeReact`
 * be computed in the body below: installing or patching a hook registers no
 * renderer, so the count this module reads is the count that existed before
 * the import ran.
 */
import 'bippy/install-hook-only';

import { resetContinuations } from './continuation.js';
import { describeElement } from './dom-target.js';
import { attachErrors, detachErrors, isErrorsAttached } from './errors.js';
import { attachFetch, detachFetch, isFetchAttached } from './fetch.js';
import { getDocumentId, getProducerId, newSpanId } from './ids.js';
import {
  attachInteractions,
  detachInteractions,
  isInteractionsAttached,
  resolveEventContext,
} from './interaction.js';
import { attachPerf, detachPerf, isPerfAttached } from './perf.js';
import {
  attachReact,
  detachReact,
  detectReact,
  isReactAttached,
  resetReactCounters,
  snapshotComponentTree,
} from './react.js';
import type { ComponentTreeNode } from './react.js';
import {
  installSpanHelper,
  resetSpanStack,
  setSpanHelperConfig,
  setSpanHelperEnabled,
} from './span-helper.js';
import { attachState, detachState, isStateAttached, resetStateCounters } from './state.js';
import {
  configureTransport,
  emit,
  flush,
  nowEpochMs,
  postControl,
  resetTransport,
  subscribe,
} from './transport.js';
import type { BridgeInboundMessage, EventDraft } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Published constants
 * ---------------------------------------------------------------------------
 */

/**
 * The build version this bundle announces in its `agent.ready` frame.
 *
 * It matters because the agent is a *static* content script: a page loaded
 * before the extension was updated keeps running the bundle it was loaded
 * with, so the service worker can be talking to an older agent than the one on
 * disk. Bumped whenever the frames this file posts, or the configuration it
 * understands, change in a way a reader could notice.
 */
export const AGENT_VERSION = 1;

/**
 * The hook names this agent understands, in **attach order**.
 *
 * The order is the contract, not a listing convenience: interactions come
 * first because {@link resolveEventContext} is what every other producer asks
 * which trace an event belongs to, the network patch second so a request
 * started inside the first interaction is already correlated, state third
 * because `./react.js` hands its transitions to `./state.js` as it walks a
 * commit, and the observers and error listeners last because neither depends
 * on the others. Detach runs this list in reverse, so context outlives the
 * producers that use it.
 */
const HOOK_NAMES = Object.freeze([
  'interaction',
  'fetch',
  'state',
  'react',
  'perf',
  'errors',
] as const);

/** One member of the closed hook vocabulary. */
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * Every configuration key accepted for each hook, canonical name first.
 *
 * **Reconcile with `packages/protocol/src/messages/agent.ts`**, which defines
 * the real `AgentHookConfig` and which this bundle may not import (the agent
 * emits raw event batches and the service worker wraps them in protocol
 * envelopes, so protocol stays out of the page — AAP 0.2.3). Until the two are
 * reconciled, a naming difference between the message schema and this file
 * would silently disable a signal: the developer would reproduce their problem
 * exactly as asked and the capture would come back missing the evidence. The
 * aliases below are the plausible spellings of each signal, so a mismatch
 * costs nothing; anything unrecognised is ignored rather than guessed at.
 *
 * Exported so that a later change can align the two files — and assert the
 * alignment in a test — rather than rediscovering this list by reading the
 * bundle.
 */
export const HOOK_ALIASES: Readonly<Record<HookName, readonly string[]>> = Object.freeze({
  interaction: Object.freeze(['interaction', 'interactions']),
  fetch: Object.freeze(['fetch', 'network', 'fetchTracking']),
  state: Object.freeze(['state', 'stateTransitions']),
  react: Object.freeze(['react', 'reactRenders', 'renders']),
  perf: Object.freeze(['perf', 'performance', 'perfTracking']),
  errors: Object.freeze(['errors', 'error']),
});

/*
 * ---------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------
 */

/**
 * How long after install to re-check whether React has registered, once.
 *
 * The `agent.ready` frame reports `reactDetected`, and at `document_start`
 * that answer is routinely a truthful "not yet" — the application's own
 * bundle has not run. `apps/local-service/src/instrumentation/readiness.ts`
 * reads it, so leaving the first answer standing would describe a React
 * application as a page without React for the rest of the session.
 *
 * One timer, one check, no interval: a poll in someone else's page is work the
 * agent has no right to schedule, and the case this covers — React
 * initialising a beat after the agent — resolves within the first paint. Every
 * inbound configuration re-checks as well, which covers a slower start without
 * any timer at all.
 */
const REACT_RECHECK_DELAY_MS = 1000;

/** The event name the component-tree snapshot is emitted under. */
const COMPONENT_TREE_EVENT_NAME = 'react.component-tree';

/**
 * The key this module marks `globalThis` with so a second injection of the
 * bundle into one document stands down.
 *
 * A registered symbol rather than a string property: two evaluations of this
 * bundle in one document share the realm and therefore the symbol registry, so
 * the marker is found, while nothing enumerable is added to the page's globals.
 * A host without `Symbol.for` falls back to a string key, because standing
 * down matters more than tidiness.
 */
const INSTALL_MARKER = 'debuggen.agent.installed';

/*
 * ---------------------------------------------------------------------------
 * Local structural types
 *
 * Every shape that arrives from outside this bundle is declared here rather
 * than imported, because the modules that own those shapes sit above this
 * package (`@debuggen/protocol`) or are the page itself. A structural mirror
 * read defensively is the only honest way to consume either.
 * ---------------------------------------------------------------------------
 */

/**
 * An `agent.config` payload as it arrives: three keys this module cares about,
 * all untyped.
 *
 * The authority is `packages/protocol/src/messages/agent.ts`'s
 * `AgentHookConfig`, which this bundle may not import (see
 * {@link HOOK_ALIASES}). Nothing is asserted about the values — a flag that is
 * not exactly `true` is off, a session or capture id that is not a non-empty
 * string is absent, and an unknown key is ignored — so a protocol change can
 * add fields, rename a hook it has an alias for, or send a malformed frame
 * without arming something the developer did not ask for or throwing inside
 * their page.
 */
interface InboundAgentConfig {
  /** The session the bound tab is serving. */
  sessionId?: unknown;
  /** The capture window the events belong to; its absence means "no capture". */
  captureId?: unknown;
  /** Which signals to observe; see {@link HOOK_ALIASES}. */
  hooks?: Record<string, unknown>;
}

/** An `agent.config` payload after {@link parseConfig} has read it. */
interface ParsedAgentConfig {
  /** The session id, or `undefined` when none was readable. */
  sessionId: string | undefined;
  /** The capture id, or `undefined` — which by itself means "disarm". */
  captureId: string | undefined;
  /** Every hook's desired state; a key is always present. */
  hooks: Readonly<Record<HookName, boolean>>;
  /** The hooks asked for, in {@link HOOK_NAMES} order. */
  enabled: readonly HookName[];
  /** Whether the service asked for page-console diagnostics. */
  debug: boolean;
  /** Component-tree bounds the service asked for, if any. */
  tree: TreeBounds;
}

/**
 * Bounds for {@link snapshotComponentTree}, as the service may request them.
 *
 * Carried through rather than fixed here: `./react.js` owns the defaults
 * (`MAX_TREE_NODES`, `MAX_TREE_DEPTH`) and the service is the side that knows
 * how large a snapshot its panel is willing to render. Both fields are
 * declared as "number or undefined" rather than optional because the
 * repository compiles with `exactOptionalPropertyTypes` and this record is
 * always fully built.
 */
interface TreeBounds {
  /** Most nodes to include, or `undefined` for the producer's default. */
  maxNodes: number | undefined;
  /** Deepest level to walk, or `undefined` for the producer's default. */
  maxDepth: number | undefined;
}

/**
 * The parts of the React DevTools global hook this module reads.
 *
 * Structural and all-optional: the hook may be bippy's, the real React
 * DevTools extension's, or a stub something else installed, and the only
 * question asked of it is how many renderers have registered.
 */
interface ReactDevToolsHookView {
  /** The renderer registry, whose `size` is React's registration count. */
  renderers?: { size?: unknown } | undefined;
}

/** A structural, mutable view of the globals this module touches. */
interface AgentGlobalScope {
  /** The React DevTools global hook, whatever installed it. */
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
}

/** One hook's three lifecycle functions, as the ordered loops below use them. */
interface HookBinding {
  /** Arm the signal. Idempotent and never throws (see each sibling). */
  attach: () => void;
  /** Disarm the signal and release everything it held. */
  detach: () => void;
  /** Whether the signal is armed right now — the source of truth. */
  isAttached: () => boolean;
}

/**
 * The hook table, keyed by {@link HookName}.
 *
 * Total by construction: a name added to {@link HOOK_NAMES} without an entry
 * here is a compile error, which is what keeps the attach, detach and
 * reporting loops from silently skipping a signal.
 */
const HOOK_BINDINGS: Readonly<Record<HookName, HookBinding>> = Object.freeze({
  interaction: {
    attach: attachInteractions,
    detach: detachInteractions,
    isAttached: isInteractionsAttached,
  },
  fetch: { attach: attachFetch, detach: detachFetch, isAttached: isFetchAttached },
  state: { attach: attachState, detach: detachState, isAttached: isStateAttached },
  react: { attach: attachReact, detach: detachReact, isAttached: isReactAttached },
  perf: { attach: attachPerf, detach: detachPerf, isAttached: isPerfAttached },
  errors: { attach: attachErrors, detach: detachErrors, isAttached: isErrorsAttached },
});

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * One page document's worth. The bundle is evaluated once per document, so a
 * reload gives a fresh set of these bindings alongside the fresh producer id
 * `./ids.js` mints and the fresh sequence `./transport.js` starts — which is
 * exactly the scope the event ordering rules in `../schema/event.ts` assume.
 * ---------------------------------------------------------------------------
 */

/** Whether *this* module instance completed the opening sequence. */
let installed = false;

/**
 * Whether the DevTools hook was in place before React registered with it.
 *
 * The heuristic, and it is a heuristic: at `document_start` the parser has not
 * finished, so `document.readyState === 'loading'` together with a hook that
 * has no registered renderer is strong evidence the agent preceded React. Both
 * halves are needed — a renderer already registered proves the agent was late,
 * and a `readyState` past `'loading'` means the document had already run
 * scripts, which is the case after a dynamic injection into an open tab.
 *
 * `apps/local-service/src/instrumentation/readiness.ts` gates capture
 * readiness on this flag, and the service worker offers a consented
 * `chrome.tabs.reload` when it is false, so an over-confident value costs the
 * developer a silently empty capture and an under-confident one costs them an
 * unnecessary reload.
 */
let installedBeforeReact = false;

/** `document.readyState` as it was when the opening sequence ran. */
let initialReadyState = 'complete';

/** What the last `agent.ready` frame claimed about React's presence. */
let announcedReactDetected = false;

/** The single pending React re-check, if one is still outstanding. */
let reactRecheckTimer: ReturnType<typeof setTimeout> | undefined;

/** Releases this module's bridge subscription; re-made after a transport reset. */
let unsubscribeBridge: (() => void) | undefined;

/** The session the current configuration named, while armed. */
let armedSessionId: string | undefined;

/**
 * The capture the current configuration named, while armed.
 *
 * Also the idempotence key: a configuration that names the same capture is a
 * re-send (the service worker re-sends after a reconnect and after a
 * same-origin navigation) and must not restart the per-capture counters, while
 * a different capture must.
 */
let armedCaptureId: string | undefined;

/** Whether the service asked for page-console diagnostics. */
let debugEnabled = false;

/** Component-tree bounds from the live configuration. */
let treeBounds: TreeBounds = { maxNodes: undefined, maxDepth: undefined };

/**
 * Hooks that were asked for and did not attach, for the current capture.
 *
 * Cleared whenever the capture changes. Its purpose is idempotence with
 * honesty: a host with no `PerformanceObserver` will refuse the performance
 * hook every time it is asked, and re-attempting on each re-sent
 * configuration would reset that module's counters and re-report the same
 * unavailable signal for the life of the capture.
 */
const failedHooks = new Set<HookName>();

/**
 * The `pagehide` listener, once registered.
 *
 * Held for idempotence rather than for removal: the flush hooks belong to the
 * document, not to a capture, so they outlive every arm and disarm — a
 * capture's tail must still reach the bridge when the developer navigates away
 * mid-session. The reference is what makes a second registration attempt a
 * no-op.
 */
let pageHideListener: (() => void) | undefined;

/** The `visibilitychange` listener, held for the same reason. */
let visibilityListener: (() => void) | undefined;

/*
 * ---------------------------------------------------------------------------
 * Defensive readers
 *
 * Everything below reads a value this module does not own: a page global, or a
 * payload relayed from the extension. Each one answers with a usable value or
 * with `undefined`, and none of them throws.
 * ---------------------------------------------------------------------------
 */

/**
 * A structural view of the globals this module reads.
 *
 * The double assertion is required rather than stylistic: `typeof globalThis`
 * already declares `__REACT_DEVTOOLS_GLOBAL_HOOK__` with bippy's own type, and
 * a direct assertion between that and a view declaring it `unknown` would be
 * rejected as a mistake. The same idiom is used in `./span-helper.ts`.
 */
const globalScope = globalThis as unknown as AgentGlobalScope;

/**
 * The install marker's key: a registered symbol where the host has one.
 *
 * @returns A key usable as a property name on the global object.
 */
function markerKey(): symbol | string {
  try {
    if (typeof Symbol !== 'undefined' && typeof Symbol.for === 'function') {
      return Symbol.for(INSTALL_MARKER);
    }
  } catch {
    // A page that replaced `Symbol` gets the string key instead.
  }
  return `__${INSTALL_MARKER.replaceAll('.', '_')}__`;
}

/**
 * Whether another evaluation of this bundle already owns this document.
 *
 * @returns `true` when a marker is present.
 */
function isAgentInstalledInDocument(): boolean {
  try {
    return (globalThis as unknown as Record<symbol | string, unknown>)[markerKey()] === true;
  } catch {
    // An unreadable global cannot be proof of an earlier install; the
    // double-install guard fails open, and the sibling modules are idempotent.
    return false;
  }
}

/**
 * Claim this document for this module instance.
 *
 * Non-enumerable and configurable, so the page's own enumeration of its
 * globals is unchanged and a teardown could remove it. A host that refuses the
 * definition leaves the marker unwritten, which is survivable: the sibling
 * modules' attach functions are all idempotent.
 */
function markAgentInstalledInDocument(): void {
  try {
    Object.defineProperty(globalThis, markerKey(), {
      value: true,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {
    // Nothing further to try; see above for why this is not fatal.
  }
}

/**
 * The React DevTools global hook, as a structural view.
 *
 * @returns The hook, or `undefined` when the global holds no object.
 */
function readReactHook(): ReactDevToolsHookView | undefined {
  try {
    const hook = globalScope.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    // No assertion is needed or allowed: narrowing `unknown` to `object` is
    // already assignable to this view, every member of which is optional.
    return typeof hook === 'object' && hook !== null ? hook : undefined;
  } catch {
    // A throwing accessor on the global object tells us nothing about React.
    return undefined;
  }
}

/**
 * How many renderers have registered with the hook.
 *
 * @returns The count, or `0` when there is no hook or no readable registry.
 */
function registeredRendererCount(): number {
  try {
    const size = readReactHook()?.renderers?.size;
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

/**
 * `document.readyState`, or `'complete'` where there is no document to ask.
 *
 * The fallback is the pessimistic answer on purpose: it makes
 * {@link installedBeforeReact} false, which asks the developer for a reload
 * instead of promising a capture the agent may be too late to observe.
 */
function readDocumentReadyState(): string {
  try {
    if (typeof document === 'undefined') {
      return 'complete';
    }
    const state: unknown = document.readyState;
    return typeof state === 'string' ? state : 'complete';
  } catch {
    return 'complete';
  }
}

/** The document's URL, unredacted — the service redacts at ingest. */
function readLocationHref(): string {
  try {
    return typeof location !== 'undefined' && typeof location.href === 'string'
      ? location.href
      : '';
  } catch {
    return '';
  }
}

/**
 * A plain object, or `undefined`.
 *
 * Arrays are rejected: every record this module reads is a keyed bag, and an
 * array reaching one of them is a malformed frame rather than an empty bag.
 */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** A non-empty string, trimmed of nothing, or `undefined`. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A positive, finite, safe integer, or `undefined`. */
function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Whether a relayed flag is on.
 *
 * Compared against `true` rather than coerced: a flag that arrives as the
 * string `'false'`, as `0`, or as an object is a malformed frame, and reading
 * any of those as "on" would arm a signal the developer did not ask for.
 */
function readFlag(value: unknown): boolean {
  return value === true;
}

/*
 * ---------------------------------------------------------------------------
 * Configuration parsing
 * ---------------------------------------------------------------------------
 */

/**
 * Lift the three protocol fields out of a relayed payload.
 *
 * @param record The payload as an object, or `undefined` when it was not one.
 * @returns The structural mirror, with only the keys that were present.
 */
function readInboundConfig(record: Record<string, unknown> | undefined): InboundAgentConfig {
  const config: InboundAgentConfig = {};
  if (record === undefined) {
    return config;
  }

  if ('sessionId' in record) {
    config.sessionId = record['sessionId'];
  }
  if ('captureId' in record) {
    config.captureId = record['captureId'];
  }

  const hooks = readRecord(record['hooks']);
  if (hooks !== undefined) {
    config.hooks = hooks;
  }
  return config;
}

/**
 * Build a total `HookName` record from a per-name predicate.
 *
 * The one assertion in this file, and it is total by construction:
 * {@link HOOK_NAMES} is the key domain of `Record<HookName, boolean>` and the
 * loop visits every member, so the partial is fully populated before it is
 * read. Writing the six keys out by hand instead would let a hook added to the
 * vocabulary be silently missing from one of the three records built this way.
 */
function hookRecord(predicate: (name: HookName) => boolean): Record<HookName, boolean> {
  const state: Partial<Record<HookName, boolean>> = {};
  for (const name of HOOK_NAMES) {
    state[name] = predicate(name);
  }
  return state as Record<HookName, boolean>;
}

/**
 * Component-tree bounds, read from wherever the service put them.
 *
 * Three spellings are accepted for the same reason the hook aliases exist: the
 * message schema is not written yet, and a bound that is not understood costs
 * either a snapshot larger than the panel wants or — worse — nothing at all.
 * Anything that is not a positive safe integer is ignored, which leaves
 * `./react.js`'s own defaults in force.
 */
function readTreeBounds(record: Record<string, unknown> | undefined): TreeBounds {
  if (record === undefined) {
    return { maxNodes: undefined, maxDepth: undefined };
  }

  const nested = readRecord(record['tree']);
  return {
    maxNodes:
      readPositiveInteger(record['maxTreeNodes']) ??
      readPositiveInteger(record['maxNodes']) ??
      readPositiveInteger(nested?.['maxNodes']),
    maxDepth:
      readPositiveInteger(record['maxTreeDepth']) ??
      readPositiveInteger(record['maxDepth']) ??
      readPositiveInteger(nested?.['maxDepth']),
  };
}

/**
 * Read an `agent.config` payload into the decisions this module acts on.
 *
 * Permissive by design and total in its result: a payload that is not an
 * object at all parses to "no session, no capture, every hook off", which is
 * the disarm request — the safe reading of a frame this module cannot
 * understand.
 *
 * @param payload The frame's payload, verbatim and untrusted.
 */
function parseConfig(payload: unknown): ParsedAgentConfig {
  const record = readRecord(payload);
  const config = readInboundConfig(record);
  const hooksRecord = config.hooks;

  const hooks = hookRecord((name) =>
    hooksRecord === undefined
      ? false
      : HOOK_ALIASES[name].some((alias) => readFlag(hooksRecord[alias])),
  );

  return {
    sessionId: readString(config.sessionId),
    captureId: readString(config.captureId),
    hooks,
    enabled: HOOK_NAMES.filter((name) => hooks[name]),
    debug: readFlag(record?.['debug']),
    tree: readTreeBounds(record),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Hook plumbing
 * ---------------------------------------------------------------------------
 */

/**
 * Whether one hook is armed right now.
 *
 * The sibling's own predicate is the source of truth rather than a copy of the
 * last configuration: `attachPerf()` legitimately declines in a host with no
 * `PerformanceObserver`, and a record of what was *asked for* would then
 * report a signal the capture does not have.
 */
function isHookAttached(name: HookName): boolean {
  try {
    return HOOK_BINDINGS[name].isAttached() === true;
  } catch {
    return false;
  }
}

/**
 * Arm one hook and report whether it took.
 *
 * Every sibling's `attach` is idempotent and documented not to throw; the
 * guard is here because this module runs in a page that can redefine the host
 * objects those functions reach for, and one hook failing must not cost the
 * other five.
 *
 * @returns `true` when the hook is armed afterwards.
 */
function attachHook(name: HookName): boolean {
  try {
    HOOK_BINDINGS[name].attach();
  } catch {
    // Contained: the predicate below reports the failure, and the caller
    // announces it as an unavailable signal.
  }
  return isHookAttached(name);
}

/** Disarm one hook, in its own guard, for the same reason as {@link attachHook}. */
function detachHook(name: HookName): void {
  try {
    HOOK_BINDINGS[name].detach();
  } catch {
    // Contained; the remaining hooks are still detached by the caller's loop.
  }
}

/** The armed hooks, in {@link HOOK_NAMES} order. */
function attachedHookNames(): HookName[] {
  return HOOK_NAMES.filter((name) => isHookAttached(name));
}

/**
 * Why a hook that was asked for might not have attached, per signal.
 *
 * These strings reach the developer: `apps/local-service` turns an unavailable
 * signal into "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled
 * list›." (AAP 0.5.5), so each one names the condition and the way out rather
 * than restating the failure.
 */
const HOOK_UNAVAILABLE_HINTS: Readonly<Record<HookName, string>> = Object.freeze({
  interaction: 'The page has no window to listen on. Reload the tab and start the capture again.',
  fetch:
    'window.fetch and XMLHttpRequest could not be wrapped, usually because another script holds a non-configurable copy. Reload the tab before capturing.',
  state: 'React state transitions could not be recorded; they accompany the React hook.',
  react:
    'No React renderer is registered with the DevTools hook in this document, so commits cannot be observed. Reload the page so the agent installs the hook before React initialises.',
  perf: 'This browser refused every PerformanceObserver entry type, so long tasks and resource timing are unavailable.',
  errors: 'Page error listeners could not be registered.',
});

/**
 * Tell the service which requested signals are unavailable.
 *
 * Reported once per capture per hook (see {@link failedHooks}), as an
 * `agent.error` frame rather than as telemetry: a missing signal is a fact
 * about the capture's coverage, and AAP 0.5.5 requires it to be surfaced
 * instead of leaving the analysis to be drawn from evidence nobody said was
 * incomplete.
 *
 * @param failures The hooks that were asked for and did not attach.
 */
function reportUnavailableHooks(failures: readonly HookName[]): void {
  if (failures.length === 0) {
    return;
  }

  postControl('agent.error', {
    code: 'hooks-unavailable',
    message: `the page agent could not enable: ${failures.join(', ')}`,
    sessionId: armedSessionId ?? null,
    captureId: armedCaptureId ?? null,
    unavailable: failures.map((signal) => ({
      signal,
      reason: 'the hook did not attach in this document',
      hint: HOOK_UNAVAILABLE_HINTS[signal],
    })),
    enabled: attachedHookNames(),
  });
}

/*
 * ---------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------
 */

/**
 * Write one line to the page console, only when the service asked for it.
 *
 * This is someone else's page: their console is where they read their own
 * application's output while they debug it, so the agent is silent unless the
 * inbound configuration carries `debug: true`. Nothing here is a substitute
 * for the telemetry itself — a line logged in the page reaches no panel.
 */
function debugLog(message: string, detail?: Record<string, unknown>): void {
  if (!debugEnabled) {
    return;
  }
  try {
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug(`[debuggen:agent] ${message}`, detail ?? {});
    }
  } catch {
    // A page that replaced `console` gets no diagnostics, which is no worse
    // than the default state.
  }
}

/** {@link detectReact}, behind a guard, because it reads a page global. */
function reactIsRegistered(): boolean {
  try {
    return detectReact();
  } catch {
    return false;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Readiness
 * ---------------------------------------------------------------------------
 */

/**
 * Post an `agent.ready` frame describing this document.
 *
 * Posted unconditionally, including when the bridge has not announced itself:
 * `./transport.js` sends a control frame straight to the window regardless of
 * its buffering state, and a frame posted before the bridge's listener existed
 * is simply lost — which is what `bridge.ready` re-announcement covers.
 *
 * **No `tabId`.** A page has no notion of a tab; the service worker relays
 * this frame under the tab's own connection and adds it (AAP 0.4.2). Inventing
 * one here would give the service two answers for the same field.
 *
 * `url` is raw and unredacted, because the service redacts URL query values at
 * ingest and needs the original to do it — and to map the URL onto a route in
 * the code graph (AAP 0.5.2).
 */
function announceReady(): void {
  try {
    const reactDetected = reactIsRegistered();
    announcedReactDetected = reactDetected;

    postControl('agent.ready', {
      documentId: getDocumentId(),
      producerId: getProducerId(),
      url: readLocationHref(),
      installedBeforeReact,
      reactDetected,
      agentVersion: AGENT_VERSION,
      readyState: initialReadyState,
    });

    debugLog('announced agent.ready', { installedBeforeReact, reactDetected });
  } catch {
    // The service worker learns this document's state from the next
    // announcement; an unsent frame is never worth an exception in the page.
  }
}

/**
 * Re-announce once React has appeared, and only then.
 *
 * `reactDetected` is a claim the service acts on, so a first answer of `false`
 * taken at `document_start` must not be left standing for a React application
 * that simply had not loaded yet. Cheap enough to call on every inbound frame:
 * one `Object.hasOwn` and one `Map.size` read.
 */
function announceReactIfNewlyDetected(): void {
  if (announcedReactDetected) {
    return;
  }
  if (!reactIsRegistered()) {
    return;
  }
  announceReady();
}

/**
 * Schedule the single React re-check.
 *
 * One timer, never an interval, and never a second one: polling the page for a
 * renderer is work the agent has no right to schedule, and every inbound frame
 * re-checks anyway.
 */
function scheduleReactRecheck(): void {
  if (reactRecheckTimer !== undefined || announcedReactDetected) {
    return;
  }
  try {
    reactRecheckTimer = setTimeout(() => {
      reactRecheckTimer = undefined;
      announceReactIfNewlyDetected();
    }, REACT_RECHECK_DELAY_MS);
  } catch {
    reactRecheckTimer = undefined;
  }
}

/** Cancel the pending React re-check, so a disarmed agent holds no timer. */
function clearReactRecheck(): void {
  const timer = reactRecheckTimer;
  reactRecheckTimer = undefined;
  if (timer === undefined) {
    return;
  }
  try {
    clearTimeout(timer);
  } catch {
    // The handle is dropped either way, and the callback is idempotent.
  }
}

/*
 * ---------------------------------------------------------------------------
 * Bridge subscription and flush hooks
 * ---------------------------------------------------------------------------
 */

/**
 * Subscribe to the isolated-world bridge, if this module is not subscribed.
 *
 * The subscription is the agent's only inbound channel and belongs to the
 * dormant state: without it an `agent.config` could never arrive and the agent
 * could never be armed.
 */
function subscribeToBridge(): void {
  if (unsubscribeBridge !== undefined) {
    return;
  }
  try {
    unsubscribeBridge = subscribe(handleInbound);
  } catch {
    unsubscribeBridge = undefined;
  }
}

/**
 * Re-establish the inbound channel after a transport reset.
 *
 * `resetTransport()` clears the transport's subscriber set and removes its
 * `message` listener, which is exactly the "hold nothing" state a disarm asks
 * for — and would also leave the agent deaf to the next `agent.config`. The
 * stale unsubscribe is dropped and the dormant channel is re-made, so a second
 * capture on the same document is possible; the transport marks the bridge
 * present again on the first frame it accepts.
 */
function resubscribeToBridge(): void {
  unsubscribeBridge = undefined;
  subscribeToBridge();
}

/**
 * Register the two flush hooks.
 *
 * `pagehide` is the last moment a document can hand anything to the bridge,
 * and `visibilitychange` covers the tab the developer switches away from and
 * never returns to. Both belong to the document rather than to a capture, so
 * they are registered once and outlive every arm and disarm; {@link flush} is
 * a no-op while nothing is buffered, so a dormant agent pays nothing for them.
 *
 * **Not `beforeunload`.** It blocks navigation, disqualifies the page from the
 * back/forward cache, and is precisely the kind of side effect an
 * instrumentation tool must not add to someone else's application.
 */
function installFlushHooks(): void {
  try {
    if (typeof window !== 'undefined' && pageHideListener === undefined) {
      const listener = (): void => {
        flush();
      };
      window.addEventListener('pagehide', listener);
      pageHideListener = listener;
    }
  } catch {
    pageHideListener = undefined;
  }

  try {
    if (typeof document !== 'undefined' && visibilityListener === undefined) {
      const listener = (): void => {
        try {
          if (document.visibilityState === 'hidden') {
            flush();
          }
        } catch {
          // A document that refuses to report its visibility simply does not
          // trigger an early flush.
        }
      };
      document.addEventListener('visibilitychange', listener);
      visibilityListener = listener;
    }
  } catch {
    visibilityListener = undefined;
  }
}

/*
 * ---------------------------------------------------------------------------
 * The component-tree snapshot
 *
 * The one event this module produces itself, and the reason it exists: the
 * `componentTree` data source is specified as the structure of the page "at
 * the last commit of the capture" (AAP 0.4.2), and the only moment that
 * structure is still reachable is just before `detachReact()` releases the
 * retained root. A tree reconstructed later from owner chains covers only the
 * components that happened to render.
 * ---------------------------------------------------------------------------
 */

/**
 * The longest serialized tree this module will post: 128 KiB of JSON text.
 *
 * Two ceilings sit above it and both would cost the whole event rather than
 * trimming it: `./transport.ts` refuses a frame larger than 512 KiB, and
 * `../aggregate/renders.ts` refuses serialized text longer than 512 KiB. A
 * quarter of that leaves room for the rest of the batch and is still several
 * times any tree worth reading — `./react.ts` caps a snapshot at 2 000 nodes,
 * which serialises to well under this.
 */
const MAX_SERIALIZED_TREE_CHARS = 128 * 1024;

/**
 * Node bound for the second attempt, when the first serialised too large.
 *
 * Deliberately far below the default: the retry exists to deliver *a* tree
 * rather than the best possible one, and a tree that reaches the panel
 * truncated is worth more than a snapshot event the transport had to drop.
 */
const FALLBACK_TREE_MAX_NODES = 400;

/**
 * Hard ceiling on the node-counting walk.
 *
 * The tree comes from `./react.ts` and is already bounded on both axes, so
 * this cannot be reached in practice. It is here because the walk runs at
 * capture stop inside the developer's page and a bound that cannot be reached
 * costs one comparison per node.
 */
const MAX_TREE_WALK_NODES = 50_000;

/**
 * Count the nodes of a snapshot, iteratively.
 *
 * Iterative rather than recursive because the input is a tree whose depth is
 * bounded by a value the *service* chose: a recursive count would put that
 * number on the page's call stack.
 */
function countTreeNodes(root: ComponentTreeNode): number {
  let count = 0;
  const stack: ComponentTreeNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }

    count += 1;
    if (count >= MAX_TREE_WALK_NODES) {
      break;
    }

    const children = node.children;
    if (!Array.isArray(children)) {
      continue;
    }
    for (const child of children) {
      if (typeof child === 'object' && child !== null) {
        stack.push(child);
      }
    }
  }

  return count;
}

/** `JSON.stringify`, behind a guard, returning `undefined` on any refusal. */
function serializeTree(tree: ComponentTreeNode): string | undefined {
  try {
    const text = JSON.stringify(tree);
    return typeof text === 'string' && text.length > 0 ? text : undefined;
  } catch {
    // Unreachable for a tree `./react.ts` built — it carries primitives and
    // arrays only — and guarded because this runs at capture stop.
    return undefined;
  }
}

/** A snapshot and its measurements, as {@link takeComponentTree} resolved them. */
interface SerializedTree {
  /** The tree as JSON text, bounded by {@link MAX_SERIALIZED_TREE_CHARS}. */
  text: string;
  /** How many nodes that text carries. */
  nodeCount: number;
  /** Whether a bound below the requested one had to be used. */
  reduced: boolean;
}

/**
 * Take the snapshot and serialise it, retrying smaller if it is too large.
 *
 * @param bounds The bounds the service asked for, if any.
 * @returns The serialized tree, or `undefined` when there is no tree to report
 * or none small enough to post.
 */
function takeComponentTree(bounds: TreeBounds): SerializedTree | undefined {
  const first = snapshotTree(bounds.maxNodes, bounds.maxDepth);
  if (first === undefined) {
    return undefined;
  }

  const firstText = serializeTree(first);
  if (firstText !== undefined && firstText.length <= MAX_SERIALIZED_TREE_CHARS) {
    return { text: firstText, nodeCount: countTreeNodes(first), reduced: false };
  }

  const second = snapshotTree(FALLBACK_TREE_MAX_NODES, bounds.maxDepth);
  if (second === undefined) {
    return undefined;
  }

  const secondText = serializeTree(second);
  if (secondText === undefined || secondText.length > MAX_SERIALIZED_TREE_CHARS) {
    return undefined;
  }

  return { text: secondText, nodeCount: countTreeNodes(second), reduced: true };
}

/**
 * `snapshotComponentTree` with only the bounds that were actually requested.
 *
 * The options object is built key by key because the repository compiles with
 * `exactOptionalPropertyTypes`: passing `{ maxNodes: undefined }` is not the
 * same as passing nothing, and `./react.ts` applies its own default only for
 * an absent key.
 */
function snapshotTree(
  maxNodes: number | undefined,
  maxDepth: number | undefined,
): ComponentTreeNode | undefined {
  const options: { maxNodes?: number; maxDepth?: number } = {};
  if (maxNodes !== undefined) {
    options.maxNodes = maxNodes;
  }
  if (maxDepth !== undefined) {
    options.maxDepth = maxDepth;
  }

  try {
    return snapshotComponentTree(options);
  } catch {
    return undefined;
  }
}

/**
 * Emit the component-tree snapshot as one `log` event.
 *
 * Called while the transport still carries the capture that is ending —
 * `emit()` drops everything outside a capture — and before `detachReact()`,
 * which is what makes the tree the *last* committed structure rather than a
 * reconstruction.
 *
 * **The tree travels as JSON text, and that is not incidental.**
 * `./transport.ts` rebuilds every attribute bag into clone-safe values and
 * replaces any container nested deeper than two levels with a type tag, so a
 * component tree posted as a nested object would arrive with its
 * grandchildren's children erased. Text is immune to that walk, stays within
 * one attribute, and is exactly what `../aggregate/renders.ts` accepts for
 * this reason ("the structure itself, and the structure as JSON text").
 *
 * The event is attributed like any other: {@link resolveEventContext} decides
 * which trace it joins, so a snapshot taken while an interaction is still open
 * hangs under that interaction rather than starting a root of its own, and the
 * lineage attributes that attribution contributed are merged into the bag.
 */
function emitComponentTreeSnapshot(bounds: TreeBounds): void {
  try {
    const snapshot = takeComponentTree(bounds);
    if (snapshot === undefined) {
      debugLog('no component tree was available to snapshot');
      return;
    }

    const at = nowEpochMs();
    const context = resolveEventContext(at);
    const attributes: Record<string, unknown> = {
      ...context.attributes,
      'log.level': 'info',
      'log.message': 'component tree at capture stop',
      'logger.name': 'debuggen.agent',
      tree: snapshot.text,
      nodeCount: snapshot.nodeCount,
      truncated: snapshot.reduced,
    };

    const draft: EventDraft = {
      traceId: context.traceId,
      spanId: newSpanId(),
      kind: 'log',
      name: COMPONENT_TREE_EVENT_NAME,
      startTime: at,
      duration: 0,
      attributes,
      status: 'ok',
    };

    // Assigned only when the attribution resolved one: an absent key and a key
    // set to `undefined` are different things under
    // `exactOptionalPropertyTypes`, and a synthetic root has no parent.
    if (context.parentSpanId !== undefined) {
      draft.parentSpanId = context.parentSpanId;
    }

    emit(draft);
    debugLog('emitted component tree', {
      nodeCount: snapshot.nodeCount,
      reduced: snapshot.reduced,
    });
  } catch {
    // A capture must still stop cleanly when its final event cannot be built.
  }
}

/*
 * ---------------------------------------------------------------------------
 * Arming and disarming
 * ---------------------------------------------------------------------------
 */

/**
 * Bring the agent to the state one configuration describes.
 *
 * The five steps of AAP 0.5.1's arming contract, in an order that is itself
 * the contract:
 *
 * 1. **Transport identity first.** A hook can fire during the very attach that
 *    registers it — React commits on its own schedule, a buffered
 *    `PerformanceObserver` flushes as soon as it is started — so the transport
 *    must already know the session and capture. A changed `captureId` also
 *    restarts the sequence there, which is why nothing may be emitted before
 *    this call.
 * 2. **The span helper.** Armed before the producers, so a patched application
 *    function that runs mid-attach is recorded rather than passed through.
 * 3. **Per-capture counters, only for a new capture.** `renderCount`,
 *    `render_count` and the state-transition budget are scoped to the capture,
 *    and the service worker re-sends the live configuration after every
 *    reconnect and after every same-origin navigation. Resetting on a re-send
 *    would zero a running capture's counts halfway through the interaction the
 *    developer is reproducing.
 * 4. **Hooks, detached before attached, each in its own guard.** Detaching
 *    first releases what is no longer wanted before anything new starts
 *    observing; attaching in {@link HOOK_NAMES} order means interaction
 *    context exists before the producers that ask for it.
 * 5. **Unavailable signals are announced.** A hook that would not attach is
 *    reported as an `agent.error` frame, once per capture, so the service can
 *    say which evidence the capture does not have (AAP 0.5.5) instead of the
 *    analysis being drawn from a silently narrower set.
 *
 * Idempotent by construction: every decision is taken against the siblings'
 * own `is…Attached()` predicates and against {@link armedCaptureId}, never
 * against a diff of the raw payload, so the same configuration applied twice
 * changes nothing and a subset detaches exactly the hooks it dropped.
 */
function arm(config: ParsedAgentConfig): void {
  const captureChanged = config.captureId !== armedCaptureId;

  armedSessionId = config.sessionId;
  armedCaptureId = config.captureId;
  treeBounds = config.tree;

  configureTransport({
    sessionId: config.sessionId,
    captureId: config.captureId,
    enabled: true,
  });

  setSpanHelperEnabled(true);

  if (captureChanged) {
    failedHooks.clear();
    resetReactCounters();
    resetStateCounters();
    resetContinuations();
  }

  for (const name of reversedHookNames()) {
    if (!config.hooks[name] && isHookAttached(name)) {
      detachHook(name);
    }
  }

  const failures: HookName[] = [];
  for (const name of HOOK_NAMES) {
    if (!config.hooks[name] || isHookAttached(name) || failedHooks.has(name)) {
      continue;
    }
    if (!attachHook(name)) {
      failedHooks.add(name);
      failures.push(name);
    }
  }

  reportUnavailableHooks(failures);

  debugLog('armed', {
    sessionId: config.sessionId ?? null,
    captureId: config.captureId ?? null,
    attached: attachedHookNames(),
    unavailable: failures,
  });
}

/**
 * Return the agent to the dormant state it had before any capture.
 *
 * The order is AAP 0.5.1's cleanup sequence and each step depends on the one
 * before it:
 *
 * 1. **The component-tree snapshot, while React is still attached** and the
 *    transport still carries the ending capture — after either, the structure
 *    is gone and the event would be dropped.
 * 2. **A flush**, so what the capture already recorded leaves before the
 *    transport stops accepting anything.
 * 3. **Detach in reverse attach order**, so interaction context outlives the
 *    producers that resolve against it and nothing resolves a trace from a
 *    half-released window.
 * 4. **Reset the shared state and the transport.** `resetTransport()` also
 *    drops this module's subscription, so the inbound channel is immediately
 *    re-made (see {@link resubscribeToBridge}).
 * 5. **Leave the span helper installed.** Disabled, not removed: patched code
 *    may still be loaded in the page, and AAP 0.5.1 requires the helper to
 *    remain an inert pass-through. Only `uninstallSpanHelper()` removes it,
 *    and nothing in this lifecycle calls it.
 *
 * Afterwards this agent holds no observer, no patch, no bippy subscription, no
 * timer and no buffered event; `window.fetch` is the page's own function
 * again. What remains is exactly the dormant state of the opening sequence —
 * the installed hook, the inert helper, the bridge subscription and the two
 * flush listeners — none of which observes the developer's application.
 */
function disarm(): void {
  const wasArmed = armedCaptureId !== undefined;
  const reactWasAttached = isHookAttached('react');

  if (reactWasAttached) {
    emitComponentTreeSnapshot(treeBounds);
  }

  try {
    flush();
  } catch {
    // The queue survives a failed flush; the reset below discards it, which is
    // the honest outcome for events the bridge never took.
  }

  for (const name of reversedHookNames()) {
    if (isHookAttached(name)) {
      detachHook(name);
    }
  }

  resetContinuations();
  resetSpanStack();
  setSpanHelperEnabled(false);
  configureTransport({ enabled: false });
  resetTransport();
  resubscribeToBridge();

  failedHooks.clear();
  armedSessionId = undefined;
  armedCaptureId = undefined;
  treeBounds = { maxNodes: undefined, maxDepth: undefined };

  // A pending re-check would be a timer held by a dormant agent, so it is
  // cancelled — and the check it would have performed is done here instead,
  // which is cheaper and immediate.
  clearReactRecheck();
  announceReactIfNewlyDetected();

  if (wasArmed) {
    debugLog('disarmed');
  }
}

/** {@link HOOK_NAMES} in detach order. A fresh array; the constant is frozen. */
function reversedHookNames(): HookName[] {
  return [...HOOK_NAMES].reverse();
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Apply an `agent.config` payload.
 *
 * The single entry point for arming and disarming, reached from the bridge in
 * production and called directly by tests. Safe to receive at any time,
 * including immediately after install with a capture already in progress,
 * which is what happens after a same-origin navigation:
 * `apps/chrome-extension/src/background/agent-control.ts` re-sends the live
 * configuration so the same `captureId` continues across the reload.
 *
 * Disarms — rather than arming nothing — when the payload names no capture or
 * enables no hook, because both spellings mean the same thing: the service
 * wants this page to stop observing (AAP 0.5.1).
 *
 * Never throws. A malformed payload disarms, and a failure inside one step
 * cannot prevent the others.
 *
 * @param payload The frame's payload, verbatim and untrusted.
 */
export function applyConfig(payload: unknown): void {
  try {
    if (!installed) {
      // Another evaluation of this bundle owns this document (see the
      // double-install guard in {@link bootstrap}). Two instances driving one
      // page would double every event and leave half the hooks unreleasable.
      return;
    }

    const config = parseConfig(payload);
    debugEnabled = config.debug;

    // Published for diagnostics only — `window.__DEBUGGEN__.config` is what a
    // developer inspects in the console and what the panel reads through
    // `chrome.devtools.inspectedWindow.eval`. Done for both paths, so the
    // helper always shows what the page was last told.
    setSpanHelperConfig(payload);

    announceReactIfNewlyDetected();

    if (config.captureId === undefined || config.enabled.length === 0) {
      disarm();
      return;
    }

    arm(config);
  } catch {
    // The agent runs inside the page's own message dispatch: an exception here
    // would surface in the developer's application, not in this product.
  }
}

/**
 * A snapshot of the agent's lifecycle state.
 *
 * For tests and for diagnostics; nothing in the product's runtime depends on
 * it. `installed` is false in a second evaluation of the bundle that stood
 * down, `armed` reflects a live capture even when every hook it asked for
 * turned out to be unavailable (the span helper and the transport are still
 * armed, so patched function spans still flow), and `hooks` is read from the
 * siblings' own predicates rather than from a record of what was requested.
 */
export function getAgentState(): {
  installed: boolean;
  armed: boolean;
  hooks: Record<string, boolean>;
  installedBeforeReact: boolean;
} {
  return {
    installed,
    armed: armedCaptureId !== undefined,
    hooks: hookRecord((name) => isHookAttached(name)),
    installedBeforeReact,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Inbound frames
 * ---------------------------------------------------------------------------
 */

/**
 * Handle one frame from the isolated-world bridge.
 *
 * Unknown types are ignored in silence, which is the compatible behaviour: the
 * bridge and the service worker ship inside an extension that updates
 * independently of the page's loaded bundle, so an agent will see frame types
 * it was written before.
 *
 * @param message A frame `./transport.js`'s guard has already accepted.
 */
function handleInbound(message: BridgeInboundMessage): void {
  try {
    switch (message.type) {
      case 'bridge.ready':
        // The bridge may have started after this agent announced itself, so
        // the announcement is repeated and anything buffered while it was away
        // is posted. `./transport.js` has already marked the bridge present.
        announceReady();
        flush();
        return;

      case 'bridge.gone':
        // `./transport.js` tracks the absence and stops flushing; there is
        // nothing for the lifecycle to do. The hooks stay attached on purpose:
        // the capture is still running, the service worker reconnects, and
        // events buffer until it does (AAP 0.5.5).
        debugLog('bridge went away; buffering');
        return;

      case 'agent.config':
        applyConfig(message.payload);
        return;

      case 'agent.snapshot':
        // An optional inbound the bridge may never send: the panel asking for
        // the component tree mid-capture. Bounds may accompany the request.
        emitComponentTreeSnapshot(readTreeBounds(message.payload));
        return;

      case 'target.request':
        describeCurrentTarget(message.payload);
        return;

      default:
        return;
    }
  } catch {
    // A frame can never break the page's `message` dispatch, and
    // `./transport.js` calls every subscriber inside its own guard as well.
  }
}

/**
 * Answer a `target.request` with a descriptor of the focused element.
 *
 * The panel's primary path does not come through here — the DevTools page
 * evaluates `window.__DEBUGGEN__.describeTarget($0)` directly, which is why
 * the helper publishes that function — so this is the fallback for a request
 * relayed through the bridge, and `document.activeElement` is the only
 * "current target" a page can answer with.
 *
 * `target` is `null` rather than absent when nothing describable is focused: a
 * relay that gets no answer at all cannot tell a refusal from a lost frame.
 * The `requestId` the bridge sent, if any, is echoed so a relay can match the
 * reply to its request.
 */
function describeCurrentTarget(payload: Record<string, unknown>): void {
  try {
    const element = typeof document === 'undefined' ? undefined : document.activeElement;
    const descriptor = element === null ? undefined : describeTargetForPanel(element);
    const requestId = readString(payload['requestId']);

    postControl('target.described', {
      target: descriptor ?? null,
      ...(requestId === undefined ? {} : { requestId }),
    });
  } catch {
    // A page that refuses to report its focused element gets no descriptor;
    // the panel's own `$0` path is unaffected.
  }
}

/**
 * Describe an element for the panel: the five-field descriptor and nothing
 * else.
 *
 * Published on the span helper as `describeTarget`, so it is reached through
 * `chrome.devtools.inspectedWindow.eval`, which can transport only
 * JSON-compliant values. Owner hints are deliberately **off**: the result is
 * forwarded verbatim as the `target.selected` payload's target, whose schema
 * admits exactly `selector`, `tagName`, optional `text`, `componentChain` and
 * `url`, so an extra key would be a validation failure at the service rather
 * than extra information.
 *
 * @param element Whatever the caller had — `$0` is routinely `null`, a text
 * node, or an object from another realm.
 * @returns The descriptor, or `undefined` when the input is not an element.
 */
function describeTargetForPanel(element: unknown): unknown {
  try {
    return describeElement(element);
  } catch {
    return undefined;
  }
}

/*
 * ---------------------------------------------------------------------------
 * The opening sequence
 *
 * Steps 0 to 5 of this module's documentation, each in its own guard so that a
 * failure in one cannot prevent the others: a page that loads this script must
 * behave exactly as it would without it, and a half-installed agent that still
 * announces itself is more useful than none at all.
 * ---------------------------------------------------------------------------
 */

/**
 * Install the agent: claim the document, read the React state, publish the
 * span helper, open the inbound channel, announce, and stop.
 *
 * Runs on import (see the call at the end of this file) because esbuild
 * bundles this module as the IIFE entry point and the manifest declares the
 * result as a content script — there is no other moment at which anything
 * could call it.
 */
function bootstrap(): void {
  // Step 0 — stand down if another evaluation of this bundle already owns this
  // document. Chrome can inject a content script twice (an extension reload
  // against an open tab, a second frame of the same document), and two
  // instances driving one page would double every event and leave each one
  // holding patches the other could not restore. The existing instance is left
  // entirely undisturbed.
  try {
    if (isAgentInstalledInDocument()) {
      return;
    }
    markAgentInstalledInDocument();
  } catch {
    // An unreadable or unwritable global cannot stop the install: the sibling
    // modules' attach functions are idempotent, so the worst case is a second
    // instance that observes nothing until it is armed.
  }

  // Step 1 — record what React's state was. The hook itself is already
  // installed: the side-effect import at the top of this file ran before this
  // function, which is the whole reason the import is written that way. A hook
  // installation registers no renderer, so the count read here is the count
  // that existed before the import — and `readyState` is unaffected by it.
  try {
    initialReadyState = readDocumentReadyState();
    installedBeforeReact = registeredRendererCount() === 0 && initialReadyState === 'loading';
  } catch {
    installedBeforeReact = false;
  }

  // Step 2 — publish `globalThis.__DEBUGGEN__`, disabled. It must exist this
  // early because a function patched by
  // `packages/instrumentation/src/patch/function-timing.ts` can run at any
  // moment and its wrapper's availability check must find a helper; leaving it
  // disabled is what keeps a dormant agent free of cost, since `span` is then
  // exactly `return fn()`.
  try {
    installSpanHelper({ describeTarget: describeTargetForPanel });
    setSpanHelperEnabled(false);
  } catch {
    // A page that froze `globalThis` keeps its own state; patched code then
    // runs uninstrumented, which is the template's documented fallback.
  }

  // From here the instance owns the document, so a configuration that arrives
  // during the remaining steps is honoured rather than dropped.
  installed = true;

  // Step 3 — open the inbound channel, then announce. In that order: a
  // `bridge.ready` posted between the two would otherwise be missed, and an
  // announcement is worth making even when the bridge has not started yet,
  // because the bridge's own arrival re-triggers it.
  try {
    subscribeToBridge();
  } catch {
    // Without a subscription the agent is deaf and its announcement says so by
    // never being answered; nothing else is affected.
  }

  try {
    announceReady();
  } catch {
    // The next `bridge.ready` re-announces.
  }

  // Step 4 — the flush hooks, so a navigation does not take a capture's tail
  // with it.
  try {
    installFlushHooks();
  } catch {
    // A capture then loses only the events queued in its final flush window.
  }

  // React may initialise a beat after this: one re-check, no interval.
  try {
    scheduleReactRecheck();
  } catch {
    // Every inbound frame re-checks as well, so a host without timers still
    // corrects the claim as soon as the service says anything.
  }

  // Step 5 — dormant. No listener on the developer's application, no observer,
  // no patch, no bippy subscription and no buffered event until an
  // `agent.config` arms one.
  debugLog('installed', { installedBeforeReact, readyState: initialReadyState });
}

/*
 * The bundle's single import-time side effect, and the reason this module is
 * the only file in this folder that has one: `esbuild.agent.mjs` makes this
 * file the IIFE's entry point, so the call below *is* the content script.
 */
bootstrap();
