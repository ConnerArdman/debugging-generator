/**
 * The **PostgreSQL driver adapter**: one of the six built-in adapters of
 * `@debuggen/instrumentation`, and one of the two that claim
 * `'db-query-tracking'`.
 *
 * It answers three questions about a target project and writes nothing to it:
 *
 * 1. *Does this project reach PostgreSQL through the raw driver?* — decided
 *    from the code graph's `db-call` nodes and the project summary's database
 *    access style, never from a table name, a handle variable, a statement or
 *    an import specifier written as a literal here (AAP §0.5.4).
 * 2. *Which functions would the plan name as its anchors?* — the enclosing
 *    functions the graph's `queries` edges start at, ranked deterministically
 *    against the problem understanding's own entities and search hints. A
 *    function in a seed, migration, script, test or configuration module is
 *    never one of them (`@debuggen/code-analysis`'s `isToolingModulePath`):
 *    that module runs in a process of its own, not in the dev server the
 *    preload instruments, so its queries can never reach a capture. When the
 *    question names or reaches any function, the anchors are drawn from the
 *    strongest evidence alone — reachable ones by shortest path — and are
 *    never padded with functions the question says nothing about.
 * 3. *Can the signal actually be collected here?* — decided **only** from the
 *    `server-agent` facts the service observed, because the driver's query
 *    spans are produced by `@opentelemetry/instrumentation-pg` inside the
 *    dev-server preload (`packages/telemetry/src/node/register.ts`) and no
 *    amount of planning substitutes for that process being attached
 *    (AAP §0.5.1).
 *
 * ## Why this adapter installs nothing
 *
 * Driver query spans are a **runtime** signal. The preload wraps the driver's
 * own client methods in the dev server's process, so there is no file to edit,
 * no hash to record and no backup to keep: {@link InstallResult.applied} is
 * always empty, this module never imports `../patch/**`, and it never touches
 * a filesystem. What an install contributes instead is one flag —
 * {@link ServerAgentSignals.pg} — derived by `../schema/readiness.ts` from the
 * actions that were installed, plus the developer-facing account of whatever
 * could not be enabled.
 *
 * ## Why `canHandle` has to be honest
 *
 * `'db-query-tracking'` is claimed by **two** adapters — this one and the
 * Prisma sibling — and the registry disambiguates them by asking each
 * `canHandle(context)`. A `true` from here for a project that only uses the
 * generated client would put the wrong adapter's name on the action and its
 * gaps; a `false` for a project that hand-writes statements would lose exactly
 * the queries a developer reached for the driver to write. So the answer is
 * read off the graph's `DbCallNodeData.driver` field, which the indexer derives
 * from what the code *calls*, and corroborated by the summary's own
 * `databaseAccess.style`.
 *
 * Both recognised driver shapes — a query issued straight on a pool, and a
 * query issued on a client borrowed from a pool and released afterwards — carry
 * the same `driver` value, so they are handled identically here by
 * construction. Telling them apart is not possible from the graph and is not
 * wanted: they are the same access, and a developer who borrowed a connection
 * for transactional work would otherwise have those queries left out.
 *
 * ## Privacy
 *
 * `DbCallNodeData` may carry a capped statement *shape* with its literals
 * already replaced. Nothing in this module reads it into a sentence, a hint or
 * a log field: what reaches a developer or a log line is a project-relative
 * file path, a declared symbol name, a signal name and a count (AAP §0.5.2).
 * No SQL, no connection string, no row content — not even the shape.
 *
 * ## Extension
 *
 * This file stands alone. It imports no sibling adapter, no registry, no
 * installer and no cleanup module, and it shares no private helper with the
 * Prisma adapter, so a seventh adapter is a new file plus a `registerAdapter()`
 * call and nothing here has to change (AAP §0.4.2).
 */

import {
  isSafeRelativePath,
  newActionId,
  normalizePosix,
  nowEpochMs,
  toPosix,
} from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';
import { isToolingModulePath } from '@debuggen/code-analysis';
import type {
  CodeGraph,
  CodeNode,
  CodeNodeOf,
  CodeQueries,
  DatabaseAccessStyle,
  DbDriver,
  ProjectSummary,
} from '@debuggen/code-analysis';

import type {
  AdapterRemoveRequest,
  InstallResult,
  InstrumentationAdapter,
  InstrumentationContext,
  RemoveResult,
  UnavailableSignal,
} from '../adapter.js';
import type {
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
} from '../schema/plan.js';
import { buildReadiness, deriveServerAgentSignals } from '../schema/readiness.js';
import type {
  CaptureSignal,
  Readiness,
  ReadinessSignal,
  ReadinessStatus,
  ServerAgentSignalKey,
  ServerAgentSignals,
} from '../schema/readiness.js';
import type { ProblemUnderstanding } from '../schema/target.js';

/* -------------------------------------------------------------------------------------------------
 * Identity and claims
 * ---------------------------------------------------------------------------------------------- */

/**
 * This adapter's registered id.
 *
 * The canonical spelling, matching this module's file name, and the value that
 * every {@link InstrumentationAction.adapter}, {@link InstallResult.adapterId},
 * {@link RemoveResult.adapterId} and {@link Readiness.adapter} this file
 * produces carries. `../registry.ts` enumerates adapter identity for the
 * product and names this same string; it is declared here as a literal so that
 * the one place it is written is the module it identifies, and so a stored plan
 * or modification record read back after an upgrade still names an adapter that
 * exists.
 */
export const POSTGRES_ADAPTER_ID = 'postgres';

/** This adapter's id as a literal type. */
export type PostgresAdapterId = typeof POSTGRES_ADAPTER_ID;

/**
 * One action type an adapter claims, and the mode it installs that type in.
 *
 * Declared here rather than imported because no shape in `../schema/**` states
 * it and `../adapter.ts` declares no claims member: the contract's five methods
 * are the whole interface, and which types an adapter claims is otherwise
 * expressed only by what `canHandle` answers and what `createPlan` proposes.
 * Naming it makes the claim readable by the registry without a second source of
 * truth — see {@link POSTGRES_ADAPTER_CLAIMS}.
 */
export interface PostgresAdapterClaim {
  /** The action type claimed. */
  readonly type: InstrumentationActionType;

  /** How an action of that type is installed. */
  readonly mode: InstrumentationMode;
}

/**
 * The action type this adapter claims, written exactly once.
 *
 * Typed as {@link InstrumentationActionType} rather than left as a loose
 * string, so a spelling outside `../schema/plan.ts`'s closed vocabulary is a
 * compile error instead of a filter that silently matches nothing — the same
 * idiom `../schema/readiness.ts` uses for its own mode constant. `createPlan`
 * stamps actions with it and `install` filters incoming actions by it, so the
 * two cannot disagree.
 */
const CLAIMED_ACTION_TYPE: InstrumentationActionType = 'db-query-tracking';

/**
 * The mode the claimed type installs in, written exactly once.
 *
 * `'runtime'`: the driver's spans come from the preload's instrumentation, so no
 * file is modified and no modification record exists (AAP §0.5.1).
 */
const CLAIMED_MODE: InstrumentationMode = 'runtime';

/**
 * What this adapter claims: `'db-query-tracking'`, installed in `'runtime'`
 * mode.
 *
 * The declaration the registry may read to build the capability catalog the
 * planning stage is given, composed from {@link CLAIMED_ACTION_TYPE} and
 * {@link CLAIMED_MODE} rather than restating them — so the claim, the proposal
 * and the install filter are one statement.
 *
 * It deliberately encodes no exclusivity against the Prisma sibling, which
 * claims the same type: an action type is not owned by one adapter, and
 * `canHandle(context)` is the mechanism that decides which claimant answers for
 * a given project.
 *
 * Frozen at both levels, because it is handed out as-is.
 */
export const POSTGRES_ADAPTER_CLAIMS: readonly PostgresAdapterClaim[] = Object.freeze([
  Object.freeze({ type: CLAIMED_ACTION_TYPE, mode: CLAIMED_MODE }),
]);

/**
 * The dev-server signal keys this adapter contributes to
 * {@link ServerAgentSignals}.
 *
 * Exactly one: `pg`, the driver's query spans. The tuple is exported so the
 * registry, the service's readiness aggregation and this package's own suite can
 * state what this adapter speaks for without re-deriving it, and it is the
 * single place the key is spelled — {@link PG_SIGNAL} reads the capture-signal
 * name straight out of it, the two vocabularies sharing this member by
 * construction (`../schema/readiness.ts` lists `pg` in both `CAPTURE_SIGNALS`
 * and `SERVER_AGENT_SIGNAL_KEYS`).
 */
export const POSTGRES_SERVER_SIGNAL_KEYS = Object.freeze([
  'pg',
] as const satisfies readonly ServerAgentSignalKey[]);

/**
 * The capture signal this adapter reports on, in readiness rows and in
 * {@link UnavailableSignal.signal}.
 *
 * The same member as {@link POSTGRES_SERVER_SIGNAL_KEYS}'s only entry, taken
 * from it rather than written again.
 */
const PG_SIGNAL: CaptureSignal = POSTGRES_SERVER_SIGNAL_KEYS[0];

/**
 * The driver value a `db-call` node must carry for this adapter to claim it.
 *
 * Typed as {@link DbDriver} — the union `@debuggen/code-analysis` derives from
 * its published `DB_DRIVERS` vocabulary — so a spelling this product does not
 * recognise is a compile error rather than a comparison that is silently always
 * false. The same idiom `../schema/readiness.ts` uses for its own mode
 * constant, and the reason detection here can never drift from the value the
 * indexer actually writes.
 */
const PG_DRIVER: DbDriver = 'pg';

/**
 * The project-summary database access styles that include the raw driver.
 *
 * `'pg'` for a project that only hand-writes statements and `'both'` for the
 * ordinary shape of a project that uses a generated client for most work and
 * the driver for the queries that need it. `'prisma'` and `'none'` are absent,
 * which is what makes {@link InstrumentationAdapter.canHandle} answer `false`
 * for a client-only project and keep the dual claim on
 * `'db-query-tracking'` honest.
 */
const PG_BEARING_ACCESS_STYLES = Object.freeze([
  'pg',
  'both',
] as const satisfies readonly DatabaseAccessStyle[]);

/**
 * The runtime hook this adapter arms, named for a developer to read.
 *
 * One entry: the driver instrumentation the preload enables when
 * {@link ServerAgentSignals.pg} is on. It is what
 * `instrumentation.ready`'s `runtimeHooks` carries into the editor's
 * "Preparing instrumentation" checklist and the panel's session summary, so the
 * wording is a description of the signal rather than a package name.
 */
const POSTGRES_RUNTIME_HOOKS: readonly string[] = Object.freeze(['PostgreSQL driver query spans']);

/* -------------------------------------------------------------------------------------------------
 * Options and defaults
 * ---------------------------------------------------------------------------------------------- */

/**
 * How a developer relaunches their dev server with the preload attached, when
 * the caller knows better than this module can.
 *
 * Supplied by `apps/local-service/src/instrumentation/service.ts`, which owns
 * the launcher and therefore knows the exact command it would run. Every member
 * is optional: an absent member falls back to the value in
 * {@link POSTGRES_ADAPTER_DEFAULTS} or, failing that, to an instruction that
 * names the editor command instead of a shell command.
 *
 * Nothing here is ever read from the environment, and no path inside this
 * repository is ever written into it (AAP §0.5.4): a relaunch instruction is
 * about the developer's project, not about the tool's checkout.
 */
export interface PostgresRelaunchDescriptor {
  /**
   * The whole command, ready to paste, single-line.
   *
   * Preferred over everything else when present, because the caller that
   * launches dev servers is the one party that knows what it would launch.
   */
  readonly command?: string | undefined;

  /**
   * The module specifier the dev-server process must preload.
   *
   * Defaults to {@link POSTGRES_ADAPTER_DEFAULTS.preloadSpecifier}, the
   * documented entry of `@debuggen/telemetry`.
   */
  readonly preloadSpecifier?: string | undefined;

  /**
   * The editor command that relaunches the dev server for the developer.
   *
   * Named in the instruction of last resort, when neither a command nor a usable
   * package manager is known. Defaults to
   * {@link POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle}.
   */
  readonly editorCommandTitle?: string | undefined;
}

/**
 * The adapter's injected knobs. Every one is optional and fully defaulted, so
 * `createPostgresAdapter()` with no argument is the production configuration.
 *
 * They exist for the reason `../adapter.ts`'s context exists: an adapter that
 * consulted the real clock could not be asserted against, and one that decided
 * its own bounds could not be tuned by the process that has to render its
 * output.
 */
export interface PostgresAdapterOptions {
  /**
   * The most actions {@link InstrumentationAdapter.createPlan} will propose.
   *
   * The preload instruments the driver **process-wide**, so the actions are
   * anchors that tell a developer which query sites the investigation found —
   * not one action per call expression. Defaults to
   * {@link POSTGRES_ADAPTER_DEFAULTS.maxTargets}; a value that is not a whole
   * number of at least one is ignored in favour of that default, and the
   * effective cap is bounded above by {@link POSTGRES_ADAPTER_DEFAULTS.maxTargetsCeiling}.
   */
  readonly maxTargets?: number | undefined;

  /**
   * How long the dev-server preload may go unheard from before its signal is
   * reported `'degraded'`, in milliseconds.
   *
   * Defaults to {@link POSTGRES_ADAPTER_DEFAULTS.heartbeatStalenessMs}. A
   * non-finite or non-positive value is ignored in favour of that default.
   */
  readonly heartbeatStalenessMs?: number | undefined;

  /**
   * The clock, in epoch milliseconds.
   *
   * Consulted only when {@link InstrumentationContext.now} is absent, so the
   * session's own clock always wins; `nowEpochMs` from `@debuggen/shared` is the
   * final fallback. Injected so a suite can assert an exact
   * {@link Readiness.checkedAt} and an exact staleness decision without freezing
   * time globally.
   */
  readonly now?: (() => number) | undefined;

  /**
   * Where this adapter's own lines go.
   *
   * Defaults to {@link InstrumentationContext.logger}, the session's logger. A
   * caller that wants only this adapter's diagnostics — a suite capturing them,
   * a host routing them to a side channel — passes one here; either way the
   * adapter logs through `logger.child({ adapter })` rather than formatting a
   * prefix into every message.
   */
  readonly logger?: Logger | undefined;

  /**
   * How to relaunch the developer's dev server with the preload attached.
   *
   * See {@link PostgresRelaunchDescriptor}.
   */
  readonly relaunch?: PostgresRelaunchDescriptor | undefined;
}

/**
 * The defaults behind {@link PostgresAdapterOptions}, and the two bounds that
 * are policy rather than preference.
 *
 * Exported and frozen so the values a caller is overriding are readable, and so
 * a suite can assert against the shipped configuration instead of restating it.
 */
export const POSTGRES_ADAPTER_DEFAULTS = Object.freeze({
  /**
   * Four anchors: enough for a developer to see which functions the
   * investigation found, few enough that a plan about a process-wide signal does
   * not read as a list of every query in the project.
   */
  maxTargets: 4,

  /**
   * The hard upper bound on {@link PostgresAdapterOptions.maxTargets}, whatever
   * a caller asks for. A plan is shown to a developer and stored on the session;
   * an unbounded anchor list would be neither readable nor reviewable.
   */
  maxTargetsCeiling: 32,

  /**
   * Thirty seconds. A local dev server that has said nothing for half a minute
   * while a session is being prepared has, for the developer's purposes, stopped
   * reporting — and saying so costs a `'degraded'` row, which does not hold a
   * capture back.
   */
  heartbeatStalenessMs: 30_000,

  /**
   * The documented preload entry of `@debuggen/telemetry`, used to compose a
   * relaunch instruction. A published package subpath, never a path inside this
   * repository.
   */
  preloadSpecifier: '@debuggen/telemetry/node/register',

  /**
   * The editor command that relaunches a dev server with the preload attached,
   * named in the instruction of last resort.
   */
  editorCommandTitle: 'Debug Generator: Launch dev server',
});

/**
 * This adapter's public shape: the contract of `../adapter.ts` with its claim
 * declaration intersected on.
 *
 * `../adapter.ts` declares no claims member — adapter identity and capability
 * belong to `../registry.ts` — so the claim travels on the object as well as
 * being exported as a constant, and a caller holding the adapter can read what
 * it claims without importing this module's constants. Assignable to
 * {@link InstrumentationAdapter} wherever the registry stores it.
 */
export interface PostgresAdapter extends InstrumentationAdapter {
  /** Always {@link POSTGRES_ADAPTER_ID}. */
  readonly id: PostgresAdapterId;

  /** Always {@link POSTGRES_ADAPTER_CLAIMS}. */
  readonly claims: readonly PostgresAdapterClaim[];
}

/* -------------------------------------------------------------------------------------------------
 * Bounds the schemas downstream will apply
 *
 * `../schema/plan.ts` and `../schema/readiness.ts` validate the strings this
 * module produces. Respecting their bounds here means a proposal or a readiness
 * row is never rejected for a length this module could have measured, and never
 * carries a line break into a one-line row.
 * ---------------------------------------------------------------------------------------------- */

/** Longest `rationale` `../schema/plan.ts` accepts, in characters. */
const MAX_RATIONALE_LENGTH = 500;

/** Longest `reason` or `hint` `../schema/readiness.ts` accepts, in characters. */
const MAX_MESSAGE_LENGTH = 500;

/** Longest `symbol` `../schema/plan.ts` accepts, in characters. */
const MAX_SYMBOL_LENGTH = 200;

/** Highest C0 control code point, DELETE and the C1 range's bounds. */
const C0_CONTROL_MAX = 0x1f;

/** First code point of the DELETE/C1 control range. */
const C1_CONTROL_MIN = 0x7f;

/** Last code point of the C1 control range. */
const C1_CONTROL_MAX = 0x9f;

/**
 * Whether a string is free of control characters.
 *
 * Written as a code-point scan rather than a regular expression because a
 * character class over the control ranges is itself a lint failure
 * (`no-control-regex`), and because the scan states the ranges it rejects
 * instead of hiding them in an escape sequence.
 *
 * @param value The string to inspect.
 * @returns `true` when no code point is a C0, DELETE or C1 control character.
 */
function isControlFree(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);

    if (code === undefined) {
      continue;
    }

    if (code <= C0_CONTROL_MAX || (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX)) {
      return false;
    }
  }

  return true;
}

/**
 * Whether a symbol name can be carried on an action.
 *
 * The three things `../schema/plan.ts`'s `symbol` field requires: non-blank,
 * within the length bound, single-line. A graph node's name is a source
 * identifier and satisfies all three in every ordinary case; the check exists so
 * that a pathological declaration — a name long past the bound — costs a skipped
 * anchor rather than a rejected plan.
 *
 * @param symbol The candidate symbol name.
 * @returns `true` when the name is usable as an action's `symbol`.
 */
function isUsableSymbol(symbol: string): boolean {
  return symbol.trim().length > 0 && symbol.length <= MAX_SYMBOL_LENGTH && isControlFree(symbol);
}

/**
 * Collapses a composed message to one line and clips it to a bound.
 *
 * Whitespace runs — including any newline a caller's injected descriptor
 * brought with it — become single spaces, and the result is clipped to `limit`
 * on a word boundary where there is one. Clipping is the last resort: every
 * message this module composes is written to fit, and the clip is what keeps a
 * developer's long project path from turning an actionable hint into a rejected
 * one.
 *
 * @param value The composed message.
 * @param limit The maximum length in characters.
 * @returns A single-line message of at most `limit` characters.
 */
function toBoundedMessage(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();

  if (collapsed.length <= limit) {
    return collapsed;
  }

  const clipped = collapsed.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(' ');

  return lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
}

/* -------------------------------------------------------------------------------------------------
 * Graph-only driver detection
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every `db-call` node in the graph that reaches PostgreSQL through the raw
 * driver.
 *
 * The **whole** of this adapter's detection, and the reason it generalises: a
 * node is here because the indexer resolved the call's receiver to a driver
 * handle and wrote {@link PG_DRIVER} on it, not because anything in this file
 * recognised a name. Both driver call shapes — a query on a pool and a query on
 * a client borrowed from one — carry that value, and the extractor emits one
 * node per query call and none for a connect or a release, so consuming its
 * nodes is all that "handle both shapes identically" requires.
 *
 * @param graph The project's code graph.
 * @returns The driver call sites, in the graph's own deterministic node order.
 */
function pgCallSites(graph: CodeGraph): readonly CodeNodeOf<'db-call'>[] {
  return graph.nodesByKind('db-call').filter((node) => node.data.driver === PG_DRIVER);
}

/**
 * Whether the project summary reports a database access style that includes the
 * raw driver.
 *
 * The cheap corroboration of {@link pgCallSites}: the summary derives its style
 * from the same `db-call` nodes, so the two agree — but the summary is a single
 * field read, and it stays meaningful for a project whose graph a caller handed
 * over in a narrowed form.
 *
 * @param summary The project summary.
 * @returns `true` when the style is one of {@link PG_BEARING_ACCESS_STYLES}.
 */
function summaryReportsPg(summary: ProjectSummary): boolean {
  return PG_BEARING_ACCESS_STYLES.some((style) => style === summary.databaseAccess.style);
}

/**
 * Whether this project queries PostgreSQL through the raw driver at all.
 *
 * The capability question, answered from the graph and the summary and from
 * nothing else — no filesystem, no manifest, no environment, no readiness. It
 * is deliberately **not** a question about whether the signal can be collected:
 * a project with driver call sites and no dev-server preload is still a project
 * this adapter claims, and that gap is `readiness`'s to report.
 *
 * @param context The session's context.
 * @returns `true` when at least one driver call site exists, or the summary
 * reports a driver-bearing access style.
 */
function projectUsesPgDriver(context: InstrumentationContext): boolean {
  return pgCallSites(context.graph).length > 0 || summaryReportsPg(context.projectSummary);
}

/* -------------------------------------------------------------------------------------------------
 * Query-site owners
 * ---------------------------------------------------------------------------------------------- */

/**
 * The node kinds a `queries` edge may start at that name a function.
 *
 * `../../code-analysis`'s edge table sanctions `symbol` and `server-function`
 * as a `queries` edge's origin, and its extractor falls through to the module's
 * own `file` node for a call written outside every declaration. A `file` owner
 * names no function, so it is skipped: an action's `symbol` must be a declared
 * symbol the feasibility gate can find, and there is nothing to put there.
 */
const OWNER_NODE_KINDS = Object.freeze(['server-function', 'symbol']);

/**
 * One function that reaches the driver, and what the graph says about it.
 *
 * The unit a proposal speaks in. Grouping by the enclosing function rather than
 * by the call expression is what makes a plan readable — "these functions query
 * the database" — and it is also the only granularity an action can address,
 * since a `db-call` node is an expression and an action's `symbol` is a
 * declaration.
 */
interface PgQuerySiteOwner {
  /** The owner node's opaque graph id, used only as a final ordering key. */
  readonly nodeId: string;

  /** The owner's declaration file: project-relative POSIX, already normalised. */
  readonly file: string;

  /** The owner's declared symbol name. */
  readonly symbol: string;

  /** The 1-based line the declaration starts on. */
  readonly line: number;

  /** The 1-based column the declaration starts at. */
  readonly column: number;

  /** How many driver call sites the graph records inside it. */
  readonly callSites: number;

  /** How many of those build their statement from a non-literal expression. */
  readonly dynamicCallSites: number;

  /** The `db-call` node ids, so evidence naming a call site can reach its owner. */
  readonly callNodeIds: readonly string[];
}

/** A mutable accumulator for one owner while its call sites are being collected. */
interface OwnerAccumulator {
  readonly owner: CodeNode;
  callSites: number;
  dynamicCallSites: number;
  readonly callNodeIds: string[];
}

/**
 * Groups every driver call site by the function that contains it.
 *
 * Resolution runs through the graph's `queries` edges — the edge the indexer
 * emits from the enclosing declaration to the call site — rather than by
 * re-reading the abstract syntax tree, which this package has no business doing
 * for a runtime signal. A call site whose owner is the module's `file` node, or
 * whose owner node is missing from the graph, contributes nothing: there is no
 * function to name.
 *
 * @param graph The project's code graph.
 * @returns One entry per owning function, keyed internally by node id.
 */
function collectPgQuerySiteOwners(graph: CodeGraph): readonly PgQuerySiteOwner[] {
  const accumulators = new Map<string, OwnerAccumulator>();

  for (const call of pgCallSites(graph)) {
    for (const edge of graph.incoming(call.id, 'queries')) {
      const owner = graph.nodeById(edge.from);

      if (owner === undefined || !OWNER_NODE_KINDS.some((kind) => kind === owner.kind)) {
        continue;
      }

      const existing = accumulators.get(owner.id);
      const accumulator = existing ?? {
        owner,
        callSites: 0,
        dynamicCallSites: 0,
        callNodeIds: [],
      };

      accumulator.callSites += 1;

      if (call.data.dynamic) {
        accumulator.dynamicCallSites += 1;
      }

      if (!accumulator.callNodeIds.includes(call.id)) {
        accumulator.callNodeIds.push(call.id);
      }

      if (existing === undefined) {
        accumulators.set(owner.id, accumulator);
      }
    }
  }

  const owners: PgQuerySiteOwner[] = [];

  for (const accumulator of accumulators.values()) {
    const { owner } = accumulator;
    const file = normalizePosix(toPosix(owner.file));

    // A node whose file is not a safe project-relative path could not become an
    // action anyway: `../schema/plan.ts` requires the normal form, and the
    // patcher's containment gate would refuse it. Dropping it here keeps the
    // proposal free of a target the feasibility check would reject.
    if (!isSafeRelativePath(file) || !isUsableSymbol(owner.name)) {
      continue;
    }

    owners.push({
      nodeId: owner.id,
      file,
      symbol: owner.name,
      line: owner.line,
      column: owner.column,
      callSites: accumulator.callSites,
      dynamicCallSites: accumulator.dynamicCallSites,
      callNodeIds: Object.freeze([...accumulator.callNodeIds]),
    });
  }

  return owners;
}

/* -------------------------------------------------------------------------------------------------
 * Evidence: what the problem understanding actually points at
 * ---------------------------------------------------------------------------------------------- */

/** An owner the understanding named, directly or through one of its call sites. */
const EVIDENCE_TIER_NAMED = 0;

/**
 * An owner reachable from something the understanding named: up its caller
 * chain, or down a bounded path from a node the understanding resolved to.
 * Ranked within the tier by the number of hops, shortest first.
 */
const EVIDENCE_TIER_REACHABLE = 1;

/** An owner the understanding says nothing about. */
const EVIDENCE_TIER_UNNARROWED = 2;

/**
 * How far up the caller chain reachability is followed.
 *
 * Three hops covers the shape this signal exists for: a route module declares
 * an exported method handler, the handler calls a service function, and the
 * service function issues the query. Bounded rather than exhaustive because a
 * proposal is advice and an unbounded traversal of a large project's call graph
 * would cost a developer a wait for a ranking refinement.
 */
const MAX_CALLER_DEPTH = 3;

/**
 * The most caller lookups one proposal will perform.
 *
 * A second bound beside {@link MAX_CALLER_DEPTH}, because depth alone does not
 * bound breadth: a widely-called service function has many callers and each has
 * its own. The query surface bounds each result; this bounds how many results
 * are asked for.
 */
const MAX_CALLER_LOOKUPS = 64;

/**
 * How many evidence nodes a downstream reachability search starts from, at
 * most.
 *
 * Roots are the evidence nodes other than call sites, in the order the
 * understanding named them, so the same question always searches from the same
 * roots. Eight covers every entity and hint a validated understanding carries
 * in practice.
 */
const MAX_REACHABILITY_ROOTS = 8;

/**
 * The most `pathBetween` searches one proposal will run, shared across owners.
 *
 * Sixty-four owners from each of {@link MAX_REACHABILITY_ROOTS} roots. Each
 * search is itself bounded by the query surface's depth and node budgets, so
 * this bounds the whole pass; exhausting it leaves the remaining owners
 * unnarrowed, which degrades the order rather than the correctness of a
 * proposal.
 */
const MAX_PATH_SEARCHES = 64 * MAX_REACHABILITY_ROOTS;

/**
 * The distance of an owner one call below something the understanding named:
 * the shortest a reachable owner can be without being the evidence itself.
 */
const DIRECT_CALLER_DISTANCE = 1;

/**
 * The node kinds a name in the understanding is looked up against.
 *
 * Wide on purpose: an entity may name the service function that queries, the
 * route that reaches it, the component that triggered the request, or the call
 * site itself, and each of those is a different node kind. Breadth costs
 * nothing in precision here because every match is intersected with the driver
 * call sites the graph already found — a name that resolves to something
 * unrelated simply fails to promote any owner.
 */
const EVIDENCE_NODE_KINDS = Object.freeze([
  'server-function',
  'symbol',
  'db-call',
  'api-route',
  'handler',
  'component',
  'api-call',
] as const);

/** Entity kinds whose `name` is worth resolving as a URL against the route map. */
const URL_ENTITY_KINDS = Object.freeze(['route', 'url']);

/**
 * The graph node ids the problem understanding points at.
 *
 * Built from the understanding's own `entities` and `searchHints` through the
 * bounded query surface — `findSymbol` for an entity that carried a file,
 * `findByName` for every name, `routeForUrl` for an entity that reads as a URL
 * — which is the mechanism AAP §0.5.4 requires: a target is promoted because
 * the graph has a declaration for the name a developer's question produced,
 * never because this module recognised the name.
 *
 * @param understanding The validated problem understanding.
 * @param queries The project's read-only query surface.
 * @returns The set of node ids the understanding resolved to. Empty when the
 * understanding named nothing this project has.
 */
function resolveEvidenceNodeIds(
  understanding: ProblemUnderstanding,
  queries: CodeQueries,
): ReadonlySet<string> {
  const resolved = new Set<string>();
  const names: string[] = [];

  for (const entity of understanding.entities) {
    names.push(entity.name);

    if (entity.file !== undefined) {
      const exact = queries.findSymbol(normalizePosix(toPosix(entity.file)), entity.name);

      if (exact !== undefined) {
        resolved.add(exact.nodeId);
      }
    }

    if (URL_ENTITY_KINDS.some((kind) => kind === entity.kind)) {
      const route = queries.routeForUrl(entity.name);

      if (route?.node !== undefined) {
        resolved.add(route.node.nodeId);
      }
    }
  }

  names.push(...understanding.searchHints);

  for (const name of names) {
    for (const match of queries.findByName(name, { kinds: EVIDENCE_NODE_KINDS })) {
      resolved.add(match.nodeId);
    }
  }

  return resolved;
}

/**
 * The evidence nodes a downstream reachability search starts from.
 *
 * Every evidence node except a call site — a `db-call` node is an expression
 * with no downstream, and one of this driver's already names its owner — in
 * the order the understanding named them, capped at
 * {@link MAX_REACHABILITY_ROOTS}.
 *
 * @param evidence The node ids the understanding resolved to.
 * @param graph The project's code graph.
 * @returns The root node ids, in a stable order.
 */
function reachabilityRoots(evidence: ReadonlySet<string>, graph: CodeGraph): readonly string[] {
  const roots: string[] = [];

  for (const id of evidence) {
    if (roots.length >= MAX_REACHABILITY_ROOTS) {
      break;
    }

    const node = graph.nodeById(id);

    if (node !== undefined && node.kind !== 'db-call') {
      roots.push(id);
    }
  }

  return roots;
}

/**
 * How many hops up its caller chain an owner meets something the understanding
 * named, within {@link MAX_CALLER_DEPTH}; `undefined` when it does not.
 *
 * Walks callers rather than callees: the question "is this query in the path of
 * what the developer asked about?" is answered by who calls the function, and
 * the graph's `calls` edges plus the query surface's reference resolution are
 * what answer it. The walk is bounded twice — by depth and by a shared lookup
 * budget — and its result is used only for ranking, so exhausting the budget
 * degrades the order rather than the correctness of a proposal.
 *
 * @param owner The candidate owner.
 * @param evidence The node ids the understanding resolved to.
 * @param queries The project's read-only query surface.
 * @param budget The mutable remaining lookup budget, shared across owners.
 * @returns The number of caller hops to the first named node, or `undefined`
 * when none lies within the bounds.
 */
function callerDistanceFromEvidence(
  owner: PgQuerySiteOwner,
  evidence: ReadonlySet<string>,
  queries: CodeQueries,
  budget: { remaining: number },
): number | undefined {
  const visited = new Set<string>([owner.nodeId]);
  let frontier: { readonly file: string; readonly symbol: string }[] = [
    { file: owner.file, symbol: owner.symbol },
  ];

  for (let depth = 0; depth < MAX_CALLER_DEPTH && frontier.length > 0; depth += 1) {
    const next: { readonly file: string; readonly symbol: string }[] = [];

    for (const target of frontier) {
      if (budget.remaining <= 0) {
        return undefined;
      }

      budget.remaining -= 1;

      for (const reference of queries.whoCalls({ file: target.file, symbol: target.symbol })) {
        const { caller } = reference;

        if (evidence.has(caller.nodeId)) {
          return depth + 1;
        }

        if (visited.has(caller.nodeId)) {
          continue;
        }

        visited.add(caller.nodeId);
        next.push({ file: caller.file, symbol: caller.name });
      }
    }

    frontier = next;
  }

  return undefined;
}

/**
 * How many hops a downstream path from an evidence root takes to reach an
 * owner; `undefined` when no root reaches it.
 *
 * The complement of {@link callerDistanceFromEvidence}, and the search that
 * connects a named route or component to a query site several calls below it:
 * `pathBetween` in the query surface's default direction — downstream, so
 * every hop points the way a request flows — within its own depth and node
 * budgets, from each root in turn. The shortest path wins, and the loop stops
 * at {@link DIRECT_CALLER_DISTANCE}, which no root can improve on.
 *
 * @param owner The candidate owner.
 * @param roots The evidence nodes to search from.
 * @param queries The project's read-only query surface.
 * @param budget The mutable remaining search budget, shared across owners.
 * @returns The shortest path depth found, or `undefined`.
 */
function pathDistanceFromRoots(
  owner: PgQuerySiteOwner,
  roots: readonly string[],
  queries: CodeQueries,
  budget: { remaining: number },
): number | undefined {
  let shortest: number | undefined;

  for (const root of roots) {
    if (budget.remaining <= 0) {
      break;
    }

    budget.remaining -= 1;

    const path = queries.pathBetween(root, owner.nodeId);

    if (path === undefined) {
      continue;
    }

    if (shortest === undefined || path.depth < shortest) {
      shortest = path.depth;
    }

    if (shortest <= DIRECT_CALLER_DISTANCE) {
      break;
    }
  }

  return shortest;
}

/**
 * One owner with the evidence tier it earned.
 *
 * Separated from {@link PgQuerySiteOwner} because a tier is a statement about
 * one question, while an owner is a fact about the project: the same owner
 * ranks differently for two different questions, and nothing about it changes.
 */
interface RankedOwner {
  readonly owner: PgQuerySiteOwner;
  readonly tier: number;

  /**
   * The hops measured from the evidence, for an
   * {@link EVIDENCE_TIER_REACHABLE} owner; `0` for every other tier, where no
   * distance was measured.
   */
  readonly distance: number;
}

/**
 * Orders two ranked owners.
 *
 * Exactly the documented order — evidence tier, then reachability distance
 * (shorter first, which only differs inside the reachable tier), then
 * project-relative file, then declaration line, then symbol — with the owner's
 * opaque node id as a final, always-distinct tie-break. The last key is what
 * makes the comparison a total order, and therefore what makes two runs over
 * the same graph produce identical arrays rather than arrays that happen to
 * agree.
 *
 * File, symbol and node id are compared by {@link compareText}, which orders by
 * code unit rather than by collation, so the result does not depend on the
 * host's locale.
 *
 * @param left The first ranked owner.
 * @param right The second.
 * @returns A negative number, zero, or a positive number, as a comparator.
 */
function compareRankedOwners(left: RankedOwner, right: RankedOwner): number {
  if (left.tier !== right.tier) {
    return left.tier - right.tier;
  }

  if (left.distance !== right.distance) {
    return left.distance - right.distance;
  }

  const byFile = compareText(left.owner.file, right.owner.file);

  if (byFile !== 0) {
    return byFile;
  }

  if (left.owner.line !== right.owner.line) {
    return left.owner.line - right.owner.line;
  }

  const bySymbol = compareText(left.owner.symbol, right.owner.symbol);

  return bySymbol === 0 ? compareText(left.owner.nodeId, right.owner.nodeId) : bySymbol;
}

/**
 * Compares two strings by code unit, deterministically and independently of the
 * host locale.
 *
 * Deliberately not `localeCompare`: a plan is stored, compared between runs and
 * asserted against, and a collation that varies with the host's locale would
 * make "the same graph yields the same plan" false on a different machine.
 *
 * @param left The first string.
 * @param right The second.
 * @returns A negative number, zero, or a positive number, as a comparator.
 */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

/* -------------------------------------------------------------------------------------------------
 * The dev-server preload: the one thing that decides whether this signal exists
 * ---------------------------------------------------------------------------------------------- */

/**
 * What the service observed about the dev-server preload for this project,
 * reduced to the three answers that change what a developer is told.
 *
 * - `'attached'` — a connection is up for this project and has been heard from
 *   inside the staleness window. The signal will be collected.
 * - `'silent'` — a connection is up but has said nothing, or nothing recently.
 *   The signal is reported `'degraded'`: it may be collected, and a capture is
 *   not held back for it.
 * - `'absent'` — no connection, a connection that has gone, or a connection
 *   that belongs to a different project. The signal cannot be collected at all.
 */
type PreloadState = 'attached' | 'silent' | 'absent';

/**
 * Reduces the observed `server-agent` facts to a {@link PreloadState}.
 *
 * The **only** source consulted is
 * {@link InstrumentationContext.readiness}.`serverAgent`, which is the frame the
 * service actually received. This function opens no socket, probes no port,
 * spawns nothing, reads no environment variable and touches no filesystem: the
 * service holds the evidence, and an adapter that went looking for its own could
 * contradict it and tell a developer a signal is ready while the spans the
 * product needs are not arriving.
 *
 * A project-root mismatch is `'absent'` rather than a lesser state, and that is
 * the load-bearing case: a preload attached to a sibling workspace package would
 * otherwise read as readiness for a project whose queries it will never see.
 *
 * @param context The session's context.
 * @param stalenessMs How long silence is tolerated before the state degrades.
 * @param now The clock, in epoch milliseconds.
 * @returns The reduced state.
 */
function resolvePreloadState(
  context: InstrumentationContext,
  stalenessMs: number,
  now: () => number,
): PreloadState {
  const agent = context.readiness.serverAgent;

  if (agent === undefined || !agent.connected) {
    return 'absent';
  }

  if (normalizePosix(toPosix(agent.projectRoot)) !== normalizePosix(toPosix(context.projectRoot))) {
    return 'absent';
  }

  const lastHeartbeatAt = agent.lastHeartbeatAt;

  if (lastHeartbeatAt === undefined) {
    return 'silent';
  }

  // A negative age is a clock that moved, not a fresh heartbeat from the future:
  // it is treated as fresh, because degrading a connected preload over a clock
  // adjustment would report a gap the developer cannot act on.
  const age = now() - lastHeartbeatAt;

  return age > stalenessMs ? 'silent' : 'attached';
}

/** The `reason` and `hint` pair a gap is reported with, in both channels. */
interface GapMessage {
  /** What was observed, as a fragment that reads after "Could not enable pg: ". */
  readonly reason: string;

  /** The one concrete thing the developer can do about it. */
  readonly hint: string;
}

/**
 * The shell fragment that runs a project's development server, for a package
 * manager the summary recognised.
 *
 * `undefined` for `'unknown'`, which is what routes the instruction to the
 * editor command instead of inventing a command line for a project whose tooling
 * was not identified.
 *
 * @param summary The project summary, whose `packageManager` the indexer read
 * from the target's own manifest and lockfile.
 * @returns The command fragment, or `undefined`.
 */
function devCommandFor(summary: ProjectSummary): string | undefined {
  switch (summary.packageManager) {
    case 'pnpm':
      return 'pnpm dev';
    case 'yarn':
      return 'yarn dev';
    case 'npm':
      return 'npm run dev';
    case 'bun':
      return 'bun run dev';
    default:
      return undefined;
  }
}

/**
 * The relaunch instruction for a project whose dev server carries no preload.
 *
 * Composed in the documented order of preference:
 *
 * 1. the caller's injected command, when it supplied one — the launcher knows
 *    exactly what it would run;
 * 2. otherwise the preload specifier and the project's own development command,
 *    both read as data (the specifier from the options or the defaults, the
 *    package manager from the project summary);
 * 3. otherwise an instruction naming the editor command that does it for the
 *    developer, which is the honest answer when the project's tooling was not
 *    identified.
 *
 * Every form names the project root, so a developer with several projects open
 * knows which dev server to relaunch, and no form contains a path inside this
 * repository (AAP §0.5.4) or a value read from the environment.
 *
 * @param context The session's context.
 * @param relaunch The caller's relaunch descriptor, possibly empty.
 * @returns The single-line, bounded hint.
 */
function composeRelaunchHint(
  context: InstrumentationContext,
  relaunch: PostgresRelaunchDescriptor,
): string {
  const { projectRoot } = context;
  const editorCommand = relaunch.editorCommandTitle ?? POSTGRES_ADAPTER_DEFAULTS.editorCommandTitle;
  const command = relaunch.command?.trim();

  if (command !== undefined && command.length > 0) {
    return toBoundedMessage(
      `Relaunch the dev server for ${projectRoot} with: ${command} - or run the "${editorCommand}" command in VS Code, which does it for you.`,
      MAX_MESSAGE_LENGTH,
    );
  }

  const specifier = relaunch.preloadSpecifier ?? POSTGRES_ADAPTER_DEFAULTS.preloadSpecifier;
  const devCommand = devCommandFor(context.projectSummary);

  if (devCommand !== undefined) {
    return toBoundedMessage(
      `Stop the dev server for ${projectRoot} and start it with NODE_OPTIONS="--import ${specifier}" ${devCommand} - or run the "${editorCommand}" command in VS Code, which does it for you.`,
      MAX_MESSAGE_LENGTH,
    );
  }

  return toBoundedMessage(
    `Run the "${editorCommand}" command in VS Code for ${projectRoot}, which restarts the dev server with the Debug Generator Node preload attached.`,
    MAX_MESSAGE_LENGTH,
  );
}

/**
 * The gap report for a project whose dev server carries no preload.
 *
 * @param context The session's context.
 * @param relaunch The caller's relaunch descriptor.
 * @returns The reason and the actionable hint.
 */
function describeAbsentPreload(
  context: InstrumentationContext,
  relaunch: PostgresRelaunchDescriptor,
): GapMessage {
  return {
    reason: toBoundedMessage(
      'the dev server for this project is not running with the Debug Generator Node preload, so the PostgreSQL driver is not instrumented and no database query spans can be produced',
      MAX_MESSAGE_LENGTH,
    ),
    hint: composeRelaunchHint(context, relaunch),
  };
}

/**
 * The gap report for a preload that is connected but has stopped reporting.
 *
 * A `'degraded'` statement rather than an `'unavailable'` one: the connection is
 * up, so query spans may still arrive, and a capture is not worth holding back
 * for silence that a restart fixes.
 *
 * @param context The session's context.
 * @param relaunch The caller's relaunch descriptor.
 * @param stalenessMs The window that was exceeded, in milliseconds.
 * @returns The reason and the actionable hint.
 */
function describeSilentPreload(
  context: InstrumentationContext,
  relaunch: PostgresRelaunchDescriptor,
  stalenessMs: number,
): GapMessage {
  const seconds = Math.max(Math.round(stalenessMs / 1000), 1);

  return {
    reason: toBoundedMessage(
      `the dev-server preload for this project has not reported in the last ${seconds}s, so database query spans may be incomplete`,
      MAX_MESSAGE_LENGTH,
    ),
    hint: composeRelaunchHint(context, relaunch),
  };
}

/**
 * The gap report for the observed state, or `undefined` when there is none.
 *
 * @param state The reduced preload state.
 * @param context The session's context.
 * @param relaunch The caller's relaunch descriptor.
 * @param stalenessMs The staleness window in force.
 * @returns The report, or `undefined` for `'attached'`.
 */
function describePreloadGap(
  state: PreloadState,
  context: InstrumentationContext,
  relaunch: PostgresRelaunchDescriptor,
  stalenessMs: number,
): GapMessage | undefined {
  if (state === 'absent') {
    return describeAbsentPreload(context, relaunch);
  }

  if (state === 'silent') {
    return describeSilentPreload(context, relaunch, stalenessMs);
  }

  return undefined;
}

/**
 * The readiness status one {@link PreloadState} corresponds to.
 *
 * The mapping is the whole of this adapter's readiness policy, and it is a pure
 * function of an observation: `'attached'` collects the signal, `'silent'`
 * collects it with a stated limitation, `'absent'` does not collect it and is
 * the one status that holds a capture back.
 *
 * @param state The reduced preload state.
 * @returns The corresponding status from `../schema/readiness.ts`'s vocabulary.
 */
function statusFor(state: PreloadState): ReadinessStatus {
  switch (state) {
    case 'attached':
      return 'available';
    case 'silent':
      return 'degraded';
    default:
      return 'unavailable';
  }
}

/* -------------------------------------------------------------------------------------------------
 * When a question is asking about database time
 * ---------------------------------------------------------------------------------------------- */

/**
 * The capture signals that name database evidence outright.
 *
 * Both drivers, not just this adapter's: an understanding that asked for query
 * spans asked about *the database*, and which library reports them is a fact
 * about the project rather than about the question. `../schema/readiness.ts`
 * maps both to the same `db.query` telemetry kind for the same reason.
 */
const DATABASE_CAPTURE_SIGNALS = Object.freeze([
  'prisma',
  'pg',
] as const satisfies readonly CaptureSignal[]);

/**
 * The capture signals that name server-tier evidence.
 *
 * A question that asks for incoming-request, route-handler or function spans is
 * a question about where server time goes, and in a project that reaches
 * PostgreSQL through the driver, database time is part of that answer — the
 * slow multi-tier interaction of AAP §0.8.4's first acceptance test is exactly
 * this case. Treating them as a database request is therefore not an
 * over-reach; it is what keeps a latency question from producing a trace whose
 * deepest span is the route handler.
 */
const SERVER_TIER_CAPTURE_SIGNALS = Object.freeze([
  'http',
  'routeHandlers',
  'functions',
] as const satisfies readonly CaptureSignal[]);

/**
 * Whether one of a set of signals appears in the understanding's needs.
 *
 * @param understanding The validated problem understanding.
 * @param wanted The signals to look for.
 * @returns `true` when any wanted signal was asked for.
 */
function requests(understanding: ProblemUnderstanding, wanted: readonly CaptureSignal[]): boolean {
  return understanding.signalsNeeded.some((needed) => wanted.some((signal) => signal === needed));
}

/* -------------------------------------------------------------------------------------------------
 * Resolved options
 * ---------------------------------------------------------------------------------------------- */

/** The options as the adapter uses them: every knob decided, nothing to re-derive. */
interface ResolvedPostgresOptions {
  /** The effective anchor cap: a whole number between 1 and the shipped ceiling. */
  readonly maxTargets: number;

  /** The effective staleness window, in milliseconds. */
  readonly heartbeatStalenessMs: number;

  /** The caller's clock, when it injected one. */
  readonly now?: (() => number) | undefined;

  /** The caller's logger, when it injected one. */
  readonly logger?: Logger | undefined;

  /** The caller's relaunch descriptor; an empty object when it supplied none. */
  readonly relaunch: PostgresRelaunchDescriptor;
}

/**
 * Decides every knob once, at construction.
 *
 * An unusable value is replaced by the shipped default rather than propagated:
 * a caller that passed `0`, a fraction, `NaN` or a negative window has a bug,
 * and answering it with a proposal of no anchors or a staleness window that
 * degrades every preload would report that bug as a property of the developer's
 * project. The substitution is silent here and visible in the debug line the
 * adapter's first call emits.
 *
 * @param options The caller's options, possibly empty.
 * @returns The resolved options.
 */
function resolveOptions(options: PostgresAdapterOptions): ResolvedPostgresOptions {
  const requestedTargets = options.maxTargets;
  const maxTargets =
    requestedTargets !== undefined && Number.isInteger(requestedTargets) && requestedTargets >= 1
      ? Math.min(requestedTargets, POSTGRES_ADAPTER_DEFAULTS.maxTargetsCeiling)
      : POSTGRES_ADAPTER_DEFAULTS.maxTargets;

  const requestedStaleness = options.heartbeatStalenessMs;
  const heartbeatStalenessMs =
    requestedStaleness !== undefined &&
    Number.isFinite(requestedStaleness) &&
    requestedStaleness > 0
      ? requestedStaleness
      : POSTGRES_ADAPTER_DEFAULTS.heartbeatStalenessMs;

  return {
    maxTargets,
    heartbeatStalenessMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    relaunch: options.relaunch ?? {},
  };
}

/**
 * The adapter's logger for one call: the caller's, or the session's, tagged with
 * this adapter's id.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns A child logger bound to this adapter.
 */
function adapterLogger(context: InstrumentationContext, options: ResolvedPostgresOptions): Logger {
  return (options.logger ?? context.logger).child({ adapter: POSTGRES_ADAPTER_ID });
}

/**
 * The clock for one call: the session's, the caller's, then the wall clock.
 *
 * The session's clock wins because a readiness report and a staleness decision
 * taken during the same session must agree, and the context is what the service
 * threads through every other participant.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns A function returning epoch milliseconds.
 */
function resolveClock(
  context: InstrumentationContext,
  options: ResolvedPostgresOptions,
): () => number {
  return context.now ?? options.now ?? nowEpochMs;
}

/* -------------------------------------------------------------------------------------------------
 * Proposals
 * ---------------------------------------------------------------------------------------------- */

/** The evidence and the two shared budgets one proposal ranks its owners against. */
interface RankingInputs {
  /** The node ids the understanding resolved to. */
  readonly evidence: ReadonlySet<string>;

  /** The evidence nodes a downstream search starts from. */
  readonly roots: readonly string[];

  /** The project's read-only query surface. */
  readonly queries: CodeQueries;

  /** The remaining caller-lookup budget, shared across owners. */
  readonly callerBudget: { remaining: number };

  /** The remaining path-search budget, shared across owners. */
  readonly pathBudget: { remaining: number };
}

/**
 * The evidence tier an owner earned for this question, and its distance from
 * the evidence when it earned the reachable tier.
 *
 * The caller walk runs first because it is the cheaper of the two routes; the
 * downstream search runs only when the walk found nothing as close as
 * {@link DIRECT_CALLER_DISTANCE}, and the shorter of the two distances is
 * kept.
 *
 * @param owner The candidate owner.
 * @param inputs The evidence, the roots and the shared budgets.
 * @returns The ranked owner: {@link EVIDENCE_TIER_NAMED},
 * {@link EVIDENCE_TIER_REACHABLE} with its distance, or
 * {@link EVIDENCE_TIER_UNNARROWED}.
 */
function rankOwner(owner: PgQuerySiteOwner, inputs: RankingInputs): RankedOwner {
  const { evidence } = inputs;

  if (evidence.size === 0) {
    // The understanding named nothing this project has, so nothing narrows the
    // candidate set and every owner is considered on equal terms.
    return { owner, tier: EVIDENCE_TIER_UNNARROWED, distance: 0 };
  }

  if (evidence.has(owner.nodeId) || owner.callNodeIds.some((id) => evidence.has(id))) {
    return { owner, tier: EVIDENCE_TIER_NAMED, distance: 0 };
  }

  const byCallers = callerDistanceFromEvidence(
    owner,
    evidence,
    inputs.queries,
    inputs.callerBudget,
  );
  const byPath =
    byCallers !== undefined && byCallers <= DIRECT_CALLER_DISTANCE
      ? undefined
      : pathDistanceFromRoots(owner, inputs.roots, inputs.queries, inputs.pathBudget);
  const distance =
    byCallers === undefined
      ? byPath
      : byPath === undefined
        ? byCallers
        : Math.min(byCallers, byPath);

  return distance === undefined
    ? { owner, tier: EVIDENCE_TIER_UNNARROWED, distance: 0 }
    : { owner, tier: EVIDENCE_TIER_REACHABLE, distance };
}

/**
 * Why one anchor is in the plan, in the developer's terms.
 *
 * States the graph relationship and the one thing about this signal a developer
 * has to know to read the plan correctly: the instrumentation is process-wide,
 * so the anchor is a query site the investigation found and **not** a change to
 * the named file. It carries a file, a symbol and a count — never a statement,
 * never a statement shape, never a connection string (AAP §0.5.2).
 *
 * @param owner The owner the anchor names.
 * @returns The bounded, single-line rationale.
 */
function composeRationale(owner: PgQuerySiteOwner): string {
  const sites =
    owner.callSites === 1 ? '1 database call site' : `${owner.callSites} database call sites`;

  return toBoundedMessage(
    `The code graph records ${sites} reaching the PostgreSQL driver inside this function. Query spans come from the dev-server preload, which instruments the driver process-wide, so this target arms a runtime signal and modifies no file.`,
    MAX_RATIONALE_LENGTH,
  );
}

/**
 * Builds the action for one anchor.
 *
 * Every identity field is supplied rather than left to normalisation, so a
 * proposal this adapter returns is already the shape `../schema/plan.ts`
 * validates and `../feasibility.ts` checks: a fresh opaque id, the owner's
 * normalised project-relative file, the owner's declared symbol, the claimed
 * type and mode, and a stated reason.
 *
 * @param owner The owner the anchor names.
 * @returns The action.
 */
function buildAction(owner: PgQuerySiteOwner): InstrumentationAction {
  return {
    id: newActionId(),
    file: owner.file,
    symbol: owner.symbol,
    type: CLAIMED_ACTION_TYPE,
    adapter: POSTGRES_ADAPTER_ID,
    mode: CLAIMED_MODE,
    rationale: composeRationale(owner),
  };
}

/**
 * De-duplicates and orders a hook list.
 *
 * {@link InstallResult.runtimeHooks} and
 * {@link RemoveResult.runtimeHooksDisabled} reach a developer and are stored on
 * the session, so two identical installs must produce identical lists.
 *
 * @param names The hook names.
 * @returns A fresh, de-duplicated, ordered array.
 */
function stableHookList(names: readonly string[]): string[] {
  return [...new Set(names)].sort(compareText);
}

/**
 * Whether the session has been aborted.
 *
 * A function rather than an inline check at each step boundary, and that is
 * load-bearing rather than tidy: `AbortSignal.aborted` is a getter whose value
 * changes under the caller, while `../adapter.ts` declares
 * {@link InstrumentationContext.signal} `readonly` — so the compiler narrows an
 * inline check and treats every later one as dead code. Reading it through a
 * call defeats that narrowing, which is what lets a proposal honour a
 * cancellation that arrives while it is being assembled.
 *
 * @param context The session's context.
 * @returns `true` when a signal is present and has been aborted.
 */
function isAborted(context: InstrumentationContext): boolean {
  return context.signal?.aborted === true;
}

/* -------------------------------------------------------------------------------------------------
 * The adapter
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates the PostgreSQL driver adapter.
 *
 * A factory rather than a singleton or a class with static state: `../registry.ts`
 * constructs the built-in adapters inside `createAdapterRegistry`, and a caller
 * that needs a frozen clock, a tighter anchor cap or its own relaunch command
 * constructs a second instance without disturbing the first. **Importing this
 * module has no side effect and constructing an adapter has none either** — no
 * environment variable is read, no socket is opened, no process is spawned, no
 * file is touched and no global is mutated, here or in any method below. Every
 * fact an answer depends on arrives on the {@link InstrumentationContext}.
 *
 * @param options Injected knobs; every one is optional and fully defaulted, so
 * `createPostgresAdapter()` is the production configuration. See
 * {@link PostgresAdapterOptions}.
 * @returns The adapter, carrying its claim declaration. Assignable to
 * {@link InstrumentationAdapter} wherever the registry stores it.
 *
 * @example
 * ```ts
 * const adapter = createPostgresAdapter();
 *
 * if (adapter.canHandle(context)) {
 *   const actions = await adapter.createPlan(context, understanding);
 *   const result = await adapter.install(actions, context);
 *   // result.applied is always empty: nothing was written.
 * }
 * ```
 */
export function createPostgresAdapter(options: PostgresAdapterOptions = {}): PostgresAdapter {
  const resolved = resolveOptions(options);

  return {
    id: POSTGRES_ADAPTER_ID,
    claims: POSTGRES_ADAPTER_CLAIMS,

    /**
     * Whether this project queries PostgreSQL through the raw driver.
     *
     * Synchronous, cheap and graph-only. It is the question the registry
     * disambiguates the two `'db-query-tracking'` claimants with, so it answers
     * `false` for a project that reaches the database only through a generated
     * client — and `true` for a project with driver call sites even when no
     * dev-server preload is attached, because that gap belongs to
     * {@link InstrumentationAdapter.readiness}.
     */
    canHandle(context: InstrumentationContext): boolean {
      return projectUsesPgDriver(context);
    },

    /**
     * Proposes the anchors a plan should carry for this question.
     *
     * Returns an empty array — never throws and never rejects — when the driver
     * is unused, when the question asks for no database or server-tier
     * evidence, when the graph records no addressable owner for a driver call
     * site, when every such owner belongs to a tooling module, or when the
     * session was aborted. An empty proposal is an answer.
     *
     * Owners are ranked named, then reachable (shortest path first), then
     * unnarrowed, and the proposal is drawn from the strongest tier reached
     * alone, up to the anchor budget.
     */
    createPlan(
      context: InstrumentationContext,
      understanding: ProblemUnderstanding,
    ): Promise<InstrumentationAction[]> {
      const log = adapterLogger(context, resolved);

      if (isAborted(context)) {
        log.debug('proposing nothing: the session was aborted before planning started', {
          sessionId: context.sessionId,
          planVersion: context.planVersion,
        });

        return Promise.resolve([]);
      }

      if (!projectUsesPgDriver(context)) {
        log.debug('proposing nothing: the code graph records no driver call site', {
          sessionId: context.sessionId,
          databaseAccessStyle: context.projectSummary.databaseAccess.style,
        });

        return Promise.resolve([]);
      }

      const databaseRequested = requests(understanding, DATABASE_CAPTURE_SIGNALS);
      const serverRequested = requests(understanding, SERVER_TIER_CAPTURE_SIGNALS);

      if (!databaseRequested && !serverRequested) {
        // AAP §0.5.1's guarantee, enforced at the point the plan is proposed: a
        // question about the page has not asked this product to read the
        // project's queries, so no database action is offered for it.
        log.debug('proposing nothing: the question asks for no database or server-tier evidence', {
          sessionId: context.sessionId,
          category: understanding.category,
          signalsNeeded: understanding.signalsNeeded.length,
        });

        return Promise.resolve([]);
      }

      const collected = collectPgQuerySiteOwners(context.graph);

      if (collected.length === 0) {
        log.debug('proposing nothing: no addressable function encloses a driver call site', {
          sessionId: context.sessionId,
          callSites: pgCallSites(context.graph).length,
        });

        return Promise.resolve([]);
      }

      // A seed, migration, script, test or configuration module runs in a
      // process of its own rather than in the dev server the preload
      // instruments (AAP §0.5.1), so none of its queries can reach a capture
      // and an anchor on it would promise evidence that never arrives.
      const owners = collected.filter((owner) => !isToolingModulePath(owner.file));
      const toolingOwners = collected.length - owners.length;

      if (owners.length === 0) {
        log.debug('proposing nothing: every driver query site belongs to a tooling module', {
          sessionId: context.sessionId,
          toolingOwners,
        });

        return Promise.resolve([]);
      }

      const evidence = resolveEvidenceNodeIds(understanding, context.queries);
      const inputs: RankingInputs = {
        evidence,
        roots: reachabilityRoots(evidence, context.graph),
        queries: context.queries,
        callerBudget: { remaining: MAX_CALLER_LOOKUPS },
        pathBudget: { remaining: MAX_PATH_SEARCHES },
      };
      const ranked = owners.map((owner) => rankOwner(owner, inputs)).sort(compareRankedOwners);

      // The strongest tier any owner reached is the only tier drawn from: once
      // the question names or reaches a function, padding the proposal with
      // functions it says nothing about would dilute the anchors a developer
      // reads. The unnarrowed fallback therefore applies only when nothing
      // narrowed, which is when every owner is in that tier.
      const bestTier = ranked[0]?.tier ?? EVIDENCE_TIER_UNNARROWED;
      const actions: InstrumentationAction[] = [];
      let unresolved = 0;

      for (const entry of ranked) {
        if (
          entry.tier !== bestTier ||
          actions.length >= resolved.maxTargets ||
          isAborted(context)
        ) {
          break;
        }

        // The feasibility gate would reject an action whose symbol the graph
        // cannot find; asking first means a proposal never carries one.
        if (!context.queries.hasSymbol(entry.owner.file, entry.owner.symbol)) {
          unresolved += 1;
          continue;
        }

        actions.push(buildAction(entry.owner));
      }

      log.debug('proposed driver query tracking anchored on the query sites the graph found', {
        sessionId: context.sessionId,
        planVersion: context.planVersion,
        signal: PG_SIGNAL,
        databaseRequested,
        serverRequested,
        owners: owners.length,
        toolingOwners,
        evidence: evidence.size,
        roots: inputs.roots.length,
        tier: bestTier,
        proposed: actions.length,
        unresolved,
        maxTargets: resolved.maxTargets,
      });

      return Promise.resolve(actions);
    },

    /**
     * Arms the driver's query spans, and reports the gap when it cannot.
     *
     * Writes nothing: {@link InstallResult.applied} is always empty, no
     * modification record is journaled and no file is opened. What it
     * contributes is {@link ServerAgentSignals.pg}, derived by
     * `../schema/readiness.ts` from the actions that were accepted, and — when
     * the dev-server preload is missing or has gone quiet — one
     * {@link UnavailableSignal} whose hint is the exact relaunch instruction for
     * this project.
     *
     * Never rejects. A missing signal is data, not a failure (AAP §0.5.5), and
     * there is no write here whose outcome could be unknowable.
     */
    install(
      actions: readonly InstrumentationAction[],
      context: InstrumentationContext,
    ): Promise<InstallResult> {
      const log = adapterLogger(context, resolved);
      const accepted = actions.filter(
        (action) => action.adapter === POSTGRES_ADAPTER_ID && action.type === CLAIMED_ACTION_TYPE,
      );

      if (accepted.length === 0) {
        // Nothing of this adapter's kind was asked for, so nothing of its kind
        // is unavailable. Reporting a gap here would put "Could not enable pg"
        // in front of a developer who never asked for it - including every
        // developer whose project does not use the driver at all. The server
        // configuration key is omitted for the same reason: this adapter arms
        // nothing in the dev-server process on this install, and a `false`
        // contribution could only argue with an adapter that does.
        log.debug('installed nothing: no action resolved to this adapter', {
          sessionId: context.sessionId,
          planVersion: context.planVersion,
          offered: actions.length,
        });

        return Promise.resolve({
          adapterId: POSTGRES_ADAPTER_ID,
          applied: [],
          runtimeHooks: [],
          unavailable: [],
        });
      }

      const state = resolvePreloadState(
        context,
        resolved.heartbeatStalenessMs,
        resolveClock(context, resolved),
      );
      const gap = describePreloadGap(
        state,
        context,
        resolved.relaunch,
        resolved.heartbeatStalenessMs,
      );
      const unavailable: UnavailableSignal[] =
        gap === undefined ? [] : [{ signal: PG_SIGNAL, reason: gap.reason, hint: gap.hint }];

      // `deriveServerAgentSignals` owns the action-type-to-key mapping; this
      // adapter narrows its answer to the one key it speaks for and never maps a
      // type to a key itself, so a key the preload does not parse cannot reach
      // the wire. `functions` is deliberately untouched: named function timing
      // belongs to the framework adapter's patch-mode actions.
      const serverSignals: Partial<ServerAgentSignals> = {
        pg: deriveServerAgentSignals(accepted).pg,
      };

      // A hook is listed only where there is a process holding it: an absent
      // preload has nothing armed, while a connected-but-quiet one does, and its
      // limitation is stated in `unavailable` instead.
      const runtimeHooks = state === 'absent' ? [] : stableHookList(POSTGRES_RUNTIME_HOOKS);

      log.debug('armed the driver query signal as far as the observed dev server allows', {
        sessionId: context.sessionId,
        planVersion: context.planVersion,
        signal: PG_SIGNAL,
        preload: state,
        accepted: accepted.length,
        offered: actions.length,
        runtimeHooks: runtimeHooks.length,
        unavailable: unavailable.length,
      });

      return Promise.resolve({
        adapterId: POSTGRES_ADAPTER_ID,
        applied: [],
        runtimeHooks,
        unavailable,
        serverSignals,
      });
    },

    /**
     * Relinquishes the driver query signal.
     *
     * There is nothing on disk to undo, so {@link RemoveResult.restored} and
     * {@link RemoveResult.conflicts} are always empty and no file is opened. The
     * signal itself is disabled by the service, which sends
     * `server-agent.config` with no `captureId`; that makes
     * `packages/telemetry/src/node/control.ts` call `disable()` on its driver
     * instrumentation, unwrapping the client methods it had patched so the
     * application keeps serving with nothing observing it (AAP §0.5.1).
     *
     * Idempotent, and safe to call again after a crash or a reconnect. A
     * `'reconcile'` reports no disabled hook: the process that held it is gone,
     * and claiming to have detached something that no longer exists would be a
     * report a developer could not verify.
     */
    remove(session: AdapterRemoveRequest, context: InstrumentationContext): Promise<RemoveResult> {
      const log = adapterLogger(context, resolved);
      const runtimeHooksDisabled =
        session.reason === 'reconcile' ? [] : stableHookList(POSTGRES_RUNTIME_HOOKS);

      log.debug('relinquished the driver query signal', {
        sessionId: session.sessionId,
        planVersion: session.planVersion ?? context.planVersion,
        reason: session.reason,
        signal: PG_SIGNAL,
        runtimeHooksDisabled: runtimeHooksDisabled.length,
      });

      return Promise.resolve({
        adapterId: POSTGRES_ADAPTER_ID,
        restored: [],
        conflicts: [],
        runtimeHooksDisabled,
      });
    },

    /**
     * Reports whether the driver's query spans can be collected here.
     *
     * A pure function of the observed `server-agent` facts and the code graph:
     * `'available'` for a preload that is attached to this project and has
     * reported recently, `'degraded'` for one that is connected but quiet, and
     * `'unavailable'` — the one status that holds "Ready to capture" back — for
     * one that is absent, gone, or attached to a different project. Nothing is
     * polled, probed, spawned or read from the environment.
     *
     * A project that does not use the driver is **ready with no rows**, which is
     * the contract's way of saying "not applicable" and a different statement
     * from an adapter whose signal is unavailable.
     */
    readiness(context: InstrumentationContext): Promise<Readiness> {
      const clock = resolveClock(context, resolved);

      if (!projectUsesPgDriver(context)) {
        return Promise.resolve(
          buildReadiness({ adapter: POSTGRES_ADAPTER_ID, signals: [], now: clock }),
        );
      }

      const state = resolvePreloadState(context, resolved.heartbeatStalenessMs, clock);
      const gap = describePreloadGap(
        state,
        context,
        resolved.relaunch,
        resolved.heartbeatStalenessMs,
      );
      const row: ReadinessSignal = {
        signal: PG_SIGNAL,
        status: statusFor(state),
        ...(gap === undefined ? {} : { reason: gap.reason, hint: gap.hint }),
      };

      return Promise.resolve(
        buildReadiness({ adapter: POSTGRES_ADAPTER_ID, signals: [row], now: clock }),
      );
    },
  };
}
