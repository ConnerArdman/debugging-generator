/**
 * The **browser-performance adapter**: the runtime-mode adapter that arms the
 * page agent's interaction listener, its performance observers and its error
 * capture.
 *
 * ## What it claims, and why it comes first
 *
 * It claims two of the eight action types of `../schema/plan.ts` —
 * `'interaction-tracking'` and `'perf-tracking'` — both in `'runtime'` mode,
 * and it maps them onto three of the seven page-agent hook keys of
 * `../schema/readiness.ts`: `interactions`, `perf` and `errors`.
 *
 * `interactions` is the one every other browser signal hangs off.
 * `packages/telemetry/src/browser/interaction.ts` mints the trace id each
 * render, state transition and request of an interaction is attributed to, and
 * `.../browser/fetch.ts` injects the `traceparent` header only while that
 * interaction context is open — so without this hook the browser and the dev
 * server produce two unrelated trees and the correlated timeline of AAP §0.4.2
 * renders nothing joined. That is why `deriveAgentHookConfig` forces
 * `interactions` on whenever any browser hook is on, and why the acceptance
 * test of AAP §0.8.4 — a question about a slow interaction — begins here: the
 * span this adapter enables is the root of the tree that answers it.
 *
 * ## It writes nothing
 *
 * Interactions, performance entries, long tasks and page errors are *runtime*
 * signals in AAP §0.5.1's table: the page agent observes them through browser
 * APIs that already exist, so there is nothing to patch. This module therefore
 * never imports `../patch/**`, never constructs a `ModificationRecord`, and
 * returns an empty {@link InstallResult.applied} on every install and an empty
 * {@link RemoveResult.restored} on every removal. Nothing here touches a
 * filesystem, reads an environment variable, opens a socket or writes to the
 * console; every fact it uses arrives on the {@link InstrumentationContext}.
 *
 * ## Targets come from the graph, never from a name
 *
 * The anchors this adapter proposes are `handler` nodes the code index found
 * (falling back to their enclosing `component` nodes for an inline arrow, which
 * has no declaration of its own), narrowed by the *structured*
 * {@link ProblemUnderstanding} — its entity list and search hints resolved
 * through `queries.findByName` — and never by the developer's question text.
 * No application's handler, component, event or route name appears as a literal
 * anywhere below; the only application-specific strings in this module's output
 * are values interpolated out of the graph at runtime (AAP §0.5.4, enforced by
 * `scripts/check-no-hardcoding.mjs`).
 *
 * ## Gaps are data
 *
 * A capture that cannot observe a signal still runs with what remains
 * (AAP §0.5.5). A missing page agent is reported as an
 * {@link UnavailableSignal} per claimed signal with a single concrete recovery
 * action, and a stale agent report is reported as a `'degraded'` readiness row
 * rather than as a failure — the promise is never rejected for a signal that
 * merely turned out to be unavailable.
 *
 * @example
 * ```ts
 * const adapter = createBrowserPerformanceAdapter();
 *
 * if (adapter.canHandle(context)) {
 *   const actions = await adapter.createPlan(context, understanding);
 *   const result = await adapter.install(actions, context);
 *   // result.applied is always empty; result.agentHooks names what was armed.
 * }
 * ```
 */

import type { CodeGraph, CodeNodeKind, CodeNodeOf, CodeQueries } from '@debuggen/code-analysis';
import {
  isSafeRelativePath,
  newActionId,
  normalizePosix,
  nowEpochMs,
  toPosix,
} from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';

import type {
  AdapterRemoveRequest,
  InstallResult,
  InstrumentationAdapter,
  InstrumentationContext,
  ObservedBrowserAgent,
  RemoveResult,
  UnavailableSignal,
} from '../adapter.js';
import type {
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
} from '../schema/plan.js';
import {
  BROWSER_CAPTURE_SIGNALS,
  buildReadiness,
  deriveAgentHookConfig,
} from '../schema/readiness.js';
import type {
  AgentHookConfig,
  AgentHookKey,
  CaptureSignal,
  Readiness,
  ReadinessSignal,
  ReadinessStatus,
} from '../schema/readiness.js';
import type { ProblemUnderstanding } from '../schema/target.js';

// ---------------------------------------------------------------------------
// Identity and claims
//
// The two exports `../registry.ts` reads. They are declared here, beside the
// implementation they describe, so that the adapter's identity and the types it
// claims cannot disagree with each other — the registry resolves an action's
// `adapter` and `mode` for `normalizePlan` from the claim table below, and the
// installer looks this adapter back up by the id below.
// ---------------------------------------------------------------------------

/**
 * This adapter's registered identity.
 *
 * Kebab-case, matching the module's file name, and **stable across versions**:
 * a stored plan or a readiness report read back after an upgrade names the
 * adapter that produced it, so an id that moved would orphan it. It must equal
 * this adapter's member of `ADAPTER_IDS` in `../registry.ts`; this spelling is
 * the canonical one.
 *
 * Typed as the literal rather than as `string` so a mismatch between the
 * registry's table and this module is a compile error rather than a value two
 * modules disagree about at runtime.
 */
export const BROWSER_PERFORMANCE_ADAPTER_ID = 'browser-performance';

/**
 * The action types this adapter claims, each with the mode it installs them
 * in — the single place those two facts are written.
 *
 * Both are `'runtime'`: the page agent observes an interaction through a
 * capture-phase listener and performance entries through `PerformanceObserver`,
 * so neither costs a byte of a developer's file (AAP §0.5.1).
 *
 * `../registry.ts` imports this const to answer `PlanAdapterResolver`'s
 * `resolveActionType`, and this module's own `install` filters incoming actions
 * against its keys — so the plan the developer is shown, the mode normalisation
 * records and the work this adapter actually does are one statement rather than
 * three that have to be kept in step.
 *
 * Frozen, and `satisfies` checks every key against the real action-type
 * vocabulary and every value against the real mode vocabulary, so a typo fails
 * the build instead of silently claiming nothing.
 */
export const BROWSER_PERFORMANCE_ADAPTER_CLAIMS = Object.freeze({
  'interaction-tracking': 'runtime',
  'perf-tracking': 'runtime',
} as const) satisfies Readonly<Partial<Record<InstrumentationActionType, InstrumentationMode>>>;

/**
 * One action type this adapter claims.
 *
 * Derived from {@link BROWSER_PERFORMANCE_ADAPTER_CLAIMS} so the table and the
 * type cannot drift.
 */
export type BrowserPerformanceActionType = keyof typeof BROWSER_PERFORMANCE_ADAPTER_CLAIMS;

/**
 * The page-agent hook keys this adapter contributes, in
 * `AGENT_HOOK_KEYS` order.
 *
 * `interactions` from an `'interaction-tracking'` action; `perf` and `errors`
 * from a `'perf-tracking'` one — page errors are the cheap, non-interfering
 * companion signal this adapter owns, because a capture that recorded a long
 * task while hiding the exception behind it would actively mislead. The mapping
 * itself is **not** restated here: `deriveAgentHookConfig` in
 * `../schema/readiness.ts` owns it, together with the prerequisite that any
 * enabled browser hook forces `interactions` on. This tuple is only the set of
 * keys this adapter is entitled to speak about, which is what narrows that
 * derivation to this adapter's contribution.
 *
 * Every member is also a {@link CaptureSignal}, which is what lets the readiness
 * rows and the unavailable rows below be derived from the same tuple as the hook
 * contribution rather than from a second hand-written table.
 */
export const BROWSER_PERFORMANCE_HOOK_KEYS = Object.freeze([
  'interactions',
  'perf',
  'errors',
] as const) satisfies readonly AgentHookKey[];

/** One hook key this adapter contributes. */
export type BrowserPerformanceHookKey = (typeof BROWSER_PERFORMANCE_HOOK_KEYS)[number];

// ---------------------------------------------------------------------------
// Options and limits
// ---------------------------------------------------------------------------

/**
 * The bounds one adapter instance runs under.
 *
 * Declared as an interface with `number` members rather than inferred from
 * {@link BROWSER_PERFORMANCE_ADAPTER_LIMITS}: the defaults are literals, and a
 * type built from them would refuse the clamped value a caller's own
 * `maxTargets` produces.
 */
export interface BrowserPerformanceAdapterLimits {
  /** How many anchors one proposal may name. */
  readonly maxTargets: number;

  /** How long a page-agent report stays current, in milliseconds. */
  readonly staleReportAfterMs: number;

  /** How many graph matches one evidence lookup may consider. */
  readonly maxEvidenceMatches: number;
}

/**
 * The adapter's default bounds, frozen.
 *
 * Exported so a suite asserts against the same numbers the adapter uses
 * instead of transcribing them, and so a caller that wants to raise one knows
 * what it is raising from.
 */
export const BROWSER_PERFORMANCE_ADAPTER_LIMITS: BrowserPerformanceAdapterLimits = Object.freeze({
  /**
   * How many anchors one proposal may name.
   *
   * Small on purpose. An `'interaction-tracking'` action is a *provenance*
   * record for a document-wide listener, not a per-target installation, so a
   * proposal naming every handler in a large project would make the plan the
   * developer is shown unreadable without observing anything extra.
   */
  maxTargets: 8,

  /**
   * How long a page-agent report stays current, in milliseconds.
   *
   * Readiness is a statement about a moment: a tab can navigate between a check
   * and a capture, and the agent re-announces itself on every document. A
   * report older than this yields a `'degraded'` row rather than an
   * `'available'` one — the hooks can still be armed, but the product says
   * plainly that the observation it is relying on may predate the page in front
   * of the developer.
   */
  staleReportAfterMs: 120_000,

  /**
   * How many graph matches one evidence lookup may consider.
   *
   * Clamped again at the call site against `queries.limits.maxResults`, so this
   * number can never widen a query beyond what `@debuggen/code-analysis`
   * permits.
   */
  maxEvidenceMatches: 24,
});

/**
 * The knobs {@link createBrowserPerformanceAdapter} accepts.
 *
 * Every member is optional and fully defaulted, and none of them is state: the
 * adapter this factory returns holds no mutable field, so two adapters built
 * from one options object cannot interfere, and building one has no effect on
 * anything (the registry constructs the built-ins at start-up).
 *
 * Deliberately **not** here: the session, the project, the graph, the observed
 * readiness facts and the clock the session runs on. Those arrive per call on
 * the {@link InstrumentationContext}, which is what keeps every method a pure
 * function of its arguments.
 */
export interface BrowserPerformanceAdapterOptions {
  /**
   * How many anchors a proposal may name.
   *
   * Defaults to {@link BROWSER_PERFORMANCE_ADAPTER_LIMITS}'s `maxTargets`. A
   * value that is not a positive integer is clamped rather than thrown on: this
   * factory runs while the service is starting, and a mistyped knob must not
   * take the service down. The clamp is reported through
   * {@link BrowserPerformanceAdapterOptions.logger}.
   */
  readonly maxTargets?: number | undefined;

  /**
   * How long a page-agent report stays current, in milliseconds.
   *
   * Defaults to {@link BROWSER_PERFORMANCE_ADAPTER_LIMITS}'s
   * `staleReportAfterMs`, and clamped the same way.
   */
  readonly staleReportAfterMs?: number | undefined;

  /**
   * A clock, in epoch milliseconds, for the staleness comparison.
   *
   * The per-call `context.now` takes precedence when the service supplies one;
   * this is the fallback for a caller that built the adapter with a clock but
   * whose contexts carry none. Both exist so a suite can assert an exact
   * readiness `checkedAt` and an exact staleness verdict without freezing time
   * globally. A clock that throws, or that returns a value which is not a
   * positive finite number, is ignored in favour of `nowEpochMs()` — a report
   * built on a nonsense timestamp would be rejected by `parseReadiness` at the
   * boundary it crossed.
   */
  readonly now?: (() => number) | undefined;

  /**
   * Where **construction-time** diagnostics go.
   *
   * Only the option clamps above are reported here, because they are the one
   * thing this module observes before it has a context. Everything a method
   * observes is logged through `context.logger`, which is the session-scoped
   * logger and the only one that can attribute a line to a session. Defaults to
   * `noopLogger`'s behaviour: silence.
   */
  readonly logger?: Logger | undefined;
}

/**
 * This adapter's public face: the {@link InstrumentationAdapter} contract, with
 * its identity and claim table narrowed to the literals this module declares.
 *
 * Returned by {@link createBrowserPerformanceAdapter} and assignable to
 * `InstrumentationAdapter` wherever the registry holds adapters uniformly. The
 * two extra members let a registry that enumerates *instances* resolve an
 * action type without a second import, while `../registry.ts` may equally read
 * the exported consts directly — the values are the same objects.
 */
export interface BrowserPerformanceAdapter extends InstrumentationAdapter {
  /** Always {@link BROWSER_PERFORMANCE_ADAPTER_ID}. */
  readonly id: typeof BROWSER_PERFORMANCE_ADAPTER_ID;

  /** Always {@link BROWSER_PERFORMANCE_ADAPTER_CLAIMS}. */
  readonly claims: typeof BROWSER_PERFORMANCE_ADAPTER_CLAIMS;

  /** Always {@link BROWSER_PERFORMANCE_HOOK_KEYS}. */
  readonly hookKeys: typeof BROWSER_PERFORMANCE_HOOK_KEYS;

  /** The bounds this instance was built with, after clamping. */
  readonly limits: BrowserPerformanceAdapterLimits;
}

// ---------------------------------------------------------------------------
// Per-signal descriptors
//
// One row per claimed signal: the hooks a developer is told about, and the
// fragment that names what could not be armed. Written once so that the
// install result, the unavailable rows and the readiness rows all speak with
// the same voice (AAP §0.5.5 renders `reason` and `hint` verbatim).
// ---------------------------------------------------------------------------

/** What this adapter can say about one of the three signals it claims. */
interface SignalDescriptor {
  /**
   * The runtime hooks this signal arms, named for a developer to read.
   *
   * These land in `instrumentation.ready`'s `runtimeHooks` and in the editor's
   * "Preparing instrumentation" checklist, so they describe the mechanism in
   * the browser's own vocabulary rather than naming an internal module.
   */
  readonly hooks: readonly string[];

  /**
   * What is not running when the signal cannot be collected, as a noun phrase
   * that reads inside "…, so ‹this› cannot be armed".
   */
  readonly observes: string;
}

/**
 * The three claimed signals, keyed by hook key.
 *
 * A total table over {@link BROWSER_PERFORMANCE_HOOK_KEYS} rather than a
 * `switch`, so a key added to that tuple fails this declaration until it says
 * something about the new case.
 *
 * The `perf` row names the four entry types
 * `packages/telemetry/src/browser/perf.ts` observes, because "performance
 * entries" on its own tells a developer nothing about what the capture will
 * contain.
 */
const SIGNAL_DESCRIPTORS: Readonly<Record<BrowserPerformanceHookKey, SignalDescriptor>> =
  Object.freeze({
    interactions: {
      hooks: Object.freeze([
        'Browser interactions (capture-phase listener)',
        'Interaction timing (PerformanceObserver: event)',
      ]),
      observes: 'the capture-phase interaction listener that starts each trace',
    },
    perf: {
      hooks: Object.freeze([
        'Long tasks (PerformanceObserver: longtask)',
        'Navigation timing (PerformanceObserver: navigation)',
        'Paint timing (PerformanceObserver: paint)',
        'Resource timing (PerformanceObserver: resource)',
      ]),
      observes: 'the performance entry observers for long tasks, resources, navigation and paint',
    },
    errors: {
      hooks: Object.freeze(['Page errors and unhandled rejections']),
      observes: 'the page error and unhandled-rejection capture',
    },
  });

/**
 * The one action a developer can take when no page agent has reported.
 *
 * The agent is declared as a dormant `document_start` content script and is
 * armed by the service worker once a tab is bound to a session (AAP §0.1.3), so
 * the recovery is to open the application with the panel open — not to install
 * anything, and **not** to reload for the React fiber hook, which is the
 * sibling React adapter's concern and has nothing to do with interactions,
 * performance entries or errors.
 */
const AGENT_ABSENT_HINT =
  'Open the application in a Chrome tab with the "Debug Generator" DevTools panel open, then try again so the service can arm the page agent for that tab.';

/** The one action a developer can take when the agent's report has aged out. */
const AGENT_STALE_HINT =
  'Reload the application tab, or interact with it, so the page agent announces itself for the document now in front of you.';

// ---------------------------------------------------------------------------
// Evidence tiers
//
// How strongly the understanding points at an anchor. Lower is stronger, and
// the order is the narrowing order of AAP §0.7.1's adapter brief: a component
// the question named, then any named entity, then a search hint, then nothing.
// ---------------------------------------------------------------------------

/** The anchor is a handler of — or is — a component the understanding named. */
const TIER_COMPONENT = 0;

/** The anchor, or its component, resolves from an entity the understanding named. */
const TIER_ENTITY = 1;

/** The anchor, or its component, resolves from one of the search hints. */
const TIER_HINT = 2;

/** Nothing in the understanding points at this anchor. */
const TIER_NONE = 3;

/** Which node kinds an evidence lookup for a component name accepts. */
const COMPONENT_KINDS: readonly CodeNodeKind[] = Object.freeze(['component'] as const);

/**
 * The browser tier's signal names, widened to the whole vocabulary.
 *
 * The widening is the point: it lets an arbitrary {@link CaptureSignal} be
 * tested for membership of `BROWSER_CAPTURE_SIGNALS`, whose own element type is
 * the narrower tuple union. An annotation rather than an assertion, and a
 * reference rather than a copy — the tuple stays the single definition in
 * `../schema/readiness.ts`.
 */
const BROWSER_SIGNALS: readonly CaptureSignal[] = BROWSER_CAPTURE_SIGNALS;

/** How an anchor was arrived at, which is what its rationale states. */
type AnchorProvenance = 'named-handler' | 'enclosing-component' | 'component';

/** One resolvable anchor for an action, before it is ranked. */
interface AnchorCandidate {
  /** Project-relative POSIX path, already in the normal form the plan requires. */
  readonly file: string;

  /** The declared symbol the action names; verified with `hasSymbol`. */
  readonly symbol: string;

  /** 1-based declaration line, used only to order candidates deterministically. */
  readonly line: number;

  /** How this anchor was arrived at. */
  readonly provenance: AnchorProvenance;

  /**
   * The DOM event name the graph recorded for the handler, without its `on`
   * prefix, when the anchor came from one.
   *
   * Interpolated into the rationale. A graph-derived value, never a literal in
   * this module (AAP §0.5.4).
   */
  readonly event: string | undefined;

  /**
   * The graph node ids this anchor stands for — the handler, its enclosing
   * component, or the component alone.
   *
   * The join key for evidence matching: an entity resolved through
   * `findByName` produces node ids, and an anchor is evidenced when one of
   * these appears among them.
   */
  readonly nodeIds: readonly string[];
}

/** An anchor with its evidence tier, ready to sort. */
interface RankedAnchor extends AnchorCandidate {
  /** One of the four tier constants above; lower is stronger evidence. */
  readonly tier: number;
}

/** The node ids and declarations the understanding resolved to, by tier. */
interface EvidenceIndex {
  /** Node ids naming a component the understanding named, plus its handlers. */
  readonly componentIds: ReadonlySet<string>;

  /** Node ids resolved from any entity of the understanding. */
  readonly entityIds: ReadonlySet<string>;

  /** `file\0name` declarations resolved from any entity of the understanding. */
  readonly entityDeclarations: ReadonlySet<string>;

  /** Node ids resolved from the understanding's search hints. */
  readonly hintIds: ReadonlySet<string>;

  /** `file\0name` declarations resolved from the search hints. */
  readonly hintDeclarations: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Orders two strings by UTF-16 code unit, without a locale.
 *
 * `localeCompare` is deliberately avoided for the reason
 * `../schema/readiness.ts` avoids it: its result depends on the host's locale
 * data, so the same graph would produce differently ordered plans and hook
 * lists on two machines — and a determinism assertion would pass or fail by
 * environment.
 *
 * @param left First string.
 * @param right Second string.
 * @returns `-1`, `0` or `1`.
 */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

/**
 * The identity of an anchor, for de-duplication.
 *
 * `\u0000` cannot occur in a path or an identifier the graph holds, so the
 * concatenation is unambiguous without an escaping scheme.
 *
 * @param file The anchor's file.
 * @param symbol The anchor's symbol.
 * @returns The key.
 */
function anchorKey(file: string, symbol: string): string {
  return `${file}\u0000${symbol}`;
}

/**
 * Clamps an optional positive-integer knob, reporting a rejected value.
 *
 * Sanitising rather than throwing is deliberate: `createAdapterRegistry` builds
 * the built-in adapters while the service is starting, and a mistyped option
 * must degrade to the default instead of preventing every session. The clamp is
 * logged so the mistake is still discoverable.
 *
 * @param value The caller's value, possibly absent.
 * @param fallback The default to use when the value is unusable.
 * @param name The option's name, for the log line.
 * @param logger Where to report a rejected value.
 * @returns A positive integer.
 */
function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  logger: Logger | undefined,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  logger?.debug('browser-performance adapter option ignored', {
    adapter: BROWSER_PERFORMANCE_ADAPTER_ID,
    option: name,
    fallback,
  });

  return fallback;
}

/**
 * Reads a clock defensively, in epoch milliseconds.
 *
 * Tries the context's clock first — the session's own, which the service
 * injects — then the one this adapter was built with, then `nowEpochMs()`. A
 * clock that throws or returns a value which is not a positive finite number is
 * skipped: `readinessSchema` requires a positive `checkedAt`, so a nonsense
 * timestamp would turn a truthful report into a rejected one at the first
 * boundary it crossed.
 *
 * @param clocks The candidate clocks, in precedence order.
 * @returns A positive epoch-millisecond timestamp.
 */
function readClock(clocks: readonly ((() => number) | undefined)[]): number {
  for (const clock of clocks) {
    if (clock === undefined) {
      continue;
    }

    try {
      const value = clock();

      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    } catch {
      // A caller-supplied clock is ordinary caller code: a throw is a reason to
      // fall through to the next candidate, never to fail an install.
    }
  }

  return nowEpochMs();
}

/**
 * Whether the caller has asked for the work to stop.
 *
 * A function rather than an inline `signal?.aborted` test at each step, and
 * that is load-bearing rather than stylistic: `AbortSignal.aborted` is a
 * `readonly` property, so TypeScript narrows it permanently after the first
 * check and reports every later one as an impossible comparison — which would
 * leave the cancellation the adapter contract asks for as dead code. A call
 * re-reads the live value.
 *
 * @param signal The context's signal, when it carries one.
 * @returns `true` when the work should stop at this step boundary.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Whether the plan's path rule would accept this path as already normalised.
 *
 * The same two conditions `../schema/plan.ts`'s internal schema applies, so an
 * action this module emits cannot be rejected for its `file` field: safe and
 * project-relative, and already its own normal form.
 *
 * @param file The candidate path.
 * @returns `true` when the path may be used as an action's `file`.
 */
function isUsableActionPath(file: string): boolean {
  return isSafeRelativePath(file) && file === normalizePosix(toPosix(file));
}

// ---------------------------------------------------------------------------
// Observed browser-agent facts
//
// Read from `context.readiness.browserAgent` and nowhere else: the service
// holds the relayed `agent.ready` frame for the bound tab's current document,
// and an adapter that went looking for its own evidence could contradict it
// (`../adapter.ts`).
// ---------------------------------------------------------------------------

/** What this adapter concludes about the page agent. */
type AgentAvailability =
  | { readonly kind: 'absent' }
  | { readonly kind: 'stale'; readonly ageMs: number }
  | { readonly kind: 'fresh' };

/**
 * Classifies the page agent's latest report.
 *
 * Note what is **not** consulted: `installedBeforeReact` and `reactDetected`.
 * Those gate React commit observation — a fiber hook has to exist before React
 * loads — and say nothing about a capture-phase DOM listener, a
 * `PerformanceObserver` or a `window` error handler, all of which work on a
 * page with no React on it at all. Copying that gate here would tell a
 * developer to reload for a signal a reload cannot affect.
 *
 * @param agent The relayed report, when there is one.
 * @param nowMs The current time, in epoch milliseconds.
 * @param staleAfterMs How long a report stays current.
 * @returns `'absent'`, `'stale'` with the report's age, or `'fresh'`.
 */
function assessBrowserAgent(
  agent: ObservedBrowserAgent | undefined,
  nowMs: number,
  staleAfterMs: number,
): AgentAvailability {
  if (agent === undefined) {
    return { kind: 'absent' };
  }

  const ageMs = nowMs - agent.observedAt;

  // A negative age is clock skew between the moment the frame was stamped and
  // the clock this call was given, not a stale report; a report from the future
  // is treated as current rather than as an error.
  if (ageMs > staleAfterMs) {
    return { kind: 'stale', ageMs };
  }

  return { kind: 'fresh' };
}

/**
 * The reason fragment for a signal that could not be armed.
 *
 * Reads after AAP §0.5.5's "Could not enable ‹signal›: ", so it is a fragment
 * stating what was observed — never a sentence about the product and never an
 * exception message.
 *
 * @param key The signal's hook key.
 * @returns The fragment.
 */
function agentAbsentReason(key: BrowserPerformanceHookKey): string {
  return `no page agent has reported for the tab bound to this session, so ${SIGNAL_DESCRIPTORS[key].observes} cannot be armed`;
}

/**
 * The reason fragment for a signal whose agent report has aged out.
 *
 * @param key The signal's hook key.
 * @param ageMs How old the report is.
 * @returns The fragment.
 */
function agentStaleReason(key: BrowserPerformanceHookKey, ageMs: number): string {
  const ageSeconds = Math.floor(ageMs / 1_000);

  return `the page agent last reported ${ageSeconds}s ago, so ${SIGNAL_DESCRIPTORS[key].observes} may belong to a document the tab has already left`;
}

// ---------------------------------------------------------------------------
// Hook contribution
// ---------------------------------------------------------------------------

/**
 * Which of this adapter's hook keys a set of actions asks for.
 *
 * Derived by handing the actions to `deriveAgentHookConfig` — the module that
 * owns the action-type-to-hook table **and** the prerequisite that any enabled
 * browser hook forces `interactions` on — and then keeping only the keys this
 * adapter is entitled to speak about. Nothing is hand-mapped here, which is
 * what keeps a change to that policy from having to be repeated in this file.
 *
 * @param actions The actions this adapter accepted.
 * @returns The subset of {@link BROWSER_PERFORMANCE_HOOK_KEYS} the actions arm,
 * in tuple order.
 */
function hookKeysFor(
  actions: readonly InstrumentationAction[],
): readonly BrowserPerformanceHookKey[] {
  if (actions.length === 0) {
    return [];
  }

  const derived: AgentHookConfig = deriveAgentHookConfig(actions);

  return BROWSER_PERFORMANCE_HOOK_KEYS.filter((key) => derived[key]);
}

/**
 * This adapter's contribution to the page agent's hook configuration.
 *
 * Only the keys that are actually **on** are present. A `false` would be
 * indistinguishable from "off" in a merge that spreads contributions, and this
 * adapter has no business turning another adapter's hook off; the complete,
 * seven-flag configuration is assembled by the installer through
 * `deriveAgentHookConfig` over every installed action.
 *
 * @param keys The hook keys that were armed.
 * @returns The partial configuration; empty when nothing was armed.
 */
function agentHookContribution(
  keys: readonly BrowserPerformanceHookKey[],
): Partial<AgentHookConfig> {
  const hooks: Partial<AgentHookConfig> = {};

  for (const key of keys) {
    hooks[key] = true;
  }

  return hooks;
}

/**
 * The developer-facing hook names for a set of hook keys: sorted, de-duplicated
 * and stable.
 *
 * Reproducibility matters because this list lands in `instrumentation.ready`
 * and is rendered by both user interfaces: two installs of the same plan must
 * produce the same list, whatever order the installer happened to hand the
 * actions over in.
 *
 * @param keys The hook keys that were armed.
 * @returns The hook names.
 */
function runtimeHookNames(keys: readonly BrowserPerformanceHookKey[]): string[] {
  const names = new Set<string>();

  for (const key of keys) {
    for (const hook of SIGNAL_DESCRIPTORS[key].hooks) {
      names.add(hook);
    }
  }

  return [...names].sort(compareText);
}

// ---------------------------------------------------------------------------
// Anchor selection
// ---------------------------------------------------------------------------

/**
 * The component a handler's binding site sits inside, when the graph recorded
 * one.
 *
 * Resolved through the `handles` edge, which the event-handler extractor
 * directs **component → handler**, so the enclosing component is an *incoming*
 * neighbour. Where a handler is bound in more than one component the lowest
 * node id wins, which is the canonical order the graph returns neighbours in
 * and therefore reproducible.
 *
 * @param graph The code graph.
 * @param handlerId The handler node's id.
 * @returns The component node, or `undefined` when the binding sits outside
 * every component (markup at module scope, for instance).
 */
function enclosingComponent(
  graph: CodeGraph,
  handlerId: string,
): CodeNodeOf<'component'> | undefined {
  for (const neighbor of graph.neighbors(handlerId, { kind: 'handles', direction: 'in' })) {
    if (neighbor.kind === 'component') {
      return neighbor;
    }
  }

  return undefined;
}

/**
 * The anchor for one handler node, or `undefined` when none resolves.
 *
 * Two routes, in the order AAP §0.7.1's brief states:
 *
 * 1. **A named handler** — bound by reference, so the graph positioned the node
 *    at the handler's *own declaration* and recorded the declared identifier.
 *    That `(file, symbol)` is where "open source" should land, so it is
 *    preferred whenever `hasSymbol` confirms the file declares it.
 * 2. **An inline arrow, or a reference the graph could not resolve to a
 *    declaration** — there is no function to name, so the enclosing component's
 *    own symbol anchors the action instead, and the rationale says so.
 *
 * `hasSymbol` is the gate in both routes: it answers only for a node that
 * *declares* a name, so a handler node's `symbol` — which may name a parameter,
 * a destructured prop or a declaration in another module — cannot affirm
 * itself. Skipping a candidate it denies is what keeps `../feasibility.ts` from
 * having to reject this adapter's proposal as `symbol-not-found`.
 *
 * @param handler The handler node.
 * @param graph The code graph.
 * @param queries The bounded query surface.
 * @returns The anchor, or `undefined` when neither route resolves.
 */
function anchorForHandler(
  handler: CodeNodeOf<'handler'>,
  graph: CodeGraph,
  queries: CodeQueries,
): AnchorCandidate | undefined {
  const handlerSymbol = handler.symbol ?? handler.name;

  if (
    !handler.data.inline &&
    isUsableActionPath(handler.file) &&
    queries.hasSymbol(handler.file, handlerSymbol)
  ) {
    return {
      file: handler.file,
      symbol: handlerSymbol,
      line: handler.line,
      provenance: 'named-handler',
      event: handler.data.event,
      nodeIds: [handler.id],
    };
  }

  const component = enclosingComponent(graph, handler.id);

  if (
    component !== undefined &&
    isUsableActionPath(component.file) &&
    queries.hasSymbol(component.file, component.name)
  ) {
    return {
      file: component.file,
      symbol: component.name,
      line: component.line,
      provenance: 'enclosing-component',
      event: handler.data.event,
      nodeIds: [handler.id, component.id],
    };
  }

  return undefined;
}

/**
 * The anchor for one component node, or `undefined` when it does not resolve.
 *
 * The documented fallback for a project whose graph holds no usable handler
 * binding at all: interaction and performance observation is **document-wide**,
 * so it does not require a named handler, and a component is still a real,
 * graph-derived place to attribute the action to.
 *
 * @param component The component node.
 * @param queries The bounded query surface.
 * @returns The anchor, or `undefined`.
 */
function anchorForComponent(
  component: CodeNodeOf<'component'>,
  queries: CodeQueries,
): AnchorCandidate | undefined {
  if (!isUsableActionPath(component.file) || !queries.hasSymbol(component.file, component.name)) {
    return undefined;
  }

  return {
    file: component.file,
    symbol: component.name,
    line: component.line,
    provenance: 'component',
    event: undefined,
    nodeIds: [component.id],
  };
}

/**
 * Every anchor the graph offers, handler bindings first.
 *
 * The component fallback is used **only** when no handler produced an anchor,
 * so a project with handlers proposes handler-derived anchors and a project
 * without them still gets document-wide observation rather than an empty plan.
 *
 * @param graph The code graph.
 * @param queries The bounded query surface.
 * @returns The candidates, in the graph's canonical node order.
 */
function collectAnchors(graph: CodeGraph, queries: CodeQueries): AnchorCandidate[] {
  const candidates: AnchorCandidate[] = [];

  for (const handler of graph.nodesByKind('handler')) {
    const anchor = anchorForHandler(handler, graph, queries);

    if (anchor !== undefined) {
      candidates.push(anchor);
    }
  }

  if (candidates.length > 0) {
    return candidates;
  }

  for (const component of graph.nodesByKind('component')) {
    const anchor = anchorForComponent(component, queries);

    if (anchor !== undefined) {
      candidates.push(anchor);
    }
  }

  return candidates;
}

/**
 * Resolves one name through the graph and records what it reached.
 *
 * `findByName` is the resolution route rather than a string comparison against
 * node names: it is bounded, ranked and deterministic, and it is what makes a
 * name from the understanding into *graph* evidence (AAP §0.5.4).
 *
 * @param name The name to resolve.
 * @param queries The bounded query surface.
 * @param limit How many matches to consider.
 * @param ids Accumulator for matched node ids.
 * @param declarations Accumulator for matched `file\0name` declarations.
 * @param kinds Restrict the lookup to these node kinds, when given.
 */
function resolveName(
  name: string,
  queries: CodeQueries,
  limit: number,
  ids: Set<string>,
  declarations: Set<string>,
  kinds?: readonly CodeNodeKind[],
): void {
  const matches =
    kinds === undefined
      ? queries.findByName(name, { limit })
      : queries.findByName(name, { kinds, limit });

  for (const match of matches) {
    ids.add(match.nodeId);
    declarations.add(anchorKey(match.file, match.name));
  }
}

/**
 * Builds the evidence index from the understanding.
 *
 * Three tiers of evidence, resolved in the order they narrow:
 *
 * 1. **Components the understanding named.** This is where a selected element
 *    arrives: the component chain the page agent resolved for `$0` reaches an
 *    adapter as `component` entities on the understanding (the
 *    {@link InstrumentationContext} carries no selected target of its own), and
 *    each such component's `handles` edges name the handlers bound inside it.
 * 2. **Any other entity**, whatever its kind — a function, hook, symbol or
 *    file — resolved through `findByName` without a kind filter.
 * 3. **The search hints**, which exist precisely for a name the graph has no
 *    declaration for and which therefore resolve the same way but rank lower.
 *
 * An `'selector'` or `'url'` entity contributes nothing here on purpose: a CSS
 * locator and an absolute URL are not declarations, so resolving them through a
 * name index would only produce coincidental matches. They still reach the
 * planner as part of the understanding, and the URL half is the route adapter's
 * evidence rather than this adapter's.
 *
 * @param understanding The validated Stage 1 artifact.
 * @param graph The code graph.
 * @param queries The bounded query surface.
 * @param limit How many matches one lookup may consider.
 * @returns The evidence index.
 */
function buildEvidence(
  understanding: ProblemUnderstanding,
  graph: CodeGraph,
  queries: CodeQueries,
  limit: number,
): EvidenceIndex {
  const componentIds = new Set<string>();
  const entityIds = new Set<string>();
  const entityDeclarations = new Set<string>();
  const hintIds = new Set<string>();
  const hintDeclarations = new Set<string>();

  for (const entity of understanding.entities) {
    if (entity.kind === 'component') {
      const componentDeclarations = new Set<string>();
      const matchedComponents = new Set<string>();

      resolveName(
        entity.name,
        queries,
        limit,
        matchedComponents,
        componentDeclarations,
        COMPONENT_KINDS,
      );

      for (const componentId of matchedComponents) {
        componentIds.add(componentId);

        // The handlers bound inside a named component are evidence of the same
        // strength as the component itself: an interaction question about a
        // component is a question about what its markup binds.
        for (const handler of graph.neighbors(componentId, { kind: 'handles', direction: 'out' })) {
          componentIds.add(handler.id);
        }
      }
    }

    if (entity.kind === 'selector' || entity.kind === 'url') {
      continue;
    }

    resolveName(entity.name, queries, limit, entityIds, entityDeclarations);
  }

  for (const hint of understanding.searchHints) {
    resolveName(hint, queries, limit, hintIds, hintDeclarations);
  }

  return { componentIds, entityIds, entityDeclarations, hintIds, hintDeclarations };
}

/**
 * The evidence tier of one anchor.
 *
 * @param candidate The anchor.
 * @param evidence The resolved evidence index.
 * @returns One of the four tier constants.
 */
function tierOf(candidate: AnchorCandidate, evidence: EvidenceIndex): number {
  const key = anchorKey(candidate.file, candidate.symbol);

  if (candidate.nodeIds.some((id) => evidence.componentIds.has(id))) {
    return TIER_COMPONENT;
  }

  if (
    evidence.entityDeclarations.has(key) ||
    candidate.nodeIds.some((id) => evidence.entityIds.has(id))
  ) {
    return TIER_ENTITY;
  }

  if (
    evidence.hintDeclarations.has(key) ||
    candidate.nodeIds.some((id) => evidence.hintIds.has(id))
  ) {
    return TIER_HINT;
  }

  return TIER_NONE;
}

/**
 * Ranks, narrows, de-duplicates and caps the anchors.
 *
 * Ordering is total and locale-free — evidence tier, then project-relative
 * file, then declaration line, then symbol — so two runs over one graph produce
 * identical arrays. Narrowing is the step that makes evidence matter: when
 * anything at all was evidenced, the unevidenced anchors are dropped rather
 * than merely sorted behind the others, which is what keeps a question about
 * one component from proposing a plan naming every handler in the project.
 *
 * @param candidates Every resolvable anchor.
 * @param evidence The resolved evidence index.
 * @param maxTargets How many anchors to keep.
 * @returns The selected anchors, best first.
 */
function selectAnchors(
  candidates: readonly AnchorCandidate[],
  evidence: EvidenceIndex,
  maxTargets: number,
): RankedAnchor[] {
  const ranked: RankedAnchor[] = candidates.map((candidate) => ({
    ...candidate,
    tier: tierOf(candidate, evidence),
  }));

  const evidenced = ranked.filter((candidate) => candidate.tier !== TIER_NONE);
  const pool = evidenced.length > 0 ? evidenced : ranked;

  pool.sort(
    (left, right) =>
      left.tier - right.tier ||
      compareText(left.file, right.file) ||
      left.line - right.line ||
      compareText(left.symbol, right.symbol),
  );

  const selected: RankedAnchor[] = [];
  const seen = new Set<string>();

  for (const candidate of pool) {
    if (selected.length >= maxTargets) {
      break;
    }

    const key = anchorKey(candidate.file, candidate.symbol);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    selected.push(candidate);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Rationales
//
// One generic sentence per provenance, naming the graph relationship that
// selected the anchor, with graph-derived values interpolated. No application's
// vocabulary appears as a literal, and nothing is asserted that the graph did
// not record (AAP §0.5.4).
// ---------------------------------------------------------------------------

/**
 * Why an interaction-tracking action names this anchor.
 *
 * @param anchor The selected anchor.
 * @returns The rationale.
 */
function interactionRationale(anchor: RankedAnchor): string {
  const event = anchor.event ?? 'user';

  switch (anchor.provenance) {
    case 'named-handler':
      return `Selected from the code graph: "${anchor.symbol}" is declared in ${anchor.file} and bound as a named "${event}" handler, so the page agent's capture-phase listener records the interaction that runs it as the root of the trace. No file is modified.`;

    case 'enclosing-component':
      return `Selected from the code graph: the "${event}" handler bound inside "${anchor.symbol}" (${anchor.file}) has no declaration of its own, so its enclosing component anchors the action; the interaction itself is observed document-wide by the page agent's capture-phase listener. No file is modified.`;

    case 'component':
      return `Selected from the code graph: no event-handler binding resolved to a declaration, so the component "${anchor.symbol}" in ${anchor.file} anchors document-wide interaction observation by the page agent's capture-phase listener. No file is modified.`;
  }
}

/**
 * Why the single performance-tracking action names this anchor.
 *
 * The wording is deliberately explicit that the anchor is provenance only:
 * `PerformanceObserver` reports long tasks, resource, navigation and paint
 * entries for the whole document, and a developer reading a plan that named a
 * file would otherwise reasonably expect the observation to be scoped to it.
 *
 * @param anchor The highest-ranked anchor.
 * @returns The rationale.
 */
function performanceRationale(anchor: RankedAnchor): string {
  return `Performance and error observation is document-wide: the page agent's observers report long tasks, resource, navigation and paint entries plus page errors for the whole document, so "${anchor.symbol}" in ${anchor.file} records where this action came from rather than limiting what is observed. No file is modified.`;
}

/**
 * Builds one action for an anchor.
 *
 * Every identity field is supplied here rather than left to normalisation —
 * the id from `newActionId()`, this adapter's own id, and the `'runtime'` mode
 * the claim table states — so the proposal a developer sees and the resolution
 * the registry would compute are the same thing.
 *
 * @param anchor The selected anchor.
 * @param type The action type.
 * @param rationale The developer-facing reason.
 * @returns The action.
 */
function buildAction(
  anchor: RankedAnchor,
  type: BrowserPerformanceActionType,
  rationale: string,
): InstrumentationAction {
  return {
    id: newActionId(),
    file: anchor.file,
    symbol: anchor.symbol,
    type,
    adapter: BROWSER_PERFORMANCE_ADAPTER_ID,
    mode: BROWSER_PERFORMANCE_ADAPTER_CLAIMS[type],
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Signal intent
// ---------------------------------------------------------------------------

/**
 * Whether the understanding asks for anything this adapter's interaction hook
 * supplies.
 *
 * Driven by the closed {@link CaptureSignal} vocabulary and never by free text:
 * `interactions` is requested directly, and it is *implied* by every other
 * browser signal, because the interaction span is what a render, a state
 * transition or a request is attributed to. That is the same prerequisite
 * `deriveAgentHookConfig` applies when it forces the flag on — stated here as
 * intent so the plan a developer reads explains why the listener is in it.
 *
 * @param understanding The validated Stage 1 artifact.
 * @returns `true` when an interaction-tracking action belongs in the plan.
 */
function wantsInteractionSignal(understanding: ProblemUnderstanding): boolean {
  return understanding.signalsNeeded.some((signal) => BROWSER_SIGNALS.includes(signal));
}

/**
 * Whether the understanding asks for a performance entry or a page error.
 *
 * @param understanding The validated Stage 1 artifact.
 * @returns `true` when a performance-tracking action belongs in the plan.
 */
function wantsPerformanceSignal(understanding: ProblemUnderstanding): boolean {
  return understanding.signalsNeeded.some((signal) => signal === 'perf' || signal === 'errors');
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Creates the browser-performance adapter.
 *
 * A factory rather than a singleton because `createAdapterRegistry` constructs
 * the built-ins, and because the two bounds are injectable. Calling it has **no
 * side effect**: no module state is written, no clock is read, nothing is
 * registered and nothing is opened. The returned object is frozen and holds no
 * mutable field, so it is safe to share across sessions — every fact a method
 * needs arrives on its {@link InstrumentationContext}.
 *
 * @param options Bounds, a clock and a construction-time logger; every member
 * is optional and defaulted from {@link BROWSER_PERFORMANCE_ADAPTER_LIMITS}.
 * @returns The adapter.
 */
export function createBrowserPerformanceAdapter(
  options: BrowserPerformanceAdapterOptions = {},
): BrowserPerformanceAdapter {
  const limits: BrowserPerformanceAdapterLimits = Object.freeze({
    maxTargets: clampPositiveInteger(
      options.maxTargets,
      BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxTargets,
      'maxTargets',
      options.logger,
    ),
    staleReportAfterMs: clampPositiveInteger(
      options.staleReportAfterMs,
      BROWSER_PERFORMANCE_ADAPTER_LIMITS.staleReportAfterMs,
      'staleReportAfterMs',
      options.logger,
    ),
    maxEvidenceMatches: BROWSER_PERFORMANCE_ADAPTER_LIMITS.maxEvidenceMatches,
  });

  const optionClock = options.now;

  /**
   * The availability verdict both `install` and `readiness` answer from, so the
   * two can never disagree about the same session.
   *
   * @param context The session's context.
   * @returns The verdict.
   */
  const assess = (context: InstrumentationContext): AgentAvailability =>
    assessBrowserAgent(
      context.readiness.browserAgent,
      readClock([context.now, optionClock]),
      limits.staleReportAfterMs,
    );

  /**
   * The actions of a call that belong to this adapter.
   *
   * Filtered on both the adapter id and the claimed type: the installer hands
   * over the subset a normalised plan resolved to this adapter, and an action
   * that names something else is another adapter's work to do and this
   * adapter's to ignore silently.
   *
   * @param actions Everything the caller passed.
   * @returns The accepted subset, in the caller's order.
   */
  const accept = (actions: readonly InstrumentationAction[]): InstrumentationAction[] =>
    actions.filter(
      (action) =>
        action.adapter === BROWSER_PERFORMANCE_ADAPTER_ID &&
        Object.prototype.hasOwnProperty.call(BROWSER_PERFORMANCE_ADAPTER_CLAIMS, action.type),
    );

  const adapter: BrowserPerformanceAdapter = {
    id: BROWSER_PERFORMANCE_ADAPTER_ID,
    claims: BROWSER_PERFORMANCE_ADAPTER_CLAIMS,
    hookKeys: BROWSER_PERFORMANCE_HOOK_KEYS,
    limits,

    canHandle(context: InstrumentationContext): boolean {
      // Capability, not readiness: whether a page agent has reported is
      // `readiness`'s question, and answering it here would make a project this
      // adapter can serve look like one it cannot.
      //
      // A handler binding is the strongest evidence that this project has
      // interactions worth timing; a component alone is enough, because
      // interaction and performance observation is document-wide and needs no
      // named handler. Both are O(1) bucket reads on the graph.
      return (
        context.graph.nodesByKind('handler').length > 0 ||
        context.graph.nodesByKind('component').length > 0
      );
    },

    createPlan(
      context: InstrumentationContext,
      understanding: ProblemUnderstanding,
    ): Promise<InstrumentationAction[]> {
      const wantsInteraction = wantsInteractionSignal(understanding);
      const wantsPerformance = wantsPerformanceSignal(understanding);

      if (isAborted(context.signal) || (!wantsInteraction && !wantsPerformance)) {
        return Promise.resolve([]);
      }

      const evidenceLimit = Math.min(limits.maxEvidenceMatches, context.queries.limits.maxResults);
      const evidence = buildEvidence(understanding, context.graph, context.queries, evidenceLimit);
      const anchors = selectAnchors(
        collectAnchors(context.graph, context.queries),
        evidence,
        limits.maxTargets,
      );

      const actions: InstrumentationAction[] = [];

      if (wantsInteraction) {
        for (const anchor of anchors) {
          // Cancellation is honoured between actions and never inside one, so
          // an aborted plan is a shorter plan rather than a partial action.
          if (isAborted(context.signal)) {
            break;
          }

          actions.push(buildAction(anchor, 'interaction-tracking', interactionRationale(anchor)));
        }
      }

      // At most ONE performance action, whatever the anchor count: the
      // observers are document-wide, so one action per component would inflate
      // the plan a developer reads without observing anything more.
      const top = anchors[0];

      if (wantsPerformance && top !== undefined && !isAborted(context.signal)) {
        actions.push(buildAction(top, 'perf-tracking', performanceRationale(top)));
      }

      context.logger.debug('browser-performance adapter proposed actions', {
        adapter: BROWSER_PERFORMANCE_ADAPTER_ID,
        sessionId: context.sessionId,
        planVersion: context.planVersion,
        anchors: anchors.length,
        actions: actions.length,
        interaction: wantsInteraction,
        performance: wantsPerformance,
      });

      return Promise.resolve(actions);
    },

    install(
      actions: readonly InstrumentationAction[],
      context: InstrumentationContext,
    ): Promise<InstallResult> {
      const accepted = accept(actions);
      const requested = hookKeysFor(accepted);
      const availability = assess(context);
      const armed = availability.kind === 'absent' ? [] : requested;

      const unavailable: UnavailableSignal[] =
        availability.kind === 'absent'
          ? requested.map((key) => ({
              signal: key,
              reason: agentAbsentReason(key),
              hint: AGENT_ABSENT_HINT,
            }))
          : [];

      context.logger.debug('browser-performance adapter install', {
        adapter: BROWSER_PERFORMANCE_ADAPTER_ID,
        sessionId: context.sessionId,
        planVersion: context.planVersion,
        accepted: accepted.length,
        agent: availability.kind,
        armed: armed.length,
        unavailable: unavailable.length,
      });

      const result: InstallResult = {
        adapterId: BROWSER_PERFORMANCE_ADAPTER_ID,
        // Runtime mode: nothing is written, so nothing is journaled and no
        // modification record exists to report (AAP §0.5.1).
        applied: [],
        runtimeHooks: runtimeHookNames(armed),
        unavailable,
        // The key is omitted entirely when nothing was armed, which is what
        // `../adapter.ts` defines as "no contribution" — and, under
        // `exactOptionalPropertyTypes`, is a different thing from present and
        // `undefined`.
        ...(armed.length === 0 ? {} : { agentHooks: agentHookContribution(armed) }),
      };

      // No `serverSignals`: none of this adapter's signals exists in the dev
      // server process.
      return Promise.resolve(result);
    },

    remove(session: AdapterRemoveRequest, context: InstrumentationContext): Promise<RemoveResult> {
      // Nothing to undo on disk, and nothing to look up: a runtime-mode adapter
      // journals no record, so `session.records` is never this adapter's to
      // unwind and a repeat call is a no-op that reports the same state.
      //
      // On a reconcile the hooks of that session no longer exist — the page
      // document and the service worker's arming of it are both gone — so there
      // is nothing to claim was detached. On a session end or a rollback the
      // service returns the page agent to dormant with an all-false
      // `agent.config`, which detaches the listener, the observers and the error
      // handlers rather than idling them (AAP §0.5.1).
      const disabled =
        session.reason === 'reconcile' ? [] : runtimeHookNames(BROWSER_PERFORMANCE_HOOK_KEYS);

      context.logger.debug('browser-performance adapter relinquished runtime hooks', {
        adapter: BROWSER_PERFORMANCE_ADAPTER_ID,
        sessionId: session.sessionId,
        reason: session.reason,
        disabled: disabled.length,
      });

      return Promise.resolve({
        adapterId: BROWSER_PERFORMANCE_ADAPTER_ID,
        restored: [],
        conflicts: [],
        runtimeHooksDisabled: disabled,
      });
    },

    readiness(context: InstrumentationContext): Promise<Readiness> {
      const nowMs = readClock([context.now, optionClock]);
      const availability = assessBrowserAgent(
        context.readiness.browserAgent,
        nowMs,
        limits.staleReportAfterMs,
      );

      const signals: ReadinessSignal[] = BROWSER_PERFORMANCE_HOOK_KEYS.map((key) => {
        if (availability.kind === 'absent') {
          const status: ReadinessStatus = 'unavailable';

          return {
            signal: key,
            status,
            reason: agentAbsentReason(key),
            hint: AGENT_ABSENT_HINT,
          };
        }

        if (availability.kind === 'stale') {
          const status: ReadinessStatus = 'degraded';

          return {
            signal: key,
            status,
            reason: agentStaleReason(key, availability.ageMs),
            hint: AGENT_STALE_HINT,
          };
        }

        const status: ReadinessStatus = 'available';

        return { signal: key, status };
      });

      // `buildReadiness` owns the `ready` derivation — no row `'unavailable'` —
      // so it is never recomputed here, and the clock is passed through so a
      // suite can assert an exact `checkedAt`.
      return Promise.resolve(
        buildReadiness({
          adapter: BROWSER_PERFORMANCE_ADAPTER_ID,
          signals,
          now: () => nowMs,
        }),
      );
    },
  };

  return Object.freeze(adapter);
}
