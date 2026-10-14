/**
 * The **fetch adapter**: the built-in {@link InstrumentationAdapter} that
 * claims the browser's request signal.
 *
 * It claims exactly one action type — `'fetch-tracking'` — in `'runtime'` mode,
 * and maps it to the page agent's `fetch` hook key. Nothing here writes to a
 * developer's project: the `fetch` and `XMLHttpRequest` observation is
 * installed by `packages/telemetry/src/browser/fetch.ts` inside the page when
 * the service sends `agent.config` (AAP §0.5.1), so
 * {@link InstallResult.applied} is always empty, `../patch/**` is never
 * imported and no filesystem path is ever touched.
 *
 * ## Why this one hook matters more than its size suggests
 *
 * The hook this adapter arms is the seam that makes browser-to-server
 * correlation possible. The agent's request patch injects the W3C
 * `traceparent` header on a same-origin request while an interaction window is
 * open, the framework's own tracer extracts it on the way in, and the two
 * halves of the trace therefore share one trace id (AAP §0.4.2). Without this
 * signal a capture still fills with events and a timeline still renders — as
 * two unrelated trees. That is also why `./schema/readiness.ts`'s
 * `deriveAgentHookConfig` forces the `interactions` flag on whenever any
 * browser hook is enabled, and why this adapter forwards that derivation's
 * answer rather than hand-mapping its type to a key.
 *
 * It is likewise what the duplicate-request investigation rests on
 * (AAP §0.8.2's third case): the events this hook produces are what
 * `packages/telemetry/src/aggregate/requests.ts` groups, and the initiators
 * named below are what the panel's request table links back to source.
 *
 * ## The one rule this file exists to keep
 *
 * This adapter's evidence *is* URLs, which makes it the place AAP §0.5.4 bites
 * hardest: **no route path, host, endpoint or query-parameter name may appear
 * as a string literal anywhere in this module.** Every URL handled here
 * arrives as data — `ApiCallNodeData.url`, recorded by the call-site
 * extractor of `@debuggen/code-analysis`, or a route path minted by the route
 * map — and is only ever interpolated into prose a developer reads. A target exists because the code graph has a call site for it, never
 * because a name was recognised. `scripts/check-no-hardcoding.mjs` reads this
 * file with ts-morph and the colocated `./fetch.test.ts` scans its source for
 * URL-shaped literals, so the rule is mechanically enforced from two
 * directions.
 *
 * Route matching is likewise not re-derived here. `../route-map.ts` in
 * `@debuggen/code-analysis` owns the single URL ↔ route-file algorithm in the
 * product; this module asks it (through `queries.routeForUrl`, falling back to
 * `routeMap.resolve`) and preserves the `SourceLocation` it minted, including
 * its `resolvedBy: 'route-map'` provenance. A second matcher here would be a
 * second answer to a question that already has one.
 *
 * ## What it contributes, per method
 *
 * - {@link FetchAdapter.canHandle} — synchronous and graph-only: does this
 *   project issue any client request at all?
 * - {@link FetchAdapter.createPlan} — a small, bounded set of
 *   `'fetch-tracking'` actions anchored on the initiators the graph found. The
 *   hook is **document-wide**, so one action per call site would be a plan a
 *   developer cannot read and a promise this adapter does not make; the anchors
 *   exist to say *what will be traced* and *where to look*.
 * - {@link FetchAdapter.install} — no writes, a stable hook list, the derived
 *   page-agent contribution, and any gap reported as data (AAP §0.5.5).
 * - {@link FetchAdapter.readiness} — decided from the observed `agent.ready`
 *   facts alone. No probe, no port, no environment read.
 * - {@link FetchAdapter.remove} — nothing to undo on disk; the hook is
 *   relinquished when the service sends an all-false `agent.config`.
 *
 * ## Boundaries
 *
 * The server-side outgoing-request span is **not** claimed here.
 * `ServerAgentSignals` carries a `fetch` key of its own for the dev-server
 * preload's `http.client` spans, and that belongs to the framework adapter's
 * preload contribution; this module contributes no `serverSignals` at all. The
 * two producers are armed independently, which is why the signal name appears
 * in both vocabularies (see `BROWSER_CAPTURE_SIGNALS` in
 * `../schema/readiness.ts`).
 *
 * Importing this module has no side effect: it declares types, frozen
 * constants and pure functions, and the adapter is constructed by
 * {@link createFetchAdapter} when a registry asks for one.
 */

import type {
  ApiCallNodeData,
  CodeNode,
  CodeNodeKind,
  CodeNodeOf,
  HttpMethodName,
} from '@debuggen/code-analysis';
import { isSafeRelativePath, newActionId, noopLogger } from '@debuggen/shared';
import type { Logger, SourceLocation } from '@debuggen/shared';

import type {
  AdapterRemoveRequest,
  InstallResult,
  InstrumentationAdapter,
  InstrumentationContext,
  RemoveResult,
  UnavailableSignal,
} from '../adapter.js';
import { actionIdentityKey } from '../schema/plan.js';
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
} from '../schema/readiness.js';
import type { ProblemUnderstanding, SelectedTarget } from '../schema/target.js';

// ---------------------------------------------------------------------------
// Identity and claim declaration
//
// The single place this adapter's id, action type, install mode, capture signal
// and page-agent hook key are written. `../registry.ts` resolves an action's
// `adapter` and `mode` for `normalizePlan` from {@link FETCH_ADAPTER_CLAIMS},
// so a claim stated twice — here and in the registry — is a claim that can
// drift; it is stated once, here, and imported there.
// ---------------------------------------------------------------------------

/**
 * This adapter's registered identity.
 *
 * A literal type rather than a widened `string`, so the `adapter` field of
 * every action this module builds, {@link InstallResult.adapterId} and
 * {@link Readiness.adapter} are all statically the same value. It matches the
 * corresponding member of `../registry.ts`'s `ADAPTER_IDS` and this module's
 * file name, and it is stable across versions: a stored plan or a modification
 * record read back after an upgrade names the adapter that produced it.
 */
export const FETCH_ADAPTER_ID = 'fetch';

/**
 * The capture signal this adapter claims, as a one-element tuple.
 *
 * The browser half of the signal name only. `CaptureSignal`'s `fetch` member
 * covers the page's `fetch`/`xhr` events *and* the preload's `http.client`
 * spans, and `SERVER_CAPTURE_SIGNALS` carries the same name for that second
 * producer — see this module's note on boundaries. A tuple rather than a bare
 * constant because a readiness report and an unavailable row both iterate the
 * signals an adapter claims, and iterating one shape keeps the two reports
 * from disagreeing.
 */
export const FETCH_CAPTURE_SIGNALS = Object.freeze([
  'fetch',
] as const) satisfies readonly CaptureSignal[];

/**
 * The page-agent hook keys this adapter contributes.
 *
 * Exactly one: the `fetch` key of `AgentHookConfig`, which arms the patched
 * `fetch` and `XMLHttpRequest` and the trace-context injection that travels
 * with them. The `interactions` key that the derivation in
 * `../schema/readiness.ts` forces on alongside it is that module's policy and
 * is not claimed here.
 */
export const FETCH_AGENT_HOOK_KEYS = Object.freeze([
  'fetch',
] as const) satisfies readonly AgentHookKey[];

/**
 * One action type an adapter claims, and how it installs it.
 *
 * The shape `../registry.ts` reads to answer "which adapter handles this action
 * type, and in which mode?" while a plan is being normalised. Declared here
 * rather than in the registry for the reason AAP §0.4.2 gives: an adapter is
 * the thing that knows whether its signal can be satisfied by a runtime hook,
 * so the mode belongs beside the implementation that honours it.
 */
export interface AdapterClaim {
  /** The action type claimed. */
  readonly type: InstrumentationActionType;

  /** How an action of that type is installed — and therefore whether a developer's file is touched. */
  readonly mode: InstrumentationMode;

  /** The capture signal an action of that type collects. */
  readonly signal: CaptureSignal;
}

/**
 * What this adapter claims: `'fetch-tracking'`, in `'runtime'` mode, for the
 * `fetch` capture signal.
 *
 * Frozen and exported so the registry, the planner's capability catalog and
 * `./fetch.test.ts` all read one declaration. `'runtime'` is not a
 * configuration choice: the page agent already observes requests, so there is
 * nothing an in-place patch could add and no reason to write into a working
 * tree for this signal (AAP §0.5.1).
 */
export const FETCH_ADAPTER_CLAIMS = Object.freeze([
  Object.freeze({
    type: 'fetch-tracking',
    mode: 'runtime',
    signal: 'fetch',
  }),
] as const) satisfies readonly AdapterClaim[];

/**
 * The hooks this adapter arms, named for a developer to read.
 *
 * These are the strings that reach the editor's "Preparing instrumentation"
 * checklist and `instrumentation.ready`'s `runtimeHooks` (AAP §0.1.2 Step 8),
 * so they describe observable behaviour rather than module names: the request
 * observation itself, and the trace-context header that makes the browser and
 * server halves of a trace join. Sorted by code unit and free of any URL, path
 * or project name.
 */
export const FETCH_RUNTIME_HOOK_LABELS: readonly string[] = Object.freeze([
  'Network tracing',
  'Trace context propagation',
]);

/** The claimed action type, extracted once so no comparison restates the literal. */
const FETCH_ACTION_TYPE: InstrumentationActionType = FETCH_ADAPTER_CLAIMS[0].type;

/** The claimed install mode, extracted once for the same reason. */
const FETCH_ACTION_MODE: InstrumentationMode = FETCH_ADAPTER_CLAIMS[0].mode;

/** The claimed capture signal, extracted once for the same reason. */
const FETCH_SIGNAL: CaptureSignal = FETCH_CAPTURE_SIGNALS[0];

/** The node kind this adapter's candidates are drawn from. */
const API_CALL_NODE_KIND = 'api-call';

/** The edge kind whose origin is a call site's owner, per the cascade in `api-calls.ts`. */
const CALLS_EDGE_KIND = 'calls';

// ---------------------------------------------------------------------------
// Limits and options
//
// Every bound this module applies is a named, exported number, and every knob
// is injected with a default. Nothing here reads an environment variable or a
// configuration file: an adapter is a pure function of what it was handed.
// ---------------------------------------------------------------------------

/** The bounds {@link createFetchAdapter} applies. See {@link FETCH_ADAPTER_LIMITS}. */
export interface FetchAdapterLimits {
  /**
   * How many actions one plan proposal may contain by default.
   *
   * Small on purpose. The hook is document-wide, so a second action arms
   * nothing a first one did not; the actions exist to tell a developer which
   * initiators the graph found, and a plan of forty rows is a plan nobody
   * reads.
   */
  readonly maxTargets: number;

  /** The smallest cap an injected {@link FetchAdapterOptions.maxTargets} may request. */
  readonly minTargets: number;

  /** The largest cap an injected {@link FetchAdapterOptions.maxTargets} may request. */
  readonly maxTargetsCeiling: number;

  /**
   * How many of the highest-ranked literal-URL candidates are cross-referenced
   * against the route map.
   *
   * A bound rather than "all of them" because a large application can hold
   * hundreds of call sites and a capability probe must not become a repository
   * traversal. Candidates past the bound keep {@link FetchInitiator.route}
   * absent, which reads as "not cross-referenced", and the order the bound is
   * applied in is the deterministic rank below.
   */
  readonly maxRouteResolutions: number;

  /** How many seed names — component names, entity names, search hints — are resolved while narrowing. */
  readonly maxSeedQueries: number;

  /** How many graph matches one seed name may contribute. */
  readonly maxSeedMatches: number;

  /**
   * The longest rationale this adapter composes.
   *
   * Below `../schema/plan.ts`'s own 500-character bound, so a rationale this
   * module truncates is still a rationale that schema accepts.
   */
  readonly maxRationaleLength: number;

  /** The longest run of interpolated data — a path, a symbol, a method — inside a rationale. */
  readonly maxProseValueLength: number;
}

/**
 * The default bounds, frozen.
 *
 * Exported because `./fetch.test.ts` asserts the emitted action count against
 * {@link FetchAdapterLimits.maxTargets} rather than against a number it
 * restates, and because a reader deciding whether to raise a cap should be able
 * to see every cap at once.
 */
export const FETCH_ADAPTER_LIMITS: FetchAdapterLimits = Object.freeze({
  maxTargets: 3,
  minTargets: 1,
  maxTargetsCeiling: 12,
  maxRouteResolutions: 64,
  maxSeedQueries: 12,
  maxSeedMatches: 8,
  maxRationaleLength: 480,
  maxProseValueLength: 120,
});

/**
 * The injected knobs {@link createFetchAdapter} accepts, all optional and all
 * defaulted.
 *
 * Deliberately nothing about a project, a session or a signal: those arrive on
 * the {@link InstrumentationContext} of every call, which is what lets one
 * registered adapter instance serve every session and what keeps its answers
 * reproducible in a suite.
 */
export interface FetchAdapterOptions {
  /**
   * How many actions a plan proposal may contain.
   *
   * Clamped into
   * `[FETCH_ADAPTER_LIMITS.minTargets, FETCH_ADAPTER_LIMITS.maxTargetsCeiling]`
   * and rounded down; a value that is not a finite number is ignored in favour
   * of the default. Clamping rather than throwing because this is a cosmetic
   * bound on a plan's length, and a caller that asked for something
   * unreasonable should still get a working adapter — the adjustment is
   * reported through {@link FetchAdapterOptions.logger} at `debug`.
   */
  readonly maxTargets?: number | undefined;

  /**
   * The clock a readiness report is stamped with, when the context carries
   * none.
   *
   * `InstrumentationContext.now` wins when it is present — it is the session's
   * clock and the one a suite injects per call — and this is the
   * construction-time fallback. Present so a registry can pin time for every
   * adapter it builds at once.
   */
  readonly now?: (() => number) | undefined;

  /**
   * Where the factory reports an adjusted option.
   *
   * Construction-time only: every other line this adapter logs goes to
   * `InstrumentationContext.logger`, which is session-scoped and is what a
   * developer's log actually carries. Defaults to `noopLogger`.
   */
  readonly logger?: Logger | undefined;
}

/** The options after defaulting and clamping — the shape the adapter closes over. */
interface ResolvedFetchAdapterOptions {
  readonly maxTargets: number;
  readonly now?: (() => number) | undefined;
}

/**
 * Applies {@link FETCH_ADAPTER_LIMITS} to the caller's options.
 *
 * @param options The caller's options, possibly absent or partially stated.
 * @returns Fully-defaulted options. A `maxTargets` outside the limits is
 * clamped and reported at `debug`; a non-finite one falls back to the default.
 */
function resolveOptions(options: FetchAdapterOptions | undefined): ResolvedFetchAdapterOptions {
  const logger = options?.logger ?? noopLogger;
  const requested = options?.maxTargets;
  let maxTargets = FETCH_ADAPTER_LIMITS.maxTargets;

  if (requested !== undefined) {
    if (Number.isFinite(requested)) {
      maxTargets = Math.min(
        Math.max(Math.floor(requested), FETCH_ADAPTER_LIMITS.minTargets),
        FETCH_ADAPTER_LIMITS.maxTargetsCeiling,
      );
    }

    if (maxTargets !== requested) {
      logger.debug('fetch adapter clamped its target cap', {
        adapter: FETCH_ADAPTER_ID,
        requested,
        applied: maxTargets,
        min: FETCH_ADAPTER_LIMITS.minTargets,
        max: FETCH_ADAPTER_LIMITS.maxTargetsCeiling,
      });
    }
  }

  return options?.now === undefined ? { maxTargets } : { maxTargets, now: options.now };
}

// ---------------------------------------------------------------------------
// Initiator discovery
//
// A request initiator is one `api-call` node plus the three facts a plan needs
// about it: the owner declaration an action can be addressed at, whether its
// target is a literal the route map can resolve, and the route that answers it
// when one does. Everything below reads the graph and the two query surfaces
// on the context and nothing else.
// ---------------------------------------------------------------------------

/**
 * The route that answers a literal request target, as the route map resolved
 * it.
 *
 * Every field is forwarded from `@debuggen/code-analysis` unchanged — in
 * particular {@link FetchInitiatorRoute.location}, which keeps the
 * `resolvedBy: 'route-map'` provenance and the confidence that route minted.
 * Re-stamping it here would claim a resolution route this module did not
 * perform.
 */
export interface FetchInitiatorRoute {
  /** The route path, as `../route-map.ts` spells it: POSIX, leading slash, bracket segments intact. */
  readonly routePath: string;

  /** The route module, project-relative POSIX. */
  readonly file: string;

  /** The methods the route module declares. */
  readonly methods: readonly HttpMethodName[];

  /** Where to open the route, exactly as the route map minted it. */
  readonly location: SourceLocation;
}

/**
 * Where an action's anchor symbol came from.
 *
 * - `'owner'` — the declaration the `calls` edge starts at: the handler, route
 *   handler, server function or module-level symbol the call site sits inside.
 *   This is the normal answer and the one a developer expects to see.
 * - `'module'` — a declaration in the initiator's own file, used when the
 *   graph's owner cascade fell through to the file node (a call site with no
 *   addressable enclosing declaration anywhere up the chain). The hook is
 *   document-wide, so the anchor is a place to look rather than a scope; the
 *   rationale says so in as many words.
 */
export type FetchAnchorKind = 'owner' | 'module';

/**
 * One request initiator the code graph recorded, ranked and cross-referenced.
 *
 * **Never de-duplicated by URL.** Two call sites that request the same path are
 * two nodes in the graph and two initiators here, because telling one
 * initiator from another is the whole of the duplicate-request investigation
 * (AAP §0.8.2's third case): a collapse here would throw the answer away
 * before the analysis starts.
 *
 * Exported as data so the same cross-reference can be read by a suite, by the
 * planning stage's capability catalog and — for the route half — by the
 * framework adapter's own server-span planning, without any of them repeating
 * the traversal.
 */
export interface FetchInitiator {
  /** The `api-call` node's opaque graph id. Compare it; never parse it. */
  readonly nodeId: string;

  /** The call site's file: project-relative POSIX, as the graph spells it. */
  readonly file: string;

  /** The call site's 1-based line. */
  readonly line: number;

  /** The call site's 1-based column. */
  readonly column: number;

  /**
   * The declaration an action for this initiator is anchored on, affirmed by
   * `queries.hasSymbol(file, symbol)`.
   *
   * Absent when no declaration in this file answers that lookup — an inline
   * arrow in markup whose enclosing declaration is function-local, for
   * instance. Such an initiator is still evidence, and still appears in this
   * list; it simply cannot carry a plan action, because `../feasibility.ts`
   * would reject one as `symbol-not-found`.
   */
  readonly symbol?: string | undefined;

  /** Where {@link FetchInitiator.symbol} came from. Absent when there is no symbol. */
  readonly anchor?: FetchAnchorKind | undefined;

  /** The graph id of the node the `calls` edge starts at, when the graph recorded one. */
  readonly ownerNodeId?: string | undefined;

  /** The kind of that owner node, which is what the rank below orders on. */
  readonly ownerKind?: CodeNodeKind | undefined;

  /**
   * The request target, present only when the call site wrote a fully static
   * string.
   *
   * Recorded by the extractor as the literal's decoded value, never a
   * reassembled or normalised form, which is what makes a route match sound.
   */
  readonly url?: string | undefined;

  /** Whether the target is computed at run time, in which case no literal was recorded. */
  readonly dynamic: boolean;

  /** The method the extractor normalised against the shared vocabulary, when it recorded one. */
  readonly method?: string | undefined;

  /**
   * The route in this project that answers {@link FetchInitiator.url}.
   *
   * Absent for a dynamic target (nothing to match), for a literal no route
   * answers (a third-party endpoint), and for a candidate past
   * {@link FetchAdapterLimits.maxRouteResolutions}.
   */
  readonly route?: FetchInitiatorRoute | undefined;
}

/**
 * How specific an owner declaration is, lowest first.
 *
 * The order of the owner cascade in the call-site extractor of
 * `@debuggen/code-analysis`: a handler is the most
 * specific thing a request can be attributed to and the one a developer
 * recognises from the page, and a file node is the least. `component` sits
 * between the declaration kinds because the cascade reaches a component only
 * through its `symbol` node; it is listed so the table is total over the kinds
 * an owner can have and no kind falls into the fallback by accident.
 */
const OWNER_KIND_RANK: Readonly<Record<CodeNodeKind, number>> = Object.freeze({
  handler: 0,
  'api-route': 1,
  'server-function': 2,
  component: 3,
  symbol: 4,
  'api-call': 5,
  'db-call': 6,
  file: 7,
});

/** The rank of an initiator whose owner the graph did not record. */
const UNKNOWN_OWNER_RANK = 99;

/** Matches a query string or a fragment, so a target can be reduced to its path for prose. */
const QUERY_OR_FRAGMENT = /[?#]/u;

/** The highest code point treated as blank — ASCII space and every C0 control. */
const BLANK_CODE_POINT_MAX = 0x20;

/** The first code point of the C1 control range, which a rationale must not carry. */
const C1_CONTROL_MIN = 0x7f;

/** The last code point of that range. */
const C1_CONTROL_MAX = 0x9f;

/** The shape of an HTTP method name this module is willing to interpolate into prose. */
const METHOD_SHAPE = /^[A-Za-z]{3,8}$/u;

/**
 * Whether one code point must not survive into a developer-facing sentence.
 *
 * Tested by code point rather than by a character class, the way
 * `../schema/plan.ts` tests the same thing: a regular expression carrying
 * literal control characters is both unreadable and a lint failure
 * (`no-control-regex`), and the interesting ranges are two comparisons.
 *
 * @param code The code point.
 * @returns `true` for a blank or a control character.
 */
function isProseNoise(code: number): boolean {
  return code <= BLANK_CODE_POINT_MAX || (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX);
}

/**
 * Reduces a value the graph recorded to something safe to interpolate into a
 * developer-facing sentence.
 *
 * Three things happen, in order: a query string or fragment is dropped, so a
 * parameter value written at a call site never travels into a plan (AAP §0.5.2
 * keeps captured query values out of everything downstream, and a plan is read
 * in the same places); whitespace and control characters are collapsed, because
 * `../schema/plan.ts` refuses a control character in a rationale and both user
 * interfaces render it on one line; and the result is truncated.
 *
 * @param value The recorded value — a route path, a literal target, a symbol.
 * @param maxLength The longest result to return.
 * @returns The sanitised value, possibly empty when nothing legible remained.
 */
function sanitizeForProse(value: string, maxLength: number): string {
  const path = value.split(QUERY_OR_FRAGMENT)[0] ?? '';
  let collapsed = '';

  for (const character of path) {
    if (isProseNoise(character.codePointAt(0) ?? 0)) {
      if (collapsed.length > 0 && !collapsed.endsWith(' ')) {
        collapsed += ' ';
      }

      continue;
    }

    collapsed += character;
  }

  const trimmed = collapsed.trimEnd();

  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
}

/**
 * Resolves the owner node of one `api-call` node through its `calls` edge.
 *
 * The edge's direction is the contract: `from` is the owner the extractor's
 * cascade chose — handler, route, server function, module-level symbol or, when
 * nothing else was addressable, the file — and `to` is the call site. Only the
 * first edge is read: a call site has exactly one owner, and a graph that
 * recorded two would be reporting one relationship twice, which is a defect to
 * see rather than to average over.
 *
 * @param context The session's context.
 * @param nodeId The `api-call` node's id.
 * @returns The owner node, or `undefined` when the graph recorded no `calls`
 * edge into this call site.
 */
function ownerOf(context: InstrumentationContext, nodeId: string): CodeNode | undefined {
  const edges = context.graph.incoming(nodeId, CALLS_EDGE_KIND);
  const edge = edges[0];

  return edge === undefined ? undefined : context.graph.nodeById(edge.from);
}

/**
 * The symbol names that could anchor an action for one call site, most specific
 * first.
 *
 * Derived from the owner the `calls` edge named, then from the enclosing symbol
 * the extractor recorded on the call node itself. Two kinds are deliberately
 * read narrowly:
 *
 * - an `api-route` node's `name` is its **route path**, not a declaration, so
 *   only its `symbol` is considered;
 * - a `handler` node's `symbol` names the function *where this file declares
 *   it*, which is exactly the addressable form, while its `name` may be a
 *   derived label for an inline function — so the symbol is preferred and the
 *   name is kept only as a second chance.
 *
 * Nothing here decides whether a name exists: every candidate is put to
 * `queries.hasSymbol` by the caller, which is the only authority on that and
 * the same authority `../feasibility.ts` and the patcher consult.
 *
 * @param node The `api-call` node.
 * @param owner Its owner node, when the graph recorded one.
 * @returns Candidate names, de-duplicated, in preference order.
 */
function anchorCandidates(
  node: CodeNodeOf<typeof API_CALL_NODE_KIND>,
  owner: CodeNode | undefined,
): readonly string[] {
  const candidates: string[] = [];

  const add = (value: string | undefined): void => {
    if (value !== undefined && value.trim().length > 0 && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  if (owner !== undefined) {
    add(owner.symbol);

    if (owner.kind !== 'api-route' && owner.kind !== 'file' && owner.kind !== API_CALL_NODE_KIND) {
      add(owner.name);
    }
  }

  add(node.symbol);

  return candidates;
}

/**
 * A declaration in the initiator's own file that an action can be addressed at.
 *
 * The fallback for the one case the owner cascade cannot help with: a call site
 * whose every enclosing declaration is function-local, which the cascade
 * attributes to the file node. Without an anchor the request signal would be
 * dropped from the plan entirely and the capture would lose the tier that joins
 * browser and server traces — a silent loss, and the worst outcome available.
 *
 * Preference is exported declarations first, then position, then the graph's
 * canonical order, so the anchor is the most legible declaration in the module
 * rather than an arbitrary one. Every candidate is still put to
 * `queries.hasSymbol`, so this cannot invent a name.
 *
 * @param context The session's context.
 * @param file The initiator's file, project-relative POSIX.
 * @returns A declared, addressable symbol name, or `undefined` when the file
 * declares none.
 */
function moduleAnchorFor(context: InstrumentationContext, file: string): string | undefined {
  const declarations = context.graph
    .nodesByFile(file)
    .filter(
      (candidate) =>
        candidate.kind === 'symbol' ||
        candidate.kind === 'component' ||
        candidate.kind === 'server-function',
    )
    .sort((left, right) => {
      const exported = Number(right.exported === true) - Number(left.exported === true);

      if (exported !== 0) {
        return exported;
      }

      if (left.line !== right.line) {
        return left.line - right.line;
      }

      return compareStrings(left.id, right.id);
    });

  for (const declaration of declarations) {
    if (context.queries.hasSymbol(file, declaration.name)) {
      return declaration.name;
    }
  }

  return undefined;
}

/**
 * Orders two strings by code unit, without a locale.
 *
 * `localeCompare` is deliberately avoided for the reason
 * `../schema/readiness.ts` avoids it: its result depends on the host's locale
 * data, so the same project would produce differently ordered plans on two
 * machines and a suite asserting an order would pass or fail by environment.
 *
 * @param left First value.
 * @param right Second value.
 * @returns A negative number, zero, or a positive number.
 */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

/**
 * The deterministic rank of two initiators, best first.
 *
 * The order is evidence quality, then specificity, then position, and it must
 * be total: two runs over the same index produce the same plan, and a suite
 * that asserts an order asserts something real. The comparison never reads a
 * clock, a random value or a locale.
 *
 * 1. **A literal target outranks a computed one.** A literal can be
 *    cross-referenced against the route map before the capture, which is what
 *    lets the plan say what will be traced and where it lands.
 * 2. **A more specific owner outranks a less specific one**
 *    ({@link OWNER_KIND_RANK}): a request issued from an event handler is the
 *    one a developer clicked on.
 * 3. **File, then line, then column** — source order, so a plan reads the way
 *    the project does.
 * 4. **Method, then target, then node id.** The last is always distinct, so no
 *    two initiators ever compare equal and the sort is stable whatever the
 *    engine's algorithm does.
 *
 * @param left First initiator.
 * @param right Second initiator.
 * @returns A negative number when `left` ranks first.
 */
function compareInitiators(left: FetchInitiator, right: FetchInitiator): number {
  const literal = Number(right.url !== undefined) - Number(left.url !== undefined);

  if (literal !== 0) {
    return literal;
  }

  const owner = ownerRankOf(left) - ownerRankOf(right);

  if (owner !== 0) {
    return owner;
  }

  const file = compareStrings(left.file, right.file);

  if (file !== 0) {
    return file;
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  if (left.column !== right.column) {
    return left.column - right.column;
  }

  const method = compareStrings(left.method ?? '', right.method ?? '');

  if (method !== 0) {
    return method;
  }

  const target = compareStrings(left.url ?? '', right.url ?? '');

  return target !== 0 ? target : compareStrings(left.nodeId, right.nodeId);
}

/**
 * The owner-specificity rank of one initiator.
 *
 * @param initiator The initiator to rank.
 * @returns Its {@link OWNER_KIND_RANK} entry, or {@link UNKNOWN_OWNER_RANK}
 * when the graph recorded no owner.
 */
function ownerRankOf(initiator: FetchInitiator): number {
  return initiator.ownerKind === undefined
    ? UNKNOWN_OWNER_RANK
    : OWNER_KIND_RANK[initiator.ownerKind];
}

/**
 * Cross-references one literal target against the project's routes.
 *
 * Asks `queries.routeForUrl` first, because that surface enriches the route
 * map's answer with the graph's own `api-route` node and applies the query
 * layer's own input bound; when it declines — a target longer than that bound,
 * for instance, which the map itself would still resolve — the injected
 * `routeMap.resolve` is asked directly. Both are the *same* algorithm: this
 * module derives no route path of its own, which is the rule
 * `../route-map.ts`'s single-owner contract states.
 *
 * The method is deliberately **not** required of the match. The question here
 * is "does a route module in this project answer this path?", and a route that
 * declares another method still answers it — narrowing by method would report
 * "no route" for a path a developer can see in their own tree. The methods the
 * route does declare are carried on the result for the reader to judge.
 *
 * @param context The session's context.
 * @param url The literal target recorded at the call site.
 * @returns The route, or `undefined` when nothing in this project answers the
 * target.
 */
function crossReferenceRoute(
  context: InstrumentationContext,
  url: string,
): FetchInitiatorRoute | undefined {
  const queried = context.queries.routeForUrl(url);

  if (queried !== undefined) {
    return Object.freeze({
      routePath: queried.routePath,
      file: queried.file,
      methods: queried.methods,
      location: queried.location,
    });
  }

  const matched = context.routeMap.resolve(url);

  if (matched === undefined) {
    return undefined;
  }

  return Object.freeze({
    routePath: matched.entry.routePath,
    file: matched.entry.file,
    methods: matched.entry.methods,
    location: matched.entry.location,
  });
}

/**
 * Builds one initiator from one `api-call` node, before any route
 * cross-reference.
 *
 * @param context The session's context.
 * @param node The `api-call` node.
 * @returns The initiator, or `undefined` when the node's file is not a path
 * this product may address — a defensive check, since the graph's own contract
 * already guarantees a safe project-relative POSIX path, and a cheap one to
 * keep an unusable path out of a plan action.
 */
function toInitiator(
  context: InstrumentationContext,
  node: CodeNodeOf<typeof API_CALL_NODE_KIND>,
): FetchInitiator | undefined {
  if (!isSafeRelativePath(node.file)) {
    return undefined;
  }

  const data: ApiCallNodeData = node.data;
  const owner = ownerOf(context, node.id);

  let symbol: string | undefined;
  let anchor: FetchAnchorKind | undefined;

  for (const candidate of anchorCandidates(node, owner)) {
    if (context.queries.hasSymbol(node.file, candidate)) {
      symbol = candidate;
      anchor = 'owner';
      break;
    }
  }

  if (symbol === undefined) {
    const fallback = moduleAnchorFor(context, node.file);

    if (fallback !== undefined) {
      symbol = fallback;
      anchor = 'module';
    }
  }

  return {
    nodeId: node.id,
    file: node.file,
    line: node.line,
    column: node.column,
    symbol,
    anchor,
    ownerNodeId: owner?.id,
    ownerKind: owner?.kind,
    url: data.url,
    dynamic: data.dynamic,
    method: data.method,
    route: undefined,
  };
}

/**
 * Every request initiator this project's code graph records, ranked.
 *
 * The evidence half of this adapter, exported as a pure function of the
 * context so that a suite, the planning stage's capability catalog and the
 * framework adapter's server-span planning can all read the same answer
 * without repeating the traversal. It writes nothing, awaits nothing and
 * reads no clock.
 *
 * Candidates are the graph's `api-call` nodes — every one of them, with **no
 * de-duplication by URL** (see {@link FetchInitiator}) — ranked by
 * {@link compareInitiators}. The highest-ranked
 * {@link FetchAdapterLimits.maxRouteResolutions} literal targets are then
 * cross-referenced against the route map; the rest keep
 * {@link FetchInitiator.route} absent.
 *
 * @param context The session's context.
 * @returns The initiators, best-ranked first. Empty when the project issues no
 * client request.
 */
export function collectFetchInitiators(context: InstrumentationContext): readonly FetchInitiator[] {
  const initiators: FetchInitiator[] = [];

  for (const node of context.graph.nodesByKind(API_CALL_NODE_KIND)) {
    const initiator = toInitiator(context, node);

    if (initiator !== undefined) {
      initiators.push(initiator);
    }
  }

  initiators.sort(compareInitiators);

  let resolutions = 0;

  return Object.freeze(
    initiators.map((initiator) => {
      const url = initiator.url;

      if (url === undefined || resolutions >= FETCH_ADAPTER_LIMITS.maxRouteResolutions) {
        return Object.freeze(initiator);
      }

      resolutions += 1;

      return Object.freeze({ ...initiator, route: crossReferenceRoute(context, url) });
    }),
  );
}

// ---------------------------------------------------------------------------
// Narrowing
//
// Which of the project's initiators this question is about. Every seed is a
// node the code graph resolved from a name the pipeline supplied — a component
// the developer's selected element sits inside, an entity the understanding
// named, a search hint — so a target is selected because a declaration exists,
// never because a name was recognised (AAP §0.5.4).
// ---------------------------------------------------------------------------

/** The graph nodes and files a question narrowed to. Empty means "the whole project". */
interface FetchPlanSeeds {
  /** Graph ids of resolved nodes: matched declarations, their handlers, a route's own node. */
  readonly nodeIds: Set<string>;

  /** Files those nodes live in, which is the wider net a component or route seed casts. */
  readonly files: Set<string>;
}

/** Node kinds a named entity may resolve to when the kind is not a component. */
const NAMED_ENTITY_KINDS: readonly CodeNodeKind[] = Object.freeze([
  'symbol',
  'server-function',
  'component',
  'handler',
]);

/** Node kinds a component entity may resolve to. */
const COMPONENT_ENTITY_KINDS: readonly CodeNodeKind[] = Object.freeze(['component']);

/**
 * Resolves one name against the graph and records what it found as seeds.
 *
 * Every match contributes both its node id and its file: the node id narrows to
 * the initiators that declaration owns, and the file narrows to the initiators
 * written beside it, which is what makes a component seed reach a request
 * issued from a sibling handler in the same module. For a component match the
 * handlers declared in that file are added as node seeds too, so a request
 * issued from a memoised handler — function-local, and therefore owned by the
 * `handler` node rather than by the component — is still reached.
 *
 * @param context The session's context.
 * @param name The name to resolve.
 * @param kinds The node kinds to accept, or `undefined` for any kind.
 * @param seeds The seed set to add to, mutated in place.
 * @returns How many matches the name produced.
 */
function addNameSeeds(
  context: InstrumentationContext,
  name: string,
  kinds: readonly CodeNodeKind[] | undefined,
  seeds: FetchPlanSeeds,
): number {
  const matches = context.queries.findByName(name, {
    kinds,
    limit: FETCH_ADAPTER_LIMITS.maxSeedMatches,
  });

  for (const match of matches) {
    seeds.nodeIds.add(match.nodeId);
    seeds.files.add(match.file);

    if (match.kind === 'component') {
      for (const node of context.graph.nodesByFile(match.file)) {
        if (node.kind === 'handler') {
          seeds.nodeIds.add(node.id);
        }
      }
    }
  }

  return matches.length;
}

/**
 * Resolves one request path or absolute URL to the route module that answers
 * it and records that module as a seed.
 *
 * Both query surfaces are used for what each knows: `handlersFor` names the
 * declaration of every method the route exports — the files a server-side
 * request would be issued from — and `routeForUrl` adds the route's own graph
 * node. Nothing is derived here; the route map answers, as it does everywhere
 * else in the product.
 *
 * @param context The session's context.
 * @param url The path or URL the understanding named.
 * @param seeds The seed set to add to, mutated in place.
 * @returns How many seeds the path produced.
 */
function addRouteSeeds(
  context: InstrumentationContext,
  url: string,
  seeds: FetchPlanSeeds,
): number {
  let added = 0;

  for (const handler of context.queries.handlersFor(url)) {
    if (isSafeRelativePath(handler.location.file)) {
      seeds.files.add(handler.location.file);
      added += 1;
    }
  }

  const route = context.queries.routeForUrl(url);

  if (route !== undefined) {
    seeds.files.add(route.file);
    added += 1;

    if (route.node !== undefined) {
      seeds.nodeIds.add(route.node.nodeId);
    }
  }

  return added;
}

/**
 * The seeds a question narrows to, in the order the evidence is trusted.
 *
 * 1. **The selected element's component chain**, nearest first. The nearest
 *    name that resolves wins and the walk stops there: an ancestor further up
 *    the chain is a wider question than the one the developer asked by picking
 *    a specific element. The chain arrives either on the optional `target`
 *    argument or as `'component'` entities of the understanding — see
 *    {@link FetchAdapter.createPlan} for why both paths exist.
 * 2. **The understanding's entities**, in the order Stage 1 ranked them: a
 *    component, function, hook or symbol through `findByName`; a route or URL
 *    through the route map; a file directly; and any entity's own `file` field
 *    whenever it carries one.
 * 3. **The search hints**, consulted only when the entities resolved nothing,
 *    because a hint is a text term rather than a name and would otherwise widen
 *    a question the entities already narrowed.
 *
 * The number of graph lookups is bounded by
 * {@link FetchAdapterLimits.maxSeedQueries}, so a long entity list cannot turn
 * a plan proposal into a repository traversal.
 *
 * @param context The session's context.
 * @param understanding The validated problem understanding.
 * @param target The selected element, when the caller has one.
 * @returns The seeds. Both sets empty means nothing narrowed the question.
 */
function collectSeeds(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  target: SelectedTarget | undefined,
): FetchPlanSeeds {
  const seeds: FetchPlanSeeds = { nodeIds: new Set<string>(), files: new Set<string>() };
  let budget = FETCH_ADAPTER_LIMITS.maxSeedQueries;

  for (const component of target?.componentChain ?? []) {
    if (budget <= 0) {
      break;
    }

    budget -= 1;

    if (addNameSeeds(context, component, COMPONENT_ENTITY_KINDS, seeds) > 0) {
      break;
    }
  }

  for (const entity of understanding.entities) {
    if (budget <= 0) {
      break;
    }

    if (entity.file !== undefined && isSafeRelativePath(entity.file)) {
      seeds.files.add(entity.file);
    }

    switch (entity.kind) {
      case 'component':
        budget -= 1;
        addNameSeeds(context, entity.name, COMPONENT_ENTITY_KINDS, seeds);
        break;

      case 'function':
      case 'hook':
      case 'symbol':
        budget -= 1;
        addNameSeeds(context, entity.name, NAMED_ENTITY_KINDS, seeds);
        break;

      case 'route':
      case 'url':
        budget -= 1;
        addRouteSeeds(context, entity.name, seeds);
        break;

      case 'file':
        if (isSafeRelativePath(entity.name)) {
          seeds.files.add(entity.name);
        }
        break;

      default:
        // A selector, a data-layer operation or an unclassified noun names no
        // declaration this graph can resolve, so it seeds nothing and costs no
        // lookup. Its contribution is the search hint Stage 1 derived from it,
        // which the next block consults.
        break;
    }
  }

  if (seeds.nodeIds.size === 0 && seeds.files.size === 0) {
    for (const hint of understanding.searchHints) {
      if (budget <= 0) {
        break;
      }

      budget -= 1;
      addNameSeeds(context, hint, undefined, seeds);
    }
  }

  return seeds;
}

/**
 * Whether one initiator falls inside a question's seeds.
 *
 * Three ways in, widest last: the call site is itself a seeded node, the
 * declaration that owns it is one, or it is written in a seeded file. The third
 * is what makes a component seed cover the requests its module issues without
 * the question having to name each one.
 *
 * @param initiator The initiator to test.
 * @param seeds The question's seeds.
 * @returns `true` when the initiator is in scope.
 */
function matchesSeeds(initiator: FetchInitiator, seeds: FetchPlanSeeds): boolean {
  if (seeds.nodeIds.has(initiator.nodeId)) {
    return true;
  }

  const ownerNodeId = initiator.ownerNodeId;

  if (ownerNodeId !== undefined && seeds.nodeIds.has(ownerNodeId)) {
    return true;
  }

  return seeds.files.has(initiator.file);
}

// ---------------------------------------------------------------------------
// Action composition
//
// Every action this adapter proposes states, in the developer's own terms, that
// the hook is document-wide and that the anchor is an initiator the graph
// found. No sentence below contains a path, a host or an endpoint: the only
// project-specific text in a rationale is interpolated from
// `ApiCallNodeData.url` or from a route the route map resolved (AAP §0.5.4).
// ---------------------------------------------------------------------------

/**
 * The half of a rationale that names the anchor.
 *
 * @param initiator The initiator, whose `symbol` has already been affirmed.
 * @param symbol The affirmed anchor symbol.
 * @returns A clause with no trailing punctuation.
 */
function anchorClause(initiator: FetchInitiator, symbol: string): string {
  const name = sanitizeForProse(symbol, FETCH_ADAPTER_LIMITS.maxProseValueLength);
  const method = initiator.method;

  // The method is an adjective on "request" rather than a clause of its own, so
  // a call site whose method the extractor could not determine reads as one
  // sentence short rather than one clause broken.
  const request =
    method !== undefined && METHOD_SHAPE.test(method)
      ? `${method.toUpperCase()} request`
      : 'request';

  return initiator.anchor === 'module'
    ? `Arms the page agent's document-wide fetch and XMLHttpRequest observation, anchored on ${name} — the nearest addressable declaration to the ${request} the code graph recorded in that module`
    : `Arms the page agent's document-wide fetch and XMLHttpRequest observation, anchored on the ${request} the code graph recorded inside ${name}`;
}

/**
 * The half of a rationale that states what is known about the target.
 *
 * Three cases, and the difference between them is exactly how much the plan may
 * promise: a literal target a route answers joins the browser and server halves
 * of a trace; a literal nothing answers is traced in the browser alone; a
 * computed target cannot be cross-referenced before the capture at all, which
 * is the reduced precision this clause is obliged to state rather than hide.
 *
 * @param initiator The initiator.
 * @returns A clause with no trailing punctuation.
 */
function targetClause(initiator: FetchInitiator): string {
  const route = initiator.route;

  if (route !== undefined) {
    const path = sanitizeForProse(route.routePath, FETCH_ADAPTER_LIMITS.maxProseValueLength);

    if (path.length > 0) {
      return `the route map resolves its target to ${path}, a route module in this project, so the browser span and the server spans behind it join on one trace`;
    }
  }

  const url = initiator.url;

  if (url !== undefined) {
    const path = sanitizeForProse(url, FETCH_ADAPTER_LIMITS.maxProseValueLength);

    if (path.length > 0) {
      return `its target ${path} matches no route module in this project, so the request is traced in the browser and correlated no further`;
    }

    return 'its recorded target reduced to nothing that could be matched against a route, so the request is traced in the browser alone';
  }

  return "its target is computed at run time, so no route can be cross-referenced before the capture and this initiator's source link is less precise than a literal target's";
}

/**
 * Composes the rationale one action carries.
 *
 * Required by `../schema/plan.ts` and shown to the developer in the editor's
 * plan list and the panel's session summary, so it says what will be traced and
 * what will not. Bounded by {@link FetchAdapterLimits.maxRationaleLength},
 * which sits below the schema's own bound, so a truncated rationale is still a
 * valid one.
 *
 * @param initiator The initiator being anchored.
 * @param symbol The affirmed anchor symbol.
 * @returns The rationale, non-empty and single-line.
 */
function buildRationale(initiator: FetchInitiator, symbol: string): string {
  const composed = `${anchorClause(initiator, symbol)}; ${targetClause(initiator)}.`;

  return composed.length <= FETCH_ADAPTER_LIMITS.maxRationaleLength
    ? composed
    : `${composed.slice(0, FETCH_ADAPTER_LIMITS.maxRationaleLength - 1)}…`;
}

/**
 * Builds the action for one anchored initiator.
 *
 * @param initiator The initiator.
 * @param symbol The affirmed anchor symbol.
 * @returns A complete {@link InstrumentationAction} with a fresh id.
 */
function toAction(initiator: FetchInitiator, symbol: string): InstrumentationAction {
  return {
    id: newActionId(),
    file: initiator.file,
    symbol,
    type: FETCH_ACTION_TYPE,
    adapter: FETCH_ADAPTER_ID,
    mode: FETCH_ACTION_MODE,
    rationale: buildRationale(initiator, symbol),
  };
}

/**
 * Whether one action belongs to this adapter.
 *
 * Both halves are required: an action naming another adapter is that adapter's
 * to install even when its type happens to be this one's, and an action of an
 * unclaimed type is not this adapter's work even when normalisation attributed
 * it here. Anything else is ignored silently — the installer hands every
 * adapter the subset it resolved, and complaining about the rest would turn a
 * routing detail into a developer-visible failure.
 *
 * @param action The action to test.
 * @returns `true` when this adapter installs it.
 */
function isClaimedAction(action: InstrumentationAction): boolean {
  return action.adapter === FETCH_ADAPTER_ID && action.type === FETCH_ACTION_TYPE;
}

/** The hook labels, de-duplicated and ordered, as every report must carry them. */
function sortedHookLabels(): string[] {
  return [...new Set(FETCH_RUNTIME_HOOK_LABELS)].sort(compareStrings);
}

/**
 * The gap this adapter can observe: no page agent has reported for the bound
 * tab.
 *
 * The wording follows `UnavailableSignal`'s contract — `reason` reads after
 * "Could not enable fetch: " and states what was observed, `hint` states one
 * concrete action — and it names no project, path or file, because the recovery
 * is the same for every project: the dormant agent is armed only once the page
 * is open with the panel attached.
 *
 * @returns The row, safe to hand to both {@link InstallResult.unavailable} and
 * a readiness report.
 */
function missingBrowserAgentSignal(): UnavailableSignal {
  return {
    signal: FETCH_SIGNAL,
    reason:
      'no page agent has reported for the tab bound to this session, so there is nothing in the page to attach the request hook to',
    hint: 'Open the application in a tab with the "Debug Generator" DevTools panel open, reload it once so the agent reports, then start the capture again.',
  };
}

/**
 * Whether cancellation has been requested.
 *
 * A function rather than an inline read of `context.signal?.aborted`, and for a
 * reason worth stating: a signal is a *live* object, so the answer can change
 * between two step boundaries of one call — which is the whole point of
 * honouring it between steps (`../adapter.ts`). Reading it through a call also
 * keeps the compiler from narrowing the second check to the first check's
 * result, which is exactly the false assumption a loop guard must not make.
 *
 * @param context The session's context.
 * @returns `true` when the caller has aborted this work.
 */
function isAborted(context: InstrumentationContext): boolean {
  return context.signal?.aborted ?? false;
}

/**
 * Whether this question asks for the browser's request signal.
 *
 * The decision is `signalsNeeded`, which is the machine-readable field
 * `../schema/target.ts` exists to keep out of free-text matching: a question
 * about renders alone must not arm a network hook, because a capture that
 * collected requests nobody asked about is untargeted instrumentation
 * (AAP §0.5.1) and unexplained data in a panel.
 *
 * One corroboration is accepted, and it is evidence rather than prose: an
 * entity whose kind is itself a request path or URL. A question that names a
 * route *is* a question about requests, and honouring that costs nothing while
 * a missed signal costs the browser↔server join.
 *
 * @param understanding The validated problem understanding.
 * @returns `true` when a `'fetch-tracking'` action belongs in the plan.
 */
function requestsFetchTracking(understanding: ProblemUnderstanding): boolean {
  if (understanding.signalsNeeded.includes(FETCH_SIGNAL)) {
    return true;
  }

  return understanding.entities.some((entity) => entity.kind === 'route' || entity.kind === 'url');
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The fetch adapter's public shape: the {@link InstrumentationAdapter} contract
 * plus the declarations a registry reads.
 *
 * The contract itself has no member for a claim — adapter identity belongs to
 * `../registry.ts`, which imports the contract and could not be imported back
 * by it — so the claim is carried here, on the instance, and exported as
 * {@link FETCH_ADAPTER_CLAIMS} for the registry to build its type-to-adapter
 * table from. Everything added is data: no method beyond the five the contract
 * defines.
 */
export interface FetchAdapter extends InstrumentationAdapter {
  /** Always {@link FETCH_ADAPTER_ID}. */
  readonly id: typeof FETCH_ADAPTER_ID;

  /** What this adapter claims, and in which mode. Always {@link FETCH_ADAPTER_CLAIMS}. */
  readonly claims: readonly AdapterClaim[];

  /** The page-agent hook keys it contributes. Always {@link FETCH_AGENT_HOOK_KEYS}. */
  readonly hookKeys: readonly AgentHookKey[];

  /** The bounds it applies. Always {@link FETCH_ADAPTER_LIMITS}. */
  readonly limits: FetchAdapterLimits;

  /**
   * The effective cap on a plan proposal's length, after
   * {@link FetchAdapterOptions.maxTargets} was clamped into
   * {@link FetchAdapterLimits}.
   */
  readonly maxTargets: number;

  /**
   * Proposes the `'fetch-tracking'` actions for this question.
   *
   * The optional third argument is the element the developer selected in the
   * inspected page, when the caller holds one. The contract's own signature has
   * two parameters and is satisfied as written — the parameter is optional, so
   * this method remains assignable to
   * {@link InstrumentationAdapter.createPlan} — and the same information also
   * reaches this adapter through the understanding's `'component'` entities,
   * which is how a selected element enters the pipeline in production
   * (`../schema/target.ts`). Both paths feed one narrowing order, so a caller
   * that can pass the descriptor gets a nearest-first component chain and a
   * caller that cannot loses nothing.
   */
  createPlan(
    context: InstrumentationContext,
    understanding: ProblemUnderstanding,
    target?: SelectedTarget,
  ): Promise<InstrumentationAction[]>;
}

/**
 * The implementation. Constructed only by {@link createFetchAdapter}.
 *
 * Holds nothing but its resolved options: every fact about a project, a session
 * or a producer arrives on the {@link InstrumentationContext} of each call, so
 * one instance serves every session and two calls with the same context give
 * the same answer.
 */
class FetchInstrumentationAdapter implements FetchAdapter {
  readonly id = FETCH_ADAPTER_ID;

  readonly claims: readonly AdapterClaim[] = FETCH_ADAPTER_CLAIMS;

  readonly hookKeys: readonly AgentHookKey[] = FETCH_AGENT_HOOK_KEYS;

  readonly limits: FetchAdapterLimits = FETCH_ADAPTER_LIMITS;

  readonly maxTargets: number;

  /** The construction-time clock, used only when a context carries none. */
  readonly #now?: (() => number) | undefined;

  constructor(options: ResolvedFetchAdapterOptions) {
    this.maxTargets = options.maxTargets;
    this.#now = options.now;
  }

  /**
   * Whether this project issues any client request at all.
   *
   * One O(1) bucket read of the code graph: `api-call` nodes are pre-indexed by
   * kind, so this costs nothing even though the planner asks it once per
   * candidate action type while a developer waits. Synchronous, side-effect
   * free and stable within a session, as the contract requires.
   *
   * It is a question about **capability, not readiness**: a project whose graph
   * holds call sites answers `true` even when no page agent has reported, and
   * that gap is {@link FetchInstrumentationAdapter.readiness}'s to report and
   * {@link InstallResult.unavailable}'s to carry. A project with no call site
   * answers `false`, because there is genuinely nothing for this adapter to
   * trace.
   *
   * @param context The session's context.
   * @returns `true` when the graph records at least one `api-call` node.
   */
  canHandle(context: InstrumentationContext): boolean {
    return context.graph.nodesByKind(API_CALL_NODE_KIND).length > 0;
  }

  /**
   * Proposes a small, bounded set of `'fetch-tracking'` actions.
   *
   * The hook is document-wide, so this deliberately does **not** emit one
   * action per call site: it emits at most
   * {@link FetchInstrumentationAdapter.maxTargets} actions anchored on the
   * highest-ranked initiators, each explaining that the observation covers the
   * whole document while the anchor names an initiator the graph found. A plan
   * a developer cannot read is a plan they cannot check, and a promise to
   * instrument forty call sites individually would be a promise this adapter
   * does not keep.
   *
   * Every anchor is affirmed by `queries.hasSymbol` before an action is built,
   * so `../feasibility.ts` has nothing to reject; an initiator with no
   * addressable declaration in its file is skipped rather than guessed at. Ids
   * are fresh per call, and everything else about the result is a pure function
   * of the context: two calls produce equal arrays apart from those ids.
   *
   * @param context The session's context.
   * @param understanding The validated problem understanding.
   * @param target The selected element, when the caller holds one.
   * @returns The proposed actions, best-ranked first. Empty — never a
   * rejection — when the project issues no request, when the question asks for
   * no request signal, or when no initiator could be anchored.
   */
  createPlan(
    context: InstrumentationContext,
    understanding: ProblemUnderstanding,
    target?: SelectedTarget,
  ): Promise<InstrumentationAction[]> {
    const logger = context.logger.child({ adapter: this.id });

    if (isAborted(context)) {
      logger.debug('fetch adapter skipped planning: the session aborted');

      return Promise.resolve([]);
    }

    if (!requestsFetchTracking(understanding)) {
      logger.debug('fetch adapter proposed nothing: the question asks for no request signal', {
        category: understanding.category,
        signals: understanding.signalsNeeded.length,
      });

      return Promise.resolve([]);
    }

    const initiators = collectFetchInitiators(context);

    if (initiators.length === 0) {
      return Promise.resolve([]);
    }

    const seeds = collectSeeds(context, understanding, target);
    const narrowed =
      seeds.nodeIds.size === 0 && seeds.files.size === 0
        ? initiators
        : initiators.filter((initiator) => matchesSeeds(initiator, seeds));

    // Unresolvable evidence widens rather than empties: a question whose names
    // the graph could not resolve is still a question about this project's
    // requests, and answering it with nothing would lose the signal that joins
    // the browser and server halves of a trace.
    const pool = narrowed.length > 0 ? narrowed : initiators;
    const actions: InstrumentationAction[] = [];
    const seen = new Set<string>();

    for (const initiator of pool) {
      if (actions.length >= this.maxTargets || isAborted(context)) {
        break;
      }

      const symbol = initiator.symbol;

      if (symbol === undefined) {
        continue;
      }

      // One action per addressable anchor. Two call sites that share an owner
      // would produce the same `(file, symbol, type)` identity — the key
      // `../schema/plan.ts` matches plan versions on — so the second would be a
      // duplicate the feasibility gate reports rather than evidence. The
      // *candidates* stay distinct (see `collectFetchInitiators`), which is what
      // duplicate-request analysis needs; only the anchors are folded.
      const identity = actionIdentityKey({
        file: initiator.file,
        symbol,
        type: FETCH_ACTION_TYPE,
      });

      if (seen.has(identity)) {
        continue;
      }

      seen.add(identity);
      actions.push(toAction(initiator, symbol));
    }

    logger.debug('fetch adapter proposed request tracking', {
      candidates: initiators.length,
      narrowed: pool.length,
      actions: actions.length,
      indexedApiCalls: context.projectSummary.counts.apiCalls,
      planVersion: context.planVersion,
    });

    return Promise.resolve(actions);
  }

  /**
   * Reports what arming the request hook came to. **Writes nothing.**
   *
   * `applied` is always empty and no `ModificationRecord` is ever produced:
   * this signal is collected by the page agent, so there is no file to back up,
   * no hash to record and nothing for cleanup to restore (AAP §0.5.1). The
   * page-agent contribution is `deriveAgentHookConfig`'s own answer over the
   * accepted actions — the derivation owns the policy, including the
   * `interactions` flag it forces on, and this adapter forwards it rather than
   * mapping its type to a key itself.
   *
   * A missing page agent is reported in {@link InstallResult.unavailable} and
   * the call still resolves: a gap is data, and only the installer — which sees
   * every adapter's answer — decides that nothing at all could be enabled
   * (AAP §0.5.5). The reduced precision of a computed request target is not a
   * gap of this kind and is carried in the relevant action's rationale instead,
   * because an `UnavailableSignal`'s `reason` reads after "Could not enable
   * fetch: " and this signal *was* enabled.
   *
   * @param actions The plan's actions; anything not this adapter's is ignored.
   * @param context The session's context.
   * @returns The result. Never rejects for a missing signal.
   */
  install(
    actions: readonly InstrumentationAction[],
    context: InstrumentationContext,
  ): Promise<InstallResult> {
    const logger = context.logger.child({ adapter: this.id });
    const accepted = actions.filter(isClaimedAction);

    if (accepted.length === 0) {
      logger.debug('fetch adapter installed nothing: no request-tracking action was planned', {
        offered: actions.length,
      });

      return Promise.resolve({
        adapterId: this.id,
        applied: [],
        runtimeHooks: [],
        unavailable: [],
      });
    }

    if (isAborted(context)) {
      logger.debug('fetch adapter armed nothing: the install aborted', {
        accepted: accepted.length,
      });

      return Promise.resolve({
        adapterId: this.id,
        applied: [],
        runtimeHooks: [],
        unavailable: [],
      });
    }

    const agent = context.readiness.browserAgent;

    if (agent === undefined) {
      logger.debug('fetch adapter could not arm the request hook: no page agent has reported', {
        accepted: accepted.length,
        signal: FETCH_SIGNAL,
      });

      return Promise.resolve({
        adapterId: this.id,
        applied: [],
        runtimeHooks: [],
        unavailable: [missingBrowserAgentSignal()],
      });
    }

    const hooks: AgentHookConfig = deriveAgentHookConfig(accepted);

    logger.debug('fetch adapter armed the request hook', {
      accepted: accepted.length,
      producerId: agent.producerId,
      documentId: agent.documentId,
      observedAt: agent.observedAt,
    });

    return Promise.resolve({
      adapterId: this.id,
      applied: [],
      runtimeHooks: sortedHookLabels(),
      unavailable: [],
      agentHooks: hooks,
    });
  }

  /**
   * Relinquishes the request hook.
   *
   * Nothing is written, deleted or restored, and `../cleanup.ts` is not
   * involved: the page agent's patched `fetch` and `XMLHttpRequest` are put
   * back by the agent itself when the service sends an all-false
   * `agent.config`, which is how a capture returns the page to dormant
   * (AAP §0.5.1). Reporting the labels is what lets both user interfaces state
   * what is no longer observing the application.
   *
   * A `'reconcile'` removal reports no disabled hook, and that is the honest
   * answer rather than a special case: the session being reconciled belongs to
   * a process that is gone, so its page hooks went with it and there is nothing
   * to detach. Idempotent in every reason — calling it again after a crash, a
   * reconnect or a retry converges on the same report.
   *
   * @param session Which session and plan version are in scope, and why.
   * @param context The session's context.
   * @returns The result: nothing restored, nothing conflicted.
   */
  remove(session: AdapterRemoveRequest, context: InstrumentationContext): Promise<RemoveResult> {
    const relinquished = session.reason === 'reconcile' ? [] : sortedHookLabels();

    context.logger.child({ adapter: this.id }).debug('fetch adapter released the request hook', {
      sessionId: session.sessionId,
      reason: session.reason,
      planVersion: session.planVersion,
      hooks: relinquished.length,
    });

    return Promise.resolve({
      adapterId: this.id,
      restored: [],
      conflicts: [],
      runtimeHooksDisabled: relinquished,
    });
  }

  /**
   * Reports whether the request signal can be collected here.
   *
   * Decided from `context.readiness.browserAgent` and the code graph, and from
   * nothing else: no port is probed, no connection retried, no process spawned,
   * no environment variable read. The service holds the evidence — the relayed
   * `agent.ready` for the bound tab's current document — and an adapter that
   * went looking for its own could tell a developer a signal is ready while the
   * frames the product needs are not arriving.
   *
   * A present report is taken at face value, which the contract sanctions: the
   * service compares a report's document with the tab's current one before
   * putting it on the context, so ageing it a second time here would only
   * invent disagreement. React is not consulted at all — the request hook
   * patches two platform functions and needs no fiber hook — so
   * `installedBeforeReact` and `reactDetected` are deliberately not read.
   *
   * A project with no `api-call` node is ready with **no rows**: an adapter
   * claiming nothing cannot hold a capture back, which is a different statement
   * from an adapter whose signal is unavailable.
   *
   * @param context The session's context.
   * @returns One report for this adapter, built by
   * `../schema/readiness.ts`'s constructor so the `ready` derivation is stated
   * in exactly one place.
   */
  readiness(context: InstrumentationContext): Promise<Readiness> {
    const signals: ReadinessSignal[] = [];

    if (this.canHandle(context)) {
      if (context.readiness.browserAgent === undefined) {
        const gap = missingBrowserAgentSignal();

        signals.push({
          signal: FETCH_SIGNAL,
          status: 'unavailable',
          reason: gap.reason,
          hint: gap.hint,
        });
      } else {
        signals.push({ signal: FETCH_SIGNAL, status: 'available' });
      }
    }

    const now = context.now ?? this.#now;

    return Promise.resolve(
      buildReadiness({
        adapter: this.id,
        signals,
        // `BuildReadinessInput.now` is declared without `| undefined`, so under
        // `exactOptionalPropertyTypes` the key is spread rather than assigned.
        ...(now === undefined ? {} : { now }),
      }),
    );
  }
}

/**
 * Builds the fetch adapter.
 *
 * A factory rather than a shared singleton, so `../registry.ts` constructs the
 * built-ins inside `createAdapterRegistry` and a suite can hold two
 * independently configured instances at once. Importing this module constructs
 * nothing and touches nothing: there is no module-load side effect to pay for.
 *
 * @param options Injected, fully-defaulted knobs. An out-of-range
 * `maxTargets` is clamped into {@link FETCH_ADAPTER_LIMITS} and reported at
 * `debug` through {@link FetchAdapterOptions.logger}.
 * @returns A fresh adapter.
 *
 * @example
 * ```ts
 * const adapter = createFetchAdapter();
 *
 * if (adapter.canHandle(context)) {
 *   const actions = await adapter.createPlan(context, understanding);
 *   const result = await adapter.install(actions, context);
 * }
 * ```
 */
export function createFetchAdapter(options?: FetchAdapterOptions): FetchAdapter {
  return new FetchInstrumentationAdapter(resolveOptions(options));
}
