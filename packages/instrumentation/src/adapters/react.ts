/**
 * The **React adapter**: the runtime-mode adapter that arms the page agent's
 * fiber hook so renders, commits, state transitions and the component-tree
 * snapshot become evidence.
 *
 * It is the first of the six built-ins of AAP §0.1.3, and it claims two of the
 * eight action types of `../schema/plan.ts` — `'react-render-tracking'` and
 * `'state-tracking'` — both `'runtime'`. That word carries the whole design of
 * this file (AAP §0.5.1): **nothing here writes to a developer's project.**
 * It imports nothing from the patch layer, makes no filesystem call, constructs
 * no `ModificationRecord` and journals nothing;
 * {@link InstallResult.applied} is always an empty array, and the only thing an
 * install produces is a statement about which hooks were armed in the page.
 * Cleanup is correspondingly cheap: the service sends `agent.config` with every
 * flag false and the agent detaches — there is nothing on disk to restore.
 *
 * ## What it does, in one paragraph
 *
 * Given the validated problem understanding of the pipeline's first stage, it
 * selects component **targets from the code graph** — never from a name it
 * recognises (AAP §0.5.4) — and proposes one action per target per requested
 * signal. When those actions come back to be installed, it maps them onto the
 * page agent's hook configuration through the derivation in
 * `../schema/readiness.ts`, reports the hooks it armed in the developer's own
 * words, and turns the browser facts the service observed into the graceful
 * degradation of AAP §0.5.5 — including the one message that matters most here:
 * a page whose React loaded *before* the fiber hook was installed can be fixed
 * by a single reload, and the hint says so.
 *
 * ## Why every target comes out of the graph
 *
 * AAP §0.5.4 forbids the shortcut this product exists to disprove. So the only
 * inputs to selection are structured: the entities and search hints of
 * {@link ProblemUnderstanding} (which is where a selected element's component
 * chain arrives once Stage 1 has resolved it into `kind: 'component'` entities,
 * most relevant first), a selected-element chain the caller carried on the
 * context directly (see {@link readSelectedTargetChain}), the capture signals
 * that understanding asks for, and the code graph itself. The raw question never
 * reaches this file, no component, provider, hook or route name appears as a
 * literal in it, and `scripts/check-no-hardcoding.mjs` loads this module with
 * ts-morph on every CI run to keep that true.
 *
 * ## Determinism
 *
 * Two runs over the same graph and the same understanding produce identical
 * proposals apart from freshly minted action ids: candidates are ranked by
 * evidence tier, then client-first, then project-relative path, then declaration
 * position, then name, then node id — a total order, compared byte-wise rather
 * than by locale, for the reason `../schema/readiness.ts` gives about
 * `localeCompare`. Hook names are sorted and de-duplicated, so an
 * `instrumentation.ready` payload for the same install is byte-identical.
 *
 * ## No module-load side effects
 *
 * Everything below is a declaration or a pure function, and the adapter itself
 * is constructed by {@link createReactAdapter} — a factory the registry calls
 * *inside* `createAdapterRegistry`, never at module load. There is no singleton,
 * no mutable module state, no clock read and no I/O, which is what keeps
 * `package.json`'s `sideEffects: false` honest through this file.
 *
 * ## What it must not import
 *
 * The adapter registry module imports the adapters, so this file may not import
 * it back — that cycle is why {@link REACT_ADAPTER_ID} and
 * {@link REACT_ADAPTER_CLAIMS} are exported for the registry to read rather than
 * looked up from it. Nor may it import the installer that calls it, the cleanup
 * module, the patch layer, any package above this one in the layering of
 * AAP §0.2.2, or any platform builtin: a runtime adapter that reached for the
 * filesystem would be a contradiction in terms. The import list below is
 * therefore the complete one, and the colocated suite asserts it by reading this
 * source — which is also why this documentation states each forbidden module by
 * description rather than by specifier.
 */

import type { CodeNode, CodeNodeOf } from '@debuggen/code-analysis';
import { isSafeRelativePath, newActionId, normalizePosix } from '@debuggen/shared';
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
import { buildReadiness, deriveAgentHookConfig } from '../schema/readiness.js';
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
// The two exports `../registry.ts` reads. They exist so that adapter identity
// stays a single source of truth in the registry while the *claim* — which
// action types this adapter installs, and how — stays beside the implementation
// that honours it. The registry composes its `PlanAdapterResolver` from them;
// nothing else may restate either fact.
// ---------------------------------------------------------------------------

/**
 * This adapter's registered id: the value carried by every action's `adapter`
 * field, by {@link InstallResult.adapterId} and by {@link Readiness.adapter}.
 *
 * A literal type rather than a widened `string`, so a mismatch with
 * `../registry.ts`'s `ADAPTER_IDS` entry is a compile error there rather than a
 * plan whose actions resolve to an adapter the installer cannot look up.
 */
export const REACT_ADAPTER_ID = 'react' as const;

/** The literal type of {@link REACT_ADAPTER_ID}. */
export type ReactAdapterId = typeof REACT_ADAPTER_ID;

/**
 * The action types this adapter claims, in the order they are considered when
 * a proposal is built.
 *
 * Render tracking first: the component-tree snapshot and every render event hang
 * off it, and a state transition is recorded *by* the same commit walk, so an
 * action list that leads with renders reads the way the evidence arrives.
 */
export const REACT_ADAPTER_ACTION_TYPES = [
  'react-render-tracking',
  'state-tracking',
] as const satisfies readonly InstrumentationActionType[];

/** One action type this adapter claims. */
export type ReactAdapterActionType = (typeof REACT_ADAPTER_ACTION_TYPES)[number];

/**
 * The claim table: which action types this adapter installs, and how.
 *
 * Both are `'runtime'`, and that is the AAP §0.5.1 decision restated as data —
 * React renders, commits, state transitions and the component tree are all
 * observable through the fiber hook the page agent installs at
 * `document_start`, so none of them is a reason to modify a file.
 *
 * `../registry.ts` resolves an action's `adapter` and `mode` for
 * `normalizePlan` from exactly this object, and this adapter's own `install`
 * reads its mode from it too, so the two cannot disagree.
 */
export const REACT_ADAPTER_CLAIMS = Object.freeze({
  'react-render-tracking': 'runtime',
  'state-tracking': 'runtime',
} as const satisfies Readonly<Record<ReactAdapterActionType, InstrumentationMode>>);

/** Widened view of {@link REACT_ADAPTER_ACTION_TYPES}, for membership tests. */
const CLAIMED_ACTION_TYPES: readonly string[] = REACT_ADAPTER_ACTION_TYPES;

/**
 * Whether an action type is one this adapter claims.
 *
 * The predicate `install` filters with: the installer may legitimately hand an
 * adapter a broader list than it claimed, and an action of another adapter's
 * type is ignored rather than refused.
 *
 * @param value Any string, typically an action's `type`.
 * @returns `true` when the type is a member of
 * {@link REACT_ADAPTER_ACTION_TYPES}, narrowing it.
 */
export function isReactAdapterActionType(value: string): value is ReactAdapterActionType {
  return CLAIMED_ACTION_TYPES.includes(value);
}

// ---------------------------------------------------------------------------
// The hooks and signals this adapter owns
//
// Three names, and each of them is *both* an `AgentHookConfig` key and a
// `CaptureSignal` — the two vocabularies coincide for the browser tier, which
// is why `deriveAgentHookConfig` can be asked what a set of actions arms and the
// answer read straight back as the list of signals a gap is reported against.
// ---------------------------------------------------------------------------

/**
 * The page-agent hook keys this adapter contributes: the fiber hook, the state
 * walk that rides on it, and the component-tree snapshot.
 *
 * Order follows `AGENT_HOOK_KEYS` in `../schema/readiness.ts`, which is the
 * AAP's browser-signal order and therefore the order a readiness report reads
 * in. `interactions` is deliberately absent even though an armed browser hook
 * forces it on: that rule belongs to `deriveAgentHookConfig`, which the
 * installer applies across every adapter's contribution, and restating it here
 * would make this adapter speak for a hook it does not own.
 */
export const REACT_ADAPTER_HOOK_KEYS = [
  'react',
  'state',
  'componentTree',
] as const satisfies readonly AgentHookKey[];

/** One hook key this adapter owns. */
export type ReactAdapterHookKey = (typeof REACT_ADAPTER_HOOK_KEYS)[number];

/**
 * The same three names, read as capture signals.
 *
 * What a {@link Readiness} row and an {@link UnavailableSignal} are reported
 * against. Aliased rather than re-spelled so the hook set and the signal set
 * cannot drift apart.
 */
export const REACT_ADAPTER_SIGNALS: readonly CaptureSignal[] = REACT_ADAPTER_HOOK_KEYS;

/**
 * The developer-facing name of each hook, as it appears in
 * {@link InstallResult.runtimeHooks}, in {@link RemoveResult.runtimeHooksDisabled}
 * and therefore in the editor's "Preparing instrumentation" checklist
 * (AAP §0.1.2) and the panel's session summary.
 *
 * Stable strings: they are shown to a developer and stored on a session record,
 * so a reopened session must name its hooks the way the run that armed them
 * did. They describe the *evidence* rather than the mechanism, because that is
 * what a reader of the checklist is deciding about.
 */
export const REACT_ADAPTER_RUNTIME_HOOK_LABELS = Object.freeze({
  react: 'React renders and commits',
  state: 'React state transitions',
  componentTree: 'React component tree snapshot',
} as const satisfies Readonly<Record<ReactAdapterHookKey, string>>);

/**
 * Which capture signals make this adapter propose render tracking.
 *
 * `componentTree` counts as a render signal because the snapshot is
 * reconstructed from the commit the fiber hook walks: a question that asks for
 * the tree is asking for the commits it is built from.
 */
const RENDER_REQUEST_SIGNALS: readonly CaptureSignal[] = ['react', 'componentTree'];

/** Which capture signals make this adapter propose state-transition tracking. */
const STATE_REQUEST_SIGNALS: readonly CaptureSignal[] = ['state'];

// ---------------------------------------------------------------------------
// Bounds and options
//
// Every bound is a named constant and every knob is injected with a default, so
// a suite asserts against the declaration instead of a magic number, and this
// module still needs no configuration to work.
// ---------------------------------------------------------------------------

/** The bounds this adapter applies to its own proposals. */
export interface ReactAdapterLimits {
  /**
   * How many component targets a proposal carries when the caller states no
   * preference.
   *
   * Eight, which is a render-storm neighbourhood — a component, the components
   * that render it and the ones it renders — rather than an inventory of a
   * project. Two claimed types means at most sixteen actions, comfortably inside
   * the sixty-four targets `../schema/plan.ts` accepts, and small enough that
   * the editor's plan list stays readable.
   */
  readonly defaultMaxTargets: number;

  /** The smallest useful cap; a lower request is raised to it. */
  readonly minMaxTargets: number;

  /**
   * The largest cap this adapter will honour, whatever it is asked for.
   *
   * Thirty-two targets is sixty-four actions, which is exactly the plan
   * schema's target ceiling: a cap beyond it could only produce a plan that
   * normalisation would reject.
   */
  readonly maxMaxTargets: number;

  /** How many rendering parents and rendered children one hop contributes. */
  readonly maxNeighbours: number;

  /** How many names from the understanding are resolved against the graph. */
  readonly maxSeedNames: number;

  /** How many graph matches one name may contribute. */
  readonly maxNameMatches: number;
}

/**
 * The bounds in force, frozen so a test can assert against them and no caller
 * can quietly move them.
 */
export const REACT_ADAPTER_LIMITS: ReactAdapterLimits = Object.freeze({
  defaultMaxTargets: 8,
  minMaxTargets: 1,
  maxMaxTargets: 32,
  maxNeighbours: 8,
  maxSeedNames: 12,
  maxNameMatches: 8,
});

/**
 * What {@link createReactAdapter} accepts.
 *
 * Injected knobs only, each fully defaulted: nothing here is required, and
 * nothing here is read from the environment. The adapter is a pure function of
 * its context and these options, which is what lets `./react.test.ts` exercise
 * the real adapter with no browser, no dev server and no working tree.
 */
export interface ReactAdapterOptions {
  /**
   * How many component targets one proposal may carry.
   *
   * Clamped into
   * `[REACT_ADAPTER_LIMITS.minMaxTargets, REACT_ADAPTER_LIMITS.maxMaxTargets]`
   * rather than trusted, so a caller cannot ask for a proposal the plan schema
   * would refuse. Defaults to {@link ReactAdapterLimits.defaultMaxTargets}.
   */
  readonly maxTargets?: number | undefined;

  /**
   * Clock for the `checkedAt` of a readiness report, in epoch milliseconds.
   *
   * Falls back to {@link InstrumentationContext.now} and then to
   * `buildReadiness`'s own default, so the report's timestamp comes from
   * whichever clock the caller has injected — the reason a suite can assert an
   * exact `checkedAt` without freezing time globally.
   */
  readonly now?: (() => number) | undefined;

  /**
   * A logger to use instead of {@link InstrumentationContext.logger}.
   *
   * For a caller that wants this adapter's lines under its own bindings. The
   * adapter logs at `debug` only: an install that armed the hooks is not news,
   * and a gap it could not fill is reported as data in
   * {@link InstallResult.unavailable} rather than shouted into a log.
   */
  readonly logger?: Logger | undefined;
}

/**
 * This adapter, with its identity and claim table travelling on the object.
 *
 * An intersection rather than a bare {@link InstrumentationAdapter}, because
 * `InstrumentationAdapter` deliberately declares no claims member — which
 * adapter claims which type is a fact about the registry (`../adapter.ts`
 * records why). Carrying the table here means a caller holding the adapter can
 * read what it claims without importing a second module, while the registry
 * still reads the same frozen object.
 */
export type ReactAdapter = InstrumentationAdapter & {
  /** Always {@link REACT_ADAPTER_ID}. */
  readonly id: ReactAdapterId;

  /** Always {@link REACT_ADAPTER_CLAIMS}. */
  readonly claims: typeof REACT_ADAPTER_CLAIMS;

  /** Always {@link REACT_ADAPTER_HOOK_KEYS}. */
  readonly hookKeys: typeof REACT_ADAPTER_HOOK_KEYS;
};

// ---------------------------------------------------------------------------
// Text discipline
//
// Three strings this adapter produces are validated by somebody else: an
// action's `rationale` (`../schema/plan.ts`: non-blank, at most 500 characters,
// no control characters), and a readiness row's `reason` and `hint`
// (`../schema/readiness.ts`: non-blank, at most 500 characters, single line).
// Two of them interpolate a value that came from outside this package — a
// symbol name read from a developer's source, a page URL relayed from the page
// agent — so every interpolation goes through the compactor below rather than
// being trusted to be short and printable.
// ---------------------------------------------------------------------------

/**
 * How much of an interpolated value a message may carry.
 *
 * Generous for a component name or a development URL, and small enough that
 * three of them could not push a message past the 500-character bound the two
 * schemas apply — which is the failure this constant exists to prevent, because
 * a rejected readiness row would cost the developer the recovery hint rather
 * than merely a long line.
 */
const MAX_INTERPOLATED_LENGTH = 120;

/** Matches any run of whitespace, control or format characters. */
const NON_PRINTING_RUN = /[\s\p{Cc}\p{Cf}]+/gu;

/**
 * Collapses a value to one printable line and truncates it.
 *
 * Every whitespace, control or format run becomes a single space, the result is
 * trimmed, and anything longer than `maxLength` is cut with a trailing ellipsis.
 * A tab or a line break inside a relayed URL would otherwise make a readiness
 * row fail its single-line rule, and a pathological name would push a rationale
 * past its bound — both of which would turn a legitimate degradation into a
 * rejected artifact.
 *
 * @param value The value to compact.
 * @param maxLength The maximum length of the result, in UTF-16 code units.
 * @returns The compacted value; an empty string when `value` holds nothing
 * printable.
 */
function compactText(value: string, maxLength: number): string {
  const collapsed = value.replace(NON_PRINTING_RUN, ' ').trim();

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, Math.max(maxLength - 1, 0))}…`;
}

/**
 * Orders two strings by code unit, without a locale.
 *
 * `localeCompare` is avoided for the reason `../schema/readiness.ts` records:
 * its result depends on the host's locale data, so the same graph would rank
 * candidates differently on two machines and a suite asserting an order would
 * pass or fail by environment.
 *
 * @param left First string.
 * @param right Second string.
 * @returns A negative number, zero or a positive number, as `Array#sort`
 * expects.
 */
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// The browser facts, turned into one obstacle
//
// Readiness and degradation are the same judgement asked at two moments, so
// they are computed by one function from the one source an adapter may consult:
// the `agent.ready` facts the service relayed onto the context (AAP §0.2.3).
// Nothing here polls, probes or reads the environment.
// ---------------------------------------------------------------------------

/** Which of the three things can stand between this adapter and the page. */
type ReactObstacleKind = 'agent-absent' | 'hook-installed-late' | 'react-absent';

/** One obstacle, with the words the developer will read and what it costs. */
interface ReactObstacle {
  /** Which obstacle this is. Carried for the log line, never parsed for meaning. */
  readonly kind: ReactObstacleKind;

  /**
   * Whether it keeps a capture from observing a commit.
   *
   * `true` for the two obstacles that make a commit unobservable — no page agent
   * at all, or a fiber hook installed after React had loaded — so readiness
   * holds the capture back until the obstacle is gone. An install arms nothing
   * for a hook installed late and says so; no page agent *yet* is instead the
   * usual state of a session whose tab binds after its plan installs, so the
   * hooks are armed and readiness alone waits for the agent (see `install`).
   * `false` for a page that simply has no React root *yet*: the hooks are
   * armed, they will observe the root when it mounts, and the gap is reported
   * as a narrower capture rather than a refusal (`../adapter.ts` states that
   * reading of `reactDetected`).
   */
  readonly blocking: boolean;

  /** The readiness status a row about this obstacle carries. */
  readonly status: ReadinessStatus;

  /** What was observed; reads after "Could not enable ‹signal›: ". */
  readonly reason: string;

  /** The one thing the developer can do about it. */
  readonly hint: string;
}

/**
 * Names the document an obstacle is about, when the report carried a URL.
 *
 * Returns a parenthesised, compacted clause to append to a reason, or an empty
 * string. The URL arrives query-redacted (AAP §0.5.2) and is compacted here for
 * the length and single-line rules; it is included because "no React on the
 * current document" is far more actionable when the developer can see *which*
 * document reported it.
 *
 * @param agent The page agent's latest report.
 * @returns The clause, or `''` when there is no URL to name.
 */
function describeDocument(agent: ObservedBrowserAgent): string {
  const url = agent.url === undefined ? '' : compactText(agent.url, MAX_INTERPOLATED_LENGTH);

  return url === '' ? '' : ` (${url})`;
}

/**
 * Resolves the browser facts into at most one obstacle, worst first.
 *
 * Precedence is deliberate and is the whole recovery story of AAP §0.5.5 for
 * this adapter:
 *
 * 1. **No page agent has reported** for the bound tab's current document. The
 *    developer has to open the application with the panel on it; nothing else
 *    can help.
 * 2. **The fiber hook was installed after React loaded** — the state of a page
 *    that was already open when the extension arrived. React attaches to the
 *    hook at mount, so a hook installed later observes nothing at all, and the
 *    recovery is a **single reload**, which the panel offers as one click and
 *    the service performs with `chrome.tabs.reload` on consent. This is the
 *    most important message this file produces: without it a developer waits
 *    through a capture that could never have recorded a commit.
 * 3. **No React root was found** on the current document — a legitimate answer
 *    about a legitimate page, and the only non-blocking case.
 *
 * Only the first applicable obstacle is reported, so a signal carries one
 * sentence naming one action rather than a list the developer has to triage.
 *
 * @param agent The page agent's latest report, or `undefined` when none has
 * arrived.
 * @returns The obstacle, or `undefined` when the page can be observed.
 */
function resolveBrowserObstacle(
  agent: ObservedBrowserAgent | undefined,
): ReactObstacle | undefined {
  if (agent === undefined) {
    return {
      kind: 'agent-absent',
      blocking: true,
      status: 'unavailable',
      reason:
        'no page agent has reported for the bound tab, so nothing in the page is observing React yet',
      hint: 'Open the application in a Chrome tab and open the "Debug Generator" panel in its DevTools, then try again.',
    };
  }

  if (!agent.installedBeforeReact) {
    return {
      kind: 'hook-installed-late',
      blocking: true,
      status: 'unavailable',
      reason:
        'the React hook was installed after this document had already loaded React, so its commits cannot be observed',
      hint: 'Reload the page once — the panel offers a one-click reload — so the hook is in place before React mounts.',
    };
  }

  if (!agent.reactDetected) {
    return {
      kind: 'react-absent',
      blocking: false,
      status: 'degraded',
      reason: `the page agent found no React root on the current document${describeDocument(agent)}`,
      hint: 'Navigate the bound tab to a page of the application that renders React, then capture again.',
    };
  }

  return undefined;
}

/**
 * Reports one obstacle against every signal it affects.
 *
 * One entry per signal rather than one per obstacle: the service renders
 * AAP §0.5.5's "Could not enable ‹signal›: ‹reason›" sentence per signal, and a
 * developer told that renders are unavailable while hearing nothing about the
 * component tree would be left guessing about the half that was not mentioned.
 *
 * @param signals The signals affected.
 * @param obstacle The obstacle to report.
 * @returns A fresh array the caller owns.
 */
function toUnavailableSignals(
  signals: readonly CaptureSignal[],
  obstacle: ReactObstacle,
): UnavailableSignal[] {
  return signals.map((signal) => ({
    signal,
    reason: obstacle.reason,
    hint: obstacle.hint,
  }));
}

// ---------------------------------------------------------------------------
// Target selection — the AAP §0.5.4 half of this file
//
// Every candidate is a `component` node of the code graph, and the only thing
// that varies is *why* the graph produced it. That "why" is the evidence kind
// below: it decides the candidate's rank and it becomes the action's rationale,
// so a developer reading the plan is told what the tool found rather than that
// the tool decided.
// ---------------------------------------------------------------------------

/** A `component` node of the code graph. */
type ComponentNode = CodeNodeOf<'component'>;

/** Why the graph produced a candidate. */
type EvidenceKind =
  /** The nearest component the understood question resolved to. */
  | 'target'
  /** A component whose markup renders that one — the cause of a child's re-render. */
  | 'renders-target'
  /** A component that one renders — where a render storm spends its time. */
  | 'rendered-by-target'
  /** Another component the understood question named, resolved in the graph. */
  | 'chain'
  /** A name the understood question carried that resolved to a component. */
  | 'entity'
  /** No name narrowed the question; the project's own component set. */
  | 'project';

/**
 * The rank of each evidence kind, lowest first.
 *
 * A total table rather than a `switch`, so a new evidence kind fails this
 * declaration until it says where it ranks. The one-hop neighbourhood shares a
 * tier with the rest of the resolved chain because all three are the same
 * strength of evidence — the graph related them to the component the question
 * named — and the tie is then broken by the deterministic order below.
 */
const EVIDENCE_TIERS = Object.freeze({
  target: 0,
  'renders-target': 1,
  'rendered-by-target': 1,
  chain: 1,
  entity: 2,
  project: 3,
} as const satisfies Readonly<Record<EvidenceKind, number>>);

/** One component the adapter would arm, and the evidence that selected it. */
interface TargetCandidate {
  /** The component node, carrying its file, position and client/server status. */
  readonly component: ComponentNode;

  /** Why the graph produced it. */
  readonly evidence: EvidenceKind;

  /**
   * The graph-derived name this candidate's evidence is relative to, when the
   * evidence is a relationship rather than the candidate itself.
   *
   * Interpolated into the rationale, so a developer reads "renders ‹name›"
   * rather than an unexplained extra target. `undefined` where the evidence
   * stands on its own.
   */
  readonly relatedTo: string | undefined;
}

/**
 * Whether a node is a `component` node.
 *
 * A narrowing guard rather than a cast: `nodeById` answers with the whole
 * {@link CodeNode} union, and the component payload — `isClient`, `displayName`
 * — is only readable once the kind has been checked.
 *
 * @param value Any node, or `undefined` from a lookup that missed.
 * @returns `true` when the node exists and is a component.
 */
function isComponentNode(value: CodeNode | undefined): value is ComponentNode {
  return value !== undefined && value.kind === 'component';
}

/** Whether the caller has cancelled this call. */
function isAborted(context: InstrumentationContext): boolean {
  return context.signal?.aborted === true;
}

/**
 * Resolves one name to the component nodes the graph holds for it.
 *
 * Exact first, through the graph's constant-time name index, because a name
 * that came out of another result should not be re-ranked against substring
 * matches. Only when nothing bears the name exactly does it fall back to
 * `findByName`, whose case-insensitive, prefix and substring tiers catch the
 * cases a name can legitimately differ in — a component known at runtime by a
 * display name a wrapper gave it, a name a question spelled with different
 * capitalisation.
 *
 * Both routes are graph lookups. Neither compares the name against anything
 * this repository knows (AAP §0.5.4).
 *
 * @param context The session's context.
 * @param name The name to resolve.
 * @param limits The bounds in force.
 * @returns The component nodes, in the order the graph or the ranking produced
 * them, capped at {@link ReactAdapterLimits.maxNameMatches}.
 */
function resolveComponentsByName(
  context: InstrumentationContext,
  name: string,
  limits: ReactAdapterLimits,
): readonly ComponentNode[] {
  const exact = context.graph.nodesByName(name).filter(isComponentNode);

  if (exact.length > 0) {
    return exact.slice(0, limits.maxNameMatches);
  }

  const matched: ComponentNode[] = [];

  for (const match of context.queries.findByName(name, {
    kinds: ['component'],
    limit: limits.maxNameMatches,
  })) {
    const node = context.graph.nodeById(match.nodeId);

    if (isComponentNode(node)) {
      matched.push(node);
    }
  }

  return matched;
}

/**
 * Reads a selected element's component chain off the context, if the caller put
 * one there.
 *
 * The chain is `SelectedTarget.componentChain` from `../schema/target.ts`:
 * composite component display names, **nearest ancestor first**, as the page
 * agent resolved them from the element the developer picked. It is the
 * strongest evidence this adapter can be given, which is why it is consulted
 * before the understanding's own entities.
 *
 * Read **structurally**, and that is deliberate rather than loose:
 * {@link InstrumentationContext} declares no target member, so a caller that
 * carries one — the service, which holds the session's `target?` — is
 * accommodated without this file inventing a field on a contract it does not
 * own, and the normal case of no target is simply an empty chain. Nothing is
 * trusted about the value: a non-object, a missing chain, a non-array and a
 * non-string entry all yield nothing, and every surviving name still has to
 * resolve in the code graph before it can become a target.
 *
 * @param context The session's context.
 * @returns The chain, nearest first; empty when the context carries none.
 */
function readSelectedTargetChain(context: InstrumentationContext): readonly string[] {
  const carried: unknown = (context as { readonly target?: unknown }).target;

  if (typeof carried !== 'object' || carried === null) {
    return [];
  }

  const chain: unknown = (carried as { readonly componentChain?: unknown }).componentChain;

  if (!Array.isArray(chain)) {
    return [];
  }

  const names: string[] = [];

  for (const entry of chain as readonly unknown[]) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      names.push(entry);
    }
  }

  return names;
}

/**
 * The names to try as component names, strongest evidence first.
 *
 * A selected element's chain comes first (see
 * {@link readSelectedTargetChain}), then the understanding's `kind: 'component'`
 * entities — which are where that same chain arrives when the service has
 * already folded it into Stage 1's artifact, and which the understanding's own
 * contract orders most-relevant-first. Reading both in that order means "the
 * nearest resolvable component" is a meaningful choice whichever route the
 * evidence took, and de-duplication keeps a name that arrived twice from
 * costing a slot twice.
 *
 * @param context The session's context.
 * @param understanding The validated problem understanding.
 * @param limits The bounds in force.
 * @returns The candidate names, de-duplicated and capped.
 */
function componentEntityNames(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  limits: ReactAdapterLimits,
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const push = (name: string): void => {
    if (!seen.has(name) && names.length < limits.maxSeedNames) {
      seen.add(name);
      names.push(name);
    }
  };

  for (const name of readSelectedTargetChain(context)) {
    push(name);
  }

  for (const entity of understanding.entities) {
    if (entity.kind === 'component') {
      push(entity.name);
    }
  }

  return names;
}

/**
 * Every other name the understood question carried: its remaining entities, of
 * any kind, followed by its search hints.
 *
 * Entities first because they are concrete things the question pointed at,
 * hints second because they are terms for a text search — the weaker evidence
 * of the two, and the reason they are consulted at all is the question that
 * names a component only descriptively.
 *
 * @param understanding The validated problem understanding.
 * @param limits The bounds in force.
 * @returns The seed names, de-duplicated and capped.
 */
function seedNames(
  understanding: ProblemUnderstanding,
  limits: ReactAdapterLimits,
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const push = (name: string): void => {
    if (!seen.has(name) && names.length < limits.maxSeedNames) {
      seen.add(name);
      names.push(name);
    }
  };

  for (const entity of understanding.entities) {
    push(entity.name);
  }

  for (const hint of understanding.searchHints) {
    push(hint);
  }

  return names;
}

/**
 * Selects the render-storm neighbourhood around the component the question
 * resolved to.
 *
 * The first evidence tier, and the one an excessive-render question depends on
 * (AAP §0.8.4 acceptance test 2). It takes the **nearest resolvable** component
 * from the selected element's chain and the question's component entities (see
 * {@link componentEntityNames}), then one hop each way:
 *
 * - **upward**, through `componentsRendering`, to the components whose markup
 *   renders it — "the cause of a child re-rendering is a decision its parent
 *   made", which is why that query's direction is upward;
 * - **downward**, through the graph's own `renders` edges, to the components it
 *   renders, which is where a re-render's cost is actually paid.
 *
 * Any further component the question named joins them at the same tier. A graph
 * with a single `renders` edge produces a neighbourhood of two, which is
 * exactly the shape the package's fixture corpus offers and the case this
 * function must not assume away.
 *
 * @param context The session's context.
 * @param understanding The validated problem understanding.
 * @param limits The bounds in force.
 * @returns The candidates, or an empty array when no component entity resolved.
 */
function collectNeighbourhoodCandidates(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  limits: ReactAdapterLimits,
): TargetCandidate[] {
  const resolved: ComponentNode[] = [];

  for (const name of componentEntityNames(context, understanding, limits)) {
    if (isAborted(context)) {
      break;
    }

    resolved.push(...resolveComponentsByName(context, name, limits));
  }

  const [target] = resolved;

  if (target === undefined) {
    return [];
  }

  const candidates: TargetCandidate[] = [
    { component: target, evidence: 'target', relatedTo: undefined },
  ];

  for (const parent of context.queries.componentsRendering(target.name, {
    limit: limits.maxNeighbours,
  })) {
    const node = context.graph.nodeById(parent.component.nodeId);

    if (isComponentNode(node)) {
      candidates.push({ component: node, evidence: 'renders-target', relatedTo: target.name });
    }
  }

  const children = context.graph
    .neighbors(target.id, { kind: 'renders', direction: 'out' })
    .filter(isComponentNode)
    .slice(0, limits.maxNeighbours);

  for (const child of children) {
    candidates.push({ component: child, evidence: 'rendered-by-target', relatedTo: target.name });
  }

  for (const sibling of resolved.slice(1)) {
    candidates.push({ component: sibling, evidence: 'chain', relatedTo: undefined });
  }

  return candidates;
}

/**
 * Selects components from the names the question carried, when none of its
 * component entities resolved.
 *
 * The second evidence tier: a question that named a function, a hook, a file or
 * a term rather than a component, resolved through the same query surface the
 * investigation stage uses and filtered to component declarations. Matching
 * happens inside `findByName`, which ranks its own tiers — this function never
 * compares a name against a string of its own.
 *
 * @param context The session's context.
 * @param understanding The validated problem understanding.
 * @param limits The bounds in force.
 * @returns The candidates, empty when nothing resolved.
 */
function collectEntityCandidates(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  limits: ReactAdapterLimits,
): TargetCandidate[] {
  const candidates: TargetCandidate[] = [];

  for (const name of seedNames(understanding, limits)) {
    if (isAborted(context)) {
      break;
    }

    for (const node of resolveComponentsByName(context, name, limits)) {
      candidates.push({ component: node, evidence: 'entity', relatedTo: name });
    }
  }

  return candidates;
}

/**
 * The last tier: every component the project has.
 *
 * Reached by a question that named nothing the graph could resolve — "the page
 * feels slow", asked with no element selected. Arming the project's components
 * is the honest answer there: the ranking below puts client components first,
 * the cap keeps the plan small, and the capture's own evidence then narrows what
 * the analysis talks about. Returning nothing instead would leave a render
 * question with no render evidence at all.
 *
 * @param context The session's context.
 * @returns One candidate per component node.
 */
function collectProjectCandidates(context: InstrumentationContext): TargetCandidate[] {
  return context.graph
    .nodesByKind('component')
    .map((component) => ({ component, evidence: 'project' as const, relatedTo: undefined }));
}

/**
 * Runs the three tiers in precedence order and stops at the first that answers.
 *
 * Precedence, not accumulation: a question that resolved to a component does not
 * also want every other component in the project, and the tier that answered is
 * what the rationale will explain.
 *
 * @param context The session's context.
 * @param understanding The validated problem understanding.
 * @param limits The bounds in force.
 * @returns The candidates, unranked and possibly duplicated.
 */
function collectCandidates(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  limits: ReactAdapterLimits,
): TargetCandidate[] {
  if (context.graph.nodesByKind('component').length === 0) {
    return [];
  }

  const neighbourhood = collectNeighbourhoodCandidates(context, understanding, limits);

  if (neighbourhood.length > 0) {
    return neighbourhood;
  }

  const entities = collectEntityCandidates(context, understanding, limits);

  return entities.length > 0 ? entities : collectProjectCandidates(context);
}

/**
 * Orders two candidates, totally and reproducibly.
 *
 * Evidence tier first, then **client components first** — a server component
 * never renders in the browser, so the fiber hook would see nothing of it —
 * then the project-relative path, the declaration position, the name and
 * finally the node id, which is unique within an index and therefore makes the
 * order total. Strings are compared by code unit (see {@link compareText}).
 *
 * @param left First candidate.
 * @param right Second candidate.
 * @returns A negative number, zero or a positive number.
 */
function compareCandidates(left: TargetCandidate, right: TargetCandidate): number {
  const byTier = EVIDENCE_TIERS[left.evidence] - EVIDENCE_TIERS[right.evidence];

  if (byTier !== 0) {
    return byTier;
  }

  if (left.component.data.isClient !== right.component.data.isClient) {
    return left.component.data.isClient ? -1 : 1;
  }

  const byFile = compareText(left.component.file, right.component.file);

  if (byFile !== 0) {
    return byFile;
  }

  if (left.component.line !== right.component.line) {
    return left.component.line - right.component.line;
  }

  if (left.component.column !== right.component.column) {
    return left.component.column - right.component.column;
  }

  const byName = compareText(left.component.name, right.component.name);

  return byName === 0 ? compareText(left.component.id, right.component.id) : byName;
}

/**
 * De-duplicates candidates by node, keeping the strongest evidence, then ranks
 * them.
 *
 * A component can arrive twice — the component the question named can also be
 * rendered by another component the question named — and the stronger evidence
 * is the one worth explaining to a developer. Ties keep the first arrival, which
 * is the collection order the tiers above define.
 *
 * Deliberately **uncapped**: the cap belongs after the addressability filter of
 * {@link selectAddressableCandidates}, so a node the graph cannot address
 * cannot consume a slot a real target needed.
 *
 * @param candidates The collected candidates.
 * @returns A fresh, ranked array.
 */
function rankCandidates(candidates: readonly TargetCandidate[]): TargetCandidate[] {
  const strongest = new Map<string, TargetCandidate>();

  for (const candidate of candidates) {
    const held = strongest.get(candidate.component.id);

    if (held === undefined || EVIDENCE_TIERS[candidate.evidence] < EVIDENCE_TIERS[held.evidence]) {
      strongest.set(candidate.component.id, candidate);
    }
  }

  return [...strongest.values()].sort(compareCandidates);
}

// ---------------------------------------------------------------------------
// From candidates to actions
//
// An action is shown to the developer in the editor's plan list and in the
// panel's session summary, so its rationale states what the graph found rather
// than that the tool decided. Every interpolated value is graph-derived and
// compacted; no name from any particular application is written here.
// ---------------------------------------------------------------------------

/**
 * States why the graph produced this candidate, as a clause that reads after
 * "because".
 *
 * @param candidate The selected candidate.
 * @returns The clause.
 */
function evidenceClause(candidate: TargetCandidate): string {
  const related =
    candidate.relatedTo === undefined
      ? undefined
      : compactText(candidate.relatedTo, MAX_INTERPOLATED_LENGTH);

  switch (candidate.evidence) {
    case 'target':
      return 'the understood question resolved to this component in the code graph';

    case 'renders-target':
      return related === undefined
        ? 'the code graph records it rendering the component the question resolved to'
        : `the code graph records it rendering ${related}, the component the question resolved to`;

    case 'rendered-by-target':
      return related === undefined
        ? 'the code graph records it being rendered by the component the question resolved to'
        : `the code graph records it being rendered by ${related}, the component the question resolved to`;

    case 'chain':
      return 'the understood question named this component as well, and the code graph resolved it';

    case 'entity':
      return related === undefined
        ? 'a name the understood question carried resolved to this component in the code graph'
        : `the name ${related} from the understood question resolved to this component in the code graph`;

    case 'project':
      return 'the code graph reports it among this project’s components and the question named none in particular';
  }
}

/**
 * States what an action of this type arms, as the opening clause of a
 * rationale.
 *
 * Render tracking mentions the component-tree snapshot because it arms it:
 * `../schema/readiness.ts` pairs `componentTree` with `react` so that a render
 * question keeps the structural half of its answer.
 *
 * @param type The claimed action type.
 * @returns The clause.
 */
function signalClause(type: ReactAdapterActionType): string {
  return type === 'react-render-tracking'
    ? "Render and commit tracking, with the capture's component-tree snapshot, is armed for this component through the page agent's fiber hook"
    : "State-transition tracking is armed for this component through the page agent's fiber hook";
}

/**
 * Composes an action's rationale: what is armed, and why this target was
 * chosen.
 *
 * Bounded by construction — two fixed clauses plus one compacted interpolation
 * — so it cannot approach the 500-character limit `../schema/plan.ts` applies,
 * and it carries no control character because {@link compactText} removes them
 * from the only part that did not originate here.
 *
 * @param type The claimed action type.
 * @param candidate The selected candidate.
 * @returns The rationale.
 */
function buildRationale(type: ReactAdapterActionType, candidate: TargetCandidate): string {
  return `${signalClause(type)} because ${evidenceClause(candidate)}.`;
}

/**
 * Which of this adapter's action types the understood question asks for.
 *
 * Driven off the closed {@link CaptureSignal} vocabulary and nothing else
 * (AAP §0.5.4): `signalsNeeded` is the machine-readable field Stage 3 and the
 * readiness gate consume, and the raw question never reaches this module.
 *
 * Render tracking is also proposed when the list narrows nothing at all — an
 * empty list, which the understanding's schema refuses but a caller assembling
 * one by hand could still produce — because a React adapter asked for "whatever
 * you have" should offer the signal it exists for. State tracking is proposed
 * only when a state signal is actually requested: it is the more specific
 * question of the two, and arming it unasked would add transitions to every
 * render capture.
 *
 * @param understanding The validated problem understanding.
 * @returns The claimed types to emit, in {@link REACT_ADAPTER_ACTION_TYPES}
 * order; empty when the question needs nothing of this adapter's kind.
 */
function requestedActionTypes(understanding: ProblemUnderstanding): ReactAdapterActionType[] {
  const requested: ReactAdapterActionType[] = [];
  const signals = understanding.signalsNeeded;
  const narrowed = signals.length > 0;

  if (!narrowed || signals.some((signal) => RENDER_REQUEST_SIGNALS.includes(signal))) {
    requested.push('react-render-tracking');
  }

  if (narrowed && signals.some((signal) => STATE_REQUEST_SIGNALS.includes(signal))) {
    requested.push('state-tracking');
  }

  return requested;
}

/**
 * Whether a node's file is a path an action may name.
 *
 * The graph already stores project-relative POSIX paths that satisfy
 * `isSafeRelativePath`, and `../schema/plan.ts` additionally requires the
 * *normal* form. Checking both here costs two string operations and keeps this
 * adapter from proposing an action normalisation would reject — a rejection
 * that would fail the whole plan rather than this one target.
 *
 * @param file The node's file.
 * @returns `true` when an action may carry it.
 */
function isAddressablePath(file: string): boolean {
  return file.length > 0 && isSafeRelativePath(file) && normalizePosix(file) === file;
}

/**
 * Keeps the best-ranked candidates an action could actually name, up to the
 * cap.
 *
 * Two facts are established here, and both are the graph's to state rather than
 * this module's to assume: the file is addressable, and the file **declares**
 * the symbol (`hasSymbol`, which answers only for a `symbol`, `component` or
 * `server-function` declaration). A candidate that fails either is dropped
 * rather than proposed — `../feasibility.ts` would reject it anyway, and a
 * runtime action still carries a real `(file, symbol)` anchor because that pair
 * is what a panel row links back to source.
 *
 * Filtering **before** the cap is what stops an unaddressable node from
 * starving a usable one: the cap counts targets a developer will actually be
 * shown. The scan stops as soon as the cap is full, so `hasSymbol` is asked at
 * most once per candidate considered and never once per component in a large
 * project.
 *
 * {@link InstrumentationContext.signal} is honoured between candidates, so a
 * cancelled call returns what it had rather than finishing the scan.
 *
 * @param context The session's context.
 * @param candidates The ranked candidates.
 * @param maxTargets The cap, already clamped.
 * @param logger Where the one debug line goes.
 * @returns The selected candidates, best first.
 */
function selectAddressableCandidates(
  context: InstrumentationContext,
  candidates: readonly TargetCandidate[],
  maxTargets: number,
  logger: Logger,
): TargetCandidate[] {
  const selected: TargetCandidate[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    if (selected.length >= maxTargets || isAborted(context)) {
      break;
    }

    const file = candidate.component.file;

    if (!isAddressablePath(file) || !context.queries.hasSymbol(file, candidate.component.name)) {
      skipped += 1;
      continue;
    }

    selected.push(candidate);
  }

  if (skipped > 0) {
    logger.debug('skipped component targets the code graph could not address', {
      adapter: REACT_ADAPTER_ID,
      skipped,
    });
  }

  return selected;
}

/**
 * Builds one action per selected candidate per requested type.
 *
 * Pure assembly: every fact an action carries has already been established by
 * {@link selectAddressableCandidates}, so nothing here can fail and nothing here
 * queries the graph again.
 *
 * @param candidates The selected candidates, best first.
 * @param types The types to emit per candidate.
 * @returns The actions, candidate order outermost and type order innermost.
 */
function buildActions(
  candidates: readonly TargetCandidate[],
  types: readonly ReactAdapterActionType[],
): InstrumentationAction[] {
  const actions: InstrumentationAction[] = [];

  for (const candidate of candidates) {
    for (const type of types) {
      actions.push({
        id: newActionId(),
        file: candidate.component.file,
        symbol: candidate.component.name,
        type,
        adapter: REACT_ADAPTER_ID,
        mode: REACT_ADAPTER_CLAIMS[type],
        rationale: buildRationale(type, candidate),
      });
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// From actions to hooks
//
// The action-type to hook-key table lives in `../schema/readiness.ts` and is
// asked rather than restated, so the prerequisites it encodes — state implies
// the fiber hook, render tracking implies the component-tree snapshot — hold
// here without this file knowing them.
// ---------------------------------------------------------------------------

/**
 * Which of this adapter's hooks a set of accepted actions arms.
 *
 * `deriveAgentHookConfig` answers for the whole page agent, including the
 * `interactions` flag it forces on once anything is enabled; the result is then
 * narrowed to the keys this adapter owns, because
 * {@link InstallResult.agentHooks} is a *contribution* the installer merges and
 * an adapter that reported a neighbour's key would be speaking out of turn.
 *
 * @param actions The accepted actions.
 * @returns The owned keys that are on, in {@link REACT_ADAPTER_HOOK_KEYS} order.
 */
function armedHookKeys(actions: readonly InstrumentationAction[]): ReactAdapterHookKey[] {
  const derived = deriveAgentHookConfig(actions);

  return REACT_ADAPTER_HOOK_KEYS.filter((key) => derived[key]);
}

/**
 * Names a set of hooks for a developer, sorted and de-duplicated.
 *
 * Sorted by code unit so an `instrumentation.ready` payload for the same
 * install is byte-identical on every run and on every machine, which is what
 * lets a suite assert the list rather than its contents.
 *
 * @param keys The hook keys to name.
 * @returns The labels.
 */
function hookLabels(keys: readonly ReactAdapterHookKey[]): string[] {
  const labels = new Set(keys.map((key) => REACT_ADAPTER_RUNTIME_HOOK_LABELS[key]));

  return [...labels].sort(compareText);
}

/**
 * This adapter's contribution to the page agent's hook configuration.
 *
 * Only the keys it armed, and only as `true`: a merge of several adapters'
 * partials must not let one adapter's explicit `false` overwrite another's
 * `true`, and the dormant baseline every unmentioned flag falls back to is
 * `DORMANT_AGENT_HOOK_CONFIG`, which `deriveAgentHookConfig` starts from.
 *
 * A reader that needs a **complete** {@link AgentHookConfig} — one that parses
 * against its schema, with all seven flags present — therefore spreads this
 * partial over that dormant baseline, or re-derives across every adapter's
 * accepted actions. A contribution is a statement about this adapter's hooks,
 * not a configuration for the whole agent.
 *
 * @param keys The armed hook keys.
 * @returns A fresh partial configuration; `{}` when nothing was armed.
 */
function toAgentHooks(
  keys: readonly ReactAdapterHookKey[],
): Partial<Pick<AgentHookConfig, ReactAdapterHookKey>> {
  const hooks: Partial<Record<ReactAdapterHookKey, boolean>> = {};

  for (const key of keys) {
    hooks[key] = true;
  }

  return hooks;
}

/**
 * Whether this project has anything for this adapter to arm.
 *
 * One component node is enough, and the code graph is the only source
 * consulted: it is what {@link createReactAdapter}'s `createPlan` selects from,
 * so claiming capability the planner could not act on would produce an empty
 * proposal and a readiness row about a signal with no target behind it.
 * `context.projectSummary` is deliberately *not* used as a second source for
 * the same reason — its counts describe the project, the graph describes what
 * can be addressed.
 *
 * @param context The session's context.
 * @returns `true` when the graph holds at least one component.
 */
function hasComponents(context: InstrumentationContext): boolean {
  return context.graph.nodesByKind('component').length > 0;
}

/**
 * Clamps a requested target cap into the bounds of {@link REACT_ADAPTER_LIMITS}.
 *
 * A caller's number is clamped rather than trusted or rejected: a cap of zero
 * would silently disarm the adapter, and a cap above the ceiling could only
 * produce a plan `../schema/plan.ts` would refuse. A non-finite value — the
 * shape a missing configuration takes after arithmetic — falls back to the
 * default.
 *
 * @param requested The caller's cap, if any.
 * @returns The cap in force.
 */
function clampMaxTargets(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return REACT_ADAPTER_LIMITS.defaultMaxTargets;
  }

  const floored = Math.floor(requested);

  return Math.min(
    Math.max(floored, REACT_ADAPTER_LIMITS.minMaxTargets),
    REACT_ADAPTER_LIMITS.maxMaxTargets,
  );
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Creates the React adapter.
 *
 * A factory, and deliberately not a singleton: `../registry.ts` constructs the
 * built-ins *inside* `createAdapterRegistry`, so importing this module costs a
 * consumer nothing and `package.json`'s `sideEffects: false` stays true. The
 * returned object holds no mutable state — the clamped cap and the two optional
 * overrides are the whole of its closure — so it is safe to share between
 * sessions and safe to call concurrently.
 *
 * What the five methods do, and what they refuse to do:
 *
 * - `canHandle` answers from the code graph, synchronously, and says nothing
 *   about readiness: a project with components is a project this adapter claims
 *   work in, whether or not a page agent has reported yet.
 * - `createPlan` proposes runtime actions for components the graph related to
 *   the understood question, and returns an empty array when the question needs
 *   nothing of its kind.
 * - `install` writes nothing, arms the page agent's hooks through its
 *   contribution to `agent.config`, and reports any gap as data.
 * - `remove` relinquishes those hooks; the service returns the agent to dormant
 *   by sending every flag false (AAP §0.5.1). There is nothing on disk to
 *   restore, and calling it twice is a no-op that still reports.
 * - `readiness` is a pure function of the relayed `agent.ready` facts.
 *
 * @param options Injected knobs; every one is defaulted.
 * @returns The adapter, with its claim table.
 *
 * @example
 * ```ts
 * const adapter = createReactAdapter({ maxTargets: 4 });
 * const actions = adapter.canHandle(context)
 *   ? await adapter.createPlan(context, understanding)
 *   : [];
 * ```
 */
export function createReactAdapter(options: ReactAdapterOptions = {}): ReactAdapter {
  const maxTargets = clampMaxTargets(options.maxTargets);
  const loggerOverride = options.logger;
  const clockOverride = options.now;

  /** The logger for one call: the caller's override, else the context's. */
  const loggerFor = (context: InstrumentationContext): Logger => loggerOverride ?? context.logger;

  /** The clock for one report: the override, else the context's, else none. */
  const clockFor = (context: InstrumentationContext): (() => number) | undefined =>
    clockOverride ?? context.now;

  return {
    id: REACT_ADAPTER_ID,
    claims: REACT_ADAPTER_CLAIMS,
    hookKeys: REACT_ADAPTER_HOOK_KEYS,

    canHandle(context: InstrumentationContext): boolean {
      return hasComponents(context);
    },

    createPlan(
      context: InstrumentationContext,
      understanding: ProblemUnderstanding,
    ): Promise<InstrumentationAction[]> {
      const logger = loggerFor(context);
      const types = requestedActionTypes(understanding);

      if (types.length === 0 || isAborted(context)) {
        logger.debug('proposed no React instrumentation', {
          adapter: REACT_ADAPTER_ID,
          planVersion: context.planVersion,
          requestedTypes: types.length,
          aborted: isAborted(context),
        });

        return Promise.resolve([]);
      }

      const ranked = rankCandidates(
        collectCandidates(context, understanding, REACT_ADAPTER_LIMITS),
      );
      const selected = selectAddressableCandidates(context, ranked, maxTargets, logger);
      const actions = buildActions(selected, types);

      logger.debug('proposed React runtime instrumentation', {
        adapter: REACT_ADAPTER_ID,
        planVersion: context.planVersion,
        candidates: ranked.length,
        targets: selected.length,
        actions: actions.length,
        evidence: selected[0]?.evidence,
      });

      return Promise.resolve(actions);
    },

    install(
      actions: readonly InstrumentationAction[],
      context: InstrumentationContext,
    ): Promise<InstallResult> {
      const logger = loggerFor(context);

      // The installer may hand over a broader list than this adapter claimed;
      // an action belonging to another adapter is ignored, not refused.
      const accepted = actions.filter(
        (action) => action.adapter === REACT_ADAPTER_ID && isReactAdapterActionType(action.type),
      );
      const armed = armedHookKeys(accepted);

      if (armed.length === 0) {
        logger.debug('armed no React hooks: this plan asked for none', {
          adapter: REACT_ADAPTER_ID,
          offered: actions.length,
          accepted: accepted.length,
        });

        return Promise.resolve({
          adapterId: REACT_ADAPTER_ID,
          applied: [],
          runtimeHooks: [],
          unavailable: [],
          agentHooks: {},
        });
      }

      const signals: readonly CaptureSignal[] = armed;
      const obstacle = resolveBrowserObstacle(context.readiness.browserAgent);

      // No page agent has reported *yet* is not a refusal. The editor creates a
      // session before the panel binds its tab, so a plan usually installs
      // before the bound tab's agent reports; arming edits no file, the capture
      // arms these hooks from the plan's runtime actions in any case, and the
      // readiness gate (`readiness` below) holds the capture back until the
      // agent reports. Refusing here would fail every plan made of page hooks
      // alone — a render or state question's — before its tab could bind.
      const awaitingAgent = obstacle?.kind === 'agent-absent';

      // A blocking obstacle on a page whose agent did report means a commit
      // could not be observed at all, so nothing is armed and every affected
      // signal says why (AAP §0.5.5). This is a successful result: the capture
      // proceeds with what other adapters enabled, and only the installer
      // judges "nothing at all".
      if (obstacle !== undefined && obstacle.blocking && !awaitingAgent) {
        logger.debug('could not arm the React hooks', {
          adapter: REACT_ADAPTER_ID,
          obstacle: obstacle.kind,
          accepted: accepted.length,
          signals: signals.length,
        });

        return Promise.resolve({
          adapterId: REACT_ADAPTER_ID,
          applied: [],
          runtimeHooks: [],
          unavailable: toUnavailableSignals(signals, obstacle),
          agentHooks: {},
        });
      }

      logger.debug('armed the React hooks', {
        adapter: REACT_ADAPTER_ID,
        accepted: accepted.length,
        hooks: armed.length,
        degraded: awaitingAgent ? undefined : obstacle?.kind,
        awaitingAgent,
      });

      return Promise.resolve({
        adapterId: REACT_ADAPTER_ID,
        // Always empty: this adapter is runtime-mode and writes no bytes
        // anywhere (AAP §0.5.1).
        applied: [],
        runtimeHooks: hookLabels(armed),
        // An agent that has not reported yet is readiness's to report, as a
        // gap that closes when it does; only an obstacle on a reporting page
        // narrows what the armed hooks can record.
        unavailable:
          obstacle === undefined || awaitingAgent ? [] : toUnavailableSignals(signals, obstacle),
        agentHooks: toAgentHooks(armed),
      });
    },

    remove(session: AdapterRemoveRequest, context: InstrumentationContext): Promise<RemoveResult> {
      const logger = loggerFor(context);

      // Nothing to undo on disk, so there is nothing that can fail or conflict:
      // the hooks stop when the service sends `agent.config` with every flag
      // false, and this result states which hooks that is about. Idempotent by
      // construction — a second call, or a session that installed nothing,
      // reports the same thing.
      logger.debug('relinquished the React hooks', {
        adapter: REACT_ADAPTER_ID,
        sessionId: session.sessionId,
        planVersion: session.planVersion,
        reason: session.reason,
      });

      return Promise.resolve({
        adapterId: REACT_ADAPTER_ID,
        restored: [],
        conflicts: [],
        runtimeHooksDisabled: hookLabels(REACT_ADAPTER_HOOK_KEYS),
      });
    },

    readiness(context: InstrumentationContext): Promise<Readiness> {
      const clock = clockFor(context);

      // `BuildReadinessInput.now` is declared without `| undefined`, so under
      // `exactOptionalPropertyTypes` the key is spread rather than passed.
      const clockInput = clock === undefined ? {} : { now: clock };

      // An adapter that claims nothing in this project is ready with no rows,
      // which is a different statement from one whose signals are unavailable.
      if (!hasComponents(context)) {
        return Promise.resolve(
          buildReadiness({ adapter: REACT_ADAPTER_ID, signals: [], ...clockInput }),
        );
      }

      const obstacle = resolveBrowserObstacle(context.readiness.browserAgent);
      const signals = REACT_ADAPTER_SIGNALS.map((signal): ReadinessSignal =>
        obstacle === undefined
          ? { signal, status: 'available' }
          : {
              signal,
              status: obstacle.status,
              reason: obstacle.reason,
              hint: obstacle.hint,
            },
      );

      return Promise.resolve(buildReadiness({ adapter: REACT_ADAPTER_ID, signals, ...clockInput }));
    },
  };
}
