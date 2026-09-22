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
 * `globalThis.__DEBUGGEN__` (step 2), preceded by arming the document-scoped
 * families it publishes — element description, which the panel uses to pick a
 * target long before a capture exists — because a function patched by
 * `packages/instrumentation/src/patch/function-timing.ts` can execute at any
 * moment and its wrapper's `if (__dbg && typeof __dbg.span === "function")`
 * check must find a helper. Both happen while the agent is **dormant**: no
 * listener, no observer, no patch and no subscription on the developer's
 * application exists until the service arms one.
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
 * Arming and disarming walk **one registry of eight producer families** — one
 * per sibling module in this folder that observes anything — rather than a
 * hand-kept list of calls, because a family reachable only from a remembered
 * call is a family whose release depends on that memory. Each entry declares
 * whether it belongs to a capture or to the document, and which of the seven
 * wire flags ask for it; see {@link HOOK_NAMES} and {@link HOOK_FLAGS}, which
 * are deliberately two separate lists because the `componentTree` flag arms no
 * observer at all.
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

import {
  COMPONENT_TREE_ATTRIBUTE_KEYS,
  COMPONENT_TREE_EVENT_NAME,
  MAX_COMPONENT_TREE_JSON_CHARS,
} from '../schema/attributes.js';
import {
  attachContinuations,
  detachContinuations,
  isContinuationsAttached,
  resetContinuations,
} from './continuation.js';
import {
  attachDomTarget,
  describeElement,
  detachDomTarget,
  isDomTargetAttached,
} from './dom-target.js';
import { attachErrors, detachErrors, hasErrorsResidue, isErrorsAttached } from './errors.js';
import {
  advanceFetchGeneration,
  attachFetch,
  detachFetch,
  hasFetchResidue,
  isFetchAttached,
} from './fetch.js';
import { getDocumentId, getProducerId, newSpanId } from './ids.js';
import {
  attachInteractions,
  detachInteractions,
  hasInteractionsResidue,
  isInteractionsAttached,
  resolveEventContext,
} from './interaction.js';
import { attachPerf, detachPerf, hasPerfResidue, isPerfAttached } from './perf.js';
import {
  attachReact,
  detachReact,
  detectReact,
  hasReactResidue,
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
  boundControlText,
  configureTransport,
  emit,
  flush,
  nowEpochMs,
  postControl,
  reportProducerFailure,
  resetTransport,
  subscribe,
} from './transport.js';
import type { BridgeInboundMessage, EventDraft, ProducerFailureSource } from './transport.js';

/*
 * ---------------------------------------------------------------------------
 * Published constants
 * ---------------------------------------------------------------------------
 */

/**
 * The build version of this bundle.
 *
 * It matters because the agent is a *static* content script: a page loaded
 * before the extension was updated keeps running the bundle it was loaded
 * with, so the service worker can be talking to an older agent than the one on
 * disk. Bumped whenever the frames this file posts, or the configuration it
 * understands, change in a way a reader could notice.
 *
 * **Deliberately not on the wire.** `agent.ready`'s payload is the exact five
 * fields AAP 0.4.2 specifies (see {@link announceReady}), so this version is
 * reported only in the page-console diagnostics the service can ask for. The
 * version negotiation it would enable belongs to the shared message schema,
 * which has to carry the field before a producer may send it. Until then this
 * constant is what a reader of a `debug: true` session correlates a bundle
 * against, and the alias list in {@link HOOK_ALIASES} is what keeps an older
 * service compatible without one.
 */
export const AGENT_VERSION = 1;

/**
 * The seven flags an `agent.config` may carry, in the order the service
 * declares them.
 *
 * These names are the **wire vocabulary**, and they are exactly the seven keys
 * of `AgentHookConfig` — `packages/instrumentation/src/schema/readiness.ts`'s
 * `AGENT_HOOK_KEYS`, the single canonical definition (AAP 0.4.2, 0.9.1). That
 * file cannot be imported here (see {@link HOOK_ALIASES}), so the parity is
 * kept by using its names verbatim rather than a spelling of this file's own.
 *
 * Six of them arm an observer; `componentTree` does not, and that asymmetry is
 * why the vocabulary and the lifecycle registry are two separate lists rather
 * than one (see {@link HOOK_NAMES}). A tree is one bounded piece of work taken
 * at the capture's last commit, so the flag is an *authorisation* the agent
 * stores and honours at that moment (see {@link maybeEmitComponentTreeSnapshot})
 * — a capture that wants render counts without a tree must not pay for one.
 */
const HOOK_FLAGS = Object.freeze([
  'interactions',
  'react',
  'state',
  'fetch',
  'perf',
  'errors',
  'componentTree',
] as const);

/** One member of the closed wire vocabulary of {@link HOOK_FLAGS}. */
export type HookFlag = (typeof HOOK_FLAGS)[number];

/**
 * Every configuration key accepted for each flag, canonical name first.
 *
 * **The canonical names are `AgentHookConfig`'s**, defined once in
 * `packages/instrumentation/src/schema/readiness.ts` and embedded by
 * `@debuggen/protocol` in `agent.config` (AAP 0.4.2). Neither file may be
 * imported here — the agent emits raw event batches and the service worker
 * wraps them in protocol envelopes, so protocol stays out of the page
 * (AAP 0.2.3) — which means a naming difference between the two sides fails
 * nowhere: the hook is simply never attached, the developer reproduces their
 * problem exactly as asked, and the capture comes back missing the evidence.
 *
 * The aliases are therefore a compatibility list, not a guess: each entry is a
 * spelling a service built against an earlier revision of this file may send
 * (`interaction`, `renders`, `network`, `performance`, `error`), so an
 * older service still arms the right signal. Anything unrecognised is ignored
 * rather than guessed at.
 *
 * Exported so the alignment with `AGENT_HOOK_KEYS` can be asserted from
 * outside this bundle rather than rediscovered by reading it.
 */
export const HOOK_ALIASES: Readonly<Record<HookFlag, readonly string[]>> = Object.freeze({
  interactions: Object.freeze(['interactions', 'interaction']),
  react: Object.freeze(['react', 'reactRenders', 'renders']),
  state: Object.freeze(['state', 'stateTransitions']),
  fetch: Object.freeze(['fetch', 'network', 'fetchTracking']),
  perf: Object.freeze(['perf', 'performance', 'perfTracking']),
  errors: Object.freeze(['errors', 'error']),
  // Not `tree`: the configuration's top level may carry a `tree` object of
  // snapshot bounds (see `readTreeBounds`), and one word meaning two things on
  // one frame is how a reader comes to believe a bounds object armed a signal.
  componentTree: Object.freeze(['componentTree', 'componentTreeSnapshot', 'componentTreeTracking']),
});

/**
 * The eight producer families this module holds a lifecycle for, in **attach
 * order** — one per sibling module in this folder that observes something.
 *
 * The list is the agent's cleanup contract made mechanical: AAP 0.5.1 requires
 * an `agent.config` with every hook false to leave the agent *disabled rather
 * than idled*, and the only way to be sure of that is for every family to be
 * reachable from one ordered walk. A family kept outside the registry is a
 * family whose release depends on someone remembering to call it — which is
 * how `continuation` came to be reset ad hoc and `dom-target` came to have no
 * release at all.
 *
 * The order is the contract, not a listing convenience:
 *
 * 1. `domTarget` — the document-scoped capability the span helper publishes as
 *    `describeTarget`, so it is armed before the helper exists.
 * 2. `continuation` — the lineage registry every other producer's attribution
 *    is resolved against, so it holds its empty state before anything can ask.
 * 3. `interactions` — mints the trace root and the window
 *    {@link resolveEventContext} answers from.
 * 4. `fetch` — the network patch, so a request started inside the first
 *    interaction is already correlated.
 * 5. `state` — `./react.js` hands its transitions to `./state.js` as it walks
 *    a commit, so state is ready before commits are observed.
 * 6. `react` — the fiber-hook subscription.
 * 7. `perf`, 8. `errors` — observers and listeners that depend on none of the
 *    above.
 *
 * Detach runs the list in reverse, so context outlives the producers that use
 * it.
 */
const HOOK_NAMES = Object.freeze([
  'domTarget',
  'continuation',
  'interactions',
  'fetch',
  'state',
  'react',
  'perf',
  'errors',
] as const);

/** One member of the closed family vocabulary of {@link HOOK_NAMES}. */
export type HookName = (typeof HOOK_NAMES)[number];

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
  /** Every flag's desired state; a key is always present. */
  hooks: Readonly<Record<HookFlag, boolean>>;
  /** The flags asked for, in {@link HOOK_FLAGS} order. */
  enabled: readonly HookFlag[];
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

/**
 * How long a family stays armed once it is attached.
 *
 * `capture` families are armed and released by {@link arm} and {@link disarm},
 * so they observe the developer's application only while a capture is running.
 * `document` families belong to the page document instead: they are armed by
 * the opening sequence and released when the document goes away, because the
 * capability they provide is used *outside* a capture — the panel picks an
 * element before the question is even asked (AAP 0.1.1, 0.4.2) — and they
 * observe nothing on their own.
 */
type HookScope = 'capture' | 'document';

/** One family's lifecycle, as the ordered loops below use it. */
interface HookBinding {
  /** See {@link HookScope}. */
  readonly scope: HookScope;
  /**
   * The wire flags that ask for this family; empty for a document-scoped one.
   *
   * A family is armed when *any* of its flags is set, which is what lets one
   * flag arm more than one family and one family serve more than one flag
   * without the arming loop knowing anything about either.
   */
  readonly requestedBy: readonly HookFlag[];
  /** Arm the family. Idempotent and never throws (see each sibling). */
  readonly attach: () => void;
  /** Disarm the family and release everything it held. */
  readonly detach: () => void;
  /** Whether the family is armed right now — the source of truth. */
  readonly isAttached: () => boolean;
  /**
   * Whether the page still carries something this family's last detach could
   * not remove.
   *
   * A second question, and a different one from {@link isAttached}. Every
   * producer in this folder reads "attached" as "observing", so a hook that
   * disarmed its gate and then failed to remove a listener, disconnect an
   * observer or restore a prototype slot answers `false` there while the
   * page still runs its registration. Without this probe the unreleased-hook
   * announcement would conclude, from a predicate answering the other
   * question, that everything came off — which is exactly the state AAP 0.5.1
   * requires to be stated rather than assumed.
   */
  readonly hasResidue: () => boolean;
}

/** `requestedBy` for a family no wire flag names. Shared, so it is frozen. */
const NO_FLAGS: readonly HookFlag[] = Object.freeze([]);

/**
 * The family table, keyed by {@link HookName}.
 *
 * Total by construction: a name added to {@link HOOK_NAMES} without an entry
 * here is a compile error, which is what keeps the attach, detach and
 * reporting loops from silently skipping a family.
 *
 * Two entries repay a second look.
 *
 * - **`domTarget` is document-scoped and no flag names it.** Element
 *   description is what answers `describeTarget`/`target.request`, which the
 *   panel uses while the agent is dormant, so tying it to a capture would
 *   break target selection — the step that happens *before* a plan exists. Its
 *   adapter holds no resource; `./dom-target.js` documents why its own
 *   functions stay callable in both states.
 * - **`continuation` is named by two flags.** The lineage registry is fed by
 *   the request producer and closed by the interaction producer
 *   (`./continuation.js`), so either of those signals is reason enough to arm
 *   it, and neither alone is reason to leave it out. In practice the service
 *   forces `interactions` on whenever anything is on — without it the
 *   `traceparent` header is never injected and browser↔server correlation
 *   breaks silently — so this family is armed for every real capture.
 */
const HOOK_BINDINGS: Readonly<Record<HookName, HookBinding>> = Object.freeze({
  domTarget: {
    scope: 'document',
    requestedBy: NO_FLAGS,
    attach: attachDomTarget,
    detach: detachDomTarget,
    isAttached: isDomTargetAttached,
    // `./dom-target.ts` registers nothing with the page — it is a flag that
    // gates `describeElement` — so it has no residue to leave behind.
    hasResidue: (): boolean => false,
  },
  continuation: {
    scope: 'capture',
    requestedBy: Object.freeze(['interactions', 'fetch'] as const),
    attach: attachContinuations,
    detach: detachContinuations,
    isAttached: isContinuationsAttached,
    // `./continuation.ts` is a registry of maps driven by the producers; it
    // holds no page registration and therefore nothing a detach could fail to
    // release.
    hasResidue: (): boolean => false,
  },
  interactions: {
    scope: 'capture',
    requestedBy: Object.freeze(['interactions'] as const),
    attach: attachInteractions,
    detach: detachInteractions,
    isAttached: isInteractionsAttached,
    hasResidue: hasInteractionsResidue,
  },
  fetch: {
    scope: 'capture',
    requestedBy: Object.freeze(['fetch'] as const),
    attach: attachFetch,
    detach: detachFetch,
    isAttached: isFetchAttached,
    hasResidue: hasFetchResidue,
  },
  state: {
    scope: 'capture',
    requestedBy: Object.freeze(['state'] as const),
    attach: attachState,
    detach: detachState,
    isAttached: isStateAttached,
    // `./state.ts` registers nothing with the page — it is a flag and two
    // counters, driven by `./react.ts`'s commit traversal — so it has no
    // residue to leave behind and nothing to probe for.
    hasResidue: (): boolean => false,
  },
  react: {
    scope: 'capture',
    requestedBy: Object.freeze(['react'] as const),
    attach: attachReact,
    detach: detachReact,
    isAttached: isReactAttached,
    hasResidue: hasReactResidue,
  },
  perf: {
    scope: 'capture',
    requestedBy: Object.freeze(['perf'] as const),
    attach: attachPerf,
    detach: detachPerf,
    isAttached: isPerfAttached,
    hasResidue: hasPerfResidue,
  },
  errors: {
    scope: 'capture',
    requestedBy: Object.freeze(['errors'] as const),
    attach: attachErrors,
    detach: detachErrors,
    isAttached: isErrorsAttached,
    hasResidue: hasErrorsResidue,
  },
});

/** The families armed and released with a capture, in attach order. */
const CAPTURE_HOOK_NAMES: readonly HookName[] = Object.freeze(
  HOOK_NAMES.filter((name) => HOOK_BINDINGS[name].scope === 'capture'),
);

/** The families that belong to the document, in attach order. */
const DOCUMENT_HOOK_NAMES: readonly HookName[] = Object.freeze(
  HOOK_NAMES.filter((name) => HOOK_BINDINGS[name].scope === 'document'),
);

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
 * Whether the live configuration authorised a component-tree snapshot.
 *
 * The `componentTree` flag arms no observer, so this is where it lives: the
 * snapshot is one bounded walk of the retained fiber root taken as the capture
 * stops, and {@link maybeEmitComponentTreeSnapshot} is the only thing that may
 * take it. Default `false`, so a capture that did not ask for a tree never
 * pays for one — which is the point of the flag being separate from `react` on
 * the wire (AAP 0.4.2).
 */
let componentTreeRequested = false;

/**
 * Whether this capture has already been told its tree request cannot be met.
 *
 * Reported once per capture, for the reason {@link failedHooks} exists: the
 * service worker re-sends the live configuration after every reconnect and
 * every same-origin navigation, and a request that is impossible in this
 * document — `componentTree` without the React family attached — is impossible
 * every time it is re-sent.
 */
let componentTreeRefusalReported = false;

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
 * Hooks already announced as unreleased, for the current capture.
 *
 * The same idempotence-with-honesty bargain {@link failedHooks} makes, for the
 * opposite failure: a hook that refuses to detach refuses every time it is
 * asked, so a re-sent configuration, a second {@link disarm} or a detach
 * attempted from both paths would otherwise post the identical `agent.error`
 * frame again and again for one unchanged fact.
 *
 * Cleared when the capture changes rather than on disarm — which is what makes
 * "once per capture" true across the disarm that ends the capture and any
 * repeat of it — so the next capture on this document announces afresh.
 */
const reportedUnreleasedHooks = new Set<HookName>();

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

/**
 * The `pageshow` listener, which re-arms the document-scoped families.
 *
 * Its counterpart is the `pagehide` listener above: a document put into the
 * back/forward cache releases them and a restored one gets them back, so
 * {@link isDomTargetAttached} always describes the document the panel is
 * actually looking at.
 */
let pageShowListener: (() => void) | undefined;

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
 * Build a total {@link HookFlag} record from a per-flag predicate.
 *
 * Total by construction: {@link HOOK_FLAGS} is the key domain of
 * `Record<HookFlag, boolean>` and the loop visits every member, so the partial
 * is fully populated before the assertion reads it. Writing the seven keys out
 * by hand instead would let a flag added to the vocabulary be silently missing
 * from a record built this way.
 */
function flagRecord(predicate: (flag: HookFlag) => boolean): Record<HookFlag, boolean> {
  const state: Partial<Record<HookFlag, boolean>> = {};
  for (const flag of HOOK_FLAGS) {
    state[flag] = predicate(flag);
  }
  return state as Record<HookFlag, boolean>;
}

/**
 * Build a total {@link HookName} record from a per-family predicate.
 *
 * The family counterpart of {@link flagRecord}, and total for the same reason.
 * Used for the state snapshot {@link getAgentState} publishes, which reports
 * all eight families rather than only the ones a capture happened to ask for.
 */
function familyRecord(predicate: (name: HookName) => boolean): Record<HookName, boolean> {
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

  const hooks = flagRecord((flag) =>
    hooksRecord === undefined
      ? false
      : HOOK_ALIASES[flag].some((alias) => readFlag(hooksRecord[alias])),
  );

  return {
    sessionId: readString(config.sessionId),
    captureId: readString(config.captureId),
    hooks,
    enabled: HOOK_FLAGS.filter((flag) => hooks[flag]),
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
 * Whether one family is armed right now.
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
 * Whether a configuration asks for one family.
 *
 * Document-scoped families answer `false` whatever the configuration says:
 * their lifecycle belongs to the document (see {@link HookScope}), so a
 * capture can neither arm nor release them, and a flag that happened to share
 * a name with one must not.
 */
function isHookRequested(name: HookName, hooks: Readonly<Record<HookFlag, boolean>>): boolean {
  const binding = HOOK_BINDINGS[name];
  return binding.scope === 'capture' && binding.requestedBy.some((flag) => hooks[flag]);
}

/**
/**
 * Whether one hook left something of itself in the page.
 *
 * The companion to {@link isHookAttached}, and the reason both exist: a
 * producer's `is…Attached()` answers "am I observing", which a hook that
 * disarmed its gate answers `false` even when the page still runs the listener
 * it could not remove, still holds the observer it could not disconnect or
 * still carries the prototype patch it could not restore. That residue is what
 * AAP 0.5.1 forbids leaving unstated, so it is asked for separately and
 * announced separately (see {@link reportUnreleasedHooks}).
 *
 * Guarded like its companion: a producer whose probe throws is treated as
 * having nothing outstanding, because the alternative — announcing residue on
 * the strength of a failed read — would report the same hook on every disarm
 * for the life of the document.
 */
function hookHasResidue(name: HookName): boolean {
  try {
    return HOOK_BINDINGS[name].hasResidue() === true;
  } catch {
    return false;
  }
}

/**
 * Arm one family and report whether it took.
 *
 * Every sibling's `attach` is idempotent and documented not to throw; the
 * guard is here because this module runs in a page that can redefine the host
 * objects those functions reach for, and one family failing must not cost the
 * other seven.
 *
 * @returns `true` when the family is armed afterwards.
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

/**
 * The transport source one family's detach failure is reported under.
 *
 * `./transport.ts`'s `ProducerFailureSource` names the producer *modules*, and
 * a family name is not always a module name: the `interactions` family is
 * produced by `./interaction.ts`, which reports itself as `'interaction'`, and
 * the two families that hold no host resource — `domTarget` and
 * `continuation` are a flag and a registry of maps — have no producer source
 * and nothing a detach could fail to release, so they carry `undefined`.
 *
 * Total over {@link HookName} on purpose: a family added to {@link HOOK_NAMES}
 * without an entry here is a compile error rather than a report the service
 * would group under nothing.
 */
const HOOK_FAILURE_SOURCES: Readonly<Record<HookName, ProducerFailureSource | undefined>> =
  Object.freeze({
    domTarget: undefined,
    continuation: undefined,
    interactions: 'interaction',
    fetch: 'fetch',
    state: 'state',
    react: 'react',
    perf: 'perf',
    errors: 'errors',
  });

/**
 * Disarm one family, in its own guard, for the same reason as {@link attachHook}.
 *
 * The failure is **reported as well as contained**. A hook that will not
 * detach is the most expensive failure this agent has — the page keeps a
 * listener, a wrapper or a bippy callback after the developer ended their
 * capture — and until this call it was invisible to everything outside the
 * page. AAP 0.5.5 requires the signal that could not be delivered to be
 * stated, and AAP 0.5.1 requires a cleared hook to be disabled rather than
 * idled, so the failure travels as an `agent.error` frame while the caller's
 * loop still detaches every other family.
 */
function detachHook(name: HookName): void {
  try {
    HOOK_BINDINGS[name].detach();
  } catch (error) {
    // Contained; the remaining families are still detached by the caller's
    // loop, and {@link reportUnreleasedHooks} states whatever is still attached
    // afterwards.
    const source = HOOK_FAILURE_SOURCES[name];
    if (source !== undefined) {
      reportProducerFailure(source, 'detach', error);
    }
  }
}

/** The armed families, in {@link HOOK_NAMES} order. */
function attachedHookNames(): HookName[] {
  return HOOK_NAMES.filter((name) => isHookAttached(name));
}

/**
 * Arm the document-scoped families.
 *
 * Called by the opening sequence — before the span helper is published, since
 * `describeTarget` is exactly what `domTarget` provides — and again from
 * `pageshow`, so a document restored from the back/forward cache regains them.
 * Idempotent, and a family that declines leaves its own predicate false rather
 * than failing the sequence.
 */
function attachDocumentHooks(): void {
  for (const name of DOCUMENT_HOOK_NAMES) {
    attachHook(name);
  }
}

/**
 * Release the document-scoped families.
 *
 * Called from `pagehide`, which is the only teardown a content script has: the
 * document is being discarded or frozen, and a capability that outlived it
 * would describe a page that is no longer there. `pageshow` re-arms them if the
 * document comes back.
 */
function detachDocumentHooks(): void {
  for (const name of [...DOCUMENT_HOOK_NAMES].reverse()) {
    detachHook(name);
  }
}

/**
 * The wire signal each family supplies, or `undefined` for a support family.
 *
 * Six families are named after the flag that arms them, so their name *is* the
 * signal name the service knows them by (`CaptureSignal` in
 * `packages/instrumentation/src/schema/readiness.ts`). `continuation` and
 * `domTarget` supply no signal of their own: the first is the lineage registry
 * behind every other producer's attribution and the second answers the panel's
 * element queries, so neither appears in a capture's signal list and neither
 * may be reported as one — a service that received `continuation` where it
 * expects a capture signal would reject the frame.
 *
 * Total by construction, so a family added to {@link HOOK_NAMES} has to declare
 * which of the two it is.
 */
const HOOK_SIGNALS: Readonly<Record<HookName, HookFlag | undefined>> = Object.freeze({
  domTarget: undefined,
  continuation: undefined,
  interactions: 'interactions',
  fetch: 'fetch',
  state: 'state',
  react: 'react',
  perf: 'perf',
  errors: 'errors',
});

/**
 * Why a family that was asked for might not have attached.
 *
 * These strings reach the developer: `apps/local-service` turns an unavailable
 * signal into "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled
 * list›." (AAP 0.5.5), so each one names the condition and the way out rather
 * than restating the failure.
 */
const HOOK_UNAVAILABLE_HINTS: Readonly<Record<HookName, string>> = Object.freeze({
  domTarget:
    'This document exposes no DOM, so an element cannot be described. Element selection is unavailable for this page.',
  continuation:
    'Async lineage could not be armed, so React work that renders a response may start a trace of its own instead of joining the interaction.',
  interactions: 'The page has no window to listen on. Reload the tab and start the capture again.',
  fetch:
    'window.fetch and XMLHttpRequest could not be wrapped, usually because another script holds a non-configurable copy. Reload the tab before capturing.',
  state: 'React state transitions could not be recorded; they accompany the React hook.',
  react:
    'No React renderer is registered with the DevTools hook in this document, so commits cannot be observed. Reload the page so the agent installs the hook before React initialises.',
  perf: 'This browser refused every PerformanceObserver entry type, so long tasks and resource timing are unavailable.',
  errors: 'Page error listeners could not be registered.',
});

/**
 * Why a `componentTree` request cannot be met without the React family.
 *
 * The snapshot is a walk of the fiber root `./react.js` retains from the
 * commits it observed, so there is nothing to walk when that family is not
 * attached. The service pairs the two flags itself — its
 * `react-render-tracking` action arms `react` and `componentTree` together
 * (AAP 0.4.2) — so this hint describes a configuration that asked for the tree
 * alone.
 */
const COMPONENT_TREE_UNAVAILABLE_HINT =
  'A component tree is taken from the React commits this document produced, so the react hook has to be enabled alongside componentTree.';

/** The reason text for a family that was asked for and did not attach. */
const HOOK_FAILED_REASON = 'the hook did not attach in this document';

/** One signal a capture asked for and cannot have. */
interface UnavailableSignal {
  /** The signal's wire name, as the service's vocabulary spells it. */
  signal: string;
  /** What happened, in one clause. */
  reason: string;
  /** What the developer can do about it. */
  hint: string;
}

/**
 * The signals this document is currently supplying, in {@link HOOK_FLAGS}
 * order.
 *
 * Built from the families' own predicates rather than from the configuration,
 * so the list the service shows after "Continuing with:" is what the capture
 * will actually contain. `componentTree` joins it only when the request can be
 * met, which is the same condition {@link maybeEmitComponentTreeSnapshot}
 * applies.
 */
function enabledSignalNames(): HookFlag[] {
  const attached = new Set<HookFlag>();

  for (const name of HOOK_NAMES) {
    const signal = HOOK_SIGNALS[name];
    if (signal !== undefined && isHookAttached(name)) {
      attached.add(signal);
    }
  }

  if (componentTreeRequested && isHookAttached('react')) {
    attached.add('componentTree');
  }

  return HOOK_FLAGS.filter((flag) => attached.has(flag));
}

/**
 * Tell the service which requested signals are unavailable.
 *
 * Reported as an `agent.error` frame rather than as telemetry: a missing
 * signal is a fact about the capture's *coverage*, and AAP 0.5.5 requires it to
 * be surfaced instead of leaving the analysis to be drawn from evidence nobody
 * said was incomplete. Every `signal` here is a name from the service's own
 * capture-signal vocabulary; see {@link HOOK_SIGNALS}.
 *
 * @param entries The signals that were asked for and cannot be supplied.
 */
function reportUnavailableSignals(entries: readonly UnavailableSignal[]): void {
  if (entries.length === 0) {
    return;
  }

  postControl('agent.error', {
    code: 'hooks-unavailable',
    message: `the page agent could not enable: ${entries.map((entry) => entry.signal).join(', ')}`,
    sessionId: armedSessionId ?? null,
    captureId: armedCaptureId ?? null,
    unavailable: entries.map((entry) => ({ ...entry })),
    enabled: enabledSignalNames(),
  });
}

/**
 * Report a support family that could not be armed.
 *
 * A separate frame with its own code, because these families are not capture
 * signals (see {@link HOOK_SIGNALS}) and must not arrive where the service
 * expects one. It is still reported rather than swallowed: a capture whose
 * lineage registry never armed produces a subtly different trace shape, and
 * that is worth a line in the session log.
 *
 * @param failures The support families that were asked for and did not attach.
 */
function reportUnavailableFamilies(failures: readonly HookName[]): void {
  if (failures.length === 0) {
    return;
  }

  postControl('agent.error', {
    code: 'agent-family-unavailable',
    message: `the page agent could not arm: ${failures.join(', ')}`,
    sessionId: armedSessionId ?? null,
    captureId: armedCaptureId ?? null,
    families: failures.map((family) => ({
      family,
      reason: HOOK_FAILED_REASON,
      hint: HOOK_UNAVAILABLE_HINTS[family],
    })),
    enabled: enabledSignalNames(),
  });
}

/**
 * Report the families that were asked for and did not attach.
 *
 * Reported once per capture per family (see {@link failedHooks}), split by
 * whether the family carries a capture signal so that each half reaches the
 * service under the shape it can read.
 *
 * @param failures The families that were asked for and did not attach.
 */
function reportUnavailableHooks(failures: readonly HookName[]): void {
  const signals: UnavailableSignal[] = [];
  const families: HookName[] = [];

  for (const name of failures) {
    const signal = HOOK_SIGNALS[name];
    if (signal === undefined) {
      families.push(name);
      continue;
    }
    signals.push({ signal, reason: HOOK_FAILED_REASON, hint: HOOK_UNAVAILABLE_HINTS[name] });
  }

  reportUnavailableSignals(signals);
  reportUnavailableFamilies(families);
}

/**
 * Tell the service its component-tree request cannot be met in this document.
 *
 * Once per capture (see {@link componentTreeRefusalReported}). The alternative
 * — staying silent — is what AAP 0.5.5 forbids: the panel would render a
 * `componentTree` node with nothing behind it and the developer would have no
 * way to tell "this page has no such structure" from "nobody collected it".
 */
function reportComponentTreeRefused(): void {
  if (componentTreeRefusalReported) {
    return;
  }
  componentTreeRefusalReported = true;

  reportUnavailableSignals([
    {
      signal: 'componentTree',
      reason: 'the react hook is not attached in this document',
      hint: COMPONENT_TREE_UNAVAILABLE_HINT,
    },
  ]);
}

/**
 * What a hook that would not release is still holding, and how to be rid of it,
 * per signal.
 *
 * The counterpart of {@link HOOK_UNAVAILABLE_HINTS}, and written for the same
 * reader: these strings reach the developer, so each one names what survives
 * in their page and the remedy that is certain to work rather than restating
 * the failure. Every remedy is a fresh document or a fresh process, because
 * nothing the agent can still call is trustworthy at this point — the call
 * that was supposed to release the hook is the one that just failed.
 */
const HOOK_UNRELEASED_HINTS: Readonly<Record<HookName, string>> = Object.freeze({
  domTarget:
    'Element description is a flag on this document and holds no page resource; nothing survives a detach.',
  continuation: 'The async-lineage registry holds no page resource; nothing survives a detach.',
  interactions:
    'Pointer and keyboard listeners are still registered on this page. Reload the tab to remove them.',
  fetch:
    'window.fetch or XMLHttpRequest is still wrapped. Reload the tab to restore the original functions.',
  state:
    'State transitions are still being recorded; they are released with the React hook. Reload the tab.',
  react:
    'The React commit callbacks are still installed, so renders are still being observed. Reload the tab to clear them.',
  perf: 'One or more PerformanceObservers are still registered. Reload the tab to release them.',
  errors:
    'The error and unhandled-rejection listeners are still registered on this page. Reload the tab to remove them.',
});

/**
 * Tell the service which hooks refused to release.
 *
 * The other half of {@link reportUnavailableHooks}, and the more serious one:
 * an unavailable signal is evidence the capture never had, while an unreleased
 * one is instrumentation still running in the developer's page after they
 * ended their capture. AAP 0.5.1 requires a cleared hook to be *disabled*
 * rather than idled, so a hook that still reports itself attached after its
 * own `detach()` ran is a fact the developer has to be given — they are the
 * only party that can act on it, by reloading the page or restarting the dev
 * server.
 *
 * Two states are announced, and the distinction is in each entry's `reason`
 * because the developer's remedy is the same but the diagnosis is not:
 *
 * - the hook **still reports itself attached** after its own `detach()` ran,
 *   so it is still observing; and
 * - the hook **disarmed its gate but left a registration behind** — a listener
 *   the page refused to remove, an observer that would not disconnect, a
 *   prototype slot that would not take its original back. Its
 *   `is…Attached()` says `false`, truthfully, because it is no longer
 *   observing; {@link hookHasResidue} is what sees the rest. Announcing only
 *   the first state would have this frame conclude, from a predicate that
 *   answers a different question, that everything came off.
 *
 * Reported **once per capture** (see {@link reportedUnreleasedHooks}), the way
 * {@link failedHooks} bounds the unavailable report: a hook that refuses to
 * detach refuses on every attempt, and a re-sent configuration or a second
 * disarm must not repeat the same frame for the rest of the capture. The
 * producer's own `producer-failure` frame names the step that failed; this one
 * names the signal that is still in the page.
 *
 * Posted before the transport is reset, so the frame carries the session and
 * capture it belongs to — which is why {@link disarm} detaches the hooks
 * before it calls `resetTransport()`.
 *
 * @param candidates The hooks whose `detach()` was called and which were
 * therefore expected to be released; any that still report themselves attached,
 * or that still hold a registration, are announced.
 */
function reportUnreleasedHooks(candidates: readonly HookName[]): void {
  const unreleased = candidates.filter(
    (name) => (isHookAttached(name) || hookHasResidue(name)) && !reportedUnreleasedHooks.has(name),
  );

  if (unreleased.length === 0) {
    return;
  }

  for (const name of unreleased) {
    reportedUnreleasedHooks.add(name);
  }

  postControl('agent.error', {
    code: 'hooks-not-released',
    message: `the page agent could not release: ${unreleased.join(', ')}`,
    sessionId: armedSessionId ?? null,
    captureId: armedCaptureId ?? null,
    unreleased: unreleased.map((signal) => ({
      signal,
      reason: isHookAttached(signal)
        ? 'the hook still reports itself attached after detach'
        : 'the hook stopped observing but the page kept a registration it could not remove',
      hint: HOOK_UNRELEASED_HINTS[signal],
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
 * **The payload is exactly these five fields, and nothing may be added to it
 * here.** AAP 0.4.2 defines `agent.ready` as
 * `{ tabId, documentId, producerId, url, installedBeforeReact, reactDetected }`
 * — the page supplies five and the service worker adds `tabId` — and
 * `./transport.js` documents the same five for this control frame. The shape is
 * validated at the far end against one shared schema, so a field this producer
 * invents is not extra information: it is a frame the service can refuse, and
 * with it the configuration that would have armed the capture. Widening the
 * contract means changing the shared schema and every relay and consumer
 * *first*; until then {@link AGENT_VERSION} and the recorded `readyState` stay
 * local diagnostics (see {@link bootstrap}'s closing log).
 *
 * **No `tabId`.** A page has no notion of a tab; the service worker relays
 * this frame under the tab's own connection and adds it (AAP 0.4.2). Inventing
 * one here would give the service two answers for the same field.
 *
 * `url` is raw and unredacted, because the service redacts URL query values at
 * ingest and needs the original to do it — and to map the URL onto a route in
 * the code graph (AAP 0.5.2). Raw is not unbounded, though: a URL is page data
 * of a length no page has to justify, and this frame is small enough that its
 * size would otherwise be the page's to choose. It is passed through
 * `./transport.ts`'s `boundControlText`, which leaves every ordinary URL
 * untouched (the bound is several times the longest any server accepts) and
 * truncates beyond it. The field set is unchanged — the service's schema is
 * strict, so a bound is applied to the value and never announced as a second
 * key.
 */
function announceReady(): void {
  try {
    const reactDetected = reactIsRegistered();
    announcedReactDetected = reactDetected;

    postControl('agent.ready', {
      documentId: getDocumentId(),
      producerId: getProducerId(),
      url: boundControlText(readLocationHref()),
      installedBeforeReact,
      reactDetected,
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
 * Register the document listeners: two flush hooks and one restore hook.
 *
 * `pagehide` is the last moment a document can hand anything to the bridge,
 * and `visibilitychange` covers the tab the developer switches away from and
 * never returns to. Both belong to the document rather than to a capture, so
 * they are registered once and outlive every arm and disarm; {@link flush} is
 * a no-op while nothing is buffered, so a dormant agent pays nothing for them.
 *
 * `pagehide` carries a second duty: it releases the document-scoped families
 * (see {@link HookScope}), because that is the only teardown a content script
 * has — there is no unload hook a bundle like this may take. `pageshow` is its
 * counterpart: a document restored from the back/forward cache re-arms them,
 * so element description follows the document it describes. Both calls are
 * idempotent, so the `pageshow` that fires on an ordinary load changes
 * nothing.
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
        detachDocumentHooks();
      };
      window.addEventListener('pagehide', listener);
      pageHideListener = listener;
    }
  } catch {
    pageHideListener = undefined;
  }

  try {
    if (typeof window !== 'undefined' && pageShowListener === undefined) {
      const listener = (): void => {
        attachDocumentHooks();
      };
      window.addEventListener('pageshow', listener);
      pageShowListener = listener;
    }
  } catch {
    pageShowListener = undefined;
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
 * The attribute keys the snapshot travels under, bound from the catalog.
 *
 * `../schema/attributes.ts` declares these three as the component-tree
 * contract and spreads them into the `log` kind's key tuple, so each is
 * annotated with that tuple's member union: a rename there is a compile error
 * here rather than a snapshot `../aggregate/renders.ts` silently stops
 * finding. The same three strings are read by the redactor's component-tree
 * handler and by that aggregate, and this is the only place this module names
 * them.
 */
type ComponentTreeAttributeKey = (typeof COMPONENT_TREE_ATTRIBUTE_KEYS)[number];

/**
 * The forest as JSON text, bounded by {@link MAX_COMPONENT_TREE_JSON_CHARS}.
 */
const KEY_COMPONENT_TREE: ComponentTreeAttributeKey = 'componentTree';

/** How many nodes that text carries, so a consumer need not parse to count. */
const KEY_COMPONENT_TREE_NODE_COUNT: ComponentTreeAttributeKey = 'componentTreeNodeCount';

/** Set when a bound below the requested one had to be used. */
const KEY_COMPONENT_TREE_TRUNCATED: ComponentTreeAttributeKey = 'componentTreeTruncated';

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
  /** The tree as JSON text, bounded by {@link MAX_COMPONENT_TREE_JSON_CHARS}. */
  text: string;
  /** How many nodes that text carries. */
  nodeCount: number;
  /** Whether a bound below the requested one had to be used. */
  reduced: boolean;
}

/**
 * Take the snapshot and serialise it, retrying smaller if it is too large.
 *
 * The bound is {@link MAX_COMPONENT_TREE_JSON_CHARS}, the catalog's single
 * declaration of how much serialized tree may travel, measured here in UTF-16
 * code units. That is never fewer than the code points the catalog counts, so
 * the test is conservative: a tree of astral characters is retried smaller
 * slightly sooner than the bound's own unit would require, and nothing over
 * the bound is ever posted.
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
  if (firstText !== undefined && firstText.length <= MAX_COMPONENT_TREE_JSON_CHARS) {
    return { text: firstText, nodeCount: countTreeNodes(first), reduced: false };
  }

  const second = snapshotTree(FALLBACK_TREE_MAX_NODES, bounds.maxDepth);
  if (second === undefined) {
    return undefined;
  }

  const secondText = serializeTree(second);
  if (secondText === undefined || secondText.length > MAX_COMPONENT_TREE_JSON_CHARS) {
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
 * ## The catalogued contract
 *
 * `../schema/attributes.ts` declares the whole of it, and this function writes
 * exactly that: the event's `name` is {@link COMPONENT_TREE_EVENT_NAME}, which
 * is what identifies this record among `log` records, and the three
 * {@link COMPONENT_TREE_ATTRIBUTE_KEYS} carry the forest
 * ({@link KEY_COMPONENT_TREE}), its node count
 * ({@link KEY_COMPONENT_TREE_NODE_COUNT}) and whether a bound below the
 * requested one had to be used ({@link KEY_COMPONENT_TREE_TRUNCATED}). The
 * kind stays `log`: `../schema/kinds.ts` fixes the kind vocabulary, and a
 * snapshot is a correlated record rather than a new signal type.
 *
 * `../aggregate/renders.ts` is the consumer. It selects the latest event with
 * this name, parses {@link KEY_COMPONENT_TREE} and reports the result as the
 * `componentTree` data source with origin `commit-snapshot`, folding
 * {@link KEY_COMPONENT_TREE_TRUNCATED} into the snapshot's own `truncated` and
 * `degraded` flags — so a reduced tree reaches the panel presented as reduced.
 * On the way there `../redaction/redactor.ts` recognises
 * {@link KEY_COMPONENT_TREE} by name, keeps the structural fields, bounds
 * every component name and React key inside the document and re-serialises
 * valid JSON; the generic string rules it would otherwise have taken cut a
 * value to a 120-code-point preview, which no parser can read back.
 *
 * **The tree travels as JSON text, and that is not incidental.**
 * `./transport.ts` rebuilds every attribute bag into clone-safe values and
 * replaces any container nested deeper than two levels with a type tag, so a
 * component tree posted as a nested object would arrive with its
 * grandchildren's children erased. Text is immune to that walk and stays
 * within one attribute.
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
      [KEY_COMPONENT_TREE]: snapshot.text,
      [KEY_COMPONENT_TREE_NODE_COUNT]: snapshot.nodeCount,
      [KEY_COMPONENT_TREE_TRUNCATED]: snapshot.reduced,
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

/**
 * Take the component-tree snapshot **only if the capture asked for one**.
 *
 * The single gate in front of {@link emitComponentTreeSnapshot}, and the whole
 * of what the seventh wire flag does. Two conditions, both required:
 *
 * 1. **The live configuration set `componentTree`.** The flag is separate from
 *    `react` on the wire precisely so that a capture can have render counts
 *    without paying for a tree (AAP 0.4.2), so an unrequested snapshot is work
 *    the developer did not ask for in a page this product is only visiting —
 *    and an event nothing in the panel would read.
 * 2. **The React family is attached.** The snapshot walks the fiber root
 *    `./react.js` retains from the commits it observed, so without that family
 *    there is nothing to walk. This is a *prerequisite*, never a reason to arm
 *    React: arming a signal the configuration did not request is the other
 *    half of the same mistake. A request that fails it is reported once per
 *    capture instead (AAP 0.5.5).
 *
 * @param trigger Why the snapshot was attempted, for the diagnostics log.
 * @param bounds The bounds to walk under — the live configuration's for a
 * capture that is stopping, the requesting frame's for an on-demand snapshot.
 * @returns `true` when a snapshot was attempted.
 */
function maybeEmitComponentTreeSnapshot(trigger: string, bounds: TreeBounds): boolean {
  if (!componentTreeRequested) {
    debugLog('component tree was not requested by this capture', { trigger });
    return false;
  }

  if (!isHookAttached('react')) {
    debugLog('component tree needs the react hook', { trigger });
    reportComponentTreeRefused();
    return false;
  }

  emitComponentTreeSnapshot(bounds);
  return true;
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
 * 1. **Per-capture state, only for a new capture.** `renderCount`,
 *    `render_count`, the state-transition budget, the once-per-capture
 *    refusal reports and `./fetch.js`'s producer generation are scoped to the
 *    capture, and the service worker re-sends the live configuration after
 *    every reconnect and after every same-origin navigation. Resetting on a
 *    re-send would zero a running capture's counts halfway through the
 *    interaction the developer is reproducing, and would throw away the events
 *    of every request still on the wire.
 *
 *    A capture boundary that is *not* a stop is the case this step exists for:
 *    `agent.config` can move the bound tab from capture A to capture B with
 *    every hook still enabled, so nothing detaches and nothing re-attaches. A
 *    request on the wire from capture A would otherwise settle inside capture B
 *    and be reported there, carrying B's `captureId` and a number from B's
 *    restarted sequence (AAP 0.2.3 scopes `seq` to `(producerId, captureId)`).
 * 2. **The span helper, with the capture's identity.** Armed before the
 *    producers, so a patched application function that runs mid-attach is
 *    recorded rather than passed through — and armed *for a named capture*,
 *    which is the second half of step 1: a patched `async` function is the
 *    other producer whose work outlives the synchronous extent of a capture,
 *    and naming the capture is what makes the helper drop a span that settles
 *    after this one has been replaced.
 * 3. **The new identity is published only once both are invalidated.** The
 *    module's own `armedCaptureId`, and the transport's session and capture,
 *    are written after steps 1 and 2 rather than before them — the ordering is
 *    a safety property. Everything before this point leaves the outgoing
 *    capture's identity in force, so a step that failed would abort the
 *    transition with nothing mis-attributed and with `armedCaptureId` still
 *    naming the old capture, which makes the next `agent.config` — the same one
 *    the service worker re-sends — retry the whole transition instead of
 *    treating it as already done. Publishing first would leave the transport
 *    stamping capture B while a producer was still recording under capture A's
 *    generation, which is the leak steps 1 and 2 exist to close. The transport
 *    is still told before any hook attaches, which is what that ordering
 *    requirement is for: a hook can fire during the very attach that registers
 *    it — React commits on its own schedule, a buffered `PerformanceObserver`
 *    flushes as soon as it is started — so nothing may be emitted before the
 *    transport knows the session and capture. A changed `captureId` also
 *    restarts the sequence there.
 * 4. **Capture-scoped families, detached before attached, each in its own
 *    guard.** Detaching first releases what is no longer wanted before
 *    anything new starts observing; attaching in {@link HOOK_NAMES} order
 *    means the lineage registry and the interaction context exist before the
 *    producers that ask for them. Document-scoped families are untouched: the
 *    opening sequence owns them (see {@link HookScope}).
 * 5. **The component-tree authorisation is stored, not acted on.** The
 *    seventh flag arms no observer; it authorises the one snapshot
 *    {@link maybeEmitComponentTreeSnapshot} takes as the capture stops, and a
 *    request that cannot be met — no React family attached — is reported here
 *    rather than discovered silently at capture stop.
 * 6. **Unavailable and unreleased signals are announced.** A family that would
 *    not attach is reported as an `agent.error` frame, once per capture, so
 *    the service can say which evidence the capture does not have (AAP 0.5.5)
 *    instead of the analysis being drawn from a silently narrower set — and a
 *    family this configuration dropped that still reports itself attached, or
 *    that left a registration behind, is reported the same way, because
 *    instrumentation the developer switched off and that kept running is
 *    theirs to know about (AAP 0.5.1, {@link reportUnreleasedHooks}).
 *
 * Idempotent by construction: every decision is taken against the siblings'
 * own `is…Attached()` predicates and against {@link armedCaptureId}, never
 * against a diff of the raw payload, so the same configuration applied twice
 * changes nothing and a subset detaches exactly the families it dropped.
 */
function arm(config: ParsedAgentConfig): void {
  const captureChanged = config.captureId !== armedCaptureId;

  if (captureChanged) {
    failedHooks.clear();
    reportedUnreleasedHooks.clear();
    componentTreeRefusalReported = false;
    // Requests already on the wire belong to the capture that has just ended.
    // Nothing detaches here — the developer is still capturing requests, and
    // `./fetch.js` keeps both patches installed — so the producer generation is
    // advanced instead, which makes every in-flight record stale: no event, no
    // continuation settle, no counter movement.
    advanceFetchGeneration();
    resetReactCounters();
    resetStateCounters();
    resetContinuations();
  }

  // The capture identity goes in with the arming, not just the `true`: the
  // helper stamps every span it opens with the capture it opened in and refuses
  // to report one that settles in a different one. Passing the id is what tells
  // it a boundary happened at all — without it, a patched `async` function
  // whose promise settles after the tab moved from one capture to the next
  // would be reported inside the capture that replaced its own.
  setSpanHelperEnabled(true, config.captureId);

  // Published only now, with every producer of the outgoing capture already
  // invalidated above: see step 3 of this function's documentation for why the
  // order is a safety property and not a preference.
  armedSessionId = config.sessionId;
  armedCaptureId = config.captureId;
  treeBounds = config.tree;
  componentTreeRequested = config.hooks.componentTree;

  configureTransport({
    sessionId: config.sessionId,
    captureId: config.captureId,
    enabled: true,
  });

  // The families this configuration drops. Collected rather than merely
  // detached, because a family that refused to release has to be announced
  // (AAP 0.5.1) and the announcement can only name the families a detach was
  // actually asked of.
  //
  // A detach is asked of every dropped family, not only of the ones that report
  // themselves attached. A producer whose previous teardown could not remove a
  // listener, disconnect an observer or restore a prototype slot retains that
  // residue *and* reports itself unattached — `is…Attached()` means
  // "observing", and a disarmed registration observes nothing — so gating this
  // call on `isHookAttached` would be the one thing that never lets the retry
  // happen, leaving the residue in the developer's page for the life of the
  // document. Every producer's `detach()` is documented idempotent and
  // non-throwing, so asking twice costs nothing and is the only way the
  // retained cleanup is ever completed.
  const released: HookName[] = [];
  for (const name of reversedHookNames()) {
    if (!isHookRequested(name, config.hooks)) {
      detachHook(name);
      released.push(name);
    }
  }

  const failures: HookName[] = [];
  for (const name of CAPTURE_HOOK_NAMES) {
    if (!isHookRequested(name, config.hooks) || isHookAttached(name) || failedHooks.has(name)) {
      continue;
    }
    if (!attachHook(name)) {
      failedHooks.add(name);
      failures.push(name);
    }
  }

  // Both announcements are made here, after the attach loop, so that the
  // `enabled` list each frame carries is what the capture is actually
  // continuing with (AAP 0.5.5's "Continuing with: ‹enabled list›") rather
  // than a mid-arm snapshot taken before the new hooks were armed.
  reportUnreleasedHooks(released);
  reportUnavailableHooks(failures);

  // The tree is taken at capture stop, so a request that cannot be met is
  // worth saying now: the developer is about to reproduce their problem, and
  // "the tree is missing" is not something to learn from an empty panel node
  // afterwards.
  if (componentTreeRequested && !isHookAttached('react')) {
    reportComponentTreeRefused();
  }

  debugLog('armed', {
    sessionId: config.sessionId ?? null,
    captureId: config.captureId ?? null,
    attached: attachedHookNames(),
    signals: enabledSignalNames(),
    componentTree: componentTreeRequested,
    unavailable: failures,
  });
}

/**
 * Return the agent to the dormant state it had before any capture.
 *
 * The order is AAP 0.5.1's cleanup sequence and each step depends on the one
 * before it:
 *
 * 1. **The component-tree snapshot, if the capture authorised one** and while
 *    React is still attached and the transport still carries the ending
 *    capture — after either, the structure is gone and the event would be
 *    dropped. {@link maybeEmitComponentTreeSnapshot} is the gate.
 * 2. **A flush**, so what the capture already recorded leaves before the
 *    transport stops accepting anything.
 * 3. **Detach every capture-scoped family in reverse attach order**, so
 *    interaction context outlives the producers that resolve against it and
 *    nothing resolves a trace from a half-released window. Unconditionally,
 *    not only the families whose predicate says they are attached: every
 *    sibling's `detach` is idempotent, and "disabled, not merely idled"
 *    (AAP 0.5.1) is a guarantee that must not rest on a predicate being
 *    accurate. Each detach runs in its own guard, and whatever is still
 *    attached — or still holds a registration — afterwards is announced while
 *    the session and capture are still known (see
 *    {@link reportUnreleasedHooks}). Document-scoped families survive — they
 *    belong to the document, and the panel still selects elements between
 *    captures.
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
 * the installed hook, the inert helper, element description, the bridge
 * subscription and the flush listeners — none of which observes the
 * developer's application.
 */
function disarm(): void {
  const wasArmed = armedCaptureId !== undefined;

  maybeEmitComponentTreeSnapshot('capture-stop', treeBounds);

  try {
    flush();
  } catch {
    // The queue survives a failed flush; the reset below discards it, which is
    // the honest outcome for events the bridge never took.
  }

  // Every hook, whatever it says about itself: see the same loop in
  // {@link arm} for why an unattached hook is still asked to detach. A
  // producer holding residue from a teardown the page refused reports itself
  // unattached, and this call is its only chance to try again.
  for (const name of reversedHookNames()) {
    detachHook(name);
  }

  // Before `resetTransport()` below, and deliberately: a family still holding
  // on after its own `detach()` is instrumentation left running in the
  // developer's page, and the frame that says so is only useful if it still
  // carries the session and capture it belongs to. Every capture-scoped family
  // is a candidate here because a detach was asked of every one of them.
  reportUnreleasedHooks(CAPTURE_HOOK_NAMES);

  resetSpanStack();
  setSpanHelperEnabled(false);
  configureTransport({ enabled: false });
  resetTransport();
  resubscribeToBridge();

  failedHooks.clear();
  armedSessionId = undefined;
  armedCaptureId = undefined;
  componentTreeRequested = false;
  componentTreeRefusalReported = false;
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

/**
 * The capture-scoped families in detach order.
 *
 * A fresh array, because {@link CAPTURE_HOOK_NAMES} is frozen — and
 * capture-scoped only, because the document-scoped families are released by
 * {@link detachDocumentHooks} when the document goes away rather than when a
 * capture ends.
 */
function reversedHookNames(): HookName[] {
  return [...CAPTURE_HOOK_NAMES].reverse();
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
 * down, `armed` reflects a live capture even when every family it asked for
 * turned out to be unavailable (the span helper and the transport are still
 * armed, so patched function spans still flow), and `hooks` is read from the
 * siblings' own predicates rather than from a record of what was requested.
 *
 * `hooks` carries **all eight families** — including the two no wire flag
 * names — because that is the lifecycle this module is answerable for: a
 * family missing from this record is a family nothing can prove was released.
 * `componentTreeRequested` is the seventh flag's state, which has no family of
 * its own (see {@link maybeEmitComponentTreeSnapshot}).
 */
export function getAgentState(): {
  installed: boolean;
  armed: boolean;
  hooks: Record<string, boolean>;
  componentTreeRequested: boolean;
  installedBeforeReact: boolean;
} {
  return {
    installed,
    armed: armedCaptureId !== undefined,
    hooks: familyRecord((name) => isHookAttached(name)),
    componentTreeRequested,
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
        // the component tree mid-capture. Bounds may accompany the request,
        // and the same authorisation applies as at capture stop — the frame
        // asks *when*, the `componentTree` flag decides *whether*, so a
        // capture that did not request a tree cannot be made to produce one by
        // a relayed frame.
        maybeEmitComponentTreeSnapshot('agent.snapshot', readTreeBounds(message.payload));
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
 * The `domTarget` family is the gate: element description is a document-scoped
 * capability (see {@link HOOK_BINDINGS}), armed by the opening sequence and
 * released when the document goes away, so a call after that release answers
 * `undefined` rather than describing a page that is no longer there.
 *
 * @param element Whatever the caller had — `$0` is routinely `null`, a text
 * node, or an object from another realm.
 * @returns The descriptor, or `undefined` when the input is not an element or
 * the family is not attached.
 */
function describeTargetForPanel(element: unknown): unknown {
  try {
    if (!isHookAttached('domTarget')) {
      return undefined;
    }
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

  // Step 2a — arm the document-scoped families. Before the helper, because
  // `domTarget` is what answers the `describeTarget` the helper is about to
  // publish, and a capability published before it is armed would answer
  // `undefined` to the panel's first selection. These families observe nothing
  // on their own, so arming them here does not break the dormancy contract —
  // it is what makes element selection work before a session has a plan
  // (AAP 0.1.1, 0.4.2).
  try {
    attachDocumentHooks();
  } catch {
    // Each family's own predicate reports the failure; the sequence continues
    // so that a page without a DOM still installs the helper and announces.
  }

  // Step 2b — publish `globalThis.__DEBUGGEN__`, disabled. It must exist this
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
  // `agent.config` arms one. The agent version and the recorded `readyState`
  // are reported here rather than on the wire: `agent.ready`'s payload is the
  // exact five fields of AAP 0.4.2 (see {@link announceReady}).
  debugLog('installed', {
    agentVersion: AGENT_VERSION,
    installedBeforeReact,
    readyState: initialReadyState,
    documentHooks: DOCUMENT_HOOK_NAMES.filter((name) => isHookAttached(name)),
  });
}

/*
 * The bundle's single import-time side effect, and the reason this module is
 * the only file in this folder that has one: `esbuild.agent.mjs` makes this
 * file the IIFE's entry point, so the call below *is* the content script.
 */
bootstrap();
