/**
 * The **framework adapter**: server-tier readiness, and the only adapter in the
 * product that installs `patch`-mode actions.
 *
 * Two halves, and they are unlike each other on purpose (AAP §0.5.1).
 *
 * 1. **Runtime readiness for the server tier.** Incoming request spans, route
 *    handler spans and the dev server's own outgoing request spans are produced
 *    by the framework's *own* tracer, as soon as the Debug Generator Node
 *    preload has registered a tracer provider inside the dev-server process.
 *    This adapter installs none of them. It reports whether that preload is
 *    attached — from the `server-agent` facts the service observed and from
 *    nothing else — and contributes the corresponding
 *    {@link ServerAgentSignals} keys so the preload is told what to collect.
 * 2. **Patch actions for named symbols.** Timing an arbitrary application
 *    function is the one signal no runtime hook can supply, so a `server-span`
 *    on a route module's method export and a `function-timing` on a server
 *    function are installed by *editing the developer's file* — through
 *    `../patch/patcher.js`, which owns the hash → backup → journal →
 *    atomic-rename sequence that makes the edit reversible. Nothing here reads,
 *    writes, renames, hashes or deletes a project file or a backup, and nothing
 *    here constructs a {@link ModificationRecord}.
 *
 * ## How a target is chosen
 *
 * Every target is **selected from the code graph** (AAP §0.5.4): an
 * `api-route` node's declared method exports, and the `server-function` nodes
 * those handlers reach along `calls` edges. No route path, handler name or
 * service-function name appears as a literal in this file; the HTTP method
 * vocabulary is imported from `@debuggen/code-analysis` rather than restated,
 * and the URL → route-file question is answered by the route map, which is the
 * product's only implementation of it.
 *
 * ## What it refuses to do
 *
 * - **No patch without a preload.** A file modification that cannot produce a
 *   span is pure risk to a developer's working tree, so when no preload is
 *   attached this adapter applies nothing and reports the gap with the relaunch
 *   instruction instead: the "Debug Generator: Launch Dev Server" editor
 *   command, plus the exact hand-typed command when a caller injects what it
 *   needs (see {@link NextJsAdapterOptions.relaunch}).
 * - **No stepping past a failed patch, and no rollback of its own.** The
 *   patcher stops at the first target it cannot complete, and this adapter
 *   stops with it: the records applied so far go back in
 *   {@link InstallResult.applied} and the failure — with the record journaled
 *   for the failed attempt — in {@link InstallResult.failure}, the contract's
 *   fatal channel. `../installer.ts` then reverse-restores every record the
 *   current install applied, so a follow-up's delta is all-or-nothing
 *   (AAP §0.4.2), and `../cleanup.ts` owns the restoration itself —
 *   chain-aware and in strict reverse order. Continuing after a failure would
 *   hand the installer a partial install shaped like a successful one.
 * - **No probing.** Readiness is a statement about observed evidence: no port
 *   is opened, no process is spawned, no environment variable is read.
 *
 * ## Consumers
 *
 * `../registry.ts` constructs this adapter inside `createAdapterRegistry` and
 * resolves an action's `adapter`/`mode` from {@link NEXTJS_ADAPTER_CLAIMS};
 * `../installer.ts` calls {@link NextJsAdapter.install} after every
 * runtime-mode adapter, so a patch failure has strictly less to unwind;
 * `apps/local-service/src/instrumentation/service.ts` builds the context and
 * sends this adapter's `serverSignals` contribution to the preload;
 * `.../readiness.ts` aggregates {@link NextJsAdapter.readiness} into the
 * session's "Ready to capture" state.
 */

import { DebuggenError, newActionId, normalizePosix, nowEpochMs, toPosix } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';
import { HTTP_METHOD_NAMES } from '@debuggen/code-analysis';
import type {
  CodeEdge,
  CodeNodeOf,
  CodeQueries,
  HttpMethodName,
  PackageManagerName,
  RouteEntry,
} from '@debuggen/code-analysis';

import type {
  AdapterRemoveRequest,
  InstallFailure,
  InstallResult,
  InstrumentationContext,
  InstrumentationAdapter,
  ObservedServerAgent,
  RemoveResult,
  UnavailableSignal,
} from '../adapter.js';
import type { ModificationRecord } from '../schema/modification.js';
import type {
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
} from '../schema/plan.js';
import {
  READINESS_HINT_MAX_LENGTH,
  READINESS_REASON_MAX_LENGTH,
  buildReadiness,
  deriveServerAgentSignals,
} from '../schema/readiness.js';
import type {
  CaptureSignal,
  Readiness,
  ReadinessSignal,
  ReadinessStatus,
  ServerAgentSignalKey,
  ServerAgentSignals,
} from '../schema/readiness.js';
import type { ProblemUnderstanding } from '../schema/target.js';
import { createPatcher } from '../patch/patcher.js';
import type { PatchBatchFailure, Patcher, PatcherOptions } from '../patch/patcher.js';

// ---------------------------------------------------------------------------
// Identity and claims
// ---------------------------------------------------------------------------

/**
 * This adapter's registered identity.
 *
 * Equal to the corresponding member of `../registry.ts`'s `ADAPTER_IDS` and to
 * this module's file name, and stable across versions: a stored plan or a
 * modification record read back after an upgrade names the adapter that
 * produced it, and an id that moved would orphan it.
 *
 * Declared `as const` so the literal survives into {@link NextJsAdapter.id},
 * which is what lets a caller compare an action's `adapter` field against it
 * without widening to `string`.
 */
export const NEXTJS_ADAPTER_ID = 'nextjs' as const;

/**
 * One entry of an adapter's claim declaration: an action type, and the mode the
 * adapter installs it in.
 *
 * Structural rather than imported, because `../registry.ts` imports *this*
 * module and not the reverse (AAP §0.4.2): the registry reads the declaration
 * off each adapter, so the shape has to be stated where the adapter lives.
 */
export interface NextJsAdapterClaim {
  /** The action type this adapter claims. */
  readonly type: InstrumentationActionType;

  /** How this adapter installs it. */
  readonly mode: InstrumentationMode;
}

/**
 * The single place this adapter's types and modes are written.
 *
 * Both claims are `'patch'`, and that is load-bearing in two places:
 * `../registry.ts` resolves an action's `adapter`/`mode` from this declaration
 * while `normalizePlan` normalises a plan, and `../installer.ts` uses the mode
 * to install every runtime-mode group *before* any patch-mode group. A wrong
 * mode here would silently change install ordering rather than fail, so it is
 * declared once, frozen, and re-exported on the adapter object itself.
 */
export const NEXTJS_ADAPTER_CLAIMS = Object.freeze([
  Object.freeze({ type: 'server-span', mode: 'patch' }),
  Object.freeze({ type: 'function-timing', mode: 'patch' }),
] as const satisfies readonly NextJsAdapterClaim[]);

/** The action types {@link NEXTJS_ADAPTER_CLAIMS} claims, for membership tests. */
const CLAIMED_ACTION_TYPES: readonly InstrumentationActionType[] = Object.freeze(
  NEXTJS_ADAPTER_CLAIMS.map((claim) => claim.type),
);

/**
 * The mode every action of this adapter is installed in.
 *
 * Read off {@link NEXTJS_ADAPTER_CLAIMS} rather than written a second time, so
 * an emitted action and the registry's resolution cannot disagree.
 */
const PATCH_MODE: InstrumentationMode = NEXTJS_ADAPTER_CLAIMS[0].mode;

/**
 * The {@link ServerAgentSignals} keys this adapter contributes.
 *
 * The three runtime signals the preload supplies for this tier — incoming
 * requests, route handlers and the dev server's own outgoing requests — plus
 * `functions`, the one signal that costs a modification to a developer's file
 * and is therefore never enabled wholesale. `prisma` and `pg` are the database
 * adapters' to contribute, and this adapter never speaks for them.
 *
 * Each member is both a {@link ServerAgentSignalKey} and a
 * {@link CaptureSignal}, which is what lets the same tuple drive the signal
 * contribution, the readiness rows and the {@link UnavailableSignal} entries.
 */
export const NEXTJS_SERVER_SIGNAL_KEYS = Object.freeze([
  'http',
  'routeHandlers',
  'fetch',
  'functions',
] as const satisfies readonly (ServerAgentSignalKey & CaptureSignal)[]);

/**
 * The signal that carries the spans a `patch`-mode action produces.
 *
 * A patched route handler and a patched server function both emit their span
 * through the preload's `globalThis.__DEBUGGEN__.span` helper, which is the
 * `functions` signal — so a patch that could not be applied is reported under
 * this name, and never under the runtime signals the preload still supplies on
 * its own.
 */
const PATCHED_SPAN_SIGNAL: CaptureSignal = 'functions';

/**
 * The signals in {@link ProblemUnderstanding.signalsNeeded} that ask for a
 * route handler to be wrapped.
 *
 * `http` is included because the incoming-request span and the route-handler
 * span are read together: a question that needs to know where a request spent
 * its time needs the handler boundary inside it.
 */
const ROUTE_FAMILY_SIGNALS: readonly CaptureSignal[] = Object.freeze(['routeHandlers', 'http']);

/** The signals that ask for a named server function to be timed. */
const FUNCTION_FAMILY_SIGNALS: readonly CaptureSignal[] = Object.freeze([PATCHED_SPAN_SIGNAL]);

/** The hook label for the framework's incoming-request spans. */
const HOOK_SERVER_REQUESTS = 'Server request spans';

/** The hook label for the framework's route-handler spans. */
const HOOK_ROUTE_HANDLERS = 'Route handler spans';

/** The hook label for the dev server's own outgoing request spans. */
const HOOK_OUTGOING_REQUESTS = 'Outgoing server request spans';

/**
 * Every runtime hook the preload can arm for this tier, as a developer reads
 * them.
 *
 * Sorted and frozen: an install reports the subset it actually armed, and the
 * list lands in `instrumentation.ready` and in both user interfaces, so two
 * identical installs must produce the same array. These are *descriptions*
 * rather than signal names — the machine-readable statement of what was enabled
 * is {@link InstallResult.serverSignals}.
 */
export const NEXTJS_RUNTIME_HOOKS: readonly string[] = Object.freeze(
  [HOOK_OUTGOING_REQUESTS, HOOK_ROUTE_HANDLERS, HOOK_SERVER_REQUESTS].sort(),
);

/**
 * The published package subpath of the product's dev-server preload
 * (`packages/telemetry`'s `./node/register` export).
 *
 * Exported as the name of record, and **never** put in a default hint: a target
 * project declares no `@debuggen/*` dependency (AAP §0.4.2), so
 * `--import @debuggen/telemetry/node/register` fails there with
 * `ERR_MODULE_NOT_FOUND`, and a bare specifier carries none of the ingest
 * variables the preload needs to report. Only a caller that knows a specifier
 * the target *can* load — the absolute `file:` URL of a bundled preload, say —
 * gets a hand-typed command, by injecting it through
 * {@link NextJsAdapterRelaunchDescriptor.preloadSpecifier}.
 */
export const DEBUGGEN_NODE_PRELOAD_SPECIFIER = '@debuggen/telemetry/node/register';

/**
 * The editor command every relaunch hint names: the VS Code palette label of
 * `debuggen.launchDevServer` (category "Debug Generator", title "Launch Dev
 * Server" in `apps/vscode-extension/package.json`), spelled exactly as the
 * palette shows it so a developer can type it into the palette verbatim.
 *
 * The service is what actually launches the dev server with the preload and a
 * freshly minted ingest credential attached (AAP §0.5.6), so this is the one
 * recovery path this adapter can state exactly without knowing the preload's
 * path, the ingest URL or a credential — none of which it is handed by default.
 */
const LAUNCH_COMMAND_LABEL = 'Debug Generator: Launch Dev Server';

/**
 * What an environment variable name must look like to be referenced from a
 * POSIX shell as `NAME="$NAME"`.
 *
 * A name outside this shape cannot be spelled as an assignment on a command
 * line, so a descriptor carrying one gets no hand-typed command at all rather
 * than a command that silently omits a variable the preload needs.
 */
const SHELL_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Highest code point of the C0 control block. */
const C0_CONTROL_MAX = 0x1f;

/** Lowest code point of the DEL/C1 control block. */
const C1_CONTROL_MIN = 0x7f;

/** Highest code point of the C1 control block. */
const C1_CONTROL_MAX = 0x9f;

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The defaults and hard ceilings of {@link NextJsAdapterOptions}.
 *
 * Exported and frozen so a suite can assert against the real numbers instead of
 * restating them, and so the caps a developer's project is measured by are
 * readable in one place. Every action this adapter proposes becomes a real file
 * modification the developer has to trust, which is why the caps are small.
 */
export const NEXTJS_ADAPTER_LIMITS = Object.freeze({
  /** How many route-handler method exports one plan may wrap. */
  maxRouteTargets: 6,

  /** How many server functions one plan may time. */
  maxFunctionTargets: 8,

  /** How many `calls` hops a server function may be from a selected route. */
  maxDepth: 2,

  /** The ceiling {@link NEXTJS_ADAPTER_LIMITS.maxDepth} may be raised to. */
  maxDepthCeiling: 4,

  /** The ceiling either target cap may be raised to. */
  maxTargetsCeiling: 32,

  /**
   * How long a connected preload may stay silent before it is reported as
   * degraded, in milliseconds.
   *
   * A preload speaks on connect and on every batch it exports, so half a minute
   * of silence during a session is evidence worth surfacing — while a
   * connection that has not spoken *yet* is not, which is why the staleness
   * test needs a heartbeat to compare against.
   */
  heartbeatStalenessMs: 30_000,
});

/**
 * The placeholder name a code index records for an anonymous default export.
 *
 * A reserved word, and therefore a name no declaration can be addressed by: a
 * patch target has to be spelled exactly as its declaration spells it, so a
 * module whose entry point is `export default function (…)` offers this adapter
 * nothing to name and is skipped rather than guessed at. Not a handler name and
 * not a project-specific one — the language's own keyword.
 */
const UNADDRESSABLE_SYMBOL_NAMES: readonly string[] = Object.freeze(['default']);

/**
 * What an addressable symbol may look like.
 *
 * A plain identifier, or one of the qualified class-member spellings the patch
 * layer accepts (`Class.method`, `Class#method`, `Class.prototype.method`).
 * Anything else — a computed name, a string key, a binding pattern — is a name
 * the transform would refuse, so it is never proposed.
 */
const ADDRESSABLE_SYMBOL_PATTERN = /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*$/;

/**
 * A generator's asterisk in front of a `function` keyword.
 *
 * Used by {@link looksLikeGeneratorDeclaration}; see that function for why the
 * check is textual and what its authority is.
 */
const GENERATOR_FUNCTION_PATTERN = /\bfunction\s*\*/;

/** A generator method's asterisk, immediately before the member's name. */
const GENERATOR_MEMBER_PATTERN = /\*\s*$/;

/**
 * The wildcard member of the imported HTTP method vocabulary.
 *
 * Not an HTTP method: it is what a route reports when a single entry point
 * serves every method, which is the shape of a legacy API module with one
 * default export and nothing per-method to enumerate. Typed as
 * {@link HttpMethodName} so the value is checked against the vocabulary
 * `@debuggen/code-analysis` owns rather than asserted here.
 */
const WILDCARD_METHOD: HttpMethodName = 'ANY';

/** The route node kind that answers requests, as opposed to a rendered page module. */
const REQUEST_ROUTE_KIND = 'route-handler';

/** The edge kind that carries "this handler invokes that function". */
const CALLS_EDGE: CodeEdge['kind'] = 'calls';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * How the service spells the relaunch a developer needs, when it knows better
 * than a default can.
 *
 * Every field is injected so the hint can be exact while this file stays free
 * of environment reads and of any assumption about how the target project is
 * started (AAP §0.5.5).
 *
 * With no {@link NextJsAdapterRelaunchDescriptor.preloadSpecifier} — which is
 * how `../registry.ts` constructs this adapter — the hint names only the editor
 * command "Debug Generator: Launch Dev Server" and the project root: this
 * adapter then knows no preload path the target can load, no ingest URL and no
 * credential, so any shell command it composed would fail or stay inert. With a
 * specifier, a hand-typed command is composed as well, from the specifier, the
 * {@link NextJsAdapterRelaunchDescriptor.devCommand} (or the package manager
 * the project summary reports) and a `NAME="$NAME"` reference for every
 * {@link NextJsAdapterRelaunchDescriptor.envVarNames} entry.
 *
 * @example
 * ```ts
 * createNextJsAdapter({
 *   relaunch: {
 *     preloadSpecifier: 'file:///opt/debuggen/telemetry/node/register.mjs',
 *     envVarNames: ['DEBUGGEN_INGEST_URL', 'DEBUGGEN_TOKEN'],
 *   },
 * });
 * // … By hand, with DEBUGGEN_INGEST_URL, DEBUGGEN_TOKEN exported: cd ‹root› &&
 * // DEBUGGEN_INGEST_URL="$DEBUGGEN_INGEST_URL" DEBUGGEN_TOKEN="$DEBUGGEN_TOKEN"
 * // NODE_OPTIONS="--import file:///opt/…/register.mjs" pnpm dev
 * ```
 */
export interface NextJsAdapterRelaunchDescriptor {
  /**
   * A module specifier the **target project** can load with `--import` — an
   * absolute `file:` URL or path, typically.
   *
   * The only field that turns on a hand-typed command. Never defaulted to
   * {@link DEBUGGEN_NODE_PRELOAD_SPECIFIER}, which a target cannot resolve.
   */
  readonly preloadSpecifier?: string | undefined;

  /**
   * The target's own dev-server command, exactly as it should be typed. Read
   * only alongside {@link NextJsAdapterRelaunchDescriptor.preloadSpecifier}.
   */
  readonly devCommand?: string | undefined;

  /**
   * The environment variables the launcher sets for the preloaded process.
   *
   * Names only, never values: the ingest URL and the per-launch credential are
   * minted by the launcher (AAP §0.5.6), and a hint that quoted one would be a
   * credential in a user interface. Each name is rendered in the hand-typed
   * command as the shell reference `NAME="$NAME"`, and the developer is told to
   * export them first, so the command hands the preload what it needs. Every
   * name must be a POSIX shell variable name; a descriptor with one that is not
   * gets the editor command only, never a command missing a variable.
   */
  readonly envVarNames?: readonly string[] | undefined;
}

/**
 * The injected, fully-defaulted knobs of {@link createNextJsAdapter}.
 *
 * There is nothing here an adapter could not be handed: the caps that bound how
 * much of a developer's project one plan may touch, the staleness window a
 * quiet preload is judged by, the clock and logger a suite substitutes, the
 * patcher factory a suite substitutes to keep a test off the filesystem, and
 * the relaunch descriptor above.
 */
export interface NextJsAdapterOptions {
  /**
   * How many route-handler method exports one plan may wrap. Defaults to
   * {@link NEXTJS_ADAPTER_LIMITS.maxRouteTargets}, clamped to
   * {@link NEXTJS_ADAPTER_LIMITS.maxTargetsCeiling}. `0` proposes no
   * route-handler targets at all.
   */
  readonly maxRouteTargets?: number | undefined;

  /**
   * How many server functions one plan may time. Defaults to
   * {@link NEXTJS_ADAPTER_LIMITS.maxFunctionTargets}, clamped to
   * {@link NEXTJS_ADAPTER_LIMITS.maxTargetsCeiling}. `0` proposes no
   * function-timing targets at all.
   */
  readonly maxFunctionTargets?: number | undefined;

  /**
   * How many `calls` hops a server function may be from a selected route before
   * it stops counting as part of that request. Defaults to
   * {@link NEXTJS_ADAPTER_LIMITS.maxDepth}, clamped to
   * {@link NEXTJS_ADAPTER_LIMITS.maxDepthCeiling}. `0` walks no `calls` edge,
   * leaving only functions named by the question or by the project scan.
   */
  readonly maxDepth?: number | undefined;

  /**
   * How long a connected preload may stay silent before readiness degrades.
   * Defaults to {@link NEXTJS_ADAPTER_LIMITS.heartbeatStalenessMs}.
   */
  readonly heartbeatStalenessMs?: number | undefined;

  /**
   * The clock, in epoch milliseconds.
   *
   * Defaults to the context's own clock and then to `nowEpochMs()`, so a suite
   * can assert an exact `checkedAt` and an exact staleness verdict without
   * freezing time globally.
   */
  readonly now?: (() => number) | undefined;

  /**
   * A logger this adapter prefers over the context's.
   *
   * The context always carries one, so this exists for the caller that wants
   * every line of *this* adapter's output on a logger of its own — a suite
   * asserting the lines, a service routing them to a per-adapter sink — and is
   * why it takes precedence rather than acting as a fallback.
   */
  readonly logger?: Logger | undefined;

  /**
   * The patcher factory, defaulting to `createPatcher` from
   * `../patch/patcher.js`.
   *
   * The seam that lets a suite drive {@link NextJsAdapter.install} with a
   * substitute and assert the ordering, the reporting and the failure handling
   * without touching a working tree. Production code never passes it: the real
   * sequence is the only one that records a backup before it writes.
   */
  readonly patcherFactory?: ((options: PatcherOptions) => Patcher) | undefined;

  /** How to spell the relaunch a developer needs. See the descriptor. */
  readonly relaunch?: NextJsAdapterRelaunchDescriptor | undefined;
}

/**
 * This adapter, as {@link createNextJsAdapter} returns it.
 *
 * An {@link InstrumentationAdapter} with two members narrowed: the literal id,
 * so a caller can compare against {@link NEXTJS_ADAPTER_ID} without widening,
 * and the claim declaration `../registry.ts` reads to resolve an action's
 * adapter and mode.
 */
export interface NextJsAdapter extends InstrumentationAdapter {
  /** Always {@link NEXTJS_ADAPTER_ID}. */
  readonly id: typeof NEXTJS_ADAPTER_ID;

  /** Always {@link NEXTJS_ADAPTER_CLAIMS}. */
  readonly claims: typeof NEXTJS_ADAPTER_CLAIMS;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

/** An `api-route` node, with its required route payload. */
type ApiRouteNode = CodeNodeOf<'api-route'>;

/** A `server-function` node, with its required payload. */
type ServerFunctionNode = CodeNodeOf<'server-function'>;

/** The options above, with every default resolved and every cap clamped. */
interface ResolvedOptions {
  readonly maxRouteTargets: number;
  readonly maxFunctionTargets: number;
  readonly maxDepth: number;
  readonly heartbeatStalenessMs: number;
  readonly now: (() => number) | undefined;
  readonly logger: Logger | undefined;
  readonly patcherFactory: (options: PatcherOptions) => Patcher;
  readonly relaunch: NextJsAdapterRelaunchDescriptor;
}

/**
 * How strong the evidence for a route was, expressed as a rank so a mixed set
 * of candidates has one total order.
 *
 * Lower is better, and the gaps leave room for the per-hop penalty a reachable
 * server function carries: a function called directly by a route the question
 * named outranks one two hops away, and both outrank a function that is merely
 * present in the project.
 */
const ROUTE_RANKS = Object.freeze({
  /** The route a URL in the question resolved to, through the route map. */
  url: 0,

  /** A route whose path matched a name or a search hint in the question. */
  name: 10,

  /** A route this project happens to declare, with nothing pointing at it. */
  project: 20,
});

/** The rank a server function named directly by the question carries. */
const NAMED_FUNCTION_RANK = 15;

/** The rank a server function no selected route reaches carries. */
const UNREACHED_FUNCTION_RANK = 40;

/** One route the plan may wrap, with the evidence that selected it. */
interface RouteCandidate {
  readonly node: ApiRouteNode;
  readonly entry: RouteEntry | undefined;
  readonly rank: number;
}

/** One server function the plan may time, with the evidence that selected it. */
interface FunctionCandidate {
  readonly node: ServerFunctionNode;
  readonly rank: number;
  readonly hops: number;
  readonly viaRoutePath: string | undefined;
}

/** What the observed `server-agent` facts say about this project's preload. */
type PreloadState = 'attached' | 'silent' | 'absent';

/** The preload verdict, with the evidence a reason and a hint are written from. */
interface PreloadVerdict {
  readonly state: PreloadState;
  readonly silentForMs: number | undefined;
}

/**
 * The bound `../schema/plan.ts` puts on an action's `rationale`.
 *
 * Restated rather than imported because that module keeps its
 * `MAX_RATIONALE_LENGTH` private. The two cannot drift unnoticed: the suite
 * parses every action this adapter emits against `instrumentationActionSchema`,
 * which applies the real number. A `reason` and a `hint` are measured against
 * `READINESS_REASON_MAX_LENGTH` and `READINESS_HINT_MAX_LENGTH`, which the
 * readiness schema exports for exactly that purpose.
 */
const MAX_RATIONALE_CHARS = 500;

/** The conventional script name a dev server is started by. */
const DEV_SCRIPT_NAME = 'dev';

/**
 * How each package manager runs a script.
 *
 * A total table over the imported vocabulary, so a manager added to
 * `@debuggen/code-analysis` fails this declaration until it says something
 * about the new case. `undefined` is a real answer: a project whose manager
 * could not be determined gets the editor-command hint, which needs no shell
 * at all, instead of a command composed from a guess.
 */
const RUN_SCRIPT_PREFIXES: Readonly<Record<PackageManagerName, string | undefined>> = Object.freeze(
  {
    pnpm: 'pnpm',
    npm: 'npm run',
    yarn: 'yarn',
    bun: 'bun run',
    unknown: undefined,
  },
);

// ---------------------------------------------------------------------------
// Options and text
// ---------------------------------------------------------------------------

/**
 * Clamps a caller's count into `[0, ceiling]`, falling back to a default.
 *
 * Zero is honoured rather than raised to one: a caller that asks for no route
 * targets, no function targets or no reachability hops is switching that part
 * of the proposal off, and silently proposing one target anyway would be this
 * adapter deciding to touch a file it was told not to. A value that is not a
 * finite number is not an instruction at all, so it falls back to the default.
 *
 * @param value The caller's value, if any.
 * @param fallback The documented default.
 * @param ceiling The hard ceiling.
 * @returns An integer in `[0, ceiling]`.
 */
function clampCount(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);

  if (floored < 0) {
    return 0;
  }

  return floored > ceiling ? ceiling : floored;
}

/**
 * Resolves {@link NextJsAdapterOptions} once, when the adapter is created.
 *
 * Done here rather than per call so every method of one adapter instance
 * measures a project by the same caps, and so a malformed cap is normalised in
 * one place instead of at each use.
 *
 * @param options The caller's options.
 * @returns The resolved options.
 */
function resolveOptions(options: NextJsAdapterOptions | undefined): ResolvedOptions {
  return {
    maxRouteTargets: clampCount(
      options?.maxRouteTargets,
      NEXTJS_ADAPTER_LIMITS.maxRouteTargets,
      NEXTJS_ADAPTER_LIMITS.maxTargetsCeiling,
    ),
    maxFunctionTargets: clampCount(
      options?.maxFunctionTargets,
      NEXTJS_ADAPTER_LIMITS.maxFunctionTargets,
      NEXTJS_ADAPTER_LIMITS.maxTargetsCeiling,
    ),
    maxDepth: clampCount(
      options?.maxDepth,
      NEXTJS_ADAPTER_LIMITS.maxDepth,
      NEXTJS_ADAPTER_LIMITS.maxDepthCeiling,
    ),
    heartbeatStalenessMs: clampCount(
      options?.heartbeatStalenessMs,
      NEXTJS_ADAPTER_LIMITS.heartbeatStalenessMs,
      Number.MAX_SAFE_INTEGER,
    ),
    now: options?.now,
    logger: options?.logger,
    patcherFactory: options?.patcherFactory ?? createPatcher,
    relaunch: options?.relaunch ?? {},
  };
}

/**
 * The logger every line of one call goes to: the caller's if it supplied one,
 * otherwise the session's, in both cases bound to this adapter's id so a line
 * is attributable without every message repeating it.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns A child logger tagged with this adapter's id.
 */
function loggerFor(context: InstrumentationContext, options: ResolvedOptions): Logger {
  return (options.logger ?? context.logger).child({ adapter: NEXTJS_ADAPTER_ID });
}

/**
 * The clock this call reads: the caller's, then the context's, then the wall
 * clock.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns A clock in epoch milliseconds.
 */
function clockFor(context: InstrumentationContext, options: ResolvedOptions): () => number {
  return options.now ?? context.now ?? nowEpochMs;
}

/**
 * Collapses every run of whitespace to a single space and trims both ends.
 *
 * @param text The composed text.
 * @returns The same words on one line.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Collapses whitespace and enforces the single-line, bounded shape a
 * developer-facing field has to have.
 *
 * The bound is the one of the field being shaped, passed by the caller rather
 * than assumed: {@link READINESS_REASON_MAX_LENGTH} for a `reason` and for a
 * failure message, {@link READINESS_HINT_MAX_LENGTH} for a `hint`, and
 * {@link MAX_RATIONALE_CHARS} for a rationale. The receiving schema refuses a
 * multi-line or over-long string at the boundary, and a refusal there would
 * drop the one sentence that told the developer what happened.
 *
 * Truncation is a guard for prose composed from this module's own fixed words,
 * which is far inside every bound. It is never how a hint that carries a
 * command is fitted: {@link firstFitting} chooses a shorter complete spelling
 * instead, because a command with its tail cut off still runs.
 *
 * @param text The composed text.
 * @param bound The longest string the receiving field accepts, in characters.
 * @returns The same text as one line of at most `bound` characters.
 */
function singleLine(text: string, bound: number): string {
  const collapsed = collapseWhitespace(text);

  if (collapsed.length <= bound) {
    return collapsed;
  }

  return `${collapsed.slice(0, bound - 1)}…`;
}

/**
 * Whether a string contains a C0, DEL or C1 control character.
 *
 * A code-point scan rather than a regular expression, because a character class
 * over the control ranges is itself a lint failure (`no-control-regex`).
 * Whitespace collapsing does not remove every control character — a bell or an
 * escape is not whitespace — and the readiness schema refuses a `hint` that
 * carries one, which would discard the whole report over one path.
 *
 * @param text The text to inspect.
 * @returns `true` when any code point is a control character.
 */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (code <= C0_CONTROL_MAX || (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX)) {
      return true;
    }
  }

  return false;
}

/**
 * The first candidate that fits `bound` as one line, returned whole.
 *
 * How a hint carrying injected, unbounded material — a project root, a preload
 * specifier, a dev command, environment variable names — is fitted to its
 * field: the caller spells the same instruction from most to least prose, each
 * spelling complete in itself, and nothing is ever cut out of the middle of a
 * command. A developer who copies a sliced command runs it. A candidate that
 * still carries a control character once its whitespace is collapsed — a
 * project root with an escape in its name, say — is passed over the same way,
 * so the next, root-free spelling is used instead of a hint the schema refuses.
 *
 * @param candidates The instruction, from the most to the least complete
 * spelling.
 * @param fallback The spelling built only from this module's own fixed words,
 * for when no candidate fits. It is far inside every bound; it passes through
 * {@link singleLine} anyway, so the result is bounded whatever a caller passes.
 * @param bound The longest string the receiving field accepts, in characters.
 * @returns The first candidate that fits, or the bounded fallback.
 */
function firstFitting(candidates: readonly string[], fallback: string, bound: number): string {
  for (const candidate of candidates) {
    const line = collapseWhitespace(candidate);

    if (line.length <= bound && !hasControlCharacter(line)) {
      return line;
    }
  }

  return singleLine(fallback, bound);
}

/**
 * Whether `specifier` can be typed inside `NODE_OPTIONS="--import ‹specifier›"`
 * exactly as it is.
 *
 * `NODE_OPTIONS` splits its value on whitespace, and a double-quoted shell word
 * gives `"`, `$`, `` ` `` and `\` a meaning of their own, so a specifier holding
 * any of them — or a control character — would be a different command once
 * typed. Such a specifier gets no hand-typed command: the editor command, which
 * needs none, is exact whatever the path looks like.
 *
 * @param specifier The injected specifier.
 * @returns `true` when the specifier survives the command line unchanged.
 */
function isTypeableSpecifier(specifier: string): boolean {
  return specifier.length > 0 && !/[\s"$`\\]/u.test(specifier) && !hasControlCharacter(specifier);
}

/**
 * A directory as one POSIX shell word: as it is when every character is inert
 * in a shell, otherwise single-quoted with each embedded quote closed, escaped
 * and reopened (`'\''`), so `cd` receives the path byte for byte.
 *
 * @param path The directory.
 * @returns The path, safe to follow `cd `.
 */
function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/u.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The two spellings of a hand-typed relaunch: naming the project root, and relative to it. */
interface HandTypedRelaunch {
  /** The instruction with the root as the command's directory. */
  readonly rooted: string;

  /** The same instruction, told to run from the project root. */
  readonly rootless: string;
}

/**
 * The hand-typed relaunch a caller's descriptor makes exact, or `undefined`
 * when it does not make one exact.
 *
 * Composed only from what was injected, or read from the project summary as
 * data — never from the environment:
 *
 * - the preload from {@link NextJsAdapterRelaunchDescriptor.preloadSpecifier},
 *   which must be present and typeable ({@link isTypeableSpecifier}); the
 *   published {@link DEBUGGEN_NODE_PRELOAD_SPECIFIER} is never substituted,
 *   because a target project cannot resolve it;
 * - one `NAME="$NAME"` reference per
 *   {@link NextJsAdapterRelaunchDescriptor.envVarNames} entry, in front of the
 *   preload, so the line hands the preload the ingest URL and credential the
 *   developer exported — the instruction says to export them first. A name
 *   that is not a shell variable name makes the whole command unavailable
 *   rather than one variable short;
 * - the dev command from {@link NextJsAdapterRelaunchDescriptor.devCommand},
 *   or the package manager's run prefix and the conventional dev script. With
 *   neither, the instruction is the assignments to put in front of whatever
 *   command the developer uses.
 *
 * A spelling that ends in a command ends *without* punctuation, so a developer
 * who selects to the end of the line copies nothing the shell would read.
 *
 * @param context The session's context, for the project root and the summary.
 * @param relaunch The injected descriptor.
 * @param names The injected variable names, de-duplicated and sorted.
 * @returns Both spellings, or `undefined` when no exact command can be composed.
 */
function handTypedRelaunch(
  context: InstrumentationContext,
  relaunch: NextJsAdapterRelaunchDescriptor,
  names: readonly string[],
): HandTypedRelaunch | undefined {
  const specifier = relaunch.preloadSpecifier?.trim();

  if (specifier === undefined || !isTypeableSpecifier(specifier)) {
    return undefined;
  }

  if (!names.every((name) => SHELL_VARIABLE_NAME_PATTERN.test(name))) {
    return undefined;
  }

  const injectedCommand = relaunch.devCommand?.trim();
  const prefix = RUN_SCRIPT_PREFIXES[context.projectSummary.packageManager];
  const devCommand =
    injectedCommand !== undefined && injectedCommand !== ''
      ? injectedCommand
      : prefix === undefined
        ? undefined
        : `${prefix} ${DEV_SCRIPT_NAME}`;
  const assignments = [
    ...names.map((name) => `${name}="$${name}"`),
    `NODE_OPTIONS="--import ${specifier}"`,
  ].join(' ');
  const byHand = names.length === 0 ? 'By hand' : `By hand, with ${names.join(', ')} exported`;
  const root = context.projectRoot;

  if (devCommand === undefined) {
    return {
      rooted: `${byHand}, start the dev server from ${root} with ${assignments} in front of its command.`,
      rootless: `${byHand}, start the dev server from the project root with ${assignments} in front of its command.`,
    };
  }

  return {
    rooted: `${byHand}: cd ${shellWord(root)} && ${assignments} ${devCommand}`,
    rootless: `${byHand}, from the project root: ${assignments} ${devCommand}`,
  };
}

/**
 * The relaunch instruction for a project whose dev server carries no preload,
 * as one line within {@link READINESS_HINT_MAX_LENGTH}.
 *
 * **By default — no {@link NextJsAdapterRelaunchDescriptor.preloadSpecifier}
 * injected, which is how `../registry.ts` builds this adapter — the hint is the
 * editor command alone**: "Run "Debug Generator: Launch Dev Server" in VS Code
 * for ‹root›, which starts this project's dev server with the preload and a
 * fresh ingest credential." That command is exact — the service launches the
 * dev server with its own preload path and a freshly minted credential (AAP
 * §0.5.6) — while any shell line this adapter could compose unaided would name
 * a preload the target cannot resolve and set no credential, which is the
 * defect this composition exists to avoid. The service replaces this text with
 * its own exact command wherever its dev-server detection has one
 * (`apps/local-service/src/dev-server/detect.ts`), so this is the fallback.
 *
 * With a typeable specifier injected, the editor command still leads — it needs
 * no shell and no credential of its own — and {@link handTypedRelaunch} follows
 * it. Everything but this module's own words is injected and unbounded, so the
 * line is fitted by {@link firstFitting}, never by cutting; the spellings, most
 * complete first:
 *
 * 1. The editor sentence, then the hand-typed command naming the root.
 * 2. The editor label alone, then that command.
 * 3. and 4. The same two with the command relative to the project root, for a
 *    root too long to fit — a deeply nested checkout.
 * 5. The editor sentence naming the root, with the variable names it sets, for
 *    a specifier, dev command or variable list so long that no spelling of the
 *    command fits. A missing command sends the developer to the editor command,
 *    which needs none; a truncated one, or one missing a variable, would run.
 * 6. The same without the variable names, when they alone do not fit.
 * 7. The same without the root but with the variable names.
 * 8. The editor sentence alone, built only from this module's own words.
 *
 * The project root is named at most **once**: inside the command when there is
 * one, since that is where it is actionable, and otherwise after the editor
 * command. Nothing is read from the environment.
 *
 * @param context The session's context, for the project root and the summary.
 * @param options The resolved options, for the injected descriptor.
 * @returns A single, never-truncated line within the hint bound, naming the
 * project root whenever a spelling carrying it fits.
 */
function relaunchHint(context: InstrumentationContext, options: ResolvedOptions): string {
  const root = context.projectRoot;
  const names = [...new Set(options.relaunch.envVarNames ?? [])].sort();
  const variables = names.join(', ');
  const editor = `Run "${LAUNCH_COMMAND_LABEL}" in VS Code`;
  const effect =
    "which starts this project's dev server with the preload and a fresh ingest credential";
  const sets = variables === '' ? '' : ` (it sets ${variables} for you)`;

  // The editor-only spellings: the whole ladder by default, and the tail of the
  // ladder when a hand-typed command is on offer but too long to fit.
  const editorOnly = [
    `${editor} for ${root}, ${effect}${sets}.`,
    ...(sets === '' ? [] : [`${editor} for ${root}, ${effect}.`, `${editor}, ${effect}${sets}.`]),
  ];
  const fallback = `${editor}, ${effect}.`;
  const byHand = handTypedRelaunch(context, options.relaunch, names);

  if (byHand === undefined) {
    return firstFitting(editorOnly, fallback, READINESS_HINT_MAX_LENGTH);
  }

  return firstFitting(
    [
      `${editor}, ${effect}. ${byHand.rooted}`,
      `${editor}. ${byHand.rooted}`,
      `${editor}, ${effect}. ${byHand.rootless}`,
      `${editor}. ${byHand.rootless}`,
      ...editorOnly,
    ],
    fallback,
    READINESS_HINT_MAX_LENGTH,
  );
}

/**
 * Why a signal could not be enabled, in the developer's terms, as a fragment
 * that reads after "Could not enable ‹signal›: ".
 *
 * @param signal The signal being reported.
 * @param verdict The preload verdict.
 * @returns The reason fragment.
 */
function reasonFor(signal: CaptureSignal, verdict: PreloadVerdict): string {
  const patched = signal === PATCHED_SPAN_SIGNAL;

  if (verdict.state === 'absent') {
    return singleLine(
      patched
        ? 'no Debug Generator preload is attached to the dev server for this project, so nothing would receive a function span and no file was modified'
        : 'no Debug Generator preload is attached to the dev server for this project, so the framework produces no spans to collect',
      READINESS_REASON_MAX_LENGTH,
    );
  }

  const seconds = Math.round((verdict.silentForMs ?? 0) / 1000);

  return singleLine(
    patched
      ? `the dev-server preload for this project has not reported for ${seconds}s, so a function span may never arrive`
      : `the dev-server preload for this project has not reported for ${seconds}s, so its spans may never arrive`,
    READINESS_REASON_MAX_LENGTH,
  );
}

/**
 * What the developer can do about a missing or silent preload.
 *
 * A missing preload gets {@link relaunchHint}. A silent one gets the restart
 * instruction through the same editor command, named exactly as the VS Code
 * palette shows it; it names the project root when it fits the hint bound and
 * otherwise says "this project" — the sentence degrades by losing the root,
 * never by being cut.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @param verdict The preload verdict.
 * @returns The hint, within {@link READINESS_HINT_MAX_LENGTH} and never
 * truncated.
 */
function hintFor(
  context: InstrumentationContext,
  options: ResolvedOptions,
  verdict: PreloadVerdict,
): string {
  if (verdict.state === 'absent') {
    return relaunchHint(context, options);
  }

  return firstFitting(
    [
      `Restart the dev server for ${context.projectRoot} with "${LAUNCH_COMMAND_LABEL}" in VS Code so its preload reconnects.`,
    ],
    `Restart this project's dev server with "${LAUNCH_COMMAND_LABEL}" in VS Code so its preload reconnects.`,
    READINESS_HINT_MAX_LENGTH,
  );
}

/**
 * One {@link UnavailableSignal} per signal this adapter speaks for.
 *
 * Emitted together rather than one at a time because the four share one cause:
 * the process that would produce every one of them is missing or silent, and a
 * developer reading three of the four would be told the capture is narrower
 * than it is.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @param verdict The preload verdict.
 * @returns The entries, in {@link NEXTJS_SERVER_SIGNAL_KEYS} order.
 */
function preloadGaps(
  context: InstrumentationContext,
  options: ResolvedOptions,
  verdict: PreloadVerdict,
): UnavailableSignal[] {
  const hint = hintFor(context, options, verdict);

  return NEXTJS_SERVER_SIGNAL_KEYS.map((signal) => ({
    signal,
    reason: reasonFor(signal, verdict),
    hint,
  }));
}

// ---------------------------------------------------------------------------
// The preload verdict
// ---------------------------------------------------------------------------

/**
 * Whether an observed preload belongs to the project this session is about.
 *
 * Compared on the normalised POSIX form of both roots, because a preload
 * attached to a sibling workspace package would otherwise be read as readiness
 * for a project whose spans it will never produce.
 *
 * @param agent The observed connection.
 * @param projectRoot The session's project root.
 * @returns `true` when the connection is for this project.
 */
function belongsToProject(agent: ObservedServerAgent, projectRoot: string): boolean {
  return normalizePosix(toPosix(agent.projectRoot)) === normalizePosix(toPosix(projectRoot));
}

/**
 * Turns the observed `server-agent` facts into the one verdict every method of
 * this adapter reads.
 *
 * Three states, and the distinctions are the ones the facts actually support:
 *
 * - `'absent'` — no connection, a connection that has gone down, or a
 *   connection for another project. All three mean the same thing to a
 *   developer, and all three are fixed by the same relaunch.
 * - `'silent'` — connected, but the last frame is older than the configured
 *   window. The transport exists, so a configuration still reaches the preload;
 *   what is in doubt is whether spans are coming back.
 * - `'attached'` — connected and recent, or connected and not yet heard from.
 *   A connection that has not spoken *yet* is not evidence of silence: the
 *   preload announces itself on connect, so the absence of a heartbeat is a
 *   service-side gap in bookkeeping rather than a fact about the process.
 *
 * No port is opened, no process is spawned and no environment variable is read
 * — the injected facts are the whole input (AAP §0.2.3).
 *
 * @param context The session's context.
 * @param options The resolved options, for the staleness window.
 * @param clock The clock this call reads.
 * @returns The verdict.
 */
function preloadVerdict(
  context: InstrumentationContext,
  options: ResolvedOptions,
  clock: () => number,
): PreloadVerdict {
  const agent = context.readiness.serverAgent;

  if (agent === undefined || !agent.connected || !belongsToProject(agent, context.projectRoot)) {
    return { state: 'absent', silentForMs: undefined };
  }

  const lastHeartbeatAt = agent.lastHeartbeatAt;

  if (lastHeartbeatAt === undefined) {
    return { state: 'attached', silentForMs: undefined };
  }

  const silentForMs = Math.max(clock() - lastHeartbeatAt, 0);

  if (silentForMs > options.heartbeatStalenessMs) {
    return { state: 'silent', silentForMs };
  }

  return { state: 'attached', silentForMs };
}

// ---------------------------------------------------------------------------
// Target selection — every candidate comes from the code graph
// ---------------------------------------------------------------------------

/** The action type a wrapped route handler is installed as. */
const SERVER_SPAN_TYPE = NEXTJS_ADAPTER_CLAIMS[0].type;

/** The action type a timed server function is installed as. */
const FUNCTION_TIMING_TYPE = NEXTJS_ADAPTER_CLAIMS[1].type;

/**
 * How many seeds one plan takes from the understanding.
 *
 * The understanding's own schema already bounds its entity and hint lists; this
 * bound is about query cost, so a long list of near-duplicate hints cannot turn
 * a proposal into a scan of the project once per hint.
 */
const MAX_SEEDS = 12;

/**
 * Byte-wise string order, for every comparator below.
 *
 * Not locale-aware on purpose: two runs on two machines must order a candidate
 * list identically, and a locale collation is the one comparison that would not
 * (the same reason `@debuggen/code-analysis` gives for its own comparators).
 *
 * @param left The first string.
 * @param right The second.
 * @returns `-1`, `0` or `1`.
 */
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/** Whether this project has a server tier this adapter could target at all. */
function hasServerTier(context: InstrumentationContext): boolean {
  return (
    context.graph.nodesByKind('api-route').length > 0 ||
    context.graph.nodesByKind('server-function').length > 0
  );
}

/** Whether the understanding asks for any of the given signals. */
function needsAny(understanding: ProblemUnderstanding, signals: readonly CaptureSignal[]): boolean {
  return signals.some((signal) => understanding.signalsNeeded.includes(signal));
}

/**
 * Whether a value is worth handing to the route map as a request path.
 *
 * A pathname or an absolute URL; anything else is a name, and names go to
 * `findByName` instead. The route map itself owns every other part of the
 * question — route groups, dynamic segments, specificity, decoding — and is
 * never re-implemented here.
 *
 * @param value A name or hint from the understanding.
 * @returns `true` when the route map can be asked about it.
 */
function looksLikeRequestPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('http://') || value.startsWith('https://');
}

/**
 * The names and hints the question supplied, most relevant first and bounded.
 *
 * Entities come first and in their own order, because the understanding's
 * producer orders them most-relevant-first; search hints follow. Duplicates are
 * dropped so a name repeated as both an entity and a hint costs one query.
 *
 * @param understanding The validated problem understanding.
 * @returns The seeds, in order.
 */
function seedsOf(understanding: ProblemUnderstanding): readonly string[] {
  const seen = new Set<string>();
  const seeds: string[] = [];

  for (const value of [
    ...understanding.entities.map((entity) => entity.name),
    ...understanding.searchHints,
  ]) {
    const trimmed = value.trim();

    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    seeds.push(trimmed);

    if (seeds.length >= MAX_SEEDS) {
      break;
    }
  }

  return seeds;
}

/** The route modules of this project that answer requests, in graph order. */
function requestRoutes(context: InstrumentationContext): readonly ApiRouteNode[] {
  return context.graph
    .nodesByKind('api-route')
    .filter((node) => node.data.kind === REQUEST_ROUTE_KIND);
}

/**
 * The route map's entry for each route file.
 *
 * Kept as a lookup rather than searched per candidate, and first-wins so the
 * map's own order decides which entry describes a file that appears twice.
 *
 * @param context The session's context.
 * @returns The entries by project-relative file.
 */
function routeEntriesByFile(context: InstrumentationContext): ReadonlyMap<string, RouteEntry> {
  const byFile = new Map<string, RouteEntry>();

  for (const entry of context.routeMap.entries) {
    if (!byFile.has(entry.file)) {
      byFile.set(entry.file, entry);
    }
  }

  return byFile;
}

/**
 * The routes this plan may wrap, best evidence first.
 *
 * Three tiers, in the order AAP §0.5.4 requires evidence to be used: a request
 * path from the question resolved through the route map, then a name or hint
 * matched against the graph's own route nodes, then — only when neither
 * narrowed anything — the project's routes as the graph reports them. A route
 * selected by a stronger tier keeps that tier.
 *
 * @param context The session's context.
 * @param understanding The validated problem understanding.
 * @param options The resolved options.
 * @returns The candidates, ordered by rank, then file, then line.
 */
function routeCandidates(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  options: ResolvedOptions,
): readonly RouteCandidate[] {
  if (options.maxRouteTargets === 0) {
    return [];
  }

  const routes = requestRoutes(context);

  if (routes.length === 0) {
    return [];
  }

  const entries = routeEntriesByFile(context);
  const nodesByFile = new Map<string, ApiRouteNode>();

  for (const node of routes) {
    if (!nodesByFile.has(node.file)) {
      nodesByFile.set(node.file, node);
    }
  }

  const best = new Map<string, RouteCandidate>();

  const consider = (node: ApiRouteNode, rank: number): void => {
    const existing = best.get(node.id);

    if (existing !== undefined && existing.rank <= rank) {
      return;
    }

    best.set(node.id, { node, entry: entries.get(node.file), rank });
  };

  const seeds = seedsOf(understanding);

  for (const seed of seeds) {
    if (!looksLikeRequestPath(seed)) {
      continue;
    }

    // The route map is the product's single URL <-> route-file algorithm; the
    // query surface wraps it, and the map itself answers the pathname form the
    // query surface declines.
    const file =
      context.queries.routeForUrl(seed)?.file ?? context.routeMap.resolve(seed)?.entry.file;
    const node = file === undefined ? undefined : nodesByFile.get(file);

    if (node !== undefined) {
      consider(node, ROUTE_RANKS.url);
    }
  }

  for (const seed of seeds) {
    for (const match of context.queries.findByName(seed, {
      kinds: ['api-route'],
      limit: options.maxRouteTargets,
    })) {
      const node = context.graph.nodeById(match.nodeId);

      if (node?.kind === 'api-route' && node.data.kind === REQUEST_ROUTE_KIND) {
        consider(node, ROUTE_RANKS.name);
      }
    }
  }

  for (const node of routes) {
    consider(node, ROUTE_RANKS.project);
  }

  return [...best.values()].sort(
    (left, right) =>
      left.rank - right.rank ||
      compareText(left.node.file, right.node.file) ||
      left.node.line - right.node.line ||
      compareText(left.node.id, right.node.id),
  );
}

/** One route handler this plan may wrap. */
interface MethodTarget {
  readonly method: HttpMethodName;
  readonly file: string;
  readonly symbol: string;
  readonly line: number;
}

/**
 * The method handlers one route module exports, as patch targets.
 *
 * The method names are the route's own, from the vocabulary
 * `@debuggen/code-analysis` owns — never a table written here — and each
 * target's symbol is taken from the route map's per-method location where there
 * is one, so the name the patch addresses is the name the index recorded rather
 * than a convention assumed here.
 *
 * The wildcard member is the legacy single-entry-point shape: it names no
 * method export, so its symbol has to come from the route's recorded handler,
 * and a module whose entry point is an anonymous default export therefore
 * yields nothing — there is no name a patch could address.
 *
 * @param candidate The selected route.
 * @returns The targets, in source order.
 */
function methodTargets(candidate: RouteCandidate): readonly MethodTarget[] {
  const { node, entry } = candidate;
  const targets: MethodTarget[] = [];

  for (const method of node.data.methods) {
    const methodLocation = entry?.methodLocations?.[method];
    const symbol =
      method === WILDCARD_METHOD
        ? (methodLocation?.symbol ?? entry?.location.symbol ?? node.symbol)
        : (methodLocation?.symbol ?? method);

    if (symbol === undefined) {
      continue;
    }

    const fallbackLine =
      method === WILDCARD_METHOD ? (entry?.location.line ?? node.line) : node.line;

    targets.push({
      method,
      file: node.file,
      symbol,
      line: methodLocation?.line ?? fallbackLine,
    });
  }

  return targets.sort(
    (left, right) =>
      left.line - right.line ||
      HTTP_METHOD_NAMES.indexOf(left.method) - HTTP_METHOD_NAMES.indexOf(right.method) ||
      compareText(left.symbol, right.symbol),
  );
}

/**
 * The server functions this plan may time, best evidence first.
 *
 * Reachability is read from the graph's `calls` edges, seeded with the selected
 * route node *and* the declarations of its module — the two shapes the code
 * graph's reachability invariant permits, since a route's handler calls may be
 * recorded against the route node itself or against the method export's symbol
 * node. Each hop costs a rank, so a function the handler calls directly
 * outranks one behind it, and a function no selected route reaches ranks below
 * one the question named.
 *
 * @param context The session's context.
 * @param understanding The validated problem understanding.
 * @param routes The selected routes.
 * @param options The resolved options.
 * @returns The candidates, ordered by rank, then file, then line.
 */
function functionCandidates(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  routes: readonly RouteCandidate[],
  options: ResolvedOptions,
): readonly FunctionCandidate[] {
  if (options.maxFunctionTargets === 0) {
    return [];
  }

  const functions = context.graph.nodesByKind('server-function');

  if (functions.length === 0) {
    return [];
  }

  const byId = new Map<string, ServerFunctionNode>(functions.map((node) => [node.id, node]));
  const best = new Map<string, FunctionCandidate>();

  const consider = (
    node: ServerFunctionNode,
    rank: number,
    hops: number,
    viaRoutePath: string | undefined,
  ): void => {
    const existing = best.get(node.id);

    if (existing !== undefined && existing.rank <= rank) {
      return;
    }

    best.set(node.id, { node, rank, hops, viaRoutePath });
  };

  for (const route of routes) {
    const visited = new Set<string>([route.node.id]);
    let frontier: string[] = [route.node.id];

    for (const declaration of context.graph.nodesByFile(route.node.file)) {
      if (declaration.kind === 'symbol' && !visited.has(declaration.id)) {
        visited.add(declaration.id);
        frontier.push(declaration.id);
      }
    }

    for (let hop = 1; hop <= options.maxDepth && frontier.length > 0; hop += 1) {
      const next: string[] = [];

      for (const id of frontier) {
        for (const edge of context.graph.outgoing(id, CALLS_EDGE)) {
          if (visited.has(edge.to)) {
            continue;
          }

          visited.add(edge.to);
          next.push(edge.to);

          const called = byId.get(edge.to);

          if (called !== undefined) {
            consider(called, route.rank + hop, hop, route.node.data.routePath);
          }
        }
      }

      frontier = next;
    }
  }

  for (const seed of seedsOf(understanding)) {
    for (const match of context.queries.findByName(seed, {
      kinds: ['server-function'],
      limit: options.maxFunctionTargets,
    })) {
      const named = byId.get(match.nodeId);

      if (named !== undefined) {
        consider(named, NAMED_FUNCTION_RANK, 0, undefined);
      }
    }
  }

  for (const node of functions) {
    consider(node, UNREACHED_FUNCTION_RANK, 0, undefined);
  }

  return [...best.values()].sort(
    (left, right) =>
      left.rank - right.rank ||
      compareText(left.node.file, right.node.file) ||
      left.node.line - right.node.line ||
      compareText(left.node.name, right.node.name),
  );
}

/**
 * The bare name a qualified symbol spelling ends in.
 *
 * `'Class.method'` and `'Class#method'` address a class member, and it is the
 * member's own name that appears at the declaration this module reads.
 *
 * @param symbol The symbol as a plan would spell it.
 * @returns The last segment.
 */
function baseSymbolName(symbol: string): string {
  const segments = symbol.split(/[.#]/u);

  return segments[segments.length - 1] ?? symbol;
}

/**
 * Whether the declaration at this position is a generator.
 *
 * **A textual pre-filter, and deliberately not an authority.** The code graph
 * records no generator flag — a generator export is an ordinary
 * `server-function` node — so the only way to tell before proposing a target is
 * to look at the declaration's own line through the bounded excerpt the query
 * surface provides. A generator has no function-timing template (a wrapper that
 * calls the body as a function cannot preserve `yield`), so proposing one would
 * put a target in the plan a developer reads that `../feasibility.ts` and the
 * patcher are both going to refuse.
 *
 * The authority stays with them: when no excerpt is available — a session with
 * no loaded project, a file the project does not hold — this answers `false`,
 * the target is proposed, and the refusal that follows is reported as a gap
 * rather than being silently guessed at here.
 *
 * @param queries The bounded query surface.
 * @param file The declaring file, project-relative POSIX.
 * @param line The declaration's 1-based line.
 * @param symbol The symbol being addressed.
 * @returns `true` when the line reads as a generator declaration.
 */
function looksLikeGeneratorDeclaration(
  queries: CodeQueries,
  file: string,
  line: number,
  symbol: string,
): boolean {
  const excerpt = queries.excerpt({ file, line }, { contextLines: 0 });

  if (excerpt === undefined) {
    return false;
  }

  const index = excerpt.text.indexOf(baseSymbolName(symbol));
  const prefix = index < 0 ? excerpt.text : excerpt.text.slice(0, index);

  return GENERATOR_FUNCTION_PATTERN.test(prefix) || GENERATOR_MEMBER_PATTERN.test(prefix);
}

/**
 * Whether a target is one the patch layer can actually rewrite.
 *
 * Three gates, each for a refusal that would otherwise reach the developer's
 * plan: a name no declaration can be addressed by, a `(file, symbol)` pair the
 * graph has no declaration for — the same lookup `../feasibility.ts` performs
 * before anything is written — and a generator, which has no template.
 *
 * @param context The session's context.
 * @param file The declaring file, project-relative POSIX.
 * @param symbol The symbol to wrap.
 * @param line The declaration's 1-based line.
 * @param logger Where a skipped target is recorded.
 * @returns `true` when the target may be proposed.
 */
function isPatchable(
  context: InstrumentationContext,
  file: string,
  symbol: string,
  line: number,
  logger: Logger,
): boolean {
  if (UNADDRESSABLE_SYMBOL_NAMES.includes(symbol) || !ADDRESSABLE_SYMBOL_PATTERN.test(symbol)) {
    logger.debug('skipping a target whose name cannot address a declaration', { file, symbol });

    return false;
  }

  if (!context.queries.hasSymbol(file, symbol)) {
    logger.debug('skipping a target the code graph has no declaration for', { file, symbol });

    return false;
  }

  if (looksLikeGeneratorDeclaration(context.queries, file, line, symbol)) {
    logger.debug('skipping a generator declaration, which has no timing template', {
      file,
      symbol,
    });

    return false;
  }

  return true;
}

/**
 * Builds one action, with the identity fields this adapter owns.
 *
 * @param file The declaring file, project-relative POSIX.
 * @param symbol The symbol to wrap.
 * @param type The claimed action type.
 * @param rationale Why the action is in the plan.
 * @returns The action.
 */
function buildAction(
  file: string,
  symbol: string,
  type: InstrumentationActionType,
  rationale: string,
): InstrumentationAction {
  return {
    id: newActionId(),
    file,
    symbol,
    type,
    adapter: NEXTJS_ADAPTER_ID,
    mode: PATCH_MODE,
    rationale: singleLine(rationale, MAX_RATIONALE_CHARS),
  };
}

/**
 * The `server-span` actions for the selected routes, capped independently of
 * the function family.
 *
 * @param context The session's context.
 * @param candidates The selected routes, best first.
 * @param options The resolved options.
 * @param logger Where a skipped target is recorded.
 * @returns The actions, in selection order.
 */
function routeActions(
  context: InstrumentationContext,
  candidates: readonly RouteCandidate[],
  options: ResolvedOptions,
  logger: Logger,
): InstrumentationAction[] {
  const actions: InstrumentationAction[] = [];

  for (const candidate of candidates) {
    for (const target of methodTargets(candidate)) {
      if (actions.length >= options.maxRouteTargets) {
        return actions;
      }

      if (!isPatchable(context, target.file, target.symbol, target.line, logger)) {
        continue;
      }

      const routePath = candidate.node.data.routePath;
      const rationale =
        target.method === WILDCARD_METHOD
          ? `The code graph records ${routePath} as serving every method through the single handler ${target.symbol}, so a span around it times the work the framework dispatches to.`
          : `The code graph records ${routePath} as exporting the ${target.method} handler ${target.symbol}, so a span around it separates the handler from the rest of the request.`;

      actions.push(buildAction(target.file, target.symbol, SERVER_SPAN_TYPE, rationale));
    }
  }

  return actions;
}

/**
 * The `function-timing` actions for the selected server functions, capped
 * independently of the route family.
 *
 * @param context The session's context.
 * @param candidates The selected functions, best first.
 * @param options The resolved options.
 * @param logger Where a skipped target is recorded.
 * @returns The actions, in selection order.
 */
function functionActions(
  context: InstrumentationContext,
  candidates: readonly FunctionCandidate[],
  options: ResolvedOptions,
  logger: Logger,
): InstrumentationAction[] {
  const actions: InstrumentationAction[] = [];

  for (const candidate of candidates) {
    if (actions.length >= options.maxFunctionTargets) {
      return actions;
    }

    const { node } = candidate;

    if (!isPatchable(context, node.file, node.name, node.line, logger)) {
      continue;
    }

    const hopClause =
      candidate.viaRoutePath === undefined
        ? `an exported server function in ${node.file}`
        : `an exported server function ${candidate.hops === 1 ? 'called directly by the handler' : `called ${candidate.hops} call hops behind the handler`} of ${candidate.viaRoutePath}`;

    actions.push(
      buildAction(
        node.file,
        node.name,
        FUNCTION_TIMING_TYPE,
        `The code graph records ${node.name} as ${hopClause}, so timing it separates its own time from the rest of the request.`,
      ),
    );
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Installation support
// ---------------------------------------------------------------------------

/**
 * Whether an action belongs to this adapter.
 *
 * Id and type, and nothing else: a `mode` that disagrees with
 * {@link NEXTJS_ADAPTER_CLAIMS} is not silently corrected here, because the
 * patcher refuses a runtime-mode action with a message a developer can act on,
 * and that refusal reaching the installer through
 * {@link InstallResult.failure} is more useful than an action disappearing
 * from this adapter's view.
 *
 * @param action One action of a normalised plan.
 * @returns `true` when this adapter must install it.
 */
function isClaimedAction(action: InstrumentationAction): boolean {
  return action.adapter === NEXTJS_ADAPTER_ID && CLAIMED_ACTION_TYPES.includes(action.type);
}

/**
 * The order the patches are applied in: file, then declaration line, then
 * symbol, then action id.
 *
 * Deterministic because the journal is append-ordered and cleanup unwinds a
 * chain in strict reverse: two runs of the same plan must journal the same
 * sequence, or a chained file would be restored through a different
 * intermediate state. The declaration line comes from the code graph, so a file
 * holding two targets is patched top-down.
 *
 * @param actions The accepted actions.
 * @param queries The bounded query surface, for each declaration's position.
 * @returns A fresh array in application order.
 */
function orderForInstall(
  actions: readonly InstrumentationAction[],
  queries: CodeQueries,
): readonly InstrumentationAction[] {
  return actions
    .map((action) => ({
      action,
      line: queries.findSymbol(action.file, action.symbol)?.location.line ?? 0,
    }))
    .sort(
      (left, right) =>
        compareText(left.action.file, right.action.file) ||
        left.line - right.line ||
        compareText(left.action.symbol, right.action.symbol) ||
        compareText(left.action.id, right.action.id),
    )
    .map((entry) => entry.action);
}

/**
 * The patch the batch stopped on, as the fatal channel reports it.
 *
 * The patcher's own error is forwarded unchanged — its message and hint are
 * already written for a developer (an unsupported declaration, a baseline
 * conflict naming where the original is kept, a path that escapes the project,
 * a cancelled sequence) and `../installer.ts` quotes them rather than a
 * paraphrase. The signal is the patched-span signal in both families: what the
 * failed action would have supplied is the span its wrapper emits, never the
 * runtime spans the preload produces on its own.
 *
 * The record journaled for the attempt travels here and only here. Whatever
 * stage the sequence reached, it is the installer's to settle through the
 * reconciliation table — closed without a write when the file still holds the
 * original, restored when the file holds the patch — so it is forwarded even
 * when the rename never ran. The conflict report is forwarded for the caller
 * that shows it, and is never logged: it holds diffs.
 *
 * Optional members are spread rather than assigned, so an absent fact is an
 * absent key and not a key holding `undefined`.
 *
 * @param failure The failure the batch stopped on.
 * @returns The fatal-channel entry.
 */
function installFailureOf(failure: PatchBatchFailure): InstallFailure {
  return {
    error: failure.error,
    signal: PATCHED_SPAN_SIGNAL,
    file: failure.file,
    symbol: failure.symbol,
    ...(failure.actionId === undefined ? {} : { actionId: failure.actionId }),
    ...(failure.record === undefined ? {} : { record: failure.record }),
    ...(failure.conflict === undefined ? {} : { conflict: failure.conflict }),
  };
}

/**
 * The fatal-channel entry for an install cancelled before its first patch.
 *
 * A failure rather than a gap: the actions were accepted for install and none
 * of them will be, so the install as planned did not happen and the installer
 * must unwind whatever the adapters before this one applied — exactly as it
 * does for a cancellation it notices itself between groups.
 *
 * @param pending How many accepted actions were left unattempted.
 * @returns The fatal-channel entry.
 */
function cancelledBeforePatching(pending: number): InstallFailure {
  return {
    error: new DebuggenError(
      'INSTRUMENTATION_INSTALL_FAILED',
      // An explanation rather than a command, so it is held to the bound a
      // reason is: the sentence a developer reads about why nothing happened.
      singleLine(
        `The install was cancelled before ${String(pending)} planned target${pending === 1 ? ' was' : 's were'} patched.`,
        READINESS_REASON_MAX_LENGTH,
      ),
      {
        hint: 'Nothing was written for these targets. Start the capture again to install them.',
        details: { reason: 'aborted', pending },
      },
    ),
    signal: PATCHED_SPAN_SIGNAL,
  };
}

/**
 * The hooks an install armed, read off the derived signal set.
 *
 * Derived rather than assumed: a hook is listed when the signal that produces
 * it is on, so a developer told a hook is armed can rely on it.
 *
 * @param signals The derived signal set.
 * @returns The hook labels, sorted.
 */
function runtimeHooksFor(signals: ServerAgentSignals): string[] {
  const hooks: string[] = [];

  if (signals.http) {
    hooks.push(HOOK_SERVER_REQUESTS);
  }

  if (signals.routeHandlers) {
    hooks.push(HOOK_ROUTE_HANDLERS);
  }

  if (signals.fetch) {
    hooks.push(HOOK_OUTGOING_REQUESTS);
  }

  return hooks.sort();
}

/**
 * This adapter's contribution to the preload's signal set.
 *
 * The derivation in `../schema/readiness.js` owns the policy — including the
 * rule that the request and route-handler spans are switched on together,
 * because they are the spine a server trace hangs off — and this function only
 * narrows its answer to the keys this adapter speaks for. A key it derived as
 * off is **omitted** rather than contributed as `false`: a contribution states
 * what this adapter enabled, and a `false` would be a statement about a signal
 * another adapter may have asked for.
 *
 * @param signals The derived signal set.
 * @returns The partial contribution the installer merges.
 */
function narrowServerSignals(signals: ServerAgentSignals): Partial<ServerAgentSignals> {
  const contribution: {
    http?: boolean;
    routeHandlers?: boolean;
    fetch?: boolean;
    functions?: string[];
  } = {};

  if (signals.http) {
    contribution.http = true;
  }

  if (signals.routeHandlers) {
    contribution.routeHandlers = true;
  }

  if (signals.fetch) {
    contribution.fetch = true;
  }

  if (signals.functions.length > 0) {
    // A copy: the derivation returns a fresh array, and the installer owns
    // whatever it is handed, so nothing this adapter keeps can be mutated
    // underneath it.
    contribution.functions = [...signals.functions];
  }

  return contribution;
}

/** The readiness status one preload verdict implies. */
function readinessStatusOf(verdict: PreloadVerdict): ReadinessStatus {
  if (verdict.state === 'attached') {
    return 'available';
  }

  return verdict.state === 'silent' ? 'degraded' : 'unavailable';
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Builds the framework adapter.
 *
 * A factory rather than a class export, so `../registry.ts` can construct it
 * inside `createAdapterRegistry` and a suite can construct it with substituted
 * caps, clock, logger, relaunch text and patcher. **Importing this module has
 * no side effect**: nothing is constructed at module scope, no patcher is
 * built until an install runs, no state is kept between calls, and the package
 * manifest's `sideEffects: false` stays true through this file.
 *
 * @param options The injected, fully-defaulted knobs. See
 * {@link NextJsAdapterOptions}.
 * @returns The adapter, with its literal id and its claim declaration.
 *
 * @example
 * ```ts
 * const adapter = createNextJsAdapter();
 *
 * if (adapter.canHandle(context)) {
 *   const actions = await adapter.createPlan(context, understanding);
 *   const result = await adapter.install(actions, context);
 * }
 * ```
 */
export function createNextJsAdapter(options?: NextJsAdapterOptions): NextJsAdapter {
  const resolved = resolveOptions(options);

  return {
    id: NEXTJS_ADAPTER_ID,
    claims: NEXTJS_ADAPTER_CLAIMS,

    /**
     * Whether this project has a server tier worth targeting.
     *
     * Synchronous and graph-only: one indexed bucket read per node kind, no
     * filesystem, no network, no environment and — deliberately — **no
     * readiness consultation**. A project whose dev server has no preload
     * attached is still a project this adapter can handle; that gap is
     * {@link readiness}'s to report and {@link InstallResult.unavailable}'s to
     * carry. The planner calls this once per candidate action type while a
     * developer waits, so it stays cheap and free of side effects, and two
     * calls with the same context give the same answer.
     */
    canHandle(context: InstrumentationContext): boolean {
      return hasServerTier(context);
    },

    /**
     * Proposes the route handlers and server functions this question needs
     * wrapped.
     *
     * Every target is selected from the code graph and proved to exist before
     * it is proposed: a symbol the graph has no declaration for, a name no
     * declaration can be addressed by and a generator are all skipped here
     * rather than left for the patcher to refuse. Both families are capped
     * independently, because each action becomes a real modification to the
     * developer's file.
     *
     * Nothing is installed and nothing is written: a proposal is advice, which
     * `normalizePlan` and `../feasibility.ts` validate before
     * {@link install} may act on it.
     */
    createPlan(
      context: InstrumentationContext,
      understanding: ProblemUnderstanding,
    ): Promise<InstrumentationAction[]> {
      const logger = loggerFor(context, resolved);

      if (context.signal?.aborted === true) {
        logger.debug('planning skipped: the session was cancelled');

        return Promise.resolve([]);
      }

      if (!hasServerTier(context)) {
        return Promise.resolve([]);
      }

      const wantsRoutes = needsAny(understanding, ROUTE_FAMILY_SIGNALS);
      const wantsFunctions = needsAny(understanding, FUNCTION_FAMILY_SIGNALS);

      if (!wantsRoutes && !wantsFunctions) {
        logger.debug('planning skipped: no server-tier signal was asked for', {
          signals: understanding.signalsNeeded.length,
        });

        return Promise.resolve([]);
      }

      // The routes are selected even when the question asks only for function
      // timing: they are what makes a server function *reachable evidence*
      // rather than one of every exported function in the project.
      const routes = routeCandidates(context, understanding, resolved);
      const actions: InstrumentationAction[] = [];

      if (wantsRoutes) {
        actions.push(...routeActions(context, routes, resolved, logger));
      }

      if (wantsFunctions) {
        actions.push(
          ...functionActions(
            context,
            functionCandidates(context, understanding, routes, resolved),
            resolved,
            logger,
          ),
        );
      }

      logger.debug('proposed patch targets', {
        routesConsidered: routes.length,
        actions: actions.length,
        planVersion: context.planVersion,
      });

      return Promise.resolve(actions);
    },

    /**
     * Installs the accepted actions and reports exactly what happened.
     *
     * **The preload gate comes first, and it decides whether a byte is written
     * at all.** With no preload attached to this project's dev server, nothing
     * would receive the spans a wrapper emits — so no patch is applied, and the
     * four signals this adapter speaks for are reported as gaps carrying the
     * exact relaunch command instead. A file modification that cannot produce
     * telemetry is pure risk to a developer's working tree, and declining it is
     * the only defensible reading of AAP §0.5.1. A preload that is connected
     * but has gone quiet is a different case: the transport exists, so the
     * patches are applied and the doubt is reported alongside them.
     *
     * Every byte reaches the file through `../patch/patcher.js`, whose hash →
     * backup → journal → atomic-rename sequence is what makes the edit
     * reversible. The accepted actions go to the patcher as **one batch** in
     * {@link orderForInstall}'s order, and the batch **stops at the first
     * target it cannot complete** — a refused declaration, a baseline
     * conflict, a write-path failure, a cancellation between stages. That
     * failure is fatal to this install and is reported, never thrown, through
     * {@link InstallResult.failure}: the records completed before it are in
     * {@link InstallResult.applied}, the record journaled for the failed
     * attempt is in {@link InstallFailure.record}, and no hook or signal
     * contribution is claimed. Nothing is rolled back here — `../installer.ts`
     * reverse-restores every record the current install applied, which is
     * what keeps a follow-up's delta all-or-nothing (AAP §0.4.2). A signal
     * that was already aborted when the call arrived is the same failure with
     * nothing written.
     */
    async install(
      actions: readonly InstrumentationAction[],
      context: InstrumentationContext,
    ): Promise<InstallResult> {
      const logger = loggerFor(context, resolved);
      const accepted = actions.filter(isClaimedAction);

      if (accepted.length === 0) {
        logger.debug('nothing claimed to install', { offered: actions.length });

        return { adapterId: NEXTJS_ADAPTER_ID, applied: [], runtimeHooks: [], unavailable: [] };
      }

      const verdict = preloadVerdict(context, resolved, clockFor(context, resolved));

      if (verdict.state === 'absent') {
        logger.warn('no dev-server preload for this project, so no file was modified', {
          actions: accepted.length,
          planVersion: context.planVersion,
        });

        return {
          adapterId: NEXTJS_ADAPTER_ID,
          applied: [],
          runtimeHooks: [],
          unavailable: preloadGaps(context, resolved, verdict),
        };
      }

      const unavailable: UnavailableSignal[] =
        verdict.state === 'silent' ? preloadGaps(context, resolved, verdict) : [];

      if (verdict.state === 'silent') {
        logger.warn('the dev-server preload has gone quiet; patching anyway', {
          silentForMs: verdict.silentForMs,
          planVersion: context.planVersion,
        });
      }

      if (context.signal?.aborted === true) {
        logger.info('the install was cancelled before any target was patched', {
          actions: accepted.length,
          planVersion: context.planVersion,
        });

        return {
          adapterId: NEXTJS_ADAPTER_ID,
          applied: [],
          runtimeHooks: [],
          unavailable,
          failure: cancelledBeforePatching(accepted.length),
        };
      }

      // One patcher per install call: its own duplicate-target guard is scoped
      // to this plan version, and the chain parent for a file an earlier plan
      // version already instrumented is resolved through the journal by the
      // patcher itself (AAP §0.4.2) — chaining is never re-implemented here.
      // The admitted canonical root travels with the spelled one, so the
      // patcher resolves, pins and writes inside the directory the service
      // admitted and refuses a patch once that directory has been replaced by
      // a link; absent, the patcher resolves the spelled root itself.
      const patcher = resolved.patcherFactory({
        projectRoot: context.projectRoot,
        canonicalRoot: context.canonicalProjectRoot,
        sessionId: context.sessionId,
        planVersion: context.planVersion,
        journal: context.journal,
        backups: context.backups,
        logger,
        now: clockFor(context, resolved),
        signal: context.signal,
      });

      // One batch, and no loop around it. The patcher stops at the first
      // target it cannot complete, which is the safe reading of a failure: the
      // installer that called this is about to unwind, and every further edit
      // would be one more file to restore. Stepping past the failure instead
      // would hand the installer a partial install shaped like a successful
      // one, which is precisely what would make a follow-up's delta non-atomic.
      const ordered = orderForInstall(accepted, context.queries);
      const batch = await patcher.patchActions(ordered);
      const applied: ModificationRecord[] = batch.applied.map((outcome) => outcome.record);
      const failure = batch.failure;

      if (failure !== undefined) {
        // Identifiers, a project-relative path and codes only: the conflict
        // report holds diffs, and nothing of a file's content is logged.
        logger.warn('a planned target could not be instrumented; this install stops here', {
          actionId: failure.actionId,
          file: failure.file,
          symbol: failure.symbol,
          stage: failure.stage,
          code: failure.error.code,
          recordId: failure.record?.id,
          fileMayHoldPatch: failure.fileMayHoldPatch,
          conflicted: failure.conflict !== undefined,
          applied: applied.length,
          notAttempted: Math.max(0, ordered.length - applied.length - 1),
          planVersion: context.planVersion,
        });

        // Only the silent-preload gaps are carried: the failure is what this
        // result reports, and the installer ignores every other member of it
        // while it unwinds. No hook and no signal contribution is claimed for
        // an install that is being reversed.
        return {
          adapterId: NEXTJS_ADAPTER_ID,
          applied,
          runtimeHooks: [],
          unavailable,
          failure: installFailureOf(failure),
        };
      }

      const signals = deriveServerAgentSignals(accepted);

      logger.debug('install finished', {
        applied: applied.length,
        unavailable: unavailable.length,
        functions: signals.functions.length,
      });

      return {
        adapterId: NEXTJS_ADAPTER_ID,
        applied,
        runtimeHooks: runtimeHooksFor(signals),
        unavailable,
        serverSignals: narrowServerSignals(signals),
      };
    },

    /**
     * Relinquishes this adapter's server-tier signals.
     *
     * **No file is restored here, and that is not an omission.** Restoration is
     * `../cleanup.ts`'s: it holds the chain it intends to unwind, walks it in
     * strict reverse, and verifies each file against its record's
     * `instrumentedHash` before writing that record's backup — a file a
     * developer edited in the meantime is left exactly as they left it
     * (AAP §0.5.1). Writing here would race that walk, and this adapter could
     * not even scope the work correctly: a {@link ModificationRecord} names a
     * session, a plan version and a file, but no adapter, which is precisely
     * why {@link AdapterRemoveRequest} carries the records rather than making
     * an adapter look them up.
     *
     * The runtime side is disabled rather than idled: the service sends
     * `server-agent.config` with no capture, and the preload drops its
     * instrumentations and its tracer provider, so the framework's own spans
     * become no-ops. Idempotent — repeat calls, and a session that installed
     * nothing, report the same thing.
     */
    remove(session: AdapterRemoveRequest, context: InstrumentationContext): Promise<RemoveResult> {
      loggerFor(context, resolved).debug('relinquishing server-tier signals', {
        reason: session.reason,
        planVersion: session.planVersion ?? context.planVersion,
        records: session.records?.length ?? 0,
      });

      return Promise.resolve({
        adapterId: NEXTJS_ADAPTER_ID,
        restored: [],
        conflicts: [],
        runtimeHooksDisabled: [...NEXTJS_RUNTIME_HOOKS],
      });
    },

    /**
     * Reports whether this project's server-tier signals can be collected here.
     *
     * Decided from {@link InstrumentationContext.readiness} and the code graph
     * and from nothing else: no port is opened, no connection is retried, no
     * process is spawned and no environment variable is read. The service holds
     * the evidence — the `server-agent` connection for this project — and an
     * adapter that went looking for its own could tell a developer a signal is
     * ready while the frames the product needs are not arriving.
     *
     * A project with no server tier reports **no rows**, which is ready: an
     * adapter with nothing to claim cannot hold a capture back. Otherwise one
     * row per signal this adapter speaks for, `'available'` when the preload is
     * attached, `'degraded'` when it is connected but silent — which does not
     * block a capture — and `'unavailable'` when it is absent, which does, with
     * the same reason and hint an install would report.
     */
    readiness(context: InstrumentationContext): Promise<Readiness> {
      const clock = clockFor(context, resolved);
      const signals: ReadinessSignal[] = [];

      if (hasServerTier(context)) {
        const verdict = preloadVerdict(context, resolved, clock);
        const status = readinessStatusOf(verdict);

        for (const signal of NEXTJS_SERVER_SIGNAL_KEYS) {
          signals.push(
            status === 'available'
              ? { signal, status }
              : {
                  signal,
                  status,
                  reason: reasonFor(signal, verdict),
                  hint: hintFor(context, resolved, verdict),
                },
          );
        }
      }

      return Promise.resolve(buildReadiness({ adapter: NEXTJS_ADAPTER_ID, signals, now: clock }));
    },
  };
}
