/**
 * The **Prisma adapter** — one of the six built-in adapters of
 * `@debuggen/instrumentation`, and the one that arms the object-relational
 * mapper's query spans.
 *
 * It claims the `'db-query-tracking'` action type in `'runtime'` mode, because
 * the spans it is responsible for are produced by an instrumentation that
 * already exists inside the dev-server preload
 * (`packages/telemetry/src/node/register.ts`). Nothing here writes
 * to a developer's project: {@link InstallResult.applied} is **always** empty,
 * no module under `../patch/**` is imported, and no filesystem, network,
 * environment or process API is touched. This adapter *arms a signal*; it does
 * not patch code.
 *
 * ## The dual claim, and why `canHandle` has to be honest
 *
 * `'db-query-tracking'` is the one action type two built-in adapters claim —
 * this one and its `./postgres.ts` sibling — and `../registry.ts` disambiguates
 * them by asking each claimant's
 * {@link InstrumentationAdapter.canHandle}. That makes `canHandle` a
 * *load-bearing* answer rather than a formality: it must be a truthful,
 * graph-only statement about whether **this** project reaches its database
 * through the generated client, and it must be `false` for a project that
 * reaches it only through the driver. A `canHandle` that answered `true` for
 * every project with a database would make the registry's choice arbitrary and
 * would require the preload for a signal this adapter could never contribute.
 *
 * ## Detection is a graph read, never a name
 *
 * The question "does this project use the object-relational mapper?" is
 * answered from `db-call` nodes whose `DbCallNodeData.driver` is the mapper's
 * driver value, corroborated by `ProjectSummary.databaseAccess.style` — both
 * of which `@debuggen/code-analysis` derives from the same call sites. No model
 * name, table name, delegate method, client variable name or import specifier
 * appears as a literal anywhere below — the product carries no built-in
 * knowledge of any project — and `scripts/check-no-hardcoding.mjs` reads this
 * file with ts-morph to enforce that.
 *
 * That is not only a policy: it is where the truth actually lives. The driver
 * handles of a project normally sit in a *different module* from the call
 * sites, and the extractor discovers them structurally by following resolved
 * imports to the construction site — so a client's local variable name is
 * evidence of nothing, while `DbCallNodeData.driver` is the classification that
 * pass already made.
 *
 * ## Which query sites it anchors on
 *
 * Only ones the dev server can actually execute. The mapper's spans are runtime
 * hooks the preload installs in the **dev-server process**, and a seed,
 * migration, script, test or configuration module runs in a process of its own
 * — the ORM's seed command, a test runner — so a query it issues is never
 * observed, and an anchor on it promises evidence that never arrives.
 * Such modules are recognised by `@debuggen/code-analysis`'s
 * `isToolingModulePath`, which is built from published tool conventions rather
 * than from any project's vocabulary, and are left out before ranking.
 *
 * Among the rest, a question that names a route or a component is answered with
 * the query sites that route or component actually **reaches**: a bounded
 * downstream `pathBetween` search from each node the question resolved to, so a
 * service function two or three calls below a route handler ranks ahead of an
 * unrelated one, and the shortest path wins.
 *
 * ## What it reports when it cannot deliver
 *
 * The mapper's spans need the preload loaded in the target project's
 * dev-server process, and a developer who started that server themselves does
 * not have it. The answer is a *report*, never an exception and never a
 * rejected promise: one {@link UnavailableSignal} whose `reason` states what
 * was observed and whose `hint` carries the exact relaunch instruction, so the
 * capture proceeds with the signals that *are* available. Three outcomes, and
 * the third is as important as the others:
 *
 * | Observed | Reported |
 * | --- | --- |
 * | mapper in the graph, no preload for this project | `'unavailable'` row + relaunch hint |
 * | mapper in the graph, preload connected but silent past the staleness window | `'degraded'` row + restart hint |
 * | mapper not used by this project at all | **nothing** — no action, no row, no noise |
 *
 * A spurious "could not enable" on a project that never queries through the
 * mapper is a defect, not diligence: it would push the session's readiness
 * gate into reporting a gap the developer cannot close and has no reason to.
 *
 * ## Everything comes from the context
 *
 * Readiness is decided **only** from the facts the service observed and handed
 * over on {@link InstrumentationContext.readiness} — there is no probe, no
 * poll, no port check and no environment read here, because the service holds
 * the evidence (the `server-agent` connection for this project) and an adapter
 * that went looking for its own could contradict it. The clock, the logger and
 * the relaunch wording are injected for the same reason, which is what lets
 * this adapter be exercised with no dev server, no browser and no working
 * tree.
 *
 * ## Module shape
 *
 * Importing this module has **no side effect**: it declares constants, types
 * and functions, and {@link createPrismaAdapter} is a factory the registry
 * calls inside `createAdapterRegistry`. Nothing is registered, mutated or read
 * at load time, which keeps `package.json`'s `sideEffects: false` true through
 * this file.
 *
 * Its `./postgres.ts` sibling is deliberately near-identical. The two files
 * stay independent — no shared private module, no import between adapters —
 * and their differences are exactly three: the driver they match, the server
 * signal key they contribute, and the wording of their prose.
 */

import { newActionId, normalizePosix, nowEpochMs, toPosix } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';
import { isToolingModulePath } from '@debuggen/code-analysis';
import type {
  CodeGraph,
  CodeMatch,
  CodeNodeKind,
  CodeNodeOf,
  CodePathEndpoint,
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
import {
  CAPTURE_SIGNALS,
  buildReadiness,
  deriveServerAgentSignals,
  telemetryKindsForSignal,
} from '../schema/readiness.js';
import type {
  CaptureSignal,
  Readiness,
  ReadinessSignal,
  ReadinessStatus,
  ServerAgentSignalKey,
  ServerAgentSignals,
} from '../schema/readiness.js';
import type { ProblemEntityKind, ProblemUnderstanding } from '../schema/target.js';

// ---------------------------------------------------------------------------
// Identity, claim and contributed signal
//
// Three vocabularies name this adapter's subject with the same token — the
// registry's adapter id, `@debuggen/code-analysis`'s `DB_DRIVERS` member and
// `../schema/readiness.ts`'s server signal key — so the token is written once,
// here, and every other use derives from it with a `satisfies` check against
// the vocabulary that owns it. A rename in any one of the three then fails this
// file at compile time instead of silently disarming a signal.
// ---------------------------------------------------------------------------

/**
 * This adapter's identity, as `../registry.ts` registers it and as every
 * action, install result and readiness report attributes work to it.
 *
 * Equal to the corresponding `ADAPTER_IDS` member in the registry — the
 * canonical spelling, which is also this file's name. It is stable across
 * versions by contract: a stored plan or a modification record read back after
 * an upgrade names the adapter that produced it, and an id that moved would
 * orphan it.
 */
export const PRISMA_ADAPTER_ID = 'prisma';

/**
 * The `db-call` driver value this adapter matches.
 *
 * `satisfies DbDriver` rather than a bare literal: `DbDriver` is derived from
 * `DB_DRIVERS` in `@debuggen/code-analysis`, so this declaration *is* the
 * membership check against that vocabulary, and a driver renamed or dropped
 * there stops this file from compiling. The value is compared against
 * `DbCallNodeData.driver`, which is where the indexer recorded the
 * classification — never against a client variable name, an import specifier
 * or a delegate method.
 */
const PRISMA_DRIVER = PRISMA_ADAPTER_ID satisfies DbDriver;

/**
 * The capture signal this adapter reports on.
 *
 * `satisfies CaptureSignal` against `../schema/readiness.ts`'s closed
 * vocabulary, so the name that appears in a readiness row and in the
 * developer-facing "Could not enable ‹signal›: ‹reason›." sentence cannot
 * drift from the one the service and the preload agree on.
 */
const PRISMA_SIGNAL = PRISMA_ADAPTER_ID satisfies CaptureSignal;

/**
 * The `ServerAgentSignals` keys this adapter contributes — exactly one.
 *
 * Exported because the registry and the service read it to know which slice of
 * the preload's configuration belongs to this adapter, and because a suite
 * asserts that the contribution is narrowed to it. `satisfies` pins each member
 * to a real key of that wire contract: `ServerAgentSignals` has exactly six,
 * parsed structurally by the preload, so contributing an unknown one would be a
 * wire-level break rather than a type error at the recipient.
 */
export const PRISMA_SERVER_SIGNAL_KEYS = [
  PRISMA_ADAPTER_ID,
] as const satisfies readonly ServerAgentSignalKey[];

/**
 * The single key of {@link PRISMA_SERVER_SIGNAL_KEYS}, for the narrowing in
 * {@link InstallResult.serverSignals}.
 *
 * A tuple index rather than a second literal, so the exported tuple stays the
 * one place the key is written.
 */
const PRISMA_SERVER_SIGNAL_KEY = PRISMA_SERVER_SIGNAL_KEYS[0];

/**
 * One action type an adapter claims, and the mode it installs it in.
 *
 * The shape of {@link PRISMA_ADAPTER_CLAIMS}. `mode` belongs beside `type`
 * because the adapter that claims a type is the thing that knows whether a
 * runtime hook can satisfy it — which, for this adapter, is the whole reason a
 * developer's file is never touched.
 */
export interface PrismaAdapterClaim {
  /** The action type claimed. */
  readonly type: InstrumentationActionType;

  /** How an action of that type is installed. */
  readonly mode: InstrumentationMode;
}

/**
 * The one claim, written once and type-checked against both vocabularies.
 *
 * The annotation is what does the checking: `type` is admitted only if it is a
 * member of `../schema/plan.ts`'s eight action types and `mode` only if it is
 * one of its two install modes, so a vocabulary change fails this declaration
 * rather than producing an action the installer cannot route. Every other use
 * of the pair — the exported array, the accepted-type set, and the two fields
 * of a proposed action — reads it from here.
 */
const PRISMA_CLAIM: PrismaAdapterClaim = Object.freeze({
  type: 'db-query-tracking',
  mode: 'runtime',
});

/**
 * What this adapter claims: `'db-query-tracking'`, installed in `'runtime'`
 * mode.
 *
 * **The single place this adapter's type and mode are written.** `../registry.ts`
 * imports it to build its capability catalog and to route a normalised plan's
 * actions, and {@link createPrismaAdapter} exposes the same array on the
 * adapter object, so a reader of either sees one statement rather than two.
 *
 * It deliberately encodes **no exclusivity**. The sibling `./postgres.ts`
 * claims the same type, and which of the two applies to a project is settled by
 * {@link InstrumentationAdapter.canHandle} — an adapter that tried to declare
 * itself the sole claimant would be asserting something about a project it has
 * not been shown yet.
 *
 * Frozen, and frozen per entry: the registry hands it to a planner that has no
 * reason to be careful with it.
 */
export const PRISMA_ADAPTER_CLAIMS: readonly PrismaAdapterClaim[] = Object.freeze([PRISMA_CLAIM]);

/**
 * The claim declaration as it appears on the adapter object.
 *
 * `../adapter.ts`'s {@link InstrumentationAdapter} declares no claims member —
 * adapter identity and capability belong to the registry — so the declaration
 * is intersected onto this adapter's type instead of replacing anything. The
 * result is still a {@link InstrumentationAdapter}, which is what the
 * installer, the readiness gate and cleanup hold it as.
 */
export interface PrismaAdapterClaims {
  /** What this adapter claims. See {@link PRISMA_ADAPTER_CLAIMS}. */
  readonly claims: readonly PrismaAdapterClaim[];
}

/**
 * This adapter's public type: the contract every adapter implements, plus the
 * claim declaration above and the narrowed id.
 *
 * Assignable to {@link InstrumentationAdapter} in every position, so nothing
 * downstream needs to know this type exists.
 */
export type PrismaAdapter = InstrumentationAdapter &
  PrismaAdapterClaims & {
    /** Always {@link PRISMA_ADAPTER_ID}. */
    readonly id: typeof PRISMA_ADAPTER_ID;
  };

// ---------------------------------------------------------------------------
// Derived vocabularies
//
// Everything below is computed from the authored tables rather than restated.
// `../schema/readiness.ts` owns the signal→key and signal→kind tables and
// `@debuggen/code-analysis` owns the driver and database-access vocabularies;
// duplicating a row of either here is how two files come to disagree about
// which signal produces which evidence.
// ---------------------------------------------------------------------------

/**
 * The telemetry kinds this adapter's signal is responsible for, read from
 * `../schema/readiness.ts`'s `CAPTURE_SIGNAL_TO_TELEMETRY_KIND` through
 * {@link telemetryKindsForSignal}.
 *
 * Used in the diagnostic fields this adapter logs, so a line about an armed or
 * missing signal names the evidence at stake without this file asserting what
 * that evidence is.
 */
const PRISMA_TELEMETRY_KINDS = telemetryKindsForSignal(PRISMA_SIGNAL);

/**
 * Every capture signal that produces the same evidence as this one — the
 * database signals, derived rather than listed.
 *
 * A plan that asks for database tracing is asking for query spans, and the two
 * driver signals are the same evidence seen through two libraries: the signal→
 * kind table maps both to one kind, and `deriveServerAgentSignals` deliberately
 * enables both for a `'db-query-tracking'` action because telling them apart
 * would mean knowing which adapter planned it. So an understanding that named
 * either one is an understanding that wants query spans, and the driver this
 * project actually uses is what {@link canHandlePrismaProject} already settled.
 *
 * Computing the set from the table keeps that reasoning true if a third driver
 * signal is ever added.
 */
const DATABASE_CAPTURE_SIGNALS: readonly CaptureSignal[] = CAPTURE_SIGNALS.filter((signal) =>
  telemetryKindsForSignal(signal).some((kind) => PRISMA_TELEMETRY_KINDS.includes(kind)),
);

/**
 * The database-access styles that include this adapter's driver.
 *
 * `ProjectSummary.databaseAccess.style` folds the graph's `db-call` drivers
 * into one value, so a project using both mechanisms reports `'both'` — and a
 * check for the driver's own style alone would miss exactly the ordinary shape
 * the summary documents (a client for most work, hand-written statements where
 * they are needed). `satisfies` pins both members to the real vocabulary.
 */
const PRISMA_ACCESS_STYLES = [
  PRISMA_ADAPTER_ID,
  'both',
] as const satisfies readonly DatabaseAccessStyle[];

/**
 * Widened view of {@link PRISMA_ACCESS_STYLES}, so a `DatabaseAccessStyle` can
 * be tested for membership without the test asserting anything about it.
 */
const PRISMA_ACCESS_STYLE_VALUES: readonly string[] = PRISMA_ACCESS_STYLES;

/**
 * The node kinds a question's seed may resolve to and still point at a query
 * owner.
 *
 * A seed is a name from the developer's question: it can resolve to the service
 * function that queries (`'server-function'`), to any other declaration that
 * does (`'symbol'`, and `'component'` for a server component that queries
 * directly), or to the call site itself (`'db-call'`). Narrowing the lookup
 * keeps a name that also belongs to a route module or an event handler from
 * dragging unrelated matches into the evidence set. `satisfies` pins every
 * member to `@debuggen/code-analysis`'s closed node vocabulary.
 */
const SEED_MATCH_KINDS = [
  'server-function',
  'symbol',
  'component',
  'db-call',
] as const satisfies readonly CodeNodeKind[];

/**
 * The owner kinds a `queries` edge may legally start at, in preference order.
 *
 * The edge table in `@debuggen/code-analysis` fixes a `queries` edge's origin
 * as `symbol | server-function`, and its extractor falls back to the `file`
 * node when a call site has no enclosing declaration at all. A file owner is
 * not a symbol an action can address — `CodeQueries.hasSymbol` rejects it,
 * because its name is a path — so it is skipped rather than proposed.
 * `'component'` is admitted for the same reason it appears in
 * {@link SEED_MATCH_KINDS}: a server component that queries directly is a
 * declaration `hasSymbol` affirms.
 */
const QUERY_OWNER_KINDS = [
  'server-function',
  'symbol',
  'component',
] as const satisfies readonly CodeNodeKind[];

/**
 * Widened view of {@link QUERY_OWNER_KINDS} for the membership test.
 */
const QUERY_OWNER_KIND_VALUES: readonly string[] = QUERY_OWNER_KINDS;

/**
 * The entity kinds that point at data-layer work directly.
 *
 * `'query'` is `../schema/target.ts`'s name for a data-layer operation, so an
 * understanding carrying one has named this adapter's subject even if its
 * `signalsNeeded` list did not — which is the second of the two ways
 * {@link createPrismaAdapter}'s planner decides to propose anything at all.
 */
const DATA_ENTITY_KINDS = ['query'] as const satisfies readonly ProblemEntityKind[];

/**
 * Widened view of {@link DATA_ENTITY_KINDS} for the membership test.
 */
const DATA_ENTITY_KIND_VALUES: readonly string[] = DATA_ENTITY_KINDS;

/**
 * The runtime hooks this adapter arms, as a developer reads them.
 *
 * One entry, because one instrumentation is enabled. The strings reach the
 * editor's "Preparing instrumentation" checklist and the DevTools session
 * summary through `instrumentation.ready`, so they are descriptions rather than
 * identifiers of anything machine-read — the machine-readable statement is
 * {@link InstallResult.serverSignals}.
 */
const PRISMA_RUNTIME_HOOKS: readonly string[] = Object.freeze([
  'Database tracing (Prisma query spans)',
]);

// ---------------------------------------------------------------------------
// Limits, defaults and injected options
//
// Every knob is injected and fully defaulted, and the defaults are exported so
// a suite asserts against the shipped values instead of restating them. None of
// them is read from the environment: this adapter learns about the machine it
// runs on from `InstrumentationContext` — the one input the adapter contract
// gives it — and from nowhere else.
// ---------------------------------------------------------------------------

/**
 * The bounds this adapter works within, and the values a caller gets when it
 * injects nothing.
 *
 * Frozen and exported so `./prisma.test.ts` asserts the shipped numbers rather
 * than duplicating them, and so a caller that wants a different cap states it
 * as an option instead of editing this file.
 */
export const PRISMA_ADAPTER_LIMITS = Object.freeze({
  /**
   * How many actions one proposal may contain, by default.
   *
   * Small on purpose, and the reason is architectural rather than economical:
   * the preload's mapper instrumentation is **process-wide**, so one action
   * arms every query in the dev server. The actions are *anchors* — the query
   * sites the graph found, named so a developer can see why the signal is on
   * and so the plan's targets point at real declarations — and one action per
   * call expression would be a plan that looked like a set of separate
   * instrumentation steps when it is one.
   */
  maxTargets: 3,

  /**
   * The highest `maxTargets` a caller may ask for.
   *
   * `../schema/plan.ts` caps a whole plan at 64 targets across every adapter,
   * so a single runtime-mode adapter asking for more than a small share of that
   * budget would crowd out the patch-mode actions a question actually needs.
   */
  maxTargetsCeiling: 16,

  /**
   * How long a connected preload may stay silent before its signal is reported
   * as degraded, in milliseconds.
   *
   * Thirty seconds: long enough that an idle dev server between heartbeats is
   * not mistaken for a dead one, short enough that a developer told to reproduce
   * their problem is not waiting on a process that stopped reporting a minute
   * ago.
   */
  heartbeatStalenessMs: 30_000,

  /**
   * How many owner candidates the reachability pass inspects, at most.
   *
   * The pass asks `CodeQueries.whoCalls` per candidate, which is a map lookup
   * per target, and then at most one bounded `CodeQueries.pathBetween` search
   * per evidence root — cheap each, but a project with hundreds of query owners
   * would turn a proposal into a scan. Candidates are ordered deterministically
   * *before* the cap applies, so the same project always yields the same
   * inspected set.
   */
  maxOwnersInspected: 64,

  /**
   * Longest `reason` or `hint` this adapter emits, in characters.
   *
   * Mirrors the bound `../schema/readiness.ts` applies to the same two fields,
   * so a message composed here is one a readiness row accepts rather than one
   * the boundary refuses.
   */
  maxMessageLength: 500,

  /**
   * Longest `rationale` this adapter emits, in characters.
   *
   * Mirrors `../schema/plan.ts`'s bound on the same field, for the same reason.
   */
  maxRationaleLength: 500,
});

/**
 * The wording defaults for the relaunch hint a missing preload is reported
 * with.
 *
 * Exported for the same reason {@link PRISMA_ADAPTER_LIMITS} is, and split from
 * it because these are *words and specifiers* rather than bounds. Both are
 * overridable through {@link PrismaAdapterOptions.relaunch}, which is how the
 * service supplies the exact command it would run without this adapter reading
 * the environment or naming a script path in this repository.
 */
export const PRISMA_RELAUNCH_DEFAULTS = Object.freeze({
  /**
   * The documented preload entry point, as a module specifier.
   *
   * The published `./node/register` condition of `@debuggen/telemetry`, which
   * is what `--import` loads into the dev-server process. A specifier rather
   * than a path: a path would be correct only for the checkout it was written
   * in, and this string is shown to a developer to paste.
   */
  preloadSpecifier: '@debuggen/telemetry/node/register',

  /**
   * The script name a project's dev server is conventionally started by.
   *
   * Used only as the last resort before the editor-command wording, and only
   * together with the package manager `ProjectSummary` reports — the summary
   * carries no script list, so this is a convention rather than a fact about
   * the target, and an injected descriptor always wins over it.
   */
  devScript: 'dev',
});

/**
 * An exact relaunch instruction, supplied by the caller.
 *
 * The service knows precisely how it would start the target's dev server — it
 * owns the launcher — so it can hand the developer the command it would run
 * rather than leaving this adapter to compose one from a convention. Injected
 * as data for the same reason the clock is: a hint assembled from an
 * environment read could not be asserted, and a hint naming a path inside this
 * repository would be right only for the checkout it came from.
 */
export interface PrismaRelaunchDescriptor {
  /**
   * The command line to run, as a single copy-pasteable line.
   *
   * Emitted verbatim apart from whitespace normalisation and the length bound
   * of {@link PRISMA_ADAPTER_LIMITS.maxMessageLength}, both of which exist so
   * that a readiness row built from these words passes the schema that
   * transports it.
   */
  readonly command: string;

  /**
   * At most one clause of context, placed before the command.
   *
   * Optional, and omitted rather than empty: the command is the actionable
   * part, and a hint that spent its length on explanation would bury it.
   */
  readonly note?: string | undefined;
}

/**
 * The injected, fully-defaulted knobs {@link createPrismaAdapter} accepts.
 *
 * Every member is optional, and an adapter constructed with no options behaves
 * exactly as the shipped product does — {@link PRISMA_ADAPTER_LIMITS} and
 * {@link PRISMA_RELAUNCH_DEFAULTS} are those values.
 */
export interface PrismaAdapterOptions {
  /**
   * How many anchor actions one proposal may contain.
   *
   * Clamped into `[1, PRISMA_ADAPTER_LIMITS.maxTargetsCeiling]`; a
   * non-finite or non-integer value falls back to the default rather than
   * refusing, because a plan is worth proposing even when a caller passed
   * nonsense.
   */
  readonly maxTargets?: number | undefined;

  /**
   * How long a connected preload may stay silent before its signal is degraded,
   * in milliseconds.
   *
   * Clamped to a positive number; see
   * {@link PRISMA_ADAPTER_LIMITS.heartbeatStalenessMs} for the default and the
   * reasoning behind it.
   */
  readonly heartbeatStalenessMs?: number | undefined;

  /**
   * The clock, in epoch milliseconds.
   *
   * Used only to age a heartbeat and to stamp a readiness report.
   * {@link InstrumentationContext.now} is preferred when the context carries
   * one — it is the session's clock — and this option is the seam for a caller
   * that constructs the adapter without a session.
   */
  readonly now?: (() => number) | undefined;

  /**
   * Where to log, overriding {@link InstrumentationContext.logger}.
   *
   * Present so a caller can capture this adapter's diagnostic lines without a
   * session; the context's logger is used when it is absent. Either way the
   * lines are bound with this adapter's id and carry paths, counts and signal
   * names only — never a statement, an argument object or a connection
   * string.
   */
  readonly logger?: Logger | undefined;

  /**
   * The exact relaunch instruction to put in front of the developer when the
   * preload is missing. See {@link PrismaRelaunchDescriptor}.
   */
  readonly relaunch?: PrismaRelaunchDescriptor | undefined;
}

/** {@link PrismaAdapterOptions} with every default resolved. */
interface ResolvedPrismaAdapterOptions {
  readonly maxTargets: number;
  readonly heartbeatStalenessMs: number;
  readonly now?: (() => number) | undefined;
  readonly logger?: Logger | undefined;
  readonly relaunch?: PrismaRelaunchDescriptor | undefined;
}

/**
 * Resolves the caller's options against the shipped defaults.
 *
 * Total over values rather than over types: a caller that passes a negative
 * cap, a fraction or a non-finite number gets the default, because a proposal
 * is worth making even when one knob arrived malformed, and refusing here would
 * turn a caller's mistake into a session that collects no database evidence.
 *
 * @param options What the caller supplied, if anything.
 * @returns Every knob with a usable value.
 */
function resolveOptions(options: PrismaAdapterOptions | undefined): ResolvedPrismaAdapterOptions {
  return {
    maxTargets: clampCount(
      options?.maxTargets,
      PRISMA_ADAPTER_LIMITS.maxTargets,
      PRISMA_ADAPTER_LIMITS.maxTargetsCeiling,
    ),
    heartbeatStalenessMs: clampCount(
      options?.heartbeatStalenessMs,
      PRISMA_ADAPTER_LIMITS.heartbeatStalenessMs,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.logger === undefined ? {} : { logger: options.logger }),
    ...(options?.relaunch === undefined ? {} : { relaunch: options.relaunch }),
  };
}

/**
 * Brings a caller-supplied count into `[1, ceiling]`, falling back to a
 * default.
 *
 * @param value The caller's value, or `undefined`.
 * @param fallback The value to use when the caller supplied nothing usable.
 * @param ceiling The highest accepted value.
 * @returns A whole number in range.
 */
function clampCount(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  const whole = Math.floor(value);

  if (whole < 1) {
    return fallback;
  }

  return Math.min(whole, ceiling);
}

/**
 * Orders two strings by code unit, without a locale.
 *
 * `localeCompare` is deliberately avoided, for the reason
 * `../schema/readiness.ts` avoids it in its own comparator: its result depends
 * on the host's locale data, so the same project would produce differently
 * ordered proposals on two machines and a test asserting an order would pass or
 * fail by environment.
 *
 * @param left First string.
 * @param right Second string.
 * @returns A negative number, zero, or a positive number, as `Array#sort`
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

/** Highest code point of the C0 control block. */
const C0_CONTROL_MAX = 0x1f;

/** Lowest code point of the DEL/C1 control block. */
const C1_CONTROL_MIN = 0x7f;

/** Highest code point of the C1 control block. */
const C1_CONTROL_MAX = 0x9f;

/**
 * Makes a composed message safe for the row that will carry it: one line, no
 * control characters, bounded length.
 *
 * Every string this adapter emits as a `reason`, a `hint` or a `rationale`
 * passes through here, including an injected relaunch command — which is
 * ordinary caller data and may contain a line break or run long. The schemas
 * that transport these fields refuse a blank, multi-line or over-long value
 * (`../schema/readiness.ts`, `../schema/plan.ts`), and refusing at *that*
 * boundary would discard a whole readiness report over wording, so the shape is
 * fixed here where the words are chosen.
 *
 * Truncation appends a single ellipsis, so a clipped message never reads as a
 * complete one.
 *
 * @param value The composed message.
 * @param maxLength The bound to fit inside.
 * @returns A single-line message of at most `maxLength` characters.
 */
function clampMessage(value: string, maxLength: number): string {
  let collapsed = '';
  let pendingSpace = false;

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isSpace =
      character === ' ' ||
      code <= C0_CONTROL_MAX ||
      (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX);

    if (isSpace) {
      pendingSpace = collapsed.length > 0;
      continue;
    }

    if (pendingSpace) {
      collapsed += ' ';
      pendingSpace = false;
    }

    collapsed += character;
  }

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, Math.max(maxLength - 1, 1))}…`;
}

/**
 * The logger this adapter writes to, bound with its id.
 *
 * An injected logger wins over the session's, which is what lets a caller
 * capture these lines with no session; otherwise the context's logger is used,
 * as `../adapter.ts` intends. `child` rather than a formatted prefix, so the
 * adapter id arrives as a field a log query can filter on.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns A logger bound to this adapter.
 */
function loggerFor(context: InstrumentationContext, options: ResolvedPrismaAdapterOptions): Logger {
  return (options.logger ?? context.logger).child({ adapter: PRISMA_ADAPTER_ID });
}

/**
 * The current epoch-millisecond time, from the most specific clock available.
 *
 * The session's clock first — a report has to agree with the rest of the
 * session's timestamps — then the adapter's injected clock, then the shared
 * default. `Date.now()` is never called directly, which is what makes an aged
 * heartbeat assertable.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns Epoch milliseconds.
 */
function currentTime(
  context: InstrumentationContext,
  options: ResolvedPrismaAdapterOptions,
): number {
  const clock = context.now ?? options.now;

  return clock === undefined ? nowEpochMs() : clock();
}

/**
 * The clock to hand to `buildReadiness`, when there is one to hand over.
 *
 * `BuildReadinessInput.now` is declared without `| undefined`, so under
 * `exactOptionalPropertyTypes` the key has to be *spread* rather than assigned
 * — the form `../adapter.ts`'s example documents.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns An object to spread into the readiness input.
 */
function readinessClock(
  context: InstrumentationContext,
  options: ResolvedPrismaAdapterOptions,
): { now?: () => number } {
  const clock = context.now ?? options.now;

  return clock === undefined ? {} : { now: clock };
}

// ---------------------------------------------------------------------------
// Detection — the graph, and only the graph
//
// Two questions, both answered from indexed facts: *does this project query
// through the mapper* (the capability probe) and *which declarations do the
// querying* (the planner's candidates). Neither consults the filesystem, a
// manifest, an import specifier or a name.
// ---------------------------------------------------------------------------

/**
 * Every `db-call` node this adapter's driver produced, in the graph's canonical
 * order.
 *
 * `nodesByKind` is a pre-built bucket rather than a scan, and `data.driver` is
 * the classification the indexer's own pass recorded, so this is the cheapest
 * and the only honest form of the question.
 *
 * @param graph The project's code graph.
 * @returns The matching call sites; empty when the project does not use the
 * mapper.
 */
function prismaCallSites(graph: CodeGraph): readonly CodeNodeOf<'db-call'>[] {
  return graph.nodesByKind('db-call').filter((node) => node.data.driver === PRISMA_DRIVER);
}

/**
 * Whether the project summary's database-access style includes this adapter's
 * driver.
 *
 * The corroborating half of the capability probe. It is derived from the same
 * `db-call` nodes by `summarizeProject`, so it cannot contradict
 * {@link prismaCallSites} — it is read as well because it is the project-level
 * record of how the project reaches its database, and because a summary
 * produced by a newer indexer that learned to classify a call this graph
 * revision does not should still let the adapter claim the project.
 *
 * @param summary The project summary.
 * @returns `true` when the style names the mapper.
 */
function summaryReportsPrisma(summary: ProjectSummary): boolean {
  return PRISMA_ACCESS_STYLE_VALUES.includes(summary.databaseAccess.style);
}

/**
 * The capability probe behind {@link InstrumentationAdapter.canHandle},
 * separated so both the probe and the planner state the question once.
 *
 * True when at least one call site carries the driver **or** the summary
 * reports a style that includes it; false otherwise — including for a project
 * that reaches its database only through the driver library, which is the case
 * that keeps the dual claim on `'db-query-tracking'` honest.
 *
 * This is a question about *capability*, never about readiness: a project whose
 * graph contains mapper call sites is a project this adapter claims, whether or
 * not a dev-server preload is attached today. That gap is
 * {@link InstrumentationAdapter.readiness}'s to report.
 *
 * @param context The session's context.
 * @returns `true` when this adapter has something to offer this project.
 */
function canHandlePrismaProject(context: InstrumentationContext): boolean {
  return prismaCallSites(context.graph).length > 0 || summaryReportsPrisma(context.projectSummary);
}

/**
 * The declaration a query call site belongs to — the node a `queries` edge
 * starts at.
 *
 * `../adapter.ts`'s contract requires a plan target to be a `(file, symbol)`
 * pair the graph declares, and a `db-call` node is an *expression*: its name is
 * the callee, which is not a symbol anything can address. The owner is
 * therefore resolved through the edge the indexer recorded for exactly this
 * purpose, whose origin is the enclosing `server-function` (or, where the
 * cascade found no service function, the enclosing `symbol` or `component`).
 */
interface PrismaQueryOwner {
  /** The owner's file: project-relative, POSIX separators. */
  readonly file: string;

  /** The owner's declared symbol name. */
  readonly symbol: string;

  /** The 1-based line the declaration starts on. */
  readonly line: number;

  /** Whether the owner is a `server-function` node — the service-layer case. */
  readonly serviceFunction: boolean;

  /**
   * The owner's opaque graph node id, when it was resolved through a `queries`
   * edge.
   *
   * The target endpoint of the reachability search. Absent for an owner taken
   * from a call site's own `symbol` field, which names a declaration without
   * pointing at its node; that search then describes the owner by file and
   * symbol instead.
   */
  readonly nodeId?: string | undefined;
}

/**
 * Resolves one call site's owner.
 *
 * The `queries` edge is preferred because it is the relationship the graph
 * asserts. A `server-function` origin wins over any other admissible kind, so a
 * call site recorded against both the service function and another declaration
 * is attributed to the function a developer would look for.
 *
 * The fallback is the call site's own `symbol` field, which the extractor sets
 * to the same owner's name and omits when the cascade fell through to the
 * module. It exists so a graph whose edge was dropped — an endpoint no
 * extractor emitted, which graph assembly reports as a dangling edge rather
 * than inventing — still yields a proposal instead of silently losing the
 * project's database work.
 *
 * @param graph The project's code graph.
 * @param call The call site.
 * @returns The owner, or `undefined` when the call site belongs to no
 * addressable declaration.
 */
function ownerOfCall(graph: CodeGraph, call: CodeNodeOf<'db-call'>): PrismaQueryOwner | undefined {
  let fallback: PrismaQueryOwner | undefined;

  for (const edge of graph.incoming(call.id, 'queries')) {
    const owner = graph.nodeById(edge.from);

    if (owner === undefined || !QUERY_OWNER_KIND_VALUES.includes(owner.kind)) {
      continue;
    }

    const resolved: PrismaQueryOwner = {
      file: owner.file,
      symbol: owner.name,
      line: owner.line,
      serviceFunction: owner.kind === 'server-function',
      nodeId: owner.id,
    };

    if (resolved.serviceFunction) {
      return resolved;
    }

    fallback ??= resolved;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  if (call.symbol === undefined) {
    return undefined;
  }

  return { file: call.file, symbol: call.symbol, line: call.line, serviceFunction: false };
}

/**
 * The query work of one declaration: the owner, its call sites, and the
 * operations the graph recorded for them.
 *
 * Grouping by owner is what makes a proposal speak in terms of *the functions
 * that query the database* rather than of raw call expressions — which is both
 * what a developer reads in the plan and what the feasibility gate can check,
 * since an owner is a declaration and a call expression is not.
 */
interface PrismaOwnerGroup {
  /** The declaration the calls belong to. */
  readonly owner: PrismaQueryOwner;

  /** How many of this adapter's call sites the declaration contains. */
  readonly callSites: number;

  /** The ids of those call sites, for the seed-evidence test. */
  readonly callSiteIds: ReadonlySet<string>;

  /**
   * The distinct operation names the graph recorded, sorted and bounded.
   *
   * Recorded by the indexer per call site where it could determine one. Safe to
   * carry into a rationale — it is a name from the developer's own schema, at
   * the level `DbCallNodeData` is bounded to, and never a statement, an argument
   * object or anything describing a row.
   */
  readonly operations: readonly string[];
}

/** How many operation names a rationale may name. */
const MAX_NAMED_OPERATIONS = 3;

/**
 * Groups this adapter's call sites by the declaration that owns them.
 *
 * Keyed on `file` and `symbol` — the pair an action addresses — so a service
 * function reached through both an edge and the fallback collapses into one
 * group, and the lowest line wins, which is the declaration's own position.
 *
 * @param graph The project's code graph.
 * @param calls This adapter's call sites.
 * @returns One group per owning declaration, in insertion order; the caller
 * orders them.
 */
function groupByOwner(
  graph: CodeGraph,
  calls: readonly CodeNodeOf<'db-call'>[],
): readonly PrismaOwnerGroup[] {
  const groups = new Map<
    string,
    { owner: PrismaQueryOwner; ids: Set<string>; operations: Set<string> }
  >();

  for (const call of calls) {
    const owner = ownerOfCall(graph, call);

    if (owner === undefined) {
      continue;
    }

    const key = `${owner.file}\u0000${owner.symbol}`;
    const existing = groups.get(key);
    const operation = call.data.operation;

    if (existing === undefined) {
      groups.set(key, {
        owner,
        ids: new Set([call.id]),
        operations: new Set(operation === undefined ? [] : [operation]),
      });

      continue;
    }

    existing.ids.add(call.id);

    if (operation !== undefined) {
      existing.operations.add(operation);
    }

    // A service function is the owner a developer looks for, so it wins
    // outright; between two owners of the same standing the earlier
    // declaration wins, which is the position of the declaration itself rather
    // than of a later call site inside it.
    const preferred =
      (owner.serviceFunction && !existing.owner.serviceFunction) ||
      (owner.serviceFunction === existing.owner.serviceFunction &&
        owner.line < existing.owner.line);

    if (preferred) {
      existing.owner = owner;
    }
  }

  return [...groups.values()].map((group) => ({
    owner: group.owner,
    callSites: group.ids.size,
    callSiteIds: group.ids,
    operations: [...group.operations].sort(compareText).slice(0, MAX_NAMED_OPERATIONS),
  }));
}

// ---------------------------------------------------------------------------
// Evidence — how the question narrows the candidates
//
// Three tiers, strongest first, and every one of them is a *graph resolution*
// of a name the understanding supplied. A candidate is never selected because
// its name resembled the question; it is selected because a query the code
// graph executed returned the declaration it belongs to.
// ---------------------------------------------------------------------------

/**
 * How directly the question points at a candidate. Lower sorts first.
 *
 * - `0` — a seed resolved **to this declaration or to one of its call sites**:
 *   the developer named the querying code.
 * - `1` — a seed resolved to *something else in the same file*: the developer
 *   named the module, which is weaker but still their own evidence.
 * - `2` — the declaration is **reachable** from what the question points at:
 *   it is called from a file the question names, or a bounded downstream
 *   `pathBetween` search from a node the question resolved to — the route the
 *   URL matched, the component it named — arrives at it. Within this tier the
 *   shorter path ranks first.
 * - `3` — no evidence narrowed it. Reached when the understanding asked for
 *   database evidence without naming anything, which is an ordinary question
 *   ("why is this slow?" with an element selected) and must still produce
 *   anchors.
 */
type EvidenceTier = 0 | 1 | 2 | 3;

/** The tier assigned when nothing in the understanding narrowed a candidate. */
const UNNARROWED_TIER: EvidenceTier = 3;

/** The tier a candidate earns by being reachable from what the question names. */
const REACHABLE_TIER: EvidenceTier = 2;

/**
 * The distance recorded for a candidate a direct caller in an evidence file
 * reaches: one call hop, which no downstream search can beat without the
 * candidate being the evidence itself (tier `0`).
 */
const DIRECT_CALLER_DISTANCE = 1;

/**
 * How many evidence roots the reachability search starts from, at most.
 *
 * Together with {@link PRISMA_ADAPTER_LIMITS.maxOwnersInspected} this bounds
 * the searches one proposal runs — at most `8 × 64`, each itself bounded by the
 * query surface's own depth and node budgets — so a question naming many
 * things costs a bounded wait. Eight covers every entity and hint a validated
 * understanding carries in practice; roots are kept in the order the
 * understanding named them, so the same question always searches from the same
 * roots.
 */
const MAX_REACHABILITY_ROOTS = 8;

/**
 * What the understanding's names resolved to in the graph.
 *
 * Built once per proposal and consulted per candidate, so a project with many
 * query owners costs one resolution pass rather than one per candidate.
 */
interface SeedEvidence {
  /** `file\u0000symbol` keys of declarations a seed resolved to. */
  readonly declarations: ReadonlySet<string>;

  /** Node ids a seed resolved to, including call sites. */
  readonly nodeIds: ReadonlySet<string>;

  /** Files a seed resolved into, or that an entity named outright. */
  readonly files: ReadonlySet<string>;

  /**
   * The node ids a downstream reachability search starts from: the route node
   * a URL entity matched and every non-call-site node a seed resolved to, in
   * the order the understanding named them, at most
   * {@link MAX_REACHABILITY_ROOTS}.
   *
   * A call site is never a root: it is an expression with no downstream, and
   * one that belongs to this adapter's driver already put its owner in tier
   * `0`.
   */
  readonly roots: readonly string[];

  /** Whether the understanding named anything at all that the graph resolved. */
  readonly resolved: boolean;
}

/**
 * Resolves the understanding's entities and search hints against the graph.
 *
 * `findByName` is the executor: the understanding proposes names, this code
 * runs the bounded, ranked lookup that turns them into declarations. Route and
 * URL entities additionally go through `routeForUrl`, because a request path is
 * not a declaration name and the route map is the only thing that can match one
 * — and the file it yields is what the reachability tier is measured against,
 * while the route's own graph node is where its downstream search starts.
 *
 * An entity's own `file`, where the producer supplied one, is admitted
 * directly: it is already a project-relative path, and it is the one seed that
 * needs no resolution.
 *
 * @param queries The bounded query surface.
 * @param understanding The validated Stage 1 artifact.
 * @returns What resolved, and whether anything did.
 */
function resolveSeedEvidence(
  queries: CodeQueries,
  understanding: ProblemUnderstanding,
): SeedEvidence {
  const declarations = new Set<string>();
  const nodeIds = new Set<string>();
  const files = new Set<string>();
  const roots = new Set<string>();
  const seeds: string[] = [];

  for (const entity of understanding.entities) {
    seeds.push(entity.name);

    if (entity.file !== undefined) {
      files.add(entity.file);
    }

    if (entity.kind === 'route' || entity.kind === 'url') {
      const route = queries.routeForUrl(entity.name);

      if (route !== undefined) {
        files.add(route.file);

        if (route.node !== undefined) {
          roots.add(route.node.nodeId);
        }
      }
    }
  }

  seeds.push(...understanding.searchHints);

  for (const seed of seeds) {
    for (const match of queries.findByName(seed, {
      kinds: SEED_MATCH_KINDS,
      limit: queries.limits.maxResults,
    })) {
      admitMatch(match, declarations, nodeIds, files);

      if (match.kind !== 'db-call') {
        roots.add(match.nodeId);
      }
    }
  }

  return {
    declarations,
    nodeIds,
    files,
    roots: [...roots].slice(0, MAX_REACHABILITY_ROOTS),
    resolved: declarations.size > 0 || nodeIds.size > 0 || files.size > 0 || roots.size > 0,
  };
}

/**
 * Records one resolved match in the evidence sets.
 *
 * A match contributes its node id (which is how a `db-call` match is recognised
 * later), its `(file, symbol)` key where the match *is* a declaration, and its
 * file. A `db-call` match contributes no declaration key: its name is a callee,
 * and treating it as a symbol would put an expression where a plan target
 * belongs.
 *
 * @param match The resolved match.
 * @param declarations Declaration keys accumulated so far.
 * @param nodeIds Node ids accumulated so far.
 * @param files Files accumulated so far.
 */
function admitMatch(
  match: CodeMatch,
  declarations: Set<string>,
  nodeIds: Set<string>,
  files: Set<string>,
): void {
  nodeIds.add(match.nodeId);
  files.add(match.file);

  if (match.kind !== 'db-call') {
    declarations.add(`${match.file}\u0000${match.name}`);
  }
}

/**
 * The tier a candidate earns from the resolved evidence, before the
 * reachability pass.
 *
 * @param group The candidate.
 * @param evidence What the understanding's names resolved to.
 * @returns `0`, `1`, or `UNNARROWED_TIER` when neither applies.
 */
function directTierOf(group: PrismaOwnerGroup, evidence: SeedEvidence): EvidenceTier {
  const key = `${group.owner.file}\u0000${group.owner.symbol}`;

  if (evidence.declarations.has(key)) {
    return 0;
  }

  for (const id of group.callSiteIds) {
    if (evidence.nodeIds.has(id)) {
      return 0;
    }
  }

  return evidence.files.has(group.owner.file) ? 1 : UNNARROWED_TIER;
}

/**
 * How many hops separate a candidate from what the question points at, or
 * `undefined` when it is not reachable within the bounds.
 *
 * The third tier, and the one that connects a question about a route or a
 * component to the service function that does the querying. Two routes,
 * cheapest first, and the shorter answer wins:
 *
 * 1. **A caller in an evidence file.** `whoCalls` reads the `calls` and
 *    `references` edges an extractor already recorded, so a route handler that
 *    delegates to this declaration is one map lookup away, at
 *    {@link DIRECT_CALLER_DISTANCE}.
 * 2. **A downstream path from an evidence root.** `pathBetween` from the route
 *    node a URL matched, or from a node a name resolved to, in the query
 *    surface's default direction — downstream, so every hop points the way a
 *    request flows — and within its own depth and node budgets. This is what
 *    reaches the service function two or three calls below a route handler,
 *    which a one-hop caller check cannot see. The path's `depth` is the
 *    distance.
 *
 * Only consulted when the stronger tiers found nothing for any candidate. The
 * root loop stops as soon as a path of {@link DIRECT_CALLER_DISTANCE} is found,
 * because no root can place the candidate closer without it being the evidence
 * itself.
 *
 * @param queries The bounded query surface.
 * @param group The candidate.
 * @param evidence What the understanding's names resolved to.
 * @returns The shortest distance found, or `undefined` when neither route
 * reaches the candidate.
 */
function reachDistanceFromEvidence(
  queries: CodeQueries,
  group: PrismaOwnerGroup,
  evidence: SeedEvidence,
): number | undefined {
  if (evidence.files.size > 0) {
    for (const caller of queries.whoCalls({
      file: group.owner.file,
      symbol: group.owner.symbol,
    })) {
      if (evidence.files.has(caller.caller.file)) {
        return DIRECT_CALLER_DISTANCE;
      }
    }
  }

  // The owner's own node when the `queries` edge named it; otherwise a
  // selector for the declaration, which is what an owner taken from a call
  // site's `symbol` field can offer.
  const target: CodePathEndpoint = group.owner.nodeId ?? {
    file: group.owner.file,
    symbol: group.owner.symbol,
  };
  let shortest: number | undefined;

  for (const root of evidence.roots) {
    const path = queries.pathBetween(root, target);

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

/** A candidate with the tier it earned. */
interface RankedCandidate {
  /** The candidate. */
  readonly group: PrismaOwnerGroup;

  /** How directly the question points at it. */
  readonly tier: EvidenceTier;

  /**
   * How many hops the reachability pass measured from the evidence, for a
   * {@link REACHABLE_TIER} candidate; `0` for every other tier, where no
   * distance was measured and the order falls through to the file.
   */
  readonly distance: number;
}

/**
 * Orders two ranked candidates deterministically.
 *
 * Evidence tier, then reachability distance (the shorter path first, which
 * only differs inside the reachable tier), then project-relative file path,
 * then declaration line, then symbol — and that order is total for this
 * candidate set, because a group is keyed on `(file, symbol)` and two distinct
 * groups therefore differ in the file, the symbol, or both. The result is
 * identical across runs and across machines, which is what makes a proposal
 * reproducible apart from its fresh action ids.
 *
 * @param left First candidate.
 * @param right Second candidate.
 * @returns A negative number, zero, or a positive number, as `Array#sort`
 * expects.
 */
function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  if (left.tier !== right.tier) {
    return left.tier - right.tier;
  }

  if (left.distance !== right.distance) {
    return left.distance - right.distance;
  }

  const byFile = compareText(left.group.owner.file, right.group.owner.file);

  if (byFile !== 0) {
    return byFile;
  }

  if (left.group.owner.line !== right.group.owner.line) {
    return left.group.owner.line - right.group.owner.line;
  }

  return compareText(left.group.owner.symbol, right.group.owner.symbol);
}

// ---------------------------------------------------------------------------
// The preload, as the service observed it
//
// The only source of readiness for this adapter's signal. No probe, no poll, no
// port check, no environment read: the service holds the `server-agent`
// connection and puts what it knows on the context, and an adapter that went
// looking for its own evidence could contradict it and tell a developer a
// signal is ready when the frames the product needs are not arriving.
// ---------------------------------------------------------------------------

/**
 * Why no usable preload was observed for this project.
 *
 * This adapter's own diagnostic vocabulary, so it is a union rather than a
 * tuple with a derived type: nothing iterates it, nothing validates a value
 * against it and it crosses no boundary — it reaches a `debug` field and
 * nowhere else. The three cases are distinguished because they are worth
 * distinguishing in a log, not because they are worth three messages:
 *
 * - `'not-reported'` — no preload has ever announced itself, which is the
 *   normal state of a dev server the developer started themselves.
 * - `'disconnected'` — one did, and its connection has since gone: a dev server
 *   restarted without the preload looks exactly like this.
 * - `'other-project'` — one is attached, to a different project root. A preload
 *   serving a sibling workspace package will never produce this project's
 *   spans, so it is no preload at all here.
 */
type PreloadAbsence = 'not-reported' | 'disconnected' | 'other-project';

/**
 * What the observed readiness inputs say about the dev-server preload for this
 * project.
 *
 * Three states, because they call for three different things to be said to a
 * developer. The absence variants are collapsed into one *report* — a preload
 * attached to a sibling package is no preload for this project, exactly as a
 * missing one is — while the reason is kept as a field so a log line can tell
 * them apart.
 */
type PreloadState =
  | { readonly kind: 'absent'; readonly absence: PreloadAbsence }
  | { readonly kind: 'ready'; readonly silentForMs?: number | undefined }
  | { readonly kind: 'stale'; readonly silentForMs: number };

/**
 * Classifies the observed preload.
 *
 * An absent heartbeat is deliberately **not** staleness: `ObservedServerAgent`
 * distinguishes a connection that has not spoken yet from one that has gone
 * quiet, and reporting the first as degraded would greet every freshly launched
 * dev server with a warning about itself.
 *
 * The project root is compared in normalised POSIX form. Both values are
 * absolute POSIX by contract, and normalising costs nothing next to the failure
 * it prevents: a trailing separator on one side would otherwise read as "no
 * preload for this project" and turn an armed signal into a relaunch hint the
 * developer has already followed.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @param at The current epoch-millisecond time.
 * @returns The state of the preload for this project.
 */
function observePreload(
  context: InstrumentationContext,
  options: ResolvedPrismaAdapterOptions,
  at: number,
): PreloadState {
  const agent = context.readiness.serverAgent;

  if (agent === undefined) {
    return { kind: 'absent', absence: 'not-reported' };
  }

  if (normalizePosix(toPosix(agent.projectRoot)) !== normalizePosix(toPosix(context.projectRoot))) {
    return { kind: 'absent', absence: 'other-project' };
  }

  if (!agent.connected) {
    return { kind: 'absent', absence: 'disconnected' };
  }

  const lastHeartbeatAt = agent.lastHeartbeatAt;

  if (lastHeartbeatAt === undefined) {
    return { kind: 'ready' };
  }

  const silentForMs = Math.max(at - lastHeartbeatAt, 0);

  if (silentForMs > options.heartbeatStalenessMs) {
    return { kind: 'stale', silentForMs };
  }

  return { kind: 'ready', silentForMs };
}

/**
 * One signal gap, as the reason and hint pair put in front of a developer.
 *
 * The same pair serves {@link InstallResult.unavailable} and the non-available
 * readiness row, because they are read in the same sentence: a readiness row
 * that stayed silent about its recovery action would make the failure honest
 * and useless.
 */
interface SignalGap {
  /** How ready the signal is, given the gap. Never `'available'`. */
  readonly status: Exclude<ReadinessStatus, 'available'>;

  /** What was observed, as a fragment reading after "Could not enable ‹signal›: ". */
  readonly reason: string;

  /** The one thing the developer can do about it. */
  readonly hint: string;
}

/** Milliseconds in one second, for the ages a message reports. */
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * Describes the gap a preload state implies, or `undefined` when there is none.
 *
 * @param state The observed preload state.
 * @param context The session's context.
 * @param options The resolved options.
 * @returns The gap to report, or `undefined` when the signal will be collected.
 */
function describeGap(
  state: PreloadState,
  context: InstrumentationContext,
  options: ResolvedPrismaAdapterOptions,
): SignalGap | undefined {
  if (state.kind === 'ready') {
    return undefined;
  }

  if (state.kind === 'stale') {
    const seconds = Math.round(state.silentForMs / MILLISECONDS_PER_SECOND);

    return {
      status: 'degraded',
      reason: clampMessage(
        `the dev-server preload for ${context.projectRoot} last reported ${String(seconds)}s ago, so Prisma query spans may already have stopped arriving`,
        PRISMA_ADAPTER_LIMITS.maxMessageLength,
      ),
      hint: clampMessage(
        `Restart the dev server for ${context.projectRoot} from the Debug Generator view in VS Code to reattach the preload.`,
        PRISMA_ADAPTER_LIMITS.maxMessageLength,
      ),
    };
  }

  return {
    status: 'unavailable',
    reason: clampMessage(
      `the dev server for ${context.projectRoot} is not running with the Debug Generator Node preload, so Prisma query spans cannot be produced`,
      PRISMA_ADAPTER_LIMITS.maxMessageLength,
    ),
    hint: relaunchHint(context, options),
  };
}

/**
 * Composes the relaunch instruction, the most exact form available first.
 *
 * 1. **An injected descriptor.** The service owns the dev-server launcher, so
 *    when it supplies the command it would run, that command is the truth and
 *    this adapter does not second-guess it.
 * 2. **The documented preload specifier plus the target's own package
 *    manager**, which `ProjectSummary` reports as data. The summary carries no
 *    script list, so the conventional dev script name of
 *    {@link PRISMA_RELAUNCH_DEFAULTS} completes the line — a convention, stated
 *    as one, and overridable by (1).
 * 3. **The editor command**, for a target whose package manager could not be
 *    determined: there is no command line to hand over, and the one-click
 *    alternative is what remains.
 *
 * Whatever the route, the hint **names the project it is about**: a relaunch
 * command for another project is worse than none, so the project root is
 * appended when the composed line does not already carry it. The command sits
 * last on the line so it ends where a developer's selection naturally does.
 *
 * Nothing here reads the environment, and no path inside this repository is
 * named — the preload is identified by its published module specifier, which is
 * what `--import` resolves.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns A single-line, bounded hint.
 */
function relaunchHint(
  context: InstrumentationContext,
  options: ResolvedPrismaAdapterOptions,
): string {
  const root = context.projectRoot;
  const packageManager = context.projectSummary.packageManager;
  const injected = options.relaunch;

  let composed: string;

  if (injected !== undefined) {
    composed =
      injected.note === undefined ? injected.command : `${injected.note}: ${injected.command}`;
  } else if (packageManager === 'unknown') {
    composed = `Start the dev server for ${root} from the Debug Generator view in VS Code, which attaches the Node preload for you.`;
  } else {
    composed = `Relaunch the dev server with the preload attached: cd ${root} && NODE_OPTIONS="--import ${PRISMA_RELAUNCH_DEFAULTS.preloadSpecifier}" ${packageManager} run ${PRISMA_RELAUNCH_DEFAULTS.devScript}`;
  }

  const addressed = composed.includes(root) ? composed : `${composed} (project: ${root})`;

  return clampMessage(addressed, PRISMA_ADAPTER_LIMITS.maxMessageLength);
}

/**
 * Turns a gap into the {@link UnavailableSignal} an install result carries.
 *
 * @param gap The described gap.
 * @returns The report, naming this adapter's capture signal.
 */
function toUnavailableSignal(gap: SignalGap): UnavailableSignal {
  return { signal: PRISMA_SIGNAL, reason: gap.reason, hint: gap.hint };
}

/**
 * Turns a gap, or its absence, into the readiness row for this adapter's
 * signal.
 *
 * `reason` and `hint` are **omitted** rather than set to `undefined` on an
 * available row: the report is transported and persisted as JSON, where an
 * absent key is the one representation every layer agrees on.
 *
 * @param gap The described gap, or `undefined` when the signal is available.
 * @returns One readiness row.
 */
function toReadinessSignal(gap: SignalGap | undefined): ReadinessSignal {
  if (gap === undefined) {
    return { signal: PRISMA_SIGNAL, status: 'available' };
  }

  return { signal: PRISMA_SIGNAL, status: gap.status, reason: gap.reason, hint: gap.hint };
}

// ---------------------------------------------------------------------------
// The five answers
//
// One function per method of the contract, so the factory below reads as the
// object it returns and each answer is documented where it is computed.
// ---------------------------------------------------------------------------

/**
 * The action types this adapter accepts in an install, derived from its claims.
 *
 * An action of any other type belongs to another adapter and is ignored
 * silently: the installer already routes by adapter id, and a second filter
 * here is what keeps a mis-routed action from being counted as armed.
 */
const CLAIMED_ACTION_TYPES: ReadonlySet<InstrumentationActionType> = new Set(
  PRISMA_ADAPTER_CLAIMS.map((claim) => claim.type),
);

/**
 * Whether the session's cancellation signal has fired.
 *
 * A function rather than an inline `context.signal?.aborted` test, and not for
 * brevity: `aborted` is a property on a borrowed object, so a second inline
 * test after a first one is narrowed by the compiler to the value it had then —
 * which is exactly wrong for a flag whose whole purpose is to change between two
 * steps. Reading it through a call keeps every check a fresh read.
 *
 * Honoured **between** steps only, never inside one: this adapter writes
 * nothing, so there is no half-finished state to leave behind, and a proposal
 * interrupted part-way is simply a shorter proposal.
 *
 * @param context The session's context.
 * @returns `true` when the caller has abandoned this work.
 */
function isAborted(context: InstrumentationContext): boolean {
  return context.signal?.aborted ?? false;
}

/**
 * The session fields every log line from this adapter carries.
 *
 * Ids, a counter and a signal name: nothing that could carry a statement, an
 * argument object or a credential.
 *
 * @param context The session's context.
 * @returns The common fields.
 */
function sessionFields(context: InstrumentationContext): LogFields {
  return {
    sessionId: context.sessionId,
    planVersion: context.planVersion,
    signal: PRISMA_SIGNAL,
  };
}

/** The runtime hook list this adapter reports, sorted and de-duplicated. */
function runtimeHookList(): string[] {
  return [...new Set(PRISMA_RUNTIME_HOOKS)].sort(compareText);
}

/**
 * Whether the understanding asks for the evidence this adapter produces.
 *
 * Two ways, and the disjunction is deliberate:
 *
 * - `signalsNeeded` names a database signal. This is the field Stage 3 and the
 *   readiness gate consume, and either driver signal counts — see
 *   {@link DATABASE_CAPTURE_SIGNALS} for why telling them apart at this point
 *   would be a distinction without a difference.
 * - an entity of a data-layer kind is named, or a seed resolved straight onto a
 *   query owner or one of its call sites. The developer has pointed at the
 *   database even though the signal list did not say so.
 *
 * When neither holds this adapter proposes **nothing**, and that silence is a
 * guarantee rather than a shortcoming: an unrelated plan collects no database
 * telemetry, so a question about why a component re-renders must not end with
 * this product reading a developer's SQL. The category is not consulted —
 * `../schema/target.ts` is explicit that nothing downstream may treat it as the
 * only input to a decision.
 *
 * @param understanding The validated Stage 1 artifact.
 * @param directlyPointed Whether a seed resolved onto a query owner.
 * @returns `true` when a proposal is warranted.
 */
function wantsDatabaseEvidence(
  understanding: ProblemUnderstanding,
  directlyPointed: boolean,
): boolean {
  if (directlyPointed) {
    return true;
  }

  if (understanding.signalsNeeded.some((signal) => DATABASE_CAPTURE_SIGNALS.includes(signal))) {
    return true;
  }

  return understanding.entities.some((entity) => DATA_ENTITY_KIND_VALUES.includes(entity.kind));
}

/**
 * The rationale one anchor action carries.
 *
 * Generic prose naming the graph relationship, with the counts and the
 * operation names the index recorded interpolated as data. It states the fact a
 * developer needs in order to read the plan honestly: the instrumentation is
 * process-wide, and the named symbol is the anchor rather than the extent of
 * what will be observed.
 *
 * No statement text, no argument object and no literal table or model name
 * written by this file ever appears here.
 *
 * @param group The candidate the action is built for.
 * @returns A bounded, single-line rationale.
 */
function rationaleFor(group: PrismaOwnerGroup): string {
  const sites =
    group.callSites === 1
      ? '1 database call site'
      : `${String(group.callSites)} database call sites`;
  const role = group.owner.serviceFunction ? 'server function' : 'declaration';
  const operations =
    group.operations.length === 0 ? '' : `, covering ${group.operations.join(', ')}`;

  return clampMessage(
    `Prisma query spans are collected by the instrumentation inside the dev-server process, so this action arms them for the whole process; the ${role} ${group.owner.symbol} is the anchor because the code graph records ${sites} in ${group.owner.file}${operations}.`,
    PRISMA_ADAPTER_LIMITS.maxRationaleLength,
  );
}

/**
 * Proposes the anchor actions for a question, or an empty array.
 *
 * The narrowing is the evidence order of {@link EvidenceTier}: the strongest
 * tier any candidate reached is the tier the proposal is drawn from, so a
 * question that named a querying function yields that function and not a sample
 * of the project's data layer, while a question that named nothing still yields
 * the highest-ranked anchors rather than nothing at all.
 *
 * Every emitted target is checked with `CodeQueries.hasSymbol` first: a
 * candidate the graph cannot resolve to an addressable declaration is dropped
 * here, where the reason can be logged, rather than at `../feasibility.ts`,
 * which would reject the whole action as a symbol it could not find.
 *
 * Query owners in a tooling module (`isToolingModulePath`: seeds, migrations,
 * scripts, tests, configuration) are left out before anything is ranked,
 * whatever the question named: they run in a process the preload is not
 * loaded into, so no span of theirs can reach a capture.
 *
 * Returns an empty array — never throws — when the project does not query
 * through the mapper, when every query owner is a tooling module, when the
 * question wants no database evidence, or when cancellation arrived between
 * steps.
 *
 * @param context The session's context.
 * @param understanding The validated Stage 1 artifact.
 * @param options The resolved options.
 * @returns The proposed actions, best-ranked first.
 */
function planActions(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
  options: ResolvedPrismaAdapterOptions,
): InstrumentationAction[] {
  const logger = loggerFor(context, options);
  const calls = prismaCallSites(context.graph);

  if (calls.length === 0) {
    logger.debug('no database call sites for this driver; proposing nothing', {
      ...sessionFields(context),
      accessStyle: context.projectSummary.databaseAccess.style,
    });

    return [];
  }

  if (isAborted(context)) {
    logger.debug('planning aborted before candidates were ranked', sessionFields(context));

    return [];
  }

  const owned = groupByOwner(context.graph, calls);

  if (owned.length === 0) {
    logger.debug('call sites belong to no addressable declaration; proposing nothing', {
      ...sessionFields(context),
      callSites: calls.length,
    });

    return [];
  }

  const groups = owned.filter((group) => !isToolingModulePath(group.owner.file));
  const toolingOwners = owned.length - groups.length;

  if (toolingOwners > 0) {
    logger.debug('query owners in tooling modules left out; they never run in the dev server', {
      ...sessionFields(context),
      toolingOwners,
    });
  }

  if (groups.length === 0) {
    logger.debug('every query owner is a tooling module; proposing nothing', {
      ...sessionFields(context),
      toolingOwners,
    });

    return [];
  }

  const evidence = resolveSeedEvidence(context.queries, understanding);
  const ranked = rankCandidates(context, groups, evidence);
  const directlyPointed = ranked.some((candidate) => candidate.tier === 0);

  if (!wantsDatabaseEvidence(understanding, directlyPointed)) {
    logger.debug('question asks for no database evidence; proposing nothing', {
      ...sessionFields(context),
      candidates: ranked.length,
    });

    return [];
  }

  const bestTier = ranked[0]?.tier ?? UNNARROWED_TIER;
  const actions: InstrumentationAction[] = [];

  for (const candidate of ranked) {
    if (candidate.tier !== bestTier || actions.length >= options.maxTargets) {
      break;
    }

    if (isAborted(context)) {
      logger.debug('planning aborted while actions were being built', {
        ...sessionFields(context),
        actions: actions.length,
      });

      break;
    }

    const { file, symbol } = candidate.group.owner;

    if (!context.queries.hasSymbol(file, symbol)) {
      logger.debug('candidate owner is not an addressable symbol; skipped', {
        ...sessionFields(context),
        file,
        symbol,
      });

      continue;
    }

    actions.push({
      id: newActionId(),
      file,
      symbol,
      type: PRISMA_CLAIM.type,
      adapter: PRISMA_ADAPTER_ID,
      mode: PRISMA_CLAIM.mode,
      rationale: rationaleFor(candidate.group),
    });
  }

  logger.debug('proposed database tracing anchors', {
    ...sessionFields(context),
    actions: actions.length,
    candidates: ranked.length,
    toolingOwners,
    tier: bestTier,
    kinds: PRISMA_TELEMETRY_KINDS.join(','),
  });

  return actions;
}

/**
 * Ranks the candidates: direct evidence first, then the bounded reachability
 * pass, then the deterministic order.
 *
 * The reachability pass runs only when nothing stronger claimed any candidate
 * and the understanding resolved to at least one file or root. A candidate it
 * reaches joins {@link REACHABLE_TIER} with the distance measured, so the
 * query sites closest to the named route or component come first. Candidates
 * are ordered **before** the inspection cap applies, so the same project always
 * inspects the same subset and two runs produce the same ranking.
 *
 * The inspection cap is {@link PRISMA_ADAPTER_LIMITS.maxOwnersInspected} and
 * is deliberately not an option: it bounds a query pass rather than describing
 * a preference, and a caller that wanted a different proposal size states
 * {@link PrismaAdapterOptions.maxTargets} instead. With
 * {@link MAX_REACHABILITY_ROOTS} it bounds the number of path searches.
 *
 * @param context The session's context.
 * @param groups The candidates.
 * @param evidence What the understanding's names resolved to.
 * @returns The candidates in proposal order.
 */
function rankCandidates(
  context: InstrumentationContext,
  groups: readonly PrismaOwnerGroup[],
  evidence: SeedEvidence,
): readonly RankedCandidate[] {
  const direct = groups
    .map((group): RankedCandidate => ({ group, tier: directTierOf(group, evidence), distance: 0 }))
    .sort(compareCandidates);

  if (!evidence.resolved || direct.some((candidate) => candidate.tier < UNNARROWED_TIER)) {
    return direct;
  }

  let inspected = 0;
  const reachable = direct.map((candidate): RankedCandidate => {
    if (inspected >= PRISMA_ADAPTER_LIMITS.maxOwnersInspected || isAborted(context)) {
      return candidate;
    }

    inspected += 1;

    const distance = reachDistanceFromEvidence(context.queries, candidate.group, evidence);

    return distance === undefined
      ? candidate
      : { group: candidate.group, tier: REACHABLE_TIER, distance };
  });

  return reachable.sort(compareCandidates);
}

/**
 * Arms this adapter's signal and reports exactly what happened.
 *
 * There is nothing to write, so the work is entirely a matter of reporting
 * honestly:
 *
 * - `applied` is **always empty**. No bytes reach the developer's project, no
 *   modification record is constructed and no journal entry is made, which is
 *   what makes this adapter's contribution reversible by construction.
 * - `serverSignals` is the deterministic derivation of
 *   `../schema/readiness.ts`, narrowed to this adapter's key. The mapping from
 *   an action type to a signal key lives there and is never restated here, and
 *   `functions` is never fabricated — the named function timing that field
 *   carries costs a file modification and belongs to the framework adapter.
 * - `runtimeHooks` names the instrumentation only when the plan asked for it
 *   **and** a preload is there to enable it. A hook listed here is one a
 *   developer can rely on, so "we sent the configuration into a process that
 *   does not exist" is not a hook.
 * - `unavailable` carries the gap. It is reported whenever this project queries
 *   through the mapper and the preload cannot deliver — the installer calls an
 *   adapter only for a plan that resolved to it, so the gap is a statement
 *   about the project rather than about one action — and it is **silent** for a
 *   project that does not use the mapper at all.
 *
 * Never rejects for a missing signal: degradation is data, and the promise is
 * reserved for an outcome that is genuinely unknowable.
 *
 * @param actions The actions the installer routed here.
 * @param context The session's context.
 * @param options The resolved options.
 * @returns What was armed, what could not be, and this adapter's contribution
 * to the preload's configuration.
 */
function installActions(
  actions: readonly InstrumentationAction[],
  context: InstrumentationContext,
  options: ResolvedPrismaAdapterOptions,
): InstallResult {
  const logger = loggerFor(context, options);
  const accepted = actions.filter(
    (action) => action.adapter === PRISMA_ADAPTER_ID && CLAIMED_ACTION_TYPES.has(action.type),
  );

  const claimsProject = canHandlePrismaProject(context);
  const preload = observePreload(context, options, currentTime(context, options));
  const gap = describeGap(preload, context, options);
  const derived = deriveServerAgentSignals(accepted);
  const serverSignals: Partial<ServerAgentSignals> = {
    [PRISMA_SERVER_SIGNAL_KEY]: derived[PRISMA_SERVER_SIGNAL_KEY],
  };

  const armed = accepted.length > 0 && preload.kind !== 'absent';
  const unavailable = claimsProject && gap !== undefined ? [toUnavailableSignal(gap)] : [];

  logger.debug('database tracing install reported', {
    ...sessionFields(context),
    requested: actions.length,
    accepted: accepted.length,
    claimsProject,
    preload: preload.kind === 'absent' ? preload.absence : preload.kind,
    armed,
    unavailable: unavailable.length,
    kinds: PRISMA_TELEMETRY_KINDS.join(','),
  });

  return {
    adapterId: PRISMA_ADAPTER_ID,
    applied: [],
    runtimeHooks: armed ? runtimeHookList() : [],
    unavailable,
    serverSignals,
  };
}

/**
 * Reports whether this adapter's signal can be collected here.
 *
 * A pure function of the observed readiness inputs and the code graph, which is
 * why the context carries them: ready when a `server-agent` connection exists
 * for **this** project and has not gone quiet, degraded when it has, and
 * unavailable when there is none — each with the same `reason` and `hint` an
 * {@link UnavailableSignal} would carry, because a developer reads them in the
 * same sentence.
 *
 * A project that does not query through the mapper produces a report with **no
 * rows**, which is how `../schema/readiness.ts`'s contract expresses "not
 * applicable": an adapter that claims nothing here is ready and has nothing to
 * say, and that is a different statement from an adapter whose signal is
 * unavailable. Reporting a gap instead would hold back the session's "Ready to
 * capture" state over a signal the question never needed.
 *
 * Built with `buildReadiness` so the `ready` derivation is stated in exactly
 * one place, and stamped from the injected clock so the report is reproducible.
 *
 * @param context The session's context.
 * @param options The resolved options.
 * @returns One report for this adapter.
 */
function reportReadiness(
  context: InstrumentationContext,
  options: ResolvedPrismaAdapterOptions,
): Readiness {
  const logger = loggerFor(context, options);
  const clock = readinessClock(context, options);

  if (!canHandlePrismaProject(context)) {
    logger.debug('driver not used by this project; reporting no rows', {
      ...sessionFields(context),
      accessStyle: context.projectSummary.databaseAccess.style,
    });

    return buildReadiness({ adapter: PRISMA_ADAPTER_ID, signals: [], ...clock });
  }

  const preload = observePreload(context, options, currentTime(context, options));
  const row = toReadinessSignal(describeGap(preload, context, options));

  logger.debug('database tracing readiness reported', {
    ...sessionFields(context),
    status: row.status,
    preload: preload.kind === 'absent' ? preload.absence : preload.kind,
  });

  return buildReadiness({ adapter: PRISMA_ADAPTER_ID, signals: [row], ...clock });
}

/**
 * Relinquishes this adapter's signal.
 *
 * Nothing was written, so nothing is restored and nothing can conflict: the
 * result reports that the signal is given up, and the service is what actually
 * turns the instrumentation off, by sending `server-agent.config` with no
 * `captureId` — which makes the preload call `disable()` on its instrumentation
 * and clear the global hook, so what remains loaded is inert and the
 * application keeps serving.
 *
 * The hook is listed as disabled for a session end and for a rollback, and
 * **not** for the service-start reconciliation: the hooks of a crashed
 * session's process do not exist any more, so claiming to have detached one
 * would be a report of work nobody did. Idempotent in every case — a repeat
 * call, and a session that installed nothing, produce the same answer, because
 * this method runs again after a crash and on every service start until nothing
 * is left open.
 *
 * @param session Which session, plan version and records are in scope, and why.
 * @param context The session's context.
 * @param options The resolved options.
 * @returns What was restored (nothing), what conflicted (nothing) and which
 * hooks were disabled.
 */
function removeSignal(
  session: AdapterRemoveRequest,
  context: InstrumentationContext,
  options: ResolvedPrismaAdapterOptions,
): RemoveResult {
  const logger = loggerFor(context, options);
  const runtimeHooksDisabled = session.reason === 'reconcile' ? [] : runtimeHookList();

  logger.debug('database tracing signal relinquished', {
    ...sessionFields(context),
    removedFor: session.sessionId,
    reason: session.reason,
    hooksDisabled: runtimeHooksDisabled.length,
  });

  return {
    adapterId: PRISMA_ADAPTER_ID,
    restored: [],
    conflicts: [],
    runtimeHooksDisabled,
  };
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * Creates the Prisma adapter.
 *
 * A factory rather than a singleton or a class instance, because
 * `../registry.ts` constructs the built-ins inside `createAdapterRegistry` and
 * a suite constructs its own with an injected clock, logger or relaunch
 * descriptor. Calling it has no side effect: nothing is registered, no global
 * is touched, no I/O is performed, and two adapters built from the same options
 * behave identically.
 *
 * The returned object is a {@link InstrumentationAdapter} — the type the
 * installer, the readiness gate and cleanup hold it as — carrying this
 * adapter's narrowed id and the claim declaration the registry reads.
 *
 * Every method answers from the {@link InstrumentationContext} it is handed and
 * from the options resolved here. None of them reaches for the environment, the
 * filesystem, a socket or a process, and none of them writes to the developer's
 * project.
 *
 * @param options Injected, fully-defaulted knobs. See
 * {@link PrismaAdapterOptions}; the defaults are
 * {@link PRISMA_ADAPTER_LIMITS} and {@link PRISMA_RELAUNCH_DEFAULTS}.
 * @returns The adapter.
 *
 * @example
 * ```ts
 * const adapter = createPrismaAdapter();
 *
 * if (adapter.canHandle(context)) {
 *   const actions = await adapter.createPlan(context, understanding);
 *   const result = await adapter.install(actions, context);
 *
 *   // `result.applied` is always empty: this adapter arms a runtime signal.
 *   for (const gap of result.unavailable) {
 *     progress.report(`Could not enable ${gap.signal}: ${gap.reason}. ${gap.hint}`);
 *   }
 * }
 * ```
 */
export function createPrismaAdapter(options?: PrismaAdapterOptions): PrismaAdapter {
  const resolved = resolveOptions(options);

  return {
    id: PRISMA_ADAPTER_ID,
    claims: PRISMA_ADAPTER_CLAIMS,

    canHandle(context: InstrumentationContext): boolean {
      return canHandlePrismaProject(context);
    },

    createPlan(
      context: InstrumentationContext,
      understanding: ProblemUnderstanding,
    ): Promise<InstrumentationAction[]> {
      return Promise.resolve(planActions(context, understanding, resolved));
    },

    install(
      actions: readonly InstrumentationAction[],
      context: InstrumentationContext,
    ): Promise<InstallResult> {
      return Promise.resolve(installActions(actions, context, resolved));
    },

    remove(session: AdapterRemoveRequest, context: InstrumentationContext): Promise<RemoveResult> {
      return Promise.resolve(removeSignal(session, context, resolved));
    },

    readiness(context: InstrumentationContext): Promise<Readiness> {
      return Promise.resolve(reportReadiness(context, resolved));
    },
  };
}
